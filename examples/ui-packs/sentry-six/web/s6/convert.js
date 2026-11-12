// the converter, as data. One live stream (Server-Sent Events) is
// shared by every page that wants it; snapshots are merged as they arrive.

import { scope, clientId } from './core.js';

export const ACTIVE = new Set([
  'discovering',
  'waiting',
  'staging',
  'encoding',
  'writing-telemetry',
  'verifying',
  'copying',
  'replacing',
  'paused',
  'paused_network',
]);
export const PAUSED = new Set(['paused', 'paused_network']);
export const STATE_WORDS = {
  discovering: 'Looking for clips to convert',
  waiting: 'Getting the next clip ready',
  staging: 'Copying clips to work on',
  encoding: 'Converting',
  'writing-telemetry': 'Putting the driving data back in',
  verifying: 'Checking each result',
  copying: 'Saving the checked copies',
  replacing: 'Swapping in the smaller files',
  paused: 'Paused',
  paused_network: 'Waiting for the connection to come back',
  completed: 'All done',
  cancelled: 'Stopped',
  failed: 'Stopped because of a problem',
};
export const CODEC_WORD = { h265: 'H.265', av1: 'AV1' };
export const PROFILE_WORD = {
  conservative: 'Light (about 5% smaller)',
  balanced: 'Balanced (about 20% smaller)',
  aggressive: 'Strong (about 50% smaller)',
  quality: 'Constant quality',
  custom: 'Custom bitrate',
};
export const GROUP_WORD = {
  RecentClips: 'Drives',
  SavedClips: 'Saved clips',
  SentryClips: 'Sentry events',
};
export const GROUPS = ['RecentClips', 'SavedClips', 'SentryClips'];
export const ERROR_WORDS = {
  SOURCE_REQUIRED: 'Pick a vehicle first.',
  DESTINATION_REQUIRED: 'Choose where the copies should go.',
  GROUP_REQUIRED: 'Pick at least one kind of footage.',
  REPLACEMENT_CONFIRMATION_REQUIRED: 'Tick the box to confirm that the originals may be replaced.',
  REPLACEMENT_UNAVAILABLE:
    'Replacing originals isn’t possible on this storage. Make copies instead.',
  PATH_NOT_ALLOWED: 'That folder is outside the vehicle footage and the output folders.',
  PATH_OVERLAP: 'The copies can’t go inside the footage folder itself. Pick another folder.',
  PATH_UNAVAILABLE: 'That folder can’t be reached right now.',
  JOB_ACTIVE: 'Something is converting already. Wait for it to finish, or stop it first.',
  BENCHMARK_ACTIVE: 'A speed test is already running.',
  BENCHMARK_SOURCE_REQUIRED: 'There are no clips to test with yet.',
  INVALID_LANES: 'Those device settings can’t be used. Reload the page and set them again.',
  DEVICE_UNSUPPORTED:
    'One of the GPUs can’t encode this format. Set it to Off or pick another format.',
  AUTO_CONFIG_REQUIRED: 'Automatic conversion needs a vehicle and settings first.',
  INVALID_AUTO_WINDOW: 'Pick different start and end hours.',
  CONVERTER_STARTING: 'The converter is still starting. Try again in a moment.',
  RECOVERY_REQUIRED:
    'This job stopped in the middle of replacing a file. Resume it so it can finish safely.',
  INVALID_MANIFEST: 'This job’s record couldn’t be updated. Use Stop to set it aside.',
  CANCELLED: 'Cancelled.',
};
export const describe = (err) => {
  if (err?.code === 'DEVICE_UNSUPPORTED' && err.details?.device)
    return `${err.details.device} can’t encode ${CODEC_WORD[err.details.codec] || err.details.codec}. Set it to Off or pick another format.`;
  return (
    ERROR_WORDS[err?.code] ||
    (typeof err?.code === 'string' && /\s/.test(err.code)
      ? err.code
      : err?.code
        ? `The converter said: ${String(err.code).toLowerCase().replace(/_/g, ' ')}.`
        : err?.message || 'Something went wrong.')
  );
};

