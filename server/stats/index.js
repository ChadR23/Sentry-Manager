'use strict';

// Server monitor ("nerd stats"). Samples the machine every 2 s while a page
// is watching (touch) or something needs it (a conversion or a benchmark:
// isBusy / markJob), and runs no timers at all otherwise. The app's own
// once-a-minute housekeeping calls tick(), which reads the network counters
// once a day, so the data used lands on the right day with nobody watching.
// Everything comes from this machine's /proc and /sys (plus nvidia-smi on an
// NVIDIA host); nothing leaves the server.
//
// What exists is probed once (and again every 10 minutes while sampling);
// a sample is then a few dozen small reads. Reads that ask a device (disk
// and GPU sensors) and the shares' answer times run in the background, so a
// slow disk or a hung NAS never holds up the web server. snapshot() is the
// GET /api/stats body, built at sample time; it never touches the disk.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { BackgroundReads, round, maxOf, sumOf } = require('./util');
const { ProcessTable } = require('./procs');
const { CpuProvider } = require('./cpu');
const { MemoryProvider } = require('./memory');
const { SensorsProvider } = require('./sensors');
const { DisksProvider } = require('./disks');
const { NetworkProvider } = require('./network');
const { GpuProvider } = require('./gpu');
const { PowerProvider } = require('./power');
const { FilesystemsProvider } = require('./filesystems');
const { HostInfo, probeFfmpeg } = require('./host');
const { Alerts } = require('./alerts');
const { History, SERIES } = require('./history');
const { Energy, dayKey } = require('./energy');
const { Traffic } = require('./traffic');

const WATCH_MS = 15000; // a page counts as watching this long after its last request
const FIRST_FOLLOW_UP_MS = 500; // the first numbers need two samples; don't make the page wait 2 s
const MIN_GAP_MS = 250;
const SAVE_EVERY_MS = 5 * 60 * 1000;
const REPROBE_MS = 10 * 60 * 1000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
// the Overview shows 8 rows and scrolls for the rest
const TOP_PROCESSES = 40;

// "Shown only when the server provides it": what one optional compose line adds
const UNLOCK = {
  // Docker hides the energy counters; the supervisor reads this read-only bind
  'cpu-power': {
    adds: 'CPU power in watts and kWh (a read-only energy counter)',
    compose: '- /sys/devices/virtual/powercap:/host/powercap:ro'
  },
  'host-view': {
    adds: 'Processes and network of the whole server, not only this container. It also lets this container see and signal the server\'s processes, so use it only with a PUID/PGID of its own (not your login user)',
    compose: 'pid: host'
  }
};

