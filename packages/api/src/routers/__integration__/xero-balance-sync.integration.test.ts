import { describe, it, expect, beforeEach, vi } from 'vitest';
import { adminCaller } from '../../test-utils/create-test-caller';
import { cleanAllData } from '../../test-utils/db-helpers';
import { createTestCustomer, createTestProduct, createTestOrder } from '../../test-utils/factories';
import { getPrismaClient } from '@joho-erp/database';
import { enqueueXeroJob } from '../../services/xero-queue';

describe('Xero AR Balance Sync — getCreditSummary / refreshArBalance / getOpenInvoices', () => {
  beforeEach(async () => {
    await cleanAllData();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // getCreditSummary
  // -------------------------------------------------------------------------
  describe('customer.getCreditSummary', () => {
    it('returns zeros when arBalance is null and no in-flight orders', async () => {
      const admin = adminCaller();
      const customer = await createTestCustomer({
        creditLimit: 500000, // $5000
      });

      const result = await admin.customer.getCreditSummary({ customerId: customer.id });

      expect(result.creditLimitCents).toBe(500000);
      expect(result.xeroOutstandingCents).toBe(0);
      expect(result.xeroOverdueCents).toBe(0);
      expect(result.preInvoiceInFlightCents).toBe(0);
      expect(result.availableCreditCents).toBe(500000);
      expect(result.lastSyncedAt).toBeNull();
      expect(result.hasXeroContact).toBe(false);
    });

    it('subtracts cached Xero outstanding from available credit', async () => {
      const admin = adminCaller();
      const customer = await createTestCustomer({
        creditLimit: 500000,
        xeroContactId: 'xero-contact-123',
        arBalance: {
          outstandingCents: 200000, // $2000 already owed
          overdueCents: 50000,      // $500 overdue
          lastSyncSource: 'webhook',
        },
      });

      const result = await admin.customer.getCreditSummary({ customerId: customer.id });

      expect(result.xeroOutstandingCents).toBe(200000);
      expect(result.xeroOverdueCents).toBe(50000);
      expect(result.availableCreditCents).toBe(500000 - 200000); // = $3000
      expect(result.hasXeroContact).toBe(true);
      expect(result.lastSyncSource).toBe('webhook');
    });

    it('also subtracts pre-invoice in-flight orders (awaiting/confirmed/packing only)', async () => {
      const admin = adminCaller();
      const customer = await createTestCustomer({
        creditLimit: 1000000,
        xeroContactId: 'xero-contact-456',
        arBalance: { outstandingCents: 100000 },
      });

      const product = await createTestProduct({ basePrice: 10000 }); // $100/unit

      // In-flight (counts):
      await createTestOrder({
        customerId: customer.id,
        status: 'confirmed',
        items: [{ productId: product.id, quantity: 5, unitPrice: 10000 }], // $500
      });
      await createTestOrder({
        customerId: customer.id,
        status: 'packing',
        items: [{ productId: product.id, quantity: 3, unitPrice: 10000 }], // $300
      });

      // Already invoiced (does NOT count — represented in xeroOutstanding):
      await createTestOrder({
        customerId: customer.id,
        status: 'ready_for_delivery',
        items: [{ productId: product.id, quantity: 10, unitPrice: 10000 }], // $1000 — excluded
      });
      await createTestOrder({
        customerId: customer.id,
        status: 'delivered',
        items: [{ productId: product.id, quantity: 2, unitPrice: 10000 }], // $200 — excluded
      });

      const result = await admin.customer.getCreditSummary({ customerId: customer.id });

      expect(result.preInvoiceInFlightCents).toBe(50000 + 30000); // $800
      expect(result.availableCreditCents).toBe(1000000 - 100000 - 80000); // = $8200
    });

    it('handles a customer over credit (negative available)', async () => {
      const admin = adminCaller();
      const customer = await createTestCustomer({
        creditLimit: 100000, // $1000
        xeroContactId: 'xero-contact-789',
        arBalance: { outstandingCents: 150000 }, // already $500 over
      });

      const result = await admin.customer.getCreditSummary({ customerId: customer.id });

      expect(result.availableCreditCents).toBe(-50000);
    });
  });

  // -------------------------------------------------------------------------
  // refreshArBalance
  // -------------------------------------------------------------------------
  describe('customer.refreshArBalance', () => {
    it('enqueues a balance_sync job when xeroContactId is set', async () => {
      const admin = adminCaller();
      const customer = await createTestCustomer({
        xeroContactId: 'xero-contact-abc',
      });

      const result = await admin.customer.refreshArBalance({ customerId: customer.id });

      expect(enqueueXeroJob).toHaveBeenCalledWith(
        'balance_sync',
        'customer',
        customer.id,
        expect.objectContaining({
          xeroContactId: 'xero-contact-abc',
          trigger: 'manual',
        })
      );
      expect(result.jobId).toBe('mock-job-id');
      expect(result.queued).toBe(true);
    });

    it('rejects when customer has no xeroContactId', async () => {
      const admin = adminCaller();
      const customer = await createTestCustomer({}); // no xeroContactId

      await expect(
        admin.customer.refreshArBalance({ customerId: customer.id })
      ).rejects.toThrow(/not synced to Xero/i);
    });

    it('throws NOT_FOUND for missing customer', async () => {
      const admin = adminCaller();
      // Valid 24-char hex that does not exist
      await expect(
        admin.customer.refreshArBalance({ customerId: '0123456789abcdef01234567' })
      ).rejects.toThrow(/Customer not found/i);
    });
  });

  // -------------------------------------------------------------------------
  // getOpenInvoices
  // -------------------------------------------------------------------------
  describe('customer.getOpenInvoices', () => {
    it('returns empty unsynced response when xeroContactId is missing', async () => {
      const admin = adminCaller();
      const customer = await createTestCustomer({});

      const result = await admin.customer.getOpenInvoices({ customerId: customer.id });

      expect(result.invoices).toEqual([]);
      expect(result.synced).toBe(false);
    });

    it('returns empty unsynced response when Xero is not connected', async () => {
      // The default mock has isConnected -> false, so even when xeroContactId is
      // present we should get the unsynced fallback rather than calling Xero.
      const admin = adminCaller();
      const customer = await createTestCustomer({ xeroContactId: 'xero-contact-xyz' });

      const result = await admin.customer.getOpenInvoices({ customerId: customer.id });

      expect(result.invoices).toEqual([]);
      expect(result.synced).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // arBalance round-trip — write + read back via getCreditSummary
  // -------------------------------------------------------------------------
  describe('arBalance round-trip', () => {
    it('persists arBalance written on a customer and surfaces it via getCreditSummary', async () => {
      const admin = adminCaller();
      const customer = await createTestCustomer({
        xeroContactId: 'xero-contact-rt',
      });

      // Simulate the balance_sync worker writing the snapshot directly.
      const prisma = getPrismaClient();
      await prisma.customer.update({
        where: { id: customer.id },
        data: {
          arBalance: {
            outstandingCents: 75000,
            overdueCents: 10000,
            currency: 'AUD',
            lastSyncedAt: new Date(),
            lastSyncSource: 'manual',
          },
        },
      });

      const result = await admin.customer.getCreditSummary({ customerId: customer.id });

      expect(result.xeroOutstandingCents).toBe(75000);
      expect(result.xeroOverdueCents).toBe(10000);
      expect(result.lastSyncSource).toBe('manual');
      expect(result.lastSyncedAt).not.toBeNull();
    });
  });
});
