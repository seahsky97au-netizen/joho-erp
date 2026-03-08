'use client';

export const dynamic = 'force-dynamic';

import { useState, useMemo, useCallback } from 'react';
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
  toast,
  TableSkeleton,
} from '@joho-erp/ui';
import { Search, ShoppingBag, Eye, Package, PackageX, Plus, AlertTriangle, Calendar } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { api } from '@/trpc/client';
import { formatAUD } from '@joho-erp/shared';
import { useTableSort } from '@joho-erp/shared/hooks';
import { PermissionGate } from '@/components/permission-gate';
import { BackorderStatusBadge } from './components/BackorderStatusBadge';
import { BackorderApprovalDialog, type BackorderOrder } from './components/BackorderApprovalDialog';
import { ConfirmOrderDialog, type ConfirmOrder } from './components/ConfirmOrderDialog';
import { XeroOrderSyncBadge } from '@/components/xero-sync-badge';
import { CheckCircle } from 'lucide-react';

type Order = {
  id: string;
  orderNumber: string;
  customerName: string;
  orderedAt: Date;
  status: StatusType;
  totalAmount: number;
  requestedDeliveryDate: Date;
  stockShortfall?: Record<
    string,
    {
      requested: number;
      available: number;
      shortfall: number;
    }
  >;
  approvedQuantities?: Record<string, number>;
  items: Array<{
    productId: string;
    productName: string;
    sku: string;
    quantity: number;
    unit: string;
    unitPrice: number;
  }>;
  deliveryAddress: {
    areaName: string | null;
  };
};

