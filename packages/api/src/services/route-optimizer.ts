/**
 * Route Optimizer Service
 * Business logic for calculating delivery routes and packing sequences
 */

import { prisma } from "@joho-erp/database";
import { getUTCDayRangeForMelbourneDay } from "@joho-erp/shared";

export type TransactionClient = Omit<
  typeof prisma,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
import {
  optimizeRoutesByArea,
  calculateArrivalTimes,
} from "./mapbox";
import { sendRouteOptimizedEmail } from "./email";

interface RouteOptimizationResult {
  routeOptimizationId: string;
  orderUpdates: Array<{
    orderId: string;
    orderNumber: string;
    areaPackingSequence: number;
    areaDeliverySequence: number;
    deliverySequence: number;
    estimatedArrival: Date;
    areaName: string;
  }>;
  routeSummary: {
    totalOrders: number;
    totalDistance: number;
    totalDuration: number;
    areaBreakdown: Array<{
      areaName: string;
      orderCount: number;
      distance: number;
      duration: number;
    }>;
  };
}

/**
 * Optimize delivery route and calculate packing/delivery sequences
 *
 * Strategy:
 * 1. Group orders by area (north, south, east, west)
 * 2. Optimize route within each area using Mapbox
 * 3. Calculate delivery sequence (1, 2, 3...)
 * 4. Calculate packing sequence (reverse of delivery, grouped by area)
 * 5. Store route optimization in database
 * 6. Update orders with sequences
 *
 * @param deliveryDate - Date to optimize deliveries for
 * @param userId - User performing the optimization
 * @returns Route optimization result with sequences
 */
