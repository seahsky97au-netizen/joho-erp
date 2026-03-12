/**
 * Stock Restoration Service
 *
 * Provides unified stock restoration logic for order cancellations and returns.
 * Key features:
 * - Atomic guard using stockConsumed flag (prevents double restoration)
 * - Subproduct-to-parent aggregation (restore to parent, recalculate subproducts)
 * - Creates both inventoryTransaction AND inventoryBatch records
 * - Recalculates all sibling subproduct stocks after parent update
 */

import { PrismaClient, prisma } from '@joho-erp/database';
import {
  calculateParentConsumption,
  calculateAllSubproductStocks,
  type SubproductForStockCalc,
} from '@joho-erp/shared';
import { generateBatchNumber } from './batch-number';

// Type for transaction client
type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

// Simplified order item type (from order.items JSON array)
export interface OrderItemForRestoration {
  productId: string;
  productName?: string;
  sku?: string;
  quantity: number;
}

// Result of stock restoration
export interface StockRestorationResult {
  success: boolean;
  restoredProducts: Array<{
    productId: string;
    productName: string;
    quantityRestored: number;
    previousStock: number;
    newStock: number;
    isSubproduct: boolean;
    parentProductId?: string;
  }>;
  inventoryBatchesCreated: number;
  inventoryTransactionsCreated: number;
}

// Input for restoreOrderStock
export interface RestoreOrderStockInput {
  orderId: string;
  orderNumber: string;
  items: OrderItemForRestoration[];
  userId: string;
  reason: string;
}

/**
 * Restores stock for a cancelled/returned order.
 *
 * IMPORTANT: Only call this if order.stockConsumed === true
 *
 * For regular products:
 * - Creates inventory transaction (type: return)
 * - Creates inventory batch for the returned stock
 * - Updates product.currentStock
 *
 * For subproducts:
 * - Calculates parent product consumption (accounting for loss percentage)
 * - Restores to parent product
 * - Recalculates all sibling subproduct stocks
 *
 * @param input - The order details and items to restore
 * @param tx - Optional transaction client for atomic operations
 * @returns StockRestorationResult with details of what was restored
 */
