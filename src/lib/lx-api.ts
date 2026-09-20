// ============================================================================
// LearnxPW upstream client (server-side only).
//
// learnxpw.site exposes the REAL PW (Physics Wallah) content APIs that power
// its own /study/batches experience. This module is the single place that
// talks to it: catalog, batch details, subjects, chapters, content nodes
// (lectures/notes/DPP PDFs/DPP videos), schedule (today + weekly), tests,
// DPP quizzes, PDF url resolution and the per-video signed CloudFront DASH
// url + ClearKey retrieval.
//
// All requests run server→server (no CORS concerns) and popular GETs are
// cached in memory for a short TTL to stay polite with the upstream.
// ============================================================================

const LX_ORIGIN = 'https://www.learnxpw.site';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export { CLOUDFRONT_HOST } from './pw-cdn';

// ---------------------------------------------------------------------------
// fetch helpers
// ---------------------------------------------------------------------------

async function lxFetch(path: string, init?: RequestInit, timeoutMs = 25000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${LX_ORIGIN}${path}`, {
      ...init,
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Referer: `${LX_ORIGIN}/study/batches`,
        Origin: LX_ORIGIN,
        ...(init?.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function lxJson<T = unknown>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const res = await lxFetch(path, init, timeoutMs);
  if (!res.ok) {
    let message = `Upstream ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// tiny GET cache ( TTL-based, bounded )
// ---------------------------------------------------------------------------

type CacheEntry = { at: number; value: unknown };
const getCache = new Map<string, CacheEntry>();
const GET_CACHE_MAX = 400;

function cacheGet<T>(key: string, ttlMs: number): T | null {
  const hit = getCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) {
    getCache.delete(key);
    return null;
  }
  return hit.value as T;
}

function cacheSet(key: string, value: unknown): void {
  if (getCache.size >= GET_CACHE_MAX) {
    const oldest = getCache.keys().next().value;
    if (oldest) getCache.delete(oldest);
  }
  getCache.set(key, { at: Date.now(), value });
}

// single-flight map — concurrent identical requests share ONE upstream call
const inflight = new Map<string, Promise<unknown>>();

