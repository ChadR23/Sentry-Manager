'use strict';

// "When did this start": searches over every indexed CAN minute of a car
// (canIndex.js: <DATA>/can-index/<vehicleKey>/<yyyyMMddTHHmm>.json.gz), so a
// problem can be traced back to the first time it showed.
//
//   signal(keys, { signal, op, value, from, to, limit, all })
//     the first time (and the next few times) a decoded signal met a
//     condition: > < >= <= = != (against a number, or a value name such as
//     "DRIVE"), changed, appeared (has data at all). The minutes are read
//     oldest first and the scan stops once `limit` matches are found (with
//     `all`, every minute is read for the full count).
//   ids(keys, { from, to, before, gap, id })
//     from the per-minute frame counts: when each CAN id first appeared (ids
//     new after `before`, or after the first hour of data), and when an id
//     the car sent regularly stopped for `gap` minutes while the car was
//     awake (other ids present).
//
// A match is one episode: the moment the condition became true after it was
// not (or after a gap in the data); "changed" reports every change. Each
// carries `at` (UTC ms); index.js adds the footage clip that covers it.

const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { tsFrom } = require('./inventory');

const gunzip = promisify(zlib.gunzip);
const MINUTE_FILE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})\.json\.gz$/;
const KEY = /^[A-Za-z0-9-]{1,64}$/;
const OPS = ['>', '<', '>=', '<=', '=', '!=', 'changed', 'appeared'];
const BUDGET_MS = 45_000; // one request reads for at most this long, then says where to go on

const minuteOf = (name) => {
  const m = MINUTE_FILE.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
};
const fileOf = (t) => `${new Date(t).toISOString().slice(0, 16).replace(/[-:]/g, '')}.json.gz`;

/** A UTC time as the car's wall clock, the way TeslaCam names clips: YYYY-MM-DD_HH-MM-SS. */
function localKey(ms, timeZone = 'UTC') {
  let p;
  try {
    p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  } catch {
    return new Date(ms).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  }
  return `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.second}`;
}
/** The same as "YYYY-MM-DD HH:MM:SS", for people. */
const localTime = (ms, timeZone) => localKey(ms, timeZone).replace('_', ' ').replace(/-(\d{2})-(\d{2})$/, ':$1:$2');
const keySeconds = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(k);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : NaN;
};

/**
 * The clip covering a moment: `stamps` are the car's clip names
 * (YYYY-MM-DD_HH-MM-SS, sorted, one entry each), `ms` the moment in UTC.
 * { at, localTime, day, clip, second } or null when there is no footage then.
 */
function footageAt(stamps, ms, timeZone = 'UTC') {
  if (!stamps?.length || !Number.isFinite(ms)) return null;
  const key = localKey(ms, timeZone);
  let lo = 0;
  let hi = stamps.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (stamps[mid] <= key) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return null;
  const second = keySeconds(key) - keySeconds(stamps[best]);
  if (!(second >= 0 && second < 62)) return null; // clips are a minute long
  return { at: ms, localTime: localTime(ms, timeZone), day: stamps[best].slice(0, 10), clip: stamps[best], second: Math.floor(second) };
}

/** Every clip name (YYYY-MM-DD_HH-MM-SS) of a car's recordings (inventory.js), sorted, once each. */
function clipStamps(recordings) {
  const out = new Set();
  for (const rec of recordings || []) for (const rel of rec.clipRels || []) { const ts = tsFrom(path.posix.basename(rel)); if (ts) out.add(ts); }
  return [...out].sort();
}

/**
 * A time from a query: ms since 1970, an ISO time with a zone, or the car's
 * own wall clock (YYYY-MM-DD, YYYY-MM-DDTHH:MM[:SS]); `toUtc(y, mo, d, h, mi, s)`
 * turns that into UTC. A bare date as `end` means the end of that day.
 */
function parseWhen(s, toUtc = (...a) => Date.UTC(a[0], a[1] - 1, a[2], a[3], a[4], a[5]), end = false) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  if (/^\d{9,15}$/.test(t)) return Number(t);
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(t) && /T/.test(t)) { const ms = Date.parse(t); return Number.isFinite(ms) ? ms : null; }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (!m) return null;
  if (m[4] === undefined) {
    const day = toUtc(+m[1], +m[2], +m[3], 0, 0, 0);
    if (!end) return day;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
    return toUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, 0) - 1;
  }
  return toUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)) + (end && m[6] === undefined ? 59_999 : 0);
}

const searchError = (message) => Object.assign(new Error(message), { status: 400 });

