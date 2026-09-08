import { NextRequest, NextResponse } from 'next/server';
import { CLOUDFRONT_HOST, getSignedQuery } from '@/lib/pw-cdn';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/pw/<folder>/<file...>
// GET /api/pw/<folder>/s/<sig>/<file...>      ← stateless form
//
// Same-origin relay for the REAL PW CloudFront media (signed per video
// folder by the upstream video-url API).
//
// The DASH manifests use RELATIVE segment URLs, so the signature is carried
// in the path (`/s/<base64url-of-query>/`) and every relative segment the
// player resolves automatically flows back through this route with its
// signature. The in-memory registry (pw-cdn) is kept as a fallback for URLs
// without the path signature.
//
//   master.mpd  → passthrough (segment URLs inside are relative)
//   *.m3u8      → playlist with every URI rewritten to this same route
//   everything  → raw asset bytes (init.mp4, segments, .ts, enc.key) with
//                 Range passthrough for seeking
// ---------------------------------------------------------------------------

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SAFE_SIG = /^[A-Za-z0-9_-]{8,}$/

function buildUpstreamUrl(folder: string, asset: string[], query: string): string | null {
  if (asset.length === 0) return null;
  if (!/^[a-f0-9-]{16,}$/i.test(folder)) return null;
  for (const seg of asset) {
    if (!SAFE_SEGMENT.test(seg)) return null; // no traversal, no url tricks
  }
  const path = [folder, ...asset].map(encodeURIComponent).join('/');
  return `https://${CLOUDFRONT_HOST}/${path}${query}`;
}

/** Rewrite every playlist URI (absolute or relative) to our relay route. */
function rewritePlaylist(body: string, base: string): string {
  return body
    .split('\n')
    .map((rawLine) => {
      const line = rawLine.trim();
      if (!line) return rawLine;
      if (line.startsWith('#')) {
        // rewrite URIs inside tags (KEY / MAP / EXT-X-MEDIA etc.)
        if (/^#(EXT-X-KEY|EXT-X-MAP|EXT-X-MEDIA|EXT-X-I-FRAME-STREAM-INF|EXT-X-SESSION-KEY)/i.test(line)) {
          return line.replace(/URI="([^"]+)"/i, (_m, uri: string) => `URI="${joinUri(base, uri)}"`);
        }
        return rawLine;
      }
      return joinUri(base, line);
    })
    .join('\n');
}

function joinUri(base: string, uri: string): string {
  if (/^https?:\/\//i.test(uri)) {
    // same-host absolute → keep only the path inside the folder
    try {
      const u = new URL(uri);
      if (u.host === CLOUDFRONT_HOST) {
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts[0] && parts[0].length > 16) return `${base}/${parts.slice(1).join('/')}`;
      }
      return uri; // different host — leave untouched (rare)
    } catch {
      return uri;
    }
  }
  const clean = uri.split('/').filter((s) => s && s !== '.');
  const out: string[] = [];
  for (const seg of clean) {
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `${base}/${out.map(encodeURIComponent).join('/')}`;
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const parts = (path || []).map((p) => decodeURIComponent(p));
  if (parts.length < 2) {
    return NextResponse.json({ success: false, error: 'Bad path' }, { status: 400 });
  }

  // Stateless form: /api/pw/<folder>/s/<sig>/<asset...>
  let folder = parts[0];
  let sigSegment: string | null = null;
  let asset: string[];
  if (parts[1] === 's' && parts.length >= 4 && SAFE_SIG.test(parts[2])) {
    sigSegment = parts[2];
    asset = parts.slice(3);
  } else {
    asset = parts.slice(1);
  }

  let signedQuery: string | null = null;
  if (sigSegment) {
    try {
      const decoded = Buffer.from(sigSegment, 'base64url').toString('utf8');
      signedQuery = decoded.startsWith('?') ? decoded : `?${decoded}`;
    } catch {
      signedQuery = null;
    }
  }
  if (!signedQuery) {
    signedQuery = getSignedQuery(folder);
  }
  if (!signedQuery) {
    return NextResponse.json(
      { success: false, error: 'Unknown or expired stream. Reload the lecture.' },
      { status: 403 },
    );
  }

  const upstream = buildUpstreamUrl(folder, asset, signedQuery);
  if (!upstream) {
    return NextResponse.json({ success: false, error: 'Bad path' }, { status: 400 });
  }

  const fileName = asset[asset.length - 1];
  const isPlaylist = /\.m3u8$/i.test(fileName);
  const isManifest = /\.mpd$/i.test(fileName);

  const range = request.headers.get('range');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const upstreamRes = await fetch(upstream, {
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
        ...(range ? { Range: range } : {}),
      },
    });

    if (!upstreamRes.ok) {
      clearTimeout(timer);
      return NextResponse.json(
        { success: false, error: `Upstream ${upstreamRes.status}` },
        { status: upstreamRes.status === 403 ? 403 : 502 },
      );
    }

    if (isPlaylist || isManifest) {
      const text = await upstreamRes.text();
      clearTimeout(timer);
      const base = sigSegment
        ? `/api/pw/${folder}/s/${sigSegment}`
        : `/api/pw/${folder}`;
      const body = isPlaylist ? rewritePlaylist(text, base) : text;
      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': isPlaylist ? 'application/vnd.apple.mpegurl' : 'application/dash+xml',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // binary asset → stream through
    const headers = new Headers();
    const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag'];
    for (const h of passthrough) {
      const v = upstreamRes.headers.get(h);
      if (v) headers.set(h, v);
    }
    if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
    headers.set('Cache-Control', 'public, max-age=86400');
    headers.set('Access-Control-Allow-Origin', '*');
    clearTimeout(timer);
    return new NextResponse(upstreamRes.body, { status: upstreamRes.status, headers });
  } catch (e) {
    clearTimeout(timer);
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'Relay failed' },
      { status: 502 },
    );
  }
}
