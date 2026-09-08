// ============================================================================
// GET /api/access-key/verify?token=<pending token>
// VPLink redirect lands here. Validates the URL token signature + expiry,
// requires it to EXACTLY match the browser's `pending` cookie (nonce binding
// — a link shared to another browser can't be redeemed), then swaps it for a
// signed 24h `sid` session cookie and redirects to /?verify=activated.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import {
  activateKeyByToken,
  buildSessionToken,
  clearCookie,
  PENDING_COOKIE,
  setSessionCookie,
} from "@/lib/access-key";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectWithCookies(req: NextRequest, location: string, sid?: string) {
  // 302 with a RELATIVE Location so the browser stays on its current origin
  // (behind the gateway/proxy the internal request origin is not reachable).
  const secure = req.headers.get("x-forwarded-proto") === "https";
  const res = new NextResponse(null, { status: 302, headers: { Location: location } });

  if (sid) {
    setSessionCookie(res, sid, secure);
  }
  clearCookie(res, PENDING_COOKIE); // clear pending after redemption or failure
  return res;
}

export async function GET(req: NextRequest) {
  const urlToken = req.nextUrl.searchParams.get("token");
  const cookieToken = req.cookies.get(PENDING_COOKIE)?.value ?? null;

  const session = activateKeyByToken(urlToken, cookieToken);

  if (session) {
    const sid = buildSessionToken(session.key, session.p, session.exp);
    return redirectWithCookies(req, "/?verify=activated", sid);
  }

  return redirectWithCookies(req, "/?verify=invalid_or_expired");
}
