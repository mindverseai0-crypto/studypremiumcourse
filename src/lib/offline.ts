// ============================================================================
// Study Bison — offline lecture library (PWA downloads).
//
// YouTube-style "Available offline": every lecture can be downloaded once and
// then watched with the network fully off. Media bytes live in the Cache API
// (one cache per lecture folder: `sb-video-<folder>`) and are served by the
// service worker (public/sw.js) even when the device is offline.
//
// Flow:
//   1. The player resolves the playable relay URL (/api/pw/<folder>/s/<sig>/…)
//      — all segment URIs are same-origin and signed statelessly in the PATH,
//      so they stay byte-identical between download time and offline playback.
//   2. collectParts() walks the manifest (shaka headless for DASH, a text
//      parser for HLS) and returns the full part list for ONE good quality.
//   3. startDownload() fetches every part (concurrency 4, resume-safe) and
//      cache.put()s it into the lecture cache. Progress is persisted in
//      IndexedDB so downloads survive reloads and can be paused/resumed.
//   4. Offline the player finds the stored record, re-uses the stored
//      manifest URL + ClearKeys and the SW serves every byte from the cache.
//
// There is no artificial cap on the number of downloads — the only limit is
// the device's own storage quota (we also request persistent storage so the
// browser's janitor does not evict lectures).
// ============================================================================

export type SbDownloadStatus = 'collecting' | 'downloading' | 'paused' | 'done' | 'error';

/** One lecture document (class note / DPP PDF) saved with the lecture.
 *  `url` is the SAME-ORIGIN relay URL (/api/pw-doc?u=…) — it doubles as the
 *  Cache-API key and the offline playback URL (served by the service worker). */
export interface SbDoc {
  name: string;
  kind: 'note' | 'dpp';
  url: string;
}

/** One offline lecture. Persisted in IndexedDB store `downloads`. */
export interface SbDownload {
  id: string; // stable lecture id (videoId || realVideoId || 'url:<path>')
  title: string;
  batchName: string;
  batchId: string;
  subjectId: string;
  schId: string;
  realVideoId: string;
  vUrl: string; // raw `vUrl` player param (to rebuild the online player URL)
  kind: 'dash' | 'hls' | 'mp4';
  /** URL the OFFLINE player should open (dash master / hls variant / mp4). */
  url: string;
  clearKeys: Record<string, string> | null; // DASH ClearKey (kid -> key)
  poster: string;
  folder: string; // media folder id — cache name is `sb-video-<folder>`
  height: number | null; // downloaded video rendition height (null = audio-only/mp4)
  parts: string[]; // absolute part URLs (manifest first) — NOT persisted (rebuilt on resume)
  partsTotal: number; // persisted count for % display (parts array is stripped on save)
  partsDone: number;
  /** Notes + DPP PDFs bundled with this lecture (persisted). */
  docs?: SbDoc[];
  docsDone?: number;
  sizeBytes: number;
  status: SbDownloadStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DownloadStartSpec {
  id: string;
  title: string;
  batchName: string;
  batchId: string;
  subjectId: string;
  schId: string;
  realVideoId: string;
  vUrl: string;
  kind: 'dash' | 'hls' | 'mp4';
  url: string;
  clearKeys: Record<string, string> | null;
  poster: string;
  /** Notes + DPP PDFs to bundle with the lecture (relay URLs). */
  docs?: SbDoc[];
}

const DB_NAME = 'sb-offline';
const DB_VERSION = 1;
const STORE = 'downloads';
const CHANGE_EVENT = 'sb-downloads-changed';

export function videoCacheName(folder: string): string {
  return `sb-video-${folder}`;
}

/** Extract the media folder id from a relay/CloudFront media URL. */
export function folderFromMediaUrl(url: string): string {
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.href : 'https://x.invalid');
    if (u.origin === location.origin) {
      // /api/pw/<folder>/…  |  /api/pw/h/<host>/<folder>/…  |  /api/pw/<folder>/s/<sig>/…
      const m = u.pathname.match(/^\/api\/pw\/(?:h\/[^/]+\/)?([^/]+)\//);
      return m ? m[1] : '';
    }
    if (/\.cloudfront\.net$/i.test(u.hostname)) {
      const m = u.pathname.match(/^\/([^/]+)\//);
      return m ? m[1] : '';
    }
  } catch {
    /* ignore */
  }
  return '';
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
    } catch (e) {
      reject(e instanceof Error ? e : new Error('IndexedDB unavailable'));
    }
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB error'));
  });
}

