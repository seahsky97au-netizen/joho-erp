import { z } from 'zod';
import { router, protectedProcedure, requirePermission, requireAnyPermission } from '../trpc';
import { prisma } from '@joho-erp/database';
import { TRPCError } from '@trpc/server';
import { getEffectivePrice, buildPrismaOrderBy, getCustomerStockStatus, calculateSubproductStock, calculateAllSubproductStocksWithInheritance, isSubproduct, getEffectiveLossPercentage } from '@joho-erp/shared';
import { logProductCreated, logProductUpdated, logStockAdjustment } from '../services/audit';
import { sortInputSchema, paginationInputSchema } from '../schemas';

const productCategoryEnum = z.enum(['Beef', 'Pork', 'Chicken', 'Lamb', 'Processed']);

// Product-specific sort field mapping
const productSortFieldMapping: Record<string, string> = {
  name: 'name',
  sku: 'sku',
  basePrice: 'basePrice',
  currentStock: 'currentStock',
  category: 'category',
  status: 'status',
  createdAt: 'createdAt',
};

/**
 * Helper to recalculate and update all subproduct stocks after parent stock changes.
 * @param parentId - The parent product ID
 * @param parentStock - The new parent stock level
 * @param tx - Optional Prisma transaction client
 */
async function updateSubproductStocks(
  parentId: string,
  parentStock: number,
  parentLossPercentage: number | null | undefined,
  tx?: any
): Promise<void> {
  const db = tx || prisma;

  // Find all subproducts of this parent
  const subproducts = await db.product.findMany({
    where: { parentProductId: parentId },
    select: { id: true, parentProductId: true, estimatedLossPercentage: true },
  });

  if (subproducts.length === 0) return;

  // Calculate new stocks for all subproducts with inheritance support
  const updatedStocks = calculateAllSubproductStocksWithInheritance(
    parentStock,
    parentLossPercentage,
    subproducts
  );

  // Update each subproduct's stock (floor at 0 to prevent negative stock)
  for (const { id, newStock } of updatedStocks) {
    await db.product.update({
      where: { id },
      data: { currentStock: Math.max(0, newStock) },
    });
  }
}

