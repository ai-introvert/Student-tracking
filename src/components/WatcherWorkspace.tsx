import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  BellRing,
  CheckCircle2,
  Home,
  Loader2,
  Plus,
  School,
  Search,
  ShieldCheck,
  UserPlus,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  CommuteFeed,
  CommuteSession,
  StudentProfile,
  UserProfile,
  WatcherLink,
  WatcherRelation,
} from '../types/wayhome';
import {
  linkStudentByShareCode,
  removeWatcherLink,
  sendWatcherSafetyAction,
} from '../lib/wayhomeService';
import { formatDistance, formatEta, formatTimeClock, getStatusMeta } from '../lib/geo';
import { SafetyTimeline } from './SafetyTimeline';

export interface ArrivalAlert {
  key: string;
  studentId: string;
  studentName: string;
  gradeSection: string;
  homeAddress: string;
  arrivedAtMs: number;
}

interface WatcherWorkspaceProps {
  userProfile: UserProfile;
  ownStudentShareCode?: string | null;
  watcherLinks: WatcherLink[];
  trackedStudents: Record<string, StudentProfile>;
  commutesById: Record<string, CommuteSession>;
  feedsByCommuteId: Record<string, CommuteFeed>;
  selectedStudentId: string | null;
  onSelectStudent: (studentId: string) => void;
  arrivalAlerts: ArrivalAlert[];
  onDismissArrivalAlert: (alertKey: string) => void;
  notificationPermission: NotificationPermission | 'unsupported';
  onRequestNotifications: () => Promise<void>;
  soundEnabled: boolean;
  onToggleSound: () => void;
}

type StatusFilter = 'all' | 'en_route' | 'sos_alert' | 'arrived_home';