export default function OrdersPage() {
  const t = useTranslations('orders');
  const tCommon = useTranslations('common');
  const tAlert = useTranslations('orders.backorderAlert');
  const tMessages = useTranslations('orders.backorderMessages');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [areaFilter, setAreaFilter] = useState<string>('');
  const [backorderFilter, setBackorderFilter] = useState<string>('');
  const [selectedOrder, setSelectedOrder] = useState<BackorderOrder | null>(null);
  const [isApprovalDialogOpen, setIsApprovalDialogOpen] = useState(false);
  const [selectedConfirmOrder, setSelectedConfirmOrder] = useState<ConfirmOrder | null>(null);
  const [isConfirmDialogOpen, setIsConfirmDialogOpen] = useState(false);

  // Date filter state - default to today (using local timezone)
  const today = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);

  const [orderDate, setOrderDate] = useState<Date | null>(today);

  // Date input value helper - uses local timezone methods
  const dateInputValue = useMemo(() => {
    if (!orderDate) return '';
    const year = orderDate.getFullYear();
    const month = String(orderDate.getMonth() + 1).padStart(2, '0');
    const day = String(orderDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }, [orderDate]);

  // End of day timestamp for date filtering (23:59:59.999 local time)
  const orderDateEnd = useMemo(() => {
    if (!orderDate) return null;
    const endOfDay = new Date(orderDate.getTime());
    endOfDay.setHours(23, 59, 59, 999);
    return endOfDay;
  }, [orderDate]);

  // Date change handler - creates local midnight
  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.value) {
      setOrderDate(null);
      return;
    }
    const [year, month, day] = e.target.value.split('-').map(Number);
    const newDate = new Date(year, month - 1, day, 0, 0, 0, 0);
    setOrderDate(newDate);
  };

  // Sorting hook
  const { sortBy, sortOrder, handleSort } = useTableSort('requestedDeliveryDate', 'desc');

  const utils = api.useUtils();

  // When filtering by awaiting_approval status, ignore date filter to show all orders needing approval
  // This ensures dashboard count matches what users can find on this page
  const shouldApplyDateFilter = statusFilter !== 'awaiting_approval';

  const { data, isLoading, error } = api.order.getAll.useQuery({
    status: statusFilter || undefined,
    areaId: areaFilter || undefined,
    search: searchQuery || undefined,
    dateFrom: shouldApplyDateFilter ? (orderDate || undefined) : undefined,
    dateTo: shouldApplyDateFilter ? (orderDateEnd || undefined) : undefined,
    sortBy,
    sortOrder,
    limit: 100,
  });

  const approveMutation = api.order.approveBackorder.useMutation({
    onSuccess: () => {
      toast({
        title: tMessages('approveSuccess'),
        variant: 'default',
      });
      setIsApprovalDialogOpen(false);
      setSelectedOrder(null);
      utils.order.getAll.invalidate();
    },
    onError: (error) => {
      console.error('Approve backorder error:', error.message);
      toast({
        title: tMessages('approveError'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  const rejectMutation = api.order.rejectBackorder.useMutation({
    onSuccess: () => {
      toast({
        title: tMessages('rejectSuccess'),
        variant: 'default',
      });
      setIsApprovalDialogOpen(false);
      setSelectedOrder(null);
      utils.order.getAll.invalidate();
    },
    onError: (error) => {
      console.error('Reject backorder error:', error.message);
      toast({
        title: tMessages('rejectError'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  const tConfirm = useTranslations('orders.confirmDialog');
  const confirmMutation = api.order.confirmOrder.useMutation({
    onSuccess: () => {
      toast({
        title: tConfirm('success'),
        description: tConfirm('successMessage'),
        variant: 'default',
      });
      setIsConfirmDialogOpen(false);
      setSelectedConfirmOrder(null);
      utils.order.getAll.invalidate();
    },
    onError: (error) => {
      console.error('Confirm order error:', error.message);
      toast({
        title: tConfirm('error'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  // Data from API with fallbacks for loading state
  const orders = (data?.orders ?? []).map((order) => ({
    ...order,
    stockShortfall: order.stockShortfall as
      | Record<string, { requested: number; available: number; shortfall: number }>
      | undefined,
    approvedQuantities: order.approvedQuantities as Record<string, number> | undefined,
  })) as Order[];

  // Apply client-side filters
  const filteredOrders = useMemo(
    () =>
      orders.filter((order) => {
        // Search filter
        if (searchQuery) {
          const query = searchQuery.toLowerCase();
          const matchesSearch =
            order.orderNumber.toLowerCase().includes(query) ||
            order.customerName.toLowerCase().includes(query);
          if (!matchesSearch) return false;
        }

        // Backorder status filter (pending backorders are awaiting_approval with stockShortfall)
        if (backorderFilter === 'pending') {
          if (!(order.status === 'awaiting_approval' && order.stockShortfall)) return false;
        }

        return true;
      }),
    [orders, searchQuery, backorderFilter]
  );

  const totalOrders = filteredOrders.length;
  const awaitingApprovalOrders = useMemo(
    () => filteredOrders.filter((o) => o.status === 'awaiting_approval').length,
    [filteredOrders]
  );
  const confirmedOrders = useMemo(
    () => filteredOrders.filter((o) => o.status === 'confirmed').length,
    [filteredOrders]
  );
  const deliveredOrders = useMemo(
    () => filteredOrders.filter((o) => o.status === 'delivered').length,
    [filteredOrders]
  );
  const pendingBackorders = useMemo(
    () => orders.filter((o) => o.status === 'awaiting_approval' && o.stockShortfall).length,
    [orders]
  );
  const totalRevenue = useMemo(
    () => filteredOrders.reduce((sum, o) => sum + o.totalAmount, 0),
    [filteredOrders]
  );

  // Handler functions — must be before early returns to satisfy rules of hooks
  const handleReviewBackorder = useCallback((order: Order) => {
    setSelectedOrder({
      id: order.id,
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      totalAmount: order.totalAmount,
      requestedDeliveryDate: order.requestedDeliveryDate,
      items: order.items,
      stockShortfall: order.stockShortfall || {},
    });
    setIsApprovalDialogOpen(true);
  }, []);

  // Handler for confirming an order
  const handleConfirmOrder = useCallback((order: Order) => {
    setSelectedConfirmOrder({
      id: order.id,
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      totalAmount: order.totalAmount,
      requestedDeliveryDate: order.requestedDeliveryDate,
      items: order.items,
    });
    setIsConfirmDialogOpen(true);
  }, []);

  const columns: TableColumn<Order>[] = useMemo(
    () => [
      {
        key: 'orderNumber',
        label: t('orderNumber'),
        className: 'font-medium',
        sortable: true,
      },
      {
        key: 'customer',
        label: t('customer'),
        render: (order) => order.customerName,
        sortable: true,
      },
      {
        key: 'requestedDeliveryDate',
        label: t('deliveryDate'),
        render: (order) => new Date(order.requestedDeliveryDate).toLocaleDateString(),
        sortable: true,
      },
      {
        key: 'orderedAt',
        label: t('orderDate'),
        render: (order) => new Date(order.orderedAt).toLocaleDateString(),
        sortable: true,
      },
      {
        key: 'items',
        label: t('items'),
        render: (order) => order.items.length,
      },
      {
        key: 'area',
        label: t('area'),
        render: (order) => order.deliveryAddress.areaName?.toUpperCase() || '-',
      },
      {
        key: 'totalAmount',
        label: t('total'),
        render: (order) => formatAUD(order.totalAmount), // value is in cents
        sortable: true,
      },
      {
        key: 'status',
        label: t('status'),
        render: (order) => (
          <div className="flex items-center gap-2">
            <StatusBadge status={order.status} />
            <BackorderStatusBadge order={order} compact />
            <XeroOrderSyncBadge orderId={order.id} orderStatus={order.status} compact />
          </div>
        ),
        sortable: true,
      },
      {
        key: 'actions',
        label: tCommon('actions'),
        className: 'text-right',
        render: (order) => (
          <div className="flex justify-end gap-2">
            {order.status === 'awaiting_approval' && order.stockShortfall && (
              <PermissionGate permission="orders:approve_backorder">
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => handleReviewBackorder(order)}
                >
                  {t('backorder.reviewBackorder')}
                </Button>
              </PermissionGate>
            )}
            {/* Confirm button only for awaiting_approval orders (non-backorders) */}
            {order.status === 'awaiting_approval' && !order.stockShortfall && (
              <PermissionGate permission="orders:confirm">
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => handleConfirmOrder(order)}
                >
                  <CheckCircle className="h-4 w-4 mr-1" />
                  {t('confirmOrder')}
                </Button>
              </PermissionGate>
            )}
            <Button
              variant="ghost"
              size="sm"
              aria-label={tCommon('view')}
              onClick={() => router.push(`/orders/${order.id}`)}
            >
              <Eye className="h-4 w-4" />
            </Button>
          </div>
        ),
      },
    ],
    [t, tCommon, router, handleReviewBackorder, handleConfirmOrder]
  );

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

  const handleApprove = async (data: {
    orderId: string;
    approvedQuantities?: Record<string, number>;
    estimatedFulfillment?: Date;
    notes?: string;
    bypassStockCheck?: boolean;
  }) => {
    await approveMutation.mutateAsync(data);
  };

  const handleReject = async (data: { orderId: string; reason: string }) => {
    await rejectMutation.mutateAsync(data);
  };

  const handleFilterPendingBackorders = () => {
    setBackorderFilter('pending');
  };

  const handleConfirm = async (data: { orderId: string; notes?: string }) => {
    await confirmMutation.mutateAsync(data);
  };

  const mobileCard = (order: Order) => (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <h3 className="font-semibold text-base">{order.orderNumber}</h3>
          <p className="text-sm text-muted-foreground">{order.customerName}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={order.status} />
          <BackorderStatusBadge order={order} compact />
          <XeroOrderSyncBadge orderId={order.id} orderStatus={order.status} compact />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <p className="text-muted-foreground">{t('deliveryDate')}</p>
          <p className="font-medium">{new Date(order.requestedDeliveryDate).toLocaleDateString()}</p>
        </div>
        <div>
          <p className="text-muted-foreground">{t('items')}</p>
          <p className="font-medium">{order.items.length}</p>
        </div>
        <div>
          <p className="text-muted-foreground">{t('area')}</p>
          <p className="font-medium">{order.deliveryAddress.areaName?.toUpperCase() || '-'}</p>
        </div>
        <div>
          <p className="text-muted-foreground">{t('total')}</p>
          <p className="font-medium">{formatAUD(order.totalAmount)}</p>
        </div>
      </div>

      <div className="flex gap-2 pt-2 border-t">
        {order.status === 'awaiting_approval' && order.stockShortfall ? (
          <>
            <PermissionGate permission="orders:approve_backorder">
              <Button
                variant="default"
                size="sm"
                className="flex-1"
                onClick={() => handleReviewBackorder(order)}
              >
                {t('backorder.reviewBackorder')}
              </Button>
            </PermissionGate>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/orders/${order.id}`)}
            >
              <Eye className="h-4 w-4" />
            </Button>
          </>
        ) : order.status === 'awaiting_approval' ? (
          <>
            <PermissionGate permission="orders:confirm">
              <Button
                variant="default"
                size="sm"
                className="flex-1"
                onClick={() => handleConfirmOrder(order)}
              >
                <CheckCircle className="h-4 w-4 mr-1" />
                {t('confirmOrder')}
              </Button>
            </PermissionGate>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/orders/${order.id}`)}
            >
              <Eye className="h-4 w-4" />
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => router.push(`/orders/${order.id}`)}
          >
            <Eye className="h-4 w-4 mr-1" />
            {t('viewDetails')}
          </Button>
        )}
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
        <PermissionGate permission="orders:create">
          <Button onClick={() => router.push('/orders/create')}>
            <Plus className="h-4 w-4 mr-2" />
            {t('createOrderOnBehalf')}
          </Button>
        </PermissionGate>
      </div>

      {/* Stats */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-6 md:mb-8">
        <Card className="stat-card animate-fade-in-up">
          <div className="stat-card-gradient" />
          <CardHeader className="pb-3 relative">
            <CardDescription>{t('totalOrders')}</CardDescription>
            <div className="stat-value tabular-nums">
              <CountUp end={totalOrders} />
            </div>
          </CardHeader>
        </Card>
        <Card className="stat-card animate-fade-in-up delay-100">
          <div className="stat-card-gradient" />
          <CardHeader className="pb-3 relative">
            <CardDescription>{t('awaitingApprovalOrders')}</CardDescription>
            <div className="stat-value tabular-nums text-warning">
              <CountUp end={awaitingApprovalOrders} />
            </div>
          </CardHeader>
        </Card>
        <Card className="stat-card animate-fade-in-up delay-200">
          <div className="stat-card-gradient" />
          <CardHeader className="pb-3 relative">
            <CardDescription>{t('confirmedOrders')}</CardDescription>
            <div className="stat-value tabular-nums text-info">
              <CountUp end={confirmedOrders} />
            </div>
          </CardHeader>
        </Card>
        <Card className="stat-card animate-fade-in-up delay-300">
          <div className="stat-card-gradient" />
          <CardHeader className="pb-3 relative">
            <CardDescription>{t('deliveredOrders')}</CardDescription>
            <div className="stat-value tabular-nums text-success">
              <CountUp end={deliveredOrders} />
            </div>
          </CardHeader>
        </Card>
      </div>

      {/* Pending Backorders Alert */}
      {pendingBackorders > 0 && (
        <Card className="mb-6 border-warning bg-warning/5">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" />
              <CardTitle className="text-base">{tAlert('title')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <p className="text-sm">{tAlert('message', { count: pendingBackorders })}</p>
              <Button variant="outline" size="sm" onClick={handleFilterPendingBackorders}>
                {tAlert('reviewNow')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Date Filter */}
      <Card className="mb-6">
        <CardHeader className="p-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <label htmlFor="order-date" className="text-sm font-medium">
                {t('selectOrderDate')}
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="order-date"
                type="date"
                className="w-full sm:w-auto"
                value={dateInputValue}
                onChange={handleDateChange}
              />
              {orderDate && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOrderDate(null)}
                >
                  {t('showAllDates')}
                </Button>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {statusFilter === 'awaiting_approval'
                ? t('showingAllAwaitingApproval')
                : orderDate
                  ? t('showingOrdersFor', { date: orderDate.toLocaleDateString() })
                  : t('showingAllDates')}
            </p>
          </div>
        </CardHeader>
      </Card>

      {/* Search and Filters */}
      <Card className="mb-6">
        <CardHeader className="p-4">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('searchPlaceholder')}
                className="pl-10"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                className="flex h-10 w-full md:w-[180px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">{t('allStatuses')}</option>
                <option value="awaiting_approval">{t('awaitingApproval')}</option>
                <option value="confirmed">{t('confirmed')}</option>
                <option value="packing">{t('packing')}</option>
                <option value="ready_for_delivery">{t('readyForDelivery')}</option>
                <option value="delivered">{t('delivered')}</option>
                <option value="cancelled">{t('cancelled')}</option>
              </select>
              <select
                className="flex h-10 w-full md:w-[180px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={areaFilter}
                onChange={(e) => setAreaFilter(e.target.value)}
              >
                <option value="">{t('allAreas')}</option>
                <option value="north">{t('north')}</option>
                <option value="south">{t('south')}</option>
                <option value="east">{t('east')}</option>
                <option value="west">{t('west')}</option>
              </select>
              <select
                className="flex h-10 w-full md:w-[200px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={backorderFilter}
                onChange={(e) => setBackorderFilter(e.target.value)}
              >
                <option value="">{t('allOrders')}</option>
                <option value="pending">{t('backorder.pending_approval')}</option>
              </select>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Revenue Card */}
      <Card className="stat-card mb-6">
        <div className="stat-card-gradient" />
        <CardHeader className="pb-3 relative">
          <div className="flex items-center justify-between">
            <div>
              <CardDescription>{t('totalRevenue')}</CardDescription>
              <div className="text-3xl font-bold tabular-nums">
                {formatAUD(totalRevenue)}
              </div>
            </div>
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Package className="h-6 w-6 text-primary" />
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Orders Table */}
      <Card>
        <CardHeader>
          <CardTitle>
            <div className="flex items-center gap-2">
              <ShoppingBag className="h-5 w-5" />
              {t('listTitle')}
            </div>
          </CardTitle>
          <CardDescription>{t('listDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="p-4 md:p-6">
          {isLoading ? (
            <TableSkeleton rows={5} columns={8} />
          ) : filteredOrders.length > 0 ? (
            <ResponsiveTable
              data={filteredOrders}
              columns={columns}
              mobileCard={mobileCard}
              className="md:border-0"
              sortColumn={sortBy}
              sortDirection={sortOrder}
              onSort={handleSort}
            />
          ) : (
            <EmptyState
              icon={PackageX}
              title={t('noOrdersFound')}
              description={searchQuery || statusFilter || areaFilter || orderDate ? t('adjustFilters') : t('ordersWillAppear')}
            />
          )}
        </CardContent>
      </Card>

      {/* Backorder Approval Dialog */}
      <BackorderApprovalDialog
        order={selectedOrder}
        open={isApprovalDialogOpen}
        onOpenChange={setIsApprovalDialogOpen}
        onApprove={handleApprove}
        onReject={handleReject}
        isSubmitting={approveMutation.isPending || rejectMutation.isPending}
      />

      {/* Confirm Order Dialog */}
      <ConfirmOrderDialog
        order={selectedConfirmOrder}
        open={isConfirmDialogOpen}
        onOpenChange={setIsConfirmDialogOpen}
        onConfirm={handleConfirm}
        isSubmitting={confirmMutation.isPending}
      />
    </div>
  );
}
