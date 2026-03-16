import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, requirePermission } from '../trpc';
import { prisma } from '@joho-erp/database';
import { createMoney, multiplyMoney, sumMoney, toCents, formatDateForMelbourne } from '@joho-erp/shared';

const COMPARISON_TYPES = ['week_over_week', 'month_over_month'] as const;

/**
 * Calculate the total value of an inventory batch using dinero.js for precision
 * @param batch - Batch with quantityRemaining and costPerUnit (in cents)
 * @returns Total value in cents
 */
function calculateBatchValue(batch: { quantityRemaining: number; costPerUnit: number }): number {
  const costMoney = createMoney(batch.costPerUnit);
  const totalMoney = multiplyMoney(costMoney, batch.quantityRemaining);
  return toCents(totalMoney);
}

/**
 * Calculate the total value of multiple inventory batches
 * @param batches - Array of batches with quantityRemaining and costPerUnit
 * @returns Total value in cents
 */
function calculateTotalBatchValue(
  batches: Array<{ quantityRemaining: number; costPerUnit: number }>
): number {
  const values = batches.map((batch) => createMoney(calculateBatchValue(batch)));
  return toCents(sumMoney(values));
}

// Helper to calculate date range based on comparison type
function getComparisonDateRange(comparisonType: (typeof COMPARISON_TYPES)[number]) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (comparisonType === 'week_over_week') {
    const startOfThisWeek = new Date(startOfToday);
    startOfThisWeek.setDate(startOfToday.getDate() - startOfToday.getDay());

    const startOfLastWeek = new Date(startOfThisWeek);
    startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);

    return {
      currentStart: startOfThisWeek,
      currentEnd: now,
      previousStart: startOfLastWeek,
      previousEnd: startOfThisWeek,
    };
  } else {
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    return {
      currentStart: startOfThisMonth,
      currentEnd: now,
      previousStart: startOfLastMonth,
      previousEnd: startOfThisMonth,
    };
  }
}

