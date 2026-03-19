'use client';

import { useState, useMemo, Fragment } from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
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
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Filter,
  Package,
  Search,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { api } from '@/trpc/client';
import { useDebounce } from 'use-debounce';
import { BatchInfoDialog } from './BatchInfoDialog';
import { BatchLink } from './BatchLink';
import { ProcessingRecordDialog } from './ProcessingRecordDialog';

type StockStatus = 'all' | 'healthy' | 'low_stock' | 'out_of_stock';
type ExpiryFilter = 'all' | 'expired' | 'expiring_soon' | 'ok';
type SortColumn = 'name' | 'sku' | 'currentStock' | 'nearestExpiry' | null;
type SortDirection = 'asc' | 'desc';

interface StockStatusBadgeProps {
  currentStock: number;
  lowStockThreshold: number | null;
}

function StockStatusBadge({ currentStock, lowStockThreshold }: StockStatusBadgeProps) {
  const t = useTranslations('inventory.stockCounts.status');

  if (currentStock === 0) {
    return (
      <Badge variant="destructive">
        {t('outOfStock')}
      </Badge>
    );
  }

  if (lowStockThreshold !== null && currentStock <= lowStockThreshold) {
    return (
      <Badge variant="warning">
        {t('lowStock')}
      </Badge>
    );
  }

  return (
    <Badge variant="success">
      {t('healthy')}
    </Badge>
  );
}

function ExpiryStatusBadge({ expiryStatus }: { expiryStatus: string | null | undefined }) {
  const t = useTranslations('inventory.stockCounts.expiry');

  if (expiryStatus === 'expired') {
    return <Badge variant="destructive">{t('expired')}</Badge>;
  }
  if (expiryStatus === 'expiring_soon') {
    return <Badge variant="warning">{t('expiringSoon')}</Badge>;
  }
  return null;
}

function SortableHeader({
  label,
  column,
  currentColumn,
  currentDirection,
  onSort,
  className,
}: {
  label: string;
  column: SortColumn;
  currentColumn: SortColumn;
  currentDirection: SortDirection;
  onSort: (column: SortColumn) => void;
  className?: string;
}) {
  return (
    <TableHead className={className}>
      <button
        type="button"
        className="flex items-center gap-1 hover:text-primary transition-colors"
        onClick={() => onSort(column)}
      >
        {label}
        {currentColumn === column ? (
          currentDirection === 'asc' ? (
            <ArrowUp className="h-4 w-4" />
          ) : (
            <ArrowDown className="h-4 w-4" />
          )
        ) : (
          <ArrowUpDown className="h-4 w-4 opacity-50" />
        )}
      </button>
    </TableHead>
  );
}

function getStockStatus(currentStock: number, lowStockThreshold: number | null): StockStatus {
  if (currentStock === 0) return 'out_of_stock';
  if (lowStockThreshold !== null && currentStock <= lowStockThreshold) return 'low_stock';
  return 'healthy';
}

// Helper to safely get stock values from product (handles admin vs customer type union)
function getProductStockInfo(product: Record<string, unknown>): {
  currentStock: number;
  lowStockThreshold: number | null;
} {
  // In admin portal, we always have currentStock and lowStockThreshold
  return {
    currentStock: (product.currentStock as number) ?? 0,
    lowStockThreshold: (product.lowStockThreshold as number | null) ?? null,
  };
}

function getBatchSummary(product: Record<string, unknown>): {
  nearestExpiryDate: string | null;
  expiryStatus: string | null;
  supplierIds: string[];
  activeBatchCount: number;
} | null {
  const summary = product.batchSummary as {
    nearestExpiryDate: string | null;
    expiryStatus: string | null;
    supplierIds: string[];
    activeBatchCount: number;
  } | null | undefined;
  return summary ?? null;
}

