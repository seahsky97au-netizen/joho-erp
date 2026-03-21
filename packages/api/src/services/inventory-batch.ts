/**
 * Inventory Batch Service
 *
 * Handles FIFO (First-In, First-Out) consumption of inventory batches
 * and tracks cost of goods sold (COGS) per transaction.
 */

import { prisma } from '@joho-erp/database';
import type { PrismaClient } from '@joho-erp/database';

// Type for transaction client (matches stock-restoration.ts)
type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

// Types for batch consumption results
export interface BatchConsumptionRecord {
  batchId: string;
  quantityConsumed: number;
  costPerUnit: number;
  totalCost: number;
}

export interface ExpiryWarning {
  batchId: string;
  expiryDate: Date;
  quantityRemaining: number;
  daysUntilExpiry: number;
}

export interface ConsumeStockResult {
  totalCost: number; // In cents
  batchesUsed: BatchConsumptionRecord[];
  expiryWarnings: ExpiryWarning[];
}

/**
 * Consume stock from batches using FIFO (First-In, First-Out) method
 *
 * @param productId - The product to consume stock from
 * @param quantityToConsume - How much stock to consume
 * @param transactionId - The InventoryTransaction ID that triggered this consumption
 * @param orderId - Optional order ID if this consumption is for an order
 * @param orderNumber - Optional order number for easy lookup
 * @param tx - Prisma transaction context (optional, uses global prisma if not provided)
 * @returns Result with total cost, batches used, and expiry warnings
 * @throws Error if insufficient stock available
 */