export async function optimizeDeliveryRoute(
  deliveryDate: Date,
  userId: string
): Promise<RouteOptimizationResult> {
  // 1. Fetch company delivery settings (warehouse location)
  const company = await prisma.company.findFirst({
    select: {
      deliverySettings: true,
    },
  });

  if (!company?.deliverySettings) {
    throw new Error(
      "Delivery settings not configured. Please configure warehouse location in settings."
    );
  }

  const { warehouseAddress } = company.deliverySettings;

  // Get Mapbox token from environment variable
  const mapboxAccessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  if (!mapboxAccessToken) {
    throw new Error(
      "Mapbox access token not configured in environment variables. Please set NEXT_PUBLIC_MAPBOX_TOKEN."
    );
  }

  if (!warehouseAddress?.latitude || !warehouseAddress?.longitude) {
    throw new Error(
      "Warehouse location not configured. Please add coordinates in delivery settings."
    );
  }

  // 2. Fetch orders for the delivery date (Melbourne day boundaries)
  const { start: startOfDay, end: endOfDay } = getUTCDayRangeForMelbourneDay(deliveryDate);

  const orders = await prisma.order.findMany({
    where: {
      requestedDeliveryDate: {
        gte: startOfDay,
        lt: endOfDay,
      },
      status: {
        in: ["confirmed", "packing", "ready_for_delivery"],
      },
    },
    select: {
      id: true,
      orderNumber: true,
      deliveryAddress: true,
      packing: true,
      delivery: true,
    },
  });

  if (orders.length === 0) {
    throw new Error("No orders found for the specified delivery date");
  }

  // 3. Validate all orders have coordinates
  const ordersWithoutCoordinates = orders.filter(
    (order) =>
      !order.deliveryAddress.latitude || !order.deliveryAddress.longitude
  );

  if (ordersWithoutCoordinates.length > 0) {
    const orderNumbers = ordersWithoutCoordinates
      .map((o) => o.orderNumber)
      .join(", ");
    throw new Error(
      `Orders missing coordinates: ${orderNumbers}. Please add address coordinates before optimizing.`
    );
  }

  // 4. Group orders by area
  const ordersByArea = new Map<
    string,
    Array<{
      id: string;
      orderNumber: string;
      longitude: number;
      latitude: number;
    }>
  >();

  for (const order of orders) {
    // Use 'unassigned' as fallback for orders without area
    const areaName = order.deliveryAddress.areaName ?? 'unassigned';
    if (!ordersByArea.has(areaName)) {
      ordersByArea.set(areaName, []);
    }
    ordersByArea.get(areaName)!.push({
      id: order.id,
      orderNumber: order.orderNumber,
      longitude: order.deliveryAddress.longitude!,
      latitude: order.deliveryAddress.latitude!,
    });
  }

  // 4b. Filter out manually-locked areas — admin-set packing sequences for these
  // areas must not be overwritten by the optimizer.
  const lockedAreaNames = await getLockedAreaNamesForDate(startOfDay, endOfDay);
  for (const lockedName of lockedAreaNames) {
    ordersByArea.delete(lockedName);
  }

  // 5. Optimize routes by area using Mapbox
  const warehouseCoord = {
    longitude: warehouseAddress.longitude,
    latitude: warehouseAddress.latitude,
  };

  const areaRoutes = await optimizeRoutesByArea(
    ordersByArea,
    warehouseCoord,
    mapboxAccessToken
  );

  // 6. Calculate sequences
  const orderUpdates: RouteOptimizationResult["orderUpdates"] = [];
  let globalDeliverySequence = 1;
  const areaBreakdown: RouteOptimizationResult["routeSummary"]["areaBreakdown"] =
    [];

  // Preferred area order for packing (matches typical route order)
  const preferredAreaOrder = ["north", "east", "south", "west"];
  const allAreas = Array.from(areaRoutes.keys());
  const areaOrder = [
    ...preferredAreaOrder.filter((a) => allAreas.includes(a)),
    ...allAreas.filter((a) => !preferredAreaOrder.includes(a)),
  ];

  // Process areas in order
  for (const areaName of areaOrder) {
    const areaRoute = areaRoutes.get(areaName);
    if (!areaRoute) continue;

    const areaOrders = ordersByArea.get(areaName)!;
    const { coordinateIds, totalDistance, totalDuration, segments } = areaRoute;

    // Calculate arrival times (start at 9:00 AM, 5 min per stop)
    const routeStartTime = new Date(deliveryDate);
    routeStartTime.setHours(9, 0, 0, 0);
    const arrivalTimes = calculateArrivalTimes(routeStartTime, segments, 300);

    // Delivery sequence: in order of optimized route (1, 2, 3...)
    // Packing sequence: reverse within area for LIFO loading
    const areaOrderCount = coordinateIds.length;

    coordinateIds.forEach((orderId, index) => {
      const order = areaOrders.find((o) => o.id === orderId)!;
      const deliverySequence = globalDeliverySequence++;

      // Per-area forward: delivery order within area (1, 2, 3...)
      const areaDeliverySequence = index + 1;
      // Per-area LIFO: pack last delivery first within this area
      const areaPackingSequence = areaOrderCount - index;

      orderUpdates.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        deliverySequence,
        areaDeliverySequence,
        areaPackingSequence,
        estimatedArrival: arrivalTimes[index],
        areaName,
      });
    });

    areaBreakdown.push({
      areaName,
      orderCount: areaOrderCount,
      distance: totalDistance,
      duration: totalDuration,
    });
  }

  // 7. Calculate total route stats (per-area sequences already set above)
  const totalDistance = areaBreakdown.reduce(
    (sum, area) => sum + area.distance,
    0
  );
  const totalDuration = areaBreakdown.reduce(
    (sum, area) => sum + area.duration,
    0
  );

  // 9. Combine all route geometries and waypoints
  const allWaypoints: Array<{
    orderId: string;
    orderNumber: string;
    sequence: number;
    address: string;
    latitude: number;
    longitude: number;
    estimatedArrival: Date;
    distanceFromPrevious?: number;
    durationFromPrevious?: number;
  }> = [];

  for (const [areaName, areaRoute] of areaRoutes.entries()) {
    const areaOrders = ordersByArea.get(areaName)!;
    const { coordinateIds, segments } = areaRoute;

    coordinateIds.forEach((orderId, index) => {
      const order = areaOrders.find((o) => o.id === orderId)!;
      const fullOrder = orders.find((o) => o.id === orderId)!;
      const update = orderUpdates.find((u) => u.orderId === orderId)!;

      allWaypoints.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sequence: update.deliverySequence,
        address: `${fullOrder.deliveryAddress.street}, ${fullOrder.deliveryAddress.suburb}`,
        latitude: order.latitude,
        longitude: order.longitude,
        estimatedArrival: update.estimatedArrival,
        distanceFromPrevious: segments[index]?.distance,
        durationFromPrevious: segments[index]?.duration,
      });
    });
  }

  // Sort waypoints by delivery sequence
  allWaypoints.sort((a, b) => a.sequence - b.sequence);

  // 10. Combine all area route geometries into a GeoJSON FeatureCollection
  const areaGeometries: Array<{ type: string; properties: Record<string, unknown>; geometry: unknown }> = [];
  for (const [areaName, areaRoute] of areaRoutes.entries()) {
    if (areaRoute.routeGeometry && areaRoute.routeGeometry !== "{}") {
      try {
        const parsed = JSON.parse(areaRoute.routeGeometry);
        if (parsed.type === "LineString" && parsed.coordinates?.length > 0) {
          areaGeometries.push({ type: "Feature", properties: { area: areaName }, geometry: parsed });
        }
      } catch { /* skip invalid geometry */ }
    }
  }
  const routeGeometry = areaGeometries.length > 0
    ? JSON.stringify({ type: "FeatureCollection", features: areaGeometries })
    : "{}";

  // 11. Store route optimization in database
  const routeOptimization = await prisma.routeOptimization.create({
    data: {
      deliveryDate: startOfDay,
      areaId: null, // Multi-area route
      orderCount: orders.length,
      totalDistance: totalDistance / 1000, // Convert meters to km
      totalDuration,
      routeGeometry,
      waypoints: allWaypoints.map((wp) => ({
        orderId: wp.orderId,
        orderNumber: wp.orderNumber,
        sequence: wp.sequence,
        address: wp.address,
        latitude: wp.latitude,
        longitude: wp.longitude,
        estimatedArrival: wp.estimatedArrival,
        distanceFromPrevious: wp.distanceFromPrevious,
        durationFromPrevious: wp.durationFromPrevious,
      })),
      optimizedAt: new Date(),
      optimizedBy: userId,
      mapboxRouteData: JSON.parse(JSON.stringify({
        areaRoutes: Array.from(areaRoutes.entries()).map(([area, route]) => ({
          area,
          totalDistance: route.totalDistance,
          totalDuration: route.totalDuration,
          orderCount: route.coordinateIds.length,
        })),
      })),
    },
  });

  // 12. Update orders with sequences — preserve in-progress packing state
  // (packedItems, lastPackedBy/At, pausedAt) and existing delivery fields
  // (driverId, etc.) so a re-optimization run does not destroy work in flight.
  await Promise.all(
    orderUpdates.map((update) => {
      const existingOrder = orders.find((o) => o.id === update.orderId);
      const existingPacking = existingOrder?.packing ?? null;
      const existingDelivery = existingOrder?.delivery ?? null;

      return prisma.order.update({
        where: { id: update.orderId },
        data: {
          packing: {
            ...(existingPacking ?? {}),
            areaPackingSequence: update.areaPackingSequence,
            packedItems: existingPacking?.packedItems ?? [],
          },
          delivery: {
            ...(existingDelivery ?? {}),
            deliverySequence: update.deliverySequence,
            areaDeliverySequence: update.areaDeliverySequence,
            routeId: routeOptimization.id,
            estimatedArrival: update.estimatedArrival,
          },
        },
      });
    })
  );

  // 13. Send route optimized email notification
  const adminEmail = process.env.RESEND_ADMIN_EMAIL || 'admin@johofoods.com';
  await sendRouteOptimizedEmail({
    warehouseManagerEmail: adminEmail,
    warehouseManagerName: 'Warehouse Manager',
    deliveryDate,
    orderCount: orders.length,
    totalDistance: totalDistance / 1000, // Convert meters to km
    estimatedDuration: totalDuration / 60, // Convert seconds to minutes
  }).catch((error) => {
    console.error('Failed to send route optimized email:', error);
  });

  return {
    routeOptimizationId: routeOptimization.id,
    orderUpdates,
    routeSummary: {
      totalOrders: orders.length,
      totalDistance,
      totalDuration,
      areaBreakdown,
    },
  };
}

