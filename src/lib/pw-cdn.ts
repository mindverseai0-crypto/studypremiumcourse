// ============================================================================
// PW CloudFront signed-folder registry (server-side only).
//
// learnxpw's video-url API hands out a per-video folder signature for
// d1d34p8vz63oiq.cloudfront.net whose Policy covers the WHOLE folder
// (…/<folder>/*) — mpd/m3u8 manifests, init segments, media segments and the
// AES key all resolve with the same query string.
//
// When our /api/data resolves a video we register {folder -> signed query}
// here; the /api/pw/[...path] relay then serves every asset through our own
// origin without ever leaking handling logic (the signed query stays
// server-side, exactly like learnxpw's own /api/play proxies).
// ============================================================================

const registry = new Map<string, { query: string; registeredAt: number }>();
const MAX_ENTRIES = 500;
const ENTRY_TTL_MS = 6 * 60 * 60 * 1000; // signatures live for months; refresh resolves anyway

/** The only PW media host we ever relay. */
export const CLOUDFRONT_HOST = 'd1d34p8vz63oiq.cloudfront.net';

export function registerSignedFolder(folder: string, signedQuery: string): void {
  const f = folder.trim();
  if (!f) return;
  if (registry.size >= MAX_ENTRIES) {
    const oldest = registry.keys().next().value;
    if (oldest) registry.delete(oldest);
  }
  registry.set(f, { query: signedQuery.startsWith('?') ? signedQuery : `?${signedQuery}`, registeredAt: Date.now() });
}

export function getSignedQuery(folder: string): string | null {
  const hit = registry.get(folder.trim());
  if (!hit) return null;
  if (Date.now() - hit.registeredAt > ENTRY_TTL_MS) {
    registry.delete(folder.trim());
    return null;
  }
  return hit.query;
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
