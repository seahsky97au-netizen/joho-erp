'use client';

import { use, useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { api } from '@/trpc/client';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Badge,
  StatusBadge,
  AreaBadge,
  Skeleton,
  ResponsiveTable,
  type TableColumn,
  type StatusType,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Label,
  Input,
  useToast,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Checkbox,
} from '@joho-erp/ui';
import {
  ArrowLeft,
  Building2,
  Mail,
  Phone,
  MapPin,
  CreditCard,
  Package,
  Ban,
  CheckCircle,
  Loader2,
  FileText,
  Pencil,
  X,
  XCircle,
  Save,
  Banknote,
  Users,
  Briefcase,
  Plus,
  Trash2,
  MessageSquare,
  IdCard,
  Download,
  RefreshCw,
  Upload,
  ImageOff,
  Send,
} from 'lucide-react';
import { formatAUD, formatDate, DAYS_OF_WEEK, type DayOfWeek, validateABN } from '@joho-erp/shared';
import { AuditLogSection } from '@/components/audit-log-section';
import { usePermission } from '@/components/permission-provider';
import { AddressSearch, type AddressResult } from '@/components/address-search';

interface PageProps {
  params: Promise<{ id: string; locale: string }>;
}

type Order = {
  id: string;
  orderNumber: string;
  status: StatusType;
  totalAmount: number;
  orderedAt: Date | string;
  items: { productName: string }[];
};

type DirectorFormData = {
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
  licenseState: string;
  licenseExpiry: string;
  position: string;
  // ID document fields (read-only pass-through to prevent data loss on save)
  idDocumentType?: string;
  idDocumentFrontUrl?: string;
  idDocumentBackUrl?: string;
  idDocumentUploadedAt?: string;
};

type TradeReferenceFormData = {
  companyName: string;
  contactPerson: string;
  phone: string;
  email: string;
};

const AUSTRALIAN_STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'] as const;
const ACCOUNT_TYPES = ['sole_trader', 'partnership', 'company', 'other'] as const;

