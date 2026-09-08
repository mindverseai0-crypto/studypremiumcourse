// ============================================================================
// POST /api/access-key/clear — logout: clear the `sid` cookie.
// ============================================================================

import { NextResponse } from "next/server";
import { clearCookie, SESSION_COOKIE } from "@/lib/access-key";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ success: true });
  clearCookie(res, SESSION_COOKIE);
  return res;
}
