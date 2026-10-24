'use strict';

// Live GPU numbers (server/gpu.js says what hardware exists; this says what
// it is doing).
//
// - AMD (amdgpu): gpu_busy_percent, VRAM, current shader clock, hwmon power
//   and temperature.
// - Intel (i915, xe): current clock, hwmon energy (discrete Arc) -> W.
// - Intel and AMD per process: the DRM fdinfo of the app's children (ffmpeg).
//   Each open GPU client reports how long each engine class worked for it;
//   busy % = that time over the wall time between two samples. This needs no
//   root (they are our own processes) but only sees our own clients, so on
//   Intel "busy" means "busy for this app".
// - NVIDIA: one long-running nvidia-smi that prints a line per GPU every
//   interval, started only while sampling and killed when it stops.
// - Anything else (Raspberry Pi's V3D, ...): its name and temperature, if any.

const path = require('path');
const { readText, readLine, readLink, realPath, listDir, exists, parseUevent, num, round, clampPct, maxOf, join } = require('./util');

const VENDORS = { '0x8086': 'intel', '0x1002': 'amd', '0x10de': 'nvidia' };
const VENDOR_NAMES = { intel: 'Intel', amd: 'AMD', nvidia: 'NVIDIA' };
const RENDER_ENGINE = /^(render|rcs|gfx|3d)$/;
const VIDEO_ENGINE = /^(video|video-enhance|vcs\d*|vecs\d*|enc(_\d+)?|dec(_\d+)?|vcn.*)$/;
// pci.ids is not in the image; these are the cards people buy to encode
const KNOWN = {
  '0x8086:0x56a0': 'Intel Arc A770', '0x8086:0x56a1': 'Intel Arc A750', '0x8086:0x56a2': 'Intel Arc A580',
  '0x8086:0x56a5': 'Intel Arc A380', '0x8086:0x56a6': 'Intel Arc A310', '0x8086:0xe20b': 'Intel Arc B580',
  '0x8086:0xe20c': 'Intel Arc B570'
};
const OTHER_NAMES = { v3d: 'Broadcom V3D', vc4: 'Broadcom VideoCore', 'vc4-drm': 'Broadcom VideoCore', panfrost: 'Arm Mali (Panfrost)', panthor: 'Arm Mali (Panthor)', lima: 'Arm Mali (Lima)', msm: 'Qualcomm Adreno', etnaviv: 'Vivante GPU', nouveau: 'NVIDIA (nouveau)' };
const PCI_IDS = ['/usr/share/misc/pci.ids', '/usr/share/hwdata/pci.ids', '/usr/share/pci.ids'];
const NVIDIA_QUERY = 'index,name,driver_version,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu,power.draw,clocks.gr';

/** A device's name from pci.ids: "DG2 [Arc A380]" -> "Intel Arc A380". */
function lookupPciIds(text, vendorId, deviceId, vendor) {
  if (!text || !vendorId || !deviceId) return null;
  const v = vendorId.replace(/^0x/, '').toLowerCase();
  const d = deviceId.replace(/^0x/, '').toLowerCase();
  const start = text.indexOf(`\n${v}  `);
  if (start < 0) return null;
  const lines = text.slice(start + 1, start + 400000).split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line && !line.startsWith('\t') && !line.startsWith('#')) break;
    const m = /^\t([0-9a-f]{4})\s+(.+)$/.exec(line);
    if (m && m[1] === d) {
      const bracket = /\[([^\]]+)\]/.exec(m[2]);
      const short = VENDOR_NAMES[vendor] || '';
      const base = (bracket ? bracket[1] : m[2]).trim();
      return short && !base.startsWith(short) ? `${short} ${base}` : base;
    }
  }
  return null;
}

/**
 * A GPU's display name: the product name amdgpu reports, else pci.ids, else
 * the cards in KNOWN, else "Intel graphics" / "AMD graphics" (SoC GPUs by
 * their driver). Also names the converter's encoding devices.
 */
