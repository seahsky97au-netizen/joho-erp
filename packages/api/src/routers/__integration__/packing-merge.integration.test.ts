import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { packerCaller } from '../../test-utils/create-test-caller';
import { cleanAllData } from '../../test-utils/db-helpers';
import { createTestProduct, createTestCustomer, createTestOrder } from '../../test-utils/factories';
import { getPrismaClient } from '@joho-erp/database';

/**
 * Integration tests for the auto-merge behavior added on the packing screen.
 *
 * Auto-merge trigger: any call to `packing.getOptimizedSession` runs
 * `mergeEligibleOrdersInternal` for the supplied delivery date. Orders that
 * share (customerId, addressHash) with another eligible order in 'confirmed'
 * or 'packing' status get merged into the lowest-orderNumber primary.
 *
 * Scenarios covered:
 *   1. Two eligible orders with overlapping (productId, unitPrice) sum quantities.
 *   2. Same setup but differing unitPrice keeps lines separate.
 *   3. Once the primary is fully packed, a newly-created eligible order stays standalone.
 *   4. A primary that was paused stays paused after merge (pausedAt preserved).
 *   5. internalNotes are concatenated with `#<orderNumber>:` prefix per absorbed order.
 */
describe('Packing Auto-Merge', () => {
  const prisma = getPrismaClient();

  let productA: Awaited<ReturnType<typeof createTestProduct>>;
  let productB: Awaited<ReturnType<typeof createTestProduct>>;
  let customer: Awaited<ReturnType<typeof createTestCustomer>>;

  const sharedAddress = {
    street: '42 Merge Lane',
    suburb: 'Melbourne',
    state: 'VIC',
    postcode: '3000',
    country: 'Australia',
  };

  // Use a unique delivery date per test run to avoid cross-test contamination.
  const baseDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  })();

  beforeAll(async () => {
    await cleanAllData();
    productA = await createTestProduct({ name: 'Merge A', sku: 'MRG-A', basePrice: 1000, currentStock: 500 });
    productB = await createTestProduct({ name: 'Merge B', sku: 'MRG-B', basePrice: 2000, currentStock: 500 });
    customer = await createTestCustomer({ businessName: 'Merge Test Customer' });
  });

  afterAll(async () => {
    await cleanAllData();
  });

  beforeEach(async () => {
    // Wipe orders only between tests so the customer/products persist.
    await prisma.order.deleteMany({});
    await prisma.routeOptimization.deleteMany({});
  });

  it('sums quantities for overlapping (productId, unitPrice) lines and marks the second order merged', async () => {
    const caller = packerCaller();

    const a = await createTestOrder({
      customerId: customer.id,
      customerName: customer.businessName,
      items: [
        { productId: productA.id, sku: productA.sku, productName: productA.name, quantity: 3, unitPrice: 1000 },
      ],
      status: 'confirmed',
      requestedDeliveryDate: baseDate,
      deliveryAddress: sharedAddress,
      internalNotes: 'first batch',
    });
    const b = await createTestOrder({
      customerId: customer.id,
      customerName: customer.businessName,
      items: [
        { productId: productA.id, sku: productA.sku, productName: productA.name, quantity: 2, unitPrice: 1000 },
        { productId: productB.id, sku: productB.sku, productName: productB.name, quantity: 1, unitPrice: 2000 },
      ],
      status: 'confirmed',
      requestedDeliveryDate: baseDate,
      deliveryAddress: sharedAddress,
      internalNotes: 'forgot the carton',
    });

    // Determine which order is the lowest-numbered (the primary).
    const sorted = [a, b].sort((x, y) => x.orderNumber.localeCompare(y.orderNumber));
    const expectedPrimaryId = sorted[0].id;
    const expectedAbsorbedId = sorted[1].id;

    const session = await caller.packing.getOptimizedSession({
      deliveryDate: baseDate.toISOString(),
    });

    expect(session.orders).toHaveLength(1);
    expect(session.orders[0].orderId).toBe(expectedPrimaryId);

    const primary = await prisma.order.findUnique({ where: { id: expectedPrimaryId } });
    const absorbed = await prisma.order.findUnique({ where: { id: expectedAbsorbedId } });

    expect(absorbed?.status).toBe('merged');
    expect(absorbed?.mergedIntoOrderId).toBe(expectedPrimaryId);
    expect(absorbed?.mergedAt).toBeTruthy();

    expect(primary?.mergedFromOrderIds).toContain(expectedAbsorbedId);
    expect(primary?.items).toHaveLength(2);
    const mergedA = primary?.items.find((i) => i.productId === productA.id && i.unitPrice === 1000);
    const mergedB = primary?.items.find((i) => i.productId === productB.id);
    expect(mergedA?.quantity).toBe(5); // 3 + 2
    expect(mergedB?.quantity).toBe(1);

    // Notes carry forward with #orderNumber prefix per absorbed order.
    expect(primary?.internalNotes).toContain('first batch');
    expect(primary?.internalNotes).toContain(`#${sorted[1].orderNumber}: forgot the carton`);
  });

  it('keeps lines separate when (productId, unitPrice) differs', async () => {
    const caller = packerCaller();

    const a = await createTestOrder({
      customerId: customer.id,
      customerName: customer.businessName,
      items: [
        { productId: productA.id, sku: productA.sku, productName: productA.name, quantity: 4, unitPrice: 1000 },
      ],
      status: 'confirmed',
      requestedDeliveryDate: baseDate,
      deliveryAddress: sharedAddress,
    });
    const b = await createTestOrder({
      customerId: customer.id,
      customerName: customer.businessName,
      items: [
        // Same product, different unit price (e.g. customer-specific discount).
        { productId: productA.id, sku: productA.sku, productName: productA.name, quantity: 2, unitPrice: 900 },
      ],
      status: 'confirmed',
      requestedDeliveryDate: baseDate,
      deliveryAddress: sharedAddress,
    });

    const sorted = [a, b].sort((x, y) => x.orderNumber.localeCompare(y.orderNumber));
    const expectedPrimaryId = sorted[0].id;

    await caller.packing.getOptimizedSession({ deliveryDate: baseDate.toISOString() });

    const primary = await prisma.order.findUnique({ where: { id: expectedPrimaryId } });
    expect(primary?.items).toHaveLength(2);

    const at1000 = primary?.items.find((i) => i.unitPrice === 1000);
    const at900 = primary?.items.find((i) => i.unitPrice === 900);
    expect(at1000?.quantity).toBe(4);
    expect(at900?.quantity).toBe(2);
  });

  it('does not absorb a new eligible order once the primary is fully packed', async () => {
    const caller = packerCaller();

    const a = await createTestOrder({
      customerId: customer.id,
      customerName: customer.businessName,
      items: [
        { productId: productA.id, sku: productA.sku, productName: productA.name, quantity: 1, unitPrice: 1000 },
      ],
      status: 'confirmed',
      requestedDeliveryDate: baseDate,
      deliveryAddress: sharedAddress,
    });
    const b = await createTestOrder({
      customerId: customer.id,
      customerName: customer.businessName,
      items: [
        { productId: productB.id, sku: productB.sku, productName: productB.name, quantity: 1, unitPrice: 2000 },
      ],
      status: 'confirmed',
      requestedDeliveryDate: baseDate,
      deliveryAddress: sharedAddress,
    });

    // First load: should merge a + b into the lowest-numbered primary.
    await caller.packing.getOptimizedSession({ deliveryDate: baseDate.toISOString() });

    const sorted = [a, b].sort((x, y) => x.orderNumber.localeCompare(y.orderNumber));
    const primaryId = sorted[0].id;

    // Mark all items on primary as packed (simulate completed packing).
    const primaryAfterMerge = await prisma.order.findUnique({ where: { id: primaryId } });
    expect(primaryAfterMerge).toBeTruthy();
    const allSkus = primaryAfterMerge!.items.map((i) => i.sku);
    await prisma.order.update({
      where: { id: primaryId },
      data: {
        packing: {
          ...(primaryAfterMerge!.packing ?? { packedItems: [] }),
          packedItems: allSkus,
        },
      },
    });

    // Add a third eligible order (same customer + same address + same date).
    const c = await createTestOrder({
      customerId: customer.id,
      customerName: customer.businessName,
      items: [
        { productId: productA.id, sku: productA.sku, productName: productA.name, quantity: 1, unitPrice: 1000 },
      ],
      status: 'confirmed',
      requestedDeliveryDate: baseDate,
      deliveryAddress: sharedAddress,
    });

    // Second load: c must NOT be absorbed into the now-fully-packed primary.
    await caller.packing.getOptimizedSession({ deliveryDate: baseDate.toISOString() });

    const cAfter = await prisma.order.findUnique({ where: { id: c.id } });
    expect(cAfter?.status).toBe('confirmed');
    expect(cAfter?.mergedIntoOrderId).toBeNull();
  });

  it('preserves pausedAt on the primary after merge', async () => {
    const caller = packerCaller();

    const a = await createTestOrder({
      customerId: customer.id,
      customerName: customer.businessName,
      items: [
        { productId: productA.id, sku: productA.sku, productName: productA.name, quantity: 5, unitPrice: 1000 },
        { productId: productB.id, sku: productB.sku, productName: productB.name, quantity: 1, unitPrice: 2000 },
      ],
      status: 'packing',
      requestedDeliveryDate: baseDate,
      deliveryAddress: sharedAddress,
    });

    const pausedAt = new Date('2026-04-25T10:30:00Z');
    // Stamp pausedAt onto the primary directly to simulate a paused packing session.
    await prisma.order.update({
      where: { id: a.id },
      data: {
        packing: {
          packedItems: [productA.sku],
          pausedAt,
          lastPackedBy: 'packer-1',
          lastPackedAt: pausedAt,
        },
      },
    });

    const b = await createTestOrder({
      customerId: customer.id,
      customerName: customer.businessName,
      items: [
        { productId: productA.id, sku: productA.sku, productName: productA.name, quantity: 2, unitPrice: 1000 },
      ],
      status: 'confirmed',
      requestedDeliveryDate: baseDate,
      deliveryAddress: sharedAddress,
    });

    // Make sure `a` is the lowest orderNumber so it remains the primary.
    expect(a.orderNumber.localeCompare(b.orderNumber)).toBeLessThan(0);

    await caller.packing.getOptimizedSession({ deliveryDate: baseDate.toISOString() });

    const primaryAfter = await prisma.order.findUnique({ where: { id: a.id } });
    expect(primaryAfter?.packing?.pausedAt?.getTime()).toBe(pausedAt.getTime());
    expect(primaryAfter?.packing?.lastPackedBy).toBe('packer-1');
    // Items should still be merged (sum 5 + 2 = 7 for productA).
    const mergedA = primaryAfter?.items.find((i) => i.productId === productA.id && i.unitPrice === 1000);
    expect(mergedA?.quantity).toBe(7);
  });

  it('flips RouteOptimization.needsReoptimization to true after merging', async () => {
    const caller = packerCaller();

    // Seed a route record with needsReoptimization=false to verify the merge flips it.
    await prisma.routeOptimization.create({
      data: {
        deliveryDate: baseDate,
        routeType: 'packing',
        orderCount: 2,
        totalDistance: 0,
        totalDuration: 0,
        routeGeometry: '{}',
        waypoints: [],
        optimizedAt: new Date(),
        optimizedBy: 'system',
        needsReoptimization: false,
      },
    });

    await createTestOrder({
      customerId: customer.id,
      customerName: customer.businessName,
      items: [{ productId: productA.id, sku: productA.sku, productName: productA.name, quantity: 1, unitPrice: 1000 }],
      status: 'confirmed',
      requestedDeliveryDate: baseDate,
      deliveryAddress: sharedAddress,
    });
    await createTestOrder({
      customerId: customer.id,
      customerName: customer.businessName,
      items: [{ productId: productA.id, sku: productA.sku, productName: productA.name, quantity: 1, unitPrice: 1000 }],
      status: 'confirmed',
      requestedDeliveryDate: baseDate,
      deliveryAddress: sharedAddress,
    });

    await caller.packing.getOptimizedSession({ deliveryDate: baseDate.toISOString() });

    const route = await prisma.routeOptimization.findFirst({ where: { deliveryDate: baseDate, routeType: 'packing', areaId: null } });
    expect(route?.needsReoptimization).toBe(true);
  });
});
