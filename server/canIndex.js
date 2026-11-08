'use strict';

// The CAN index: each uploaded CAN Bridge log is read once in the background
// and decoded (canDbc.js), so the Viewer only fetches what one clip needs,
// already in signals. For every car (vehicleKey) and UTC minute:
//
//   <DATA>/can-index/<vehicleKey>/<yyyyMMddTHHmm>.json.gz
//     { minute, enc, act, trust, logs: { "<log name>": { span: [first ms, last ms], ids, trust } },
//       signals: { name: [[ms since the minute, value], …] },
//       ids: { "can0:2E5": frames, … } }       (unknown ids are counted too; last,
//                                               canSearch.js reads only them)
//     (on disk each series is two columns, time steps and values: canFormat.js;
//     `act` is what the minute shows of the car, for the archive gap check)
//   <DATA>/can-index/<vehicleKey>/signals.json   every signal seen, with unit,
//                                                range, value names, bus
//   <DATA>/can-index/<vehicleKey>/<yyyyMMddTHHmm>.raw.json.gz
//     { minute, raw: { "can0:2E5": [[ms since the minute, "PAYLOADHEX"], …] },
//       logs: { "<log name>": { span: [first ms, last ms], buses: { can0: 'VehicleBus' },
//                               ids: { "can0:2E5": frames } } } }
//     every id's payload as it changes (decodable or not), for the Viewer's raw
//     view: at most RAW_PER_SEC changes a second per id, the last payload of
//     each second, and each id's payload at the start of the minute
//   <DATA>/can-index/<vehicleKey>/ids-<yyyyMMdd>.json  every id of that UTC day:
//     { v, ids: { "can0:2E5": [first minute, last minute, minutes] } }, made
//     from the minutes' tops when asked for (new ids since a date) and
//     removed whenever a minute of the day is written
//   <DATA>/can-index/done.json                   which logs are indexed
//     ("<size>/<mtime>/<FORMAT>[/<sidecar size>-<sidecar mtime>]": a log
//     indexed by an older format is read again, and only what that format
//     lacked is written; a sidecar that comes, or changes, after its log has
//     the log indexed again with its bus map)
//
// Indexing a log again replaces its own part of each minute: what it wrote
// before (its frame counts, and its points within its own span of the
// minute) is taken out first, so nothing is counted twice. A log whose xz
// ends early (cut off when the bridge lost power) keeps what could be read.
//
// A signal keeps a point when its value changes, at most 20 a second (the
// last value of each 50 ms wins), and once a second while it stays the same.
// The raw logs stay as they came: a better DBC later means indexing again.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { parseName } = require('./canLogs');
const fmt = require('./canFormat');
const { bundledDbc, decodeFrame } = require('./canDbc');

// a log is read line by line with bounds: no line longer than this (a candump line is under 100
// bytes), and no more than this many bytes unpacked from one log (a 10-minute log is about 150 MB),
// so a crafted file (one endless line, or a tiny file that unpacks to terabytes) cannot use up memory
const MAX_LINE = 512;
const MAX_UNPACKED = 4 * 1024 ** 3;

/** Lines from a stream, each at most maxLine bytes (longer ones are skipped), stopping after maxTotal bytes. */
async function* boundedLines(stream, { maxLine = MAX_LINE, maxTotal = MAX_UNPACKED, onLimit = () => {} } = {}) {
  let rest = '';
  let total = 0;
  let skipping = false;
  const chunks = (async function* read() {
    // a stream closed early (xz could not start, or was stopped) just ends the lines
    try { for await (const c of stream) yield c; } catch (err) { if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err; }
  }());
  for await (const chunk of chunks) {
    total += chunk.length;
    if (total > maxTotal) { onLimit(); return; }
    const text = chunk.toString('latin1');
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl < 0) break;
      if (skipping) skipping = false;
      else {
        const line = rest + text.slice(start, nl);
        if (line.length <= maxLine) yield line;
      }
      rest = '';
      start = nl + 1;
    }
    if (!skipping) {
      rest += text.slice(start);
      if (rest.length > maxLine) { rest = ''; skipping = true; }
    }
  }
  if (!skipping && rest) yield rest;
}

const STEP_MS = 50; // at most 20 points a second per signal
const RAW_PER_SEC = 10; // raw payload changes kept a second per id
// the index format: r1 added the raw snapshots (an older stamp has none)
const FORMAT = 'r1';
const KEEP_MS = 1000; // a point at least once a second
// the interface is a plain name (can0, vcan1): anything else in a log line is not indexed, so a
// crafted log cannot make up ids (each a key in the index) or put a formula into a CSV download
const IFACE = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;
const LINE = /^\((\d+)\.(\d+)\)\s+([A-Za-z][A-Za-z0-9_]{0,15})\s+([0-9A-Fa-f]{1,8})#([0-9A-Fa-f]*)\s*$/;
const goodId = (idKey) => IFACE.test(String(idKey).split(':')[0]);
const DEFAULT_BUSES = { can0: 'VehicleBus', can1: 'ChassisBus' };

const minuteKey = (ms) => new Date(Math.floor(ms / 60000) * 60000).toISOString().slice(0, 16).replace(/[-:]/g, '');

// how far a minute's data can be trusted, worst first (canTrust.js)
const TRUST_RANK = { override: 0, unsigned: 1, verified: 2 };
const worseTrust = (a, b) => (a === undefined ? b : b === undefined ? a : (TRUST_RANK[a] ?? 1) <= (TRUST_RANK[b] ?? 1) ? a : b);

