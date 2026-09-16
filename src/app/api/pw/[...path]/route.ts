import { NextRequest, NextResponse } from 'next/server';
import {
  CLOUDFRONT_HOST,
  getSignedQuery,
  getFallbackSignedQuery,
  getHostForFolder,
  fetchSignedAsset,
} from '@/lib/pw-cdn';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/pw/<folder>/<file...>
// GET /api/pw/<folder>/s/<sig>/<file...>      ← stateless signature in path
// GET /api/pw/h/<host>/<folder>/...           ← explicit distribution host
//
// Same-origin relay for the REAL PW CloudFront media (signed per video
// folder by the upstream video-url API).
//
// Upstream fetches go through the ordered lane chain in pw-cdn.ts:
//   delta (apiserver.deltastudy.fun pass-through) → pearl
//   (proxy.studyparcham.in) → direct CloudFront. The first lane that
// returns a non-403/non-5xx response wins. PW_UPSTREAM_MODE picks the
// first lane (default: delta).
//
// The DASH manifests use ABSOLUTE folder-level <BaseURL>s, so rewriteMpd()
// points them back at this route and the signature is carried statelessly
// in the path (`/s/<base64url-of-query>/`); every relative segment the
// player resolves automatically flows back through here. The in-memory
// registry (pw-cdn) and the fallback signature table are consulted for
// URLs without a path signature.
//
//   master.mpd / main.m3u8 → playlist rewritten to this same route
//   everything else        → raw asset bytes (init.mp4, segments, .ts, enc.key)
//                             with Range passthrough for seeking
// ---------------------------------------------------------------------------

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SAFE_HOST = /^[a-z0-9.-]+\.cloudfront\.net$/i;
const SAFE_SIG = /^[A-Za-z0-9_-]{8,}$/;

/** "<folder>/<asset…>" percent-encoded path below the distribution root. */
function buildAssetPath(folder: string, asset: string[]): string | null {
  if (asset.length === 0) return null;
  if (!/^[a-f0-9-]{16,}$/i.test(folder)) return null;
  for (const seg of asset) {
    if (!SAFE_SEGMENT.test(seg)) return null; // no traversal, no url tricks
  }
  return [folder, ...asset].map(encodeURIComponent).join('/');
}

/** Rewrite every playlist URI (absolute or relative) to our relay route. */
function rewritePlaylist(body: string, base: string, host: string): string {
  return body
    .split('\n')
    .map((rawLine) => {
      const line = rawLine.trim();
      if (!line) return rawLine;
      if (line.startsWith('#')) {
        // rewrite URIs inside tags (KEY / MAP / EXT-X-MEDIA etc.)
        if (/^#(EXT-X-KEY|EXT-X-MAP|EXT-X-MEDIA|EXT-X-I-FRAME-STREAM-INF|EXT-X-SESSION-KEY)/i.test(line)) {
          return line.replace(/URI="([^"]+)"/i, (_m, uri: string) => `URI="${joinUri(base, uri, host)}"`);
        }
        return rawLine;
      }
      return joinUri(base, line, host);
    })
    .join('\n');
}

function joinUri(base: string, uri: string, host: string): string {
  if (/^https?:\/\//i.test(uri)) {
    // same-host absolute → keep only the path inside the folder
    try {
      const u = new URL(uri);
      if (u.host === host || /\.cloudfront\.net$/i.test(u.host)) {
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

/**
 * DASH manifests from shaka-packager carry ABSOLUTE folder-level BaseURLs
 * (https://<dist>/<folder>/) at MPD and AdaptationSet level. Left as-is the
 * player would resolve segments straight against the unsigned distribution
 * (403). Rewrite every such occurrence to our relay base so each segment
 * flows back through this route with its signature in the path.
 */
function rewriteMpd(body: string, base: string, host: string, folder: string): string {
  const esc = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`https?://${esc}/${folder}/`, 'gi');
  return body.replace(re, `${base}/`);
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const parts = (path || []).map((p) => decodeURIComponent(p));
  if (parts.length < 2) {
    return NextResponse.json({ success: false, error: 'Bad path' }, { status: 400 });
  }

  // Optional explicit host form: /api/pw/h/<host>/<folder>/...
  let host = '';
  let cursor = 0;
  if (parts[0] === 'h' && parts.length >= 3) {
    host = parts[1];
    cursor = 2;
  }

  let folder = parts[cursor];
  let sigSegment: string | null = null;
  let asset: string[];
  if (parts[cursor + 1] === 's' && parts.length >= cursor + 4 && SAFE_SIG.test(parts[cursor + 2])) {
    sigSegment = parts[cursor + 2];
    asset = parts.slice(cursor + 3);
  } else {
    asset = parts.slice(cursor + 1);
  }

  if (!host) host = getHostForFolder(folder) || CLOUDFRONT_HOST;

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
    // last resort — the owner-provided constant fallback table
    const fb = getFallbackSignedQuery(folder);
    if (fb) {
      signedQuery = fb;
      // propagate it statelessly for every segment the player resolves
      sigSegment = Buffer.from(fb, 'utf8').toString('base64url');
    }
  }
  if (!signedQuery) {
    return NextResponse.json(
      { success: false, error: 'Unknown or expired stream. Reload the lecture.' },
      { status: 403 },
    );
  }

  const assetPath = buildAssetPath(folder, asset);
  if (!assetPath) {
    return NextResponse.json({ success: false, error: 'Bad path' }, { status: 400 });
  }

  const fileName = asset[asset.length - 1];
  const isPlaylist = /\.m3u8$/i.test(fileName);
  const isManifest = /\.mpd$/i.test(fileName);

  const range = request.headers.get('range');
  const upstreamRes = await fetchSignedAsset(host, assetPath, signedQuery, {
    headers: range ? { Range: range } : undefined,
    timeoutMs: 60000,
  });

  if (!upstreamRes.ok) {
    return NextResponse.json(
      { success: false, error: `Upstream ${upstreamRes.status}` },
      { status: upstreamRes.status === 403 ? 403 : 502 },
    );
  }

  if (isPlaylist || isManifest) {
    const text = await upstreamRes.text();
    const hostSeg = host === CLOUDFRONT_HOST ? '' : '/h/' + host;
    // Always carry a stateless signature segment so segments need no registry
    const sigSeg = sigSegment ?? Buffer.from(signedQuery, 'utf8').toString('base64url');
    const base = `/api/pw${hostSeg}/${folder}/s/${sigSeg}`;
    const body = isPlaylist ? rewritePlaylist(text, base, host) : rewriteMpd(text, base, host, folder);
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
  return new NextResponse(upstreamRes.body, { status: upstreamRes.status, headers });
}
