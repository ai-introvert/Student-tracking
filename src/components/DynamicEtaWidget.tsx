import React, { useEffect, useMemo, useState } from 'react';
import {
  Bike,
  Bus,
  Car,
  ChevronDown,
  ChevronUp,
  Clock,
  Footprints,
  Layers,
  RefreshCw,
} from 'lucide-react';
import { StudentProfile, TravelMode } from '../types/wayhome';
import { OfflineRoutePackage } from '../lib/offlineMapCache';
import { formatDistance, formatEta, formatTimeClock, haversineMeters } from '../lib/geo';
import { RouteMetrics } from './CommuteMap';

interface DynamicEtaWidgetProps {
  student: StudentProfile | null;
  travelMode: TravelMode;
  onTravelModeChange: (mode: TravelMode) => void;
  routeMetrics: RouteMetrics | null;
  offlineRoute: OfflineRoutePackage | null;
  isOnline: boolean;
  mapViewMode: 'google' | 'offline';
  showTrafficLayer: boolean;
  onToggleTrafficLayer: () => void;
  onRefreshRoute: () => void;
}

const MODE_OPTIONS: Array<{
  id: TravelMode;
  label: string;
  defaultSpeedKmh: number;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'DRIVING', label: 'Car', defaultSpeedKmh: 28, Icon: Car },
  { id: 'WALKING', label: 'Walk', defaultSpeedKmh: 4.8, Icon: Footprints },
  { id: 'BICYCLING', label: 'Bike', defaultSpeedKmh: 14, Icon: Bike },
  { id: 'TRANSIT', label: 'Transit', defaultSpeedKmh: 22, Icon: Bus },
];

