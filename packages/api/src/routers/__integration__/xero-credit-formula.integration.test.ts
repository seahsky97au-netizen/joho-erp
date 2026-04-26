/**
 * Integration tests for the Phase 3 credit-formula switch.
 *
 * `calculateAvailableCredit` and `getOutstandingBalance` are gated behind
 * `XERO_AR_CREDIT_ENFORCEMENT`. Both must produce the legacy result with the
 * flag off, and the new Xero-AR result with the flag on. We exercise both
 * paths against a real DB and verify the formulas.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanAllData } from '../../test-utils/db-helpers';
import { createTestCustomer, createTestProduct, createTestOrder } from '../../test-utils/factories';
import { calculateAvailableCredit, getOutstandingBalance } from '../order';

const FLAG_KEY = 'XERO_AR_CREDIT_ENFORCEMENT';

describe('Phase 3 credit formula — XERO_AR_CREDIT_ENFORCEMENT flag', () => {
  let originalFlag: string | undefined;

  beforeEach(async () => {
    await cleanAllData();
    originalFlag = process.env[FLAG_KEY];
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env[FLAG_KEY];
    } else {
      process.env[FLAG_KEY] = originalFlag;
    }
  });

  // -------------------------------------------------------------------------
  // Flag OFF — legacy formula
  // -------------------------------------------------------------------------
  describe('flag OFF — legacy formula', () => {
    beforeEach(() => {
      process.env[FLAG_KEY] = 'false';
    });

    it('calculateAvailableCredit ignores arBalance and counts confirmed → out_for_delivery', async () => {
      const customer = await createTestCustomer({
        creditLimit: 1_000_000,
        xeroContactId: 'xero-1',
        arBalance: { outstandingCents: 500_000 }, // should be ignored
      });
      const product = await createTestProduct({ basePrice: 10_000 });

      // Counts in legacy:
      await createTestOrder({
        customerId: customer.id,
        status: 'confirmed',
        items: [{ productId: product.id, quantity: 5, unitPrice: 10_000 }], // $500
      });
      await createTestOrder({
        customerId: customer.id,
        status: 'ready_for_delivery',
        items: [{ productId: product.id, quantity: 10, unitPrice: 10_000 }], // $1000
      });
      // Excluded in legacy:
      await createTestOrder({
        customerId: customer.id,
        status: 'awaiting_approval',
        items: [{ productId: product.id, quantity: 2, unitPrice: 10_000 }], // ignored
      });

      const available = await calculateAvailableCredit(customer.id, 1_000_000);

      // 1_000_000 − (50_000 + 100_000) = 850_000
      expect(available).toBe(850_000);
    });

    it('getOutstandingBalance includes awaiting_approval through out_for_delivery', async () => {
      const customer = await createTestCustomer({
        xeroContactId: 'xero-1',
        arBalance: { outstandingCents: 500_000 }, // ignored in legacy
      });
      const product = await createTestProduct({ basePrice: 10_000 });

      await createTestOrder({
        customerId: customer.id,
        status: 'awaiting_approval',
        items: [{ productId: product.id, quantity: 1, unitPrice: 10_000 }], // $100
      });
      await createTestOrder({
        customerId: customer.id,
        status: 'confirmed',
        items: [{ productId: product.id, quantity: 1, unitPrice: 10_000 }], // $100
      });

      const balance = await getOutstandingBalance(customer.id);

      // Legacy: 10_000 + 10_000 = 20_000 (no Xero contribution)
      expect(balance).toBe(20_000);
    });
  });

  // -------------------------------------------------------------------------
  // Flag ON — Xero-AR formula
  // -------------------------------------------------------------------------
  describe('flag ON — Xero-AR formula', () => {
    beforeEach(() => {
      process.env[FLAG_KEY] = 'true';
    });

    it('calculateAvailableCredit subtracts arBalance + pre-invoice in-flight', async () => {
      const customer = await createTestCustomer({
        creditLimit: 1_000_000,
        xeroContactId: 'xero-1',
        arBalance: { outstandingCents: 200_000 }, // $2000 owed in Xero
      });
      const product = await createTestProduct({ basePrice: 10_000 });

      // Pre-invoice (counts):
      await createTestOrder({
        customerId: customer.id,
        status: 'confirmed',
        items: [{ productId: product.id, quantity: 5, unitPrice: 10_000 }], // $500
      });
      await createTestOrder({
        customerId: customer.id,
        status: 'packing',
        items: [{ productId: product.id, quantity: 3, unitPrice: 10_000 }], // $300
      });
      await createTestOrder({
        customerId: customer.id,
        status: 'awaiting_approval',
        items: [{ productId: product.id, quantity: 2, unitPrice: 10_000 }], // $200
      });

      // Invoiced (NOT counted again — already in arBalance):
      await createTestOrder({
        customerId: customer.id,
        status: 'ready_for_delivery',
        items: [{ productId: product.id, quantity: 10, unitPrice: 10_000 }],
      });
      await createTestOrder({
        customerId: customer.id,
        status: 'out_for_delivery',
        items: [{ productId: product.id, quantity: 5, unitPrice: 10_000 }],
      });

      const available = await calculateAvailableCredit(customer.id, 1_000_000);

      // 1_000_000 − 200_000 − (50_000 + 30_000 + 20_000) = 700_000
      expect(available).toBe(700_000);
    });

    it('calculateAvailableCredit handles null arBalance (treated as zero)', async () => {
      const customer = await createTestCustomer({
        creditLimit: 500_000,
        // No xeroContactId / arBalance
      });
      const product = await createTestProduct({ basePrice: 10_000 });

      await createTestOrder({
        customerId: customer.id,
        status: 'confirmed',
        items: [{ productId: product.id, quantity: 3, unitPrice: 10_000 }], // $300
      });

      const available = await calculateAvailableCredit(customer.id, 500_000);

      // 500_000 − 0 − 30_000 = 470_000
      expect(available).toBe(470_000);
    });

    it('calculateAvailableCredit can go negative when over credit', async () => {
      const customer = await createTestCustomer({
        creditLimit: 100_000, // $1000
        xeroContactId: 'xero-1',
        arBalance: { outstandingCents: 150_000 }, // already $500 over
      });

      const available = await calculateAvailableCredit(customer.id, 100_000);

      expect(available).toBe(-50_000);
    });

    it('getOutstandingBalance = arBalance + pre-invoice in-flight', async () => {
      const customer = await createTestCustomer({
        xeroContactId: 'xero-1',
        arBalance: { outstandingCents: 300_000 },
      });
      const product = await createTestProduct({ basePrice: 10_000 });

      await createTestOrder({
        customerId: customer.id,
        status: 'awaiting_approval',
        items: [{ productId: product.id, quantity: 2, unitPrice: 10_000 }], // $200
      });
      await createTestOrder({
        customerId: customer.id,
        status: 'packing',
        items: [{ productId: product.id, quantity: 1, unitPrice: 10_000 }], // $100
      });
      // Excluded under Xero-AR: ready_for_delivery is already in arBalance.
      await createTestOrder({
        customerId: customer.id,
        status: 'ready_for_delivery',
        items: [{ productId: product.id, quantity: 5, unitPrice: 10_000 }],
      });

      const balance = await getOutstandingBalance(customer.id);

      // 300_000 + (20_000 + 10_000) = 330_000
      expect(balance).toBe(330_000);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases under flag ON — exclusions, null arBalance, bypass-credit
  // -------------------------------------------------------------------------
  describe('flag ON — edge cases', () => {
    beforeEach(() => {
      process.env[FLAG_KEY] = 'true';
    });

    it('excludes delivered / cancelled / merged orders from in-flight', async () => {
      const customer = await createTestCustomer({
        creditLimit: 1_000_000,
        xeroContactId: 'xero-1',
        arBalance: { outstandingCents: 0 },
      });
      const product = await createTestProduct({ basePrice: 10_000 });

      // None of these should count under the Xero-AR formula:
      await createTestOrder({
        customerId: customer.id,
        status: 'delivered',
        items: [{ productId: product.id, quantity: 5, unitPrice: 10_000 }],
      });
      await createTestOrder({
        customerId: customer.id,
        status: 'cancelled',
        items: [{ productId: product.id, quantity: 5, unitPrice: 10_000 }],
      });

      const available = await calculateAvailableCredit(customer.id, 1_000_000);
      const balance = await getOutstandingBalance(customer.id);

      expect(available).toBe(1_000_000);
      expect(balance).toBe(0);
    });

    it('handles xeroContactId set but arBalance still null (just-synced contact, no invoices yet)', async () => {
      const customer = await createTestCustomer({
        creditLimit: 500_000,
        xeroContactId: 'xero-newly-synced',
        // No arBalance — represents customer synced as contact but never had AR fetched
      });
      const product = await createTestProduct({ basePrice: 10_000 });
      await createTestOrder({
        customerId: customer.id,
        status: 'confirmed',
        items: [{ productId: product.id, quantity: 4, unitPrice: 10_000 }], // $400
      });

      const available = await calculateAvailableCredit(customer.id, 500_000);
      const balance = await getOutstandingBalance(customer.id);

      // arBalance treated as zero; only in-flight counts
      expect(available).toBe(500_000 - 40_000);
      expect(balance).toBe(40_000);
    });

    it('counts bypass-credit historical orders via arBalance (semantic change vs legacy)', async () => {
      // Scenario: a previous order was placed with bypassCreditLimit=true, has
      // shipped + been invoiced, and now lives entirely in arBalance.outstandingCents.
      // Under legacy formula it would have stopped counting once delivered.
      // Under Xero-AR formula it correctly continues to consume credit.
      const customer = await createTestCustomer({
        creditLimit: 100_000, // $1000 limit
        xeroContactId: 'xero-1',
        arBalance: { outstandingCents: 80_000 }, // $800 from past bypassed order, still owed
      });
      const product = await createTestProduct({ basePrice: 10_000 });

      // Historical bypassed order, now delivered (in joho-erp's view)
      await createTestOrder({
        customerId: customer.id,
        status: 'delivered',
        bypassCreditLimit: true,
        bypassCreditReason: 'manual override',
        items: [{ productId: product.id, quantity: 8, unitPrice: 10_000 }],
      });

      const available = await calculateAvailableCredit(customer.id, 100_000);

      // Xero-AR: 100_000 − 80_000 (still in arBalance) − 0 (no in-flight) = 20_000
      expect(available).toBe(20_000);
    });
  });

  // -------------------------------------------------------------------------
  // Flag respected at runtime
  // -------------------------------------------------------------------------
  describe('flag is respected at runtime', () => {
    it('flipping the flag changes the formula on the next call', async () => {
      const customer = await createTestCustomer({
        creditLimit: 1_000_000,
        xeroContactId: 'xero-1',
        arBalance: { outstandingCents: 200_000 },
      });
      const product = await createTestProduct({ basePrice: 10_000 });
      await createTestOrder({
        customerId: customer.id,
        status: 'ready_for_delivery',
        items: [{ productId: product.id, quantity: 10, unitPrice: 10_000 }], // $1000
      });

      process.env[FLAG_KEY] = 'false';
      const legacy = await calculateAvailableCredit(customer.id, 1_000_000);
      // Legacy: 1_000_000 − 100_000 = 900_000 (arBalance ignored)
      expect(legacy).toBe(900_000);

      process.env[FLAG_KEY] = 'true';
      const xeroAr = await calculateAvailableCredit(customer.id, 1_000_000);
      // Xero-AR: 1_000_000 − 200_000 − 0 = 800_000 (ready_for_delivery excluded)
      expect(xeroAr).toBe(800_000);
    });
  });
});
