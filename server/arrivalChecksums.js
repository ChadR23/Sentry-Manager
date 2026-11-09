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
// that are recent: the clip's own time, its modification time or the time it
// reached the share (birth time, else ctime) within WINDOW_DAYS (7). The whole archive is never
// read by default; backfill(vid, days) reaches further back once.
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
// the result dropped if it changed (the file was replaced mid-hash).
//
// What was recorded is kept per car in <dir>/<vehicle id>.json:
// relpath (from the car's folder) -> [size, mtimeMs, ino, at, kind], kind 'h'
// (hashed, a line written), 'c' (our conversion's output), 's' (skipped:
// encoded, not ours). Entries go when their file is gone from the inventory or
// after KEEP_DAYS (45, as the record's lines).

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { locate, KEEP_DAYS } = require('./originalChecksums');
const { isConverterArtifact } = require('./footage');
const { videoCodec } = require('./mp4codec');

const WINDOW_DAYS = 7;
const MAX_BACKFILL_DAYS = 365;
const PER_CYCLE = 300;
const RATE = 64 * 1024 * 1024; // bytes a second
const CHUNK = 1024 * 1024;
const SETTLE_MS = 60_000;
const TIMER_MS = 10 * 60_000;
const NEXT_CYCLE_MS = 30_000; // when a pass stopped at PER_CYCLE
const DAY_MS = 86_400_000;
const CLIP_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-[a-z0-9_]+\.mp4$/i;
const GROUP_RE = /^(recentclips|sentryclips|savedclips|teslatrackmode)$/i;
const ENCODED = new Set(['h265', 'av1']);
const SENTRY_USB_DIR = '.sentryusb';

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

/**
 * vehicles: { list(), get(id), rootOf(v), vehicleForPath(p) }
 * inventory: { get(vid) -> { files: Map(rel -> { rel, kind, size, mtimeMs, ctimeMs }) }, codecs(vid) }
 * record({ source, sourceRoot, sha256 }): originalChecksums.record
 * holds(abs): Sentry USB is still copying it (sentryUsb.holds)
 * busyPaths(): Set of absolute paths a conversion has in hand
 * idle(): no conversion or benchmark runs
 */