async function cachedJson<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const hit = cacheGet<T>(key, ttlMs);
  if (hit !== null) return hit;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = (async () => {
    try {
      const value = await loader();
      cacheSet(key, value);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// shared types (upstream shapes, kept loose)
// ---------------------------------------------------------------------------

export interface LxAttachment {
  _id?: string;
  baseUrl?: string;
  key?: string;
  name?: string;
}

export interface LxSubject {
  _id?: string; // batch-subject id (join record)
  subject?: string;
  subjectId?: string; // master subject id
  slug?: string;
  teacherIds?: Array<{ _id?: string; firstName?: string; lastName?: string; imageId?: LxAttachment }>;
}

export interface LxChapter {
  _id?: string;
  name?: string;
  type?: string;
  typeId?: string;
  displayOrder?: number;
  notes?: number;
  exercises?: number;
  videos?: number;
  lectureVideos?: number;
  slug?: string;
}

export interface LxVideoDetails {
  _id?: string;
  name?: string;
  image?: string;
  videoUrl?: string;
  duration?: string;
}

export interface LxScheduleItem {
  _id?: string;
  topic?: string;
  name?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  status?: string;
  tag?: string;
  lectureType?: string; // LIVE | RECORDED | ...
  urlType?: string; // penpencilvdo | youtube | vimeo | ...
  url?: string;
  isDPPNotes?: boolean;
  isDPPVideos?: boolean;
  videoDetails?: LxVideoDetails | null;
  teachers?: unknown;
  subjectId?: { _id?: string; name?: string; slug?: string } | string | null;
  homeworkIds?: Array<{ _id?: string; topic?: string; attachmentIds?: LxAttachment[] }>;
  exerciseIds?: Array<Record<string, unknown>>;
  dpp?: { homeworkIds?: Array<{ _id?: string; topic?: string; attachmentIds?: LxAttachment[] }> } | null;
  dppVideos?: LxScheduleItem[];
  previewImageUrl?: string;
  slug?: string;
}

export interface LxBatchSummary {
  _id?: string;
  name?: string;
  byName?: string;
  startDate?: string;
  endDate?: string;
  language?: string;
  previewImage?: string;
  feeTotal?: number;
  type?: string;
  slug?: string;
}

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

export interface LxBatchPage {
  success?: boolean;
  batches?: LxBatchSummary[];
  currentPage?: number;
  totalPages?: number;
  pageSize?: number;
  total?: number;
}

export async function lxAllBatches(page: number): Promise<LxBatchPage> {
  return cachedJson(`allb:${page}`, 5 * 60_000, () =>
    lxJson<LxBatchPage>(`/api/AllBatches?page=${Math.max(1, page)}`),
  );
}

export async function lxSearchBatches(name: string, page: number): Promise<LxBatchPage> {
  const q = encodeURIComponent(name.trim());
  return cachedJson(`search:${q}:${page}`, 3 * 60_000, () =>
    lxJson<LxBatchPage>(`/api/searchBatch?name=${q}&page=${Math.max(1, page)}`),
  );
}

// ---------------------------------------------------------------------------
// batch details / announcements
// ---------------------------------------------------------------------------

export interface LxBatchDetails extends Record<string, unknown> {
  _id?: string;
  name?: string;
  byName?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  language?: string;
  class?: unknown;
  exam?: unknown;
  subjects?: LxSubject[];
  previewImage?: string;
  previewImageUrl?: string;
  feeTotal?: number;
  slug?: string;
  priceLabel?: string;
}

export async function lxBatchDetails(batchId: string): Promise<LxBatchDetails | null> {
  const id = encodeURIComponent(batchId.trim());
  try {
    return await cachedJson(`bd:${id}`, 5 * 60_000, async () => {
      const res = await lxJson<{ success?: boolean; data?: LxBatchDetails }>(
        `/api/BatchInfo?BatchId=${id}&Type=details`,
      );
      return res?.data ?? null;
    });
  } catch {
    return null;
  }
}

export async function lxBatchAnnouncements(
  batchId: string,
  page: number,
): Promise<Array<Record<string, unknown>>> {
  const id = encodeURIComponent(batchId.trim());
  try {
    const res = await cachedJson(`ann:${id}:${page}`, 2 * 60_000, () =>
      lxJson<{ data?: Array<Record<string, unknown>> }>(
        `/api/BatchInfo?BatchId=${id}&Type=announcement&page=${Math.max(1, page)}`,
      ),
    );
    return Array.isArray(res?.data) ? res.data : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// chapters & content
// ---------------------------------------------------------------------------

export async function lxChapters(batchId: string, subjectSlug: string, page: number): Promise<LxChapter[]> {
  const b = encodeURIComponent(batchId.trim());
  const s = encodeURIComponent(subjectSlug.trim());
  return cachedJson<LxChapter[]>(`ch:${b}:${s}:${Math.max(1, page)}`, 3 * 60_000, async () => {
    const res = await lxJson<{ data?: LxChapter[] }>(
      `/api/SubjectInfo?BatchId=${b}&SubjectId=${s}&page=${Math.max(1, page)}`,
    );
    return Array.isArray(res?.data) ? res.data : [];
  });
}

export type LxContentType = 'videos' | 'notes' | 'DppNotes' | 'DppVideos';

export async function lxTopicContent(
  batchId: string,
  subjectSlug: string,
  chapterId: string,
  contentType: LxContentType,
  page: number,
): Promise<LxScheduleItem[]> {
  const b = encodeURIComponent(batchId.trim());
  const s = encodeURIComponent(subjectSlug.trim());
  const t = encodeURIComponent(chapterId.trim());
  return cachedJson<LxScheduleItem[]>(
    `tc:${b}:${s}:${t}:${contentType}:${Math.max(1, page)}`,
    3 * 60_000,
    async () => {
      const res = await lxJson<{ data?: LxScheduleItem[] }>(
        `/api/TopicInfo?BatchId=${b}&SubjectId=${s}&TopicId=${t}&ContentType=${contentType}&page=${Math.max(1, page)}`,
      );
      return Array.isArray(res?.data) ? res.data : [];
    },
  );
}

// ---------------------------------------------------------------------------
// schedule (today / weekly / single)
// ---------------------------------------------------------------------------

export async function lxTodaySchedule(batchId: string): Promise<LxScheduleItem[]> {
  const id = encodeURIComponent(batchId.trim());
  try {
    const res = await lxJson<{ data?: LxScheduleItem[] | { data?: LxScheduleItem[] } }>(
      '/api/todays-schedule',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: id }),
      },
    );
    const d = res?.data;
    return Array.isArray(d) ? d : Array.isArray((d as { data?: LxScheduleItem[] })?.data) ? (d as { data: LxScheduleItem[] }).data : [];
  } catch {
    return [];
  }
}

export async function lxScheduleDetail(
  batchId: string,
  subjectId: string,
  contentId: string,
): Promise<LxScheduleItem | null> {
  const b = encodeURIComponent(batchId.trim());
  const s = encodeURIComponent(subjectId.trim());
  const c = encodeURIComponent(contentId.trim());
  return cachedJson<LxScheduleItem | null>(`sd:${b}:${s}:${c}`, 5 * 60_000, async () => {
    try {
      const res = await lxJson<{ data?: LxScheduleItem | { data?: LxScheduleItem } }>(
        `/api/Schedule?BatchId=${b}&SubjectId=${s}&ContentId=${c}`,
      );
      const d = res?.data;
      if (Array.isArray(d)) return (d[0] as LxScheduleItem) ?? null;
      if (d && typeof d === 'object' && 'data' in (d as Record<string, unknown>)) {
        return ((d as { data?: LxScheduleItem }).data as LxScheduleItem) ?? null;
      }
      return (d as LxScheduleItem) ?? null;
    } catch {
      return null;
    }
  });
}

// ---------------------------------------------------------------------------
// tests & dpps
// ---------------------------------------------------------------------------

export async function lxBatchTests(batchId: string): Promise<Array<Record<string, unknown>>> {
  const id = encodeURIComponent(batchId.trim());
  const res = await lxJson<Record<string, unknown>>(`/api/batch-tests?batchId=${id}`);
  const data = (res as { data?: unknown }).data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const inner = (data as { data?: unknown }).data;
    if (Array.isArray(inner)) return inner;
  }
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  return [];
}

export async function lxTestInstructions(
  testId: string,
  batchId: string,
): Promise<Record<string, unknown> | null> {
  const t = encodeURIComponent(testId.trim());
  const b = encodeURIComponent(batchId.trim());
  try {
    const res = await lxJson<{ data?: Record<string, unknown> }>(
      `/api/test-instructions?testId=${t}&batchId=${b}`,
    );
    return res?.data ?? null;
  } catch {
    return null;
  }
}

export interface LxDppItem {
  _id?: string;
  type?: string;
  dppQuizDetails?: {
    test?: { _id?: string; name?: string; totalQuestions?: number; totalMarks?: number; maxDuration?: number };
    tag?: string;
    isReattempted?: boolean;
    isFree?: boolean;
    scheduleId?: string;
    contentId?: string;
    testStudentMapping?: Record<string, unknown>;
  };
}

export async function lxDppList(
  batchId: string,
  batchSubjectId: string,
  chapterId: string,
  page: number,
  limit: number,
): Promise<LxDppItem[]> {
  const b = encodeURIComponent(batchId.trim());
  const bs = encodeURIComponent(batchSubjectId.trim());
  const c = encodeURIComponent(chapterId.trim());
  const res = await lxJson<{ data?: LxDppItem[] }>(
    `/api/dpp-list?batchId=${b}&batchSubjectId=${bs}&chapterId=${c}&page=${Math.max(1, page)}&limit=${Math.min(50, Math.max(1, limit))}`,
  );
  return Array.isArray(res?.data) ? res.data : [];
}

/**
 * Start (fetch questions for) a DPP quiz. NOTE: the upstream gates this
 * behind a signed-in session — anonymous calls return an error, which the
 * caller is expected to surface honestly.
 */
export async function lxStartDpp(params: {
  testId: string;
  batchId: string;
  type?: string;
  scheduleId?: string;
  batchScheduleId?: string;
  subjectId?: string;
}): Promise<Record<string, unknown>> {
  const q = new URLSearchParams({
    testId: params.testId.trim(),
    batchId: params.batchId.trim(),
    type: params.type || 'Start',
    scheduleId: params.scheduleId || '',
    batchScheduleId: params.batchScheduleId || params.scheduleId || '',
    subjectId: params.subjectId || '',
    exerciseId: params.testId.trim(),
    testSource: 'DPP_QUIZ_MODE',
  });
  return lxJson<Record<string, unknown>>(`/api/start-dpp?${q.toString()}`);
}

// ---------------------------------------------------------------------------
// video: signed cloudfront url + clearkey
// ---------------------------------------------------------------------------

export interface LxVideoUrl {
  url: string; // e.g. https://d1d34p8vz63oiq.cloudfront.net/<folder>/master.mpd
  signedUrl: string; // ?Signature=...&Key-Pair-Id=...&Policy=...
}

export async function lxVideoUrl(
  batchId: string,
  subjectId: string,
  videoId: string,
): Promise<LxVideoUrl | null> {
  const b = encodeURIComponent(batchId.trim());
  const s = encodeURIComponent(subjectId.trim());
  const v = encodeURIComponent(videoId.trim());
  // Cached 10 min + single-flight: this endpoint is the slowest hop of the
  // lecture chain — repeats / StrictMode double-fires must not re-hit it.
  return cachedJson<LxVideoUrl | null>(`vu:${b}:${s}:${v}`, 10 * 60_000, async () => {
    try {
      const res = await lxJson<{ success?: boolean; data?: LxVideoUrl }>(
        `/api/video-url?batch_id=${b}&subject_id=${s}&video_id=${v}`,
        undefined,
        12000,
      );
      if (res?.success && res.data?.url) return { url: res.data.url, signedUrl: res.data.signedUrl || '' };
    } catch {
      /* fall through */
    }
    try {
      const res = await lxJson<{ success?: boolean; data?: LxVideoUrl }>(
        `/api/get-video-url?batchId=${b}&subjectId=${s}&childId=${v}`,
        undefined,
        12000,
      );
      if (res?.data?.url) return { url: res.data.url, signedUrl: res.data.signedUrl || '' };
    } catch {
      /* fall through */
    }
    return null;
  });
}

export async function lxOtp(kid: string): Promise<Record<string, string> | null> {
  const k = encodeURIComponent(kid.trim());
  // ClearKeys are stable per KID — cache for an hour (null results stay
  // uncached so a transient otp failure retries on the next lecture load).
  return cachedJson<Record<string, string> | null>(`otp:${k}`, 60 * 60_000, async () => {
    try {
      const res = await lxJson<{ clearKeys?: Record<string, string> }>(`/api/get-otp?kid=${k}`, undefined, 15000);
      return res?.clearKeys ?? null;
    } catch {
      return null;
    }
  });
}

// ---------------------------------------------------------------------------
// pdf url resolution
// ---------------------------------------------------------------------------

export async function lxPdfUrl(
  batchId: string,
  subjectSlug: string,
  pdfId: string,
  attachmentId: string,
): Promise<string | null> {
  const b = encodeURIComponent(batchId.trim());
  const s = encodeURIComponent(subjectSlug.trim());
  const p = encodeURIComponent(pdfId.trim());
  const a = encodeURIComponent(attachmentId.trim());
  const res = await lxJson<{ data?: { baseUrl?: string; key?: string } }>(
    `/api/GetPdf?BatchId=${b}&SubjectId=${s}&PdfId=${p}&AttachmentId=${a}`,
  );
  const d = res?.data;
  if (d?.key && d?.baseUrl) return `${d.baseUrl}${d.key}`;
  return null;
}

// ---------------------------------------------------------------------------
// teachers
// ---------------------------------------------------------------------------

export async function lxTeachers(ids: string[]): Promise<Array<Record<string, unknown>>> {
  const clean = ids.map((s) => String(s).trim()).filter(Boolean);
  if (clean.length === 0) return [];
  try {
    const res = await lxJson<{ data?: Array<Record<string, unknown>> }>('/api/get-user-details-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idsParam: clean.join(',') }),
    });
    return Array.isArray(res?.data) ? res.data : [];
  } catch {
    return [];
  }
}
