import { useState, useEffect, useRef, useCallback } from 'react';

// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_WASH = 45 * 60;
const DEFAULT_DRY  = 60 * 60;
const NAG_INTERVAL = 5 * 60;
const MAX_SNOOZES  = 2;
const SNOOZE_SECS  = 10 * 60;

const PHASES = {
  IDLE:      'idle',
  WASHING:   'washing',
  NAG_DRYER: 'nag_dryer',
  DRYING:    'drying',
  NAG_FOLD:  'nag_fold',
  CELEBRATE: 'celebrate',
};

const PHASE_COLORS = {
  idle:      { bg: '#0f1729', accent: '#60a5fa', ring: '#3b82f6' },
  washing:   { bg: '#0d1340', accent: '#818cf8', ring: '#6366f1' },
  nag_dryer: { bg: '#2d1200', accent: '#fb923c', ring: '#f97316' },
  drying:    { bg: '#1a0d2e', accent: '#c084fc', ring: '#a855f7' },
  nag_fold:  { bg: '#2d1200', accent: '#fb923c', ring: '#f97316' },
  celebrate: { bg: '#0a2010', accent: '#4ade80', ring: '#22c55e' },
};

const DEFAULT_STATS = {
  totalLoads: 0, currentStreak: 0, bestStreak: 0,
  loadsThisWeek: 0, lastCompletedDate: null, history: [],
};

// ─── Audio ────────────────────────────────────────────────────────────────────
function playAlert(level = 0) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const freqs = [440, 520, 620, 740];
    const durs  = [0.25, 0.35, 0.45, 0.6];
    const vols  = [0.08, 0.12, 0.18, 0.25];
    for (let i = 0; i < level + 1; i++) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = level >= 2 ? 'sawtooth' : 'sine';
      osc.frequency.value = freqs[level];
      gain.gain.setValueAtTime(vols[level], ctx.currentTime + i * 0.4);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.4 + durs[level]);
      osc.start(ctx.currentTime + i * 0.4);
      osc.stop(ctx.currentTime + i * 0.4 + durs[level]);
    }
  } catch (_) {}
}

function playVictory() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [261.63, 329.63, 392.00, 523.25].forEach((freq, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.15, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      osc.start(t); osc.stop(t + 0.4);
    });
  } catch (_) {}
}

// ─── Haptic ───────────────────────────────────────────────────────────────────
function triggerHaptic(level) {
  try {
    const patterns = [
      [200],
      [200, 100, 200],
      [300, 100, 300, 100, 300],
      [500, 100, 500, 100, 500],
    ];
    navigator.vibrate?.(patterns[level] ?? patterns[0]);
  } catch (_) {}
}

// ─── ntfy.sh — true background push notifications ────────────────────────────
// ntfy is a free push relay. The app POSTs a scheduled message to ntfy's servers;
// they deliver it to the ntfy app on the user's phone even when this app is closed.

function generateTopicId() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return 'laundry-' + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getOrCreateTopicId() {
  try {
    const existing = await storage.get('ntfy-topic');
    if (existing) return existing;
    const id = generateTopicId();
    await storage.set('ntfy-topic', id);
    return id;
  } catch (_) { return null; }
}

// Returns ntfy message ID string (used to cancel), or null on failure
async function scheduleNtfyNotification(topicId, delayMs, title, body) {
  if (!topicId) return null;
  try {
    const headers = { 'Title': title, 'Priority': 'high', 'Tags': 'bell' };
    if (delayMs > 0) {
      const delayMins = Math.max(1, Math.round(delayMs / 60000));
      headers['Delay'] = `${delayMins}min`;
    }
    const res = await fetch(`https://ntfy.sh/${topicId}`, {
      method: 'POST',
      headers,
      body: body,
    });
    if (res.ok) {
      const data = await res.json();
      return data.id ?? null;
    }
  } catch (_) {}
  return null;
}

// Schedule the initial alert + escalating follow-ups. Returns array of IDs.
async function scheduleNtfyNagSeries(topicId, baseDelayMs, firstTitle, firstBody, followUps) {
  if (!topicId) return [];
  const ids = await Promise.all([
    scheduleNtfyNotification(topicId, baseDelayMs, firstTitle, firstBody),
    ...followUps.map(({ extraMs, title, body }) =>
      scheduleNtfyNotification(topicId, baseDelayMs + extraMs, title, body)
    ),
  ]);
  return ids.filter(Boolean);
}

// Cancel an array of ntfy message IDs
async function cancelNtfyNotifications(topicId, ids) {
  if (!topicId || !ids?.length) return;
  await Promise.allSettled(
    ids.map(id => fetch(`https://ntfy.sh/${topicId}/${id}`, { method: 'DELETE' }).catch(() => {}))
  );
}

// ─── Storage shim ─────────────────────────────────────────────────────────────
// Use window.storage if the host provides it; otherwise fall back to localStorage.
const storage = {
  async get(key) {
    if (window.storage?.get) return window.storage.get(key);
    return localStorage.getItem(key);
  },
  async set(key, value) {
    if (window.storage?.set) return window.storage.set(key, value);
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  },
};

