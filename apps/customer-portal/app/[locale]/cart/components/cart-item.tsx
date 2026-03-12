'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card, CardContent, H4, Muted, useToast, Input } from '@joho-erp/ui';
import { Check, Loader2, Minus, Plus, Trash2, X } from 'lucide-react';
import { formatAUD } from '@joho-erp/shared';
import { api } from '@/trpc/client';

interface CartItemProps {
  item: {
    productId: string;
    sku: string;
    productName: string;
    unit: string;
    quantity: number;
    unitPrice: number; // in cents
    basePrice: number; // in cents
    subtotal: number; // in cents
    hasCustomPricing: boolean;
  };
}

export function CartItem({ item }: CartItemProps) {
  const t = useTranslations('cart');
  const tProducts = useTranslations('products');
  const { toast } = useToast();
  const utils = api.useUtils();
  const [isEditingQuantity, setIsEditingQuantity] = React.useState(false);
  const [editQuantity, setEditQuantity] = React.useState(item.quantity.toString());
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Sync editQuantity when item.quantity changes from external updates
  React.useEffect(() => {
    if (!isEditingQuantity) {
      setEditQuantity(item.quantity.toString());
    }
  }, [item.quantity, isEditingQuantity]);

  const updateQuantity = api.cart.updateQuantity.useMutation({
    onSuccess: () => {
      void utils.cart.getCart.invalidate();
    },
    onError: () => {
      toast({
        title: t('messages.errorUpdatingQuantity'),
        variant: 'destructive',
      });
    },
  });

  const removeItem = api.cart.removeItem.useMutation({
    onSuccess: () => {
      toast({
        title: t('messages.removedFromCart'),
      });
      void utils.cart.getCart.invalidate();
    },
    onError: () => {
      toast({
        title: t('messages.errorRemovingItem'),
        variant: 'destructive',
      });
    },
  });

  const isPending = updateQuantity.isPending || removeItem.isPending;

  const handleIncrease = () => {
    updateQuantity.mutate({
      productId: item.productId,
      quantity: item.quantity + 1,
    });
  };

  const handleDecrease = () => {
    if (item.quantity > 0.01) {
      const newQty = Math.round((item.quantity - 1) * 100) / 100;
      if (newQty <= 0) {
        removeItem.mutate({ productId: item.productId });
      } else {
        updateQuantity.mutate({
          productId: item.productId,
          quantity: newQty,
        });
      }
    }
  };

  const handleIncreaseBy5 = () => {
    updateQuantity.mutate({
      productId: item.productId,
      quantity: item.quantity + 5,
    });
  };

  const handleDecreaseBy5 = () => {
    const newQty = item.quantity - 5;
    if (newQty <= 0) {
      removeItem.mutate({ productId: item.productId });
    } else {
      updateQuantity.mutate({
        productId: item.productId,
        quantity: newQty,
      });
    }
  };

  const handleRemove = () => {
    removeItem.mutate({ productId: item.productId });
  };

  const handleQuantityClick = () => {
    setIsEditingQuantity(true);
    setEditQuantity(item.quantity.toString());
    // Focus input after state update
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleQuantityBlur = () => {
    setIsEditingQuantity(false);

    // Handle empty input - remove item from cart
    if (editQuantity.trim() === '') {
      removeItem.mutate({ productId: item.productId });
      return;
    }

    const newQty = Math.round(parseFloat(editQuantity) * 100) / 100;

    // If invalid number, restore to original
    if (isNaN(newQty)) {
      setEditQuantity(item.quantity.toString());
      return;
    }

    // If 0 or negative, remove item from cart
    if (newQty <= 0) {
      removeItem.mutate({ productId: item.productId });
      return;
    }

    // If valid and different from current, update
    if (newQty !== item.quantity) {
      updateQuantity.mutate({
        productId: item.productId,
        quantity: newQty,
      });
    } else {
      // Same value, just normalize the display
      setEditQuantity(item.quantity.toString());
    }
  };

  const handleQuantityKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleQuantityBlur();
    } else if (e.key === 'Escape') {
      setIsEditingQuantity(false);
      setEditQuantity(item.quantity.toString());
    }
  };

  const handleConfirmQuantity = () => {
    handleQuantityBlur();
  };

  const handleCancelEdit = () => {
    setIsEditingQuantity(false);
    setEditQuantity(item.quantity.toString());
  };

  // Item total is already calculated by backend
  return (
    <Card>
      <CardContent className="p-4">
        {/* Header row with product name and delete button */}
        <div className="flex justify-between items-start mb-2">
          <H4 className="text-base md:text-lg">{item.productName}</H4>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRemove}
            disabled={removeItem.isPending}
            className="h-8 w-8 -mt-1 -mr-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            aria-label={t('buttons.removeItem')}
          >
            {removeItem.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </Button>
        </div>

        <div className="flex gap-4">
          {/* Product Info */}
          <div className="flex-1">
            <Muted className="text-sm">SKU: {item.sku}</Muted>
            <div className="mt-2">
              <p className="text-sm font-medium">{formatAUD(item.unitPrice)}</p>
              <Muted className="text-xs">{tProducts('perUnit', { unit: item.unit })}</Muted>
            </div>
          </div>

          {/* Quantity Controls */}
          <div className="flex flex-col items-end gap-3">
            {/* Enhanced quantity controls: -5, -1, qty, +1, +5 */}
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-11 w-11 text-sm font-semibold"
                onClick={handleDecreaseBy5}
                disabled={isPending}
                aria-label={t('decrementBy5')}
              >
                {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '-5'}
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-11 w-11"
                onClick={handleDecrease}
                disabled={item.quantity <= 0.01 || isPending}
                aria-label={tProducts('decreaseQuantity')}
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Minus className="h-4 w-4" />}
              </Button>
              {isEditingQuantity ? (
                <>
                  <Input
                    ref={inputRef}
                    type="number"
                    step="0.01"
                    value={editQuantity}
                    onChange={(e) => setEditQuantity(e.target.value)}
                    onBlur={handleQuantityBlur}
                    onKeyDown={handleQuantityKeyDown}
                    className="h-11 w-14 text-center font-medium p-1"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-11 w-11 border-green-500 hover:bg-green-50 hover:border-green-600"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleConfirmQuantity}
                    disabled={isPending || editQuantity === item.quantity.toString()}
                    aria-label={t('confirmQuantity')}
                  >
                    {isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4 text-green-600" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleCancelEdit}
                    disabled={isPending}
                    aria-label={t('cancelEdit')}
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleQuantityClick}
                  className="h-11 w-14 border border-input rounded-md bg-background hover:bg-muted/50 transition-colors flex items-center justify-center font-medium"
                  title={t('tapToEditQuantity')}
                >
                  {item.quantity}
                </button>
              )}
              <Button
                variant="outline"
                size="icon"
                className="h-11 w-11"
                onClick={handleIncrease}
                disabled={isPending}
                aria-label={tProducts('increaseQuantity')}
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-11 w-11 text-sm font-semibold"
                onClick={handleIncreaseBy5}
                disabled={isPending}
                aria-label={t('incrementBy5')}
              >
                {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '+5'}
              </Button>
            </div>

            {/* Item Total */}
            <div className="text-right">
              <p className="font-semibold">{formatAUD(item.subtotal)}</p>
              <Muted className="text-xs">{t('itemTotal')}</Muted>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
