'use strict';

// Automatic conversion: on a schedule, look for clips in the source folder
// that no earlier automatic run has handled and convert just those, with the
// settings saved when it was turned on. An optional time window pauses an
// automatic job outside the chosen hours and resumes it inside them.
//
// "Handled" clips are remembered in a small index per source/output setup
// (relative path -> size and modification time), so each check only stats
// files instead of re-inspecting the whole archive. In separate-output mode a
// clip whose converted copy already exists in the destination is also known.

const crypto = require('crypto');
const nodePath = require('path');
const { normalizeLanes, lanesTotal } = require('./contracts');

const INTERVAL_MINUTES = Object.freeze([15, 30, 60, 180, 360, 720, 1440]);
const SETTINGS_FILE = 'settings.json';
// Which job this feature paused for the time window (survives restarts, so a
// job the user paused themselves is never resumed automatically).
const STATE_FILE = 'state.json';
const MAX_FAILED_SWEEPS = 3;
// Clips the automatic job gave up on (failed MAX_FAILED_SWEEPS times, or kept
// as the original because the encode was not smaller) are remembered with this
// number. Raise it whenever encoding or verification changes in a way that
// could let such clips convert now: each one is then tried once more.
// 2: Tesla mid-GOP lead-in frames are kept (leadIn.js).
const CONVERTER_REVISION = 2;
const INDEX_VERSION = 2;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  intervalMinutes: 60,
  // null (any time), { startHour, endHour }, or { follow: 'off-peak' }: the
  // cheapest rate of the electricity plan in Settings
  window: null,
  // outside the window, also pause conversions the owner started
  holdManual: false,
  keepRunning: false,
  openAtLogin: false,
  config: null
});

function autoError(code) {
  return Object.assign(new Error(code), { code });
}

function isHour(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 23;
}

// Saved job settings with conversions at once per GPU: the total is the
// concurrency; lanes that are not valid are left out (plain concurrency).
function withValidLanes(config) {
  if (!config || config.lanes === undefined) return config;
  let lanes = null;
  try { lanes = normalizeLanes(config.lanes); } catch (_) { lanes = null; }
  const result = { ...config };
  if (lanes) {
    result.lanes = lanes;
    result.concurrency = lanesTotal(lanes);
  } else delete result.lanes;
  return result;
}

function normalizeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw autoError('INVALID_AUTO_SETTINGS');
  const settings = {
    enabled: value.enabled === true,
    intervalMinutes: INTERVAL_MINUTES.includes(value.intervalMinutes) ? value.intervalMinutes : DEFAULT_SETTINGS.intervalMinutes,
    window: null,
    holdManual: value.holdManual === true,
    keepRunning: value.keepRunning === true,
    openAtLogin: value.openAtLogin === true,
    config: value.config && typeof value.config === 'object' && !Array.isArray(value.config) ? withValidLanes({ ...value.config }) : null
  };
  if (value.window?.follow === 'off-peak') {
    settings.window = { follow: 'off-peak' };
  } else if (value.window !== null && value.window !== undefined) {
    if (!isHour(value.window.startHour) || !isHour(value.window.endHour)
        || value.window.startHour === value.window.endHour) throw autoError('INVALID_AUTO_WINDOW');
    settings.window = { startHour: value.window.startHour, endHour: value.window.endHour };
  }
  if (settings.enabled && !settings.config) throw autoError('AUTO_CONFIG_REQUIRED');
  return settings;
}

// Inside [start, end) with wrap-around past midnight (e.g. 22 -> 6).
function inWindow(window, hour) {
  if (!window) return true;
  return window.startHour < window.endHour
    ? hour >= window.startHour && hour < window.endHour
    : hour >= window.startHour || hour < window.endHour;
}

function setupKey(config) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([config.sourceRoot, config.destinationRoot, config.codec, config.outputMode]))
    .digest('hex').slice(0, 24);
}

