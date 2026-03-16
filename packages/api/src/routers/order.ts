import { z } from 'zod';
import { router, protectedProcedure, requirePermission } from '../trpc';
import { prisma } from '@joho-erp/database';
import { TRPCError } from '@trpc/server';
import { generateOrderNumber, calculateOrderTotals, paginatePrismaQuery, getEffectivePrice, createMoney, multiplyMoney, toCents, buildPrismaOrderBy, calculateParentConsumption, isSubproduct, validateStatusTransition, formatDateForMelbourne, type UserRole as StateMachineUserRole } from '@joho-erp/shared';
import { sortInputSchema } from '../schemas';
import {
  sendBackorderSubmittedEmail,
  sendBackorderApprovedEmail,
  sendBackorderRejectedEmail,
  sendBackorderPartialApprovalEmail,
  sendBackorderAdminNotification,
  sendDriverUrgentCancellationEmail,
  sendOrderConfirmationEmail,
  sendOrderConfirmedByAdminEmail,
  sendOrderOutForDeliveryEmail,
  sendOrderDeliveredEmail,
  sendOrderCancelledEmail,
  sendNewOrderNotificationEmail,
} from '../services/email';
import { clerkClient } from '@clerk/nextjs/server';
import {
  getCutoffInfo as getCutoffInfoService,
  validateOrderCutoffTime,
  isValidDeliveryDate,
  getMinDeliveryDate,
} from '../services/order-validation';
import {
  logOrderCreated,
  logOrderStatusChange,
  logOrderCancellation,
  logBackorderApproval,
  logBackorderRejection,
  logOrderConfirmation,
  logReorder,
  logResendConfirmation,
} from '../services/audit';
import { assignPreliminaryPackingSequence } from '../services/route-optimizer';
import { restoreOrderStock, reversePackingAdjustments } from '../services/stock-restoration';

// Helper: Validate stock and calculate shortfall for backorder support
interface StockValidationResult {
  requiresBackorder: boolean;
  stockShortfall: Record<string, { requested: number; available: number; shortfall: number }>;
}

function validateStockWithBackorder(
  items: Array<{ productId: string; quantity: number }>,
  products: Array<{ id: string; name: string; currentStock: number; parentProductId?: string | null; parentProduct?: { id: string; currentStock: number } | null; estimatedLossPercentage?: number | null }>
): StockValidationResult {
  const result: StockValidationResult = {
    requiresBackorder: false,
    stockShortfall: {},
  };

  // Aggregate parent consumption for subproducts sharing the same parent
  const parentConsumptions = new Map<string, { total: number; parentStock: number; items: Array<{ productId: string; quantity: number; lossPercentage: number }> }>();

  for (const item of items) {
    const product = products.find((p) => p.id === item.productId);
    if (!product) continue;

    const productIsSubproduct = isSubproduct(product);

    if (productIsSubproduct && product.parentProduct) {
      const lossPercentage = product.estimatedLossPercentage ?? 0;
      const requiredFromParent = calculateParentConsumption(item.quantity, lossPercentage);
      const parentId = product.parentProduct.id;
      const existing = parentConsumptions.get(parentId) || { total: 0, parentStock: product.parentProduct.currentStock, items: [] };
      existing.total += requiredFromParent;
      existing.items.push({ productId: item.productId, quantity: item.quantity, lossPercentage });
      parentConsumptions.set(parentId, existing);
    } else {
      // Regular product — check directly
      if (product.currentStock < item.quantity) {
        result.requiresBackorder = true;
        result.stockShortfall[item.productId] = {
          requested: item.quantity,
          available: product.currentStock,
          shortfall: item.quantity - product.currentStock,
        };
      }
    }
  }

  // Check aggregated parent consumption
  for (const [_parentId, { total, parentStock, items: subItems }] of parentConsumptions) {
    if (parentStock < total) {
      // Mark each subproduct item as having a shortfall
      for (const subItem of subItems) {
        const availableForSubproduct = Math.floor(parentStock * (1 - subItem.lossPercentage / 100));
        result.requiresBackorder = true;
        result.stockShortfall[subItem.productId] = {
          requested: subItem.quantity,
          available: availableForSubproduct,
          shortfall: subItem.quantity - availableForSubproduct,
        };
      }
    }
  }

  return result;
}

// Helper: Get user display name and email from Clerk
interface UserDetails {
  changedByName: string | null;
  changedByEmail: string | null;
}

async function getUserDetails(userId: string): Promise<UserDetails> {
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const changedByName = user.firstName && user.lastName
      ? `${user.firstName} ${user.lastName}`
      : null;
    const changedByEmail = user.emailAddresses[0]?.emailAddress || null;
    return { changedByName, changedByEmail };
  } catch (error) {
    console.error('Failed to fetch user details:', error);
    return { changedByName: null, changedByEmail: null };
  }
}

// Helper: Calculate available credit for a customer
// Pending backorders don't count against credit limit (only approved ones do)
// Accepts optional transaction context for atomic credit checking
export async function calculateAvailableCredit(
  customerId: string,
  creditLimit: number,
  tx?: { order: typeof prisma.order }
): Promise<number> {
  const db = tx || prisma;

  // Use atomic aggregation instead of findMany + reduce to prevent race conditions
  // This is a single database operation that returns the sum
  const result = await db.order.aggregate({
    where: {
      customerId,
      // Exclude awaiting_approval (pending backorders) - they don't count until approved
      // Exclude delivered (invoiced) and cancelled orders
      status: {
        in: ['confirmed', 'packing', 'ready_for_delivery', 'out_for_delivery'],
      },
    },
    _sum: {
      totalAmount: true,
    },
  });

  // Get the outstanding balance (null means no orders found)
  const outstandingBalance = result._sum.totalAmount || 0;

  // Calculate available credit
  const availableCredit = creditLimit - outstandingBalance;

  return availableCredit;
}


/**
 * Helper function to geocode an address and get coordinates
 * Returns coordinates from Mapbox, or falls back to SuburbAreaMapping
 */
