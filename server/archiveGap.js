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
//   sentry   CAN Bridge logs show Sentry Mode on in minutes with no footage,
//            once the share has shown that this car records while in Sentry
//            Mode (most of its Sentry minutes have footage). Parked Sentry
//            footage is most of a busy day, and without CAN logs it cannot be
//            told from a car asleep.
//   cutoff   a drive whose footage stops while the car is moving (the speed
//            index: the last seconds of its last front clip above 3 m/s), with
//            the next footage minutes later. A car does not stop recording
//            while it drives.
//   partial  a minute with only some of its cameras, when the minutes either
//            side have them (a copy cut off part way).
//   filling  clips of the day still arriving hours after they were recorded
//            (the file's arrival time on the share, its birth or change time,
//            against the clip's name), or the share still receiving footage
//            while minutes after its newest clip are not there yet: the archive
//            is behind, but working. Only a tag; no notification.
//
// A minute counts only once it is GRACE old, and, if nothing the car recorded
// later is on the share yet (the archive has not got that far), LONG_GRACE
// old with nothing new reaching the share for FILLING (an archive catching up
// after days away from Wi-Fi is not a gap). A parked, sleeping car never warns:
// it has no CAN driving or Sentry minutes, no drive cut off, no partial minute.
// A car whose archive leaves RecentClips out (its Sentry or Saved clips go on
// arriving long after its last Recent clip) is not checked for missing drives.
// CAN minutes that line up with the footage when shifted by whole hours (the
// car's time zone set wrongly, a road trip into another zone) are not counted.
//
// One notification (kind 'archive', so it can be turned off in the
// notification rules) per car and day, dedupe key archive:<vid>:<day>. It is
// updated as the evidence changes and resolved when the footage arrives (the
// day's clip count went up, or the evidence has been gone for hours while every
// check it rested on ran); one the owner dismissed comes back only when the gap
// grows a good deal. A day that leaves the window has its notification resolved.

const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);
const MIN = 60;
const HOUR = 3600;
const GRACE_S = 3 * HOUR; // a minute is looked at once it is this old ...
const LONG_GRACE_S = 24 * HOUR; // ... or this old when nothing later is on the share yet
const WINDOW_DAYS = 7;
const HABIT_DAYS = 14;
const MOVING = 3; // m/s (about 11 km/h)
const MOVING_KPH = 3;
const MAX_KPH = 285; // DI_vehicleSpeed's range ends here; 4095 raw (287.6 km/h) is "not available"
const GAP_S = 3 * MIN; // footage that stops while moving and goes on this much later: a cut
const LATE_MS = 3600 * 1000; // a clip that reached the share this long after it was recorded is late
const FILLING_MS = 2 * 3600 * 1000; // ... and the share is still receiving if one arrived this recently
const BULK_MS = 30 * 24 * 3600 * 1000; // later than this: a restore or a copy on the NAS, not the archive
const BULK_FILES = 20; // ... and this many old clips arriving at once is such a copy
const ABSENT_MS = 6 * 3600 * 1000; // evidence gone this long (every check it rested on ran): resolved
const MAX_DECODE = 3000; // CAN minutes with no footage read in one check (the rest next time)
const LEARN_READS = 300; // CAN minutes with footage read in one check to learn what they show
const LEARN_MIN = 10; // ... this many matching minutes before a key or Sentry recording is trusted
const SHIFTS = Array.from({ length: 27 }, (_, i) => i - 12).filter((k) => k !== 0); // hours tried for a wrong time zone
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
const hhmm = (k) => k.slice(11, 16).replace('-', ':');

