'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
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
  Skeleton,
  EmptyState,
  Badge,
  Button,
  H1,
  Muted,
} from '@joho-erp/ui';
import {
  Package,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Layers,
  ExternalLink,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { api } from '@/trpc/client';
import { BatchLink } from '../components/BatchLink';

export default function ProductConsumptionPage() {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations('inventory.productConsumption');
  const productId = params.id as string;
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const { data, isLoading } = api.inventory.getProductConsumptionHistory.useQuery({
    productId,
    page,
    pageSize,
  });

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  };

  const formatDateTime = (date: string | Date) => {
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
      <div className="container mx-auto px-4 py-6 md:py-10">
        <Skeleton className="h-8 w-48 mb-4" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (!data?.product) {
    return (
      <div className="container mx-auto px-4 py-6 md:py-10">
        <EmptyState icon={Package} title={t('productNotFound')} />
      </div>
    );
  }

  const { product, consumptions, totalCount, totalPages } = data;

  return (
    <div className="container mx-auto px-4 py-6 md:py-10">
      <div className="flex items-center gap-4 mb-6">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <H1>{product.name}</H1>
          <Muted>{product.sku} &middot; {t('currentStock')}: {product.currentStock} {product.unit}</Muted>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-primary" />
            {t('title')}
          </CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.batchNumber')}</TableHead>
                  <TableHead>{t('columns.quantityConsumed')}</TableHead>
                  <TableHead>{t('columns.orderNumber')}</TableHead>
                  <TableHead>{t('columns.transactionType')}</TableHead>
                  <TableHead>{t('columns.batchReceived')}</TableHead>
                  <TableHead>{t('columns.batchExpiry')}</TableHead>
                  <TableHead>{t('columns.consumedAt')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {consumptions.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <BatchLink batchNumber={c.batchNumber} onClick={() => {}} />
                    </TableCell>
                    <TableCell className="tabular-nums font-medium text-destructive">
                      -{c.quantityConsumed} {product.unit}
                    </TableCell>
                    <TableCell>
                      {c.orderNumber ? (
                        c.orderId ? (
                          <Link
                            href={`/orders/${c.orderId}`}
                            className="text-primary hover:underline flex items-center gap-1"
                          >
                            {c.orderNumber}
                            <ExternalLink className="h-3 w-3" />
                          </Link>
                        ) : (
                          c.orderNumber
                        )
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {c.transactionAdjustmentType || c.transactionType}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDate(c.batchReceivedAt)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {c.batchExpiryDate ? formatDate(c.batchExpiryDate) : '-'}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDateTime(c.consumedAt)}
                    </TableCell>
                  </TableRow>
                ))}
                {consumptions.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center">
                      <EmptyState
                        icon={Layers}
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
    </div>
  );
}
