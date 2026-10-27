'use strict';

const deepFreeze = (value) => {
  Object.freeze(value);
  Object.values(value).forEach((item) => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) deepFreeze(item);
  });
  return value;
};

const PROFILES = deepFreeze({
  conservative: { savings: 0.05, tolerance: 0.02 },
  balanced: { savings: 0.20, tolerance: 0.02 },
  aggressive: { savings: 0.50, tolerance: 0.02 }
});

const CODECS = deepFreeze({ H264: 'h264', H265: 'h265' });
const NETWORK_MODES = deepFreeze({ LOCAL: 'local', NETWORK: 'network' });
const OUTPUT_MODES = deepFreeze({ COPY: 'copy', CONVERT: 'convert' });
const ITEM_STATES = deepFreeze({ queued: 'queued', processing: 'processing', completed: 'completed', failed: 'failed', cancelled: 'cancelled' });
const TERMINAL_STATES = new Set([ITEM_STATES.completed, ITEM_STATES.failed, ITEM_STATES.cancelled]);
const GROUPS = ['RecentClips', 'SavedClips', 'SentryClips'];
// How many items a job may convert at the same time. A job without the field runs
// exactly like the original single-worker pipeline (`fallback`); the UI offers
// `recommended` by default.
const CONCURRENCY = deepFreeze({ min: 1, max: 64, fallback: 1, recommended: 5 });

// Where a converted file's wall-clock time goes. Names avoid substrings the
// IPC snapshot sanitizer treats as private (e.g. "telemetry", "process").
// (checkWait and picture: a node's clips only, waiting for and running the picture check)
const TIMING_PHASES = Object.freeze(['inspect', 'source', 'timeline', 'encode', 'metadata', 'checkWait', 'picture', 'verify', 'saveWait', 'save', 'cleanup']);

// Adds one converted file's phase durations (ms) to a job's running totals.
function addItemTimings(previous, phases) {
  const totalMs = {};
  for (const phase of TIMING_PHASES) {
    const added = Math.max(0, Math.round(Number(phases?.[phase]) || 0));
    totalMs[phase] = (Number.isSafeInteger(previous?.totalMs?.[phase]) ? previous.totalMs[phase] : 0) + added;
  }
  return { files: (Number.isSafeInteger(previous?.files) ? previous.files : 0) + 1, totalMs };
}

// A custom profile encodes at a user-chosen bitrate instead of aiming for a
// size reduction; only "output must be smaller than the source" is enforced.
const CUSTOM_PROFILE_ID = 'custom';
const CUSTOM_BITRATE_KBPS = deepFreeze({ min: 250, max: 100_000 });

function isValidCustomBitrate(value) {
  return Number.isSafeInteger(value) && value >= CUSTOM_BITRATE_KBPS.min && value <= CUSTOM_BITRATE_KBPS.max;
}

// Constant-quality mode (opt-in): the encoder holds a quality level instead of
// a size target, so still scenes shrink far more and busy ones keep detail.
// Only "output must be smaller than the source" is enforced, as for custom.
const QUALITY_PROFILE_ID = 'quality';
const QUALITY_LEVELS = deepFreeze(['high', 'balanced', 'small']);

function isValidQualityLevel(value) {
  return QUALITY_LEVELS.includes(value);
}

// Post-conversion verification depth:
//   full  - quick checks plus a complete decode of every output frame;
//   quick - stream/duration/frame/dimension checks against the source, the
//           per-frame telemetry comparison and size rules (no full decode);
//   off   - only the integrity hash, "smaller than the original" and the size
//           profile's upper limit (so a profile still compresses as promised).
// Replacing originals always uses at least quick. Jobs saved before this
// setting existed keep running full.
const VERIFY_MODES = deepFreeze(['off', 'quick', 'full']);
const DEFAULT_VERIFY_MODE = 'quick';

function isValidVerifyMode(value) {
  return VERIFY_MODES.includes(value);
}

function effectiveVerifyMode(config = {}) {
  const mode = isValidVerifyMode(config.verifyMode) ? config.verifyMode : 'full';
  return config.outputMode === 'replace' && mode === 'off' ? 'quick' : mode;
}

// Profiles without a byte target (the verifier only requires real savings).
function hasSizeTarget(profileId) {
  return profileId !== CUSTOM_PROFILE_ID && profileId !== QUALITY_PROFILE_ID;
}

function isValidConcurrency(value) {
  return Number.isSafeInteger(value) && value >= CONCURRENCY.min && value <= CONCURRENCY.max;
}

// Conversions at once per encoding device (several GPUs, set by hand per GPU):
// `lanes` = [{ device, concurrency }]. A device is named by its PCI slot,
// which stays the same when the kernel numbers the render nodes differently,
// 'cpu' for the software encoder, or 'node:<id>@<its GPU or cpu>' for one
// GPU (or the CPU) of another server paired under Nodes (its encodes run
// there). 'node:<id>' alone is a node that lists no devices (an older
// version), and the lane saved before nodes listed theirs: it stands for the
// node's default device (its first GPU, else its CPU). A job without lanes
// runs as before.
const LOCAL_DEVICE_ID = /^(pci:[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]|cpu)$/;
const DEVICE_ID = /^(pci:[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]|cpu|node:[a-z0-9]{12}(@(pci:[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]|cpu))?)$/;
const NODE_LANE = /^(node:[a-z0-9]{12})(?:@(.+))?$/;
// 'node:<id>' for any lane on a node (its own key: trust, Vehicles first,
// Off per vehicle, uploads and checks are per node), else null
function nodeKeyOf(id) {
  const match = typeof id === 'string' ? NODE_LANE.exec(id) : null;
  return match ? match[1] : null;
}
// the node's own device id ('pci:...' or 'cpu') of a lane, null for the whole node
function nodeDeviceOf(id) {
  const match = typeof id === 'string' ? NODE_LANE.exec(id) : null;
  return match && match[2] && LOCAL_DEVICE_ID.test(match[2]) ? match[2] : null;
}
const LANES = deepFreeze({ maxEntries: 16 });

