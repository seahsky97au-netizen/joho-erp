'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Badge,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@joho-erp/ui';
import {
  ArrowRight,
  ArrowRightLeft,
  Calendar,
  DollarSign,
  FileText,
  Percent,
  User,
  Hash,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatAUD } from '@joho-erp/shared';
import { api } from '@/trpc/client';

interface ProcessingRecordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batchNumber: string | null;
}

export function ProcessingRecordDialog({
  open,
  onOpenChange,
  batchNumber,
}: ProcessingRecordDialogProps) {
  const t = useTranslations('inventory.processingRecord');

  const { data: record, isLoading } =
    api.inventory.getProcessingRecordByBatchNumber.useQuery(
      { batchNumber: batchNumber! },
      { enabled: !!batchNumber && open }
    );

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  };

  const formatDateTime = (date: string | Date) => {
    return new Date(date).toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5" />
            {t('title')}
          </DialogTitle>
          <DialogDescription>
            {batchNumber && (
              <Badge variant="secondary" className="font-mono">
                {batchNumber}
              </Badge>
            )}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : record ? (
          <div className="space-y-6">
            {/* Source → Target(s) Flow */}
            <div className="p-4 bg-muted/50 rounded-lg">
              <p className="text-xs font-medium text-muted-foreground mb-3">
                {t('processingFlow')}
              </p>
              <div className="flex items-start gap-3">
                {/* Source */}
                {record.source && (
                  <div className="flex-1 text-center p-3 rounded-md bg-destructive/10 border border-destructive/20">
                    <p className="text-sm font-medium">{record.source.productName}</p>
                    <p className="text-xs text-muted-foreground">{record.source.productSku}</p>
                    <p className="text-lg font-bold text-destructive mt-1">
                      -{record.source.quantity} {record.source.productUnit}
                    </p>
                    <p className="text-xs text-muted-foreground">{t('inputQuantity')}</p>
                  </div>
                )}
                <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0 mt-6" />
                {/* Targets */}
                <div className="flex-1 space-y-2">
                  {record.targets.map((target) => (
                    <div
                      key={target.id}
                      className="text-center p-3 rounded-md bg-success/10 border border-success/20"
                    >
                      <p className="text-sm font-medium">{target.productName}</p>
                      <p className="text-xs text-muted-foreground">{target.productSku}</p>
                      <p className="text-lg font-bold text-success mt-1">
                        +{target.quantity} {target.productUnit}
                      </p>
                      <p className="text-xs text-muted-foreground">{t('outputQuantity')}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Processing Metrics */}
            <div className="grid grid-cols-2 gap-4">
              {record.lossPercentage !== null && (
                <div className="flex items-center gap-3 text-sm">
                  <Percent className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-muted-foreground">{t('lossPercentage')}</p>
                    <p className="font-medium">{record.lossPercentage}%</p>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-3 text-sm">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-muted-foreground">{t('totalMaterialCost')}</p>
                  <p className="font-medium">{formatAUD(record.totalMaterialCost)}</p>
                </div>
              </div>
            </div>

            {/* Per-target breakdown */}
            {record.targets.length > 1 && (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold">{t('targetsBreakdown')}</h4>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('targetProduct')}</TableHead>
                        <TableHead className="text-right">{t('outputQuantity')}</TableHead>
                        <TableHead className="text-right">{t('outputCostPerUnit')}</TableHead>
                        <TableHead>{t('outputExpiryDate')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {record.targets.map((target) => (
                        <TableRow key={target.id}>
                          <TableCell>
                            <div>
                              <p className="font-medium text-sm">{target.productName}</p>
                              <p className="text-xs text-muted-foreground">{target.productSku}</p>
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-sm">
                            {target.quantity.toFixed(1)} {target.productUnit}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-sm">
                            {target.costPerUnit !== null ? formatAUD(target.costPerUnit) : '-'}
                          </TableCell>
                          <TableCell className="text-sm">
                            {target.expiryDate ? formatDate(target.expiryDate) : '-'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {/* Single-target detail (only when there's exactly one target) */}
            {record.targets.length === 1 && (
              <div className="grid grid-cols-2 gap-4">
                {record.targets[0]!.costPerUnit != null && (
                  <div className="flex items-center gap-3 text-sm">
                    <DollarSign className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-muted-foreground">{t('outputCostPerUnit')}</p>
                      <p className="font-medium">
                        {formatAUD(record.targets[0]!.costPerUnit!)}
                      </p>
                    </div>
                  </div>
                )}
                {record.targets[0]!.expiryDate && (
                  <div className="flex items-center gap-3 text-sm">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-muted-foreground">{t('outputExpiryDate')}</p>
                      <p className="font-medium">{formatDate(record.targets[0]!.expiryDate!)}</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Source Batches Consumed Table */}
            {record.batchConsumptions.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold">{t('sourceBatchesConsumed')}</h4>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('batchNumber')}</TableHead>
                        <TableHead>{t('expiry')}</TableHead>
                        <TableHead className="text-right">{t('qtyConsumed')}</TableHead>
                        <TableHead className="text-right">{t('costPerUnit')}</TableHead>
                        <TableHead className="text-right">{t('subtotal')}</TableHead>
                        <TableHead>{t('supplier')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {record.batchConsumptions.map((bc, idx) => (
                        <TableRow key={idx}>
                          <TableCell>
                            {bc.batch?.batchNumber ? (
                              <Badge variant="secondary" className="font-mono text-xs">
                                <Hash className="mr-1 h-3 w-3" />
                                {bc.batch.batchNumber}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">&mdash;</span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">
                            {bc.batch?.expiryDate
                              ? formatDate(bc.batch.expiryDate)
                              : '-'}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-sm">
                            {bc.quantityConsumed.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-sm">
                            {formatAUD(bc.costPerUnit)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-sm">
                            {formatAUD(bc.totalCost)}
                          </TableCell>
                          <TableCell className="text-sm">
                            {bc.supplierName ?? '-'}
                          </TableCell>
                        </TableRow>
                      ))}
                      {/* Total row */}
                      <TableRow className="bg-muted/50 font-semibold">
                        <TableCell colSpan={4} className="text-right text-sm">
                          {t('totalMaterialCost')}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm">
                          {formatAUD(record.totalMaterialCost)}
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {record.batchConsumptions.length === 0 && (
              <p className="text-sm text-muted-foreground italic">{t('noBatchData')}</p>
            )}

            {/* Notes */}
            <div className="pt-4 border-t space-y-3">
              <div className="flex items-start gap-3 text-sm">
                <FileText className="h-4 w-4 text-muted-foreground mt-0.5" />
                <span className="text-muted-foreground">{t('notes')}:</span>
                <span className="font-medium flex-1">
                  {record.notes || t('noNotes')}
                </span>
              </div>
            </div>

            {/* Metadata */}
            <div className="pt-4 border-t space-y-3">
              <div className="flex items-center gap-3 text-sm">
                <User className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">{t('performedBy')}:</span>
                <span className="font-medium">{record.createdBy}</span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">{t('dateTime')}:</span>
                <span className="font-medium">{formatDateTime(record.createdAt)}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="py-8 text-center text-muted-foreground">
            {t('notFound')}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