export async function restoreOrderStock(
  input: RestoreOrderStockInput,
  tx?: TransactionClient
): Promise<StockRestorationResult> {
  const client = tx || prisma;
  const { orderId, orderNumber, items, userId, reason } = input;

  const result: StockRestorationResult = {
    success: true,
    restoredProducts: [],
    inventoryBatchesCreated: 0,
    inventoryTransactionsCreated: 0,
  };

  // Group items by whether they're subproducts or regular products
  // For subproducts, we need to aggregate by parent product
  const productIds = items.map((item) => item.productId);
  const products = await client.product.findMany({
    where: { id: { in: productIds } },
    include: {
      parentProduct: true,
      subProducts: {
        where: { status: 'active' },
        select: {
          id: true,
          estimatedLossPercentage: true,
          parentProductId: true,
        },
      },
    },
  });

  // Create a map for quick lookup
  const productMap = new Map(products.map((p) => [p.id, p]));

  // Track parent products that need recalculation
  // Map: parentProductId -> { totalParentConsumption, subproductIds }
  const parentRestoreMap = new Map<
    string,
    {
      totalParentConsumption: number;
      subproductIdsToRecalc: string[];
      parentName: string;
    }
  >();

  // Process each order item
  for (const item of items) {
    const product = productMap.get(item.productId);
    if (!product) {
      console.warn(
        `Product ${item.productId} not found during stock restoration for order ${orderNumber}`
      );
      continue;
    }

    const isSubproduct = !!product.parentProductId;

    if (isSubproduct && product.parentProduct) {
      // For subproducts, calculate parent consumption and aggregate
      const lossPercentage = product.estimatedLossPercentage ?? 0;
      const parentConsumption = calculateParentConsumption(item.quantity, lossPercentage);

      const existing = parentRestoreMap.get(product.parentProductId!);
      if (existing) {
        existing.totalParentConsumption += parentConsumption;
      } else {
        // Get all sibling subproducts (including this one) for recalculation
        const parentWithSiblings = await client.product.findUnique({
          where: { id: product.parentProductId! },
          include: {
            subProducts: {
              where: { status: 'active' },
              select: {
                id: true,
                estimatedLossPercentage: true,
                parentProductId: true,
              },
            },
          },
        });

        parentRestoreMap.set(product.parentProductId!, {
          totalParentConsumption: parentConsumption,
          subproductIdsToRecalc:
            parentWithSiblings?.subProducts.map((s) => s.id) || [],
          parentName: product.parentProduct.name,
        });
      }
    } else {
      // Regular product - restore directly
      const previousStock = product.currentStock;
      const newStock = previousStock + item.quantity;

      // Generate batch number for stock return
      const batchNumber = await generateBatchNumber(client, 'stock_return');

      // Create inventory transaction (return)
      const transaction = await client.inventoryTransaction.create({
        data: {
          productId: product.id,
          type: 'return',
          batchNumber,
          quantity: item.quantity,
          previousStock,
          newStock,
          referenceType: 'order',
          referenceId: orderId,
          notes: `Stock restored from cancelled order ${orderNumber}: ${reason}`,
          createdBy: userId,
        },
      });
      result.inventoryTransactionsCreated++;

      // Create inventory batch for the returned stock
      // Use average cost from existing batches, or 0 if no batches exist
      const existingBatch = await client.inventoryBatch.findFirst({
        where: { productId: product.id },
        orderBy: { receivedAt: 'desc' },
        select: { costPerUnit: true },
      });
      const costPerUnit = existingBatch?.costPerUnit ?? 0;

      await client.inventoryBatch.create({
        data: {
          productId: product.id,
          batchNumber,
          quantityRemaining: item.quantity,
          initialQuantity: item.quantity,
          costPerUnit,
          receivedAt: new Date(),
          receiveTransactionId: transaction.id,
          notes: `Returned stock from cancelled order ${orderNumber}`,
        },
      });
      result.inventoryBatchesCreated++;

      // Update product stock (floor at 0 as defensive guard)
      await client.product.update({
        where: { id: product.id },
        data: { currentStock: Math.max(0, newStock) },
      });

      result.restoredProducts.push({
        productId: product.id,
        productName: product.name,
        quantityRestored: item.quantity,
        previousStock,
        newStock,
        isSubproduct: false,
      });
    }
  }

  // Process parent products that had subproduct returns
  for (const [parentId, parentData] of parentRestoreMap) {
    const parent = await client.product.findUnique({
      where: { id: parentId },
      include: {
        subProducts: {
          where: { status: 'active' },
          select: {
            id: true,
            name: true,
            estimatedLossPercentage: true,
            parentProductId: true,
            currentStock: true,
          },
        },
      },
    });

    if (!parent) {
      console.warn(
        `Parent product ${parentId} not found during stock restoration for order ${orderNumber}`
      );
      continue;
    }

    const previousParentStock = parent.currentStock;
    const newParentStock = previousParentStock + parentData.totalParentConsumption;

    // Generate batch number for stock return
    const parentBatchNumber = await generateBatchNumber(client, 'stock_return');

    // Create inventory transaction for parent (return)
    const parentTransaction = await client.inventoryTransaction.create({
      data: {
        productId: parentId,
        type: 'return',
        batchNumber: parentBatchNumber,
        quantity: parentData.totalParentConsumption,
        previousStock: previousParentStock,
        newStock: newParentStock,
        referenceType: 'order',
        referenceId: orderId,
        notes: `Stock restored from cancelled order ${orderNumber} (from subproduct returns): ${reason}`,
        createdBy: userId,
      },
    });
    result.inventoryTransactionsCreated++;

    // Create inventory batch for parent's returned stock
    const existingParentBatch = await client.inventoryBatch.findFirst({
      where: { productId: parentId },
      orderBy: { receivedAt: 'desc' },
      select: { costPerUnit: true },
    });
    const parentCostPerUnit = existingParentBatch?.costPerUnit ?? 0;

    await client.inventoryBatch.create({
      data: {
        productId: parentId,
        batchNumber: parentBatchNumber,
        quantityRemaining: parentData.totalParentConsumption,
        initialQuantity: parentData.totalParentConsumption,
        costPerUnit: parentCostPerUnit,
        receivedAt: new Date(),
        receiveTransactionId: parentTransaction.id,
        notes: `Returned stock from cancelled order ${orderNumber} (from subproduct returns)`,
      },
    });
    result.inventoryBatchesCreated++;

    // Update parent stock (floor at 0 as defensive guard)
    await client.product.update({
      where: { id: parentId },
      data: { currentStock: Math.max(0, newParentStock) },
    });

    result.restoredProducts.push({
      productId: parentId,
      productName: parentData.parentName,
      quantityRestored: parentData.totalParentConsumption,
      previousStock: previousParentStock,
      newStock: newParentStock,
      isSubproduct: false,
    });

    // Recalculate all sibling subproduct stocks based on new parent stock
    const subproductsForCalc: SubproductForStockCalc[] = parent.subProducts.map((s) => ({
      id: s.id,
      estimatedLossPercentage: s.estimatedLossPercentage,
      parentProductId: s.parentProductId,
    }));

    const newSubproductStocks = calculateAllSubproductStocks(
      newParentStock,
      subproductsForCalc
    );

    for (const subStock of newSubproductStocks) {
      const subproduct = parent.subProducts.find((s) => s.id === subStock.id);
      if (subproduct && subproduct.currentStock !== subStock.newStock) {
        await client.product.update({
          where: { id: subStock.id },
          data: { currentStock: Math.max(0, subStock.newStock) },
        });
      }
    }
  }

  // Mark all unreversed sale and packing_adjustment transactions as reversed
  // This ensures a clean audit trail when stock is restored
  const transactionsToReverse = await client.inventoryTransaction.findMany({
    where: {
      referenceType: 'order',
      referenceId: orderId,
      OR: [
        { type: 'sale' },
        { type: 'adjustment', adjustmentType: 'packing_adjustment' },
      ],
    },
  });

  const unreversedIds = transactionsToReverse
    .filter(txn => !txn.reversedAt)
    .map(txn => txn.id);

  if (unreversedIds.length > 0) {
    await client.inventoryTransaction.updateMany({
      where: { id: { in: unreversedIds } },
      data: { reversedAt: new Date() },
    });
  }

  return result;
}

