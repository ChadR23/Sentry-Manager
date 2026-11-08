'use strict';

// CAN logs from the Screenmate CAN Bridge (repo SMO): every frame of the
// car's CAN buses, recorded in the car and uploaded here when it reaches the
// home network, to be synced to the footage later. Nothing is decoded or
// thrown away on the way in: the logs are kept exactly as they came, so a
// message identified later works on old drives too.
//
// The upload API (docs/can-bridge-api.md) is opt-in (off: 404), HTTPS only,
// and takes a write-only bearer token made in the hidden Nerd settings; the
// token can do nothing else. Each log is uploaded in chunks that can be
// resumed, and kept only once its SHA-256 matches:
//
//   <DATA>/can/<vehicleKey>/<name>.log.xz    a finished log
//   <DATA>/can/<vehicleKey>/<name>.json      its sidecar
//   <DATA>/can/<vehicleKey>/<name>.part      a log still arriving
//   <DATA>/can/<vehicleKey>/<name>.part.json what that upload promised

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const LOG_NAME = /^([A-Za-z0-9-]{1,64})_(\d{8}T\d{6}Z)_(\d{1,6})\.log\.xz$/;
const SIDECAR_NAME = /^([A-Za-z0-9-]{1,64})_(\d{8}T\d{6}Z)_(\d{1,6})\.log\.xz\.json$/;
const MAX_CHUNK = 16 * 1024 * 1024; // one request's body
const MAX_FILE = 1024 * 1024 * 1024; // one log (a one-minute log is about 1.7 MB as candump text, 0.7 MB as columns)
const MAX_SIDECAR = 1024 * 1024;

const canError = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