function ProductBatchRows({
  productId,
  parentCurrentStock,
  tBatches,
  tExpiry,
  onBatchClick,
  onProcessingBatchClick,
}: {
  productId: string;
  parentCurrentStock: number;
  tBatches: (key: string, values?: Record<string, string | number>) => string;
  tExpiry: (key: string, values?: Record<string, string | number | Date>) => string;
  onBatchClick: (batchId: string) => void;
  onProcessingBatchClick: (batchNumber: string) => void;
}) {
  const { data: batches, isLoading } = api.inventory.getProductBatches.useQuery({
    productId,
    batchPrefix: 'SI-',
  });

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  };

  const getExpiryBadge = (batch: {
    expiryDate: string | Date | null;
    daysUntilExpiry: number | null;
    isExpired: boolean;
  }) => {
    if (!batch.expiryDate || batch.daysUntilExpiry === null) return null;

    if (batch.isExpired) {
      return (
        <Badge variant="destructive">
          {tExpiry('expiredDays', { days: Math.abs(batch.daysUntilExpiry) })}
        </Badge>
      );
    }

    if (batch.daysUntilExpiry <= 7) {
      return (
        <Badge variant="warning">
          {tExpiry('expiresIn', { days: batch.daysUntilExpiry })}
        </Badge>
      );
    }

    return (
      <Badge variant="success">
        {tExpiry('expiresIn', { days: batch.daysUntilExpiry })}
      </Badge>
    );
  };

  if (isLoading) {
    return (
      <TableRow>
        <TableCell colSpan={8} className="bg-muted/30 py-3 pl-12">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 w-48" />
          </div>
        </TableCell>
      </TableRow>
    );
  }

  if (!batches || batches.length === 0) {
    return (
      <TableRow>
        <TableCell colSpan={8} className="bg-muted/30 py-3 pl-12 text-sm text-muted-foreground">
          {tBatches('batches.noBatches')}
        </TableCell>
      </TableRow>
    );
  }

  const batchSum = batches.reduce((sum, b) => sum + b.quantityRemaining, 0);

  return (
    <>
      {/* Batch sub-header */}
      <TableRow className="bg-muted/30 hover:bg-muted/30">
        <TableCell />
        <TableCell className="pl-8 text-xs font-medium text-muted-foreground">
          {tBatches('batches.batchNumber')}
        </TableCell>
        <TableCell className="text-xs font-medium text-muted-foreground">
          {tBatches('batches.expiry')}
        </TableCell>
        <TableCell className="text-right text-xs font-medium text-muted-foreground">
          {tBatches('batches.quantity')}
        </TableCell>
        <TableCell className="text-xs font-medium text-muted-foreground">
          {tBatches('batches.supplier')}
        </TableCell>
        <TableCell className="text-xs font-medium text-muted-foreground">
          {tBatches('batches.costPerUnit')}
        </TableCell>
        <TableCell className="text-xs font-medium text-muted-foreground" colSpan={2}>
          {tBatches('batches.received')}
        </TableCell>
      </TableRow>
      {/* Batch rows */}
      {batches.map((batch) => (
        <TableRow
          key={batch.id}
          className="cursor-pointer bg-muted/30 hover:bg-muted/50"
          onClick={(e) => {
            e.stopPropagation();
            onBatchClick(batch.id);
          }}
        >
          <TableCell />
          <TableCell className="pl-8">
            <BatchLink
              batchNumber={batch.batchNumber}
              onClick={(bn) => {
                if (bn.startsWith('PR-')) {
                  onProcessingBatchClick(bn);
                } else {
                  onBatchClick(batch.id);
                }
              }}
            />
          </TableCell>
          <TableCell>
            <div className="flex items-center gap-2">
              <span className="text-sm">
                {batch.expiryDate ? formatDate(batch.expiryDate) : '-'}
              </span>
              {getExpiryBadge(batch)}
            </div>
          </TableCell>
          <TableCell className="text-right text-sm tabular-nums">
            {batch.quantityRemaining.toFixed(1)}
          </TableCell>
          <TableCell className="text-sm">
            {batch.supplier?.businessName ?? '-'}
          </TableCell>
          <TableCell className="text-sm">
            {formatAUD(batch.costPerUnit)}
          </TableCell>
          <TableCell className="text-sm" colSpan={2}>
            {formatDate(batch.receivedAt)}
          </TableCell>
        </TableRow>
      ))}
      {/* Batch total summary row */}
      <TableRow className="bg-muted/50 hover:bg-muted/50 border-t">
        <TableCell />
        <TableCell className="pl-8 text-sm font-semibold" colSpan={2}>
          {tBatches('batchTotal')}
        </TableCell>
        <TableCell className="text-right text-sm font-semibold tabular-nums">
          {batchSum.toFixed(1)}
        </TableCell>
        <TableCell colSpan={4} />
      </TableRow>
    </>
  );
}

