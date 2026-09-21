// Frontend API client — mirrors the original ParchamCore protocol.
// All calls POST to /api/data with { action, params, method, payload }.
// The backend relays the REAL PW content APIs used by learnxpw.site:
// batches, subjects, chapters, lectures, notes/DPP PDFs, tests, schedule
// and signed CloudFront DASH streams.
//
// Offline support: every cacheable response is persisted (src/lib/offline-data)
// and served back from there when the device is offline or the network call
// fails — so enrolled batches and all their content stay browsable offline
// after having been opened online at least once.

import { apiCacheKey, cacheApiGet, cacheApiPut, isOffline } from './offline-data';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  hasMore?: boolean;
  error?: string;
  /** True when this response came from the offline app-data cache. */
  stale?: boolean;
}

/** Side-effectful / short-lived actions that must never be cached. */
const UNCACHABLE_ACTIONS = new Set(['parcham_vid', 'pw_dpp_start']);

export async function parchamCore<T = unknown>(
  action: string,
  params: Record<string, unknown> = {},
  method: 'GET' | 'POST' = 'GET',
  payload: unknown = null,
): Promise<ApiResponse<T>> {
  const cacheable = method === 'GET' && !UNCACHABLE_ACTIONS.has(action);
  const key = cacheable ? apiCacheKey(action, params) : '';

  // offline right away → answer from the last cached copy, if any
  if (cacheable && isOffline()) {
    const hit = await cacheApiGet<{ data?: T; hasMore?: boolean }>(key);
    if (hit) return { success: true, data: hit.data as T, hasMore: hit.hasMore, stale: true };
  }

  try {
    const res = await fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params, method, payload }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as ApiResponse<T>;
    if (cacheable && body.success) void cacheApiPut(key, { data: body.data, hasMore: body.hasMore });
    return body;
  } catch (e) {
    // network failure → fall back to the cached copy (stale) when we have one
    if (cacheable) {
      const hit = await cacheApiGet<{ data?: T; hasMore?: boolean }>(key);
      if (hit) return { success: true, data: hit.data as T, hasMore: hit.hasMore, stale: true };
    }
    return { success: false, error: e instanceof Error ? e.message : 'Network error' };
  }
}

// ---- Typed helpers ----

/** Real batch record — catalog card + detail share the same fields. */
export interface BatchCatalogItem {
  _id: string; // real PW batch id
  id: string; // slug
  name: string;
  byName: string;
  imageUrl?: string;
  exams: string[];
  language: string;
  className: string;
  amount: number | null;
  startDate: string;
  endDate: string;
  description?: string;
  /** Subject mapping — present on pw_btch_dtl responses. */
  subjects?: BatchSubjectPublic[];
}

export type BatchDetailPublic = BatchCatalogItem;

export function imageUrl(
  ref: { baseUrl?: string; key?: string } | string | null | undefined,
  fallback = 'https://store.pw.live/footer-logo.svg',
): string {
  if (!ref) return fallback;
  if (typeof ref === 'string') return ref || fallback;
  const url = (ref.baseUrl || '') + (ref.key || '');
  return url || fallback;
}

// ---- Content shapes ----

export interface BatchSubjectPublic {
  _id: string; // subject slug (SubjectInfo/TopicInfo are slug-addressed)
  subject: string;
  subjectId: string; // slug as well
  batchSubjectId?: string; // batch-subject join id (dpp-list)
  masterId?: string; // master subject id (Schedule / video-url)
}

export interface ChapterItemPublic {
  _id: string;
  name: string;
  typeId: string;
  notes: number;
  videos: number;
  exercises?: number;
  order: number;
}

export interface LectureData {
  _id: string;
  topic: string;
  name?: string;
  date?: string;
  urlType?: string;
  url?: string;
  videoDetails?: { _id?: string; image?: string; videoUrl?: string; duration?: string };
  homeworkIds?: Array<{ topic?: string; attachmentIds?: Array<{ baseUrl?: string; key?: string }> }>;
  exerciseIds?: Array<{ title?: string; dppId?: string; attachmentIds?: Array<{ baseUrl?: string; key?: string }> }>;
}

export interface ContentNodePublic {
  _id: string;
  type: string;
  data: LectureData;
}

