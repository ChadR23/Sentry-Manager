'use strict';

// Drives: a vehicle's trips, as Sentry Studio's Drives tab groups them
// (src/renderer/scripts/core/driveGrouper.js): clips back to back, a gap of
// more than 5 minutes (by default) between the end of one and the start of
// the next starts a new drive. Only the car's own recording counts (Recent
// clips and other loose clips); Sentry and Saved events are copies kept for
// an event, not drives.
//
// Where the speed index (server/speedIndex.js) has read a clip, its speeds
// say when the car really moved: a clip of the car standing still (Sentry
// Mode keeps Recent clips going while parked) is not driving, and a drive
// starts at the first second moving and ends at the last, so a stop of more
// than the gap (parked with the camera on) ends one drive and the next
// movement starts another. A clip not read yet, or without driving data,
// counts as a minute of driving, as in Studio.
//
// Nothing is kept but the clip list per scan (rebuilt when the recordings
// change) and the speed index's own per-day numbers (clipStats), so a page of
// drives reads only the days it shows: newest first, `limit` at a time, and
// `before` (the first clip of the last drive shown) for the next page.

const TS = /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/;
const CLIP_S = 60;
const DEFAULT_GAP_S = 5 * 60;

/** Seconds of a clip name's wall-clock time (as if UTC: only differences and the clock text matter). */
function keySeconds(key) {
  const m = TS.exec(String(key || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : null;
}

/** "YYYY-MM-DD HH:MM:SS" of wall-clock seconds. */
const wall = (s) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ');

const clipCache = new WeakMap(); // recordings array -> clips

/**
 * The car's own clips of a scan, one per minute, oldest first:
 * [{ key, t, day, rel (the front camera's, else any), rels, rec }].
 * Sentry and Saved events are left out.
 */
function clipsOf(recordings) {
  if (!Array.isArray(recordings)) return [];
  const had = clipCache.get(recordings);
  if (had) return had;
  const byKey = new Map();
  for (const rec of recordings) {
    if (rec.eventId || rec.type === 'SentryClips' || rec.type === 'SavedClips') continue;
    for (const rel of rec.clipRels || []) {
      const name = String(rel).split('/').pop();
      const m = TS.exec(name);
      if (!m) continue;
      const key = m[0];
      let c = byKey.get(key);
      if (!c) {
        c = { key, t: keySeconds(key), day: key.slice(0, 10), rel, front: false, rec };
        byKey.set(key, c);
      }
      if (!c.front && /-front\.mp4$/i.test(name)) { c.rel = rel; c.front = true; c.rec = rec; }
    }
  }
  const out = [...byKey.values()].sort((a, b) => a.t - b.t);
  clipCache.set(recordings, out);
  return out;
}

/** When a clip had driving in it: [from, to] in wall seconds, or null when the car stood still all of it. */
function activityOf(clip, stats) {
  if (!stats) return [clip.t, clip.t + CLIP_S]; // not read yet, or no driving data: a minute of driving
  if (stats.m <= 0 || stats.f < 0) return null;
  return [clip.t + stats.f, clip.t + stats.l + 1];
}

/**
 * Group clips (oldest first) into drives, newest first. statsFor(clip) gives
 * the clip's numbers (speedIndex.clipStats) or null; it may return a promise.
 *   { gapS, limit, before } — before: only clips older than this clip key.
 * Returns { drives: [{ clips: [clip…], from, to }], more } where from and to are
 * wall seconds of the first and last movement.
 */
async function group(clips, statsFor, { gapS = DEFAULT_GAP_S, limit = 50, before = null } = {}) {
  let i = clips.length - 1;
  if (before) {
    const t = keySeconds(before);
    if (t !== null) while (i >= 0 && clips[i].t >= t) i--;
  }
  const found = [];
  let cur = null;
  let more = false;
  for (; i >= 0; i--) {
    const c = clips[i];
    const stats = await statsFor(c);
    const iv = activityOf(c, stats);
    if (!iv) continue;
    if (cur && cur.from - iv[1] > gapS) {
      found.push(cur);
      cur = null;
      if (found.length >= limit) { more = true; break; }
    }
    if (!cur) cur = { hi: i, lo: i, from: iv[0], to: iv[1] };
    else { cur.lo = i; cur.from = Math.min(cur.from, iv[0]); cur.to = Math.max(cur.to, iv[1]); }
  }
  if (cur) found.push(cur);
  return {
    more,
    drives: found.map((d) => ({ clips: clips.slice(d.lo, d.hi + 1), from: d.from, to: d.to }))
  };
}

/**
 * A drive in numbers, for the API: times, length, distance (from the speeds),
 * where it started and ended, what opens it in the Viewer. statsOf(clip) is
 * synchronous here (the stats group() read). label(pos) names a position.
 */
function describe(drive, statsOf, { label = () => null, hasCan = null } = {}) {
  const { clips, from, to } = drive;
  const first = clips[0];
  const last = clips[clips.length - 1];
  let distance = 0; let moving = 0; let top = 0; let brakes = 0; let swerves = 0; let read = 0;
  let a = null; let z = null;
  for (const c of clips) {
    const s = statsOf(c);
    if (!s) continue;
    read++;
    distance += s.d;
    moving += s.m;
    if (s.v > top) top = s.v;
    brakes += s.b;
    swerves += s.t;
    if (!a && s.a) a = s.a;
    if (s.z) z = s.z;
  }
  // the clip where the movement starts, and the second in it
  const startClip = clips.find((c) => c.t + CLIP_S > from) || first;
  const second = Math.max(0, Math.round(from - startClip.t));
  const end = (pos) => (pos ? { lat: pos[0], lon: pos[1], ...label({ lat: pos[0], lon: pos[1] }) } : null);
  const recs = new Set(clips.map((c) => c.rec?.id).filter(Boolean));
  return {
    id: first.key,
    date: wall(from).slice(0, 10),
    start: wall(from),
    end: wall(to),
    seconds: Math.max(0, Math.round(to - from)),
    clips: clips.length,
    recordings: recs.size,
    indexed: read,
    distance: read ? Math.round(distance) : null,
    moving: read ? moving : null,
    top: read ? top : null,
    hardBrakes: read ? brakes : null,
    swerves: read ? swerves : null,
    from: end(a),
    to: end(z),
    can: hasCan ? Boolean(hasCan({ clipRels: [first.rel, last.rel], startKey: first.key })) : false,
    // the Viewer: the day's recordings (by the recording's day), this clip, this second
    open: { recording: startClip.rec?.id || null, day: startClip.rec?.day || startClip.day, clip: startClip.key, second }
  };
}

/**
 * Names a position: the saved place it is at (Home, Work), else the street
 * and town of the nearest Sentry or Saved event within `near` metres (Tesla
 * writes them in event.json), else that town within `town` metres.
 * spots: [{ lat, lon, street, city }]; placeOf(pos) -> saved place or null.
 */
function labeller({ placeOf, spots = [], metres, near = 250, town = 3000 }) {
  return (pos) => {
    const p = placeOf(pos);
    if (p) return { place: p.name, label: p.name };
    let best = null;
    for (const s of spots) {
      if (!s.city && !s.street) continue;
      if (Math.abs(s.lat - pos.lat) > 0.05 || Math.abs(s.lon - pos.lon) > 0.07) continue;
      const m = metres(pos, s);
      if (m <= town && (!best || m < best.m)) best = { s, m };
    }
    if (!best) return { place: null, label: null };
    const { s, m } = best;
    if (m <= near && s.street) return { place: null, label: s.city ? `${s.street}, ${s.city}` : s.street };
    return { place: null, label: s.city || null };
  };
}

module.exports = { clipsOf, group, describe, labeller, activityOf, keySeconds, DEFAULT_GAP_S, CLIP_S };