function gpuDisplayName({ dev, driver, kind, vendor, vendorId, deviceId, pciIdsFiles = PCI_IDS }) {
  const family = kind || (driver === 'amdgpu' ? 'amd' : driver === 'i915' || driver === 'xe' ? 'intel' : 'other');
  const maker = family !== 'other' ? family : vendor || VENDORS[vendorId] || 'other';
  let name = null;
  if (family === 'amd' && dev) name = readLine(join(dev, 'product_name'));
  if (!name && vendorId && deviceId && VENDORS[vendorId]) {
    for (const f of pciIdsFiles) {
      name = lookupPciIds(readText(f), vendorId, deviceId, maker);
      if (name) break;
    }
  }
  name = name || KNOWN[`${vendorId}:${deviceId}`] || null;
  if (!name) name = family === 'other' ? OTHER_NAMES[driver] || driver || 'GPU' : `${VENDOR_NAMES[maker] || 'Unknown'} graphics`;
  return name;
}

/** One fdinfo file of a DRM client. */
function parseFdinfo(text) {
  if (!text) return null;
  const out = { driver: null, pdev: null, clientId: null, engines: {}, capacity: {} };
  const eng = (name) => (out.engines[name] = out.engines[name] || {});
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    if (key === 'drm-driver') out.driver = val;
    else if (key === 'drm-pdev') out.pdev = val;
    else if (key === 'drm-client-id') out.clientId = val;
    else if (key.startsWith('drm-engine-capacity-')) out.capacity[key.slice(20)] = Math.max(1, parseInt(val, 10) || 1);
    else if (key.startsWith('drm-engine-')) {
      const n = parseFloat(val); // "123456 ns"
      if (Number.isFinite(n)) eng(key.slice(11)).ns = n;
    } else if (key.startsWith('drm-total-cycles-')) {
      const n = parseFloat(val);
      if (Number.isFinite(n)) eng(key.slice(17)).total = n;
    } else if (key.startsWith('drm-cycles-')) {
      const n = parseFloat(val);
      if (Number.isFinite(n)) eng(key.slice(11)).cycles = n;
    }
  }
  return out.driver || out.clientId !== null ? out : null;
}

/**
 * Busy share (0..1) of each engine for one client between two fdinfo reads.
 * i915/amdgpu count nanoseconds (divide by wall time); xe counts GPU cycles
 * against the GPU's own clock (divide by total cycles). Engines with several
 * instances (two video engines on an Arc) are divided by their capacity.
 */
function engineUse(before, after, wallMs) {
  const out = {};
  for (const [name, cur] of Object.entries(after.engines)) {
    const prev = before.engines[name];
    if (!prev) continue;
    let u = null;
    if (cur.cycles !== undefined && prev.cycles !== undefined && cur.total !== undefined && prev.total !== undefined) {
      const total = cur.total - prev.total;
      if (total > 0) u = (cur.cycles - prev.cycles) / total;
    } else if (cur.ns !== undefined && prev.ns !== undefined && wallMs > 0) {
      u = (cur.ns - prev.ns) / (wallMs * 1e6);
    }
    if (u === null || !Number.isFinite(u) || u < 0) continue;
    out[name] = Math.min(1, u / (after.capacity[name] || 1));
  }
  return out;
}

const groupMax = (engines, re) => {
  let best = null;
  for (const [name, u] of Object.entries(engines)) if (re.test(name) && (best === null || u > best)) best = u;
  return best;
};

