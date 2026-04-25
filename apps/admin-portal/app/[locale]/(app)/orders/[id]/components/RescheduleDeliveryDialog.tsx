'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  useToast,
} from '@joho-erp/ui';
import { api } from '@/trpc/client';

interface RescheduleDeliveryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  currentDeliveryDate: Date | string;
  workingDays: number[];
}

const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5, 6];

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function RescheduleDeliveryDialog({
  open,
  onOpenChange,
  orderId,
  currentDeliveryDate,
  workingDays,
}: RescheduleDeliveryDialogProps) {
  const t = useTranslations('orderDetail.delivery.reschedule');
  const tCommon = useTranslations('common');
  const { toast } = useToast();
  const utils = api.useUtils();

  const effectiveWorkingDays =
    workingDays.length > 0 ? workingDays : DEFAULT_WORKING_DAYS;

  const initialValue = useMemo(
    () => toDateInputValue(new Date(currentDeliveryDate)),
    [currentDeliveryDate]
  );

  const [newDate, setNewDate] = useState<string>(initialValue);
  const [reason, setReason] = useState<string>('');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setNewDate(initialValue);
      setReason('');
      setValidationError(null);
    }
  }, [open, initialValue]);

  const minDate = useMemo(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return toDateInputValue(tomorrow);
  }, []);

  const rescheduleMutation = api.order.rescheduleDelivery.useMutation({
    onSuccess: async () => {
      toast({
        title: t('success'),
      });
      await utils.order.getById.invalidate({ orderId });
      onOpenChange(false);
    },
    onError: (error) => {
      toast({
        title: t('failed'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const handleDateChange = (value: string) => {
    setNewDate(value);
    if (!value) {
      setValidationError(null);
      return;
    }
    const parsed = new Date(value);
    if (!effectiveWorkingDays.includes(parsed.getDay())) {
      setValidationError(t('notWorkingDay'));
    } else {
      setValidationError(null);
    }
  };

  const handleSave = () => {
    if (!newDate) return;
    const parsed = new Date(newDate);
    if (!effectiveWorkingDays.includes(parsed.getDay())) {
      setValidationError(t('notWorkingDay'));
      return;
    }
    rescheduleMutation.mutate({
      orderId,
      newDeliveryDate: parsed,
      reason: reason.trim() || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('dialogTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="rescheduleDate">{t('newDateLabel')}</Label>
            <Input
              id="rescheduleDate"
              type="date"
              value={newDate}
              min={minDate}
              onChange={(e) => handleDateChange(e.target.value)}
              className={validationError ? 'border-destructive' : ''}
            />
            {validationError && (
              <p className="text-sm text-destructive">{validationError}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="rescheduleReason">{t('reasonLabel')}</Label>
            <textarea
              id="rescheduleReason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={rescheduleMutation.isPending}
          >
            {tCommon('cancel')}
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              rescheduleMutation.isPending ||
              !!validationError ||
              !newDate ||
              newDate === initialValue
            }
          >
            {rescheduleMutation.isPending ? tCommon('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
