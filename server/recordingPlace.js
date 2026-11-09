'use strict';

// Where a recording was, for the Footage page's place tag ("at Home", or
// "Home → Work"): the car's position at the start and the end of the
// recording, best source first:
//
//   1. CAN Bridge GPS (0x04F GPSLatitude04F / GPSLongitude04F, with
//      GPSAccuracy04F in metres), when the recording has CAN data: only fixes
//      of CAN_FIX_MAX_M or better, read from the CAN index's minute files at the
//      recording's first and last minutes (a few minutes inward when those have
//      no fix), each file read once while it does not change;
//   2. the cameras' GPS from the speed index (the first indexed front clip's
//      first position, the last one's last position);
//   3. for Sentry and Saved events, Tesla's event.json estimate, which CAN GPS
//      at the event time beats.
//
// A recording is at a place when it starts and ends there (parked at Work, or
// a loop from Home); otherwise from and to name where it started and ended.

const fsp = require('fs/promises');
const path = require('path');
const fmt = require('./canFormat');
const { CLIP_MS } = require('./canFootage');

const CAN_FIX_MAX_M = 15; // a CAN GPS fix counts when its accuracy is this or better (metres)
const CAN_INWARD_MIN = 5; // minutes looked at from each end of a recording for a fix
const VIDEO_INWARD_CLIPS = 5; // front clips looked at from each end for a position
const CAN_SLACK_MS = 30_000; // a fix this close outside the recording still counts (the car is where it was)
const EVENT_NEAR_MS = 120_000; // a fix this close to an event's time is where the event was
const FIXES_KEPT = 20_000; // minute files whose fixes are kept
const RECS_KEPT = 20_000; // recordings whose CAN ends are kept
const SIG = { lat: 'GPSLatitude04F', lon: 'GPSLongitude04F', acc: 'GPSAccuracy04F' };
const TS = /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/;