export async function consumeStock(
  productId: string,
  quantityToConsume: number,
  transactionId: string,
  orderId?: string,
  orderNumber?: string,
  tx?: Omit<
    PrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
  >
): Promise<ConsumeStockResult> {
  // Use provided transaction context or global prisma instance
  const client = tx || prisma;

  const MAX_RETRIES = 3;
  let retryCount = 0;

  while (retryCount < MAX_RETRIES) {
    try {
      // Step 1: Get available batches in FIFO order (oldest receivedAt first)
      // Filter: quantityRemaining > 0, isConsumed = false
      // Note: Expired batches are included — stock only decreases via manual write-off
      const now = new Date();
      const availableBatches = await client.inventoryBatch.findMany({
        where: {
          productId,
          isConsumed: false,
          quantityRemaining: { gt: 0 },
        },
        orderBy: { receivedAt: 'asc' }, // FIFO: oldest first
      });

      // Step 2: Validate sufficient stock
      const totalAvailable = availableBatches.reduce(
        (sum: number, batch) => sum + batch.quantityRemaining,
        0
      );

      if (totalAvailable < quantityToConsume) {
        throw new Error(
          `Insufficient stock. Need ${quantityToConsume}, have ${totalAvailable}`
        );
      }

      // Step 3: Consume from batches in FIFO order with atomic guards
      let remainingToConsume = quantityToConsume;
      const consumptions: BatchConsumptionRecord[] = [];
      const expiryWarnings: ExpiryWarning[] = [];
      let totalCost = 0;
      let conflictDetected = false;

      for (const batch of availableBatches) {
        if (remainingToConsume < 0.001) break;

        // Check if batch is expired or expires soon (within 7 days)
        if (batch.expiryDate) {
          const daysUntilExpiry = Math.ceil(
            (batch.expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
          );
          if (daysUntilExpiry <= 7) {
            expiryWarnings.push({
              batchId: batch.id,
              expiryDate: batch.expiryDate,
              quantityRemaining: batch.quantityRemaining,
              daysUntilExpiry, // Negative means already expired
            });
          }
        }

        // Consume from this batch
        const quantityFromBatch = Math.min(
          batch.quantityRemaining,
          remainingToConsume
        );

        // Skip near-zero quantities caused by floating-point rounding
        if (quantityFromBatch < 0.001) {
          remainingToConsume -= quantityFromBatch;
          continue;
        }

        // Calculate cost from this batch (in cents)
        const costFromBatch = Math.round(quantityFromBatch * batch.costPerUnit);

        // Calculate new quantity
        const newQuantity = batch.quantityRemaining - quantityFromBatch;
        const isFullyConsumed = newQuantity === 0;

        // ATOMIC GUARD: Use updateMany with WHERE condition on expected quantityRemaining
        // This prevents race conditions where another process consumed from this batch
        const updateResult = await client.inventoryBatch.updateMany({
          where: {
            id: batch.id,
            quantityRemaining: batch.quantityRemaining, // Optimistic lock on expected value
            isConsumed: false, // Must not already be consumed
          },
          data: {
            quantityRemaining: newQuantity,
            isConsumed: isFullyConsumed,
            consumedAt: isFullyConsumed ? new Date() : null,
          },
        });

        // Check if update succeeded (batch wasn't modified by another process)
        if (updateResult.count === 0) {
          // Batch was consumed by another process - conflict detected
          conflictDetected = true;
          break; // Break and retry the entire operation
        }

        // Update succeeded - record the consumption
        consumptions.push({
          batchId: batch.id,
          quantityConsumed: quantityFromBatch,
          costPerUnit: batch.costPerUnit,
          totalCost: costFromBatch,
        });

        totalCost += costFromBatch;

        // Create BatchConsumption record
        await client.batchConsumption.create({
          data: {
            batchId: batch.id,
            transactionId,
            quantityConsumed: quantityFromBatch,
            costPerUnit: batch.costPerUnit,
            totalCost: costFromBatch,
            orderId: orderId || null,
            orderNumber: orderNumber || null,
          },
        });

        remainingToConsume -= quantityFromBatch;
      }

      // If conflict detected, retry the entire operation
      if (conflictDetected) {
        retryCount++;
        if (retryCount >= MAX_RETRIES) {
          throw new Error(
            `Concurrent batch consumption conflict after ${MAX_RETRIES} retries. Please try again.`
          );
        }
        // Small delay before retry to reduce contention
        await new Promise((resolve) => setTimeout(resolve, 50 * retryCount));
        continue; // Retry the loop
      }

      // Check if we consumed enough (shouldn't happen if validation passed, but be safe)
      if (remainingToConsume > 0) {
        throw new Error(
          `Failed to consume all required stock. Remaining: ${remainingToConsume}`
        );
      }

      return {
        totalCost,
        batchesUsed: consumptions,
        expiryWarnings,
      };
    } catch (error) {
      // Re-throw non-conflict errors immediately
      if (error instanceof Error && !error.message.includes('conflict')) {
        console.error('Error consuming stock:', error);
        throw error;
      }
      // For conflict errors, the while loop handles retries
      retryCount++;
      if (retryCount >= MAX_RETRIES) {
        console.error('Error consuming stock after retries:', error);
        throw error;
      }
    }
  }

  // Should never reach here, but TypeScript needs a return
  throw new Error('Unexpected error in consumeStock');
}

/**
 * Consume stock from a specific batch by ID (used when admin selects a batch explicitly)
 *
 * @param batchId - The specific batch to consume from
 * @param quantityToConsume - How much stock to consume
 * @param transactionId - The InventoryTransaction ID that triggered this consumption
 * @param tx - Prisma transaction context (optional, uses global prisma if not provided)
 * @returns Result with total cost, batch used, and expiry warnings
 * @throws Error if batch not found, already consumed, or insufficient quantity
 */
export async function consumeFromBatch(
  batchId: string,
  quantityToConsume: number,
  transactionId: string,
  tx?: Omit<
    PrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
  >
): Promise<ConsumeStockResult> {
  const client = tx || prisma;
  const now = new Date();

  // Step 1: Fetch the batch
  const batch = await client.inventoryBatch.findUnique({
    where: { id: batchId },
  });

  if (!batch) {
    throw new Error(`Batch not found: ${batchId}`);
  }

  if (batch.isConsumed) {
    throw new Error(`Batch ${batchId} is already fully consumed`);
  }

  if (batch.quantityRemaining < quantityToConsume) {
    throw new Error(
      `Insufficient stock in batch. Need ${quantityToConsume}, have ${batch.quantityRemaining}`
    );
  }

  // Step 2: Check expiry warnings
  const expiryWarnings: ExpiryWarning[] = [];
  if (batch.expiryDate) {
    const daysUntilExpiry = Math.ceil(
      (batch.expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (daysUntilExpiry <= 7) {
      expiryWarnings.push({
        batchId: batch.id,
        expiryDate: batch.expiryDate,
        quantityRemaining: batch.quantityRemaining,
        daysUntilExpiry,
      });
    }
  }

  // Step 3: Calculate values
  const costFromBatch = Math.round(quantityToConsume * batch.costPerUnit);
  const newQuantity = batch.quantityRemaining - quantityToConsume;
  const isFullyConsumed = newQuantity === 0;

  // Step 4: Optimistic lock update
  const updateResult = await client.inventoryBatch.updateMany({
    where: {
      id: batch.id,
      quantityRemaining: batch.quantityRemaining, // Optimistic lock
      isConsumed: false,
    },
    data: {
      quantityRemaining: newQuantity,
      isConsumed: isFullyConsumed,
      consumedAt: isFullyConsumed ? new Date() : null,
    },
  });

  if (updateResult.count === 0) {
    throw new Error(
      'Concurrent batch consumption conflict. The batch was modified by another process. Please try again.'
    );
  }

  // Step 5: Create BatchConsumption record
  await client.batchConsumption.create({
    data: {
      batchId: batch.id,
      transactionId,
      quantityConsumed: quantityToConsume,
      costPerUnit: batch.costPerUnit,
      totalCost: costFromBatch,
    },
  });

  return {
    totalCost: costFromBatch,
    batchesUsed: [
      {
        batchId: batch.id,
        quantityConsumed: quantityToConsume,
        costPerUnit: batch.costPerUnit,
        totalCost: costFromBatch,
      },
    ],
    expiryWarnings,
  };
}

/**
 * Check if there is sufficient non-expired stock available
 *
 * @param productId - The product to check
 * @param quantityNeeded - How much stock is needed
 * @param prisma - Prisma client instance (optional)
 * @returns True if sufficient stock available, false otherwise
 */
export async function hasAvailableStock(
  productId: string,
  quantityNeeded: number,
  tx?: Omit<
    PrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
  >
): Promise<boolean> {
  const client = tx || prisma;

  try {
    const availableBatches = await client.inventoryBatch.findMany({
      where: {
        productId,
        isConsumed: false,
        quantityRemaining: { gt: 0 },
      },
      select: { quantityRemaining: true },
    });

    const totalAvailable = availableBatches.reduce(
      (sum: number, batch) => sum + batch.quantityRemaining,
      0
    );

    return totalAvailable >= quantityNeeded;
  } catch (error) {
    console.error('Error checking available stock:', error);
    throw error;
  }
}

export interface StockDiscrepancy {
  productId: string;
  productName: string;
  sku: string;
  previousStock: number;
  batchSum: number;
  diff: number;
}

/**
 * Sync a single product's currentStock with actual batch quantities.
 * Recalculates from SUM(batch.quantityRemaining) and updates the product.
 *
 * @param productId - The product to sync
 * @param tx - Prisma transaction context (optional)
 * @returns The new stock value
 */
export async function syncProductCurrentStock(
  productId: string,
  tx?: Omit<
    PrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
  >
): Promise<number> {
  const client = tx || prisma;
  const batchSum = await getAvailableStockQuantity(productId, client);
  await client.product.update({
    where: { id: productId },
    data: { currentStock: batchSum },
  });
  return batchSum;
}

/**
 * Sync currentStock with actual batch availability for ALL products.
 * Products may show stale currentStock if their batches have expired since the last update.
 * This function recalculates currentStock based on non-consumed batch quantities,
 * and updates subproduct stocks for any affected parents.
 *
 * @param tx - Optional Prisma transaction context
 * @returns List of discrepancies found and corrected
 */
export async function syncCurrentStock(
  tx?: Omit<
    PrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
  >
): Promise<StockDiscrepancy[]> {
  const client = tx || prisma;
  const TOLERANCE = 0.001;

  // Get all parent products (non-subproducts) with their current stock
  const products = await client.product.findMany({
    where: { parentProductId: null },
    select: { id: true, name: true, sku: true, currentStock: true, estimatedLossPercentage: true },
  });

  const discrepancies: StockDiscrepancy[] = [];

  for (const product of products) {
    const batchSum = await getAvailableStockQuantity(product.id, client);
    const diff = product.currentStock - batchSum;

    if (Math.abs(diff) > TOLERANCE) {
      discrepancies.push({
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        previousStock: product.currentStock,
        batchSum,
        diff,
      });

      // Update the product's currentStock
      await client.product.update({
        where: { id: product.id },
        data: { currentStock: batchSum },
      });
    }

    // Always cascade to subproducts (even if parent didn't change,
    // subproducts may be stale)
    const subproducts = await client.product.findMany({
      where: { parentProductId: product.id },
      select: { id: true, parentProductId: true, estimatedLossPercentage: true },
    });

    if (subproducts.length > 0) {
      const { calculateAllSubproductStocksWithInheritance } = await import('@joho-erp/shared');
      const updatedStocks = calculateAllSubproductStocksWithInheritance(
        batchSum,
        product.estimatedLossPercentage,
        subproducts
      );
      for (const { id, newStock } of updatedStocks) {
        await client.product.update({
          where: { id },
          data: { currentStock: Math.max(0, newStock) },
        });
      }
    }
  }

  return discrepancies;
}

/**
 * Get the total available (non-expired) stock for a product
 *
 * @param productId - The product to check
 * @param prisma - Prisma client instance (optional)
 * @returns Total quantity available in non-expired batches
 */
export async function getAvailableStockQuantity(
  productId: string,
  tx?: Omit<
    PrismaClient,
    '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
  >
): Promise<number> {
  const client = tx || prisma;

  try {
    const availableBatches = await client.inventoryBatch.findMany({
      where: {
        productId,
        isConsumed: false,
        quantityRemaining: { gt: 0 },
      },
      select: { quantityRemaining: true },
    });

    return availableBatches.reduce(
      (sum: number, batch) => sum + batch.quantityRemaining,
      0
    );
  } catch (error) {
    console.error('Error getting available stock quantity:', error);
    throw error;
  }
}

/**
 * Reverse batch consumptions by restoring original batch quantities.
 *
 * Instead of creating anonymous batches (which lose supplier traceability),
 * this finds the BatchConsumption records for the given transactions and
 * restores each original batch's quantityRemaining.
 *
 * @param transactionIds - InventoryTransaction IDs whose consumptions to reverse
 * @param tx - Prisma transaction context
 * @returns Total quantity restored across all batches
 */
export async function restoreBatchConsumptions(
  transactionIds: string[],
  tx: TransactionClient
): Promise<number> {
  if (transactionIds.length === 0) return 0;

  // Find all BatchConsumption records for these transactions
  const consumptions = await tx.batchConsumption.findMany({
    where: { transactionId: { in: transactionIds } },
  });

  if (consumptions.length === 0) return 0;

  let totalRestored = 0;

  for (const consumption of consumptions) {
    // Fetch the original batch
    const batch = await tx.inventoryBatch.findUnique({
      where: { id: consumption.batchId },
    });

    if (!batch) {
      console.warn(
        `[restoreBatchConsumptions] Batch ${consumption.batchId} not found, skipping`
      );
      continue;
    }

    // Restore quantityRemaining, capping at initialQuantity to prevent double-restoration
    const restoredQty = Math.min(
      batch.quantityRemaining + consumption.quantityConsumed,
      batch.initialQuantity
    );

    await tx.inventoryBatch.update({
      where: { id: batch.id },
      data: {
        quantityRemaining: restoredQty,
        // Un-mark consumed if we've restored any quantity
        isConsumed: restoredQty <= 0,
        consumedAt: restoredQty > 0 ? null : batch.consumedAt,
      },
    });

    totalRestored += consumption.quantityConsumed;
  }

  // Delete the BatchConsumption records (audit trail lives in InventoryTransaction with reversedAt)
  await tx.batchConsumption.deleteMany({
    where: { transactionId: { in: transactionIds } },
  });

  return totalRestored;
}
