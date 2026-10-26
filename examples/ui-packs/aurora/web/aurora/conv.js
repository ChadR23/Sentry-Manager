// Aurora: the converter as data. One live stream (/api/converter/events) shared
// by whoever listens; full snapshots and progress-only updates merge here.

import { invoke, CLIENT_ID } from './core.js';

export const ACTIVE = new Set(['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing', 'paused', 'paused_network']);
export const PAUSED = new Set(['paused', 'paused_network']);
export const STATE_TEXT = {
  discovering: 'Finding clips', waiting: 'Lining up the next clip', staging: 'Copying clips to work on', encoding: 'Converting',
  'writing-telemetry': 'Writing the driving data back', verifying: 'Verifying', copying: 'Saving checked copies', replacing: 'Replacing originals',
  paused: 'Paused', paused_network: 'Waiting for the share', completed: 'Finished', cancelled: 'Cancelled', failed: 'Stopped with a problem'
};
export const CODEC = { h265: 'H.265', av1: 'AV1', h264: 'H.264' };
export const PROFILES = [
  ['conservative', 'Light', 'about 5% smaller'],
  ['balanced', 'Balanced', 'about 20% smaller'],
  ['aggressive', 'Strong', 'about 50% smaller'],
  ['quality', 'Constant quality', 'holds a quality level'],
  ['custom', 'Custom bitrate', 'a bitrate you choose']
];
export const GROUPS = [['RecentClips', 'Recent drives'], ['SavedClips', 'Saved clips'], ['SentryClips', 'Sentry events']];
const ERRORS = {
  REPLACEMENT_CONFIRMATION_REQUIRED: 'Confirm that the originals may be replaced.',
  REPLACEMENT_UNAVAILABLE: 'This storage can’t replace originals safely. Use a separate folder.',
  PATH_NOT_ALLOWED: 'That folder is outside the vehicle shares and output folders.',
  PATH_OVERLAP: 'The output folder can’t be inside the footage folder.',
  PATH_UNAVAILABLE: 'That folder can’t be reached right now.',
  INVALID_PATH: 'That folder can’t be used.',
  JOB_ACTIVE: 'A conversion is already running. Wait for it, or cancel it first.',
  BENCHMARK_ACTIVE: 'A benchmark is already running.',
  BENCHMARK_SOURCE_REQUIRED: 'There are no clips to benchmark with yet.',
  INVALID_LANES: 'Those per-device settings can’t be used.',
  INVALID_GROUP_SELECTION: 'Pick at least one kind of clip.',
  INVALID_BITRATE: 'Enter a bitrate between 250 and 100000 kbit/s.',
  AUTO_CONFIG_REQUIRED: 'Automatic conversion needs a vehicle and settings.',
  INVALID_AUTO_WINDOW: 'Pick different start and end hours.',
  CONVERTER_STARTING: 'The converter is still starting. Try again in a moment.',
  RECOVERY_REQUIRED: 'This job stopped in the middle of replacing a file. Resume it so it can finish safely.',
  NETWORK_ERROR: 'Can’t reach the server.',
  CANCELLED: 'Cancelled.'
};
export function explain(err) {
  if (err?.code === 'DEVICE_UNSUPPORTED' && err.details?.device) return `${err.details.device} can’t encode ${CODEC[err.details.codec] || err.details.codec}. Set it to 0 or pick another codec.`;
  return ERRORS[err?.code] || (err?.code ? `The converter said: ${String(err.code).toLowerCase().replace(/_/g, ' ')}.` : 'Something went wrong.');
}

/** Counts of a snapshot, whether its item list is complete or trimmed. */
export function counts(s) {
  const items = Array.isArray(s?.items) ? s.items : [];
  const n = (st) => s?.itemStateCounts?.[st] ?? items.filter((i) => i.state === st).length;
  const total = s?.itemCount ?? items.length;
  const completed = n('completed');
  const skipped = n('skipped');
  const failed = n('failed');
  const queued = n('queued');
  const working = s?.itemStateCounts?.active ?? items.filter((i) => i.state === 'processing').length;
  return { total, completed, skipped, failed, queued, working, done: completed + skipped + failed };
}

