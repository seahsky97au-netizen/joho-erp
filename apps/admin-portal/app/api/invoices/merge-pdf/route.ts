/**
 * Merged Invoice PDF Download Route
 *
 * POST /api/invoices/merge-pdf
 *
 * Accepts { orderIds: string[] }, fetches each invoice PDF from Xero,
 * merges them into a single PDF using pdf-lib, and returns one download.
 * Retries transient failures with exponential backoff.
 *
 * Security:
 * - Requires authenticated user via Clerk
 * - Requires admin, manager, or sales role
 */

import { auth, clerkClient } from '@clerk/nextjs/server';
import { prisma } from '@joho-erp/database';
import { getInvoicePdfBuffer, XeroApiError } from '@joho-erp/api/services/xero';
import { PDFDocument } from 'pdf-lib';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

function isRetryableError(error: unknown): boolean {
  if (error instanceof XeroApiError) {
    return error.isRetryable;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('network') ||
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('socket hang up')
    );
  }
  return false;
}

async function fetchPdfWithRetry(invoiceId: string): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await getInvoicePdfBuffer(invoiceId);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === MAX_RETRIES - 1) {
        throw error;
      }
      // Exponential backoff: 500ms, 1000ms, 2000ms
      await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

export async function POST(request: Request) {
  try {
    // Verify user is authenticated
    const authData = await auth();
    if (!authData.userId) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Verify user has an authorized role
    const client = await clerkClient();
    const user = await client.users.getUser(authData.userId);
    const metadata = user.publicMetadata as { role?: string };
    const userRole = metadata?.role;

    if (!userRole || !['admin', 'manager', 'sales'].includes(userRole)) {
      return new Response('Forbidden', { status: 403 });
    }

    // Parse request body
    const body = await request.json();
    const orderIds: string[] = body.orderIds;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return new Response('orderIds must be a non-empty array', { status: 400 });
    }

    // Fetch orders from DB to get Xero invoice IDs
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, xero: true },
    });

    // Build map of orderId -> invoiceId
    const invoiceMap: Array<{ orderId: string; invoiceId: string }> = [];
    for (const order of orders) {
      const xero = order.xero as { invoiceId?: string | null } | null;
      if (xero?.invoiceId) {
        invoiceMap.push({
          orderId: order.id,
          invoiceId: xero.invoiceId,
        });
      }
    }

    if (invoiceMap.length === 0) {
      return new Response('No orders with invoices found', { status: 400 });
    }

    // Fetch all PDFs sequentially (respects Xero rate limits built into getInvoicePdfBuffer)
    const mergedPdf = await PDFDocument.create();
    const failedOrderIds: string[] = [];
    let successCount = 0;

    for (const { orderId, invoiceId } of invoiceMap) {
      try {
        const pdfBuffer = await fetchPdfWithRetry(invoiceId);
        const sourcePdf = await PDFDocument.load(pdfBuffer);
        const copiedPages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
        for (const page of copiedPages) {
          mergedPdf.addPage(page);
        }
        successCount++;
      } catch (error) {
        console.error(`Failed to fetch PDF for order ${orderId} (invoice ${invoiceId}):`, error);
        failedOrderIds.push(orderId);
      }
    }

    // If ALL fetches failed, return error
    if (successCount === 0) {
      return new Response('Failed to fetch any invoices from Xero', { status: 500 });
    }

    // Generate merged PDF
    const mergedPdfBytes = await mergedPdf.save();
    const today = new Date().toISOString().split('T')[0];

    return new Response(Buffer.from(mergedPdfBytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="Invoices-${today}.pdf"`,
        'Content-Length': mergedPdfBytes.length.toString(),
        'X-Total-Invoices': invoiceMap.length.toString(),
        'X-Successful-Invoices': successCount.toString(),
        'X-Failed-Orders': failedOrderIds.join(','),
      },
    });
  } catch (error) {
    console.error('Failed to merge invoice PDFs:', error);

    if (error instanceof Error) {
      if (error.message.includes('Xero integration is disabled')) {
        return new Response('Xero integration is disabled', { status: 503 });
      }
      if (error.message.includes('not connected')) {
        return new Response('Xero is not connected', { status: 503 });
      }
    }

    return new Response('Failed to merge invoices', { status: 500 });
  }
}
