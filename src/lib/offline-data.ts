'use client';

// ============================================================================
// Study Bison — offline app-data cache (enrolled batches & their content).
//
// Every catalog/study API response relayed through parchamCore is persisted
// here (IndexedDB store `kv` in DB `sb-appcache`). When the device is offline
// — or the network call fails — the app transparently falls back to the last
// cached copy, so the user can keep browsing their enrolled batches, subjects,
// chapters, lectures, notes and DPP PDFs with the network fully off.
//
// Design notes:
//   - Small LRU-ish store: entries expire after 7 days and the store is kept
//     under MAX_ENTRIES (pruned oldest-first, throttled to every Nth write).
//   - Side-effectful actions (video payload signing, DPP start) are never
//     cached — callers exclude them.
//   - Every failure is swallowed: the cache is a progressive enhancement, it
//     must never break an online flow.
// ============================================================================

const DB_NAME = 'sb-appcache';
const DB_VERSION = 1;
const STORE = 'kv';
const MAX_ENTRIES = 300;
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CacheEntry {
  key: string;
  at: number;
  val: unknown;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
    } catch (e) {
      reject(e instanceof Error ? e : new Error('IndexedDB unavailable'));
    }
  });
  return dbPromise;
}

/** True when the browser currently reports no network connection. */
export function isOffline(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  } catch {
    return false;
  }
}

/** Stable cache key for one upstream call (action + sorted params). */
export function apiCacheKey(action: string, params: Record<string, unknown> = {}): string {
  const parts = Object.keys(params || {})
    .sort()
    .map((k) => `${k}=${params[k] == null ? '' : String(params[k])}`);
  return `pw:${action}:${parts.join('&')}`;
}

let putCount = 0;

/** Persist one API response (best-effort, never throws). */
export async function cacheApiPut(key: string, val: unknown): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put({ key, at: Date.now(), val } satisfies CacheEntry);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('IndexedDB aborted'));
    });
    void pruneCache();
  } catch {
    /* cache is best-effort */
  }
}

/** Read one cached API response, or null when missing/expired. */
export async function cacheApiGet<T = unknown>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise<T | null>((resolve) => {
      const t = db.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).get(key);
      req.onsuccess = () => {
        const hit = req.result as CacheEntry | undefined;
        if (!hit || hit.val == null) return resolve(null);
        if (!hit.at || Date.now() - hit.at > TTL_MS) return resolve(null);
        resolve(hit.val as T);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** Evict expired + oldest-beyond-cap entries. Throttled to every 25th put. */
async function pruneCache(): Promise<void> {
  putCount++;
  if (putCount % 25 !== 0) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const t = db.transaction(STORE, 'readwrite');
      const store = t.objectStore(STORE);
      const live: Array<{ key: IDBValidKey; at: number }> = [];
      const now = Date.now();
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          // cursor pass finished — transaction is still alive here
          if (live.length > MAX_ENTRIES) {
            live.sort((a, b) => a.at - b.at); // oldest first
            for (let i = 0; i < live.length - MAX_ENTRIES; i++) {
              try {
                store.delete(live[i].key);
              } catch {
                /* ignore */
              }
            }
          }
          done();
          return;
        }
        const val = cursor.value as CacheEntry | undefined;
        if (!val || !val.at || now - val.at > TTL_MS) {
          try {
            cursor.delete();
          } catch {
            /* ignore */
          }
        } else {
          live.push({ key: cursor.key, at: val.at });
        }
        cursor.continue();
      };
      cursorReq.onerror = () => done();
      t.oncomplete = () => done();
      t.onerror = () => done();
      t.onabort = () => done();
    });
  } catch {
    /* ignore */
  }
}
