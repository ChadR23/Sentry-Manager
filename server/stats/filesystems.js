'use strict';

// Space and answer time of the footage shares and the data folder. A share
// that hangs must never hold up the server: checks are asynchronous, one at
// a time per share, at most every 10 s. A check that has not answered after
// 2 s shows as slow (its time keeps growing), after 15 s as unreachable.
// A network share that is not mounted is only an empty folder on the
// server's own disk: it shows as not connected, never with that disk's space
// and answer time.

const path = require('path');
const { readText, realPath, exists, join } = require('./util');

const CHECK_EVERY_MS = 10000;
const UNREACHABLE_MS = 15000;
const MOUNTS_EVERY_MS = 60000;

const unescapeMount = (p) => p.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));

/** /proc/<pid>/mountinfo lines. */
function parseMountinfo(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const left = line.slice(0, sep).split(' ');
    const right = line.slice(sep + 3).split(' ');
    if (left.length < 5 || right.length < 2) continue;
    out.push({ majmin: left[2], mountPoint: unescapeMount(left[4]), fsType: right[0], source: unescapeMount(right[1]), superOpts: right[2] || '' });
  }
  return out;
}

/** The mount a path lives on: the deepest mount point above it (the last one wins when stacked). */
function mountFor(mounts, p) {
  let best = null;
  for (const m of mounts) {
    const mp = m.mountPoint;
    const inside = p === mp || mp === '/' || p.startsWith(mp.endsWith('/') ? mp : `${mp}/`);
    if (inside && (!best || mp.length >= best.mountPoint.length)) best = m;
  }
  return best;
}

class FilesystemsProvider {
  constructor({ procRoot, sysRoot, appPid, readShares, fsp, now, log }) {
    this.procRoot = procRoot;
    this.sysRoot = sysRoot;
    this.appPid = appPid;
    this.readShares = readShares;
    this.fsp = fsp;
    this.now = now;
    this.log = log;
    this.shares = new Map(); // path -> state
    this.listedAt = null;
    this.mounts = [];
    this.mountsAt = null;
  }

  /** The whole disk behind a block device number ("259:2" -> "nvme0n1"). */
  diskOf(majmin) {
    if (!majmin || majmin.startsWith('0:')) return null; // network and virtual filesystems
    const real = realPath(join(this.sysRoot, 'dev', 'block', majmin));
    if (!real) return null;
    return exists(join(real, 'partition')) ? path.basename(path.dirname(real)) : path.basename(real);
  }

  refreshList(t) {
    let list = [];
    try {
      list = this.readShares() || [];
    } catch (err) {
      this.log?.warn(`Could not list the shares for the stats: ${err.message}`);
    }
    const next = new Map();
    for (const s of Array.isArray(list) ? list.slice(0, 32) : []) {
      if (!s || typeof s.path !== 'string' || !path.isAbsolute(s.path)) continue;
      const p = path.resolve(s.path);
      const label = String(s.label || p).slice(0, 100);
      const state = this.shares.get(p) || {
        path: p, totalB: null, usedB: null, freeB: null, latencyMs: null, reachable: null, pendingSince: null, lastCheck: null
      };
      state.label = label;
      state.vehicle = s.vehicle === true;
      state.network = s.network === true;
      next.set(p, state);
    }
    const changed = [...next.keys()].join('\n') !== [...this.shares.keys()].join('\n');
    this.shares = next;
    this.listedAt = t;
    // with a network share, at every check: a share mounted or lost shows within 10 s
    const every = [...this.shares.values()].some((s) => s.network) ? CHECK_EVERY_MS : MOUNTS_EVERY_MS;
    if (changed || this.mountsAt === null || t - this.mountsAt >= every) {
      this.mounts = parseMountinfo(readText(join(this.procRoot, String(this.appPid), 'mountinfo')));
      this.mountsAt = t;
      for (const s of this.shares.values()) {
        const m = mountFor(this.mounts, s.path);
        s.fsType = m?.fsType || null;
        s.source = m && m.source !== 'none' ? m.source : null;
        s.disk = m ? this.diskOf(m.majmin) : null;
        s.smbVersion = m && /^(cifs|smb3)$/.test(m.fsType) ? (/(?:^|,)vers=([\d.]+)/.exec(m.superOpts) || [])[1] || null : null;
        const mounted = s.network ? Boolean(m && /^(cifs|smb3)$/.test(m.fsType)) : null;
        // not mounted (any more): nothing measured so far is the share's
        if (mounted === false && s.mounted !== false) Object.assign(s, { totalB: null, usedB: null, freeB: null, latencyMs: null, reachable: false });
        s.mounted = mounted;
      }
    }
  }

  check(s) {
    if (s.mounted === false) {
      s.lastCheck = this.now();
      return;
    }
    s.pendingSince = this.now();
    const target = s.path;
    (async () => {
      const t0 = this.now();
      await this.fsp.stat(target);
      const latency = this.now() - t0;
      let sfs = null;
      try {
        if (typeof this.fsp.statfs === 'function') sfs = await this.fsp.statfs(target);
      } catch {
        sfs = null;
      }
      return { latency, sfs };
    })().then(({ latency, sfs }) => {
      if (s.mounted === false) return; // lost while checking: the folder under it answered
      s.reachable = true;
      s.latencyMs = Math.max(0, Math.round(latency));
      if (sfs) {
        const bs = Number(sfs.bsize);
        const blocks = Number(sfs.blocks);
        if (bs > 0 && blocks > 0) {
          s.totalB = blocks * bs;
          s.usedB = Math.max(0, blocks - Number(sfs.bfree)) * bs;
          s.freeB = Number(sfs.bavail) * bs;
        }
      }
    }, () => {
      s.reachable = false;
      s.latencyMs = null;
    }).finally(() => {
      s.pendingSince = null;
      s.lastCheck = this.now();
    });
  }

  sample(t) {
    if (this.listedAt === null || t - this.listedAt >= CHECK_EVERY_MS) this.refreshList(t);
    const out = [];
    for (const s of this.shares.values()) {
      if (s.pendingSince === null && (s.lastCheck === null || t - s.lastCheck >= CHECK_EVERY_MS)) this.check(s);
      let { latencyMs, reachable } = s;
      if (s.pendingSince !== null) {
        const waited = t - s.pendingSince;
        if (waited > 2000) latencyMs = Math.max(latencyMs || 0, Math.round(waited));
        if (waited > UNREACHABLE_MS) reachable = false;
      }
      out.push({
        label: s.label, path: s.path, vehicle: s.vehicle === true, totalB: s.totalB, usedB: s.usedB, freeB: s.freeB, latencyMs, reachable,
        fsType: s.fsType || null, source: s.source || null, disk: s.disk || null, smbVersion: s.smbVersion || null,
        mounted: s.mounted ?? null
      });
    }
    return out;
  }
}

module.exports = { FilesystemsProvider, parseMountinfo, mountFor };
