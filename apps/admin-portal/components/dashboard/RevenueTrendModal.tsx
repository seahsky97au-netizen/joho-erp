'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@joho-erp/ui';
import { formatAUD } from '@joho-erp/shared';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { RevenueChart } from './RevenueChart';
import { api } from '@/trpc/client';

interface RevenueTrendModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function RevenueTrendModal({ isOpen, onClose }: RevenueTrendModalProps) {
  const t = useTranslations('dashboard.revenueChart');
  const [days, setDays] = useState<7 | 14 | 30>(7);

  const { data: trendData, isLoading } = api.dashboard.getRevenueTrend.useQuery(
    { days },
    { enabled: isOpen }
  );

  // Calculate summary stats
  const totalRevenue = trendData?.reduce((sum, d) => sum + d.revenue, 0) || 0;
  const totalOrders = trendData?.reduce((sum, d) => sum + d.orderCount, 0) || 0;
  const avgDailyRevenue = trendData && trendData.length > 0 ? totalRevenue / trendData.length : 0;

  // Calculate trend (compare first half to second half)
  const getTrend = () => {
    if (!trendData || trendData.length < 2) return 0;
    const mid = Math.floor(trendData.length / 2);
    const firstHalf = trendData.slice(0, mid).reduce((sum, d) => sum + d.revenue, 0);
    const secondHalf = trendData.slice(mid).reduce((sum, d) => sum + d.revenue, 0);
    if (firstHalf === 0) return 0;
    return Math.round(((secondHalf - firstHalf) / firstHalf) * 100);
  };

  const trend = getTrend();
  const TrendIcon = trend > 0 ? TrendingUp : trend < 0 ? TrendingDown : Minus;
  const trendColor = trend > 0 ? 'text-success' : trend < 0 ? 'text-destructive' : 'text-muted-foreground';

  return (
    <Dialog open={isOpen} onOpenChange={(open: boolean) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-6">
          {/* Period Selector */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t('timePeriod')}</span>
            <Select value={days.toString()} onValueChange={(v) => setDays(Number(v) as 7 | 14 | 30)}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">{t('last7Days')}</SelectItem>
                <SelectItem value="14">{t('last14Days')}</SelectItem>
                <SelectItem value="30">{t('last30Days')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Summary Stats */}
          {isLoading ? (
            <div className="grid grid-cols-3 gap-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-8 w-20" />
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4">
              <div className="revenue-modal-stat">
                <div className="revenue-modal-stat-value">{formatAUD(totalRevenue)}</div>
                <div className="revenue-modal-stat-label">{t('totalRevenue')}</div>
              </div>
              <div className="revenue-modal-stat">
                <div className="revenue-modal-stat-value">{totalOrders}</div>
                <div className="revenue-modal-stat-label">{t('totalOrders')}</div>
              </div>
              <div className="revenue-modal-stat">
                <div className="revenue-modal-stat-value">{formatAUD(avgDailyRevenue)}</div>
                <div className="revenue-modal-stat-label">{t('dailyAverage')}</div>
                <div className={`revenue-modal-stat-trend ${trendColor}`}>
                  <TrendIcon className="h-3 w-3" />
                  <span>{trend > 0 ? '+' : ''}{trend}%</span>
                </div>
              </div>
            </div>
          )}

          {/* Chart */}
          <div className="revenue-modal-chart">
            {isLoading ? (
              <div className="h-full flex items-center justify-center">
                <Skeleton className="h-full w-full" />
              </div>
            ) : trendData && trendData.length > 0 ? (
              <RevenueChart data={trendData} showOrderCount />
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground">
                {t('noDataForPeriod')}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
