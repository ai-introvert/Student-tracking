import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Compass,
  HardDriveDownload,
  Home,
  Loader2,
  LocateFixed,
  Maximize2,
  Minus,
  Plus,
  School,
  WifiOff,
} from 'lucide-react';
import {
  BreadcrumbPoint,
  LatLngPoint,
  StudentProfile,
} from '../types/wayhome';
import {
  countCachedOfflineTiles,
  loadOrFetchOfflineTile,
  OfflineRoutePackage,
  prefetchOfflineCorridorTiles,
} from '../lib/offlineMapCache';
import {
  computeBearing,
  formatDistance,
  formatEta,
  getStatusMeta,
  haversineMeters,
} from '../lib/geo';
import { MapPinMode } from './CommuteMap';

interface OfflineCommuteMapProps {
  students: StudentProfile[];
  selectedStudentId: string | null;
  onSelectStudent?: (studentId: string) => void;
  breadcrumbsByStudent?: Record<string, BreadcrumbPoint[]>;
  offlineRoute: OfflineRoutePackage | null;
  pinMode?: MapPinMode;
  onMapPinDrop?: (coords: LatLngPoint) => void;
  defaultCenter?: LatLngPoint;
  isOnline: boolean;
  queuedBreadcrumbCount?: number;
  canSaveRoute?: boolean;
  onSaveOfflineRoute?: () => void;
}

const EARTH_CIRCUMFERENCE_M = 40075016.686;
const MAX_MEM_TILES = 160;

function latLngToWorldNorm(pt: LatLngPoint): { wx: number; wy: number } {
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, pt.lat));
  const latRad = (clampedLat * Math.PI) / 180;
  const wx = (pt.lng + 180) / 360;
  const wy =
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
  return { wx, wy };
}

function worldNormToLatLng(wx: number, wy: number): LatLngPoint {
  const wrappedX = ((wx % 1) + 1) % 1;
  const clampedY = Math.max(0.0001, Math.min(0.9999, wy));
  const lng = wrappedX * 360 - 180;
  const n = Math.PI * (1 - 2 * clampedY);
  const lat = (Math.atan(Math.sinh(n)) * 180) / Math.PI;
  return { lat, lng };
}

function getMetersPerPixel(lat: number, zoom: number): number {
  const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
  return (EARTH_CIRCUMFERENCE_M * cosLat) / (256 * Math.pow(2, zoom));
}

