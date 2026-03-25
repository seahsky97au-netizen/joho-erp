'use client';

import { useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@joho-erp/ui';
import { Truck, MapPin, User, Camera, Calendar, FileImage } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatDate } from '@joho-erp/shared';
import Image from 'next/image';

interface DeliveryAddress {
  street: string;
  suburb: string;
  state: string;
  postcode: string;
  areaId?: string | null;
  areaName?: string | null;
  deliveryInstructions?: string | null;
}

interface ProofOfDelivery {
  type: string;
  fileUrl: string;
  uploadedAt: Date | string;
}

interface Delivery {
  driverId?: string | null;
  driverName?: string | null;
  assignedAt?: Date | string | null;
  startedAt?: Date | string | null;
  deliveredAt?: Date | string | null;
  proofOfDelivery?: ProofOfDelivery | null;
  notes?: string | null;
  deliverySequence?: number | null;
  returnReason?: string | null;
  returnNotes?: string | null;
  returnedAt?: Date | string | null;
}

interface DeliveryInfoProps {
  deliveryAddress: DeliveryAddress;
  requestedDeliveryDate: Date | string;
  delivery?: Delivery | null;
}

export function DeliveryInfo({
  deliveryAddress,
  requestedDeliveryDate,
  delivery,
}: DeliveryInfoProps) {
  const t = useTranslations('orderDetail');
  const tCommon = useTranslations('common');
  const [isPodDialogOpen, setIsPodDialogOpen] = useState(false);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Truck className="h-5 w-5" />
            {t('delivery.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Delivery Address */}
          <div>
            <p className="text-sm text-muted-foreground flex items-center gap-1 mb-1">
              <MapPin className="h-4 w-4" />
              {t('delivery.address')}
            </p>
            <p className="text-sm">
              {deliveryAddress.street}
              <br />
              {deliveryAddress.suburb}, {deliveryAddress.state} {deliveryAddress.postcode}
            </p>
            {deliveryAddress.areaName && (
              <Badge variant="outline" className="mt-2">
                {tCommon('area')}: {deliveryAddress.areaName.toUpperCase()}
              </Badge>
            )}
          </div>

          {deliveryAddress.deliveryInstructions && (
            <div>
              <p className="text-sm text-muted-foreground">{t('delivery.instructions')}</p>
              <p className="text-sm">{deliveryAddress.deliveryInstructions}</p>
            </div>
          )}

          {/* Dates */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                {t('delivery.requestedDate')}
              </p>
              <p className="text-sm font-medium">{formatDate(requestedDeliveryDate)}</p>
            </div>
            {delivery?.deliveredAt && (
              <div>
                <p className="text-sm text-muted-foreground">{t('delivery.actualDate')}</p>
                <p className="text-sm font-medium text-success">{formatDate(delivery.deliveredAt)}</p>
              </div>
            )}
          </div>

          {/* Driver */}
          <div>
            <p className="text-sm text-muted-foreground flex items-center gap-1">
              <User className="h-4 w-4" />
              {t('delivery.driver')}
            </p>
            <p className="text-sm font-medium mt-1">
              {delivery?.driverName || t('delivery.unassigned')}
            </p>
          </div>

          {/* Return Info */}
          {delivery?.returnedAt && (
            <div className="border-t pt-4">
              <p className="text-sm font-medium text-destructive mb-2">{t('delivery.returned')}</p>
              <div className="space-y-2">
                <div>
                  <p className="text-sm text-muted-foreground">{t('delivery.returnReason')}</p>
                  <p className="text-sm">{delivery.returnReason}</p>
                </div>
                {delivery.returnNotes && (
                  <div>
                    <p className="text-sm text-muted-foreground">{t('delivery.returnNotes')}</p>
                    <p className="text-sm">{delivery.returnNotes}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Proof of Delivery */}
          {delivery?.proofOfDelivery ? (
            <div className="border-t pt-4">
              <p className="text-sm text-muted-foreground flex items-center gap-1 mb-2">
                <Camera className="h-4 w-4" />
                {t('delivery.pod')}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsPodDialogOpen(true)}
              >
                <FileImage className="h-4 w-4 mr-2" />
                {t('delivery.viewPod')}
              </Button>
            </div>
          ) : (
            delivery?.deliveredAt && (
              <div className="border-t pt-4">
                <p className="text-sm text-muted-foreground">{t('delivery.noPod')}</p>
              </div>
            )
          )}
        </CardContent>
      </Card>

      {/* POD Dialog */}
      <Dialog open={isPodDialogOpen} onOpenChange={setIsPodDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('delivery.pod')}</DialogTitle>
          </DialogHeader>
          {delivery?.proofOfDelivery && (
            <div className="space-y-4">
              <div className="relative aspect-video bg-muted rounded-lg overflow-hidden">
                <Image
                  src={delivery.proofOfDelivery.fileUrl}
                  alt={tCommon('aria.proofOfDelivery')}
                  fill
                  className="object-contain"
                />
              </div>
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>
                  {t('delivery.podType')}: {delivery.proofOfDelivery.type}
                </span>
                <span>{formatDate(delivery.proofOfDelivery.uploadedAt)}</span>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
