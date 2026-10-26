'use strict';

// Automatic conversion: on a schedule, look for clips in each automatic
// source folder (one per vehicle) that no earlier automatic run has handled
// and convert just those, with the settings saved for that folder when it was
// turned on. The folders are checked one after another and converted one job
// at a time; the schedule and the time window are shared. An optional time
// window pauses an automatic job outside the chosen hours and resumes it
// inside them.
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
// 3: a frame Tesla's encoder skipped no longer fails the clip (frameNumGaps.js).
// 4: a clip that is not smaller is encoded again under the original's bitrate.
const CONVERTER_REVISION = 4;
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
  // the job settings of each automatic source folder (one per vehicle)
  configs: []
});
const MAX_SOURCES = 64;

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
  // nodes set to Off in this vehicle's Encoder rows (see nodesOffFor)
  if (result.nodesOff !== undefined) {
    const off = Array.isArray(result.nodesOff) ? [...new Set(result.nodesOff.filter(isNodeDevice))].slice(0, 32) : [];
    if (off.length) result.nodesOff = off;
    else delete result.nodesOff;
  }
  if (lanes) {
    result.lanes = lanes;
    result.concurrency = lanesTotal(lanes);
  } else delete result.lanes;
  return result;
}

const isConfig = (config) => Boolean(config) && typeof config === 'object' && !Array.isArray(config) && typeof config.sourceRoot === 'string';

// One per source folder (the last one given wins). Settings saved before
// there was one per vehicle had a single `config`.
function normalizeConfigs(value) {
  const list = Array.isArray(value.configs) ? value.configs : value.enabled === true && isConfig(value.config) ? [value.config] : [];
  const bySource = new Map();
  for (const config of list) if (isConfig(config)) bySource.set(config.sourceRoot, withValidLanes({ ...config }));
  return [...bySource.values()].slice(0, MAX_SOURCES);
}

function normalizeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw autoError('INVALID_AUTO_SETTINGS');
  const configs = normalizeConfigs(value);
  const settings = {
    enabled: configs.length > 0,
    intervalMinutes: INTERVAL_MINUTES.includes(value.intervalMinutes) ? value.intervalMinutes : DEFAULT_SETTINGS.intervalMinutes,
    window: null,
    holdManual: value.holdManual === true,
    keepRunning: value.keepRunning === true,
    openAtLogin: value.openAtLogin === true,
    configs
  };
  if (value.window?.follow === 'off-peak') {
    settings.window = { follow: 'off-peak' };
  } else if (value.window !== null && value.window !== undefined) {
    if (!isHour(value.window.startHour) || !isHour(value.window.endHour)
        || value.window.startHour === value.window.endHour) throw autoError('INVALID_AUTO_WINDOW');
    settings.window = { startHour: value.window.startHour, endHour: value.window.endHour };
  }
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

const isNodeDevice = (id) => typeof id === 'string' && id.startsWith('node:');

/**
 * Which devices each vehicle's automatic job gets, as lanes. A node goes to
 * the first vehicle on its list (Nodes) that has a job or new clips; with
 * none of those, it helps the vehicle on this server's own devices (when
 * that vehicle's settings use the node), else any vehicle whose settings
 * use it. This server's own devices go to `localHolder` only.
 *   cars: the automatic settings, one per source folder
 *   wanting: source folders with a job or new clips
 *   devices: [{ id, kind, online, slots }] (this server's and the nodes)
 *   priorities: { 'node:<id>': [sourceRoot, ...] }
 * -> Map sourceRoot -> lanes (empty when it gets no device now)
 */
