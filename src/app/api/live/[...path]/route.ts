import { NextRequest, NextResponse } from 'next/server';
import { buildLiveUpstreamUrl, liveChannelEnabled } from '@/lib/live-cdn';
import { lookupLiveSignature } from '@/lib/signature-store';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/live/<asset>                ← shared live channel (owner signature
//                                        in live-cdn.ts / LIVE_CDN_QUERY env)
// GET /api/live/h/<host>/<asset>?m=…   ← per-distribution LIVE streams
//                                        (urlType awsVideo: index.m3u8 on the
//                                        PW live CloudFront). The signature
//                                        comes from the persistent signature
//                                        store ("live:<host>" entries,
//                                        registered by pasting the signed
//                                        live URL into the live page's
//                                        recovery box / POST /api/pw-register).
//
// Playlists are rewritten so every URI goes back through this route; media
// segments (ts/m4s/aac/mp4) stream through with Range passthrough.
// ---------------------------------------------------------------------------

const ACL_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: ACL_HEADERS });
}

const ASSET_RE = /^(?!.*\.\.)[\w./-]+\.(?:m3u8|ts|m4s|mp4|aac|key)$/i;
const DVR_PARAM_RE = /^(?:start|m)=\d{1,15}$/;

function upstreamHeaders(range: string | null): HeadersInit {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
    ...(range ? { Range: range } : {}),
  };
}

/** Rewrite a playlist so every URI (bare lines + URI="…" attributes) is
 *  served through this relay, resolved against the manifest's own directory. */
function rewritePlaylist(body: string, host: string, manifestDir: string): string {
  const relayRef = (ref: string): string => {
    const raw = ref.trim();
    if (!raw) return ref;
    if (/^https?:\/\//i.test(raw)) {
      // absolute URL → same-host absolute refs go through the relay too
      try {
        const u = new URL(raw);
        if (u.host.toLowerCase() !== host.toLowerCase()) return raw;
        return `/api/live/h/${host}${u.pathname}${u.search || ''}`;
      } catch {
        return raw;
      }
    }
    let path: string;
    try {
      path = new URL(raw, `https://${host}${manifestDir}`).pathname;
    } catch {
      return raw;
    }
    const qIdx = raw.indexOf('?');
    return `/api/live/h/${host}${path}${qIdx >= 0 ? raw.slice(qIdx) : ''}`;
  };

  return body
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        // EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA carry URI="…" attributes
        if (/URI="/i.test(t)) {
          return line.replace(/URI="([^"]+)"/i, (_m, uri: string) => `URI="${relayRef(uri)}"`);
        }
        return line;
      }
      return relayRef(t);
    })
    .join('\n');
}

