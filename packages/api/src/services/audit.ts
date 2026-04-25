/**
 * Audit Trail Logging Service
 *
 * This service provides centralized audit logging for tracking
 * changes to business entities across the system.
 */

import { prisma } from '@joho-erp/database';
import type { AuditAction } from '@joho-erp/database';

// ============================================================================
// TYPES
// ============================================================================

export interface AuditLogParams {
  userId: string;
  userEmail?: string;
  userRole?: string;
  userName?: string | null;
  action: AuditAction;
  entity: string;
  entityId?: string;
  changes?: AuditChange[];
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

// ============================================================================
// MAIN FUNCTIONS
// ============================================================================

/**
 * Create an audit log entry
 */
export async function createAuditLog(params: AuditLogParams): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        userEmail: params.userEmail,
        userRole: params.userRole,
        userName: params.userName,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId,
        changes: params.changes ? JSON.parse(JSON.stringify(params.changes)) : undefined,
        metadata: params.metadata ? JSON.parse(JSON.stringify(params.metadata)) : undefined,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        timestamp: new Date(),
      },
    });
  } catch (error) {
    // Log the error but don't throw - audit logging should not block business operations
    console.error('Failed to create audit log:', error);
  }
}

/**
 * Log order creation
 */
export async function logOrderCreated(
  userId: string,
  orderId: string,
  orderNumber: string,
  customerId: string,
  totalAmount: number
): Promise<void> {
  await createAuditLog({
    userId,
    action: 'create',
    entity: 'order',
    entityId: orderId,
    metadata: {
      orderNumber,
      customerId,
      totalAmount,
    },
  });
}

/**
 * Log order status change
 */
export async function logOrderStatusChange(
  userId: string,
  orderId: string,
  orderNumber: string,
  oldStatus: string,
  newStatus: string,
  reason?: string,
  userEmail?: string,
  userName?: string | null,
  userRole?: string
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userName,
    userRole,
    action: 'update',
    entity: 'order',
    entityId: orderId,
    changes: [
      {
        field: 'status',
        oldValue: oldStatus,
        newValue: newStatus,
      },
    ],
    metadata: {
      orderNumber,
      reason,
    },
  });
}

/**
 * Log order cancellation
 */
export async function logOrderCancellation(
  userId: string,
  orderId: string,
  orderNumber: string,
  reason: string,
  previousStatus: string
): Promise<void> {
  await createAuditLog({
    userId,
    action: 'update',
    entity: 'order',
    entityId: orderId,
    changes: [
      {
        field: 'status',
        oldValue: previousStatus,
        newValue: 'cancelled',
      },
    ],
    metadata: {
      orderNumber,
      cancellationReason: reason,
    },
  });
}

/**
 * Log backorder approval
 */
export async function logBackorderApproval(
  userId: string,
  orderId: string,
  orderNumber: string,
  approvalType: 'full' | 'partial',
  approvedQuantities?: Record<string, number>
): Promise<void> {
  await createAuditLog({
    userId,
    action: 'approve',
    entity: 'order',
    entityId: orderId,
    metadata: {
      orderNumber,
      approvalType,
      approvedQuantities,
    },
  });
}

/**
 * Log backorder rejection
 */
export async function logBackorderRejection(
  userId: string,
  orderId: string,
  orderNumber: string,
  reason: string
): Promise<void> {
  await createAuditLog({
    userId,
    action: 'reject',
    entity: 'order',
    entityId: orderId,
    metadata: {
      orderNumber,
      rejectionReason: reason,
    },
  });
}

/**
 * Log credit approval
 */
export async function logCreditApproval(
  userId: string,
  customerId: string,
  customerName: string,
  creditLimit: number,
  paymentTerms?: string
): Promise<void> {
  await createAuditLog({
    userId,
    action: 'approve',
    entity: 'customer',
    entityId: customerId,
    metadata: {
      customerName,
      creditLimit,
      paymentTerms,
      type: 'credit_application',
    },
  });
}

/**
 * Log credit rejection
 */
export async function logCreditRejection(
  userId: string,
  customerId: string,
  customerName: string,
  reason?: string
): Promise<void> {
  await createAuditLog({
    userId,
    action: 'reject',
    entity: 'customer',
    entityId: customerId,
    metadata: {
      customerName,
      rejectionReason: reason,
      type: 'credit_application',
    },
  });
}

/**
 * Log pricing change
 */
