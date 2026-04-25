'use client';

import { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { api } from '@/trpc/client';
import { formatCentsForInput, parseToCents } from '@joho-erp/shared';
import {
  MapPin,
  Loader2,
  Warehouse,
  Clock,
  Search,
  Navigation2,
  UserCog,
} from 'lucide-react';
import type { DeliverySettingsMapHandle } from './delivery-settings-map';

const DeliverySettingsMap = dynamic(() => import('./delivery-settings-map'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-muted/50">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  ),
});
import { SettingsPageHeader } from '@/components/settings/settings-page-header';
import { FloatingSaveBar } from '@/components/settings/floating-save-bar';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Checkbox,
  Input,
  Label,
  useToast,
} from '@joho-erp/ui';

const DEFAULT_WORKING_DAYS: number[] = [1, 2, 3, 4, 5, 6];
const WEEKDAYS: Array<{ value: number; key: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun' }> = [
  { value: 1, key: 'mon' },
  { value: 2, key: 'tue' },
  { value: 3, key: 'wed' },
  { value: 4, key: 'thu' },
  { value: 5, key: 'fri' },
  { value: 6, key: 'sat' },
  { value: 0, key: 'sun' },
];

/** Geocode search result from Mapbox API */
interface GeocodeResult {
  address: string;
  latitude: number;
  longitude: number;
  relevance: number;
}

