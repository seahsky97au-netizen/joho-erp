// Marker style constants and utilities

export const MARKER_SIZES = {
  warehouse: 48,
  deliveryActive: 36,
  deliveryCompleted: 28,
  deliveryPending: 32,
} as const;

export const MARKER_COLORS = {
  warehouse: '#3B82F6', // blue-600
  pending: '#EAB308', // yellow-500
  active: '#F97316', // orange-500
  completed: '#16A34A', // green-600
  priority: '#EF4444', // red-500
} as const;

export type DeliveryStatus = 'ready_for_delivery' | 'delivered' | 'pending';

export const getStatusColor = (status: string): string => {
  switch (status) {
    case 'ready_for_delivery':
      return MARKER_COLORS.active;
    case 'delivered':
      return MARKER_COLORS.completed;
    default:
      return MARKER_COLORS.pending;
  }
};

export const getStatusSize = (status: string): number => {
  switch (status) {
    case 'delivered':
      return MARKER_SIZES.deliveryCompleted;
    case 'ready_for_delivery':
      return MARKER_SIZES.deliveryActive;
    default:
      return MARKER_SIZES.deliveryPending;
  }
};

export const AREA_VARIANT_COLORS: Record<string, string> = {
  info: '#0EA5E9',      // blue (matches --info: 199 89% 48%)
  success: '#22C55E',   // green (matches --success: 142 71% 45%)
  warning: '#F59E0B',   // amber (matches --warning: 38 92% 50%)
  gray: '#9CA3AF',      // gray-400
  secondary: '#8B5CF6', // violet (used as "purple" in area settings)
  default: '#E8553D',   // coral (matches --primary: 6 78% 57%)
};

export const getAreaColor = (colorVariant: string | null | undefined): string | null => {
  if (!colorVariant) return null;
  return AREA_VARIANT_COLORS[colorVariant] ?? null;
};

export const STATUS_RING_COLORS = {
  ready_for_delivery: '#F97316', // orange
  delivered: '#16A34A',          // green
  pending: '#EAB308',            // yellow
} as const;

export const getStatusRingColor = (status: string): string => {
  if (status === 'ready_for_delivery') return STATUS_RING_COLORS.ready_for_delivery;
  if (status === 'delivered') return STATUS_RING_COLORS.delivered;
  return STATUS_RING_COLORS.pending;
};

export const pulseAnimation = `
  @keyframes pulse-marker {
    0%, 100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.7;
      transform: scale(1.05);
    }
  }
`;
