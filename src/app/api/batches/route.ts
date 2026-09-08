import { NextRequest, NextResponse } from 'next/server';
import { lxAllBatches, lxSearchBatches, LxBatchSummary } from '@/lib/lx-api';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/batches?q=&page=&limit=
//
// REAL batch catalog relayed from the LearnxPW upstream (the same source
// that powers learnxpw.site/study/batches) — 13k+ live PW batches with real
// names, prices, images and validity windows.
// ---------------------------------------------------------------------------

function toCatalogItem(b: LxBatchSummary) {
  return {
    _id: b._id || '',
    id: b.slug || b._id || '',
    name: b.name || 'Untitled batch',
    byName: b.byName || '',
    imageUrl: b.previewImage || '',
    exams: [] as string[],
    language: b.language || '',
    className: '',
    amount: typeof b.feeTotal === 'number' ? b.feeTotal : null,
    startDate: b.startDate || '',
    endDate: b.endDate || '',
  };
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const q = (sp.get('q') || '').trim();
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);

    const result = q ? await lxSearchBatches(q, page) : await lxAllBatches(page);
    const batches = Array.isArray(result.batches) ? result.batches : [];
    const total = Number.isFinite(result.total) ? Number(result.total) : batches.length;
    const totalPages = Number.isFinite(result.totalPages) ? Number(result.totalPages) : 0;

    return NextResponse.json({
      success: true,
      total,
      page,
      limit: batches.length,
      hasMore: totalPages > 0 ? page < totalPages : batches.length > 0,
      data: batches.map(toCatalogItem),
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
