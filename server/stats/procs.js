'use strict';

// One pass over /proc/<pid>/stat per sample: every visible process with its
// parent, CPU ticks and memory, and which of them are this app and its
// children (ffmpeg). CPU % comes from tick deltas between passes, keyed by
// pid and start time so a reused pid never borrows another process's ticks.
// A pass is ~0.4 ms for 100 processes, a few ms with `pid: host`.

const { readText, readLine, listDir, parseKeyValues, join } = require('./util');

/** Fields of /proc/<pid>/stat; the name sits in parentheses and may hold spaces or ')'. */
function parseStat(text) {
  if (!text) return null;
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 1 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const rest = text.slice(close + 2).trim().split(/\s+/);
  // rest[0] is field 3 (state); field N is rest[N - 3]
  if (!Number.isInteger(pid) || rest.length < 22) return null;
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const start = Number(rest[19]);
  const rssPages = Number(rest[21]);
  if (![ppid, utime, stime, start].every(Number.isFinite)) return null;
  return { pid, comm: text.slice(open + 1, close), state: rest[0], ppid, ticks: utime + stime, start, rssPages: Number.isFinite(rssPages) ? rssPages : 0 };
}

/** First number of /proc/uptime, in seconds. */
function readUptime(procRoot) {
  const n = Number(String(readLine(join(procRoot, 'uptime')) || '').split(/\s+/)[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const HZ = 100; // USER_HZ: the unit of /proc tick counters on every Linux architecture

class ProcessTable {
  constructor({ procRoot, appPid }) {
    this.procRoot = procRoot;
    this.appPid = appPid;
    this.prev = new Map(); // `${pid}:${start}` -> ticks
    this.prevUptime = null;
    this.pageSize = null;
    this.scope = 'container';
    this.list = [];
    this.byPid = new Map();
    this.app = new Set();
  }

  probe() {
    // With `pid: host` the first process is the host's init, in another cgroup
    // than the app; in the container's own pid namespace it is our tini.
    const a = readText(join(this.procRoot, '1', 'cgroup'));
    const b = readText(join(this.procRoot, String(this.appPid), 'cgroup'));
    this.scope = a !== null && b !== null && a.trim() !== b.trim() ? 'host' : 'container';
    this.pageSize = this.detectPageSize();
  }

  // stat counts memory in pages (4 KiB on x86, 16 or 64 KiB on some ARM
  // kernels); status says kB. The app's own two answers give the page size.
  detectPageSize() {
    const st = parseStat(readText(join(this.procRoot, String(this.appPid), 'stat')));
    const kb = parseKeyValues(readText(join(this.procRoot, String(this.appPid), 'status'))).VmRSS;
    if (st && st.rssPages > 0 && kb > 0) {
      const ratio = (kb * 1024) / st.rssPages;
      for (const size of [4096, 16384, 65536]) if (Math.abs(ratio - size) / size < 0.25) return size;
    }
    return 4096;
  }

  /**
   * Read every process. `totalTicks` is the whole server's CPU time over the
   * same interval (all cores, from /proc/stat); a process's % is its share.
   */
  sample(totalTicks) {
    const uptime = readUptime(this.procRoot);
    const list = [];
    for (const name of listDir(this.procRoot, 100000)) {
      if (!/^\d+$/.test(name)) continue;
      const p = parseStat(readText(join(this.procRoot, name, 'stat')));
      if (p) list.push(p);
    }
    const next = new Map();
    // a process that started after the last pass used all its ticks in this interval
    const bornAfter = this.prevUptime === null ? Infinity : this.prevUptime * HZ;
    for (const p of list) {
      const key = `${p.pid}:${p.start}`;
      next.set(key, p.ticks);
      const before = this.prev.get(key);
      let delta = null;
      if (before !== undefined) delta = Math.max(0, p.ticks - before);
      else if (p.start >= bornAfter) delta = p.ticks;
      p.cpu = delta !== null && totalTicks > 0 ? (delta / totalTicks) * 100 : null;
      p.memB = p.rssPages * (this.pageSize || 4096);
    }
    this.prev = next;
    this.prevUptime = uptime;
    this.uptime = uptime;
    this.list = list;
    this.byPid = new Map(list.map((p) => [p.pid, p]));

    // the app and everything below it (ffmpeg, ffprobe, helpers)
    const children = new Map();
    for (const p of list) {
      if (!children.has(p.ppid)) children.set(p.ppid, []);
      children.get(p.ppid).push(p.pid);
    }
    const app = new Set();
    if (this.byPid.has(this.appPid)) {
      const stack = [this.appPid];
      while (stack.length) {
        const pid = stack.pop();
        if (app.has(pid)) continue;
        app.add(pid);
        for (const c of children.get(pid) || []) stack.push(c);
      }
    }
    this.app = app;
    // status has the exact resident size in kB, whatever the page size
    for (const pid of app) {
      const kb = parseKeyValues(readText(join(this.procRoot, String(pid), 'status'))).VmRSS;
      if (Number.isFinite(kb)) this.byPid.get(pid).memB = kb * 1024;
    }
    return this;
  }

  /** The app's descendants (not the app itself): the processes that may hold a GPU. */
  descendants() {
    return [...this.app].filter((pid) => pid !== this.appPid).map((pid) => this.byPid.get(pid)).filter(Boolean);
  }

  /** When the app started, in seconds since boot (for its uptime). */
  appStartS() {
    const p = this.byPid.get(this.appPid);
    return p ? p.start / HZ : null;
  }
}

module.exports = { ProcessTable, parseStat, readUptime, HZ };
