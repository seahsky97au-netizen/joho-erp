/**
 * Xero AR Balance Reconciler
 *
 * Pages through invoices modified since the last reconciled timestamp and
 * enqueues a `balance_sync` job for each distinct contact. Acts as the
 * safety net for missed webhooks — runs nightly via a cron route handler.
 *
 * Long-tail safety net: also enqueues a refresh for any customer whose
 * `arBalance.lastSyncedAt` is older than 7 days (or never synced).
 *
 * The watermark is stored in `XeroSyncCursor`, keyed by tenantId.
 */

import { prisma } from '@joho-erp/database';
import { getValidAccessToken, isConnected, isXeroIntegrationEnabled, xeroApiRequest, XeroApiError } from './xero';
import { enqueueXeroJob, sweepStuckProcessing } from './xero-queue';
import { xeroLogger } from '../utils/logger';

const STALE_THRESHOLD_DAYS = 7;
const MAX_PAGES = 50; // hard cap to prevent runaway
const PAGE_SIZE = 100;

interface ReconcileResult {
  ranAt: Date;
  contactsTouched: number;
  jobsEnqueued: number;
  staleCustomersRefreshed: number;
  pagesScanned: number;
  /** True when MAX_PAGES was reached with a full page — watermark NOT advanced. */
  truncated?: boolean;
  skipped?: string;
}

/**
 * Run the balance reconciler.
 *
 * 1. Read `lastReconciledAt` for the active tenant.
 * 2. Page through `/Invoices?Statuses=AUTHORISED,PAID&summaryOnly=true` using
 *    an `If-Modified-Since` header (or fall back to a full sweep on first run).
 * 3. Collect distinct `Contact.ContactID`s; resolve to local customers; enqueue
 *    `balance_sync` per matched customer.
 * 4. Long-tail: for any customer with `lastSyncedAt < now - 7d`, enqueue too.
 * 5. Update `lastReconciledAt = startOfRun`.
 */
export async function runBalanceReconciler(): Promise<ReconcileResult> {
  const ranAt = new Date();

  if (!isXeroIntegrationEnabled()) {
    return { ranAt, contactsTouched: 0, jobsEnqueued: 0, staleCustomersRefreshed: 0, pagesScanned: 0, skipped: 'integration_disabled' };
  }
  if (!(await isConnected())) {
    return { ranAt, contactsTouched: 0, jobsEnqueued: 0, staleCustomersRefreshed: 0, pagesScanned: 0, skipped: 'not_connected' };
  }

  // Step 0: sweep any rows stuck in `processing` from a crashed/timed-out worker.
  // Without this the coalescer would silently skip future enqueues for affected
  // customers because it sees a row "in flight" that is actually orphaned.
  await sweepStuckProcessing();

  const { tenantId } = await getValidAccessToken();

  // Step 1: read watermark
  const cursor = await prisma.xeroSyncCursor.findUnique({ where: { tenantId } });
  const lastReconciledAt = cursor?.lastReconciledAt ?? null;

  // Step 2: page through invoices
  const contactIds = new Set<string>();
  let pagesScanned = 0;
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    type InvoiceListResp = {
      Invoices: Array<{ Contact?: { ContactID?: string } }>;
    };

    const headers: Record<string, string> = {};
    if (lastReconciledAt) {
      // Xero requires RFC 1123 / IMF-fixdate format here. toUTCString() emits
      // exactly that format (e.g. "Wed, 21 Oct 2015 07:28:00 GMT"). Do NOT
      // change to ISO 8601 — Xero ignores ISO and silently returns all rows.
      headers['If-Modified-Since'] = lastReconciledAt.toUTCString();
    }

    let resp: InvoiceListResp;
    try {
      resp = await xeroApiRequest<InvoiceListResp>(
        `/Invoices?Statuses=AUTHORISED,PAID&summaryOnly=true&page=${page}`,
        { headers }
      );
    } catch (error) {
      if (error instanceof XeroApiError && error.statusCode === 304) {
        // Nothing modified since watermark — short-circuit.
        break;
      }
      throw error;
    }

    pagesScanned += 1;
    const invoices = resp.Invoices ?? [];
    if (invoices.length === 0) break;

    for (const inv of invoices) {
      if (inv.Contact?.ContactID) contactIds.add(inv.Contact.ContactID);
    }

    // Less than a full page → last page
    if (invoices.length < PAGE_SIZE) break;

    // Hit the page cap with a full page → there are likely more results we
    // didn't see. Mark truncated so we DO NOT advance the watermark; the next
    // run will re-scan this window.
    if (page === MAX_PAGES && invoices.length === PAGE_SIZE) {
      truncated = true;
      xeroLogger.warn('Reconciler hit MAX_PAGES with a full page — watermark NOT advanced; next run will re-scan', {
        maxPages: MAX_PAGES,
        pageSize: PAGE_SIZE,
      });
    }
  }

  // Step 3: resolve to local customers + enqueue
  let jobsEnqueued = 0;
  if (contactIds.size > 0) {
    const customers = await prisma.customer.findMany({
      where: { xeroContactId: { in: Array.from(contactIds) } },
      select: { id: true, xeroContactId: true },
    });
    for (const customer of customers) {
      if (!customer.xeroContactId) continue;
      const jobId = await enqueueXeroJob('balance_sync', 'customer', customer.id, {
        xeroContactId: customer.xeroContactId,
        trigger: 'poll',
      });
      if (jobId) jobsEnqueued += 1;
    }
  }

  // Step 4: long-tail refresh of stale customers
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
  const staleCustomers = await prisma.customer.findMany({
    where: {
      xeroContactId: { not: null },
      OR: [
        { arBalance: { is: null } },
        { arBalance: { is: { lastSyncedAt: { lt: staleCutoff } } } },
      ],
    },
    select: { id: true, xeroContactId: true },
    // Cap to avoid swamping the queue if there's a big backlog
    take: 200,
  });

  let staleRefreshed = 0;
  for (const customer of staleCustomers) {
    if (!customer.xeroContactId) continue;
    const jobId = await enqueueXeroJob('balance_sync', 'customer', customer.id, {
      xeroContactId: customer.xeroContactId,
      trigger: 'poll',
    });
    if (jobId) staleRefreshed += 1;
  }

  // Step 5: persist watermark = run-start timestamp.
  // If we truncated at MAX_PAGES we leave the watermark untouched so the next
  // run re-scans the same window — otherwise we'd silently drop invoices.
  if (!truncated) {
    await prisma.xeroSyncCursor.upsert({
      where: { tenantId },
      create: { tenantId, lastReconciledAt: ranAt },
      update: { lastReconciledAt: ranAt },
    });
  }

  xeroLogger.info('Reconciler run complete', {
    pagesScanned,
    contactsTouched: contactIds.size,
    jobsEnqueued,
    staleRefreshed,
    truncated,
  });

  return {
    ranAt,
    contactsTouched: contactIds.size,
    jobsEnqueued,
    staleCustomersRefreshed: staleRefreshed,
    truncated: truncated || undefined,
    pagesScanned,
  };
}
