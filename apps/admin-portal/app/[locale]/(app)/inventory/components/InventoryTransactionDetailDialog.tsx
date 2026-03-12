'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Badge,
  Button,
} from '@joho-erp/ui';
import {
  ArrowRight,
  ExternalLink,
  Package,
  Calendar,
  User,
  FileText,
  DollarSign,
  Truck,
  Building2,
  Thermometer,
  Layers,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatAUD } from '@joho-erp/shared';
import Link from 'next/link';

// Transaction type from API
export interface InventoryTransaction {
  id: string;
  productId: string;
  productName: string;
  productSku: string;
  productUnit: string;
  type: 'sale' | 'adjustment' | 'return';
  adjustmentType?: string | null;
  quantity: number;
  previousStock: number;
  newStock: number;
  notes?: string | null;
  createdBy: string;
  createdAt: string | Date;
  costPerUnit?: number | null;
  expiryDate?: string | Date | null;
  referenceType?: 'order' | 'manual' | null;
  referenceId?: string | null;
  // Batch number from the transaction
  batchNumber?: string | null;
  // Stock receipt fields from InventoryBatch
  stockInDate?: string | Date | null;
  supplierInvoiceNumber?: string | null;
  mtvNumber?: string | null;
  vehicleTemperature?: number | null;
  supplierId?: string | null;
  supplierName?: string | null;
  // Batch consumptions (FIFO tracking)
  batchConsumptions?: Array<{
    id: string;
    quantityConsumed: number;
    batchId: string;
    batchNumber: string | null;
    batchReceivedAt: string | Date;
    batchExpiryDate: string | Date | null;
  }>;
}

interface InventoryTransactionDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: InventoryTransaction | null;
}