export async function logPricingChange(
  userId: string,
  pricingId: string,
  customerId: string,
  productId: string,
  oldPrice: number | null,
  newPrice: number,
  action: 'create' | 'update' | 'delete'
): Promise<void> {
  await createAuditLog({
    userId,
    action,
    entity: 'customer_pricing',
    entityId: pricingId,
    changes:
      action === 'update'
        ? [
            {
              field: 'customPrice',
              oldValue: oldPrice,
              newValue: newPrice,
            },
          ]
        : undefined,
    metadata: {
      customerId,
      productId,
      newPrice,
    },
  });
}

/**
 * Log customer registration
 */
export async function logCustomerRegistration(
  userId: string,
  customerId: string,
  businessName: string,
  abn: string
): Promise<void> {
  await createAuditLog({
    userId,
    action: 'create',
    entity: 'customer',
    entityId: customerId,
    metadata: {
      businessName,
      abn,
      type: 'registration',
    },
  });
}

/**
 * Log customer profile update
 */
export async function logCustomerProfileUpdate(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  customerId: string,
  customerName: string,
  changes: AuditChange[]
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'customer',
    entityId: customerId,
    changes,
    metadata: {
      customerName,
      type: 'profile_update',
    },
  });
}

/**
 * Log customer creation by admin
 */
export async function logCustomerCreatedByAdmin(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  customerId: string,
  businessName: string,
  abn: string
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'create',
    entity: 'customer',
    entityId: customerId,
    metadata: {
      businessName,
      abn,
      type: 'admin_created',
    },
  });
}

/**
 * Log product creation
 */
export async function logProductCreated(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  productId: string,
  sku: string,
  productName: string,
  basePrice: number
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'create',
    entity: 'product',
    entityId: productId,
    metadata: {
      sku,
      productName,
      basePrice,
    },
  });
}

/**
 * Log product update
 */
export async function logProductUpdated(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  productId: string,
  sku: string,
  changes: AuditChange[]
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'product',
    entityId: productId,
    changes,
    metadata: {
      sku,
    },
  });
}

/**
 * Log pricing change with user info
 */
export async function logPricingChangeWithUser(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  pricingId: string,
  customerId: string,
  productId: string,
  oldPrice: number | null,
  newPrice: number,
  action: 'create' | 'update' | 'delete',
  notes?: string
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action,
    entity: 'customer_pricing',
    entityId: pricingId,
    changes:
      action === 'update'
        ? [
            {
              field: 'customPrice',
              oldValue: oldPrice,
              newValue: newPrice,
            },
          ]
        : undefined,
    metadata: {
      customerId,
      productId,
      newPrice,
      notes,
    },
  });
}

/**
 * Log bulk pricing import
 */
export async function logBulkPricingImport(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  importCount: number,
  successCount: number,
  errorCount: number
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'create',
    entity: 'customer_pricing',
    metadata: {
      type: 'bulk_import',
      importCount,
      successCount,
      errorCount,
    },
  });
}

// ============================================================================
// PERMISSION DOMAIN - CRITICAL SECURITY
// ============================================================================

/**
 * Log single permission toggle
 */
export async function logPermissionToggle(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  metadata: {
    targetRole: string;
    permissionCode: string;
    enabled: boolean;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'permission',
    changes: [
      {
        field: metadata.permissionCode,
        oldValue: !metadata.enabled,
        newValue: metadata.enabled,
      },
    ],
    metadata: {
      targetRole: metadata.targetRole,
      permissionCode: metadata.permissionCode,
      action: metadata.enabled ? 'grant' : 'revoke',
    },
  });
}

/**
 * Log bulk permission update for a role
 */
export async function logBulkPermissionUpdate(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  metadata: {
    targetRole: string;
    permissionsGranted: string[];
    permissionsRevoked: string[];
    totalPermissions: number;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'permission',
    metadata: {
      targetRole: metadata.targetRole,
      permissionsGranted: metadata.permissionsGranted,
      permissionsRevoked: metadata.permissionsRevoked,
      totalPermissions: metadata.totalPermissions,
      type: 'bulk_update',
    },
  });
}

/**
 * Log role permission reset to defaults
 */
export async function logRolePermissionReset(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  metadata: {
    targetRole: string;
    previousPermissions: string[];
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'permission',
    metadata: {
      targetRole: metadata.targetRole,
      previousPermissions: metadata.previousPermissions,
      type: 'reset_to_defaults',
    },
  });
}