/**
 * Get existing route optimization for a delivery date.
 * Returns the multi-area packing route record (areaId: null) — never a
 * per-area lock record (those have a non-null areaId).
 */
export async function getRouteOptimization(deliveryDate: Date) {
  const { start: startOfDay, end: endOfDay } = getUTCDayRangeForMelbourneDay(deliveryDate);

  return prisma.routeOptimization.findFirst({
    where: {
      deliveryDate: {
        gte: startOfDay,
        lt: endOfDay,
      },
      areaId: null,
    },
    orderBy: {
      optimizedAt: "desc",
    },
  });
}

/**
 * Resolve the set of area names that are manually locked for a delivery date.
 * Used by the optimizer to avoid touching admin-set packing sequences.
 */
async function getLockedAreaNamesForDate(
  startOfDay: Date,
  endOfDay: Date
): Promise<Set<string>> {
  const lockedRecords = await prisma.routeOptimization.findMany({
    where: {
      deliveryDate: { gte: startOfDay, lt: endOfDay },
      routeType: 'packing',
      manuallyLocked: true,
      areaId: { not: null },
    },
    select: { areaId: true },
  });

  if (lockedRecords.length === 0) return new Set();

  const areas = await prisma.area.findMany({
    where: {
      id: { in: lockedRecords.map((r) => r.areaId!).filter(Boolean) },
    },
    select: { name: true },
  });

  return new Set(areas.map((a) => a.name));
}

