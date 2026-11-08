'use strict';

// Whole disks: read/write bytes per second and how busy they are from
// /proc/diskstats deltas, model and kind from /sys/block, temperature from
// the disk's own sensor (drivetemp / nvme hwmon, see sensors.js), and the
// I/O errors the kernel counted on it since this app started
// (device/ioerr_cnt, SATA and SAS disks): errors that keep coming are an
// early sign of a failing disk. Errors that reach most disks in the same
// moment, or arrive across a stall (the server frozen for a while), are the
// controller's or the whole server's (commands timed out while everything
// waited, a bus reset, the NAS's own SMART polling): they are counted apart
// (ioErrorsShared) and are not the disk's own. Full SMART needs root and the raw disk,
// which this container does not have; the NAS itself checks SMART.

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
    this.errShared = new Map(); // disk -> errors that came with most disks at once, or across a stall
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
    this.splitErrors(out, dt);
    if (stats.size) {
      this.prev = stats;
      this.prevAt = t;
    }
    return out;
  }
}

/** Disks a stall is judged by: a sample this long after the last one means the server was frozen. */
const STALL_S = 60;

DisksProvider.prototype.splitErrors = function splitErrors(out, dt) {
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
    if (shared && x.rise) this.errShared.set(x.d.name, (this.errShared.get(x.d.name) || 0) + x.rise);
    const sharedN = Math.min(x.total, this.errShared.get(x.d.name) || 0);
    x.d.ioErrors = x.total - sharedN;
    if (sharedN) x.d.ioErrorsShared = sharedN;
  }
};

module.exports = { DisksProvider, parseDiskstats, kindOf };
