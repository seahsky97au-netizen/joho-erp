'use client';

import { useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  EmptyState,
  Button,
  Input,
} from '@joho-erp/ui';
import {
  PackagePlus,
  ChevronLeft,
  ChevronRight,
  Search,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { api } from '@/trpc/client';
import { formatAUD } from '@joho-erp/shared';
import { BatchLink } from './BatchLink';
import { DeleteBatchButton } from './DeleteBatchButton';
import { PermissionGate } from '@/components/permission-gate';

type SortBy = 'receivedAt' | 'productName' | 'quantity' | 'costPerUnit' | 'expiryDate';
type SortDirection = 'asc' | 'desc';

export function StockReceivedTable() {
  const t = useTranslations('inventory.stockReceivedHistory');

  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('receivedAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [page, setPage] = useState(1);
  const pageSize = 25;

  // Selected batch for edit dialog
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);

  const { data: suppliersData } = api.supplier.getAll.useQuery({});

  const { data, isLoading, refetch } = api.inventory.getStockReceivedHistory.useQuery({
    page,
    pageSize,
    sortBy,
    sortDirection,
    search: search || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    supplierId: supplierId || undefined,
  });

  const formatDate = (date: string | Date | null) => {
    if (!date) return '-';
    return new Date(date).toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="mt-2 h-4 w-64" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[400px] w-full" />
        </CardContent>
      </Card>
    );
  }

  const items = data?.items ?? [];
  const totalCount = data?.totalCount ?? 0;
  const totalPages = data?.totalPages ?? 0;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <PackagePlus className="h-5 w-5 text-success" />
                {t('title')}
              </CardTitle>
              <CardDescription>{t('description')}</CardDescription>
            </div>
          </div>

          <div className="flex flex-col gap-4 mt-4 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={t('filters.searchPlaceholder')}
                className="pl-10"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm text-muted-foreground whitespace-nowrap">
                {t('filters.dateFrom')}
              </label>
              <Input
                type="date"
                className="w-auto"
                value={dateFrom}
                onChange={(e) => {
                  setDateFrom(e.target.value);
                  setPage(1);
                }}
              />
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm text-muted-foreground whitespace-nowrap">
                {t('filters.dateTo')}
              </label>
              <Input
                type="date"
                className="w-auto"
                value={dateTo}
                onChange={(e) => {
                  setDateTo(e.target.value);
                  setPage(1);
                }}
              />
            </div>

            <Select
              value={supplierId || 'all'}
              onValueChange={(value) => {
                setSupplierId(value === 'all' ? '' : value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue placeholder={t('filters.allSuppliers')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('filters.allSuppliers')}</SelectItem>
                {suppliersData?.suppliers?.map((supplier) => (
                  <SelectItem key={supplier.id} value={supplier.id}>
                    {supplier.businessName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={`${sortBy}-${sortDirection}`}
              onValueChange={(value) => {
                const [newSortBy, newSortDirection] = value.split('-') as [SortBy, SortDirection];
                setSortBy(newSortBy);
                setSortDirection(newSortDirection);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-[200px]">
                <SelectValue placeholder={t('sort.sortBy')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="receivedAt-desc">{t('sort.dateDesc')}</SelectItem>
                <SelectItem value="receivedAt-asc">{t('sort.dateAsc')}</SelectItem>
                <SelectItem value="productName-asc">{t('sort.productNameAsc')}</SelectItem>
                <SelectItem value="productName-desc">{t('sort.productNameDesc')}</SelectItem>
                <SelectItem value="quantity-desc">{t('sort.quantityDesc')}</SelectItem>
                <SelectItem value="quantity-asc">{t('sort.quantityAsc')}</SelectItem>
                <SelectItem value="costPerUnit-desc">{t('sort.costDesc')}</SelectItem>
                <SelectItem value="costPerUnit-asc">{t('sort.costAsc')}</SelectItem>
                <SelectItem value="expiryDate-asc">{t('sort.expiryAsc')}</SelectItem>
                <SelectItem value="expiryDate-desc">{t('sort.expiryDesc')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.batchNumber')}</TableHead>
                  <TableHead>{t('columns.product')}</TableHead>
                  <TableHead className="text-right">{t('columns.quantity')}</TableHead>
                  <TableHead className="text-right">{t('columns.costPerUnit')}</TableHead>
                  <TableHead>{t('columns.supplier')}</TableHead>
                  <TableHead>{t('columns.invoiceNumber')}</TableHead>
                  <TableHead>{t('columns.receivedDate')}</TableHead>
                  <TableHead>{t('columns.expiryDate')}</TableHead>
                  <PermissionGate permission="products:adjust_stock">
                    <TableHead>{t('columns.actions')}</TableHead>
                  </PermissionGate>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow
                    key={item.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => {
                      setSelectedBatchId(item.id);
                      setShowEditDialog(true);
                    }}
                  >
                    <TableCell>
                      <BatchLink
                        batchNumber={item.batchNumber}
                        onClick={() => {
                          setSelectedBatchId(item.id);
                          setShowEditDialog(true);
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <div>
                        <p className="font-medium">{item.productName}</p>
                        <p className="text-sm text-muted-foreground">{item.productSku}</p>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {item.quantityRemaining.toFixed(1)} / {item.initialQuantity.toFixed(1)} {item.productUnit}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatAUD(item.costPerUnit)}
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{item.supplierName || '-'}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{item.supplierInvoiceNumber || '-'}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{formatDate(item.stockInDate || item.receivedAt)}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{formatDate(item.expiryDate)}</span>
                    </TableCell>
                    <PermissionGate permission="products:adjust_stock">
                      <TableCell>
                        {item.batchNumber && (
                          <DeleteBatchButton
                            batchId={item.id}
                            batchNumber={item.batchNumber}
                            productName={item.productName}
                            initialQuantity={item.initialQuantity}
                            quantityRemaining={item.quantityRemaining}
                            unit={item.productUnit}
                            onSuccess={() => refetch()}
                          />
                        )}
                      </TableCell>
                    </PermissionGate>
                  </TableRow>
                ))}
                {items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center">
                      <EmptyState
                        icon={PackagePlus}
                        title={t('emptyState')}
                        description={t('emptyStateDescription')}
                      />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-muted-foreground">
                {t('pagination.showing', {
                  start: (page - 1) * pageSize + 1,
                  end: Math.min(page * pageSize, totalCount),
                  total: totalCount,
                })}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(page - 1)}
                  disabled={page === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                  {t('pagination.previous')}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {t('pagination.pageOf', { page, total: totalPages })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(page + 1)}
                  disabled={page >= totalPages}
                >
                  {t('pagination.next')}
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lazy-loaded edit dialog */}
      {showEditDialog && selectedBatchId && (
        <EditStockReceivedDialogLazy
          open={showEditDialog}
          onOpenChange={(open) => {
            setShowEditDialog(open);
            if (!open) setSelectedBatchId(null);
          }}
          batchId={selectedBatchId}
          onSuccess={() => {
            setShowEditDialog(false);
            setSelectedBatchId(null);
            refetch();
          }}
        />
      )}
    </>
  );
}

// Lazy import for the edit dialog to avoid pulling it in upfront
import dynamic from 'next/dynamic';
const EditStockReceivedDialogLazy = dynamic(
  () => import('./EditStockReceivedDialog').then((m) => m.EditStockReceivedDialog),
  { ssr: false }
);
