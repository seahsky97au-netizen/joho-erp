/**
 * Xero Sync Admin Router
 *
 * Provides endpoints for managing and monitoring Xero sync jobs.
 */

import { z } from 'zod';
import { router, requirePermission } from '../trpc';
import { prisma } from '@joho-erp/database';
import { TRPCError } from '@trpc/server';
import {
  enqueueXeroJob,
  retryJob,
  getSyncJobs,
  getSyncStats,
} from '../services/xero-queue';
import { isXeroIntegrationEnabled } from '../services/xero';
import { logXeroSyncTrigger, logXeroJobRetry } from '../services/audit';

export const xeroRouter = router({
  /**
   * Get sync jobs with filtering and pagination
   */
  getSyncJobs: requirePermission('settings.xero:view')
    .input(
      z.object({
        status: z
          .enum(['pending', 'processing', 'completed', 'failed'])
          .optional(),
        type: z
          .enum(['sync_contact', 'create_invoice', 'create_credit_note', 'update_invoice', 'balance_sync'])
          .optional(),
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(20),
      })
    )
    .query(async ({ input }) => {
      return getSyncJobs({
        status: input.status,
        type: input.type,
        page: input.page,
        limit: input.limit,
      });
    }),

  /**
   * Get sync stats for dashboard
   */
  getSyncStats: requirePermission('settings.xero:view').query(async () => {
    return getSyncStats();
  }),

  /**
   * Retry a failed sync job
   */
  retryJob: requirePermission('settings.xero:sync')
    .input(z.object({ jobId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Get job details for audit
      const job = await prisma.xeroSyncJob.findUnique({
        where: { id: input.jobId },
      });

      const result = await retryJob(input.jobId);

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error || 'Failed to retry job',
        });
      }

      // Audit log - MEDIUM: Job retry tracked
      await logXeroJobRetry(ctx.userId, undefined, ctx.userRole, ctx.userName, {
        jobId: input.jobId,
        jobType: job?.type || 'unknown',
        entityType: job?.entityType || 'unknown',
        entityId: job?.entityId || '',
        previousAttempts: job?.attempts || 0,
      }).catch((error) => {
        console.error('Audit log failed for Xero job retry:', error);
      });

      return { success: true };
    }),

  /**
   * Manually trigger contact sync for a customer
   */
  syncContact: requirePermission('settings.xero:sync')
    .input(z.object({ customerId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const customer = await prisma.customer.findUnique({
        where: { id: input.customerId },
        select: { id: true, creditApplication: true },
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      // Check if customer has approved credit
      const creditApp = customer.creditApplication as { status?: string } | null;
      if (creditApp?.status !== 'approved') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Customer must have approved credit to sync to Xero',
        });
      }

      const jobId = await enqueueXeroJob('sync_contact', 'customer', input.customerId);

      // Audit log - MEDIUM: Xero sync trigger tracked
      await logXeroSyncTrigger(ctx.userId, undefined, ctx.userRole, ctx.userName, {
        jobType: 'sync_contact',
        entityType: 'customer',
        entityId: input.customerId,
      }).catch((error) => {
        console.error('Audit log failed for Xero sync trigger:', error);
      });

      return { success: true, jobId };
    }),

  /**
   * Manually trigger invoice creation for an order
   */
  createInvoice: requirePermission('settings.xero:sync')
    .input(z.object({ orderId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const order = await prisma.order.findUnique({
        where: { id: input.orderId },
        select: { id: true, status: true, xero: true },
      });

      if (!order) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Order not found',
        });
      }

      // Allow invoice creation for ready_for_delivery and later statuses
      const allowedStatuses = ['ready_for_delivery', 'out_for_delivery', 'delivered'];
      if (!allowedStatuses.includes(order.status)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Order must be at least ready for delivery to create an invoice',
        });
      }

      const xeroInfo = order.xero as { invoiceId?: string | null } | null;
      if (xeroInfo?.invoiceId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invoice already exists for this order',
        });
      }

      const jobId = await enqueueXeroJob('create_invoice', 'order', input.orderId);

      // Audit log - MEDIUM: Xero sync trigger tracked
      await logXeroSyncTrigger(ctx.userId, undefined, ctx.userRole, ctx.userName, {
        jobType: 'create_invoice',
        entityType: 'order',
        entityId: input.orderId,
      }).catch((error) => {
        console.error('Audit log failed for Xero invoice trigger:', error);
      });

      return { success: true, jobId };
    }),

  /**
   * Manually trigger credit note creation for an order
   */
  createCreditNote: requirePermission('settings.xero:sync')
    .input(z.object({ orderId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const order = await prisma.order.findUnique({
        where: { id: input.orderId },
        select: { id: true, status: true, xero: true },
      });

      if (!order) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Order not found',
        });
      }

      if (order.status !== 'cancelled') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Order must be cancelled to create a credit note',
        });
      }

      const xeroInfo = order.xero as { invoiceId?: string | null; creditNoteId?: string | null } | null;
      if (!xeroInfo?.invoiceId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Order has no invoice to credit',
        });
      }

      if (xeroInfo?.creditNoteId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Credit note already exists for this order',
        });
      }

      const jobId = await enqueueXeroJob('create_credit_note', 'order', input.orderId);

      // Audit log - MEDIUM: Xero sync trigger tracked
      await logXeroSyncTrigger(ctx.userId, undefined, ctx.userRole, ctx.userName, {
        jobType: 'create_credit_note',
        entityType: 'order',
        entityId: input.orderId,
      }).catch((error) => {
        console.error('Audit log failed for Xero credit note trigger:', error);
      });

      return { success: true, jobId };
    }),

  /**
   * Create a partial credit note for specific items on a paid invoice
   */
  createPartialCreditNote: requirePermission('settings.xero:sync')
    .input(
      z.object({
        orderId: z.string(),
        reason: z.string().min(1).max(500),
        items: z
          .array(
            z.object({
              productId: z.string(),
              quantity: z.number().positive(),
            })
          )
          .min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const order = await prisma.order.findUnique({
        where: { id: input.orderId },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          items: true,
          totalAmount: true,
          xero: true,
        },
      });

      if (!order) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Order not found',
        });
      }

      const xeroInfo = order.xero as {
        invoiceId?: string | null;
        invoiceStatus?: string | null;
        creditNotes?: Array<{
          amount: number;
          items: Array<{ productId: string; quantity: number }>;
        }>;
      } | null;

      if (!xeroInfo?.invoiceId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Order has no invoice to credit',
        });
      }

      const invoiceStatus = xeroInfo.invoiceStatus;
      if (invoiceStatus !== 'PAID' && invoiceStatus !== 'AUTHORISED') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invoice must be PAID or AUTHORISED to issue a partial credit note',
        });
      }

      // Build a map of already credited quantities per product
      const existingCreditNotes = xeroInfo.creditNotes || [];
      const creditedQtyMap = new Map<string, number>();
      let existingCreditsTotal = 0;
      for (const cn of existingCreditNotes) {
        existingCreditsTotal += cn.amount;
        for (const item of cn.items) {
          creditedQtyMap.set(
            item.productId,
            (creditedQtyMap.get(item.productId) || 0) + item.quantity
          );
        }
      }

      // Validate items and build payload
      const orderItems = order.items as Array<{
        productId: string;
        sku: string;
        productName: string;
        unit: string;
        quantity: number;
        unitPrice: number;
        subtotal: number;
        applyGst: boolean;
      }>;

      const validatedItems: Array<{
        productId: string;
        sku: string;
        productName: string;
        quantity: number;
        unitPrice: number;
        subtotal: number;
        applyGst: boolean;
      }> = [];

      for (const inputItem of input.items) {
        const orderItem = orderItems.find(
          (oi) => oi.productId === inputItem.productId
        );
        if (!orderItem) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Product ${inputItem.productId} not found in order`,
          });
        }

        const alreadyCredited = creditedQtyMap.get(inputItem.productId) || 0;
        const maxCreditableQty = orderItem.quantity - alreadyCredited;

        if (inputItem.quantity > maxCreditableQty) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Cannot credit ${inputItem.quantity} of ${orderItem.productName} — only ${maxCreditableQty} remaining (${alreadyCredited} already credited)`,
          });
        }

        const itemSubtotal = Math.round(orderItem.unitPrice * inputItem.quantity);

        validatedItems.push({
          productId: orderItem.productId,
          sku: orderItem.sku,
          productName: orderItem.productName,
          quantity: inputItem.quantity,
          unitPrice: orderItem.unitPrice,
          subtotal: itemSubtotal,
          applyGst: orderItem.applyGst ?? false,
        });
      }

      // Calculate new CN total (incl GST) and check against invoice total
      let newCnSubtotal = 0;
      let newCnGst = 0;
      for (const item of validatedItems) {
        newCnSubtotal += item.subtotal;
        if (item.applyGst) {
          newCnGst += Math.round(item.subtotal * 0.1);
        }
      }
      const newCnTotal = newCnSubtotal + newCnGst;

      if (existingCreditsTotal + newCnTotal > order.totalAmount) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Total credits would exceed the invoice total amount',
        });
      }

      // Restore stock for credited items (physical returns)
      const { restoreStockForCreditNote } = await import('../services/stock-restoration');
      await prisma.$transaction(async (tx) => {
        await restoreStockForCreditNote(
          {
            orderId: input.orderId,
            orderNumber: order.orderNumber,
            items: validatedItems.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
            })),
            userId: ctx.userId,
            reason: input.reason,
          },
          tx
        );
      });

      // Enqueue the job with partial payload
      const jobId = await enqueueXeroJob('create_credit_note', 'order', input.orderId, {
        type: 'partial' as const,
        reason: input.reason,
        createdBy: ctx.userName || ctx.userId,
        items: validatedItems,
      });

      // Audit log
      await logXeroSyncTrigger(ctx.userId, undefined, ctx.userRole, ctx.userName, {
        jobType: 'create_credit_note',
        entityType: 'order',
        entityId: input.orderId,
      }).catch((error) => {
        console.error('Audit log failed for Xero partial credit note trigger:', error);
      });

      return { success: true, jobId };
    }),

  /**
   * Get invoice PDF URL for an order (admin use)
   * Returns the Xero online invoice URL that can be used to view/download the invoice
   */
  getInvoicePdfUrlForOrder: requirePermission('orders:view')
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input }) => {
      const order = await prisma.order.findUnique({
        where: { id: input.orderId },
        select: { xero: true },
      });

      if (!order) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Order not found',
        });
      }

      const xeroInfo = order.xero as { invoiceId?: string | null; invoiceNumber?: string | null } | null;
      if (!xeroInfo?.invoiceId) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No invoice exists for this order',
        });
      }

      const { getInvoicePdfUrl } = await import('../services/xero');
      const url = await getInvoicePdfUrl(xeroInfo.invoiceId);

      if (!url) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Invoice online URL is not available. Check server logs for details.',
        });
      }

      return { url, invoiceNumber: xeroInfo.invoiceNumber };
    }),

  /**
   * Resync an existing invoice in Xero (update with current order data)
   */
  resyncInvoice: requirePermission('settings.xero:sync')
    .input(z.object({ orderId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const order = await prisma.order.findUnique({
        where: { id: input.orderId },
        select: { id: true, status: true, xero: true },
      });

      if (!order) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Order not found',
        });
      }

      const xeroInfo = order.xero as { invoiceId?: string | null; invoiceStatus?: string | null } | null;
      if (!xeroInfo?.invoiceId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Order has no existing invoice to resync',
        });
      }

      // Check if invoice status allows updates (DRAFT or AUTHORISED only)
      const status = xeroInfo.invoiceStatus?.toUpperCase();
      if (status === 'PAID' || status === 'VOIDED' || status === 'DELETED') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot resync invoice with status ${status}. Only DRAFT or AUTHORISED invoices can be updated.`,
        });
      }

      const jobId = await enqueueXeroJob('update_invoice', 'order', input.orderId);

      // Audit log - MEDIUM: Xero resync trigger tracked
      await logXeroSyncTrigger(ctx.userId, undefined, ctx.userRole, ctx.userName, {
        jobType: 'update_invoice',
        entityType: 'order',
        entityId: input.orderId,
      }).catch((error) => {
        console.error('Audit log failed for Xero invoice resync trigger:', error);
      });

      return { success: true, jobId };
    }),

  /**
   * Resync an existing contact in Xero (update with current customer data)
   */
  resyncContact: requirePermission('settings.xero:sync')
    .input(z.object({ customerId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const customer = await prisma.customer.findUnique({
        where: { id: input.customerId },
        select: { id: true, xeroContactId: true, creditApplication: true },
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      if (!customer.xeroContactId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Customer has no existing Xero contact to resync',
        });
      }

      const jobId = await enqueueXeroJob('sync_contact', 'customer', input.customerId);

      // Audit log - MEDIUM: Xero resync trigger tracked
      await logXeroSyncTrigger(ctx.userId, undefined, ctx.userRole, ctx.userName, {
        jobType: 'sync_contact',
        entityType: 'customer',
        entityId: input.customerId,
      }).catch((error) => {
        console.error('Audit log failed for Xero contact resync trigger:', error);
      });

      return { success: true, jobId };
    }),

  /**
   * Get order sync status
   */
  getOrderSyncStatus: requirePermission('settings.xero:view')
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input }) => {
      // Check if Xero integration is enabled
      const integrationEnabled = isXeroIntegrationEnabled();

      const order = await prisma.order.findUnique({
        where: { id: input.orderId },
        select: { xero: true },
      });

      if (!order) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Order not found',
        });
      }

      const xeroInfo = order.xero as {
        invoiceId?: string | null;
        invoiceNumber?: string | null;
        invoiceStatus?: string | null;
        creditNoteId?: string | null;
        creditNoteNumber?: string | null;
        syncedAt?: Date | null;
        syncError?: string | null;
        lastSyncJobId?: string | null;
      } | null;

      return {
        integrationEnabled,
        synced: !!xeroInfo?.invoiceId,
        invoiceId: xeroInfo?.invoiceId || null,
        invoiceNumber: xeroInfo?.invoiceNumber || null,
        invoiceStatus: xeroInfo?.invoiceStatus || null,
        creditNoteId: xeroInfo?.creditNoteId || null,
        creditNoteNumber: xeroInfo?.creditNoteNumber || null,
        syncedAt: xeroInfo?.syncedAt || null,
        syncError: xeroInfo?.syncError || null,
        lastSyncJobId: xeroInfo?.lastSyncJobId || null,
      };
    }),

  /**
   * Get customer sync status
   */
  getCustomerSyncStatus: requirePermission('settings.xero:view')
    .input(z.object({ customerId: z.string() }))
    .query(async ({ input }) => {
      const customer = await prisma.customer.findUnique({
        where: { id: input.customerId },
        select: { xeroContactId: true },
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      return {
        synced: !!customer.xeroContactId,
        contactId: customer.xeroContactId,
      };
    }),

  previewContactSync: requirePermission('settings.xero:view')
    .input(z.object({ customerId: z.string() }))
    .query(async ({ input }) => {
      const customer = await prisma.customer.findUnique({
        where: { id: input.customerId },
        select: {
          id: true,
          businessName: true,
          tradingName: true,
          xeroContactId: true,
          contactPerson: true,
          deliveryAddress: true,
          billingAddress: true,
        },
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      const contactPerson = customer.contactPerson as {
        email: string;
        firstName: string;
        lastName: string;
        phone: string;
      };
      const deliveryAddress = customer.deliveryAddress as {
        street: string;
        suburb: string;
        state: string;
        postcode: string;
      };
      const billingAddress = customer.billingAddress as {
        street: string;
        suburb: string;
        state: string;
        postcode: string;
      } | null;

      // Only show existing Xero contact info if already linked via xeroContactId
      const existingXeroContact =
        null as { contactId: string; name: string } | null;

      return {
        customerId: customer.id,
        customerData: {
          businessName: customer.businessName,
          tradingName: customer.tradingName,
          email: contactPerson.email,
          phone: contactPerson.phone,
          contactName: `${contactPerson.firstName} ${contactPerson.lastName}`,
          deliveryAddress,
          billingAddress,
        },
        existingXeroContact,
        isAlreadySynced: !!customer.xeroContactId,
        linkedXeroContactId: customer.xeroContactId,
      };
    }),

  /**
   * Get a specific sync job by ID
   */
  getJob: requirePermission('settings.xero:view')
    .input(z.object({ jobId: z.string() }))
    .query(async ({ input }) => {
      const job = await prisma.xeroSyncJob.findUnique({
        where: { id: input.jobId },
      });

      if (!job) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Sync job not found',
        });
      }

      return job;
    }),

  /**
   * List XeroWebhookEvent rows for the admin webhook dashboard.
   * Used to surface "webhooks have stopped firing" or "events are stuck failed"
   * before the operator notices balances drifting.
   */
  getWebhookEvents: requirePermission('settings.xero:view')
    .input(
      z.object({
        status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(20),
      })
    )
    .query(async ({ input }) => {
      const where = input.status ? { status: input.status } : {};
      const skip = (input.page - 1) * input.limit;
      const [events, total] = await Promise.all([
        prisma.xeroWebhookEvent.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: input.limit,
        }),
        prisma.xeroWebhookEvent.count({ where }),
      ]);
      return {
        events,
        total,
        page: input.page,
        totalPages: Math.ceil(total / input.limit),
      };
    }),

  /**
   * Counts of webhook events by status, for the dashboard summary card.
   * Plus the timestamp of the most recent successful event — if this stops
   * advancing, webhooks have stopped firing.
   */
  getWebhookStats: requirePermission('settings.xero:view').query(async () => {
    const [pending, processing, completed, failed, mostRecent] = await Promise.all([
      prisma.xeroWebhookEvent.count({ where: { status: 'pending' } }),
      prisma.xeroWebhookEvent.count({ where: { status: 'processing' } }),
      prisma.xeroWebhookEvent.count({ where: { status: 'completed' } }),
      prisma.xeroWebhookEvent.count({ where: { status: 'failed' } }),
      prisma.xeroWebhookEvent.findFirst({
        where: { status: 'completed' },
        orderBy: { processedAt: 'desc' },
        select: { processedAt: true },
      }),
    ]);
    return {
      pending,
      processing,
      completed,
      failed,
      lastSuccessfulAt: mostRecent?.processedAt ?? null,
    };
  }),

  /**
   * Retry a failed XeroWebhookEvent. Resets status to `pending` and re-runs
   * the per-event processor. Idempotent — the processor handles existing
   * customer/contact lookups gracefully.
   */
  retryWebhookEvent: requirePermission('settings.xero:sync')
    .input(z.object({ eventId: z.string() }))
    .mutation(async ({ input }) => {
      const event = await prisma.xeroWebhookEvent.findUnique({
        where: { id: input.eventId },
      });
      if (!event) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Webhook event not found' });
      }
      if (event.status !== 'failed') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only failed webhook events can be retried',
        });
      }
      const { processPersistedWebhookEvent } = await import('../services/xero-webhook');
      // Reset to pending; the processor sets it to processing on entry.
      await prisma.xeroWebhookEvent.update({
        where: { id: input.eventId },
        data: { status: 'pending', error: null },
      });
      const result = await processPersistedWebhookEvent(input.eventId);
      return result;
    }),
});
