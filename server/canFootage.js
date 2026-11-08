'use strict';

// Which recordings have CAN Bridge data (the green "CAN" tag on the Footage
// page): a recording has it when the Viewer would show car data for it, that
// is when an indexed minute of one of the car's CAN keys (the keys the Viewer
// reads: mapped to this car, or not mapped at all when there is one car)
// overlaps the recording's clips, from its first clip's start to its last
// clip's end. Only logs that may be used are indexed (canTrust: verified,
// unsigned before pairing, or a failed one used anyway), and a log that is
// deleted or no longer used leaves the index, so the tag follows the same
// rules as the Viewer.
//
// Cheap: per car, the sorted minute starts of its keys are kept until the
// index changes (its generation), the car's keys change (the Nerd mapping, a
// new key) or its time zone does; each clip name's UTC start is worked out
// once per zone.

const CLIP_MS = 62_000; // a Tesla clip is a minute, a second or two more
const MINUTE_MS = 60_000;
const TS = /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/;
const STAMPS_KEPT = 200_000;

/** The first index of sorted `arr` whose value is >= x. */
function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Whether an indexed minute in `minutes` (sorted starts) overlaps [from, to). */
function minuteIn(minutes, from, to) {
  const i = lowerBound(minutes, from - MINUTE_MS + 1);
  return i < minutes.length && minutes[i] < to;
}

/** A recording's first and last clip name stamps (YYYY-MM-DD_HH-MM-SS), or null. */
function clipRange(rec) {
  let first = null;
  let last = null;
  for (const rel of rec?.clipRels || []) {
    const m = TS.exec(String(rel).split('/').pop());
    if (!m) continue;
    if (first === null || m[1] < first) first = m[1];
    if (last === null || m[1] > last) last = m[1];
  }
  if (first === null && rec?.startKey && TS.test(rec.startKey)) first = last = TS.exec(rec.startKey)[1];
  return first === null ? null : { first, last };
}

/**
 * keysFor(vid) -> car keys (as the Viewer reads them), minuteTimes(key) -> sorted UTC minute
 * starts of its index, generation() -> bumped on every index change, startOf(v, name) -> a
 * clip name's start in UTC ms in the car's zone.
 */
function createCanFootage({ keysFor, minuteTimes, generation, startOf }) {
  const cars = new Map(); // vid -> { sig, minutes, zone, stamps: Map(stamp -> UTC ms) }

  async function minutesOf(v) {
    const keys = [...await keysFor(v.id)].sort();
    const zone = v.timezone || 'UTC';
    const sig = `${generation()}|${keys.join(',')}`;
    let c = cars.get(v.id);
    if (c?.zone !== zone) c = { sig: null, minutes: [], zone, stamps: new Map() };
    if (c.sig !== sig) {
      const all = [];
      for (const key of keys) for (const t of await minuteTimes(key)) all.push(t);
      all.sort((a, b) => a - b);
      c.minutes = all.filter((t, i) => i === 0 || t !== all[i - 1]);
      c.sig = sig;
    }
    cars.set(v.id, c);
    return c;
  }

  /** A function rec -> true when CAN data covers that recording of car `v` (its minutes read once). */
  async function forVehicle(v) {
    const c = await minutesOf(v);
    if (!c.minutes.length) return () => false;
    const utc = (stamp) => {
      let t = c.stamps.get(stamp);
      if (t === undefined) {
        t = startOf(v, stamp);
        if (c.stamps.size >= STAMPS_KEPT) c.stamps.clear();
        c.stamps.set(stamp, t);
      }
      return t;
    };
    return (rec) => {
      const r = clipRange(rec);
      if (!r) return false;
      const from = utc(r.first);
      const to = utc(r.last);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
      return minuteIn(c.minutes, from, Math.max(from, to) + CLIP_MS);
    };
  }

  return { forVehicle, forget: (vid) => cars.delete(vid) };
}

module.exports = { createCanFootage, minuteIn, clipRange, CLIP_MS };