function planLanes({ cars, wanting, localHolder = null, devices = [], priorities = {} }) {
  const byRoot = new Map(cars.filter((config) => Array.isArray(config.lanes)).map((config) => [config.sourceRoot, config]));
  const plan = new Map([...byRoot.keys()].filter((root) => wanting.has(root)).map((root) => [root, []]));
  const laneOf = (root, id) => byRoot.get(root)?.lanes.find((lane) => lane.device === id) || null;
  const present = new Set(devices.filter((device) => device && device.online !== false).map((device) => device.id));
  if (localHolder && plan.has(localHolder)) {
    for (const lane of byRoot.get(localHolder).lanes) {
      if (!isNodeDevice(lane.device) && present.has(lane.device)) plan.get(localHolder).push({ device: lane.device, concurrency: lane.concurrency });
    }
  }
  for (const node of devices) {
    if (!node || !isNodeDevice(node.id) || !present.has(node.id)) continue;
    // (a vehicle whose Encoder row for this node is Off never gets it)
    const allows = (root) => !(byRoot.get(root)?.nodesOff || []).includes(node.id);
    const listed = (Array.isArray(priorities[node.id]) ? priorities[node.id] : []).find((root) => plan.has(root) && allows(root));
    const helps = listed
      || (localHolder && plan.has(localHolder) && laneOf(localHolder, node.id) ? localHolder : null)
      || [...plan.keys()].find((root) => laneOf(root, node.id) && allows(root));
    if (!helps) continue;
    const concurrency = laneOf(helps, node.id)?.concurrency || (Number.isSafeInteger(node.slots) && node.slots > 0 ? Math.min(node.slots, 8) : 1);
    plan.get(helps).push({ device: node.id, concurrency });
  }
  return plan;
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
    // the folder being checked, the folders still to check in this round,
    // each folder's last check, the folders with new clips waiting for a
    // device, and each running automatic job by folder:
    //   { jobId, lanes, pausedForWindow, pausedForDevices }
    // (activeJobId and activeSource name the first of them)
    activeSource: null, round: [], sources: {}, pending: {}, active: {},
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

  function changed() {
    // the first running job, for anything that shows one
    const [first] = Object.entries(status.active);
    status.activeJobId = first ? first[1].jobId : null;
    if (!status.checking) status.activeSource = first ? first[0] : null;
    status.pausedForWindow = Object.values(status.active).some((entry) => entry.pausedForWindow);
    try { onChange(getState()); } catch (_) { /* observers are advisory */ }
  }

  async function followActiveJobs(insideWindow) {
    for (const [sourceRoot, entry] of Object.entries(status.active)) {
      let job;
      try { job = await service.get(entry.jobId); } catch (_) { job = null; }
      if (!job || TERMINAL.has(job.state)) {
        if (job) await recordFinishedJob(job);
        delete status.active[sourceRoot];
        await saveState();
        changed();
        continue;
      }
      // Turned off: no more automatic pausing or resuming; the job stays as
      // it is for the user to resume or cancel (finished clips are still
      // recorded).
      if (!settings.enabled) continue;
      if (!insideWindow && !entry.pausedForWindow && job.state !== 'paused') {
        await service.pause(job.id);
        entry.pausedForWindow = true;
        await saveState();
        changed();
      } else if (insideWindow && entry.pausedForWindow) {
        entry.pausedForWindow = false;
        // A pause takes effect once every worker has finished its clip.
        // Resume whether or not it already has: a pause still settling when
        // the window opened again was never undone, and it held the job.
        if (!entry.pausedForDevices) await resumeJob(entry.jobId);
        await saveState();
        changed();
      }
    }
  }

  async function resumeJob(jobId) {
    try { await service.resume(jobId); } catch (error) {
      if (error?.code !== 'JOB_NOT_PAUSED') throw error;
    }
  }

  async function saveState() {
    try {
      const paused = Object.values(status.active).filter((entry) => entry.pausedForWindow).map((entry) => entry.jobId);
      const forDevices = Object.values(status.active).filter((entry) => entry.pausedForDevices).map((entry) => entry.jobId);
      await writeJson(STATE_FILE, { pausedForWindowJobIds: paused, pausedForDevicesJobIds: forDevices, heldManual: status.heldManual, handledManual: status.handledManual });
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

  const configFor = (sourceRoot) => settings.configs.find((config) => config.sourceRoot === sourceRoot) || null;
  // the folder whose automatic job is running (or the only one)
  const activeConfig = (sourceRoot = status.activeSource) => configFor(sourceRoot) || (settings.configs.length === 1 ? settings.configs[0] : null);
  const usesOwnDevices = (lanes) => Array.isArray(lanes) && lanes.some((lane) => !isNodeDevice(lane.device));
  const sameLanes = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

  // The nodes a vehicle's Encoder rows leave at Off: every node paired now
  // that its lanes do not use. A node paired later is not among them, so it
  // helps as its "Vehicles first" list says until the owner sets its row.
  // null when the devices could not be listed (a node slow to answer): the
  // vehicle then keeps the Off it had, instead of losing it
  async function nodesOffFor(lanes) {
    if (!Array.isArray(lanes)) return [];
    let devices;
    try { devices = await options.devices?.(); } catch (_) { return null; }
    if (!Array.isArray(devices) || devices.length === 0) return null;
    const used = new Set(lanes.map((lane) => lane.device));
    return devices.map((device) => device?.id).filter((id) => isNodeDevice(id) && !used.has(id));
  }

  function noteSource(sourceRoot, fields) {
    status.sources = { ...status.sources, [sourceRoot]: { ...(status.sources[sourceRoot] || {}), ...fields } };
  }

  // Each folder in the round once, one after another; a folder converting
  // now is left to its job.
  async function sweepRound() {
    status.checking = true;
    status.error = null;
    changed();
    try {
      while (status.round.length && settings.enabled) {
        const sourceRoot = status.round.shift();
        const config = configFor(sourceRoot);
        if (!config || status.active[sourceRoot]) continue;
        status.activeSource = sourceRoot;
        changed();
        let newFiles = null;
        let error = null;
        try {
          newFiles = await sweep(config);
        } catch (sweepError) {
          // (one vehicle's share being down never stops the others)
          error = typeof sweepError?.code === 'string' ? sweepError.code : 'AUTO_CHECK_FAILED';
        }
        status.lastCheckAt = now();
        status.lastNewFiles = newFiles;
        if (error) status.error = error;
        noteSource(sourceRoot, { lastCheckAt: status.lastCheckAt, lastNewFiles: newFiles, error });
        if (newFiles > 0) status.pending[sourceRoot] = newFiles;
        else delete status.pending[sourceRoot];
      }
    } finally {
      status.checking = false;
      changed();
    }
  }

  async function startJob(sourceRoot, config) {
    try {
      // (nodesOff is the vehicle's automatic setting, not the job's: a job
      // with it was refused as INVALID_MANIFEST, so the vehicle never started)
      const { nodesOff: _off, ...jobConfig } = config;
      const jobId = await service.start({ ...jobConfig, autoConvert: true });
      status.active[sourceRoot] = { jobId, lanes: config.lanes || null, pausedForWindow: false, pausedForDevices: false };
      status.lastJobId = jobId;
      delete status.pending[sourceRoot];
      changed();
      return true;
    } catch (startError) {
      // Another conversion started meanwhile: not a failure; this folder
      // keeps its new clips and starts once there is room.
      if (startError?.code === 'JOB_ACTIVE') return false;
      status.error = typeof startError?.code === 'string' ? startError.code : 'AUTO_CHECK_FAILED';
      noteSource(sourceRoot, { error: status.error });
      delete status.pending[sourceRoot];
      changed();
      return false;
    }
  }

  // Gives each folder with a job or new clips its devices: jobs that lose a
  // device are changed (or paused when none is left) before new jobs start.
  async function allocate() {
    const activeRoots = Object.keys(status.active);
    // a job saved without per-device lanes runs alone, as before
    if (activeRoots.some((root) => !Array.isArray(status.active[root].lanes))) return;
    const waiting = settings.configs.map((config) => config.sourceRoot).filter((root) => status.pending[root] > 0 && !status.active[root]);
    if (!activeRoots.length && !waiting.length) return;
    if (!activeRoots.length) {
      const first = configFor(waiting[0]);
      if (!Array.isArray(first.lanes)) { await startJob(first.sourceRoot, first); return; }
    }
    let devices = [];
    try { devices = (await options.devices?.()) || []; } catch (_) { devices = []; }
    let priorities = {};
    try { priorities = (await options.nodePriorities?.()) || {}; } catch (_) { priorities = {}; }
    // this server's own devices: the job using them, else the next folder
    // with new clips after the last one that had them
    let localHolder = activeRoots.find((root) => usesOwnDevices(status.active[root].lanes)) || null;
    if (!localHolder) {
      const order = settings.configs.map((config) => config.sourceRoot);
      const last = order.indexOf(status.lastLocal);
      const candidates = waiting.filter((root) => usesOwnDevices(configFor(root)?.lanes));
      localHolder = candidates.find((root) => order.indexOf(root) > last) || candidates[0] || null;
    }
    if (localHolder) status.lastLocal = localHolder;
    const plan = planLanes({ cars: settings.configs, wanting: new Set([...activeRoots, ...waiting]), localHolder, devices, priorities });
    for (const root of activeRoots) {
      const entry = status.active[root];
      const lanes = plan.get(root) || [];
      if (!lanes.length) {
        // its device went to the vehicle it belongs to: wait for another
        if (!entry.pausedForDevices) {
          try { await service.pause(entry.jobId); entry.pausedForDevices = true; } catch (_) { /* finished meanwhile */ }
          await saveState();
          changed();
        }
        continue;
      }
      if (!sameLanes(entry.lanes, lanes)) {
        try { await service.setLanes(entry.jobId, lanes); entry.lanes = lanes; } catch (_) { /* finished meanwhile */ }
        changed();
      }
      if (entry.pausedForDevices) {
        entry.pausedForDevices = false;
        if (!entry.pausedForWindow) await resumeJob(entry.jobId).catch(() => undefined);
        await saveState();
        changed();
      }
    }
    for (const root of waiting) {
      const lanes = plan.get(root);
      if (!lanes?.length || !settings.enabled) continue;
      await startJob(root, { ...configFor(root), lanes, concurrency: lanesTotal(lanes) });
    }
  }

  async function tickOnce() {
    const time = now();
    const insideWindow = insideWindowAt(time);
    await holdManualJobs(insideWindow);
    await followActiveJobs(insideWindow);
    if (!settings.enabled || !insideWindow) return;
    if (await isBusy()) return;
    const known = new Set(settings.configs.map((config) => config.sourceRoot));
    status.round = status.round.filter((sourceRoot) => known.has(sourceRoot));
    for (const root of Object.keys(status.pending)) if (!known.has(root)) delete status.pending[root];
    if (!status.round.length && (status.nextCheckAt === null || time >= status.nextCheckAt)) {
      status.round = [...known];
      status.nextCheckAt = time + settings.intervalMinutes * 60_000;
    }
    if (status.round.length) await sweepRound();
    // a round begun for a folder just turned on also sets the next check
    if (status.nextCheckAt === null) status.nextCheckAt = now() + settings.intervalMinutes * 60_000;
    await allocate();
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
    return { settings: JSON.parse(JSON.stringify(settings)), status: JSON.parse(JSON.stringify(status)) };
  }

  return Object.freeze({
    isKnown,
    getState,
    tick,
    async start() {
      const stored = await readJson(SETTINGS_FILE);
      try { if (stored) settings = normalizeSettings(stored); } catch (_) { settings = { ...DEFAULT_SETTINGS }; }
      for (const config of settings.configs) await loadIndex(config);
      // Adopt the automatic jobs still running when the app closed.
      try {
        const jobs = await service.list();
        const saved = await readJson(STATE_FILE);
        const pausedIds = new Set([...(Array.isArray(saved?.pausedForWindowJobIds) ? saved.pausedForWindowJobIds : []), saved?.pausedForWindowJobId].filter(Boolean));
        const forDevices = new Set(Array.isArray(saved?.pausedForDevicesJobIds) ? saved.pausedForDevicesJobIds : []);
        for (const running of jobs) {
          if (running.config?.autoConvert !== true || TERMINAL.has(running.state) || typeof running.config.sourceRoot !== 'string') continue;
          await loadIndex(running.config);
          // Only a pause this feature made is undone automatically.
          status.active[running.config.sourceRoot] = {
            jobId: running.id, lanes: running.config.lanes || null,
            pausedForWindow: running.state === 'paused' && pausedIds.has(running.id),
            pausedForDevices: running.state === 'paused' && forDevices.has(running.id)
          };
        }
        changed();
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
    /**
     * The shared schedule and window, plus one vehicle's folder: `enabled`
     * with `config` turns automatic on for config.sourceRoot (or saves its
     * new settings); `removeSource` turns it off for that folder. Other
     * folders keep theirs. `configs` replaces the whole list.
     */
    async configure(next) {
      let configs = settings.configs;
      if (Array.isArray(next?.configs)) configs = next.configs;
      else if (next?.enabled === true && isConfig(next.config)) {
        const { nodesOff: _sent, ...sent } = next.config;
        const off = await nodesOffFor(withValidLanes(sent).lanes)
          ?? (settings.configs.find((config) => config.sourceRoot === sent.sourceRoot)?.nodesOff || []);
        configs = [...configs.filter((config) => config.sourceRoot !== next.config.sourceRoot), { ...sent, ...(off.length ? { nodesOff: off } : {}) }];
      } else if (typeof next?.removeSource === 'string') {
        configs = configs.filter((config) => config.sourceRoot !== next.removeSource);
      }
      if (configs.length > MAX_SOURCES) throw autoError('TOO_MANY_AUTO_SOURCES');
      const normalized = normalizeSettings({ ...next, configs });
      for (const config of normalized.configs) await loadIndex(config);
      const before = new Map(settings.configs.map((config) => [config.sourceRoot, JSON.stringify(config)]));
      const added = normalized.configs.filter((config) => before.get(config.sourceRoot) !== JSON.stringify(config)).map((config) => config.sourceRoot);
      settings = normalized;
      await writeJson(SETTINGS_FILE, settings);
      // a folder turned on (or with new settings) is checked soon
      for (const sourceRoot of added) if (!status.round.includes(sourceRoot)) status.round.push(sourceRoot);
      if (!settings.enabled) { status.round = []; status.nextCheckAt = null; }
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
    // Parallel conversions changed on a running automatic job: later
    // automatic jobs for that folder use the same number.
    async setConcurrency(value, sourceRoot) {
      const current = activeConfig(sourceRoot);
      if (!current || (current.concurrency === value && !current.lanes)) return getState();
      // the running job has one number for all; the saved setting follows it
      const { lanes: _lanes, ...config } = current;
      settings = { ...settings, configs: settings.configs.map((c) => (c === current ? { ...config, concurrency: value } : c)) };
      await writeJson(SETTINGS_FILE, settings);
      changed();
      return getState();
    },
    // Conversions at once per GPU changed on the running automatic job.
    async setLanes(value, sourceRoot) {
      const lanes = normalizeLanes(value);
      const current = activeConfig(sourceRoot);
      if (!current || !lanes) return getState();
      const off = (await nodesOffFor(lanes)) ?? (current.nodesOff || []);
      if (JSON.stringify(current.lanes || null) === JSON.stringify(lanes) && sameLanes(current.nodesOff || [], off)) return getState();
      const { nodesOff: _old, ...rest } = current;
      settings = { ...settings, configs: settings.configs.map((c) => (c === current ? { ...rest, lanes, concurrency: lanesTotal(lanes), ...(off.length ? { nodesOff: off } : {}) } : c)) };
      await writeJson(SETTINGS_FILE, settings);
      changed();
      return getState();
    },
    async checkNow() {
      status.nextCheckAt = null;
      status.round = [];
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

module.exports = { createAutoConverter, planLanes, INTERVAL_MINUTES, inWindow, CONVERTER_REVISION };