// ============================================================================
// USER DOMAIN - CRITICAL SECURITY
// ============================================================================

/**
 * Log user role change
 */
export async function logUserRoleChange(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  targetUserId: string,
  metadata: {
    targetUserEmail: string;
    oldRole: string;
    newRole: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'user',
    entityId: targetUserId,
    changes: [
      {
        field: 'role',
        oldValue: metadata.oldRole,
        newValue: metadata.newRole,
      },
    ],
    metadata: {
      targetUserEmail: metadata.targetUserEmail,
      type: 'role_change',
    },
  });
}

/**
 * Log user status change (deactivate/activate)
 */
export async function logUserStatusChange(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  targetUserId: string,
  metadata: {
    targetUserEmail: string;
    action: 'deactivate' | 'activate';
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'user',
    entityId: targetUserId,
    changes: [
      {
        field: 'status',
        oldValue: metadata.action === 'deactivate' ? 'active' : 'inactive',
        newValue: metadata.action === 'deactivate' ? 'inactive' : 'active',
      },
    ],
    metadata: {
      targetUserEmail: metadata.targetUserEmail,
      type: metadata.action,
    },
  });
}

/**
 * Log user invitation
 */
export async function logUserInvitation(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  metadata: {
    invitedEmail: string;
    invitedRole: string;
    invitationId: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'create',
    entity: 'user_invitation',
    // entityId omitted - Clerk invitation IDs are not valid MongoDB ObjectIDs
    metadata: {
      invitationId: metadata.invitationId,
      invitedEmail: metadata.invitedEmail,
      invitedRole: metadata.invitedRole,
      type: 'invitation_sent',
    },
  });
}

/**
 * Log invitation revocation
 */
export async function logInvitationRevoke(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  metadata: {
    invitationId: string;
    revokedEmail: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'delete',
    entity: 'user_invitation',
    // entityId omitted - Clerk invitation IDs are not valid MongoDB ObjectIDs
    metadata: {
      invitationId: metadata.invitationId,
      revokedEmail: metadata.revokedEmail,
      type: 'invitation_revoked',
    },
  });
}

// ============================================================================
// COMPANY DOMAIN - CRITICAL SECURITY
// ============================================================================

/**
 * Log company profile update
 */
export async function logCompanyProfileUpdate(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  companyId: string,
  changes: AuditChange[],
  metadata: {
    businessName: string;
    changeType: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'company',
    entityId: companyId,
    changes,
    metadata: {
      businessName: metadata.businessName,
      changeType: metadata.changeType,
    },
  });
}

/**
 * Log company logo update
 */
export async function logCompanyLogoUpdate(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  companyId: string,
  metadata: {
    previousLogoUrl?: string;
    newLogoUrl: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'company',
    entityId: companyId,
    changes: [
      {
        field: 'logoUrl',
        oldValue: metadata.previousLogoUrl,
        newValue: metadata.newLogoUrl,
      },
    ],
    metadata: {
      type: 'logo_update',
    },
  });
}

/**
 * Log Xero settings update or disconnect
 */
export async function logXeroSettingsUpdate(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  companyId: string,
  metadata: {
    action: 'update' | 'disconnect';
    fieldsChanged?: string[];
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: metadata.action === 'disconnect' ? 'delete' : 'update',
    entity: 'company_xero_settings',
    entityId: companyId,
    metadata: {
      action: metadata.action,
      fieldsChanged: metadata.fieldsChanged,
      type: metadata.action === 'disconnect' ? 'xero_disconnect' : 'xero_settings_update',
    },
  });
}

/**
 * Log packing PIN update
 */
export async function logPackingPinUpdate(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  companyId: string,
  metadata: {
    pinChanged: boolean;
    pinEnabled?: boolean;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'company_packing_settings',
    entityId: companyId,
    metadata: {
      pinChanged: metadata.pinChanged,
      pinEnabled: metadata.pinEnabled,
      type: 'packing_pin_update',
    },
  });
}

/**
 * Log delivery settings update
 */
export async function logDeliverySettingsUpdate(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  companyId: string,
  changes: AuditChange[],
  metadata: {
    zonesAffected?: string[];
    settingType: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'company_delivery_settings',
    entityId: companyId,
    changes,
    metadata: {
      zonesAffected: metadata.zonesAffected,
      settingType: metadata.settingType,
      type: 'delivery_settings_update',
    },
  });
}

// ============================================================================
// DELIVERY DOMAIN - HIGH PRIORITY
// ============================================================================

