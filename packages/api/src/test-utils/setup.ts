import { vi, beforeAll, afterAll, afterEach } from 'vitest';

// ============================================================
// MOCK ALL EXTERNAL SERVICES
// These must be defined before any router imports
// ============================================================

// Mock Clerk
vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: vi.fn(() =>
    Promise.resolve({
      users: {
        getUserList: vi.fn().mockResolvedValue({ data: [] }),
        getUser: vi.fn(),
        updateUserMetadata: vi.fn(),
        banUser: vi.fn(),
        unbanUser: vi.fn(),
      },
      invitations: {
        createInvitation: vi.fn(),
        getInvitationList: vi.fn().mockResolvedValue({ data: [] }),
        revokeInvitation: vi.fn(),
      },
    })
  ),
  auth: vi.fn().mockResolvedValue({ userId: null, sessionId: null }),
}));

// Mock Email service -- all 24 send functions -> no-op
vi.mock('../services/email', () => ({
  sendOrderConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendOrderCancelledEmail: vi.fn().mockResolvedValue(undefined),
  sendOrderConfirmedByAdminEmail: vi.fn().mockResolvedValue(undefined),
  sendNewOrderNotificationEmail: vi.fn().mockResolvedValue(undefined),
  sendOrderDeliveredEmail: vi.fn().mockResolvedValue(undefined),
  sendOrderOutForDeliveryEmail: vi.fn().mockResolvedValue(undefined),
  sendOrderReadyForDeliveryEmail: vi.fn().mockResolvedValue(undefined),
  sendOrderReturnedToWarehouseEmail: vi.fn().mockResolvedValue(undefined),
  sendBackorderAdminNotification: vi.fn().mockResolvedValue(undefined),
  sendBackorderSubmittedEmail: vi.fn().mockResolvedValue(undefined),
  sendBackorderApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendBackorderRejectedEmail: vi.fn().mockResolvedValue(undefined),
  sendBackorderPartialApprovalEmail: vi.fn().mockResolvedValue(undefined),
  sendCreditApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendCreditRejectedEmail: vi.fn().mockResolvedValue(undefined),
  sendCreditNoteIssuedEmail: vi.fn().mockResolvedValue(undefined),
  sendCustomerRegistrationEmail: vi.fn().mockResolvedValue(undefined),
  sendNewCustomerRegistrationAdminEmail: vi.fn().mockResolvedValue(undefined),
  sendDriverUrgentCancellationEmail: vi.fn().mockResolvedValue(undefined),
  sendLowStockAlertEmail: vi.fn().mockResolvedValue(undefined),
  sendPackingTimeoutAlertEmail: vi.fn().mockResolvedValue(undefined),
  sendRouteOptimizedEmail: vi.fn().mockResolvedValue(undefined),
  sendTestEmail: vi.fn().mockResolvedValue(undefined),
  sendXeroSyncErrorEmail: vi.fn().mockResolvedValue(undefined),
}));

// Mock Xero service
vi.mock('../services/xero', () => ({
  isXeroIntegrationEnabled: vi.fn().mockReturnValue(false),
  isConnected: vi.fn().mockResolvedValue(false),
  createInvoiceInXero: vi.fn().mockResolvedValue({ success: true }),
  updateInvoiceInXero: vi.fn().mockResolvedValue({ success: true }),
  syncContactToXero: vi.fn().mockResolvedValue({ success: true }),
  createCreditNoteInXero: vi.fn().mockResolvedValue({ success: true }),
  getConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
  getAuthorizationUrl: vi.fn().mockReturnValue('https://mock-xero-auth'),
  exchangeCodeForTokens: vi.fn().mockResolvedValue({ success: true }),
  getConnectedTenants: vi.fn().mockResolvedValue([]),
  testConnection: vi.fn().mockResolvedValue(true),
  testConnectionDetailed: vi.fn().mockResolvedValue({ connected: false }),
  getInvoicePdfUrl: vi.fn().mockResolvedValue(null),
  getInvoicePdfBuffer: vi.fn().mockResolvedValue(null),
  findExistingContactByEmail: vi.fn().mockResolvedValue(null),
  findExistingInvoiceByReference: vi.fn().mockResolvedValue(null),
  ensureXeroItemsExist: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  clearInvoiceCache: vi.fn(),
  fetchContactBalance: vi.fn().mockResolvedValue({
    outstandingCents: 0,
    overdueCents: 0,
    currency: 'AUD',
  }),
  fetchInvoiceContactId: vi.fn().mockResolvedValue(null),
  fetchOpenInvoicesForContact: vi.fn().mockResolvedValue([]),
  xeroApiRequest: vi.fn().mockResolvedValue({ Invoices: [] }),
  getValidAccessToken: vi.fn().mockResolvedValue({
    accessToken: 'mock-access-token',
    tenantId: 'mock-tenant-id',
  }),
  XeroApiError: class XeroApiError extends Error {
    statusCode: number;
    endpoint: string;
    responseBody: string;
    isRetryable: boolean;
    constructor(statusCode: number, endpoint: string, responseBody: string) {
      super(`Xero API error: ${statusCode}`);
      this.statusCode = statusCode;
      this.endpoint = endpoint;
      this.responseBody = responseBody;
      this.isRetryable = statusCode === 429 || statusCode >= 500;
    }
  },
}));