export default function CustomerDetailPage({ params }: PageProps) {
  const resolvedParams = use(params);
  const t = useTranslations('customerDetail');
  const tCustomers = useTranslations('customers');
  const tCommon = useTranslations('common');
  const tDays = useTranslations('days');
  const tOrders = useTranslations('orders');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const { toast } = useToast();
  const utils = api.useUtils();
  const { isAdmin } = usePermission();

  // Suspension dialog state
  const [showSuspendDialog, setShowSuspendDialog] = useState(false);
  const [showActivateDialog, setShowActivateDialog] = useState(false);
  const [suspendReason, setSuspendReason] = useState('');
  const [activateNotes, setActivateNotes] = useState('');

  // Closure dialog state
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [closeReason, setCloseReason] = useState('');

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState(() => ({
    // Contact person
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    mobile: '',
    // Delivery address
    street: '',
    suburb: '',
    state: '',
    postcode: '',
    deliveryInstructions: '',
    areaId: undefined as string | undefined,
    latitude: undefined as number | undefined,
    longitude: undefined as number | undefined,
    // Business info
    businessName: '',
    tradingName: '',
    abn: '',
    acn: '',
    accountType: 'company' as (typeof ACCOUNT_TYPES)[number],
    // Billing address
    billingStreet: '',
    billingSuburb: '',
    billingState: '',
    billingPostcode: '',
    // Postal address
    postalStreet: '',
    postalSuburb: '',
    postalState: '',
    postalPostcode: '',
    postalSameAsBilling: false,
    // Financial details
    bankName: '',
    accountName: '',
    bsb: '',
    accountNumber: '',
    // Directors
    directors: [] as DirectorFormData[],
    // Trade references
    tradeReferences: [] as TradeReferenceFormData[],
    // SMS reminder preferences
    smsReminderEnabled: false,
    smsReminderDays: [] as DayOfWeek[],
  }));

  // Fetch customer data
  const {
    data: customer,
    isLoading,
    error,
  } = api.customer.getById.useQuery({ customerId: resolvedParams.id });

  // Fetch customer orders (customerId is from URL params, no need to wait for customer query)
  const { data: ordersData } = api.order.getAll.useQuery(
    { customerId: resolvedParams.id, limit: 10 },
  );

  // Fetch areas for dropdown
  const { data: areas } = api.area.list.useQuery();

  // Auto-lookup area by suburb when editing
  const { data: autoArea, isLoading: isLookingUpArea } = api.area.lookupBySuburb.useQuery(
    {
      suburb: editForm.suburb,
      state: editForm.state,
      postcode: editForm.postcode,
    },
    {
      enabled:
        isEditing &&
        !!editForm.suburb &&
        editForm.suburb.length > 2 &&
        !editForm.areaId, // Only lookup if no manual selection
    }
  );

  // Auto-select area when lookup returns a result (during editing)
  const autoAreaId = autoArea?.id;
  useEffect(() => {
    if (isEditing && autoAreaId && !editForm.areaId) {
      setEditForm((prev) => ({
        ...prev,
        areaId: autoAreaId,
      }));
    }
  }, [isEditing, autoAreaId, editForm.areaId]);

  // Suspend mutation
  const suspendMutation = api.customer.suspend.useMutation({
    onSuccess: () => {
      toast({
        title: t('suspension.suspendSuccess'),
        description: t('suspension.suspendSuccessMessage'),
      });
      void utils.customer.getById.invalidate({ customerId: resolvedParams.id });
      setShowSuspendDialog(false);
      setSuspendReason('');
    },
    onError: (error) => {
      console.error('Suspend customer error:', error.message);
      toast({
        title: t('suspension.suspendError'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  // Activate mutation
  const activateMutation = api.customer.activate.useMutation({
    onSuccess: () => {
      toast({
        title: t('suspension.activateSuccess'),
        description: t('suspension.activateSuccessMessage'),
      });
      void utils.customer.getById.invalidate({ customerId: resolvedParams.id });
      setShowActivateDialog(false);
      setActivateNotes('');
    },
    onError: (error) => {
      console.error('Activate customer error:', error.message);
      toast({
        title: t('suspension.activateError'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  // Close mutation (permanent account closure)
  const closeMutation = api.customer.close.useMutation({
    onSuccess: () => {
      toast({
        title: t('closure.closeSuccess'),
        description: t('closure.closeSuccessMessage'),
      });
      void utils.customer.getById.invalidate({ customerId: resolvedParams.id });
      setShowCloseDialog(false);
      setCloseReason('');
    },
    onError: (error) => {
      console.error('Close customer error:', error.message);
      toast({
        title: t('closure.closeError'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  // Invitation dialog state
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');

  // Invite mutation
  const inviteMutation = api.customer.inviteCustomer.useMutation({
    onSuccess: () => {
      toast({
        title: t('invitation.inviteSuccess'),
        description: t('invitation.inviteSuccessMessage', { email: inviteEmail }),
      });
      void utils.customer.getById.invalidate({ customerId: resolvedParams.id });
      setShowInviteDialog(false);
      setInviteEmail('');
    },
    onError: (error) => {
      console.error('Invite customer error:', error.message);
      toast({
        title: t('invitation.inviteError'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  // Resend invitation mutation
  const resendMutation = api.customer.revokeAndResendInvitation.useMutation({
    onSuccess: () => {
      toast({
        title: t('invitation.resendSuccess'),
        description: t('invitation.resendSuccessMessage', { email: inviteEmail }),
      });
      void utils.customer.getById.invalidate({ customerId: resolvedParams.id });
      setShowInviteDialog(false);
      setInviteEmail('');
    },
    onError: (error) => {
      console.error('Resend invitation error:', error.message);
      toast({
        title: t('invitation.resendError'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  // Identity document upload state
  const [uploadingDoc, setUploadingDoc] = useState<string | null>(null); // e.g. "0-front", "0-back"
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingUploadRef = useRef<{ directorIndex: number; side: 'front' | 'back' } | null>(null);

  // Update mutation
  const updateMutation = api.customer.update.useMutation({
    onSuccess: () => {
      toast({
        title: t('edit.updateSuccess'),
        description: t('edit.updateSuccessMessage'),
      });
      void utils.customer.getById.invalidate({ customerId: resolvedParams.id });
      setIsEditing(false);
    },
    onError: (error) => {
      console.error('Update customer error:', error.message);
      toast({
        title: t('edit.updateError'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  const handleIdDocUpload = useCallback(async (
    file: File,
    directorIndex: number,
    side: 'front' | 'back',
    director: { idDocumentType?: string | null }
  ) => {
    const uploadKey = `${directorIndex}-${side}`;
    setUploadingDoc(uploadKey);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('customerId', resolvedParams.id);
      formData.append('directorIndex', String(directorIndex));
      formData.append('documentType', director.idDocumentType || 'DRIVER_LICENSE');
      formData.append('side', side);

      const response = await fetch('/api/upload/identity-document', {
        method: 'POST',
        body: formData,
      });

      const result = await response.json() as { success: boolean; publicUrl?: string; error?: string };

      if (!result.success) {
        throw new Error(result.error || 'Upload failed');
      }

      // Update the customer record with the new document URL
      const directors = customer?.directors || [];
      const updatedDirectors = directors.map((d, i) => ({
        familyName: d.familyName,
        givenNames: d.givenNames,
        residentialAddress: {
          street: d.residentialAddress?.street || '',
          suburb: d.residentialAddress?.suburb || '',
          state: d.residentialAddress?.state || '',
          postcode: d.residentialAddress?.postcode || '',
        },
        dateOfBirth: new Date(d.dateOfBirth),
        driverLicenseNumber: d.driverLicenseNumber || '',
        licenseState: (d.licenseState || 'NSW') as 'NSW' | 'VIC' | 'QLD' | 'SA' | 'WA' | 'TAS' | 'NT' | 'ACT',
        licenseExpiry: new Date(d.licenseExpiry),
        position: d.position || undefined,
        idDocumentType: (d.idDocumentType || 'DRIVER_LICENSE') as 'DRIVER_LICENSE' | 'PASSPORT',
        idDocumentFrontUrl: i === directorIndex && side === 'front' ? result.publicUrl : (d.idDocumentFrontUrl || undefined),
        idDocumentBackUrl: i === directorIndex && side === 'back' ? result.publicUrl : (d.idDocumentBackUrl || undefined),
        idDocumentUploadedAt: i === directorIndex ? new Date() : (d.idDocumentUploadedAt ? new Date(d.idDocumentUploadedAt) : undefined),
      }));

      updateMutation.mutate({
        customerId: resolvedParams.id,
        directors: updatedDirectors,
      });

      toast({
        title: t('identityDocuments.uploadSuccess'),
      });
    } catch (error) {
      console.error('Identity document upload error:', error);
      toast({
        title: t('identityDocuments.uploadError'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setUploadingDoc(null);
    }
  }, [resolvedParams.id, customer, updateMutation, toast, t]);

  const triggerIdDocUpload = useCallback((directorIndex: number, side: 'front' | 'back') => {
    pendingUploadRef.current = { directorIndex, side };
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const pending = pendingUploadRef.current;
    if (!file || !pending || !customer?.directors) return;

    const director = customer.directors[pending.directorIndex];
    if (director) {
      void handleIdDocUpload(file, pending.directorIndex, pending.side, director);
    }

    // Reset input so the same file can be re-selected
    e.target.value = '';
    pendingUploadRef.current = null;
  }, [customer, handleIdDocUpload]);

  // Regenerate PDF mutation
  const regeneratePdfMutation = api.customer.regenerateCreditApplicationPdf.useMutation({
    onSuccess: () => {
      toast({
        title: t('credit.generateSuccess'),
        description: t('credit.generateSuccessDescription'),
      });
      void utils.customer.getById.invalidate({ customerId: resolvedParams.id });
    },
    onError: (error) => {
      console.error('Regenerate PDF error:', error.message);
      toast({
        title: t('credit.generateError'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  // Re-geocode address mutation (admin recovery for customers with missing coordinates)
  const regeocodeMutation = api.customer.regeocodeAddress.useMutation({
    onSuccess: (data) => {
      toast({
        title: t('coordinates.regeocodeSuccess'),
        description: `${data.latitude.toFixed(4)}, ${data.longitude.toFixed(4)}`,
      });
      void utils.customer.getById.invalidate({ customerId: resolvedParams.id });
    },
    onError: (error) => {
      console.error('Re-geocode error:', error.message);
      toast({
        title: t('coordinates.regeocodeFailed'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const handleSuspend = () => {
    if (!suspendReason.trim() || suspendReason.length < 10) {
      toast({
        title: t('suspension.reasonRequired'),
        description: t('suspension.reasonMinLength'),
        variant: 'destructive',
      });
      return;
    }
    suspendMutation.mutate({
      customerId: resolvedParams.id,
      reason: suspendReason,
    });
  };

  const handleActivate = () => {
    activateMutation.mutate({
      customerId: resolvedParams.id,
      notes: activateNotes || undefined,
    });
  };

  const handleClose = () => {
    if (!closeReason.trim() || closeReason.length < 10) {
      toast({
        title: t('closure.reasonRequired'),
        description: t('closure.reasonMinLength'),
        variant: 'destructive',
      });
      return;
    }
    closeMutation.mutate({
      customerId: resolvedParams.id,
      reason: closeReason,
    });
  };

  const handleStartEdit = () => {
    if (!customer) return;

    // Map directors to form data
    const directorsData: DirectorFormData[] = (customer.directors || []).map((d) => ({
      familyName: d.familyName,
      givenNames: d.givenNames,
      residentialAddress: {
        street: d.residentialAddress?.street || '',
        suburb: d.residentialAddress?.suburb || '',
        state: d.residentialAddress?.state || '',
        postcode: d.residentialAddress?.postcode || '',
      },
      dateOfBirth: d.dateOfBirth ? new Date(d.dateOfBirth).toISOString().split('T')[0] : '',
      driverLicenseNumber: d.driverLicenseNumber || '',
      licenseState: d.licenseState || '',
      licenseExpiry: d.licenseExpiry ? new Date(d.licenseExpiry).toISOString().split('T')[0] : '',
      position: d.position || '',
      // Preserve ID document fields
      idDocumentType: d.idDocumentType || undefined,
      idDocumentFrontUrl: d.idDocumentFrontUrl || undefined,
      idDocumentBackUrl: d.idDocumentBackUrl || undefined,
      idDocumentUploadedAt: d.idDocumentUploadedAt ? new Date(d.idDocumentUploadedAt).toISOString() : undefined,
    }));

    // Map trade references to form data
    const tradeRefsData: TradeReferenceFormData[] = (customer.tradeReferences || []).map((r) => ({
      companyName: r.companyName,
      contactPerson: r.contactPerson,
      phone: r.phone,
      email: r.email,
    }));

    setEditForm({
      // Contact person
      firstName: customer.contactPerson.firstName,
      lastName: customer.contactPerson.lastName,
      email: customer.contactPerson.email,
      phone: customer.contactPerson.phone,
      mobile: customer.contactPerson.mobile || '',
      // Delivery address
      street: customer.deliveryAddress.street,
      suburb: customer.deliveryAddress.suburb,
      state: customer.deliveryAddress.state,
      postcode: customer.deliveryAddress.postcode,
      deliveryInstructions: customer.deliveryAddress.deliveryInstructions || '',
      areaId: customer.deliveryAddress.areaId || undefined,
      latitude: customer.deliveryAddress.latitude ?? undefined,
      longitude: customer.deliveryAddress.longitude ?? undefined,
      // Business info
      businessName: customer.businessName,
      tradingName: customer.tradingName || '',
      abn: customer.abn,
      acn: customer.acn || '',
      accountType: (customer.accountType as (typeof ACCOUNT_TYPES)[number]) || 'company',
      // Billing address
      billingStreet: customer.billingAddress?.street || '',
      billingSuburb: customer.billingAddress?.suburb || '',
      billingState: customer.billingAddress?.state || '',
      billingPostcode: customer.billingAddress?.postcode || '',
      // Postal address
      postalStreet: customer.postalAddress?.street || '',
      postalSuburb: customer.postalAddress?.suburb || '',
      postalState: customer.postalAddress?.state || '',
      postalPostcode: customer.postalAddress?.postcode || '',
      postalSameAsBilling: false,
      // Financial details
      bankName: customer.financialDetails?.bankName || '',
      accountName: customer.financialDetails?.accountName || '',
      bsb: customer.financialDetails?.bsb || '',
      accountNumber: customer.financialDetails?.accountNumber || '',
      // Directors and trade references
      directors: directorsData,
      tradeReferences: tradeRefsData,
      // SMS reminder preferences
      smsReminderEnabled: customer.smsReminderPreferences?.enabled ?? false,
      smsReminderDays: (customer.smsReminderPreferences?.reminderDays as DayOfWeek[]) || [],
    });
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  const handleSaveEdit = () => {
    // Validate ABN if provided
    if (editForm.abn && !validateABN(editForm.abn)) {
      toast({
        title: t('edit.validationError'),
        description: t('edit.abnInvalid'),
        variant: 'destructive',
      });
      return;
    }

    // Build the mutation payload
    const payload: Parameters<typeof updateMutation.mutate>[0] = {
      customerId: resolvedParams.id,
      contactPerson: {
        firstName: editForm.firstName,
        lastName: editForm.lastName,
        email: editForm.email,
        phone: editForm.phone,
        mobile: editForm.mobile || undefined,
      },
      deliveryAddress: {
        street: editForm.street,
        suburb: editForm.suburb,
        state: editForm.state,
        postcode: editForm.postcode,
        deliveryInstructions: editForm.deliveryInstructions || undefined,
        areaId: editForm.areaId || undefined,
        latitude: editForm.latitude || undefined,
        longitude: editForm.longitude || undefined,
      },
      businessInfo: {
        businessName: editForm.businessName,
        tradingName: editForm.tradingName || null,
        abn: editForm.abn,
        acn: editForm.acn || null,
        accountType: editForm.accountType,
      },
    };

    // Add billing address if provided
    if (editForm.billingStreet && editForm.billingSuburb && editForm.billingState && editForm.billingPostcode) {
      payload.billingAddress = {
        street: editForm.billingStreet,
        suburb: editForm.billingSuburb,
        state: editForm.billingState,
        postcode: editForm.billingPostcode,
      };
    } else {
      payload.billingAddress = null;
    }

    // Handle postal address
    if (editForm.postalSameAsBilling) {
      payload.postalSameAsBilling = true;
    } else if (editForm.postalStreet && editForm.postalSuburb && editForm.postalState && editForm.postalPostcode) {
      payload.postalAddress = {
        street: editForm.postalStreet,
        suburb: editForm.postalSuburb,
        state: editForm.postalState,
        postcode: editForm.postalPostcode,
      };
    } else {
      payload.postalAddress = null;
    }

    // Add directors
    if (editForm.directors.length > 0) {
      payload.directors = editForm.directors.map((d) => ({
        familyName: d.familyName,
        givenNames: d.givenNames,
        residentialAddress: {
          street: d.residentialAddress.street,
          suburb: d.residentialAddress.suburb,
          state: d.residentialAddress.state,
          postcode: d.residentialAddress.postcode,
        },
        dateOfBirth: new Date(d.dateOfBirth),
        driverLicenseNumber: d.driverLicenseNumber,
        licenseState: d.licenseState as 'NSW' | 'VIC' | 'QLD' | 'SA' | 'WA' | 'TAS' | 'NT' | 'ACT',
        licenseExpiry: new Date(d.licenseExpiry),
        position: d.position || undefined,
        // Preserve ID document fields
        idDocumentType: d.idDocumentType as 'DRIVER_LICENSE' | 'PASSPORT' | undefined,
        idDocumentFrontUrl: d.idDocumentFrontUrl || undefined,
        idDocumentBackUrl: d.idDocumentBackUrl || undefined,
        idDocumentUploadedAt: d.idDocumentUploadedAt ? new Date(d.idDocumentUploadedAt) : undefined,
      }));
    }

    // Add financial details if provided
    if (editForm.bankName && editForm.accountName && editForm.bsb && editForm.accountNumber) {
      payload.financialDetails = {
        bankName: editForm.bankName,
        accountName: editForm.accountName,
        bsb: editForm.bsb,
        accountNumber: editForm.accountNumber,
      };
    } else {
      payload.financialDetails = null;
    }

    // Add trade references
    if (editForm.tradeReferences.length > 0) {
      payload.tradeReferences = editForm.tradeReferences.map((r) => ({
        companyName: r.companyName,
        contactPerson: r.contactPerson,
        phone: r.phone,
        email: r.email,
      }));
    }

    // Add SMS reminder preferences
    payload.smsReminderPreferences = {
      enabled: editForm.smsReminderEnabled,
      reminderDays: editForm.smsReminderEnabled ? editForm.smsReminderDays : [],
    };

    updateMutation.mutate(payload);
  };

  // Helper functions for array fields
  const addDirector = () => {
    setEditForm({
      ...editForm,
      directors: [
        ...editForm.directors,
        {
          familyName: '',
          givenNames: '',
          residentialAddress: { street: '', suburb: '', state: '', postcode: '' },
          dateOfBirth: '',
          driverLicenseNumber: '',
          licenseState: '',
          licenseExpiry: '',
          position: '',
        },
      ],
    });
  };

  const removeDirector = (index: number) => {
    setEditForm({
      ...editForm,
      directors: editForm.directors.filter((_, i) => i !== index),
    });
  };

  const updateDirector = (index: number, field: keyof DirectorFormData, value: string | object) => {
    const updatedDirectors = [...editForm.directors];
    if (field === 'residentialAddress' && typeof value === 'object') {
      updatedDirectors[index] = { ...updatedDirectors[index], residentialAddress: value as DirectorFormData['residentialAddress'] };
    } else {
      updatedDirectors[index] = { ...updatedDirectors[index], [field]: value };
    }
    setEditForm({ ...editForm, directors: updatedDirectors });
  };

  const addTradeReference = () => {
    setEditForm({
      ...editForm,
      tradeReferences: [
        ...editForm.tradeReferences,
        { companyName: '', contactPerson: '', phone: '', email: '' },
      ],
    });
  };

  const removeTradeReference = (index: number) => {
    setEditForm({
      ...editForm,
      tradeReferences: editForm.tradeReferences.filter((_, i) => i !== index),
    });
  };

  const updateTradeReference = (index: number, field: keyof TradeReferenceFormData, value: string) => {
    const updatedRefs = [...editForm.tradeReferences];
    updatedRefs[index] = { ...updatedRefs[index], [field]: value };
    setEditForm({ ...editForm, tradeReferences: updatedRefs });
  };

  if (isLoading) {
    return (
      <div className="container mx-auto max-w-6xl px-4 py-8">
        <Skeleton className="h-10 w-40 mb-6" />
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
          <div className="space-y-6">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="container mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-col items-center justify-center py-12">
          <p className="text-destructive text-lg mb-2">{t('errorLoading')}</p>
          <p className="text-sm text-muted-foreground">{error?.message}</p>
          <Button
            variant="outline"
            onClick={() => router.push(`/${resolvedParams.locale}/customers`)}
            className="mt-4"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('backToCustomers')}
          </Button>
        </div>
      </div>
    );
  }

  const orders = (ordersData?.orders ?? []) as Order[];
  const creditApp = customer.creditApplication;
  const isSuspended = customer.status === 'suspended';
  const isClosed = customer.status === 'closed';

  const orderColumns: TableColumn<Order>[] = [
    {
      key: 'orderNumber',
      label: tOrders('orderNumber'),
      className: 'font-medium',
      render: (order) => `#${order.orderNumber}`,
    },
    {
      key: 'date',
      label: tOrders('date'),
      render: (order) => formatDate(order.orderedAt),
    },
    {
      key: 'status',
      label: tCommon('status'),
      render: (order) => <StatusBadge status={order.status} />,
    },
    {
      key: 'items',
      label: tOrders('items'),
      render: (order) => order.items.length,
    },
    {
      key: 'total',
      label: tCommon('total'),
      render: (order) => formatAUD(order.totalAmount),
    },
  ];

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <Button
            variant="ghost"
            onClick={() => router.push(`/${resolvedParams.locale}/customers`)}
            className="mb-2"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('backToCustomers')}
          </Button>
          <h1 className="text-3xl font-bold">{customer.businessName}</h1>
          <div className="flex items-center gap-2 mt-2">
            <StatusBadge status={customer.status as StatusType} />
            {isSuspended && customer.suspensionReason && (
              <span className="text-sm text-muted-foreground">
                - {customer.suspensionReason}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {!isEditing && !isClosed && (
            <Button onClick={handleStartEdit} variant="outline">
              <Pencil className="mr-2 h-4 w-4" />
              {t('edit.editButton')}
            </Button>
          )}
          {!isClosed && (
            <>
              {isSuspended ? (
                <Button onClick={() => setShowActivateDialog(true)} variant="default" disabled={isEditing}>
                  <CheckCircle className="mr-2 h-4 w-4" />
                  {t('suspension.activate')}
                </Button>
              ) : (
                <Button onClick={() => setShowSuspendDialog(true)} variant="destructive" disabled={isEditing}>
                  <Ban className="mr-2 h-4 w-4" />
                  {t('suspension.suspend')}
                </Button>
              )}
              <Button
                onClick={() => setShowCloseDialog(true)}
                variant="destructive"
                disabled={isEditing}
              >
                <XCircle className="mr-2 h-4 w-4" />
                {t('closure.close')}
              </Button>
            </>
          )}
          {/* Invite / Resend Invitation button */}
          {customer.clerkUserId.startsWith('admin_created_') && (
            <>
              {customer.portalInvitationStatus === 'invited' ? (
                <Button
                  variant="outline"
                  disabled={isEditing}
                  onClick={() => {
                    setInviteEmail(customer.portalInvitedEmail || customer.contactPerson.email);
                    setShowInviteDialog(true);
                  }}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t('invitation.resendButton')}
                </Button>
              ) : customer.portalInvitationStatus !== 'accepted' ? (
                <Button
                  variant="outline"
                  disabled={isEditing}
                  onClick={() => {
                    setInviteEmail(customer.contactPerson.email);
                    setShowInviteDialog(true);
                  }}
                >
                  <Send className="mr-2 h-4 w-4" />
                  {t('invitation.inviteButton')}
                </Button>
              ) : null}
            </>
          )}
          {/* Portal status badge */}
          {customer.portalInvitationStatus === 'invited' && (
            <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-200">
              {t('invitation.statusInvited')}
            </Badge>
          )}
          {customer.portalInvitationStatus === 'accepted' && (
            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
              {t('invitation.statusAccepted')}
            </Badge>
          )}
          <Button
            variant="outline"
            disabled={isEditing || isClosed}
            onClick={() =>
              router.push(`/${resolvedParams.locale}/customers/${resolvedParams.id}/credit-review`)
            }
          >
            <FileText className="mr-2 h-4 w-4" />
            {tCustomers('reviewCredit')}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left Column - Customer Info */}
        <div className="lg:col-span-2 space-y-6">
          {/* Business Information */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="h-5 w-5" />
                {t('businessInfo.title')}
                {isEditing && (
                  <Badge variant="outline" className="ml-2">{t('edit.editMode')}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {isEditing ? (
                <>
                  <div>
                    <Label htmlFor="businessName" className="text-sm text-muted-foreground">{t('businessInfo.businessName')}</Label>
                    <Input
                      id="businessName"
                      value={editForm.businessName}
                      onChange={(e) => setEditForm({ ...editForm, businessName: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="tradingName" className="text-sm text-muted-foreground">{t('businessInfo.tradingName')}</Label>
                    <Input
                      id="tradingName"
                      value={editForm.tradingName}
                      onChange={(e) => setEditForm({ ...editForm, tradingName: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="abn" className="text-sm text-muted-foreground">{t('businessInfo.abn')}</Label>
                    <Input
                      id="abn"
                      value={editForm.abn}
                      onChange={(e) => setEditForm({ ...editForm, abn: e.target.value.replace(/\D/g, '').slice(0, 11) })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="acn" className="text-sm text-muted-foreground">{t('businessInfo.acn')}</Label>
                    <Input
                      id="acn"
                      value={editForm.acn}
                      onChange={(e) => setEditForm({ ...editForm, acn: e.target.value })}
                      className="mt-1"
                      maxLength={9}
                    />
                  </div>
                  <div>
                    <Label htmlFor="accountType" className="text-sm text-muted-foreground">{t('businessInfo.accountType')}</Label>
                    <Select
                      value={editForm.accountType}
                      onValueChange={(value) => setEditForm({ ...editForm, accountType: value as (typeof ACCOUNT_TYPES)[number] })}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ACCOUNT_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {t(`businessInfo.accountTypes.${type}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <p className="text-sm text-muted-foreground">{t('businessInfo.businessName')}</p>
                    <p className="font-medium">{customer.businessName}</p>
                  </div>
                  {customer.tradingName && (
                    <div>
                      <p className="text-sm text-muted-foreground">{t('businessInfo.tradingName')}</p>
                      <p className="font-medium">{customer.tradingName}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-sm text-muted-foreground">{t('businessInfo.abn')}</p>
                    <p className="font-medium">{customer.abn}</p>
                  </div>
                  {customer.acn && (
                    <div>
                      <p className="text-sm text-muted-foreground">{t('businessInfo.acn')}</p>
                      <p className="font-medium">{customer.acn}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-sm text-muted-foreground">{t('businessInfo.accountType')}</p>
                    <p className="font-medium">{t(`businessInfo.accountTypes.${customer.accountType}`)}</p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Contact Information */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail className="h-5 w-5" />
                {t('contactInfo.title')}
                {isEditing && (
                  <Badge variant="outline" className="ml-2">{t('edit.editMode')}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {isEditing ? (
                <>
                  <div>
                    <Label htmlFor="firstName" className="text-sm text-muted-foreground">{t('contactInfo.firstName')}</Label>
                    <Input
                      id="firstName"
                      value={editForm.firstName}
                      onChange={(e) => setEditForm({ ...editForm, firstName: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="lastName" className="text-sm text-muted-foreground">{t('contactInfo.lastName')}</Label>
                    <Input
                      id="lastName"
                      value={editForm.lastName}
                      onChange={(e) => setEditForm({ ...editForm, lastName: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="email" className="text-sm text-muted-foreground">{t('contactInfo.email')}</Label>
                    <Input
                      id="email"
                      type="email"
                      value={editForm.email}
                      onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="phone" className="text-sm text-muted-foreground">{t('contactInfo.phone')}</Label>
                    <Input
                      id="phone"
                      value={editForm.phone}
                      onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="mobile" className="text-sm text-muted-foreground">{t('contactInfo.mobile')}</Label>
                    <Input
                      id="mobile"
                      value={editForm.mobile}
                      onChange={(e) => setEditForm({ ...editForm, mobile: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <p className="text-sm text-muted-foreground">{t('contactInfo.name')}</p>
                    <p className="font-medium">
                      {customer.contactPerson.firstName} {customer.contactPerson.lastName}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <p>{customer.contactPerson.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <p>{customer.contactPerson.phone}</p>
                  </div>
                  {customer.contactPerson.mobile && (
                    <div className="flex items-center gap-2">
                      <Phone className="h-4 w-4 text-muted-foreground" />
                      <p>{customer.contactPerson.mobile}</p>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Delivery Address */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="h-5 w-5" />
                {t('address.title')}
                {isEditing && (
                  <Badge variant="outline" className="ml-2">{t('edit.editMode')}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isEditing ? (
                <div className="space-y-4">
                  <AddressSearch
                    id="deliveryAddress"
                    onAddressSelect={(address: AddressResult) => {
                      setEditForm({
                        ...editForm,
                        street: address.street,
                        suburb: address.suburb,
                        state: address.state,
                        postcode: address.postcode,
                        areaId: undefined, // Reset area to trigger auto-lookup
                        latitude: address.latitude || undefined,
                        longitude: address.longitude || undefined,
                      });
                    }}
                    defaultValues={{
                      street: editForm.street,
                      suburb: editForm.suburb,
                      state: editForm.state,
                      postcode: editForm.postcode,
                    }}
                  />
                  <div>
                    <Label htmlFor="areaId" className="text-sm text-muted-foreground">{t('address.area')}</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <select
                        id="areaId"
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={editForm.areaId ?? ''}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            areaId: e.target.value || undefined,
                          })
                        }
                      >
                        <option value="">{t('address.areaAutoDetect')}</option>
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
                    {editForm.areaId && areas && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground mt-2">
                        <MapPin className="h-3 w-3" />
                        <span>{t('address.assignedTo')}:</span>
                        <AreaBadge
                          area={
                            areas.find((a) => a.id === editForm.areaId) ?? {
                              name: 'unknown',
                              displayName: 'Unknown',
                              colorVariant: 'default',
                            }
                          }
                          className="text-xs"
                        />
                      </div>
                    )}
                    {!editForm.areaId && autoArea && (
                      <p className="text-sm text-muted-foreground mt-2">
                        {t('address.willAutoAssignTo', { area: autoArea.displayName })}
                      </p>
                    )}
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor="deliveryInstructions" className="text-sm text-muted-foreground">{t('address.deliveryInstructions')}</Label>
                    <textarea
                      id="deliveryInstructions"
                      value={editForm.deliveryInstructions}
                      onChange={(e) => setEditForm({ ...editForm, deliveryInstructions: e.target.value })}
                      className="mt-1 flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      rows={3}
                    />
                  </div>
                </div>
              ) : (
                <>
                  <p>
                    {customer.deliveryAddress.street}
                    <br />
                    {customer.deliveryAddress.suburb}, {customer.deliveryAddress.state}{' '}
                    {customer.deliveryAddress.postcode}
                  </p>
                  {customer.deliveryAddress.areaName && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">{tCommon('area')}:</span>
                      <AreaBadge area={customer.deliveryAddress.areaName} />
                    </div>
                  )}
                  {(() => {
                    const lat = customer.deliveryAddress.latitude;
                    const lng = customer.deliveryAddress.longitude;
                    const hasValidCoords = !!lat && !!lng && lat !== 0 && lng !== 0;
                    return (
                      <div className="mt-3 flex items-center gap-2 flex-wrap">
                        {hasValidCoords ? (
                          <span className="text-xs text-muted-foreground">
                            {t('coordinates.label')}: {lat!.toFixed(4)}, {lng!.toFixed(4)}
                          </span>
                        ) : (
                          <Badge variant="destructive" className="text-xs" title={t('coordinates.missingTooltip')}>
                            {t('coordinates.missing')}
                          </Badge>
                        )}
                        <Button
                          type="button"
                          variant={hasValidCoords ? 'ghost' : 'outline'}
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() =>
                            regeocodeMutation.mutate({ customerId: resolvedParams.id })
                          }
                          disabled={regeocodeMutation.isPending}
                        >
                          {regeocodeMutation.isPending ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <RefreshCw className="mr-1 h-3 w-3" />
                          )}
                          {t('coordinates.regeocode')}
                        </Button>
                      </div>
                    );
                  })()}
                  {customer.deliveryAddress.deliveryInstructions && (
                    <div className="mt-4">
                      <p className="text-sm text-muted-foreground">{t('address.deliveryInstructions')}</p>
                      <p className="text-sm">{customer.deliveryAddress.deliveryInstructions}</p>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Billing Address */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="h-5 w-5" />
                {t('billingAddress.title')}
                {isEditing && (
                  <Badge variant="outline" className="ml-2">{t('edit.editMode')}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isEditing ? (
                <AddressSearch
                  id="billingAddress"
                  onAddressSelect={(address: AddressResult) => {
                    setEditForm({
                      ...editForm,
                      billingStreet: address.street,
                      billingSuburb: address.suburb,
                      billingState: address.state,
                      billingPostcode: address.postcode,
                    });
                  }}
                  defaultValues={{
                    street: editForm.billingStreet,
                    suburb: editForm.billingSuburb,
                    state: editForm.billingState,
                    postcode: editForm.billingPostcode,
                  }}
                />
              ) : customer.billingAddress ? (
                <p>
                  {customer.billingAddress.street}<br />
                  {customer.billingAddress.suburb}, {customer.billingAddress.state} {customer.billingAddress.postcode}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{t('billingAddress.notProvided')}</p>
              )}
            </CardContent>
          </Card>

          {/* Postal Address */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail className="h-5 w-5" />
                {t('postalAddress.title')}
                {isEditing && (
                  <Badge variant="outline" className="ml-2">{t('edit.editMode')}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isEditing ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="postalSameAsBilling"
                      checked={editForm.postalSameAsBilling}
                      onCheckedChange={(checked) => setEditForm({ ...editForm, postalSameAsBilling: checked as boolean })}
                    />
                    <Label htmlFor="postalSameAsBilling" className="text-sm">{t('postalAddress.sameAsBilling')}</Label>
                  </div>
                  {!editForm.postalSameAsBilling && (
                    <AddressSearch
                      id="postalAddress"
                      onAddressSelect={(address: AddressResult) => {
                        setEditForm({
                          ...editForm,
                          postalStreet: address.street,
                          postalSuburb: address.suburb,
                          postalState: address.state,
                          postalPostcode: address.postcode,
                        });
                      }}
                      defaultValues={{
                        street: editForm.postalStreet,
                        suburb: editForm.postalSuburb,
                        state: editForm.postalState,
                        postcode: editForm.postalPostcode,
                      }}
                    />
                  )}
                </div>
              ) : customer.postalAddress ? (
                <p>
                  {customer.postalAddress.street}<br />
                  {customer.postalAddress.suburb}, {customer.postalAddress.state} {customer.postalAddress.postcode}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{t('postalAddress.notProvided')}</p>
              )}
            </CardContent>
          </Card>

          {/* Financial Details */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Banknote className="h-5 w-5" />
                {t('financialDetails.title')}
                {isEditing && (
                  <Badge variant="outline" className="ml-2">{t('edit.editMode')}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isEditing ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="bankName" className="text-sm text-muted-foreground">{t('financialDetails.bankName')}</Label>
                    <Input
                      id="bankName"
                      value={editForm.bankName}
                      onChange={(e) => setEditForm({ ...editForm, bankName: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="accountName" className="text-sm text-muted-foreground">{t('financialDetails.accountName')}</Label>
                    <Input
                      id="accountName"
                      value={editForm.accountName}
                      onChange={(e) => setEditForm({ ...editForm, accountName: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="bsb" className="text-sm text-muted-foreground">{t('financialDetails.bsb')}</Label>
                    <Input
                      id="bsb"
                      value={editForm.bsb}
                      onChange={(e) => setEditForm({ ...editForm, bsb: e.target.value })}
                      className="mt-1"
                      maxLength={6}
                      placeholder="000000"
                    />
                  </div>
                  <div>
                    <Label htmlFor="accountNumber" className="text-sm text-muted-foreground">{t('financialDetails.accountNumber')}</Label>
                    <Input
                      id="accountNumber"
                      value={editForm.accountNumber}
                      onChange={(e) => setEditForm({ ...editForm, accountNumber: e.target.value })}
                      className="mt-1"
                      maxLength={10}
                    />
                  </div>
                </div>
              ) : customer.financialDetails ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <p className="text-sm text-muted-foreground">{t('financialDetails.bankName')}</p>
                    <p className="font-medium">{customer.financialDetails.bankName}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{t('financialDetails.accountName')}</p>
                    <p className="font-medium">{customer.financialDetails.accountName}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{t('financialDetails.bsb')}</p>
                    <p className="font-medium">{customer.financialDetails.bsb}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{t('financialDetails.accountNumber')}</p>
                    <p className="font-medium">{customer.financialDetails.accountNumber}</p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('financialDetails.notProvided')}</p>
              )}
            </CardContent>
          </Card>

          {/* Directors */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                {t('directors.title')}
                {isEditing && (
                  <Badge variant="outline" className="ml-2">{t('edit.editMode')}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isEditing ? (
                <div className="space-y-6">
                  {editForm.directors.map((director, index) => (
                    <div key={index} className="border rounded-lg p-4 space-y-4">
                      <div className="flex justify-between items-center">
                        <h4 className="font-medium">{t('directors.director')} {index + 1}</h4>
                        <Button variant="ghost" size="sm" onClick={() => removeDirector(index)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <Label className="text-sm text-muted-foreground">{t('directors.familyName')}</Label>
                          <Input
                            value={director.familyName}
                            onChange={(e) => updateDirector(index, 'familyName', e.target.value)}
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <Label className="text-sm text-muted-foreground">{t('directors.givenNames')}</Label>
                          <Input
                            value={director.givenNames}
                            onChange={(e) => updateDirector(index, 'givenNames', e.target.value)}
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <Label className="text-sm text-muted-foreground">{t('directors.dateOfBirth')}</Label>
                          <Input
                            type="date"
                            value={director.dateOfBirth}
                            onChange={(e) => updateDirector(index, 'dateOfBirth', e.target.value)}
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <Label className="text-sm text-muted-foreground">{t('directors.position')}</Label>
                          <Input
                            value={director.position}
                            onChange={(e) => updateDirector(index, 'position', e.target.value)}
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <Label className="text-sm text-muted-foreground">{t('directors.driverLicense')}</Label>
                          <Input
                            value={director.driverLicenseNumber}
                            onChange={(e) => updateDirector(index, 'driverLicenseNumber', e.target.value)}
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <Label className="text-sm text-muted-foreground">{t('directors.licenseState')}</Label>
                          <Select
                            value={director.licenseState}
                            onValueChange={(value) => updateDirector(index, 'licenseState', value)}
                          >
                            <SelectTrigger className="mt-1">
                              <SelectValue placeholder={t('directors.licenseState')} />
                            </SelectTrigger>
                            <SelectContent>
                              {AUSTRALIAN_STATES.map((state) => (
                                <SelectItem key={state} value={state}>{state}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label className="text-sm text-muted-foreground">{t('directors.licenseExpiry')}</Label>
                          <Input
                            type="date"
                            value={director.licenseExpiry}
                            onChange={(e) => updateDirector(index, 'licenseExpiry', e.target.value)}
                            className="mt-1"
                          />
                        </div>
                      </div>
                      <div>
                        <Label className="text-sm text-muted-foreground mb-2 block">{t('directors.residentialAddress')}</Label>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div className="sm:col-span-2">
                            <Input
                              placeholder={t('address.street')}
                              value={director.residentialAddress.street}
                              onChange={(e) => updateDirector(index, 'residentialAddress', { ...director.residentialAddress, street: e.target.value })}
                            />
                          </div>
                          <div>
                            <Input
                              placeholder={t('address.suburb')}
                              value={director.residentialAddress.suburb}
                              onChange={(e) => updateDirector(index, 'residentialAddress', { ...director.residentialAddress, suburb: e.target.value })}
                            />
                          </div>
                          <div>
                            <Input
                              placeholder={t('address.state')}
                              value={director.residentialAddress.state}
                              onChange={(e) => updateDirector(index, 'residentialAddress', { ...director.residentialAddress, state: e.target.value })}
                            />
                          </div>
                          <div>
                            <Input
                              placeholder={t('address.postcode')}
                              value={director.residentialAddress.postcode}
                              onChange={(e) => updateDirector(index, 'residentialAddress', { ...director.residentialAddress, postcode: e.target.value })}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                  <Button variant="outline" onClick={addDirector} className="w-full">
                    <Plus className="h-4 w-4 mr-2" />
                    {t('directors.addDirector')}
                  </Button>
                </div>
              ) : customer.directors && customer.directors.length > 0 ? (
                <div className="space-y-4">
                  {customer.directors.map((director, index) => (
                    <div key={index} className="border rounded-lg p-4">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div>
                          <p className="text-sm text-muted-foreground">{t('contactInfo.name')}</p>
                          <p className="font-medium">{director.givenNames} {director.familyName}</p>
                        </div>
                        {director.position && (
                          <div>
                            <p className="text-sm text-muted-foreground">{t('directors.position')}</p>
                            <p className="font-medium">{director.position}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('directors.noDirectors')}</p>
              )}
            </CardContent>
          </Card>

          {/* Identity Documents - Admin Only */}
          {isAdmin && customer.directors && customer.directors.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <IdCard className="h-5 w-5" />
                  {t('identityDocuments.title')}
                </CardTitle>
                <CardDescription>{t('identityDocuments.description')}</CardDescription>
              </CardHeader>
              <CardContent>
                {/* Hidden file input for uploads */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/jpg,application/pdf"
                  className="hidden"
                  onChange={handleFileInputChange}
                />
                <div className="space-y-4">
                  {customer.directors.map((director, index) => (
                    <div key={index} className="border rounded-lg p-4">
                      <div className="mb-3">
                        <p className="font-medium">{director.givenNames} {director.familyName}</p>
                        <p className="text-sm text-muted-foreground">
                          {director.idDocumentType === 'DRIVER_LICENSE'
                            ? t('identityDocuments.driverLicense')
                            : t('identityDocuments.passport')}
                        </p>
                        {director.idDocumentUploadedAt && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {t('identityDocuments.uploadedAt', { date: formatDate(director.idDocumentUploadedAt) })}
                          </p>
                        )}
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        {/* Front / Photo Page */}
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-sm text-muted-foreground">
                              {director.idDocumentType === 'DRIVER_LICENSE'
                                ? t('identityDocuments.front')
                                : t('identityDocuments.photoPage')}
                            </p>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={uploadingDoc === `${index}-front`}
                              onClick={() => triggerIdDocUpload(index, 'front')}
                            >
                              {uploadingDoc === `${index}-front` ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Upload className="h-4 w-4" />
                              )}
                              <span className="ml-1 text-xs">
                                {uploadingDoc === `${index}-front`
                                  ? t('identityDocuments.uploading')
                                  : director.idDocumentFrontUrl
                                    ? t('identityDocuments.replaceDocument')
                                    : t('identityDocuments.uploadFront')}
                              </span>
                            </Button>
                          </div>
                          {director.idDocumentFrontUrl ? (
                            director.idDocumentFrontUrl.toLowerCase().endsWith('.pdf') ? (
                              <a
                                href={director.idDocumentFrontUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 text-primary hover:underline"
                              >
                                <FileText className="h-4 w-4" />
                                {t('identityDocuments.viewPdf')}
                              </a>
                            ) : (
                              <a
                                href={director.idDocumentFrontUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <img
                                  src={director.idDocumentFrontUrl}
                                  alt={t('identityDocuments.front')}
                                  className="w-full max-w-[200px] rounded border hover:opacity-80 transition-opacity"
                                  onError={(e) => {
                                    const target = e.currentTarget;
                                    target.style.display = 'none';
                                    target.nextElementSibling?.classList.remove('hidden');
                                  }}
                                />
                                <div className="hidden flex items-center gap-2 text-muted-foreground text-sm p-4 border rounded bg-muted/50">
                                  <ImageOff className="h-4 w-4" />
                                  {t('identityDocuments.imageUnavailable')}
                                </div>
                              </a>
                            )
                          ) : (
                            <div className="flex items-center gap-2 text-muted-foreground text-sm p-4 border rounded border-dashed">
                              <ImageOff className="h-4 w-4" />
                              {t('identityDocuments.noDocuments')}
                            </div>
                          )}
                        </div>

                        {/* Back (driver license only) */}
                        {(director.idDocumentType === 'DRIVER_LICENSE' || !director.idDocumentType) && (
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-sm text-muted-foreground">{t('identityDocuments.back')}</p>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={uploadingDoc === `${index}-back`}
                                onClick={() => triggerIdDocUpload(index, 'back')}
                              >
                                {uploadingDoc === `${index}-back` ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Upload className="h-4 w-4" />
                                )}
                                <span className="ml-1 text-xs">
                                  {uploadingDoc === `${index}-back`
                                    ? t('identityDocuments.uploading')
                                    : director.idDocumentBackUrl
                                      ? t('identityDocuments.replaceDocument')
                                      : t('identityDocuments.uploadBack')}
                                </span>
                              </Button>
                            </div>
                            {director.idDocumentBackUrl ? (
                              director.idDocumentBackUrl.toLowerCase().endsWith('.pdf') ? (
                                <a
                                  href={director.idDocumentBackUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-2 text-primary hover:underline"
                                >
                                  <FileText className="h-4 w-4" />
                                  {t('identityDocuments.viewPdf')}
                                </a>
                              ) : (
                                <a
                                  href={director.idDocumentBackUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <img
                                    src={director.idDocumentBackUrl}
                                    alt={t('identityDocuments.back')}
                                    className="w-full max-w-[200px] rounded border hover:opacity-80 transition-opacity"
                                    onError={(e) => {
                                      const target = e.currentTarget;
                                      target.style.display = 'none';
                                      target.nextElementSibling?.classList.remove('hidden');
                                    }}
                                  />
                                  <div className="hidden flex items-center gap-2 text-muted-foreground text-sm p-4 border rounded bg-muted/50">
                                    <ImageOff className="h-4 w-4" />
                                    {t('identityDocuments.imageUnavailable')}
                                  </div>
                                </a>
                              )
                            ) : (
                              <div className="flex items-center gap-2 text-muted-foreground text-sm p-4 border rounded border-dashed">
                                <ImageOff className="h-4 w-4" />
                                {t('identityDocuments.noDocuments')}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {!customer.directors.some(d => d.idDocumentFrontUrl || d.idDocumentBackUrl) && (
                    <p className="text-sm text-muted-foreground">{t('identityDocuments.noDocumentsUploaded')}</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Trade References */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Briefcase className="h-5 w-5" />
                {t('tradeReferences.title')}
                {isEditing && (
                  <Badge variant="outline" className="ml-2">{t('edit.editMode')}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isEditing ? (
                <div className="space-y-4">
                  {editForm.tradeReferences.map((ref, index) => (
                    <div key={index} className="border rounded-lg p-4 space-y-4">
                      <div className="flex justify-between items-center">
                        <h4 className="font-medium">{t('tradeReferences.reference')} {index + 1}</h4>
                        <Button variant="ghost" size="sm" onClick={() => removeTradeReference(index)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <Label className="text-sm text-muted-foreground">{t('tradeReferences.companyName')}</Label>
                          <Input
                            value={ref.companyName}
                            onChange={(e) => updateTradeReference(index, 'companyName', e.target.value)}
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <Label className="text-sm text-muted-foreground">{t('tradeReferences.contactPerson')}</Label>
                          <Input
                            value={ref.contactPerson}
                            onChange={(e) => updateTradeReference(index, 'contactPerson', e.target.value)}
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <Label className="text-sm text-muted-foreground">{t('tradeReferences.phone')}</Label>
                          <Input
                            value={ref.phone}
                            onChange={(e) => updateTradeReference(index, 'phone', e.target.value)}
                            className="mt-1"
                          />
                        </div>
                        <div>
                          <Label className="text-sm text-muted-foreground">{t('tradeReferences.email')}</Label>
                          <Input
                            type="email"
                            value={ref.email}
                            onChange={(e) => updateTradeReference(index, 'email', e.target.value)}
                            className="mt-1"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <Button variant="outline" onClick={addTradeReference} className="w-full">
                    <Plus className="h-4 w-4 mr-2" />
                    {t('tradeReferences.addReference')}
                  </Button>
                </div>
              ) : customer.tradeReferences && customer.tradeReferences.length > 0 ? (
                <div className="space-y-4">
                  {customer.tradeReferences.map((ref, index) => (
                    <div key={index} className="border rounded-lg p-4">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div>
                          <p className="text-sm text-muted-foreground">{t('tradeReferences.companyName')}</p>
                          <p className="font-medium">{ref.companyName}</p>
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">{t('tradeReferences.contactPerson')}</p>
                          <p className="font-medium">{ref.contactPerson}</p>
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">{t('tradeReferences.phone')}</p>
                          <p className="font-medium">{ref.phone}</p>
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">{t('tradeReferences.email')}</p>
                          <p className="font-medium">{ref.email}</p>
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">{t('tradeReferences.verified')}</p>
                          <Badge variant={ref.verified ? 'default' : 'secondary'}>
                            {ref.verified ? t('tradeReferences.verified') : t('tradeReferences.notVerified')}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('tradeReferences.noReferences')}</p>
              )}
            </CardContent>
          </Card>

          {/* Order History */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                {tOrders('title')}
              </CardTitle>
              <CardDescription>{tOrders('recentOrders')}</CardDescription>
            </CardHeader>
            <CardContent>
              {orders.length > 0 ? (
                <ResponsiveTable data={orders} columns={orderColumns} />
              ) : (
                <p className="text-sm text-muted-foreground text-center py-8">
                  {tOrders('noOrders')}
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column - Credit & Stats */}
        <div className="space-y-6">
          {/* Credit Information */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CreditCard className="h-5 w-5" />
                {t('credit.title')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">{t('credit.status')}</span>
                <StatusBadge status={creditApp.status as StatusType} />
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">{t('credit.limit')}</span>
                <span className="font-bold text-lg">{formatAUD(creditApp.creditLimit)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">{t('credit.balance')}</span>
                <span className="font-medium">
                  {formatAUD((customer as { outstandingBalance?: number }).outstandingBalance || 0)}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">{t('credit.available')}</span>
                <span className="font-medium text-success">
                  {formatAUD(creditApp.creditLimit - ((customer as { outstandingBalance?: number }).outstandingBalance || 0))}
                </span>
              </div>
              {creditApp.paymentTerms && (
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">{t('credit.paymentTerms')}</span>
                  <span className="font-medium">{creditApp.paymentTerms}</span>
                </div>
              )}
              <div className="pt-4 border-t mt-4 space-y-2">
                {customer.creditApplicationPdfUrl ? (
                  <>
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => window.open(customer.creditApplicationPdfUrl!, '_blank')}
                    >
                      <Download className="mr-2 h-4 w-4" />
                      {t('credit.downloadApplication')}
                    </Button>
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => regeneratePdfMutation.mutate({ customerId: resolvedParams.id })}
                      disabled={regeneratePdfMutation.isPending}
                    >
                      {regeneratePdfMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                      )}
                      {t('credit.regenerateApplication')}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => regeneratePdfMutation.mutate({ customerId: resolvedParams.id })}
                    disabled={regeneratePdfMutation.isPending}
                  >
                    {regeneratePdfMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <FileText className="mr-2 h-4 w-4" />
                    )}
                    {t('credit.generateApplication')}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Account Stats */}
          <Card>
            <CardHeader>
              <CardTitle>{t('stats.title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">{t('stats.totalOrders')}</span>
                <span className="font-medium">{ordersData?.total || 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">{t('stats.memberSince')}</span>
                <span className="font-medium">{formatDate(customer.createdAt)}</span>
              </div>
            </CardContent>
          </Card>

          {/* SMS Reminder Preferences */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="h-5 w-5" />
                {t('smsReminder.title')}
                {isEditing && (
                  <Badge variant="outline" className="ml-2">{t('edit.editMode')}</Badge>
                )}
              </CardTitle>
              <CardDescription>{t('smsReminder.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {isEditing ? (
                <>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="smsReminderEnabled">{t('smsReminder.enable')}</Label>
                    <Checkbox
                      id="smsReminderEnabled"
                      checked={editForm.smsReminderEnabled}
                      onCheckedChange={(checked) => {
                        setEditForm({
                          ...editForm,
                          smsReminderEnabled: checked === true,
                          smsReminderDays: checked === true ? editForm.smsReminderDays : [],
                        });
                      }}
                      disabled={!customer.contactPerson.mobile}
                    />
                  </div>
                  {!customer.contactPerson.mobile && (
                    <p className="text-xs text-destructive">{t('smsReminder.mobileRequired')}</p>
                  )}
                  {editForm.smsReminderEnabled && (
                    <div className="space-y-2">
                      <Label>{t('smsReminder.reminderDays')}</Label>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {DAYS_OF_WEEK.map((day) => (
                          <label key={day} className="flex items-center gap-2 cursor-pointer">
                            <Checkbox
                              checked={editForm.smsReminderDays.includes(day)}
                              onCheckedChange={(checked) => {
                                const newDays = checked
                                  ? [...editForm.smsReminderDays, day]
                                  : editForm.smsReminderDays.filter((d) => d !== day);
                                setEditForm({ ...editForm, smsReminderDays: newDays });
                              }}
                            />
                            <span className="text-sm">{tDays(day)}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">{t('smsReminder.enable')}</span>
                    <Badge variant={customer.smsReminderPreferences?.enabled ? 'default' : 'secondary'}>
                      {customer.smsReminderPreferences?.enabled ? tCommon('yes') : tCommon('no')}
                    </Badge>
                  </div>
                  {customer.smsReminderPreferences?.enabled &&
                   customer.smsReminderPreferences?.reminderDays &&
                   customer.smsReminderPreferences.reminderDays.length > 0 && (
                    <div className="flex justify-between items-start">
                      <span className="text-sm text-muted-foreground">{t('smsReminder.reminderDays')}</span>
                      <span className="font-medium text-right">
                        {customer.smsReminderPreferences.reminderDays
                          .map((day) => tDays(day as DayOfWeek))
                          .join(', ')}
                      </span>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Suspension Info (if suspended) */}
          {isSuspended && (
            <Card className="border-destructive">
              <CardHeader>
                <CardTitle className="text-destructive flex items-center gap-2">
                  <Ban className="h-5 w-5" />
                  {t('suspension.suspendedAccount')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div>
                  <p className="text-sm text-muted-foreground">{t('suspension.reason')}</p>
                  <p className="text-sm">{customer.suspensionReason}</p>
                </div>
                {customer.suspendedAt && (
                  <div>
                    <p className="text-sm text-muted-foreground">{t('suspension.suspendedAt')}</p>
                    <p className="text-sm">{formatDate(customer.suspendedAt)}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Closure Info (if closed) */}
          {isClosed && (
            <Card className="border-destructive">
              <CardHeader>
                <CardTitle className="text-destructive flex items-center gap-2">
                  <XCircle className="h-5 w-5" />
                  {t('closure.closedAccount')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div>
                  <p className="text-sm text-muted-foreground">{t('closure.reason')}</p>
                  <p className="text-sm">{customer.closureReason}</p>
                </div>
                {customer.closedAt && (
                  <div>
                    <p className="text-sm text-muted-foreground">{t('closure.closedAt')}</p>
                    <p className="text-sm">{formatDate(customer.closedAt)}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Activity History */}
          <AuditLogSection entity="customer" entityId={customer.id} />
        </div>
      </div>

      {/* Suspend Dialog */}
      <AlertDialog open={showSuspendDialog} onOpenChange={setShowSuspendDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('suspension.suspendTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('suspension.suspendDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Label htmlFor="suspendReason">{t('suspension.reason')}</Label>
            <textarea
              id="suspendReason"
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              placeholder={t('suspension.reasonPlaceholder')}
              className="mt-2 flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              rows={4}
            />
            <p className="text-xs text-muted-foreground mt-1">{t('suspension.reasonMinLength')}</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={suspendMutation.isPending}>
              {tCommon('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSuspend}
              disabled={suspendMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {suspendMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('suspension.suspending')}
                </>
              ) : (
                t('suspension.confirmSuspend')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Activate Dialog */}
      <AlertDialog open={showActivateDialog} onOpenChange={setShowActivateDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('suspension.activateTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('suspension.activateDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Label htmlFor="activateNotes">{t('suspension.notes')}</Label>
            <textarea
              id="activateNotes"
              value={activateNotes}
              onChange={(e) => setActivateNotes(e.target.value)}
              placeholder={t('suspension.notesPlaceholder')}
              className="mt-2 flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              rows={3}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={activateMutation.isPending}>
              {tCommon('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleActivate}
              disabled={activateMutation.isPending}
              className="bg-success text-success-foreground hover:bg-success/90"
            >
              {activateMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('suspension.activating')}
                </>
              ) : (
                t('suspension.confirmActivate')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Close Dialog */}
      <AlertDialog open={showCloseDialog} onOpenChange={setShowCloseDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('closure.closeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('closure.closeDescription', { businessName: customer.businessName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4 space-y-4">
            <div className="p-3 bg-destructive/10 rounded-md border border-destructive/20">
              <p className="text-sm text-destructive font-medium">{t('closure.closeWarning')}</p>
            </div>
            <div>
              <Label htmlFor="closeReason">{t('closure.reason')}</Label>
              <textarea
                id="closeReason"
                value={closeReason}
                onChange={(e) => setCloseReason(e.target.value)}
                placeholder={t('closure.reasonPlaceholder')}
                className="mt-2 flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                rows={4}
              />
              <p className="text-xs text-muted-foreground mt-1">{t('closure.reasonMinLength')}</p>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={closeMutation.isPending}>
              {tCommon('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClose}
              disabled={closeMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {closeMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('closure.closing')}
                </>
              ) : (
                t('closure.confirm')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Invite Customer Dialog */}
      <AlertDialog open={showInviteDialog} onOpenChange={setShowInviteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('invitation.dialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('invitation.dialogDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="invite-email">{t('invitation.emailLabel')}</Label>
              <Input
                id="invite-email"
                type="email"
                placeholder={t('invitation.emailPlaceholder')}
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={inviteMutation.isPending || resendMutation.isPending}>
              {tCommon('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (customer?.portalInvitationStatus === 'invited') {
                  resendMutation.mutate({
                    customerId: resolvedParams.id,
                    email: inviteEmail,
                  });
                } else {
                  inviteMutation.mutate({
                    customerId: resolvedParams.id,
                    email: inviteEmail,
                  });
                }
              }}
              disabled={!inviteEmail || inviteMutation.isPending || resendMutation.isPending}
            >
              {inviteMutation.isPending || resendMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {customer?.portalInvitationStatus === 'invited'
                    ? t('invitation.resending')
                    : t('invitation.sending')}
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  {t('invitation.sendButton')}
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Floating Save/Cancel Action Bar */}
      {isEditing && (
        <div className="fixed bottom-6 right-6 flex gap-2 bg-background p-4 rounded-lg shadow-lg border z-50">
          <Button variant="outline" onClick={handleCancelEdit} disabled={updateMutation.isPending}>
            <X className="h-4 w-4 mr-2" />
            {tCommon('cancel')}
          </Button>
          <Button onClick={handleSaveEdit} disabled={updateMutation.isPending}>
            {updateMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('edit.saving')}
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                {tCommon('save')}
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
