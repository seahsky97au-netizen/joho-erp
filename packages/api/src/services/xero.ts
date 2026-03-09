/**
 * Xero OAuth 2.0 Service
 *
 * This service handles Xero OAuth authentication and API interactions.
 * It implements the Authorization Code flow with PKCE support.
 *
 * Environment variables required:
 * - XERO_CLIENT_ID: Xero OAuth Client ID
 * - XERO_CLIENT_SECRET: Xero OAuth Client Secret
 * - XERO_REDIRECT_URI: OAuth callback URL (e.g., https://admin.johofoods.com/api/xero/auth-callback)
 * - XERO_SCOPES: Space-separated OAuth scopes (e.g., "accounting.transactions accounting.contacts")
 */

import { prisma } from '@joho-erp/database';
import { formatDateForMelbourne } from '@joho-erp/shared';
import crypto from 'crypto';
import { encrypt, decrypt, isEncryptionEnabled } from '../utils/encryption';
import { xeroLogger, startTimer } from '../utils/logger';

// Xero OAuth endpoints
const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';

// Configuration from environment variables

/**
 * Custom error class for Xero API errors with detailed context.
 * Includes status code, endpoint, and response body for debugging.
 * The isRetryable flag indicates if the error is transient (429, 5xx).
 */

// Token refresh mutex to prevent race conditions when multiple requests
// try to refresh the token simultaneously
let tokenRefreshPromise: Promise<{ accessToken: string; tenantId: string }> | null = null;

// Rate limiting configuration and state
// Xero's limit is 60 calls/minute, we use 55 for safety margin
const RATE_LIMIT = {
  maxCalls: 55,
  windowMs: 60000, // 1 minute
  minDelayMs: 100, // Minimum delay between calls
};
let lastApiCallTime = 0;
let apiCallsInWindow: number[] = [];

/**
 * Enforce rate limiting before making Xero API calls.
 * Tracks calls within a sliding window and delays if necessary.
 */
async function enforceRateLimit(): Promise<void> {
  const now = Date.now();
  
  // Remove calls outside the current window
  apiCallsInWindow = apiCallsInWindow.filter(
    (timestamp) => now - timestamp < RATE_LIMIT.windowMs
  );

  // Check if we've hit the rate limit
  if (apiCallsInWindow.length >= RATE_LIMIT.maxCalls) {
    // Calculate how long to wait until the oldest call exits the window
    const oldestCall = Math.min(...apiCallsInWindow);
    const waitTime = RATE_LIMIT.windowMs - (now - oldestCall) + 100; // +100ms buffer
    xeroLogger.rateLimit.waiting(waitTime);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
    // Recurse to recheck after waiting
    return enforceRateLimit();
  }

  // Enforce minimum delay between calls to avoid bursts
  const timeSinceLastCall = now - lastApiCallTime;
  if (timeSinceLastCall < RATE_LIMIT.minDelayMs && lastApiCallTime > 0) {
    await new Promise((resolve) => 
      setTimeout(resolve, RATE_LIMIT.minDelayMs - timeSinceLastCall)
    );
  }

  // Record this call
  apiCallsInWindow.push(Date.now());
  lastApiCallTime = Date.now();
}

export class XeroApiError extends Error {
  readonly statusCode: number;
  readonly endpoint: string;
  readonly responseBody: string;
  readonly isRetryable: boolean;

  constructor(statusCode: number, endpoint: string, responseBody: string) {
    super(`Xero API request failed: ${statusCode} on ${endpoint} - ${responseBody}`);
    this.name = 'XeroApiError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
    this.responseBody = responseBody;
    // 429 (rate limit) and 5xx (server errors) are retryable
    this.isRetryable = statusCode === 429 || statusCode >= 500;
  }
}

const getConfig = () => ({
  clientId: process.env.XERO_CLIENT_ID || '',
  clientSecret: process.env.XERO_CLIENT_SECRET || '',
  redirectUri: process.env.XERO_REDIRECT_URI || '',
  scopes: process.env.XERO_SCOPES || 'openid profile email accounting.transactions accounting.contacts offline_access',
});

/**
 * Check if Xero integration is enabled via environment variable.
 * Defaults to true for backward compatibility.
 */
export function isXeroIntegrationEnabled(): boolean {
  const enabled = process.env.XERO_INTEGRATION_ENABLED;
  // Default to true for backward compatibility - only 'false' disables
  return enabled !== 'false';
}

/**
 * Token response from Xero
 */
export interface XeroTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token: string;
  scope: string;
}

/**
 * Xero tenant (organization) information
 */
export interface XeroTenant {
  id: string;
  authEventId: string;
  tenantId: string;
  tenantType: string;
  tenantName: string;
  createdDateUtc: string;
  updatedDateUtc: string;
}

/**
 * Generate a cryptographically secure state parameter for CSRF protection
 */
