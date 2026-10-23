'use strict';

// Small readers shared by the stats providers. Every read answers null (or
// an empty list) instead of throwing: a file that is missing, unreadable or
// odd on this machine only means that number is not shown.

const fs = require('fs');
const path = require('path');

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** First line, trimmed (sysfs attributes are one line). */
function readLine(file) {
  const text = readText(file);
  if (text === null) return null;
  const line = text.split('\n', 1)[0].trim();
  return line || null;
}

function toNum(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const readNum = (file) => toNum(readLine(file));

function listDir(dir, max = 4096) {
  try {
    const names = fs.readdirSync(dir);
    return names.length > max ? names.slice(0, max) : names;
  } catch {
    return [];
  }
}

function readLink(p) {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

function realPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** `Key: 123 kB` lines (/proc/meminfo, /proc/<pid>/status) as numbers in their own unit. */
function parseKeyValues(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^([\w()]+):\s*(-?\d+)/.exec(line);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** `key=value` lines (uevent). */
function parseUevent(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function round(n, digits = 1) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

const clampPct = (n) => (n === null || !Number.isFinite(n) ? null : Math.min(100, Math.max(0, n)));

function maxOf(values) {
  let best = null;
  for (const v of values) if (v !== null && v !== undefined && Number.isFinite(v) && (best === null || v > best)) best = v;
  return best;
}

function sumOf(values) {
  let total = null;
  for (const v of values) if (v !== null && v !== undefined && Number.isFinite(v)) total = (total || 0) + v;
  return total;
}

/**
 * Reads that may be slow because they ask a device: a disk's or a GPU's
 * sensor, an ACPI thermal zone. They run off the main thread, at most one at
 * a time per file and at most `limit` at once, and a sample uses the last
 * answer. A disk that takes seconds to answer (spinning up, failing) only
 * makes its own number late, never the web server; even several hung
 * sensors hold at most `limit` of libuv's threads.
 */
class BackgroundReads {
  constructor({ now, readFile = fs.promises.readFile, limit = 4 }) {
    this.now = now;
    this.readFile = readFile;
    this.limit = limit;
    this.entries = new Map();
    this.queue = [];
    this.running = 0;
    this.waiters = [];
  }

  /**
   * The last answer for `file` ({ text, at, prevText, prevAt }), refreshed in
   * the background when it is older than `everyMs`. `at` is when the read
   * started, so counters (energy) are divided by the right interval.
   */
  get(file, everyMs = 0) {
    let e = this.entries.get(file);
    if (!e) {
      e = { text: null, at: null, prevText: null, prevAt: null, busy: false, startedAt: null, wantedAt: 0 };
      this.entries.set(file, e);
    }
    const t = this.now();
    e.wantedAt = t;
    if (!e.busy && (e.at === null || t - e.at >= everyMs)) {
      e.busy = true;
      this.queue.push([file, e]);
      this.pump();
    }
    return e;
  }

  /** Text of the last answer, or null when there is none younger than `maxAgeMs`. */
  text(file, everyMs = 0, maxAgeMs = 60000) {
    const e = this.get(file, everyMs);
    return e.at !== null && this.now() - e.at <= maxAgeMs ? e.text : null;
  }

  pump() {
    while (this.running < this.limit && this.queue.length) {
      const [file, e] = this.queue.shift();
      this.running++;
      e.startedAt = this.now();
      let read;
      try {
        read = Promise.resolve(this.readFile(file, 'utf8'));
      } catch {
        read = Promise.resolve(null);
      }
      read.then((text) => text, () => null).then((text) => {
        e.prevText = e.text;
        e.prevAt = e.at;
        e.text = typeof text === 'string' ? text : null;
        e.at = e.startedAt;
        e.busy = false;
        this.running--;
        this.pump();
        if (!this.running && !this.queue.length) for (const done of this.waiters.splice(0)) done();
      });
    }
  }

  /** Resolves once no read is queued or in flight (tests, and a clean stop). */
  idle() {
    return this.running || this.queue.length ? new Promise((resolve) => this.waiters.push(resolve)) : Promise.resolve();
  }

  /** Forget files nobody asked for since `before` (a GPU or disk that went away). */
  prune(before) {
    for (const [file, e] of this.entries) if (!e.busy && e.wantedAt < before) this.entries.delete(file);
  }
}

const num = (text) => toNum(text === null || text === undefined ? null : String(text).split('\n', 1)[0]);

module.exports = {
  readText, readLine, readNum, toNum, num, listDir, readLink, realPath, exists,
  parseKeyValues, parseUevent, round, clampPct, maxOf, sumOf, BackgroundReads, join: path.join
};
