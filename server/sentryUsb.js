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
//   - show the last archive and its checksum results per car.
//
// The share root is the folder holding RecentClips/ (the vehicle's folder, or
// a TeslaCam/ folder in it: vehicles.studioRoot). The file is read on each
// scan and every minute while it says "transferring", and only re-parsed when
// its size or modification time changed. A missing or unreadable file is
// simply no status.

const fsp = require('fs/promises');
const path = require('path');

const DIR = '.sentryusb';
const FILE = 'archive-status.json';
const MAX_BYTES = 64 * 1024;
const POLL_MS = 60_000;
const RESULTS = new Set(['in_progress', 'ok', 'failed', 'nothing_new']);
const TS_RE = /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/;

const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const text = (v, max = 200) => (typeof v === 'string' && v.length <= 1024 ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null);
/** A relpath from the share root, or null. */
function relpath(v) {
  const s = text(v, 512);
  if (!s || s.startsWith('/') || s.split('/').some((p) => p === '..' || p === '')) return null;
  return s;
}
const clipName = (rel) => (rel ? rel.split('/').pop() : null);

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
    } : null
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

const STALE_MS = 24 * 3600 * 1000;
const ms = (unix) => (Number.isSafeInteger(unix) ? unix * 1000 : null);

/**
 * GET /api/vehicles/:id/sentry-usb: { present: false[, error] }, or
 * { present: true, readAt, writtenAt, device, state ('idle' | 'transferring'
 * | 'waiting': past give_up_unix), archive, verification, autoDeleteEnabled,
 * transfer, stale (written more than 24 h ago), summary, detail, tone }.
 * Times in milliseconds.
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
    summary: words.summary, detail: words.detail, tone: words.tone
  };
}

/**
 * vehicles: { list(), get(id), studioRoot(v), rootOf(v) }. onChange(vid):
 * the status of a car changed (its state, or a new file).
 */
function createSentryUsbStatus({ vehicles, now = () => Date.now(), log = null, onChange = () => {}, pollMs = POLL_MS, timers = { setInterval, clearInterval } } = {}) {
  const cache = new Map(); // vid -> { file, size, mtimeMs, status, readAt }
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
    const was = before?.status ? JSON.stringify(before.status) : null;
    const is = next.status ? JSON.stringify(next.status) : null;
    if (was !== is) {
      try { onChange(vid, next.status); } catch { /* observers are advisory */ }
    }
    return next.status;
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
    /** The last status read (no I/O), or null. */
    get(vid) { return cache.get(vid)?.status || null; },
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
    forget(vid) { cache.delete(vid); }
  };
}

module.exports = { createSentryUsbStatus, parseStatus, interpret, inRange, describe, apiView, stampSec, DIR, FILE };
