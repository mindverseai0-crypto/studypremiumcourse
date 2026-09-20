// ============================================================================
// PW CloudFront signed-folder registry + upstream fetch lanes (server-side).
//
// Lectures are served through the SAME pipeline as the owner's production
// site: a per-video folder signature from the upstream video-url API whose
// Policy covers the WHOLE folder (…/<folder>/*) — manifests, init segments,
// media segments and AES keys all resolve with the same query string.
//
// Our origin reaches the signed CloudFront assets through ordered LANES
// (see fetchSignedAsset below):
//
//   delta  — https://apiserver.deltastudy.fun/api/pi/play?url=<encoded URL>
//            Heroku pass-through: the server fetches ANY valid signed
//            CloudFront URL and returns the bytes. It signs nothing itself
//            and its CORS is locked to deltastudy.fun, so it is usable
//            ONLY server-side — exactly what this module is for.
//   pearl  — https://proxy.studyparcham.in/{cf_host}/{path}{signature}
//            the owner's proxy gateway.
//   direct — straight to CloudFront from this origin.
//
// When /api/data resolves a video we register {folder -> signed query, host}
// here; the /api/pw/[...path] relay serves every asset through our own
// origin without leaking the signed query to the browser.
// ============================================================================

const registry = new Map<string, { query: string; host: string; registeredAt: number }>();
const MAX_ENTRIES = 500;
const ENTRY_TTL_MS = 6 * 60 * 60 * 1000; // signatures live for months; refresh resolves anyway

/** The default PW media host (most lecture folders live here). */
export const CLOUDFRONT_HOST = 'd1d34p8vz63oiq.cloudfront.net';

/**
 * Proxy gateway template — the owner-provided API for lecture assets:
 *   https://proxy.studyparcham.in/{cf_host}/{folder}/hls/720/main.m3u8{signature}
 * Override with PW_PROXY_ORIGIN env when self-hosting the gateway.
 */
export function pwProxyOrigin(): string {
  return (process.env.PW_PROXY_ORIGIN || 'https://proxy.studyparcham.in').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Upstream lanes
// ---------------------------------------------------------------------------

export type UpstreamMode = 'delta' | 'pearl' | 'direct';

/** First lane to try — env `PW_UPSTREAM_MODE`, default `delta`. */
export function upstreamMode(): UpstreamMode {
  const v = (process.env.PW_UPSTREAM_MODE || 'delta').toLowerCase().trim();
  return v === 'pearl' || v === 'direct' ? (v as UpstreamMode) : 'delta';
}

/** Delta pass-through endpoint — env `PW_DELTA_PLAY_API` to override. */
export function deltaPlayUrl(): string {
  return (process.env.PW_DELTA_PLAY_API || 'https://apiserver.deltastudy.fun/api/pi/play').trim();
}

/** Full lane order: configured mode first, then the remaining ones. */
function laneChain(): UpstreamMode[] {
  const first = upstreamMode();
  const rest: UpstreamMode[] = (['delta', 'pearl', 'direct'] as UpstreamMode[]).filter((m) => m !== first);
  return [first, ...rest];
}

/** Concrete upstream URL for a lane. `path` = "<folder>/<asset…>" (pre-encoded). */
function laneAssetUrl(lane: UpstreamMode, host: string, path: string, signedQuery: string): string {
  const target = `https://${host}/${path}${signedQuery}`;
  if (lane === 'direct') return target;
  if (lane === 'pearl') return `${pwProxyOrigin()}/${host}/${path}${signedQuery}`;
  return `${deltaPlayUrl()}?url=${encodeURIComponent(target)}`;
}

export interface FetchSignedOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Fetch a signed CloudFront asset trying each upstream lane in order.
 * A lane wins when the fetch resolves with a non-403, non-5xx status; on
 * network errors / 403 / 5xx the next lane is tried. Returns the first
 * winning response, or the last response when every lane failed (a
 * synthesized 502 if all lanes threw).
 *
 * `pathAfterHost` must be the percent-encoded path below the distribution
 * root, e.g. "<folder>/dash/720/init.mp4". `signedQuery` starts with "?".
 */
export async function fetchSignedAsset(
  host: string,
  pathAfterHost: string,
  signedQuery: string,
  opts: FetchSignedOptions = {},
): Promise<Response> {
  const query = signedQuery.startsWith('?') ? signedQuery : signedQuery ? `?${signedQuery}` : '';
  const lanes = laneChain();
  let last: Response | null = null;
  let lastErr: unknown = null;
  for (const lane of lanes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60000);
    try {
      const res = await fetch(laneAssetUrl(lane, host, pathAfterHost, query), {
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
          ...(opts.headers || {}),
        },
      });
      clearTimeout(timer);
      if (res.status !== 403 && res.status < 500) return res; // lane win
      last = res; // genuine upstream failure — remember, try next lane
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
  }
  if (last) return last;
  return new Response(
    JSON.stringify({ success: false, error: lastErr instanceof Error ? lastErr.message : 'All upstream lanes failed' }),
    { status: 502, headers: { 'Content-Type': 'application/json' } },
  );
}

