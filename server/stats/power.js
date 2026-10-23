'use strict';

// Power in watts. The CPU package comes from the RAPL energy counters: read
// here when the app may read them, otherwise sent by the root supervisor
// (setRapl), since kernels after 5.10 let only root read them. The GPUs
// report their own (gpu.js). W = energy used / time between two readings,
// across the counter's wrap-around. A server with two CPU sockets has a
// package zone per socket: summed for the CPU, and also shown per socket.

const { readLine, readNum, listDir, round, sumOf, join } = require('./util');

const RAPL_ZONE = /^intel-rapl:\d+$/; // top-level zones only; intel-rapl:0:0 etc. are parts of a package
const PACKAGE = /^package/;

/** µJ used between two readings of a counter that wraps after maxUj. */
function energyDelta(prevUj, curUj, maxUj) {
  if (!Number.isFinite(prevUj) || !Number.isFinite(curUj) || prevUj < 0 || curUj < 0) return null;
  let d = curUj - prevUj;
  if (d < 0) {
    if (!(maxUj > 0) || prevUj > maxUj) return null;
    d += maxUj;
  }
  return d;
}

/**
 * Watts of each package zone between two readings ({ at, packages: [{ name,
 * energyUj, maxEnergyUj }] }), as [{ name, w }], or null. Longer than a
 * minute apart, a counter could have wrapped more than once, so that is no
 * answer.
 */
function zoneWatts(prev, cur) {
  if (!prev || !cur) return null;
  const dt = (cur.at - prev.at) / 1000;
  if (!(dt > 0) || dt > 60) return null;
  const out = [];
  for (const p of cur.packages) {
    if (!PACKAGE.test(p.name)) continue;
    const before = prev.packages.find((x) => x.name === p.name);
    if (!before) continue;
    const d = energyDelta(before.energyUj, p.energyUj, p.maxEnergyUj || before.maxEnergyUj);
    if (d === null) continue;
    out.push({ name: p.name, w: d / 1e6 / dt });
  }
  return out;
}

/** CPU package watts between two readings: every package (socket) together. */
function packageWatts(prev, cur) {
  const zones = zoneWatts(prev, cur);
  if (!zones) return null;
  let total = null;
  for (const { w } of zones) {
    if (w > 1000) return null; // not a real reading
    total = (total || 0) + w;
  }
  return total;
}

/** W per socket: "package-1" is socket 1 (with its dies, "package-1-die-0", together). */
function socketWatts(prev, cur) {
  const out = new Map();
  if (packageWatts(prev, cur) === null) return out;
  for (const { name, w } of zoneWatts(prev, cur)) {
    const m = /^package-(\d+)(?:-die-\d+)?$/.exec(name);
    if (m) out.set(Number(m[1]), (out.get(Number(m[1])) || 0) + w);
  }
  return out;
}

function cleanReading(reading) {
  if (!reading || !Number.isFinite(Number(reading.at)) || !Array.isArray(reading.packages)) return null;
  const packages = reading.packages.slice(0, 16).map((p) => ({
    name: String(p?.name ?? ''), energyUj: Number(p?.energyUj), maxEnergyUj: Number(p?.maxEnergyUj) || null
  })).filter((p) => Number.isFinite(p.energyUj));
  return packages.length ? { at: Number(reading.at), packages } : null;
}

class PowerProvider {
  constructor({ sysRoot, now, intervalMs }) {
    this.sysRoot = sysRoot;
    this.now = now;
    this.intervalMs = intervalMs;
    this.zones = [];
    this.direct = false;
    this.readings = { prev: null, cur: null }; // read here
    this.sent = { prev: null, cur: null }; // from the supervisor
    this.used = { prev: null, cur: null }; // the two readings the last cpu() answer came from
  }

  probe() {
    const dir = join(this.sysRoot, 'class', 'powercap');
    this.zones = listDir(dir).filter((n) => RAPL_ZONE.test(n)).sort().map((z) => ({
      name: readLine(join(dir, z, 'name')) || z,
      energy: join(dir, z, 'energy_uj'),
      max: readNum(join(dir, z, 'max_energy_range_uj'))
    })).filter((z) => PACKAGE.test(z.name));
    this.direct = this.zones.length > 0 && this.zones.every((z) => readNum(z.energy) !== null);
  }

  /** The supervisor's latest reading. */
  setRapl(reading) {
    const r = cleanReading(reading);
    if (!r) return;
    if (this.sent.cur && r.at <= this.sent.cur.at) return;
    this.sent = { prev: this.sent.cur, cur: r };
  }

  /** CPU package W, or null; also says whether any RAPL source answers. */
  cpu(t) {
    if (this.direct) {
      const r = { at: t, packages: this.zones.map((z) => ({ name: z.name, energyUj: readNum(z.energy), maxEnergyUj: z.max })) };
      if (r.packages.every((p) => p.energyUj !== null)) this.readings = { prev: this.readings.cur, cur: r };
      this.used = this.readings;
      return packageWatts(this.readings.prev, this.readings.cur);
    }
    const { prev, cur } = this.sent;
    if (!cur || t - cur.at > Math.max(3 * this.intervalMs, 10000)) {
      this.used = { prev: null, cur: null };
      return null;
    }
    this.used = this.sent;
    return packageWatts(prev, cur);
  }

  /** W per socket (Map physical id -> W) from the readings of the last sample. */
  socketWatts() {
    return socketWatts(this.used.prev, this.used.cur);
  }

  hasRapl(t) {
    return this.direct || Boolean(this.sent.cur && t - this.sent.cur.at < 60000);
  }

  sample(t, gpus) {
    const cpuW = this.cpu(t);
    const withPower = gpus.filter((g) => g.powerW !== null && g.powerW !== undefined);
    const gpuW = sumOf(withPower.map((g) => g.powerW));
    // An AMD APU's reading is the whole chip, CPU included: adding it to the
    // CPU package would count the CPU twice.
    const discrete = sumOf(withPower.filter((g) => !g.integrated).map((g) => g.powerW));
    const integrated = sumOf(withPower.filter((g) => g.integrated).map((g) => g.powerW));
    // the whole chip (CPU and built-in GPU): the larger of the two readings
    const chipW = integrated !== null ? Math.max(integrated, cpuW ?? 0) : null;
    let totalW = null;
    if (chipW !== null) totalW = chipW + (discrete || 0);
    else if (cpuW !== null) totalW = cpuW + (discrete || 0);
    else if (gpuW !== null) totalW = gpuW;
    return {
      totalW: round(totalW, 1), cpuW: round(cpuW, 1), gpuW: round(gpuW, 1),
      // with a built-in GPU: one figure for the chip, the other GPUs apart
      chipW: round(chipW, 1), discreteW: chipW !== null ? round(discrete, 1) : null,
      cpuSource: cpuW !== null ? 'rapl' : null,
      gpuSource: withPower[0]?.powerSource || null
    };
  }
}

module.exports = { PowerProvider, energyDelta, packageWatts, socketWatts, cleanReading };
