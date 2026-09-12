// Client-safe constants for the shared live channel relay.

export const LIVE_MANIFEST_URL = '/api/live/index_2.m3u8';

export function isLiveManifestUrl(url: string): boolean {
  return url === LIVE_MANIFEST_URL || url.startsWith(`${LIVE_MANIFEST_URL}?`);
}
