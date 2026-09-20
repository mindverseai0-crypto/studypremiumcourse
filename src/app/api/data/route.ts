import { NextRequest, NextResponse } from "next/server";
import {
  lxAllBatches, // (re-exported for potential tooling; catalog route uses /api/batches)
  lxBatchDetails,
  lxBatchAnnouncements,
  lxChapters,
  lxTopicContent,
  lxTodaySchedule,
  lxScheduleDetail,
  lxBatchTests,
  lxTestInstructions,
  lxDppList,
  lxStartDpp,
  lxVideoUrl,
  lxOtp,
  LxScheduleItem,
  LxContentType,
} from "@/lib/lx-api";
import {
  registerSignedFolder,
  registerFolderHost,
  folderFromUrl,
  hostFromUrl,
  subPathFromUrl,
  getSignedQuery,
  getFallbackSignedQuery,
  fetchSignedAsset,
} from "@/lib/pw-cdn";
import { lookupStoredSignature, parsePolicy } from "@/lib/signature-store";

void lxAllBatches; // catalog lives in /api/batches

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Latency guards — lecture loading used to run 3-5 serial upstream calls per
// open (video-url → signer → manifest probe → otp). Everything below makes
// repeats instant and concurrent loads share one upstream roundtrip.
// ---------------------------------------------------------------------------

type MemoEntry = { at: number; ttl: number; value: unknown };
const MEMO_MAX = 400;

function memoGet(map: Map<string, MemoEntry>, key: string): MemoEntry | null {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    map.delete(key);
    return null;
  }
  return hit;
}

function memoSet(map: Map<string, MemoEntry>, key: string, value: unknown, ttl: number): void {
  if (map.size >= MEMO_MAX) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
  map.set(key, { at: Date.now(), ttl, value });
}

/** True when the query has no Policy expiry, or the expiry is still ahead. */
function nonExpiredQuery(q: string | null): string | null {
  if (!q) return null;
  const policy = parsePolicy(q.startsWith("?") ? q : `?${q}`);
  if (policy?.exp && Math.floor(Date.now() / 1000) >= policy.exp) return null;
  return q;
}

// Shared CORS headers (same-origin frontend normally, kept for safety).
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

type Params = Record<string, unknown>;

interface ActionBody {
  action?: unknown;
  params?: unknown;
  method?: unknown;
  payload?: unknown;
}

const asParams = (v: unknown): Params =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Params) : {};

const str = (v: unknown, fallback = ""): string =>
  v === undefined || v === null ? fallback : String(v);

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Payload may arrive as object or JSON string. */
function parsePayload(payload: unknown): unknown {
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  return payload;
}

// ---------------------------------------------------------------------------
// upstream → protocol transforms
// ---------------------------------------------------------------------------

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v ? [v] : [];
}

/** PDF attachments are baked as /api/lxpdf links that resolve the real file. */
function pdfAttachmentRef(batchId: string, subjectId: string, pdfId: string, attachmentId: string) {
  const q = `batchId=${encodeURIComponent(batchId)}&subjectId=${encodeURIComponent(
    subjectId,
  )}&pdfId=${encodeURIComponent(pdfId)}&attachmentId=${encodeURIComponent(attachmentId)}`;
  return { baseUrl: `/api/lxpdf?${q}`, key: "", _id: attachmentId };
}

function subjectRef(s: unknown): { _id: string; slug: string; name: string } {
  if (s && typeof s === "object") {
    const o = s as { _id?: string; slug?: string; name?: string };
    return { _id: o._id || "", slug: o.slug || o._id || "", name: o.name || "" };
  }
  return { _id: String(s || ""), slug: String(s || ""), name: "" };
}

function eventStatus(item: LxScheduleItem, startIso: string, endIso: string): string {
  const tag = String(item.tag || "").toLowerCase();
  if (tag === "live" || tag === "live now") return "LIVE";
  if (tag === "upcoming") return "UPCOMING";
  if (tag === "ended" || tag === "cancelled") return tag === "cancelled" ? "CANCELLED" : "ENDED";
  const now = Date.now();
  const s = new Date(startIso || "").getTime();
  const e = new Date(endIso || "").getTime();
  if (Number.isFinite(s) && Number.isFinite(e)) {
    if (now >= s && now <= e) return "LIVE";
    if (now < s) return "UPCOMING";
  }
  return "ENDED";
}

