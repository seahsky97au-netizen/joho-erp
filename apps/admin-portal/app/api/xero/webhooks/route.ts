/**
 * Xero Webhooks Receiver
 *
 * Public endpoint registered in the Xero Developer Portal. Verifies HMAC-SHA256
 * over the raw request body, then persists each event to XeroWebhookEvent.
 * Persistence MUST succeed before we return 200 — Xero will not redeliver
 * after a 200 response. Processing is fired in the background (within the
 * 5-second budget); if processing errors, the event row stays in `failed`
 * state for manual or scheduled retry.
 *
 * IMPORTANT: read the body as raw text (not JSON). The signature is computed
 * over the exact bytes Xero sent — re-serialising breaks it.
 */

import { NextResponse } from 'next/server';
import {
  verifyXeroWebhookSignature,
  persistXeroWebhookEvents,
  processPersistedWebhookEvent,
} from '@joho-erp/api';

export async function POST(request: Request) {
  const signingKey = process.env.XERO_WEBHOOK_SIGNING_KEY;
  if (!signingKey) {
    console.error('[Xero webhook] XERO_WEBHOOK_SIGNING_KEY not configured');
    // 500 — server misconfiguration; Xero will retry.
    return new NextResponse('Server not configured', { status: 500 });
  }

  // Raw body is required. Do NOT call req.json() — re-serialising breaks the sig check.
  const rawBody = await request.text();
  const providedSignature = request.headers.get('x-xero-signature');

  if (!verifyXeroWebhookSignature(rawBody, providedSignature, signingKey)) {
    // Xero's intent-to-receive handshake explicitly expects 401 on bad signature.
    return new NextResponse('Unauthorized', { status: 401 });
  }

  // Persist BEFORE returning 200. If this fails we return 5xx so Xero retries.
  let persistedIds: string[] = [];
  try {
    const persisted = await persistXeroWebhookEvents(rawBody);
    persistedIds = persisted.persistedIds;
  } catch (error) {
    console.error(
      '[Xero webhook] failed to persist events:',
      error instanceof Error ? error.message : error
    );
    return new NextResponse('Failed to persist events', { status: 500 });
  }

  // Fire-and-forget processing — errors leave events in `failed` state for retry.
  for (const id of persistedIds) {
    processPersistedWebhookEvent(id).catch((error: unknown) => {
      console.error(
        '[Xero webhook] processing error for event',
        id,
        error instanceof Error ? error.message : error
      );
    });
  }

  return new NextResponse(null, { status: 200 });
}
