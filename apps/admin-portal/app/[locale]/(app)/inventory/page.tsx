'use client';

export const dynamic = 'force-dynamic';

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  H1,
  Muted,
  Small,
  CountUp,
  EmptyState,
  Badge,
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Input,
  TableSkeleton,
  StatusBadge,
  useToast,
  type StatusType,
} from '@joho-erp/ui';
import {
  Package,
  AlertTriangle,
  PackageX,
  DollarSign,
  ArrowDownUp,
  RefreshCw,
  Layers,
  Search,
  Download,
  Plus,
  PackagePlus,
  ArrowRightLeft,
  CheckCheck,
} from 'lucide-react';
import nextDynamic from 'next/dynamic';
import {
  StockMovementChart,
  InventoryValueChart,
  ProductTurnoverTable,
  ComparisonAnalytics,
  StockCountsTable,
  ExpiringBatchesList,
  StockWriteOffTable,
  StockReceivedTable,
  ProcessingHistoryTable,
  PackingHistoryTable,
  type InventoryTransaction,
} from './components';
import { BatchLink } from './components/BatchLink';
import { PermissionGate } from '@/components/permission-gate';

// Dynamically import heavy dialogs (they pull in xlsx, @react-pdf/renderer, etc.)
const StockAdjustmentDialog = nextDynamic(() => import('./components/StockAdjustmentDialog').then(m => m.StockAdjustmentDialog));
const ProcessStockDialog = nextDynamic(() => import('./components/ProcessStockDialog').then(m => m.ProcessStockDialog));
const InventoryTransactionDetailDialog = nextDynamic(() => import('./components/InventoryTransactionDetailDialog').then(m => m.InventoryTransactionDetailDialog));
const BatchInfoDialog = nextDynamic(() => import('./components/BatchInfoDialog').then(m => m.BatchInfoDialog));
const ExportDialog = nextDynamic(() => import('./components/ExportDialog').then(m => m.ExportDialog));
const ProcessingRecordDialog = nextDynamic(() => import('./components/ProcessingRecordDialog').then(m => m.ProcessingRecordDialog));
import { useTranslations } from 'next-intl';
import { api } from '@/trpc/client';
import { formatAUD } from '@joho-erp/shared';

type TransactionType = 'sale' | 'adjustment' | 'return' | undefined;
type AdjustmentTypeFilter = 'stock_received' | undefined;

