export type ViewMode = 'student' | 'parent' | 'adviser';

export type StudentStatus = 'at_school' | 'en_route' | 'arrived_home' | 'sos_alert' | 'idle';

export type CommuteStatus = 'en_route' | 'sos_alert' | 'arrived_home' | 'cancelled';

export type TravelMode = 'WALKING' | 'DRIVING' | 'TRANSIT' | 'BICYCLING';

export type WatcherRelation = 'parent' | 'adviser';

export interface LatLngPoint {
  lat: number;
  lng: number;
}

export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  viewMode: ViewMode;
  sectionName: string;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface SchoolCampus {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  createdBy: string;
  createdAt: unknown;
}

export interface StudentProfile {
  id: string;
  ownerUid: string;
  studentName: string;
  gradeSection: string;
  schoolName: string;
  schoolLat: number;
  schoolLng: number;
  homeAddress: string;
  homeLat: number;
  homeLng: number;
  hasHomePin: boolean;
  shareCode: string;
  activeCommuteId: string;
  recentCommuteIds: string[];
  currentStatus: StudentStatus;
  lastLat: number;
  lastLng: number;
  lastHeading: number;
  lastSpeedKmh: number;
  etaMinutes: number;
  distanceRemainingMeters: number;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface ShareCodeLookup {
  code: string;
  studentId: string;
  studentOwnerUid: string;
  studentName: string;
  gradeSection: string;
  createdAt: unknown;
}

export interface WatcherLink {
  id: string;
  studentId: string;
  studentOwnerUid: string;
  studentName: string;
  gradeSection: string;
  watcherUid: string;
  watcherName: string;
  watcherRelation: WatcherRelation;
  shareCode: string;
  status: 'active' | 'revoked';
  createdAt: unknown;
  updatedAt: unknown;
}

export interface CommuteSession {
  id: string;
  studentId: string;
  studentOwnerUid: string;
  studentName: string;
  schoolName: string;
  originLat: number;
  originLng: number;
  homeAddress: string;
  destinationLat: number;
  destinationLng: number;
  travelMode: TravelMode;
  status: CommuteStatus;
  currentLat: number;
  currentLng: number;
  speedKmh: number;
  etaMinutes: number;
  distanceRemainingMeters: number;
  sosNote: string;
  endedAtMs: number;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface BreadcrumbPoint {
  lat: number;
  lng: number;
  speedKmh: number;
  tsMs: number;
}

export interface SafetyEvent {
  id: string;
  type: 'departed_school' | 'checkpoint' | 'sos_triggered' | 'sos_resolved' | 'arrived_home' | 'safety_ping' | 'cancelled';
  actorName: string;
  actorRole: 'student' | 'parent' | 'adviser' | 'system';
  message: string;
  lat: number;
  lng: number;
  tsMs: number;
}

export interface CommuteFeed {
  commuteId: string;
  studentId: string;
  studentOwnerUid: string;
  breadcrumbs: BreadcrumbPoint[];
  events: SafetyEvent[];
  updatedAt: unknown;
}

export const FIELD_LIMITS = {
  NAME_MAX: 80,
  SECTION_MAX: 60,
  SCHOOL_NAME_MAX: 100,
  ADDRESS_MAX: 200,
  SOS_NOTE_MAX: 240,
  BREADCRUMBS_MAX: 100,
  EVENTS_MAX: 40,
  RECENT_COMMUTES_MAX: 10,
} as const;