/** Counts of a snapshot, whether its item list is complete or trimmed. */
export function counts(s) {
  const items = Array.isArray(s?.items) ? s.items : [];
  const n = (state) => s?.itemStateCounts?.[state] ?? items.filter((i) => i.state === state).length;
  const total = s?.itemCount ?? items.length;
  const completed = n('completed');
  const skipped = n('skipped');
  const failed = n('failed');
  const queued = n('queued');
  const inFlight =
    s?.itemStateCounts?.active ?? items.filter((i) => i.state === 'processing').length;
  return {
    total,
    completed,
    skipped,
    failed,
    queued,
    inFlight,
    done: completed + skipped + failed,
    failedItems: items.filter((i) => i.state === 'failed'),
    keptItems: items.filter((i) => i.state === 'completed' && i.offTarget),
  };
}

export function workingMs(s, at = Date.now()) {
  if (!s || !Number.isFinite(s.createdAt)) return 0;
  const stopped = !ACTIVE.has(s.state) || PAUSED.has(s.state);
  const end = stopped ? (Number.isFinite(s.updatedAt) ? s.updatedAt : s.createdAt) : at;
  return Math.max(0, end - s.createdAt - (Number.isFinite(s.pausedMs) ? s.pausedMs : 0));
}

/** Files per minute and the time left, from recent progress. */
export class Pace {
  constructor() {
    this.samples = [];
    this.jobId = null;
  }
  read(s) {
    if (!s) return { perMinute: null, leftMs: null };
    if (s.id !== this.jobId) {
      this.jobId = s.id;
      this.samples = [];
    }
    const c = counts(s);
    const finished = c.completed + c.failed;
    const remaining = c.queued + c.inFlight;
    const now = Date.now();
    if (PAUSED.has(s.state)) this.samples = [];
    if (!this.samples.length || this.samples[this.samples.length - 1].done !== finished)
      this.samples.push({ t: now, done: finished });
    while (this.samples.length > 2 && now - this.samples[1].t > 120000) this.samples.shift();
    let perMinute = null;
    const first = this.samples[0];
    if (this.samples.length > 1 && now - first.t >= 15000 && finished > first.done)
      perMinute = (finished - first.done) / ((now - first.t) / 60000);
    else if (finished > 0 && workingMs(s, now) >= 15000)
      perMinute = finished / (workingMs(s, now) / 60000);
    if (!ACTIVE.has(s.state) && finished > 0 && workingMs(s, now) > 0)
      perMinute = finished / (workingMs(s, now) / 60000);
    if (!perMinute || !Number.isFinite(perMinute)) return { perMinute: null, leftMs: null };
    return {
      perMinute,
      leftMs: ACTIVE.has(s.state) && remaining > 0 ? (remaining / perMinute) * 60000 : null,
    };
  }
}

// ---------- the shared live stream ----------
const live = {
  known: false,
  source: null,
  snap: null,
  revision: -1,
  nodeWaiting: null,
  listeners: new Set(),
  bench: new Set(),
  subscribed: false,
  retry: 1000,
};

function deliver() {
  for (const fn of [...live.listeners]) {
    try {
      fn(live.snap, live.nodeWaiting);
    } catch (err) {
      console.warn(err);
    }
  }
}

/** Take a snapshot (full or progress-only) into the shared state. */
export function applySnapshot(next) {
  live.known = true;
  if (!next) {
    // no job (or the last one was put away)
    live.snap = null;
    deliver();
    return;
  }
  if (!next.state) {
    // progress only: the current job's live numbers
    if (live.snap && next.id === live.snap.id && next.progress) {
      live.snap = { ...live.snap, progress: next.progress };
      if (Number.isSafeInteger(next.progress.waitingOnNode))
        live.nodeWaiting = {
          jobId: next.id,
          count: next.progress.waitingOnNode,
          encoding: next.progress.encodingNow ?? null,
        };
    }
  } else if (
    !live.snap ||
    next.id !== live.snap.id ||
    (next.revision ?? 0) >= (live.snap.revision ?? 0)
  ) {
    // a newer job, or a newer version of this one (a finished old job never replaces a running one)
    if (
      live.snap &&
      next.id !== live.snap.id &&
      ACTIVE.has(live.snap.state) &&
      !ACTIVE.has(next.state) &&
      (next.updatedAt || 0) < (live.snap.updatedAt || 0)
    )
      return;
    live.snap = {
      ...next,
      progress: next.progress ?? (live.snap?.id === next.id ? live.snap.progress : undefined),
    };
  }
  deliver();
}

// Each connection has a generation and scope; no callback survives close().
let generation = 0,
  retryTimer = null,
  stream = null;
