'use strict';

// Whole disks: read/write bytes per second and how busy they are from
// /proc/diskstats deltas, model and kind from /sys/block, temperature from
// the disk's own sensor (drivetemp / nvme hwmon, see sensors.js), and the
// I/O errors the kernel counted on it since this app started
// (device/ioerr_cnt, SATA and SAS disks).
//
// That counter is not SMART and not only failed reads and writes: it counts
// every command the disk ended with an error, including harmless ones, such
// as a SMART or power query the disk does not support (the NAS's own SMART
// polling, one disk at a time, every 30 minutes or so), a command sent while
// it sleeps, a bus reset. So a disk's errors count as its own (ioErrors) only
// when they come while the app is watching and the disk is moving data in
// that same moment: such queries are not counted as reads or writes in
// /proc/diskstats, a failing read or write is. Everything else (no traffic,
// came while nobody watched, across a stall, or on most disks in the same
// moment) is counted apart (ioErrorsShared). ioErrorsRecent is the disk's own
// in the last 10 minutes, which the alert uses: a failing disk errs in
// bursts, retries included. Full SMART needs root and the raw disk, which this
// container does not have; the NAS itself checks SMART.

const { readText, readLine, readNum, listDir, round, clampPct, join } = require('./util');

// virtual or derived devices: their I/O is already counted on the real disks
const SKIP = /^(loop|ram|zram|dm-|md|nbd|sr|fd|zd|rbd|drbd|bcache)/;
const SECTOR = 512; // diskstats always counts 512-byte sectors

function parseDiskstats(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const v = f.slice(3).map(Number);
    if (v.slice(0, 10).some((n) => !Number.isFinite(n))) continue;
    out.set(f[2], { read: v[2] * SECTOR, write: v[6] * SECTOR, ioMs: v[9] });
  }
  return out;
}

function kindOf(name, rotational) {
  if (name.startsWith('nvme')) return 'nvme';
  if (/^(vd|xvd|mmcblk|mtdblock)/.test(name)) return 'other';
  if (rotational === 1) return 'hdd';
  if (rotational === 0) return 'ssd';
  return 'other';
}

class DisksProvider {
  constructor({ procRoot, sysRoot, now, sensors }) {
    this.procRoot = procRoot;
    this.sysRoot = sysRoot;
    this.now = now;
    this.sensors = sensors;
    this.disks = new Map();
    this.prev = null;
    this.prevAt = null;
    this.errBase = new Map(); // disk -> its error count when first read
    this.errLast = new Map(); // disk -> its count since start at the last sample
    this.errShared = new Map(); // disk -> errors that are not the disk's own (see the top)
    this.errOwn = new Map(); // disk -> its own errors since start
    this.errRecent = new Map(); // disk -> [{ at, n }] of its own, the last RECENT_MS
  }

  /** I/O errors on the disk since this app started (null: not counted). */
  errorsSince(name) {
    const raw = readLine(join(this.sysRoot, 'block', name, 'device', 'ioerr_cnt'));
    if (!raw) return null;
    const n = Number.parseInt(raw, raw.startsWith('0x') ? 16 : 10);
    if (!Number.isFinite(n)) return null;
    if (!this.errBase.has(name)) this.errBase.set(name, n);
    return Math.max(0, n - this.errBase.get(name));
  }

  /**
   * Sampling stopped (nobody watching) and starts again later: the next
   * sample has nothing to diff against, so the idle stretch is neither a
   * rate averaged over hours nor taken for a stall. The error counts stay:
   * errors that came while nobody watched still count as the disk's own,
   * unless most disks rose together.
   */
  resetBaseline() {
    this.prev = null;
    this.prevAt = null;
  }

  probe() {
    this.disks = new Map();
    for (const name of listDir(join(this.sysRoot, 'block')).sort()) {
      if (SKIP.test(name)) continue;
      const dir = join(this.sysRoot, 'block', name);
      // empty card readers and drives without a medium report size 0
      if (readNum(join(dir, 'size')) === 0) continue;
      const model = readLine(join(dir, 'device', 'model')) || readLine(join(dir, 'device', 'name'));
      this.disks.set(name, { name, model, kind: kindOf(name, readNum(join(dir, 'queue', 'rotational'))) });
    }
  }

  sample() {
    const t = this.now();
    const stats = parseDiskstats(readText(join(this.procRoot, 'diskstats')));
    const dt = this.prevAt === null ? 0 : (t - this.prevAt) / 1000;
    const out = [];
    for (const d of this.disks.values()) {
      const cur = stats.get(d.name);
      const before = this.prev?.get(d.name);
      let readBps = null;
      let writeBps = null;
      let busy = null;
      // a counter that went back (device re-added) gives no rate this time
      if (cur && before && dt > 0 && cur.read >= before.read && cur.write >= before.write) {
        readBps = Math.round((cur.read - before.read) / dt);
        writeBps = Math.round((cur.write - before.write) / dt);
        if (cur.ioMs >= before.ioMs) busy = round(clampPct((cur.ioMs - before.ioMs) / (dt * 10)), 0);
      }
      out.push({ name: d.name, model: d.model, readBps, writeBps, tempC: this.sensors.diskTemp(d.name), kind: d.kind, busy });
    }
    this.splitErrors(out, dt, t);
    if (stats.size) {
      this.prev = stats;
      this.prevAt = t;
    }
    return out;
  }
}

/** Disks a stall is judged by: a sample this long after the last one means the server was frozen. */
const STALL_S = 60;
/** How far back ioErrorsRecent looks. */
const RECENT_MS = 10 * 60 * 1000;

DisksProvider.prototype.splitErrors = function splitErrors(out, dt, t) {
  const counted = [];
  for (const d of out) {
    const total = this.errorsSince(d.name);
    if (total === null) continue;
    const before = this.errLast.get(d.name);
    this.errLast.set(d.name, total);
    counted.push({ d, total, rise: before === undefined ? 0 : Math.max(0, total - before) });
  }
  const rising = counted.filter((x) => x.rise > 0);
  // the same moment on most disks (two or more, at least half of them), or a stall: not one disk's fault
  const shared = (rising.length >= 2 && rising.length * 2 >= counted.length) || (rising.length > 0 && dt > STALL_S);
  for (const x of counted) {
    // moving data in this same moment (a rate is known: not the first sample after idle)
    const inUse = x.d.readBps > 0 || x.d.writeBps > 0;
    if (x.rise) {
      if (shared || !inUse) this.errShared.set(x.d.name, (this.errShared.get(x.d.name) || 0) + x.rise);
      else {
        this.errOwn.set(x.d.name, (this.errOwn.get(x.d.name) || 0) + x.rise);
        const list = this.errRecent.get(x.d.name) || [];
        list.push({ at: t, n: x.rise });
        this.errRecent.set(x.d.name, list);
      }
    }
    const recent = (this.errRecent.get(x.d.name) || []).filter((e) => t - e.at < RECENT_MS);
    this.errRecent.set(x.d.name, recent);
    x.d.ioErrors = this.errOwn.get(x.d.name) || 0;
    x.d.ioErrorsRecent = recent.reduce((a, e) => a + e.n, 0);
    const sharedN = this.errShared.get(x.d.name) || 0;
    if (sharedN) x.d.ioErrorsShared = sharedN;
  }
};

module.exports = { DisksProvider, parseDiskstats, kindOf, RECENT_MS };