function notifyChange() {
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    /* ignore */
  }
}

/** Subscribe to download-library changes. Returns an unsubscribe fn. */
export function subscribeDownloads(cb: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export async function listDownloads(): Promise<SbDownload[]> {
  try {
    const all = await tx<SbDownload[]>('readonly', (s) => s.getAll() as IDBRequest<SbDownload[]>);
    return (all || []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch {
    return [];
  }
}

export async function getDownload(id: string): Promise<SbDownload | null> {
  try {
    const rec = await tx<SbDownload | undefined>('readonly', (s) => s.get(id) as IDBRequest<SbDownload | undefined>);
    return rec || null;
  } catch {
    return null;
  }
}

async function putDownload(rec: SbDownload): Promise<void> {
  rec.updatedAt = new Date().toISOString();
  // Persist WITHOUT the parts array: a 2-hour lecture carries thousands of
  // ~100-char URLs (~0.5MB per save × every 5 parts ≈ 100s of MB of IndexedDB
  // writes per download — a real throughput killer). The part list lives in
  // memory while running and is re-collected from the stored manifest on
  // resume (same sig → same URIs → cached parts still match).
  const slim: SbDownload = { ...rec, parts: [] };
  await tx('readwrite', (s) => s.put(slim) as IDBRequest<IDBValidKey>);
}

// ---------------------------------------------------------------------------
// Change lookup / storage
// ---------------------------------------------------------------------------

/** Find the download record matching a lecture (by id candidates or vUrl). */
export async function findDownloadFor(ids: {
  videoId?: string;
  realVideoId?: string;
  vUrl?: string;
}): Promise<SbDownload | null> {
  const cands = new Set<string>();
  if (ids.videoId) cands.add(ids.videoId);
  if (ids.realVideoId) cands.add(ids.realVideoId);
  if (ids.vUrl) {
    cands.add(`url:${ids.vUrl.split('?')[0]}`);
    cands.add(ids.vUrl);
  }
  if (cands.size === 0) return null;
  const all = await listDownloads();
  for (const rec of all) {
    if (cands.has(rec.id) || (ids.vUrl && rec.vUrl && rec.vUrl === ids.vUrl)) return rec;
  }
  return null;
}

/** Rough storage usage of the whole origin (all caches + IDB). */
export async function estimateOfflineStorage(): Promise<{ usage: number; quota: number }> {
  try {
    const est = await navigator.storage.estimate();
    return { usage: est.usage || 0, quota: est.quota || 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

/** Ask the browser to keep our storage (no auto eviction). Best-effort. */
export async function ensurePersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch {
    /* ignore */
  }
  return false;
}

// ---------------------------------------------------------------------------
// Manifest → part list
// ---------------------------------------------------------------------------

export interface CollectedParts {
  parts: string[];
  height: number | null;
  /** What the OFFLINE player should open. */
  playbackUrl: string;
}

function uniqKeepOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of items) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for playlist`);
  return res.text();
}

/**
 * HLS — relay playlists are fully rewritten (absolute same-origin URIs), so a
 * plain text walk is exact. For a master playlist we pick ONE rendition
 * (≤720p, highest bitrate) and download only that media playlist + its
 * segments — the offline player opens the variant playlist directly.
 */
async function collectHlsParts(url: string, depth = 0): Promise<CollectedParts> {
  // absolutize (input may be a same-origin relative path like /e2ehls/main.m3u8)
  const absUrl = new URL(url, location.href).href;
  const text = await fetchText(absUrl);
  const lines = text.split('\n').map((l) => l.trim());

  // master playlist? → choose one variant
  const variants: Array<{ url: string; bandwidth: number; height: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF/i.test(lines[i])) continue;
    const attrs = lines[i].slice(lines[i].indexOf(':') + 1);
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(attrs);
    const bw = /BANDWIDTH=(\d+)/i.exec(attrs);
    let j = i + 1;
    while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
    if (j < lines.length) {
      variants.push({
        url: new URL(lines[j], absUrl).href,
        bandwidth: bw ? Number(bw[1]) || 0 : 0,
        height: res ? Number(res[2]) || 0 : 0,
      });
    }
  }

  let playlistUrl = absUrl;
  let height: number | null = null;
  if (variants.length > 0) {
    const capped = variants.filter((v) => v.height > 0 && v.height <= 720);
    const best =
      capped.sort((a, b) => b.bandwidth - a.bandwidth)[0] ||
      variants.slice().sort((a, b) => a.bandwidth - b.bandwidth)[0];
    playlistUrl = best.url;
    height = best.height || null;
  }

  const mediaText = playlistUrl === absUrl ? text : await fetchText(playlistUrl);
  const mediaLines = mediaText.split('\n').map((l) => l.trim());

  // defensive: a variant that is itself still a master (depth guard = 2)
  if (depth < 2 && mediaLines.some((l) => /^#EXT-X-STREAM-INF/i.test(l))) {
    return collectHlsParts(playlistUrl, depth + 1);
  }

  const parts: string[] = [playlistUrl];
  for (const l of mediaLines) {
    if (!l) continue;
    if (l.startsWith('#')) {
      if (/^#EXT-X-(KEY|MAP|MEDIA|SESSION-KEY)/i.test(l)) {
        const m = /URI="([^"]+)"/i.exec(l);
        if (m) parts.push(new URL(m[1], playlistUrl).href);
      }
      continue;
    }
    parts.push(new URL(l, playlistUrl).href);
  }
  return { parts: uniqKeepOrder(parts), height, playbackUrl: playlistUrl };
}

/** Cheap ranged probe — verifies a URL is actually fetchable (200/206). */
async function probePart(u: string, timeoutMs = 8000): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(u, { headers: { Range: 'bytes=0-1' }, signal: ctrl.signal });
    clearTimeout(t);
    return res.status < 400;
  } catch {
    return false;
  }
}

/** Verify the collected list: probe the manifest + the first media segment. */
async function probeCollected(parts: string[]): Promise<boolean> {
  if (parts.length === 0) return false;
  if (!(await probePart(parts[0]))) return false;
  // find the first non-init part (the first real media segment)
  const seg = parts.slice(1).find((u) => !/init\.(mp4|m4s)$/i.test(u.split('?')[0]));
  if (!seg) return true; // playlist-only download
  return probePart(seg);
}

/**
 * DASH via shaka headless (no <video>): parse the MPD and walk the chosen
 * variant's SegmentReferences. NOTE: some shaka versions substitute $Number$
 * with time values when a SegmentTimeline is present — every collected list
 * is therefore probe-verified by the caller before use.
 */
async function collectDashShaka(url: string, clearKeys: Record<string, string> | null): Promise<CollectedParts> {
  const shaka = (await import('shaka-player')).default;
  shaka.polyfill.installAll();
  const player = new shaka.Player();
  player.configure({
    manifest: {
      dash: { ignoreDrmInfo: true }, // we store encrypted bytes; keys only matter at playback
      retryParameters: { timeout: 20000, maxAttempts: 3 },
    },
  });
  try {
    await player.load(url, 0, 'application/dash+xml');
    const manifest = player.getManifest();
    if (!manifest) throw new Error('Manifest did not parse');
    const variants = manifest.variants.filter((v) => v.video);
    if (variants.length === 0) throw new Error('No video variants in manifest');

    // pick ≤720p with the highest bitrate (fallback: the smallest available)
    const capped = variants.filter((v) => (v.video?.height || 0) > 0 && (v.video?.height || 0) <= 720);
    const chosen =
      capped.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0] ||
      variants.slice().sort((a, b) => (a.video?.height || 4320) - (b.video?.height || 4320))[0] ||
      variants[0];

    const height = chosen.video?.height || null;
    const parts: string[] = [];
    const seenStreams = new Set<number>();
    const streams = [chosen.video, chosen.audio].filter(Boolean) as NonNullable<typeof chosen.video | typeof chosen.audio>[];
    for (const stream of streams) {
      if (seenStreams.has(stream.id)) continue;
      seenStreams.add(stream.id);
      try {
        await stream.createSegmentIndex();
      } catch {
        /* already created */
      }
      const segIndex = stream.segmentIndex;
      if (!segIndex) continue;
      for (const ref of segIndex) {
        if (!ref) continue;
        try {
          const init = ref.initSegmentReference;
          if (init) {
            for (const u of init.getUris()) parts.push(u);
          }
          for (const u of ref.getUris()) parts.push(u);
        } catch {
          /* skip broken reference */
        }
      }
    }
    if (parts.length === 0) throw new Error('No segments found in manifest');
    return { parts: uniqKeepOrder(parts), height, playbackUrl: url };
  } finally {
    try {
      await player.destroy();
    } catch {
      /* ignore */
    }
  }
}

/**
 * MPD parser (primary DASH path) — handles SegmentTemplate with $Number$
 * (+ SegmentTimeline or @duration) and $Time$, SegmentList and plain BaseURL
 * representations, per the DASH spec ($Number$ = segment sequence number).
 */
async function collectDashText(url: string): Promise<CollectedParts> {
  const xml = new DOMParser().parseFromString(await fetchText(url), 'application/xml');
  const q = (el: Element | Document, name: string): Element | null => {
    const list = (el as Element).getElementsByTagName(name);
    return list.length ? list[0] : null;
  };
  const txt = (el: Element, name: string): string => {
    const n = q(el, name);
    return n && n.textContent ? n.textContent.trim() : '';
  };
  const num = (el: Element, name: string): number => Number(el.getAttribute(name) || 0);
  const attr = (el: Element, name: string): string => el.getAttribute(name) || '';

  const resolve = (base: string, uri: string): string => new URL(uri, new URL(base, location.href)).href;

  const mpdBase = txt(xml, 'BaseURL') ? resolve(url, txt(xml, 'BaseURL')) : url;
  const isoDuration = attr(xml.getElementsByTagName('MPD')[0] || xml.documentElement, 'mediaPresentationDuration');
  const totalSec = (() => {
    const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(isoDuration);
    if (!m) return 0;
    return (Number(m[4]) || 0) * 3600 + (Number(m[5]) || 0) * 60 + (Number(m[6]) || 0);
  })();

  const videoReps: Array<{ el: Element; base: string; height: number; bandwidth: number }> = [];
  const audioReps: Array<{ el: Element; base: string }> = [];
  for (const aset of Array.from(xml.getElementsByTagName('AdaptationSet'))) {
    const asBase = txt(aset, 'BaseURL') ? resolve(mpdBase, txt(aset, 'BaseURL')) : mpdBase;
    const contentType = (attr(aset, 'contentType') || attr(aset, 'mimeType')).toLowerCase();
    const isAudio = /audio/.test(contentType);
    for (const rep of Array.from(aset.getElementsByTagName('Representation'))) {
      const repBase = txt(rep, 'BaseURL') ? resolve(asBase, txt(rep, 'BaseURL')) : asBase;
      if (isAudio || /audio/.test(attr(rep, 'mimeType').toLowerCase())) {
        audioReps.push({ el: rep, base: repBase });
      } else {
        videoReps.push({ el: rep, base: repBase, height: num(rep, 'height'), bandwidth: num(rep, 'bandwidth') });
      }
    }
  }
  if (videoReps.length === 0) throw new Error('No representations found');

  const capped = videoReps.filter((r) => r.height > 0 && r.height <= 720);
  const chosen =
    capped.sort((a, b) => b.bandwidth - a.bandwidth)[0] ||
    videoReps.slice().sort((a, b) => a.height - b.height)[0];
  const height = chosen.height || null;

  const expandRep = (rep: Element, base: string, out: string[]) => {
    const repBase = txt(rep, 'BaseURL') ? resolve(base, txt(rep, 'BaseURL')) : base;
    const aset = rep.parentElement as Element | null;
    const tmpl = (q(rep, 'SegmentTemplate') as Element | null) || (aset ? q(aset, 'SegmentTemplate') : null);
    if (tmpl) {
      const mediaT = attr(tmpl, 'media');
      const initT = attr(tmpl, 'initialization');
      const timescale = num(tmpl, 'timescale') || 1;
      const segDur = num(tmpl, 'duration') / timescale;
      const startNumber = num(tmpl, 'startNumber') || (/\$Number%0(\d+)d\$/.test(mediaT) ? 1 : 0);
      const repId = attr(rep, 'id');
      const bandwidth = attr(rep, 'bandwidth');
      const fill = (t: string): string =>
        t
          .replace(/\$RepresentationID\$/g, repId)
          .replace(/\$Bandwidth\$/g, bandwidth)
          .replace(/\$\$/g, '$');
      if (initT) out.push(resolve(repBase, fill(initT)));
      const timeline = q(tmpl, 'SegmentTimeline');
      if (timeline) {
        let t = 0;
        let segIdx = 0;
        for (const s of Array.from(timeline.getElementsByTagName('S'))) {
          const st = s.getAttribute('t');
          if (st !== null) t = Number(st);
          const d = Number(s.getAttribute('d') || 0);
          const r = Number(s.getAttribute('r') || 0);
          for (let i = 0; i <= Math.max(0, r); i++) {
            // $Number$ = sequence number (startNumber + index), $Time$ = media time
            const filled = fill(mediaT)
              .replace(/\$Number(?:%0(\d+)d)?\$/g, (_m, pad?: string) => String(startNumber + segIdx).padStart(pad ? Number(pad) : 0, '0'))
              .replace(/\$Time\$/g, String(t));
            out.push(resolve(repBase, filled));
            segIdx++;
            t += d;
          }
        }
      } else if (segDur > 0 && totalSec > 0) {
        const count = Math.ceil(totalSec / segDur);
        for (let i = 0; i < count; i++) {
          out.push(resolve(repBase, fill(mediaT).replace(/\$Number(?:%0(\d+)d)?\$/g, (_m, pad?: string) => String(startNumber + i).padStart(pad ? Number(pad) : 0, '0'))));
        }
      }
      return;
    }
    const list = q(rep, 'SegmentList') || (aset ? q(aset, 'SegmentList') : null);
    if (list) {
      const initEl = q(list, 'Initialization');
      if (initEl) {
        const src = attr(initEl, 'sourceURL');
        if (src) out.push(resolve(repBase, src));
      }
      for (const su of Array.from(list.getElementsByTagName('SegmentURL'))) {
        const media = attr(su, 'media');
        if (media) out.push(resolve(repBase, media));
      }
      return;
    }
    // plain <BaseURL> representation (single self-contained file)
    const single = txt(rep, 'BaseURL');
    if (single) out.push(resolve(base, single));
  };

  const parts: string[] = [url];
  expandRep(chosen.el, chosen.base, parts);
  for (const a of audioReps.slice(0, 2)) expandRep(a.el, a.base, parts);
  return { parts: uniqKeepOrder(parts), height, playbackUrl: url };
}

async function collectParts(kind: 'dash' | 'hls' | 'mp4', url: string, clearKeys: Record<string, string> | null): Promise<CollectedParts> {
  if (kind === 'mp4') return { parts: [url], height: null, playbackUrl: url };
  if (kind === 'hls') return collectHlsParts(url);
  // DASH: spec-correct MPD parser first, then probe-verify. Some shaka
  // builds mis-substitute $Number$ on timelines — only trust a part list
  // whose first segment actually fetches. If the parser fails, try the
  // shaka walk (also probe-verified), then fall back to whichever parsed.
  let textParts: CollectedParts | null = null;
  try {
    textParts = await collectDashText(url);
  } catch {
    textParts = null;
  }
  if (textParts && textParts.parts.length > 1 && (await probeCollected(textParts.parts))) {
    return textParts;
  }
  try {
    const shakaParts = await collectDashShaka(url, clearKeys);
    if (shakaParts.parts.length > 1 && (await probeCollected(shakaParts.parts))) {
      return shakaParts;
    }
  } catch {
    /* fall through */
  }
  if (textParts && textParts.parts.length > 1) return textParts;
  throw new Error('Could not read the lecture manifest (segments unreachable).');
}

// ---------------------------------------------------------------------------
// Download engine
// ---------------------------------------------------------------------------

const CONCURRENCY = 8; // browser→CDN is HTTP/2-multiplexed; 8 lanes ≈ 2× the old 4
const activeControllers = new Map<string, AbortController>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pickHeaders(res: Response): Headers {
  const h = new Headers();
  const ct = res.headers.get('content-type');
  if (ct) h.set('Content-Type', ct);
  h.set('Cache-Control', 'immutable');
  return h;
}

/**
 * Start (or resume) a lecture download. Resolves once the download pipeline
 * has been kicked off (progress continues in the background — observe via
 * subscribeDownloads / listDownloads).
 */
export async function startDownload(spec: DownloadStartSpec): Promise<SbDownload> {
  const now = new Date().toISOString();
  const existing = await getDownload(spec.id);
  // resumable = a healthy in-flight download — keep its progress; the part
  // list is re-collected on resume (parts are not persisted), which yields
  // byte-identical URLs for the already-downloaded parts (same stored sig).
  const resumable = Boolean(
    existing &&
      (existing.parts.length > 0 || existing.partsTotal > 0) &&
      (existing.status === 'paused' || existing.status === 'downloading' || existing.status === 'collecting'),
  );
  let rec: SbDownload;
  if (!existing || existing.status === 'done') {
    // brand-new download (or full re-download)
    rec = {
      ...spec,
      folder: folderFromMediaUrl(spec.url) || spec.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40),
      height: null,
      parts: [],
      partsTotal: 0,
      partsDone: 0,
      docs: spec.docs || [],
      docsDone: 0,
      sizeBytes: 0,
      status: 'collecting',
      error: undefined,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
  } else if (resumable && existing) {
    rec = {
      ...existing,
      ...spec,
      url: existing.url,
      folder: existing.folder,
      parts: [],
      partsTotal: existing.partsTotal || existing.parts.length,
      partsDone: existing.partsDone || 0,
      // keep the already-bundled docs (they may be half-downloaded)
      docs: existing.docs && existing.docs.length > 0 ? existing.docs : spec.docs || [],
      docsDone: existing.docsDone || 0,
      updatedAt: now,
    };
  } else if (existing) {
    // error state — drop the stale part list and re-collect from the source
    rec = {
      ...existing,
      ...spec,
      folder: folderFromMediaUrl(spec.url) || existing.folder,
      parts: [],
      partsTotal: 0,
      partsDone: 0,
      docs: spec.docs && spec.docs.length > 0 ? spec.docs : existing.docs || [],
      docsDone: 0,
      sizeBytes: 0,
      height: null,
      status: 'collecting',
      error: undefined,
      updatedAt: now,
    };
  } else {
    throw new Error('unreachable');
  }

  if (activeControllers.has(spec.id)) return rec; // already running
  const ctrl = new AbortController();
  activeControllers.set(spec.id, ctrl);

  await putDownload(rec);
  notifyChange();

  // fire-and-forget the heavy lifting
  void runDownload(rec, ctrl).finally(() => activeControllers.delete(spec.id));
  return rec;
}

async function runDownload(rec: SbDownload, ctrl: AbortController): Promise<void> {
  try {
    // ---- 1. collect parts (re-collect on resume if we never finished) ----
    if (rec.parts.length === 0) {
      rec.status = 'collecting';
      await putDownload(rec);
      notifyChange();
      const collected = await collectParts(rec.kind, rec.url, rec.clearKeys);
      if (ctrl.signal.aborted) return;
      rec.parts = collected.parts;
      rec.partsTotal = collected.parts.length;
      rec.height = collected.height;
      rec.url = collected.playbackUrl;
      // resume: keep progress (cached parts are re-verified cheaply below);
      // fresh/error re-collect: start from zero
      if (!rec.partsDone) {
        rec.partsDone = 0;
        rec.sizeBytes = 0;
      }
      await putDownload(rec);
      notifyChange();
    }
    if (!rec.partsTotal) rec.partsTotal = rec.parts.length;

    if (!('caches' in window)) throw new Error('Cache API unavailable in this browser');
    const cache = await caches.open(videoCacheName(rec.folder));

    // ---- 2. notes & DPP PDFs — small files, fetched FIRST so they are
    //         usable even if the big video download is paused or never
    //         finishes. A missing PDF never blocks the lecture itself. ----
    const docs = rec.docs || [];
    if (docs.length > 0) {
      rec.docsDone = 0;
      await putDownload(rec);
      notifyChange();
      for (const d of docs) {
        if (ctrl.signal.aborted) return;
        try {
          const hit = await cache.match(d.url); // already stored on resume
          if (!hit) {
            const res = await fetch(d.url, { signal: ctrl.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            await cache.put(d.url, new Response(buf, { headers: pickHeaders(res) }));
          }
          rec.docsDone = (rec.docsDone || 0) + 1;
          await putDownload(rec);
          notifyChange();
        } catch {
          // one unreachable note/DPP must not fail the lecture download
        }
      }
    }

    // ---- 3. download pool ----
    rec.status = 'downloading';
    await putDownload(rec);
    notifyChange();

    let next = 0;
    let done = rec.partsDone;
    let size = rec.sizeBytes;
    let failure: Error | null = null;
    // fresh start: nothing can be cached yet — skip the per-part resume probe
    const skipResumeMatch = rec.partsDone === 0;

    const grab = async (): Promise<void> => {
      for (;;) {
        if (ctrl.signal.aborted || failure) return;
        const i = next++;
        if (i >= rec.parts.length) return;
        const partUrl = rec.parts[i];
        try {
          const hit = skipResumeMatch ? null : await cache.match(partUrl); // resume: keep already-cached parts
          if (hit) {
            size += Number(hit.headers.get('content-length') || 0);
          } else {
            let stored = false;
            for (let attempt = 0; attempt < 2 && !stored; attempt++) {
              try {
                const res = await fetch(partUrl, { signal: ctrl.signal });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const buf = await res.arrayBuffer();
                size += buf.byteLength;
                await cache.put(partUrl, new Response(buf, { headers: pickHeaders(res) }));
                stored = true;
              } catch (e) {
                if (ctrl.signal.aborted) return;
                if (attempt === 1) throw e;
                await sleep(1500); // one soft retry on flaky network
              }
            }
            if (!stored) throw new Error('Fetch failed twice');
          }
          done++;
          if (done % 5 === 0 || done === rec.parts.length) {
            rec.partsDone = done;
            rec.sizeBytes = size;
            await putDownload(rec);
            notifyChange();
          }
        } catch (e) {
          if (ctrl.signal.aborted) return;
          failure = e instanceof Error ? e : new Error('Download failed');
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rec.parts.length) }, grab));

    if (ctrl.signal.aborted) return;
    if (failure) throw failure;

    rec.partsDone = rec.parts.length;
    rec.sizeBytes = size;
    rec.partsTotal = rec.parts.length;
    rec.status = 'done';
    rec.error = undefined;
    await putDownload(rec);
    notifyChange();
    await ensurePersistentStorage();
  } catch (e) {
    if (ctrl.signal.aborted) return; // paused — record keeps its state
    rec.status = 'error';
    rec.error = e instanceof Error ? e.message : 'Download failed';
    await putDownload(rec);
    notifyChange();
  }
}

/** Pause an in-flight download (resume later with startDownload). */
export async function pauseDownload(id: string): Promise<void> {
  const ctrl = activeControllers.get(id);
  if (ctrl) {
    activeControllers.delete(id);
    ctrl.abort();
  }
  const rec = await getDownload(id);
  if (rec && (rec.status === 'downloading' || rec.status === 'collecting')) {
    rec.status = 'paused';
    await putDownload(rec);
    notifyChange();
  }
}

export async function isDownloading(id: string): Promise<boolean> {
  return activeControllers.has(id);
}

/** Delete a lecture's offline copy (cache + record). */
export async function deleteDownload(id: string): Promise<void> {
  await pauseDownload(id);
  const rec = await getDownload(id);
  if (rec) {
    try {
      await caches.delete(videoCacheName(rec.folder));
    } catch {
      /* ignore */
    }
    await tx('readwrite', (s) => s.delete(rec.id) as unknown as IDBRequest<undefined>);
    notifyChange();
  }
}

/** Delete every offline lecture (used by "Clear all"). */
export async function deleteAllDownloads(): Promise<void> {
  const all = await listDownloads();
  for (const rec of all) await deleteDownload(rec.id);
}

// ---------------------------------------------------------------------------
// Formatting helpers for the UI
// ---------------------------------------------------------------------------

export function formatBytes(n: number): string {
  if (!n || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
