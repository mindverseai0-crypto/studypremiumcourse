'use client';

// Study Bison live class page — plays REAL live/recorded PW classes through the
// same secure pipeline as the player (DASH ClearKey / HLS / YouTube / mp4).
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type HlsType from 'hls.js';
import type ShakaNamespace from 'shaka-player';
import './live.css';
import { api, imageUrl } from '@/lib/api-client';
import { isHlsUrl, isMpdUrl, youtubeId } from '@/lib/video-utils';
import { LIVE_MANIFEST_URL } from '@/lib/live-stream';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

type PlayerKind = '' | 'dash' | 'hls' | 'youtube' | 'mp4';

function formatTime(t: number): string {
  if (!isFinite(t) || t < 0) return '00:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface Attachment {
  title: string;
  url: string;
}

const POLL = {
  q: 'How well are you understanding today’s topic?',
  options: ['Very well 😎', 'Average 🙂', 'Need revision 😅'],
};

function LiveInner() {
  const params = useSearchParams();
  const videoId = params.get('videoId') || params.get('vId') || '';
  const batchId = params.get('batchId') || '';
  const subjectId = params.get('subjectId') || params.get('SubjectId') || '';
  const title = params.get('title') || 'PW Live Class';
  const vUrl = params.get('vUrl') || '';
  // DVR start epoch for the shared live channel (?start=<epoch>)
  const [startOffset] = useState(() => {
    const s = Number(params.get('start'));
    return Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  });
  const liveFallbackDone = useRef(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hlsRef = useRef<HlsType | null>(null);
  const shakaRef = useRef<ShakaNamespace.Player | null>(null);

  const [kind, setKind] = useState<PlayerKind>('');
  const [src, setSrc] = useState('');
  const [clearKeys, setClearKeys] = useState<Record<string, string> | null>(null);
  const [status, setStatus] = useState('Connecting to Live Server...');
  const [statusSub, setStatusSub] = useState('Resolving Secure Stream');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [centerVisible, setCenterVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(2);

  const [menuOpen, setMenuOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[] | null>(null);
  const [comments, setComments] = useState<Array<{ name: string; text: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [votes, setVotes] = useState<number[]>([0, 0, 0]);
  const [voted, setVoted] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  // ------------------------------------------------------------------
  // Resolve payload — per-batch/class content FIRST (each batch plays its
  // own lecture, not one shared video), shared live channel as fallback.
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError('');
      // 1) direct passthrough for non-CloudFront URLs (youtube / plain files)
      if (vUrl && !/\.cloudfront\.net/i.test(vUrl)) {
        setSrc(vUrl);
        if (isMpdUrl(vUrl)) setKind('dash');
        else if (isHlsUrl(vUrl)) setKind('hls');
        else if (/youtube\.com|youtu\.be/i.test(vUrl)) setKind('youtube');
        else setKind('mp4');
        setLoading(false);
        return;
      }
      // 2) per-batch/class payload (batch-specific lecture video)
      if (videoId) {
        try {
          const res = await api.videoPayload(videoId, batchId, subjectId, vUrl);
          if (cancelled) return;
          if (res.success && res.data && res.data.url) {
            setKind(res.data.kind || 'mp4');
            setSrc(res.data.url);
            setClearKeys(res.data.clearKeys || null);
            setLoading(false);
            return;
          }
        } catch {
          /* fall through to the shared channel */
        }
        if (cancelled) return;
      }
      // 3) shared live channel fallback (one attempt, DVR start when given)
      if (!liveFallbackDone.current) {
        liveFallbackDone.current = true;
        setKind('hls');
        setSrc(startOffset > 0 ? `${LIVE_MANIFEST_URL}?start=${startOffset}` : LIVE_MANIFEST_URL);
        setLoading(false);
        return;
      }
      if (!cancelled) {
        setError('Live Stream Offline');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoId, batchId, subjectId, vUrl, startOffset]);

  // ------------------------------------------------------------------
  // Attach source by kind
  // ------------------------------------------------------------------
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !src) return;

    if (kind === 'youtube') return;
    if (kind === 'mp4') {
      v.src = src;
      return () => {
        v.removeAttribute('src');
        v.load();
      };
    }

    let destroyed = false;
    (async () => {
      if (kind === 'dash') {
        const shaka = (await import('shaka-player')).default;
        if (destroyed) return;
        shaka.polyfill.installAll();
        if (!shaka.Player.isBrowserSupported()) {
          setError('Protected video playback is not supported in this browser.');
          setLoading(false);
          return;
        }
        const player = new shaka.Player(v);
        shakaRef.current = player;
        player.configure({
          abr: { enabled: true },
          ...(clearKeys && Object.keys(clearKeys).length > 0 ? { drm: { clearKeys } } : {}),
        });
        player.addEventListener('error', (evt) => {
          const detail = (evt as unknown as { detail?: { message?: string } })?.detail;
          if (detail) {
            setError(detail.message || 'Live Stream Offline');
            setLoading(false);
          }
        });
        await player.load(src, 0, 'application/dash+xml');
        await v.play().catch(() => undefined);
      } else if (kind === 'hls') {
        const Hls = (await import('hls.js')).default;
        if (destroyed) return;
        if (Hls.isSupported()) {
          const hls = new Hls({ enableWorker: true });
          hlsRef.current = hls;
          hls.attachMedia(v);
          hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(src));
          hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (data.fatal) {
              setError('Live Stream Offline');
              setLoading(false);
            }
          });
        } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
          v.src = src; // Safari native HLS
        } else {
          setError('HLS playback is not supported in this browser.');
          setLoading(false);
        }
      }
    })();

    return () => {
      destroyed = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (shakaRef.current) {
        const sp = shakaRef.current;
        shakaRef.current = null;
        try {
          void sp.destroy();
        } catch {
          /* ignore */
        }
      }
    };
  }, [src, kind, clearKeys]);

  const loadAttachments = useCallback(async () => {
    if (attachments !== null) return;
    if (!batchId || !videoId || !subjectId) {
      setAttachments([]);
      return;
    }
    try {
      const res = await api.scheduleDetail(batchId, videoId, subjectId);
      const data = res.data as {
        topic?: string;
        homeworkIds?: Array<{ topic?: string; attachmentIds?: Array<{ baseUrl?: string; key?: string }> }>;
      } | undefined;
      const found: Attachment[] = [];
      const pushRef = (t: string, ref?: { baseUrl?: string; key?: string }) => {
        const url = imageUrl(ref);
        if (url) found.push({ title: t, url });
      };
      if (data && Array.isArray(data.homeworkIds)) {
        data.homeworkIds.forEach((hw) => {
          (hw.attachmentIds || []).forEach((att) => pushRef(hw.topic || 'Class Note', att));
        });
      }
      setAttachments(found);
    } catch {
      setAttachments([]);
    }
  }, [attachments, batchId, videoId, subjectId]);

  const scheduleHide = useCallback(() => {
    if (hideTimeout.current) clearTimeout(hideTimeout.current);
    setControlsHidden(false);
    hideTimeout.current = setTimeout(() => {
      const v = videoRef.current;
      if (v && !v.paused && !settingsOpen && !menuOpen && !activePanel) {
        setControlsHidden(true);
        setCenterVisible(false);
      }
    }, 3000);
  }, [settingsOpen, menuOpen, activePanel]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => undefined);
    else v.pause();
  }, []);

  const seek = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + delta));
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else el.requestFullscreen().catch(() => undefined);
  }, []);

  const cycleSpeed = useCallback(() => {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    if (videoRef.current) videoRef.current.playbackRate = SPEEDS[next];
  }, [speedIdx]);

  const seekToStart = useCallback(() => {
    if (videoRef.current) videoRef.current.currentTime = 0;
    setSettingsOpen(false);
  }, []);

  const openPanel = useCallback((panel: string) => {
    setMenuOpen(false);
    setActivePanel(panel);
    if (panel === 'attach-panel') loadAttachments();
  }, [loadAttachments]);

  const copyLink = useCallback(() => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
    setMenuOpen(false);
  }, []);

  const sendComment = useCallback(() => {
    const text = chatInput.trim();
    if (!text) return;
    setComments((c) => [...c, { name: 'You', text }]);
    setChatInput('');
  }, [chatInput]);

  const castVote = useCallback((idx: number) => {
    if (voted !== null) return;
    setVoted(idx);
    setVotes((v) => v.map((n, i) => (i === idx ? n + 1 : n)));
  }, [voted]);

  const goBack = useCallback(() => {
    if (window.history.length > 1) window.history.back();
    else window.close();
  }, []);

  useEffect(() => {
    scheduleHide();
    return () => {
      if (hideTimeout.current) clearTimeout(hideTimeout.current);
    };
  }, [scheduleHide]);

  const totalVotes = votes.reduce((a, b) => a + b, 0);
  const ytId = kind === 'youtube' ? youtubeId(src) : '';

  return (
    <div className="sb-live-root" ref={wrapperRef} onMouseMove={scheduleHide} onClick={scheduleHide}>
      <div className="video-wrapper">
        {kind === 'youtube' && ytId ? (
          <iframe
            src={`https://www.youtube.com/embed/${encodeURIComponent(ytId)}?autoplay=1&rel=0`}
            title={title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            style={{ width: '100%', height: '100%', border: 0 }}
          />
        ) : (
          <video
            ref={videoRef}
            playsInline
            onPlay={() => { setPlaying(true); scheduleHide(); }}
            onPause={() => { setPlaying(false); setCenterVisible(true); setControlsHidden(false); }}
            onLoadedMetadata={(e) => { e.currentTarget.playbackRate = SPEEDS[speedIdx]; }}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onCanPlay={() => { setLoading(false); }}
            onError={() => {
              if (src) {
                setError('Live Stream Offline');
                setLoading(false);
              }
            }}
          />
        )}

        {error ? (
          <div className="error-box">
            <i className="fas fa-video-slash" style={{ fontSize: '2rem', marginBottom: '10px' }}></i>
            <br />
            <span>{error}</span>
          </div>
        ) : null}

        {loading && !error && kind !== 'youtube' ? (
          <div className="loader-overlay">
            <div className="spinner-ring"></div>
            <div className="status-text">{status}</div>
            <div className="status-text" style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '8px' }}>{statusSub}</div>
          </div>
        ) : null}

        <div className={`controls-overlay ${controlsHidden ? 'hidden' : ''}`}>
          <div className="top-bar">
            <div className="top-left">
              <i className="fas fa-arrow-left back-btn" onClick={goBack}></i>
              <div className="live-badge"><i className="fas fa-circle" style={{ fontSize: '0.4rem' }}></i> LIVE</div>
              <div className="video-title">{title}</div>
            </div>
            <div className="top-icons">
              <i className="fas fa-ellipsis-v icon-btn" onClick={() => setMenuOpen(true)}></i>
            </div>
          </div>

          {kind !== 'youtube' ? (
            <>
              <div className="center-area" onClick={togglePlay}>
                {centerVisible ? (
                  <div className={`play-pause-center ${playing ? '' : 'paused'}`}>
                    <i className={`fas ${playing ? 'fa-pause' : 'fa-play'}`}></i>
                  </div>
                ) : null}
              </div>

              <div className="bottom-gradient">
                <div className="time-display">
                  <span>{formatTime(currentTime)}</span> / <span>LIVE</span>
                </div>

                <div className="progress-wrapper">
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: playing ? '100%' : '0%' }}></div>
                  </div>
                </div>

                <div className="controls-row">
                  <div className="controls-left">
                    <div className="play-btn" onClick={togglePlay}>
                      <i className={`fas ${playing ? 'fa-pause' : 'fa-play'}`}></i>
                    </div>
                    <div className="skip-btn" onClick={() => seek(-10)}>
                      <i className="fas fa-undo-alt"></i>
                      <span className="skip-text">10</span>
                    </div>
                    <div className="skip-btn" onClick={() => seek(10)}>
                      <i className="fas fa-redo-alt"></i>
                      <span className="skip-text">10</span>
                    </div>
                    <div className="vol-btn" onClick={toggleMute}>
                      <i className={`fas ${muted ? 'fa-volume-mute' : 'fa-volume-up'}`}></i>
                    </div>
                  </div>
                  <div className="controls-right">
                    <div className="gear-btn" onClick={() => setSettingsOpen((s) => !s)}>
                      <i className="fas fa-cog"></i>
                    </div>
                    <div className="fullscreen-btn" onClick={toggleFullscreen}>
                      <i className="fas fa-expand"></i>
                    </div>
                  </div>
                </div>
              </div>

              <div className={`settings-float ${settingsOpen ? 'active' : ''}`}>
                <div className="float-item" onClick={seekToStart}>
                  <span><i className="fas fa-history text-danger"></i> Watch from Start</span>
                </div>
                <div className="float-item" onClick={cycleSpeed}>
                  <span>Speed</span>
                  <span className="float-val">{SPEEDS[speedIdx]}x <i className="fas fa-chevron-right" style={{ marginLeft: 4 }}></i></span>
                </div>
              </div>
            </>
          ) : null}

          <div className={`sheet-overlay ${menuOpen || activePanel ? 'active' : ''}`} onClick={() => { setMenuOpen(false); setActivePanel(null); }}>
            {/* Main menu */}
            <div className={`bottom-sheet show ${menuOpen ? '' : 'display-none'}`} style={{ display: menuOpen ? 'flex' : 'none' }} onClick={(e) => e.stopPropagation()}>
              <div className="sheet-handle-wrap"><div className="sheet-handle"></div></div>
              <ul className="menu-list" style={{ marginTop: 8 }}>
                <li className="menu-item" onClick={() => openPanel('chat-panel')}><i className="far fa-comment-dots menu-icon"></i> Live Chat</li>
                <li className="menu-item" onClick={() => openPanel('polls-panel')}><i className="fas fa-poll menu-icon"></i> Live Polls</li>
                <li className="menu-item" onClick={() => openPanel('attach-panel')}><i className="fas fa-paperclip menu-icon"></i> Attachments / Notes</li>
                <li className="menu-item" onClick={copyLink}><i className="fas fa-link menu-icon"></i>{copied ? ' Link Copied!' : ' Copy Link'}</li>
              </ul>
            </div>

            {/* Chat panel */}
            <div className="bottom-sheet show" style={{ display: activePanel === 'chat-panel' ? 'flex' : 'none', height: '60vh' }} onClick={(e) => e.stopPropagation()}>
              <div className="sheet-handle-wrap"><div className="sheet-handle"></div></div>
              <div className="sheet-header">Live Chat <i className="fas fa-times close-sheet" onClick={() => setActivePanel(null)}></i></div>
              <div className="chat-area">
                {comments.map((c, i) => (
                  <div className="comment-box" key={i}>
                    <div className="c-name">{c.name}</div>
                    <div className="c-text">{c.text}</div>
                  </div>
                ))}
              </div>
              <div className="chat-input-row">
                <input
                  className="chat-input"
                  placeholder="Say something..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') sendComment(); }}
                />
                <button className="chat-send" onClick={sendComment}>Send</button>
              </div>
            </div>

            {/* Polls panel */}
            <div className="bottom-sheet show" style={{ display: activePanel === 'polls-panel' ? 'flex' : 'none', height: 'auto' }} onClick={(e) => e.stopPropagation()}>
              <div className="sheet-handle-wrap"><div className="sheet-handle"></div></div>
              <div className="sheet-header">Live Polls <i className="fas fa-times close-sheet" onClick={() => setActivePanel(null)}></i></div>
              <div className="sheet-content">
                <div className="poll-card">
                  <div className="poll-q">{POLL.q}</div>
                  {POLL.options.map((opt, i) => {
                    const pct = totalVotes ? Math.round((votes[i] / totalVotes) * 100) : 0;
                    return (
                      <div key={i} className={`poll-opt ${voted === i ? 'voted' : ''}`} onClick={() => castVote(i)}>
                        {voted !== null ? <div className="poll-bar" style={{ width: `${pct}%` }}></div> : null}
                        <span className="label">{opt}</span>
                        {voted !== null ? <span className="pct">{pct}%</span> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Attachments panel */}
            <div className="bottom-sheet show" style={{ display: activePanel === 'attach-panel' ? 'flex' : 'none', height: '60vh' }} onClick={(e) => e.stopPropagation()}>
              <div className="sheet-handle-wrap"><div className="sheet-handle"></div></div>
              <div className="sheet-header">Attachments <i className="fas fa-times close-sheet" onClick={() => setActivePanel(null)}></i></div>
              <div className="sheet-content">
                {attachments === null ? (
                  <div className="status-text" style={{ color: '#6b7280', padding: '40px 0' }}>Loading Attachments...</div>
                ) : attachments.length === 0 ? (
                  <div className="status-text" style={{ color: '#6b7280', padding: '40px 0' }}>No attachments for this class.</div>
                ) : (
                  attachments.map((att, i) => (
                    <div className="attach-row" key={i}>
                      <div className="attach-title"><i className="fas fa-file-pdf" style={{ color: '#ef4444' }}></i> {att.title}</div>
                      <button className="attach-btn" onClick={() => window.open(att.url, '_blank')}>View</button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LivePage() {
  return (
    <Suspense fallback={
      <div className="sb-live-root">
        <div className="video-wrapper">
          <div className="loader-overlay">
            <div className="spinner-ring"></div>
            <div className="status-text">Connecting to Live Server...</div>
          </div>
        </div>
      </div>
    }>
      <LiveInner />
    </Suspense>
  );
}