/**
 * Check if route needs re-optimization
 * (e.g., if orders were added/removed after last optimization)
 */
export async function checkIfRouteNeedsReoptimization(
  deliveryDate: Date
): Promise<boolean> {
  const route = await getRouteOptimization(deliveryDate);
  if (!route) return true;

  // Honor explicit flag (set when an admin resets a manual lock so the
  // optimizer reconsiders the area on the next refetch).
  if (route.needsReoptimization) return true;

  const { start: startOfDay, end: endOfDay } = getUTCDayRangeForMelbourneDay(deliveryDate);

  const currentOrderCount = await prisma.order.count({
    where: {
      requestedDeliveryDate: {
        gte: startOfDay,
        lt: endOfDay,
      },
      status: {
        in: ["confirmed", "packing", "ready_for_delivery"],
      },
    },
  });

  // If order count changed, re-optimization needed
  return currentOrderCount !== route.orderCount;
}


/**
 * Assigns a preliminary packing sequence to a newly confirmed order.
 * This gives the order an immediate sequence number (max + 1) without running
 * full route optimization. When the packer opens the packing session, full
 * optimization will recalculate optimal sequences based on geography.
 *
 * Returns 0 (and assigns no sequence) when the order's area is manually
 * locked — admin's manual ordering takes precedence, so the new order is
 * left unsequenced and surfaces in the UI without a number for admin to
 * slot in via the drag-and-drop reorder UI.
 */
export async function assignPreliminaryPackingSequence(
  deliveryDate: Date,
  orderId: string,
  areaName: string | null
): Promise<number> {
  const { start: startOfDay, end: endOfDay } = getUTCDayRangeForMelbourneDay(deliveryDate);

  // If this order belongs to a manually-locked area, do NOT auto-assign a
  // sequence. Doing so would silently violate the admin's manual ordering.
  if (areaName) {
    const lockedAreaNames = await getLockedAreaNamesForDate(startOfDay, endOfDay);
    if (lockedAreaNames.has(areaName)) {
      return 0;
    }
  }

  // Build where clause - filter by area if provided for per-area sequencing
  const whereClause: any = {
    requestedDeliveryDate: {
      gte: startOfDay,
      lt: endOfDay,
    },
    status: {
      in: ["confirmed", "packing", "ready_for_delivery"],
    },
    NOT: {
      id: orderId, // Exclude the current order
    },
  };

  // Add area filter to ensure each area has its own independent sequence
  if (areaName) {
    whereClause.deliveryAddress = {
      is: {
        areaName: areaName,
      },
    };
  }

  // Get max existing packing sequence for this delivery date and area
  const ordersWithSequence = await prisma.order.findMany({
    where: whereClause,
    select: {
      packing: true,
    },
  });

  const maxSequence = ordersWithSequence.reduce((max, order) => {
    const seq = order.packing?.areaPackingSequence ?? 0;
    return seq > max ? seq : max;
  }, 0);

  const newSequence = maxSequence + 1;

  // Preserve any existing packing state on the target order (defensive — for a
  // freshly-confirmed order this is empty, but the function is also called
  // from paths where the order may already have progress).
  const targetOrder = await prisma.order.findUnique({
    where: { id: orderId },
    select: { packing: true },
  });

  await prisma.order.update({
    where: { id: orderId },
    data: {
      packing: {
        ...(targetOrder?.packing ?? {}),
        areaPackingSequence: newSequence,
        packedItems: targetOrder?.packing?.packedItems ?? [],
      },
    },
  });

  return newSequence;
}