const subscribers = new Map();
const hasSubscribers = () => [...subscribers.values()].some((owner) => owner.alive());
function close() {
  generation++;
  clearTimeout(retryTimer);
  retryTimer = null;
  stream?.abort();
  stream = null;
  live.source?.close();
  live.source = null;
  live.subscribed = false;
}
function openStream() {
  if (live.source || !hasSubscribers()) return;
  clearTimeout(retryTimer);
  retryTimer = null;
  const ticket = ++generation;
  const owner = scope([], { alive: () => ticket === generation && hasSubscribers() });
  stream = owner;
  const valid = () => ticket === generation && owner.alive();
  const invoke = (name) => {
    owner.check();
    const caller = [...subscribers.values()].find((s) => s.alive());
    return caller.invoke(name, undefined, { signal: owner.signal });
  };
  const es = new EventSource(`/api/converter/events?client=${encodeURIComponent(clientId)}`);
  live.source = es;
  const snapshot = async () => {
    const next = await invoke('getCurrent');
    if (valid()) applySnapshot(next);
  };
  es.addEventListener('hello', async () => {
    if (!valid()) return;
    live.retry = 1000;
    try {
      await invoke('subscribeProgress');
      if (!valid()) return;
      live.subscribed = true;
      await snapshot();
    } catch {
      /* Closing or a converter still starting needs no follow-up. */
    }
  });
  es.addEventListener('converter:progress', (e) => {
    if (!valid()) return;
    try {
      applySnapshot(JSON.parse(e.data).snapshot);
    } catch {
      /* ignore malformed data */
    }
  });
  es.addEventListener('converter:benchmarkProgress', (e) => {
    if (!valid()) return;
    try {
      for (const fn of [...live.bench]) fn(JSON.parse(e.data));
    } catch {
      /* ignore malformed data */
    }
  });
  es.addEventListener('error', () => {
    if (!valid() || es.readyState !== EventSource.CLOSED) return;
    close();
    const retryGeneration = generation;
    if (hasSubscribers())
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (retryGeneration === generation && hasSubscribers()) openStream();
      }, live.retry);
    live.retry = Math.min(live.retry * 2, 30000);
  });
  snapshot().catch(() => {
    if (valid()) deliver();
  });
}
function subscribe(set, fn, owner) {
  const ownScope = !owner;
  owner ||= scope();
  const listener = (...args) => {
    if (owner.alive()) fn(...args);
  };
  const stop = () => {
    owner.signal.removeEventListener('abort', stop);
    set.delete(listener);
    subscribers.delete(listener);
    if (ownScope) owner.abort();
    if (!hasSubscribers()) close();
  };
  if (!owner.alive()) return stop;
  set.add(listener);
  subscribers.set(listener, owner);
  owner.signal.addEventListener('abort', stop, { once: true });
  openStream();
  if (set === live.listeners && live.known) listener(live.snap, live.nodeWaiting);
  return stop;
}
/** Follow the converter while the caller's page scope is alive. */
export function follow(fn, owner) {
  return subscribe(live.listeners, fn, owner);
}
export function onBenchmark(fn, owner) {
  return subscribe(live.bench, fn, owner);
}
/** Wait for subscription, without leaving a timer behind on navigation. */
export function streamReady(owner) {
  owner.check();
  openStream();
  return new Promise((resolve) => {
    let timer;
    const end = () => {
      clearTimeout(timer);
      owner.signal.removeEventListener('abort', end);
      resolve();
    };
    owner.signal.addEventListener('abort', end, { once: true });
    const deadline = Date.now() + 4000;
    const check = () => {
      if (!owner.alive() || !hasSubscribers() || live.subscribed || Date.now() >= deadline) end();
      else timer = setTimeout(check, 100);
    };
    check();
  });
}
export const currentSnapshot = () => live.snap;

/** Hardware comes from /api/stats.encoder, never the numeric clip counter. */
export function hardwareLabel(snapshot, encoder) {
  if (encoder?.jobId !== snapshot?.id) return '';
  const devices = encoder.devices?.length
    ? encoder.devices
    : encoder.device
      ? [encoder.device]
      : [];
  return [
    ...new Set(
      devices.map((d) =>
        [d.name || d.gpuName || (d.hardware ? d.node || 'GPU' : 'CPU'), d.encoder]
          .filter(Boolean)
          .join(' · '),
      ),
    ),
  ].join(', ');
}
