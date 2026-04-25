'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Input, Label, Button, useToast } from '@joho-erp/ui';
import { Search, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '@/trpc/client';

export interface AddressResult {
  street: string;
  suburb: string;
  state: string;
  postcode: string;
  latitude?: number;
  longitude?: number;
  fullAddress: string;
}

interface AddressSearchProps {
  onAddressSelect: (address: AddressResult) => void;
  defaultValues?: {
    street?: string;
    suburb?: string;
    state?: string;
    postcode?: string;
  };
  disabled?: boolean;
  label?: string;
  id?: string;
}

const AUSTRALIAN_STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'] as const;

export function AddressSearch({
  onAddressSelect,
  defaultValues,
  disabled = false,
  label,
  id = 'addressSearch',
}: AddressSearchProps) {
  const t = useTranslations('customerForm.addresses');
  const tSearch = useTranslations('customerForm.addressSearch');
  const tErrors = useTranslations('errors');
  const { toast } = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [isManualMode, setIsManualMode] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [results, setResults] = useState<AddressResult[]>([]);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Manual entry fields
  const [manualStreet, setManualStreet] = useState(defaultValues?.street || '');
  const [manualSuburb, setManualSuburb] = useState(defaultValues?.suburb || '');
  const [manualState, setManualState] = useState(defaultValues?.state || '');
  const [manualPostcode, setManualPostcode] = useState(defaultValues?.postcode || '');

  const geocodeMutation = api.customer.geocodeAddress.useMutation();

  // Initialize search query with default street value
  useEffect(() => {
    if (defaultValues?.street && !searchQuery && !isManualMode) {
      setSearchQuery(defaultValues.street);
    }
  }, [defaultValues?.street]);

  // Update manual fields when defaultValues change
  useEffect(() => {
    if (defaultValues) {
      setManualStreet(defaultValues.street || '');
      setManualSuburb(defaultValues.suburb || '');
      setManualState(defaultValues.state || '');
      setManualPostcode(defaultValues.postcode || '');
    }
  }, [defaultValues]);

  // Debounced search
  const performSearch = useCallback(async (query: string) => {
    if (query.length < 3) {
      setResults([]);
      setShowResults(false);
      return;
    }

    try {
      const response = await geocodeMutation.mutateAsync({ address: query });
      if (response.success && response.results) {
        setResults(response.results);
        setShowResults(true);
      } else {
        setResults([]);
        setShowResults(true);
      }
    } catch (error) {
      console.error('Geocoding error:', error);
      toast({
        title: tErrors('searchError'),
        variant: 'destructive',
      });
      setResults([]);
      setShowResults(true);
    }
  }, [geocodeMutation, toast, tErrors]);

  // Handle search input change with debounce
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    searchTimeoutRef.current = setTimeout(() => {
      performSearch(value);
    }, 300);
  };

  // Handle result selection
  const handleSelectResult = (result: AddressResult) => {
    setSearchQuery(result.fullAddress);
    setShowResults(false);
    setResults([]);
    onAddressSelect(result);
  };

  // Handle manual mode toggle
  const handleToggleManualMode = () => {
    setIsManualMode(!isManualMode);
    setShowResults(false);
    setResults([]);
  };

  // Handle manual entry changes - pass to parent without coordinates
  // The backend will geocode the address if coordinates are not provided
  useEffect(() => {
    if (isManualMode && manualStreet && manualSuburb && manualState && manualPostcode) {
      onAddressSelect({
        street: manualStreet,
        suburb: manualSuburb,
        state: manualState,
        postcode: manualPostcode,
        latitude: undefined,
        longitude: undefined,
        fullAddress: `${manualStreet}, ${manualSuburb}, ${manualState} ${manualPostcode}`,
      });
    }
  }, [isManualMode, manualStreet, manualSuburb, manualState, manualPostcode, onAddressSelect]);

  // Close results when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowResults(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div ref={containerRef} className="space-y-4">
      {/* Search Mode */}
      {!isManualMode && (
        <div className="relative">
          <Label htmlFor={id}>{label || t('street')} *</Label>
          <div className="relative mt-1">
            <Input
              id={id}
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder={tSearch('searchPlaceholder')}
              disabled={disabled}
              className="pr-10"
            />
            <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
              {geocodeMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <Search className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
          </div>

          {/* Search Results Dropdown */}
          {showResults && (
            <div className="absolute z-10 w-full mt-1 bg-background border rounded-md shadow-lg max-h-60 overflow-auto">
              {geocodeMutation.isPending ? (
                <div className="p-3 text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {tSearch('searching')}
                </div>
              ) : results.length > 0 ? (
                results.map((result, index) => (
                  <button
                    key={index}
                    type="button"
                    className="w-full px-3 py-2 text-left hover:bg-muted text-sm border-b last:border-b-0"
                    onClick={() => handleSelectResult(result)}
                  >
                    {result.fullAddress}
                  </button>
                ))
              ) : searchQuery.length >= 3 ? (
                <div className="p-3 text-sm text-muted-foreground">
                  {tSearch('noResults')}
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* Manual Entry Fields */}
      {isManualMode && (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${id}-manualStreet`}>{label || t('street')} *</Label>
            <Input
              id={`${id}-manualStreet`}
              value={manualStreet}
              onChange={(e) => setManualStreet(e.target.value)}
              disabled={disabled}
              placeholder={t('streetPlaceholder')}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor={`${id}-manualSuburb`}>{t('suburb')} *</Label>
              <Input
                id={`${id}-manualSuburb`}
                value={manualSuburb}
                onChange={(e) => setManualSuburb(e.target.value)}
                disabled={disabled}
                placeholder={t('suburbPlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-manualState`}>{t('state')} *</Label>
              <select
                id={`${id}-manualState`}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={manualState}
                onChange={(e) => setManualState(e.target.value)}
                disabled={disabled}
              >
                <option value="">{t('statePlaceholder')}</option>
                {AUSTRALIAN_STATES.map((state) => (
                  <option key={state} value={state}>
                    {state}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-manualPostcode`}>{t('postcode')} *</Label>
              <Input
                id={`${id}-manualPostcode`}
                maxLength={4}
                value={manualPostcode}
                onChange={(e) => setManualPostcode(e.target.value.replace(/\D/g, ''))}
                disabled={disabled}
                placeholder={t('postcodePlaceholder')}
              />
            </div>
          </div>
        </>
      )}

      {/* Toggle between modes */}
      <Button
        type="button"
        variant="link"
        size="sm"
        className="p-0 h-auto text-primary"
        onClick={handleToggleManualMode}
        disabled={disabled}
      >
        {isManualMode ? (
          <>
            <ChevronUp className="h-4 w-4 mr-1" />
            {tSearch('useSearch')}
          </>
        ) : (
          <>
            <ChevronDown className="h-4 w-4 mr-1" />
            {tSearch('enterManually')}
          </>
        )}
      </Button>
    </div>
  );
}
