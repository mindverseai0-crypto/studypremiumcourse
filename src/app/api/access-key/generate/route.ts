// ============================================================================
// POST /api/access-key/generate — mints a pending 24h grant, creates the
// VPLink short link to our verify endpoint, sets the `pending` cookie and
// returns { key, expiresAt, vplinkUrl }.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import {
  buildVerifyUrlFromSite,
  checkRateLimit,
  checkSameOrigin,
  clientIp,
  createPendingKey,
  createVplinkUrl,
  isKeyGenerationEnabled,
  isSiteUrlPublic,
  publicOrigin,
  setPendingCookie,
} from "@/lib/access-key";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // 1. Same-origin check (blocks cross-site scripted abuse)
    if (!checkSameOrigin(req)) {
      return NextResponse.json(
        { success: false, error: "Cross-site key generation is not allowed." },
        { status: 403 }
      );
    }

    // 2. Admin kill-switch
    if (!isKeyGenerationEnabled()) {
      return NextResponse.json(
        { success: false, error: "Key generation is temporarily disabled." },
        { status: 403 }
      );
    }

    // 3. Rate limit — 3/IP/10min + global fleet cap 9/10min
    const rl = checkRateLimit(clientIp(req));
    if (!rl.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: `Too many attempts. Please try again in ${Math.ceil(rl.retryAfterSec / 60)} minute(s).`,
        },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
      );
    }

    // 4. Mint the pending grant (stateless — everything is in the token)
    const { key, expires, token } = createPendingKey();

    // 5. Build the activation link.
    //    - Production (SITE_URL is a real public domain): VPLink short link
    //      whose destination is SITE_URL + /api/access-key/verify?token=...
    //      (built from the configured SITE_URL — never the request origin,
    //      because VPLink rejects localhost and proxied origins are internal).
    //    - Sandbox/dev (SITE_URL not configured): VPLink cannot be used for
    //      non-public destinations, so the browser visits the verify URL on
    //      this origin directly. ALL security checks (signature, expiry,
    //      pending-cookie nonce binding, rate limits) remain fully enforced —
    //      only the external ad step is skipped.
    let vplinkUrl: string;
    let mode: "vplink" | "direct";
    let devNote: string | undefined;

    if (isSiteUrlPublic()) {
      const verifyUrl = buildVerifyUrlFromSite(token);
      const short = await createVplinkUrl(verifyUrl);
      if (!short) {
        return NextResponse.json(
          {
            success: false,
            error: "The ad gateway is unreachable right now. Please retry in a moment.",
          },
          { status: 502 }
        );
      }
      vplinkUrl = short;
      mode = "vplink";
    } else {
      // Sandbox/dev: return a RELATIVE verify URL. The browser resolves it
      // against the origin it is actually viewing the site on, so nested
      // preview proxies that rewrite Host/X-Forwarded-* can never produce a
      // broken or foreign absolute URL. Same-origin by construction; all
      // security checks still apply at the verify endpoint.
      vplinkUrl = `/api/access-key/verify?token=${encodeURIComponent(token)}`;
      mode = "direct";
      devNote =
        "SITE_URL is not configured for a public domain — running in sandbox mode: the ad-gateway step is skipped and activation completes directly. All security checks still apply.";
    }

    // 6. Set the pending cookie and respond
    const secure = publicOrigin(req).startsWith("https://");
    const res = NextResponse.json({
      success: true,
      key,
      type: "temp",
      expiresAt: new Date(expires).toISOString(),
      vplinkUrl,
      mode,
      ...(devNote ? { devNote } : {}),
    });
    setPendingCookie(res, token, expires, secure);
    return res;
  } catch (err) {
    console.error("[access-key/generate]", err);
    return NextResponse.json(
      { success: false, error: "Could not start key generation. Please retry." },
      { status: 500 }
    );
  }
}
