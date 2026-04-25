'use client';

import { useState, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card, CardContent, Checkbox, Label, useToast } from '@joho-erp/ui';
import { SignaturePadComponent } from './signature-pad';
import type { DirectorInfo, DirectorSignature } from '../page';

interface GuaranteeIndemnityStepProps {
  businessName: string;
  directors: DirectorInfo[];
  directorSignatures: DirectorSignature[];
  onSignaturesChange: (signatures: DirectorSignature[]) => void;
  onNext: () => void;
  onBack: () => void;
}

// Mirrors onboarding.guaranteeIndemnity.* in the locale JSON.
// Each clause is either: a single-paragraph clause (key = 'content'),
// or a list clause (intro + lower-alpha items), or a definitions clause.
type ClauseShape =
  | { kind: 'paragraph' }
  | { kind: 'list'; items: readonly string[] }
  | { kind: 'definitions'; terms: readonly string[] };

const RECITALS = ['a', 'b'] as const;

const GI_CLAUSES: ReadonlyArray<{ num: string; shape: ClauseShape }> = [
  { num: '1', shape: { kind: 'list', items: ['a', 'b', 'c'] } },
  { num: '2', shape: { kind: 'paragraph' } },
  { num: '3', shape: { kind: 'list', items: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] } },
  { num: '4', shape: { kind: 'paragraph' } },
  { num: '5', shape: { kind: 'list', items: ['a', 'b', 'c'] } },
  { num: '6', shape: { kind: 'paragraph' } },
  { num: '7', shape: { kind: 'paragraph' } },
  { num: '8', shape: { kind: 'paragraph' } },
  { num: '9', shape: { kind: 'paragraph' } },
  { num: '10', shape: { kind: 'paragraph' } },
  { num: '11', shape: { kind: 'definitions', terms: ['supplier', 'applicant', 'guarantors'] } },
];