// ============================================================================
// DELIVERY ROUTE FUNCTIONS (for ready_for_delivery orders only)
// ============================================================================

interface DeliveryRouteResult {
  routeOptimizationId: string | null;
  orderUpdates: Array<{
    orderId: string;
    orderNumber: string;
    deliverySequence: number;
    areaDeliverySequence: number;
    estimatedArrival: Date;
    areaName: string;
  }>;
  routeSummary: {
    totalOrders: number;
    totalDistance: number;
    totalDuration: number;
    areaBreakdown: Array<{
      areaName: string;
      orderCount: number;
      distance: number;
      duration: number;
    }>;
  };
}

/**
 * Optimize delivery route for ONLY ready_for_delivery orders.
 * This is used to recalculate routes when viewing the delivery page,
 * ensuring only actually ready orders are included.
 *
 * @param deliveryDate - Date to optimize deliveries for
 * @param userId - User performing the optimization
 * @returns Route optimization result (or empty result if no ready orders)
 */
export async function optimizeDeliveryOnlyRoute(
  deliveryDate: Date,
  userId: string
): Promise<DeliveryRouteResult> {
  // 1. Fetch company delivery settings (warehouse location)
  const company = await prisma.company.findFirst({
    select: {
      deliverySettings: true,
    },
  });

  if (!company?.deliverySettings) {
    throw new Error(
      "Delivery settings not configured. Please configure warehouse location in settings."
    );
  }

  const { warehouseAddress } = company.deliverySettings;
  const mapboxAccessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  if (!mapboxAccessToken) {
    throw new Error(
      "Mapbox access token not configured in environment variables. Please set NEXT_PUBLIC_MAPBOX_TOKEN."
    );
  }

  if (!warehouseAddress?.latitude || !warehouseAddress?.longitude) {
    throw new Error(
      "Warehouse location not configured. Please add coordinates in delivery settings."
    );
  }

  // 2. Fetch ONLY ready_for_delivery orders
  const { start: startOfDay, end: endOfDay } = getUTCDayRangeForMelbourneDay(deliveryDate);

  const orders = await prisma.order.findMany({
    where: {
      requestedDeliveryDate: {
        gte: startOfDay,
        lt: endOfDay,
      },
      status: "ready_for_delivery", // ONLY ready orders
    },
    select: {
      id: true,
      orderNumber: true,
      deliveryAddress: true,
      delivery: true, // Include existing delivery data to preserve driver assignments
    },
  });

  // Return empty result if no ready orders (don't throw error)
  if (orders.length === 0) {
    return {
      routeOptimizationId: null,
      orderUpdates: [],
      routeSummary: {
        totalOrders: 0,
        totalDistance: 0,
        totalDuration: 0,
        areaBreakdown: [],
      },
    };
  }

  // 3. Validate all orders have coordinates
  const ordersWithoutCoordinates = orders.filter(
    (order) =>
      !order.deliveryAddress.latitude || !order.deliveryAddress.longitude
  );

  if (ordersWithoutCoordinates.length > 0) {
    const orderNumbers = ordersWithoutCoordinates
      .map((o) => o.orderNumber)
      .join(", ");
    throw new Error(
      `Orders missing coordinates: ${orderNumbers}. Please add address coordinates before optimizing.`
    );
  }

  // 4. Group orders by area
  const ordersByArea = new Map<
    string,
    Array<{
      id: string;
      orderNumber: string;
      longitude: number;
      latitude: number;
    }>
  >();

  for (const order of orders) {
    // Use 'unassigned' as fallback for orders without area
    const areaName = order.deliveryAddress.areaName ?? 'unassigned';
    if (!ordersByArea.has(areaName)) {
      ordersByArea.set(areaName, []);
    }
    ordersByArea.get(areaName)!.push({
      id: order.id,
      orderNumber: order.orderNumber,
      longitude: order.deliveryAddress.longitude!,
      latitude: order.deliveryAddress.latitude!,
    });
  }

  // 5. Optimize routes by area using Mapbox
  const warehouseCoord = {
    longitude: warehouseAddress.longitude,
    latitude: warehouseAddress.latitude,
  };

  const areaRoutes = await optimizeRoutesByArea(
    ordersByArea,
    warehouseCoord,
    mapboxAccessToken
  );

  // 6. Calculate delivery sequences (contiguous 1, 2, 3...)
  const orderUpdates: DeliveryRouteResult["orderUpdates"] = [];
  let globalDeliverySequence = 1;
  const areaBreakdown: DeliveryRouteResult["routeSummary"]["areaBreakdown"] = [];

  // Dynamic area discovery: preferred order first, then any additional areas
  const preferredAreaOrder = ["north", "east", "south", "west"];
  const allAreas = Array.from(areaRoutes.keys());
  const areaOrder = [
    ...preferredAreaOrder.filter((a) => allAreas.includes(a)),
    ...allAreas.filter((a) => !preferredAreaOrder.includes(a)),
  ];

  for (const areaName of areaOrder) {
    const areaRoute = areaRoutes.get(areaName);
    if (!areaRoute) continue;

    const areaOrders = ordersByArea.get(areaName)!;
    const { coordinateIds, totalDistance, totalDuration, segments } = areaRoute;

    const routeStartTime = new Date(deliveryDate);
    routeStartTime.setHours(9, 0, 0, 0);
    const arrivalTimes = calculateArrivalTimes(routeStartTime, segments, 300);

    coordinateIds.forEach((orderId, index) => {
      const order = areaOrders.find((o) => o.id === orderId)!;
      const deliverySequence = globalDeliverySequence++;
      const areaDeliverySequence = index + 1; // Forward within area (1, 2, 3...)

      orderUpdates.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        deliverySequence,
        areaDeliverySequence,
        estimatedArrival: arrivalTimes[index],
        areaName,
      });
    });

    areaBreakdown.push({
      areaName,
      orderCount: coordinateIds.length,
      distance: totalDistance,
      duration: totalDuration,
    });
  }

  // 7. Calculate total route stats
  const totalDistance = areaBreakdown.reduce(
    (sum, area) => sum + area.distance,
    0
  );
  const totalDuration = areaBreakdown.reduce(
    (sum, area) => sum + area.duration,
    0
  );

  // 8. Build waypoints
  const allWaypoints: Array<{
    orderId: string;
    orderNumber: string;
    sequence: number;
    address: string;
    latitude: number;
    longitude: number;
    estimatedArrival: Date;
    distanceFromPrevious?: number;
    durationFromPrevious?: number;
  }> = [];

  for (const [areaName, areaRoute] of areaRoutes.entries()) {
    const areaOrders = ordersByArea.get(areaName)!;
    const { coordinateIds, segments } = areaRoute;

    coordinateIds.forEach((orderId, index) => {
      const order = areaOrders.find((o) => o.id === orderId)!;
      const fullOrder = orders.find((o) => o.id === orderId)!;
      const update = orderUpdates.find((u) => u.orderId === orderId)!;

      allWaypoints.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sequence: update.deliverySequence,
        address: `${fullOrder.deliveryAddress.street}, ${fullOrder.deliveryAddress.suburb}`,
        latitude: order.latitude,
        longitude: order.longitude,
        estimatedArrival: update.estimatedArrival,
        distanceFromPrevious: segments[index]?.distance,
        durationFromPrevious: segments[index]?.duration,
      });
    });
  }

  allWaypoints.sort((a, b) => a.sequence - b.sequence);

  // 9. Combine all area route geometries into a GeoJSON FeatureCollection
  const areaGeometries: Array<{ type: string; properties: Record<string, unknown>; geometry: unknown }> = [];
  for (const [areaName, areaRoute] of areaRoutes.entries()) {
    if (areaRoute.routeGeometry && areaRoute.routeGeometry !== "{}") {
      try {
        const parsed = JSON.parse(areaRoute.routeGeometry);
        if (parsed.type === "LineString" && parsed.coordinates?.length > 0) {
          areaGeometries.push({ type: "Feature", properties: { area: areaName }, geometry: parsed });
        }
      } catch { /* skip invalid geometry */ }
    }
  }
  const routeGeometry = areaGeometries.length > 0
    ? JSON.stringify({ type: "FeatureCollection", features: areaGeometries })
    : "{}";

  // 10. Store as delivery-type route
  const routeOptimization = await prisma.routeOptimization.create({
    data: {
      deliveryDate: startOfDay,
      routeType: "delivery", // Mark as delivery route
      driverId: null, // Global delivery route (not per-driver)
      areaId: null,
      orderCount: orders.length,
      totalDistance: totalDistance / 1000,
      totalDuration,
      routeGeometry,
      waypoints: allWaypoints.map((wp) => ({
        orderId: wp.orderId,
        orderNumber: wp.orderNumber,
        sequence: wp.sequence,
        address: wp.address,
        latitude: wp.latitude,
        longitude: wp.longitude,
        estimatedArrival: wp.estimatedArrival,
        distanceFromPrevious: wp.distanceFromPrevious,
        durationFromPrevious: wp.durationFromPrevious,
      })),
      optimizedAt: new Date(),
      optimizedBy: userId,
      mapboxRouteData: JSON.parse(JSON.stringify({
        areaRoutes: Array.from(areaRoutes.entries()).map(([area, route]) => ({
          area,
          totalDistance: route.totalDistance,
          totalDuration: route.totalDuration,
          orderCount: route.coordinateIds.length,
        })),
      })),
    },
  });

  // 11. Update orders with NEW delivery sequences (preserve existing delivery data)
  await Promise.all(
    orderUpdates.map((update) => {
      const existingOrder = orders.find((o) => o.id === update.orderId);
      const existingDelivery = existingOrder?.delivery || {};

      return prisma.order.update({
        where: { id: update.orderId },
        data: {
          delivery: {
            ...existingDelivery, // Preserve driverId, driverName, etc.
            deliverySequence: update.deliverySequence,
            areaDeliverySequence: update.areaDeliverySequence,
            routeId: routeOptimization.id,
            estimatedArrival: update.estimatedArrival,
          },
        },
      });
    })
  );

  // NO email notification for delivery route (only for packing route)

  return {
    routeOptimizationId: routeOptimization.id,
    orderUpdates,
    routeSummary: {
      totalOrders: orders.length,
      totalDistance,
      totalDuration,
      areaBreakdown,
    },
  };
}

