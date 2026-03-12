'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Map, { Marker, Popup, NavigationControl, Source, Layer, type MapRef, type MapMouseEvent } from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';
import { MapPin } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { WarehouseMarker } from './components/markers/WarehouseMarker';
import { DeliveryMarker } from './components/markers/DeliveryMarker';
import { FullscreenControl } from './components/FullscreenControl';

// Driver color palette for multi-route visualization
const DRIVER_COLORS = [
  '#3B82F6', // blue
  '#10B981', // green
  '#F59E0B', // amber
  '#EF4444', // red
  '#8B5CF6', // purple
  '#EC4899', // pink
  '#06B6D4', // cyan
  '#F97316', // orange
] as const;

interface Delivery {
  id: string;
  orderId: string;
  customer: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  status: string;
  areaName: string | null; // Can be null if area unassigned
  estimatedTime: string;
  deliverySequence?: number | null;
  areaDeliverySequence?: number | null;
  driverId?: string | null;
  driverName?: string | null;
  driverDeliverySequence?: number | null;
}

interface RouteData {
  geometry: {
    type: string;
    coordinates: [number, number][];
  };
  totalDistance: number;
  totalDuration: number;
  driverId?: string | null;
  driverName?: string | null;
}

interface WarehouseLocation {
  latitude: number;
  longitude: number;
  address?: string;
}

interface DeliveryMapProps {
  deliveries: Delivery[];
  selectedDelivery: string | null;
  routeData?: RouteData | null;
  multiRouteData?: RouteData[];
  selectedDriverId?: string | null;
  warehouseLocation?: WarehouseLocation | null;
  emptyStateTitle?: string;
  emptyStateDescription?: string;
}