export const inventoryRouter = router({
  export: router({
    // Single endpoint to get all export data based on tab
    getData: requirePermission('inventory:export')
      .input(
        z.object({
          tab: z.enum(['overview', 'trends', 'turnover', 'comparison']),
          useCurrentFilters: z.boolean(),
          filters: z
            .object({
              transactionType: z.enum(['sale', 'adjustment', 'return']).optional(),
              productSearch: z.string().optional(),
              granularity: z.enum(['daily', 'weekly', 'monthly']).optional(),
              comparisonType: z.enum(COMPARISON_TYPES).optional(),
            })
            .optional(),
        })
      )
      .query(async ({ input }) => {
        const { tab, useCurrentFilters, filters } = input;

        switch (tab) {
          case 'overview': {
            // Get inventory summary
            const [totalProducts, lowStockCount, outOfStockCount] = await Promise.all([
              prisma.product.count({ where: { status: 'active' } }),
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
              prisma.product.count({
                where: { status: 'active', currentStock: 0 },
              }),
            ]);

            // Calculate total inventory value from batch costs
            const batches = await prisma.inventoryBatch.findMany({
              where: {
                isConsumed: false,
                product: { status: 'active' },
              },
              select: {
                quantityRemaining: true,
                costPerUnit: true,
              },
            });

            const totalValue = calculateTotalBatchValue(batches);

            // Get category breakdown
            const categories = await prisma.category.findMany({
              where: { isActive: true },
              include: {
                products: {
                  where: { status: 'active' },
                  select: {
                    id: true,
                    currentStock: true,
                    lowStockThreshold: true,
                  },
                },
              },
            });

            // Get batch values for all products
            const productIds = categories.flatMap((cat) =>
              cat.products.map((p) => p.id)
            );

            const categoryBatches = await prisma.inventoryBatch.findMany({
              where: {
                productId: { in: productIds },
                isConsumed: false,
              },
              select: {
                productId: true,
                quantityRemaining: true,
                costPerUnit: true,
              },
            });

            // Group batch values by product
            const batchValuesByProduct = new Map<string, number>();
            categoryBatches.forEach((batch) => {
              const currentValue = batchValuesByProduct.get(batch.productId) || 0;
              batchValuesByProduct.set(
                batch.productId,
                currentValue + calculateBatchValue(batch)
              );
            });

            const categoryBreakdown = categories.map((cat) => {
              const categoryValue = cat.products.reduce(
                (sum, p) => sum + (batchValuesByProduct.get(p.id) || 0),
                0
              );

              return {
                name: cat.name,
                productCount: cat.products.length,
                totalStock: cat.products.reduce((sum, p) => sum + p.currentStock, 0),
                totalValue: categoryValue,
                lowStockCount: cat.products.filter(
                  (p) => p.lowStockThreshold && p.currentStock <= p.lowStockThreshold
                ).length,
              };
            });

            // Get transactions with filters
            const transactionWhere: any = {};
            if (useCurrentFilters && filters?.transactionType) {
              transactionWhere.type = filters.transactionType;
            }
            if (useCurrentFilters && filters?.productSearch) {
              transactionWhere.product = {
                OR: [
                  { name: { contains: filters.productSearch, mode: 'insensitive' } },
                  { sku: { contains: filters.productSearch, mode: 'insensitive' } },
                ],
              };
            }

            const transactions = await prisma.inventoryTransaction.findMany({
              where: transactionWhere,
              take: useCurrentFilters ? 100 : 1000,
              orderBy: { createdAt: 'desc' },
              include: {
                product: {
                  select: { sku: true, name: true, unit: true },
                },
              },
            });

            return {
              summary: {
                totalValue,
                totalProducts,
                lowStockCount,
                outOfStockCount,
              },
              categories: categoryBreakdown,
              transactions: transactions.map((tx) => ({
                id: tx.id,
                createdAt: tx.createdAt,
                product: tx.product,
                type: tx.type,
                adjustmentType: tx.adjustmentType,
                quantity: tx.quantity,
                previousStock: tx.previousStock,
                newStock: tx.newStock,
                notes: tx.notes,
              })),
            };
          }

          case 'trends': {
            const granularity = filters?.granularity || 'daily';

            // Get date boundaries
            const now = new Date();
            let startDate: Date;
            switch (granularity) {
              case 'daily':
                startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                break;
              case 'weekly':
                startDate = new Date(now.getTime() - 84 * 24 * 60 * 60 * 1000);
                break;
              case 'monthly':
                startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
                break;
            }

            // Get stock movement data (already aggregated)
            const dateGroupExpression =
              granularity === 'daily'
                ? {
                    year: { $year: '$createdAt' },
                    month: { $month: '$createdAt' },
                    day: { $dayOfMonth: '$createdAt' },
                  }
                : granularity === 'weekly'
                  ? {
                      year: { $isoWeekYear: '$createdAt' },
                      week: { $isoWeek: '$createdAt' },
                    }
                  : {
                      year: { $year: '$createdAt' },
                      month: { $month: '$createdAt' },
                    };

            const stockMovementData = (await prisma.inventoryTransaction.aggregateRaw({
              pipeline: [
                {
                  $match: {
                    createdAt: { $gte: { $date: startDate.toISOString() } },
                  },
                },
                {
                  $group: {
                    _id: dateGroupExpression,
                    positiveQuantity: {
                      $sum: {
                        $cond: [{ $gt: ['$quantity', 0] }, '$quantity', 0],
                      },
                    },
                    negativeQuantity: {
                      $sum: {
                        $cond: [{ $lt: ['$quantity', 0] }, { $abs: '$quantity' }, 0],
                      },
                    },
                  },
                },
                {
                  $sort: {
                    '_id.year': 1,
                    '_id.month': 1,
                    '_id.week': 1,
                    '_id.day': 1,
                  },
                },
              ],
            })) as unknown as Array<{
              _id: { year: number; month: number; day?: number; week?: number };
              positiveQuantity: number;
              negativeQuantity: number;
            }>;

            // Format stock movement
            const stockMovement = stockMovementData.map((item) => {
              let period: string;
              if (granularity === 'daily') {
                period = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`;
              } else if (granularity === 'weekly') {
                period = `W${item._id.week} ${item._id.year}`;
              } else {
                const months = [
                  'Jan',
                  'Feb',
                  'Mar',
                  'Apr',
                  'May',
                  'Jun',
                  'Jul',
                  'Aug',
                  'Sep',
                  'Oct',
                  'Nov',
                  'Dec',
                ];
                period = `${months[(item._id.month || 1) - 1]} ${item._id.year}`;
              }
              return {
                period,
                stockIn: Math.round(item.positiveQuantity * 10) / 10,
                stockOut: Math.round(item.negativeQuantity * 10) / 10,
              };
            });

            // Get inventory value history from batch costs
            // For export, we'll use batch-based calculation
            const trendsBatches = await prisma.inventoryBatch.findMany({
              where: {
                isConsumed: false,
                product: { status: 'active' },
              },
              select: {
                quantityRemaining: true,
                costPerUnit: true,
              },
            });

            const currentTotalValue = calculateTotalBatchValue(trendsBatches);

            const inventoryValue = [
              {
                period: formatDateForMelbourne(new Date()),
                totalValue: currentTotalValue,
              },
            ];

            return {
              stockMovement,
              inventoryValue,
              granularity,
            };
          }

          case 'turnover': {
            const granularity = filters?.granularity || 'daily';

            // Get date range
            const now = new Date();
            let startDate: Date;
            let daysInPeriod: number;
            switch (granularity) {
              case 'daily':
                startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                daysInPeriod = 30;
                break;
              case 'weekly':
                startDate = new Date(now.getTime() - 84 * 24 * 60 * 60 * 1000);
                daysInPeriod = 84;
                break;
              case 'monthly':
                startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
                daysInPeriod = 365;
                break;
            }

            // Get sales data aggregated by product
            const salesData = (await prisma.inventoryTransaction.aggregateRaw({
              pipeline: [
                {
                  $match: {
                    type: 'sale',
                    createdAt: { $gte: { $date: startDate.toISOString() } },
                  },
                },
                {
                  $group: {
                    _id: '$productId',
                    totalSold: { $sum: { $abs: '$quantity' } },
                    transactionCount: { $sum: 1 },
                  },
                },
                {
                  $sort: { totalSold: -1 },
                },
                {
                  $limit: useCurrentFilters ? 50 : 100,
                },
              ],
            })) as unknown as Array<{
              _id: { $oid: string };
              totalSold: number;
              transactionCount: number;
            }>;

            // Enrich with product details
            const productIds = salesData.map((item) => item._id.$oid);
            const products = await prisma.product.findMany({
              where: { id: { in: productIds } },
              select: {
                id: true,
                sku: true,
                name: true,
                currentStock: true,
                unit: true,
              },
            });

            const productMap = new Map(products.map((p) => [p.id, p]));

            const turnoverMetrics = salesData
              .map((item) => {
                const product = productMap.get(item._id.$oid);
                if (!product) return null;

                const totalSold = item.totalSold;
                const velocity = totalSold / daysInPeriod;
                const daysOnHand = velocity > 0 ? product.currentStock / velocity : 9999;

                return {
                  productId: product.id,
                  sku: product.sku,
                  name: product.name,
                  unit: product.unit,
                  currentStock: product.currentStock,
                  totalSold,
                  transactionCount: item.transactionCount,
                  velocity: Math.round(velocity * 100) / 100,
                  daysOnHand: Math.round(daysOnHand),
                };
              })
              .filter((item) => item !== null);

            return {
              metrics: turnoverMetrics,
              granularity,
              periodDays: daysInPeriod,
            };
          }

          case 'comparison': {
            const comparisonType = filters?.comparisonType || 'week_over_week';
            const { currentStart, currentEnd, previousStart, previousEnd } =
              getComparisonDateRange(comparisonType);

            // Get transaction metrics for both periods
            const [currentMetrics, previousMetrics] = await Promise.all([
              prisma.inventoryTransaction.aggregateRaw({
                pipeline: [
                  {
                    $match: {
                      createdAt: {
                        $gte: { $date: currentStart.toISOString() },
                        $lte: { $date: currentEnd.toISOString() },
                      },
                    },
                  },
                  {
                    $group: {
                      _id: null,
                      stockIn: {
                        $sum: {
                          $cond: [{ $gt: ['$quantity', 0] }, '$quantity', 0],
                        },
                      },
                      stockOut: {
                        $sum: {
                          $cond: [{ $lt: ['$quantity', 0] }, { $abs: '$quantity' }, 0],
                        },
                      },
                      transactions: { $sum: 1 },
                    },
                  },
                ],
              }),
              prisma.inventoryTransaction.aggregateRaw({
                pipeline: [
                  {
                    $match: {
                      createdAt: {
                        $gte: { $date: previousStart.toISOString() },
                        $lt: { $date: previousEnd.toISOString() },
                      },
                    },
                  },
                  {
                    $group: {
                      _id: null,
                      stockIn: {
                        $sum: {
                          $cond: [{ $gt: ['$quantity', 0] }, '$quantity', 0],
                        },
                      },
                      stockOut: {
                        $sum: {
                          $cond: [{ $lt: ['$quantity', 0] }, { $abs: '$quantity' }, 0],
                        },
                      },
                      transactions: { $sum: 1 },
                    },
                  },
                ],
              }),
            ]);

            const current = (currentMetrics as any)[0] || { stockIn: 0, stockOut: 0, transactions: 0 };
            const previous = (previousMetrics as any)[0] || { stockIn: 0, stockOut: 0, transactions: 0 };

            const calculateChange = (curr: number, prev: number) => {
              if (prev === 0) return curr > 0 ? 100 : 0;
              return ((curr - prev) / prev) * 100;
            };

            return {
              comparisonType,
              stockIn: {
                current: Math.round(current.stockIn * 10) / 10,
                previous: Math.round(previous.stockIn * 10) / 10,
                change: calculateChange(current.stockIn, previous.stockIn),
              },
              stockOut: {
                current: Math.round(current.stockOut * 10) / 10,
                previous: Math.round(previous.stockOut * 10) / 10,
                change: calculateChange(current.stockOut, previous.stockOut),
              },
              transactions: {
                current: current.transactions,
                previous: previous.transactions,
                change: calculateChange(current.transactions, previous.transactions),
              },
              netMovement: {
                current: Math.round((current.stockIn - current.stockOut) * 10) / 10,
                previous: Math.round((previous.stockIn - previous.stockOut) * 10) / 10,
                change: calculateChange(
                  current.stockIn - current.stockOut,
                  previous.stockIn - previous.stockOut
                ),
              },
            };
          }

          default:
            throw new Error('Invalid tab');
        }
      }),
  }),

  /**
   * Get batches expiring soon (within X days)
   */
  getExpiringBatches: requirePermission('inventory:view')
    .input(
      z.object({
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().positive().max(100).default(25),
        sortBy: z.enum(['expiryDate', 'value', 'productName', 'quantity', 'batchNumber']).default('expiryDate'),
        sortDirection: z.enum(['asc', 'desc']).default('asc'),
        statusFilter: z.enum(['all', 'expired', 'expiringSoon']).default('all'),
        categoryId: z.string().optional(),
        supplierId: z.string().optional(),
        search: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const { page, pageSize, sortBy, sortDirection, statusFilter, categoryId, supplierId, search } = input;

      // Get company inventory settings for threshold
      const company = await prisma.company.findFirst({
        select: { inventorySettings: true },
      });
      const daysThreshold = company?.inventorySettings?.expiryAlertDays || 7;

      const thresholdDate = new Date();
      thresholdDate.setDate(thresholdDate.getDate() + daysThreshold);
      const now = new Date();

      // Build where clause
      const where: any = {
        expiryDate: { not: null },
        isConsumed: false,
        quantityRemaining: { gt: 0 },
      };

      // Apply status filter
      if (statusFilter === 'expired') {
        where.expiryDate.lt = now;
      } else if (statusFilter === 'expiringSoon') {
        where.AND = [
          { expiryDate: { gte: now } },
          { expiryDate: { lte: thresholdDate } },
        ];
      } else {
        // 'all' - include both expired and expiring soon
        where.expiryDate.lte = thresholdDate;
      }

      // Apply category filter
      if (categoryId) {
        where.product = { ...where.product, categoryId };
      }

      // Apply supplier filter
      if (supplierId) {
        where.supplierId = supplierId;
      }

      // Apply search filter
      if (search) {
        where.OR = [
          { product: { name: { contains: search, mode: 'insensitive' } } },
          { product: { sku: { contains: search, mode: 'insensitive' } } },
          { batchNumber: { contains: search, mode: 'insensitive' } },
        ];
      }

      // Build orderBy based on sortBy
      let orderBy: any;
      switch (sortBy) {
        case 'productName':
          orderBy = { product: { name: sortDirection } };
          break;
        case 'quantity':
          orderBy = { quantityRemaining: sortDirection };
          break;
        case 'value':
          // For value sorting, we'll sort in-memory since it's a computed field
          orderBy = { expiryDate: 'asc' };
          break;
        case 'batchNumber':
          orderBy = { batchNumber: sortDirection };
          break;
        case 'expiryDate':
        default:
          orderBy = { expiryDate: sortDirection };
          break;
      }

      // Get total count for pagination
      const totalCount = await prisma.inventoryBatch.count({ where });

      // Get batches with pagination
      const batches = await prisma.inventoryBatch.findMany({
        where,
        include: {
          product: {
            select: {
              id: true,
              sku: true,
              name: true,
              unit: true,
              category: true,
              categoryId: true,
            },
          },
          supplier: {
            select: {
              id: true,
              businessName: true,
            },
          },
        },
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      });

      // Enrich batches with computed fields
      let enrichedBatches = batches.map((batch) => ({
        ...batch,
        daysUntilExpiry: batch.expiryDate
          ? Math.ceil((batch.expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
          : null,
        isExpired: batch.expiryDate ? batch.expiryDate < now : false,
        totalValue: calculateBatchValue(batch),
      }));

      // Sort by value in-memory if that's the sort field
      if (sortBy === 'value') {
        enrichedBatches.sort((a, b) => {
          const diff = a.totalValue - b.totalValue;
          return sortDirection === 'desc' ? -diff : diff;
        });
      }

      // Calculate summary for all matching batches (not just current page)
      const allBatches = await prisma.inventoryBatch.findMany({
        where,
        select: { quantityRemaining: true, costPerUnit: true, expiryDate: true },
      });
      
      const expiredCount = allBatches.filter((b) => b.expiryDate! < now).length;
      const expiringSoonCount = allBatches.filter(
        (b) => b.expiryDate! >= now && b.expiryDate! <= thresholdDate
      ).length;
      const totalValue = calculateTotalBatchValue(allBatches);

      return {
        batches: enrichedBatches,
        pagination: {
          page,
          pageSize,
          total: totalCount,
          totalPages: Math.ceil(totalCount / pageSize),
        },
        summary: {
          totalBatches: totalCount,
          totalValue,
          expiredCount,
          expiringSoonCount,
          thresholdDays: daysThreshold,
        },
      };
    }),

  /**
   * Get a single batch by ID with full details
   */
  getBatchById: requirePermission('inventory:view')
    .input(z.object({ batchId: z.string() }))
    .query(async ({ input }) => {
      const batch = await prisma.inventoryBatch.findUnique({
        where: { id: input.batchId },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              sku: true,
              unit: true,
              category: true,
              currentStock: true,
            },
          },
          supplier: {
            select: {
              id: true,
              businessName: true,
            },
          },
          consumptions: {
            take: 10,
            orderBy: { consumedAt: 'desc' },
            include: {
              transaction: {
                select: {
                  type: true,
                  referenceType: true,
                  referenceId: true,
                },
              },
            },
          },
        },
      });

      if (!batch) {
        return null;
      }

      const now = new Date();
      const daysUntilExpiry = batch.expiryDate
        ? Math.ceil(
            (batch.expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
          )
        : null;

      return {
        ...batch,
        totalValue: calculateBatchValue(batch),
        utilizationRate:
          batch.initialQuantity > 0
            ? ((batch.initialQuantity - batch.quantityRemaining) /
                batch.initialQuantity) *
              100
            : 0,
        daysUntilExpiry,
        isExpired: daysUntilExpiry !== null && daysUntilExpiry < 0,
      };
    }),

  /**
   * Get all batches for a specific product
   */
  getProductBatches: requirePermission('inventory:view')
    .input(
      z.object({
        productId: z.string(),
        includeConsumed: z.boolean().default(false),
        supplierOnly: z.boolean().default(false),
        batchPrefix: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const batches = await prisma.inventoryBatch.findMany({
        where: {
          productId: input.productId,
          isConsumed: input.includeConsumed ? undefined : false,
          ...(input.supplierOnly && { supplierId: { not: null } }),
          ...(input.batchPrefix && { batchNumber: { startsWith: input.batchPrefix } }),
        },
        include: {
          supplier: { select: { id: true, businessName: true } },
          consumptions: {
            take: 10,
            orderBy: { consumedAt: 'desc' },
          },
        },
        orderBy: { receivedAt: 'asc' },
      });

      const now = new Date();
      return batches.map((batch) => {
        const daysUntilExpiry = batch.expiryDate
          ? Math.ceil(
              (batch.expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
            )
          : null;

        return {
          ...batch,
          totalValue: calculateBatchValue(batch),
          utilizationRate:
            batch.initialQuantity > 0
              ? ((batch.initialQuantity - batch.quantityRemaining) /
                  batch.initialQuantity) *
                100
              : 0,
          daysUntilExpiry,
          isExpired: daysUntilExpiry !== null && daysUntilExpiry < 0,
        };
      });
    }),

  getBatchIdByBatchNumber: requirePermission('inventory:view')
    .input(z.object({ batchNumber: z.string() }))
    .query(async ({ input }) => {
      const batch = await prisma.inventoryBatch.findFirst({
        where: { batchNumber: input.batchNumber },
        select: { id: true },
      });
      return batch ? { batchId: batch.id } : null;
    }),

  /**
   * Mark a batch as fully consumed (stock write-off)
   */
  markBatchConsumed: requirePermission('products:adjust_stock')
    .input(z.object({
      batchId: z.string(),
      reason: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const batch = await prisma.inventoryBatch.findUnique({
        where: { id: input.batchId },
        include: {
          product: {
            select: { id: true, currentStock: true },
          },
        },
      });

      if (!batch) {
        throw new Error('Batch not found');
      }

      if (batch.isConsumed) {
        throw new Error('Batch is already consumed');
      }

      // Update the batch and reduce product stock
      const quantityToDeduct = batch.quantityRemaining;

      if (batch.product.currentStock < quantityToDeduct) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Insufficient stock to write off this batch. Product stock: ${batch.product.currentStock}, batch remaining: ${quantityToDeduct}. Please adjust product stock first.`,
        });
      }

      await prisma.$transaction(async (tx) => {
        // Generate batch number for write-off
        const { generateBatchNumber } = await import('../services/batch-number');
        const batchNumber = await generateBatchNumber(tx, 'stock_write_off');

        // Mark batch as consumed
        await tx.inventoryBatch.update({
          where: { id: input.batchId },
          data: {
            isConsumed: true,
            quantityRemaining: 0,
          },
        });

        // Create inventory transaction for traceability
        await tx.inventoryTransaction.create({
          data: {
            type: 'adjustment',
            adjustmentType: 'stock_write_off',
            productId: batch.productId,
            quantity: -quantityToDeduct,
            previousStock: batch.product.currentStock,
            newStock: batch.product.currentStock - quantityToDeduct,
            costPerUnit: batch.costPerUnit,
            notes: input.reason
              ? `Stock writeoff: ${input.reason}`
              : 'Stock writeoff (expiry management)',
            createdBy: ctx.userId || 'system',
            batchNumber,
          },
        });

        // Sync product stock from batch sums (defensive — replaces manual arithmetic)
        const { syncProductCurrentStock } = await import('../services/inventory-batch');
        await syncProductCurrentStock(batch.productId, tx);
      });

      return { success: true };
    }),

  /**
   * Update a batch's remaining quantity
   */
  updateBatchQuantity: requirePermission('products:adjust_stock')
    .input(
      z.object({
        batchId: z.string(),
        newQuantity: z.number().min(0),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const batch = await prisma.inventoryBatch.findUnique({
        where: { id: input.batchId },
        include: {
          product: {
            select: { id: true, currentStock: true },
          },
        },
      });

      if (!batch) {
        throw new Error('Batch not found');
      }

      if (batch.isConsumed) {
        throw new Error('Cannot update consumed batch');
      }

      const quantityDiff = input.newQuantity - batch.quantityRemaining;

      const rawNewProductStock = batch.product.currentStock + quantityDiff;
      if (rawNewProductStock < 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot adjust batch quantity — it would reduce product stock below zero. Current stock: ${batch.product.currentStock}, change: ${quantityDiff}. Please adjust product stock first.`,
        });
      }

      const isConsumed = input.newQuantity === 0;

      await prisma.$transaction(async (tx) => {
        // Generate batch number for stock count correction
        const { generateBatchNumber } = await import('../services/batch-number');
        const batchNumber = await generateBatchNumber(tx, 'stock_count_correction');

        // Update batch quantity
        await tx.inventoryBatch.update({
          where: { id: input.batchId },
          data: {
            quantityRemaining: input.newQuantity,
            isConsumed,
          },
        });

        // Create inventory transaction for traceability
        await tx.inventoryTransaction.create({
          data: {
            type: 'adjustment',
            adjustmentType: 'stock_count_correction',
            productId: batch.productId,
            quantity: quantityDiff,
            previousStock: batch.product.currentStock,
            newStock: batch.product.currentStock + quantityDiff,
            costPerUnit: batch.costPerUnit,
            notes: `Batch quantity adjusted (expiry management)`,
            createdBy: ctx.userId || 'system',
            batchNumber,
          },
        });

        // Sync product stock from batch sums (defensive — replaces manual arithmetic)
        const { syncProductCurrentStock } = await import('../services/inventory-batch');
        await syncProductCurrentStock(batch.productId, tx);
      });

      return { success: true, newQuantity: input.newQuantity };
    }),

  /**
   * Get stock received history (paginated, searchable) — lists InventoryBatch records
   */
  getStockReceivedHistory: requirePermission('inventory:view')
    .input(
      z.object({
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().positive().max(100).default(25),
        sortBy: z.enum(['receivedAt', 'productName', 'quantity', 'costPerUnit', 'expiryDate']).default('receivedAt'),
        sortDirection: z.enum(['asc', 'desc']).default('desc'),
        search: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        supplierId: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const { page, pageSize, sortBy, sortDirection, search, dateFrom, dateTo, supplierId } = input;

      const where: any = {
        batchNumber: { startsWith: 'SI-' },
      };

      if (search) {
        where.product = {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { sku: { contains: search, mode: 'insensitive' } },
          ],
        };
      }

      if (supplierId) {
        where.supplierId = supplierId;
      }

      if (dateFrom || dateTo) {
        where.receivedAt = {};
        if (dateFrom) {
          where.receivedAt.gte = new Date(dateFrom);
        }
        if (dateTo) {
          const endDate = new Date(dateTo);
          endDate.setDate(endDate.getDate() + 1);
          where.receivedAt.lte = endDate;
        }
      }

      let orderBy: any;
      switch (sortBy) {
        case 'productName':
          orderBy = { product: { name: sortDirection } };
          break;
        case 'quantity':
          orderBy = { quantityRemaining: sortDirection };
          break;
        case 'costPerUnit':
          orderBy = { costPerUnit: sortDirection };
          break;
        case 'expiryDate':
          orderBy = { expiryDate: sortDirection };
          break;
        case 'receivedAt':
        default:
          orderBy = { receivedAt: sortDirection };
          break;
      }

      const totalCount = await prisma.inventoryBatch.count({ where });

      const batches = await prisma.inventoryBatch.findMany({
        where,
        include: {
          product: {
            select: { id: true, name: true, sku: true, unit: true },
          },
          supplier: {
            select: { id: true, businessName: true },
          },
        },
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      });

      const items = batches.map((batch) => ({
        id: batch.id,
        productId: batch.product.id,
        productName: batch.product.name,
        productSku: batch.product.sku,
        productUnit: batch.product.unit,
        batchNumber: batch.batchNumber,
        initialQuantity: batch.initialQuantity,
        quantityRemaining: batch.quantityRemaining,
        costPerUnit: batch.costPerUnit,
        supplierId: batch.supplier?.id || null,
        supplierName: batch.supplier?.businessName || null,
        supplierInvoiceNumber: batch.supplierInvoiceNumber,
        stockInDate: batch.stockInDate,
        receivedAt: batch.receivedAt,
        expiryDate: batch.expiryDate,
        mtvNumber: batch.mtvNumber,
        vehicleTemperature: batch.vehicleTemperature,
        notes: batch.notes,
        isConsumed: batch.isConsumed,
      }));

      return {
        items,
        totalCount,
        page,
        pageSize,
        totalPages: Math.ceil(totalCount / pageSize),
      };
    }),

  /**
   * Get processing history (paginated, searchable) — paired processing events
   * Target transactions (qty > 0) are the pagination anchor; source transactions
   * (qty < 0) are fetched by matching batchNumber.
   */
  getProcessingHistory: requirePermission('inventory:view')
    .input(
      z.object({
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().positive().max(100).default(25),
        sortBy: z.enum(['createdAt', 'productName']).default('createdAt'),
        sortDirection: z.enum(['asc', 'desc']).default('desc'),
        search: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const { page, pageSize, sortBy, sortDirection, search, dateFrom, dateTo } = input;

      // Build where clause for target transactions (qty > 0)
      const where: any = {
        type: 'adjustment',
        adjustmentType: 'processing',
        quantity: { gt: 0 },
      };

      if (search) {
        where.product = {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { sku: { contains: search, mode: 'insensitive' } },
          ],
        };
      }

      if (dateFrom || dateTo) {
        where.createdAt = {};
        if (dateFrom) {
          where.createdAt.gte = new Date(dateFrom);
        }
        if (dateTo) {
          const endDate = new Date(dateTo);
          endDate.setDate(endDate.getDate() + 1);
          where.createdAt.lte = endDate;
        }
      }

      let orderBy: any;
      switch (sortBy) {
        case 'productName':
          orderBy = { product: { name: sortDirection } };
          break;
        case 'createdAt':
        default:
          orderBy = { createdAt: sortDirection };
          break;
      }

      // 1. Count target transactions for pagination
      const totalCount = await prisma.inventoryTransaction.count({ where });

      // 2. Fetch target transactions (paginated)
      const targetTransactions = await prisma.inventoryTransaction.findMany({
        where,
        include: {
          product: {
            select: { id: true, name: true, sku: true, unit: true },
          },
        },
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      });

      // 3. Fetch source transactions by matching batchNumber
      const batchNumbers = targetTransactions
        .map((tx) => tx.batchNumber)
        .filter((bn): bn is string => bn !== null);

      const sourceTransactions = batchNumbers.length > 0
        ? await prisma.inventoryTransaction.findMany({
            where: {
              type: 'adjustment',
              adjustmentType: 'processing',
              quantity: { lt: 0 },
              batchNumber: { in: batchNumbers },
            },
            include: {
              product: {
                select: { id: true, name: true, sku: true, unit: true },
              },
              batchConsumptions: {
                include: {
                  batch: {
                    select: {
                      id: true,
                      batchNumber: true,
                      expiryDate: true,
                      costPerUnit: true,
                      supplier: {
                        select: { businessName: true },
                      },
                    },
                  },
                },
              },
            },
          })
        : [];

      // Build a map of batchNumber -> source transaction
      const sourceMap = new Map<string, (typeof sourceTransactions)[number]>();
      for (const src of sourceTransactions) {
        if (src.batchNumber) {
          sourceMap.set(src.batchNumber, src);
        }
      }

      // Assemble paired events
      const items = targetTransactions.map((target) => {
        const source = target.batchNumber ? sourceMap.get(target.batchNumber) ?? null : null;

        const batchConsumptions = (source?.batchConsumptions ?? []).map((bc) => ({
          quantityConsumed: bc.quantityConsumed,
          costPerUnit: bc.costPerUnit, // cents
          totalCost: bc.totalCost, // cents
          batch: bc.batch
            ? {
                id: bc.batch.id,
                batchNumber: bc.batch.batchNumber,
                expiryDate: bc.batch.expiryDate,
              }
            : null,
          supplierName: bc.batch?.supplier?.businessName ?? null,
        }));

        const totalMaterialCost = batchConsumptions.reduce((sum, bc) => sum + bc.totalCost, 0);
        const inputQty = source ? Math.abs(source.quantity) : null;
        const outputQty = target.quantity;
        const lossPercentage =
          inputQty !== null && inputQty > 0
            ? Math.round(((inputQty - outputQty) / inputQty) * 1000) / 10
            : null;

        return {
          id: target.id,
          batchNumber: target.batchNumber,
          source: source
            ? {
                productId: source.product.id,
                productName: source.product.name,
                productSku: source.product.sku,
                productUnit: source.product.unit,
                quantity: Math.abs(source.quantity),
              }
            : null,
          target: {
            productId: target.product.id,
            productName: target.product.name,
            productSku: target.product.sku,
            productUnit: target.product.unit,
            quantity: target.quantity,
            costPerUnit: target.costPerUnit, // cents or null
            expiryDate: target.expiryDate,
          },
          lossPercentage,
          batchConsumptions,
          totalMaterialCost, // cents
          notes: target.notes ?? source?.notes ?? null,
          createdAt: target.createdAt,
          createdBy: target.createdBy || 'system',
        };
      });

      return {
        items,
        totalCount,
        page,
        pageSize,
        totalPages: Math.ceil(totalCount / pageSize),
      };
    }),

  /**
   * Get a single processing record by its batchNumber (e.g. "PR-xxx").
   * Returns the same shape as individual items in getProcessingHistory.
   */
  getProcessingRecordByBatchNumber: requirePermission('inventory:view')
    .input(z.object({ batchNumber: z.string() }))
    .query(async ({ input }) => {
      const { batchNumber } = input;

      // Find target transaction (qty > 0, processing, matching batchNumber)
      const target = await prisma.inventoryTransaction.findFirst({
        where: {
          type: 'adjustment',
          adjustmentType: 'processing',
          quantity: { gt: 0 },
          batchNumber,
        },
        include: {
          product: { select: { id: true, name: true, sku: true, unit: true } },
        },
      });

      if (!target) return null;

      // Find paired source transaction (qty < 0)
      const source = await prisma.inventoryTransaction.findFirst({
        where: {
          type: 'adjustment',
          adjustmentType: 'processing',
          quantity: { lt: 0 },
          batchNumber,
        },
        include: {
          product: { select: { id: true, name: true, sku: true, unit: true } },
          batchConsumptions: {
            include: {
              batch: {
                select: {
                  id: true,
                  batchNumber: true,
                  expiryDate: true,
                  costPerUnit: true,
                  supplier: { select: { businessName: true } },
                },
              },
            },
          },
        },
      });

      const batchConsumptions = (source?.batchConsumptions ?? []).map((bc) => ({
        quantityConsumed: bc.quantityConsumed,
        costPerUnit: bc.costPerUnit,
        totalCost: bc.totalCost,
        batch: bc.batch
          ? {
              id: bc.batch.id,
              batchNumber: bc.batch.batchNumber,
              expiryDate: bc.batch.expiryDate,
            }
          : null,
        supplierName: bc.batch?.supplier?.businessName ?? null,
      }));

      const totalMaterialCost = batchConsumptions.reduce((sum, bc) => sum + bc.totalCost, 0);
      const inputQty = source ? Math.abs(source.quantity) : null;
      const outputQty = target.quantity;
      const lossPercentage =
        inputQty !== null && inputQty > 0
          ? Math.round(((inputQty - outputQty) / inputQty) * 1000) / 10
          : null;

      return {
        id: target.id,
        batchNumber: target.batchNumber,
        source: source
          ? {
              productId: source.product.id,
              productName: source.product.name,
              productSku: source.product.sku,
              productUnit: source.product.unit,
              quantity: Math.abs(source.quantity),
            }
          : null,
        target: {
          productId: target.product.id,
          productName: target.product.name,
          productSku: target.product.sku,
          productUnit: target.product.unit,
          quantity: target.quantity,
          costPerUnit: target.costPerUnit,
          expiryDate: target.expiryDate,
        },
        lossPercentage,
        batchConsumptions,
        totalMaterialCost,
        notes: target.notes ?? source?.notes ?? null,
        createdAt: target.createdAt,
        createdBy: target.createdBy || 'system',
      };
    }),

  /**
   * Get packing history (paginated, searchable) — InventoryTransactions with adjustmentType IN ('packing_adjustment', 'packing_reset')
   */
  getPackingHistory: requirePermission('inventory:view')
    .input(
      z.object({
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().positive().max(100).default(25),
        sortBy: z.enum(['createdAt', 'productName', 'quantity']).default('createdAt'),
        sortDirection: z.enum(['asc', 'desc']).default('desc'),
        search: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const { page, pageSize, sortBy, sortDirection, search, dateFrom, dateTo } = input;

      const where: any = {
        type: 'adjustment',
        adjustmentType: { in: ['packing_adjustment', 'packing_reset'] },
      };

      if (search) {
        where.product = {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { sku: { contains: search, mode: 'insensitive' } },
          ],
        };
      }

      if (dateFrom || dateTo) {
        where.createdAt = {};
        if (dateFrom) {
          where.createdAt.gte = new Date(dateFrom);
        }
        if (dateTo) {
          const endDate = new Date(dateTo);
          endDate.setDate(endDate.getDate() + 1);
          where.createdAt.lte = endDate;
        }
      }

      let orderBy: any;
      switch (sortBy) {
        case 'productName':
          orderBy = { product: { name: sortDirection } };
          break;
        case 'quantity':
          orderBy = { quantity: sortDirection };
          break;
        case 'createdAt':
        default:
          orderBy = { createdAt: sortDirection };
          break;
      }

      const totalCount = await prisma.inventoryTransaction.count({ where });

      const transactions = await prisma.inventoryTransaction.findMany({
        where,
        include: {
          product: {
            select: { id: true, name: true, sku: true, unit: true },
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
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      });

      const items = transactions.map((tx) => ({
        id: tx.id,
        productId: tx.product.id,
        productName: tx.product.name,
        productSku: tx.product.sku,
        productUnit: tx.product.unit,
        batchNumber: tx.batchNumber,
        adjustmentType: tx.adjustmentType,
        quantity: tx.quantity,
        previousStock: tx.previousStock,
        newStock: tx.newStock,
        notes: tx.notes,
        createdAt: tx.createdAt,
        createdBy: tx.createdBy || 'system',
        batchConsumptions: tx.batchConsumptions.map((bc) => ({
          id: bc.id,
          quantityConsumed: bc.quantityConsumed,
          batchId: bc.batch.id,
          batchNumber: bc.batch.batchNumber,
          batchReceivedAt: bc.batch.receivedAt,
          batchExpiryDate: bc.batch.expiryDate,
        })),
      }));

      return {
        items,
        totalCount,
        page,
        pageSize,
        totalPages: Math.ceil(totalCount / pageSize),
      };
    }),

  /**
   * Get write-off history (paginated, searchable)
   */
  getWriteOffHistory: requirePermission('inventory:view')
    .input(
      z.object({
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().positive().max(100).default(25),
        sortBy: z.enum(['createdAt', 'productName', 'quantity']).default('createdAt'),
        sortDirection: z.enum(['asc', 'desc']).default('desc'),
        search: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const { page, pageSize, sortBy, sortDirection, search, dateFrom, dateTo } = input;

      // Build where clause for write-off transactions
      const where: any = {
        type: 'adjustment',
        adjustmentType: 'stock_write_off',
      };

      // Apply search filter on product name/SKU
      if (search) {
        where.product = {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { sku: { contains: search, mode: 'insensitive' } },
          ],
        };
      }

      // Apply date range filter
      if (dateFrom || dateTo) {
        where.createdAt = {};
        if (dateFrom) {
          where.createdAt.gte = new Date(dateFrom);
        }
        if (dateTo) {
          // Include the entire "dateTo" day
          const endDate = new Date(dateTo);
          endDate.setDate(endDate.getDate() + 1);
          where.createdAt.lte = endDate;
        }
      }

      // Build orderBy
      let orderBy: any;
      switch (sortBy) {
        case 'productName':
          orderBy = { product: { name: sortDirection } };
          break;
        case 'quantity':
          orderBy = { quantity: sortDirection };
          break;
        case 'createdAt':
        default:
          orderBy = { createdAt: sortDirection };
          break;
      }

      // Get total count for pagination
      const totalCount = await prisma.inventoryTransaction.count({ where });

      // Get transactions with pagination
      const transactions = await prisma.inventoryTransaction.findMany({
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
        },
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      });

      // Parse reason from notes field
      const items = transactions.map((tx) => {
        let reason = tx.notes || '';
        // Notes format: "Stock writeoff: <reason>" or "Stock writeoff (expiry management)"
        const colonIndex = reason.indexOf(':');
        if (colonIndex !== -1) {
          reason = reason.substring(colonIndex + 1).trim();
        }

        return {
          id: tx.id,
          productId: tx.product.id,
          productName: tx.product.name,
          productSku: tx.product.sku,
          productUnit: tx.product.unit,
          batchNumber: tx.batchNumber,
          quantity: Math.abs(tx.quantity), // stored as negative, display as positive
          rawQuantity: tx.quantity, // original signed value for edit dialog
          previousStock: tx.previousStock,
          newStock: tx.newStock,
          notes: tx.notes,
          reason,
          createdAt: tx.createdAt,
          createdBy: tx.createdBy || 'system',
        };
      });

      return {
        items,
        totalCount,
        page,
        pageSize,
        totalPages: Math.ceil(totalCount / pageSize),
      };
    }),

  /**
   * Edit a stock-received batch (all fields including quantity)
   */
  editStockReceivedBatch: requirePermission('products:adjust_stock')
    .input(
      z.object({
        batchId: z.string(),
        initialQuantity: z.number().positive().optional(),
        quantityRemaining: z.number().min(0).optional(),
        costPerUnit: z.number().int().positive().optional(), // in cents
        expiryDate: z.date().nullable().optional(),
        supplierId: z.string().nullable().optional(),
        supplierInvoiceNumber: z.string().nullable().optional(),
        stockInDate: z.date().nullable().optional(),
        mtvNumber: z.string().nullable().optional(),
        vehicleTemperature: z.number().nullable().optional(),
        notes: z.string().nullable().optional(),
        editReason: z.string().min(1, 'Edit reason is required'),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { batchId, editReason, ...updates } = input;

      const batch = await prisma.inventoryBatch.findUnique({
        where: { id: batchId },
        include: {
          product: {
            select: { id: true, currentStock: true, estimatedLossPercentage: true, parentProductId: true },
          },
        },
      });

      if (!batch) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Batch not found' });
      }

      const quantityChanged = updates.quantityRemaining !== undefined && updates.quantityRemaining !== batch.quantityRemaining;

      // Validate stock won't go negative if quantity reduced
      if (quantityChanged) {
        const quantityDiff = updates.quantityRemaining! - batch.quantityRemaining;
        const projectedStock = batch.product.currentStock + quantityDiff;
        if (projectedStock < 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Cannot reduce batch quantity — it would reduce product stock below zero. Current stock: ${batch.product.currentStock}, change: ${quantityDiff}.`,
          });
        }
      }

      await prisma.$transaction(async (tx) => {
        // Build update data for batch
        const batchUpdate: any = {};
        if (updates.quantityRemaining !== undefined) batchUpdate.quantityRemaining = updates.quantityRemaining;
        if (updates.initialQuantity !== undefined) batchUpdate.initialQuantity = updates.initialQuantity;
        if (updates.costPerUnit !== undefined) batchUpdate.costPerUnit = updates.costPerUnit;
        if (updates.expiryDate !== undefined) batchUpdate.expiryDate = updates.expiryDate;
        if (updates.supplierId !== undefined) batchUpdate.supplierId = updates.supplierId;
        if (updates.supplierInvoiceNumber !== undefined) batchUpdate.supplierInvoiceNumber = updates.supplierInvoiceNumber;
        if (updates.stockInDate !== undefined) batchUpdate.stockInDate = updates.stockInDate;
        if (updates.mtvNumber !== undefined) batchUpdate.mtvNumber = updates.mtvNumber;
        if (updates.vehicleTemperature !== undefined) batchUpdate.vehicleTemperature = updates.vehicleTemperature;
        if (updates.notes !== undefined) batchUpdate.notes = updates.notes;

        // Mark batch as consumed if quantity set to 0
        if (updates.quantityRemaining === 0) {
          batchUpdate.isConsumed = true;
          batchUpdate.consumedAt = new Date();
        } else if (updates.quantityRemaining !== undefined && updates.quantityRemaining > 0 && batch.isConsumed) {
          // Re-open if was consumed
          batchUpdate.isConsumed = false;
          batchUpdate.consumedAt = null;
        }

        await tx.inventoryBatch.update({
          where: { id: batchId },
          data: batchUpdate,
        });

        // If quantity changed, create a corrective transaction
        if (quantityChanged) {
          const quantityDiff = updates.quantityRemaining! - batch.quantityRemaining;
          const { generateBatchNumber } = await import('../services/batch-number');
          const batchNumber = await generateBatchNumber(tx, 'stock_count_correction');

          await tx.inventoryTransaction.create({
            data: {
              type: 'adjustment',
              adjustmentType: 'stock_count_correction',
              productId: batch.productId,
              quantity: quantityDiff,
              previousStock: batch.product.currentStock,
              newStock: batch.product.currentStock + quantityDiff,
              costPerUnit: batch.costPerUnit,
              notes: `Batch edit (stock received correction): ${editReason}`,
              createdBy: ctx.userId || 'system',
              batchNumber,
            },
          });
        }

        // Sync product stock and cascade to subproducts
        const { syncProductCurrentStock } = await import('../services/inventory-batch');
        const syncedStock = await syncProductCurrentStock(batch.productId, tx);

        // Cascade to subproducts
        const subproducts = await tx.product.findMany({
          where: { parentProductId: batch.productId },
          select: { id: true },
        });
        if (subproducts.length > 0) {
          const { calculateAllSubproductStocksWithInheritance } = await import('@joho-erp/shared');
          const allSubs = await tx.product.findMany({
            where: { parentProductId: batch.productId },
            select: { id: true, parentProductId: true, estimatedLossPercentage: true },
          });
          const updatedStocks = calculateAllSubproductStocksWithInheritance(
            syncedStock,
            batch.product.estimatedLossPercentage,
            allSubs
          );
          for (const { id, newStock } of updatedStocks) {
            await tx.product.update({
              where: { id },
              data: { currentStock: Math.max(0, newStock) },
            });
          }
        }
      });

      return { success: true };
    }),

  /**
   * Edit an existing write-off/processing/packing transaction (quantity + notes)
   */
  editTransaction: requirePermission('products:adjust_stock')
    .input(
      z.object({
        transactionId: z.string(),
        newQuantity: z.number(),
        notes: z.string().nullable().optional(),
        editReason: z.string().min(1, 'Edit reason is required'),
      })
    )
    .mutation(async ({ input }) => {
      const { transactionId, newQuantity, notes, editReason } = input;

      const transaction = await prisma.inventoryTransaction.findUnique({
        where: { id: transactionId },
        include: {
          product: {
            select: { id: true, currentStock: true, estimatedLossPercentage: true },
          },
          batchConsumptions: true,
        },
      });

      if (!transaction) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Transaction not found' });
      }

      const allowedTypes = ['stock_write_off', 'processing', 'packing_adjustment', 'packing_reset'];
      if (!transaction.adjustmentType || !allowedTypes.includes(transaction.adjustmentType)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot edit transaction of type '${transaction.adjustmentType}'. Only write-off, processing, and packing transactions can be edited.`,
        });
      }

      // For negative transactions (write-offs, processing source), newQuantity should be the absolute value
      // The stored quantity is negative, so we work with the absolute difference
      const oldAbsQuantity = Math.abs(transaction.quantity);
      const isNegativeTransaction = transaction.quantity < 0;
      const absNewQuantity = Math.abs(newQuantity);

      // Validate the new quantity won't cause negative stock
      if (isNegativeTransaction) {
        // Increasing a deduction: check there's enough stock
        const additionalDeduction = absNewQuantity - oldAbsQuantity;
        if (additionalDeduction > 0) {
          // Need to restore old consumptions then re-consume, so check total available
          // This is validated inside the transaction below
        }
      }

      await prisma.$transaction(async (tx) => {
        const { syncProductCurrentStock } = await import('../services/inventory-batch');

        // Step 1: Reverse original batch consumptions
        if (transaction.batchConsumptions.length > 0) {
          for (const consumption of transaction.batchConsumptions) {
            await tx.inventoryBatch.update({
              where: { id: consumption.batchId },
              data: {
                quantityRemaining: { increment: consumption.quantityConsumed },
                isConsumed: false,
                consumedAt: null,
              },
            });
          }
          // Delete old consumption records
          await tx.batchConsumption.deleteMany({
            where: { transactionId: transaction.id },
          });
        }

        // Step 2: Re-consume with corrected amount (for negative/deduction transactions)
        if (isNegativeTransaction && absNewQuantity > 0) {
          const { consumeStock } = await import('../services/inventory-batch');
          await consumeStock(
            transaction.productId,
            absNewQuantity,
            transaction.id,
            undefined,
            undefined,
            tx
          );
        }

        // Step 3: Recalculate stock values
        const currentStock = await syncProductCurrentStock(transaction.productId, tx);

        // Compute the correct previousStock/newStock for the updated transaction
        const actualQuantity = isNegativeTransaction ? -absNewQuantity : absNewQuantity;
        const updatedPreviousStock = currentStock - actualQuantity + transaction.quantity;

        // Step 4: Update the transaction record
        const existingNotes = transaction.notes || '';
        const updatedNotes = notes !== undefined && notes !== null
          ? `${notes} [Edited: ${editReason}]`
          : `${existingNotes} [Edited: ${editReason}]`;

        await tx.inventoryTransaction.update({
          where: { id: transaction.id },
          data: {
            quantity: actualQuantity,
            previousStock: updatedPreviousStock,
            newStock: currentStock,
            notes: updatedNotes.trim(),
          },
        });

        // Step 5: Cascade to subproducts
        const subproducts = await tx.product.findMany({
          where: { parentProductId: transaction.productId },
          select: { id: true },
        });
        if (subproducts.length > 0) {
          const { calculateAllSubproductStocksWithInheritance } = await import('@joho-erp/shared');
          const allSubs = await tx.product.findMany({
            where: { parentProductId: transaction.productId },
            select: { id: true, parentProductId: true, estimatedLossPercentage: true },
          });
          const updatedStocks = calculateAllSubproductStocksWithInheritance(
            currentStock,
            transaction.product.estimatedLossPercentage,
            allSubs
          );
          for (const { id, newStock: subStock } of updatedStocks) {
            await tx.product.update({
              where: { id },
              data: { currentStock: Math.max(0, subStock) },
            });
          }
        }
      });

      return { success: true };
    }),

  /**
   * Get batch consumption history for a specific product
   */
  getProductConsumptionHistory: requirePermission('inventory:view')
    .input(
      z.object({
        productId: z.string(),
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().positive().max(100).default(25),
      })
    )
    .query(async ({ input }) => {
      const { productId, page, pageSize } = input;

      const [product, totalCount, consumptions] = await Promise.all([
        prisma.product.findUnique({
          where: { id: productId },
          select: { id: true, name: true, sku: true, unit: true, currentStock: true },
        }),
        prisma.batchConsumption.count({
          where: { batch: { productId } },
        }),
        prisma.batchConsumption.findMany({
          where: { batch: { productId } },
          include: {
            batch: {
              select: {
                id: true,
                batchNumber: true,
                receivedAt: true,
                expiryDate: true,
              },
            },
            transaction: {
              select: {
                id: true,
                type: true,
                adjustmentType: true,
                notes: true,
                createdAt: true,
                referenceId: true,
                referenceType: true,
              },
            },
          },
          orderBy: { consumedAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ]);

      return {
        product,
        consumptions: consumptions.map((c) => ({
          id: c.id,
          quantityConsumed: c.quantityConsumed,
          orderNumber: c.orderNumber,
          orderId: c.orderId,
          consumedAt: c.consumedAt,
          batchId: c.batch.id,
          batchNumber: c.batch.batchNumber,
          batchReceivedAt: c.batch.receivedAt,
          batchExpiryDate: c.batch.expiryDate,
          transactionType: c.transaction.type,
          transactionAdjustmentType: c.transaction.adjustmentType,
          transactionNotes: c.transaction.notes,
          transactionReferenceId: c.transaction.referenceId,
          transactionReferenceType: c.transaction.referenceType,
        })),
        totalCount,
        page,
        pageSize,
        totalPages: Math.ceil(totalCount / pageSize),
      };
    }),
});
