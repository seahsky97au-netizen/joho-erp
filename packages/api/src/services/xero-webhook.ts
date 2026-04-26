/**
 * Xero Webhook handler
 *
 * Verifies HMAC-SHA256 signatures on the raw request body, durably persists
 * each event into `XeroWebhookEvent`, then enqueues `balance_sync` jobs for
 * each INVOICE event.
 *
 * Why persist first: Xero will NOT redeliver an event after we return 200.
 * If downstream processing fails, the only way to recover is from our own
 * record. Each event row tracks status (pending/processing/completed/failed)
 * and is retryable by an admin or a follow-up cron.
 *
 * The signature MUST be computed over the EXACT raw bytes — never re-serialised
 * JSON — and compared in constant time. Signature-mismatch responses also
 * satisfy Xero's intent-to-receive handshake (401 confirms we are checking).
 *
 * Reference: https://developer.xero.com/documentation/guides/webhooks/overview/
 */

import crypto from 'crypto';
import { prisma } from '@joho-erp/database';
import { fetchInvoiceContactId, getStoredTokens } from './xero';
import { enqueueXeroJob } from './xero-queue';
import { xeroLogger } from '../utils/logger';

export interface XeroWebhookEvent {
  resourceUrl?: string;
  resourceId: string;
  eventDateUtc: string;
  eventType: 'CREATE' | 'UPDATE';
  eventCategory: 'INVOICE' | 'CONTACT';
  tenantId: string;
  tenantType?: string;
}

interface XeroWebhookPayload {
  events: XeroWebhookEvent[];
  firstEventSequence?: number;
  lastEventSequence?: number;
  entropy?: string;
}

/**
 * Compute base64(HMAC-SHA256(rawBody, signingKey)) and compare in constant
 * time against the provided signature. Returns true iff valid.
 */
