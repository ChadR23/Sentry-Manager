'use strict';

// What the car wrote: Sentry USB's list of the clips on the car's USB drive
// (docs/sentry-usb.md, "What the car wrote"; section 4 of the share contract in the
// Sentry USB repository):
//
//   <share root>/.sentryusb/car-files.tsv
//
// Written beside archive-status.json. Every 10 minutes the Pi lists the
// car's drive (an instant read-only copy, independent of its snapshots) and
// records each clip it has not seen yet, or that grew since:
//
//   # first_seen_unix	path	size	mtime_unix
//   1762800000	RecentClips/2026-11-10_12-00-00-front.mp4	30000000	1762790000
//
// The path is the car's own layout (RecentClips flat, without the date folder
// the share uses), .mp4 only, the last 7 days, and clips the car deleted later
// stay listed. A clip that grew is listed again with a later first_seen: the
// largest size counts. Sizes are only kept for the record: Sentry Six Manager
// re-encodes clips, so a clip is matched to the share by its name, never its
// size.
//
// The file is read on purpose although it is dot-named (the scanner skips
// .sentryusb/, so it is never indexed as footage), at most MAX_BYTES of it,
// and parsed again only when its size or modification time changed (the Pi
// rewrites it every 10 minutes). A line that is not one is skipped quietly,
// and so is a path that is absolute or climbs out with "..".

const fsp = require('fs/promises');
const path = require('path');

const FILE = 'car-files.tsv';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_CLIPS = 400_000; // distinct paths kept (7 days of a car that never parks is ~60,000)
const MAX_PATH = 512;
const FROM_UNIX = 1262304000; // 2010
const TO_UNIX = 4102444800; // 2100
const COLUMNS = ['first_seen_unix', 'path', 'size', 'mtime_unix'];
const TOPS = { recentclips: 'RecentClips', sentryclips: 'SentryClips', savedclips: 'SavedClips', teslatrackmode: 'TeslaTrackMode' };
const NAME = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-[A-Za-z0-9_]+\.mp4$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const unixOf = (s) => {
  if (!/^\d{1,12}$/.test(s)) return null;
  const n = Number(s);
  return n >= FROM_UNIX && n <= TO_UNIX ? n : null;
};

/**
 * A path of the file as { path, type, event, name }, or null when it is not a
 * clip path (absolute, "..", empty parts, a backslash, not .mp4, too deep).
 * type: RecentClips | SentryClips | SavedClips | TeslaTrackMode | Other.
 * event: the event folder of a Sentry or Saved clip (the share has the same).
 */
function clipPath(raw) {
  const p = String(raw || '');
  if (!p || p.length > MAX_PATH || CONTROL.test(p) || p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split('/');
  if (parts.length > 4 || parts.some((x) => !x || x === '.' || x === '..')) return null;
  const name = parts[parts.length - 1];
  if (!NAME.test(name)) return null;
  const type = TOPS[parts[0].toLowerCase()] || 'Other';
  const event = (type === 'SentryClips' || type === 'SavedClips') && parts.length >= 3 ? parts[parts.length - 2] : null;
  return { path: p, type, event, name };
}

/**
 * The file's text as { clips: Map(path -> { path, type, event, name, size,
 * mtimeUnix, firstSeenUnix, lastSeenUnix }), lines, bad, firstSeenUnix,
 * lastSeenUnix }. A header ("# first_seen_unix	path	size	mtime_unix")
 * that names the four columns in another order is followed; without one the
 * order above is used. Lines that are not a clip are counted in `bad`.
 */
function parseCarFiles(text) {
  const clips = new Map();
  let order = [0, 1, 2, 3]; // index of first_seen, path, size, mtime in a line
  let lines = 0;
  let bad = 0;
  let first = null;
  let last = null;
  const s = String(text || '');
  let at = 0;
  while (at < s.length) {
    let end = s.indexOf('\n', at);
    if (end < 0) end = s.length;
    let line = s.slice(at, end);
    at = end + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      const names = line.slice(1).trim().split('\t').map((x) => x.trim().toLowerCase());
      if (names.length === 4 && COLUMNS.every((c) => names.includes(c))) order = COLUMNS.map((c) => names.indexOf(c));
      continue;
    }
    lines++;
    const f = line.split('\t');
    if (f.length !== 4) { bad++; continue; }
    const seen = unixOf(f[order[0]]);
    const clip = clipPath(f[order[1]]);
    const size = /^\d{1,15}$/.test(f[order[2]]) ? Number(f[order[2]]) : null;
    const mtime = /^\d{1,12}$/.test(f[order[3]]) ? Number(f[order[3]]) : null;
    if (seen === null || !clip || size === null || mtime === null) { bad++; continue; }
    const had = clips.get(clip.path);
    if (had) {
      had.size = Math.max(had.size, size);
      had.mtimeUnix = Math.max(had.mtimeUnix, mtime);
      had.firstSeenUnix = Math.min(had.firstSeenUnix, seen);
      had.lastSeenUnix = Math.max(had.lastSeenUnix, seen);
    } else {
      if (clips.size >= MAX_CLIPS) { bad++; continue; }
      clips.set(clip.path, { ...clip, size, mtimeUnix: mtime, firstSeenUnix: seen, lastSeenUnix: seen });
    }
    first = first === null ? seen : Math.min(first, seen);
    last = last === null ? seen : Math.max(last, seen);
  }
  return { clips, lines, bad, firstSeenUnix: first, lastSeenUnix: last };
}

