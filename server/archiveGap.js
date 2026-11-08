'use strict';

// Archive gaps: footage the car recorded that has not reached the share.
//
// A car's USB drive that archives itself over Wi-Fi (a Sentry USB, a
// TeslaUSB) copies the clips to the NAS some time after the car wrote them,
// and makes room for new footage by recycling old clips. Footage it has not
// copied by then is lost, and Sentry Six Manager can only show what is on the
// share. So after every scan each car's last seven days are looked at for
// signs that some of what the car recorded is missing from the share:
//
//   can      CAN Bridge logs show the car driving (gear D or R, or moving) in
//            minutes with no footage at all. The strongest sign, only for cars
//            with CAN logs. "Awake" alone is not enough: a car wakes to
//            charge, for climate or for the app without recording.
//   cutoff   a drive whose footage stops while the car is moving (the speed
//            index: the last seconds of its last front clip above 3 m/s), with
//            the next footage minutes later. A car does not stop recording
//            while it drives.
//   partial  a minute with only some of its cameras, when the minutes either
//            side have them (a copy cut off part way).
//   filling  clips of the day still arriving hours after they were recorded
//            (the file's arrival time on the share, its birth or change time,
//            against its modified time, which the archive keeps): the archive
//            is behind. Only a tag; no notification.
//
// A minute counts only once it is GRACE old, and, if nothing the car recorded
// later is on the share yet (the archive has not got that far), LONG_GRACE
// old. A parked, sleeping car never warns: it has no CAN driving minutes, no
// drive cut off, no partial minute. A car with no Recent clips on the share
// in the last two weeks (its archive leaves RecentClips out) is not checked
// for missing drives.
//
// One notification (kind 'archive', so it can be turned off in the
// notification rules) per car and day, dedupe key archive:<vid>:<day>. It is
// updated as the evidence changes and resolved when the footage arrives; one
// the owner dismissed comes back only when the gap grows a good deal.

const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { localKey } = require('./canSearch');

const gunzip = promisify(zlib.gunzip);
const MIN = 60;
const HOUR = 3600;
const GRACE_S = 3 * HOUR; // a minute is looked at once it is this old ...
const LONG_GRACE_S = 24 * HOUR; // ... or this old when nothing later is on the share yet
const WINDOW_DAYS = 7;
const HABIT_DAYS = 14;
const MOVING = 3; // m/s (about 11 km/h)
const MOVING_KPH = 3;
const GAP_S = 3 * MIN; // footage that stops while moving and goes on this much later: a cut
const LATE_MS = 3600 * 1000; // a clip that reached the share this long after it was written is late
const FILLING_MS = 2 * 3600 * 1000; // ... and the day is still filling if one arrived this recently
const BULK_MS = 30 * 24 * 3600 * 1000; // later than this: a restore or a copy on the NAS, not the archive
const BULK_FILES = 20; // ... and this many old clips arriving at once is such a copy
const MAX_DECODE = 3000; // CAN minutes read in one check (the rest next time)
const TS = /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/;
const MINUTE_FILE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})\.json\.gz$/;
const KEY = /^[A-Za-z0-9-]{1,64}$/;

/** A clip name's wall-clock time as seconds, treating it as UTC (only differences matter). */
function stampSec(name) {
  const m = TS.exec(String(name));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : null;
}
const keyOfSec = (s) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
const dayOfSec = (s) => keyOfSec(s).slice(0, 10);
const hhmm = (s) => keyOfSec(s).slice(11, 16).replace('-', ':');
/** The moment `ms` on the car's clock, as seconds (stampSec's scale). */
const wallSec = (ms, tz) => stampSec(localKey(ms, tz));

/** When a file reached the share: its birth time where the share has one, else its change time. */
function arrivalOf(f) {
  if (Number(f.birthtimeMs) > 0) return f.birthtimeMs;
  if (Number(f.ctimeMs) > 0) return f.ctimeMs;
  return null;
}