/**
 * Log driver assignment to order
 */
export async function logDriverAssignment(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  orderId: string,
  metadata: {
    orderNumber: string;
    driverId: string;
    driverName: string;
    previousDriverId?: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'order',
    entityId: orderId,
    changes: [
      {
        field: 'driverId',
        oldValue: metadata.previousDriverId,
        newValue: metadata.driverId,
      },
    ],
    metadata: {
      orderNumber: metadata.orderNumber,
      driverName: metadata.driverName,
      type: 'driver_assignment',
    },
  });
}

/**
 * Log delivery status change
 */
export async function logDeliveryStatusChange(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  orderId: string,
  metadata: {
    orderNumber: string;
    oldStatus: string;
    newStatus: string;
    driverId?: string;
    notes?: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'order',
    entityId: orderId,
    changes: [
      {
        field: 'deliveryStatus',
        oldValue: metadata.oldStatus,
        newValue: metadata.newStatus,
      },
    ],
    metadata: {
      orderNumber: metadata.orderNumber,
      driverId: metadata.driverId,
      notes: metadata.notes,
      type: 'delivery_status_change',
    },
  });
}

/**
 * Log proof of delivery upload
 */
export async function logProofOfDeliveryUpload(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  orderId: string,
  metadata: {
    orderNumber: string;
    fileUrl: string;
    uploadType: 'signature' | 'photo';
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'create',
    entity: 'proof_of_delivery',
    entityId: orderId,
    metadata: {
      orderNumber: metadata.orderNumber,
      fileUrl: metadata.fileUrl,
      uploadType: metadata.uploadType,
      type: 'pod_upload',
    },
  });
}

/**
 * Log return to warehouse
 */
export async function logReturnToWarehouse(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  orderId: string,
  metadata: {
    orderNumber: string;
    reason: string;
    driverId: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'order',
    entityId: orderId,
    metadata: {
      orderNumber: metadata.orderNumber,
      reason: metadata.reason,
      driverId: metadata.driverId,
      type: 'return_to_warehouse',
    },
  });
}

// ============================================================================
// ORDER DOMAIN - ADDITIONAL HELPERS
// ============================================================================

/**
 * Log order confirmation
 */
export async function logOrderConfirmation(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  orderId: string,
  metadata: {
    orderNumber: string;
    customerId: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'approve',
    entity: 'order',
    entityId: orderId,
    metadata: {
      orderNumber: metadata.orderNumber,
      customerId: metadata.customerId,
      type: 'order_confirmation',
    },
  });
}

/**
 * Log reorder action
 */
export async function logReorder(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  newOrderId: string,
  metadata: {
    originalOrderId: string;
    originalOrderNumber: string;
    newOrderNumber: string;
    customerId: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'create',
    entity: 'order',
    entityId: newOrderId,
    metadata: {
      originalOrderId: metadata.originalOrderId,
      originalOrderNumber: metadata.originalOrderNumber,
      newOrderNumber: metadata.newOrderNumber,
      customerId: metadata.customerId,
      type: 'reorder',
    },
  });
}

/**
 * Log resend confirmation email
 */
export async function logResendConfirmation(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  orderId: string,
  metadata: {
    orderNumber: string;
    recipientEmail: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'order',
    entityId: orderId,
    metadata: {
      orderNumber: metadata.orderNumber,
      recipientEmail: metadata.recipientEmail,
      type: 'resend_confirmation',
    },
  });
}

// ============================================================================
// PRODUCT DOMAIN - ADDITIONAL HELPERS
// ============================================================================

/**
 * Log stock adjustment
 */
export async function logStockAdjustment(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  productId: string,
  metadata: {
    sku: string;
    adjustmentType: string;
    previousStock: number;
    newStock: number;
    quantity: number;
    notes?: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'product',
    entityId: productId,
    changes: [
      {
        field: 'currentStock',
        oldValue: metadata.previousStock,
        newValue: metadata.newStock,
      },
    ],
    metadata: {
      sku: metadata.sku,
      adjustmentType: metadata.adjustmentType,
      quantity: metadata.quantity,
      notes: metadata.notes,
      type: 'stock_adjustment',
    },
  });
}


/**
 * Log product image upload
 */
export async function logProductImageUpload(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  metadata: {
    productId: string;
    filename: string;
    contentType: string;
    publicUrl: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'create',
    entity: 'product-image',
    entityId: metadata.productId,
    metadata: {
      filename: metadata.filename,
      contentType: metadata.contentType,
      publicUrl: metadata.publicUrl,
    },
  });
}