/**
 * The Pi's daily counts from the list ("Car files for 2026-11-10: 1234
 * RecentClips file(s) covering 310 minute(s), 3 Sentry event(s), 1 saved
 * clip(s)"), per day of the clip's name (the car's clock):
 * { day: { recentFiles, minutes, sentryEvents, savedEvents } }.
 */
function dailyCounts(entries) {
  const out = {};
  const minutes = new Map();
  const events = new Map();
  for (const c of entries) {
    const day = c.name.slice(0, 10);
    const d = (out[day] ||= { recentFiles: 0, minutes: 0, sentryEvents: 0, savedEvents: 0 });
    if (c.type === 'RecentClips') {
      d.recentFiles++;
      if (!minutes.has(day)) minutes.set(day, new Set());
      minutes.get(day).add(c.name.slice(0, 16));
    } else if (c.event && (c.type === 'SentryClips' || c.type === 'SavedClips')) {
      const k = `${day}|${c.type}`;
      if (!events.has(k)) events.set(k, new Set());
      events.get(k).add(c.event);
    }
  }
  for (const [day, set] of minutes) out[day].minutes = set.size;
  for (const [k, set] of events) {
    const [day, type] = k.split('|');
    out[day][type === 'SentryClips' ? 'sentryEvents' : 'savedEvents'] = set.size;
  }
  return out;
}

/**
 * Reads a share's car-files.tsv, cached by its size and modification time.
 * read(dir) with the share's .sentryusb folder: { file, size, mtimeMs, list
 * (parseCarFiles), error } or null when there is no file.
 */
function createCarFilesReader({ log = null } = {}) {
  const cache = new Map(); // file -> { size, mtimeMs, list, error }
  return {
    async read(dir) {
      const file = path.join(dir, FILE);
      let st;
      try { st = await fsp.stat(file); } catch { cache.delete(file); return null; }
      if (!st.isFile()) return null;
      const had = cache.get(file);
      if (had && had.size === st.size && had.mtimeMs === st.mtimeMs) return { file, ...had };
      let list = null;
      let error = null;
      if (st.size > MAX_BYTES) error = 'too large';
      else {
        try {
          const buf = await fsp.readFile(file);
          // (it may have been replaced by a bigger one in between)
          if (buf.length > MAX_BYTES) error = 'too large';
          else list = parseCarFiles(buf.toString('utf8'));
        } catch (err) {
          error = 'unreadable';
          log?.debug?.(`Sentry USB car files ${file}: ${err.message}`);
        }
      }
      const next = { size: st.size, mtimeMs: st.mtimeMs, list, error };
      if (cache.size > 64) cache.clear();
      cache.set(file, next);
      return { file, ...next };
    }
  };
}

module.exports = { parseCarFiles, clipPath, dailyCounts, createCarFilesReader, FILE, MAX_BYTES, MAX_CLIPS };