/**
 * Marks an order as having its stock NOT consumed (for rollback scenarios).
 * This should be used when an order is cancelled BEFORE packing (stock was never consumed).
 *
 * @param orderId - The order ID
 * @param tx - Optional transaction client
 */
export async function markStockNotConsumed(
  orderId: string,
  tx?: TransactionClient
): Promise<void> {
  const client = tx || prisma;

  await client.order.update({
    where: { id: orderId },
    data: {
      stockConsumed: false,
      stockConsumedAt: null,
    },
  });
}

// Input for reversePackingAdjustments
export interface ReversePackingAdjustmentsInput {
  orderId: string;
  orderNumber: string;
  userId: string;
  reason: string;
}

/**
 * Reverses unreversed packing_adjustment transactions for an order.
 *
 * This handles stock restoration for packing adjustments that occurred BEFORE
 * markOrderReady (i.e., when stockConsumed is still false).
 *
 * Idempotent: if no unreversed packing_adjustment transactions exist, this is a no-op.
 *
 * For each product with a net positive restoration:
 * - Creates a packing_reset reversal transaction
 * - Creates an inventoryBatch for the returned stock
 * - Updates product.currentStock
 * - If product is a parent, recalculates subproduct stocks
 *
 * @param input - The order details for the reversal
 * @param tx - Optional transaction client for atomic operations
 */
