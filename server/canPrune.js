'use strict';

// CAN logs live and die with their footage. A CAN Bridge log is one minute of
// a car's CAN buses; it is paired with the footage of the same car that covers
// that minute (a clip's name is its car-local start; a clip is about a minute;
// Recent, Sentry and Saved clips alike). Footage in the Recycle Bin still
// counts: a restore brings it back, so its logs stay until it is deleted for
// good.
//
//   paired     some footage (on the share, in the Recycle Bin, or protected)
//              covers the log's minute: kept.
//   gone       the footage that covered it was deleted for good (the Recycle
//              Bin emptied by hand or after N days; a policy and the size
//              limit only move footage to the bin) and nothing else covers it:
//              deleted with it.
//   no footage the minute never had footage (an archive gap, Sentry off): kept
//              while it is newer than the car's oldest footage, less MARGIN;
//              older than all of it: deleted (footage retention bounds the
//              logs).
//
// Never touched: CAN keys not mapped to a car in the Nerd settings, logs still
// arriving (a sidecar upload under way) or not judged yet (canTrust waiting),
// and every log of a car whose footage cannot be trusted right now: the share
// not healthy, a scan running, failed or with unreadable folders, or no
// footage at all (a share outage must not look like "all footage deleted").
// Each run deletes at most BATCH logs (the rest a minute later), through the
// same path as a delete in the Nerd settings (index, sync, trust record), with
// one audit line per run saying why.
//
//   db 'can-keep'         { withFootage: true }   the Nerd setting (on by default)
//   db 'can-prune:<vid>'  { gone: [[from, to, at], ...], last: { at, removed, ... } }

const CLIP_MS = 62_000; // a Tesla clip is a minute, a second or two more
const LOG_MIN_MS = 60_000; // a log is a minute ...
const LOG_MAX_MS = 10 * 60_000; // ... older bridges wrote one every 10 minutes
const MARGIN_MS = 3600_000;
const BATCH = 500;
const FRESH_MS = 30 * 60_000; // a scan older than this is done again before deciding
const GONE_KEEP_MS = 7 * 86400_000; // a deleted minute whose log was still pending: remembered this long
const TS = /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/;

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
/** Whether a clip starting in `starts` (sorted) overlaps [from, to). */
function overlaps(starts, from, to) {
  const i = lowerBound(starts, from - CLIP_MS + 1);
  return i < starts.length && starts[i] < to;
}

/** Each log's [from, to): its start, to the next log of its key (one to ten minutes). */
function spans(rows) {
  const sorted = [...rows].sort((a, b) => a.startedAtMs - b.startedAtMs || a.seq - b.seq);
  return sorted.map((r, i) => {
    const next = sorted.slice(i + 1).find((x) => x.startedAtMs > r.startedAtMs);
    const len = next ? Math.min(LOG_MAX_MS, Math.max(LOG_MIN_MS, next.startedAtMs - r.startedAtMs)) : LOG_MIN_MS;
    return { row: r, from: r.startedAtMs, to: r.startedAtMs + len };
  });
}