const formats = new Map(); // time zone -> Intl.DateTimeFormat (or null: not a zone)
/** The moment `ms` on a clock in `tz`, as seconds (stampSec's scale). */
function wallSec(ms, tz = 'UTC') {
  let f = formats.get(tz);
  if (f === undefined) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { f = null; }
    formats.set(tz, f);
  }
  const t = Math.floor(ms / 1000) * 1000;
  if (!f) return t / 1000;
  const p = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000;
}
/** A wall-clock time in `tz` (stampSec's scale) as real UTC seconds. `cache` keeps the offset per hour. */
function utcOfWall(s, tz = 'UTC', cache = null) {
  const hour = Math.floor(s / HOUR);
  if (cache?.has(hour)) return s - cache.get(hour);
  const offsetAt = (u) => wallSec(u * 1000, tz) - u;
  const first = s - offsetAt(s);
  const off = offsetAt(first);
  cache?.set(hour, off);
  return s - off;
}

/** When a file reached the share: its birth time where the share has one, else its change time. */
function arrivalOf(f) {
  if (Number(f.birthtimeMs) > 0) return f.birthtimeMs;
  if (Number(f.ctimeMs) > 0) return f.ctimeMs;
  return null;
}

/** The clip a moment (seconds) is inside, as an index of `starts` (sorted clip starts), or -1. */
function coverIdx(starts, s) {
  let lo = 0;
  let hi = starts.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= s) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best >= 0 && s - starts[best] < 62 ? best : -1;
}
const covered = (starts, s) => coverIdx(starts, s) >= 0;

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
const runList = (minutes) => runsOf(minutes).map(([a, b]) => ({ from: keyOfSec(a), to: keyOfSec(b), minutes: Math.round((b - a) / MIN) + 1 }));

/**
 * The gaps of one car, from what Sentry Six Manager holds (no I/O):
 *   files        the scan's file records (rel, size, mtimeMs, ctimeMs, birthtimeMs, kind, type, camera)
 *   nowMs, tz    now, and the car's time zone (its clip names are its wall clock)
 *   encoded      rels the converter has rewritten (their file times say nothing of the archive)
 *   speeds       Map(rel -> speeds a second, m/s) of indexed front clips
 *   canDriving   wall-clock seconds of minutes CAN Bridge shows driving with no footage, or null (no CAN data)
 *   canSentry    the same for minutes in Sentry Mode (only passed once the car is known to record in Sentry)
 *   canMinutes   wall-clock seconds of every minute CAN Bridge has logged (the car awake), to see the zones match
 *   receivedMs   when the share last received new footage of this car (from the scans), if known
 *   lastRecentS  the newest Recent clip ever seen on the share (stampSec), if known
 * { days: { day: finding }, stalled, signals }
 */
