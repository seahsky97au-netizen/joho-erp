export { appRouter, type AppRouter } from './root';
export { createContext, type Context, type UserRole } from './context';
export { router, publicProcedure, protectedProcedure } from './trpc';

// Export invitation types for frontend use
export {
  INTERNAL_ROLES,
  type InternalRole,
  type InvitationInput,
  type InvitationResponse,
  type PendingInvitation,
  type RevokeInvitationResponse,
} from './types/invitation';

// Export services for use in API routes
export {
  processTimedOutSessions,
  startPackingSession,
  updateSessionActivity,
  updateSessionActivityByPacker,
  endPackingSession,
  getActiveSession,
  getAllActiveSessions,
} from './services/packing-session';

export {
  sendPackingTimeoutAlertEmail,
  sendLowStockAlertEmail,
  sendXeroSyncErrorEmail,
  sendNewOrderNotificationEmail,
} from './services/email';

export {
  uploadToR2,
  uploadIdentityDocument,
  isR2Configured,
  IMAGE_UPLOAD_CONFIG,
  IDENTITY_DOCUMENT_CONFIG,
  type AllowedMimeType,
  type IdentityDocumentMimeType,
} from './services/r2';

export {
  sendSms,
  sendTestSms,
  sendOrderReminderSms,
  sendBulkOrderReminderSms,
  isSmsConfigured,
} from './services/sms';

export { runBalanceReconciler } from './services/xero-balance-reconciler';
export {
  verifyXeroWebhookSignature,
  persistXeroWebhookEvents,
  processPersistedWebhookEvent,
  processXeroWebhookPayload,
} from './services/xero-webhook';

// Table query schemas for sorting/filtering/pagination
export {
  sortInputSchema,
  paginationInputSchema,
  tableQueryInputSchema,
  searchInputSchema,
  fullTableQueryInputSchema,
  type SortInput,
  type PaginationInput,
  type TableQueryInput,
  type SearchInput,
  type FullTableQueryInput,
} from './schemas';
