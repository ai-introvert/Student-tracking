import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  APILoadingStatus,
  Map as GoogleMap,
  AdvancedMarker,
  InfoWindow,
  RenderingType,
  useApiLoadingStatus,
  useMap,
  useMapsLibrary,
  useAdvancedMarkerRef,
  MapMouseEvent,
} from '@vis.gl/react-google-maps';
import { Home, School, Navigation, AlertTriangle, CheckCircle2, Loader2, WifiOff } from 'lucide-react';
import {
  BreadcrumbPoint,
  LatLngPoint,
  StudentProfile,
  TravelMode,
} from '../types/wayhome';
import { triggerQuotaNoticeIfNeeded } from '../hooks/useAutocompleteSuggestions';
import {
  formatDistance,
  formatEta,
  getStatusMeta,
  haversineMeters,
} from '../lib/geo';

export type MapPinMode = 'none' | 'home' | 'school';

export type TrafficCondition = 'light' | 'moderate' | 'heavy' | 'not_applicable';

export interface RouteMetrics {
  distanceMeters: number;
  durationMinutes: number;
  staticDurationMinutes: number;
  trafficDelayMinutes: number;
  trafficCondition: TrafficCondition;
  travelMode: TravelMode;
  computedAtMs: number;
  path: LatLngPoint[];
}

interface CommuteMapProps {
  students: StudentProfile[];
  selectedStudentId: string | null;
  onSelectStudent?: (studentId: string) => void;
  breadcrumbsByStudent?: Record<string, BreadcrumbPoint[]>;
  pinMode?: MapPinMode;
  onMapPinDrop?: (coords: LatLngPoint) => void;
  travelMode?: TravelMode;
  onRouteComputed?: (metrics: RouteMetrics) => void;
  defaultCenter?: LatLngPoint;
  showTrafficLayer?: boolean;
  routeRefreshNonce?: number;
  onSwitchToOffline?: () => void;
}

const DEFAULT_CENTER: LatLngPoint = { lat: 37.7749, lng: -122.4194 };

