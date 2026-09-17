import { NextRequest, NextResponse } from 'next/server';
import {
  srBatches,
  srBatchDetails,
  srTopics,
  srLectures,
  srVideoUrl,
  srPlayerUrl,
  srHandshake,
  SR_HOSTS,
} from '@/lib/sr-api';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/sr?action=… — Study Ratna content chain.
//
//   batches                → full public catalog (16k+ batches)
//   batch&batchId=         → batch details incl. subjects
//   topics&batchId&subjectId=&page=   → chapters for a subject
//   lectures&batchId&subjectId&tagId=&skip= → lecture list for a topic
//   video&videoKey=        → resolved stream payload (unsigned CloudFront mpd)
//   player&scheduleId&videoKey&batchId&subjectId&topicId&… → their play.php URL
//   health                 → handshake probe
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const action = sp.get('action') || '';

  try {
    switch (action) {
      case 'health': {
        const okApi = await srHandshake(SR_HOSTS.api);
        const okApp = await srHandshake(SR_HOSTS.app);
        return NextResponse.json({ success: okApi && okApp, api: okApi, app: okApp });
      }

      case 'batches': {
        const batches = await srBatches();
        return NextResponse.json({ success: true, data: batches });
      }

      case 'batch': {
        const batchId = sp.get('batchId') || '';
        if (!batchId) return NextResponse.json({ success: false, error: 'batchId required' }, { status: 400 });
        const data = await srBatchDetails(batchId);
        if (!data) return NextResponse.json({ success: false, error: 'batch not found or upstream blocked' }, { status: 404 });
        return NextResponse.json({ success: true, data });
      }

      case 'topics': {
        const batchId = sp.get('batchId') || '';
        const subjectId = sp.get('subjectId') || '';
        const page = parseInt(sp.get('page') || '1', 10) || 1;
        if (!batchId || !subjectId) return NextResponse.json({ success: false, error: 'batchId and subjectId required' }, { status: 400 });
        const data = await srTopics(batchId, subjectId, page, 50);
        if (data === null) return NextResponse.json({ success: false, error: 'Upstream busy — please retry' }, { status: 502 });
        return NextResponse.json({ success: true, data });
      }

      case 'lectures': {
        const batchId = sp.get('batchId') || '';
        const subjectId = sp.get('subjectId') || '';
        const tagId = sp.get('tagId') || '';
        const skip = parseInt(sp.get('skip') || '0', 10) || 0;
        if (!batchId || !subjectId || !tagId)
          return NextResponse.json({ success: false, error: 'batchId, subjectId, tagId required' }, { status: 400 });
        const data = await srLectures(batchId, subjectId, tagId, skip, 20);
        if (data === null) return NextResponse.json({ success: false, error: 'Upstream busy — please retry' }, { status: 502 });
        return NextResponse.json({ success: true, data });
      }

      case 'video': {
        const videoKey = sp.get('videoKey') || '';
        if (!videoKey) return NextResponse.json({ success: false, error: 'videoKey required' }, { status: 400 });
        const data = await srVideoUrl(videoKey);
        if (!data) return NextResponse.json({ success: false, error: 'video not found or upstream blocked' }, { status: 404 });
        return NextResponse.json({ success: true, data });
      }

      case 'player': {
        const scheduleId = sp.get('scheduleId') || '';
        const videoKey = sp.get('videoKey') || '';
        const batchId = sp.get('batchId') || '';
        const subjectId = sp.get('subjectId') || '';
        const topicId = sp.get('topicId') || '';
        if (!scheduleId || !videoKey || !batchId || !subjectId || !topicId)
          return NextResponse.json({ success: false, error: 'scheduleId, videoKey, batchId, subjectId, topicId required' }, { status: 400 });
        // Best-effort: resolve the underlying stream URL so their player gets
        // a pre-resolved video_url (their PHP signs it server-side).
        let videoUrl = '';
        try {
          const v = await srVideoUrl(videoKey);
          videoUrl = v?.videoUrl || '';
        } catch {
          /* resolution is optional — their player also resolves via video_key */
        }
        const url = srPlayerUrl({
          scheduleId,
          videoKey,
          batchId,
          subjectId,
          topicId,
          videoUrl,
          subjectSlug: sp.get('subjectSlug') || undefined,
          topicSlug: sp.get('topicSlug') || undefined,
          title: sp.get('title') || undefined,
          poster: sp.get('poster') || undefined,
        });
        return NextResponse.json({ success: true, data: { url, videoUrl } });
      }

      default:
        return NextResponse.json({ success: false, error: `unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'sr upstream error' },
      { status: 502 },
    );
  }
}
