'use strict';

// Sentry USB's status file on the archive share (its contract: docs/sentry-usb.md,
// and docs/sentry-manager-contract.md in the Sentry USB repository):
//
//   <share root>/.sentryusb/archive-status.json
//
// The Pi replaces it atomically when a transfer starts ("state":
// "transferring", with the transfer's first and last clip and when it should
// be done) and when the cycle's archive and checksum steps are done ("state":
// "idle", with the results). Sentry Six Manager reads it to
//   - not flag archive gaps, nor convert clips, in the range still arriving
//     (first_clip..last_clip by clip name) while it says "transferring";
//   - say "waiting for Sentry USB" (not missing footage) once a transfer is
//     past its give_up_unix: the car drove off mid-transfer, the clips stay on
//     the Pi and the rest arrives at its next archive;
//   - show the last archive and its checksum results per car;
//   - explain missing footage by the snapshots the Pi did not take (the
//     optional snapshot_interval_s and snapshots fields, below).
//
// Snapshots. The Pi copies the car's USB drive every snapshot_interval_s
// seconds (Sentry USB's default 3480, 58 min) and archives the copies later.
// The car keeps only about the last hour of RecentClips, so when two
// consecutive snapshots are more than the interval plus SNAP_MARGIN_S apart,
// the footage from the earlier one up to about CAR_KEEPS_S before the later
// one was overwritten before any snapshot caught it. "snapshots" lists every
// snapshot of the last 7 days (at most 1000, oldest first), including ones
// since released: [{ "name": "snap-000011", "started_unix": 1762731609 }].
// Runs the Pi discarded because the drive had not changed (a parked car can
// write nothing for hours) count too when listed (any extra field, such as
// "kept": false, is ignored): a run that found nothing new is not a missed
// snapshot.
// A gap only explains missing minutes: before a gap the car may have been
// asleep, recording nothing.
//
// The share root is the folder holding RecentClips/ (the vehicle's folder, or
// a TeslaCam/ folder in it: vehicles.studioRoot). The file is read on each
// scan and every minute while it says "transferring", and only re-parsed when
// its size or modification time changed. A missing or unreadable file is
// simply no status.

const fsp = require('fs/promises');
const path = require('path');
const { createCarFilesReader } = require('./carFiles');

const DIR = '.sentryusb';
const FILE = 'archive-status.json';
const MAX_BYTES = 256 * 1024; // room for 1000 snapshots
const POLL_MS = 60_000;
const ARRIVED_MS = 1000; // a transfer's progress is counted at most this often
const IDLE_LOOK_MS = 5000; // otherwise the file is looked at again at most this often when asked
const RESULTS = new Set(['in_progress', 'ok', 'failed', 'nothing_new']);
const TS_RE = /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/;
const DEFAULT_INTERVAL_S = 3480; // Sentry USB's SNAPSHOT_INTERVAL when the file does not say
const MIN_INTERVAL_S = 60;
const MAX_INTERVAL_S = 86400;
const SNAP_MARGIN_S = 7 * 60; // snapshots further apart than the interval and this: one was missed
const CAR_KEEPS_S = 60 * 60; // the car keeps about this much RecentClips before overwriting it
const MAX_SNAPSHOTS = 1000;
const SNAP_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const SNAP_FROM_UNIX = 1262304000; // 2010: a snapshot time before this is not one
const SNAP_TO_UNIX = 4102444800; // 2100

const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const text = (v, max = 200) => (typeof v === 'string' && v.length <= 1024 ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null);
/** A relpath from the share root, or null. */
function relpath(v) {
  const s = text(v, 512);
  if (!s || s.startsWith('/') || s.split('/').some((p) => p === '..' || p === '')) return null;
  return s;
}
const clipName = (rel) => (rel ? rel.split('/').pop() : null);