// Per-driver sequences removed - now using per-area sequences only

/**
 * Get existing delivery-type route optimization for a date
 *
 * @param deliveryDate - The delivery date
 * @param driverId - Optional: get route for specific driver
 */
export async function getDeliveryRouteOptimization(
  deliveryDate: Date,
  driverId?: string | null
) {
  const { start: startOfDay, end: endOfDay } = getUTCDayRangeForMelbourneDay(deliveryDate);

  const whereClause: {
    deliveryDate: { gte: Date; lt: Date };
    routeType: "delivery";
    driverId?: string | null;
  } = {
    deliveryDate: {
      gte: startOfDay,
      lt: endOfDay,
    },
    routeType: "delivery",
  };

  // If driverId is explicitly provided (including null for global routes)
  if (driverId !== undefined) {
    whereClause.driverId = driverId;
  }

  return prisma.routeOptimization.findFirst({
    where: whereClause,
    orderBy: {
      optimizedAt: "desc",
    },
  });
}

/**
 * Check if delivery route needs recalculation.
 * Returns true if:
 * - No delivery route exists for the date
 * - Ready order count changed since last calculation
 * - Driver assignments changed (tracked via order count mismatch)
 *
 * @param deliveryDate - The delivery date to check
 */
export async function checkIfDeliveryRouteNeedsRecalculation(
  deliveryDate: Date
): Promise<boolean> {
  const deliveryRoute = await getDeliveryRouteOptimization(deliveryDate, null);

  const { start: startOfDay, end: endOfDay } = getUTCDayRangeForMelbourneDay(deliveryDate);

  // Count current ready_for_delivery orders
  const currentReadyCount = await prisma.order.count({
    where: {
      requestedDeliveryDate: {
        gte: startOfDay,
        lt: endOfDay,
      },
      status: "ready_for_delivery",
    },
  });

  // If no delivery route exists, need to calculate
  if (!deliveryRoute) {
    return currentReadyCount > 0; // Only need recalc if there are ready orders
  }

  // If order count changed, need to recalculate
  if (currentReadyCount !== deliveryRoute.orderCount) {
    return true;
  }

  // Also check if the set of order IDs changed (more robust)
  const currentOrderIds = await prisma.order.findMany({
    where: {
      requestedDeliveryDate: {
        gte: startOfDay,
        lte: endOfDay,
      },
      status: "ready_for_delivery",
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  const waypointOrderIds = deliveryRoute.waypoints
    .map((wp) => wp.orderId)
    .sort();
  const currentIds = currentOrderIds.map((o) => o.id).sort();

  // Check if same set of orders
  if (JSON.stringify(waypointOrderIds) !== JSON.stringify(currentIds)) {
    return true;
  }

  return false;
}