/** Which DBC bus each interface is: the sidecar's bus map, else can0 vehicle and can1 chassis. */
function busMapOf(side) {
  const busOf = { ...DEFAULT_BUSES };
  const map = side?.bus || side?.busMap || side?.buses || null;
  if (map && typeof map === 'object') {
    for (const [iface, v] of Object.entries(map)) {
      const s = String(typeof v === 'object' ? v?.dbcBus || v?.name || '' : v).toLowerCase();
      if (/vehicle/.test(s)) busOf[iface] = 'VehicleBus';
      else if (/chassis/.test(s)) busOf[iface] = 'ChassisBus';
      else if (/party/.test(s)) busOf[iface] = 'PartyBus';
    }
  }
  return busOf;
}

const MINUTE_FILE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})\.json\.gz$/;
const RAW_FILE = /^(\d{8}T\d{4})\.raw\.json\.gz$/;
const ID_DAY = 'v1';
const dayFile = (dayKey) => `ids-${dayKey}.json`;
const MINUTE_CACHE = 4; // parsed minutes kept for the Viewer (a busy minute is tens of MB parsed)
const CLIP_STEP_MS = 250; // every signal of a clip (the Viewer's list): the last value each 250 ms
const minuteOfFile = (f) => { const m = MINUTE_FILE.exec(f); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null; };

/** Write a file whole or not at all (a failed write leaves no .tmp file behind). */
async function writeAtomic(file, body) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * A minute without one log's part: its frame counts taken off, and its points
 * (signal values or raw payloads) within its span of the minute taken out.
 * `old` is that log's record ({ span, ids }), or nothing when it had no part.
 */
function withoutPart({ signals, ids = {} }, old) {
  if (!old || !Array.isArray(old.span)) return { signals, ids };
  const [a, b] = old.span;
  const outSignals = {};
  for (const [nm, pts] of Object.entries(signals)) {
    const keep = pts.filter((p) => p[0] < a || p[0] > b);
    if (keep.length) outSignals[nm] = keep;
  }
  const outIds = { ...ids };
  for (const [id, n] of Object.entries(old.ids || {})) {
    const left = (outIds[id] || 0) - n;
    if (left > 0) outIds[id] = left; else delete outIds[id];
  }
  return { signals: outSignals, ids: outIds };
}

/** The part of a stamp that names the sidecar: its size and mtime, or nothing when there is none. */
async function sidecarStamp(file) {
  const st = await fsp.stat(`${file}.json`).catch(() => null);
  return st ? `/${st.size}-${Math.round(st.mtimeMs)}` : '';
}

