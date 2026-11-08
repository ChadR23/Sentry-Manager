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
const MAX_FILE = 1024 * 1024 * 1024; // one log (a 10-minute log is about 17 MB)
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

function createCanLogs({ dir, freeBytes = async () => Infinity, now = () => Date.now(), maxFilesPerCar = 20_000, minFree = 2 * 1024 ** 3 }) {
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
        let count = 0;
        try { count = (await fsp.readdir(path.dirname(file))).length; } catch { /* a new car */ }
        if (count >= maxFilesPerCar) throw canError(507, 'car_full', `This car has ${maxFilesPerCar} CAN files already: the owner can delete old ones in the Nerd settings.`, { received: 0 });
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
      return { received, length, complete: true };
    } finally {
      busy.delete(file);
    }
  }

  /** Every finished log, newest first: name, vehicleKey, start, size, sidecar facts. */
  async function list({ limit = 200 } = {}) {
    const out = [];
    let keys = [];
    try { keys = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return { logs: [], bytes: 0, count: 0 }; }
    let bytes = 0;
    let count = 0;
    for (const key of keys) {
      let names = [];
      try { names = await fsp.readdir(path.join(dir, key)); } catch { continue; }
      for (const name of names) {
        const n = parseName(name);
        const st = n ? await exists(path.join(dir, key, name)) : null;
        if (!st) continue;
        bytes += st.size;
        if (n.sidecar) continue;
        count++;
        let side = null;
        if (names.includes(`${name}.json`)) {
          try { side = JSON.parse(await fsp.readFile(path.join(dir, key, `${name}.json`), 'utf8')); } catch { side = null; }
        }
        out.push({
          name, vehicleKey: n.vehicleKey, startedAt: new Date(n.startedAt).toISOString(), seq: n.seq, bytes: st.size, receivedAt: new Date(st.mtimeMs).toISOString(),
          sidecar: Boolean(side), frames: Number.isFinite(side?.frames) ? side.frames : null,
          dropped: [side?.dropped_chunks, side?.dropped].find((x) => Number.isFinite(x)) ?? null,
          appVersion: [side?.app_version, side?.appVersion].find((x) => typeof x === 'string')?.slice(0, 40) ?? null
        });
      }
    }
    out.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.seq - a.seq);
    return { logs: out.slice(0, Math.max(1, Math.min(2000, limit))), bytes, count };
  }

  /** Delete one log and its sidecar (the Nerd settings). */
  async function remove(name) {
    const n = parseName(name);
    if (!n || n.sidecar) throw canError(400, 'bad_name', 'That is not a CAN Bridge log name.');
    const file = fileOf(name);
    if (!(await exists(file))) throw canError(404, 'not_found', 'No such log.');
    for (const f of [file, `${file}.json`, `${file}.part`, `${file}.part.json`]) await fsp.rm(f, { force: true });
  }

  return { status, receive, list, remove, stateOf, cleanStale, MAX_CHUNK, MAX_FILE, MAX_SIDECAR };
}

module.exports = { createCanLogs, parseName, MAX_CHUNK, MAX_FILE, MAX_SIDECAR };