// Simple Switch component using checkbox styling
function Switch({
  id,
  checked,
  onCheckedChange,
  disabled = false,
}: {
  id?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-primary' : 'bg-input'
      }`}
    >
      <span
        className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export default function DeliverySettingsPage() {
  const t = useTranslations('settings.delivery');
  const tCommon = useTranslations('common');
  const { toast } = useToast();
  const utils = api.useUtils();

  // Form state
  const [street, setStreet] = useState('');
  const [suburb, setSuburb] = useState('');
  const [state, setState] = useState('VIC');
  const [postcode, setPostcode] = useState('');
  const [latitude, setLatitude] = useState(-37.8136);
  const [longitude, setLongitude] = useState(144.9631);
  const [cutoffTime, setCutoffTime] = useState('14:00');
  const [deliveryWindow, setDeliveryWindow] = useState('9:00-17:00');
  const [minimumOrderAmount, setMinimumOrderAmount] = useState('');
  const [workingDays, setWorkingDays] = useState<number[]>(DEFAULT_WORKING_DAYS);
  const [manualDriverAssignment, setManualDriverAssignment] = useState(false);

  // UI state
  const [addressSearch, setAddressSearch] = useState('');
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const mapRef = useRef<DeliverySettingsMapHandle>(null);

  // Load existing settings
  const { data: settings, isLoading: loadingSettings } = api.company.getSettings.useQuery();

  // Mutations
  const saveSettingsMutation = api.company.updateDeliverySettings.useMutation();
  const geocodeMutation = api.company.geocodeAddress.useMutation();

  // Load settings into form
  useEffect(() => {
    if (settings?.deliverySettings) {
      const ds = settings.deliverySettings;
      if (ds.warehouseAddress) {
        setStreet(ds.warehouseAddress.street);
        setSuburb(ds.warehouseAddress.suburb);
        setState(ds.warehouseAddress.state);
        setPostcode(ds.warehouseAddress.postcode);
        setLatitude(ds.warehouseAddress.latitude);
        setLongitude(ds.warehouseAddress.longitude);
      }
      if (ds.orderCutoffTime) {
        setCutoffTime(ds.orderCutoffTime);
      }
      if (ds.defaultDeliveryWindow) {
        setDeliveryWindow(ds.defaultDeliveryWindow);
      }
      if (ds.minimumOrderAmount !== null && ds.minimumOrderAmount !== undefined) {
        setMinimumOrderAmount(formatCentsForInput(ds.minimumOrderAmount));
      }
      if (Array.isArray(ds.workingDays) && ds.workingDays.length > 0) {
        setWorkingDays(ds.workingDays);
      }
      setManualDriverAssignment(Boolean(ds.manualDriverAssignment));
    }
  }, [settings]);

  // Track changes - always compare against saved values or defaults
  useEffect(() => {
    // Get the values to compare against (saved values or defaults)
    const savedStreet = settings?.deliverySettings?.warehouseAddress?.street || '';
    const savedSuburb = settings?.deliverySettings?.warehouseAddress?.suburb || '';
    const savedState = settings?.deliverySettings?.warehouseAddress?.state || 'VIC';
    const savedPostcode = settings?.deliverySettings?.warehouseAddress?.postcode || '';
    const savedLatitude = settings?.deliverySettings?.warehouseAddress?.latitude ?? -37.8136;
    const savedLongitude = settings?.deliverySettings?.warehouseAddress?.longitude ?? 144.9631;
    const savedCutoffTime = settings?.deliverySettings?.orderCutoffTime || '14:00';
    const savedDeliveryWindow = settings?.deliverySettings?.defaultDeliveryWindow || '9:00-17:00';
    const savedMinimumOrder = settings?.deliverySettings?.minimumOrderAmount ?? null;
    const savedWorkingDays =
      Array.isArray(settings?.deliverySettings?.workingDays) &&
      settings!.deliverySettings!.workingDays!.length > 0
        ? settings!.deliverySettings!.workingDays!
        : DEFAULT_WORKING_DAYS;
    const savedManualDriverAssignment = Boolean(
      settings?.deliverySettings?.manualDriverAssignment
    );

    // Convert current input to cents for comparison
    const currentMinimumCents = minimumOrderAmount ? parseToCents(minimumOrderAmount) : null;

    const workingDaysChanged =
      workingDays.length !== savedWorkingDays.length ||
      !savedWorkingDays.every((d) => workingDays.includes(d));

    // Compare current form values against saved/default values
    const hasModifications =
      street !== savedStreet ||
      suburb !== savedSuburb ||
      state !== savedState ||
      postcode !== savedPostcode ||
      latitude !== savedLatitude ||
      longitude !== savedLongitude ||
      cutoffTime !== savedCutoffTime ||
      deliveryWindow !== savedDeliveryWindow ||
      currentMinimumCents !== savedMinimumOrder ||
      workingDaysChanged ||
      manualDriverAssignment !== savedManualDriverAssignment;

    setHasChanges(hasModifications);
  }, [street, suburb, state, postcode, latitude, longitude, cutoffTime, deliveryWindow, minimumOrderAmount, workingDays, manualDriverAssignment, settings]);

  // Geocode search
  const handleSearch = async () => {
    if (!addressSearch.trim()) return;

    try {
      const result = await geocodeMutation.mutateAsync({
        address: addressSearch,
      });

      if (result.success && result.results) {
        setSearchResults(result.results);
        setShowResults(true);
      }
    } catch (error) {
      toast({
        title: t('geocodingFailed'),
        description: error instanceof Error ? error.message : t('unknownError'),
        variant: 'destructive',
      });
    }
  };

  // Select geocoded result
  const selectResult = (result: GeocodeResult) => {
    const parts = result.address.split(',');
    setStreet(parts[0]?.trim() || '');
    setSuburb(parts[1]?.trim() || '');
    setPostcode(parts[2]?.trim().split(' ')[1] || '');
    setLatitude(result.latitude);
    setLongitude(result.longitude);
    setShowResults(false);
    setAddressSearch('');

    // Fly map to location
    if (mapRef.current) {
      mapRef.current.flyTo({
        center: [result.longitude, result.latitude],
        zoom: 15,
        duration: 1500,
      });
    }
  };

  // Save settings
  const handleSave = async () => {
    if (!street || !suburb || !state || !postcode) {
      toast({
        title: t('validationError'),
        description: t('fillRequiredFields'),
        variant: 'destructive',
      });
      return;
    }

    // Parse and validate minimum order amount
    const minimumOrderCents = minimumOrderAmount ? parseToCents(minimumOrderAmount) : null;
    if (minimumOrderAmount && minimumOrderCents === null) {
      toast({
        title: t('validationError'),
        description: t('invalidMinimumOrderAmount'),
        variant: 'destructive',
      });
      return;
    }

    if (workingDays.length === 0) {
      toast({
        title: t('validationError'),
        description: t('workingDays.atLeastOneRequired'),
        variant: 'destructive',
      });
      return;
    }

    try {
      await saveSettingsMutation.mutateAsync({
        warehouseAddress: {
          street,
          suburb,
          state,
          postcode,
          country: 'Australia',
          latitude,
          longitude,
        },
        orderCutoffTime: cutoffTime,
        workingDays,
        defaultDeliveryWindow: deliveryWindow || undefined,
        minimumOrderAmount: minimumOrderCents || undefined,
        manualDriverAssignment,
      });

      toast({
        title: t('settingsSaved'),
        description: t('settingsSavedDescription'),
      });

      setHasChanges(false);
      void utils.company.getSettings.invalidate();
      // Also invalidate delivery queries so the delivery page gets updated warehouse location
      void utils.delivery.getOptimizedRoute.invalidate();
    } catch (error) {
      toast({
        title: t('saveFailed'),
        description: error instanceof Error ? error.message : t('unknownError'),
        variant: 'destructive',
      });
    }
  };

  const handleCancel = () => {
    // Reset form to original values
    if (settings?.deliverySettings) {
      const ds = settings.deliverySettings;
      if (ds.warehouseAddress) {
        setStreet(ds.warehouseAddress.street);
        setSuburb(ds.warehouseAddress.suburb);
        setState(ds.warehouseAddress.state);
        setPostcode(ds.warehouseAddress.postcode);
        setLatitude(ds.warehouseAddress.latitude);
        setLongitude(ds.warehouseAddress.longitude);
      }
      if (ds.orderCutoffTime) {
        setCutoffTime(ds.orderCutoffTime);
      }
      if (ds.defaultDeliveryWindow) {
        setDeliveryWindow(ds.defaultDeliveryWindow);
      }
      if (ds.minimumOrderAmount !== null && ds.minimumOrderAmount !== undefined) {
        setMinimumOrderAmount(formatCentsForInput(ds.minimumOrderAmount));
      } else {
        setMinimumOrderAmount('');
      }
      if (Array.isArray(ds.workingDays) && ds.workingDays.length > 0) {
        setWorkingDays(ds.workingDays);
      } else {
        setWorkingDays(DEFAULT_WORKING_DAYS);
      }
      setManualDriverAssignment(Boolean(ds.manualDriverAssignment));
    }
  };

  const toggleWorkingDay = (day: number, checked: boolean) => {
    setWorkingDays((prev) => {
      if (checked) {
        if (prev.includes(day)) return prev;
        return [...prev, day].sort((a, b) => a - b);
      }
      return prev.filter((d) => d !== day);
    });
  };

  if (loadingSettings) {
    return (
      <div className="container mx-auto px-4 py-12">
        <div className="flex flex-col items-center justify-center min-h-[400px]">
          <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
          <p className="text-muted-foreground font-medium">{tCommon('loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 md:py-10">
      <SettingsPageHeader
        icon={Warehouse}
        titleKey="delivery.title"
        descriptionKey="delivery.subtitle"
      >
        <FloatingSaveBar
          onSave={handleSave}
          onCancel={handleCancel}
          isSaving={saveSettingsMutation.isPending}
          hasChanges={hasChanges}
          saveLabel={t('saveChanges')}
          savingLabel={t('saving')}
        />
      </SettingsPageHeader>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: Map */}
        <div className="space-y-6">
          <Card className="animate-fade-in-up">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Navigation2 className="h-5 w-5 text-primary" />
                  <CardTitle className="text-base">{t('warehouseLocation')}</CardTitle>
                </div>
                <div className="text-xs text-muted-foreground">
                  {latitude.toFixed(6)}, {longitude.toFixed(6)}
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {/* Map */}
              <div className="h-[500px] relative">
                <DeliverySettingsMap
                  ref={mapRef}
                  latitude={latitude}
                  longitude={longitude}
                  onLocationChange={(lat, lng) => {
                    setLatitude(lat);
                    setLongitude(lng);
                  }}
                />
              </div>

              <div className="p-4 bg-muted/50 border-t">
                <p className="text-xs text-muted-foreground">
                  💡 {t('clickMap')}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Forms */}
        <div className="space-y-6">
          {/* Address Search */}
          <Card className="animate-fade-in-up">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Search className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">{t('addressSearch')}</CardTitle>
              </div>
              <CardDescription>{t('searchDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  type="text"
                  value={addressSearch}
                  onChange={(e) => setAddressSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  placeholder={t('searchPlaceholder')}
                />
                <Button
                  onClick={handleSearch}
                  disabled={geocodeMutation.isPending}
                  variant="outline"
                >
                  {geocodeMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    tCommon('search')
                  )}
                </Button>
              </div>

              {/* Search Results */}
              {showResults && searchResults.length > 0 && (
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {searchResults.map((result, idx) => (
                    <button
                      key={idx}
                      onClick={() => selectResult(result)}
                      className="w-full p-3 bg-muted hover:bg-muted/80 border rounded-lg text-left transition-colors"
                    >
                      <p className="text-sm font-medium">{result.address}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {result.latitude.toFixed(6)}, {result.longitude.toFixed(6)}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Manual Address Entry */}
          <Card className="animate-fade-in-up delay-100">
            <CardHeader>
              <div className="flex items-center gap-2">
                <MapPin className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">{t('warehouseAddress')}</CardTitle>
              </div>
              <CardDescription>{t('manualEntryDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="street">{t('streetAddress')} *</Label>
                <Input
                  id="street"
                  type="text"
                  value={street}
                  onChange={(e) => setStreet(e.target.value)}
                  placeholder={t('streetPlaceholder')}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="suburb">{t('suburb')} *</Label>
                  <Input
                    id="suburb"
                    type="text"
                    value={suburb}
                    onChange={(e) => setSuburb(e.target.value)}
                    placeholder={t('suburbPlaceholder')}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="postcode">{t('postcode')} *</Label>
                  <Input
                    id="postcode"
                    type="text"
                    value={postcode}
                    onChange={(e) => setPostcode(e.target.value)}
                    placeholder={t('postcodePlaceholder')}
                    maxLength={4}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="state">{t('state')} *</Label>
                <select
                  id="state"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="VIC">{t('states.VIC')}</option>
                  <option value="NSW">{t('states.NSW')}</option>
                  <option value="QLD">{t('states.QLD')}</option>
                  <option value="SA">{t('states.SA')}</option>
                  <option value="WA">{t('states.WA')}</option>
                  <option value="TAS">{t('states.TAS')}</option>
                  <option value="NT">{t('states.NT')}</option>
                  <option value="ACT">{t('states.ACT')}</option>
                </select>
              </div>
            </CardContent>
          </Card>

          {/* Operations Settings */}
          <Card className="animate-fade-in-up delay-200">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">{t('operations')}</CardTitle>
              </div>
              <CardDescription>{t('operationsDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="cutoffTime">{t('orderCutoffTime')}</Label>
                <Input
                  id="cutoffTime"
                  type="time"
                  value={cutoffTime}
                  onChange={(e) => setCutoffTime(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t('cutoffDescription')}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="deliveryWindow">{t('deliveryWindow')}</Label>
                <Input
                  id="deliveryWindow"
                  type="text"
                  value={deliveryWindow}
                  onChange={(e) => setDeliveryWindow(e.target.value)}
                  placeholder={t('deliveryWindowPlaceholder')}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="minimumOrderAmount">{t('minimumOrderAmount')}</Label>
                <Input
                  id="minimumOrderAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={minimumOrderAmount}
                  onChange={(e) => setMinimumOrderAmount(e.target.value)}
                  placeholder={t('minimumOrderPlaceholder')}
                />
                <p className="text-xs text-muted-foreground">
                  {t('minimumOrderDescription')}
                </p>
              </div>

              <div className="space-y-2 pt-2 border-t">
                <Label>{t('workingDays.title')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('workingDays.description')}
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
                  {WEEKDAYS.map(({ value, key }) => (
                    <label
                      key={value}
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <Checkbox
                        checked={workingDays.includes(value)}
                        onCheckedChange={(checked) =>
                          toggleWorkingDay(value, checked)
                        }
                      />
                      <span className="text-sm">
                        {t(`workingDays.${key}`)}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Driver Assignment */}
          <Card className="animate-fade-in-up delay-300">
            <CardHeader>
              <div className="flex items-center gap-2">
                <UserCog className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">
                  {t('manualDriverAssignment.title')}
                </CardTitle>
              </div>
              <CardDescription>
                {t('manualDriverAssignment.description')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <Label htmlFor="manualDriverAssignment" className="cursor-pointer">
                  {t('manualDriverAssignment.label')}
                </Label>
                <Switch
                  id="manualDriverAssignment"
                  checked={manualDriverAssignment}
                  onCheckedChange={setManualDriverAssignment}
                />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