function createCanSearch({ dir, now = () => Date.now() }) {
  async function readMinute(key, t) {
    try { return JSON.parse((await gunzip(await fsp.readFile(path.join(dir, key, fileOf(t))))).toString('utf8')); } catch { return null; }
  }
  // only the frame counts: they come last in the file, so the signals need not be parsed
  async function readIds(key, t) {
    let text;
    try { text = (await gunzip(await fsp.readFile(path.join(dir, key, fileOf(t))))).toString('utf8'); } catch { return null; }
    const at = text.lastIndexOf(',"ids":');
    if (at > 0 && text.endsWith('}')) {
      try { return JSON.parse(text.slice(at + 7, -1)) || {}; } catch { /* the whole file, then */ }
    }
    try { return JSON.parse(text).ids || {}; } catch { return null; }
  }

  /** Every indexed minute of these cars between two times, oldest first: [[t, [keys]], …]. */
  async function minutesOf(keys, from = -Infinity, to = Infinity) {
    const byT = new Map();
    for (const key of keys) {
      if (!KEY.test(key)) continue;
      let names = [];
      try { names = await fsp.readdir(path.join(dir, key)); } catch { continue; }
      for (const name of names) {
        const t = minuteOf(name);
        if (t === null || t + 60_000 <= from || t > to) continue;
        const list = byT.get(t);
        if (list) list.push(key); else byT.set(t, [key]);
      }
    }
    return [...byT].sort((a, b) => a[0] - b[0]);
  }

  async function metaOf(keys, name) {
    for (const key of keys) {
      try {
        const all = JSON.parse(await fsp.readFile(path.join(dir, key, 'signals.json'), 'utf8'));
        if (all?.[name]) return all[name];
      } catch { /* none yet */ }
    }
    return null;
  }

  /** The first (and next) times a signal met a condition. */
  async function signal(keys, { signal: name, op, value, from = null, to = null, limit = 10, all = false, budgetMs = BUDGET_MS } = {}) {
    name = String(name || '').trim();
    if (!/^\w{1,80}$/.test(name)) throw searchError('Give the signal\'s name.');
    if (!OPS.includes(op)) throw searchError(`The condition is one of ${OPS.join(' ')}.`);
    limit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 10)));
    const lo = Number.isFinite(from) ? from : -Infinity;
    const hi = Number.isFinite(to) ? to : Infinity;
    const meta = await metaOf(keys, name);
    const names = meta?.values && typeof meta.values === 'object' ? meta.values : null;
    let want = null;
    if (op !== 'changed' && op !== 'appeared') {
      const raw = String(value ?? '').trim();
      if (raw === '') throw searchError('Give the value to compare with.');
      want = Number(raw);
      if (!Number.isFinite(want)) {
        // a value name ("DRIVE"), as the DBC calls it
        const hit = names && Object.entries(names).find(([, n]) => String(n).toLowerCase() === raw.toLowerCase());
        if (!hit) throw searchError(names ? `"${raw}" is not a value of ${name} (it has ${Object.values(names).slice(0, 12).join(', ')}).` : `"${raw}" is not a number.`);
        want = Number(hit[0]);
      }
    }
    const EPS = 1e-9;
    const test = {
      '>': (v) => v > want, '<': (v) => v < want, '>=': (v) => v >= want - EPS, '<=': (v) => v <= want + EPS,
      '=': (v) => Math.abs(v - want) <= EPS, '!=': (v) => Math.abs(v - want) > EPS
    }[op];
    const label = (v) => (names && names[String(v)] !== undefined ? String(names[String(v)]) : null);

    const minutes = await minutesOf(keys, lo, hi);
    const deadline = now() + budgetMs;
    const matches = [];
    let matchingMinutes = 0;
    let withData = 0;
    let scanned = 0;
    let prev;
    let inMatch = false;
    let lastT = null;
    let complete = true;
    let resumeFrom = null;
    for (const [t, ks] of minutes) {
      if (now() > deadline) { complete = false; resumeFrom = t; break; }
      const pts = [];
      for (const key of ks) {
        const p = (await readMinute(key, t))?.signals?.[name];
        if (Array.isArray(p)) for (const [ms, v] of p) pts.push([t + ms, v]);
      }
      if (ks.length > 1) pts.sort((a, b) => a[0] - b[0]);
      scanned++;
      // a gap in the data (the car asleep, a missing log) ends an episode
      if (lastT !== null && t - lastT > 60_000) inMatch = false;
      lastT = t;
      let hit = false;
      for (const [at, v] of pts) {
        if (at < lo || at > hi || typeof v !== 'number') continue;
        let ok;
        if (op === 'appeared') ok = true;
        else if (op === 'changed') ok = prev !== undefined && v !== prev;
        else ok = test(v);
        const before = prev;
        prev = v;
        if (!ok) { inMatch = false; continue; }
        hit = true;
        if ((!inMatch || op === 'changed') && matches.length < limit) {
          matches.push({ at, value: v, text: label(v), ...(op === 'changed' ? { previous: before, previousText: label(before) } : {}) });
        }
        inMatch = true;
      }
      if (pts.length) withData++; else inMatch = false;
      if (hit) matchingMinutes++;
      if (!all && matches.length >= limit) { complete = scanned === minutes.length; break; }
    }
    return {
      signal: name, op, value: want, unit: meta?.unit || '', first: matches[0] || null, matches,
      matchingMinutes, minutesWithData: withData, scannedMinutes: scanned, totalMinutes: minutes.length,
      // false: stopped early (enough matches, or out of time); counts are of what was read
      complete, resumeFrom
    };
  }

  /** New CAN ids, and regularly-seen ids that stopped. */
  async function ids(keys, { from = null, to = null, before = null, gap = 10, regular = 0.9, minSeen = 30, settle = 60, id = null, limit = 200, budgetMs = BUDGET_MS } = {}) {
    gap = Math.max(1, Math.min(10_000, Math.floor(Number(gap) || 10)));
    limit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
    // one id: "can0:2E5" (that bus), or "2E5" / "0x2E5" (any bus)
    const only = id ? String(id).trim().toLowerCase() : null;
    const onlyHex = only ? parseInt(only.split(':').pop().replace(/^0x/, ''), 16) : NaN;
    const matchesId = (k) => !only || (only.includes(':') ? k.toLowerCase() === only : parseInt(k.split(':').pop(), 16) === onlyHex);
    // "never seen before a date" needs everything before it, so a baseline reads from the start
    const lo = Number.isFinite(before) ? -Infinity : Number.isFinite(from) ? from : -Infinity;
    const hi = Number.isFinite(to) ? to : Infinity;
    const minutes = await minutesOf(keys, lo, hi);
    const deadline = now() + budgetMs;
    // id -> { first, last, seen, run (minutes seen since it last came back), runStart, lastAwake, missing, missingSince, open }
    const stats = new Map();
    const stopped = [];
    let awake = 0;
    let scanned = 0;
    let complete = true;
    let resumeFrom = null;
    let settledAt = null;
    for (const [t, ks] of minutes) {
      if (now() > deadline) { complete = false; resumeFrom = t; break; }
      const here = new Set();
      for (const key of ks) for (const k of Object.keys((await readIds(key, t)) || {})) here.add(k);
      scanned++;
      if (!here.size) continue;
      awake++;
      if (awake === settle) settledAt = t;
      for (const k of here) {
        let s = stats.get(k);
        if (!s) { s = { first: t, last: t, seen: 0, run: 0, runStart: awake, lastAwake: awake, missing: 0, missingSince: null, open: null }; stats.set(k, s); }
        // back after a long absence: how regular it is counts from here
        if (s.missing >= gap) { s.run = 0; s.runStart = awake; }
        s.seen++;
        s.run++;
        s.last = t;
        s.lastAwake = awake;
        if (s.open) { s.open.back = t; s.open.missingMinutes = s.missing; s.open = null; }
        s.missing = 0;
        s.missingSince = null;
      }
      for (const [k, s] of stats) {
        if (here.has(k)) continue;
        if (s.missing++ === 0) s.missingSince = t;
        if (s.missing !== gap || s.open) continue;
        // regular: seen in most awake minutes since it (last) came, and long enough
        if (s.run >= minSeen && s.run / (s.lastAwake - s.runStart + 1) >= regular && matchesId(k)) {
          s.open = { id: k, at: s.missingSince, lastSeen: s.last + 59_999, seenMinutes: s.seen, back: null, missingMinutes: null };
          if (stopped.length < limit) stopped.push(s.open);
        }
      }
    }
    for (const s of stats.values()) if (s.open) s.open.missingMinutes = s.missing; // still missing at the end
    // new: first seen in the minute of `before` or later; without it, after the first `settle` awake minutes
    const baseline = Number.isFinite(before) ? before : settledAt;
    const isNew = Number.isFinite(before) ? (s) => s.first >= Math.floor(before / 60_000) * 60_000 : (s) => settledAt !== null && s.first > settledAt;
    const appeared = [];
    for (const [k, s] of stats) if (isNew(s) && matchesId(k)) appeared.push({ id: k, at: s.first, lastSeen: s.last + 59_999, seenMinutes: s.seen });
    appeared.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const info = only ? [...stats].filter(([k]) => matchesId(k)).map(([k, s]) => ({ id: k, first: s.first, last: s.last + 59_999, seenMinutes: s.seen })) : null;
    return {
      gap, baseline, firstMinute: minutes[0]?.[0] ?? null, lastMinute: minutes[scanned - 1]?.[0] ?? null,
      awakeMinutes: awake, idCount: stats.size, appeared: appeared.slice(0, limit), appearedCount: appeared.length,
      stopped, ...(info ? { ids: info } : {}), scannedMinutes: scanned, totalMinutes: minutes.length, complete, resumeFrom
    };
  }

  return { signal, ids, minutesOf, readMinute };
}

module.exports = { createCanSearch, footageAt, clipStamps, localKey, localTime, parseWhen, OPS };