async function relayAsset(
  host: string,
  asset: string,
  signedQuery: string,
  clientQuery: string,
  range: string | null,
): Promise<NextResponse> {
  // Forward whitelisted DVR params (start/m) that the client asked for.
  const extra = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(clientQuery)) {
    if (DVR_PARAM_RE.test(`${k}=${v}`)) extra.set(k, v);
  }
  let qs = signedQuery;
  const extraStr = extra.toString();
  if (extraStr) qs += `&${extraStr}`;
  const upstream = `https://${host}/${asset}${qs}`;

  const isPlaylist = asset.toLowerCase().endsWith('.m3u8');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), isPlaylist ? 15000 : 45000);
  try {
    const upstreamRes = await fetch(upstream, {
      cache: 'no-store',
      signal: controller.signal,
      headers: upstreamHeaders(range),
    });
    clearTimeout(timer);

    if (!upstreamRes.ok) {
      // Pass the upstream error through as JSON (403 = signature problem)
      return NextResponse.json(
        { success: false, error: `Upstream ${upstreamRes.status}` },
        { status: upstreamRes.status === 403 ? 403 : 502, headers: ACL_HEADERS },
      );
    }

    if (isPlaylist) {
      const text = await upstreamRes.text();
      const dir = asset.includes('/') ? `/${asset.slice(0, asset.lastIndexOf('/'))}/` : '/';
      const body = rewritePlaylist(text, host, dir);
      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
          ...ACL_HEADERS,
        },
      });
    }

    const headers = new Headers();
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']) {
      const v = upstreamRes.headers.get(h);
      if (v) headers.set(h, v);
    }
    if (!headers.has('content-type')) headers.set('content-type', 'video/mp2t');
    headers.set('Cache-Control', 'no-store');
    for (const [k, v] of Object.entries(ACL_HEADERS)) headers.set(k, v);
    return new NextResponse(upstreamRes.body, { status: upstreamRes.status, headers });
  } catch {
    clearTimeout(timer);
    return NextResponse.json(
      { success: false, error: 'Live relay failed' },
      { status: 502, headers: ACL_HEADERS },
    );
  }
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const parts = (path || []).map((p) => decodeURIComponent(p));
  const clientQuery = request.nextUrl.search || '';
  const range = request.headers.get('range');

  // ---- per-distribution live stream: /api/live/h/<host>/<asset> ----
  if (parts.length >= 3 && parts[0] === 'h') {
    const host = (parts[1] || '').toLowerCase();
    const asset = parts.slice(2).join('/');
    if (!/^(?:[a-z0-9-]+\.)*(?:cloudfront\.net|pw\.live)$/i.test(host)) {
      return NextResponse.json(
        { success: false, error: 'Bad live host' },
        { status: 400, headers: ACL_HEADERS },
      );
    }
    if (!ASSET_RE.test(asset)) {
      return NextResponse.json(
        { success: false, error: 'Bad asset' },
        { status: 400, headers: ACL_HEADERS },
      );
    }
    const signedQuery = lookupLiveSignature(host);
    if (!signedQuery) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Live signature not registered — paste the signed live URL (…/index.m3u8?Signature=…) to unlock this stream.',
        },
        { status: 403, headers: ACL_HEADERS },
      );
    }
    return relayAsset(host, asset, signedQuery, clientQuery, range);
  }

  // ---- legacy shared live channel: /api/live/<asset> ----
  const asset = parts[parts.length - 1] || '';
  if (!liveChannelEnabled()) {
    return NextResponse.json(
      { success: false, error: 'Live channel not configured.' },
      { status: 403, headers: ACL_HEADERS },
    );
  }
  const upstream = buildLiveUpstreamUrl(asset, clientQuery);
  if (!upstream) {
    return NextResponse.json(
      { success: false, error: 'Bad asset' },
      { status: 400, headers: ACL_HEADERS },
    );
  }
  const isPlaylist = asset.endsWith('.m3u8');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), isPlaylist ? 15000 : 45000);
  try {
    const upstreamRes = await fetch(upstream, {
      cache: 'no-store',
      signal: controller.signal,
      headers: upstreamHeaders(range),
    });
    clearTimeout(timer);

    if (!upstreamRes.ok) {
      return NextResponse.json(
        { success: false, error: `Upstream ${upstreamRes.status}` },
        { status: upstreamRes.status === 403 ? 403 : 502, headers: ACL_HEADERS },
      );
    }

    if (isPlaylist) {
      const text = await upstreamRes.text();
      // rewrite every segment (index_2_N.ts) back through this route,
      // preserving the segment's own query params (m=…) for DVR windows.
      const body = text.replace(
        /(index_2(?:_\d+)?\.ts)(\?[^\s]*)?/g,
        (_m: string, seg: string, segQ?: string) => `/api/live/${seg}${segQ || ''}`,
      );
      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
          ...ACL_HEADERS,
        },
      });
    }

    const headers = new Headers();
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']) {
      const v = upstreamRes.headers.get(h);
      if (v) headers.set(h, v);
    }
    if (!headers.has('content-type')) headers.set('content-type', 'video/mp2t');
    headers.set('Cache-Control', 'no-store');
    for (const [k, v] of Object.entries(ACL_HEADERS)) headers.set(k, v);
    return new NextResponse(upstreamRes.body, { status: upstreamRes.status, headers });
  } catch {
    clearTimeout(timer);
    return NextResponse.json(
      { success: false, error: 'Live relay failed' },
      { status: 502, headers: ACL_HEADERS },
    );
  }
}
