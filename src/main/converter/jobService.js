'use strict';

const {
  CONCURRENCY,
  TIMING_PHASES,
  addItemTimings,
  isValidConcurrency,
  normalizeLanes,
  lanesTotal,
  createEmptyCounters,
  addCompletedFile,
  serializeSummary,
  targetOutputBytes,
  hasSizeTarget,
  effectiveVerifyMode
} = require('./contracts');
const { replacementAction } = require('./jobStore');
const {
  SAFE_VIDEO_BITRATE_FLOORS,
  buildEncodeArgs,
  calculateInitialBitrate,
  decideSizeRetry
} = require('./encoderPlanner');
const { leadInHoldFrames } = require('./leadIn');

const ACTIVE_STATES = new Set([
  'discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry',
  'verifying', 'copying', 'replacing', 'paused', 'paused_network'
]);
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'skipped']);
// Clips each node (another server) is sent beyond its conversions at once
const NODE_SEND_AHEAD = 15;
// Clips a node gave back (it failed, went away, or its pictures did not
// match) encoded on this server at once: a node's whole send-ahead queue
// failing over never starts dozens of encodes here.
const NODE_FALLBACK_AT_ONCE = 2;
const SAFE_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REPLACEMENT_PHASES = new Set([
  'candidate-written', 'original-backed-up', 'candidate-promoted',
  'final-validated', 'backup-deleted', 'rollback-started',
  'backup-restored', 'rollback-failed'
]);
const OWNED_KEYS = new Set([
  'stagedSource', 'encodedCandidate', 'publicationSnapshot',
  'destinationPartial', 'replacementCandidate', 'replacementBackup'
]);

class ConverterJobServiceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ConverterJobServiceError';
    this.code = code;
  }
}

const MAX_RECORDED_ATTEMPTS = 3; // jobStore rejects more
// Not smaller with a quality level or custom bitrate: encode again at these
// shares of the original's size before keeping the original.
const UNDER_SOURCE_SHARES = Object.freeze([0.85, 0.6]);
// Retries of an operation whose "network" error came while nothing was down
// (see waitForNetwork) before it counts as a plain failure.
const QUICK_RETRY_LIMIT = 2;
// States in which a job is not working: time spent in them is left out of its
// elapsed time and average speed (a retry restarts a finished job).
const IDLE_JOB_STATES = new Set(['paused', 'paused_network', 'completed', 'skipped', 'failed', 'cancelled']);

function serviceError(code) {
  return new ConverterJobServiceError(code);
}

// ffmpeg -progress keys reported per running clip (see activeEncodes).
const LIVE_COUNTERS = Object.freeze({
  frame: 'frame', drop_frames: 'dropFrames', dup_frames: 'dupFrames', total_size: 'totalSizeB'
});

function progressCount(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

// "1.23x" or "1234.5kbits/s"; "N/A" until ffmpeg knows.
function progressRate(value, scale) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * scale) / scale : null;
}

// The GPU an encode uses, when its arguments name one: a render node
// (VA-API, or QSV opened on a chosen GPU) or an NVIDIA GPU chosen by index
// ("nvidia1", as the stats engine names it).
function renderDevice(args) {
  for (let index = 0; index < args.length - 1; index += 1) {
    const value = args[index + 1];
    if (typeof value !== 'string') continue;
    if ((args[index] === '-vaapi_device' || args[index] === '-hwaccel_device') && value.startsWith('/dev/')) return value;
    if (args[index] === '-gpu' && /^\d+$/.test(value)) return `nvidia${value}`;
    if (args[index] === '-init_hw_device') {
      const child = /(?:^|,)child_device=(\/dev\/[^,]+)/.exec(value);
      if (child) return child[1];
    }
  }
  return null;
}

// Only read-only waits may be detached on abort. Their late results are observed,
// but cannot continue recovery or start a transaction after shutdown.
function abortableRead(operation, signal) {
  if (signal.aborted) return Promise.reject(serviceError('CANCELLED'));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(serviceError('CANCELLED')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw serviceError('CANCELLED');
      return operation();
    }).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(serviceError('CANCELLED')); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function stableFailure(error, fallback = 'operation-failed') {
  const raw = typeof error?.code === 'string' ? error.code.toLowerCase().replace(/_/g, '-') : fallback;
  return SAFE_CODE.test(raw) ? raw : fallback;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function composeOwnership(base = {}, incoming = {}, clearKeys = []) {
  const ownedPaths = { ...(base.ownedPaths || {}) };
  const ownedArtifacts = { ...(base.ownedArtifacts || {}) };
  const incomingClears = Array.isArray(incoming.clearOwnedKeys) ? incoming.clearOwnedKeys : [];
  for (const key of [...clearKeys, ...incomingClears]) {
    if (!OWNED_KEYS.has(key)) continue;
    delete ownedPaths[key];
    delete ownedArtifacts[key];
  }
  for (const [key, value] of Object.entries(incoming.ownedPaths || {})) {
    if (OWNED_KEYS.has(key)) ownedPaths[key] = value;
  }
  for (const [key, value] of Object.entries(incoming.ownedArtifacts || {})) {
    if (OWNED_KEYS.has(key)) ownedArtifacts[key] = value;
  }
  const result = { ownedPaths, ownedArtifacts };
  if (Object.prototype.hasOwnProperty.call(incoming, 'publicationArtifact')) {
    if (incoming.publicationArtifact) result.publicationArtifact = incoming.publicationArtifact;
  } else if (base.publicationArtifact) result.publicationArtifact = base.publicationArtifact;
  if (incoming.clearPublicationArtifact === true) delete result.publicationArtifact;
  return result;
}

function ownershipOf(value) {
  return composeOwnership({}, value || {});
}

const PRIVATE_SNAPSHOT_KEYS = ['ownedPaths', 'ownedArtifacts', 'publicationArtifact'];

// A finished clip keeps empty ownership ({}): that holds nothing private.
function carriesPrivate(item, key) {
  if (!Object.prototype.hasOwnProperty.call(item, key)) return false;
  const value = item[key];
  if (value === null || value === undefined) return false;
  return typeof value !== 'object' || Object.keys(value).length > 0;
}

// Frozen items (the job store's own validated copies) cannot change, so the
// snapshot reuses them when they carry nothing private instead of copying
// every item of a large job on each update. Without the empty-ownership case
// every converted clip was copied again on each of the ~40 updates per clip,
// and a 30,000-clip job got slower the further it went.
function publicItem(item) {
  if (Object.isFrozen(item) && item && typeof item === 'object'
      && !PRIVATE_SNAPSHOT_KEYS.some((key) => carriesPrivate(item, key))) return item;
  const safeItem = clone(item);
  for (const key of PRIVATE_SNAPSHOT_KEYS) delete safeItem[key];
  return safeItem;
}

function publicSnapshot(manifest) {
  const snapshot = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'items' || PRIVATE_SNAPSHOT_KEYS.includes(key)) continue;
    snapshot[key] = value && typeof value === 'object' && !Object.isFrozen(value) ? clone(value) : value;
  }
  snapshot.items = (manifest.items || []).map(publicItem);
  return deepFreeze(snapshot);
}

function validateDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('dependencies are required');
  for (const [name, method] of [
    ['store.create', deps.store?.create],
    ['store.transition', deps.store?.transition],
    ['store.load', deps.store?.load],
    ['store.list', deps.store?.list],
    ['scanner', deps.scanner],
    ['planner.select', deps.planner?.select],
    ['planner.selectCpuFallback', deps.planner?.selectCpuFallback],
    ['stagingManager.reserveEncodeOutput', deps.stagingManager?.reserveEncodeOutput],
    ['stagingManager.adoptEncodeOutput', deps.stagingManager?.adoptEncodeOutput],
    ['stagingManager.copyAsset', deps.stagingManager?.copyAsset],
    ['stagingManager.publishSeparate', deps.stagingManager?.publishSeparate],
    ['stagingManager.replaceOriginal', deps.stagingManager?.replaceOriginal],
    ['stagingManager.cleanupOwnedArtifacts', deps.stagingManager?.cleanupOwnedArtifacts],
    ['ensureDestinationParent', deps.ensureDestinationParent],
    ['inspectVideo', deps.inspectVideo],
    ['readTimeline', deps.readTimeline],
    ['verifier', deps.verifier],
    ['spawnProcess', deps.spawnProcess]
  ]) {
    if (typeof method !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (typeof deps.writers?.h265 !== 'function' || typeof deps.writers?.av1 !== 'function') {
    throw new TypeError('codec writers are required');
  }
}

class BoundedQueue {
  constructor(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('queueLimit must be a positive safe integer');
    this.limit = limit;
    this.values = [];
    this.pushWaiters = [];
    this.shiftWaiters = [];
    this.closed = false;
  }

  async push(value) {
    if (this.closed) throw serviceError('QUEUE_CLOSED');
    if (this.shiftWaiters.length) {
      this.shiftWaiters.shift()({ value, done: false });
      return;
    }
    while (!this.closed && this.values.length >= this.limit) {
      await new Promise((resolve) => this.pushWaiters.push(resolve));
    }
    if (this.closed) throw serviceError('QUEUE_CLOSED');
    this.values.push(value);
  }

  async shift() {
    if (this.values.length) {
      const value = this.values.shift();
      this.pushWaiters.shift()?.();
      return { value, done: false };
    }
    if (this.closed) return { value: undefined, done: true };
    return new Promise((resolve) => this.shiftWaiters.push(resolve));
  }

  // A value taken by a worker that then stops (fewer at once) goes back to
  // the front, to another waiting worker first.
  unshift(value) {
    if (this.shiftWaiters.length) {
      this.shiftWaiters.shift()({ value, done: false });
      return;
    }
    this.values.unshift(value);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.shiftWaiters.splice(0)) resolve({ value: undefined, done: true });
    for (const resolve of this.pushWaiters.splice(0)) resolve();
  }
}

