import { FIELD_LIMITS, LatLngPoint, StudentStatus } from '../types/wayhome';

export function haversineMeters(a: LatLngPoint, b: LatLngPoint): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function computeBearing(from: LatLngPoint, to: LatLngPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLng = toRad(to.lng - from.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const bearing = (toDeg(Math.atan2(y, x)) + 360) % 360;
  return Number.isFinite(bearing) ? Math.round(bearing) : 0;
}

export function clampText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

export function clampCoord(lat: number, lng: number): LatLngPoint {
  const safeLat = Math.max(-90, Math.min(90, Number.isFinite(lat) ? lat : 0));
  const safeLng = Math.max(-180, Math.min(180, Number.isFinite(lng) ? lng : 0));
  return { lat: safeLat, lng: safeLng };
}

export function generateShareCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'WH';
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function generateSafeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}_${rand}`.replace(/[^a-zA-Z0-9_-]/g, '');
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return '0 m';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

export function formatEta(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'Arriving';
  if (minutes < 1) return '< 1 min';
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  const hrs = Math.floor(rounded / 60);
  const mins = rounded % 60;
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

export function formatRelativeTime(tsMs: number): string {
  if (!tsMs) return 'Just now';
  const diffSec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
  if (diffSec < 10) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

export function formatTimeClock(tsMs: number): string {
  if (!tsMs) return '--:--';
  return new Date(tsMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function getStatusMeta(status: StudentStatus | string): {
  label: string;
  textClass: string;
  dotClass: string;
  surfaceClass: string;
} {
  switch (status) {
    case 'en_route':
      return {
        label: 'En Route Home',
        textClass: 'text-amber-700',
        dotClass: 'bg-amber-500',
        surfaceClass: 'bg-amber-50 border-amber-200',
      };
    case 'sos_alert':
      return {
        label: 'SOS Emergency',
        textClass: 'text-red-700',
        dotClass: 'bg-red-600',
        surfaceClass: 'bg-red-50 border-red-200',
      };
    case 'arrived_home':
      return {
        label: 'Arrived Safely',
        textClass: 'text-emerald-700',
        dotClass: 'bg-emerald-600',
        surfaceClass: 'bg-emerald-50 border-emerald-200',
      };
    case 'at_school':
      return {
        label: 'At School',
        textClass: 'text-blue-700',
        dotClass: 'bg-blue-600',
        surfaceClass: 'bg-blue-50 border-blue-200',
      };
    default:
      return {
        label: 'Standby',
        textClass: 'text-slate-600',
        dotClass: 'bg-slate-400',
        surfaceClass: 'bg-slate-50 border-slate-200',
      };
  }
}

export function sanitizeAddress(address: string): string {
  return clampText(address, FIELD_LIMITS.ADDRESS_MAX);
}
