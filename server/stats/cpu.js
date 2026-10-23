'use strict';

// CPU: model, cores and threads, total and per-core use from /proc/stat
// deltas, clock, load, thermal throttling, and how much of it is this app
// (and its ffmpeg children). A server with two or more CPU sockets also
// gets the use of each socket, from the CPUs /proc/cpuinfo puts in it.

const { readText, readLine, readNum, listDir, round, clampPct, join } = require('./util');

/** busy/total jiffies per line of /proc/stat (guest time is already inside user). */
function parseProcStat(text) {
  const out = { total: null, cores: new Map() };
  for (const line of String(text || '').split('\n')) {
    const m = /^cpu(\d*)\s+(.+)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    if (v.length < 4 || v.slice(0, 4).some((n) => !Number.isFinite(n))) continue;
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = v.map((n) => (Number.isFinite(n) ? n : 0));
    const all = user + nice + system + idle + iowait + irq + softirq + steal;
    const entry = { busy: all - idle - iowait, all };
    if (m[1] === '') out.total = entry;
    else out.cores.set(Number(m[1]), entry);
  }
  return out;
}

/** "12th Gen Intel(R) Core(TM) i5-12500" -> "Intel Core i5-12500". */
function cleanModel(name) {
  if (!name) return null;
  const s = String(name)
    .replace(/\((R|TM|tm|r)\)/g, '')
    .replace(/^\d+(st|nd|rd|th) Gen /i, '')
    .replace(/\s+@\s+[\d.]+\s*GHz/i, '')
    .replace(/\s+CPU\b/g, '')
    .replace(/\s+\d+-Core Processor\b/i, '')
    .replace(/\s+with Radeon( \w+)* Graphics\b/i, '')
    .replace(/\s+Processor\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
}

function parseCpuinfo(text, dtModel) {
  const blocks = String(text || '').split(/\n\s*\n/);
  let threads = 0;
  const coreKeys = new Set();
  const packages = new Map(); // physical id -> first cpu number
  const socketOf = new Map(); // cpu number -> physical id
  const perPackage = new Map(); // physical id -> { cores: Set of core ids, threads }
  let modelName = null;
  let hardware = null;
  let boardModel = null;
  let vendor = null;
  let implementer = null;
  let virtual = false;
  for (const block of blocks) {
    const kv = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    if (kv.processor !== undefined && /^\d+$/.test(kv.processor)) {
      threads++;
      if (kv['core id'] !== undefined) coreKeys.add(`${kv['physical id'] || 0}:${kv['core id']}`);
      const pkg = kv['physical id'] || '0';
      if (!packages.has(pkg)) packages.set(pkg, Number(kv.processor));
      if (/^\d+$/.test(pkg)) {
        socketOf.set(Number(kv.processor), Number(pkg));
        if (!perPackage.has(pkg)) perPackage.set(pkg, { cores: new Set(), threads: 0 });
        const p = perPackage.get(pkg);
        p.threads++;
        if (kv['core id'] !== undefined) p.cores.add(kv['core id']);
      }
    }
    modelName = modelName || kv['model name'] || null;
    vendor = vendor || kv.vendor_id || null;
    implementer = implementer || kv['CPU implementer'] || null;
    hardware = hardware || kv.Hardware || null;
    if (/\bhypervisor\b/.test(kv.flags || '')) virtual = true;
    boardModel = boardModel || kv.Model || null;
  }
  // ARM boards: the board ("Raspberry Pi 4 Model B") says more than "ARMv8 Processor"
  let model = null;
  if (modelName && !/^ARMv\d/i.test(modelName)) model = cleanModel(modelName);
  else model = boardModel || dtModel || hardware || (modelName ? cleanModel(modelName) : null);
  const arch = vendor ? 'x86' : implementer ? 'arm' : null;
  // A virtual machine's sockets are however it was set up (often one per
  // vCPU) and say nothing about the server's own, so a VM counts as one.
  const sockets = virtual ? [] : [...perPackage].map(([id, p]) => ({ socket: Number(id), cores: p.cores.size || p.threads, threads: p.threads }))
    .sort((a, b) => a.socket - b.socket);
  return {
    model, threads: threads || null, cores: coreKeys.size || threads || null,
    packageCpus: [...packages.values()].sort((a, b) => a - b), x86: arch === 'x86', vendor, virtual,
    sockets: Math.max(1, sockets.length), socketList: sockets.length > 1 ? sockets : [], socketOf
  };
}

class CpuProvider {
  constructor({ procRoot, sysRoot, now }) {
    this.procRoot = procRoot;
    this.sysRoot = sysRoot;
    this.now = now;
    this.prev = null;
    this.info = { model: null, cores: null, threads: null, packageCpus: [], x86: false, sockets: 1, socketList: [], socketOf: new Map() };
    this.freqFiles = [];
    this.throttleFiles = [];
    this.throttleCounts = null;
    this.lastThrottleAt = null;
  }

  probe() {
    const dtModel = (readText(join(this.sysRoot, 'firmware', 'devicetree', 'base', 'model'))
      || readText(join(this.procRoot, 'device-tree', 'model')) || '').replace(/\0/g, '').trim() || null;
    this.info = parseCpuinfo(readText(join(this.procRoot, 'cpuinfo')), dtModel);
    const cpuDir = join(this.sysRoot, 'devices', 'system', 'cpu');
    const cpus = listDir(cpuDir).filter((n) => /^cpu\d+$/.test(n)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
    // a 128-thread server need not be read core by core: 32 spread over it tell the clock
    const step = Math.max(1, cpus.length / 32);
    const picked = [];
    for (let i = 0; i < cpus.length && picked.length < 32; i = Math.ceil(i + step - 1e-9)) picked.push(cpus[Math.floor(i)]);
    this.freqFiles = picked.map((c) => join(cpuDir, c, 'cpufreq', 'scaling_cur_freq')).filter((f) => readNum(f) !== null);
    if (!this.info.threads && cpus.length) this.info.threads = this.info.cores = cpus.length;
    // Thermal throttle counters are per package and per core; one CPU per
    // package covers the package, and its core counter is a fair sample.
    // (The power-limit counters rise in normal turbo use, so they are not read.)
    const firsts = this.info.packageCpus.length ? this.info.packageCpus : [0];
    this.throttleFiles = [];
    this.throttleCounts = null;
    for (const n of firsts) {
      for (const name of ['package_throttle_count', 'core_throttle_count']) {
        const f = join(cpuDir, `cpu${n}`, 'thermal_throttle', name);
        if (readNum(f) !== null) this.throttleFiles.push(f);
      }
    }
  }

  sample() {
    const t = this.now();
    const stat = parseProcStat(readText(join(this.procRoot, 'stat')));
    let usage = null;
    let perCore = [];
    let totalTicks = null;
    const { socketList, socketOf } = this.info;
    const bySocket = new Map(socketList.map((s) => [s.socket, { busy: 0, all: 0 }]));
    if (stat.total && this.prev?.total) {
      const all = stat.total.all - this.prev.total.all;
      const busy = stat.total.busy - this.prev.total.busy;
      // iowait can run backwards on some kernels; a step back is no data
      if (all > 0 && busy >= 0) {
        usage = clampPct((busy / all) * 100);
        totalTicks = all;
      }
      for (const [n, core] of [...stat.cores].sort((a, b) => a[0] - b[0])) {
        const before = this.prev.cores.get(n);
        const a = before ? core.all - before.all : 0;
        const b = before ? core.busy - before.busy : -1;
        perCore.push(a > 0 && b >= 0 ? round(clampPct((b / a) * 100), 0) : null);
        // a socket's use: the time its own CPUs worked over their time
        const s = a > 0 && b >= 0 ? bySocket.get(socketOf.get(n)) : null;
        if (s) {
          s.busy += b;
          s.all += a;
        }
      }
    }
    if (stat.total) this.prev = stat;
    const perSocket = socketList.length > 1 ? socketList.map((s) => {
      const t = bySocket.get(s.socket);
      return { socket: s.socket, cores: s.cores, threads: s.threads, usage: t.all > 0 ? round(clampPct((t.busy / t.all) * 100)) : null };
    }) : null;

    // the fastest core: idle cores sit at their lowest clock and say little
    let freqMHz = null;
    for (const f of this.freqFiles) {
      const khz = readNum(f);
      if (khz !== null && khz > 0 && (freqMHz === null || khz / 1000 > freqMHz)) freqMHz = khz / 1000;
    }

    const load = String(readLine(join(this.procRoot, 'loadavg')) || '').split(/\s+/).slice(0, 3).map(Number);

    // throttling: a counter rose within the last 10 s
    if (this.throttleFiles.length) {
      const counts = this.throttleFiles.map((f) => readNum(f));
      if (this.throttleCounts && counts.some((c, i) => c !== null && this.throttleCounts[i] !== null && c > this.throttleCounts[i])) this.lastThrottleAt = t;
      this.throttleCounts = counts;
    }
    const throttling = this.throttleFiles.length ? this.lastThrottleAt !== null && t - this.lastThrottleAt < 10000 : false;

    return {
      model: this.info.model, cores: this.info.cores, threads: this.info.threads,
      usage: round(usage), perCore, freqMHz: freqMHz === null ? null : Math.round(freqMHz),
      load: load.length === 3 && load.every(Number.isFinite) ? load : null,
      throttling, totalTicks, sockets: this.info.sockets, perSocket
    };
  }
}

module.exports = { CpuProvider, parseProcStat, parseCpuinfo, cleanModel };
