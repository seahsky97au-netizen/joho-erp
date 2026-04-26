/**
 * Integration tests for the Xero balance reconciler.
 *
 * The reconciler depends on Xero (mocked in test-utils/setup.ts) and Prisma
 * (real DB). We exercise: dedup of contacts across pages, mapping to local
 * customers, stale-customer long-tail, and watermark persistence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanAllData } from '../../test-utils/db-helpers';
import { createTestCustomer } from '../../test-utils/factories';
import { runBalanceReconciler } from '../../services/xero-balance-reconciler';
import { enqueueXeroJob } from '../../services/xero-queue';
import * as xeroService from '../../services/xero';
import { getPrismaClient } from '@joho-erp/database';

const xeroApiRequestMock = vi.mocked(xeroService.xeroApiRequest);
const isConnectedMock = vi.mocked(xeroService.isConnected);
const isXeroIntegrationEnabledMock = vi.mocked(xeroService.isXeroIntegrationEnabled);
const getValidAccessTokenMock = vi.mocked(xeroService.getValidAccessToken);

describe('Xero AR Balance Reconciler', () => {
  beforeEach(async () => {
    await cleanAllData();
    vi.clearAllMocks();

    isXeroIntegrationEnabledMock.mockReturnValue(true);
    isConnectedMock.mockResolvedValue(true);
    getValidAccessTokenMock.mockResolvedValue({
      accessToken: 'access-token',
      tenantId: 'tenant-A',
    });
  });

  it('skips when integration disabled', async () => {
    isXeroIntegrationEnabledMock.mockReturnValue(false);
    const result = await runBalanceReconciler();
    expect(result.skipped).toBe('integration_disabled');
    expect(enqueueXeroJob).not.toHaveBeenCalled();
  });

  it('skips when Xero is not connected', async () => {
    isConnectedMock.mockResolvedValue(false);
    const result = await runBalanceReconciler();
    expect(result.skipped).toBe('not_connected');
    expect(enqueueXeroJob).not.toHaveBeenCalled();
  });

  it('enqueues balance_sync per distinct contact in returned invoices', async () => {
    const customerA = await createTestCustomer({ xeroContactId: 'contact-A' });
    const customerB = await createTestCustomer({ xeroContactId: 'contact-B' });

    // Single page; same contact appears twice (across two invoices) — should dedupe.
    xeroApiRequestMock.mockResolvedValueOnce({
      Invoices: [
        { Contact: { ContactID: 'contact-A' } },
        { Contact: { ContactID: 'contact-A' } },
        { Contact: { ContactID: 'contact-B' } },
      ],
    });

    const result = await runBalanceReconciler();

    expect(result.contactsTouched).toBe(2);
    expect(result.jobsEnqueued).toBe(2);
    expect(enqueueXeroJob).toHaveBeenCalledWith(
      'balance_sync',
      'customer',
      customerA.id,
      expect.objectContaining({ xeroContactId: 'contact-A', trigger: 'poll' })
    );
    expect(enqueueXeroJob).toHaveBeenCalledWith(
      'balance_sync',
      'customer',
      customerB.id,
      expect.objectContaining({ xeroContactId: 'contact-B', trigger: 'poll' })
    );
  });

  it('skips contacts that do not have a local customer mapping', async () => {
    await createTestCustomer({ xeroContactId: 'contact-known' });

    xeroApiRequestMock.mockResolvedValueOnce({
      Invoices: [
        { Contact: { ContactID: 'contact-known' } },
        { Contact: { ContactID: 'contact-orphan' } }, // no local customer
      ],
    });

    const result = await runBalanceReconciler();

    expect(result.contactsTouched).toBe(2);
    expect(result.jobsEnqueued).toBe(1); // only contact-known mapped
  });

  it('refreshes customers whose arBalance is stale (>7d)', async () => {
    // No new invoices — only stale customers should drive enqueues.
    xeroApiRequestMock.mockResolvedValueOnce({ Invoices: [] });

    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const fresh = await createTestCustomer({
      xeroContactId: 'contact-fresh',
      arBalance: { outstandingCents: 0, lastSyncedAt: new Date() },
    });
    const stale = await createTestCustomer({
      xeroContactId: 'contact-stale',
      arBalance: { outstandingCents: 0, lastSyncedAt: oldDate },
    });
    const neverSynced = await createTestCustomer({
      xeroContactId: 'contact-never',
      // no arBalance
    });

    const result = await runBalanceReconciler();

    expect(result.staleCustomersRefreshed).toBeGreaterThanOrEqual(2);
    // Fresh customer should NOT be enqueued by the long-tail check
    const enqueuedIds = (enqueueXeroJob as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => call[2]);
    expect(enqueuedIds).toContain(stale.id);
    expect(enqueuedIds).toContain(neverSynced.id);
    expect(enqueuedIds).not.toContain(fresh.id);
  });

  it('writes the watermark on each successful run', async () => {
    xeroApiRequestMock.mockResolvedValueOnce({ Invoices: [] });

    const before = new Date();
    await runBalanceReconciler();

    const cursor = await getPrismaClient().xeroSyncCursor.findUnique({
      where: { tenantId: 'tenant-A' },
    });
    expect(cursor).not.toBeNull();
    expect(cursor!.lastReconciledAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('uses If-Modified-Since on subsequent runs', async () => {
    xeroApiRequestMock.mockResolvedValueOnce({ Invoices: [] });
    await runBalanceReconciler();

    xeroApiRequestMock.mockClear();
    xeroApiRequestMock.mockResolvedValueOnce({ Invoices: [] });
    await runBalanceReconciler();

    // Second run must include an If-Modified-Since header
    expect(xeroApiRequestMock).toHaveBeenCalledWith(
      expect.stringContaining('/Invoices'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'If-Modified-Since': expect.any(String),
        }),
      })
    );
  });
});
