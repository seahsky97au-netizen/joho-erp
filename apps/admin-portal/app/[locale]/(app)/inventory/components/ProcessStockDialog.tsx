'use client';

import { useState, useMemo, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
  Label,
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@joho-erp/ui';
import { format, addDays, addMonths } from 'date-fns';
import {
  Loader2,
  Package,
  ArrowRight,
  TrendingDown,
  AlertTriangle,
  Info,
  Search,
  X,
  Plus,
  Trash2,
} from 'lucide-react';
import { api } from '@/trpc/client';
import { useToast } from '@joho-erp/ui';
import { useTranslations } from 'next-intl';
import { parseToCents, formatAUD } from '@joho-erp/shared';

interface Product {
  id: string;
  name: string;
  sku: string;
  currentStock: number;
  unit: string;
  parentProductId?: string | null;
  estimatedLossPercentage?: number | null;
  categoryRelation?: {
    id: string;
    name: string;
    processingLossPercentage?: number | null;
  } | null;
}

interface ProcessStockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceProduct?: Product | null;
  onSuccess: () => void;
}

type TargetRow = {
  rowId: string;
  product: Product | null;
  outputQuantity: string;
  costPerUnit: string;
  expirySelection: string;
  customExpiryDate: Date | undefined;
};

const newRow = (): TargetRow => ({
  rowId: `target-${Math.random().toString(36).slice(2, 10)}`,
  product: null,
  outputQuantity: '',
  costPerUnit: '',
  expirySelection: '',
  customExpiryDate: undefined,
});