export async function reversePackingAdjustments(
  input: ReversePackingAdjustmentsInput,
  tx?: TransactionClient
): Promise<void> {
  const client = tx || prisma;
  const { orderId, orderNumber, userId, reason } = input;

  // Find all packing_adjustment transactions for this order
  const adjustmentTransactions = await client.inventoryTransaction.findMany({
    where: {
      referenceType: 'order',
      referenceId: orderId,
      type: 'adjustment',
      adjustmentType: 'packing_adjustment',
    },
  });

  // Filter out already-reversed transactions in code (MongoDB doesn't match missing fields with null)
  const unreversedAdjustments = adjustmentTransactions.filter(txn => !txn.reversedAt);

  if (unreversedAdjustments.length === 0) {
    return; // No-op: nothing to reverse
  }

  // Idempotency guard: atomically claim unreversed transactions FIRST.
  // If a concurrent call already claimed them, claimResult.count will be 0.
  const claimResult = await client.inventoryTransaction.updateMany({
    where: {
      id: { in: unreversedAdjustments.map((t) => t.id) },
      reversedAt: null,
    },
    data: {
      reversedAt: new Date(),
    },
  });

  if (claimResult.count === 0) {
    return; // Another call already claimed and reversed these transactions
  }

  // Group by productId and aggregate quantities (negate to get restoration amount)
  const adjustmentQuantities = new Map<string, number>();
  for (const txn of unreversedAdjustments) {
    const current = adjustmentQuantities.get(txn.productId) || 0;
    // Negate: packing_adjustments store negative qty when stock is consumed
    adjustmentQuantities.set(txn.productId, current + (-txn.quantity));
  }

  // Restore stock for each product with net positive restoration
  for (const [productId, quantity] of adjustmentQuantities) {
    if (quantity <= 0) continue; // Skip if net effect is 0 or negative

    const product = await client.product.findUnique({ where: { id: productId } });
    if (!product) continue;

    const previousStock = product.currentStock;
    const newStock = previousStock + quantity;

    // Generate batch number for reversal transaction
    const reversalBatchNumber = await generateBatchNumber(client, 'packing_reset');

    // Create reversal transaction
    const reversalTransaction = await client.inventoryTransaction.create({
      data: {
        productId,
        type: 'adjustment',
        adjustmentType: 'packing_reset',
        batchNumber: reversalBatchNumber,
        quantity: quantity, // Positive to add back
        previousStock,
        newStock,
        referenceType: 'order',
        referenceId: orderId,
        notes: `Stock restored from packing adjustments on cancelled order ${orderNumber}: ${reason}`,
        createdBy: userId,
      },
    });

    // Create new batch for returned stock
    await client.inventoryBatch.create({
      data: {
        productId,
        batchNumber: reversalBatchNumber,
        quantityRemaining: quantity,
        initialQuantity: quantity,
        costPerUnit: 0, // Unknown cost for returned stock
        receivedAt: new Date(),
        receiveTransactionId: reversalTransaction.id,
        notes: `Stock returned from packing adjustments on cancelled order ${orderNumber}`,
      },
    });

    // Update product stock (floor at 0 as defensive guard)
    await client.product.update({
      where: { id: productId },
      data: { currentStock: Math.max(0, newStock) },
    });

    // Recalculate subproduct stocks if this product is a parent
    const subproducts = await client.product.findMany({
      where: { parentProductId: productId },
      select: { id: true, parentProductId: true, estimatedLossPercentage: true },
    });

    if (subproducts.length > 0) {
      const updatedStocks = calculateAllSubproductStocks(newStock, subproducts);
      for (const { id, newStock: subStock } of updatedStocks) {
        await client.product.update({
          where: { id },
          data: { currentStock: Math.max(0, subStock) },
        });
      }
    }
  }
}
