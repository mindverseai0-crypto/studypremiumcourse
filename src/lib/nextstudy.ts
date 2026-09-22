// ============================================================================
// NextStudy stream fallback (server-side only).
//
// For lectures/batches whose normal playback chain is gated — no per-folder
// CloudFront signature is obtainable from any local source (fallback table,
// signature store, memory registry, env signer, learnxpw video-url) — the
// user-directed fallback is the pw-nextstudy.ai.studio streaming API:
//
//   GET /api/resolve-m3u8?videoId=..&scheduleId=..&batchId=..&subjectId=..
//     → { success, streamUrl, streamType, directUrl, m3u8Url, title }
//       streamUrl = the video's canonical (UNSIGNED) CloudFront url,
//       m3u8Url   = their own proxy endpoint for the same content.
//   GET /api/stream.m3u8?videoId=..[&url=<encoded cloudfront url>]
//     → HLS master playlist whose variants + segments are ABSOLUTE URLs
//       back to their origin (api/stream.m3u8?url=… / api/segment-proxy?url=…).
//
// Their proxy serves the DRM-packaged folders (media-N Bento4 trees). The
// Pallycon DRM content inside is FairPlay SAMPLE-AES and CANNOT be decoded
// in a browser without PW's license server — the /api/next relay serves it
// anyway (so the wiring is complete) and the player surfaces the honest
// DRM error. Non-DRM content that their proxy can serve plays directly.
//
// Companion module: ns-api.ts (penpencil v1/videos metadata → drmProtected).
// ============================================================================

/** Upstream origin of the NextStudy streaming API (env override). */
export function nsStreamBase(): string {
  return (process.env.NS_STREAM_BASE || "https://pw-nextstudy.ai.studio").replace(/\/+$/, "");
}

export interface NsStreamResolution {
  success: boolean;
  streamType: string;
  streamUrl: string;
  directUrl: string;
  m3u8Url: string;
  title: string;
}

// ---------------------------------------------------------------------------
// Memoized resolve-m3u8 caller (10 min, LRU 400). Null results stay in the
// cache briefly so a gated lecture doesn't re-hit upstream on every open.
// ---------------------------------------------------------------------------

type MemoEntry = { at: number; value: NsStreamResolution | null };
const MEMO_MAX = 400;
const OK_TTL_MS = 10 * 60_000;
const NULL_TTL_MS = 60_000;
const memo = new Map<string, MemoEntry>();

function memoGet(key: string): MemoEntry | null {
  const hit = memo.get(key);
  if (!hit) return null;
  const ttl = hit.value ? OK_TTL_MS : NULL_TTL_MS;
  if (Date.now() - hit.at > ttl) {
    memo.delete(key);
    return null;
  }
  return hit;
}

function memoSet(key: string, value: NsStreamResolution | null): void {
  if (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest) memo.delete(oldest);
  }
  memo.set(key, { at: Date.now(), value });
}

function memoizeKey(params: {
  videoId?: string;
  scheduleId?: string;
  batchId?: string;
  subjectId?: string;
  title?: string;
}): string {
  return [params.videoId || "", params.scheduleId || "", params.batchId || "", params.subjectId || ""].join("|");
}

/**
 * Resolve a lecture to its stream via the NextStudy resolver. Returns null
 * on any failure (never throws). videoId is the key param — scheduleId /
 * batchId / subjectId / title only help their backend disambiguate.
 */
export async function nsResolveM3u8(params: {
  videoId?: string;
  scheduleId?: string;
  batchId?: string;
  subjectId?: string;
  title?: string;
}): Promise<NsStreamResolution | null> {
  const videoId = (params.videoId || "").trim();
  if (!videoId) return null;
  const key = memoizeKey(params);
  const hit = memoGet(key);
  if (hit) return hit.value;

  const q = new URLSearchParams();
  q.set("videoId", videoId);
  if (params.scheduleId) q.set("scheduleId", params.scheduleId);
  if (params.batchId) q.set("batchId", params.batchId);
  if (params.subjectId) q.set("subjectId", params.subjectId);
  if (params.title) q.set("title", params.title);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${nsStreamBase()}/api/resolve-m3u8?${q.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      },
    });
    if (!res.ok) {
      memoSet(key, null);
      return null;
    }
    const body = (await res.json()) as Partial<NsStreamResolution> | null;
    if (!body || !body.success || !body.m3u8Url) {
      memoSet(key, null);
      return null;
    }
    const value: NsStreamResolution = {
      success: true,
      streamType: String(body.streamType || "hls"),
      streamUrl: String(body.streamUrl || ""),
      directUrl: String(body.directUrl || ""),
      m3u8Url: String(body.m3u8Url || ""),
      title: String(body.title || ""),
    };
    memoSet(key, value);
    return value;
  } catch {
    memoSet(key, null);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Relay URL mapping — any pw-nextstudy URL becomes a same-origin /api/next/*
// URL (path + query passed through). The /api/next/[...path] route proxies it.
// ---------------------------------------------------------------------------

/** Map an upstream (pw-nextstudy) URL to its same-origin relay path, or null. */
export function nsRelayUrlFromUpstream(upstreamUrl: string): string | null {
  try {
    const u = new URL(upstreamUrl.trim());
    if (u.host.toLowerCase() !== new URL(nsStreamBase()).host.toLowerCase()) return null;
    return `/api/next${u.pathname}${u.search || ""}`;
  } catch {
    return null;
  }
}

/** Wrap the resolver's m3u8Url into our relay (returns null when unusable). */
export function nsRelayPlaylistUrl(m3u8Url: string): string | null {
  const raw = (m3u8Url || "").trim();
  if (!/^https:\/\//i.test(raw)) return null;
  return nsRelayUrlFromUpstream(raw);
}
