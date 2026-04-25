import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getPrismaClient } from '@joho-erp/database';
import { getUTCDayRangeForMelbourneDay } from '@joho-erp/shared';
import { adminCaller, customerCaller } from '../../test-utils/create-test-caller';
import { cleanTransactionalData } from '../../test-utils/db-helpers';
import { createTestProduct, createTestCustomer, createTestCompany } from '../../test-utils/factories';

const prisma = getPrismaClient();

/**
 * Integration tests for order.rescheduleDelivery
 */

const CUSTOMER_CLERK_ID = 'test-reschedule-customer';

let product: Awaited<ReturnType<typeof createTestProduct>>;
let customer: Awaited<ReturnType<typeof createTestCustomer>>;

/**
 * Returns a safe delivery date well in the future, on a Wednesday.
 */
function getSafeDeliveryDate(daysOut = 14): Date {
  const date = new Date();
  date.setDate(date.getDate() + daysOut);
  const day = date.getDay();
  const daysUntilWednesday = (3 - day + 7) % 7 || 7;
  date.setDate(date.getDate() + daysUntilWednesday);
  date.setHours(10, 0, 0, 0);
  return date;
}

/** Returns a future date guaranteed to be a Sunday. */
function getFutureSunday(daysOut = 21): Date {
  const date = new Date();
  date.setDate(date.getDate() + daysOut);
  const day = date.getDay();
  const daysUntilSunday = (7 - day) % 7 || 7;
  date.setDate(date.getDate() + daysUntilSunday);
  date.setHours(0, 0, 0, 0);
  return date;
}