function lanesError() {
  return Object.assign(new Error('INVALID_LANES'), { code: 'INVALID_LANES' });
}

// null when there are no lanes; otherwise the lanes without the devices set
// to 0. Throws INVALID_LANES on anything else.
function normalizeLanes(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > LANES.maxEntries) throw lanesError();
  const seen = new Set();
  const lanes = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw lanesError();
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes('device') || !keys.includes('concurrency')) throw lanesError();
    const { device, concurrency } = entry;
    if (typeof device !== 'string' || !DEVICE_ID.test(device) || seen.has(device)) throw lanesError();
    if (!Number.isSafeInteger(concurrency) || concurrency < 0 || concurrency > CONCURRENCY.max) throw lanesError();
    seen.add(device);
    if (concurrency > 0) lanes.push({ device, concurrency });
  }
  const total = lanesTotal(lanes);
  if (lanes.length === 0 || total < CONCURRENCY.min || total > CONCURRENCY.max) throw lanesError();
  return lanes;
}

function lanesTotal(lanes) {
  return Array.isArray(lanes) ? lanes.reduce((sum, lane) => sum + (Number(lane?.concurrency) || 0), 0) : 0;
}

function profile(name) {
  if (!PROFILES[name]) throw new RangeError(`Unknown conversion profile: ${name}`);
  return PROFILES[name];
}

function targetOutputBytes(sourceBytes, profileName) {
  return Math.round(sourceBytes * (1 - profile(profileName).savings));
}

function isWithinProfile(sourceBytes, outputBytes, profileName) {
  const selected = profile(profileName);
  const target = targetOutputBytes(sourceBytes, profileName);
  const tolerance = sourceBytes * selected.tolerance;
  // Extra savings are welcome; the verifier still checks integrity and media.
  return outputBytes <= target + tolerance;
}

function emptyGroup() {
  return { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 };
}

function createEmptyCounters() {
  return {
    files: 0,
    sourceVideoBytes: 0,
    outputVideoBytes: 0,
    savedBytes: 0,
    copiedAssetBytes: 0,
    groups: Object.fromEntries(GROUPS.map((group) => [group, emptyGroup()]))
  };
}

function addCompletedFile(counters, file) {
  if (!file || file.state !== ITEM_STATES.completed) return counters;
  const sourceBytes = Number(file.sourceBytes) || 0;
  const outputBytes = Number(file.outputBytes) || 0;
  const isAsset = file.kind === 'asset' || file.eligibleVideo === false;
  if (!isAsset && file.kind !== 'video') return counters;
  const next = { ...counters, groups: { ...counters.groups } };
  if (isAsset) {
    next.copiedAssetBytes += outputBytes;
    return next;
  }
  const savedBytes = sourceBytes - outputBytes;
  next.files += 1;
  next.sourceVideoBytes += sourceBytes;
  next.outputVideoBytes += outputBytes;
  next.savedBytes += savedBytes;
  if (GROUPS.includes(file.group)) {
    const current = counters.groups[file.group] || emptyGroup();
    next.groups[file.group] = {
      files: current.files + 1,
      sourceBytes: current.sourceBytes + sourceBytes,
      outputBytes: current.outputBytes + outputBytes,
      savedBytes: current.savedBytes + savedBytes
    };
  }
  return next;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError('bytes must be a non-negative finite number');
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const rendered = unit === 0 ? String(Math.round(value)) : value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return `${rendered} ${units[unit]}`;
}

function isTerminalState(state) { return TERMINAL_STATES.has(state); }

function serializeSummary(counters) {
  return {
    files: counters.files,
    sourceVideoBytes: counters.sourceVideoBytes,
    outputVideoBytes: counters.outputVideoBytes,
    savedBytes: counters.savedBytes,
    copiedAssetBytes: counters.copiedAssetBytes,
    source: formatBytes(counters.sourceVideoBytes),
    output: formatBytes(counters.outputVideoBytes),
    saved: formatBytes(counters.savedBytes),
    copiedAssets: formatBytes(counters.copiedAssetBytes),
    groups: JSON.parse(JSON.stringify(counters.groups))
  };
}

module.exports = { PROFILES, CODECS, NETWORK_MODES, OUTPUT_MODES, ITEM_STATES, CONCURRENCY, TIMING_PHASES, addItemTimings, isValidConcurrency, DEVICE_ID, LOCAL_DEVICE_ID, nodeKeyOf, nodeDeviceOf, LANES, normalizeLanes, lanesTotal, CUSTOM_PROFILE_ID, CUSTOM_BITRATE_KBPS, isValidCustomBitrate, QUALITY_PROFILE_ID, QUALITY_LEVELS, isValidQualityLevel, hasSizeTarget, VERIFY_MODES, DEFAULT_VERIFY_MODE, isValidVerifyMode, effectiveVerifyMode, createEmptyCounters, targetOutputBytes, isWithinProfile, addCompletedFile, formatBytes, isTerminalState, serializeSummary };