async function geocodeAddressCoordinates(address: {
  street: string;
  suburb: string;
  state: string;
  postcode: string;
}): Promise<{ latitude: number | null; longitude: number | null }> {
  let latitude: number | null = null;
  let longitude: number | null = null;

  // Try Mapbox geocoding first
  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (mapboxToken) {
    try {
      const fullAddress = `${address.street}, ${address.suburb}, ${address.state} ${address.postcode}, Australia`;
      const encodedAddress = encodeURIComponent(fullAddress);
      const geocodeUrl = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodedAddress}&access_token=${mapboxToken}&country=AU&limit=1&types=address,secondary_address`;

      const geocodeResponse = await fetch(geocodeUrl);
      if (geocodeResponse.ok) {
        const geocodeData = await geocodeResponse.json();
        if (geocodeData.features && geocodeData.features.length > 0) {
          const feature = geocodeData.features[0];
          latitude = feature.properties.coordinates.latitude;
          longitude = feature.properties.coordinates.longitude;
        }
      }
    } catch (geocodeError) {
      console.warn('Server-side geocoding failed:', geocodeError);
    }
  }

  // Fallback to SuburbAreaMapping coordinates if geocoding didn't work
  if (latitude === null || longitude === null) {
    const suburbMapping = await prisma.suburbAreaMapping.findFirst({
      where: {
        suburb: { equals: address.suburb, mode: 'insensitive' },
        state: address.state,
        isActive: true,
      },
    });
    if (suburbMapping) {
      latitude = suburbMapping.latitude;
      longitude = suburbMapping.longitude;
    }
  }

  return { latitude, longitude };
}

// Helper: Get outstanding balance for a customer
export async function getOutstandingBalance(customerId: string): Promise<number> {
  // Use atomic aggregation instead of findMany + reduce to prevent race conditions
  const result = await prisma.order.aggregate({
    where: {
      customerId,
      // Include awaiting_approval to prevent customers from exceeding credit (Issue #9 fix)
      // Pending backorders count against credit to prevent over-ordering while approval is pending
      // Note: This is intentionally different from calculateAvailableCredit which excludes awaiting_approval
      // because that function is used during backorder approval when we need the committed credit only
      status: {
        in: ['awaiting_approval', 'confirmed', 'packing', 'ready_for_delivery', 'out_for_delivery'],
      },
    },
    _sum: {
      totalAmount: true,
    },
  });

  return result._sum.totalAmount || 0;
}

export const orderRouter = router({
  // Create order
  create: protectedProcedure
    .input(
      z.object({
        customerId: z.string().optional(), // For admin placing on behalf
        items: z
          .array(
            z.object({
              productId: z.string(),
              quantity: z.number().min(0.01).max(10000),
            })
          )
          .min(1, 'At least one item is required'),
        deliveryAddress: z
          .object({
            street: z.string(),
            suburb: z.string(),
            state: z.string(),
            postcode: z.string(),
            areaId: z.string().optional(),
            deliveryInstructions: z.string().optional(),
          })
          .optional(),
        requestedDeliveryDate: z.date().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Get customer based on how the ID was provided
      let customer;

      if (input.customerId) {
        // Admin provided a customerId - could be MongoDB ObjectID or Clerk user ID
        // First try as MongoDB ObjectID, then as Clerk user ID
        if (input.customerId.startsWith('user_')) {
          // It's a Clerk user ID
          customer = await prisma.customer.findUnique({
            where: { clerkUserId: input.customerId },
          });
        } else if (/^[a-fA-F0-9]{24}$/.test(input.customerId)) {
          // It's a valid MongoDB ObjectID format
          customer = await prisma.customer.findUnique({
            where: { id: input.customerId },
          });
        } else {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Invalid customer ID format',
          });
        }
      } else {
        // Customer placing their own order - ctx.userId is their Clerk user ID
        customer = await prisma.customer.findUnique({
          where: { clerkUserId: ctx.userId },
        });
      }

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      // Check if customer is suspended
      if (customer.status === 'suspended') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Your account is suspended. Please contact support for assistance.',
        });
      }

      // Check if onboarding is complete
      if (!customer.onboardingComplete) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Please complete your registration before placing orders.',
        });
      }

      // Check credit approval
      if (customer.creditApplication.status !== 'approved') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Your credit application is pending approval. You can browse products and add to cart, but orders cannot be placed until your credit is approved.',
        });
      }

      // Defensive: Validate all items have productId
      const invalidItems = input.items.filter((item) => !item.productId);
      if (invalidItems.length > 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'All order items must have a valid productId',
        });
      }

      // Get products and validate stock (include parent product for subproducts)
      const productIds = input.items.map((item) => item.productId);
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        include: { parentProduct: true },
      });

      if (products.length !== input.items.length) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'One or more products not found',
        });
      }

      // Get customer-specific pricing for all products
      const customerPricings = await prisma.customerPricing.findMany({
        where: {
          customerId: customer.id,
          productId: { in: productIds },
        },
      });

      // Create a map of product ID to custom pricing
      const pricingMap = new Map(customerPricings.map((p) => [p.productId, p]));

      // Validate stock and check if backorder is needed
      const stockValidation = validateStockWithBackorder(input.items, products);

      // Build order items with prices (using customer-specific pricing if available)
      const orderItems = input.items.map((item) => {
        const product = products.find((p) => p.id === item.productId);
        if (!product) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Product not found',
          });
        }

        // Get effective price (custom or base price) - already in cents
        const customPricing = pricingMap.get(product.id);
        const priceInfo = getEffectivePrice(product.basePrice, customPricing);
        const effectivePrice = priceInfo.effectivePrice; // In cents

        // Calculate item subtotal using dinero.js for precision
        const priceMoney = createMoney(effectivePrice);
        const itemSubtotalMoney = multiplyMoney(priceMoney, item.quantity);
        const itemSubtotal = toCents(itemSubtotalMoney);

        return {
          productId: product.id,
          parentProductId: product.parentProductId ?? null,
          sku: product.sku,
          productName: product.name,
          unit: product.unit,
          quantity: item.quantity,
          unitPrice: effectivePrice, // In cents
          subtotal: itemSubtotal, // In cents
          applyGst: product.applyGst,
          gstRate: product.gstRate,
          // Store loss % at order time for subproduct stock calculations (Issue #10 fix)
          estimatedLossPercentage: product.estimatedLossPercentage ?? null,
        };
      });

      // Reject orders with zero-price items (Issue #20 fix)
      const zeroItems = orderItems.filter((item) => item.unitPrice === 0);
      if (zeroItems.length > 0) {
        const zeroItemNames = zeroItems.map((i) => `${i.productName} (${i.sku})`).join(', ');
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot create order with zero-price items: ${zeroItemNames}. Please contact sales to set pricing.`,
        });
      }

      // Calculate totals using per-product GST settings
      const totals = calculateOrderTotals(orderItems);

      // Run independent checks in parallel: credit, company settings, and min delivery date
      const creditLimit = customer.creditApplication.creditLimit; // In cents
      const deliveryAddress = input.deliveryAddress || customer.deliveryAddress;
      const areaName = 'areaName' in deliveryAddress
        ? (deliveryAddress.areaName ?? undefined)
        : (customer.deliveryAddress.areaName ?? undefined);

      const [availableCredit, company, minDeliveryDate] = await Promise.all([
        calculateAvailableCredit(customer.id, creditLimit),
        prisma.company.findFirst({ select: { deliverySettings: true } }),
        getMinDeliveryDate(areaName),
      ]);

      if (totals.totalAmount > availableCredit) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Order total ($${(totals.totalAmount / 100).toFixed(2)}) exceeds available credit ($${(availableCredit / 100).toFixed(2)}). Please contact sales.`,
        });
      }

      const minimumOrderAmount = company?.deliverySettings?.minimumOrderAmount;

      if (minimumOrderAmount && totals.totalAmount < minimumOrderAmount) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Order total ($${(totals.totalAmount / 100).toFixed(2)}) does not meet the minimum order requirement ($${(minimumOrderAmount / 100).toFixed(2)}). Please add more items to your order.`,
        });
      }

      // Generate order number
      const orderNumber = generateOrderNumber();
      const deliveryDate = input.requestedDeliveryDate || minDeliveryDate;

      // Check if delivery date is Sunday
      if (deliveryDate.getDay() === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Sunday deliveries are not available. Please select a weekday (Monday-Saturday).',
        });
      }

      // Validate delivery date is not in the past and is at or after minimum date
      const isValidDate = await isValidDeliveryDate(deliveryDate, areaName);
      if (!isValidDate) {
        const minDateStr = minDeliveryDate.toLocaleDateString('en-AU');
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `The requested delivery date is not available. The earliest available delivery date is ${minDateStr}. Please select a valid date.`,
        });
      }

      // Validate cutoff time for next-day delivery
      const cutoffValidation = await validateOrderCutoffTime(deliveryDate, areaName);
      if (cutoffValidation.isAfterCutoff) {
        // Cutoff has passed for the requested delivery date
        const nextDateStr = cutoffValidation.nextAvailableDeliveryDate.toLocaleDateString('en-AU');
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Order cutoff time (${cutoffValidation.cutoffTime}) has passed for the requested delivery date. The next available delivery date is ${nextDateStr}. Please select a later delivery date or contact us for assistance.`,
        });
      }

      // Create order with stock reservation in a transaction
      // Get user details for status history
      const userDetails = await getUserDetails(ctx.userId);

      // For normal orders: Reduce stock immediately
      // For backorders: Stock is NOT reduced (only when approved)
      const order = await prisma.$transaction(async (tx) => {
        // Re-fetch products with fresh stock data inside transaction to prevent race conditions
        const freshProducts = await tx.product.findMany({
          where: { id: { in: productIds } },
          select: {
            id: true,
            name: true,
            currentStock: true,
            status: true,
            parentProductId: true,
          },
        });

        // Re-validate stock with fresh data
        const freshStockValidation = validateStockWithBackorder(input.items, freshProducts);

        // Check if stock situation changed (was available, now requires backorder)
        if (!stockValidation.requiresBackorder && freshStockValidation.requiresBackorder) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Stock availability changed. Some items are no longer in stock. Please review your order.',
          });
        }

        // Re-check credit limit with fresh data inside transaction to prevent race conditions
        const freshAvailableCredit = await calculateAvailableCredit(customer.id, creditLimit, tx);
        if (totals.totalAmount > freshAvailableCredit) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Credit limit exceeded. Another order was placed. Available credit: $${(freshAvailableCredit / 100).toFixed(2)}`,
          });
        }

        // Create the order using fresh validation
        const newOrder = await tx.order.create({
          data: {
            orderNumber,
            customerId: customer.id,
            customerName: customer.businessName,
            items: orderItems,
            subtotal: totals.subtotal,
            taxAmount: totals.taxAmount,
            totalAmount: totals.totalAmount,
            deliveryAddress,
            requestedDeliveryDate: deliveryDate,
            status: freshStockValidation.requiresBackorder ? 'awaiting_approval' : 'confirmed',
            statusHistory: [
              {
                status: freshStockValidation.requiresBackorder ? 'awaiting_approval' : 'confirmed',
                changedAt: new Date(),
                changedBy: ctx.userId,
                changedByName: userDetails.changedByName,
                changedByEmail: userDetails.changedByEmail,
                notes: freshStockValidation.requiresBackorder
                  ? 'Order created - Awaiting approval due to insufficient stock'
                  : 'Order created and confirmed',
              },
            ],
            orderedAt: new Date(),
            createdBy: ctx.userId,

            // Backorder fields (stockShortfall presence indicates backorder)
            stockShortfall: freshStockValidation.requiresBackorder
              ? freshStockValidation.stockShortfall
              : undefined,
          },
        });

        // Stock is NOT reduced at order creation
        // Stock reduction happens at packing step (markOrderReady) to allow for quantity adjustments

        return { order: newOrder, stockValidationResult: freshStockValidation };
      });

      // Send backorder notification emails if required
      if (order.stockValidationResult.requiresBackorder) {
        // Prepare stock shortfall data for email
        const stockShortfallArray = Object.entries(order.stockValidationResult.stockShortfall).map(
          ([productId, data]) => {
            const product = products.find((p) => p.id === productId);
            return {
              productName: product?.name || 'Unknown Product',
              sku: product?.sku || productId,
              requested: data.requested,
              available: data.available,
              shortfall: data.shortfall,
              unit: product?.unit || 'units',
            };
          }
        );

        // Send notification to customer
        void sendBackorderSubmittedEmail({
          customerEmail: customer.contactPerson.email,
          customerName: customer.businessName,
          orderNumber: order.order.orderNumber,
          orderDate: order.order.orderedAt,
          totalAmount: order.order.totalAmount,
          stockShortfall: stockShortfallArray,
        }).catch((error) => {
          console.error('Failed to send backorder submitted email to customer:', error);
        });

        // Send notification to admin
        void sendBackorderAdminNotification({
          orderNumber: order.order.orderNumber,
          customerName: customer.businessName,
          totalAmount: order.order.totalAmount,
          stockShortfall: stockShortfallArray,
        }).catch((error) => {
          console.error('Failed to send backorder admin notification:', error);
        });
      }

      // Send order confirmation email (for non-backorder orders)
      if (!order.stockValidationResult.requiresBackorder) {
        void sendOrderConfirmationEmail({
          customerEmail: customer.contactPerson.email,
          customerName: customer.businessName,
          orderNumber: order.order.orderNumber,
          orderDate: order.order.orderedAt,
          requestedDeliveryDate: deliveryDate,
          items: orderItems.map((item) => ({
            productName: item.productName,
            sku: item.sku,
            quantity: item.quantity,
            unit: item.unit,
            unitPrice: item.unitPrice,
            subtotal: item.subtotal,
          })),
          subtotal: totals.subtotal,
          taxAmount: totals.taxAmount,
          totalAmount: totals.totalAmount,
          deliveryAddress: {
            street: deliveryAddress.street,
            suburb: deliveryAddress.suburb,
            state: deliveryAddress.state,
            postcode: deliveryAddress.postcode,
          },
        }).catch((error) => {
          console.error('Failed to send order confirmation email:', error);
        });
      }

      // Log order creation to audit trail
      void logOrderCreated(
        ctx.userId,
        order.order.id,
        order.order.orderNumber,
        customer.id,
        order.order.totalAmount
      ).catch((error) => {
        console.error('Failed to log order creation:', error);
      });

      return order.order;
    }),

  // Create order on behalf of customer (Admin only)
  createOnBehalf: requirePermission('orders:create')
    .input(
      z.object({
        customerId: z.string(), // Required - which customer to place order for
        items: z
          .array(
            z.object({
              productId: z.string(),
              quantity: z.number().min(0.01).max(10000),
            })
          )
          .min(1, 'At least one item is required'),

        // Address handling
        useCustomAddress: z.boolean().default(false),
        customDeliveryAddress: z
          .object({
            street: z.string().min(1),
            suburb: z.string().min(1),
            state: z.string(),
            postcode: z.string(),
            areaId: z.string().optional(),
            deliveryInstructions: z.string().optional(),
            latitude: z.number().optional(),
            longitude: z.number().optional(),
          })
          .optional(),

        // Bypass options
        bypassCreditLimit: z.boolean().default(false),
        bypassCreditReason: z.string().optional(),
        bypassCutoffTime: z.boolean().default(false),
        bypassMinimumOrder: z.boolean().default(false),

        // Notes
        adminNotes: z.string().optional(),
        internalNotes: z.string().optional(),

        // Optional delivery date
        requestedDeliveryDate: z.date().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // 0. Validate role for bypass flags - only admin/manager can use bypass options
      if (input.bypassCreditLimit || input.bypassCutoffTime || input.bypassMinimumOrder) {
        if (!['admin', 'manager'].includes(ctx.userRole)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only admin or manager roles can bypass order restrictions',
          });
        }
      }

      // 1. Validate customer exists
      const customer = await prisma.customer.findUnique({
        where: { id: input.customerId },
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      // 2. Validate bypass reason if credit limit is bypassed
      if (input.bypassCreditLimit && !input.bypassCreditReason) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Bypass reason is required when bypassing credit limit',
        });
      }

      // 3. Validate custom address if using custom address
      if (input.useCustomAddress && !input.customDeliveryAddress) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Custom delivery address is required when useCustomAddress is true',
        });
      }

      // 4. Validate products and check stock (include parent product for subproducts)
      const productIds = input.items.map((item) => item.productId);
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        include: { parentProduct: true },
      });

      if (products.length !== input.items.length) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'One or more products not found',
        });
      }

      // 5. Get customer-specific pricing
      const customerPricings = await prisma.customerPricing.findMany({
        where: {
          customerId: customer.id,
          productId: { in: productIds },
        },
      });

      const pricingMap = new Map(customerPricings.map((p) => [p.productId, p]));

      // 6. Validate stock and check if backorder is needed
      const stockValidation = validateStockWithBackorder(input.items, products);

      // 7. Build order items with prices
      const orderItems = input.items.map((item) => {
        const product = products.find((p) => p.id === item.productId);
        if (!product) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Product not found',
          });
        }

        // Get effective price
        const customPricing = pricingMap.get(product.id);
        const priceInfo = getEffectivePrice(product.basePrice, customPricing);
        const effectivePrice = priceInfo.effectivePrice; // In cents

        // Calculate item subtotal
        const priceMoney = createMoney(effectivePrice);
        const itemSubtotalMoney = multiplyMoney(priceMoney, item.quantity);
        const itemSubtotal = toCents(itemSubtotalMoney);

        return {
          productId: product.id,
          parentProductId: product.parentProductId ?? null,
          sku: product.sku,
          productName: product.name,
          unit: product.unit,
          quantity: item.quantity,
          unitPrice: effectivePrice, // In cents
          subtotal: itemSubtotal, // In cents
          applyGst: product.applyGst,
          gstRate: product.gstRate,
          // Store loss % at order time for subproduct stock calculations (Issue #10 fix)
          estimatedLossPercentage: product.estimatedLossPercentage ?? null,
        };
      });

      // Reject orders with zero-price items (Issue #20 fix)
      const zeroItems = orderItems.filter((item) => item.unitPrice === 0);
      if (zeroItems.length > 0) {
        const zeroItemNames = zeroItems.map((i) => `${i.productName} (${i.sku})`).join(', ');
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot create order with zero-price items: ${zeroItemNames}. Please set pricing for these products.`,
        });
      }

      // 8. Calculate totals using per-product GST settings
      const totals = calculateOrderTotals(orderItems);

      // 9. Check credit limit (unless bypassed) - exclude pending backorders from calculation
      if (!input.bypassCreditLimit) {
        const creditLimit = customer.creditApplication.creditLimit; // In cents
        const availableCredit = await calculateAvailableCredit(customer.id, creditLimit);

        if (totals.totalAmount > availableCredit) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Order total ($${(totals.totalAmount / 100).toFixed(2)}) exceeds available credit ($${(availableCredit / 100).toFixed(2)})`,
          });
        }
      }

      // 10. Check minimum order amount (unless bypassed)
      if (!input.bypassMinimumOrder) {
        const company = await prisma.company.findFirst({
          select: { deliverySettings: true },
        });
        const minimumOrderAmount = company?.deliverySettings?.minimumOrderAmount;

        if (minimumOrderAmount && totals.totalAmount < minimumOrderAmount) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Order total ($${(totals.totalAmount / 100).toFixed(2)}) does not meet the minimum order requirement ($${(minimumOrderAmount / 100).toFixed(2)})`,
          });
        }
      }

      // 10. Generate order number
      const orderNumber = generateOrderNumber();

      // 11. Determine delivery date
      let deliveryDate = input.requestedDeliveryDate;

      if (!deliveryDate) {
        // Default to tomorrow (cutoff bypass doesn't matter if no specific date requested)
        deliveryDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      }

      // 12. Determine delivery address (with geocoding for custom addresses)
      let deliveryAddress;
      if (input.useCustomAddress && input.customDeliveryAddress) {
        let { latitude, longitude } = input.customDeliveryAddress;

        // Geocode if no valid coordinates provided
        if (!latitude || !longitude || latitude === 0 || longitude === 0) {
          const coords = await geocodeAddressCoordinates({
            street: input.customDeliveryAddress.street,
            suburb: input.customDeliveryAddress.suburb,
            state: input.customDeliveryAddress.state,
            postcode: input.customDeliveryAddress.postcode,
          });
          latitude = coords.latitude ?? undefined;
          longitude = coords.longitude ?? undefined;
        }

        // Look up area for the suburb if not provided
        let areaId: string | null | undefined = input.customDeliveryAddress.areaId;
        let areaName: string | undefined;
        if (!areaId) {
          const suburbMapping = await prisma.suburbAreaMapping.findFirst({
            where: {
              suburb: { equals: input.customDeliveryAddress.suburb, mode: 'insensitive' },
              state: input.customDeliveryAddress.state,
              isActive: true,
            },
            include: { area: true },
          });
          if (suburbMapping?.area && suburbMapping.areaId) {
            areaId = suburbMapping.areaId;
            areaName = suburbMapping.area.name;
          }
        }

        deliveryAddress = {
          street: input.customDeliveryAddress.street,
          suburb: input.customDeliveryAddress.suburb,
          state: input.customDeliveryAddress.state,
          postcode: input.customDeliveryAddress.postcode,
          country: 'Australia',
          areaId,
          areaName,
          deliveryInstructions: input.customDeliveryAddress.deliveryInstructions,
          latitude,
          longitude,
        };
      } else {
        deliveryAddress = customer.deliveryAddress;
      }

      // 13. Get user details for status history
      const userDetails = await getUserDetails(ctx.userId);

      // 15. Create order with stock reservation in a transaction
      // For normal orders: Reduce stock immediately
      // For backorders: Stock is NOT reduced (only when approved)
      const order = await prisma.$transaction(async (tx) => {
        // Create the order
        const newOrder = await tx.order.create({
          data: {
            orderNumber,
            customerId: customer.id,
            customerName: customer.businessName,
            items: orderItems,
            subtotal: totals.subtotal,
            taxAmount: totals.taxAmount,
            totalAmount: totals.totalAmount,
            deliveryAddress,
            requestedDeliveryDate: deliveryDate,
            status: stockValidation.requiresBackorder ? 'awaiting_approval' : 'confirmed',
            statusHistory: [
              {
                status: stockValidation.requiresBackorder ? 'awaiting_approval' : 'confirmed',
                changedAt: new Date(),
                changedBy: ctx.userId,
                changedByName: userDetails.changedByName,
                changedByEmail: userDetails.changedByEmail,
                notes: stockValidation.requiresBackorder
                  ? 'Order placed by admin - Awaiting approval due to insufficient stock'
                  : 'Order placed by admin on behalf of customer',
              },
            ],
            orderedAt: new Date(),
            createdBy: ctx.userId,

            // Admin-specific fields
            bypassCreditLimit: input.bypassCreditLimit,
            bypassCreditReason: input.bypassCreditReason,
            bypassCutoffTime: input.bypassCutoffTime,
            bypassMinimumOrder: input.bypassMinimumOrder,
            useCustomAddress: input.useCustomAddress,
            customDeliveryAddress: input.useCustomAddress && input.customDeliveryAddress
              ? deliveryAddress  // Use the already geocoded deliveryAddress
              : undefined,
            adminNotes: input.adminNotes,
            internalNotes: input.internalNotes,
            placedOnBehalfOf: customer.id,
            placedByAdmin: ctx.userId,

            // Backorder fields (stockShortfall presence indicates backorder)
            stockShortfall: stockValidation.requiresBackorder
              ? stockValidation.stockShortfall
              : undefined,
          },
        });

        // Stock is NOT reduced at order creation
        // Stock reduction happens at packing step (markOrderReady) to allow for quantity adjustments

        return newOrder;
      });

      // Assign preliminary packing sequence for non-backorder orders (confirmed immediately)
      if (!stockValidation.requiresBackorder) {
        await assignPreliminaryPackingSequence(deliveryDate, order.id, deliveryAddress?.areaName ?? null);
      }

      // Send order confirmation email to customer (for non-backorder orders)
      if (!stockValidation.requiresBackorder) {
        const deliveryAddr = deliveryAddress as {
          street: string;
          suburb: string;
          state: string;
          postcode: string;
        };

        void sendOrderConfirmationEmail({
          customerEmail: customer.contactPerson.email,
          customerName: customer.businessName,
          orderNumber: order.orderNumber,
          orderDate: order.orderedAt,
          requestedDeliveryDate: deliveryDate,
          items: orderItems.map((item) => ({
            productName: item.productName,
            sku: item.sku,
            quantity: item.quantity,
            unit: item.unit,
            unitPrice: item.unitPrice,
            subtotal: item.subtotal,
          })),
          subtotal: totals.subtotal,
          taxAmount: totals.taxAmount,
          totalAmount: totals.totalAmount,
          deliveryAddress: {
            street: deliveryAddr.street,
            suburb: deliveryAddr.suburb,
            state: deliveryAddr.state,
            postcode: deliveryAddr.postcode,
          },
        }).catch((error) => {
          console.error('Failed to send order confirmation email:', error);
        });
      }

      // Log order creation to audit trail
      void logOrderCreated(
        ctx.userId,
        order.id,
        order.orderNumber,
        customer.id,
        order.totalAmount
      ).catch((error) => {
        console.error('Failed to log order creation:', error);
      });

      return order;
    }),

  // Get customer's orders
  getMyOrders: protectedProcedure
    .input(
      z.object({
        status: z.string().optional(),
        search: z.string().optional(), // Search by order number
        dateFrom: z.date().optional(),
        dateTo: z.date().optional(),
        page: z.number().default(1),
        limit: z.number().default(20),
      })
    )
    .query(async ({ input, ctx }) => {
      // Get customer
      const customer = await prisma.customer.findUnique({
        where: { clerkUserId: ctx.userId },
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      const where: any = { customerId: customer.id };

      if (input.status) {
        where.status = input.status;
      }

      // Search by order number (case-insensitive contains)
      if (input.search) {
        where.orderNumber = {
          contains: input.search,
          mode: 'insensitive',
        };
      }

      if (input.dateFrom || input.dateTo) {
        where.orderedAt = {};
        if (input.dateFrom) where.orderedAt.gte = input.dateFrom;
        if (input.dateTo) where.orderedAt.lte = input.dateTo;
      }

      const result = await paginatePrismaQuery(prisma.order, where, {
        page: input.page,
        limit: input.limit,
        orderBy: { orderedAt: 'desc' },
      });

      return {
        orders: result.items,
        total: result.total,
        page: result.page,
        totalPages: result.totalPages,
      };
    }),

  // Get all orders (admin)
  getAll: requirePermission('orders:view')
    .input(
      z
        .object({
          status: z.string().optional(),
          customerId: z.string().optional(),
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          areaId: z.string().optional(),
          search: z.string().optional(),
          page: z.number().default(1),
          limit: z.number().default(20),
        })
        .merge(sortInputSchema)
    )
    .query(async ({ input }) => {
      const { page, limit, sortBy, sortOrder, search, ...filters } = input;
      const where: any = {};

      if (filters.status) where.status = filters.status;
      if (filters.customerId) where.customerId = filters.customerId;

      if (filters.areaId) {
        where.deliveryAddress = {
          is: { areaId: filters.areaId },
        };
      }

      if (filters.dateFrom || filters.dateTo) {
        where.requestedDeliveryDate = {};
        if (filters.dateFrom) where.requestedDeliveryDate.gte = filters.dateFrom;
        if (filters.dateTo) where.requestedDeliveryDate.lte = filters.dateTo;
      }

      // Add search functionality
      if (search) {
        where.OR = [
          { orderNumber: { contains: search, mode: 'insensitive' } },
          { customer: { businessName: { contains: search, mode: 'insensitive' } } },
        ];
      }

      // Build orderBy from sort parameters
      const orderSortFieldMapping: Record<string, string> = {
        orderNumber: 'orderNumber',
        orderedAt: 'orderedAt',
        requestedDeliveryDate: 'requestedDeliveryDate',
        totalAmount: 'totalAmount',
        status: 'status',
        customer: 'customer.businessName',
      };

      const orderBy =
        sortBy && orderSortFieldMapping[sortBy]
          ? buildPrismaOrderBy(sortBy, sortOrder, orderSortFieldMapping)
          : { orderedAt: 'desc' as const };

      const result = await paginatePrismaQuery(prisma.order, where, {
        page,
        limit,
        orderBy,
      });

      return {
        orders: result.items,
        total: result.total,
        page: result.page,
        totalPages: result.totalPages,
      };
    }),

  // Get order by ID
  getById: protectedProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input, ctx }) => {
      const order = await prisma.order.findUnique({
        where: { id: input.orderId },
      });

      if (!order) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Order not found',
        });
      }

      // Role-based data isolation: customers can only view their own orders
      if (ctx.userRole === 'customer') {
        // Get customer to verify ownership
        const customer = await prisma.customer.findUnique({
          where: { clerkUserId: ctx.userId },
        });

        if (!customer) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Customer not found',
          });
        }

        // Verify the order belongs to the authenticated customer
        if (order.customerId !== customer.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Insufficient permissions to access this resource',
          });
        }
      }
      // Admin, Sales, and Manager roles can view all orders (no additional check needed)

      return order;
    }),

  // Update order status
  updateStatus: requirePermission('orders:edit')
    .input(
      z.object({
        orderId: z.string(),
        newStatus: z.enum([
          'awaiting_approval',
          'confirmed',
          'packing',
          'ready_for_delivery',
          'out_for_delivery',
          'delivered',
          'cancelled',
        ]),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Get user details for status history (safe to fetch outside transaction)
      const userDetails = await getUserDetails(ctx.userId);

      // Wrap entire operation in transaction with atomic guard
      const result = await prisma.$transaction(async (tx) => {
        // STEP 1: Fetch current order INSIDE transaction
        const currentOrder = await tx.order.findUnique({
          where: { id: input.orderId },
        });

        if (!currentOrder) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Order not found',
          });
        }

        // STEP 2: Check for idempotency first
        if (currentOrder.status === input.newStatus) {
          return { order: currentOrder, alreadyCompleted: true, originalStatus: currentOrder.status };
        }

        // Validate status transition using state machine
        const transitionValidation = validateStatusTransition(
          currentOrder.status as Parameters<typeof validateStatusTransition>[0],
          input.newStatus,
          ctx.userRole as StateMachineUserRole
        );
        if (!transitionValidation.valid) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: transitionValidation.error || 'Invalid status transition',
          });
        }

        // Block backward transitions that have dedicated endpoints with stock/state cleanup
        const TRANSITIONS_WITH_DEDICATED_HANDLERS: Record<string, { targetStatuses: string[]; endpoint: string }> = {
          packing: { targetStatuses: ['confirmed'], endpoint: 'resetOrder' },
          ready_for_delivery: { targetStatuses: ['packing'], endpoint: 'resetOrder' },
          out_for_delivery: { targetStatuses: ['ready_for_delivery'], endpoint: 'returnToWarehouse' },
        };

        const dedicatedHandler = TRANSITIONS_WITH_DEDICATED_HANDLERS[currentOrder.status];
        if (dedicatedHandler?.targetStatuses.includes(input.newStatus)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Cannot transition from ${currentOrder.status} to ${input.newStatus} via status update. Use the ${dedicatedHandler.endpoint} endpoint instead.`,
          });
        }

        // STEP 3: Atomic guard - use updateMany with current status condition
        const updateResult = await tx.order.updateMany({
          where: {
            id: input.orderId,
            status: currentOrder.status, // Atomic guard - must still be at current status
          },
          data: {
            status: input.newStatus,
          },
        });

        if (updateResult.count === 0) {
          // Race condition - another process changed the status
          const recheck = await tx.order.findUnique({ where: { id: input.orderId } });
          if (recheck?.status === input.newStatus) {
            return { order: recheck, alreadyCompleted: true, originalStatus: currentOrder.status };
          }
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Order status was changed by another process. Please refresh and try again.',
          });
        }

        // Handle stock restoration when cancelling
        let shouldRestoreStock = false;
        const wasDelivered = currentOrder.status === 'delivered';
        if (input.newStatus === 'cancelled') {
          // Skip stock restoration and packing reversal for delivered orders
          // Goods are already with the customer, stock cannot be restored
          if (!wasDelivered) {
            if (currentOrder.stockConsumed === true) {
              shouldRestoreStock = true;
              // STEP 4: Atomic guard for stock restoration - prevent double restoration
              const stockGuardResult = await tx.order.updateMany({
                where: {
                  id: input.orderId,
                  stockConsumed: true, // Only if stock is actually consumed
                },
                data: {
                  stockConsumed: false, // Mark as not consumed atomically
                  stockConsumedAt: null,
                },
              });

              if (stockGuardResult.count === 0) {
                // Stock already restored by another process - skip restoration
                // Update status history and return
                const order = await tx.order.update({
                  where: { id: input.orderId },
                  data: {
                    statusHistory: [
                      ...currentOrder.statusHistory,
                      {
                        status: input.newStatus,
                        changedAt: new Date(),
                        changedBy: ctx.userId,
                        changedByName: userDetails.changedByName,
                        changedByEmail: userDetails.changedByEmail,
                        notes: input.notes,
                      },
                    ],
                  },
                });
                return { order, alreadyCompleted: false, originalStatus: currentOrder.status, stockAlreadyRestored: true };
              }

              // Use shared stock restoration service
              const orderItems = (currentOrder.items as any[]).map((item: any) => ({
                productId: item.productId,
                productName: item.productName || item.name,
                sku: item.sku,
                quantity: item.quantity,
              }));

              await restoreOrderStock(
                {
                  orderId: input.orderId,
                  orderNumber: currentOrder.orderNumber,
                  items: orderItems,
                  userId: ctx.userId,
                  reason: input.notes || 'Admin cancellation',
                },
                tx
              );
            }

            // Reverse packing adjustments when stockConsumed is false
            // (e.g., cancelled from 'packing' status before markOrderReady)
            if (!currentOrder.stockConsumed) {
              await reversePackingAdjustments(
                {
                  orderId: input.orderId,
                  orderNumber: currentOrder.orderNumber,
                  userId: ctx.userId,
                  reason: input.notes || 'Admin cancellation',
                },
                tx
              );
            }
          }
        }

        // STEP 5: Update status history
        const updatedOrder = await tx.order.update({
          where: { id: input.orderId },
          data: {
            statusHistory: [
              ...currentOrder.statusHistory,
              {
                status: input.newStatus,
                changedAt: new Date(),
                changedBy: ctx.userId,
                changedByName: userDetails.changedByName,
                changedByEmail: userDetails.changedByEmail,
                notes: input.notes,
              },
            ],
          },
        });

        return { 
          order: updatedOrder, 
          alreadyCompleted: false, 
          originalStatus: currentOrder.status,
          delivery: currentOrder.delivery,
          shouldRestoreStock,
        };
      });

      // Only trigger side effects if not already completed (idempotent)
      if (!result.alreadyCompleted) {
        // Check if cancelling an order with assigned driver - send urgent notification
        const delivery = result.delivery as { driverId?: string; driverName?: string } | null;
        const isCancellingWithAssignedDriver =
          input.newStatus === 'cancelled' &&
          delivery?.driverId &&
          (result.originalStatus === 'ready_for_delivery' || result.originalStatus === 'out_for_delivery');

        if (isCancellingWithAssignedDriver && delivery?.driverId) {
          try {
            const client = await clerkClient();
            const driverUser = await client.users.getUser(delivery.driverId);
            const driverEmail = driverUser.primaryEmailAddress?.emailAddress;

            if (driverEmail) {
              const deliveryAddr = result.order.deliveryAddress as {
                street: string;
                suburb: string;
                state: string;
                postcode: string;
              };
              await sendDriverUrgentCancellationEmail({
                driverEmail,
                driverName: delivery.driverName || 'Driver',
                orderNumber: result.order.orderNumber,
                customerName: result.order.customerName,
                deliveryAddress: `${deliveryAddr.street}, ${deliveryAddr.suburb} ${deliveryAddr.state} ${deliveryAddr.postcode}`,
                cancellationReason: input.notes || 'No reason provided',
              });
            }
          } catch (error) {
            console.error('Failed to send driver urgent cancellation email:', error);
          }
        }

        // Get customer for email notifications
        const customer = await prisma.customer.findUnique({
          where: { id: result.order.customerId },
          select: { contactPerson: true, businessName: true },
        });

        if (customer) {
          switch (input.newStatus) {
            case 'cancelled':
              await sendOrderCancelledEmail({
                customerEmail: customer.contactPerson.email,
                customerName: customer.businessName,
                orderNumber: result.order.orderNumber,
                cancellationReason: input.notes || 'No reason provided',
                totalAmount: result.order.totalAmount,
              }).catch((error) => {
                console.error('Failed to send order cancelled email:', error);
              });

              // If order has a Xero invoice, create a credit note
              // But only if no partial credit notes already exist (to avoid conflicts)
              const xeroInfo = result.order.xero as { invoiceId?: string | null; creditNotes?: any[] } | null;
              if (xeroInfo?.invoiceId && !((xeroInfo?.creditNotes?.length ?? 0) > 0)) {
                const { enqueueXeroJob } = await import('../services/xero-queue');
                await enqueueXeroJob('create_credit_note', 'order', input.orderId).catch((error) => {
                  console.error('Failed to enqueue Xero credit note creation:', error);
                });
              }

              // Log cancellation
              await logOrderCancellation(
                ctx.userId,
                input.orderId,
                result.order.orderNumber,
                input.notes || 'No reason provided',
                result.originalStatus
              ).catch((error) => {
                console.error('Failed to log order cancellation:', error);
              });
              break;

            case 'ready_for_delivery':
            case 'out_for_delivery':
              {
                const deliveryAddr = result.order.deliveryAddress as {
                  street: string;
                  suburb: string;
                  state: string;
                  postcode: string;
                };
                const orderDelivery = result.order.delivery as { driverName?: string } | null;

                await sendOrderOutForDeliveryEmail({
                  customerEmail: customer.contactPerson.email,
                  customerName: customer.businessName,
                  orderNumber: result.order.orderNumber,
                  driverName: orderDelivery?.driverName,
                  deliveryAddress: {
                    street: deliveryAddr.street,
                    suburb: deliveryAddr.suburb,
                    state: deliveryAddr.state,
                    postcode: deliveryAddr.postcode,
                  },
                }).catch((error) => {
                  console.error('Failed to send out for delivery email:', error);
                });

                // Trigger Xero invoice creation only when order becomes ready_for_delivery
                // (not when transitioning to out_for_delivery since invoice should already exist)
                const xeroInfo = result.order.xero as { invoiceId?: string | null } | null;
                if (input.newStatus === 'ready_for_delivery' && !xeroInfo?.invoiceId) {
                  const { enqueueXeroJob } = await import('../services/xero-queue');
                  await enqueueXeroJob('create_invoice', 'order', input.orderId).catch((error) => {
                    console.error('Failed to enqueue Xero invoice creation:', error);
                  });
                }
              }
              break;

            case 'delivered':
              await sendOrderDeliveredEmail({
                customerEmail: customer.contactPerson.email,
                customerName: customer.businessName,
                orderNumber: result.order.orderNumber,
                deliveredAt: new Date(),
                totalAmount: result.order.totalAmount,
              }).catch((error) => {
                console.error('Failed to send order delivered email:', error);
              });
              break;
          }
        }

        // Log status change for non-cancellation changes
        if (input.newStatus !== 'cancelled') {
          await logOrderStatusChange(
            ctx.userId,
            input.orderId,
            result.order.orderNumber,
            result.originalStatus,
            input.newStatus,
            input.notes,
            userDetails.changedByEmail || undefined,
            userDetails.changedByName,
            undefined
          ).catch((error) => {
            console.error('Failed to log order status change:', error);
          });
        }
      }

      return result.order;
    }),

  // Reorder - Create new order from existing order
  reorder: protectedProcedure
    .input(z.object({ orderId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Fetch the original order with all items
      const originalOrder = await prisma.order.findUnique({
        where: { id: input.orderId },
      });

      if (!originalOrder) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Order not found',
        });
      }

      // Get customer to verify ownership
      const customer = await prisma.customer.findUnique({
        where: { clerkUserId: ctx.userId },
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      // Verify the order belongs to the authenticated customer
      if (originalOrder.customerId !== customer.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission to reorder this order',
        });
      }

      // Check credit approval
      if (customer.creditApplication.status !== 'approved') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Your credit application is pending approval',
        });
      }

      // Extract product IDs and quantities from original order items
      const orderItems = originalOrder.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      }));

      // Get products and validate they still exist and are available (include parent for subproducts)
      const productIds = orderItems.map((item) => item.productId);
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        include: { parentProduct: true },
      });

      if (products.length !== orderItems.length) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'One or more products from the original order are no longer available',
        });
      }

      // Get current customer-specific pricing for all products
      const customerPricings = await prisma.customerPricing.findMany({
        where: {
          customerId: customer.id,
          productId: { in: productIds },
        },
      });

      // Create a map of product ID to custom pricing
      const pricingMap = new Map(customerPricings.map((p) => [p.productId, p]));

      // Build new order items with CURRENT pricing
      const newOrderItems = orderItems.map((item) => {
        const product = products.find((p) => p.id === item.productId);
        if (!product) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Product not found',
          });
        }

        // Stock validation removed - orders with insufficient stock go to pending admin approval

        // Get effective price using CURRENT pricing (not historical)
        const customPricing = pricingMap.get(product.id);
        const priceInfo = getEffectivePrice(product.basePrice, customPricing);
        const effectivePrice = priceInfo.effectivePrice; // In cents

        // Calculate item subtotal using dinero.js for precision
        const priceMoney = createMoney(effectivePrice);
        const itemSubtotalMoney = multiplyMoney(priceMoney, item.quantity);
        const itemSubtotal = toCents(itemSubtotalMoney);

        return {
          productId: product.id,
          sku: product.sku,
          productName: product.name,
          unit: product.unit,
          quantity: item.quantity,
          unitPrice: effectivePrice, // In cents - CURRENT price
          subtotal: itemSubtotal, // In cents
          applyGst: product.applyGst,
          gstRate: product.gstRate,
        };
      });

      // Calculate totals using per-product GST settings
      const totals = calculateOrderTotals(newOrderItems);

      // Validate stock and check if backorder is needed
      const stockValidation = validateStockWithBackorder(orderItems, products);
      const orderStatus = stockValidation.requiresBackorder ? 'awaiting_approval' : 'confirmed';

      // Validate available credit (Issue #2 fix: check available credit, not total limit)
      const creditLimit = customer.creditApplication.creditLimit; // In cents
      const availableCredit = await calculateAvailableCredit(customer.id, creditLimit);
      if (totals.totalAmount > availableCredit) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Order exceeds available credit. Available: $${(availableCredit / 100).toFixed(2)}, Order total: $${(totals.totalAmount / 100).toFixed(2)}`,
        });
      }

      // Generate new order number
      const orderNumber = generateOrderNumber();

      // Set delivery date (tomorrow by default)
      const deliveryDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

      // Get user details for status history
      const userDetails = await getUserDetails(ctx.userId);

      // Create new order with stock reservation in a transaction
      const newOrder = await prisma.$transaction(async (tx) => {
        // Create the order
        const createdOrder = await tx.order.create({
          data: {
            orderNumber,
            customerId: customer.id,
            customerName: customer.businessName,
            items: newOrderItems,
            subtotal: totals.subtotal,
            taxAmount: totals.taxAmount,
            totalAmount: totals.totalAmount,
            deliveryAddress: originalOrder.deliveryAddress, // Use same delivery address
            requestedDeliveryDate: deliveryDate,
            status: orderStatus,
            statusHistory: [
              {
                status: orderStatus,
                changedAt: new Date(),
                changedBy: ctx.userId,
                changedByName: userDetails.changedByName,
                changedByEmail: userDetails.changedByEmail,
                notes: stockValidation.requiresBackorder
                  ? `Reordered from order ${originalOrder.orderNumber} - Awaiting approval due to insufficient stock`
                  : `Reordered from order ${originalOrder.orderNumber}`,
              },
            ],
            orderedAt: new Date(),
            createdBy: ctx.userId,

            // Backorder fields (stockShortfall presence indicates backorder)
            stockShortfall: stockValidation.requiresBackorder
              ? stockValidation.stockShortfall
              : undefined,
          },
        });

        // Stock reduction is now handled in markOrderReady (packing step)
        // This ensures stock is only consumed when order is actually packed

        return createdOrder;
      });

      // Send appropriate email based on backorder status
      const deliveryAddr = originalOrder.deliveryAddress as {
        street: string;
        suburb: string;
        state: string;
        postcode: string;
      };

      if (stockValidation.requiresBackorder) {
        // Send backorder notification emails
        const stockShortfallArray = Object.entries(stockValidation.stockShortfall).map(
          ([productId, data]) => {
            const product = products.find((p) => p.id === productId);
            return {
              productName: product?.name || 'Unknown Product',
              sku: product?.sku || productId,
              requested: data.requested,
              available: data.available,
              shortfall: data.shortfall,
              unit: product?.unit || 'unit',
            };
          }
        );

        await sendBackorderSubmittedEmail({
          customerEmail: customer.contactPerson.email,
          customerName: customer.businessName,
          orderNumber: newOrder.orderNumber,
          orderDate: newOrder.orderedAt,
          stockShortfall: stockShortfallArray,
          totalAmount: totals.totalAmount,
        }).catch((error) => {
          console.error('Failed to send backorder submitted email:', error);
        });

        // Notify admin of backorder
        await sendBackorderAdminNotification({
          orderNumber: newOrder.orderNumber,
          customerName: customer.businessName,
          stockShortfall: stockShortfallArray,
          totalAmount: totals.totalAmount,
        }).catch((error) => {
          console.error('Failed to send backorder admin notification:', error);
        });
      } else {
        // Send regular order confirmation email
        await sendOrderConfirmationEmail({
          customerEmail: customer.contactPerson.email,
          customerName: customer.businessName,
          orderNumber: newOrder.orderNumber,
          orderDate: newOrder.orderedAt,
          requestedDeliveryDate: deliveryDate,
          items: newOrderItems.map((item) => ({
            productName: item.productName,
            sku: item.sku,
            quantity: item.quantity,
            unit: item.unit,
            unitPrice: item.unitPrice,
            subtotal: item.subtotal,
          })),
          subtotal: totals.subtotal,
          taxAmount: totals.taxAmount,
          totalAmount: totals.totalAmount,
          deliveryAddress: {
            street: deliveryAddr.street,
            suburb: deliveryAddr.suburb,
            state: deliveryAddr.state,
            postcode: deliveryAddr.postcode,
          },
        }).catch((error) => {
          console.error('Failed to send order confirmation email:', error);
        });
      }

      // Send notification to admin
      sendNewOrderNotificationEmail({
        orderNumber: newOrder.orderNumber,
        customerName: customer.businessName,
        totalAmount: totals.totalAmount,
        itemCount: newOrderItems.length,
        deliveryDate,
        isBackorder: stockValidation.requiresBackorder,
      }).catch((error) => {
        console.error('Failed to send admin notification email:', error);
      });

      // Audit log - MEDIUM: Reorder creation
      await logReorder(ctx.userId, undefined, ctx.userRole, ctx.userName, newOrder.id, {
        originalOrderId: input.orderId,
        originalOrderNumber: originalOrder.orderNumber,
        newOrderNumber: newOrder.orderNumber,
        customerId: customer.id,
      }).catch((error) => {
        console.error('Audit log failed for reorder:', error);
      });

      return newOrder;
    }),

  // Get pending backorders (Admin only)
  getPendingBackorders: requirePermission('orders:approve_backorder')
    .input(
      z.object({
        customerId: z.string().optional(),
        dateFrom: z.date().optional(),
        dateTo: z.date().optional(),
        page: z.number().default(1),
        limit: z.number().default(50),
      })
    )
    .query(async ({ input }) => {
      const { customerId, dateFrom, dateTo, page, limit } = input;

      // Build where clause (pending backorders have awaiting_approval status and stockShortfall)
      const where: any = {
        status: 'awaiting_approval',
        stockShortfall: { not: null },
      };

      if (customerId) {
        where.customerId = customerId;
      }

      if (dateFrom || dateTo) {
        where.createdAt = {};
        if (dateFrom) where.createdAt.gte = dateFrom;
        if (dateTo) where.createdAt.lte = dateTo;
      }

      // Get orders with pagination
      const result = await paginatePrismaQuery(
        prisma.order,
        where,
        {
          page,
          limit,
          orderBy: { createdAt: 'desc' },
          include: {
            customer: {
              select: {
                id: true,
                businessName: true,
                contactPerson: true,
                creditApplication: true,
              },
            },
          },
        }
      );

      return result;
    }),

  // Approve backorder (Admin only)
  approveBackorder: requirePermission('orders:approve_backorder')
    .input(
      z.object({
        orderId: z.string(),
        approvedQuantities: z.record(z.number().int().positive()).optional(), // For partial approval
        expectedFulfillment: z.date().optional(),
        notes: z.string().optional(),
        bypassStockCheck: z.boolean().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { orderId, approvedQuantities, expectedFulfillment, notes } = input;

      // Get user details for status history (safe to fetch outside transaction)
      const userDetails = await getUserDetails(ctx.userId);

      // Determine if this is a partial approval
      const isPartialApproval = approvedQuantities && Object.keys(approvedQuantities).length > 0;

      // Wrap entire operation in transaction with atomic guard
      const result = await prisma.$transaction(async (tx) => {
        // STEP 1: Atomic guard - update only if still awaiting_approval with stockShortfall
        const updateResult = await tx.order.updateMany({
          where: {
            id: orderId,
            status: 'awaiting_approval',
            stockShortfall: { not: null }, // Must have stock shortfall (backorder indicator)
          },
          data: {
            status: 'confirmed', // Atomic transition
            reviewedBy: ctx.userId,
            reviewedAt: new Date(),
          },
        });

        // STEP 2: Check idempotency
        if (updateResult.count === 0) {
          // Check if already approved (idempotent) or conflict
          const existing = await tx.order.findUnique({
            where: { id: orderId },
            include: { customer: true },
          });

          if (!existing) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Order not found',
            });
          }

          if (existing.status === 'confirmed') {
            // Already approved - return idempotent result
            return { order: existing, alreadyCompleted: true, originalItems: existing.items };
          }

          // Different status - conflict
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Order is not pending backorder approval. Current status: ${existing.status}`,
          });
        }

        // STEP 3: Fetch the updated order with customer for further processing
        const order = await tx.order.findUnique({
          where: { id: orderId },
          include: { customer: true },
        });

        if (!order) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Order not found after update',
          });
        }

        // Save original items for email
        const originalItems = order.items as any[];

        // Re-check stock availability before finalizing (stock may have changed)
        const { isSubproduct, calculateParentConsumption } = await import('@joho-erp/shared');
        const productIds = originalItems.map((item: any) => item.productId);
        const products = await tx.product.findMany({
          where: { id: { in: productIds } },
          include: { parentProduct: true },
        });

        const shortfalls: Record<string, { requested: number; available: number }> = {};

        for (const item of originalItems) {
          const product = products.find((p) => p.id === item.productId);
          if (!product) continue;

          const productIsSubproduct = isSubproduct(product);
          const consumeFrom = productIsSubproduct ? product.parentProduct : product;
          
          if (!consumeFrom) continue;

          const consumeQty = productIsSubproduct
            ? calculateParentConsumption(item.quantity, product.estimatedLossPercentage ?? 0)
            : item.quantity;

          if (consumeFrom.currentStock < consumeQty) {
            shortfalls[item.productId] = { 
              requested: consumeQty, 
              available: consumeFrom.currentStock 
            };
          }
        }

        if (Object.keys(shortfalls).length > 0) {
          if (!input.bypassStockCheck) {
            // Rollback by reverting status (transaction will rollback anyway on throw)
            const shortfallDetails = Object.entries(shortfalls)
              .map(([productId, { requested, available }]) => {
                const product = products.find((p) => p.id === productId);
                return `${product?.name || productId}: need ${requested}, have ${available}`;
              })
              .join('; ');
            
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Insufficient stock for some items. Stock may have changed since order was placed. ${shortfallDetails}`,
            });
          }
        }

        // STEP 4: Handle partial approval if applicable
        let updatedOrder = order;
        let updatedItems = order.items;

        if (isPartialApproval && approvedQuantities) {
          updatedItems = order.items.map((item: any) => {
            const approvedQty = approvedQuantities[item.productId];
            if (approvedQty !== undefined && approvedQty !== item.quantity) {
              const unitPriceMoney = createMoney(item.unitPrice);
              const newSubtotalMoney = multiplyMoney(unitPriceMoney, approvedQty);
              return {
                ...item,
                quantity: approvedQty,
                subtotal: toCents(newSubtotalMoney),
              };
            }
            return item;
          });

          // Recalculate order totals using per-product GST settings
          const newTotals = calculateOrderTotals(
            updatedItems.map((item: any) => ({
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              applyGst: item.applyGst ?? false,
              gstRate: item.gstRate ?? null,
            }))
          );

          // Credit re-validation for partial approval
          const creditLimit = order.customer.creditApplication.creditLimit;
          const otherOrdersBalance = await tx.order.aggregate({
            where: {
              customerId: order.customerId,
              id: { not: orderId },
              status: { in: ['awaiting_approval', 'confirmed', 'packing', 'ready_for_delivery', 'out_for_delivery'] },
            },
            _sum: { totalAmount: true },
          });
          const availableCredit = creditLimit - (otherOrdersBalance._sum.totalAmount || 0);

          if (newTotals.totalAmount > availableCredit) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Approved order total ($${(newTotals.totalAmount / 100).toFixed(2)}) exceeds available credit ($${(availableCredit / 100).toFixed(2)}).`,
            });
          }

          // Update order with approved quantities and new totals
          updatedOrder = await tx.order.update({
            where: { id: orderId },
            data: {
              items: updatedItems,
              subtotal: newTotals.subtotal,
              taxAmount: newTotals.taxAmount,
              totalAmount: newTotals.totalAmount,
              approvedQuantities,
              backorderNotes: notes,
              expectedFulfillment,
              statusHistory: [
                ...order.statusHistory,
                {
                  status: 'confirmed',
                  changedAt: new Date(),
                  changedBy: ctx.userId,
                  changedByName: userDetails.changedByName,
                  changedByEmail: userDetails.changedByEmail,
                  notes: `Backorder partially approved by admin${input.bypassStockCheck ? ' (approved with insufficient stock — admin override)' : ''}${notes ? `: ${notes}` : ''}`,
                },
              ],
            },
            include: { customer: true },
          });
        } else {
          // Full approval - update with status history
          updatedOrder = await tx.order.update({
            where: { id: orderId },
            data: {
              backorderNotes: notes,
              expectedFulfillment,
              statusHistory: [
                ...order.statusHistory,
                {
                  status: 'confirmed',
                  changedAt: new Date(),
                  changedBy: ctx.userId,
                  changedByName: userDetails.changedByName,
                  changedByEmail: userDetails.changedByEmail,
                  notes: `Backorder approved by admin${input.bypassStockCheck ? ' (approved with insufficient stock — admin override)' : ''}${notes ? `: ${notes}` : ''}`,
                },
              ],
            },
            include: { customer: true },
          });
        }

        return { order: updatedOrder, alreadyCompleted: false, originalItems, isPartialApproval, updatedItems };
      });

      // STEP 5: Send emails only if not already completed (idempotent)
      if (!result.alreadyCompleted) {
        if (result.isPartialApproval) {
          const approvedItemsForEmail = result.updatedItems.map((item: any) => ({
            productName: item.productName,
            sku: item.sku,
            requestedQuantity: result.originalItems.find((i: any) => i.productId === item.productId)?.quantity || item.quantity,
            approvedQuantity: item.quantity,
            unit: item.unit,
          }));

          await sendBackorderPartialApprovalEmail({
            customerEmail: result.order.customer.contactPerson.email,
            customerName: result.order.customer.businessName,
            orderNumber: result.order.orderNumber,
            totalAmount: result.order.totalAmount,
            approvedItems: approvedItemsForEmail,
            estimatedFulfillment: expectedFulfillment,
            notes,
          }).catch((error) => {
            console.error('Failed to send backorder partial approval email:', error);
          });

          await logBackorderApproval(
            ctx.userId,
            orderId,
            result.order.orderNumber,
            'partial',
            approvedQuantities
          ).catch((error) => {
            console.error('Failed to log backorder partial approval:', error);
          });
        } else {
          const approvedItemsForEmail = (result.order.items as any[]).map((item) => ({
            productName: item.productName,
            sku: item.sku,
            approvedQuantity: item.quantity,
            unit: item.unit,
          }));

          await sendBackorderApprovedEmail({
            customerEmail: result.order.customer.contactPerson.email,
            customerName: result.order.customer.businessName,
            orderNumber: result.order.orderNumber,
            totalAmount: result.order.totalAmount,
            approvedItems: approvedItemsForEmail,
            estimatedFulfillment: expectedFulfillment,
            notes,
          }).catch((error) => {
            console.error('Failed to send backorder approved email:', error);
          });

          await logBackorderApproval(
            ctx.userId,
            orderId,
            result.order.orderNumber,
            'full',
            undefined
          ).catch((error) => {
            console.error('Failed to log backorder full approval:', error);
          });
        }

        // Assign preliminary packing sequence for confirmed backorder
        await assignPreliminaryPackingSequence(
          result.order.requestedDeliveryDate,
          result.order.id,
          (result.order.deliveryAddress as { areaName?: string } | null)?.areaName ?? null
        );
      }

      return result.order;
    }),

  // Reject backorder (Admin only)
  rejectBackorder: requirePermission('orders:approve_backorder')
    .input(
      z.object({
        orderId: z.string(),
        reason: z.string().min(10, 'Rejection reason must be at least 10 characters'),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { orderId, reason } = input;

      // Get user details for status history (safe to fetch outside transaction)
      const userDetails = await getUserDetails(ctx.userId);

      // Wrap in transaction with atomic guard
      const result = await prisma.$transaction(async (tx) => {
        // STEP 1: Atomic guard - update only if still awaiting_approval with stockShortfall
        const updateResult = await tx.order.updateMany({
          where: {
            id: orderId,
            status: 'awaiting_approval',
            stockShortfall: { not: null }, // Must have stock shortfall (backorder indicator)
          },
          data: {
            status: 'cancelled',
            reviewedBy: ctx.userId,
            reviewedAt: new Date(),
          },
        });

        // STEP 2: Check idempotency
        if (updateResult.count === 0) {
          const existing = await tx.order.findUnique({
            where: { id: orderId },
            include: { customer: true },
          });

          if (!existing) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Order not found',
            });
          }

          // Check if already rejected (cancelled with stockShortfall)
          if (existing.status === 'cancelled' && existing.stockShortfall) {
            return { order: existing, alreadyCompleted: true };
          }

          // Different status - conflict
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Order is not pending backorder approval. Current status: ${existing.status}`,
          });
        }

        // STEP 3: Fetch and update with rejection details
        const order = await tx.order.findUnique({
          where: { id: orderId },
          include: { customer: true },
        });

        if (!order) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Order not found after update',
          });
        }

        // Update with backorder notes and status history
        const updatedOrder = await tx.order.update({
          where: { id: orderId },
          data: {
            backorderNotes: reason,
            statusHistory: [
              ...order.statusHistory,
              {
                status: 'cancelled',
                changedAt: new Date(),
                changedBy: ctx.userId,
                changedByName: userDetails.changedByName,
                changedByEmail: userDetails.changedByEmail,
                notes: `Backorder rejected by admin: ${reason}`,
              },
            ],
          },
          include: { customer: true },
        });

        return { order: updatedOrder, alreadyCompleted: false };
      });

      // Only send emails if not already completed (idempotent)
      if (!result.alreadyCompleted) {
        // Send rejection email to customer
        const rejectedItemsForEmail = (result.order.items as any[]).map((item) => ({
          productName: item.productName,
          sku: item.sku,
          requestedQuantity: item.quantity,
          unit: item.unit,
        }));

        await sendBackorderRejectedEmail({
          customerEmail: result.order.customer.contactPerson.email,
          customerName: result.order.customer.businessName,
          orderNumber: result.order.orderNumber,
          reason,
          rejectedItems: rejectedItemsForEmail,
        }).catch((error) => {
          console.error('Failed to send backorder rejected email:', error);
        });

        // Log backorder rejection to audit trail
        await logBackorderRejection(
          ctx.userId,
          orderId,
          result.order.orderNumber,
          reason
        ).catch((error) => {
          console.error('Failed to log backorder rejection:', error);
        });
      }

      return result.order;
    }),

  // ============================================================================
  // CUTOFF TIME & CREDIT INFO QUERIES
  // ============================================================================

  // Get cutoff time information for the UI
  getCutoffInfo: protectedProcedure
    .input(
      z.object({
        areaName: z.string().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const cutoffInfo = await getCutoffInfoService(input?.areaName);
      return cutoffInfo;
    }),

  // Get available credit information for a customer
  getAvailableCreditInfo: protectedProcedure.query(async ({ ctx }) => {
    // Get customer by clerkUserId
    const customer = await prisma.customer.findUnique({
      where: { clerkUserId: ctx.userId },
      select: {
        id: true,
        creditApplication: true,
      },
    });

    if (!customer) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Customer not found',
      });
    }

    const creditLimit = customer.creditApplication.creditLimit;
    const outstandingBalance = await getOutstandingBalance(customer.id);
    const availableCredit = creditLimit - outstandingBalance;

    return {
      creditLimit, // In cents
      outstandingBalance, // In cents
      availableCredit, // In cents
      currency: 'AUD',
    };
  }),

  // Get credit information for a specific customer (Admin only - for order on behalf)
  getCustomerCreditInfoForAdmin: requirePermission('orders:create')
    .input(z.object({ customerId: z.string() }))
    .query(async ({ input }) => {
      const customer = await prisma.customer.findUnique({
        where: { id: input.customerId },
        select: {
          id: true,
          creditApplication: true,
        },
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      const creditLimit = customer.creditApplication.creditLimit;
      const outstandingBalance = await getOutstandingBalance(customer.id);
      const availableCredit = creditLimit - outstandingBalance;

      return {
        creditLimit, // In cents
        outstandingBalance, // In cents
        availableCredit, // In cents
        currency: 'AUD',
      };
    }),

  // ============================================================================
  // ORDER CONFIRMATION (Admin)
  // ============================================================================

  // Confirm a pending order (Admin/Sales only)
  confirmOrder: requirePermission('orders:confirm')
    .input(
      z.object({
        orderId: z.string(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { orderId, notes } = input;

      // Use transaction to ensure atomic stock check and order update
      return prisma.$transaction(
        async (tx) => {
          // Get the order inside transaction
          const order = await tx.order.findUnique({
            where: { id: orderId },
            include: { customer: true },
          });

          if (!order) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Order not found',
            });
          }

          // Validate current status - only awaiting_approval orders can be confirmed (for backorders)
          if (order.status !== 'awaiting_approval') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Cannot confirm order with status '${order.status}'. Only orders awaiting approval can be confirmed.`,
            });
          }

          // Check stock availability for non-backorders and convert to backorder if insufficient
          let stockValidation: StockValidationResult = { requiresBackorder: false, stockShortfall: {} };
          if (!order.stockShortfall) {
            // Normal order (not a backorder)
            const orderItems = order.items as Array<{ productId: string; quantity: number }>;
            const productIds = orderItems.map((item) => item.productId);

            // Fetch products inside transaction
            const products = await tx.product.findMany({
              where: { id: { in: productIds } },
            });

            stockValidation = validateStockWithBackorder(orderItems, products);

            // If stock is insufficient, convert to backorder instead of blocking
            if (stockValidation.requiresBackorder) {
              const userDetails = await getUserDetails(ctx.userId);

              // Update order to backorder status with atomic guard on status
              const updatedBackorder = await tx.order.update({
                where: {
                  id: orderId,
                  status: 'awaiting_approval', // Atomic guard
                },
                data: {
                  stockShortfall: stockValidation.stockShortfall, // This indicates it's now a backorder
                  statusHistory: {
                    push: {
                      status: 'awaiting_approval',
                      changedAt: new Date(),
                      changedBy: ctx.userId,
                      changedByName: userDetails.changedByName,
                      changedByEmail: userDetails.changedByEmail,
                      notes: 'Order converted to backorder due to insufficient stock',
                    },
                  },
                },
                include: { customer: true },
              });

              // Send backorder notification
              const stockShortfallArray = Object.entries(stockValidation.stockShortfall).map(
                ([productId, data]) => {
                  const product = products.find((p) => p.id === productId);
                  return {
                    productName: product?.name || 'Unknown Product',
                    sku: product?.sku || productId,
                    requested: data.requested,
                    available: data.available,
                    shortfall: data.shortfall,
                    unit: product?.unit || 'unit',
                  };
                }
              );

              await sendBackorderSubmittedEmail({
                customerEmail: updatedBackorder.customer.contactPerson.email,
                customerName: updatedBackorder.customer.businessName,
                orderNumber: updatedBackorder.orderNumber,
                orderDate: updatedBackorder.orderedAt,
                stockShortfall: stockShortfallArray,
                totalAmount: updatedBackorder.totalAmount,
              }).catch((error) => {
                console.error('Failed to send backorder submitted email:', error);
              });

              return {
                ...updatedBackorder,
                convertedToBackorder: true,
                message: 'Order converted to backorder due to insufficient stock. Awaiting approval.',
              };
            }
          }

          // Re-validate credit limit
          const creditLimit = order.customer.creditApplication.creditLimit;
          const availableCredit = await calculateAvailableCredit(order.customerId, creditLimit);

          // Need to exclude this order's amount from available credit since it's already counted
          const adjustedAvailableCredit = availableCredit + order.totalAmount;
          if (order.totalAmount > adjustedAvailableCredit) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Order total exceeds available credit. Available: $${(adjustedAvailableCredit / 100).toFixed(2)}`,
            });
          }

          // Validate delivery date is in the future
          const now = new Date();
          if (order.requestedDeliveryDate < now) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Requested delivery date is in the past. Please update the delivery date.',
            });
          }

          // Get user details for status history
          const userDetails = await getUserDetails(ctx.userId);

          // Update order status to confirmed with atomic guard on status
          const updatedOrder = await tx.order.update({
            where: {
              id: orderId,
              status: 'awaiting_approval', // Atomic guard
            },
            data: {
              status: 'confirmed',
              statusHistory: {
                push: {
                  status: 'confirmed',
                  changedAt: new Date(),
                  changedBy: ctx.userId,
                  changedByName: userDetails.changedByName,
                  changedByEmail: userDetails.changedByEmail,
                  notes: notes || 'Order confirmed by admin',
                },
              },
            },
            include: { customer: true },
          });

          // Assign preliminary packing sequence for immediate display
          await assignPreliminaryPackingSequence(
            updatedOrder.requestedDeliveryDate,
            updatedOrder.id,
            (updatedOrder.deliveryAddress as { areaName?: string } | null)?.areaName ?? null
          );

          // Send order confirmed by admin email to customer
          await sendOrderConfirmedByAdminEmail({
            customerEmail: updatedOrder.customer.contactPerson.email,
            customerName: updatedOrder.customer.businessName,
            orderNumber: updatedOrder.orderNumber,
            estimatedDeliveryDate: updatedOrder.requestedDeliveryDate,
          }).catch((error) => {
            console.error('Failed to send order confirmed by admin email:', error);
          });

          // Audit log - HIGH: Order confirmation must be tracked
          await logOrderConfirmation(ctx.userId, undefined, ctx.userRole, ctx.userName, orderId, {
            orderNumber: order.orderNumber,
            customerId: order.customerId,
          }).catch((error) => {
            console.error('Audit log failed for order confirmation:', error);
          });

          return updatedOrder;
        },
        { timeout: 15000 }
      );
    }),

  // ============================================================================
  // CUSTOMER ORDER CANCELLATION
  // ============================================================================

  // Cancel own order (Customer only - pending orders)
  cancelMyOrder: protectedProcedure
    .input(
      z.object({
        orderId: z.string(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { orderId, reason } = input;

      // Get the order
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { customer: true },
      });

      if (!order) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Order not found',
        });
      }

      // Validate ownership - order must belong to the customer
      if (order.customer.clerkUserId !== ctx.userId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You can only cancel your own orders',
        });
      }

      // Validate status - orders can be cancelled before packing starts
      const cancellableStatuses = ['confirmed', 'awaiting_approval'];
      if (!cancellableStatuses.includes(order.status)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Orders can only be cancelled before packing begins. Please contact customer service for assistance.',
        });
      }

      // Get user details for status history
      const userDetails = await getUserDetails(ctx.userId);

      // Cancel the order and restore stock in a transaction
      const cancelledOrder = await prisma.$transaction(async (tx) => {
        // Only restore stock if it was actually consumed (during packing)
        // Issue #1 fix: Check stockConsumed flag, not stockShortfall
        if (order.stockConsumed) {
          const orderItems = order.items as Array<{ productId: string; quantity: number }>;

          // Use unified stock restoration service
          // This handles subproduct aggregation, inventoryBatch creation, etc.
          await restoreOrderStock(
            {
              orderId: order.id,
              orderNumber: order.orderNumber,
              items: orderItems,
              userId: ctx.userId,
              reason: reason || 'Cancelled by customer',
            },
            tx
          );
        }

        // Defensive: reverse any packing adjustments when stockConsumed is false
        // Currently customer cancellation only allows confirmed/awaiting_approval statuses
        // where packing adjustments shouldn't exist, but this guards against future changes
        if (!order.stockConsumed) {
          await reversePackingAdjustments(
            {
              orderId: order.id,
              orderNumber: order.orderNumber,
              userId: ctx.userId,
              reason: reason || 'Cancelled by customer',
            },
            tx
          );
        }

        // Update order status
        const updated = await tx.order.update({
          where: { id: orderId },
          data: {
            status: 'cancelled',
            statusHistory: {
              push: {
                status: 'cancelled',
                changedAt: new Date(),
                changedBy: ctx.userId,
                changedByName: userDetails.changedByName,
                changedByEmail: userDetails.changedByEmail,
                notes: reason || 'Cancelled by customer',
              },
            },
          },
          include: { customer: true },
        });

        return updated;
      });

      // Send cancellation email to customer
      await sendOrderCancelledEmail({
        customerEmail: cancelledOrder.customer.contactPerson.email,
        customerName: cancelledOrder.customer.businessName,
        orderNumber: cancelledOrder.orderNumber,
        cancellationReason: reason || 'Cancelled by customer',
        totalAmount: cancelledOrder.totalAmount,
      }).catch((error) => {
        console.error('Failed to send order cancelled email:', error);
      });

      // Audit log - HIGH: Customer-initiated cancellation must be tracked
      await logOrderCancellation(ctx.userId, orderId, order.orderNumber, reason || 'Cancelled by customer', order.status).catch((error) => {
        console.error('Audit log failed for customer order cancellation:', error);
      });

      return cancelledOrder;
    }),

  // ============================================================================
  // RESEND CONFIRMATION EMAIL
  // ============================================================================

  // Resend order confirmation email (Admin/Sales only)
  resendConfirmation: requirePermission('orders:confirm')
    .input(z.object({ orderId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { orderId } = input;

      // Get the order with customer
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { customer: true },
      });

      if (!order) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Order not found',
        });
      }

      // Only allow resending for confirmed orders
      if (order.status !== 'confirmed') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot resend confirmation for order with status '${order.status}'. Only confirmed orders can have confirmation emails resent.`,
        });
      }

      // Get the order items from the JSON field
      const orderItems = order.items as Array<{
        productId: string;
        productName: string;
        sku: string;
        quantity: number;
        unit: string;
        unitPrice: number;
        subtotal: number;
      }>;

      // Get the delivery address from the JSON field
      const deliveryAddress = order.deliveryAddress as {
        street: string;
        suburb: string;
        state: string;
        postcode: string;
      };

      // Send the order confirmation email
      await sendOrderConfirmationEmail({
        customerEmail: order.customer.contactPerson.email,
        customerName: order.customer.businessName,
        orderNumber: order.orderNumber,
        orderDate: order.orderedAt,
        requestedDeliveryDate: order.requestedDeliveryDate,
        items: orderItems.map((item) => ({
          productName: item.productName,
          sku: item.sku,
          quantity: item.quantity,
          unit: item.unit,
          unitPrice: item.unitPrice,
          subtotal: item.subtotal,
        })),
        subtotal: order.subtotal,
        taxAmount: order.taxAmount,
        totalAmount: order.totalAmount,
        deliveryAddress: {
          street: deliveryAddress.street,
          suburb: deliveryAddress.suburb,
          state: deliveryAddress.state,
          postcode: deliveryAddress.postcode,
        },
      });

      // Audit log - LOW: Resend confirmation tracked for visibility
      await logResendConfirmation(ctx.userId, undefined, ctx.userRole, ctx.userName, orderId, {
        orderNumber: order.orderNumber,
        recipientEmail: order.customer.contactPerson.email,
      }).catch((error) => {
        console.error('Audit log failed for resend confirmation:', error);
      });

      return { success: true, message: 'Confirmation email resent successfully' };
    }),

  /**
   * Get minimum order amount configuration
   * Returns the minimum order amount and whether it's enabled
   */
  getMinimumOrderInfo: protectedProcedure.query(async () => {
    const company = await prisma.company.findFirst({
      select: { deliverySettings: true },
    });

    const minimumOrderAmount = company?.deliverySettings?.minimumOrderAmount || null;

    return {
      minimumOrderAmount, // In cents
      hasMinimum: minimumOrderAmount !== null && minimumOrderAmount > 0,
    };
  }),

  /**
   * Get invoice details for a customer's order
   * Fetches live data from Xero if available, otherwise returns cached data
   * Customer can only view their own orders
   */
  getOrderInvoice: protectedProcedure
    .input(z.object({ orderId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      // Verify customer owns this order
      const order = await prisma.order.findUnique({
        where: { id: input.orderId },
        select: {
          id: true,
          orderNumber: true,
          customerId: true,
          xero: true,
          delivery: true,
        },
      });

      if (!order) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      // Get customer to verify ownership
      const customer = await prisma.customer.findUnique({
        where: { clerkUserId: ctx.userId! },
        select: { id: true },
      });

      if (!customer || order.customerId !== customer.id) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }

      // Check if order has an invoice
      if (!order.xero?.invoiceId) {
        return null;
      }

      // Try to fetch live invoice from Xero
      try {
        const { getCachedInvoice } = await import('../services/xero');
        const liveInvoice = await getCachedInvoice(order.xero.invoiceId);

        if (liveInvoice) {
          return {
            invoiceId: liveInvoice.InvoiceID,
            invoiceNumber: liveInvoice.InvoiceNumber,
            date: liveInvoice.Date,
            dueDate: liveInvoice.DueDate,
            status: liveInvoice.Status,
            total: liveInvoice.Total || 0,
            totalTax: liveInvoice.TotalTax || 0,
            amountDue: liveInvoice.AmountDue,
            amountPaid: liveInvoice.AmountPaid,
            isLive: true,
          };
        }
      } catch (error) {
        // If live fetch fails, fall back to cached data
        console.error('Failed to fetch live invoice:', error);
      }

      // Fallback to cached data from order.xero
      return {
        invoiceId: order.xero.invoiceId,
        invoiceNumber: order.xero.invoiceNumber,
        date: order.delivery?.deliveredAt ? formatDateForMelbourne(order.delivery.deliveredAt) : formatDateForMelbourne(new Date()),
        dueDate: order.delivery?.deliveredAt ? formatDateForMelbourne(order.delivery.deliveredAt) : formatDateForMelbourne(new Date()),
        status: order.xero.invoiceStatus || 'AUTHORISED',
        total: 0,
        totalTax: 0,
        isLive: false,
        syncedAt: order.xero.syncedAt?.toISOString(),
      };
    }),

  /**
   * Get invoice PDF download URL
   * Returns a temporary URL from Xero for customer to download invoice
   * Customer can only download invoices for their own orders
   */
  getInvoicePdfUrl: protectedProcedure
    .input(z.object({ orderId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      // Verify customer owns this order
      const order = await prisma.order.findUnique({
        where: { id: input.orderId },
        select: {
          id: true,
          customerId: true,
          xero: true,
        },
      });

      if (!order) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      // Get customer to verify ownership
      const customer = await prisma.customer.findUnique({
        where: { clerkUserId: ctx.userId! },
        select: { id: true },
      });

      if (!customer || order.customerId !== customer.id) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }

      // Check if order has an invoice
      if (!order.xero?.invoiceId) {
        return null;
      }

      // Fetch PDF URL from Xero
      try {
        const { getInvoicePdfUrl } = await import('../services/xero');
        const pdfUrl = await getInvoicePdfUrl(order.xero.invoiceId);
        return pdfUrl;
      } catch (error) {
        console.error('Failed to fetch invoice PDF URL:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to generate PDF download link',
        });
      }
    }),
});
