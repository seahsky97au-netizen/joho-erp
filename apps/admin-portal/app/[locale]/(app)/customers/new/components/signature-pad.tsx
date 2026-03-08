'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import SignaturePad from 'signature_pad';
import { Button } from '@joho-erp/ui';

interface SignaturePadComponentProps {
  id: string;
  label: string;
  description?: string;
  onSignatureChange: (data: string | null) => void;
  disabled?: boolean;
  required?: boolean;
  error?: string;
}

export function SignaturePadComponent({
  id,
  label,
  description,
  onSignatureChange,
  disabled = false,
  required = false,
  error,
}: SignaturePadComponentProps) {
  const t = useTranslations('customerForm.signatures.signaturePad');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const signaturePadRef = useRef<SignaturePad | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;
    const signaturePad = new SignaturePad(canvas, {
      backgroundColor: 'rgb(255, 255, 255)',
      penColor: 'rgb(0, 0, 0)',
    });

    signaturePadRef.current = signaturePad;

    const resizeCanvas = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const container = canvas.parentElement;
      if (!container) return;

      const signatureData = signaturePad.isEmpty()
        ? null
        : signaturePad.toData();

      const width = container.clientWidth;
      const height = 150;

      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(ratio, ratio);
      }

      if (signatureData) {
        signaturePad.fromData(signatureData);
      } else {
        signaturePad.clear();
      }
    };

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    signaturePad.addEventListener('endStroke', () => {
      if (!signaturePad.isEmpty()) {
        const dataUrl = signaturePad.toDataURL('image/png');
        onSignatureChange(dataUrl);
      }
    });

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      signaturePad.off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (signaturePadRef.current) {
      if (disabled) {
        signaturePadRef.current.off();
      } else {
        signaturePadRef.current.on();
      }
    }
  }, [disabled]);

  const handleClear = useCallback(() => {
    if (signaturePadRef.current) {
      signaturePadRef.current.clear();
      onSignatureChange(null);
    }
  }, [onSignatureChange]);

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-gray-700">
        {label}
        {required && <span className="ml-1 text-red-500">*</span>}
      </label>
      {description && <p className="text-sm text-gray-500">{description}</p>}
      <div
        className={`relative rounded-lg border-2 ${
          error
            ? 'border-red-300 bg-red-50'
            : 'border-gray-300 bg-white'
        } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      >
        <canvas
          ref={canvasRef}
          id={id}
          className="w-full touch-none rounded-lg"
          aria-label={label}
        />
        {!disabled && (
          <div className="absolute bottom-2 right-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleClear}
              className="text-xs"
            >
              {t('clear')}
            </Button>
          </div>
        )}
        {!disabled && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="select-none text-sm text-gray-400">
              {t('tapToSign')}
            </span>
          </div>
        )}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
