'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Upload, X, FileText, Loader2 } from 'lucide-react';
import { cn } from '@joho-erp/ui';
import { Button, Label, useToast } from '@joho-erp/ui';

export type IdDocumentType = 'DRIVER_LICENSE' | 'PASSPORT';

export interface IdDocumentData {
  documentType: IdDocumentType;
  frontUrl: string | null;
  backUrl: string | null;
  uploadedAt: string | null;
}

interface IdentityDocumentUploadProps {
  directorIndex: number;
  value: IdDocumentData;
  onChange: (data: IdDocumentData) => void;
  error?: string;
}

const ACCEPTED_FILE_TYPES = 'image/jpeg,image/png,image/jpg,application/pdf';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

export function IdentityDocumentUpload({
  directorIndex,
  value,
  onChange,
  error,
}: IdentityDocumentUploadProps) {
  const t = useTranslations('customerForm.documents');
  const { toast } = useToast();
  const [uploadingFront, setUploadingFront] = React.useState(false);
  const [uploadingBack, setUploadingBack] = React.useState(false);
  const frontInputRef = React.useRef<HTMLInputElement>(null);
  const backInputRef = React.useRef<HTMLInputElement>(null);

  const handleDocumentTypeChange = (newType: IdDocumentType) => {
    onChange({
      documentType: newType,
      frontUrl: null,
      backUrl: null,
      uploadedAt: null,
    });
  };

  const uploadFile = async (
    file: File,
    side: 'front' | 'back'
  ): Promise<string | null> => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('customerId', 'new'); // Placeholder for new customers
    formData.append('directorIndex', directorIndex.toString());
    formData.append('documentType', value.documentType);
    formData.append('side', side);

    try {
      const response = await fetch('/api/upload/identity-document', {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || 'Upload failed');
      }

      return result.publicUrl;
    } catch (err) {
      console.error('Upload error:', err);
      toast({
        title: t('uploadError'),
        description: err instanceof Error ? err.message : t('uploadErrorGeneric'),
        variant: 'destructive',
      });
      return null;
    }
  };

  const handleFileSelect = async (
    e: React.ChangeEvent<HTMLInputElement>,
    side: 'front' | 'back'
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (!validTypes.includes(file.type)) {
      toast({
        title: t('invalidFileType'),
        description: t('allowedFileTypes'),
        variant: 'destructive',
      });
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      toast({
        title: t('fileTooLarge'),
        description: t('maxFileSize'),
        variant: 'destructive',
      });
      return;
    }

    if (side === 'front') {
      setUploadingFront(true);
    } else {
      setUploadingBack(true);
    }

    const url = await uploadFile(file, side);

    if (side === 'front') {
      setUploadingFront(false);
    } else {
      setUploadingBack(false);
    }

    if (url) {
      const now = new Date().toISOString();
      if (side === 'front') {
        onChange({ ...value, frontUrl: url, uploadedAt: now });
      } else {
        onChange({ ...value, backUrl: url, uploadedAt: now });
      }
    }

    e.target.value = '';
  };

  const handleRemove = (side: 'front' | 'back') => {
    if (side === 'front') {
      onChange({
        ...value,
        frontUrl: null,
        uploadedAt: value.backUrl ? value.uploadedAt : null,
      });
    } else {
      onChange({ ...value, backUrl: null });
    }
  };

  const isPdf = (url: string | null): boolean => {
    if (!url) return false;
    return url.toLowerCase().endsWith('.pdf');
  };

  const renderUploadBox = (
    side: 'front' | 'back',
    label: string,
    url: string | null,
    isUploading: boolean,
    inputRef: React.RefObject<HTMLInputElement | null>
  ) => {
    const hasFile = !!url;

    return (
      <div className="space-y-2">
        <Label className="text-sm font-medium">{label}</Label>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_FILE_TYPES}
          onChange={(e) => handleFileSelect(e, side)}
          className="hidden"
        />

        {isUploading ? (
          <div className="flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-lg p-6 bg-muted/50">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{t('uploading')}</p>
          </div>
        ) : hasFile ? (
          <div className="relative border rounded-lg overflow-hidden group">
            {isPdf(url) ? (
              <div className="flex flex-col items-center justify-center p-6 bg-muted">
                <FileText className="h-12 w-12 text-muted-foreground" />
                <p className="text-sm text-muted-foreground mt-2">PDF</p>
              </div>
            ) : (
              <img
                src={url}
                alt={label}
                className="w-full h-32 object-cover"
              />
            )}
            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => inputRef.current?.click()}
              >
                {t('replace')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => handleRemove(side)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ) : (
          <div
            onClick={() => inputRef.current?.click()}
            className={cn(
              'flex flex-col items-center justify-center gap-2',
              'border-2 border-dashed rounded-lg p-6',
              'cursor-pointer transition-colors',
              'hover:border-primary hover:bg-accent',
              error && 'border-destructive'
            )}
          >
            <Upload className="h-8 w-8 text-muted-foreground" />
            <div className="text-center">
              <p className="text-sm font-medium">{t('clickToUpload')}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('allowedFileTypes')}
              </p>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4 border rounded-lg p-4 bg-muted/20">
      <div>
        <Label className="text-base font-semibold">{t('title')}</Label>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">{t('selectType')}</Label>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name={`idType-${directorIndex}`}
              value="DRIVER_LICENSE"
              checked={value.documentType === 'DRIVER_LICENSE'}
              onChange={() => handleDocumentTypeChange('DRIVER_LICENSE')}
              className="h-4 w-4 text-primary focus:ring-primary"
            />
            <span className="text-sm">{t('driverLicense')}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name={`idType-${directorIndex}`}
              value="PASSPORT"
              checked={value.documentType === 'PASSPORT'}
              onChange={() => handleDocumentTypeChange('PASSPORT')}
              className="h-4 w-4 text-primary focus:ring-primary"
            />
            <span className="text-sm">{t('passport')}</span>
          </label>
        </div>
      </div>

      <div className={cn(
        'grid gap-4',
        value.documentType === 'DRIVER_LICENSE' ? 'md:grid-cols-2' : 'md:grid-cols-1'
      )}>
        {renderUploadBox(
          'front',
          value.documentType === 'DRIVER_LICENSE'
            ? t('licenseFront')
            : t('passportPhotoPage'),
          value.frontUrl,
          uploadingFront,
          frontInputRef
        )}

        {value.documentType === 'DRIVER_LICENSE' && (
          renderUploadBox(
            'back',
            t('licenseBack'),
            value.backUrl,
            uploadingBack,
            backInputRef
          )
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
