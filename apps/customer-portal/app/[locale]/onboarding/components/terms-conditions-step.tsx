'use client';

import { useState, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Card, CardContent, Button, Checkbox, Label, useToast } from '@joho-erp/ui';
import { SignaturePadComponent } from './signature-pad';
import type { DirectorInfo, DirectorSignature } from '../page';

interface TermsConditionsStepProps {
  directors: DirectorInfo[];
  directorSignatures: DirectorSignature[];
  onSignaturesChange: (signatures: DirectorSignature[]) => void;
  onNext: () => void;
  onBack: () => void;
}

// Mirrors the shape of onboarding.termsConditions.* in the locale JSON.
// Update both together if a clause is added/removed.
const DEFINITIONS = ['applicant', 'conditions', 'supplier', 'goods'] as const;

type ClauseItem = string | { key: string; subItems: readonly string[] };
const CLAUSES: ReadonlyArray<{ num: string; items: readonly ClauseItem[] }> = [
  { num: '1', items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
  {
    num: '2',
    items: [
      'a',
      { key: 'b', subItems: ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix'] },
      { key: 'c', subItems: ['i', 'ii', 'iii', 'iv', 'v'] },
      'd',
      'e',
    ],
  },
  { num: '3', items: ['a', 'b'] },
  { num: '4', items: ['a', 'b', 'c', 'd'] },
  { num: '5', items: ['a', 'b', 'c', 'd', 'e'] },
  { num: '6', items: ['a'] },
  { num: '7', items: ['a', 'b', 'c'] },
  { num: '8', items: ['a'] },
  { num: '9', items: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'] },
  { num: '10', items: ['a'] },
  { num: '11', items: ['a'] },
];

const DECLARATION_ITEMS = ['1', '2', '3', '4', '5'] as const;

export function TermsConditionsStep({
  directors,
  directorSignatures,
  onSignaturesChange,
  onNext,
  onBack,
}: TermsConditionsStepProps) {
  const t = useTranslations('onboarding.termsConditions');
  const { toast } = useToast();
  const checkboxRef = useRef<HTMLInputElement>(null);
  const [agreed, setAgreed] = useState(false);
  const [errors, setErrors] = useState<Record<number, string>>({});

  // Initialize signatures for all directors if not already present
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
          applicantSignature: signature,
          applicantSignedAt: signature ? new Date() : null,
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
      if (!sig?.applicantSignature || sig.applicantSignature.length < 200) {
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

      {/* Terms Content */}
      <Card>
        <CardContent className="p-6">
          <div className="max-h-[500px] overflow-y-auto pr-2 space-y-6">
            {/* Intro Section */}
            <div className="rounded-lg bg-muted/50 p-4">
              <p className="text-sm font-medium leading-relaxed">{t('intro')}</p>
            </div>

            {/* Definitions */}
            <div className="space-y-2">
              <h3 className="text-lg font-semibold">{t('definitions.title')}</h3>
              <ul className="list-disc pl-6 space-y-1 text-sm">
                {DEFINITIONS.map((def) => (
                  <li key={def}>
                    <strong>{t(`definitions.${def}.term`)}</strong>{' '}
                    {t(`definitions.${def}.meaning`)}
                  </li>
                ))}
              </ul>
            </div>

            {/* Clauses */}
            {CLAUSES.map(({ num, items }) => (
              <div key={num} className="space-y-2">
                <h3 className="text-lg font-semibold">{t(`clauses.${num}.title`)}</h3>
                <ol className="list-[lower-alpha] pl-6 space-y-2 text-sm">
                  {items.map((it) => {
                    if (typeof it === 'string') {
                      return <li key={it}>{t(`clauses.${num}.${it}`)}</li>;
                    }
                    return (
                      <li key={it.key}>
                        {t(`clauses.${num}.${it.key}.intro`)}
                        <ol className="list-[lower-roman] pl-6 space-y-1 mt-1">
                          {it.subItems.map((sub) => (
                            <li key={sub}>{t(`clauses.${num}.${it.key}.${sub}`)}</li>
                          ))}
                        </ol>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}

            {/* Declaration Section */}
            <div className="rounded-lg bg-muted/50 p-4 space-y-3">
              <h3 className="text-lg font-semibold">{t('declaration.title')}</h3>
              <p className="text-sm">{t('declaration.intro')}</p>
              <ol className="list-decimal pl-6 space-y-2 text-sm">
                {DECLARATION_ITEMS.map((n) => (
                  <li key={n}>{t(`declaration.${n}`)}</li>
                ))}
              </ol>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Agreement Checkbox */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-start space-x-3">
            <Checkbox
              id="terms-conditions-agreement"
              ref={checkboxRef}
              checked={agreed}
              onCheckedChange={handleCheckboxChange}
              className="mt-1"
            />
            <div className="flex-1 space-y-1">
              <Label
                htmlFor="terms-conditions-agreement"
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

      {/* Director Signatures - Only shown when checkbox is checked */}
      {agreed && (
        <Card>
          <CardContent className="p-6">
            <h3 className="text-lg font-semibold mb-4">
              {t('directorSignatures.title', { defaultValue: 'Director Signatures' })}
            </h3>
            <p className="text-sm text-muted-foreground mb-6">
              {t('directorSignatures.description', { defaultValue: 'Each director must sign below to acknowledge agreement to the terms and conditions.' })}
            </p>
            <div className="space-y-6">
              {directors.map((director, index) => {
                const directorName = `${director.givenNames} ${director.familyName}`;
                const signature = directorSignatures.find(s => s.directorIndex === index);
                return (
                  <div key={index} className="border-b border-gray-200 pb-6 last:border-b-0 last:pb-0">
                    <div className="mb-3">
                      <h4 className="font-medium text-gray-900">
                        {t('directorSignatures.directorLabel', {
                          defaultValue: 'Director {number}: {name}',
                          number: index + 1,
                          name: directorName,
                        })}
                        {director.position && (
                          <span className="text-muted-foreground ml-2">({director.position})</span>
                        )}
                      </h4>
                    </div>
                    <SignaturePadComponent
                      id={`applicant-signature-${index}`}
                      label={t('directorSignatures.signatureLabel', { defaultValue: 'Signature' })}
                      onSignatureChange={(sig) => handleSignatureChange(index, sig)}
                      required
                      error={errors[index]}
                    />
                    {signature?.applicantSignature && (
                      <p className="mt-2 text-sm text-green-600">
                        {t('directorSignatures.signatureComplete', { defaultValue: 'Signature captured' })}
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