function scheduleEventNode(batchId: string, item: LxScheduleItem) {
  const startIso = item.startTime || item.date || "";
  const endIso = item.endTime || "";
  const subj = subjectRef(item.subjectId);
  const image =
    (item.videoDetails && item.videoDetails.image) || item.previewImageUrl || "";
  return {
    _id: item._id || "",
    type: "LECTURE",
    data: {
      _id: item._id || "",
      topic: item.topic || item.name || "Class",
      startTime: startIso,
      endTime: endIso,
      status: eventStatus(item, startIso, endIso),
      lectureType: item.lectureType || "",
      urlType: item.urlType || "",
      url: item.url || "",
      videoDetails: { _id: item._id || "", image },
      subjectId: { _id: subj._id, slug: subj.slug },
      slug: item.slug || "",
      homeworkIds: [],
      exerciseIds: [],
      batchId,
    },
  };
}

function contentNodesFromItems(
  batchId: string,
  subjectId: string,
  items: LxScheduleItem[],
  kind: "LECTURE" | "DPP_VIDEOS" | "NOTES",
): Array<{ _id: string; type: string; data: Record<string, unknown> }> {
  const nodes: Array<{ _id: string; type: string; data: Record<string, unknown> }> = [];
  for (const item of items) {
    const pdfId = item._id || "";

    if (kind === "LECTURE" || kind === "DPP_VIDEOS") {
      const vd = item.videoDetails || {};
      nodes.push({
        _id: item._id || "",
        type: kind,
        data: {
          _id: item._id || "",
          topic: item.topic || vd.name || item.name || "Lecture",
          date: item.date || item.startTime || "",
          urlType: item.urlType || "",
          url: item.url || "",
          videoDetails: {
            _id: item._id || "",
            image: vd.image || item.previewImageUrl || "",
            videoUrl: "",
            duration: vd.duration || "",
          },
          homeworkIds: asArray(item.homeworkIds).flatMap((hw) => {
            const h = hw as { _id?: string; topic?: string; attachmentIds?: unknown[] };
            return asArray(h.attachmentIds).map((att) => {
              const a = att as { _id?: string };
              return {
                _id: h._id || "",
                topic: h.topic || "Class Note",
                attachmentIds: [pdfAttachmentRef(batchId, subjectId, pdfId, a._id || "")],
              };
            });
          }),
          exerciseIds: [],
        },
      });
      continue;
    }

    // NOTES / DppNotes → PDF cards
    const atts: Array<Record<string, unknown>> = [];
    let title = item.topic || item.name || "";
    const homeworkSources = [
      ...asArray(item.homeworkIds),
      ...asArray(item.dpp?.homeworkIds),
    ];
    for (const hw of homeworkSources) {
      const h = hw as { _id?: string; topic?: string; attachmentIds?: unknown[] };
      if (!title && h.topic) title = h.topic;
      for (const att of asArray(h.attachmentIds)) {
        const a = att as { _id?: string; key?: string; baseUrl?: string; name?: string };
        if (!a?._id) continue;
        if (!title) title = a.name || "";
        // some attachments already carry a real static.pw.live key
        const direct = a.baseUrl && a.key ? `${a.baseUrl}${a.key}` : "";
        const ref = direct
          ? { baseUrl: direct, key: "", _id: a._id }
          : pdfAttachmentRef(batchId, subjectId, pdfId, a._id);
        atts.push({
          _id: a._id,
          topic: h.topic || a.name || item.topic || item.name || "Study Material",
          attachmentIds: [ref],
        });
      }
    }
    if (atts.length === 0) continue;
    nodes.push({
      _id: item._id || "",
      type: "NOTES",
      data: {
        _id: item._id || "",
        topic: title || "Study Material",
        date: item.date || item.startTime || "",
        homeworkIds: atts,
      },
    });
  }
  return nodes;
}

function resolveContentKind(contentType: string): "LECTURE" | "DPP_VIDEOS" | "NOTES" | null {
  switch ((contentType || "ALL").toUpperCase()) {
    case "ALL":
    case "LECTURE":
      return "LECTURE";
    case "DPP_VIDEOS":
      return "DPP_VIDEOS";
    case "NOTES":
    case "DPP_PDF":
      return "NOTES";
    default:
      return null;
  }
}

function upstreamContentType(contentType: string): LxContentType {
  switch ((contentType || "ALL").toUpperCase()) {
    case "DPP_VIDEOS":
      return "DppVideos";
    case "DPP_PDF":
      return "DppNotes";
    case "NOTES":
      return "notes";
    default:
      return "videos";
  }
}

/**
 * Direct (unsigned) CloudFront urls per schedule item from the owner's
 * V2 listing API — the same source the production site merges into its
 * content lists. Best-effort: failure simply leaves the nodes untouched.
 * Memoized 5 min (60s when empty) so chapter revisits skip the roundtrip.
 */
const v2Memo = new Map<string, MemoEntry>();

