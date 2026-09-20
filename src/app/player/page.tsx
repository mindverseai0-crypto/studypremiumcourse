'use client';

// Study Bison video player — PW-app style.
// Streams: DASH (ClearKey via shaka), HLS (hls.js), YouTube embeds, mp4.
// UI: minimal top bar (back + kebab), time + speed chip, buffered seek bar
// with scrub tooltip, control row (play · ±10s · volume ‖ comments · doubts ·
// slides · notes · settings · fullscreen) and a side panel / bottom sheet
// with Comments, Doubts, Slides, Notes and Attachments tabs.
// Backend: /api/player/interactions (comments+doubts, one-level replies) and
// /api/player/extras (slides/notes/attachments from the lecture schedule).
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type HlsType from 'hls.js';
import type ShakaNamespace from 'shaka-player';
import './player.css';
import { api } from '@/lib/api-client';
import { addXP } from '@/lib/local-state';
import { isHlsUrl, isMpdUrl, youtubeId } from '@/lib/video-utils';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

type PlayerKind = '' | 'dash' | 'hls' | 'youtube' | 'mp4';
type PanelTab = '' | 'comments' | 'doubts' | 'slides' | 'notes' | 'attachments';
type SheetView = '' | 'root' | 'speed' | 'quality';

interface ReplyItem {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  parentId: string | null;
}
interface TopItem extends ReplyItem {
  replies: ReplyItem[];
}
interface DocItem {
  name: string;
  url: string;
}

function formatTime(t: number): string {
  if (!isFinite(t) || t < 0) return '00:00';
  const s = Math.floor(t % 60);
  const m = Math.floor((t / 60) % 60);
  const h = Math.floor(t / 3600);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

/* Doubt (Q+A bubbles) icon — FA free has no Q&A glyph. */
function DoubtIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.8" y="3" width="13" height="10.5" rx="2.6" />
      <text x="8.3" y="10.9" fontSize="7.4" fontWeight="800" fill="currentColor" stroke="none" textAnchor="middle" fontFamily="Inter, sans-serif">Q</text>
      <path d="M4.5 13.5v3.2l3.4-3.2" />
      <rect x="12.6" y="11.2" width="9.6" height="8" rx="2.1" fill="#000" />
      <rect x="12.6" y="11.2" width="9.6" height="8" rx="2.1" />
      <text x="17.4" y="17" fontSize="5.6" fontWeight="800" fill="currentColor" stroke="none" textAnchor="middle" fontFamily="Inter, sans-serif">A</text>
    </svg>
  );
}

