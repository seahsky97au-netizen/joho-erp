'use client';

import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Button, TableSkeleton, StatusBadge, type StatusType, useToast, Badge, Input, Tabs, TabsList, TabsTrigger, TabsContent } from '@joho-erp/ui';
import { MapPin, Navigation, CheckCircle, Package, FileText, Users, Clock, Calendar, Loader2, Truck, UserX, MapPinOff } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { api } from '@/trpc/client';
import { PermissionGate } from '@/components/permission-gate';
import { useTableSort } from '@joho-erp/shared/hooks';
import { RouteManifestDialog, DriverFilter, AutoAssignDialog, MarkDeliveredDialog } from './components';
import { StatsBar, FilterBar, type StatItem } from '@/components/operations';

// Dynamically import Map component to avoid SSR issues
const DeliveryMap = dynamic(() => import('./delivery-map'), {
  ssr: false,
  loading: () => <div className="w-full h-[600px] bg-muted animate-pulse rounded-lg" />,
});

export default function DeliveriesPage() {
  const t = useTranslations('deliveries');
  const tPacking = useTranslations('packing');
  const tErrors = useTranslations('errors');
  const { toast } = useToast();
  const utils = api.useUtils();
  const [isRecalculatingRoute, setIsRecalculatingRoute] = useState(false);
  const [selectedDelivery, setSelectedDelivery] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'active' | 'unassigned'>('active');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ready_for_delivery' | 'delivered' | ''>('');
  const [areaFilter, setAreaFilter] = useState<string>(''); // Now uses areaId
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [manifestDialogOpen, setManifestDialogOpen] = useState(false);
  const [autoAssignDialogOpen, setAutoAssignDialogOpen] = useState(false);
  const [markDeliveredDialog, setMarkDeliveredDialog] = useState<{
    open: boolean;
    delivery: { id: string; orderId: string; customer: string; packedAt?: Date | null } | null;
  }>({ open: false, delivery: null });
  const { sortBy, sortOrder } = useTableSort('deliverySequence', 'asc');

  // Date selector state for filtering by delivery date (using local timezone)
  const today = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);
  const [deliveryDate, setDeliveryDate] = useState<Date>(today);

  // Date helper functions
  const formatDate = (date: Date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();
    const utcDate = new Date(Date.UTC(year, month, day));

    return new Intl.DateTimeFormat('en-AU', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC'
    }).format(utcDate);
  };

  // Date change handler - creates local midnight
  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const [year, month, day] = e.target.value.split('-').map(Number);
    const newDate = new Date(year, month - 1, day, 0, 0, 0, 0);
    setDeliveryDate(newDate);
  };

  // Date input value helper - uses local timezone methods
  const dateInputValue = useMemo(() => {
    const year = deliveryDate.getFullYear();
    const month = String(deliveryDate.getMonth() + 1).padStart(2, '0');
    const day = String(deliveryDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }, [deliveryDate]);

  // End of day timestamp for date filtering (23:59:59.999 local time)
  const deliveryDateEnd = useMemo(() => {
    const endOfDay = new Date(deliveryDate.getTime());
    endOfDay.setHours(23, 59, 59, 999);
    return endOfDay;
  }, [deliveryDate]);

  // Mark Delivered mutation (for admins)
  const markDeliveredMutation = api.delivery.markDelivered.useMutation({
    onSuccess: () => {
      toast({
        title: t('messages.markDeliveredSuccess'),
      });
      void utils.delivery.getAll.invalidate();
      void utils.delivery.getOptimizedRoute.invalidate();
      setMarkDeliveredDialog({ open: false, delivery: null });
    },
    onError: (error) => {
      console.error('Mark delivered error:', error.message);
      toast({
        title: t('messages.markDeliveredError'),
        description: tErrors('operationFailed'),
        variant: 'destructive',
      });
    },
  });

  // Optimize Route mutation (for recalculating the route)
  const optimizeRouteMutation = api.packing.optimizeRoute.useMutation();

  // Handler for recalculating the delivery route
  const handleRecalculateRoute = async () => {
    if (!deliveryDate) return;
    setIsRecalculatingRoute(true);
    try {
      await optimizeRouteMutation.mutateAsync({
        deliveryDate: deliveryDate.toISOString(),
        force: true,
      });
      await utils.delivery.getOptimizedRoute.invalidate();
      await utils.delivery.getAll.invalidate();
      toast({
        title: tPacking('routeOptimized'),
      });
    } catch (error) {
      toast({
        title: tErrors('optimizationFailed'),
        variant: 'destructive',
      });
    } finally {
      setIsRecalculatingRoute(false);
    }
  };

  // Get ISO date string for route optimization query
  const deliveryDateISO = useMemo(() => deliveryDate.toISOString(), [deliveryDate]);

  // Fetch deliveries from database, filtered by delivery date
  const { data, isLoading } = api.delivery.getAll.useQuery({
    search: searchQuery || undefined,
    status: statusFilter || undefined,
    areaId: areaFilter || undefined,
    dateFrom: deliveryDate, // Filter by delivery date (local midnight)
    dateTo: deliveryDateEnd, // End of day in local timezone
    sortBy,
    sortOrder,
  });

  // Fetch optimized route data for the map
  const { data: routeData } = api.delivery.getOptimizedRoute.useQuery({
    deliveryDate: deliveryDateISO,
  });

  const deliveries = useMemo(() => data?.deliveries || [], [data?.deliveries]);

  // Extract unique drivers from deliveries for the filter
  const driversWithRoutes = useMemo(() => {
    if (!deliveries.length) return [];

    const driverMap = new Map<string, { id: string; name: string; orderCount: number }>();

    deliveries.forEach((delivery) => {
      const driverId = delivery.driverId;
      const driverName = delivery.driverName;

      if (driverId) {
        const existing = driverMap.get(driverId);
        if (existing) {
          existing.orderCount++;
        } else {
          driverMap.set(driverId, {
            id: driverId,
            name: driverName || 'Unknown Driver',
            orderCount: 1,
          });
        }
      }
    });

    return Array.from(driverMap.values());
  }, [deliveries]);

  // Filter deliveries by selected driver
  const filteredDeliveries = useMemo(() => {
    if (!selectedDriverId) return deliveries;
    return deliveries.filter((d) => d.driverId === selectedDriverId);
  }, [deliveries, selectedDriverId]);

  // Split deliveries into active (has both driver and area) and unassigned (missing either)
  const activeDeliveries = useMemo(
    () => filteredDeliveries.filter((d) => d.driverId && d.areaName),
    [filteredDeliveries],
  );

  const unassignedDeliveries = useMemo(
    () => filteredDeliveries.filter((d) => !d.driverId || !d.areaName),
    [filteredDeliveries],
  );

  // Group unassigned deliveries by reason — area-missing comes first since that blocks routing
  const unassignedGroups = useMemo(() => {
    const noArea: typeof unassignedDeliveries = [];
    const noDriver: typeof unassignedDeliveries = [];
    for (const d of unassignedDeliveries) {
      if (!d.areaName) noArea.push(d);
      else noDriver.push(d);
    }
    return { noArea, noDriver };
  }, [unassignedDeliveries]);

  // Group deliveries by area for per-area display
  const deliveryAreaGroups = useMemo(() => {
    const groupMap = new Map<string | null, {
      areaName: string | null;
      areaDisplayName: string;
      areaSortOrder: number;
      deliveries: typeof activeDeliveries;
    }>();

    for (const delivery of activeDeliveries) {
      const areaName = delivery.areaName ?? null;
      if (!groupMap.has(areaName)) {
        groupMap.set(areaName, {
          areaName,
          areaDisplayName: delivery.areaDisplayName ?? 'Unassigned',
          areaSortOrder: delivery.areaSortOrder ?? 999,
          deliveries: [],
        });
      }
      groupMap.get(areaName)!.deliveries.push(delivery);
    }

    // Sort groups by areaSortOrder, unassigned last
    const groups = Array.from(groupMap.values());
    groups.sort((a, b) => {
      if (a.areaName === null && b.areaName !== null) return 1;
      if (a.areaName !== null && b.areaName === null) return -1;
      return a.areaSortOrder - b.areaSortOrder;
    });

    // Sort deliveries within each group by areaDeliverySequence
    for (const group of groups) {
      group.deliveries.sort((a, b) => (a.areaDeliverySequence ?? 999) - (b.areaDeliverySequence ?? 999));
    }

    return groups;
  }, [activeDeliveries]);

  const hasMultipleAreas = deliveryAreaGroups.length > 1 || (deliveryAreaGroups.length === 1 && deliveryAreaGroups[0].areaName !== null);

  // Calculate stats for StatsBar
  const stats = useMemo<StatItem[]>(() => {
    const total = filteredDeliveries.length;
    const pending = filteredDeliveries.filter((d) => d.status === 'ready_for_delivery').length;
    const delivered = filteredDeliveries.filter((d) => d.status === 'delivered').length;

    return [
      { label: t('stats.totalDeliveries'), value: total, icon: Package },
      { label: t('stats.readyForDelivery'), value: pending, icon: Clock, variant: 'warning' as const },
      { label: t('stats.delivered'), value: delivered, icon: CheckCircle, variant: 'success' as const },
    ];
  }, [filteredDeliveries, t]);

  // Transform route data for the map component with filter support
  // Prefers stored Mapbox road-following geometry over straight lines from waypoints
  const mapRouteData = useMemo(() => {
    if (!routeData?.hasRoute || !routeData.route) return null;

    // Get order IDs from filtered deliveries
    const filteredOrderIds = new Set(filteredDeliveries.map((d) => d.id));

    // Filter waypoints to only include orders that are in the filtered list
    const filteredWaypoints = routeData.route.waypoints?.filter(
      (wp: { orderId: string }) => filteredOrderIds.has(wp.orderId)
    ) || [];

    // If no waypoints match filters, return null (no route to display)
    if (filteredWaypoints.length === 0) return null;

    // Try to use stored Mapbox road-following geometry
    const storedGeometry = routeData.route.routeGeometry;
    if (storedGeometry && typeof storedGeometry === 'object') {
      // FeatureCollection: combine all LineStrings from area routes
      if (storedGeometry.type === 'FeatureCollection' && Array.isArray(storedGeometry.features)) {
        const allCoordinates: [number, number][] = [];
        for (const feature of storedGeometry.features) {
          if (feature.geometry?.type === 'LineString' && Array.isArray(feature.geometry.coordinates)) {
            allCoordinates.push(...feature.geometry.coordinates);
          }
        }
        if (allCoordinates.length > 0) {
          return {
            geometry: { type: 'LineString' as const, coordinates: allCoordinates },
            totalDistance: routeData.route.totalDistance,
            totalDuration: routeData.route.totalDuration,
          };
        }
      }
      // Single LineString geometry
      if (storedGeometry.type === 'LineString' && Array.isArray(storedGeometry.coordinates) && storedGeometry.coordinates.length > 0) {
        return {
          geometry: storedGeometry as { type: 'LineString'; coordinates: [number, number][] },
          totalDistance: routeData.route.totalDistance,
          totalDuration: routeData.route.totalDuration,
        };
      }
    }

    // Fallback: Generate straight-line geometry from waypoint coordinates
    const sortedWaypoints = [...filteredWaypoints].sort(
      (a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence
    );

    const filteredGeometry = {
      type: 'LineString' as const,
      coordinates: sortedWaypoints.map(
        (wp: { longitude: number; latitude: number }): [number, number] => [wp.longitude, wp.latitude]
      ),
    };

    return {
      geometry: filteredGeometry,
      totalDistance: routeData.route.totalDistance,
      totalDuration: routeData.route.totalDuration,
    };
  }, [routeData, filteredDeliveries]);

  // Auto-select the first delivery when data loads (already sorted by deliverySequence from API)
  useEffect(() => {
    if (deliveries.length > 0 && selectedDelivery === null) {
      setSelectedDelivery(deliveries[0].id);
    }
  }, [deliveries, selectedDelivery]);

  return (
    <div className="container mx-auto py-10">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-4xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground mt-2">{t('subtitle')}</p>
        </div>
        <div className="flex gap-2">
          {/* Driver Filter - show only if multiple drivers */}
          {driversWithRoutes.length > 1 && (
            <DriverFilter
              drivers={driversWithRoutes}
              selectedDriverId={selectedDriverId}
              onDriverChange={setSelectedDriverId}
            />
          )}
          <PermissionGate permission="deliveries:manage">
            <Button onClick={() => setAutoAssignDialogOpen(true)}>
              <Users className="h-4 w-4 mr-2" />
              {t('autoAssignDrivers')}
            </Button>
          </PermissionGate>
          <PermissionGate permission="deliveries:view">
            <Button onClick={() => setManifestDialogOpen(true)} variant="outline">
              <FileText className="h-4 w-4 mr-2" />
              {t('printManifest')}
            </Button>
          </PermissionGate>
          <PermissionGate permission="packing:manage">
            <Button
              onClick={handleRecalculateRoute}
              variant="outline"
              disabled={isRecalculatingRoute || !deliveryDate}
            >
              {isRecalculatingRoute ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {tPacking('optimizingRoute')}
                </>
              ) : (
                <>
                  <Navigation className="h-4 w-4 mr-2" />
                  {tPacking('regenerateRoute')}
                </>
              )}
            </Button>
          </PermissionGate>
        </div>
      </div>

      {/* Date Selector - Filter by delivery date */}
      <Card className="mb-4">
        <CardHeader className="p-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Calendar className="h-5 w-5 text-muted-foreground" />
              <div>
                <label className="text-sm font-medium text-muted-foreground block mb-1">
                  {t('selectDate')}
                </label>
                <Input
                  type="date"
                  value={dateInputValue}
                  onChange={handleDateChange}
                  className="w-auto"
                />
              </div>
            </div>
            <div className="text-sm text-muted-foreground">
              {t('showingDeliveriesFor', { date: formatDate(deliveryDate) })}
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Filters */}
      <FilterBar
        showSearchFilter
        search={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder={t('searchPlaceholder')}
        showStatusFilter
        status={statusFilter}
        onStatusChange={(s) => setStatusFilter(s as 'ready_for_delivery' | 'delivered' | '')}
        statusOptions={[
          { value: 'ready_for_delivery', label: t('filters.readyForDelivery') },
          { value: 'delivered', label: t('filters.delivered') },
        ]}
        showAreaFilter
        areaId={areaFilter}
        onAreaChange={setAreaFilter}
        showDriverFilter
        driverId={selectedDriverId ?? ''}
        onDriverChange={(id) => setSelectedDriverId(id || null)}
        drivers={driversWithRoutes}
        className="mb-4"
      />

      {/* Stats Bar */}
      {filteredDeliveries.length > 0 && (
        <StatsBar stats={stats} className="mb-6" />
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Delivery List */}
        <div className="lg:col-span-1 space-y-4">
          <Card className="lg:h-[600px] lg:flex lg:flex-col">
            <CardHeader className="pb-3 lg:flex-none">
              <CardTitle>
                {activeTab === 'active' ? t('activeDeliveries') : t('tabs.unassigned')}
              </CardTitle>
              <CardDescription>
                {activeTab === 'active'
                  ? `${activeDeliveries.length} ${t('deliveriesInProgress')}`
                  : t('unassigned.description')}
              </CardDescription>
            </CardHeader>
            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as 'active' | 'unassigned')}
              className="lg:flex-1 lg:flex lg:flex-col lg:min-h-0"
            >
              <TabsList className="mx-4 md:mx-6">
                <TabsTrigger value="active">
                  {t('tabs.active')}
                  <Badge variant="secondary" className="ml-2">{activeDeliveries.length}</Badge>
                </TabsTrigger>
                <TabsTrigger value="unassigned">
                  {t('tabs.unassigned')}
                  <Badge variant="secondary" className="ml-2">{unassignedDeliveries.length}</Badge>
                </TabsTrigger>
              </TabsList>

              <TabsContent
                value="active"
                className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto p-4 md:p-6 space-y-4 mt-0"
              >
                {isLoading ? (
                  <TableSkeleton rows={4} columns={3} showMobileCards />
                ) : activeDeliveries.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">{t('noDeliveriesFound')}</p>
                ) : hasMultipleAreas ? (
                  /* Grouped by area */
                  <div className="space-y-6">
                    {deliveryAreaGroups.map((group) => (
                      <div key={group.areaName ?? 'unassigned'} className="space-y-3">
                        {/* Area Header */}
                        <div className="flex items-center gap-2 px-2 py-2 bg-muted/50 rounded-lg">
                          <Truck className="h-4 w-4 text-muted-foreground" />
                          <span className="font-semibold text-sm">
                            {group.areaDisplayName}
                          </span>
                          <Badge variant="secondary" className="ml-auto">
                            {group.deliveries.length} {group.deliveries.length === 1 ? t('order') : t('orders')}
                          </Badge>
                        </div>
                        {/* Deliveries in this area */}
                        {group.deliveries.map((delivery) => (
                          <DeliveryCard
                            key={delivery.id}
                            delivery={delivery}
                            isSelected={selectedDelivery === delivery.id}
                            onSelect={() => setSelectedDelivery(delivery.id)}
                            onMarkDelivered={(e) => {
                              e.stopPropagation();
                              setMarkDeliveredDialog({
                                open: true,
                                delivery: {
                                  id: delivery.id,
                                  orderId: delivery.orderId,
                                  customer: delivery.customer,
                                  packedAt: delivery.packedAt ? new Date(delivery.packedAt) : null,
                                },
                              });
                            }}
                            isMarkDeliveredPending={markDeliveredMutation.isPending}
                            showAreaSequence
                            t={t}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  /* Flat list when single/no area */
                  activeDeliveries.map((delivery) => (
                    <DeliveryCard
                      key={delivery.id}
                      delivery={delivery}
                      isSelected={selectedDelivery === delivery.id}
                      onSelect={() => setSelectedDelivery(delivery.id)}
                      onMarkDelivered={(e) => {
                        e.stopPropagation();
                        setMarkDeliveredDialog({
                          open: true,
                          delivery: {
                            id: delivery.id,
                            orderId: delivery.orderId,
                            customer: delivery.customer,
                            packedAt: delivery.packedAt ? new Date(delivery.packedAt) : null,
                          },
                        });
                      }}
                      isMarkDeliveredPending={markDeliveredMutation.isPending}
                      showAreaSequence={false}
                      t={t}
                    />
                  ))
                )}
              </TabsContent>

              <TabsContent
                value="unassigned"
                className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto p-4 md:p-6 space-y-4 mt-0"
              >
                {isLoading ? (
                  <TableSkeleton rows={4} columns={3} showMobileCards />
                ) : unassignedDeliveries.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">{t('unassigned.allAssigned')}</p>
                ) : (
                  <div className="space-y-6">
                    {unassignedGroups.noArea.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 px-2 py-2 bg-muted/50 rounded-lg">
                          <MapPinOff className="h-4 w-4 text-muted-foreground" />
                          <span className="font-semibold text-sm">
                            {t('unassigned.needsArea')}
                          </span>
                          <Badge variant="secondary" className="ml-auto">
                            {unassignedGroups.noArea.length} {unassignedGroups.noArea.length === 1 ? t('order') : t('orders')}
                          </Badge>
                        </div>
                        {unassignedGroups.noArea.map((delivery) => (
                          <DeliveryCard
                            key={delivery.id}
                            delivery={delivery}
                            isSelected={selectedDelivery === delivery.id}
                            onSelect={() => setSelectedDelivery(delivery.id)}
                            onMarkDelivered={(e) => {
                              e.stopPropagation();
                              setMarkDeliveredDialog({
                                open: true,
                                delivery: {
                                  id: delivery.id,
                                  orderId: delivery.orderId,
                                  customer: delivery.customer,
                                  packedAt: delivery.packedAt ? new Date(delivery.packedAt) : null,
                                },
                              });
                            }}
                            isMarkDeliveredPending={markDeliveredMutation.isPending}
                            showAreaSequence={false}
                            t={t}
                          />
                        ))}
                      </div>
                    )}
                    {unassignedGroups.noDriver.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 px-2 py-2 bg-muted/50 rounded-lg">
                          <UserX className="h-4 w-4 text-muted-foreground" />
                          <span className="font-semibold text-sm">
                            {t('unassigned.needsDriver')}
                          </span>
                          <Badge variant="secondary" className="ml-auto">
                            {unassignedGroups.noDriver.length} {unassignedGroups.noDriver.length === 1 ? t('order') : t('orders')}
                          </Badge>
                        </div>
                        {unassignedGroups.noDriver.map((delivery) => (
                          <DeliveryCard
                            key={delivery.id}
                            delivery={delivery}
                            isSelected={selectedDelivery === delivery.id}
                            onSelect={() => setSelectedDelivery(delivery.id)}
                            onMarkDelivered={(e) => {
                              e.stopPropagation();
                              setMarkDeliveredDialog({
                                open: true,
                                delivery: {
                                  id: delivery.id,
                                  orderId: delivery.orderId,
                                  customer: delivery.customer,
                                  packedAt: delivery.packedAt ? new Date(delivery.packedAt) : null,
                                },
                              });
                            }}
                            isMarkDeliveredPending={markDeliveredMutation.isPending}
                            showAreaSequence={false}
                            t={t}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </Card>
        </div>

        {/* Map View */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('deliveryRoutes')}</CardTitle>
              <CardDescription>{t('realTimeTracking')}</CardDescription>
            </CardHeader>
            <CardContent>
              <DeliveryMap
                deliveries={activeTab === 'active' ? activeDeliveries : unassignedDeliveries}
                selectedDelivery={selectedDelivery}
                routeData={activeTab === 'active' ? mapRouteData : undefined}
                selectedDriverId={activeTab === 'active' ? selectedDriverId : null}
                warehouseLocation={routeData?.warehouseLocation}
                emptyStateTitle={t('noDeliveriesAvailable')}
                emptyStateDescription={t('deliveriesWillAppear')}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Route Manifest Dialog */}
      <RouteManifestDialog
        open={manifestDialogOpen}
        onOpenChange={setManifestDialogOpen}
        selectedDate={deliveryDate}
        selectedArea={areaFilter || undefined}
      />

      {/* Auto-Assign Drivers Dialog */}
      <AutoAssignDialog
        deliveryDate={deliveryDateISO}
        open={autoAssignDialogOpen}
        onOpenChange={setAutoAssignDialogOpen}
        onAssigned={() => {
          void utils.delivery.getAll.invalidate();
          void utils.delivery.getOptimizedRoute.invalidate();
        }}
      />

      {/* Mark Delivered Dialog (for admins) */}
      <MarkDeliveredDialog
        delivery={markDeliveredDialog.delivery}
        open={markDeliveredDialog.open}
        onOpenChange={(open) => setMarkDeliveredDialog({ ...markDeliveredDialog, open })}
        onConfirm={async (notes, adminOverride) => {
          if (markDeliveredDialog.delivery) {
            await markDeliveredMutation.mutateAsync({
              orderId: markDeliveredDialog.delivery.id,
              notes,
              adminOverride,
            });
          }
        }}
        isSubmitting={markDeliveredMutation.isPending}
      />
    </div>
  );
}

/** Delivery card used in both flat list and area-grouped views */
function DeliveryCard({
  delivery,
  isSelected,
  onSelect,
  onMarkDelivered,
  isMarkDeliveredPending,
  showAreaSequence,
  t,
}: {
  delivery: {
    id: string;
    orderId: string;
    customer: string;
    address: string;
    status: string;
    areaName: string | null | undefined;
    areaDisplayName?: string | null;
    areaDeliverySequence?: number | null;
    deliverySequence?: number | null;
    estimatedTime: string;
    items: number;
    packedAt?: Date | string | null;
  };
  isSelected: boolean;
  onSelect: () => void;
  onMarkDelivered: (e: React.MouseEvent) => void;
  isMarkDeliveredPending: boolean;
  showAreaSequence: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  const seq = showAreaSequence ? delivery.areaDeliverySequence : delivery.deliverySequence;

  return (
    <div
      className={`p-4 border rounded-lg cursor-pointer transition-colors ${
        isSelected ? 'border-primary bg-primary/5' : 'hover:border-primary/50'
      }`}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          {seq != null && (
            <span className="flex items-center justify-center h-6 w-6 rounded-full bg-primary/10 text-primary text-xs font-bold">
              {seq}
            </span>
          )}
          <div>
            <p className="font-semibold text-sm">{delivery.customer}</p>
            <p className="text-xs text-muted-foreground">{delivery.orderId}</p>
          </div>
        </div>
        <StatusBadge status={delivery.status as StatusType} />
      </div>

      <div className="flex items-start gap-2 text-sm text-muted-foreground mb-2">
        <MapPin className="h-4 w-4 mt-0.5 flex-shrink-0" />
        <span className="text-xs">{delivery.address}</span>
      </div>

      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1">
          <Package className="h-3 w-3" />
          <span>{delivery.items} {t('items')}</span>
        </div>
        <div className="flex items-center gap-1">
          <Navigation className="h-3 w-3" />
          <span>{delivery.estimatedTime}</span>
        </div>
      </div>

      {delivery.status === 'ready_for_delivery' && (
        <div className="mt-3 pt-3 border-t flex justify-end">
          <PermissionGate permission="deliveries:manage">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={onMarkDelivered}
              disabled={isMarkDeliveredPending}
            >
              <CheckCircle className="h-3 w-3 mr-1" />
              {t('markAsDelivered')}
            </Button>
          </PermissionGate>
        </div>
      )}
    </div>
  );
}
