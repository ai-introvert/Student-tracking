import React, { useState } from 'react';
import { ShieldCheck, MapPin, Navigation, Users, ArrowRight, Loader2 } from 'lucide-react';
import campusWalkwayImg from '../assets/images/campus_dismissal_walkway_1794790925818.jpg';
import { PWAInstallButton } from './PWAInstallButton';

interface AuthLandingProps {
  onSignIn: () => Promise<void>;
  isSigningIn: boolean;
  authError: string | null;
}

export const AuthLanding: React.FC<AuthLandingProps> = ({
  onSignIn,
  isSigningIn,
  authError,
}) => {
  const [imgError, setImgError] = useState(false);

  return (
    <div className="min-h-[calc(100vh-65px)] bg-slate-50 flex flex-col justify-center">
      <div className="max-w-7xl mx-auto w-full px-6 py-10 lg:py-16">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-stretch">
          {/* Left Column: Value Proposition & Sign In */}
          <div className="lg:col-span-6 flex flex-col justify-between bg-white border border-slate-200 rounded-2xl p-8 lg:p-10">
            <div>
              <p className="text-xs font-semibold tracking-wide text-blue-700">
                School-to-Home Safety Network
              </p>
              <h1 className="mt-3 text-3xl sm:text-4xl lg:text-[42px] font-bold tracking-tight text-slate-900 leading-[1.15] [text-wrap:balance]">
                Every student commute from campus to home, accounted for in real time.
              </h1>
              <p className="mt-4 text-base text-slate-600 leading-relaxed max-w-xl">
                Students pin their exact home destination on the map and share live movement when leaving school. Parents and faculty advisers follow progress, receive check-ins, and respond to alerts without guesswork.
              </p>

              <div className="mt-8 space-y-4 border-t border-slate-100 pt-6">
                <div className="flex items-start gap-3.5">
                  <div className="w-9 h-9 rounded-lg bg-slate-100 text-slate-800 flex items-center justify-center shrink-0">
                    <MapPin className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">
                      Pin Home &amp; 100m Arrival Zone
                    </h2>
                    <p className="text-sm text-slate-600 mt-0.5">
                      Search your street address or tap directly on the map to set your home pin and school origin.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3.5">
                  <div className="w-9 h-9 rounded-lg bg-slate-100 text-slate-800 flex items-center justify-center shrink-0">
                    <Navigation className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">
                      Live GPS Route &amp; ETA Telemetry
                    </h2>
                    <p className="text-sm text-slate-600 mt-0.5">
                      Real-time location breadcrumbs, speed, and Google Maps route ETA streamed securely during dismissal.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3.5">
                  <div className="w-9 h-9 rounded-lg bg-slate-100 text-slate-800 flex items-center justify-center shrink-0">
                    <Users className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">
                      Parent &amp; Faculty Adviser Oversight
                    </h2>
                    <p className="text-sm text-slate-600 mt-0.5">
                      Authorize trusted guardians and advisers with revocable share codes, safety pings, and SOS alerts.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-8 pt-6 border-t border-slate-100">
              {authError && (
                <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">
                  {authError}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void onSignIn()}
                  disabled={isSigningIn}
                  className="w-full sm:w-auto min-h-[48px] px-6 py-3 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-sm font-semibold inline-flex items-center justify-center gap-2.5 transition-colors cursor-pointer"
                >
                  {isSigningIn ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Signing in...</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4" />
                      <span>Continue with Google</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>

                <PWAInstallButton />
              </div>

              <p className="mt-3 text-xs text-slate-500">
                Sign in with your Google account to configure a Student, Parent, or Faculty Adviser workspace.
              </p>
            </div>
          </div>

          {/* Right Column: Editorial Campus Visual */}
          <div className="lg:col-span-6 relative rounded-2xl overflow-hidden border border-slate-200 bg-slate-900 min-h-[340px] lg:min-h-full">
            {!imgError ? (
              <img
                src={campusWalkwayImg}
                alt="Sunlit pedestrian walkway outside a modern high school campus during afternoon dismissal"
                referrerPolicy="no-referrer"
                onError={() => setImgError(true)}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-slate-800 via-slate-900 to-blue-950 p-10 text-center">
                <ShieldCheck className="w-12 h-12 text-blue-400 mb-3" />
                <p className="text-base font-semibold text-white">WayHome Commute Safety</p>
                <p className="text-sm text-slate-300 mt-1">Real-time student dismissal monitoring</p>
              </div>
            )}

            <div className="absolute inset-0 bg-gradient-to-t from-slate-950/85 via-slate-950/25 to-transparent" />

            <div className="absolute bottom-0 left-0 right-0 p-6 sm:p-8 text-white">
              <p className="text-xs font-medium text-blue-200">
                Verified Dismissal Tracking · Revocable Consent
              </p>
              <p className="mt-1.5 text-lg sm:text-xl font-semibold leading-snug max-w-lg">
                Students stay in control of their Home Pin and live location sharing while families and advisers gain peace of mind.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
