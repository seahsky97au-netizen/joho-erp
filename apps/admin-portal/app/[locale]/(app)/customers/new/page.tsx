'use client';

import { useState, useEffect } from 'react';
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
  AreaBadge,
  useToast,
} from '@joho-erp/ui';
import { ArrowLeft, Loader2, Plus, X, MapPin } from 'lucide-react';
import Link from 'next/link';
import { api } from '@/trpc/client';
import { parseToCents, validateABN, validateACN, validateAustralianPhone, formatCentsForWholeInput } from '@joho-erp/shared';
import { AddressSearch, type AddressResult } from '@/components/address-search';
import { SignaturePadComponent } from './components/signature-pad';
import {
  IdentityDocumentUpload,
  type IdDocumentData,
} from './components/identity-document-upload';

// Type definitions
type SignatureInfo = {
  directorIndex: number;
  applicantSignatureData: string | null;
  guarantorSignatureData: string | null;
  witnessName: string;
  witnessSignatureData: string | null;
};

type DirectorInfo = {
  familyName: string;
  givenNames: string;
  residentialAddress: {
    street: string;
    suburb: string;
    state: string;
    postcode: string;
  };
  dateOfBirth: string;
  driverLicenseNumber: string;
  licenseState: 'NSW' | 'VIC' | 'QLD' | 'SA' | 'WA' | 'TAS' | 'NT' | 'ACT';
  licenseExpiry: string;
  position?: string;
};

type TradeReferenceInfo = {
  companyName: string;
  contactPerson: string;
  phone: string;
  email: string;
};