/* Slides icon — framed play (lecture deck). */
function SlidesIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.4" y="4.2" width="19.2" height="15.6" rx="2.6" />
      <path d="M10.2 9.1v5.8l5.2-2.9z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PlayerInner() {
  const params = useSearchParams();
  const videoId = params.get('videoId') || params.get('vId') || '';
  const batchId = params.get('batchId') || '';
  const subjectId = params.get('subjectId') || params.get('SubjectId') || '';
  // schedule item id (pw_sch_cntnt node id) — the correct upstream id for
  // slides/notes/attachments, more reliable than the lecture/video id
  const schId = params.get('schId') || '';
  const title = params.get('title') || 'PW Lecture';
  const vUrl = params.get('vUrl') || '';
  // real PW video id (videoDetails._id) when it differs from the schedule id
  const realVideoId = params.get('lectureVideoId') || '';
  // Study Ratna embed — render their play.php player in an iframe
  const srUrl = params.get('srUrl') || '';
  const isSrEmbed = Boolean(srUrl);

  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const xpGiven = useRef(false);
  const hlsRef = useRef<HlsType | null>(null);
  const shakaRef = useRef<ShakaNamespace.Player | null>(null);
  const scrubbing = useRef(false);

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
  const [buffered, setBuffered] = useState(0);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [centerVisible, setCenterVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsSheet, setSettingsSheet] = useState<SheetView>('');
  const [speedIdx, setSpeedIdx] = useState(2);
  const [copied, setCopied] = useState(false);
  const [sigInput, setSigInput] = useState('');
  const [sigBusy, setSigBusy] = useState(false);
  const [sigMsg, setSigMsg] = useState('');

  // player extras
  const [volume, setVolume] = useState(100);
  const [loop, setLoop] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const [seekFlash, setSeekFlash] = useState('');
  const [hoverFrac, setHoverFrac] = useState<number | null>(null);
  const [scrubFrac, setScrubFrac] = useState<number | null>(null);
  const [hlsLevels, setHlsLevels] = useState<Array<{ index: number; label: string }>>([]);
  const [dashList, setDashList] = useState<Array<{ id: number; height: number }>>([]);
  const [qualitySel, setQualitySel] = useState<'auto' | number>('auto');

  // side panel
  const [panel, setPanel] = useState<PanelTab>('');
  const [items, setItems] = useState<TopItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [draft, setDraft] = useState('');
  const [submitErr, setSubmitErr] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; author: string } | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [extras, setExtras] = useState<{ slides: DocItem[]; notes: DocItem[]; attachments: DocItem[] }>({ slides: [], notes: [], attachments: [] });
  const [extrasLoading, setExtrasLoading] = useState(false);
  const [extrasLoaded, setExtrasLoaded] = useState(false);
  const [viewingDoc, setViewingDoc] = useState<DocItem | null>(null);
  const extrasStarted = useRef(false);
  // PiP support can only be detected on the client — decide AFTER hydration,
  // otherwise the kebab sheet renders a different tree on server vs client
  // (recoverable hydration error on /player).
  const [pipAvailable, setPipAvailable] = useState(false);

  // ------------------------------------------------------------------
  // Identity of the discussion thread: stable per lecture.
  // ------------------------------------------------------------------
  const threadKey = useMemo(() => {
    if (videoId) return videoId;
    if (realVideoId) return realVideoId;
    if (vUrl) return `url:${vUrl.split('?')[0]}`;
    return 'player';
  }, [videoId, realVideoId, vUrl]);

  const panelType = panel === 'doubts' ? 'doubt' : 'comment';

  // ------------------------------------------------------------------
  // Resolve the playable payload.
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError('');
      setDuration(0);
      setCurrentTime(0);
      setBuffered(0);
      setHlsLevels([]);
      setDashList([]);
      setQualitySel('auto');
      setExtras({ slides: [], notes: [], attachments: [] });
      setExtrasLoaded(false);
      extrasStarted.current = false;
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
        // quality variants for the settings sheet
        const refreshTracks = () => {
          try {
            const p = shakaRef.current;
            if (!p) return;
            const tracks = p.getVariantTracks().filter((t) => t.height);
            tracks.sort((a, b) => b.height - a.height);
            const seen = new Set<number>();
            const list: Array<{ id: number; height: number }> = [];
            for (const t of tracks) {
              if (!seen.has(t.height)) {
                seen.add(t.height);
                list.push({ id: t.id, height: t.height });
              }
            }
            setDashList(list);
          } catch {
            /* ignore */
          }
        };
        player.addEventListener('variantchanged', refreshTracks);
        player.addEventListener('adaptation', refreshTracks);
        await player.load(src, 0, 'application/dash+xml');
        refreshTracks();
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
          hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
            const seen = new Set<string>();
            const levels: Array<{ index: number; label: string }> = [];
            data.levels.forEach((l, i) => {
              const h = l.height || 0;
              // media playlists often carry no RESOLUTION — fall back to bitrate
              const label = h > 0
                ? `${h}p`
                : l.bitrate ? `${Math.round(l.bitrate / 1000)} kbps` : `Level ${i + 1}`;
              if (!seen.has(label)) {
                seen.add(label);
                levels.push({ index: i, label });
              }
            });
            setHlsLevels(levels);
          });
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

  // ------------------------------------------------------------------
  // Volume / loop persistence + application.
  // ------------------------------------------------------------------
  useEffect(() => {
    try {
      const sv = parseInt(window.localStorage.getItem('pw_volume') || '', 10);
      if (Number.isFinite(sv) && sv >= 0 && sv <= 100) setVolume(sv);
      const sn = window.localStorage.getItem('pw_display_name');
      if (sn) setDisplayName(sn);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.volume = volume / 100;
      if (volume > 0 && v.muted) {
        v.muted = false;
        setMuted(false);
      }
    }
  }, [volume, src, kind]);

  // Fullscreen icon state.
  useEffect(() => {
    const onFs = () => setIsFs(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Picture-in-picture feature detection must run post-hydration (client only).
  useEffect(() => {
    setPipAvailable(!isSrEmbed && document.pictureInPictureEnabled);
  }, [isSrEmbed]);

  const scheduleHide = useCallback(() => {
    if (hideTimeout.current) clearTimeout(hideTimeout.current);
    setControlsHidden(false);
    hideTimeout.current = setTimeout(() => {
      const v = videoRef.current;
      if (v && !v.paused && !settingsSheet && !menuOpen) {
        setControlsHidden(true);
        setCenterVisible(false);
      }
    }, 3000);
  }, [settingsSheet, menuOpen]);

  // Explicit affordance to bring the controls/options back after auto-hide.
  const showControls = useCallback(() => {
    setControlsHidden(false);
    setCenterVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => undefined);
    else v.pause();
  }, []);

  const flash = useCallback((label: string) => {
    setSeekFlash(label);
    if (flashTimeout.current) clearTimeout(flashTimeout.current);
    flashTimeout.current = setTimeout(() => setSeekFlash(''), 700);
  }, []);

  const seek = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + delta));
    flash(delta < 0 ? `−${Math.round(Math.abs(delta))}s` : `+${Math.round(delta)}s`);
  }, [flash]);

  const seekToFraction = useCallback((frac: number) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    v.currentTime = Math.max(0, Math.min(1, frac)) * v.duration;
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }, []);

  const changeVolume = useCallback((n: number) => {
    setVolume(n);
    try {
      window.localStorage.setItem('pw_volume', String(n));
    } catch {
      /* ignore */
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else el.requestFullscreen().catch(() => undefined);
  }, []);

  const togglePip = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        void document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled && v.requestPictureInPicture) {
        void v.requestPictureInPicture().catch(() => undefined);
      }
    } catch {
      /* unsupported */
    }
    setMenuOpen(false);
  }, []);

  const selectSpeed = useCallback((idx: number) => {
    setSpeedIdx(idx);
    if (videoRef.current) videoRef.current.playbackRate = SPEEDS[idx];
  }, []);

  const selectHlsQuality = useCallback((sel: 'auto' | number) => {
    setQualitySel(sel);
    const hls = hlsRef.current;
    if (!hls) return;
    try {
      hls.currentLevel = sel === 'auto' ? -1 : sel;
    } catch {
      /* ignore */
    }
  }, []);

  const selectDashQuality = useCallback((sel: 'auto' | number) => {
    setQualitySel(sel);
    const p = shakaRef.current;
    if (!p) return;
    try {
      if (sel === 'auto') {
        p.configure({ abr: { enabled: true } });
      } else {
        const track = p.getVariantTracks().find((t) => t.id === sel);
        if (track) {
          p.configure({ abr: { enabled: false } });
          p.selectVariantTrack(track, true);
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  const copyLink = useCallback(() => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  }, []);

  const goBack = useCallback(() => {
    if (window.history.length > 1) window.history.back();
    else window.close();
  }, []);

  // ------------------------------------------------------------------
  // Keyboard shortcuts (ignored while typing).
  // ------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft') {
        seek(-5);
      } else if (e.key === 'ArrowRight') {
        seek(5);
      } else if (e.key === 'm') {
        toggleMute();
      } else if (e.key === 'f') {
        toggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seek, toggleMute, toggleFullscreen]);

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

  // ------------------------------------------------------------------
  // Side panel — interactions (comments / doubts).
  // ------------------------------------------------------------------
  const loadItems = useCallback(async (type: 'comment' | 'doubt') => {
    setListLoading(true);
    setSubmitErr('');
    try {
      const res = await fetch(`/api/player/interactions?threadKey=${encodeURIComponent(threadKey)}&type=${type}`);
      const body = (await res.json()) as { success?: boolean; items?: TopItem[] };
      setItems(body.success && Array.isArray(body.items) ? body.items : []);
    } catch {
      setItems([]);
    } finally {
      setListLoading(false);
    }
  }, [threadKey]);

  // ------------------------------------------------------------------
  // Docs (slides / notes / attachments) — fetched once per lecture.
  // scheduleId priority: schId (pw_sch_cntnt node) → videoId → realVideoId.
  // ------------------------------------------------------------------
  const loadExtras = useCallback(() => {
    if (extrasStarted.current) return;
    extrasStarted.current = true;
    setExtrasLoading(true);
    const q = new URLSearchParams({
      batchId,
      scheduleId: schId || videoId || realVideoId,
      subjectId,
      videoId: realVideoId,
    });
    fetch(`/api/player/extras?${q.toString()}`)
      .then((r) => r.json())
      .then((body: { success?: boolean; slides?: DocItem[]; notes?: DocItem[]; attachments?: DocItem[] }) => {
        setExtras({
          slides: Array.isArray(body.slides) ? body.slides : [],
          notes: Array.isArray(body.notes) ? body.notes : [],
          attachments: Array.isArray(body.attachments) ? body.attachments : [],
        });
        setExtrasLoaded(true);
      })
      .catch(() => {
        extrasStarted.current = false; // allow a retry on the next open
        setExtrasLoaded(true);
      })
      .finally(() => setExtrasLoading(false));
  }, [batchId, schId, videoId, realVideoId, subjectId]);

  // Prefetch docs for EVERY lecture so Slides/Notes/Attachments tabs are
  // populated (with counts) without requiring the user to open them first.
  useEffect(() => {
    if (isSrEmbed || kind === 'youtube') return;
    if (!batchId || !(schId || videoId || realVideoId)) return;
    loadExtras();
  }, [loadExtras, batchId, schId, videoId, realVideoId, isSrEmbed, kind]);

  const openPanel = useCallback((tab: PanelTab) => {
    setPanel(tab);
    setViewingDoc(null);
    setReplyTo(null);
    setDraft('');
    setSubmitErr('');
    if (tab === 'comments' || tab === 'doubts') {
      setItems([]);
      void loadItems(tab === 'doubts' ? 'doubt' : 'comment');
    } else if (tab === 'slides' || tab === 'notes' || tab === 'attachments') {
      if (!extrasLoaded) loadExtras();
    }
  }, [loadItems, extrasLoaded, loadExtras]);

  const closePanel = useCallback(() => {
    setPanel('');
    setViewingDoc(null);
  }, []);

  // keep the discussion list pinned to the newest message
  useEffect(() => {
    if ((panel === 'comments' || panel === 'doubts') && !listLoading && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [panel, items, listLoading]);

  const submitPost = useCallback(async () => {
    const text = draft.trim();
    if (!text || posting) return;
    setPosting(true);
    setSubmitErr('');
    try {
      const res = await fetch('/api/player/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadKey,
          type: panelType,
          text,
          author: displayName.trim() || 'Student',
          parentId: replyTo?.id || undefined,
        }),
      });
      const body = (await res.json()) as { success?: boolean; error?: string; item?: ReplyItem };
      if (!res.ok || !body.success || !body.item) {
        throw new Error(body.error || 'Could not post. Try again.');
      }
      const item = body.item;
      if (replyTo) {
        setItems((prev) => prev.map((it) => (it.id === replyTo.id ? { ...it, replies: [...it.replies, item] } : it)));
      } else {
        setItems((prev) => [...prev, { ...item, parentId: null, replies: [] }]);
      }
      setDraft('');
      setReplyTo(null);
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : 'Could not post. Try again.');
    } finally {
      setPosting(false);
    }
  }, [draft, posting, threadKey, panelType, displayName, replyTo]);

  const saveName = useCallback(() => {
    const n = nameDraft.trim().slice(0, 40);
    setDisplayName(n);
    try {
      if (n) window.localStorage.setItem('pw_display_name', n);
      else window.localStorage.removeItem('pw_display_name');
    } catch {
      /* ignore */
    }
    setNameEditing(false);
  }, [nameDraft]);

  // ------------------------------------------------------------------
  // Progress scrubbing (pointer events — click + drag).
  // ------------------------------------------------------------------
  const fracFromEvent = (e: React.PointerEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  };

  const onScrubStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubbing.current = true;
    e.currentTarget.classList.add('scrubbing');
    const f = fracFromEvent(e);
    setScrubFrac(f);
    seekToFraction(f);
  };
  const onScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const f = fracFromEvent(e);
    if (scrubbing.current) {
      setScrubFrac(f);
      seekToFraction(f);
    } else {
      setHoverFrac(f);
    }
  };
  const onScrubEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    scrubbing.current = false;
    e.currentTarget.classList.remove('scrubbing');
    setScrubFrac(null);
  };

  const displayFrac = duration > 0 ? (scrubFrac ?? currentTime / duration) : 0;
  const tipFrac = scrubFrac ?? hoverFrac;
  const isPwStream = kind === 'dash' || kind === 'hls';
  const ytId = kind === 'youtube' ? youtubeId(src) : '';
  const panelsEnabled = !isSrEmbed && kind !== 'youtube';

  const qualityOptions: Array<{ key: 'auto' | number; label: string }> = useMemo(() => {
    if (kind === 'hls') return [{ key: 'auto', label: 'Auto' }, ...hlsLevels.map((l) => ({ key: l.index as 'auto' | number, label: l.label }))];
    if (kind === 'dash') return [{ key: 'auto', label: 'Auto' }, ...dashList.map((d) => ({ key: d.id as 'auto' | number, label: `${d.height}p` }))];
    return [{ key: 'auto', label: 'Auto' }];
  }, [kind, hlsLevels, dashList]);

  const selectQuality = useCallback((sel: 'auto' | number) => {
    if (kind === 'hls') selectHlsQuality(sel);
    else if (kind === 'dash') selectDashQuality(sel);
    setSettingsSheet('quality');
  }, [kind, selectHlsQuality, selectDashQuality]);

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
      <h1 className="sr-only-player">{title}</h1>
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
            loop={loop}
            poster={poster || undefined}
            onPlay={() => { setPlaying(true); scheduleHide(); }}
            onPause={() => { setPlaying(false); setCenterVisible(true); setControlsHidden(false); }}
            onLoadedMetadata={(e) => {
              setDuration(e.currentTarget.duration || 0);
              e.currentTarget.playbackRate = SPEEDS[speedIdx];
              e.currentTarget.volume = volume / 100;
            }}
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              setCurrentTime(v.currentTime);
              try {
                if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
              } catch { /* ignore */ }
              // Award XP once when 90% watched
              if (!xpGiven.current && v.duration > 0 && v.currentTime / v.duration >= 0.9) {
                xpGiven.current = true;
                addXP(10, 'Watched Video');
              }
            }}
            onProgress={(e) => {
              const v = e.currentTarget;
              try {
                if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
              } catch { /* ignore */ }
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

        {/* ---------------- side panel / bottom sheet ---------------- */}
        {panel && panelsEnabled ? (
          <aside className="sb-panel" onClick={(e) => e.stopPropagation()}>
            {viewingDoc ? (
              <div className="pdf-view">
                <div className="pdf-view-head">
                  <button className="panel-close" style={{ marginLeft: 0 }} aria-label="Back to list" onClick={() => setViewingDoc(null)}>
                    <i className="fas fa-chevron-left"></i>
                  </button>
                  <div className="pdf-view-name">{viewingDoc.name}</div>
                  <a className="doc-btn" href={viewingDoc.url} target="_blank" rel="noreferrer">
                    <i className="fas fa-external-link-alt" style={{ fontSize: '0.65rem' }}></i> Open
                  </a>
                </div>
                <iframe className="pdf-frame" src={viewingDoc.url} title={viewingDoc.name} />
              </div>
            ) : (
              <>
                <div className="panel-head">
                  <button className={`panel-tab ${panel === 'comments' ? 'active' : ''}`} onClick={() => openPanel('comments')}>Comments</button>
                  <button className={`panel-tab ${panel === 'doubts' ? 'active' : ''}`} onClick={() => openPanel('doubts')}>Doubts</button>
                  <button className={`panel-tab ${panel === 'slides' ? 'active' : ''}`} onClick={() => openPanel('slides')}>
                    Slides{extras.slides.length > 0 ? <span className="tab-count">{extras.slides.length}</span> : null}
                  </button>
                  <button className={`panel-tab ${panel === 'notes' ? 'active' : ''}`} onClick={() => openPanel('notes')}>
                    Notes{extras.notes.length > 0 ? <span className="tab-count">{extras.notes.length}</span> : null}
                  </button>
                  <button className={`panel-tab ${panel === 'attachments' ? 'active' : ''}`} onClick={() => openPanel('attachments')}>
                    Attach{extras.attachments.length > 0 ? <span className="tab-count">{extras.attachments.length}</span> : null}
                  </button>
                  <button className="panel-close" aria-label="Close panel" onClick={closePanel}>
                    <i className="fas fa-times"></i>
                  </button>
                </div>

                {(panel === 'comments' || panel === 'doubts') ? (
                  <div className="panel-body">
                    <div className="panel-list" ref={listRef}>
                      {listLoading ? (
                        <div className="panel-loading"><i className="fas fa-spinner fa-spin"></i> Loading…</div>
                      ) : items.length === 0 ? (
                        <div className="panel-empty">
                          {panel === 'doubts' ? <DoubtIcon /> : <i className="far fa-comment-dots"></i>}
                          <div className="pe-title">{panel === 'doubts' ? 'No doubts yet' : 'No comments yet'}</div>
                          <div className="pe-sub">
                            {panel === 'doubts'
                              ? 'Stuck somewhere in this lecture? Ask your doubt below and get it cleared.'
                              : 'Be the first to share your thoughts on this lecture.'}
                          </div>
                        </div>
                      ) : (
                        <>
                          {items.map((it) => (
                            <div key={it.id}>
                              <div className="cm">
                                <div className="cm-avatar">{(it.author || 'S').charAt(0)}</div>
                                <div className="cm-main">
                                  <div className="cm-top">
                                    <span className="cm-name">{it.author || 'Student'}</span>
                                    <span className="cm-time">{timeAgo(it.createdAt)}</span>
                                  </div>
                                  <div className="cm-text">{it.text}</div>
                                  <div className="cm-actions">
                                    <button className="cm-act" onClick={() => { setReplyTo({ id: it.id, author: it.author || 'Student' }); }}>Reply</button>
                                  </div>
                                </div>
                              </div>
                              {it.replies.length > 0 ? (
                                <>
                                  <div className="cm-replies">
                                    {it.replies.map((r) => (
                                      <div className="cm" key={r.id}>
                                        <div className="cm-avatar sm">{(r.author || 'S').charAt(0)}</div>
                                        <div className="cm-main">
                                          <div className="cm-top">
                                            <span className="cm-name">{r.author || 'Student'}</span>
                                            <span className="cm-time">{timeAgo(r.createdAt)}</span>
                                          </div>
                                          <div className="cm-text">{r.text}</div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </>
                              ) : null}
                            </div>
                          ))}
                          <div className="list-end">You&apos;re all caught up</div>
                        </>
                      )}
                    </div>
                    <div className="composer-wrap">
                      {replyTo ? (
                        <div className="reply-chip">
                          <span>Replying to <b>@{replyTo.author}</b></span>
                          <span className="reply-x" onClick={() => setReplyTo(null)} role="button" aria-label="Cancel reply">✕</span>
                        </div>
                      ) : null}
                      <div className="name-row">
                        {nameEditing ? (
                          <>
                            <input
                              className="name-edit-input"
                              value={nameDraft}
                              placeholder="Your name"
                              maxLength={40}
                              autoFocus
                              onChange={(e) => setNameDraft(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }}
                            />
                            <button className="name-edit-btn" onClick={saveName}>Save</button>
                          </>
                        ) : (
                          <>
                            <span>Commenting as <b style={{ color: '#9ca3af' }}>{displayName || 'Student'}</b></span>
                            <button className="name-edit-btn" onClick={() => { setNameDraft(displayName); setNameEditing(true); }}>Edit</button>
                          </>
                        )}
                      </div>
                      {submitErr ? (
                        <div className="name-row" style={{ color: '#f87171' }}>{submitErr}</div>
                      ) : null}
                      <div className="composer">
                        <input
                          value={draft}
                          placeholder={panel === 'doubts' ? 'Have a doubt? Ask here…' : 'Add a comment…'}
                          maxLength={2000}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitPost(); } }}
                        />
                        <button className="send-btn" aria-label="Send" disabled={!draft.trim() || posting} onClick={() => void submitPost()}>
                          <i className={`fas ${posting ? 'fa-spinner fa-spin' : 'fa-paper-plane'}`}></i>
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="panel-body">
                    {extrasLoading ? (
                      <div className="panel-loading"><i className="fas fa-spinner fa-spin"></i> Loading…</div>
                    ) : (
                      <>
                        {panel === 'slides' && extras.slides.length === 0 ? (
                          <div className="panel-empty">
                            <SlidesIcon />
                            <div className="pe-title">No slides</div>
                            <div className="pe-sub">Slides shared by the educator for this lecture will appear here.</div>
                          </div>
                        ) : null}
                        {panel === 'notes' && extras.notes.length === 0 ? (
                          <div className="panel-empty">
                            <i className="far fa-file-pdf"></i>
                            <div className="pe-title">No notes</div>
                            <div className="pe-sub">Class notes for this lecture will appear here.</div>
                          </div>
                        ) : null}
                        {panel === 'attachments' && extras.attachments.length === 0 ? (
                          <div className="panel-empty">
                            <i className="fas fa-paperclip"></i>
                            <div className="pe-title">No attachments</div>
                            <div className="pe-sub">DPPs and other resources will appear here.</div>
                          </div>
                        ) : null}
                        {(panel === 'slides' ? extras.slides : panel === 'notes' ? extras.notes : extras.attachments).length > 0 ? (
                          <div className="panel-list">
                            {(panel === 'slides' ? extras.slides : panel === 'notes' ? extras.notes : extras.attachments).map((d) => (
                              <div className="doc-item" key={d.url}>
                                <i className="far fa-file-pdf doc-icon"></i>
                                <div className="doc-name">{d.name || 'Document'}</div>
                                <button className="doc-btn primary" onClick={() => setViewingDoc(d)}>View</button>
                                <a className="doc-btn" href={d.url} target="_blank" rel="noreferrer">Open</a>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </aside>
        ) : null}

        {/* -------- restore affordance: bring the player controls and
             the options (comments, doubts, slides, notes…) back after
             they auto-hide during playback -------- */}
        {controlsHidden && !error && !isSrEmbed ? (
          <button
            className="controls-restore"
            aria-label="Show player controls and options"
            title="Show controls"
            onClick={(e) => { e.stopPropagation(); showControls(); }}
          >
            <i className="fas fa-sliders"></i>
          </button>
        ) : null}

        <div className={`controls-overlay ${controlsHidden ? 'hidden' : ''}`}>
          <div className="top-bar">
            <div className="top-left">
              <i className="fas fa-arrow-left back-btn" onClick={goBack} role="button" aria-label="Back"></i>
            </div>
            <div className="top-icons">
              <i className="fas fa-ellipsis-v icon-btn" onClick={(e) => { e.stopPropagation(); setMenuOpen(true); }} role="button" aria-label="More options"></i>
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

              {seekFlash ? <div className="seek-flash">{seekFlash}</div> : null}

              <div className="bottom-gradient">
                <div className="time-row">
                  <span>{formatTime(currentTime)}</span>
                  <button className="speed-chip" onClick={(e) => { e.stopPropagation(); setSettingsSheet('speed'); }}>
                    {SPEEDS[speedIdx]}x
                  </button>
                  <span className="time-dur">{formatTime(duration)}</span>
                </div>

                <div
                  className="progress-wrapper"
                  onPointerDown={onScrubStart}
                  onPointerMove={onScrubMove}
                  onPointerUp={onScrubEnd}
                  onPointerCancel={onScrubEnd}
                  onPointerLeave={() => { if (!scrubbing.current) setHoverFrac(null); }}
                  role="slider"
                  aria-label="Seek"
                  aria-valuemin={0}
                  aria-valuemax={Math.round(duration)}
                  aria-valuenow={Math.round(currentTime)}
                >
                  <div className="progress-track">
                    <div className="progress-buffered" style={{ width: duration ? `${Math.min(100, (buffered / duration) * 100)}%` : '0%' }}></div>
                    <div className="progress-fill" style={{ width: `${displayFrac * 100}%` }}></div>
                  </div>
                  <div className="progress-thumb" style={{ left: `${displayFrac * 100}%` }}></div>
                  {tipFrac !== null && duration > 0 ? (
                    <div className="progress-tip" style={{ left: `${tipFrac * 100}%` }}>{formatTime(tipFrac * duration)}</div>
                  ) : null}
                </div>

                <div className="controls-row">
                  <div className="controls-left">
                    <button className="c-btn play-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
                      <i className={`fas ${playing ? 'fa-pause' : 'fa-play'}`}></i>
                    </button>
                    <button className="c-btn skip-btn" aria-label="Back 10 seconds" onClick={() => seek(-10)}>
                      <i className="fas fa-rotate-left"></i>
                      <span className="skip-text">10</span>
                    </button>
                    <button className="c-btn skip-btn" aria-label="Forward 10 seconds" onClick={() => seek(10)}>
                      <i className="fas fa-rotate-right"></i>
                      <span className="skip-text">10</span>
                    </button>
                    <div className="vol-wrap">
                      <button className="c-btn vol-btn" aria-label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
                        <i className={`fas ${muted || volume === 0 ? 'fa-volume-mute' : volume < 50 ? 'fa-volume-down' : 'fa-volume-up'}`}></i>
                      </button>
                      <div className="vol-pop" onClick={(e) => e.stopPropagation()}>
                        <input
                          className="vol-range"
                          type="range"
                          min={0}
                          max={100}
                          value={volume}
                          aria-label="Volume"
                          onChange={(e) => changeVolume(Number(e.target.value))}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="controls-right">
                    {panelsEnabled ? (
                      <>
                        <button className="c-btn panel-btn" aria-label="Comments" title="Comments" onClick={(e) => { e.stopPropagation(); openPanel('comments'); }}>
                          <i className="far fa-comment-dots"></i>
                        </button>
                        <button className="c-btn panel-btn" aria-label="Doubts" title="Doubts" onClick={(e) => { e.stopPropagation(); openPanel('doubts'); }}>
                          <DoubtIcon />
                        </button>
                        <button className="c-btn panel-btn" aria-label="Slides" title="Slides" onClick={(e) => { e.stopPropagation(); openPanel('slides'); }}>
                          <SlidesIcon />
                        </button>
                        <button className="c-btn panel-btn" aria-label="Notes" title="Notes" onClick={(e) => { e.stopPropagation(); openPanel('notes'); }}>
                          <i className="far fa-edit"></i>
                        </button>
                      </>
                    ) : null}
                    <button className="c-btn gear-btn" aria-label="Settings" onClick={(e) => { e.stopPropagation(); setSettingsSheet('root'); }}>
                      <i className="fas fa-cog"></i>
                    </button>
                    <button className="c-btn fullscreen-btn" aria-label={isFs ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen}>
                      <i className={`fas ${isFs ? 'fa-compress' : 'fa-expand'}`}></i>
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : null}

        </div>

        {/* -------- settings sheet (gear / speed chip) — outside the
             controls overlay so it stacks above the error box -------- */}
          <div
            className={`sheet-overlay ${settingsSheet ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setSettingsSheet(''); }}
          >
            <div className="sb-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="sheet-handle-wrap"><div className="sheet-handle"></div></div>

              {settingsSheet === 'root' ? (
                <>
                  <div className="sheet-title"><i className="fas fa-cog" style={{ color: '#9ca3af' }}></i> Playback settings</div>
                  <div className="sheet-row" onClick={() => setSettingsSheet('speed')}>
                    <span className="row-icon"><i className="fas fa-gauge-high"></i></span>
                    <span>Playback speed</span>
                    <span className="row-val">{SPEEDS[speedIdx]}x <i className="fas fa-chevron-right" style={{ fontSize: '0.65rem' }}></i></span>
                  </div>
                  <div className={`sheet-row ${isPwStream ? '' : 'disabled'}`} onClick={() => { if (isPwStream) setSettingsSheet('quality'); }}>
                    <span className="row-icon"><i className="fas fa-sliders"></i></span>
                    <span>Quality</span>
                    <span className="row-val">
                      {qualityOptions.find((q) => q.key === qualitySel)?.label || 'Auto'}
                      <i className="fas fa-chevron-right" style={{ fontSize: '0.65rem' }}></i>
                    </span>
                  </div>
                  <div className="sheet-row" onClick={() => setLoop((l) => !l)}>
                    <span className="row-icon"><i className="fas fa-repeat"></i></span>
                    <span>Loop</span>
                    {loop ? <span className="row-check"><i className="fas fa-check"></i></span> : <span className="row-val">Off</span>}
                  </div>
                </>
              ) : null}

              {settingsSheet === 'speed' ? (
                <>
                  <div className="sheet-title">
                    <span className="sheet-back" onClick={() => setSettingsSheet('root')} role="button" aria-label="Back"><i className="fas fa-arrow-left"></i></span>
                    Playback speed
                  </div>
                  {SPEEDS.map((s, i) => (
                    <div key={s} className={`sheet-row ${i === speedIdx ? 'checked' : ''}`} onClick={() => { selectSpeed(i); setSettingsSheet(''); }}>
                      <span className="row-icon"><i className="fas fa-gauge-high"></i></span>
                      <span>{s}x</span>
                      {i === speedIdx ? <span className="row-check"><i className="fas fa-check"></i></span> : null}
                    </div>
                  ))}
                </>
              ) : null}

              {settingsSheet === 'quality' ? (
                <>
                  <div className="sheet-title">
                    <span className="sheet-back" onClick={() => setSettingsSheet('root')} role="button" aria-label="Back"><i className="fas fa-arrow-left"></i></span>
                    Quality
                  </div>
                  {qualityOptions.map((q) => (
                    <div key={String(q.key)} className={`sheet-row ${q.key === qualitySel ? 'checked' : ''}`} onClick={() => { selectQuality(q.key); setSettingsSheet(''); }}>
                      <span className="row-icon"><i className="fas fa-sliders"></i></span>
                      <span>{q.label}</span>
                      {q.key === qualitySel ? <span className="row-check"><i className="fas fa-check"></i></span> : null}
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          </div>

          {/* -------- kebab sheet (⋮) -------- */}
          <div
            className={`sheet-overlay ${menuOpen ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }}
          >
            <div className="sb-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="sheet-handle-wrap"><div className="sheet-handle"></div></div>
              <div className="sheet-title"><i className="fas fa-ellipsis-v" style={{ color: '#9ca3af' }}></i> More options</div>
              <div className="sheet-sep"></div>
              {pipAvailable ? (
                <div className="sheet-row" onClick={togglePip}>
                  <span className="row-icon"><i className="fas fa-clone"></i></span>
                  <span>Picture-in-picture</span>
                </div>
              ) : null}
              <div className="sheet-row" onClick={() => { copyLink(); setMenuOpen(false); }}>
                <span className="row-icon"><i className="fas fa-link"></i></span>
                <span>{copied ? 'Link Copied!' : 'Copy Link'}</span>
              </div>
              <div className="sheet-row" style={{ cursor: 'default' }}>
                <span className="row-icon"><i className="fas fa-film"></i></span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
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
