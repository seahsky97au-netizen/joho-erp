'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Input,
  Label,
  Badge,
  useToast,
} from '@joho-erp/ui';
import { ArrowLeft, Loader2, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { api } from '@/trpc/client';
import { parseToCents, validateABN, validateACN } from '@joho-erp/shared';
import type { PaymentMethod, AustralianState } from '@joho-erp/database';
import { AddressSearch, type AddressResult } from '@/components/address-search';

// Type definitions
type ContactInfo = {
  name: string;
  position: string;
  email: string;
  phone: string;
  mobile: string;
};

type AddressInfo = {
  street: string;
  suburb: string;
  state: AustralianState;
  postcode: string;
  country: string;
};

export default function NewSupplierPage() {
  const router = useRouter();
  const t = useTranslations('supplierForm');
  const tCommon = useTranslations('common');
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('business');

  const createSupplierMutation = api.supplier.create.useMutation({
    onSuccess: () => {
      toast({
        title: t('messages.createSuccess'),
        variant: 'default',
      });
      router.push('/suppliers');
    },
    onError: (error: { message?: string }) => {
      toast({
        title: tCommon('error'),
        description: error.message || t('messages.createError'),
        variant: 'destructive',
      });
    },
  });

  // Form state
  const [formData, setFormData] = useState({
    // Business Information
    supplierCode: '',
    businessName: '',
    tradingName: '',
    abn: '',
    acn: '',
    primaryCategories: [] as string[],
    newCategory: '',

    // Primary Contact
    primaryContact: {
      name: '',
      position: '',
      email: '',
      phone: '',
      mobile: '',
    } as ContactInfo,

    // Business Address
    businessAddress: {
      street: '',
      suburb: '',
      state: 'NSW' as AustralianState,
      postcode: '',
      country: 'Australia',
    } as AddressInfo,

    // Financial Terms
    paymentTerms: '',
    paymentMethod: 'account_credit' as PaymentMethod,
    creditLimit: '', // Store as string for input, convert to cents on submit
    minimumOrderValue: '',
    leadTimeDays: '',
    deliveryDays: '',
    deliveryNotes: '',
  });

  // Validation error states
  const [businessErrors, setBusinessErrors] = useState<Record<string, string>>({});
  const [contactErrors, setContactErrors] = useState<Record<string, string>>({});
  const [financialErrors, setFinancialErrors] = useState<Record<string, string>>({});

  // Clear individual field error helpers
  const clearBusinessError = (field: string) => {
    if (businessErrors[field]) {
      const newErrors = { ...businessErrors };
      delete newErrors[field];
      setBusinessErrors(newErrors);
    }
  };

  const clearContactError = (field: string) => {
    if (contactErrors[field]) {
      const newErrors = { ...contactErrors };
      delete newErrors[field];
      setContactErrors(newErrors);
    }
  };

  const clearFinancialError = (field: string) => {
    if (financialErrors[field]) {
      const newErrors = { ...financialErrors };
      delete newErrors[field];
      setFinancialErrors(newErrors);
    }
  };

  // Handle address selection from AddressSearch component
  const handleAddressSelect = (result: AddressResult) => {
    setFormData({
      ...formData,
      businessAddress: {
        street: result.street,
        suburb: result.suburb,
        state: result.state as AustralianState,
        postcode: result.postcode,
        country: 'Australia',
      },
    });
    // Clear any address-related errors
    clearContactError('street');
    clearContactError('suburb');
    clearContactError('postcode');
  };

  // Category management
  const handleAddCategory = () => {
    const category = formData.newCategory.trim();
    if (category && !formData.primaryCategories.includes(category)) {
      setFormData({
        ...formData,
        primaryCategories: [...formData.primaryCategories, category],
        newCategory: '',
      });
    }
  };

  const handleRemoveCategory = (category: string) => {
    setFormData({
      ...formData,
      primaryCategories: formData.primaryCategories.filter((c) => c !== category),
    });
  };

  // Validation functions
  const validateBusinessInfo = (): boolean => {
    const errors: Record<string, string> = {};
    let isValid = true;

    if (!formData.supplierCode?.trim()) {
      errors.supplierCode = t('validation.supplierCodeRequired');
      isValid = false;
    }

    if (!formData.businessName?.trim()) {
      errors.businessName = t('validation.businessNameRequired');
      isValid = false;
    }

    if (formData.abn && !validateABN(formData.abn)) {
      errors.abn = t('validation.abnInvalid');
      isValid = false;
    }

    if (formData.acn && !validateACN(formData.acn)) {
      errors.acn = t('validation.acnInvalid');
      isValid = false;
    }

    setBusinessErrors(errors);
    return isValid;
  };

  const validateContactInfo = (): boolean => {
    const errors: Record<string, string> = {};
    let isValid = true;

    if (!formData.primaryContact.name?.trim()) {
      errors.contactName = t('validation.contactNameRequired');
      isValid = false;
    }

    if (!formData.primaryContact.email?.trim()) {
      errors.contactEmail = t('validation.contactEmailRequired');
      isValid = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.primaryContact.email)) {
      errors.contactEmail = t('validation.contactEmailInvalid');
      isValid = false;
    }

    if (!formData.primaryContact.phone?.trim()) {
      errors.contactPhone = t('validation.contactPhoneRequired');
      isValid = false;
    }

    // Business Address validation
    if (!formData.businessAddress.street?.trim()) {
      errors.street = t('validation.streetRequired');
      isValid = false;
    }

    if (!formData.businessAddress.suburb?.trim()) {
      errors.suburb = t('validation.suburbRequired');
      isValid = false;
    }

    if (!formData.businessAddress.postcode?.trim()) {
      errors.postcode = t('validation.postcodeRequired');
      isValid = false;
    } else if (!/^\d{4}$/.test(formData.businessAddress.postcode)) {
      errors.postcode = t('validation.postcodeInvalid');
      isValid = false;
    }

    setContactErrors(errors);
    return isValid;
  };

  const validateFinancialInfo = (): boolean => {
    const errors: Record<string, string> = {};
    let isValid = true;

    // Credit limit validation (optional but if provided must be valid)
    if (formData.creditLimit) {
      const cents = parseToCents(formData.creditLimit);
      if (cents === null || cents < 0) {
        errors.creditLimit = t('validation.creditLimitInvalid');
        isValid = false;
      }
    }

    // Minimum order value validation (optional)
    if (formData.minimumOrderValue) {
      const cents = parseToCents(formData.minimumOrderValue);
      if (cents === null || cents < 0) {
        errors.minimumOrderValue = t('validation.creditLimitInvalid');
        isValid = false;
      }
    }

    setFinancialErrors(errors);
    return isValid;
  };

  const validateForm = (): boolean => {
    const businessValid = validateBusinessInfo();
    const contactValid = validateContactInfo();
    const financialValid = validateFinancialInfo();

    // Navigate to first tab with errors
    if (!businessValid) {
      setActiveTab('business');
    } else if (!contactValid) {
      setActiveTab('contact');
    } else if (!financialValid) {
      setActiveTab('financial');
    }

    return businessValid && contactValid && financialValid;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Prevent double submission
    if (isSubmitting) return;

    if (!validateForm()) {
      toast({
        title: tCommon('validationError'),
        description: t('messages.fixValidationErrors'),
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);

    try {
      await createSupplierMutation.mutateAsync({
        supplierCode: formData.supplierCode,
        businessName: formData.businessName,
        tradingName: formData.tradingName || undefined,
        abn: formData.abn || undefined,
        acn: formData.acn || undefined,
        primaryContact: formData.primaryContact,
        businessAddress: formData.businessAddress,
        paymentTerms: formData.paymentTerms || undefined,
        paymentMethod: formData.paymentMethod,
        creditLimit: parseToCents(formData.creditLimit) || 0,
        minimumOrderValue: formData.minimumOrderValue
          ? parseToCents(formData.minimumOrderValue) || undefined
          : undefined,
        leadTimeDays: formData.leadTimeDays ? parseInt(formData.leadTimeDays, 10) : undefined,
        deliveryDays: formData.deliveryDays || undefined,
        deliveryNotes: formData.deliveryNotes || undefined,
        primaryCategories: formData.primaryCategories,
      });
    } catch (error) {
      console.error('Error creating supplier:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Check if tab has errors
  const tabHasErrors = (tab: string): boolean => {
    switch (tab) {
      case 'business':
        return Object.keys(businessErrors).length > 0;
      case 'contact':
        return Object.keys(contactErrors).length > 0;
      case 'financial':
        return Object.keys(financialErrors).length > 0;
      default:
        return false;
    }
  };

  return (
    <div className="container mx-auto px-4 py-6 md:py-10">
      <div className="mb-6">
        <Link href="/suppliers">
          <Button variant="ghost" size="sm" className="mb-4">
            <ArrowLeft className="mr-2 h-4 w-4" />
            {tCommon('back')}
          </Button>
        </Link>
        <h1 className="text-2xl md:text-4xl font-bold">{t('title.create')}</h1>
        <p className="text-sm md:text-base text-muted-foreground mt-1 md:mt-2">
          {t('description')}
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        {/* Custom Tab Navigation */}
        <div className="mb-6">
          <div className="flex flex-wrap gap-2 border-b">
            {[
              { value: 'business', label: t('tabs.business') },
              { value: 'contact', label: t('tabs.contact') },
              { value: 'financial', label: t('tabs.financial') },
            ].map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => setActiveTab(tab.value)}
                className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  activeTab === tab.value
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                } ${tabHasErrors(tab.value) ? 'text-destructive' : ''}`}
              >
                {tab.label}
                {tabHasErrors(tab.value) && <span className="ml-1 text-destructive">*</span>}
              </button>
            ))}
          </div>
        </div>

        {/* Business Information Tab */}
        {activeTab === 'business' && (
          <div className="mt-6 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('tabs.business')}</CardTitle>
                <CardDescription>{t('description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="supplierCode">{t('fields.supplierCode')} *</Label>
                    <Input
                      id="supplierCode"
                      placeholder={t('fields.supplierCodePlaceholder')}
                      required
                      value={formData.supplierCode}
                      onChange={(e) => {
                        setFormData({
                          ...formData,
                          supplierCode: e.target.value.toUpperCase(),
                        });
                        clearBusinessError('supplierCode');
                      }}
                    />
                    {businessErrors.supplierCode && (
                      <p className="text-sm text-destructive">{businessErrors.supplierCode}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="businessName">{t('fields.businessName')} *</Label>
                    <Input
                      id="businessName"
                      placeholder={t('fields.businessNamePlaceholder')}
                      required
                      value={formData.businessName}
                      onChange={(e) => {
                        setFormData({ ...formData, businessName: e.target.value });
                        clearBusinessError('businessName');
                      }}
                    />
                    {businessErrors.businessName && (
                      <p className="text-sm text-destructive">{businessErrors.businessName}</p>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="tradingName">{t('fields.tradingName')}</Label>
                  <Input
                    id="tradingName"
                    placeholder={t('fields.tradingNamePlaceholder')}
                    value={formData.tradingName}
                    onChange={(e) => setFormData({ ...formData, tradingName: e.target.value })}
                  />
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="abn">{t('fields.abn')}</Label>
                    <Input
                      id="abn"
                      placeholder={t('fields.abnPlaceholder')}
                      value={formData.abn}
                      onChange={(e) => {
                        setFormData({ ...formData, abn: e.target.value.replace(/\D/g, '').slice(0, 11) });
                        clearBusinessError('abn');
                      }}
                    />
                    {businessErrors.abn && (
                      <p className="text-sm text-destructive">{businessErrors.abn}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="acn">{t('fields.acn')}</Label>
                    <Input
                      id="acn"
                      placeholder={t('fields.acnPlaceholder')}
                      maxLength={9}
                      value={formData.acn}
                      onChange={(e) => {
                        setFormData({ ...formData, acn: e.target.value.replace(/\D/g, '') });
                        clearBusinessError('acn');
                      }}
                    />
                    {businessErrors.acn && (
                      <p className="text-sm text-destructive">{businessErrors.acn}</p>
                    )}
                  </div>
                </div>

                {/* Product Categories */}
                <div className="space-y-2">
                  <Label>{t('fields.primaryCategories')}</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder={t('fields.primaryCategoriesPlaceholder')}
                      value={formData.newCategory}
                      onChange={(e) => setFormData({ ...formData, newCategory: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddCategory();
                        }
                      }}
                    />
                    <Button type="button" onClick={handleAddCategory} variant="outline">
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  {formData.primaryCategories.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {formData.primaryCategories.map((category) => (
                        <Badge key={category} variant="secondary" className="flex items-center gap-1">
                          {category}
                          <button
                            type="button"
                            onClick={() => handleRemoveCategory(category)}
                            className="ml-1 hover:text-destructive"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Contact & Address Tab */}
        {activeTab === 'contact' && (
          <div className="mt-6 space-y-6">
            {/* Primary Contact */}
            <Card>
              <CardHeader>
                <CardTitle>{t('sections.primaryContact')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="contactName">{t('fields.contactName')} *</Label>
                    <Input
                      id="contactName"
                      placeholder={t('fields.contactNamePlaceholder')}
                      required
                      value={formData.primaryContact.name}
                      onChange={(e) => {
                        setFormData({
                          ...formData,
                          primaryContact: { ...formData.primaryContact, name: e.target.value },
                        });
                        clearContactError('contactName');
                      }}
                    />
                    {contactErrors.contactName && (
                      <p className="text-sm text-destructive">{contactErrors.contactName}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="contactPosition">{t('fields.contactPosition')}</Label>
                    <Input
                      id="contactPosition"
                      placeholder={t('fields.contactPositionPlaceholder')}
                      value={formData.primaryContact.position}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          primaryContact: { ...formData.primaryContact, position: e.target.value },
                        })
                      }
                    />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="contactEmail">{t('fields.contactEmail')} *</Label>
                    <Input
                      id="contactEmail"
                      type="email"
                      placeholder={t('fields.contactEmailPlaceholder')}
                      required
                      value={formData.primaryContact.email}
                      onChange={(e) => {
                        setFormData({
                          ...formData,
                          primaryContact: { ...formData.primaryContact, email: e.target.value },
                        });
                        clearContactError('contactEmail');
                      }}
                    />
                    {contactErrors.contactEmail && (
                      <p className="text-sm text-destructive">{contactErrors.contactEmail}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="contactPhone">{t('fields.contactPhone')} *</Label>
                    <Input
                      id="contactPhone"
                      placeholder={t('fields.contactPhonePlaceholder')}
                      required
                      value={formData.primaryContact.phone}
                      onChange={(e) => {
                        setFormData({
                          ...formData,
                          primaryContact: { ...formData.primaryContact, phone: e.target.value },
                        });
                        clearContactError('contactPhone');
                      }}
                    />
                    {contactErrors.contactPhone && (
                      <p className="text-sm text-destructive">{contactErrors.contactPhone}</p>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="contactMobile">{t('fields.contactMobile')}</Label>
                  <Input
                    id="contactMobile"
                    placeholder={t('fields.contactMobilePlaceholder')}
                    value={formData.primaryContact.mobile}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        primaryContact: { ...formData.primaryContact, mobile: e.target.value },
                      })
                    }
                  />
                </div>
              </CardContent>
            </Card>

            {/* Business Address */}
            <Card>
              <CardHeader>
                <CardTitle>{t('sections.businessAddress')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <AddressSearch
                  id="supplierBusinessAddress"
                  label={t('fields.street')}
                  onAddressSelect={handleAddressSelect}
                  defaultValues={{
                    street: formData.businessAddress.street,
                    suburb: formData.businessAddress.suburb,
                    state: formData.businessAddress.state,
                    postcode: formData.businessAddress.postcode,
                  }}
                />
                {(contactErrors.street || contactErrors.suburb || contactErrors.postcode) && (
                  <p className="text-sm text-destructive">
                    {contactErrors.street || contactErrors.suburb || contactErrors.postcode}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Financial Terms Tab */}
        {activeTab === 'financial' && (
          <div className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('tabs.financial')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="creditLimit">{t('fields.creditLimit')}</Label>
                    <Input
                      id="creditLimit"
                      type="text"
                      inputMode="decimal"
                      placeholder={t('fields.creditLimitPlaceholder')}
                      value={formData.creditLimit}
                      onChange={(e) => {
                        setFormData({ ...formData, creditLimit: e.target.value });
                        clearFinancialError('creditLimit');
                      }}
                    />
                    <p className="text-xs text-muted-foreground">{t('hints.enterDollars')}</p>
                    {financialErrors.creditLimit && (
                      <p className="text-sm text-destructive">{financialErrors.creditLimit}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="paymentTerms">{t('fields.paymentTerms')}</Label>
                    <Input
                      id="paymentTerms"
                      placeholder={t('fields.paymentTermsPlaceholder')}
                      value={formData.paymentTerms}
                      onChange={(e) => setFormData({ ...formData, paymentTerms: e.target.value })}
                    />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="paymentMethod">{t('fields.paymentMethod')}</Label>
                    <select
                      id="paymentMethod"
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={formData.paymentMethod}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          paymentMethod: e.target.value as PaymentMethod,
                        })
                      }
                    >
                      <option value="bank_transfer">Bank Transfer</option>
                      <option value="credit_card">Credit Card</option>
                      <option value="cheque">Cheque</option>
                      <option value="cash_on_delivery">Cash on Delivery</option>
                      <option value="account_credit">Account Credit</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="minimumOrderValue">{t('fields.minimumOrderValue')}</Label>
                    <Input
                      id="minimumOrderValue"
                      type="text"
                      inputMode="decimal"
                      placeholder={t('fields.minimumOrderValuePlaceholder')}
                      value={formData.minimumOrderValue}
                      onChange={(e) => {
                        setFormData({ ...formData, minimumOrderValue: e.target.value });
                        clearFinancialError('minimumOrderValue');
                      }}
                    />
                    <p className="text-xs text-muted-foreground">{t('hints.enterDollars')}</p>
                    {financialErrors.minimumOrderValue && (
                      <p className="text-sm text-destructive">{financialErrors.minimumOrderValue}</p>
                    )}
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="leadTimeDays">{t('fields.leadTimeDays')}</Label>
                    <Input
                      id="leadTimeDays"
                      type="number"
                      min="0"
                      placeholder={t('fields.leadTimeDaysPlaceholder')}
                      value={formData.leadTimeDays}
                      onChange={(e) => setFormData({ ...formData, leadTimeDays: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="deliveryDays">{t('fields.deliveryDays')}</Label>
                    <Input
                      id="deliveryDays"
                      placeholder={t('fields.deliveryDaysPlaceholder')}
                      value={formData.deliveryDays}
                      onChange={(e) => setFormData({ ...formData, deliveryDays: e.target.value })}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Error Message */}
        {createSupplierMutation.error && (
          <div className="mt-6 rounded-lg bg-destructive/10 p-4 text-destructive">
            <p className="text-sm font-medium">{t('messages.createError')}</p>
            <p className="text-sm">{createSupplierMutation.error.message}</p>
          </div>
        )}

        {/* Actions */}
        <div className="mt-6 flex justify-end gap-4">
          <Link href="/suppliers">
            <Button type="button" variant="outline" disabled={isSubmitting}>
              {t('buttons.cancel')}
            </Button>
          </Link>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isSubmitting ? t('buttons.creating') : t('buttons.createSupplier')}
          </Button>
        </div>
      </form>
    </div>
  );
}
