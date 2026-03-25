import { z } from 'zod';
import { router, publicProcedure, protectedProcedure, requirePermission } from '../trpc';
import { prisma } from '@joho-erp/database';
import { TRPCError } from '@trpc/server';
import {
  paginatePrismaQuery,
  buildPrismaOrderBy,
  validateABN,
  phoneSchema,
  postcodeSchema,
  creditLimitSchema,
  licenseExpirySchema,
} from '@joho-erp/shared';
import { sortInputSchema } from '../schemas';
import {
  sendCreditApprovedEmail,
  sendCreditRejectedEmail,
  sendCustomerRegistrationEmail,
  sendNewCustomerRegistrationAdminEmail,
} from '../services/email';

/**
 * Creates a Clerk client targeting the customer portal's Clerk instance.
 * This is needed because the admin portal runs its own Clerk instance,
 * but customer invitations must be created in the customer portal's Clerk.
 */
async function getCustomerPortalClerkClient() {
  const secretKey = process.env.CUSTOMER_PORTAL_CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Customer portal Clerk secret key not configured',
    });
  }
  const { createClerkClient } = await import('@clerk/nextjs/server');
  return createClerkClient({ secretKey });
}
import {
  logCreditApproval,
  logCreditRejection,
  logCustomerRegistration,
  logCustomerProfileUpdate,
  logCustomerCreatedByAdmin,
  logCustomerStatusChange,
} from '../services/audit';
import { generateCreditApplicationPdf } from '../services/pdf-generator';
import { uploadPdfToR2, isR2Configured } from '../services/r2';

// Validation schemas for credit application
const residentialAddressSchema = z.object({
  street: z.string().min(1, 'Street address is required'),
  suburb: z.string().min(1, 'Suburb is required'),
  state: z.string().min(1, 'State is required'),
  postcode: z.string().regex(/^\d{4}$/, 'Postcode must be 4 digits'),
  country: z.string().default('Australia'),
});

const directorDetailsSchema = z.object({
  familyName: z.string().min(1, 'Family name is required'),
  givenNames: z.string().min(1, 'Given names are required'),
  residentialAddress: residentialAddressSchema,
  dateOfBirth: z.date().or(z.string().transform((str) => new Date(str))),
  driverLicenseNumber: z.string().min(1, 'Driver license number is required'),
  licenseState: z.enum(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']),
  licenseExpiry: licenseExpirySchema,
  position: z.string().optional(),
  // ID document fields for verification photos
  idDocumentType: z.enum(['DRIVER_LICENSE', 'PASSPORT']).optional(),
  idDocumentFrontUrl: z.string().url().optional(),
  idDocumentBackUrl: z.string().url().optional(),
  idDocumentUploadedAt: z.date().or(z.string().transform((str) => new Date(str))).optional(),
});;

const financialDetailsSchema = z.object({
  bankName: z.string().min(1, 'Bank name is required'),
  accountName: z.string().min(1, 'Account name is required'),
  bsb: z.string().regex(/^\d{6}$/, 'BSB must be 6 digits'),
  accountNumber: z.string().min(1, 'Account number is required'),
});

const tradeReferenceSchema = z.object({
  companyName: z.string().min(1, 'Company name is required'),
  contactPerson: z.string().min(1, 'Contact person is required'),
  phone: z.string().min(1, 'Phone number is required'),
  email: z.string().email('Invalid email address'),
  verified: z.boolean().default(false),
  verifiedAt: z.date().optional(),
});

/**
 * Resolves a customer ID that can be either a MongoDB ObjectID or a Clerk user ID.
 * If a Clerk user ID is provided (starts with 'user_'), looks up the customer by clerkUserId
 * and returns their MongoDB ID.
 * @param customerId - Either a MongoDB ObjectID or Clerk user ID
 * @returns The MongoDB ObjectID of the customer
 * @throws TRPCError if customer not found or invalid ID format
 */
async function resolveCustomerId(customerId: string): Promise<string> {
  // Check if it looks like a Clerk user ID
  if (customerId.startsWith('user_')) {
    const customer = await prisma.customer.findUnique({
      where: { clerkUserId: customerId },
      select: { id: true },
    });
    if (!customer) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Customer not found',
      });
    }
    return customer.id;
  }

  // Validate MongoDB ObjectID format (24-char hex)
  if (!/^[a-fA-F0-9]{24}$/.test(customerId)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Invalid customer ID format',
    });
  }

  return customerId;
}


/**
 * Helper function to geocode an address and get coordinates
 * Returns coordinates from Mapbox, or falls back to SuburbAreaMapping
 */