export function InventoryTransactionDetailDialog({
  open,
  onOpenChange,
  transaction,
}: InventoryTransactionDetailDialogProps) {
  const t = useTranslations('inventory');
  const tDetail = useTranslations('inventory.transactionDetail');

  if (!transaction) return null;

  const getTypeBadgeVariant = (
    type: string
  ): 'default' | 'destructive' | 'outline' | 'secondary' => {
    switch (type) {
      case 'sale':
        return 'destructive';
      case 'return':
        return 'default';
      case 'adjustment':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'sale':
        return t('types.sale');
      case 'return':
        return t('types.return');
      case 'adjustment':
        return t('types.adjustment');
      default:
        return type;
    }
  };

  const getAdjustmentTypeLabel = (adjType: string) => {
    const key = `adjustmentTypes.${adjType}` as const;
    return t(key as 'adjustmentTypes.stock_received');
  };

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatExpiryDate = (date: string | Date) => {
    return new Date(date).toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            {tDetail('title')}
          </DialogTitle>
          <DialogDescription>
            {transaction.productName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Product Info */}
          <div className="space-y-2">
            <p className="font-semibold text-lg">{transaction.productName}</p>
            <p className="text-sm text-muted-foreground">{transaction.productSku}</p>
          </div>

          {/* Transaction Type */}
          <div className="flex items-center gap-2">
            <Badge variant={getTypeBadgeVariant(transaction.type)}>
              {getTypeLabel(transaction.type)}
            </Badge>
            {transaction.adjustmentType && (
              <span className="text-sm text-muted-foreground">
                ({getAdjustmentTypeLabel(transaction.adjustmentType)})
              </span>
            )}
          </div>

          {/* Quantity Change */}
          <div className="p-4 bg-muted/50 rounded-lg">
            <div className="flex items-center justify-between">
              <div className="text-center">
                <p className="text-sm text-muted-foreground">{tDetail('previousStock')}</p>
                <p className="text-xl font-semibold">{transaction.previousStock}</p>
              </div>
              <ArrowRight className="h-6 w-6 text-muted-foreground" />
              <div className="text-center">
                <p className="text-sm text-muted-foreground">{tDetail('newStock')}</p>
                <p className="text-xl font-semibold">{transaction.newStock}</p>
              </div>
            </div>
            <div className="mt-3 text-center">
              <span
                className={`text-lg font-semibold ${
                  transaction.quantity > 0 ? 'text-success' : 'text-destructive'
                }`}
              >
                {transaction.quantity > 0 ? '+' : ''}
                {transaction.quantity} {transaction.productUnit}
              </span>
            </div>
          </div>

          {/* Additional Details */}
          <div className="space-y-3">
            {/* Cost per Unit (only for stock_received) */}
            {transaction.costPerUnit !== null && transaction.costPerUnit !== undefined && (
              <div className="flex items-center gap-3 text-sm">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">{tDetail('costPerUnit')}:</span>
                <span className="font-medium">{formatAUD(transaction.costPerUnit)}</span>
              </div>
            )}

            {/* Expiry Date (only for stock_received) */}
            {transaction.expiryDate && (
              <div className="flex items-center gap-3 text-sm">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">{tDetail('expiryDate')}:</span>
                <span className="font-medium">{formatExpiryDate(transaction.expiryDate)}</span>
              </div>
            )}

            {/* Created By */}
            <div className="flex items-center gap-3 text-sm">
              <User className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">{tDetail('createdBy')}:</span>
              <span className="font-medium">{transaction.createdBy}</span>
            </div>

            {/* Timestamp */}
            <div className="flex items-center gap-3 text-sm">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">{tDetail('timestamp')}:</span>
              <span className="font-medium">{formatDate(transaction.createdAt)}</span>
            </div>

            {/* Notes */}
            <div className="flex items-start gap-3 text-sm">
              <FileText className="h-4 w-4 text-muted-foreground mt-0.5" />
              <span className="text-muted-foreground">{tDetail('notes')}:</span>
              <span className="font-medium flex-1">
                {transaction.notes || tDetail('noNotes')}
              </span>
            </div>
          </div>

          {/* Stock Receipt Details (only for stock_received adjustments) */}
          {transaction.adjustmentType === 'stock_received' &&
            (transaction.stockInDate ||
              transaction.supplierName ||
              transaction.supplierInvoiceNumber ||
              transaction.mtvNumber ||
              transaction.vehicleTemperature != null) && (
              <div className="pt-4 border-t space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  <Truck className="h-4 w-4" />
                  {tDetail('stockReceiptDetails')}
                </h4>

                {transaction.stockInDate && (
                  <div className="flex items-center gap-3 text-sm">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">{tDetail('stockInDate')}:</span>
                    <span className="font-medium">{formatExpiryDate(transaction.stockInDate)}</span>
                  </div>
                )}

                {transaction.supplierName && (
                  <div className="flex items-center gap-3 text-sm">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">{tDetail('supplier')}:</span>
                    <span className="font-medium">{transaction.supplierName}</span>
                  </div>
                )}

                {transaction.supplierInvoiceNumber && (
                  <div className="flex items-center gap-3 text-sm">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">{tDetail('invoiceNumber')}:</span>
                    <span className="font-medium">{transaction.supplierInvoiceNumber}</span>
                  </div>
                )}

                {transaction.mtvNumber && (
                  <div className="flex items-center gap-3 text-sm">
                    <Truck className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">{tDetail('mtvNumber')}:</span>
                    <span className="font-medium">{transaction.mtvNumber}</span>
                  </div>
                )}

                {transaction.vehicleTemperature != null && (
                  <div className="flex items-center gap-3 text-sm">
                    <Thermometer className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">{tDetail('vehicleTemperature')}:</span>
                    <span className="font-medium">{transaction.vehicleTemperature}°C</span>
                  </div>
                )}
              </div>
            )}

          {/* Batch Consumptions (FIFO) */}
          {transaction.batchConsumptions && transaction.batchConsumptions.length > 0 && (
            <div className="pt-4 border-t space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Layers className="h-4 w-4" />
                {tDetail('batchesConsumed')}
              </h4>
              <div className="space-y-2">
                {transaction.batchConsumptions.map((bc) => (
                  <div
                    key={bc.id}
                    className="flex items-center justify-between p-2 bg-muted/30 rounded-md text-sm"
                  >
                    <div>
                      <span className="font-medium">
                        {bc.batchNumber || tDetail('unknownBatch')}
                      </span>
                      <span className="text-muted-foreground ml-2">
                        {formatExpiryDate(bc.batchReceivedAt)}
                      </span>
                      {bc.batchExpiryDate && (
                        <span className="text-muted-foreground ml-2">
                          ({tDetail('expires')} {formatExpiryDate(bc.batchExpiryDate)})
                        </span>
                      )}
                    </div>
                    <span className="font-medium text-destructive tabular-nums">
                      -{bc.quantityConsumed} {transaction.productUnit}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Order Reference Link */}
          {transaction.referenceType === 'order' && transaction.referenceId && (
            <div className="pt-4 border-t">
              <Button variant="outline" className="w-full" asChild>
                <Link href={`/orders/${transaction.referenceId}`}>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {tDetail('viewOrder')}
                </Link>
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
