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
import {
  Loader2,
  Package,
  TrendingUp,
  TrendingDown,
  History,
  AlertTriangle,
  Search,
  Truck,
} from 'lucide-react';
import { api } from '@/trpc/client';
import { useToast } from '@joho-erp/ui';
import { useTranslations } from 'next-intl';
import { format, addDays, addMonths } from 'date-fns';
import { parseToCents } from '@joho-erp/shared';
// Status constants - using string literals to avoid importing Prisma on client
const ACTIVE_STATUS = 'active' as const;

type AdjustmentType =
  | 'stock_received'
  | 'stock_write_off';

interface Product {
  id: string;
  name: string;
  sku: string;
  currentStock: number;
  unit: string;
}

interface StockAdjustmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: Product | null;
  onSuccess: () => void;
}

export function StockAdjustmentDialog({
  open,
  onOpenChange,
  product,
  onSuccess,
}: StockAdjustmentDialogProps) {
  const { toast } = useToast();
  const t = useTranslations('stockAdjustment');
  const tErrors = useTranslations('errors');
  const tInventory = useTranslations('inventory');

  // Product selection state
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(product);
  const [productSearch, setProductSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Sync selectedProduct with prop changes
  useEffect(() => {
    setSelectedProduct(product);
  }, [product]);

  // Debounce product search (300ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(productSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [productSearch]);

  // Fetch products for selection (only when no product is selected)
  const { data: productsData, isLoading: productsLoading } = api.product.getAll.useQuery(
    {
      search: debouncedSearch,
      status: ACTIVE_STATUS,
      limit: 100,
    },
    { enabled: !selectedProduct && open }
  );
  const products = (productsData?.items || []) as unknown as Product[];

  // Form state
  const [adjustmentType, setAdjustmentType] = useState<AdjustmentType>('stock_received');
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');

  // NEW: Stock received specific fields
  const [costPerUnit, setCostPerUnit] = useState('');
  const [expirySelection, setExpirySelection] = useState<string>('');
  const [customExpiryDate, setCustomExpiryDate] = useState<Date | undefined>();
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState('');

  // Calculate actual expiry date from selection
  const getExpiryDate = (): Date | undefined => {
    if (!expirySelection || expirySelection === 'none') return undefined;
    if (expirySelection === 'custom') return customExpiryDate;

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
  const [stockInDate, setStockInDate] = useState<Date | undefined>(new Date());
  const [mtvNumber, setMtvNumber] = useState('');
  const [vehicleTemperature, setVehicleTemperature] = useState('');

  // Supplier selection state
  const [supplierId, setSupplierId] = useState<string>('');
  const [supplierSearch, setSupplierSearch] = useState('');

  // Fetch active suppliers (only when stock_received type)
  const { data: suppliersData, isLoading: suppliersLoading } = api.supplier.getAll.useQuery(
    {
      status: ACTIVE_STATUS,
      search: supplierSearch || undefined,
      limit: 100,
    },
    { enabled: adjustmentType === 'stock_received' && open }
  );

  // Fetch stock history
  const { data: historyData, isLoading: historyLoading } = api.product.getStockHistory.useQuery(
    { productId: selectedProduct?.id || '', limit: 10 },
    { enabled: !!selectedProduct?.id && open }
  );

  const adjustStockMutation = api.product.adjustStock.useMutation({
    onSuccess: (data) => {
      const batchNum = data?.batchNumber;
      toast({
        title: t('messages.success'),
        description: batchNum ? t('messages.batchNumberAssigned', { batchNumber: batchNum }) : undefined,
      });
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

  // Calculate new stock preview and effective quantity.
  // For stock_write_off, the user enters a positive amount in the input but the
  // adjustment is always a deduction — flip the sign here so preview and submit agree.
  const { newStock, effectiveQuantity } = useMemo(() => {
    if (!selectedProduct) return { newStock: 0, effectiveQuantity: 0 };

    const raw = parseFloat(quantity) || 0;
    const signed = adjustmentType === 'stock_write_off' ? -Math.abs(raw) : raw;
    return {
      newStock: selectedProduct.currentStock + signed,
      effectiveQuantity: signed,
    };
  }, [selectedProduct, quantity, adjustmentType]);

  const isNegativeResult = newStock < 0;
  const quantityNum = effectiveQuantity;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedProduct) return;

    // Validation - quantity is required
    if (!quantity || quantityNum === 0) {
      toast({
        title: t('validation.quantityRequired'),
        variant: 'destructive',
      });
      return;
    }

    // Write-off must be a positive amount (the dialog flips its sign on submit).
    if (adjustmentType === 'stock_write_off' && parseFloat(quantity) <= 0) {
      toast({
        title: t('validation.writeOffPositive'),
        variant: 'destructive',
      });
      return;
    }

    if (!notes.trim()) {
      toast({
        title: t('validation.notesRequired'),
        variant: 'destructive',
      });
      return;
    }

    if (isNegativeResult) {
      toast({
        title: t('validation.cannotGoNegative'),
        variant: 'destructive',
      });
      return;
    }

    // Validate stock_received specific fields
    if (adjustmentType === 'stock_received') {
      if (!supplierInvoiceNumber.trim()) {
        toast({
          title: t('validation.supplierInvoiceRequired'),
          variant: 'destructive',
        });
        return;
      }

      const costInCents = parseToCents(costPerUnit);

      if (!costInCents) {
        toast({
          title: t('validation.costRequired'),
          variant: 'destructive',
        });
        return;
      }

      if (!stockInDate) {
        toast({
          title: t('validation.stockInDateRequired'),
          variant: 'destructive',
        });
        return;
      }

      if (stockInDate > new Date()) {
        toast({
          title: t('validation.stockInDateFuture'),
          variant: 'destructive',
        });
        return;
      }

      const tempNum = parseFloat(vehicleTemperature);
      if (vehicleTemperature && (isNaN(tempNum) || tempNum < -30 || tempNum > 25)) {
        toast({
          title: t('validation.vehicleTemperatureRange'),
          variant: 'destructive',
        });
        return;
      }
    }

    // Build mutation input
    const baseInput = {
      productId: selectedProduct.id,
      adjustmentType,
      quantity: quantityNum,
      notes: notes.trim(),
    };

    // Add type-specific fields
    if (adjustmentType === 'stock_received') {
      await adjustStockMutation.mutateAsync({
        ...baseInput,
        costPerUnit: parseToCents(costPerUnit)!,
        stockInDate: stockInDate!,
        ...(supplierInvoiceNumber.trim() && { supplierInvoiceNumber: supplierInvoiceNumber.trim() }),
        ...(mtvNumber.trim() && { mtvNumber: mtvNumber.trim() }),
        ...(vehicleTemperature && { vehicleTemperature: parseFloat(vehicleTemperature) }),
        ...(expiryDate && { expiryDate }),
        ...(supplierId && { supplierId }),
      });
    } else {
      // stock_write_off uses quantity
      await adjustStockMutation.mutateAsync(baseInput);
    }
  };

  const handleReset = () => {
    setAdjustmentType('stock_received');
    setQuantity('');
    setNotes('');
    setProductSearch('');

    // NEW: Reset stock_received fields
    setCostPerUnit('');
    setExpirySelection('');
    setCustomExpiryDate(undefined);
    setSupplierInvoiceNumber('');
    setStockInDate(new Date());
    setMtvNumber('');
    setVehicleTemperature('');
    setSupplierId('');
    setSupplierSearch('');

    // Only reset selectedProduct if it wasn't provided as a prop
    if (!product) {
      setSelectedProduct(null);
    }
  };

  const getTransactionTypeLabel = (type: string, adjType?: string | null) => {
    if (type === 'sale') return 'Sale';
    if (type === 'return') return 'Return';
    if (type === 'adjustment' && adjType) {
      // TODO: Remove stock_count_correction after historical transaction data has been cleaned up
      const typeLabels: Record<string, string> = {
        stock_received: t('types.stock_received'),
        stock_count_correction: t('types.stock_count_correction'),
        stock_write_off: t('types.stock_write_off'),
        packing_adjustment: t('types.packing_adjustment'),
      };
      return typeLabels[adjType] || adjType;
    }
    return type;
  };

  const getTransactionTypeBadgeVariant = (
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            {t('dialog.title')}
          </DialogTitle>
          <DialogDescription>
            {selectedProduct ? t('dialog.description') : tInventory('productSelector.selectProduct')}
          </DialogDescription>
        </DialogHeader>

        {/* Product Selection Mode (when no product selected) */}
        {!selectedProduct && (
          <div className="space-y-4">
            {/* Search Input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={tInventory('productSelector.searchPlaceholder')}
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                className="pl-9"
                autoFocus
              />
            </div>

            {/* Products List */}
            <div className="max-h-[400px] overflow-y-auto space-y-2 border rounded-lg p-2">
              {productsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="ml-2 text-sm text-muted-foreground">
                    {tInventory('productSelector.loading')}
                  </span>
                </div>
              ) : products.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Package className="h-12 w-12 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">{tInventory('productSelector.noResults')}</p>
                </div>
              ) : (
                products.map((prod) => (
                    <button
                      key={prod.id}
                      type="button"
                      onClick={() => setSelectedProduct({
                        id: prod.id,
                        name: prod.name,
                        sku: prod.sku,
                        currentStock: prod.currentStock,
                        unit: prod.unit,
                      })}
                      className="w-full p-3 rounded-lg border hover:bg-accent transition-colors text-left flex items-center justify-between gap-4"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{prod.name}</div>
                        <div className="text-sm text-muted-foreground">SKU: {prod.sku}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm text-muted-foreground">Stock</div>
                        <div className="font-semibold">
                          {prod.currentStock} {prod.unit}
                        </div>
                      </div>
                    </button>
                  ))
              )}
            </div>
          </div>
        )}

        {/* Adjustment Form Mode (when product is selected) */}
        {selectedProduct && (
          <>
            {/* Product Info */}
            <div className="bg-muted p-4 rounded-lg space-y-2">
              <div className="flex justify-between items-start">
                <div>
                  <div className="font-semibold text-lg">{selectedProduct.name}</div>
                  <div className="text-sm text-muted-foreground">SKU: {selectedProduct.sku}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-muted-foreground">{t('fields.currentStock')}</div>
                  <div className="text-2xl font-bold">
                    {selectedProduct.currentStock}{' '}
                    <span className="text-sm font-normal">{selectedProduct.unit}</span>
                  </div>
                </div>
              </div>
              {/* Back button when product wasn't pre-selected */}
              {!product && (
                <button
                  type="button"
                  onClick={() => setSelectedProduct(null)}
                  className="text-sm text-primary hover:underline"
                >
                  {t('buttons.changeProduct')}
                </button>
              )}
            </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Adjustment Type */}
          <div>
            <Label htmlFor="adjustmentType">{t('fields.adjustmentType')}</Label>
            <select
              id="adjustmentType"
              value={adjustmentType}
              onChange={(e) => setAdjustmentType(e.target.value as AdjustmentType)}
              className="w-full px-3 py-2 border border-input bg-background text-foreground rounded-md mt-1 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="stock_received">{t('types.stock_received')}</option>
              <option value="stock_write_off">{t('types.stock_write_off')}</option>
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              {adjustmentType === 'stock_received' && t('typeDescriptions.stock_received')}
              {adjustmentType === 'stock_write_off' && t('typeDescriptions.stock_write_off')}
            </p>
          </div>

          {/* Stock Received Specific Fields - Only show for stock_received type */}
          {adjustmentType === 'stock_received' && (
            <div className="space-y-4 p-4 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <Package className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <span className="text-sm font-semibold text-blue-900 dark:text-blue-100">
                  {t('fields.stockReceivedDetails')}
                </span>
              </div>

              {/* Supplier - OPTIONAL */}
              <div>
                <Label htmlFor="supplier">
                  {t('fields.supplier')}
                </Label>
                <div className="relative mt-1">
                  <Truck className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t('fields.supplierSearchPlaceholder')}
                    value={supplierSearch}
                    onChange={(e) => setSupplierSearch(e.target.value)}
                    className="pl-10 mb-2"
                  />
                </div>
                <select
                  id="supplier"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                >
                  <option value="">{t('fields.supplierPlaceholder')}</option>
                  {suppliersLoading ? (
                    <option disabled>{tInventory('productSelector.loading')}</option>
                  ) : suppliersData?.suppliers.length === 0 ? (
                    <option disabled>{t('fields.noSuppliersFound')}</option>
                  ) : (
                    suppliersData?.suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.supplierCode} - {supplier.businessName}
                      </option>
                    ))
                  )}
                </select>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('fields.supplierHint')}
                </p>
              </div>

              {/* Cost Per Unit - REQUIRED */}
              <div>
                <Label htmlFor="costPerUnit">
                  {t('fields.costPerUnit')} <span className="text-red-500">*</span>
                </Label>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-muted-foreground">$</span>
                  <Input
                    id="costPerUnit"
                    type="number"
                    step="0.01"
                    min="0"
                    value={costPerUnit}
                    onChange={(e) => setCostPerUnit(e.target.value)}
                    placeholder="0.00"
                    className="flex-1"
                    required
                  />
                  <span className="text-muted-foreground text-sm">per {selectedProduct.unit}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('fields.costPerUnitHint')}
                </p>
              </div>

              {/* Stock In Date - REQUIRED */}
              <div>
                <Label htmlFor="stockInDate">
                  {t('fields.stockInDate')} <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="stockInDate"
                  type="date"
                  value={stockInDate ? format(stockInDate, 'yyyy-MM-dd') : ''}
                  max={format(new Date(), 'yyyy-MM-dd')}
                  onChange={(e) => setStockInDate(e.target.value ? new Date(e.target.value) : undefined)}
                  className="mt-1"
                  required
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t('fields.stockInDateHint')}
                </p>
              </div>

              {/* Supplier Invoice Number - REQUIRED */}
              <div>
                <Label htmlFor="supplierInvoiceNumber">
                  {t('fields.supplierInvoiceNumber')} <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="supplierInvoiceNumber"
                  type="text"
                  maxLength={100}
                  value={supplierInvoiceNumber}
                  onChange={(e) => setSupplierInvoiceNumber(e.target.value)}
                  placeholder={t('fields.supplierInvoiceNumberPlaceholder')}
                  className="mt-1"
                  required
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t('fields.supplierInvoiceNumberHint')}
                </p>
              </div>

              {/* MTV Number - OPTIONAL (PrimeSafe Meat Transfer Vehicle) */}
              <div>
                <Label htmlFor="mtvNumber">
                  {t('fields.mtvNumber')}
                </Label>
                <Input
                  id="mtvNumber"
                  type="text"
                  maxLength={50}
                  value={mtvNumber}
                  onChange={(e) => setMtvNumber(e.target.value)}
                  placeholder={t('fields.mtvNumberPlaceholder')}
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t('fields.mtvNumberHint')}
                </p>
              </div>

              {/* Vehicle Temperature - OPTIONAL */}
              <div>
                <Label htmlFor="vehicleTemperature">
                  {t('fields.vehicleTemperature')}
                </Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    id="vehicleTemperature"
                    type="number"
                    step="0.1"
                    min="-30"
                    max="25"
                    value={vehicleTemperature}
                    onChange={(e) => setVehicleTemperature(e.target.value)}
                    placeholder="0.0"
                    className="flex-1"
                  />
                  <span className="text-muted-foreground">°C</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('fields.vehicleTemperatureHint')}
                </p>
              </div>

              {/* Expiry Date Selection - OPTIONAL */}
              <div>
                <Label htmlFor="expirySelection">
                  {t('fields.expiryDate')}
                </Label>
                <Select value={expirySelection} onValueChange={setExpirySelection}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder={t('fields.expiryOptions.none')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('fields.expiryOptions.none')}</SelectItem>
                    <SelectItem value="3d">{t('fields.expiryOptions.3d')}</SelectItem>
                    <SelectItem value="5d">{t('fields.expiryOptions.5d')}</SelectItem>
                    <SelectItem value="10d">{t('fields.expiryOptions.10d')}</SelectItem>
                    <SelectItem value="1M">{t('fields.expiryOptions.1M')}</SelectItem>
                    <SelectItem value="custom">{t('fields.expiryOptions.custom')}</SelectItem>
                  </SelectContent>
                </Select>

                {/* Show date picker only for custom selection */}
                {expirySelection === 'custom' && (
                  <Input
                    id="customExpiryDate"
                    type="date"
                    value={customExpiryDate ? format(customExpiryDate, 'yyyy-MM-dd') : ''}
                    min={format(new Date(), 'yyyy-MM-dd')}
                    onChange={(e) => setCustomExpiryDate(e.target.value ? new Date(e.target.value) : undefined)}
                    className="mt-2"
                  />
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  {t('fields.expiryDateHint')}
                </p>
              </div>
            </div>
          )}

          {/* Quantity */}
          <div>
            <Label htmlFor="quantity">{t('fields.quantity')}</Label>
            <div className="flex items-center gap-2 mt-1">
              <Input
                id="quantity"
                type="number"
                step="1"
                min={adjustmentType === 'stock_write_off' ? '0' : undefined}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="0"
                className="flex-1"
              />
              <span className="text-muted-foreground">{selectedProduct.unit}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {adjustmentType === 'stock_write_off'
                ? t('fields.writeOffQuantityHint')
                : t('fields.quantityHint')}
            </p>
          </div>

          {/* New Stock Preview */}
          {quantity && (
            <div
              className={`p-3 rounded-lg border ${
                isNegativeResult
                  ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800'
                  : quantityNum > 0
                    ? 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800'
                    : 'bg-orange-50 dark:bg-orange-950/30 border-orange-200 dark:border-orange-800'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {quantityNum > 0 ? (
                    <TrendingUp className="h-5 w-5 text-green-600 dark:text-green-400" />
                  ) : (
                    <TrendingDown className="h-5 w-5 text-orange-600 dark:text-orange-400" />
                  )}
                  <span className="text-sm font-medium">{t('fields.newStock')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{selectedProduct.currentStock}</span>
                  <span>{quantityNum >= 0 ? '+' : ''}</span>
                  <span className={quantityNum >= 0 ? 'text-green-600 dark:text-green-400' : 'text-orange-600 dark:text-orange-400'}>
                    {quantityNum}
                  </span>
                  <span>=</span>
                  <span className={`font-bold ${isNegativeResult ? 'text-red-600 dark:text-red-400' : ''}`}>
                    {newStock} {selectedProduct.unit}
                  </span>
                </div>
              </div>
              {isNegativeResult && (
                <div className="flex items-center gap-2 mt-2 text-red-600 dark:text-red-400 text-sm">
                  <AlertTriangle className="h-4 w-4" />
                  <span>{t('validation.cannotGoNegative')}</span>
                </div>
              )}
            </div>
          )}

          {/* Notes */}
          <div>
            <Label htmlFor="notes">{t('fields.notes')} *</Label>
            <textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('fields.notesPlaceholder')}
              rows={3}
              className="mt-1 w-full px-3 py-2 border border-input bg-background text-foreground rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              required
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                handleReset();
                onOpenChange(false);
              }}
              disabled={adjustStockMutation.isPending}
            >
              {t('buttons.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={
                adjustStockMutation.isPending ||
                isNegativeResult ||
                !notes.trim() ||
                !quantity
              }
            >
              {adjustStockMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('buttons.save')}
            </Button>
          </div>
        </form>

        {/* Stock History */}
        <div className="border-t pt-4 mt-4">
          <div className="flex items-center gap-2 mb-3">
            <History className="h-4 w-4" />
            <h3 className="font-semibold">{t('history.title')}</h3>
          </div>

          {historyLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : historyData?.transactions.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              {t('history.noTransactions')}
            </p>
          ) : (
            <div className="max-h-[200px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted sticky top-0">
                  <tr>
                    <th className="text-left p-2">{t('history.date')}</th>
                    <th className="text-left p-2">{t('history.type')}</th>
                    <th className="text-right p-2">{t('history.quantity')}</th>
                    <th className="text-right p-2">{t('history.after')}</th>
                    <th className="text-left p-2">{t('history.notes')}</th>
                  </tr>
                </thead>
                <tbody>
                  {historyData?.transactions.map((tx) => (
                    <tr key={tx.id} className="border-t">
                      <td className="p-2 text-muted-foreground">
                        {format(new Date(tx.createdAt), 'MMM d, HH:mm')}
                      </td>
                      <td className="p-2">
                        <Badge variant={getTransactionTypeBadgeVariant(tx.type)}>
                          {getTransactionTypeLabel(tx.type, tx.adjustmentType)}
                        </Badge>
                      </td>
                      <td
                        className={`p-2 text-right font-medium ${
                          tx.quantity >= 0 ? 'text-green-600 dark:text-green-400' : 'text-orange-600 dark:text-orange-400'
                        }`}
                      >
                        {tx.quantity >= 0 ? '+' : ''}
                        {tx.quantity}
                      </td>
                      <td className="p-2 text-right">{tx.newStock}</td>
                      <td className="p-2 text-muted-foreground truncate max-w-[150px]" title={tx.notes || ''}>
                        {tx.notes || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
