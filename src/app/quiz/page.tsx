'use client';

// Study Bison quiz runner — attempts DPPs/tests through the pw_dpp_start
// action (real upstream questions). NOTE: the upstream gates quiz starts
// behind a signed-in session; when it refuses, this page shows the honest
// upstream message instead of fake questions.
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api-client';
import './quiz.css';

interface NormalizedQuestion {
  id: string;
  text: string;
  options: string[];
  answer: number | null; // index, when upstream reveals it
}

function normalizeQuestions(data: unknown): NormalizedQuestion[] {
  const sections =
    (data as { sections?: unknown[] })?.sections ||
    (data as { questions?: unknown[] })?.questions ||
    (Array.isArray(data) ? data : []);
  const flat: unknown[] = Array.isArray(sections)
    ? sections.flatMap((s) => (Array.isArray((s as { questions?: unknown[] })?.questions) ? (s as { questions: unknown[] }).questions : [s]))
    : [];
  const out: NormalizedQuestion[] = [];
  for (const raw of flat) {
    const q = raw as Record<string, unknown>;
    if (!q || typeof q !== 'object') continue;
    const text = String(q.text || q.question || q.title || q.name || '').replace(/<[^>]*>/g, '').trim();
    if (!text) continue;
    const rawOpts = (q.options || q.optionsList || q.choices || []) as unknown[];
    const options = rawOpts
      .map((o) => (typeof o === 'string' ? o : String((o as { text?: string; value?: string })?.text || (o as { value?: string })?.value || '')))
      .filter(Boolean);
    let answer: number | null = null;
    if (typeof q.correctAnswer === 'number') answer = q.correctAnswer;
    else if (typeof q.answer === 'number') answer = q.answer;
    else if (q.correctAnswerId || q.answerId) {
      const idx = rawOpts.findIndex((o) => String((o as { _id?: string })?._id || '') === String(q.correctAnswerId || q.answerId));
      if (idx >= 0) answer = idx;
    }
    out.push({
      id: String(q._id || q.id || q.questionId || out.length),
      text,
      options,
      answer,
    });
  }
  return out;
}

