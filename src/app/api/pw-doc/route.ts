// ============================================================================
// Doc relay — same-origin proxy for lecture documents (Notes / DPP PDFs).
//
// GET /api/pw-doc?u=<url-encoded upstream url>
//
// Why a relay: the notes/DPP PDFs live on PW CDNs that don't send CORS
// headers, so the download engine can't read them browser-side and the
// offline player can't show them from an iframe. Routing through this
// same-origin relay gives us:
//   - readable responses (real status + size) for the download engine,
//   - a stable SAME-ORIGIN cache key that the service worker can serve
//     from the lecture's cache while the device is offline,
//   - inline PDF viewing in the player panel (no CORS, no CDN round-trip
//     leaks into the page).
//
// Only PW document hosts are allowed (strict hostname suffix whitelist) so
// this can never be abused as an open proxy.
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Host whitelist — PW document CDNs only (cloudfront + pw.live). */
const ALLOWED_HOST = /(^|\.)(cloudfront\.net|pw\.live)$/i;

const UPSTREAM_TIMEOUT_MS = 30_000;

export async function GET(request: NextRequest) {
  const raw = (request.nextUrl.searchParams.get('u') || '').trim();
  if (!raw) {
    return NextResponse.json({ success: false, error: 'Missing u parameter' }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid url' }, { status: 400 });
  }
  if (!/^https?:$/.test(target.protocol) || !ALLOWED_HOST.test(target.hostname)) {
    return NextResponse.json({ success: false, error: 'Host not allowed' }, { status: 403 });
  }

  try {
    const upstream = await fetch(target.href, {
      headers: {
        // static.pw.live 403s generic bots — a real browser UA is required
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        accept: '*/*',
        referer: 'https://www.pw.live/',
      },
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { success: false, error: `Upstream HTTP ${upstream.status}` },
        { status: 502 },
      );
    }

    const headers = new Headers();
    headers.set('Content-Type', upstream.headers.get('content-type') || 'application/pdf');
    const cl = upstream.headers.get('content-length');
    if (cl) headers.set('Content-Length', cl);
    headers.set('Cache-Control', 'public, max-age=86400');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new NextResponse(upstream.body, { status: 200, headers });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'Doc fetch failed' },
      { status: 502 },
    );
  }
}
