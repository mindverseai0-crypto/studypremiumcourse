// ============================================================================
// Persistent signature store for PW CloudFront folder signatures.
//
// Upstream signing APIs (learnxpw video-url, video-detail.studyparcham.in,
// pw.studyparcham.in v2 lists) gate most batches, so playable signatures
// arrive out-of-band (owner-provided). This store persists them to
// db/pw-signatures.json so they survive dev-server restarts, and re-hydrates
// the in-memory registry in pw-cdn.ts on demand.
//
// Accepted input forms (see parseSignedUrl):
//   - full signed URL  https://<dist>.cloudfront.net/<folder>/master.mpd?Signature=…&Key-Pair-Id=…&Policy=…
//   - bare signed query Signature=…&Key-Pair-Id=…&Policy=… (+ folder from the Policy Resource)
//
// The Policy statement is the source of truth: the Resource URL yields the
// distribution host + folder, and DateLessThan yields the expiry.
// ============================================================================

import fs from 'fs';
import path from 'path';
import {
  registerSignedFolder,
  registerFolderHost,
  getFallbackSignedQuery,
  FALLBACK_FOLDER_IDS,
} from './pw-cdn';

export interface StoredSignature {
  query: string; // "?Signature=…&Key-Pair-Id=…&Policy=…"
  host: string; // "<dist>.cloudfront.net"
  exp: number | null; // Policy DateLessThan epoch seconds
  addedAt: number; // epoch ms
  source: string; // 'builtin' | 'manual' | …
}

type StoreShape = Record<string, StoredSignature>;

const STORE_PATH = path.join(process.cwd(), 'db', 'pw-signatures.json');
const READ_CACHE_MS = 5000;

let cache: { at: number; shape: StoreShape } | null = null;
let seeded = false;

// ---------------------------------------------------------------------------
// disk io
// ---------------------------------------------------------------------------

function readStoreRaw(): StoreShape {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as StoreShape;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* missing / corrupt → empty */
  }
  return {};
}

function writeStoreRaw(shape: StoreShape): void {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const tmp = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(shape, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_PATH);
  } catch {
    /* best-effort persistence */
  }
}

function readStore(): StoreShape {
  if (cache && Date.now() - cache.at < READ_CACHE_MS) return cache.shape;
  const shape = readStoreRaw();
  cache = { at: Date.now(), shape };
  return shape;
}

function invalidateCache(): void {
  cache = null;
}

/**
 * Seed the store from the builtin fallback table (pw-cdn) the first time the
 * store is used and the file holds nothing — protects the known-good
 * signatures against accidental loss of the json file.
 */
function ensureSeeded(): void {
  if (seeded) return;
  seeded = true;
  const shape = readStoreRaw();
  if (Object.keys(shape).length > 0) return;
  const known = fallbackFolderIds();
  if (known.length === 0) return;
  const now = Date.now();
  for (const folder of known) {
    const q = getFallbackSignedQuery(folder);
    if (!q) continue;
    shape[folder] = {
      query: q.startsWith('?') ? q : `?${q}`,
      host: '',
      exp: policyExpiry(q),
      addedAt: now,
      source: 'builtin',
    };
  }
  if (Object.keys(shape).length > 0) writeStoreRaw(shape);
  invalidateCache();
}

// ---------------------------------------------------------------------------
// policy parsing
// ---------------------------------------------------------------------------

interface PolicyStatement {
  Resource?: string;
  Condition?: { DateLessThan?: { 'AWS:EpochTime'?: number } };
}

/** Decode a signed query's Policy and return {resource, exp} or null. */
export function parsePolicy(signedQuery: string): { resource: string; exp: number | null } | null {
  const m = signedQuery.match(/Policy=([^&]+)/);
  if (!m) return null;
  try {
    // Some signers pad base64url non-canonically — trim decoded bytes to the
    // outermost JSON object before parsing.
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const json = decoded.slice(decoded.indexOf('{'), decoded.lastIndexOf('}') + 1);
    const policy = JSON.parse(json) as { Statement?: PolicyStatement[] };
    const st = policy.Statement?.[0];
    if (!st) return null;
    const exp = st.Condition?.DateLessThan?.['AWS:EpochTime'] ?? null;
    return { resource: st.Resource || '', exp: typeof exp === 'number' ? exp : null };
  } catch {
    return null;
  }
}

function policyExpiry(signedQuery: string): number | null {
  return parsePolicy(signedQuery)?.exp ?? null;
}

export interface ParsedSignature {
  folder: string;
  host: string;
  query: string; // normalized, starts with "?"
  subPath: string; // manifest/asset path below the folder ("" if unknown)
  exp: number | null;
}

/**
 * Parse a pasted signed URL / query into a normalized signature.
 * Accepts:
 *   https://<dist>/…/<folder>/master.mpd?Signature=…&Key-Pair-Id=…&Policy=…
 *   https://<dist>/<folder>/hls/720/main.m3u8?Signature=…
 *   Signature=…&Key-Pair-Id=…&Policy=…           (folder/host from Policy)
 */
