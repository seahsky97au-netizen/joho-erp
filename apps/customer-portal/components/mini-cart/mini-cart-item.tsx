'use client';

import * as React from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { Button, useToast, Badge, cn } from '@joho-erp/ui';
import { Minus, Plus, Trash2 } from 'lucide-react';
import { formatAUD } from '@joho-erp/shared';
import { api } from '@/trpc/client';
import { ProductImageDialog } from './product-image-dialog';

interface MiniCartItemProps {
  item: {
    productId: string;
    sku: string;
    productName: string;
    unit: string;
    quantity: number;
    unitPrice: number; // in cents
    subtotal: number; // in cents
    hasCustomPricing: boolean;
    imageUrl: string | null;
    description: string | null;
  };
}

export function MiniCartItem({ item }: MiniCartItemProps) {
  const t = useTranslations('miniCart');
  const tCart = useTranslations('cart');
  const tProducts = useTranslations('products');
  const { toast } = useToast();
  const utils = api.useUtils();
  const [isHovered, setIsHovered] = React.useState(false);
  const [showImageDialog, setShowImageDialog] = React.useState(false);

  const updateQuantity = api.cart.updateQuantity.useMutation({
    onSuccess: () => {
      void utils.cart.getCart.invalidate();
    },
    onError: () => {
      toast({
        title: tCart('messages.errorUpdatingQuantity'),
        variant: 'destructive',
      });
    },
  });

  const removeItem = api.cart.removeItem.useMutation({
    onSuccess: () => {
      toast({
        title: tCart('messages.removedFromCart'),
      });
      void utils.cart.getCart.invalidate();
    },
    onError: () => {
      toast({
        title: tCart('messages.errorRemovingItem'),
        variant: 'destructive',
      });
    },
  });

  const handleIncrease = () => {
    updateQuantity.mutate({
      productId: item.productId,
      quantity: item.quantity + 1,
    });
  };

  const handleDecrease = () => {
    if (item.quantity > 1) {
      updateQuantity.mutate({
        productId: item.productId,
        quantity: item.quantity - 1,
      });
    }
  };

  const handleRemove = () => {
    removeItem.mutate({ productId: item.productId });
  };

  const isPending = updateQuantity.isPending || removeItem.isPending;

  return (
    <>
      <div
        className={cn(
          'relative flex gap-3 py-4',
          'border-b border-neutral-100 last:border-b-0',
          'transition-all duration-200',
          isHovered && 'bg-neutral-50/50 -mx-2 px-2 rounded-lg'
        )}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Delete Button - Top Right */}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'absolute top-2 right-0',
            'h-7 w-7',
            'text-neutral-400 hover:text-destructive',
            'hover:bg-destructive/10',
            'transition-all duration-200'
          )}
          onClick={handleRemove}
          disabled={isPending}
          aria-label={t('removeItem')}
        >
          <Trash2 className="h-4 w-4" />
        </Button>

        {/* Product Image - Clickable */}
        <button
          onClick={() => item.imageUrl && setShowImageDialog(true)}
          className={cn(
            'flex-shrink-0 w-16 h-16 relative rounded-lg overflow-hidden',
            'border border-neutral-200 bg-neutral-50',
            item.imageUrl && 'cursor-pointer hover:ring-2 hover:ring-primary/20',
            'transition-all duration-200',
            'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2'
          )}
          disabled={!item.imageUrl}
          aria-label={item.imageUrl ? t('viewImage') : undefined}
        >
          {item.imageUrl ? (
            <Image
              src={item.imageUrl}
              alt={item.productName}
              fill
              className="object-cover"
              sizes="64px"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-[10px] font-medium text-neutral-400 text-center px-1">
                {tProducts('noImage')}
              </span>
            </div>
          )}
        </button>

        {/* Product Info */}
        <div className="flex-1 min-w-0">
          {/* Product Name */}
          <h4 className="text-sm font-medium text-neutral-900 leading-snug mb-1">
            {item.productName}
          </h4>

          {/* SKU, Price, Unit, Special Badge */}
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <span className="text-xs text-neutral-500">
              {formatAUD(item.unitPrice)}
            </span>
            <span className="text-neutral-300">·</span>
            <span className="text-xs text-neutral-400">{item.unit}</span>
            {item.hasCustomPricing && (
              <>
                <span className="text-neutral-300">·</span>
                <Badge variant="success" className="text-[10px] px-1.5 py-0">
                  {tProducts('specialPrice')}
                </Badge>
              </>
            )}
          </div>

          {/* Description (if available) */}
          {item.description && (
            <p className="text-xs text-neutral-500 leading-relaxed line-clamp-2 mb-2">
              {item.description}
            </p>
          )}

          {/* Quantity Controls + Subtotal Row */}
          <div className="flex items-center justify-between mt-2">
            {/* Quantity Controls */}
            <div className={cn(
              'flex items-center gap-1 p-0.5 rounded-lg',
              'bg-neutral-100/80 border border-neutral-200/60'
            )}>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-8 w-8 rounded-md',
                  'hover:bg-white hover:shadow-sm',
                  'transition-all duration-150'
                )}
                onClick={handleDecrease}
                disabled={item.quantity <= 1 || isPending}
                aria-label={tProducts('decreaseQuantity')}
              >
                <Minus className="h-3.5 w-3.5 text-neutral-600" />
              </Button>

              <span className={cn(
                'w-8 text-center text-sm font-semibold text-neutral-800',
                'tabular-nums'
              )}>
                {item.quantity}
              </span>

              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-8 w-8 rounded-md',
                  'hover:bg-white hover:shadow-sm',
                  'transition-all duration-150'
                )}
                onClick={handleIncrease}
                disabled={isPending}
                aria-label={tProducts('increaseQuantity')}
              >
                <Plus className="h-3.5 w-3.5 text-neutral-600" />
              </Button>
            </div>

            {/* Subtotal */}
            <span className="text-sm font-semibold text-neutral-900 tabular-nums">
              {formatAUD(item.subtotal)}
            </span>
          </div>
        </div>

        {/* Loading Overlay */}
        {isPending && (
          <div className="absolute inset-0 bg-white/60 backdrop-blur-[1px] rounded-lg flex items-center justify-center">
            <div className="w-5 h-5 border-2 border-neutral-200 border-t-[hsl(0,67%,35%)] rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Image Enlargement Dialog */}
      <ProductImageDialog
        open={showImageDialog}
        onClose={() => setShowImageDialog(false)}
        imageUrl={item.imageUrl}
        productName={item.productName}
      />
    </>
  );
}