async function geocodeAddressCoordinates(address: {
  street: string;
  suburb: string;
  state: string;
  postcode: string;
}): Promise<{ latitude: number | null; longitude: number | null }> {
  let latitude: number | null = null;
  let longitude: number | null = null;

  // Try Mapbox geocoding first
  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (mapboxToken) {
    try {
      const fullAddress = `${address.street}, ${address.suburb}, ${address.state} ${address.postcode}, Australia`;
      const encodedAddress = encodeURIComponent(fullAddress);
      const geocodeUrl = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodedAddress}&access_token=${mapboxToken}&country=AU&limit=1&types=address,secondary_address`;

      const geocodeResponse = await fetch(geocodeUrl);
      if (geocodeResponse.ok) {
        const geocodeData = await geocodeResponse.json();
        if (geocodeData.features && geocodeData.features.length > 0) {
          const feature = geocodeData.features[0];
          latitude = feature.properties.coordinates.latitude;
          longitude = feature.properties.coordinates.longitude;
        }
      }
    } catch (geocodeError) {
      console.warn('Server-side geocoding failed:', geocodeError);
    }
  }

  // Fallback to SuburbAreaMapping coordinates if geocoding didn't work
  if (latitude === null || longitude === null) {
    const suburbMapping = await prisma.suburbAreaMapping.findFirst({
      where: {
        suburb: { equals: address.suburb, mode: 'insensitive' },
        state: address.state,
        isActive: true,
      },
    });
    if (suburbMapping) {
      latitude = suburbMapping.latitude;
      longitude = suburbMapping.longitude;
    }
  }

  return { latitude, longitude };
}

export const customerRouter = router({
  // Public registration
  register: publicProcedure
    .input(
      z.object({
        clerkUserId: z.string(),
        accountType: z.enum(['sole_trader', 'partnership', 'company', 'other']),
        businessName: z.string().min(1),
        tradingName: z.string().optional(),
        abn: z.string().length(11).refine(validateABN, 'Invalid ABN checksum'),
        acn: z.string().length(9).optional(),
        contactPerson: z.object({
          firstName: z.string().min(1),
          lastName: z.string().min(1),
          email: z.string().email(),
          phone: phoneSchema,
          mobile: z.string().optional(),
        }),
        deliveryAddress: z.object({
          street: z.string().min(1),
          suburb: z.string().min(1),
          state: z.string(),
          postcode: postcodeSchema,
          areaId: z.string().optional(), // Manual area override
          deliveryInstructions: z.string().optional(),
          latitude: z.number().optional(), // From geocoding
          longitude: z.number().optional(), // From geocoding
        }),
        billingAddress: z
          .object({
            street: z.string().min(1),
            suburb: z.string().min(1),
            state: z.string(),
            postcode: postcodeSchema,
          })
          .optional(),
        postalAddress: z
          .object({
            street: z.string().min(1),
            suburb: z.string().min(1),
            state: z.string(),
            postcode: postcodeSchema,
          })
          .optional(),
        requestedCreditLimit: z.number().int().optional(), // In cents
        forecastPurchase: z.number().int().optional(), // In cents
        directors: z.array(directorDetailsSchema).min(1, 'At least one director is required'),
        financialDetails: financialDetailsSchema.optional(),
        tradeReferences: z.array(tradeReferenceSchema).optional(),
        signatures: z
          .array(
            z.object({
              directorIndex: z.number().int().min(0),
              applicantSignatureUrl: z.string().url(),
              applicantSignedAt: z.date(),
              guarantorSignatureUrl: z.string().url(),
              guarantorSignedAt: z.date(),
              witnessName: z.string().min(1),
              witnessSignatureUrl: z.string().url(),
              witnessSignedAt: z.date(),
            })
          )
          .min(1, 'At least one director must sign'),
      })
    )
    .mutation(async ({ input, ctx: _ctx }) => {
      // Run all uniqueness checks in parallel
      const [existing, existingByEmail, existingByABN] = await Promise.all([
        prisma.customer.findUnique({
          where: { clerkUserId: input.clerkUserId },
        }),
        prisma.customer.findFirst({
          where: {
            contactPerson: {
              is: { email: input.contactPerson.email },
            },
          },
        }),
        prisma.customer.findFirst({
          where: { abn: input.abn, status: 'active' },
        }),
      ]);

      if (existing) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Customer already registered',
        });
      }

      if (existingByEmail) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A customer with this email already exists',
        });
      }

      if (existingByABN) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'An active customer with this ABN already exists',
        });
      }

      // Auto-assign area based on suburb lookup (if not manually specified)
      let areaId = input.deliveryAddress.areaId ?? null;
      let areaName: string | null = null;

      if (!areaId) {
        // Lookup area by suburb
        const suburbMapping = await prisma.suburbAreaMapping.findFirst({
          where: {
            suburb: { equals: input.deliveryAddress.suburb, mode: 'insensitive' },
            state: input.deliveryAddress.state,
            isActive: true,
          },
          include: { area: true },
        });

        if (suburbMapping?.area) {
          areaId = suburbMapping.areaId;
          areaName = suburbMapping.area.name;
        }
      } else {
        // Manual override - get area name for display
        const area = await prisma.area.findUnique({ where: { id: areaId } });
        areaName = area?.name ?? null;
      }

      // Resolve coordinates for delivery address
      let latitude = input.deliveryAddress.latitude ?? null;
      let longitude = input.deliveryAddress.longitude ?? null;

      // If coordinates not provided by frontend, try to geocode server-side
      if (latitude === null || longitude === null) {
        const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
        if (mapboxToken) {
          try {
            const fullAddress = `${input.deliveryAddress.street}, ${input.deliveryAddress.suburb}, ${input.deliveryAddress.state} ${input.deliveryAddress.postcode}, Australia`;
            const encodedAddress = encodeURIComponent(fullAddress);
            // Use v6 API with secondary_address support for unit numbers
            const geocodeUrl = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodedAddress}&access_token=${mapboxToken}&country=AU&limit=1&types=address,secondary_address`;

            const geocodeResponse = await fetch(geocodeUrl);
            if (geocodeResponse.ok) {
              const geocodeData = await geocodeResponse.json();
              if (geocodeData.features && geocodeData.features.length > 0) {
                const feature = geocodeData.features[0];
                latitude = feature.properties.coordinates.latitude;
                longitude = feature.properties.coordinates.longitude;
              }
            }
          } catch (geocodeError) {
            console.warn('Server-side geocoding failed, falling back to suburb mapping:', geocodeError);
          }
        }
      }

      // Fallback to SuburbAreaMapping coordinates if geocoding didn't work
      if ((latitude === null || longitude === null) && !input.deliveryAddress.areaId) {
        const suburbMappingForCoords = await prisma.suburbAreaMapping.findFirst({
          where: {
            suburb: { equals: input.deliveryAddress.suburb, mode: 'insensitive' },
            state: input.deliveryAddress.state,
            isActive: true,
          },
        });
        if (suburbMappingForCoords) {
          latitude = suburbMappingForCoords.latitude;
          longitude = suburbMappingForCoords.longitude;
        }
      }

      // Create customer
      const customer = await prisma.customer.create({
        data: {
          clerkUserId: input.clerkUserId,
          accountType: input.accountType,
          businessName: input.businessName,
          tradingName: input.tradingName,
          abn: input.abn,
          acn: input.acn,
          contactPerson: input.contactPerson,
          deliveryAddress: {
            street: input.deliveryAddress.street,
            suburb: input.deliveryAddress.suburb,
            state: input.deliveryAddress.state,
            postcode: input.deliveryAddress.postcode,
            country: 'Australia',
            areaId,
            areaName,
            deliveryInstructions: input.deliveryAddress.deliveryInstructions,
            latitude,
            longitude,
          },
          billingAddress: input.billingAddress
            ? { ...input.billingAddress, country: 'Australia' }
            : undefined,
          postalAddress: input.postalAddress
            ? { ...input.postalAddress, country: 'Australia' }
            : undefined,
          creditApplication: {
            status: 'pending',
            requestedCreditLimit: input.requestedCreditLimit,
            forecastPurchase: input.forecastPurchase,
            appliedAt: new Date(),
            submittedAt: new Date(),
            creditLimit: 0,
            agreedToTermsAt: new Date(),
            signatures: input.signatures.flatMap((sig, _idx) => {
              const director = input.directors[sig.directorIndex];
              const signerName = `${director.givenNames} ${director.familyName}`;
              return [
                {
                  signerName,
                  signerPosition: director.position,
                  signatureUrl: sig.applicantSignatureUrl,
                  signedAt: sig.applicantSignedAt,
                  signatureType: 'APPLICANT' as const,
                },
                {
                  signerName,
                  signerPosition: director.position,
                  signatureUrl: sig.guarantorSignatureUrl,
                  signedAt: sig.guarantorSignedAt,
                  signatureType: 'GUARANTOR' as const,
                  witnessName: sig.witnessName,
                  witnessSignatureUrl: sig.witnessSignatureUrl,
                  witnessSignedAt: sig.witnessSignedAt,
                },
              ];
            }),
          },
          directors: input.directors,
          financialDetails: input.financialDetails,
          tradeReferences: input.tradeReferences || [],
          status: 'active',
          onboardingComplete: true,
        },
      });

      // Send confirmation email to customer
      await sendCustomerRegistrationEmail({
        customerEmail: customer.contactPerson.email,
        contactPerson: `${customer.contactPerson.firstName} ${customer.contactPerson.lastName}`,
        businessName: customer.businessName,
      }).catch((error) => {
        console.error('Failed to send customer registration email:', error);
      });

      // Send notification email to admin for credit approval
      await sendNewCustomerRegistrationAdminEmail({
        businessName: customer.businessName,
        contactPerson: `${customer.contactPerson.firstName} ${customer.contactPerson.lastName}`,
        email: customer.contactPerson.email,
        phone: customer.contactPerson.phone,
        abn: customer.abn,
        requestedCreditLimit: input.requestedCreditLimit,
      }).catch((error) => {
        console.error('Failed to send admin notification for new customer:', error);
      });

      // Log customer registration to audit trail
      await logCustomerRegistration(
        input.clerkUserId,
        customer.id,
        customer.businessName,
        customer.abn
      ).catch((error) => {
        console.error('Failed to log customer registration:', error);
      });

      // Generate and upload credit application PDF
      if (isR2Configured()) {
        try {
          const pdfBytes = await generateCreditApplicationPdf({
            accountType: input.accountType,
            businessName: input.businessName,
            abn: input.abn,
            acn: input.acn,
            tradingName: input.tradingName,
            deliveryAddress: {
              street: input.deliveryAddress.street,
              suburb: input.deliveryAddress.suburb,
              state: input.deliveryAddress.state,
              postcode: input.deliveryAddress.postcode,
            },
            postalAddress: input.postalAddress,
            contactFirstName: input.contactPerson.firstName,
            contactLastName: input.contactPerson.lastName,
            contactPhone: input.contactPerson.phone,
            contactMobile: input.contactPerson.mobile,
            contactEmail: input.contactPerson.email,
            requestedCreditLimit: input.requestedCreditLimit,
            forecastPurchaseAmount: input.forecastPurchase,
            directors: input.directors.map((d) => ({
              familyName: d.familyName,
              givenNames: d.givenNames,
              residentialAddress: d.residentialAddress,
              dateOfBirth: d.dateOfBirth,
              driverLicenseNumber: d.driverLicenseNumber,
              licenseState: d.licenseState,
              licenseExpiry: d.licenseExpiry,
              position: d.position,
            })),
            financialDetails: input.financialDetails,
            tradeReferences: input.tradeReferences,
            signatures: input.signatures,
            submissionDate: new Date(),
          });

          // Upload PDF to R2
          const { publicUrl } = await uploadPdfToR2({
            path: `credit-applications/${customer.id}`,
            filename: `credit-application-${customer.businessName.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
            buffer: pdfBytes,
          });

          // Update customer with PDF URL
          await prisma.customer.update({
            where: { id: customer.id },
            data: { creditApplicationPdfUrl: publicUrl },
          });

          console.log(`Credit application PDF generated for customer ${customer.id}: ${publicUrl}`);
        } catch (pdfError) {
          // Log error but don't fail the registration
          console.error('Failed to generate or upload credit application PDF:', pdfError);
        }
      } else {
        console.warn('R2 not configured - skipping credit application PDF generation');
      }

      return {
        customerId: customer.id,
        status: 'pending',
      };
    }),

  // Get customer profile (authenticated)
  getProfile: protectedProcedure.query(async ({ ctx }) => {
    const customer = await prisma.customer.findUnique({
      where: { clerkUserId: ctx.userId },
    });

    if (!customer) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Customer profile not found',
      });
    }

    // Calculate used credit from unpaid orders
    // Sum totalAmount for orders that are not cancelled and not delivered
    const unpaidOrders = await prisma.order.aggregate({
      _sum: {
        totalAmount: true,
      },
      where: {
        customerId: customer.id,
        // Exclude awaiting_approval (pending backorders) - they don't count against credit limit
        status: {
          in: ['confirmed', 'packing', 'ready_for_delivery', 'out_for_delivery'],
        },
      },
    });

    const usedCredit = unpaidOrders._sum.totalAmount ?? 0;

    return {
      ...customer,
      usedCredit,
    };
  }),

  // Check onboarding status
  getOnboardingStatus: protectedProcedure.query(async ({ ctx }) => {
    const customer = await prisma.customer.findUnique({
      where: { clerkUserId: ctx.userId },
      select: {
        id: true,
        status: true,
        onboardingComplete: true,
        businessName: true,
        creditApplication: true,
      },
    });

    return {
      hasCustomerRecord: !!customer,
      status: customer?.status ?? null,
      onboardingComplete: customer?.onboardingComplete ?? false,
      businessName: customer?.businessName ?? null,
      creditStatus: customer?.creditApplication?.status ?? null,
    };
  }),

  // Update profile
  updateProfile: protectedProcedure
    .input(
      z.object({
        contactPerson: z
          .object({
            phone: z.string(),
            mobile: z.string().optional(),
          })
          .optional(),
        deliveryAddress: z
          .object({
            street: z.string(),
            suburb: z.string(),
            state: z.string(),
            postcode: z.string(),
            latitude: z.number().optional(),
            longitude: z.number().optional(),
            deliveryInstructions: z.string().optional(),
          })
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Fetch current customer to merge updates
      const currentCustomer = await prisma.customer.findUnique({
        where: { clerkUserId: ctx.userId },
      });

      if (!currentCustomer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      // Build update data with merged composite types
      const updateData: any = {};

      if (input.contactPerson) {
        updateData.contactPerson = {
          ...currentCustomer.contactPerson,
          ...input.contactPerson,
        };
      }

      if (input.deliveryAddress) {
        let { latitude, longitude } = input.deliveryAddress;

        // Check if address has changed (street or suburb)
        const addressChanged =
          input.deliveryAddress.street !== currentCustomer.deliveryAddress?.street ||
          input.deliveryAddress.suburb !== currentCustomer.deliveryAddress?.suburb;

        // If address changed and no valid coordinates provided, geocode
        if (addressChanged && (!latitude || !longitude || latitude === 0 || longitude === 0)) {
          const coords = await geocodeAddressCoordinates({
            street: input.deliveryAddress.street,
            suburb: input.deliveryAddress.suburb,
            state: input.deliveryAddress.state,
            postcode: input.deliveryAddress.postcode,
          });
          latitude = coords.latitude ?? undefined;
          longitude = coords.longitude ?? undefined;
        }

        // Check if suburb changed and update area assignment
        let areaId: string | null | undefined = currentCustomer.deliveryAddress?.areaId;
        let areaName: string | null | undefined = currentCustomer.deliveryAddress?.areaName;

        if (input.deliveryAddress.suburb !== currentCustomer.deliveryAddress?.suburb) {
          // Look up new area for the suburb
          const suburbMapping = await prisma.suburbAreaMapping.findFirst({
            where: {
              suburb: { equals: input.deliveryAddress.suburb, mode: 'insensitive' },
              state: input.deliveryAddress.state,
              isActive: true,
            },
            include: { area: true },
          });

          if (suburbMapping?.area) {
            areaId = suburbMapping.areaId;
            areaName = suburbMapping.area.name;
          } else {
            // No mapping found, clear area assignment
            areaId = null;
            areaName = null;
          }
        }

        updateData.deliveryAddress = {
          ...currentCustomer.deliveryAddress,
          street: input.deliveryAddress.street,
          suburb: input.deliveryAddress.suburb,
          state: input.deliveryAddress.state,
          postcode: input.deliveryAddress.postcode,
          deliveryInstructions: input.deliveryAddress.deliveryInstructions,
          latitude: latitude ?? currentCustomer.deliveryAddress?.latitude,
          longitude: longitude ?? currentCustomer.deliveryAddress?.longitude,
          areaId,
          areaName,
        };
      }

      const customer = await prisma.customer.update({
        where: { clerkUserId: ctx.userId },
        data: updateData,
      });

      // Build changes array for audit log
      const changes = [];
      if (input.contactPerson) {
        changes.push({
          field: 'contactPerson',
          oldValue: currentCustomer.contactPerson,
          newValue: customer.contactPerson,
        });
      }
      if (input.deliveryAddress) {
        changes.push({
          field: 'deliveryAddress',
          oldValue: currentCustomer.deliveryAddress,
          newValue: customer.deliveryAddress,
        });
      }

      // Log to audit trail
      await logCustomerProfileUpdate(
        ctx.userId,
        undefined, // userEmail not available in context
        ctx.userRole,
        ctx.userName,
        customer.id,
        customer.businessName,
        changes
      );

      return customer;
    }),

  // Get all customers (no pagination) — used for dropdowns/filters
  listAll: requirePermission('customers:view')
    .query(async () => {
      const customers = await prisma.customer.findMany({
        orderBy: { businessName: 'asc' },
        select: { id: true, businessName: true, abn: true, status: true },
      });
      return { customers };
    }),

  // Admin: Get all customers
  getAll: requirePermission('customers:view')
    .input(
      z
        .object({
          status: z.enum(['active', 'suspended', 'closed']).optional(),
          approvalStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
          areaId: z.string().optional(),
          search: z.string().optional(),
          page: z.number().default(1),
          limit: z.number().default(20),
        })
        .merge(sortInputSchema)
    )
    .query(async ({ input }) => {
      const { page, limit, sortBy, sortOrder, ...filters } = input;
      const where: any = {};

      if (filters.status) {
        where.status = filters.status;
      }

      if (filters.approvalStatus) {
        where.creditApplication = {
          is: { status: filters.approvalStatus },
        };
      }

      if (filters.areaId) {
        where.deliveryAddress = {
          is: { areaId: filters.areaId },
        };
      }

      if (filters.search) {
        where.OR = [
          { businessName: { contains: filters.search, mode: 'insensitive' } },
          { contactPerson: { is: { email: { contains: filters.search, mode: 'insensitive' } } } },
          { abn: { contains: filters.search, mode: 'insensitive' } },
        ];
      }

      // Build orderBy from sort parameters
      const customerSortFieldMapping: Record<string, string> = {
        businessName: 'businessName',
        createdAt: 'createdAt',
        status: 'status',
        creditLimit: 'creditApplication.creditLimit',
        creditStatus: 'creditApplication.status',
      };

      const orderBy =
        sortBy && customerSortFieldMapping[sortBy]
          ? buildPrismaOrderBy(sortBy, sortOrder, customerSortFieldMapping)
          : { businessName: 'asc' as const };

      const result = await paginatePrismaQuery(prisma.customer, where, {
        page,
        limit,
        orderBy,
      });

      return {
        customers: result.items,
        total: result.total,
        page: result.page,
        totalPages: result.totalPages,
      };
    }),

  // Admin: Get customer by ID
  getById: requirePermission('customers:view')
    .input(z.object({ customerId: z.string() }))
    .query(async ({ input }) => {
      const resolvedCustomerId = await resolveCustomerId(input.customerId);

      const customer = await prisma.customer.findUnique({
        where: { id: resolvedCustomerId },
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      return customer;
    }),

  // Admin: Create customer
  createCustomer: requirePermission('customers:create')
    .input(
      z.object({
        // Business Information
        accountType: z.enum(['sole_trader', 'partnership', 'company', 'other']),
        businessName: z.string().min(1),
        tradingName: z.string().optional(),
        abn: z.string().length(11).refine(validateABN, 'Invalid ABN checksum'),
        acn: z.string().length(9).optional(),

        // Contact Person
        contactPerson: z.object({
          firstName: z.string().min(1),
          lastName: z.string().min(1),
          email: z.string().email(),
          phone: z.string(),
          mobile: z.string().optional(),
        }),

        // Addresses
        deliveryAddress: z.object({
          street: z.string().min(1),
          suburb: z.string().min(1),
          state: z.string(),
          postcode: z.string(),
          areaId: z.string().optional(), // Manual area override
          deliveryInstructions: z.string().optional(),
        }),
        billingAddress: z
          .object({
            street: z.string().min(1),
            suburb: z.string().min(1),
            state: z.string(),
            postcode: z.string(),
          })
          .optional(),
        postalAddress: z
          .object({
            street: z.string().min(1),
            suburb: z.string().min(1),
            state: z.string(),
            postcode: z.string(),
          })
          .optional(),

        // Credit Application
        requestedCreditLimit: z.number().int().optional(), // In cents
        forecastPurchase: z.number().int().optional(), // In cents
        creditLimit: z.number().int().min(0).default(0), // In cents
        paymentTerms: z.string().optional(),
        notes: z.string().optional(),

        // Optional: Directors/Proprietors
        directors: z.array(directorDetailsSchema).optional(),

        // Optional: Financial Details
        financialDetails: financialDetailsSchema.optional(),

        // Optional: Trade References
        tradeReferences: z.array(tradeReferenceSchema).optional(),

        // Optional: Signatures (for admin sign-up on behalf of customer)
        signatures: z
          .array(
            z.object({
              directorIndex: z.number().int().min(0),
              applicantSignatureUrl: z.string().url(),
              applicantSignedAt: z.date().or(z.string().transform((str) => new Date(str))),
              guarantorSignatureUrl: z.string().url(),
              guarantorSignedAt: z.date().or(z.string().transform((str) => new Date(str))),
              witnessName: z.string().min(1),
              witnessSignatureUrl: z.string().url(),
              witnessSignedAt: z.date().or(z.string().transform((str) => new Date(str))),
            })
          )
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Run uniqueness checks in parallel
      const [existingByEmail, existingByABN] = await Promise.all([
        prisma.customer.findFirst({
          where: {
            contactPerson: {
              is: { email: input.contactPerson.email },
            },
          },
        }),
        prisma.customer.findFirst({
          where: { abn: input.abn, status: 'active' },
        }),
      ]);

      if (existingByEmail) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A customer with this email already exists',
        });
      }

      if (existingByABN) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'An active customer with this ABN already exists',
        });
      }

      // Generate a dummy Clerk user ID for admin-created customers
      const dummyClerkId = `admin_created_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      // Auto-assign area based on suburb lookup (if not manually specified)
      let areaId = input.deliveryAddress.areaId ?? null;
      let areaName: string | null = null;

      if (!areaId) {
        // Lookup area by suburb
        const suburbMapping = await prisma.suburbAreaMapping.findFirst({
          where: {
            suburb: { equals: input.deliveryAddress.suburb, mode: 'insensitive' },
            state: input.deliveryAddress.state,
            isActive: true,
          },
          include: { area: true },
        });

        if (suburbMapping?.area) {
          areaId = suburbMapping.areaId;
          areaName = suburbMapping.area.name;
        }
      } else {
        // Manual override - get area name for display
        const area = await prisma.area.findUnique({ where: { id: areaId } });
        areaName = area?.name ?? null;
      }

      // Create customer
      const customer = await prisma.customer.create({
        data: {
          clerkUserId: dummyClerkId,
          accountType: input.accountType,
          businessName: input.businessName,
          tradingName: input.tradingName,
          abn: input.abn,
          acn: input.acn,
          contactPerson: input.contactPerson,
          deliveryAddress: {
            street: input.deliveryAddress.street,
            suburb: input.deliveryAddress.suburb,
            state: input.deliveryAddress.state,
            postcode: input.deliveryAddress.postcode,
            country: 'Australia',
            areaId,
            areaName,
            deliveryInstructions: input.deliveryAddress.deliveryInstructions,
          },
          billingAddress: input.billingAddress
            ? { ...input.billingAddress, country: 'Australia' }
            : undefined,
          postalAddress: input.postalAddress
            ? { ...input.postalAddress, country: 'Australia' }
            : undefined,
          creditApplication: {
            status: input.creditLimit > 0 ? 'approved' : 'pending',
            requestedCreditLimit: input.requestedCreditLimit,
            forecastPurchase: input.forecastPurchase,
            appliedAt: new Date(),
            creditLimit: input.creditLimit,
            paymentTerms: input.paymentTerms,
            notes: input.notes,
            reviewedAt: input.creditLimit > 0 ? new Date() : undefined,
            reviewedBy: input.creditLimit > 0 ? ctx.userId : undefined,
            ...(input.signatures && input.signatures.length > 0 && input.directors
              ? {
                  agreedToTermsAt: new Date(),
                  signatures: input.signatures.flatMap((sig) => {
                    const director = input.directors![sig.directorIndex];
                    if (!director) return [];
                    const signerName = `${director.givenNames} ${director.familyName}`;
                    return [
                      {
                        signerName,
                        signerPosition: director.position,
                        signatureUrl: sig.applicantSignatureUrl,
                        signedAt: sig.applicantSignedAt,
                        signatureType: 'APPLICANT' as const,
                      },
                      {
                        signerName,
                        signerPosition: director.position,
                        signatureUrl: sig.guarantorSignatureUrl,
                        signedAt: sig.guarantorSignedAt,
                        signatureType: 'GUARANTOR' as const,
                        witnessName: sig.witnessName,
                        witnessSignatureUrl: sig.witnessSignatureUrl,
                        witnessSignedAt: sig.witnessSignedAt,
                      },
                    ];
                  }),
                }
              : {}),
          },
          directors: input.directors || [],
          financialDetails: input.financialDetails,
          tradeReferences: input.tradeReferences || [],
          status: 'active',
          onboardingComplete: true, // Admin-created customers skip onboarding
          portalInvitationStatus: 'not_invited',
        },
      });

      // Send welcome email to customer
      try {
        await sendCustomerRegistrationEmail({
          customerEmail: input.contactPerson.email,
          businessName: input.businessName,
          contactPerson: `${input.contactPerson.firstName} ${input.contactPerson.lastName}`,
        });
      } catch (error) {
        // Log error but don't fail the registration
        console.error('Failed to send welcome email:', error);
      }

      // Auto-invite customer to portal
      try {
        const clerkBackend = await getCustomerPortalClerkClient();
        const customerPortalUrl = process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL || 'http://localhost:3000';

        await clerkBackend.invitations.createInvitation({
          emailAddress: input.contactPerson.email,
          publicMetadata: {
            role: 'customer',
            customerId: customer.id,
          },
          redirectUrl: `${customerPortalUrl}/sign-up`,
        });

        // Update invitation status
        await prisma.customer.update({
          where: { id: customer.id },
          data: {
            portalInvitationStatus: 'invited',
            portalInvitedAt: new Date(),
            portalInvitedEmail: input.contactPerson.email,
          },
        });
      } catch (error) {
        // Don't fail customer creation if invitation fails
        console.error('Failed to auto-invite customer to portal:', error);
      }

      // Log to audit trail
      await logCustomerCreatedByAdmin(
        ctx.userId,
        undefined, // userEmail not available in context
        ctx.userRole,
        ctx.userName,
        customer.id,
        customer.businessName,
        customer.abn
      );

      return customer;
    }),

  // Admin: Approve credit
  approveCredit: requirePermission('customers:approve_credit')
    .input(
      z.object({
        customerId: z.string(),
        creditLimit: creditLimitSchema, // In cents, max $100,000
        paymentTerms: z.string(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const resolvedCustomerId = await resolveCustomerId(input.customerId);

      // Wrap in transaction with atomic guard to prevent duplicate approvals
      const result = await prisma.$transaction(async (tx) => {
        // STEP 1: Fetch customer INSIDE transaction
        const currentCustomer = await tx.customer.findUnique({
          where: { id: resolvedCustomerId },
        });

        if (!currentCustomer) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Customer not found',
          });
        }

        // STEP 2: Check if already approved (idempotent check)
        const currentCreditApp = currentCustomer.creditApplication;
        if (currentCreditApp.status === 'approved') {
          // Already approved - return idempotent result
          return { customer: currentCustomer, alreadyApproved: true };
        }

        // STEP 3: Validate status is pending (atomic guard)
        if (currentCreditApp.status !== 'pending') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Credit application cannot be approved. Current status: ${currentCreditApp.status}`,
          });
        }

        // STEP 4: Update customer with credit approval
        const customer = await tx.customer.update({
          where: { id: resolvedCustomerId },
          data: {
            creditApplication: {
              ...currentCreditApp,
              status: 'approved',
              creditLimit: input.creditLimit,
              paymentTerms: input.paymentTerms,
              notes: input.notes,
              reviewedAt: new Date(),
              reviewedBy: ctx.userId,
            },
          },
        });

        return { customer, alreadyApproved: false };
      });

      // Only send emails and trigger side effects if not already approved (idempotent)
      if (!result.alreadyApproved) {
        // Send approval email to customer
        const contactPerson = result.customer.contactPerson as { firstName: string; lastName: string; email: string };
        await sendCreditApprovedEmail({
          customerEmail: contactPerson.email,
          customerName: result.customer.businessName,
          contactPerson: `${contactPerson.firstName} ${contactPerson.lastName}`,
          creditLimit: input.creditLimit,
          paymentTerms: input.paymentTerms,
          notes: input.notes,
        }).catch((error) => {
          console.error('Failed to send credit approved email:', error);
        });

        // Sync to Xero as contact
        const { enqueueXeroJob } = await import('../services/xero-queue');
        await enqueueXeroJob('sync_contact', 'customer', result.customer.id).catch((error) => {
          console.error('Failed to enqueue Xero contact sync:', error);
        });

        // Log credit approval to audit trail
        await logCreditApproval(
          ctx.userId,
          result.customer.id,
          result.customer.businessName,
          input.creditLimit,
          input.paymentTerms
        ).catch((error) => {
          console.error('Failed to log credit approval:', error);
        });
      }

      return result.customer;
    }),

  // Admin: Reject credit
  rejectCredit: requirePermission('customers:approve_credit')
    .input(
      z.object({
        customerId: z.string(),
        notes: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const resolvedCustomerId = await resolveCustomerId(input.customerId);

      // Fetch current customer to update creditApplication
      const currentCustomer = await prisma.customer.findUnique({
        where: { id: resolvedCustomerId },
      });

      if (!currentCustomer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      const customer = await prisma.customer.update({
        where: { id: resolvedCustomerId },
        data: {
          creditApplication: {
            ...currentCustomer.creditApplication,
            status: 'rejected',
            notes: input.notes,
            reviewedAt: new Date(),
            reviewedBy: ctx.userId,
          },
        },
      });

      // Send rejection email to customer
      const contactPerson = customer.contactPerson as { firstName: string; lastName: string; email: string };
      await sendCreditRejectedEmail({
        customerEmail: contactPerson.email,
        customerName: customer.businessName,
        contactPerson: `${contactPerson.firstName} ${contactPerson.lastName}`,
        reason: input.notes,
      }).catch((error) => {
        console.error('Failed to send credit rejected email:', error);
      });

      // Log credit rejection to audit trail
      await logCreditRejection(
        ctx.userId,
        customer.id,
        customer.businessName,
        input.notes
      ).catch((error) => {
        console.error('Failed to log credit rejection:', error);
      });

      return customer;
    }),


  regenerateCreditApplicationPdf: requirePermission('customers:approve_credit')
    .input(z.object({ customerId: z.string() }))
    .mutation(async ({ input }) => {
      const resolvedCustomerId = await resolveCustomerId(input.customerId);

      const customer = await prisma.customer.findUnique({
        where: { id: resolvedCustomerId },
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      const creditApp = customer.creditApplication;
      if (!creditApp?.signatures?.length) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No credit application signatures found. Cannot generate PDF without signatures.',
        });
      }

      if (!isR2Configured()) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'R2 storage is not configured. Cannot generate PDF.',
        });
      }

      // Build director data from stored directors
      const directors = (customer.directors || []).map((d) => ({
        familyName: d.familyName,
        givenNames: d.givenNames,
        residentialAddress: d.residentialAddress,
        dateOfBirth: d.dateOfBirth,
        driverLicenseNumber: d.driverLicenseNumber,
        licenseState: d.licenseState,
        licenseExpiry: d.licenseExpiry,
        position: d.position ?? undefined,
      }));

      // Build signature data from credit application signatures
      // The stored format has flattened signatures, we need to reconstruct the input format
      const signaturesByDirector = new Map<number, {
        directorIndex: number;
        applicantSignatureUrl?: string;
        applicantSignedAt?: Date;
        guarantorSignatureUrl?: string;
        guarantorSignedAt?: Date;
        witnessName?: string;
        witnessSignatureUrl?: string;
        witnessSignedAt?: Date;
      }>();

      for (const sig of creditApp.signatures) {
        // Find director index by matching signer name
        const directorIndex = directors.findIndex(
          (d) => `${d.givenNames} ${d.familyName}` === sig.signerName
        );
        if (directorIndex === -1) continue;

        const existing = signaturesByDirector.get(directorIndex) || { directorIndex };
        
        if (sig.signatureType === 'APPLICANT') {
          existing.applicantSignatureUrl = sig.signatureUrl;
          existing.applicantSignedAt = sig.signedAt;
        } else if (sig.signatureType === 'GUARANTOR') {
          existing.guarantorSignatureUrl = sig.signatureUrl;
          existing.guarantorSignedAt = sig.signedAt;
          existing.witnessName = sig.witnessName ?? undefined;
          existing.witnessSignatureUrl = sig.witnessSignatureUrl ?? undefined;
          existing.witnessSignedAt = sig.witnessSignedAt ?? undefined;
        }

        signaturesByDirector.set(directorIndex, existing);
      }

      const signatures = Array.from(signaturesByDirector.values()).filter(
        (s) => s.applicantSignatureUrl && s.guarantorSignatureUrl
      ) as Array<{
        directorIndex: number;
        applicantSignatureUrl: string;
        applicantSignedAt: Date;
        guarantorSignatureUrl: string;
        guarantorSignedAt: Date;
        witnessName: string;
        witnessSignatureUrl: string;
        witnessSignedAt: Date;
      }>;

      if (signatures.length === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Could not reconstruct valid signature data. Cannot generate PDF.',
        });
      }

      const contactPerson = customer.contactPerson as {
        firstName: string;
        lastName: string;
        email: string;
        phone: string;
        mobile?: string;
      };

      try {
        const pdfBytes = await generateCreditApplicationPdf({
          accountType: customer.accountType,
          businessName: customer.businessName,
          abn: customer.abn,
          acn: customer.acn ?? undefined,
          tradingName: customer.tradingName ?? undefined,
          deliveryAddress: {
            street: customer.deliveryAddress.street,
            suburb: customer.deliveryAddress.suburb,
            state: customer.deliveryAddress.state,
            postcode: customer.deliveryAddress.postcode,
          },
          postalAddress: customer.postalAddress
            ? {
                street: customer.postalAddress.street,
                suburb: customer.postalAddress.suburb,
                state: customer.postalAddress.state,
                postcode: customer.postalAddress.postcode,
              }
            : undefined,
          contactFirstName: contactPerson.firstName,
          contactLastName: contactPerson.lastName,
          contactPhone: contactPerson.phone,
          contactMobile: contactPerson.mobile,
          contactEmail: contactPerson.email,
          requestedCreditLimit: creditApp.requestedCreditLimit ?? undefined,
          forecastPurchaseAmount: creditApp.forecastPurchase ?? undefined,
          directors,
          financialDetails: customer.financialDetails ?? undefined,
          tradeReferences: customer.tradeReferences ?? undefined,
          signatures,
          submissionDate: creditApp.submittedAt ?? creditApp.appliedAt ?? new Date(),
        });

        // Upload PDF to R2
        const { publicUrl } = await uploadPdfToR2({
          path: `credit-applications/${customer.id}`,
          filename: `credit-application-${customer.businessName.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
          buffer: pdfBytes,
        });

        // Update customer with PDF URL
        await prisma.customer.update({
          where: { id: customer.id },
          data: { creditApplicationPdfUrl: publicUrl },
        });

        console.log(`Credit application PDF regenerated for customer ${customer.id}: ${publicUrl}`);

        return { pdfUrl: publicUrl };
      } catch (error) {
        console.error('Failed to generate or upload credit application PDF:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to generate credit application PDF. Please try again.',
        });
      }
    }),

  // Admin: Suspend customer account
  suspend: requirePermission('customers:suspend')
    .input(
      z.object({
        customerId: z.string(),
        reason: z.string().min(10, 'Suspension reason must be at least 10 characters'),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const resolvedCustomerId = await resolveCustomerId(input.customerId);

      const customer = await prisma.customer.findUnique({
        where: { id: resolvedCustomerId },
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      if (customer.status === 'suspended') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Customer is already suspended',
        });
      }

      const updatedCustomer = await prisma.customer.update({
        where: { id: resolvedCustomerId },
        data: {
          status: 'suspended',
          suspensionReason: input.reason,
          suspendedAt: new Date(),
          suspendedBy: ctx.userId,
        },
      });

      // Log suspension to audit trail
      await logCustomerStatusChange(
        ctx.userId,
        undefined, // userEmail not available in context
        ctx.userRole,
        ctx.userName,
        customer.id,
        {
          businessName: customer.businessName,
          action: 'suspend',
          reason: input.reason,
        }
      ).catch((error) => {
        console.error('Failed to log customer suspension:', error);
      });

      return updatedCustomer;
    }),

  // Admin: Activate (unsuspend) customer account
  activate: requirePermission('customers:suspend')
    .input(
      z.object({
        customerId: z.string(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const resolvedCustomerId = await resolveCustomerId(input.customerId);

      const customer = await prisma.customer.findUnique({
        where: { id: resolvedCustomerId },
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      if (customer.status !== 'suspended') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Customer is not suspended',
        });
      }

      const updatedCustomer = await prisma.customer.update({
        where: { id: resolvedCustomerId },
        data: {
          status: 'active',
          suspensionReason: null,
          suspendedAt: null,
          suspendedBy: null,
        },
      });

      // Log activation to audit trail
      await logCustomerStatusChange(
        ctx.userId,
        undefined, // userEmail not available in context
        ctx.userRole,
        ctx.userName,
        customer.id,
        {
          businessName: customer.businessName,
          action: 'activate',
        }
      ).catch((error) => {
        console.error('Failed to log customer activation:', error);
      });

      return updatedCustomer;
    }),

  // Admin: Permanently close a customer account (soft delete)
  close: requirePermission('customers:delete')
    .input(
      z.object({
        customerId: z.string(),
        reason: z.string().min(10, 'Closure reason must be at least 10 characters'),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const resolvedCustomerId = await resolveCustomerId(input.customerId);

      const customer = await prisma.customer.findUnique({
        where: { id: resolvedCustomerId },
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      if (customer.status === 'closed') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Customer account is already closed',
        });
      }

      const previousStatus = customer.status;

      // Modify clerkUserId to allow email re-registration
      // Append '_closed_<timestamp>' suffix to free up the original identifier
      const modifiedClerkUserId = `${customer.clerkUserId}_closed_${Date.now()}`;

      const updatedCustomer = await prisma.customer.update({
        where: { id: resolvedCustomerId },
        data: {
          status: 'closed',
          clerkUserId: modifiedClerkUserId,
          closureReason: input.reason,
          closedAt: new Date(),
          closedBy: ctx.userId,
        },
      });

      // Log closure to audit trail
      await logCustomerStatusChange(
        ctx.userId,
        undefined, // userEmail not available in context
        ctx.userRole,
        ctx.userName,
        customer.id,
        {
          businessName: customer.businessName,
          action: 'close',
          reason: input.reason,
          previousStatus,
        }
      ).catch((error) => {
        console.error('Failed to log customer closure:', error);
      });

      return updatedCustomer;
    }),

  // Admin: Update customer details
  update: requirePermission('customers:edit')
    .input(
      z.object({
        customerId: z.string(),
        // Contact person
        contactPerson: z
          .object({
            firstName: z.string().min(1).optional(),
            lastName: z.string().min(1).optional(),
            email: z.string().email().optional(),
            phone: z.string().optional(),
            mobile: z.string().optional(),
          })
          .optional(),
        // Delivery address
        deliveryAddress: z
          .object({
            street: z.string().min(1).optional(),
            suburb: z.string().min(1).optional(),
            state: z.string().optional(),
            postcode: z.string().optional(),
            deliveryInstructions: z.string().optional(),
            // Area assignment (optional - if not provided, auto-assigns based on suburb)
            areaId: z.string().nullable().optional(),
            // Coordinates (optional - if not provided, auto-geocodes based on address)
            latitude: z.number().optional(),
            longitude: z.number().optional(),
          })
          .optional(),
        // Business information
        businessInfo: z
          .object({
            businessName: z.string().min(1).optional(),
            tradingName: z.string().nullable().optional(),
            abn: z.string().length(11).refine(validateABN, 'Invalid ABN checksum').optional(),
            acn: z.string().length(9).nullable().optional(),
            accountType: z.enum(['sole_trader', 'partnership', 'company', 'other']).optional(),
          })
          .optional(),
        // Billing address
        billingAddress: z
          .object({
            street: z.string().min(1),
            suburb: z.string().min(1),
            state: z.string().min(1),
            postcode: z.string().min(1),
            country: z.string().optional(),
          })
          .nullable()
          .optional(),
        // Postal address
        postalAddress: z
          .object({
            street: z.string().min(1),
            suburb: z.string().min(1),
            state: z.string().min(1),
            postcode: z.string().min(1),
            country: z.string().optional(),
          })
          .nullable()
          .optional(),
        // Flag to copy billing address to postal address
        postalSameAsBilling: z.boolean().optional(),
        // Directors array
        directors: z
          .array(
            z.object({
              familyName: z.string().min(1),
              givenNames: z.string().min(1),
              residentialAddress: z.object({
                street: z.string().min(1),
                suburb: z.string().min(1),
                state: z.string().min(1),
                postcode: z.string().min(1),
                country: z.string().optional(),
              }),
              dateOfBirth: z.coerce.date(),
              driverLicenseNumber: z.string().min(1),
              licenseState: z.enum(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']),
              licenseExpiry: z.coerce.date(),
              position: z.string().optional(),
              // ID document fields (pass-through to prevent data loss on save)
              idDocumentType: z.enum(['DRIVER_LICENSE', 'PASSPORT']).optional(),
              idDocumentFrontUrl: z.string().url().optional(),
              idDocumentBackUrl: z.string().url().optional(),
              idDocumentUploadedAt: z.coerce.date().optional(),
            })
          )
          .optional(),
        // Financial details
        financialDetails: z
          .object({
            bankName: z.string().min(1),
            accountName: z.string().min(1),
            bsb: z.string().regex(/^\d{6}$/, 'BSB must be 6 digits'),
            accountNumber: z.string().min(6).max(10),
          })
          .nullable()
          .optional(),
        // Trade references array
        tradeReferences: z
          .array(
            z.object({
              companyName: z.string().min(1),
              contactPerson: z.string().min(1),
              phone: z.string().min(1),
              email: z.string().email(),
              verified: z.boolean().optional(),
              verifiedAt: z.date().nullable().optional(),
            })
          )
          .optional(),
        // SMS reminder preferences
        smsReminderPreferences: z
          .object({
            enabled: z.boolean(),
            reminderDays: z
              .array(z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']))
              .optional()
              .default([]),
          })
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const resolvedCustomerId = await resolveCustomerId(input.customerId);

      const currentCustomer = await prisma.customer.findUnique({
        where: { id: resolvedCustomerId },
      });

      if (!currentCustomer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      // Build update data with merged composite types
      const updateData: Record<string, unknown> = {};
      const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];

      // Handle contact person
      if (input.contactPerson) {
        const currentContact = currentCustomer.contactPerson as Record<string, unknown>;
        const newContact = {
          ...currentContact,
          ...input.contactPerson,
        };
        updateData.contactPerson = newContact;
        changes.push({
          field: 'contactPerson',
          oldValue: currentContact,
          newValue: newContact,
        });
      }

      // Handle delivery address with area assignment logic and geocoding
      if (input.deliveryAddress) {
        const currentAddress = currentCustomer.deliveryAddress as Record<string, unknown>;
        const newAddress: Record<string, unknown> = {
          ...currentAddress,
          ...input.deliveryAddress,
        };

        // Check if address has changed (street or suburb)
        const addressChanged =
          (input.deliveryAddress.street !== undefined && input.deliveryAddress.street !== currentAddress?.street) ||
          (input.deliveryAddress.suburb !== undefined && input.deliveryAddress.suburb !== currentAddress?.suburb);

        // Handle geocoding if address changed but no valid coordinates provided
        if (addressChanged) {
          let { latitude, longitude } = input.deliveryAddress;

          if (!latitude || !longitude || latitude === 0 || longitude === 0) {
            const coords = await geocodeAddressCoordinates({
              street: (input.deliveryAddress.street ?? currentAddress?.street) as string,
              suburb: (input.deliveryAddress.suburb ?? currentAddress?.suburb) as string,
              state: (input.deliveryAddress.state ?? currentAddress?.state) as string,
              postcode: (input.deliveryAddress.postcode ?? currentAddress?.postcode) as string,
            });
            newAddress.latitude = coords.latitude;
            newAddress.longitude = coords.longitude;
          } else {
            newAddress.latitude = latitude;
            newAddress.longitude = longitude;
          }
        } else if (input.deliveryAddress.latitude !== undefined || input.deliveryAddress.longitude !== undefined) {
          // Coordinates explicitly provided without address change
          newAddress.latitude = input.deliveryAddress.latitude ?? currentAddress?.latitude;
          newAddress.longitude = input.deliveryAddress.longitude ?? currentAddress?.longitude;
        }

        // Handle area assignment
        const suburbChanged =
          input.deliveryAddress.suburb !== undefined &&
          input.deliveryAddress.suburb !== currentAddress?.suburb;
        const areaIdExplicitlyProvided = 'areaId' in input.deliveryAddress;

        if (areaIdExplicitlyProvided) {
          // Explicit area assignment (including null for unassigning)
          if (input.deliveryAddress.areaId) {
            const area = await prisma.area.findUnique({
              where: { id: input.deliveryAddress.areaId },
            });
            if (area) {
              newAddress.areaId = area.id;
              newAddress.areaName = area.name;
            }
          } else {
            // Explicitly set to null (unassign)
            newAddress.areaId = null;
            newAddress.areaName = null;
          }
        } else if (suburbChanged) {
          // Auto-assign area based on new suburb
          const suburb = input.deliveryAddress.suburb ?? '';
          const state = input.deliveryAddress.state ?? (currentAddress?.state as string);
          const suburbMapping = await prisma.suburbAreaMapping.findFirst({
            where: {
              suburb: { equals: suburb, mode: 'insensitive' },
              state: state,
              isActive: true,
            },
            include: { area: true },
          });
          if (suburbMapping?.area) {
            newAddress.areaId = suburbMapping.areaId;
            newAddress.areaName = suburbMapping.area.name;
          }
        }

        updateData.deliveryAddress = newAddress;
        changes.push({
          field: 'deliveryAddress',
          oldValue: currentAddress,
          newValue: newAddress,
        });
      }

      // Handle business information
      if (input.businessInfo) {
        if (input.businessInfo.businessName !== undefined) {
          updateData.businessName = input.businessInfo.businessName;
          changes.push({
            field: 'businessName',
            oldValue: currentCustomer.businessName,
            newValue: input.businessInfo.businessName,
          });
        }
        if (input.businessInfo.tradingName !== undefined) {
          updateData.tradingName = input.businessInfo.tradingName;
          changes.push({
            field: 'tradingName',
            oldValue: currentCustomer.tradingName,
            newValue: input.businessInfo.tradingName,
          });
        }
        if (input.businessInfo.abn !== undefined) {
          updateData.abn = input.businessInfo.abn;
          changes.push({
            field: 'abn',
            oldValue: currentCustomer.abn,
            newValue: input.businessInfo.abn,
          });
        }
        if (input.businessInfo.acn !== undefined) {
          updateData.acn = input.businessInfo.acn;
          changes.push({
            field: 'acn',
            oldValue: currentCustomer.acn,
            newValue: input.businessInfo.acn,
          });
        }
        if (input.businessInfo.accountType !== undefined) {
          updateData.accountType = input.businessInfo.accountType;
          changes.push({
            field: 'accountType',
            oldValue: currentCustomer.accountType,
            newValue: input.businessInfo.accountType,
          });
        }
      }

      // Handle billing address
      if (input.billingAddress !== undefined) {
        const newBillingAddress = input.billingAddress
          ? { ...input.billingAddress, country: input.billingAddress.country ?? 'Australia' }
          : null;
        updateData.billingAddress = newBillingAddress;
        changes.push({
          field: 'billingAddress',
          oldValue: currentCustomer.billingAddress,
          newValue: newBillingAddress,
        });
      }

      // Handle postal address
      if (input.postalSameAsBilling && input.billingAddress) {
        // Copy billing address to postal address
        const newPostalAddress = { ...input.billingAddress, country: input.billingAddress.country ?? 'Australia' };
        updateData.postalAddress = newPostalAddress;
        changes.push({
          field: 'postalAddress',
          oldValue: currentCustomer.postalAddress,
          newValue: newPostalAddress,
        });
      } else if (input.postalAddress !== undefined) {
        const newPostalAddress = input.postalAddress
          ? { ...input.postalAddress, country: input.postalAddress.country ?? 'Australia' }
          : null;
        updateData.postalAddress = newPostalAddress;
        changes.push({
          field: 'postalAddress',
          oldValue: currentCustomer.postalAddress,
          newValue: newPostalAddress,
        });
      }

      // Handle directors array
      if (input.directors !== undefined) {
        const newDirectors = input.directors.map((director) => ({
          ...director,
          residentialAddress: {
            ...director.residentialAddress,
            country: director.residentialAddress.country ?? 'Australia',
          },
        }));
        updateData.directors = newDirectors;
        changes.push({
          field: 'directors',
          oldValue: currentCustomer.directors,
          newValue: newDirectors,
        });
      }

      // Handle financial details
      if (input.financialDetails !== undefined) {
        updateData.financialDetails = input.financialDetails;
        changes.push({
          field: 'financialDetails',
          oldValue: currentCustomer.financialDetails,
          newValue: input.financialDetails,
        });
      }

      // Handle trade references array
      if (input.tradeReferences !== undefined) {
        // Preserve verified status if not explicitly changed
        const newTradeReferences = input.tradeReferences.map((ref) => ({
          ...ref,
          verified: ref.verified ?? false,
          verifiedAt: ref.verifiedAt ?? null,
        }));
        updateData.tradeReferences = newTradeReferences;
        changes.push({
          field: 'tradeReferences',
          oldValue: currentCustomer.tradeReferences,
          newValue: newTradeReferences,
        });
      }

      // Handle SMS reminder preferences
      if (input.smsReminderPreferences !== undefined) {
        const newSmsPreferences = {
          enabled: input.smsReminderPreferences.enabled,
          reminderDays: input.smsReminderPreferences.enabled
            ? input.smsReminderPreferences.reminderDays ?? []
            : [],
        };
        updateData.smsReminderPreferences = newSmsPreferences;
        changes.push({
          field: 'smsReminderPreferences',
          oldValue: currentCustomer.smsReminderPreferences,
          newValue: newSmsPreferences,
        });
      }

      const customer = await prisma.customer.update({
        where: { id: resolvedCustomerId },
        data: updateData,
      });

      // Log update to audit trail
      await prisma.auditLog.create({
        data: {
          userId: ctx.userId,
          action: 'update',
          entity: 'customer',
          entityId: customer.id,
          changes: changes as unknown as Array<{ field: string; oldValue: string | null; newValue: string | null }>,
          metadata: {
            actionType: 'update_details',
            businessName: customer.businessName,
          },
          timestamp: new Date(),
        },
      }).catch((error) => {
        console.error('Failed to log customer update:', error);
      });

      return customer;
    }),

  /**
   * Public geocoding endpoint for address search during onboarding
   * Uses Mapbox Geocoding API to get precise coordinates and parsed address parts
   */
  geocodeAddress: publicProcedure
    .input(
      z.object({
        address: z.string().min(1, 'Address is required'),
      })
    )
    .mutation(async ({ input }) => {
      const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

      if (!token) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Mapbox access token not configured',
        });
      }

      try {
        const encodedAddress = encodeURIComponent(input.address);
        // Use v6 API with secondary_address support for unit numbers
        const url = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodedAddress}&access_token=${token}&country=AU&limit=5&types=address,secondary_address`;

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error('Geocoding request failed');
        }

        const data = await response.json();

        if (!data.features || data.features.length === 0) {
          return { success: true, results: [] };
        }

        // Parse Mapbox v6 response into structured address parts
        const results = data.features.map(
          (feature: {
            properties: {
              full_address: string;
              feature_type: string;
              coordinates: { longitude: number; latitude: number };
              context: {
                address?: { street_name?: string; address_number?: string };
                locality?: { name?: string };
                place?: { name?: string };
                region?: { region_code?: string };
                postcode?: { name?: string };
              };
            };
            relevance?: number;
          }) => {
            const props = feature.properties;
            const context = props.context || {};

            // Build street address from v6 context
            const addressNumber = context.address?.address_number || '';
            const streetName = context.address?.street_name || '';
            let street = addressNumber ? `${addressNumber} ${streetName}` : streetName;

            // For secondary addresses, extract unit info from full_address
            if (props.feature_type === 'secondary_address') {
              // full_address format: "Unit 5, 123 Main Street, Suburb, State, Postcode, Australia"
              const parts = props.full_address.split(',');
              if (parts.length > 1) {
                // Take first two parts (unit + street address)
                street = `${parts[0].trim()}, ${parts[1].trim()}`;
              }
            }

            // Extract suburb, state, postcode from context
            const suburb = context.locality?.name || context.place?.name || '';
            const regionCode = context.region?.region_code || '';
            // Convert "AU-NSW" to "NSW"
            const state = regionCode.replace('AU-', '');
            const postcode = context.postcode?.name || '';

            return {
              fullAddress: props.full_address,
              street,
              suburb,
              state,
              postcode,
              latitude: props.coordinates.latitude,
              longitude: props.coordinates.longitude,
              relevance: feature.relevance || 1,
            };
          }
        );

        return { success: true, results };
      } catch (error) {
        console.error('Geocoding error:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Geocoding failed',
        });
      }
    }),

  // Admin: Invite customer to portal
  inviteCustomer: requirePermission('customers:create')
    .input(
      z.object({
        customerId: z.string(),
        email: z.string().email(),
      })
    )
    .mutation(async ({ input }) => {
      const resolvedCustomerId = await resolveCustomerId(input.customerId);

      const customer = await prisma.customer.findUnique({
        where: { id: resolvedCustomerId },
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      if (!customer.clerkUserId.startsWith('admin_created_')) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This customer already has a portal account',
        });
      }

      // Create Clerk invitation in the customer portal's Clerk instance
      try {
        const clerkBackend = await getCustomerPortalClerkClient();

        const customerPortalUrl = process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL || 'http://localhost:3000';

        await clerkBackend.invitations.createInvitation({
          emailAddress: input.email,
          publicMetadata: {
            role: 'customer',
            customerId: resolvedCustomerId,
          },
          redirectUrl: `${customerPortalUrl}/sign-up`,
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Clerk invitation error:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to send invitation',
        });
      }

      // Update customer record
      const updated = await prisma.customer.update({
        where: { id: resolvedCustomerId },
        data: {
          portalInvitationStatus: 'invited',
          portalInvitedAt: new Date(),
          portalInvitedEmail: input.email,
        },
      });

      return updated;
    }),

  // Admin: Revoke and resend invitation
  revokeAndResendInvitation: requirePermission('customers:create')
    .input(
      z.object({
        customerId: z.string(),
        email: z.string().email(),
      })
    )
    .mutation(async ({ input }) => {
      const resolvedCustomerId = await resolveCustomerId(input.customerId);

      const customer = await prisma.customer.findUnique({
        where: { id: resolvedCustomerId },
      });

      if (!customer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Customer not found',
        });
      }

      if (!customer.clerkUserId.startsWith('admin_created_')) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This customer already has a portal account',
        });
      }

      try {
        const clerkBackend = await getCustomerPortalClerkClient();

        // Revoke existing invitations for this email
        const invitations = await clerkBackend.invitations.getInvitationList();
        for (const inv of invitations.data) {
          if (
            inv.emailAddress === customer.portalInvitedEmail &&
            inv.status === 'pending'
          ) {
            await clerkBackend.invitations.revokeInvitation(inv.id);
          }
        }

        // Create new invitation
        const customerPortalUrl = process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL || 'http://localhost:3000';

        await clerkBackend.invitations.createInvitation({
          emailAddress: input.email,
          publicMetadata: {
            role: 'customer',
            customerId: resolvedCustomerId,
          },
          redirectUrl: `${customerPortalUrl}/sign-up`,
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Clerk invitation error:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to resend invitation',
        });
      }

      // Update customer record
      const updated = await prisma.customer.update({
        where: { id: resolvedCustomerId },
        data: {
          portalInvitationStatus: 'invited',
          portalInvitedAt: new Date(),
          portalInvitedEmail: input.email,
        },
      });

      return updated;
    }),
});
