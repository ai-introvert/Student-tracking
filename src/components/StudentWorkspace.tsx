import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Compass,
  Copy,
  Check,
  Home,
  Loader2,
  MapPin,
  Navigation,
  Play,
  School,
  ShieldAlert,
  ShieldCheck,
  Square,
  UserCheck,
  UserX,
  Bell,
} from 'lucide-react';
import {
  CommuteFeed,
  CommuteSession,
  LatLngPoint,
  SchoolCampus,
  StudentProfile,
  TravelMode,
  UserProfile,
  WatcherLink,
} from '../types/wayhome';
import { PlaceSearchInput, SelectedPlaceResult } from './PlaceSearchInput';
import { MapPinMode, RouteMetrics } from './CommuteMap';
import { SafetyTimeline } from './SafetyTimeline';
import { OfflineRoutePackage } from '../lib/offlineMapCache';
import {
  appendStudentSafetyAction,
  createSchoolCampus,
  createStudentProfile,
  pushLiveCommuteTelemetry,
  removeWatcherLink,
  startCommuteSession,
  updateStudentPinConfig,
  updateWatcherLinkStatus,
} from '../lib/wayhomeService';
import {
  computeBearing,
  formatDistance,
  formatEta,
  getStatusMeta,
  haversineMeters,
} from '../lib/geo';

export type StudentSectionTab = 'commute' | 'pins' | 'guardians' | 'log';

interface StudentWorkspaceProps {
  userProfile: UserProfile;
  student: StudentProfile | null;
  activeCommute: CommuteSession | null;
  commuteFeed: CommuteFeed | null;
  schools: SchoolCampus[];
  watchers: WatcherLink[];
  activeTab: StudentSectionTab;
  onTabChange: (tab: StudentSectionTab) => void;
  pinMode: MapPinMode;
  onPinModeChange: (mode: MapPinMode) => void;
  lastDroppedPin: LatLngPoint | null;
  onClearDroppedPin: () => void;
  travelMode: TravelMode;
  onTravelModeChange: (mode: TravelMode) => void;
  routeMetrics: RouteMetrics | null;
  isOnline: boolean;
  offlineRoute: OfflineRoutePackage | null;
  mapViewMode: 'google' | 'offline';
  onToggleOfflineMap: () => void;
  onOfflineTelemetry?: (payload: {
    coords: LatLngPoint;
    heading: number;
    speedKmh: number;
    etaMinutes: number;
    distanceRemainingMeters: number;
    arrivedHome: boolean;
  }) => void;
}

const TRAVEL_MODES: Array<{ value: TravelMode; label: string }> = [
  { value: 'WALKING', label: 'Walk' },
  { value: 'DRIVING', label: 'Car' },
  { value: 'TRANSIT', label: 'Transit' },
  { value: 'BICYCLING', label: 'Bike' },
];

