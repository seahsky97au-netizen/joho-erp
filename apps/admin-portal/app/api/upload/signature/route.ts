/**
 * Proxy Upload API Route for Signatures (Admin Portal)
 *
 * POST /api/upload/signature
 *
 * Accepts multipart form data with:
 * - file: The signature image file (PNG only, max 500KB)
 * - signatureType: The type of signature (applicant, guarantor, witness)
 * - directorIndex: The director index (0-2)
 *
 * Security:
 * - Requires authenticated admin/sales user (via Clerk)
 * - Validates file type (PNG only), size (500KB max), signature type, and director index
 * - Uploads directly to R2 server-side (no CORS issues)
 */

import { NextResponse } from 'next/server';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { uploadToR2, isR2Configured } from '@joho-erp/api';

interface UploadSuccessResponse {
  success: true;
  publicUrl: string;
  key: string;
}

interface UploadErrorResponse {
  success: false;
  error: string;
}

type UploadResponse = UploadSuccessResponse | UploadErrorResponse;

export async function POST(request: Request): Promise<NextResponse<UploadResponse>> {
  try {
    // 1. Verify authentication
    const authData = await auth();
    if (!authData.userId) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 }
      );
    }

    // 2. Verify admin/sales role
    const client = await clerkClient();
    const user = await client.users.getUser(authData.userId);
    const metadata = user.publicMetadata as { role?: string };
    const userRole = metadata.role || 'customer';

    if (userRole !== 'admin' && userRole !== 'sales') {
      return NextResponse.json(
        { success: false, error: 'Admin access required' },
        { status: 403 }
      );
    }

    // 3. Check R2 configuration
    if (!isR2Configured()) {
      return NextResponse.json(
        { success: false, error: 'Storage not configured' },
        { status: 503 }
      );
    }

    // 4. Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const signatureType = formData.get('signatureType') as string | null;
    const directorIndex = formData.get('directorIndex') as string | null;

    // 5. Validate inputs
    if (!file || !signatureType || directorIndex === null) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // 6. Validate signature type
    const validTypes = ['applicant', 'guarantor', 'witness'];
    if (!validTypes.includes(signatureType)) {
      return NextResponse.json(
        { success: false, error: 'Invalid signature type' },
        { status: 400 }
      );
    }

    // 7. Validate director index
    const index = parseInt(directorIndex, 10);
    if (isNaN(index) || index < 0 || index > 2) {
      return NextResponse.json(
        { success: false, error: 'Invalid director index' },
        { status: 400 }
      );
    }

    // 8. Validate file type
    if (file.type !== 'image/png') {
      return NextResponse.json(
        { success: false, error: 'Only PNG files are allowed' },
        { status: 400 }
      );
    }

    // 9. Validate file size (500KB max)
    const MAX_SIZE = 500 * 1024;
    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { success: false, error: 'File size exceeds 500KB limit' },
        { status: 400 }
      );
    }

    // 10. Convert file to buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 11. Generate filename
    const timestamp = Date.now();
    const filename = `${timestamp}-${signatureType}-${index}.png`;

    // 12. Upload to R2 (using signature path pattern)
    const result = await uploadToR2({
      path: 'signatures',
      filename,
      contentType: 'image/png',
      buffer,
    });

    // 13. Return success response
    return NextResponse.json({
      success: true,
      publicUrl: result.publicUrl,
      key: result.key,
    });
  } catch (error) {
    console.error('Signature upload error:', error);
    return NextResponse.json(
      { success: false, error: 'Upload failed' },
      { status: 500 }
    );
  }
}
