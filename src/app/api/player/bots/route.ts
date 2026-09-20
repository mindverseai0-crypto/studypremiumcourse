// ============================================================================
// Bot students API — makes the comment section feel like a real classroom.
//
// POST /api/player/bots
//   { action: "seed",  threadKey, title?, batchName? }
//     → generates a natural bot-student conversation for an EMPTY thread
//       (casual banter + academic doubts answered correctly) and persists it
//       with organic staggered timestamps. Idempotent: skipped when the
//       thread already has comments.
//   { action: "reply", threadKey, commentId, text, author?, title?, batchName? }
//     → a random bot answers a real student's comment (correct explanation
//       for doubts, friendly banter otherwise) and returns the reply item.
//
// LLM: z-ai-web-dev-sdk (server-side only), JSON-tolerant parsing, hard
// timeouts and safe fallbacks so the player never breaks when the model or
// network is unavailable.
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { BOT_PERSONAS, BOT_NAMES } from '@/lib/bots';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// LLM helper (lazy singleton + timeout)
// ---------------------------------------------------------------------------

type ChatMessages = Array<{ role: 'assistant' | 'user'; content: string }>;
let zaiPromise: Promise<{ chat: { completions: { create: (o: { messages: ChatMessages; thinking: { type: string } }) => Promise<{ choices?: Array<{ message?: { content?: string } }> }> } } } | null> | null = null;

async function getZai() {
  if (!zaiPromise) {
    zaiPromise = import('z-ai-web-dev-sdk')
      .then(async (mod) => {
        const ZAI = mod.default;
        return await ZAI.create();
      })
      .catch(() => null);
  }
  return zaiPromise;
}

async function llmComplete(messages: ChatMessages, timeoutMs: number): Promise<string | null> {
  const zai = await getZai();
  if (!zai) return null;
  try {
    const result = await Promise.race([
      zai.chat.completions.create({ messages, thinking: { type: 'disabled' } }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    const text = result?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

/** Pull the first JSON array embedded in an LLM response. */
function extractJsonArray(raw: string): Array<Record<string, unknown>> | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1).replace(/,\s*([\]}])/g, '$1'));
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : null;
  } catch {
    return null;
  }
}

