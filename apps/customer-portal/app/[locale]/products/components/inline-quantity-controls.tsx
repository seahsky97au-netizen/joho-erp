'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Button, useToast, cn } from '@joho-erp/ui';
import { Minus, Plus, Loader2, Check, X } from 'lucide-react';
import { api } from '@/trpc/client';

const MAX_QUANTITY = 999;
const MIN_QUANTITY = 0.01;

interface InlineQuantityControlsProps {
  productId: string;
  productName: string;
  currentQuantity: number; // 0 if not in cart
  disabled: boolean; // credit status, onboarding
  className?: string;
}

export function InlineQuantityControls({
  productId,
  productName,
  currentQuantity,
  disabled,
  className,
}: InlineQuantityControlsProps) {
  const tCart = useTranslations('cart');
  const t = useTranslations('products');
  const tErrors = useTranslations('errors');
  const { toast } = useToast();
  const [isEditing, setIsEditing] = React.useState(false);
  const [inputValue, setInputValue] = React.useState(currentQuantity.toString());
  const [isPending, setIsPending] = React.useState(false);
  const [customQuantity, setCustomQuantity] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  const customInputRef = React.useRef<HTMLInputElement>(null);

  const utils = api.useUtils();

  // Sync input value when currentQuantity changes externally
  React.useEffect(() => {
    if (!isEditing) {
      setInputValue(currentQuantity.toString());
    }
  }, [currentQuantity, isEditing]);

  // Auto-focus input when entering edit mode
  React.useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Add to cart mutation
  const addToCart = api.cart.addItem.useMutation({
    onMutate: async (variables) => {
      setIsPending(true);
      await utils.cart.getCart.cancel();

      // Optimistic update
      const previousCart = utils.cart.getCart.getData();
      utils.cart.getCart.setData(undefined, (old) => {
        if (!old) return old;
        return {
          ...old,
          itemCount: old.itemCount + variables.quantity,
        };
      });

      return { previousCart };
    },
    onSuccess: () => {
      toast({
        title: tCart('messages.addedToCart'),
        description: tCart('messages.productAddedToCart', { productName }),
      });
    },
    onError: (error, _variables, context) => {
      if (context?.previousCart) {
        utils.cart.getCart.setData(undefined, context.previousCart);
      }
      console.error('Cart add error:', error.message);
      toast({
        title: tCart('messages.errorAddingToCart'),
        description: tErrors('cartUpdateFailed'),
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setIsPending(false);
      void utils.cart.getCart.invalidate();
    },
  });

  // Update quantity mutation
  const updateQuantity = api.cart.updateQuantity.useMutation({
    onMutate: async (variables) => {
      setIsPending(true);
      await utils.cart.getCart.cancel();

      // Optimistic update
      const previousCart = utils.cart.getCart.getData();
      utils.cart.getCart.setData(undefined, (old) => {
        if (!old) return old;
        const quantityDiff = variables.quantity - currentQuantity;
        return {
          ...old,
          itemCount: old.itemCount + quantityDiff,
          items: old.items.map((item) =>
            item.productId === variables.productId
              ? { ...item, quantity: variables.quantity }
              : item
          ),
        };
      });

      return { previousCart };
    },
    onError: (error, _variables, context) => {
      if (context?.previousCart) {
        utils.cart.getCart.setData(undefined, context.previousCart);
      }
      console.error('Cart update error:', error.message);
      toast({
        title: tCart('messages.errorUpdatingQuantity'),
        description: tErrors('cartUpdateFailed'),
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setIsPending(false);
      void utils.cart.getCart.invalidate();
    },
  });

  // Remove item mutation
  const removeItem = api.cart.removeItem.useMutation({
    onMutate: async (variables) => {
      setIsPending(true);
      await utils.cart.getCart.cancel();

      // Optimistic update
      const previousCart = utils.cart.getCart.getData();
      utils.cart.getCart.setData(undefined, (old) => {
        if (!old) return old;
        return {
          ...old,
          itemCount: old.itemCount - currentQuantity,
          items: old.items.filter((item) => item.productId !== variables.productId),
        };
      });

      return { previousCart };
    },
    onSuccess: () => {
      toast({
        title: tCart('messages.removedFromCart'),
      });
    },
    onError: (error, _variables, context) => {
      if (context?.previousCart) {
        utils.cart.getCart.setData(undefined, context.previousCart);
      }
      console.error('Cart remove error:', error.message);
      toast({
        title: tCart('messages.errorRemovingItem'),
        description: tErrors('cartUpdateFailed'),
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setIsPending(false);
      void utils.cart.getCart.invalidate();
    },
  });

  const handleAdd5 = () => {
    const newQty = currentQuantity + 5;
    if (currentQuantity === 0) {
      addToCart.mutate({ productId, quantity: 5 });
    } else {
      updateQuantity.mutate({ productId, quantity: Math.min(newQty, MAX_QUANTITY) });
    }
  };

  const handleSubtract5 = () => {
    const newQty = currentQuantity - 5;
    if (newQty <= 0) {
      removeItem.mutate({ productId });
    } else {
      updateQuantity.mutate({ productId, quantity: Math.max(newQty, MIN_QUANTITY) });
    }
  };

  const handleEnablePrecisionMode = () => {
    setIsEditing(true);
  };

  const handleSaveQuantity = () => {
    // Handle empty input - remove item from cart
    if (inputValue.trim() === '') {
      // Only remove if item is in cart
      if (currentQuantity > 0) {
        removeItem.mutate({ productId });
      }
      setIsEditing(false);
      return;
    }

    const newQty = Math.round(parseFloat(inputValue) * 100) / 100;

    // If invalid number or 0, remove item if in cart
    if (isNaN(newQty) || newQty <= 0) {
      if (currentQuantity > 0) {
        removeItem.mutate({ productId });
      } else {
        toast({
          title: t('quantity.invalid'),
          description: t('quantity.precision'),
          variant: 'destructive',
        });
        setInputValue(currentQuantity.toString());
      }
      setIsEditing(false);
      return;
    }

    // Validate range
    if (newQty > MAX_QUANTITY) {
      toast({
        title: t('quantity.invalid'),
        description: t('quantity.precision'),
        variant: 'destructive',
      });
      setInputValue(currentQuantity.toString());
      setIsEditing(false);
      return;
    }

    // No change, just exit edit mode
    if (newQty === currentQuantity) {
      setIsEditing(false);
      return;
    }

    // Update quantity
    if (currentQuantity === 0) {
      addToCart.mutate({ productId, quantity: newQty });
    } else {
      updateQuantity.mutate({ productId, quantity: newQty });
    }

    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setInputValue(currentQuantity.toString());
    setIsEditing(false);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Allow empty for typing convenience
    if (value === '') {
      setInputValue('');
      return;
    }
    // Allow numbers and decimals
    const numValue = parseFloat(value);
    if (!isNaN(numValue) && numValue <= MAX_QUANTITY) {
      setInputValue(value);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveQuantity();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  // Handlers for custom quantity input (State 1 - not in cart)
  const handleCustomInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Allow empty for typing convenience
    if (value === '') {
      setCustomQuantity('');
      return;
    }
    // Allow positive numbers and decimals
    const numValue = parseFloat(value);
    if (!isNaN(numValue) && numValue >= 0 && numValue <= MAX_QUANTITY) {
      setCustomQuantity(value);
    }
  };

  const handleCustomInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddCustomQuantity();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setCustomQuantity('');
      customInputRef.current?.blur();
    }
  };

  const handleAddCustomQuantity = () => {
    // Empty input - do nothing
    if (customQuantity.trim() === '') {
      return;
    }

    const qty = Math.round(parseFloat(customQuantity) * 100) / 100;

    // Invalid or non-positive
    if (isNaN(qty) || qty <= 0) {
      toast({
        title: t('quantity.invalid'),
        description: t('quantity.enterValidAmount'),
        variant: 'destructive',
      });
      setCustomQuantity('');
      return;
    }

    // Exceeds max
    if (qty > MAX_QUANTITY) {
      toast({
        title: t('quantity.invalid'),
        description: t('quantity.maxExceeded', { max: MAX_QUANTITY }),
        variant: 'destructive',
      });
      setCustomQuantity('');
      return;
    }

    // Valid - add to cart
    addToCart.mutate({ productId, quantity: qty });
    setCustomQuantity('');
  };

  // State 1: Not in cart (custom input + confirm button + quick-add button)
  if (currentQuantity === 0 && !isEditing) {
    const hasValidCustomQuantity = customQuantity.trim() !== '' && !isNaN(parseFloat(customQuantity)) && parseFloat(customQuantity) > 0;

    return (
      <div className={cn('flex items-center gap-1.5', className)}>
        <input
          ref={customInputRef}
          type="number"
          value={customQuantity}
          onChange={handleCustomInputChange}
          onKeyDown={handleCustomInputKeyDown}
          disabled={disabled || isPending}
          min={MIN_QUANTITY}
          max={MAX_QUANTITY}
          step="0.01"
          className={cn(
            'h-9 w-14 border-2 border-border rounded-md text-center font-medium text-sm',
            'focus:outline-none focus:ring-2 focus:ring-ring focus:border-primary',
            'transition-all duration-200 placeholder:text-muted-foreground',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
          placeholder={t('quantity.placeholder')}
          aria-label={t('quantity.enterCustom')}
        />
        {/* Confirm button - only visible when custom quantity has a valid value */}
        {hasValidCustomQuantity && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleAddCustomQuantity}
            disabled={disabled || isPending}
            className={cn(
              'h-9 w-9 p-0',
              'border-green-500 hover:bg-green-50 hover:border-green-600',
              'disabled:border-border disabled:hover:bg-transparent'
            )}
            title={t('quantity.confirm')}
            aria-label={t('quantity.confirm')}
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5 text-green-600" />
            )}
          </Button>
        )}
        <Button
          size="sm"
          onClick={handleAdd5}
          disabled={disabled || isPending}
          className="gap-1 px-2.5"
          title={t('quantity.quickAdd5')}
          aria-label={t('quantity.quickAdd5')}
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          <span className="text-xs">5</span>
        </Button>
      </div>
    );
  }

  // State 2: In cart (not editing) - show [-5] [qty] [+5]
  if (!isEditing) {
    return (
      <div className={cn('flex items-center gap-1', className)}>
        <Button
          size="sm"
          variant="outline"
          onClick={handleSubtract5}
          disabled={disabled || isPending}
          className="h-9 w-9 p-0"
          title={t('quantity.remove5')}
          aria-label={t('quantity.remove5')}
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Minus className="h-3.5 w-3.5" />
          )}
        </Button>

        <button
          onClick={handleEnablePrecisionMode}
          disabled={disabled || isPending}
          className={cn(
            'h-9 w-14 border-y-2 border-border font-bold text-sm transition-colors',
            'hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
          title={t('quantity.edit')}
          aria-label={t('quantity.current', { count: currentQuantity })}
        >
          {currentQuantity}
        </button>

        <Button
          size="sm"
          variant="outline"
          onClick={handleAdd5}
          disabled={disabled || isPending}
          className="h-9 w-9 p-0"
          title={t('quantity.add5')}
          aria-label={t('quantity.add5')}
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    );
  }

  // State 3: Precision edit mode - show [input] [✓] [✗] (simplified for mobile)
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <input
        ref={inputRef}
        type="number"
        value={inputValue}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        disabled={disabled || isPending}
        min={MIN_QUANTITY}
        max={MAX_QUANTITY}
        step="0.01"
        className={cn(
          'h-9 w-16 border-2 border-primary rounded-md text-center font-bold text-sm',
          'focus:outline-none focus:ring-2 focus:ring-ring',
          'transition-all duration-200',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
        placeholder={currentQuantity.toString()}
        aria-label={t('quantity.precision')}
      />

      <Button
        size="sm"
        variant="outline"
        onClick={handleSaveQuantity}
        disabled={disabled || isPending || inputValue === currentQuantity.toString()}
        className={cn(
          'h-9 w-9 p-0',
          'border-green-500 hover:bg-green-50 hover:border-green-600',
          'disabled:border-border disabled:hover:bg-transparent'
        )}
        title={t('quantity.confirm')}
        aria-label={t('quantity.confirm')}
      >
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5 text-green-600" />
        )}
      </Button>

      <Button
        size="sm"
        variant="ghost"
        onClick={handleCancelEdit}
        disabled={disabled || isPending}
        className="h-9 w-9 p-0 hover:bg-muted"
        title={t('quantity.cancel')}
        aria-label={t('quantity.cancel')}
      >
        <X className="h-3.5 w-3.5 text-muted-foreground" />
      </Button>
    </div>
  );
}
