/* ============================================================================
   Study Bison service worker — PWA app shell + offline lecture library.

   - App shell: precaches '/', '/player' + icons so the app boots offline;
     navigations are network-first with a cache fallback.
   - Static assets (/​_next/static/*, icons, avatar DPs): cache-first runtime.
   - Downloaded lectures: every part the downloader stored lives in a dedicated
     per-lecture cache (`sb-video-<folder>`). Any request for a media folder
     with such a cache is served cache-first (exact URL match, then
     path-only match so re-signed URLs still hit) — online OR offline.
     Requests for folders with no cache are passed straight to the network.
   ============================================================================ */

const SHELL = 'sb-shell-v2';
const RUNTIME = 'sb-runtime-v2';
const SHELL_URLS = [
  '/',
  '/player',
  '/manifest.webmanifest',
  '/logo-bison.png',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
];
const RUNTIME_LIMIT = 200;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await Promise.allSettled(
        SHELL_URLS.map((u) => cache.add(new Request(u, { cache: 'reload' }))),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.map((n) => {
          // keep the current shell + runtime + every user's offline lecture
          if (n === SHELL || n === RUNTIME || n.startsWith('sb-video-')) return undefined;
          return caches.delete(n);
        }),
      );
      await self.clients.claim();
    })(),
  );
});

/** Which lecture folder does this media URL belong to (if any)? */
function videoFolder(url) {
  try {
    if (url.origin === self.location.origin) {
      // /api/pw/<folder>/… | /api/pw/h/<host>/<folder>/… | /api/pw/<folder>/s/<sig>/…
      const m = url.pathname.match(/^\/api\/pw\/(?:h\/[^/]+\/)?([^/]+)\//);
      return m ? m[1] : null;
    }
    if (/\.cloudfront\.net$/i.test(url.hostname)) {
      const m = url.pathname.match(/^\/([^/]+)\//);
      return m ? m[1] : null;
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

const MEDIA_EXT = /\.(m3u8|mpd|ts|m4s|mp4|m4a|m4v|webm|aac|key|cmfv|cmfa)$/i;

/** Exact match first, then match ignoring the query string. */
async function matchLoose(cache, request) {
  const exact = await cache.match(request);
  if (exact) return exact;
  let path;
  try {
    path = new URL(request.url).pathname;
  } catch (_) {
    return null;
  }
  const keys = await cache.keys();
  for (const key of keys) {
    try {
      if (new URL(key.url).pathname === path) return await cache.match(key);
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

function offlineMiss(message) {
  return new Response(
    JSON.stringify({ success: false, error: message }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }

  // ---- 1. downloaded lecture media (relay + CloudFront) ----
  const folder = videoFolder(url);
  if (folder) {
    event.respondWith(
      (async () => {
        const name = 'sb-video-' + folder;
        if (!(await caches.has(name))) {
          // not a downloaded lecture — pure passthrough
          if (!self.navigator.onLine) return offlineMiss('Offline: this lecture is not downloaded.');
          return fetch(req);
        }
        const cache = await caches.open(name);
        const hit = await matchLoose(cache, req);
        if (hit) {
          const headers = new Headers(hit.headers);
          headers.set('X-SB-Offline', 'hit');
          return new Response(hit.body, {
            status: hit.status,
            statusText: hit.statusText,
            headers,
          });
        }
        if (!self.navigator.onLine) return offlineMiss('Offline: this part of the lecture is not downloaded.');
        return fetch(req);
      })(),
    );
    return;
  }

  // ---- 1b. media files without a folder-shaped path (direct HLS/mp4 URLs) —
  //         try every offline-lecture cache before touching the network ----
  if (url.origin === self.location.origin && MEDIA_EXT.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const names = (await caches.keys()).filter((n) => n.startsWith('sb-video-'));
        for (const name of names) {
          const cache = await caches.open(name);
          const hit = await matchLoose(cache, req);
          if (hit) {
            const headers = new Headers(hit.headers);
            headers.set('X-SB-Offline', 'hit');
            return new Response(hit.body, {
              status: hit.status,
              statusText: hit.statusText,
              headers,
            });
          }
        }
        if (!self.navigator.onLine) return offlineMiss('Offline: this lecture is not downloaded.');
        return fetch(req);
      })(),
    );
    return;
  }

  if (url.origin !== self.location.origin) return; // other hosts: browser default

  // ---- 2. navigations: network-first, fall back to the cache ----
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          try {
            const cache = await caches.open(SHELL);
            await cache.put(req, fresh.clone());
          } catch (_) {
            /* ignore */
          }
          return fresh;
        } catch (_) {
          // Same page (any query) or the precached app shell.
          const cached =
            (await caches.match(req)) ||
            (await caches.match(req, { ignoreSearch: true })) ||
            (await caches.match('/'));
          if (cached) return cached;
          return offlineMiss('You are offline.');
        }
      })(),
    );
    return;
  }

  // ---- 3. static assets + bot avatar DPs: network-first (fresh in dev,
  //         cached fallback offline) ----
  const p = url.pathname;
  const isStatic =
    p.startsWith('/_next/static/') ||
    p === '/logo-bison.png' ||
    p === '/logo.svg' ||
    p.startsWith('/pwa-icon-') ||
    p === '/favicon.ico';
  const isAvatar = p.startsWith('/api/avatar');
  if (isStatic || isAvatar) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME);
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) {
            const keys = await cache.keys();
            if (keys.length >= RUNTIME_LIMIT) await cache.delete(keys[0]);
            await cache.put(req, fresh.clone());
          }
          return fresh;
        } catch (_) {
          const hit = await cache.match(req);
          return hit || new Response('', { status: 504 });
        }
      })(),
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
