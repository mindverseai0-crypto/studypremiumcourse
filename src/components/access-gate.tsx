'use client';

// ============================================================================
// AccessGate — the 24h key gate for Study Bison.
// - On load: polls /api/access-key/status. If the gate is enabled and the
//   browser has no active key, the app is replaced by the gate screen.
// - "Get free access" mints a pending key (ARO-XXXX-…), shows it briefly,
//   then redirects to the VPLink ad-gateway (or straight to verify in
//   sandbox mode). Activation returns to /?verify=activated and the app
//   renders with a live countdown chip.
// One single useAccessKey instance lives in the provider; UI pieces consume
// it through context so there is exactly one poller per page.
// ============================================================================

import { createContext, useContext, useEffect, useState } from 'react';
import {
  BadgeCheck,
  Check,
  Clock3,
  Copy,
  KeyRound,
  Loader2,
  LogOut,
  MousePointerClick,
  RotateCw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { useAccessKey, type UseAccessKey } from '@/lib/use-access-key';

const AMBER = '#FFB800';
const DARK = '#111827';

function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AccessKeyContext = createContext<UseAccessKey | null>(null);

function useAccessKeyContext(): UseAccessKey {
  const ctx = useContext(AccessKeyContext);
  if (!ctx) throw new Error('useAccessKeyContext must be used within AccessGate');
  return ctx;
}

// ---------------------------------------------------------------------------
// Brand shell shared by gate states
// ---------------------------------------------------------------------------

function Logo({ size = 64 }: { size?: number }) {
  return (
    <img
      src="/logo-bison.png"
      alt="STUDY PREMIUM COURSE logo"
      width={size}
      height={size}
      className="rounded-2xl shadow-lg"
      style={{ width: size, height: size }}
    />
  );
}

function Splash() {
  return (
    <div
      className="fixed inset-0 z-[3000] flex flex-col items-center justify-center gap-4"
      style={{ background: `linear-gradient(160deg, ${DARK} 0%, #1F2937 100%)` }}
      role="status"
      aria-label="Checking access"
    >
      <Logo size={72} />
      <Loader2 className="h-6 w-6 animate-spin" style={{ color: AMBER }} aria-hidden />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gate screen (locked / minting)
// ---------------------------------------------------------------------------

const STEPS = [
  { icon: MousePointerClick, title: 'Tap "Get free access"', desc: 'We create your personal 24-hour key instantly.' },
  { icon: ShieldCheck, title: 'Complete one short ad step', desc: 'A brief sponsor page keeps Study Monkey free.' },
  { icon: BadgeCheck, title: 'You are back — activated', desc: 'Full access for 24 hours, bound to this browser.' },
];

function GateScreen() {
  const { status, generating, error, minted, verifyNotice, generate } = useAccessKeyContext();
  const [copied, setCopied] = useState(false);

  const copyKey = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable (permissions) — non-fatal
    }
  };

  return (
    <div
      className="flex min-h-screen w-full flex-col items-center justify-center px-4 py-10"
      style={{
        background: `radial-gradient(1000px 500px at 50% -10%, rgba(255,184,0,0.14), transparent 60%), linear-gradient(160deg, ${DARK} 0%, #1F2937 100%)`,
      }}
    >
      <main className="w-full max-w-md">
        {/* Brand */}
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Logo size={72} />
          <div>
            <div className="text-2xl font-extrabold tracking-tight text-white">
              STUDY <span style={{ color: AMBER }}>PREMIUM COURSE</span>
            </div>
            <div className="mt-1 text-sm text-gray-400">Your premium learning platform</div>
          </div>
        </div>

        {/* Card */}
        <section
          className="rounded-3xl border border-white/10 bg-white/[0.06] p-6 shadow-2xl backdrop-blur sm:p-8"
          aria-labelledby="gate-heading"
        >
          {!minted ? (
            <>
              <div className="mb-1 flex items-center justify-center gap-2">
                <KeyRound className="h-5 w-5" style={{ color: AMBER }} aria-hidden />
                <span className="text-xs font-bold uppercase tracking-widest" style={{ color: AMBER }}>
                  Free 24-hour access key
                </span>
              </div>
              <h1 id="gate-heading" className="text-center text-2xl font-extrabold text-white sm:text-[1.7rem]">
                Unlock everything for 24 hours
              </h1>
              <p className="mt-2 text-center text-sm leading-relaxed text-gray-400">
                All batches, lectures, notes, DPPs, tests and live classes — free for a full day. No sign-up, no payment.
              </p>

              {/* Steps */}
              <ol className="mt-6 space-y-3">
                {STEPS.map((step, i) => (
                  <li
                    key={step.title}
                    className="flex items-start gap-3 rounded-2xl border border-white/5 bg-white/[0.04] p-3"
                  >
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                      style={{ background: 'rgba(255,184,0,0.14)', color: AMBER }}
                      aria-hidden
                    >
                      <step.icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white">
                        <span className="mr-1.5" style={{ color: AMBER }}>
                          {i + 1}.
                        </span>
                        {step.title}
                      </div>
                      <div className="mt-0.5 text-xs leading-relaxed text-gray-400">{step.desc}</div>
                    </div>
                  </li>
                ))}
              </ol>

              {/* Verify notice from a failed return */}
              {verifyNotice === 'invalid_or_expired' && (
                <div
                  className="mt-5 flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-xs leading-relaxed text-red-200"
                  role="alert"
                >
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden />
                  <span>
                    Your activation link was invalid or expired. Generate a fresh key below and try again.
                  </span>
                </div>
              )}

              {/* Generate error */}
              {error && (
                <div
                  className="mt-5 flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-xs leading-relaxed text-red-200"
                  role="alert"
                >
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden />
                  <span>{error}</span>
                </div>
              )}

              {/* CTA */}
              <button
                type="button"
                onClick={generate}
                disabled={generating}
                className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-full text-base font-extrabold shadow-lg transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70"
                style={{ background: AMBER, color: DARK }}
              >
                {generating ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                    Creating your key…
                  </>
                ) : (
                  <>
                    <KeyRound className="h-5 w-5" aria-hidden />
                    Get free access
                  </>
                )}
              </button>

              <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-[11px] leading-relaxed text-gray-500">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
                One key per browser, bound to this device. When it expires, just get a new one.
                {status && !status.keyGenerationEnabled && ' Key generation is temporarily disabled.'}
              </p>
            </>
          ) : (
            /* ---------------- Minted key — redirecting ---------------- */
            <div className="text-center">
              <div
                className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl"
                style={{ background: 'rgba(255,184,0,0.14)', color: AMBER }}
                aria-hidden
              >
                <KeyRound className="h-7 w-7" />
              </div>
              <h1 className="text-xl font-extrabold text-white">Your 24-hour key is ready</h1>
              <p className="mt-1.5 text-sm text-gray-400">Keep it handy — it is bound to this browser.</p>

              <div
                className="mt-5 select-all rounded-2xl border border-dashed p-4 font-mono text-lg font-bold tracking-[0.18em]"
                style={{ borderColor: 'rgba(255,184,0,0.5)', background: 'rgba(255,184,0,0.07)', color: AMBER }}
                aria-label="Your access key"
              >
                {minted.key}
              </div>

              <button
                type="button"
                onClick={copyKey}
                className="mx-auto mt-3 flex items-center gap-1.5 rounded-full border border-white/15 px-4 py-1.5 text-xs font-semibold text-gray-300 transition-colors hover:bg-white/10"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                )}
                {copied ? 'Copied' : 'Copy key'}
              </button>

              <div className="mt-6 flex items-center justify-center gap-2 text-sm text-gray-300" role="status">
                <Loader2 className="h-4 w-4 animate-spin" style={{ color: AMBER }} aria-hidden />
                {minted.mode === 'vplink' ? 'Taking you to complete the ad step…' : 'Completing activation…'}
              </div>

              {minted.mode === 'direct' && (
                <p className="mt-3 rounded-xl border border-white/10 bg-white/[0.04] p-2.5 text-[11px] leading-relaxed text-gray-500">
                  Sandbox mode: no public site URL configured, so the ad-gateway step is skipped and activation finishes
                  directly on this origin. All security checks still apply.
                </p>
              )}

              <div className="mt-6 h-1 w-full overflow-hidden rounded-full bg-white/10">
                <div className="h-full w-1/3 animate-pulse rounded-full" style={{ background: AMBER }} />
              </div>
            </div>
          )}
        </section>

        <p className="mt-6 text-center text-[11px] text-gray-500">
          Keys are signed and expire automatically after 24 hours. STUDY PREMIUM COURSE never stores your data.
        </p>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Countdown chip (visible while the app is unlocked)
