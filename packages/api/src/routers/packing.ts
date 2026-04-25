import { z } from "zod";
import { router, requirePermission } from "../trpc";
import { prisma, Prisma } from "@joho-erp/database";
import { TRPCError } from "@trpc/server";
import { clerkClient } from "@clerk/nextjs/server";
import { getTodayAsUTCMidnight, toUTCMidnightForMelbourneDay, formatMelbourneDateForDisplay, getUTCDayRangeForMelbourneDay } from "@joho-erp/shared";

/**
 * Get user display name and email for audit trail
 */
async function getUserDetails(userId: string | null): Promise<{
  changedByName: string | null;
  changedByEmail: string | null;
}> {
  if (!userId) {
    return { changedByName: null, changedByEmail: null };
  }
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const changedByName = user.firstName && user.lastName
      ? `${user.firstName} ${user.lastName}`
      : user.firstName || user.lastName || null;
    const changedByEmail = user.emailAddresses[0]?.emailAddress || null;
    return { changedByName, changedByEmail };
  } catch (error) {
    console.error('Failed to fetch user details:', error);
    return { changedByName: null, changedByEmail: null };
  }
}
import type { PackingSessionSummary, PackingOrderCard, ProductSummaryItem } from "../types/packing";
import {
  optimizeDeliveryRoute,
  getRouteOptimization,
  checkIfRouteNeedsReoptimization,
} from "../services/route-optimizer";
import {
  startPackingSession,
  updateSessionActivityByPacker,
} from "../services/packing-session";
import { sendOrderReadyForDeliveryEmail } from "../services/email";
import { createMoney, multiplyMoney, toCents, calculateOrderTotals, validateStatusTransition } from "@joho-erp/shared";
import type { OrderStatus, UserRole } from "@joho-erp/shared";
import { createHash } from "crypto";
import {
  logPackingItemUpdate,
  logPackingNotesUpdate,
  logOrderReadyForDelivery,
  logPackingOrderPauseResume,
  logPackingOrderReset,
  logPackingItemQuantityUpdate,
  logPackingTotalChange,
  logOrdersMerged,
} from "../services/audit";
import { reversePackingAdjustments } from "../services/stock-restoration";

/**
 * Merge context — minimal subset of tRPC ctx required by the auto-merge helper.
 * (Avoids importing the full Context type which carries Next.js req/res.)
 */
type MergeCtx = {
  userId: string | null;
  userRole?: string | null;
  userName?: string | null;
};

/**
 * Hash the address fields that determine "same delivery location" for auto-merge.
 * Uses sha1 over a delimiter-joined string of the fields the FSD treats as
 * location-defining. Two addresses with identical street/suburb/state/postcode/
 * country/areaId hash to the same value regardless of optional fields like
 * latitude/longitude or deliveryInstructions (those vary between user sessions
 * and shouldn't break merge eligibility).
 */
function hashDeliveryAddress(addr: {
  street: string;
  suburb: string;
  state: string;
  postcode: string;
  country: string;
  areaId?: string | null;
}): string {
  const parts = [
    addr.street.trim().toLowerCase(),
    addr.suburb.trim().toLowerCase(),
    addr.state.trim().toLowerCase(),
    addr.postcode.trim().toLowerCase(),
    addr.country.trim().toLowerCase(),
    addr.areaId ?? '',
  ];
  return createHash('sha1').update(parts.join('|')).digest('hex');
}

type MergeResult = {
  mergedGroups: Array<{
    primaryId: string;
    primaryOrderNumber: string;
    absorbedOrderIds: string[];
    absorbedOrderNumbers: string[];
  }>;
};

/**
 * Auto-merge eligible orders for a given delivery date (and optional area scope).
 *
 * An "eligible group" is two or more orders that share:
 *   - customerId
 *   - Melbourne-day-bucketed requestedDeliveryDate
 *   - Hashed embedded DeliveryAddress (street|suburb|state|postcode|country|areaId)
 *   - status in ['confirmed', 'packing']
 *   - mergedIntoOrderId == null
 *
 * For each group with size > 1:
 *   - Promote the order with the lowest orderNumber as primary (or the existing
 *     primary if one already has mergedFromOrderIds populated).
 *   - Skip the group if the primary is fully packed (re-merge guard).
 *   - Sum line items where (productId, unitPrice) matches; otherwise keep as
 *     separate lines. Recalculate subtotal/taxAmount/totalAmount.
 *   - Concatenate internalNotes and packing.notes from absorbed orders, prefixed
 *     with `#<orderNumber>: `.
 *   - Mark absorbed orders as status='merged' with mergedIntoOrderId pointing
 *     at the primary, mergedAt, mergedBy.
 *
 * Optimistic-lock pattern (mirrors addPackingNotes at packing.ts:1397) — every
 * order update checks `version` and increments it, throwing CONFLICT if a
 * concurrent mutation raced us. The caller can retry on the next page load.
 *
 * Side effect: when any merge happens, flips `RouteOptimization.needsReoptimization`
 * for the date so the existing auto-optimizer at services/route-optimizer.ts
 * re-runs on the next session load (it respects per-area `manuallyLocked`).
 *
 * NOTE: This helper does not throw — group-level CONFLICT errors are logged
 * and swallowed so that the calling resolver (`getOptimizedSession`) is never
 * blocked by transient merge failures. Failed groups simply re-attempt on the
 * next refresh.
 */