/** Is a moment (seconds) inside some clip? `starts` sorted clip starts. */
function covered(starts, s) {
  let lo = 0;
  let hi = starts.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= s) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best >= 0 && s - starts[best] < 62;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const dayLabel = (day) => {
  try { return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); } catch { return day; }
};

/** Consecutive minutes (seconds, sorted) as runs [[from, to], …]. */
function runsOf(minutes) {
  const out = [];
  for (const m of minutes) {
    const last = out[out.length - 1];
    if (last && m - last[1] <= MIN) last[1] = m;
    else out.push([m, m]);
  }
  return out;
}

/**
 * The gaps of one car, from what Sentry Six Manager holds (no I/O):
 *   files       the scan's file records (rel, size, mtimeMs, ctimeMs, birthtimeMs, kind, type, camera)
 *   nowMs, tz   now, and the car's time zone (its clip names are its wall clock)
 *   encoded     rels the converter has rewritten (their file times say nothing of the archive)
 *   speeds      Map(rel -> speeds a second, m/s) of indexed front clips
 *   canDriving  wall-clock seconds of minutes CAN Bridge shows driving with no footage, or null (no CAN data)
 * { days: { day: finding }, stalled, signals }
 */
function analyze({ files, nowMs, tz = 'UTC', encoded = new Set(), speeds = new Map(), canDriving = null, windowDays = WINDOW_DAYS }) {
  const now = wallSec(nowMs, tz);
  const firstDay = dayOfSec(now - (windowDays - 1) * 86400);
  const clips = [];
  for (const f of files.values ? files.values() : files) {
    if (f.kind !== 'clip' || !(f.size > 0)) continue;
    const name = path.posix.basename(f.rel);
    const s = stampSec(name);
    if (s === null) continue;
    clips.push({ f, s, dir: path.posix.dirname(f.rel), recent: f.type === 'RecentClips' });
  }
  const starts = [...new Set(clips.map((c) => c.s))].sort((a, b) => a - b);
  const recentStarts = [...new Set(clips.filter((c) => c.recent).map((c) => c.s))].sort((a, b) => a - b);
  const newestRecent = recentStarts.length ? recentStarts[recentStarts.length - 1] : null;
  // the archive copies the car's Recent clips at all (some leave them out)
  const habit = recentStarts.some((s) => s >= now - HABIT_DAYS * 86400);
  const days = {};
  const dayOf = (d) => (days[d] ||= { day: d, missing: new Set(), can: [], cutoffs: [], partial: [], late: 0, maxLateMs: 0, lastArrival: 0 });
  // a minute is looked at once it is old enough, and long enough if the archive has not got past it
  const due = (s) => now - s >= GRACE_S && ((newestRecent !== null && newestRecent > s + MIN) || now - s >= LONG_GRACE_S);
  const inWindow = (s) => dayOfSec(s) >= firstDay;

  // can: driving minutes with no footage
  if (canDriving && habit) {
    for (const m of [...new Set(canDriving)].sort((a, b) => a - b)) {
      if (!inWindow(m) || !due(m) || covered(starts, m + 30)) continue;
      const d = dayOf(dayOfSec(m));
      d.missing.add(m);
      d.can.push(m);
    }
  }

  // cutoff: footage that stops while the car is moving
  if (habit && speeds.size) {
    const front = clips.filter((c) => c.recent && c.f.camera === 'front' && Array.isArray(speeds.get(c.f.rel))).sort((a, b) => a.s - b.s);
    const values = (c) => speeds.get(c.f.rel).filter((v) => Number.isFinite(v));
    for (const c of front) {
      if (!inWindow(c.s)) continue;
      const v = values(c);
      if (v.length < 40) continue; // a short clip: the recording ended there anyway
      const tail = v.slice(-3);
      if (tail.length < 3 || !tail.every((x) => x > MOVING)) continue;
      const end = c.s + MIN;
      // the next footage of any kind after this minute
      const nextIdx = starts.findIndex((s) => s > c.s);
      const next = nextIdx >= 0 ? starts[nextIdx] : null;
      if (next !== null && next - end < GAP_S) continue;
      if (now - end < GRACE_S || (next === null && now - end < LONG_GRACE_S)) continue;
      let lost = 1; // at least the minute that should have followed
      if (next !== null && next - end <= 3 * HOUR) {
        const after = front.find((x) => x.s === next);
        const head = after ? values(after).slice(0, 3) : [];
        // moving at both ends: the car drove the whole time in between
        if (head.length === 3 && head.every((x) => x > MOVING)) lost = Math.max(1, Math.floor((next - end) / MIN));
      }
      const d = dayOf(dayOfSec(c.s));
      for (let i = 0; i < lost; i++) {
        const m = end + i * MIN;
        if (dayOfSec(m) === d.day && !covered(starts, m + 30)) d.missing.add(m);
      }
      d.cutoffs.push({ at: c.s + v.length, kph: Math.round(tail[tail.length - 1] * 3.6), next, lost });
    }
  }

  // partial: a minute with only some of the cameras its neighbours have
  const byDir = new Map();
  for (const c of clips) {
    let m = byDir.get(c.dir);
    if (!m) byDir.set(c.dir, (m = new Map()));
    let e = m.get(c.s);
    if (!e) m.set(c.s, (e = { s: c.s, cams: new Set(), arrival: 0 }));
    if (c.f.camera) e.cams.add(c.f.camera);
    e.arrival = Math.max(e.arrival, arrivalOf(c.f) || 0);
  }
  for (const m of byDir.values()) {
    const list = [...m.values()].sort((a, b) => a.s - b.s);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!inWindow(e.s) || now - e.s < GRACE_S) continue;
      const prev = i > 0 && e.s - list[i - 1].s <= 90 ? list[i - 1] : null;
      const next = i + 1 < list.length && list[i + 1].s - e.s <= 90 ? list[i + 1] : null;
      if (!prev && !next) continue;
      const ref = [prev, next].filter(Boolean);
      const lacking = [...ref[0].cams].filter((cam) => !e.cams.has(cam) && ref.every((r) => r.cams.has(cam)));
      if (!lacking.length) continue;
      // the last minute of a folder may still be being copied
      if (!next && !(e.arrival ? nowMs - e.arrival >= FILLING_MS && now - e.s >= GRACE_S : now - e.s >= LONG_GRACE_S)) continue;
      dayOf(dayOfSec(e.s)).partial.push({ at: e.s, has: e.cams.size, of: e.cams.size + lacking.length, lacking: lacking.sort() });
    }
  }

  // filling: clips still reaching the share hours after they were written.
  // Not when many clips older than the window "arrived" lately as well: that
  // is the share copied or restored on the NAS, not the car's archive.
  let bulk = 0;
  for (const c of clips) {
    const arrival = arrivalOf(c.f);
    if (!inWindow(c.s) && arrival && nowMs - arrival < 24 * 3600 * 1000 && arrival - c.f.mtimeMs > LATE_MS) bulk++;
  }
  let informative = false;
  for (const c of clips) {
    if (bulk >= BULK_FILES) break;
    if (!inWindow(c.s) || encoded.has(c.f.rel)) continue;
    const arrival = arrivalOf(c.f);
    if (!arrival || !(c.f.mtimeMs > 0)) continue;
    const lag = arrival - c.f.mtimeMs;
    if (lag > BULK_MS || lag < LATE_MS) continue;
    informative = true;
    const d = dayOf(dayOfSec(c.s));
    d.late++;
    d.maxLateMs = Math.max(d.maxLateMs, lag);
    d.lastArrival = Math.max(d.lastArrival, arrival);
  }

  const out = {};
  for (const d of Object.values(days)) {
    const missingMinutes = d.missing.size;
    const partialMinutes = d.partial.length;
    const filling = d.late >= 4 && nowMs - d.lastArrival < FILLING_MS;
    // one partial minute alone is not enough (a camera can miss a minute)
    const partial = missingMinutes > 0 || partialMinutes >= 2;
    if (!partial && !filling) continue;
    const finding = {
      day: d.day,
      state: partial ? 'partial' : 'filling',
      missingMinutes,
      partialMinutes,
      lateClips: d.late,
      maxLateHours: Math.round(d.maxLateMs / 360000) / 10,
      can: runsOf(d.can).map(([a, b]) => ({ from: keyOfSec(a), to: keyOfSec(b), minutes: Math.round((b - a) / MIN) + 1 })),
      cutoffs: d.cutoffs.map((x) => ({ at: keyOfSec(x.at), kph: x.kph, next: x.next === null ? null : keyOfSec(x.next), minutes: x.lost })),
      partial: d.partial.map((x) => ({ at: keyOfSec(x.at), cameras: x.has, of: x.of, lacking: x.lacking }))
    };
    finding.summary = summarize(finding);
    out[d.day] = finding;
  }

  // stalled: nothing new on the share for a while from a car that usually has footage most days
  let stalled = null;
  if (clips.length) {
    let newest = 0;
    for (const c of clips) newest = Math.max(newest, arrivalOf(c.f) || 0, c.f.mtimeMs || 0);
    const quiet = nowMs - newest;
    const lastDay = dayOfSec(starts[starts.length - 1]);
    const dayset = new Set(starts.map(dayOfSec));
    let had = 0;
    for (let i = 0; i < HABIT_DAYS; i++) if (dayset.has(dayOfSec(stampSec(`${lastDay}_12-00-00`) - i * 86400))) had++;
    if (quiet >= 36 * 3600 * 1000 && had / HABIT_DAYS >= 0.6) stalled = { since: newest, hours: Math.round(quiet / 3600000), usualDays: had, of: HABIT_DAYS };
  }
  return { days: out, stalled, signals: { can: Boolean(canDriving) && habit, speed: habit && speeds.size > 0, arrival: informative, recent: habit } };
}