const RouteAndGeofenceLayer: React.FC<{
  student: StudentProfile | null;
  breadcrumbs: BreadcrumbPoint[];
  travelMode: TravelMode;
  onRouteComputed?: (metrics: RouteMetrics) => void;
  showTrafficLayer?: boolean;
  routeRefreshNonce?: number;
  defaultCenter: LatLngPoint;
}> = ({
  student,
  breadcrumbs,
  travelMode,
  onRouteComputed,
  showTrafficLayer = false,
  routeRefreshNonce = 0,
  defaultCenter,
}) => {
  const map = useMap();
  const routesLib = useMapsLibrary('routes');
  const routePolylinesRef = useRef<google.maps.Polyline[]>([]);
  const breadcrumbPolylineRef = useRef<google.maps.Polyline | null>(null);
  const geofenceCircleRef = useRef<google.maps.Circle | null>(null);
  const trafficLayerRef = useRef<google.maps.TrafficLayer | null>(null);
  const lastFittedKeyRef = useRef<string>('');
  const lastComputedOriginRef = useRef<{ key: string; point: LatLngPoint } | null>(null);
  const [liveAnchorTick, setLiveAnchorTick] = useState(0);

  // Toggle native Google Maps TrafficLayer overlay
  useEffect(() => {
    if (trafficLayerRef.current) {
      trafficLayerRef.current.setMap(null);
      trafficLayerRef.current = null;
    }

    if (!map || !showTrafficLayer || typeof google === 'undefined') return;

    trafficLayerRef.current = new google.maps.TrafficLayer();
    trafficLayerRef.current.setMap(map);

    return () => {
      if (trafficLayerRef.current) {
        trafficLayerRef.current.setMap(null);
        trafficLayerRef.current = null;
      }
    };
  }, [map, showTrafficLayer]);

  // Draw 100m Home Safety Geofence Circle
  useEffect(() => {
    if (geofenceCircleRef.current) {
      geofenceCircleRef.current.setMap(null);
      geofenceCircleRef.current = null;
    }

    if (!map || !student || !student.hasHomePin || typeof google === 'undefined') return;

    geofenceCircleRef.current = new google.maps.Circle({
      map,
      center: { lat: student.homeLat, lng: student.homeLng },
      radius: 100,
      strokeColor: '#16A34A',
      strokeOpacity: 0.75,
      strokeWeight: 1.5,
      fillColor: '#16A34A',
      fillOpacity: 0.12,
      clickable: false,
    });

    return () => {
      if (geofenceCircleRef.current) {
        geofenceCircleRef.current.setMap(null);
        geofenceCircleRef.current = null;
      }
    };
  }, [map, student?.id, student?.hasHomePin, student?.homeLat, student?.homeLng]);

  // Draw Live Breadcrumb Trail Polyline
  useEffect(() => {
    if (breadcrumbPolylineRef.current) {
      breadcrumbPolylineRef.current.setMap(null);
      breadcrumbPolylineRef.current = null;
    }

    if (!map || breadcrumbs.length < 2 || typeof google === 'undefined') return;

    breadcrumbPolylineRef.current = new google.maps.Polyline({
      map,
      path: breadcrumbs.map((b) => ({ lat: b.lat, lng: b.lng })),
      strokeColor: student?.currentStatus === 'sos_alert' ? '#DC2626' : '#16A34A',
      strokeOpacity: 0.9,
      strokeWeight: 4,
      zIndex: 20,
    });

    return () => {
      if (breadcrumbPolylineRef.current) {
        breadcrumbPolylineRef.current.setMap(null);
        breadcrumbPolylineRef.current = null;
      }
    };
  }, [map, breadcrumbs, student?.currentStatus]);

  // Trigger a route & traffic-aware ETA refresh when moving >= 150m while en_route
  useEffect(() => {
    if (!student || !student.hasHomePin) return;
    if (student.currentStatus !== 'en_route' && student.currentStatus !== 'sos_alert') return;

    const currentPt = { lat: student.lastLat, lng: student.lastLng };
    const baseKey = `${student.id}_${travelMode}`;
    const prev = lastComputedOriginRef.current;

    if (!prev || prev.key !== baseKey || haversineMeters(prev.point, currentPt) >= 150) {
      lastComputedOriginRef.current = { key: baseKey, point: currentPt };
      setLiveAnchorTick((t) => t + 1);
    }
  }, [student?.id, student?.hasHomePin, student?.currentStatus, student?.lastLat, student?.lastLng, travelMode]);

  // Compute Recommended Route from School (or current position) to Home using Routes API (New)
  useEffect(() => {
    routePolylinesRef.current.forEach((p) => p.setMap(null));
    routePolylinesRef.current = [];

    if (!map || !routesLib || !student || !student.hasHomePin) return;

    const isEnRoute =
      student.currentStatus === 'en_route' || student.currentStatus === 'sos_alert';
    const origin = isEnRoute
      ? { lat: student.lastLat, lng: student.lastLng }
      : { lat: student.schoolLat, lng: student.schoolLng };

    const destination = { lat: student.homeLat, lng: student.homeLng };
    const routeKey = `${student.id}_${student.schoolLat.toFixed(4)}_${student.schoolLng.toFixed(4)}_${student.homeLat.toFixed(4)}_${student.homeLng.toFixed(4)}_${travelMode}`;
    lastComputedOriginRef.current = { key: `${student.id}_${travelMode}`, point: origin };

    let cancelled = false;
    const isTrafficAwareMode = travelMode === 'DRIVING';

    const request: Record<string, unknown> = {
      origin,
      destination,
      travelMode,
      fields: isTrafficAwareMode
        ? [
            'path',
            'distanceMeters',
            'durationMillis',
            'staticDurationMillis',
            'viewport',
            'travelAdvisory',
          ]
        : ['path', 'distanceMeters', 'durationMillis', 'viewport'],
    };

    if (isTrafficAwareMode) {
      request.routingPreference = 'TRAFFIC_AWARE';
    }

    (routesLib.Route as any)
      .computeRoutes(request)
      .then(({ routes }: { routes: any[] }) => {
        if (cancelled || !routes || routes.length === 0) return;

        const primaryRoute = routes[0];
        const newPolylines: google.maps.Polyline[] = primaryRoute.createPolylines
          ? primaryRoute.createPolylines()
          : [];

        newPolylines.forEach((polyline) => {
          polyline.setOptions({
            strokeColor: '#1D4ED8',
            strokeOpacity: 0.78,
            strokeWeight: 5,
            zIndex: 10,
          });
          polyline.setMap(map);
        });
        routePolylinesRef.current = newPolylines;

        if (primaryRoute.viewport && lastFittedKeyRef.current !== routeKey) {
          map.fitBounds(primaryRoute.viewport, 64);
          lastFittedKeyRef.current = routeKey;
        }

        const rawPath: LatLngPoint[] = Array.isArray(primaryRoute.path)
          ? primaryRoute.path.map((pt: google.maps.LatLng) => ({
              lat: typeof pt.lat === 'function' ? pt.lat() : (pt as any).lat,
              lng: typeof pt.lng === 'function' ? pt.lng() : (pt as any).lng,
            }))
          : [origin, destination];

        const durationMillis: number = primaryRoute.durationMillis ?? 0;
        const staticDurationMillis: number =
          primaryRoute.staticDurationMillis ?? durationMillis;
        const durationMinutes = Math.max(1, Math.round(durationMillis / 60000));
        const staticDurationMinutes = Math.max(1, Math.round(staticDurationMillis / 60000));
        const trafficDelayMinutes = isTrafficAwareMode
          ? Math.max(0, Math.round((durationMillis - staticDurationMillis) / 60000))
          : 0;

        const intervals: Array<{ speed?: string }> =
          primaryRoute.travelAdvisory?.speedReadingIntervals || [];
        const hasJam = intervals.some((i) => i.speed === 'TRAFFIC_JAM');
        const hasSlow = intervals.some((i) => i.speed === 'SLOW');

        let trafficCondition: TrafficCondition = 'not_applicable';
        if (isTrafficAwareMode) {
          if (hasJam || trafficDelayMinutes >= 5) {
            trafficCondition = 'heavy';
          } else if (hasSlow || trafficDelayMinutes >= 2) {
            trafficCondition = 'moderate';
          } else {
            trafficCondition = 'light';
          }
        }

        onRouteComputed?.({
          distanceMeters: primaryRoute.distanceMeters ?? 0,
          durationMinutes,
          staticDurationMinutes,
          trafficDelayMinutes,
          trafficCondition,
          travelMode,
          computedAtMs: Date.now(),
          path: rawPath.length >= 2 ? rawPath : [origin, destination],
        });
      })
      .catch((err: unknown) => {
        triggerQuotaNoticeIfNeeded(err);
      });

    return () => {
      cancelled = true;
      routePolylinesRef.current.forEach((p) => p.setMap(null));
      routePolylinesRef.current = [];
    };
  }, [
    map,
    routesLib,
    student?.id,
    student?.hasHomePin,
    student?.schoolLat,
    student?.schoolLng,
    student?.homeLat,
    student?.homeLng,
    travelMode,
    liveAnchorTick,
    routeRefreshNonce,
  ]);

  // Center map smoothly when selected student changes or geolocation resolves before student setup
  const lastCenteredIdRef = useRef<string>('');
  useEffect(() => {
    if (!map || typeof google === 'undefined') return;
    if (student) {
      if (student.currentStatus === 'en_route' || student.currentStatus === 'sos_alert') {
        map.panTo({ lat: student.lastLat, lng: student.lastLng });
      } else if (lastCenteredIdRef.current !== student.id) {
        lastCenteredIdRef.current = student.id;
        if (Number.isFinite(student.lastLat) && Number.isFinite(student.lastLng)) {
          map.panTo({ lat: student.lastLat, lng: student.lastLng });
        }
      }
    } else if (Number.isFinite(defaultCenter.lat) && Number.isFinite(defaultCenter.lng)) {
      map.panTo(defaultCenter);
    }
  }, [map, student?.id, student?.lastLat, student?.lastLng, student?.currentStatus, defaultCenter.lat, defaultCenter.lng]);

  return null;
};

