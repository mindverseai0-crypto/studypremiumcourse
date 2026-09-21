import { NextRequest, NextResponse } from 'next/server';
import {
  parseSignedUrl,
  parseLiveSignedUrl,
  persistSignature,
  persistLiveSignature,
  listStoredSignatures,
  ParsedSignature,
} from '@/lib/signature-store';
import { fetchSignedAsset } from '@/lib/pw-cdn';
import { lxOtp } from '@/lib/lx-api';

export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** base64url-encode a signed query for the stateless /s/<sig>/ relay path. */
function sigPathSegment(signedQuery: string): string {
  const q = signedQuery.startsWith('?') ? signedQuery.slice(1) : signedQuery;
  return Buffer.from(q, 'utf8').toString('base64url');
}

/**
 * POST /api/pw-register
 *
 * Register a signed CloudFront lecture URL at runtime. This is the recovery
 * path when every upstream signing API is gated: the owner pastes the signed
 * URL (…/master.mpd?Signature=…&Key-Pair-Id=…&Policy=…) and the lecture
 * plays immediately — the signature is persisted server-side so it survives
 * restarts.
 *
 * Body: { url: "https://<dist>/<folder>/master.mpd?Signature=…&…&…" }
 *   or  { folder, signature }  (signature = the raw query string)
 *
 * Returns { success, folder, host, kind, relayUrl, clearKeys?, exp }.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    url?: unknown;
    folder?: unknown;
    signature?: unknown;
  };

  const rawUrl = typeof body.url === 'string' ? body.url : '';
  const folderHint = typeof body.folder === 'string' ? body.folder.trim() : '';
  const rawSig = typeof body.signature === 'string' ? body.signature.trim() : '';

  // ---- LIVE urls (root-level manifest, no UUID folder) first ----
  if (rawUrl && /\.(?:m3u8|mpd)(\?|$)/i.test(rawUrl) && !/\/[a-f0-9-]{16,}\//i.test(rawUrl.split('?')[0])) {
    const live = parseLiveSignedUrl(rawUrl);
    if (!live.ok) {
      // structurally a live url — surface the live-specific error
      if (/^https?:\/\//i.test(rawUrl) && !/\/[a-f0-9-]{16,}\//i.test(rawUrl.split('?')[0])) {
        return NextResponse.json({ success: false, error: live.error }, { status: 400, headers: CORS });
      }
    } else {
      const { sig } = live;
      persistLiveSignature(sig);

      // best-effort manifest probe so the caller knows whether it plays yet
      let manifestOk: boolean | null = null;
      try {
        const res = await fetch(`https://${sig.host}/${sig.asset}${sig.query}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(20000),
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
          },
        });
        manifestOk = res.ok;
      } catch {
        manifestOk = null;
      }

      const kind = /\.mpd$/i.test(sig.asset) ? 'dash' : 'hls';
      return NextResponse.json(
        {
          success: true,
          live: true,
          host: sig.host,
          asset: sig.asset,
          kind,
          relayUrl: `/api/live/h/${sig.host}/${sig.asset}`,
          manifestOk,
          exp: sig.exp,
        },
        { headers: CORS },
      );
    }
  }

  let parsed: ParsedSignature;
  if (rawUrl) {
    const r = parseSignedUrl(rawUrl);
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400, headers: CORS });
    parsed = r.sig;
  } else if (folderHint && rawSig) {
    const sig = rawSig.startsWith('?') ? rawSig : `?${rawSig}`;
    const r = parseSignedUrl(`https://d1d34p8vz63oiq.cloudfront.net/${folderHint}/master.mpd${sig}`);
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400, headers: CORS });
    parsed = r.sig;
  } else {
    return NextResponse.json(
      { success: false, error: 'Send { url } (full signed lecture URL) or { folder, signature }.' },
      { status: 400, headers: CORS },
    );
  }

  // Persist + hydrate the in-memory registry.
  persistSignature(parsed, 'manual');

  // Best-effort manifest probe: confirm the signature actually works and,
  // for DASH, resolve the ClearKey KID so DRM lectures decrypt.
  const subPath = parsed.subPath || 'master.mpd';
  let kind = 'mp4';
  if (/\.mpd$/i.test(subPath)) kind = 'dash';
  else if (/\.m3u8$/i.test(subPath)) kind = 'hls';

  let clearKeys: Record<string, string> | null = null;
  let manifestOk: boolean | null = null;
  try {
    const res = await fetchSignedAsset(parsed.host, `${parsed.folder}/${subPath}`, parsed.query, {
      timeoutMs: 30000,
    });
    manifestOk = res.ok;
    if (res.ok && kind === 'dash') {
      const text = await res.text();
      const kidMatch = text.match(/default_KID="([0-9a-fA-F-]+)"/);
      if (kidMatch) clearKeys = await lxOtp(kidMatch[1]);
    }
  } catch {
    manifestOk = null; // upstream probe failed — registration kept, playback may still work
  }

  const sig = sigPathSegment(parsed.query);
  const hostSeg = parsed.host === 'd1d34p8vz63oiq.cloudfront.net' ? '' : `/h/${parsed.host}`;
  const relayUrl = `/api/pw${hostSeg}/${parsed.folder}/s/${sig}/${subPath}`;

  return NextResponse.json(
    {
      success: true,
      folder: parsed.folder,
      host: parsed.host,
      kind,
      relayUrl,
      clearKeys,
      manifestOk,
      exp: parsed.exp,
    },
    { headers: CORS },
  );
}

/** GET /api/pw-register — list registered folders (no raw signatures). */
export async function GET() {
  return NextResponse.json({ success: true, data: listStoredSignatures() }, { headers: CORS });
}