async function v2DirectUrls(
  batchId: string,
  subjectId: string,
  tagId: string,
): Promise<Map<string, { url: string; videoId: string }>> {
  const memoKey = `${batchId}|${subjectId}|${tagId}`;
  const hit = memoGet(v2Memo, memoKey);
  if (hit) return hit.value as Map<string, { url: string; videoId: string }>;
  const out = await fetchV2DirectUrls(batchId, subjectId, tagId);
  memoSet(v2Memo, memoKey, out, out.size > 0 ? 5 * 60_000 : 60_000);
  return out;
}

async function fetchV2DirectUrls(
  batchId: string,
  subjectId: string,
  tagId: string,
): Promise<Map<string, { url: string; videoId: string }>> {
  const out = new Map<string, { url: string; videoId: string }>();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    const res = await fetch("https://pw.studyparcham.in/api/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: controller.signal,
      body: JSON.stringify({
        action: "pw_v2_list",
        params: { batchId, subjectId, tagId, contentType: "videos", page: 1 },
        method: "GET",
        payload: null,
      }),
    });
    clearTimeout(timer);
    if (!res.ok) return out;
    const body = (JSON.parse(await res.text()) as {
      data?: Array<{
        _id?: string;
        url?: string;
        videoDetails?: { videoUrl?: string; _id?: string };
      }>;
    });
    for (const it of body.data || []) {
      const u = it.url || it.videoDetails?.videoUrl || "";
      if (it._id && u) out.set(it._id, { url: u, videoId: it.videoDetails?._id || "" });
    }
  } catch {
    /* best-effort merge */
  }
  return out;
}

/** base64url-encode a signed query for the stateless /s/<sig>/ relay path. */
function sigPathSegment(signedQuery: string): string {
  const q = signedQuery.startsWith("?") ? signedQuery.slice(1) : signedQuery;
  if (!q) return "";
  return Buffer.from(q, "utf8").toString("base64url");
}

// ---------------------------------------------------------------------------
// Lecture stream signing chain (server-side only).
//
// 1. signedUrl from the upstream video-url API (per-video folder policy)
// 2. LECTURE_SIGN_URL env template (owner's signing service, e.g.
//    https://video-detail.studyparcham.in/?batch_id={batch_id}&video_id={video_id}&subject_id={subject_id})
// 3. non-expired fallback constants registered in pw-cdn
// ---------------------------------------------------------------------------

async function envSignerSignedQuery(
  batchId: string,
  videoId: string,
  subjectId: string,
): Promise<string> {
  const tpl = process.env.LECTURE_SIGN_URL || "";
  if (!tpl) return "";
  const url = tpl
    .replace(/\{batch_id\}/g, encodeURIComponent(batchId))
    .replace(/\{video_id\}/g, encodeURIComponent(videoId))
    .replace(/\{subject_id\}/g, encodeURIComponent(subjectId));
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0" },
    });
    clearTimeout(timer);
    if (!res.ok) return "";
    const body = (await res.json()) as {
      url?: string;
      signedUrl?: string;
      data?: { url?: string; signedUrl?: string };
    };
    const signed = body.signedUrl || body.data?.signedUrl || "";
    if (signed) return signed.startsWith("?") ? signed : `?${signed}`;
    // a signed absolute URL works too — peel off its query
    const abs = body.url || body.data?.url || "";
    if (abs.includes("Signature=")) {
      const q = abs.slice(abs.indexOf("?"));
      return q;
    }
    return "";
  } catch {
    return "";
  }
}

/** Per-folder memo for the env signing service (only successes are kept). */
const envSigMemo = new Map<string, MemoEntry>();

async function envSignerSignedQueryCached(
  folder: string,
  batchId: string,
  videoId: string,
  subjectId: string,
): Promise<string> {
  const hit = memoGet(envSigMemo, `es:${folder}`);
  if (hit) return hit.value as string;
  const signed = await envSignerSignedQuery(batchId, videoId, subjectId);
  if (signed) memoSet(envSigMemo, `es:${folder}`, signed, 10 * 60_000);
  return signed;
}

