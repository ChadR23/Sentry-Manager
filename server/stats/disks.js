'use strict';

// Whole disks: read/write bytes per second and how busy they are from
// /proc/diskstats deltas, model and kind from /sys/block, temperature from
// the disk's own sensor (drivetemp / nvme hwmon, see sensors.js).

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
    if (stats.size) {
      this.prev = stats;
      this.prevAt = t;
    }
    return out;
  }
}

module.exports = { DisksProvider, parseDiskstats, kindOf };
