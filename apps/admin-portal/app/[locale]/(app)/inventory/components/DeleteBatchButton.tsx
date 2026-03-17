'use client';

import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  useToast,
} from '@joho-erp/ui';
import { Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { api } from '@/trpc/client';

interface DeleteBatchButtonProps {
  batchId: string;
  batchNumber: string;
  productName: string;
  initialQuantity: number;
  quantityRemaining: number;
  unit: string;
  onSuccess: () => void;
}

export function DeleteBatchButton({
  batchId,
  batchNumber,
  productName,
  initialQuantity,
  quantityRemaining,
  unit,
  onSuccess,
}: DeleteBatchButtonProps) {
  const t = useTranslations('inventory.stockReceivedHistory.deleteBatch');
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  // Only render if batch is fully unconsumed
  if (quantityRemaining !== initialQuantity) {
    return null;
  }

  const deleteMutation = api.inventory.deleteStockReceivedBatch.useMutation({
    onSuccess: () => {
      toast({ title: t('success') });
      setOpen(false);
      setReason('');
      onSuccess();
    },
    onError: (error) => {
      toast({
        title: t('error'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const handleDelete = () => {
    deleteMutation.mutate({ batchId, reason });
  };

  return (
    <>
      <div onClick={(e) => e.stopPropagation()}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          title={t('delete')}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <Dialog
        open={open}
        onOpenChange={(isOpen) => {
          setOpen(isOpen);
          if (!isOpen) setReason('');
        }}
      >
        <DialogContent
          className="sm:max-w-[400px]"
          onClick={(e) => e.stopPropagation()}
          onPointerDownOutside={(e) => e.stopPropagation()}
          onInteractOutside={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>
              {t('description', {
                quantity: initialQuantity.toFixed(1),
                unit,
                product: productName,
                batchNumber,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="deleteReason">{t('reason')}</Label>
              <Input
                id="deleteReason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('reasonPlaceholder')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                setReason('');
              }}
              disabled={deleteMutation.isPending}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteMutation.isPending || !reason.trim()}
            >
              {deleteMutation.isPending ? t('processing') : t('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