export function GuaranteeIndemnityStep({
  businessName,
  directors,
  directorSignatures,
  onSignaturesChange,
  onNext,
  onBack,
}: GuaranteeIndemnityStepProps) {
  const t = useTranslations('onboarding.guaranteeIndemnity');
  const { toast } = useToast();
  const checkboxRef = useRef<HTMLInputElement>(null);
  const [agreed, setAgreed] = useState(false);
  const [errors, setErrors] = useState<Record<number, string>>({});

  // Ensure signatures exist for all directors
  const ensureDirectorSignatures = useCallback(() => {
    if (directorSignatures.length !== directors.length) {
      const newSignatures = directors.map((_, index) => {
        const existing = directorSignatures.find(s => s.directorIndex === index);
        return existing || {
          directorIndex: index,
          applicantSignature: null,
          applicantSignedAt: null,
          guarantorSignature: null,
          guarantorSignedAt: null,
        };
      });
      onSignaturesChange(newSignatures);
      return newSignatures;
    }
    return directorSignatures;
  }, [directors, directorSignatures, onSignaturesChange]);

  const handleCheckboxChange = (checked: boolean) => {
    setAgreed(checked);
    if (checked) {
      ensureDirectorSignatures();
    }
  };

  const handleSignatureChange = (directorIndex: number, signature: string | null) => {
    const updatedSignatures = ensureDirectorSignatures().map(sig => {
      if (sig.directorIndex === directorIndex) {
        return {
          ...sig,
          guarantorSignature: signature,
          guarantorSignedAt: signature ? new Date() : null,
        };
      }
      return sig;
    });
    onSignaturesChange(updatedSignatures);
    // Clear error for this director
    setErrors(prev => ({ ...prev, [directorIndex]: '' }));
  };

  const validateSignatures = (): boolean => {
    if (!agreed) {
      toast({
        title: t('validation.mustAgree'),
        variant: 'destructive',
      });
      checkboxRef.current?.focus();
      return false;
    }

    const sigs = ensureDirectorSignatures();
    const newErrors: Record<number, string> = {};
    let isValid = true;

    directors.forEach((_, index) => {
      const sig = sigs.find(s => s.directorIndex === index);
      if (!sig?.guarantorSignature || sig.guarantorSignature.length < 200) {
        newErrors[index] = t('validation.signatureRequired', { defaultValue: 'Signature is required' });
        isValid = false;
      }
    });

    setErrors(newErrors);
    return isValid;
  };

  const handleNext = () => {
    if (validateSignatures()) {
      onNext();
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold">{t('title')}</h2>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      {/* Guarantee Content */}
      <Card>
        <CardContent className="p-6">
          <div className="max-h-[500px] overflow-y-auto pr-2 space-y-6">
            {/* Header Section */}
            <div className="rounded-lg bg-muted/50 p-4">
              <p className="text-sm font-medium leading-relaxed">{t('header')}</p>
            </div>

            {/* Recitals */}
            <div className="space-y-3">
              <h3 className="text-lg font-semibold">{t('recitals.title')}</h3>
              <div className="space-y-2 text-sm">
                {RECITALS.map((letter) => (
                  <p key={letter}>
                    <strong>{letter.toUpperCase()}.</strong>{' '}
                    {t(`recitals.${letter}`, {
                      businessName: businessName || '[Business Name]',
                    })}
                  </p>
                ))}
              </div>
            </div>

            {/* Operative Part */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">{t('operativePart.title')}</h3>

              {GI_CLAUSES.map(({ num, shape }) => (
                <div key={num} className="space-y-2">
                  <h4 className="font-semibold">{t(`clauses.${num}.title`)}</h4>
                  {shape.kind === 'paragraph' && (
                    <p className="text-sm">{t(`clauses.${num}.content`)}</p>
                  )}
                  {shape.kind === 'list' && (
                    <>
                      <p className="text-sm">{t(`clauses.${num}.intro`)}</p>
                      <ol className="list-[lower-alpha] pl-6 space-y-1 text-sm">
                        {shape.items.map((it) => (
                          <li key={it}>{t(`clauses.${num}.${it}`)}</li>
                        ))}
                      </ol>
                    </>
                  )}
                  {shape.kind === 'definitions' && (
                    <ul className="list-disc pl-6 space-y-1 text-sm">
                      {shape.terms.map((term) => (
                        <li key={term}>
                          <strong>{t(`clauses.${num}.${term}.term`)}</strong>{' '}
                          {t(`clauses.${num}.${term}.meaning`)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Agreement Checkbox */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-start space-x-3">
            <Checkbox
              id="guarantee-indemnity-agreement"
              ref={checkboxRef}
              checked={agreed}
              onCheckedChange={handleCheckboxChange}
              className="mt-1"
            />
            <div className="flex-1 space-y-1">
              <Label
                htmlFor="guarantee-indemnity-agreement"
                className="text-sm font-medium leading-relaxed cursor-pointer"
              >
                {t('agreement.label')}
                <span className="ml-1 text-destructive" aria-label={t('agreement.required')}>
                  *
                </span>
              </Label>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Director/Guarantor Signatures - Only shown when checkbox is checked */}
      {agreed && (
        <Card>
          <CardContent className="p-6">
            <h3 className="text-lg font-semibold mb-4">
              {t('guarantorSignatures.title', { defaultValue: 'Guarantor Signatures' })}
            </h3>
            <p className="text-sm text-muted-foreground mb-6">
              {t('guarantorSignatures.description', { defaultValue: 'Each director/guarantor must sign below to acknowledge the guarantee and indemnity.' })}
            </p>
            <div className="space-y-6">
              {directors.map((director, index) => {
                const directorName = `${director.givenNames} ${director.familyName}`;
                const signature = directorSignatures.find(s => s.directorIndex === index);
                return (
                  <div key={index} className="border-b border-gray-200 pb-6 last:border-b-0 last:pb-0">
                    <div className="mb-3">
                      <h4 className="font-medium text-gray-900">
                        {t('guarantorSignatures.guarantorLabel', {
                          defaultValue: 'Guarantor {number}: {name}',
                          number: index + 1,
                          name: directorName,
                        })}
                        {director.position && (
                          <span className="text-muted-foreground ml-2">({director.position})</span>
                        )}
                      </h4>
                    </div>
                    <SignaturePadComponent
                      id={`guarantor-signature-${index}`}
                      label={t('guarantorSignatures.signatureLabel', { defaultValue: 'Signature' })}
                      onSignatureChange={(sig) => handleSignatureChange(index, sig)}
                      required
                      error={errors[index]}
                    />
                    {signature?.guarantorSignature && (
                      <p className="mt-2 text-sm text-green-600">
                        {t('guarantorSignatures.signatureComplete', { defaultValue: 'Signature captured' })}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Navigation Buttons */}
      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          {t('buttons.back')}
        </Button>
        <Button onClick={handleNext}>
          {t('buttons.next')}
        </Button>
      </div>
    </div>
  );
}