/**
 * Log product image deletion
 */
export async function logProductImageDelete(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  metadata: {
    productId?: string;
    imageUrl: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'delete',
    entity: 'product-image',
    entityId: metadata.productId,
    metadata: {
      imageUrl: metadata.imageUrl,
    },
  });
}

// ============================================================================
// PACKING DOMAIN - HIGH PRIORITY
// ============================================================================

/**
 * Log packing item update
 */
export async function logPackingItemUpdate(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  orderId: string,
  metadata: {
    orderNumber: string;
    itemSku: string;
    action: 'packed' | 'unpacked';
    quantity?: number;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'order_item',
    entityId: orderId,
    metadata: {
      orderNumber: metadata.orderNumber,
      itemSku: metadata.itemSku,
      action: metadata.action,
      quantity: metadata.quantity,
      type: 'packing_item_update',
    },
  });
}

/**
 * Log packing notes update
 */
export async function logPackingNotesUpdate(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  orderId: string,
  metadata: {
    orderNumber: string;
    notes: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'order',
    entityId: orderId,
    metadata: {
      orderNumber: metadata.orderNumber,
      notes: metadata.notes,
      type: 'packing_notes_update',
    },
  });
}

/**
 * Log auto-merge of orders at packing-screen load time.
 * Records the primary that absorbed the others and the list of absorbed order numbers.
 */
export async function logOrdersMerged(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  primaryOrderId: string,
  metadata: {
    primaryOrderNumber: string;
    absorbedOrderIds: string[];
    absorbedOrderNumbers: string[];
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'order',
    entityId: primaryOrderId,
    metadata: {
      primaryOrderNumber: metadata.primaryOrderNumber,
      absorbedOrderIds: metadata.absorbedOrderIds,
      absorbedOrderNumbers: metadata.absorbedOrderNumbers,
      type: 'packing_orders_merged',
    },
  });
}

/**
 * Log order marked ready for delivery
 */
export async function logOrderReadyForDelivery(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  orderId: string,
  metadata: {
    orderNumber: string;
    packedBy: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'order',
    entityId: orderId,
    metadata: {
      orderNumber: metadata.orderNumber,
      packedBy: metadata.packedBy,
      type: 'ready_for_delivery',
    },
  });
}

/**
 * Log packing order pause/resume
 */
export async function logPackingOrderPauseResume(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  orderId: string,
  metadata: {
    orderNumber: string;
    action: 'pause' | 'resume';
    reason?: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'order',
    entityId: orderId,
    metadata: {
      orderNumber: metadata.orderNumber,
      action: metadata.action,
      reason: metadata.reason,
      type: `packing_${metadata.action}`,
    },
  });
}

/**
 * Log packing order reset
 */
export async function logPackingOrderReset(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  orderId: string,
  metadata: {
    orderNumber: string;
    reason?: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'order',
    entityId: orderId,
    metadata: {
      orderNumber: metadata.orderNumber,
      reason: metadata.reason,
      type: 'packing_reset',
    },
  });
}

/**
 * Log packing item quantity update
 */
export async function logPackingItemQuantityUpdate(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  orderId: string,
  metadata: {
    orderNumber: string;
    itemSku: string;
    oldQuantity: number;
    newQuantity: number;
    reason?: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'order_item',
    entityId: orderId,
    changes: [
      {
        field: 'quantity',
        oldValue: metadata.oldQuantity,
        newValue: metadata.newQuantity,
      },
    ],
    metadata: {
      orderNumber: metadata.orderNumber,
      itemSku: metadata.itemSku,
      reason: metadata.reason,
      type: 'packing_quantity_update',
    },
  });
}

/**
 * Log when order total changes during packing (Issue #16 fix)
 */
export async function logPackingTotalChange(
  userId: string,
  orderId: string,
  metadata: {
    orderNumber: string;
    previousTotal: number;
    newTotal: number;
    reason: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    action: 'update',
    entity: 'order',
    entityId: orderId,
    changes: [
      {
        field: 'totalAmount',
        oldValue: metadata.previousTotal,
        newValue: metadata.newTotal,
      },
    ],
    metadata: {
      orderNumber: metadata.orderNumber,
      reason: metadata.reason,
      type: 'packing_total_change',
      totalDifference: metadata.newTotal - metadata.previousTotal,
    },
  });
}