/** What a file name says: { vehicleKey, startedAt (ms), seq, sidecar } or null. */
function parseName(name) {
  const s = String(name || '');
  const m = LOG_NAME.exec(s) || SIDECAR_NAME.exec(s);
  if (!m) return null;
  const t = m[2];
  const startedAt = Date.parse(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`);
  if (!Number.isFinite(startedAt)) return null;
  return { vehicleKey: m[1], startedAt, seq: Number(m[3]), sidecar: s.endsWith('.json') };
}

async function sha256Of(file) {
  const h = crypto.createHash('sha256');
  await new Promise((ok, fail) => fs.createReadStream(file).on('data', (b) => h.update(b)).on('end', ok).on('error', fail));
  return h.digest('hex');
}

/** Run fn over items, at most `n` at a time. */
async function eachLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

/** What the Nerd panel shows of a sidecar. */
const sideFacts = (side) => ({
  frames: Number.isFinite(side?.frames) ? side.frames : null,
  dropped: [side?.dropped_chunks, side?.dropped].find((x) => Number.isFinite(x)) ?? null,
  appVersion: [side?.app_version, side?.appVersion].find((x) => typeof x === 'string')?.slice(0, 40) ?? null,
  // what the sidecar says the log holds (canbridge-candump-xz/1 or canbridge-columns-xz/2; canLogReader.js reads
  // either, by its first bytes), and why the bridge closed it: rotate, quiet, stop, size (48 MB in memory), flush
  format: typeof side?.format === 'string' && /^[\w./-]{1,64}$/.test(side.format) ? side.format : null,
  closedBecause: typeof side?.closed_because === 'string' && /^[\w-]{1,20}$/.test(side.closed_because) ? side.closed_because : null
});

// A bridge uploads a log a minute while the car is awake (older bridges: one every 10 minutes). The
// cap counts finished logs only (not sidecars or uploads under way) and is there against a stolen
// token making endless tiny files; the free-space floor is what guards the disk. 200,000 is about
// 139 days of a car awake around the clock, and years of a car awake a few hours a day; the
// catalogue keeps about 400 bytes of memory per log.
const MAX_LOGS_PER_CAR = 200_000;
const RESCAN_MS = 10 * 60_000; // the catalogue is read again from the folder at least this often

function createCanLogs({ dir, freeBytes = async () => Infinity, now = () => Date.now(), maxFilesPerCar = MAX_LOGS_PER_CAR, minFree = 2 * 1024 ** 3 }) {
  const fileOf = (name) => {
    const n = parseName(name);
    if (!n) throw canError(400, 'bad_name', 'That is not a CAN Bridge log name.');
    return path.join(dir, n.vehicleKey, name);
  };
  const exists = (f) => fsp.stat(f).then((st) => st, () => null);
  // one upload at a time per file
  const busy = new Set();

  /** Where a file stands: complete (with its size), partial (bytes received so far) or missing. */
  async function stateOf(name) {
    const file = fileOf(name);
    const done = await exists(file);
    if (done) return { state: 'complete', received: done.size, length: done.size };
    const part = await exists(`${file}.part`);
    if (part) {
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(`${file}.part.json`, 'utf8')); } catch { /* none */ }
      return { state: 'partial', received: part.size, length: meta.length ?? null };
    }
    return { state: 'missing', received: 0, length: null };
  }

  /** Many at once (the app asks which of its files are here); `key`: only that car's names are answered. */
  async function status(names, { key = null } = {}) {
    if (!Array.isArray(names) || names.length > 2000) throw canError(400, 'bad_request', 'Send { "names": [...] } with up to 2000 names.');
    const files = {};
    for (const name of names) {
      const n = parseName(name);
      if (n && key && n.vehicleKey !== key) { files[name] = { state: 'forbidden', received: 0, length: null }; continue; }
      try { files[name] = await stateOf(name); } catch { files[name] = { state: 'invalid', received: 0, length: null }; }
    }
    return { files };
  }

  /** Half-finished uploads older than `maxAgeMs` are dropped (an app that gave up, or someone filling the disk). */
  async function cleanStale(maxAgeMs) {
    let keys = [];
    try { keys = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return 0; }
    let n = 0;
    for (const key of keys) {
      let names = [];
      try { names = await fsp.readdir(path.join(dir, key)); } catch { continue; }
      for (const f of names.filter((x) => x.endsWith('.part'))) {
        const st = await exists(path.join(dir, key, f));
        if (st && now() - st.mtimeMs > maxAgeMs) {
          await fsp.rm(path.join(dir, key, f), { force: true });
          await fsp.rm(path.join(dir, key, `${f}.json`), { force: true });
          await ownChange(key);
          n++;
        }
      }
    }
    return n;
  }

  /**
   * One chunk of a file: `offset` must be what is already here, `length`
   * the whole file's size and `sha256` its hash (the same on every chunk).
   * The file is kept when the last byte arrives and the hash matches.
   */
  async function receive(name, body, { offset, length, sha256 }) {
    const n = parseName(name);
    if (!n) throw canError(400, 'bad_name', 'That is not a CAN Bridge log name.');
    if (!Number.isSafeInteger(offset) || offset < 0) throw canError(400, 'bad_offset', 'Upload-Offset must be a whole number of bytes.');
    if (!Number.isSafeInteger(length) || length <= 0) throw canError(400, 'bad_length', 'Upload-Length must be the whole file\'s size in bytes.');
    if (!/^[0-9a-f]{64}$/.test(String(sha256 || ''))) throw canError(400, 'bad_sha256', 'Upload-SHA256 must be the whole file\'s SHA-256 in hex.');
    const limit = n.sidecar ? MAX_SIDECAR : MAX_FILE;
    if (length > limit) throw canError(413, 'too_large', `A ${n.sidecar ? 'sidecar' : 'log'} can be at most ${limit} bytes.`);
    const file = fileOf(name);
    if (busy.has(file)) throw canError(409, 'busy', 'This file is being uploaded by another request.', { received: (await stateOf(name)).received });
    busy.add(file);
    try {
      const had = await stateOf(name);
      if (had.state === 'complete') {
        // already here: fine when it is the same file, refused when it is not
        if (had.length === length && await sha256Of(file) === sha256) return { received: length, length, complete: true, already: true };
        throw canError(409, 'exists_different', 'A different file with this name is already here.');
      }
      if (had.state === 'partial' && had.length !== null && had.length !== length) throw canError(409, 'length_changed', 'Upload-Length differs from the upload already started; start again at offset 0 with a new name or the same length.', { received: had.received });
      if (offset !== had.received) throw canError(409, 'offset_mismatch', `Expected Upload-Offset ${had.received}.`, { received: had.received });
      if (offset + body.length > length) throw canError(400, 'past_end', 'The chunk goes past Upload-Length.', { received: had.received });
      if (body.length > MAX_CHUNK) throw canError(413, 'chunk_too_large', `A chunk can be at most ${MAX_CHUNK} bytes.`, { received: had.received });
      // room for it, and the data disk never filled by CAN logs (a floor kept free for everything else)
      if (offset === 0 && (await freeBytes()) < length * 2 + minFree) throw canError(507, 'no_space', 'There is not enough free space for this file.');
      if (offset === 0) {
        // at most so many files per car (a stolen token cannot fill the disk with small ones)
        const count = n.sidecar ? 0 : (await catalogue(n.vehicleKey)).rows.size;
        if (count >= maxFilesPerCar) throw canError(507, 'car_full', `This car has ${maxFilesPerCar} CAN logs already: the owner can delete old ones in the Nerd settings.`, { received: 0 });
      }
      if (offset === 0) {
        // at most 16 uploads half-finished at once per car (the bridge sends one at a time)
        let parts = [];
        try { parts = (await fsp.readdir(path.dirname(file))).filter((x) => x.endsWith('.part')); } catch { /* none */ }
        if (parts.length >= 16) throw canError(429, 'too_many_partial', 'Too many unfinished uploads for this car; finish or wait for them.', { received: 0 });
      }
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const part = `${file}.part`;
      if (offset === 0) await fsp.writeFile(`${part}.json`, JSON.stringify({ length, sha256, startedAt: now() }));
      await fsp.appendFile(part, body);
      if (offset === 0) await ownChange(n.vehicleKey); // a new .part is no change to the catalogue
      const received = offset + body.length;
      if (received < length) return { received, length, complete: false };
      // the last byte: kept only when it is the file the app hashed
      const got = await sha256Of(part);
      if (got !== sha256) {
        await fsp.rm(part, { force: true });
        await fsp.rm(`${part}.json`, { force: true });
        throw canError(422, 'sha256_mismatch', 'The file arrived different from its SHA-256; it was discarded. Upload it again from offset 0.', { received: 0 });
      }
      if (n.sidecar) {
        try { JSON.parse(await fsp.readFile(part, 'utf8')); } catch {
          await fsp.rm(part, { force: true });
          await fsp.rm(`${part}.json`, { force: true });
          throw canError(422, 'bad_sidecar', 'The sidecar is not JSON; it was discarded.', { received: 0 });
        }
      }
      await fsp.rename(part, file);
      await fsp.rm(`${part}.json`, { force: true });
      await noteChanged(n.vehicleKey, n.sidecar ? name.slice(0, -5) : name);
      return { received, length, complete: true };
    } finally {
      busy.delete(file);
    }
  }

  // ---- the catalogue: every finished log of each car, with its size and sidecar facts, kept in memory
  // (the Nerd panel lists it on every upload and index step; reading 20,000 files each time took seconds).
  // Changes made here update it at once; the folder is read again when its time changes (a change made
  // from outside), and at least every RESCAN_MS. A folder read stats each file, but reads a sidecar again
  // only when its size or time changed.
  const cats = new Map(); // key -> { rows: Map(name -> row), orphanBytes, dirMtime, at, loading }
  const rowBytes = (r) => r.bytes + (r.sideBytes || 0);

  async function readFolder(key, old) {
    const kdir = path.join(dir, key);
    const st0 = await exists(kdir);
    let names = [];
    try { names = await fsp.readdir(kdir); } catch { /* no such car (yet) */ }
    const have = new Set(names);
    const rows = new Map();
    let orphanBytes = 0;
    const logs = [];
    for (const name of names) {
      const n = parseName(name);
      if (!n || n.vehicleKey !== key) continue;
      if (n.sidecar) { if (!have.has(name.slice(0, -5))) logs.push({ name, n, orphan: true }); continue; }
      logs.push({ name, n });
    }
    await eachLimit(logs, 16, async ({ name, n, orphan }) => {
      const st = await exists(path.join(kdir, name));
      if (!st?.isFile()) return;
      if (orphan) { orphanBytes += st.size; return; }
      const row = { name, vehicleKey: key, startedAtMs: n.startedAt, seq: n.seq, bytes: st.size, mtimeMs: st.mtimeMs, sideBytes: 0, sideMtime: null, side: null };
      if (have.has(`${name}.json`)) {
        const ss = await exists(path.join(kdir, `${name}.json`));
        if (ss?.isFile()) {
          row.sideBytes = ss.size;
          row.sideMtime = ss.mtimeMs;
          const was = old?.get(name);
          if (was && was.sideBytes === ss.size && was.sideMtime === ss.mtimeMs) row.side = was.side;
          else {
            try { row.side = sideFacts(JSON.parse(await fsp.readFile(path.join(kdir, `${name}.json`), 'utf8'))); } catch { row.side = null; }
          }
        }
      }
      rows.set(name, row);
    });
    return { rows, orphanBytes, dirMtime: st0?.mtimeMs ?? null, at: now() };
  }

  async function catalogue(key) {
    let c = cats.get(key);
    if (c?.loading) return c.loading;
    if (c) {
      const st = await exists(path.join(dir, key));
      if ((st?.mtimeMs ?? null) === c.dirMtime && now() - c.at < RESCAN_MS) return c;
    }
    const loading = readFolder(key, c?.rows).then((fresh) => { cats.set(key, fresh); return fresh; }, (err) => { cats.delete(key); throw err; });
    cats.set(key, { ...(c || { rows: new Map(), orphanBytes: 0, dirMtime: null, at: 0 }), loading });
    return loading;
  }

  /** A log (or its sidecar) was finished or deleted here: its row now, and the folder's time taken as seen. */
  async function noteChanged(key, logName) {
    const c = cats.get(key);
    if (!c || c.loading) return; // read whole the next time it is asked for
    const kdir = path.join(dir, key);
    const st = await exists(path.join(kdir, logName));
    if (!st?.isFile()) c.rows.delete(logName);
    else {
      const n = parseName(logName);
      const row = { name: logName, vehicleKey: key, startedAtMs: n.startedAt, seq: n.seq, bytes: st.size, mtimeMs: st.mtimeMs, sideBytes: 0, sideMtime: null, side: null };
      const ss = await exists(path.join(kdir, `${logName}.json`));
      if (ss?.isFile()) {
        row.sideBytes = ss.size;
        row.sideMtime = ss.mtimeMs;
        try { row.side = sideFacts(JSON.parse(await fsp.readFile(path.join(kdir, `${logName}.json`), 'utf8'))); } catch { row.side = null; }
      }
      c.rows.set(logName, row);
    }
    // a sidecar that came before its log was counted apart: read whole next time
    if (c.orphanBytes) { cats.delete(key); return; }
    c.dirMtime = (await exists(kdir))?.mtimeMs ?? null;
  }

  /** The folder changed here in a way the catalogue does not show (an upload started, a stale one dropped). */
  async function ownChange(key) {
    const c = cats.get(key);
    if (c && !c.loading) c.dirMtime = (await exists(path.join(dir, key)))?.mtimeMs ?? null;
  }

  async function carKeys() {
    try { return (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  }

  /** How many finished logs, and how many bytes of logs and sidecars, without listing them. */
  async function summary() {
    let bytes = 0;
    let count = 0;
    const keys = [];
    for (const key of await carKeys()) {
      const c = await catalogue(key);
      if (!c.rows.size && !c.orphanBytes) continue;
      keys.push(key);
      count += c.rows.size;
      bytes += c.orphanBytes;
      for (const r of c.rows.values()) bytes += rowBytes(r);
    }
    return { bytes, count, keys };
  }

  /** Every finished log, newest first: name, vehicleKey, start, size, sidecar facts. */
  async function list({ limit = 200 } = {}) {
    const all = [];
    let bytes = 0;
    for (const key of await carKeys()) {
      const c = await catalogue(key);
      bytes += c.orphanBytes;
      for (const r of c.rows.values()) { bytes += rowBytes(r); all.push(r); }
    }
    all.sort((a, b) => b.startedAtMs - a.startedAtMs || b.seq - a.seq);
    const logs = all.slice(0, Math.max(1, Math.min(2000, limit))).map((r) => ({
      name: r.name, vehicleKey: r.vehicleKey, startedAt: new Date(r.startedAtMs).toISOString(), seq: r.seq, bytes: r.bytes, receivedAt: new Date(r.mtimeMs).toISOString(),
      sidecar: Boolean(r.side), frames: r.side?.frames ?? null, dropped: r.side?.dropped ?? null, appVersion: r.side?.appVersion ?? null,
      format: r.side?.format ?? null, closedBecause: r.side?.closedBecause ?? null
    }));
    return { logs, bytes, count: all.length };
  }

  /** Every finished log of one car key (catalogue rows: name, startedAtMs, seq, bytes, ...). */
  async function rowsOf(key) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(String(key || ''))) return [];
    return [...(await catalogue(key)).rows.values()];
  }

  /** Delete one log and its sidecar (the Nerd settings, and with its footage: canPrune.js). */
  async function remove(name) {
    const n = parseName(name);
    if (!n || n.sidecar) throw canError(400, 'bad_name', 'That is not a CAN Bridge log name.');
    const file = fileOf(name);
    if (!(await exists(file))) throw canError(404, 'not_found', 'No such log.');
    for (const f of [file, `${file}.json`, `${file}.part`, `${file}.part.json`]) await fsp.rm(f, { force: true });
    await noteChanged(n.vehicleKey, name);
  }

  return { status, receive, list, summary, remove, rowsOf, stateOf, cleanStale, MAX_CHUNK, MAX_FILE, MAX_SIDECAR };
}

module.exports = { createCanLogs, parseName, MAX_CHUNK, MAX_FILE, MAX_SIDECAR, MAX_LOGS_PER_CAR };
