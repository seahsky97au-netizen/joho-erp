'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Skeleton,
  H3,
  Muted,
  Input,
  Label,
} from '@joho-erp/ui';
import { ShoppingCart, MapPin, Loader2, AlertCircle, Info, Calendar, ClipboardList, CreditCard, Ban } from 'lucide-react';
import { api } from '@/trpc/client';
import { formatAUD, formatDateForMelbourne } from '@joho-erp/shared';
import { useToast } from '@joho-erp/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { CutoffReminder } from '@/components/cutoff-reminder';

export function OrderSummary() {
  const t = useTranslations('checkout');
  const tCommon = useTranslations('common');
  const tBackorder = useTranslations('checkout.backorderWarning');
  const tDelivery = useTranslations('checkout.deliveryDate');
  const tCredit = useTranslations('checkout.credit');
  const tBlocking = useTranslations('checkout.blocking');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const { toast } = useToast();
  const params = useParams();
  const locale = params.locale as string;

  // State for delivery date
  const [deliveryDate, setDeliveryDate] = React.useState<string>('');
  const [isSundayError, setIsSundayError] = React.useState<boolean>(false);

  // Fetch customer profile for delivery address
  const { data: customer, isLoading: isLoadingCustomer } = api.customer.getProfile.useQuery();

  // Fetch onboarding status
  const { data: onboardingStatus, isLoading: isLoadingStatus } = api.customer.getOnboardingStatus.useQuery();

  // Fetch cutoff info
  const { data: cutoffInfo } = api.order.getCutoffInfo.useQuery(undefined, {
    refetchInterval: 60000, // Refresh every minute
  });

  // Fetch minimum order info
  const { data: minimumOrderInfo } = api.order.getMinimumOrderInfo.useQuery();

  // Set default delivery date based on cutoff info
  React.useEffect(() => {
    if (cutoffInfo?.nextAvailableDeliveryDate && !deliveryDate) {
      const nextDate = new Date(cutoffInfo.nextAvailableDeliveryDate);
      // Issue #12 fix: Use Melbourne timezone to avoid off-by-one errors
      setDeliveryDate(formatDateForMelbourne(nextDate));
    }
  }, [cutoffInfo, deliveryDate]);

  // Calculate min date for date picker (tomorrow or day after based on cutoff)
  // Issue #12 fix: Use Melbourne timezone to avoid off-by-one errors
  const minDeliveryDate = React.useMemo(() => {
    if (cutoffInfo?.nextAvailableDeliveryDate) {
      return formatDateForMelbourne(new Date(cutoffInfo.nextAvailableDeliveryDate));
    }
    // Default to tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return formatDateForMelbourne(tomorrow);
  }, [cutoffInfo]);

  // Reset delivery date if it's now before the minimum (e.g., tab was backgrounded overnight)
  React.useEffect(() => {
    if (deliveryDate && minDeliveryDate && deliveryDate < minDeliveryDate) {
      setDeliveryDate(minDeliveryDate);
    }
  }, [deliveryDate, minDeliveryDate]);

  // TRPC utils for cache invalidation
  const utils = api.useUtils();

  // Clear cart mutation
  const clearCart = api.cart.clearCart.useMutation({
    onSuccess: () => {
      void utils.cart.getCart.invalidate();
    },
  });

  // Create order mutation
  const createOrder = api.order.create.useMutation({
    onSuccess: () => {
      // Clear the cart after successful order
      clearCart.mutate();

      toast({
        title: t('orderPlaced'),
        description: t('orderPlacedSuccess'),
        variant: 'default',
      });
      router.push('/orders');
    },
    onError: (error) => {
      console.error('Place order error:', error.message);
      const isForbidden = error.data?.code === 'FORBIDDEN';
      const isBadRequest = error.data?.code === 'BAD_REQUEST';
      toast({
        title: isForbidden ? tBlocking('suspendedTitle') : t('orderFailed'),
        description: isForbidden
          ? tBlocking('suspendedMessage')
          : isBadRequest
            ? error.message
            : tErrors('orderFailed'),
        variant: 'destructive',
      });
      if (isForbidden) {
        void utils.customer.getOnboardingStatus.invalidate();
      }
    },
  });

  // Fetch cart data
  const { data: cart, isLoading: isLoadingCart } = api.cart.getCart.useQuery();

  const handlePlaceOrder = () => {
    if (!customer) {
      toast({
        title: t('error'),
        description: t('customerNotFound'),
        variant: 'destructive',
      });
      return;
    }

    if (!cart || cart.items.length === 0) {
      toast({
        title: t('error'),
        description: t('emptyCart'),
        variant: 'destructive',
      });
      return;
    }

    // Check if selected delivery date is Sunday
    if (deliveryDate) {
      const selectedDate = new Date(deliveryDate);
      if (selectedDate.getDay() === 0) {
        toast({
          title: t('error'),
          description: `${tDelivery('sundayNotAvailable')}. ${tDelivery('selectWeekday')}`,
          variant: 'destructive',
        });
        return;
      }
    }

    // Convert cart items to order format
    const orderItems = cart.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
    }));

    createOrder.mutate({
      items: orderItems,
      requestedDeliveryDate: deliveryDate ? new Date(deliveryDate) : undefined,
    });
  };;

  // Check if order exceeds available credit
  const exceedsCredit = cart?.exceedsCredit ?? false;

  // Check if order is below minimum
  const belowMinimum = React.useMemo(() => {
    if (!minimumOrderInfo?.hasMinimum || !cart) return false;
    return cart.total < (minimumOrderInfo.minimumOrderAmount || 0);
  }, [minimumOrderInfo, cart]);

  // Check for blocking conditions
  const isSuspended = onboardingStatus?.status === 'suspended';
  const isOnboardingIncomplete = !onboardingStatus?.onboardingComplete;
  const isCreditPending = onboardingStatus?.creditStatus !== 'approved';

  // Cart totals (already calculated by backend)
  const subtotal = cart?.subtotal ?? 0;
  const gst = cart?.gst ?? 0;
  const total = cart?.total ?? 0;

  // Loading state
  if (isLoadingCustomer || isLoadingCart || isLoadingStatus) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-40" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-16 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  // Error state - customer not found
  if (!customer) {
    return (
      <div className="p-4 border border-destructive rounded-lg bg-destructive/10">
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="h-4 w-4" />
          <p className="text-sm font-medium">{t('customerNotFound')}</p>
        </div>
      </div>
    );
  }

  // Empty cart state
  if (!cart || cart.items.length === 0) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="text-center">
            <ShoppingCart className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
            <H3 className="mb-2">{t('emptyCart')}</H3>
            <Muted className="mb-4">{t('emptyCartDescription')}</Muted>
            <Button onClick={() => {}}>
              {t('continueShopping')}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Blocking state - account suspended
  if (isSuspended) {
    return (
      <div className="space-y-4">
        <Card className="border-destructive bg-destructive/5">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <Ban className="h-8 w-8 text-destructive flex-shrink-0 mt-1" />
              <div className="flex-1">
                <H3 className="text-lg text-destructive mb-2">{tBlocking('suspendedTitle')}</H3>
                <p className="text-destructive/80 mb-4">{tBlocking('suspendedMessage')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Still show cart items as reference */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShoppingCart className="h-5 w-5" />
              {t('orderItems')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {cart.items.map((item) => (
              <div key={item.productId} className="flex justify-between items-start pb-3 border-b last:border-0 last:pb-0 opacity-60">
                <div className="flex-1">
                  <p className="font-medium">{item.productName}</p>
                  <Muted className="text-sm">
                    {item.quantity} × {formatAUD(item.unitPrice)}
                  </Muted>
                </div>
                <p className="font-semibold">{formatAUD(item.subtotal)}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Blocking state - onboarding incomplete
  if (isOnboardingIncomplete) {
    return (
      <div className="space-y-4">
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <ClipboardList className="h-8 w-8 text-amber-600 flex-shrink-0 mt-1" />
              <div className="flex-1">
                <H3 className="text-lg text-amber-800 mb-2">{tBlocking('onboardingTitle')}</H3>
                <p className="text-amber-700 mb-4">{tBlocking('onboardingMessage')}</p>
                <Link href={`/${locale}/onboarding`}>
                  <Button className="bg-amber-600 hover:bg-amber-700">
                    {tBlocking('completeOnboarding')}
                  </Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Still show cart items as reference */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShoppingCart className="h-5 w-5" />
              {t('orderItems')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {cart.items.map((item) => (
              <div key={item.productId} className="flex justify-between items-start pb-3 border-b last:border-0 last:pb-0 opacity-60">
                <div className="flex-1">
                  <p className="font-medium">{item.productName}</p>
                  <Muted className="text-sm">
                    {item.quantity} × {formatAUD(item.unitPrice)}
                  </Muted>
                </div>
                <p className="font-semibold">{formatAUD(item.subtotal)}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Blocking state - credit pending
  if (isCreditPending) {
    return (
      <div className="space-y-4">
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <CreditCard className="h-8 w-8 text-amber-600 flex-shrink-0 mt-1" />
              <div className="flex-1">
                <H3 className="text-lg text-amber-800 mb-2">{tBlocking('creditTitle')}</H3>
                <p className="text-amber-700 mb-4">
                  {onboardingStatus?.creditStatus === 'rejected'
                    ? tBlocking('creditRejectedMessage')
                    : tBlocking('creditPendingMessage')
                  }
                </p>
                <Link href={`/${locale}/profile`}>
                  <Button variant="outline" className="border-amber-600 text-amber-700 hover:bg-amber-100">
                    {tBlocking('viewProfile')}
                  </Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Still show cart items as reference */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShoppingCart className="h-5 w-5" />
              {t('orderItems')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {cart.items.map((item) => (
              <div key={item.productId} className="flex justify-between items-start pb-3 border-b last:border-0 last:pb-0 opacity-60">
                <div className="flex-1">
                  <p className="font-medium">{item.productName}</p>
                  <Muted className="text-sm">
                    {item.quantity} × {formatAUD(item.unitPrice)}
                  </Muted>
                </div>
                <p className="font-semibold">{formatAUD(item.subtotal)}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Show order total */}
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex justify-between">
              <Muted>{tCommon('subtotal')}</Muted>
              <span>{formatAUD(subtotal)}</span>
            </div>
            {gst > 0 && (
              <div className="flex justify-between">
                <Muted>{tCommon('tax')}</Muted>
                <span>{formatAUD(gst)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-lg pt-2 border-t">
              <span>{tCommon('total')}</span>
              <span>{formatAUD(total)}</span>
            </div>
          </CardContent>
        </Card>

        {/* Disabled order button */}
        <Button className="w-full" size="lg" disabled>
          {tBlocking('creditPendingButton')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Backorder Warning for Credit Customers */}
      {customer.creditApplication.status === 'approved' && (
        <Card className="border-info bg-info/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-2">
              <Info className="h-5 w-5 text-info mt-0.5 flex-shrink-0" />
              <div>
                <H3 className="text-base mb-1">{tBackorder('title')}</H3>
                <p className="text-sm text-muted-foreground">
                  {tBackorder('message')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Delivery Date Selection */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            {tDelivery('label')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="deliveryDate">{tDelivery('selectDate')}</Label>
            <Input
              id="deliveryDate"
              type="date"
              value={deliveryDate}
              min={minDeliveryDate}
              onChange={(e) => {
                const selectedDate = e.target.value;
                setDeliveryDate(selectedDate);

                // Check if selected date is Sunday (getDay() returns 0 for Sunday)
                const date = new Date(selectedDate);
                const isSunday = date.getDay() === 0;
                setIsSundayError(isSunday);
              }}
              className={`mt-1 ${isSundayError ? 'border-destructive' : ''}`}
            />
            {isSundayError && (
              <p className="text-sm text-destructive mt-1">
                {tDelivery('sundayNotAvailable')}. {tDelivery('selectWeekday')}
              </p>
            )}
          </div>

          {/* Cutoff Reminder */}
          {cutoffInfo && (
            <CutoffReminder
              cutoffTime={cutoffInfo.cutoffTime}
              isAfterCutoff={cutoffInfo.isAfterCutoff}
              nextAvailableDate={new Date(cutoffInfo.nextAvailableDeliveryDate)}
            />
          )}
        </CardContent>
      </Card>

      {/* Credit Limit Warning */}
      {exceedsCredit && (
        <Card className="border-destructive bg-destructive/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-destructive mt-0.5 flex-shrink-0" />
              <div>
                <H3 className="text-base mb-1 text-destructive">{t('orderBlocked')}</H3>
                <p className="text-sm text-muted-foreground">
                  {t('orderBlockedMessage')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Minimum Order Warning */}
      {belowMinimum && minimumOrderInfo && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-4">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
              <div>
                <H3 className="text-base mb-1 text-amber-700">{t('minimumOrder.belowMinimum')}</H3>
                <p className="text-sm text-amber-600">
                  {t('minimumOrder.belowMinimumMessage', {
                    current: formatAUD(total),
                    required: formatAUD(minimumOrderInfo.minimumOrderAmount || 0),
                    shortfall: formatAUD((minimumOrderInfo.minimumOrderAmount || 0) - total),
                  })}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Order Items */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5" />
            {t('orderItems')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {cart.items.map((item) => (
            <div key={item.productId} className="flex justify-between items-start pb-3 border-b last:border-0 last:pb-0">
              <div className="flex-1">
                <p className="font-medium">{item.productName}</p>
                <Muted className="text-sm">
                  {item.quantity} × {formatAUD(item.unitPrice)}
                </Muted>
              </div>
              <p className="font-semibold">{formatAUD(item.subtotal)}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Delivery Address */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            {t('deliveryAddress')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-base">
            <p>{customer.deliveryAddress.street}</p>
            <p>
              {customer.deliveryAddress.suburb} {customer.deliveryAddress.state}{' '}
              {customer.deliveryAddress.postcode}
            </p>
            {customer.deliveryAddress.deliveryInstructions && (
              <Muted className="mt-2">
                {t('instructions')}: {customer.deliveryAddress.deliveryInstructions}
              </Muted>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Order Summary */}
      <Card>
        <CardHeader>
          <CardTitle>{t('summary')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-between">
            <Muted>{tCommon('subtotal')}</Muted>
            <p className="font-medium">{formatAUD(subtotal)}</p>
          </div>
          {gst > 0 && (
            <div className="flex justify-between">
              <Muted>{tCommon('tax')}</Muted>
              <p className="font-medium">{formatAUD(gst)}</p>
            </div>
          )}
          <div className="border-t pt-3 flex justify-between">
            <p className="text-lg font-semibold">{tCommon('total')}</p>
            <p className="text-lg font-bold">{formatAUD(total)}</p>
          </div>
        </CardContent>
      </Card>

      {/* Place Order Button */}
      <Button
        className="w-full"
        size="lg"
        onClick={handlePlaceOrder}
        disabled={createOrder.isPending || cart.items.length === 0 || exceedsCredit || belowMinimum || !deliveryDate || isSundayError}
      >
        {createOrder.isPending ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            {t('placingOrder')}
          </>
        ) : exceedsCredit ? (
          tCredit('exceedsCredit')
        ) : belowMinimum ? (
          t('minimumOrder.belowMinimum')
        ) : (
          tCommon('placeOrder')
        )}
      </Button>
    </div>
  );
}
