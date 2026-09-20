// ============================================================================
// Avatar API — profile pictures for the bot students (and anyone without a
// real DP). Proxies DiceBear cartoon avatars server-side so the browser never
// depends on a third-party origin, caches aggressively in memory, and falls
// back to a locally-generated initials SVG when upstream is unreachable.
//
// GET /api/avatar?seed=<name>  → image/svg+xml (Cache-Control: public, 7d)
// ============================================================================

export const dynamic = 'force-dynamic';

const UP = 'https://api.dicebear.com/9.x/adventurer/svg';
const MAX_MEM = 200;
const memCache = new Map<string, { at: number; body: string }>();

const PALETTES: Array<[string, string]> = [
  ['#fca5a5', '#ef4444'],
  ['#fdba74', '#f97316'],
  ['#fde047', '#eab308'],
  ['#86efac', '#22c55e'],
  ['#67e8f9', '#06b6d4'],
  ['#93c5fd', '#3b82f6'],
  ['#c4b5fd', '#8b5cf6'],
  ['#f9a8d4', '#ec4899'],
];

function hashOf(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function initialsSvg(seed: string): string {
  const clean = (seed || 'S').trim().slice(0, 12) || 'S';
  const initial = clean.charAt(0).toUpperCase();
  const [c1, c2] = PALETTES[hashOf(clean) % PALETTES.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
<rect width="96" height="96" rx="48" fill="url(#g)"/>
<text x="48" y="62" font-family="Inter,Arial,sans-serif" font-size="42" font-weight="800" fill="#ffffff" text-anchor="middle">${initial}</text>
</svg>`;
  return svg.replace(/\n/g, '');
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const seed = (searchParams.get('seed') || 'Student').trim().slice(0, 60);

  const hit = memCache.get(seed);
  if (hit && Date.now() - hit.at < 7 * 24 * 60 * 60 * 1000) {
    return new Response(hit.body, {
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=604800' },
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const url = `${UP}?seed=${encodeURIComponent(seed)}&radius=50&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf&backgroundType=gradientLinear`;
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const body = await res.text();
      if (memCache.size >= MAX_MEM) {
        const oldest = memCache.keys().next().value;
        if (oldest) memCache.delete(oldest);
      }
      memCache.set(seed, { at: Date.now(), body });
      return new Response(body, {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=604800' },
      });
    }
  } catch {
    clearTimeout(timer);
  }
  return new Response(initialsSvg(seed), {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=604800' },
  });
}
