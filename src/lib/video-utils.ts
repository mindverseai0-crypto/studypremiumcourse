// Client-safe media helpers for the player / live pages.

/** True when a URL points at an HLS playlist (incl. our /api/pw relay). */
export function isHlsUrl(url: string): boolean {
  if (!url) return false;
  return /\.m3u8([?#]|$)/i.test(url);
}

/** True when a URL points at a DASH manifest. */
export function isMpdUrl(url: string): boolean {
  if (!url) return false;
  return /\.mpd([?#]|$)/i.test(url);
}

/** Extract a YouTube video id from common URL shapes. */
export function youtubeId(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
    const v = u.searchParams.get('v');
    if (v) return v;
    const parts = u.pathname.split('/');
    const idx = parts.findIndex((p) => p === 'embed' || p === 'shorts' || p === 'live');
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    return parts.filter(Boolean).pop() || '';
  } catch {
    return '';
  }
}
