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
  Badge,
  Button,
  Input,
} from '@joho-erp/ui';
import {
  Package,
  ChevronLeft,
  ChevronRight,
  Search,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { api } from '@/trpc/client';
import { BatchLink } from './BatchLink';

type SortBy = 'createdAt' | 'productName' | 'quantity';
type SortDirection = 'asc' | 'desc';

interface BatchConsumption {
  id: string;
  quantityConsumed: number;
  batchId: string;
  batchNumber: string | null;
  batchReceivedAt: string | Date;
  batchExpiryDate: string | Date | null;
}

interface TransactionItem {
  id: string;
  productId: string;
  productName: string;
  productSku: string;
  productUnit: string;
  batchNumber: string | null;
  adjustmentType: string | null;
  quantity: number;
  previousStock: number;
  newStock: number;
  notes: string | null;
  createdAt: Date;
  createdBy: string;
  batchConsumptions?: BatchConsumption[];
}

export function PackingHistoryTable() {
  const t = useTranslations('inventory.packingHistory');

  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [selectedTransaction, setSelectedTransaction] = useState<TransactionItem | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const { data, isLoading, refetch } = api.inventory.getPackingHistory.useQuery({
    page,
    pageSize,
    sortBy,
    sortDirection,
    search: search || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
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

  const items = (data?.items ?? []) as TransactionItem[];
  const totalCount = data?.totalCount ?? 0;
  const totalPages = data?.totalPages ?? 0;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5 text-primary" />
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
                <SelectItem value="createdAt-desc">{t('sort.dateDesc')}</SelectItem>
                <SelectItem value="createdAt-asc">{t('sort.dateAsc')}</SelectItem>
                <SelectItem value="productName-asc">{t('sort.productNameAsc')}</SelectItem>
                <SelectItem value="productName-desc">{t('sort.productNameDesc')}</SelectItem>
                <SelectItem value="quantity-desc">{t('sort.quantityDesc')}</SelectItem>
                <SelectItem value="quantity-asc">{t('sort.quantityAsc')}</SelectItem>
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
                  <TableHead>{t('columns.type')}</TableHead>
                  <TableHead className="text-right">{t('columns.quantity')}</TableHead>
                  <TableHead>{t('columns.stockChange')}</TableHead>
                  <TableHead>{t('columns.notes')}</TableHead>
                  <TableHead>{t('columns.date')}</TableHead>
                  <TableHead>{t('columns.performedBy')}</TableHead>
                  <TableHead>{t('columns.batchesConsumed')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow
                    key={item.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => {
                      setSelectedTransaction(item);
                      setShowEditDialog(true);
                    }}
                  >
                    <TableCell>
                      <BatchLink
                        batchNumber={item.batchNumber}
                        onClick={() => {
                          setSelectedTransaction(item);
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
                    <TableCell>
                      <Badge variant={item.adjustmentType === 'packing_reset' ? 'secondary' : 'outline'}>
                        {item.adjustmentType === 'packing_reset' ? t('packingReset') : t('packingAdjustment')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <span className={item.quantity > 0 ? 'text-success' : 'text-destructive'}>
                        {item.quantity > 0 ? '+' : ''}{item.quantity.toFixed(1)} {item.productUnit}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {item.previousStock} → {item.newStock}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm line-clamp-2">{item.notes || '-'}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{formatDate(item.createdAt)}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">{item.createdBy}</span>
                    </TableCell>
                    <TableCell>
                      {item.batchConsumptions && item.batchConsumptions.length > 0 ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedRows((prev) => {
                              const next = new Set(prev);
                              if (next.has(item.id)) {
                                next.delete(item.id);
                              } else {
                                next.add(item.id);
                              }
                              return next;
                            });
                          }}
                        >
                          {expandedRows.has(item.id) ? t('columns.hideDetails') : `${item.batchConsumptions.length} ${t('columns.batches')}`}
                        </Button>
                      ) : (
                        <span className="text-sm text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {items.map((item) =>
                  expandedRows.has(item.id) && item.batchConsumptions && item.batchConsumptions.length > 0 ? (
                    <TableRow key={`${item.id}-consumptions`} className="bg-muted/20">
                      <TableCell colSpan={9} className="py-2 px-6">
                        <div className="space-y-1">
                          <p className="text-xs font-semibold text-muted-foreground mb-1">{t('columns.batchesConsumed')}</p>
                          {item.batchConsumptions.map((bc) => (
                            <div key={bc.id} className="flex items-center justify-between text-sm">
                              <span className="font-medium">{bc.batchNumber || '-'}</span>
                              <span className="text-muted-foreground">
                                {new Date(bc.batchReceivedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
                              </span>
                              {bc.batchExpiryDate && (
                                <span className="text-muted-foreground">
                                  {t('columns.expires')} {new Date(bc.batchExpiryDate).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
                                </span>
                              )}
                              <span className="font-medium tabular-nums text-destructive">-{bc.quantityConsumed} {item.productUnit}</span>
                            </div>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null
                )}
                {items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center">
                      <EmptyState
                        icon={Package}
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

      {showEditDialog && selectedTransaction && (
        <EditTransactionDialogLazy
          open={showEditDialog}
          onOpenChange={(open) => {
            setShowEditDialog(open);
            if (!open) setSelectedTransaction(null);
          }}
          transaction={selectedTransaction}
          onSuccess={() => {
            setShowEditDialog(false);
            setSelectedTransaction(null);
            refetch();
          }}
        />
      )}
    </>
  );
}

import dynamic from 'next/dynamic';
const EditTransactionDialogLazy = dynamic(
  () => import('./EditTransactionDialog').then((m) => m.EditTransactionDialog),
  { ssr: false }
);
