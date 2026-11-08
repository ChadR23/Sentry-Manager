'use strict';

// The CAN index: each uploaded CAN Bridge log is read once in the background
// and decoded (canDbc.js), so the Viewer only fetches what one clip needs,
// already in signals. For every car (vehicleKey) and UTC minute:
//
//   <DATA>/can-index/<vehicleKey>/<yyyyMMddTHHmm>.json.gz
//     { minute, signals: { name: [[ms since the minute, value], …] },
//       ids: { "can0:2E5": frames, … } }       (unknown ids are counted too)
//   <DATA>/can-index/<vehicleKey>/signals.json   every signal seen, with unit,
//                                                range, value names, bus
//   <DATA>/can-index/done.json                   which logs are indexed
//
// A signal keeps a point when its value changes, at most 20 a second (the
// last value of each 50 ms wins), and once a second while it stays the same.
// The raw logs stay as they came: a better DBC later means indexing again.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { parseName } = require('./canLogs');
const { bundledDbc, decodeFrame } = require('./canDbc');

const STEP_MS = 50; // at most 20 points a second per signal
const KEEP_MS = 1000; // a point at least once a second
const LINE = /^\((\d+)\.(\d+)\)\s+(\S+)\s+([0-9A-Fa-f]{1,8})#([0-9A-Fa-f]*)\s*$/;
const DEFAULT_BUSES = { can0: 'VehicleBus', can1: 'ChassisBus' };

const minuteKey = (ms) => new Date(Math.floor(ms / 60000) * 60000).toISOString().slice(0, 16).replace(/[-:]/g, '');

