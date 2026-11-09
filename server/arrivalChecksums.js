'use strict';

// The checksum of every clip that reaches a Sentry USB share, in the same
// record the converter writes before an in-place conversion
// (originalChecksums.js; the contract: docs/sentry-usb.md, "Manager's record
// comes first").
//
// Sentry USB verifies each upload from Manager's record first: a clip with a
// line is compared with the Pi's own hash and never read back over the
// network; a clip without one waits up to 24 h for Manager, then the Pi reads
// it back. So every clip that has fully arrived gets a line, converted or not,
// with the SHA-256 of the bytes on the share now. That is the same hash the
// in-place conversion records later (a later line for a path wins, and an
// equal one changes nothing); a damaged upload gets its true, damaged, hash,
// so the Pi sees the mismatch and sends the clip again.
//
// Only shares whose root (the folder holding RecentClips/, as the record)
// has a .sentryusb/ folder: a Sentry USB archives there. Nothing is written
// on any other share.
//
// Which clips: Tesla clips (YYYY-MM-DD_HH-MM-SS-<camera>.mp4) in RecentClips/,
// SentryClips/, SavedClips/ or TeslaTrackMode/, from the inventory's last scan,
// of any age: every clip on the share gets a line (olderOf(vid) false, the
// "Record checksums for older clips" setting off: only the recent window, the
// clip's own time, its modification time or the time it reached the share
// (birth time, else ctime) within WINDOW_DAYS (7)).
//
// Order: newest first, and fresh arrivals never wait behind the old archive.
// Each pass first takes the clips of the recent window (those that arrived or
// were recorded in the last FRESH_MS (48 h) first, then by the clip's own time,
// newest first), for every car, then the older ones (the backlog), newest
// first by the clip's own time. A kick (an inventory scan: new clips) while the
// backlog is being read ends the pass after the current file, and the next one
// starts with the new arrivals.
//
// Skipped:
//   - clips Sentry USB is still copying (its status file's transfer range);
//   - clips a conversion has in hand (busyPaths) and our converter's own
//     working files (TEMP-H265-…, BACKUP-…), dot-named files and folders,
//     *.mismatch-* copies (the scanner and classify() leave those out);
//   - a clip modified in the last SETTLE_MS (still being written);
//   - a clip whose identity (size, mtime, inode) is the one we recorded;
//   - our own in-place conversion's output (onClipConverted: its identity is
//     noted, never hashed: the record's line for it stays the original's);
//   - any other H.265 / AV1 clip (no record of converting it: unknown origin,
//     and its bytes are not what the Pi uploaded).
//
// Cost: one file at a time across all cars, streamed (1 MiB reads), at most
// RATE bytes a second, paused while a conversion or the benchmark runs
// (idle()), at most PER_CYCLE clips a pass (another pass follows shortly when
// more are waiting). After hashing, the file's identity is checked again and
// the result dropped if it changed (the file was replaced mid-hash). Measured:
// SHA-256 with the reads about 1.1 CPU-seconds per GiB, so 64 MiB/s is some 8%
// of one core; a 550 GB archive the first time is about 2.3 h of reading, some
// 3.3 h with the pauses between passes (longer while conversions run).
//
// What was recorded is kept per car, so a clip is never read twice:
// relpath (from the car's folder) -> [size, mtimeMs, ino, at, kind], kind 'h'
// (hashed, a line written), 'c' (our conversion's output), 's' (skipped:
// encoded, not ours). An entry stays as long as its file is in the inventory
// unchanged, however old: the record's lines are pruned after KEEP_DAYS (45)
// by when they were written, and a clip whose line went is not hashed again
// (the Pi needed it within its first day). Entries go only when their file is
// gone from the inventory.
//
// On disk (some 35,000 clips a car, and more): <dir>/<vehicle id>.json, a
// snapshot { v: 2, dirs: { "<folder>": { "<name>": [size, mtimeMs, ino, at, kind] } } },
// and <dir>/<vehicle id>.log, a journal of the changes since, one JSON array a
// line (["<relpath>", size, mtimeMs, ino, at, kind], or ["<relpath>"] for one
// gone). Changes are appended in batches (every SAVE_EVERY clips and at the
// end of a pass); the snapshot is rewritten (temporary file, rename) and the
// journal emptied once the journal is longer than COMPACT_MIN lines and half
// the entries. A torn last journal line (a crash mid-append) is skipped and
// the next save rewrites the snapshot. The v1 file ({ v: 1, files: { rel: [...] } })
// is read and rewritten as v2.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { locate } = require('./originalChecksums');
const { isConverterArtifact } = require('./footage');
const { videoCodec } = require('./mp4codec');