function analyze({ files, nowMs, tz = 'UTC', encoded = new Set(), speeds = new Map(), canDriving = null, canSentry = [], canMinutes = null, receivedMs = null, lastRecentS = null, windowDays = WINDOW_DAYS }) {
  const now = wallSec(nowMs, tz);
  const offsets = new Map();
  const utc = (s) => utcOfWall(s, tz, offsets);
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
  let newestRecent = null;
  let newestOther = null;
  for (const c of clips) {
    if (c.recent) newestRecent = Math.max(newestRecent ?? c.s, c.s);
    else newestOther = Math.max(newestOther ?? c.s, c.s);
  }
  // the archive copies the car's Recent clips at all: some leave them out, and then their
  // Sentry and Saved clips go on arriving long after the last Recent one. An archive that
  // stopped altogether brings nothing at all, and is still checked.
  const everRecent = newestRecent === null ? (lastRecentS ?? null) : Math.max(newestRecent, lastRecentS ?? newestRecent);
  const habit = everRecent !== null && !(newestOther !== null && newestOther > everRecent + HABIT_DAYS * 86400);
  // when the share last received footage of this car: still receiving means catching up
  let received = Number(receivedMs) > 0 ? Number(receivedMs) : 0;
  for (const c of clips) {
    if (encoded.has(c.f.rel)) continue;
    const a = arrivalOf(c.f);
    if (a && a <= nowMs + 60_000) received = Math.max(received, a);
  }
  const catchingUp = received > 0 && nowMs - received < FILLING_MS;
  const days = {};
  const dayOf = (d) => (days[d] ||= { day: d, missing: new Set(), can: [], sentry: [], cut: new Set(), cutoffs: [], partial: [], late: 0, maxLateMs: 0, lastArrival: 0, held: new Set() });
  // the archive has got past a minute: footage the car recorded later is on the share
  const past = (s) => newestRecent !== null && newestRecent > s + MIN;
  // nothing later on the share: only after a day, and not while the share is still receiving
  const quiet = (s) => now - s >= LONG_GRACE_S && !catchingUp;
  const due = (s) => now - s >= GRACE_S && (past(s) || quiet(s));
  // not due only because the archive is still copying: the day is "filling"
  const hold = (s) => { if (now - s >= GRACE_S && !past(s) && catchingUp) dayOf(dayOfSec(s)).held.add(s); };
  const inWindow = (s) => dayOfSec(s) >= firstDay;
  const valuesOf = (rel) => speeds.get(rel).filter((v) => Number.isFinite(v));
  const frontAt = new Map(); // clip start -> its front clip's speeds
  for (const c of clips) if (c.f.camera === 'front' && Array.isArray(speeds.get(c.f.rel))) frontAt.set(c.s, valuesOf(c.f.rel));

  // can, sentry: minutes CAN Bridge shows the car recording, with no footage
  const tzShift = [];
  if (habit && (canDriving || canSentry?.length)) {
    const what = new Map();
    for (const m of canDriving || []) what.set(m, 'drive');
    for (const m of canSentry || []) if (!what.has(m)) what.set(m, 'sentry');
    const perDay = new Map();
    for (const m of [...what.keys()].sort((a, b) => a - b)) {
      if (!inWindow(m) || covered(starts, m + 30)) continue;
      if (!due(m)) { hold(m); continue; }
      const day = dayOfSec(m);
      if (!perDay.has(day)) perDay.set(day, []);
      perDay.get(day).push(m);
    }
    // CAN and footage a whole number of hours apart: the time zone is off, nothing is missing.
    // The car is awake (CAN Bridge logging) whenever it records, so with the right zone most
    // footage minutes of the day have a CAN minute; with a wrong one they have it k hours away.
    const canSet = canMinutes ? new Set([...canMinutes].map((x) => x - (x % MIN))) : null;
    const aligned = (mins, k) => mins.filter((x) => canSet.has(x + k * HOUR)).length / mins.length;
    for (const [day, list] of perDay) {
      let shift = 0;
      const mins = canSet ? [...new Set(starts.filter((x) => dayOfSec(x) === day).map((x) => x - (x % MIN)))] : [];
      if (mins.length >= 5 && aligned(mins, 0) < 0.3) {
        let best = 0;
        for (const k of SHIFTS) {
          // ... and the minutes that look missing are footage k hours back
          const a = Math.min(aligned(mins, k), list.filter((m) => covered(starts, m - k * HOUR + 30)).length / list.length);
          if (a > best) { best = a; shift = k; }
        }
        if (best < 0.7) shift = 0;
      }
      if (shift) { tzShift.push({ day, hours: shift, minutes: list.length }); continue; }
      const d = dayOf(day);
      for (const m of list) { d.missing.add(m); (what.get(m) === 'drive' ? d.can : d.sentry).push(m); }
    }
  }

  // cutoff: footage that stops while the car is moving
  if (habit && speeds.size) {
    const front = clips.filter((c) => c.recent && c.f.camera === 'front' && frontAt.has(c.s) && Array.isArray(speeds.get(c.f.rel))).sort((a, b) => a.s - b.s);
    for (const c of front) {
      if (!inWindow(c.s)) continue;
      const v = valuesOf(c.f.rel);
      if (v.length < 40) continue; // a short clip: the recording ended there anyway
      const tail = v.slice(-3);
      if (tail.length < 3 || !tail.every((x) => x > MOVING)) continue;
      const end = c.s + MIN;
      // the next footage of any kind after this minute
      const nextIdx = starts.findIndex((s) => s > c.s);
      const next = nextIdx >= 0 ? starts[nextIdx] : null;
      // real time in between (a change of clocks between two clip names is no gap)
      const endU = utc(c.s) + MIN;
      const gap = next === null ? null : utc(next) - endU;
      if (gap !== null && gap < GAP_S) continue;
      if (now - end < GRACE_S) continue;
      if (next === null && !quiet(end)) { hold(end); continue; }
      let lost = 1; // at least the minute that should have followed
      if (gap !== null && gap <= 3 * HOUR) {
        const head = (frontAt.get(next) || []).slice(0, 3);
        // moving at both ends: the car drove the whole time in between
        if (head.length === 3 && head.every((x) => x > MOVING)) lost = Math.max(1, Math.floor(gap / MIN));
      }
      const d = dayOf(dayOfSec(c.s));
      for (let i = 0; i < lost; i++) {
        const m = wallSec((endU + i * MIN) * 1000, tz);
        if (dayOfSec(m) !== d.day || covered(starts, m + 30)) continue;
        d.missing.add(m);
        d.cut.add(m);
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

  // late: clips still reaching the share hours after they were recorded. The lag is
  // measured from the clip's name on the car's clock (a FAT file time has no time zone).
  // Not when many clips older than the window "arrived" lately as well: that is the
  // share copied or restored on the NAS, not the car's archive.
  const recordedMs = (c) => (utc(c.s) + MIN) * 1000;
  let bulk = 0;
  for (const c of clips) {
    if (inWindow(c.s)) continue;
    const arrival = arrivalOf(c.f);
    if (arrival && nowMs - arrival < 24 * 3600 * 1000 && arrival - recordedMs(c) > LATE_MS) bulk++;
  }
  let informative = false;
  for (const c of clips) {
    if (bulk >= BULK_FILES) break;
    if (!inWindow(c.s) || encoded.has(c.f.rel)) continue;
    const arrival = arrivalOf(c.f);
    if (!arrival) continue;
    const lag = arrival - recordedMs(c);
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
    const late = d.late >= 4 && nowMs - d.lastArrival < FILLING_MS;
    // one partial minute alone is not enough (a camera can miss a minute)
    const partial = missingMinutes > 0 || partialMinutes >= 2;
    if (!partial && !late && !d.held.size) continue;
    const finding = {
      day: d.day,
      state: partial ? 'partial' : 'filling',
      missingMinutes,
      partialMinutes,
      waitingMinutes: d.held.size,
      lateClips: late ? d.late : 0,
      maxLateHours: late ? Math.round(d.maxLateMs / 360000) / 10 : 0,
      // a minute the cut-off below already accounts for is not listed twice
      can: runList(d.can.filter((m) => !d.cut.has(m))),
      sentry: runList(d.sentry.filter((m) => !d.cut.has(m))),
      cutoffs: d.cutoffs.map((x) => ({ at: keyOfSec(x.at), kph: x.kph, next: x.next === null ? null : keyOfSec(x.next), minutes: x.lost })),
      partial: d.partial.map((x) => ({ at: keyOfSec(x.at), cameras: x.has, of: x.of, lacking: x.lacking })),
      sources: [...(d.can.length ? ['can'] : []), ...(d.sentry.length ? ['can'] : []), ...(d.cutoffs.length ? ['speed'] : []), ...(partialMinutes ? ['partial'] : [])].filter((x, i, a) => a.indexOf(x) === i)
    };
    finding.summary = summarize(finding, { receivedMs: received, nowMs });
    finding.advice = ADVICE;
    out[d.day] = finding;
  }

  // stalled: nothing new on the share for a while from a car that usually has footage most days
  let stalled = null;
  if (clips.length) {
    let newest = 0;
    for (const c of clips) newest = Math.max(newest, arrivalOf(c.f) || 0, c.f.mtimeMs || 0);
    const quietMs = nowMs - newest;
    const lastDay = dayOfSec(starts[starts.length - 1]);
    const dayset = new Set(starts.map(dayOfSec));
    let had = 0;
    for (let i = 0; i < HABIT_DAYS; i++) if (dayset.has(dayOfSec(stampSec(`${lastDay}_12-00-00`) - i * 86400))) had++;
    if (quietMs >= 36 * 3600 * 1000 && had / HABIT_DAYS >= 0.6) stalled = { since: newest, hours: Math.round(quietMs / 3600000), usualDays: had, of: HABIT_DAYS };
  }
  return {
    days: out, stalled,
    signals: { can: canDriving !== null && habit, speed: habit && speeds.size > 0, arrival: informative, recent: habit, catchingUp, receivedAt: received || null, tzShift },
    newestRecent
  };
}

/** The evidence in plain words (for the tag and the notification). */
function summarize(f, { receivedMs = 0, nowMs = Date.now() } = {}) {
  const bits = [];
  const list = (runs) => {
    const shown = runs.slice(0, 3).map((r) => (r.minutes > 1 ? `${hhmm(r.from)}–${hhmm(r.to)}` : hhmm(r.from)));
    const extra = runs.length - 3;
    const more = extra > 0 ? ` and ${extra} more stretch${extra === 1 ? '' : 'es'}` : '';
    return `${shown.length > 1 && !more ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown.join(', ')}${more}`;
  };
  if (f.can?.length) bits.push(`CAN Bridge shows the car driving ${list(f.can)} with no footage`);
  if (f.sentry?.length) bits.push(`CAN Bridge shows Sentry Mode on ${list(f.sentry)} with no footage`);
  for (const c of f.cutoffs.slice(0, 2)) {
    bits.push(`the footage stops at ${hhmm(c.at)} while the car was moving (${c.kph} km/h)${c.next ? `, and the next starts at ${hhmm(c.next)}` : ', and nothing later is on the share'}`);
  }
  if (f.cutoffs.length > 2) bits.push(`${f.cutoffs.length - 2} more drives stop like that`);
  if (f.partialMinutes) {
    const p = f.partial[0];
    bits.push(`${plural(f.partialMinutes, 'minute')} ${f.partialMinutes === 1 ? 'has' : 'have'} only some cameras${f.partialMinutes === 1 ? ` (${p.cameras} of ${p.of} at ${hhmm(p.at)})` : ''}`);
  }
  if (f.waitingMinutes) {
    const ago = receivedMs ? Math.max(1, Math.round((nowMs - receivedMs) / 60000)) : null;
    bits.push(`the share is still receiving footage${ago ? ` (the latest ${ago} min ago)` : ''}, and ${plural(f.waitingMinutes, 'minute')} the car recorded after its newest clip ${f.waitingMinutes === 1 ? 'is' : 'are'} not there yet`);
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

/** What a CAN minute shows: 'drive', 'sentry' or 'none'. */
function classify(sig) {
  const speed = (sig.DI_vehicleSpeed || []).map((p) => p[1]);
  const gear = (sig.DI_gear || []).map((p) => p[1]);
  const moving = speed.some((x) => x > MOVING_KPH && x <= MAX_KPH); // not "not available" (287.6)
  const inDR = gear.some((x) => x === 4 || x === 2);
  const parked = gear.length > 0 && gear.every((x) => x === 1);
  if (inDR || (moving && !parked)) return 'drive';
  if ((sig.UI_autopilotPowerStateRequest || []).some((p) => p[1] === 1) || (sig.UIsentryMode284 || []).some((p) => p[1] === 1)) return 'sentry';
  return 'none';
}

/**
 * The service: check(vid) after each scan (single flight, one more run queued when
 * asked while busy), soon(vid) when CAN logs were indexed, results(vid), forDays(vid)
 * for the day cards, indexed(key, from, to) and forget(vid).
 *   canKeysFor(vid)   the CAN Bridge keys of a car; canKeyMapped(key) whether one was
 *                     mapped to it explicitly (an unmapped key of the only car is used
 *                     once its CAN data has matched the car's footage)
 */
function createArchiveGap({ inventory, vehicles, notes, db, speedIndex = null, canKeysFor = async () => [], canKeyMapped = () => true, canDir = null, log = null, now = () => Date.now(), soonMs = 30_000 }) {
  const results = new Map(); // vid -> analysis + checkedAt
  const running = new Map(); // vid -> { p, next }
  const generation = new Map(); // vid -> bumped by forget()
  const timers = new Map();
  const canCache = new Map(); // "<key>/<minute file>" -> 'drive' | 'sentry' | 'none'
  const stateKey = (vid) => `archive-gap:${vid}`;

  function loadState(vid) {
    const raw = db.get(stateKey(vid), {}) || {};
    if (raw.days) return { days: {}, rx: null, lastRecentS: null, sentry: false, matched: [], ...raw };
    // the first version kept only the days, at the top level
    const days = {};
    for (const [k, v] of Object.entries(raw)) if (v && typeof v === 'object' && v.day) days[k] = v;
    return { days, rx: null, lastRecentS: null, sentry: false, matched: [] };
  }

  async function minuteKind(key, name) {
    const id = `${key}/${name}`;
    if (canCache.has(id)) return canCache.get(id);
    let kind;
    try {
      const data = JSON.parse((await gunzip(await fsp.readFile(path.join(canDir, key, name)))).toString('utf8'));
      kind = classify(data.signals || {});
    } catch { return 'none'; } // unreadable now: asked again next time
    if (canCache.size > 100_000) canCache.clear();
    canCache.set(id, kind);
    return kind;
  }

  /** CAN minutes with no footage, on the car's clock (seconds), or null without CAN data. */
  async function canActivityOf(v, files, nowMs, st) {
    if (!canDir) return null;
    const keys = (await canKeysFor(v.id)).filter((k) => KEY.test(k));
    if (!keys.length) return null;
    const tz = v.timezone || 'UTC';
    const starts = [];
    for (const f of files.values()) if (f.kind === 'clip') { const s = stampSec(path.posix.basename(f.rel)); if (s !== null) starts.push(s); }
    starts.sort((a, b) => a - b);
    const fromKey = new Date(nowMs - (WINDOW_DAYS + 1) * 86400_000).toISOString().slice(0, 16).replace(/[-:]/g, '');
    const nowWall = wallSec(nowMs, tz);
    const matched = new Set(st.matched || []);
    let read = 0;
    let learned = 0;
    let sentryCovered = 0;
    let sentryBare = 0;
    const perKey = [];
    for (const key of keys) {
      let names = [];
      try { names = await fsp.readdir(path.join(canDir, key)); } catch { continue; }
      const trusted = () => canKeyMapped(key) || matched.has(key);
      const k = { key, driving: [], sentry: [], minutes: [], coveredActive: 0 };
      for (const name of names.sort().reverse()) {
        if (/^\d{8}T\d{4}/.test(name) && name.slice(0, 13) < fromKey) break; // older than the window: the rest are too
        const m = MINUTE_FILE.exec(name);
        if (!m) continue;
        const s = wallSec(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]), tz);
        k.minutes.push(s);
        if (nowWall - s < GRACE_S) continue;
        const id = `${key}/${name}`;
        if (covered(starts, s + 30)) {
          // minutes with footage are read only to learn: is this key the car, does it record in Sentry
          if (trusted() && st.sentry) continue;
          if (!canCache.has(id) && ++learned > LEARN_READS) continue;
          const kind = await minuteKind(key, name);
          if (kind !== 'none') k.coveredActive++;
          if (kind === 'sentry') sentryCovered++;
          continue;
        }
        // only minutes old enough to count and with no footage are read
        if (!canCache.has(id) && ++read > MAX_DECODE) continue;
        const kind = await minuteKind(key, name);
        if (kind === 'drive') k.driving.push(s);
        else if (kind === 'sentry') { k.sentry.push(s); sentryBare++; }
      }
      if (!canKeyMapped(key) && k.coveredActive >= LEARN_MIN) matched.add(key);
      perKey.push(k);
    }
    const sentry = Boolean(st.sentry) || (sentryCovered >= LEARN_MIN && sentryCovered >= sentryBare);
    const use = perKey.filter((k) => canKeyMapped(k.key) || matched.has(k.key));
    return {
      driving: use.flatMap((k) => k.driving),
      sentry: sentry ? use.flatMap((k) => k.sentry) : [],
      minutes: use.flatMap((k) => k.minutes),
      learned: { sentry, matched: [...matched] },
      used: use.length > 0
    };
  }

  async function speedsOf(vid, nowMs, tz) {
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

  /** When the share last received new footage of the car: the clips from a fixed start went up in number. */
  function received(st, files, nowMs, tz) {
    const from = stampSec(`${dayOfSec(wallSec(nowMs, tz) - (WINDOW_DAYS + 1) * 86400)}_00-00-00`);
    const countFrom = (f0) => { let n = 0; for (const f of files.values()) if (f.kind === 'clip' && f.size > 0) { const s = stampSec(path.posix.basename(f.rel)); if (s !== null && s >= f0) n++; } return n; };
    const rx = st.rx;
    // the first check knows nothing of before: as if footage had just arrived (warnings wait a little)
    const grew = !rx || countFrom(rx.from) > rx.count;
    const at = grew ? nowMs : rx.at;
    st.rx = { from, count: countFrom(from), at };
    return at;
  }

  /** Clip files per day (a day's count going up means footage arrived). */
  function clipsPerDay(files) {
    const out = {};
    for (const f of files.values()) if (f.kind === 'clip' && f.size > 0) { const s = stampSec(path.posix.basename(f.rel)); if (s !== null) { const d = dayOfSec(s); out[d] = (out[d] || 0) + 1; } }
    return out;
  }

  /** Raise, update or resolve the car's archive notifications from a fresh analysis. */
  function sync(v, res, st, perDay, nowMs) {
    const open = new Set((notes.list({ open: true, vehicleId: v.id }) || []).filter((n) => n.kind === 'archive').map((n) => n.dedupeKey).filter(Boolean));
    const firstDay = dayOfSec(wallSec(nowMs, v.timezone || 'UTC') - (WINDOW_DAYS - 1) * 86400);
    const known = st.days || {};
    const found = {};
    for (const f of Object.values(res.days)) if (f.state === 'partial') found[`archive:${v.id}:${f.day}`] = f;
    const next = {};
    for (const key of new Set([...Object.keys(known), ...Object.keys(found)])) {
      let p = known[key] ? { ...known[key] } : null;
      const day = p?.day || found[key]?.day;
      const isOpen = open.has(key);
      // raised, not resolved here, and no longer open: the owner dismissed it
      if (p && p.raised && !p.resolved && !isOpen) p.dismissed = true;
      if (day < firstDay) {
        // out of the window: it can no longer be checked, and its footage is likely recycled by now
        if (p && p.raised && !p.resolved && isOpen) notes.resolve(key);
        continue;
      }
      const f = found[key];
      if (f) {
        const score = scoreOf(f);
        if (p?.dismissed && !(score >= p.score * 1.5 && score - p.score >= 10)) { next[key] = { ...p, absentSince: null }; continue; }
        const id = notes.raise(noteFor(v, f));
        if (id !== null && id !== undefined) next[key] = { day, score, raised: true, resolved: false, dismissed: false, clips: perDay[day] || 0, sources: f.sources, absentSince: null };
        else next[key] = p ? { ...p, absentSince: null } : { day, score, raised: false, clips: perDay[day] || 0, sources: f.sources, absentSince: null }; // muted
        continue;
      }
      // no evidence this time
      const absentSince = p.absentSince || nowMs;
      if (p.raised && !p.resolved && isOpen) {
        const arrived = p.clips === undefined || (perDay[day] || 0) > p.clips;
        const ran = (p.sources || []).every((s) => s === 'partial' || res.signals[s] === true);
        if (arrived || (ran && nowMs - absentSince >= ABSENT_MS)) { notes.resolve(key); next[key] = { ...p, resolved: true, absentSince }; continue; }
      }
      next[key] = { ...p, absentSince };
    }
    st.days = next;
  }

  async function run(vid) {
    const gen = generation.get(vid) || 0;
    const v = vehicles.get(vid);
    const entry = inventory.get(vid);
    if (!v || !entry?.files) return null;
    const nowMs = now();
    const tz = v.timezone || 'UTC';
    const st = loadState(vid);
    const receivedMs = received(st, entry.files, nowMs, tz);
    const can = await canActivityOf(v, entry.files, nowMs, st);
    const speeds = await speedsOf(vid, nowMs, tz);
    const res = analyze({
      files: entry.files, nowMs, tz, encoded: encodedSet(vid), speeds,
      canDriving: can?.used ? can.driving : null, canSentry: can?.sentry || [], canMinutes: can?.used ? can.minutes : null, receivedMs, lastRecentS: st.lastRecentS
    });
    // the car was removed while this ran: nothing of it is kept or raised
    if ((generation.get(vid) || 0) !== gen || !vehicles.get(vid)) return null;
    if (can) { st.sentry = can.learned.sentry; st.matched = can.learned.matched; }
    if (res.newestRecent !== null) st.lastRecentS = Math.max(st.lastRecentS || 0, res.newestRecent);
    res.checkedAt = nowMs;
    results.set(vid, res);
    sync(v, res, st, clipsPerDay(entry.files), nowMs);
    db.set(stateKey(vid), st);
    return res;
  }

  function check(vid) {
    const busy = running.get(vid);
    // asked while a check runs: one more run once it ends (it may have started before the change)
    if (busy) return (busy.next ||= busy.p.then(() => check(vid)));
    const job = {};
    job.p = run(vid).catch((err) => { log?.warn(`Archive gap check: ${err.message}`); return null; }).finally(() => { if (running.get(vid) === job) running.delete(vid); });
    running.set(vid, job);
    return job.p;
  }

  return {
    check,
    /** A check a little later (CAN logs were indexed; several in a row make one check). */
    soon(vid) {
      clearTimeout(timers.get(vid));
      const t = setTimeout(() => { timers.delete(vid); check(vid); }, soonMs);
      t.unref?.();
      timers.set(vid, t);
    },
    /** The last analysis (checked now when there is none). */
    async results(vid) { return results.get(vid) || (await check(vid)) || { days: {}, stalled: null, signals: {}, checkedAt: null }; },
    /** { day: { state, missingMinutes, partialMinutes, summary, advice } } for the day cards (no check started). */
    forDays(vid) {
      const out = {};
      for (const [d, f] of Object.entries(results.get(vid)?.days || {})) out[d] = { state: f.state, missingMinutes: f.missingMinutes, partialMinutes: f.partialMinutes, lateClips: f.lateClips, maxLateHours: f.maxLateHours, summary: f.summary, advice: f.state === 'partial' ? ADVICE : null };
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
    forget(vid) {
      generation.set(vid, (generation.get(vid) || 0) + 1);
      clearTimeout(timers.get(vid));
      timers.delete(vid);
      results.delete(vid);
      db.resolvePrefix?.(`archive:${vid}:`);
      db.set(stateKey(vid), {});
      notes.emit?.('changed');
    }
  };
}

module.exports = { createArchiveGap, analyze, summarize, noteFor, classify, stampSec, covered, wallSec, utcOfWall, ADVICE };