// ---------------------------------------------------------------------------

function KeyChip() {
  const { status, timeLeft, clear, refresh } = useAccessKeyContext();
  const [confirming, setConfirming] = useState(false);

  if (!status?.hasKey) return null;

  return (
    <div
      className="fixed bottom-3 right-3 z-[1400] flex items-center gap-2 rounded-full border border-black/10 py-1.5 pl-3 pr-1.5 shadow-xl sm:bottom-4 sm:right-4"
      style={{ background: DARK, color: '#fff' }}
      role="status"
      aria-label="Access key countdown"
    >
      <KeyRound className="h-3.5 w-3.5 shrink-0" style={{ color: AMBER }} aria-hidden />
      <span className="max-w-[86px] truncate font-mono text-[11px] font-bold tracking-wider sm:max-w-none">
        {status.key}
      </span>
      <span className="h-3.5 w-px bg-white/20" aria-hidden />
      <span className="flex items-center gap-1 font-mono text-[11px] font-bold" style={{ color: AMBER }}>
        <Clock3 className="h-3 w-3" aria-hidden />
        {timeLeft !== null ? formatCountdown(timeLeft) : '…'}
      </span>
      {confirming ? (
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={clear}
            className="rounded-full bg-red-500/90 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-red-500"
            aria-label="Confirm remove key"
          >
            Remove
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-bold text-gray-200 hover:bg-white/20"
            aria-label="Keep key"
          >
            Keep
          </button>
        </span>
      ) : (
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={refresh}
            className="rounded-full bg-white/10 px-2 py-1 text-[10px] font-bold text-gray-200 hover:bg-white/20"
            title="Refresh key status"
            aria-label="Refresh key status"
          >
            <RotateCw className="h-3 w-3" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-bold text-gray-200 hover:bg-white/20"
            title="Remove key (logout)"
            aria-label="Remove key"
          >
            <LogOut className="h-3 w-3" aria-hidden />
            <span className="hidden sm:inline">Exit</span>
          </button>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activated banner (brief success flash after returning from verify)
// ---------------------------------------------------------------------------

function ActivatedBanner() {
  const { verifyNotice, dismissNotice } = useAccessKeyContext();

  // banner visibility is DERIVED from verifyNotice; the effect only schedules
  // the auto-dismiss (async, allowed) — no setState in the effect body.
  useEffect(() => {
    if (verifyNotice === 'activated') {
      const t = setTimeout(() => dismissNotice(), 5000);
      return () => clearTimeout(t);
    }
  }, [verifyNotice, dismissNotice]);

  if (verifyNotice !== 'activated') return null;

  return (
    <div
      className="fixed left-1/2 top-16 z-[2400] flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm font-bold shadow-2xl"
      style={{ background: DARK, color: '#fff', border: `1px solid ${AMBER}` }}
      role="status"
    >
      <BadgeCheck className="h-4 w-4" style={{ color: AMBER }} aria-hidden />
      Access activated — enjoy your 24 hours!
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gate wrapper (owns the single hook instance via context)
// ---------------------------------------------------------------------------

export default function AccessGate({ children }: { children: React.ReactNode }) {
  const access = useAccessKey();
  const { status, initialLoading } = access;

  const unlocked = !!status?.hasKey;
  const gateActive = initialLoading || !status || status.gateEnabled !== false;

  let content: React.ReactNode;
  if (!gateActive) {
    content = <>{children}</>; // admin disabled the gate entirely
  } else if (initialLoading || !status) {
    content = <Splash />;
  } else if (!unlocked) {
    content = <GateScreen />;
  } else {
    content = (
      <>
        <ActivatedBanner />
        {children}
        <KeyChip />
      </>
    );
  }

  return <AccessKeyContext.Provider value={access}>{content}</AccessKeyContext.Provider>;
}