export default function InventoryPage() {
  const t = useTranslations('inventory');
  const tStockCounts = useTranslations('inventory.stockCounts');
  const tCommon = useTranslations('common');
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const utils = api.useUtils();

  // Reconcile stock mutation
  const reconcileMutation = api.product.reconcileStock.useMutation({
    onSuccess: (data) => {
      void utils.product.getAll.invalidate();
      void utils.dashboard.getInventorySummary.invalidate();
      void utils.inventory.getProductBatches.invalidate();
      if (data.reconciledCount > 0) {
        toast({
          title: tStockCounts('reconcileSuccess', { count: data.reconciledCount }),
        });
      } else {
        toast({
          title: tStockCounts('reconcileNone'),
        });
      }
    },
    onError: (error) => {
      toast({
        title: tCommon('error'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const handleReconcile = () => {
    if (window.confirm(tStockCounts('reconcileConfirm'))) {
      reconcileMutation.mutate();
    }
  };

  // Filters for transaction history
  const [transactionType, setTransactionType] = useState<TransactionType>(undefined);
  const [adjustmentTypeFilter, setAdjustmentTypeFilter] = useState<AdjustmentTypeFilter>(undefined);
  const [productSearch, setProductSearch] = useState('');

  // Export dialog state
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [currentTab, setCurrentTab] = useState<'overview' | 'trends' | 'turnover' | 'comparison' | 'stockCounts' | 'stockExpiry' | 'writeOffs' | 'stockReceived' | 'processing' | 'packing'>('overview');

  // Stock counts initial filter state (from URL params)
  const [stockCountsInitialFilter, setStockCountsInitialFilter] = useState<'all' | 'healthy' | 'low_stock' | 'out_of_stock' | undefined>(undefined);
  const [stockCountsInitialSearch, setStockCountsInitialSearch] = useState<string | undefined>(undefined);

  // Stock adjustment state
  const [showStockDialog, setShowStockDialog] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<{
    id: string;
    name: string;
    sku: string;
    currentStock: number;
    unit: string;
  } | null>(null);

  // Process stock dialog state
  const [showProcessStockDialog, setShowProcessStockDialog] = useState(false);

  // Transaction detail dialog state
  const [selectedTransaction, setSelectedTransaction] = useState<InventoryTransaction | null>(null);
  const [showTransactionDetail, setShowTransactionDetail] = useState(false);

  // Batch info dialog state
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [showBatchInfoDialog, setShowBatchInfoDialog] = useState(false);

  // Processing record dialog state
  const [selectedProcessingBatchNumber, setSelectedProcessingBatchNumber] = useState<string | null>(null);
  const [showProcessingRecordDialog, setShowProcessingRecordDialog] = useState(false);

  // SI- batch number resolution for overview tab
  const [pendingSiBatchNumber, setPendingSiBatchNumber] = useState<string | null>(null);
  const { data: resolvedSiBatch } = api.inventory.getBatchIdByBatchNumber.useQuery(
    { batchNumber: pendingSiBatchNumber! },
    { enabled: !!pendingSiBatchNumber }
  );

  // Open BatchInfoDialog once SI- batchId resolves
  useEffect(() => {
    if (resolvedSiBatch?.batchId && pendingSiBatchNumber) {
      setSelectedBatchId(resolvedSiBatch.batchId);
      setShowBatchInfoDialog(true);
      setPendingSiBatchNumber(null);
    }
  }, [resolvedSiBatch, pendingSiBatchNumber]);

  // Handle query parameters from URL (e.g., from dashboard alerts)
  useEffect(() => {
    const batchId = searchParams.get('batchId');
    const expiryFilter = searchParams.get('expiryFilter');
    const stockFilter = searchParams.get('stockFilter');
    const productSearchParam = searchParams.get('productSearch');
    const tab = searchParams.get('tab');

    if (batchId) {
      setSelectedBatchId(batchId);
      setShowBatchInfoDialog(true);
      router.replace('/inventory', { scroll: false });
    } else if (expiryFilter === 'alert') {
      setCurrentTab('stockExpiry');
      router.replace('/inventory', { scroll: false });
    } else if (stockFilter === 'low') {
      setCurrentTab('stockCounts');
      setStockCountsInitialFilter('low_stock');
      router.replace('/inventory', { scroll: false });
    } else if (stockFilter === 'out') {
      setCurrentTab('stockCounts');
      setStockCountsInitialFilter('out_of_stock');
      router.replace('/inventory', { scroll: false });
    } else if (productSearchParam) {
      setCurrentTab('stockCounts');
      setStockCountsInitialSearch(productSearchParam);
      router.replace('/inventory', { scroll: false });
    } else if (tab === 'stockCounts') {
      setCurrentTab('stockCounts');
      router.replace('/inventory', { scroll: false });
    }
  }, [searchParams, router]);

  // API calls
  const { data: summary } = api.dashboard.getInventorySummary.useQuery();
  const { data: categoryData, isLoading: categoryLoading } = api.dashboard.getInventoryByCategory.useQuery();
  const { data: transactionsData, isLoading: transactionsLoading, refetch: refetchTransactions } =
    api.dashboard.getInventoryTransactions.useQuery({
      type: transactionType,
      adjustmentType: adjustmentTypeFilter,
      search: productSearch || undefined,
      limit: 20,
    });

  // Transaction type badge uses consolidated StatusBadge

  // Get adjustment type label
  const getAdjustmentTypeLabel = (type: string | null) => {
    if (!type) return '';
    switch (type) {
      case 'stock_received':
        return t('adjustmentTypes.stock_received');
      // TODO: Remove stock_count_correction after historical transaction data has been cleaned up
      case 'stock_count_correction':
        return t('adjustmentTypes.stock_count_correction');
      case 'stock_write_off':
        return t('adjustmentTypes.stock_write_off');
      case 'packing_adjustment':
        return t('adjustmentTypes.packing_adjustment');
      case 'processing':
        return t('adjustmentTypes.processing');
      default:
        return type;
    }
  };

  // Stock adjustment event handlers
  const handleStockAdjustSuccess = () => {
    refetchTransactions();
    void utils.product.getAll.invalidate();
    void utils.dashboard.getInventorySummary.invalidate();
    void utils.inventory.getProductBatches.invalidate();
    setSelectedProduct(null);
    setShowStockDialog(false);
  };

  const handleProcessStockSuccess = () => {
    refetchTransactions();
    void utils.product.getAll.invalidate();
    void utils.dashboard.getInventorySummary.invalidate();
    void utils.inventory.getProductBatches.invalidate();
    setShowProcessStockDialog(false);
  };

  const handleQuickAdjust = (tx: {
    productId: string;
    productName: string;
    productSku: string;
    productUnit: string;
    newStock: number;
  }) => {
    setSelectedProduct({
      id: tx.productId,
      name: tx.productName,
      sku: tx.productSku,
      currentStock: tx.newStock,
      unit: tx.productUnit,
    });
    setShowStockDialog(true);
  };

  return (
    <div className="container mx-auto px-4 py-6 md:py-10">
      <div className="flex justify-between items-center mb-6 md:mb-8">
        <div>
          <H1>{t('title')}</H1>
          <Muted className="mt-2">{t('subtitle')}</Muted>
        </div>
        <div className="flex gap-2">
          <PermissionGate permission="products:adjust_stock">
            <Button
              variant="default"
              onClick={() => {
                setSelectedProduct(null);
                setShowStockDialog(true);
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              <span className="hidden sm:inline">{t('adjustStock')}</span>
            </Button>
          </PermissionGate>
          <PermissionGate permission="products:adjust_stock">
            <Button
              variant="outline"
              onClick={() => setShowProcessStockDialog(true)}
            >
              <ArrowRightLeft className="h-4 w-4 mr-2" />
              <span className="hidden sm:inline">{t('processStock')}</span>
            </Button>
          </PermissionGate>
          <PermissionGate permission="products:adjust_stock">
            <Button
              variant="outline"
              onClick={handleReconcile}
              disabled={reconcileMutation.isPending}
            >
              <CheckCheck className="h-4 w-4 mr-2" />
              <span className="hidden sm:inline">{tStockCounts('reconcile')}</span>
            </Button>
          </PermissionGate>
          <Button onClick={() => setExportDialogOpen(true)}>
            <Download className="h-4 w-4 mr-2" />
            {t('export.export')}
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-6 md:mb-8">
        <Card className="stat-card animate-fade-in-up">
          <div className="stat-card-gradient" />
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 relative">
            <CardTitle className="text-sm font-medium">{t('totalValue')}</CardTitle>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-success/10 text-success">
              <DollarSign className="h-5 w-5" />
            </div>
          </CardHeader>
          <CardContent className="p-4 md:p-6 relative">
            <div className="stat-value tabular-nums text-2xl font-bold">
              {formatAUD(summary?.totalValue || 0)}
            </div>
            <Small className="text-muted-foreground mt-1">{t('basedOnCost')}</Small>
          </CardContent>
        </Card>

        <Card className="stat-card animate-fade-in-up delay-100">
          <div className="stat-card-gradient" />
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 relative">
            <CardTitle className="text-sm font-medium">{t('totalProducts')}</CardTitle>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/5 text-primary">
              <Package className="h-5 w-5" />
            </div>
          </CardHeader>
          <CardContent className="p-4 md:p-6 relative">
            <div className="stat-value tabular-nums">
              <CountUp end={summary?.totalProducts || 0} />
            </div>
            <Small className="text-muted-foreground mt-1">{t('activeProducts')}</Small>
          </CardContent>
        </Card>

        <Card className="stat-card animate-fade-in-up delay-200">
          <div className="stat-card-gradient" />
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 relative">
            <CardTitle className="text-sm font-medium">{t('lowStockItems')}</CardTitle>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-warning/10 text-warning">
              <AlertTriangle className="h-5 w-5" />
            </div>
          </CardHeader>
          <CardContent className="p-4 md:p-6 relative">
            <div className="stat-value tabular-nums">
              <CountUp end={summary?.lowStockCount || 0} />
            </div>
            <Small className="text-muted-foreground mt-1">{t('belowThreshold')}</Small>
          </CardContent>
        </Card>

        <Card className="stat-card animate-fade-in-up delay-300">
          <div className="stat-card-gradient" />
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 relative">
            <CardTitle className="text-sm font-medium">{t('outOfStock')}</CardTitle>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
              <PackageX className="h-5 w-5" />
            </div>
          </CardHeader>
          <CardContent className="p-4 md:p-6 relative">
            <div className="stat-value tabular-nums">
              <CountUp end={summary?.outOfStockCount || 0} />
            </div>
            <Small className="text-muted-foreground mt-1">{t('zeroStock')}</Small>
          </CardContent>
        </Card>
      </div>

      {/* Tabbed Content */}
      <Tabs value={currentTab} onValueChange={(v) => setCurrentTab(v as typeof currentTab)} className="space-y-4">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="overview">{t('tabs.overview')}</TabsTrigger>
          <TabsTrigger value="trends">{t('tabs.trends')}</TabsTrigger>
          <TabsTrigger value="turnover">{t('tabs.turnover')}</TabsTrigger>
          <TabsTrigger value="comparison">{t('tabs.comparison')}</TabsTrigger>
          <TabsTrigger value="stockCounts">{t('tabs.stockCounts')}</TabsTrigger>
          <TabsTrigger value="stockExpiry">{t('tabs.stockExpiry')}</TabsTrigger>
          <TabsTrigger value="writeOffs">{t('tabs.writeOffs')}</TabsTrigger>
          <TabsTrigger value="stockReceived">{t('tabs.stockReceived')}</TabsTrigger>
          <TabsTrigger value="processing">{t('tabs.processing')}</TabsTrigger>
          <TabsTrigger value="packing">{t('tabs.packing')}</TabsTrigger>
        </TabsList>

        {/* Overview Tab - Existing content */}
        <TabsContent value="overview">
          <div className="grid gap-4 lg:grid-cols-7">
            {/* Category Breakdown */}
            <Card className="lg:col-span-3 animate-fade-in-up">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Layers className="h-5 w-5" />
                  {t('byCategory')}
                </CardTitle>
                <CardDescription>{t('categoryBreakdownDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="p-4 md:p-6">
                {categoryLoading ? (
                  <TableSkeleton rows={5} columns={3} showMobileCards />
                ) : categoryData && categoryData.length > 0 ? (
                  <div className="space-y-4">
                    {categoryData.map((category) => (
                      <div
                        key={category.category}
                        className="flex items-center justify-between pb-3 border-b last:border-0"
                      >
                        <div>
                          <p className="font-medium">{category.category}</p>
                          <p className="text-sm text-muted-foreground">
                            {category.productCount} {t('products')}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-medium tabular-nums">{formatAUD(category.totalValue)}</p>
                          <div className="flex gap-2 justify-end">
                            <Small className="text-muted-foreground">
                              {category.totalStock} {t('units')}
                            </Small>
                            {category.lowStockCount > 0 && (
                              <Badge variant="destructive" className="text-xs">
                                {category.lowStockCount} {t('lowStock')}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState icon={Package} title={t('noCategories')} />
                )}
              </CardContent>
            </Card>

            {/* Transaction History */}
            <Card className="lg:col-span-4 animate-fade-in-up">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <ArrowDownUp className="h-5 w-5" />
                      {t('transactionHistory')}
                    </CardTitle>
                    <CardDescription>{t('recentTransactions')}</CardDescription>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => refetchTransactions()}>
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>

                {/* Search Input */}
                <div className="relative mt-4">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder={t('searchPlaceholder')}
                    className="pl-10"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                  />
                </div>

                {/* Filter Buttons */}
                <div className="flex flex-wrap gap-2 mt-4">
                  <Button
                    variant={transactionType === undefined ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTransactionType(undefined)}
                  >
                    {t('filters.allTypes')}
                  </Button>
                  <Button
                    variant={transactionType === 'sale' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTransactionType('sale')}
                  >
                    {t('types.sale')}
                  </Button>
                  <Button
                    variant={transactionType === 'adjustment' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTransactionType('adjustment')}
                  >
                    {t('types.adjustment')}
                  </Button>
                  <Button
                    variant={transactionType === 'return' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTransactionType('return')}
                  >
                    {t('types.return')}
                  </Button>
                  <div className="w-px h-6 bg-border mx-1" />
                  <Button
                    variant={adjustmentTypeFilter === 'stock_received' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() =>
                      setAdjustmentTypeFilter(
                        adjustmentTypeFilter === 'stock_received' ? undefined : 'stock_received'
                      )
                    }
                  >
                    {t('filters.stockIn')}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-4 md:p-6">
                {transactionsLoading ? (
                  <TableSkeleton rows={5} columns={4} showMobileCards />
                ) : transactionsData && transactionsData.transactions.length > 0 ? (
                  <div className="space-y-4 max-h-[400px] overflow-y-auto">
                    {transactionsData.transactions.map((tx) => (
                      <div
                        key={tx.id}
                        className="flex items-start justify-between pb-3 border-b last:border-0 cursor-pointer hover:bg-muted/50 transition-colors rounded-md p-2 -mx-2"
                        onClick={() => {
                          setSelectedTransaction(tx as InventoryTransaction);
                          setShowTransactionDetail(true);
                        }}
                      >
                        <div className="space-y-1">
                          <p className="font-medium">{tx.productName}</p>
                          <p className="text-sm text-muted-foreground">{tx.productSku}</p>
                          <div className="flex items-center gap-2">
                            <StatusBadge status={tx.type as StatusType} showIcon={false} />
                            {tx.adjustmentType && (
                              <span className="text-xs text-muted-foreground">
                                ({getAdjustmentTypeLabel(tx.adjustmentType)})
                              </span>
                            )}
                            {tx.batchNumber && (
                              <BatchLink
                                batchNumber={tx.batchNumber}
                                onClick={(bn) => {
                                  if (bn.startsWith('PR-')) {
                                    setSelectedProcessingBatchNumber(bn);
                                    setShowProcessingRecordDialog(true);
                                  } else if (bn.startsWith('SI-')) {
                                    setPendingSiBatchNumber(bn);
                                  } else {
                                    setSelectedTransaction(tx as InventoryTransaction);
                                    setShowTransactionDetail(true);
                                  }
                                }}
                              />
                            )}
                          </div>
                        </div>
                        <div className="flex items-start gap-2">
                          <div className="text-right">
                            <p
                              className={`font-medium tabular-nums ${
                                tx.quantity > 0 ? 'text-success' : 'text-destructive'
                              }`}
                            >
                              {tx.quantity > 0 ? '+' : ''}
                              {tx.quantity} {tx.productUnit}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {tx.previousStock} → {tx.newStock}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {new Date(tx.createdAt).toLocaleDateString('en-AU', {
                                day: 'numeric',
                                month: 'short',
                                year: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </p>
                          </div>
                          <PermissionGate permission="products:adjust_stock">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 hidden sm:flex shrink-0"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleQuickAdjust(tx);
                              }}
                              title={t('adjustStock')}
                            >
                              <PackagePlus className="h-4 w-4" />
                            </Button>
                          </PermissionGate>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState icon={ArrowDownUp} title={t('noTransactions')} />
                )}

                {transactionsData && transactionsData.hasMore && (
                  <div className="mt-4 text-center">
                    <Small className="text-muted-foreground">
                      {t('showingOf', {
                        shown: transactionsData.transactions.length,
                        total: transactionsData.totalCount,
                      })}
                    </Small>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Trends Tab - New charts */}
        <TabsContent value="trends" className="space-y-4">
          {currentTab === 'trends' && (
            <>
              <StockMovementChart />
              <InventoryValueChart />
            </>
          )}
        </TabsContent>

        {/* Turnover Tab - New table */}
        <TabsContent value="turnover">
          {currentTab === 'turnover' && <ProductTurnoverTable />}
        </TabsContent>

        {/* Comparison Tab - New analytics */}
        <TabsContent value="comparison">
          {currentTab === 'comparison' && <ComparisonAnalytics />}
        </TabsContent>

        {/* Stock Counts Tab - Product stock levels */}
        <TabsContent value="stockCounts">
          {currentTab === 'stockCounts' && (
            <StockCountsTable
              initialStatusFilter={stockCountsInitialFilter}
              initialSearch={stockCountsInitialSearch}
            />
          )}
        </TabsContent>

        {/* Stock Expiry Tab - Expiring batches list */}
        <TabsContent value="stockExpiry">
          {currentTab === 'stockExpiry' && <ExpiringBatchesList />}
        </TabsContent>

        {/* Write-Offs Tab - Write-off history */}
        <TabsContent value="writeOffs">
          {currentTab === 'writeOffs' && <StockWriteOffTable />}
        </TabsContent>

        {/* Stock Received Tab */}
        <TabsContent value="stockReceived">
          {currentTab === 'stockReceived' && <StockReceivedTable />}
        </TabsContent>

        {/* Processing Tab */}
        <TabsContent value="processing">
          {currentTab === 'processing' && <ProcessingHistoryTable />}
        </TabsContent>

        {/* Packing Tab */}
        <TabsContent value="packing">
          {currentTab === 'packing' && <PackingHistoryTable />}
        </TabsContent>
      </Tabs>

      {/* Stock Adjustment Dialog */}
      <StockAdjustmentDialog
        open={showStockDialog}
        onOpenChange={(open) => {
          setShowStockDialog(open);
          if (!open) setSelectedProduct(null);
        }}
        product={selectedProduct}
        onSuccess={handleStockAdjustSuccess}
      />

      {/* Process Stock Dialog */}
      <ProcessStockDialog
        open={showProcessStockDialog}
        onOpenChange={setShowProcessStockDialog}
        onSuccess={handleProcessStockSuccess}
      />

      {/* Export Dialog */}
      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        currentTab={currentTab as 'overview' | 'trends' | 'turnover' | 'comparison' | 'stockCounts' | 'stockExpiry' | 'writeOffs'}
        currentFilters={{
          transactionType,
          productSearch,
        }}
      />

      {/* Transaction Detail Dialog */}
      <InventoryTransactionDetailDialog
        open={showTransactionDetail}
        onOpenChange={(open) => {
          setShowTransactionDetail(open);
          if (!open) setSelectedTransaction(null);
        }}
        transaction={selectedTransaction}
      />

      {/* Batch Info Dialog */}
      <BatchInfoDialog
        open={showBatchInfoDialog}
        onOpenChange={(open) => {
          setShowBatchInfoDialog(open);
          if (!open) setSelectedBatchId(null);
        }}
        batchId={selectedBatchId}
      />

      {/* Processing Record Dialog */}
      <ProcessingRecordDialog
        open={showProcessingRecordDialog}
        onOpenChange={(open) => {
          setShowProcessingRecordDialog(open);
          if (!open) setSelectedProcessingBatchNumber(null);
        }}
        batchNumber={selectedProcessingBatchNumber}
      />
    </div>
  );
}