const StudentMarkerItem: React.FC<{
  student: StudentProfile;
  isSelected: boolean;
  onSelect: () => void;
}> = ({ student, isSelected, onSelect }) => {
  const [markerRef, marker] = useAdvancedMarkerRef();
  const [infoOpen, setInfoOpen] = useState(false);
  const statusMeta = getStatusMeta(student.currentStatus);

  const isSos = student.currentStatus === 'sos_alert';
  const isArrived = student.currentStatus === 'arrived_home';
  const isEnRoute = student.currentStatus === 'en_route';

  const bgClass = isSos
    ? 'bg-red-600 text-white border-white'
    : isArrived
    ? 'bg-emerald-600 text-white border-white'
    : isEnRoute
    ? 'bg-blue-700 text-white border-white'
    : 'bg-slate-800 text-white border-white';

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: student.lastLat, lng: student.lastLng }}
        zIndex={isSos ? 100 : isSelected ? 80 : 50}
        onClick={() => {
          onSelect();
          setInfoOpen(true);
        }}
        title={`${student.studentName} (${statusMeta.label})`}
      >
        <div className="relative flex flex-col items-center cursor-pointer select-none">
          <div
            className={`px-2.5 py-1.5 rounded-xl border-2 shadow-md flex items-center gap-1.5 transition-transform ${bgClass} ${
              isSelected ? 'scale-110 ring-4 ring-blue-700/25' : ''
            }`}
          >
            {isSos ? (
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            ) : isArrived ? (
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <Navigation
                className="w-3.5 h-3.5 shrink-0"
                style={{ transform: `rotate(${student.lastHeading}deg)` }}
              />
            )}
            <span className="text-xs font-semibold whitespace-nowrap">
              {student.studentName.split(' ')[0]}
            </span>
          </div>
          <div
            className={`w-2.5 h-2.5 -mt-1.5 rotate-45 border-r-2 border-b-2 ${
              isSos
                ? 'bg-red-600 border-white'
                : isArrived
                ? 'bg-emerald-600 border-white'
                : isEnRoute
                ? 'bg-blue-700 border-white'
                : 'bg-slate-800 border-white'
            }`}
          />
        </div>
      </AdvancedMarker>

      {infoOpen && marker && (
        <InfoWindow anchor={marker} onCloseClick={() => setInfoOpen(false)} maxWidth={250}>
          <div className="p-1 text-slate-900">
            <p className="text-sm font-semibold">{student.studentName}</p>
            <p className="text-xs text-slate-600 mt-0.5">
              {student.gradeSection} · {statusMeta.label}
            </p>
            {student.currentStatus === 'en_route' && (
              <p className="text-xs font-mono text-slate-700 mt-1.5">
                {formatDistance(student.distanceRemainingMeters)} · ETA {formatEta(student.etaMinutes)}
              </p>
            )}
          </div>
        </InfoWindow>
      )}
    </>
  );
};