function createArrivalChecksums({
  dir, vehicles, inventory, record, holds = () => false, busyPaths = () => new Set(), idle = () => true, log = null,
  now = () => Date.now(), windowDays = WINDOW_DAYS, perCycle = PER_CYCLE, rate = RATE, settleMs = SETTLE_MS,
  timerMs = TIMER_MS, nextCycleMs = NEXT_CYCLE_MS, idleWaitMs = 2000, codecOf = videoCodec,
  timers = { setInterval, clearInterval, setTimeout, clearTimeout }
} = {}) {
  const indexes = new Map(); // vid -> { v: 1, files: { rel: [size, mtimeMs, ino, at, kind] } }
  const dirty = new Set();
  const enabled = new Map(); // vid -> bool (a .sentryusb/ at a share root, last pass)
  const pendingOf = new Map(); // vid -> clips waiting, last pass
  const backfills = new Map(); // vid -> { days, since, startedAt, done, total, finishedAt }
  let running = null;
  let again = false;
  let stopped = false;
  let timer = null;
  let soon = null;
  let hashedBytes = 0;
  let hashedMs = 0;

  const file = (vid) => path.join(dir, `${vid.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

  function index(vid) {
    if (!indexes.has(vid)) {
      let data = { v: 1, files: {} };
      try {
        const raw = JSON.parse(fs.readFileSync(file(vid), 'utf8'));
        if (raw?.v === 1 && raw.files && typeof raw.files === 'object') data = { v: 1, files: raw.files };
      } catch { /* none yet, or unreadable: start over */ }
      indexes.set(vid, data);
    }
    return indexes.get(vid);
  }

  async function save() {
    if (!dirty.size) return;
    await fsp.mkdir(dir, { recursive: true });
    for (const vid of [...dirty]) {
      dirty.delete(vid);
      const target = file(vid);
      const tmp = `${target}.tmp-${crypto.randomBytes(4).toString('hex')}`;
      try {
        await fsp.writeFile(tmp, JSON.stringify(index(vid)));
        await fsp.rename(tmp, target);
      } catch (err) {
        await fsp.unlink(tmp).catch(() => {});
        log?.warn?.(`Checksum record index ${vid}: ${err.message}`);
      }
    }
  }

  function note(vid, rel, st, kind) {
    index(vid).files[rel] = [...idOf(st), now(), kind];
    dirty.add(vid);
  }

  /** Drop entries whose clip is gone from the inventory, or older than KEEP_DAYS. */
  function prune(vid, files) {
    const idx = index(vid);
    const cutoff = now() - KEEP_DAYS * DAY_MS;
    for (const [rel, e] of Object.entries(idx.files)) {
      if (!Array.isArray(e) || e[3] < cutoff || (files && !files.has(rel))) {
        delete idx.files[rel];
        dirty.add(vid);
      }
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

  /** The car's clips that may need a line: [{ rel, abs, root (share root), size, mtimeMs }]. */
  async function candidates(v, sinceMs) {
    const inv = inventory.get(v.id);
    if (!inv?.files) return { list: [], files: null, any: false };
    const base = vehicles.rootOf(v);
    const out = [];
    let any = false;
    for (const f of inv.files.values()) {
      if (f.kind !== 'clip') continue;
      const name = path.posix.basename(f.rel);
      const t = clipMs(name);
      if (t === null || isConverterArtifact(name)) continue;
      if (f.rel.split('/').some((p) => p.startsWith('.'))) continue;
      const abs = path.join(base, ...f.rel.split('/'));
      const where = locate(abs, base);
      if (!where || !GROUP_RE.test(where.rel.split('/')[0])) continue;
      if (!(await sentryUsbRoot(where.root))) continue;
      any = true;
      // (a clip's own time is the car's clock: a day either side is plenty)
      // (rsync keeps a clip's mtime: when it reached the share is its birth
      // time, else its ctime where the filesystem has none)
      const arrived = f.birthtimeMs > 0 ? f.birthtimeMs : f.ctimeMs || 0;
      const recent = Math.max(t, f.mtimeMs || 0, arrived);
      if (recent < sinceMs) continue;
      out.push({ rel: f.rel, abs, root: where.root, size: f.size, mtimeMs: f.mtimeMs });
    }
    // newest first: the Pi waits on the latest archive
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
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
    let read = 0;
    try {
      for (;;) {
        if (stopped) throw new Error('stopped');
        await waitIdle();
        const { bytesRead } = await fh.read(buf, 0, CHUNK, read);
        if (!bytesRead) break;
        h.update(buf.subarray(0, bytesRead));
        read += bytesRead;
        if (rate > 0) {
          const ahead = (read / rate) * 1000 - (Date.now() - started);
          if (ahead > 5) await sleep(ahead);
        }
      }
    } finally {
      await fh.close();
    }
    hashedBytes += read;
    hashedMs += Date.now() - started;
    return h.digest('hex');
  }

  /** One clip: 'hashed' | 'unchanged' | 'held' | 'busy' | 'settling' | 'ours' | 'encoded' | 'changed' | 'gone' | 'failed'. */
  const busyNow = () => new Set([...busyPaths()].map((p) => path.resolve(p)));

  async function one(v, c) {
    const idx = index(v.id);
    let st;
    try { st = await fsp.stat(c.abs); } catch { return 'gone'; }
    if (!st.isFile()) return 'gone';
    const had = idx.files[c.rel];
    if (sameId(had, st)) return 'unchanged';
    if (holds(c.abs)) return 'held';
    if (busyNow().has(path.resolve(c.abs))) return 'busy';
    // (renamed into place just now: ctime; still being written: mtime)
    if (now() - Math.max(st.mtimeMs, st.ctimeMs || 0) < settleMs) return 'settling';
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
    let more = false;
    const t = now();
    for (const v of vehicles.list()) {
      if (stopped) break;
      const bf = backfills.get(v.id);
      const since = Math.min(t - windowDays * DAY_MS, bf && !bf.finishedAt ? bf.since : Infinity);
      let got;
      try { got = await candidates(v, since); } catch (err) {
        log?.warn?.(`Checksum record ${v.name}: ${err.message}`);
        continue;
      }
      enabled.set(v.id, got.any);
      if (got.files && !inventory.get(v.id)?.scanning) prune(v.id, got.files);
      if (!got.any) { pendingOf.set(v.id, 0); continue; }
      const idx = index(v.id);
      const todo = got.list.filter((c) => {
        const e = idx.files[c.rel];
        return !(e && e[0] === c.size && e[1] === c.mtimeMs);
      });
      if (bf && !bf.finishedAt && bf.total === null) bf.total = todo.length;
      let left = todo.length;
      let waiting = 0;
      for (const c of todo) {
        if (stopped) break;
        if (budget <= 0) { more = true; waiting += left; break; }
        await waitIdle();
        const r = await one(v, c);
        left--;
        if (r === 'hashed') budget--;
        if (['held', 'busy', 'settling', 'failed', 'changed'].includes(r)) waiting++;
        if (bf && !bf.finishedAt) bf.done++;
        if (r === 'hashed' && (perCycle - budget) % 25 === 0) await save();
      }
      pendingOf.set(v.id, waiting);
      if (bf && !bf.finishedAt && !more) bf.finishedAt = now();
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

  const dayIn = (ms, tz) => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(new Date(ms)); } catch { return new Date(ms).toISOString().slice(0, 10); }
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
    /** Also record clips from the last `days` days, once. */
    backfill(vid, days) {
      const n = Math.floor(Number(days));
      if (!Number.isFinite(n) || n < 1 || n > MAX_BACKFILL_DAYS) throw Object.assign(new Error(`Choose 1 to ${MAX_BACKFILL_DAYS} days.`), { status: 400 });
      backfills.set(vid, { days: n, since: now() - n * DAY_MS, startedAt: now(), done: 0, total: null, finishedAt: null });
      kick();
      return this.view(vid);
    },
    /** For GET /api/vehicles/:id/sentry-usb: { enabled, today, lastAt, pending, lines, backfill }. */
    view(vid) {
      const v = vehicles.get(vid);
      const idx = index(vid);
      const today = dayIn(now(), v?.timezone);
      let lines = 0;
      let todayN = 0;
      let lastAt = null;
      for (const e of Object.values(idx.files)) {
        if (!Array.isArray(e) || e[4] !== 'h') continue;
        lines++;
        if (dayIn(e[3], v?.timezone) === today) todayN++;
        if (lastAt === null || e[3] > lastAt) lastAt = e[3];
      }
      const bf = backfills.get(vid);
      return {
        enabled: enabled.get(vid) === true,
        today: todayN,
        lastAt,
        pending: pendingOf.get(vid) ?? 0,
        lines,
        windowDays,
        backfill: bf ? { days: bf.days, done: bf.total === null ? bf.done : Math.min(bf.done, bf.total), total: bf.total, startedAt: bf.startedAt, finishedAt: bf.finishedAt } : null
      };
    },
    /** Bytes hashed and the time it took, since start (for the log and tests). */
    stats: () => ({ bytes: hashedBytes, ms: hashedMs, running: Boolean(running) }),
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
      return running || Promise.resolve();
    },
    forget(vid) {
      indexes.delete(vid);
      enabled.delete(vid);
      pendingOf.delete(vid);
      backfills.delete(vid);
      fsp.unlink(file(vid)).catch(() => {});
    },
    /** Wait for the current pass (tests). */
    settled: async () => { while (running) await running; }
  };
}

module.exports = { createArrivalChecksums, clipMs, WINDOW_DAYS, MAX_BACKFILL_DAYS };