/** Resolve the folder-wide signed query for a video through the whole chain. */
async function resolveSignedQuery(
  folder: string,
  opts: { batchId: string; videoId: string; subjectId: string; signedUrl?: string },
): Promise<string> {
  if (opts.signedUrl) {
    registerSignedFolder(folder, opts.signedUrl);
    return opts.signedUrl.startsWith("?") ? opts.signedUrl : `?${opts.signedUrl}`;
  }
  // 1) Non-expired LOCAL signatures first — zero network, saves the env
  //    signer roundtrip (1-12s) on every cold load of a known folder.
  const local =
    nonExpiredQuery(getFallbackSignedQuery(folder)) ||
    nonExpiredQuery(lookupStoredSignature(folder)) ||
    nonExpiredQuery(getSignedQuery(folder));
  if (local) {
    registerSignedFolder(folder, local);
    return local;
  }
  // 2) Env signing service (memoized per folder, 8s cap).
  const envSig = await envSignerSignedQueryCached(folder, opts.batchId, opts.videoId, opts.subjectId);
  if (envSig) {
    registerSignedFolder(folder, envSig);
    return envSig;
  }
  // Nothing usable — let the caller decide (upstream signedUrl retry, error).
  return "";
}

/**
 * Same-origin relay URL for a resolved CloudFront asset — keeps the REAL
 * manifest path from the upstream url (e.g. hls/720/main.m3u8, master.mpd)
 * instead of guessing, and carries the signature statelessly in the path.
 */
async function relayUrlFor(
  rawUrl: string,
  opts: { batchId: string; videoId: string; subjectId: string; signedUrl?: string },
): Promise<{ url: string; signedQuery: string } | null> {
  const host = hostFromUrl(rawUrl);
  const folder = folderFromUrl(rawUrl);
  const sub = subPathFromUrl(rawUrl);
  if (!folder || !sub) return null;
  const signedQuery = await resolveSignedQuery(folder, { ...opts, signedUrl: opts.signedUrl || "" });
  if (host) registerFolderHost(folder, host);
  if (!signedQuery) return null;
  const sig = sigPathSegment(signedQuery);
  const hostSeg = host && host !== "d1d34p8vz63oiq.cloudfront.net" ? `/h/${host}` : "";
  return { url: `/api/pw${hostSeg}/${folder}${sig ? `/s/${sig}` : ""}/${sub}`, signedQuery };
}

/**
 * ClearKey cache — the KID and keys are stable per video folder, but probing
 * the manifest through the lane chain + otp can cost up to ~30s. Memoize per
 * folder (60 min for keys, 60s negative) with single-flight.
 */
const folderKeysMemo = new Map<string, MemoEntry>();
const folderKeysInflight = new Map<string, Promise<Record<string, string> | null>>();

async function clearKeysForFolder(
  folder: string,
  host: string,
  manifestPath: string,
  signedQuery: string,
): Promise<Record<string, string> | null> {
  if (!folder) return null;
  const hit = memoGet(folderKeysMemo, `ck:${folder}`);
  if (hit) return hit.value as Record<string, string> | null;
  const running = folderKeysInflight.get(folder);
  if (running) return running;
  const p = (async () => {
    try {
      // Probe the manifest through the same upstream lane chain the relay
      // uses (delta → pearl → direct) to extract the ClearKey KID. 8s per
      // lane keeps a dead-lane worst case bounded.
      const mpdRes = await fetchSignedAsset(host, manifestPath, signedQuery, { timeoutMs: 8000 });
      if (!mpdRes.ok) return null;
      const text = await mpdRes.text();
      const kidMatch = text.match(/default_KID="([0-9a-fA-F-]+)"/);
      if (!kidMatch) return null;
      const keys = await lxOtp(kidMatch[1]);
      if (keys && Object.keys(keys).length > 0) {
        memoSet(folderKeysMemo, `ck:${folder}`, keys, 60 * 60_000);
        return keys;
      }
      // keys unavailable right now — brief negative cache so a retry soon
      // after isn't blocked, but the next cold load re-probes.
      memoSet(folderKeysMemo, `ck:${folder}`, null, 60_000);
      return null;
    } catch {
      return null;
    } finally {
      folderKeysInflight.delete(folder);
    }
  })();
  folderKeysInflight.set(folder, p);
  return p;
}

type VideoPayload = {
  kind: "dash" | "hls" | "youtube" | "mp4";
  url: string;
  signedUrl: string;
  clearKeys: Record<string, string> | null;
  poster: string;
  drmDetails: null;
};