/** "0: 500Mhz\n1: 2321Mhz *" -> 2321 */
function currentClock(text) {
  const m = /(\d+)\s*Mhz\s*\*/i.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

/** One CSV line of the nvidia-smi query; [N/A] and friends become null. */
function parseNvidiaLine(line) {
  const parts = String(line).split(',').map((s) => s.trim());
  if (parts.length < 11) return null;
  const index = Number(parts[0]);
  if (!Number.isInteger(index) || index < 0) return null;
  const tail = parts.slice(-9);
  const name = parts.slice(1, parts.length - 9).join(', ');
  const n = (s) => {
    if (!s || /^\[.*\]$/.test(s) || /^N\/A$/i.test(s)) return null;
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
  };
  const mib = (s) => (n(s) === null ? null : Math.round(n(s) * 1048576));
  const [driver, busy, enc, dec, used, total, temp, power, clock] = tail;
  return {
    index, name: name || null, driverVersion: driver && !/^\[.*\]$/.test(driver) ? driver : null,
    busy: n(busy), encoder: n(enc), decoder: n(dec), vramUsedB: mib(used), vramTotalB: mib(total),
    tempC: n(temp), powerW: n(power), clockMHz: n(clock)
  };
}

/** The long-running nvidia-smi: started while sampling, restarted with backoff, killed on stop. */
class NvidiaSmi {
  constructor({ spawn, timers, now, intervalMs, log }) {
    this.spawn = spawn;
    this.timers = timers;
    this.now = now;
    this.intervalMs = intervalMs;
    this.log = log;
    this.wanted = false;
    this.child = null;
    this.timer = null;
    this.backoff = 2000;
    this.gpus = new Map();
    this.missingLogged = false;
  }

  start() {
    this.wanted = true;
    if (!this.child && !this.timer) this.launch();
  }

  stop() {
    this.wanted = false;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  }

  launch() {
    this.timer = null;
    if (!this.wanted) return;
    const startedAt = this.now();
    let child;
    try {
      child = this.spawn('nvidia-smi', [`--query-gpu=${NVIDIA_QUERY}`, '--format=csv,noheader,nounits', '-lms', String(this.intervalMs)], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      this.ended(err, startedAt);
      return;
    }
    this.child = child;
    let buf = '';
    let done = false;
    const end = (err) => {
      if (done) return;
      done = true;
      // a child stopped or replaced meanwhile must not start another one
      if (this.child !== child) return;
      this.child = null;
      this.ended(err, startedAt);
    };
    child.on('error', end);
    child.on('exit', () => end(null));
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 65536) buf = buf.slice(-4096);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const g = parseNvidiaLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (g) {
          g.at = this.now();
          this.gpus.set(g.index, g);
          if (this.gpus.size > 16) this.gpus.delete(this.gpus.keys().next().value);
        }
      }
    });
    child.stdout?.on('error', () => {});
  }

  ended(err, startedAt) {
    if (!this.wanted) return;
    let delay;
    if (err?.code === 'ENOENT') {
      // the device is there but the toolkit did not bring nvidia-smi in
      if (!this.missingLogged) this.log?.warn('An NVIDIA GPU is present but nvidia-smi is not available in the container; NVIDIA numbers are not shown.');
      this.missingLogged = true;
      delay = 10 * 60 * 1000;
    } else {
      if (this.now() - startedAt > 60000) this.backoff = 2000;
      delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, 5 * 60 * 1000);
    }
    this.timer = this.timers.setTimeout(() => this.launch(), delay);
    this.timer?.unref?.();
  }

  read() {
    const t = this.now();
    const fresh = Math.max(3 * this.intervalMs, 6000);
    return [...this.gpus.values()].sort((a, b) => a.index - b.index).map((g) => {
      const ok = t - g.at <= fresh;
      const pick = (v) => (ok ? v : null);
      return {
        id: `nvidia${g.index}`, name: g.name, vendor: 'nvidia', driver: 'nvidia', driverVersion: g.driverVersion, node: `nvidia${g.index}`,
        busy: pick(g.busy), video: pick(maxOf([g.encoder, g.decoder])), vramUsedB: pick(g.vramUsedB), vramTotalB: g.vramTotalB,
        clockMHz: pick(g.clockMHz), tempC: pick(g.tempC), powerW: pick(round(g.powerW, 1)), clients: null, powerSource: 'nvidia-smi'
      };
    });
  }
}