function createCanPrune({
  db, vehicles, inventory, canLogs, canTrust, keysOf, drop, startOf, withLock = (vid, fn) => fn(),
  audit = null, log = null, now = () => Date.now(), batch = BATCH, freshMs = FRESH_MS, soonMs = 30_000, onChange = () => {}
}) {
  const settings = () => ({ withFootage: true, ...(db.get('can-keep', null) || {}) });
  const stateKey = (vid) => `can-prune:${vid}`;
  const loadState = (vid) => ({ gone: [], last: null, ...(db.get(stateKey(vid), null) || {}) });
  const running = new Map(); // vid -> { p, next }
  const timers = new Map();

  /** A clip name's start in UTC ms, in the car's zone. */
  const clipStart = (v, rel) => {
    const base = String(rel).split('/').pop();
    if (!TS.test(base)) return null;
    const t = startOf(v, base);
    return Number.isFinite(t) ? t : null;
  };

  /** Every clip start (sorted) of a car: on the share, in its Recycle Bin, and protected. */
  function footageOf(v) {
    const set = new Set();
    const add = (rel) => { const t = clipStart(v, rel); if (t !== null) set.add(t); };
    const entry = inventory.get(v.id);
    for (const f of entry?.files?.values?.() || []) if (f.kind === 'clip') add(f.rel);
    for (const item of db.binItems(v.id) || []) for (const f of item.files || []) if (/\.mp4$/i.test(f.rel)) add(f.rel);
    for (const rel of db.protectedSet?.(v.id) || []) if (/\.mp4$/i.test(rel)) add(rel);
    return [...set].sort((a, b) => a - b);
  }

  // the Nerd list asks every few seconds: kept per car until its footage changes
  const covers = new Map(); // vid -> { sig, starts }
  function startsOf(v) {
    const entry = inventory.get(v.id);
    const bin = db.binItems(v.id) || [];
    const sig = `${entry?.scannedAt}|${entry?.files?.size}|${bin.length}|${bin.reduce((n, i) => n + (i.files?.length || 0), 0)}|${db.protectedSet?.(v.id)?.size || 0}|${v.timezone}`;
    const c = covers.get(v.id);
    if (c?.sig === sig) return c.starts;
    const starts = footageOf(v);
    covers.set(v.id, { sig, starts });
    return starts;
  }

  /** Why this car's footage cannot be trusted right now (null: it can). */
  function untrusted(v) {
    const share = vehicles.share?.(v.id);
    if (share && !share.isHealthy()) return 'the share is not reachable';
    const entry = inventory.get(v.id);
    if (!entry?.files) return 'the footage has not been scanned yet';
    if (entry.scanning) return 'a scan is running';
    if (entry.lastError) return `the last scan failed (${String(entry.lastError).slice(0, 120)})`;
    if (entry.errorCount) return `${entry.errorCount} folder(s) or file(s) could not be read in the last scan`;
    return null;
  }

  /** The car of a CAN key (only one the owner mapped), or null. */
  const carOfKey = (key) => vehicles.list().find((v) => keysOf(v.id).includes(key)) || null;

  /** For the Nerd list: name -> 'paired' | 'none' (no footage covers it) for one key's logs, or null (not mapped). */
  async function pairing(key) {
    const v = carOfKey(key);
    if (!v || !inventory.get(v.id)?.files) return null;
    const starts = startsOf(v);
    const out = new Map();
    for (const s of spans(await canLogs.rowsOf(key))) out.set(s.row.name, overlaps(starts, s.from, s.to) ? 'paired' : 'none');
    return out;
  }

  /** Footage was deleted for good (a Recycle Bin item): its minutes are remembered, and the car looked at soon. */
  function footageGone(vid, item) {
    const v = vehicles.get(vid);
    if (!v) return;
    const st = loadState(vid);
    const at = now();
    const starts = [...new Set((item?.files || []).map((f) => clipStart(v, f.rel)).filter((t) => t !== null))].sort((a, b) => a - b);
    // as spans: one-minute clips in a row are one
    for (const t of starts) {
      const last = st.gone[st.gone.length - 1];
      if (last && last[2] === at && t <= last[1]) last[1] = Math.max(last[1], t + CLIP_MS);
      else st.gone.push([t, t + CLIP_MS, at]);
    }
    if (st.gone.length > 50_000) st.gone = st.gone.slice(-50_000);
    db.set(stateKey(vid), st);
    soon(vid);
  }

  function soon(vid, ms = soonMs) {
    clearTimeout(timers.get(vid));
    const t = setTimeout(() => { timers.delete(vid); check(vid).catch(() => {}); }, ms);
    t.unref?.();
    timers.set(vid, t);
  }

  /** What would go (decided under the Recycle Bin's lock, so a restore or a move is never half seen). */
  async function plan(v, st) {
    const keys = keysOf(v.id);
    if (!keys.length) return { skip: 'no CAN Bridge key is mapped to this car' };
    let why = untrusted(v);
    // the footage is read again first when the last scan is old (the hourly look)
    if (!why || why === 'the footage has not been scanned yet') {
      const entry = inventory.get(v.id);
      if (!entry?.files || !(now() - (entry.scannedAt || 0) < freshMs)) {
        try { await inventory.scan(v.id); } catch (err) { return { skip: `the footage could not be scanned (${err.message})` }; }
        why = untrusted(v);
      }
    }
    if (why) return { skip: why };
    return withLock(v.id, async () => {
      const again = untrusted(v);
      if (again) return { skip: again };
      const starts = footageOf(v);
      if (!starts.length) return { skip: 'the car has no footage at all (a share outage looks the same): nothing is deleted' };
      const oldest = starts[0];
      const gone = st.gone.slice().sort((a, b) => a[0] - b[0]);
      const goneStarts = gone.map((g) => g[0]);
      // the furthest end of the spans so far: a log is in a deleted minute when one starting before its end reaches past its start
      const maxEnd = [];
      for (const [i, g] of gone.entries()) maxEnd.push(Math.max(g[1], i ? maxEnd[i - 1] : -Infinity));
      const inGone = (from, to) => { const i = lowerBound(goneStarts, to); return i > 0 && maxEnd[i - 1] > from; };
      const todo = [];
      const held = []; // pending logs in a deleted minute: their minute is remembered
      let pending = 0;
      for (const key of keys) {
        for (const s of spans(await canLogs.rowsOf(key))) {
          if (overlaps(starts, s.from, s.to)) continue;
          const goneHere = inGone(s.from, s.to);
          const old = s.to < oldest - MARGIN_MS;
          if (!goneHere && !old) continue;
          todo.push({ key, name: s.row.name, from: s.from, to: s.to, why: goneHere ? 'footage' : 'old' });
        }
      }
      // not one still arriving or waiting for its check
      const out = [];
      for (const t of todo) {
        const rec = await canTrust.record(t.key, t.name).catch(() => null);
        const side = await canLogs.stateOf(`${t.name}.json`).catch(() => ({ state: 'partial' }));
        if (!rec || rec.status === 'waiting' || side.state === 'partial') {
          pending++;
          if (t.why === 'footage') held.push(t);
          continue;
        }
        out.push(t);
      }
      return { todo: out, pending, held, oldest };
    });
  }

  async function run(vid) {
    const v = vehicles.get(vid);
    if (!v) return null;
    const st = loadState(vid);
    const done = (last) => {
      const s = loadState(vid);
      s.last = { at: now(), ...last };
      db.set(stateKey(vid), s);
      onChange(vid);
      return s.last;
    };
    if (!settings().withFootage) return done({ removed: 0, skip: 'turned off' });
    const p = await plan(v, st);
    if (p.skip) {
      if (st.gone.length) log?.info?.(`CAN logs of ${v.name}: not looked at now: ${p.skip}`);
      return done({ removed: 0, skip: p.skip });
    }
    const take = p.todo.slice(0, batch);
    let removed = 0;
    const names = [];
    const byWhy = { footage: 0, old: 0 };
    for (const [i, t] of take.entries()) {
      // the share checked again now and then: a car whose share went away stops here
      if (i && i % 50 === 0 && untrusted(v)) break;
      if (!settings().withFootage) break;
      try {
        await canLogs.remove(t.name);
      } catch (err) {
        if (err.status !== 404) { log?.warn?.(`CAN log ${t.name}: not deleted: ${err.message}`); continue; }
      }
      await drop(t.key, t.name);
      await canTrust.deleted(t.key, t.name).catch(() => {});
      removed++;
      names.push(t.name);
      byWhy[t.why]++;
    }
    const more = p.todo.length - removed;
    // deleted minutes: kept while a log in them is still pending (for a while), else done with
    const s = loadState(vid);
    const at = now();
    const heldSpans = p.held.map((h) => [h.from, h.to]);
    // (minutes noted while this ran are looked at next time)
    const seen = new Set(st.gone.map((g) => g.join(',')));
    if (more <= 0) s.gone = s.gone.filter((g) => !seen.has(g.join(',')) || (at - g[2] < GONE_KEEP_MS && heldSpans.some(([a, b]) => g[0] < b && g[1] > a)));
    db.set(stateKey(vid), s);
    if (removed) {
      const parts = [byWhy.footage ? `${byWhy.footage} with their footage deleted` : '', byWhy.old ? `${byWhy.old} older than the car's oldest footage` : ''].filter(Boolean).join(', ');
      log?.info?.(`CAN logs: removed ${removed} with their footage (car ${v.name})`);
      audit?.info?.(`CAN logs deleted with their footage (car ${v.name}): ${removed} (${parts}), ${names[0]}${removed > 1 ? ` to ${names[names.length - 1]}` : ''}: automatic ("Delete CAN logs with their footage")`);
    }
    if (more > 0 && removed) soon(vid, 60_000);
    return done({ removed, footage: byWhy.footage, old: byWhy.old, pending: p.pending, more: Math.max(0, more), oldestFootage: p.oldest });
  }

  /** One run per car at a time; asked during one: once more after it. */
  function check(vid) {
    const busy = running.get(vid);
    if (busy) return (busy.next ||= busy.p.then(() => check(vid)));
    const job = {};
    job.p = run(vid).catch((err) => { log?.warn?.(`CAN logs with their footage: ${err.message}`); return null; })
      .finally(() => { if (running.get(vid) === job) running.delete(vid); });
    running.set(vid, job);
    return job.p;
  }

  /** Every car (the hourly look: footage the car or the archive removed, and logs past the oldest footage). */
  async function sweep() {
    if (!settings().withFootage) return;
    for (const v of vehicles.list()) await check(v.id);
  }

  function set(input) {
    const next = { ...settings(), withFootage: input?.withFootage !== false };
    db.set('can-keep', next);
    if (next.withFootage) for (const v of vehicles.list()) soon(v.id, 5000);
    return next;
  }

  const status = () => ({ ...settings(), cars: Object.fromEntries(vehicles.list().map((v) => [v.id, loadState(v.id).last])) });

  return { settings, set, status, footageGone, check, sweep, pairing, soon, stop: () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); } };
}

module.exports = { createCanPrune, spans, overlaps, CLIP_MS, MARGIN_MS, BATCH };
