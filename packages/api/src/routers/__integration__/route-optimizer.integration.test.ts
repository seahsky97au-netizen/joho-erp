import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { getPrismaClient } from '@joho-erp/database';
import { getUTCDayRangeForMelbourneDay } from '@joho-erp/shared';
import { cleanAllData } from '../../test-utils/db-helpers';
import { createTestProduct, createTestCustomer } from '../../test-utils/factories';

// The global setup mocks route-optimizer for tRPC tests. For this file we
// want to exercise the *real* implementation, so re-mock it with the actual
// module. Mapbox stays mocked at the boundary (deterministic stub data).
vi.mock('../../services/route-optimizer', async () => {
  return await vi.importActual('../../services/route-optimizer');
});

vi.mock('../../services/mapbox', () => ({
  optimizeRoute: vi.fn(),
  optimizeRoutesByArea: vi.fn(),
  calculateArrivalTimes: vi.fn(),
  formatDistance: vi.fn().mockReturnValue('10 km'),
  formatDuration: vi.fn().mockReturnValue('20 min'),
}));

import { optimizeDeliveryRoute, assignPreliminaryPackingSequence } from '../../services/route-optimizer';
import { optimizeRoutesByArea, calculateArrivalTimes } from '../../services/mapbox';

describe('route-optimizer.optimizeDeliveryRoute', () => {
  const prisma = getPrismaClient();

  let product: Awaited<ReturnType<typeof createTestProduct>>;
  let customer: Awaited<ReturnType<typeof createTestCustomer>>;
  let northArea: { id: string; name: string };
  let deliveryDate: Date;

  beforeAll(async () => {
    await cleanAllData();

    // Optimizer requires a Company with delivery settings (warehouse coords)
    await prisma.company.create({
      data: {
        businessName: 'Optimizer Test Co',
        abn: '11111111111',
        email: 'opt@test.com',
        phone: '0300000000',
        address: {
          street: '100 Co St',
          suburb: 'Melbourne',
          state: 'VIC',
          postcode: '3000',
          country: 'Australia',
        },
        contactPerson: {
          firstName: 'Admin',
          lastName: 'Test',
          email: 'admin@opt.test',
          phone: '0400000000',
        },
        deliverySettings: {
          warehouseAddress: {
            street: '100 Warehouse Way',
            suburb: 'Melbourne',
            state: 'VIC',
            postcode: '3000',
            country: 'Australia',
            latitude: -37.8136,
            longitude: 144.9631,
          },
          workingDays: [1, 2, 3, 4, 5, 6],
        },
      },
    });

    product = await createTestProduct({
      name: 'Optimizer Product',
      sku: 'OPT-A',
      basePrice: 1500,
      currentStock: 200,
    });
    customer = await createTestCustomer({ businessName: 'Optimizer Test Customer' });

    const north = await prisma.area.create({
      data: {
        name: 'opt-north',
        displayName: 'Optimizer North',
        colorVariant: 'info',
        isActive: true,
        sortOrder: 1,
      },
    });
    northArea = { id: north.id, name: north.name };

    process.env.NEXT_PUBLIC_MAPBOX_TOKEN = 'test-token';
  });

  afterAll(async () => {
    await cleanAllData();
  });

  beforeEach(async () => {
    await prisma.order.deleteMany({ where: { customerId: customer.id } });
    await prisma.routeOptimization.deleteMany({});

    deliveryDate = new Date();
    deliveryDate.setDate(deliveryDate.getDate() + 1);
    deliveryDate.setHours(0, 0, 0, 0);

    vi.mocked(calculateArrivalTimes).mockReturnValue([new Date(), new Date()]);
  });

  async function createOrderWithPackedItems(
    packedItems: string[],
    overrides: { latitude?: number; longitude?: number } = {}
  ) {
    const order = await prisma.order.create({
      data: {
        orderNumber: `OPT-${Math.random().toString(36).slice(2, 8)}`,
        customerId: customer.id,
        customerName: customer.businessName,
        status: 'packing',
        items: [
          {
            productId: product.id,
            productName: product.name,
            sku: product.sku,
            quantity: 2,
            unit: 'kg',
            unitPrice: 1500,
            subtotal: 3000,
            applyGst: false,
          },
        ],
        subtotal: 3000,
        taxAmount: 0,
        totalAmount: 3000,
        deliveryAddress: {
          street: '1 Delivery St',
          suburb: 'Suburbia',
          state: 'VIC',
          postcode: '3000',
          country: 'Australia',
          areaId: northArea.id,
          areaName: northArea.name,
          latitude: overrides.latitude ?? -37.81,
          longitude: overrides.longitude ?? 144.96,
        },
        requestedDeliveryDate: deliveryDate,
        orderedAt: new Date(),
        createdBy: 'test-system',
        statusHistory: [],
        packing: {
          packedItems,
          areaPackingSequence: 1,
          lastPackedBy: 'packer-1',
          lastPackedAt: new Date(),
        },
      },
    });
    return order;
  }

  it('preserves packedItems when re-running optimization', async () => {
    // Arrange: two orders in the same area, each with in-progress packed items
    const o1 = await createOrderWithPackedItems(['SKU-A', 'SKU-B'], { latitude: -37.81, longitude: 144.96 });
    const o2 = await createOrderWithPackedItems(['SKU-C'], { latitude: -37.82, longitude: 144.97 });

    // Stub Mapbox to return both orders in the same area, in a known order
    vi.mocked(optimizeRoutesByArea).mockResolvedValue(
      new Map([
        [
          northArea.name,
          {
            coordinateIds: [o1.id, o2.id],
            totalDistance: 5000,
            totalDuration: 600,
            segments: [
              { distance: 2500, duration: 300 },
              { distance: 2500, duration: 300 },
            ],
            routeGeometry: '{}',
          },
        ],
      ]) as never
    );
    vi.mocked(calculateArrivalTimes).mockReturnValue([new Date(), new Date()]);

    // Act
    await optimizeDeliveryRoute(deliveryDate, 'test-user');

    // Assert: packedItems must be preserved
    const refreshed1 = await prisma.order.findUnique({ where: { id: o1.id } });
    const refreshed2 = await prisma.order.findUnique({ where: { id: o2.id } });

    expect(refreshed1?.packing?.packedItems).toEqual(['SKU-A', 'SKU-B']);
    expect(refreshed2?.packing?.packedItems).toEqual(['SKU-C']);

    // Sanity-check that the optimizer did write sequences (so we know it ran)
    expect(refreshed1?.packing?.areaPackingSequence).toBeDefined();
    expect(refreshed2?.packing?.areaPackingSequence).toBeDefined();
  });

  it('assignPreliminaryPackingSequence skips assignment when the area is locked', async () => {
    // Arrange: lock the north area
    const { start: startOfDay } = getUTCDayRangeForMelbourneDay(deliveryDate);
    await prisma.routeOptimization.create({
      data: {
        deliveryDate: startOfDay,
        routeType: 'packing',
        areaId: northArea.id,
        orderCount: 0,
        totalDistance: 0,
        totalDuration: 0,
        routeGeometry: '{}',
        waypoints: [],
        optimizedAt: new Date(),
        optimizedBy: 'system',
        manuallyLocked: true,
        manuallyLockedAt: new Date(),
        manuallyLockedBy: 'admin',
      },
    });

    // Create a new order in the locked area
    const newOrder = await createOrderWithPackedItems([]);
    // Reset the order's packing field so we can observe whether assignment writes to it
    await prisma.order.update({
      where: { id: newOrder.id },
      data: { packing: { areaPackingSequence: null, packedItems: [] } },
    });

    // Act
    const seq = await assignPreliminaryPackingSequence(deliveryDate, newOrder.id, northArea.name);

    // Assert: returns 0 (sentinel for "not assigned") and leaves the order's
    // sequence null — admin must slot it in via DnD reorder.
    expect(seq).toBe(0);
    const refreshed = await prisma.order.findUnique({ where: { id: newOrder.id } });
    expect(refreshed?.packing?.areaPackingSequence ?? null).toBeNull();
  });

  it('assignPreliminaryPackingSequence still assigns when the area is NOT locked', async () => {
    const newOrder = await createOrderWithPackedItems([]);
    await prisma.order.update({
      where: { id: newOrder.id },
      data: { packing: { areaPackingSequence: null, packedItems: [] } },
    });

    const seq = await assignPreliminaryPackingSequence(deliveryDate, newOrder.id, northArea.name);

    expect(seq).toBeGreaterThan(0);
    const refreshed = await prisma.order.findUnique({ where: { id: newOrder.id } });
    expect(refreshed?.packing?.areaPackingSequence).toBe(seq);
  });

  it('preserves other packing fields (lastPackedBy/lastPackedAt) across re-optimization', async () => {
    const o1 = await createOrderWithPackedItems(['SKU-X']);

    vi.mocked(optimizeRoutesByArea).mockResolvedValue(
      new Map([
        [
          northArea.name,
          {
            coordinateIds: [o1.id],
            totalDistance: 1000,
            totalDuration: 120,
            segments: [{ distance: 1000, duration: 120 }],
            routeGeometry: '{}',
          },
        ],
      ]) as never
    );
    vi.mocked(calculateArrivalTimes).mockReturnValue([new Date()]);

    await optimizeDeliveryRoute(deliveryDate, 'test-user');

    const refreshed = await prisma.order.findUnique({ where: { id: o1.id } });
    expect(refreshed?.packing?.packedItems).toEqual(['SKU-X']);
    expect(refreshed?.packing?.lastPackedBy).toBe('packer-1');
    expect(refreshed?.packing?.lastPackedAt).toBeInstanceOf(Date);
  });
});
