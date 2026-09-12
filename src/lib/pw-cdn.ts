// ============================================================================
// PW CloudFront signed-folder registry (server-side only).
//
// Lectures are served through the SAME pipeline as the owner's production
// site: a per-video folder signature from the upstream video-url API whose
// Policy covers the WHOLE folder (…/<folder>/*) — manifests, init segments,
// media segments and AES keys all resolve with the same query string.
//
// Assets are fetched through the proxy gateway
//     https://proxy.studyparcham.in/{cf_host}/{path}{signature}
// so our origin never needs direct egress to CloudFront.
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
};

/** Non-expired fallback signature for a folder, or null. */
export function getFallbackSignedQuery(folder: string): string | null {
  const raw = FALLBACK_FOLDER_SIGNATURES[folder.trim()];
  if (!raw) return null;
  const m = raw.match(/Policy=([^&]+)/);
  if (m) {
    try {
      const policy = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as {
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