export default function DeliveryMap({
  deliveries,
  selectedDelivery,
  routeData,
  multiRouteData,
  selectedDriverId,
  warehouseLocation,
  emptyStateTitle,
  emptyStateDescription,
}: DeliveryMapProps) {
  const t = useTranslations('deliveries');
  const [popupInfo, setPopupInfo] = useState<Delivery | null>(null);
  const [hoveredRouteId, setHoveredRouteId] = useState<string | null>(null);
  const mapRef = useRef<MapRef | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const hasDeliveries = deliveries.length > 0;
  const hasWarehouse = !!warehouseLocation;

  // Animation state for route drawing — progress tracked in ref to avoid 60fps re-renders
  const [animationProgress, setAnimationProgress] = useState<Record<string, number>>({});
  const animationProgressRef = useRef<Record<string, number>>({});
  const [isAnimating, setIsAnimating] = useState(false);

  // Fullscreen state
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Melbourne CBD coordinates as default center
  const [viewState, setViewState] = useState({
    longitude: 144.9631,
    latitude: -37.8136,
    zoom: 12,
  });

  useEffect(() => {
    if (selectedDelivery && mapRef.current && isMapReady && hasDeliveries) {
      const delivery = deliveries.find((d) => d.id === selectedDelivery);
      if (delivery && delivery.latitude && delivery.longitude) {
        mapRef.current.flyTo({
          center: [delivery.longitude, delivery.latitude],
          zoom: 14,
          duration: 1000,
        });
        setPopupInfo(delivery);
      }
    }
  }, [selectedDelivery, isMapReady, hasDeliveries, deliveries]);

  // Center on warehouse when no deliveries but warehouse exists
  const warehouseLat = warehouseLocation?.latitude;
  const warehouseLng = warehouseLocation?.longitude;
  useEffect(() => {
    if (!hasDeliveries && hasWarehouse && warehouseLat != null && warehouseLng != null && mapRef.current && isMapReady) {
      mapRef.current.flyTo({
        center: [warehouseLng, warehouseLat],
        zoom: 12,
        duration: 1000,
      });
    }
  }, [hasDeliveries, hasWarehouse, warehouseLat, warehouseLng, isMapReady]);

  // Animate route drawing when routes change
  // Uses ref for 60fps tracking, throttles React state updates to ~15fps
  useEffect(() => {
    if (!isMapReady || (!multiRouteData && !routeData)) return;

    setIsAnimating(true);
    const routesToAnimate = multiRouteData && multiRouteData.length > 0
      ? multiRouteData.map((route, index) => route.driverId || `route-${index}`)
      : ['single-route'];

    // Initialize all routes to 0% progress
    const initialProgress: Record<string, number> = {};
    routesToAnimate.forEach(routeKey => {
      initialProgress[routeKey] = 0;
    });
    animationProgressRef.current = initialProgress;
    setAnimationProgress(initialProgress);

    let lastStateUpdate = 0;
    const STATE_UPDATE_INTERVAL = 67; // ~15fps for React state updates

    // Animate each route with staggered timing
    routesToAnimate.forEach((routeKey, index) => {
      const delay = index * 500; // 500ms delay between each route
      const duration = 2000; // 2 seconds per route animation
      const startTime = Date.now() + delay;

      const animate = () => {
        const now = Date.now();
        const elapsed = now - startTime;

        if (elapsed < 0) {
          requestAnimationFrame(animate);
          return;
        }

        const progress = Math.min(elapsed / duration, 1);

        // Update ref immediately (no re-render)
        animationProgressRef.current = {
          ...animationProgressRef.current,
          [routeKey]: progress,
        };

        // Throttle React state updates
        if (now - lastStateUpdate >= STATE_UPDATE_INTERVAL || progress >= 1) {
          lastStateUpdate = now;
          setAnimationProgress({ ...animationProgressRef.current });
        }

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else if (index === routesToAnimate.length - 1) {
          // Last route finished — final state sync
          setAnimationProgress({ ...animationProgressRef.current });
          setIsAnimating(false);
        }
      };

      requestAnimationFrame(animate);
    });
  }, [multiRouteData, routeData, isMapReady]);

  // Build interactive layer IDs for route line hover detection
  // NOTE: This useMemo must be called before any early returns to follow React's Rules of Hooks
  const interactiveLayerIds = useMemo(() => {
    if (!multiRouteData || multiRouteData.length === 0) {
      // Include fallback single route layer if it exists
      return routeData?.geometry ? ['route-line'] : [];
    }
    return multiRouteData.map((route, index) => {
      const routeKey = route.driverId || `route-${index}`;
      return `route-line-${routeKey}`;
    });
  }, [multiRouteData, routeData]);

  // Empty state when no deliveries AND no warehouse configured
  if (!hasDeliveries && !hasWarehouse) {
    return (
      <div className="w-full h-[600px] rounded-lg overflow-hidden bg-muted/50 flex flex-col items-center justify-center border border-dashed border-muted-foreground/20">
        <MapPin className="h-16 w-16 text-muted-foreground/30 mb-4" />
        <p className="text-muted-foreground text-lg font-medium">
          {emptyStateTitle ?? t('noDeliveriesAvailable')}
        </p>
        <p className="text-muted-foreground/60 text-sm mt-1">
          {emptyStateDescription ?? t('deliveriesWillAppear')}
        </p>
      </div>
    );
  }


  const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '';

  // Handle mouse enter on route lines
  const handleRouteMouseEnter = (e: MapMouseEvent) => {
    const feature = e.features?.[0];
    if (feature?.layer?.id) {
      const layerId = feature.layer.id;
      // Extract route key from layer ID (e.g., "route-line-driver123" -> "driver123")
      const routeId = layerId.replace('route-line-', '');
      setHoveredRouteId(routeId);
      if (mapRef.current) {
        mapRef.current.getCanvas().style.cursor = 'pointer';
      }
    }
  };

  // Handle mouse leave from route lines
  const handleRouteMouseLeave = () => {
    setHoveredRouteId(null);
    if (mapRef.current) {
      mapRef.current.getCanvas().style.cursor = '';
    }
  };

  return (
    <div
      id="delivery-map-container"
      className={`relative w-full rounded-lg overflow-hidden transition-all duration-300 ${
        isFullscreen ? 'fixed inset-0 z-50 bg-white' : 'h-[600px]'
      }`}
    >
      <FullscreenControl onToggle={setIsFullscreen} />

      <Map
        ref={mapRef}
        {...viewState}
        onMove={(evt) => setViewState(evt.viewState)}
        onLoad={() => setIsMapReady(true)}
        onMouseEnter={handleRouteMouseEnter}
        onMouseLeave={handleRouteMouseLeave}
        interactiveLayerIds={interactiveLayerIds}
        mapStyle="mapbox://styles/mapbox/streets-v12"
        mapboxAccessToken={MAPBOX_TOKEN}
        style={{ width: '100%', height: '100%' }}
      >
        <NavigationControl position="top-right" />

        {/* Multi-Route Lines - render each driver's route with distinct colors */}
        {multiRouteData && multiRouteData.length > 0 ? (
          multiRouteData.map((route, index) => {
            const isSelected = selectedDriverId === null || selectedDriverId === route.driverId;
            const color = DRIVER_COLORS[index % DRIVER_COLORS.length];
            const routeKey = route.driverId || `route-${index}`;
            const isHovered = hoveredRouteId === routeKey;
            const progress = animationProgress[routeKey] ?? 1;

            // Animation effect using dash array
            const dashArray = [2, 1]; // Pattern for dashed line during animation
            const dashOffset = isAnimating ? (1 - progress) * 3 : 0;

            return (
              <Source
                key={routeKey}
                id={`route-${routeKey}`}
                type="geojson"
                data={{
                  type: 'Feature' as const,
                  properties: {},
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  geometry: route.geometry as any,
                }}
              >
                {/* Glow layer - rendered first (below main line) when hovered or selected */}
                {(isSelected || isHovered) && (
                  <Layer
                    id={`route-line-glow-${routeKey}`}
                    type="line"
                    paint={{
                      'line-color': color,
                      'line-width': isHovered ? 12 : 8,
                      'line-opacity': (isHovered ? 0.3 : 0.2) * progress,
                      'line-blur': isHovered ? 6 : 4,
                      ...(isAnimating && {
                        'line-dasharray': dashArray,
                        'line-dash-offset': dashOffset,
                      }),
                    }}
                  />
                )}
                {/* Main route line */}
                <Layer
                  id={`route-line-${routeKey}`}
                  type="line"
                  paint={{
                    'line-color': color,
                    'line-width': isHovered ? 6 : (isSelected ? 4 : 2),
                    'line-opacity': (isHovered ? 1.0 : (isSelected ? 0.8 : 0.3)) * progress,
                    ...(isAnimating && {
                      'line-dasharray': dashArray,
                      'line-dash-offset': dashOffset,
                    }),
                  }}
                />
              </Source>
            );
          })
        ) : routeData && routeData.geometry ? (
          /* Fallback: Single route for backward compatibility */
          (() => {
            const isSingleRouteHovered = hoveredRouteId === '';
            const progress = animationProgress['single-route'] ?? 1;

            // Animation effect using dash array
            const dashArray = [2, 1]; // Pattern for dashed line during animation
            const dashOffset = isAnimating ? (1 - progress) * 3 : 0;

            return (
              <Source
                id="route"
                type="geojson"
                data={{
                  type: 'Feature' as const,
                  properties: {},
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  geometry: routeData.geometry as any,
                }}
              >
                {/* Glow layer */}
                <Layer
                  id="route-line-glow"
                  type="line"
                  paint={{
                    'line-color': '#FF6B35',
                    'line-width': isSingleRouteHovered ? 12 : 8,
                    'line-opacity': (isSingleRouteHovered ? 0.3 : 0.2) * progress,
                    'line-blur': isSingleRouteHovered ? 6 : 4,
                    ...(isAnimating && {
                      'line-dasharray': dashArray,
                      'line-dash-offset': dashOffset,
                    }),
                  }}
                />
                {/* Main route line */}
                <Layer
                  id="route-line"
                  type="line"
                  paint={{
                    'line-color': '#FF6B35',
                    'line-width': isSingleRouteHovered ? 6 : 4,
                    'line-opacity': (isSingleRouteHovered ? 1.0 : 0.8) * progress,
                    ...(isAnimating && {
                      'line-dasharray': dashArray,
                      'line-dash-offset': dashOffset,
                    }),
                  }}
                />
              </Source>
            );
          })()
        ) : null}

        {/* Warehouse Origin Marker */}
        {warehouseLocation && (
          <Marker
            longitude={warehouseLocation.longitude}
            latitude={warehouseLocation.latitude}
            anchor="center"
          >
            <WarehouseMarker isActive={hasDeliveries} />
          </Marker>
        )}

        {/* Delivery Markers with Sequence Numbers */}
        {deliveries
          .filter((delivery) => delivery.latitude && delivery.longitude)
          .map((delivery) => (
            <Marker
              key={delivery.id}
              longitude={delivery.longitude!}
              latitude={delivery.latitude!}
              anchor="center"
              onClick={(e) => {
                e.originalEvent.stopPropagation();
                setPopupInfo(delivery);
              }}
            >
              <DeliveryMarker
                status={delivery.status}
                sequence={delivery.areaDeliverySequence}
                isPriority={false} // TODO: Add priority field to delivery data
                onClick={() => setPopupInfo(delivery)}
              />
            </Marker>
          ))}

        {popupInfo && popupInfo.latitude && popupInfo.longitude && (
          <Popup
            longitude={popupInfo.longitude}
            latitude={popupInfo.latitude}
            anchor="top"
            onClose={() => setPopupInfo(null)}
            closeOnClick={false}
          >
            <div className="p-2 min-w-[200px]">
              <h3 className="font-semibold text-sm mb-1">{popupInfo.customer}</h3>
              <p className="text-xs text-gray-600 mb-2">{popupInfo.orderId}</p>
              <p className="text-xs text-gray-500 mb-2">{popupInfo.address}</p>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-600">
                  {popupInfo.areaName && t('map.popup.area', { areaName: popupInfo.areaName.toUpperCase() })}
                  {popupInfo.areaDeliverySequence && ` • ${t('map.popup.sequence', { sequence: popupInfo.areaDeliverySequence })}`}
                </span>
                <span
                  className={`px-2 py-0.5 rounded-full ${
                    popupInfo.status === 'ready_for_delivery'
                      ? 'bg-yellow-100 text-yellow-800'
                      : 'bg-green-100 text-green-800'
                  }`}
                >
                  {popupInfo.status.replace(/_/g, ' ')}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-1">{t('map.popup.eta', { time: popupInfo.estimatedTime })}</p>
            </div>
          </Popup>
        )}
      </Map>

      {/* Route Legend - shows when multiple routes exist */}
      {multiRouteData && multiRouteData.length > 1 && (
        <div className="absolute top-4 left-4 bg-white/95 rounded-lg shadow-md p-3 z-10 max-w-[200px]">
          <h4 className="text-sm font-semibold mb-2 text-gray-700">
            {t('map.legend.title')}
          </h4>
          <div className="space-y-1.5">
            {multiRouteData.map((route, index) => {
              const color = DRIVER_COLORS[index % DRIVER_COLORS.length];
              const isSelected = selectedDriverId === null || selectedDriverId === route.driverId;

              return (
                <div
                  key={route.driverId || index}
                  className={`flex items-center gap-2 text-xs ${
                    isSelected ? 'opacity-100' : 'opacity-50'
                  }`}
                >
                  <div
                    className="w-4 h-1 rounded-full flex-shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <span className="truncate">
                    {route.driverName || t('map.legend.unassigned')}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