// ============================================================================
// CATEGORY DOMAIN
// ============================================================================

/**
 * Log category creation
 */
export async function logCategoryCreate(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  categoryId: string,
  metadata: {
    name: string;
    description?: string;
    processingLossPercentage?: number | null;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'create',
    entity: 'category',
    entityId: categoryId,
    metadata: {
      name: metadata.name,
      description: metadata.description,
      processingLossPercentage: metadata.processingLossPercentage,
      type: 'category_create',
    },
  });
}

/**
 * Log category update
 */
export async function logCategoryUpdate(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  categoryId: string,
  changes: AuditChange[],
  metadata: {
    name: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'category',
    entityId: categoryId,
    changes,
    metadata: {
      name: metadata.name,
      type: 'category_update',
    },
  });
}

/**
 * Log category delete
 */
export async function logCategoryDelete(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  categoryId: string,
  metadata: {
    name: string;
    type: 'soft_delete' | 'hard_delete';
    productCount: number;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'delete',
    entity: 'category',
    entityId: categoryId,
    metadata: {
      name: metadata.name,
      deleteType: metadata.type,
      productCount: metadata.productCount,
      type: 'category_delete',
    },
  });
}

// ============================================================================
// NOTIFICATION/SMS SETTINGS DOMAIN
// ============================================================================

/**
 * Log notification settings update
 */
export async function logNotificationSettingsUpdate(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  companyId: string,
  changes: AuditChange[],
  metadata: {
    settingType: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'notification_settings',
    entityId: companyId,
    changes,
    metadata: {
      settingType: metadata.settingType,
      type: 'notification_settings_update',
    },
  });
}

/**
 * Log SMS settings update
 */
export async function logSmsSettingsUpdate(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  companyId: string,
  changes: AuditChange[],
  metadata: {
    fieldsChanged: string[];
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'sms_settings',
    entityId: companyId,
    changes,
    metadata: {
      fieldsChanged: metadata.fieldsChanged,
      type: 'sms_settings_update',
    },
  });
}

// ============================================================================
// XERO DOMAIN
// ============================================================================

/**
 * Log Xero sync trigger
 */
export async function logXeroSyncTrigger(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  metadata: {
    jobType: 'create_invoice' | 'create_credit_note' | 'sync_contact' | 'update_invoice';
    entityType: string;
    entityId: string;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'create',
    entity: 'xero_sync_job',
    entityId: metadata.entityId,
    metadata: {
      jobType: metadata.jobType,
      entityType: metadata.entityType,
      type: 'xero_sync_trigger',
    },
  });
}

/**
 * Log Xero job retry
 */
export async function logXeroJobRetry(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  metadata: {
    jobId: string;
    jobType: string;
    entityType: string;
    entityId: string;
    previousAttempts: number;
  }
): Promise<void> {
  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'xero_sync_job',
    entityId: metadata.jobId,
    metadata: {
      jobType: metadata.jobType,
      entityType: metadata.entityType,
      entityId: metadata.entityId,
      previousAttempts: metadata.previousAttempts,
      type: 'xero_job_retry',
    },
  });
}

// ============================================================================
// CUSTOMER DOMAIN - ADDITIONAL HELPERS
// ============================================================================

/**
 * Log customer status change (suspend/activate/close)
 */
export async function logCustomerStatusChange(
  userId: string,
  userEmail: string | undefined,
  userRole: string | undefined,
  userName: string | null | undefined,
  customerId: string,
  metadata: {
    businessName: string;
    action: 'suspend' | 'activate' | 'close';
    reason?: string;
    previousStatus?: string;
  }
): Promise<void> {
  // Determine old and new status based on action
  let oldValue: string;
  let newValue: string;
  if (metadata.action === 'suspend') {
    oldValue = 'active';
    newValue = 'suspended';
  } else if (metadata.action === 'activate') {
    oldValue = 'suspended';
    newValue = 'active';
  } else {
    // close action
    oldValue = metadata.previousStatus ?? 'active';
    newValue = 'closed';
  }

  await createAuditLog({
    userId,
    userEmail,
    userRole,
    userName,
    action: 'update',
    entity: 'customer',
    entityId: customerId,
    changes: [
      {
        field: 'status',
        oldValue,
        newValue,
      },
    ],
    metadata: {
      businessName: metadata.businessName,
      action: metadata.action,
      reason: metadata.reason,
      type: `customer_${metadata.action}`,
    },
  });
}