// Mock Xero Queue
vi.mock('../services/xero-queue', () => ({
  enqueueXeroJob: vi.fn().mockResolvedValue('mock-job-id'),
  getSyncJobs: vi.fn().mockResolvedValue([]),
  getSyncStats: vi.fn().mockResolvedValue({ pending: 0, processing: 0, completed: 0, failed: 0 }),
  processJob: vi.fn().mockResolvedValue(undefined),
  retryJob: vi.fn().mockResolvedValue(undefined),
}));

// Mock Xero Webhook (downstream of xero + xero-queue)
vi.mock('../services/xero-webhook', () => ({
  verifyXeroWebhookSignature: vi.fn().mockReturnValue(true),
  persistXeroWebhookEvents: vi.fn().mockResolvedValue({
    persistedIds: [],
    totalEvents: 0,
    skippedNonInvoice: 0,
    skippedDuplicate: 0,
    skippedWrongTenant: 0,
    rawBodyHash: 'mock-hash',
  }),
  processPersistedWebhookEvent: vi.fn().mockResolvedValue({ status: 'completed' }),
  processXeroWebhookPayload: vi.fn().mockResolvedValue({
    persistedIds: [],
    totalEvents: 0,
    skippedNonInvoice: 0,
    skippedDuplicate: 0,
    skippedWrongTenant: 0,
  }),
}));

// Mock Route Optimizer
vi.mock('../services/route-optimizer', () => ({
  optimizeDeliveryRoute: vi.fn().mockResolvedValue(null),
  optimizeDeliveryOnlyRoute: vi.fn().mockResolvedValue(null),
  getDeliveryRouteOptimization: vi.fn().mockResolvedValue(null),
  getRouteOptimization: vi.fn().mockResolvedValue(null),
  checkIfDeliveryRouteNeedsRecalculation: vi.fn().mockResolvedValue(false),
  checkIfRouteNeedsReoptimization: vi.fn().mockResolvedValue(false),
  assignPreliminaryPackingSequence: vi.fn().mockResolvedValue(undefined),
}));

// Mock Mapbox
vi.mock('../services/mapbox', () => ({
  optimizeRoute: vi.fn().mockResolvedValue({
    trips: [{ distance: 10000, duration: 1200, geometry: { coordinates: [] } }],
    waypoints: [],
  }),
  optimizeRoutesByArea: vi.fn().mockResolvedValue([]),
  calculateArrivalTimes: vi.fn().mockReturnValue([]),
  formatDistance: vi.fn().mockReturnValue('10 km'),
  formatDuration: vi.fn().mockReturnValue('20 min'),
}));

// Mock R2 (S3-compatible storage)
vi.mock('../services/r2', () => ({
  generateUploadUrl: vi.fn().mockResolvedValue({ uploadUrl: 'https://mock-upload-url', publicUrl: 'https://mock-public-url' }),
  generateSignatureUploadUrl: vi.fn().mockResolvedValue({ uploadUrl: 'https://mock-upload-url', publicUrl: 'https://mock-public-url' }),
  deleteImage: vi.fn().mockResolvedValue(undefined),
  uploadToR2: vi.fn().mockResolvedValue('https://mock-public-url'),
  uploadPdfToR2: vi.fn().mockResolvedValue('https://mock-pdf-url'),
  uploadIdentityDocument: vi.fn().mockResolvedValue({ publicUrl: 'https://mock-doc-url' }),
  isR2Configured: vi.fn().mockReturnValue(true),
  getR2Client: vi.fn(),
  IMAGE_UPLOAD_CONFIG: {
    maxSizeBytes: 2 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'],
    presignedUrlExpiresIn: 300,
  },
}));

// Mock SMS
vi.mock('../services/sms', () => ({
  sendSms: vi.fn().mockResolvedValue({ success: true }),
  sendTestSms: vi.fn().mockResolvedValue({ success: true }),
  sendOrderReminderSms: vi.fn().mockResolvedValue({ success: true }),
  sendBulkOrderReminderSms: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  isSmsConfigured: vi.fn().mockReturnValue(false),
  getTwilioClient: vi.fn().mockReturnValue(null),
}));

// Mock PDF Generator
vi.mock('../services/pdf-generator', () => ({
  generateCreditApplicationPdf: vi.fn().mockResolvedValue(Buffer.from('mock-pdf')),
}));

// Mock Permission Service
vi.mock('../services/permission-service', () => ({
  hasPermission: vi.fn().mockResolvedValue(true),
  getRolePermissions: vi.fn().mockResolvedValue([]),
}));

// Mock Audit Service
vi.mock('../services/audit', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================
// DATABASE CONNECTION LIFECYCLE
// ============================================================

import { getPrismaClient, disconnectPrisma } from '@joho-erp/database';

beforeAll(async () => {
  // Prisma connects lazily, but we can verify the connection here
  const prisma = getPrismaClient();
  await prisma.$connect();
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await disconnectPrisma();
});
