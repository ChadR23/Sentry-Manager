'use strict';

// The checksum record of originals the converter replaces in place, for
// Sentry USB (its contract: docs/sentry-usb.md, and
// docs/sentry-manager-contract.md in the Sentry USB repository).
//
// Sentry USB checks every clip it uploaded by SHA-256, its copy against the
// share's. A clip converted in place can never match, so before an original
// is replaced its SHA-256 goes into
//
//   <share root>/.sentrymanager/original-checksums.sha256
//
// in sha256sum format, one line per clip: "<64 lowercase hex>  <relpath>\n".
// The share root is the folder that holds the clip's RecentClips/,
// SentryClips/, SavedClips/ or TeslaTrackMode/ folder (a vehicle's folder
// itself, or a TeslaCam/ folder in it), and the relpath is the clip's path
// from there with forward slashes, e.g.
// RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4. Sentry USB compares
// the line with its own copy's hash: equal, the conversion is of a good
// upload.
//
// Order: the line is appended and fsynced (with the folder, when the file is
// new) before the converter touches the original; a replacement that fails
// afterwards leaves a harmless line. Lines are only appended; a later line
// for the same path wins (Sentry USB reads the last one).
//
// Appends to one record are serialized in this process, each line one
// O_APPEND write. Only this server writes the record: other servers paired
// as nodes only encode, the save (and so the line) happens here.
//
// Pruning: lines are kept at least KEEP_DAYS (45; the contract asks for 30).
// The time of each line comes from a small sidecar,
// .sentrymanager/original-checksums.marks.json, which notes the record's
// size when the first line of each day (UTC) was appended. A clip's date
// says nothing of when it was converted (an old backlog converts today), and
// the file's own time covers only its newest line. About once a week the
// lines from before the oldest day still kept are dropped: the rest is
// written to a dot-named temporary file, fsynced, and renamed over the
// record, so a reader sees the old record or the new one. Without the
// sidecar (lost, unreadable) nothing is pruned.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DIR = '.sentrymanager';
const FILE = 'original-checksums.sha256';
const MARKS = 'original-checksums.marks.json';
const KEEP_DAYS = 45;
const PRUNE_SLACK_DAYS = 7; // prune once the oldest kept day is this much older still
const GROUP_RE = /^(recentclips|sentryclips|savedclips|teslatrackmode)$/i;
const SHA_RE = /^[0-9a-f]{64}$/;
const DAY_MS = 86_400_000;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/**
 * The share root and relpath of a clip: the folder above the clip's group
 * folder (the nearest RecentClips / SentryClips / SavedClips / TeslaTrackMode
 * above it), or `fallbackRoot` when there is none. null when the clip is not
 * inside `fallbackRoot`'s tree in a usable way.
 */
function locate(source, fallbackRoot) {
  const abs = path.resolve(source);
  const parts = abs.split(path.sep).filter(Boolean);
  for (let i = parts.length - 2; i >= 0; i--) {
    if (!GROUP_RE.test(parts[i])) continue;
    if (i === 0) break;
    const root = path.sep + parts.slice(0, i).join(path.sep);
    return { root, rel: parts.slice(i).join('/') };
  }
  return fallbackRoot ? under(abs, fallbackRoot) : null;
}

function under(abs, fallbackRoot) {
  const base = path.resolve(fallbackRoot);
  const rel = path.relative(base, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return { root: base, rel: rel.split(path.sep).join('/') };
}

/** One record line, or throws for a path sha256sum would have to escape. */
function lineFor(sha256, rel) {
  const hash = String(sha256 || '').toLowerCase();
  if (!SHA_RE.test(hash)) throw new Error('Not a SHA-256');
  if (!rel || /[\n\r\\\0]/.test(rel) || rel.startsWith('./') || rel.startsWith('/')) throw new Error('Unusable relpath');
  return `${hash}  ${rel}\n`;
}

/** The record's lines as [{ sha256, rel }] (in order; for tests and tools). */
function parseRecord(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (line.length > 66 && SHA_RE.test(line.slice(0, 64)) && line.slice(64, 66) === '  ') out.push({ sha256: line.slice(0, 64), rel: line.slice(66) });
  }
  return out;
}

