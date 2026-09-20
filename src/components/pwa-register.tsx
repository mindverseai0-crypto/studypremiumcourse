'use client';

// Registers the Study Bison service worker (offline app shell + lecture
// library) and requests persistent storage so downloaded lectures are never
// auto-evicted by the browser.

import { useEffect } from 'react';

export default function PWARegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const register = () => {
      if (!('serviceWorker' in navigator)) return;
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        /* insecure context or blocked — the app still works online */
      });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register);

    // request durable storage so downloads are never auto-evicted
    const t = setTimeout(() => {
      try {
        if (navigator.storage && navigator.storage.persist) void navigator.storage.persist();
      } catch {
        /* ignore */
      }
    }, 4000);

    return () => {
      window.removeEventListener('load', register);
      clearTimeout(t);
    };
  }, []);

  return null;
}