export function registerSignedFolder(folder: string, signedQuery: string, host = ''): void {
  const f = folder.trim();
  if (!f) return;
  if (registry.size >= MAX_ENTRIES) {
    const oldest = registry.keys().next().value;
    if (oldest) registry.delete(oldest);
  }
  registry.set(f, {
    query: signedQuery.startsWith('?') ? signedQuery : signedQuery ? `?${signedQuery}` : '',
    host: host || registry.get(f)?.host || '',
    registeredAt: Date.now(),
  });
}

export function registerFolderHost(folder: string, host: string): void {
  const f = folder.trim();
  if (!f || !host) return;
  const hit = registry.get(f);
  if (hit) hit.host = host;
  else registerSignedFolder(f, '', host);
}

export function getSignedQuery(folder: string): string | null {
  const hit = registry.get(folder.trim());
  if (!hit) return null;
  if (Date.now() - hit.registeredAt > ENTRY_TTL_MS) {
    registry.delete(folder.trim());
    return null;
  }
  return hit.query || null;
}

export function getHostForFolder(folder: string): string {
  return registry.get(folder.trim())?.host || CLOUDFRONT_HOST;
}

/** Extract the video folder uuid from an upstream manifest URL. */
export function folderFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[0] && /^[a-f0-9-]{16,}$/i.test(parts[0]) ? parts[0] : (parts[0] ?? '');
  } catch {
    return '';
  }
}

/** Extract the host from an upstream URL (cloudfront distributions only). */
export function hostFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return /\.cloudfront\.net$/i.test(u.host) ? u.host : '';
  } catch {
    return '';
  }
}

/** Everything after the folder segment: "hls/720/main.m3u8" etc. */
export function subPathFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.slice(1).map((p) => encodeURIComponent(decodeURIComponent(p))).join('/');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Fallback per-folder signatures (owner-provided constants).
//
// The owner signs folder-wide CloudFront policies outside this app; when a
// fresh per-video signature cannot be resolved from the upstream APIs, a
// non-expired constant from this table keeps that folder playable.
// Entries whose Policy DateLessThan has passed are ignored automatically.
// ---------------------------------------------------------------------------

