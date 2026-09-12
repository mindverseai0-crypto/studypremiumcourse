import { NextRequest, NextResponse } from 'next/server';
import { buildLiveUpstreamUrl, liveChannelEnabled } from '@/lib/live-cdn';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/live/<asset>            ← live channel relay
//
// Same-origin relay for the owner's signed CloudFront LIVE channel:
//   index_2.m3u8 → playlist with every segment rewritten to /api/live/<seg>.ts
//   index_2_N.ts → raw bytes streamed through (Range passthrough, seeking)
//
// The signed query lives only on the server (live-cdn.ts). Requests carry
// optional DVR params (?start=<epoch> / ?m=<n>) which are whitelisted and
// forwarded upstream.
// ---------------------------------------------------------------------------

const ACL_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: ACL_HEADERS });
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const [rawAsset] = path || [];
  const asset = decodeURIComponent(rawAsset || '');
  const clientQuery = request.nextUrl.search || '';

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
  const range = request.headers.get('range');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), isPlaylist ? 15000 : 45000);
  try {
    const upstreamRes = await fetch(upstream, {
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
        ...(range ? { Range: range } : {}),
      },
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
