import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { APIProvider } from '@vis.gl/react-google-maps';
import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import {
  CheckCircle2,
  Home,
  Loader2,
  Map as MapIcon,
  SlidersHorizontal,
  WifiOff,
  X,
} from 'lucide-react';
import { auth, googleProvider } from './lib/firebase';
import { formatTimeClock } from './lib/geo';
import {
  getUserProfile,
  pushLiveCommuteTelemetry,
  saveUserProfile,
  subscribeCommute,
  subscribeCommuteFeed,
  subscribeOwnStudentProfiles,
  subscribeSchools,
  subscribeStudentById,
  subscribeWatcherLinksForStudent,
  subscribeWatcherLinksForWatcher,
} from './lib/wayhomeService';
import {
  BreadcrumbPoint,
  CommuteFeed,
  CommuteSession,
  LatLngPoint,
  SchoolCampus,
  StudentProfile,
  TravelMode,
  UserProfile,
  ViewMode,
  WatcherLink,
} from './types/wayhome';
import { AuthLanding } from './components/AuthLanding';
import { ProfileSetupModal } from './components/ProfileSetupModal';
import { CommuteMap, MapPinMode, RouteMetrics } from './components/CommuteMap';
import { OfflineCommuteMap } from './components/OfflineCommuteMap';
import { DynamicEtaWidget } from './components/DynamicEtaWidget';
import { StudentSectionTab, StudentWorkspace } from './components/StudentWorkspace';
import { ArrivalAlert, WatcherWorkspace } from './components/WatcherWorkspace';
import { PWAInstallButton } from './components/PWAInstallButton';
import { useOnlineStatus } from './hooks/usePWAInstall';
import {
  clearQueuedOfflineBreadcrumbsForCommute,
  enqueueOfflineBreadcrumb,
  loadAllOfflineRoutes,
  loadQueuedOfflineBreadcrumbs,
  OfflineRoutePackage,
  QueuedOfflineBreadcrumb,
  saveOfflineRouteForStudent,
} from './lib/offlineMapCache';

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

