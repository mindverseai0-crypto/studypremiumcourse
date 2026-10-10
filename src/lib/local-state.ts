'use client';

import { useCallback, useEffect, useState } from 'react';

const XP_KEY = 'studypro_xp';
const ENROLLED_KEY = 'studypro_enrolled_batches';
const WATCHED_KEY = 'studypro_watched_videos';

function getArray(key: string): string[] {
  if (typeof window === 'undefined') return [];

  try {
    const value = localStorage.getItem(key);
    if (!value) return [];

    const data = JSON.parse(value);
    return Array.isArray(data)
      ? data.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function saveArray(key: string, value: string[]) {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage errors
  }
}

export function addXP(amount: number, _reason?: string) {
  if (typeof window === 'undefined') return;

  try {
    const current = Number(localStorage.getItem(XP_KEY) || '0');
    localStorage.setItem(XP_KEY, String(current + amount));

    window.dispatchEvent(new Event('studypro-xp-change'));
  } catch {
    // Ignore storage errors
  }
}

export function useXP() {
  const [xp, setXP] = useState(0);

  useEffect(() => {
    const load = () => {
      try {
        setXP(Number(localStorage.getItem(XP_KEY) || '0'));
      } catch {
        setXP(0);
      }
    };

    load();

    window.addEventListener('studypro-xp-change', load);
    window.addEventListener('storage', load);

    return () => {
      window.removeEventListener('studypro-xp-change', load);
      window.removeEventListener('storage', load);
    };
  }, []);

  return xp;
}

export function useEnrolledBatches() {
  const [enrolled, setEnrolled] = useState<string[]>([]);

  useEffect(() => {
    setEnrolled(getArray(ENROLLED_KEY));

    const onStorage = () => {
      setEnrolled(getArray(ENROLLED_KEY));
    };

    window.addEventListener('storage', onStorage);

    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const enroll = useCallback((batchId: string) => {
    setEnrolled((current) => {
      if (current.includes(batchId)) return current;

      const next = [...current, batchId];
      saveArray(ENROLLED_KEY, next);
      return next;
    });
  }, []);

  const unenroll = useCallback((batchId: string) => {
    setEnrolled((current) => {
      const next = current.filter((id) => id !== batchId);
      saveArray(ENROLLED_KEY, next);
      return next;
    });
  }, []);

  return { enrolled, enroll, unenroll };
}

export function useWatchedVideos() {
  const [watched, setWatched] = useState<string[]>([]);

  useEffect(() => {
    setWatched(getArray(WATCHED_KEY));

    const onStorage = () => {
      setWatched(getArray(WATCHED_KEY));
    };

    window.addEventListener('storage', onStorage);

    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const toggleWatched = useCallback((videoId: string): boolean => {
    const current = getArray(WATCHED_KEY);

    if (current.includes(videoId)) {
      const next = current.filter((id) => id !== videoId);
      saveArray(WATCHED_KEY, next);
      setWatched(next);
      return false;
    }

    const next = [...current, videoId];
    saveArray(WATCHED_KEY, next);
    setWatched(next);
    return true;
  }, []);

  return { watched, toggleWatched };
}
