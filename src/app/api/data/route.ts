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
} from "@/lib/pw-cdn";

void lxAllBatches; // catalog lives in /api/batches

export const dynamic = "force-dynamic";

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
 */
async function v2DirectUrls(
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
    const timer = setTimeout(() => controller.abort(), 12000);
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

/** Resolve the folder-wide signed query for a video through the whole chain. */
async function resolveSignedQuery(
  folder: string,
  opts: { batchId: string; videoId: string; subjectId: string; signedUrl?: string },
): Promise<string> {
  if (opts.signedUrl) {
    registerSignedFolder(folder, opts.signedUrl);
    return opts.signedUrl.startsWith("?") ? opts.signedUrl : `?${opts.signedUrl}`;
  }
  const envSig = await envSignerSignedQuery(opts.batchId, opts.videoId, opts.subjectId);
  if (envSig) {
    registerSignedFolder(folder, envSig);
    return envSig;
  }
  const fb = getFallbackSignedQuery(folder);
  if (fb) {
    registerSignedFolder(folder, fb);
    return fb;
  }
  const cached = getSignedQuery(folder);
  return cached || "";
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

/** Resolve a video → same-origin playable payload (dash/hls/youtube/mp4). */
async function resolveVideoPayload(
  childId: string,
  batchId: string,
  subjectId: string,
  vUrlParam = "",
  realVideoId = "",
) {
  let vid = await lxVideoUrl(batchId, subjectId, childId).catch(() => null);
  if (!vid && realVideoId && realVideoId !== childId) {
    vid = await lxVideoUrl(batchId, subjectId, realVideoId).catch(() => null);
  }
  const sigOpts = { batchId, videoId: realVideoId || childId, subjectId };
  const rawUrl = vid?.url?.trim() || vUrlParam.trim();
  if (rawUrl) {
    const url = rawUrl;
    if (/\.mpd(\?|$)/i.test(url)) {
      const relay = await relayUrlFor(url, { ...sigOpts, signedUrl: vid?.signedUrl || "" });
      if (!relay) return null;
      let clearKeys: Record<string, string> | null = null;
      try {
        const upstreamBase = process.env.PW_CDN_DIRECT === "1" ? "" : "https://proxy.studyparcham.in/";
        const abs = upstreamBase
          ? `${upstreamBase}${new URL(url).host}${new URL(url).pathname}${relay.signedQuery}`
          : `${url}${relay.signedQuery}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        const mpdRes = await fetch(abs, {
          cache: "no-store",
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        });
        clearTimeout(timer);
        if (mpdRes.ok) {
          const text = await mpdRes.text();
          const kidMatch = text.match(/default_KID="([0-9a-fA-F-]+)"/);
          if (kidMatch) {
            clearKeys = await lxOtp(kidMatch[1]);
          }
        }
      } catch {
        /* keys unavailable — player will surface a decrypt error */
      }
      return {
        kind: "dash",
        url: relay.url,
        signedUrl: "",
        clearKeys,
        poster: "",
        drmDetails: null,
      };
    }
    if (/\.m3u8(\?|$)/i.test(url)) {
      const relay = await relayUrlFor(url, { ...sigOpts, signedUrl: vid?.signedUrl || "" });
      if (!relay) return null;
      return {
        kind: "hls",
        url: relay.url,
        signedUrl: "",
        clearKeys: null,
        poster: "",
        drmDetails: null,
      };
    }
    if (/youtube\.com|youtu\.be/i.test(url)) {
      return { kind: "youtube", url, signedUrl: "", clearKeys: null, poster: "", drmDetails: null };
    }
    // plain file (mp4 etc.) inside the signed folder
    const relay = await relayUrlFor(url, { ...sigOpts, signedUrl: vid?.signedUrl || "" });
    if (!relay) return null;
    return {
      kind: "mp4",
      url: relay.url,
      signedUrl: "",
      clearKeys: null,
      poster: "",
      drmDetails: null,
    };
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
          const data = await resolveVideoPayload(childId, batchId, subjectId, vUrl, realVideoId);
          if (!data) return NextResponse.json({ success: false }, { headers: CORS_HEADERS });
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
