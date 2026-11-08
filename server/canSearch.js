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
//
// A scan reads for at most 45 s. Out of time, it answers `resume`, a token:
// the same call with { resume } goes on exactly where it stopped, with all
// it found so far. Both take `stop` (an AbortSignal) to end early.

const crypto = require('crypto');
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
const KEEP_MS = 15 * 60_000; // a scan out of time can be gone on with for this long ...
const KEEP_MAX = 16; // ... and this many are kept at once (the oldest go first)

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

const searchError = (message, status = 400) => Object.assign(new Error(message), { status });

/** A real moment on the calendar and the clock: no 31 February, no 24:00 or 10:61. */
function realTime(y, mo, d, h = 0, mi = 0, s = 0) {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && h <= 23 && mi <= 59 && s <= 59;
}

/**
 * A time from a query: ms since 1970, an ISO time with a zone, or the car's
 * own wall clock (YYYY-MM-DD, YYYY-MM-DDTHH:MM[:SS]); `toUtc(y, mo, d, h, mi, s)`
 * turns that into UTC. A bare date as `end` means the end of that day.
 * Nothing given is null (no bound). Anything else that is not such a time
 * is an error (400), so a typo does not quietly search the whole history.
 */
function parseWhen(s, toUtc = (...a) => Date.UTC(a[0], a[1] - 1, a[2], a[3], a[4], a[5]), end = false) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const bad = () => searchError(`"${t.slice(0, 40)}" is not a time: give YYYY-MM-DD or YYYY-MM-DDTHH:MM.`);
  if (/^\d{9,15}$/.test(t)) return Number(t);
  const z = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/i.exec(t);
  if (z) {
    const ms = Date.parse(t);
    if (!realTime(+z[1], +z[2], +z[3], +z[4], +z[5], +(z[6] || 0)) || !Number.isFinite(ms)) throw bad();
    return ms;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (!m || !realTime(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))) throw bad();
  if (m[4] === undefined) {
    const day = toUtc(+m[1], +m[2], +m[3], 0, 0, 0);
    if (!end) return day;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
    return toUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, 0) - 1;
  }
  return toUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)) + (end && m[6] === undefined ? 59_999 : 0);
}

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

  // A scan out of time keeps where it was (the last value, the episode, the
  // counts, every id's history) here for a while, under a token: "Go on"
  // passes the token back and the scan picks up exactly where it stopped.
  const kept = new Map(); // token -> { kind, keys, at, st }
  function keep(kind, keys, st, token = crypto.randomBytes(12).toString('hex')) {
    const t = now();
    for (const [k, p] of kept) if (t - p.at > KEEP_MS) kept.delete(k);
    while (kept.size >= KEEP_MAX) kept.delete(kept.keys().next().value);
    kept.set(token, { kind, keys: keys.join(','), at: t, st });
    return token;
  }
  function takeKept(kind, keys, token) {
    const p = kept.get(String(token));
    if (!p || p.kind !== kind || p.keys !== keys.join(',') || now() - p.at > KEEP_MS) throw searchError('That search is no longer kept: search again.');
    kept.delete(String(token));
    return p.st;
  }
  // stopped (the page closed, or a newer search took its place): kept again under its token, if it had one
  function halt(kind, keys, st, token) {
    if (token) keep(kind, keys, st, token);
    return searchError('The search was stopped.', 409);
  }

  /** The first (and next) times a signal met a condition. With `resume` (a token), goes on from where that scan stopped. */
  async function signal(keys, { signal: name, op, value, from = null, to = null, limit = 10, all = false, resume = null, budgetMs = BUDGET_MS, stop = null } = {}) {
    const st = resume ? takeKept('signal', keys, resume) : await signalStart(keys, { name, op, value, from, to, limit, all });
    const EPS = 1e-9;
    const want = st.want;
    const test = {
      '>': (v) => v > want, '<': (v) => v < want, '>=': (v) => v >= want - EPS, '<=': (v) => v <= want + EPS,
      '=': (v) => Math.abs(v - want) <= EPS, '!=': (v) => Math.abs(v - want) > EPS
    }[st.op];
    const label = (v) => (st.names && st.names[String(v)] !== undefined ? String(st.names[String(v)]) : null);

    const minutes = await minutesOf(keys, st.next ?? st.lo, st.hi);
    const deadline = now() + budgetMs;
    const scannedBefore = st.scanned;
    let complete = true;
    let token = null;
    for (const [t, ks] of minutes) {
      if (stop?.aborted) { st.next = t; throw halt('signal', keys, st, resume); }
      if (now() > deadline) { complete = false; st.next = t; token = keep('signal', keys, st, resume || undefined); break; }
      const pts = [];
      for (const key of ks) {
        const p = (await readMinute(key, t))?.signals?.[st.name];
        if (Array.isArray(p)) for (const [ms, v] of p) pts.push([t + ms, v]);
      }
      if (ks.length > 1) pts.sort((a, b) => a[0] - b[0]);
      st.scanned++;
      // a gap in the data (the car asleep, a missing log) ends an episode
      if (st.lastT !== null && t - st.lastT > 60_000) st.inMatch = false;
      st.lastT = t;
      let hit = false;
      for (const [at, v] of pts) {
        if (at < st.lo || at > st.hi || typeof v !== 'number') continue;
        let ok;
        if (st.op === 'appeared') ok = true;
        else if (st.op === 'changed') ok = st.prev !== undefined && v !== st.prev;
        else ok = test(v);
        const before = st.prev;
        st.prev = v;
        if (!ok) { st.inMatch = false; continue; }
        hit = true;
        if ((!st.inMatch || st.op === 'changed') && st.matches.length < st.limit) {
          st.matches.push({ at, value: v, text: label(v), ...(st.op === 'changed' ? { previous: before, previousText: label(before) } : {}) });
        }
        st.inMatch = true;
      }
      if (pts.length) st.withData++; else st.inMatch = false;
      if (hit) st.matchingMinutes++;
      if (!st.all && st.matches.length >= st.limit) { complete = st.scanned - scannedBefore === minutes.length; break; }
    }
    return {
      signal: st.name, op: st.op, value: want, unit: st.unit, first: st.matches[0] || null, matches: st.matches,
      matchingMinutes: st.matchingMinutes, minutesWithData: st.withData, scannedMinutes: st.scanned, totalMinutes: scannedBefore + minutes.length,
      // false: stopped early (enough matches, or out of time); counts are of what was read.
      // Out of time: `resume` is the token that goes on from `resumeFrom`.
      complete, resumeFrom: token ? st.next : null, resume: token
    };
  }

  // a new signal search: its condition checked, nothing read yet
  async function signalStart(keys, { name, op, value, from, to, limit, all }) {
    name = String(name || '').trim();
    if (!/^\w{1,80}$/.test(name)) throw searchError('Give the signal\'s name.');
    if (!OPS.includes(op)) throw searchError(`The condition is one of ${OPS.join(' ')}.`);
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
    return {
      name, op, want, names, unit: meta?.unit || '', all: !!all,
      limit: Math.max(1, Math.min(200, Math.floor(Number(limit) || 10))),
      lo: Number.isFinite(from) ? from : -Infinity, hi: Number.isFinite(to) ? to : Infinity,
      next: null, matches: [], matchingMinutes: 0, withData: 0, scanned: 0, prev: undefined, inMatch: false, lastT: null
    };
  }

  /** New CAN ids, and regularly-seen ids that stopped. With `resume` (a token), goes on from where that scan stopped. */
  async function ids(keys, { from = null, to = null, before = null, gap = 10, regular = 0.9, minSeen = 30, settle = 60, id = null, limit = 200, resume = null, budgetMs = BUDGET_MS, stop = null } = {}) {
    const st = resume ? takeKept('ids', keys, resume) : {
      gap: Math.max(1, Math.min(10_000, Math.floor(Number(gap) || 10))),
      limit: Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200))),
      regular, minSeen, settle,
      // one id: "can0:2E5" (that bus), or "2E5" / "0x2E5" (any bus)
      only: id ? String(id).trim().toLowerCase() : null,
      before: Number.isFinite(before) ? before : null,
      // "never seen before a date" needs everything before it, so a baseline reads from the start
      lo: Number.isFinite(before) ? -Infinity : Number.isFinite(from) ? from : -Infinity,
      hi: Number.isFinite(to) ? to : Infinity,
      next: null,
      // id -> { first, last, seen, run (minutes seen since it last came back), runStart, lastAwake, missing, missingSince, open }
      stats: new Map(), stopped: [], awake: 0, scanned: 0, settledAt: null, firstMinute: null, lastMinute: null
    };
    const { only, stats, stopped } = st;
    const onlyHex = only ? parseInt(only.split(':').pop().replace(/^0x/, ''), 16) : NaN;
    const matchesId = (k) => !only || (only.includes(':') ? k.toLowerCase() === only : parseInt(k.split(':').pop(), 16) === onlyHex);
    const minutes = await minutesOf(keys, st.next ?? st.lo, st.hi);
    const deadline = now() + budgetMs;
    const scannedBefore = st.scanned;
    let complete = true;
    let token = null;
    if (st.firstMinute === null) st.firstMinute = minutes[0]?.[0] ?? null;
    for (const [t, ks] of minutes) {
      if (stop?.aborted) { st.next = t; throw halt('ids', keys, st, resume); }
      if (now() > deadline) { complete = false; st.next = t; token = keep('ids', keys, st, resume || undefined); break; }
      const here = new Set();
      for (const key of ks) for (const k of Object.keys((await readIds(key, t)) || {})) here.add(k);
      st.scanned++;
      st.lastMinute = t;
      if (!here.size) continue;
      st.awake++;
      if (st.awake === st.settle) st.settledAt = t;
      for (const k of here) {
        let s = stats.get(k);
        if (!s) { s = { first: t, last: t, seen: 0, run: 0, runStart: st.awake, lastAwake: st.awake, missing: 0, missingSince: null, open: null }; stats.set(k, s); }
        // back after a long absence: how regular it is counts from here
        if (s.missing >= st.gap) { s.run = 0; s.runStart = st.awake; }
        s.seen++;
        s.run++;
        s.last = t;
        s.lastAwake = st.awake;
        if (s.open) { s.open.back = t; s.open.missingMinutes = s.missing; s.open = null; }
        s.missing = 0;
        s.missingSince = null;
      }
      for (const [k, s] of stats) {
        if (here.has(k)) continue;
        if (s.missing++ === 0) s.missingSince = t;
        if (s.missing !== st.gap || s.open) continue;
        // regular: seen in most awake minutes since it (last) came, and long enough
        if (s.run >= st.minSeen && s.run / (s.lastAwake - s.runStart + 1) >= st.regular && matchesId(k)) {
          s.open = { id: k, at: s.missingSince, lastSeen: s.last + 59_999, seenMinutes: s.seen, back: null, missingMinutes: null };
          if (stopped.length < st.limit) stopped.push(s.open);
        }
      }
    }
    for (const s of stats.values()) if (s.open) s.open.missingMinutes = s.missing; // still missing (as far as read)
    // new: first seen in the minute of `before` or later; without it, after the first `settle` awake minutes
    const baseline = st.before ?? st.settledAt;
    const isNew = st.before !== null ? (s) => s.first >= Math.floor(st.before / 60_000) * 60_000 : (s) => st.settledAt !== null && s.first > st.settledAt;
    const appeared = [];
    for (const [k, s] of stats) if (isNew(s) && matchesId(k)) appeared.push({ id: k, at: s.first, lastSeen: s.last + 59_999, seenMinutes: s.seen });
    appeared.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const info = only ? [...stats].filter(([k]) => matchesId(k)).map(([k, s]) => ({ id: k, first: s.first, last: s.last + 59_999, seenMinutes: s.seen })) : null;
    return {
      gap: st.gap, baseline, firstMinute: st.firstMinute, lastMinute: st.lastMinute,
      awakeMinutes: st.awake, idCount: stats.size, appeared: appeared.slice(0, st.limit), appearedCount: appeared.length,
      // copies: the kept scan goes on changing its own
      stopped: stopped.map((x) => ({ ...x })), ...(info ? { ids: info } : {}),
      scannedMinutes: st.scanned, totalMinutes: scannedBefore + minutes.length, complete, resumeFrom: token ? st.next : null, resume: token
    };
  }

  return { signal, ids, minutesOf, readMinute };
}