/** snapshot_interval_s when it is sane, else null. */
function intervalOf(v) {
  return Number.isSafeInteger(v) && v >= MIN_INTERVAL_S && v <= MAX_INTERVAL_S ? v : null;
}
/**
 * The "snapshots" list: [{ name, startedUnix }] sorted by time, one per time,
 * the newest MAX_SNAPSHOTS; entries that are not one are left out. null when
 * the file has no list (an older Sentry USB).
 */
function snapshotsOf(v) {
  if (!Array.isArray(v)) return null;
  const byTime = new Map();
  for (const e of v.slice(0, MAX_SNAPSHOTS * 4)) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const t = e.started_unix;
    if (!Number.isSafeInteger(t) || t < SNAP_FROM_UNIX || t > SNAP_TO_UNIX) continue;
    let name = null;
    if (e.name !== undefined && e.name !== null) {
      if (typeof e.name !== 'string' || !SNAP_NAME.test(e.name)) continue;
      name = e.name;
    }
    if (!byTime.has(t) || (!byTime.get(t).name && name)) byTime.set(t, { name, startedUnix: t });
  }
  return [...byTime.values()].sort((a, b) => a.startedUnix - b.startedUnix).slice(-MAX_SNAPSHOTS);
}

/**
 * Missed snapshots: consecutive snapshots more than intervalS + SNAP_MARGIN_S
 * apart, oldest first, as { fromUnix, toUnix, seconds, lostToUnix }: the
 * footage from fromUnix to lostToUnix (the later snapshot less CAR_KEEPS_S)
 * was overwritten on the car before a snapshot caught it, if the car recorded
 * it at all. lostToUnix is null when nothing can have been lost (an interval
 * set below an hour, snapshots a little late).
 */
function snapshotGaps(snapshots, intervalS = DEFAULT_INTERVAL_S) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return [];
  const every = intervalOf(intervalS) ?? DEFAULT_INTERVAL_S;
  const out = [];
  for (let i = 1; i < snapshots.length; i++) {
    const from = snapshots[i - 1].startedUnix;
    const to = snapshots[i].startedUnix;
    if (to - from <= every + SNAP_MARGIN_S) continue;
    const lostTo = to - CAR_KEEPS_S;
    out.push({ fromUnix: from, toUnix: to, seconds: to - from, lostToUnix: lostTo > from ? lostTo : null });
  }
  return out;
}

/** The status's snapshots for archiveGap.js: { intervalS, gaps }, or null when the file lists none. */
function snapshotInfo(status) {
  if (!status || !Array.isArray(status.snapshots)) return null;
  const intervalS = status.snapshotIntervalS ?? DEFAULT_INTERVAL_S;
  return { intervalS, reported: status.snapshotIntervalS !== null, count: status.snapshots.length, gaps: snapshotGaps(status.snapshots, intervalS) };
}

/** The file's JSON as a normalized status (schema 1), or null when it is not one. */
function parseStatus(json) {
  let raw;
  try { raw = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema !== 1) return null;
  const a = raw.archive && typeof raw.archive === 'object' ? raw.archive : {};
  const v = raw.verification && typeof raw.verification === 'object' ? raw.verification : {};
  const t = raw.transfer && typeof raw.transfer === 'object' && !Array.isArray(raw.transfer) ? raw.transfer : null;
  const hasVerification = Boolean(raw.verification) && typeof raw.verification === 'object' && !Array.isArray(raw.verification);
  const state = raw.state === 'transferring' ? 'transferring' : 'idle';
  return {
    schema: 1,
    device: text(raw.device, 64),
    writtenUnix: int(raw.written_unix),
    archive: {
      result: RESULTS.has(a.result) ? a.result : null,
      startedUnix: int(a.started_unix),
      finishedUnix: int(a.finished_unix),
      filesArchived: int(a.files_archived),
      filesNotArchived: int(a.files_not_archived),
      lastClip: relpath(a.last_clip)
    },
    verification: !hasVerification ? null : {
      enabled: v.enabled === true,
      ran: v.ran === true,
      matched: int(v.matched),
      converted: int(v.converted),
      resending: int(v.resending),
      noPiCopy: int(v.no_pi_copy),
      stillQueued: int(v.still_queued),
      stopped: text(v.stopped, 200)
    },
    autoDeleteEnabled: typeof raw.auto_delete_enabled === 'boolean' ? raw.auto_delete_enabled : null,
    state,
    transfer: t ? {
      startedUnix: int(t.started_unix),
      files: int(t.files),
      bytes: int(t.bytes),
      firstClip: relpath(t.first_clip),
      lastClip: relpath(t.last_clip),
      expectedFinishUnix: int(t.expected_finish_unix),
      giveUpUnix: int(t.give_up_unix)
    } : null,
    // optional (newer Sentry USB): how often it snapshots, and its snapshots of the last 7 days
    snapshotIntervalS: intervalOf(raw.snapshot_interval_s),
    snapshots: snapshotsOf(raw.snapshots)
  };
}