function cleanText(v: unknown, max = 500): string {
  if (typeof v !== 'string') return '';
  return v
    .replace(/\*\*|__|`/g, '') // no markdown decoration
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** "Replying to Priya: <msg>" → { to: 'Priya', text: '<msg>' } (LLM recovery). */
function parseReplyingPrefix(text: string): { to: string; text: string } {
  const m = text.match(/^replying to\s+([^:]{1,30}):\s*/i);
  if (!m) return { to: '', text };
  return { to: m[1].trim(), text: text.slice(m[0].length).trim() };
}

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  while (copy.length > 0 && out.length < n) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// persona/voice instructions shared by both actions
// ---------------------------------------------------------------------------

function styleGuide(): string {
  return [
    'You write comment-section messages for Indian students on a lecture streaming app (PW style).',
    'Voice: real school/college friends chatting — Hinglish (Roman Hindi + English), casual, warm, light emoji use (0-2 per message), sometimes "bhai", "yaar", "guys".',
    'Hard rules: NO markdown, NO asterisks, no hashtags, never mention being an AI, never say these are generated.',
    'Each message 1-3 short sentences (max ~40 words). Answers to doubts must be factually correct and easy to understand — explain simply like a friend would; if not fully sure, stay conceptual and safe without inventing numbers.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

interface SeedMsg {
  name: string;
  text: string;
  replyTo: string; // '' when top-level
}

const FALLBACK_SEED: SeedMsg[] = [
  { name: 'Diya', text: 'Anyone else watching this at 2x before the test? 😄', replyTo: '' },
  { name: 'Rohan', text: 'Bhai 2x pe bhi slow lag rahi hai aaj, attention kaha jaata hai pata nahi 😭', replyTo: '' },
  { name: 'Ishaan', text: 'Guys ye topic exam ke liye important hai na?', replyTo: '' },
  { name: 'Aarav', text: 'Haan yaar, isse questions aate rehte hai. Acche se samajh lo, notes bana lo 👍', replyTo: 'Ishaan' },
  { name: 'Priya', text: 'Who else pausing every 2 mins to write notes 🙋‍♀️', replyTo: '' },
  { name: 'Kavya', text: 'Me too! Derivation wala part dobara rewind kar rahi hu', replyTo: 'Priya' },
];

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = typeof body.action === 'string' ? body.action : '';
  const threadKey = typeof body.threadKey === 'string' ? body.threadKey.trim().slice(0, 200) : '';
  const lectureTitle = cleanText(body.title, 160) || 'this lecture';
  const batchName = cleanText(body.batchName, 80) || 'our batch';

  if (!threadKey) {
    return NextResponse.json({ success: false, error: 'threadKey is required' }, { status: 400 });
  }

  try {
    if (action === 'seed') return await handleSeed(threadKey, lectureTitle, batchName);
    if (action === 'reply') return await handleReply(body, threadKey, lectureTitle, batchName);
    return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('[api/player/bots] failed:', error);
    return NextResponse.json({ success: false, error: 'Bot service failed' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// seed — populate an empty thread with a natural bot conversation
// ---------------------------------------------------------------------------

const seedInflight = new Map<string, Promise<{ seeded: boolean; count: number }>>();

function handleSeed(threadKey: string, lectureTitle: string, batchName: string) {
  const running = seedInflight.get(threadKey);
  if (running) return running.then((r) => NextResponse.json({ success: true, ...r }));

  const p = (async () => {
    const existing = await db.playerComment.count({ where: { threadKey, type: 'comment' } });
    if (existing >= 3) return { seeded: false, count: existing };

    // pick 4-6 personas for this conversation
    const cast = pickRandom(BOT_PERSONAS, 4 + Math.floor(Math.random() * 3));
    const roster = cast.map((c) => `${c.name} (${c.vibe})`).join('; ');

    const prompt = [
      `Lecture: "${lectureTitle}" — batch: ${batchName}. Students in this comment section: ${roster}.`,
      'Write 7 messages as a JSON array. Mix it like a real classroom comment section:',
      '- 2-3 casual/funny messages (lecture pace, teacher, exam tension)',
      '- 2-3 academic doubts ABOUT THIS LECTURE TOPIC, each answered correctly by ANOTHER student as a reply (the answer must actually explain the concept simply and correctly)',
      '- 1-2 helpful/practical notes (revision tip, PYQ mention, notes/DPP suggestion)',
      'JSON shape: [{"name":"<persona name>","text":"<message>"}, {"name":"...","text":"...","replyTo":"<persona name of the message it replies to>"}]',
      'replyTo must be the name of an EARLIER message author. Only use the persona names given. Reply messages must come after the message they answer.',
      'Respond with ONLY the JSON array.',
    ].join('\n');

    const raw = await llmComplete(
      [
        { role: 'assistant', content: styleGuide() },
        { role: 'user', content: prompt },
      ],
      30_000,
    );

    let parsed = raw ? extractJsonArray(raw) : null;
    let msgs: SeedMsg[] = [];
    if (parsed) {
      const castNames = new Set(cast.map((c) => c.name));
      for (const entry of parsed.slice(0, 10)) {
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        let text = cleanText(entry.text);
        if (!name || !castNames.has(name) || text.length < 2) continue;
        let replyToRaw = typeof entry.replyTo === 'string' ? entry.replyTo.trim() : '';
        // LLMs sometimes inline the linkage in the text — recover it
        const prefixed = parseReplyingPrefix(text);
        if (prefixed.to && !replyToRaw) {
          replyToRaw = prefixed.to;
          text = prefixed.text;
        } else if (prefixed.to) {
          text = prefixed.text; // keep the JSON linkage, strip the redundant prefix
        }
        if (text.length < 2) continue;
        msgs.push({
          name,
          text,
          replyTo: replyToRaw && castNames.has(replyToRaw) && replyToRaw !== name ? replyToRaw : '',
        });
      }
      // need at least one top-level opener
      if (msgs.length >= 4 && msgs.some((m) => !m.replyTo)) {
        // drop replyTo links that point to a name not seen yet (order matters)
        const seen = new Set<string>();
        msgs = msgs.filter((m) => {
          if (m.replyTo && !seen.has(m.replyTo)) m.replyTo = '';
          seen.add(m.name);
          return true;
        });
      } else {
        msgs = [];
      }
    }
    if (msgs.length === 0) msgs = FALLBACK_SEED;

    // organic timestamps: conversation happened over the last ~2 hours
    const gaps = msgs.map(() => 3 + Math.floor(Math.random() * 12)); // minutes
    const total = gaps.reduce((a, b) => a + b, 0);
    let t = Date.now() - total * 60_000;

    const lastTopLevel = new Map<string, string>(); // author → top-level id
    let inserted = 0;
    for (let i = 0; i < msgs.length; i++) {
      t += gaps[i] * 60_000;
      const createdAt = new Date(Math.min(t, Date.now() - 30_000));
      const parent = msgs[i].replyTo ? lastTopLevel.get(msgs[i].replyTo) : undefined;
      const row = await db.playerComment.create({
        data: {
          threadKey,
          type: 'comment',
          parentId: parent || null,
          author: msgs[i].name,
          text: msgs[i].text,
          createdAt,
        },
      });
      inserted += 1;
      if (!parent) lastTopLevel.set(msgs[i].name, row.id);
    }
    return { seeded: inserted > 0, count: existing + inserted };
  })();

  const tracked = p.finally(() => seedInflight.delete(threadKey));
  seedInflight.set(threadKey, tracked);
  return tracked.then((r) => NextResponse.json({ success: true, ...r }));
}

// ---------------------------------------------------------------------------
// reply — a bot answers a real student's comment
// ---------------------------------------------------------------------------

interface SerializedReply {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  parentId: string | null;
}

async function handleReply(
  body: Record<string, unknown>,
  threadKey: string,
  lectureTitle: string,
  batchName: string,
) {
  const commentId = typeof body.commentId === 'string' ? body.commentId.trim() : '';
  const studentText = cleanText(body.text, 1000);
  const studentName = cleanText(body.author, 40) || 'Student';
  if (!commentId || !studentText) {
    return NextResponse.json({ success: false, error: 'commentId and text are required' }, { status: 400 });
  }

  const comment = await db.playerComment.findUnique({ where: { id: commentId } });
  if (!comment || comment.threadKey !== threadKey) {
    return NextResponse.json({ success: false, error: 'Comment not found in this thread' }, { status: 404 });
  }
  // one-level threading: anchor the bot reply to the top-level ancestor
  const topLevelId = comment.parentId || comment.id;

  // the client shows a typing indicator for a specific bot — honor it
  const preferred = typeof body.preferredBot === 'string' ? body.preferredBot.trim() : '';
  const bot =
    BOT_PERSONAS.find((p) => p.name === preferred) ||
    BOT_PERSONAS[Math.floor(Math.random() * BOT_PERSONAS.length)];

  const raw = await llmComplete(
    [
      { role: 'assistant', content: styleGuide() },
      {
        role: 'user',
        content: [
          `Lecture: "${lectureTitle}" — batch: ${batchName}.`,
          `You are ${bot.name} — ${bot.vibe}. A student named ${studentName} just wrote:`,
          `"${studentText}"`,
          'Write YOUR reply as a comment. If it is a doubt or question: answer it CORRECTLY and simply, with a short explanation in friendly student language. If it is just a comment: reply like a friend would.',
          'Respond with ONLY the reply text (no name prefix, no quotes, no "Replying to …" prefix).',
        ].join('\n'),
      },
    ],
    25_000,
  );

  const text =
    cleanText(parseReplyingPrefix(raw?.replace(/^["']|["']$/g, '') || '').text, 600) ||
    'Achha point hai yaar! Ek baar us part ko dobara dekh lo aur notes mei mark kar lo — samajh aa jayega 👍';

  const row = await db.playerComment.create({
    data: { threadKey, type: 'comment', parentId: topLevelId, author: bot.name, text },
  });

  const item: SerializedReply = {
    id: row.id,
    author: row.author,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    parentId: row.parentId,
  };
  return NextResponse.json({ success: true, item });
}

// keep BOT_NAMES referenced (avatar seeding + future filters)
void BOT_NAMES;