/** Clips per minute and time left, from the last two minutes of progress. */
export class Pace {
  constructor() { this.samples = []; this.id = null; }
  read(s) {
    if (!s) return { perMin: null, leftMs: null };
    if (s.id !== this.id) { this.id = s.id; this.samples = []; }
    const c = counts(s);
    const done = c.completed + c.failed;
    const left = c.queued + c.working;
    const now = Date.now();
    if (PAUSED.has(s.state)) this.samples = [];
    const lastS = this.samples[this.samples.length - 1];
    if (!lastS || lastS.done !== done) this.samples.push({ t: now, done });
    while (this.samples.length > 2 && now - this.samples[1].t > 120000) this.samples.shift();
    let perMin = null;
    const first = this.samples[0];
    const elapsed = Math.max(0, (ACTIVE.has(s.state) ? now : s.updatedAt || now) - (s.createdAt || now));
    if (this.samples.length > 1 && now - first.t >= 10000 && done > first.done) perMin = (done - first.done) / ((now - first.t) / 60000);
    else if (done > 0 && elapsed > 5000) perMin = done / (elapsed / 60000);
    if (!perMin || !Number.isFinite(perMin)) return { perMin: null, leftMs: null };
    return { perMin, leftMs: ACTIVE.has(s.state) && left > 0 ? (left / perMin) * 60000 : null };
  }
}

// ---------- the shared stream ----------
const live = { known: false, es: null, snap: null, listeners: new Set(), bench: new Set(), subscribed: false, retry: 1000 };

function deliver() {
  for (const fn of [...live.listeners]) {
    try { fn(live.snap); } catch (err) { console.warn(err); }
  }
}

export function apply(next) {
  live.known = true;
  if (!next) {
    live.snap = null;
  } else if (!next.state) {
    // progress only: the running clip's live numbers
    if (live.snap && next.id === live.snap.id && next.progress) live.snap = { ...live.snap, progress: next.progress };
    else return;
  } else if (!live.snap || next.id !== live.snap.id || (next.revision ?? 0) >= (live.snap.revision ?? 0)) {
    // an older finished job never replaces a running one
    if (live.snap && next.id !== live.snap.id && ACTIVE.has(live.snap.state) && !ACTIVE.has(next.state) && (next.updatedAt || 0) < (live.snap.updatedAt || 0)) return;
    live.snap = { ...next, progress: next.progress ?? (live.snap?.id === next.id ? live.snap.progress : undefined) };
  } else return;
  deliver();
}

export async function refreshCurrent() {
  const r = await invoke('getCurrent');
  if (r.ok) {
    // (a newer revision of the same job, or another job, or none)
    if (!r.value) apply(null);
    else apply(r.value);
  }
  return r;
}

function open() {
  if (live.es) return;
  const es = new EventSource(`/api/converter/events?client=${encodeURIComponent(CLIENT_ID)}`);
  live.es = es;
  es.addEventListener('hello', async () => {
    live.retry = 1000;
    const r = await invoke('subscribeProgress');
    live.subscribed = r.ok;
    await refreshCurrent();
  });
  es.addEventListener('converter:progress', (e) => {
    try { apply(JSON.parse(e.data).snapshot); } catch { /* bad line */ }
  });
  es.addEventListener('converter:benchmarkProgress', (e) => {
    let p;
    try { p = JSON.parse(e.data); } catch { return; }
    for (const fn of [...live.bench]) fn(p);
  });
  es.addEventListener('error', () => {
    if (es.readyState !== EventSource.CLOSED) return;
    live.es = null;
    live.subscribed = false;
    if (live.listeners.size || live.bench.size) setTimeout(open, live.retry);
    live.retry = Math.min(live.retry * 2, 30000);
  });
}

function closeIfIdle() {
  if (live.listeners.size || live.bench.size || !live.es) return;
  live.es.close();
  live.es = null;
  if (live.subscribed) invoke('unsubscribeProgress');
  live.subscribed = false;
}

/** fn(snapshot) on every change; returns stop(). */
export function follow(fn) {
  live.listeners.add(fn);
  open();
  if (live.known) fn(live.snap);
  else refreshCurrent().then((r) => { if (!r.ok) fn(null); });
  return () => {
    live.listeners.delete(fn);
    setTimeout(closeIfIdle, 0);
  };
}
export function onBenchmark(fn) {
  live.bench.add(fn);
  open();
  return () => {
    live.bench.delete(fn);
    setTimeout(closeIfIdle, 0);
  };
}
export function streamReady() {
  open();
  return new Promise((resolve) => {
    const t0 = Date.now();
    const check = () => (live.subscribed || Date.now() - t0 > 4000 ? resolve() : setTimeout(check, 100));
    check();
  });
}
export const snapshot = () => live.snap;
