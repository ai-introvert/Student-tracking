import { BreadcrumbPoint, LatLngPoint, StudentProfile, TravelMode } from '../types/wayhome';

const ROUTE_CACHE_STORAGE_KEY = 'wayhome_offline_routes_v1';
const OFFLINE_QUEUE_STORAGE_KEY = 'wayhome_offline_breadcrumbs_v1';

// Per Google Maps Platform Service Specific Terms, cached geospatial coordinates (lat/lng)
// are strictly bounded to a maximum of 30 consecutive calendar days.
export const MAX_OFFLINE_ROUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface OfflineRoutePackage {
  studentId: string;
  studentName: string;
  gradeSection: string;
  schoolName: string;
  schoolLat: number;
  schoolLng: number;
  homeAddress: string;
  homeLat: number;
  homeLng: number;
  hasHomePin: boolean;
  travelMode: TravelMode;
  distanceMeters: number;
  durationMinutes: number;
  path: LatLngPoint[];
  savedAtMs: number;
  expiresAtMs: number;
}

export interface QueuedOfflineBreadcrumb {
  commuteId: string;
  studentId: string;
  point: BreadcrumbPoint;
  heading: number;
  etaMinutes: number;
  distanceRemainingMeters: number;
}

function safeReadJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safeWriteJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadAllOfflineRoutes(): Record<string, OfflineRoutePackage> {
  const raw = safeReadJson<Record<string, OfflineRoutePackage>>(ROUTE_CACHE_STORAGE_KEY, {});
  const now = Date.now();
  const valid: Record<string, OfflineRoutePackage> = {};
  let changed = false;

  Object.entries(raw).forEach(([studentId, pkg]) => {
    if (pkg && typeof pkg.expiresAtMs === 'number' && pkg.expiresAtMs > now) {
      valid[studentId] = pkg;
    } else {
      changed = true;
    }
  });

  if (changed) {
    safeWriteJson(ROUTE_CACHE_STORAGE_KEY, valid);
  }
  return valid;
}

export function getOfflineRouteForStudent(studentId: string): OfflineRoutePackage | null {
  const all = loadAllOfflineRoutes();
  return all[studentId] || null;
}

export function saveOfflineRouteForStudent(params: {
  student: StudentProfile;
  travelMode: TravelMode;
  distanceMeters: number;
  durationMinutes: number;
  path: LatLngPoint[];
}): OfflineRoutePackage {
  const all = loadAllOfflineRoutes();
  const now = Date.now();
  const pkg: OfflineRoutePackage = {
    studentId: params.student.id,
    studentName: params.student.studentName,
    gradeSection: params.student.gradeSection,
    schoolName: params.student.schoolName,
    schoolLat: params.student.schoolLat,
    schoolLng: params.student.schoolLng,
    homeAddress: params.student.homeAddress,
    homeLat: params.student.homeLat,
    homeLng: params.student.homeLng,
    hasHomePin: params.student.hasHomePin,
    travelMode: params.travelMode,
    distanceMeters: Math.max(0, Math.round(params.distanceMeters)),
    durationMinutes: Math.max(1, Math.round(params.durationMinutes)),
    path: params.path.slice(0, 600),
    savedAtMs: now,
    expiresAtMs: now + MAX_OFFLINE_ROUTE_TTL_MS,
  };
  all[params.student.id] = pkg;
  safeWriteJson(ROUTE_CACHE_STORAGE_KEY, all);
  return pkg;
}

export function removeOfflineRouteForStudent(studentId: string): void {
  const all = loadAllOfflineRoutes();
  if (all[studentId]) {
    delete all[studentId];
    safeWriteJson(ROUTE_CACHE_STORAGE_KEY, all);
  }
}

export function loadQueuedOfflineBreadcrumbs(): QueuedOfflineBreadcrumb[] {
  return safeReadJson<QueuedOfflineBreadcrumb[]>(OFFLINE_QUEUE_STORAGE_KEY, []);
}

export function enqueueOfflineBreadcrumb(item: QueuedOfflineBreadcrumb): QueuedOfflineBreadcrumb[] {
  const current = loadQueuedOfflineBreadcrumbs();
  const next = [...current, item].slice(-95);
  safeWriteJson(OFFLINE_QUEUE_STORAGE_KEY, next);
  return next;
}

export function clearQueuedOfflineBreadcrumbsForCommute(commuteId: string): void {
  const current = loadQueuedOfflineBreadcrumbs();
  const remaining = current.filter((b) => b.commuteId !== commuteId);
  safeWriteJson(OFFLINE_QUEUE_STORAGE_KEY, remaining);
}

const OFFLINE_TILE_CACHE_NAME = 'wayhome-offline-tiles-v1';

export function latLngToTileXY(
  lat: number,
  lng: number,
  zoom: number
): { x: number; y: number } {
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (clampedLat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

export function getOfflineTileUrl(z: number, x: number, y: number): string {
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

export async function loadOrFetchOfflineTile(
  z: number,
  x: number,
  y: number
): Promise<Blob | null> {
  if (typeof window === 'undefined') return null;
  const url = getOfflineTileUrl(z, x, y);

  try {
    if ('caches' in window) {
      const cache = await caches.open(OFFLINE_TILE_CACHE_NAME);
      const cached = await cache.match(url);
      if (cached && cached.ok) {
        return await cached.blob();
      }
    }

    if (!navigator.onLine) return null;

    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) return null;

    if ('caches' in window) {
      const cache = await caches.open(OFFLINE_TILE_CACHE_NAME);
      await cache.put(url, response.clone());
    }
    return await response.blob();
  } catch {
    return null;
  }
}

export async function countCachedOfflineTiles(): Promise<number> {
  if (typeof window === 'undefined' || !('caches' in window)) return 0;
  try {
    const cache = await caches.open(OFFLINE_TILE_CACHE_NAME);
    const keys = await cache.keys();
    return keys.length;
  } catch {
    return 0;
  }
}

export async function prefetchOfflineCorridorTiles(
  points: LatLngPoint[],
  zooms: number[] = [14, 15, 16]
): Promise<number> {
  if (typeof window === 'undefined' || !navigator.onLine || points.length === 0) {
    return 0;
  }

  const keys = new Set<string>();
  const coordsToFetch: Array<{ z: number; x: number; y: number }> = [];

  // Sample up to 6 anchor points along the corridor
  const sampled: LatLngPoint[] = [];
  if (points.length <= 6) {
    sampled.push(...points);
  } else {
    for (let i = 0; i < 6; i++) {
      const idx = Math.floor((i / 5) * (points.length - 1));
      sampled.push(points[idx]);
    }
  }

  for (const z of zooms) {
    const n = Math.pow(2, z);
    const radius = z >= 16 ? 1 : 1;
    for (const pt of sampled) {
      if (!Number.isFinite(pt.lat) || !Number.isFinite(pt.lng)) continue;
      const center = latLngToTileXY(pt.lat, pt.lng, z);
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          const tx = center.x + dx;
          const ty = center.y + dy;
          if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
          const k = `${z}/${tx}/${ty}`;
          if (!keys.has(k)) {
            keys.add(k);
            coordsToFetch.push({ z, x: tx, y: ty });
          }
        }
      }
    }
  }

  const bounded = coordsToFetch.slice(0, 48);
  let loaded = 0;
  const batchSize = 6;
  for (let i = 0; i < bounded.length; i += batchSize) {
    const chunk = bounded.slice(i, i + batchSize);
    const results = await Promise.all(
      chunk.map((t) => loadOrFetchOfflineTile(t.z, t.x, t.y))
    );
    loaded += results.filter(Boolean).length;
  }
  return loaded;
}