export function verifyXeroWebhookSignature(
  rawBody: string,
  providedSignature: string | null,
  signingKey: string
): boolean {
  if (!providedSignature || !signingKey) return false;

  const computed = crypto
    .createHmac('sha256', signingKey)
    .update(rawBody, 'utf8')
    .digest('base64');

  const a = Buffer.from(computed);
  const b = Buffer.from(providedSignature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Persist every INVOICE event from the verified webhook body to
 * `XeroWebhookEvent`. Must complete before we return 200 to Xero. Idempotent
 * via a `(tenantId, resourceId, eventDateUtc)` natural key — replays of the
 * same payload do NOT create duplicate rows.
 *
 * Returns the IDs of the freshly-persisted events that need processing.
 */
export async function persistXeroWebhookEvents(rawBody: string): Promise<{
  persistedIds: string[];
  totalEvents: number;
  skippedNonInvoice: number;
  skippedDuplicate: number;
  skippedWrongTenant: number;
  rawBodyHash: string;
}> {
  const rawBodyHash = crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex');

  let payload: XeroWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as XeroWebhookPayload;
  } catch {
    // Signed but unparseable — caller should still 200 (signature validated)
    // because returning 5xx triggers a Xero retry of the same garbage payload.
    xeroLogger.error('Webhook body verified but JSON parse failed', { rawBodyHash });
    return { persistedIds: [], totalEvents: 0, skippedNonInvoice: 0, skippedDuplicate: 0, skippedWrongTenant: 0, rawBodyHash };
  }

  const events = payload.events ?? [];

  // Determine the currently-connected tenant. Events whose tenantId does not
  // match are dropped — covers the rare case where the Xero connection has
  // been re-bound to a different organisation, which would otherwise leave
  // orphan events accumulating against customers we no longer manage.
  const tokens = await getStoredTokens();
  const currentTenantId = tokens?.tenantId ?? null;

  const persistedIds: string[] = [];
  let skippedNonInvoice = 0;
  let skippedDuplicate = 0;
  let skippedWrongTenant = 0;

  for (const event of events) {
    if (event.eventCategory !== 'INVOICE') {
      skippedNonInvoice += 1;
      continue;
    }

    if (currentTenantId && event.tenantId !== currentTenantId) {
      // Event is for a tenant we are no longer connected to. Discard.
      xeroLogger.warn('Webhook event tenantId does not match current tenant — dropping', {
        eventTenantId: event.tenantId,
        currentTenantId,
        resourceId: event.resourceId,
      });
      skippedWrongTenant += 1;
      continue;
    }

    const eventDate = new Date(event.eventDateUtc);

    // Replay guard: same (tenant, resource, eventDate) → skip.
    const existing = await prisma.xeroWebhookEvent.findFirst({
      where: {
        tenantId: event.tenantId,
        resourceId: event.resourceId,
        eventDateUtc: eventDate,
      },
      select: { id: true },
    });
    if (existing) {
      skippedDuplicate += 1;
      continue;
    }

    const row = await prisma.xeroWebhookEvent.create({
      data: {
        tenantId: event.tenantId,
        resourceId: event.resourceId,
        eventCategory: event.eventCategory,
        eventType: event.eventType,
        eventDateUtc: eventDate,
        resourceUrl: event.resourceUrl,
        rawBodyHash,
        status: 'pending',
      },
    });
    persistedIds.push(row.id);
  }

  return {
    persistedIds,
    totalEvents: events.length,
    skippedNonInvoice,
    skippedDuplicate,
    skippedWrongTenant,
    rawBodyHash,
  };
}

/**
 * Process a single persisted webhook event: resolve the contact via Xero,
 * find the matching local customer, enqueue a `balance_sync`. Updates the
 * event row to `completed` or `failed` so admins can audit the pipeline.
 *
 * Idempotent — safe to retry a `failed` row.
 */
export async function processPersistedWebhookEvent(eventId: string): Promise<{
  status: 'completed' | 'failed' | 'skipped';
  jobId?: string;
  reason?: string;
}> {
  const event = await prisma.xeroWebhookEvent.findUnique({
    where: { id: eventId },
  });
  if (!event) {
    return { status: 'failed', reason: 'event_not_found' };
  }

  await prisma.xeroWebhookEvent.update({
    where: { id: eventId },
    data: {
      status: 'processing',
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
    },
  });

  try {
    const xeroContactId = await fetchInvoiceContactId(event.resourceId);
    if (!xeroContactId) {
      await prisma.xeroWebhookEvent.update({
        where: { id: eventId },
        data: {
          status: 'completed',
          processedAt: new Date(),
          error: null,
        },
      });
      return { status: 'skipped', reason: 'invoice_has_no_contact' };
    }

    const customer = await prisma.customer.findFirst({
      where: { xeroContactId },
      select: { id: true },
    });
    if (!customer) {
      await prisma.xeroWebhookEvent.update({
        where: { id: eventId },
        data: {
          status: 'completed',
          processedAt: new Date(),
          error: null,
        },
      });
      return { status: 'skipped', reason: 'no_local_customer' };
    }

    const jobId = await enqueueXeroJob('balance_sync', 'customer', customer.id, {
      xeroContactId,
      resourceId: event.resourceId,
      resourceUrl: event.resourceUrl,
      eventDateUtc: event.eventDateUtc.toISOString(),
      trigger: 'webhook',
    });

    await prisma.xeroWebhookEvent.update({
      where: { id: eventId },
      data: {
        status: 'completed',
        processedAt: new Date(),
        jobId: jobId ?? null,
        error: null,
      },
    });
    return { status: 'completed', jobId: jobId ?? undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.xeroWebhookEvent.update({
      where: { id: eventId },
      data: { status: 'failed', error: message },
    });
    return { status: 'failed', reason: message };
  }
}

/**
 * Convenience: persist + process in sequence. Used by the webhook route's
 * background processor. Persistence must succeed before the route returns
 * 200 — processing can fail and the row stays in `failed` state.
 */
export async function processXeroWebhookPayload(rawBody: string): Promise<{
  persistedIds: string[];
  totalEvents: number;
  skippedNonInvoice: number;
  skippedDuplicate: number;
  skippedWrongTenant: number;
}> {
  const persisted = await persistXeroWebhookEvents(rawBody);

  // Process each freshly-persisted event. Errors are caught per-event so one
  // failure does not block the rest.
  for (const id of persisted.persistedIds) {
    try {
      await processPersistedWebhookEvent(id);
    } catch (error) {
      xeroLogger.error('Unexpected error processing webhook event', {
        eventId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  xeroLogger.info('Xero webhook processed', {
    totalEvents: persisted.totalEvents,
    persisted: persisted.persistedIds.length,
    skippedNonInvoice: persisted.skippedNonInvoice,
    skippedDuplicate: persisted.skippedDuplicate,
    skippedWrongTenant: persisted.skippedWrongTenant,
  });

  return {
    persistedIds: persisted.persistedIds,
    totalEvents: persisted.totalEvents,
    skippedNonInvoice: persisted.skippedNonInvoice,
    skippedDuplicate: persisted.skippedDuplicate,
    skippedWrongTenant: persisted.skippedWrongTenant,
  };
}
