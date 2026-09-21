'use client';

// ============================================================================
// Study Bison — main SPA (rebranded from the studybee pro clone)
// Views: All Courses (home) / Study Dashboard / All Classes / Chapters /
// Content / All Tests. Every content action is backed by the REAL PW data
// relayed from the LearnxPW upstream (batches, subjects, chapters, lectures,
// notes & DPP PDFs, tests, live schedule).
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  fetchCatalog,
  imageUrl,
  BatchCatalogItem,
  BatchDetailPublic,
  BatchSubjectPublic,
  ChapterItemPublic,
  ContentNodePublic,
  ScheduleEventPublic,
  TestItemPublic,
} from '@/lib/api-client';
import { addXP, useEnrolledBatches, useXP, useWatchedVideos } from '@/lib/local-state';
import {
  SbDownload,
  listDownloads,
  subscribeDownloads,
  deleteDownload,
  pauseDownload,
  startDownload,
  estimateOfflineStorage,
  formatBytes,
} from '@/lib/offline';

export type ViewId = 'home-view' | 'study-view' | 'all-classes-view' | 'chapters-view' | 'content-view' | 'all-tests-view' | 'downloads-view';

interface SubjectRef { id: string; internalId: string; name: string; masterId: string; batchSubjectId: string }
interface TopicRef { id: string; name: string }
interface AttachmentRow { title: string; url: string }
interface DppMeta {
  testId: string;
  scheduleId: string;
  subjectId: string;
  name: string;
}

const DEFAULT_THUMB = 'https://store.pw.live/footer-logo.svg';

