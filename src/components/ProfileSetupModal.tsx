import React, { useState } from 'react';
import { GraduationCap, HeartHandshake, Shield, Loader2 } from 'lucide-react';
import { ViewMode } from '../types/wayhome';

interface ProfileSetupModalProps {
  defaultName: string;
  email: string;
  onComplete: (data: {
    displayName: string;
    viewMode: ViewMode;
    sectionName: string;
  }) => Promise<void>;
}

const ROLE_OPTIONS: Array<{
  mode: ViewMode;
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    mode: 'student',
    title: 'Student',
    subtitle: 'Pin your home location and share live movement when leaving school.',
    icon: GraduationCap,
  },
  {
    mode: 'parent',
    title: 'Parent / Guardian',
    subtitle: 'Track your child’s commute in real time and receive arrival or SOS alerts.',
    icon: HeartHandshake,
  },
  {
    mode: 'adviser',
    title: 'Faculty Adviser',
    subtitle: 'Monitor advisory students heading home after dismissal.',
    icon: Shield,
  },
];

export const ProfileSetupModal: React.FC<ProfileSetupModalProps> = ({
  defaultName,
  email,
  onComplete,
}) => {
  const [displayName, setDisplayName] = useState(defaultName);
  const [viewMode, setViewMode] = useState<ViewMode>('student');
  const [sectionName, setSectionName] = useState('Grade 10 - Section A');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) {
      setError('Please enter your name.');
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await onComplete({
        displayName: displayName.trim(),
        viewMode,
        sectionName: sectionName.trim(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save profile.');
      setIsSaving(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-65px)] bg-slate-50 flex items-center justify-center p-6">
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="w-full max-w-xl bg-white border border-slate-200 rounded-2xl p-8"
      >
        <p className="text-xs font-semibold text-blue-700">Account Setup</p>
        <h1 className="mt-1.5 text-2xl font-bold text-slate-900">
          Choose your primary WayHome role
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Signed in as <span className="font-medium text-slate-800">{email}</span>. You can switch workspace views anytime.
        </p>

        <div className="mt-6 grid grid-cols-1 gap-3">
          {ROLE_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const selected = viewMode === opt.mode;
            return (
              <button
                key={opt.mode}
                type="button"
                onClick={() => setViewMode(opt.mode)}
                className={`w-full text-left p-4 rounded-xl border transition-colors flex items-start gap-3.5 cursor-pointer ${
                  selected
                    ? 'border-blue-700 bg-blue-50/50 ring-2 ring-blue-700/15'
                    : 'border-slate-200 bg-white hover:bg-slate-50'
                }`}
              >
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                    selected ? 'bg-blue-700 text-white' : 'bg-slate-100 text-slate-700'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">{opt.title}</p>
                  <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">{opt.subtitle}</p>
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Full Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={80}
              required
              className="w-full min-h-[44px] px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              {viewMode === 'parent' ? 'Family Note / Label' : 'Grade / Advisory Section'}
            </label>
            <input
              type="text"
              value={sectionName}
              onChange={(e) => setSectionName(e.target.value)}
              maxLength={60}
              placeholder="e.g. Grade 10 - Einstein"
              className="w-full min-h-[44px] px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700/20 focus:border-blue-700"
            />
          </div>
        </div>

        {error && (
          <p className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={isSaving}
          className="mt-6 w-full min-h-[48px] px-6 py-3 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer"
        >
          {isSaving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Setting up workspace...</span>
            </>
          ) : (
            <span>Enter WayHome Workspace</span>
          )}
        </button>
      </form>
    </div>
  );
};
