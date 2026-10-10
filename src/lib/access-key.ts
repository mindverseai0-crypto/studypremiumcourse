// ============================================================================
// 24h Access-Key System — stateless, HMAC-signed, NO database.
// ----------------------------------------------------------------------------
// Token format:  base64url(JSON payload) + "." + hex HMAC-SHA256
//                MAC = HMAC-SHA256("<purpose>:<body>", SESSION_SECRET)
//   purpose "pending" → { key, exp (epoch ms), nonce }   (pre-activation)
//   purpose "session" → { key, p (permanent?), exp }     (active sid cookie)
//
// Flow: generate → VPLink short link → verify (nonce-bound cookie swap) →
// sid session cookie. Every check is signature + expiry only; nothing is
// stored server-side.
// ============================================================================

import crypto from "crypto";

// ---------------------------------------------------------------------------
// Config (hardcoded per spec — no env setup needed).
// ACCESS_KEY_SITE_URL env var overrides SITE_URL so a deployment can point the
// VPLink verify redirect at its real public domain without a code change.
// ---------------------------------------------------------------------------
const VPLINK_API_TOKEN = "938c2ec8f766a346b65c1968eaa035afd5f9680c"; // vplink.in API token
const SESSION_SECRET =
  "55890b0a2a0b51320ef130ed17f4f67317f86370fb3a39d07dc2603b3025f08e"; // fresh per project

const SITE_URL =
  process.env.ACCESS_KEY_SITE_URL || "https://studypremiumcourse.vercel.app";

export const PENDING_COOKIE = "pending";
export const SESSION_COOKIE = "sid";
export const ACCESS_DURATION_MS = 24 * 60 * 60 * 1000; // 24h

// ---------------------------------------------------------------------------
// Kill-switches (simple env flags per spec §5.2)
// ---------------------------------------------------------------------------
export function isKeyGenerationEnabled(): boolean {
  return process.env.ACCESS_KEY_GENERATION_DISABLED !== "1";
}

export function isGateEnabled(): boolean {
  return process.env.ACCESS_KEY_GATE_DISABLED !== "1";
}

// ---------------------------------------------------------------------------
// Key string — ARO-XXXX-XXXX-XXXX-XXXX
// ---------------------------------------------------------------------------
export function generateKeyString(): string {
  const group = () =>
    crypto.randomBytes(2).toString("hex").toUpperCase().slice(0, 4);
  return `ARO-${group()}-${group()}-${group()}-${group()}`;
}

// ---------------------------------------------------------------------------
// Signed-token machinery
// ---------------------------------------------------------------------------

function b64urlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function hmac(purpose: string, body: string): string {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(`${purpose}:${body}`)
    .digest("hex");
}

export function signToken(purpose: "pending" | "session", payload: object): string {
  const body = b64urlEncode(JSON.stringify(payload));
  return `${body}.${hmac(purpose, body)}`;
}

