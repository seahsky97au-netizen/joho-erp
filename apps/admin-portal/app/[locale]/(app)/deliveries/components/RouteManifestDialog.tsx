'use client';

import { useState, useCallback, useEffect } from 'react';
import { printPdfBlob } from '@/lib/printPdf';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@joho-erp/ui';
import { useTranslations } from 'next-intl';
import { Loader2, FileText, FileStack, Printer, Zap } from 'lucide-react';
import { api } from '@/trpc/client';

interface RouteManifestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDate: Date;
  selectedArea?: string; // Area ID or 'all'
}

export function RouteManifestDialog({
  open,
  onOpenChange,
  selectedDate,
  selectedArea,
}: RouteManifestDialogProps) {
  const t = useTranslations('deliveries.manifest');
  const tCommon = useTranslations('common');
  const tErrors = useTranslations('errors');
  const { toast } = useToast();

  const [areaFilter, setAreaFilter] = useState<string>(selectedArea || 'all');

  // Fetch areas dynamically
  const { data: areas } = api.area.list.useQuery();

  // Query for invoice URLs
  const { data: invoiceData, isLoading: isLoadingInvoices } = api.delivery.getInvoiceUrlsForDelivery.useQuery(
    {
      dateFrom: selectedDate,
      dateTo: new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), 23, 59, 59, 999),
      areaId: areaFilter !== 'all' ? areaFilter : undefined,
    },
    {
      enabled: open,
    }
  );

  const [isDownloadingInvoices, setIsDownloadingInvoices] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);
  const [isGeneratingInvoices, setIsGeneratingInvoices] = useState(false);
  const [generateProgress, setGenerateProgress] = useState<{ current: number; total: number } | null>(null);

  const utils = api.useUtils();
  const createInvoiceMutation = api.xero.createInvoice.useMutation();

  const fetchMergedPdf = useCallback(async (orderIds: string[]): Promise<{ blob: Blob; failedOrders: string[]; total: number; successful: number } | null> => {
    const response = await fetch('/api/invoices/merge-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText);
    }

    const blob = await response.blob();
    const total = parseInt(response.headers.get('X-Total-Invoices') || '0', 10);
    const successful = parseInt(response.headers.get('X-Successful-Invoices') || '0', 10);
    const failedOrdersHeader = response.headers.get('X-Failed-Orders') || '';
    const failedOrders = failedOrdersHeader ? failedOrdersHeader.split(',') : [];

    return { blob, failedOrders, total, successful };
  }, []);

  const downloadAllInvoices = useCallback(async () => {
    if (!invoiceData?.invoices?.length) return;

    setIsDownloadingInvoices(true);

    try {
      const orderIds = invoiceData.invoices.map((inv) => inv.orderId);
      const result = await fetchMergedPdf(orderIds);
      if (!result) return;

      // Trigger download via hidden anchor
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      const today = new Date().toISOString().split('T')[0];
      a.download = `Invoices-${today}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (result.failedOrders.length > 0) {
        toast({
          title: t('partialSuccess', {
            success: result.successful,
            total: result.total,
            failed: result.failedOrders.length,
          }),
          variant: 'destructive',
        });
      } else {
        toast({ title: t('downloadReady') });
      }
    } catch (error) {
      console.error('Error downloading invoices:', error);
      toast({
        title: tErrors('generationFailed'),
        variant: 'destructive',
      });
    } finally {
      setIsDownloadingInvoices(false);
    }
  }, [invoiceData, fetchMergedPdf, toast, tErrors, t]);

  const handlePrint = useCallback(async () => {
    if (!invoiceData?.invoices?.length) return;

    setIsPrinting(true);

    try {
      const orderIds = invoiceData.invoices.map((inv) => inv.orderId);
      const result = await fetchMergedPdf(orderIds);
      if (!result) return;

      printPdfBlob(result.blob);

      if (result.failedOrders.length > 0) {
        toast({
          title: t('partialSuccess', {
            success: result.successful,
            total: result.total,
            failed: result.failedOrders.length,
          }),
          variant: 'destructive',
        });
      } else {
        toast({ title: t('printReady') });
      }
    } catch (error) {
      console.error('Error printing invoices:', error);
      toast({
        title: tErrors('generationFailed'),
        variant: 'destructive',
      });
    } finally {
      setIsPrinting(false);
    }
  }, [invoiceData, fetchMergedPdf, toast, tErrors, t]);

  const generateMissingInvoices = useCallback(async () => {
    const orders = invoiceData?.ordersWithoutInvoices;
    if (!orders?.length) return;

    setIsGeneratingInvoices(true);
    setGenerateProgress({ current: 0, total: orders.length });

    let successCount = 0;
    let failedCount = 0;

    for (let i = 0; i < orders.length; i++) {
      setGenerateProgress({ current: i + 1, total: orders.length });
      try {
        await createInvoiceMutation.mutateAsync({ orderId: orders[i].orderId });
        successCount++;
      } catch {
        failedCount++;
      }
    }

    // Refresh data
    await utils.delivery.getInvoiceUrlsForDelivery.invalidate();

    if (failedCount === 0) {
      toast({
        title: t('generateSuccess'),
        description: t('generateSuccessDescription', { count: successCount }),
      });
    } else {
      toast({
        title: t('generatePartialSuccess', {
          success: successCount,
          total: orders.length,
          failed: failedCount,
        }),
        variant: 'destructive',
      });
    }

    setIsGeneratingInvoices(false);
    setGenerateProgress(null);
  }, [invoiceData, createInvoiceMutation, utils, toast, t]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setGenerateProgress(null);
    }
  }, [open]);

  const formatDate = (date: Date): string => {
    return new Intl.DateTimeFormat('en-AU', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(date);
  };

  const isBusy = isDownloadingInvoices || isPrinting || isGeneratingInvoices;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {t('title')}
          </DialogTitle>
          <DialogDescription>{t('subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Date Display */}
          <div>
            <Label className="text-sm text-muted-foreground">{t('dateLabel')}</Label>
            <p className="font-medium">{formatDate(selectedDate)}</p>
          </div>

          {/* Area Filter - Dynamic areas from API */}
          <div className="space-y-2">
            <Label htmlFor="area-select">{t('areaLabel')}</Label>
            <Select value={areaFilter} onValueChange={setAreaFilter}>
              <SelectTrigger id="area-select">
                <SelectValue placeholder={t('allAreas')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('allAreas')}</SelectItem>
                {areas?.map((area) => (
                  <SelectItem key={area.id} value={area.id}>
                    {area.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Invoice Count Preview */}
          {isLoadingInvoices ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {tCommon('loading')}
            </div>
          ) : invoiceData?.totalOrders ? (
            <div className="p-3 bg-muted rounded-lg space-y-1">
              <p className="text-sm">
                {t('invoiceStatus', { withInvoices: invoiceData.ordersWithInvoices, total: invoiceData.totalOrders })}
              </p>
              {invoiceData.totalOrders > invoiceData.ordersWithInvoices && (
                <p className="text-xs text-muted-foreground">
                  {t('invoicesPending', { count: invoiceData.totalOrders - invoiceData.ordersWithInvoices })}
                </p>
              )}
              {invoiceData.ordersWithoutInvoices && invoiceData.ordersWithoutInvoices.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={isBusy}
                  onClick={generateMissingInvoices}
                >
                  {isGeneratingInvoices ? (
                    <>
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      {t('generatingInvoices')}
                    </>
                  ) : (
                    <>
                      <Zap className="h-3 w-3 mr-1" />
                      {t('generateInvoices')} ({invoiceData.ordersWithoutInvoices.length})
                    </>
                  )}
                </Button>
              )}
            </div>
          ) : (
            <div className="p-3 bg-destructive/10 text-destructive rounded-lg">
              <p className="text-sm">{t('noOrdersFound')}</p>
            </div>
          )}
        </div>

        {/* Progress indicators */}
        {generateProgress && (() => {
          const pct = Math.round((generateProgress.current / generateProgress.total) * 100);
          return (
            <div className="px-6 pb-2 space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{t('generatingProgress', { current: generateProgress.current, total: generateProgress.total })}</span>
                <span>{pct}%</span>
              </div>
              <div className="w-full bg-secondary rounded-full h-2">
                <div
                  className="bg-primary h-full rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })()}

        {/* Preparing invoices message */}
        {(isDownloadingInvoices || isPrinting) && (
          <div className="px-6 pb-2 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('preparingInvoices', { count: invoiceData?.ordersWithInvoices || 0 })}
          </div>
        )}

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isBusy}>
            {tCommon('cancel')}
          </Button>
          <Button
            variant="secondary"
            onClick={handlePrint}
            disabled={isPrinting || isLoadingInvoices || !invoiceData?.ordersWithInvoices || isGeneratingInvoices}
          >
            {isPrinting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('printingInvoices')}
              </>
            ) : (
              <>
                <Printer className="h-4 w-4 mr-2" />
                {t('printInvoices')}
              </>
            )}
          </Button>
          <Button
            onClick={downloadAllInvoices}
            disabled={isDownloadingInvoices || isLoadingInvoices || !invoiceData?.ordersWithInvoices || isGeneratingInvoices}
          >
            {isDownloadingInvoices ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('downloadingInvoices')}
              </>
            ) : (
              <>
                <FileStack className="h-4 w-4 mr-2" />
                {t('downloadInvoices')} {invoiceData?.ordersWithInvoices ? `(${invoiceData.ordersWithInvoices})` : ''}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
