'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { api } from '@/trpc/client';
import { formatAUD, formatCentsForInput, formatCentsForWholeInput, parseToCents, validateABN } from '@joho-erp/shared';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Input,
  Label,
  Badge,
  Skeleton,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  useToast,
} from '@joho-erp/ui';
import {
  ArrowLeft,
  Edit,
  Save,
  X,
  Loader2,
  Ban,
  CheckCircle,
  Plus,
  Package,
} from 'lucide-react';
import Link from 'next/link';
import { SupplierStatusBadge } from '../components/SupplierStatusBadge';
import { LinkProductDialog } from '../components/LinkProductDialog';
import { PermissionGate } from '@/components/permission-gate';
import type { SupplierStatus, AustralianState, PaymentMethod } from '@joho-erp/database';

interface PageProps {
  params: Promise<{ id: string; locale: string }>;
}

export default function SupplierDetailPage({ params }: PageProps) {
  const resolvedParams = use(params);
  const router = useRouter();
  const t = useTranslations('supplierDetail');
  const tCommon = useTranslations('common');
  const tErrors = useTranslations('errors');
  const tPayment = useTranslations('paymentMethods');
  const { toast } = useToast();

  const [isEditing, setIsEditing] = useState(false);
  const [showLinkProductDialog, setShowLinkProductDialog] = useState(false);
  const [showSuspendDialog, setShowSuspendDialog] = useState(false);
  const [showActivateDialog, setShowActivateDialog] = useState(false);
  const [suspendReason, setSuspendReason] = useState('');

  const utils = api.useUtils();

  const { data: supplier, isLoading, error } = api.supplier.getById.useQuery({
    id: resolvedParams.id,
  });

  // Edit form state
  const [editForm, setEditForm] = useState<{
    businessName: string;
    tradingName: string;
    abn: string;
    acn: string;
    primaryContact: {
      name: string;
      position: string;
      email: string;
      phone: string;
      mobile: string;
    };
    businessAddress: {
      street: string;
      suburb: string;
      state: AustralianState;
      postcode: string;
      country: string;
    };
    paymentTerms: string;
    paymentMethod: PaymentMethod;
    creditLimit: string;
    minimumOrderValue: string;
    leadTimeDays: string;
    deliveryDays: string;
    deliveryNotes: string;
  } | null>(null);

  const updateMutation = api.supplier.update.useMutation({
    onSuccess: () => {
      toast({
        title: t('updateSuccess'),
        variant: 'default',
      });
      setIsEditing(false);
      void utils.supplier.getById.invalidate({ id: resolvedParams.id });
    },
    onError: (error) => {
      console.error('Update supplier error:', error.message);
      toast({
        title: t('updateError'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  const suspendMutation = api.supplier.updateStatus.useMutation({
    onSuccess: () => {
      toast({
        title: t('suspendSuccess'),
        variant: 'default',
      });
      setShowSuspendDialog(false);
      setSuspendReason('');
      void utils.supplier.getById.invalidate({ id: resolvedParams.id });
    },
    onError: (error) => {
      console.error('Suspend supplier error:', error.message);
      toast({
        title: t('suspendError'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  const activateMutation = api.supplier.updateStatus.useMutation({
    onSuccess: () => {
      toast({
        title: t('activateSuccess'),
        variant: 'default',
      });
      setShowActivateDialog(false);
      void utils.supplier.getById.invalidate({ id: resolvedParams.id });
    },
    onError: (error) => {
      console.error('Activate supplier error:', error.message);
      toast({
        title: t('activateError'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  const handleStartEdit = () => {
    if (!supplier) return;
    setEditForm({
      businessName: supplier.businessName,
      tradingName: supplier.tradingName || '',
      abn: supplier.abn || '',
      acn: supplier.acn || '',
      primaryContact: {
        name: supplier.primaryContact.name,
        position: supplier.primaryContact.position || '',
        email: supplier.primaryContact.email,
        phone: supplier.primaryContact.phone,
        mobile: supplier.primaryContact.mobile || '',
      },
      businessAddress: {
        street: supplier.businessAddress.street,
        suburb: supplier.businessAddress.suburb,
        state: supplier.businessAddress.state,
        postcode: supplier.businessAddress.postcode,
        country: supplier.businessAddress.country || 'Australia',
      },
      paymentTerms: supplier.paymentTerms || '',
      paymentMethod: supplier.paymentMethod,
      creditLimit: formatCentsForWholeInput(supplier.creditLimit),
      minimumOrderValue: supplier.minimumOrderValue
        ? formatCentsForInput(supplier.minimumOrderValue)
        : '',
      leadTimeDays: supplier.leadTimeDays?.toString() || '',
      deliveryDays: supplier.deliveryDays || '',
      deliveryNotes: supplier.deliveryNotes || '',
    });
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setEditForm(null);
    setIsEditing(false);
  };

  const handleSaveEdit = () => {
    if (!editForm) return;

    // Validate ABN if provided
    if (editForm.abn && !validateABN(editForm.abn)) {
      toast({
        title: tCommon('error'),
        description: t('validation.abnInvalid'),
        variant: 'destructive',
      });
      return;
    }

    updateMutation.mutate({
      id: resolvedParams.id,
      data: {
        businessName: editForm.businessName,
        tradingName: editForm.tradingName || undefined,
        abn: editForm.abn || undefined,
        acn: editForm.acn || undefined,
        primaryContact: editForm.primaryContact,
        businessAddress: editForm.businessAddress,
        paymentTerms: editForm.paymentTerms || undefined,
        paymentMethod: editForm.paymentMethod,
        creditLimit: parseToCents(editForm.creditLimit) || 0,
        minimumOrderValue: editForm.minimumOrderValue
          ? parseToCents(editForm.minimumOrderValue) || undefined
          : undefined,
        leadTimeDays: editForm.leadTimeDays ? parseInt(editForm.leadTimeDays, 10) : undefined,
        deliveryDays: editForm.deliveryDays || undefined,
        deliveryNotes: editForm.deliveryNotes || undefined,
      },
    });
  };

  const handleSuspend = () => {
    if (suspendReason.length < 10) return;
    suspendMutation.mutate({
      id: resolvedParams.id,
      status: 'suspended' as SupplierStatus,
      reason: suspendReason,
    });
  };

  const handleActivate = () => {
    activateMutation.mutate({
      id: resolvedParams.id,
      status: 'active' as SupplierStatus,
    });
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="container mx-auto max-w-7xl px-4 py-8 space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <Skeleton className="h-48" />
            <Skeleton className="h-64" />
          </div>
          <div className="space-y-6">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error || !supplier) {
    return (
      <div className="container mx-auto max-w-7xl px-4 py-8">
        <Card className="p-6 text-center">
          <p className="text-destructive mb-4">{t('errorLoading')}</p>
          <Button variant="outline" onClick={() => router.back()}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {tCommon('back')}
          </Button>
        </Card>
      </div>
    );
  }

  const isSuspended = supplier.status === 'suspended';

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link href="/suppliers">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-2" />
              {tCommon('back')}
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl md:text-3xl font-bold">{supplier.businessName}</h1>
              <SupplierStatusBadge status={supplier.status} />
            </div>
            <p className="text-muted-foreground font-mono">{supplier.supplierCode}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <PermissionGate permission="suppliers:edit">
            {!isEditing && (
              <Button onClick={handleStartEdit} variant="outline">
                <Edit className="h-4 w-4 mr-2" />
                {tCommon('edit')}
              </Button>
            )}
          </PermissionGate>
          <PermissionGate permission="suppliers:suspend">
            {supplier.status === 'active' && (
              <Button variant="destructive" onClick={() => setShowSuspendDialog(true)}>
                <Ban className="h-4 w-4 mr-2" />
                {t('suspend')}
              </Button>
            )}
            {supplier.status === 'suspended' && (
              <Button variant="outline" onClick={() => setShowActivateDialog(true)}>
                <CheckCircle className="h-4 w-4 mr-2" />
                {t('activate')}
              </Button>
            )}
          </PermissionGate>
        </div>
      </div>

      {/* Main Content - 3 Column Layout */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left Column - Primary Info */}
        <div className="lg:col-span-2 space-y-6">
          {/* Business Information */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {t('businessInfo')}
                {isEditing && <Badge variant="outline">{tCommon('editing')}</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-muted-foreground">{t('businessName')}</Label>
                  {isEditing && editForm ? (
                    <Input
                      value={editForm.businessName}
                      onChange={(e) =>
                        setEditForm({ ...editForm, businessName: e.target.value })
                      }
                    />
                  ) : (
                    <p className="font-medium">{supplier.businessName}</p>
                  )}
                </div>
                <div>
                  <Label className="text-muted-foreground">{t('tradingName')}</Label>
                  {isEditing && editForm ? (
                    <Input
                      value={editForm.tradingName}
                      onChange={(e) =>
                        setEditForm({ ...editForm, tradingName: e.target.value })
                      }
                    />
                  ) : (
                    <p className="font-medium">{supplier.tradingName || '-'}</p>
                  )}
                </div>
                <div>
                  <Label className="text-muted-foreground">{t('abn')}</Label>
                  {isEditing && editForm ? (
                    <Input
                      value={editForm.abn}
                      onChange={(e) =>
                        setEditForm({ ...editForm, abn: e.target.value.replace(/\D/g, '').slice(0, 11) })
                      }
                    />
                  ) : (
                    <p className="font-medium font-mono">{supplier.abn || '-'}</p>
                  )}
                </div>
                <div>
                  <Label className="text-muted-foreground">{t('acn')}</Label>
                  {isEditing && editForm ? (
                    <Input
                      value={editForm.acn}
                      onChange={(e) =>
                        setEditForm({ ...editForm, acn: e.target.value.replace(/\D/g, '') })
                      }
                      maxLength={9}
                    />
                  ) : (
                    <p className="font-medium font-mono">{supplier.acn || '-'}</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Contact Information */}
          <Card>
            <CardHeader>
              <CardTitle>{t('contactInfo')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h3 className="font-medium text-sm text-muted-foreground mb-2">
                  {t('primaryContact')}
                </h3>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-muted-foreground">{t('name')}</Label>
                    {isEditing && editForm ? (
                      <Input
                        value={editForm.primaryContact.name}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            primaryContact: { ...editForm.primaryContact, name: e.target.value },
                          })
                        }
                      />
                    ) : (
                      <p className="font-medium">{supplier.primaryContact.name}</p>
                    )}
                  </div>
                  <div>
                    <Label className="text-muted-foreground">{t('position')}</Label>
                    {isEditing && editForm ? (
                      <Input
                        value={editForm.primaryContact.position}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            primaryContact: { ...editForm.primaryContact, position: e.target.value },
                          })
                        }
                      />
                    ) : (
                      <p className="font-medium">{supplier.primaryContact.position || '-'}</p>
                    )}
                  </div>
                  <div>
                    <Label className="text-muted-foreground">{t('email')}</Label>
                    {isEditing && editForm ? (
                      <Input
                        type="email"
                        value={editForm.primaryContact.email}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            primaryContact: { ...editForm.primaryContact, email: e.target.value },
                          })
                        }
                      />
                    ) : (
                      <p className="font-medium">{supplier.primaryContact.email}</p>
                    )}
                  </div>
                  <div>
                    <Label className="text-muted-foreground">{t('phone')}</Label>
                    {isEditing && editForm ? (
                      <Input
                        value={editForm.primaryContact.phone}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            primaryContact: { ...editForm.primaryContact, phone: e.target.value },
                          })
                        }
                      />
                    ) : (
                      <p className="font-medium">{supplier.primaryContact.phone}</p>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Financial Terms */}
          <Card>
            <CardHeader>
              <CardTitle>{t('financialTerms')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-muted-foreground">{t('creditLimit')}</Label>
                  {isEditing && editForm ? (
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={editForm.creditLimit}
                      onChange={(e) =>
                        setEditForm({ ...editForm, creditLimit: e.target.value })
                      }
                    />
                  ) : (
                    <p className="font-medium">{formatAUD(supplier.creditLimit)}</p>
                  )}
                </div>
                <div>
                  <Label className="text-muted-foreground">{t('currentBalance')}</Label>
                  <p className="font-medium">{formatAUD(supplier.currentBalance)}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">{t('paymentTerms')}</Label>
                  {isEditing && editForm ? (
                    <Input
                      value={editForm.paymentTerms}
                      onChange={(e) =>
                        setEditForm({ ...editForm, paymentTerms: e.target.value })
                      }
                    />
                  ) : (
                    <p className="font-medium">{supplier.paymentTerms || '-'}</p>
                  )}
                </div>
                <div>
                  <Label className="text-muted-foreground">{t('paymentMethod')}</Label>
                  {isEditing && editForm ? (
                    <select
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={editForm.paymentMethod}
                      onChange={(e) =>
                        setEditForm({
                          ...editForm,
                          paymentMethod: e.target.value as PaymentMethod,
                        })
                      }
                    >
                      <option value="bank_transfer">{tPayment('bank_transfer')}</option>
                      <option value="credit_card">{tPayment('credit_card')}</option>
                      <option value="cheque">{tPayment('cheque')}</option>
                      <option value="cash_on_delivery">{tPayment('cash_on_delivery')}</option>
                      <option value="account_credit">{tPayment('account_credit')}</option>
                    </select>
                  ) : (
                    <p className="font-medium">
                      {tPayment(supplier.paymentMethod)}
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Linked Products */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{t('linkedProducts')}</CardTitle>
              <PermissionGate permission="suppliers:edit">
                <Button size="sm" onClick={() => setShowLinkProductDialog(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  {t('linkProduct')}
                </Button>
              </PermissionGate>
            </CardHeader>
            <CardContent>
              {(supplier.products?.length ?? 0) === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Package className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>{t('noLinkedProducts')}</p>
                  <p className="text-sm">{t('noLinkedProductsDescription')}</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 text-sm font-medium">{t('product')}</th>
                        <th className="text-left py-2 text-sm font-medium">{t('supplierSku')}</th>
                        <th className="text-right py-2 text-sm font-medium">{t('costPrice')}</th>
                        <th className="text-center py-2 text-sm font-medium">{t('preferred')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {supplier.products?.map((link) => (
                        <tr key={link.id} className="border-b last:border-0">
                          <td className="py-3">
                            <div>
                              <p className="font-medium">{link.product?.name}</p>
                              <p className="text-sm text-muted-foreground font-mono">
                                {link.product?.sku}
                              </p>
                            </div>
                          </td>
                          <td className="py-3 font-mono text-sm">{link.supplierSku || '-'}</td>
                          <td className="py-3 text-right font-medium">
                            {formatAUD(link.costPrice)}
                          </td>
                          <td className="py-3 text-center">
                            {link.isPreferredSupplier && (
                              <Badge variant="default">{t('preferred')}</Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column - Sidebar */}
        <div className="space-y-6">
          {/* Suspension Info - Shown when supplier is suspended */}
          {isSuspended && (
            <Card className="border-destructive bg-destructive/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <Ban className="h-5 w-5" />
                  {t('suspended')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div>
                  <span className="text-muted-foreground">{t('reason')}: </span>
                  <span>{supplier.suspensionReason}</span>
                </div>
                {supplier.suspendedAt && (
                  <div>
                    <span className="text-muted-foreground">{t('date')}: </span>
                    <span>{new Date(supplier.suspendedAt).toLocaleDateString()}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Delivery Terms */}
          <Card>
            <CardHeader>
              <CardTitle>{t('deliveryTerms')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="text-muted-foreground">{t('minimumOrder')}</Label>
                {isEditing && editForm ? (
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={editForm.minimumOrderValue}
                    onChange={(e) =>
                      setEditForm({ ...editForm, minimumOrderValue: e.target.value })
                    }
                  />
                ) : (
                  <p className="font-medium">
                    {supplier.minimumOrderValue ? formatAUD(supplier.minimumOrderValue) : '-'}
                  </p>
                )}
              </div>
              <div>
                <Label className="text-muted-foreground">{t('leadTime')}</Label>
                {isEditing && editForm ? (
                  <Input
                    type="number"
                    value={editForm.leadTimeDays}
                    onChange={(e) =>
                      setEditForm({ ...editForm, leadTimeDays: e.target.value })
                    }
                  />
                ) : (
                  <p className="font-medium">
                    {supplier.leadTimeDays ? `${supplier.leadTimeDays} ${t('days')}` : '-'}
                  </p>
                )}
              </div>
              <div>
                <Label className="text-muted-foreground">{t('deliveryDays')}</Label>
                {isEditing && editForm ? (
                  <Input
                    value={editForm.deliveryDays}
                    onChange={(e) =>
                      setEditForm({ ...editForm, deliveryDays: e.target.value })
                    }
                  />
                ) : (
                  <p className="font-medium">{supplier.deliveryDays || '-'}</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Categories */}
          <Card>
            <CardHeader>
              <CardTitle>{t('categories')}</CardTitle>
            </CardHeader>
            <CardContent>
              {supplier.primaryCategories.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {supplier.primaryCategories.map((cat) => (
                    <Badge key={cat}>{cat}</Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('noCategories')}</p>
              )}
            </CardContent>
          </Card>

          {/* Metadata */}
          <Card>
            <CardHeader>
              <CardTitle>{t('metadata')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div>
                <span className="text-muted-foreground">{t('createdAt')}: </span>
                {new Date(supplier.createdAt).toLocaleDateString()}
              </div>
              <div>
                <span className="text-muted-foreground">{t('updatedAt')}: </span>
                {new Date(supplier.updatedAt).toLocaleDateString()}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Floating Action Bar - Edit Mode */}
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
                {tCommon('saving')}
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

      {/* Link Product Dialog */}
      <LinkProductDialog
        open={showLinkProductDialog}
        onOpenChange={setShowLinkProductDialog}
        supplierId={supplier.id}
        onSuccess={() => {
          void utils.supplier.getById.invalidate({ id: resolvedParams.id });
        }}
      />

      {/* Suspend Dialog */}
      <AlertDialog open={showSuspendDialog} onOpenChange={setShowSuspendDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('suspendTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('suspendDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Label>{t('suspensionReason')} *</Label>
            <textarea
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              placeholder={t('suspensionReasonPlaceholder')}
              className="mt-2 flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            {suspendReason.length > 0 && suspendReason.length < 10 && (
              <p className="text-sm text-destructive mt-1">{t('suspensionReasonMinLength')}</p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSuspend}
              disabled={suspendReason.length < 10 || suspendMutation.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {suspendMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('suspend')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Activate Dialog */}
      <AlertDialog open={showActivateDialog} onOpenChange={setShowActivateDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('activateTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('activateDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleActivate} disabled={activateMutation.isPending}>
              {activateMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('activate')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