// ─── Storage ──────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const raw = await storage.get('laundry-stats');
    if (raw) return { ...DEFAULT_STATS, ...JSON.parse(raw) };
  } catch (_) {}
  return { ...DEFAULT_STATS };
}
async function saveStats(s) {
  try { await storage.set('laundry-stats', JSON.stringify(s)); } catch (_) {}
}
async function setInProgress(v) {
  try { await storage.set('laundry-in-progress', v ? 'true' : null); } catch (_) {}
}
async function getInProgress() {
  try { return (await storage.get('laundry-in-progress')) === 'true'; } catch (_) { return false; }
}
async function loadDurations() {
  try {
    const raw = await storage.get('laundry-durations');
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return { wash: DEFAULT_WASH, dry: DEFAULT_DRY };
}
async function saveDurations(wash, dry) {
  try { await storage.set('laundry-durations', JSON.stringify({ wash, dry })); } catch (_) {}
}

// Session = the active timer state, so we can survive iOS killing the app
async function saveSession(data) {
  try { await storage.set('laundry-session', JSON.stringify(data)); } catch (_) {}
}
async function loadSession() {
  try {
    const raw = await storage.get('laundry-session');
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}
async function clearSession() {
  try { await storage.set('laundry-session', null); } catch (_) {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getMondayStr(date = new Date()) {
  const d = new Date(date), day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}
function formatTime(secs) {
  return `${Math.floor(secs / 60).toString().padStart(2, '0')}:${(secs % 60).toString().padStart(2, '0')}`;
}
function formatElapsed(secs) {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60), s = secs % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}
function formatEndTime(secs) {
  const end = new Date(Date.now() + secs * 1000);
  return end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function ConfettiCanvas() {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d');
    c.width = c.offsetWidth; c.height = c.offsetHeight;
    const ps = Array.from({ length: 150 }, () => ({
      x: Math.random() * c.width, y: Math.random() * c.height * 0.4 - c.height * 0.2,
      vx: (Math.random() - 0.5) * 4, vy: Math.random() * 3 + 2,
      color: `hsl(${Math.random() * 360},90%,60%)`,
      size: Math.random() * 8 + 4, rot: Math.random() * Math.PI * 2,
      rotV: (Math.random() - 0.5) * 0.2, life: 1, decay: Math.random() * 0.008 + 0.004,
    }));
    let id;
    function draw() {
      ctx.clearRect(0, 0, c.width, c.height);
      let alive = false;
      for (const p of ps) {
        if (p.life <= 0) continue; alive = true;
        p.x += p.vx; p.y += p.vy; p.vy += 0.08; p.rot += p.rotV; p.life -= p.decay;
        ctx.save(); ctx.globalAlpha = Math.max(0, p.life);
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.color; ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.5);
        ctx.restore();
      }
      if (alive) id = requestAnimationFrame(draw);
    }
    draw();
    return () => cancelAnimationFrame(id);
  }, []);
  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />;
}

function ProgressRing({ progress, color, size = 240, sw = 8 }) {
  const r = (size - sw) / 2, circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} style={{ position: 'absolute', top: 0, left: 0, transform: 'rotate(-90deg)' }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={sw} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={sw}
        strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={circ * (1 - progress)}
        style={{ transition: 'stroke-dashoffset 1s linear', filter: `drop-shadow(0 0 6px ${color})` }}
      />
    </svg>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 12, padding: '12px 8px', flex: 1, minWidth: 0, textAlign: 'center' }}>
      <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 24, fontWeight: 700, color: accent, lineHeight: 1 }}>{value}</div>
      <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 10, color: 'rgba(255,255,255,0.45)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
    </div>
  );
}