function createCanIndex({ canDir, dir, log = null, idle = () => true, dbc = bundledDbc, xz = 'xz', onIndexed = null }) {
  const doneFile = path.join(dir, 'done.json');
  let done = null;
  const loadDone = async () => {
    if (done) return done;
    try { done = JSON.parse(await fsp.readFile(doneFile, 'utf8')) || {}; } catch { done = {}; }
    return done;
  };
  const saveDone = async () => {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${doneFile}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(done));
    await fsp.rename(tmp, doneFile);
  };
  const status = { running: false, current: null, indexed: 0, pending: 0, lastError: null, lastAt: null };

  async function readMinute(key, minute) {
    try { return JSON.parse(zlib.gunzipSync(await fsp.readFile(path.join(dir, key, `${minute}.json.gz`))).toString('utf8')); } catch { return null; }
  }
  async function writeMinute(key, minute, data) {
    // a minute can span two logs: merge with what is there
    const had = await readMinute(key, minute);
    if (had) {
      for (const [name, pts] of Object.entries(had.signals || {})) {
        const mine = data.signals[name];
        data.signals[name] = mine ? [...pts, ...mine].sort((a, b) => a[0] - b[0]).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0]) : pts;
      }
      for (const [id, n] of Object.entries(had.ids || {})) data.ids[id] = (data.ids[id] || 0) + n;
    }
    await fsp.mkdir(path.join(dir, key), { recursive: true });
    const file = path.join(dir, key, `${minute}.json.gz`);
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, zlib.gzipSync(JSON.stringify(data), { level: 6 }));
    await fsp.rename(tmp, file);
  }
  async function mergeSignals(key, seen) {
    const file = path.join(dir, key, 'signals.json');
    let all = {};
    try { all = JSON.parse(await fsp.readFile(file, 'utf8')) || {}; } catch { /* first */ }
    for (const [name, meta] of seen) all[name] = meta;
    await fsp.mkdir(path.join(dir, key), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(all));
  }

  /** Index one log: decode every frame, write its minutes. */
  async function indexLog(key, name) {
    const file = path.join(canDir, key, name);
    let side = {};
    try { side = JSON.parse(await fsp.readFile(`${file}.json`, 'utf8')) || {}; } catch { /* no sidecar */ }
    // which DBC bus each interface is (the sidecar's bus map, else can0/can1)
    const busOf = { ...DEFAULT_BUSES };
    const map = side.busMap || side.buses || null;
    if (map && typeof map === 'object') {
      for (const [iface, v] of Object.entries(map)) {
        const s = String(typeof v === 'object' ? v?.dbcBus || v?.name || '' : v).toLowerCase();
        if (/vehicle/.test(s)) busOf[iface] = 'VehicleBus';
        else if (/chassis/.test(s)) busOf[iface] = 'ChassisBus';
        else if (/party/.test(s)) busOf[iface] = 'PartyBus';
      }
    }
    const { messages } = dbc();
    const seen = new Map();
    let minute = null;
    let minuteStart = 0;
    let bucket = null;
    const last = new Map(); // signal -> { t, v, pt (last kept time), pending }
    const flushPending = () => {
      for (const [nm, s] of last) if (s.pending && bucket) { (bucket.signals[nm] ||= []).push([s.pending[0] - minuteStart, s.pending[1]]); s.pt = s.pending[0]; s.pending = null; }
    };
    const writes = [];
    const closeMinute = () => {
      if (!bucket) return;
      flushPending();
      writes.push([minute, bucket]);
      bucket = null;
    };
    const child = spawn(xz, ['-dc', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let frames = 0;
    let written = 0;
    let first = null;
    let lastT = null;
    for await (const line of lines) {
      const m = LINE.exec(line);
      if (!m) continue;
      const t = Number(m[1]) * 1000 + Number(`0.${m[2]}`) * 1000;
      const mk = minuteKey(t);
      if (mk !== minute) {
        if (minute) written++;
        closeMinute();
        minute = mk;
        minuteStart = Math.floor(t / 60000) * 60000;
        bucket = { minute: mk, signals: {}, ids: {} };
        for (const s of last.values()) s.pt = -Infinity; // each minute starts with every signal's value
        if (writes.length >= 2) { const [a, b] = writes.shift(); await writeMinute(key, a, b); }
      }
      frames++;
      if (first === null) first = t;
      lastT = t;
      const iface = m[3];
      const id = parseInt(m[4], 16);
      const idKey = `${iface}:${m[4].toUpperCase()}`;
      bucket.ids[idKey] = (bucket.ids[idKey] || 0) + 1;
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
    closeMinute();
    let minutes = writes.length;
    const code = await new Promise((ok) => (child.exitCode !== null ? ok(child.exitCode) : child.once('close', ok)));
    if (code !== 0) throw new Error(`xz could not read ${name}: ${stderr.trim().slice(0, 200) || `exit ${code}`}`);
    for (const [a, b] of writes) await writeMinute(key, a, b);
    await mergeSignals(key, seen);
    minutes = written + (minute ? 1 : 0);
    return { frames, minutes, from: first, to: lastT };
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
        const stamp = `${st.size}/${Math.round(st.mtimeMs)}`;
        if (d[`${key}/${name}`] !== stamp) out.push({ key, name, stamp, startedAt: n.startedAt });
      }
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  }

  let running = null;
  let again = false;
  /** Index what is new (after an upload, and at start). */
  function kick() {
    if (running) { again = true; return running; }
    running = (async () => {
      status.running = true;
      do {
        again = false;
        const todo = await pendingLogs();
        status.pending = todo.length;
        for (const job of todo) {
          while (!idle()) await new Promise((r) => setTimeout(r, 2000));
          status.current = job.name;
          try {
            const r = await indexLog(job.key, job.name);
            (await loadDone())[`${job.key}/${job.name}`] = job.stamp;
            await saveDone();
            status.indexed++;
            log?.info?.(`CAN index: ${job.name}: ${r.frames} frames, ${r.minutes} minute(s)`);
            try { onIndexed?.(job.key, r.from, r.to); } catch { /* the sync's own business */ }
          } catch (err) {
            status.lastError = `${job.name}: ${err.message}`;
            log?.warn?.(`CAN index: ${status.lastError}`);
            (await loadDone())[`${job.key}/${job.name}`] = job.stamp; // not again until the file changes
            await saveDone();
          }
          status.pending--;
        }
      } while (again);
    })().catch((err) => { status.lastError = err.message; }).finally(() => {
      running = null;
      Object.assign(status, { running: false, current: null, lastAt: Date.now() });
    });
    return running;
  }

  /** The signals of these cars between two times: { name: [[ms (UTC), value], …] } (the value before `from` too). */
  async function series(keys, from, to, names) {
    const want = names ? new Set(names) : null;
    const out = {};
    for (const key of keys) {
      // the minute before as well, for each signal's value at `from`
      for (let t = Math.floor(from / 60000) * 60000 - 60000; t <= to; t += 60000) {
        const data = await readMinute(key, minuteKey(t));
        if (!data) continue;
        for (const [name, pts] of Object.entries(data.signals || {})) {
          if (want && !want.has(name)) continue;
          const list = (out[name] ||= []);
          for (const [ms, v] of pts) list.push([t + ms, v]);
        }
      }
    }
    for (const [name, pts] of Object.entries(out)) {
      pts.sort((a, b) => a[0] - b[0]);
      // keep the last point before `from` and everything up to `to`
      let i = 0;
      while (i + 1 < pts.length && pts[i + 1][0] <= from) i++;
      out[name] = pts.slice(i).filter((p) => p[0] <= to);
      if (!out[name].length) delete out[name];
    }
    return out;
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

  return { kick, indexLog, series, signals, forget, status: () => ({ ...status }), pendingLogs };
}

module.exports = { createCanIndex, minuteKey };
