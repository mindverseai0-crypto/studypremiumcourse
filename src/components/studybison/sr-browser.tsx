'use client';

// ============================================================================
// Study Ratna browser — browse studyratna.cc lectures inside Study Bison.
// Chain: catalog → batch subjects → topics → lectures → their play.php player
// embedded via iframe on our /player page.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';

interface SrBatch {
  batch_id: string;
  name: string;
  byName?: string;
  exam?: string;
  language?: string;
  class?: string;
  photo?: string;
}

interface SrSubject {
  _id?: string;      // batch-subject join id — used by topics/lectures APIs
  subjectId?: string; // master subject id (NOT used for browsing)
  subject?: string;
  slug?: string;
}

interface SrTopic {
  _id: string;
  name: string;
  videos?: number;
  notes?: number;
  slug?: string;
}

interface SrLecture {
  _id: string;
  topic?: string;
  slug?: string;
  startTime?: string;
  videoDetails?: { _id?: string; name?: string; image?: string; duration?: string };
}

type Step = 'batches' | 'subjects' | 'topics' | 'lectures';

async function srApi<T>(params: string): Promise<T> {
  const res = await fetch(`/api/sr?${params}`);
  const j = (await res.json()) as { success: boolean; data?: T; error?: string };
  if (!j.success) throw new Error(j.error || 'Study Ratna request failed');
  return j.data as T;
}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function SrBrowser() {
  const [step, setStep] = useState<Step>('batches');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [allBatches, setAllBatches] = useState<SrBatch[]>([]);
  const [batch, setBatch] = useState<SrBatch | null>(null);
  const [subjects, setSubjects] = useState<SrSubject[]>([]);
  const [subject, setSubject] = useState<SrSubject | null>(null);
  const [topics, setTopics] = useState<SrTopic[]>([]);
  const [topic, setTopic] = useState<SrTopic | null>(null);
  const [lectures, setLectures] = useState<SrLecture[]>([]);

  // Load the full catalog once (16k+ records, served from our server cache).
  useEffect(() => {
    let alive = true;
    setLoading(true);
    srApi<SrBatch[]>('action=batches')
      .then((d) => { if (alive) setAllBatches(d || []); })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const filteredBatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? allBatches.filter((b) => (b.name || '').toLowerCase().includes(q) || (b.exam || '').toLowerCase().includes(q))
      : allBatches;
    return list.slice(0, 60);
  }, [allBatches, query]);

  const openBatch = useCallback(async (b: SrBatch) => {
    setBatch(b);
    setError('');
    setLoading(true);
    setStep('subjects');
    try {
      const d = await srApi<SrBatch & { subjects?: SrSubject[] }>(`action=batch&batchId=${encodeURIComponent(b.batch_id)}`);
      setSubjects(d.subjects || []);
      if (!d.subjects?.length) setError('No subjects found for this batch.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load batch');
      setSubjects([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const openSubject = useCallback(async (s: SrSubject) => {
    if (!batch) return;
    setSubject(s);
    setError('');
    setLoading(true);
    setStep('topics');
    try {
      const sid = s._id || s.subjectId || '';
      const d = await srApi<SrTopic[]>(`action=topics&batchId=${encodeURIComponent(batch.batch_id)}&subjectId=${encodeURIComponent(sid)}`);
      setTopics(d || []);
      if (!d?.length) setError('No chapters found for this subject.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load chapters');
      setTopics([]);
    } finally {
      setLoading(false);
    }
  }, [batch]);

  const openTopic = useCallback(async (t: SrTopic) => {
    if (!batch || !subject) return;
    setTopic(t);
    setError('');
    setLoading(true);
    setStep('lectures');
    try {
      const sid = subject._id || subject.subjectId || '';
      const d = await srApi<SrLecture[]>(
        `action=lectures&batchId=${encodeURIComponent(batch.batch_id)}&subjectId=${encodeURIComponent(sid)}&tagId=${encodeURIComponent(t._id)}`,
      );
      setLectures(d || []);
      if (!d?.length) setError('No lectures found in this chapter.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load lectures');
      setLectures([]);
    } finally {
      setLoading(false);
    }
  }, [batch, subject]);

  const watchLecture = useCallback(async (l: SrLecture) => {
    if (!batch || !subject || !topic || !l.videoDetails?._id) return;
    setError('');
    setLoading(true);
    try {
      const sid = subject._id || subject.subjectId || '';
      const d = await srApi<{ url: string; videoUrl?: string }>(
        `action=player&scheduleId=${encodeURIComponent(l._id)}&videoKey=${encodeURIComponent(l.videoDetails._id)}` +
        `&batchId=${encodeURIComponent(batch.batch_id)}&subjectId=${encodeURIComponent(sid)}&topicId=${encodeURIComponent(topic._id)}` +
        `&subjectSlug=${encodeURIComponent(subject.slug || '')}&topicSlug=${encodeURIComponent(topic.slug || '')}` +
        `&title=${encodeURIComponent(l.topic || l.videoDetails.name || 'Lecture')}&poster=${encodeURIComponent(l.videoDetails.image || '')}`,
      );
      // Their anti-bot challenge structurally cannot pass inside an iframe
      // (it requires non-zero window.outerWidth/outerHeight, which are always
      // 0 in iframes), so the lecture opens TOP-LEVEL in a new tab — the same
      // way their own site opens the player. Their PHP signs the stream.
      window.open(d.url, '_blank', 'noopener');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open player');
    } finally {
      setLoading(false);
    }
  }, [batch, subject, topic]);

  const back = () => {
    setError('');
    if (step === 'lectures') { setStep('topics'); setLectures([]); }
    else if (step === 'topics') { setStep('subjects'); setTopics([]); }
    else if (step === 'subjects') { setStep('batches'); setSubjects([]); setBatch(null); }
  };

  return (
    <div className="sr-browser">
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        {step !== 'batches' ? (
          <button className="btn btn-outline-danger fw-bold rounded-pill" style={{ minWidth: 44, minHeight: 44 }} onClick={back} aria-label="Back">
            <i className="fas fa-arrow-left"></i>
          </button>
        ) : null}
        <h4 style={{ margin: 0, fontWeight: 800 }}>
          Study Prince
          <span style={{ background: '#ef4444', color: '#fff', fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.5px', padding: '2px 6px', borderRadius: 4, marginLeft: 8, verticalAlign: 'middle' }}>SR LECTURES</span>
        </h4>
      </div>

      {step === 'batches' ? (
        <>
          <input
            className="form-control rounded-pill"
            style={{ padding: '12px 20px', marginBottom: 16, minHeight: 44 }}
            placeholder="Search Study Prince batches…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search Study Prince batches"
          />
          <div className="row g-3">
            {filteredBatches.map((b) => (
              <div className="col-12 col-md-6 col-lg-4" key={b.batch_id}>
                <div
                  className="card-custom"
                  style={{ cursor: 'pointer' }}
                  onClick={() => void openBatch(b)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') void openBatch(b); }}
                >
                  <img src={b.photo || 'https://store.pw.live/footer-logo.svg'} className="batch-thumb" alt={b.name} loading="lazy" />
                  <div className="card-body-custom">
                    <div className="title-text mt-2" style={{ fontSize: '0.95rem' }}>{b.name}</div>
                    <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: 4 }}>
                      {b.exam || ''}{b.language ? ` · ${b.language}` : ''}
                    </div>
                    <button className="btn-sb-dark w-100 mt-2" style={{ fontWeight: 600 }}>Browse Lectures</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {!loading && !allBatches.length && !error ? (
            <div className="text-center p-5 text-muted">Loading catalog…</div>
          ) : null}
          {!loading && allBatches.length && !filteredBatches.length ? (
            <div className="text-center p-5 text-muted">No batches match “{query}”.</div>
          ) : null}
        </>
      ) : null}

      {step === 'subjects' ? (
        <div className="d-flex flex-column gap-3">
          <div style={{ fontWeight: 800 }}>{batch?.name}</div>
          {subjects.map((s) => {
            const sid = s._id || s.subjectId || '';
            return (
              <button
                key={sid}
                className="btn btn-light text-start d-flex justify-content-between align-items-center"
                style={{ border: '1px solid #e5e7eb', borderRadius: 14, padding: '14px 18px', minHeight: 44 }}
                onClick={() => void openSubject(s)}
              >
                <span style={{ fontWeight: 700 }}>{s.subject || sid}</span>
                <i className="fas fa-chevron-right" style={{ color: '#9ca3af' }}></i>
              </button>
            );
          })}
        </div>
      ) : null}

      {step === 'topics' ? (
        <div className="d-flex flex-column gap-3">
          <div style={{ fontWeight: 800 }}>{subject?.subject}</div>
          {topics.map((t) => (
            <button
              key={t._id}
              className="btn btn-light text-start d-flex justify-content-between align-items-center"
              style={{ border: '1px solid #e5e7eb', borderRadius: 14, padding: '14px 18px', minHeight: 44 }}
              onClick={() => void openTopic(t)}
            >
              <span>
                <span style={{ fontWeight: 700, display: 'block' }}>{t.name}</span>
                <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>{t.videos || 0} Lectures · {t.notes || 0} Notes</span>
              </span>
              <i className="fas fa-chevron-right" style={{ color: '#9ca3af' }}></i>
            </button>
          ))}
        </div>
      ) : null}

      {step === 'lectures' ? (
        <div className="d-flex flex-column gap-3">
          <div style={{ fontWeight: 800 }}>{topic?.name}</div>
          {lectures.map((l) => (
            <div key={l._id} className="card-custom" style={{ padding: 14 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <img
                  src={l.videoDetails?.image || 'https://store.pw.live/footer-logo.svg'}
                  alt={l.videoDetails?.name || l.topic || 'lecture'}
                  style={{ width: 96, height: 60, objectFit: 'cover', borderRadius: 8, background: '#111' }}
                  loading="lazy"
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.topic || l.videoDetails?.name || 'Lecture'}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: 2 }}>
                    {formatDate(l.startTime || l.date)}{l.videoDetails?.duration ? ` · ${l.videoDetails.duration}` : ''}
                  </div>
                </div>
                <button
                  className="btn btn-danger fw-bold rounded-pill"
                  style={{ minWidth: 44, minHeight: 44, flexShrink: 0 }}
                  onClick={() => void watchLecture(l)}
                  disabled={!l.videoDetails?._id}
                  aria-label={`Watch ${l.topic || 'lecture'}`}
                >
                  <i className="fas fa-play"></i>
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {loading ? (
        <div className="text-center p-4">
          <i className="fas fa-spinner fa-spin fa-2x" style={{ color: '#ef4444' }}></i>
        </div>
      ) : null}

      {error ? (
        <div className="text-center p-4">
          <div style={{ color: '#b91c1c', fontWeight: 600, marginBottom: 12 }}>
            <i className="fas fa-triangle-exclamation me-2"></i>{error}
          </div>
          <button
            className="btn btn-outline-danger fw-bold rounded-pill"
            style={{ minWidth: 44, minHeight: 44 }}
            onClick={() => {
              const e0 = error;
              setError('');
              if (step === 'batches' || e0.includes('catalog')) setStep('batches');
              else if (step === 'subjects' && batch) void openBatch(batch);
              else if (step === 'topics' && subject) void openSubject(subject);
              else if (step === 'lectures' && topic) void openTopic(topic);
            }}
          >
            <i className="fas fa-rotate-right me-2"></i>Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}
