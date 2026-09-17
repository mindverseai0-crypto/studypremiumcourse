// Study Ratna (studyratna.cc) server-side client.
//
// The platform ("StudyRays v3.0" white-label) sits behind two layers:
//   1. An openresty "One moment, please…" splash (wssplashchk cookie) whose
//      handshake we replicate: fetch challenge page → parse per-page params
//      (id/ts/wsidchk digits) → GET the verification endpoint → follow the
//      http→https redirect chain. Cookie is UA-bound and valid ~1h.
//   2. Cloudflare jsd fingerprinting (no interaction needed for server calls).
//
// Content APIs live on s4-cdn.samfygros.com under /radha/ (a transparent
// proxy to the PW backend). Two accepted forms:
//   - raw:   /radha/<upstream-path>
//   - enc:   /radha/index.php?type=<type>&metaData=<xor-base64(path)>
// The XOR cipher uses the repeating key below (recovered from the client JS).
//
// Chain used by this module:
//   batches   → public GitHub JSON (semfy-gros.github.io)
//   subjects  → /v3/batches/<B>/details                (data.subjects)
//   topics    → /v1/batches/<B>/subject/<S>/topics
//   lectures  → /batch-service/v3/batch-subject-schedules/<B>/subject/<S>/contents?contentType=LECTURES&tagId=<T>
//   video     → /v1/videos/<videoKey>                  (unsigned CloudFront master.mpd)
//   player    → https://s2-cdn.studyratna.cc/play.php?… (their own player page,
//                embeddable via iframe — self-handles its splash + token)

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

export const SR_HOSTS = {
  app: 'https://s2-cdn.studyratna.cc',
  api: 'https://s4-cdn.samfygros.com',
} as const;

export const SR_BATCHES_JSON = 'https://semfy-gros.github.io/batches/batcha.json';

const SPLASH_FORM_ID = '7fa3b767c460b54a2be4d49030b349c7';
const XOR_KEY = 'fgsbhv235793853rifjb';

export function srEncryptMeta(path: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < path.length; i++) bytes.push(path.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
  return Buffer.from(bytes).toString('base64');
}

