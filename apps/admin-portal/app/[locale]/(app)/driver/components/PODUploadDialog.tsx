'use client';

import { useState, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
  useToast,
} from '@joho-erp/ui';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { Loader2, Camera, Upload, X } from 'lucide-react';

interface Delivery {
  id: string;
  orderNumber: string;
  customerName: string;
}

interface PODUploadDialogProps {
  delivery: Delivery | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpload: (fileUrl: string, type: 'photo' | 'signature') => Promise<void>;
  isSubmitting?: boolean;
}

export function PODUploadDialog({
  delivery,
  open,
  onOpenChange,
  onUpload,
  isSubmitting = false,
}: PODUploadDialogProps) {
  const t = useTranslations('driver.podDialog');
  const tCommon = useTranslations('common');
  const tMessages = useTranslations('driver.messages');
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  if (!delivery) return null;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Create preview
    const reader = new FileReader();
    reader.onloadend = () => {
      setPreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleUpload = async () => {
    if (!preview) return;

    setUploading(true);
    try {
      // In a real implementation, you would upload the file to R2/S3 first
      // and get back a URL. For now, we'll use the data URL directly
      // or you can implement a proper upload endpoint.

      // For demonstration, we'll just pass the preview URL
      // In production, replace this with actual R2 upload
      await onUpload(preview, 'photo');
      toast({
        title: tMessages('podSuccess'),
      });
      setPreview(null);
      onOpenChange(false);
    } catch (error) {
      toast({
        title: tMessages('error'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setUploading(false);
    }
  };

  const handleClearPreview = () => {
    setPreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) {
      setPreview(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
    onOpenChange(isOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Order Info */}
          <div className="text-center">
            <p className="font-semibold">{delivery.orderNumber}</p>
            <p className="text-sm text-muted-foreground">{delivery.customerName}</p>
          </div>

          {/* Preview or Upload */}
          {preview ? (
            <div className="relative">
              <Image
                src={preview}
                alt={tCommon('aria.podPreview')}
                className="w-full rounded-lg border object-cover max-h-64"
                width={400}
                height={256}
                unoptimized
              />
              <Button
                variant="destructive"
                size="icon"
                className="absolute top-2 right-2"
                onClick={handleClearPreview}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleFileChange}
                className="hidden"
              />

              <Button
                variant="outline"
                className="w-full h-24 flex flex-col gap-2"
                onClick={() => fileInputRef.current?.click()}
              >
                <Camera className="h-8 w-8" />
                <span>{t('takePhoto')}</span>
              </Button>

              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  if (fileInputRef.current) {
                    fileInputRef.current.removeAttribute('capture');
                    fileInputRef.current.click();
                    fileInputRef.current.setAttribute('capture', 'environment');
                  }
                }}
              >
                <Upload className="h-4 w-4 mr-2" />
                {t('uploadFile')}
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)} disabled={isSubmitting || uploading}>
            {t('cancel')}
          </Button>
          <Button onClick={handleUpload} disabled={!preview || isSubmitting || uploading}>
            {(isSubmitting || uploading) && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {uploading ? t('uploading') : t('upload')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