export default function StudyBisonApp() {
  // ---------------- global nav ----------------
  const [view, setView] = useState<ViewId>('home-view');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // ---------------- home / catalog ----------------
  const [batches, setBatches] = useState<BatchCatalogItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceTerm = useRef('');

  // ---------------- enrollment ----------------
  const { enrolled, enroll, unenroll } = useEnrolledBatches();
  const { watched, toggleWatched } = useWatchedVideos();
  const xp = useXP();
  const batchDetailCache = useRef<Map<string, BatchDetailPublic>>(new Map());

  // ---------------- study ----------------
  const [currentBatchId, setCurrentBatchId] = useState<string | null>(null);
  const [enrolledDetails, setEnrolledDetails] = useState<BatchDetailPublic[]>([]);
  const [events, setEvents] = useState<ScheduleEventPublic[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  // ---------------- classes / chapters / content ----------------
  const [subjects, setSubjects] = useState<BatchSubjectPublic[]>([]);
  const [subjectsLoading, setSubjectsLoading] = useState(false);
  const [currentSubject, setCurrentSubject] = useState<SubjectRef | null>(null);
  const [chaptersTab, setChaptersTab] = useState<'UNITS' | 'STUDY_MATERIAL'>('UNITS');
  const [chapters, setChapters] = useState<ChapterItemPublic[]>([]);
  const [chaptersLoading, setChaptersLoading] = useState(false);
  const [currentTopic, setCurrentTopic] = useState<TopicRef | null>(null);
  const [contentTab, setContentTab] = useState('ALL');
  const [contentNodes, setContentNodes] = useState<ContentNodePublic[]>([]);
  const [dppItems, setDppItems] = useState<TestItemPublic[]>([]);
  const [contentLoading, setContentLoading] = useState(false);

  // ---------------- tests ----------------
  const [tests, setTests] = useState<TestItemPublic[]>([]);
  const [testsLoading, setTestsLoading] = useState(false);

  // ---------------- PWA offline downloads ----------------
  const [downloads, setDownloads] = useState<SbDownload[]>([]);
  const [storageEst, setStorageEst] = useState<{ usage: number; quota: number } | null>(null);

  // ---------------- resources tab ----------------
  const [resourcesTab, setResourcesTab] = useState<'subjects' | 'resources'>('subjects');
  const [resourceTopics, setResourceTopics] = useState<ChapterItemPublic[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);

  // ---------------- modals ----------------
  const [batchInfoOpen, setBatchInfoOpen] = useState(false);
  const [batchInfo, setBatchInfo] = useState<BatchDetailPublic | null>(null);
  const [batchInfoLoading, setBatchInfoLoading] = useState(false);

  const [notesOpen, setNotesOpen] = useState(false);
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteRows, setNoteRows] = useState<AttachmentRow[]>([]);

  const [dppOpen, setDppOpen] = useState(false);
  const [dppMeta, setDppMeta] = useState<DppMeta | null>(null);

  const [testFrame, setTestFrame] = useState<{ open: boolean; url: string; title: string }>({ open: false, url: '', title: 'Test Attempt' });

  const [instructions, setInstructions] = useState<{ open: boolean; loading: boolean; title: string; html: string }>({ open: false, loading: false, title: '', html: '' });

  // ==================================================================
  // NAV
  // ==================================================================
  const nav = useCallback((v: ViewId) => {
    setView(v);
    setSidebarOpen(false);
    window.scrollTo(0, 0);
  }, []);

  // ==================================================================
  // OFFLINE LECTURE LIBRARY (PWA downloads)
  // ==================================================================
  const refreshDownloads = useCallback(() => {
    void listDownloads().then((list) => {
      setDownloads(list);
      void estimateOfflineStorage().then(setStorageEst);
    });
  }, []);

  useEffect(() => {
    refreshDownloads();
    const unsub = subscribeDownloads(refreshDownloads);
    return () => unsub();
  }, [refreshDownloads]);

  // manifest shortcut / deep link → open the Downloads view directly
  useEffect(() => {
    try {
      const v = new URLSearchParams(window.location.search).get('view');
      if (v === 'downloads') {
        setView('downloads-view');
        window.history.replaceState({}, '', '/');
      }
    } catch {
      /* ignore */
    }
  }, []);

  const playDownload = useCallback((rec: SbDownload) => {
    const q = new URLSearchParams({
      videoId: rec.id,
      batchId: rec.batchId || '',
      subjectId: rec.subjectId || '',
      schId: rec.schId || rec.id,
      title: rec.title || 'PW Lecture',
      batchName: rec.batchName || '',
      vUrl: rec.vUrl || '',
      ...(rec.realVideoId ? { lectureVideoId: rec.realVideoId } : {}),
    });
    window.open(`/player?${q.toString()}`, '_blank');
  }, []);

  // ==================================================================
  // CATALOG (home view)
  // ==================================================================
  const loadCatalog = useCallback(async (q: string, p: number, isNew: boolean) => {
    try {
      if (isNew) {
        setSearching(true);
        setBatches([]);
      }
      setCatalogError('');
      const res = await fetchCatalog(q, p, 20);
      setBatches((prev) => (isNew ? res.data : [...prev, ...res.data]));
      setHasMore(res.hasMore);
      setPage(p);
    } catch {
      setCatalogError('Failed to load batches.');
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    loadCatalog('', 1, true);
  }, [loadCatalog]);

  const handleSearchInput = (value: string) => {
    setSearchTerm(value);
    debounceTerm.current = value;
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      loadCatalog(debounceTerm.current, 1, true);
    }, 500);
  };

  const loadNextPage = () => {
    loadCatalog(searchTerm, page + 1, false);
  };

  /** Catalog card click — open the real-data batch detail sheet. */
  const openCatalogInfo = async (b: BatchCatalogItem) => {
    setBatchInfoOpen(true);
    setBatchInfoLoading(true);
    setBatchInfo(b);
    const res = await api.batchDetail(b._id);
    if (res.success && res.data) setBatchInfo(res.data);
    setBatchInfoLoading(false);
  };

  const enrollInBatch = (batchId: string) => {
    enroll(batchId);
    setCurrentBatchId(batchId);
    setBatchInfoOpen(false);
    nav('study-view');
  };

  const studyBatch = (batchId: string) => {
    setBatchInfoOpen(false);
    setCurrentBatchId(batchId);
    nav('study-view');
  };

  // ==================================================================
  // STUDY DASHBOARD
  // ==================================================================
  const refreshEnrolledDetails = useCallback(async () => {
    const results: BatchDetailPublic[] = [];
    for (const id of enrolled) {
      const cached = batchDetailCache.current.get(id);
      if (cached) {
        results.push(cached);
        continue;
      }
      const res = await api.batchDetail(id);
      if (res.success && res.data) {
        batchDetailCache.current.set(id, res.data);
        results.push(res.data);
      }
    }
    setEnrolledDetails(results);
    setCurrentBatchId((cur) => {
      if (cur && results.some((r) => r._id === cur)) return cur;
      return results.length > 0 ? results[0]._id : null;
    });
  }, [enrolled]);

  useEffect(() => {
    refreshEnrolledDetails();
  }, [refreshEnrolledDetails]);

  const loadEvents = useCallback(async (batchId: string) => {
    setEventsLoading(true);
    const res = await api.todaySchedule(batchId);
    setEvents(res.success && res.data ? res.data : []);
    setEventsLoading(false);
  }, []);

  useEffect(() => {
    if (currentBatchId) loadEvents(currentBatchId);
    else setEvents([]);
  }, [currentBatchId, loadEvents]);

  const currentBatch = enrolledDetails.find((b) => b._id === currentBatchId) || null;

  // ==================================================================
  // ALL CLASSES — SUBJECTS & RESOURCES
  // ==================================================================
  const loadSubjects = useCallback(async (batchId: string) => {
    setSubjectsLoading(true);
    // Batch detail carries the real subject mapping (slug-addressed).
    const res = await api.batchDetail(batchId);
    if (res.success && res.data) {
      batchDetailCache.current.set(batchId, res.data);
      setSubjects(res.data.subjects || []);
    } else {
      setSubjects([]);
    }
    setSubjectsLoading(false);
  }, []);

  const loadResources = useCallback(async (batchId: string) => {
    setResourcesLoading(true);
    const res = await api.resourceTopics(batchId, '');
    const topics = res.success && res.data ? (res.data as unknown as { data?: ChapterItemPublic[] }).data || [] : [];
    setResourceTopics(topics);
    setResourcesLoading(false);
  }, []);

  const openAllClasses = () => {
    setResourcesTab('subjects');
    nav('all-classes-view');
    if (currentBatchId) loadSubjects(currentBatchId);
  };

  const switchClassesTab = (tab: 'subjects' | 'resources') => {
    setResourcesTab(tab);
    if (tab === 'subjects' && currentBatchId) loadSubjects(currentBatchId);
    if (tab === 'resources' && currentBatchId) loadResources(currentBatchId);
  };

  // ==================================================================
  // CHAPTERS
  // ==================================================================
  const loadChaptersList = useCallback(async (subjectId: string, tagType: 'UNITS' | 'STUDY_MATERIAL') => {
    if (!currentBatchId) return;
    setChaptersLoading(true);
    const res = await api.subjectTopics(currentBatchId, subjectId, tagType);
    const list = res.success && res.data ? (res.data as unknown as { data?: ChapterItemPublic[] }).data || [] : [];
    setChapters(list);
    setChaptersLoading(false);
  }, [currentBatchId]);

  const openSubject = (sub: BatchSubjectPublic) => {
    setCurrentSubject({
      id: sub.subjectId || sub._id,
      internalId: sub.subjectId || sub._id,
      name: sub.subject,
      masterId: sub.masterId || '',
      batchSubjectId: sub.batchSubjectId || '',
    });
    setChaptersTab('UNITS');
    nav('chapters-view');
    loadChaptersList(sub.subjectId || sub._id, 'UNITS');
  };

  const switchChaptersTab = (tagType: 'UNITS' | 'STUDY_MATERIAL') => {
    setChaptersTab(tagType);
    if (currentSubject) loadChaptersList(currentSubject.id, tagType);
  };

  // ==================================================================
  // CONTENT
  // ==================================================================
  const loadContent = useCallback(async (subjectId: string, tagId: string, filter: string) => {
    if (!currentBatchId) return;
    setContentLoading(true);
    if (filter === 'DPP_TEST') {
      const subject = currentSubject;
      const res = await api.dppList(currentBatchId, subject?.batchSubjectId || '', tagId);
      const list = res.success && res.data ? (res.data as unknown as { data?: TestItemPublic[] }).data || [] : [];
      setDppItems(list);
      setContentNodes([]);
    } else {
      const res = await api.scheduleContent(currentBatchId, subjectId, tagId, filter);
      const nodes = res.success && res.data ? (res.data as ContentNodePublic[]) : [];
      setContentNodes(nodes);
      setDppItems([]);
    }
    setContentLoading(false);
  }, [currentBatchId, currentSubject]);

  const openTopic = (t: ChapterItemPublic) => {
    setCurrentTopic({ id: t._id, name: t.name });
    setContentTab('ALL');
    nav('content-view');
    if (currentSubject) loadContent(currentSubject.id, t._id, 'ALL');
  };

  const openResourceTopic = (t: ChapterItemPublic) => {
    if (!currentSubject) return;
    setCurrentTopic({ id: t._id, name: t.name });
    setContentTab('ALL');
    nav('content-view');
    loadContent(currentSubject.id, t._id, 'ALL');
  };

  const filterContentTab = (filter: string) => {
    setContentTab(filter);
    if (currentSubject && currentTopic) loadContent(currentSubject.id, currentTopic.id, filter);
  };

  // ==================================================================
  // TESTS
  // ==================================================================
  const openAllTests = () => {
    nav('all-tests-view');
    if (!currentBatchId) return;
    setTestsLoading(true);
    api.testList(currentBatchId).then((res) => {
      setTests(res.success && res.data ? res.data : []);
      setTestsLoading(false);
    }).catch(() => {
      setTests([]);
      setTestsLoading(false);
    });
  };

  const openInstructions = async (t: TestItemPublic) => {
    if (!currentBatchId) return;
    setInstructions({ open: true, loading: true, title: t.name || 'Test', html: '' });
    const res = await api.testDetail(t._id, currentBatchId);
    const d = (res.data || {}) as Record<string, unknown>;
    // upstream instructions arrive as {en: "<html>"} or a plain html string
    const pick = (v: unknown): string => {
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object') return String((v as { en?: string }).en || '');
      return '';
    };
    const raw = pick(d.multiGeneralInstructions) || pick(d.generalInstructions);
    const html = raw.replace(/<script[\s\S]*?<\/script>/gi, '');
    setInstructions({ open: true, loading: false, title: t.name || 'Test', html: html || '<p>No instructions available.</p>' });
  };

  const launchQuiz = (p: { testId: string; scheduleId?: string; subjectId?: string; title: string }) => {
    if (!currentBatchId) return;
    const q = new URLSearchParams({
      testId: p.testId,
      batchId: currentBatchId,
      scheduleId: p.scheduleId || '',
      subjectId: p.subjectId || currentSubject?.masterId || '',
      type: 'Start',
    });
    addXP(10, 'Attempted Test/DPP');
    setDppOpen(false);
    setTestFrame({ open: true, url: `/quiz?${q.toString()}`, title: p.title || 'Test Attempt' });
  };

  // ==================================================================
  // MODALS
  // ==================================================================
  const openBatchInfo = async () => {
    if (!currentBatchId) return;
    setBatchInfoOpen(true);
    setBatchInfoLoading(true);
    const res = await api.batchDetail(currentBatchId);
    setBatchInfo(res.success && res.data ? res.data : null);
    setBatchInfoLoading(false);
  };

  const openNotesModal = async (scheduleId: string, subjectMasterId: string) => {
    if (!currentBatchId) return;
    setNotesOpen(true);
    setNotesLoading(true);
    setNoteRows([]);
    const res = await api.scheduleDetail(currentBatchId, scheduleId, subjectMasterId);
    const item = res.data as {
      topic?: string;
      name?: string;
      homeworkIds?: Array<{ topic?: string; attachmentIds?: Array<{ baseUrl?: string; key?: string }> }>;
    } | undefined;

    const rows: AttachmentRow[] = [];
    if (item) {
      (item.homeworkIds || []).forEach((hw) => {
        (hw.attachmentIds || []).forEach((att) => {
          rows.push({ title: hw.topic || 'Class Note', url: imageUrl(att) });
        });
      });
    }
    setNoteRows(rows);
    setNotesLoading(false);
  };

  const handleUnenroll = (batchId: string) => {
    if (!window.confirm('Are you sure you want to unenroll from this batch?')) return;
    unenroll(batchId);
    setBatchInfoOpen(false);
    if (currentBatchId === batchId) {
      const remaining = enrolled.filter((id) => id !== batchId);
      if (remaining.length > 0) setCurrentBatchId(remaining[0]);
      else {
        setCurrentBatchId(null);
        nav('home-view');
      }
    }
  };

  // ==================================================================
  // RENDER HELPERS
  // ==================================================================
  const renderLectureCard = (node: ContentNodePublic) => {
    const d = node.data;
    const thumb = d.videoDetails?.image || DEFAULT_THUMB;
    const title = d.topic || d.name || 'Lecture';
    const date = d.date ? new Date(d.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const vId = d._id || d.videoDetails?._id || node._id;
    const master = currentSubject?.masterId || currentSubject?.id || '';
    const rawVUrl = d.url || d.videoDetails?.videoUrl || '';
    const realVideoId = d.videoDetails?._id && d.videoDetails._id !== vId ? d.videoDetails._id : '';
    const isWatched = watched.includes(vId);
    const bName = currentBatch?.name || 'PW Batch';
    const base = node.type === 'DPP_VIDEOS' ? '/player' : '/player';
    const playerUrl = `${base}?videoId=${encodeURIComponent(vId)}&batchId=${encodeURIComponent(currentBatchId || '')}&subjectId=${encodeURIComponent(master)}&schId=${encodeURIComponent(node._id)}&title=${encodeURIComponent(title)}&batchName=${encodeURIComponent(bName)}&vUrl=${encodeURIComponent(rawVUrl)}${realVideoId ? `&lectureVideoId=${encodeURIComponent(realVideoId)}` : ''}`;
    const hasAttachments = d.homeworkIds && d.homeworkIds.length > 0;

    return (
      <div className="content-card" key={node._id} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <div className="d-flex gap-3 mb-3">
          <img src={thumb} className="lecture-thumb" alt={title} />
          <div className="flex-grow-1">
            <span style={{ background: '#eff6ff', color: '#2563eb', fontSize: '0.7rem', fontWeight: 800, padding: '2px 6px', borderRadius: 4, display: 'inline-block', marginBottom: 5 }}>
              {node.type === 'DPP_VIDEOS' ? 'DPP VIDEO' : 'VIDEO'}
            </span>
            <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--sb-text-dark)' }}>{title}</div>
            <div style={{ color: 'var(--sb-text-muted)', fontSize: '0.8rem', marginTop: 5 }}>
              <i className="fas fa-clock"></i> {date}
            </div>
          </div>
        </div>
        <div className="d-flex gap-2">
          <button
            className={`btn-check-done ${isWatched ? 'active' : ''}`}
            title="Mark as Watched"
            onClick={() => {
              const added = toggleWatched(vId);
              if (added) addXP(10, 'Watched Video');
            }}
          >
            <i className="fas fa-check"></i>
          </button>
          <button className="btn-play" style={{ flexGrow: 1 }} onClick={() => window.open(playerUrl, '_blank')}>
            <i className="fas fa-play"></i> Watch
          </button>
          {hasAttachments ? (
            <button className="btn-notes" onClick={() => openNotesModal(node._id, master)}>
              <i className="fas fa-file-alt"></i>
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  const renderPdfCard = (node: ContentNodePublic) => {
    const d = node.data;
    const title = d.topic || 'Document';
    const att = d.homeworkIds?.[0]?.attachmentIds?.[0];
    const url = imageUrl(att);
    const isDpp = node.type === 'DPP_PDF';
    const tagColor = isDpp ? '#d97706' : '#e11d48';
    const tagBg = isDpp ? '#fef3c7' : '#fee2e2';
    return (
      <div className="content-card d-flex align-items-center justify-content-between" key={node._id} style={{ padding: 20 }}>
        <div className="d-flex align-items-center gap-3" style={{ maxWidth: '75%' }}>
          <div style={{ background: tagBg, color: tagColor, width: 40, height: 40, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', flexShrink: 0 }}>
            <i className="fas fa-file-pdf"></i>
          </div>
          <div style={{ fontWeight: 600, fontSize: '0.95rem', wordBreak: 'break-word' }}>{title}</div>
        </div>
        <button
          className="btn btn-sb-dark"
          style={{ padding: '8px 16px', borderRadius: 8, fontSize: '0.9rem', width: 'auto' }}
          onClick={() => {
            if (!url) return;
            window.open(url, '_blank');
            addXP(5, 'Viewed Document');
          }}
        >
          <i className="fas fa-eye"></i> View
        </button>
      </div>
    );
  };

  const renderDppItem = (t: TestItemPublic) => {
    return (
      <div className="content-card" key={t._id} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <div className="d-flex align-items-center gap-3 mb-3">
          <div style={{ background: '#fef3c7', color: '#d97706', width: 45, height: 45, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem' }}>
            <i className="fas fa-tasks"></i>
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '1rem' }}>{t.name}</div>
            <div style={{ color: 'var(--sb-text-muted)', fontSize: '0.8rem', marginTop: 4 }}>
              {t.totalQuestions} Qs &bull; {t.totalMarks} Marks
            </div>
          </div>
        </div>
        <button
          className="btn-dpp"
          onClick={() => {
            setDppMeta({
              testId: t._id,
              scheduleId: t.dppQuizDetails?.scheduleId || '',
              subjectId: currentSubject?.masterId || '',
              name: t.name,
            });
            setDppOpen(true);
          }}
        >
          Attempt Now
        </button>
      </div>
    );
  };

  // ==================================================================
  // MAIN RENDER
  // ==================================================================
  const now = new Date();

  const liveEvents = events.filter((e) => e.type === 'LECTURE' && e.data);

  return (
    <>
      {/* ================= SIDEBAR ================= */}
      <div className={`sidebar-overlay ${sidebarOpen ? 'active' : ''}`} onClick={() => setSidebarOpen(false)}></div>
      <div className={`sidebar ${sidebarOpen ? 'active' : ''}`}>
        <div className="sidebar-header">
          <div className="logo-area">
            <img src="/logo-bison.png" alt="Study Bison logo" style={{ width: 38, height: 38, borderRadius: 11, objectFit: 'cover' }} />
            <span className="logo-text">Study <span>Bison</span></span>
          </div>
          <button className="sheet-close" onClick={() => setSidebarOpen(false)} style={{ position: 'relative', top: 0, right: 0, width: 35, height: 35 }} aria-label="Close menu">
            <i className="fas fa-times"></i>
          </button>
        </div>
        <div className="sidebar-links">
          <a onClick={() => nav('study-view')} className={view === 'study-view' ? 'active' : ''} id="link-study" role="button" tabIndex={0}>
            <i className="fas fa-book-open"></i> Study Dashboard
          </a>
          <a onClick={() => nav('home-view')} className={view === 'home-view' ? 'active' : ''} id="link-courses" role="button" tabIndex={0}>
            <i className="fas fa-compass"></i> All Courses
          </a>
          <a onClick={() => nav('downloads-view')} className={view === 'downloads-view' ? 'active' : ''} id="link-downloads" role="button" tabIndex={0}>
            <i className="fas fa-download"></i> Downloads
            {downloads.length > 0 ? <span className="dl-count-pill">{downloads.length}</span> : null}
          </a>
        </div>
        <div id="dev-credit" style={{ marginTop: 'auto', padding: 24, textAlign: 'center', borderTop: '1px solid var(--sb-border-color)', background: 'rgba(0,0,0,0.02)' }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--sb-text-muted)', letterSpacing: '0.5px' }}>
            <i className="fas fa-code" style={{ color: 'var(--sb-text-dark)' }}></i> Developed by <br />
            <span style={{ color: 'var(--sb-primary)', fontWeight: 800, fontSize: '1.2rem', textTransform: 'uppercase', display: 'inline-block', marginTop: 5 }}>Nishant</span>
          </div>
        </div>
      </div>

      {/* ================= HEADER ================= */}
      <header className="sb-header">
        <div className="d-flex align-items-center">
          <button className="menu-btn" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            <i className="fas fa-bars-staggered"></i>
          </button>
          <a className="logo-area" onClick={() => nav('home-view')} role="button" tabIndex={0}>
            <img src="/logo-bison.png" alt="Study Bison logo" style={{ width: 38, height: 38, borderRadius: 11, objectFit: 'cover' }} />
            <span className="logo-text">Study <span>Bison</span></span>
          </a>
        </div>
        <div className="d-flex align-items-center">
          <div className="nav-tab active xp-chip">
            <i className="fas fa-bolt text-warning"></i> <span>{xp} XP</span>
          </div>
        </div>
      </header>

      <div id="app-container">
        {/* ================= HOME VIEW ================= */}
        <div id="home-view" className={`view-section ${view === 'home-view' ? 'active-view' : ''}`}>
          <div className="search-container">
            <div className="d-flex justify-content-between align-items-center mb-3">
              <h4 className="m-0" style={{ fontWeight: 800 }}>Discover Courses</h4>
              <span style={{ fontSize: '0.85rem', color: 'var(--sb-primary)', fontWeight: 700 }}>
                {searching ? <i className="fas fa-spinner fa-spin"></i> : null}
              </span>
            </div>
            <input
              type="text"
              className="search-bar"
              placeholder="Search for exams, batches..."
              value={searchTerm}
              onChange={(e) => handleSearchInput(e.target.value)}
              aria-label="Search for exams, batches"
            />
          </div>
          <div className="container px-4 pb-5">
            {catalogError ? (
              <div className="text-center p-5 text-muted">{catalogError}</div>
            ) : null}
            {!searching && batches.length === 0 && !catalogError ? (
              <div className="text-center p-5 text-muted">
                <i className="fas fa-search fa-2x mb-3" style={{ display: 'block' }}></i>
                No batches found.
              </div>
            ) : null}
            <div className="row g-4">
              {batches.map((b) => {
                const thumb = b.imageUrl || DEFAULT_THUMB;
                const isEnrolled = enrolled.includes(b._id);
                return (
                  <div className="col-12 col-md-6 col-lg-4" key={b._id}>
                    <div className="card-custom" onClick={() => openCatalogInfo(b)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') openCatalogInfo(b); }}>
                      <img src={thumb} className="batch-thumb" alt={b.name} loading="lazy" />
                      <div className="card-body-custom">
                        <div className="title-text mt-2">{b.name}</div>
                        <button className="btn-sb-dark w-100 mt-auto" style={{ fontWeight: 600 }}>
                          {isEnrolled ? 'Study' : 'View Details'}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {hasMore ? (
              <div className="text-center mt-5" id="load-more-container" style={{ display: 'block' }}>
                <button className="btn btn-sb-dark" style={{ width: 'auto', padding: '14px 40px', borderRadius: 30 }} onClick={loadNextPage}>
                  <i className="fas fa-sync-alt me-2"></i> {searching ? 'Loading...' : 'Load More'}
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {/* ================= STUDY VIEW ================= */}
        {/* ================= DOWNLOADS VIEW (PWA offline library) ================= */}
        <div id="downloads-view" className={`view-section ${view === 'downloads-view' ? 'active-view' : ''}`}>
          <div className="breadcrumb-pw">
            <button className="back-btn" onClick={() => nav('home-view')} aria-label="Back"><i className="fas fa-arrow-left"></i></button>
            <span>Downloads</span>
          </div>
          <div className="dl-page-head">
            <div className="dl-page-icon"><i className="fas fa-cloud-arrow-down"></i></div>
            <div>
              <h5 style={{ fontWeight: 800, margin: 0 }}>Offline Lectures</h5>
              <p style={{ fontSize: '0.78rem', color: 'var(--sb-text-muted)', margin: '3px 0 0' }}>
                Download any lecture from the player (⋮ → Download) and watch it without internet.
                Unlimited downloads — limited only by your device storage.
              </p>
            </div>
          </div>

          {storageEst && storageEst.quota > 0 ? (
            <div className="dl-storage">
              <div className="dl-storage-line">
                <span><i className="fas fa-hard-drive"></i> {formatBytes(storageEst.usage)} used</span>
                <span>{storageEst.quota ? `${Math.min(100, Math.round((storageEst.usage / storageEst.quota) * 100))}%` : ''}</span>
              </div>
              <div className="dl-storage-bar"><span style={{ width: `${Math.min(100, (storageEst.usage / storageEst.quota) * 100)}%` }}></span></div>
              <div className="dl-storage-sub">of about {formatBytes(storageEst.quota)} available on this device</div>
            </div>
          ) : null}

          <div className="px-4 py-3">
            {downloads.length === 0 ? (
              <div className="text-center py-4">
                <i className="fas fa-cloud-arrow-down" style={{ fontSize: '3rem', color: 'var(--sb-text-muted)', opacity: 0.5, marginBottom: 10 }}></i>
                <h6 style={{ fontWeight: 700 }}>No downloads yet</h6>
                <p className="text-muted" style={{ fontSize: '0.85rem' }}>
                  Open any lecture, tap <b>⋮ → Download</b> and it will be available here for offline watching.
                </p>
              </div>
            ) : (
              <div className="row g-3">
                {downloads.map((rec) => {
                  const dlTotal = rec.partsTotal || rec.parts.length;
                  const pct = dlTotal > 0 ? Math.round((rec.partsDone / dlTotal) * 100) : 0;
                  const isActive = rec.status === 'downloading' || rec.status === 'collecting';
                  return (
                    <div className="col-12" key={rec.id}>
                      <div className="list-card dl-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
                        <div className="d-flex align-items-start gap-3">
                          <div className="dl-thumb"><i className="fas fa-play"></i></div>
                          <div className="flex-grow-1" style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: '0.95rem', lineHeight: 1.25, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                              {rec.title || 'Lecture'}
                            </div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--sb-text-muted)', marginTop: 3 }}>
                              {rec.batchName || 'PW Batch'} · {new Date(rec.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                            </div>
                            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {rec.status === 'done' ? (
                                <span className="dl-tag dl-tag-ok"><i className="fas fa-circle-check"></i> Offline ready</span>
                              ) : isActive ? (
                                <span className="dl-tag dl-tag-busy"><i className="fas fa-spinner fa-spin"></i> Downloading {pct}%</span>
                              ) : rec.status === 'paused' ? (
                                <span className="dl-tag dl-tag-warn"><i className="fas fa-pause"></i> Paused {pct}%</span>
                              ) : (
                                <span className="dl-tag dl-tag-err"><i className="fas fa-triangle-exclamation"></i> {rec.status === 'error' ? 'Failed' : rec.status}</span>
                              )}
                              <span className="dl-tag">{formatBytes(rec.sizeBytes)}</span>
                              {rec.height ? <span className="dl-tag">{rec.height}p</span> : null}
                              <span className="dl-tag">{rec.kind.toUpperCase()}</span>
                            </div>
                            {isActive || rec.status === 'paused' ? (
                              <div className="dl-bar" style={{ marginTop: 8 }}>
                                <span className="dl-bar-fill" style={{ width: `${pct}%` }}></span>
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <div className="d-flex gap-2">
                          {rec.status === 'done' ? (
                            <button className="btn btn-sm btn-sb-dark" style={{ flexGrow: 1 }} onClick={() => playDownload(rec)}>
                              <i className="fas fa-play"></i> Watch offline
                            </button>
                          ) : isActive ? (
                            <button className="btn btn-sm btn-outline-secondary" style={{ flexGrow: 1 }} onClick={() => { void pauseDownload(rec.id); }}>
                              <i className="fas fa-pause"></i> Pause
                            </button>
                          ) : (
                            <button className="btn btn-sm btn-sb-dark" style={{ flexGrow: 1 }} onClick={() => { void startDownload({
                              id: rec.id, title: rec.title, batchName: rec.batchName, batchId: rec.batchId,
                              subjectId: rec.subjectId, schId: rec.schId, realVideoId: rec.realVideoId,
                              vUrl: rec.vUrl, kind: rec.kind, url: rec.url, clearKeys: rec.clearKeys, poster: rec.poster,
                            }); }}>
                              <i className="fas fa-rotate-right"></i> {rec.status === 'paused' ? 'Resume' : 'Retry'}
                            </button>
                          )}
                          <button className="btn btn-sm btn-outline-secondary" onClick={() => { if (window.confirm('Delete this downloaded lecture?')) void deleteDownload(rec.id); }} aria-label={`Delete ${rec.title}`}>
                            <i className="fas fa-trash" style={{ color: '#e11d48' }}></i>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div id="study-view" className={`view-section ${view === 'study-view' ? 'active-view' : ''}`}>
          <div className="study-header-bg">
            <div style={{ flexGrow: 1, overflow: 'hidden', paddingRight: 15 }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#9CA3AF', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '1px' }}>Selected Batch</div>
              <select
                className="batch-dropdown"
                value={currentBatchId || ''}
                onChange={(e) => setCurrentBatchId(e.target.value)}
                aria-label="Select enrolled batch"
              >
                {enrolledDetails.length === 0 ? <option value="">No batch enrolled</option> : null}
                {enrolledDetails.map((b) => (
                  <option key={b._id} value={b._id}>{b.name}</option>
                ))}
              </select>
            </div>
            <button className="back-btn" style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', margin: 0 }} onClick={openBatchInfo} aria-label="Batch info">
              <i className="fas fa-info"></i>
            </button>
          </div>

          <div className="offerings-container pb-0">
            <div className="offering-title">Quick Access</div>

            <div className="offering-item" onClick={openAllClasses} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') openAllClasses(); }}>
              <div className="offering-icon icon-blue"><i className="fas fa-tv"></i></div>
              <div style={{ flexGrow: 1 }}>
                <span style={{ fontWeight: 800, fontSize: '1.15rem', color: 'var(--sb-text-dark)', display: 'block' }}>All Classes</span>
                <span style={{ fontSize: '0.85rem', color: 'var(--sb-text-muted)', fontWeight: 500 }}>Lectures &amp; Resources</span>
              </div>
              <i className="fas fa-chevron-right text-muted ms-auto"></i>
            </div>

            <div className="offering-item" onClick={openAllTests} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') openAllTests(); }}>
              <div className="offering-icon icon-indigo"><i className="fas fa-file-signature"></i></div>
              <div style={{ flexGrow: 1 }}>
                <span style={{ fontWeight: 800, fontSize: '1.15rem', color: 'var(--sb-text-dark)', display: 'block' }}>All Tests &amp; DPPs</span>
                <span style={{ fontSize: '0.85rem', color: 'var(--sb-text-muted)', fontWeight: 500 }}>Practice &amp; Mocks</span>
              </div>
              <i className="fas fa-chevron-right text-muted ms-auto"></i>
            </div>
          </div>

          <div className="live-section mt-4">
            <div className="offering-title"><i className="fas fa-broadcast-tower text-danger me-2"></i> Today&apos;s Classes</div>
            <div id="live-classes-scroll">
              {eventsLoading ? (
                <div className="loader-center"><i className="fas fa-spinner fa-spin"></i></div>
              ) : !currentBatchId ? (
                <div className="text-center py-4">
                  <i className="fas fa-calendar-times" style={{ fontSize: '3rem', color: 'var(--sb-text-muted)', opacity: 0.5, marginBottom: 10 }}></i>
                  <h6 style={{ fontWeight: 700 }}>No batch selected</h6>
                  <p className="text-muted" style={{ fontSize: '0.85rem' }}>Enroll in a batch from All Courses to see your schedule.</p>
                </div>
              ) : liveEvents.length === 0 ? (
                <div className="text-center py-4">
                  <i className="fas fa-calendar-times" style={{ fontSize: '3rem', color: 'var(--sb-text-muted)', opacity: 0.5, marginBottom: 10 }}></i>
                  <h6 style={{ fontWeight: 700 }}>No upcoming events,</h6>
                  <p className="text-muted" style={{ fontSize: '0.85rem' }}>Perfect time to catch up on pending work!</p>
                </div>
              ) : (
                liveEvents.map((e) => {
                  const d = e.data;
                  const start = new Date(d.startTime);
                  const isLiveNow = d.status === 'LIVE';
                  const isEnded = d.status === 'ENDED';
                  const thumb = d.videoDetails?.image || DEFAULT_THUMB;
                  const time = d.startTime ? start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                  const subjectMaster = d.subjectId?._id || '';
                  const playable = d.urlType === 'penpencilvdo' || d.urlType === 'youtube';
                  const watchUrl = isEnded && playable
                    ? `/player?videoId=${encodeURIComponent(d._id)}&batchId=${encodeURIComponent(d.batchId || currentBatchId || '')}&subjectId=${encodeURIComponent(subjectMaster)}&title=${encodeURIComponent(d.topic || '')}`
                    : '';
                  const liveUrl = `/live?videoId=${encodeURIComponent(d._id)}&batchId=${encodeURIComponent(d.batchId || currentBatchId || '')}&subjectId=${encodeURIComponent(subjectMaster)}&title=${encodeURIComponent(d.topic || '')}`;
                  return (
                    <div className="live-card-vertical" key={e._id}>
                      <img src={thumb} className="live-thumb-sm" alt={d.topic} />
                      <div className="flex-grow-1">
                        {isLiveNow
                          ? <span className="live-tag">🔴LIVE NOW</span>
                          : isEnded
                            ? <span className="upcoming-tag" style={{ background: '#eef2f7', color: '#64748b' }}>✔ COMPLETED</span>
                            : d.status === 'CANCELLED'
                              ? <span className="upcoming-tag" style={{ background: '#fee2e2', color: '#e11d48' }}>✖ CANCELLED</span>
                              : <span className="upcoming-tag">🔔UPCOMING</span>}
                        <div style={{ fontWeight: 700, fontSize: '0.95rem', lineHeight: 1.2, marginBottom: 5, marginTop: 6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{d.topic || d._id}</div>
                        <div className="d-flex justify-content-between align-items-center mt-2">
                          <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--sb-text-muted)' }}>
                            <i className="far fa-clock"></i> {time}
                          </div>
                          <div className="d-flex align-items-center gap-2">
                            {isLiveNow ? (
                              <button className="btn btn-sm btn-danger" onClick={() => window.open(liveUrl, '_blank')}>
                                <i className="fas fa-play"></i> Join
                              </button>
                            ) : isEnded && watchUrl ? (
                              <button className="btn btn-sm btn-sb-dark" onClick={() => window.open(watchUrl, '_blank')}>
                                <i className="fas fa-play"></i> Watch
                              </button>
                            ) : !isEnded ? (
                              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--sb-text-muted)', border: '1px solid var(--sb-border-color)', padding: '4px 8px', borderRadius: 4 }}>Scheduled</span>
                            ) : null}
                            {d.status !== 'CANCELLED' ? (
                              <button className="btn btn-sm btn-outline-secondary" onClick={() => openNotesModal(e._id, subjectMaster)}>Notes</button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* ================= ALL CLASSES VIEW ================= */}
        <div id="all-classes-view" className={`view-section ${view === 'all-classes-view' ? 'active-view' : ''}`}>
          <div className="breadcrumb-pw">
            <button className="back-btn" onClick={() => nav('study-view')} aria-label="Back"><i className="fas fa-arrow-left"></i></button>
            <span>Subjects</span>
          </div>
          <div className="nav-tabs-pw">
            <div className={`nav-tab ${resourcesTab === 'subjects' ? 'active' : ''}`} id="tab-subjects" onClick={() => switchClassesTab('subjects')}>Subjects</div>
            <div className={`nav-tab ${resourcesTab === 'resources' ? 'active' : ''}`} id="tab-resources" onClick={() => switchClassesTab('resources')}>Resources</div>
          </div>
          <div className="px-4 py-3">
            {resourcesTab === 'subjects' ? (
              subjectsLoading ? (
                <div className="loader-center"><i className="fas fa-spinner fa-spin"></i></div>
              ) : subjects.length === 0 ? (
                <p className="text-muted text-center w-100">No subjects mapped.</p>
              ) : (
                <div className="row g-3" id="subjects-grid">
                  {subjects.map((sub) => (
                    <div className="col-12 col-md-6" key={sub._id}>
                      <div className="list-card" onClick={() => openSubject(sub)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') openSubject(sub); }}>
                        <div className="sub-icon-letter">{(sub.subject || 'S').substring(0, 2).toUpperCase()}</div>
                        <div style={{ flexGrow: 1, fontWeight: 700, fontSize: '1.05rem' }}>{sub.subject}</div>
                        <i className="fas fa-chevron-right text-muted"></i>
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : resourcesLoading ? (
              <div className="loader-center"><i className="fas fa-spinner fa-spin"></i></div>
            ) : resourceTopics.length === 0 ? (
              <p className="text-muted text-center p-4">No resources found.</p>
            ) : (
              <div id="resources-grid">
                {resourceTopics.map((t) => (
                  <div className="list-card" key={t._id} onClick={() => openResourceTopic(t)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') openResourceTopic(t); }}>
                    <div className="sub-icon-letter" style={{ background: '#fefce8', color: '#d97706' }}><i className="fas fa-folder"></i></div>
                    <div style={{ flexGrow: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: '1rem' }}>{t.name}</div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--sb-text-muted)', marginTop: 2 }}>{t.notes} Notes &bull; {t.videos} Videos</div>
                    </div>
                    <i className="fas fa-chevron-right text-muted"></i>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ================= CHAPTERS VIEW ================= */}
        <div id="chapters-view" className={`view-section ${view === 'chapters-view' ? 'active-view' : ''}`}>
          <div className="breadcrumb-pw">
            <button className="back-btn" onClick={() => nav('all-classes-view')} aria-label="Back"><i className="fas fa-arrow-left"></i></button>
            <span>{currentSubject?.name || 'Subject'}</span>
          </div>
          <div className="nav-tabs-pw">
            <div className={`nav-tab ${chaptersTab === 'UNITS' ? 'active' : ''}`} id="tab-ch-chapters" onClick={() => switchChaptersTab('UNITS')}>Chapters</div>
            <div className={`nav-tab ${chaptersTab === 'STUDY_MATERIAL' ? 'active' : ''}`} id="tab-ch-study" onClick={() => switchChaptersTab('STUDY_MATERIAL')}>Study Material</div>
          </div>
          <div className="px-4 py-3" id="chapters-list">
            {chaptersLoading ? (
              <div className="loader-center"><i className="fas fa-spinner fa-spin"></i></div>
            ) : chapters.length === 0 ? (
              <p className="text-muted text-center p-4">Directory empty.</p>
            ) : (
              chapters.map((t, i) => {
                const code = i < 9 ? `0${i + 1}` : `${i + 1}`;
                const tagPre = chaptersTab === 'UNITS' ? 'CH' : 'SM';
                return (
                  <div className="list-card" key={t._id} onClick={() => openTopic(t)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') openTopic(t); }}>
                    <div style={{ flexGrow: 1 }}>
                      <span style={{ background: 'var(--sb-primary-light)', color: 'var(--sb-primary)', fontSize: '0.75rem', fontWeight: 800, padding: '3px 8px', borderRadius: 4 }}>{tagPre} - {code}</span>
                      <div style={{ fontWeight: 700, fontSize: '1.05rem', marginTop: 8 }}>{t.name}</div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--sb-text-muted)', marginTop: 4 }}>
                        {t.videos} Videos &bull; {t.notes} Notes{t.exercises ? ` • ${t.exercises} DPPs` : ''}
                      </div>
                    </div>
                    <i className="fas fa-chevron-right text-muted ms-3"></i>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ================= CONTENT VIEW ================= */}
        <div id="content-view" className={`view-section ${view === 'content-view' ? 'active-view' : ''}`}>
          <div className="breadcrumb-pw">
            <button className="back-btn" onClick={() => nav('chapters-view')} aria-label="Back"><i className="fas fa-arrow-left"></i></button>
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentTopic?.name || 'Chapter'}</span>
          </div>
          <div className="nav-tabs-pw" id="content-tabs">
            {[['ALL', 'All'], ['LECTURE', 'Lectures'], ['DPP_TEST', 'DPPs'], ['NOTES', 'Notes'], ['DPP_PDF', 'DPP PDFs'], ['DPP_VIDEOS', 'DPP Videos']].map(([key, label]) => (
              <div key={key} className={`nav-tab ${contentTab === key ? 'active' : ''}`} onClick={() => filterContentTab(key)}>{label}</div>
            ))}
          </div>
          <div className="px-4 py-3" id="content-list">
            {contentLoading ? (
              <div className="loader-center"><i className="fas fa-spinner fa-spin"></i></div>
            ) : contentTab === 'DPP_TEST' ? (
              dppItems.length === 0 ? (
                <p className="text-center text-muted p-4">No DPPs available for this chapter.</p>
              ) : (
                dppItems.map((t) => renderDppItem(t))
              )
            ) : contentNodes.length === 0 ? (
              <p className="text-center text-muted p-4">No content available.</p>
            ) : (
              contentNodes.map((node) =>
                node.data && (node.type === 'LECTURE' || node.type === 'DPP_VIDEOS')
                  ? renderLectureCard(node)
                  : node.data && node.type === 'NOTES'
                    ? renderPdfCard(node)
                    : null,
              )
            )}
          </div>
        </div>

        {/* ================= ALL TESTS VIEW ================= */}
        <div id="all-tests-view" className={`view-section ${view === 'all-tests-view' ? 'active-view' : ''}`}>
          <div className="breadcrumb-pw">
            <button className="back-btn" onClick={() => nav('study-view')} aria-label="Back"><i className="fas fa-arrow-left"></i></button>
            <span>Assessments</span>
          </div>
          <div className="px-4 py-3" id="tests-list">
            {testsLoading ? (
              <div className="loader-center"><i className="fas fa-spinner fa-spin"></i></div>
            ) : tests.length === 0 ? (
              <p className="text-muted text-center p-4">No tests configured.</p>
            ) : (
              tests.map((t) => (
                <div className="content-card" key={t._id} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <div className="d-flex align-items-center gap-3 mb-3">
                    <div style={{ background: '#fef3c7', color: '#d97706', width: 45, height: 45, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem' }}>
                      <i className="fas fa-tasks"></i>
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '1rem' }}>{t.name || t._id}</div>
                      <div style={{ color: 'var(--sb-text-muted)', fontSize: '0.8rem', marginTop: 4 }}>
                        {t.totalQuestions} Qs &bull; {t.totalMarks} Marks
                      </div>
                    </div>
                  </div>
                  <div className="d-flex gap-2">
                    <button className="btn-dpp" style={{ background: '#f1f5f9', color: 'var(--sb-text-dark)' }} onClick={() => openInstructions(t)}>
                      <i className="fas fa-info-circle me-1"></i> Instructions
                    </button>
                    <button className="btn-dpp" style={{ flexGrow: 1 }} onClick={() => launchQuiz({ testId: t._id, subjectId: '', title: t.name || 'Test Attempt' })}>
                      Attempt Now
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ================= BATCH INFO MODAL ================= */}
      <div className={`modal-overlay ${batchInfoOpen ? 'active' : ''}`} id="batch-info-modal" onClick={(e) => { if (e.target === e.currentTarget) setBatchInfoOpen(false); }}>
        <div className="bottom-sheet" style={{ padding: 0, overflow: 'hidden' }}>
          <i className="fas fa-times sheet-close" onClick={() => setBatchInfoOpen(false)}></i>
          <div id="batch-info-content">
            {batchInfoLoading ? (
              <div className="loader-center" style={{ padding: '100px 0' }}><i className="fas fa-spinner fa-spin"></i> Fetching Details...</div>
            ) : !batchInfo ? (
              <p className="text-center text-muted p-5">Batch details not available.</p>
            ) : (() => {
              const thumb = imageUrl(batchInfo.imageUrl, DEFAULT_THUMB);
              const priceText =
                batchInfo.amount == null
                  ? ''
                  : batchInfo.amount === 0
                    ? 'Free'
                    : `₹${batchInfo.amount.toLocaleString('en-IN')}`;
              const sDate = batchInfo.startDate ? new Date(batchInfo.startDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'TBA';
              const eDate = batchInfo.endDate ? new Date(batchInfo.endDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'TBA';
              const isEnrolled = enrolled.includes(batchInfo._id);
              return (
                <>
                  <div style={{ background: `url('${thumb}') center/cover`, height: 200, width: '100%', borderRadius: '20px 20px 0 0', position: 'relative' }}>
                    <div style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: '50%', background: 'linear-gradient(to top, rgba(0,0,0,0.8), transparent)' }}></div>
                    {priceText ? <div className="badge bg-danger position-absolute top-0 end-0 m-3 fs-6">{priceText}</div> : null}
                  </div>
                  <div className="p-4 pt-3">
                    <h4 className="fw-bold mb-1">{batchInfo.name}</h4>
                    {batchInfo.byName ? (
                      <div style={{ color: 'var(--sb-text-muted)', fontWeight: 600, fontSize: '0.9rem', marginBottom: 10 }}>{batchInfo.byName}</div>
                    ) : null}

                    {batchInfo.exams.length > 0 ? (
                      <div style={{ marginBottom: 14 }}>
                        {batchInfo.exams.map((exam, i) => (
                          <span key={i} style={{ background: '#fef3c7', color: '#d97706', border: '1px solid #fde68a', fontSize: '0.7rem', fontWeight: 700, padding: '4px 10px', borderRadius: 20, display: 'inline-block', marginRight: 8, marginBottom: 8 }}>
                            {exam}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    <div className="batch-grid-info">
                      <div className="bg-info-box"><span className="lbl">Class</span><span className="val">{batchInfo.className || 'General'}</span></div>
                      <div className="bg-info-box"><span className="lbl">Language</span><span className="val">{batchInfo.language || 'Hinglish'}</span></div>
                      <div className="bg-info-box"><span className="lbl">Start Date</span><span className="val">{sDate}</span></div>
                      <div className="bg-info-box"><span className="lbl">End Date</span><span className="val">{eDate}</span></div>
                    </div>

                    {isEnrolled ? (
                      <>
                        <button className="btn btn-sb-dark w-100 mt-4 fw-bold rounded-pill" onClick={() => studyBatch(batchInfo._id)}>
                          <i className="fas fa-book-open me-2"></i> Study This Batch
                        </button>
                        <button className="btn btn-outline-danger w-100 mt-3 fw-bold rounded-pill" onClick={() => handleUnenroll(batchInfo._id)}>
                          <i className="fas fa-sign-out-alt me-2"></i> Unenroll from Batch
                        </button>
                      </>
                    ) : (
                      <button className="btn btn-sb-dark w-100 mt-4 fw-bold rounded-pill" onClick={() => enrollInBatch(batchInfo._id)}>
                        <i className="fas fa-graduation-cap me-2"></i> Enroll Now
                      </button>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      </div>

      {/* ================= NOTES MODAL ================= */}
      <div className={`modal-overlay ${notesOpen ? 'active' : ''}`} id="notes-modal" onClick={(e) => { if (e.target === e.currentTarget) setNotesOpen(false); }}>
        <div className="bottom-sheet">
          <i className="fas fa-times sheet-close" onClick={() => setNotesOpen(false)}></i>
          <h4 style={{ fontWeight: 800, marginBottom: 24, color: 'var(--sb-text-dark)' }}>Attachments</h4>
          <div id="notes-modal-content">
            {notesLoading ? (
              <div className="loader-center"><i className="fas fa-spinner fa-spin"></i></div>
            ) : (
              <>
                {noteRows.map((row, i) => (
                  <div className="resource-row" key={`n-${i}`}>
                    <div className="resource-title"><i className="fas fa-file-pdf text-danger"></i> {row.title}</div>
                    <button className="btn-view-pdf" onClick={() => { window.open(row.url, '_blank'); addXP(5, 'Viewed Document'); }}>View</button>
                  </div>
                ))}
                {noteRows.length === 0 && !notesLoading ? (
                  <p className="text-muted text-center">No resources attached.</p>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ================= DPP MODE MODAL ================= */}
      <div className={`modal-overlay ${dppOpen ? 'active' : ''}`} id="dpp-modal" onClick={(e) => { if (e.target === e.currentTarget) setDppOpen(false); }}>
        <div className="bottom-sheet">
          <i className="fas fa-times sheet-close" onClick={() => setDppOpen(false)}></i>
          <h4 style={{ fontWeight: 800, marginBottom: 24, color: 'var(--sb-text-dark)' }}>Choose Attempt Mode</h4>
          <div id="dpp-modal-content" className="d-flex flex-column gap-3">
            <div className="resource-row" style={{ background: '#eff6ff', border: '1px solid #2563eb', cursor: 'pointer' }} onClick={() => dppMeta && launchQuiz({ testId: dppMeta.testId, scheduleId: dppMeta.scheduleId, subjectId: dppMeta.subjectId, title: dppMeta.name })} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' && dppMeta) launchQuiz({ testId: dppMeta.testId, scheduleId: dppMeta.scheduleId, subjectId: dppMeta.subjectId, title: dppMeta.name }); }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: '1.1rem', color: '#2563eb' }}>Practice Mode</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--sb-text-dark)', marginTop: 4 }}>Learn without time pressure</div>
              </div>
              <i className="fas fa-chevron-right" style={{ color: '#2563eb' }}></i>
            </div>
            <div className="resource-row" style={{ background: '#fef2f2', border: '1px solid #e11d48', cursor: 'pointer' }} onClick={() => dppMeta && launchQuiz({ testId: dppMeta.testId, scheduleId: dppMeta.scheduleId, subjectId: dppMeta.subjectId, title: dppMeta.name })} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' && dppMeta) launchQuiz({ testId: dppMeta.testId, scheduleId: dppMeta.scheduleId, subjectId: dppMeta.subjectId, title: dppMeta.name }); }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: '1.1rem', color: '#e11d48' }}>Quiz Mode</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--sb-text-dark)', marginTop: 4 }}>Attempt with standard timing</div>
              </div>
              <i className="fas fa-chevron-right" style={{ color: '#e11d48' }}></i>
            </div>
          </div>
        </div>
      </div>

      {/* ================= TEST INSTRUCTIONS MODAL ================= */}
      <div className={`modal-overlay ${instructions.open ? 'active' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) setInstructions({ open: false, loading: false, title: '', html: '' }); }}>
        <div className="bottom-sheet" style={{ maxHeight: '80vh' }}>
          <i className="fas fa-times sheet-close" onClick={() => setInstructions({ open: false, loading: false, title: '', html: '' })}></i>
          <h4 style={{ fontWeight: 800, marginBottom: 16, color: 'var(--sb-text-dark)' }}>{instructions.title}</h4>
          {instructions.loading ? (
            <div className="loader-center"><i className="fas fa-spinner fa-spin"></i></div>
          ) : (
            <div
              style={{ maxHeight: '55vh', overflowY: 'auto', fontSize: '0.9rem', color: 'var(--sb-text-dark)', lineHeight: 1.6 }}
              className="instructions-body"
              dangerouslySetInnerHTML={{ __html: instructions.html }}
            />
          )}
        </div>
      </div>

      {/* ================= QUIZ IFRAME MODAL ================= */}
      <div className={`iframe-overlay ${testFrame.open ? 'active' : ''}`} id="test-iframe-modal">
        <div className="iframe-header">
          <h5 className="m-0" style={{ fontWeight: 800, color: 'var(--sb-text-dark)' }}>{testFrame.title}</h5>
          <button className="btn btn-sm btn-danger fw-bold rounded-pill px-3" onClick={() => setTestFrame({ open: false, url: '', title: 'Test Attempt' })}>
            <i className="fas fa-times me-1"></i> Close
          </button>
        </div>
        <iframe id="test-iframe" className="iframe-content" src={testFrame.open ? testFrame.url : undefined} title={testFrame.title} />
      </div>
    </>
  );
}
