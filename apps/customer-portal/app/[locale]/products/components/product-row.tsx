'use client';

import * as React from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { Badge, Muted, Large } from '@joho-erp/ui';
import { formatAUD } from '@joho-erp/shared';
import type { ProductWithPricing, StockStatus } from '@joho-erp/shared';
import { InlineQuantityControls } from './inline-quantity-controls';
import { ExpandableDetails } from './expandable-details';

interface ProductRowProps {
  product: ProductWithPricing & {
    id: string;
    name: string;
    sku: string;
    description: string | null;
    categoryId: string | null;
    categoryRelation: {
      id: string;
      name: string;
      isActive: boolean;
    } | null;
    unit: string;
    basePrice: number;
    stockStatus: StockStatus;
    hasStock: boolean;
    imageUrl: string | null;
    applyGst?: boolean;
    gstRate?: number | null;
    priceWithGst?: number;
  };
  expanded: boolean;
  onExpandToggle: () => void;
  canAddToCart: boolean;
  cartQuantity: number; // Quantity in cart (0 if not in cart)
  creditStatus?: 'pending' | 'approved' | 'rejected' | null;
}

export function ProductRow({
  product,
  expanded,
  onExpandToggle,
  canAddToCart,
  cartQuantity,
  creditStatus: _creditStatus,
}: ProductRowProps) {
  const t = useTranslations('products');

  const getStockBadge = (stockStatus: StockStatus) => {
    switch (stockStatus) {
      case 'low_stock':
        return (
          <Badge variant="warning" className="text-xs">
            {t('lowStock')}
          </Badge>
        );
      case 'out_of_stock':
        return (
          <Badge variant="destructive" className="text-xs">
            {t('outOfStock')}
          </Badge>
        );
      case 'in_stock':
      default:
        return (
          <Badge variant="success" className="text-xs">
            {t('inStock')}
          </Badge>
        );
    }
  };

  // Determine display price (GST-inclusive if applicable, otherwise effective price)
  const displayPrice = product.priceWithGst || product.effectivePrice || product.basePrice;
  const hasCustomPricing = product.hasCustomPricing || false;

  return (
    <div className="bg-background">
      {/* Main Product Row */}
      <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4 p-4 transition-colors hover:bg-muted/30">
        {/* Mobile Layout: Image on left, info stacked on right */}
        <div className="flex gap-3 md:hidden">
          {/* Product Image - Bigger on mobile */}
          <div className="flex-shrink-0 w-20 h-20 relative rounded-lg overflow-hidden border border-border bg-muted">
            {product.imageUrl ? (
              <Image
                src={product.imageUrl}
                alt={product.name}
                fill
                className="object-cover"
                sizes="80px"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                <span className="text-xs font-medium">{t('noImage')}</span>
              </div>
            )}
          </div>

          {/* Product Info + Price stacked vertically */}
          <div className="flex-1 min-w-0 flex flex-col justify-between">
            {/* Product Name */}
            <div>
              <button
                onClick={onExpandToggle}
                className="text-left w-full group focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded"
              >
                <h3 className="font-semibold text-sm group-hover:text-primary transition-colors">
                  {product.name}
                </h3>
              </button>
              {/* SKU + Category */}
              <div className="flex items-center gap-1.5 mt-0.5">
                <Muted className="text-xs">
                  {product.sku}
                </Muted>
                {product.categoryRelation && (
                  <>
                    <span className="text-muted-foreground text-xs">|</span>
                    <Muted className="text-xs truncate">
                      {product.categoryRelation.name}
                    </Muted>
                  </>
                )}
              </div>
            </div>

            {/* Price + Stock (Mobile) - Below product name */}
            <div className="flex items-center justify-between mt-1.5">
              <div className="flex items-center gap-1.5">
                <Large className="font-bold text-sm">
                  {formatAUD(displayPrice)}
                </Large>
                <Muted className="text-xs">
                  / {product.unit}
                </Muted>
              </div>
              <div className="flex items-center gap-1.5">
                {getStockBadge(product.stockStatus)}
                {hasCustomPricing && (
                  <Badge variant="success" className="text-xs">
                    {t('customPricing')}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Desktop Layout: Original horizontal layout */}
        <div className="hidden md:flex md:items-center md:gap-4 md:flex-1 min-w-0">
          {/* Product Image */}
          <div className="flex-shrink-0 w-20 h-20 relative rounded-lg overflow-hidden border border-border bg-muted">
            {product.imageUrl ? (
              <Image
                src={product.imageUrl}
                alt={product.name}
                fill
                className="object-cover"
                sizes="80px"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                <span className="text-xs font-medium">{t('noImage')}</span>
              </div>
            )}
          </div>

          {/* Product Info */}
          <div className="flex-1 min-w-0">
            <button
              onClick={onExpandToggle}
              className="text-left w-full group focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded"
            >
              <h3 className="font-semibold text-base group-hover:text-primary transition-colors">
                {product.name}
              </h3>
            </button>
            <div className="flex items-center gap-2 mt-1">
              <Muted className="text-xs">
                {product.sku}
              </Muted>
              {product.categoryRelation && (
                <>
                  <span className="text-muted-foreground">|</span>
                  <Muted className="text-xs">
                    {product.categoryRelation.name}
                  </Muted>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Price (Desktop only) */}
        <div className="hidden md:flex md:flex-col md:items-end md:w-32 md:flex-shrink-0">
          <Large className="font-bold">
            {formatAUD(displayPrice)}
          </Large>
          <Muted className="text-xs">
            {product.applyGst ? t('gstIncluded') : t('perUnit', { unit: product.unit })}
          </Muted>
          {hasCustomPricing && (
            <Badge variant="success" className="text-xs mt-1">
              {t('customPricing')}
            </Badge>
          )}
        </div>

        {/* Stock Status (Desktop only) */}
        <div className="hidden md:flex md:w-28 md:flex-shrink-0 md:justify-center">
          {getStockBadge(product.stockStatus)}
        </div>

        {/* Quantity Controls */}
        <div className="flex items-center justify-end md:w-44 md:flex-shrink-0">
          <InlineQuantityControls
            productId={product.id}
            productName={product.name}
            currentQuantity={cartQuantity}
            disabled={!canAddToCart}
          />
        </div>
      </div>

      {/* Expandable Details */}
      <ExpandableDetails
        expanded={expanded}
        onCollapse={onExpandToggle}
        product={{
          description: product.description,
          basePrice: product.basePrice,
          effectivePrice: product.effectivePrice,
          priceWithGst: product.priceWithGst,
          hasCustomPricing: product.hasCustomPricing,
          applyGst: product.applyGst,
          gstRate: product.gstRate,
          unit: product.unit,
        }}
      />
    </div>
  );
}