class GpuProvider {
  constructor({ procRoot, sysRoot, devRoot, now, reads, sensors, spawn, timers, intervalMs, log, pciIdsFiles = PCI_IDS }) {
    this.procRoot = procRoot;
    this.sysRoot = sysRoot;
    this.devRoot = devRoot;
    this.now = now;
    this.reads = reads;
    this.sensors = sensors;
    this.pciIdsFiles = pciIdsFiles;
    this.cards = [];
    this.names = new Map();
    this.fdCache = new Map(); // `${pid}:${start}` -> { at, fds }
    this.prevClients = new Map(); // `${pdev}|${client}` -> { t, info }
    this.perPid = new Map();
    this.drmOpen = true;
    this.hasNvidia = false;
    this.nvidia = new NvidiaSmi({ spawn, timers, now, intervalMs, log });
  }

  probe() {
    // only spawn nvidia-smi on a machine that has an NVIDIA device
    this.hasNvidia = exists(join(this.devRoot, 'nvidia0')) || exists(join(this.procRoot, 'driver', 'nvidia', 'version'));
    const drm = join(this.sysRoot, 'class', 'drm');
    const names = listDir(drm);
    const renders = names.filter((n) => /^renderD\d+$/.test(n)).map((r) => ({ r, dev: realPath(join(drm, r, 'device')) }));
    const cards = [];
    for (const card of names.filter((n) => /^card\d+$/.test(n)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))) {
      const dir = join(drm, card);
      const dev = realPath(join(dir, 'device'));
      if (!dev || cards.some((c) => c.dev === dev)) continue;
      const uevent = parseUevent(readText(join(dir, 'device', 'uevent')));
      const link = readLink(join(dir, 'device', 'driver'));
      const driver = (link && path.basename(link)) || uevent.DRIVER || null;
      if (driver === 'nvidia') continue; // reported by nvidia-smi
      // display-only devices (server BMC graphics, simpledrm) have no render node
      const render = renders.find((x) => x.dev === dev);
      if (!render) continue;
      const vendorId = readLine(join(dir, 'device', 'vendor'));
      const deviceId = readLine(join(dir, 'device', 'device'));
      const kind = driver === 'amdgpu' ? 'amd' : driver === 'i915' || driver === 'xe' ? 'intel' : 'other';
      const vendor = kind !== 'other' ? kind : VENDORS[vendorId] || 'other';
      const chip = this.sensors.chipOf(dev);
      const c = {
        id: card, dir, dev, pdev: path.basename(dev), driver, kind, vendor, node: render.r, chip,
        name: this.nameOf({ dev, driver, kind, vendor, vendorId, deviceId, uevent }),
        runtime: join(dev, 'power', 'runtime_status'), fdinfoSeen: false, vramTotalB: null
      };
      if (kind === 'amd') {
        c.busyFile = join(dev, 'gpu_busy_percent');
        c.vramUsedFile = join(dev, 'mem_info_vram_used');
        c.vramTotalB = num(readLine(join(dev, 'mem_info_vram_total')));
        c.sclkFile = join(dev, 'pp_dpm_sclk');
        const p = chip && (chip.files.has('power1_average') ? 'power1_average' : chip.files.has('power1_input') ? 'power1_input' : null);
        c.powerFile = p ? join(chip.dir, p) : null;
        // amdgpu shows no fans on APUs; their power reading is the whole chip, CPU included
        c.integrated = Boolean(chip) && !chip.files.has('fan1_input');
      } else if (kind === 'intel') {
        c.freqFile = [join(dir, 'gt_act_freq_mhz'), join(dir, 'gt', 'gt0', 'rps_act_freq_mhz'), join(dir, 'device', 'tile0', 'gt0', 'freq0', 'act_freq')].find(exists) || null;
        if (chip) {
          const energy = [...chip.files].filter((f) => /^energy\d+_input$/.test(f)).sort();
          const card = energy.find((f) => readLine(join(chip.dir, f.replace('_input', '_label'))) === 'card');
          c.energyFile = card || energy[0] ? join(chip.dir, card || energy[0]) : null;
        }
      }
      if (chip?.temps.length) {
        const t = chip.temps.find((x) => x.label === 'edge' || x.label === 'pkg') || chip.temps[0];
        c.tempFile = t.file;
      }
      cards.push(c);
    }
    // keep what was learned from fdinfo across a re-probe
    for (const c of cards) c.fdinfoSeen = this.cards.find((o) => o.dev === c.dev)?.fdinfoSeen || false;
    this.cards = cards;
    this.sensors.markGpuChips(cards.map((c) => c.dev));
  }

  nameOf({ dev, driver, kind, vendor, vendorId, deviceId }) {
    const key = `${vendorId}:${deviceId}:${driver}`; // SoC GPUs have no PCI ids at all
    if (this.names.has(key)) return this.names.get(key);
    const name = gpuDisplayName({ dev, driver, kind, vendor, vendorId, deviceId, pciIdsFiles: this.pciIdsFiles });
    this.names.set(key, name);
    return name;
  }

  /** DRM fd numbers of a process (its open /dev/dri files). */
  scanFds(pid) {
    const dir = join(this.procRoot, String(pid), 'fd');
    const fds = [];
    for (const fd of listDir(dir, 1024)) {
      const target = readLink(join(dir, fd));
      if (target && target.startsWith('/dev/dri/')) fds.push(fd);
    }
    return fds;
  }

  /** Engine use per GPU (and per process) from the fdinfo of the app's children. */
  clients(t, procs) {
    const byGpu = new Map();
    const perPid = new Map();
    const seen = new Set();
    const next = new Map();
    const alive = new Set();
    let drmOpen = !procs; // without the process list, nothing is known
    const gpuOf = (key) => {
      if (!byGpu.has(key)) byGpu.set(key, { engines: {}, pids: new Set(), measured: false });
      return byGpu.get(key);
    };
    for (const p of procs ? procs.descendants() : []) {
      const key = `${p.pid}:${p.start}`;
      alive.add(key);
      let cache = this.fdCache.get(key);
      // fds are found again every 10 s, or at once when one stops being a GPU client
      if (!cache || t - cache.at > 10000) {
        cache = { at: t, fds: this.scanFds(p.pid) };
        this.fdCache.set(key, cache);
      }
      if (cache.fds.length) drmOpen = true;
      for (const fd of cache.fds) {
        const text = readText(join(this.procRoot, String(p.pid), 'fdinfo', fd));
        if (text === null) {
          cache.at = -Infinity; // the fd was closed: look again next time
          continue;
        }
        // kernels before 5.19 (and some drivers) print no usage for DRM clients
        const info = parseFdinfo(text);
        if (!info || info.clientId === null) continue;
        // drm-pdev is only printed for PCI devices; others are matched by driver
        const gpuKey = info.pdev || `driver:${info.driver}`;
        const client = `${gpuKey}|${info.clientId}`;
        // the same client through a duplicated or inherited fd counts once
        if (seen.has(client)) continue;
        seen.add(client);
        next.set(client, { t, info });
        const g = gpuOf(gpuKey);
        g.pids.add(p.pid);
        const before = this.prevClients.get(client);
        if (!before) continue;
        g.measured = true;
        const use = engineUse(before.info, info, t - before.t);
        for (const [name, u] of Object.entries(use)) {
          g.engines[name] = (g.engines[name] || 0) + u;
          if (!perPid.has(p.pid)) perPid.set(p.pid, {});
          const mine = perPid.get(p.pid);
          mine[name] = (mine[name] || 0) + u;
        }
      }
      if (this.fdCache.size > 4096) this.fdCache.clear();
    }
    for (const k of this.fdCache.keys()) if (!alive.has(k)) this.fdCache.delete(k);
    this.prevClients = next;
    // none of the app's processes has a GPU open: its use is 0 on every GPU
    this.drmOpen = drmOpen;
    this.perPid = new Map([...perPid].map(([pid, engines]) => [pid, groupMax(engines, VIDEO_ENGINE)]));
    return byGpu;
  }

  /** Video engine % of one of the app's children (for the process list). */
  videoOf(pid) {
    const u = this.perPid.get(pid);
    return u === undefined || u === null ? null : round(clampPct(u * 100), 0);
  }

  watts(file) {
    const e = this.reads.get(file, 0);
    const a = num(e.prevText);
    const b = num(e.text);
    if (a === null || b === null || e.at === null || e.prevAt === null || e.at <= e.prevAt) return null;
    const w = (b - a) / 1e6 / ((e.at - e.prevAt) / 1000);
    return w >= 0 && w < 2000 ? w : null;
  }

  sample(t, procs) {
    const usage = this.clients(t, procs);
    const pct = (u) => (u === null ? null : round(clampPct(u * 100), 0));
    const out = [];
    for (const c of this.cards) {
      const g = usage.get(c.pdev) || usage.get(`driver:${c.driver}`) || null;
      if (g) c.fdinfoSeen = true;
      const entry = {
        id: c.id, name: c.name, vendor: c.vendor, driver: c.driver, node: c.node,
        busy: null, video: null, vramUsedB: null, vramTotalB: c.vramTotalB, clockMHz: null, tempC: null, powerW: null,
        clients: null, integrated: Boolean(c.integrated), powerSource: null
      };
      // no client of ours: idle for us; a client seen for the first time: not known yet.
      // Until this kernel's fdinfo has been seen to report clients, a GPU open
      // by ffmpeg is unknown (kernels before 5.19 report none); with no GPU
      // open by any of the app's processes, it is idle for us all the same
      // (right after a start, before the first conversion).
      if (c.fdinfoSeen || (!this.drmOpen && (c.kind === 'amd' || c.kind === 'intel'))) {
        const known = !g || g.measured;
        entry.video = known ? (g ? pct(groupMax(g.engines, VIDEO_ENGINE)) ?? 0 : 0) : null;
        if (c.kind !== 'amd') entry.busy = known ? (g ? pct(groupMax(g.engines, RENDER_ENGINE)) ?? 0 : 0) : null;
        entry.clients = g ? g.pids.size : 0;
      }
      // Every clip starts a new ffmpeg, whose first reading cannot be measured
      // yet: the last known numbers stand in for up to 10 s, so the tiles do
      // not blink to unknown at each clip.
      for (const k of ['video', 'busy']) {
        if (entry[k] === null && c.held?.[k] && t - c.held[k].at < 10000) entry[k] = c.held[k].v;
        else if (entry[k] !== null) (c.held ||= {})[k] = { v: entry[k], at: t };
      }
      // asking a sleeping GPU anything wakes it up (and costs power)
      if (readLine(c.runtime) === 'suspended') {
        if (c.kind !== 'other') {
          entry.busy = 0;
          entry.video = entry.video ?? 0;
        }
        out.push(entry);
        continue;
      }
      if (c.kind === 'amd') {
        entry.busy = num(this.reads.text(c.busyFile, 0, 10000));
        entry.vramUsedB = num(this.reads.text(c.vramUsedFile, 0, 10000));
        entry.clockMHz = currentClock(this.reads.text(c.sclkFile, 0, 10000));
        const uw = c.powerFile ? num(this.reads.text(c.powerFile, 0, 10000)) : null;
        if (uw !== null && uw >= 0) entry.powerW = round(uw / 1e6, 1);
      } else if (c.kind === 'intel') {
        if (c.freqFile) entry.clockMHz = num(this.reads.text(c.freqFile, 0, 10000));
        if (c.energyFile) entry.powerW = round(this.watts(c.energyFile), 1);
      }
      if (c.tempFile) {
        const mc = num(this.reads.text(c.tempFile, 0, 10000));
        entry.tempC = mc !== null && mc > -30000 && mc < 150000 ? round(mc / 1000, 1) : null;
      }
      if (entry.powerW !== null) entry.powerSource = 'hwmon';
      out.push(entry);
    }
    if (this.hasNvidia) out.push(...this.nvidia.read());
    return out;
  }

  startStreams() {
    if (this.hasNvidia) this.nvidia.start();
  }

  stopStreams() {
    this.nvidia.stop();
  }
}

module.exports = { GpuProvider, NvidiaSmi, gpuDisplayName, parseFdinfo, engineUse, parseNvidiaLine, lookupPciIds, currentClock, VIDEO_ENGINE, RENDER_ENGINE, NVIDIA_QUERY };