function createAutoConverter(options = {}) {
  const { service, scanner, fs, directory } = options;
  const pathApi = options.pathApi || nodePath;
  const now = options.now || Date.now;
  const hourOf = options.hourOf || ((ms) => new Date(ms).getHours());
  const isBusy = options.isBusy || (async () => false);
  const tickMs = options.tickMs || 30_000;
  const timers = options.timers || { setInterval, clearInterval };
  const onChange = options.onChange || (() => {});
  // true while the cheapest electricity rate is in force, false otherwise,
  // null without a time-of-use plan (then any time is off-peak)
  const isCheapNow = options.isCheapNow || (() => null);
  if (!service || typeof scanner !== 'function' || !fs || typeof directory !== 'string') {
    throw new TypeError('service, scanner, fs and directory are required');
  }

  let settings = { ...DEFAULT_SETTINGS };
  const status = {
    lastCheckAt: null, nextCheckAt: null, lastNewFiles: null, lastJobId: null,
    activeJobId: null, pausedForWindow: false, checking: false, error: null,
    // manual jobs this paused outside the window, and every manual job it
    // has handled since the window closed (one the owner resumes stays running)
    heldManual: [], handledManual: []
  };
  const indexes = new Map(); // setup key -> { files: Map, gaveUp: Map, failures: Map, dirty }
  let timer = null;
  let ticking = null;
  let sweepAbort = null;

  async function writeJson(name, value) {
    await fs.mkdir(directory, { recursive: true });
    const target = pathApi.join(directory, name);
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value));
    await fs.rename(temporary, target);
  }

  async function readJson(name) {
    try { return JSON.parse(await fs.readFile(pathApi.join(directory, name), 'utf8')); } catch (_) { return null; }
  }

  async function loadIndex(config) {
    const key = setupKey(config);
    if (!indexes.has(key)) {
      let stored = await readJson(`index-${key}.json`);
      // A version 1 index mixed clips that converted with clips it gave up
      // on, so the given-up ones could never be tried again. It starts over:
      // converted clips are still skipped at once (the converted index), and
      // every other clip is tried again with the current converter.
      const fresh = Boolean(stored) && stored.v !== INDEX_VERSION;
      if (fresh) stored = null;
      const files = new Map();
      const gaveUp = new Map();
      if (stored && stored.files && typeof stored.files === 'object') {
        for (const [relativePath, entry] of Object.entries(stored.files)) {
          if (Array.isArray(entry) && entry.length === 2) files.set(relativePath, entry);
        }
      }
      if (stored && stored.gaveUp && typeof stored.gaveUp === 'object') {
        for (const [relativePath, entry] of Object.entries(stored.gaveUp)) {
          if (Array.isArray(entry) && entry.length === 3) gaveUp.set(relativePath, entry);
        }
      }
      const failures = new Map(Object.entries(stored?.failures || {}).filter(([, count]) => Number.isSafeInteger(count)));
      indexes.set(key, { key, files, gaveUp, failures, dirty: fresh });
    }
    return indexes.get(key);
  }

  async function saveIndex(index) {
    if (!index.dirty) return;
    await writeJson(`index-${index.key}.json`, {
      v: INDEX_VERSION, files: Object.fromEntries(index.files), gaveUp: Object.fromEntries(index.gaveUp), failures: Object.fromEntries(index.failures)
    });
    index.dirty = false;
  }

  function remember(index, relativePath, size, mtimeMs) {
    index.files.set(relativePath, [size, mtimeMs]);
    index.gaveUp.delete(relativePath);
    index.failures.delete(relativePath);
    index.dirty = true;
  }

  // Not converted, and not tried again until the converter changes.
  function giveUp(index, relativePath, size, mtimeMs) {
    index.gaveUp.set(relativePath, [size, mtimeMs, CONVERTER_REVISION]);
    index.files.delete(relativePath);
    index.failures.delete(relativePath);
    index.dirty = true;
  }

  function knownIn(index, discovered) {
    const entry = index.files.get(discovered.relativePath);
    if (entry) return entry[0] === discovered.sourceBytes && entry[1] === discovered.mtimeMs;
    const given = index.gaveUp.get(discovered.relativePath);
    return Boolean(given) && given[0] === discovered.sourceBytes && given[1] === discovered.mtimeMs && given[2] === CONVERTER_REVISION;
  }

  // Used by the job service while an automatic job discovers files.
  function isKnown(config, discovered) {
    if (config?.autoConvert !== true) return false;
    const index = indexes.get(setupKey(config));
    return Boolean(index) && knownIn(index, discovered);
  }

  async function destinationExists(config, discovered) {
    if (config.outputMode !== 'separate' || !config.destinationRoot) return false;
    try {
      const target = pathApi.resolve(config.destinationRoot, ...discovered.relativePath.split('/'));
      const stat = await fs.stat(target);
      return stat.isFile() && stat.size > 0;
    } catch (_) {
      return false;
    }
  }

  async function sweep(config) {
    const index = await loadIndex(config);
    const controller = new AbortController();
    sweepAbort = controller;
    let newFiles = 0;
    try {
      for await (const discovered of scanner(config, { signal: controller.signal })) {
        if (knownIn(index, discovered)) continue;
        if (await destinationExists(config, discovered)) {
          remember(index, discovered.relativePath, discovered.sourceBytes, discovered.mtimeMs);
          continue;
        }
        newFiles += 1;
      }
    } finally {
      if (sweepAbort === controller) sweepAbort = null;
    }
    await saveIndex(index);
    return newFiles;
  }

  async function recordFinishedJob(job) {
    const index = await loadIndex(job.config);
    for (const item of job.items || []) {
      if (item.state === 'skipped' && item.resultCode === 'no-savings') {
        // kept as the original (the encode was not smaller): a later converter may do better
        giveUp(index, item.relativePath, item.sourceBytes, item.mtimeMs);
      } else if (item.state === 'completed' || item.state === 'skipped') {
        if (job.config.outputMode === 'replace' && item.state === 'completed') {
          // The original was replaced: remember the converted file now there.
          try {
            const stat = await fs.stat(item.sourcePath);
            remember(index, item.relativePath, Number(stat.size), Number(stat.mtimeMs));
          } catch (_) { /* re-examined next time */ }
        } else {
          remember(index, item.relativePath, item.sourceBytes, item.mtimeMs);
        }
      } else if (item.state === 'failed') {
        const count = (index.failures.get(item.relativePath) || 0) + 1;
        // Stop retrying a clip that keeps failing; it stays listed as failed.
        if (count >= MAX_FAILED_SWEEPS) giveUp(index, item.relativePath, item.sourceBytes, item.mtimeMs);
        else { index.failures.set(item.relativePath, count); index.dirty = true; }
      }
    }
    await saveIndex(index);
  }

  async function setPausedForWindow(jobId) {
    status.pausedForWindow = Boolean(jobId);
    await saveState(jobId);
  }

  function changed() {
    try { onChange(getState()); } catch (_) { /* observers are advisory */ }
  }

  async function followActiveJob(insideWindow) {
    let job;
    try { job = await service.get(status.activeJobId); } catch (_) { job = null; }
    if (!job) {
      status.activeJobId = null;
      if (status.pausedForWindow) await setPausedForWindow(null);
      return;
    }
    if (TERMINAL.has(job.state)) {
      await recordFinishedJob(job);
      status.activeJobId = null;
      if (status.pausedForWindow) await setPausedForWindow(null);
      changed();
      return;
    }
    // Turned off: no more automatic pausing or resuming; the job stays as it
    // is for the user to resume or cancel (finished clips are still recorded).
    if (!settings.enabled) return;
    if (!insideWindow && !status.pausedForWindow && job.state !== 'paused') {
      await service.pause(job.id);
      await setPausedForWindow(job.id);
      changed();
    } else if (insideWindow && status.pausedForWindow) {
      // A pause takes effect once every worker has finished its clip. Resume
      // whether or not it already has: a pause still settling when the
      // window opened again was never undone, and it held the job for good.
      try { await service.resume(job.id); } catch (error) {
        if (error?.code !== 'JOB_NOT_PAUSED') throw error;
      }
      await setPausedForWindow(null);
      changed();
    }
  }

  async function saveState(pausedJobId = status.pausedForWindow ? status.activeJobId : null) {
    try {
      await writeJson(STATE_FILE, { pausedForWindowJobId: pausedJobId || null, heldManual: status.heldManual, handledManual: status.handledManual });
    } catch (_) { /* best effort */ }
  }

  function insideWindowAt(time) {
    if (settings.window?.follow === 'off-peak') {
      let cheap = null;
      try { cheap = isCheapNow(time); } catch (_) { cheap = null; }
      return cheap !== false;
    }
    return inWindow(settings.window, hourOf(time));
  }

  // "Also pause conversions I start myself": outside the window a running
  // manual job is paused (once; if the owner resumes it, it is left alone),
  // and when the window opens the ones paused here are resumed.
  async function holdManualJobs(insideWindow) {
    const active = Boolean(settings.window) && settings.holdManual;
    if (insideWindow || !active) {
      if (!status.heldManual.length && !status.handledManual.length) return;
      for (const id of status.heldManual) {
        try { await service.resume(id); } catch (_) { /* finished, cancelled or already running */ }
      }
      status.heldManual = [];
      status.handledManual = [];
      await saveState();
      changed();
      return;
    }
    let jobs;
    try { jobs = typeof service.liveJobs === 'function' ? service.liveJobs() : await service.list(); } catch (_) { return; }
    let changedHold = false;
    // one this paused that runs again was resumed by the owner: it is no
    // longer held, so a pause the owner makes later is never undone
    const running = new Set(jobs.filter((job) => job.state !== 'paused' && !TERMINAL.has(job.state)).map((job) => job.id));
    const stillHeld = status.heldManual.filter((id) => !running.has(id));
    if (stillHeld.length !== status.heldManual.length) {
      status.heldManual = stillHeld;
      changedHold = true;
    }
    for (const job of jobs) {
      const automatic = job.autoConvert === true || job.config?.autoConvert === true;
      if (automatic || TERMINAL.has(job.state) || job.state === 'paused' || job.state === 'paused_network') continue;
      if (status.handledManual.includes(job.id)) continue;
      try {
        await service.pause(job.id);
        status.heldManual.push(job.id);
        status.handledManual.push(job.id);
        changedHold = true;
      } catch (_) { /* it ended meanwhile */ }
    }
    if (changedHold) {
      await saveState();
      changed();
    }
  }

  async function tickOnce() {
    const time = now();
    const insideWindow = insideWindowAt(time);
    await holdManualJobs(insideWindow);
    if (status.activeJobId) {
      await followActiveJob(insideWindow);
      if (status.activeJobId) return;
    }
    if (!settings.enabled || !settings.config || !insideWindow) return;
    if (status.nextCheckAt !== null && time < status.nextCheckAt) return;
    if (await isBusy()) return;
    status.checking = true;
    status.error = null;
    changed();
    try {
      const newFiles = await sweep(settings.config);
      status.lastCheckAt = now();
      status.lastNewFiles = newFiles;
      if (newFiles > 0 && settings.enabled) {
        const jobId = await service.start({ ...settings.config, autoConvert: true });
        status.activeJobId = jobId;
        status.lastJobId = jobId;
      }
    } catch (error) {
      if (error?.code === 'JOB_ACTIVE') {
        // Another conversion started while this check ran: not a failure;
        // check again as soon as it is finished.
        status.checking = false;
        status.nextCheckAt = null;
        changed();
        return;
      }
      status.error = typeof error?.code === 'string' ? error.code : 'AUTO_CHECK_FAILED';
      status.lastCheckAt = now();
    } finally {
      if (status.checking) {
        status.checking = false;
        status.nextCheckAt = status.lastCheckAt + settings.intervalMinutes * 60_000;
        changed();
      }
    }
  }

  function tick() {
    if (!ticking) {
      ticking = tickOnce().catch((error) => {
        status.error = typeof error?.code === 'string' ? error.code : 'AUTO_CHECK_FAILED';
      }).finally(() => { ticking = null; });
    }
    return ticking;
  }

  function getState() {
    return { settings: JSON.parse(JSON.stringify(settings)), status: { ...status } };
  }

  return Object.freeze({
    isKnown,
    getState,
    tick,
    async start() {
      const stored = await readJson(SETTINGS_FILE);
      try { if (stored) settings = normalizeSettings(stored); } catch (_) { settings = { ...DEFAULT_SETTINGS }; }
      if (settings.config) await loadIndex(settings.config);
      // Adopt an automatic job that was still running when the app closed.
      try {
        const jobs = await service.list();
        const running = jobs.find((job) => job.config?.autoConvert === true && !TERMINAL.has(job.state));
        if (running) {
          await loadIndex(running.config);
          status.activeJobId = running.id;
          // Only a pause this feature made is undone automatically.
          const saved = await readJson(STATE_FILE);
          status.pausedForWindow = running.state === 'paused' && saved?.pausedForWindowJobId === running.id;
        }
      } catch (_) { /* nothing to adopt */ }
      // manual jobs paused for the window before a restart
      try {
        const saved = await readJson(STATE_FILE);
        const ids = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === 'string').slice(0, 64) : []);
        // (kept together with any already noted in this run)
        status.heldManual = [...new Set([...status.heldManual, ...ids(saved?.heldManual)])];
        status.handledManual = [...new Set([...status.handledManual, ...ids(saved?.handledManual)])];
      } catch (_) { /* none */ }
      if (!timer) {
        timer = timers.setInterval(() => { void tick(); }, tickMs);
        timer?.unref?.(); // never keeps the app (or a test) alive on its own
      }
      void tick();
      return getState();
    },
    async configure(next) {
      const normalized = normalizeSettings(next);
      if (normalized.config) await loadIndex(normalized.config);
      const configChanged = JSON.stringify(normalized.config) !== JSON.stringify(settings.config);
      settings = normalized;
      await writeJson(SETTINGS_FILE, settings);
      if (configChanged || !settings.enabled) status.nextCheckAt = null; // check soon with new settings
      changed();
      void tick();
      return getState();
    },
    // The owner resumed a job by hand: if this had paused it outside the
    // window, it no longer counts as held here, so the window opening later
    // never undoes a pause the owner makes afterwards.
    async ownerResumed(jobId) {
      if (!status.heldManual.includes(jobId)) return;
      status.heldManual = status.heldManual.filter((id) => id !== jobId);
      await saveState();
      changed();
    },
    // Parallel conversions changed on the running automatic job: later
    // automatic jobs use the same number.
    async setConcurrency(value) {
      if (!settings.config || (settings.config.concurrency === value && !settings.config.lanes)) return getState();
      // the running job has one number for all; the saved setting follows it
      const { lanes: _lanes, ...config } = settings.config;
      settings = { ...settings, config: { ...config, concurrency: value } };
      await writeJson(SETTINGS_FILE, settings);
      changed();
      return getState();
    },
    // Conversions at once per GPU changed on the running automatic job.
    async setLanes(value) {
      const lanes = normalizeLanes(value);
      if (!settings.config || !lanes) return getState();
      if (JSON.stringify(settings.config.lanes || null) === JSON.stringify(lanes)) return getState();
      settings = { ...settings, config: { ...settings.config, lanes, concurrency: lanesTotal(lanes) } };
      await writeJson(SETTINGS_FILE, settings);
      changed();
      return getState();
    },
    async checkNow() {
      status.nextCheckAt = null;
      await tick();
      return getState();
    },
    stop() {
      if (timer) timers.clearInterval(timer);
      timer = null;
      sweepAbort?.abort();
    }
  });
}

module.exports = { createAutoConverter, INTERVAL_MINUTES, inWindow, CONVERTER_REVISION };
