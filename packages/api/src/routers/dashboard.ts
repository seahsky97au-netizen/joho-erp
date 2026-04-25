import { z } from 'zod';
import { router, requirePermission } from '../trpc';
import { prisma } from '@joho-erp/database';
import { formatDateForMelbourne } from '@joho-erp/shared';

export const dashboardRouter = router({
  // Get dashboard statistics
  getStats: requirePermission('dashboard:view').query(async () => {
    const [totalOrders, pendingOrders, totalCustomers, activeDeliveries, lowStockCount] = await Promise.all([
      // Total orders count (exclude merged — absorbed into primary at packing time)
      prisma.order.count({
        where: { status: { not: 'merged' } },
      }),

      // Active orders count (awaiting approval or confirmed)
      prisma.order.count({
        where: {
          status: { in: ['awaiting_approval', 'confirmed'] },
        },
      }),

      // Active customers count
      prisma.customer.count({
        where: { status: 'active' },
      }),

      // Active deliveries count
      prisma.order.count({
        where: {
          status: 'ready_for_delivery',
        },
      }),

      // Low stock count using raw aggregation
      // Note: Prisma doesn't support field comparison directly, so we use $queryRaw
      prisma.product.aggregateRaw({
        pipeline: [
          {
            $match: {
              status: 'active',
              lowStockThreshold: { $exists: true, $ne: null },
            },
          },
          {
            $match: {
              $expr: { $lte: ['$currentStock', '$lowStockThreshold'] },
            },
          },
          { $count: 'count' },
        ],
      }).then((result: any) => {
        const data = result as Array<{ count: number }>;
        return data[0]?.count || 0;
      }),
    ]);

    return {
      totalOrders,
      pendingOrders,
      totalCustomers,
      activeDeliveries,
      lowStockCount,
    };
  }),

  // Get recent orders
  getRecentOrders: requirePermission('dashboard:view')
    .input(z.object({ limit: z.number().default(10) }))
    .query(async ({ input }) => {
      const orders = await prisma.order.findMany({
        take: input.limit,
        where: { status: { not: 'merged' } },
        orderBy: { orderedAt: 'desc' },
        select: {
          id: true,
          orderNumber: true,
          customerName: true,
          totalAmount: true,
          status: true,
          orderedAt: true,
        },
      });

      return orders;
    }),

  // Get low stock items
  getLowStockItems: requirePermission('dashboard:view')
    .input(z.object({ limit: z.number().default(10) }))
    .query(async ({ input }) => {
      // Using raw aggregation for field comparison
      const products = await prisma.product.aggregateRaw({
        pipeline: [
          {
            $match: {
              status: 'active',
              lowStockThreshold: { $exists: true, $ne: null },
            },
          },
          {
            $match: {
              $expr: { $lte: ['$currentStock', '$lowStockThreshold'] },
            },
          },
          { $sort: { currentStock: 1 } },
          { $limit: input.limit },
          {
            $project: {
              id: { $toString: '$_id' },
              name: 1,
              sku: 1,
              currentStock: 1,
              lowStockThreshold: 1,
              unit: 1,
            },
          },
        ],
      });

      return products as unknown as Array<{
        id: string;
        name: string;
        sku: string;
        currentStock: number;
        lowStockThreshold: number;
        unit: string;
      }>;
    }),

  // Get expiring stock items for dashboard alert
  getExpiringStock: requirePermission('dashboard:view').query(async () => {
    // Get company inventory settings for threshold
    const company = await prisma.company.findFirst({
      select: {
        inventorySettings: true,
      },
    });

    const daysThreshold = company?.inventorySettings?.expiryAlertDays || 7;
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() + daysThreshold);
    const now = new Date();

    // Find all batches that are expired or expiring within threshold
    const batches = await prisma.inventoryBatch.findMany({
      where: {
        expiryDate: {
          not: null,
          lte: thresholdDate, // Include both expired and expiring soon
        },
        isConsumed: false,
        quantityRemaining: { gt: 0 },
      },
      include: {
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            unit: true,
            category: true,
          },
        },
      },
      orderBy: { expiryDate: 'asc' }, // Soonest expiry first
      take: 10, // Limit to 10 for dashboard display
    });

    // Enrich batches with computed fields
    const enrichedBatches = batches.map((batch) => {
      const daysUntilExpiry = batch.expiryDate
        ? Math.ceil((batch.expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        : null;
      const isExpired = batch.expiryDate ? batch.expiryDate < now : false;

      return {
        id: batch.id,
        productId: batch.product.id,
        productName: batch.product.name,
        productSku: batch.product.sku,
        productUnit: batch.product.unit,
        productCategory: batch.product.category,
        quantityRemaining: batch.quantityRemaining,
        expiryDate: batch.expiryDate,
        daysUntilExpiry,
        isExpired,
        costPerUnit: batch.costPerUnit,
        totalValue: batch.quantityRemaining * batch.costPerUnit,
      };
    });

    // Separate expired vs expiring soon
    const expiredBatches = enrichedBatches.filter((b) => b.isExpired);
    const expiringSoonBatches = enrichedBatches.filter((b) => !b.isExpired);

    return {
      batches: enrichedBatches,
      summary: {
        totalCount: enrichedBatches.length,
        expiredCount: expiredBatches.length,
        expiringSoonCount: expiringSoonBatches.length,
        totalValue: enrichedBatches.reduce((sum, b) => sum + b.totalValue, 0),
        thresholdDays: daysThreshold,
      },
    };
  }),

  // ============================================================================
  // INVENTORY DASHBOARD ENDPOINTS
  // ============================================================================

  // Get inventory summary statistics
  getInventorySummary: requirePermission('inventory:view').query(async () => {
    const [
      totalProducts,
      outOfStockCount,
      lowStockCountResult,
      inventoryValueResult,
    ] = await Promise.all([
      // Total active products count
      prisma.product.count({
        where: { status: 'active' },
      }),

      // Out of stock count
      prisma.product.count({
        where: {
          status: 'active',
          currentStock: 0,
        },
      }),

      // Low stock count (using raw aggregation for field comparison)
      prisma.product.aggregateRaw({
        pipeline: [
          {
            $match: {
              status: 'active',
              lowStockThreshold: { $exists: true, $ne: null },
              currentStock: { $gt: 0 },
            },
          },
          {
            $match: {
              $expr: { $lte: ['$currentStock', '$lowStockThreshold'] },
            },
          },
          { $count: 'count' },
        ],
      }).then((result: unknown) => {
        const data = result as Array<{ count: number }>;
        return data[0]?.count || 0;
      }),

      // Total inventory value from batch costs (quantityRemaining * costPerUnit, in cents)
      prisma.inventoryBatch.aggregateRaw({
        pipeline: [
          // Join with products to filter active products only
          {
            $lookup: {
              from: 'products',
              localField: 'productId',
              foreignField: '_id',
              as: 'product',
            },
          },
          { $unwind: '$product' },
          // Filter for active products and non-consumed batches
          {
            $match: {
              'product.status': 'active',
              isConsumed: false,
            },
          },
          // Calculate batch value and sum
          {
            $group: {
              _id: null,
              totalValue: {
                $sum: { $multiply: ['$quantityRemaining', '$costPerUnit'] },
              },
            },
          },
        ],
      }).then((result: unknown) => {
        const data = result as Array<{ totalValue: number }>;
        return data[0]?.totalValue || 0;
      }),
    ]);

    return {
      totalProducts,
      outOfStockCount,
      lowStockCount: lowStockCountResult,
      totalValue: inventoryValueResult, // in cents
    };
  }),

  // Get inventory breakdown by category
  getInventoryByCategory: requirePermission('inventory:view').query(async () => {
    // Get category breakdown from inventory batches (correct cost-based value)
    const batchBreakdown = await prisma.inventoryBatch.aggregateRaw({
      pipeline: [
        // Filter non-consumed batches only
        { $match: { isConsumed: false } },
        // Join with products
        {
          $lookup: {
            from: 'products',
            localField: 'productId',
            foreignField: '_id',
            as: 'product',
          },
        },
        { $unwind: '$product' },
        // Filter for active products
        { $match: { 'product.status': 'active' } },
        // Group by category with correct value calculation
        {
          $group: {
            _id: '$product.category',
            products: { $addToSet: '$productId' },
            totalStock: { $sum: '$quantityRemaining' },
            totalValue: { $sum: { $multiply: ['$quantityRemaining', '$costPerUnit'] } },
          },
        },
        {
          $project: {
            category: '$_id',
            productCount: { $size: '$products' },
            totalStock: 1,
            totalValue: 1,
            _id: 0,
          },
        },
        { $sort: { category: 1 } },
      ],
    });

    // Get low stock counts per category from products
    const lowStockByCategory = await prisma.product.aggregateRaw({
      pipeline: [
        { $match: { status: 'active' } },
        {
          $group: {
            _id: '$category',
            lowStockCount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: ['$lowStockThreshold', null] },
                      { $lte: ['$currentStock', '$lowStockThreshold'] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ],
    }) as unknown as Array<{ _id: string; lowStockCount: number }>;

    // Merge lowStockCount into batch breakdown
    const lowStockMap = new Map(lowStockByCategory.map((c) => [c._id, c.lowStockCount]));
    const breakdown = batchBreakdown as unknown as Array<{
      category: string;
      productCount: number;
      totalStock: number;
      totalValue: number;
    }>;

    return breakdown.map((cat) => ({
      ...cat,
      lowStockCount: lowStockMap.get(cat.category) || 0,
    }));
  }),

  // Get inventory transactions with filters
  getInventoryTransactions: requirePermission('inventory:view')
    .input(
      z.object({
        dateFrom: z.date().optional(),
        dateTo: z.date().optional(),
        type: z.enum(['sale', 'adjustment', 'return']).optional(),
        // TODO: Remove 'stock_count_correction' after historical data cleanup — deprecated, no longer used in UI
        adjustmentType: z
          .enum(['stock_received', 'stock_count_correction', 'stock_write_off', 'packing_adjustment', 'processing'])
          .optional(),
        productId: z.string().optional(),
        search: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const { dateFrom, dateTo, type, adjustmentType, productId, search, limit, offset } = input;

      // Build where clause
      const where: Record<string, unknown> = {};

      if (dateFrom || dateTo) {
        where.createdAt = {};
        if (dateFrom) (where.createdAt as Record<string, Date>).gte = dateFrom;
        if (dateTo) (where.createdAt as Record<string, Date>).lte = dateTo;
      }

      if (type) {
        where.type = type;
      }

      if (adjustmentType) {
        where.adjustmentType = adjustmentType;
      }

      if (productId) {
        where.productId = productId;
      }

      // Add search functionality for product name or SKU
      if (search) {
        where.product = {
          is: {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { sku: { contains: search, mode: 'insensitive' } },
            ],
          },
        };
      }

      const [transactions, totalCount] = await Promise.all([
        prisma.inventoryTransaction.findMany({
          where,
          include: {
            product: {
              select: {
                id: true,
                name: true,
                sku: true,
                unit: true,
              },
            },
            batchConsumptions: {
              include: {
                batch: {
                  select: {
                    id: true,
                    batchNumber: true,
                    receivedAt: true,
                    expiryDate: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.inventoryTransaction.count({ where }),
      ]);

      // Fetch related InventoryBatch records for stock_received and processing transactions
      const stockReceivedTxIds = transactions
        .filter((tx) => tx.adjustmentType === 'stock_received' || tx.adjustmentType === 'processing')
        .map((tx) => tx.id);

      const batches =
        stockReceivedTxIds.length > 0
          ? await prisma.inventoryBatch.findMany({
              where: { receiveTransactionId: { in: stockReceivedTxIds } },
              include: { supplier: true },
            })
          : [];

      const batchByTxId = new Map(batches.map((b) => [b.receiveTransactionId, b]));

      return {
        transactions: transactions.map((tx) => ({
          id: tx.id,
          productId: tx.productId,
          productName: tx.product.name,
          productSku: tx.product.sku,
          productUnit: tx.product.unit,
          type: tx.type,
          adjustmentType: tx.adjustmentType,
          quantity: tx.quantity,
          previousStock: tx.previousStock,
          newStock: tx.newStock,
          notes: tx.notes,
          createdBy: tx.createdBy,
          createdAt: tx.createdAt,
          // Additional fields for transaction detail view
          costPerUnit: tx.costPerUnit,
          expiryDate: tx.expiryDate,
          referenceType: tx.referenceType,
          referenceId: tx.referenceId,
          // Batch number from the transaction itself
          batchNumber: tx.batchNumber,
          // Stock receipt fields from InventoryBatch
          stockInDate: batchByTxId.get(tx.id)?.stockInDate ?? null,
          supplierInvoiceNumber: batchByTxId.get(tx.id)?.supplierInvoiceNumber ?? null,
          mtvNumber: batchByTxId.get(tx.id)?.mtvNumber ?? null,
          vehicleTemperature: batchByTxId.get(tx.id)?.vehicleTemperature ?? null,
          supplierId: batchByTxId.get(tx.id)?.supplierId ?? null,
          supplierName: batchByTxId.get(tx.id)?.supplier?.businessName ?? null,
          // Batch consumptions (FIFO tracking)
          batchConsumptions: tx.batchConsumptions.map((bc) => ({
            id: bc.id,
            quantityConsumed: bc.quantityConsumed,
            batchId: bc.batch.id,
            batchNumber: bc.batch.batchNumber,
            batchReceivedAt: bc.batch.receivedAt,
            batchExpiryDate: bc.batch.expiryDate,
          })),
        })),
        totalCount,
        hasMore: offset + transactions.length < totalCount,
      };
    }),


  // ============================================================================
  // NEW DASHBOARD REDESIGN ENDPOINTS
  // ============================================================================

  // Get financial overview with period comparison
  getFinancialOverview: requirePermission('dashboard:view')
    .input(
      z.object({
        period: z.enum(['today', 'week', 'month']).default('today'),
      })
    )
    .query(async ({ input }) => {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      // Calculate date ranges based on period
      let currentStart: Date;
      let currentEnd: Date;
      let previousStart: Date;
      let previousEnd: Date;

      switch (input.period) {
        case 'today':
          currentStart = today;
          currentEnd = new Date(today.getTime() + 24 * 60 * 60 * 1000);
          previousStart = new Date(today.getTime() - 24 * 60 * 60 * 1000);
          previousEnd = today;
          break;
        case 'week':
          // Get start of current week (Monday)
          const dayOfWeek = today.getDay();
          const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
          currentStart = new Date(today.getTime() - daysToMonday * 24 * 60 * 60 * 1000);
          currentEnd = new Date(today.getTime() + 24 * 60 * 60 * 1000);
          previousStart = new Date(currentStart.getTime() - 7 * 24 * 60 * 60 * 1000);
          previousEnd = currentStart;
          break;
        case 'month':
          currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
          currentEnd = new Date(today.getTime() + 24 * 60 * 60 * 1000);
          previousStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          previousEnd = currentStart;
          break;
      }

      // Query revenue for current and previous periods (excluding cancelled orders)
      const [currentRevenue, previousRevenue, pendingPayments] = await Promise.all([
        // Current period revenue
        prisma.order.aggregate({
          where: {
            orderedAt: { gte: currentStart, lt: currentEnd },
            status: { not: 'cancelled' },
          },
          _sum: { totalAmount: true },
          _count: true,
        }),

        // Previous period revenue for comparison
        prisma.order.aggregate({
          where: {
            orderedAt: { gte: previousStart, lt: previousEnd },
            status: { not: 'cancelled' },
          },
          _sum: { totalAmount: true },
        }),

        // Pending payments (orders that are delivered but not yet paid - assuming no payment tracking, we'll use delivered orders)
        // For now, count orders delivered in last 30 days as proxy for pending AR
        prisma.order.aggregate({
          where: {
            status: 'delivered',
            updatedAt: { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) },
          },
          _sum: { totalAmount: true },
          _count: true,
        }),
      ]);

      const current = currentRevenue._sum.totalAmount || 0;
      const previous = previousRevenue._sum.totalAmount || 0;
      const percentChange = previous > 0 ? Math.round(((current - previous) / previous) * 100) : 0;

      return {
        revenue: current, // in cents
        previousRevenue: previous, // in cents
        percentChange,
        orderCount: currentRevenue._count,
        pendingPayments: pendingPayments._sum.totalAmount || 0, // in cents
        pendingPaymentsCount: pendingPayments._count,
        period: input.period,
      };
    }),

  // Get order status counts for status cards
  getOrderStatusCounts: requirePermission('dashboard:view').query(async () => {
    const counts = await prisma.order.groupBy({
      by: ['status'],
      _count: true,
    });

    // Map to dashboard categories
    const statusMap: Record<string, number> = {
      awaitingApproval: 0, // Only awaiting_approval orders
      pending: 0, // awaiting_approval + confirmed (for backward compatibility)
      ready: 0,
      delivering: 0,
      completed: 0,
    };

    counts.forEach((item) => {
      switch (item.status) {
        case 'awaiting_approval':
          statusMap.awaitingApproval += item._count;
          statusMap.pending += item._count;
          break;
        case 'confirmed':
          statusMap.pending += item._count;
          break;
        case 'packing':
        case 'ready_for_delivery':
          statusMap.ready += item._count;
          break;
        case 'out_for_delivery':
          statusMap.delivering += item._count;
          break;
        case 'delivered':
          statusMap.completed += item._count;
          break;
        // cancelled orders are excluded
      }
    });

    return statusMap;
  }),

  // Get count of customers with pending credit applications
  getPendingCreditCount: requirePermission('dashboard:view').query(async () => {
    const count = await prisma.customer.count({
      where: {
        creditApplication: {
          is: { status: 'pending' },
        },
      },
    });

    return count;
  }),

  // Get daily revenue trend for chart
  getRevenueTrend: requirePermission('dashboard:view')
    .input(
      z.object({
        days: z.number().min(7).max(90).default(7),
      })
    )
    .query(async ({ input }) => {
      const now = new Date();
      const startDate = new Date(now.getTime() - input.days * 24 * 60 * 60 * 1000);

      // Use MongoDB aggregation to group by date
      const result = await prisma.order.aggregateRaw({
        pipeline: [
          {
            $match: {
              orderedAt: { $gte: { $date: startDate.toISOString() } },
              status: { $ne: 'cancelled' },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: { format: '%Y-%m-%d', date: '$orderedAt' },
              },
              revenue: { $sum: '$totalAmount' },
              orderCount: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],
      });

      // Fill in missing dates with zero revenue
      const trendData: Array<{ date: string; revenue: number; orderCount: number }> = [];
      const resultMap = new Map(
        (result as unknown as Array<{ _id: string; revenue: number; orderCount: number }>).map(
          (item) => [item._id, item]
        )
      );

      for (let i = 0; i < input.days; i++) {
        const date = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
        const dateStr = formatDateForMelbourne(date);
        const existing = resultMap.get(dateStr);
        trendData.push({
          date: dateStr,
          revenue: existing?.revenue || 0,
          orderCount: existing?.orderCount || 0,
        });
      }

      return trendData;
    }),

  // Get inventory health summary
  getInventoryHealth: requirePermission('dashboard:view').query(async () => {
    // Get company inventory settings for expiry threshold
    const company = await prisma.company.findFirst({
      select: { inventorySettings: true },
    });
    const expiryDays = company?.inventorySettings?.expiryAlertDays || 7;
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() + expiryDays);

    const [totalProducts, healthyCount, lowStockCount, outOfStockCount, expiringCount] =
      await Promise.all([
        // Total active products
        prisma.product.count({ where: { status: 'active' } }),

        // Healthy stock (above threshold)
        prisma.product.aggregateRaw({
          pipeline: [
            {
              $match: {
                status: 'active',
                lowStockThreshold: { $exists: true, $ne: null },
                currentStock: { $gt: 0 },
              },
            },
            {
              $match: {
                $expr: { $gt: ['$currentStock', '$lowStockThreshold'] },
              },
            },
            { $count: 'count' },
          ],
        }).then((res: unknown) => {
          const data = res as Array<{ count: number }>;
          return data[0]?.count || 0;
        }),

        // Low stock count (at or below threshold but not zero)
        prisma.product.aggregateRaw({
          pipeline: [
            {
              $match: {
                status: 'active',
                lowStockThreshold: { $exists: true, $ne: null },
                currentStock: { $gt: 0 },
              },
            },
            {
              $match: {
                $expr: { $lte: ['$currentStock', '$lowStockThreshold'] },
              },
            },
            { $count: 'count' },
          ],
        }).then((res: unknown) => {
          const data = res as Array<{ count: number }>;
          return data[0]?.count || 0;
        }),

        // Out of stock count
        prisma.product.count({
          where: { status: 'active', currentStock: 0 },
        }),

        // Expiring inventory batches count
        prisma.inventoryBatch.count({
          where: {
            expiryDate: { not: null, lte: thresholdDate },
            isConsumed: false,
            quantityRemaining: { gt: 0 },
          },
        }),
      ]);

    // Calculate health percentage (healthy products / total products with threshold)
    const productsWithThreshold = healthyCount + lowStockCount;
    const healthPercentage =
      productsWithThreshold > 0 ? Math.round((healthyCount / productsWithThreshold) * 100) : 100;

    return {
      healthPercentage,
      totalProducts,
      healthyCount,
      lowStockCount,
      outOfStockCount,
      expiringCount,
      expiryThresholdDays: expiryDays,
    };
  }),
});
