/**
 * Xero Sync Job Queue Service
 *
 * This service handles on-demand processing of Xero sync jobs.
 * Jobs are processed immediately when triggered (no background polling).
 * Failed jobs can be manually retried via the admin API.
 */

import { prisma } from '@joho-erp/database';
import { getTodayAsUTCMidnight } from '@joho-erp/shared';
import type { XeroSyncJob, XeroSyncJobType, XeroSyncJobStatus } from '@joho-erp/database';
import {
  syncContactToXero,
  createInvoiceInXero,
  createCreditNoteInXero,
  createPartialCreditNoteInXero,
  updateInvoiceInXero,
  fetchContactBalance,
  fetchInvoiceContactId,
  isConnected,
  isXeroIntegrationEnabled,
  XeroApiError,
} from './xero';
import type { PartialCreditNotePayload } from './xero';
import { sendCreditNoteIssuedEmail, sendXeroSyncErrorEmail } from './email';
import { xeroLogger, startTimer } from '../utils/logger';

// ============================================================================
// Retry Helpers
// ============================================================================

/**
 * Determine if an error is retryable (transient errors that may succeed on retry)
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof XeroApiError) {
    return error.isRetryable;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Network errors and timeouts are retryable
    return msg.includes('network') || 
           msg.includes('timeout') || 
           msg.includes('econnreset') ||
           msg.includes('econnrefused') ||
           msg.includes('socket hang up');
  }
  return false;
}

/**
 * Calculate exponential backoff delay for retry attempts
 * Returns delay in milliseconds, capped at 60 seconds
 */
function calculateNextAttemptDelay(attempt: number): number {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped)
  return Math.min(1000 * Math.pow(2, attempt - 1), 60000);
}

/**
 * Handle job failure - either schedule retry or mark as permanently failed
 */