function createConverterJobService(deps) {
  validateDependencies(deps);
  const store = deps.store;
  const scanner = deps.scanner;
  const planner = deps.planner;
  const staging = deps.stagingManager;
  // GPU decoding is an optimisation only. An encoder whose GPU decode proved
  // unusable is not offered it again; verify stops after repeated fallbacks.
  // With a GPU chosen per lane the records are per GPU: one GPU's broken
  // decode does not turn it off on another.
  const encodeDecodeBroken = new Set();
  const verifyDecodeFallbacks = new Map();
  const VERIFY_DECODE_FALLBACK_LIMIT = 3;
  const laneDevice = (encoder) => (encoder?.device && encoder.device.kind !== 'cpu' ? encoder.device : null);
  const decodeKey = (encoder) => `${laneDevice(encoder) ? `${laneDevice(encoder).id}|` : ''}${encoder.codec}`;
  function accelArgs(encoder, options) {
    try {
      const device = laneDevice(encoder);
      const args = deps.decodeAccel(encoder.codec, device ? { ...(options || {}), device } : options);
      return Array.isArray(args) && args.length > 0 ? args : null;
    } catch (_) { return null; }
  }
  function decodeAccelFor(encoder, purpose) {
    // a node decodes its clips itself; verifying here decodes on this CPU
    if (encoder?.hardware !== true || encoder.remote === true || typeof deps.decodeAccel !== 'function') return null;
    if (purpose === 'verify' && (verifyDecodeFallbacks.get(decodeKey(encoder)) || 0) >= VERIFY_DECODE_FALLBACK_LIMIT) return null;
    return accelArgs(encoder);
  }
  // Encode decode tiers, fastest first: GPU frames kept on the GPU (zero-copy),
  // then GPU decode, then (implicitly, after the list) CPU decode. A clip
  // whose lead-in frames are held (leadIn.js) skips zero-copy: the frame
  // repeat runs on system-memory frames, and a failure there must not rule
  // zero-copy out for the clips that start on a keyframe.
  function encodeDecodeTiers(encoder, { zeroCopy = true } = {}) {
    if (encoder?.hardware !== true || encoder.remote === true || typeof deps.decodeAccel !== 'function') return [];
    return [
      ...(zeroCopy ? [{ key: `${decodeKey(encoder)}:zero-copy`, args: accelArgs(encoder, { zeroCopy: true }) }] : []),
      { key: `${decodeKey(encoder)}:gpu`, args: accelArgs(encoder) }
    ].filter((tier) => tier.args && !encodeDecodeBroken.has(tier.key));
  }
  const pathApi = deps.pathApi || require('path');
  const clock = deps.clock || { now: Date.now, sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) };
  const network = deps.network || {
    isRetryable: (error) => [
      'ENOENT', 'ENOTCONN', 'ENETDOWN', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EIO'
    ].includes(error?.code),
    checkPath: async () => true
  };
  const backoff = {
    initialMs: deps.networkBackoff?.initialMs || 1_000,
    maximumMs: deps.networkBackoff?.maximumMs || 30_000
  };
  if (!Number.isSafeInteger(backoff.initialMs) || backoff.initialMs < 1
      || !Number.isSafeInteger(backoff.maximumMs) || backoff.maximumMs < backoff.initialMs) {
    throw new RangeError('network backoff must use positive bounded integers');
  }
  const ffmpegPath = deps.ffmpegPath || 'ffmpeg';
  const encodeStallMs = deps.encodeStallMs || 10 * 60_000;
  // Monotonic clock for per-phase timings (kept separate from deps.clock, which
  // stamps manifests).
  const timingNow = deps.timingNow || (() => performance.now());

  // Attributes elapsed time to phases: mark(phase) charges everything since the
  // previous mark to that phase (retries accumulate).
  function createItemTiming() {
    const phases = Object.fromEntries(TIMING_PHASES.map((phase) => [phase, 0]));
    const started = timingNow();
    let last = started;
    return {
      mark(phase) {
        const now = timingNow();
        phases[phase] += Math.max(0, now - last);
        last = now;
      },
      result() {
        const rounded = Object.fromEntries(Object.entries(phases).map(([phase, ms]) => [phase, Math.round(ms)]));
        return { phases: rounded, totalMs: Math.round(timingNow() - started) };
      }
    };
  }
  const queueLimit = deps.queueLimit || 4;
  // Clips already converted are skipped while discovering: from the
  // converted-clips index without opening the file, or from a quick read of
  // the MP4 header, a few at a time and never in an encode slot.
  const convertedIndex = typeof deps.convertedIndex?.has === 'function' && typeof deps.convertedIndex?.add === 'function'
    ? deps.convertedIndex : null;
  const headerCheckConcurrency = deps.headerCheckConcurrency || 8;
  const headerCheckTimeoutMs = deps.headerCheckTimeoutMs || 20_000;
  if (!Number.isSafeInteger(headerCheckConcurrency) || headerCheckConcurrency < 1
      || !Number.isSafeInteger(headerCheckTimeoutMs) || headerCheckTimeoutMs < 1) {
    throw new RangeError('header checks must use positive bounded integers');
  }
  // Index entries for clips that just finished converting (one stat each),
  // written before the job's end flushes the index.
  const indexWrites = new Set();
  // Discovery persists newly found items in batches. 1 keeps the original
  // persist-each-item-before-enqueue cadence; larger values avoid rewriting the
  // whole manifest once per discovered file.
  const discoveryBatchSize = deps.discoveryBatchSize || 1;
  const discoveryFlushMs = deps.discoveryFlushMs ?? 250;
  if (!Number.isSafeInteger(discoveryBatchSize) || discoveryBatchSize < 1
      || !Number.isSafeInteger(discoveryFlushMs) || discoveryFlushMs < 0) {
    throw new RangeError('discovery batching must use positive bounded integers');
  }
  const jobs = new Map();
  const listeners = new Set();
  // Live job snapshots go out at most this often while a job works (the
  // latest one wins); entering or leaving a pause, an outage, the end, and
  // any recovery, failure or summary change go out at once. 0: every change.
  const snapshotIntervalMs = deps.snapshotIntervalMs ?? 250;
  if (!Number.isSafeInteger(snapshotIntervalMs) || snapshotIntervalMs < 0) {
    throw new RangeError('snapshotIntervalMs must be a non-negative integer');
  }
  let shuttingDown = false;
  let commandChain = Promise.resolve();

  function serializeCommand(operation) {
    const result = commandChain.catch(() => undefined).then(operation);
    commandChain = result;
    return result;
  }

  function emit(runtime, type, fields = {}) {
    if (listeners.size === 0) return;
    // Snapshots are already detached, deep-frozen copies; cloning them again
    // per event was a full extra pass over every manifest item.
    const detached = {};
    for (const [key, value] of Object.entries(fields)) {
      detached[key] = value && typeof value === 'object' && Object.isFrozen(value) ? value : clone(value);
    }
    const event = deepFreeze({
      type,
      jobId: runtime.manifest.id,
      revision: runtime.manifest.revision,
      ...detached
    });
    for (const listener of [...listeners]) {
      try { listener(event); } catch (_) { /* listener isolation */ }
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function runtimeFor(manifest) {
    return {
      manifest,
      queue: new BoundedQueue(queueLimit),
      producerDone: false,
      pauseRequested: false,
      cancelRequested: false,
      stopRequested: false,
      pauseWaiters: [],
      // Per-item worker state. With concurrency 1 there is at most one entry,
      // which reproduces the original single-worker pipeline exactly.
      children: new Map(),
      encodeFps: new Map(),
      // Live numbers of each running ffmpeg, for activeEncodes().
      encodes: new Map(),
      ownerships: new Map(),
      inFlight: new Set(),
      leadItemId: null,
      commitHolder: null,
      commitWaiters: [],
      liveWorkers: 0,
      parkedWorkers: 0,
      pausePersisted: false,
      abortController: new AbortController(),
      runPromise: null,
      runKind: null,
      persistChain: Promise.resolve(),
      snapshotTimer: null,
      scannerStarted: false,
      itemSequence: manifest.items.length,
      stopPhase: null,
      stopItemId: null,
      stopWhilePaused: false,
      // Workers per lane (one lane per chosen GPU; null is the default lane
      // of a job without lanes): { live, retiring }.
      laneCounters: new Map(),
      // The lanes whose GPUs were found, while the job runs with lanes.
      lanePlan: null,
      // The device a job without lanes encodes on, once a switch between
      // no lanes and lanes needed it (see deviceActive).
      defaultLane: undefined,
      addWorker: null
    };
  }

  function update(runtime, buildPatch) {
    const operation = runtime.persistChain.catch(() => undefined).then(async () => {
      let patch = typeof buildPatch === 'function' ? buildPatch(runtime.manifest) : buildPatch;
      // nothing to change: no write
      if (patch === null) return runtime.manifest;
      // A network wait recorded by one worker describes that worker's item.
      // When another worker's progress takes over the job-level state (it
      // holds the save slot now), that record goes with it: the job file
      // only accepts a recovery record on a paused job, and rejecting the
      // write stopped every worker and even Cancel.
      if (patch && typeof patch.state === 'string' && patch.state !== 'paused' && patch.state !== 'paused_network'
          && !('recovery' in patch) && runtime.manifest.recovery?.fromState === 'paused_network') {
        patch = { ...patch, recovery: null };
      }
      // Stamp state changes so a finished job knows when it finished (elapsed
      // time and average speed after completion).
      if (patch && typeof patch.state === 'string' && patch.state !== runtime.manifest.state && !('updatedAt' in patch)) {
        const at = clock.now();
        patch = { ...patch, updatedAt: at };
        // Leaving a pause (including one across an app restart) or retrying a
        // finished job: that time was not working time. updatedAt marks when
        // the idle state began.
        const previous = runtime.manifest;
        if (IDLE_JOB_STATES.has(previous.state) && Number.isSafeInteger(previous.updatedAt)
            && Number.isSafeInteger(at) && at > previous.updatedAt) {
          patch.pausedMs = (Number.isSafeInteger(previous.pausedMs) ? previous.pausedMs : 0) + (at - previous.updatedAt);
        }
      }
      const previous = runtime.manifest;
      runtime.manifest = await store.transition(runtime.manifest.id, patch);
      queueSnapshot(runtime, snapshotUrgent(previous, runtime.manifest));
      return runtime.manifest;
    });
    runtime.persistChain = operation;
    return operation;
  }

  // jobChanges apply only while the clip leads; a clip that does not lead and
  // has nothing of its own to change writes nothing (with six at once most
  // state updates were exactly that: an unchanged clip written again).
  // With six clips at once the job-level state changes on almost every write
  // (encoding, verifying, replacing...): those wait for the next snapshot.
  function snapshotUrgent(previous, next) {
    if (previous.state !== next.state && (IDLE_JOB_STATES.has(previous.state) || IDLE_JOB_STATES.has(next.state))) return true;
    const same = (key) => previous[key] === next[key] || JSON.stringify(previous[key] ?? null) === JSON.stringify(next[key] ?? null);
    return !same('recovery') || !same('failure') || !same('summary') || previous.summaryDismissed !== next.summaryDismissed;
  }

  // Nothing is built while nobody listens; otherwise the snapshot is built
  // when it goes out, from the job as it is then.
  function queueSnapshot(runtime, urgent) {
    if (listeners.size === 0) return;
    if (urgent || snapshotIntervalMs === 0) {
      if (runtime.snapshotTimer) {
        clearTimeout(runtime.snapshotTimer);
        runtime.snapshotTimer = null;
      }
      emit(runtime, 'snapshot', { snapshot: publicSnapshot(runtime.manifest) });
      return;
    }
    if (runtime.snapshotTimer) return;
    runtime.snapshotTimer = setTimeout(() => {
      runtime.snapshotTimer = null;
      if (listeners.size > 0) emit(runtime, 'snapshot', { snapshot: publicSnapshot(runtime.manifest) });
    }, snapshotIntervalMs);
    runtime.snapshotTimer.unref?.();
  }

  function itemPatch(runtime, itemId, changes, jobChanges = {}) {
    return update(runtime, (current) => {
      const lead = isLead(runtime, itemId);
      if (!lead && Object.keys(changes).length === 0) return null;
      return {
        ...(lead ? jobChanges : {}),
        items: current.items.map((item) => item.id === itemId ? mergeItem(item, changes) : item)
      };
    });
  }

  function ownershipFor(runtime, itemId) {
    return runtime.ownerships.get(itemId) || null;
  }

  function setOwnership(runtime, itemId, value) {
    if (value) runtime.ownerships.set(itemId, value);
    else runtime.ownerships.delete(itemId);
  }

  function concurrencyOf(manifest) {
    const value = manifest?.config?.concurrency;
    return isValidConcurrency(value) ? value : CONCURRENCY.fallback;
  }

  // Several GPUs, each set by hand: a lane per GPU with its own number of
  // conversions at once. Every worker belongs to one lane (null is the
  // default lane, the only one of a job without lanes) and takes the next
  // queued clip whenever it is free, so a faster GPU simply converts more.
  function lanesOf(manifest) {
    const lanes = manifest?.config?.lanes;
    return Array.isArray(lanes) && lanes.length > 0 ? lanes : null;
  }

  function laneCounters(runtime, laneId) {
    if (!runtime.laneCounters.has(laneId)) runtime.laneCounters.set(laneId, { live: 0, retiring: 0 });
    return runtime.laneCounters.get(laneId);
  }

  // How many workers a lane may have now. Without lanes, or when none of the
  // job's GPUs is in the container, the default lane runs the whole job.
  function laneLimit(runtime, laneId) {
    const plan = runtime.lanePlan;
    if (!plan || plan.fallback) return laneId === null ? concurrencyOf(runtime.manifest) : 0;
    return laneId === null ? 0 : plan.limits.get(laneId) || 0;
  }

  // Finds each lane's GPU among the devices this container has now.
  async function resolveLanes(lanes) {
    const limits = new Map();
    const base = new Map(); // the lane's own number, without clips sent ahead
    const devices = new Map();
    for (const lane of lanes) {
      let device = null;
      try {
        device = typeof deps.resolveDevice === 'function' ? await deps.resolveDevice(lane.device) : null;
      } catch (_) { device = null; }
      if (device && device.id === lane.device) {
        // A node (another server) gets NODE_SEND_AHEAD more clips than it
        // converts at once: they are read and sent while it works, and wait
        // there for a free slot, so it never waits for this server.
        // (a node converts no more at once than its own setting, whatever
        // this lane says: more here would only be sent and checked here)
        const own = device.kind === 'node' && Number.isSafeInteger(device.slots) && device.slots > 0 ? Math.min(lane.concurrency, device.slots) : lane.concurrency;
        limits.set(lane.device, own + (device.kind === 'node' ? NODE_SEND_AHEAD : 0));
        base.set(lane.device, own);
        devices.set(lane.device, device);
      } else {
        console.warn(`[CONVERTER] Encoding device ${lane.device} is not in the container; its ${lane.concurrency} conversions at once are not started.`);
      }
    }
    return { fallback: devices.size === 0, limits, base, devices };
  }

  // A lane's workers that are not on their way out.
  function laneActive(runtime, laneId) {
    const counters = laneCounters(runtime, laneId);
    return counters.live - counters.retiring;
  }

  // The workers converting on a lane's device. A job switching between no
  // lanes and lanes runs the default lane and the lanes side by side until
  // the old workers finish their clip; the default lane encodes on the
  // device a job without lanes uses (runtime.defaultLane), so the two count
  // together there and that GPU never runs more at once than it was set to.
  function deviceActive(runtime, laneId) {
    const shared = runtime.defaultLane;
    if (laneId === null) return laneActive(runtime, null) + (shared ? laneActive(runtime, shared) : 0);
    return laneActive(runtime, laneId) + (shared && laneId === shared ? laneActive(runtime, null) : 0);
  }

  // Before switching between no lanes and lanes: the device a job without
  // lanes encodes on (looked up once; null when it cannot be told).
  async function noteDefaultLane(runtime, toLanes) {
    const fromLanes = Boolean(runtime.lanePlan && !runtime.lanePlan.fallback);
    if (fromLanes === toLanes || runtime.defaultLane !== undefined) return;
    let id = null;
    try {
      if (typeof deps.defaultDevice === 'function') id = await deps.defaultDevice(runtime.manifest.config.codec);
    } catch (_) { id = null; }
    if (runtime.defaultLane === undefined) runtime.defaultLane = typeof id === 'string' && id ? id : null;
  }

  // The workers each lane is missing (more at once, a lane just added, or
  // old workers on the same GPU that have finished their clip).
  function startMissingWorkers(runtime) {
    if (typeof runtime.addWorker !== 'function' || runtime.cancelRequested || runtime.stopRequested) return;
    const plan = runtime.lanePlan;
    const lanes = !plan || plan.fallback ? [null] : [...plan.devices].map(([id, device]) => ({ id, device }));
    for (const lane of lanes) {
      const laneId = lane ? lane.id : null;
      for (let missing = laneLimit(runtime, laneId) - deviceActive(runtime, laneId); missing > 0; missing -= 1) {
        runtime.addWorker(lane);
      }
    }
  }

  // The job-level recovery fields (state, activeItemId, ownedPaths,
  // ownedArtifacts, publicationArtifact, replacementPhase, recovery) describe a
  // single item, because crash recovery reconciles exactly one active item. With
  // several workers only the "lead" item may write them:
  //   - the commit holder (publishing/replacing is exclusive, see acquireCommit),
  //   - otherwise the oldest in-flight item, or any item when it runs alone.
  // Every other in-flight item persists its ownership on the item itself and is
  // cleaned up and re-queued by recovery (see releaseInterruptedItems).
  function isLead(runtime, itemId) {
    if (runtime.recoveryRequired) return itemId === runtime.recoveryItemId;
    if (runtime.commitHolder) return runtime.commitHolder === itemId;
    if (runtime.inFlight.size <= 1) return true;
    return runtime.leadItemId === itemId;
  }

  function leadItemId(runtime) {
    return runtime.commitHolder || runtime.leadItemId || null;
  }

  function beginItem(runtime, item) {
    runtime.inFlight.add(item.id);
    if (!runtime.leadItemId || !runtime.inFlight.has(runtime.leadItemId)) runtime.leadItemId = item.id;
    setOwnership(runtime, item.id, ownershipOf(item));
  }

  function finishItem(runtime, itemId) {
    const paths = Object.values(ownershipFor(runtime, itemId)?.ownedPaths || {});
    const item = currentItem(runtime, itemId);
    if (typeof staging.releaseLeases === 'function') {
      try { staging.releaseLeases([...paths, ...Object.values(item?.ownedPaths || {})]); } catch (_) { /* best effort */ }
    }
    runtime.inFlight.delete(itemId);
    runtime.ownerships.delete(itemId);
    runtime.children.delete(itemId);
    releaseCommit(runtime, itemId);
    if (runtime.leadItemId === itemId) runtime.leadItemId = runtime.inFlight.values().next().value || null;
  }

  // Publishing (copying) and in-place replacement run one item at a time so the
  // job-level recovery state always describes the item that is mid-transaction.
  // The holder keeps the slot until its outcome, success or failure, is
  // persisted (released in finishItem).
  async function acquireCommit(runtime, itemId) {
    let waited = false;
    while (runtime.commitHolder && runtime.commitHolder !== itemId) {
      waited = true;
      await new Promise((resolve) => runtime.commitWaiters.push(resolve));
    }
    if ((runtime.recoveryRequired && runtime.recoveryItemId !== itemId)
        || (waited && (runtime.cancelRequested || runtime.stopRequested))) {
      runtime.commitWaiters.shift()?.();
      throw serviceError('CANCELLED');
    }
    runtime.commitHolder = itemId;
  }

  function releaseCommit(runtime, itemId) {
    if (runtime.commitHolder !== itemId) return;
    runtime.commitHolder = null;
    runtime.commitWaiters.shift()?.();
  }

  function terminateChildren(runtime) {
    for (const entry of runtime.children.values()) {
      if (entry.terminationRequested) continue;
      entry.terminationRequested = true;
      entry.child.kill('SIGTERM');
    }
  }

  function mergeItem(item, changes) {
    const next = { ...item };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    return next;
  }

  // Records a file transaction step. scope 'item': on the clip only, never in
  // the job-level fields, whoever leads (a clip's files outside the save
  // slot, and the cleanup of clips other than the job's active one).
  // Replacement phases always go to the job: only the save slot holder
  // writes them, and recovery finds that clip by the job's activeItemId.
  function transactionPersistence(runtime, itemId, { scope = 'lead' } = {}) {
    return async (snapshot) => {
      const clearKeys = Array.isArray(snapshot.clearOwnedKeys) ? snapshot.clearOwnedKeys : [];
      let combined;
      const jobChanges = {};
      const phase = snapshot.phase && REPLACEMENT_PHASES.has(snapshot.phase) ? snapshot.phase : null;
      if (phase) {
        jobChanges.replacementPhase = phase;
        jobChanges.state = 'replacing';
        jobChanges.activeItemId = itemId;
      }
      await update(runtime, (current) => {
        const item = current.items.find((entry) => entry.id === itemId);
        combined = composeOwnership(item || current, snapshot, clearKeys);
        const itemChanges = { ...item, ...combined };
        if (!combined.publicationArtifact) delete itemChanges.publicationArtifact;
        if (phase) itemChanges.replacementPhase = phase;
        if (snapshot.itemFields?.expectedSource) itemChanges.expectedSource = snapshot.itemFields.expectedSource;
        if (!phase && (scope === 'item' || !isLead(runtime, itemId))) {
          return { items: current.items.map((entry) => entry.id === itemId ? itemChanges : entry) };
        }
        return {
          ...jobChanges,
          ownedPaths: combined.ownedPaths,
          ownedArtifacts: combined.ownedArtifacts,
          publicationArtifact: combined.publicationArtifact || null,
          items: current.items.map((entry) => entry.id === itemId ? itemChanges : entry)
        };
      });
      setOwnership(runtime, itemId, combined);
    };
  }

  function nextItemId(runtime) {
    runtime.itemSequence += 1;
    return `item-${String(runtime.itemSequence).padStart(6, '0')}`;
  }

  function createQueueItem(runtime, discovered, changes = {}) {
    const item = {
      ...clone(discovered),
      id: nextItemId(runtime),
      state: 'queued',
      attempts: 0,
      ...changes
    };
    // The inode only identifies the clip in the converted-clips index; the
    // job file has no field for it.
    delete item.ino;
    return item;
  }

  // Adding clips rewrites the whole job file. With batching on, a batch grows
  // with the job (a quarter of what it already holds), so finding 50,000
  // clips writes the file a few dozen times instead of hundreds; short of
  // that, a batch goes out on time only while the workers run short of clips
  // and it holds a clip for them (skipped clips give them nothing to do).
  function discoveryDue(runtime, pendingCount, lastFlush, pendingWork = pendingCount) {
    if (discoveryBatchSize === 1) return true;
    if (pendingCount >= Math.max(discoveryBatchSize, Math.floor(runtime.manifest.items.length / 4))) return true;
    if (pendingWork === 0) return false;
    const short = runtime.queue.values.length < concurrencyOf(runtime.manifest) * 2;
    return short && clock.now() - lastFlush >= discoveryFlushMs;
  }

  function withTimeout(promise, milliseconds, code) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(serviceError(code)), milliseconds);
        timer.unref?.();
      })
    ]).finally(() => clearTimeout(timer));
  }

  // 'h265' / 'av1' for a discovered clip that is already converted, from the
  // index (no file access at all) or else from its MP4 header; null leaves it
  // to the normal path (ffprobe in a worker), as does anything unexpected. A
  // share that drops meanwhile is waited for like any other discovery read.
  async function convertedCodecOf(runtime, discovered) {
    try {
      if (discovered?.kind !== 'video') return null;
      const recorded = convertedIndex ? convertedIndex.has(discovered) : null;
      if (recorded) return recorded;
      if (typeof deps.readVideoCodec !== 'function') return null;
      const signal = runtime.abortController.signal;
      const codec = await retryAffectedOperation(runtime, discovered.sourcePath, () => withTimeout(
        abortableRead(() => deps.readVideoCodec(discovered.sourcePath, { size: discovered.sourceBytes, signal }), signal),
        headerCheckTimeoutMs, 'HEADER_CHECK_TIMEOUT'
      ));
      if (codec !== 'h265' && codec !== 'av1') return null;
      convertedIndex?.add(discovered, codec);
      return codec;
    } catch (_) {
      return null;
    }
  }

  // A converted clip's new file (the original's path when replacing, else the
  // copy in the destination) goes into the index, so the next run skips it.
  // Best effort and off the worker's path: one stat, which a slow share must
  // not turn into a held worker.
  function rememberConverted(target, codec) {
    if (!convertedIndex || typeof deps.statFile !== 'function' || typeof target !== 'string') return;
    const pending = Promise.resolve().then(() => deps.statFile(target)).then((stat) => {
      if (!stat || (typeof stat.isFile === 'function' && !stat.isFile())) return;
      convertedIndex.add({ sourcePath: target, sourceBytes: Number(stat.size), mtimeMs: Number(stat.mtimeMs), ino: stat.ino }, codec);
    }).catch(() => undefined);
    indexWrites.add(pending);
    pending.finally(() => indexWrites.delete(pending));
  }

  async function flushConvertedIndex() {
    if (!convertedIndex) return;
    if (indexWrites.size > 0) {
      let timer;
      await Promise.race([
        Promise.allSettled([...indexWrites]),
        new Promise((resolve) => { timer = setTimeout(resolve, 10_000); timer.unref?.(); })
      ]);
      clearTimeout(timer);
    }
    try { await convertedIndex.flush?.(); } catch (_) { /* the index is an optimisation only */ }
  }

  async function produce(runtime) {
    runtime.scannerStarted = true;
    const identity = (item) => `${item.relativePath}\u0000${item.sourcePath}`;
    const known = new Set(runtime.manifest.items.map(identity));
    let pending = [];
    let pendingWork = 0;
    let lastFlush = -Infinity;
    const stopped = () => runtime.cancelRequested || runtime.stopRequested;
    // Items are always persisted before they are enqueued; batching only changes
    // how many share one manifest write. Skipped clips are persisted only.
    const flush = async () => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      pendingWork = 0;
      await update(runtime, (current) => ({ items: [...current.items, ...batch] }));
      if (discoveryBatchSize > 1) lastFlush = clock.now();
      for (const item of batch) {
        if (item.state === 'queued') await runtime.queue.push(item.id);
      }
    };
    // Header checks run ahead of the scan, a few at a time, while clips still
    // join the job in the order the scan found them.
    const checking = [];
    const settleNext = async () => {
      const { discovered, verdict } = checking.shift();
      const converted = await verdict;
      if (stopped()) return;
      if (converted) {
        pending.push(createQueueItem(runtime, discovered, {
          state: 'skipped', eligibleVideo: false, resultCode: 'already-converted'
        }));
      } else {
        pending.push(createQueueItem(runtime, discovered));
        pendingWork += 1;
      }
      if (discoveryDue(runtime, pending.length, lastFlush, pendingWork)) await flush();
    };
    try {
      for await (const discovered of scanner(runtime.manifest.config, {
        signal: runtime.abortController.signal,
        retryOperation: ({ path: affectedPath, operation }) => retryAffectedOperation(runtime, affectedPath, operation)
      })) {
        if (stopped()) break;
        const key = identity(discovered);
        if (known.has(key)) continue;
        // Automatic jobs skip clips an earlier automatic run already handled.
        if (typeof deps.skipDiscovered === 'function' && deps.skipDiscovered(runtime.manifest.config, discovered)) continue;
        known.add(key);
        checking.push({ discovered, verdict: convertedCodecOf(runtime, discovered) });
        while (checking.length >= headerCheckConcurrency && !stopped()) await settleNext();
      }
      while (checking.length > 0 && !stopped()) await settleNext();
      if (!stopped()) {
        await flush();
        await update(runtime, { discoveryComplete: true });
        void convertedIndex?.flush?.();
      }
      runtime.producerDone = true;
      runtime.queue.close();
    } catch (error) {
      runtime.producerDone = true;
      runtime.queue.close();
      const controlledAbort = runtime.cancelRequested || runtime.stopRequested || runtime.recoveryRequired
        || error?.name === 'AbortError' || error?.code === 'CANCELLED';
      if (!controlledAbort) {
        await update(runtime, {
          state: 'failed',
          activeItemId: null,
          summary: null,
          summaryDismissed: false,
          failure: { code: stableFailure(error, 'discovery-failed'), retryable: network.isRetryable(error) === true }
        });
        throw error;
      }
    }
  }

  // A pause lets in-flight items finish; the job reports "paused" once every
  // live worker has parked (with one worker that is immediately, as before).
  async function persistPauseWhenParked(runtime) {
    if (!runtime.pauseRequested || runtime.cancelRequested || runtime.pausePersisted) return;
    // A halted job (failed rollback, stop, fatal worker error) owns its own
    // job-level state; a pause must never overwrite it.
    if (runtime.recoveryRequired || runtime.stopRequested || runtime.halted) return;
    if (runtime.liveWorkers === 0 || runtime.parkedWorkers < runtime.liveWorkers) return;
    runtime.pausePersisted = true;
    await update(runtime, { state: 'paused', activeItemId: null });
    emit(runtime, 'paused');
  }

  async function waitWhilePaused(runtime) {
    if (!runtime.pauseRequested || runtime.cancelRequested) return;
    runtime.parkedWorkers += 1;
    try {
      const parked = new Promise((resolve) => runtime.pauseWaiters.push(resolve));
      await persistPauseWhenParked(runtime);
      await parked;
    } finally {
      runtime.parkedWorkers -= 1;
    }
  }

  // A path that is missing while a folder above it inside the footage is
  // still there (its event folder, SentryClips, ...) was moved or deleted
  // (the Recycle Bin, a retention policy, the car): waiting cannot bring it
  // back. When nothing between it and the footage's top folder is there, the
  // share may have dropped (an unmounted share leaves its empty mount folder
  // behind): that is an outage, as is the top folder itself and a
  // destination (which may not exist yet).
  async function goneWhileShareAnswers(runtime, target, pathRole) {
    const root = runtime.manifest.config.sourceRoot;
    if (pathRole === 'destination' || typeof root !== 'string') return false;
    const rootPath = pathApi.resolve(root);
    const targetPath = pathApi.resolve(target);
    const relative = pathApi.relative(rootPath, targetPath);
    if (relative === '') return false;
    // Outside the footage (the converter's own working files): the share
    // answering is enough.
    if (relative.startsWith('..') || pathApi.isAbsolute(relative)) return pathPresent(runtime, rootPath);
    for (let dir = pathApi.dirname(targetPath); dir !== rootPath && dir.length > rootPath.length; dir = pathApi.dirname(dir)) {
      if (await pathPresent(runtime, dir)) return true;
    }
    // A clip directly in the footage folder has no folder in between: then
    // other clips of this job still being there show the share answers (an
    // unmounted share has none). A few spread over the job are enough.
    const others = runtime.manifest.items.filter((entry) => entry.sourcePath
      && pathApi.resolve(entry.sourcePath) !== targetPath);
    for (const entry of [others[0], others[Math.floor(others.length / 2)], others[others.length - 1]]) {
      if (entry && await pathPresent(runtime, entry.sourcePath)) return true;
    }
    return false;
  }

  async function pathPresent(runtime, target) {
    const signal = runtime.abortController.signal;
    try {
      return await abortableRead(() => network.checkPath(target, { allowAncestor: false, signal }), signal) === true;
    } catch (_) { return false; }
  }

  // Resolves true after a real outage (the path or its share did not answer
  // for a while) and false when there was nothing to wait for: the path
  // answers again right away, or it is gone while the share answers. The
  // callers retry an operation a few times at most after a false, so an
  // error that is not about the network cannot loop forever.
  async function waitForNetwork(runtime, target, options = {}) {
    // Only one wait persists the job-level paused_network state; concurrent
    // workers waiting on the same outage just poll their own path.
    const persist = options.persist !== false && !runtime.networkPauseOwner
      && (!options.itemId || isLead(runtime, options.itemId));
    const item = currentItem(runtime, options.itemId || leadItemId(runtime) || runtime.manifest.activeItemId);
    const observedState = options.resumeState || runtime.manifest.state;
    const resumeState = observedState === 'discovering' && item ? 'waiting' : observedState;
    const phase = resumeState === 'replacing'
      ? (options.phase || runtime.manifest.replacementPhase)
      : undefined;
    const normalizedTarget = pathApi.resolve(target).toLowerCase();
    const pathRole = options.pathRole || (item && pathApi.resolve(item.sourcePath).toLowerCase() === normalizedTarget
      ? 'source'
      : item && pathApi.resolve(outputPath(runtime.manifest.config, item)).toLowerCase() === normalizedTarget
        ? 'destination' : 'discovery');
    const ownerToken = persist ? {} : null;
    if (persist) runtime.networkPauseOwner = ownerToken;
    // Leadership is re-checked when each write is applied: another item may
    // have entered the exclusive publish/replace phase meanwhile, and its
    // job-level state must not be overwritten.
    const stillLead = () => !options.itemId || isLead(runtime, options.itemId);
    let persisted = false;
    let outage = false;
    try {
    if (persist) {
      await update(runtime, () => {
        if (!stillLead()) return {};
        persisted = true;
        return {
          state: 'paused_network',
          activeItemId: item?.id || null,
          recovery: {
            fromState: 'paused_network', action: 'resume-network', pathRole, resumeState,
            ...(phase ? { phase } : {})
          }
        };
      });
    }
    emit(runtime, 'paused_network', { status: 'waiting' });
    let delay = backoff.initialMs;
    // Any abort ends the wait, including one for another clip that needs
    // recovery (the job then stops all its workers); checking only cancel
    // and stop kept this loop polling after such an abort, forever.
    const ended = () => runtime.cancelRequested || runtime.stopRequested || runtime.abortController.signal.aborted;
    while (!ended()) {
      let available = false;
      try {
        available = await abortableRead(() => network.checkPath(target, {
          allowAncestor: pathRole === 'destination', signal: runtime.abortController.signal
        }), runtime.abortController.signal) === true;
      } catch (_) { available = false; }
      if (ended()) throw serviceError('CANCELLED');
      if (!available) {
        if (await goneWhileShareAnswers(runtime, target, pathRole)) available = true;
        else outage = true;
      }
      if (available) {
        if (persisted) {
          // Only while the job file still shows this wait: when another
          // worker's progress took the job state over meanwhile, that state
          // is newer, and writing the old one back could even be rejected.
          await update(runtime, (current) => (stillLead() && current.state === 'paused_network' ? {
            state: resumeState,
            recovery: null,
            ...(resumeState === 'replacing' ? { replacementPhase: phase } : {})
          } : {}));
        }
        emit(runtime, 'network_reconnected', { status: 'resuming' });
        return outage;
      }
      // The abort listener goes again after each sleep: the signal lives as
      // long as the job, and an outage can last all night.
      const signal = runtime.abortController.signal;
      if (signal.aborted) throw serviceError('CANCELLED');
      let onAbort;
      try {
        await Promise.race([
          clock.sleep(delay),
          new Promise((_, reject) => {
            onAbort = () => reject(serviceError('CANCELLED'));
            signal.addEventListener('abort', onAbort, { once: true });
          })
        ]);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
      delay = Math.min(backoff.maximumMs, delay * 2);
    }
    throw serviceError('CANCELLED');
    } finally {
      if (ownerToken && runtime.networkPauseOwner === ownerToken) runtime.networkPauseOwner = null;
    }
  }

  function isRetryableNetwork(error, target) {
    return network.isRetryable(error) === true
      || (typeof network.isPathUnavailable === 'function' && network.isPathUnavailable(error, target) === true);
  }

  async function retryAffectedOperation(runtime, target, operation) {
    let quickRetries = 0;
    while (true) {
      if (runtime.abortController.signal.aborted) throw serviceError('CANCELLED');
      try { return await operation(); } catch (error) {
        if (!isRetryableNetwork(error, target)) throw error;
        if (await waitForNetwork(runtime, target, { persist: false })) quickRetries = 0;
        else if (++quickRetries > QUICK_RETRY_LIMIT) throw error;
      }
    }
  }

  async function retryTransactionOperation(runtime, itemId, target, operation, networkProbePath = target) {
    let quickRetries = 0;
    while (true) {
      try { return await operation(); } catch (error) {
        if (!isRetryableNetwork(error, target)) throw error;
        const reconciled = await reconcileItemOwnership(runtime, itemId, ownershipFor(runtime, itemId));
        if (!reconciled) throw Object.assign(new Error('cleanup pending'), { code: 'OWNED_CLEANUP_FAILED' });
        if (await waitForNetwork(runtime, networkProbePath, { pathRole: 'destination', itemId })) quickRetries = 0;
        else if (++quickRetries > QUICK_RETRY_LIMIT) throw error;
      }
    }
  }

  function currentItem(runtime, itemId) {
    return runtime.manifest.items.find((item) => item.id === itemId);
  }

  async function prepareDestination(config, destination) {
    const destinationGuard = await deps.ensureDestinationParent({
      destinationRoot: config.destinationRoot,
      destination
    });
    if (!destinationGuard || typeof destinationGuard.revalidate !== 'function') {
      throw serviceError('DESTINATION_CONTAINMENT_UNAVAILABLE');
    }
    await destinationGuard.revalidate();
  }

  function outputPath(config, item) {
    return config.outputMode === 'replace'
      ? item.sourcePath
      : pathApi.resolve(config.destinationRoot, ...item.relativePath.split('/'));
  }

  async function runChild(runtime, itemId, source, target, codec, encoder, { bitrate, quality = null, durationUs = null, laneId = null, holdFrames = 0 }, decodeAccel = null) {
    let child;
    let encodeArgs = [];
    if (encoder.remote === true) {
      // A lane on another server (Nodes): the clip is sent there and the
      // encoded file comes back to `target`. The returned object behaves like
      // ffmpeg's process (progress lines on stdout, 'close', kill), so the
      // progress, stall and cancel handling below is the same; reading,
      // telemetry, verification and saving stay on this server.
      try {
        child = typeof deps.remoteEncode === 'function'
          ? deps.remoteEncode({ device: encoder.device, source, target, codec, bitrate, quality, holdFrames, durationUs })
          : null;
      } catch (_) {
        return { ok: false, code: 'encoder-start-failed' };
      }
    } else {
      const hwFrames = Array.isArray(decodeAccel) && decodeAccel.includes('-hwaccel_output_format');
      const device = encoder.hardware === true ? laneDevice(encoder) : null;
      encodeArgs = buildEncodeArgs({
        codec, encoder: encoder.codec, bitrate, quality, hwFrames, ...(device ? { device } : {}), ...(holdFrames > 0 ? { holdFrames } : {})
      });
      const args = [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
        ...(decodeAccel || []),
        '-i', source,
        ...encodeArgs,
        '-an', '-sn', '-dn',
        '-progress', 'pipe:1', '-nostats',
        '-f', 'mp4', target
      ];
      try {
        child = deps.spawnProcess(ffmpegPath, args, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (_) {
        return { ok: false, code: 'encoder-start-failed' };
      }
    }
    if (!child || typeof child.once !== 'function' || !child.stdout?.on || typeof child.kill !== 'function') {
      return { ok: false, code: 'encoder-start-failed' };
    }
    const entry = { child, terminationRequested: false };
    runtime.children.set(itemId, entry);
    const live = {
      jobId: runtime.manifest.id,
      itemId,
      relativePath: currentItem(runtime, itemId)?.relativePath || null,
      encoder: encoder.codec,
      hardware: encoder.hardware === true,
      decode: Array.isArray(decodeAccel) && decodeAccel.length > 0 ? 'gpu' : 'cpu',
      device: encoder.remote === true ? null : renderDevice([...(decodeAccel || []), ...encodeArgs]),
      // the paired server encoding this clip (Nodes), else null
      node: encoder.remote === true ? (encoder.device?.name || encoder.device?.id || null) : null,
      // the lane (chosen GPU) this clip runs on; null without lanes
      deviceId: laneId,
      pid: Number.isSafeInteger(child.pid) ? child.pid : null,
      fps: null,
      speed: null,
      bitrateKbps: null,
      frame: null,
      outTimeUs: null,
      durationUs: Number.isSafeInteger(durationUs) && durationUs > 0 ? durationUs : null,
      dropFrames: null,
      dupFrames: null,
      totalSizeB: null
    };
    runtime.encodes.set(itemId, live);
    // A cancel/stop issued while this item was starting must still stop it.
    if (runtime.cancelRequested || runtime.stopRequested || runtime.recoveryRequired) {
      entry.terminationRequested = true;
      child.kill('SIGTERM');
    }
    child.stderr?.on?.('data', () => {});
    // ffmpeg reports progress about twice a second. A GPU or a share that
    // stops answering can leave it waiting forever without failing, which
    // held the worker for good; after a long silence it is stopped and the
    // clip goes on as a failed encode (slower decoding, the CPU encoder, or
    // a failed clip).
    let finishStalled = null;
    let stallTimer = null;
    const watchStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        entry.terminationRequested = true;
        try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
        // Not waiting for 'close': a process stuck in the kernel on a dead
        // share may not exit until the share answers.
        finishStalled?.();
      }, encodeStallMs);
      stallTimer.unref?.();
    };
    watchStall();
    let buffered = '';
    const progress = {};
    child.stdout.on('data', (chunk) => {
      watchStall();
      buffered = `${buffered}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)}`.slice(-8192);
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || '';
      for (const line of lines) {
        const separator = line.indexOf('=');
        if (separator < 1) continue;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1).trim();
        if (key === 'out_time_ms' || key === 'out_time_us') {
          const parsed = Number(value);
          if (Number.isSafeInteger(parsed) && parsed >= 0) {
            progress.outTimeUs = parsed;
            live.outTimeUs = parsed;
          }
        } else if (key === 'fps') {
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed >= 0) {
            runtime.encodeFps.set(itemId, parsed);
            live.fps = Math.round(parsed * 10) / 10;
          }
        } else if (Object.prototype.hasOwnProperty.call(LIVE_COUNTERS, key)) {
          live[LIVE_COUNTERS[key]] = progressCount(value);
        } else if (key === 'speed') {
          live.speed = progressRate(value, 100);
        } else if (key === 'bitrate') {
          live.bitrateKbps = progressRate(value, 10);
        } else if (key === 'progress' && (value === 'continue' || value === 'end')) {
          progress.phase = value;
          // The UI shows one live progress line: the lead item's, plus the
          // combined frames per second of every encode running right now.
          if (isLead(runtime, itemId)) {
            let fps = 0;
            for (const value of runtime.encodeFps.values()) fps += value;
            emit(runtime, 'progress', { progress: { ...progress, fps: Math.round(fps * 10) / 10 } });
          }
        }
      }
    });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(stallTimer);
        if (runtime.children.get(itemId) === entry) runtime.children.delete(itemId);
        if (runtime.encodes.get(itemId) === live) runtime.encodes.delete(itemId);
        runtime.encodeFps.delete(itemId);
        resolve(result);
      };
      finishStalled = () => finish({ ok: false, code: 'encoder-stalled' });
      child.once('error', () => finish({ ok: false, code: 'encoder-start-failed' }));
      child.once('close', (code, signal) => {
        if (runtime.cancelRequested || runtime.stopRequested || runtime.recoveryRequired || signal) {
          finish({ ok: false, code: 'cancelled' });
        } else finish(code === 0 ? { ok: true } : { ok: false, code: 'encoder-failed' });
      });
    });
  }

  async function cleanupOwnership(runtime, itemId, ownership, signal = runtime.abortController.signal, { scope = 'lead' } = {}) {
    if (!ownership?.ownedPaths || !ownership?.ownedArtifacts) return { cleaned: true };
    if (Object.keys(ownership.ownedPaths).length === 0) return { cleaned: true };
    // Any retained original requires replacement-specific reconciliation. Never
    // hand the backup or its recovery companions to generic cleanup. (A
    // backup only announced is no original: generic cleanup forgets it when
    // nothing is there, and keeps it otherwise.)
    if (ownership.ownedPaths.replacementBackup && ownership.ownedArtifacts.replacementBackup?.state !== 'intent') return {
      cleaned: false, recoveryRequired: true, cleanupPending: Object.keys(ownership.ownedPaths), ...ownership
    };
    try {
      const result = await staging.cleanupOwnedArtifacts({
        codec: runtime.manifest.config.codec,
        jobId: runtime.manifest.id,
        itemId,
        source: currentItem(runtime, itemId)?.sourcePath,
        sourceRoot: runtime.manifest.config.sourceRoot,
        ownedPaths: ownership.ownedPaths,
        ownedArtifacts: ownership.ownedArtifacts,
        publicationArtifact: ownership.publicationArtifact,
        signal,
        persistTransaction: transactionPersistence(runtime, itemId, { scope })
      });
      if (result.cleaned !== true && result.cleanupPending?.includes('replacementBackup')) result.recoveryRequired = true;
      if (result.cleaned === true) {
        setOwnership(runtime, itemId, composeOwnership(ownershipFor(runtime, itemId) || ownership, {}, Object.keys(ownership.ownedPaths)));
      } else {
        setOwnership(runtime, itemId, composeOwnership(ownershipFor(runtime, itemId), result));
      }
      return result;
    } catch (error) {
      return { cleaned: false, cleanupPending: error?.cleanupPending || Object.keys(ownership.ownedPaths) };
    }
  }

  async function reconcileItemOwnership(runtime, itemId, ownership, { scope = 'lead' } = {}) {
    if (!ownership || Object.keys(ownership.ownedPaths || {}).length === 0) return true;
    setOwnership(runtime, itemId, ownershipOf(ownership));
    const cleanup = await cleanupOwnership(runtime, itemId, ownershipFor(runtime, itemId), runtime.abortController.signal, { scope });
    if (cleanup.cleaned === true) {
      await itemPatch(runtime, itemId, {
        ownedPaths: {}, ownedArtifacts: {}, publicationArtifact: undefined, replacementPhase: undefined
      });
      setOwnership(runtime, itemId, ownershipOf(currentItem(runtime, itemId)));
      return true;
    }
    const retained = composeOwnership(ownership, cleanup);
    if (!retained.ownedPaths.publicationSnapshot) delete retained.publicationArtifact;
    await itemPatch(runtime, itemId, {
      ownedPaths: retained.ownedPaths,
      ownedArtifacts: retained.ownedArtifacts,
      publicationArtifact: retained.publicationArtifact,
      resultCode: 'cleanup-pending'
    }, scope === 'item' ? {} : {
      ownedPaths: retained.ownedPaths,
      ownedArtifacts: retained.ownedArtifacts,
      publicationArtifact: retained.publicationArtifact || null
    });
    return false;
  }

  // Also used for a video whose conversion would not save space (custom
  // bitrate or constant quality): the original is kept (replace mode) or
  // copied unchanged (separate mode) instead of failing the clip.
  async function processAsset(runtime, item, codes = { retained: 'asset-retained', copied: 'copied' }) {
    if (runtime.manifest.config.outputMode === 'replace') {
      await itemPatch(runtime, item.id, { state: 'skipped', resultCode: codes.retained, eligibleVideo: false }, {
        state: 'waiting', activeItemId: null
      });
      return;
    }
    const destination = outputPath(runtime.manifest.config, item);
    await acquireCommit(runtime, item.id);
    await itemPatch(runtime, item.id, { state: 'processing', eligibleVideo: false }, {
      state: 'copying', activeItemId: item.id
    });
    let result;
    try {
      result = await retryTransactionOperation(runtime, item.id, destination, async () => {
        await prepareDestination(runtime.manifest.config, destination);
        return staging.copyAsset({
          source: item.sourcePath,
          sourceRoot: runtime.manifest.config.sourceRoot,
          destination,
          destinationRoot: runtime.manifest.config.destinationRoot,
          jobId: runtime.manifest.id,
          itemId: item.id,
          signal: runtime.abortController.signal,
          persistTransaction: transactionPersistence(runtime, item.id)
        });
      }, runtime.manifest.config.destinationRoot);
    } catch (error) {
      if (!error?.validFinal?.finalPath || !Number.isSafeInteger(error.validFinal.outputBytes)) throw error;
      result = error.validFinal;
    }
    const publicationCleanup = await cleanupOwnership(runtime, item.id, result);
    const cleanupPending = publicationCleanup.cleanupPending || [];
    const completed = {
      state: 'completed',
      eligibleVideo: false,
      outputPath: result.finalPath,
      outputBytes: result.outputBytes,
      resultCode: cleanupPending.length ? 'completed-cleanup-pending' : codes.copied,
      ownedPaths: publicationCleanup.cleaned === false ? result.ownedPaths : {},
      ownedArtifacts: publicationCleanup.cleaned === false ? result.ownedArtifacts : {}
    };
    await update(runtime, (current) => {
      const finished = { ...current.items.find((entry) => entry.id === item.id), ...completed };
      return {
        state: 'waiting',
        activeItemId: null,
        ownedPaths: null,
        ownedArtifacts: null,
        publicationArtifact: null,
        items: current.items.map((entry) => entry.id === item.id ? finished : entry),
        counters: addCompletedFile(current.counters, finished)
      };
    });
  }

  // Read directly or through local staging (networkMode, or for 'auto' the
  // kind of volume and the free space).
  async function sourceMode(runtime, item) {
    let mode = runtime.manifest.config.networkMode;
    let space;
    if (mode === 'auto') {
      if (typeof deps.classifyPath !== 'function' || typeof deps.chooseStagingMode !== 'function'
          || typeof deps.checkStagingSpace !== 'function') throw serviceError('STAGING_POLICY_UNAVAILABLE');
      const classification = await deps.classifyPath(item.sourcePath);
      space = await deps.checkStagingSpace({ sourceBytes: item.sourceBytes, outputBytes: item.sourceBytes });
      mode = deps.chooseStagingMode({ networkMode: 'auto', classification, space });
    }
    if (mode === 'staging' && !space) {
      if (typeof deps.checkStagingSpace !== 'function') throw serviceError('STAGING_POLICY_UNAVAILABLE');
      space = await deps.checkStagingSpace({ sourceBytes: item.sourceBytes, outputBytes: item.sourceBytes });
      if (space?.sufficient !== true) throw serviceError('INSUFFICIENT_STAGING_SPACE');
    }
    return mode;
  }

  async function videoSource(runtime, item, mode) {
    let expectedSource;
    const replacing = runtime.manifest.config.outputMode === 'replace';
    if (replacing) {
      if (staging.capabilities?.replacement === 'unavailable') throw serviceError('ATOMIC_PROMOTION_UNSUPPORTED');
      if (typeof staging.captureSource !== 'function') throw serviceError('SOURCE_AUTHORITY_REQUIRED');
    }
    // Fingerprint the original read-only before anything else touches it. When
    // it is copied to local staging, the copy itself fingerprints it with the
    // same identity checks, so a network source is read once instead of twice.
    const captureAuthority = async () => {
      expectedSource = await staging.captureSource({ source: item.sourcePath, signal: runtime.abortController.signal });
      await itemPatch(runtime, item.id, { expectedSource });
    };
    if (mode !== 'staging') {
      if (replacing) await captureAuthority();
      return { source: item.sourcePath, ownership: null, expectedSource };
    }
    const result = await staging.stageSource({
      source: item.sourcePath,
      expectedSource,
      jobId: runtime.manifest.id,
      itemId: item.id,
      signal: runtime.abortController.signal,
      // replacing: the original's fingerprint is recorded with the staged copy
      recordExpectedSource: replacing,
      persistTransaction: transactionPersistence(runtime, item.id)
    });
    const stagedAuthority = result.expectedSource || expectedSource;
    if (replacing) {
      // Replacement and its crash recovery both require this fingerprint.
      if (!stagedAuthority) throw serviceError('SOURCE_AUTHORITY_REQUIRED');
      const recorded = currentItem(runtime, item.id)?.expectedSource;
      const same = (left, right) => ['size', 'sha256', 'device', 'inode'].every((key) => String(left?.[key]) === String(right?.[key]));
      if (!same(recorded, stagedAuthority)) {
        await itemPatch(runtime, item.id, { expectedSource: stagedAuthority });
      }
    }
    return {
      source: result.stagedSource || result.path,
      ownership: result.ownedPaths ? result : null,
      expectedSource: stagedAuthority
    };
  }

  // This server's own encoder for a codec, never a node: its preferred one
  // (its GPU when it has one), else the CPU.
  // one counter for the whole service (every job): see NODE_FALLBACK_AT_ONCE
  const fallbackSlots = { busy: 0, waiters: [] };
  async function takeFallbackSlot(signal) {
    while (fallbackSlots.busy >= NODE_FALLBACK_AT_ONCE) {
      if (signal?.aborted) throw serviceError('CANCELLED');
      await new Promise((resolve) => {
        const done = () => { signal?.removeEventListener('abort', done); resolve(); };
        fallbackSlots.waiters.push(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
    if (signal?.aborted) throw serviceError('CANCELLED');
    fallbackSlots.busy += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      fallbackSlots.busy -= 1;
      fallbackSlots.waiters.shift()?.();
    };
  }

  // A node's encoded clips are checked here (pictures, then frames and
  // telemetry) no more at once than the node converts: the clips sent ahead
  // keep the node busy, not this server's CPU with as many checks.
  async function takeCheckSlot(runtime, lane, signal) {
    runtime.nodeChecks ||= new Map();
    const id = lane?.id || 'node';
    if (!runtime.nodeChecks.has(id)) runtime.nodeChecks.set(id, { busy: 0, waiters: [] });
    const slots = runtime.nodeChecks.get(id);
    const limit = () => Math.max(1, runtime.lanePlan?.base?.get(id) || 1);
    while (slots.busy >= limit()) {
      if (signal?.aborted) throw serviceError('CANCELLED');
      await new Promise((resolve) => {
        const done = () => { signal?.removeEventListener('abort', done); resolve(); };
        slots.waiters.push(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
    if (signal?.aborted) throw serviceError('CANCELLED');
    slots.busy += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      slots.busy -= 1;
      slots.waiters.shift()?.();
    };
  }

  async function localEncoder(codec) {
    try {
      const chosen = await planner.select(codec);
      if (chosen && chosen.remote !== true) return chosen;
    } catch (_) { /* the CPU below */ }
    return planner.selectCpuFallback(codec);
  }

  async function processVideoOnce(runtime, item, lane = null) {
    const check = { release: null };
    try {
      return await processVideoOnceChecked(runtime, item, lane, check);
    } finally {
      check.release?.();
    }
  }

  async function processVideoOnceChecked(runtime, item, lane, check) {
    const signal = runtime.abortController.signal;
    const timing = createItemTiming();
    const inspected = await deps.inspectVideo(item, item.sourcePath, signal);
    timing.mark('inspect');
    if (inspected.codec === 'h265' || inspected.codec === 'av1') {
      // Its header could not tell (or it was found before this version):
      // remembered now, the next run skips it while discovering.
      convertedIndex?.add(item, inspected.codec);
      await itemPatch(runtime, item.id, {
        state: 'skipped', eligibleVideo: false, resultCode: 'already-converted'
      }, { state: 'waiting', activeItemId: null });
      return;
    }
    if (inspected.codec !== 'h264') throw Object.assign(new Error('unsupported'), { code: 'UNSUPPORTED_CODEC' });
    const mode = await sourceMode(runtime, item);
    await itemPatch(runtime, item.id, { state: 'processing', eligibleVideo: true }, {
      state: mode === 'staging' ? 'staging' : 'waiting', activeItemId: item.id
    });
    const staged = await videoSource(runtime, item, mode);
    timing.mark('source');
    try {
    const timeline = await deps.readTimeline({ source: staged.source, item, signal });
    timing.mark('timeline');
    // Frames before the first keyframe are kept as repeats of the first
    // decodable frame; the telemetry writer then gives the output this
    // clip's own timing (leadIn.js). 0 for a clip that starts on a keyframe.
    const holdFrames = leadInHoldFrames(timeline);
    const codec = runtime.manifest.config.codec;
    const profileId = runtime.manifest.config.profileId;
    const customBitrate = profileId === 'custom';
    // Constant quality: the encoder holds a quality level; no bitrate or target.
    let quality = profileId === 'quality' ? runtime.manifest.config.qualityLevel : null;
    const noTarget = !hasSizeTarget(profileId);
    const targetBytes = noTarget ? null : targetOutputBytes(item.sourceBytes, profileId);
    let bitrate = quality ? null : customBitrate ? runtime.manifest.config.bitrateKbps * 1000 : calculateInitialBitrate({
      codec,
      targetBytes,
      durationSeconds: inspected.durationSeconds,
      containerReserveBytes: inspected.containerReserveBytes || 0,
      telemetryReserveBytes: inspected.telemetryReserveBytes || 0
    });
    let selected = lane && typeof planner.selectFor === 'function'
      ? await planner.selectFor(codec, lane.device)
      : await planner.select(codec);
    let usedCpuFallback = selected.hardware !== true;
    // set once a node gave the clip back (or its lane landed here because
    // the node has no encoder for the codec): its encodes here wait their turn
    let fromNode = Boolean(lane && String(lane.id || '').startsWith('node:') && selected.remote !== true);
    // Hardware rate-control backends commonly overshoot a byte target on
    // variable-frame-rate Tesla clips. Leave a small headroom so the first
    // candidate normally lands inside the profile window; the bounded retry
    // remains available for encoders that still miss.
    if (selected.hardware === true && !noTarget) bitrate = Math.max(SAFE_VIDEO_BITRATE_FLOORS[codec], Math.floor(bitrate * 0.93));
    let sizeRetryCount = 0;
    let underSourceCount = 0;
    let attempts = currentItem(runtime, item.id)?.attempts || 0;
    let latestOwnership = staged.ownership;
    let encodeTiers = encodeDecodeTiers(selected, { zeroCopy: holdFrames === 0 });
    const failedTiers = [];
    let decodeTierRetry = false;

    while (!runtime.cancelRequested && !runtime.stopRequested) {
      // Retrying the same encoder with a slower decode tier is not a new
      // attempt; the job file allows at most 3 recorded attempts per clip.
      if (!decodeTierRetry) attempts += 1;
      decodeTierRetry = false;
      attempts = Math.min(attempts, MAX_RECORDED_ATTEMPTS);
      await itemPatch(runtime, item.id, { attempts, encoder: selected.codec }, {
        state: 'encoding', activeItemId: item.id
      });
      const reserved = await staging.reserveEncodeOutput({
        jobId: runtime.manifest.id,
        itemId: item.id,
        extension: '.mp4',
        signal: runtime.abortController.signal,
        persistTransaction: transactionPersistence(runtime, item.id)
      });
      latestOwnership = reserved;
      setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), reserved));
      const usedTier = encodeTiers[0] || null;
      const durationUs = Math.round((inspected.durationSeconds || 0) * 1_000_000) || null;
      const releaseFallback = fromNode ? await takeFallbackSlot(runtime.abortController.signal) : null;
      let encoded;
      try {
        encoded = await runChild(runtime, item.id, staged.source, reserved.path, codec, selected,
          { bitrate, quality, durationUs, laneId: lane ? lane.id : null, holdFrames }, usedTier?.args || null);
      } finally {
        releaseFallback?.();
      }
      timing.mark('encode');
      if (!encoded.ok) {
        let failedOwnership = reserved;
        // Stopped or cancelled: ffmpeg has exited, so its partial output is
        // final and is cleaned up now. With the job's own (aborted) signal
        // this failed, and every worker but one left its partial file behind.
        const settleSignal = encoded.code === 'cancelled' ? AbortSignal.timeout(15_000) : runtime.abortController.signal;
        try {
          failedOwnership = await staging.adoptEncodeOutput({
            jobId: runtime.manifest.id,
            itemId: item.id,
            ownedPaths: reserved.ownedPaths,
            ownedArtifacts: reserved.ownedArtifacts,
            signal: settleSignal,
            persistTransaction: transactionPersistence(runtime, item.id)
          });
          latestOwnership = failedOwnership;
          setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), failedOwnership));
        } catch (_) { /* an absent output remains a safe missing-intent cleanup */ }
        const cleanup = await cleanupOwnership(runtime, item.id, failedOwnership, settleSignal);
        if (cleanup.cleaned === false) {
          setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), failedOwnership));
          throw Object.assign(new Error('cleanup pending'), { code: 'OWNED_CLEANUP_FAILED' });
        }
        if (encoded.code === 'cancelled') throw serviceError('CANCELLED');
        // Retry the same GPU encoder with CPU decoding before giving up on it.
        if (usedTier) {
          failedTiers.push(usedTier.key);
          encodeTiers = encodeTiers.slice(1);
          decodeTierRetry = true;
          continue;
        }
        // A node (another server) that failed: this server's own encoder
        // (its GPU when it has one) takes the clip, then the CPU if that fails.
        if (selected.remote === true) {
          fromNode = true;
          selected = await localEncoder(codec);
          encodeTiers = encodeDecodeTiers(selected, { zeroCopy: holdFrames === 0 });
          usedCpuFallback = selected.hardware !== true;
          continue;
        }
        if (selected.hardware === true && !usedCpuFallback) {
          selected = await planner.selectCpuFallback(codec);
          usedCpuFallback = true;
          continue;
        }
        throw Object.assign(new Error('encode failed'), { code: 'ENCODER_FAILED' });
      }
      // A slower decode tier fixed what a faster one broke: stop offering those.
      for (const key of failedTiers.splice(0)) {
        if (key.startsWith(`${decodeKey(selected)}:`)) encodeDecodeBroken.add(key);
      }
      let adopted = await staging.adoptEncodeOutput({
        jobId: runtime.manifest.id,
        itemId: item.id,
        ownedPaths: reserved.ownedPaths,
        ownedArtifacts: reserved.ownedArtifacts,
        signal: runtime.abortController.signal,
        persistTransaction: transactionPersistence(runtime, item.id)
      });
      latestOwnership = adopted;
      setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), adopted));
      await itemPatch(runtime, item.id, {}, { state: 'writing-telemetry', activeItemId: item.id });
      try {
        await deps.writers[codec]({
          candidatePath: reserved.path,
          timeline,
          item: clone(currentItem(runtime, item.id)),
          signal
        });
      } catch (error) {
        try {
          adopted = await staging.adoptEncodeOutput({
            jobId: runtime.manifest.id,
            itemId: item.id,
            ownedPaths: adopted.ownedPaths,
            ownedArtifacts: adopted.ownedArtifacts,
            signal: runtime.abortController.signal,
            persistTransaction: transactionPersistence(runtime, item.id)
          });
          latestOwnership = adopted;
          setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), adopted));
        } catch (_) { /* retain the last proven identity for ownership-safe cleanup */ }
        throw error;
      }
      adopted = await staging.adoptEncodeOutput({
        jobId: runtime.manifest.id,
        itemId: item.id,
        ownedPaths: adopted.ownedPaths,
        ownedArtifacts: adopted.ownedArtifacts,
        signal: runtime.abortController.signal,
        persistTransaction: transactionPersistence(runtime, item.id)
      });
      latestOwnership = adopted;
      setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), adopted));
      timing.mark('metadata');
      await itemPatch(runtime, item.id, {}, { state: 'verifying', activeItemId: item.id });
      // Encoded on another server (Nodes): its pictures must match the
      // original's before anything else is checked or saved. One that does
      // not is thrown away and the clip is encoded here instead.
      if (selected.remote === true) {
        if (!check.release) check.release = await takeCheckSlot(runtime, lane, signal);
        const same = typeof deps.comparePicture === 'function'
          ? await deps.comparePicture({ source: staged.source, candidate: adopted.path, signal }).catch(() => ({ ok: false, reason: 'compare-failed' }))
          : { ok: false, reason: 'no-picture-check' };
        if (!same?.ok) {
          console.warn(`[CONVERTER] The encode from ${selected.device?.name || 'a node'} does not show the original's pictures; encoding it on this server instead:`,
            item.relativePath, JSON.stringify(same || {}).slice(0, 200));
          const cleanup = await cleanupOwnership(runtime, item.id, adopted);
          if (cleanup.cleaned === false) {
            setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), adopted));
            throw Object.assign(new Error('cleanup pending'), { code: 'OWNED_CLEANUP_FAILED' });
          }
          fromNode = true;
          // (encoded here now: the check slot goes to the node's next clip)
          check.release?.();
          check.release = null;
          selected = await localEncoder(codec);
          encodeTiers = encodeDecodeTiers(selected, { zeroCopy: holdFrames === 0 });
          usedCpuFallback = selected.hardware !== true;
          continue;
        }
      }
      const verifyAccel = decodeAccelFor(selected, 'verify');
      const verifiedEncoder = decodeKey(selected);
      const verification = await deps.verifier({
        source: staged.source,
        candidate: adopted.path,
        codec,
        profileId: runtime.manifest.config.profileId,
        sourceTimeline: timeline,
        sourceDurationUs: Math.round((inspected.durationSeconds || 0) * 1_000_000) || undefined,
        signal: runtime.abortController.signal,
        // Off / quick / full; replacing originals is never below quick.
        verifyMode: effectiveVerifyMode(runtime.manifest.config),
        ...(verifyAccel && effectiveVerifyMode(runtime.manifest.config) === 'full' ? {
          decodeAccel: verifyAccel,
          onDecodeAccelFallback: () => verifyDecodeFallbacks.set(verifiedEncoder, (verifyDecodeFallbacks.get(verifiedEncoder) || 0) + 1)
        } : {})
      });
      timing.mark('verify');
      check.release?.();
      check.release = null;
      if (!verification?.ok) {
        const retry = decideSizeRetry({
          retryCount: sizeRetryCount,
          failureReason: verification?.reason,
          codec,
          encoder: selected.codec,
          currentBitrate: bitrate,
          actualBytes: verification?.outputBytes,
          targetBytes
        });
        const cleanup = await cleanupOwnership(runtime, item.id, adopted);
        if (cleanup.cleaned === false) {
          setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), adopted));
          // Cleanup is secondary: preserve the reason this candidate was rejected.
          throw Object.assign(new Error('verification failed; cleanup pending'), {
            code: verification?.reason || 'VERIFICATION_FAILED',
            retryable: verification?.retryable === true
          });
        }
        if (retry.retry) {
          sizeRetryCount += 1;
          bitrate = retry.bitrate;
          continue;
        }
        if (noTarget && verification?.reason === 'not-smaller') {
          // The Encoder is there to get every clip into the chosen codec: a
          // clip the quality level (or the custom bitrate) cannot make
          // smaller, such as busy repeater footage, is encoded again at a
          // bitrate under the original's (85%, then 60%) instead of staying
          // H.264. Only if that is still not smaller is the original kept.
          if (underSourceCount < UNDER_SOURCE_SHARES.length) {
            const share = UNDER_SOURCE_SHARES[underSourceCount];
            underSourceCount += 1;
            quality = null;
            bitrate = calculateInitialBitrate({
              codec,
              targetBytes: Math.floor(item.sourceBytes * share),
              durationSeconds: inspected.durationSeconds,
              containerReserveBytes: inspected.containerReserveBytes || 0,
              telemetryReserveBytes: inspected.telemetryReserveBytes || 0
            });
            if (selected.hardware === true) bitrate = Math.max(SAFE_VIDEO_BITRATE_FLOORS[codec], Math.floor(bitrate * 0.93));
            continue;
          }
          throw serviceError('KEEP_ORIGINAL');
        }
        // the reason alone ("duration-mismatch") cannot tell a damaged clip
        // from a converter problem; the measurements can
        console.warn('[CONVERTER] Verification failed:', item.relativePath, verification?.reason || 'unknown',
          JSON.stringify(verification?.details || {}).slice(0, 600));
        const error = Object.assign(new Error('verification failed'), {
          code: verification?.reason || 'VERIFICATION_FAILED',
          retryable: verification?.retryable === true
        });
        throw error;
      }
      const publicationArtifact = verification.publicationArtifact;
      const destination = outputPath(runtime.manifest.config, item);
      const common = {
        publicationArtifact,
        jobId: runtime.manifest.id,
        itemId: item.id,
        signal: runtime.abortController.signal,
        persistTransaction: transactionPersistence(runtime, item.id)
      };
      if (staging.capabilities?.splitSave === true) {
        await saveSplit(runtime, item, {
          publicationArtifact, destination, common, timing, staged, codec, verification, selected, attempts
        });
        return;
      }
      await acquireCommit(runtime, item.id);
      timing.mark('saveWait');
      await itemPatch(runtime, item.id, {}, {
        state: 'copying',
        activeItemId: item.id
      });
      let published;
      try {
        if (runtime.manifest.config.outputMode !== 'replace') {
          await prepareDestination(runtime.manifest.config, destination);
        }
        published = runtime.manifest.config.outputMode === 'replace'
          ? await staging.replaceOriginal({
            ...common,
            codec: runtime.manifest.config.codec,
            source: item.sourcePath,
            expectedSource: staged.expectedSource,
            sourceRoot: runtime.manifest.config.sourceRoot
          })
          : await staging.publishSeparate({ ...common, destination });
      } catch (error) {
        if (!error?.validFinal?.finalPath || !Number.isSafeInteger(error.validFinal.outputBytes)) {
          if (isRetryableNetwork(error, destination)) {
            const affected = Object.assign(new Error('publication path unavailable'), {
              code: error.code,
              path: destination,
              networkProbePath: runtime.manifest.config.outputMode === 'replace'
                ? runtime.manifest.config.sourceRoot
                : runtime.manifest.config.destinationRoot,
              pathRole: runtime.manifest.config.outputMode === 'replace' ? 'source' : 'destination',
              cause: error,
              retryable: true
            });
            throw affected;
          }
          throw error;
        }
        published = error.validFinal;
      }
      timing.mark('save');
      const publicationCleanup = await cleanupOwnership(runtime, item.id, {
        ...published,
        publicationArtifact
      });
      const candidateCleanup = await cleanupOwnership(runtime, item.id, adopted);
      const stagedCleanup = await cleanupOwnership(runtime, item.id, staged.ownership);
      const cleanupPending = [...new Set([
        ...(publicationCleanup.cleanupPending || []),
        ...(candidateCleanup.cleanupPending || []),
        ...(stagedCleanup.cleanupPending || [])
      ])];
      const residualOwnership = {
        ownedPaths: {
          ...(publicationCleanup.cleaned === false ? published.ownedPaths : {}),
          ...(candidateCleanup.cleaned === false ? adopted.ownedPaths : {}),
          ...(stagedCleanup.cleaned === false ? staged.ownership?.ownedPaths : {})
        },
        ownedArtifacts: {
          ...(publicationCleanup.cleaned === false ? published.ownedArtifacts : {}),
          ...(candidateCleanup.cleaned === false ? adopted.ownedArtifacts : {}),
          ...(stagedCleanup.cleaned === false ? staged.ownership?.ownedArtifacts : {})
        }
      };
      const completed = {
        state: 'completed',
        eligibleVideo: true,
        outputPath: published.finalPath,
        outputBytes: verification.outputBytes,
        attempts,
        encoder: selected.codec,
        resultCode: cleanupPending.length ? 'completed-cleanup-pending' : 'converted',
        ownedPaths: residualOwnership.ownedPaths,
        ownedArtifacts: residualOwnership.ownedArtifacts
      };
      if (residualOwnership.ownedPaths.publicationSnapshot) completed.publicationArtifact = publicationArtifact;
      timing.mark('cleanup');
      const itemTiming = timing.result();
      await update(runtime, (current) => {
        const finished = { ...current.items.find((entry) => entry.id === item.id), ...completed };
        if (!residualOwnership.ownedPaths.publicationSnapshot) delete finished.publicationArtifact;
        delete finished.replacementPhase;
        return {
          state: 'waiting',
          activeItemId: null,
          ownedPaths: null,
          ownedArtifacts: null,
          publicationArtifact: null,
          replacementPhase: null,
          items: current.items.map((entry) => entry.id === item.id ? finished : entry),
          counters: addCompletedFile(current.counters, finished),
          timings: addItemTimings(current.timings, itemTiming.phases)
        };
      });
      rememberConverted(published.finalPath, codec);
      emit(runtime, 'item_timing', {
        itemId: item.id, relativePath: item.relativePath, encoder: selected.codec, outputPath: published.finalPath,
        sourceBytes: item.sourceBytes, outputBytes: verification.outputBytes, attempts, ...itemTiming
      });
      return;
    }
    await cleanupOwnership(runtime, item.id, latestOwnership);
    throw serviceError('CANCELLED');
    } catch (error) {
      const cleanup = await cleanupOwnership(runtime, item.id, staged.ownership);
      if (cleanup.cleaned === false) setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), staged.ownership));
      throw error;
    }
  }

  // Network errors while saving go to the path the job waits for.
  function publicationError(runtime, error, destination) {
    if (!isRetryableNetwork(error, destination)) return error;
    const replace = runtime.manifest.config.outputMode === 'replace';
    return Object.assign(new Error('publication path unavailable'), {
      code: error.code,
      path: destination,
      networkProbePath: replace ? runtime.manifest.config.sourceRoot : runtime.manifest.config.destinationRoot,
      pathRole: replace ? 'source' : 'destination',
      cause: error,
      retryable: true
    });
  }

  // The save, split around the one-clip-at-a-time slot:
  //  - before it, at the same time as other clips: the verified conversion
  //    is copied to the share beside its original (or destination), recorded
  //    on the clip only;
  //  - in it: the renames that put the copy in place (and, replacing, the
  //    removal of the original's backup), then the clip's result;
  //  - after it: the clip's private work files are removed.
  // The slot is held only for the renames, a few metadata round trips and
  // the full checks before each of them, not for the copy or the cleanup.
  async function saveSplit(runtime, item, { publicationArtifact, destination, common, timing, staged, codec, verification, selected, attempts }) {
    const config = runtime.manifest.config;
    const replace = config.outputMode === 'replace';
    const outside = { ...common, persistTransaction: transactionPersistence(runtime, item.id, { scope: 'item' }) };
    let prepared;
    try {
      if (replace) {
        prepared = await staging.prepareReplacement({
          ...outside, codec: config.codec, source: item.sourcePath, expectedSource: staged.expectedSource, sourceRoot: config.sourceRoot
        });
      } else {
        await prepareDestination(config, destination);
        prepared = await staging.preparePublication({ ...outside, destination });
      }
    } catch (error) {
      throw publicationError(runtime, error, destination);
    }
    timing.mark('save');
    await acquireCommit(runtime, item.id);
    timing.mark('saveWait');
    const slotStarted = timingNow();
    let published;
    try {
      if (replace) {
        // (no abort signal: a stop lets the swap finish, or roll back)
        published = await staging.swapReplacement({ prepared, persistTransaction: common.persistTransaction });
      } else {
        await update(runtime, (current) => {
          const entry = current.items.find((candidate) => candidate.id === item.id);
          return {
            state: 'copying',
            activeItemId: item.id,
            ownedPaths: entry?.ownedPaths || {},
            ownedArtifacts: entry?.ownedArtifacts || {},
            publicationArtifact: entry?.publicationArtifact || null
          };
        });
        await prepareDestination(config, destination);
        published = await staging.commitPublication({ prepared, persistTransaction: common.persistTransaction });
      }
    } catch (error) {
      if (!error?.validFinal?.finalPath || !Number.isSafeInteger(error.validFinal.outputBytes)) {
        // Put back: the original is at its name again. The job-level
        // replacement record ends here (a network wait or a retry that
        // follows must not find the job still 'replacing').
        if (error?.rolledBack) {
          const clear = () => update(runtime, (current) => (current.activeItemId === item.id && current.replacementPhase ? {
            state: 'waiting', activeItemId: null, replacementPhase: null,
            ownedPaths: {}, ownedArtifacts: {}, publicationArtifact: null
          } : null));
          let cleared = false;
          for (let attempt = 0; attempt < 3 && !cleared; attempt += 1) {
            if (attempt) await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
            cleared = await clear().then(() => true, () => false);
          }
          // The job file cannot be written: it still says this clip is
          // mid-replacement (the original back at its name). No other clip
          // may save or record anything as the job's active one meanwhile,
          // so the job stops here as after a crash; recovery (on Resume or
          // the next start) finds the original in place and queues the clip
          // again.
          if (!cleared) throw Object.assign(serviceError('REPLACEMENT_RECORD_STALE'), { replacementRecordStale: true, cause: error });
        }
        throw publicationError(runtime, error, destination);
      }
      published = error.validFinal;
    }
    // The clip's result, still in the slot. What remains of it are its
    // private work files (and the verified snapshot): removed below, once
    // the slot is free.
    const memory = ownershipFor(runtime, item.id) || { ownedPaths: {}, ownedArtifacts: {} };
    const leftover = { ownedPaths: {}, ownedArtifacts: {} };
    for (const key of ['stagedSource', 'encodedCandidate']) {
      if (!memory.ownedPaths?.[key] || !memory.ownedArtifacts?.[key]) continue;
      leftover.ownedPaths[key] = memory.ownedPaths[key];
      leftover.ownedArtifacts[key] = memory.ownedArtifacts[key];
    }
    Object.assign(leftover.ownedPaths, published.ownedPaths || {});
    Object.assign(leftover.ownedArtifacts, published.ownedArtifacts || {});
    if (leftover.ownedPaths.publicationSnapshot) leftover.publicationArtifact = publicationArtifact;
    const completed = {
      state: 'completed',
      eligibleVideo: true,
      outputPath: published.finalPath,
      outputBytes: verification.outputBytes,
      attempts,
      encoder: selected.codec,
      resultCode: published.cleanupPending?.length ? 'completed-cleanup-pending' : 'converted',
      ownedPaths: leftover.ownedPaths,
      ownedArtifacts: leftover.ownedArtifacts
    };
    await update(runtime, (current) => {
      const finished = { ...current.items.find((entry) => entry.id === item.id), ...completed };
      if (leftover.publicationArtifact) finished.publicationArtifact = leftover.publicationArtifact;
      else delete finished.publicationArtifact;
      delete finished.replacementPhase;
      delete finished.failure;
      return {
        state: 'waiting',
        activeItemId: null,
        ownedPaths: null,
        ownedArtifacts: null,
        publicationArtifact: null,
        replacementPhase: null,
        items: current.items.map((entry) => entry.id === item.id ? finished : entry),
        counters: addCompletedFile(current.counters, finished)
      };
    });
    setOwnership(runtime, item.id, leftover);
    timing.mark('save');
    const slotMs = Math.round(timingNow() - slotStarted);
    releaseCommit(runtime, item.id);
    // From here on the clip is converted; a problem with its leftovers only
    // leaves it marked for a later cleanup (never failed).
    let retained = null;
    try {
      const cleanup = await cleanupOwnership(runtime, item.id, leftover, AbortSignal.timeout(15_000), { scope: 'item' });
      if (cleanup.cleaned === false) retained = composeOwnership(leftover, cleanup);
    } catch (_) {
      retained = leftover;
    }
    timing.mark('cleanup');
    const itemTiming = timing.result();
    try {
      await update(runtime, (current) => {
        const entry = current.items.find((candidate) => candidate.id === item.id);
        const finished = { ...entry };
        if (retained) {
          finished.ownedPaths = retained.ownedPaths;
          finished.ownedArtifacts = retained.ownedArtifacts;
          if (retained.ownedPaths.publicationSnapshot && leftover.publicationArtifact) finished.publicationArtifact = leftover.publicationArtifact;
          else delete finished.publicationArtifact;
          finished.resultCode = 'completed-cleanup-pending';
        } else {
          finished.ownedPaths = {};
          finished.ownedArtifacts = {};
          delete finished.publicationArtifact;
        }
        return {
          items: current.items.map((candidate) => candidate.id === item.id ? finished : candidate),
          timings: addItemTimings(current.timings, itemTiming.phases)
        };
      });
    } catch (_) { /* the clip is converted; a restart removes what is left */ }
    setOwnership(runtime, item.id, retained);
    rememberConverted(published.finalPath, codec);
    emit(runtime, 'item_timing', {
      itemId: item.id, relativePath: item.relativePath, encoder: selected.codec, outputPath: published.finalPath,
      sourceBytes: item.sourceBytes, outputBytes: verification.outputBytes, attempts, slotMs, ...itemTiming
    });
  }

  async function keepOriginalWhenNoSavings(runtime, item, operation) {
    try {
      return await operation();
    } catch (error) {
      if (error?.code !== 'KEEP_ORIGINAL' || Object.keys(ownershipFor(runtime, item.id)?.ownedPaths || {}).length > 0) throw error;
      return processAsset(runtime, currentItem(runtime, item.id), { retained: 'no-savings', copied: 'no-savings' });
    }
  }

  async function processVideo(runtime, item, lane = null) {
    let quickRetries = 0;
    while (!runtime.cancelRequested && !runtime.stopRequested) {
      try {
        return await processVideoOnce(runtime, currentItem(runtime, item.id), lane);
      } catch (error) {
        const affectedPath = typeof error.path === 'string' ? error.path : item.sourcePath;
        if (!isRetryableNetwork(error, affectedPath)) throw error;
        if (Object.keys(ownershipFor(runtime, item.id)?.ownedPaths || {}).length > 0) {
          const reconciled = await reconcileItemOwnership(runtime, item.id, ownershipFor(runtime, item.id));
          if (!reconciled) throw Object.assign(new Error('cleanup pending'), { code: 'OWNED_CLEANUP_FAILED' });
        }
        if (await waitForNetwork(runtime, error.networkProbePath || affectedPath, { pathRole: error.pathRole, itemId: item.id })) {
          quickRetries = 0;
          continue;
        }
        // No outage: a clip that is gone (moved to the Recycle Bin, deleted)
        // fails now instead of holding its worker forever; any other error
        // gets a few more tries, then fails, instead of converting the clip
        // over and over.
        if (!await pathPresent(runtime, item.sourcePath)) throw serviceError('SOURCE_MISSING');
        if (++quickRetries > QUICK_RETRY_LIMIT) throw error;
      }
    }
    throw serviceError('CANCELLED');
  }

  async function failItem(runtime, itemId, error) {
    const retryable = error?.retryable === true || isRetryableNetwork(error, currentItem(runtime, itemId)?.sourcePath);
    const code = stableFailure(error);
    // An error without a code is unexpected: keep its details in the log
    // (the job file only records the generic code).
    if (typeof error?.code !== 'string') {
      console.error('[CONVERTER] Unexpected clip failure:', String(error?.stack || error).slice(0, 2000));
    }
    const ownership = ownershipFor(runtime, itemId);
    if (ownership?.ownedPaths?.replacementBackup || error?.code === 'ROLLBACK_FAILED' || error?.replacementRecordStale === true) {
      if (!runtime.recoveryRequired) {
        runtime.recoveryRequired = true;
        runtime.recoveryItemId = itemId;
      }
      runtime.queue.close();
      runtime.abortController.abort();
      // Other workers stop and re-queue their items; they never touch the
      // job-level state this item now owns (see isLead). Workers parked on a
      // pause must wake up and exit too, or the job would never settle.
      terminateChildren(runtime);
      for (const resolve of runtime.pauseWaiters.splice(0)) resolve();
      const phase = runtime.manifest.replacementPhase || 'rollback-failed';
      await itemPatch(runtime, itemId, { state: 'processing', resultCode: 'recovery-required', failure: undefined }, {
        state: 'paused', activeItemId: itemId, replacementPhase: phase,
        recovery: { fromState: 'replacing', phase, action: 'manual-intervention' },
        summary: null, summaryDismissed: false
      });
      return;
    }
    const cleanup = await cleanupOwnership(runtime, itemId, ownership);
    if (cleanup.cleaned === true) setOwnership(runtime, itemId, ownershipOf(ownershipFor(runtime, itemId)));
    const haltedByRecovery = runtime.recoveryRequired && runtime.recoveryItemId !== itemId;
    const stopped = (runtime.stopRequested || haltedByRecovery) && !runtime.cancelRequested;
    const terminallyCancelled = runtime.cancelRequested;
    await itemPatch(runtime, itemId, {
      state: stopped ? 'queued' : (terminallyCancelled ? 'cancelled' : 'failed'),
      failure: stopped || terminallyCancelled ? undefined : { code, retryable },
      resultCode: stopped && cleanup.cleaned !== false ? undefined : (cleanup.cleaned === false ? 'cleanup-pending' : code),
      ownedPaths: cleanup.cleaned === false ? ownership?.ownedPaths : undefined,
      ownedArtifacts: cleanup.cleaned === false ? ownership?.ownedArtifacts : undefined
    }, {
      state: terminallyCancelled ? 'cancelled' : 'waiting',
      activeItemId: null,
      ownedPaths: cleanup.cleaned === false ? ownership?.ownedPaths : {},
      ownedArtifacts: cleanup.cleaned === false ? ownership?.ownedArtifacts : {},
      publicationArtifact: cleanup.cleaned === false ? ownership?.publicationArtifact || null : null,
      replacementPhase: cleanup.cleaned === false ? runtime.manifest.replacementPhase || null : null
    });
  }

  async function work(runtime, lane = null) {
    const laneId = lane ? lane.id : null;
    const counters = laneCounters(runtime, laneId);
    runtime.liveWorkers += 1;
    counters.live += 1;
    let retired = false;
    try {
      while (!runtime.cancelRequested && !runtime.stopRequested && !runtime.recoveryRequired) {
        await waitWhilePaused(runtime);
        if (runtime.cancelRequested || runtime.stopRequested) break;
        // Fewer at once (Parallel conversions lowered mid-run, or this GPU
        // set lower or off): this worker stops after its clip instead of
        // taking another.
        if (counters.live - counters.retiring > laneLimit(runtime, laneId)) {
          counters.retiring += 1;
          retired = true;
          break;
        }
        const next = await runtime.queue.shift();
        if (next.done) break;
        // A worker that waited for discovery to find a clip: a pause, a
        // stop or fewer at once may have come meanwhile; the clip is still
        // queued in the job file, so nothing is lost.
        if (runtime.pauseRequested) await waitWhilePaused(runtime);
        if (runtime.cancelRequested || runtime.stopRequested || runtime.recoveryRequired) break;
        if (counters.live - counters.retiring > laneLimit(runtime, laneId)) {
          runtime.queue.unshift(next.value);
          counters.retiring += 1;
          retired = true;
          break;
        }
        const item = currentItem(runtime, next.value);
        if (!item || item.state !== 'queued') continue;
        beginItem(runtime, item);
        try {
          if (item.kind === 'asset') await processAsset(runtime, item);
          else await keepOriginalWhenNoSavings(runtime, item, () => processVideo(runtime, item, lane));
        } catch (error) {
          await failItem(runtime, item.id, error);
        } finally {
          finishItem(runtime, item.id);
        }
      }
    } catch (error) {
      // A worker that cannot record an outcome fails the job; let the others
      // finish their current item and stop taking new ones.
      runtime.halted = true;
      runtime.queue.close();
      for (const resolve of runtime.pauseWaiters.splice(0)) resolve();
      throw error;
    } finally {
      runtime.liveWorkers -= 1;
      counters.live -= 1;
      if (retired) {
        counters.retiring -= 1;
        // its GPU may be waiting for it (a switch to or from lanes)
        startMissingWorkers(runtime);
      }
      // The remaining workers may all be parked on a pause already.
      await persistPauseWhenParked(runtime).catch(() => undefined);
    }
  }

  async function consume(runtime) {
    // A job with lanes first finds its GPUs (again when the lanes changed
    // meanwhile). Without lanes nothing waits: the workers start at once.
    let plan = null;
    for (let lanes = lanesOf(runtime.manifest); lanes;) {
      const resolved = await resolveLanes(lanes);
      const latest = lanesOf(runtime.manifest);
      if (JSON.stringify(latest) === JSON.stringify(lanes)) {
        plan = resolved;
        break;
      }
      lanes = latest;
    }
    runtime.lanePlan = plan;
    // Workers added while the job runs (Parallel conversions raised) are
    // waited for too.
    const workers = [];
    runtime.addWorker = (lane = null) => workers.push(work(runtime, lane));
    if (!plan || plan.fallback) {
      for (let index = 0; index < concurrencyOf(runtime.manifest); index += 1) runtime.addWorker();
    } else {
      for (const [id, device] of plan.devices) {
        for (let index = 0; index < plan.limits.get(id); index += 1) runtime.addWorker({ id, device });
      }
    }
    const results = [];
    try {
      while (results.length < workers.length) results.push(...await Promise.allSettled(workers.slice(results.length)));
    } finally {
      runtime.addWorker = null;
    }
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }

  // Parallel conversions changed while the job runs (the GPU is needed
  // elsewhere, or there is room for more): saved with the job, so a restart
  // keeps it. Raising starts workers now; lowering lets the extra ones finish
  // their clip and stop.
  async function setConcurrency(id, value) {
    if (!isValidConcurrency(value)) throw serviceError('INVALID_CONCURRENCY');
    const runtime = await ensureRuntime(id);
    if (TERMINAL_STATES.has(runtime.manifest.state)) throw serviceError('JOB_NOT_ACTIVE');
    const lanes = lanesOf(runtime.manifest);
    if (lanes) {
      // One number for a job with a number per GPU: the Encoder page shows
      // the single number when it lists fewer than two GPUs (one went away,
      // or the list has not come yet). It goes to the one GPU the job still
      // has; otherwise the job carries on without lanes.
      const plan = runtime.lanePlan;
      const kept = plan ? (plan.fallback ? [] : [...plan.devices.keys()]) : lanes.map((lane) => lane.device);
      if (kept.length === 1) return setLanes(id, [{ device: kept[0], concurrency: value }]);
      return dropLanes(runtime, value);
    }
    if (concurrencyOf(runtime.manifest) === value) return publicSnapshot(runtime.manifest);
    await update(runtime, (current) => ({ config: { ...current.config, concurrency: value } }));
    startMissingWorkers(runtime);
    return publicSnapshot(runtime.manifest);
  }

  // A lanes job becomes a job without lanes (the default device's workers
  // take over as the lanes' workers finish their clip).
  async function dropLanes(runtime, value) {
    const running = () => typeof runtime.addWorker === 'function' && !runtime.cancelRequested && !runtime.stopRequested;
    if (running()) await noteDefaultLane(runtime, false);
    await update(runtime, (current) => {
      const { lanes: _lanes, ...config } = current.config;
      return { config: { ...config, concurrency: value } };
    });
    if (running()) {
      runtime.lanePlan = null;
      startMissingWorkers(runtime);
    }
    return publicSnapshot(runtime.manifest);
  }

  // Conversions at once per GPU changed while the job runs; saved with the
  // job like Parallel conversions. A GPU set higher (or added) starts its
  // workers now; one set lower or removed finishes its clips first. The
  // workers follow the lanes found in memory, not the saved ones, so the
  // workers of a lane that goes away keep going until the new ones start.
  async function setLanes(id, value) {
    let lanes;
    try { lanes = normalizeLanes(value); } catch (_) { lanes = null; }
    if (!lanes) throw serviceError('INVALID_LANES');
    const runtime = await ensureRuntime(id);
    if (TERMINAL_STATES.has(runtime.manifest.state)) throw serviceError('JOB_NOT_ACTIVE');
    if (JSON.stringify(lanesOf(runtime.manifest)) === JSON.stringify(lanes)) return publicSnapshot(runtime.manifest);
    const running = () => typeof runtime.addWorker === 'function' && !runtime.cancelRequested && !runtime.stopRequested;
    // the GPUs are looked up first, so the new lanes start as they are saved
    const found = running() ? await resolveLanes(lanes) : null;
    await update(runtime, (current) => ({ config: { ...current.config, lanes, concurrency: lanesTotal(lanes) } }));
    // (a run that started meanwhile with the old lanes takes the new ones too)
    if (running()) {
      const plan = found || await resolveLanes(lanes);
      if (running()) await noteDefaultLane(runtime, !plan.fallback);
      if (running()) {
        runtime.lanePlan = plan;
        startMissingWorkers(runtime);
      }
    }
    return publicSnapshot(runtime.manifest);
  }

  async function finalize(runtime) {
    await runtime.persistChain.catch(() => undefined);
    if (runtime.recoveryRequired || runtime.manifest.recovery?.action === 'manual-intervention') return;
    if (runtime.cancelRequested) {
      // Discovery persists items ahead of the workers, so a cancelled job can
      // hold queued items even after a worker already marked the job cancelled.
      if (runtime.manifest.state !== 'cancelled'
          || runtime.manifest.items.some((item) => item.state === 'queued' || item.state === 'processing')) {
        await update(runtime, (current) => ({
          state: 'cancelled',
          activeItemId: null,
          summary: null,
          summaryDismissed: false,
          failure: null,
          items: current.items.map((item) => item.state === 'queued' || item.state === 'processing'
            ? mergeItem(item, { state: 'cancelled', failure: undefined })
            : item)
        }));
      }
      emit(runtime, 'cancelled');
      return;
    }
    // Files owned by a clip still to do or in progress; leftovers of a
    // finished clip whose cleanup is pending are not unfinished work.
    const ownsInFlight = (item) => (item.state === 'queued' || item.state === 'processing')
      && Object.keys(item.ownedPaths || {}).length > 0;
    if (runtime.stopRequested && runtime.stopWhilePaused && !runtime.manifest.items.some(ownsInFlight)) {
      await update(runtime, (current) => ({
        state: 'paused', activeItemId: null, recovery: null,
        items: current.items.map((item) => item.state === 'processing' ? mergeItem(item, { state: 'queued', failure: undefined }) : item)
      }));
      emit(runtime, 'paused');
      return;
    }
    if (runtime.stopRequested) {
      await update(runtime, (current) => {
        const unresolved = current.items.find((item) => Object.keys(item.ownedPaths || {}).length > 0);
        // (a clip that finished its save while the stop came is done: only
        // its private work files may be left, which the restart removes)
        const interrupted = current.items.find((item) => item.id === runtime.stopItemId && item.state === 'processing'
          && Object.keys(item.ownedPaths || {}).length > 0);
        const mappedPhase = runtime.stopPhase === 'copying' || runtime.stopPhase === 'replacing'
          ? runtime.stopPhase : 'encoding';
        // Stopped while running with no clip half done (an update between
        // clips, or the save in progress finished first): marked so the
        // restart carries on by itself. A bare "restart-encoding" without a
        // clip, as earlier versions saved it for paused jobs too, stays
        // paused.
        const replacingNow = mappedPhase === 'replacing' && Boolean(current.replacementPhase);
        const nothingHalfDone = !interrupted && !replacingNow && !current.items.some(ownsInFlight);
        const recovery = nothingHalfDone
          ? { fromState: 'waiting', action: current.discoveryComplete === false ? 'resume-discovery' : 'resume-queue' }
          : mappedPhase === 'copying'
            ? { fromState: 'copying', action: interrupted ? 'manual-intervention' : 'restart-copy' }
            : mappedPhase === 'replacing' && current.replacementPhase
              ? { fromState: 'replacing', phase: current.replacementPhase, action: 'manual-intervention' }
              : {
                fromState: 'encoding',
                action: interrupted ? 'cleanup-and-restart-encoding' : 'restart-encoding'
              };
        return {
          state: 'paused',
          activeItemId: interrupted?.id || null,
          summary: null,
          summaryDismissed: false,
          failure: null,
          recovery,
          ownedPaths: unresolved?.ownedPaths || {},
          ownedArtifacts: unresolved?.ownedArtifacts || {},
          publicationArtifact: unresolved?.publicationArtifact || null,
          replacementPhase: mappedPhase === 'replacing' ? current.replacementPhase : null,
          items: current.items.map((item) => interrupted?.id === item.id
            ? mergeItem(item, { state: 'processing', failure: undefined })
            : item.state === 'processing' ? mergeItem(item, { state: 'queued', failure: undefined }) : item)
        };
      });
      emit(runtime, 'paused');
      return;
    }
    if (runtime.manifest.state === 'failed') return;
    if (runtime.manifest.discoveryComplete === false) {
      const fromState = runtime.manifest.state === 'discovering' ? 'discovering' : 'waiting';
      await update(runtime, {
        state: 'paused',
        activeItemId: null,
        summary: null,
        summaryDismissed: false,
        failure: null,
        recovery: { fromState, action: 'resume-discovery' }
      });
      emit(runtime, 'paused');
      return;
    }
    const summary = serializeSummary(runtime.manifest.counters);
    await update(runtime, (current) => {
      const unresolved = current.items.find((item) => Object.keys(item.ownedPaths || {}).length > 0);
      return {
        state: 'completed',
        activeItemId: null,
        summary,
        summaryDismissed: false,
        ownedPaths: unresolved?.ownedPaths || {},
        ownedArtifacts: unresolved?.ownedArtifacts || {},
        publicationArtifact: unresolved?.publicationArtifact || null,
        replacementPhase: null
      };
    });
    emit(runtime, 'completed', { summary });
  }

  function launch(runtime, { discover = true, itemIds = [] } = {}) {
    if (runtime.suppressLaunch) return Promise.resolve();
    if (runtime.runPromise && runtime.runKind !== 'recovery') return runtime.runPromise;
    const launchedFromRecovery = runtime.runKind === 'recovery';
    const producer = Promise.resolve().then(async () => {
      for (const itemId of itemIds) await runtime.queue.push(itemId);
      if (discover) await produce(runtime);
      else {
        runtime.producerDone = true;
        runtime.queue.close();
      }
    });
    const consumer = consume(runtime);
    const jobPromise = Promise.allSettled([producer, consumer])
      .then(async (results) => {
        const rejected = results.find((result) => result.status === 'rejected');
        if (rejected && runtime.manifest.state !== 'failed' && !runtime.cancelRequested && !runtime.stopRequested && !runtime.recoveryRequired) {
          await update(runtime, {
            state: 'failed', activeItemId: null, summary: null, summaryDismissed: false,
            failure: { code: stableFailure(rejected.reason), retryable: false }
          });
          return;
        }
        await finalize(runtime);
      })
      // What this run learned about converted clips is on disk once it ends.
      .finally(() => flushConvertedIndex());
    const tracked = jobPromise.finally(() => {
      if (runtime.runPromise === tracked) {
        runtime.runPromise = null;
        runtime.runKind = null;
      }
    });
    if (!launchedFromRecovery) {
      runtime.runKind = 'job';
      runtime.runPromise = tracked;
    }
    return tracked;
  }

  // Automatic jobs for different vehicles may run side by side when they
  // share no device (a GPU or a node): each has lanes of its own. Anything
  // else (a job started by hand, one without lanes) runs alone, as always.
  // the same folder, or one inside the other: the same files
  function overlaps(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return true;
    const [x, y] = [pathApi.resolve(a), pathApi.resolve(b)];
    return x === y || x.startsWith(y + pathApi.sep) || y.startsWith(x + pathApi.sep);
  }

  function mayRunAlongside(config, others) {
    const devicesOf = (c) => (Array.isArray(c?.lanes) ? c.lanes.map((lane) => lane.device) : null);
    const mine = devicesOf(config);
    if (config?.autoConvert !== true || !mine?.length) return false;
    const taken = new Set();
    for (const other of others) {
      const theirs = devicesOf(other.config);
      if (other.config?.autoConvert !== true || !theirs?.length || overlaps(other.config.sourceRoot, config.sourceRoot)) return false;
      // a paused job uses no device (automatic conversion gives it devices
      // again before it resumes it)
      if (other.state === 'paused') continue;
      for (const device of theirs) taken.add(device);
    }
    return mine.every((device) => !taken.has(device));
  }

  async function startUnlocked(config) {
    if (shuttingDown) throw serviceError('SERVICE_SHUTDOWN');
    const persistedJobs = await store.list();
    const active = new Map();
    for (const manifest of persistedJobs) if (ACTIVE_STATES.has(manifest.state)) active.set(manifest.id, manifest);
    for (const runtime of jobs.values()) {
      if (ACTIVE_STATES.has(runtime.manifest.state) && !TERMINAL_STATES.has(runtime.manifest.state)) active.set(runtime.manifest.id, runtime.manifest);
    }
    if (active.size > 0 && !mayRunAlongside(config, [...active.values()])) throw serviceError('JOB_ACTIVE');
    const created = await store.create({
      config: clone(config),
      state: 'discovering',
      createdAt: clock.now(),
      updatedAt: clock.now(),
      items: [],
      counters: createEmptyCounters(),
      summary: null,
      summaryDismissed: false,
      discoveryComplete: false
    });
    const runtime = runtimeFor(created);
    jobs.set(created.id, runtime);
    emit(runtime, 'started', { snapshot: publicSnapshot(created) });
    launch(runtime, { discover: true });
    return created.id;
  }

  function start(config) {
    return serializeCommand(() => startUnlocked(config));
  }

  async function ensureRuntime(id) {
    if (jobs.has(id)) return jobs.get(id);
    const manifest = await store.load(id);
    if (!manifest) throw serviceError('JOB_NOT_FOUND');
    const runtime = runtimeFor(manifest);
    jobs.set(id, runtime);
    return runtime;
  }

  // A run that stopped itself (a clip that could not be finished safely
  // parks the job for recovery) leaves its runtime spent: the abort signal
  // stays aborted and the stop flags stay set. Resume and Cancel then re-read
  // the interrupted clip's files with that aborted signal (INSPECTION_FAILED)
  // and a relaunched worker would stop at once, until the app restarted.
  // Once that run has ended, the job carries on from a fresh runtime.
  async function liveRuntime(id) {
    const runtime = await ensureRuntime(id);
    if (runtime.runPromise || shuttingDown) return runtime;
    const spent = runtime.abortController.signal.aborted || runtime.recoveryRequired
      || runtime.cancelRequested || runtime.halted;
    if (!spent) return runtime;
    const fresh = runtimeFor(runtime.manifest);
    jobs.set(id, fresh);
    return fresh;
  }

  async function get(id) {
    const runtime = jobs.get(id);
    const manifest = runtime ? runtime.manifest : await store.load(id);
    if (!manifest) throw serviceError('JOB_NOT_FOUND');
    return publicSnapshot(manifest);
  }

  async function list() {
    return deepFreeze((await store.list()).map(publicSnapshot));
  }

  async function pause(id) {
    const runtime = await ensureRuntime(id);
    if (TERMINAL_STATES.has(runtime.manifest.state)) return publicSnapshot(runtime.manifest);
    runtime.pauseRequested = true;
    emit(runtime, 'pause_requested');
    return publicSnapshot(runtime.manifest);
  }

  async function resume(id) {
    const runtime = await liveRuntime(id);
    if (runtime.manifest.state !== 'paused' && !runtime.pauseRequested) throw serviceError('JOB_NOT_PAUSED');
    // A replacement interrupted by a restart (an update of the container, a
    // power cut) that recovery parked for a decision: Resume re-reads the
    // files like Cancel does, finishes or rolls back that one clip, and the
    // job carries on with the rest. Only an ambiguous state still needs one.
    if (runtime.manifest.recovery?.fromState === 'replacing' && !runtime.runPromise) {
      await resolveReplacementBeforeCancel(runtime, id, { relaunch: true });
      emit(runtime, 'resumed');
      return publicSnapshot(runtime.manifest);
    }
    // A pause that has not taken effect (a worker is still on its clip, maybe
    // mid-replacement or waiting out an outage) is simply called off: the job
    // state belongs to that worker, and writing 'waiting' over it was
    // rejected mid-replacement, which left the parked workers parked.
    if (runtime.manifest.state !== 'paused' && runtime.runPromise) {
      runtime.pauseRequested = false;
      runtime.pausePersisted = false;
      for (const resolve of runtime.pauseWaiters.splice(0)) resolve();
      emit(runtime, 'resumed');
      return publicSnapshot(runtime.manifest);
    }
    await releaseInterruptedSave(runtime);
    if (runtime.manifest.activeItemId && runtime.manifest.recovery) throw serviceError('RECOVERY_REQUIRED');
    runtime.pauseRequested = false;
    runtime.pausePersisted = false;
    await update(runtime, { state: 'waiting', recovery: null });
    for (const resolve of runtime.pauseWaiters.splice(0)) resolve();
    if (!runtime.runPromise) {
      runtime.queue = new BoundedQueue(queueLimit);
      launch(runtime, {
        discover: runtime.manifest.discoveryComplete === false,
        itemIds: runtime.manifest.items.filter((item) => item.state === 'queued').map((item) => item.id)
      });
    }
    emit(runtime, 'resumed');
    return publicSnapshot(runtime.manifest);
  }

  // A job parked mid-replacement (for example by an interrupted replace) can
  // only be cancelled once that original is safe. Re-inspect the files with the
  // replacement truth tables; if they show an unambiguous state, finish or roll
  // back that one item through the normal recovery path, then cancel. Ambiguous
  // states keep RECOVERY_REQUIRED.
  async function resolveReplacementBeforeCancel(runtime, id, { relaunch = false } = {}) {
    if (runtime.runPromise || typeof deps.inspectRecovery !== 'function') throw serviceError('RECOVERY_REQUIRED');
    const signal = runtime.abortController.signal;
    const inspectWithSignal = (manifest) => abortableRead(() => deps.inspectRecovery(manifest, { signal }), signal);
    // The recovery path normally relaunches the queue; for a cancel it must
    // only settle the interrupted item, and the cancel then finalizes the rest.
    runtime.suppressLaunch = !relaunch;
    try {
      const recovered = await store.recover(id, inspectWithSignal, { reinspectReplacement: true });
      runtime.manifest = recovered;
      if (recovered.recovery?.fromState !== 'replacing' || recovered.recovery.action === 'manual-intervention') {
        throw serviceError('RECOVERY_REQUIRED');
      }
      await performRecovery(runtime, id, inspectWithSignal, recovered);
      if (runtime.manifest.recovery?.fromState === 'replacing') throw serviceError('RECOVERY_REQUIRED');
    } finally {
      runtime.suppressLaunch = false;
    }
  }

  // A job stopped while saving a clip (the computer crashed, lost power or
  // was shut down mid-save) waits for a decision before it continues: its
  // workers show as busy, Resume answered RECOVERY_REQUIRED and Cancel did
  // nothing, so the job could not be ended from the app. Unless an original
  // already moved to its backup name (the job then says 'replacing' and has
  // its own recovery), no original is at risk: the interrupted clips'
  // leftover working files are removed (a record is kept of any that cannot
  // be) and the clips go back in the queue. Recovery does this by itself
  // after a restart (resume: the job carries on); Resume and Cancel do it
  // for a job that still waits.
  async function releaseInterruptedSave(runtime, { resume = false } = {}) {
    const recovery = runtime.manifest.recovery;
    if (recovery?.action !== 'manual-intervention' || recovery.fromState === 'replacing'
        || runtime.manifest.replacementPhase || (runtime.runPromise && runtime.runKind !== 'recovery')) return false;
    const interrupted = runtime.manifest.items.filter((item) => item.state === 'processing');
    for (const item of interrupted) {
      const backup = item.ownedPaths?.replacementBackup;
      if (!backup) continue;
      if (item.ownedArtifacts?.replacementBackup?.state !== 'intent') return false;
      if (typeof deps.pathExists !== 'function') return false;
      try {
        if (await deps.pathExists(backup)) return false;
      } catch (_) { return false; }
    }
    const pending = new Set();
    for (const item of interrupted) {
      if (Object.keys(item.ownedPaths || {}).length === 0) continue;
      if (!await reconcileItemOwnership(runtime, item.id, ownershipOf(item), { scope: 'item' })) pending.add(item.id);
    }
    await update(runtime, (current) => ({
      state: resume ? 'waiting' : 'paused', activeItemId: null, recovery: null, replacementPhase: null,
      ownedPaths: {}, ownedArtifacts: {}, publicationArtifact: null, failure: null,
      items: current.items.map((entry) => {
        if (entry.state !== 'processing') return entry;
        return pending.has(entry.id)
          ? mergeItem(entry, { state: 'failed', resultCode: 'cleanup-pending', failure: { code: 'interrupted', retryable: false } })
          : mergeItem(entry, { state: 'queued', failure: undefined, resultCode: undefined });
      })
    }));
    for (const item of interrupted) {
      if (!pending.has(item.id)) setOwnership(runtime, item.id, null);
    }
    emit(runtime, 'interrupted_save_released', { pending: pending.size });
    return true;
  }

  async function cancel(id) {
    const runtime = await liveRuntime(id);
    if (runtime.manifest.recovery?.fromState === 'replacing') await resolveReplacementBeforeCancel(runtime, id);
    await releaseInterruptedSave(runtime);
    // Still waiting on a decision (an original may be at risk): say so instead
    // of returning as if the job had been cancelled.
    if (runtime.manifest.recovery?.action === 'manual-intervention' && !runtime.runPromise) {
      throw serviceError('RECOVERY_REQUIRED');
    }
    if (runtime.manifest.state === 'cancelled') return publicSnapshot(runtime.manifest);
    runtime.cancelRequested = true;
    runtime.abortController.abort();
    runtime.queue.close();
    for (const resolve of runtime.pauseWaiters.splice(0)) resolve();
    terminateChildren(runtime);
    if (runtime.runPromise) await runtime.runPromise;
    else await finalize(runtime);
    return publicSnapshot(runtime.manifest);
  }

  // Last resort for a job that cannot be ended normally (Cancel failed):
  // stop anything it is running and set it aside so the converter is free
  // again. Converted files and the clips themselves are kept; the job file is
  // renamed rather than deleted.
  async function discard(id) {
    const runtime = jobs.get(id);
    if (runtime) {
      runtime.cancelRequested = true;
      runtime.abortController.abort();
      runtime.queue?.close?.();
      for (const resolve of runtime.pauseWaiters.splice(0)) resolve();
      terminateChildren(runtime);
      if (runtime.runPromise) {
        await Promise.race([runtime.runPromise.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 30_000).unref?.())]);
      }
      jobs.delete(id);
    }
    if (typeof store.discard !== 'function') throw serviceError('OPERATION_FAILED');
    await store.discard(id);
    for (const listener of listeners) {
      try { listener(deepFreeze({ type: 'discarded', jobId: id })); } catch (_) { /* observers are advisory */ }
    }
    return { jobId: id, discarded: true };
  }

  async function retryFailed(id) {
    const runtime = await liveRuntime(id);
    if (runtime.manifest.recovery?.fromState === 'replacing') throw serviceError('RECOVERY_REQUIRED');
    if (runtime.runPromise) throw serviceError('JOB_ACTIVE');
    if (!['completed', 'failed'].includes(runtime.manifest.state)) throw serviceError('JOB_NOT_RETRYABLE');
    if (!runtime.manifest.items.some((item) => item.state === 'failed')) throw serviceError('NO_FAILED_ITEMS');
    for (const item of runtime.manifest.items.filter((entry) => entry.state === 'failed')) {
      if (!await reconcileItemOwnership(runtime, item.id, item)) throw serviceError('RECOVERY_REQUIRED');
    }
    await update(runtime, (current) => ({
      state: 'waiting',
      summary: null,
      summaryDismissed: false,
      failure: null,
      items: current.items.map((item) => item.state === 'failed'
        ? mergeItem(item, { state: 'queued', attempts: 0, failure: undefined, resultCode: undefined })
        : item)
    }));
    runtime.queue = new BoundedQueue(queueLimit);
    launch(runtime, {
      discover: false,
      itemIds: runtime.manifest.items.filter((item) => item.state === 'queued').map((item) => item.id)
    });
    return publicSnapshot(runtime.manifest);
  }

  async function dismissSummary(id) {
    const runtime = await ensureRuntime(id);
    if (runtime.manifest.state !== 'completed') throw serviceError('JOB_NOT_COMPLETED');
    await update(runtime, { summary: null, summaryDismissed: true });
    emit(runtime, 'summary_dismissed');
    return publicSnapshot(runtime.manifest);
  }

  // Clips that finished (or failed) while their private work files were still
  // being removed: a stop right after the clip's result was recorded. Those
  // files are removed now and the records cleared.
  const PRIVATE_KEYS = new Set(['stagedSource', 'encodedCandidate', 'publicationSnapshot']);
  async function sweepFinishedLeftovers(runtime) {
    const finished = runtime.manifest.items.filter((entry) => TERMINAL_STATES.has(entry.state)
      && Object.keys(entry.ownedPaths || {}).length > 0
      && Object.keys(entry.ownedPaths).every((key) => PRIVATE_KEYS.has(key)));
    for (const item of finished) {
      const ownership = ownershipOf(item);
      const cleanup = await cleanupOwnership(runtime, item.id, ownership, runtime.abortController.signal, { scope: 'item' });
      if (cleanup.cleaned === true) {
        await itemPatch(runtime, item.id, {
          ownedPaths: {}, ownedArtifacts: {}, publicationArtifact: undefined,
          ...(item.resultCode === 'completed-cleanup-pending' ? { resultCode: item.eligibleVideo === false ? 'copied' : 'converted' } : {})
        });
      }
      setOwnership(runtime, item.id, null);
    }
  }

  // With several workers, items other than the job-level active item may have
  // been mid-encode when the app stopped. They never entered the exclusive
  // publish/replace phase, so their owned artifacts are temporary encode
  // outputs: clean them up and queue the items again.
  async function releaseInterruptedItems(runtime, keepItemId) {
    const interrupted = runtime.manifest.items.filter((entry) => entry.state === 'processing' && entry.id !== keepItemId);
    for (const item of interrupted) {
      if (Object.keys(item.ownedPaths || {}).length === 0) continue;
      if (!await reconcileItemOwnership(runtime, item.id, item, { scope: 'item' })) return false;
    }
    if (interrupted.length === 0) return true;
    const ids = new Set(interrupted.map((entry) => entry.id));
    await update(runtime, (current) => ({
      items: current.items.map((entry) => ids.has(entry.id) && entry.state === 'processing'
        ? mergeItem(entry, { state: 'queued', failure: undefined, resultCode: undefined }) : entry)
    }));
    return true;
  }

  async function relaunch(runtime) {
    runtime.queue = new BoundedQueue(queueLimit);
    await launch(runtime, {
      discover: runtime.manifest.discoveryComplete === false,
      itemIds: runtime.manifest.items.filter((entry) => entry.state === 'queued').map((entry) => entry.id)
    });
  }

  // The interrupted clip starts over: its files are removed and it goes back
  // in the queue. One whose files cannot all be removed (still recorded for
  // a later attempt) is failed instead and the job carries on; false only
  // when a backup of an original is among them (that needs a decision).
  async function requeueRecovered(runtime, item, ownership) {
    let retained = null;
    if (Object.keys(ownership?.ownedPaths || {}).length > 0) {
      const cleanup = await cleanupOwnership(runtime, item.id, ownership);
      if (cleanup.recoveryRequired) return false;
      if (cleanup.cleaned === false) retained = composeOwnership(ownership, cleanup);
    }
    const jobChanges = {
      state: 'waiting', activeItemId: null, recovery: null, replacementPhase: null,
      ownedPaths: {}, ownedArtifacts: {}, publicationArtifact: null
    };
    if (retained) {
      await itemPatch(runtime, item.id, {
        state: 'failed', failure: { code: 'interrupted', retryable: false }, resultCode: 'cleanup-pending',
        ownedPaths: retained.ownedPaths, ownedArtifacts: retained.ownedArtifacts,
        publicationArtifact: retained.ownedPaths.publicationSnapshot ? retained.publicationArtifact : undefined,
        replacementPhase: undefined
      }, jobChanges);
    } else {
      await itemPatch(runtime, item.id, {
        state: 'queued', failure: undefined, resultCode: undefined,
        ownedPaths: {}, ownedArtifacts: {}, publicationArtifact: undefined, replacementPhase: undefined
      }, jobChanges);
    }
    setOwnership(runtime, item.id, null);
    return true;
  }

  async function performRecovery(runtime, id, inspectWithSignal, recovered) {
    let recovery = recovered.recovery;
    // Clips other than the job's active one never reached the save slot (at
    // most one clip is ever in it): their files are removed and they go back
    // in the queue. This holds for any number at once, also a job lowered to
    // one conversion at once while several clips were under way.
    if (recovery?.action !== 'manual-intervention'
        && !await releaseInterruptedItems(runtime, recovered.activeItemId)) {
      return publicSnapshot(runtime.manifest);
    }
    await sweepFinishedLeftovers(runtime);
    if (recovery?.action === 'resume-network') {
      const interrupted = currentItem(runtime, recovered.activeItemId);
      const target = recovery.pathRole === 'destination' && interrupted
        ? recovered.config.destinationRoot
        : recovery.pathRole === 'source' && interrupted ? interrupted.sourcePath : recovered.config.sourceRoot;
      const resumeState = recovery.resumeState || 'waiting';
      await waitForNetwork(runtime, target, { resumeState, phase: recovery.phase, pathRole: recovery.pathRole });
      if (new Set(['staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing']).has(resumeState)) {
        recovered = await store.recover(id, inspectWithSignal);
        runtime.manifest = recovered;
        recovery = recovered.recovery;
      } else {
        if (interrupted && Object.keys(interrupted.ownedPaths || {}).length > 0) {
          setOwnership(runtime, interrupted.id, ownershipOf(interrupted));
          if (!await reconcileItemOwnership(runtime, interrupted.id, ownershipFor(runtime, interrupted.id))) {
            return publicSnapshot(runtime.manifest);
          }
        }
        await update(runtime, (current) => ({
          state: 'waiting', activeItemId: null, recovery: null,
          items: current.items.map((entry) => entry.state === 'processing'
            ? mergeItem(entry, { state: 'queued', failure: undefined }) : entry)
        }));
        runtime.queue = new BoundedQueue(queueLimit);
        await launch(runtime, {
          discover: runtime.manifest.discoveryComplete === false,
          itemIds: runtime.manifest.items.filter((entry) => entry.state === 'queued').map((entry) => entry.id)
        });
        emit(runtime, 'recovered');
        return publicSnapshot(runtime.manifest);
      }
    }
    if (recovery?.action === 'resume-discovery' || recovery?.action === 'resume-queue') {
      await update(runtime, (current) => ({
        state: 'waiting',
        activeItemId: null,
        recovery: null,
        items: current.items.map((entry) => entry.state === 'processing'
          ? mergeItem(entry, { state: 'queued', failure: undefined }) : entry)
      }));
      runtime.queue = new BoundedQueue(queueLimit);
      await launch(runtime, {
        discover: recovery.action === 'resume-discovery',
        itemIds: runtime.manifest.items.filter((entry) => entry.state === 'queued').map((entry) => entry.id)
      });
      emit(runtime, 'recovered');
      return publicSnapshot(runtime.manifest);
    }
    const item = currentItem(runtime, recovered.activeItemId);
    if (item?.state === 'completed') {
      await update(runtime, {
        state: 'waiting', activeItemId: null, recovery: null,
        ownedPaths: item.ownedPaths || {}, ownedArtifacts: item.ownedArtifacts || {},
        publicationArtifact: item.publicationArtifact || null, replacementPhase: null
      });
      runtime.queue = new BoundedQueue(queueLimit);
      await launch(runtime, {
        discover: runtime.manifest.discoveryComplete === false,
        itemIds: runtime.manifest.items.filter((entry) => entry.state === 'queued').map((entry) => entry.id)
      });
      emit(runtime, 'recovered');
      return publicSnapshot(runtime.manifest);
    }
    // Parked mid-save by an earlier version (or before the clip's original
    // ever moved): nothing of the footage is at risk when no backup of an
    // original is on disk, so the clips' leftovers go and they start over.
    if (recovery?.action === 'manual-intervention' && recovery.fromState !== 'replacing') {
      if (!await releaseInterruptedSave(runtime, { resume: true })) return publicSnapshot(runtime.manifest);
      await relaunch(runtime);
      emit(runtime, 'recovered');
      return publicSnapshot(runtime.manifest);
    }
    if (!item || !recovery || recovery.action === 'manual-intervention') return publicSnapshot(recovered);

    async function completeRecovered(finalPath, outputBytes, transactionResult = {}) {
      const publicationArtifact = item.publicationArtifact || recovered.publicationArtifact;
      let retainedResult = transactionResult;
      if (Object.keys(transactionResult.ownedPaths || {}).length > 0) {
        const cleanup = await cleanupOwnership(runtime, item.id, {
          ...transactionResult,
          publicationArtifact
        });
        retainedResult = cleanup.cleaned === true
          ? { ownedPaths: {}, ownedArtifacts: {}, cleanupPending: [] }
          : {
            ownedPaths: cleanup.ownedPaths || transactionResult.ownedPaths || {},
            ownedArtifacts: cleanup.ownedArtifacts || transactionResult.ownedArtifacts || {},
            cleanupPending: cleanup.cleanupPending || transactionResult.cleanupPending || []
          };
      }
      const completed = {
        ...item,
        state: 'completed',
        eligibleVideo: true,
        outputPath: finalPath,
        outputBytes,
        resultCode: retainedResult.cleanupPending?.length ? 'completed-cleanup-pending' : 'converted',
        ownedPaths: retainedResult.ownedPaths || {},
        ownedArtifacts: retainedResult.ownedArtifacts || {}
      };
      delete completed.failure;
      if (completed.ownedPaths.publicationSnapshot) completed.publicationArtifact = publicationArtifact;
      else delete completed.publicationArtifact;
      delete completed.replacementPhase;
      await update(runtime, (current) => {
        const counters = addCompletedFile(current.counters, completed);
        return {
          state: 'waiting',
          activeItemId: null,
          recovery: null,
          items: current.items.map((entry) => entry.id === item.id ? completed : entry),
          counters,
          summary: null,
          summaryDismissed: false,
          ownedPaths: completed.ownedPaths,
          ownedArtifacts: completed.ownedArtifacts,
          publicationArtifact: completed.publicationArtifact || null,
          replacementPhase: null
        };
      });
      rememberConverted(finalPath, recovered.config.codec);
      runtime.queue = new BoundedQueue(queueLimit);
      await launch(runtime, {
        discover: runtime.manifest.discoveryComplete === false,
        itemIds: runtime.manifest.items.filter((entry) => entry.state === 'queued').map((entry) => entry.id)
      });
    }

    if (recovery.fromState === 'copying') {
      const destination = outputPath(recovered.config, item);
      if (item.kind === 'asset') {
        let result;
        if (recovery.action === 'finalize-copy') {
          const cleanup = await cleanupOwnership(runtime, item.id, item);
          result = {
            finalPath: destination,
            outputBytes: item.sourceBytes,
            ownedPaths: cleanup.cleaned === false ? item.ownedPaths : {},
            ownedArtifacts: cleanup.cleaned === false ? item.ownedArtifacts : {},
            cleanupPending: cleanup.cleanupPending || []
          };
        } else {
          if (item.ownedPaths && Object.keys(item.ownedPaths).length) {
            const cleanup = await cleanupOwnership(runtime, item.id, item);
            if (cleanup.cleaned === false) return publicSnapshot(runtime.manifest);
          }
          await prepareDestination(recovered.config, destination);
          result = await staging.copyAsset({
            source: item.sourcePath,
            sourceRoot: recovered.config.sourceRoot,
            destination,
            destinationRoot: recovered.config.destinationRoot,
            jobId: recovered.id,
            itemId: item.id,
            signal: runtime.abortController.signal,
            persistTransaction: transactionPersistence(runtime, item.id)
          });
          const cleanup = await cleanupOwnership(runtime, item.id, result);
          if (cleanup.cleaned !== false) {
            result = { ...result, ownedPaths: {}, ownedArtifacts: {}, cleanupPending: [] };
          } else {
            result = { ...result, cleanupPending: cleanup.cleanupPending || result.cleanupPending || [] };
          }
        }
        const completed = {
          ...item,
          state: 'completed',
          eligibleVideo: false,
          outputPath: result.finalPath,
          outputBytes: result.outputBytes,
          resultCode: result.cleanupPending?.length ? 'completed-cleanup-pending' : 'copied',
          ownedPaths: result.ownedPaths || {},
          ownedArtifacts: result.ownedArtifacts || {}
        };
        delete completed.failure;
        await update(runtime, (current) => {
          const counters = addCompletedFile(current.counters, completed);
          return {
            state: 'waiting', activeItemId: null, recovery: null,
            items: current.items.map((entry) => entry.id === item.id ? completed : entry),
            counters, summary: null, summaryDismissed: false,
            ownedPaths: completed.ownedPaths, ownedArtifacts: completed.ownedArtifacts,
            publicationArtifact: completed.publicationArtifact || null, replacementPhase: null
          };
        });
        runtime.queue = new BoundedQueue(queueLimit);
        await launch(runtime, {
          discover: runtime.manifest.discoveryComplete === false,
          itemIds: runtime.manifest.items.filter((entry) => entry.state === 'queued').map((entry) => entry.id)
        });
        emit(runtime, 'recovered');
        return publicSnapshot(runtime.manifest);
      }
      const publicationArtifact = item.publicationArtifact || recovered.publicationArtifact;
      // Nothing (or only part) was copied yet: the clip's files go and it is
      // converted again (its verified snapshot cannot be published by a later
      // run).
      if (recovery.action === 'restart-copy' || (recovery.action === 'resume-copy'
          && (item.ownedArtifacts || recovered.ownedArtifacts)?.destinationPartial?.state !== 'owned')) {
        if (!await requeueRecovered(runtime, item, ownershipOf(item))) return publicSnapshot(runtime.manifest);
        await relaunch(runtime);
        emit(runtime, 'recovered');
        return publicSnapshot(runtime.manifest);
      }
      await prepareDestination(recovered.config, destination);
      const result = await staging.recoverCopy({
        action: recovery.action,
        destination,
        publicationArtifact,
        ownedPaths: item.ownedPaths || recovered.ownedPaths,
        ownedArtifacts: item.ownedArtifacts || recovered.ownedArtifacts,
        jobId: recovered.id,
        itemId: item.id,
        signal: runtime.abortController.signal,
        persistTransaction: transactionPersistence(runtime, item.id)
      });
      await completeRecovered(result.finalPath, publicationArtifact.size, result);
    } else if (recovery.fromState === 'replacing') {
      const publicationArtifact = item.publicationArtifact || recovered.publicationArtifact;
      if (!item.expectedSource || staging.capabilities?.replacement === 'unavailable') {
        await update(runtime, { state: 'paused', recovery: { ...recovery, action: 'manual-intervention' } });
        return publicSnapshot(runtime.manifest);
      }
      // Each step of the recovery records its phase as a 'replacing' job,
      // which the job file only accepts without the recovery note: with the
      // note left on, the first phase write failed and a replacement
      // interrupted by a restart could never finish (nor be cancelled). The
      // job goes back to exactly what a crash mid-replacement leaves; if the
      // recovery fails, it parks again for a decision, files untouched.
      await update(runtime, {
        state: 'replacing',
        activeItemId: item.id,
        replacementPhase: recovery.phase || recovered.replacementPhase,
        recovery: null
      });
      const park = (phase) => update(runtime, (current) => ({
        state: 'paused',
        activeItemId: item.id,
        replacementPhase: phase || current.replacementPhase || recovery.phase,
        recovery: { fromState: 'replacing', phase: phase || current.replacementPhase || recovery.phase, action: 'manual-intervention' }
      }));
      // Step by step until the clip is finished or its original is back:
      // after each step the files on disk decide the next one, so a restart
      // in the middle of a swap needs nobody to press Resume. Only a state
      // that is not clear (files changed by something else) waits for a
      // decision.
      let action = recovery.action;
      // Stopped after the backup was removed and the snapshot cleaned up but
      // before the clip was recorded (earlier versions wrote that last step
      // on its own): only the record is missing.
      if (!publicationArtifact) {
        const phase = recovery.phase || recovered.replacementPhase;
        // A swap that was put back (the snapshot already removed with it),
        // stopped before the job's record of it was cleared: the original
        // is at its name again, nothing of the swap is left, and the clip
        // is converted again.
        if (action === 'rollback-complete') {
          if (!await requeueRecovered(runtime, item, { ownedPaths: item.ownedPaths || recovered.ownedPaths || {}, ownedArtifacts: item.ownedArtifacts || recovered.ownedArtifacts || {} })) {
            await park(phase);
            return publicSnapshot(runtime.manifest);
          }
          await relaunch(runtime);
          emit(runtime, 'recovered');
          return publicSnapshot(runtime.manifest);
        }
        let stat = null;
        if (phase === 'backup-deleted' && action === 'finish-replacement' && typeof deps.statFile === 'function') {
          stat = await deps.statFile(item.sourcePath).catch(() => null);
        }
        if (!stat || !Number.isSafeInteger(Number(stat.size)) || Number(stat.size) <= 0) {
          await park(phase);
          return publicSnapshot(runtime.manifest);
        }
        await completeRecovered(item.sourcePath, Number(stat.size), {
          ownedPaths: item.ownedPaths || {}, ownedArtifacts: item.ownedArtifacts || {}
        });
        emit(runtime, 'recovered');
        return publicSnapshot(runtime.manifest);
      }
      let ownership = {
        ownedPaths: item.ownedPaths || recovered.ownedPaths || {},
        ownedArtifacts: item.ownedArtifacts || recovered.ownedArtifacts || {}
      };
      let result = null;
      let outcome = null;
      for (let step = 0; step < 6 && !outcome; step += 1) {
        if (action === 'manual-intervention') {
          outcome = 'park';
          break;
        }
        try {
          result = await staging.recoverReplacement({
            codec: recovered.config.codec,
            action,
            source: item.sourcePath,
            expectedSource: item.expectedSource,
            sourceRoot: recovered.config.sourceRoot,
            publicationArtifact,
            ownedPaths: ownership.ownedPaths,
            ownedArtifacts: ownership.ownedArtifacts,
            jobId: recovered.id,
            itemId: item.id,
            signal: runtime.abortController.signal,
            persistTransaction: transactionPersistence(runtime, item.id)
          });
        } catch (error) {
          // The original changed after it was converted: it stays as it is
          // and the clip is converted again from what it holds now.
          if (action === 'backup-original' && error?.code === 'SOURCE_CHANGED') {
            action = 'restart-replacement';
            continue;
          }
          await park().catch(() => undefined);
          throw error;
        }
        ownership = { ownedPaths: result.ownedPaths || {}, ownedArtifacts: result.ownedArtifacts || {} };
        if (result.action === 'restart-replacement') outcome = 'requeue';
        else if (result.phase === 'backup-deleted') outcome = 'complete';
        else if (result.phase === 'backup-restored') outcome = 'requeue';
        else {
          let facts;
          try {
            facts = await inspectWithSignal(clone({ ...runtime.manifest, state: 'replacing', replacementPhase: result.phase }));
          } catch (error) {
            await park(result.phase).catch(() => undefined);
            throw error;
          }
          action = replacementAction({ ...runtime.manifest, replacementPhase: result.phase }, facts);
        }
      }
      if (outcome === 'complete') {
        await completeRecovered(item.sourcePath, publicationArtifact.size, result);
      } else if (outcome === 'requeue') {
        if (!await requeueRecovered(runtime, item, { ...ownership, publicationArtifact: result?.publicationArtifact || publicationArtifact })) {
          await park(result?.phase);
          return publicSnapshot(runtime.manifest);
        }
        await relaunch(runtime);
      } else {
        await park(result?.phase);
        return publicSnapshot(runtime.manifest);
      }
    } else {
      if (recovery.action === 'cleanup-and-restart-encoding') {
        let interruptedOwnership = item;
        if (item.ownedArtifacts?.encodedCandidate?.state === 'intent' && staging.capabilities?.privateTempCleanup !== 'identity') {
          try {
            interruptedOwnership = await staging.adoptEncodeOutput({
              jobId: recovered.id,
              itemId: item.id,
              ownedPaths: item.ownedPaths,
              ownedArtifacts: item.ownedArtifacts,
              signal: runtime.abortController.signal,
              persistTransaction: transactionPersistence(runtime, item.id)
            });
          } catch (_) {
            return publicSnapshot(runtime.manifest);
          }
        }
        if (!await requeueRecovered(runtime, item, ownershipOf(interruptedOwnership))) return publicSnapshot(runtime.manifest);
      } else {
        await itemPatch(runtime, item.id, { state: 'queued', failure: undefined }, {
          state: 'waiting', activeItemId: null, recovery: null
        });
      }
      await relaunch(runtime);
    }
    emit(runtime, 'recovered');
    return publicSnapshot(runtime.manifest);
  }

  async function recover(id, inspectPaths = deps.inspectRecovery, { deferExecution = false } = {}) {
    let recoveryPromise;
    await serializeCommand(async () => {
      if (shuttingDown) throw serviceError('SERVICE_SHUTDOWN');
      if (typeof inspectPaths !== 'function') throw new TypeError('inspectPaths must be a function');
      const runtime = await ensureRuntime(id);
      // A failed startup can retry reconciliation without abandoning jobs that
      // already reconciled successfully and are still waiting at their gates.
      if (deferExecution && runtime.releaseRecovery) {
        recoveryPromise = runtime.reconciliationPromise;
        return;
      }
      if (runtime.runPromise) throw serviceError('JOB_ACTIVE');
      let reconciled, reconciliationFailed;
      const ready = new Promise((resolve, reject) => { reconciled = resolve; reconciliationFailed = reject; });
      ready.catch(() => {});
      runtime.reconciliationPromise = ready;
      const executionGate = deferExecution
        ? new Promise(resolve => { runtime.releaseRecovery = resolve; }) : Promise.resolve();
      const inspectWithSignal = manifest => abortableRead(
        () => inspectPaths(manifest, { signal: runtime.abortController.signal }), runtime.abortController.signal);
      let tracked;
      const operation = (async () => {
        try {
          // A job parked mid-replacement is looked at again on every start:
          // the files may show by now how to finish that clip or put its
          // original back.
          const recovered = await store.recover(id, inspectWithSignal, { reinspectReplacement: true });
          runtime.manifest = recovered;
          if (runtime.stopRequested || runtime.cancelRequested) throw serviceError('CANCELLED');
          reconciled(publicSnapshot(recovered));
          await abortableRead(() => executionGate, runtime.abortController.signal);
          runtime.releaseRecovery = null;
          return await performRecovery(runtime, id, inspectWithSignal, recovered);
        } catch (error) {
          reconciliationFailed(error);
          if (!runtime.stopRequested && !runtime.cancelRequested) throw error;
          await finalize(runtime);
          return publicSnapshot(runtime.manifest);
        }
      })();
      tracked = operation.finally(() => {
        if (runtime.runPromise === tracked) {
          runtime.runPromise = null;
          runtime.runKind = null;
          runtime.releaseRecovery = null;
        }
      });
      // Deferred recoveries can reject before the runtime reaches their serial
      // execution slot. Observe failures immediately and retain the same owned
      // promise for whenIdle/shutdown and the runtime's error reporter.
      tracked.catch(error => emit(runtime, 'recovery_failed', { code: stableFailure(error) }));
      runtime.runKind = 'recovery';
      runtime.runPromise = tracked;
      recoveryPromise = deferExecution ? ready : tracked;
    });
    return recoveryPromise;
  }

  async function continueRecovery(id) {
    const runtime = await ensureRuntime(id);
    if (shuttingDown) return runtime.runPromise;
    runtime.releaseRecovery?.();
    return runtime.runPromise;
  }

  async function whenIdle(id) {
    const runtime = await ensureRuntime(id);
    while (runtime.runPromise) await runtime.runPromise;
    return publicSnapshot(runtime.manifest);
  }

  // One entry per ffmpeg encoding right now, with its latest -progress numbers
  // (null until ffmpeg reports them). Synchronous and cheap: the server reads
  // it every couple of seconds while a page shows it.
  function activeEncodes() {
    const encodes = [];
    for (const runtime of jobs.values()) {
      for (const live of runtime.encodes.values()) encodes.push({ ...live });
    }
    return encodes;
  }

  // How many clips a job converts at once as it runs now: the lanes whose
  // GPU was found (one missing from the container starts none), else its
  // own number; null for a job this process does not hold.
  function slotsOf(id) {
    const runtime = jobs.get(id);
    if (!runtime) return null;
    const plan = runtime.lanePlan;
    // (the clips sent ahead to a node wait there: not converting)
    if (plan && !plan.fallback) return [...(plan.base || plan.limits).values()].reduce((sum, n) => sum + n, 0);
    return concurrencyOf(runtime.manifest);
  }

  async function shutdown() {
    if (shuttingDown) {
      await Promise.all([...jobs.values()].map((runtime) => runtime.runPromise).filter(Boolean));
      return;
    }
    shuttingDown = true;
    await Promise.all([...jobs.values()].map(async (runtime) => {
      if (TERMINAL_STATES.has(runtime.manifest.state)) return;
      runtime.stopPhase = runtime.manifest.state === 'paused_network'
        ? runtime.manifest.recovery?.resumeState
        : runtime.manifest.state === 'paused' ? runtime.manifest.recovery?.fromState : runtime.manifest.state;
      runtime.stopItemId = runtime.manifest.activeItemId || leadItemId(runtime);
      // paused by the owner (or the automatic window): it stays paused after
      // the restart; a job that was running carries on by itself
      runtime.stopWhilePaused = runtime.pauseRequested || (runtime.manifest.state === 'paused' && !runtime.manifest.recovery);
      runtime.stopRequested = true;
      runtime.abortController.abort();
      runtime.queue.close();
      for (const resolve of runtime.pauseWaiters.splice(0)) resolve();
      terminateChildren(runtime);
      if (runtime.runPromise) await runtime.runPromise;
      else await finalize(runtime);
    }));
  }

  // The jobs this process holds, from memory (no job file is read): every
  // job that is not finished has one since start() or startup recovery.
  function liveJobs() {
    return [...jobs.values()].map((runtime) => ({
      id: runtime.manifest.id, state: runtime.manifest.state, autoConvert: runtime.manifest.config?.autoConvert === true
    }));
  }

  return Object.freeze({
    start,
    get,
    list,
    liveJobs,
    pause: (...args) => serializeCommand(() => pause(...args)),
    setConcurrency: (...args) => serializeCommand(() => setConcurrency(...args)),
    setLanes: (...args) => serializeCommand(() => setLanes(...args)),
    resume: (...args) => serializeCommand(() => resume(...args)),
    cancel: (...args) => serializeCommand(() => cancel(...args)),
    discard: (...args) => serializeCommand(() => discard(...args)),
    retryFailed: (...args) => serializeCommand(() => retryFailed(...args)),
    dismissSummary,
    recover,
    continueRecovery,
    shutdown: (...args) => serializeCommand(() => shutdown(...args)),
    subscribe,
    whenIdle,
    activeEncodes,
    slotsOf
  });
}

module.exports = {
  ConverterJobServiceError,
  createConverterJobService,
  publicSnapshot
};