export function srDecryptMeta(b64: string): string {
  const buf = Buffer.from(decodeURIComponent(b64), 'base64');
  let out = '';
  for (let i = 0; i < buf.length; i++) out += String.fromCharCode(buf[i] ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
  return out;
}

/* ------------------------------------------------------------------ */
/* Splash session (per host)                                           */
/* ------------------------------------------------------------------ */

interface SrSession {
  cookie: string;
  lastHandshake: number;
  handshakePromise: Promise<boolean> | null;
}

const sessions = new Map<string, SrSession>();

function sessionFor(host: string): SrSession {
  let s = sessions.get(host);
  if (!s) {
    s = { cookie: '', lastHandshake: 0, handshakePromise: null };
    sessions.set(host, s);
  }
  return s;
}

async function rawFetch(host: string, path: string, extraHeaders: Record<string, string> = {}) {
  const s = sessionFor(host);
  const res = await fetch(host + path, {
    headers: { 'User-Agent': UA, ...(s.cookie ? { Cookie: s.cookie } : {}), ...extraHeaders },
    redirect: 'manual',
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) s.cookie = pair;
  }
  return { res, body: await res.text() };
}

/** Replicates the wssplashchk handshake. Returns true when cleared. */
export async function srHandshake(host: string = SR_HOSTS.api): Promise<boolean> {
  const s = sessionFor(host);
  if (s.handshakePromise) return s.handshakePromise;
  s.handshakePromise = (async () => {
    try {
      s.cookie = '';
      const { body: html } = await rawFetch(host, '/');
      const rpath = html.match(/\/z0f[0-9a-f]{32,}/)?.[0];
      const ts = html.match(/'ts',\s*'(\d+)'/)?.[1];
      const pExpr = html.match(/P=\+\(\((.*?)\)\)/s)?.[1];
      const nExpr = html.match(/N=\+\(\((.*?)\)\)/s)?.[1];
      if (!rpath || !ts || !pExpr || !nExpr) return false;
      const wsidchk = +eval(`(${pExpr})`) + +eval(`(${nExpr})`);
      const hostName = host.replace(/^https?:\/\//, '');
      const qs = `wsidchk=${wsidchk}&pdata=${encodeURIComponent('http://' + hostName)}&id=${SPLASH_FORM_ID}&ts=${ts}&cttl=0`;
      const hs = await fetch(host + rpath + '?' + qs, {
        headers: { 'User-Agent': UA, Referer: host + '/' },
        redirect: 'manual',
      });
      for (const c of hs.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) s.cookie = pair;
      }
      const loc = hs.headers.get('location');
      if (loc) {
        try {
          await fetch(loc, { headers: { 'User-Agent': UA, Cookie: s.cookie }, redirect: 'follow' });
        } catch {
          /* the redirect hop is best-effort */
        }
      }
      s.lastHandshake = Date.now();
      return s.cookie.includes('wssplashchk=');
    } finally {
      s.handshakePromise = null;
    }
  })();
  return s.handshakePromise;
}

const isSplash = (body: string) => body.includes('being verified') || body.includes('One moment, please');

/** Authenticated GET against a splash-protected host with auto re-handshake. */
export async function srGet(
  url: string,
  extraHeaders: Record<string, string> = {},
  attempts = 3,
): Promise<{ status: number; body: string }> {
  const host = new URL(url).origin;
  for (let i = 0; i < attempts; i++) {
    const s = sessionFor(host);
    if (!s.cookie || Date.now() - s.lastHandshake > 30 * 60 * 1000) await srHandshake(host);
    const { res, body } = await rawFetch(host, url.slice(host.length), extraHeaders);
    if (!isSplash(body)) return { status: res.status, body };
    await srHandshake(host);
  }
  return { status: 502, body: '{"success":false,"error":"splash loop"}' };
}

/* ------------------------------------------------------------------ */
/* Content chain                                                       */
/* ------------------------------------------------------------------ */

const API_HEADERS = {
  Origin: SR_HOSTS.app,
  Referer: SR_HOSTS.app + '/',
};

/** Fetch a radha proxied path. Tries the encrypted form first, then raw. */
export async function radhaGet(path: string): Promise<{ status: number; body: string }> {
  const encUrl = `${SR_HOSTS.api}/radha/index.php?type=contents&metaData=${encodeURIComponent(srEncryptMeta(path))}`;
  let out = await srGet(encUrl, API_HEADERS);
  const ok = (r: { status: number; body: string }) => r.status === 200 && r.body.includes('"success":true');
  if (ok(out)) return out;
  const raw = await srGet(`${SR_HOSTS.api}/radha${path.startsWith('/') ? path : '/' + path}`, API_HEADERS);
  if (ok(raw)) return raw;
  return out;
}

async function radhaJson<T = Record<string, unknown>>(path: string): Promise<T | null> {
  // The upstream intermittently flaps (rate scoring) — retry twice with a
  // small backoff before giving up.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { body } = await radhaGet(path);
    try {
      const j = JSON.parse(body) as { success?: boolean; data?: T };
      if (j.success && j.data !== undefined) return j.data;
    } catch {
      /* fall through to retry */
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
  }
  return null;
}

/* ---- batches catalog (public GitHub JSON, no splash) ---- */

export interface SrBatch {
  batch_id: string;
  name: string;
  byName?: string;
  exam?: string;
  language?: string;
  class?: string;
  photo?: string;
  amount?: number;
  start_date?: string;
  end_date?: string;
}

let batchesCache: { at: number; data: SrBatch[] } | null = null;

export async function srBatches(): Promise<SrBatch[]> {
  if (batchesCache && Date.now() - batchesCache.at < 6 * 60 * 60 * 1000) return batchesCache.data;
  const res = await fetch(SR_BATCHES_JSON + '?v=' + Date.now(), { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`batches HTTP ${res.status}`);
  const j = (await res.json()) as { batches?: SrBatch[] };
  const list = Array.isArray(j.batches) ? j.batches : [];
  batchesCache = { at: Date.now(), data: list };
  return list;
}

/* ---- batch details (includes subjects) ---- */

export interface SrSubject {
  _id?: string;
  subjectId?: string;
  subject?: string;
  slug?: string;
  imageUrl?: string;
}

export interface SrBatchDetails {
  _id: string;
  name?: string;
  byName?: string;
  description?: string;
  subjects?: SrSubject[];
  [k: string]: unknown;
}

export async function srBatchDetails(batchId: string): Promise<SrBatchDetails | null> {
  return radhaJson<SrBatchDetails>(`/v3/batches/${batchId}/details`);
}

/* ---- topics (chapters) ---- */

export interface SrTopic {
  _id: string;
  name: string;
  typeId?: string;
  type?: string;
  videos?: number;
  notes?: number;
  exercises?: number;
  displayOrder?: number;
  slug?: string;
}

export async function srTopics(batchId: string, subjectId: string, page = 1, limit = 50): Promise<SrTopic[] | null> {
  const d = await radhaJson<{ data?: SrTopic[] } | SrTopic[]>(
    `/v1/batches/${batchId}/subject/${subjectId}/topics?page=${page}&limit=${limit}`,
  );
  if (d === null) return null;
  if (Array.isArray(d)) return d;
  return d?.data || [];
}

/* ---- lectures (schedule contents) ---- */

export interface SrLecture {
  _id: string;
  topic?: string;
  date?: string;
  startTime?: string;
  urlType?: string;
  videoDetails?: { _id?: string; name?: string; videoUrl?: string; image?: string; duration?: string; types?: string[]; drmProtected?: boolean };
  [k: string]: unknown;
}

export async function srLectures(
  batchId: string,
  subjectId: string,
  tagId: string,
  skip = 0,
  limit = 20,
): Promise<SrLecture[] | null> {
  const p = `/batch-service/v3/batch-subject-schedules/${batchId}/subject/${subjectId}/contents?skip=${skip}&limit=${limit}&contentType=LECTURES&tagId=${tagId}`;
  const d = await radhaJson<{ contents?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(p);
  if (d === null) return null;
  const arr = Array.isArray(d) ? d : d?.contents || [];
  // Items arrive wrapped as { type: 'LECTURE', _id, data: {…schedule…} } — unwrap.
  return arr
    .filter((it) => it && typeof it === 'object')
    .map((it) => {
      const inner = (it as { data?: SrLecture }).data;
      return inner && typeof inner === 'object' ? inner : (it as SrLecture);
    });
}

/* ---- video resolution ---- */

export interface SrVideo {
  _id?: string;
  name?: string;
  videoUrl?: string;
  image?: string;
  duration?: string;
  types?: string[];
  drmProtected?: boolean;
}

export async function srVideoUrl(videoKey: string): Promise<SrVideo | null> {
  return radhaJson<SrVideo>(`/v1/videos/${videoKey}`);
}

/* ---- player embed URL (their own player page — iframe friendly) ---- */

export interface SrPlayerParams {
  scheduleId: string; // video_id
  videoKey: string; //   videoDetails._id
  batchId: string;
  subjectId: string;
  topicId: string;
  subjectSlug?: string;
  topicSlug?: string;
  title?: string;
  poster?: string;
}

export function srPlayerUrl(p: SrPlayerParams & { videoUrl?: string }): string {
  const q = new URLSearchParams();
  // Their PHP layer signs whatever video_url it receives server-side; when we
  // can resolve the underlying master.mpd we hand it over pre-resolved.
  q.set('video_url', p.videoUrl || '');
  if (p.title) q.set('title', p.title);
  if (p.poster) q.set('poster', p.poster);
  q.set('video_id', p.scheduleId);
  q.set('video_key', p.videoKey);
  q.set('batch_id', p.batchId);
  q.set('subject_id', p.subjectId);
  q.set('video_type', 'pw');
  q.set('subject_id_original', p.subjectId);
  q.set('topic_id', p.topicId);
  if (p.subjectSlug) q.set('subject_slug', p.subjectSlug);
  if (p.topicSlug) q.set('topic_slug', p.topicSlug);
  return `${SR_HOSTS.app}/play.php?${q.toString()}`;
}