const FALLBACK_FOLDER_SIGNATURES: Record<string, string> = {
  // Owner sample (proxy.studyparcham.in template) — folder-wide policy.
  'a558fffd-9f3f-4334-ac96-50c13dd2cfc7':
    'Signature=jNepjtfmz52QXRhnbc6fpfUzjhRJrHDPwrRYYh9crNIgJvqy3cmNSfCiNsaiPmQEHFa6EJ8tKNBPlUufLmbSNugAsyFjW5yRJixcxLF0QWcjvEy~lUd9dPNXMZ0ZCGq7cCiOjxPn200yPolUMpQlfnzVTks3~cAFFiwUZS9dvZ5ssTOpmIJoDsuCqbvEqnYl1-JWIHuRfGO3sVAjl1Mm-cEbbavfCc5Lavgwa9YieCV~opvKuLW8HqEytkZE2yzjZkVEughljmlL-jFIonuSNUNZrhlRtg7aX31xjENZ4lRj2-EqGoXezLr4WDzTqilIHV9pZ~uWDrtlAqlD0efXGg__&Key-Pair-Id=APKAXVKMENFCRKTG5XE2&Policy=eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9kMWQzNHA4dno2M29pcS5jbG91ZGZyb250Lm5ldC9hNTU4ZmZmZC05ZjNmLTQzMzQtYWM5Ni01MGMxM2RkMmNmYzcvKiIsIkNvbmRpdGlvbiI6eyJEYXRlTGVzc1RoYW4iOnsiQVdTOkVwb2NoVGltZSI6MTc4ODcyNjMyN30sIkRhdGVHcmVhdGVyVGhhbiI6eyJBV1M6RXBvY2hUaW1lIjo1NzY2ODAxMX19fV19',
  // Owner-provided sample (delta lane era) — folder-wide policy, expires
  // epoch 1789589599 (2026-09-16). Probed 200 for master.mpd, init.mp4 and
  // media segments through apiserver.deltastudy.fun/api/pi/play.
  'dd3326fa-0ece-4bfe-8972-032cf2e46e04':
    '?Signature=PRPN2G6cgfE7rk4sAaft2dq9fRbnrBdRvx2-jSdYvjQHcKml2yiV4g7sKE5Rgv86e13BlDX-xBkmS19SEpA-TV8Vg~YeT6sO-lEYLXkyU-KOq1XdJ2YUPMmrxbJYF4Db3yORDM23kGVc17o9QM5~5DapMH5OMB2z2c9AajcHQC7qZ~KF5TwgYM-~kmaM8WaztUKhLHBeZfmWN1dJCIWyshaNlyZm2s18vqFLT8KNCrfiGG414LNEdugx4ZsisLY5Uksozpr-knfd428syuZdARMpyUcmj4enndJMnpcARF2iUr-pEUfaSeX3kXC6j9E8JJSFqidsVPPBcMqxqRxWaw__&Key-Pair-Id=APKAXVKMENFCRKTG5XE2&Policy=eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9kMWQzNHA4dno2M29pcS5jbG91ZGZyb250Lm5ldC9kZDMzMjZmYS0wZWNlLTRiZmUtODk3Mi0wMzJjZjJlNDZlMDQvKiIsIkNvbmRpdGlvbiI6eyJEYXRlTGVzc1RoYW4iOnsiQVdTOkVwb2NoVGltZSI6MTc4OTU4OTU5OX0sIkRhdGVHcmVhdGVyVGhhbiI6eyJBV1M6RXBvY2hUaW1lIjoxNTc5ODk3NDA1fX19XX0_',
  // Owner-provided HLS sample (studyparcham proxy template) — folder-wide
  // policy, expires epoch 1789896759 (2026-09-21). Probed 200 for
  // hls/720/main.m3u8 (867-seg AES-128 VOD), hls/720/NNN.ts segments and
  // hls/enc.key direct + via the pearl proxy. `start=` query param verified
  // optional (byte-identical manifest without it). AES key lives one level
  // ABOVE the rendition dir (hls/enc.key); the manifest's penpencil
  // get-hls-key EXT-X-KEY is remapped there by the /api/pw relay.
  '3a0ec8d2-b2aa-4823-8dee-c87798d13176':
    '?Signature=XTxlrsK7K0dbsY5WPuqTabgnivpuKZWHIzw18xPg4hGvwHDJh8lWqvokABOD6EZiPhPcp6057znuv~AGDI21qB9RDw3b5gmlRMb~MdvoR64bvSuKOl9gWprJ2ATfk62wQNRoEKfLd03-fWqTSTUGYPdjvnf3A-N4lqsSoOqPriYm2rFsYjuO32zv4sx3~L0F48J9YuKDnbAyO0jrWQw8brs4ZYrUwSGzljtjh48dZtgs0TpOaSCNO84X5-mrTKMKmd8IAkXRxNORnX-T7WWIYyR2j1mfWDyEV9-XW~E9AX~MErTQOSjQ3rAAqxbW-gqonPUw-Uh7rIqY5WD8TQQ5Tg__&Key-Pair-Id=APKAXVKMENFCRKTG5XE2&Policy=eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9kMWQzNHA4dno2M29pcS5jbG91ZGZyb250Lm5ldC8zYTBlYzhkMi1iMmFhLTQ4MjMtOGRlZS1jODc3OThkMTMxNzYvKiIsIkNvbmRpdGlvbiI6eyJEYXRlTGVzc1RoYW4iOnsiQVdTOkVwb2NoVGltZSI6MTc4OTg5Njc1OX0sIkRhdGVHcmVhdGVyVGhhbiI6eyJBV1M6RXBvY2hUaW1lIjoxNzIyMTYyNjg5fX19XX0_',
};

/** Folder ids with builtin fallback signatures (for store seeding). */
export const FALLBACK_FOLDER_IDS: string[] = Object.keys(FALLBACK_FOLDER_SIGNATURES);

/** Non-expired fallback signature for a folder, or null. */
export function getFallbackSignedQuery(folder: string): string | null {
  const raw = FALLBACK_FOLDER_SIGNATURES[folder.trim()];
  if (!raw) return null;
  const m = raw.match(/Policy=([^&]+)/);
  if (m) {
    try {
      // Some signers pad base64url non-canonically (e.g. trailing '_' bits)
      // which decodes to junk bytes after the JSON — trim to the object.
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const policy = JSON.parse(decoded.slice(decoded.indexOf('{'), decoded.lastIndexOf('}') + 1)) as {
        Statement?: Array<{ Condition?: { DateLessThan?: { 'AWS:EpochTime'?: number } } }>;
      };
      const now = Math.floor(Date.now() / 1000);
      const exp = policy.Statement?.[0]?.Condition?.DateLessThan?.['AWS:EpochTime'];
      if (exp && now >= exp) return null; // expired — let the API path resolve instead
    } catch {
      /* unparseable policy — treat as unusable */
      return null;
    }
  }
  return raw;
}
