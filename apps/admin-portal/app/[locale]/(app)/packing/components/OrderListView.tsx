'use client';

import { useEffect, useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Package2, PauseCircle, Truck } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { PackingOrderCard } from './PackingOrderCard';
import { SortableOrderRow } from './SortableOrderRow';
import { AreaLabelFilter } from './AreaLabelFilter';
import { Card, CardContent, Button, Badge, useToast } from '@joho-erp/ui';
import { useHasPermission } from '@/components/permission-provider';
import { api } from '@/trpc/client';

interface OrderListViewProps {
  orders: Array<{
    orderId: string;
    orderNumber: string;
    customerName: string;
    areaName: string | null;
    areaPackingSequence: number | null;
    areaColorVariant?: string;
    areaDisplayName?: string;
    areaSortOrder?: number;
    deliverySequence: number | null;
    status: string;
    // Partial progress fields
    isPaused?: boolean;
    lastPackedBy?: string | null;
    lastPackedAt?: Date | null;
    packedItemsCount?: number;
    totalItemsCount?: number;
  }>;
  deliveryDate: Date;
  onOrderUpdated: () => void;
  focusedOrderNumber?: string | null;
  onClearFocus?: () => void;
  areaId?: string;
  onAreaChange?: (areaId: string) => void;
}

// Group orders by area for per-area packing sequences
interface AreaGroup {
  areaName: string | null;
  areaDisplayName: string;
  areaColorVariant: string;
  areaSortOrder: number;
  orders: OrderListViewProps['orders'];
}