export function parseSignedUrl(raw: string): { ok: true; sig: ParsedSignature } | { ok: false; error: string } {
  const input = (raw || '').trim();
  if (!input) return { ok: false, error: 'Paste a signed lecture URL.' };

  let urlPart = input;
  let query = '';
  const qIdx = input.indexOf('?');
  if (qIdx >= 0) {
    urlPart = input.slice(0, qIdx);
    query = input.slice(qIdx + 1);
  } else if (/Signature=/i.test(input) && !/\.[a-z0-9]{2,5}(\?|$)/i.test(input)) {
    // bare query string pasted without a leading "?"
    query = input;
    urlPart = '';
  }

  const has = (k: string) => new RegExp(`[?&]?${k}=`, 'i').test(query || '');
  if (!query || !(has('Signature') && has('Key-Pair-Id') && has('Policy'))) {
    return {
      ok: false,
      error: 'URL is missing Signature / Key-Pair-Id / Policy — copy the FULL signed URL including the query string.',
    };
  }
  const normalized = `?${query.replace(/^[?&]+/, '')}`;

  const policy = parsePolicy(normalized);
  if (!policy) {
    return { ok: false, error: 'Policy could not be decoded — the signature looks truncated or invalid.' };
  }
  if (policy.exp !== null) {
    const now = Math.floor(Date.now() / 1000);
    if (now >= policy.exp) {
      return { ok: false, error: 'This signature has expired (Policy DateLessThan already passed).' };
    }
  }

  // Prefer the Policy Resource for host+folder (works even for bare queries).
  let host = '';
  let folder = '';
  let subPath = '';
  if (policy.resource) {
    try {
      const u = new URL(policy.resource);
      host = u.host;
      const parts = u.pathname.split('/').filter(Boolean);
      folder = parts[0] || '';
      // Resource is folder-wide: "…/<folder>/*" — the wildcard is not an asset.
      const rest = parts.slice(1).filter((p) => p !== '*');
      subPath = rest.join('/');
    } catch {
      /* non-URL resource — fall through to the pasted url */
    }
  }
  if (!folder && urlPart) {
    // last resort: first path segment below the host of the pasted url
    try {
      const u = new URL(urlPart);
      host = u.host;
      folder = u.pathname.split('/').filter(Boolean)[0] || '';
      const parts = u.pathname.split('/').filter(Boolean);
      subPath = parts.slice(1).join('/');
    } catch {
      /* ignore */
    }
  }
  // Folder-wide policies ("…/<folder>/*") carry no asset path — fall back to
  // the PASTED URL's own subpath so kind detection (mpd/m3u8/mp4) stays true
  // to what was actually pasted.
  if (folder && !subPath && urlPart) {
    try {
      const u = new URL(urlPart);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === folder) subPath = parts.slice(1).join('/');
    } catch {
      /* ignore */
    }
  }
  if (!/^[a-f0-9-]{16,}$/i.test(folder)) {
    return { ok: false, error: 'Could not determine the video folder from this URL (no UUID path segment found).' };
  }
  if (!/\.cloudfront\.net$/i.test(host)) host = host || 'd1d34p8vz63oiq.cloudfront.net';

  return { ok: true, sig: { folder, host, query: normalized, subPath, exp: policy.exp } };
}

// ---------------------------------------------------------------------------
// persistence + registry hydration
// ---------------------------------------------------------------------------

/** Upsert a signature into the store and the in-memory registry. */
export function persistSignature(sig: ParsedSignature, source = 'manual'): StoredSignature {
  ensureSeeded();
  const shape = readStoreRaw();
  const entry: StoredSignature = {
    query: sig.query,
    host: sig.host,
    exp: sig.exp,
    addedAt: Date.now(),
    source,
  };
  shape[sig.folder] = entry;
  writeStoreRaw(shape);
  invalidateCache();
  hydrate(sig.folder, entry);
  return entry;
}

/** Hydrate one entry into the pw-cdn in-memory registry. */
function hydrate(folder: string, entry: StoredSignature): void {
  registerSignedFolder(folder, entry.query, entry.host);
  if (entry.host) registerFolderHost(folder, entry.host);
}

/**
 * Store lookup used by the relay + data routes when the in-memory registry
 * misses (e.g. after TTL eviction or a fresh process). Re-hydrates the
 * registry as a side effect. Returns the signed query or null.
 */
export function lookupStoredSignature(folder: string): string | null {
  const f = (folder || '').trim();
  if (!f) return null;
  const shape = readStore();
  const entry = shape[f];
  if (!entry) return null;
  if (entry.exp !== null && entry.exp !== undefined) {
    if (Math.floor(Date.now() / 1000) >= entry.exp) return null; // expired
  }
  hydrate(f, entry);
  return entry.query;
}

/** Registered folders for admin/inspection (no raw signatures). */
export function listStoredSignatures(): Array<{
  folder: string;
  host: string;
  exp: number | null;
  addedAt: number;
  source: string;
}> {
  ensureSeeded();
  const shape = readStore();
  return Object.entries(shape)
    .map(([folder, e]) => ({
      folder,
      host: e.host,
      exp: e.exp ?? null,
      addedAt: e.addedAt ?? 0,
      source: e.source || 'manual',
    }))
    .sort((a, b) => b.addedAt - a.addedAt);
}

/** Builtin fallback folders known to pw-cdn (used for seeding). */
function fallbackFolderIds(): string[] {
  return [...FALLBACK_FOLDER_IDS];
}
