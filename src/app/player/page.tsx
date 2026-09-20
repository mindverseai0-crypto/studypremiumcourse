'use client';

// Study Bison video player — plays the REAL PW lectures resolved through
// parcham_vid: DASH (ClearKey via dash.js), HLS (hls.js), YouTube embeds and
// plain mp4. Faithful port of the original player.html UI.
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type HlsType from 'hls.js';
import type ShakaNamespace from 'shaka-player';
import './player.css';
import { api } from '@/lib/api-client';
import { addXP } from '@/lib/local-state';
import { isHlsUrl, isMpdUrl, youtubeId } from '@/lib/video-utils';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

type PlayerKind = '' | 'dash' | 'hls' | 'youtube' | 'mp4';

function formatTime(t: number): string {
  if (!isFinite(t) || t < 0) return '00:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function PlayerInner() {
  const params = useSearchParams();
  const videoId = params.get('videoId') || params.get('vId') || '';
  const batchId = params.get('batchId') || '';
  const subjectId = params.get('subjectId') || params.get('SubjectId') || '';
  const title = params.get('title') || 'PW Lecture';
  const vUrl = params.get('vUrl') || '';
  // real PW video id (videoDetails._id) when it differs from the schedule id
  const realVideoId = params.get('lectureVideoId') || '';
  // Study Ratna embed — render their play.php player in an iframe
  const srUrl = params.get('srUrl') || '';
  const isSrEmbed = Boolean(srUrl);

  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const xpGiven = useRef(false);
  const hlsRef = useRef<HlsType | null>(null);
  const shakaRef = useRef<ShakaNamespace.Player | null>(null);

  const [kind, setKind] = useState<PlayerKind>('');
  const [src, setSrc] = useState('');
  const [clearKeys, setClearKeys] = useState<Record<string, string> | null>(null);
  const [poster, setPoster] = useState('');
  const [status, setStatus] = useState('Processing Stream...');
  const [statusSub, setStatusSub] = useState('Preparing Secure Stream');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [centerVisible, setCenterVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(2);
  const [copied, setCopied] = useState(false);
  const [sigInput, setSigInput] = useState('');
  const [sigBusy, setSigBusy] = useState(false);
  const [sigMsg, setSigMsg] = useState('');

  // ------------------------------------------------------------------
  // Resolve the playable payload.
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError('');
      setDuration(0);
      setCurrentTime(0);
      xpGiven.current = false;
      if (vUrl && !/\.cloudfront\.net/i.test(vUrl)) {
        // direct URL (mp4 / m3u8 / mpd / youtube) — non-CloudFront hosts only;
        // CloudFront folders must be signed server-side via parcham_vid.
        setSrc(vUrl);
        if (isMpdUrl(vUrl)) setKind('dash');
        else if (isHlsUrl(vUrl)) setKind('hls');
        else if (/youtube\.com|youtu\.be/i.test(vUrl)) setKind('youtube');
        else setKind('mp4');
        setStatus('Ready to play');
        setLoading(false);
        return;
      }
      if (!videoId) {
        setError('Missing URL Parameters.');
        setLoading(false);
        return;
      }
      setStatus('Fetching lecture...');
      setStatusSub('Resolving secure stream');
      try {
        const res = await api.videoPayload(videoId, batchId, subjectId, vUrl, realVideoId);
        if (cancelled) return;
        if (!res.success || !res.data || !res.data.url) {
          throw new Error(res.error || 'This lecture is not available right now.');
        }
        setKind(res.data.kind || 'mp4');
        setSrc(res.data.url);
        setClearKeys(res.data.clearKeys || null);
        setPoster(res.data.poster || '');
        setStatus('Ready to play');
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Playback Engine Failed');
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoId, batchId, subjectId, vUrl, realVideoId]);

  // ------------------------------------------------------------------
  // Attach the source by kind.
  // ------------------------------------------------------------------
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !src) return;

    if (kind === 'youtube') return; // rendered as an iframe below

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
        setStatus('Loading DASH player...');
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
            setError(detail.message || 'Unable to decrypt/play this stream.');
            setLoading(false);
          }
        });
        await player.load(src, 0, 'application/dash+xml');
        await v.play().catch(() => undefined);
      } else if (kind === 'hls') {
        setStatus('Loading HLS stream...');
        const Hls = (await import('hls.js')).default;
        if (destroyed) return;
        if (Hls.isSupported()) {
          const hls = new Hls({ enableWorker: true });
          hlsRef.current = hls;
          hls.attachMedia(v);
          hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(src));
          hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (data.fatal) {
              setError('Unable to load the stream. Please try again.');
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

  const scheduleHide = useCallback(() => {
    if (hideTimeout.current) clearTimeout(hideTimeout.current);
    setControlsHidden(false);
    hideTimeout.current = setTimeout(() => {
      const v = videoRef.current;
      if (v && !v.paused && !settingsOpen && !menuOpen) {
        setControlsHidden(true);
        setCenterVisible(false);
      }
    }, 3000);
  }, [settingsOpen, menuOpen]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => undefined);
    else v.pause();
  }, []);

  const seek = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + delta));
  }, []);

  const seekToFraction = useCallback((frac: number) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    v.currentTime = frac * v.duration;
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

  const copyLink = useCallback(() => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
    setMenuOpen(false);
  }, []);

  const goBack = useCallback(() => {
    if (window.history.length > 1) window.history.back();
    else window.close();
  }, []);

  // ------------------------------------------------------------------
  // Recovery: register a pasted signed lecture URL and play it.
  // ------------------------------------------------------------------
  const submitSignature = useCallback(async () => {
    const url = sigInput.trim();
    if (!url || sigBusy) return;
    setSigBusy(true);
    setSigMsg('');
    try {
      const res = await fetch('/api/pw-register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const body = (await res.json()) as {
        success?: boolean;
        error?: string;
        kind?: string;
        relayUrl?: string;
        clearKeys?: Record<string, string> | null;
      };
      if (!res.ok || !body.success || !body.relayUrl) {
        throw new Error(body.error || 'This signed URL could not be registered.');
      }
      setError('');
      setSigMsg('');
      setSigInput('');
      setKind((body.kind as PlayerKind) || 'mp4');
      setSrc(body.relayUrl);
      setClearKeys(body.clearKeys || null);
      setPoster('');
      setStatus('Ready to play');
      setLoading(false);
    } catch (e) {
      setSigMsg(e instanceof Error ? e.message : 'Could not register this URL.');
    } finally {
      setSigBusy(false);
    }
  }, [sigInput, sigBusy]);

  // Auto-hide controls while playing
  useEffect(() => {
    scheduleHide();
    return () => {
      if (hideTimeout.current) clearTimeout(hideTimeout.current);
    };
  }, [scheduleHide]);

  const onProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    seekToFraction(Math.max(0, Math.min(1, frac)));
  };

  const isPwStream = kind === 'dash' || kind === 'hls';
  const ytId = kind === 'youtube' ? youtubeId(src) : '';

  if (isSrEmbed) {
    return (
      <div className="sb-player-root">
        <div className="video-wrapper">
          <iframe
            src={srUrl}
            title={title}
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen
            style={{ width: '100%', height: '100%', border: 0, background: '#000' }}
          />
          <div className="controls-overlay">
            <div className="top-bar">
              <div className="top-left">
                <i className="fas fa-arrow-left back-btn" onClick={goBack}></i>
                <div className="video-title">
                  {title}
                  <span style={{ background: '#ef4444', color: '#fff', fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.5px', padding: '2px 6px', borderRadius: 4, marginLeft: 8, verticalAlign: 'middle' }}>STUDY RATNA</span>
                </div>
              </div>
              <div className="top-icons">
                <i className="fas fa-expand icon-btn" onClick={toggleFullscreen}></i>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sb-player-root" ref={wrapperRef}
      onMouseMove={scheduleHide}
      onClick={scheduleHide}
    >
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
          // Preview-panel/extension scripts can tag <video> (e.g. class
          // "vq-video-detected") before React hydrates — suppress the
          // harmless attribute mismatch this causes.
          <video
            suppressHydrationWarning
            ref={videoRef}
            playsInline
            poster={poster || undefined}
            onPlay={() => { setPlaying(true); scheduleHide(); }}
            onPause={() => { setPlaying(false); setCenterVisible(true); setControlsHidden(false); }}
            onLoadedMetadata={(e) => {
              setDuration(e.currentTarget.duration || 0);
              e.currentTarget.playbackRate = SPEEDS[speedIdx];
            }}
            onTimeUpdate={(e) => {
              setCurrentTime(e.currentTarget.currentTime);
              // Award XP once when 90% watched
              if (!xpGiven.current && e.currentTarget.duration > 0 &&
                  e.currentTarget.currentTime / e.currentTarget.duration >= 0.9) {
                xpGiven.current = true;
                addXP(10, 'Watched Video');
              }
            }}
            onEnded={() => {
              setPlaying(false);
              if (!xpGiven.current) {
                xpGiven.current = true;
                addXP(10, 'Watched Video');
              }
            }}
            onCanPlay={() => { setLoading(false); }}
            onError={() => {
              if (src) {
                setError('Unable to load the stream. Please try again.');
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
            <div className="sig-recovery">
              <div className="sig-recovery-title">
                <i className="fas fa-key"></i> Have a signed lecture URL?
              </div>
              <p className="sig-recovery-hint">
                Paste the FULL signed URL (…/master.mpd?Signature=…&amp;Key-Pair-Id=…&amp;Policy=…) to unlock
                this stream. It is registered server-side and kept for future plays.
              </p>
              <input
                className="sig-recovery-input"
                type="url"
                value={sigInput}
                placeholder="https://…/master.mpd?Signature=…"
                onChange={(e) => setSigInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitSignature();
                }}
              />
              <button
                className="sig-recovery-btn"
                type="button"
                onClick={() => void submitSignature()}
                disabled={sigBusy || !sigInput.trim()}
              >
                {sigBusy ? (
                  <>
                    <i className="fas fa-spinner fa-spin"></i> Verifying…
                  </>
                ) : (
                  <>
                    <i className="fas fa-play"></i> Load Stream
                  </>
                )}
              </button>
              {sigMsg ? <div className="sig-recovery-msg">{sigMsg}</div> : null}
            </div>
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
              <div className="video-title">
                {title}
                {isPwStream ? (
                  <span style={{ background: '#FFB800', color: '#111827', fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.5px', padding: '2px 6px', borderRadius: 4, marginLeft: 8, verticalAlign: 'middle' }}>PW STREAM</span>
                ) : null}
              </div>
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
                  <span>{formatTime(currentTime)}</span> / <span>{formatTime(duration)}</span>
                </div>

                <div className="progress-wrapper" onClick={onProgressClick}>
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: duration ? `${(currentTime / duration) * 100}%` : '0%' }}></div>
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
                    <div className="gear-btn" onClick={() => { setSettingsOpen((s) => !s); }}>
                      <i className="fas fa-cog"></i>
                    </div>
                    <div className="fullscreen-btn" onClick={toggleFullscreen}>
                      <i className="fas fa-expand"></i>
                    </div>
                  </div>
                </div>
              </div>

              <div className={`settings-float ${settingsOpen ? 'active' : ''}`}>
                <div className="float-item" onClick={cycleSpeed}>
                  <span>Speed</span>
                  <span className="float-val">
                    {SPEEDS[speedIdx]}x <i className="fas fa-chevron-right" style={{ marginLeft: 4 }}></i>
                  </span>
                </div>
                {kind === 'dash' ? (
                  <div className="float-item" style={{ cursor: 'default' }}>
                    <span>Quality</span>
                    <span className="float-val">Auto (DASH)</span>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          <div className={`sheet-overlay ${menuOpen ? 'active' : ''}`} onClick={() => setMenuOpen(false)}>
            <div className="bottom-sheet show" onClick={(e) => e.stopPropagation()}>
              <div className="sheet-handle-wrap"><div className="sheet-handle"></div></div>
              <ul className="menu-list" style={{ marginTop: 8 }}>
                <li className="menu-item" onClick={copyLink}>
                  <i className="fas fa-link menu-icon"></i>
                  {copied ? 'Link Copied!' : 'Copy Link'}
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PlayerPage() {
  return (
    <Suspense fallback={
      <div className="sb-player-root">
        <div className="video-wrapper">
          <div className="loader-overlay">
            <div className="spinner-ring"></div>
            <div className="status-text">Loading Player...</div>
          </div>
        </div>
      </div>
    }>
      <PlayerInner />
    </Suspense>
  );
}
