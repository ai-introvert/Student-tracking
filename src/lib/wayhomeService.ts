import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  Unsubscribe,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import {
  BreadcrumbPoint,
  CommuteFeed,
  CommuteSession,
  FIELD_LIMITS,
  LatLngPoint,
  SafetyEvent,
  SchoolCampus,
  ShareCodeLookup,
  StudentProfile,
  TravelMode,
  UserProfile,
  ViewMode,
  WatcherLink,
  WatcherRelation,
} from '../types/wayhome';
import { clampCoord, clampText, generateSafeId, generateShareCode } from './geo';

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const path = `users/${uid}`;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? (snap.data() as UserProfile) : null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function saveUserProfile(params: {
  uid: string;
  displayName: string;
  email: string;
  viewMode: ViewMode;
  sectionName: string;
  isNew: boolean;
}): Promise<void> {
  const path = `users/${params.uid}`;
  try {
    if (params.isNew) {
      await setDoc(doc(db, 'users', params.uid), {
        uid: params.uid,
        displayName: clampText(params.displayName, FIELD_LIMITS.NAME_MAX) || 'User',
        email: clampText(params.email, 120),
        viewMode: params.viewMode,
        sectionName: clampText(params.sectionName, FIELD_LIMITS.SECTION_MAX),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(doc(db, 'users', params.uid), {
        displayName: clampText(params.displayName, FIELD_LIMITS.NAME_MAX) || 'User',
        viewMode: params.viewMode,
        sectionName: clampText(params.sectionName, FIELD_LIMITS.SECTION_MAX),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, params.isNew ? OperationType.CREATE : OperationType.UPDATE, path);
  }
}

export function subscribeSchools(
  onData: (schools: SchoolCampus[]) => void
): Unsubscribe {
  const path = 'schools';
  return onSnapshot(
    collection(db, 'schools'),
    (snap) => {
      const list = snap.docs.map((d) => d.data() as SchoolCampus);
      onData(list);
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export async function createSchoolCampus(params: {
  name: string;
  address: string;
  lat: number;
  lng: number;
  createdBy: string;
}): Promise<SchoolCampus> {
  const id = generateSafeId('sch');
  const coords = clampCoord(params.lat, params.lng);
  const path = `schools/${id}`;
  const payload = {
    id,
    name: clampText(params.name, FIELD_LIMITS.SCHOOL_NAME_MAX) || 'School Campus',
    address: clampText(params.address, FIELD_LIMITS.ADDRESS_MAX) || 'Campus Location',
    lat: coords.lat,
    lng: coords.lng,
    createdBy: params.createdBy,
    createdAt: serverTimestamp(),
  };
  try {
    await setDoc(doc(db, 'schools', id), payload);
    return payload as SchoolCampus;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export function subscribeOwnStudentProfiles(
  ownerUid: string,
  onData: (students: StudentProfile[]) => void
): Unsubscribe {
  const path = 'studentProfiles';
  const q = query(collection(db, 'studentProfiles'), where('ownerUid', '==', ownerUid));
  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => d.data() as StudentProfile));
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export function subscribeStudentById(
  studentId: string,
  onData: (student: StudentProfile | null) => void
): Unsubscribe {
  const path = `studentProfiles/${studentId}`;
  return onSnapshot(
    doc(db, 'studentProfiles', studentId),
    (snap) => {
      onData(snap.exists() ? (snap.data() as StudentProfile) : null);
    },
    (error) => handleFirestoreError(error, OperationType.GET, path)
  );
}

export async function createStudentProfile(params: {
  ownerUid: string;
  studentName: string;
  gradeSection: string;
  schoolName: string;
  schoolLat: number;
  schoolLng: number;
}): Promise<StudentProfile> {
  const studentId = generateSafeId('stu');
  const shareCode = generateShareCode();
  const schoolCoords = clampCoord(params.schoolLat, params.schoolLng);
  const studentName = clampText(params.studentName, FIELD_LIMITS.NAME_MAX) || 'Student';
  const gradeSection = clampText(params.gradeSection, FIELD_LIMITS.SECTION_MAX) || 'Student';
  const schoolName = clampText(params.schoolName, FIELD_LIMITS.SCHOOL_NAME_MAX) || 'School Campus';

  const profileData = {
    id: studentId,
    ownerUid: params.ownerUid,
    studentName,
    gradeSection,
    schoolName,
    schoolLat: schoolCoords.lat,
    schoolLng: schoolCoords.lng,
    homeAddress: '',
    homeLat: schoolCoords.lat,
    homeLng: schoolCoords.lng,
    hasHomePin: false,
    shareCode,
    activeCommuteId: '',
    recentCommuteIds: [],
    currentStatus: 'at_school',
    lastLat: schoolCoords.lat,
    lastLng: schoolCoords.lng,
    lastHeading: 0,
    lastSpeedKmh: 0,
    etaMinutes: 0,
    distanceRemainingMeters: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'studentProfiles', studentId), profileData);
    await setDoc(doc(db, 'shareCodes', shareCode), {
      code: shareCode,
      studentId,
      studentOwnerUid: params.ownerUid,
      studentName,
      gradeSection,
      createdAt: serverTimestamp(),
    });
    return profileData as StudentProfile;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `studentProfiles/${studentId}`);
  }
}

export async function updateStudentPinConfig(
  student: StudentProfile,
  updates: {
    studentName?: string;
    gradeSection?: string;
    schoolName?: string;
    schoolLat?: number;
    schoolLng?: number;
    homeAddress?: string;
    homeLat?: number;
    homeLng?: number;
    hasHomePin?: boolean;
  }
): Promise<void> {
  const path = `studentProfiles/${student.id}`;
  const schoolCoords = clampCoord(
    updates.schoolLat ?? student.schoolLat,
    updates.schoolLng ?? student.schoolLng
  );
  const homeCoords = clampCoord(
    updates.homeLat ?? student.homeLat,
    updates.homeLng ?? student.homeLng
  );
  const nextName = clampText(updates.studentName ?? student.studentName, FIELD_LIMITS.NAME_MAX) || student.studentName;
  const nextSection = clampText(updates.gradeSection ?? student.gradeSection, FIELD_LIMITS.SECTION_MAX) || student.gradeSection;

  try {
    await updateDoc(doc(db, 'studentProfiles', student.id), {
      studentName: nextName,
      gradeSection: nextSection,
      schoolName: clampText(updates.schoolName ?? student.schoolName, FIELD_LIMITS.SCHOOL_NAME_MAX) || student.schoolName,
      schoolLat: schoolCoords.lat,
      schoolLng: schoolCoords.lng,
      homeAddress: clampText(updates.homeAddress ?? student.homeAddress, FIELD_LIMITS.ADDRESS_MAX),
      homeLat: homeCoords.lat,
      homeLng: homeCoords.lng,
      hasHomePin: updates.hasHomePin ?? student.hasHomePin,
      updatedAt: serverTimestamp(),
    });

    if (updates.studentName !== undefined || updates.gradeSection !== undefined) {
      await updateDoc(doc(db, 'shareCodes', student.shareCode), {
        studentName: nextName,
        gradeSection: nextSection,
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export function subscribeWatcherLinksForWatcher(
  watcherUid: string,
  onData: (links: WatcherLink[]) => void
): Unsubscribe {
  const path = 'watcherLinks';
  const q = query(collection(db, 'watcherLinks'), where('watcherUid', '==', watcherUid));
  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => d.data() as WatcherLink));
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export function subscribeWatcherLinksForStudent(
  studentOwnerUid: string,
  onData: (links: WatcherLink[]) => void
): Unsubscribe {
  const path = 'watcherLinks';
  const q = query(
    collection(db, 'watcherLinks'),
    where('studentOwnerUid', '==', studentOwnerUid)
  );
  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => d.data() as WatcherLink));
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export async function linkStudentByShareCode(params: {
  shareCode: string;
  watcherUid: string;
  watcherName: string;
  watcherRelation: WatcherRelation;
}): Promise<{ ok: boolean; error?: string; studentName?: string }> {
  const cleanCode = params.shareCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleanCode.length < 6 || cleanCode.length > 12) {
    return { ok: false, error: 'Share code must be 6–12 alphanumeric characters.' };
  }

  let lookupSnap;
  try {
    lookupSnap = await getDoc(doc(db, 'shareCodes', cleanCode));
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `shareCodes/${cleanCode}`);
  }

  if (!lookupSnap.exists()) {
    return { ok: false, error: 'No student found with that Share Code.' };
  }

  const lookup = lookupSnap.data() as ShareCodeLookup;
  const linkId = `${lookup.studentId}_${params.watcherUid}`;
  const linkPath = `watcherLinks/${linkId}`;

  try {
    await setDoc(doc(db, 'watcherLinks', linkId), {
      id: linkId,
      studentId: lookup.studentId,
      studentOwnerUid: lookup.studentOwnerUid,
      studentName: lookup.studentName,
      gradeSection: lookup.gradeSection,
      watcherUid: params.watcherUid,
      watcherName: clampText(params.watcherName, FIELD_LIMITS.NAME_MAX) || 'Guardian',
      watcherRelation: params.watcherRelation,
      shareCode: cleanCode,
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { ok: true, studentName: lookup.studentName };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, linkPath);
  }
}

export async function updateWatcherLinkStatus(
  linkId: string,
  status: 'active' | 'revoked'
): Promise<void> {
  const path = `watcherLinks/${linkId}`;
  try {
    await updateDoc(doc(db, 'watcherLinks', linkId), {
      status,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function removeWatcherLink(linkId: string): Promise<void> {
  const path = `watcherLinks/${linkId}`;
  try {
    await deleteDoc(doc(db, 'watcherLinks', linkId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export function subscribeCommute(
  commuteId: string,
  onData: (commute: CommuteSession | null) => void
): Unsubscribe {
  const path = `commutes/${commuteId}`;
  return onSnapshot(
    doc(db, 'commutes', commuteId),
    (snap) => {
      onData(snap.exists() ? (snap.data() as CommuteSession) : null);
    },
    (error) => handleFirestoreError(error, OperationType.GET, path)
  );
}

export function subscribeCommuteFeed(
  commuteId: string,
  onData: (feed: CommuteFeed | null) => void
): Unsubscribe {
  const path = `commutes/${commuteId}/meta/feed`;
  return onSnapshot(
    doc(db, 'commutes', commuteId, 'meta', 'feed'),
    (snap) => {
      onData(snap.exists() ? (snap.data() as CommuteFeed) : null);
    },
    (error) => handleFirestoreError(error, OperationType.GET, path)
  );
}

export async function startCommuteSession(params: {
  student: StudentProfile;
  travelMode: TravelMode;
  initialDistanceMeters: number;
  initialEtaMinutes: number;
  startLocation?: LatLngPoint;
}): Promise<string> {
  const commuteId = generateSafeId('com');
  const origin = clampCoord(
    params.startLocation?.lat ?? params.student.schoolLat,
    params.startLocation?.lng ?? params.student.schoolLng
  );
  const dest = clampCoord(params.student.homeLat, params.student.homeLng);
  const nowMs = Date.now();

  const commutePayload = {
    id: commuteId,
    studentId: params.student.id,
    studentOwnerUid: params.student.ownerUid,
    studentName: params.student.studentName,
    schoolName: params.student.schoolName,
    originLat: origin.lat,
    originLng: origin.lng,
    homeAddress: clampText(params.student.homeAddress, FIELD_LIMITS.ADDRESS_MAX),
    destinationLat: dest.lat,
    destinationLng: dest.lng,
    travelMode: params.travelMode,
    status: 'en_route',
    currentLat: origin.lat,
    currentLng: origin.lng,
    speedKmh: 0,
    etaMinutes: Math.max(0, Math.min(1440, Math.round(params.initialEtaMinutes))),
    distanceRemainingMeters: Math.max(0, Math.min(500000, Math.round(params.initialDistanceMeters))),
    sosNote: '',
    endedAtMs: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const initialBreadcrumb: BreadcrumbPoint = {
    lat: origin.lat,
    lng: origin.lng,
    speedKmh: 0,
    tsMs: nowMs,
  };

  const initialEvent: SafetyEvent = {
    id: generateSafeId('evt'),
    type: 'departed_school',
    actorName: params.student.studentName,
    actorRole: 'student',
    message: `Departed ${params.student.schoolName} heading home (${params.travelMode.toLowerCase()}).`,
    lat: origin.lat,
    lng: origin.lng,
    tsMs: nowMs,
  };

  const feedPayload = {
    commuteId,
    studentId: params.student.id,
    studentOwnerUid: params.student.ownerUid,
    breadcrumbs: [initialBreadcrumb],
    events: [initialEvent],
    updatedAt: serverTimestamp(),
  };

  const recentIds = [commuteId, ...params.student.recentCommuteIds.filter((id) => id !== commuteId)].slice(
    0,
    FIELD_LIMITS.RECENT_COMMUTES_MAX
  );

  try {
    await setDoc(doc(db, 'commutes', commuteId), commutePayload);
    await setDoc(doc(db, 'commutes', commuteId, 'meta', 'feed'), feedPayload);
    await updateDoc(doc(db, 'studentProfiles', params.student.id), {
      activeCommuteId: commuteId,
      recentCommuteIds: recentIds,
      currentStatus: 'en_route',
      lastLat: origin.lat,
      lastLng: origin.lng,
      lastHeading: 0,
      lastSpeedKmh: 0,
      etaMinutes: commutePayload.etaMinutes,
      distanceRemainingMeters: commutePayload.distanceRemainingMeters,
      updatedAt: serverTimestamp(),
    });
    return commuteId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `commutes/${commuteId}`);
  }
}

export async function pushLiveCommuteTelemetry(params: {
  student: StudentProfile;
  commute: CommuteSession;
  feed: CommuteFeed | null;
  coords: LatLngPoint;
  heading: number;
  speedKmh: number;
  etaMinutes: number;
  distanceRemainingMeters: number;
}): Promise<void> {
  if (params.commute.status === 'arrived_home' || params.commute.status === 'cancelled') {
    return;
  }

  const safeCoords = clampCoord(params.coords.lat, params.coords.lng);
  const safeSpeed = Math.max(0, Math.min(250, Math.round(params.speedKmh * 10) / 10));
  const safeHeading = Math.max(0, Math.min(360, Math.round(params.heading)));
  const safeEta = Math.max(0, Math.min(1440, Math.round(params.etaMinutes)));
  const safeDist = Math.max(0, Math.min(500000, Math.round(params.distanceRemainingMeters)));

  const prevBreadcrumbs = params.feed?.breadcrumbs || [];
  const nextBreadcrumbs = [
    ...prevBreadcrumbs,
    {
      lat: safeCoords.lat,
      lng: safeCoords.lng,
      speedKmh: safeSpeed,
      tsMs: Date.now(),
    },
  ].slice(-95);

  try {
    await updateDoc(doc(db, 'commutes', params.commute.id), {
      currentLat: safeCoords.lat,
      currentLng: safeCoords.lng,
      speedKmh: safeSpeed,
      etaMinutes: safeEta,
      distanceRemainingMeters: safeDist,
      updatedAt: serverTimestamp(),
    });

    await updateDoc(doc(db, 'studentProfiles', params.student.id), {
      lastLat: safeCoords.lat,
      lastLng: safeCoords.lng,
      lastHeading: safeHeading,
      lastSpeedKmh: safeSpeed,
      etaMinutes: safeEta,
      distanceRemainingMeters: safeDist,
      updatedAt: serverTimestamp(),
    });

    await updateDoc(doc(db, 'commutes', params.commute.id, 'meta', 'feed'), {
      breadcrumbs: nextBreadcrumbs,
      events: (params.feed?.events || []).slice(-38),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `commutes/${params.commute.id}`);
  }
}

export async function appendStudentSafetyAction(params: {
  student: StudentProfile;
  commute: CommuteSession;
  feed: CommuteFeed | null;
  action: 'checkpoint' | 'sos_triggered' | 'arrived_home' | 'cancelled';
  note?: string;
}): Promise<void> {
  if (params.commute.status === 'arrived_home' || params.commute.status === 'cancelled') {
    return;
  }

  const nowMs = Date.now();
  const isTerminal = params.action === 'arrived_home' || params.action === 'cancelled';
  const nextCommuteStatus =
    params.action === 'sos_triggered'
      ? 'sos_alert'
      : params.action === 'arrived_home'
      ? 'arrived_home'
      : params.action === 'cancelled'
      ? 'cancelled'
      : params.commute.status;

  const nextStudentStatus =
    params.action === 'sos_triggered'
      ? 'sos_alert'
      : params.action === 'arrived_home'
      ? 'arrived_home'
      : params.action === 'cancelled'
      ? 'at_school'
      : params.student.currentStatus;

  const messageMap = {
    checkpoint: 'Student checked in: Safe and continuing route home.',
    sos_triggered: params.note
      ? `SOS Alert: ${clampText(params.note, 180)}`
      : 'SOS Emergency Alert triggered by student.',
    arrived_home: 'Student arrived safely inside pinned Home zone.',
    cancelled: 'Commute tracking ended by student.',
  };

  const event: SafetyEvent = {
    id: generateSafeId('evt'),
    type: params.action,
    actorName: params.student.studentName,
    actorRole: 'student',
    message: messageMap[params.action],
    lat: params.student.lastLat,
    lng: params.student.lastLng,
    tsMs: nowMs,
  };

  const nextEvents = [...(params.feed?.events || []), event].slice(-38);
  const nextBreadcrumbs = (params.feed?.breadcrumbs || []).slice(-95);

  try {
    await updateDoc(doc(db, 'commutes', params.commute.id), {
      status: nextCommuteStatus,
      sosNote:
        params.action === 'sos_triggered'
          ? clampText(params.note || 'Emergency assistance requested', FIELD_LIMITS.SOS_NOTE_MAX)
          : params.commute.sosNote,
      endedAtMs: isTerminal ? nowMs : 0,
      distanceRemainingMeters:
        params.action === 'arrived_home' ? 0 : params.commute.distanceRemainingMeters,
      etaMinutes: params.action === 'arrived_home' ? 0 : params.commute.etaMinutes,
      updatedAt: serverTimestamp(),
    });

    await updateDoc(doc(db, 'studentProfiles', params.student.id), {
      currentStatus: nextStudentStatus,
      distanceRemainingMeters:
        params.action === 'arrived_home' ? 0 : params.student.distanceRemainingMeters,
      etaMinutes: params.action === 'arrived_home' ? 0 : params.student.etaMinutes,
      updatedAt: serverTimestamp(),
    });

    await updateDoc(doc(db, 'commutes', params.commute.id, 'meta', 'feed'), {
      breadcrumbs: nextBreadcrumbs,
      events: nextEvents,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `commutes/${params.commute.id}`);
  }
}

export async function sendWatcherSafetyAction(params: {
  commute: CommuteSession;
  feed: CommuteFeed | null;
  watcherName: string;
  watcherRelation: WatcherRelation;
  action: 'safety_ping' | 'acknowledge_sos';
}): Promise<void> {
  const nowMs = Date.now();
  const event: SafetyEvent = {
    id: generateSafeId('evt'),
    type: params.action === 'acknowledge_sos' ? 'sos_resolved' : 'safety_ping',
    actorName: clampText(params.watcherName, FIELD_LIMITS.NAME_MAX) || 'Guardian',
    actorRole: params.watcherRelation,
    message:
      params.action === 'acknowledge_sos'
        ? `${params.watcherName} (${params.watcherRelation}) acknowledged SOS alert and is responding.`
        : `${params.watcherName} (${params.watcherRelation}) requested a quick safety check-in.`,
    lat: params.commute.currentLat,
    lng: params.commute.currentLng,
    tsMs: nowMs,
  };

  const nextEvents = [...(params.feed?.events || []), event].slice(-38);

  try {
    if (params.action === 'acknowledge_sos' && params.commute.status === 'sos_alert') {
      await updateDoc(doc(db, 'commutes', params.commute.id), {
        status: 'en_route',
        sosNote: clampText(`Acknowledged by ${params.watcherName}`, FIELD_LIMITS.SOS_NOTE_MAX),
        updatedAt: serverTimestamp(),
      });
    }

    await updateDoc(doc(db, 'commutes', params.commute.id, 'meta', 'feed'), {
      events: nextEvents,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `commutes/${params.commute.id}/meta/feed`);
  }
}
