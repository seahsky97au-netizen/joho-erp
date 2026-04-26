import { getPrismaClient } from '@joho-erp/database';

interface CreateTestCustomerOptions {
  clerkUserId?: string;
  businessName?: string;
  abn?: string;
  accountType?: 'sole_trader' | 'partnership' | 'company' | 'other';
  status?: 'active' | 'suspended' | 'closed';
  creditLimit?: number; // in cents
  creditStatus?: 'pending' | 'approved' | 'rejected';
  paymentTerms?: string;
  contactEmail?: string;
  contactFirstName?: string;
  contactLastName?: string;
  contactPhone?: string;
  deliveryStreet?: string;
  deliverySuburb?: string;
  deliveryState?: string;
  deliveryPostcode?: string;
  areaId?: string;
  areaName?: string;
  onboardingComplete?: boolean;
  xeroContactId?: string;
  arBalance?: {
    outstandingCents?: number;
    overdueCents?: number;
    currency?: string;
    lastSyncedAt?: Date;
    lastSyncSource?: string;
  };
}

let customerCounter = 0;

export async function createTestCustomer(options: CreateTestCustomerOptions = {}) {
  const prisma = getPrismaClient();
  customerCounter++;

  return prisma.customer.create({
    data: {
      clerkUserId: options.clerkUserId ?? `test-clerk-user-${customerCounter}-${Date.now()}`,
      accountType: options.accountType ?? 'company',
      businessName: options.businessName ?? `Test Business ${customerCounter}`,
      abn: options.abn ?? `${String(customerCounter).padStart(11, '0')}`,
      contactPerson: {
        firstName: options.contactFirstName ?? 'Test',
        lastName: options.contactLastName ?? `Customer${customerCounter}`,
        email: options.contactEmail ?? `customer${customerCounter}@test.com`,
        phone: options.contactPhone ?? '0400000000',
      },
      deliveryAddress: {
        street: options.deliveryStreet ?? '123 Test Street',
        suburb: options.deliverySuburb ?? 'Melbourne',
        state: options.deliveryState ?? 'VIC',
        postcode: options.deliveryPostcode ?? '3000',
        country: 'Australia',
        areaId: options.areaId ?? undefined,
        areaName: options.areaName ?? undefined,
      },
      creditApplication: {
        status: options.creditStatus ?? 'approved',
        creditLimit: options.creditLimit ?? 500000, // $5000 default
        paymentTerms: options.paymentTerms ?? 'Net 30',
        appliedAt: new Date(),
      },
      status: options.status ?? 'active',
      onboardingComplete: options.onboardingComplete ?? true,
      xeroContactId: options.xeroContactId,
      arBalance: options.arBalance
        ? {
            outstandingCents: options.arBalance.outstandingCents ?? 0,
            overdueCents: options.arBalance.overdueCents ?? 0,
            currency: options.arBalance.currency ?? 'AUD',
            lastSyncedAt: options.arBalance.lastSyncedAt ?? new Date(),
            lastSyncSource: options.arBalance.lastSyncSource ?? 'manual',
          }
        : undefined,
    },
  });
}