export const productRouter = router({
  // Get all products (with customer-specific pricing if authenticated customer)
  getAll: protectedProcedure
    .input(
      z
        .object({
          categoryId: z.string().optional(),
          status: z.enum(['active', 'discontinued', 'out_of_stock']).optional(),
          search: z.string().optional(),
          showAll: z.boolean().optional(), // If true, show all statuses (for admin)
          includeSubproducts: z.boolean().optional().default(true), // Include nested subproducts (default true)
          onlyParents: z.boolean().optional().default(true), // Only fetch parent products at top level (default true)
          includeBatchSummary: z.boolean().optional().default(false), // Include batch expiry/supplier summary per product
        })
        .merge(sortInputSchema)
        .merge(paginationInputSchema)
    )
    .query(async ({ input, ctx: _ctx }) => {
      // Sync currentStock with batch availability (handles expired batches)


      const { page, limit, sortBy, sortOrder, showAll, includeSubproducts, onlyParents, includeBatchSummary, ...filters } = input;
      const where: any = {};

      if (filters.categoryId) {
        where.categoryId = filters.categoryId;
        where.categoryRelation = { isActive: true }; // Only show products with active categories
      }

      if (filters.status) {
        where.status = filters.status;
      } else if (!showAll) {
        // By default, only show active products to customers
        where.status = 'active';
      }

      if (filters.search) {
        where.OR = [
          { name: { contains: filters.search, mode: 'insensitive' } },
          { sku: { contains: filters.search, mode: 'insensitive' } },
        ];
      }

      // By default, only fetch top-level products (not subproducts)
      // Subproducts will be included nested under their parents
      if (onlyParents) {
        where.parentProductId = null;
      }

      // Build orderBy from sort parameters
      const orderBy =
        sortBy && productSortFieldMapping[sortBy]
          ? buildPrismaOrderBy(sortBy, sortOrder, productSortFieldMapping)
          : { name: 'asc' as const };

      // Calculate pagination
      const skip = (page - 1) * limit;

      // Get total count for pagination
      const totalCount = await prisma.product.count({ where });

      const products = await prisma.product.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: {
          categoryRelation: true,
          // Include subproducts nested under their parent
          ...(includeSubproducts && {
            subProducts: {
              include: {
                categoryRelation: true,
              },
              orderBy: { name: 'asc' },
            },
          }),
        },
      });

      // Compute batch summary (nearest expiry, supplier IDs) per product if requested
      let batchSummaryMap: Map<string, {
        nearestExpiryDate: Date | null;
        expiryStatus: 'expired' | 'expiring_soon' | 'ok' | null;
        supplierIds: string[];
        activeBatchCount: number;
      }> | null = null;

      if (includeBatchSummary) {
        const productIds = products.map((p) => p.id);
        const activeBatches = await prisma.inventoryBatch.findMany({
          where: {
            productId: { in: productIds },
            isConsumed: false,
          },
          select: {
            productId: true,
            expiryDate: true,
            supplierId: true,
          },
        });

        const now = new Date();
        const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        batchSummaryMap = new Map();

        // Group batches by productId
        const grouped = new Map<string, typeof activeBatches>();
        for (const batch of activeBatches) {
          const existing = grouped.get(batch.productId) || [];
          existing.push(batch);
          grouped.set(batch.productId, existing);
        }

        for (const productId of productIds) {
          const batches = grouped.get(productId);
          if (!batches || batches.length === 0) {
            batchSummaryMap.set(productId, {
              nearestExpiryDate: null,
              expiryStatus: null,
              supplierIds: [],
              activeBatchCount: 0,
            });
            continue;
          }

          const expiryDates = batches
            .map((b) => b.expiryDate)
            .filter((d): d is Date => d !== null);
          const nearestExpiryDate = expiryDates.length > 0
            ? expiryDates.reduce((min, d) => (d < min ? d : min))
            : null;

          let expiryStatus: 'expired' | 'expiring_soon' | 'ok' | null = null;
          if (nearestExpiryDate) {
            if (nearestExpiryDate < now) {
              expiryStatus = 'expired';
            } else if (nearestExpiryDate <= sevenDaysFromNow) {
              expiryStatus = 'expiring_soon';
            } else {
              expiryStatus = 'ok';
            }
          }

          const supplierIds = [...new Set(
            batches.map((b) => b.supplierId).filter((id): id is string => id !== null)
          )];

          batchSummaryMap.set(productId, {
            nearestExpiryDate,
            expiryStatus,
            supplierIds,
            activeBatchCount: batches.length,
          });
        }
      }

      // Helper to attach batch summary to a product
      const attachBatchSummary = <T extends { id: string }>(product: T) => {
        if (!batchSummaryMap) return product;
        return {
          ...product,
          batchSummary: batchSummaryMap.get(product.id) ?? null,
        };
      };

      // Fetch customer-specific pricing if user is authenticated
      let customerId: string | null = null;

      // Try to get customer ID from clerk user ID
      if (_ctx.userId) {
        const customer = await prisma.customer.findUnique({
          where: { clerkUserId: _ctx.userId },
          select: { id: true },
        });
        customerId = customer?.id || null;
      }

      // Calculate pagination metadata
      const totalPages = Math.ceil(totalCount / limit);
      const paginationMeta = {
        total: totalCount,
        page,
        totalPages,
        hasMore: page < totalPages,
      };

      // Determine if caller is a customer (hide exact stock counts for customers)
      const isCustomer = !_ctx.userRole || _ctx.userRole === 'customer';

      // Helper to transform product for customer (hide exact stock, show status only)
      const transformForCustomer = <T extends { currentStock: number; lowStockThreshold: number | null }>(
        product: T
      ) => {
        const { currentStock, lowStockThreshold, ...rest } = product;
        return {
          ...rest,
          stockStatus: getCustomerStockStatus(currentStock, lowStockThreshold),
          hasStock: currentStock > 0,
        };
      };

      // If customer exists, fetch their custom pricing
      if (customerId) {
        // Collect all product IDs including subproducts for pricing lookup
        const allProductIds = products.flatMap((p) => [
          p.id,
          ...(p.subProducts?.map((sub: any) => sub.id) || [])
        ]);

        const customerPricings = await prisma.customerPricing.findMany({
          where: {
            customerId,
            productId: { in: allProductIds },
          },
        });

        // Map pricing to products
        const pricingMap = new Map(customerPricings.map((p) => [p.productId, p]));

        const items = products.map((product) => {
          const customPricing = pricingMap.get(product.id);
          // Pass GST options from product to calculate GST-inclusive price
          const gstOptions = { applyGst: product.applyGst, gstRate: product.gstRate };
          const priceInfo = getEffectivePrice(product.basePrice, customPricing, gstOptions);

          // Transform subProducts if present
          const transformedSubProducts = product.subProducts?.map((sub: any) => {
            const subCustomPricing = pricingMap.get(sub.id);
            const subGstOptions = { applyGst: sub.applyGst, gstRate: sub.gstRate };
            const subPriceInfo = getEffectivePrice(sub.basePrice, subCustomPricing, subGstOptions);
            const fullSub = { ...sub, ...subPriceInfo };
            return isCustomer ? transformForCustomer(fullSub) : fullSub;
          });

          const fullProduct = {
            ...product,
            ...priceInfo,
            ...(transformedSubProducts && { subProducts: transformedSubProducts })
          };
          const transformed = isCustomer ? transformForCustomer(fullProduct) : fullProduct;
          return attachBatchSummary(transformed);
        });

        return { items, ...paginationMeta };
      }

      // No customer pricing, return products with base price as effective price
      const items = products.map((product) => {
        // Pass GST options from product to calculate GST-inclusive price
        const gstOptions = { applyGst: product.applyGst, gstRate: product.gstRate };

        // Transform subProducts if present (no customer pricing in this branch)
        const transformedSubProducts = product.subProducts?.map((sub: any) => {
          const subGstOptions = { applyGst: sub.applyGst, gstRate: sub.gstRate };
          const fullSub = { ...sub, ...getEffectivePrice(sub.basePrice, undefined, subGstOptions) };
          return isCustomer ? transformForCustomer(fullSub) : fullSub;
        });

        const fullProduct = {
          ...product,
          ...getEffectivePrice(product.basePrice, undefined, gstOptions),
          ...(transformedSubProducts && { subProducts: transformedSubProducts })
        };
        const transformed = isCustomer ? transformForCustomer(fullProduct) : fullProduct;
        return attachBatchSummary(transformed);
      });

      return { items, ...paginationMeta };
    }),

  // Get all products with cursor-based pagination for useInfiniteQuery
  getInfinite: protectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
        cursor: z.number().min(1).default(1), // page number as cursor
        search: z.string().optional(),
        categoryId: z.string().optional(),
        status: z.enum(['active', 'discontinued', 'out_of_stock']).optional(),
        showAll: z.boolean().optional(),
      })
    )
    .query(async ({ input, ctx: _ctx }) => {
      const { cursor: page, limit, showAll, ...filters } = input;
      const where: any = {};

      if (filters.categoryId) {
        where.categoryId = filters.categoryId;
        where.categoryRelation = { isActive: true };
      }

      if (filters.status) {
        where.status = filters.status;
      } else if (!showAll) {
        where.status = 'active';
      }

      if (filters.search) {
        where.OR = [
          { name: { contains: filters.search, mode: 'insensitive' } },
          { sku: { contains: filters.search, mode: 'insensitive' } },
        ];
      }

      // Only fetch top-level products (subproducts nested under parents)
      where.parentProductId = null;

      const skip = (page - 1) * limit;
      const totalCount = await prisma.product.count({ where });

      const products = await prisma.product.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take: limit,
        include: {
          categoryRelation: true,
          subProducts: {
            include: { categoryRelation: true },
            orderBy: { name: 'asc' },
          },
        },
      });

      // Fetch customer-specific pricing if user is authenticated
      let customerId: string | null = null;
      if (_ctx.userId) {
        const customer = await prisma.customer.findUnique({
          where: { clerkUserId: _ctx.userId },
          select: { id: true },
        });
        customerId = customer?.id || null;
      }

      const isCustomer = !_ctx.userRole || _ctx.userRole === 'customer';

      const transformForCustomer = <T extends { currentStock: number; lowStockThreshold: number | null }>(
        product: T
      ) => {
        const { currentStock, lowStockThreshold, ...rest } = product;
        return {
          ...rest,
          stockStatus: getCustomerStockStatus(currentStock, lowStockThreshold),
          hasStock: currentStock > 0,
        };
      };

      let items;
      if (customerId) {
        const allProductIds = products.flatMap((p) => [
          p.id,
          ...(p.subProducts?.map((sub: any) => sub.id) || [])
        ]);

        const customerPricings = await prisma.customerPricing.findMany({
          where: { customerId, productId: { in: allProductIds } },
        });

        const pricingMap = new Map(customerPricings.map((p) => [p.productId, p]));

        items = products.map((product) => {
          const customPricing = pricingMap.get(product.id);
          const gstOptions = { applyGst: product.applyGst, gstRate: product.gstRate };
          const priceInfo = getEffectivePrice(product.basePrice, customPricing, gstOptions);

          const transformedSubProducts = product.subProducts?.map((sub: any) => {
            const subCustomPricing = pricingMap.get(sub.id);
            const subGstOptions = { applyGst: sub.applyGst, gstRate: sub.gstRate };
            const subPriceInfo = getEffectivePrice(sub.basePrice, subCustomPricing, subGstOptions);
            const fullSub = { ...sub, ...subPriceInfo };
            return isCustomer ? transformForCustomer(fullSub) : fullSub;
          });

          const fullProduct = {
            ...product,
            ...priceInfo,
            ...(transformedSubProducts && { subProducts: transformedSubProducts })
          };
          return isCustomer ? transformForCustomer(fullProduct) : fullProduct;
        });
      } else {
        items = products.map((product) => {
          const gstOptions = { applyGst: product.applyGst, gstRate: product.gstRate };

          const transformedSubProducts = product.subProducts?.map((sub: any) => {
            const subGstOptions = { applyGst: sub.applyGst, gstRate: sub.gstRate };
            const fullSub = { ...sub, ...getEffectivePrice(sub.basePrice, undefined, subGstOptions) };
            return isCustomer ? transformForCustomer(fullSub) : fullSub;
          });

          const fullProduct = {
            ...product,
            ...getEffectivePrice(product.basePrice, undefined, gstOptions),
            ...(transformedSubProducts && { subProducts: transformedSubProducts })
          };
          return isCustomer ? transformForCustomer(fullProduct) : fullProduct;
        });
      }

      const totalPages = Math.ceil(totalCount / limit);
      const nextCursor = page < totalPages ? page + 1 : undefined;

      return { items, nextCursor, total: totalCount };
    }),

  // Get product by ID (with customer-specific pricing if applicable)
  getById: protectedProcedure
    .input(z.object({ productId: z.string() }))
    .query(async ({ input, ctx }) => {
      const product = await prisma.product.findUnique({
        where: { id: input.productId },
        include: {
          categoryRelation: true,
        },
      });

      if (!product) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Product not found',
        });
      }

      // Determine if caller is a customer (hide exact stock counts for customers)
      const isCustomer = !ctx.userRole || ctx.userRole === 'customer';

      // Helper to transform product for customer (hide exact stock, show status only)
      const transformForCustomer = <T extends { currentStock: number; lowStockThreshold: number | null }>(
        prod: T
      ) => {
        const { currentStock, lowStockThreshold, ...rest } = prod;
        return {
          ...rest,
          stockStatus: getCustomerStockStatus(currentStock, lowStockThreshold),
          hasStock: currentStock > 0,
        };
      };

      // Try to get customer ID and their custom pricing
      let customerId: string | null = null;
      if (ctx.userId) {
        const customer = await prisma.customer.findUnique({
          where: { clerkUserId: ctx.userId },
          select: { id: true },
        });
        customerId = customer?.id || null;
      }

      // GST options from product
      const gstOptions = { applyGst: product.applyGst, gstRate: product.gstRate };

      if (customerId) {
        const customPricing = await prisma.customerPricing.findFirst({
          where: {
            customerId,
            productId: input.productId,
          },
        });

        const priceInfo = getEffectivePrice(product.basePrice, customPricing, gstOptions);
        const fullProduct = { ...product, ...priceInfo };

        return isCustomer ? transformForCustomer(fullProduct) : fullProduct;
      }

      // No customer pricing, return product with base price
      const fullProduct = { ...product, ...getEffectivePrice(product.basePrice, undefined, gstOptions) };
      return isCustomer ? transformForCustomer(fullProduct) : fullProduct;
    }),

  // Admin: Create product (with optional customer-specific pricing)
  // NOTE: basePrice and customPrice must be in cents (Int)
  create: requirePermission('products:create')
    .input(
      z.object({
        sku: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        category: productCategoryEnum.optional(), // Deprecated: Use categoryId instead
        categoryId: z.string().optional(),
        unit: z.enum(['kg', 'piece', 'box', 'carton']),
        packageSize: z.number().positive().optional(),
        basePrice: z.number().int().positive(), // In cents (e.g., 2550 = $25.50)
        unitCost: z.number().int().positive().optional(), // In cents (e.g., 1500 = $15.00)
        applyGst: z.boolean().default(false),
        gstRate: z.number().min(0).max(100).optional(), // GST rate as percentage (e.g., 10 for 10%)
        currentStock: z.number().min(0).default(0),
        lowStockThreshold: z.number().min(0).optional(),
        status: z.enum(['active', 'discontinued', 'out_of_stock']).default('active'),
        imageUrl: z.string().url().optional(), // R2 public URL for product image
        estimatedLossPercentage: z.number().min(0).max(100).optional(), // Processing loss percentage (0-100)
        // Optional customer-specific pricing to be created with the product
        customerPricing: z
          .array(
            z.object({
              customerId: z.string(),
              customPrice: z.number().int().positive(), // In cents
              effectiveFrom: z.date().optional(),
              effectiveTo: z.date().optional(),
            })
          )
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { customerPricing, ...productData } = input;

      // Check if SKU already exists
      const existing = await prisma.product.findUnique({
        where: { sku: productData.sku },
      });

      if (existing) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Product with this SKU already exists',
        });
      }

      // Use transaction to create product and pricing atomically
      const result = await prisma.$transaction(async (tx) => {
        // Create the product
        // Explicitly set parentProductId: null to ensure the field exists in MongoDB.
        // This is required because the getAll query filters with parentProductId: null,
        // which won't match documents where the field is missing entirely.
        const product = await tx.product.create({
          data: {
            ...productData,
            parentProductId: null,
          },
        });

        // Create customer pricing records if provided
        if (customerPricing && customerPricing.length > 0) {
          await tx.customerPricing.createMany({
            data: customerPricing.map((cp) => ({
              productId: product.id,
              customerId: cp.customerId,
              customPrice: cp.customPrice,
              effectiveFrom: cp.effectiveFrom || new Date(),
              effectiveTo: cp.effectiveTo || null,
            })),
          });
        }

        return {
          product,
          pricingCount: customerPricing?.length || 0,
        };
      });

      // Log to audit trail
      await logProductCreated(
        ctx.userId,
        undefined, // userEmail not available in context
        ctx.userRole,
        ctx.userName,
        result.product.id,
        result.product.sku,
        result.product.name,
        result.product.basePrice
      );

      return result;
    }),

  // Admin: Update product (with optional customer-specific pricing)
  // NOTE: basePrice and customPrice must be in cents (Int)
  update: requirePermission('products:edit')
    .input(
      z.object({
        productId: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        category: productCategoryEnum.optional(), // Deprecated: Use categoryId instead
        categoryId: z.string().nullish(), // null to remove category
        unit: z.enum(['kg', 'piece', 'box', 'carton']).optional(),
        packageSize: z.number().positive().optional(),
        basePrice: z.number().int().positive().optional(), // In cents
        applyGst: z.boolean().optional(),
        gstRate: z.number().min(0).max(100).nullish(), // GST rate as percentage (null to remove)
        currentStock: z.number().min(0).optional(),
        lowStockThreshold: z.number().min(0).optional(),
        status: z.enum(['active', 'discontinued', 'out_of_stock']).optional(),
        imageUrl: z.string().url().nullish(), // R2 public URL (null to remove)
        estimatedLossPercentage: z.number().min(0).max(100).nullish(), // Processing loss percentage (0-100, null to remove)
        // Optional customer-specific pricing to update with the product
        // If provided, all existing pricing will be replaced with the new array
        customerPricing: z
          .array(
            z.object({
              customerId: z.string(),
              customPrice: z.number().int().positive(), // In cents
              effectiveFrom: z.date().optional(),
              effectiveTo: z.date().optional(),
            })
          )
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { productId, customerPricing, ...updates } = input;

      // Fetch current product for change tracking
      const currentProduct = await prisma.product.findUnique({
        where: { id: productId },
        include: { parentProduct: true },
      });

      if (!currentProduct) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Product not found',
        });
      }

      // Subproduct-specific restrictions
      if (isSubproduct(currentProduct)) {
        // Cannot change unit for subproducts (must match parent)
        if (updates.unit && updates.unit !== currentProduct.unit) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cannot change unit for subproducts. Unit must match parent product.',
          });
        }

        // Cannot directly change currentStock for subproducts (it's calculated)
        if (updates.currentStock !== undefined) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cannot directly change subproduct stock. Adjust the parent product instead.',
          });
        }

        // If loss percentage changes (including switching to/from inheritance), recalculate stock
        if (updates.estimatedLossPercentage !== undefined &&
            updates.estimatedLossPercentage !== currentProduct.estimatedLossPercentage &&
            currentProduct.parentProduct) {
          const effectiveLoss = getEffectiveLossPercentage(
            updates.estimatedLossPercentage,
            currentProduct.parentProduct.estimatedLossPercentage
          );
          updates.currentStock = calculateSubproductStock(
            currentProduct.parentProduct.currentStock,
            effectiveLoss
          );
        }
      }

      // Use transaction to update product and pricing atomically
      const result = await prisma.$transaction(async (tx) => {
        // Update the product
        const product = await tx.product.update({
          where: { id: productId },
          data: updates,
        });

        // Handle customer pricing if provided
        let pricingCount = 0;
        if (customerPricing !== undefined) {
          // Delete all existing pricing for this product
          await tx.customerPricing.deleteMany({
            where: { productId },
          });

          // Create new pricing records
          if (customerPricing.length > 0) {
            await tx.customerPricing.createMany({
              data: customerPricing.map((cp) => ({
                productId,
                customerId: cp.customerId,
                customPrice: cp.customPrice,
                effectiveFrom: cp.effectiveFrom || new Date(),
                effectiveTo: cp.effectiveTo || null,
              })),
            });
            pricingCount = customerPricing.length;
          }
        }

        return { product, pricingCount };
      });

      // Cascade loss percentage changes to inheriting subproducts
      // This happens when a parent product's loss rate changes
      if (!isSubproduct(currentProduct) && 
          updates.estimatedLossPercentage !== undefined &&
          updates.estimatedLossPercentage !== currentProduct.estimatedLossPercentage) {
        // Update all inheriting subproducts (those with null estimatedLossPercentage)
        await updateSubproductStocks(
          productId,
          result.product.currentStock,
          updates.estimatedLossPercentage
        );
      }

      // Build changes array for audit log
      const changes = Object.keys(updates)
        .filter((key) => {
          const typedKey = key as keyof typeof updates;
          return updates[typedKey] !== undefined && updates[typedKey] !== currentProduct[typedKey];
        })
        .map((key) => {
          const typedKey = key as keyof typeof updates;
          return {
            field: key,
            oldValue: currentProduct[typedKey],
            newValue: updates[typedKey],
          };
        });

      // Add pricing change to audit log if pricing was updated
      if (customerPricing !== undefined) {
        changes.push({
          field: 'customerPricing',
          oldValue: 'previous pricing',
          newValue: `${result.pricingCount} custom prices`,
        });
      }

      // Log to audit trail
      if (changes.length > 0) {
        await logProductUpdated(
          ctx.userId,
          undefined, // userEmail not available in context
          ctx.userRole,
          ctx.userName,
          result.product.id,
          result.product.sku,
          changes
        );
      }

      return result.product;
    }),

  // Admin: Adjust stock level (manual stock management)
  adjustStock: requireAnyPermission(['products:adjust_stock', 'inventory:adjust'])
    .input(
      z.object({
        productId: z.string(),
        adjustmentType: z.enum([
          'stock_received',
          'stock_write_off',
        ]),
        quantity: z.number(), // Positive to add, negative to reduce
        notes: z.string().min(1, 'Notes are required'),
        // NEW: Required for stock_received
        costPerUnit: z.number().int().positive().optional(), // In cents
        expiryDate: z.date().optional(),
        // NEW: Enhanced traceability and compliance fields
        supplierInvoiceNumber: z.string().max(100).optional(),
        stockInDate: z.date().optional(),
        mtvNumber: z.string().max(50).optional(),
        vehicleTemperature: z.number().optional(),
        supplierId: z.string().optional(), // Optional supplier reference
      })
        .refine(
          (data) => {
            // If stock_received, costPerUnit is REQUIRED
            if (data.adjustmentType === 'stock_received') {
              return data.costPerUnit !== undefined;
            }
            return true;
          },
          {
            message: 'costPerUnit is required when adjustmentType is stock_received',
            path: ['costPerUnit'],
          }
        )
        .refine(
          (data) => {
            // expiryDate must be in future if provided
            if (data.expiryDate) {
              return data.expiryDate > new Date();
            }
            return true;
          },
          {
            message: 'expiryDate must be in the future',
            path: ['expiryDate'],
          }
        )
        .refine(
          (data) => {
            // If stock_received, stockInDate is REQUIRED
            if (data.adjustmentType === 'stock_received') {
              return data.stockInDate !== undefined;
            }
            return true;
          },
          {
            message: 'stockInDate is required when adjustmentType is stock_received',
            path: ['stockInDate'],
          }
        )
        .refine(
          (data) => {
            // stockInDate cannot be in the future
            if (data.stockInDate) {
              return data.stockInDate <= new Date();
            }
            return true;
          },
          {
            message: 'stockInDate cannot be in the future',
            path: ['stockInDate'],
          }
        )
        .refine(
          (data) => {
            // Vehicle temperature must be within valid range
            if (data.vehicleTemperature !== undefined) {
              return data.vehicleTemperature >= -30 && data.vehicleTemperature <= 25;
            }
            return true;
          },
          {
            message: 'Vehicle temperature must be between -30°C and 25°C',
            path: ['vehicleTemperature'],
          }
        )
        .refine(
          (data) => {
            // supplierInvoiceNumber is required for stock_received
            if (data.adjustmentType === 'stock_received') {
              return data.supplierInvoiceNumber !== undefined && data.supplierInvoiceNumber.trim() !== '';
            }
            return true;
          },
          {
            message: 'Supplier invoice number is required for stock received',
            path: ['supplierInvoiceNumber'],
          }
        )
    )
    .mutation(async ({ input, ctx }) => {
      const { productId, adjustmentType, quantity, notes, costPerUnit, expiryDate, supplierInvoiceNumber, stockInDate, mtvNumber, vehicleTemperature, supplierId } = input;

      // Get current product
      const product = await prisma.product.findUnique({
        where: { id: productId },
      });

      if (!product) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Product not found',
        });
      }

      // Reject stock adjustments on subproducts - they have virtual stock from parent
      if (isSubproduct(product)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot adjust subproduct stock directly. Adjust the parent product instead.',
        });
      }

      const previousStock = product.currentStock;
      const newStock = previousStock + quantity;

      // Prevent negative stock
      if (newStock < 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot reduce stock below zero. Current stock: ${previousStock}, requested change: ${quantity}`,
        });
      }

      // Use transaction to create inventory transaction, batch, and update product atomically
      const result = await prisma.$transaction(async (tx) => {
        // 0. Generate batch number
        const { generateBatchNumber } = await import('../services/batch-number');
        const batchNumber = await generateBatchNumber(tx, adjustmentType, supplierInvoiceNumber, supplierId);

        // 1. Create inventory transaction record
        const transaction = await tx.inventoryTransaction.create({
          data: {
            productId,
            type: 'adjustment',
            adjustmentType,
            quantity,
            previousStock,
            newStock,
            referenceType: 'manual',
            notes,
            createdBy: ctx.userId || 'system',
            // Store cost and expiry for stock_received
            costPerUnit: adjustmentType === 'stock_received' ? costPerUnit : null,
            expiryDate: adjustmentType === 'stock_received' ? expiryDate : null,
            batchNumber,
          },
        });

        // 2. If receiving stock (positive quantity): Create InventoryBatch
        if (adjustmentType === 'stock_received' && quantity > 0) {
          if (costPerUnit == null) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Cost per unit is required when receiving stock',
            });
          }
          await tx.inventoryBatch.create({
            data: {
              productId,
              quantityRemaining: quantity,
              initialQuantity: quantity,
              costPerUnit,
              receivedAt: new Date(),
              expiryDate: expiryDate || null,
              receiveTransactionId: transaction.id,
              notes,
              batchNumber,
              // Traceability and compliance fields
              supplierInvoiceNumber: supplierInvoiceNumber || null,
              stockInDate: stockInDate || null,
              mtvNumber: mtvNumber || null,
              vehicleTemperature: vehicleTemperature || null,
              supplierId: supplierId || null,
            },
          });
        }

        // 3. If reducing stock (negative quantity): Consume via FIFO
        if (quantity < 0) {
          const { consumeStock } = await import('../services/inventory-batch');
          const result = await consumeStock(
            productId,
            Math.abs(quantity),
            transaction.id,
            undefined,
            undefined,
            tx
          );

          // Log expiry warnings if any
          if (result.expiryWarnings.length > 0) {
            console.warn(
              `Expiry warnings for product ${product.sku}:`,
              result.expiryWarnings
            );
          }
        }

        // 4. Sync product stock from batch sums (defensive — replaces manual arithmetic)
        const { syncProductCurrentStock } = await import('../services/inventory-batch');
        const syncedStock = await syncProductCurrentStock(productId, tx);

        const updatedProduct = await tx.product.findUnique({ where: { id: productId } });

        // 5. Recalculate all subproduct stocks after parent stock change
        await updateSubproductStocks(productId, syncedStock, product.estimatedLossPercentage, tx);

        return { product: updatedProduct, batchNumber };
      });

      // Audit log - HIGH: Stock adjustments must be tracked
      await logStockAdjustment(ctx.userId, undefined, ctx.userRole, ctx.userName, productId, {
        sku: product.sku,
        adjustmentType,
        previousStock,
        newStock,
        quantity,
        notes,
      }).catch((error) => {
        console.error('Audit log failed for stock adjustment:', error);
      });

      return result;
    }),

  // Admin: Process stock (convert raw materials to processed products)
  processStock: requireAnyPermission(['products:adjust_stock', 'inventory:adjust'])
    .input(
      z.object({
        sourceProductId: z.string(),
        targetProductId: z.string(),
        sourceBatchId: z.string().optional(), // If provided, consume from this specific batch instead of FIFO
        sourceQuantity: z.number().positive(), // Raw material to consume (input quantity)
        targetOutputQuantity: z.number().positive(), // Desired output quantity (processed goods)
        lossPercentage: z.number().min(0).max(100).optional(), // Processing loss percentage (calculated if not provided)
        costPerUnit: z.number().int().positive(), // In cents - cost for target product
        expiryDate: z.date().optional(),
        notes: z.string().optional(),
      })
        .refine(
          (data) => {
            // Source and target must be different
            return data.sourceProductId !== data.targetProductId;
          },
          {
            message: 'Source and target products must be different',
            path: ['targetProductId'],
          }
        )
        .refine(
          (data) => {
            // Output cannot exceed input
            return data.targetOutputQuantity <= data.sourceQuantity;
          },
          {
            message: 'Output quantity cannot exceed raw material input',
            path: ['targetOutputQuantity'],
          }
        )
    )
    .mutation(async ({ input, ctx }) => {
      const { sourceProductId, targetProductId, sourceBatchId, sourceQuantity, targetOutputQuantity, lossPercentage: inputLossPercentage, costPerUnit, expiryDate, notes } = input;

      // Use transaction to process stock atomically - ALL validation inside transaction
      const result = await prisma.$transaction(async (tx) => {
        // STEP 1: Get both products INSIDE transaction (prevents TOCTOU)
        const [sourceProduct, targetProduct] = await Promise.all([
          tx.product.findUnique({
            where: { id: sourceProductId },
            include: { categoryRelation: true },
          }),
          tx.product.findUnique({ where: { id: targetProductId } }),
        ]);

        if (!sourceProduct) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Source product not found',
          });
        }

        if (!targetProduct) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Target product not found',
          });
        }

        // Block subproducts — they derive virtual stock from parent, not from Process Stock
        if (sourceProduct.parentProductId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cannot use a subproduct as source in Process Stock. Use the parent product instead.',
          });
        }
        if (targetProduct.parentProductId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cannot use a subproduct as target in Process Stock. Use the parent product instead.',
          });
        }

        // STEP 2: Use sourceQuantity directly (provided by user)
        // Calculate loss percentage if not provided: ((input - output) / input) * 100
        const calculatedLoss = sourceQuantity > 0 
          ? ((sourceQuantity - targetOutputQuantity) / sourceQuantity) * 100 
          : 0;
        const lossPercentage = inputLossPercentage ?? calculatedLoss;

        // Validate loss percentage
        if (lossPercentage < 0 || lossPercentage > 100) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Loss percentage must be between 0 and 100.',
          });
        }

        // Use sourceQuantity directly as the raw material to consume
        const requiredRawMaterial = parseFloat(sourceQuantity.toFixed(2));

        // Validate source has enough stock
        if (sourceProduct.currentStock < requiredRawMaterial) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Insufficient stock in source product. Available: ${sourceProduct.currentStock}, required: ${requiredRawMaterial}.`,
          });
        }

        // Output quantity is the target output quantity requested
        const outputQty = targetOutputQuantity;

        // Validate output is not zero
        if (outputQty <= 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Output quantity must be greater than zero.',
          });
        }

        // STEP 2.5: Generate batch number for processing
        const { generateBatchNumber } = await import('../services/batch-number');
        const batchNumber = await generateBatchNumber(tx, 'processing');

        // STEP 3: Create source InventoryTransaction (consumption)
        const sourceTransaction = await tx.inventoryTransaction.create({
          data: {
            productId: sourceProductId,
            type: 'adjustment',
            adjustmentType: 'processing', // Processing/transformation adjustment
            quantity: -requiredRawMaterial,
            previousStock: sourceProduct.currentStock,
            newStock: sourceProduct.currentStock - requiredRawMaterial,
            referenceType: 'manual',
            notes: `Processed to ${targetProduct.name} (${targetProduct.sku})${notes ? ' - ' + notes : ''}`,
            createdBy: ctx.userId || 'system',
            batchNumber,
          },
        });

        // STEP 4: Consume from source batches — specific batch or FIFO
        let consumptionResult;
        if (sourceBatchId) {
          // Validate batch belongs to source product
          const batch = await tx.inventoryBatch.findUnique({ where: { id: sourceBatchId } });
          if (!batch || batch.productId !== sourceProductId) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Selected batch does not belong to the source product',
            });
          }
          if (batch.isConsumed || batch.quantityRemaining < requiredRawMaterial) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Insufficient stock in selected batch. Available: ${batch.quantityRemaining}, required: ${requiredRawMaterial}.`,
            });
          }
          const { consumeFromBatch } = await import('../services/inventory-batch');
          consumptionResult = await consumeFromBatch(
            sourceBatchId,
            requiredRawMaterial,
            sourceTransaction.id,
            tx
          );
        } else {
          const { consumeStock } = await import('../services/inventory-batch');
          consumptionResult = await consumeStock(
            sourceProductId,
            requiredRawMaterial,
            sourceTransaction.id,
            undefined,
            undefined,
            tx
          );
        }

        // STEP 5: Sync source product stock from batch sums (defensive)
        const { syncProductCurrentStock } = await import('../services/inventory-batch');
        const syncedSourceStock = await syncProductCurrentStock(sourceProductId, tx);

        // Cascade to source subproducts
        await updateSubproductStocks(sourceProductId, syncedSourceStock, sourceProduct.estimatedLossPercentage, tx);

        // STEP 6: Create target InventoryTransaction (receipt)
        const targetTransaction = await tx.inventoryTransaction.create({
          data: {
            productId: targetProductId,
            type: 'adjustment',
            adjustmentType: 'processing',
            quantity: outputQty,
            previousStock: targetProduct.currentStock,
            newStock: targetProduct.currentStock + outputQty,
            referenceType: 'manual',
            costPerUnit: costPerUnit,
            expiryDate: expiryDate || null,
            notes: `Processed from ${sourceProduct.name} (${sourceProduct.sku})${notes ? ' - ' + notes : ''}`,
            createdBy: ctx.userId || 'system',
            batchNumber,
          },
        });

        // STEP 7: Create InventoryBatch for target product
        await tx.inventoryBatch.create({
          data: {
            productId: targetProductId,
            initialQuantity: outputQty,
            quantityRemaining: outputQty,
            costPerUnit: costPerUnit,
            receivedAt: new Date(),
            expiryDate: expiryDate || null,
            receiveTransactionId: targetTransaction.id,
            notes: `Processed from ${sourceProduct.name} - Source COGS: $${(consumptionResult.totalCost / 100).toFixed(2)}`,
            batchNumber,
          },
        });

        // STEP 8: Sync target product stock from batch sums (defensive)
        const syncedTargetStock = await syncProductCurrentStock(targetProductId, tx);

        // Cascade to target subproducts
        await updateSubproductStocks(targetProductId, syncedTargetStock, targetProduct.estimatedLossPercentage, tx);

        return {
          sourceTransaction,
          targetTransaction,
          quantityProcessed: requiredRawMaterial,
          quantityProduced: outputQty,
          lossPercentage,
          sourceCOGS: consumptionResult.totalCost,
          expiryWarnings: consumptionResult.expiryWarnings,
          sourceProduct,
          targetProduct,
        };
      });

      // Audit logs for both products (outside transaction - non-critical)
      await Promise.all([
        logStockAdjustment(ctx.userId, undefined, ctx.userRole, ctx.userName, sourceProductId, {
          sku: result.sourceProduct.sku,
          adjustmentType: 'processing',
          previousStock: result.sourceProduct.currentStock,
          newStock: result.sourceProduct.currentStock - result.quantityProcessed,
          quantity: -result.quantityProcessed,
          notes: `Processed to ${result.targetProduct.name}`,
        }).catch((error) => {
          console.error('Audit log failed for source product:', error);
        }),
        logStockAdjustment(ctx.userId, undefined, ctx.userRole, ctx.userName, targetProductId, {
          sku: result.targetProduct.sku,
          adjustmentType: 'processing',
          previousStock: result.targetProduct.currentStock,
          newStock: result.targetProduct.currentStock + result.quantityProduced,
          quantity: result.quantityProduced,
          notes: `Processed from ${result.sourceProduct.name}`,
        }).catch((error) => {
          console.error('Audit log failed for target product:', error);
        }),
      ]);

      return {
        success: true,
        sourceProduct: {
          id: result.sourceProduct.id,
          name: result.sourceProduct.name,
          sku: result.sourceProduct.sku,
          newStock: result.sourceProduct.currentStock - result.quantityProcessed,
        },
        targetProduct: {
          id: result.targetProduct.id,
          name: result.targetProduct.name,
          sku: result.targetProduct.sku,
          newStock: result.targetProduct.currentStock + result.quantityProduced,
        },
        quantityProcessed: result.quantityProcessed,
        quantityProduced: result.quantityProduced,
        lossPercentage: result.lossPercentage,
        sourceCOGS: result.sourceCOGS,
        expiryWarnings: result.expiryWarnings,
      };
    }),

  // Admin: Get stock transaction history for a product
  getStockHistory: requirePermission('inventory:view')
    .input(
      z.object({
        productId: z.string(),
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const { productId, limit, offset } = input;

      // Verify product exists
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, sku: true, currentStock: true, unit: true },
      });

      if (!product) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Product not found',
        });
      }

      // Get transaction history
      const [transactions, totalCount] = await Promise.all([
        prisma.inventoryTransaction.findMany({
          where: { productId },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.inventoryTransaction.count({
          where: { productId },
        }),
      ]);

      return {
        product,
        transactions,
        totalCount,
        hasMore: offset + transactions.length < totalCount,
      };
    }),

  // Admin: Create subproduct (derived from parent product with calculated virtual stock)
  // NOTE: basePrice and customPrice must be in cents (Int)
  createSubproduct: requirePermission('products:create')
    .input(
      z.object({
        parentProductId: z.string(), // Required: the parent product ID
        sku: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        categoryId: z.string().optional(), // Can differ from parent
        basePrice: z.number().int().positive(), // In cents
        applyGst: z.boolean().default(false),
        gstRate: z.number().min(0).max(100).optional(),
        estimatedLossPercentage: z.number().min(0).max(99).nullish(), // Optional: loss percentage 0-99% (null = inherit from parent)
        imageUrl: z.string().url().optional(),
        // Optional customer-specific pricing
        customerPricing: z
          .array(
            z.object({
              customerId: z.string(),
              customPrice: z.number().int().positive(),
              effectiveFrom: z.date().optional(),
              effectiveTo: z.date().optional(),
            })
          )
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { parentProductId, customerPricing, estimatedLossPercentage, ...subproductData } = input;

      // 1. Validate parent product exists
      const parentProduct = await prisma.product.findUnique({
        where: { id: parentProductId },
        include: { subProducts: true },
      });

      if (!parentProduct) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Parent product not found',
        });
      }

      // 2. Validate parent is not itself a subproduct (single-level nesting only)
      if (isSubproduct(parentProduct)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot create subproduct of a subproduct',
        });
      }

      // 3. Check if SKU already exists
      const existingSku = await prisma.product.findUnique({
        where: { sku: subproductData.sku },
      });

      if (existingSku) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'SKU already exists',
        });
      }

      // 4. Calculate initial virtual stock from parent using effective loss percentage
      const effectiveLossPercentage = getEffectiveLossPercentage(
        estimatedLossPercentage,
        parentProduct.estimatedLossPercentage
      );
      const initialStock = calculateSubproductStock(parentProduct.currentStock, effectiveLossPercentage);

      // Use transaction to create subproduct and pricing atomically
      const result = await prisma.$transaction(async (tx) => {
        // Create the subproduct
        const subproduct = await tx.product.create({
          data: {
            ...subproductData,
            parentProductId,
            estimatedLossPercentage,
            // Inherit unit from parent (enforced)
            unit: parentProduct.unit,
            // Set calculated virtual stock
            currentStock: initialStock,
            // Default status
            status: 'active',
          },
        });

        // Create customer pricing records if provided
        if (customerPricing && customerPricing.length > 0) {
          await tx.customerPricing.createMany({
            data: customerPricing.map((cp) => ({
              productId: subproduct.id,
              customerId: cp.customerId,
              customPrice: cp.customPrice,
              effectiveFrom: cp.effectiveFrom || new Date(),
              effectiveTo: cp.effectiveTo || null,
            })),
          });
        }

        return {
          subproduct,
          pricingCount: customerPricing?.length || 0,
        };
      });

      // Log to audit trail
      await logProductCreated(
        ctx.userId,
        undefined,
        ctx.userRole,
        ctx.userName,
        result.subproduct.id,
        result.subproduct.sku,
        result.subproduct.name,
        result.subproduct.basePrice
      );

      return {
        product: result.subproduct,
        pricingCount: result.pricingCount,
        parentProduct: {
          id: parentProduct.id,
          name: parentProduct.name,
          sku: parentProduct.sku,
        },
      };
    }),

  // Admin: Delete product (with cascade for subproducts)
  delete: requirePermission('products:delete')
    .input(z.object({ productId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { productId } = input;

      // Get product with subproducts
      const product = await prisma.product.findUnique({
        where: { id: productId },
        include: { subProducts: true },
      });

      if (!product) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Product not found',
        });
      }

      // Use transaction to delete product and subproducts atomically
      // MongoDB doesn't support cascade, so we handle it manually
      await prisma.$transaction(async (tx) => {
        // 1. Delete all subproducts first
        if (product.subProducts.length > 0) {
          // Delete customer pricing for subproducts
          await tx.customerPricing.deleteMany({
            where: { productId: { in: product.subProducts.map((sp) => sp.id) } },
          });

          // Delete subproducts
          await tx.product.deleteMany({
            where: { parentProductId: productId },
          });
        }

        // 2. Delete customer pricing for the product
        await tx.customerPricing.deleteMany({
          where: { productId },
        });

        // 3. Delete the product
        await tx.product.delete({
          where: { id: productId },
        });
      });

      // Log to audit trail
      await logProductUpdated(
        ctx.userId,
        undefined,
        ctx.userRole,
        ctx.userName,
        productId,
        product.sku,
        [{ field: 'deleted', oldValue: false, newValue: true }]
      );

      return {
        success: true,
        deletedProductId: productId,
        deletedSubproductsCount: product.subProducts.length,
      };
    }),

  // Audit stock: compare currentStock vs batch sums for all products
  auditStock: requireAnyPermission(['inventory:adjust', 'products:adjust_stock'])
    .query(async () => {
      const { getAvailableStockQuantity } = await import('../services/inventory-batch');

      // Get all parent products (non-subproducts)
      const products = await prisma.product.findMany({
        where: { parentProductId: null },
        select: { id: true, name: true, sku: true, currentStock: true, unit: true },
        orderBy: { name: 'asc' },
      });

      const results = await Promise.all(
        products.map(async (product) => {
          const batchSum = await getAvailableStockQuantity(product.id);
          const diff = product.currentStock - batchSum;
          return {
            productId: product.id,
            name: product.name,
            sku: product.sku,
            unit: product.unit,
            currentStock: product.currentStock,
            batchSum,
            diff,
            hasMismatch: Math.abs(diff) > 0.001,
          };
        })
      );

      const mismatchCount = results.filter((r) => r.hasMismatch).length;

      return {
        products: results,
        totalProducts: results.length,
        mismatchCount,
      };
    }),

  // Reconcile stock: sync all product currentStock values to match batch sums
  reconcileStock: requireAnyPermission(['inventory:adjust', 'products:adjust_stock'])
    .mutation(async ({ ctx }) => {
      const { syncCurrentStock } = await import('../services/inventory-batch');

      const discrepancies = await prisma.$transaction(async (tx) => {
        const found = await syncCurrentStock(tx);

        // Generate a single batch number for the entire reconciliation run
        if (found.length > 0) {
          const { generateBatchNumber } = await import('../services/batch-number');
          const batchNumber = await generateBatchNumber(tx, 'stock_count_correction');

          // Create audit trail for each correction
          for (const d of found) {
            await tx.inventoryTransaction.create({
              data: {
                type: 'adjustment',
                adjustmentType: 'stock_count_correction',
                productId: d.productId,
                quantity: d.batchSum - d.previousStock,
                previousStock: d.previousStock,
                newStock: d.batchSum,
                notes: `Stock reconciliation: corrected from ${d.previousStock} to ${d.batchSum} (batch sum)`,
                createdBy: ctx.userId || 'system',
                batchNumber,
              },
            });
          }
        }

        return found;
      });

      return {
        reconciledCount: discrepancies.length,
        discrepancies,
      };
    }),
});