/**
 * One CAN search at a time (they read a lot from disk), for everyone. Each
 * owner (a user) has at most one: a newer search stops the older one, which
 * answers 409. At most `waiting` wait behind the running one; more get 429.
 * run(owner, fn) -> { done, cancel(why) }; fn(stop) is given an AbortSignal,
 * set when it is cancelled, that the search checks between minutes.
 */
function createSearchQueue({ waiting = 4 } = {}) {
  const queue = [];
  let running = null;
  const stoppedError = (why) => searchError(why || 'The search was stopped.', 409);
  function cancel(job, why) {
    job.why = why;
    job.stop.abort();
    const i = queue.indexOf(job);
    if (i >= 0) { queue.splice(i, 1); job.reject(stoppedError(why)); }
  }
  function next() {
    if (running || !queue.length) return;
    const job = queue.shift();
    running = job;
    Promise.resolve()
      .then(() => { if (job.stop.signal.aborted) throw stoppedError(job.why); return job.fn(job.stop.signal); })
      .catch((err) => { throw job.stop.signal.aborted && err.status === 409 ? stoppedError(job.why) : err; })
      .then(job.resolve, job.reject)
      .finally(() => { running = null; next(); });
  }
  function run(owner, fn) {
    for (const j of [running, ...queue]) if (j && owner && j.owner === owner) cancel(j, 'Stopped: a newer search took its place.');
    if (queue.length >= waiting) {
      return { done: Promise.reject(searchError('The CAN search is busy with other searches: try again in a minute.', 429)), cancel() {} };
    }
    const job = { owner, fn, stop: new AbortController(), why: null };
    const done = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    queue.push(job);
    next();
    return { done, cancel: (why) => cancel(job, why) };
  }
  return { run, size: () => queue.length + (running ? 1 : 0) };
}

module.exports = { createCanSearch, createSearchQueue, footageAt, clipStamps, localKey, localTime, parseWhen, OPS };
