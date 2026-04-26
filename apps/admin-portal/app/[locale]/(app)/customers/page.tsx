'use client';

export const dynamic = 'force-dynamic';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Input,
  ResponsiveTable,
  type TableColumn,
  StatusBadge,
  type StatusType,
  CountUp,
  EmptyState,
  TableSkeleton,
  AreaBadge,
} from '@joho-erp/ui';
import { Search, UserPlus, Check, X, Eye, Mail, Phone, MapPin, CreditCard, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { api } from '@/trpc/client';
import { formatAUD } from '@joho-erp/shared';
import { useTableSort } from '@joho-erp/shared/hooks';
import { PermissionGate } from '@/components/permission-gate';

type Customer = {
  id: string;
  businessName: string;
  abn: string;
  createdAt?: string | Date;
  contactPerson: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  };
  status: StatusType;
  creditApplication: {
    status: StatusType;
    creditLimit: number;
  };
  deliveryAddress: {
    areaName?: string;
  };
  arBalance?: {
    outstandingCents?: number;
    overdueCents?: number;
  } | null;
  orders?: number;
};

export default function CustomersPage() {
  const t = useTranslations('customers');
  const tCommon = useTranslations('common');
  const searchParams = useSearchParams();
  const [searchQuery, setSearchQuery] = useState('');

  // Filter state (server-side)
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [creditStatusFilter, setCreditStatusFilter] = useState<string>(
    searchParams.get('approvalStatus') || ''
  );
  const [areaFilter, setAreaFilter] = useState<string>('');

  // Fetch areas dynamically for filter dropdown
  const { data: areas } = api.area.list.useQuery();

  // Sorting state (server-side)
  const { sortBy, sortOrder, handleSort } = useTableSort('businessName', 'asc');

  const { data, isLoading, error } = api.customer.getAll.useQuery({
    search: searchQuery || undefined,
    status: statusFilter as 'active' | 'suspended' | 'closed' || undefined,
    approvalStatus: creditStatusFilter as 'pending' | 'approved' | 'rejected' || undefined,
    areaId: areaFilter || undefined, // Use areaId instead of areaTag
    sortBy,
    sortOrder,
    limit: 100,
  });

  // TODO: Implement approval mutations when needed
  // const _approveMutation = api.customer.approveCredit.useMutation();
  // const _rejectMutation = api.customer.rejectCredit.useMutation();

  // Data from API with fallbacks for loading state (already sorted server-side)
  const customers = (data?.customers ?? []) as Customer[];
  const totalCustomers = data?.total ?? 0;
  const activeCustomers = customers.filter((c) => c.status === 'active').length;
  const pendingCredit = customers.filter((c) => c.creditApplication.status === 'pending').length;

  if (error) {
    return (
      <div className="container mx-auto px-4 py-12">
        <div className="flex flex-col items-center justify-center">
          <p className="text-destructive text-lg mb-2">{t('errorLoading')}</p>
          <p className="text-sm text-muted-foreground">{error.message}</p>
        </div>
      </div>
    );
  }

  const columns: TableColumn<Customer>[] = [
    {
      key: 'businessName',
      label: t('businessName'),
      className: 'font-medium',
      sortable: true,
    },
    {
      key: 'contactPerson',
      label: t('contactPerson'),
      render: (customer) => `${customer.contactPerson.firstName} ${customer.contactPerson.lastName}`,
    },
    {
      key: 'email',
      label: t('email'),
      className: 'text-sm text-muted-foreground',
      render: (customer) => customer.contactPerson.email,
    },
    {
      key: 'area',
      label: t('area'),
      render: (customer) => {
        const areaDisplay = customer.deliveryAddress.areaName;
        return areaDisplay ? <AreaBadge area={areaDisplay} /> : null;
      },
    },
    {
      key: 'status',
      label: tCommon('status'),
      render: (customer) => <StatusBadge status={customer.status} />,
    },
    {
      key: 'creditStatus',
      label: t('creditStatus'),
      render: (customer) => <StatusBadge status={customer.creditApplication.status as StatusType} />,
    },
    {
      key: 'creditLimit',
      label: t('creditLimit'),
      sortable: true,
      render: (customer) =>
        customer.creditApplication.creditLimit > 0
          ? formatAUD(customer.creditApplication.creditLimit)
          : '-',
    },
    {
      key: 'outstanding',
      label: t('cols.outstanding'),
      sortable: true,
      render: (customer) =>
        customer.arBalance?.outstandingCents
          ? formatAUD(customer.arBalance.outstandingCents)
          : '-',
    },
    {
      key: 'overdue',
      label: t('cols.overdue'),
      sortable: true,
      render: (customer) =>
        customer.arBalance?.overdueCents
          ? <span className="text-destructive">{formatAUD(customer.arBalance.overdueCents)}</span>
          : '-',
    },
    {
      key: 'orders',
      label: t('orders'),
      sortable: true,
      render: (customer) => customer.orders || 0,
    },
    {
      key: 'actions',
      label: tCommon('actions'),
      className: 'text-right',
      render: (customer) => (
        <div className="flex justify-end gap-2">
          {customer.creditApplication.status === 'pending' && (
            <PermissionGate permission="customers:approve_credit">
              <Link href={`/customers/${customer.id}/credit-review`}>
                <Button variant="default" size="sm">
                  {t('reviewCredit')}
                </Button>
              </Link>
            </PermissionGate>
          )}
          <Link href={`/customers/${customer.id}`}>
            <Button variant="ghost" size="sm" aria-label={t('view')}>
              <Eye className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      ),
    },
  ];

  // Mobile card view
  const mobileCard = (customer: Customer) => (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <h3 className="font-semibold text-base">{customer.businessName}</h3>
          <p className="text-sm text-muted-foreground">
            {customer.contactPerson.firstName} {customer.contactPerson.lastName}
          </p>
        </div>
        <StatusBadge status={customer.status} />
      </div>

      {/* Contact Info */}
      <div className="space-y-2 text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Mail className="h-4 w-4" />
          <span>{customer.contactPerson.email}</span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Phone className="h-4 w-4" />
          <span>{customer.contactPerson.phone}</span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <MapPin className="h-4 w-4" />
          <span className="flex items-center gap-1">
            {t('area')}:{' '}
            {customer.deliveryAddress.areaName ? (
              <AreaBadge area={customer.deliveryAddress.areaName} />
            ) : (
              '-'
            )}
          </span>
        </div>
      </div>

      {/* Credit Info */}
      <div className="flex items-center justify-between pt-2 border-t">
        <div className="flex items-center gap-2">
          <CreditCard className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">
              {customer.creditApplication.creditLimit > 0
                ? formatAUD(customer.creditApplication.creditLimit)
                : t('noCredit')}
            </p>
            <StatusBadge status={customer.creditApplication.status as StatusType} showIcon={false} />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{t('ordersCount', { count: customer.orders || 0 })}</p>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-2">
        {customer.creditApplication.status === 'pending' && (
          <PermissionGate permission="customers:approve_credit">
            <Button variant="outline" size="sm" className="flex-1">
              <Check className="h-4 w-4 mr-1" />
              {t('approve')}
            </Button>
            <Button variant="outline" size="sm" className="flex-1">
              <X className="h-4 w-4 mr-1" />
              {t('reject')}
            </Button>
          </PermissionGate>
        )}
        <Button variant="outline" size="sm" className="flex-1">
          <Eye className="h-4 w-4 mr-1" />
          {t('view')}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="container mx-auto px-4 py-6 md:py-10">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6 md:mb-8">
        <div>
          <h1 className="text-2xl md:text-4xl font-bold">{t('title')}</h1>
          <p className="text-sm md:text-base text-muted-foreground mt-1 md:mt-2">
            {t('subtitle')}
          </p>
        </div>
        <PermissionGate permission="customers:create">
          <Link href="/customers/new">
            <Button className="btn-enhanced btn-primary-enhanced w-full sm:w-auto">
              <UserPlus className="mr-2 h-4 w-4" />
              {t('addCustomer')}
            </Button>
          </Link>
        </PermissionGate>
      </div>

      {/* Stats */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-6 md:mb-8">
        <Card className="stat-card animate-fade-in-up">
          <div className="stat-card-gradient" />
          <CardHeader className="pb-3 relative">
            <CardDescription>{t('totalCustomers')}</CardDescription>
            <div className="stat-value tabular-nums">
              <CountUp end={totalCustomers} />
            </div>
          </CardHeader>
        </Card>
        <Card className="stat-card animate-fade-in-up delay-100">
          <div className="stat-card-gradient" />
          <CardHeader className="pb-3 relative">
            <CardDescription>{t('active')}</CardDescription>
            <div className="stat-value tabular-nums text-success">
              <CountUp end={activeCustomers} />
            </div>
          </CardHeader>
        </Card>
        <Card className="stat-card animate-fade-in-up delay-200">
          <div className="stat-card-gradient" />
          <CardHeader className="pb-3 relative">
            <CardDescription>{t('pendingCreditApproval')}</CardDescription>
            <div className="stat-value tabular-nums text-warning">
              <CountUp end={pendingCredit} />
            </div>
          </CardHeader>
        </Card>
        <Card className="stat-card animate-fade-in-up delay-300">
          <div className="stat-card-gradient" />
          <CardHeader className="pb-3 relative">
            <CardDescription>{t('totalOrders')}</CardDescription>
            <div className="stat-value tabular-nums">
              <CountUp end={customers.reduce((sum, c) => sum + (c.orders || 0), 0)} />
            </div>
          </CardHeader>
        </Card>
      </div>

      {/* Search and Filter */}
      <Card className="mb-6">
        <CardHeader className="p-4">
          <div className="flex flex-col gap-4">
            {/* Search row */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('searchPlaceholder')}
                className="pl-10"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            {/* Filter row */}
            <div className="flex flex-wrap gap-2">
              {/* Customer Status Filter */}
              <select
                className="flex h-10 w-full md:w-[160px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">{t('filters.allStatuses')}</option>
                <option value="active">{t('active')}</option>
                <option value="suspended">{t('suspended')}</option>
                <option value="closed">{t('closed')}</option>
              </select>

              {/* Credit Status Filter */}
              <select
                className="flex h-10 w-full md:w-[180px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={creditStatusFilter}
                onChange={(e) => setCreditStatusFilter(e.target.value)}
              >
                <option value="">{t('filters.allCreditStatuses')}</option>
                <option value="pending">{t('pending')}</option>
                <option value="approved">{t('approved')}</option>
                <option value="rejected">{t('rejected')}</option>
              </select>

              {/* Area Filter - Dynamic areas from API */}
              <select
                className="flex h-10 w-full md:w-[160px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={areaFilter}
                onChange={(e) => setAreaFilter(e.target.value)}
              >
                <option value="">{t('filters.allAreas')}</option>
                {areas?.map((area) => (
                  <option key={area.id} value={area.id}>
                    {area.displayName}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Customers Table/Cards */}
      <Card>
        <CardHeader>
          <CardTitle>{t('listTitle')}</CardTitle>
          <CardDescription>{t('listDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="p-4 md:p-6">
          {isLoading ? (
            <TableSkeleton rows={5} columns={10} />
          ) : customers.length > 0 ? (
            <ResponsiveTable
              data={customers}
              columns={columns}
              mobileCard={mobileCard}
              className="md:border-0"
              sortColumn={sortBy}
              sortDirection={sortOrder}
              onSort={handleSort}
            />
          ) : (
            <EmptyState
              icon={Users}
              title={t('noCustomersFound')}
              description={
                searchQuery || statusFilter || creditStatusFilter || areaFilter
                  ? t('adjustFilters')
                  : t('addFirstCustomer')
              }
              action={!searchQuery && !statusFilter && !creditStatusFilter && !areaFilter ? {
                label: t('addCustomer'),
                onClick: () => window.location.href = '/customers/new'
              } : undefined}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