/**
 * What the status means now:
 *   transferring  the file says so
 *   overdue       ... and give_up_unix has passed: "waiting for Sentry USB"
 *   range         { first, last } clip names still arriving (by name, the
 *                 Pi's order), or null
 */
function interpret(status, nowMs = Date.now()) {
  if (!status) return { transferring: false, overdue: false, range: null };
  const transferring = status.state === 'transferring';
  const t = status.transfer;
  const giveUp = t?.giveUpUnix ?? null;
  const overdue = transferring && giveUp !== null && nowMs / 1000 > giveUp;
  let range = null;
  if (transferring && t) {
    const first = clipName(t.firstClip);
    const last = clipName(t.lastClip) || first;
    if (first && last) range = first <= last ? { first, last } : { first: last, last: first };
  }
  return { transferring, overdue, range };
}

/** Whether a clip (its file name) is in the range still arriving. */
function inRange(range, name) {
  if (!range || !name) return false;
  return name >= range.first && name <= range.last;
}

/** A clip name's wall-clock time as seconds on archiveGap's scale (UTC-as-wall), or null. */
function stampSec(name) {
  const m = TS_RE.exec(String(name || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : null;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function clock(unix, tz, nowMs) {
  if (!unix) return null;
  const d = new Date(unix * 1000);
  const opt = { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try {
    const sameDay = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(d) === new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(new Date(nowMs));
    const time = new Intl.DateTimeFormat('en-GB', opt).format(d);
    return sameDay ? time : `${new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', day: 'numeric', month: 'short' }).format(d)} ${time}`;
  } catch {
    return d.toISOString().slice(11, 16);
  }
}
/** "12:59" of a clip name (the car's clock), with its date when not today. */
function clipClock(name, tz, nowMs) {
  const m = TS_RE.exec(String(name || ''));
  if (!m) return null;
  let today = null;
  try { today = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(new Date(nowMs)); } catch { today = null; }
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const time = `${m[4]}:${m[5]}`;
  if (day === today) return time;
  const label = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${label} ${time}`;
}

/**
 * The status for the UI: the fields above plus a one-line `summary`, a
 * `detail` line (checksums) and a `tone`: 'info' (copying), 'waiting'
 * (past give-up), 'amber' (the last archive left files behind), 'ok'.
 */
function describe(status, { nowMs = Date.now(), tz = 'UTC', readAt = null } = {}) {
  if (!status) return null;
  const now = interpret(status, nowMs);
  const a = status.archive;
  const v = status.verification || {};
  const t = status.transfer;
  let tone = 'ok';
  let summary;
  if (now.overdue) {
    tone = 'waiting';
    summary = `Waiting for Sentry USB since ${clock(t.startedUnix, tz, nowMs) || 'its last transfer'}: its transfer${t.files ? ` of ${plural(t.files, 'file')}` : ''} stopped part way (the car most likely drove off or lost Wi-Fi). Nothing is lost: the clips stay on the Sentry USB and the rest arrives at its next archive.`;
  } else if (now.transferring) {
    tone = 'info';
    const range = now.range ? ` (${clipClock(now.range.first, tz, nowMs)}–${clipClock(now.range.last, tz, nowMs)})` : '';
    summary = `Sentry USB is copying ${t?.files ? plural(t.files, 'file') : 'clips'}${range}${t?.startedUnix ? ` since ${clock(t.startedUnix, tz, nowMs)}` : ''}${t?.expectedFinishUnix ? `, expected by ${clock(t.expectedFinishUnix, tz, nowMs)}` : ''}. Those clips are not converted or reported missing until they are in.`;
  } else {
    const when = clock(a.finishedUnix || status.writtenUnix, tz, nowMs);
    const parts = [];
    if (a.result === 'failed') {
      tone = 'amber';
      parts.push(`Sentry USB's last archive${when ? ` (${when})` : ''} copied ${plural(a.filesArchived || 0, 'file')}${a.filesNotArchived ? `; ${plural(a.filesNotArchived, 'file')} did not make it and ${a.filesNotArchived === 1 ? 'is' : 'are'} tried again at its next archive` : ''}`);
    } else if (a.result === 'nothing_new') {
      parts.push(`Sentry USB's last archive${when ? ` (${when})` : ''} had nothing new`);
    } else {
      parts.push(`Sentry USB's last archive${when ? ` (${when})` : ''} copied ${plural(a.filesArchived || 0, 'file')}`);
    }
    if (a.lastClip) parts.push(`newest clip ${clipClock(clipName(a.lastClip), tz, nowMs) || clipName(a.lastClip)}`);
    summary = `${parts.join(', ')}.`;
  }
  let detail = null;
  if (v.enabled && v.ran) {
    const bits = [`${v.matched || 0} matched`];
    if (v.converted) bits.push(`${v.converted} converted here`);
    if (v.resending) bits.push(`${v.resending} being sent again`);
    if (v.stillQueued) bits.push(`${v.stillQueued} still to check`);
    detail = `Checksums: ${bits.join(', ')}.`;
  } else if (v.enabled) detail = 'Checksums: on, none checked in its last archive.';
  return {
    ...status,
    transferring: now.transferring,
    overdue: now.overdue,
    range: now.range,
    tone,
    summary,
    detail,
    readAt
  };
}

/**
 * When the Pi's newest archive that went through started (unix), or null: an
 * archive takes a fresh snapshot when it starts, so a clip the Pi saw before
 * then should be on the share once it is done. While a transfer runs, its
 * start (the clips it is still sending are held apart, by name); a failed
 * archive that left files behind, or one still in progress, gives none.
 */
function archivedSince(status) {
  if (!status) return null;
  if (status.state === 'transferring') return status.transfer?.startedUnix ?? null;
  const a = status.archive || {};
  if (a.result === 'ok' || a.result === 'nothing_new' || (a.result === 'failed' && a.filesNotArchived === 0)) return a.startedUnix ?? null;
  return null;
}

const STALE_MS = 24 * 3600 * 1000;
const ms = (unix) => (Number.isSafeInteger(unix) ? unix * 1000 : null);

/**
 * GET /api/vehicles/:id/sentry-usb: { present: false[, error] }, or
 * { present: true, readAt, writtenAt, device, state ('idle' | 'transferring'
 * | 'waiting': past give_up_unix), archive, verification, autoDeleteEnabled,
 * transfer, stale (written more than 24 h ago), summary, detail, tone,
 * snapshots }. Times in milliseconds. snapshots is null when the file lists
 * none, else { interval (seconds; Sentry USB's default when the file does not
 * say), intervalReported, count, firstAt, lastAt, times: [ms…] (oldest first),
 * missed: [{ from, to, minutes, lostTo }] (oldest first; lostTo null when
 * nothing can have been lost) }.
 */
function apiView(status, { nowMs = Date.now(), tz = 'UTC', readAt = null, error = null } = {}) {
  if (!status) return error ? { present: false, error } : { present: false };
  const now = interpret(status, nowMs);
  const a = status.archive;
  const v = status.verification;
  const t = status.transfer;
  const writtenAt = ms(status.writtenUnix);
  const words = describe(status, { nowMs, tz });
  return {
    present: true,
    readAt,
    writtenAt,
    device: status.device,
    state: now.overdue ? 'waiting' : now.transferring ? 'transferring' : 'idle',
    archive: {
      result: a.result, startedAt: ms(a.startedUnix), finishedAt: ms(a.finishedUnix),
      filesArchived: a.filesArchived, filesNotArchived: a.filesNotArchived, lastClip: a.lastClip
    },
    verification: v ? {
      enabled: v.enabled, ran: v.ran, matched: v.matched, converted: v.converted, resending: v.resending,
      noPiCopy: v.noPiCopy, stillQueued: v.stillQueued, stopped: v.stopped
    } : null,
    autoDeleteEnabled: status.autoDeleteEnabled,
    transfer: t && t.startedUnix !== null && t.firstClip ? {
      startedAt: ms(t.startedUnix), files: t.files, bytes: t.bytes, firstClip: t.firstClip, lastClip: t.lastClip || t.firstClip,
      expectedFinishAt: ms(t.expectedFinishUnix), giveUpAt: ms(t.giveUpUnix)
    } : null,
    stale: writtenAt === null || nowMs - writtenAt > STALE_MS,
    // the same in words (for an interface that wants them)
    summary: words.summary, detail: words.detail, tone: words.tone,
    snapshots: snapshotsView(status)
  };
}

function snapshotsView(status) {
  const info = snapshotInfo(status);
  if (!info) return null;
  const list = status.snapshots;
  return {
    interval: info.intervalS,
    intervalReported: info.reported,
    count: list.length,
    firstAt: list.length ? ms(list[0].startedUnix) : null,
    lastAt: list.length ? ms(list[list.length - 1].startedUnix) : null,
    times: list.map((x) => ms(x.startedUnix)),
    missed: info.gaps.map((g) => ({ from: ms(g.fromUnix), to: ms(g.toUnix), minutes: Math.round(g.seconds / 60), lostTo: g.lostToUnix === null ? null : ms(g.lostToUnix) }))
  };
}

/**
 * vehicles: { list(), get(id), studioRoot(v), rootOf(v) }. onChange(vid):
 * the status of a car changed (its state, or a new file).
 */
function createSentryUsbStatus({ vehicles, now = () => Date.now(), log = null, onChange = () => {}, pollMs = POLL_MS, timers = { setInterval, clearInterval } } = {}) {
  const cache = new Map(); // vid -> { file, size, mtimeMs, status, readAt }
  // the car's own list of what it wrote, beside the status file (carFiles.js)
  const carFilesReader = createCarFilesReader({ log });
  const carFiles = new Map(); // vid -> { file, size, mtimeMs, list, error } or null
  let timer = null;

  function filesOf(v) {
    const out = [];
    try { const s = vehicles.studioRoot?.(v); if (s) out.push(path.join(s, DIR, FILE)); } catch { /* not reachable now */ }
    const root = vehicles.rootOf(v);
    if (root) out.push(path.join(root, DIR, FILE));
    return [...new Set(out)];
  }

  async function refresh(vid) {
    const v = vehicles.get(vid);
    if (!v) { cache.delete(vid); return null; }
    const before = cache.get(vid);
    let found = null;
    for (const file of filesOf(v)) {
      try {
        const st = await fsp.stat(file);
        if (!st.isFile()) continue;
        found = { file, st };
        break;
      } catch { /* not there */ }
    }
    let next;
    if (!found) next = { file: null, size: null, mtimeMs: null, status: null, error: null, readAt: now() };
    else if (before && before.file === found.file && before.size === found.st.size && before.mtimeMs === found.st.mtimeMs) next = { ...before, readAt: now() };
    else {
      let status = null;
      let error = null;
      try {
        if (found.st.size > MAX_BYTES) error = 'too large';
        else {
          status = parseStatus(await fsp.readFile(found.file, 'utf8'));
          if (!status) error = 'not a schema 1 status file';
        }
      } catch (err) {
        error = 'unreadable';
        log?.debug?.(`Sentry USB status ${found.file}: ${err.message}`);
      }
      next = { file: found.file, size: found.st.size, mtimeMs: found.st.mtimeMs, status, error, readAt: now() };
    }
    cache.set(vid, next);
    // car-files.tsv beside it (in the status file's folder first)
    const dirs = [...new Set([...(found ? [path.dirname(found.file)] : []), ...filesOf(v).map((f) => path.dirname(f))])];
    const cfBefore = carFiles.get(vid) || null;
    let cf = null;
    for (const dir of dirs) {
      cf = await carFilesReader.read(dir).catch(() => null);
      if (cf) break;
    }
    carFiles.set(vid, cf);
    const was = before?.status ? JSON.stringify(before.status) : null;
    const is = next.status ? JSON.stringify(next.status) : null;
    const cfChanged = (cfBefore?.file || null) !== (cf?.file || null) || (cfBefore?.mtimeMs ?? null) !== (cf?.mtimeMs ?? null) || (cfBefore?.size ?? null) !== (cf?.size ?? null);
    if (was !== is || cfChanged) {
      try { onChange(vid, next.status); } catch { /* observers are advisory */ }
    }
    return next.status;
  }

  // what of a transfer in progress is on the share already: the clip files
  // (.mp4, not dot-named: an unfinished upload has another name) whose time
  // is in the transfer's range, counted at most once a second per car, each
  // file's size read once
  const arrivedOf = new Map(); // vid -> { key, at, result, sizes, running }
  const stamp = (name) => String(name).slice(0, 19);
  async function countArrived(vid) {
    const c = cache.get(vid);
    const n = interpret(c?.status || null, now());
    if (!n.transferring || !n.range || !c?.file) return null;
    const root = path.dirname(path.dirname(c.file));
    const key = `${root}|${n.range.first}|${n.range.last}`;
    let a = arrivedOf.get(vid);
    if (!a || a.key !== key) { a = { key, at: 0, result: null, sizes: new Map(), running: null }; arrivedOf.set(vid, a); }
    if (a.result && now() - a.at < ARRIVED_MS) return a.result;
    if (a.running) return a.running;
    const first = stamp(n.range.first), last = stamp(n.range.last);
    const firstDay = first.slice(0, 10), lastDay = last.slice(0, 10);
    a.running = (async () => {
      const dirs = [];
      for (const top of ['RecentClips', 'SentryClips', 'SavedClips', 'TeslaTrackMode']) {
        let ents;
        try { ents = await fsp.readdir(path.join(root, top), { withFileTypes: true }); } catch { continue; }
        dirs.push(path.join(root, top)); // older cars: clips loose in RecentClips
        for (const d of ents) {
          if (!d.isDirectory() || d.name.startsWith('.')) continue;
          const day = d.name.slice(0, 10);
          if (day >= firstDay && day <= lastDay) dirs.push(path.join(root, top, d.name));
        }
      }
      let files = 0;
      let bytes = 0;
      const seen = new Set();
      for (const dir of dirs) {
        let names;
        try { names = await fsp.readdir(dir); } catch { continue; }
        for (const name of names) {
          if (name.startsWith('.') || !name.endsWith('.mp4')) continue;
          const t = stamp(name);
          if (t < first || t > last) continue;
          const file = path.join(dir, name);
          let size = a.sizes.get(file);
          if (size === undefined) {
            try { const st = await fsp.stat(file); if (!st.isFile()) continue; size = st.size; } catch { continue; }
            a.sizes.set(file, size);
          }
          seen.add(file);
          files += 1;
          bytes += size;
        }
      }
      for (const file of a.sizes.keys()) if (!seen.has(file)) a.sizes.delete(file);
      a.result = { files, bytes, countedAt: now() };
      a.at = now();
      return a.result;
    })().finally(() => { a.running = null; });
    return a.running;
  }

  async function poll() {
    for (const v of vehicles.list()) {
      const c = cache.get(v.id);
      // every minute only while a transfer runs (and once for cars not read yet)
      if (c && c.status?.state !== 'transferring') continue;
      await refresh(v.id).catch(() => null);
    }
  }

  return {
    refresh,
    /**
     * When a page asks: the status file looked at again (a stat; re-read only
     * when it changed) if the last look is older than a second while a
     * transfer runs, else older than IDLE_LOOK_MS, so a transfer that starts
     * (or a file that appears) shows within seconds, not at the next scan.
     */
    async fresh(vid) {
      const c = cache.get(vid);
      const age = c ? now() - (c.readAt || 0) : Infinity;
      if (age >= (c?.status?.state === 'transferring' ? ARRIVED_MS : IDLE_LOOK_MS)) await refresh(vid).catch(() => null);
    },
    /** While a transfer runs: { files, bytes, countedAt } on the share already in its range, else null. */
    arrived(vid) { return countArrived(vid).catch(() => null); },
    /** The last status read (no I/O), or null. */
    get(vid) { return cache.get(vid)?.status || null; },
    /**
     * The car's list of what it wrote (carFiles.js), for archiveGap.js: null
     * without the file, else { present, error, fileUnix (when the share's copy
     * was written), list (parseCarFiles, null when unreadable), archivedUnix:
     * the start of the Pi's newest archive that went through (its fresh snapshot;
     * clips it saw before then should be on the share), or null }.
     */
    carFiles(vid) {
      const cf = carFiles.get(vid);
      if (!cf) return null;
      return { present: true, error: cf.error || null, fileUnix: Math.floor(cf.mtimeMs / 1000), list: cf.list, archivedUnix: archivedSince(cache.get(vid)?.status || null) };
    },
    /** The snapshots the last status lists (snapshotInfo), or null. */
    snapshots(vid) { return snapshotInfo(cache.get(vid)?.status || null); },
    /** interpret() of the last status, now. */
    now(vid) { return interpret(cache.get(vid)?.status || null, now()); },
    /** GET /api/vehicles/:id/sentry-usb (apiView), from the last read. */
    api(vid) {
      const c = cache.get(vid);
      const v = vehicles.get(vid);
      return apiView(c?.status || null, { nowMs: now(), tz: v?.timezone || 'UTC', readAt: c?.readAt ?? null, error: c?.error || null });
    },
    /** Whether the car's file was read at least once. */
    known(vid) { return cache.has(vid); },
    /** describe() of the last status, or null. */
    view(vid) {
      const c = cache.get(vid);
      const v = vehicles.get(vid);
      return c?.status ? describe(c.status, { nowMs: now(), tz: v?.timezone || 'UTC', readAt: c.readAt }) : null;
    },
    /** A clip (absolute path) that is still arriving: in the range of a transfer in progress. */
    holds(absPath) {
      const v = vehicles.vehicleForPath?.(absPath);
      if (!v) return false;
      const n = interpret(cache.get(v.id)?.status || null, now());
      return n.transferring && inRange(n.range, path.basename(absPath));
    },
    start() {
      if (timer) return;
      timer = timers.setInterval(() => poll().catch(() => {}), pollMs);
      timer?.unref?.();
      return poll().catch(() => {});
    },
    stop() {
      if (timer) timers.clearInterval(timer);
      timer = null;
    },
    forget(vid) { cache.delete(vid); arrivedOf.delete(vid); carFiles.delete(vid); }
  };
}

module.exports = { createSentryUsbStatus, archivedSince, parseStatus, interpret, inRange, describe, apiView, stampSec, snapshotGaps, snapshotInfo, DIR, FILE, MAX_BYTES, DEFAULT_INTERVAL_S, SNAP_MARGIN_S, CAR_KEEPS_S, MAX_SNAPSHOTS };