export function OrderListView({
  orders,
  deliveryDate,
  onOrderUpdated,
  focusedOrderNumber,
  onClearFocus,
  areaId = '',
  onAreaChange
}: OrderListViewProps) {
  const t = useTranslations('packing');
  const tErrors = useTranslations('errors');
  const { toast } = useToast();
  const canManagePacking = useHasPermission('packing:manage');
  const reorderAreaMutation = api.packing.reorderArea.useMutation();

  // Memoize the clear focus callback to avoid unnecessary effect re-runs
  const stableClearFocus = useCallback(() => {
    onClearFocus?.();
  }, [onClearFocus]);

  // Handle scrolling to and highlighting focused order
  useEffect(() => {
    if (!focusedOrderNumber) return;

    // Check if order is in current list - if not in view but we have an area filter, reset it
    const orderInOrders = orders.some(o => o.orderNumber === focusedOrderNumber);

    if (!orderInOrders && areaId && onAreaChange) {
      // Order might be filtered out by area - reset area filter to show all
      onAreaChange('');
      // Let the retry mechanism handle finding the element after the filter resets
    }

    let attempts = 0;
    const maxAttempts = 10;
    const retryInterval = 100;
    let scrollTimer: NodeJS.Timeout | null = null;
    let highlightTimer: NodeJS.Timeout | null = null;

    const attemptScroll = () => {
      const element = document.getElementById(`order-card-${focusedOrderNumber}`);

      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.classList.add('order-card-highlight');

        highlightTimer = setTimeout(() => {
          element.classList.remove('order-card-highlight');
          stableClearFocus();
        }, 1500);
      } else if (attempts < maxAttempts) {
        attempts++;
        scrollTimer = setTimeout(attemptScroll, retryInterval);
      } else {
        // Max attempts reached, clear focus to avoid stuck state
        stableClearFocus();
      }
    };

    // Initial delay to allow for any pending renders
    scrollTimer = setTimeout(attemptScroll, 100);

    return () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      if (highlightTimer) clearTimeout(highlightTimer);
    };
  }, [focusedOrderNumber, orders, areaId, onAreaChange, stableClearFocus]);

  // Sort orders: move ready_for_delivery orders to the bottom
  const sortedOrders = useMemo(() => [...orders].sort((a, b) => {
    if (a.status === 'ready_for_delivery' && b.status !== 'ready_for_delivery') return 1;
    if (a.status !== 'ready_for_delivery' && b.status === 'ready_for_delivery') return -1;
    return 0; // Preserve original order for same status
  }), [orders]);

  // Group orders by area for per-area packing sequences
  const areaGroups = useMemo<AreaGroup[]>(() => {
    const groupMap = new Map<string | null, AreaGroup>();

    for (const order of sortedOrders) {
      const areaName = order.areaName ?? null;
      const areaDisplayName = order.areaDisplayName ?? 'Unassigned';
      const areaColorVariant = order.areaColorVariant ?? 'secondary';
      const areaSortOrder = order.areaSortOrder ?? 999;

      if (!groupMap.has(areaName)) {
        groupMap.set(areaName, {
          areaName,
          areaDisplayName,
          areaColorVariant,
          areaSortOrder,
          orders: [],
        });
      }
      groupMap.get(areaName)!.orders.push(order);
    }

    // Convert to array and sort by areaSortOrder, unassigned last
    const groups = Array.from(groupMap.values());
    return groups.sort((a, b) => {
      // Unassigned (null) goes last
      if (a.areaName === null && b.areaName !== null) return 1;
      if (a.areaName !== null && b.areaName === null) return -1;
      // Sort by configured sortOrder
      return a.areaSortOrder - b.areaSortOrder;
    });
  }, [sortedOrders]);

  // Check if we have multiple areas (need to show grouping)
  const hasMultipleAreas = areaGroups.length > 1 || (areaGroups.length === 1 && areaGroups[0].areaName !== null);

  // Drag-and-drop is only enabled when a single area is selected via the
  // filter and the user has packing:manage permission.
  const dndEnabled = Boolean(areaId) && canManagePacking;

  // Local optimistic ordering for the active (non-ready_for_delivery) orders.
  // Tracks orderIds for the active group so drag-and-drop feels instant.
  const [optimisticOrderIds, setOptimisticOrderIds] = useState<string[] | null>(null);

  // Active orders that can be reordered (status confirmed/packing) — preserves
  // server order initially, replaced by optimisticOrderIds during a drag.
  const { activeOrders, lockedOrders } = useMemo(() => {
    const active = sortedOrders.filter((o) => o.status !== 'ready_for_delivery');
    const locked = sortedOrders.filter((o) => o.status === 'ready_for_delivery');
    if (optimisticOrderIds) {
      const byId = new Map(active.map((o) => [o.orderId, o]));
      const reordered = optimisticOrderIds
        .map((id) => byId.get(id))
        .filter((o): o is (typeof active)[number] => Boolean(o));
      // Append any new orders that arrived after the optimistic snapshot.
      for (const o of active) {
        if (!optimisticOrderIds.includes(o.orderId)) reordered.push(o);
      }
      return { activeOrders: reordered, lockedOrders: locked };
    }
    return { activeOrders: active, lockedOrders: locked };
  }, [sortedOrders, optimisticOrderIds]);

  // Reset optimistic state when the underlying server order or area changes.
  const sortedOrdersFingerprint = useMemo(
    () => sortedOrders.map((o) => `${o.orderId}:${o.areaPackingSequence}`).join('|'),
    [sortedOrders]
  );
  useEffect(() => {
    setOptimisticOrderIds(null);
  }, [areaId, sortedOrdersFingerprint]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      if (!areaId) return;

      const oldIndex = activeOrders.findIndex((o) => o.orderId === active.id);
      const newIndex = activeOrders.findIndex((o) => o.orderId === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(activeOrders, oldIndex, newIndex);
      const reorderedIds = reordered.map((o) => o.orderId);
      setOptimisticOrderIds(reorderedIds);

      try {
        await reorderAreaMutation.mutateAsync({
          deliveryDate: deliveryDate.toISOString(),
          areaId,
          orderIdsInOrder: reorderedIds,
        });
        toast({ title: t('areaSequenceUpdated') });
        onOrderUpdated();
      } catch (error) {
        setOptimisticOrderIds(null);
        toast({
          title: tErrors('operationFailed'),
          description: error instanceof Error ? error.message : undefined,
          variant: 'destructive',
        });
        onOrderUpdated();
      }
    },
    [activeOrders, areaId, deliveryDate, onOrderUpdated, reorderAreaMutation, t, tErrors, toast]
  );

  if (orders.length === 0) {
    return (
      <Card>
        <CardContent className="p-12 text-center border-2 border-dashed">
          <Package2 className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground font-medium">{t('noOrders')}</p>
        </CardContent>
      </Card>
    );
  }

  // When DnD is enabled (single area selected + permission), we render a
  // single sortable list of the area's active orders, with any
  // ready_for_delivery orders shown below as a non-draggable section.
  if (dndEnabled) {
    return (
      <div className="space-y-4">
        {onAreaChange && (
          <AreaLabelFilter
            selectedAreaId={areaId}
            onAreaChange={onAreaChange}
          />
        )}

        <div className="flex items-center justify-between px-2">
          <div className="flex items-center gap-3">
            <p className="text-xs font-semibold text-muted-foreground">
              {sortedOrders.length} {sortedOrders.length === 1 ? t('order') : t('orders')}
            </p>
            {sortedOrders.filter(o => o.isPaused).length > 0 && (
              <Badge variant="outline" className="border-warning/50 text-warning-foreground bg-warning/10">
                <PauseCircle className="h-3 w-3 mr-1" />
                {sortedOrders.filter(o => o.isPaused).length} {t('paused')}
              </Badge>
            )}
            {sortedOrders.filter(o => (o.packedItemsCount ?? 0) > 0 && !o.isPaused).length > 0 && (
              <Badge variant="outline" className="border-primary/50 text-primary bg-primary/10">
                {sortedOrders.filter(o => (o.packedItemsCount ?? 0) > 0 && !o.isPaused).length} {t('inProgress')}
              </Badge>
            )}
          </div>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={activeOrders.map((o) => o.orderId)} strategy={verticalListSortingStrategy}>
            <div className="space-y-3">
              {activeOrders.map((order, index) => (
                <div
                  key={order.orderId}
                  id={`order-card-${order.orderNumber}`}
                  style={{
                    animationDelay: `${index * 50}ms`,
                    animation: 'orderFadeIn 0.4s ease-out',
                  }}
                >
                  <SortableOrderRow order={order} onOrderUpdated={onOrderUpdated} />
                </div>
              ))}
            </div>
          </SortableContext>
        </DndContext>

        {lockedOrders.length > 0 && (
          <div className="space-y-3 pt-2">
            <div className="flex items-center gap-2 px-2 py-2 bg-muted/30 rounded-lg">
              <Truck className="h-4 w-4 text-muted-foreground" />
              <span className="font-semibold text-sm text-muted-foreground">
                {t('readyForDeliverySection')}
              </span>
              <Badge variant="secondary" className="ml-auto">
                {lockedOrders.length}
              </Badge>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {lockedOrders.map((order) => (
                <div key={order.orderId} id={`order-card-${order.orderNumber}`}>
                  <PackingOrderCard order={order} onOrderUpdated={onOrderUpdated} />
                </div>
              ))}
            </div>
          </div>
        )}

        <style jsx global>{packingAnimations}</style>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Area Label Filter */}
      {onAreaChange && (
        <AreaLabelFilter
          selectedAreaId={areaId}
          onAreaChange={onAreaChange}
        />
      )}

      {/* Hint when multiple areas visible: select one to enable reordering */}
      {canManagePacking && !areaId && hasMultipleAreas && (
        <p className="text-xs text-muted-foreground px-2">{t('reorderSelectAreaHint')}</p>
      )}

      {/* Orders Count with Paused Indicator */}
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-3">
          <p className="text-xs font-semibold text-muted-foreground">
            {sortedOrders.length} {sortedOrders.length === 1 ? t('order') : t('orders')}
          </p>
          {/* Show paused orders count */}
          {sortedOrders.filter(o => o.isPaused).length > 0 && (
            <Badge variant="outline" className="border-warning/50 text-warning-foreground bg-warning/10">
              <PauseCircle className="h-3 w-3 mr-1" />
              {sortedOrders.filter(o => o.isPaused).length} {t('paused')}
            </Badge>
          )}
          {/* Show orders with progress */}
          {sortedOrders.filter(o => (o.packedItemsCount ?? 0) > 0 && !o.isPaused).length > 0 && (
            <Badge variant="outline" className="border-primary/50 text-primary bg-primary/10">
              {sortedOrders.filter(o => (o.packedItemsCount ?? 0) > 0 && !o.isPaused).length} {t('inProgress')}
            </Badge>
          )}
        </div>
      </div>

      {/* Orders grouped by area (or flat list if single/no area) */}
      {hasMultipleAreas ? (
        <div className="space-y-6">
          {areaGroups.map((group) => (
            <div key={group.areaName ?? 'unassigned'} className="space-y-3">
              {/* Area Header */}
              <div className="flex items-center gap-2 px-2 py-2 bg-muted/50 rounded-lg">
                <Truck className="h-4 w-4 text-muted-foreground" />
                <span className="font-semibold text-sm">
                  {group.areaDisplayName}
                </span>
                <Badge variant="secondary" className="ml-auto">
                  {group.orders.length} {group.orders.length === 1 ? t('order') : t('orders')}
                </Badge>
              </div>
              {/* 2-Column Grid Layout for Area's Orders */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {group.orders.map((order, index) => (
                  <div
                    key={order.orderId}
                    id={`order-card-${order.orderNumber}`}
                    style={{
                      animationDelay: `${index * 50}ms`,
                      animation: 'orderFadeIn 0.4s ease-out',
                    }}
                  >
                    <PackingOrderCard order={order} onOrderUpdated={onOrderUpdated} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* Flat list when no area grouping needed */
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {sortedOrders.map((order, index) => (
            <div
              key={order.orderId}
              id={`order-card-${order.orderNumber}`}
              style={{
                animationDelay: `${index * 50}ms`,
                animation: 'orderFadeIn 0.4s ease-out',
              }}
            >
              <PackingOrderCard order={order} onOrderUpdated={onOrderUpdated} />
            </div>
          ))}
        </div>
      )}

      {/* Empty State for Filter */}
      {sortedOrders.length === 0 && areaId && onAreaChange && (
        <Card>
          <CardContent className="p-12 text-center border-2 border-dashed">
            <Package2 className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground font-medium">{t('noOrdersForArea')}</p>
            <Button
              onClick={() => onAreaChange('')}
              className="mt-4"
            >
              {t('showAllAreas')}
            </Button>
          </CardContent>
        </Card>
      )}

      <style jsx global>{packingAnimations}</style>
    </div>
  );
}

const packingAnimations = `
  @keyframes orderFadeIn {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes orderHighlightPulse {
    0%, 100% {
      box-shadow: 0 0 0 0 transparent;
      background-color: transparent;
      border-color: transparent;
      transform: scale(1);
    }
    25%, 75% {
      box-shadow: 0 0 0 4px hsl(var(--primary) / 0.4);
      background-color: hsl(var(--primary) / 0.08);
      border-color: hsl(var(--primary) / 0.6);
      transform: scale(1.01);
    }
    50% {
      box-shadow: 0 0 0 6px hsl(var(--primary) / 0.3);
      background-color: hsl(var(--primary) / 0.12);
      border-color: hsl(var(--primary));
      transform: scale(1.02);
    }
  }

  .order-card-highlight {
    animation: orderHighlightPulse 2s ease-in-out;
    border-radius: 0.5rem;
    border: 2px solid transparent;
  }
`;