async function mergeEligibleOrdersInternal(
  deliveryDate: Date,
  areaId: string | undefined,
  ctx: MergeCtx
): Promise<MergeResult> {
  const { start, end } = getUTCDayRangeForMelbourneDay(deliveryDate);

  const where: Prisma.OrderWhereInput = {
    requestedDeliveryDate: { gte: start, lt: end },
    status: { in: ['confirmed', 'packing'] },
    mergedIntoOrderId: null,
  };
  if (areaId) {
    where.deliveryAddress = { is: { areaId } };
  }

  const candidates = await prisma.order.findMany({
    where,
    select: {
      id: true,
      orderNumber: true,
      customerId: true,
      deliveryAddress: true,
      version: true,
      items: true,
      packing: true,
      internalNotes: true,
      mergedFromOrderIds: true,
    },
  });

  // Group by customerId + addressHash
  const groups = new Map<string, typeof candidates>();
  for (const order of candidates) {
    const addrHash = hashDeliveryAddress(order.deliveryAddress);
    const key = `${order.customerId}|${addrHash}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(order);
    } else {
      groups.set(key, [order]);
    }
  }

  const mergedGroups: MergeResult['mergedGroups'] = [];

  for (const [, group] of groups) {
    if (group.length < 2) continue;

    // Sort by orderNumber ASC
    const sorted = [...group].sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));

    // Prefer existing primary (one whose mergedFromOrderIds is non-empty); else lowest orderNumber.
    let primaryIdx = 0;
    for (let i = 0; i < sorted.length; i++) {
      const ids = sorted[i].mergedFromOrderIds ?? [];
      if (ids.length > 0) {
        primaryIdx = i;
        break;
      }
    }
    const primaryCandidate = sorted[primaryIdx];
    const absorbedCandidates = sorted.filter((_, i) => i !== primaryIdx);

    // Re-merge guard: skip group if primary is fully packed.
    const packedCount = primaryCandidate.packing?.packedItems?.length ?? 0;
    const totalCount = primaryCandidate.items.length;
    if (totalCount > 0 && packedCount >= totalCount) continue;

    try {
      const txResult = await prisma.$transaction(async (tx) => {
        // Re-fetch primary with version inside the tx.
        const primary = await tx.order.findUnique({
          where: { id: primaryCandidate.id },
          select: {
            id: true,
            orderNumber: true,
            version: true,
            items: true,
            packing: true,
            internalNotes: true,
            mergedFromOrderIds: true,
            mergedIntoOrderId: true,
          },
        });
        if (!primary || primary.mergedIntoOrderId !== null) return null;

        // Build merged items map keyed by (productId|unitPrice).
        const itemKey = (it: { productId: string; unitPrice: number }) =>
          `${it.productId}|${it.unitPrice}`;
        const itemMap = new Map<string, (typeof primary.items)[number]>();
        for (const it of primary.items) {
          itemMap.set(itemKey(it), { ...it });
        }

        // Build merged note buffers (primary content first, then absorbed prefixed by #<orderNumber>:).
        const internalNoteParts: string[] = [];
        const primaryInternal = (primary.internalNotes ?? '').trim();
        if (primaryInternal) internalNoteParts.push(primaryInternal);

        const packingNoteParts: string[] = [];
        const primaryPackingNotes = (primary.packing?.notes ?? '').trim();
        if (primaryPackingNotes) packingNoteParts.push(primaryPackingNotes);

        const absorbedIds: string[] = [];
        const absorbedOrderNumbers: string[] = [];

        for (const a of absorbedCandidates) {
          const fresh = await tx.order.findUnique({
            where: { id: a.id },
            select: {
              id: true,
              orderNumber: true,
              version: true,
              items: true,
              packing: true,
              internalNotes: true,
              mergedIntoOrderId: true,
            },
          });
          if (!fresh || fresh.mergedIntoOrderId !== null) continue;

          for (const it of fresh.items) {
            const k = itemKey(it);
            const existing = itemMap.get(k);
            if (existing) {
              const newQty = existing.quantity + it.quantity;
              const itemPriceMoney = createMoney(existing.unitPrice);
              const newSubtotal = toCents(multiplyMoney(itemPriceMoney, newQty));
              itemMap.set(k, { ...existing, quantity: newQty, subtotal: newSubtotal });
            } else {
              itemMap.set(k, { ...it });
            }
          }

          const aInternal = (fresh.internalNotes ?? '').trim();
          if (aInternal) internalNoteParts.push(`#${fresh.orderNumber}: ${aInternal}`);
          const aPacking = (fresh.packing?.notes ?? '').trim();
          if (aPacking) packingNoteParts.push(`#${fresh.orderNumber}: ${aPacking}`);

          // Mark absorbed with optimistic lock.
          const absorbResult = await tx.order.updateMany({
            where: { id: fresh.id, version: fresh.version, mergedIntoOrderId: null },
            data: {
              status: 'merged',
              mergedIntoOrderId: primary.id,
              mergedAt: new Date(),
              mergedBy: ctx.userId ?? 'system',
              version: { increment: 1 },
            },
          });
          if (absorbResult.count === 0) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: `Concurrent modification on order ${fresh.orderNumber} during merge`,
            });
          }
          absorbedIds.push(fresh.id);
          absorbedOrderNumbers.push(fresh.orderNumber);
        }

        if (absorbedIds.length === 0) return null;

        const mergedItems = Array.from(itemMap.values());

        // Recalculate order totals (subtotal/tax/total) so downstream consumers
        // — invoicing, deliveries — see consistent monetary state. Per-item
        // applyGst/gstRate are preserved from the original lines.
        const totals = calculateOrderTotals(
          mergedItems.map((it) => ({
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            applyGst: it.applyGst ?? false,
            gstRate: it.gstRate ?? null,
          }))
        );

        const newInternalNotes = internalNoteParts.join('\n');
        const newPackingNotes = packingNoteParts.join('\n');

        const updateResult = await tx.order.updateMany({
          where: { id: primary.id, version: primary.version },
          data: {
            items: mergedItems,
            subtotal: totals.subtotal,
            taxAmount: totals.taxAmount,
            totalAmount: totals.totalAmount,
            internalNotes: newInternalNotes.length > 0 ? newInternalNotes : null,
            packing: {
              ...(primary.packing ?? { packedItems: [] }),
              packedItems: primary.packing?.packedItems ?? [],
              notes: newPackingNotes.length > 0 ? newPackingNotes : null,
              // pausedAt, lastPackedAt, lastPackedBy intentionally preserved.
            },
            mergedFromOrderIds: [...(primary.mergedFromOrderIds ?? []), ...absorbedIds],
            version: { increment: 1 },
          },
        });

        if (updateResult.count === 0) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Concurrent modification on primary order ${primary.orderNumber} during merge`,
          });
        }

        return {
          primaryId: primary.id,
          primaryOrderNumber: primary.orderNumber,
          absorbedOrderIds: absorbedIds,
          absorbedOrderNumbers,
        };
      });

      if (txResult) mergedGroups.push(txResult);
    } catch (err) {
      // CONFLICT or transient failure — skip group, will re-attempt on next refresh.
      console.error('Merge group failed (will retry on next load):', err);
    }
  }

  if (mergedGroups.length > 0) {
    // Flip needsReoptimization for the date. Multiple RouteOptimization rows can
    // exist (one per area, plus a multi-area row) — flag them all so the
    // optimizer re-runs (it still respects per-area manuallyLocked).
    try {
      await prisma.routeOptimization.updateMany({
        where: { deliveryDate: { gte: start, lt: end } },
        data: { needsReoptimization: true },
      });
    } catch (err) {
      console.error('Failed to flag route for reoptimization after merge:', err);
    }

    // Audit log per merged group (best-effort — never block).
    for (const g of mergedGroups) {
      logOrdersMerged(
        ctx.userId ?? 'system',
        undefined,
        ctx.userRole ?? undefined,
        ctx.userName ?? undefined,
        g.primaryId,
        {
          primaryOrderNumber: g.primaryOrderNumber,
          absorbedOrderIds: g.absorbedOrderIds,
          absorbedOrderNumbers: g.absorbedOrderNumbers,
        }
      ).catch((err) => console.error('Audit log failed for orders merged:', err));
    }
  }

  return { mergedGroups };
}

export const packingRouter = router({
  /**
   * Get packing session for a specific delivery date
   * Returns all orders that need packing and aggregated product summary
   * Also starts/resumes a packing session for timeout tracking
   */
  getSession: requirePermission('packing:view')
    .input(
      z.object({
        deliveryDate: z.string().datetime(),
      })
    )
    .query(async ({ input, ctx }): Promise<PackingSessionSummary> => {
      const deliveryDate = new Date(input.deliveryDate);

      // Get all orders for the delivery date with status 'confirmed' or 'packing'
      // Use Melbourne-aware day boundaries to avoid DST/UTC drift.
      const { start: startOfDay, end: endOfDay } = getUTCDayRangeForMelbourneDay(deliveryDate);

      const orders = await prisma.order.findMany({
        where: {
          requestedDeliveryDate: {
            gte: startOfDay,
            lt: endOfDay,
          },
          status: {
            in: ['confirmed', 'packing'],
          },
        },
        include: {
          customer: {
            select: {
              businessName: true,
            },
          },
        },
        orderBy: {
          orderNumber: 'asc',
        },
      });

      // Build product summary by aggregating quantities across all orders
      const productMap = new Map<string, ProductSummaryItem>();

      for (const order of orders) {
        for (const item of order.items) {
          // Defensive: Skip items without productId
          if (!item.productId) {
            console.warn(`Order ${order.orderNumber} has item without productId:`, {
              sku: item.sku,
              productName: item.productName,
            });
            continue;
          }

          const productId = item.productId;

          if (productMap.has(productId)) {
            const existing = productMap.get(productId)!;
            existing.totalQuantity += item.quantity;
            existing.orders.push({
              orderNumber: order.orderNumber,
              quantity: item.quantity,
              status: order.status as 'confirmed' | 'packing' | 'ready_for_delivery',
            });
          } else {
            productMap.set(productId, {
              productId: item.productId,
              sku: item.sku,
              productName: item.productName,
              category: null, // Will be populated after fetching from products
              unit: item.unit,
              totalQuantity: item.quantity,
              orders: [
                {
                  orderNumber: order.orderNumber,
                  quantity: item.quantity,
                  status: order.status as 'confirmed' | 'packing' | 'ready_for_delivery',
                },
              ],
            });
          }
        }
      }

      // Fetch categories for all products in the productMap
      const productIds = Array.from(productMap.keys());
      const productsWithCategories = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, category: true },
      });

      // Create a map of productId -> category
      const categoryMap = new Map<string, string | null>();
      for (const product of productsWithCategories) {
        categoryMap.set(product.id, product.category);
      }

      // Add category to each product summary item
      for (const [productId, item] of productMap.entries()) {
        item.category = categoryMap.get(productId) as ProductSummaryItem['category'] ?? null;
      }

      const productSummary = Array.from(productMap.values()).sort((a, b) =>
        a.sku.localeCompare(b.sku)
      );

      // Start or resume packing session for timeout tracking
      if (ctx.userId && orders.length > 0) {
        const orderIds = orders.map((order) => order.id);
        await startPackingSession(ctx.userId, deliveryDate, orderIds);
      }

      // Get area info for orders
      const areaIds = [...new Set(orders.map((o) => o.deliveryAddress.areaId).filter(Boolean))];
      const areasData = areaIds.length > 0
        ? await prisma.area.findMany({ where: { id: { in: areaIds as string[] } } })
        : [];
      const areaMap = new Map(areasData.map((a) => [a.id, a]));

      return {
        deliveryDate,
        orders: orders.map((order) => {
          const areaId = order.deliveryAddress.areaId;
          const areaInfo = areaId ? areaMap.get(areaId) : null;
          return {
            orderId: order.id,
            orderNumber: order.orderNumber,
            customerName: order.customer?.businessName ?? 'Unknown Customer',
            area: areaInfo
              ? {
                  id: areaInfo.id,
                  name: areaInfo.name,
                  displayName: areaInfo.displayName,
                  colorVariant: areaInfo.colorVariant,
                }
              : null,
          };
        }),
        productSummary,
      };
    }),

  /**
   * Get detailed order information for packing
   * Includes current stock levels for each product
   */
  getOrderDetails: requirePermission('packing:view')
    .input(
      z.object({
        orderId: z.string(),
      })
    )
    .query(async ({ input }): Promise<PackingOrderCard> => {
      const order = await prisma.order.findUnique({
        where: {
          id: input.orderId,
        },
        include: {
          customer: {
            select: {
              businessName: true,
            },
          },
        },
      });

      if (!order) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Order not found',
        });
      }

      // Get packed items from database
      const packedSkus = new Set(order.packing?.packedItems ?? []);

      // Fetch stock levels and area info in parallel (both only depend on the order)
      const productIds = order.items.map((item) => item.productId).filter(Boolean);
      const areaId = order.deliveryAddress.areaId;

      const [products, areaInfo] = await Promise.all([
        prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, currentStock: true, lowStockThreshold: true },
        }),
        areaId ? prisma.area.findUnique({ where: { id: areaId } }) : null,
      ]);

      // Create a map for quick lookup
      const productStockMap = new Map(
        products.map((p) => [p.id, { currentStock: p.currentStock, lowStockThreshold: p.lowStockThreshold }])
      );

      const items = order.items.map((item) => {
        const stockInfo = productStockMap.get(item.productId) ?? { currentStock: 0, lowStockThreshold: undefined };
        return {
          productId: item.productId,
          sku: item.sku,
          productName: item.productName,
          quantity: item.quantity,
          packed: packedSkus.has(item.sku),
          unit: item.unit,
          unitPrice: item.unitPrice,
          currentStock: stockInfo.currentStock,
          lowStockThreshold: stockInfo.lowStockThreshold ?? undefined,
        };
      });

      const allItemsPacked = items.length > 0 && items.every((item) => item.packed);

      // Resolve absorbed-order numbers (for the "Merged from" badge in the UI).
      const mergedFromIds = order.mergedFromOrderIds ?? [];
      const mergedFromOrders = mergedFromIds.length > 0
        ? await prisma.order.findMany({
            where: { id: { in: mergedFromIds } },
            select: { orderNumber: true },
          })
        : [];
      const mergedFromOrderNumbers = mergedFromOrders.map((o) => o.orderNumber);

      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerName: order.customer?.businessName ?? 'Unknown Customer',
        deliveryAddress: `${order.deliveryAddress.street}, ${order.deliveryAddress.suburb} ${order.deliveryAddress.state} ${order.deliveryAddress.postcode}`,
        area: areaInfo
          ? {
              id: areaInfo.id,
              name: areaInfo.name,
              displayName: areaInfo.displayName,
              colorVariant: areaInfo.colorVariant,
            }
          : null,
        items,
        status: order.status as 'confirmed' | 'packing' | 'ready_for_delivery',
        allItemsPacked,
        packingNotes: order.packing?.notes ?? undefined,
        internalNotes: order.internalNotes ?? null,
        mergedFromOrderNumbers,
      };
    }),

  /**
   * Check if PIN is required for quantity modifications
   */
  isPinRequired: requirePermission('packing:view').query(async () => {
    const company = await prisma.company.findFirst({
      select: {
        packingSettings: true,
      },
    });

    return {
      required: !!company?.packingSettings?.quantityPinHash,
    };
  }),

  /**
   * Update item quantity during packing
   * Adjusts stock and recalculates order totals
   * Requires PIN if configured in packing settings
   */
  updateItemQuantity: requirePermission('packing:manage')
    .input(
      z.object({
        orderId: z.string(),
        productId: z.string(),
        newQuantity: z.number().min(0),
        pin: z.string().regex(/^\d{4}$/, 'PIN must be exactly 4 digits').optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { orderId, productId, newQuantity, pin } = input;

      // Check if PIN is required and validate
      const company = await prisma.company.findFirst({
        select: {
          packingSettings: true,
        },
      });

      const pinRequired = !!company?.packingSettings?.quantityPinHash;

      if (pinRequired) {
        if (!pin) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'PIN is required for quantity modifications',
          });
        }

        const inputPinHash = createHash('sha256').update(pin).digest('hex');

        if (inputPinHash !== company.packingSettings?.quantityPinHash) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Invalid PIN',
          });
        }
      }

      // Fetch order
      const order = await prisma.order.findUnique({
        where: { id: orderId },
      });

      if (!order) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Order not found',
        });
      }

      // Block if stock already consumed (order marked ready)
      if (order.stockConsumed) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot adjust quantities after order has been marked ready for delivery.',
        });
      }

      // Block if not in editable status
      if (!['confirmed', 'packing'].includes(order.status)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot adjust quantities when order is in '${order.status}' status. Order must be in confirmed or packing status.`,
        });
      }

      // Find the item in the order
      const itemIndex = order.items.findIndex((item) => item.productId === productId);
      if (itemIndex === -1) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Item not found in order',
        });
      }

      const item = order.items[itemIndex];
      const oldQuantity = item.quantity;
      const quantityDiff = newQuantity - oldQuantity;

      // Fetch product for stock validation
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          currentStock: true,
          name: true,
        },
      });

      if (!product) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Product not found',
        });
      }

      // Stock validation is performed inside the transaction with fresh data
      // to prevent race conditions

      // Calculate new subtotal for this item using dinero.js
      const newSubtotal = newQuantity === 0
        ? 0
        : toCents(multiplyMoney(createMoney(item.unitPrice), newQuantity));

      // Update items array: keep item with qty=0 (instead of removing)
      const updatedItems = order.items.map((orderItem, idx) => {
        if (idx === itemIndex) {
          return {
            ...orderItem,
            quantity: newQuantity,
            subtotal: newSubtotal,
          };
        }
        return orderItem;
      });

      // Recalculate order totals using per-product GST settings
      // Note: Uses order-time prices (i.unitPrice) stored in the order item, NOT current product prices.
      // This ensures price consistency even if product prices change after order placement. (Issue #14 clarification)
      const newTotals = calculateOrderTotals(
            updatedItems.map((i: any) => ({
              quantity: i.quantity,
              unitPrice: i.unitPrice, // Order-time price, not current product price
              applyGst: i.applyGst ?? false,
              gstRate: i.gstRate ?? null,
            }))
          );

      // Stock calculation now happens inside the transaction with fresh data

      // Get user details for audit trail
      const userDetails = await getUserDetails(ctx.userId);

      // Perform all updates in a transaction
      const actualNewStock = await prisma.$transaction(async (tx) => {
        // Re-check stockConsumed inside transaction to prevent race condition
        const freshOrder = await tx.order.findUnique({
          where: { id: orderId },
          select: { stockConsumed: true, status: true, version: true, packing: true, items: true },
        });

        if (!freshOrder) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Order not found or was deleted.',
          });
        }

        if (freshOrder.stockConsumed) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Order was marked ready concurrently. Cannot adjust quantities.',
          });
        }

        if (!['confirmed', 'packing'].includes(freshOrder.status)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Order status changed to '${freshOrder.status}'. Cannot adjust quantities.`,
          });
        }

        // Re-fetch product inside transaction for accurate stock check
        const { isSubproduct: checkIsSubproduct, calculateParentConsumption: calcParentConsumption, calculateAllSubproductStocks: calcAllSubproductStocks } = await import('@joho-erp/shared');
        const freshProduct = await tx.product.findUnique({
          where: { id: productId },
          select: { id: true, currentStock: true, name: true, parentProductId: true, estimatedLossPercentage: true },
        });

        if (!freshProduct) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Product not found',
          });
        }

        const productIsSubproduct = checkIsSubproduct(freshProduct);

        // For subproducts, stock adjustments must route through the parent product
        // to match how markOrderReady consumes stock from the parent
        const stockTargetProductId = productIsSubproduct ? freshProduct.parentProductId! : productId;
        let freshTargetProduct = productIsSubproduct
          ? await tx.product.findUnique({
              where: { id: stockTargetProductId },
              select: { id: true, currentStock: true, name: true },
            })
          : { id: freshProduct.id, currentStock: freshProduct.currentStock, name: freshProduct.name };

        if (!freshTargetProduct) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `Parent product not found for subproduct ${freshProduct.name}`,
          });
        }

        // Calculate the actual stock delta on the target product
        // For subproducts, convert through loss percentage to get parent consumption
        const stockDelta = productIsSubproduct
          ? calcParentConsumption(Math.abs(quantityDiff), freshProduct.estimatedLossPercentage ?? 0) * Math.sign(quantityDiff)
          : quantityDiff;

        // Validate stock availability with fresh data inside transaction
        if (stockDelta > 0 && freshTargetProduct.currentStock < stockDelta) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Insufficient stock for ${freshTargetProduct.name} (${item.sku}). Available: ${freshTargetProduct.currentStock}, Required increase: ${stockDelta}. Please reduce the quantity or wait for stock replenishment.`,
          });
        }

        // Calculate new stock level with fresh data
        const freshNewStock = freshTargetProduct.currentStock - stockDelta;

        // Generate batch number for audit trail
        const { generateBatchNumber } = await import('../services/batch-number');
        const batchNumber = await generateBatchNumber(tx, 'packing_adjustment');

        // Create inventory transaction for audit trail (on the target product)
        const transaction = await tx.inventoryTransaction.create({
          data: {
            productId: stockTargetProductId,
            type: 'adjustment',
            adjustmentType: 'packing_adjustment',
            batchNumber,
            quantity: -stockDelta, // Negative when reducing stock (increasing order qty)
            previousStock: freshTargetProduct.currentStock,
            newStock: freshNewStock,
            referenceType: 'order',
            referenceId: orderId,
            notes: productIsSubproduct
              ? `Packing quantity adjustment for subproduct ${freshProduct.name} in order ${order.orderNumber}: ${oldQuantity} → ${newQuantity} ${item.unit} (parent stock adjusted)`
              : `Packing quantity adjustment for order ${order.orderNumber}: ${oldQuantity} → ${newQuantity} ${item.unit}`,
            createdBy: ctx.userId || 'system',
          },
        });

        // Handle batch consumption based on quantity change (on the target product)
        if (stockDelta > 0) {
          // Increasing order qty (reducing stock) - consume from batches
          const { consumeStock } = await import('../services/inventory-batch');
          const result = await consumeStock(
            stockTargetProductId,
            stockDelta,
            transaction.id,
            orderId,
            order.orderNumber,
            tx
          );

          // Log expiry warnings if any
          if (result.expiryWarnings.length > 0) {
            console.warn(
              `Expiry warnings during packing adjustment for order ${order.orderNumber}:`,
              result.expiryWarnings
            );
          }
        } else if (stockDelta < 0) {
          // Reducing order qty (returning stock) - create new batch for returned stock
          await tx.inventoryBatch.create({
            data: {
              productId: stockTargetProductId,
              batchNumber,
              quantityRemaining: Math.abs(stockDelta),
              initialQuantity: Math.abs(stockDelta),
              costPerUnit: 0, // Unknown cost - admin can adjust later
              receivedAt: new Date(),
              expiryDate: null,
              receiveTransactionId: transaction.id,
              notes: productIsSubproduct
                ? `Stock returned from packing adjustment (subproduct ${freshProduct.name}): Order ${order.orderNumber}`
                : `Stock returned from packing adjustment: Order ${order.orderNumber}`,
            },
          });
        }

        // Sync TARGET product stock from batch sums (parent for subproducts, self for regular)
        const { syncProductCurrentStock: syncAdjustStock } = await import('../services/inventory-batch');
        const syncedStock = await syncAdjustStock(stockTargetProductId, tx);

        // For subproducts, recalculate all sibling subproduct stocks from the updated parent
        if (productIsSubproduct) {
          const siblingSubproducts = await tx.product.findMany({
            where: { parentProductId: stockTargetProductId, status: 'active' },
            select: { id: true, parentProductId: true, estimatedLossPercentage: true },
          });

          if (siblingSubproducts.length > 0) {
            const updatedStocks = calcAllSubproductStocks(Math.max(0, syncedStock), siblingSubproducts);
            for (const { id, newStock: subStock } of updatedStocks) {
              await tx.product.update({
                where: { id },
                data: { currentStock: Math.max(0, subStock) },
              });
            }
          }
        }

        // CRITICAL FIX: Store original items on FIRST quantity adjustment
        // This allows full restoration on reset
        const existingOriginalItems = freshOrder.packing?.originalItems;
        const shouldStoreOriginalItems = !existingOriginalItems || existingOriginalItems.length === 0;

        let packingUpdate: any = {};
        if (shouldStoreOriginalItems) {
          // Snapshot original items from current order state (before this adjustment)
          packingUpdate = {
            packing: {
              ...(freshOrder.packing || {}),
              originalItems: freshOrder.items.map((i: any) => ({
                productId: i.productId,
                sku: i.sku,
                quantity: i.quantity,
                unitPrice: i.unitPrice,
                subtotal: i.subtotal,
              })),
            },
          };
        }

        // Update order with new items and totals using optimistic locking
        const updateResult = await tx.order.updateMany({
          where: {
            id: orderId,
            version: freshOrder.version,
          },
          data: {
            items: updatedItems,
            subtotal: newTotals.subtotal,
            taxAmount: newTotals.taxAmount,
            totalAmount: newTotals.totalAmount,
            version: { increment: 1 },
            ...packingUpdate,
          },
        });

        if (updateResult.count === 0) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Order was modified concurrently. Please retry.',
          });
        }

        // Update status history separately (requires update, not updateMany)
        const historyNote = newQuantity === 0
          ? `Item quantity set to 0: ${item.sku}`
          : `Item quantity adjusted: ${item.sku} ${oldQuantity} → ${newQuantity} ${item.unit}`;

        await tx.order.update({
          where: { id: orderId },
          data: {
            statusHistory: {
              push: {
                status: order.status,
                changedAt: new Date(),
                changedBy: ctx.userId || 'system',
                changedByName: userDetails.changedByName,
                changedByEmail: userDetails.changedByEmail,
                notes: historyNote,
              },
            },
          },
        });

        // Return the fresh stock value for use in response
        return freshNewStock;
      });

      // Audit log - HIGH: Quantity changes during packing must be tracked
      await logPackingItemQuantityUpdate(ctx.userId, undefined, ctx.userRole, ctx.userName, orderId, {
        orderNumber: order.orderNumber,
        itemSku: item.sku,
        oldQuantity,
        newQuantity,
        reason: newQuantity === 0 ? 'Item quantity set to 0 during packing' : 'Packing adjustment',
      }).catch((error) => {
        console.error('Audit log failed for packing quantity update:', error);
      });

      // Audit log for order total change during packing (Issue #16 fix)
      if (newTotals.totalAmount !== order.totalAmount) {
        await logPackingTotalChange(ctx.userId, orderId, {
          orderNumber: order.orderNumber,
          previousTotal: order.totalAmount,
          newTotal: newTotals.totalAmount,
          reason: `Item quantity adjusted: ${item.sku} ${oldQuantity} → ${newQuantity}`,
        }).catch((error) => {
          console.error('Audit log failed for packing total change:', error);
        });
      }

      return {
        success: true,
        oldQuantity,
        newQuantity,
        newStock: actualNewStock,
        newSubtotal,
        newOrderTotal: newTotals.totalAmount,
        itemRemoved: false,
        orderCancelled: false,
      };
    }),

  /**
   * Mark an individual item as packed/unpacked
   * Persists packed state to database for optimistic UI updates
   * Also updates lastPackedAt/lastPackedBy and clears pausedAt when actively packing
   */
  markItemPacked: requirePermission('packing:manage')
    .input(
      z.object({
        orderId: z.string(),
        itemSku: z.string(),
        packed: z.boolean(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      return prisma.$transaction(async (tx) => {
        // Fetch order with version for optimistic locking
        const order = await tx.order.findUnique({
          where: { id: input.orderId },
          select: {
            id: true,
            orderNumber: true,
            status: true,
            packing: true,
            version: true,
            requestedDeliveryDate: true,
          },
        });

        if (!order) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Order not found',
          });
        }

        // Get current packed items or initialize empty array
        const packedItems = order.packing?.packedItems ?? [];

        // Update packed items array
        const updatedPackedItems = input.packed
          ? [...new Set([...packedItems, input.itemSku])] // Add SKU (deduplicate)
          : packedItems.filter((sku) => sku !== input.itemSku); // Remove SKU

        // Get user details for audit trail
        const userDetails = await getUserDetails(ctx.userId);

        // Validate state transition if moving to 'packing'
        if (order.status === 'confirmed') {
          const transition = validateStatusTransition(
            order.status as OrderStatus,
            'packing',
            (ctx.userRole || 'packer') as UserRole
          );
          if (!transition.valid) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: transition.error || 'Invalid status transition',
            });
          }
        }

        // Optimistic locking: update only if version matches
        const updateResult = await tx.order.updateMany({
          where: {
            id: input.orderId,
            version: order.version,
          },
          data: {
            status: order.status === 'confirmed' ? 'packing' : order.status,
            packing: {
              ...(order.packing ?? {}),
              packedItems: updatedPackedItems,
              // Track when and who last packed
              lastPackedAt: new Date(),
              lastPackedBy: ctx.userId || 'system',
              // Clear paused state when actively packing
              pausedAt: null,
            },
            version: { increment: 1 },
          },
        });

        if (updateResult.count === 0) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Order was modified concurrently. Please refresh and retry.',
          });
        }

        // Handle statusHistory push separately (updateMany doesn't support push)
        if (order.status === 'confirmed') {
          await tx.order.update({
            where: { id: input.orderId },
            data: {
              statusHistory: {
                push: {
                  status: 'packing',
                  changedAt: new Date(),
                  changedBy: ctx.userId || 'system',
                  changedByName: userDetails.changedByName,
                  changedByEmail: userDetails.changedByEmail,
                  notes: 'Order moved to packing status',
                },
              },
            },
          });
        }

        // Update packing session activity to prevent timeout
        if (ctx.userId) {
          await updateSessionActivityByPacker(ctx.userId, order.requestedDeliveryDate);
        }

        // Audit log - MEDIUM: Item packing tracked
        await logPackingItemUpdate(ctx.userId, undefined, ctx.userRole, ctx.userName, input.orderId, {
          orderNumber: order.orderNumber,
          itemSku: input.itemSku,
          action: input.packed ? 'packed' : 'unpacked',
        }).catch((error) => {
          console.error('Audit log failed for mark item packed:', error);
        });

        return {
          success: true,
          packedItems: updatedPackedItems,
        };
      });
    }),

  /**
   * Mark entire order as ready for delivery
   */
  markOrderReady: requirePermission('packing:manage')
    .input(
      z.object({
        orderId: z.string(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Get user details for audit trail (can be done outside transaction)
      const userDetails = await getUserDetails(ctx.userId);

      // Import shared utilities
      const { consumeStock } = await import('../services/inventory-batch');
      const { isSubproduct, calculateParentConsumption, calculateAllSubproductStocks } = await import('@joho-erp/shared');

      // Track missing products for logging
      const missingProducts: string[] = [];

      // Reduce stock and update order in a transaction, returning order data for email/audit
      const orderData = await prisma.$transaction(async (tx) => {
        // Fetch order INSIDE transaction for fresh data
        const freshOrder = await tx.order.findUnique({
          where: { id: input.orderId },
          include: { customer: true },
        });

        if (!freshOrder) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Order not found',
          });
        }

        // Validate state transition to ready_for_delivery
        const transition = validateStatusTransition(
          freshOrder.status as OrderStatus,
          'ready_for_delivery',
          (ctx.userRole || 'packer') as UserRole
        );
        if (!transition.valid) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: transition.error || 'Invalid status transition to ready_for_delivery',
          });
        }

        // Idempotency check - prevent double stock consumption
        if (freshOrder.stockConsumed) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Stock already consumed for this order. This operation has already been completed.',
          });
        }

        // Delivery date validation - check if date hasn't passed (Issue #19 fix)
        const today = getTodayAsUTCMidnight();
        const deliveryDate = toUTCMidnightForMelbourneDay(freshOrder.requestedDeliveryDate);

        if (deliveryDate < today) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Cannot mark order ready - delivery date (${freshOrder.requestedDeliveryDate.toLocaleDateString('en-AU')}) has passed. Please update the delivery date first.`,
          });
        }

        // Validate order status
        if (freshOrder.status !== 'packing' && freshOrder.status !== 'confirmed') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Order is in '${freshOrder.status}' status, cannot mark ready. Must be in confirmed or packing status.`,
          });
        }

        // Prepare order data to return after transaction
        const txOrderData: {
          orderNumber: string;
          customerEmail: string;
          customerName: string;
          deliveryDate: Date;
          alreadyCompleted?: boolean;
        } = {
          orderNumber: freshOrder.orderNumber,
          customerEmail: freshOrder.customer.contactPerson.email,
          customerName: freshOrder.customer.businessName,
          deliveryDate: freshOrder.requestedDeliveryDate,
        };

        // Get products INSIDE transaction for fresh data
        const productIds = (freshOrder.items as any[]).map((item: any) => item.productId).filter(Boolean);
        const products = await tx.product.findMany({
          where: { id: { in: productIds } },
          include: { parentProduct: true },
        });

        // Create a product map for quick lookup
        const productMap = new Map(products.map((p) => [p.id, p]));

        // ============================================================================
        // CRITICAL FIX: Check for packing adjustments
        // If originalItems exists, quantity adjustments were made during packing.
        // The delta was already consumed by updateItemQuantity, so we should only
        // consume the ORIGINAL quantity here to avoid double consumption.
        // ============================================================================
        const packingData = freshOrder.packing as { originalItems?: any[] } | null;
        const originalItems = packingData?.originalItems;
        const hasAdjustments = Array.isArray(originalItems) && originalItems.length > 0;

        // Create a map of original quantities by productId for quick lookup
        const originalQuantityMap = new Map<string, number>();
        if (hasAdjustments) {
          for (const origItem of originalItems!) {
            originalQuantityMap.set(origItem.productId, origItem.quantity);
          }
        }

        // ============================================================================
        // PHASE 1: Aggregate consumption per parent product
        // This ensures that if an order has multiple subproducts from the same parent,
        // the parent stock is updated ONCE with the TOTAL consumption
        // ============================================================================
        const parentConsumptions = new Map<string, {
          totalConsumption: number;
          items: Array<{ product: any; item: any; consumeQuantity: number }>;
        }>();

        const regularProductItems: Array<{
          product: any;
          item: any;
          consumeQuantity: number;
        }> = [];

        // First pass: categorize and aggregate
        for (const item of freshOrder.items as any[]) {
          // Skip items with zero quantity ONLY if no packing adjustment was made.
          // When adjustments exist, updateItemQuantity already "returned" stock for
          // the delta, so we must still consume the ORIGINAL quantity here to keep
          // the ledger balanced. Without this, adjusting qty to 0 would create
          // phantom stock (the returned amount is never offset by consumption).
          if (item.quantity === 0) {
            const origQty = originalQuantityMap.get(item.productId);
            if (!origQty || origQty === 0) continue;
          }

          const product = productMap.get(item.productId);
          
          // Throw error for deleted products instead of silent skip (Issue #13 fix)
          if (!product) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Product ${item.productName} (${item.sku}) has been deleted and cannot be packed. Please modify the order to remove this item.`,
            });
          }

          const productIsSubproduct = isSubproduct(product);
          const parentProduct = productIsSubproduct ? product.parentProduct : null;

          // CRITICAL FIX: Use original quantity when adjustments exist
          // The adjustment delta was already consumed by updateItemQuantity
          const quantityForConsumption = hasAdjustments
            ? (originalQuantityMap.get(item.productId) ?? item.quantity)
            : item.quantity;

          const consumeQuantity = productIsSubproduct
            ? calculateParentConsumption(quantityForConsumption, product.estimatedLossPercentage ?? 0)
            : quantityForConsumption;

          if (productIsSubproduct && parentProduct) {
            const existing = parentConsumptions.get(parentProduct.id) || {
              totalConsumption: 0,
              items: [],
            };
            existing.totalConsumption += consumeQuantity;
            existing.items.push({ product, item, consumeQuantity });
            parentConsumptions.set(parentProduct.id, existing);
          } else if (productIsSubproduct && !parentProduct) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Parent product for "${product.name}" (${product.sku}) has been deleted. Cannot pack this subproduct.`,
            });
          } else {
            regularProductItems.push({ product, item, consumeQuantity });
          }
        }

        // ============================================================================
        // PHASE 2: Process parent products with aggregated totals
        // Each subproduct gets its own inventory transaction for audit trail,
        // but the parent stock is only updated ONCE with the total
        // ============================================================================
        for (const [parentId, { totalConsumption, items }] of parentConsumptions) {
          const parentProduct = await tx.product.findUnique({ where: { id: parentId } });
          if (!parentProduct) continue;

          const previousStock = parentProduct.currentStock;
          const newStock = previousStock - totalConsumption;

          // Validate stock availability with aggregated total
          if (newStock < 0) {
            const itemDetails = items.map(i => `${i.product.name} (qty: ${i.item.quantity})`).join(', ');
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Insufficient stock for parent product "${parentProduct.name}" to fulfill subproducts. ` +
                `Available: ${previousStock}, Required: ${totalConsumption.toFixed(2)}. ` +
                `Affected items: ${itemDetails}. ` +
                `Please adjust quantities or wait for parent product restock.`,
            });
          }



          // Create individual inventory transactions for each subproduct (detailed audit trail)
          let runningStock = previousStock;
          for (const { product, item, consumeQuantity } of items) {
            const transactionNotes = `Subproduct packed: ${product.name} (${item.quantity}${product.unit}) for order ${freshOrder.orderNumber}`;

            const transaction = await tx.inventoryTransaction.create({
              data: {
                productId: parentId,
                type: 'sale',
                quantity: -consumeQuantity,
                previousStock: runningStock,
                newStock: runningStock - consumeQuantity,
                referenceType: 'order',
                referenceId: freshOrder.id,
                notes: transactionNotes,
                createdBy: ctx.userId || 'system',
              },
            });
            runningStock -= consumeQuantity;

            // Consume from batches via FIFO (from parent for subproducts)
            try {
              const result = await consumeStock(
                parentId,
                consumeQuantity,
                transaction.id,
                freshOrder.id,
                freshOrder.orderNumber,
                tx
              );

              // Log expiry warnings if any
              if (result.expiryWarnings.length > 0) {
                console.warn(
                  `Expiry warnings for order ${freshOrder.orderNumber}:`,
                  result.expiryWarnings
                );
              }
            } catch (stockError) {
              console.error(`Stock consumption failed for order ${freshOrder.orderNumber}, product ${product.id}:`, stockError);
              const detail = stockError instanceof Error ? stockError.message : 'Unknown error';
              throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: `Failed to consume stock for ${product.name}: ${detail}. Transaction rolled back.`,
              });
            }
          }

          // Sync parent stock from batch sums (defensive — replaces manual arithmetic)
          const { syncProductCurrentStock } = await import('../services/inventory-batch');
          const syncedParentStock = await syncProductCurrentStock(parentId, tx);

          // Recalculate subproduct stocks from synced parent
          const subproducts = await tx.product.findMany({
            where: { parentProductId: parentId },
            select: { id: true, parentProductId: true, estimatedLossPercentage: true },
          });

          if (subproducts.length > 0) {
            const updatedStocks = calculateAllSubproductStocks(syncedParentStock, subproducts);
            for (const { id, newStock: subStock } of updatedStocks) {
              await tx.product.update({
                where: { id },
                data: { currentStock: Math.max(0, subStock) },
              });
            }
          }
        }

        // ============================================================================
        // PHASE 3: Process regular (non-subproduct) products
        // ============================================================================
        for (const { product, consumeQuantity } of regularProductItems) {
          // Get current stock FRESH inside transaction
          const freshProduct = await tx.product.findUnique({ where: { id: product.id } });
          if (!freshProduct) continue;

          const previousStock = freshProduct.currentStock;
          const newStock = previousStock - consumeQuantity;

          // Validate stock availability
          if (newStock < 0) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Insufficient stock for "${product.name}" (SKU: ${product.sku ?? 'N/A'}). ` +
                `Available: ${previousStock}, Required: ${consumeQuantity}. ` +
                `Please adjust the order quantity or wait for stock replenishment.`,
            });
          }



          // Create inventory transaction
          const transactionNotes = `Stock consumed at packing for order ${freshOrder.orderNumber}`;

          const transaction = await tx.inventoryTransaction.create({
            data: {
              productId: product.id,
              type: 'sale',
              quantity: -consumeQuantity,
              previousStock,
              newStock,
              referenceType: 'order',
              referenceId: freshOrder.id,
              notes: transactionNotes,
              createdBy: ctx.userId || 'system',
            },
          });

          // Consume from batches via FIFO
          try {
            const result = await consumeStock(
              product.id,
              consumeQuantity,
              transaction.id,
              freshOrder.id,
              freshOrder.orderNumber,
              tx
            );

            // Log expiry warnings if any
            if (result.expiryWarnings.length > 0) {
              console.warn(
                `Expiry warnings for order ${freshOrder.orderNumber}:`,
                result.expiryWarnings
              );
            }
          } catch (stockError) {
            console.error(`Stock consumption failed for order ${freshOrder.orderNumber}, product ${product.id}:`, stockError);
            const detail = stockError instanceof Error ? stockError.message : 'Unknown error';
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: `Failed to consume stock for ${product.name}: ${detail}. Transaction rolled back.`,
            });
          }

          // Sync product stock from batch sums (defensive — replaces manual arithmetic)
          const { syncProductCurrentStock: syncRegularStock } = await import('../services/inventory-batch');
          const syncedRegularStock = await syncRegularStock(product.id, tx);

          // If this regular product has subproducts, recalculate their stocks too
          const subproducts = await tx.product.findMany({
            where: { parentProductId: product.id },
            select: { id: true, parentProductId: true, estimatedLossPercentage: true },
          });

          if (subproducts.length > 0) {
            const updatedStocks = calculateAllSubproductStocks(syncedRegularStock, subproducts);
            for (const { id, newStock: subStock } of updatedStocks) {
              await tx.product.update({
                where: { id },
                data: { currentStock: Math.max(0, subStock) },
              });
            }
          }
        }

        // Log warning for missing products
        if (missingProducts.length > 0) {
          console.warn(`Order ${freshOrder.orderNumber}: Skipped deleted products:`, missingProducts);
        }

        // Atomic update with stockConsumed check and version-based optimistic locking for idempotency
        // Both stockConsumed: false and version check provide guards against concurrent modifications
        const updateResult = await tx.order.updateMany({
          where: {
            id: input.orderId,
            stockConsumed: false,
            version: freshOrder.version,
          },
          data: {
            status: 'ready_for_delivery',
            stockConsumed: true,
            stockConsumedAt: new Date(),
            version: { increment: 1 },
          },
        });

        if (updateResult.count === 0) {
          // Check if this is because the operation already succeeded (idempotent case)
          const recheckOrder = await tx.order.findUnique({
            where: { id: input.orderId },
            select: { stockConsumed: true, status: true },
          });

          if (recheckOrder?.stockConsumed && recheckOrder.status === 'ready_for_delivery') {
            // Operation already completed successfully - return success (idempotent)
            // This handles duplicate requests (e.g., double-click, network retry)
            // Skip secondary update (packing info, status history) to avoid duplicates
            txOrderData.alreadyCompleted = true;
            return txOrderData;
          }

          // Genuine conflict - another process modified the order
          throw new TRPCError({ 
            code: 'CONFLICT', 
            message: 'Order modified concurrently. Please retry.' 
          });
        }

        // Auto-update requestedDeliveryDate if it doesn't match today (Melbourne timezone)
        const todayStart = getTodayAsUTCMidnight();
        const requestedDate = toUTCMidnightForMelbourneDay(freshOrder.requestedDeliveryDate);
        const isPreOrderShippedEarly = requestedDate > todayStart;
        const isPastDeliveryDate = requestedDate < todayStart;
        const needsDateUpdate = isPreOrderShippedEarly || isPastDeliveryDate;

        let statusNote = input.notes || 'Order packed and ready for delivery';
        if (isPreOrderShippedEarly) {
          const originalDateStr = formatMelbourneDateForDisplay(freshOrder.requestedDeliveryDate);
          statusNote = `${statusNote}. Delivery date moved forward from ${originalDateStr} to today.`;
        } else if (isPastDeliveryDate) {
          const originalDateStr = formatMelbourneDateForDisplay(freshOrder.requestedDeliveryDate);
          statusNote = `${statusNote}. Delivery date moved from ${originalDateStr} to today (original date was in the past).`;
        }

        // Update packing info and status history separately (these fields require update, not updateMany)
        await tx.order.update({
          where: { id: input.orderId },
          data: {
            // Move delivery date to today if it doesn't match (pre-order shipped early or past date)
            ...(needsDateUpdate ? { requestedDeliveryDate: todayStart } : {}),
            packing: {
              // Preserve existing packing fields (including originalItems from quantity adjustments)
              ...(freshOrder.packing || {}),
              packedAt: new Date(),
              packedBy: ctx.userId || 'system',
              notes: input.notes,
            },
            statusHistory: {
              push: {
                status: 'ready_for_delivery',
                changedAt: new Date(),
                changedBy: ctx.userId || 'system',
                changedByName: userDetails.changedByName,
                changedByEmail: userDetails.changedByEmail,
                notes: statusNote,
              },
            },
          },
        });

        // Update delivery date in return data for email notification
        if (needsDateUpdate) {
          txOrderData.deliveryDate = todayStart;
        }

        // Return order data for use after transaction
        return txOrderData;
      });

      // Send order ready for delivery email to customer (after transaction success)
      // Skip email and audit if this was a duplicate request that already completed
      if (orderData && !orderData.alreadyCompleted) {
        await sendOrderReadyForDeliveryEmail({
          customerEmail: orderData.customerEmail,
          customerName: orderData.customerName,
          orderNumber: orderData.orderNumber,
          deliveryDate: orderData.deliveryDate,
        }).catch((error) => {
          console.error('Failed to send order ready for delivery email:', error);
        });

        // Audit log - HIGH: Ready for delivery must be tracked
        await logOrderReadyForDelivery(ctx.userId, undefined, ctx.userRole, ctx.userName, input.orderId, {
          orderNumber: orderData.orderNumber,
          packedBy: ctx.userId || 'system',
        }).catch((error) => {
          console.error('Audit log failed for mark order ready:', error);
        });

        // Trigger Xero invoice creation when order becomes ready_for_delivery
        // Check if invoice doesn't already exist before enqueuing
        const orderForXero = await prisma.order.findUnique({
          where: { id: input.orderId },
          select: { xero: true },
        });
        const xeroInfo = orderForXero?.xero as { invoiceId?: string | null } | null;
        const { enqueueXeroJob } = await import('../services/xero-queue');
        if (!xeroInfo?.invoiceId) {
          await enqueueXeroJob('create_invoice', 'order', input.orderId).catch((error) => {
            console.error('Failed to enqueue Xero invoice creation:', error);
          });
        } else {
          // Order already has invoice (e.g. from before packing reset) — update it with current quantities
          await enqueueXeroJob('update_invoice', 'order', input.orderId).catch((error) => {
            console.error('Failed to enqueue Xero invoice update:', error);
          });
        }
      }

      // After transaction, fetch updated product stocks for the items in this order
      // This allows the frontend to update cache without invalidation (prevents flash)
      const orderForStocks = await prisma.order.findUnique({
        where: { id: input.orderId },
        select: { items: true },
      });

      const orderItemsArray = (orderForStocks?.items ?? []) as Array<{ productId: string }>;
      const productIds = [...new Set(orderItemsArray.map(item => item.productId).filter(Boolean))] as string[];

      const updatedProducts = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          currentStock: true,
          lowStockThreshold: true,
        },
      });

      const updatedStocks = updatedProducts.reduce((acc, product) => {
        acc[product.id] = {
          currentStock: product.currentStock,
          lowStockThreshold: product.lowStockThreshold,
        };
        return acc;
      }, {} as Record<string, { currentStock: number; lowStockThreshold: number | null }>);

      return { success: true, updatedStocks };
    }),

  /**
   * Add packing notes to an order
   */
  addPackingNotes: requirePermission('packing:manage')
    .input(
      z.object({
        orderId: z.string(),
        notes: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      return prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: input.orderId },
          select: { id: true, orderNumber: true, packing: true, version: true },
        });

        if (!order) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Order not found',
          });
        }

        // Optimistic locking: update only if version matches
        const updateResult = await tx.order.updateMany({
          where: {
            id: input.orderId,
            version: order.version,
          },
          data: {
            packing: {
              ...order.packing,
              notes: input.notes,
            },
            version: { increment: 1 },
          },
        });

        if (updateResult.count === 0) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Order was modified concurrently. Please refresh and retry.',
          });
        }

        // Audit log - LOW: Packing notes tracked
        await logPackingNotesUpdate(ctx.userId, undefined, ctx.userRole, ctx.userName, input.orderId, {
          orderNumber: order.orderNumber,
          notes: input.notes,
        }).catch((error) => {
          console.error('Audit log failed for packing notes:', error);
        });

        return { success: true };
      });
    }),

  /**
   * Pause packing on an order - saves progress for later
   * Sets pausedAt timestamp and keeps order in 'packing' status
   */
  pauseOrder: requirePermission('packing:manage')
    .input(
      z.object({
        orderId: z.string(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Get user details for audit trail (safe outside transaction)
      const userDetails = await getUserDetails(ctx.userId);

      const result = await prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: input.orderId },
          select: {
            id: true,
            orderNumber: true,
            status: true,
            packing: true,
            version: true,
          },
        });

        if (!order) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Order not found',
          });
        }

        // Only allow pausing orders that are in 'packing' status
        if (order.status !== 'packing') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Only orders in packing status can be paused',
          });
        }

        // Must have some progress to pause
        const packedItemsCount = order.packing?.packedItems?.length ?? 0;
        if (packedItemsCount === 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cannot pause order with no packed items',
          });
        }

        // Atomic guard with version check to prevent TOCTOU race
        const updateResult = await tx.order.updateMany({
          where: {
            id: input.orderId,
            status: 'packing',
            version: order.version,
          },
          data: {
            packing: {
              ...order.packing,
              pausedAt: new Date(),
              notes: input.notes || order.packing?.notes,
            },
            version: { increment: 1 },
          },
        });

        if (updateResult.count === 0) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Order was modified concurrently. Please refresh and retry.',
          });
        }

        // Push status history separately (updateMany doesn't support push)
        await tx.order.update({
          where: { id: input.orderId },
          data: {
            statusHistory: {
              push: {
                status: 'packing',
                changedAt: new Date(),
                changedBy: ctx.userId || 'system',
                changedByName: userDetails.changedByName,
                changedByEmail: userDetails.changedByEmail,
                notes: `Packing paused. Progress: ${packedItemsCount} items packed`,
              },
            },
          },
        });

        return { orderNumber: order.orderNumber };
      });

      // Audit log - MEDIUM: Packing pause tracked
      await logPackingOrderPauseResume(ctx.userId, undefined, ctx.userRole, ctx.userName, input.orderId, {
        orderNumber: result.orderNumber,
        action: 'pause',
        reason: input.notes,
      }).catch((error) => {
        console.error('Audit log failed for pause order:', error);
      });

      return { success: true };
    }),

  /**
   * Resume packing on a paused order
   * Clears pausedAt and updates lastPackedAt/lastPackedBy
   */
  resumeOrder: requirePermission('packing:manage')
    .input(
      z.object({
        orderId: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Get user details for audit trail (safe outside transaction)
      const userDetails = await getUserDetails(ctx.userId);

      const result = await prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: input.orderId },
          select: {
            id: true,
            orderNumber: true,
            status: true,
            packing: true,
            version: true,
            requestedDeliveryDate: true,
          },
        });

        if (!order) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Order not found',
          });
        }

        // Only allow resuming orders that are in 'packing' status
        if (order.status !== 'packing') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Only orders in packing status can be resumed',
          });
        }

        // Atomic guard with version check to prevent TOCTOU race
        const updateResult = await tx.order.updateMany({
          where: {
            id: input.orderId,
            status: 'packing',
            version: order.version,
          },
          data: {
            packing: {
              ...order.packing,
              pausedAt: null,
              lastPackedAt: new Date(),
              lastPackedBy: ctx.userId || 'system',
            },
            version: { increment: 1 },
          },
        });

        if (updateResult.count === 0) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Order was modified concurrently. Please refresh and retry.',
          });
        }

        // Push status history separately (updateMany doesn't support push)
        await tx.order.update({
          where: { id: input.orderId },
          data: {
            statusHistory: {
              push: {
                status: 'packing',
                changedAt: new Date(),
                changedBy: ctx.userId || 'system',
                changedByName: userDetails.changedByName,
                changedByEmail: userDetails.changedByEmail,
                notes: 'Packing resumed',
              },
            },
          },
        });

        return { orderNumber: order.orderNumber, requestedDeliveryDate: order.requestedDeliveryDate };
      });

      // Update packing session activity
      if (ctx.userId) {
        await updateSessionActivityByPacker(ctx.userId, result.requestedDeliveryDate);
      }

      // Audit log - MEDIUM: Packing resume tracked
      await logPackingOrderPauseResume(ctx.userId, undefined, ctx.userRole, ctx.userName, input.orderId, {
        orderNumber: result.orderNumber,
        action: 'resume',
      }).catch((error) => {
        console.error('Audit log failed for resume order:', error);
      });

      return { success: true };
    }),

  /**
   * Reset order packing progress - clears all packed items
   * Reverts order to 'confirmed' status
   */
  resetOrder: requirePermission('packing:manage')
    .input(
      z.object({
        orderId: z.string(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Import shared utilities for subproduct stock calculation
      const { calculateAllSubproductStocks } = await import('@joho-erp/shared');

      // Get user details for audit trail (can be done outside transaction)
      const userDetails = await getUserDetails(ctx.userId);

      // Capture values for audit log outside transaction
      let orderNumber: string = '';
      let packedItemsCount = 0;
      let stockWasConsumed = false;
      let hadOriginalItems = false;

      // Use transaction for all operations to ensure atomicity
      await prisma.$transaction(async (tx) => {
        // CRITICAL FIX: Fetch order INSIDE transaction for fresh data
        const order = await tx.order.findUnique({
          where: { id: input.orderId },
        });

        if (!order) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Order not found',
          });
        }

        // Capture for audit log
        orderNumber = order.orderNumber;
        packedItemsCount = order.packing?.packedItems?.length ?? 0;
        stockWasConsumed = order.stockConsumed;
        hadOriginalItems = !!(order.packing?.originalItems && order.packing.originalItems.length > 0);

        // Allow resetting orders that are in 'packing', 'confirmed', or 'ready_for_delivery' status
        if (!['packing', 'confirmed', 'ready_for_delivery'].includes(order.status)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Only orders in packing, confirmed, or ready_for_delivery status can be reset',
          });
        }

        // CRITICAL FIX: If stock was consumed, use atomic guard to prevent double restoration
        if (order.stockConsumed) {
          // Atomically claim the reset by setting stockConsumed to false
          // Only succeeds if stockConsumed is still true
          const claimResult = await tx.order.updateMany({
            where: {
              id: input.orderId,
              stockConsumed: true, // Atomic guard - only proceed if still true
            },
            data: {
              stockConsumed: false,
              stockConsumedAt: null,
            },
          });

          if (claimResult.count === 0) {
            // Check if already reset by another request (idempotent case)
            const recheck = await tx.order.findUnique({
              where: { id: input.orderId },
              select: { stockConsumed: true },
            });
            if (!recheck?.stockConsumed) {
              // Already reset - this is an idempotent success, skip stock restoration
              // but continue to reset other fields
            } else {
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'Order modified concurrently. Please retry.',
              });
            }
          } else {
            // Successfully claimed the reset - now restore stock
            // CRITICAL FIX: Include BOTH sale AND packing_adjustment transactions
            // Only include transactions that haven't been reversed yet
            const stockTransactions = await tx.inventoryTransaction.findMany({
              where: {
                referenceType: 'order',
                referenceId: input.orderId,
                OR: [
                  { type: 'sale' },
                  { type: 'adjustment', adjustmentType: 'packing_adjustment' },
                ],
              },
            });

            // Filter out already-reversed transactions in code (MongoDB doesn't match missing fields with null)
            const unreversedTransactions = stockTransactions.filter(txn => !txn.reversedAt);

            const { generateBatchNumber: genResetBatchNum } = await import('../services/batch-number');
            const { syncProductCurrentStock: syncResetStock, restoreBatchConsumptions } = await import('../services/inventory-batch');

            // Separate consuming vs returning transactions:
            // - Consuming (qty < 0): sale txns and negative packing_adjustments → have BatchConsumption records
            // - Returning (qty > 0): positive packing_adjustments → created phantom batches directly
            const consumingTxnIds = unreversedTransactions
              .filter(txn => txn.quantity < 0)
              .map(txn => txn.id);
            const returningTxns = unreversedTransactions.filter(txn => txn.quantity > 0);

            // Step A: Restore original supplier batches via BatchConsumption reversal
            if (consumingTxnIds.length > 0) {
              const restoredQty = await restoreBatchConsumptions(consumingTxnIds, tx);
              console.info('[PACKING_RESET] Restored batch consumptions:', {
                orderId: input.orderId,
                orderNumber: order.orderNumber,
                consumingTxnCount: consumingTxnIds.length,
                totalRestoredQty: restoredQty,
              });
            }

            // Step B: Zero out phantom batches created by returning packing_adjustments
            for (const txn of returningTxns) {
              const phantomBatches = await tx.inventoryBatch.findMany({
                where: { receiveTransactionId: txn.id },
              });
              for (const batch of phantomBatches) {
                await tx.inventoryBatch.update({
                  where: { id: batch.id },
                  data: { quantityRemaining: 0, isConsumed: true, consumedAt: new Date() },
                });
              }
            }

            // Step C: Create audit trail packing_reset transactions and sync stock
            // Group by productId to aggregate all quantities
            const productConsumptions = new Map<string, number>();
            for (const txn of unreversedTransactions) {
              const current = productConsumptions.get(txn.productId) || 0;
              productConsumptions.set(txn.productId, current + (-txn.quantity));
            }

            const affectedProductIds = new Set<string>();
            for (const [productId, quantity] of productConsumptions) {
              if (quantity === 0) continue;
              affectedProductIds.add(productId);

              const product = await tx.product.findUnique({ where: { id: productId } });
              if (!product) continue;

              const previousStock = product.currentStock;
              const resetBatchNumber = await genResetBatchNum(tx, 'packing_reset');

              // Create audit transaction (no batch creation — originals are restored/zeroed)
              await tx.inventoryTransaction.create({
                data: {
                  productId,
                  type: 'adjustment',
                  adjustmentType: 'packing_reset',
                  batchNumber: resetBatchNumber,
                  quantity,
                  previousStock,
                  newStock: previousStock + quantity,
                  referenceType: 'order',
                  referenceId: input.orderId,
                  notes: `Stock restored from packing reset: Order ${order.orderNumber}`,
                  createdBy: ctx.userId || 'system',
                },
              });
            }

            // Step D: Sync stock for all affected products and cascade subproducts
            for (const productId of affectedProductIds) {
              const syncedResetStock = await syncResetStock(productId, tx);
              console.info('[PACKING_RESET] Synced stock:', {
                productId,
                syncedStock: syncedResetStock,
              });

              const subproducts = await tx.product.findMany({
                where: { parentProductId: productId },
                select: { id: true, parentProductId: true, estimatedLossPercentage: true },
              });

              if (subproducts.length > 0) {
                const updatedStocks = calculateAllSubproductStocks(syncedResetStock, subproducts);
                for (const { id, newStock: subStock } of updatedStocks) {
                  await tx.product.update({
                    where: { id },
                    data: { currentStock: Math.max(0, subStock) },
                  });
                }
              }
            }

            // Mark original transactions as reversed to prevent double-counting
            if (unreversedTransactions.length > 0) {
              await tx.inventoryTransaction.updateMany({
                where: {
                  id: { in: unreversedTransactions.map((t) => t.id) },
                },
                data: {
                  reversedAt: new Date(),
                },
              });
            }
          }
        }

        // CRITICAL FIX: Restore original order items if they were modified
        // This handles packing adjustments made BEFORE markOrderReady
        if (order.packing?.originalItems && order.packing.originalItems.length > 0) {
          const originalItems = order.packing.originalItems;

          // For items NOT already handled by stockConsumed restoration,
          // we need to reverse the packing adjustments
          // Note: If stockConsumed was true, the adjustments were already included above
          // But if stockConsumed was false, we need to handle them here
          if (!order.stockConsumed) {
            // Use shared service to reverse packing adjustments
            await reversePackingAdjustments(
              {
                orderId: input.orderId,
                orderNumber: order.orderNumber,
                userId: ctx.userId || 'system',
                reason: input.reason || 'Packing reset',
              },
              tx
            );
          }

          // Recalculate order totals from original items
          const { calculateOrderTotals } = await import('@joho-erp/shared');

          // Restore original items array
          const restoredItems = order.items.map((item: any) => {
            const original = originalItems.find((o: any) => o.productId === item.productId);
            if (original) {
              return {
                ...item,
                quantity: original.quantity,
                subtotal: original.subtotal,
              };
            }
            return item;
          });

          // Recalculate totals
          const newTotals = calculateOrderTotals(
            restoredItems.map((i: any) => ({
              quantity: i.quantity,
              unitPrice: i.unitPrice,
              applyGst: i.applyGst ?? false,
              gstRate: i.gstRate ?? null,
            }))
          );

          // Update order with restored items
          await tx.order.update({
            where: { id: input.orderId },
            data: {
              items: restoredItems,
              subtotal: newTotals.subtotal,
              taxAmount: newTotals.taxAmount,
              totalAmount: newTotals.totalAmount,
            },
          });
        }

        // Reset order fields (status, packing, etc.)
        await tx.order.update({
          where: { id: input.orderId },
          data: {
            status: 'confirmed',
            // Note: stockConsumed already set to false by atomic updateMany above if it was true
            ...(order.stockConsumed ? {} : { stockConsumed: false, stockConsumedAt: null }),
            packing: {
              packedAt: null,
              packedBy: null,
              notes: null,
              areaPackingSequence: order.packing?.areaPackingSequence ?? (order.packing as any)?.packingSequence ?? null,
              packedItems: [],
              lastPackedAt: null,
              lastPackedBy: null,
              pausedAt: null,
              originalItems: [], // Clear original items snapshot
            },
            statusHistory: {
              push: {
                status: 'confirmed',
                changedAt: new Date(),
                changedBy: ctx.userId || 'system',
                changedByName: userDetails.changedByName,
                changedByEmail: userDetails.changedByEmail,
                notes: `Packing reset from ${order.status} status. ${packedItemsCount} items cleared. ${
                  stockWasConsumed ? 'Stock consumption reversed. ' : ''
                }${hadOriginalItems ? 'Original quantities restored. ' : ''}Reason: ${input.reason || 'Manual reset by packer'}`,
              },
            },
          },
        });
      });

      // Audit log - MEDIUM: Packing reset tracked
      await logPackingOrderReset(ctx.userId, undefined, ctx.userRole, ctx.userName, input.orderId, {
        orderNumber: orderNumber,
        reason: stockWasConsumed
          ? `${input.reason || 'Manual reset'} (stock consumption reversed)`
          : input.reason,
      }).catch((error) => {
        console.error('Audit log failed for reset order:', error);
      });

      return { success: true };
    }),

  /**
   * Optimize delivery route for a specific date
   * Calculates packing and delivery sequences using Mapbox
   */
  optimizeRoute: requirePermission('packing:manage')
    .input(
      z.object({
        deliveryDate: z.string().datetime(),
        force: z.boolean().optional(), // Force re-optimization even if route exists
      })
    )
    .mutation(async ({ input, ctx }) => {
      const deliveryDate = new Date(input.deliveryDate);

      // Check if route already exists and is up-to-date
      if (!input.force) {
        const needsReoptimization =
          await checkIfRouteNeedsReoptimization(deliveryDate);

        if (!needsReoptimization) {
          const existingRoute = await getRouteOptimization(deliveryDate);
          if (existingRoute) {
            return {
              success: true,
              message: "Route already optimized",
              routeId: existingRoute.id,
              alreadyOptimized: true,
            };
          }
        }
      }

      try {
        const result = await optimizeDeliveryRoute(
          deliveryDate,
          ctx.userId || "system"
        );

        return {
          success: true,
          message: `Route optimized successfully. ${result.routeSummary.totalOrders} orders, ${(result.routeSummary.totalDistance / 1000).toFixed(1)} km`,
          routeId: result.routeOptimizationId,
          summary: result.routeSummary,
          alreadyOptimized: false,
        };
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Route optimization failed",
        });
      }
    }),

  /**
   * Get packing session with optimized sequences
   * Enhanced version of getSession that includes sequence numbers
   * Also starts/resumes a packing session and auto-triggers route optimization if needed
   */
  getOptimizedSession: requirePermission('packing:view')
    .input(
      z.object({
        deliveryDate: z.string().datetime(),
        areaId: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const deliveryDate = new Date(input.deliveryDate);

      // Auto-merge eligible orders (same customer + date + address) before
      // building the session. Best-effort — failures are logged but never block
      // the screen. Successful merges flip RouteOptimization.needsReoptimization
      // so the auto-optimizer below picks up the new layout.
      try {
        await mergeEligibleOrdersInternal(deliveryDate, input.areaId, ctx);
      } catch (err) {
        console.error('mergeEligibleOrders failed:', err);
      }

      // Get all orders for the delivery date (Melbourne-aware boundaries)
      const { start: startOfDay, end: endOfDay } = getUTCDayRangeForMelbourneDay(deliveryDate);

      // Build base where clause. `mergedIntoOrderId: null` is a defense-in-depth
      // filter — the `merged` status is already excluded by the `status in` list
      // below, but this guards against future status filter changes.
      const where: Prisma.OrderWhereInput = {
        requestedDeliveryDate: {
          gte: startOfDay,
          lt: endOfDay,
        },
        status: {
          in: ["confirmed", "packing", "ready_for_delivery"],
        },
        mergedIntoOrderId: null,
      };

      if (input.areaId) {
        where.deliveryAddress = {
          is: { areaId: input.areaId },
        };
      }

      const orders = await prisma.order.findMany({
        where,
        include: {
          customer: {
            select: {
              businessName: true,
            },
          },
        },
        orderBy: [
          { deliveryAddress: { areaName: "asc" } }, // Group by area first
          { packing: { areaPackingSequence: "asc" } }, // Then by per-area packing sequence
          { orderNumber: "asc" }, // Fallback to order number
        ],
      });

      // Resolve absorbed-order numbers for the "Merged from" badge. Absorbed
      // orders carry status='merged' and are excluded from the main `orders`
      // fetch above, so we look them up by id.
      const allAbsorbedIds = orders.flatMap((o) => o.mergedFromOrderIds ?? []);
      const absorbedOrders = allAbsorbedIds.length > 0
        ? await prisma.order.findMany({
            where: { id: { in: allAbsorbedIds } },
            select: { id: true, orderNumber: true },
          })
        : [];
      const absorbedNumberById = new Map(absorbedOrders.map((o) => [o.id, o.orderNumber]));

      // Build product summary
      const productMap = new Map<string, ProductSummaryItem>();

      for (const order of orders) {
        for (const item of order.items) {
          if (!item.productId) continue;

          const productId = item.productId;

          if (productMap.has(productId)) {
            const existing = productMap.get(productId)!;
            existing.totalQuantity += item.quantity;
            existing.orders.push({
              orderNumber: order.orderNumber,
              quantity: item.quantity,
              status: order.status as 'confirmed' | 'packing' | 'ready_for_delivery',
            });
          } else {
            productMap.set(productId, {
              productId: item.productId,
              sku: item.sku,
              productName: item.productName,
              category: null, // Will be populated after fetching from products
              unit: item.unit,
              totalQuantity: item.quantity,
              orders: [
                {
                  orderNumber: order.orderNumber,
                  quantity: item.quantity,
                  status: order.status as 'confirmed' | 'packing' | 'ready_for_delivery',
                },
              ],
            });
          }
        }
      }

      // Fetch categories for all products in the productMap
      const productIds = Array.from(productMap.keys());
      const productsWithCategories = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, category: true },
      });

      // Create a map of productId -> category
      const categoryMap = new Map<string, string | null>();
      for (const product of productsWithCategories) {
        categoryMap.set(product.id, product.category);
      }

      // Add category to each product summary item
      for (const [productId, item] of productMap.entries()) {
        item.category = categoryMap.get(productId) as ProductSummaryItem['category'] ?? null;
      }

      const productSummary = Array.from(productMap.values()).sort((a, b) =>
        a.sku.localeCompare(b.sku)
      );

      // Start or resume packing session for timeout tracking
      if (ctx.userId && orders.length > 0) {
        const orderIds = orders.map((order) => order.id);
        await startPackingSession(ctx.userId, deliveryDate, orderIds);
      }

      // Per-area manual lock state (admin-set packing sequence overrides)
      const areaLockRecords = await prisma.routeOptimization.findMany({
        where: {
          deliveryDate: { gte: startOfDay, lte: endOfDay },
          routeType: 'packing',
          areaId: { not: null },
        },
        select: {
          areaId: true,
          manuallyLocked: true,
          manuallyLockedAt: true,
        },
      });
      const areaLocks = areaLockRecords
        .filter((r): r is typeof r & { areaId: string } => r.areaId !== null)
        .map((r) => ({
          areaId: r.areaId,
          manuallyLocked: r.manuallyLocked,
          manuallyLockedAt: r.manuallyLockedAt,
        }));

      // Auto-trigger route optimization if needed (Task 1.2 requirement)
      let routeOptimization = await getRouteOptimization(deliveryDate);
      let needsReoptimization = await checkIfRouteNeedsReoptimization(deliveryDate);
      let routeAutoOptimized = false;

      // If route needs optimization and there are orders to pack, auto-trigger
      if (needsReoptimization && orders.length > 0) {
        try {
          await optimizeDeliveryRoute(
            deliveryDate,
            ctx.userId || "system"
          );
          routeOptimization = await getRouteOptimization(deliveryDate);
          needsReoptimization = false;
          routeAutoOptimized = true;

          // Re-fetch orders to get updated packing sequences
          const updatedOrders = await prisma.order.findMany({
            where: {
              id: { in: orders.map(o => o.id) },
            },
            include: {
              customer: {
                select: {
                  businessName: true,
                },
              },
            },
            orderBy: [
              { deliveryAddress: { areaName: "asc" } }, // Group by area
              { packing: { areaPackingSequence: "asc" } }, // Then by per-area packing sequence
              { orderNumber: "asc" },
            ],
          });

          // Re-fetch orders with updated sequences
          const refetchedOrders = await prisma.order.findMany({
            where: {
              id: { in: updatedOrders.map(o => o.id) },
            },
            include: {
              customer: {
                select: {
                  businessName: true,
                },
              },
            },
            orderBy: [
              { deliveryAddress: { areaName: "asc" } }, // Group by area
              { packing: { areaPackingSequence: "asc" } }, // Then by per-area packing sequence
              { orderNumber: "asc" },
            ],
          });

          // Fetch area colors for mapping
          const areas = await prisma.area.findMany({
            where: { isActive: true },
            select: { name: true, displayName: true, colorVariant: true, sortOrder: true },
          });
          const areaMap = new Map(areas.map(a => [a.name, a]));

          // Re-resolve absorbed-order numbers (refetchedOrders may have updated mergedFromOrderIds).
          const refetchedAbsorbedIds = refetchedOrders.flatMap((o) => o.mergedFromOrderIds ?? []);
          const refetchedAbsorbed = refetchedAbsorbedIds.length > 0
            ? await prisma.order.findMany({
                where: { id: { in: refetchedAbsorbedIds } },
                select: { id: true, orderNumber: true },
              })
            : [];
          const refetchedAbsorbedNumberById = new Map(refetchedAbsorbed.map((o) => [o.id, o.orderNumber]));

          // Use updated orders with packing sequences and area info
          return {
            deliveryDate,
            orders: refetchedOrders.map((order) => {
              const areaName = order.deliveryAddress.areaName ?? 'unassigned';
              const area = areaMap.get(areaName);
              const mergedFromOrderNumbers = (order.mergedFromOrderIds ?? [])
                .map((id) => refetchedAbsorbedNumberById.get(id))
                .filter((n): n is string => Boolean(n));
              return {
                orderId: order.id,
                orderNumber: order.orderNumber,
                customerName: order.customer?.businessName ?? "Unknown Customer",
                areaName: order.deliveryAddress.areaName,
                areaPackingSequence: order.packing?.areaPackingSequence ?? (order.packing as any)?.packingSequence ?? null,
                areaColorVariant: area?.colorVariant ?? 'secondary',
                areaDisplayName: area?.displayName ?? 'Unassigned',
                areaSortOrder: area?.sortOrder ?? 999,
                deliverySequence: order.delivery?.deliverySequence ?? null,
                status: order.status,
                packedItemsCount: order.packing?.packedItems?.length ?? 0,
                totalItemsCount: order.items.length,
                // Partial progress fields
                isPaused: !!order.packing?.pausedAt,
                lastPackedBy: order.packing?.lastPackedBy ?? null,
                lastPackedAt: order.packing?.lastPackedAt ?? null,
                // Auto-merge fields
                internalNotes: order.internalNotes ?? null,
                mergedFromOrderNumbers,
              };
            }),
            productSummary,
            routeOptimization: routeOptimization
              ? {
                  id: routeOptimization.id,
                  optimizedAt: routeOptimization.optimizedAt,
                  totalDistance: routeOptimization.totalDistance,
                  totalDuration: routeOptimization.totalDuration,
                  needsReoptimization: false,
                  autoOptimized: true,
                }
              : null,
            areaLocks,
          };
        } catch (error) {
          // If auto-optimization fails, continue with existing data
          console.error("Auto route optimization failed:", error);
        }
      }

      // Fetch area colors for mapping
      const areas = await prisma.area.findMany({
        where: { isActive: true },
        select: { name: true, displayName: true, colorVariant: true, sortOrder: true },
      });
      const areaMap = new Map(areas.map(a => [a.name, a]));

      // Sort orders by area sort order, then by per-area packing sequence
      const areaOrderMap = new Map(areas.map(a => [a.name, a.sortOrder]));
      const sortedOrders = [...orders].sort((a, b) => {
        // First sort by area sortOrder (nulls/unassigned last)
        const areaA = a.deliveryAddress.areaName;
        const areaB = b.deliveryAddress.areaName;
        const sortA = areaA ? (areaOrderMap.get(areaA) ?? 999) : 9999;
        const sortB = areaB ? (areaOrderMap.get(areaB) ?? 999) : 9999;
        if (sortA !== sortB) return sortA - sortB;

        // Then by per-area packing sequence
        const seqA = a.packing?.areaPackingSequence ?? 999;
        const seqB = b.packing?.areaPackingSequence ?? 999;
        return seqA - seqB;
      });

      return {
        deliveryDate,
        orders: sortedOrders.map((order) => {
          const areaName = order.deliveryAddress.areaName ?? 'unassigned';
          const area = areaMap.get(areaName);
          const mergedFromOrderNumbers = (order.mergedFromOrderIds ?? [])
            .map((id) => absorbedNumberById.get(id))
            .filter((n): n is string => Boolean(n));
          return {
            orderId: order.id,
            orderNumber: order.orderNumber,
            customerName: order.customer?.businessName ?? "Unknown Customer",
            areaName: order.deliveryAddress.areaName,
            areaPackingSequence: order.packing?.areaPackingSequence ?? (order.packing as any)?.packingSequence ?? null,
            areaColorVariant: area?.colorVariant ?? 'secondary',
            areaDisplayName: area?.displayName ?? 'Unassigned',
            deliverySequence: order.delivery?.deliverySequence ?? null,
            status: order.status,
            packedItemsCount: order.packing?.packedItems?.length ?? 0,
            totalItemsCount: order.items.length,
            // Partial progress fields
            isPaused: !!order.packing?.pausedAt,
            lastPackedBy: order.packing?.lastPackedBy ?? null,
            lastPackedAt: order.packing?.lastPackedAt ?? null,
            // Auto-merge fields
            internalNotes: order.internalNotes ?? null,
            mergedFromOrderNumbers,
          };
        }),
        productSummary,
        routeOptimization: routeOptimization
          ? {
              id: routeOptimization.id,
              optimizedAt: routeOptimization.optimizedAt,
              totalDistance: routeOptimization.totalDistance,
              totalDuration: routeOptimization.totalDuration,
              needsReoptimization,
              autoOptimized: routeAutoOptimized,
            }
          : null,
        areaLocks,
      };
    }),

  /**
   * Manually reorder the packing sequence within an area.
   * Locks the area so subsequent auto-optimization runs leave it alone.
   */
  reorderArea: requirePermission('packing:manage')
    .input(
      z.object({
        deliveryDate: z.string().datetime(),
        areaId: z.string(),
        orderIdsInOrder: z.array(z.string()).min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const deliveryDate = new Date(input.deliveryDate);
      const { start: startOfDay, end: endOfDay } = getUTCDayRangeForMelbourneDay(deliveryDate);

      const userDetails = await getUserDetails(ctx.userId ?? null);
      const now = new Date();

      return prisma.$transaction(async (tx) => {
        const orders = await tx.order.findMany({
          where: {
            id: { in: input.orderIdsInOrder },
            requestedDeliveryDate: { gte: startOfDay, lt: endOfDay },
            status: { in: ['confirmed', 'packing'] },
            deliveryAddress: { is: { areaId: input.areaId } },
          },
          select: { id: true, status: true, packing: true },
        });

        if (orders.length !== input.orderIdsInOrder.length) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'Some orders no longer match the selected area or have already moved past packing. Please refresh and try again.',
          });
        }

        const orderById = new Map(orders.map((o) => [o.id, o]));

        for (let i = 0; i < input.orderIdsInOrder.length; i++) {
          const orderId = input.orderIdsInOrder[i];
          const newSeq = i + 1;
          const order = orderById.get(orderId)!;

          await tx.order.update({
            where: { id: orderId },
            data: {
              packing: {
                ...(order.packing ?? { packedItems: [] }),
                areaPackingSequence: newSeq,
                packedItems: order.packing?.packedItems ?? [],
              },
              statusHistory: {
                push: {
                  status: order.status,
                  changedAt: now,
                  changedBy: ctx.userId ?? 'system',
                  changedByName: userDetails.changedByName,
                  changedByEmail: userDetails.changedByEmail,
                  notes: `Packing sequence manually set to position ${newSeq}`,
                },
              },
            },
          });
        }

        const existingLock = await tx.routeOptimization.findFirst({
          where: {
            deliveryDate: { gte: startOfDay, lt: endOfDay },
            areaId: input.areaId,
            routeType: 'packing',
          },
        });

        if (existingLock) {
          await tx.routeOptimization.update({
            where: { id: existingLock.id },
            data: {
              manuallyLocked: true,
              manuallyLockedAt: now,
              manuallyLockedBy: ctx.userId ?? null,
            },
          });
        } else {
          await tx.routeOptimization.create({
            data: {
              deliveryDate: startOfDay,
              routeType: 'packing',
              areaId: input.areaId,
              orderCount: input.orderIdsInOrder.length,
              totalDistance: 0,
              totalDuration: 0,
              routeGeometry: '{}',
              waypoints: [],
              optimizedAt: now,
              optimizedBy: ctx.userId ?? 'system',
              manuallyLocked: true,
              manuallyLockedAt: now,
              manuallyLockedBy: ctx.userId ?? null,
            },
          });
        }

        return { updatedCount: input.orderIdsInOrder.length };
      });
    }),

  /**
   * Clear the manual lock on an area's packing sequence so auto-optimization
   * can re-run on the next refetch.
   */
  resetAreaToOptimized: requirePermission('packing:manage')
    .input(
      z.object({
        deliveryDate: z.string().datetime(),
        areaId: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const deliveryDate = new Date(input.deliveryDate);
      const { start: startOfDay, end: endOfDay } = getUTCDayRangeForMelbourneDay(deliveryDate);

      const lockRecord = await prisma.routeOptimization.findFirst({
        where: {
          deliveryDate: { gte: startOfDay, lt: endOfDay },
          areaId: input.areaId,
          routeType: 'packing',
        },
      });

      if (lockRecord) {
        await prisma.routeOptimization.update({
          where: { id: lockRecord.id },
          data: {
            manuallyLocked: false,
            manuallyLockedAt: null,
            manuallyLockedBy: null,
          },
        });
      }

      const multiArea = await prisma.routeOptimization.findFirst({
        where: {
          deliveryDate: { gte: startOfDay, lt: endOfDay },
          areaId: null,
          routeType: 'packing',
        },
        orderBy: { optimizedAt: 'desc' },
      });

      if (multiArea) {
        await prisma.routeOptimization.update({
          where: { id: multiArea.id },
          data: { needsReoptimization: true },
        });
      }

      return { ok: true };
    }),

  /**
   * Get route optimization status for a date
   */
  getRouteStatus: requirePermission('packing:view')
    .input(
      z.object({
        deliveryDate: z.string().datetime(),
      })
    )
    .query(async ({ input }) => {
      const deliveryDate = new Date(input.deliveryDate);
      const routeOptimization = await getRouteOptimization(deliveryDate);
      const needsReoptimization = await checkIfRouteNeedsReoptimization(deliveryDate);

      return {
        isOptimized: !!routeOptimization,
        needsReoptimization,
        routeOptimization: routeOptimization
          ? {
              id: routeOptimization.id,
              optimizedAt: routeOptimization.optimizedAt,
              optimizedBy: routeOptimization.optimizedBy,
              totalDistance: routeOptimization.totalDistance,
              totalDuration: routeOptimization.totalDuration,
              orderCount: routeOptimization.orderCount,
            }
          : null,
      };
    }),
});