async function fsyncPath(p) {
  let fh;
  try {
    fh = await fsp.open(p, 'r');
    await fh.sync();
  } catch (err) {
    // a folder some filesystems (SMB, some FUSE) cannot fsync
    if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EPERM', 'EACCES'].includes(err?.code)) throw err;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * allowedRoot(dir): whether a record may be written in `dir` (inside a
 * vehicle's folder). now: the clock (tests).
 */
function createOriginalChecksums({ log = null, now = () => Date.now(), allowedRoot = () => true } = {}) {
  const chains = new Map(); // record path -> promise of the last operation on it

  function serialize(file, fn) {
    const prev = chains.get(file) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    chains.set(file, tail);
    tail.then(() => { if (chains.get(file) === tail) chains.delete(file); });
    return next;
  }

  async function readMarks(dir) {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(dir, MARKS), 'utf8'));
      if (raw?.v !== 1 || !Array.isArray(raw.marks)) return null;
      const marks = raw.marks.filter((m) => m && /^\d{4}-\d{2}-\d{2}$/.test(m.day) && Number.isSafeInteger(m.offset) && m.offset >= 0);
      return { v: 1, marks: marks.sort((a, b) => a.offset - b.offset) };
    } catch {
      return null;
    }
  }

  async function writeAtomic(dir, name, data) {
    const tmp = path.join(dir, `.${name}.tmp-${crypto.randomBytes(6).toString('hex')}`);
    const fh = await fsp.open(tmp, 'wx', 0o644);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await fsp.rename(tmp, path.join(dir, name));
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
    await fsyncPath(dir);
  }

  /** Drop the lines from before the oldest day kept (rewrite + rename). */
  async function prune(dir, marks, today) {
    const keep = marks.marks.filter((m) => daysBetween(m.day, today) < KEEP_DAYS);
    const dropped = marks.marks.filter((m) => daysBetween(m.day, today) >= KEEP_DAYS);
    if (!dropped.length) return marks;
    const oldest = dropped[0];
    if (daysBetween(oldest.day, today) < KEEP_DAYS + PRUNE_SLACK_DAYS) return marks;
    const file = path.join(dir, FILE);
    const data = await fsp.readFile(file);
    // everything before the first day kept was written more than KEEP_DAYS ago
    const cut = keep.length ? keep[0].offset : data.length;
    if (cut <= 0 || cut > data.length || (cut < data.length && data[cut - 1] !== 0x0a)) return marks; // not a line start: leave it
    await writeAtomic(dir, FILE, data.subarray(cut));
    const next = { v: 1, marks: keep.map((m) => ({ day: m.day, offset: m.offset - cut })) };
    await writeAtomic(dir, MARKS, JSON.stringify(next));
    log?.info?.(`Checksum record ${file}: dropped ${cut} bytes of lines older than ${KEEP_DAYS} days`);
    return next;
  }

  /**
   * Append the original's line and fsync it, before it is replaced.
   * { source, sourceRoot, sha256 } -> { file, line }. Throws when the line
   * could not be written (the original is then kept).
   */
  async function record({ source, sourceRoot, sha256 }) {
    let where = locate(source, sourceRoot);
    // (a group folder above the vehicle's own folder: the job's folder then)
    if (where && !allowedRoot(where.root)) where = sourceRoot ? under(path.resolve(source), sourceRoot) : null;
    if (where && !allowedRoot(where.root)) where = null;
    if (!where) throw new Error(`No share root for ${source}`);
    const line = Buffer.from(lineFor(sha256, where.rel));
    const dir = path.join(where.root, DIR);
    const file = path.join(dir, FILE);
    return serialize(file, async () => {
      let createdDir = false;
      try {
        await fsp.mkdir(dir, { mode: 0o755 });
        createdDir = true;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      if (createdDir) await fsyncPath(where.root);
      const fh = await fsp.open(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o644);
      let size;
      let created;
      try {
        const st = await fh.stat();
        created = st.size === 0;
        size = st.size;
        let data = line;
        if (size > 0) {
          // a torn last line (never ours, but): start on a line of its own
          const last = Buffer.alloc(1);
          const rfh = await fsp.open(file, 'r');
          try { await rfh.read(last, 0, 1, size - 1); } finally { await rfh.close(); }
          if (last[0] !== 0x0a) data = Buffer.concat([Buffer.from('\n'), line]);
        }
        await fh.write(data);
        await fh.sync();
        if (data.length !== line.length) size += 1;
      } finally {
        await fh.close();
      }
      if (created) await fsyncPath(dir);
      // the day's first line: note where it starts (for pruning)
      try {
        const today = dayOf(now());
        // (no sidecar: the lines before this one count as older than it)
        let marks = (await readMarks(dir)) || { v: 1, marks: [] };
        if (!marks.marks.some((m) => m.day === today)) {
          marks.marks.push({ day: today, offset: size });
          marks = await prune(dir, marks, today);
          await writeAtomic(dir, MARKS, JSON.stringify(marks));
        }
      } catch (err) {
        log?.warn?.(`Checksum record ${file}: ${err.message}`);
      }
      return { file, line: line.toString() };
    });
  }

  return { record, locate };
}

module.exports = { createOriginalChecksums, locate, lineFor, parseRecord, DIR, FILE, MARKS, KEEP_DAYS };