/** The evidence in plain words (for the tag's tooltip and the notification). */
function summarize(f) {
  const bits = [];
  const t = (k) => k.slice(11, 16).replace('-', ':');
  if (f.can.length) {
    const runs = f.can.slice(0, 3).map((r) => (r.minutes > 1 ? `${t(r.from)}–${t(r.to)}` : t(r.from)));
    const extra = f.can.length - 3;
    const more = extra > 0 ? ` and ${extra} more stretch${extra === 1 ? '' : 'es'}` : '';
    const list = runs.length > 1 && !more ? `${runs.slice(0, -1).join(', ')} and ${runs[runs.length - 1]}` : runs.join(', ');
    bits.push(`CAN Bridge shows the car driving ${list}${more} with no footage`);
  }
  for (const c of f.cutoffs.slice(0, 2)) {
    bits.push(`the footage stops at ${c.at.slice(11, 16).replace('-', ':')} while the car is moving (${c.kph} km/h)${c.next ? `, and the next is at ${c.next.slice(11, 16).replace('-', ':')}` : ' and nothing later is on the share'}`);
  }
  if (f.cutoffs.length > 2) bits.push(`${f.cutoffs.length - 2} more drives stop like that`);
  if (f.partialMinutes) {
    const p = f.partial[0];
    bits.push(`${plural(f.partialMinutes, 'minute')} ${f.partialMinutes === 1 ? 'has' : 'have'} only some cameras${f.partialMinutes === 1 ? ` (${p.cameras} of ${p.of} at ${p.at.slice(11, 16).replace('-', ':')})` : ''}`);
  }
  if (f.lateClips) bits.push(`clips are reaching the share up to ${f.maxLateHours} h after they were recorded`);
  let head;
  if (f.state === 'filling') head = 'Still being copied: ';
  else if (f.missingMinutes) head = `About ${plural(f.missingMinutes, 'minute')} the car recorded ${f.missingMinutes === 1 ? 'is' : 'are'} not on the share: `;
  else head = 'Some footage looks only partly copied: ';
  const text = bits.join('; ');
  // (lower case after the colon, but not an acronym such as CAN)
  const first = /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() : text.charAt(0);
  return `${head}${first}${text.slice(1)}.`;
}

