import React from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  MapPin,
  Navigation,
  ShieldCheck,
} from 'lucide-react';
import { SafetyEvent } from '../types/wayhome';
import { formatTimeClock } from '../lib/geo';

interface SafetyTimelineProps {
  events: SafetyEvent[];
  emptyMessage?: string;
}

export const SafetyTimeline: React.FC<SafetyTimelineProps> = ({
  events,
  emptyMessage = 'No commute safety events recorded yet.',
}) => {
  if (events.length === 0) {
    return (
      <div className="py-6 text-center border border-dashed border-slate-200 rounded-xl bg-slate-50/50">
        <p className="text-xs text-slate-500">{emptyMessage}</p>
      </div>
    );
  }

  const sorted = [...events].sort((a, b) => b.tsMs - a.tsMs);

  return (
    <ul className="divide-y divide-slate-100">
      {sorted.map((evt) => {
        let Icon = Navigation;
        let iconStyle = 'bg-slate-100 text-slate-700';

        if (evt.type === 'sos_triggered') {
          Icon = AlertTriangle;
          iconStyle = 'bg-red-50 text-red-700';
        } else if (evt.type === 'arrived_home' || evt.type === 'sos_resolved') {
          Icon = CheckCircle2;
          iconStyle = 'bg-emerald-50 text-emerald-700';
        } else if (evt.type === 'checkpoint') {
          Icon = ShieldCheck;
          iconStyle = 'bg-blue-50 text-blue-700';
        } else if (evt.type === 'safety_ping') {
          Icon = Bell;
          iconStyle = 'bg-amber-50 text-amber-700';
        } else if (evt.type === 'departed_school') {
          Icon = MapPin;
          iconStyle = 'bg-slate-900 text-white';
        }

        return (
          <li key={evt.id} className="py-3 flex items-start gap-3">
            <div
              className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${iconStyle}`}
            >
              <Icon className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-slate-900 leading-snug">
                {evt.message}
              </p>
              <p className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
                {formatTimeClock(evt.tsMs)} · {evt.actorName} ({evt.actorRole})
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
};