/** Build a same-origin playable payload for a resolved manifest/file url. */
async function payloadFromRawUrl(
  rawUrl: string,
  upstreamSignedUrl: string,
  sigOpts: { batchId: string; videoId: string; subjectId: string },
): Promise<VideoPayload | null> {
  const url = rawUrl.trim();
  if (!url) return null;
  if (/\.mpd(\?|$)/i.test(url)) {
    const relay = await relayUrlFor(url, { ...sigOpts, signedUrl: upstreamSignedUrl });
    if (!relay) return null;
    let clearKeys: Record<string, string> | null = null;
    try {
      const u = new URL(url);
      const folder = folderFromUrl(url);
      clearKeys = await clearKeysForFolder(folder, u.host, u.pathname.replace(/^\/+/, ""), relay.signedQuery);
    } catch {
      /* keys unavailable — player will surface a decrypt error */
    }
    return { kind: "dash", url: relay.url, signedUrl: "", clearKeys, poster: "", drmDetails: null };
  }
  if (/\.m3u8(\?|$)/i.test(url)) {
    const relay = await relayUrlFor(url, { ...sigOpts, signedUrl: upstreamSignedUrl });
    if (!relay) return null;
    return { kind: "hls", url: relay.url, signedUrl: "", clearKeys: null, poster: "", drmDetails: null };
  }
  if (/youtube\.com|youtu\.be/i.test(url)) {
    return { kind: "youtube", url, signedUrl: "", clearKeys: null, poster: "", drmDetails: null };
  }
  // plain file (mp4 etc.) inside the signed folder
  const relay = await relayUrlFor(url, { ...sigOpts, signedUrl: upstreamSignedUrl });
  if (!relay) return null;
  return { kind: "mp4", url: relay.url, signedUrl: "", clearKeys: null, poster: "", drmDetails: null };
}

/** Resolve a video → same-origin playable payload (dash/hls/youtube/mp4). */
async function resolveVideoPayload(
  childId: string,
  batchId: string,
  subjectId: string,
  vUrlParam = "",
  realVideoId = "",
) {
  const sigOpts = { batchId, videoId: realVideoId || childId, subjectId };
  const direct = vUrlParam.trim();

  // FAST PATH: the lecture list already carries the CloudFront manifest url
  // (v2 merge). Skip the slow upstream video-url roundtrip entirely and sign
  // from local/env sources; only when no signature is available do we fall
  // through to the full chain below.
  if (direct && /\.cloudfront\.net/i.test(direct)) {
    const fast = await payloadFromRawUrl(direct, "", sigOpts);
    if (fast) return fast;
  }

  let vid = await lxVideoUrl(batchId, subjectId, childId).catch(() => null);
  if (!vid && realVideoId && realVideoId !== childId) {
    vid = await lxVideoUrl(batchId, subjectId, realVideoId).catch(() => null);
  }
  const rawUrl = vid?.url?.trim() || direct;
  if (rawUrl) {
    const payload = await payloadFromRawUrl(rawUrl, vid?.signedUrl || "", sigOpts);
    if (payload) return payload;
  }

  // No signed stream — maybe a youtube lecture.
  if (subjectId) {
    const detail = await lxScheduleDetail(batchId, subjectId, childId).catch(() => null);
    const url = (detail as { url?: string } | null)?.url || "";
    if (url && /youtube\.com|youtu\.be/i.test(url)) {
      return { kind: "youtube", url, signedUrl: "", clearKeys: null, poster: "", drmDetails: null };
    }
  }
  return null;
}

/**
 * Memoized entry point for the parcham_vid action.
 *  - full payload .............. 10 min
 *  - dash without clearKeys ..... 45s (probe failed — retry soon)
 *  - unavailable (null) ......... 30s negative cache (no upstream hammering)
 * Concurrent identical requests share one in-flight resolution.
 */
const videoMemo = new Map<string, MemoEntry>();
const videoInflight = new Map<string, Promise<VideoPayload | null>>();

