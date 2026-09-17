'use client';

// ============================================================================
// useAccessKey — client-side status polling + countdown + generate/clear for
// the 24h access-key system. The server's signed cookie is the single source
// of truth; the hook only reflects /api/access-key/* responses.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';

export interface AccessKeyStatus {
  ok: boolean;
  hasKey: boolean;
  key: string | null;
  isPermanent: boolean;
  expires: string | null;
  timeLeft: number | null;
  gateEnabled: boolean;
  keyGenerationEnabled: boolean;
}

export interface MintedKey {
  key: string;
  expiresAt: string;
  vplinkUrl: string;
  mode: 'vplink' | 'direct';
  devNote?: string;
}

const RETURN_TO_KEY = 'sb_access_return_to';

export interface UseAccessKey {
  status: AccessKeyStatus | null;
  initialLoading: boolean;
  generating: boolean;
  error: string | null;
  minted: MintedKey | null;
  timeLeft: number | null;
  verifyNotice: 'activated' | 'invalid_or_expired' | null;
  generate: () => Promise<void>;
  clear: () => Promise<void>;
  dismissNotice: () => void;
  refresh: () => Promise<void>;
}

export function useAccessKey(): UseAccessKey {
  const [status, setStatus] = useState<AccessKeyStatus | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [verifyNotice, setVerifyNotice] = useState<'activated' | 'invalid_or_expired' | null>(null);

  const timeLeftRef = useRef<number | null>(null);
  timeLeftRef.current = timeLeft;

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/access-key/status', { cache: 'no-store' });
      const data: AccessKeyStatus = await res.json();
      if (data?.ok) {
        setStatus(data);
        setTimeLeft(typeof data.timeLeft === 'number' ? data.timeLeft : null);
        // if a key became active while we were showing the gate, drop notices
        if (data.hasKey) setVerifyNotice(null);
      }
    } catch {
      // network hiccup — keep previous state, next poll will retry
    } finally {
      setInitialLoading(false);
    }
  }, []);

  // Mount: handle ?verify=... return param, then poll status.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const v = sp.get('verify');
    if (v === 'activated' || v === 'invalid_or_expired') {
      setVerifyNotice(v);
      // Sub-page gating: come back to where the user started (same-origin only).
      const returnTo = window.sessionStorage.getItem(RETURN_TO_KEY);
      window.sessionStorage.removeItem(RETURN_TO_KEY);
      if (v === 'activated' && returnTo && returnTo.startsWith('/') && returnTo !== window.location.pathname + window.location.search) {
        window.location.replace(returnTo);
        return;
      }
      sp.delete('verify');
      const qs = sp.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
    poll();
  }, [poll]);

  // 1s countdown tick; hits 0 → re-poll (gate again, per spec).
  useEffect(() => {
    const iv = setInterval(() => {
      const t = timeLeftRef.current;
      if (t === null) return;
      if (t <= 1) {
        timeLeftRef.current = 0;
        setTimeLeft(0);
        poll();
      } else {
        timeLeftRef.current = t - 1;
        setTimeLeft(t - 1);
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [poll]);

  // Periodic server re-sync (picks up external clears / multi-tab changes).
  useEffect(() => {
    const iv = setInterval(poll, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll]);

  const generate = useCallback(async () => {
    setError(null);
    setGenerating(true);
    try {
      const res = await fetch('/api/access-key/generate', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || 'Could not start key generation. Please retry.');
        setGenerating(false);
        return;
      }
      setMinted({
        key: data.key,
        expiresAt: data.expiresAt,
        vplinkUrl: data.vplinkUrl,
        mode: data.mode,
        devNote: data.devNote,
      });
      // remember where to return to after activation (sub-page gating)
      const here = window.location.pathname + window.location.search;
      if (here !== '/') window.sessionStorage.setItem(RETURN_TO_KEY, here);
      // brief beat so the user sees their key, then send them off
      setTimeout(() => {
        window.location.href = data.vplinkUrl;
      }, 1800);
    } catch {
      setError('Network error — please check your connection and retry.');
      setGenerating(false);
    }
  }, []);

  const clear = useCallback(async () => {
    try {
      await fetch('/api/access-key/clear', { method: 'POST' });
    } catch {
      // ignore — poll will reflect reality
    }
    setMinted(null);
    setError(null);
    poll();
  }, [poll]);

  const dismissNotice = useCallback(() => setVerifyNotice(null), []);

  return {
    status,
    initialLoading,
    generating,
    error,
    minted,
    timeLeft,
    verifyNotice,
    generate,
    clear,
    dismissNotice,
    refresh: poll,
  };
}
