// ============================================================================
// NextStudy lecture source (scraped from pw-nextstudy.ai.studio).
//
// That site is a thin client over the OFFICIAL Physics Wallah API
// (api.penpencil.co). Its bundle revealed the whole pipeline, of which the
// video-URL resolver is open and useful to us:
//
//   batch catalog   https://rarestudy.github.io/rarestudy/batches.json
//   API proxy       https://api.studyspark.study/api/penpencil/<path>
//                   (also proxy.streamvideo.co.in/fetch/api.penpencil.co,
//                    vidcloud.eu.org/api, vidcloud.eu.org/fetch/api.penpencil.co)
//   auth token      https://vidcloud.eu.org/generate_token.php (fresh PW JWT)
//                   with the well-known anonymous guest JWT as fallback
//   video resolver  GET <proxy>/v1/videos/{videoId}
//                   → { success, data: { name, videoUrl, duration,
//                        types: ["DASH","HLS"], drmProtected, status } }
//                   videoUrl = https://d1d34p8vz63oiq.cloudfront.net/<folder>/master.mpd
//
// The url is UNSIGNED (signature lanes live in pw-cdn.ts) — this module only
// maps videoId → canonical folder/metadata. Server-side only.
// ============================================================================

export interface NsVideoMeta {
  videoId: string;
  name: string;
  videoUrl: string;
  host: string;
  folder: string;
  /** e.g. ["DASH","HLS"] — when HLS is advertised, master.m3u8 exists too. */
  types: string[];
  drmProtected: boolean;
  duration: string;
}

const NS_API_BASE = (process.env.NS_API_BASE || "https://api.studyspark.study/api/penpencil").replace(/\/+$/, "");
const NS_GUEST_TOKEN =
  process.env.NS_GUEST_TOKEN ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M";
const NS_TIMEOUT_MS = 9000;
const NS_CACHE_TTL_MS = 30 * 60 * 1000;

const cache = new Map<string, { meta: NsVideoMeta | null; at: number }>();
const MAX_CACHE = 1000;

function cacheGet(id: string): NsVideoMeta | null | undefined {
  const hit = cache.get(id);
  if (!hit) return undefined;
  if (Date.now() - hit.at > NS_CACHE_TTL_MS) {
    cache.delete(id);
    return undefined;
  }
  return hit.meta;
}

function cacheSet(id: string, meta: NsVideoMeta | null): void {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(id, { meta, at: Date.now() });
}

function folderAndHost(url: string): { host: string; folder: string } {
  try {
    const u = new URL(url);
    const folder = u.pathname.split("/").filter(Boolean)[0] || "";
    return { host: u.host, folder };
  } catch {
    return { host: "", folder: "" };
  }
}

/**
 * Resolve a PW videoId to its canonical lecture URL + metadata through the
 * NextStudy/penpencil pipeline. Returns null on any failure (never throws).
 */
export async function nsVideoMeta(videoId: string): Promise<NsVideoMeta | null> {
  const id = (videoId || "").trim();
  if (!id || !/^[a-f0-9]{16,32}$/i.test(id)) return null;
  const cached = cacheGet(id);
  if (cached !== undefined) return cached;

  const url = `${NS_API_BASE}/v1/videos/${encodeURIComponent(id)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${NS_GUEST_TOKEN}`,
        token: NS_GUEST_TOKEN,
        "client-type": "WEB",
        client_type: "WEB",
        "client-version": "1.0.0",
        randomId: "studybison_server",
      },
    });
    if (!res.ok) {
      cacheSet(id, null);
      return null;
    }
    const body = (await res.json()) as {
      success?: boolean;
      data?: { _id?: string; id?: string; name?: string; videoUrl?: string; duration?: string; types?: string[]; drmProtected?: boolean };
    };
    const d = body?.data;
    if (!body?.success || !d?.videoUrl || !/^https:\/\//i.test(d.videoUrl)) {
      cacheSet(id, null);
      return null;
    }
    const { host, folder } = folderAndHost(d.videoUrl);
    if (!folder) {
      cacheSet(id, null);
      return null;
    }
    const meta: NsVideoMeta = {
      videoId: d._id || d.id || id,
      name: d.name || "",
      videoUrl: d.videoUrl,
      host,
      folder,
      types: Array.isArray(d.types) ? d.types : [],
      drmProtected: !!d.drmProtected,
      duration: d.duration || "",
    };
    cacheSet(id, meta);
    return meta;
  } catch {
    cacheSet(id, null);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Static batch catalog used by pw-nextstudy (13k+ PW batches). */
export const NS_BATCH_CATALOG_URL =
  process.env.NS_BATCH_CATALOG_URL || "https://rarestudy.github.io/rarestudy/batches.json";