export interface TestItemPublic {
  _id: string;
  name: string;
  totalQuestions: number;
  totalMarks: number;
  duration: number;
  startTime?: string;
  testActivityStatus: string;
  testStudentMapping: { _id: string; testActivityStatus: string } | null;
  tag2?: string;
  dppQuizDetails?: {
    contentId: string;
    scheduleId: string;
    test: { _id: string; name: string; totalQuestions: number; totalMarks: number };
    testStudentMapping: Record<string, unknown>;
  };
}

export interface ScheduleEventPublic {
  _id: string;
  type: string;
  data: {
    _id: string;
    topic: string;
    startTime: string;
    endTime: string;
    status: string; // LIVE | UPCOMING | ENDED | CANCELLED
    lectureType?: string;
    urlType?: string;
    url?: string;
    slug?: string;
    batchId?: string;
    videoDetails?: { image?: string };
    subjectId?: { _id: string; slug?: string };
    teachers?: unknown;
    homeworkIds?: unknown[];
    exerciseIds?: unknown[];
  };
}

/** Resolved playable stream payload (parcham_vid). */
export interface VideoPayloadPublic {
  kind: 'dash' | 'hls' | 'youtube' | 'mp4';
  url: string;
  signedUrl?: string;
  clearKeys?: Record<string, string> | null;
  poster?: string;
  drmDetails?: unknown;
}

// ---- API wrappers (same action names as the original site) ----

export const api = {
  batchDetail: (batchId: string) =>
    parchamCore<BatchDetailPublic>('pw_btch_dtl', { batchId }),
  subjectTopics: (batchId: string, subjectId: string, tagType: string, page = 1, limit = 50) =>
    parchamCore<{ data: ChapterItemPublic[] }>('pw_sub_topics', { batchId, subjectId, tagType, page, limit }),
  resourceTopics: (batchId: string, subjectIds: string) =>
    parchamCore<{ data: ChapterItemPublic[] }>('pw_res_topics', { batchId, subjectIds }),
  scheduleContent: (batchId: string, subjectId: string, tagId: string, contentType: string, skip = 0, limit = 50) =>
    parchamCore<ContentNodePublic[]>('pw_sch_cntnt', { batchId, subjectId, tagId, contentType, skip, limit }),
  dppList: (batchId: string, batchSubjectId: string, chapterId: string, page = 1, limit = 20) =>
    parchamCore<{ data: TestItemPublic[] }>('pw_dpp_lst', { batchId, batchSubjectId, chapterId, page, limit }),
  dppStart: (p: { testId: string; batchId: string; scheduleId?: string; subjectId?: string; type?: string }) =>
    parchamCore<Record<string, unknown>>('pw_dpp_start', p),
  testList: (batchId: string, limit = 50) =>
    parchamCore<TestItemPublic[]>('pw_test_lst', { batchId, limit }),
  testDetail: (testId: string, batchId: string) =>
    parchamCore<Record<string, unknown>>('pw_test_dtl', { testId, batchId }),
  scheduleDetail: (batchId: string, scheduleId: string, subjectId: string) =>
    parchamCore<Record<string, unknown>>('pw_sch_dtl', { batchId, scheduleId, subjectId }),
  todaySchedule: (batchId: string) =>
    parchamCore<ScheduleEventPublic[]>('pw_tdy_sch', { batchId }),
  videoPayload: (childId: string, batchId: string, subjectId: string, vUrl = '', realVideoId = '') =>
    parchamCore<VideoPayloadPublic | null>('parcham_vid', { childId, batchId, subjectId, vUrl, videoId: realVideoId }),
};

interface CatalogPage {
  success: boolean;
  total: number;
  page: number;
  hasMore: boolean;
  data: BatchCatalogItem[];
  stale?: boolean;
}

export async function fetchCatalog(q: string, page: number, limit = 20) {
  const key = apiCacheKey('catalog', { q, page, limit });
  // offline → last cached page of the catalog (stale copy)
  if (isOffline()) {
    const hit = await cacheApiGet<CatalogPage>(key);
    if (hit) return { ...hit, stale: true };
  }
  try {
    const res = await fetch(`/api/batches?q=${encodeURIComponent(q)}&page=${page}&limit=${limit}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as CatalogPage;
    if (body?.success) void cacheApiPut(key, body);
    return body;
  } catch (e) {
    const hit = await cacheApiGet<CatalogPage>(key);
    if (hit) return { ...hit, stale: true };
    throw e instanceof Error ? e : new Error('Network error');
  }
}