export const WatcherWorkspace: React.FC<WatcherWorkspaceProps> = ({
  userProfile,
  ownStudentShareCode,
  watcherLinks,
  trackedStudents,
  commutesById,
  feedsByCommuteId,
  selectedStudentId,
  onSelectStudent,
  arrivalAlerts,
  onDismissArrivalAlert,
  notificationPermission,
  onRequestNotifications,
  soundEnabled,
  onToggleSound,
}) => {
  const [shareCodeInput, setShareCodeInput] = useState('');
  const [relation, setRelation] = useState<WatcherRelation>(
    userProfile.viewMode === 'adviser' ? 'adviser' : 'parent'
  );
  const [isLinking, setIsLinking] = useState(false);
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [isActionBusy, setIsActionBusy] = useState(false);

  const activeLinks = useMemo(
    () => watcherLinks.filter((l) => l.status === 'active'),
    [watcherLinks]
  );

  const studentRows = useMemo(() => {
    return activeLinks
      .map((link) => {
        const student = trackedStudents[link.studentId];
        if (!student) return null;
        const commute = student.activeCommuteId
          ? commutesById[student.activeCommuteId] || null
          : null;
        const effectiveStatus = commute?.status ?? student.currentStatus;
        return { link, student, commute, effectiveStatus };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  }, [activeLinks, trackedStudents, commutesById]);

  const filteredRows = useMemo(() => {
    return studentRows.filter((row) => {
      if (statusFilter !== 'all' && row.effectiveStatus !== statusFilter) {
        return false;
      }
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        return (
          row.student.studentName.toLowerCase().includes(q) ||
          row.student.gradeSection.toLowerCase().includes(q) ||
          row.student.schoolName.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [studentRows, statusFilter, searchTerm]);

  const sosRows = useMemo(
    () => studentRows.filter((r) => r.effectiveStatus === 'sos_alert'),
    [studentRows]
  );

  const selectedRow =
    studentRows.find((r) => r.student.id === selectedStudentId) ||
    studentRows[0] ||
    null;

  const selectedFeed = selectedRow?.commute
    ? feedsByCommuteId[selectedRow.commute.id] || null
    : null;

  const handleLinkStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shareCodeInput.trim()) return;
    setIsLinking(true);
    setLinkError(null);
    setLinkMessage(null);
    try {
      const res = await linkStudentByShareCode({
        shareCode: shareCodeInput,
        watcherUid: userProfile.uid,
        watcherName: userProfile.displayName,
        watcherRelation: relation,
      });
      if (!res.ok) {
        setLinkError(res.error || 'Could not link student.');
      } else {
        setLinkMessage(`Linked ${res.studentName} for live tracking.`);
        setShareCodeInput('');
      }
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Linking failed.');
    } finally {
      setIsLinking(false);
    }
  };

  const handleWatcherAction = async (
    commute: CommuteSession,
    feed: CommuteFeed | null,
    action: 'safety_ping' | 'acknowledge_sos'
  ) => {
    setIsActionBusy(true);
    try {
      await sendWatcherSafetyAction({
        commute,
        feed,
        watcherName: userProfile.displayName,
        watcherRelation: relation,
        action,
      });
      setLinkMessage(
        action === 'acknowledge_sos'
          ? 'SOS alert acknowledged.'
          : 'Safety check-in ping sent to student.'
      );
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Could not send action.');
    } finally {
      setIsActionBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Add Student via Share Code */}
      <div className="p-5 border-b border-slate-200 bg-white space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-slate-900">
            {relation === 'adviser' ? 'Adviser Student Roster' : 'Family Commute Monitor'}
          </h2>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onToggleSound}
              title={soundEnabled ? 'Mute arrival chime' : 'Enable arrival chime'}
              aria-label={soundEnabled ? 'Mute arrival chime' : 'Enable arrival chime'}
              className="min-h-[32px] min-w-[32px] px-2 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 inline-flex items-center justify-center cursor-pointer"
            >
              {soundEnabled ? (
                <Volume2 className="w-3.5 h-3.5 text-blue-700" />
              ) : (
                <VolumeX className="w-3.5 h-3.5 text-slate-400" />
              )}
            </button>
            {notificationPermission !== 'unsupported' && (
              <button
                type="button"
                onClick={() => void onRequestNotifications()}
                disabled={notificationPermission === 'denied'}
                className={`min-h-[32px] px-2.5 py-1 rounded-lg border text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer whitespace-nowrap ${
                  notificationPermission === 'granted'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : notificationPermission === 'denied'
                    ? 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100'
                }`}
              >
                <BellRing className="w-3 h-3" />
                <span>
                  {notificationPermission === 'granted'
                    ? 'Alerts On'
                    : notificationPermission === 'denied'
                    ? 'Blocked'
                    : 'Enable Alerts'}
                </span>
              </button>
            )}
            <span className="text-xs font-mono text-slate-500">
              {studentRows.length}
            </span>
          </div>
        </div>

        <form onSubmit={(e) => void handleLinkStudent(e)} className="space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={shareCodeInput}
              onChange={(e) => setShareCodeInput(e.target.value.toUpperCase())}
              placeholder="Enter Share Code (e.g. WH...)"
              maxLength={12}
              className="flex-1 min-h-[40px] px-3 py-1.5 text-xs font-mono uppercase bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:normal-case placeholder:font-sans focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
            />
            <select
              value={relation}
              onChange={(e) => setRelation(e.target.value as WatcherRelation)}
              aria-label="Watcher relationship"
              className="min-h-[40px] px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-lg text-slate-800 font-medium"
            >
              <option value="parent">Parent</option>
              <option value="adviser">Adviser</option>
            </select>
            <button
              type="submit"
              disabled={isLinking}
              className="min-h-[40px] px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center gap-1 cursor-pointer shrink-0"
            >
              {isLinking ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              <span>Link</span>
            </button>
          </div>
          {ownStudentShareCode && (
            <button
              type="button"
              onClick={() => setShareCodeInput(ownStudentShareCode)}
              className="text-[11px] text-blue-700 hover:underline font-medium cursor-pointer"
            >
              Use your own Student Share Code ({ownStudentShareCode}) to test tracking
            </button>
          )}
        </form>

        {linkError && (
          <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {linkError}
          </p>
        )}
        {linkMessage && (
          <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            {linkMessage}
          </p>
        )}
      </div>

      {/* Active SOS Priority Banner */}
      {sosRows.length > 0 && (
        <div className="px-5 pt-4 space-y-2">
          {sosRows.map((row) => (
            <div
              key={row.student.id}
              className="p-3.5 rounded-xl bg-red-50 border border-red-200 space-y-2.5"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-red-900">
                    SOS Alert: {row.student.studentName}
                  </p>
                  <p className="text-xs text-red-800 mt-0.5">
                    {row.commute?.sosNote || 'Emergency assistance requested.'}
                  </p>
                </div>
              </div>
              {row.commute && (
                <button
                  type="button"
                  disabled={isActionBusy}
                  onClick={() =>
                    void handleWatcherAction(
                      row.commute!,
                      feedsByCommuteId[row.commute!.id] || null,
                      'acknowledge_sos'
                    )
                  }
                  className="w-full min-h-[38px] px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold cursor-pointer"
                >
                  Acknowledge SOS Alert
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Home Arrival Notification Cards */}
      {arrivalAlerts.length > 0 && (
        <div className="px-5 pt-4 space-y-2">
          {arrivalAlerts.map((alert) => (
            <div
              key={alert.key}
              className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 space-y-2"
            >
              <div className="flex items-start justify-between gap-2.5">
                <button
                  type="button"
                  onClick={() => onSelectStudent(alert.studentId)}
                  className="flex items-start gap-2.5 text-left min-w-0 flex-1 cursor-pointer"
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-emerald-950">
                      Arrived Home: {alert.studentName}
                    </p>
                    <p className="text-xs text-emerald-800 mt-0.5 truncate">
                      {alert.homeAddress || 'Pinned Home Destination'} ·{' '}
                      <span className="font-mono">{formatTimeClock(alert.arrivedAtMs)}</span>
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => onDismissArrivalAlert(alert.key)}
                  aria-label={`Dismiss arrival notification for ${alert.studentName}`}
                  className="min-w-[32px] min-h-[32px] rounded-md text-emerald-700 hover:bg-emerald-100 flex items-center justify-center shrink-0 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Search & Status Filters */}
      {studentRows.length > 0 && (
        <div className="px-5 pt-4 space-y-2.5">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Filter students by name or section..."
              className="w-full min-h-[38px] pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-900"
            />
          </div>

          <div className="grid grid-cols-4 gap-1 p-1 bg-slate-100 rounded-lg">
            {(
              [
                { id: 'all', label: 'All' },
                { id: 'en_route', label: 'En Route' },
                { id: 'sos_alert', label: 'SOS' },
                { id: 'arrived_home', label: 'Arrived' },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id)}
                className={`min-h-[32px] text-[11px] font-semibold rounded-md transition-colors cursor-pointer ${
                  statusFilter === f.id
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Roster + Selected Student Details */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {studentRows.length === 0 ? (
          <div className="p-6 text-center border border-dashed border-slate-200 rounded-xl bg-slate-50/50 space-y-2">
            <UserPlus className="w-6 h-6 text-slate-400 mx-auto" />
            <p className="text-sm font-semibold text-slate-800">No students linked yet</p>
            <p className="text-xs text-slate-500 leading-relaxed">
              Ask a student for their Share Code from their WayHome profile to monitor their school-to-home commute in real time.
            </p>
          </div>
        ) : (
          <>
            {/* Roster List */}
            <ul className="divide-y divide-slate-200 border border-slate-200 rounded-xl bg-white overflow-hidden">
              {filteredRows.map(({ student, commute, effectiveStatus }) => {
                const meta = getStatusMeta(effectiveStatus);
                const isSelected = selectedRow?.student.id === student.id;
                const dist = commute?.distanceRemainingMeters ?? student.distanceRemainingMeters;
                const eta = commute?.etaMinutes ?? student.etaMinutes;

                return (
                  <li key={student.id}>
                    <button
                      type="button"
                      onClick={() => onSelectStudent(student.id)}
                      className={`w-full text-left px-4 py-3 min-h-[56px] transition-colors cursor-pointer flex items-center justify-between gap-3 ${
                        isSelected ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900 truncate">
                          {student.studentName}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5 truncate">
                          {student.gradeSection} · {student.schoolName}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`text-xs font-semibold ${meta.textClass}`}>
                          {meta.label}
                        </p>
                        {effectiveStatus === 'en_route' && (
                          <p className="text-[11px] font-mono text-slate-500 mt-0.5">
                            {formatDistance(dist)} · {formatEta(eta)}
                          </p>
                        )}
                        {effectiveStatus === 'arrived_home' && commute?.endedAtMs ? (
                          <p className="text-[11px] font-mono text-emerald-700 mt-0.5">
                            At {formatTimeClock(commute.endedAtMs)}
                          </p>
                        ) : null}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Selected Student Live Inspector */}
            {selectedRow && (
              <div className="space-y-4 pt-2 border-t border-slate-200">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">
                      {selectedRow.student.studentName} — Live Telemetry
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {selectedRow.student.gradeSection} · Linked as {selectedRow.link.watcherRelation}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void removeWatcherLink(selectedRow.link.id)}
                    className="text-xs text-slate-500 hover:text-red-700 font-medium cursor-pointer"
                  >
                    Unlink
                  </button>
                </div>

                <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/70 space-y-2.5 text-xs">
                  <div className="flex items-center gap-2 text-slate-700">
                    <School className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                    <span className="truncate">From: {selectedRow.student.schoolName}</span>
                  </div>
                  <div className="flex items-center gap-2 text-slate-700">
                    <Home className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
                    <span className="truncate">
                      To:{' '}
                      {selectedRow.student.hasHomePin
                        ? selectedRow.student.homeAddress || 'Pinned Home'
                        : 'Home not pinned yet'}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-200">
                    <div>
                      <p className="text-[11px] text-slate-500">Remaining</p>
                      <p className="font-mono text-sm font-semibold text-slate-900">
                        {formatDistance(
                          selectedRow.commute?.distanceRemainingMeters ??
                            selectedRow.student.distanceRemainingMeters
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-slate-500">ETA</p>
                      <p className="font-mono text-sm font-semibold text-slate-900">
                        {formatEta(
                          selectedRow.commute?.etaMinutes ?? selectedRow.student.etaMinutes
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-slate-500">Speed</p>
                      <p className="font-mono text-sm font-semibold text-slate-900">
                        {(
                          selectedRow.commute?.speedKmh ?? selectedRow.student.lastSpeedKmh
                        ).toFixed(1)}{' '}
                        km/h
                      </p>
                    </div>
                  </div>
                </div>

                {selectedRow.commute &&
                  (selectedRow.commute.status === 'en_route' ||
                    selectedRow.commute.status === 'sos_alert') && (
                    <button
                      type="button"
                      disabled={isActionBusy}
                      onClick={() =>
                        void handleWatcherAction(
                          selectedRow.commute!,
                          selectedFeed,
                          'safety_ping'
                        )
                      }
                      className="w-full min-h-[44px] px-4 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-900 text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <Bell className="w-4 h-4 text-blue-700" />
                      <span>Request Safety Check-In Ping</span>
                    </button>
                  )}

                {selectedRow.effectiveStatus === 'arrived_home' && (
                  <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold">
                        Arrived safely at pinned Home destination
                      </p>
                      {selectedRow.commute?.endedAtMs ? (
                        <p className="text-emerald-800 mt-0.5 font-mono text-[11px]">
                          Confirmed at {formatTimeClock(selectedRow.commute.endedAtMs)}
                        </p>
                      ) : null}
                    </div>
                  </div>
                )}

                <div>
                  <h4 className="text-xs font-bold text-slate-900 mb-2 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-blue-700" />
                    <span>Safety Timeline</span>
                  </h4>
                  <SafetyTimeline
                    events={selectedFeed?.events || []}
                    emptyMessage="Waiting for student to start their school-to-home commute."
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