describe('order.rescheduleDelivery', () => {
  beforeAll(async () => {
    await cleanTransactionalData();
    await createTestCompany();

    product = await createTestProduct({
      name: 'Reschedule Test Beef',
      sku: 'RT-BEEF-001',
      basePrice: 2500,
      currentStock: 100,
      applyGst: false,
    });

    customer = await createTestCustomer({
      clerkUserId: CUSTOMER_CLERK_ID,
      businessName: 'Reschedule Test Restaurant',
      creditLimit: 1000000,
      creditStatus: 'approved',
      onboardingComplete: true,
      status: 'active',
    });
  });

  afterAll(async () => {
    await cleanTransactionalData();
  });

  it('reschedules a confirmed order: updates date and appends statusHistory entry', async () => {
    const customerCallerInst = customerCaller(CUSTOMER_CLERK_ID);
    const adminCallerInst = adminCaller();

    const originalDate = getSafeDeliveryDate(7);
    const order = await customerCallerInst.order.create({
      items: [{ productId: product.id, quantity: 1 }],
      requestedDeliveryDate: originalDate,
    });
    expect(order.status).toBe('confirmed');

    const newDate = getSafeDeliveryDate(21);
    const updated = await adminCallerInst.order.rescheduleDelivery({
      orderId: order.id,
      newDeliveryDate: newDate,
      reason: 'Customer requested',
    });

    expect(updated.requestedDeliveryDate.toISOString().slice(0, 10)).toBe(
      newDate.toISOString().slice(0, 10)
    );

    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    expect(persisted).not.toBeNull();
    const history = persisted!.statusHistory as Array<{
      status: string;
      changedBy: string;
      notes?: string;
    }>;
    const rescheduleEntry = history.find((h) => h.status === 'delivery_rescheduled');
    expect(rescheduleEntry).toBeDefined();
    expect(rescheduleEntry!.notes).toMatch(originalDate.toISOString().slice(0, 10));
    expect(rescheduleEntry!.notes).toMatch(newDate.toISOString().slice(0, 10));
    expect(rescheduleEntry!.notes).toMatch(/Customer requested/);
  });

  it('reschedules an awaiting_approval order', async () => {
    const adminCallerInst = adminCaller();

    // Manually create an awaiting_approval order
    const order = await prisma.order.create({
      data: {
        orderNumber: 'TEST-RESCH-AA-001',
        customerId: customer.id,
        customerName: customer.businessName,
        status: 'awaiting_approval',
        items: [
          {
            productId: product.id,
            productName: product.name,
            sku: product.sku,
            quantity: 1,
            unit: 'kg',
            unitPrice: 2500,
            subtotal: 2500,
            applyGst: false,
          },
        ],
        subtotal: 2500,
        taxAmount: 0,
        totalAmount: 2500,
        deliveryAddress: {
          street: '1 Test St',
          suburb: 'Melbourne',
          state: 'VIC',
          postcode: '3000',
        },
        requestedDeliveryDate: getSafeDeliveryDate(7),
        orderedAt: new Date(),
        createdBy: 'test-system',
        statusHistory: [
          {
            status: 'awaiting_approval',
            changedAt: new Date(),
            changedBy: 'system',
          },
        ],
      },
    });

    const newDate = getSafeDeliveryDate(28);
    const updated = await adminCallerInst.order.rescheduleDelivery({
      orderId: order.id,
      newDeliveryDate: newDate,
    });

    expect(updated.requestedDeliveryDate.toISOString().slice(0, 10)).toBe(
      newDate.toISOString().slice(0, 10)
    );
  });

  it('throws FORBIDDEN when the order is in a non-reschedulable status (packing)', async () => {
    const adminCallerInst = adminCaller();

    const order = await prisma.order.create({
      data: {
        orderNumber: 'TEST-RESCH-PACK-001',
        customerId: customer.id,
        customerName: customer.businessName,
        status: 'packing',
        items: [
          {
            productId: product.id,
            productName: product.name,
            sku: product.sku,
            quantity: 1,
            unit: 'kg',
            unitPrice: 2500,
            subtotal: 2500,
            applyGst: false,
          },
        ],
        subtotal: 2500,
        taxAmount: 0,
        totalAmount: 2500,
        deliveryAddress: {
          street: '1 Test St',
          suburb: 'Melbourne',
          state: 'VIC',
          postcode: '3000',
        },
        requestedDeliveryDate: getSafeDeliveryDate(7),
        orderedAt: new Date(),
        createdBy: 'test-system',
        statusHistory: [],
      },
    });

    await expect(
      adminCallerInst.order.rescheduleDelivery({
        orderId: order.id,
        newDeliveryDate: getSafeDeliveryDate(21),
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>);
  });

  it('throws BAD_REQUEST when the new date is not a working day', async () => {
    const customerCallerInst = customerCaller(CUSTOMER_CLERK_ID);
    const adminCallerInst = adminCaller();

    const order = await customerCallerInst.order.create({
      items: [{ productId: product.id, quantity: 1 }],
      requestedDeliveryDate: getSafeDeliveryDate(7),
    });

    await expect(
      adminCallerInst.order.rescheduleDelivery({
        orderId: order.id,
        newDeliveryDate: getFutureSunday(),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' } satisfies Partial<TRPCError>);
  });

  it('clears stale packing/delivery sequences when rescheduling a confirmed order', async () => {
    const customerCallerInst = customerCaller(CUSTOMER_CLERK_ID);
    const adminCallerInst = adminCaller();

    const originalDate = getSafeDeliveryDate(7);
    const order = await customerCallerInst.order.create({
      items: [{ productId: product.id, quantity: 1 }],
      requestedDeliveryDate: originalDate,
    });

    // Simulate optimizer output: order has sequences for the OLD day
    await prisma.order.update({
      where: { id: order.id },
      data: {
        packing: {
          areaPackingSequence: 3,
          packedItems: [],
        },
        delivery: {
          deliverySequence: 5,
          areaDeliverySequence: 2,
          routeId: 'old-route-id',
          estimatedArrival: new Date(),
        },
      },
    });

    const newDate = getSafeDeliveryDate(21);
    await adminCallerInst.order.rescheduleDelivery({
      orderId: order.id,
      newDeliveryDate: newDate,
    });

    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    // Old-day delivery sequences must be cleared
    expect(persisted?.delivery?.deliverySequence).toBeNull();
    expect(persisted?.delivery?.areaDeliverySequence).toBeNull();
    expect(persisted?.delivery?.routeId).toBeNull();
    expect(persisted?.delivery?.estimatedArrival).toBeNull();
    // Packing sequence is reassigned for the NEW day by assignPreliminaryPackingSequence
    expect(persisted?.packing?.areaPackingSequence).toBe(1);
  });

  it('flags the old day\'s multi-area packing route for re-optimization', async () => {
    const customerCallerInst = customerCaller(CUSTOMER_CLERK_ID);
    const adminCallerInst = adminCaller();

    const originalDate = getSafeDeliveryDate(7);
    const order = await customerCallerInst.order.create({
      items: [{ productId: product.id, quantity: 1 }],
      requestedDeliveryDate: originalDate,
    });

    // Order has a packing sequence for the OLD day
    await prisma.order.update({
      where: { id: order.id },
      data: {
        packing: { areaPackingSequence: 1, packedItems: [] },
      },
    });

    // Pre-existing optimized route for the OLD day (areaId=null = multi-area)
    const { start: oldStart } = getUTCDayRangeForMelbourneDay(originalDate);
    const oldRoute = await prisma.routeOptimization.create({
      data: {
        deliveryDate: oldStart,
        routeType: 'packing',
        areaId: null,
        orderCount: 1,
        totalDistance: 5,
        totalDuration: 600,
        routeGeometry: '{}',
        waypoints: [],
        optimizedAt: new Date(),
        optimizedBy: 'system',
        needsReoptimization: false,
      },
    });

    await adminCallerInst.order.rescheduleDelivery({
      orderId: order.id,
      newDeliveryDate: getSafeDeliveryDate(21),
    });

    const refreshed = await prisma.routeOptimization.findUnique({ where: { id: oldRoute.id } });
    expect(refreshed?.needsReoptimization).toBe(true);
  });
});
