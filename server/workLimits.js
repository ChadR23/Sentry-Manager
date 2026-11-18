'use strict';

// How much background work runs at once, picked from the memory and CPUs this
// container really has (its cgroup limits, not the host's totals), so a 1 GB
// Raspberry Pi or a NAS with a 2 GB container limit is not asked to do what a
// big PC does. A normal PC (7 GB or more and 4 CPUs or more) gets the same
// numbers as before.
//
//   speedIndex      clips the speed index reads at once, at most (backgroundPace.js
//                   starts at one and adds one while the server keeps up)
//   codecChecks     clips whose codec is read at once after a scan (inventory.js)
//   scrubPreviews   Viewer scrub previews made at once (scrubFrames.js)
//   telemetryReads  clips whose car data (every frame) is read at once (telemetry.js;
//                   each keeps a worker thread busy)
//   thumbnails      recording card thumbnails made at once (thumbnails.js)
//
// An admin can set any of them by hand (Settings → Advanced → Background
// work); a number left empty is picked automatically. Saved under the
// `work-limits` setting as { speedIndex: 3, ... } (only the ones set).

const fsDefault = require('fs');
const osDefault = require('os');

const GB = 1024 ** 3;
const KEYS = ['speedIndex', 'codecChecks', 'scrubPreviews', 'telemetryReads', 'thumbnails'];
// the most an admin may set each to
const MAX = { speedIndex: 8, codecChecks: 32, scrubPreviews: 8, telemetryReads: 8, thumbnails: 8 };

// the three sizes of server; big is what every server got before
const TIERS = {
  small: { speedIndex: 1, codecChecks: 2, scrubPreviews: 1, telemetryReads: 1, thumbnails: 1 },
  medium: { speedIndex: 2, codecChecks: 4, scrubPreviews: 2, telemetryReads: 1, thumbnails: 2 },
  big: { speedIndex: 4, codecChecks: 8, scrubPreviews: 3, telemetryReads: 2, thumbnails: 2 },
};
const ORDER = ['small', 'medium', 'big'];
// an "8 GB" machine reports a little less (the kernel and firmware keep some),
// hence 7; a "4 GB" one reports about 3.7, a "2 GB" one about 1.8
const BIG_MEMORY = 7 * GB;
const SMALL_MEMORY = 3 * GB;

function reader(fs) {
  return (p) => {
    try { return String(fs.readFileSync(p, 'utf8')).trim(); } catch { return ''; }
  };
}

// cgroup v1 writes a huge number (about 2^63) for "no limit"
const realLimit = (n) => (Number.isFinite(n) && n > 0 && n < 2 ** 60 ? n : null);

/** The cgroup v2 folder of this process (/proc/self/cgroup "0::/path"), or the root. */
function v2Dirs(read) {
  const m = /^0::(\/\S*)$/m.exec(read('/proc/self/cgroup'));
  const own = m && m[1] !== '/' ? `/sys/fs/cgroup${m[1]}` : null;
  return own ? [own, '/sys/fs/cgroup'] : ['/sys/fs/cgroup'];
}

/** The container's memory limit in bytes, or null when it has none. */
function cgroupMemory(read) {
  const found = [];
  for (const dir of v2Dirs(read)) {
    const v = read(`${dir}/memory.max`);
    if (v) found.push(v === 'max' ? null : realLimit(Number(v)));
  }
  found.push(realLimit(Number(read('/sys/fs/cgroup/memory/memory.limit_in_bytes') || NaN)));
  const set = found.filter((n) => n !== null);
  return set.length ? Math.min(...set) : null;
}

/** The container's CPU limit (2.5 is two and a half CPUs), or null when it has none. */
function cgroupCpus(read) {
  const found = [];
  for (const dir of v2Dirs(read)) {
    const [quota, period] = read(`${dir}/cpu.max`).split(/\s+/);
    if (quota && quota !== 'max' && Number(quota) > 0 && Number(period) > 0) found.push(Number(quota) / Number(period));
  }
  for (const dir of ['/sys/fs/cgroup/cpu', '/sys/fs/cgroup/cpu,cpuacct']) {
    const quota = Number(read(`${dir}/cpu.cfs_quota_us`) || NaN);
    const period = Number(read(`${dir}/cpu.cfs_period_us`) || NaN);
    if (quota > 0 && period > 0) found.push(quota / period);
  }
  return found.length ? Math.min(...found) : null;
}

/**
 * What this container has: { memoryBytes, memoryFrom, cpus, cpusFrom }, where
 * the *From fields say 'container' (a cgroup limit) or 'host'.
 */
function detectResources({ fs = fsDefault, os = osDefault } = {}) {
  const read = reader(fs);
  let hostMemory = 0;
  try { hostMemory = Number(os.totalmem()) || 0; } catch { /* unknown */ }
  let hostCpus = 1;
  try { hostCpus = Number(os.availableParallelism?.() ?? os.cpus().length) || 1; } catch { /* unknown */ }
  const memLimit = cgroupMemory(read);
  const cpuLimit = cgroupCpus(read);
  const memoryFrom = memLimit !== null && (!hostMemory || memLimit < hostMemory) ? 'container' : 'host';
  const cpusFrom = cpuLimit !== null && cpuLimit < hostCpus ? 'container' : 'host';
  return {
    memoryBytes: memoryFrom === 'container' ? memLimit : hostMemory,
    memoryFrom,
    cpus: cpusFrom === 'container' ? Math.round(cpuLimit * 10) / 10 : hostCpus,
    cpusFrom,
  };
}

/** The size of server ('small', 'medium' or 'big') for what it has. */
function tierFor({ memoryBytes, cpus }) {
  // memory not known: as before
  const mem = !memoryBytes ? 2 : memoryBytes >= BIG_MEMORY ? 2 : memoryBytes >= SMALL_MEMORY ? 1 : 0;
  const cpu = cpus >= 4 ? 2 : cpus >= 3 ? 1 : 0;
  return ORDER[Math.min(mem, cpu)];
}

/** Only the numbers an admin set that are whole numbers in range ({} for none). */
function cleanOverride(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of KEYS) {
    const n = raw[k];
    if (Number.isSafeInteger(n) && n >= 1 && n <= MAX[k]) out[k] = n;
  }
  return out;
}

/**
 * The limits in use: { limits, auto, override, tier, resources }. `override`
 * is the saved setting; `resources` defaults to this container's.
 */
function pickLimits({ resources = detectResources(), override = null } = {}) {
  const tier = tierFor(resources);
  const auto = { ...TIERS[tier] };
  const set = cleanOverride(override);
  return { limits: { ...auto, ...set }, auto, override: set, tier, resources, max: { ...MAX } };
}

/**
 * The setting an admin sent, checked: each key a whole number in range, or
 * null / '' for automatic. Throws a TypeError with a message for the admin.
 */
function parseOverride(body) {
  const out = {};
  for (const k of KEYS) {
    const v = body?.[k];
    if (v === undefined || v === null || v === '') continue;
    const n = typeof v === 'number' || (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX[k]) throw new TypeError(`${k} must be a whole number from 1 to ${MAX[k]}, or empty for automatic.`);
    out[k] = n;
  }
  return out;
}

module.exports = { pickLimits, detectResources, tierFor, parseOverride, cleanOverride, cgroupMemory, cgroupCpus, TIERS, KEYS, MAX };