const ADVICE = 'Check the Sentry USB (or whatever copies the car\'s USB drive to the share): its Logs page, its archive settings and its Wi-Fi to the NAS. Clips it recycles before copying them are lost.';

/** The notification for a finding. */
function noteFor(vehicle, f) {
  return {
    kind: 'archive', level: 'warning', vehicleId: vehicle.id, dedupeKey: `archive:${vehicle.id}:${f.day}`,
    title: `${vehicle.name}: ${dayLabel(f.day)} looks only partly archived`,
    message: `${f.summary} ${ADVICE}`
  };
}
const scoreOf = (f) => f.missingMinutes + f.partialMinutes;

/**
 * The service: check(vid) after each scan (single flight, the latest result
 * kept), results(vid), forDays(vid) for the day cards, and indexed(key, from, to)
 * when CAN Bridge minutes were (re)indexed.
 */
function createArchiveGap({ inventory, vehicles, notes, db, speedIndex = null, canKeysFor = async () => [], canDir = null, log = null, now = () => Date.now() }) {
  const results = new Map(); // vid -> analysis + checkedAt
  const running = new Map();
  const canCache = new Map(); // "<key>/<minute file>" -> driving (true/false)

  async function minuteDriving(key, name) {
    const id = `${key}/${name}`;
    if (canCache.has(id)) return canCache.get(id);
    let driving = false;
    try {
      const data = JSON.parse((await gunzip(await fsp.readFile(path.join(canDir, key, name)))).toString('utf8'));
      const sig = data.signals || {};
      driving = (sig.DI_vehicleSpeed || []).some((p) => p[1] > MOVING_KPH && p[1] < 300)
        || (sig.DI_gear || []).some((p) => p[1] === 4 || p[1] === 2);
    } catch { return false; } // unreadable now: asked again next time
    if (canCache.size > 50_000) canCache.clear();
    canCache.set(id, driving);
    return driving;
  }

  /** CAN driving minutes with no footage, on the car's clock (seconds), or null without CAN data. */
  async function canDrivingOf(v, files, nowMs) {
    if (!canDir) return null;
    const keys = (await canKeysFor(v.id)).filter((k) => KEY.test(k));
    if (!keys.length) return null;
    const tz = v.timezone || 'UTC';
    const starts = [];
    for (const f of files.values()) if (f.kind === 'clip') { const s = stampSec(path.posix.basename(f.rel)); if (s !== null) starts.push(s); }
    starts.sort((a, b) => a - b);
    const from = nowMs - (WINDOW_DAYS + 1) * 86400_000;
    const nowWall = wallSec(nowMs, tz);
    const out = [];
    let read = 0;
    for (const key of keys) {
      let names = [];
      try { names = await fsp.readdir(path.join(canDir, key)); } catch { continue; }
      for (const name of names.sort().reverse()) {
        const m = MINUTE_FILE.exec(name);
        if (!m) continue;
        const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
        if (t < from) continue;
        const s = wallSec(t, tz);
        // only minutes old enough to count and with no footage are read
        if (nowWall - s < GRACE_S || covered(starts, s + 30)) continue;
        if (!canCache.has(`${key}/${name}`) && ++read > MAX_DECODE) continue;
        if (await minuteDriving(key, name)) out.push(s);
      }
    }
    return out;
  }

  async function speedsOf(vid, files, nowMs, tz) {
    const out = new Map();
    if (!speedIndex?.day) return out;
    const today = wallSec(nowMs, tz);
    for (let i = 0; i < WINDOW_DAYS; i++) {
      const d = dayOfSec(today - i * 86400);
      try { for (const [rel, sp] of Object.entries(await speedIndex.day(vid, d))) if (Array.isArray(sp)) out.set(rel, sp); } catch { /* not indexed yet */ }
    }
    return out;
  }

  function encodedSet(vid) {
    const out = new Set();
    try { for (const [rel, v] of inventory.codecs(vid)) if (v.codec === 'h265' || v.codec === 'av1') out.add(rel); } catch { /* none known */ }
    return out;
  }

  /** Raise, update or resolve the car's archive notifications from a fresh analysis. */
  function sync(v, res) {
    const stateKey = `archive-gap:${v.id}`;
    const known = db.get(stateKey, {}) || {};
    const open = new Set((notes.list({ open: true, vehicleId: v.id }) || []).filter((n) => n.kind === 'archive').map((n) => n.dedupeKey).filter(Boolean));
    const firstDay = dayOfSec(wallSec(now(), v.timezone || 'UTC') - (WINDOW_DAYS - 1) * 86400);
    const next = {};
    for (const [key, k] of Object.entries(known)) if (k.day < firstDay) next[key] = k; // older days: left as they are
    for (const f of Object.values(res.days)) {
      if (f.state !== 'partial') continue;
      const n = noteFor(v, f);
      const prev = known[n.dedupeKey];
      const score = scoreOf(f);
      // dismissed (raised before, no longer open): only again when the gap grew a good deal
      if (prev && !open.has(n.dedupeKey) && prev.raised && !(score >= prev.score * 1.5 && score - prev.score >= 10)) {
        next[n.dedupeKey] = prev;
        continue;
      }
      const id = notes.raise(n);
      if (id !== null && id !== undefined) next[n.dedupeKey] = { day: f.day, score, raised: true };
    }
    for (const [key, k] of Object.entries(known)) {
      if (k.day < firstDay || next[key]) continue;
      notes.resolve(key); // caught up (or no longer looks missing)
    }
    db.set(stateKey, next);
  }

  function check(vid) {
    if (running.has(vid)) return running.get(vid);
    const p = (async () => {
      const v = vehicles.get(vid);
      const entry = inventory.get(vid);
      if (!v || !entry?.files) return null;
      const nowMs = now();
      const tz = v.timezone || 'UTC';
      const res = analyze({
        files: entry.files, nowMs, tz, encoded: encodedSet(vid),
        speeds: await speedsOf(vid, entry.files, nowMs, tz),
        canDriving: await canDrivingOf(v, entry.files, nowMs)
      });
      res.checkedAt = nowMs;
      results.set(vid, res);
      sync(v, res);
      return res;
    })().catch((err) => { log?.warn(`Archive gap check: ${err.message}`); return null; }).finally(() => running.delete(vid));
    running.set(vid, p);
    return p;
  }

  return {
    check,
    /** The last analysis (checked now when there is none). */
    async results(vid) { return results.get(vid) || (await check(vid)) || { days: {}, stalled: null, signals: {}, checkedAt: null }; },
    /** { day: { state, missingMinutes, partialMinutes, summary } } for the day cards (no check started). */
    forDays(vid) {
      const out = {};
      for (const [d, f] of Object.entries(results.get(vid)?.days || {})) out[d] = { state: f.state, missingMinutes: f.missingMinutes, partialMinutes: f.partialMinutes, lateClips: f.lateClips, maxLateHours: f.maxLateHours, summary: f.summary };
      return out;
    },
    /** A CAN log was indexed: forget what was read of its minutes. */
    indexed(key, from, to) {
      for (const id of [...canCache.keys()]) {
        if (!id.startsWith(`${key}/`)) continue;
        const m = MINUTE_FILE.exec(id.slice(key.length + 1));
        const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
        if (t === null || !Number.isFinite(from) || (t + 60_000 > from && t <= to)) canCache.delete(id);
      }
    },
    forget(vid) { results.delete(vid); db.resolvePrefix?.(`archive:${vid}:`); db.set(`archive-gap:${vid}`, {}); notes.emit?.('changed'); }
  };
}

module.exports = { createArchiveGap, analyze, summarize, noteFor, stampSec, covered, ADVICE };
