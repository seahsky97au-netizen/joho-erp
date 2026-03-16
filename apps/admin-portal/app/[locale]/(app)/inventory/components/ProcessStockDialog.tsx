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
  targetProduct?: Product | null;
  onSuccess: () => void;
}

export function ProcessStockDialog({
  open,
  onOpenChange,
  sourceProduct: initialSource,
  targetProduct: initialTarget,
  onSuccess,
}: ProcessStockDialogProps) {
  const { toast } = useToast();
  const t = useTranslations('processStock');
  const tErrors = useTranslations('errors');
  const tCommon = useTranslations('common');

  // Product selection state
  const [sourceProduct, setSourceProduct] = useState<Product | null>(initialSource || null);
  const [targetProduct, setTargetProduct] = useState<Product | null>(initialTarget || null);
  const [productSearch, setProductSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectionMode, setSelectionMode] = useState<'source' | 'target' | 'none'>('none');

  // Sync with prop changes
  useEffect(() => {
    setSourceProduct(initialSource || null);
  }, [initialSource]);

  useEffect(() => {
    setTargetProduct(initialTarget || null);
  }, [initialTarget]);

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
    { enabled: selectionMode !== 'none' && open }
  );

  // Fetch source product batches for FIFO cost calculation
  const { data: sourceBatches } = api.inventory.getProductBatches.useQuery(
    { productId: sourceProduct?.id ?? '', includeConsumed: false, batchPrefix: 'SI-' },
    { enabled: !!sourceProduct && open }
  );

  // Batch selection state
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const selectedBatch = useMemo(
    () => (sourceBatches ?? []).find((b) => b.id === selectedBatchId) ?? null,
    [sourceBatches, selectedBatchId]
  );

  // Form state
  const [sourceQuantity, setSourceQuantity] = useState<string>('');
  const [targetOutputQuantity, setTargetOutputQuantity] = useState('');
  const [laborCost, setLaborCost] = useState('');
  const [laborCostType, setLaborCostType] = useState<'perKg' | 'total'>('perKg');
  const [expirySelection, setExpirySelection] = useState<string>('');
  const [customExpiryDate, setCustomExpiryDate] = useState<Date | undefined>();
  const [notes, setNotes] = useState('');

  // Calculate actual expiry date from selection
  const getExpiryDate = (): Date | undefined => {
    if (!expirySelection || expirySelection === 'none') return undefined;
    if (expirySelection === 'custom') return customExpiryDate;
    if (expirySelection === 'followParent') {
      return selectedBatch?.expiryDate ? new Date(selectedBatch.expiryDate) : undefined;
    }

    const today = new Date();
    switch (expirySelection) {
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

  const expiryDate = getExpiryDate();

  // Reset batch selection and quantities when source product changes
  useEffect(() => {
    setSelectedBatchId(null);
    setSourceQuantity('');
    setTargetOutputQuantity('');
    setExpirySelection('');
  }, [sourceProduct]);

  // Auto-calculated loss percentage (read-only)
  const lossPercentage = useMemo(() => {
    const input = parseFloat(sourceQuantity) || 0;
    const output = parseFloat(targetOutputQuantity) || 0;
    if (input > 0 && output >= 0 && output <= input) {
      return ((input - output) / input) * 100;
    }
    return 0;
  }, [sourceQuantity, targetOutputQuantity]);

  // Computed labor cost per kg
  const laborCostPerKg = useMemo(() => {
    const cost = parseFloat(laborCost) || 0;
    if (cost <= 0) return 0;
    if (laborCostType === 'perKg') return cost;
    const output = parseFloat(targetOutputQuantity) || 0;
    return output > 0 ? cost / output : 0;
  }, [laborCost, laborCostType, targetOutputQuantity]);

  // Auto-calculated material cost per kg from selected batch or FIFO fallback
  const materialCostPerKg = useMemo(() => {
    const inputQty = parseFloat(sourceQuantity) || 0;
    const outputQty = parseFloat(targetOutputQuantity) || 0;
    if (inputQty <= 0 || outputQty <= 0) return 0;

    // When a specific batch is selected, use its cost directly
    if (selectedBatch) {
      const totalCostCents = Math.round(inputQty * selectedBatch.costPerUnit);
      return totalCostCents / 100 / outputQty;
    }

    // FIFO fallback
    const batches = sourceBatches ?? [];
    if (batches.length === 0) return 0;

    let remaining = inputQty;
    let totalCostCents = 0;

    for (const batch of batches) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, batch.quantityRemaining);
      totalCostCents += Math.round(take * batch.costPerUnit);
      remaining -= take;
    }

    return totalCostCents / 100 / outputQty;
  }, [sourceBatches, selectedBatch, sourceQuantity, targetOutputQuantity]);

  // Computed total cost per kg (material + labor)
  const totalCostPerKg = materialCostPerKg + laborCostPerKg;

  // Computed loss amount for display
  const lossAmount = useMemo(() => {
    const input = parseFloat(sourceQuantity) || 0;
    const output = parseFloat(targetOutputQuantity) || 0;
    return Math.max(0, input - output);
  }, [sourceQuantity, targetOutputQuantity]);

  // Validation errors
  const validationErrors = useMemo(() => {
    const errors: string[] = [];

    if (!sourceProduct) errors.push(t('validation.sourceRequired'));
    if (!targetProduct) errors.push(t('validation.targetRequired'));
    if (sourceProduct && targetProduct && sourceProduct.id === targetProduct.id) {
      errors.push(t('validation.sameProduct'));
    }

    // Batch selection is required when source product is set
    if (sourceProduct && !selectedBatch) {
      errors.push(t('validation.batchRequired'));
    }

    const sourceQty = parseFloat(sourceQuantity) || 0;
    const targetQty = parseFloat(targetOutputQuantity) || 0;

    if (sourceQty <= 0) errors.push(t('validation.sourceQuantityRequired'));
    if (targetQty <= 0) errors.push(t('validation.quantityPositive'));

    // Check if source quantity exceeds selected batch stock
    if (selectedBatch && sourceQty > selectedBatch.quantityRemaining) {
      errors.push(t('validation.sourceQuantityExceedsBatch', { available: selectedBatch.quantityRemaining.toFixed(2) }));
    }

    // Check if output exceeds input (should not happen)
    if (targetQty > sourceQty && sourceQty > 0) {
      errors.push(t('validation.outputExceedsInput'));
    }

    if (materialCostPerKg <= 0 && sourceQty > 0 && targetQty > 0) {
      errors.push(t('validation.costRequired'));
    }

    return errors;
  }, [sourceProduct, targetProduct, selectedBatch, sourceQuantity, targetOutputQuantity, materialCostPerKg, t]);

  // Process stock mutation
  const processStockMutation = api.product.processStock.useMutation({
    onSuccess: (result) => {
      toast({
        title: t('messages.success'),
        description: t('messages.successDetails', {
          processed: result.quantityProcessed,
          produced: result.quantityProduced,
          sourceUnit: sourceProduct?.unit || '',
          targetUnit: targetProduct?.unit || '',
        }),
      });

      // Show expiry warnings if any
      if (result.expiryWarnings && result.expiryWarnings.length > 0) {
        toast({
          title: t('warnings.expiryTitle'),
          description: t('warnings.expiryMessage', {
            count: result.expiryWarnings.length,
          }),
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

    if (!sourceProduct || !targetProduct || validationErrors.length > 0) return;

    // Total cost per kg = material + labor, converted to cents
    const totalCostInCents = parseToCents(totalCostPerKg.toFixed(2));
    if (!totalCostInCents) return;

    // Include labor cost breakdown in notes for traceability
    const laborNote = laborCostPerKg > 0
      ? `[Labor: $${laborCostPerKg.toFixed(2)}/kg (${laborCostType === 'perKg' ? 'per kg' : `total $${laborCost}`}), Material: $${materialCostPerKg.toFixed(2)}/kg]`
      : '';
    const combinedNotes = [laborNote, notes.trim()].filter(Boolean).join(' ');

    await processStockMutation.mutateAsync({
      sourceProductId: sourceProduct.id,
      targetProductId: targetProduct.id,
      sourceBatchId: selectedBatch?.id,
      sourceQuantity: parseFloat(sourceQuantity),
      targetOutputQuantity: parseFloat(targetOutputQuantity),
      lossPercentage: lossPercentage,
      costPerUnit: totalCostInCents,
      expiryDate: expiryDate || undefined,
      notes: combinedNotes || undefined,
    });
  };

  const handleReset = () => {
    setSourceProduct(null);
    setTargetProduct(null);
    setSelectedBatchId(null);
    setSourceQuantity('');
    setTargetOutputQuantity('');
    setLaborCost('');
    setLaborCostType('perKg');
    setExpirySelection('');
    setCustomExpiryDate(undefined);
    setNotes('');
    setProductSearch('');
    setSelectionMode('none');
  };

  const handleProductSelect = (product: Product) => {
    if (selectionMode === 'source') {
      setSourceProduct(product);
    } else if (selectionMode === 'target') {
      setTargetProduct(product);
    }
    setSelectionMode('none');
    setProductSearch('');
  };

  const products = ((productsData?.items || []) as unknown as Product[]).filter(p => !p.parentProductId);
  const isLoading = processStockMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            {t('dialog.title')}
          </DialogTitle>
          <DialogDescription>
            {t('dialog.description')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Product Selection Section */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold">{t('fields.sourceProduct')}</h3>

            <div className="grid grid-cols-2 gap-4">
              {/* Source Product */}
              <div>
                <Label>{t('fields.sourceProduct')}</Label>
                {sourceProduct ? (
                  <div className="mt-2 p-3 border rounded-md bg-muted/30">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <p className="font-medium">{sourceProduct.name}</p>
                        <p className="text-sm text-muted-foreground">{sourceProduct.sku}</p>
                        <p className="text-sm mt-1">
                          {t('preview.source')}: <span className="font-medium">{sourceProduct.currentStock} {sourceProduct.unit}</span>
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSourceProduct(null);
                          setSelectionMode('source');
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
                    className="w-full mt-2"
                    onClick={() => setSelectionMode('source')}
                  >
                    <Search className="h-4 w-4 mr-2" />
                    {t('dialog.selectSource')}
                  </Button>
                )}
              </div>

              {/* Target Product */}
              <div>
                <Label>{t('fields.targetProduct')}</Label>
                {targetProduct ? (
                  <div className="mt-2 p-3 border rounded-md bg-muted/30">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <p className="font-medium">{targetProduct.name}</p>
                        <p className="text-sm text-muted-foreground">{targetProduct.sku}</p>
                        <p className="text-sm mt-1">
                          {t('preview.source')}: <span className="font-medium">{targetProduct.currentStock} {targetProduct.unit}</span>
                        </p>
                        {targetProduct.estimatedLossPercentage !== null && targetProduct.estimatedLossPercentage !== undefined && (
                          <p className="text-sm text-orange-600 dark:text-orange-400 mt-1">
                            {t('preview.loss')}: {targetProduct.estimatedLossPercentage}%
                          </p>
                        )}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setTargetProduct(null);
                          setSelectionMode('target');
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
                    className="w-full mt-2"
                    onClick={() => setSelectionMode('target')}
                  >
                    <Search className="h-4 w-4 mr-2" />
                    {t('dialog.selectTarget')}
                  </Button>
                )}
              </div>
            </div>

            {/* Product Search Dropdown */}
            {selectionMode !== 'none' && (
              <div className="border rounded-md p-3 bg-muted/10">
                <div className="flex items-center gap-2 mb-2">
                  <Search className="h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={selectionMode === 'source' ? t('dialog.selectSource') : t('dialog.selectTarget')}
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSelectionMode('none');
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
                            {('currentStock' in product) ? product.currentStock : 0} {product.unit}
                          </Badge>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Batch Selection */}
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
                              {t('fields.batchQtyRemaining')}: <span className="font-medium">{batch.quantityRemaining}</span>
                            </span>
                            <span>
                              {t('fields.batchCost')}: <span className="font-medium">{formatAUD(batch.costPerUnit)}/unit</span>
                            </span>
                            {batch.expiryDate && (
                              <span className="text-muted-foreground">
                                {format(new Date(batch.expiryDate), 'dd MMM yyyy')}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className={`w-4 h-4 rounded-full border-2 shrink-0 ${
                          selectedBatchId === batch.id
                            ? 'border-primary bg-primary'
                            : 'border-muted-foreground/30'
                        }`}>
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

          {/* Conversion Preview */}
          {sourceProduct && targetProduct && selectedBatch && sourceQuantity && targetOutputQuantity && (
            <div className="bg-primary/10 dark:bg-primary/20 border border-primary/30 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="text-center flex-1">
                  <div className="text-sm text-muted-foreground">{t('fields.willConsume')}</div>
                  <div className="text-2xl font-bold">{parseFloat(sourceQuantity).toFixed(2)} {sourceProduct.unit}</div>
                  <div className="text-sm">{sourceProduct.name}</div>
                </div>
                <div className="mx-4">
                  <ArrowRight className="h-8 w-8 text-primary" />
                </div>
                <div className="text-center flex-1">
                  <div className="text-sm text-muted-foreground">{t('preview.output')}</div>
                  <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                    {parseFloat(targetOutputQuantity).toFixed(2)} {targetProduct.unit}
                  </div>
                  <div className="text-sm">{targetProduct.name}</div>
                </div>
              </div>
              {lossAmount > 0 && (
                <div className="mt-3 text-center text-sm text-muted-foreground">
                  <TrendingDown className="inline h-4 w-4 mr-1" />
                  {t('preview.loss')}: {lossPercentage.toFixed(1)}% = {lossAmount.toFixed(2)} {sourceProduct.unit}
                </div>
              )}
            </div>
          )}

          {/* Form Fields */}
          {sourceProduct && targetProduct && selectedBatch && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">{t('dialog.processingDetails')}</h3>

              {/* Quantity Fields */}
              <div className="grid grid-cols-3 gap-4">
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
                      <> • {t('preview.available')}: {selectedBatch.quantityRemaining} {sourceProduct.unit}</>
                    )}
                  </p>
                </div>

                <div>
                  <Label htmlFor="targetOutputQuantity">{t('fields.targetOutputQuantity')}</Label>
                  <Input
                    id="targetOutputQuantity"
                    type="number"
                    step="0.01"
                    min="0"
                    value={targetOutputQuantity}
                    onChange={(e) => setTargetOutputQuantity(e.target.value)}
                    placeholder="0"
                    disabled={isLoading}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('fields.targetOutputHint')}
                  </p>
                </div>

                <div>
                  <Label htmlFor="lossPercentage">{t('fields.calculatedLoss')}</Label>
                  <Input
                    id="lossPercentage"
                    type="text"
                    value={lossPercentage.toFixed(1)}
                    readOnly
                    disabled
                    className="bg-muted"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('fields.calculatedLossHint')}
                  </p>
                </div>
              </div>

              {/* Cost Fields */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>{t('fields.materialCostPerUnit')}</Label>
                  <div className="mt-2 p-2 border rounded-md bg-muted/30 text-sm font-medium">
                    {materialCostPerKg > 0
                      ? `$${materialCostPerKg.toFixed(2)}`
                      : t('fields.materialCostPending')}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('fields.materialCostAutoHint')}
                  </p>
                </div>

                <div>
                  <Label htmlFor="laborCost">{t('fields.laborCost')}</Label>
                  <div className="flex gap-2">
                    <Select value={laborCostType} onValueChange={(v) => setLaborCostType(v as 'perKg' | 'total')} disabled={isLoading}>
                      <SelectTrigger className="w-[120px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="perKg">{t('fields.laborCostPerKg')}</SelectItem>
                        <SelectItem value="total">{t('fields.laborCostTotal')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      id="laborCost"
                      type="text"
                      value={laborCost}
                      onChange={(e) => setLaborCost(e.target.value)}
                      placeholder="0.00"
                      disabled={isLoading}
                      className="flex-1"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('fields.laborCostHint')}
                  </p>
                </div>
              </div>

              {/* Total Cost Breakdown */}
              {(materialCostPerKg > 0 || laborCostPerKg > 0) && (
                <div className="bg-muted/50 border rounded-md p-3">
                  <p className="text-sm font-medium mb-2">{t('fields.totalCostBreakdown')}</p>
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('fields.materialCostPerUnit')}</span>
                      <span>${materialCostPerKg.toFixed(2)}</span>
                    </div>
                    {laborCostPerKg > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('fields.laborCost')} ({t('fields.laborCostPerKg').toLowerCase()})</span>
                        <span>${laborCostPerKg.toFixed(2)}</span>
                      </div>
                    )}
                    <div className="flex justify-between font-medium border-t pt-1 mt-1">
                      <span>{t('fields.totalCostPerKg')}</span>
                      <span>${totalCostPerKg.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <Label htmlFor="expirySelection">{t('fields.expiryDate')}</Label>
                <Select value={expirySelection} onValueChange={setExpirySelection} disabled={isLoading}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder={t('fields.expiryOptions.none')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('fields.expiryOptions.none')}</SelectItem>
                    {selectedBatch && (
                      <SelectItem value="followParent">{t('fields.expiryOptions.followParent')}</SelectItem>
                    )}
                    <SelectItem value="3d">{t('fields.expiryOptions.3d')}</SelectItem>
                    <SelectItem value="5d">{t('fields.expiryOptions.5d')}</SelectItem>
                    <SelectItem value="10d">{t('fields.expiryOptions.10d')}</SelectItem>
                    <SelectItem value="1M">{t('fields.expiryOptions.1M')}</SelectItem>
                    <SelectItem value="custom">{t('fields.expiryOptions.custom')}</SelectItem>
                  </SelectContent>
                </Select>

                {/* Follow parent expiry info */}
                {expirySelection === 'followParent' && selectedBatch && (
                  <div className="flex items-start gap-2 mt-2 p-2 rounded-md bg-muted/50 text-sm">
                    <Info className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                    {selectedBatch.expiryDate ? (
                      <span>{t('fields.expiryFollowParentDate', { date: format(new Date(selectedBatch.expiryDate), 'dd MMM yyyy') })}</span>
                    ) : (
                      <span className="text-orange-600 dark:text-orange-400">{t('fields.expiryFollowParentNoExpiry')}</span>
                    )}
                  </div>
                )}

                {/* Show date picker only for custom selection */}
                {expirySelection === 'custom' && (
                  <Input
                    id="customExpiryDate"
                    type="date"
                    value={customExpiryDate ? format(customExpiryDate, 'yyyy-MM-dd') : ''}
                    min={format(new Date(), 'yyyy-MM-dd')}
                    onChange={(e) => setCustomExpiryDate(e.target.value ? new Date(e.target.value) : undefined)}
                    className="mt-2"
                    disabled={isLoading}
                  />
                )}
              </div>

              <div>
                <Label htmlFor="notes">{t('fields.notes')}</Label>
                <textarea
                  id="notes"
                  value={notes}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
                  placeholder={t('fields.notesPlaceholder')}
                  rows={3}
                  className="mt-1 w-full px-3 py-2 border rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  disabled={isLoading}
                />
              </div>
            </div>
          )}

          {/* Validation Errors */}
          {validationErrors.length > 0 && (
            <div className="bg-destructive/10 dark:bg-destructive/20 border border-destructive/30 rounded-md p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-destructive">{t('validation.fixErrors')}</p>
                  <ul className="text-sm text-destructive/90 list-disc list-inside mt-1">
                    {validationErrors.map((error, index) => (
                      <li key={index}>{error}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Action Buttons */}
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
            <Button
              type="submit"
              disabled={isLoading || validationErrors.length > 0}
            >
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
