// ============================================================================
// Player extras API — slides / notes / attachments for the current lecture.
//
// GET /api/player/extras?batchId&scheduleId&subjectId&videoId
//   → { success: true, slides: [{name,url}], notes: [...], attachments: [...] }
//
// All params optional, but at least scheduleId or videoId is expected
// (whichever is present is used as the upstream content id). The upstream
// schedule-detail call is guarded by a 12s timeout; ANY failure, timeout or
// unexpected upstream shape degrades to a 200 with empty arrays + `warning`
// so the player panel never hangs or breaks.
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { lxScheduleDetail, LxScheduleItem } from '@/lib/lx-api';

export const dynamic = 'force-dynamic';

const UPSTREAM_TIMEOUT_MS = 12_000;

interface ExtrasItem {
  name: string;
  url: string;
}

const TIMEOUT = Symbol('lx-extras-timeout');

// ---------------------------------------------------------------------------
// small shape-tolerant helpers
// ---------------------------------------------------------------------------

/** Last path segment of a key/url, decoded; '' when nothing usable. */
function fileNameOf(keyOrUrl: string): string {
  const clean = (keyOrUrl || '').split('?')[0];
  const last = clean.substring(clean.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** baseUrl+key → absolute http(s) url (or the key itself when already absolute). */
function absoluteUrl(baseUrl: unknown, key: unknown): string | null {
  const b = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  const k = typeof key === 'string' ? key.trim() : '';
  if (!b && !k) return null;
  if (/^https?:\/\//i.test(k)) return k;
  if (!b || !/^https?:\/\//i.test(b)) return null;
  return `${b}${k}`;
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/** Collect one doc-ish entry (string url | {baseUrl,key} | {url} | arrays of those). */
function pushDocLike(target: ExtrasItem[], value: unknown, fallbackName: string): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const entry of value) pushDocLike(target, entry, fallbackName);
    return;
  }
  if (isHttpUrl(value)) {
    const url = value.trim();
    target.push({ name: fileNameOf(url) || fallbackName, url });
    return;
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const url =
      absoluteUrl(o.baseUrl, o.key) ?? (isHttpUrl(o.url) ? (o.url as string).trim() : null);
    if (!url) return;
    const name =
      typeof o.name === 'string' && o.name.trim()
        ? o.name.trim()
        : fileNameOf(url) || fallbackName;
    target.push({ name, url });
  }
}

/** Flatten homework/exercise-style nodes: [{ topic?, title?, attachmentIds?: [{baseUrl,key}] }] */
function flattenContentNodes(
  target: ExtrasItem[],
  nodes: unknown,
  topicOf: (node: Record<string, unknown>) => string,
): void {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const o = node as Record<string, unknown>;
    const topic = topicOf(o);
    const attachments = Array.isArray(o.attachmentIds) ? o.attachmentIds : [];
    for (const att of attachments) {
      if (!att || typeof att !== 'object') continue;
      const a = att as Record<string, unknown>;
      const url = absoluteUrl(a.baseUrl, a.key);
      if (!url) continue;
      const provided = typeof a.name === 'string' ? a.name.trim() : '';
      target.push({
        name: provided || topic || fileNameOf(url) || 'Document',
        url,
      });
    }
  }
}

function dedupeByUrl(items: ExtrasItem[]): ExtrasItem[] {
  const seen = new Set<string>();
  const out: ExtrasItem[] = [];
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry),
  );
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const batchId = (searchParams.get('batchId') || '').trim();
  const scheduleId = (searchParams.get('scheduleId') || '').trim();
  const subjectId = (searchParams.get('subjectId') || '').trim();
  const videoId = (searchParams.get('videoId') || '').trim();

  const contentId = scheduleId || videoId;

  try {
    if (!contentId) {
      return NextResponse.json({
        success: true,
        slides: [],
        notes: [],
        attachments: [],
        warning: 'scheduleId or videoId is required',
      });
    }

    const raced = await Promise.race([
      lxScheduleDetail(batchId, subjectId, contentId),
      new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), UPSTREAM_TIMEOUT_MS)),
    ]);

    if (raced === TIMEOUT) {
      return NextResponse.json({
        success: true,
        slides: [],
        notes: [],
        attachments: [],
        warning: 'upstream request timed out',
      });
    }
    if (!raced || typeof raced !== 'object') {
      return NextResponse.json({
        success: true,
        slides: [],
        notes: [],
        attachments: [],
        warning: 'schedule detail not found upstream',
      });
    }

    const detail = raced as LxScheduleItem & Record<string, unknown>;
    const videoDetails =
      detail.videoDetails && typeof detail.videoDetails === 'object'
        ? (detail.videoDetails as unknown as Record<string, unknown>)
        : null;

    // notes: homework attachments (upstream also nests DPP notes under dpp.homeworkIds —
    // the frontend LectureData shape sees them merged, so merge here too).
    const notes: ExtrasItem[] = [];
    flattenContentNodes(notes, detail.homeworkIds, (n) =>
      typeof n.topic === 'string' ? n.topic.trim() : '',
    );
    flattenContentNodes(notes, (detail.dpp as Record<string, unknown> | null | undefined)?.homeworkIds, (n) =>
      typeof n.topic === 'string' ? n.topic.trim() : '',
    );

    // attachments: exercise/DPP attachments
    const attachments: ExtrasItem[] = [];
    flattenContentNodes(attachments, detail.exerciseIds, (n) => {
      for (const field of ['title', 'topic', 'name'] as const) {
        const v = n[field];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      return '';
    });

    // slides: doc-ish fields directly on the item or its videoDetails
    const slides: ExtrasItem[] = [];
    const slideSources: Array<Record<string, unknown>> = [detail];
    if (videoDetails) slideSources.push(videoDetails as Record<string, unknown>);
    const DOC_FIELDS = ['videoDocUrl', 'docUrl', 'slidesUrl', 'docUrlObj', 'attachmentIds'] as const;
    for (const source of slideSources) {
      for (const field of DOC_FIELDS) {
        pushDocLike(slides, source[field], 'Slides');
      }
    }

    return NextResponse.json({
      success: true,
      slides: dedupeByUrl(slides),
      notes: dedupeByUrl(notes),
      attachments: dedupeByUrl(attachments),
    });
  } catch (error) {
    console.error('[api/player/extras] GET failed:', error);
    return NextResponse.json({
      success: true,
      slides: [],
      notes: [],
      attachments: [],
      warning: 'unexpected error while loading extras',
    });
  }
}
