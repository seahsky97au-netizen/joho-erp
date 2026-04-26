/**
 * Cron Endpoint: Xero AR Balance Reconciler
 *
 * Pages through invoices modified since last run and enqueues balance_sync
 * jobs for each affected contact. Acts as the safety net for missed webhooks.
 *
 * Vercel Cron Configuration (add to vercel.json):
 * {
 *   "crons": [
 *     {
 *       "path": "/api/cron/xero-balance-reconcile",
 *       "schedule": "0 3 * * *"
 *     }
 *   ]
 * }
 */

import { NextResponse } from 'next/server';
import { runBalanceReconciler } from '@joho-erp/api';

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runBalanceReconciler();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Cron] Xero balance reconciler failed:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
