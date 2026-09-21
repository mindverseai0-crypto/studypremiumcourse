import { NextRequest, NextResponse } from 'next/server';
import { nsStreamBase } from '@/lib/nextstudy';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/next/<path>?<query>  — same-origin proxy for the NextStudy
// (pw-nextstudy.ai.studio) streaming API, used as the playback fallback for
// lectures/batches whose normal signing chain is gated.
//
//   /api/next/api/stream.m3u8?videoId=…&scheduleId=…      master playlist
//   /api/next/api/stream.m3u8?url=<encoded cf url>         variant playlist
//   /api/next/api/segment-proxy?url=<encoded cf/skd url>   segments + keys
//
// Playlists (m3u8 content-type) are rewritten so every URI goes back through
// this relay: absolute upstream URLs → /api/next/…, any other absolute http(s)
// URL → their segment-proxy (they hold the CDN credentials), relative refs
// resolved against the manifest's upstream URL first. Everything else streams
// through byte-for-byte with Range passthrough.
//
// NOTE: skd:// FairPlay key requests fail at the upstream (their key delivery
// is unimplemented — HTTP 500); this relay surfaces a 502 with a clear DRM
// message so players can render an honest error.
// ---------------------------------------------------------------------------

const ACL_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: ACL_HEADERS });
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

function isPlaylist(upstreamUrl: URL, contentType: string): boolean {
  if (/mpegurl/i.test(contentType)) return true;
  if (/\.m3u8(\?|$)/i.test(upstreamUrl.pathname + upstreamUrl.search)) return true;
  // the inner proxied target decides for their stream.m3u8?url=… endpoint
  const inner = upstreamUrl.searchParams.get('url') || '';
  return /\.m3u8(\?|$)/i.test(inner);
}

/** Map one URI reference to a same-origin relay reference. */
function mapUri(raw: string, manifestUrl: URL, upstreamHost: string): string {
  const ref = raw.trim();
  if (!ref || /^(data:|blob:|#)/i.test(ref)) return ref;
  let abs: URL;
  try {
    abs = new URL(ref, manifestUrl);
  } catch {
    return ref;
  }
  if (!/^https?:$/i.test(abs.protocol)) return ref;
  if (abs.host.toLowerCase() === upstreamHost) {
    return `/api/next${abs.pathname}${abs.search || ''}`;
  }
  // other hosts (cloudfront etc.) — their proxy holds the CDN credentials
  return `/api/next/api/segment-proxy?url=${encodeURIComponent(abs.toString())}`;
}

/** Rewrite every URI (bare lines + URI="…" attributes) through the relay. */
function rewritePlaylist(body: string, manifestUrl: URL): string {
  const upstreamHost = manifestUrl.host.toLowerCase();
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line) {
      out.push(line);
      continue;
    }
    if (line.startsWith('#')) {
      // rewrite URI="…" attributes on KEY / MAP / STREAM-INF / MEDIA lines
      if (line.includes('URI="')) {
        out.push(line.replace(/URI="([^"]*)"/g, (_m, uri: string) => `URI="${mapUri(uri, manifestUrl, upstreamHost)}"`));
      } else {
        out.push(line);
      }
      continue;
    }
    out.push(mapUri(line, manifestUrl, upstreamHost));
  }
  return out.join('\n');
}

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition'];

export async function GET(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const sub = (path || []).map((p) => encodeURIComponent(decodeURIComponent(p))).join('/');
  if (!sub || sub.includes('..')) {
    return NextResponse.json({ success: false, error: 'Bad path' }, { status: 400, headers: ACL_HEADERS });
  }
  const incoming = request.nextUrl.search || '';
  let manifestUrl: URL;
  try {
    manifestUrl = new URL(`${nsStreamBase()}/${sub}${incoming}`);
  } catch {
    return NextResponse.json({ success: false, error: 'Bad upstream URL' }, { status: 400, headers: ACL_HEADERS });
  }

  const range = request.headers.get('range');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let upstream: Response;
  try {
    upstream = await fetch(manifestUrl, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: '*/*', ...(range ? { Range: range } : {}) },
    });
  } catch (e) {
    clearTimeout(timer);
    return NextResponse.json(
      { success: false, error: `NextStudy upstream unreachable: ${e instanceof Error ? e.message : 'fetch failed'}` },
      { status: 502, headers: ACL_HEADERS },
    );
  }
  clearTimeout(timer);

  // FairPlay key delivery is unimplemented upstream — surface an honest 502.
  const innerUrl = manifestUrl.searchParams.get('url') || '';
  if (/^skd:/i.test(innerUrl)) {
    return NextResponse.json(
      {
        success: false,
        error:
          'This stream is FairPlay DRM protected. The upstream key endpoint does not deliver keys, so the content cannot be decrypted in any browser.',
      },
      { status: 502, headers: ACL_HEADERS },
    );
  }

  const ctype = upstream.headers.get('content-type') || '';

  if (!upstream.ok) {
    // their API returns errors as m3u8-ish bodies ("#EXT-X-ERROR: …") with
    // non-200 status — surface a clean 502 JSON the player can reason about
    const text = await upstream.text().catch(() => '');
    const m = text.match(/#EXT-X-ERROR:(.*)/);
    if (m) {
      return NextResponse.json(
        { success: false, error: `NextStudy upstream could not serve this stream: ${m[1].trim()}` },
        { status: 502, headers: ACL_HEADERS },
      );
    }
    return new NextResponse(text || `Upstream ${upstream.status}`, {
      status: upstream.status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...ACL_HEADERS },
    });
  }

  if (isPlaylist(manifestUrl, ctype)) {
    const text = await upstream.text().catch(() => '');
    if (/#EXT-X-ERROR/i.test(text.slice(0, 400))) {
      const msg = (text.match(/#EXT-X-ERROR:(.*)/) || [])[1]?.trim() || 'Upstream CDN error';
      return NextResponse.json(
        { success: false, error: `NextStudy upstream could not serve this stream: ${msg}` },
        { status: 502, headers: ACL_HEADERS },
      );
    }
    const rewritten = rewritePlaylist(text, manifestUrl);
    return new NextResponse(rewritten, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache, no-store',
        ...ACL_HEADERS,
      },
    });
  }

  // binary passthrough (segments / keys / files)
  const headers: Record<string, string> = { ...ACL_HEADERS };
  for (const h of PASS_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  if (!headers['content-type']) headers['content-type'] = 'application/octet-stream';
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}
