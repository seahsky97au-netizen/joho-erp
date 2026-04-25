import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { adminCaller, packerCaller } from '../../test-utils/create-test-caller';
import { cleanAllData } from '../../test-utils/db-helpers';
import { createTestProduct, createTestCustomer, createTestOrder } from '../../test-utils/factories';
import { getPrismaClient } from '@joho-erp/database';
import { getUTCDayRangeForMelbourneDay } from '@joho-erp/shared';

describe('Manual Packing Sequence Override', () => {
  const prisma = getPrismaClient();

  let product: Awaited<ReturnType<typeof createTestProduct>>;
  let customer: Awaited<ReturnType<typeof createTestCustomer>>;
  let northArea: { id: string; name: string };
  let southArea: { id: string; name: string };
  let deliveryDate: Date;

  beforeAll(async () => {
    await cleanAllData();

    product = await createTestProduct({
      name: 'Reorder Product',
      sku: 'REORDER-A',
      basePrice: 1500,
      currentStock: 200,
    });
    customer = await createTestCustomer({ businessName: 'Reorder Test Customer' });

    const north = await prisma.area.create({
      data: {
        name: 'reorder-north',
        displayName: 'Reorder North',
        colorVariant: 'info',
        isActive: true,
        sortOrder: 1,
      },
    });
    const south = await prisma.area.create({
      data: {
        name: 'reorder-south',
        displayName: 'Reorder South',
        colorVariant: 'success',
        isActive: true,
        sortOrder: 2,
      },
    });
    northArea = { id: north.id, name: north.name };
    southArea = { id: south.id, name: south.name };
  });

  afterAll(async () => {
    await cleanAllData();
  });

  beforeEach(async () => {
    // Reset orders + route optimizations between tests so each scenario starts fresh.
    await prisma.order.deleteMany({ where: { customerId: customer.id } });
    await prisma.routeOptimization.deleteMany({});

    deliveryDate = new Date();
    deliveryDate.setDate(deliveryDate.getDate() + 1);
    deliveryDate.setHours(0, 0, 0, 0);
  });

  async function createOrderInArea(
    area: { id: string; name: string },
    overrides: { status?: 'confirmed' | 'packing' | 'ready_for_delivery'; sequence?: number } = {}
  ) {
    const order = await createTestOrder({
      customerId: customer.id,
      customerName: customer.businessName,
      items: [
        { productId: product.id, sku: product.sku, productName: product.name, quantity: 1, unitPrice: 1500 },
      ],
      status: overrides.status ?? 'confirmed',
      requestedDeliveryDate: deliveryDate,
      deliveryAddress: {
        street: '1 Test Way',
        suburb: 'Suburbia',
        state: 'VIC',
        postcode: '3000',
        country: 'Australia',
        areaId: area.id,
        areaName: area.name,
      },
    });
    if (overrides.sequence !== undefined) {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          packing: {
            areaPackingSequence: overrides.sequence,
            packedItems: [],
          },
        },
      });
    }
    return order;
  }

  describe('packing.reorderArea', () => {
    it('rewrites areaPackingSequence to 1..N in the supplied order', async () => {
      const caller = adminCaller();

      const o1 = await createOrderInArea(northArea, { sequence: 1 });
      const o2 = await createOrderInArea(northArea, { sequence: 2 });
      const o3 = await createOrderInArea(northArea, { sequence: 3 });

      const result = await caller.packing.reorderArea({
        deliveryDate: deliveryDate.toISOString(),
        areaId: northArea.id,
        orderIdsInOrder: [o3.id, o1.id, o2.id],
      });

      expect(result).toEqual({ updatedCount: 3 });

      const updated = await prisma.order.findMany({
        where: { id: { in: [o1.id, o2.id, o3.id] } },
      });
      const seqById = new Map(updated.map((o) => [o.id, o.packing?.areaPackingSequence]));
      expect(seqById.get(o3.id)).toBe(1);
      expect(seqById.get(o1.id)).toBe(2);
      expect(seqById.get(o2.id)).toBe(3);
    });

    it('rejects when an order is in ready_for_delivery status', async () => {
      const caller = adminCaller();

      const o1 = await createOrderInArea(northArea, { status: 'confirmed', sequence: 1 });
      const o2 = await createOrderInArea(northArea, { status: 'ready_for_delivery', sequence: 2 });

      await expect(
        caller.packing.reorderArea({
          deliveryDate: deliveryDate.toISOString(),
          areaId: northArea.id,
          orderIdsInOrder: [o2.id, o1.id],
        })
      ).rejects.toThrow(/no longer match|refresh/i);
    });

    it('rejects when an order belongs to a different area', async () => {
      const caller = adminCaller();

      const oNorth = await createOrderInArea(northArea, { sequence: 1 });
      const oSouth = await createOrderInArea(southArea, { sequence: 1 });

      await expect(
        caller.packing.reorderArea({
          deliveryDate: deliveryDate.toISOString(),
          areaId: northArea.id,
          orderIdsInOrder: [oNorth.id, oSouth.id],
        })
      ).rejects.toThrow(/no longer match|refresh/i);
    });

    it('creates a RouteOptimization lock record with manuallyLocked=true', async () => {
      const caller = adminCaller();

      const o1 = await createOrderInArea(northArea);
      const o2 = await createOrderInArea(northArea);

      await caller.packing.reorderArea({
        deliveryDate: deliveryDate.toISOString(),
        areaId: northArea.id,
        orderIdsInOrder: [o2.id, o1.id],
      });

      const { start: startOfDay, end: endOfDay } = getUTCDayRangeForMelbourneDay(deliveryDate);
      const lock = await prisma.routeOptimization.findFirst({
        where: {
          deliveryDate: { gte: startOfDay, lt: endOfDay },
          areaId: northArea.id,
          routeType: 'packing',
        },
      });
      expect(lock).not.toBeNull();
      expect(lock!.manuallyLocked).toBe(true);
      expect(lock!.manuallyLockedAt).toBeInstanceOf(Date);
      expect(lock!.manuallyLockedBy).toBe('admin-user-id');
    });

    it('updates an existing RouteOptimization record rather than creating a duplicate', async () => {
      const caller = adminCaller();

      const o1 = await createOrderInArea(northArea);
      const o2 = await createOrderInArea(northArea);

      // Pre-existing per-area route record (e.g., from a prior optimization run)
      const { start: startOfDay } = getUTCDayRangeForMelbourneDay(deliveryDate);
      await prisma.routeOptimization.create({
        data: {
          deliveryDate: startOfDay,
          routeType: 'packing',
          areaId: northArea.id,
          orderCount: 2,
          totalDistance: 5,
          totalDuration: 600,
          routeGeometry: '{}',
          waypoints: [],
          optimizedAt: new Date(),
          optimizedBy: 'system',
          manuallyLocked: false,
        },
      });

      await caller.packing.reorderArea({
        deliveryDate: deliveryDate.toISOString(),
        areaId: northArea.id,
        orderIdsInOrder: [o2.id, o1.id],
      });

      const records = await prisma.routeOptimization.findMany({
        where: {
          areaId: northArea.id,
          routeType: 'packing',
        },
      });
      expect(records).toHaveLength(1);
      expect(records[0].manuallyLocked).toBe(true);
    });

    it('appends a status history entry for each reordered order', async () => {
      const caller = adminCaller();

      const o1 = await createOrderInArea(northArea);
      const o2 = await createOrderInArea(northArea);

      await caller.packing.reorderArea({
        deliveryDate: deliveryDate.toISOString(),
        areaId: northArea.id,
        orderIdsInOrder: [o2.id, o1.id],
      });

      const updated = await prisma.order.findMany({
        where: { id: { in: [o1.id, o2.id] } },
      });
      for (const order of updated) {
        const lastEntry = order.statusHistory[order.statusHistory.length - 1];
        expect(lastEntry?.notes).toMatch(/Packing sequence manually set/i);
      }
    });
  });

  describe('packing.resetAreaToOptimized', () => {
    it('clears manuallyLocked on the lock record', async () => {
      const caller = adminCaller();

      const o1 = await createOrderInArea(northArea);
      const o2 = await createOrderInArea(northArea);

      await caller.packing.reorderArea({
        deliveryDate: deliveryDate.toISOString(),
        areaId: northArea.id,
        orderIdsInOrder: [o2.id, o1.id],
      });

      const result = await caller.packing.resetAreaToOptimized({
        deliveryDate: deliveryDate.toISOString(),
        areaId: northArea.id,
      });

      expect(result).toEqual({ ok: true });

      const lock = await prisma.routeOptimization.findFirst({
        where: { areaId: northArea.id, routeType: 'packing' },
      });
      expect(lock?.manuallyLocked).toBe(false);
      expect(lock?.manuallyLockedAt).toBeNull();
      expect(lock?.manuallyLockedBy).toBeNull();
    });

    it('sets needsReoptimization=true on the multi-area packing record', async () => {
      const caller = adminCaller();

      // Create the multi-area packing record (mirrors the optimizer's output)
      const { start: startOfDay } = getUTCDayRangeForMelbourneDay(deliveryDate);
      const multi = await prisma.routeOptimization.create({
        data: {
          deliveryDate: startOfDay,
          routeType: 'packing',
          areaId: null,
          orderCount: 3,
          totalDistance: 15,
          totalDuration: 1800,
          routeGeometry: '{}',
          waypoints: [],
          optimizedAt: new Date(),
          optimizedBy: 'system',
          needsReoptimization: false,
        },
      });

      await caller.packing.resetAreaToOptimized({
        deliveryDate: deliveryDate.toISOString(),
        areaId: northArea.id,
      });

      const refreshed = await prisma.routeOptimization.findUnique({ where: { id: multi.id } });
      expect(refreshed?.needsReoptimization).toBe(true);
    });

    it('is a no-op when there is no lock record yet', async () => {
      const caller = adminCaller();

      const result = await caller.packing.resetAreaToOptimized({
        deliveryDate: deliveryDate.toISOString(),
        areaId: northArea.id,
      });
      expect(result).toEqual({ ok: true });
    });
  });

  describe('packing.getOptimizedSession.areaLocks', () => {
    it('exposes per-area lock state in the response', async () => {
      const adminC = adminCaller();
      const o1 = await createOrderInArea(northArea);
      const o2 = await createOrderInArea(northArea);
      await createOrderInArea(southArea);

      await adminC.packing.reorderArea({
        deliveryDate: deliveryDate.toISOString(),
        areaId: northArea.id,
        orderIdsInOrder: [o2.id, o1.id],
      });

      const session = await packerCaller().packing.getOptimizedSession({
        deliveryDate: deliveryDate.toISOString(),
      });

      expect(session.areaLocks).toBeDefined();
      const northLock = session.areaLocks!.find((l) => l.areaId === northArea.id);
      expect(northLock?.manuallyLocked).toBe(true);
      expect(northLock?.manuallyLockedAt).toBeInstanceOf(Date);
      const southLock = session.areaLocks!.find((l) => l.areaId === southArea.id);
      // South area was never locked — there is no record for it
      expect(southLock).toBeUndefined();
    });
  });
});