export function StockCountsTable({
  initialStatusFilter,
  initialSearch,
}: {
  initialStatusFilter?: StockStatus;
  initialSearch?: string;
} = {}) {
  const t = useTranslations('inventory.stockCounts');
  const tExpiry = useTranslations('dashboard.expiringInventory');
  const [search, setSearch] = useState(initialSearch ?? '');
  const [statusFilter, setStatusFilter] = useState<StockStatus>(initialStatusFilter ?? 'all');
  const [debouncedSearch] = useDebounce(search, 300);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [showBatchDialog, setShowBatchDialog] = useState(false);
  const [selectedProcessingBatchNumber, setSelectedProcessingBatchNumber] = useState<string | null>(null);
  const [showProcessingDialog, setShowProcessingDialog] = useState(false);

  // New filter/sort state
  const [selectedSupplierIds, setSelectedSupplierIds] = useState<Set<string>>(new Set());
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>('all');
  const [sortColumn, setSortColumn] = useState<SortColumn>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const { data, isLoading } = api.product.getAll.useQuery({
    showAll: true,
    includeSubproducts: false,
    onlyParents: false,
    includeBatchSummary: true,
    limit: 500,
    page: 1,
  });

  const { data: suppliersData } = api.supplier.getAll.useQuery({});

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const toggleSupplier = (supplierId: string) => {
    setSelectedSupplierIds((prev) => {
      const next = new Set(prev);
      if (next.has(supplierId)) {
        next.delete(supplierId);
      } else {
        next.add(supplierId);
      }
      return next;
    });
  };

  const toggleExpanded = (productId: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) {
        next.delete(productId);
      } else {
        next.add(productId);
      }
      return next;
    });
  };

  // Client-side filtering for search, status, supplier, and expiry
  const filteredProducts = useMemo(() => {
    if (!data?.items) return [];

    return data.items.filter((product) => {
      const stockInfo = getProductStockInfo(product as unknown as Record<string, unknown>);
      const batchSummary = getBatchSummary(product as unknown as Record<string, unknown>);

      // Search filter
      if (debouncedSearch) {
        const searchLower = debouncedSearch.toLowerCase();
        const matchesSearch =
          product.name.toLowerCase().includes(searchLower) ||
          product.sku.toLowerCase().includes(searchLower);
        if (!matchesSearch) return false;
      }

      // Status filter
      if (statusFilter !== 'all') {
        const productStatus = getStockStatus(
          stockInfo.currentStock,
          stockInfo.lowStockThreshold
        );
        if (productStatus !== statusFilter) return false;
      }

      // Supplier filter
      if (selectedSupplierIds.size > 0 && batchSummary) {
        const hasMatchingSupplier = batchSummary.supplierIds.some((id) =>
          selectedSupplierIds.has(id)
        );
        if (!hasMatchingSupplier) return false;
      } else if (selectedSupplierIds.size > 0 && !batchSummary) {
        return false;
      }

      // Expiry filter
      if (expiryFilter !== 'all') {
        const status = batchSummary?.expiryStatus ?? null;
        if (status !== expiryFilter) return false;
      }

      return true;
    });
  }, [data?.items, debouncedSearch, statusFilter, selectedSupplierIds, expiryFilter]);

  // Sorted products
  const sortedProducts = useMemo(() => {
    if (!sortColumn) return filteredProducts;

    return [...filteredProducts].sort((a, b) => {
      const dir = sortDirection === 'asc' ? 1 : -1;

      switch (sortColumn) {
        case 'name':
          return dir * a.name.localeCompare(b.name);
        case 'sku':
          return dir * a.sku.localeCompare(b.sku);
        case 'currentStock': {
          const stockA = getProductStockInfo(a as unknown as Record<string, unknown>).currentStock;
          const stockB = getProductStockInfo(b as unknown as Record<string, unknown>).currentStock;
          return dir * (stockA - stockB);
        }
        case 'nearestExpiry': {
          const summaryA = getBatchSummary(a as unknown as Record<string, unknown>);
          const summaryB = getBatchSummary(b as unknown as Record<string, unknown>);
          const dateA = summaryA?.nearestExpiryDate ? new Date(summaryA.nearestExpiryDate).getTime() : null;
          const dateB = summaryB?.nearestExpiryDate ? new Date(summaryB.nearestExpiryDate).getTime() : null;
          // Nulls sort last
          if (dateA === null && dateB === null) return 0;
          if (dateA === null) return 1;
          if (dateB === null) return -1;
          return dir * (dateA - dateB);
        }
        default:
          return 0;
      }
    });
  }, [filteredProducts, sortColumn, sortDirection]);

  const formatExpiryDate = (dateStr: string | null) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('en-AU', {
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

  const suppliers = suppliersData?.suppliers ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              {t('title')}
            </CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-4 mt-4 sm:flex-row sm:flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('searchPlaceholder')}
              className="pl-10"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select
            value={statusFilter}
            onValueChange={(value) => setStatusFilter(value as StockStatus)}
          >
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder={t('filterAll')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('filterAll')}</SelectItem>
              <SelectItem value="healthy">{t('filterHealthy')}</SelectItem>
              <SelectItem value="low_stock">{t('filterLowStock')}</SelectItem>
              <SelectItem value="out_of_stock">{t('filterOutOfStock')}</SelectItem>
            </SelectContent>
          </Select>

          {/* Supplier filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="w-full sm:w-[180px] justify-start">
                <Filter className="mr-2 h-4 w-4" />
                {selectedSupplierIds.size > 0
                  ? t('filters.suppliersSelected', { count: selectedSupplierIds.size })
                  : t('filters.allSuppliers')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[200px] max-h-[300px] overflow-y-auto">
              {suppliers.map((supplier) => (
                <DropdownMenuCheckboxItem
                  key={supplier.id}
                  checked={selectedSupplierIds.has(supplier.id)}
                  onCheckedChange={() => toggleSupplier(supplier.id)}
                >
                  {supplier.businessName}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Expiry filter */}
          <Select
            value={expiryFilter}
            onValueChange={(value) => setExpiryFilter(value as ExpiryFilter)}
          >
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder={t('filters.allExpiry')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('filters.allExpiry')}</SelectItem>
              <SelectItem value="expired">{t('filters.expired')}</SelectItem>
              <SelectItem value="expiring_soon">{t('filters.expiringSoon')}</SelectItem>
              <SelectItem value="ok">{t('filters.expiryOk')}</SelectItem>
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
                <SortableHeader
                  label={t('columns.productName')}
                  column="name"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                />
                <SortableHeader
                  label={t('columns.sku')}
                  column="sku"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                />
                <SortableHeader
                  label={t('columns.currentStock')}
                  column="currentStock"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  className="text-right"
                />
                <TableHead>{t('columns.unit')}</TableHead>
                <TableHead className="text-right">{t('columns.lowStockThreshold')}</TableHead>
                <TableHead>{t('columns.status')}</TableHead>
                <SortableHeader
                  label={t('columns.nearestExpiry')}
                  column="nearestExpiry"
                  currentColumn={sortColumn}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedProducts.map((product) => {
                const stockInfo = getProductStockInfo(product as unknown as Record<string, unknown>);
                const batchSummary = getBatchSummary(product as unknown as Record<string, unknown>);
                const isExpanded = expandedRows.has(product.id);
                return (
                  <Fragment key={product.id}>
                    <TableRow
                      className="cursor-pointer hover:bg-muted/50 [content-visibility:auto] [contain-intrinsic-size:auto_48px]"
                      onClick={() => toggleExpanded(product.id)}
                    >
                      <TableCell className="w-8 pr-0">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell>
                        <Link href={`/inventory/${product.id}`} className="font-medium text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
                          {product.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm text-muted-foreground">{product.sku}</p>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {stockInfo.currentStock.toFixed(1)}
                      </TableCell>
                      <TableCell>{product.unit}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {stockInfo.lowStockThreshold !== null
                          ? stockInfo.lowStockThreshold.toFixed(1)
                          : '-'}
                      </TableCell>
                      <TableCell>
                        <StockStatusBadge
                          currentStock={stockInfo.currentStock}
                          lowStockThreshold={stockInfo.lowStockThreshold}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="text-sm">
                            {formatExpiryDate(batchSummary?.nearestExpiryDate ?? null)}
                          </span>
                          <ExpiryStatusBadge expiryStatus={batchSummary?.expiryStatus} />
                        </div>
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <ProductBatchRows
                        productId={product.id}
                        parentCurrentStock={stockInfo.currentStock}
                        tBatches={t}
                        tExpiry={tExpiry}
                        onBatchClick={(batchId) => {
                          setSelectedBatchId(batchId);
                          setShowBatchDialog(true);
                        }}
                        onProcessingBatchClick={(batchNumber) => {
                          setSelectedProcessingBatchNumber(batchNumber);
                          setShowProcessingDialog(true);
                        }}
                      />
                    )}
                  </Fragment>
                );
              })}
              {sortedProducts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center">
                    <EmptyState icon={Package} title={t('emptyState')} />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <BatchInfoDialog
        open={showBatchDialog}
        onOpenChange={setShowBatchDialog}
        batchId={selectedBatchId}
      />

      <ProcessingRecordDialog
        open={showProcessingDialog}
        onOpenChange={(open) => {
          setShowProcessingDialog(open);
          if (!open) setSelectedProcessingBatchNumber(null);
        }}
        batchNumber={selectedProcessingBatchNumber}
      />
    </Card>
  );
}