export const DynamicEtaWidget: React.FC<DynamicEtaWidgetProps> = ({
  student,
  travelMode,
  onTravelModeChange,
  routeMetrics,
  offlineRoute,
  isOnline,
  mapViewMode,
  showTrafficLayer,
  onToggleTrafficLayer,
  onRefreshRoute,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Keep projected clock arrival time fresh every 30s
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const etaSnapshot = useMemo(() => {
    if (!student || !student.hasHomePin) return null;

    const isEnRoute =
      student.currentStatus === 'en_route' || student.currentStatus === 'sos_alert';
    const isArrived = student.currentStatus === 'arrived_home';

    const directMeters = isEnRoute
      ? haversineMeters(
          { lat: student.lastLat, lng: student.lastLng },
          { lat: student.homeLat, lng: student.homeLng }
        )
      : haversineMeters(
          { lat: student.schoolLat, lng: student.schoolLng },
          { lat: student.homeLat, lng: student.homeLng }
        );

    const hasMatchingLiveRoute =
      Boolean(routeMetrics) && routeMetrics!.travelMode === travelMode && isOnline;

    const modeMeta =
      MODE_OPTIONS.find((m) => m.id === travelMode) || MODE_OPTIONS[1];

    let remainingMeters = directMeters;
    let remainingMinutes = 0;
    let trafficDelayMinutes = 0;
    let trafficLabel = '';
    let trafficToneClass = 'text-slate-600';
    let sourceLabel = 'Live Route';

    if (isArrived) {
      remainingMeters = 0;
      remainingMinutes = 0;
      trafficLabel = 'Arrived safely at Home Pin';
      trafficToneClass = 'text-emerald-700';
      sourceLabel = 'Arrival Confirmed';
    } else if (hasMatchingLiveRoute && routeMetrics) {
      remainingMeters = isEnRoute
        ? Math.min(routeMetrics.distanceMeters, Math.max(directMeters, 0))
        : routeMetrics.distanceMeters;

      // Interpolate between periodic 150m route refreshes using live remaining ratio
      const ratio =
        isEnRoute && routeMetrics.distanceMeters > 0
          ? Math.max(0.05, Math.min(1, directMeters / routeMetrics.distanceMeters))
          : 1;

      remainingMinutes = Math.max(1, Math.round(routeMetrics.durationMinutes * ratio));
      trafficDelayMinutes = routeMetrics.trafficDelayMinutes;

      if (travelMode === 'DRIVING') {
        if (routeMetrics.trafficCondition === 'heavy') {
          trafficLabel =
            trafficDelayMinutes > 0
              ? `Heavy traffic · +${trafficDelayMinutes} min delay`
              : 'Heavy traffic congestion';
          trafficToneClass = 'text-red-700';
        } else if (routeMetrics.trafficCondition === 'moderate') {
          trafficLabel =
            trafficDelayMinutes > 0
              ? `Moderate traffic · +${trafficDelayMinutes} min delay`
              : 'Moderate traffic along route';
          trafficToneClass = 'text-amber-700';
        } else {
          trafficLabel = 'Light traffic · Clear roads';
          trafficToneClass = 'text-emerald-700';
        }
        sourceLabel = 'Traffic-Aware';
      } else if (travelMode === 'WALKING') {
        trafficLabel = 'Pedestrian path · Unaffected by traffic';
        trafficToneClass = 'text-slate-600';
      } else if (travelMode === 'BICYCLING') {
        trafficLabel = 'Bike route · Pace adjusted';
        trafficToneClass = 'text-slate-600';
      } else {
        trafficLabel = 'Transit estimate · Live schedule';
        trafficToneClass = 'text-slate-600';
      }
    } else {
      // Offline or pre-route fallback estimate based on active travel mode & live speed
      const baseMeters =
        !isEnRoute && offlineRoute && offlineRoute.travelMode === travelMode
          ? offlineRoute.distanceMeters
          : directMeters;
      remainingMeters = baseMeters;

      const effectiveSpeedKmh =
        isEnRoute && student.lastSpeedKmh >= 1.5
          ? student.lastSpeedKmh
          : modeMeta.defaultSpeedKmh;

      remainingMinutes =
        !isEnRoute && offlineRoute && offlineRoute.travelMode === travelMode
          ? offlineRoute.durationMinutes
          : Math.max(1, Math.round((baseMeters / 1000 / effectiveSpeedKmh) * 60));

      trafficLabel = isOnline
        ? `Estimated via ${modeMeta.label.toLowerCase()} speed`
        : 'Offline estimate · Live traffic paused';
      trafficToneClass = isOnline ? 'text-slate-600' : 'text-amber-700';
      sourceLabel = isOnline ? 'Mode Estimate' : 'Offline Cache';
    }

    return {
      isArrived,
      remainingMeters,
      remainingMinutes,
      arrivalClock: formatTimeClock(nowMs + remainingMinutes * 60000),
      trafficLabel,
      trafficToneClass,
      sourceLabel,
      computedAtClock: routeMetrics?.computedAtMs
        ? formatTimeClock(routeMetrics.computedAtMs)
        : null,
    };
  }, [student, travelMode, routeMetrics, offlineRoute, isOnline, nowMs]);

  if (!student || !student.hasHomePin || !etaSnapshot) {
    return null;
  }

  return (
    <div className="w-[calc(100%-2rem)] sm:w-[320px] rounded-xl bg-white/95 backdrop-blur-md border border-slate-200 shadow-md overflow-hidden">
      {/* Compact Header Row */}
      <div className="px-3.5 py-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Clock className="w-4 h-4 text-blue-700 shrink-0" />
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-base font-bold text-slate-900 font-mono tabular-nums whitespace-nowrap">
                {etaSnapshot.isArrived ? 'Arrived' : formatEta(etaSnapshot.remainingMinutes)}
              </span>
              {!etaSnapshot.isArrived && (
                <span className="text-[11px] font-medium text-slate-500 font-mono tabular-nums truncate">
                  {formatDistance(etaSnapshot.remainingMeters)} · Est. {etaSnapshot.arrivalClock}
                </span>
              )}
            </div>
            <p className={`text-[11px] font-semibold truncate ${etaSnapshot.trafficToneClass}`}>
              {etaSnapshot.trafficLabel}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {isOnline && mapViewMode === 'google' && (
            <button
              type="button"
              onClick={onRefreshRoute}
              title="Recalculate ETA with latest traffic"
              aria-label="Recalculate ETA with latest traffic"
              className="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-600 flex items-center justify-center cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand ETA controls' : 'Collapse ETA controls'}
            className="w-8 h-8 rounded-lg hover:bg-slate-100 text-slate-600 flex items-center justify-center cursor-pointer"
          >
            {collapsed ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronUp className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {/* Expandable Mode Switcher & Traffic Layer Controls */}
      {!collapsed && (
        <div className="px-3.5 pb-3 pt-2 border-t border-slate-100 space-y-2.5">
          <div className="grid grid-cols-4 gap-1 p-1 bg-slate-100 rounded-lg">
            {MODE_OPTIONS.map(({ id, label, Icon }) => {
              const active = travelMode === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onTravelModeChange(id)}
                  className={`min-h-[32px] px-1.5 py-1 rounded-md text-[11px] font-semibold inline-flex items-center justify-center gap-1 transition-colors whitespace-nowrap cursor-pointer ${
                    active
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Icon className="w-3 h-3 shrink-0" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-slate-500 truncate">
              {etaSnapshot.sourceLabel}
              {etaSnapshot.computedAtClock ? ` · ${etaSnapshot.computedAtClock}` : ''}
            </span>

            {isOnline && mapViewMode === 'google' && (
              <button
                type="button"
                onClick={onToggleTrafficLayer}
                className={`px-2 py-1 rounded-md border font-semibold inline-flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer ${
                  showTrafficLayer
                    ? 'border-blue-200 bg-blue-50 text-blue-800'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <Layers className="w-3 h-3" />
                <span>{showTrafficLayer ? 'Traffic On' : 'Traffic Off'}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