function QuizInner() {
  const params = useSearchParams();
  const router = useRouter();
  const testId = params.get('testId') || '';
  const batchId = params.get('batchId') || '';
  const scheduleId = params.get('scheduleId') || '';
  const subjectId = params.get('subjectId') || '';
  const type = params.get('type') || 'Start';
  const mode = params.get('mode') || 'DPP';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [title, setTitle] = useState(mode === 'TEST' ? 'Test Attempt' : 'DPP Attempt');
  const [duration, setDuration] = useState(0); // seconds
  const [questions, setQuestions] = useState<NormalizedQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [marked, setMarked] = useState<Record<number, boolean>>({});
  const [current, setCurrent] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await api.dppStart({ testId, batchId, scheduleId, subjectId, type });
        if (cancelled) return;
        if (!res.success || !res.data) {
          throw new Error(res.error || 'Could not start this quiz.');
        }
        const data = res.data as Record<string, unknown>;
        const qs = normalizeQuestions(data);
        if (qs.length === 0) {
          throw new Error('No questions were returned for this quiz.');
        }
        const rem = Number((data as { remainingDuration?: number }).remainingDuration || 0);
        const maxDur = Number((data as { maxDuration?: number }).maxDuration || (data as { duration?: number }).duration || 0);
        setTitle(String((data as { name?: string }).name || (mode === 'TEST' ? 'Test Attempt' : 'DPP Attempt')));
        setQuestions(qs);
        setRemaining(rem > 0 ? rem : maxDur * 60);
        setDuration(rem > 0 ? rem : maxDur * 60);
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to start quiz');
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [testId, batchId, scheduleId, subjectId, type, mode]);

  useEffect(() => {
    if (submitted || loading || error || remaining <= 0) return;
    const t = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(t);
          setSubmitted(true);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [submitted, loading, error, remaining]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  };

  const score = useMemo(() => {
    let correct = 0;
    let wrong = 0;
    let skipped = 0;
    questions.forEach((q, i) => {
      const a = answers[i];
      if (a === undefined) skipped += 1;
      else if (q.answer !== null && a === q.answer) correct += 1;
      else if (q.answer === null) correct += 0; // unknown key — counted as attempted
      else wrong += 1;
    });
    return { correct, wrong, skipped, answered: questions.length - skipped };
  }, [questions, answers]);

  const close = useCallback(() => {
    if (window.history.length > 1) router.back();
    else window.close();
  }, [router]);

  if (loading) {
    return (
      <div className="qz-root">
        <div className="qz-center">
          <div className="spinner-ring" />
          <div className="qz-muted" style={{ marginTop: 14 }}>Preparing your questions...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="qz-root">
        <div className="qz-center qz-error-card">
          <i className="fas fa-lock" style={{ fontSize: '2.4rem', color: '#f59e0b', marginBottom: 16 }}></i>
          <h2 style={{ fontWeight: 800, marginBottom: 8 }}>Quiz unavailable</h2>
          <p className="qz-muted" style={{ maxWidth: 460, lineHeight: 1.6 }}>
            {error}
            {/status code 400|401|403/i.test(error) || /login|sign|auth/i.test(error) ? (
              <>
                <br /><br />
                The upstream PW content API only allows quiz attempts for <b>signed-in users</b>. Notes, PDFs,
                lectures and the test series remain fully available.
              </>
            ) : null}
          </p>
          <button className="qz-btn qz-btn-primary" onClick={close}><i className="fas fa-arrow-left me-2"></i>Go Back</button>
        </div>
      </div>
    );
  }

  const q = questions[current];

  if (submitted) {
    return (
      <div className="qz-root">
        <div className="qz-center">
          <div className="qz-score-ring">
            <div className="qz-score-num">{questions.length > 0 ? Math.round((score.correct / questions.length) * 100) : 0}%</div>
            <div className="qz-muted">Score</div>
          </div>
          <div className="qz-stats">
            <div className="qz-stat qz-green"><b>{score.correct}</b> Correct</div>
            <div className="qz-stat qz-red"><b>{score.wrong}</b> Incorrect</div>
            <div className="qz-stat qz-gray"><b>{score.skipped}</b> Skipped</div>
          </div>
          <div className="qz-review">
            {questions.map((qq, i) => {
              const a = answers[i];
              return (
                <div className="qz-review-item" key={qq.id}>
                  <div className="qz-review-q"><b>Q{i + 1}.</b> {qq.text}</div>
                  <div className="qz-review-a">
                    {a === undefined ? (
                      <span className="qz-gray">Not answered</span>
                    ) : qq.answer === null ? (
                      <span className="qz-gray">Answer key not provided by upstream</span>
                    ) : a === qq.answer ? (
                      <span className="qz-green">Correct — {qq.options[a]}</span>
                    ) : (
                      <span className="qz-red">
                        You: {qq.options[a]} · Correct: {qq.options[qq.answer]}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <button className="qz-btn qz-btn-primary" onClick={close}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="qz-root">
      <div className="qz-header">
        <button className="qz-close" onClick={close} aria-label="Close quiz"><i className="fas fa-times"></i></button>
        <div className="qz-title">{title}</div>
        <div className={`qz-timer ${remaining < 60 ? 'qz-timer-danger' : ''}`}>
          <i className="far fa-clock"></i> {fmt(remaining)}
          <span className="qz-timer-sub">/{fmt(duration)}</span>
        </div>
      </div>

      <div className="qz-body">
        <div className="qz-qmeta">Question {current + 1} of {questions.length}</div>
        <div className="qz-question">{q.text}</div>
        <div className="qz-options">
          {q.options.map((opt, oi) => (
            <div
              key={oi}
              className={`qz-opt ${answers[current] === oi ? 'selected' : ''}`}
              onClick={() => setAnswers((a) => ({ ...a, [current]: oi }))}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') setAnswers((a) => ({ ...a, [current]: oi })); }}
            >
              <span className="qz-opt-key">{String.fromCharCode(65 + oi)}</span>
              <span>{opt}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="qz-footer">
        <button className="qz-btn" onClick={() => setCurrent((c) => Math.max(0, c - 1))} disabled={current === 0}>
          <i className="fas fa-arrow-left"></i> Prev
        </button>
        <button
          className="qz-btn"
          onClick={() => setMarked((m) => ({ ...m, [current]: !m[current] }))}
        >
          <i className="fas fa-flag"></i> {marked[current] ? 'Unmark' : 'Mark'}
        </button>
        <button
          className="qz-btn qz-btn-primary"
          onClick={() => (current === questions.length - 1 ? setSubmitted(true) : setCurrent((c) => c + 1))}
        >
          {current === questions.length - 1 ? 'Submit' : 'Save & Next'}
        </button>
        <button className="qz-btn qz-btn-palette" onClick={() => setPaletteOpen((p) => !p)} aria-label="Question palette">
          <i className="fas fa-th"></i>
        </button>
      </div>

      <div className={`qz-palette ${paletteOpen ? 'open' : ''}`}>
        <div className="qz-palette-head">
          <span>Questions</span>
          <button className="qz-close" onClick={() => setPaletteOpen(false)} aria-label="Close palette"><i className="fas fa-times"></i></button>
        </div>
        <div className="qz-palette-grid">
          {questions.map((_, i) => (
            <button
              key={i}
              className={`qz-pal-btn ${i === current ? 'current' : ''} ${answers[i] !== undefined ? 'answered' : ''} ${marked[i] ? 'marked' : ''}`}
              onClick={() => { setCurrent(i); setPaletteOpen(false); }}
            >
              {i + 1}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function QuizPage() {
  return (
    <Suspense fallback={
      <div className="qz-root">
        <div className="qz-center">
          <div className="spinner-ring" />
        </div>
      </div>
    }>
      <QuizInner />
    </Suspense>
  );
}