const goodPos = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** A minute's good fixes: [[UTC ms, lat, lon, accuracy m], …] by time (signals as point lists, ms into minute t). */
function fixesOf(signals, t) {
  const lat = signals?.[SIG.lat];
  const lon = signals?.[SIG.lon];
  const acc = signals?.[SIG.acc];
  if (!Array.isArray(lat) || !Array.isArray(lon) || !Array.isArray(acc) || !acc.length) return [];
  const lonAt = new Map(lon.map((p) => [p[0], p[1]]));
  const accAt = new Map(acc.map((p) => [p[0], p[1]]));
  const out = [];
  for (const [ms, la] of lat) {
    const lo = lonAt.get(ms);
    let ac = accAt.get(ms);
    if (ac === undefined) {
      // the nearest accuracy within a second (the same frame carries all three, so this is rare)
      let best = null;
      for (const [m2, v] of acc) if (Math.abs(m2 - ms) <= 1000 && (!best || Math.abs(m2 - ms) < best[0])) best = [Math.abs(m2 - ms), v];
      ac = best ? best[1] : undefined;
    }
    if (!goodPos(la, lo) || !Number.isFinite(ac) || ac < 0 || ac > CAN_FIX_MAX_M) continue;
    out.push([t + ms, la, lo, ac]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** A recording's front clips in time order: [{ rel, day, stamp }]. */
function frontClips(rec, files) {
  const out = [];
  for (const rel of rec?.clipRels || []) {
    const f = files?.get(rel);
    if ((f?.camera || (/-front\.mp4$/i.test(rel) ? 'front' : null)) !== 'front') continue;
    const m = TS.exec(String(rel).split('/').pop());
    if (m) out.push({ rel, day: f?.day || m[1].slice(0, 10), stamp: m[1] });
  }
  return out.sort((a, b) => a.stamp.localeCompare(b.stamp));
}

/** A clip stamp from a display time ("YYYY-MM-DD HH:MM:SS"). */
const stampOf = (display) => (display && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(display) ? display.replace(' ', '_').replace(/:/g, '-') : null);

/**
 * keysFor(vid) -> the car's CAN keys, canFile(key, t) -> a minute file's path,
 * utcOf(v, stamp) -> a clip stamp in UTC ms in the car's zone, clipStats(vid, day)
 * -> the speed index's clip stats, filesOf(vid) -> the scan's file map,
 * generation() -> the CAN index's change counter.
 */
function createRecordingPlaces({ keysFor, canFile, utcOf, clipStats, filesOf, generation = () => 0 }) {
  const fixCache = new Map(); // file -> { stamp, fixes | promise }
  const recCache = new Map(); // `${vid}/${rec.id}` -> { sig, ends }

  async function minuteFixes(key, t) {
    const file = canFile(key, t);
    let st;
    try { st = await fsp.stat(file); } catch { return []; }
    const stamp = `${st.size}/${Math.round(st.mtimeMs)}`;
    const had = fixCache.get(file);
    if (had && had.stamp === stamp) return had.fixes;
    const p = fmt.readMinuteFile(file).then((data) => fixesOf(data?.signals, t));
    fixCache.set(file, { stamp, fixes: p });
    if (fixCache.size > FIXES_KEPT) fixCache.delete(fixCache.keys().next().value);
    const fixes = await p;
    if (fixCache.get(file)?.fixes === p) fixCache.set(file, { stamp, fixes });
    return fixes;
  }
  async function fixesAt(keys, t) {
    const all = [];
    for (const key of keys) for (const f of await minuteFixes(key, t)) all.push(f);
    return all.sort((a, b) => a[0] - b[0]);
  }
  const pos = (f) => (f ? { lat: f[1], lon: f[2], accuracy: f[3] } : null);

  /** CAN GPS at the start and end of [from, to) (UTC ms): { a, z } ({ lat, lon, accuracy } or null). */
  async function canEnds(keys, from, to) {
    if (!keys.length || !Number.isFinite(from) || !Number.isFinite(to) || to < from) return { a: null, z: null };
    const first = Math.floor((from - CAN_SLACK_MS) / 60_000) * 60_000;
    const last = Math.floor((to + CAN_SLACK_MS) / 60_000) * 60_000;
    let a = null;
    for (let t = first, n = 0; t <= last && n <= CAN_INWARD_MIN && !a; t += 60_000, n++) {
      a = (await fixesAt(keys, t)).find((f) => f[0] >= from - CAN_SLACK_MS && f[0] <= to + CAN_SLACK_MS) || null;
    }
    let z = null;
    for (let t = last, n = 0; t >= first && n <= CAN_INWARD_MIN && !z; t -= 60_000, n++) {
      const fs = (await fixesAt(keys, t)).filter((f) => f[0] >= from - CAN_SLACK_MS && f[0] <= to + CAN_SLACK_MS);
      z = fs.length ? fs[fs.length - 1] : null;
    }
    return { a: pos(a), z: pos(z) };
  }

  /** The CAN GPS fix nearest `at` (UTC ms) within two minutes, or null. */
  async function canNear(keys, at) {
    if (!keys.length || !Number.isFinite(at)) return null;
    const m = Math.floor(at / 60_000) * 60_000;
    let best = null;
    for (const t of [m, m - 60_000, m + 60_000, m - 120_000, m + 120_000]) {
      for (const f of await fixesAt(keys, t)) {
        const d = Math.abs(f[0] - at);
        if (d <= EVENT_NEAR_MS && (!best || d < best[0])) best = [d, f];
      }
    }
    return best ? pos(best[1]) : null;
  }

  /** The cameras' GPS at a recording's start and end: { a, z } ({ lat, lon } or null). */
  async function videoEnds(vid, rec) {
    const clips = frontClips(rec, filesOf(vid));
    if (!clips.length) return { a: null, z: null };
    const days = new Map();
    const statsOf = async (c) => {
      if (!days.has(c.day)) days.set(c.day, await clipStats(vid, c.day).catch(() => ({})));
      return days.get(c.day)[c.rel] || null;
    };
    // from each end inward, over clips that were read (a clip not read yet: that end is not known yet,
    // as the index reads a day newest first and would leave a start wrong otherwise)
    const walk = async (list, key) => {
      for (const c of list.slice(0, VIDEO_INWARD_CLIPS)) {
        const s = await statsOf(c);
        if (!s) return null;
        const p = s[key];
        if (Array.isArray(p) && goodPos(Number(p[0]), Number(p[1]))) return { lat: Number(p[0]), lon: Number(p[1]) };
      }
      return null;
    };
    return { a: await walk(clips, 'a'), z: await walk([...clips].reverse(), 'z') };
  }

  /** A recording's CAN ends (cached until the index, the car's keys, its zone or its clips change). */
  async function canEndsOf(v, rec, keys) {
    const stamps = frontClips(rec, filesOf(v.id)).map((c) => c.stamp);
    if (!stamps.length && rec.startKey && TS.test(rec.startKey)) stamps.push(TS.exec(rec.startKey)[1]);
    if (!stamps.length) return { a: null, z: null };
    const sig = `${generation()}|${keys.join(',')}|${v.timezone || 'UTC'}|${stamps[0]}|${stamps[stamps.length - 1]}`;
    const k = `${v.id}/${rec.id}`;
    const had = recCache.get(k);
    if (had && had.sig === sig) return had.ends;
    const from = utcOf(v, stamps[0]);
    const to = utcOf(v, stamps[stamps.length - 1]) + CLIP_MS;
    const ends = await canEnds(keys, from, to);
    recCache.delete(k);
    recCache.set(k, { sig, ends });
    if (recCache.size > RECS_KEPT) recCache.delete(recCache.keys().next().value);
    return ends;
  }

  /**
   * The place fields of a recording of car `v`: { place, from?, to?, placeSource? }.
   * hasCan(rec) says whether CAN data covers it; eventPos(rec) -> event.json's position
   * (events only); placeOf(pos) -> the saved place there, or null.
   */
  async function tag(v, rec, { hasCan = null, eventPos = null, placeOf }) {
    const keys = hasCan && hasCan(rec) ? [...await keysFor(v.id)].sort() : [];
    const name = (p) => (p ? placeOf(p)?.name ?? null : null);
    if (rec.eventId) {
      const at = stampOf(rec.eventAt);
      const can = keys.length && at ? await canNear(keys, utcOf(v, at)) : null;
      if (can) return { place: name(can), placeSource: 'can' };
      const ev = eventPos ? await eventPos(rec) : null;
      if (ev) return { place: name(ev), placeSource: 'event' };
      const { z } = await videoEnds(v.id, rec);
      return z ? { place: name(z), placeSource: 'video' } : { place: null };
    }
    const can = keys.length ? await canEndsOf(v, rec, keys) : { a: null, z: null };
    const video = can.a && can.z ? { a: null, z: null } : await videoEnds(v.id, rec);
    const a = can.a || video.a;
    const z = can.z || video.z;
    if (!a || !z) return { place: null };
    const placeSource = can.a && can.z ? 'can' : 'video';
    const from = name(a);
    const to = name(z);
    if (from && from === to) return { place: from, placeSource };
    if (!from && !to) return { place: null };
    return { place: null, from, to, placeSource };
  }

  return { tag, canEnds, canNear, videoEnds, forget: () => { fixCache.clear(); recCache.clear(); } };
}

/** A CAN index minute file's path. */
const minuteFileOf = (dir) => (key, t) => path.join(dir, key, `${new Date(t).toISOString().slice(0, 16).replace(/[-:]/g, '')}.json.gz`);

module.exports = { createRecordingPlaces, fixesOf, frontClips, minuteFileOf, CAN_FIX_MAX_M, SIG };
