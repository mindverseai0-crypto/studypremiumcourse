import { NextRequest, NextResponse } from 'next/server';
import { lxPdfUrl } from '@/lib/lx-api';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/lxpdf?batchId=&subjectId=&pdfId=&attachmentId=
//
// Resolves a note/DPP attachment through the upstream GetPdf API and
// redirects to the REAL pdf on static.pw.live (public CDN, no signature).
// 404 if upstream cannot resolve the document.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const batchId = sp.get('batchId') || '';
  const subjectId = sp.get('subjectId') || '';
  const pdfId = sp.get('pdfId') || '';
  const attachmentId = sp.get('attachmentId') || '';

  if (!batchId || !subjectId || !pdfId || !attachmentId) {
    return NextResponse.json({ success: false, error: 'Missing parameters' }, { status: 400 });
  }

  try {
    const url = await lxPdfUrl(batchId, subjectId, pdfId, attachmentId);
    if (!url) {
      return NextResponse.json({ success: false, error: 'PDF not available' }, { status: 404 });
    }
    return NextResponse.redirect(url, { status: 302 });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'PDF lookup failed' },
      { status: 502 },
    );
  }
}
