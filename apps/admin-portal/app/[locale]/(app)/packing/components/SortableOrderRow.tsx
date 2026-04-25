'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PackingOrderCard } from './PackingOrderCard';

interface SortableOrderRowProps {
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
    isPaused?: boolean;
    lastPackedBy?: string | null;
    lastPackedAt?: Date | null;
    packedItemsCount?: number;
    totalItemsCount?: number;
  };
  onOrderUpdated: () => void;
  disabled?: boolean;
}

export function SortableOrderRow({ order, onOrderUpdated, disabled }: SortableOrderRowProps) {
  const t = useTranslations('packing');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: order.orderId,
    disabled,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="relative flex items-stretch gap-2">
      <button
        type="button"
        aria-label={t('dragToReorder')}
        title={t('dragToReorder')}
        className={
          disabled
            ? 'flex items-center justify-center px-1 text-muted-foreground/40 cursor-not-allowed'
            : 'flex items-center justify-center px-1 text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none'
        }
        {...(disabled ? {} : attributes)}
        {...(disabled ? {} : listeners)}
        disabled={disabled}
      >
        <GripVertical className="h-5 w-5" />
      </button>
      <div className="flex-1 min-w-0">
        <PackingOrderCard order={order} onOrderUpdated={onOrderUpdated} />
      </div>
    </div>
  );
}
