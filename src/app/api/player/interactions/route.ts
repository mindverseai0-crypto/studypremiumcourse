// ============================================================================
// Player interactions API — comments + doubts with one-level threading.
//
// GET  /api/player/interactions?threadKey=<key>&type=comment|doubt
//   → { success: true, items: [{ id, author, text, createdAt, parentId: null,
//        replies: [{ id, author, text, createdAt, parentId }] }] }
//
// POST /api/player/interactions
//   body: { threadKey, type, text, author?, parentId? }
//   → { success: true, item: { id, author, text, createdAt, parentId } }
//
// Storage: PlayerComment table (Prisma / SQLite). No self-relation in the
// schema, so replies are fetched in a second query and grouped in JS.
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

const VALID_TYPES = ['comment', 'doubt'] as const;
type InteractionType = (typeof VALID_TYPES)[number];

interface SerializedComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  parentId: string | null;
}

function serialize(row: {
  id: string;
  author: string;
  text: string;
  createdAt: Date;
  parentId: string | null;
}): SerializedComment {
  return {
    id: row.id,
    author: row.author,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    parentId: row.parentId,
  };
}

// ---------------------------------------------------------------------------
// GET — list a thread (top-level items + nested replies)
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const threadKey = (searchParams.get('threadKey') || '').trim();
  const rawType = (searchParams.get('type') || 'comment').trim() || 'comment';

  if (!threadKey || threadKey.length > 200 || !VALID_TYPES.includes(rawType as InteractionType)) {
    return NextResponse.json(
      { success: false, error: 'threadKey and type are required' },
      { status: 400 },
    );
  }
  const type = rawType as InteractionType;

  try {
    const topLevel = await db.playerComment.findMany({
      where: { threadKey, type, parentId: null },
      orderBy: { createdAt: 'asc' },
    });

    const topIds = topLevel.map((row) => row.id);
    const replies =
      topIds.length > 0
        ? await db.playerComment.findMany({
            where: { parentId: { in: topIds } },
            orderBy: { createdAt: 'asc' },
          })
        : [];

    const byParent = new Map<string, SerializedComment[]>();
    for (const reply of replies) {
      const parentId = reply.parentId as string;
      const bucket = byParent.get(parentId);
      const serialized = serialize(reply);
      if (bucket) bucket.push(serialized);
      else byParent.set(parentId, [serialized]);
    }

    const items = topLevel.map((row) => ({
      ...serialize(row),
      parentId: null,
      replies: byParent.get(row.id) ?? [],
    }));

    return NextResponse.json({ success: true, items });
  } catch (error) {
    console.error('[api/player/interactions] GET failed:', error);
    return NextResponse.json(
      { success: false, error: 'Could not load the conversation. Please try again.' },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// POST — create a comment, doubt or reply
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  const threadKey = typeof raw.threadKey === 'string' ? raw.threadKey.trim() : '';
  const type = typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim() : 'comment';
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  const authorRaw = typeof raw.author === 'string' ? raw.author.trim() : '';
  const author = (authorRaw || 'Student').slice(0, 40);
  const parentId =
    typeof raw.parentId === 'string' && raw.parentId.trim() ? raw.parentId.trim() : null;

  if (!threadKey || threadKey.length > 200) {
    return NextResponse.json(
      { success: false, error: 'threadKey and type are required' },
      { status: 400 },
    );
  }
  if (!VALID_TYPES.includes(type as InteractionType)) {
    return NextResponse.json(
      { success: false, error: 'threadKey and type are required' },
      { status: 400 },
    );
  }
  if (!text || text.length > 2000) {
    return NextResponse.json(
      { success: false, error: 'text is required (max 2000 characters)' },
      { status: 400 },
    );
  }

  try {
    if (parentId) {
      // One-level threading only: the reply target must exist and be top-level.
      const parent = await db.playerComment.findUnique({ where: { id: parentId } });
      if (!parent) {
        return NextResponse.json(
          { success: false, error: 'Reply target not found' },
          { status: 404 },
        );
      }
      if (parent.parentId !== null) {
        return NextResponse.json(
          { success: false, error: 'Replies to replies are not allowed (one level only)' },
          { status: 400 },
        );
      }
    }

    const created = await db.playerComment.create({
      data: { threadKey, type, parentId, author, text },
    });

    return NextResponse.json({ success: true, item: serialize(created) });
  } catch (error) {
    console.error('[api/player/interactions] POST failed:', error);
    return NextResponse.json(
      { success: false, error: 'Could not save your message. Please try again.' },
      { status: 500 },
    );
  }
}