async function resolveVideoPayloadCached(
  childId: string,
  batchId: string,
  subjectId: string,
  vUrlParam = "",
  realVideoId = "",
): Promise<VideoPayload | null> {
  const key = `${batchId}|${subjectId}|${childId}|${realVideoId}|${(vUrlParam || "").split("?")[0]}`;
  const hit = memoGet(videoMemo, key);
  if (hit) return hit.value as VideoPayload | null;
  const running = videoInflight.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      const value = await resolveVideoPayload(childId, batchId, subjectId, vUrlParam, realVideoId);
      const hasKeys = value?.kind === "dash" ? !!value.clearKeys : true;
      const ttl = !value ? 30_000 : hasKeys ? 10 * 60_000 : 45_000;
      memoSet(videoMemo, key, value, ttl);
      return value;
    } finally {
      videoInflight.delete(key);
    }
  })();
  videoInflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// POST /api/data — action API (real upstream data, transformed)
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as ActionBody;
    const action = typeof body.action === "string" ? body.action : "";
    const params = asParams(body.params);
    const payload = parsePayload(body.payload);

    switch (action) {
      case "pw_btch_dtl": {
        const batchId = str(params.batchId).trim();
        if (!batchId) return NextResponse.json({ success: false }, { headers: CORS_HEADERS });
        const d = await lxBatchDetails(batchId);
        if (!d) return NextResponse.json({ success: false }, { headers: CORS_HEADERS });

        const exams = Array.isArray(d.exam)
          ? (d.exam as unknown[])
              .map((e) => (typeof e === "string" ? e : (e as { name?: string })?.name || ""))
              .filter(Boolean)
          : [];
        const subjects = Array.isArray(d.subjects) ? d.subjects : [];
        return NextResponse.json(
          {
            success: true,
            data: {
              _id: d._id || batchId,
              id: d.slug || batchId,
              name: d.name || "Batch",
              byName: d.byName || "",
              description: typeof d.description === "string" ? d.description : "",
              imageUrl: d.previewImage || d.previewImageUrl || "",
              exams,
              language: d.language || "",
              className:
                typeof d.class === "string"
                  ? d.class
                  : Array.isArray(d.class)
                    ? (d.class as unknown[]).map((c) => String(c)).join(", ")
                    : "",
              amount: typeof d.feeTotal === "number" ? d.feeTotal : null,
              startDate: d.startDate || "",
              endDate: d.endDate || "",
              // subject mapping — subjectId = SLUG (SubjectInfo/TopicInfo are
              // slug-addressed), batchSubjectId & masterId for dpp/schedule apis
              subjects: subjects.map((s) => ({
                _id: s.slug || s.subjectId || s._id || "",
                subject: s.subject || "",
                subjectId: s.slug || s.subjectId || "",
                batchSubjectId: s._id || "",
                masterId: s.subjectId || "",
              })),
            },
          },
          { headers: CORS_HEADERS },
        );
      }

      case "pw_sub_topics": {
        const batchId = str(params.batchId).trim();
        const subjectId = str(params.subjectId).trim();
        const page = num(params.page, 1);
        if (!batchId || !subjectId) {
          return NextResponse.json({ success: true, data: { data: [] } }, { headers: CORS_HEADERS });
        }
        try {
          const chapters = await lxChapters(batchId, subjectId, page);
          const data = chapters.map((c, i) => ({
            _id: c._id || "",
            name: c.name || "Chapter",
            typeId: subjectId,
            notes: Number(c.notes || 0),
            videos: Number(c.videos || c.lectureVideos || 0),
            exercises: Number(c.exercises || 0),
            order: Number.isFinite(c.displayOrder) ? Number(c.displayOrder) : i,
          }));
          return NextResponse.json({ success: true, data: { data } }, { headers: CORS_HEADERS });
        } catch {
          return NextResponse.json({ success: true, data: { data: [] } }, { headers: CORS_HEADERS });
        }
      }

      case "pw_res_topics":
        // upstream has no separate resource folders
        return NextResponse.json({ success: true, data: { data: [] } }, { headers: CORS_HEADERS });

      case "pw_sch_cntnt": {
        const batchId = str(params.batchId).trim();
        const subjectId = str(params.subjectId).trim();
        const tagId = str(params.tagId).trim();
        const contentType = str(params.contentType, "ALL");
        const page = num(params.page, 1);
        if (!batchId || !subjectId || !tagId) {
          return NextResponse.json({ success: true, data: [] }, { headers: CORS_HEADERS });
        }
        const kind = resolveContentKind(contentType);
        if (!kind) return NextResponse.json({ success: true, data: [] }, { headers: CORS_HEADERS });
        try {
          const items = await lxTopicContent(batchId, subjectId, tagId, upstreamContentType(contentType), page);
          const nodes = contentNodesFromItems(batchId, subjectId, items, kind);
          if (kind === "LECTURE" || kind === "DPP_VIDEOS") {
            // Magic merge: inject the direct V2 video urls into the nodes so
            // the player can resolve a stream even when video-url is gated.
            const v2 = await v2DirectUrls(batchId, subjectId, tagId);
            if (v2.size > 0) {
              for (const n of nodes) {
                const hit = v2.get(n._id);
                if (!hit) continue;
                const d = n.data as Record<string, unknown>;
                d.url = hit.url;
                const vd = d.videoDetails as Record<string, unknown> | undefined;
                if (vd) {
                  vd.videoUrl = hit.url;
                  if (hit.videoId) vd._id = hit.videoId;
                }
              }
            }
          }
          return NextResponse.json({ success: true, data: nodes }, { headers: CORS_HEADERS });
        } catch {
          return NextResponse.json({ success: true, data: [] }, { headers: CORS_HEADERS });
        }
      }

      case "pw_dpp_lst": {
        const batchId = str(params.batchId).trim();
        const batchSubjectId = str(params.batchSubjectId).trim();
        const chapterId = str(params.chapterId).trim();
        const page = num(params.page, 1);
        const limit = num(params.limit, 20);
        if (!batchId || !batchSubjectId || !chapterId) {
          return NextResponse.json({ success: true, data: { data: [] } }, { headers: CORS_HEADERS });
        }
        try {
          const items = await lxDppList(batchId, batchSubjectId, chapterId, page, limit);
          const data = items
            .map((it) => {
              const q = it.dppQuizDetails;
              const t = q?.test;
              if (!t?._id) return null;
              return {
                _id: t._id,
                name: t.name || "DPP",
                totalQuestions: Number(t.totalQuestions || 0),
                totalMarks: Number(t.totalMarks || 0),
                duration: Number(t.maxDuration || 0) * 60 || 1800,
                testActivityStatus: "Not Started",
                testStudentMapping: null,
                dppQuizDetails: {
                  contentId: q?.contentId || t._id,
                  scheduleId: q?.scheduleId || "",
                  test: {
                    _id: t._id,
                    name: t.name || "DPP",
                    totalQuestions: Number(t.totalQuestions || 0),
                    totalMarks: Number(t.totalMarks || 0),
                  },
                  testStudentMapping: { testActivityStatus: q?.tag || "Start" },
                },
              };
            })
            .filter(Boolean);
          return NextResponse.json({ success: true, data: { data } }, { headers: CORS_HEADERS });
        } catch {
          return NextResponse.json({ success: true, data: { data: [] } }, { headers: CORS_HEADERS });
        }
      }

      case "pw_dpp_start": {
        // Auth-gated upstream: anonymous calls fail → surfaced honestly.
        const testId = str(params.testId).trim();
        const batchId = str(params.batchId).trim();
        if (!testId || !batchId) {
          return NextResponse.json(
            { success: false, error: "testId and batchId are required" },
            { headers: CORS_HEADERS },
          );
        }
        try {
          const data = await lxStartDpp({
            testId,
            batchId,
            type: str(params.type, "Start"),
            scheduleId: str(params.scheduleId),
            batchScheduleId: str(params.batchScheduleId) || str(params.scheduleId),
            subjectId: str(params.subjectId),
          });
          return NextResponse.json({ success: true, data }, { headers: CORS_HEADERS });
        } catch (e) {
          return NextResponse.json(
            { success: false, error: e instanceof Error ? e.message : "Failed to start DPP" },
            { headers: CORS_HEADERS },
          );
        }
      }

      case "pw_test_lst": {
        const batchId = str(params.batchId).trim();
        if (!batchId) return NextResponse.json({ success: true, data: [] }, { headers: CORS_HEADERS });
        try {
          const tests = await lxBatchTests(batchId);
          const data = tests.map((t) => {
            const o = t as Record<string, unknown>;
            return {
              _id: str(o._id),
              name: str(o.name, "Test"),
              totalQuestions: Number(o.totalQuestions || 0),
              totalMarks: Number(o.totalMarks || 0),
              duration: Number(o.maxDuration || 0) * 60 || 3600,
              startTime: str(o.startTime),
              testActivityStatus: "Not Started",
              testStudentMapping: null,
              tag2: str(o.tag2, "Start"),
            };
          });
          return NextResponse.json({ success: true, data }, { headers: CORS_HEADERS });
        } catch {
          return NextResponse.json({ success: true, data: [] }, { headers: CORS_HEADERS });
        }
      }

      case "pw_test_dtl": {
        const testId = str(params.testId).trim();
        const batchId = str(params.batchId).trim();
        if (!testId || !batchId) {
          return NextResponse.json({ success: true, data: null }, { headers: CORS_HEADERS });
        }
        const data = await lxTestInstructions(testId, batchId);
        return NextResponse.json({ success: true, data }, { headers: CORS_HEADERS });
      }

      case "pw_sch_dtl": {
        const batchId = str(params.batchId).trim();
        const scheduleId = str(params.scheduleId).trim();
        const subjectId = str(params.subjectId).trim();
        if (!batchId || !scheduleId || !subjectId) {
          return NextResponse.json({ success: true, data: null }, { headers: CORS_HEADERS });
        }
        const detail = await lxScheduleDetail(batchId, subjectId, scheduleId);
        if (!detail) return NextResponse.json({ success: true, data: null }, { headers: CORS_HEADERS });

        const homeworkIds = [...asArray(detail.homeworkIds), ...asArray(detail.dpp?.homeworkIds)]
          .flatMap((hw) => {
            const h = hw as { _id?: string; topic?: string; attachmentIds?: unknown[] };
            return asArray(h.attachmentIds).map((att) => {
              const a = att as { _id?: string; key?: string; baseUrl?: string };
              if (!a?._id) return null;
              const direct = a.baseUrl && a.key ? `${a.baseUrl}${a.key}` : "";
              const ref = direct
                ? { baseUrl: direct, key: "", _id: a._id }
                : pdfAttachmentRef(batchId, subjectId, detail._id || scheduleId, a._id);
              return { _id: h._id || "", topic: h.topic || "Class Note", attachmentIds: [ref] };
            });
          })
            .filter(Boolean) as Array<Record<string, unknown>>;

        return NextResponse.json(
          {
            success: true,
            data: {
              _id: detail._id || scheduleId,
              topic: detail.topic || detail.name || "",
              startTime: detail.startTime || "",
              endTime: detail.endTime || "",
              urlType: detail.urlType || "",
              homeworkIds,
              exerciseIds: [],
            },
          },
          { headers: CORS_HEADERS },
        );
      }

      case "pw_tdy_sch": {
        const batchId = str(params.batchId).trim();
        if (!batchId) return NextResponse.json({ success: true, data: [] }, { headers: CORS_HEADERS });
        const items = await lxTodaySchedule(batchId);
        const data = items.map((it) => scheduleEventNode(batchId, it));
        return NextResponse.json({ success: true, data }, { headers: CORS_HEADERS });
      }

      case "pw_notifs": {
        const batchId = str(params.batchId).trim();
        const page = num(params.page, 1);
        if (!batchId) {
          return NextResponse.json({ success: true, data: [], hasMore: false }, { headers: CORS_HEADERS });
        }
        const anns = await lxBatchAnnouncements(batchId, page);
        const data = anns.map((a) => {
          const o = a as Record<string, unknown>;
          return {
            _id: str(o._id),
            type: str(o.type, "GENERAL"),
            heading: str(o.announcement, "").slice(0, 80),
            announcement: str(o.announcement, ""),
            scheduleTime: str(o.createdAt || o.updatedAt),
            isRead: false,
          };
        });
        return NextResponse.json({ success: true, data, hasMore: anns.length >= 20 }, { headers: CORS_HEADERS });
      }

      case "pw_tchr_dtl":
        return NextResponse.json({ success: true, data: null }, { headers: CORS_HEADERS });

      case "parcham_vid": {
        const childId = str(params.childId).trim();
        const batchId = str(params.batchId).trim();
        const subjectId = str(params.subjectId).trim();
        const vUrl = str(params.vUrl).trim();
        const realVideoId = str(params.videoId).trim();
        if (!childId || !batchId || !subjectId) {
          return NextResponse.json({ success: false }, { headers: CORS_HEADERS });
        }
        try {
          const data = await resolveVideoPayloadCached(childId, batchId, subjectId, vUrl, realVideoId);
          if (!data) {
            return NextResponse.json(
              {
                success: false,
                error:
                  "Stream unavailable — every upstream signing source is gated for this batch. If you have a signed lecture URL, paste it below to unlock playback.",
              },
              { headers: CORS_HEADERS },
            );
          }
          return NextResponse.json({ success: true, data }, { headers: CORS_HEADERS });
        } catch (e) {
          return NextResponse.json(
            { success: false, error: e instanceof Error ? e.message : "Stream resolution failed" },
            { headers: CORS_HEADERS },
          );
        }
      }

      case "pw_test_map": {
        // testId may be single or array; can live in params or payload.
        const payloadParams = asParams(payload);
        const raw: unknown =
          params.testId ??
          payloadParams.testId ??
          (Array.isArray(payload) ? payload : undefined);
        const ids: string[] = [];
        collectTestIds(raw, ids, new Set<string>());
        const data = ids.map((testId) => ({
          testId,
          tag2: "Start",
          testStudentMapping: {
            _id: `map_${testId}`,
            testActivityStatus: "Not Started",
          },
        }));
        return NextResponse.json({ success: true, data }, { headers: CORS_HEADERS });
      }

      default:
        return NextResponse.json(
          { success: false, error: "Unknown action" },
          { status: 400, headers: CORS_HEADERS },
        );
    }
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}

/** Flatten test ids from scalars / arrays / objects ({testId}|{_id}|{id}). */
function collectTestIds(source: unknown, out: string[], seen: Set<string>): void {
  if (source === undefined || source === null) return;
  if (Array.isArray(source)) {
    source.forEach((item) => collectTestIds(item, out, seen));
    return;
  }
  if (typeof source === "object") {
    const o = source as Record<string, unknown>;
    collectTestIds(o.testId ?? o._id ?? o.id, out, seen);
    return;
  }
  const s = String(source).trim();
  if (s && !seen.has(s)) {
    seen.add(s);
    out.push(s);
  }
}
