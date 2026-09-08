// ============================================================================
// GET /api/access-key/status — verify the `sid` cookie's signature + exp
// claim (no DB lookup ever happens) and report feature toggles.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import {
  isGateEnabled,
  isKeyGenerationEnabled,
  readSession,
  SESSION_COOKIE,
} from "@/lib/access-key";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = readSession(req.cookies.get(SESSION_COOKIE)?.value);

  return NextResponse.json(
    {
      ok: true,
      hasKey: !!session,
      key: session?.key ?? null,
      isPermanent: session?.p ?? false,
      expires: session?.exp ? new Date(session.exp).toISOString() : null,
      timeLeft: session?.exp ? Math.max(0, Math.floor((session.exp - Date.now()) / 1000)) : null,
      // feature toggles
      gateEnabled: isGateEnabled(),
      keyGenerationEnabled: isKeyGenerationEnabled(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
