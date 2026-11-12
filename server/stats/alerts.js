'use strict';

// Alerts with hysteresis: a condition must hold for 30 s before it is raised,
// and it clears only once the value is back below a lower mark (5 °C or 2 %
// under) for 30 s, so a value hovering at the line does not flap. Each raise
// is passed to onAlert once; the server turns it into a Notification and a
// log line.

const { round } = require('./util');

const HOLD_MS = 30000;
const DISK_LIMIT = { nvme: 70, ssd: 70, hdd: 55, other: 70 };
const DISK_KIND = { nvme: 'NVMe disk', ssd: 'SSD', hdd: 'Hard disk', other: 'Disk' };

const pctUsed = (fs) => {
  if (!fs || !(fs.totalB > 0) || fs.usedB === null || fs.usedB === undefined) return null;
  // like df: used / (used + available), so the reserve for root counts as full
  const avail = Number.isFinite(fs.freeB) ? fs.freeB : fs.totalB - fs.usedB;
  return (fs.usedB / Math.max(1, fs.usedB + avail)) * 100;
};

/**
 * The rules, from one snapshot body: [{ key, level, value, raise, clear,
 * above, message }]. `above` rules raise at value >= raise and clear below
 * `clear`; the others raise at value <= raise and clear above `clear`.
 */
function rules(body) {
  const out = [];
  const cpuT = body.cpu?.tempC ?? null;
  out.push({ key: 'cpu-temp', level: 'warn', value: cpuT, raise: 90, clear: 85, above: true, message: () => `CPU at ${round(cpuT, 0)} °C` });
  out.push({
    key: 'cpu-throttle', level: 'warn', value: body.cpu ? (body.cpu.throttling ? 1 : 0) : null, raise: 1, clear: 1, above: true,
    message: () => 'The CPU is slowing itself down to stay cool (thermal throttling)'
  });
  for (const g of body.gpus || []) {
    out.push({ key: `gpu-temp:${g.id}`, level: 'warn', value: g.tempC, raise: 90, clear: 85, above: true, message: () => `${g.name || 'GPU'} at ${round(g.tempC, 0)} °C` });
  }
  for (const d of body.disks || []) {
    const limit = DISK_LIMIT[d.kind] || DISK_LIMIT.other;
    out.push({
      key: `disk-temp:${d.name}`, level: 'warn', value: d.tempC, raise: limit, clear: limit - 5, above: true,
      message: () => `${DISK_KIND[d.kind] || 'Disk'} ${d.name} at ${round(d.tempC, 0)} °C`
    });
  }
  for (const f of body.filesystems || []) {
    // a vehicle's share already has its own notifications for full and offline
    if (!f.vehicle) {
      const pct = pctUsed(f);
      out.push({ key: `fs-full:${f.label}`, level: 'warn', value: pct, raise: 90, clear: 88, above: true, message: () => `${f.label} is ${round(pct, 0)}% full` });
      out.push({
        key: `share-down:${f.label}`, level: 'error', value: f.reachable === false ? 1 : f.reachable === true ? 0 : null, raise: 1, clear: 1, above: true,
        message: () => `${f.label} is not reachable`
      });
    }
    out.push({
      key: `share-slow:${f.label}`, level: 'warn', value: f.reachable === false ? null : f.latencyMs, raise: 2000.001, clear: 1500, above: true,
      message: () => `${f.label} answers slowly (${round(f.latencyMs / 1000, 1)} s)`
    });
  }
  const m = body.memory;
  const availPct = m && m.totalB > 0 && m.availableB !== null ? (m.availableB / m.totalB) * 100 : null;
  out.push({ key: 'memory-low', level: 'warn', value: availPct, raise: 5, clear: 7, above: false, message: () => `Memory almost full: ${round(availPct, 1)}% available` });
  return out;
}

class Alerts {
  constructor({ onAlert, onAlertClear, log } = {}) {
    this.onAlert = onAlert;
    this.onAlertClear = onAlertClear;
    this.log = log;
    this.state = new Map(); // key -> { raised, since, message, level }
  }

  call(fn, arg) {
    if (typeof fn !== 'function') return;
    try {
      fn(arg);
    } catch (err) {
      this.log?.warn(`Alert handler failed: ${err.message}`);
    }
  }

  /** Evaluate at time t; returns the raised alerts [{ key, level, message }]. */
  evaluate(t, body) {
    const seen = new Set();
    for (const r of rules(body)) {
      seen.add(r.key);
      let s = this.state.get(r.key);
      if (!s) {
        s = { raised: false, since: null, message: null, level: r.level };
        this.state.set(r.key, s);
      }
      if (r.value === null || r.value === undefined || !Number.isFinite(r.value)) {
        // unknown this time: neither raises nor clears, and breaks a hold
        s.since = null;
        continue;
      }
      const over = r.above ? r.value >= r.raise : r.value <= r.raise;
      const under = r.above ? r.value < r.clear : r.value > r.clear;
      if (!s.raised) {
        if (!over) s.since = null;
        else if (s.since === null) s.since = t;
        if (over && t - s.since >= HOLD_MS) {
          s.raised = true;
          s.since = null;
          s.level = r.level;
          s.message = r.message();
          this.call(this.onAlert, { key: r.key, level: r.level, message: s.message });
        }
      } else {
        s.message = over ? r.message() : s.message;
        if (!under) s.since = null;
        else if (s.since === null) s.since = t;
        if (under && t - s.since >= HOLD_MS) {
          s.raised = false;
          s.since = null;
          this.call(this.onAlertClear, { key: r.key });
        }
      }
    }
    // a disk, GPU or share that is gone takes its alert with it
    for (const [key, s] of this.state) {
      if (seen.has(key)) continue;
      if (s.raised) this.call(this.onAlertClear, { key });
      this.state.delete(key);
    }
    return this.list();
  }

  list() {
    const out = [];
    for (const [key, s] of this.state) if (s.raised) out.push({ key, level: s.level, message: s.message });
    return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  }
}

module.exports = { Alerts, rules, HOLD_MS };