export function verifyToken<T>(
  purpose: "pending" | "session",
  token: string | undefined | null
): T | null {
  if (!token || typeof token !== "string") return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0 || idx === token.length - 1) return null;
  const body = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = hmac(purpose, body);
  const a = Buffer.from(mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const json = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return (json && typeof json === "object" ? json : null) as T | null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pending grant (minted per generate request — nothing stored server-side)
// ---------------------------------------------------------------------------

export interface PendingPayload {
  key: string;
  exp: number; // epoch ms
  nonce: string;
}

export interface SessionPayload {
  key: string;
  p: boolean; // permanent?
  exp: number | null;
}

export function createPendingKey(): {
  key: string;
  expires: number;
  token: string;
  nonce: string;
} {
  const key = generateKeyString();
  const expires = Date.now() + ACCESS_DURATION_MS;
  const nonce = crypto.randomBytes(16).toString("hex");
  const token = signToken("pending", { key, exp: expires, nonce } satisfies PendingPayload);
  return { key, expires, token, nonce };
}

// Anti-sharing swap: the URL token must exactly match the browser's pending
// cookie (nonce binding) before it can be exchanged for a session token.
export function activateKeyByToken(
  urlToken: string | null,
  cookieToken: string | null | undefined
): SessionPayload | null {
  const payload = verifyToken<PendingPayload>("pending", urlToken);
  if (!payload || typeof payload.key !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp <= Date.now()) return null;

  if (payload.nonce) {
    if (!cookieToken || typeof cookieToken !== "string") return null;
    if (cookieToken.length !== urlToken!.length) return null;
    const a = Buffer.from(cookieToken, "utf8");
    const b = Buffer.from(urlToken!, "utf8");
    if (!crypto.timingSafeEqual(a, b)) return null;
  }

  return { key: payload.key, p: false, exp: payload.exp };
}

export function buildSessionToken(key: string, permanent: boolean, exp: number | null): string {
  return signToken("session", { key, p: permanent, exp } satisfies SessionPayload);
}

export function readSession(cookieValue: string | undefined | null): SessionPayload | null {
  const payload = verifyToken<SessionPayload>("session", cookieValue);
  if (!payload || typeof payload.key !== "string") return null;
  if (payload.exp !== null && (typeof payload.exp !== "number" || payload.exp <= Date.now())) {
    return null;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Cookie helpers (real expiry lives in the signed payload, not Max-Age)
// ---------------------------------------------------------------------------

function cookieBase(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure, // set when served over https (production / gateway); omitted on plain http dev
  };
}

export function setSessionCookie(res: import("next").NextResponse, token: string, secure: boolean) {
  res.cookies.set(SESSION_COOKIE, token, { ...cookieBase(secure), maxAge: 60 * 60 * 24 * 365 });
}

export function setPendingCookie(res: import("next").NextResponse, token: string, expiresMs: number, secure: boolean) {
  const maxAge = Math.max(60, Math.floor((expiresMs - Date.now()) / 1000));
  res.cookies.set(PENDING_COOKIE, token, { ...cookieBase(secure), maxAge });
}

export function clearCookie(res: import("next").NextResponse, name: string) {
  res.cookies.set(name, "", { ...cookieBase(false), maxAge: 0 });
}

// ---------------------------------------------------------------------------
// Request origin helpers (gateway/proxy aware)
// ---------------------------------------------------------------------------

// The browser-visible origin: behind the sandbox gateway / any reverse proxy,
// X-Forwarded-Host + X-Forwarded-Proto carry the public host. Only used for
// the same-origin check and — in sandbox mode ONLY — the direct verify link.
// It is NEVER used as the VPLink destination (that is always SITE_URL).
export function publicOrigin(req: Request): string {
  const xfHost = req.headers.get("x-forwarded-host");
  const host = (xfHost ? xfHost.split(",")[0].trim() : "") || req.headers.get("host") || "localhost:3000";
  const proto =
    (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim() ||
    (/^(localhost|127\.|0\.|10\.|192\.168\.)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

export function isSecureRequest(req: Request): boolean {
  return publicOrigin(req).startsWith("https://");
}

// Blocks cross-site scripted abuse of the generate endpoint.
//
// The Origin host must match a host this request is actually addressed by.
// Behind nested proxies (sandbox preview, Caddy, CDNs) the Host header can be
// rewritten at any hop, so EVERY plausible representation is accepted:
// X-Forwarded-Host, Host, req.url host and (production) the SITE_URL host.
// Hosts are compared with and without their port (and with default ports).
// In production (public SITE_URL configured) enforcement is strict — an
// unrecognized Origin is still rejected. In sandbox/dev, where no canonical
// public host exists and proxies may rewrite all host headers, an unmatched
// Origin is tolerated: the endpoint remains protected by the HMAC signature,
// the pending-cookie nonce binding and the rate limiter (a minted key can
// never be redeemed cross-site), so nothing is weakened that matters.
export function checkSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin form posts / non-browser clients

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (!originHost) return false;

  const candidates = new Set<string>();
  const addHost = (value?: string | null) => {
    if (!value) return;
    const first = value.split(",")[0].trim().toLowerCase();
    if (!first) return;
    const bare = first.replace(/:\d+$/, "");
    candidates.add(first);
    candidates.add(bare);
    candidates.add(`${bare}:80`);
    candidates.add(`${bare}:443`);
  };
  addHost(req.headers.get("x-forwarded-host"));
  addHost(req.headers.get("host"));
  try {
    addHost(new URL(req.url).host);
  } catch {
    // req.url unparseable — skip this candidate
  }
  try {
    addHost(new URL(SITE_URL).host);
  } catch {
    // SITE_URL not configured — skipped
  }

  if (candidates.has(originHost)) return true;

  // Sandbox/dev fallback — see rationale above.
  return !isSiteUrlPublic();
}

// ---------------------------------------------------------------------------
// SITE_URL configuration detection
// ---------------------------------------------------------------------------

const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|\[::1\]|.*\.local|.*\.internal)/i;

export function isSiteUrlPublic(): boolean {
  try {
    const u = new URL(SITE_URL);
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      u.hostname !== "your-public-domain.com" &&
      !PRIVATE_HOST_RE.test(u.hostname)
    );
  } catch {
    return false;
  }
}

// Verify URL built from the configured SITE_URL — never from the request
// origin (VPLink rejects localhost, and behind proxies the origin is an
// internal host). Only used as the VPLink destination in production.
export function buildVerifyUrlFromSite(token: string): string {
  const u = new URL("/api/access-key/verify", SITE_URL);
  u.searchParams.set("token", token);
  return u.toString();
}

// ---------------------------------------------------------------------------
// VPLink ad-gateway (server-side ONLY — token must never reach the client)
// ---------------------------------------------------------------------------

export async function createVplinkUrl(destinationUrl: string): Promise<string | null> {
  const params = new URLSearchParams({
    api: VPLINK_API_TOKEN,
    url: destinationUrl, // verify URL with ?token=...
    alias: crypto.randomBytes(4).toString("hex"), // random short-link alias
    format: "json",
  });
  try {
    const res = await fetch(`https://vplink.in/api?${params.toString()}`, {
      signal: AbortSignal.timeout(8000), // 8s timeout
    });
    if (!res.ok) return null;
    const json = await res.json();
    // Success shape: { status: "success", shortenedUrl: "https://vplink.in/xxxx" }
    return json?.status === "success" && json?.shortenedUrl ? json.shortenedUrl : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rate limiter — sliding window, in-memory.
// 3 per IP per 10 min  +  global fleet cap 9 per 10 min across ALL IPs
// (stops rotating-IP bots). The ad gate only discourages abuse; the rate
// limiter actually stops it.
// ---------------------------------------------------------------------------

const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_IP_LIMIT = 3;
const RL_GLOBAL_LIMIT = 9;

const rlBuckets = new Map<string, number[]>();
let rlLastPrune = 0;

function pruneBuckets(now: number) {
  if (now - rlLastPrune < 60_000) return;
  rlLastPrune = now;
  for (const [k, hits] of rlBuckets) {
    const alive = hits.filter((t) => now - t < RL_WINDOW_MS);
    if (alive.length === 0) rlBuckets.delete(k);
    else rlBuckets.set(k, alive);
  }
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return (
    req.headers.get("x-real-ip") ||
    req.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

export function checkRateLimit(
  ip: string
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  pruneBuckets(now);

  const hits = (rlBuckets.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  const global = (rlBuckets.get("__global__") || []).filter(
    (t) => now - t < RL_WINDOW_MS
  );

  if (hits.length >= RL_IP_LIMIT) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((RL_WINDOW_MS - (now - hits[0])) / 1000)),
    };
  }
  if (global.length >= RL_GLOBAL_LIMIT) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((RL_WINDOW_MS - (now - global[0])) / 1000)),
    };
  }

  rlBuckets.set(ip, [...hits, now]);
  rlBuckets.set("__global__", [...global, now]);
  return { allowed: true, retryAfterSec: 0 };
}
