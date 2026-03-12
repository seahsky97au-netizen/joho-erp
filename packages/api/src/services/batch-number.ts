/**
 * Batch Number Generation Service
 *
 * Generates system-prefixed sequential batch numbers for inventory operations.
 * Format: {PREFIX}-{XXXXXX} (e.g., SI-000001, WO-000002)
 *
 * Prefixes:
 *   SI = Stock Received (stock_received)
 *   WO = Stock Write-Off (stock_write_off)
 *   CC = Stock Count Correction (stock_count_correction)
 *   PR = Processing (processing)
 *   PA = Packing Adjustment (packing_adjustment)
 *
 * For stock_received: batches with the same supplierInvoiceNumber share a batch number.
 */

import type { PrismaClient } from '@joho-erp/database';

type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

type AdjustmentType =
  | 'stock_received'
  | 'stock_write_off'
  | 'stock_count_correction'
  | 'processing'
  | 'packing_adjustment'
  | 'packing_reset'
  | 'stock_return';

const ADJUSTMENT_TYPE_TO_PREFIX: Record<AdjustmentType, string> = {
  stock_received: 'SI',
  stock_write_off: 'WO',
  stock_count_correction: 'CC',
  processing: 'PR',
  packing_adjustment: 'PA',
  packing_reset: 'PA',
  stock_return: 'SR',
};

/**
 * Generate or retrieve a batch number for an inventory operation.
 *
 * For stock_received with a supplierInvoiceNumber, looks up whether a batch
 * with that invoice already exists. If so, reuses its batch number.
 * Otherwise, atomically increments the counter for the prefix type.
 *
 * @param tx - Prisma transaction client (must be used within a $transaction)
 * @param adjustmentType - The type of stock adjustment
 * @param supplierInvoiceNumber - Required for stock_received; triggers grouping
 * @param supplierId - Scopes invoice number matching to a specific supplier
 * @returns The generated batch number string (e.g., "SI-000001")
 */
export async function generateBatchNumber(
  tx: TransactionClient,
  adjustmentType: AdjustmentType,
  supplierInvoiceNumber?: string,
  supplierId?: string,
): Promise<string> {
  const prefix = ADJUSTMENT_TYPE_TO_PREFIX[adjustmentType];

  if (!prefix) {
    throw new Error(`Unknown adjustment type: ${adjustmentType}`);
  }

  // For stock_received with a supplier invoice, check for existing batch number
  if (adjustmentType === 'stock_received' && supplierInvoiceNumber) {
    const existingBatch = await tx.inventoryBatch.findFirst({
      where: {
        supplierInvoiceNumber,
        supplierId,
        batchNumber: { not: null },
      },
      select: { batchNumber: true },
      orderBy: { createdAt: 'desc' },
    });

    if (existingBatch?.batchNumber) {
      return existingBatch.batchNumber;
    }
  }

  // Atomically increment the counter for this prefix type
  const result = await tx.batchCounter.upsert({
    where: { type: prefix },
    create: { type: prefix, counter: 1 },
    update: { counter: { increment: 1 } },
  });

  return `${prefix}-${result.counter.toString().padStart(6, '0')}`;
}