export function ProcessStockDialog({
  open,
  onOpenChange,
  sourceProduct: initialSource,
  onSuccess,
}: ProcessStockDialogProps) {
  const { toast } = useToast();
  const t = useTranslations('processStock');
  const tErrors = useTranslations('errors');
  const tCommon = useTranslations('common');

  // Product selection state
  const [sourceProduct, setSourceProduct] = useState<Product | null>(initialSource || null);
  const [targetRows, setTargetRows] = useState<TargetRow[]>(() => [newRow()]);
  const [productSearch, setProductSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // Either selecting source, or selecting a target row by its rowId
  const [selectionMode, setSelectionMode] = useState<
    { kind: 'none' } | { kind: 'source' } | { kind: 'target'; rowId: string }
  >({ kind: 'none' });

  useEffect(() => {
    setSourceProduct(initialSource || null);
  }, [initialSource]);

  // Debounce product search (300ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(productSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [productSearch]);

  // Fetch products for selection
  const { data: productsData, isLoading: productsLoading } = api.product.getAll.useQuery(
    {
      search: debouncedSearch,
      status: 'active' as const,
      limit: 100,
    },
    { enabled: selectionMode.kind !== 'none' && open }
  );

  // Fetch source product batches for FIFO cost calculation
  const { data: sourceBatches } = api.inventory.getProductBatches.useQuery(
    { productId: sourceProduct?.id ?? '', includeConsumed: false, batchPrefix: 'SI-' },
    { enabled: !!sourceProduct && open }
  );

  // Batch & quantity state
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const selectedBatch = useMemo(
    () => (sourceBatches ?? []).find((b) => b.id === selectedBatchId) ?? null,
    [sourceBatches, selectedBatchId]
  );
  const [sourceQuantity, setSourceQuantity] = useState<string>('');
  const [notes, setNotes] = useState('');

  // Reset everything that depends on source product when it changes
  useEffect(() => {
    setSelectedBatchId(null);
    setSourceQuantity('');
    setTargetRows([newRow()]);
  }, [sourceProduct]);

  const sourceQty = parseFloat(sourceQuantity) || 0;
  const totalOutputQty = useMemo(
    () =>
      targetRows.reduce((sum, r) => sum + (parseFloat(r.outputQuantity) || 0), 0),
    [targetRows]
  );
  const lossAmount = Math.max(0, sourceQty - totalOutputQty);
  const lossPercentage =
    sourceQty > 0 && totalOutputQty <= sourceQty
      ? ((sourceQty - totalOutputQty) / sourceQty) * 100
      : 0;

  // Material cost (cents) consumed from source batches for the chosen sourceQty.
  const totalMaterialCostCents = useMemo(() => {
    if (sourceQty <= 0) return 0;
    if (selectedBatch) {
      return Math.round(sourceQty * selectedBatch.costPerUnit);
    }
    const batches = sourceBatches ?? [];
    let remaining = sourceQty;
    let cents = 0;
    for (const batch of batches) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, batch.quantityRemaining);
      cents += Math.round(take * batch.costPerUnit);
      remaining -= take;
    }
    return cents;
  }, [sourceBatches, selectedBatch, sourceQty]);

  // Suggested material cost per kg, allocated proportionally across all targets.
  // Each row's output share = outputQty / totalOutputQty.
  const suggestedMaterialCostPerKgDollars =
    totalOutputQty > 0 ? totalMaterialCostCents / 100 / totalOutputQty : 0;

  const updateRow = (rowId: string, patch: Partial<TargetRow>) => {
    setTargetRows((rows) => rows.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)));
  };
  const addRow = () => setTargetRows((rows) => [...rows, newRow()]);
  const removeRow = (rowId: string) =>
    setTargetRows((rows) => (rows.length > 1 ? rows.filter((r) => r.rowId !== rowId) : rows));

  // Per-row expiry resolution
  const getRowExpiryDate = (row: TargetRow): Date | undefined => {
    const sel = row.expirySelection;
    if (!sel || sel === 'none') return undefined;
    if (sel === 'custom') return row.customExpiryDate;
    if (sel === 'followParent')
      return selectedBatch?.expiryDate ? new Date(selectedBatch.expiryDate) : undefined;
    const today = new Date();
    switch (sel) {
      case '3d':
        return addDays(today, 3);
      case '5d':
        return addDays(today, 5);
      case '10d':
        return addDays(today, 10);
      case '1M':
        return addMonths(today, 1);
      default:
        return undefined;
    }
  };

  // Validation
  const validationErrors = useMemo(() => {
    const errors: string[] = [];

    if (!sourceProduct) errors.push(t('validation.sourceRequired'));
    if (sourceProduct && !selectedBatch) errors.push(t('validation.batchRequired'));
    if (sourceQty <= 0) errors.push(t('validation.sourceQuantityRequired'));
    if (selectedBatch && sourceQty > selectedBatch.quantityRemaining) {
      errors.push(
        t('validation.sourceQuantityExceedsBatch', {
          available: selectedBatch.quantityRemaining.toFixed(2),
        })
      );
    }

    // Per-row validation
    const productIds = new Set<string>();
    let dupTarget = false;
    let sourceAsTarget = false;
    let missingProduct = false;
    let badQty = false;
    let badCost = false;
    for (const row of targetRows) {
      if (!row.product) {
        missingProduct = true;
        continue;
      }
      if (sourceProduct && row.product.id === sourceProduct.id) {
        sourceAsTarget = true;
      }
      if (productIds.has(row.product.id)) {
        dupTarget = true;
      }
      productIds.add(row.product.id);
      const out = parseFloat(row.outputQuantity) || 0;
      if (out <= 0) badQty = true;
      const cents = parseToCents(row.costPerUnit);
      if (!cents) badCost = true;
    }
    if (missingProduct) errors.push(t('validation.targetRequired'));
    if (sourceAsTarget) errors.push(t('validation.sameProduct'));
    if (dupTarget) errors.push(t('validation.duplicateTarget'));
    if (badQty) errors.push(t('validation.quantityPositive'));
    if (badCost) errors.push(t('validation.costRequired'));

    if (sourceQty > 0 && totalOutputQty > sourceQty) {
      errors.push(t('validation.outputExceedsInput'));
    }

    return errors;
  }, [sourceProduct, selectedBatch, sourceQty, targetRows, totalOutputQty, t]);

  const processStockMutation = api.product.processStock.useMutation({
    onSuccess: (result) => {
      toast({
        title: t('messages.success'),
        description: t('messages.successDetailsMulti', {
          processed: result.quantityProcessed,
          targetCount: result.targets.length,
          sourceUnit: sourceProduct?.unit || '',
        }),
      });

      if (result.expiryWarnings && result.expiryWarnings.length > 0) {
        toast({
          title: t('warnings.expiryTitle'),
          description: t('warnings.expiryMessage', { count: result.expiryWarnings.length }),
          variant: 'destructive',
        });
      }

      handleReset();
      onSuccess();
      onOpenChange(false);
    },
    onError: (error) => {
      console.error('Operation error:', error.message);
      toast({
        title: t('messages.error'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceProduct || validationErrors.length > 0) return;

    const targets: Array<{
      productId: string;
      outputQuantity: number;
      costPerUnit: number;
      expiryDate?: Date;
    }> = [];
    for (const row of targetRows) {
      if (!row.product) return;
      const cents = parseToCents(row.costPerUnit);
      if (!cents) return;
      targets.push({
        productId: row.product.id,
        outputQuantity: parseFloat(row.outputQuantity),
        costPerUnit: cents,
        ...(getRowExpiryDate(row) && { expiryDate: getRowExpiryDate(row)! }),
      });
    }

    await processStockMutation.mutateAsync({
      sourceProductId: sourceProduct.id,
      sourceBatchId: selectedBatch?.id,
      sourceQuantity: sourceQty,
      targets,
      notes: notes.trim() || undefined,
    });
  };

  const handleReset = () => {
    setSourceProduct(null);
    setSelectedBatchId(null);
    setSourceQuantity('');
    setTargetRows([newRow()]);
    setNotes('');
    setProductSearch('');
    setSelectionMode({ kind: 'none' });
  };

  const handleProductSelect = (product: Product) => {
    if (selectionMode.kind === 'source') {
      setSourceProduct(product);
    } else if (selectionMode.kind === 'target') {
      updateRow(selectionMode.rowId, { product });
    }
    setSelectionMode({ kind: 'none' });
    setProductSearch('');
  };

  const products = ((productsData?.items || []) as unknown as Product[]).filter(
    (p) => !p.parentProductId
  );
  const isLoading = processStockMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            {t('dialog.title')}
          </DialogTitle>
          <DialogDescription>{t('dialog.description')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Source Product */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{t('fields.sourceProduct')}</h3>
            {sourceProduct ? (
              <div className="p-3 border rounded-md bg-muted/30">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <p className="font-medium">{sourceProduct.name}</p>
                    <p className="text-sm text-muted-foreground">{sourceProduct.sku}</p>
                    <p className="text-sm mt-1">
                      {t('preview.source')}:{' '}
                      <span className="font-medium">
                        {sourceProduct.currentStock} {sourceProduct.unit}
                      </span>
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSourceProduct(null);
                      setSelectionMode({ kind: 'source' });
                    }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => setSelectionMode({ kind: 'source' })}
              >
                <Search className="h-4 w-4 mr-2" />
                {t('dialog.selectSource')}
              </Button>
            )}

            {/* Batch selection */}
            {sourceProduct && sourceBatches && (
              <div className="space-y-2">
                <Label>{t('fields.sourceBatch')}</Label>
                <p className="text-xs text-muted-foreground">{t('fields.sourceBatchHint')}</p>
                {sourceBatches.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4 border rounded-md">
                    {t('fields.noBatchesAvailable')}
                  </p>
                ) : (
                  <div className="max-h-[200px] overflow-y-auto space-y-1">
                    {sourceBatches.map((batch) => (
                      <button
                        key={batch.id}
                        type="button"
                        className={`w-full text-left p-3 border rounded-md transition-colors ${
                          selectedBatchId === batch.id
                            ? 'border-primary ring-2 ring-primary/20 bg-primary/5'
                            : 'hover:bg-muted/50'
                        }`}
                        onClick={() => setSelectedBatchId(batch.id)}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <Badge variant="secondary" className="shrink-0">
                              {batch.batchNumber || batch.id.slice(0, 8)}
                            </Badge>
                            <div className="flex items-center gap-3 text-sm">
                              <span>
                                {t('fields.batchQtyRemaining')}:{' '}
                                <span className="font-medium">{batch.quantityRemaining}</span>
                              </span>
                              <span>
                                {t('fields.batchCost')}:{' '}
                                <span className="font-medium">
                                  {formatAUD(batch.costPerUnit)}/unit
                                </span>
                              </span>
                              {batch.expiryDate && (
                                <span className="text-muted-foreground">
                                  {format(new Date(batch.expiryDate), 'dd MMM yyyy')}
                                </span>
                              )}
                            </div>
                          </div>
                          <div
                            className={`w-4 h-4 rounded-full border-2 shrink-0 ${
                              selectedBatchId === batch.id
                                ? 'border-primary bg-primary'
                                : 'border-muted-foreground/30'
                            }`}
                          >
                            {selectedBatchId === batch.id && (
                              <div className="w-full h-full flex items-center justify-center">
                                <div className="w-1.5 h-1.5 rounded-full bg-white" />
                              </div>
                            )}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Source quantity */}
            {sourceProduct && selectedBatch && (
              <div>
                <Label htmlFor="sourceQuantity">{t('fields.sourceQuantity')}</Label>
                <Input
                  id="sourceQuantity"
                  type="number"
                  step="0.01"
                  min="0"
                  max={selectedBatch?.quantityRemaining}
                  value={sourceQuantity}
                  onChange={(e) => setSourceQuantity(e.target.value)}
                  placeholder="0"
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t('fields.sourceQuantityHint')}
                  {selectedBatch && (
                    <>
                      {' '}
                      • {t('preview.available')}: {selectedBatch.quantityRemaining}{' '}
                      {sourceProduct.unit}
                    </>
                  )}
                </p>
              </div>
            )}
          </div>

          {/* Target Rows */}
          {sourceProduct && selectedBatch && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">{t('fields.targetProducts')}</h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addRow}
                  disabled={isLoading}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  {t('buttons.addTarget')}
                </Button>
              </div>

              {targetRows.map((row, idx) => {
                const rowOutput = parseFloat(row.outputQuantity) || 0;
                const rowExpiryDate = getRowExpiryDate(row);
                return (
                  <div
                    key={row.rowId}
                    className="border rounded-lg p-3 space-y-3 bg-muted/20"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        {t('fields.targetIndex', { index: idx + 1 })}
                      </span>
                      {targetRows.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeRow(row.rowId)}
                          disabled={isLoading}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>

                    {/* Target product picker */}
                    <div>
                      <Label>{t('fields.targetProduct')}</Label>
                      {row.product ? (
                        <div className="mt-1 p-2 border rounded-md bg-background flex items-start justify-between">
                          <div>
                            <p className="font-medium text-sm">{row.product.name}</p>
                            <p className="text-xs text-muted-foreground">{row.product.sku}</p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              updateRow(row.rowId, { product: null });
                              setSelectionMode({ kind: 'target', rowId: row.rowId });
                            }}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full mt-1"
                          onClick={() =>
                            setSelectionMode({ kind: 'target', rowId: row.rowId })
                          }
                          size="sm"
                        >
                          <Search className="h-4 w-4 mr-2" />
                          {t('dialog.selectTarget')}
                        </Button>
                      )}
                    </div>

                    {/* Output qty + cost */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor={`output-${row.rowId}`}>
                          {t('fields.targetOutputQuantity')}
                        </Label>
                        <Input
                          id={`output-${row.rowId}`}
                          type="number"
                          step="0.01"
                          min="0"
                          value={row.outputQuantity}
                          onChange={(e) =>
                            updateRow(row.rowId, { outputQuantity: e.target.value })
                          }
                          placeholder="0"
                          disabled={isLoading}
                        />
                      </div>
                      <div>
                        <Label htmlFor={`cost-${row.rowId}`}>
                          {t('fields.costPerUnit')}
                        </Label>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">$</span>
                          <Input
                            id={`cost-${row.rowId}`}
                            type="number"
                            step="0.01"
                            min="0"
                            value={row.costPerUnit}
                            onChange={(e) =>
                              updateRow(row.rowId, { costPerUnit: e.target.value })
                            }
                            placeholder="0.00"
                            disabled={isLoading}
                          />
                        </div>
                        {suggestedMaterialCostPerKgDollars > 0 && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {t('fields.suggestedMaterialCost', {
                              amount: suggestedMaterialCostPerKgDollars.toFixed(2),
                            })}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Expiry */}
                    <div>
                      <Label htmlFor={`expiry-${row.rowId}`}>
                        {t('fields.expiryDate')}
                      </Label>
                      <Select
                        value={row.expirySelection}
                        onValueChange={(v) =>
                          updateRow(row.rowId, { expirySelection: v })
                        }
                        disabled={isLoading}
                      >
                        <SelectTrigger className="mt-1">
                          <SelectValue placeholder={t('fields.expiryOptions.none')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">
                            {t('fields.expiryOptions.none')}
                          </SelectItem>
                          {selectedBatch && (
                            <SelectItem value="followParent">
                              {t('fields.expiryOptions.followParent')}
                            </SelectItem>
                          )}
                          <SelectItem value="3d">{t('fields.expiryOptions.3d')}</SelectItem>
                          <SelectItem value="5d">{t('fields.expiryOptions.5d')}</SelectItem>
                          <SelectItem value="10d">{t('fields.expiryOptions.10d')}</SelectItem>
                          <SelectItem value="1M">{t('fields.expiryOptions.1M')}</SelectItem>
                          <SelectItem value="custom">
                            {t('fields.expiryOptions.custom')}
                          </SelectItem>
                        </SelectContent>
                      </Select>

                      {row.expirySelection === 'followParent' && selectedBatch && (
                        <div className="flex items-start gap-2 mt-2 p-2 rounded-md bg-muted/50 text-sm">
                          <Info className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                          {selectedBatch.expiryDate ? (
                            <span>
                              {t('fields.expiryFollowParentDate', {
                                date: format(new Date(selectedBatch.expiryDate), 'dd MMM yyyy'),
                              })}
                            </span>
                          ) : (
                            <span className="text-orange-600 dark:text-orange-400">
                              {t('fields.expiryFollowParentNoExpiry')}
                            </span>
                          )}
                        </div>
                      )}
                      {row.expirySelection === 'custom' && (
                        <Input
                          type="date"
                          value={
                            row.customExpiryDate
                              ? format(row.customExpiryDate, 'yyyy-MM-dd')
                              : ''
                          }
                          min={format(new Date(), 'yyyy-MM-dd')}
                          onChange={(e) =>
                            updateRow(row.rowId, {
                              customExpiryDate: e.target.value
                                ? new Date(e.target.value)
                                : undefined,
                            })
                          }
                          className="mt-2"
                          disabled={isLoading}
                        />
                      )}
                    </div>

                    {/* Per-row preview footer */}
                    {row.product && rowOutput > 0 && (
                      <div className="text-xs text-muted-foreground flex items-center justify-between border-t pt-2">
                        <span>
                          {t('preview.output')}: {rowOutput.toFixed(2)} {row.product.unit}
                        </span>
                        {rowExpiryDate && (
                          <span>
                            {t('fields.expiryDate')}: {format(rowExpiryDate, 'dd MMM yyyy')}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Conversion Preview */}
          {sourceProduct && selectedBatch && sourceQty > 0 && totalOutputQty > 0 && (
            <div className="bg-primary/10 dark:bg-primary/20 border border-primary/30 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="text-center flex-1">
                  <div className="text-sm text-muted-foreground">{t('fields.willConsume')}</div>
                  <div className="text-2xl font-bold">
                    {sourceQty.toFixed(2)} {sourceProduct.unit}
                  </div>
                  <div className="text-sm">{sourceProduct.name}</div>
                </div>
                <div className="mx-4">
                  <ArrowRight className="h-8 w-8 text-primary" />
                </div>
                <div className="text-center flex-1">
                  <div className="text-sm text-muted-foreground">{t('preview.totalOutput')}</div>
                  <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                    {totalOutputQty.toFixed(2)}
                  </div>
                  <div className="text-sm">
                    {t('preview.acrossTargets', { count: targetRows.length })}
                  </div>
                </div>
              </div>
              {lossAmount > 0 && (
                <div className="mt-3 text-center text-sm text-muted-foreground">
                  <TrendingDown className="inline h-4 w-4 mr-1" />
                  {t('preview.loss')}: {lossPercentage.toFixed(1)}% = {lossAmount.toFixed(2)}{' '}
                  {sourceProduct.unit}
                </div>
              )}
              {totalMaterialCostCents > 0 && (
                <div className="mt-1 text-center text-xs text-muted-foreground">
                  {t('preview.totalMaterialCost')}: {formatAUD(totalMaterialCostCents)}
                </div>
              )}
            </div>
          )}

          {/* Notes */}
          {sourceProduct && selectedBatch && (
            <div>
              <Label htmlFor="notes">{t('fields.notes')}</Label>
              <textarea
                id="notes"
                value={notes}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  setNotes(e.target.value)
                }
                placeholder={t('fields.notesPlaceholder')}
                rows={3}
                className="mt-1 w-full px-3 py-2 border rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                disabled={isLoading}
              />
            </div>
          )}

          {/* Product search dropdown (overlay-style) */}
          {selectionMode.kind !== 'none' && (
            <div className="border rounded-md p-3 bg-muted/10">
              <div className="flex items-center gap-2 mb-2">
                <Search className="h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={
                    selectionMode.kind === 'source'
                      ? t('dialog.selectSource')
                      : t('dialog.selectTarget')
                  }
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectionMode({ kind: 'none' });
                    setProductSearch('');
                  }}
                >
                  {tCommon('cancel')}
                </Button>
              </div>
              <div className="max-h-[200px] overflow-y-auto space-y-1">
                {productsLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                ) : products.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    {t('dialog.noProductsFound')}
                  </p>
                ) : (
                  products.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      className="w-full text-left p-2 hover:bg-muted rounded-md transition-colors"
                      onClick={() => handleProductSelect(product as unknown as Product)}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">{product.name}</p>
                          <p className="text-xs text-muted-foreground">{product.sku}</p>
                        </div>
                        <Badge variant="secondary">
                          {'currentStock' in product ? product.currentStock : 0} {product.unit}
                        </Badge>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Validation errors */}
          {validationErrors.length > 0 && (
            <div className="bg-destructive/10 dark:bg-destructive/20 border border-destructive/30 rounded-md p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-destructive">
                    {t('validation.fixErrors')}
                  </p>
                  <ul className="text-sm text-destructive/90 list-disc list-inside mt-1">
                    {validationErrors.map((error, index) => (
                      <li key={index}>{error}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                handleReset();
                onOpenChange(false);
              }}
              disabled={isLoading}
            >
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={isLoading || validationErrors.length > 0}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('buttons.processing')}
                </>
              ) : (
                t('buttons.processStock')
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
