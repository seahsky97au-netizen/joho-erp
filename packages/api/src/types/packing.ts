/**
 * Packing Interface Type Definitions
 * Types for the order packing module
 */

export interface PackingSessionSummary {
  deliveryDate: Date;
  orders: PackingOrder[];
  productSummary: ProductSummaryItem[];
}

export interface PackingOrderArea {
  id: string;
  name: string;
  displayName: string;
  colorVariant: string;
}

export interface PackingOrder {
  orderId: string;
  orderNumber: string;
  customerName: string;
  area: PackingOrderArea | null; // Can be null if area is unassigned
}

/**
 * Extended PackingOrder with progress and sequence information
 * Returned by getOptimizedSession
 */
export interface PackingOrderWithProgress extends PackingOrder {
  packingSequence: number | null;
  deliverySequence: number | null;
  status: string;
  packedItemsCount: number;
  totalItemsCount: number;
  // Partial progress persistence fields
  isPaused: boolean;
  lastPackedBy: string | null;
  lastPackedAt: Date | null;
}

export interface ProductSummaryItem {
  productId: string;
  sku: string;
  productName: string;
  category: 'Beef' | 'Pork' | 'Chicken' | 'Lamb' | 'Processed' | null;
  unit: string;
  totalQuantity: number;
  orders: {
    orderNumber: string;
    quantity: number;
    status: 'confirmed' | 'packing' | 'ready_for_delivery';
  }[];
}

export interface PackingOrderCard {
  orderId: string;
  orderNumber: string;
  customerName: string;
  deliveryAddress: string;
  area: PackingOrderArea | null; // Can be null if area is unassigned
  items: PackingOrderItem[];
  status: 'confirmed' | 'packing' | 'ready_for_delivery';
  allItemsPacked: boolean;
  packingNotes?: string;
  internalNotes?: string | null;
  mergedFromOrderNumbers?: string[];
}

export interface PackingOrderItem {
  productId: string;
  sku: string;
  productName: string;
  quantity: number;
  packed: boolean;
  unit: string;
  unitPrice: number; // in cents
  currentStock: number;
  lowStockThreshold?: number;
}
