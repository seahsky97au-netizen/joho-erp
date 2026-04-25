import { z } from 'zod';
import { router, requirePermission, requireAnyPermission } from '../trpc';
import { prisma } from '@joho-erp/database';
import { TRPCError } from '@trpc/server';
import { validateABN } from '@joho-erp/shared';
import * as xeroService from '../services/xero';
import { createHash } from 'crypto';
import {
  logCompanyProfileUpdate,
  logCompanyLogoUpdate,
  logXeroSettingsUpdate,
  logDeliverySettingsUpdate,
  logPackingPinUpdate,
} from '../services/audit';
import type { AuditChange } from '../services/audit';

export const companyRouter = router({
  /**
   * Get company settings including delivery configuration
   */
  getSettings: requireAnyPermission(['settings.company:view', 'settings.delivery:view', 'settings.xero:view']).query(async () => {
    const company = await prisma.company.findFirst({
      select: {
        id: true,
        businessName: true,
        abn: true,
        address: true,
        contactPerson: true,
        bankDetails: true,
        xeroSettings: true,
        deliverySettings: true,
        notificationSettings: true,
        logoUrl: true,
      },
    });

    return company ?? null;
  }),

  /**
   * Update company profile (business info, address, bank details)
   */
  updateProfile: requirePermission('settings.company:edit')
    .input(
      z.object({
        businessName: z.string().min(1, 'Business name is required'),
        abn: z.string().length(11).refine(validateABN, 'Invalid ABN checksum'),
        address: z.object({
          street: z.string().min(1, 'Street address is required'),
          suburb: z.string().min(1, 'Suburb is required'),
          state: z.string().min(1, 'State is required'),
          postcode: z.string().min(4, 'Valid postcode is required'),
          country: z.string().default('Australia'),
        }),
        contactPerson: z.object({
          firstName: z.string().min(1, 'First name is required'),
          lastName: z.string().min(1, 'Last name is required'),
          email: z.string().email('Valid email is required'),
          phone: z.string().min(1, 'Phone is required'),
          mobile: z.string().optional(),
        }),
        bankDetails: z.object({
          bankName: z.string().min(1, 'Bank name is required'),
          accountName: z.string().min(1, 'Account name is required'),
          bsb: z.string().min(6, 'Valid BSB is required'),
          accountNumber: z.string().min(1, 'Account number is required'),
        }).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const company = await prisma.company.findFirst();

      const data = {
        businessName: input.businessName,
        abn: input.abn,
        address: input.address,
        contactPerson: input.contactPerson,
        bankDetails: input.bankDetails || null,
      };

      if (company) {
        // Track changes for audit
        const changes: AuditChange[] = [];
        if (company.businessName !== input.businessName) {
          changes.push({ field: 'businessName', oldValue: company.businessName, newValue: input.businessName });
        }
        if (company.abn !== input.abn) {
          changes.push({ field: 'abn', oldValue: company.abn, newValue: input.abn });
        }

        const updated = await prisma.company.update({
          where: { id: company.id },
          data,
        });

        // Audit log - CRITICAL: Company profile changes must be tracked
        await logCompanyProfileUpdate(ctx.userId, undefined, ctx.userRole, ctx.userName, company.id, changes, {
          businessName: input.businessName,
          changeType: 'profile',
        }).catch((error) => {
          console.error('Audit log failed for company profile update:', error);
        });

        return {
          success: true,
          message: 'Company profile updated successfully',
          company: updated,
        };
      }

      // No company exists — create one
      const created = await prisma.company.create({ data });

      await logCompanyProfileUpdate(ctx.userId, undefined, ctx.userRole, ctx.userName, created.id, [], {
        businessName: input.businessName,
        changeType: 'profile_created',
      }).catch((error) => {
        console.error('Audit log failed for company profile creation:', error);
      });

      return {
        success: true,
        message: 'Company profile created successfully',
        company: created,
      };
    }),

  /**
   * Update logo URL
   */
  updateLogo: requirePermission('settings.company:edit')
    .input(
      z.object({
        logoUrl: z.string().url('Valid URL is required'),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const company = await prisma.company.findFirst();

      if (!company) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Company not found',
        });
      }

      const previousLogoUrl = company.logoUrl || undefined;

      const updated = await prisma.company.update({
        where: { id: company.id },
        data: {
          logoUrl: input.logoUrl,
        },
      });

      // Audit log - Company logo changes
      await logCompanyLogoUpdate(ctx.userId, undefined, ctx.userRole, ctx.userName, company.id, {
        previousLogoUrl,
        newLogoUrl: input.logoUrl,
      }).catch((error) => {
        console.error('Audit log failed for company logo update:', error);
      });

      return {
        success: true,
        message: 'Company logo updated successfully',
        logoUrl: updated.logoUrl,
      };
    }),

  /**
   * Test Xero connection with detailed verification
   */
  testXeroConnection: requirePermission('settings.xero:sync').mutation(async () => {
    const company = await prisma.company.findFirst();

    if (!company || !company.xeroSettings) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Xero settings not configured',
      });
    }

    // Use detailed test for comprehensive verification
    const result = await xeroService.testConnectionDetailed();

    return {
      success: result.success,
      message: result.message,
      connected: result.success,
      tenantName: result.details.tenantName,
      details: result.details,
      errors: result.errors,
    };
  }),

  /**
   * Get Xero connection status
   */
  getXeroStatus: requirePermission('settings.xero:view').query(async () => {
    const status = await xeroService.getConnectionStatus();

    return {
      enabled: status.enabled,
      connected: status.connected,
      tenantId: status.tenantId,
      tokenExpiry: status.tokenExpiry,
      needsRefresh: status.needsRefresh,
    };
  }),

  /**
   * Disconnect from Xero
   */
  disconnectXero: requirePermission('settings.integrations:edit').mutation(async ({ ctx }) => {
    try {
      const company = await prisma.company.findFirst();

      await xeroService.disconnect();

      // Audit log - CRITICAL: Xero disconnect must be tracked
      if (company) {
        await logXeroSettingsUpdate(ctx.userId, undefined, ctx.userRole, ctx.userName, company.id, {
          action: 'disconnect',
        }).catch((error) => {
          console.error('Audit log failed for Xero disconnect:', error);
        });
      }

      return {
        success: true,
        message: 'Successfully disconnected from Xero',
      };
    } catch (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: error instanceof Error ? error.message : 'Failed to disconnect from Xero',
      });
    }
  }),

  /**
   * Update delivery settings (warehouse address, Mapbox token, cut-off times)
   */
  updateDeliverySettings: requirePermission('settings.delivery:edit')
    .input(
      z.object({
        warehouseAddress: z.object({
          street: z.string().min(1, 'Street address is required'),
          suburb: z.string().min(1, 'Suburb is required'),
          state: z.string().min(1, 'State is required'),
          postcode: z.string().min(4, 'Valid postcode is required'),
          country: z.string().default('Australia'),
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
        }),
        orderCutoffTime: z.string().regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:mm)').default('14:00'),
        cutoffByArea: z.record(z.string()).optional(),
        workingDays: z
          .array(z.number().int().min(0).max(6))
          .min(1, 'At least one working day must be selected')
          .optional(),
        defaultDeliveryWindow: z.string().optional(),
        minimumOrderAmount: z.number().int().positive().optional(), // In cents
        manualDriverAssignment: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Get existing company
      const company = await prisma.company.findFirst();

      if (!company) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Company not found',
        });
      }

      // Track changes for audit
      const changes: AuditChange[] = [];
      const oldSettings = company.deliverySettings as Record<string, unknown> | null;
      if (oldSettings?.orderCutoffTime !== input.orderCutoffTime) {
        changes.push({ field: 'orderCutoffTime', oldValue: oldSettings?.orderCutoffTime, newValue: input.orderCutoffTime });
      }
      if (oldSettings?.minimumOrderAmount !== input.minimumOrderAmount) {
        changes.push({
          field: 'minimumOrderAmount',
          oldValue: oldSettings?.minimumOrderAmount,
          newValue: input.minimumOrderAmount,
        });
      }
      const oldManualDriverAssignment =
        typeof oldSettings?.manualDriverAssignment === 'boolean'
          ? (oldSettings.manualDriverAssignment as boolean)
          : false;
      const newManualDriverAssignment = input.manualDriverAssignment ?? false;
      if (oldManualDriverAssignment !== newManualDriverAssignment) {
        changes.push({
          field: 'manualDriverAssignment',
          oldValue: oldManualDriverAssignment,
          newValue: newManualDriverAssignment,
        });
      }
      const oldWorkingDays = Array.isArray(oldSettings?.workingDays)
        ? (oldSettings.workingDays as number[])
        : undefined;
      const newWorkingDays = input.workingDays;
      const workingDaysChanged =
        newWorkingDays !== undefined &&
        (oldWorkingDays === undefined ||
          oldWorkingDays.length !== newWorkingDays.length ||
          !oldWorkingDays.every((d) => newWorkingDays.includes(d)));
      if (workingDaysChanged) {
        changes.push({
          field: 'workingDays',
          oldValue: oldWorkingDays,
          newValue: newWorkingDays,
        });
      }

      // Extract old warehouse coordinates for change detection
      const oldWarehouse = oldSettings?.warehouseAddress as { latitude?: number; longitude?: number } | undefined;
      const oldLatitude = oldWarehouse?.latitude;
      const oldLongitude = oldWarehouse?.longitude;

      // Preserve existing workingDays if not provided in this update
      const persistedWorkingDays =
        input.workingDays ??
        (Array.isArray(oldSettings?.workingDays)
          ? (oldSettings.workingDays as number[])
          : [1, 2, 3, 4, 5, 6]); // Default Mon-Sat for new/legacy companies

      // Update company with delivery settings
      const updated = await prisma.company.update({
        where: { id: company.id },
        data: {
          deliverySettings: {
            warehouseAddress: input.warehouseAddress,
            orderCutoffTime: input.orderCutoffTime,
            cutoffByArea: input.cutoffByArea || null,
            workingDays: persistedWorkingDays,
            defaultDeliveryWindow: input.defaultDeliveryWindow || null,
            minimumOrderAmount: input.minimumOrderAmount || null,
            manualDriverAssignment: newManualDriverAssignment,
          },
        },
      });

      // Check if warehouse coordinates changed significantly (~11m threshold to avoid GPS drift)
      const COORDINATE_THRESHOLD = 0.0001;
      const coordinatesChanged =
        oldLatitude === undefined ||
        oldLongitude === undefined ||
        Math.abs(oldLatitude - input.warehouseAddress.latitude) > COORDINATE_THRESHOLD ||
        Math.abs(oldLongitude - input.warehouseAddress.longitude) > COORDINATE_THRESHOLD;

      // Mark future/today's routes for reoptimization if warehouse location changed
      let routesMarkedCount = 0;
      if (coordinatesChanged) {
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);

        const result = await prisma.routeOptimization.updateMany({
          where: {
            deliveryDate: { gte: today },
          },
          data: {
            needsReoptimization: true,
          },
        });
        routesMarkedCount = result.count;

        // Add coordinate change to audit trail
        changes.push({
          field: 'warehouseCoordinates',
          oldValue: oldLatitude !== undefined ? `${oldLatitude},${oldLongitude}` : 'not set',
          newValue: `${input.warehouseAddress.latitude},${input.warehouseAddress.longitude}`,
        });
      }

      // Audit log - HIGH: Delivery settings changes affect operations
      await logDeliverySettingsUpdate(ctx.userId, undefined, ctx.userRole, ctx.userName, company.id, changes, {
        settingType: 'delivery',
      }).catch((error) => {
        console.error('Audit log failed for delivery settings update:', error);
      });

      return {
        success: true,
        message:
          coordinatesChanged && routesMarkedCount > 0
            ? `Delivery settings updated. ${routesMarkedCount} route(s) will be recalculated.`
            : 'Delivery settings updated successfully',
        settings: updated.deliverySettings,
      };
    }),

  /**
   * Geocode an address using Mapbox
   */
  geocodeAddress: requirePermission('settings.delivery:edit')
    .input(
      z.object({
        address: z.string().min(1, 'Address is required'),
      })
    )
    .mutation(async ({ input }) => {
      // Get token from environment variable
      const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

      if (!token) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
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
          throw new Error('No results found for this address');
        }

        // Return formatted results from v6 response format
        return {
          success: true,
          results: data.features.map(
            (feature: {
              properties: {
                full_address: string;
                coordinates: { longitude: number; latitude: number };
              };
              relevance?: number;
            }) => ({
              address: feature.properties.full_address,
              latitude: feature.properties.coordinates.latitude,
              longitude: feature.properties.coordinates.longitude,
              relevance: feature.relevance || 1,
            })
          ),
        };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Geocoding failed',
        });
      }
    }),

  /**
   * Get packing settings (PIN configuration status)
   */
  getPackingSettings: requireAnyPermission(['settings.packing:view', 'settings.packing:edit']).query(async () => {
    const company = await prisma.company.findFirst({
      select: {
        packingSettings: true,
      },
    });

    return {
      pinConfigured: !!company?.packingSettings?.quantityPinHash,
      pinUpdatedAt: company?.packingSettings?.pinUpdatedAt || null,
    };
  }),

  /**
   * Update packing PIN for quantity modifications
   */
  updatePackingPin: requirePermission('settings.packing:edit')
    .input(
      z.object({
        pin: z.string().regex(/^\d{4}$/, 'PIN must be exactly 4 digits').optional(),
        removePin: z.boolean().optional(),
      }).refine(
        (data) => data.removePin || data.pin,
        { message: 'Either pin or removePin must be provided' }
      )
    )
    .mutation(async ({ input, ctx }) => {
      const company = await prisma.company.findFirst();

      if (!company) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Company not found',
        });
      }

      // Hash the PIN using SHA-256
      const pinHash = input.pin
        ? createHash('sha256').update(input.pin).digest('hex')
        : null;

      await prisma.company.update({
        where: { id: company.id },
        data: {
          packingSettings: input.removePin
            ? null
            : {
                quantityPinHash: pinHash,
                pinUpdatedAt: new Date(),
                pinUpdatedBy: ctx.userId,
              },
        },
      });

      // Audit log - CRITICAL: Packing PIN changes must be tracked
      await logPackingPinUpdate(ctx.userId, undefined, ctx.userRole, ctx.userName, company.id, {
        pinChanged: true,
        pinEnabled: !input.removePin,
      }).catch((error) => {
        console.error('Audit log failed for packing PIN update:', error);
      });

      return {
        success: true,
        message: input.removePin ? 'PIN removed successfully' : 'PIN updated successfully',
      };
    }),

  // Get inventory settings
  getInventorySettings: requireAnyPermission(['settings.company:view', 'inventory:view']).query(
    async () => {
      const company = await prisma.company.findFirst({
        select: {
          inventorySettings: true,
        },
      });

      return {
        expiryAlertDays: company?.inventorySettings?.expiryAlertDays || 7,
      };
    }
  ),

  // Update inventory settings
  updateInventorySettings: requirePermission('settings.company:edit')
    .input(
      z.object({
        expiryAlertDays: z.number().int().min(1).max(90),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const company = await prisma.company.findFirst();

      if (!company) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Company not found',
        });
      }

      // Track changes for audit
      const changes: AuditChange[] = [];
      const oldSettings = company.inventorySettings as { expiryAlertDays?: number } | null;
      if (oldSettings?.expiryAlertDays !== input.expiryAlertDays) {
        changes.push({
          field: 'expiryAlertDays',
          oldValue: oldSettings?.expiryAlertDays || 7,
          newValue: input.expiryAlertDays,
        });
      }

      const updated = await prisma.company.update({
        where: { id: company.id },
        data: {
          inventorySettings: {
            expiryAlertDays: input.expiryAlertDays,
          },
        },
      });

      // Audit log
      await logCompanyProfileUpdate(
        ctx.userId,
        undefined,
        ctx.userRole,
        ctx.userName,
        company.id,
        changes,
        {
          businessName: company.businessName,
          changeType: 'inventory_settings',
        }
      ).catch((error) => {
        console.error('Audit log failed for inventory settings update:', error);
      });

      return {
        success: true,
        message: 'Inventory settings updated successfully',
        settings: updated.inventorySettings,
      };
    }),
});