function AbandonConfirmOverlay({ onConfirm, onCancel, streakWillReset }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div style={{
        background: '#1e1e2e', border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 20, padding: '32px 24px', maxWidth: 340, width: '100%', textAlign: 'center',
      }}>
        <div style={{ fontSize: 44, marginBottom: 16 }}>🗑️</div>
        <h2 style={{ fontFamily: "'Outfit', sans-serif", fontWeight: 800, fontSize: 22, color: 'white', marginBottom: 8 }}>
          Abandon this load?
        </h2>
        {streakWillReset && (
          <p style={{ color: '#fb923c', fontSize: 14, marginBottom: 8 }}>
            ⚠️ This will reset your streak to 0.
          </p>
        )}
        <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: 14, marginBottom: 28, lineHeight: 1.5 }}>
          No judgment — life happens. You can always start fresh.
        </p>
        <div style={{ display: 'flex', gap: 12, flexDirection: 'column' }}>
          <button
            onClick={onConfirm}
            style={{
              background: '#7f1d1d', border: '1px solid #ef4444', color: '#fca5a5',
              borderRadius: 12, padding: '14px', fontFamily: "'Outfit', sans-serif",
              fontWeight: 700, fontSize: 15, cursor: 'pointer',
            }}
          >
            Yes, abandon load
          </button>
          <button
            onClick={onCancel}
            style={{
              background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
              color: 'rgba(255,255,255,0.7)', borderRadius: 12, padding: '14px',
              fontFamily: "'Outfit', sans-serif", fontWeight: 600, fontSize: 15, cursor: 'pointer',
            }}
          >
            Keep going
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [phase, setPhase]             = useState(PHASES.IDLE);
  const [timer, setTimer]             = useState(0);
  const [nagElapsed, setNagElapsed]   = useState(0);
  const [nagLevel, setNagLevel]       = useState(0);
  const [stats, setStats]             = useState(DEFAULT_STATS);
  const [showHome, setShowHome]       = useState(false);
  const [washStart, setWashStart]     = useState(null);
  const [dryStart, setDryStart]       = useState(null);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [snoozeCount, setSnoozeCount] = useState(0);
  const [snoozeSecs, setSnoozeSecs]   = useState(0);   // countdown while snoozed
  const [isSnoozed, setIsSnoozed]     = useState(false);
  const [washDuration, setWashDuration] = useState(DEFAULT_WASH);
  const [dryDuration, setDryDuration]   = useState(DEFAULT_DRY);
  const [topicId, setTopicId]           = useState(null);
  const [ntfyReady, setNtfyReady]       = useState(false);
  const [ntfyTestState, setNtfyTestState] = useState('idle'); // 'idle' | 'sending' | 'ok' | 'fail'
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  );
  const [alarmScheduled, setAlarmScheduled] = useState(null); // null | 'ok' | 'fail'

  const timerRef      = useRef(null);
  const nagRef        = useRef(null);
  const snoozeRef     = useRef(null);
  const wakeLockRef   = useRef(null);
  const notifIdRef    = useRef([]);     // kept for ntfy test cancellation only
  const phaseRef      = useRef(phase);
  phaseRef.current    = phase;

  const colors = PHASE_COLORS[phase];

  // ── SW helpers ────────────────────────────────────────────────────────────
  const swPost = useCallback((data) => {
    navigator.serviceWorker?.controller?.postMessage(data);
  }, []);

  const requestNotifPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return;
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
  }, []);

  // ── Init ─────────────────────────────────────────────────────────────────
  // Use a ref so startCountdown/startNag are available inside the async init
  const initDoneRef = useRef(false);
  useEffect(() => {
    if (initDoneRef.current) return;
    initDoneRef.current = true;
    (async () => {
      const s = await loadStats();
      const thisMonday = getMondayStr();
      const lastMonday = s.lastCompletedDate ? getMondayStr(new Date(s.lastCompletedDate)) : null;
      if (lastMonday && lastMonday < thisMonday) s.loadsThisWeek = 0;
      setStats(s);

      const { wash, dry } = await loadDurations();
      setWashDuration(wash); setDryDuration(dry);

      const tid = await getOrCreateTopicId();
      setTopicId(tid);
      const ntfyReadyVal = await storage.get('ntfy-ready').catch(() => null);
      setNtfyReady(ntfyReadyVal === 'true');

      // ── Restore session if iOS killed the app mid-cycle ──────────────
      const session = await loadSession();
      if (!session) return;

      const now = Date.now();

      if (session.phase === PHASES.WASHING || session.phase === PHASES.DRYING) {
        const remainingSecs = Math.round((session.timerEndsAt - now) / 1000);
        if (session.washStart) setWashStart(session.washStart);
        if (session.dryStart)  setDryStart(session.dryStart);

        if (remainingSecs <= 0) {
          // Timer already expired while app was away — go straight to nag
          const nagPhase = session.phase === PHASES.WASHING ? PHASES.NAG_DRYER : PHASES.NAG_FOLD;
          setPhase(nagPhase);
          // Calculate how long they've been waiting
          const nagElapsedSecs = Math.round((now - session.timerEndsAt) / 1000);
          setNagElapsed(nagElapsedSecs);
          const lvl = Math.min(3, Math.floor(nagElapsedSecs / NAG_INTERVAL));
          startNag(lvl);
        } else {
          // Resume countdown from where it left off
          setPhase(session.phase);
          const onComplete = () => {
            const np = phaseRef.current === PHASES.WASHING ? PHASES.NAG_DRYER : PHASES.NAG_FOLD;
            setPhase(np); startNag(0);
          };
          startCountdown(remainingSecs, onComplete);
        }
      } else if (session.phase === PHASES.NAG_DRYER || session.phase === PHASES.NAG_FOLD) {
        if (session.washStart) setWashStart(session.washStart);
        if (session.dryStart)  setDryStart(session.dryStart);
        const nagElapsedSecs = Math.round((now - session.nagStartedAt) / 1000);
        setPhase(session.phase);
        const lvl = Math.min(3, Math.floor(nagElapsedSecs / NAG_INTERVAL));
        setNagElapsed(nagElapsedSecs);
        startNag(lvl);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => () => {
    clearInterval(timerRef.current);
    clearInterval(nagRef.current);
    clearInterval(snoozeRef.current);
    // ntfy cancellation is best-effort; skip on unmount to avoid async issues
    wakeLockRef.current?.release?.().catch(() => {});
  }, []);

  // ── WakeLock ──────────────────────────────────────────────────────────────
  const acquireWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      }
    } catch (_) {}
  }, []);
  const releaseWakeLock = useCallback(() => {
    wakeLockRef.current?.release?.().catch(() => {});
    wakeLockRef.current = null;
  }, []);

  // ── Countdown ─────────────────────────────────────────────────────────────
  const startCountdown = useCallback((duration, onComplete) => {
    clearInterval(timerRef.current);
    setTimer(duration);
    timerRef.current = setInterval(() => {
      setTimer(prev => {
        if (prev <= 1) { clearInterval(timerRef.current); onComplete(); return 0; }
        return prev - 1;
      });
    }, 1000);
  }, []);

  // ── Nag ───────────────────────────────────────────────────────────────────
  const startNag = useCallback((level = 0) => {
    clearInterval(nagRef.current);
    setNagElapsed(0); setNagLevel(level);
    setSnoozeCount(0); setIsSnoozed(false); setSnoozeSecs(0);
    playAlert(level); triggerHaptic(level);
    acquireWakeLock();

    nagRef.current = setInterval(() => {
      setIsSnoozed(cur => {
        if (cur) return cur; // paused during snooze — just skip tick
        setNagElapsed(prev => {
          const next = prev + 1;
          const newLevel = Math.min(3, Math.floor(next / NAG_INTERVAL));
          setNagLevel(curLevel => {
            if (newLevel > curLevel) { playAlert(newLevel); triggerHaptic(newLevel); }
            return newLevel;
          });
          return next;
        });
        return cur;
      });
    }, 1000);
  }, [acquireWakeLock]);

  const stopNag = useCallback(() => {
    clearInterval(nagRef.current);
    clearInterval(snoozeRef.current);
    setNagElapsed(0); setNagLevel(0);
    setIsSnoozed(false); setSnoozeSecs(0); setSnoozeCount(0);
    releaseWakeLock();
  }, [releaseWakeLock]);

  // ── Snooze ────────────────────────────────────────────────────────────────
  const handleSnooze = useCallback(() => {
    if (snoozeCount >= MAX_SNOOZES) return;
    setIsSnoozed(true);
    setSnoozeSecs(SNOOZE_SECS);
    setSnoozeCount(c => c + 1);
    clearInterval(snoozeRef.current);
    snoozeRef.current = setInterval(() => {
      setSnoozeSecs(prev => {
        if (prev <= 1) {
          clearInterval(snoozeRef.current);
          setIsSnoozed(false);
          // re-trigger haptic/sound at current level
          setNagLevel(lvl => { playAlert(lvl); triggerHaptic(lvl); return lvl; });
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [snoozeCount]);

  // ── Abandon ───────────────────────────────────────────────────────────────
  const handleAbandon = useCallback(async () => {
    clearInterval(timerRef.current);
    stopNag();
    swPost({ type: 'CANCEL_ALARM', id: 'laundry' });
    notifIdRef.current = [];
    await setInProgress(false);
    await clearSession();
    setStats(prev => {
      const next = { ...prev, currentStreak: 0 };
      saveStats(next);
      return next;
    });
    setPhase(PHASES.IDLE);
    setTimer(0); setWashStart(null); setDryStart(null);
    setConfirmAbandon(false); setShowHome(false);
  }, [stopNag, swPost]);

  // ── Adjust timer ──────────────────────────────────────────────────────────
  const adjustTimer = useCallback((delta) => {
    setTimer(prev => {
      const next = Math.max(60, prev + delta);
      // Update stored timerEndsAt so restore works correctly after adjustment
      loadSession().then(s => {
        if (s?.timerEndsAt) saveSession({ ...s, timerEndsAt: s.timerEndsAt + delta * 1000 });
      });
      return next;
    });
    if (phaseRef.current === PHASES.WASHING) {
      setWashDuration(prev => { const next = Math.max(60, prev + delta); saveDurations(next, dryDuration); return next; });
    } else if (phaseRef.current === PHASES.DRYING) {
      setDryDuration(prev => { const next = Math.max(60, prev + delta); saveDurations(washDuration, next); return next; });
    }
  }, [dryDuration, washDuration]);

  // ── Transitions ───────────────────────────────────────────────────────────
  const handleStartWash = useCallback(async () => {
    const now = Date.now();
    await setInProgress(true);
    setWashStart(now);
    setPhase(PHASES.WASHING);
    await saveSession({ phase: PHASES.WASHING, timerEndsAt: now + washDuration * 1000, washStart: now });
    swPost({
      type: 'SET_ALARM', id: 'laundry',
      endTime: now + washDuration * 1000,
      title: '🌀 Wash done!', body: 'Move your clothes to the dryer.',
      topicId,
      followUps: [
        { extraMs: 10 * 60000, title: '👋 Still in the washer', body: 'Go move them to the dryer!' },
        { extraMs: 25 * 60000, title: '⚠️ 25+ min waiting', body: 'Wet clothes get musty. Move them NOW!' },
      ],
    });
    setAlarmScheduled(navigator.serviceWorker?.controller ? 'ok' : 'fail');
    startCountdown(washDuration, () => {
      if (phaseRef.current === PHASES.WASHING) {
        setPhase(PHASES.NAG_DRYER);
        saveSession({ phase: PHASES.NAG_DRYER, nagStartedAt: Date.now(), washStart: now });
        startNag(0);
      }
    });
  }, [startCountdown, startNag, washDuration, topicId, swPost]);

  const handleStartDryOnly = useCallback(async () => {
    const now = Date.now();
    await setInProgress(true);
    setDryStart(now);
    setPhase(PHASES.DRYING);
    await saveSession({ phase: PHASES.DRYING, timerEndsAt: now + dryDuration * 1000, dryStart: now });
    swPost({
      type: 'SET_ALARM', id: 'laundry',
      endTime: now + dryDuration * 1000,
      title: '🌪️ Dryer done!', body: 'Time to fold and put away.',
      topicId,
      followUps: [
        { extraMs: 10 * 60000, title: '👋 Still in the dryer', body: 'Go fold your clothes!' },
        { extraMs: 25 * 60000, title: '⚠️ 25+ min waiting', body: 'Wrinkles are setting in. Fold them NOW!' },
      ],
    });
    setAlarmScheduled(navigator.serviceWorker?.controller ? 'ok' : 'fail');
    startCountdown(dryDuration, () => {
      if (phaseRef.current === PHASES.DRYING) {
        const nagNow = Date.now();
        setPhase(PHASES.NAG_FOLD);
        saveSession({ phase: PHASES.NAG_FOLD, nagStartedAt: nagNow, dryStart: now });
        startNag(0);
      }
    });
  }, [startCountdown, startNag, dryDuration, topicId, swPost]);

  const handleJumpToFold = useCallback(async () => {
    await setInProgress(true);
    const now = Date.now();
    setPhase(PHASES.NAG_FOLD);
    await saveSession({ phase: PHASES.NAG_FOLD, nagStartedAt: now });
    startNag(0);
  }, [startNag]);

  const handleMovedToDryer = useCallback(async (savedWashStart) => {
    stopNag();
    const now = Date.now();
    const ws = savedWashStart ?? washStart;
    setDryStart(now);
    setPhase(PHASES.DRYING);
    await saveSession({ phase: PHASES.DRYING, timerEndsAt: now + dryDuration * 1000, washStart: ws, dryStart: now });
    swPost({
      type: 'SET_ALARM', id: 'laundry',
      endTime: now + dryDuration * 1000,
      title: '🌪️ Dryer done!', body: 'Time to fold and put away.',
      topicId,
      followUps: [
        { extraMs: 10 * 60000, title: '👋 Still in the dryer', body: 'Go fold your clothes!' },
        { extraMs: 25 * 60000, title: '⚠️ 25+ min waiting', body: 'Wrinkles are setting in. Fold them NOW!' },
      ],
    });
    startCountdown(dryDuration, () => {
      if (phaseRef.current === PHASES.DRYING) { setPhase(PHASES.NAG_FOLD); startNag(0); }
    });
  }, [stopNag, startCountdown, startNag, dryDuration, washStart, topicId, swPost]);

  const handleFolded = useCallback(async () => {
    stopNag();
    clearInterval(timerRef.current);
    swPost({ type: 'CANCEL_ALARM', id: 'laundry' });
    notifIdRef.current = [];

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const thisMonday = getMondayStr(now);

    setStats(prev => {
      const newStreak = prev.currentStreak + 1;
      const newBest   = Math.max(prev.bestStreak, newStreak);
      const sameWeek  = prev.lastCompletedDate
        ? getMondayStr(new Date(prev.lastCompletedDate)) === thisMonday : false;
      const loadsThisWeek = sameWeek ? prev.loadsThisWeek + 1 : 1;
      const washMs = washStart ? Date.now() - washStart : 0;
      const dryMs  = dryStart  ? Date.now() - dryStart  : 0;
      const next = {
        ...prev, totalLoads: prev.totalLoads + 1,
        currentStreak: newStreak, bestStreak: newBest, loadsThisWeek, lastCompletedDate: dateStr,
        history: [...(prev.history || []).slice(-49), { date: dateStr, washDuration: Math.round(washMs / 1000), dryDuration: Math.round(dryMs / 1000), totalTime: Math.round((washMs + dryMs) / 1000) }],
      };
      saveStats(next); return next;
    });

    await setInProgress(false);
    await clearSession();
    setPhase(PHASES.CELEBRATE);
    playVictory();
    setTimeout(() => setShowHome(true), 3000);
  }, [stopNag, washStart, dryStart, topicId, swPost]);

  const handleGoHome = useCallback(() => {
    setPhase(PHASES.IDLE); setShowHome(false);
    setTimer(0); setNagElapsed(0); setNagLevel(0);
    setWashStart(null); setDryStart(null);
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────
  const isNag   = phase === PHASES.NAG_DRYER || phase === PHASES.NAG_FOLD;
  const isTimer = phase === PHASES.WASHING   || phase === PHASES.DRYING;
  const timerTotal    = phase === PHASES.WASHING ? washDuration : dryDuration;
  const timerProgress = isTimer ? (timerTotal - timer) / timerTotal : 0;
  const canSnooze     = snoozeCount < MAX_SNOOZES && !isSnoozed;
  const isActive      = phase !== PHASES.IDLE && phase !== PHASES.CELEBRATE;

  const nagMessages = {
    nag_dryer: ['Time to move your clothes to the dryer!', 'Hey! Clothes are still in the washer.', 'CLOTHES ARE GETTING WRINKLED.', 'YOUR CLOTHES ARE STILL IN THE WASHER'],
    nag_fold:  ['Your laundry is done — time to fold!', 'Hey! Clothes are still in the dryer.', 'CLOTHES WILL WRINKLE IF LEFT LONGER.', 'FOLD YOUR CLOTHES NOW. SERIOUSLY.'],
  };
  const nagAnimStyle = [
    {},
    { animation: 'pulse-nag 2s ease-in-out infinite' },
    { animation: 'shake-nag 0.5s ease-in-out infinite' },
    { animation: 'flash-nag 0.8s ease-in-out infinite' },
  ];
  const nagBadgeColors = ['#fb923c', '#f97316', '#ef4444', '#dc2626'];
  const nagBadgeLabels = ['🔔 Reminder', '⚠️ Hey!', '🚨 Urgent!', '‼️ CRITICAL'];

  return (
    <div style={{
      minHeight: '100svh', background: colors.bg, transition: 'background 0.8s ease',
      fontFamily: "'Outfit', sans-serif",
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '24px 16px', position: 'relative', overflow: 'hidden',
    }}>
      <style>{`
        @keyframes pulse-nag { 0%,100%{transform:scale(1);opacity:1;} 50%{transform:scale(1.03);opacity:0.85;} }
        @keyframes shake-nag { 0%,100%{transform:translateX(0);} 20%{transform:translateX(-10px);} 40%{transform:translateX(10px);} 60%{transform:translateX(-6px);} 80%{transform:translateX(6px);} }
        @keyframes flash-nag { 0%,100%{opacity:1;background:#2d1200;} 50%{opacity:0.8;background:#3d1800;} }
        @keyframes pulse-ring { 0%,100%{opacity:1;} 50%{opacity:0.65;} }
        @keyframes bounce-btn { 0%,100%{transform:translateY(0) scale(1);} 50%{transform:translateY(-5px) scale(1.015);} }
        @keyframes bounce-fast { 0%,100%{transform:translateY(0) scale(1);} 50%{transform:translateY(-8px) scale(1.02);} }
        @keyframes celebrate-pop { 0%,100%{transform:scale(1) rotate(0deg);} 25%{transform:scale(1.1) rotate(-5deg);} 75%{transform:scale(1.1) rotate(5deg);} }
        button:active { transform: scale(0.97) !important; }
      `}</style>

      {/* Abandon confirm overlay */}
      {confirmAbandon && (
        <AbandonConfirmOverlay
          streakWillReset={stats.currentStreak > 0}
          onConfirm={handleAbandon}
          onCancel={() => setConfirmAbandon(false)}
        />
      )}

      {/* ── IDLE ───────────────────────────────────────────────────────── */}
      {phase === PHASES.IDLE && (
        <div style={{ width: '100%', maxWidth: 400, textAlign: 'center' }}>
          <h1 style={{ fontFamily: "'Outfit', sans-serif", fontWeight: 800, fontSize: 30, color: 'rgba(255,255,255,0.9)', marginBottom: 6, letterSpacing: '-0.02em' }}>
            Laundry Tracker
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.35)', fontSize: 14, marginBottom: 36 }}>
            Let&apos;s finish a full load today 💪
          </p>

          {/* Notification permission prompt */}
          {notifPermission !== 'granted' && (
            <div style={{ background: notifPermission === 'denied' ? '#3d1000' : '#1a2235', border: `1px solid ${notifPermission === 'denied' ? '#ef444444' : '#f59e0b44'}`, borderRadius: 14, padding: '14px 16px', marginBottom: 16, textAlign: 'left' }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: 'rgba(255,255,255,0.9)', marginBottom: 6 }}>
                {notifPermission === 'denied' ? '🚫 Notifications blocked' : '🔔 Allow notifications'}
              </div>
              {notifPermission === 'denied' ? (
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
                  You blocked notifications. Go to your browser settings and allow notifications for this site, then reload.
                </p>
              ) : (
                <>
                  <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5, marginBottom: 10 }}>
                    Required to alert you when your laundry is done. Also, <strong style={{ color: 'rgba(255,255,255,0.7)' }}>add this app to your Home Screen</strong> (Safari → Share → Add to Home Screen) for reliable background alerts.
                  </p>
                  <button
                    onClick={requestNotifPermission}
                    style={{ width: '100%', background: `${colors.accent}33`, border: `1px solid ${colors.accent}66`, color: colors.accent, borderRadius: 10, padding: '10px', fontFamily: "'Outfit', sans-serif", fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
                  >
                    Allow notifications →
                  </button>
                </>
              )}
            </div>
          )}


          {/* Main CTA */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
            <button onClick={handleStartWash} style={{
              width: 224, height: 224, borderRadius: '50%',
              background: `radial-gradient(circle at 35% 35%, ${colors.accent}33, ${colors.ring}11)`,
              border: `3px solid ${colors.accent}55`, color: 'white', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
              boxShadow: `0 0 48px ${colors.accent}44, 0 0 96px ${colors.accent}22`,
              animation: 'bounce-btn 3s ease-in-out infinite',
            }}>
              <span style={{ fontSize: 54 }}>🧺</span>
              <span style={{ fontFamily: "'Outfit', sans-serif", fontWeight: 700, fontSize: 18 }}>Start Wash</span>
            </button>
          </div>

          {/* Jump-in-mid-cycle */}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 40 }}>
            <button onClick={handleStartDryOnly} style={{
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
              color: 'rgba(255,255,255,0.55)', borderRadius: 100, padding: '9px 16px',
              fontFamily: "'Outfit', sans-serif", fontWeight: 600, fontSize: 13, cursor: 'pointer',
            }}>
              🌪️ Already drying →
            </button>
            <button onClick={handleJumpToFold} style={{
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
              color: 'rgba(255,255,255,0.55)', borderRadius: 100, padding: '9px 16px',
              fontFamily: "'Outfit', sans-serif", fontWeight: 600, fontSize: 13, cursor: 'pointer',
            }}>
              👕 Need to fold →
            </button>
          </div>

          {/* Duration editors */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 24, justifyContent: 'center' }}>
            {[
              { label: '🌀 Wash', dur: washDuration, setDur: (d) => { setWashDuration(d); saveDurations(d, dryDuration); } },
              { label: '🌪️ Dry',  dur: dryDuration,  setDur: (d) => { setDryDuration(d);  saveDurations(washDuration, d); } },
            ].map(({ label, dur, setDur }) => (
              <div key={label} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '12px 8px', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <button
                    onClick={() => setDur(Math.max(60, dur - 5 * 60))}
                    style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.6)', fontSize: 16, fontWeight: 700, cursor: 'pointer', lineHeight: 1 }}
                  >−</button>
                  <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 18, fontWeight: 700, color: colors.accent, minWidth: 48 }}>
                    {Math.floor(dur / 60)}m
                  </div>
                  <button
                    onClick={() => setDur(dur + 5 * 60)}
                    style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.6)', fontSize: 16, fontWeight: 700, cursor: 'pointer', lineHeight: 1 }}
                  >+</button>
                </div>
              </div>
            ))}
          </div>

          {/* Stats */}
          <div style={{ display: 'flex', gap: 8 }}>
            <StatCard label="Streak"   value={`${stats.currentStreak}🔥`} accent={colors.accent} />
            <StatCard label="Best"     value={stats.bestStreak}           accent={colors.accent} />
            <StatCard label="Week"     value={stats.loadsThisWeek}        accent={colors.accent} />
            <StatCard label="Total"    value={stats.totalLoads}           accent={colors.accent} />
          </div>
          <p style={{ color: 'rgba(255,255,255,0.18)', fontSize: 12, marginTop: 14 }}>
            {stats.totalLoads === 0 ? 'Complete your first load to start your streak!' : `Load #${stats.totalLoads + 1} coming up`}
          </p>
        </div>
      )}

      {/* ── WASHING / DRYING ─────────────────────────────────────────────── */}
      {isTimer && (
        <div style={{ width: '100%', maxWidth: 400, textAlign: 'center' }}>
          <h2 style={{ fontFamily: "'Outfit', sans-serif", fontWeight: 700, fontSize: 22, color: 'rgba(255,255,255,0.65)', marginBottom: 4 }}>
            {phase === PHASES.WASHING ? '🌀 Washing…' : '🌪️ Drying…'}
          </h2>
          <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: 13, marginBottom: 36 }}>
            {phase === PHASES.WASHING ? "I'll alert you when it's done" : 'Almost there — hang tight!'}
          </p>

          {/* Timer ring + nudge buttons */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, marginBottom: 36 }}>
            {/* −5 button */}
            <button onClick={() => adjustTimer(-5 * 60)} style={{
              width: 48, height: 48, borderRadius: '50%',
              background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)',
              color: 'rgba(255,255,255,0.6)', fontSize: 14, fontWeight: 700, cursor: 'pointer',
              fontFamily: "'Outfit', sans-serif", flexShrink: 0,
            }}>−5</button>

            <div style={{ position: 'relative', width: 220, height: 220, flexShrink: 0 }}>
              <ProgressRing progress={timerProgress} color={colors.ring} size={220} sw={8} />
              <div style={{
                position: 'absolute', inset: 14, borderRadius: '50%',
                background: `radial-gradient(circle at 35% 35%, ${colors.accent}18, transparent)`,
                border: `1px solid ${colors.accent}20`,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                animation: 'pulse-ring 2s ease-in-out infinite',
              }}>
                <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 40, fontWeight: 700, color: colors.accent, lineHeight: 1, textShadow: `0 0 24px ${colors.accent}88` }}>
                  {formatTime(timer)}
                </div>
                <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11, marginTop: 4 }}>remaining</div>
                <div style={{ color: colors.accent, fontSize: 12, marginTop: 6, fontWeight: 600, opacity: 0.7 }}>
                  done at {formatEndTime(timer)}
                </div>
              </div>
            </div>

            {/* +5 button */}
            <button onClick={() => adjustTimer(5 * 60)} style={{
              width: 48, height: 48, borderRadius: '50%',
              background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)',
              color: 'rgba(255,255,255,0.6)', fontSize: 14, fontWeight: 700, cursor: 'pointer',
              fontFamily: "'Outfit', sans-serif", flexShrink: 0,
            }}>+5</button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginBottom: 32 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: `${colors.accent}18`, border: `1px solid ${colors.accent}33`, borderRadius: 100, padding: '8px 20px' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: colors.accent, display: 'inline-block', animation: 'pulse-ring 1.2s ease-in-out infinite' }} />
              <span style={{ color: colors.accent, fontSize: 13, fontWeight: 600, fontFamily: "'Outfit', sans-serif" }}>
                {phase === PHASES.WASHING ? 'Wash cycle active' : 'Dry cycle active'}
              </span>
            </div>
            {alarmScheduled === 'ok' && (
              <div style={{ fontSize: 12, color: '#4ade80' }}>🔔 Background alert scheduled</div>
            )}
            {alarmScheduled === 'fail' && (
              <div style={{ fontSize: 12, color: '#fb923c' }}>⚠️ Install app to Home Screen to get alerts</div>
            )}
          </div>

          {/* Abandon */}
          <div>
            <button onClick={() => setConfirmAbandon(true)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.2)', fontSize: 13, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>
              Abandon load
            </button>
          </div>
        </div>
      )}

      {/* ── NAG ──────────────────────────────────────────────────────────── */}
      {isNag && (
        <div style={{ width: '100%', maxWidth: 400, textAlign: 'center', ...(isSnoozed ? {} : nagAnimStyle[nagLevel]) }}>
          {/* Urgency badge */}
          <div style={{
            display: 'inline-block', marginBottom: 20,
            background: isSnoozed ? '#374151' : nagBadgeColors[nagLevel],
            borderRadius: 100, padding: '6px 18px',
            fontSize: 12, fontWeight: 700, color: 'white', textTransform: 'uppercase', letterSpacing: '0.1em',
            boxShadow: isSnoozed ? 'none' : `0 0 20px ${nagBadgeColors[nagLevel]}88`,
          }}>
            {isSnoozed ? `😴 Snoozed — resuming in ${formatTime(snoozeSecs)}` : nagBadgeLabels[nagLevel]}
          </div>

          {/* Elapsed time */}
          <div style={{ marginBottom: 16 }}>
            <span style={{ fontFamily: "'Space Mono', monospace", fontSize: 52 + (isSnoozed ? 0 : nagLevel * 6), fontWeight: 700, color: isSnoozed ? 'rgba(255,255,255,0.3)' : colors.accent, textShadow: isSnoozed ? 'none' : `0 0 30px ${colors.accent}88`, lineHeight: 1 }}>
              {formatElapsed(nagElapsed)}
            </span>
            <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: 13, marginTop: 6 }}>
              since {phase === PHASES.NAG_DRYER ? 'wash ended' : 'dryer stopped'}
            </div>
          </div>

          {/* Message */}
          {!isSnoozed && (
            <p style={{ fontFamily: "'Outfit', sans-serif", fontWeight: nagLevel >= 2 ? 800 : 500, color: nagLevel >= 2 ? 'white' : 'rgba(255,255,255,0.8)', marginBottom: 32, fontSize: 14 + nagLevel * 3, lineHeight: 1.3 }}>
              {(nagMessages[phase] || [])[nagLevel]}
            </p>
          )}
          {isSnoozed && (
            <p style={{ fontFamily: "'Outfit', sans-serif", color: 'rgba(255,255,255,0.4)', marginBottom: 32, fontSize: 15 }}>
              Okay, I&apos;ll remind you again soon.
            </p>
          )}

          {/* Action button */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
            <button
              onClick={phase === PHASES.NAG_DRYER ? handleMovedToDryer : handleFolded}
              style={{
                width: 210, height: 210, borderRadius: '50%',
                background: `radial-gradient(circle at 35% 35%, ${colors.accent}44, ${colors.ring}22)`,
                border: `3px solid ${colors.accent}${isSnoozed ? '44' : ['66','88','aa','cc'][nagLevel]}`,
                color: 'white', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
                boxShadow: isSnoozed ? 'none' : `0 0 ${30 + nagLevel * 20}px ${colors.accent}${['44','66','88','aa'][nagLevel]}`,
                animation: isSnoozed ? 'none' : (nagLevel >= 1 ? 'bounce-fast 1s ease-in-out infinite' : 'bounce-btn 2.5s ease-in-out infinite'),
                fontFamily: "'Outfit', sans-serif", fontWeight: 700, fontSize: 15,
                opacity: isSnoozed ? 0.6 : 1,
              }}
            >
              <span style={{ fontSize: 42 }}>{phase === PHASES.NAG_DRYER ? '🌪️' : '👕'}</span>
              <span style={{ lineHeight: 1.25, textAlign: 'center', padding: '0 14px' }}>
                {phase === PHASES.NAG_DRYER ? 'Moved to\nDryer ✓' : 'Folded &\nPut Away ✓'}
              </span>
            </button>
          </div>

          {/* Snooze */}
          {canSnooze && (
            <button onClick={handleSnooze} style={{
              background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)',
              color: 'rgba(255,255,255,0.5)', borderRadius: 100, padding: '10px 24px',
              fontFamily: "'Outfit', sans-serif", fontWeight: 600, fontSize: 14, cursor: 'pointer',
              marginBottom: 8,
            }}>
              😴 Snooze 10 min {snoozeCount > 0 ? `(${MAX_SNOOZES - snoozeCount} left)` : ''}
            </button>
          )}
          {!canSnooze && snoozeCount >= MAX_SNOOZES && !isSnoozed && (
            <p style={{ color: 'rgba(255,255,255,0.2)', fontSize: 12, marginBottom: 8 }}>No more snoozes — you&apos;ve got this!</p>
          )}

          {/* Abandon */}
          <div style={{ marginTop: 8 }}>
            <button onClick={() => setConfirmAbandon(true)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.18)', fontSize: 13, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>
              Abandon load
            </button>
          </div>
        </div>
      )}

      {/* ── CELEBRATE ────────────────────────────────────────────────────── */}
      {phase === PHASES.CELEBRATE && (
        <div style={{ width: '100%', maxWidth: 400, textAlign: 'center', position: 'relative', zIndex: 1 }}>
          <ConfettiCanvas />
          <div style={{ fontSize: 80, marginBottom: 16, animation: 'celebrate-pop 0.8s ease-in-out infinite' }}>🎉</div>
          <h1 style={{ fontFamily: "'Outfit', sans-serif", fontWeight: 900, fontSize: 38, color: colors.accent, textShadow: `0 0 30px ${colors.accent}88`, marginBottom: 10, letterSpacing: '-0.02em' }}>
            Load #{stats.totalLoads} Done!
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.75)', fontSize: 18, marginBottom: 6 }}>
            {stats.currentStreak >= stats.bestStreak && stats.currentStreak > 1
              ? `🏆 New record — ${stats.currentStreak} in a row!`
              : stats.currentStreak > 1 ? `${stats.currentStreak} loads in a row 🔥`
              : 'Your clothes are clean and put away!'}
          </p>
          <p style={{ color: 'rgba(255,255,255,0.35)', fontSize: 14, marginBottom: 40 }}>
            {stats.loadsThisWeek} load{stats.loadsThisWeek !== 1 ? 's' : ''} this week
          </p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 40 }}>
            <StatCard label="Streak" value={`${stats.currentStreak}🔥`} accent={colors.accent} />
            <StatCard label="Best"   value={stats.bestStreak}           accent={colors.accent} />
            <StatCard label="Total"  value={stats.totalLoads}           accent={colors.accent} />
          </div>
          {showHome && (
            <button onClick={handleGoHome} style={{
              background: `${colors.accent}22`, border: `2px solid ${colors.accent}66`,
              color: colors.accent, borderRadius: 100, padding: '14px 36px',
              fontFamily: "'Outfit', sans-serif", fontWeight: 700, fontSize: 16, cursor: 'pointer',
              boxShadow: `0 0 20px ${colors.accent}33`,
            }}>
              Back to Home →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