export default function NewCustomerPage() {
  const router = useRouter();
  const t = useTranslations('customerForm');
  const tCommon = useTranslations('common');
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('business');

  const createCustomerMutation = api.customer.createCustomer.useMutation({
    onSuccess: () => {
      toast({
        title: t('messages.createSuccess'),
        variant: 'default',
      });
      router.push('/customers');
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
    accountType: 'company' as 'sole_trader' | 'partnership' | 'company' | 'other',
    businessName: '',
    tradingName: '',
    abn: '',
    acn: '',
    contactPerson: {
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      mobile: '',
    },
    deliveryAddress: {
      street: '',
      suburb: '',
      state: 'NSW',
      postcode: '',
      areaId: undefined as string | undefined, // Dynamic area ID from API
      deliveryInstructions: '',
    },
    billingAddress: {
      street: '',
      suburb: '',
      state: 'NSW',
      postcode: '',
    },
    postalAddress: {
      street: '',
      suburb: '',
      state: 'NSW',
      postcode: '',
    },
    requestedCreditLimit: undefined as number | undefined,
    forecastPurchase: undefined as number | undefined,
    creditLimit: 0,
    paymentTerms: '',
    notes: '',
    directors: [] as DirectorInfo[],
    financialDetails: {
      bankName: '',
      accountName: '',
      bsb: '',
      accountNumber: '',
    },
    tradeReferences: [] as TradeReferenceInfo[],
  });

  // Signature state per director
  const [signatures, setSignatures] = useState<SignatureInfo[]>([]);

  // Identity document state per director
  const [idDocuments, setIdDocuments] = useState<IdDocumentData[]>([]);

  const [sameAsDelivery, setSameAsDelivery] = useState(true);
  const [postalSameAsBilling, setPostalSameAsBilling] = useState(true);
  const [includeFinancial, setIncludeFinancial] = useState(false);

  // Validation error states
  const [businessErrors, setBusinessErrors] = useState<Record<string, string>>({});
  const [contactErrors, setContactErrors] = useState<Record<string, string>>({});
  const [addressErrors, setAddressErrors] = useState<Record<string, string>>({});
  const [creditErrors, setCreditErrors] = useState<Record<string, string>>({});
  const [financialErrors, setFinancialErrors] = useState<Record<string, string>>({});
  const [directorErrors, setDirectorErrors] = useState<Record<number, Record<string, string>>>({});
  const [tradeRefErrors, setTradeRefErrors] = useState<Record<number, Record<string, string>>>({});

  // Clear individual field error
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

  const clearAddressError = (field: string) => {
    if (addressErrors[field]) {
      const newErrors = { ...addressErrors };
      delete newErrors[field];
      setAddressErrors(newErrors);
    }
  };

  const clearCreditError = (field: string) => {
    if (creditErrors[field]) {
      const newErrors = { ...creditErrors };
      delete newErrors[field];
      setCreditErrors(newErrors);
    }
  };

  const clearFinancialError = (field: string) => {
    if (financialErrors[field]) {
      const newErrors = { ...financialErrors };
      delete newErrors[field];
      setFinancialErrors(newErrors);
    }
  };

  const clearDirectorError = (index: number, field: string) => {
    if (directorErrors[index]?.[field]) {
      const newErrors = { ...directorErrors };
      const newDirectorErrors = { ...newErrors[index] };
      delete newDirectorErrors[field];
      if (Object.keys(newDirectorErrors).length === 0) {
        delete newErrors[index];
      } else {
        newErrors[index] = newDirectorErrors;
      }
      setDirectorErrors(newErrors);
    }
  };

  const clearTradeRefError = (index: number, field: string) => {
    if (tradeRefErrors[index]?.[field]) {
      const newErrors = { ...tradeRefErrors };
      const newRefErrors = { ...newErrors[index] };
      delete newRefErrors[field];
      if (Object.keys(newRefErrors).length === 0) {
        delete newErrors[index];
      } else {
        newErrors[index] = newRefErrors;
      }
      setTradeRefErrors(newErrors);
    }
  };

  // Fetch areas dynamically
  const { data: areas } = api.area.list.useQuery();

  // Auto-lookup area by suburb
  const { data: autoArea, isLoading: isLookingUpArea } = api.area.lookupBySuburb.useQuery(
    {
      suburb: formData.deliveryAddress.suburb,
      state: formData.deliveryAddress.state,
      postcode: formData.deliveryAddress.postcode,
    },
    {
      enabled:
        !!formData.deliveryAddress.suburb &&
        formData.deliveryAddress.suburb.length > 2 &&
        !formData.deliveryAddress.areaId, // Only lookup if no manual selection
    }
  );

  // Auto-select area when lookup returns a result
  useEffect(() => {
    if (autoArea && !formData.deliveryAddress.areaId) {
      setFormData((prev) => ({
        ...prev,
        deliveryAddress: {
          ...prev.deliveryAddress,
          areaId: autoArea.id,
        },
      }));
    }
  }, [autoArea, formData.deliveryAddress.areaId]);

  // Helper functions for directors
  const addDirector = () => {
    const newIndex = formData.directors.length;
    setFormData({
      ...formData,
      directors: [
        ...formData.directors,
        {
          familyName: '',
          givenNames: '',
          residentialAddress: { street: '', suburb: '', state: 'NSW', postcode: '' },
          dateOfBirth: '',
          driverLicenseNumber: '',
          licenseState: 'NSW',
          licenseExpiry: '',
          position: '',
        },
      ],
    });
    setSignatures((prev) => [
      ...prev,
      {
        directorIndex: newIndex,
        applicantSignatureData: null,
        guarantorSignatureData: null,
        witnessName: '',
        witnessSignatureData: null,
      },
    ]);
    setIdDocuments((prev) => [
      ...prev,
      {
        documentType: 'DRIVER_LICENSE',
        frontUrl: null,
        backUrl: null,
        uploadedAt: null,
      },
    ]);
  };

  const removeDirector = (index: number) => {
    setFormData({
      ...formData,
      directors: formData.directors.filter((_, i) => i !== index),
    });
    setSignatures((prev) => prev.filter((_, i) => i !== index));
    setIdDocuments((prev) => prev.filter((_, i) => i !== index));
  };

  const updateDirector = (index: number, field: string, value: string) => {
    const updated = [...formData.directors];
    if (field.includes('.')) {
      const [parent, child] = field.split('.');
      if (parent === 'residentialAddress') {
        updated[index] = {
          ...updated[index],
          residentialAddress: { ...updated[index].residentialAddress, [child]: value },
        };
      }
    } else {
      updated[index] = { ...updated[index], [field]: value };
    }
    setFormData({ ...formData, directors: updated });
  };

  // Helper functions for trade references
  const addTradeReference = () => {
    setFormData({
      ...formData,
      tradeReferences: [
        ...formData.tradeReferences,
        { companyName: '', contactPerson: '', phone: '', email: '' },
      ],
    });
  };

  const removeTradeReference = (index: number) => {
    setFormData({
      ...formData,
      tradeReferences: formData.tradeReferences.filter((_, i) => i !== index),
    });
  };

  const updateTradeReference = (index: number, field: string, value: string) => {
    const updated = [...formData.tradeReferences];
    updated[index] = { ...updated[index], [field]: value };
    setFormData({ ...formData, tradeReferences: updated });
  };

  // Validation functions
  const validateBusinessInfo = (): boolean => {
    const errors: Record<string, string> = {};
    let isValid = true;

    if (!formData.accountType) {
      errors.accountType = t('validation.accountTypeRequired');
      isValid = false;
    }

    if (!formData.businessName?.trim()) {
      errors.businessName = t('validation.businessNameRequired');
      isValid = false;
    }

    if (!formData.abn?.trim()) {
      errors.abn = t('validation.abnRequired');
      isValid = false;
    } else if (!validateABN(formData.abn)) {
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

  const validateContactPerson = (): boolean => {
    const errors: Record<string, string> = {};
    let isValid = true;

    if (!formData.contactPerson.firstName?.trim()) {
      errors.firstName = t('validation.firstNameRequired');
      isValid = false;
    }

    if (!formData.contactPerson.lastName?.trim()) {
      errors.lastName = t('validation.lastNameRequired');
      isValid = false;
    }

    if (!formData.contactPerson.email?.trim()) {
      errors.email = t('validation.emailRequired');
      isValid = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.contactPerson.email)) {
      errors.email = t('validation.emailInvalid');
      isValid = false;
    }

    if (!formData.contactPerson.phone?.trim()) {
      errors.phone = t('validation.phoneRequired');
      isValid = false;
    } else if (!validateAustralianPhone(formData.contactPerson.phone)) {
      errors.phone = t('validation.phoneInvalid');
      isValid = false;
    }

    if (formData.contactPerson.mobile && !validateAustralianPhone(formData.contactPerson.mobile)) {
      errors.mobile = t('validation.mobileInvalid');
      isValid = false;
    }

    setContactErrors(errors);
    return isValid;
  };

  const validateAddresses = (): boolean => {
    const errors: Record<string, string> = {};
    let isValid = true;

    // Delivery address (always required)
    if (!formData.deliveryAddress.street?.trim()) {
      errors['delivery.street'] = t('validation.streetRequired');
      isValid = false;
    }

    if (!formData.deliveryAddress.suburb?.trim()) {
      errors['delivery.suburb'] = t('validation.suburbRequired');
      isValid = false;
    }

    if (!formData.deliveryAddress.postcode?.trim()) {
      errors['delivery.postcode'] = t('validation.postcodeRequired');
      isValid = false;
    } else if (!/^\d{4}$/.test(formData.deliveryAddress.postcode)) {
      errors['delivery.postcode'] = t('validation.postcodeInvalid');
      isValid = false;
    }

    // Conditional billing address
    if (!sameAsDelivery) {
      if (!formData.billingAddress.street?.trim()) {
        errors['billing.street'] = t('validation.streetRequired');
        isValid = false;
      }

      if (!formData.billingAddress.suburb?.trim()) {
        errors['billing.suburb'] = t('validation.suburbRequired');
        isValid = false;
      }

      if (!formData.billingAddress.postcode?.trim()) {
        errors['billing.postcode'] = t('validation.postcodeRequired');
        isValid = false;
      } else if (!/^\d{4}$/.test(formData.billingAddress.postcode)) {
        errors['billing.postcode'] = t('validation.postcodeInvalid');
        isValid = false;
      }
    }

    // Conditional postal address
    if (!postalSameAsBilling) {
      if (!formData.postalAddress.street?.trim()) {
        errors['postal.street'] = t('validation.streetRequired');
        isValid = false;
      }

      if (!formData.postalAddress.suburb?.trim()) {
        errors['postal.suburb'] = t('validation.suburbRequired');
        isValid = false;
      }

      if (!formData.postalAddress.postcode?.trim()) {
        errors['postal.postcode'] = t('validation.postcodeRequired');
        isValid = false;
      } else if (!/^\d{4}$/.test(formData.postalAddress.postcode)) {
        errors['postal.postcode'] = t('validation.postcodeInvalid');
        isValid = false;
      }
    }

    setAddressErrors(errors);
    return isValid;
  };

  const validateFinancialInfo = (): boolean => {
    if (!includeFinancial) {
      setFinancialErrors({});
      return true; // Not required if checkbox unchecked
    }

    const errors: Record<string, string> = {};
    let isValid = true;

    if (!formData.financialDetails.bankName?.trim()) {
      errors.bankName = t('validation.bankNameRequired');
      isValid = false;
    }

    if (!formData.financialDetails.accountName?.trim()) {
      errors.accountName = t('validation.accountNameRequired');
      isValid = false;
    }

    if (!formData.financialDetails.bsb?.trim()) {
      errors.bsb = t('validation.bsbRequired');
      isValid = false;
    } else if (!/^\d{6}$/.test(formData.financialDetails.bsb.replace(/-/g, ''))) {
      errors.bsb = t('validation.bsbInvalid');
      isValid = false;
    }

    if (!formData.financialDetails.accountNumber?.trim()) {
      errors.accountNumber = t('validation.accountNumberRequired');
      isValid = false;
    }

    setFinancialErrors(errors);
    return isValid;
  };

  const validateDirectors = (): boolean => {
    if (formData.directors.length === 0) {
      setDirectorErrors({});
      return true; // Directors are optional
    }

    const errors: Record<number, Record<string, string>> = {};
    let isValid = true;

    formData.directors.forEach((director, index) => {
      const directorErrs: Record<string, string> = {};

      if (!director.familyName?.trim()) {
        directorErrs.familyName = t('validation.familyNameRequired');
        isValid = false;
      }

      if (!director.givenNames?.trim()) {
        directorErrs.givenNames = t('validation.givenNamesRequired');
        isValid = false;
      }

      if (!director.residentialAddress.street?.trim()) {
        directorErrs['residentialAddress.street'] = t('validation.streetRequired');
        isValid = false;
      }

      if (!director.residentialAddress.suburb?.trim()) {
        directorErrs['residentialAddress.suburb'] = t('validation.suburbRequired');
        isValid = false;
      }

      if (!director.residentialAddress.postcode?.trim()) {
        directorErrs['residentialAddress.postcode'] = t('validation.postcodeRequired');
        isValid = false;
      } else if (!/^\d{4}$/.test(director.residentialAddress.postcode)) {
        directorErrs['residentialAddress.postcode'] = t('validation.postcodeInvalid');
        isValid = false;
      }

      if (!director.dateOfBirth) {
        directorErrs.dateOfBirth = t('validation.dateOfBirthRequired');
        isValid = false;
      }

      if (!director.driverLicenseNumber?.trim()) {
        directorErrs.driverLicenseNumber = t('validation.driverLicenseRequired');
        isValid = false;
      }

      if (!director.licenseExpiry) {
        directorErrs.licenseExpiry = t('validation.licenseExpiryRequired');
        isValid = false;
      }

      if (Object.keys(directorErrs).length > 0) {
        errors[index] = directorErrs;
      }
    });

    setDirectorErrors(errors);
    return isValid;
  };

  const validateTradeReferences = (): boolean => {
    if (formData.tradeReferences.length === 0) {
      setTradeRefErrors({});
      return true; // Trade references are optional
    }

    const errors: Record<number, Record<string, string>> = {};
    let isValid = true;

    formData.tradeReferences.forEach((ref, index) => {
      const refErrs: Record<string, string> = {};

      if (!ref.companyName?.trim()) {
        refErrs.companyName = t('validation.companyNameRequired');
        isValid = false;
      }

      if (!ref.contactPerson?.trim()) {
        refErrs.contactPerson = t('validation.contactPersonRequired');
        isValid = false;
      }

      if (!ref.phone?.trim()) {
        refErrs.phone = t('validation.phoneRequired');
        isValid = false;
      } else if (!validateAustralianPhone(ref.phone)) {
        refErrs.phone = t('validation.phoneInvalid');
        isValid = false;
      }

      if (!ref.email?.trim()) {
        refErrs.email = t('validation.emailRequired');
        isValid = false;
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ref.email)) {
        refErrs.email = t('validation.emailInvalid');
        isValid = false;
      }

      if (Object.keys(refErrs).length > 0) {
        errors[index] = refErrs;
      }
    });

    setTradeRefErrors(errors);
    return isValid;
  };

  const validateForm = (): boolean => {
    const businessValid = validateBusinessInfo();
    const contactValid = validateContactPerson();
    const addressValid = validateAddresses();
    const financialValid = validateFinancialInfo();
    const directorsValid = validateDirectors();
    const referencesValid = validateTradeReferences();

    return businessValid && contactValid && addressValid &&
           financialValid && directorsValid && referencesValid;
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
      // Upload signatures to R2 if any exist
      let signatureData: Array<{
        directorIndex: number;
        applicantSignatureUrl: string;
        applicantSignedAt: Date;
        guarantorSignatureUrl: string;
        guarantorSignedAt: Date;
        witnessName: string;
        witnessSignatureUrl: string;
        witnessSignedAt: Date;
      }> | undefined;

      const validSignatures = signatures.filter(
        (sig) =>
          sig &&
          sig.applicantSignatureData &&
          sig.guarantorSignatureData &&
          sig.witnessSignatureData &&
          sig.witnessName
      );

      if (validSignatures.length > 0) {
        const uploadSignature = async (dataUrl: string, type: string, dirIndex: number): Promise<string> => {
          const blob = await fetch(dataUrl).then((r) => r.blob());
          const file = new File([blob], `${type}-${dirIndex}.png`, { type: 'image/png' });
          const formDataUpload = new FormData();
          formDataUpload.append('file', file);
          formDataUpload.append('signatureType', type);
          formDataUpload.append('directorIndex', dirIndex.toString());

          const response = await fetch('/api/upload/signature', {
            method: 'POST',
            body: formDataUpload,
          });
          const result = await response.json();
          if (!result.success) throw new Error(result.error || 'Signature upload failed');
          return result.publicUrl;
        };

        signatureData = await Promise.all(
          validSignatures.map(async (sig) => {
            const now = new Date();
            const [applicantUrl, guarantorUrl, witnessUrl] = await Promise.all([
              uploadSignature(sig.applicantSignatureData!, 'applicant', sig.directorIndex),
              uploadSignature(sig.guarantorSignatureData!, 'guarantor', sig.directorIndex),
              uploadSignature(sig.witnessSignatureData!, 'witness', sig.directorIndex),
            ]);
            return {
              directorIndex: sig.directorIndex,
              applicantSignatureUrl: applicantUrl,
              applicantSignedAt: now,
              guarantorSignatureUrl: guarantorUrl,
              guarantorSignedAt: now,
              witnessName: sig.witnessName,
              witnessSignatureUrl: witnessUrl,
              witnessSignedAt: now,
            };
          })
        );
      }

      // Build directors with ID document data
      const directorsWithDocs = formData.directors.length > 0
        ? formData.directors.map((director, index) => {
            const doc = idDocuments[index];
            return {
              ...director,
              ...(doc?.frontUrl
                ? {
                    idDocumentType: doc.documentType as 'DRIVER_LICENSE' | 'PASSPORT',
                    idDocumentFrontUrl: doc.frontUrl,
                    idDocumentBackUrl: doc.backUrl || undefined,
                    idDocumentUploadedAt: doc.uploadedAt || undefined,
                  }
                : {}),
            };
          })
        : undefined;

      await createCustomerMutation.mutateAsync({
        accountType: formData.accountType,
        businessName: formData.businessName,
        tradingName: formData.tradingName || undefined,
        abn: formData.abn,
        acn: formData.acn || undefined,
        contactPerson: formData.contactPerson,
        deliveryAddress: formData.deliveryAddress,
        billingAddress: sameAsDelivery ? undefined : formData.billingAddress,
        postalAddress: postalSameAsBilling ? undefined : formData.postalAddress,
        requestedCreditLimit: formData.requestedCreditLimit,
        forecastPurchase: formData.forecastPurchase,
        creditLimit: formData.creditLimit,
        paymentTerms: formData.paymentTerms || undefined,
        notes: formData.notes || undefined,
        directors: directorsWithDocs,
        financialDetails: includeFinancial ? formData.financialDetails : undefined,
        tradeReferences: formData.tradeReferences.length > 0 ? formData.tradeReferences : undefined,
        signatures: signatureData,
      });
    } catch (error) {
      console.error('Error creating customer:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-6 md:py-10">
      <div className="mb-6">
        <Link href="/customers">
          <Button variant="ghost" size="sm" className="mb-4">
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('backToCustomers')}
          </Button>
        </Link>
        <h1 className="text-2xl md:text-4xl font-bold">{t('title')}</h1>
        <p className="text-sm md:text-base text-muted-foreground mt-1 md:mt-2">{t('subtitle')}</p>
      </div>

      <form onSubmit={handleSubmit}>
        {/* Custom Tab Navigation */}
        <div className="mb-6">
          <div className="flex flex-wrap gap-2 border-b">
            {[
              { value: 'business', label: t('tabs.business') },
              { value: 'contact', label: t('tabs.contact') },
              { value: 'addresses', label: t('tabs.addresses') },
              { value: 'credit', label: t('tabs.credit') },
              { value: 'directors', label: t('tabs.directors') },
              { value: 'financial', label: t('tabs.financial') },
              { value: 'references', label: t('tabs.references') },
              { value: 'signatures', label: t('tabs.signatures') },
              { value: 'documents', label: t('tabs.documents') },
            ].map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => setActiveTab(tab.value)}
                className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  activeTab === tab.value
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Business Information Tab */}
        {activeTab === 'business' && (
          <div className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('businessInfo.title')}</CardTitle>
                <CardDescription>{t('businessInfo.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="accountType">{t('businessInfo.accountType')} *</Label>
                  <select
                    id="accountType"
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={formData.accountType}
                    onChange={(e) => {
                      setFormData({
                        ...formData,
                        accountType: e.target.value as 'sole_trader' | 'partnership' | 'company' | 'other',
                      });
                      clearBusinessError('accountType');
                    }}
                    required
                  >
                    <option value="sole_trader">{t('businessInfo.accountTypes.soleTrader')}</option>
                    <option value="partnership">{t('businessInfo.accountTypes.partnership')}</option>
                    <option value="company">{t('businessInfo.accountTypes.company')}</option>
                    <option value="other">{t('businessInfo.accountTypes.other')}</option>
                  </select>
                  {businessErrors.accountType && (
                    <p className="text-sm text-destructive mt-1">{businessErrors.accountType}</p>
                  )}
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="businessName">{t('businessInfo.businessName')} *</Label>
                    <Input
                      id="businessName"
                      placeholder={t('businessInfo.businessNamePlaceholder')}
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
                  <div className="space-y-2">
                    <Label htmlFor="tradingName">{t('businessInfo.tradingName')}</Label>
                    <Input
                      id="tradingName"
                      placeholder={t('businessInfo.tradingNamePlaceholder')}
                      value={formData.tradingName}
                      onChange={(e) => setFormData({ ...formData, tradingName: e.target.value })}
                    />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="abn">{t('businessInfo.abn')} *</Label>
                    <Input
                      id="abn"
                      placeholder={t('businessInfo.abnPlaceholder')}
                      required
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
                    <Label htmlFor="acn">{t('businessInfo.acn')}</Label>
                    <Input
                      id="acn"
                      placeholder={t('businessInfo.acnPlaceholder')}
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
              </CardContent>
            </Card>
          </div>
        )}

        {/* Contact Person Tab */}
        {activeTab === 'contact' && (
          <div className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('contactPerson.title')}</CardTitle>
                <CardDescription>{t('contactPerson.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="firstName">{t('contactPerson.firstName')} *</Label>
                    <Input
                      id="firstName"
                      placeholder={t('contactPerson.firstNamePlaceholder')}
                      required
                      value={formData.contactPerson.firstName}
                      onChange={(e) => {
                        setFormData({
                          ...formData,
                          contactPerson: { ...formData.contactPerson, firstName: e.target.value },
                        });
                        clearContactError('firstName');
                      }}
                    />
                    {contactErrors.firstName && (
                      <p className="text-sm text-destructive">{contactErrors.firstName}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lastName">{t('contactPerson.lastName')} *</Label>
                    <Input
                      id="lastName"
                      placeholder={t('contactPerson.lastNamePlaceholder')}
                      required
                      value={formData.contactPerson.lastName}
                      onChange={(e) => {
                        setFormData({
                          ...formData,
                          contactPerson: { ...formData.contactPerson, lastName: e.target.value },
                        });
                        clearContactError('lastName');
                      }}
                    />
                    {contactErrors.lastName && (
                      <p className="text-sm text-destructive">{contactErrors.lastName}</p>
                    )}
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="email">{t('contactPerson.email')} *</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder={t('contactPerson.emailPlaceholder')}
                      required
                      value={formData.contactPerson.email}
                      onChange={(e) => {
                        setFormData({
                          ...formData,
                          contactPerson: { ...formData.contactPerson, email: e.target.value },
                        });
                        clearContactError('email');
                      }}
                    />
                    {contactErrors.email && (
                      <p className="text-sm text-destructive">{contactErrors.email}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="phone">{t('contactPerson.phone')} *</Label>
                    <Input
                      id="phone"
                      placeholder={t('contactPerson.phonePlaceholder')}
                      required
                      value={formData.contactPerson.phone}
                      onChange={(e) => {
                        setFormData({
                          ...formData,
                          contactPerson: { ...formData.contactPerson, phone: e.target.value },
                        });
                        clearContactError('phone');
                      }}
                    />
                    {contactErrors.phone && (
                      <p className="text-sm text-destructive">{contactErrors.phone}</p>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="mobile">{t('contactPerson.mobile')}</Label>
                  <Input
                    id="mobile"
                    placeholder={t('contactPerson.mobilePlaceholder')}
                    value={formData.contactPerson.mobile}
                    onChange={(e) => {
                      setFormData({
                        ...formData,
                        contactPerson: { ...formData.contactPerson, mobile: e.target.value },
                      });
                      clearContactError('mobile');
                    }}
                  />
                  {contactErrors.mobile && (
                    <p className="text-sm text-destructive">{contactErrors.mobile}</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Addresses Tab */}
        {activeTab === 'addresses' && (
          <div className="mt-6 space-y-6">
            {/* Delivery Address */}
            <Card>
              <CardHeader>
                <CardTitle>{t('addresses.deliveryTitle')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <AddressSearch
                  id="deliveryAddress"
                  onAddressSelect={(address: AddressResult) => {
                    setFormData({
                      ...formData,
                      deliveryAddress: {
                        ...formData.deliveryAddress,
                        street: address.street,
                        suburb: address.suburb,
                        state: address.state,
                        postcode: address.postcode,
                        areaId: undefined, // Reset area to trigger auto-lookup
                      },
                    });
                    clearAddressError('delivery.street');
                    clearAddressError('delivery.suburb');
                    clearAddressError('delivery.postcode');
                  }}
                  defaultValues={{
                    street: formData.deliveryAddress.street,
                    suburb: formData.deliveryAddress.suburb,
                    state: formData.deliveryAddress.state,
                    postcode: formData.deliveryAddress.postcode,
                  }}
                />
                {(addressErrors['delivery.street'] || addressErrors['delivery.suburb'] || addressErrors['delivery.postcode']) && (
                  <p className="text-sm text-destructive">
                    {addressErrors['delivery.street'] || addressErrors['delivery.suburb'] || addressErrors['delivery.postcode']}
                  </p>
                )}

                <div className="space-y-2">
                  <Label htmlFor="areaId">{t('addresses.area')}</Label>
                  <div className="flex items-center gap-2">
                    <select
                      id="areaId"
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={formData.deliveryAddress.areaId ?? ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          deliveryAddress: {
                            ...formData.deliveryAddress,
                            areaId: e.target.value || undefined,
                          },
                        })
                      }
                    >
                      <option value="">{t('addresses.areaAutoDetect')}</option>
                      {areas?.map((area) => (
                        <option key={area.id} value={area.id}>
                          {area.displayName}
                        </option>
                      ))}
                    </select>
                    {isLookingUpArea && (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  {formData.deliveryAddress.areaId && areas && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <MapPin className="h-3 w-3" />
                      <span>{t('addresses.assignedTo')}:</span>
                      <AreaBadge
                        area={
                          areas.find((a) => a.id === formData.deliveryAddress.areaId) ?? {
                            name: 'unknown',
                            displayName: 'Unknown',
                            colorVariant: 'default',
                          }
                        }
                        className="text-xs"
                      />
                    </div>
                  )}
                  {!formData.deliveryAddress.areaId && autoArea && (
                    <p className="text-sm text-muted-foreground">
                      {t('addresses.willAutoAssignTo', { area: autoArea.displayName })}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="deliveryInstructions">{t('addresses.deliveryInstructions')}</Label>
                  <Input
                    id="deliveryInstructions"
                    placeholder={t('addresses.deliveryInstructionsPlaceholder')}
                    value={formData.deliveryAddress.deliveryInstructions}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        deliveryAddress: { ...formData.deliveryAddress, deliveryInstructions: e.target.value },
                      })
                    }
                  />
                </div>
              </CardContent>
            </Card>

            {/* Billing Address */}
            <Card>
              <CardHeader>
                <CardTitle>{t('addresses.billingTitle')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="sameAsDelivery"
                    checked={sameAsDelivery}
                    onChange={(e) => setSameAsDelivery(e.target.checked)}
                    className="h-4 w-4"
                  />
                  <Label htmlFor="sameAsDelivery" className="font-normal">
                    {t('addresses.sameAsDelivery')}
                  </Label>
                </div>

                {!sameAsDelivery && (
                  <>
                    <AddressSearch
                      id="billingAddress"
                      onAddressSelect={(address: AddressResult) => {
                        setFormData({
                          ...formData,
                          billingAddress: {
                            street: address.street,
                            suburb: address.suburb,
                            state: address.state,
                            postcode: address.postcode,
                          },
                        });
                        clearAddressError('billing.street');
                        clearAddressError('billing.suburb');
                        clearAddressError('billing.postcode');
                      }}
                      defaultValues={{
                        street: formData.billingAddress.street,
                        suburb: formData.billingAddress.suburb,
                        state: formData.billingAddress.state,
                        postcode: formData.billingAddress.postcode,
                      }}
                    />
                    {(addressErrors['billing.street'] || addressErrors['billing.suburb'] || addressErrors['billing.postcode']) && (
                      <p className="text-sm text-destructive">
                        {addressErrors['billing.street'] || addressErrors['billing.suburb'] || addressErrors['billing.postcode']}
                      </p>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            {/* Postal Address */}
            <Card>
              <CardHeader>
                <CardTitle>{t('addresses.postalTitle')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="postalSameAsBilling"
                    checked={postalSameAsBilling}
                    onChange={(e) => setPostalSameAsBilling(e.target.checked)}
                    className="h-4 w-4"
                  />
                  <Label htmlFor="postalSameAsBilling" className="font-normal">
                    {t('addresses.sameAsBilling')}
                  </Label>
                </div>

                {!postalSameAsBilling && (
                  <>
                    <AddressSearch
                      id="postalAddress"
                      onAddressSelect={(address: AddressResult) => {
                        setFormData({
                          ...formData,
                          postalAddress: {
                            street: address.street,
                            suburb: address.suburb,
                            state: address.state,
                            postcode: address.postcode,
                          },
                        });
                        clearAddressError('postal.street');
                        clearAddressError('postal.suburb');
                        clearAddressError('postal.postcode');
                      }}
                      defaultValues={{
                        street: formData.postalAddress.street,
                        suburb: formData.postalAddress.suburb,
                        state: formData.postalAddress.state,
                        postcode: formData.postalAddress.postcode,
                      }}
                    />
                    {(addressErrors['postal.street'] || addressErrors['postal.suburb'] || addressErrors['postal.postcode']) && (
                      <p className="text-sm text-destructive">
                        {addressErrors['postal.street'] || addressErrors['postal.suburb'] || addressErrors['postal.postcode']}
                      </p>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Credit Application Tab */}
        {activeTab === 'credit' && (
          <div className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('creditApplication.title')}</CardTitle>
                <CardDescription>{t('creditApplication.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="requestedCreditLimit">{t('creditApplication.requestedCreditLimit')}</Label>
                    <Input
                      id="requestedCreditLimit"
                      type="number"
                      min="0"
                      step="100"
                      placeholder={t('creditApplication.requestedCreditLimitPlaceholder')}
                      value={formData.requestedCreditLimit ? (formData.requestedCreditLimit / 100).toFixed(0) : ''}
                      onChange={(e) => {
                        setFormData({
                          ...formData,
                          requestedCreditLimit: e.target.value ? parseToCents(e.target.value) || undefined : undefined,
                        });
                        clearCreditError('requestedCreditLimit');
                      }}
                    />
                    <p className="text-xs text-muted-foreground">{t('creditApplication.enterDollars')}</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="forecastPurchase">{t('creditApplication.forecastPurchase')}</Label>
                    <Input
                      id="forecastPurchase"
                      type="number"
                      min="0"
                      step="100"
                      placeholder={t('creditApplication.forecastPurchasePlaceholder')}
                      value={formatCentsForWholeInput(formData.forecastPurchase)}
                      onChange={(e) => {
                        setFormData({
                          ...formData,
                          forecastPurchase: e.target.value ? parseToCents(e.target.value) || undefined : undefined,
                        });
                        clearCreditError('forecastPurchase');
                      }}
                    />
                    <p className="text-xs text-muted-foreground">{t('creditApplication.enterDollars')}</p>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="creditLimit">{t('creditApplication.approvedCreditLimit')}</Label>
                    <Input
                      id="creditLimit"
                      type="number"
                      min="0"
                      step="100"
                      placeholder={t('creditApplication.approvedCreditLimitPlaceholder')}
                      value={formatCentsForWholeInput(formData.creditLimit) || '0'}
                      onChange={(e) => {
                        setFormData({ ...formData, creditLimit: parseToCents(e.target.value) || 0 });
                        clearCreditError('creditLimit');
                      }}
                    />
                    <p className="text-xs text-muted-foreground">{t('creditApplication.enterDollars')}</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="paymentTerms">{t('creditApplication.paymentTerms')}</Label>
                    <Input
                      id="paymentTerms"
                      placeholder={t('creditApplication.paymentTermsPlaceholder')}
                      value={formData.paymentTerms}
                      onChange={(e) => {
                        setFormData({ ...formData, paymentTerms: e.target.value });
                        clearCreditError('paymentTerms');
                      }}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="notes">{t('creditApplication.notes')}</Label>
                  <textarea
                    id="notes"
                    className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    placeholder={t('creditApplication.notesPlaceholder')}
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Directors Tab */}
        {activeTab === 'directors' && (
          <div className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('directors.title')}</CardTitle>
                <CardDescription>{t('directors.description')}</CardDescription>
                <p className="text-sm text-muted-foreground mt-2">{t('directors.optional')}</p>
              </CardHeader>
              <CardContent className="space-y-6">
                {formData.directors.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground mb-4">{t('directors.emptyState')}</p>
                    <Button type="button" onClick={addDirector}>
                      <Plus className="mr-2 h-4 w-4" />
                      {t('directors.addDirector')}
                    </Button>
                  </div>
                ) : (
                  <>
                    {formData.directors.map((director, index) => (
                      <Card key={index} className="relative">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="absolute top-2 right-2"
                          onClick={() => removeDirector(index)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                        <CardHeader>
                          <CardTitle className="text-base">
                            {t('directors.directorNumber', { number: index + 1 })}
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label>{t('directors.familyName')}</Label>
                              <Input
                                value={director.familyName}
                                onChange={(e) => {
                                  updateDirector(index, 'familyName', e.target.value);
                                  clearDirectorError(index, 'familyName');
                                }}
                                placeholder={t('directors.familyNamePlaceholder')}
                              />
                              {directorErrors[index]?.['familyName'] && (
                                <p className="text-sm text-destructive">{directorErrors[index]['familyName']}</p>
                              )}
                            </div>
                            <div className="space-y-2">
                              <Label>{t('directors.givenNames')}</Label>
                              <Input
                                value={director.givenNames}
                                onChange={(e) => {
                                  updateDirector(index, 'givenNames', e.target.value);
                                  clearDirectorError(index, 'givenNames');
                                }}
                                placeholder={t('directors.givenNamesPlaceholder')}
                              />
                              {directorErrors[index]?.['givenNames'] && (
                                <p className="text-sm text-destructive">{directorErrors[index]['givenNames']}</p>
                              )}
                            </div>
                          </div>

                          <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label>{t('directors.dateOfBirth')}</Label>
                              <Input
                                type="date"
                                value={director.dateOfBirth}
                                onChange={(e) => {
                                  updateDirector(index, 'dateOfBirth', e.target.value);
                                  clearDirectorError(index, 'dateOfBirth');
                                }}
                              />
                              {directorErrors[index]?.['dateOfBirth'] && (
                                <p className="text-sm text-destructive">{directorErrors[index]['dateOfBirth']}</p>
                              )}
                            </div>
                            <div className="space-y-2">
                              <Label>{t('directors.position')}</Label>
                              <Input
                                value={director.position || ''}
                                onChange={(e) => updateDirector(index, 'position', e.target.value)}
                                placeholder={t('directors.positionPlaceholder')}
                              />
                            </div>
                          </div>

                          <div className="space-y-2">
                            <Label>{t('directors.residentialAddress')}</Label>
                            <Input
                              value={director.residentialAddress.street}
                              onChange={(e) => {
                                updateDirector(index, 'residentialAddress.street', e.target.value);
                                clearDirectorError(index, 'residentialAddress.street');
                              }}
                              placeholder={t('addresses.streetPlaceholder')}
                              className="mb-2"
                            />
                            {directorErrors[index]?.['residentialAddress.street'] && (
                              <p className="text-sm text-destructive mb-2">{directorErrors[index]['residentialAddress.street']}</p>
                            )}
                            <div className="grid gap-2 md:grid-cols-3">
                              <div className="space-y-2">
                                <Input
                                  value={director.residentialAddress.suburb}
                                  onChange={(e) => {
                                    updateDirector(index, 'residentialAddress.suburb', e.target.value);
                                    clearDirectorError(index, 'residentialAddress.suburb');
                                  }}
                                  placeholder={t('addresses.suburbPlaceholder')}
                                />
                                {directorErrors[index]?.['residentialAddress.suburb'] && (
                                  <p className="text-sm text-destructive">{directorErrors[index]['residentialAddress.suburb']}</p>
                                )}
                              </div>
                              <select
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                value={director.residentialAddress.state}
                                onChange={(e) => updateDirector(index, 'residentialAddress.state', e.target.value)}
                              >
                                <option value="NSW">NSW</option>
                                <option value="VIC">VIC</option>
                                <option value="QLD">QLD</option>
                                <option value="SA">SA</option>
                                <option value="WA">WA</option>
                                <option value="TAS">TAS</option>
                                <option value="NT">NT</option>
                                <option value="ACT">ACT</option>
                              </select>
                              <div className="space-y-2">
                                <Input
                                  value={director.residentialAddress.postcode}
                                  onChange={(e) => {
                                    updateDirector(index, 'residentialAddress.postcode', e.target.value);
                                    clearDirectorError(index, 'residentialAddress.postcode');
                                  }}
                                  placeholder={t('addresses.postcodePlaceholder')}
                                  maxLength={4}
                                />
                                {directorErrors[index]?.['residentialAddress.postcode'] && (
                                  <p className="text-sm text-destructive">{directorErrors[index]['residentialAddress.postcode']}</p>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="grid gap-4 md:grid-cols-3">
                            <div className="space-y-2">
                              <Label>{t('directors.driverLicenseNumber')}</Label>
                              <Input
                                value={director.driverLicenseNumber}
                                onChange={(e) => {
                                  updateDirector(index, 'driverLicenseNumber', e.target.value);
                                  clearDirectorError(index, 'driverLicenseNumber');
                                }}
                                placeholder={t('directors.driverLicenseNumberPlaceholder')}
                              />
                              {directorErrors[index]?.['driverLicenseNumber'] && (
                                <p className="text-sm text-destructive">{directorErrors[index]['driverLicenseNumber']}</p>
                              )}
                            </div>
                            <div className="space-y-2">
                              <Label>{t('directors.licenseState')}</Label>
                              <select
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                value={director.licenseState}
                                onChange={(e) => updateDirector(index, 'licenseState', e.target.value)}
                              >
                                <option value="NSW">{t('directors.states.NSW')}</option>
                                <option value="VIC">{t('directors.states.VIC')}</option>
                                <option value="QLD">{t('directors.states.QLD')}</option>
                                <option value="SA">{t('directors.states.SA')}</option>
                                <option value="WA">{t('directors.states.WA')}</option>
                                <option value="TAS">{t('directors.states.TAS')}</option>
                                <option value="NT">{t('directors.states.NT')}</option>
                                <option value="ACT">{t('directors.states.ACT')}</option>
                              </select>
                            </div>
                            <div className="space-y-2">
                              <Label>{t('directors.licenseExpiry')}</Label>
                              <Input
                                type="date"
                                value={director.licenseExpiry}
                                onChange={(e) => {
                                  updateDirector(index, 'licenseExpiry', e.target.value);
                                  clearDirectorError(index, 'licenseExpiry');
                                }}
                              />
                              {directorErrors[index]?.['licenseExpiry'] && (
                                <p className="text-sm text-destructive">{directorErrors[index]['licenseExpiry']}</p>
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}

                    <Button type="button" onClick={addDirector} variant="outline" className="w-full">
                      <Plus className="mr-2 h-4 w-4" />
                      {t('directors.addDirector')}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Financial Tab */}
        {activeTab === 'financial' && (
          <div className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('financial.title')}</CardTitle>
                <CardDescription>{t('financial.description')}</CardDescription>
                <p className="text-sm text-muted-foreground mt-2">{t('financial.optional')}</p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center space-x-2 mb-4">
                  <input
                    type="checkbox"
                    id="includeFinancial"
                    checked={includeFinancial}
                    onChange={(e) => setIncludeFinancial(e.target.checked)}
                    className="h-4 w-4"
                  />
                  <Label htmlFor="includeFinancial" className="font-normal">
                    Include financial information
                  </Label>
                </div>

                {includeFinancial && (
                  <>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="bankName">{t('financial.bankName')}</Label>
                        <Input
                          id="bankName"
                          placeholder={t('financial.bankNamePlaceholder')}
                          value={formData.financialDetails.bankName}
                          onChange={(e) => {
                            setFormData({
                              ...formData,
                              financialDetails: { ...formData.financialDetails, bankName: e.target.value },
                            });
                            clearFinancialError('bankName');
                          }}
                        />
                        {financialErrors.bankName && (
                          <p className="text-sm text-destructive">{financialErrors.bankName}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="accountName">{t('financial.accountName')}</Label>
                        <Input
                          id="accountName"
                          placeholder={t('financial.accountNamePlaceholder')}
                          value={formData.financialDetails.accountName}
                          onChange={(e) => {
                            setFormData({
                              ...formData,
                              financialDetails: { ...formData.financialDetails, accountName: e.target.value },
                            });
                            clearFinancialError('accountName');
                          }}
                        />
                        {financialErrors.accountName && (
                          <p className="text-sm text-destructive">{financialErrors.accountName}</p>
                        )}
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="bsb">{t('financial.bsb')}</Label>
                        <Input
                          id="bsb"
                          placeholder={t('financial.bsbPlaceholder')}
                          maxLength={7}
                          value={formData.financialDetails.bsb}
                          onChange={(e) => {
                            setFormData({
                              ...formData,
                              financialDetails: { ...formData.financialDetails, bsb: e.target.value },
                            });
                            clearFinancialError('bsb');
                          }}
                        />
                        {financialErrors.bsb && (
                          <p className="text-sm text-destructive">{financialErrors.bsb}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="accountNumber">{t('financial.accountNumber')}</Label>
                        <Input
                          id="accountNumber"
                          placeholder={t('financial.accountNumberPlaceholder')}
                          value={formData.financialDetails.accountNumber}
                          onChange={(e) => {
                            setFormData({
                              ...formData,
                              financialDetails: { ...formData.financialDetails, accountNumber: e.target.value },
                            });
                            clearFinancialError('accountNumber');
                          }}
                        />
                        {financialErrors.accountNumber && (
                          <p className="text-sm text-destructive">{financialErrors.accountNumber}</p>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Trade References Tab */}
        {activeTab === 'references' && (
          <div className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('tradeReferences.title')}</CardTitle>
                <CardDescription>{t('tradeReferences.description')}</CardDescription>
                <p className="text-sm text-muted-foreground mt-2">{t('tradeReferences.optional')}</p>
              </CardHeader>
              <CardContent className="space-y-6">
                {formData.tradeReferences.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground mb-4">{t('tradeReferences.emptyState')}</p>
                    <Button type="button" onClick={addTradeReference}>
                      <Plus className="mr-2 h-4 w-4" />
                      {t('tradeReferences.addReference')}
                    </Button>
                  </div>
                ) : (
                  <>
                    {formData.tradeReferences.map((reference, index) => (
                      <Card key={index} className="relative">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="absolute top-2 right-2"
                          onClick={() => removeTradeReference(index)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                        <CardHeader>
                          <CardTitle className="text-base">
                            {t('tradeReferences.referenceNumber', { number: index + 1 })}
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label>{t('tradeReferences.companyName')}</Label>
                              <Input
                                value={reference.companyName}
                                onChange={(e) => {
                                  updateTradeReference(index, 'companyName', e.target.value);
                                  clearTradeRefError(index, 'companyName');
                                }}
                                placeholder={t('tradeReferences.companyNamePlaceholder')}
                              />
                              {tradeRefErrors[index]?.['companyName'] && (
                                <p className="text-sm text-destructive">{tradeRefErrors[index]['companyName']}</p>
                              )}
                            </div>
                            <div className="space-y-2">
                              <Label>{t('tradeReferences.contactPerson')}</Label>
                              <Input
                                value={reference.contactPerson}
                                onChange={(e) => {
                                  updateTradeReference(index, 'contactPerson', e.target.value);
                                  clearTradeRefError(index, 'contactPerson');
                                }}
                                placeholder={t('tradeReferences.contactPersonPlaceholder')}
                              />
                              {tradeRefErrors[index]?.['contactPerson'] && (
                                <p className="text-sm text-destructive">{tradeRefErrors[index]['contactPerson']}</p>
                              )}
                            </div>
                          </div>

                          <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label>{t('tradeReferences.phone')}</Label>
                              <Input
                                value={reference.phone}
                                onChange={(e) => {
                                  updateTradeReference(index, 'phone', e.target.value);
                                  clearTradeRefError(index, 'phone');
                                }}
                                placeholder={t('tradeReferences.phonePlaceholder')}
                              />
                              {tradeRefErrors[index]?.['phone'] && (
                                <p className="text-sm text-destructive">{tradeRefErrors[index]['phone']}</p>
                              )}
                            </div>
                            <div className="space-y-2">
                              <Label>{t('tradeReferences.email')}</Label>
                              <Input
                                type="email"
                                value={reference.email}
                                onChange={(e) => {
                                  updateTradeReference(index, 'email', e.target.value);
                                  clearTradeRefError(index, 'email');
                                }}
                                placeholder={t('tradeReferences.emailPlaceholder')}
                              />
                              {tradeRefErrors[index]?.['email'] && (
                                <p className="text-sm text-destructive">{tradeRefErrors[index]['email']}</p>
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}

                    <Button type="button" onClick={addTradeReference} variant="outline" className="w-full">
                      <Plus className="mr-2 h-4 w-4" />
                      {t('tradeReferences.addReference')}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Signatures Tab */}
        {activeTab === 'signatures' && (
          <div className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('signatures.title')}</CardTitle>
                <CardDescription>{t('signatures.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-8">
                {formData.directors.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground">{t('signatures.noDirectors')}</p>
                  </div>
                ) : (
                  <>
                    <div className="rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground">
                      {t('signatures.termsText')}
                    </div>
                    {formData.directors.map((director, index) => (
                      <div key={index} className="space-y-6 border rounded-lg p-4">
                        <h3 className="font-semibold">
                          {t('signatures.directorNumber', {
                            number: index + 1,
                            name: `${director.givenNames} ${director.familyName}`.trim() || `Director ${index + 1}`,
                          })}
                        </h3>

                        <SignaturePadComponent
                          id={`applicant-sig-${index}`}
                          label={t('signatures.applicantSignature')}
                          onSignatureChange={(data) => {
                            setSignatures((prev) => {
                              const updated = [...prev];
                              if (!updated[index]) {
                                updated[index] = {
                                  directorIndex: index,
                                  applicantSignatureData: null,
                                  guarantorSignatureData: null,
                                  witnessName: '',
                                  witnessSignatureData: null,
                                };
                              }
                              updated[index] = { ...updated[index], applicantSignatureData: data };
                              return updated;
                            });
                          }}
                        />

                        <SignaturePadComponent
                          id={`guarantor-sig-${index}`}
                          label={t('signatures.guarantorSignature')}
                          onSignatureChange={(data) => {
                            setSignatures((prev) => {
                              const updated = [...prev];
                              if (!updated[index]) {
                                updated[index] = {
                                  directorIndex: index,
                                  applicantSignatureData: null,
                                  guarantorSignatureData: null,
                                  witnessName: '',
                                  witnessSignatureData: null,
                                };
                              }
                              updated[index] = { ...updated[index], guarantorSignatureData: data };
                              return updated;
                            });
                          }}
                        />

                        <div className="space-y-4 border-t pt-4">
                          <div className="space-y-2">
                            <Label>{t('signatures.witnessName')}</Label>
                            <Input
                              placeholder={t('signatures.witnessNamePlaceholder')}
                              value={signatures[index]?.witnessName || ''}
                              onChange={(e) => {
                                setSignatures((prev) => {
                                  const updated = [...prev];
                                  if (!updated[index]) {
                                    updated[index] = {
                                      directorIndex: index,
                                      applicantSignatureData: null,
                                      guarantorSignatureData: null,
                                      witnessName: '',
                                      witnessSignatureData: null,
                                    };
                                  }
                                  updated[index] = { ...updated[index], witnessName: e.target.value };
                                  return updated;
                                });
                              }}
                            />
                          </div>

                          <SignaturePadComponent
                            id={`witness-sig-${index}`}
                            label={t('signatures.witnessSignature')}
                            onSignatureChange={(data) => {
                              setSignatures((prev) => {
                                const updated = [...prev];
                                if (!updated[index]) {
                                  updated[index] = {
                                    directorIndex: index,
                                    applicantSignatureData: null,
                                    guarantorSignatureData: null,
                                    witnessName: '',
                                    witnessSignatureData: null,
                                  };
                                }
                                updated[index] = { ...updated[index], witnessSignatureData: data };
                                return updated;
                              });
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Documents Tab */}
        {activeTab === 'documents' && (
          <div className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('documents.title')}</CardTitle>
                <CardDescription>{t('documents.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {formData.directors.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground">{t('documents.noDirectors')}</p>
                  </div>
                ) : (
                  formData.directors.map((director, index) => (
                    <div key={index} className="space-y-4">
                      <h3 className="font-semibold">
                        {t('documents.directorNumber', {
                          number: index + 1,
                          name: `${director.givenNames} ${director.familyName}`.trim() || `Director ${index + 1}`,
                        })}
                      </h3>
                      <IdentityDocumentUpload
                        directorIndex={index}
                        value={
                          idDocuments[index] || {
                            documentType: 'DRIVER_LICENSE',
                            frontUrl: null,
                            backUrl: null,
                            uploadedAt: null,
                          }
                        }
                        onChange={(data) => {
                          setIdDocuments((prev) => {
                            const updated = [...prev];
                            updated[index] = data;
                            return updated;
                          });
                        }}
                      />
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Error Message */}
        {createCustomerMutation.error && (
          <div className="mt-6 rounded-lg bg-destructive/10 p-4 text-destructive">
            <p className="text-sm font-medium">{t('messages.createError')}</p>
            <p className="text-sm">{createCustomerMutation.error.message}</p>
          </div>
        )}

        {/* Actions */}
        <div className="mt-6 flex justify-end gap-4">
          <Link href="/customers">
            <Button type="button" variant="outline" disabled={isSubmitting}>
              {t('buttons.cancel')}
            </Button>
          </Link>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isSubmitting ? t('buttons.creating') : t('buttons.createCustomer')}
          </Button>
        </div>
      </form>
    </div>
  );
}
