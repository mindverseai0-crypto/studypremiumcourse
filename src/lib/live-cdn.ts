// ============================================================================
// Live class CDN — shared CloudFront live channel (server-side only).
//
// The owner supplies a folder/host-wide signed query for the live stream:
//   https://{live_host}/index_2.m3u8?start=<epoch>&Signature=…&Key-Pair-Id=…&Policy=…
// The signature lives ONLY on the server; browsers see /api/live/*.
//
// Refresh the signed query by pasting a fresh one into LIVE_SIGNED_QUERY
// (or the LIVE_CDN_QUERY env var) when the current policy expires.
// ============================================================================

const LIVE_HOST = 'd2v87mlvcokwo8.cloudfront.net';

/**
 * Signed query for the live distribution (Signature/Key-Pair-Id/Policy).
 * Empty by default → the shared channel is disabled and the live page falls
 * back to per-batch payloads only. Paste the fresh signed query string
 * (everything from "Signature=" onward) to enable the shared channel.
 */
const LIVE_SIGNED_QUERY =
  process.env.LIVE_CDN_QUERY ||
  ''; // e.g. 'Signature=…&Key-Pair-Id=APKAXVKMENFCRKTG5XE2&Policy=…'

/** Only live playlist + media segment assets are ever relayed. */
const SAFE_ASSET = /^index_2(?:_\d+)?\.(?:m3u8|ts)$/;

/** Only DVR-style numeric params are forwarded upstream. */
const SAFE_PARAM = /^(?:start|m)=\d{1,15}$/;

/** True when a usable (non-expired) signature is configured. */
export function liveChannelEnabled(): boolean {
  if (!LIVE_SIGNED_QUERY) return false;
  const m = LIVE_SIGNED_QUERY.match(/Policy=([^&]+)/);
  if (!m) return true; // no policy to inspect (canned-cookie setups)
  try {
    const policy = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as {
      Statement?: Array<{ Condition?: { DateLessThan?: { 'AWS:EpochTime'?: number } } }>;
    };
    const exp = policy.Statement?.[0]?.Condition?.DateLessThan?.['AWS:EpochTime'];
    if (exp && Math.floor(Date.now() / 1000) >= exp) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Build the signed upstream URL for a live asset.
 * `clientQuery` is the query received from the browser (start/m params only);
 * returns null for anything that is not a whitelisted live asset.
 */
export function buildLiveUpstreamUrl(asset: string, clientQuery: string): string | null {
  if (!liveChannelEnabled()) return null;
  if (!SAFE_ASSET.test(asset)) return null;
  const params = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(clientQuery)) {
    const pair = `${k}=${v}`;
    if (SAFE_PARAM.test(pair)) params.set(k, v);
  }
  let qs = LIVE_SIGNED_QUERY;
  const extra = params.toString();
  if (extra) qs += (qs.endsWith('=') || qs.includes('=') ? '&' : '') + extra;
  return `https://${LIVE_HOST}/${asset}${qs ? `?${qs}` : ''}`;
}

export function liveHost(): string {
  return LIVE_HOST;
}