function getScaleBarMetrics(metersPerPixel: number): { label: string; widthPx: number } {
  const niceSteps = [25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000];
  const targetPx = 92;
  const targetMeters = metersPerPixel * targetPx;
  let chosen = niceSteps[0];
  for (const step of niceSteps) {
    if (step <= targetMeters * 1.35) {
      chosen = step;
    }
  }
  const widthPx = Math.max(36, Math.min(140, chosen / metersPerPixel));
  const label = chosen >= 1000 ? `${chosen / 1000} km` : `${chosen} m`;
  return { label, widthPx };
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export const OfflineCommuteMap: React.FC<OfflineCommuteMapProps> = ({
  students,
  selectedStudentId,
  onSelectStudent,
  breadcrumbsByStudent = {},
  offlineRoute,
  pinMode = 'none',
  onMapPinDrop,
  defaultCenter = { lat: 37.7749, lng: -122.4194 },
  isOnline,
  queuedBreadcrumbCount = 0,
  canSaveRoute = false,
  onSaveOfflineRoute,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  const selectedStudent = useMemo(
    () => students.find((s) => s.id === selectedStudentId) || students[0] || null,
    [students, selectedStudentId]
  );

  // Derive fallback points from live student or cached offline route package
  const schoolPoint = useMemo<LatLngPoint | null>(() => {
    if (selectedStudent) {
      return { lat: selectedStudent.schoolLat, lng: selectedStudent.schoolLng };
    }
    if (offlineRoute) {
      return { lat: offlineRoute.schoolLat, lng: offlineRoute.schoolLng };
    }
    return null;
  }, [selectedStudent, offlineRoute]);

  const homePoint = useMemo<LatLngPoint | null>(() => {
    if (selectedStudent?.hasHomePin) {
      return { lat: selectedStudent.homeLat, lng: selectedStudent.homeLng };
    }
    if (offlineRoute?.hasHomePin) {
      return { lat: offlineRoute.homeLat, lng: offlineRoute.homeLng };
    }
    return null;
  }, [selectedStudent, offlineRoute]);

  const studentPoint = useMemo<LatLngPoint | null>(() => {
    if (selectedStudent) {
      return { lat: selectedStudent.lastLat, lng: selectedStudent.lastLng };
    }
    return schoolPoint;
  }, [selectedStudent, schoolPoint]);

  const [viewCenter, setViewCenter] = useState<LatLngPoint>(() => {
    if (studentPoint) return studentPoint;
    if (schoolPoint) return schoolPoint;
    return defaultCenter;
  });
  const [zoom, setZoom] = useState<number>(15);
  const [tilePaintTick, setTilePaintTick] = useState(0);
  const [cachedTileCount, setCachedTileCount] = useState<number>(0);
  const [isCachingTiles, setIsCachingTiles] = useState(false);

  const tileMemCacheRef = useRef<
    Map<string, HTMLImageElement | 'loading' | 'unavailable'>
  >(new Map());
  const drawnTilesCountRef = useRef(0);

  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    startCenter: LatLngPoint;
    moved: boolean;
  } | null>(null);

  const studentHitTargetsRef = useRef<
    Array<{ studentId: string; x: number; y: number; r: number }>
  >([]);

  const fitRouteBounds = useCallback(() => {
    const points: LatLngPoint[] = [];
    if (schoolPoint) points.push(schoolPoint);
    if (homePoint) points.push(homePoint);
    if (studentPoint) points.push(studentPoint);
    if (offlineRoute?.path?.length) {
      offlineRoute.path.forEach((p) => points.push(p));
    }

    if (points.length === 0) {
      setViewCenter(defaultCenter);
      setZoom(14.5);
      return;
    }

    if (points.length === 1) {
      setViewCenter(points[0]);
      setZoom(15.5);
      return;
    }

    let minLat = points[0].lat;
    let maxLat = points[0].lat;
    let minLng = points[0].lng;
    let maxLng = points[0].lng;
    points.forEach((p) => {
      minLat = Math.min(minLat, p.lat);
      maxLat = Math.max(maxLat, p.lat);
      minLng = Math.min(minLng, p.lng);
      maxLng = Math.max(maxLng, p.lng);
    });

    const centerLat = (minLat + maxLat) / 2;
    const centerLng = (minLng + maxLng) / 2;
    setViewCenter({ lat: centerLat, lng: centerLng });

    const spanLatM = Math.max(180, (maxLat - minLat) * 111320);
    const spanLngM = Math.max(
      180,
      (maxLng - minLng) * 111320 * Math.max(0.15, Math.cos((centerLat * Math.PI) / 180))
    );
    const padW = Math.max(240, size.width * 0.68);
    const padH = Math.max(240, size.height * 0.65);
    const neededMpp = Math.max(spanLngM / padW, spanLatM / padH);
    const cosLat = Math.max(0.15, Math.cos((centerLat * Math.PI) / 180));
    const computedZoom = Math.log2((EARTH_CIRCUMFERENCE_M * cosLat) / (256 * neededMpp));
    setZoom(Math.max(10.5, Math.min(18, Number.isFinite(computedZoom) ? computedZoom : 14.5)));
  }, [schoolPoint, homePoint, studentPoint, offlineRoute, defaultCenter, size.width, size.height]);

  // Fit bounds when selected student, cached route, or geolocation defaultCenter changes
  const lastAutoFittedIdRef = useRef<string>('');
  useEffect(() => {
    const key = `${selectedStudent?.id || 'none'}_${offlineRoute?.savedAtMs || 0}_${
      selectedStudent ? '' : `${defaultCenter.lat.toFixed(4)}_${defaultCenter.lng.toFixed(4)}`
    }`;
    if (lastAutoFittedIdRef.current !== key) {
      lastAutoFittedIdRef.current = key;
      fitRouteBounds();
    }
  }, [selectedStudent, offlineRoute?.savedAtMs, defaultCenter.lat, defaultCenter.lng, fitRouteBounds]);

  // Refresh cached tile count on mount & after caching
  useEffect(() => {
    void countCachedOfflineTiles().then(setCachedTileCount);
  }, [tilePaintTick]);

  // Observe container resize + window resize so canvas never stays at stale dimensions
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize((prev) =>
          Math.abs(prev.width - rect.width) > 1 || Math.abs(prev.height - rect.height) > 1
            ? { width: rect.width, height: rect.height }
            : prev
        );
      }
    };
    updateSize();
    const raf = window.requestAnimationFrame(updateSize);
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    window.addEventListener('resize', updateSize);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  const latLngToPixel = useCallback(
    (pt: LatLngPoint) => {
      const worldSize = 256 * Math.pow(2, zoom);
      const centerNorm = latLngToWorldNorm(viewCenter);
      const ptNorm = latLngToWorldNorm(pt);
      return {
        x: size.width / 2 + (ptNorm.wx - centerNorm.wx) * worldSize,
        y: size.height / 2 + (ptNorm.wy - centerNorm.wy) * worldSize,
      };
    },
    [viewCenter, zoom, size.width, size.height]
  );

  const pixelToLatLng = useCallback(
    (px: number, py: number): LatLngPoint => {
      const worldSize = 256 * Math.pow(2, zoom);
      const centerNorm = latLngToWorldNorm(viewCenter);
      const wx = centerNorm.wx + (px - size.width / 2) / worldSize;
      const wy = centerNorm.wy + (py - size.height / 2) / worldSize;
      return worldNormToLatLng(wx, wy);
    },
    [viewCenter, zoom, size.width, size.height]
  );

  const handleSaveOfflineAndTiles = useCallback(async () => {
    onSaveOfflineRoute?.();
    if (!isOnline) return;
    const points: LatLngPoint[] = [];
    if (offlineRoute?.path?.length) {
      points.push(...offlineRoute.path);
    } else {
      if (schoolPoint) points.push(schoolPoint);
      if (homePoint) points.push(homePoint);
      if (studentPoint) points.push(studentPoint);
      if (points.length === 0) points.push(viewCenter);
    }
    setIsCachingTiles(true);
    try {
      await prefetchOfflineCorridorTiles(points, [14, 15, 16]);
      const total = await countCachedOfflineTiles();
      setCachedTileCount(total);
      setTilePaintTick((t) => t + 1);
    } finally {
      setIsCachingTiles(false);
    }
  }, [onSaveOfflineRoute, isOnline, offlineRoute, schoolPoint, homePoint, studentPoint, viewCenter]);

  // Draw the interactive Offline Commute Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Clean cartographic surface
    ctx.fillStyle = '#EEF2F6';
    ctx.fillRect(0, 0, size.width, size.height);

    const mpp = getMetersPerPixel(viewCenter.lat, zoom);

    // 2. Subtle fallback coordinate grid (visible immediately while tiles load or if uncached offline)
    const rawGridMeters = mpp * 110;
    const gridSteps = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
    let gridMeters = gridSteps[0];
    for (const s of gridSteps) {
      if (s <= rawGridMeters * 1.4) gridMeters = s;
    }

    const metersPerDegLng =
      111320 * Math.max(0.15, Math.cos((viewCenter.lat * Math.PI) / 180));
    const latStepDeg = gridMeters / 111320;
    const lngStepDeg = gridMeters / metersPerDegLng;

    const topLeft = pixelToLatLng(0, 0);
    const bottomRight = pixelToLatLng(size.width, size.height);

    const startLat = Math.floor(bottomRight.lat / latStepDeg) * latStepDeg;
    const startLng = Math.floor(topLeft.lng / lngStepDeg) * lngStepDeg;

    ctx.lineWidth = 1;
    ctx.font = '500 10px "JetBrains Mono", ui-monospace, monospace';

    for (let lng = startLng; lng <= bottomRight.lng + lngStepDeg; lng += lngStepDeg) {
      const { x } = latLngToPixel({ lat: viewCenter.lat, lng });
      if (x < -10 || x > size.width + 10) continue;
      ctx.strokeStyle = '#DCE3EC';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size.height);
      ctx.stroke();

      ctx.fillStyle = '#94A3B8';
      ctx.textAlign = 'center';
      ctx.fillText(lng.toFixed(3), x, 14);
    }

    for (let lat = startLat; lat <= topLeft.lat + latStepDeg; lat += latStepDeg) {
      const { y } = latLngToPixel({ lat, lng: viewCenter.lng });
      if (y < -10 || y > size.height + 10) continue;
      ctx.strokeStyle = '#DCE3EC';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size.width, y);
      ctx.stroke();

      ctx.fillStyle = '#94A3B8';
      ctx.textAlign = 'left';
      ctx.fillText(lat.toFixed(3), 8, y - 4);
    }

    // 2b. Cached / Live Slippy Street Map Raster Tiles
    const tileZ = Math.max(10, Math.min(18, Math.round(zoom)));
    const tileCountAxis = Math.pow(2, tileZ);
    const worldSize = 256 * Math.pow(2, zoom);
    const tileDrawSize = 256 * Math.pow(2, zoom - tileZ);
    const centerNorm = latLngToWorldNorm(viewCenter);

    const minWorldX = centerNorm.wx - size.width / 2 / worldSize;
    const maxWorldX = centerNorm.wx + size.width / 2 / worldSize;
    const minWorldY = centerNorm.wy - size.height / 2 / worldSize;
    const maxWorldY = centerNorm.wy + size.height / 2 / worldSize;

    const minTileX = Math.max(0, Math.floor(minWorldX * tileCountAxis));
    const maxTileX = Math.min(tileCountAxis - 1, Math.floor(maxWorldX * tileCountAxis));
    const minTileY = Math.max(0, Math.floor(minWorldY * tileCountAxis));
    const maxTileY = Math.min(tileCountAxis - 1, Math.floor(maxWorldY * tileCountAxis));

    let tilesDrawn = 0;
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      for (let ty = minTileY; ty <= maxTileY; ty++) {
        const key = `${tileZ}/${tx}/${ty}`;
        const entry = tileMemCacheRef.current.get(key);
        const drawX = size.width / 2 + (tx / tileCountAxis - centerNorm.wx) * worldSize;
        const drawY = size.height / 2 + (ty / tileCountAxis - centerNorm.wy) * worldSize;

        if (entry && entry !== 'loading' && entry !== 'unavailable') {
          ctx.drawImage(entry, drawX, drawY, tileDrawSize + 0.6, tileDrawSize + 0.6);
          tilesDrawn += 1;
        } else if (!entry || (entry === 'unavailable' && isOnline)) {
          // Bound in-memory tile dictionary
          if (tileMemCacheRef.current.size > MAX_MEM_TILES) {
            const firstKey = tileMemCacheRef.current.keys().next().value;
            if (firstKey) tileMemCacheRef.current.delete(firstKey);
          }
          tileMemCacheRef.current.set(key, 'loading');
          void loadOrFetchOfflineTile(tileZ, tx, ty).then((blob) => {
            if (!blob) {
              tileMemCacheRef.current.set(key, 'unavailable');
              return;
            }
            const objUrl = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
              URL.revokeObjectURL(objUrl);
              tileMemCacheRef.current.set(key, img);
              setTilePaintTick((t) => t + 1);
            };
            img.onerror = () => {
              URL.revokeObjectURL(objUrl);
              tileMemCacheRef.current.set(key, 'unavailable');
            };
            img.src = objUrl;
          });
        }
      }
    }
    drawnTilesCountRef.current = tilesDrawn;

    // 3. Home Pin 100m & 250m Safety Geofence Rings
    if (homePoint) {
      const hp = latLngToPixel(homePoint);
      const r100Px = 100 / mpp;
      const r250Px = 250 / mpp;

      // 250m approach ring
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.38)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, r250Px, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // 100m Safe Arrival Geofence fill + stroke
      ctx.fillStyle = 'rgba(16, 185, 129, 0.14)';
      ctx.strokeStyle = 'rgba(22, 163, 74, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, r100Px, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      if (r100Px > 28) {
        ctx.fillStyle = '#15803D';
        ctx.font = '600 10px "DM Sans", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('100m Safe Zone', hp.x, hp.y + r100Px + 13);
      }
    }

    // 4. Cached Planned Route Polyline (from School to Home)
    const routePts: LatLngPoint[] =
      offlineRoute?.path && offlineRoute.path.length >= 2
        ? offlineRoute.path
        : schoolPoint && homePoint
        ? [schoolPoint, homePoint]
        : [];

    if (routePts.length >= 2) {
      const isDirectFallback = !(offlineRoute?.path && offlineRoute.path.length >= 2);

      // Outer white casing
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (isDirectFallback) ctx.setLineDash([8, 6]);
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 8;
      ctx.beginPath();
      routePts.forEach((pt, idx) => {
        const p = latLngToPixel(pt);
        if (idx === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();

      // Inner blue route stroke
      ctx.strokeStyle = isDirectFallback ? '#3B82F6' : '#1D4ED8';
      ctx.lineWidth = 4.5;
      ctx.stroke();
      ctx.restore();

      // Draw subtle directional chevrons along the route
      const step = Math.max(1, Math.floor(routePts.length / 6));
      for (let i = step; i < routePts.length - 1; i += step) {
        const a = latLngToPixel(routePts[i - 1]);
        const b = latLngToPixel(routePts[i]);
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        if (segLen < 16) continue;
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(angle);
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-4, -3.5);
        ctx.lineTo(3, 0);
        ctx.lineTo(-4, 3.5);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 5. Live & Queued Breadcrumb Trail
    const selectedBreadcrumbs = selectedStudent
      ? breadcrumbsByStudent[selectedStudent.id] || []
      : [];

    if (selectedBreadcrumbs.length >= 2) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle =
        selectedStudent?.currentStatus === 'sos_alert' ? '#DC2626' : '#16A34A';
      ctx.lineWidth = 4;
      ctx.beginPath();
      selectedBreadcrumbs.forEach((pt, idx) => {
        const p = latLngToPixel(pt);
        if (idx === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();

      selectedBreadcrumbs.forEach((pt) => {
        const p = latLngToPixel(pt);
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle =
          selectedStudent?.currentStatus === 'sos_alert' ? '#DC2626' : '#16A34A';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
    }

    // 6. School Origin Marker
    if (schoolPoint) {
      const sp = latLngToPixel(schoolPoint);
      const label = selectedStudent?.schoolName || offlineRoute?.schoolName || 'School Campus';
      ctx.font = '600 11px "DM Sans", system-ui, sans-serif';
      const textWidth = Math.min(160, ctx.measureText(label).width);
      const boxW = textWidth + 22;
      const boxH = 26;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      drawRoundedRect(ctx, sp.x - boxW / 2, sp.y - boxH - 6, boxW, boxH, 7);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.fillText(label.slice(0, 24), sp.x, sp.y - 15);

      ctx.fillStyle = '#0F172A';
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // 7. Home Pin Marker
    if (homePoint) {
      const hp = latLngToPixel(homePoint);
      const boxW = 82;
      const boxH = 26;

      ctx.fillStyle = '#15803D';
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      drawRoundedRect(ctx, hp.x - boxW / 2, hp.y - boxH - 8, boxW, boxH, 7);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 11px "DM Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Home Pin', hp.x, hp.y - 17);

      ctx.fillStyle = '#15803D';
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // 8. Student Live Position Markers
    const nextHitTargets: Array<{ studentId: string; x: number; y: number; r: number }> = [];
    students.forEach((stu) => {
      const p = latLngToPixel({ lat: stu.lastLat, lng: stu.lastLng });
      const isSelected = stu.id === selectedStudent?.id;
      const isSos = stu.currentStatus === 'sos_alert';
      const isArrived = stu.currentStatus === 'arrived_home';
      const isEnRoute = stu.currentStatus === 'en_route';

      const fill = isSos
        ? '#DC2626'
        : isArrived
        ? '#059669'
        : isEnRoute
        ? '#1D4ED8'
        : '#1E293B';

      if (isSelected) {
        ctx.fillStyle = isSos ? 'rgba(220, 38, 38, 0.16)' : 'rgba(29, 78, 216, 0.16)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 20, 0, Math.PI * 2);
        ctx.fill();
      }

      // Direction arrow / position puck
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((stu.lastHeading * Math.PI) / 180);
      ctx.fillStyle = fill;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, isSelected ? 11 : 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // North-up heading pointer inside puck
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(4, 4);
      ctx.lineTo(0, 2);
      ctx.lineTo(-4, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Student name pill tag
      const firstName = stu.studentName.split(' ')[0] || 'Student';
      ctx.font = '700 11px "DM Sans", system-ui, sans-serif';
      const tw = ctx.measureText(firstName).width + 16;
      ctx.fillStyle = fill;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      drawRoundedRect(ctx, p.x - tw / 2, p.y - 38, tw, 22, 6);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.fillText(firstName, p.x, p.y - 23);

      nextHitTargets.push({ studentId: stu.id, x: p.x, y: p.y, r: 24 });
    });

    studentHitTargetsRef.current = nextHitTargets;
  }, [
    size,
    viewCenter,
    zoom,
    students,
    selectedStudent,
    breadcrumbsByStudent,
    offlineRoute,
    schoolPoint,
    homePoint,
    latLngToPixel,
    pixelToLatLng,
    tilePaintTick,
    isOnline,
  ]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      startCenter: viewCenter,
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || !drag.active) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.hypot(dx, dy) > 4) {
      drag.moved = true;
    }

    const mpp = getMetersPerPixel(drag.startCenter.lat, zoom);
    const metersPerDegLng =
      111320 * Math.max(0.15, Math.cos((drag.startCenter.lat * Math.PI) / 180));

    setViewCenter({
      lat: Math.max(-85, Math.min(85, drag.startCenter.lat + (dy * mpp) / 111320)),
      lng: Math.max(-180, Math.min(180, drag.startCenter.lng - (dx * mpp) / metersPerDegLng)),
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.moved) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    if (pinMode !== 'none' && onMapPinDrop) {
      onMapPinDrop(pixelToLatLng(clickX, clickY));
      return;
    }

    const hit = studentHitTargetsRef.current.find(
      (t) => Math.hypot(t.x - clickX, t.y - clickY) <= t.r
    );
    if (hit && onSelectStudent) {
      onSelectStudent(hit.studentId);
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.55 : -0.55;
    setZoom((z) => Math.max(10, Math.min(19, z + delta)));
  };

  const mpp = getMetersPerPixel(viewCenter.lat, zoom);
  const scaleBar = getScaleBarMetrics(mpp);

  const liveDistanceMeters = useMemo(() => {
    if (selectedStudent && homePoint) {
      return haversineMeters(
        { lat: selectedStudent.lastLat, lng: selectedStudent.lastLng },
        homePoint
      );
    }
    return offlineRoute?.distanceMeters ?? 0;
  }, [selectedStudent, homePoint, offlineRoute]);

  const bearingToHome = useMemo(() => {
    if (studentPoint && homePoint) {
      return computeBearing(studentPoint, homePoint);
    }
    return 0;
  }, [studentPoint, homePoint]);

  const statusMeta = selectedStudent ? getStatusMeta(selectedStudent.currentStatus) : null;

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full min-h-[420px] bg-slate-100 overflow-hidden select-none ${
        pinMode !== 'none' ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
      }`}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        className="absolute inset-0 w-full h-full block touch-none"
      />

      {/* Offline Mode / Pin Drop Top Prompt */}
      {pinMode !== 'none' ? (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-20 px-4 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg shadow-lg pointer-events-none whitespace-nowrap">
          {pinMode === 'home'
            ? 'Tap anywhere on the Offline Map to pin your Home location'
            : 'Tap anywhere on the Offline Map to pin your School Campus'}
        </div>
      ) : null}

      {/* Right-side Map Zoom & Fit Controls (above Offline Cache Card) */}
      <div className="absolute bottom-60 lg:bottom-48 right-4 z-20 flex flex-col gap-1.5">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(19, z + 0.8))}
          aria-label="Zoom in offline map"
          className="w-10 h-10 rounded-lg bg-white/95 border border-slate-200 shadow-sm hover:bg-slate-50 text-slate-800 flex items-center justify-center cursor-pointer"
        >
          <Plus className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(10, z - 0.8))}
          aria-label="Zoom out offline map"
          className="w-10 h-10 rounded-lg bg-white/95 border border-slate-200 shadow-sm hover:bg-slate-50 text-slate-800 flex items-center justify-center cursor-pointer"
        >
          <Minus className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={fitRouteBounds}
          title="Fit School-to-Home route"
          aria-label="Fit School-to-Home route"
          className="w-10 h-10 rounded-lg bg-white/95 border border-slate-200 shadow-sm hover:bg-slate-50 text-slate-800 flex items-center justify-center cursor-pointer"
        >
          <Maximize2 className="w-4 h-4" />
        </button>
        {studentPoint && (
          <button
            type="button"
            onClick={() => {
              setViewCenter(studentPoint);
              setZoom(16);
            }}
            title="Center on student GPS position"
            aria-label="Center on student GPS position"
            className="w-10 h-10 rounded-lg bg-white/95 border border-slate-200 shadow-sm hover:bg-slate-50 text-blue-700 flex items-center justify-center cursor-pointer"
          >
            <LocateFixed className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Bottom-left Scale Bar, Compass & Legend */}
      <div className="absolute bottom-16 lg:bottom-4 left-4 z-10 space-y-2">
        <div className="inline-flex items-center gap-3 px-3 py-1.5 bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm text-[11px] font-mono text-slate-700">
          <div className="flex items-center gap-1.5">
            <Compass className="w-3.5 h-3.5 text-slate-600" />
            <span>N</span>
          </div>
          <div className="flex flex-col items-center">
            <span className="leading-none mb-1">{scaleBar.label}</span>
            <div
              className="h-1.5 border-x-2 border-b-2 border-slate-700"
              style={{ width: `${Math.round(scaleBar.widthPx)}px` }}
            />
          </div>
          {homePoint && (
            <span className="text-slate-500">
              Brg {bearingToHome}°
            </span>
          )}
        </div>

        <div className="hidden sm:flex items-center gap-4 px-3.5 py-2 bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm text-xs text-slate-700">
          <span className="flex items-center gap-1.5">
            <School className="w-3.5 h-3.5 text-slate-900" />
            School
          </span>
          <span className="flex items-center gap-1.5">
            <Home className="w-3.5 h-3.5 text-emerald-700" />
            Home Pin (100m zone)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-0.5 bg-blue-700 inline-block" />
            Cached Route
          </span>
          <span className="text-[10px] text-slate-400 border-l border-slate-200 pl-3">
            © OpenStreetMap
          </span>
        </div>
      </div>

      {/* Bottom-right Offline Route Cache & Telemetry Card */}
      <div className="absolute bottom-16 lg:bottom-4 right-4 z-10 w-[calc(100%-2rem)] sm:w-80 bg-white/95 backdrop-blur-sm border border-slate-200 rounded-xl shadow-md p-3.5 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
            {isOnline ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-amber-700 shrink-0" />
            )}
            <span>{isOnline ? 'Offline Route Map Ready' : 'Offline GPS Map Active'}</span>
          </div>
          {statusMeta && (
            <span className={`text-[11px] font-semibold ${statusMeta.textClass}`}>
              {statusMeta.label}
            </span>
          )}
        </div>

        {selectedStudent && (
          <div className="grid grid-cols-3 gap-2 pt-1.5 border-t border-slate-100 text-xs">
            <div>
              <p className="text-[10px] text-slate-500">To Home</p>
              <p className="font-mono font-semibold text-slate-900">
                {formatDistance(liveDistanceMeters)}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-slate-500">Est. Time</p>
              <p className="font-mono font-semibold text-slate-900">
                {formatEta(
                  selectedStudent.etaMinutes || offlineRoute?.durationMinutes || 0
                )}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-slate-500">Speed</p>
              <p className="font-mono font-semibold text-slate-900">
                {selectedStudent.lastSpeedKmh.toFixed(1)} km/h
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-slate-100 text-[11px] text-slate-600">
          {offlineRoute ? (
            <span className="truncate">
              {offlineRoute.path.length} route pts · {cachedTileCount} tiles · 30d limit
            </span>
          ) : (
            <span className="truncate">
              {cachedTileCount > 0
                ? `${cachedTileCount} map tiles cached offline`
                : 'Street tiles cache as you browse'}
            </span>
          )}
          {queuedBreadcrumbCount > 0 && (
            <span className="font-mono font-semibold text-amber-700 shrink-0">
              {queuedBreadcrumbCount} queued
            </span>
          )}
        </div>

        {isOnline && (canSaveRoute || onSaveOfflineRoute) && (
          <button
            type="button"
            disabled={isCachingTiles}
            onClick={() => void handleSaveOfflineAndTiles()}
            className="w-full min-h-[36px] px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
          >
            {isCachingTiles ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Downloading Map Tiles...</span>
              </>
            ) : (
              <>
                <HardDriveDownload className="w-3.5 h-3.5" />
                <span>
                  {offlineRoute ? 'Refresh Offline Route & Tiles' : 'Download Offline Map & Route'}
                </span>
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
};