export const CommuteMap: React.FC<CommuteMapProps> = ({
  students,
  selectedStudentId,
  onSelectStudent,
  breadcrumbsByStudent = {},
  pinMode = 'none',
  onMapPinDrop,
  travelMode = 'WALKING',
  onRouteComputed,
  defaultCenter = DEFAULT_CENTER,
  showTrafficLayer = false,
  routeRefreshNonce = 0,
  onSwitchToOffline,
}) => {
  const apiStatus = useApiLoadingStatus();
  const selectedStudent =
    students.find((s) => s.id === selectedStudentId) || students[0] || null;

  const initialCenter =
    selectedStudent &&
    Number.isFinite(selectedStudent.lastLat) &&
    Number.isFinite(selectedStudent.lastLng)
      ? { lat: selectedStudent.lastLat, lng: selectedStudent.lastLng }
      : Number.isFinite(defaultCenter.lat) && Number.isFinite(defaultCenter.lng)
      ? defaultCenter
      : DEFAULT_CENTER;

  const handleMapClick = useCallback(
    (ev: MapMouseEvent) => {
      if (pinMode === 'none' || !onMapPinDrop || !ev.detail.latLng) return;
      onMapPinDrop({
        lat: ev.detail.latLng.lat,
        lng: ev.detail.latLng.lng,
      });
    },
    [pinMode, onMapPinDrop]
  );

  const selectedBreadcrumbs = selectedStudent
    ? breadcrumbsByStudent[selectedStudent.id] || []
    : [];

  const isLoadingApi =
    apiStatus === APILoadingStatus.NOT_LOADED || apiStatus === APILoadingStatus.LOADING;
  const isApiFailed =
    apiStatus === APILoadingStatus.FAILED || apiStatus === APILoadingStatus.AUTH_FAILURE;

  return (
    <div className="relative w-full h-full min-h-[420px] bg-slate-100 overflow-hidden">
      {pinMode !== 'none' && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 px-4 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg shadow-lg flex items-center gap-2 pointer-events-none">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <span>
            {pinMode === 'home'
              ? 'Click anywhere on the map to pin your Home location'
              : 'Click anywhere on the map to pin your School Campus'}
          </span>
        </div>
      )}

      {isLoadingApi && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-100/80 backdrop-blur-[1px] pointer-events-none">
          <div className="px-4 py-2.5 rounded-xl bg-white border border-slate-200 shadow-sm flex items-center gap-2.5 text-xs font-semibold text-slate-700">
            <Loader2 className="w-4 h-4 animate-spin text-blue-700" />
            <span>Loading Live Google Map...</span>
          </div>
        </div>
      )}

      {isApiFailed && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-100/95 p-6">
          <div className="max-w-sm w-full p-5 rounded-2xl bg-white border border-slate-200 shadow-md text-center space-y-3">
            <div className="w-10 h-10 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center mx-auto">
              <WifiOff className="w-5 h-5" />
            </div>
            <h3 className="text-sm font-bold text-slate-900">
              Live Google Map unavailable
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Google Maps tiles could not be loaded in this session. You can switch to the Offline Map immediately to view locations and pin coordinates.
            </p>
            {onSwitchToOffline && (
              <button
                type="button"
                onClick={onSwitchToOffline}
                className="w-full min-h-[40px] px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer"
              >
                Switch to Offline Map
              </button>
            )}
          </div>
        </div>
      )}

      <div className="absolute inset-0 w-full h-full">
        <GoogleMap
          mapId="DEMO_MAP_ID"
          renderingType={RenderingType.RASTER}
          internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
          defaultCenter={initialCenter}
          defaultZoom={14}
          gestureHandling="greedy"
          disableDefaultUI={false}
          mapTypeControl={false}
          streetViewControl={false}
          fullscreenControl={true}
          onClick={handleMapClick}
          style={{ width: '100%', height: '100%' }}
        >
          <RouteAndGeofenceLayer
            student={selectedStudent}
            breadcrumbs={selectedBreadcrumbs}
            travelMode={travelMode}
            onRouteComputed={onRouteComputed}
            showTrafficLayer={showTrafficLayer}
            routeRefreshNonce={routeRefreshNonce}
            defaultCenter={defaultCenter}
          />

        {/* Selected Student's School Origin Marker */}
        {selectedStudent && (
          <AdvancedMarker
            position={{
              lat: selectedStudent.schoolLat,
              lng: selectedStudent.schoolLng,
            }}
            title={`School: ${selectedStudent.schoolName}`}
            zIndex={30}
          >
            <div className="flex flex-col items-center select-none">
              <div className="px-2.5 py-1.5 rounded-lg bg-slate-900 text-white border border-white shadow-md flex items-center gap-1.5">
                <School className="w-3.5 h-3.5 text-blue-300 shrink-0" />
                <span className="text-xs font-medium whitespace-nowrap max-w-[140px] truncate">
                  {selectedStudent.schoolName}
                </span>
              </div>
            </div>
          </AdvancedMarker>
        )}

        {/* Selected Student's Home Pin Marker */}
        {selectedStudent && selectedStudent.hasHomePin && (
          <AdvancedMarker
            position={{
              lat: selectedStudent.homeLat,
              lng: selectedStudent.homeLng,
            }}
            title={`Home Pin: ${selectedStudent.homeAddress || 'Pinned Home'}`}
            zIndex={40}
          >
            <div className="flex flex-col items-center select-none">
              <div className="px-2.5 py-1.5 rounded-lg bg-emerald-700 text-white border-2 border-white shadow-md flex items-center gap-1.5">
                <Home className="w-3.5 h-3.5 shrink-0" />
                <span className="text-xs font-semibold whitespace-nowrap">Home Pin</span>
              </div>
              <div className="w-2 h-2 -mt-1 rotate-45 bg-emerald-700 border-r-2 border-b-2 border-white" />
            </div>
          </AdvancedMarker>
        )}

        {/* All Tracked Student Live Markers */}
        {students.map((student) => (
          <StudentMarkerItem
            key={student.id}
            student={student}
            isSelected={student.id === selectedStudent?.id}
            onSelect={() => onSelectStudent?.(student.id)}
          />
        ))}
        </GoogleMap>
      </div>

      {/* Bottom-left Map Legend */}
      <div className="hidden sm:flex items-center gap-4 absolute bottom-4 left-4 z-10 px-3.5 py-2 bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm text-xs text-slate-700">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-slate-900" />
          School
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-emerald-700" />
          Home Pin (100m zone)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-blue-700" />
          Live Student
        </span>
      </div>
    </div>
  );
};