export default function App() {
  const [quotaExceeded, setQuotaExceeded] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Workspace view mode ('student' vs 'parent'/'adviser')
  const [activeMode, setActiveMode] = useState<ViewMode>('student');
  const [studentTab, setStudentTab] = useState<StudentSectionTab>('commute');
  const [mobilePane, setMobilePane] = useState<'controls' | 'map'>('controls');

  // Shared Firestore state
  const [schools, setSchools] = useState<SchoolCampus[]>([]);
  const [ownStudents, setOwnStudents] = useState<StudentProfile[]>([]);
  const [studentWatchers, setStudentWatchers] = useState<WatcherLink[]>([]);
  const [watcherLinks, setWatcherLinks] = useState<WatcherLink[]>([]);
  const [trackedStudents, setTrackedStudents] = useState<Record<string, StudentProfile>>({});
  const [commutesById, setCommutesById] = useState<Record<string, CommuteSession>>({});
  const [feedsByCommuteId, setFeedsByCommuteId] = useState<Record<string, CommuteFeed>>({});

  // Map & Commute interaction state
  const [selectedTrackedStudentId, setSelectedTrackedStudentId] = useState<string | null>(null);
  const [pinMode, setPinMode] = useState<MapPinMode>('none');
  const [lastDroppedPin, setLastDroppedPin] = useState<LatLngPoint | null>(null);
  const [travelMode, setTravelMode] = useState<TravelMode>('WALKING');
  const [routeMetrics, setRouteMetrics] = useState<RouteMetrics | null>(null);
  const [showTrafficLayer, setShowTrafficLayer] = useState(false);
  const [routeRefreshNonce, setRouteRefreshNonce] = useState(0);
  const [browserCenter, setBrowserCenter] = useState<LatLngPoint>({ lat: 37.7749, lng: -122.4194 });

  // Offline Map & PWA connectivity state
  const isOnline = useOnlineStatus();
  const [preferOfflineMap, setPreferOfflineMap] = useState(false);
  const [offlineRoutesByStudent, setOfflineRoutesByStudent] = useState<
    Record<string, OfflineRoutePackage>
  >(() => loadAllOfflineRoutes());
  const [queuedBreadcrumbs, setQueuedBreadcrumbs] = useState<QueuedOfflineBreadcrumb[]>(() =>
    loadQueuedOfflineBreadcrumbs()
  );
  const [offlineLiveOverride, setOfflineLiveOverride] = useState<{
    studentId: string;
    lat: number;
    lng: number;
    heading: number;
    speedKmh: number;
    etaMinutes: number;
    distanceRemainingMeters: number;
  } | null>(null);

  // Arrival notifications state for Parents & Faculty Advisers
  const [arrivalAlerts, setArrivalAlerts] = useState<ArrivalAlert[]>([]);
  const [dismissedArrivalKeys, setDismissedArrivalKeys] = useState<Record<string, boolean>>({});
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >(() => (typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported'));
  const prevTrackedStatusRef = useRef<Record<string, string>>({});

  // Listen for Google Maps Quota Exceeded event (Case A Demo Key)
  useEffect(() => {
    const onQuota = () => setQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuota);
    return () => window.removeEventListener('gmp-quota-exceeded', onQuota);
  }, []);

  // Optional initial map viewport center from browser geolocation
  useEffect(() => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setBrowserCenter({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          });
        },
        () => {
          // Keep neutral default viewport if denied
        },
        { maximumAge: 60000, timeout: 4000 }
      );
    }
  }, []);

  // Firebase Auth listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (user) {
        setProfileLoading(true);
        try {
          const profile = await getUserProfile(user.uid);
          setUserProfile(profile);
          if (profile) {
            setActiveMode(profile.viewMode);
          }
        } catch (err) {
          console.error('Failed to fetch user profile', err);
        } finally {
          setProfileLoading(false);
        }
      } else {
        setUserProfile(null);
      }
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  // Real-time Firestore subscriptions once authenticated & verified
  useEffect(() => {
    if (!firebaseUser || !userProfile) return;

    const unsubSchools = subscribeSchools(setSchools);
    const unsubOwnStudents = subscribeOwnStudentProfiles(firebaseUser.uid, setOwnStudents);
    const unsubStudentWatchers = subscribeWatcherLinksForStudent(
      firebaseUser.uid,
      setStudentWatchers
    );
    const unsubWatcherLinks = subscribeWatcherLinksForWatcher(
      firebaseUser.uid,
      setWatcherLinks
    );

    return () => {
      unsubSchools();
      unsubOwnStudents();
      unsubStudentWatchers();
      unsubWatcherLinks();
    };
  }, [firebaseUser, userProfile]);

  const ownStudent = ownStudents[0] || null;

  // Subscribe to each active linked student's profile in real time (Parent/Adviser mode)
  useEffect(() => {
    if (!firebaseUser || !userProfile) return;
    const activeIds = watcherLinks
      .filter((l) => l.status === 'active')
      .map((l) => l.studentId);

    if (activeIds.length === 0) {
      setTrackedStudents({});
      return;
    }

    const unsubs = activeIds.map((studentId) =>
      subscribeStudentById(studentId, (stu) => {
        setTrackedStudents((prev) => {
          const next = { ...prev };
          if (stu) {
            next[studentId] = stu;
          } else {
            delete next[studentId];
          }
          return next;
        });
      })
    );

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [firebaseUser, userProfile, watcherLinks]);

  // Collect all active commute IDs we need real-time telemetry for
  const activeCommuteIds = useMemo(() => {
    const ids: string[] = [];
    if (ownStudent?.activeCommuteId) {
      ids.push(ownStudent.activeCommuteId);
    }
    Object.values(trackedStudents).forEach((s) => {
      if (s.activeCommuteId && !ids.includes(s.activeCommuteId)) {
        ids.push(s.activeCommuteId);
      }
    });
    return ids;
  }, [ownStudent?.activeCommuteId, trackedStudents]);

  // Subscribe to active commutes & their live feeds
  useEffect(() => {
    if (!firebaseUser || !userProfile || activeCommuteIds.length === 0) return;

    const unsubs: Array<() => void> = [];

    activeCommuteIds.forEach((commuteId) => {
      unsubs.push(
        subscribeCommute(commuteId, (commute) => {
          setCommutesById((prev) => {
            const next = { ...prev };
            if (commute) next[commuteId] = commute;
            else delete next[commuteId];
            return next;
          });
        })
      );

      unsubs.push(
        subscribeCommuteFeed(commuteId, (feed) => {
          setFeedsByCommuteId((prev) => {
            const next = { ...prev };
            if (feed) next[commuteId] = feed;
            else delete next[commuteId];
            return next;
          });
        })
      );
    });

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [firebaseUser, userProfile, activeCommuteIds]);

  const playArrivalChime = useCallback(() => {
    if (!soundEnabled || typeof window === 'undefined') return;
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;

      const playNote = (freq: number, startOffset: number, duration: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + startOffset);
        gain.gain.setValueAtTime(0.001, now + startOffset);
        gain.gain.exponentialRampToValueAtTime(0.12, now + startOffset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + startOffset);
        osc.stop(now + startOffset + duration);
      };

      playNote(587.33, 0, 0.22); // D5
      playNote(880.0, 0.14, 0.35); // A5
    } catch {
      // Audio playback may be blocked until user gesture
    }
  }, [soundEnabled]);

  const handleRequestNotifications = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setNotificationPermission('unsupported');
      return;
    }
    const result = await Notification.requestPermission();
    setNotificationPermission(result);
  }, []);

  const handleDismissArrivalAlert = useCallback((alertKey: string) => {
    setDismissedArrivalKeys((prev) => ({ ...prev, [alertKey]: true }));
    setArrivalAlerts((prev) => prev.filter((a) => a.key !== alertKey));
  }, []);

  // Detect real-time transitions when a linked student reaches their Home Pin
  useEffect(() => {
    const activeLinks = watcherLinks.filter((l) => l.status === 'active');
    if (activeLinks.length === 0) return;

    const nowMs = Date.now();
    const newAlerts: ArrivalAlert[] = [];
    let shouldNotifyLive = false;

    activeLinks.forEach((link) => {
      const student = trackedStudents[link.studentId];
      if (!student) return;

      const commute = student.activeCommuteId
        ? commutesById[student.activeCommuteId] || null
        : null;
      const effectiveStatus = commute?.status ?? student.currentStatus;
      const prevStatus = prevTrackedStatusRef.current[student.id];

      const alertKey = `${student.id}_${student.activeCommuteId || 'latest'}`;
      const arrivedAtMs = commute?.endedAtMs || nowMs;
      const isRecentArrival = nowMs - arrivedAtMs <= 10 * 60 * 1000;

      const transitionedToArrived =
        prevStatus !== undefined &&
        prevStatus !== 'arrived_home' &&
        effectiveStatus === 'arrived_home';

      if (transitionedToArrived) {
        shouldNotifyLive = true;
      }

      if (
        effectiveStatus === 'arrived_home' &&
        !dismissedArrivalKeys[alertKey] &&
        (transitionedToArrived || (prevStatus === undefined && isRecentArrival))
      ) {
        newAlerts.push({
          key: alertKey,
          studentId: student.id,
          studentName: student.studentName,
          gradeSection: student.gradeSection,
          homeAddress: student.homeAddress,
          arrivedAtMs,
        });

        if (
          transitionedToArrived &&
          typeof window !== 'undefined' &&
          'Notification' in window &&
          Notification.permission === 'granted'
        ) {
          try {
            new Notification(`${student.studentName} arrived safely at Home`, {
              body: `${student.homeAddress || 'Pinned Home destination'} · ${formatTimeClock(arrivedAtMs)}`,
            });
          } catch {
            // Ignore browser notification errors in restricted contexts
          }
        }
      }

      prevTrackedStatusRef.current[student.id] = effectiveStatus;
    });

    if (shouldNotifyLive) {
      playArrivalChime();
    }

    if (newAlerts.length > 0) {
      setArrivalAlerts((prev) => {
        const existingKeys: Record<string, boolean> = {};
        prev.forEach((p) => {
          existingKeys[p.key] = true;
        });
        const additions = newAlerts.filter((a) => !existingKeys[a.key]);
        return additions.length > 0 ? [...additions, ...prev] : prev;
      });
    }
  }, [watcherLinks, trackedStudents, commutesById, dismissedArrivalKeys, playArrivalChime]);

  const handleGoogleSignIn = async () => {
    setIsSigningIn(true);
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Google sign-in failed.');
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
    setOwnStudents([]);
    setWatcherLinks([]);
    setTrackedStudents({});
    setCommutesById({});
    setFeedsByCommuteId({});
  };

  const handleCompleteProfileSetup = async (data: {
    displayName: string;
    viewMode: ViewMode;
    sectionName: string;
  }) => {
    if (!firebaseUser) return;
    await saveUserProfile({
      uid: firebaseUser.uid,
      displayName: data.displayName,
      email: firebaseUser.email || '',
      viewMode: data.viewMode,
      sectionName: data.sectionName,
      isNew: !userProfile,
    });
    const fresh = await getUserProfile(firebaseUser.uid);
    setUserProfile(fresh);
    setActiveMode(data.viewMode);
  };

  const handleSwitchMode = async (mode: ViewMode) => {
    setActiveMode(mode);
    setPinMode('none');
    if (firebaseUser && userProfile) {
      try {
        await saveUserProfile({
          uid: firebaseUser.uid,
          displayName: userProfile.displayName,
          email: userProfile.email,
          viewMode: mode,
          sectionName: userProfile.sectionName,
          isNew: false,
        });
      } catch {
        // Non-blocking preference sync
      }
    }
  };

  // Students & breadcrumbs passed to Google Map / Offline Map depending on active workspace mode
  const rawMapStudents = useMemo(() => {
    if (activeMode === 'student') {
      return ownStudent ? [ownStudent] : [];
    }
    return watcherLinks
      .filter((l) => l.status === 'active')
      .map((l) => trackedStudents[l.studentId])
      .filter((s): s is StudentProfile => Boolean(s));
  }, [activeMode, ownStudent, watcherLinks, trackedStudents]);

  const mapStudents = useMemo(() => {
    if (!offlineLiveOverride) return rawMapStudents;
    return rawMapStudents.map((s) =>
      s.id === offlineLiveOverride.studentId
        ? {
            ...s,
            lastLat: offlineLiveOverride.lat,
            lastLng: offlineLiveOverride.lng,
            lastHeading: offlineLiveOverride.heading,
            lastSpeedKmh: offlineLiveOverride.speedKmh,
            etaMinutes: offlineLiveOverride.etaMinutes,
            distanceRemainingMeters: offlineLiveOverride.distanceRemainingMeters,
          }
        : s
    );
  }, [rawMapStudents, offlineLiveOverride]);

  const breadcrumbsByStudent = useMemo(() => {
    const out: Record<string, BreadcrumbPoint[]> = {};
    mapStudents.forEach((s) => {
      const base =
        s.activeCommuteId && feedsByCommuteId[s.activeCommuteId]
          ? feedsByCommuteId[s.activeCommuteId].breadcrumbs || []
          : [];
      const queued = queuedBreadcrumbs
        .filter((q) => q.studentId === s.id && (!s.activeCommuteId || q.commuteId === s.activeCommuteId))
        .map((q) => q.point);
      out[s.id] = queued.length > 0 ? [...base, ...queued] : base;
    });
    return out;
  }, [mapStudents, feedsByCommuteId, queuedBreadcrumbs]);

  const ownCommute = ownStudent?.activeCommuteId
    ? commutesById[ownStudent.activeCommuteId] || null
    : null;
  const ownFeed = ownStudent?.activeCommuteId
    ? feedsByCommuteId[ownStudent.activeCommuteId] || null
    : null;

  const focusedMapStudentId =
    activeMode === 'student'
      ? ownStudent?.id || null
      : selectedTrackedStudentId || mapStudents[0]?.id || null;

  const focusedMapStudent =
    mapStudents.find((s) => s.id === focusedMapStudentId) || mapStudents[0] || null;

  const focusedOfflineRoute = focusedMapStudent
    ? offlineRoutesByStudent[focusedMapStudent.id] || null
    : null;

  // Automatically cache computed Google Maps routes locally (strict 30-day TTL) for offline map fallback
  const handleRouteComputed = useCallback(
    (metrics: RouteMetrics) => {
      setRouteMetrics(metrics);
      if (focusedMapStudent && focusedMapStudent.hasHomePin && metrics.path.length >= 2) {
        const saved = saveOfflineRouteForStudent({
          student: focusedMapStudent,
          travelMode,
          distanceMeters: metrics.distanceMeters,
          durationMinutes: metrics.durationMinutes,
          path: metrics.path,
        });
        setOfflineRoutesByStudent((prev) => ({
          ...prev,
          [focusedMapStudent.id]: saved,
        }));
      }
    },
    [focusedMapStudent, travelMode]
  );

  const handleSaveOfflineRoute = useCallback(() => {
    if (!focusedMapStudent || !focusedMapStudent.hasHomePin) return;
    const path =
      routeMetrics?.path && routeMetrics.path.length >= 2
        ? routeMetrics.path
        : [
            { lat: focusedMapStudent.schoolLat, lng: focusedMapStudent.schoolLng },
            { lat: focusedMapStudent.homeLat, lng: focusedMapStudent.homeLng },
          ];
    const saved = saveOfflineRouteForStudent({
      student: focusedMapStudent,
      travelMode,
      distanceMeters: routeMetrics?.distanceMeters ?? focusedMapStudent.distanceRemainingMeters,
      durationMinutes: routeMetrics?.durationMinutes ?? Math.max(1, focusedMapStudent.etaMinutes),
      path,
    });
    setOfflineRoutesByStudent((prev) => ({
      ...prev,
      [focusedMapStudent.id]: saved,
    }));
  }, [focusedMapStudent, routeMetrics, travelMode]);

  const handleOfflineTelemetry = useCallback(
    (payload: {
      coords: LatLngPoint;
      heading: number;
      speedKmh: number;
      etaMinutes: number;
      distanceRemainingMeters: number;
      arrivedHome: boolean;
    }) => {
      if (!ownStudent || !ownCommute) return;
      const nextQueue = enqueueOfflineBreadcrumb({
        commuteId: ownCommute.id,
        studentId: ownStudent.id,
        point: {
          lat: payload.coords.lat,
          lng: payload.coords.lng,
          speedKmh: payload.speedKmh,
          tsMs: Date.now(),
        },
        heading: payload.heading,
        etaMinutes: payload.etaMinutes,
        distanceRemainingMeters: payload.distanceRemainingMeters,
      });
      setQueuedBreadcrumbs(nextQueue);
      setOfflineLiveOverride({
        studentId: ownStudent.id,
        lat: payload.coords.lat,
        lng: payload.coords.lng,
        heading: payload.heading,
        speedKmh: payload.speedKmh,
        etaMinutes: payload.etaMinutes,
        distanceRemainingMeters: payload.distanceRemainingMeters,
      });
    },
    [ownStudent, ownCommute]
  );

  const handleTravelModeChange = useCallback((mode: TravelMode) => {
    setTravelMode(mode);
    if (mode === 'DRIVING') {
      setShowTrafficLayer(true);
    }
  }, []);

  // Sync queued offline GPS points to Firestore as soon as connectivity returns
  useEffect(() => {
    if (!isOnline || !ownStudent || !ownCommute || queuedBreadcrumbs.length === 0) return;
    const matching = queuedBreadcrumbs.filter((q) => q.commuteId === ownCommute.id);
    if (matching.length === 0) return;

    const latest = matching[matching.length - 1];
    const flush = async () => {
      try {
        await pushLiveCommuteTelemetry({
          student: ownStudent,
          commute: ownCommute,
          feed: ownFeed,
          coords: { lat: latest.point.lat, lng: latest.point.lng },
          heading: latest.heading,
          speedKmh: latest.point.speedKmh,
          etaMinutes: latest.etaMinutes,
          distanceRemainingMeters: latest.distanceRemainingMeters,
        });
        clearQueuedOfflineBreadcrumbsForCommute(ownCommute.id);
        setQueuedBreadcrumbs(loadQueuedOfflineBreadcrumbs());
        setOfflineLiveOverride(null);
      } catch {
        // Keep queue intact for next retry
      }
    };
    void flush();
  }, [isOnline, ownStudent, ownCommute, ownFeed, queuedBreadcrumbs]);

  const effectiveMapView: 'google' | 'offline' =
    !isOnline || !GOOGLE_MAPS_API_KEY || quotaExceeded || preferOfflineMap
      ? 'offline'
      : 'google';

  const isAuthenticatedWorkspace = Boolean(firebaseUser && userProfile);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Mandatory Case A Demo Key Quota Banner */}
      {quotaExceeded && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      {/* Top Bar Contract: Strict 3-Zone Header */}
      <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-8 sticky top-0 z-40">
        {/* Zone 1: Single-line Wordmark */}
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            if (isAuthenticatedWorkspace) setMobilePane('controls');
          }}
          className="text-lg font-extrabold tracking-tight text-slate-900 whitespace-nowrap shrink-0 font-display"
        >
          WayHome
        </a>

        {/* Zone 2: Single-line Nav Links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          {isAuthenticatedWorkspace ? (
            <>
              <button
                type="button"
                onClick={() => {
                  if (activeMode === 'student') setStudentTab('commute');
                  setMobilePane('map');
                }}
                className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Live Map
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleSwitchMode('student');
                  setStudentTab('pins');
                }}
                className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Home Pin
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleSwitchMode('parent');
                }}
                className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Parent &amp; Adviser
              </button>
              <button
                type="button"
                onClick={() => {
                  if (activeMode === 'student') setStudentTab('log');
                  else void handleSwitchMode('student');
                }}
                className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Safety Log
              </button>
            </>
          ) : (
            <>
              <a
                href="#features"
                onClick={(e) => {
                  e.preventDefault();
                  void handleGoogleSignIn();
                }}
                className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
              >
                Live Tracking
              </a>
              <a
                href="#pins"
                onClick={(e) => {
                  e.preventDefault();
                  void handleGoogleSignIn();
                }}
                className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
              >
                Home Pins
              </a>
              <a
                href="#advisers"
                onClick={(e) => {
                  e.preventDefault();
                  void handleGoogleSignIn();
                }}
                className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
              >
                Parents &amp; Advisers
              </a>
              <a
                href="#consent"
                onClick={(e) => {
                  e.preventDefault();
                  void handleGoogleSignIn();
                }}
                className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
              >
                Safety Consent
              </a>
            </>
          )}
        </nav>

        {/* Zone 3: Single Primary Action Button */}
        <div className="flex items-center shrink-0">
          {firebaseUser ? (
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="px-4 py-2 min-h-[40px] text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Sign Out
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleGoogleSignIn()}
              disabled={isSigningIn}
              className="px-4 py-2 min-h-[40px] text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Sign In
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      {!authReady || profileLoading ? (
        <div className="flex-1 flex items-center justify-center p-10">
          <div className="flex items-center gap-2.5 text-sm text-slate-600">
            <Loader2 className="w-4 h-4 animate-spin text-blue-700" />
            <span>Loading WayHome workspace...</span>
          </div>
        </div>
      ) : !firebaseUser ? (
        <AuthLanding
          onSignIn={handleGoogleSignIn}
          isSigningIn={isSigningIn}
          authError={authError}
        />
      ) : !userProfile ? (
        <ProfileSetupModal
          defaultName={firebaseUser.displayName || 'Student'}
          email={firebaseUser.email || ''}
          onComplete={handleCompleteProfileSetup}
        />
      ) : (
        <APIProvider
          apiKey={GOOGLE_MAPS_API_KEY}
          libraries={['places', 'routes', 'marker']}
          language="en"
          region="US"
          onError={(err) => {
            console.error('Google Maps APIProvider error:', err);
          }}
        >
          <main className="h-[calc(100dvh-64px)] flex flex-col lg:flex-row overflow-hidden">
            {/* Left Operations Panel */}
            <aside
              className={`w-full lg:w-[410px] xl:w-[440px] shrink-0 bg-white border-r border-slate-200 flex-col flex-1 min-h-0 lg:flex-none lg:h-full pb-14 lg:pb-0 overflow-hidden ${
                mobilePane === 'map' ? 'hidden lg:flex' : 'flex'
              }`}
            >
              {/* Workspace Mode Switcher Toolbar */}
              <div className="px-5 py-3 border-b border-slate-200 bg-slate-50/70 flex items-center gap-2">
                <div className="flex-1 grid grid-cols-3 gap-1 p-1 bg-slate-200/70 rounded-lg">
                  {(
                    [
                      { id: 'student', label: 'Student' },
                      { id: 'parent', label: 'Parent' },
                      { id: 'adviser', label: 'Adviser' },
                    ] as const
                  ).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => void handleSwitchMode(m.id)}
                      className={`min-h-[36px] text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                        activeMode === m.id
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <PWAInstallButton compact />
              </div>

              {/* Active Role Workspace */}
              <div className="flex-1 overflow-y-auto">
                {activeMode === 'student' ? (
                  <StudentWorkspace
                    userProfile={userProfile}
                    student={ownStudent}
                    activeCommute={ownCommute}
                    commuteFeed={ownFeed}
                    schools={schools}
                    watchers={studentWatchers}
                    activeTab={studentTab}
                    onTabChange={setStudentTab}
                    pinMode={pinMode}
                    onPinModeChange={(mode) => {
                      setPinMode(mode);
                      if (mode !== 'none') setMobilePane('map');
                    }}
                    lastDroppedPin={lastDroppedPin}
                    onClearDroppedPin={() => setLastDroppedPin(null)}
                    travelMode={travelMode}
                    onTravelModeChange={handleTravelModeChange}
                    routeMetrics={routeMetrics}
                    isOnline={isOnline}
                    offlineRoute={ownStudent ? offlineRoutesByStudent[ownStudent.id] || null : null}
                    mapViewMode={effectiveMapView}
                    onToggleOfflineMap={() => {
                      setPreferOfflineMap((v) => !v);
                      setMobilePane('map');
                    }}
                    onOfflineTelemetry={handleOfflineTelemetry}
                  />
                ) : (
                  <WatcherWorkspace
                    userProfile={{ ...userProfile, viewMode: activeMode }}
                    ownStudentShareCode={ownStudent?.shareCode}
                    watcherLinks={watcherLinks}
                    trackedStudents={trackedStudents}
                    commutesById={commutesById}
                    feedsByCommuteId={feedsByCommuteId}
                    selectedStudentId={selectedTrackedStudentId}
                    onSelectStudent={(id) => {
                      setSelectedTrackedStudentId(id);
                    }}
                    arrivalAlerts={arrivalAlerts}
                    onDismissArrivalAlert={handleDismissArrivalAlert}
                    notificationPermission={notificationPermission}
                    onRequestNotifications={handleRequestNotifications}
                    soundEnabled={soundEnabled}
                    onToggleSound={() => setSoundEnabled((v) => !v)}
                  />
                )}
              </div>
            </aside>

            {/* Right Interactive Map Viewport (Live Google Maps + Offline Route Fallback) */}
            <section
              className={`relative flex-1 min-h-[420px] mb-14 lg:mb-0 w-full lg:h-full overflow-hidden ${
                mobilePane === 'controls' ? 'hidden lg:block' : 'block'
              }`}
            >
              {/* Top-left Map Mode Switcher + Dynamic Traffic-Aware ETA Widget */}
              <div className="absolute top-3.5 left-4 z-30 flex flex-col items-start gap-2.5 max-w-[calc(100%-2rem)] pointer-events-none">
                <div className="pointer-events-auto">
                  {isOnline && GOOGLE_MAPS_API_KEY && !quotaExceeded ? (
                    <div className="inline-flex items-center p-1 rounded-lg bg-white/95 backdrop-blur-md border border-slate-200 shadow-sm">
                      <button
                        type="button"
                        onClick={() => setPreferOfflineMap(false)}
                        className={`min-h-[30px] px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                          effectiveMapView === 'google'
                            ? 'bg-blue-700 text-white'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Live Google Map
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreferOfflineMap(true)}
                        className={`min-h-[30px] px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                          effectiveMapView === 'offline'
                            ? 'bg-slate-900 text-white'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Offline Map
                      </button>
                    </div>
                  ) : (
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-50/95 backdrop-blur-md border border-amber-200 shadow-sm text-xs font-semibold text-amber-900">
                      <WifiOff className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                      <span className="whitespace-nowrap">
                        {!isOnline
                          ? 'Offline Mode — Saved route & device GPS active'
                          : 'Offline Route Map Fallback'}
                      </span>
                    </div>
                  )}
                </div>

                {pinMode === 'none' && (
                  <div className="pointer-events-auto">
                    <DynamicEtaWidget
                      student={focusedMapStudent}
                      travelMode={travelMode}
                      onTravelModeChange={handleTravelModeChange}
                      routeMetrics={routeMetrics}
                      offlineRoute={focusedOfflineRoute}
                      isOnline={isOnline}
                      mapViewMode={effectiveMapView}
                      showTrafficLayer={showTrafficLayer}
                      onToggleTrafficLayer={() => setShowTrafficLayer((v) => !v)}
                      onRefreshRoute={() => setRouteRefreshNonce((n) => n + 1)}
                    />
                  </div>
                )}
              </div>

              {effectiveMapView === 'google' ? (
                <CommuteMap
                  students={mapStudents}
                  selectedStudentId={focusedMapStudentId}
                  onSelectStudent={(id) => setSelectedTrackedStudentId(id)}
                  breadcrumbsByStudent={breadcrumbsByStudent}
                  pinMode={pinMode}
                  onMapPinDrop={(coords) => {
                    setLastDroppedPin(coords);
                    setMobilePane('controls');
                  }}
                  travelMode={travelMode}
                  onRouteComputed={handleRouteComputed}
                  defaultCenter={browserCenter}
                  showTrafficLayer={showTrafficLayer}
                  routeRefreshNonce={routeRefreshNonce}
                  onSwitchToOffline={() => setPreferOfflineMap(true)}
                />
              ) : (
                <OfflineCommuteMap
                  students={mapStudents}
                  selectedStudentId={focusedMapStudentId}
                  onSelectStudent={(id) => setSelectedTrackedStudentId(id)}
                  breadcrumbsByStudent={breadcrumbsByStudent}
                  offlineRoute={focusedOfflineRoute}
                  pinMode={pinMode}
                  onMapPinDrop={(coords) => {
                    setLastDroppedPin(coords);
                    setMobilePane('controls');
                  }}
                  defaultCenter={browserCenter}
                  isOnline={isOnline}
                  queuedBreadcrumbCount={queuedBreadcrumbs.length}
                  canSaveRoute={Boolean(focusedMapStudent?.hasHomePin)}
                  onSaveOfflineRoute={handleSaveOfflineRoute}
                />
              )}

              {/* Floating Home Arrival Alert Toast for Parents & Advisers */}
              {activeMode !== 'student' && arrivalAlerts.length > 0 && (
                <div className="absolute top-4 right-4 z-30 w-[calc(100%-2rem)] max-w-sm space-y-2 pointer-events-auto">
                  {arrivalAlerts.slice(0, 2).map((alert) => (
                    <div
                      key={alert.key}
                      role="status"
                      aria-live="polite"
                      className="p-3.5 rounded-xl bg-white/95 backdrop-blur-md border border-emerald-300 shadow-lg flex items-start gap-3"
                    >
                      <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                        <Home className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          <span className="truncate">
                            {alert.studentName} reached Home Pin
                          </span>
                        </p>
                        <p className="text-[11px] text-slate-600 mt-0.5 truncate">
                          {alert.homeAddress || 'Pinned Home Destination'} ·{' '}
                          <span className="font-mono">{formatTimeClock(alert.arrivedAtMs)}</span>
                        </p>
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setSelectedTrackedStudentId(alert.studentId)}
                            className="px-2.5 py-1 rounded-md bg-emerald-700 hover:bg-emerald-800 text-white text-[11px] font-semibold cursor-pointer"
                          >
                            View on Map
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDismissArrivalAlert(alert.key)}
                            className="px-2 py-1 rounded-md text-[11px] font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDismissArrivalAlert(alert.key)}
                        aria-label="Close arrival notification"
                        className="text-slate-400 hover:text-slate-700 p-1 rounded cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Compact Mobile View Switcher (Bottom Bar <= 15% viewport height) */}
            <div className="lg:hidden fixed bottom-0 left-0 right-0 z-30 h-14 bg-white/95 backdrop-blur-md border-t border-slate-200 grid grid-cols-2">
              <button
                type="button"
                onClick={() => setMobilePane('controls')}
                className={`flex items-center justify-center gap-2 text-xs font-semibold ${
                  mobilePane === 'controls' ? 'text-blue-700' : 'text-slate-600'
                }`}
              >
                <SlidersHorizontal className="w-4 h-4" />
                <span>Controls</span>
              </button>
              <button
                type="button"
                onClick={() => setMobilePane('map')}
                className={`flex items-center justify-center gap-2 text-xs font-semibold border-l border-slate-200 ${
                  mobilePane === 'map' ? 'text-blue-700' : 'text-slate-600'
                }`}
              >
                <MapIcon className="w-4 h-4" />
                <span>Live Map</span>
              </button>
            </div>
          </main>
        </APIProvider>
      )}
    </div>
  );
}