function createCanIndex({ canDir, dir, log = null, idle = () => true, dbc = bundledDbc, xz = 'xz', onIndexed = null, onProgress = null, usable = async () => ({ use: true, trust: 'unsigned' }), maxUnpacked = MAX_UNPACKED, autoRepack = true }) {
  const doneFile = path.join(dir, 'done.json');
  let done = null;
  const loadDone = async () => {
    if (done) return done;
    try { done = JSON.parse(await fsp.readFile(doneFile, 'utf8')) || {}; } catch { done = {}; }
    return done;
  };
  const saveDone = async () => {
    await fsp.mkdir(dir, { recursive: true });
    await writeAtomic(doneFile, JSON.stringify(done));
  };
  const status = { running: false, current: null, indexed: 0, pending: 0, lastError: null, lastAt: null };
  // the Nerd panel's progress line (index.js throttles it)
  const progress = () => { try { onProgress?.({ ...status }); } catch { /* the caller's own business */ } };

  // a few parsed minutes, for the Viewer: the next clip shares most of its minutes with this one
  const minuteCache = new Map(); // key/minute -> Promise<data|null>
  let generation = 0; // bumped on every change to the index (callers cache answers by it)
  const changed = (key, minute) => { minuteCache.delete(`${key}/${minute}`); generation++; };
  function readMinute(key, minute, { cache = false } = {}) {
    const file = path.join(dir, key, `${minute}.json.gz`);
    if (!cache) return fmt.readMinuteFile(file);
    const k = `${key}/${minute}`;
    let p = minuteCache.get(k);
    if (p) { minuteCache.delete(k); minuteCache.set(k, p); return p; } // most recently used last
    p = fmt.readMinuteFile(file);
    minuteCache.set(k, p);
    while (minuteCache.size > MINUTE_CACHE) minuteCache.delete(minuteCache.keys().next().value);
    return p;
  }
  // one change at a time to a car key's minute files (indexing, removing a log, repacking)
  const locks = new Map();
  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.catch(() => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return p;
  }
  // the per-day id summaries: one is removed before any minute of its day changes (a crash in
  // between leaves no stale summary), and one made while a minute changed is not saved
  const dayGen = new Map(); // key/day -> changes
  async function dayChanged(key, minute) {
    const day = minute.slice(0, 8);
    dayGen.set(`${key}/${day}`, (dayGen.get(`${key}/${day}`) || 0) + 1);
    await fsp.rm(path.join(dir, key, dayFile(day)), { force: true });
  }
  /**
   * Write one log's part of a minute. A minute can span two logs: merge with
   * what is there, after taking out what this log wrote before (`before`: its
   * record in the raw file, for a minute written before the per-log records).
   */
  async function writeMinute(key, minute, data, name, part, before = null) {
    const had = await readMinute(key, minute);
    const logs = {};
    let signals = data.signals;
    let ids = data.ids;
    if (had) {
      // a minute from before the per-log records: its trust is kept as a part of its own
      if (had.logs) Object.assign(logs, had.logs);
      else if (had.trust) logs[''] = { trust: had.trust };
      const old = had.logs ? had.logs[name] : before;
      const rest = withoutPart({ signals: had.signals || {}, ids: had.ids || {} }, old);
      for (const [nm, pts] of Object.entries(rest.signals)) {
        const mine = signals[nm];
        signals[nm] = mine ? [...pts, ...mine].sort((a, b) => a[0] - b[0]).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0]) : pts;
      }
      ids = { ...rest.ids };
      for (const [id, n] of Object.entries(data.ids)) ids[id] = (ids[id] || 0) + n;
    }
    logs[name] = part;
    let trust;
    for (const p of Object.values(logs)) trust = worseTrust(trust, p.trust);
    // the frame counts last: canSearch.js reads only them, from the end of the file
    const body = await fmt.packMinute({ minute, trust, logs, signals, ids });
    await fsp.mkdir(path.join(dir, key), { recursive: true });
    await dayChanged(key, minute);
    await writeAtomic(path.join(dir, key, `${minute}.json.gz`), body);
    changed(key, minute);
  }
  // ---- raw snapshots (<minute>.raw.json.gz): merged so that indexing a log again replaces its own part
  const rawCache = new Map(); // key/minute -> Promise<data|null> (a few, for the Viewer's fetches)
  function readRaw(key, minute) {
    const k = `${key}/${minute}`;
    if (!rawCache.has(k)) {
      rawCache.set(k, fmt.readRawFile(path.join(dir, key, `${minute}.raw.json.gz`)));
      if (rawCache.size > 6) rawCache.delete(rawCache.keys().next().value);
    }
    return rawCache.get(k);
  }
  async function rawNow(key, minute) {
    rawCache.delete(`${key}/${minute}`);
    const had = await readRaw(key, minute);
    rawCache.delete(`${key}/${minute}`);
    return had;
  }
  /** Write one log's part of a minute's raw snapshots, after taking out what it wrote before. */
  async function writeRaw(key, minute, data, name, had) {
    if (had) {
      const rest = withoutPart({ signals: had.raw || {} }, had.logs?.[name]).signals;
      for (const [id, pts] of Object.entries(rest)) {
        const mine = data.raw[id];
        data.raw[id] = mine ? [...pts, ...mine].sort((a, b) => a[0] - b[0]).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]) : pts;
      }
      data.logs = { ...had.logs, ...data.logs };
    }
    await fsp.mkdir(path.join(dir, key), { recursive: true });
    await writeAtomic(path.join(dir, key, `${minute}.raw.json.gz`), await fmt.packRaw(data));
    rawCache.delete(`${key}/${minute}`);
    generation++;
  }
  async function mergeSignals(key, seen) {
    const file = path.join(dir, key, 'signals.json');
    let all = {};
    try { all = JSON.parse(await fsp.readFile(file, 'utf8')) || {}; } catch { /* first */ }
    for (const [name, meta] of seen) all[name] = meta;
    await fsp.mkdir(path.join(dir, key), { recursive: true });
    await writeAtomic(file, JSON.stringify(all));
  }

  /** Index one log: decode every frame, write its minutes (rawOnly: only the raw snapshots, for a log indexed before them). */
  async function indexLog(key, name, { rawOnly = false, trust } = {}) {
    const file = path.join(canDir, key, name);
    let side = {};
    try { side = JSON.parse(await fsp.readFile(`${file}.json`, 'utf8')) || {}; } catch { /* no sidecar */ }
    const busOf = busMapOf(side);
    const { messages } = dbc();
    const seen = new Map();
    let minute = null;
    let minuteStart = 0;
    let minuteNo = null; // the minute as a number: a frame's minute is told by it, not by a date string
    let bucket = null;
    const last = new Map(); // signal -> { t, v, pt (last kept time), pending }
    const flushPending = () => {
      for (const [nm, s] of last) if (s.pending && bucket) { (bucket.signals[nm] ||= []).push([s.pending[0] - minuteStart, s.pending[1]]); s.pt = s.pending[0]; s.pending = null; }
    };
    // raw: per id { v: the last payload seen, sec, n: changes kept this second, pending: [t, hex] held back by the limit }
    const rawLast = new Map();
    let rawBucket = null;
    let rawLog = null; // this log's part of the minute: { span, buses, ids }
    const keepRaw = (idKey, t, hex) => { (rawBucket.raw[idKey] ||= []).push([Math.round(t - minuteStart), hex.toUpperCase()]); };
    const flushRaw = () => {
      for (const [idKey, s] of rawLast) if (s.pending && rawBucket) { keepRaw(idKey, s.pending[0], s.pending[1]); s.pending = null; }
    };
    const writes = [];
    const closeMinute = () => {
      if (!bucket) return;
      flushPending();
      flushRaw();
      writes.push([minute, bucket, rawBucket, { span: rawLog.span, ids: rawLog.ids, ...(trust ? { trust } : {}) }]);
      bucket = null;
      rawBucket = null;
    };
    const writeOut = ([a, b, rawData, part]) => withLock(key, async () => {
      // the raw file's record of this log, from before: what it wrote to the minute
      const hadRaw = await rawNow(key, a);
      if (!rawOnly) await writeMinute(key, a, b, name, part, hadRaw?.logs?.[name] || null);
      await writeRaw(key, a, rawData, name, hadRaw);
    });
    const child = spawn(xz, ['-dc', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let spawnError = null;
    child.stderr.on('data', (c) => { if (stderr.length < 4096) stderr += c; });
    let tooBig = false;
    const lines = boundedLines(child.stdout, { maxTotal: maxUnpacked, onLimit: () => { tooBig = true; child.kill(); } });
    // how xz ended: its exit code, or null when it could not be started (no xz, no free process slot)
    const exited = new Promise((ok) => {
      child.once('error', (err) => { spawnError = err; child.stdout.destroy(); ok(null); });
      child.once('close', (code) => ok(code));
    });
    let frames = 0;
    let written = 0;
    let first = null;
    let lastT = null;
    let ended = false;
    try {
      for await (const line of lines) {
        const m = LINE.exec(line);
        if (!m) continue;
        const t = Number(m[1]) * 1000 + Number(`0.${m[2]}`) * 1000;
        const no = Math.floor(t / 60000);
        if (no !== minuteNo) {
          if (minute) written++;
          closeMinute(); // (with the minute before's start: what it held back goes there)
          minuteNo = no;
          minuteStart = no * 60000;
          const mk = minuteKey(minuteStart);
          minute = mk;
          bucket = { minute: mk, signals: {}, ids: {} };
          rawLog = { span: [Math.round(t - minuteStart), Math.round(t - minuteStart)], buses: busOf, ids: {} };
          rawBucket = { minute: mk, raw: {}, logs: { [name]: rawLog } };
          for (const s of last.values()) s.pt = -Infinity; // each minute starts with every signal's value
          for (const s of rawLast.values()) s.v = null; // ... and every id's payload
          if (writes.length >= 2) await writeOut(writes.shift());
        }
        frames++;
        if (first === null) first = t;
        lastT = t;
        const iface = m[3];
        const idKey = `${iface}:${m[4].toUpperCase()}`;
        bucket.ids[idKey] = (bucket.ids[idKey] || 0) + 1;
        // raw: the payload when it changes (a string compare for the frames that repeat)
        rawLog.ids[idKey] = (rawLog.ids[idKey] || 0) + 1;
        rawLog.span[1] = Math.round(t - minuteStart);
        const hex = m[5];
        let r = rawLast.get(idKey);
        if (!r) { r = { v: null, sec: -1, n: 0, pending: null }; rawLast.set(idKey, r); }
        if (hex !== r.v) {
          r.v = hex;
          const sec = Math.floor(t / 1000);
          if (sec !== r.sec) {
            // the last payload of the second before, when the limit held it back
            if (r.pending) { keepRaw(idKey, r.pending[0], r.pending[1]); r.pending = null; }
            r.sec = sec;
            r.n = 0;
          }
          if (r.n < RAW_PER_SEC) { keepRaw(idKey, t, hex); r.n++; r.pending = null; } else r.pending = [t, hex];
        }
        if (rawOnly) continue;
        const id = parseInt(m[4], 16);
        const msg = messages.get(id);
        if (!msg || (busOf[iface] && msg.bus !== busOf[iface])) continue;
        const bytes = Buffer.from(m[5], 'hex');
        for (const [sig, v] of decodeFrame(msg, bytes)) {
          const nm = sig.name;
          if (!seen.has(nm)) seen.set(nm, { label: sig.comment || nm, unit: sig.unit || '', min: sig.min, max: sig.max, values: sig.values, bus: sig.bus, message: sig.message, id: sig.messageId });
          let s = last.get(nm);
          if (!s) { s = { pt: -Infinity, v: undefined, pending: null }; last.set(nm, s); }
          const value = Math.round(v * 1e6) / 1e6;
          if (value === s.v && t - s.pt < KEEP_MS) {
            // a change held back (under 50 ms after the last point) is kept at its own time once 50 ms have gone by,
            // not a second later (the CAN sync matches these edges to the footage)
            if (s.pending && t - s.pt >= STEP_MS) { (bucket.signals[nm] ||= []).push([s.pending[0] - minuteStart, s.pending[1]]); s.pt = s.pending[0]; s.pending = null; }
            continue;
          }
          s.v = value;
          if (t - s.pt >= STEP_MS) {
            (bucket.signals[nm] ||= []).push([Math.round(t - minuteStart), value]);
            s.pt = t;
            s.pending = null;
          } else s.pending = [Math.round(t), value];
        }
        if (frames % 200000 === 0) await new Promise((r) => setImmediate(r)); // let requests through
      }
      ended = true;
    } finally {
      // a write that failed partway: stop xz, which would wait for ever on its full pipe
      if (!ended && child.exitCode === null && child.signalCode === null) { child.kill(); child.stdout.destroy(); }
    }
    closeMinute();
    const code = await exited;
    // (not this log's fault: it is read again at the next look)
    if (spawnError) throw Object.assign(new Error(`xz could not be started for ${name}: ${spawnError.message}`), { retry: true });
    // xz stopped early (a log cut off, or damaged): what it read before is kept, unless that is nothing
    const truncated = code !== 0 || tooBig;
    const why = tooBig ? `it unpacks to more than ${Math.round(maxUnpacked / 1024 ** 2)} MB (stopped there)` : `${stderr.trim().slice(0, 200) || `exit ${code}`}`;
    if (truncated && !frames) throw new Error(`xz could not read ${name}: ${why}`);
    for (const w of writes) await writeOut(w);
    if (!rawOnly) await mergeSignals(key, seen);
    const minutes = written + (minute ? 1 : 0);
    return { frames, minutes, from: first, to: lastT, ...(truncated ? { truncated: `xz stopped early: ${why}` } : {}) };
  }

  /** Every complete log not indexed yet, oldest first. */
  async function pendingLogs() {
    const d = await loadDone();
    const out = [];
    let keys = [];
    try { keys = (await fsp.readdir(canDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
    for (const key of keys) {
      let names = [];
      try { names = await fsp.readdir(path.join(canDir, key)); } catch { continue; }
      for (const name of names) {
        const n = parseName(name);
        if (!n || n.sidecar) continue;
        const st = await fsp.stat(path.join(canDir, key, name)).catch(() => null);
        if (!st) continue;
        const file = `${st.size}/${Math.round(st.mtimeMs)}`;
        // the sidecar is part of the stamp: one that comes (or changes) later has the log read again with its bus map
        const side = await sidecarStamp(path.join(canDir, key, name));
        const stamp = `${file}/${FORMAT}${side}`;
        const had = d[`${key}/${name}`];
        if (had === stamp) continue;
        // only logs whose check allows it (canTrust: verified, unsigned before pairing, or used anyway);
        // the others wait, and are looked at again when their check changes
        const ok = await usable(key, name).catch(() => ({ use: false }));
        if (!ok.use) continue;
        // indexed before the raw snapshots (the same file, no sidecar since): only those are written now
        out.push({ key, name, stamp, startedAt: n.startedAt, rawOnly: had === file && !side, trust: ok.trust });
      }
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  }

  let running = null;
  let again = false;
  /** Index what is new (after an upload, and at start). */
  function kick() {
    if (running) { again = true; return running; }
    const indexedBefore = status.indexed;
    running = (async () => {
      status.running = true;
      do {
        again = false;
        const todo = await pendingLogs();
        status.pending = todo.length;
        if (todo.length) progress();
        for (const job of todo) {
          while (!idle()) await new Promise((r) => setTimeout(r, 2000));
          status.current = job.name;
          progress();
          try {
            const r = await indexLog(job.key, job.name, { rawOnly: job.rawOnly, trust: job.trust });
            (await loadDone())[`${job.key}/${job.name}`] = job.stamp;
            await saveDone();
            status.indexed++;
            log?.info?.(`CAN index: ${job.name}: ${r.frames} frames, ${r.minutes} minute(s)`);
            if (r.truncated) {
              status.lastError = `${job.name}: ${r.truncated} (what was read before is indexed)`;
              log?.warn?.(`CAN index: ${status.lastError}`);
            }
            try { onIndexed?.(job.key, r.from, r.to); } catch { /* the sync's own business */ }
          } catch (err) {
            status.lastError = `${job.name}: ${err.message}`;
            log?.warn?.(`CAN index: ${status.lastError}`);
            if (!err.retry) {
              (await loadDone())[`${job.key}/${job.name}`] = job.stamp; // not again until the file changes
              await saveDone();
            }
          }
          status.pending--;
        }
        // nothing waiting: older minute files into the smaller layout (stops for a new upload)
        if (!again && autoRepack) await repack({ shouldStop: () => again });
      } while (again);
    })().catch((err) => { status.lastError = err.message; }).finally(() => {
      running = null;
      const worked = status.indexed;
      Object.assign(status, { running: false, current: null, lastAt: Date.now() });
      if (worked !== indexedBefore || status.lastError) progress();
    });
    return running;
  }

  /**
   * `pts` (sorted, the first the value at `from`) thinned to the last value of
   * each `step` ms (counted from `from`); `dropRepeats`: a value the same as the
   * one kept before it is left out too.
   */
  function thin(pts, from, step, dropRepeats) {
    const out = [pts[0]];
    for (let k = 1; k < pts.length; k++) {
      const p = pts[k];
      const next = pts[k + 1];
      // (the last point of its step only)
      if (next && Math.floor((next[0] - from) / step) === Math.floor((p[0] - from) / step)) continue;
      if (!dropRepeats || p[1] !== out[out.length - 1][1]) out.push(p);
    }
    return out;
  }
  /** The worst trust of the data between two times: verified, unsigned or override (used despite failing its check), or null. */
  async function trustOf(keys, from, to) {
    let t;
    for (const key of keys) {
      for (let m = Math.floor(from / 60000) * 60000; m <= to; m += 60000) {
        // only the top of each file: the trust is there, before the signals
        const head = await fmt.readHead(path.join(dir, key, `${minuteKey(m)}.json.gz`));
        if (head) t = worseTrust(t, head.trust || 'unsigned');
      }
    }
    return t || null;
  }

  /**
   * The signals of these cars between two times, and the worst trust of the minutes inside it:
   * { series: { name: [[ms (UTC), value], …] } (the value before `from` too), trust }. Each
   * minute is read once (and kept for the next clip).
   * `step` (ms, optional): thin each signal to the last value of each step (from
   * `from`), for a list of live values; `dropRepeats` also leaves out a value the
   * same as the one before (the value now is the same at any moment). Then
   * `changing` (a Set, optional) gets each name whose value changes anywhere in
   * the window, from every point, not the thinned ones.
   */
  async function clipData(keys, from, to, names, { step = 0, dropRepeats = false, changing = null } = {}) {
    const want = names ? new Set(names) : null;
    const out = {};
    let trust;
    for (const key of keys) {
      // the minute before as well, for each signal's value at `from`
      for (let t = Math.floor(from / 60000) * 60000 - 60000; t <= to; t += 60000) {
        const data = await readMinute(key, minuteKey(t), { cache: true });
        if (!data) continue;
        if (t + 60000 > from) trust = worseTrust(trust, data.trust || 'unsigned');
        for (const [name, pts] of Object.entries(data.signals || {})) {
          if (want && !want.has(name)) continue;
          const list = (out[name] ||= []);
          for (const [ms, v] of pts) list.push([t + ms, v]);
        }
        await new Promise((r) => setImmediate(r)); // other requests between minutes
      }
    }
    for (const [name, pts] of Object.entries(out)) {
      if (keys.length > 1) pts.sort((a, b) => a[0] - b[0]);
      else if (pts.some((p, i) => i && p[0] < pts[i - 1][0])) pts.sort((a, b) => a[0] - b[0]);
      // keep the last point before `from` and everything up to `to`
      let i = 0;
      while (i + 1 < pts.length && pts[i + 1][0] <= from) i++;
      let end = i;
      while (end < pts.length && pts[end][0] <= to) end++;
      if (end === i) { delete out[name]; continue; }
      let kept = i === 0 && end === pts.length ? pts : pts.slice(i, end);
      if (changing && kept.some((p) => p[1] !== kept[0][1])) changing.add(name);
      if (step > 0) kept = thin(kept, from, step, dropRepeats);
      out[name] = kept;
    }
    return { series: out, trust: trust || null };
  }

  /** The signals of these cars between two times: { name: [[ms (UTC), value], …] } (the value before `from` too). */
  async function series(keys, from, to, names, opts) {
    return (await clipData(keys, from, to, names, opts)).series;
  }

  /**
   * Every CAN id of these cars between two times, decodable or not, for the
   * Viewer's raw view: [{ key ("can0:2E5"), bus ("can0"), id ("2E5"), name (the
   * DBC's message, else null), hz, changes: [[ms (UTC), "HEX"], …] }], sorted
   * by id; the first change is the payload at `from` when there is one before.
   */
  async function raw(keys, from, to) {
    const { messages } = dbc();
    const out = new Map();
    const entry = (idKey) => {
      let e = out.get(idKey);
      if (!e) { e = { key: idKey, pts: [], frames: 0, ms: 0, bus: null }; out.set(idKey, e); }
      return e;
    };
    for (const key of keys) {
      // the minute before as well, for each id's payload at `from`
      for (let t = Math.floor(from / 60000) * 60000 - 60000; t <= to; t += 60000) {
        const data = await readRaw(key, minuteKey(t));
        if (!data) continue;
        for (const [idKey, pts] of Object.entries(data.raw || {})) {
          const e = entry(idKey);
          for (const [ms, hex] of pts) e.pts.push([t + ms, hex]);
        }
        const inside = t + 60000 > from; // the rate from the minutes of the window only
        for (const lg of Object.values(data.logs || {})) {
          const span = Math.max(1000, (lg.span?.[1] ?? 0) - (lg.span?.[0] ?? 0));
          for (const [idKey, n] of Object.entries(lg.ids || {})) {
            const e = entry(idKey);
            e.bus ||= lg.buses?.[idKey.split(':')[0]] || null;
            if (inside) { e.frames += n; e.ms += span; }
          }
        }
      }
    }
    const list = [];
    for (const e of out.values()) {
      e.pts.sort((a, b) => a[0] - b[0]);
      let i = 0;
      while (i + 1 < e.pts.length && e.pts[i + 1][0] <= from) i++;
      // (each minute starts with every id's payload: only real changes are sent)
      const changes = [];
      for (let k = i; k < e.pts.length && e.pts[k][0] <= to; k++) if (!changes.length || changes[changes.length - 1][1] !== e.pts[k][1]) changes.push(e.pts[k]);
      if (!changes.length) continue;
      const [iface, hexId] = e.key.split(':');
      const msg = messages.get(parseInt(hexId, 16));
      const known = msg && (!e.bus || msg.bus === e.bus);
      list.push({ key: e.key, bus: iface, id: hexId, name: known ? msg.name : null, hz: e.ms ? Math.round((e.frames / e.ms) * 10000) / 10 : 0, changes });
    }
    return list.sort((a, b) => parseInt(a.id, 16) - parseInt(b.id, 16) || a.bus.localeCompare(b.bus));
  }

  /** Every signal seen for these cars, with unit, range and value names. */
  async function signals(keys) {
    const all = {};
    for (const key of keys) {
      try { Object.assign(all, JSON.parse(await fsp.readFile(path.join(dir, key, 'signals.json'), 'utf8'))); } catch { /* none yet */ }
    }
    return all;
  }

  /** Forget a deleted log's index entry (its minutes stay until indexed again). */
  async function forget(key, name) {
    const d = await loadDone();
    delete d[`${key}/${name}`];
    await saveDone();
  }

  /**
   * Take one log's data out of the index (deleted, or no longer used): its part of every minute
   * it wrote is removed (by the per-log records), then it counts as not indexed. A log covers at
   * most a few minutes from the start in its name; those minutes are the ones looked at.
   */
  async function removeLog(key, name) {
    const n = parseName(name);
    if (!n) return 0;
    let count = 0;
    for (let t = n.startedAt - 2 * 60_000; t <= n.startedAt + 30 * 60_000; t += 60_000) {
      if (await withLock(key, () => removeFromMinute(key, minuteKey(t), name))) count++;
    }
    await forget(key, name);
    return count;
  }
  async function removeFromMinute(key, minute, name) {
    let removed = false;
    const had = await readMinute(key, minute);
    if (had?.logs?.[name]) {
      const rest = withoutPart({ signals: had.signals || {}, ids: had.ids || {} }, had.logs[name]);
      const logs = { ...had.logs };
      delete logs[name];
      const file = path.join(dir, key, `${minute}.json.gz`);
      await dayChanged(key, minute);
      if (!Object.keys(logs).length) await fsp.rm(file, { force: true });
      else {
        let trust;
        for (const p of Object.values(logs)) trust = worseTrust(trust, p.trust);
        await writeAtomic(file, await fmt.packMinute({ minute, trust, logs, signals: rest.signals, ids: rest.ids }));
      }
      changed(key, minute);
      removed = true;
    }
    const raw = await rawNow(key, minute);
    if (raw?.logs?.[name]) {
      const rest = withoutPart({ signals: raw.raw || {} }, raw.logs[name]).signals;
      const logs = { ...raw.logs };
      delete logs[name];
      const file = path.join(dir, key, `${minute}.raw.json.gz`);
      if (!Object.keys(logs).length) await fsp.rm(file, { force: true });
      else await writeAtomic(file, await fmt.packRaw({ ...raw, raw: rest, logs }));
      rawCache.delete(`${key}/${minute}`);
      generation++;
    }
    return removed;
  }

  /** The minute times (UTC ms) of one car key's index files between two times, oldest first. */
  async function minuteTimes(key, from = -Infinity, to = Infinity) {
    let names = [];
    try { names = await fsp.readdir(path.join(dir, key)); } catch { return []; }
    return names.map(minuteOfFile).filter((t) => t !== null && t + 60_000 > from && t <= to).sort((a, b) => a - b);
  }
  /** One car key's indexed minutes between two times (UTC ms), oldest first: [t, data] (read one at a time). */
  async function* minutesIn(key, from, to) {
    for (const t of await minuteTimes(key, from, to)) {
      const data = await readMinute(key, minuteKey(t));
      if (data) yield [t, data];
    }
  }
  /** The top of a minute (logs, spans, id counts per log, trust, act), or null. */
  const headOf = (key, t) => fmt.readHead(path.join(dir, key, `${minuteKey(t)}.json.gz`));

  /** The DBC message of an id ("can0:2E5") on a bus map, or null when the DBC does not know it there. */
  function messageName(idKey, busOf = DEFAULT_BUSES) {
    const [iface, hexId] = String(idKey).split(':');
    const msg = dbc().messages.get(parseInt(hexId, 16));
    const bus = busOf[iface] || null;
    return msg && (!bus || !msg.bus || msg.bus === bus) ? msg.name : null;
  }

  /**
   * Every CAN id of one car key between two times, from the frame counts the
   * index keeps per log and minute (nothing decoded again): [{ key, bus, id,
   * name (the DBC's, else null), frames, hz (while its log ran), firstSeen,
   * lastSeen (UTC ms, to the log's span within the minute), minutes }], by id.
   */
  async function idSummary(key, from, to, { stop = null } = {}) {
    const out = new Map();
    const buses = new Map(); // log name -> its bus map (from its sidecar)
    const busesOf = async (name) => {
      if (!buses.has(name)) {
        let side = {};
        if (parseName(name)) { try { side = JSON.parse(await fsp.readFile(path.join(canDir, key, `${name}.json`), 'utf8')) || {}; } catch { /* none */ } }
        buses.set(name, busMapOf(side));
      }
      return buses.get(name);
    };
    for (const t of await minuteTimes(key, from, to)) {
      if (stop?.()) break;
      // only the top of each file (the logs' id counts and spans), not its signals
      const data = await headOf(key, t);
      if (!data) continue;
      for (const [name, part] of Object.entries(data.logs || {})) {
        if (!part?.ids) continue;
        const [a, b] = Array.isArray(part.span) ? part.span : [0, 59_999];
        const ms = Math.max(1000, b - a);
        const busOf = await busesOf(name);
        for (const [idKey, n] of Object.entries(part.ids)) {
          if (!goodId(idKey)) continue;
          let e = out.get(idKey);
          if (!e) {
            const [iface, hexId] = idKey.split(':');
            e = { key: idKey, bus: iface, id: hexId, name: messageName(idKey, busOf), frames: 0, ms: 0, firstSeen: t + a, lastSeen: t + b, minutes: new Set() };
            out.set(idKey, e);
          }
          e.frames += n;
          e.ms += ms;
          e.firstSeen = Math.min(e.firstSeen, t + a);
          e.lastSeen = Math.max(e.lastSeen, t + b);
          e.minutes.add(t);
        }
      }
    }
    return [...out.values()].map((e) => ({ key: e.key, bus: e.bus, id: e.id, name: e.name, frames: e.frames, hz: Math.round((e.frames / e.ms) * 10000) / 10, firstSeen: e.firstSeen, lastSeen: e.lastSeen, minutes: e.minutes.size }))
      .sort((x, y) => parseInt(x.id, 16) - parseInt(y.id, 16) || x.bus.localeCompare(y.bus));
  }

  /** Every id of one UTC day (yyyyMMdd), from its minutes' tops: { id: [first minute, last minute, minutes] }. */
  async function idDay(key, day, times) {
    const file = path.join(dir, key, dayFile(day));
    try {
      const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (saved?.v === ID_DAY && saved.ids) return saved.ids;
    } catch { /* made now */ }
    const gen = dayGen.get(`${key}/${day}`) || 0;
    const ids = {};
    for (const t of times) {
      const head = await headOf(key, t);
      // a minute from before the per-log counts: its own id counts (the whole file)
      const here = fmt.idsOfHead(head) || (await readMinute(key, minuteKey(t)))?.ids;
      if (!here) continue;
      for (const k of Object.keys(here)) {
        if (!goodId(k)) continue;
        const e = ids[k];
        if (!e) ids[k] = [t, t, 1];
        else { e[0] = Math.min(e[0], t); e[1] = Math.max(e[1], t); e[2]++; }
      }
    }
    // not kept when a minute of the day changed meanwhile (it is made again next time)
    if ((dayGen.get(`${key}/${day}`) || 0) === gen) await writeAtomic(file, JSON.stringify({ v: ID_DAY, ids })).catch(() => {});
    return ids;
  }

  /**
   * CAN ids of one car key first seen in the minute of `since` or later (as after a software
   * update), from per-day summaries (complete, however long the history): { appeared: [{ id,
   * at (its first minute), lastSeen, seenMinutes }], appearedCount, idCount, totalMinutes, complete }.
   */
  async function newIds(key, since, { limit = 1000, stop = null } = {}) {
    const byDay = new Map();
    for (const t of await minuteTimes(key)) {
      const d = minuteKey(t).slice(0, 8);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(t);
    }
    const all = new Map(); // id -> [first, last, minutes]
    for (const [day, times] of byDay) {
      if (stop?.()) throw Object.assign(new Error('The search was stopped.'), { status: 409 });
      for (const [k, [a, b, n]] of Object.entries(await idDay(key, day, times))) {
        const e = all.get(k);
        if (!e) all.set(k, [a, b, n]);
        else { e[0] = Math.min(e[0], a); e[1] = Math.max(e[1], b); e[2] += n; }
      }
    }
    const from = Math.floor(since / 60_000) * 60_000;
    const appeared = [...all].filter(([, e]) => e[0] >= from).map(([id, e]) => ({ id, at: e[0], lastSeen: e[1] + 59_999, seenMinutes: e[2] }))
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    let totalMinutes = 0;
    for (const times of byDay.values()) totalMinutes += times.length;
    return { appeared: appeared.slice(0, limit), appearedCount: appeared.length, idCount: all.size, totalMinutes, scannedMinutes: totalMinutes, complete: true };
  }

  // ---- repacking: minutes written before the column layout (canFormat.js) are written again in
  // it, in the background once nothing is waiting to be indexed: about half the room on disk.
  // The content stays the same; only the layout (and `act` on top) changes. Done per car key, once.
  const packFile = path.join(dir, 'packed.json');
  async function encOf(file) {
    let fh;
    try {
      fh = await fsp.open(file, 'r');
      const buf = Buffer.alloc(512);
      const { bytesRead } = await fh.read(buf, 0, 512, 0);
      const head = zlib.gunzipSync(buf.subarray(0, bytesRead), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8', 0, 200);
      return /"enc":"(\w+)"/.exec(head)?.[1] || null;
    } catch { return undefined; } finally { await fh?.close().catch(() => {}); }
  }
  async function repack({ shouldStop = () => false } = {}) {
    let packed = {};
    try { packed = JSON.parse(await fsp.readFile(packFile, 'utf8')) || {}; } catch { /* none yet */ }
    let keys = [];
    try { keys = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return 0; }
    let n = 0;
    for (const key of keys) {
      if (packed[key] === fmt.ENC) continue;
      let names = [];
      try { names = await fsp.readdir(path.join(dir, key)); } catch { continue; }
      let finished = true;
      for (const name of names.sort().reverse()) {
        const isMinute = MINUTE_FILE.test(name);
        const rawMinute = RAW_FILE.exec(name)?.[1];
        if (!isMinute && !rawMinute) continue;
        if (shouldStop()) { finished = false; break; }
        while (!idle() && !shouldStop()) await new Promise((r) => setTimeout(r, 2000));
        const file = path.join(dir, key, name);
        if ((await encOf(file)) !== null) continue; // packed already (or unreadable)
        await withLock(key, async () => {
          if ((await encOf(file)) !== null) return;
          if (isMinute) {
            const minute = name.slice(0, 13);
            const data = await readMinute(key, minute);
            if (!data) return;
            const { minute: m, trust, logs, signals, ids } = data;
            // (a minute from before the per-log records keeps having none: indexing it again relies on that)
            await writeAtomic(file, await fmt.packMinute({ minute: m ?? minute, trust, logs, signals: signals || {}, ids: ids || {} }));
            changed(key, minute);
          } else {
            const data = await rawNow(key, rawMinute);
            if (!data) return;
            await writeAtomic(file, await fmt.packRaw(data));
            rawCache.delete(`${key}/${rawMinute}`);
          }
          n++;
        });
        await new Promise((r) => setImmediate(r));
      }
      if (finished) {
        packed[key] = fmt.ENC;
        await fsp.mkdir(dir, { recursive: true });
        await writeAtomic(packFile, JSON.stringify(packed));
      } else break;
    }
    if (n) log?.info?.(`CAN index: ${n} older minute file(s) repacked`);
    return n;
  }

  return { kick, trustOf, indexLog, series, clipData, raw, signals, forget, removeLog, minutesIn, minuteTimes, idSummary, newIds, repack, messageName, generation: () => generation, status: () => ({ ...status }), pendingLogs };
}

module.exports = { createCanIndex, minuteKey, busMapOf, FORMAT, RAW_PER_SEC, CLIP_STEP_MS, IFACE };
