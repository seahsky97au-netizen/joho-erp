/**
 * Backfill Customer AR Balances from Xero
 *
 * One-shot script that enqueues a `balance_sync` job for every customer with a
 * `xeroContactId`. The xero-queue worker handles the actual fetch + write,
 * respecting the existing 55/min rate limit.
 *
 * Run after Phase 1 ships, before flipping XERO_AR_CREDIT_ENFORCEMENT in Phase 3.
 *
 * IMPORTANT: enqueueXeroJob calls processJob(job) fire-and-forget after every
 * insert. At ~55 calls/min Xero throttle, naively iterating N customers
 * synchronously parks N closures on the rate-limit timer at once → real OOM
 * pressure for tenants with thousands of customers. We chunk the loop with a
 * pacing delay so the worker has time to drain in-flight jobs before we add
 * more. Coalescing in enqueueXeroJob (Phase 2) makes this safe to re-run.
 *
 * Usage:
 *   pnpm xero:backfill-balances          # dry-run — count only, no jobs
 *   pnpm xero:backfill-balances --apply  # actually enqueue (chunked + paced)
 */

import { prisma } from '@joho-erp/database';
import { enqueueXeroJob } from '../services/xero-queue';

// Env is expected to be pre-loaded by the runner. The package.json script uses
// `tsx --env-file=.env` which requires Node ≥ 20.6.

const isApply = process.argv.includes('--apply');

// Tuning: keep below the 55/min Xero rate-limit. 50 jobs per ~60s = 50 calls
// in flight at most. Each chunk pause gives the worker time to drain.
const CHUNK_SIZE = 50;
const CHUNK_PAUSE_MS = 65_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(
    `[backfill] mode: ${isApply ? 'APPLY (enqueueing jobs)' : 'DRY RUN (no jobs created)'}`
  );

  const customers = await prisma.customer.findMany({
    where: { xeroContactId: { not: null } },
    select: {
      id: true,
      businessName: true,
      xeroContactId: true,
      arBalance: true,
    },
    orderBy: [
      // Oldest-synced first so the longest-stale customers get priority.
      { arBalance: { lastSyncedAt: 'asc' } },
      { businessName: 'asc' },
    ],
  });

  console.log(
    `[backfill] found ${customers.length} customer(s) with a xeroContactId`
  );

  if (customers.length === 0) {
    console.log('[backfill] nothing to do');
    return;
  }

  if (!isApply) {
    console.log('[backfill] dry-run — first 10:');
    for (const c of customers.slice(0, 10)) {
      const last = c.arBalance?.lastSyncedAt
        ? new Date(c.arBalance.lastSyncedAt).toISOString()
        : 'never';
      console.log(`  - ${c.businessName} (${c.id}) — last synced: ${last}`);
    }
    console.log(
      '[backfill] re-run with --apply to enqueue balance_sync for all of them'
    );
    return;
  }

  let enqueued = 0;
  let failed = 0;

  // Process in chunks of CHUNK_SIZE, pausing between chunks so the queue worker
  // can drain. Each chunk's enqueues are awaited individually but the worker
  // runs them async — the pause is what keeps the rate-limit-bound timer
  // closures bounded.
  for (let i = 0; i < customers.length; i += CHUNK_SIZE) {
    const chunk = customers.slice(i, i + CHUNK_SIZE);

    for (const customer of chunk) {
      if (!customer.xeroContactId) continue;
      try {
        const jobId = await enqueueXeroJob(
          'balance_sync',
          'customer',
          customer.id,
          {
            xeroContactId: customer.xeroContactId,
            trigger: 'manual',
          }
        );
        if (!jobId) {
          console.error('[backfill] Xero integration is disabled. Aborting.');
          process.exitCode = 1;
          return;
        }
        enqueued += 1;
      } catch (error) {
        failed += 1;
        console.error(
          `[backfill] failed to enqueue for ${customer.businessName} (${customer.id}):`,
          error instanceof Error ? error.message : error
        );
      }
    }

    console.log(
      `[backfill] enqueued ${enqueued} / ${customers.length}…`
    );

    // Pause between chunks so the worker can drain. Skip after the last chunk.
    if (i + CHUNK_SIZE < customers.length) {
      console.log(
        `[backfill] pausing ${Math.round(CHUNK_PAUSE_MS / 1000)}s for queue to drain…`
      );
      await sleep(CHUNK_PAUSE_MS);
    }
  }

  console.log(`[backfill] done. enqueued=${enqueued} failed=${failed}`);
}

main()
  .catch((error) => {
    console.error('[backfill] fatal error:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Allow any in-flight job processing to settle before we exit.
    // The worker fires immediately but runs async.
    await new Promise((r) => setTimeout(r, 1000));
    process.exit(process.exitCode || 0);
  });