export const StudentWorkspace: React.FC<StudentWorkspaceProps> = ({
  userProfile,
  student,
  activeCommute,
  commuteFeed,
  schools,
  watchers,
  activeTab,
  onTabChange,
  pinMode,
  onPinModeChange,
  lastDroppedPin,
  onClearDroppedPin,
  travelMode,
  onTravelModeChange,
  routeMetrics,
  isOnline,
  offlineRoute,
  mapViewMode,
  onToggleOfflineMap,
  onOfflineTelemetry,
}) => {
  // Onboarding state when user has no StudentProfile yet
  const [setupName, setSetupName] = useState(userProfile.displayName);
  const [setupSection, setSetupSection] = useState(userProfile.sectionName || 'Grade 10 - Section A');
  const [setupSchool, setSetupSchool] = useState<{
    name: string;
    address: string;
    lat: number;
    lng: number;
  } | null>(null);
  const [isCreatingStudent, setIsCreatingStudent] = useState(false);

  // Pin & Commute UI state
  const [homeLabelDraft, setHomeLabelDraft] = useState(student?.homeAddress || '');
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [sosNote, setSosNote] = useState('');
  const [showSosInput, setShowSosInput] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [gpsActive, setGpsActive] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);

  const watchIdRef = useRef<number | null>(null);
  const simTimerRef = useRef<number | null>(null);
  const lastSentAtRef = useRef<number>(0);
  const prevCoordsRef = useRef<LatLngPoint | null>(null);

  useEffect(() => {
    if (student?.homeAddress) {
      setHomeLabelDraft(student.homeAddress);
    }
  }, [student?.homeAddress]);

  // Handle dropped pin from map click
  useEffect(() => {
    if (!lastDroppedPin) return;

    if (!student) {
      setSetupSchool({
        name: 'Pinned School Campus',
        address: `${lastDroppedPin.lat.toFixed(5)}, ${lastDroppedPin.lng.toFixed(5)}`,
        lat: lastDroppedPin.lat,
        lng: lastDroppedPin.lng,
      });
      onPinModeChange('none');
      onClearDroppedPin();
      return;
    }

    const applyDrop = async () => {
      try {
        if (pinMode === 'home') {
          const fallbackLabel =
            homeLabelDraft.trim() ||
            `Pinned Home (${lastDroppedPin.lat.toFixed(4)}, ${lastDroppedPin.lng.toFixed(4)})`;
          await updateStudentPinConfig(student, {
            homeLat: lastDroppedPin.lat,
            homeLng: lastDroppedPin.lng,
            homeAddress: fallbackLabel,
            hasHomePin: true,
          });
          setHomeLabelDraft(fallbackLabel);
          setFeedback('Home pin updated from map.');
        } else if (pinMode === 'school') {
          await updateStudentPinConfig(student, {
            schoolLat: lastDroppedPin.lat,
            schoolLng: lastDroppedPin.lng,
            schoolName: student.schoolName || 'Pinned School Campus',
          });
          setFeedback('School campus location updated from map.');
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to save pin.');
      } finally {
        onPinModeChange('none');
        onClearDroppedPin();
      }
    };

    void applyDrop();
  }, [lastDroppedPin, pinMode, student, homeLabelDraft, onPinModeChange, onClearDroppedPin]);

  // Keep student currentStatus synced if watcher acknowledged SOS
  useEffect(() => {
    if (
      student &&
      activeCommute &&
      activeCommute.id === student.activeCommuteId &&
      activeCommute.status === 'en_route' &&
      student.currentStatus === 'sos_alert'
    ) {
      void pushLiveCommuteTelemetry({
        student,
        commute: activeCommute,
        feed: commuteFeed,
        coords: { lat: student.lastLat, lng: student.lastLng },
        heading: student.lastHeading,
        speedKmh: student.lastSpeedKmh,
        etaMinutes: student.etaMinutes,
        distanceRemainingMeters: student.distanceRemainingMeters,
      });
    }
  }, [student, activeCommute, commuteFeed]);

  // Real device GPS watchPosition when en_route or sos_alert
  useEffect(() => {
    const isCommuteLive =
      !!student &&
      !!activeCommute &&
      activeCommute.id === student.activeCommuteId &&
      (activeCommute.status === 'en_route' || activeCommute.status === 'sos_alert');

    if (!isCommuteLive || !gpsActive || !('geolocation' in navigator)) {
      if (watchIdRef.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      return;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      async (pos) => {
        const now = Date.now();
        if (now - lastSentAtRef.current < 3000) return;

        const nextCoords = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        };
        const prev = prevCoordsRef.current || { lat: student.lastLat, lng: student.lastLng };
        const movedMeters = haversineMeters(prev, nextCoords);
        if (movedMeters < 8 && now - lastSentAtRef.current < 10000) return;

        lastSentAtRef.current = now;
        prevCoordsRef.current = nextCoords;

        const heading =
          pos.coords.heading !== null && Number.isFinite(pos.coords.heading)
            ? pos.coords.heading
            : computeBearing(prev, nextCoords);

        const speedKmh =
          pos.coords.speed !== null && Number.isFinite(pos.coords.speed)
            ? Math.max(0, pos.coords.speed * 3.6)
            : 4.5;

        const distToHome = haversineMeters(nextCoords, {
          lat: student.homeLat,
          lng: student.homeLng,
        });
        const etaMinutes = Math.max(
          1,
          Math.round((distToHome / 1000 / Math.max(speedKmh, 4.5)) * 60)
        );
        const insideHomeZone = distToHome <= 100 && activeCommute.status === 'en_route';

        if (!navigator.onLine) {
          onOfflineTelemetry?.({
            coords: nextCoords,
            heading,
            speedKmh,
            etaMinutes,
            distanceRemainingMeters: distToHome,
            arrivedHome: insideHomeZone,
          });
          if (insideHomeZone) {
            setGpsActive(false);
            void appendStudentSafetyAction({
              student: { ...student, lastLat: nextCoords.lat, lastLng: nextCoords.lng },
              commute: activeCommute,
              feed: commuteFeed,
              action: 'arrived_home',
            });
            setFeedback('Entered 100m Home zone offline. Marked Arrived Safely (queued for sync).');
          }
          return;
        }

        await pushLiveCommuteTelemetry({
          student,
          commute: activeCommute,
          feed: commuteFeed,
          coords: nextCoords,
          heading,
          speedKmh,
          etaMinutes,
          distanceRemainingMeters: distToHome,
        });

        // Auto-arrive inside 100m Home Geofence
        if (insideHomeZone) {
          setGpsActive(false);
          await appendStudentSafetyAction({
            student: { ...student, lastLat: nextCoords.lat, lastLng: nextCoords.lng },
            commute: activeCommute,
            feed: commuteFeed,
            action: 'arrived_home',
          });
          setFeedback('Entered 100m Home zone. Marked as Arrived Safely.');
        }
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setGpsActive(false);
          setErrorMsg('Browser location permission was denied. Enable GPS or use the route movement test.');
        }
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
    );

    return () => {
      if (watchIdRef.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [gpsActive, student, activeCommute, commuteFeed, onOfflineTelemetry]);

  // Optional Desktop Movement Simulator along computed Google Maps Route polyline
  useEffect(() => {
    if (!isSimulating) {
      if (simTimerRef.current !== null) {
        window.clearInterval(simTimerRef.current);
        simTimerRef.current = null;
      }
      return;
    }

    if (
      !student ||
      !activeCommute ||
      (activeCommute.status !== 'en_route' && activeCommute.status !== 'sos_alert')
    ) {
      setIsSimulating(false);
      return;
    }

    const waypoints: LatLngPoint[] =
      routeMetrics && routeMetrics.path.length >= 2
        ? routeMetrics.path
        : [
            { lat: activeCommute.originLat, lng: activeCommute.originLng },
            { lat: activeCommute.destinationLat, lng: activeCommute.destinationLng },
          ];

    // Subsample to ~16 smooth steps toward home
    const totalSteps = 16;
    let stepIndex = 1;

    simTimerRef.current = window.setInterval(async () => {
      if (stepIndex > totalSteps) {
        setIsSimulating(false);
        return;
      }

      const ratio = stepIndex / totalSteps;
      const idx = Math.min(
        waypoints.length - 1,
        Math.floor(ratio * (waypoints.length - 1))
      );
      const nextPt =
        stepIndex === totalSteps
          ? { lat: student.homeLat, lng: student.homeLng }
          : waypoints[idx];

      const prevPt = { lat: student.lastLat, lng: student.lastLng };
      const distToHome = haversineMeters(nextPt, {
        lat: student.homeLat,
        lng: student.homeLng,
      });
      const speedKmh = travelMode === 'DRIVING' ? 28 : travelMode === 'BICYCLING' ? 14 : 5.2;
      const etaMinutes = Math.max(
        0,
        Math.round((distToHome / 1000 / speedKmh) * 60)
      );

      const insideHomeZone = distToHome <= 100 && activeCommute.status === 'en_route';

      if (!navigator.onLine) {
        onOfflineTelemetry?.({
          coords: nextPt,
          heading: computeBearing(prevPt, nextPt),
          speedKmh,
          etaMinutes,
          distanceRemainingMeters: distToHome,
          arrivedHome: insideHomeZone,
        });
        if (insideHomeZone) {
          setIsSimulating(false);
          setGpsActive(false);
          void appendStudentSafetyAction({
            student: { ...student, lastLat: nextPt.lat, lastLng: nextPt.lng },
            commute: activeCommute,
            feed: commuteFeed,
            action: 'arrived_home',
          });
          setFeedback('Arrived inside 100m Home Pin zone offline (queued for sync).');
        }
        stepIndex += 1;
        return;
      }

      await pushLiveCommuteTelemetry({
        student,
        commute: activeCommute,
        feed: commuteFeed,
        coords: nextPt,
        heading: computeBearing(prevPt, nextPt),
        speedKmh,
        etaMinutes,
        distanceRemainingMeters: distToHome,
      });

      if (insideHomeZone) {
        setIsSimulating(false);
        setGpsActive(false);
        await appendStudentSafetyAction({
          student: { ...student, lastLat: nextPt.lat, lastLng: nextPt.lng },
          commute: activeCommute,
          feed: commuteFeed,
          action: 'arrived_home',
        });
        setFeedback('Arrived inside 100m Home Pin safety zone.');
      }

      stepIndex += 1;
    }, 2000);

    return () => {
      if (simTimerRef.current !== null) {
        window.clearInterval(simTimerRef.current);
        simTimerRef.current = null;
      }
    };
  }, [isSimulating, student, activeCommute, commuteFeed, routeMetrics, travelMode, onOfflineTelemetry]);

  const handleUseBrowserGpsForSetup = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setErrorMsg('Geolocation is not supported in this browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setSetupSchool({
          name: 'My Current School Location',
          address: `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
        setErrorMsg(null);
      },
      () => {
        setErrorMsg('Could not read GPS. Please search your school above or click on the map.');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }, []);

  const handleUseGpsForHomePin = useCallback(async () => {
    if (!student || !('geolocation' in navigator)) {
      setErrorMsg('Geolocation is not available.');
      return;
    }
    setIsBusy(true);
    setErrorMsg(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const label =
            homeLabelDraft.trim() ||
            `GPS Home Pin (${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)})`;
          await updateStudentPinConfig(student, {
            homeLat: pos.coords.latitude,
            homeLng: pos.coords.longitude,
            homeAddress: label,
            hasHomePin: true,
          });
          setHomeLabelDraft(label);
          setFeedback('Home pinned to your current GPS coordinates.');
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to save Home pin.');
        } finally {
          setIsBusy(false);
        }
      },
      () => {
        setIsBusy(false);
        setErrorMsg('Unable to get GPS fix. Search your home address or click on the map.');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }, [student, homeLabelDraft]);

  const handleCreateStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!setupSchool) {
      setErrorMsg('Please select or pin your school campus on the map first.');
      return;
    }
    setIsCreatingStudent(true);
    setErrorMsg(null);
    try {
      await createSchoolCampus({
        name: setupSchool.name,
        address: setupSchool.address,
        lat: setupSchool.lat,
        lng: setupSchool.lng,
        createdBy: userProfile.uid,
      });
      await createStudentProfile({
        ownerUid: userProfile.uid,
        studentName: setupName.trim() || userProfile.displayName,
        gradeSection: setupSection.trim() || 'Student',
        schoolName: setupSchool.name,
        schoolLat: setupSchool.lat,
        schoolLng: setupSchool.lng,
      });
      onTabChange('pins');
      setFeedback('Student profile created. Now pin your Home location.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not create student profile.');
    } finally {
      setIsCreatingStudent(false);
    }
  };

  const handleStartCommute = async () => {
    if (!student || !student.hasHomePin) {
      setErrorMsg('Please pin your Home location before starting a commute.');
      onTabChange('pins');
      return;
    }
    if (!consentAccepted) {
      setErrorMsg('Please confirm location-sharing consent to start live tracking.');
      return;
    }

    setIsBusy(true);
    setErrorMsg(null);
    try {
      const dist =
        routeMetrics?.distanceMeters ||
        haversineMeters(
          { lat: student.schoolLat, lng: student.schoolLng },
          { lat: student.homeLat, lng: student.homeLng }
        );
      const eta = routeMetrics?.durationMinutes || Math.max(1, Math.round((dist / 1000 / 5) * 60));

      await startCommuteSession({
        student,
        travelMode,
        initialDistanceMeters: dist,
        initialEtaMinutes: eta,
        startLocation: { lat: student.schoolLat, lng: student.schoolLng },
      });
      setGpsActive(true);
      setFeedback('Live commute started. Parents & advisers can now see your movement.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to start commute.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleSafetyAction = async (
    action: 'checkpoint' | 'sos_triggered' | 'arrived_home' | 'cancelled'
  ) => {
    if (!student || !activeCommute) return;
    setIsBusy(true);
    setErrorMsg(null);
    try {
      await appendStudentSafetyAction({
        student,
        commute: activeCommute,
        feed: commuteFeed,
        action,
        note: action === 'sos_triggered' ? sosNote : undefined,
      });
      if (action === 'arrived_home' || action === 'cancelled') {
        setGpsActive(false);
        setIsSimulating(false);
      }
      if (action === 'sos_triggered') {
        setShowSosInput(false);
        setSosNote('');
      }
      setFeedback(
        action === 'checkpoint'
          ? 'Safe check-in logged.'
          : action === 'sos_triggered'
          ? 'SOS alert broadcast to all linked guardians & advisers.'
          : action === 'arrived_home'
          ? 'Marked Arrived Safely at Home.'
          : 'Commute tracking stopped.'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleCopyShareCode = async () => {
    if (!student) return;
    await navigator.clipboard.writeText(student.shareCode);
    setCopiedCode(true);
    window.setTimeout(() => setCopiedCode(false), 2000);
  };

  // --- Initial Student Setup Form ---
  if (!student) {
    return (
      <div className="p-5 space-y-5">
        <div>
          <p className="text-xs font-semibold text-blue-700">Student Setup</p>
          <h2 className="mt-1 text-lg font-bold text-slate-900">
            Set your School Campus origin
          </h2>
          <p className="mt-1 text-xs text-slate-600 leading-relaxed">
            Register your school campus starting point first, then pin your home on the map.
          </p>
        </div>

        <form onSubmit={(e) => void handleCreateStudent(e)} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Student Name
            </label>
            <input
              type="text"
              value={setupName}
              onChange={(e) => setSetupName(e.target.value)}
              maxLength={80}
              required
              className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Grade &amp; Section
            </label>
            <input
              type="text"
              value={setupSection}
              onChange={(e) => setSetupSection(e.target.value)}
              maxLength={60}
              required
              className="w-full min-h-[44px] px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
            />
          </div>

          <PlaceSearchInput
            label="Search School Campus"
            placeholder="Search your school name or address..."
            onSelect={(place: SelectedPlaceResult) => {
              setSetupSchool({
                name: place.name,
                address: place.address,
                lat: place.location.lat,
                lng: place.location.lng,
              });
            }}
          />

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onPinModeChange(pinMode === 'school' ? 'none' : 'school')}
              className={`min-h-[44px] px-3 py-2 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                pinMode === 'school'
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              <MapPin className="w-3.5 h-3.5" />
              <span>{pinMode === 'school' ? 'Click Map...' : 'Pin on Map'}</span>
            </button>

            <button
              type="button"
              onClick={handleUseBrowserGpsForSetup}
              className="min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <Compass className="w-3.5 h-3.5" />
              <span>Use Current GPS</span>
            </button>
          </div>

          {schools.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-1.5">
                Or pick a registered campus
              </p>
              <div className="space-y-1.5 max-h-32 overflow-y-auto">
                {schools.slice(0, 5).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() =>
                      setSetupSchool({
                        name: s.name,
                        address: s.address,
                        lat: s.lat,
                        lng: s.lng,
                      })
                    }
                    className={`w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors cursor-pointer ${
                      setupSchool?.name === s.name
                        ? 'border-blue-700 bg-blue-50 text-blue-900'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                    }`}
                  >
                    <p className="font-semibold truncate">{s.name}</p>
                    <p className="text-[11px] text-slate-500 truncate">{s.address}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {setupSchool && (
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs">
              <p className="font-semibold text-slate-900">{setupSchool.name}</p>
              <p className="text-slate-600 mt-0.5 truncate">{setupSchool.address}</p>
              <p className="font-mono text-[11px] text-slate-500 mt-1">
                {setupSchool.lat.toFixed(5)}, {setupSchool.lng.toFixed(5)}
              </p>
            </div>
          )}

          {errorMsg && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {errorMsg}
            </p>
          )}

          <button
            type="submit"
            disabled={isCreatingStudent}
            className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            {isCreatingStudent ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Saving Student Profile...</span>
              </>
            ) : (
              <span>Save School &amp; Continue</span>
            )}
          </button>
        </form>
      </div>
    );
  }

  const effectiveStatus = activeCommute?.status ?? student.currentStatus;
  const statusMeta = getStatusMeta(effectiveStatus);
  const isCommuteLive =
    !!activeCommute &&
    activeCommute.id === student.activeCommuteId &&
    (activeCommute.status === 'en_route' || activeCommute.status === 'sos_alert');

  const latestPing = [...(commuteFeed?.events || [])]
    .reverse()
    .find((evt) => evt.type === 'safety_ping' && Date.now() - evt.tsMs < 10 * 60 * 1000);

  return (
    <div className="flex flex-col h-full">
      {/* Student Identity & Status Summary */}
      <div className="p-5 border-b border-slate-200 bg-white">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-slate-900 truncate">
              {student.studentName}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 truncate">
              {student.gradeSection} · {student.schoolName}
            </p>
          </div>
          <span className={`text-xs font-semibold whitespace-nowrap ${statusMeta.textClass}`}>
            {statusMeta.label}
          </span>
        </div>

        {/* Share Code Strip */}
        <div className="mt-4 px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium text-slate-500">
              Parent &amp; Adviser Share Code
            </p>
            <p className="font-mono text-sm font-semibold text-slate-900 tracking-wider mt-0.5">
              {student.shareCode}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleCopyShareCode()}
            className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-700 inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            {copiedCode ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy Code</span>
              </>
            )}
          </button>
        </div>

        {/* Section Tabs */}
        <div className="mt-4 grid grid-cols-4 gap-1 p-1 bg-slate-100 rounded-lg">
          {(
            [
              { id: 'commute', label: 'Commute' },
              { id: 'pins', label: 'Home Pin' },
              { id: 'guardians', label: `Watchers (${watchers.filter((w) => w.status === 'active').length})` },
              { id: 'log', label: 'Log' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={`min-h-[36px] px-2 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap truncate ${
                activeTab === tab.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Feedback & Errors */}
      {(feedback || errorMsg) && (
        <div className="px-5 pt-4">
          {errorMsg && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 flex items-start justify-between gap-2">
              <span>{errorMsg}</span>
              <button
                type="button"
                onClick={() => setErrorMsg(null)}
                className="text-red-600 font-semibold"
              >
                Dismiss
              </button>
            </div>
          )}
          {feedback && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-start justify-between gap-2">
              <span>{feedback}</span>
              <button
                type="button"
                onClick={() => setFeedback(null)}
                className="text-emerald-700 font-semibold"
              >
                OK
              </button>
            </div>
          )}
        </div>
      )}

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {activeTab === 'commute' && (
          <>
            {/* Safety Ping Banner from Parent / Adviser */}
            {isCommuteLive && latestPing && (
              <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 space-y-2.5">
                <div className="flex items-start gap-2.5">
                  <Bell className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <p className="text-xs font-medium text-amber-900">
                    {latestPing.message}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleSafetyAction('checkpoint')}
                  disabled={isBusy}
                  className="w-full min-h-[40px] px-3 py-2 rounded-lg bg-amber-700 hover:bg-amber-800 text-white text-xs font-semibold cursor-pointer"
                >
                  Respond: I Am Safe
                </button>
              </div>
            )}

            {/* Home Pin Prerequisite Notice */}
            {!student.hasHomePin && (
              <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 space-y-2.5">
                <p className="text-xs font-semibold text-amber-900">
                  Pin your Home location first
                </p>
                <p className="text-xs text-amber-800 leading-relaxed">
                  Your parents and adviser need your pinned Home destination to calculate your route and arrival zone.
                </p>
                <button
                  type="button"
                  onClick={() => onTabChange('pins')}
                  className="min-h-[40px] px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold cursor-pointer"
                >
                  Pin Home Location
                </button>
              </div>
            )}

            {/* Route Summary Card */}
            {student.hasHomePin && (
              <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-700">Planned Route</span>
                  <span className="text-slate-500 truncate max-w-[180px]">
                    {student.homeAddress || 'Pinned Home'}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-3 pt-1 border-t border-slate-200/80">
                  <div>
                    <p className="text-[11px] text-slate-500">Distance</p>
                    <p className="font-mono text-sm font-semibold text-slate-900 mt-0.5">
                      {formatDistance(
                        isCommuteLive
                          ? activeCommute.distanceRemainingMeters
                          : routeMetrics?.distanceMeters ?? 0
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Est. Time</p>
                    <p className="font-mono text-sm font-semibold text-slate-900 mt-0.5">
                      {formatEta(
                        isCommuteLive
                          ? activeCommute.etaMinutes
                          : routeMetrics?.durationMinutes ?? 0
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Speed</p>
                    <p className="font-mono text-sm font-semibold text-slate-900 mt-0.5">
                      {isCommuteLive ? `${activeCommute.speedKmh.toFixed(1)} km/h` : '0.0 km/h'}
                    </p>
                  </div>
                </div>
                <div className="pt-2 border-t border-slate-200/80 flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-slate-600 truncate">
                    {offlineRoute
                      ? `Offline map cached (${offlineRoute.path.length} pts)`
                      : isOnline
                      ? 'Computing offline route backup...'
                      : 'Using offline coordinates & GPS'}
                  </span>
                  <button
                    type="button"
                    onClick={onToggleOfflineMap}
                    className="font-semibold text-blue-700 hover:underline shrink-0 cursor-pointer"
                  >
                    {mapViewMode === 'offline' ? 'Live Google Map' : 'Open Offline Map'}
                  </button>
                </div>
              </div>
            )}

            {/* Pre-Commute Controls */}
            {!isCommuteLive && student.hasHomePin && (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Travel Mode
                  </label>
                  <div className="grid grid-cols-4 gap-1 p-1 bg-slate-100 rounded-lg">
                    {TRAVEL_MODES.map((m) => (
                      <button
                        key={m.value}
                        type="button"
                        onClick={() => onTravelModeChange(m.value)}
                        className={`min-h-[38px] text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                          travelMode === m.value
                            ? 'bg-white text-slate-900 shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex items-start gap-2.5 p-3 rounded-xl border border-slate-200 bg-white cursor-pointer">
                  <input
                    type="checkbox"
                    checked={consentAccepted}
                    onChange={(e) => setConsentAccepted(e.target.checked)}
                    className="mt-0.5 w-4 h-4 accent-blue-700 rounded"
                  />
                  <span className="text-xs text-slate-600 leading-relaxed">
                    I consent to share my real-time GPS location with my authorized parents and faculty advisers until I arrive home or tap Stop Sharing.
                  </span>
                </label>

                <button
                  type="button"
                  onClick={() => void handleStartCommute()}
                  disabled={isBusy}
                  className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  {isBusy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Navigation className="w-4 h-4" />
                  )}
                  <span>Leave School &amp; Share Live Location</span>
                </button>
              </div>
            )}

            {/* Active Live Commute Controls */}
            {isCommuteLive && (
              <div className="space-y-3">
                <div className="p-3.5 rounded-xl border border-blue-200 bg-blue-50/60 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-blue-700 animate-pulse" />
                    <div>
                      <p className="text-xs font-semibold text-slate-900">
                        {gpsActive ? 'Live GPS Sharing Active' : 'Commute Session Open'}
                      </p>
                      <p className="text-[11px] text-slate-600 font-mono">
                        {student.lastLat.toFixed(5)}, {student.lastLng.toFixed(5)}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setGpsActive((v) => !v)}
                    className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 cursor-pointer"
                  >
                    {gpsActive ? 'Pause GPS' : 'Resume GPS'}
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => void handleSafetyAction('checkpoint')}
                    disabled={isBusy}
                    className="min-h-[44px] px-3 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-900 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <ShieldCheck className="w-4 h-4 text-blue-700" />
                    <span>I&apos;m Safe Check-In</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleSafetyAction('arrived_home')}
                    disabled={isBusy}
                    className="min-h-[44px] px-3 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Arrived Home</span>
                  </button>
                </div>

                {/* SOS Emergency Action */}
                {activeCommute.status !== 'sos_alert' ? (
                  !showSosInput ? (
                    <button
                      type="button"
                      onClick={() => setShowSosInput(true)}
                      className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <ShieldAlert className="w-4 h-4" />
                      <span>Trigger SOS Emergency Alert</span>
                    </button>
                  ) : (
                    <div className="p-3.5 rounded-xl border border-red-200 bg-red-50 space-y-2.5">
                      <label className="block text-xs font-semibold text-red-900">
                        Optional emergency note for parents &amp; adviser
                      </label>
                      <input
                        type="text"
                        value={sosNote}
                        onChange={(e) => setSosNote(e.target.value)}
                        maxLength={200}
                        placeholder="e.g. Missed bus, waiting at corner store..."
                        className="w-full min-h-[40px] px-3 py-2 text-xs bg-white border border-red-300 rounded-lg text-slate-900"
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setShowSosInput(false)}
                          className="min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSafetyAction('sos_triggered')}
                          disabled={isBusy}
                          className="min-h-[40px] px-3 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold cursor-pointer"
                        >
                          Send SOS Now
                        </button>
                      </div>
                    </div>
                  )
                ) : (
                  <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-900 flex items-center gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                    <span>SOS Emergency Alert is active. Your watchers have been notified.</span>
                  </div>
                )}

                {/* Desktop Movement Simulator & Revoke Controls */}
                <div className="pt-2 border-t border-slate-200 space-y-2">
                  <button
                    type="button"
                    onClick={() => setIsSimulating((v) => !v)}
                    className={`w-full min-h-[40px] px-3 py-2 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer ${
                      isSimulating
                        ? 'border-amber-300 bg-amber-50 text-amber-900'
                        : 'border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700'
                    }`}
                  >
                    {isSimulating ? (
                      <>
                        <Square className="w-3.5 h-3.5" />
                        <span>Stop Route Movement Test</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5" />
                        <span>Desktop Test: Simulate Movement Along Route</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleSafetyAction('cancelled')}
                    disabled={isBusy}
                    className="w-full min-h-[38px] px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 cursor-pointer"
                  >
                    Stop Sharing &amp; End Trip
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === 'pins' && (
          <div className="space-y-5">
            {/* Home Pin Section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                  <Home className="w-4 h-4 text-emerald-700" />
                  <span>Home Pin Location</span>
                </h3>
                {student.hasHomePin && (
                  <span className="text-[11px] font-semibold text-emerald-700">
                    Pinned
                  </span>
                )}
              </div>

              <PlaceSearchInput
                label="Search Home Street or Neighborhood"
                placeholder="Type home address..."
                initialValue={student.homeAddress}
                onSelect={async (place) => {
                  setIsBusy(true);
                  try {
                    await updateStudentPinConfig(student, {
                      homeAddress: place.address || place.name,
                      homeLat: place.location.lat,
                      homeLng: place.location.lng,
                      hasHomePin: true,
                    });
                    setHomeLabelDraft(place.address || place.name);
                    setFeedback('Home location pinned and saved.');
                  } catch (err) {
                    setErrorMsg(err instanceof Error ? err.message : 'Failed to save Home pin.');
                  } finally {
                    setIsBusy(false);
                  }
                }}
              />

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onPinModeChange(pinMode === 'home' ? 'none' : 'home')}
                  className={`min-h-[44px] px-3 py-2 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer ${
                    pinMode === 'home'
                      ? 'bg-emerald-700 text-white border-emerald-700'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <MapPin className="w-3.5 h-3.5" />
                  <span>{pinMode === 'home' ? 'Click Map Now...' : 'Drop Pin on Map'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleUseGpsForHomePin()}
                  disabled={isBusy}
                  className="min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Compass className="w-3.5 h-3.5" />
                  <span>Pin Current GPS</span>
                </button>
              </div>

              {student.hasHomePin && (
                <div className="p-3 rounded-xl bg-emerald-50/60 border border-emerald-200 space-y-2">
                  <label className="block text-[11px] font-semibold text-emerald-900">
                    Home Address / Landmark Note
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={homeLabelDraft}
                      onChange={(e) => setHomeLabelDraft(e.target.value)}
                      maxLength={200}
                      className="flex-1 min-h-[38px] px-3 py-1.5 text-xs bg-white border border-emerald-200 rounded-lg text-slate-900"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        await updateStudentPinConfig(student, {
                          homeAddress: homeLabelDraft,
                        });
                        setFeedback('Home label saved.');
                      }}
                      className="min-h-[38px] px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-semibold cursor-pointer"
                    >
                      Save
                    </button>
                  </div>
                  <p className="font-mono text-[11px] text-emerald-800">
                    {student.homeLat.toFixed(5)}, {student.homeLng.toFixed(5)} · 100m safety arrival zone
                  </p>
                </div>
              )}
            </div>

            {/* School Campus Origin Section */}
            <div className="pt-4 border-t border-slate-200 space-y-3">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                <School className="w-4 h-4 text-slate-800" />
                <span>School Origin Campus</span>
              </h3>
              <p className="text-xs text-slate-600">
                Current: <span className="font-semibold text-slate-900">{student.schoolName}</span>
              </p>

              <PlaceSearchInput
                placeholder="Change school campus..."
                onSelect={async (place) => {
                  await updateStudentPinConfig(student, {
                    schoolName: place.name,
                    schoolLat: place.location.lat,
                    schoolLng: place.location.lng,
                  });
                  setFeedback(`School updated to ${place.name}.`);
                }}
              />

              <button
                type="button"
                onClick={() => onPinModeChange(pinMode === 'school' ? 'none' : 'school')}
                className={`w-full min-h-[40px] px-3 py-2 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer ${
                  pinMode === 'school'
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                }`}
              >
                <MapPin className="w-3.5 h-3.5" />
                <span>{pinMode === 'school' ? 'Click Map to Set School...' : 'Reposition School Pin on Map'}</span>
              </button>
            </div>
          </div>
        )}

        {activeTab === 'guardians' && (
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                Authorized Parents &amp; Faculty Advisers
              </h3>
              <p className="text-xs text-slate-600 mt-1">
                Share code <span className="font-mono font-semibold text-slate-900">{student.shareCode}</span> with your parent or faculty adviser so they can track your commute. You can revoke access anytime.
              </p>
            </div>

            {watchers.length === 0 ? (
              <div className="p-6 text-center border border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                <p className="text-xs text-slate-500">
                  No parents or faculty advisers linked yet.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-slate-200 border border-slate-200 rounded-xl bg-white">
                {watchers.map((w) => (
                  <li key={w.id} className="p-3.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900 truncate">
                        {w.watcherName}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5 capitalize">
                        {w.watcherRelation} · {w.status === 'active' ? 'Active Access' : 'Revoked'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          void updateWatcherLinkStatus(
                            w.id,
                            w.status === 'active' ? 'revoked' : 'active'
                          )
                        }
                        className="min-h-[36px] px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 inline-flex items-center gap-1 cursor-pointer"
                      >
                        {w.status === 'active' ? (
                          <>
                            <UserX className="w-3.5 h-3.5 text-amber-700" />
                            <span>Revoke</span>
                          </>
                        ) : (
                          <>
                            <UserCheck className="w-3.5 h-3.5 text-emerald-700" />
                            <span>Restore</span>
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeWatcherLink(w.id)}
                        className="min-h-[36px] px-2.5 py-1 rounded-lg text-xs font-medium text-red-700 hover:bg-red-50 cursor-pointer"
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {activeTab === 'log' && (
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-slate-900">
              Current Commute Safety Timeline
            </h3>
            <SafetyTimeline events={commuteFeed?.events || []} />
          </div>
        )}
      </div>
    </div>
  );
};
