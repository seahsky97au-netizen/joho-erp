'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Input,
  Label,
  AreaBadge,
} from '@joho-erp/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { api } from '@/trpc/client';
import { formatAUD, createMoney, multiplyMoney, toCents } from '@joho-erp/shared';
import {
  ShoppingCart,
  Plus,
  X,
  AlertCircle,
  Loader2,
  MapPin,
  FileText,
  Shield,
  CreditCard,
  ChevronDown,
  Check,
  Search,
} from 'lucide-react';
import { useToast } from '@joho-erp/ui';

type OrderItem = {
  productId: string;
  quantity: number;
  sku: string;
  name: string;
  unitPrice: number; // In cents
  subtotal: number; // In cents
  applyGst: boolean;
  gstRate: number | null;
};

type Product = {
  id: string;
  sku: string;
  name: string;
  basePrice: number;
  applyGst: boolean;
  gstRate: number | null;
  unit: string;
  currentStock: number;
  subProducts?: Product[];
};

export default function CreateOrderOnBehalfPage() {
  const t = useTranslations('orderOnBehalf');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const { toast } = useToast();

  // State
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [quantityInput, setQuantityInput] = useState('1');

  // Address
  const [useCustomAddress, setUseCustomAddress] = useState(false);
  const [customStreet, setCustomStreet] = useState('');
  const [customSuburb, setCustomSuburb] = useState('');
  const [customState, setCustomState] = useState('');
  const [customPostcode, setCustomPostcode] = useState('');
  const [customAreaId, setCustomAreaId] = useState<string>('');
  const [deliveryInstructions, setDeliveryInstructions] = useState('');

  // Fetch areas dynamically
  const { data: areas } = api.area.list.useQuery();

  // Bypass options
  const [bypassCreditLimit, setBypassCreditLimit] = useState(false);
  const [bypassCreditReason, setBypassCreditReason] = useState('');
  const [bypassCutoffTime, setBypassCutoffTime] = useState(false);

  // Notes
  const [adminNotes, setAdminNotes] = useState('');
  const [internalNotes, setInternalNotes] = useState('');

  // Delivery date
  const [requestedDeliveryDate, setRequestedDeliveryDate] = useState('');

  // Field error state
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Product search state
  const [productSearchTerm, setProductSearchTerm] = useState('');
  const [debouncedProductSearch, setDebouncedProductSearch] = useState('');
  const [productDropdownOpen, setProductDropdownOpen] = useState(false);
  const productDropdownRef = useRef<HTMLDivElement>(null);

  // Debounce product search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedProductSearch(productSearchTerm);
    }, 300);
    return () => clearTimeout(timer);
  }, [productSearchTerm]);

  // Close product dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (productDropdownRef.current && !productDropdownRef.current.contains(event.target as Node)) {
        setProductDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Fetch data
  const { data: customersData } = api.customer.getAll.useQuery({ limit: 1000 });
  const { data: productsData, isLoading: isLoadingProducts } = api.product.getAll.useQuery({
    search: debouncedProductSearch || undefined,
    limit: 50,
    showAll: true,
  });
  const { data: selectedCustomer } = api.customer.getById.useQuery(
    { customerId: selectedCustomerId },
    { enabled: !!selectedCustomerId }
  );
  const { data: creditInfo } = api.order.getCustomerCreditInfoForAdmin.useQuery(
    { customerId: selectedCustomerId },
    { enabled: !!selectedCustomerId }
  );

  // Fetch customer-specific pricing
  const { data: customerPricesData } = api.pricing.getCustomerPrices.useQuery(
    { customerId: selectedCustomerId },
    { enabled: !!selectedCustomerId }
  );

  const customers = customersData?.customers || [];
  const products = (productsData?.items || []) as unknown as Product[];

  // Build pricing map: productId -> effective price in cents
  const pricingMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!customerPricesData) return map;
    for (const pricing of customerPricesData) {
      if (pricing.isValid && pricing.effectivePriceInfo) {
        map.set(pricing.productId, pricing.effectivePriceInfo.effectivePrice);
      }
    }
    return map;
  }, [customerPricesData]);

  // Helper to get effective price for a product
  const getEffectiveProductPrice = (productId: string, basePrice: number): number => {
    return pricingMap.get(productId) ?? basePrice;
  };

  // Flatten products: parents without subs stay as-is, parents with subs become groups
  const { groupedProducts, allProducts } = useMemo(() => {
    const grouped: { parent: Product; children: Product[] }[] = [];
    const all: Product[] = [];

    for (const product of products) {
      if (product.subProducts && product.subProducts.length > 0) {
        // Parent with subproducts: group header + children
        grouped.push({ parent: product, children: product.subProducts });
        all.push(product);
        for (const sub of product.subProducts) {
          all.push(sub);
        }
      } else {
        // Standalone product (no subproducts)
        grouped.push({ parent: product, children: [] });
        all.push(product);
      }
    }

    return { groupedProducts: grouped, allProducts: all };
  }, [products]);

  // Create order mutation
  const createOrderMutation = api.order.createOnBehalf.useMutation({
    onSuccess: (data) => {
      toast({
        title: t('messages.orderCreated'),
        description: t('messages.orderCreatedSuccess', { orderNumber: data.orderNumber }),
        variant: 'default',
      });
      router.push(`/orders`);
    },
    onError: (error) => {
      toast({
        title: t('messages.orderFailed'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  // Calculate totals using per-product GST settings
  const { subtotal, gst, total } = useMemo(() => {
    const DEFAULT_GST_RATE = 10; // Default GST rate if product has GST enabled but no rate set
    const subtotalCents = orderItems.reduce((sum, item) => sum + item.subtotal, 0);
    const gstCents = orderItems.reduce((sum, item) => {
      if (!item.applyGst) return sum;
      const rate = item.gstRate ?? DEFAULT_GST_RATE;
      const itemMoney = createMoney(item.subtotal);
      const itemGst = multiplyMoney(itemMoney, { amount: rate, scale: 2 });
      return sum + toCents(itemGst);
    }, 0);
    const totalCents = subtotalCents + gstCents;
    return {
      subtotal: subtotalCents,
      gst: gstCents,
      total: totalCents,
    };
  }, [orderItems]);

  // Credit limit check - compares against available credit, not total credit limit
  const exceedsAvailableCredit = useMemo(() => {
    if (!creditInfo || bypassCreditLimit) return false;
    return total > creditInfo.availableCredit;
  }, [total, creditInfo, bypassCreditLimit]);

  // Calculate projected credit after this order
  const projectedRemainingCredit = useMemo(() => {
    if (!creditInfo) return 0;
    return creditInfo.availableCredit - total;
  }, [creditInfo, total]);

  // Calculate credit utilization percentage (including this order)
  const creditUtilizationPercent = useMemo(() => {
    if (!creditInfo || creditInfo.creditLimit === 0) return 0;
    const projectedUsed = creditInfo.outstandingBalance + total;
    return Math.min(100, (projectedUsed / creditInfo.creditLimit) * 100);
  }, [creditInfo, total]);

  const clearFieldError = (field: string) => {
    if (fieldErrors[field]) {
      const newErrors = { ...fieldErrors };
      delete newErrors[field];
      setFieldErrors(newErrors);
    }
  };

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};
    let isValid = true;

    // Customer validation
    if (!selectedCustomerId) {
      errors.selectedCustomerId = t('validation.customerRequired');
      isValid = false;
    }

    // Order items validation
    if (orderItems.length === 0) {
      errors.orderItems = t('validation.itemsRequired');
      isValid = false;
    }

    // Custom address validation (if enabled)
    if (useCustomAddress) {
      if (!customStreet?.trim()) {
        errors.customStreet = t('validation.streetRequired');
        isValid = false;
      }

      if (!customSuburb?.trim()) {
        errors.customSuburb = t('validation.suburbRequired');
        isValid = false;
      }

      if (!customState?.trim()) {
        errors.customState = t('validation.stateRequired');
        isValid = false;
      }

      if (!customPostcode?.trim()) {
        errors.customPostcode = t('validation.postcodeRequired');
        isValid = false;
      } else if (!/^\d{4}$/.test(customPostcode)) {
        errors.customPostcode = t('validation.postcodeInvalid');
        isValid = false;
      }
    }

    // Bypass credit reason validation (if bypass is enabled)
    if (bypassCreditLimit && !bypassCreditReason?.trim()) {
      errors.bypassCreditReason = t('validation.bypassReasonRequired');
      isValid = false;
    }

    // Delivery date validation (if provided, must be future date)
    if (requestedDeliveryDate) {
      const selectedDate = new Date(requestedDeliveryDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Reset time to compare dates only

      if (selectedDate < today) {
        errors.requestedDeliveryDate = t('validation.deliveryDateInvalid');
        isValid = false;
      }
    }

    setFieldErrors(errors);
    return isValid;
  };

  // Add item to order
  const handleAddItem = () => {
    const qty = parseInt(quantityInput) || 0;
    if (!selectedProductId || qty <= 0) {
      toast({
        title: t('validation.invalidItem'),
        description: t('validation.selectProductAndQuantity'),
        variant: 'destructive',
      });
      return;
    }

    // Search all selectable products (flattened list)
    const product = allProducts.find((p) => p.id === selectedProductId);
    if (!product) return;

    const effectivePrice = getEffectiveProductPrice(product.id, product.basePrice);

    // Check if product already in order
    const existingIndex = orderItems.findIndex((item) => item.productId === selectedProductId);

    if (existingIndex >= 0) {
      // Update quantity
      const updatedItems = [...orderItems];
      const newQuantity = updatedItems[existingIndex].quantity + qty;
      updatedItems[existingIndex] = {
        ...updatedItems[existingIndex],
        quantity: newQuantity,
        unitPrice: effectivePrice,
        subtotal: toCents(multiplyMoney(createMoney(effectivePrice), newQuantity)),
      };
      setOrderItems(updatedItems);
    } else {
      // Add new item
      const newItem: OrderItem = {
        productId: product.id,
        quantity: qty,
        sku: product.sku,
        name: product.name,
        unitPrice: effectivePrice, // In cents
        subtotal: toCents(multiplyMoney(createMoney(effectivePrice), qty)),
        applyGst: product.applyGst,
        gstRate: product.gstRate,
      };
      setOrderItems([...orderItems, newItem]);
    }

    // Reset
    setSelectedProductId('');
    setQuantityInput('1');
  };

  // Remove item
  const handleRemoveItem = (productId: string) => {
    setOrderItems(orderItems.filter((item) => item.productId !== productId));
  };

  // Submit order
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Validation
    if (!validateForm()) {
      toast({
        title: t('validation.invalidInput'),
        description: t('validation.fixErrors'),
        variant: 'destructive',
      });
      return;
    }

    // Prepare payload
    const payload = {
      customerId: selectedCustomerId,
      items: orderItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
      useCustomAddress,
      customDeliveryAddress: useCustomAddress
        ? {
            street: customStreet,
            suburb: customSuburb,
            state: customState,
            postcode: customPostcode,
            areaId: customAreaId || undefined,
            deliveryInstructions: deliveryInstructions || undefined,
          }
        : undefined,
      bypassCreditLimit,
      bypassCreditReason: bypassCreditReason || undefined,
      bypassCutoffTime,
      adminNotes: adminNotes || undefined,
      internalNotes: internalNotes || undefined,
      requestedDeliveryDate: requestedDeliveryDate ? new Date(requestedDeliveryDate) : undefined,
    };

    createOrderMutation.mutate(payload);
  };

  return (
    <div className="container mx-auto px-4 py-6 md:py-10 max-w-6xl">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl md:text-4xl font-bold">{t('title')}</h1>
        <p className="text-sm md:text-base text-muted-foreground mt-1">{t('subtitle')}</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Customer Selection */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShoppingCart className="h-5 w-5" />
              {t('sections.customerSelection')}
            </CardTitle>
            <CardDescription>{t('sections.customerDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="customer">{t('fields.customer')}</Label>
              <select
                id="customer"
                className="w-full px-3 py-2 border rounded-md"
                value={selectedCustomerId}
                onChange={(e) => {
                  setSelectedCustomerId(e.target.value);
                  clearFieldError('selectedCustomerId');
                }}
                required
              >
                <option value="">{t('placeholders.selectCustomer')}</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.businessName} ({customer.contactPerson.email})
                  </option>
                ))}
              </select>
              {fieldErrors.selectedCustomerId && (
                <p className="text-sm text-destructive">{fieldErrors.selectedCustomerId}</p>
              )}
            </div>

            {selectedCustomer && creditInfo && (
              <div className="mt-4 p-4 bg-muted rounded-md space-y-4">
                {/* Credit Usage Header */}
                <div className="flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium">{t('info.creditUsage')}</p>
                </div>

                {/* Credit Stats Grid */}
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <p className="text-xs text-muted-foreground">{t('info.creditLimit')}</p>
                    <p className="text-lg font-bold">{formatAUD(creditInfo.creditLimit)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t('info.outstandingBalance')}</p>
                    <p className="text-lg font-bold">{formatAUD(creditInfo.outstandingBalance)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t('info.availableCredit')}</p>
                    <p className="text-lg font-bold text-green-600">
                      {formatAUD(creditInfo.availableCredit)}
                    </p>
                  </div>
                </div>

                {/* Credit Usage Progress Bar */}
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground">{t('info.used')}</span>
                    <span className="font-medium">
                      {formatAUD(creditInfo.outstandingBalance)} / {formatAUD(creditInfo.creditLimit)}
                    </span>
                  </div>
                  <div className="h-2 bg-secondary rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all ${
                        creditUtilizationPercent > 100
                          ? 'bg-destructive'
                          : creditUtilizationPercent > 80
                          ? 'bg-amber-500'
                          : 'bg-primary'
                      }`}
                      style={{
                        width: `${Math.min(100, (creditInfo.outstandingBalance / creditInfo.creditLimit) * 100)}%`,
                      }}
                    />
                  </div>
                </div>

                {/* Order Impact Preview - Only show when items exist */}
                {total > 0 && (
                  <div className="pt-3 border-t border-border">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-xs text-muted-foreground">{t('info.thisOrder')}</p>
                        <p className="text-lg font-bold">{formatAUD(total)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t('info.afterOrder')}</p>
                        <p
                          className={`text-lg font-bold ${
                            projectedRemainingCredit < 0 ? 'text-destructive' : 'text-green-600'
                          }`}
                        >
                          {formatAUD(Math.max(0, projectedRemainingCredit))} {t('info.remaining')}
                        </p>
                      </div>
                    </div>

                    {/* Projected Usage Bar */}
                    <div className="mt-2">
                      <div className="h-2 bg-secondary rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all ${
                            creditUtilizationPercent > 100
                              ? 'bg-destructive'
                              : creditUtilizationPercent > 80
                              ? 'bg-amber-500'
                              : 'bg-primary'
                          }`}
                          style={{ width: `${Math.min(100, creditUtilizationPercent)}%` }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 text-right">
                        {Math.round(creditUtilizationPercent)}% {t('info.afterOrder').toLowerCase()}
                      </p>
                    </div>
                  </div>
                )}

                {/* Delivery Area */}
                {selectedCustomer.deliveryAddress.areaName && (
                  <p className="text-sm text-muted-foreground pt-2 border-t border-border">
                    {t('info.deliveryArea')}: {selectedCustomer.deliveryAddress.areaName.toUpperCase()}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Product Selection */}
        {selectedCustomerId && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plus className="h-5 w-5" />
                {t('sections.addProducts')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2">
                  <Label htmlFor="product">{t('fields.product')}</Label>
                  <div ref={productDropdownRef} className="relative mt-1">
                    <button
                      type="button"
                      onClick={() => setProductDropdownOpen(!productDropdownOpen)}
                      className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    >
                      <span className={selectedProductId ? '' : 'text-muted-foreground'}>
                        {selectedProductId
                          ? (() => {
                              const p = allProducts.find((p) => p.id === selectedProductId);
                              return p ? `${p.sku} - ${p.name}` : t('placeholders.selectProduct');
                            })()
                          : t('placeholders.selectProduct')}
                      </span>
                      <ChevronDown className="h-4 w-4 opacity-50" />
                    </button>

                    {productDropdownOpen && (
                      <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
                        {/* Search input */}
                        <div className="p-2 border-b">
                          <div className="relative">
                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                              placeholder={t('placeholders.searchProducts')}
                              value={productSearchTerm}
                              onChange={(e) => setProductSearchTerm(e.target.value)}
                              className="h-8 pl-8"
                              autoFocus
                            />
                          </div>
                        </div>

                        {/* Product list */}
                        <div className="max-h-64 overflow-y-auto">
                          {isLoadingProducts ? (
                            <div className="flex items-center justify-center p-4">
                              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                            </div>
                          ) : groupedProducts.length === 0 ? (
                            <div className="p-3 text-center text-sm text-muted-foreground">
                              {t('placeholders.noProductsFound')}
                            </div>
                          ) : (
                            groupedProducts.map((group, index) => {
                              if (group.children.length > 0) {
                                const parentPrice = getEffectiveProductPrice(group.parent.id, group.parent.basePrice);
                                const isParentCustom = pricingMap.has(group.parent.id);
                                return (
                                  <div key={group.parent.id}>
                                    {index > 0 && <div className="border-t" />}
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSelectedProductId(group.parent.id);
                                        setProductDropdownOpen(false);
                                        setProductSearchTerm('');
                                      }}
                                      className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
                                    >
                                      <span>
                                        {group.parent.sku} - {group.parent.name} ({formatAUD(parentPrice)}{isParentCustom ? ` - ${t('labels.customPrice')}` : ''})
                                      </span>
                                      {group.parent.id === selectedProductId && <Check className="h-4 w-4 flex-shrink-0" />}
                                    </button>
                                    {group.children.map((sub) => {
                                      const price = getEffectiveProductPrice(sub.id, sub.basePrice);
                                      const isCustom = pricingMap.has(sub.id);
                                      return (
                                        <button
                                          key={sub.id}
                                          type="button"
                                          onClick={() => {
                                            setSelectedProductId(sub.id);
                                            setProductDropdownOpen(false);
                                            setProductSearchTerm('');
                                          }}
                                          className="flex w-full items-center justify-between pl-8 pr-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
                                        >
                                          <span>
                                            {sub.sku} - {sub.name} ({formatAUD(price)}{isCustom ? ` - ${t('labels.customPrice')}` : ''})
                                          </span>
                                          {sub.id === selectedProductId && <Check className="h-4 w-4 flex-shrink-0" />}
                                        </button>
                                      );
                                    })}
                                  </div>
                                );
                              }
                              const price = getEffectiveProductPrice(group.parent.id, group.parent.basePrice);
                              const isCustom = pricingMap.has(group.parent.id);
                              return (
                                <button
                                  key={group.parent.id}
                                  type="button"
                                  onClick={() => {
                                    setSelectedProductId(group.parent.id);
                                    setProductDropdownOpen(false);
                                    setProductSearchTerm('');
                                  }}
                                  className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
                                >
                                  <span>
                                    {group.parent.sku} - {group.parent.name} ({formatAUD(price)}{isCustom ? ` - ${t('labels.customPrice')}` : ''})
                                  </span>
                                  {group.parent.id === selectedProductId && <Check className="h-4 w-4 flex-shrink-0" />}
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <Label htmlFor="quantity">{t('fields.quantity')}</Label>
                  <Input
                    id="quantity"
                    type="number"
                    min="0"
                    value={quantityInput}
                    onChange={(e) => setQuantityInput(e.target.value)}
                    className="mt-1"
                  />
                </div>
              </div>
              <Button type="button" onClick={handleAddItem} variant="outline" className="w-full">
                <Plus className="h-4 w-4 mr-2" />
                {t('buttons.addItem')}
              </Button>

              {/* Order Items Error */}
              {fieldErrors.orderItems && (
                <p className="text-sm text-destructive mt-2">{fieldErrors.orderItems}</p>
              )}

              {/* Order Items Table */}
              {orderItems.length > 0 && (
                <div className="mt-6">
                  <h3 className="font-semibold mb-3">{t('sections.orderItems')}</h3>
                  <div className="space-y-2">
                    {orderItems.map((item) => (
                      <div
                        key={item.productId}
                        className="flex items-center justify-between p-3 bg-muted rounded-md"
                      >
                        <div className="flex-1">
                          <p className="font-medium">{item.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {item.quantity} × {formatAUD(item.unitPrice)}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <p className="font-semibold">{formatAUD(item.subtotal)}</p>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveItem(item.productId)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Totals */}
                  <div className="mt-4 p-4 bg-muted rounded-md space-y-2">
                    <div className="flex justify-between">
                      <span>{tCommon('subtotal')}</span>
                      <span className="font-medium">{formatAUD(subtotal)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>{tCommon('tax')}</span>
                      <span className="font-medium">{formatAUD(gst)}</span>
                    </div>
                    <div className="flex justify-between border-t pt-2">
                      <span className="font-bold">{tCommon('total')}</span>
                      <span className="font-bold text-lg">{formatAUD(total)}</span>
                    </div>

                    {exceedsAvailableCredit && !bypassCreditLimit && (
                      <div className="flex items-center gap-2 text-destructive mt-2">
                        <AlertCircle className="h-4 w-4" />
                        <span className="text-sm">{t('warnings.willExceedCredit')}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Delivery Options */}
        {orderItems.length > 0 && (
          <>
            {/* Custom Address */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-5 w-5" />
                  {t('sections.deliveryAddress')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="useCustomAddress"
                    checked={useCustomAddress}
                    onChange={(e) => setUseCustomAddress(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  />
                  <Label htmlFor="useCustomAddress" className="cursor-pointer">
                    {t('fields.useCustomAddress')}
                  </Label>
                </div>

                {useCustomAddress && (
                  <div className="space-y-4 pl-6 border-l-2">
                    <div className="space-y-2">
                      <Label>{t('fields.street')}</Label>
                      <Input
                        value={customStreet}
                        onChange={(e) => {
                          setCustomStreet(e.target.value);
                          clearFieldError('customStreet');
                        }}
                        placeholder={t('placeholders.street')}
                      />
                      {fieldErrors.customStreet && (
                        <p className="text-sm text-destructive">{fieldErrors.customStreet}</p>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>{t('fields.suburb')}</Label>
                        <Input
                          value={customSuburb}
                          onChange={(e) => {
                            setCustomSuburb(e.target.value);
                            clearFieldError('customSuburb');
                          }}
                          placeholder={t('placeholders.suburb')}
                        />
                        {fieldErrors.customSuburb && (
                          <p className="text-sm text-destructive">{fieldErrors.customSuburb}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label>{t('fields.state')}</Label>
                        <Input
                          value={customState}
                          onChange={(e) => {
                            setCustomState(e.target.value);
                            clearFieldError('customState');
                          }}
                          placeholder="NSW"
                        />
                        {fieldErrors.customState && (
                          <p className="text-sm text-destructive">{fieldErrors.customState}</p>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>{t('fields.postcode')}</Label>
                        <Input
                          value={customPostcode}
                          onChange={(e) => {
                            setCustomPostcode(e.target.value);
                            clearFieldError('customPostcode');
                          }}
                          placeholder="2000"
                          maxLength={4}
                        />
                        {fieldErrors.customPostcode && (
                          <p className="text-sm text-destructive">{fieldErrors.customPostcode}</p>
                        )}
                      </div>
                      <div>
                        <Label>{t('fields.area')}</Label>
                        <select
                          className="w-full px-3 py-2 border rounded-md"
                          value={customAreaId}
                          onChange={(e) => setCustomAreaId(e.target.value)}
                        >
                          <option value="">{t('fields.selectArea')}</option>
                          {areas?.map((area) => (
                            <option key={area.id} value={area.id}>
                              {area.displayName}
                            </option>
                          ))}
                        </select>
                        {customAreaId && areas && (
                          <div className="mt-1">
                            <AreaBadge
                              area={
                                areas.find((a) => a.id === customAreaId) ?? {
                                  name: 'unknown',
                                  displayName: 'Unknown',
                                  colorVariant: 'default',
                                }
                              }
                              className="text-xs"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                    <div>
                      <Label>{t('fields.deliveryInstructions')}</Label>
                      <textarea
                        value={deliveryInstructions}
                        onChange={(e) => setDeliveryInstructions(e.target.value)}
                        placeholder={t('placeholders.deliveryInstructions')}
                        rows={2}
                        className="w-full px-3 py-2 border rounded-md"
                      />
                    </div>
                  </div>
                )}

                {!useCustomAddress && selectedCustomer && (
                  <div className="p-3 bg-muted rounded-md">
                    <p className="text-sm font-medium">{t('info.usingDefaultAddress')}</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {selectedCustomer.deliveryAddress.street},{' '}
                      {selectedCustomer.deliveryAddress.suburb}
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="deliveryDate">{t('fields.deliveryDate')}</Label>
                  <Input
                    id="deliveryDate"
                    type="date"
                    value={requestedDeliveryDate}
                    onChange={(e) => {
                      setRequestedDeliveryDate(e.target.value);
                      clearFieldError('requestedDeliveryDate');
                    }}
                  />
                  {fieldErrors.requestedDeliveryDate && (
                    <p className="text-sm text-destructive">{fieldErrors.requestedDeliveryDate}</p>
                  )}
                  {!fieldErrors.requestedDeliveryDate && (
                    <p className="text-sm text-muted-foreground">
                      {t('info.deliveryDateOptional')}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Bypass Options */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="h-5 w-5" />
                  {t('sections.adminOptions')}
                </CardTitle>
                <CardDescription>{t('sections.adminOptionsDescription')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Bypass Credit Limit */}
                <div className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      id="bypassCredit"
                      checked={bypassCreditLimit}
                      onChange={(e) => setBypassCreditLimit(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                    />
                    <Label htmlFor="bypassCredit" className="cursor-pointer">
                      {t('fields.bypassCreditLimit')}
                    </Label>
                  </div>
                  {bypassCreditLimit && (
                    <div className="pl-6 space-y-2">
                      <Label>{t('fields.bypassReason')}</Label>
                      <textarea
                        value={bypassCreditReason}
                        onChange={(e) => {
                          setBypassCreditReason(e.target.value);
                          clearFieldError('bypassCreditReason');
                        }}
                        placeholder={t('placeholders.bypassReason')}
                        rows={2}
                        required
                        className="w-full px-3 py-2 border rounded-md"
                      />
                      {fieldErrors.bypassCreditReason && (
                        <p className="text-sm text-destructive">{fieldErrors.bypassCreditReason}</p>
                      )}
                    </div>
                  )}
                </div>

                {/* Bypass Cutoff Time */}
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="bypassCutoff"
                    checked={bypassCutoffTime}
                    onChange={(e) => setBypassCutoffTime(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  />
                  <Label htmlFor="bypassCutoff" className="cursor-pointer">
                    {t('fields.bypassCutoffTime')}
                  </Label>
                </div>
              </CardContent>
            </Card>

            {/* Notes */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  {t('sections.notes')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>{t('fields.adminNotes')}</Label>
                  <textarea
                    value={adminNotes}
                    onChange={(e) => setAdminNotes(e.target.value)}
                    placeholder={t('placeholders.adminNotes')}
                    rows={3}
                    className="w-full px-3 py-2 border rounded-md"
                  />
                  <p className="text-sm text-muted-foreground mt-1">
                    {t('info.adminNotesPrivate')}
                  </p>
                </div>
                <div>
                  <Label>{t('fields.internalNotes')}</Label>
                  <textarea
                    value={internalNotes}
                    onChange={(e) => setInternalNotes(e.target.value)}
                    placeholder={t('placeholders.internalNotes')}
                    rows={2}
                    className="w-full px-3 py-2 border rounded-md"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Submit */}
            <div className="flex justify-end gap-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push('/orders')}
                disabled={createOrderMutation.isPending}
              >
                {tCommon('cancel')}
              </Button>
              <Button
                type="submit"
                disabled={createOrderMutation.isPending || orderItems.length === 0}
              >
                {createOrderMutation.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                {t('buttons.createOrder')}
              </Button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