async function handleJobFailure(
  job: XeroSyncJob,
  error: unknown,
  currentAttempt: number
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  const canRetry = isRetryableError(error) && currentAttempt < job.maxAttempts;

  if (canRetry) {
    // Schedule retry with exponential backoff
    const delayMs = calculateNextAttemptDelay(currentAttempt);
    const nextAttemptAt = new Date(Date.now() + delayMs);
    
    xeroLogger.job.retrying(job.id, job.type, currentAttempt, job.maxAttempts, delayMs, {
      entityType: job.entityType,
      entityId: job.entityId,
    });

    await prisma.xeroSyncJob.update({
      where: { id: job.id },
      data: {
        status: 'pending',
        error: errorMessage,
        nextAttemptAt,
      },
    });

    // Schedule the retry
    setTimeout(() => {
      prisma.xeroSyncJob.findUnique({ where: { id: job.id } })
        .then((updatedJob) => {
          if (updatedJob && updatedJob.status === 'pending') {
            processJob(updatedJob).catch((err) => {
              xeroLogger.error(`Retry failed for job ${job.id}`, {
                jobId: job.id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        })
        .catch((err) => {
          xeroLogger.error(`Failed to fetch job for retry ${job.id}`, {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, delayMs);
  } else {
    // Permanent failure - mark as failed and notify
    xeroLogger.job.failed(job.id, job.type, errorMessage, currentAttempt, job.maxAttempts, {
      entityType: job.entityType,
      entityId: job.entityId,
    });
    
    await prisma.xeroSyncJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        error: errorMessage,
      },
    });

    // Send failure notification email
    await notifyJobFailure(job, errorMessage, currentAttempt);
  }
}

/**
 * Send email notification for permanent job failures
 */
async function notifyJobFailure(
  job: XeroSyncJob,
  errorMessage: string,
  attempts: number
): Promise<void> {
  try {
    // Get entity name for the notification
    let entityName = job.entityId;
    
    if (job.entityType === 'customer') {
      const customer = await prisma.customer.findUnique({
        where: { id: job.entityId },
        select: { businessName: true },
      });
      entityName = customer?.businessName || job.entityId;
    } else if (job.entityType === 'order') {
      const order = await prisma.order.findUnique({
        where: { id: job.entityId },
        select: { orderNumber: true },
      });
      entityName = order?.orderNumber || job.entityId;
    }

    await sendXeroSyncErrorEmail({
      entityType: job.entityType as 'customer' | 'order',
      entityId: job.entityId,
      entityName,
      errorMessage,
      attempts,
    });
  } catch (emailError) {
    xeroLogger.error(`Failed to send failure notification email for job ${job.id}`, {
      jobId: job.id,
      error: emailError instanceof Error ? emailError.message : String(emailError),
    });
  }
}

// ============================================================================
// Job Enqueueing
// ============================================================================

/**
 * Enqueue a Xero sync job and process it immediately
 * Returns the job ID for tracking, or null if Xero integration is disabled
 */
export async function enqueueXeroJob(
  type: 'sync_contact' | 'create_invoice' | 'create_credit_note' | 'update_invoice' | 'balance_sync',
  entityType: 'customer' | 'order',
  entityId: string,
  payload?: Record<string, unknown>
): Promise<string | null> {
  // Skip if Xero integration is disabled
  if (!isXeroIntegrationEnabled()) {
    xeroLogger.debug('Xero integration is disabled, skipping job creation', { type, entityType, entityId });
    return null;
  }

  // Coalescing: balance_sync jobs are idempotent — re-running them just refreshes
  // the cached AR snapshot from Xero. A busy customer can generate dozens of
  // webhook + reconciler enqueues per day; without coalescing they each consume
  // a slot in the 55/min Xero rate limit. If a pending/processing balance_sync
  // job already exists for this customer, return its id rather than create a
  // duplicate. This is intentionally limited to balance_sync — invoice/credit-note
  // jobs MUST run individually because each carries unique payload semantics.
  if (type === 'balance_sync') {
    const existing = await prisma.xeroSyncJob.findFirst({
      where: {
        type: 'balance_sync' as XeroSyncJobType,
        entityType,
        entityId,
        status: { in: ['pending' as XeroSyncJobStatus, 'processing' as XeroSyncJobStatus] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (existing) {
      xeroLogger.debug('Coalescing balance_sync into existing in-flight job', {
        existingJobId: existing.id,
        entityType,
        entityId,
      });
      return existing.id;
    }
  }

  // Create the job record
  const job = await prisma.xeroSyncJob.create({
    data: {
      type: type as XeroSyncJobType,
      entityType,
      entityId,
      payload: payload ? JSON.parse(JSON.stringify(payload)) : undefined,
      status: 'pending' as XeroSyncJobStatus,
      nextAttemptAt: new Date(),
    },
  });

  xeroLogger.job.queued(job.id, type, { entityType, entityId });

  // Process immediately (fire and forget)
  processJob(job).catch((error) => {
    xeroLogger.error(`Failed to process Xero job ${job.id}`, {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return job.id;
}

// ============================================================================
// Job Processing
// ============================================================================

/**
 * Process a single Xero sync job
 */
async function processJob(job: XeroSyncJob): Promise<void> {
  const currentAttempt = job.attempts + 1;
  const timer = startTimer();

  xeroLogger.job.started(job.id, job.type, {
    entityType: job.entityType,
    entityId: job.entityId,
    attempt: currentAttempt,
    maxAttempts: job.maxAttempts,
  });

  // Check if Xero is connected
  const connected = await isConnected();
  if (!connected) {
    // Connection errors are potentially retryable (user may reconnect)
    await handleJobFailure(
      job,
      new Error('Xero is not connected'),
      currentAttempt
    );
    // Still update attempt count
    await prisma.xeroSyncJob.update({
      where: { id: job.id },
      data: { lastAttemptAt: new Date(), attempts: currentAttempt },
    });
    return;
  }

  // Mark as processing
  await prisma.xeroSyncJob.update({
    where: { id: job.id },
    data: {
      status: 'processing',
      lastAttemptAt: new Date(),
      attempts: currentAttempt,
    },
  });

  try {
    let result: {
      success: boolean;
      error?: string;
      [key: string]: unknown;
    };

    switch (job.type) {
      case 'sync_contact':
        result = await processSyncContact(job.entityId);
        break;
      case 'create_invoice':
        result = await processCreateInvoice(job.entityId, job.id);
        break;
      case 'create_credit_note':
        result = await processCreateCreditNote(job.entityId, job.id);
        break;
      case 'update_invoice':
        result = await processUpdateInvoice(job.entityId, job.id);
        break;
      case 'balance_sync':
        result = await processBalanceSync(job);
        break;
      default:
        throw new Error(`Unknown job type: ${job.type}`);
    }

    if (result.success) {
      const duration = timer.stop();
      await prisma.xeroSyncJob.update({
        where: { id: job.id },
        data: {
          status: 'completed',
          result: JSON.parse(JSON.stringify(result)),
          completedAt: new Date(),
          error: null,
        },
      });
      xeroLogger.job.completed(job.id, job.type, duration, {
        entityType: job.entityType,
        entityId: job.entityId,
      });
    } else {
      // Application-level errors (validation, business logic) are not retryable
      // These typically indicate bad data that won't be fixed by retrying
      await prisma.xeroSyncJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          error: result.error || 'Unknown error',
        },
      });
      // Still notify about the failure
      await notifyJobFailure(job, result.error || 'Unknown error', currentAttempt);
    }
  } catch (error) {
    // Use handleJobFailure for caught exceptions - it will determine if retryable
    await handleJobFailure(job, error, currentAttempt);
  }
}

// ============================================================================
// Job Processors
// ============================================================================

/**
 * Process a balance_sync job.
 * Reads the AR balance for the contact from Xero and writes it back to
 * Customer.arBalance. The job payload may carry either {customerId, xeroContactId}
 * (from the manual refresh path) or {resourceUrl/resourceId} from a webhook,
 * in which case the invoice must be looked up first to resolve the contact.
 */
async function processBalanceSync(job: XeroSyncJob): Promise<{
  success: boolean;
  outstandingCents?: number;
  overdueCents?: number;
  error?: string;
}> {
  const payload = (job.payload as Record<string, unknown> | null) || {};
  const trigger = (payload.trigger as string | undefined) || 'manual';

  // Step 1: resolve customer record. entityType is always 'customer' for balance_sync.
  let customer = await prisma.customer.findUnique({
    where: { id: job.entityId },
    select: { id: true, xeroContactId: true },
  });

  // Fallback: if the entityId was a placeholder (e.g. webhook hadn't resolved yet),
  // try resolving via xeroContactId in the payload.
  if (!customer) {
    const payloadContactId = payload.xeroContactId as string | undefined;
    if (payloadContactId) {
      customer = await prisma.customer.findFirst({
        where: { xeroContactId: payloadContactId },
        select: { id: true, xeroContactId: true },
      });
    }
  }

  if (!customer) {
    return { success: false, error: 'Customer not found' };
  }

  // Step 2: determine the Xero contact id.
  let xeroContactId = customer.xeroContactId
    || (payload.xeroContactId as string | undefined)
    || null;

  // Last resort: derive from an invoice resource id (webhook path).
  if (!xeroContactId) {
    const resourceId = payload.resourceId as string | undefined;
    if (resourceId) {
      xeroContactId = await fetchInvoiceContactId(resourceId);
    }
  }

  if (!xeroContactId) {
    return { success: false, error: 'Customer has no xeroContactId' };
  }

  // Step 3: fetch + persist.
  const balance = await fetchContactBalance(xeroContactId);

  await prisma.customer.update({
    where: { id: customer.id },
    data: {
      arBalance: {
        outstandingCents: balance.outstandingCents,
        overdueCents: balance.overdueCents,
        currency: balance.currency,
        lastSyncedAt: new Date(),
        lastSyncSource: trigger,
      },
    },
  });

  return {
    success: true,
    outstandingCents: balance.outstandingCents,
    overdueCents: balance.overdueCents,
  };
}

/**
 * Process a sync_contact job
 * Syncs a customer to Xero and updates their xeroContactId
 */
async function processSyncContact(customerId: string): Promise<{
  success: boolean;
  contactId?: string;
  error?: string;
}> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
  });

  if (!customer) {
    return { success: false, error: 'Customer not found' };
  }

  // Cast to the expected type for sync
  const customerForSync = {
    id: customer.id,
    businessName: customer.businessName,
    abn: customer.abn,
    xeroContactId: customer.xeroContactId,
    contactPerson: customer.contactPerson as {
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
      mobile?: string | null;
    },
    deliveryAddress: customer.deliveryAddress as {
      street: string;
      suburb: string;
      state: string;
      postcode: string;
    },
    billingAddress: customer.billingAddress as {
      street: string;
      suburb: string;
      state: string;
      postcode: string;
    } | null,
    creditApplication: customer.creditApplication as {
      paymentTerms?: string | null;
    },
  };

  const result = await syncContactToXero(customerForSync);

  if (result.success && result.contactId) {
    // Update customer with Xero contact ID. If the contact id changes (e.g.
    // re-link to a different Xero contact), clear the cached arBalance so we
    // don't gate credit decisions against the previous contact's balance —
    // the next balance_sync will populate fresh values.
    const contactChanged =
      customer.xeroContactId && customer.xeroContactId !== result.contactId;

    await prisma.customer.update({
      where: { id: customerId },
      data: contactChanged
        ? { xeroContactId: result.contactId, arBalance: null }
        : { xeroContactId: result.contactId },
    });
  }

  return result;
}

/**
 * Process a create_invoice job
 * Creates an invoice in Xero and updates the order's xero info
 */
async function processCreateInvoice(
  orderId: string,
  jobId: string
): Promise<{
  success: boolean;
  invoiceId?: string;
  invoiceNumber?: string;
  error?: string;
}> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { customer: true },
  });

  if (!order) {
    return { success: false, error: 'Order not found' };
  }

  // Check if customer is synced to Xero
  if (!order.customer.xeroContactId) {
    // Try to sync customer first
    const customerSync = await processSyncContact(order.customer.id);
    if (!customerSync.success) {
      return { success: false, error: `Customer sync failed: ${customerSync.error}` };
    }
    // Refresh customer data
    const updatedCustomer = await prisma.customer.findUnique({
      where: { id: order.customer.id },
    });
    if (!updatedCustomer?.xeroContactId) {
      return { success: false, error: 'Failed to get customer Xero contact ID' };
    }
    order.customer.xeroContactId = updatedCustomer.xeroContactId;
  }

  // Cast to the expected types for sync
  const orderForSync = {
    id: order.id,
    orderNumber: order.orderNumber,
    items: (order.items as Array<{
      productId: string;
      sku: string;
      productName: string;
      unit: string;
      quantity: number;
      unitPrice: number;
      subtotal: number;
      applyGst: boolean;
    }>).map((item) => ({
      productId: item.productId,
      sku: item.sku,
      productName: item.productName,
      unit: item.unit,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
      applyGst: item.applyGst ?? false, // Default to false for backwards compatibility
    })),
    subtotal: order.subtotal,
    taxAmount: order.taxAmount,
    totalAmount: order.totalAmount,
    requestedDeliveryDate: order.requestedDeliveryDate,
    xero: order.xero as {
      invoiceId?: string | null;
      invoiceNumber?: string | null;
      invoiceStatus?: string | null;
    } | null,
    delivery: order.delivery as {
      deliveredAt?: Date | null;
    } | null,
    statusHistory: order.statusHistory as Array<{
      status: string;
      changedAt: Date | string;
    }>,
  };

  const customerForSync = {
    id: order.customer.id,
    businessName: order.customer.businessName,
    abn: order.customer.abn,
    xeroContactId: order.customer.xeroContactId,
    contactPerson: order.customer.contactPerson as {
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
      mobile?: string | null;
    },
    deliveryAddress: order.customer.deliveryAddress as {
      street: string;
      suburb: string;
      state: string;
      postcode: string;
    },
    billingAddress: order.customer.billingAddress as {
      street: string;
      suburb: string;
      state: string;
      postcode: string;
    } | null,
    creditApplication: order.customer.creditApplication as {
      paymentTerms?: string | null;
    },
  };

  const result = await createInvoiceInXero(orderForSync, customerForSync);

  if (result.success) {
    // Update order with Xero invoice info
    // Use try-catch to handle DB failures after successful Xero creation
    // Note: createInvoiceInXero checks for existing invoices, so retries are safe
    try {
      const currentXero = (order.xero as Record<string, unknown>) || {};
      await prisma.order.update({
        where: { id: orderId },
        data: {
          xero: {
            ...currentXero,
            invoiceId: result.invoiceId,
            invoiceNumber: result.invoiceNumber,
            invoiceStatus: 'AUTHORISED',
            syncedAt: new Date(),
            syncError: null,
            lastSyncJobId: jobId,
          },
        },
      });
    } catch (dbError) {
      // CRITICAL: Xero invoice was created but we failed to record it in our DB
      // Log all details needed for manual recovery
      xeroLogger.error('CRITICAL: Invoice created in Xero but DB update failed!', {
        orderId,
        orderNumber: order.orderNumber,
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        error: dbError instanceof Error ? dbError.message : String(dbError),
      });
      // Return failure so the job can be retried - createInvoiceInXero will find the existing invoice
      return {
        success: false,
        error: `Invoice created in Xero (${result.invoiceNumber}) but failed to update local database. Invoice ID: ${result.invoiceId}. Please retry - the existing invoice will be detected.`,
      };
    }
  } else {
    // Record error in order
    const currentXero = (order.xero as Record<string, unknown>) || {};
    await prisma.order.update({
      where: { id: orderId },
      data: {
        xero: {
          ...currentXero,
          syncError: result.error,
          lastSyncJobId: jobId,
        },
      },
    });
  }

  return result;
}

/**
 * Process an update_invoice job
 * Updates an existing invoice in Xero with current order data
 */
async function processUpdateInvoice(
  orderId: string,
  jobId: string
): Promise<{
  success: boolean;
  invoiceId?: string;
  invoiceNumber?: string;
  error?: string;
}> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { customer: true },
  });

  if (!order) {
    return { success: false, error: 'Order not found' };
  }

  if (!order.xero || !(order.xero as Record<string, unknown>).invoiceId) {
    return { success: false, error: 'Order has no existing invoice to update' };
  }

  // Check if customer is synced to Xero
  if (!order.customer.xeroContactId) {
    return { success: false, error: 'Customer not synced to Xero' };
  }

  // Cast to the expected types for sync
  const orderForSync = {
    id: order.id,
    orderNumber: order.orderNumber,
    items: (order.items as Array<{
      productId: string;
      sku: string;
      productName: string;
      unit: string;
      quantity: number;
      unitPrice: number;
      subtotal: number;
      applyGst: boolean;
    }>).map((item) => ({
      productId: item.productId,
      sku: item.sku,
      productName: item.productName,
      unit: item.unit,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
      applyGst: item.applyGst ?? false, // Default to false for backwards compatibility
    })),
    subtotal: order.subtotal,
    taxAmount: order.taxAmount,
    totalAmount: order.totalAmount,
    requestedDeliveryDate: order.requestedDeliveryDate,
    xero: order.xero as {
      invoiceId?: string | null;
      invoiceNumber?: string | null;
      invoiceStatus?: string | null;
    } | null,
    delivery: order.delivery as {
      deliveredAt?: Date | null;
    } | null,
  };

  const customerForSync = {
    id: order.customer.id,
    businessName: order.customer.businessName,
    abn: order.customer.abn,
    xeroContactId: order.customer.xeroContactId,
    contactPerson: order.customer.contactPerson as {
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
      mobile?: string | null;
    },
    deliveryAddress: order.customer.deliveryAddress as {
      street: string;
      suburb: string;
      state: string;
      postcode: string;
    },
    billingAddress: order.customer.billingAddress as {
      street: string;
      suburb: string;
      state: string;
      postcode: string;
    } | null,
    creditApplication: order.customer.creditApplication as {
      paymentTerms?: string | null;
    },
  };

  const result = await updateInvoiceInXero(orderForSync, customerForSync);

  if (result.success) {
    // Update order with Xero invoice info
    const currentXero = (order.xero as Record<string, unknown>) || {};
    await prisma.order.update({
      where: { id: orderId },
      data: {
        xero: {
          ...currentXero,
          invoiceId: result.invoiceId,
          invoiceNumber: result.invoiceNumber,
          syncedAt: new Date(),
          syncError: null,
          lastSyncJobId: jobId,
        },
      },
    });
  } else {
    // Record error in order
    const currentXero = (order.xero as Record<string, unknown>) || {};
    await prisma.order.update({
      where: { id: orderId },
      data: {
        xero: {
          ...currentXero,
          syncError: result.error,
          lastSyncJobId: jobId,
        },
      },
    });
  }

  return result;
}

/**
 * Process a create_credit_note job
 * Creates a credit note in Xero and updates the order's xero info
 */
async function processCreateCreditNote(
  orderId: string,
  jobId: string
): Promise<{
  success: boolean;
  creditNoteId?: string;
  creditNoteNumber?: string;
  error?: string;
}> {
  // Fetch the job record to read payload
  const job = await prisma.xeroSyncJob.findUnique({
    where: { id: jobId },
  });

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { customer: true },
  });

  if (!order) {
    return { success: false, error: 'Order not found' };
  }

  // Cast to the expected types for sync
  const orderForSync = {
    id: order.id,
    orderNumber: order.orderNumber,
    items: (order.items as Array<{
      productId: string;
      sku: string;
      productName: string;
      unit: string;
      quantity: number;
      unitPrice: number;
      subtotal: number;
      applyGst: boolean;
    }>).map((item) => ({
      productId: item.productId,
      sku: item.sku,
      productName: item.productName,
      unit: item.unit,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
      applyGst: item.applyGst ?? false, // Default to false for backwards compatibility
    })),
    subtotal: order.subtotal,
    taxAmount: order.taxAmount,
    totalAmount: order.totalAmount,
    requestedDeliveryDate: order.requestedDeliveryDate,
    xero: order.xero as {
      invoiceId?: string | null;
      invoiceNumber?: string | null;
      invoiceStatus?: string | null;
    } | null,
    delivery: order.delivery as {
      deliveredAt?: Date | null;
    } | null,
  };

  const customerForSync = {
    id: order.customer.id,
    businessName: order.customer.businessName,
    abn: order.customer.abn,
    xeroContactId: order.customer.xeroContactId,
    contactPerson: order.customer.contactPerson as {
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
      mobile?: string | null;
    },
    deliveryAddress: order.customer.deliveryAddress as {
      street: string;
      suburb: string;
      state: string;
      postcode: string;
    },
    billingAddress: order.customer.billingAddress as {
      street: string;
      suburb: string;
      state: string;
      postcode: string;
    } | null,
    creditApplication: order.customer.creditApplication as {
      paymentTerms?: string | null;
    },
  };

  // Check if this is a partial credit note
  const payload = job?.payload as Record<string, unknown> | null;
  const isPartial = payload?.type === 'partial';

  if (isPartial) {
    // --- Partial credit note flow ---
    const partialPayload = payload as unknown as PartialCreditNotePayload;

    // Determine sequence number from existing credit notes
    const currentXero = (order.xero as Record<string, unknown>) || {};
    const existingCreditNotes = (currentXero.creditNotes as Array<Record<string, unknown>>) || [];
    const sequenceNumber = existingCreditNotes.length + 1;

    const result = await createPartialCreditNoteInXero(
      orderForSync,
      customerForSync,
      partialPayload,
      sequenceNumber
    );

    if (result.success) {
      // Append to creditNotes array (don't overwrite legacy fields or invoice status)
      const newCreditNoteEntry = {
        creditNoteId: result.creditNoteId || '',
        creditNoteNumber: result.creditNoteNumber || '',
        amount: result.amount || 0, // total in cents (incl GST)
        reason: partialPayload.reason,
        items: partialPayload.items,
        createdAt: new Date(),
        createdBy: partialPayload.createdBy,
      };

      const updatedCreditNotes = [...existingCreditNotes, newCreditNoteEntry];

      await prisma.order.update({
        where: { id: orderId },
        data: {
          xero: {
            ...currentXero,
            creditNotes: updatedCreditNotes,
            syncedAt: new Date(),
            syncError: null,
            lastSyncJobId: jobId,
          } as typeof currentXero,
        },
      });

      // Send itemized credit note email
      await sendCreditNoteIssuedEmail({
        customerEmail: customerForSync.contactPerson.email,
        customerName: customerForSync.businessName,
        orderNumber: order.orderNumber,
        creditNoteNumber: result.creditNoteNumber || '',
        refundAmount: result.amount || 0,
        reason: partialPayload.reason,
        items: partialPayload.items,
      }).catch((error) => {
        xeroLogger.error('Failed to send partial credit note email', {
          orderId: order.id,
          orderNumber: order.orderNumber,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      // Record error in order
      const currentXeroForError = (order.xero as Record<string, unknown>) || {};
      await prisma.order.update({
        where: { id: orderId },
        data: {
          xero: {
            ...currentXeroForError,
            syncError: result.error,
            lastSyncJobId: jobId,
          },
        },
      });
    }

    return result;
  }

  // --- Existing full-refund flow (unchanged) ---
  const result = await createCreditNoteInXero(orderForSync, customerForSync);

  if (result.success) {
    // Update order with credit note info
    const currentXero = (order.xero as Record<string, unknown>) || {};
    await prisma.order.update({
      where: { id: orderId },
      data: {
        xero: {
          ...currentXero,
          creditNoteId: result.creditNoteId,
          creditNoteNumber: result.creditNoteNumber,
          invoiceStatus: 'CREDITED',
          syncedAt: new Date(),
          syncError: null,
          lastSyncJobId: jobId,
        },
      },
    });

    // Send credit note issued email to customer
    const cancellationReason = (order as { cancellationReason?: string }).cancellationReason;
    await sendCreditNoteIssuedEmail({
      customerEmail: customerForSync.contactPerson.email,
      customerName: customerForSync.businessName,
      orderNumber: order.orderNumber,
      creditNoteNumber: result.creditNoteNumber || '',
      refundAmount: order.totalAmount,
      reason: cancellationReason || 'Order cancelled',
    }).catch((error) => {
      xeroLogger.error('Failed to send credit note issued email', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } else {
    // Record error in order
    const currentXero = (order.xero as Record<string, unknown>) || {};
    await prisma.order.update({
      where: { id: orderId },
      data: {
        xero: {
          ...currentXero,
          syncError: result.error,
          lastSyncJobId: jobId,
        },
      },
    });
  }

  return result;
}

// ============================================================================
// Manual Retry
// ============================================================================

/**
 * Manually retry a failed job
 * Resets the job status and processes it again
 */
export async function retryJob(jobId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const job = await prisma.xeroSyncJob.findUnique({
    where: { id: jobId },
  });

  if (!job) {
    return { success: false, error: 'Job not found' };
  }

  if (job.status !== 'failed') {
    return { success: false, error: 'Only failed jobs can be retried' };
  }

  // Reset job for retry
  // Note: attempts is reset to 0 intentionally for manual retries.
  // This gives the user a fresh set of automatic retry attempts after
  // they've investigated and potentially fixed the underlying issue.
  // Without this reset, a job that failed after max attempts would
  // immediately fail again without any retries.
  const updatedJob = await prisma.xeroSyncJob.update({
    where: { id: jobId },
    data: {
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(),
      error: null,
    },
  });

  xeroLogger.info(`Manual retry initiated for job ${jobId}`, { jobId });

  // Process immediately
  processJob(updatedJob).catch((error) => {
    xeroLogger.error(`Failed to process Xero job ${jobId}`, {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return { success: true };
}

// ============================================================================
// Job Queries
// ============================================================================

/**
 * Get sync jobs with filtering and pagination
 */
export async function getSyncJobs(options: {
  status?: XeroSyncJobStatus;
  type?: XeroSyncJobType;
  page?: number;
  limit?: number;
}): Promise<{
  jobs: XeroSyncJob[];
  total: number;
  page: number;
  totalPages: number;
}> {
  const page = options.page || 1;
  const limit = options.limit || 20;
  const skip = (page - 1) * limit;

  const where: { status?: XeroSyncJobStatus; type?: XeroSyncJobType } = {};
  if (options.status) where.status = options.status;
  if (options.type) where.type = options.type;

  const [jobs, total] = await Promise.all([
    prisma.xeroSyncJob.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.xeroSyncJob.count({ where }),
  ]);

  return {
    jobs,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Sweep `processing` rows that have been stuck for too long.
 *
 * Both XeroSyncJob and XeroWebhookEvent transition into `processing`
 * synchronously and only out of it on the same in-process call. If the Node
 * process is killed mid-flight (Vercel function timeout, deploy, OOM), the
 * row stays `processing` forever — and the coalescer in `enqueueXeroJob`
 * will then skip future enqueues for that customer because it sees an
 * "in-flight" job.
 *
 * Run periodically (we hook this into the nightly reconciler cron). Resets
 * stale `processing` rows to `pending` so retries can pick them up.
 *
 * Returns counts of rows reset.
 */
export async function sweepStuckProcessing(staleMinutes = 30): Promise<{
  jobsReset: number;
  webhookEventsReset: number;
}> {
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);

  // Stuck XeroSyncJob rows
  const jobs = await prisma.xeroSyncJob.updateMany({
    where: {
      status: 'processing',
      lastAttemptAt: { lt: cutoff },
    },
    data: {
      status: 'pending',
      nextAttemptAt: new Date(),
      error: 'Reset by sweeper — previous attempt did not complete',
    },
  });

  // Stuck XeroWebhookEvent rows
  const events = await prisma.xeroWebhookEvent.updateMany({
    where: {
      status: 'processing',
      lastAttemptAt: { lt: cutoff },
    },
    data: {
      status: 'pending',
      error: 'Reset by sweeper — previous attempt did not complete',
    },
  });

  if (jobs.count > 0 || events.count > 0) {
    xeroLogger.warn('Stuck-processing sweeper reset rows', {
      jobsReset: jobs.count,
      webhookEventsReset: events.count,
      staleMinutes,
    });
  }

  return { jobsReset: jobs.count, webhookEventsReset: events.count };
}

/**
 * Get sync stats for the dashboard
 */
export async function getSyncStats(): Promise<{
  pending: number;
  failed: number;
  completedToday: number;
}> {
  const startOfDay = getTodayAsUTCMidnight();

  const [pending, failed, completedToday] = await Promise.all([
    prisma.xeroSyncJob.count({ where: { status: 'pending' } }),
    prisma.xeroSyncJob.count({ where: { status: 'failed' } }),
    prisma.xeroSyncJob.count({
      where: {
        status: 'completed',
        completedAt: { gte: startOfDay },
      },
    }),
  ]);

  return { pending, failed, completedToday };
}