export function generateState(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate the Xero OAuth authorization URL
 */
export function getAuthorizationUrl(state: string): string {
  const config = getConfig();

  if (!config.clientId) {
    throw new Error('XERO_CLIENT_ID is not configured');
  }

  if (!config.redirectUri) {
    throw new Error('XERO_REDIRECT_URI is not configured');
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    state: state,
  });

  return `${XERO_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access and refresh tokens
 */
export async function exchangeCodeForTokens(code: string): Promise<XeroTokenResponse> {
  const config = getConfig();

  if (!config.clientId || !config.clientSecret) {
    throw new Error('Xero OAuth credentials are not configured');
  }

  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  const response = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: config.redirectUri,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    xeroLogger.error('Token exchange failed', { statusCode: response.status, error: errorText });
    throw new Error(`Failed to exchange code for tokens: ${response.status} ${errorText}`);
  }

  const tokenResponse = await response.json();

  // Validate required fields are present
  if (!tokenResponse.access_token || typeof tokenResponse.access_token !== 'string') {
    xeroLogger.error('Invalid token response: missing access_token', { response: tokenResponse });
    throw new Error('Invalid token response from Xero: missing access_token');
  }

  if (!tokenResponse.refresh_token || typeof tokenResponse.refresh_token !== 'string') {
    xeroLogger.error('Invalid token response: missing refresh_token', { response: tokenResponse });
    throw new Error('Invalid token response from Xero: missing refresh_token');
  }

  if (typeof tokenResponse.expires_in !== 'number') {
    xeroLogger.error('Invalid token response: missing expires_in', { response: tokenResponse });
    throw new Error('Invalid token response from Xero: missing expires_in');
  }

  return tokenResponse as XeroTokenResponse;
}

/**
 * Refresh the access token using the refresh token
 */
export async function refreshAccessToken(refreshToken: string): Promise<XeroTokenResponse> {
  const config = getConfig();

  if (!config.clientId || !config.clientSecret) {
    throw new Error('Xero OAuth credentials are not configured');
  }

  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  const response = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    xeroLogger.token.refreshFailed(errorText, { statusCode: response.status });
    throw new Error(`Failed to refresh token: ${response.status} ${errorText}`);
  }

  return response.json();
}

/**
 * Get connected Xero tenants (organizations)
 */
export async function getConnectedTenants(accessToken: string): Promise<XeroTenant[]> {
  const response = await fetch(XERO_CONNECTIONS_URL, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    xeroLogger.error('Failed to get connected tenants', { statusCode: response.status, error: errorText });
    throw new Error(`Failed to get connected tenants: ${response.status}`);
  }

  return response.json();
}

/**
 * Store OAuth tokens in the database
 * Tokens are encrypted if XERO_TOKEN_ENCRYPTION_KEY is set
 */
export async function storeTokens(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  tenantId?: string
): Promise<void> {
  const company = await prisma.company.findFirst();

  if (!company) {
    throw new Error('Company not found. Please create company profile first.');
  }

  const tokenExpiry = new Date(Date.now() + expiresIn * 1000);

  // Encrypt tokens before storage
  const encryptedAccessToken = encrypt(accessToken);
  const encryptedRefreshToken = encrypt(refreshToken);

  await prisma.company.update({
    where: { id: company.id },
    data: {
      xeroSettings: {
        tenantId: tenantId || null,
        refreshToken: encryptedRefreshToken,
        tokenExpiry: tokenExpiry,
        accessToken: encryptedAccessToken,
      },
    },
  });
}

/**
 * Get stored tokens from the database
 * Tokens are decrypted if encryption is enabled
 */
export async function getStoredTokens(): Promise<{
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiry: Date | null;
  tenantId: string | null;
} | null> {
  const company = await prisma.company.findFirst({
    select: { xeroSettings: true },
  });

  if (!company || !company.xeroSettings) {
    return null;
  }

  const settings = company.xeroSettings as {
    accessToken?: string;
    refreshToken?: string;
    tokenExpiry?: Date;
    tenantId?: string;
  };

  // Decrypt tokens (handles unencrypted tokens for migration)
  const accessToken = settings.accessToken ? decrypt(settings.accessToken) : null;
  const refreshToken = settings.refreshToken ? decrypt(settings.refreshToken) : null;

  return {
    accessToken,
    refreshToken,
    tokenExpiry: settings.tokenExpiry ? new Date(settings.tokenExpiry) : null,
    tenantId: settings.tenantId || null,
  };
}

/**
 * Check if the access token is expired or about to expire (within 5 minutes)
 */
export function isTokenExpired(tokenExpiry: Date | null): boolean {
  if (!tokenExpiry) return true;

  // Consider token expired if it expires within 5 minutes
  const bufferMs = 5 * 60 * 1000;
  return new Date().getTime() > tokenExpiry.getTime() - bufferMs;
}

/**
 * Get a valid access token, refreshing if necessary
 */
export async function getValidAccessToken(): Promise<{ accessToken: string; tenantId: string }> {
  const tokens = await getStoredTokens();

  if (!tokens || !tokens.refreshToken) {
    throw new Error('Xero is not connected. Please authenticate first.');
  }

  if (!tokens.tenantId) {
    throw new Error('Xero tenant not selected. Please reconnect to Xero.');
  }

  // Capture values for use in async closure (TypeScript type narrowing)
  const tenantId = tokens.tenantId;
  const refreshToken = tokens.refreshToken;

  // If token is still valid, return it (fast path)
  if (tokens.accessToken && !isTokenExpired(tokens.tokenExpiry)) {
    return {
      accessToken: tokens.accessToken,
      tenantId,
    };
  }

  // Token is expired or about to expire, need to refresh
  // Use mutex to prevent concurrent refresh requests from invalidating each other
  if (tokenRefreshPromise) {
    // Another request is already refreshing the token, wait for it
    xeroLogger.debug('Token refresh already in progress, waiting...');
    return tokenRefreshPromise;
  }

  // Start the refresh and store the promise as a mutex
  xeroLogger.token.refreshing();
  tokenRefreshPromise = (async () => {
    try {
      const newTokens = await refreshAccessToken(refreshToken);

      // Store the new tokens
      await storeTokens(
        newTokens.access_token,
        newTokens.refresh_token,
        newTokens.expires_in,
        tenantId
      );
      xeroLogger.token.refreshed();
      xeroLogger.token.stored();

      return {
        accessToken: newTokens.access_token,
        tenantId,
      };
    } finally {
      // Clear the mutex when done (success or failure)
      tokenRefreshPromise = null;
    }
  })();

  return tokenRefreshPromise;
}

/**
 * Test the Xero connection by fetching organization info
 */
export async function testConnection(): Promise<{
  success: boolean;
  message: string;
  tenantName?: string;
}> {
  try {
    const { accessToken } = await getValidAccessToken();
    const tenants = await getConnectedTenants(accessToken);

    if (tenants.length === 0) {
      return {
        success: false,
        message: 'No Xero organizations connected',
      };
    }

    return {
      success: true,
      message: 'Successfully connected to Xero',
      tenantName: tenants[0].tenantName,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Detailed connection test result
 */
export interface XeroConnectionTestResult {
  success: boolean;
  message: string;
  details: {
    tokenValid: boolean;
    tokenExpiresInMinutes: number | null;
    tenantConnected: boolean;
    tenantName: string | null;
    canReadContacts: boolean;
    canReadInvoices: boolean;
    canWriteContacts: boolean;
    encryptionEnabled: boolean;
  };
  errors: string[];
}

// Test contact used for write permission verification
const TEST_CONTACT: XeroContact = {
  Name: '_JOHO_ERP_TEST_CONTACT',
  FirstName: 'Test',
  LastName: 'Contact',
  EmailAddress: 'joho-erp-test@localhost.invalid',
  IsCustomer: true,
};

/**
 * Test the Xero connection with detailed verification of all permissions
 * Tests: token validity, tenant connection, read contacts, read invoices, write contacts
 */
export async function testConnectionDetailed(): Promise<XeroConnectionTestResult> {
  const errors: string[] = [];
  const details = {
    tokenValid: false,
    tokenExpiresInMinutes: null as number | null,
    tenantConnected: false,
    tenantName: null as string | null,
    canReadContacts: false,
    canReadInvoices: false,
    canWriteContacts: false,
    encryptionEnabled: isEncryptionEnabled(),
  };

  try {
    // Step 1: Check token validity and get valid token (auto-refresh if needed)
    const tokens = await getStoredTokens();
    if (!tokens || !tokens.refreshToken) {
      errors.push('Xero is not connected. Please authenticate first.');
      return {
        success: false,
        message: 'Xero is not connected',
        details,
        errors,
      };
    }

    // Calculate token expiry
    if (tokens.tokenExpiry) {
      const minutesRemaining = Math.round((tokens.tokenExpiry.getTime() - Date.now()) / (1000 * 60));
      details.tokenExpiresInMinutes = Math.max(0, minutesRemaining);
    }

    // Get valid access token (will refresh if expired)
    let accessToken: string;
    let tenantId: string;
    try {
      const validTokens = await getValidAccessToken();
      accessToken = validTokens.accessToken;
      tenantId = validTokens.tenantId;
      details.tokenValid = true;

      // Update expiry after potential refresh
      const refreshedTokens = await getStoredTokens();
      if (refreshedTokens?.tokenExpiry) {
        const minutesRemaining = Math.round((refreshedTokens.tokenExpiry.getTime() - Date.now()) / (1000 * 60));
        details.tokenExpiresInMinutes = Math.max(0, minutesRemaining);
      }
    } catch (error) {
      errors.push(`Token error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return {
        success: false,
        message: 'Failed to get valid access token',
        details,
        errors,
      };
    }

    // Step 2: Test tenant connection
    try {
      const tenants = await getConnectedTenants(accessToken);
      if (tenants.length > 0) {
        details.tenantConnected = true;
        // Find the tenant matching our stored tenantId
        const matchingTenant = tenants.find(t => t.tenantId === tenantId);
        details.tenantName = matchingTenant?.tenantName || tenants[0].tenantName;
      } else {
        errors.push('No Xero organizations connected');
      }
    } catch (error) {
      errors.push(`Tenant connection error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Step 3: Test read contacts permission
    try {
      await xeroApiRequest<XeroContactsResponse>('/Contacts?page=1&pageSize=1');
      details.canReadContacts = true;
    } catch (error) {
      errors.push(`Read contacts error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Step 4: Test read invoices permission
    try {
      await xeroApiRequest<XeroInvoicesResponse>('/Invoices?page=1&pageSize=1');
      details.canReadInvoices = true;
    } catch (error) {
      errors.push(`Read invoices error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Step 5: Test write contacts permission
    try {
      // First, search for existing test contact
      const existingContactId = await findExistingContactByEmail(TEST_CONTACT.EmailAddress!);

      if (existingContactId) {
        // Update existing test contact (proves write works)
        await xeroApiRequest<XeroContactsResponse>(
          `/Contacts/${existingContactId}`,
          { method: 'POST', body: { Contacts: [TEST_CONTACT] } }
        );
      } else {
        // Create new test contact (proves write works)
        await xeroApiRequest<XeroContactsResponse>('/Contacts', {
          method: 'POST',
          body: { Contacts: [TEST_CONTACT] },
        });
      }
      details.canWriteContacts = true;
    } catch (error) {
      errors.push(`Write contacts error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Determine overall success
    const success = details.tokenValid &&
      details.tenantConnected &&
      details.canReadContacts &&
      details.canReadInvoices &&
      details.canWriteContacts;

    return {
      success,
      message: success
        ? 'All Xero connection tests passed'
        : 'Some Xero connection tests failed',
      details,
      errors,
    };
  } catch (error) {
    errors.push(`Unexpected error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return {
      success: false,
      message: 'Connection test failed with unexpected error',
      details,
      errors,
    };
  }
}

/**
 * Disconnect from Xero by clearing stored tokens
 */
export async function disconnect(): Promise<void> {
  const company = await prisma.company.findFirst();

  if (!company) {
    throw new Error('Company not found');
  }

  await prisma.company.update({
    where: { id: company.id },
    data: {
      xeroSettings: {
        tenantId: null,
        refreshToken: null,
        tokenExpiry: null,
        accessToken: null,
      },
    },
  });
}

/**
 * Check if Xero is currently connected (has valid refresh token)
 */
export async function isConnected(): Promise<boolean> {
  if (!isXeroIntegrationEnabled()) {
    return false;
  }
  const tokens = await getStoredTokens();
  return !!(tokens?.refreshToken);
}

/**
 * Get the connection status with details
 */
export async function getConnectionStatus(): Promise<{
  enabled: boolean;
  connected: boolean;
  tenantId: string | null;
  tokenExpiry: Date | null;
  needsRefresh: boolean;
}> {
  const enabled = isXeroIntegrationEnabled();
  
  if (!enabled) {
    return {
      enabled: false,
      connected: false,
      tenantId: null,
      tokenExpiry: null,
      needsRefresh: false,
    };
  }

  const tokens = await getStoredTokens();

  if (!tokens || !tokens.refreshToken) {
    return {
      enabled: true,
      connected: false,
      tenantId: null,
      tokenExpiry: null,
      needsRefresh: false,
    };
  }

  return {
    enabled: true,
    connected: true,
    tenantId: tokens.tenantId,
    tokenExpiry: tokens.tokenExpiry,
    needsRefresh: isTokenExpired(tokens.tokenExpiry),
  };
}

// ============================================================================
// Xero API Methods (for future use)
// ============================================================================

/**
 * Make an authenticated request to the Xero API
 */
export async function xeroApiRequest<T>(
  endpoint: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
  } = {}
): Promise<T> {
  // Enforce rate limiting before making the request
  await enforceRateLimit();

  const { accessToken, tenantId } = await getValidAccessToken();
  const method = options.method || 'GET';
  const timer = startTimer();

  xeroLogger.apiRequest(endpoint, method);

  const response = await fetch(`${XERO_API_BASE}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': tenantId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const duration = timer.stop();

  if (!response.ok) {
    const errorText = await response.text();
    xeroLogger.apiResponse(endpoint, response.status, duration, { error: errorText });
    throw new XeroApiError(response.status, endpoint, errorText);
  }

  xeroLogger.apiResponse(endpoint, response.status, duration);
  return response.json();
}

// ============================================================================
// Xero API Types
// ============================================================================

/**
 * Xero Contact structure
 */
export interface XeroContact {
  ContactID?: string;
  ContactNumber?: string;  // Unique identifier — set to local customer ID
  TaxNumber?: string;      // Maps to ABN (no uniqueness constraint in Xero)
  Name: string;
  FirstName?: string;
  LastName?: string;
  EmailAddress?: string;
  Phones?: Array<{
    PhoneType: 'DEFAULT' | 'DDI' | 'MOBILE' | 'FAX';
    PhoneNumber: string;
  }>;
  Addresses?: Array<{
    AddressType: 'POBOX' | 'STREET' | 'DELIVERY';
    AddressLine1?: string;
    City?: string;
    Region?: string;
    PostalCode?: string;
    Country?: string;
  }>;
  IsCustomer: boolean;
  DefaultCurrency?: string;
  PaymentTerms?: {
    Sales?: {
      Day: number;
      Type: 'DAYSAFTERBILLDATE' | 'DAYSAFTERBILLMONTH' | 'OFCURRENTMONTH' | 'OFFOLLOWINGMONTH';
    };
  };
}

export interface XeroContactsResponse {
  Contacts: XeroContact[];
}

/**
 * Xero Invoice line item
 */
export interface XeroLineItem {
  Description: string;
  Quantity: number;
  UnitAmount: number; // In dollars (Xero uses decimal)
  AccountCode: string;
  TaxType: string;
  ItemCode?: string; // Optional SKU reference
}

/**
 * Xero Item structure for creating/upserting items
 */
export interface XeroItem {
  ItemID?: string;
  Code: string;
  Name: string;
  Description: string;
  IsSold: boolean;
  IsPurchased: boolean;
  IsTrackedAsInventory: boolean;
  SalesDetails: {
    UnitPrice: number;
    AccountCode: string;
    TaxType: string;
  };
}

export interface XeroItemsResponse {
  Items: XeroItem[];
}

/**
 * Xero Invoice structure
 */
export interface XeroInvoice {
  InvoiceID?: string;
  InvoiceNumber?: string;
  Type: 'ACCREC' | 'ACCPAY';
  Contact: { ContactID: string };
  LineItems: XeroLineItem[];
  Date: string; // YYYY-MM-DD
  DueDate: string; // YYYY-MM-DD
  Status: 'DRAFT' | 'SUBMITTED' | 'AUTHORISED';
  CurrencyCode: string;
  Reference?: string;
  LineAmountTypes: 'Exclusive' | 'Inclusive' | 'NoTax';
}

export interface XeroInvoicesResponse {
  Invoices: XeroInvoice[];
}

/**
 * Xero Credit Note structure
 */
export interface XeroCreditNote {
  CreditNoteID?: string;
  CreditNoteNumber?: string;
  Type: 'ACCRECCREDIT' | 'ACCPAYCREDIT';
  Contact: { ContactID: string };
  LineItems: XeroLineItem[];
  Date: string;
  Status: 'DRAFT' | 'SUBMITTED' | 'AUTHORISED';
  CurrencyCode: string;
  Reference?: string;
  LineAmountTypes: 'Exclusive' | 'Inclusive' | 'NoTax';
}

export interface XeroCreditNotesResponse {
  CreditNotes: XeroCreditNote[];
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format a date for Xero API (YYYY-MM-DD)
 */
export function formatXeroDate(date: Date): string {
  return formatDateForMelbourne(date);
}

/**
 * Parse payment terms to extract number of days
 * Handles formats like "Net 30", "30 days", "Net 14", etc.
 */
export function parsePaymentTerms(terms: string | null | undefined): number | null {
  if (!terms) return null;
  const match = terms.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Get the Xero sales account code from environment or default
 */
function getXeroSalesAccountCode(): string {
  return process.env.XERO_SALES_ACCOUNT_CODE || '200';
}

function getXeroGstTaxType(): string {
  return process.env.XERO_GST_TAX_TYPE || 'OUTPUT';
}

function getXeroGstFreeTaxType(): string {
  return process.env.XERO_GST_FREE_TAX_TYPE || 'EXEMPTOUTPUT';
}

// ============================================================================
// Customer Type (for sync functions)
// ============================================================================

export interface CustomerForXeroSync {
  id: string;
  businessName: string;
  abn: string;
  xeroContactId?: string | null;
  contactPerson: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    mobile?: string | null;
  };
  deliveryAddress: {
    street: string;
    suburb: string;
    state: string;
    postcode: string;
  };
  billingAddress?: {
    street: string;
    suburb: string;
    state: string;
    postcode: string;
  } | null;
  creditApplication: {
    paymentTerms?: string | null;
  };
}

export interface OrderItemForXeroSync {
  productId: string;
  sku: string;
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number; // In cents
  subtotal: number; // In cents
  applyGst: boolean; // Whether GST should be applied to this item
}

export interface OrderForXeroSync {
  id: string;
  orderNumber: string;
  items: OrderItemForXeroSync[];
  subtotal: number; // In cents
  taxAmount: number; // In cents
  totalAmount: number; // In cents
  xero?: {
    invoiceId?: string | null;
    invoiceNumber?: string | null;
    invoiceStatus?: string | null;
    creditNoteId?: string | null;
    creditNoteNumber?: string | null;
  } | null;
  delivery?: {
    deliveredAt?: Date | null;
  } | null;
  statusHistory?: Array<{
    status: string;
    changedAt: Date | string;
  }>;
}

// ============================================================================
// Duplicate Detection Helpers
// ============================================================================

/**
 * Search for an existing contact in Xero by email address
 * Used for duplicate detection before creating new contacts
 */
async function findExistingContactByEmail(email: string): Promise<string | null> {
  try {
    // URL encode the email for the where clause
    const whereClause = encodeURIComponent(`EmailAddress=="${email}"`);
    const response = await xeroApiRequest<XeroContactsResponse>(
      `/Contacts?where=${whereClause}`
    );

    if (response.Contacts && response.Contacts.length > 0) {
      return response.Contacts[0].ContactID || null;
    }
    return null;
  } catch {
    // If search fails, return null and proceed with creation
    // (Xero will return error if duplicate exists)
    return null;
  }
}

async function findExistingItemByCode(code: string): Promise<string | null> {
  try {
    const whereClause = encodeURIComponent(`Code=="${code}"`);
    const response = await xeroApiRequest<XeroItemsResponse>(
      `/Items?where=${whereClause}`
    );

    if (response.Items && response.Items.length > 0) {
      return response.Items[0].ItemID || null;
    }
    return null;
  } catch (error) {
    xeroLogger.warn(`Failed to look up existing Xero item by code "${code}", will attempt creation`, {
      error: error instanceof Error ? error.message : 'Unknown error',
    } as any);
    return null;
  }
}


export async function findExistingContactByEmailWithName(
  email: string
): Promise<{ contactId: string; name: string } | null> {
  try {
    const whereClause = encodeURIComponent(`EmailAddress=="${email}"`);
    const response = await xeroApiRequest<XeroContactsResponse>(
      `/Contacts?where=${whereClause}`
    );

    if (response.Contacts && response.Contacts.length > 0) {
      const contact = response.Contacts[0];
      return {
        contactId: contact.ContactID!,
        name: contact.Name || 'Unknown',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Search for an existing invoice in Xero by reference (order number)
 * Used for duplicate detection before creating new invoices
 */
async function findExistingInvoiceByReference(reference: string): Promise<{
  invoiceId: string;
  invoiceNumber: string;
  status: string;
} | null> {
  try {
    const whereClause = encodeURIComponent(`Reference=="${reference}"`);
    const response = await xeroApiRequest<XeroInvoicesResponse>(
      `/Invoices?where=${whereClause}`
    );

    if (response.Invoices && response.Invoices.length > 0) {
      const invoice = response.Invoices[0];
      return {
        invoiceId: invoice.InvoiceID || '',
        invoiceNumber: invoice.InvoiceNumber || '',
        status: invoice.Status,
      };
    }
    return null;
  } catch {
    // If search fails, return null and proceed with creation
    return null;
  }
}

/**
 * Search for an existing credit note in Xero by reference
 * Used for duplicate detection before creating new credit notes
 */
async function findExistingCreditNoteByReference(reference: string): Promise<{
  creditNoteId: string;
  creditNoteNumber: string;
} | null> {
  try {
    const whereClause = encodeURIComponent(`Reference=="${reference}"`);
    const response = await xeroApiRequest<XeroCreditNotesResponse>(
      `/CreditNotes?where=${whereClause}`
    );

    if (response.CreditNotes && response.CreditNotes.length > 0) {
      const creditNote = response.CreditNotes[0];
      return {
        creditNoteId: creditNote.CreditNoteID || '',
        creditNoteNumber: creditNote.CreditNoteNumber || '',
      };
    }
    return null;
  } catch {
    // If search fails, return null and proceed with creation
    return null;
  }
}

// ============================================================================
// Contact Sync
// ============================================================================

/**
 * Map a customer to Xero Contact format
 */
function mapCustomerToXeroContact(customer: CustomerForXeroSync): XeroContact {
  const contact = customer.contactPerson;
  const deliveryAddr = customer.deliveryAddress;
  const billingAddr = customer.billingAddress || customer.deliveryAddress;

  // Parse payment terms (e.g., "Net 30" -> 30 days)
  const paymentDays = parsePaymentTerms(customer.creditApplication.paymentTerms);

  const phones: XeroContact['Phones'] = [
    { PhoneType: 'DEFAULT', PhoneNumber: contact.phone },
  ];

  if (contact.mobile) {
    phones.push({ PhoneType: 'MOBILE', PhoneNumber: contact.mobile });
  }

  return {
    ContactNumber: customer.id,  // Local customer ID as unique Xero key
    TaxNumber: customer.abn,     // ABN for reference in Xero
    Name: customer.businessName,
    FirstName: contact.firstName,
    LastName: contact.lastName,
    EmailAddress: contact.email,
    Phones: phones,
    Addresses: [
      {
        AddressType: 'STREET',
        AddressLine1: deliveryAddr.street,
        City: deliveryAddr.suburb,
        Region: deliveryAddr.state,
        PostalCode: deliveryAddr.postcode,
        Country: 'Australia',
      },
      {
        AddressType: 'POBOX',
        AddressLine1: billingAddr.street,
        City: billingAddr.suburb,
        Region: billingAddr.state,
        PostalCode: billingAddr.postcode,
        Country: 'Australia',
      },
    ],
    IsCustomer: true,
    DefaultCurrency: 'AUD',
    PaymentTerms: paymentDays
      ? {
          Sales: {
            Day: paymentDays,
            Type: 'DAYSAFTERBILLDATE',
          },
        }
      : undefined,
  };
}

/**
 * Sync a customer to Xero as a Contact
 * Creates a new contact or updates an existing one
 * Includes duplicate detection to prevent creating duplicate contacts
 */
export async function syncContactToXero(customer: CustomerForXeroSync): Promise<{
  success: boolean;
  contactId?: string;
  error?: string;
}> {
  try {
    const contactPayload = mapCustomerToXeroContact(customer);

    // If customer already has a Xero contact ID, update the existing contact
    if (customer.xeroContactId) {
      const response = await xeroApiRequest<XeroContactsResponse>(
        `/Contacts/${customer.xeroContactId}`,
        { method: 'POST', body: { Contacts: [contactPayload] } }
      );
      xeroLogger.sync.contactUpdated(response.Contacts[0].ContactID!, customer.id, customer.businessName);
      return { success: true, contactId: response.Contacts[0].ContactID };
    }

    // Create new contact in Xero using PUT (Xero's reversed REST: PUT = create-only,
    // POST = upsert by Name which can silently overwrite existing contacts)
    try {
      const response = await xeroApiRequest<XeroContactsResponse>('/Contacts', {
        method: 'PUT',
        body: { Contacts: [contactPayload] },
      });

      xeroLogger.sync.contactCreated(response.Contacts[0].ContactID!, customer.id, customer.businessName);
      return { success: true, contactId: response.Contacts[0].ContactID };
    } catch (createError) {
      // If PUT fails due to duplicate Name, retry with a disambiguated name
      if (
        createError instanceof XeroApiError &&
        createError.statusCode === 400 &&
        createError.responseBody.toLowerCase().includes('already assigned to another contact')
      ) {
        const disambiguatedName = `${customer.businessName} (CustomerID: ${customer.abn})`;
        xeroLogger.warn(
          `Duplicate Xero contact name "${customer.businessName}" — creating as "${disambiguatedName}"`,
          { customerId: customer.id, originalName: customer.businessName } as any
        );

        const retryPayload = { ...contactPayload, Name: disambiguatedName };
        const response = await xeroApiRequest<XeroContactsResponse>('/Contacts', {
          method: 'PUT',
          body: { Contacts: [retryPayload] },
        });

        xeroLogger.sync.contactCreated(response.Contacts[0].ContactID!, customer.id, disambiguatedName);
        return { success: true, contactId: response.Contacts[0].ContactID };
      }
      throw createError;
    }
  } catch (error) {
    xeroLogger.error(`Contact sync failed for customer ${customer.id} (${customer.businessName})`, {
      customerId: customer.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    const baseMessage = error instanceof Error ? error.message : 'Failed to sync contact';
    return {
      success: false,
      error: `Customer "${customer.businessName}" (${customer.id}): ${baseMessage}`,
    };
  }
}

// ============================================================================
// Item Sync (auto-create Xero Items before invoicing)
// ============================================================================

/**
 * Map a Product record to a Xero Item payload for upsert
 */
function mapProductToXeroItem(product: {
  sku: string;
  name: string;
  description: string | null;
  basePrice: number; // In cents
  applyGst: boolean;
}): XeroItem {
  const code = product.sku.slice(0, 30);
  if (product.sku.length > 30) {
    xeroLogger.warn(`SKU truncated from ${product.sku.length} to 30 chars: "${product.sku}"`, {
      sku: product.sku,
    } as any);
  }

  const name = product.name.slice(0, 50);
  if (product.name.length > 50) {
    xeroLogger.warn(`Product name truncated from ${product.name.length} to 50 chars: "${product.name}"`, {
      sku: product.sku,
    } as any);
  }

  return {
    Code: code,
    Name: name,
    Description: product.description || product.name,
    IsSold: true,
    IsPurchased: false,
    IsTrackedAsInventory: false,
    SalesDetails: {
      UnitPrice: product.basePrice / 100, // Convert cents to dollars
      AccountCode: getXeroSalesAccountCode(),
      TaxType: product.applyGst ? getXeroGstTaxType() : getXeroGstFreeTaxType(),
    },
  };
}

/**
 * Ensure all Xero Items exist for the given order items.
 * Syncs items via POST /Items (upsert) and caches the Xero Item ID
 * on the Product record to skip future API calls.
 */
export async function ensureXeroItemsExist(
  orderItems: OrderItemForXeroSync[]
): Promise<{ success: boolean; createdCount: number; skippedCount: number; errors: string[] }> {
  // Deduplicate by productId
  const uniqueProductIds = [...new Set(orderItems.map((item) => item.productId))];

  // Batch-fetch product records from DB
  const products = await prisma.product.findMany({
    where: { id: { in: uniqueProductIds } },
    select: {
      id: true,
      sku: true,
      name: true,
      description: true,
      basePrice: true,
      applyGst: true,
      xeroItemId: true,
    },
  });

  // Filter out products where xeroItemId is already cached
  const uncachedProducts = products.filter((p) => !p.xeroItemId);
  let skippedCount = products.length - uncachedProducts.length;

  let createdCount = 0;
  const errors: string[] = [];

  for (const product of uncachedProducts) {
    try {
      // Check if item already exists in Xero by Code/SKU
      const existingItemId = await findExistingItemByCode(product.sku);
      if (existingItemId) {
        await prisma.product.update({
          where: { id: product.id },
          data: { xeroItemId: existingItemId },
        });
        xeroLogger.sync.itemCreated(existingItemId, product.id, product.sku);
        skippedCount++;
        continue;
      }

      const itemPayload = mapProductToXeroItem(product);
      const response = await xeroApiRequest<XeroItemsResponse>('/Items', {
        method: 'POST',
        body: { Items: [itemPayload] },
      });

      const createdItem = response.Items[0];
      if (createdItem?.ItemID) {
        await prisma.product.update({
          where: { id: product.id },
          data: { xeroItemId: createdItem.ItemID },
        });
        xeroLogger.sync.itemCreated(createdItem.ItemID, product.id, product.sku);
        createdCount++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`SKU "${product.sku}": ${message}`);
      xeroLogger.error(`Failed to create Xero item for SKU "${product.sku}"`, {
        error: message,
      } as any);
    }
  }

  return { success: errors.length === 0, createdCount, skippedCount, errors };
}

// ============================================================================
// Invoice Creation
// ============================================================================

/**
 * Create an invoice in Xero from an order
 * Includes duplicate detection to prevent creating duplicate invoices
 */
export async function createInvoiceInXero(
  order: OrderForXeroSync,
  customer: CustomerForXeroSync
): Promise<{
  success: boolean;
  invoiceId?: string;
  invoiceNumber?: string;
  error?: string;
}> {
  try {
    if (!customer.xeroContactId) {
      return { success: false, error: 'Customer not synced to Xero' };
    }

    // Check local record for existing invoice
    if (order.xero?.invoiceId) {
      return {
        success: true,
        invoiceId: order.xero.invoiceId,
        invoiceNumber: order.xero.invoiceNumber || undefined,
        error: undefined,
      };
    }

    // Check Xero directly for existing invoice by order number (Reference field)
    // This catches cases where invoice was created but local record wasn't updated
    const existingInvoice = await findExistingInvoiceByReference(order.orderNumber);
    if (existingInvoice) {
      return {
        success: true,
        invoiceId: existingInvoice.invoiceId,
        invoiceNumber: existingInvoice.invoiceNumber,
      };
    }

    // Ensure all Xero Items exist before creating the invoice
    const itemsResult = await ensureXeroItemsExist(order.items);
    if (!itemsResult.success) {
      return {
        success: false,
        error: `Failed to create Xero items: ${itemsResult.errors.join('; ')}`,
      };
    }

    // Calculate due date from payment terms
    const paymentDays = parsePaymentTerms(customer.creditApplication.paymentTerms) || 30;
    // Use the date when order became ready_for_delivery (when invoice should be created)
    // Fall back to delivery date or current date for backwards compatibility
    const readyForDeliveryEntry = order.statusHistory?.find(
      (h) => h.status === 'ready_for_delivery'
    );
    const invoiceDate = readyForDeliveryEntry?.changedAt
      ? new Date(readyForDeliveryEntry.changedAt)
      : order.delivery?.deliveredAt || new Date();
    const dueDate = new Date(invoiceDate);
    dueDate.setDate(dueDate.getDate() + paymentDays);

    // Separate zeroed items (qty=0 set during packing) from active items
    const zeroedItems = order.items.filter((item) => item.quantity === 0);
    const activeItems = order.items.filter((item) => item.quantity > 0);

    // Map active order items to Xero line items
    const lineItems: XeroLineItem[] = activeItems.map((item) => ({
      Description: `${item.productName} (${item.sku})`,
      Quantity: item.quantity,
      UnitAmount: item.unitPrice / 100, // Convert cents to dollars
      AccountCode: getXeroSalesAccountCode(),
      TaxType: item.applyGst ? getXeroGstTaxType() : getXeroGstFreeTaxType(),
      ItemCode: item.sku,
    }));

    // Add zeroed items as descriptive $0 line items (Xero rejects Quantity=0)
    if (zeroedItems.length > 0) {
      for (const item of zeroedItems) {
        lineItems.push({
          Description: `[Removed during packing] ${item.productName} (${item.sku})`,
          Quantity: 1,
          UnitAmount: 0,
          AccountCode: getXeroSalesAccountCode(),
          TaxType: getXeroGstFreeTaxType(), // No GST on $0 items
          ItemCode: item.sku,
        });
      }
    }

    const invoice: XeroInvoice = {
      Type: 'ACCREC',
      Contact: { ContactID: customer.xeroContactId },
      LineItems: lineItems,
      Date: formatXeroDate(invoiceDate),
      DueDate: formatXeroDate(dueDate),
      Status: 'AUTHORISED', // Auto-approve invoices
      CurrencyCode: 'AUD',
      Reference: order.orderNumber,
      LineAmountTypes: 'Exclusive', // Prices exclude GST, GST added
    };

    const response = await xeroApiRequest<XeroInvoicesResponse>('/Invoices', {
      method: 'POST',
      body: { Invoices: [invoice] },
    });

    const createdInvoice = response.Invoices[0];
    xeroLogger.sync.invoiceCreated(
      createdInvoice.InvoiceID!,
      createdInvoice.InvoiceNumber!,
      order.id,
      order.orderNumber
    );
    return {
      success: true,
      invoiceId: createdInvoice.InvoiceID,
      invoiceNumber: createdInvoice.InvoiceNumber,
    };
  } catch (error) {
    xeroLogger.error('Invoice creation failed', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create invoice',
    };
  }
}

/**
 * Update an existing invoice in Xero with current order data
 * Only works for DRAFT or AUTHORISED invoices (not PAID, VOIDED, or DELETED)
 */
export async function updateInvoiceInXero(
  order: OrderForXeroSync,
  customer: CustomerForXeroSync
): Promise<{
  success: boolean;
  invoiceId?: string;
  invoiceNumber?: string;
  error?: string;
}> {
  try {
    if (!customer.xeroContactId) {
      return { success: false, error: 'Customer not synced to Xero' };
    }

    if (!order.xero?.invoiceId) {
      return { success: false, error: 'Order has no existing invoice to update' };
    }

    // Fetch current invoice to check status
    const existingInvoiceResponse = await xeroApiRequest<XeroInvoicesResponse>(
      `/Invoices/${order.xero.invoiceId}`
    );

    if (!existingInvoiceResponse.Invoices || existingInvoiceResponse.Invoices.length === 0) {
      return { success: false, error: 'Invoice not found in Xero' };
    }

    const existingInvoice = existingInvoiceResponse.Invoices[0];
    const currentStatus = existingInvoice.Status;

    // Check if invoice can be updated
    const nonUpdatableStatuses = ['PAID', 'VOIDED', 'DELETED'];
    if (nonUpdatableStatuses.includes(currentStatus)) {
      return {
        success: false,
        error: `Cannot update invoice with status "${currentStatus}". Only DRAFT or AUTHORISED invoices can be updated.`,
      };
    }

    // Calculate due date from payment terms
    const paymentDays = parsePaymentTerms(customer.creditApplication.paymentTerms) || 30;
    const invoiceDate = order.delivery?.deliveredAt || new Date();
    const dueDate = new Date(invoiceDate);
    dueDate.setDate(dueDate.getDate() + paymentDays);

    // Map order items to Xero line items
    const lineItems: XeroLineItem[] = order.items.map((item) => ({
      Description: `${item.productName} (${item.sku})`,
      Quantity: item.quantity,
      UnitAmount: item.unitPrice / 100, // Convert cents to dollars
      AccountCode: getXeroSalesAccountCode(),
      TaxType: item.applyGst ? getXeroGstTaxType() : getXeroGstFreeTaxType(),
      ItemCode: item.sku,
    }));

    const invoice: XeroInvoice = {
      InvoiceID: order.xero.invoiceId,
      Type: 'ACCREC',
      Contact: { ContactID: customer.xeroContactId },
      LineItems: lineItems,
      Date: formatXeroDate(invoiceDate),
      DueDate: formatXeroDate(dueDate),
      Status: currentStatus as 'DRAFT' | 'SUBMITTED' | 'AUTHORISED', // Preserve current status
      CurrencyCode: 'AUD',
      Reference: order.orderNumber,
      LineAmountTypes: 'Exclusive',
    };

    const response = await xeroApiRequest<XeroInvoicesResponse>('/Invoices', {
      method: 'POST',
      body: { Invoices: [invoice] },
    });

    const updatedInvoice = response.Invoices[0];
    xeroLogger.sync.invoiceUpdated(
      updatedInvoice.InvoiceID!,
      updatedInvoice.InvoiceNumber!,
      order.id,
      order.orderNumber
    );
    return {
      success: true,
      invoiceId: updatedInvoice.InvoiceID,
      invoiceNumber: updatedInvoice.InvoiceNumber,
    };
  } catch (error) {
    xeroLogger.error('Invoice update failed', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      invoiceId: order.xero?.invoiceId || undefined,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update invoice',
    };
  }
}

// ============================================================================
// Credit Note Creation
// ============================================================================

/**
 * Allocate a credit note to an invoice in Xero
 */
async function allocateCreditNoteToInvoice(
  creditNoteId: string,
  invoiceId: string,
  amount: number // In dollars
): Promise<void> {
  await xeroApiRequest(`/CreditNotes/${creditNoteId}/Allocations`, {
    method: 'PUT',
    body: {
      Allocations: [
        {
          Invoice: { InvoiceID: invoiceId },
          Amount: amount,
          Date: formatXeroDate(new Date()),
        },
      ],
    },
  });
}

/**
 * Create a credit note in Xero for a cancelled order
 * Includes duplicate detection to prevent creating duplicate credit notes
 */
export async function createCreditNoteInXero(
  order: OrderForXeroSync,
  customer: CustomerForXeroSync
): Promise<{
  success: boolean;
  creditNoteId?: string;
  creditNoteNumber?: string;
  error?: string;
}> {
  try {
    if (!customer.xeroContactId) {
      return { success: false, error: 'Customer not synced to Xero' };
    }

    if (!order.xero?.invoiceId) {
      return { success: false, error: 'Order has no invoice to credit' };
    }

    // Check local record for existing credit note
    if (order.xero.creditNoteId) {
      return {
        success: true,
        creditNoteId: order.xero.creditNoteId,
        creditNoteNumber: order.xero.creditNoteNumber || undefined,
      };
    }

    // Check Xero directly for existing credit note by reference
    // This catches cases where credit note was created but local record wasn't updated
    const creditNoteReference = `Credit for Order ${order.orderNumber}`;
    const existingCreditNote = await findExistingCreditNoteByReference(creditNoteReference);
    if (existingCreditNote) {
      return {
        success: true,
        creditNoteId: existingCreditNote.creditNoteId,
        creditNoteNumber: existingCreditNote.creditNoteNumber,
      };
    }

    // Map order items to credit note line items
    const lineItems: XeroLineItem[] = order.items.map((item) => ({
      Description: `Credit: ${item.productName} (${item.sku})`,
      Quantity: item.quantity,
      UnitAmount: item.unitPrice / 100, // Convert cents to dollars
      AccountCode: getXeroSalesAccountCode(),
      TaxType: item.applyGst ? getXeroGstTaxType() : getXeroGstFreeTaxType(),
    }));

    const creditNote: XeroCreditNote = {
      Type: 'ACCRECCREDIT',
      Contact: { ContactID: customer.xeroContactId },
      LineItems: lineItems,
      Date: formatXeroDate(new Date()),
      Status: 'AUTHORISED',
      CurrencyCode: 'AUD',
      Reference: `Credit for Order ${order.orderNumber}`,
      LineAmountTypes: 'Exclusive',
    };

    const response = await xeroApiRequest<XeroCreditNotesResponse>('/CreditNotes', {
      method: 'POST',
      body: { CreditNotes: [creditNote] },
    });

    const createdCreditNote = response.CreditNotes[0];
    xeroLogger.sync.creditNoteCreated(
      createdCreditNote.CreditNoteID!,
      createdCreditNote.CreditNoteNumber!,
      order.id,
      order.orderNumber
    );

    // Allocate credit note to original invoice
    if (createdCreditNote.CreditNoteID && order.xero.invoiceId) {
      try {
        await allocateCreditNoteToInvoice(
          createdCreditNote.CreditNoteID,
          order.xero.invoiceId,
          order.totalAmount / 100 // Convert cents to dollars
        );
        xeroLogger.sync.creditNoteAllocated(
          createdCreditNote.CreditNoteNumber!,
          order.xero.invoiceNumber || order.xero.invoiceId
        );
      } catch (allocError) {
        xeroLogger.error('Credit note allocation failed', {
          creditNoteId: createdCreditNote.CreditNoteID,
          invoiceId: order.xero.invoiceId,
          error: allocError instanceof Error ? allocError.message : 'Unknown error',
        });
        // Continue even if allocation fails - credit note is still created
      }
    }

    return {
      success: true,
      creditNoteId: createdCreditNote.CreditNoteID,
      creditNoteNumber: createdCreditNote.CreditNoteNumber,
    };
  } catch (error) {
    xeroLogger.error('Credit note creation failed', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create credit note',
    };
  }
}

export interface PartialCreditNotePayload {
  type: 'partial';
  reason: string;
  createdBy: string;
  items: Array<{
    productId: string;
    sku: string;
    productName: string;
    quantity: number;
    unitPrice: number; // cents
    subtotal: number; // cents
    applyGst: boolean;
  }>;
}

export async function createPartialCreditNoteInXero(
  order: OrderForXeroSync,
  customer: CustomerForXeroSync,
  payload: PartialCreditNotePayload,
  sequenceNumber: number
): Promise<{
  success: boolean;
  creditNoteId?: string;
  creditNoteNumber?: string;
  amount?: number; // total in cents (incl GST)
  error?: string;
}> {
  try {
    if (!customer.xeroContactId) {
      return { success: false, error: 'Customer not synced to Xero' };
    }

    if (!order.xero?.invoiceId) {
      return { success: false, error: 'Order has no invoice to credit' };
    }

    // Generate unique reference for this partial credit note
    const creditNoteReference = `Partial Credit for Order ${order.orderNumber} #${sequenceNumber}`;

    // Check Xero for existing credit note by reference (idempotency)
    const existingCreditNote = await findExistingCreditNoteByReference(creditNoteReference);
    if (existingCreditNote) {
      return {
        success: true,
        creditNoteId: existingCreditNote.creditNoteId,
        creditNoteNumber: existingCreditNote.creditNoteNumber,
      };
    }

    // Map only selected items to Xero line items
    const lineItems: XeroLineItem[] = payload.items.map((item) => ({
      Description: `Credit: ${item.productName} (${item.sku})`,
      Quantity: item.quantity,
      UnitAmount: item.unitPrice / 100, // Convert cents to dollars
      AccountCode: getXeroSalesAccountCode(),
      TaxType: item.applyGst ? getXeroGstTaxType() : getXeroGstFreeTaxType(),
    }));

    const creditNote: XeroCreditNote = {
      Type: 'ACCRECCREDIT',
      Contact: { ContactID: customer.xeroContactId },
      LineItems: lineItems,
      Date: formatXeroDate(new Date()),
      Status: 'AUTHORISED',
      CurrencyCode: 'AUD',
      Reference: creditNoteReference,
      LineAmountTypes: 'Exclusive',
    };

    const response = await xeroApiRequest<XeroCreditNotesResponse>('/CreditNotes', {
      method: 'POST',
      body: { CreditNotes: [creditNote] },
    });

    const createdCreditNote = response.CreditNotes[0];
    xeroLogger.sync.creditNoteCreated(
      createdCreditNote.CreditNoteID!,
      createdCreditNote.CreditNoteNumber!,
      order.id,
      order.orderNumber
    );

    // Calculate total amount in dollars for allocation
    // Sum up item subtotals, then add GST for GST-applicable items
    let subtotalCents = 0;
    let gstCents = 0;
    for (const item of payload.items) {
      subtotalCents += item.subtotal;
      if (item.applyGst) {
        gstCents += Math.round(item.subtotal * 0.1);
      }
    }
    const totalCents = subtotalCents + gstCents;
    const totalDollars = totalCents / 100;

    // Allocate credit note to original invoice
    if (createdCreditNote.CreditNoteID && order.xero.invoiceId) {
      try {
        await allocateCreditNoteToInvoice(
          createdCreditNote.CreditNoteID,
          order.xero.invoiceId,
          totalDollars
        );
        xeroLogger.sync.creditNoteAllocated(
          createdCreditNote.CreditNoteNumber!,
          order.xero.invoiceNumber || order.xero.invoiceId
        );
      } catch (allocError) {
        xeroLogger.error('Partial credit note allocation failed', {
          creditNoteId: createdCreditNote.CreditNoteID,
          invoiceId: order.xero.invoiceId,
          error: allocError instanceof Error ? allocError.message : 'Unknown error',
        });
        // Continue even if allocation fails - credit note is still created
      }
    }

    return {
      success: true,
      creditNoteId: createdCreditNote.CreditNoteID,
      creditNoteNumber: createdCreditNote.CreditNoteNumber,
      amount: totalCents,
    };
  } catch (error) {
    xeroLogger.error('Partial credit note creation failed', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create partial credit note',
    };
  }
}


// ============================================================================
// Invoice Retrieval for Customers (with Caching)
// ============================================================================

/**
 * In-memory cache for invoice data with TTL
 * Cache key: invoiceId, value: { data: XeroInvoice, expires: timestamp }
 */
const invoiceCache = new Map<
  string,
  { data: XeroInvoice & { Total?: number; TotalTax?: number; AmountDue?: number; AmountPaid?: number }; expires: number }
>();

/**
 * Get cached invoice data or fetch from Xero with caching
 * Respects XERO_INTEGRATION_ENABLED environment variable
 * Returns null if invoice not found or integration disabled
 */
export async function getCachedInvoice(
  invoiceId: string
): Promise<(XeroInvoice & { Total?: number; TotalTax?: number; AmountDue?: number; AmountPaid?: number }) | null> {
  // Check if Xero integration is enabled
  if (!isXeroIntegrationEnabled()) {
    throw new Error('Xero integration is disabled');
  }

  // Check cache first
  const cached = invoiceCache.get(invoiceId);
  if (cached && cached.expires > Date.now()) {
    xeroLogger.cache.hit(`invoice:${invoiceId}`, { invoiceId });
    return cached.data;
  }

  xeroLogger.cache.miss(`invoice:${invoiceId}`, { invoiceId });

  try {
    const response = await xeroApiRequest<XeroInvoicesResponse>(`/Invoices/${invoiceId}`);

    if (!response.Invoices || response.Invoices.length === 0) {
      return null;
    }

    const invoice = response.Invoices[0];

    // Cache the invoice for 5 minutes
    invoiceCache.set(invoiceId, {
      data: invoice as any,
      expires: Date.now() + 5 * 60 * 1000,
    });
    xeroLogger.cache.set(`invoice:${invoiceId}`, { invoiceId });

    return invoice as any;
  } catch (error) {
    xeroLogger.error(`Failed to fetch invoice ${invoiceId}`, {
      invoiceId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

/**
 * Get a temporary PDF download URL for an invoice
 * Respects XERO_INTEGRATION_ENABLED environment variable
 * Returns null if integration is disabled
 */
export async function getInvoicePdfUrl(invoiceId: string): Promise<string | null> {
  // NOTE: This function returns a Xero OnlineInvoice URL which requires Xero login.
  // For actual PDF download without login, use getInvoicePdfBuffer() instead.
  if (!isXeroIntegrationEnabled()) {
    xeroLogger.warn('Cannot get PDF URL: Xero integration is disabled');
    return null;
  }

  try {
    const response = await xeroApiRequest<{ OnlineInvoices: Array<{ Url: string }> }>(
      `/Invoices/${invoiceId}/OnlineInvoice`
    );

    xeroLogger.debug('OnlineInvoice API response', {
      invoiceId,
      responseKeys: Object.keys(response || {}),
      onlineInvoices: response.OnlineInvoices,
    });

    if (response.OnlineInvoices && response.OnlineInvoices.length > 0) {
      return response.OnlineInvoices[0].Url;
    }

    xeroLogger.warn('No OnlineInvoice URL in response', {
      invoiceId,
      response: JSON.stringify(response),
    });
    return null;
  } catch (error) {
    xeroLogger.error(`Failed to get PDF URL for invoice ${invoiceId}`, {
      invoiceId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}


/**
 * Fetches an invoice as a PDF binary buffer from Xero.
 * Uses the correct Xero API approach: GET /Invoices/{id} with Accept: application/pdf header.
 *
 * @param invoiceId - The Xero invoice ID
 * @returns Buffer containing the PDF binary data
 * @throws Error if Xero integration is disabled or the request fails
 */
export async function getInvoicePdfBuffer(invoiceId: string): Promise<Buffer> {
  if (!isXeroIntegrationEnabled()) {
    throw new Error('Xero integration is disabled');
  }

  await enforceRateLimit();
  const { accessToken, tenantId } = await getValidAccessToken();

  xeroLogger.debug(`Fetching PDF for invoice ${invoiceId}`);

  const response = await fetch(`${XERO_API_BASE}/Invoices/${invoiceId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'xero-tenant-id': tenantId,
      'Accept': 'application/pdf', // KEY: Request PDF format instead of JSON
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    xeroLogger.error(`Failed to fetch PDF for invoice ${invoiceId}`, {
      statusCode: response.status,
      error: errorText,
    });
    throw new XeroApiError(response.status, `/Invoices/${invoiceId}`, errorText);
  }

  const arrayBuffer = await response.arrayBuffer();
  xeroLogger.debug(`Successfully fetched PDF for invoice ${invoiceId}, size: ${arrayBuffer.byteLength} bytes`);

  return Buffer.from(arrayBuffer);
}

/**
 * Clear the invoice cache (for testing or manual refresh)
 */
export function clearInvoiceCache(invoiceId?: string): void {
  if (invoiceId) {
    invoiceCache.delete(invoiceId);
  } else {
    invoiceCache.clear();
  }
}