function createStats(options = {}) {
  const opt = (key, fallback) => (options[key] === undefined || options[key] === null ? fallback : options[key]);
  const procRoot = opt('procRoot', '/proc');
  const sysRoot = opt('sysRoot', '/sys');
  const devRoot = opt('devRoot', '/dev');
  const dataDir = opt('dataDir', null);
  const appPid = Number(opt('appPid', process.pid));
  const nowFn = opt('now', Date.now);
  const now = () => Number(nowFn());
  const intervalMs = Math.max(100, Number(opt('intervalMs', 2000)) || 2000);
  const isBusy = opt('isBusy', () => false);
  const spawn = opt('spawn', childProcess.spawn);
  const readShares = opt('readShares', () => []);
  const activeEncodes = opt('activeEncodes', () => []);
  const log = opt('log', null);
  const timers = opt('timers', { setTimeout, clearTimeout });
  const fsp = opt('fsp', fs.promises);
  const priceAt = opt('priceAt', () => null);
  // where a conversion job stands ({ clips, savedB }), asked at each sample while its energy is counted
  const jobProgress = opt('jobProgress', () => null);

  const reads = new BackgroundReads({ now, readFile: typeof fsp.readFile === 'function' ? fsp.readFile.bind(fsp) : fs.promises.readFile });
  const procs = new ProcessTable({ procRoot, appPid });
  const cpu = new CpuProvider({ procRoot, sysRoot, now });
  const memoryProvider = new MemoryProvider({ procRoot });
  const sensors = new SensorsProvider({ sysRoot, reads });
  const disks = new DisksProvider({ procRoot, sysRoot, now, sensors });
  const network = new NetworkProvider({ procRoot, sysRoot, now });
  const gpu = new GpuProvider({
    procRoot, sysRoot, devRoot, now, reads, sensors, spawn, timers, intervalMs, log,
    ...(options.pciIdsFiles ? { pciIdsFiles: options.pciIdsFiles } : {})
  });
  const power = new PowerProvider({ sysRoot, now, intervalMs });
  const filesystems = new FilesystemsProvider({ procRoot, sysRoot, appPid, readShares, fsp, now, log });
  const host = new HostInfo({ procRoot, version: options.version });
  const history = new History({ intervalMs });
  const energy = new Energy({ intervalMs, progressOf: (jobId) => callSafe(jobProgress, jobId) || null });
  const traffic = new Traffic();
  const alerts = new Alerts({ onAlert: options.onAlert, onAlertClear: options.onAlertClear, log });
  const file = dataDir ? path.join(dataDir, 'stats-history.json') : null;

  let sampling = false;
  let stopped = false;
  let timer = null;
  let lastTouch = null;
  let samplingSince = null;
  let probedAt = null;
  let lastSave = now();
  let dirty = false;
  let tickedDay = null;
  let ffmpegVersion = options.ffmpegVersion === undefined ? null : options.ffmpegVersion;
  let ffmpegAsked = options.ffmpegVersion !== undefined;
  const warned = new Set();

  const warnOnce = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    log?.warn?.(message);
  };
  const guard = (name, fn, fallback) => {
    try {
      return fn();
    } catch (err) {
      warnOnce(`fail:${name}`, `Server stats: reading ${name} failed: ${err.message}`);
      return fallback;
    }
  };
  const callSafe = (fn, ...args) => {
    if (typeof fn !== 'function') return undefined;
    try {
      return fn(...args);
    } catch {
      return undefined;
    }
  };
  const list = (fn) => {
    const v = callSafe(fn);
    return Array.isArray(v) ? v : [];
  };
  /** The price per kWh in force at t, or null (no price set, or a bad answer). */
  const price = (t) => {
    const p = callSafe(priceAt, t);
    return typeof p === 'number' && Number.isFinite(p) && p >= 0 ? p : null;
  };

  // ---- saved history (graphs, energy and data used survive a restart)
  function load() {
    if (!file) return;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error('file too large');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data?.v !== 1) return;
      history.load(data.history, now());
      energy.load(data.energy);
      traffic.load(data.traffic);
      filesystems.load(data.shares);
    } catch (err) {
      if (err.code !== 'ENOENT') warnOnce('load', `Server stats: could not read ${file} (${err.message}); starting a new history.`);
    }
  }

  function save() {
    if (!file) return;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: now(), history: history.toJSON(), energy: energy.toJSON(), traffic: traffic.toJSON(), shares: filesystems.toJSON() }), { mode: 0o600 });
      fs.renameSync(tmp, file);
      dirty = false;
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // nothing to clean
      }
      warnOnce('save', `Server stats: could not save ${file}: ${err.message}`);
    }
    lastSave = now();
  }

  // ---- sampling
  function probe(t) {
    // sensors first: disks and GPUs look up their own sensor chips
    guard('sensors', () => sensors.probe());
    guard('cpu', () => cpu.probe());
    guard('processes', () => procs.probe());
    guard('memory', () => memoryProvider.probe());
    guard('disks', () => disks.probe());
    guard('network', () => network.probe());
    guard('gpus', () => gpu.probe());
    guard('power', () => power.probe());
    guard('host', () => host.probe());
    if (probedAt !== null) reads.prune(probedAt);
    probedAt = t;
  }

  function appUsage() {
    if (!procs.byPid.has(appPid)) return { usage: null, ffmpegUsage: null, ffmpegCount: null };
    const members = [...procs.app].map((pid) => procs.byPid.get(pid)).filter(Boolean);
    const ffmpeg = members.filter((p) => /^ffmpeg/.test(p.comm));
    const known = members.some((p) => p.cpu !== null);
    return {
      usage: known ? round(sumOf(members.map((p) => p.cpu)) || 0, 1) : null,
      ffmpegUsage: known ? round(sumOf(ffmpeg.map((p) => p.cpu)) || 0, 1) : null,
      ffmpegCount: ffmpeg.length
    };
  }

  function topProcesses(encoders) {
    const shown = procs.list.filter((p) => p.state !== 'Z' && p.pid !== 2 && p.ppid !== 2 && (p.rssPages > 0 || procs.app.has(p.pid)));
    shown.sort((a, b) => (b.cpu || 0) - (a.cpu || 0) || b.memB - a.memB);
    return shown.slice(0, TOP_PROCESSES).map((p) => {
      const enc = encoders.get(p.pid);
      let name = p.comm;
      if (p.pid === appPid) name = 'sentry-six-manager';
      else if (enc?.encoder) name = `${p.comm} · ${enc.encoder}`;
      return { pid: p.pid, name, cpu: round(p.cpu, 1), memB: p.memB, gpuVideo: procs.app.has(p.pid) ? gpu.videoOf(p.pid) : null };
    });
  }

  /** Two or more sockets: each one's use, with its own temperature and package power. */
  function perSocket(list) {
    if (!Array.isArray(list) || list.length < 2) return null;
    const ids = list.map((s) => s.socket);
    const temps = guard('sensors', () => sensors.socketTemps(ids), []);
    const watts = guard('power', () => power.socketWatts(), new Map());
    return list.map((s, i) => ({ ...s, tempC: temps[i] ?? null, powerW: round(watts.get(s.socket) ?? null, 1) }));
  }

  function unlockHints(t, cpuW) {
    const out = [];
    // give the supervisor a few seconds to send its first RAPL reading; a
    // virtual machine has no counters to bind, so no hint there
    if (cpu.info.x86 && !cpu.info.virtual && cpuW === null && !power.hasRapl(t) && samplingSince !== null && t - samplingSince >= 3 * intervalMs) {
      out.push({ key: 'cpu-power', ...UNLOCK['cpu-power'] });
    }
    if (procs.scope !== 'host') out.push({ key: 'host-view', ...UNLOCK['host-view'] });
    return out;
  }

  let body = skeleton();

  function skeleton() {
    return {
      at: null, intervalMs,
      host: { hostname: null, os: null, kernel: null, arch: null, uptimeS: null, appUptimeS: null, version: host.version ?? null, node: process.version, ffmpeg: ffmpegVersion },
      cpu: { model: null, cores: null, threads: null, usage: null, perCore: [], freqMHz: null, tempC: null, load: null, app: { usage: null, ffmpegUsage: null, ffmpegCount: null }, throttling: false, sockets: 1, perSocket: null },
      memory: { totalB: null, usedB: null, availableB: null, cacheB: null, swapTotalB: null, swapUsedB: null, appB: null },
      gpus: [],
      power: { totalW: null, cpuW: null, gpuW: null, chipW: null, discreteW: null, todayWh: null, weekWh: null, todayCost: null, weekCost: null, priceNow: null, cpuSource: null, gpuSource: null },
      disks: [],
      filesystems: [],
      network: { scope: 'container', interfaces: [], today: null, week: null, month: null },
      sensors: [],
      processes: { scope: 'container', top: [] },
      alerts: [],
      unlock: [],
      sparks: { cpu: [], gpuVideo: [], rxBps: [] }
    };
  }

  let lastSampleAt = null;

  function sampleOnce() {
    const t = now();
    // Rates are deltas over the time between samples; two samples a moment
    // apart (a job waking the sampler right after one) would turn
    // rounding noise into numbers, so the second is skipped.
    if (lastSampleAt !== null && t >= lastSampleAt && t - lastSampleAt < MIN_GAP_MS) return body;
    lastSampleAt = t;
    if (probedAt === null || t - probedAt >= REPROBE_MS) probe(t);
    const c = guard('cpu', () => cpu.sample(), null);
    guard('processes', () => procs.sample(c?.totalTicks ?? null));
    const encodes = list(activeEncodes);
    const encoders = new Map(encodes.filter((e) => e && Number.isInteger(e.pid)).map((e) => [e.pid, e]));
    const memory = guard('memory', () => memoryProvider.sample(procs), skeleton().memory);
    const gpus = guard('gpus', () => gpu.sample(t, procs), []);
    const pw = guard('power', () => power.sample(t, gpus), skeleton().power);
    // costs are summed at the price of each moment (time-of-use plans)
    const priceNow = price(t);
    energy.add(t, pw.totalW, priceNow);
    const es = energy.summary(t);
    const diskList = guard('disks', () => disks.sample(), []);
    const net = guard('network', () => network.sample(), { scope: network.scope, interfaces: [] });
    // data used: the same counters, per day (a gap between samples loses nothing)
    guard('traffic', () => traffic.add(network.readAt, network.counters, network.where(), (name) => network.ifindex(name)));
    const used = guard('traffic', () => traffic.summary(t), { today: null, week: null, month: null });
    const fsList = guard('filesystems', () => filesystems.sample(t), []);
    const { sensors: sensorList, cpuTempC: cpuTemp } = guard('sensors', () => sensors.sample(), { sensors: [], cpuTempC: null });

    const next = {
      at: t, intervalMs,
      host: guard('host', () => host.info({ uptimeS: procs.uptime ?? null, appStartS: procs.appStartS(), ffmpeg: ffmpegVersion }), skeleton().host),
      cpu: {
        model: c?.model ?? cpu.info.model ?? null, cores: c?.cores ?? null, threads: c?.threads ?? null,
        usage: c?.usage ?? null, perCore: c?.perCore ?? [], freqMHz: c?.freqMHz ?? null, tempC: cpuTemp,
        load: c?.load ?? null, app: appUsage(), throttling: Boolean(c?.throttling),
        sockets: c?.sockets ?? cpu.info.sockets ?? 1, perSocket: perSocket(c?.perSocket)
      },
      memory,
      gpus: gpus.map(({ powerSource, ...g }) => g),
      power: { ...pw, todayWh: es.todayWh, weekWh: es.weekWh, todayCost: es.todayCost, weekCost: es.weekCost, priceNow },
      disks: diskList,
      filesystems: fsList,
      network: { ...net, today: used.today, week: used.week, month: used.month },
      sensors: sensorList,
      processes: { scope: procs.scope, top: guard('top', () => topProcesses(encoders), []) },
      alerts: [],
      unlock: [],
      sparks: { cpu: [], gpuVideo: [], rxBps: [] }
    };
    const memPct = memory.totalB ? (memory.usedB / memory.totalB) * 100 : null;
    const values = {
      cpu: next.cpu.usage, memory: memPct, gpuBusy: maxOf(gpus.map((g) => g.busy)), gpuVideo: maxOf(gpus.map((g) => g.video)),
      powerW: pw.totalW, rxBps: sumOf(net.interfaces.map((i) => i.rxBps)), txBps: sumOf(net.interfaces.map((i) => i.txBps)),
      tempMax: maxOf([cpuTemp, ...gpus.map((g) => g.tempC), ...diskList.map((d) => d.tempC)])
    };
    history.add(t, SERIES.map((name) => values[name]));
    next.alerts = guard('alerts', () => alerts.evaluate(t, next), []);
    next.unlock = unlockHints(t, pw.cpuW);
    next.sparks = history.sparks(t);
    body = next;
    dirty = true;
    if (t - lastSave >= SAVE_EVERY_MS) save();
    return body;
  }

  const busy = () => Boolean(callSafe(isBusy));
  const wanted = (t) => (lastTouch !== null && t - lastTouch < WATCH_MS) || busy() || energy.active();

  function schedule(ms) {
    timer = timers.setTimeout(tick, ms);
    timer?.unref?.();
  }

  function tick() {
    timer = null;
    if (!sampling) return;
    if (!wanted(now())) {
      goIdle();
      return;
    }
    guard('sample', sampleOnce);
    schedule(intervalMs);
  }

  function askFfmpeg() {
    if (ffmpegAsked) return;
    ffmpegAsked = true;
    probeFfmpeg({ spawn, ffmpegPath: opt('ffmpegPath', process.env.FFMPEG_PATH || 'ffmpeg'), timers })
      .then((v) => {
        ffmpegVersion = v;
        if (body.host) body.host.ffmpeg = v;
      }, () => {});
  }

  function start() {
    if (stopped || sampling) return;
    sampling = true;
    samplingSince = now();
    if (probedAt === null) probe(samplingSince);
    callSafe(options.onSampling, true);
    guard('gpus', () => gpu.startStreams());
    askFfmpeg();
    guard('sample', sampleOnce);
    if (sampling) schedule(Math.min(FIRST_FOLLOW_UP_MS, intervalMs));
  }

  function goIdle() {
    sampling = false;
    samplingSince = null;
    if (timer) timers.clearTimeout(timer);
    timer = null;
    guard('gpus', () => gpu.stopStreams());
    if (dirty) save();
    callSafe(options.onSampling, false);
  }

  load();

  return {
    /** The GET /api/stats body (from the last sample; never waits for I/O). */
    snapshot() {
      return { ...body };
    },

    /** A page is watching: sample for the next 15 s. */
    touch() {
      if (stopped) return;
      lastTouch = now();
      start();
    },

    history(range) {
      return history.range(range === '24h' ? '24h' : '15m', now());
    },

    csv(range) {
      return history.csv(range === '24h' ? '24h' : '15m', now());
    },

    /**
     * { todayWh, weekWh, todayCost, weekCost, byJob: { [jobId]: { wh, avgW, seconds, cost, base } } };
     * `base` is where the job stood when its energy began to be counted ({ clips, savedB, wh }) or null
     */
    energy() {
      return energy.summary(now());
    },

    /** Data used: { today, week, month }, each { rxB, txB } or null (not measured yet). */
    traffic() {
      return traffic.summary(now());
    },

    /**
     * Called once a minute by the app's housekeeping (the engine runs no
     * timer of its own). On the first call of a day, while nothing samples,
     * the network counters are read once and saved: a day nobody watched
     * gets its own bytes, not a share of a gap over several days. The very
     * first call starts the count.
     */
    tick() {
      if (stopped || sampling) return;
      const t = now();
      const day = dayKey(t);
      if (day === tickedDay) return;
      tickedDay = day;
      // a sample read them today already
      if (network.readAt !== null && dayKey(network.readAt) === day) return;
      if (probedAt === null) guard('network', () => network.probe());
      guard('network', () => network.read());
      if (!network.counters) return;
      guard('traffic', () => traffic.add(network.readAt, network.counters, network.where(), (name) => network.ifindex(name)));
      dirty = true;
      save();
    },

    /** Energy from now on also counts for this job (null: no job). A job keeps sampling running. */
    markJob(jobId) {
      energy.markJob(jobId);
      dirty = true;
      if (jobId !== null && jobId !== undefined) start();
    },

    /** The supervisor's RAPL reading: { at, packages: [{ name, energyUj, maxEnergyUj }] }. */
    setRapl(reading) {
      power.setRapl(reading);
    },

    get sampling() {
      return sampling;
    },

    /** Take one sample now (tests; probes first if needed). */
    sampleNow() {
      if (probedAt === null) probe(now());
      return sampleOnce();
    },

    /** Resolves when no background read is in flight (tests). */
    settle() {
      return reads.idle().then(() => new Promise((resolve) => setImmediate(resolve)));
    },

    stop() {
      stopped = true;
      if (sampling) goIdle();
      else {
        guard('gpus', () => gpu.stopStreams());
        if (dirty) save();
      }
    }
  };
}

module.exports = { createStats, UNLOCK, WATCH_MS };
