'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import { api } from '@/trpc/client';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Input,
  Label,
  useToast,
} from '@joho-erp/ui';
import { Building2, Loader2, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { validateABN } from '@joho-erp/shared';
import { SettingsPageHeader } from '@/components/settings/settings-page-header';
import { FloatingSaveBar } from '@/components/settings/floating-save-bar';
import { AddressSearch, type AddressResult } from '@/components/address-search';

export default function CompanySettingsPage() {
  const t = useTranslations('settings.company');
  const tCommon = useTranslations('common');
  const tErrors = useTranslations('errors');
  const { toast } = useToast();
  const utils = api.useUtils();
  const [hasChanges, setHasChanges] = useState(false);

  // Form state
  const [businessName, setBusinessName] = useState('');
  const [abn, setAbn] = useState('');
  const [street, setStreet] = useState('');
  const [suburb, setSuburb] = useState('');
  const [state, setState] = useState('');
  const [postcode, setPostcode] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [mobile, setMobile] = useState('');
  const [bankName, setBankName] = useState('');
  const [accountName, setAccountName] = useState('');
  const [bsb, setBsb] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [logoUrl, setLogoUrl] = useState('');

  // Load data
  const { data: settings, isLoading } = api.company.getSettings.useQuery();

  // Save mutation
  const saveMutation = api.company.updateProfile.useMutation({
    onSuccess: (data) => {
      toast({
        title: t('settingsSaved'),
        description: data.message,
      });
      setHasChanges(false);
      void utils.company.getSettings.invalidate();
    },
    onError: (error) => {
      console.error('Operation error:', error.message);
      toast({
        title: t('saveError'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  // Load settings into form
  useEffect(() => {
    if (settings) {
      setBusinessName(settings.businessName || '');
      setAbn(settings.abn || '');
      setStreet(settings.address?.street || '');
      setSuburb(settings.address?.suburb || '');
      setState(settings.address?.state || '');
      setPostcode(settings.address?.postcode || '');
      setFirstName(settings.contactPerson?.firstName || '');
      setLastName(settings.contactPerson?.lastName || '');
      setEmail(settings.contactPerson?.email || '');
      setPhone(settings.contactPerson?.phone || '');
      setMobile(settings.contactPerson?.mobile || '');
      setBankName(settings.bankDetails?.bankName || '');
      setAccountName(settings.bankDetails?.accountName || '');
      setBsb(settings.bankDetails?.bsb || '');
      setAccountNumber(settings.bankDetails?.accountNumber || '');
      setLogoUrl(settings.logoUrl || '');
    }
  }, [settings]);

  // Handle address selection from AddressSearch component
  const handleAddressSelect = (result: AddressResult) => {
    setStreet(result.street);
    setSuburb(result.suburb);
    setState(result.state);
    setPostcode(result.postcode);
  };

  // Track changes
  useEffect(() => {
    if (settings === null) {
      // No company exists yet — enable save once user fills required fields
      setHasChanges(businessName.trim() !== '' || abn.trim() !== '');
    } else if (settings) {
      const modified =
        businessName !== (settings.businessName || '') ||
        abn !== (settings.abn || '') ||
        street !== (settings.address?.street || '') ||
        suburb !== (settings.address?.suburb || '') ||
        state !== (settings.address?.state || '') ||
        postcode !== (settings.address?.postcode || '') ||
        firstName !== (settings.contactPerson?.firstName || '') ||
        lastName !== (settings.contactPerson?.lastName || '') ||
        email !== (settings.contactPerson?.email || '') ||
        phone !== (settings.contactPerson?.phone || '') ||
        mobile !== (settings.contactPerson?.mobile || '') ||
        bankName !== (settings.bankDetails?.bankName || '') ||
        accountName !== (settings.bankDetails?.accountName || '') ||
        bsb !== (settings.bankDetails?.bsb || '') ||
        accountNumber !== (settings.bankDetails?.accountNumber || '');
      setHasChanges(modified);
    }
  }, [businessName, abn, street, suburb, state, postcode, firstName, lastName, email, phone, mobile, bankName, accountName, bsb, accountNumber, settings]);

  const handleSave = async () => {
    if (!validateABN(abn)) {
      toast({
        title: t('saveError'),
        description: t('validation.abnInvalid'),
        variant: 'destructive',
      });
      return;
    }
    await saveMutation.mutateAsync({
      businessName,
      abn,
      address: {
        street,
        suburb,
        state,
        postcode,
        country: 'Australia',
      },
      contactPerson: {
        firstName,
        lastName,
        email,
        phone,
        mobile: mobile || undefined,
      },
      bankDetails: bankName && accountName && bsb && accountNumber ? {
        bankName,
        accountName,
        bsb,
        accountNumber,
      } : undefined,
    });
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-12">
        <div className="flex flex-col items-center justify-center min-h-[400px]">
          <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
          <p className="text-muted-foreground font-medium">{t('loading')}</p>
        </div>
      </div>
    );
  }

  const handleCancel = () => {
    // Reset form to original values
    if (settings) {
      setBusinessName(settings.businessName || '');
      setAbn(settings.abn || '');
      setStreet(settings.address?.street || '');
      setSuburb(settings.address?.suburb || '');
      setState(settings.address?.state || '');
      setPostcode(settings.address?.postcode || '');
      setFirstName(settings.contactPerson?.firstName || '');
      setLastName(settings.contactPerson?.lastName || '');
      setEmail(settings.contactPerson?.email || '');
      setPhone(settings.contactPerson?.phone || '');
      setMobile(settings.contactPerson?.mobile || '');
      setBankName(settings.bankDetails?.bankName || '');
      setAccountName(settings.bankDetails?.accountName || '');
      setBsb(settings.bankDetails?.bsb || '');
      setAccountNumber(settings.bankDetails?.accountNumber || '');
    } else {
      setBusinessName('');
      setAbn('');
      setStreet('');
      setSuburb('');
      setState('');
      setPostcode('');
      setFirstName('');
      setLastName('');
      setEmail('');
      setPhone('');
      setMobile('');
      setBankName('');
      setAccountName('');
      setBsb('');
      setAccountNumber('');
    }
  };

  return (
    <div className="container mx-auto px-4 py-6 md:py-10">
      <SettingsPageHeader
        icon={Building2}
        titleKey="company.title"
        descriptionKey="company.subtitle"
      >
        <FloatingSaveBar
          onSave={handleSave}
          onCancel={handleCancel}
          isSaving={saveMutation.isPending}
          hasChanges={hasChanges}
          saveLabel={t('saveChanges')}
          savingLabel={t('saving')}
        />
      </SettingsPageHeader>

      {/* Content Cards */}
      <div className="space-y-6">
        {/* Business Information */}
        <Card className="animate-fade-in-up">
          <CardHeader>
            <CardTitle>{t('businessInfo.title')}</CardTitle>
            <CardDescription>{t('businessInfo.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="businessName">{t('fields.businessName')} *</Label>
                <Input
                  id="businessName"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  placeholder={t('fields.businessName')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="abn">{t('fields.abn')} *</Label>
                <Input
                  id="abn"
                  value={abn}
                  onChange={(e) => setAbn(e.target.value.replace(/\D/g, '').slice(0, 11))}
                  placeholder={t('fields.abn')}
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="firstName">{t('fields.contactFirstName')} *</Label>
                <Input
                  id="firstName"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder={t('fields.contactFirstName')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">{t('fields.contactLastName')} *</Label>
                <Input
                  id="lastName"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder={t('fields.contactLastName')}
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="email">{t('fields.email')} *</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('fields.email')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">{t('fields.phone')} *</Label>
                <Input
                  id="phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder={t('fields.phone')}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="mobile">{t('fields.mobile')}</Label>
              <Input
                id="mobile"
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                placeholder={t('fields.mobile')}
              />
            </div>
          </CardContent>
        </Card>

        {/* Company Address */}
        <Card className="animate-fade-in-up delay-100">
          <CardHeader>
            <CardTitle>{t('address.title')}</CardTitle>
            <CardDescription>{t('address.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <AddressSearch
              id="companyAddress"
              label={t('fields.street')}
              onAddressSelect={handleAddressSelect}
              defaultValues={{
                street,
                suburb,
                state,
                postcode,
              }}
            />
          </CardContent>
        </Card>

        {/* Bank Details */}
        <Card className="animate-fade-in-up delay-200">
          <CardHeader>
            <CardTitle>{t('bankDetails.title')}</CardTitle>
            <CardDescription>{t('bankDetails.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="bankName">{t('fields.bankName')}</Label>
                <Input
                  id="bankName"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  placeholder={t('fields.bankName')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="accountName">{t('fields.accountName')}</Label>
                <Input
                  id="accountName"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  placeholder={t('fields.accountName')}
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="bsb">{t('fields.bsb')}</Label>
                <Input
                  id="bsb"
                  value={bsb}
                  onChange={(e) => setBsb(e.target.value)}
                  placeholder={t('fields.bsb')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="accountNumber">{t('fields.accountNumber')}</Label>
                <Input
                  id="accountNumber"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  placeholder={t('fields.accountNumber')}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Branding */}
        <Card className="animate-fade-in-up delay-300">
          <CardHeader>
            <CardTitle>{t('branding.title')}</CardTitle>
            <CardDescription>{t('branding.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              {logoUrl && (
                <div className="w-24 h-24 border-2 border-border rounded-lg flex items-center justify-center overflow-hidden">
                  <Image
                    src={logoUrl}
                    alt={tCommon('aria.companyLogo')}
                    className="w-full h-full object-contain"
                    width={96}
                    height={96}
                    unoptimized
                  />
                </div>
              )}
              <div className="flex-1 space-y-2">
                <Label htmlFor="logoUrl">{t('fields.logoUrl')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="logoUrl"
                    value={logoUrl}
                    onChange={(e) => setLogoUrl(e.target.value)}
                    placeholder={t('fields.logoUrl')}
                  />
                  <Button variant="outline" size="icon">
                    <Upload className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('branding.uploadHint')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
