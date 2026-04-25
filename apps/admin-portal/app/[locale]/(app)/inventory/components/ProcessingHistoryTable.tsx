'use client';

import { useState, Fragment } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@joho-erp/ui';
import { formatAUD } from '@joho-erp/shared';
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Search,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { api } from '@/trpc/client';
import { BatchLink } from './BatchLink';

type SortBy = 'createdAt' | 'productName';
type SortDirection = 'asc' | 'desc';

export function ProcessingHistoryTable() {
  const t = useTranslations('inventory.processingHistory');

  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [selectedTransaction, setSelectedTransaction] = useState<{
    id: string;
    productId: string;
    productName: string;
    productSku: string;
    productUnit: string;
    quantity: number;
    previousStock: number;
    newStock: number;
    notes: string | null;
  } | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);

  const { data, isLoading, refetch } = api.inventory.getProcessingHistory.useQuery({
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

  const formatShortDate = (date: string | Date) => {
    return new Date(date).toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  };

  const toggleExpanded = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const getLossColor = (loss: number | null) => {
    if (loss === null) return 'text-muted-foreground';
    if (loss <= 5) return 'text-success';
    if (loss <= 15) return 'text-warning';
    return 'text-destructive';
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
                <ArrowRightLeft className="h-5 w-5 text-primary" />
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
                <SelectItem value="productName-asc">{t('sort.targetProductAsc')}</SelectItem>
                <SelectItem value="productName-desc">{t('sort.targetProductDesc')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>{t('columns.batchNumber')}</TableHead>
                  <TableHead>{t('columns.sourceProduct')}</TableHead>
                  <TableHead>{t('columns.targetProduct')}</TableHead>
                  <TableHead className="text-right">{t('columns.inputQty')}</TableHead>
                  <TableHead className="text-right">{t('columns.outputQty')}</TableHead>
                  <TableHead className="text-right">{t('columns.lossPercentage')}</TableHead>
                  <TableHead>{t('columns.date')}</TableHead>
                  <TableHead>{t('columns.performedBy')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const isExpanded = expandedRows.has(item.id);
                  const firstTarget = item.targets[0];
                  return (
                    <Fragment key={item.id}>
                      <TableRow
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => toggleExpanded(item.id)}
                      >
                        <TableCell className="w-8 pr-0">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell>
                          <BatchLink
                            batchNumber={item.batchNumber}
                            onClick={() => toggleExpanded(item.id)}
                          />
                        </TableCell>
                        <TableCell>
                          {item.source ? (
                            <div>
                              <p className="font-medium">{item.source.productName}</p>
                              <p className="text-sm text-muted-foreground">{item.source.productSku}</p>
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground italic">
                              {t('detail.unknownSource')}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {item.targets.length === 1 && firstTarget ? (
                            <div>
                              <p className="font-medium">{firstTarget.productName}</p>
                              <p className="text-sm text-muted-foreground">{firstTarget.productSku}</p>
                            </div>
                          ) : (
                            <div>
                              <p className="font-medium">
                                {t('multiTarget.summary', { count: item.targets.length })}
                              </p>
                              <p className="text-sm text-muted-foreground">
                                {item.targets
                                  .map((tg) => tg.productName)
                                  .slice(0, 2)
                                  .join(', ')}
                                {item.targets.length > 2 ? '…' : ''}
                              </p>
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {item.source ? (
                            <span className="text-destructive">
                              -{item.source.quantity.toFixed(1)} {item.source.productUnit}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {item.targets.length === 1 && firstTarget ? (
                            <span className="text-success">
                              +{firstTarget.quantity.toFixed(1)} {firstTarget.productUnit}
                            </span>
                          ) : (
                            <span className="text-success">
                              +{item.totalOutputQuantity.toFixed(1)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <span className={getLossColor(item.lossPercentage)}>
                            {item.lossPercentage !== null ? `${item.lossPercentage}%` : '-'}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">{formatDate(item.createdAt)}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground">{item.createdBy}</span>
                        </TableCell>
                      </TableRow>

                      {/* Expandable detail row */}
                      {isExpanded && (
                        <TableRow className="hover:bg-muted/30">
                          <TableCell colSpan={9} className="bg-muted/30 p-4">
                            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                              {/* Left: Source Batches Consumed */}
                              <div>
                                <h4 className="text-sm font-semibold mb-3">
                                  {t('detail.sourceBatches')}
                                </h4>
                                {item.batchConsumptions.length > 0 ? (
                                  <div className="overflow-x-auto">
                                    <Table>
                                      <TableHeader>
                                        <TableRow>
                                          <TableHead className="text-xs">{t('detail.batchNumber')}</TableHead>
                                          <TableHead className="text-xs">{t('detail.expiry')}</TableHead>
                                          <TableHead className="text-xs text-right">{t('detail.qtyConsumed')}</TableHead>
                                          <TableHead className="text-xs text-right">{t('detail.costPerUnit')}</TableHead>
                                          <TableHead className="text-xs text-right">{t('detail.subtotal')}</TableHead>
                                          <TableHead className="text-xs">{t('detail.supplier')}</TableHead>
                                        </TableRow>
                                      </TableHeader>
                                      <TableBody>
                                        {item.batchConsumptions.map((bc, idx) => (
                                          <TableRow key={idx}>
                                            <TableCell className="text-sm font-mono">
                                              {bc.batch?.batchNumber ?? '-'}
                                            </TableCell>
                                            <TableCell className="text-sm">
                                              {bc.batch?.expiryDate
                                                ? formatShortDate(bc.batch.expiryDate)
                                                : '-'}
                                            </TableCell>
                                            <TableCell className="text-sm text-right tabular-nums">
                                              {bc.quantityConsumed.toFixed(1)}
                                            </TableCell>
                                            <TableCell className="text-sm text-right tabular-nums">
                                              {formatAUD(bc.costPerUnit)}
                                            </TableCell>
                                            <TableCell className="text-sm text-right tabular-nums">
                                              {formatAUD(bc.totalCost)}
                                            </TableCell>
                                            <TableCell className="text-sm">
                                              {bc.supplierName ?? '-'}
                                            </TableCell>
                                          </TableRow>
                                        ))}
                                        {/* Total row */}
                                        <TableRow className="border-t font-semibold">
                                          <TableCell colSpan={4} className="text-sm text-right">
                                            {t('detail.totalMaterialCost')}
                                          </TableCell>
                                          <TableCell className="text-sm text-right tabular-nums">
                                            {formatAUD(item.totalMaterialCost)}
                                          </TableCell>
                                          <TableCell />
                                        </TableRow>
                                      </TableBody>
                                    </Table>
                                  </div>
                                ) : (
                                  <p className="text-sm text-muted-foreground italic">
                                    {t('detail.noBatchData')}
                                  </p>
                                )}
                              </div>

                              {/* Right: Targets Summary */}
                              <div>
                                <h4 className="text-sm font-semibold mb-3">
                                  {t('detail.outputSummary')}
                                </h4>
                                <div className="space-y-3">
                                  {item.targets.map((target) => (
                                    <div
                                      key={target.id}
                                      className="rounded-md border p-3 bg-background"
                                    >
                                      <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                          <p className="font-medium text-sm truncate">
                                            {target.productName}
                                          </p>
                                          <p className="text-xs text-muted-foreground">
                                            {target.productSku}
                                          </p>
                                        </div>
                                        <span className="text-success font-semibold tabular-nums">
                                          +{target.quantity.toFixed(1)} {target.productUnit}
                                        </span>
                                      </div>
                                      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                                        <dt className="text-muted-foreground">
                                          {t('detail.outputCostPerUnit')}
                                        </dt>
                                        <dd className="text-right tabular-nums">
                                          {target.costPerUnit !== null
                                            ? formatAUD(target.costPerUnit)
                                            : '-'}
                                        </dd>
                                        <dt className="text-muted-foreground">
                                          {t('detail.outputExpiry')}
                                        </dt>
                                        <dd className="text-right">
                                          {target.expiryDate
                                            ? formatShortDate(target.expiryDate)
                                            : '-'}
                                        </dd>
                                      </dl>
                                      <div className="mt-2 flex justify-end">
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedTransaction({
                                              id: target.id,
                                              productId: target.productId,
                                              productName: target.productName,
                                              productSku: target.productSku,
                                              productUnit: target.productUnit,
                                              quantity: target.quantity,
                                              previousStock: 0,
                                              newStock: 0,
                                              notes: target.notes ?? item.notes,
                                            });
                                            setShowEditDialog(true);
                                          }}
                                        >
                                          <Pencil className="mr-2 h-3 w-3" />
                                          {t('detail.edit')}
                                        </Button>
                                      </div>
                                    </div>
                                  ))}
                                </div>

                                <dl className="mt-4 space-y-1 text-sm border-t pt-3">
                                  <div className="flex justify-between">
                                    <dt className="text-muted-foreground">
                                      {t('columns.lossPercentage')}
                                    </dt>
                                    <dd
                                      className={`font-medium ${getLossColor(item.lossPercentage)}`}
                                    >
                                      {item.lossPercentage !== null
                                        ? `${item.lossPercentage}%`
                                        : '-'}
                                    </dd>
                                  </div>
                                  <div className="flex justify-between">
                                    <dt className="text-muted-foreground">
                                      {t('detail.totalMaterialCost')}
                                    </dt>
                                    <dd className="font-medium tabular-nums">
                                      {formatAUD(item.totalMaterialCost)}
                                    </dd>
                                  </div>
                                  {item.notes && (
                                    <div className="flex justify-between">
                                      <dt className="text-muted-foreground">
                                        {t('detail.notes')}
                                      </dt>
                                      <dd className="font-medium text-right max-w-[200px]">
                                        {item.notes}
                                      </dd>
                                    </div>
                                  )}
                                </dl>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
                {items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center">
                      <EmptyState
                        icon={ArrowRightLeft}
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
