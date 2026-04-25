'use client';

import { useState, useEffect, useCallback } from 'react';
import { StatusBadge, type StatusType, useToast, Card, CardContent, Button, AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger, Badge, Input, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@joho-erp/ui';
import { useTranslations } from 'next-intl';
import { CheckSquare, Square, Loader2, Send, StickyNote, PauseCircle, PlayCircle, RotateCcw, Plus, Minus, Package, AlertTriangle, Lock } from 'lucide-react';
import { api } from '@/trpc/client';
import { useDebouncedCallback } from 'use-debounce';
import { PinEntryDialog } from './PinEntryDialog';

// Map area colorVariant to Tailwind background classes
const areaColorClasses: Record<string, string> = {
  default: 'bg-slate-500',
  secondary: 'bg-gray-500',
  info: 'bg-blue-500',
  success: 'bg-green-500',
  warning: 'bg-amber-500',
  destructive: 'bg-red-500',
};

interface PackingOrderCardProps {
  order: {
    orderId: string;
    orderNumber: string;
    customerName: string;
    areaName: string | null;
    areaPackingSequence: number | null;
    areaColorVariant?: string;
    areaDisplayName?: string;
    deliverySequence: number | null;
    status: string;
    // Partial progress fields
    isPaused?: boolean;
    lastPackedBy?: string | null;
    lastPackedAt?: Date | null;
    packedItemsCount?: number;
    totalItemsCount?: number;
    // Auto-merge fields
    internalNotes?: string | null;
    mergedFromOrderNumbers?: string[];
  };
  onOrderUpdated: () => void;
}

export function PackingOrderCard({ order, onOrderUpdated }: PackingOrderCardProps) {
  const t = useTranslations('packing');
  const tErrors = useTranslations('errors');
  const { toast } = useToast();
  const [packingNotes, setPackingNotes] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editQuantity, setEditQuantity] = useState<string>('');
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const [pendingQuantityChange, setPendingQuantityChange] = useState<{
    productId: string;
    newQuantity: number;
    currentStock: number;
  } | null>(null);

  const utils = api.useUtils();

  // Check if PIN is required for quantity modifications
  const { data: pinData } = api.packing.isPinRequired.useQuery();
  const isPinRequired = pinData?.required ?? false;

  const { data: orderDetails, isLoading } = api.packing.getOrderDetails.useQuery({
    orderId: order.orderId,
  });

  // Sync local notes state with server data on initial load
  useEffect(() => {
    if (orderDetails?.packingNotes) {
      setPackingNotes(orderDetails.packingNotes);
    }
  }, [orderDetails?.packingNotes]);

  const markOrderReadyMutation = api.packing.markOrderReady.useMutation({
    onMutate: async (variables) => {
      const { orderId, notes } = variables;

      // Cancel outgoing refetches
      await utils.packing.getOrderDetails.cancel({ orderId });

      // Snapshot for rollback
      const previousOrderDetails = utils.packing.getOrderDetails.getData({ orderId });

      // Optimistically update order status
      utils.packing.getOrderDetails.setData(
        { orderId },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            status: 'ready_for_delivery' as const,
            packingNotes: notes,
          };
        }
      );

      return { previousOrderDetails };
    },

    onSuccess: (data) => {
      toast({
        title: t('orderReady'),
        description: t('orderReadyDescription'),
      });

      // Update cache with fresh stock data from response (no refetch/flash)
      if (data.updatedStocks) {
        utils.packing.getOrderDetails.setData(
          { orderId: order.orderId },
          (old) => {
            if (!old) return old;
            return {
              ...old,
              status: 'ready_for_delivery' as const,
              items: old.items.map((item) => {
                const updatedStock = data.updatedStocks?.[item.productId];
                if (updatedStock) {
                  return {
                    ...item,
                    currentStock: updatedStock.currentStock,
                    lowStockThreshold: updatedStock.lowStockThreshold ?? undefined,
                  };
                }
                return item;
              }),
            };
          }
        );
      }

      // Parent's onOrderUpdated() handles list refresh
      onOrderUpdated();
    },

    onError: (error, variables, context) => {
      // Rollback on error
      if (context?.previousOrderDetails) {
        utils.packing.getOrderDetails.setData(
          { orderId: variables.orderId },
          context.previousOrderDetails
        );
      }

      console.error('Operation error:', error.message);
      toast({
        title: t('errorMarkingReady'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  const markItemPackedMutation = api.packing.markItemPacked.useMutation({
    // Optimistic update: Update cache before server responds
    onMutate: async (variables) => {
      const { orderId, itemSku, packed } = variables;

      // Cancel any outgoing refetches (so they don't overwrite optimistic update)
      await utils.packing.getOrderDetails.cancel({ orderId });

      // Snapshot the previous value for rollback
      const previousOrderDetails = utils.packing.getOrderDetails.getData({ orderId });

      // Optimistically update orderDetails cache
      utils.packing.getOrderDetails.setData(
        { orderId },
        (old) => {
          if (!old) return old;

          const updatedItems = old.items.map((item) =>
            item.sku === itemSku ? { ...item, packed } : item
          );

          return {
            ...old,
            items: updatedItems,
            allItemsPacked: updatedItems.length > 0 && updatedItems.every((item) => item.packed),
          };
        }
      );

      // Return context for rollback
      return { previousOrderDetails };
    },

    // On error: rollback to previous state
    onError: (error, variables, context) => {
      // Restore previous cache state
      if (context?.previousOrderDetails) {
        utils.packing.getOrderDetails.setData(
          { orderId: variables.orderId },
          context.previousOrderDetails
        );
      }

      console.error('Operation error:', error.message);
      toast({
        title: t('errorMarkingItem'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },

    // On success: cache already updated optimistically, no action needed
    onSuccess: () => {
      // Success handled silently - UI already updated optimistically
    },
  });

  const addPackingNotesMutation = api.packing.addPackingNotes.useMutation({
    onMutate: async (variables) => {
      const { orderId, notes } = variables;

      await utils.packing.getOrderDetails.cancel({ orderId });

      const previousOrderDetails = utils.packing.getOrderDetails.getData({ orderId });

      // Optimistically update notes in cache
      utils.packing.getOrderDetails.setData(
        { orderId },
        (old) => {
          if (!old) return old;
          return { ...old, packingNotes: notes };
        }
      );

      return { previousOrderDetails };
    },

    onError: (error, variables, context) => {
      if (context?.previousOrderDetails) {
        utils.packing.getOrderDetails.setData(
          { orderId: variables.orderId },
          context.previousOrderDetails
        );
      }
      // Silent error - user can retry by typing again
    },

    onSuccess: () => {
      // Success handled silently
    },
  });

  // Pause order mutation
  const pauseOrderMutation = api.packing.pauseOrder.useMutation({
    onSuccess: () => {
      toast({
        title: t('orderPaused'),
        description: t('orderPausedDescription'),
      });
      // Don't invalidate - parent's onOrderUpdated() handles refresh
      onOrderUpdated();
    },
    onError: (error) => {
      console.error('Operation error:', error.message);
      toast({
        title: t('errorPausingOrder'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  // Resume order mutation
  const resumeOrderMutation = api.packing.resumeOrder.useMutation({
    onSuccess: () => {
      toast({
        title: t('orderResumed'),
        description: t('orderResumedDescription'),
      });
      // Don't invalidate - parent's onOrderUpdated() handles refresh
      onOrderUpdated();
    },
    onError: (error) => {
      console.error('Operation error:', error.message);
      toast({
        title: t('errorResumingOrder'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  // Reset order mutation
  const resetOrderMutation = api.packing.resetOrder.useMutation({
    onSuccess: () => {
      toast({
        title: t('orderReset'),
        description: t('orderResetDescription'),
      });
      // Don't invalidate - parent's onOrderUpdated() handles refresh
      onOrderUpdated();
    },
    onError: (error) => {
      console.error('Operation error:', error.message);
      toast({
        title: t('errorResettingOrder'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  // Update item quantity mutation
  const updateItemQuantityMutation = api.packing.updateItemQuantity.useMutation({
    onMutate: async (variables) => {
      const { orderId, productId, newQuantity } = variables;

      // Cancel any outgoing refetches
      await utils.packing.getOrderDetails.cancel({ orderId });

      // Snapshot for rollback
      const previousOrderDetails = utils.packing.getOrderDetails.getData({ orderId });

      // Optimistically update quantity (keep item with qty=0)
      utils.packing.getOrderDetails.setData(
        { orderId },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            items: old.items.map((item) =>
              item.productId === productId
                ? { ...item, quantity: newQuantity }
                : item
            ),
          };
        }
      );

      return { previousOrderDetails };
    },
    onSuccess: (data) => {
      setEditingItemId(null);
      setEditQuantity('');
      if (data.newQuantity === 0 && data.oldQuantity > 0) {
        // Stock was actually returned to inventory
        toast({
          title: t('quantityUpdated'),
          description: t('quantityZeroedWithReturn'),
        });
      } else if (data.newQuantity === 0) {
        // Quantity was already 0 — no stock change
        toast({
          title: t('quantityUpdated'),
          description: t('quantityNoChange'),
        });
      } else {
        toast({
          title: t('quantityUpdated'),
          description: t('quantityUpdatedDescription'),
        });
      }
      // Refetch to get updated stock levels
      utils.packing.getOrderDetails.invalidate({ orderId: order.orderId });
      onOrderUpdated();
    },
    onError: (error, variables, context) => {
      // Rollback on error
      if (context?.previousOrderDetails) {
        utils.packing.getOrderDetails.setData(
          { orderId: variables.orderId },
          context.previousOrderDetails
        );
      }
      console.error('Operation error:', error.message);
      toast({
        title: t('errorUpdatingQuantity'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  // Debounced auto-save (500ms delay after typing stops)
  const debouncedSaveNotes = useDebouncedCallback((notes: string) => {
    addPackingNotesMutation.mutate({
      orderId: order.orderId,
      notes,
    });
  }, 500);

  const toggleItemPacked = (itemSku: string) => {
    if (!orderDetails) return;

    // Find current packed state from server data
    const currentItem = orderDetails.items.find((item) => item.sku === itemSku);
    if (!currentItem) return;

    const isPacked = currentItem.packed;

    // Trigger mutation with optimistic update
    markItemPackedMutation.mutate({
      orderId: order.orderId,
      itemSku,
      packed: !isPacked,
    });
  };

  const handleMarkReady = () => {
    if (!allItemsPacked) {
      toast({
        title: t('mustCheckAllItems'),
        description: t('mustCheckAllItemsDescription'),
        variant: 'destructive',
      });
      return;
    }

    markOrderReadyMutation.mutate({
      orderId: order.orderId,
      notes: packingNotes || undefined,
    });
  };

  const handlePauseOrder = () => {
    pauseOrderMutation.mutate({
      orderId: order.orderId,
      notes: packingNotes || undefined,
    });
  };

  const handleResumeOrder = () => {
    resumeOrderMutation.mutate({
      orderId: order.orderId,
    });
  };

  const handleResetOrder = () => {
    resetOrderMutation.mutate({
      orderId: order.orderId,
      reason: 'Manual reset by packer',
    });
  };

  // Execute quantity change (with optional PIN)
  const executeQuantityChange = useCallback((productId: string, newQuantity: number, pin?: string) => {
    updateItemQuantityMutation.mutate({
      orderId: order.orderId,
      productId,
      newQuantity,
      pin,
    });
  }, [order.orderId, updateItemQuantityMutation]);

  // Handle PIN submission
  const handlePinSubmit = useCallback(async (pin: string): Promise<boolean> => {
    if (!pendingQuantityChange) return false;

    return new Promise((resolve) => {
      updateItemQuantityMutation.mutate(
        {
          orderId: order.orderId,
          productId: pendingQuantityChange.productId,
          newQuantity: pendingQuantityChange.newQuantity,
          pin,
        },
        {
          onSuccess: () => {
            setPinDialogOpen(false);
            setPendingQuantityChange(null);
            resolve(true);
          },
          onError: (error) => {
            // Check if error is PIN-related
            if (error.message === 'Invalid PIN') {
              resolve(false);
            } else {
              // For other errors, close dialog and show error toast
              setPinDialogOpen(false);
              setPendingQuantityChange(null);
              resolve(true); // Return true to prevent lockout for non-PIN errors
            }
          },
        }
      );
    });
  }, [pendingQuantityChange, order.orderId, updateItemQuantityMutation]);

  const handleQuantityChange = (productId: string, newQuantity: number, currentStock: number) => {
    if (newQuantity < 0) {
      toast({
        title: t('quantityMustBePositive'),
        variant: 'destructive',
      });
      return;
    }

    // Allow qty=0 (zeroes out the item instead of removing it)
    // Only check stock when increasing quantity above 0
    if (newQuantity > 0 && newQuantity > currentStock) {
      toast({
        title: t('insufficientStock'),
        description: t('stockAvailable', { count: currentStock }),
        variant: 'destructive',
      });
      return;
    }

    // If PIN is required, show PIN dialog
    if (isPinRequired) {
      setPendingQuantityChange({ productId, newQuantity, currentStock });
      setPinDialogOpen(true);
    } else {
      // Execute directly without PIN
      executeQuantityChange(productId, newQuantity);
    }
  };

  const handleIncrement = (productId: string, currentQuantity: number, currentStock: number) => {
    const newQuantity = currentQuantity + 1;
    if (newQuantity <= currentStock) {
      handleQuantityChange(productId, newQuantity, currentStock);
    } else {
      toast({
        title: t('insufficientStock'),
        description: t('stockAvailable', { count: currentStock }),
        variant: 'destructive',
      });
    }
  };

  const handleDecrement = (productId: string, currentQuantity: number, currentStock: number) => {
    const newQuantity = currentQuantity - 1;
    if (newQuantity >= 0) {
      handleQuantityChange(productId, newQuantity, currentStock);
    }
  };

  const startEditing = (productId: string, currentQuantity: number) => {
    setEditingItemId(productId);
    setEditQuantity(currentQuantity.toString());
  };

  const cancelEditing = () => {
    setEditingItemId(null);
    setEditQuantity('');
  };

  const submitEditedQuantity = (productId: string, currentStock: number) => {
    const newQuantity = parseFloat(editQuantity);
    if (isNaN(newQuantity) || newQuantity < 0) {
      toast({
        title: t('quantityMustBePositive'),
        variant: 'destructive',
      });
      return;
    }
    handleQuantityChange(productId, newQuantity, currentStock);
  };

  const getStockStatus = (currentStock: number, lowStockThreshold?: number): 'normal' | 'low' | 'out' => {
    if (currentStock === 0) return 'out';
    if (lowStockThreshold && currentStock <= lowStockThreshold) return 'low';
    return 'normal';
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <span className="text-sm text-muted-foreground font-medium">{t('loadingOrder')}</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!orderDetails) {
    return null;
  }

  const items = orderDetails.items || [];
  const allItemsPacked = orderDetails.allItemsPacked;
  const packedCount = items.filter((item) => item.packed).length;
  const progressPercent = items.length > 0 ? (packedCount / items.length) * 100 : 0;

  const isPaused = order.isPaused ?? false;
  const hasProgress = packedCount > 0;
  const isReadyForDelivery = orderDetails.status === 'ready_for_delivery';

  return (
    <div className={`bg-card border rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-all duration-300 ${
      isReadyForDelivery
        ? 'border-success/50 bg-success/5'
        : isPaused
          ? 'border-warning/50'
          : 'border-border hover:border-primary/40'
    }`}>
      {/* Paused Banner */}
      {isPaused && (
        <div className="bg-warning/10 border-b border-warning/30 px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PauseCircle className="h-4 w-4 text-warning" />
            <span className="text-sm font-semibold text-warning-foreground">
              {t('orderPausedBanner')}
            </span>
            {order.lastPackedBy && (
              <span className="text-xs text-muted-foreground">
                • {t('pausedBy', { name: order.lastPackedBy })}
              </span>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleResumeOrder}
            disabled={resumeOrderMutation.isPending}
            className="border-warning/50 hover:bg-warning/20"
          >
            {resumeOrderMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                <PlayCircle className="h-3.5 w-3.5 mr-1" />
                {t('resume')}
              </>
            )}
          </Button>
        </div>
      )}

      {/* Clean Header - With Sequence Badge */}
      <div className="relative">
        {/* Sequence Badge - Per-area sequence with area-colored background */}
        {(() => {
          const displaySequence = order.areaPackingSequence;
          const badgeColor = areaColorClasses[order.areaColorVariant ?? 'secondary'] ?? areaColorClasses.secondary;
          return displaySequence !== null ? (
            <div className="absolute top-0 left-0 z-10">
              <div className={`${badgeColor} text-white px-4 py-2 rounded-tl-lg rounded-br-lg shadow-lg`}>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold opacity-90">{t('packBadge')}</span>
                  <span className="text-2xl font-black tabular-nums leading-none">
                    #{displaySequence}
                  </span>
                </div>
              </div>
            </div>
          ) : null;
        })()}

        <div className="px-5 py-4 bg-gradient-to-br from-muted/30 to-background border-b border-border pt-14">
          <div className="flex items-start justify-between gap-4 mb-3">
            {/* Order Info */}
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-mono font-bold text-xl text-foreground tracking-tight">
                  {order.orderNumber}
                </h3>
                {order.mergedFromOrderNumbers && order.mergedFromOrderNumbers.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] font-medium">
                    {t('merge.mergedFromBadge', { numbers: order.mergedFromOrderNumbers.join(', ') })}
                  </Badge>
                )}
              </div>
              <p className="text-sm font-medium text-muted-foreground mt-1">{order.customerName}</p>
            </div>

            {/* Status Badge */}
            <div className="flex-shrink-0">
              <StatusBadge status={orderDetails.status as StatusType} />
            </div>
          </div>

          {/* Progress Bar */}
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs font-semibold mb-1.5">
              <span className="text-muted-foreground">{t('progress')}</span>
              <span className="text-foreground tabular-nums">
                {packedCount} / {items.length}
              </span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 rounded-full ${
                  progressPercent === 100 ? 'bg-success' : 'bg-primary'
                }`}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          {/* Delivery Instructions if present */}
          {orderDetails.deliveryAddress && orderDetails.deliveryAddress.includes('instructions') && (
            <div className="mt-3 p-2.5 bg-warning/10 border-l-4 border-warning rounded">
              <div className="flex items-start gap-2">
                <StickyNote className="h-4 w-4 text-warning mt-0.5 flex-shrink-0" />
                <div className="text-xs text-warning-foreground font-medium">
                  {orderDetails.deliveryAddress}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Items Checklist */}
      <div className="p-4 space-y-1.5">
        {items.map((item, index) => {
          const isPacked = item.packed;
          // Calculate display stock: deduct quantity when item is packed
          // When ready_for_delivery, stock has already been consumed - show actual stock
          // Only apply optimistic deduction for in-progress packing
          const displayStock = isReadyForDelivery
            ? item.currentStock
            : isPacked
              ? item.currentStock - item.quantity
              : item.currentStock;
          const stockStatus = getStockStatus(displayStock, item.lowStockThreshold);
          const isEditing = editingItemId === item.productId;
          const isUpdating = updateItemQuantityMutation.isPending &&
            updateItemQuantityMutation.variables?.productId === item.productId;

          return (
            <div
              key={item.sku}
              className={`w-full flex flex-col gap-2 p-3 rounded-md border transition-all duration-200 ${
                isPacked
                  ? 'bg-success/10 border-success/30'
                  : 'bg-background border-border hover:border-primary/30'
              }`}
              style={{
                animationDelay: `${index * 50}ms`,
                animation: 'itemSlide 0.3s ease-out',
              }}
            >
              {/* Top row: Checkbox, SKU, Stock indicator */}
              <div className="flex items-center gap-3">
                {/* Checkbox */}
                <button
                  onClick={() => !isReadyForDelivery && toggleItemPacked(item.sku)}
                  className={`flex-shrink-0 p-1 rounded transition-colors ${
                    isReadyForDelivery
                      ? 'cursor-not-allowed opacity-60'
                      : 'hover:bg-muted'
                  }`}
                  disabled={isReadyForDelivery}
                >
                  {isPacked || isReadyForDelivery ? (
                    <CheckSquare className={`h-5 w-5 transition-transform ${
                      isReadyForDelivery ? 'text-success/60' : 'text-success hover:scale-110'
                    }`} />
                  ) : (
                    <Square className="h-5 w-5 text-muted-foreground transition-transform hover:scale-110" />
                  )}
                </button>

                {/* SKU and Product Name */}
                <div className="flex-1 min-w-0">
                  <span
                    className={`font-mono font-semibold text-xs tracking-tight ${
                      isPacked ? 'text-muted-foreground line-through' : 'text-foreground'
                    }`}
                  >
                    {item.sku}
                  </span>
                  <p
                    className={`text-xs font-medium mt-0.5 truncate ${
                      isPacked ? 'text-muted-foreground line-through' : 'text-muted-foreground'
                    }`}
                  >
                    {item.productName}
                  </p>
                </div>

                {/* Stock Indicator with Tooltip */}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-1.5 flex-shrink-0 cursor-help">
                        {isUpdating ? (
                          <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
                        ) : (
                          <Package className={`h-3.5 w-3.5 ${
                            stockStatus === 'out' ? 'text-destructive' :
                            stockStatus === 'low' ? 'text-warning' :
                            'text-muted-foreground'
                          }`} />
                        )}
                        <span className={`text-xs font-medium tabular-nums ${
                          isUpdating ? 'text-muted-foreground/50' :
                          stockStatus === 'out' ? 'text-destructive' :
                          stockStatus === 'low' ? 'text-warning' :
                          'text-muted-foreground'
                        }`}>
                          {isUpdating ? t('updatingStock') : `${displayStock} ${t('currentStock')}`}
                        </span>
                        {!isUpdating && stockStatus === 'low' && (
                          <AlertTriangle className="h-3 w-3 text-warning" />
                        )}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-xs">
                      <div className="space-y-1 text-xs">
                        <p className="font-medium">{t('stockTooltip.title')}</p>
                        <div className="space-y-0.5 text-muted-foreground">
                          <p>{t('stockTooltip.warehouseStock', { count: item.currentStock })}</p>
                          <p>{t('stockTooltip.orderQuantity', { count: item.quantity })}</p>
                          <p className="font-medium text-foreground">
                            {isPacked
                              ? t('stockTooltip.packedRemainingStock', { count: displayStock })
                              : t('stockTooltip.remainingAfter', { count: item.currentStock - item.quantity })}
                          </p>
                        </div>
                        {isPacked && (
                          <p className="text-success pt-1 border-t">{t('stockTooltip.itemPacked')}</p>
                        )}
                        {!isPacked && (
                          <p className="text-muted-foreground pt-1 border-t">{t('stockTooltip.note')}</p>
                        )}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>

              {/* Bottom row: Quantity controls */}
              <div className="flex items-center justify-between pl-9">
                {isEditing ? (
                  // Edit mode: Input with save/cancel
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      value={editQuantity}
                      onChange={(e) => setEditQuantity(e.target.value)}
                      className="w-20 h-8 text-center text-sm font-bold"
                      min={0.1}
                      step={0.1}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          submitEditedQuantity(item.productId, item.currentStock);
                        } else if (e.key === 'Escape') {
                          cancelEditing();
                        }
                      }}
                    />
                    <span className="text-xs text-muted-foreground">{item.unit}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      onClick={() => submitEditedQuantity(item.productId, item.currentStock)}
                      disabled={isUpdating}
                    >
                      {isUpdating ? <Loader2 className="h-3 w-3 animate-spin" /> : t('saveQuantity')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      onClick={cancelEditing}
                      disabled={isUpdating}
                    >
                      {t('cancelEdit')}
                    </Button>
                  </div>
                ) : (
                  // View mode: Quantity with +/- buttons
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 w-7 p-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDecrement(item.productId, item.quantity, item.currentStock);
                      }}
                      disabled={isUpdating || isPacked || isReadyForDelivery}
                      title={t('decreaseQuantity')}
                    >
                      {isUpdating ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Minus className="h-3 w-3" />
                      )}
                    </Button>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isPacked && !isReadyForDelivery) {
                          startEditing(item.productId, item.quantity);
                        }
                      }}
                      className={`min-w-[60px] px-2 py-1 font-bold text-sm text-primary tabular-nums text-center rounded hover:bg-muted transition-colors ${
                        isPacked || isReadyForDelivery ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                      }`}
                      disabled={isPacked || isReadyForDelivery}
                      title={t('editQuantity')}
                    >
                      {item.quantity}
                      <span className="text-xs text-muted-foreground ml-1">{item.unit}</span>
                    </button>

                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 w-7 p-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleIncrement(item.productId, item.quantity, item.currentStock);
                      }}
                      disabled={item.quantity >= item.currentStock || isUpdating || isPacked || isReadyForDelivery}
                      title={t('increaseQuantity')}
                    >
                      {isUpdating ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Plus className="h-3 w-3" />
                      )}
                    </Button>


                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Internal Order Notes (read-only) — surfaced from Order.internalNotes
          so packers see customer-supplied / merged context that previously was
          hidden during packing. */}
      {orderDetails?.internalNotes && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-1.5 mb-1">
            <Lock className="h-3 w-3 text-muted-foreground" />
            <label className="text-xs font-semibold text-muted-foreground">
              {t('orderCard.internalNotesLabel')}
            </label>
          </div>
          <div className="px-3 py-2 bg-muted/40 border border-border rounded-md text-xs whitespace-pre-line">
            {orderDetails.internalNotes}
          </div>
        </div>
      )}

      {/* Notes Section */}
      <div className="px-4 pb-3">
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-xs font-semibold text-muted-foreground">
            {t('packingNotes')}
          </label>
          {addPackingNotesMutation.isPending && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Saving...</span>
            </div>
          )}
        </div>
        <textarea
          value={packingNotes}
          onChange={(e) => {
            if (isReadyForDelivery) return;
            const newNotes = e.target.value;
            setPackingNotes(newNotes);
            debouncedSaveNotes(newNotes);
          }}
          placeholder={t('addNotes')}
          className={`w-full px-3 py-2 border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent resize-none text-xs font-medium text-foreground placeholder:text-muted-foreground ${
            isReadyForDelivery ? 'bg-muted cursor-not-allowed opacity-60' : 'bg-background'
          }`}
          rows={2}
          disabled={isReadyForDelivery}
        />
      </div>

      {/* Action Buttons */}
      <div className="px-4 pb-4 space-y-2">
        {/* Main Action: Mark as Ready */}
        <Button
          onClick={handleMarkReady}
          disabled={!allItemsPacked || markOrderReadyMutation.isPending || isPaused || isReadyForDelivery}
          className="w-full"
          variant={allItemsPacked && !markOrderReadyMutation.isPending && !isPaused && !isReadyForDelivery ? "default" : "secondary"}
        >
          {markOrderReadyMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              {t('marking')}
            </>
          ) : (
            <>
              <Send className="h-4 w-4 mr-2" />
              {t('markAsReady')}
            </>
          )}
        </Button>

        {!allItemsPacked && !isPaused && !isReadyForDelivery && (
          <p className="text-xs text-center text-muted-foreground font-medium">
            {t('checkAllItemsFirst')}
          </p>
        )}

        {/* Secondary Actions: Pause and Reset */}
        {hasProgress && !isPaused && !isReadyForDelivery && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePauseOrder}
              disabled={pauseOrderMutation.isPending}
              className="flex-1"
            >
              {pauseOrderMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <>
                  <PauseCircle className="h-3.5 w-3.5 mr-1" />
                  {t('pauseOrder')}
                </>
              )}
            </Button>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                  {t('resetOrder')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('resetOrderTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('resetOrderDescription', {
                      packedCount: packedCount,
                      orderNumber: order.orderNumber
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleResetOrder}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {resetOrderMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      t('confirmReset')
                    )}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}

        {/* Reset only for paused orders */}
        {isPaused && (
          <div className="flex justify-center">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                  {t('resetOrder')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('resetOrderTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('resetOrderDescription', {
                      packedCount: packedCount,
                      orderNumber: order.orderNumber
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleResetOrder}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {resetOrderMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      t('confirmReset')
                    )}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}

        {/* Reset for ready_for_delivery orders - restores consumed stock */}
        {isReadyForDelivery && (
          <div className="flex justify-center">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                  {t('resetOrder')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('resetOrderTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('resetReadyOrderDescription', {
                      orderNumber: order.orderNumber
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleResetOrder}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {resetOrderMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      t('confirmReset')
                    )}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </div>

      {/* Custom Animations */}
      <style jsx>{`
        @keyframes itemSlide {
          from {
            opacity: 0;
            transform: translateX(-4px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
      `}</style>



      {/* PIN Entry Dialog */}
      <PinEntryDialog
        open={pinDialogOpen}
        onOpenChange={(open) => {
          setPinDialogOpen(open);
          if (!open) {
            setPendingQuantityChange(null);
          }
        }}
        onPinSubmit={handlePinSubmit}
        isLoading={updateItemQuantityMutation.isPending}
      />
    </div>
  );
}