const WINDOW_DAYS = 7;
const FRESH_MS = 48 * 3600_000;
const PER_CYCLE = 300;
const RATE = 64 * 1024 * 1024; // bytes a second
const CHUNK = 1024 * 1024;
const SETTLE_MS = 60_000;
const TIMER_MS = 10 * 60_000;
const NEXT_CYCLE_MS = 30_000; // when a pass stopped at PER_CYCLE
const SAVE_EVERY = 25;
const COMPACT_MIN = 2000;
const DAY_MS = 86_400_000;
const CLIP_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-[a-z0-9_]+\.mp4$/i;
const GROUP_RE = /^(recentclips|sentryclips|savedclips|teslatrackmode)$/i;
const ENCODED = new Set(['h265', 'av1']);
const SENTRY_USB_DIR = '.sentryusb';
// what a clip of the backlog ends as: looked at (a line, ours, encoded, gone) or failed to read
const SETTLED = new Set(['hashed', 'unchanged', 'encoded', 'gone']);
const WAITING = new Set(['held', 'busy', 'settling', 'failed', 'changed']);

/** A Tesla clip name's time (its wall clock read as UTC), or null. */
function clipMs(name) {
  const m = CLIP_RE.exec(name);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(t) ? t : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idOf = (st) => [st.size, st.mtimeMs, Number(st.ino)];
const sameId = (e, st) => Boolean(e) && e[0] === st.size && e[1] === st.mtimeMs && e[2] === Number(st.ino);
const validEntry = (e) => Array.isArray(e) && e.length === 5 && typeof e[0] === 'number' && typeof e[1] === 'number' && typeof e[3] === 'number' && typeof e[4] === 'string';

/** The snapshot's { v: 2, dirs } from a Map(rel -> entry). */
function toSnapshot(files) {
  const dirs = {};
  for (const [rel, e] of files) {
    const i = rel.lastIndexOf('/');
    const d = i < 0 ? '' : rel.slice(0, i);
    (dirs[d] ||= {})[rel.slice(i + 1)] = e;
  }
  return { v: 2, dirs };
}

/** A Map(rel -> entry) from a v1 or v2 snapshot, or null. */
function fromSnapshot(raw) {
  const files = new Map();
  if (raw?.v === 2 && raw.dirs && typeof raw.dirs === 'object') {
    for (const [d, names] of Object.entries(raw.dirs)) {
      if (!names || typeof names !== 'object') continue;
      for (const [n, e] of Object.entries(names)) if (validEntry(e)) files.set(d ? `${d}/${n}` : n, e);
    }
    return files;
  }
  if (raw?.v === 1 && raw.files && typeof raw.files === 'object') {
    for (const [rel, e] of Object.entries(raw.files)) if (validEntry(e)) files.set(rel, e);
    return files;
  }
  return null;
}

/**
 * vehicles: { list(), get(id), rootOf(v), vehicleForPath(p) }
 * inventory: { get(vid) -> { files: Map(rel -> { rel, kind, size, mtimeMs, ctimeMs }) }, codecs(vid) }
 * record({ source, sourceRoot, sha256 }): originalChecksums.record
 * holds(abs): Sentry USB is still copying it (sentryUsb.holds)
 * busyPaths(): Set of absolute paths a conversion has in hand
 * idle(): no conversion or benchmark runs
 * olderOf(vid): record clips older than the recent window too (the setting; default on)
 */
function createArrivalChecksums({
  dir, vehicles, inventory, record, holds = () => false, busyPaths = () => new Set(), idle = () => true, log = null,
  olderOf = () => true, now = () => Date.now(), windowDays = WINDOW_DAYS, freshMs = FRESH_MS, perCycle = PER_CYCLE, rate = RATE,
  settleMs = SETTLE_MS, timerMs = TIMER_MS, nextCycleMs = NEXT_CYCLE_MS, idleWaitMs = 2000, codecOf = videoCodec,
  saveEvery = SAVE_EVERY, compactMin = COMPACT_MIN, timers = { setInterval, clearInterval, setTimeout, clearTimeout }
} = {}) {
  const indexes = new Map(); // vid -> { files: Map(rel -> [size, mtimeMs, ino, at, kind]), journal: lines on disk, compact: bool }
  const pendingOps = new Map(); // vid -> [op] not yet appended to the journal
  const enabled = new Map(); // vid -> bool (a .sentryusb/ at a share root, last pass)
  const pendingOf = new Map(); // vid -> clips of the recent window waiting, last pass
  const backlogs = new Map(); // vid -> { total, left, bytesLeft, failed } (clips older than the window), live
  let running = null;
  let again = false;
  let stopped = false;
  let timer = null;
  let soon = null;
  let hashedBytes = 0;
  let hashedMs = 0; // reading and hashing only (not the waits while a conversion runs)

  const base = (vid) => path.join(dir, vid.replace(/[^A-Za-z0-9_-]/g, '_'));
  const file = (vid) => `${base(vid)}.json`;
  const journalFile = (vid) => `${base(vid)}.log`;

  function index(vid) {
    if (!indexes.has(vid)) {
      let files = null;
      let compact = false;
      try {
        const raw = JSON.parse(fs.readFileSync(file(vid), 'utf8'));
        files = fromSnapshot(raw);
        compact = files !== null && raw.v !== 2;
      } catch { /* none yet, or unreadable: start over */ }
      if (!files) files = new Map();
      let journal = 0;
      try {
        const text = fs.readFileSync(journalFile(vid), 'utf8');
        if (text && !text.endsWith('\n')) compact = true; // torn: rewrite before appending again
        for (const line of text.split('\n')) {
          if (!line) continue;
          let op;
          try { op = JSON.parse(line); } catch { compact = true; continue; }
          if (!Array.isArray(op) || typeof op[0] !== 'string') continue;
          journal++;
          if (op.length === 1) files.delete(op[0]);
          else if (validEntry(op.slice(1))) files.set(op[0], op.slice(1));
        }
      } catch { /* no journal */ }
      indexes.set(vid, { files, journal, compact });
    }
    return indexes.get(vid);
  }

  function op(vid, line) {
    if (!pendingOps.has(vid)) pendingOps.set(vid, []);
    pendingOps.get(vid).push(line);
  }

  async function writeSnapshot(vid, idx) {
    const target = file(vid);
    const tmp = `${target}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(toSnapshot(idx.files)));
      await fsp.rename(tmp, target);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
    // (the snapshot holds everything: the journal before it is spent)
    await fsp.unlink(journalFile(vid)).catch(() => {});
    idx.journal = 0;
    idx.compact = false;
  }

  /** Append the changes waiting (or rewrite the snapshot when the journal has grown long). */
  async function save() {
    if (!pendingOps.size) return;
    await fsp.mkdir(dir, { recursive: true });
    for (const [vid, ops] of [...pendingOps]) {
      pendingOps.delete(vid);
      const idx = index(vid);
      try {
        if (idx.compact || idx.journal + ops.length > Math.max(compactMin, idx.files.size / 2) || !fs.existsSync(file(vid))) {
          await writeSnapshot(vid, idx);
        } else {
          await fsp.appendFile(journalFile(vid), ops.map((o) => JSON.stringify(o)).join('\n') + '\n');
          idx.journal += ops.length;
        }
      } catch (err) {
        // (kept in memory; the next save rewrites the snapshot)
        idx.compact = true;
        if (!pendingOps.has(vid)) pendingOps.set(vid, []);
        log?.warn?.(`Checksum record index ${vid}: ${err.message}`);
      }
    }
  }

  function note(vid, rel, st, kind) {
    const e = [...idOf(st), now(), kind];
    index(vid).files.set(rel, e);
    op(vid, [rel, ...e]);
  }

  /** Drop the entries whose clip is gone from the inventory (only those: an unchanged clip keeps its entry, however old). */
  function prune(vid, files) {
    const idx = index(vid);
    for (const rel of idx.files.keys()) {
      if (files.has(rel)) continue;
      idx.files.delete(rel);
      op(vid, [rel]);
    }
  }

  const roots = new Map(); // share root -> { at, yes }
  async function sentryUsbRoot(root) {
    const c = roots.get(root);
    if (c && now() - c.at < 60_000) return c.yes;
    let yes = false;
    try { yes = (await fsp.stat(path.join(root, SENTRY_USB_DIR))).isDirectory(); } catch { yes = false; }
    roots.set(root, { at: now(), yes });
    return yes;
  }

  /**
   * The car's clips that may need a line, newest first (fresh arrivals, then
   * by the clip's own time): [{ rel, abs, root (share root), size, mtimeMs, recent }].
   */
  async function candidates(v, sinceMs) {
    const inv = inventory.get(v.id);
    if (!inv?.files) return { list: [], files: null, any: false };
    const rootDir = vehicles.rootOf(v);
    const out = [];
    let any = false;
    const freshFrom = now() - freshMs;
    for (const f of inv.files.values()) {
      if (f.kind !== 'clip') continue;
      const name = path.posix.basename(f.rel);
      const t = clipMs(name);
      if (t === null || isConverterArtifact(name)) continue;
      if (f.rel.split('/').some((p) => p.startsWith('.'))) continue;
      const abs = path.join(rootDir, ...f.rel.split('/'));
      const where = locate(abs, rootDir);
      if (!where || !GROUP_RE.test(where.rel.split('/')[0])) continue;
      if (!(await sentryUsbRoot(where.root))) continue;
      any = true;
      // (a clip's own time is the car's clock: a day either side is plenty)
      // (rsync keeps a clip's mtime: when it reached the share is its birth
      // time, else its ctime where the filesystem has none)
      const arrived = f.birthtimeMs > 0 ? f.birthtimeMs : f.ctimeMs || 0;
      const recent = Math.max(t, f.mtimeMs || 0, arrived);
      if (recent < sinceMs) continue;
      out.push({ rel: f.rel, abs, root: where.root, size: f.size || 0, mtimeMs: f.mtimeMs, t, recent, fresh: recent >= freshFrom });
    }
    // the Pi waits on the latest archive: what arrived in the last 48 h first, then the newest clips
    out.sort((a, b) => (b.fresh - a.fresh) || (b.t - a.t) || (a.rel < b.rel ? 1 : a.rel > b.rel ? -1 : 0));
    return { list: out, files: inv.files, any };
  }

  async function waitIdle() {
    while (!idle() && !stopped) await sleep(idleWaitMs);
  }

  /** The file's SHA-256, streamed at most `rate` bytes a second, paused while not idle. */
  async function hashFile(abs) {
    const h = crypto.createHash('sha256');
    const fh = await fsp.open(abs, 'r');
    const buf = Buffer.alloc(CHUNK);
    const started = Date.now();
    let paused = 0;
    let read = 0;
    try {
      for (;;) {
        if (stopped) throw new Error('stopped');
        if (!idle()) {
          const w = Date.now();
          await waitIdle();
          paused += Date.now() - w;
        }
        const { bytesRead } = await fh.read(buf, 0, CHUNK, read);
        if (!bytesRead) break;
        h.update(buf.subarray(0, bytesRead));
        read += bytesRead;
        if (rate > 0) {
          const ahead = (read / rate) * 1000 - (Date.now() - started - paused);
          if (ahead > 5) await sleep(ahead);
        }
      }
    } finally {
      await fh.close();
    }
    hashedBytes += read;
    hashedMs += Date.now() - started - paused;
    return h.digest('hex');
  }

  const busyNow = () => new Set([...busyPaths()].map((p) => path.resolve(p)));

  /** One clip: 'hashed' | 'unchanged' | 'held' | 'busy' | 'settling' | 'encoded' | 'changed' | 'gone' | 'failed'. */
  async function one(v, c) {
    const idx = index(v.id);
    let st;
    try { st = await fsp.stat(c.abs); } catch { return 'gone'; }
    if (!st.isFile()) return 'gone';
    const had = idx.files.get(c.rel);
    if (sameId(had, st)) return 'unchanged';
    if (holds(c.abs)) return 'held';
    if (busyNow().has(path.resolve(c.abs))) return 'busy';
    // (renamed into place just now: ctime; still being written: mtime; in
    // whole milliseconds, as now(): a file time has a fraction of one, so a
    // clip written in this very millisecond would otherwise be younger than
    // 0 ms)
    if (now() - Math.floor(Math.max(st.mtimeMs, st.ctimeMs || 0)) < settleMs) return 'settling';
    // encoded: our own conversion's output is noted by converted(); any other is not the Pi's bytes
    let codec;
    const known = inventory.codecs?.(v.id)?.get(c.rel);
    if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) codec = known.codec;
    else {
      try { codec = await codecOf(c.abs); } catch { codec = null; }
    }
    if (ENCODED.has(codec)) {
      note(v.id, c.rel, st, 's');
      return 'encoded';
    }
    let sha;
    try { sha = await hashFile(c.abs); } catch (err) {
      if (stopped) return 'failed';
      log?.debug?.(`Checksum record: ${c.rel}: ${err.message}`);
      return 'failed';
    }
    // the same file still (not replaced, converted or re-uploaded meanwhile)?
    let after;
    try { after = await fsp.stat(c.abs); } catch { return 'gone'; }
    if (!sameId(idOf(st), after)) return 'changed';
    if (busyNow().has(path.resolve(c.abs)) || holds(c.abs)) return 'busy';
    try {
      await record({ source: c.abs, sourceRoot: vehicles.rootOf(v), sha256: sha });
    } catch (err) {
      log?.warn?.(`Checksum record: ${c.rel}: ${err.message}`);
      return 'failed';
    }
    note(v.id, c.rel, after, 'h');
    return 'hashed';
  }

  async function pass() {
    let budget = perCycle;
    let hashed = 0;
    let more = false;
    const windowFrom = now() - windowDays * DAY_MS;
    const cars = [];
    for (const v of vehicles.list()) {
      if (stopped) break;
      const older = olderOf(v.id) !== false;
      let got;
      try { got = await candidates(v, older ? -Infinity : windowFrom); } catch (err) {
        log?.warn?.(`Checksum record ${v.name}: ${err.message}`);
        continue;
      }
      enabled.set(v.id, got.any);
      if (got.files && !inventory.get(v.id)?.scanning) prune(v.id, got.files);
      if (!got.any) { pendingOf.set(v.id, 0); backlogs.delete(v.id); continue; }
      const idx = index(v.id);
      const recent = [];
      const backlog = [];
      let olderTotal = 0;
      for (const c of got.list) {
        const inWindow = c.recent >= windowFrom;
        if (!inWindow) olderTotal++;
        const e = idx.files.get(c.rel);
        if (e && e[0] === c.size && e[1] === c.mtimeMs) continue;
        (inWindow ? recent : backlog).push(c);
      }
      if (older) {
        const bl = { total: olderTotal, left: backlog.length, bytesLeft: backlog.reduce((n, c) => n + c.size, 0), failed: 0 };
        backlogs.set(v.id, bl);
      } else backlogs.delete(v.id);
      cars.push({ v, recent, backlog, waiting: 0 });
    }

    const step = async (car, c) => {
      await waitIdle();
      const r = await one(car.v, c);
      if (r === 'hashed') { budget--; hashed++; }
      if (hashed && hashed % saveEvery === 0 && r === 'hashed') await save();
      return r;
    };

    // first what arrived lately, for every car (the Pi is waiting on it)
    for (const car of cars) {
      for (let i = 0; i < car.recent.length; i++) {
        if (stopped) break;
        if (budget <= 0) { more = true; car.waiting += car.recent.length - i; break; }
        if (WAITING.has(await step(car, car.recent[i]))) car.waiting++;
      }
      pendingOf.set(car.v.id, car.waiting);
    }
    // then the older clips, newest first; new arrivals (a kick) end the pass so the next one takes them first
    for (const car of cars) {
      const bl = backlogs.get(car.v.id);
      for (const c of car.backlog) {
        if (stopped || again || olderOf(car.v.id) === false || !bl) break;
        if (budget <= 0) { more = true; break; }
        const r = await step(car, c);
        if (SETTLED.has(r) || r === 'failed') {
          bl.left--;
          bl.bytesLeft = Math.max(0, bl.bytesLeft - c.size);
          if (r === 'failed') bl.failed++;
        }
      }
      if (stopped || again) break;
    }
    await save();
    return more;
  }

  function kick() {
    if (stopped) return Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => {
      let more = false;
      do {
        again = false;
        try { more = await pass(); } catch (err) { log?.warn?.(`Checksum record: ${err.message}`); more = false; }
      } while (again && !stopped);
      return more;
    })().then((more) => {
      running = null;
      if (more && !stopped) {
        timers.clearTimeout(soon);
        soon = timers.setTimeout(() => kick(), nextCycleMs);
        soon?.unref?.();
      }
    });
    return running;
  }

  const days = new Map(); // time zone -> formatter
  const dayIn = (ms, tz) => {
    const z = tz || 'UTC';
    if (!days.has(z)) {
      try { days.set(z, new Intl.DateTimeFormat('en-CA', { timeZone: z })); } catch { days.set(z, null); }
    }
    const f = days.get(z);
    return f ? f.format(new Date(ms)) : new Date(ms).toISOString().slice(0, 10);
  };

  /** Bytes a second the hashing manages (measured once there is enough of it, else the limit). */
  const speed = () => {
    const measured = hashedBytes >= 64 * 1024 * 1024 && hashedMs > 0 ? (hashedBytes / hashedMs) * 1000 : 0;
    if (measured) return rate > 0 ? Math.min(measured, rate) : measured;
    return rate > 0 ? rate : 512 * 1024 * 1024;
  };

  return {
    kick,
    /** Our in-place conversion saved outputPath: its identity is ours, never hashed. */
    async converted(outputPath) {
      const v = vehicles.vehicleForPath?.(outputPath);
      if (!v) return;
      const rel = path.relative(vehicles.rootOf(v), path.resolve(outputPath)).split(path.sep).join('/');
      if (!rel || rel.startsWith('..')) return;
      try {
        const st = await fsp.stat(outputPath);
        // (a clip kept as it was, no savings, is still the original: hashed as any other)
        const codec = await codecOf(outputPath).catch(() => null);
        if (!ENCODED.has(codec)) return;
        note(v.id, rel, st, 'c');
        await save();
      } catch { /* gone again */ }
    },
    /**
     * For GET /api/vehicles/:id/sentry-usb: { enabled, today, lastAt, pending,
     * lines, windowDays, older, backlog: null | { total, done, left, failed, bytesLeft, etaMinutes } }.
     * backlog: the clips older than the recent window (older on), done = looked at.
     */
    view(vid) {
      const v = vehicles.get(vid);
      const idx = index(vid);
      const t = now();
      const today = dayIn(t, v?.timezone);
      const since = t - 2 * DAY_MS; // (today, in any zone, is within the last two days)
      let lines = 0;
      let todayN = 0;
      let lastAt = null;
      // (a day starts on a quarter hour in every zone: one look per quarter hour, not per clip)
      const quarters = new Map();
      const isToday = (ms) => {
        const q = Math.floor(ms / 900_000);
        if (!quarters.has(q)) quarters.set(q, dayIn(ms, v?.timezone) === today);
        return quarters.get(q);
      };
      for (const e of idx.files.values()) {
        if (e[4] !== 'h') continue;
        lines++;
        if (e[3] >= since && isToday(e[3])) todayN++;
        if (lastAt === null || e[3] > lastAt) lastAt = e[3];
      }
      const older = olderOf(vid) !== false;
      const bl = older ? backlogs.get(vid) : null;
      let backlog = null;
      if (bl) {
        const seconds = bl.left ? bl.bytesLeft / speed() + Math.ceil(bl.left / perCycle) * (nextCycleMs / 1000) : 0;
        backlog = {
          total: bl.total, done: bl.total - bl.left, left: bl.left, failed: bl.failed,
          bytesLeft: bl.bytesLeft, etaMinutes: bl.left ? Math.max(1, Math.ceil(seconds / 60)) : 0
        };
      }
      return { enabled: enabled.get(vid) === true, today: todayN, lastAt, pending: pendingOf.get(vid) ?? 0, lines, windowDays, older, backlog };
    },
    /** Bytes hashed and the time it took (reading only), since start (for the log and tests). */
    stats: () => ({ bytes: hashedBytes, ms: hashedMs, running: Boolean(running), bytesPerSecond: speed() }),
    start() {
      if (timer) return;
      timer = timers.setInterval(() => kick(), timerMs);
      timer?.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) timers.clearInterval(timer);
      timers.clearTimeout(soon);
      timer = null;
      return (running || Promise.resolve()).then(() => save().catch(() => {}));
    },
    forget(vid) {
      indexes.delete(vid);
      pendingOps.delete(vid);
      enabled.delete(vid);
      pendingOf.delete(vid);
      backlogs.delete(vid);
      fsp.unlink(file(vid)).catch(() => {});
      fsp.unlink(journalFile(vid)).catch(() => {});
    },
    /** Wait for the current pass (tests). */
    settled: async () => { while (running) await running; }
  };
}

module.exports = { createArrivalChecksums, clipMs, toSnapshot, fromSnapshot, WINDOW_DAYS, FRESH_MS };
