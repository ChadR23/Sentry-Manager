'use strict';

// The speed index: every front-camera clip's speed, one value a second, kept
// under /data/speeds so the viewer's speed graph for a whole day comes in one
// small request instead of reading the day's clips while you wait.
//
// It fills in the background, newest days first, one clip at a time
// (server/speedReader.js reads a few KB of each; the full telemetry read is
// the fallback). A clip is read again only when its size or time changes,
// as when it is converted. One file per vehicle and day:
//   /data/speeds/<vehicleId>/<YYYY-MM-DD>.json  { rel: [size, mtimeMs, speeds | null, summary | null] }
//
// The summary is what Find moments and the place search read (summarize):
//   { b: [second, m/s²] hardest braking: the car's own forward accelerometer in
//        a second where it is slowing, or the speed lost in one second, the larger,
//     t: [second, m/s²] hardest sideways acceleration,
//     v: [second, m/s] top speed,
//     g: [[second, lat, lon], …] where the car was, every 5 seconds,
//     k: SUMMARY_VERSION }
// Entries from before it existed (three items), or from an older summary
// (another k), are read again: every clip, however old.

const fsp = require('fs/promises');
const path = require('path');
const { readSamples } = require('./speedReader');
const { speedsOf } = require('./telemetry');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const GPS_EVERY = 5;
const BRAKE = 3.9; // m/s lost in one second (about 0.4 g)
const SWERVE = 4; // m/s² sideways (about 0.4 g)
// 2: braking from the accelerometer too (the speed, one value a second, misses most stops)
const SUMMARY_VERSION = 2;

/** Metres between two points (haversine). */
function metres(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const r2 = (n) => Math.round(n * 100) / 100;
const r5 = (n) => Math.round(n * 1e5) / 1e5;

/** A clip's summary from its seconds ({ v, lat, lon, ax, ay } or null each). */
function summarize(samples) {
  let b = null;
  let t = null;
  let v = null;
  const g = [];
  for (let s = 0; s < samples.length; s++) {
    const x = samples[s];
    if (!x) continue;
    if (x.v !== null && (!v || x.v > v[1])) v = [s, r2(x.v)];
    const n = samples[s + 1];
    if (x.v !== null && n && n.v !== null && x.v - n.v > 0 && (!b || x.v - n.v > b[1])) b = [s, r2(x.v - n.v)];
    // the accelerometer, in a second where the car is slowing (its sign does not matter then)
    const p = samples[s - 1];
    const slowing = x.v !== null && ((n && n.v !== null && n.v < x.v - 0.3) || (p && p.v !== null && x.v < p.v - 0.3));
    if (slowing && Number.isFinite(x.ax) && x.ax !== null && (!b || Math.abs(x.ax) > b[1])) b = [s, r2(Math.abs(x.ax))];
    if (x.ay !== null && (!t || Math.abs(x.ay) > t[1])) t = [s, r2(Math.abs(x.ay))];
    if (s % GPS_EVERY === 0 && x.lat !== null && x.lon !== null && (x.lat !== 0 || x.lon !== 0)
      && Math.abs(x.lat) <= 90 && Math.abs(x.lon) <= 180) g.push([s, r5(x.lat), r5(x.lon)]);
  }
  return { b, t, v, g, k: SUMMARY_VERSION };
}

function createSpeedIndex({ dir, inventory, vehicles, telemetry, log, pauseMs = 100, idle = () => true }) {
  const days = new Map(); // `${vid}/${day}` -> { rel: [size, mtimeMs, speeds] }
  const dirty = new Set();
  const ver = new Map(); // `${vid}/${day}` -> changes made here, for the place search's cache
  const touch = (key) => { dirty.add(key); ver.set(key, (ver.get(key) || 0) + 1); };
  let running = null;
  let again = false;
  let stopped = false;
  // where the running pass is, for the Footage page's "Index speeds"
  const progress_ = { running: false, done: 0, total: 0, day: null, finishedAt: null, last: 0 };

  const fileOf = (vid, day) => path.join(dir, String(vid).replace(/[^\w-]/g, '_'), `${day}.json`);

  async function load(vid, day) {
    const key = `${vid}/${day}`;
    if (days.has(key)) return days.get(key);
    let data = {};
    try {
      const parsed = JSON.parse(await fsp.readFile(fileOf(vid, day), 'utf8'));
      if (parsed && typeof parsed === 'object') data = parsed;
    } catch { /* not indexed yet */ }
    days.set(key, data);
    if (days.size > 400) days.delete(days.keys().next().value);
    return data;
  }

  let flushing = Promise.resolve();
  const flush = () => (flushing = flushing.then(writeDirty, writeDirty));
  async function writeDirty() {
    for (const key of [...dirty]) {
      dirty.delete(key);
      const [vid, day] = key.split('/');
      const data = days.get(key);
      if (!data) continue;
      const file = fileOf(vid, day);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(data));
      await fsp.rename(tmp, file);
    }
  }

  /** The front-camera clips to index, newest day first: [{ vid, day, rel, size, mtimeMs }]. */
  function fronts(vid) {
    const files = inventory.get(vid)?.files;
    if (!files) return [];
    const out = [];
    for (const f of files.values()) if (f.kind === 'clip' && f.camera === 'front' && f.size > 0 && f.day && DAY.test(f.day)) out.push({ vid, day: f.day, rel: f.rel, size: f.size, mtimeMs: Math.round(f.mtimeMs) });
    return out.sort((a, b) => (a.day === b.day ? b.rel.localeCompare(a.rel) : b.day.localeCompare(a.day)));
  }

  /** Speeds and summary for one clip: the quick read, else the dashboard's full read (speeds only). */
  async function speedsFor(real, size) {
    try {
      const samples = await readSamples(real);
      if (!samples) return [null, null];
      const speeds = samples.map((x) => (x && x.v !== null ? r2(x.v) : null));
      return [speeds, summarize(samples)];
    } catch (err) {
      try {
        const speeds = speedsOf(await telemetry.limit(() => telemetry.read(real, size)));
        return [speeds, speeds ? summarize(speeds.map((v) => ({ v, lat: null, lon: null, ax: null, ay: null }))) : null];
      } catch {
        log?.info(`Speed index: no speeds in ${path.basename(real)} (${err.message})`);
        return [null, null];
      }
    }
  }

  async function pass() {
    // what is left to read, so the log can say how far along it is
    const todo = [];
    for (const v of vehicles.list()) {
      const root = vehicles.rootOf(v);
      if (!root) continue;
      for (const c of fronts(v.id)) {
        const had = (await load(c.vid, c.day))[c.rel];
        if (!(had && had[0] === c.size && had[1] === c.mtimeMs && had.length >= 4 && (had[3] === null || had[3]?.k === SUMMARY_VERSION))) todo.push({ ...c, root });
      }
    }
    if (todo.length) log?.info(`Speed index: ${todo.length} clip(s) to read, newest days first`);
    let done = 0;
    Object.assign(progress_, { done: 0, total: todo.length, day: null });
    const started = Date.now();
    for (const c of todo) {
      if (stopped) return done;
      while (!idle() && !stopped) await new Promise((r) => setTimeout(r, 2000));
      const data = await load(c.vid, c.day);
      data[c.rel] = [c.size, c.mtimeMs, ...(await speedsFor(path.join(c.root, c.rel), c.size))];
      touch(`${c.vid}/${c.day}`);
      Object.assign(progress_, { done: done + 1, day: c.day });
      if (++done % 25 === 0) await flush();
      if (done % 250 === 0 && done < todo.length) {
        const left = Math.round(((Date.now() - started) / done) * (todo.length - done) / 60000);
        log?.info(`Speed index: ${done} of ${todo.length} clips (now on ${c.day}, about ${left} min left)`);
      }
      if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    }
    await flush();
    return done;
  }

  /** Index what is new; again after this pass if more changed meanwhile. */
  function kick() {
    if (running) { again = true; return running; }
    progress_.running = true;
    running = (async () => {
      do {
        again = false;
        try {
          const n = await pass();
          if (n) log?.info(`Speed index: done, ${n} clip(s) indexed`);
          progress_.last = n;
        } catch (err) {
          log?.warn(`Speed index: ${err.message}`);
        }
      } while (again && !stopped);
    })().finally(() => { running = null; Object.assign(progress_, { running: false, finishedAt: Date.now() }); });
    return running;
  }

  /** A day's indexed speeds for the viewer: { rel: speeds | null } (clips not indexed yet are left out). */
  async function day(vid, d) {
    if (!DAY.test(String(d || ''))) return {};
    const data = await load(vid, d);
    const out = {};
    for (const [rel, [size, mtimeMs, sp]] of Object.entries(data)) {
      const f = inventory.get(vid)?.files?.get(rel);
      if (f && f.size === size && Math.round(f.mtimeMs) === mtimeMs) out[rel] = sp;
    }
    return out;
  }

  /** A day's clip summaries: { rel: summary } (clips not indexed with one yet are left out). */
  async function summaries(vid, d) {
    if (!DAY.test(String(d || ''))) return {};
    const data = await load(vid, d);
    const out = {};
    for (const [rel, [size, mtimeMs, , sum]] of Object.entries(data)) {
      const f = inventory.get(vid)?.files?.get(rel);
      if (sum && f && f.size === size && Math.round(f.mtimeMs) === mtimeMs) out[rel] = sum;
    }
    return out;
  }

  /**
   * A day's moments: hard braking (at least 3.9 m/s lost in a second, about
   * 0.4 g), hard swerves or corners (at least 4 m/s² sideways), and the three
   * fastest clips' top speed. [{ kind, rel, second, value }], strongest first.
   */
  async function moments(vid, d) {
    const out = [];
    const fastest = [];
    for (const [rel, sum] of Object.entries(await summaries(vid, d))) {
      if (sum.b && sum.b[1] >= BRAKE) out.push({ kind: 'brake', rel, second: sum.b[0], value: sum.b[1] });
      if (sum.t && sum.t[1] >= SWERVE) out.push({ kind: 'swerve', rel, second: sum.t[0], value: sum.t[1] });
      if (sum.v && sum.v[1] > 0) fastest.push({ kind: 'speed', rel, second: sum.v[0], value: sum.v[1] });
    }
    fastest.sort((a, b) => b.value - a.value);
    return [...out.sort((a, b) => b.value - a.value), ...fastest.slice(0, 3)];
  }

  /**
   * Clips that passed within `radius` metres of a place, across every indexed
   * day of the given vehicles: [{ vid, day, rel, second, metres }], newest
   * first, at most `limit`. Day files are read without keeping them.
   */
  // The place search's cache: each day's positions packed small
  // ({ stamp, rels, at: clip i's points start at at[i], pts: [second, lat, lon]… }),
  // and each clip's box, so a search reads no file twice and skips clips far away
  const geo = new Map();
  let geoPoints = 0;
  const GEO_MAX = 3_000_000; // points kept (12 bytes each)
  function packGeo(data) {
    const rels = [];
    const at = [0];
    const box = [];
    let n = 0;
    for (const entry of Object.values(data)) n += entry?.[3]?.g?.length || 0;
    const pts = new Float32Array(n * 3);
    let k = 0;
    for (const [rel, entry] of Object.entries(data)) {
      const g = entry?.[3]?.g;
      if (!g?.length) continue;
      let a0 = Infinity; let a1 = -Infinity; let o0 = Infinity; let o1 = -Infinity;
      for (const [sec, a, o] of g) {
        pts[k++] = sec; pts[k++] = a; pts[k++] = o;
        if (a < a0) a0 = a; if (a > a1) a1 = a; if (o < o0) o0 = o; if (o > o1) o1 = o;
      }
      rels.push(rel);
      at.push(k / 3);
      box.push(a0, a1, o0, o1);
    }
    return { rels, at, box, pts };
  }
  async function geoOf(vid, d, file) {
    const key = `${vid}/${d}`;
    let st;
    try { st = await fsp.stat(file); } catch { st = null; }
    const mem = days.get(key);
    if (!st && !mem) return null;
    const stamp = `${ver.get(key) || 0}|${st ? `${st.size}/${st.mtimeMs}` : '-'}`;
    const had = geo.get(key);
    if (had && had.stamp === stamp) {
      geo.delete(key); // newest use last
      geo.set(key, had);
      return had;
    }
    let data = mem;
    if (!data) {
      try { data = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
    }
    const packed = { stamp, ...packGeo(data || {}) };
    if (had) { geo.delete(key); geoPoints -= had.pts.length / 3; }
    geo.set(key, packed);
    geoPoints += packed.pts.length / 3;
    for (const [k, v] of geo) {
      if (geoPoints <= GEO_MAX || k === key) break;
      geo.delete(k);
      geoPoints -= v.pts.length / 3;
    }
    return packed;
  }

  /**
   * Clips that passed within `radius` metres of a place, across every indexed
   * day of the given vehicles: [{ vid, day, rel, second, metres }], newest
   * first, at most `limit`.
   */
  async function near(vids, lat, lon, radius, limit = 300) {
    const hits = [];
    // a box around the place a little wider than the radius: points outside it are too far
    const dLat = (radius / 111320) * 1.05 + 1e-4;
    const dLon = (radius / (111320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)))) * 1.05 + 1e-4;
    for (const vid of vids) {
      const folder = path.dirname(fileOf(vid, '2000-01-01'));
      let names = [];
      try { names = (await fsp.readdir(folder)).filter((n) => n.endsWith('.json') && DAY.test(n.slice(0, -5))); } catch { continue; }
      for (const name of names.sort().reverse()) {
        const d = name.slice(0, -5);
        const day_ = await geoOf(vid, d, path.join(folder, name));
        if (!day_) continue;
        const { rels, at, box, pts } = day_;
        for (let i = 0; i < rels.length; i++) {
          if (box[4 * i + 1] < lat - dLat || box[4 * i] > lat + dLat || box[4 * i + 3] < lon - dLon || box[4 * i + 2] > lon + dLon) continue;
          let best = null;
          for (let j = at[i]; j < at[i + 1]; j++) {
            const a = pts[3 * j + 1];
            const o = pts[3 * j + 2];
            if (Math.abs(a - lat) > dLat || Math.abs(o - lon) > dLon) continue;
            const m = metres(lat, lon, a, o);
            if (m <= radius && (!best || m < best.metres)) best = { second: pts[3 * j], metres: Math.round(m) };
          }
          if (best) hits.push({ vid, day: d, rel: rels[i], ...best });
        }
        if (hits.length >= limit * 2) break;
      }
    }
    return hits.sort((a, b) => (a.day === b.day ? b.rel.localeCompare(a.rel) : b.day.localeCompare(a.day))).slice(0, limit);
  }

  /**
   * Read every indexed day into the place search's cache, newest first, a day
   * at a time with a pause between (after start-up, so the first search is as
   * quick as the next ones).
   */
  async function warm(vids, pause = 20) {
    for (const vid of vids) {
      const folder = path.dirname(fileOf(vid, '2000-01-01'));
      let names = [];
      try { names = (await fsp.readdir(folder)).filter((n) => n.endsWith('.json') && DAY.test(n.slice(0, -5))); } catch { continue; }
      for (const name of names.sort().reverse()) {
        if (stopped || geoPoints >= GEO_MAX) return;
        while (!idle() && !stopped) await new Promise((r) => setTimeout(r, 2000));
        await geoOf(vid, name.slice(0, -5), path.join(folder, name));
        if (pause) await new Promise((r) => setTimeout(r, pause));
      }
    }
  }

  /** How far each day is indexed: { day: { clips, indexed } } (front-camera clips). */
  async function progress(vid, list) {
    const per = {};
    for (const f of inventory.get(vid)?.files?.values() || []) {
      if (f.kind !== 'clip' || f.camera !== 'front' || !(f.size > 0) || !list.includes(f.day)) continue;
      (per[f.day] ||= { clips: 0, indexed: 0, files: [] }).clips++;
      per[f.day].files.push(f);
    }
    for (const [d, p] of Object.entries(per)) {
      const data = await load(vid, d);
      p.indexed = p.files.filter((f) => { const had = data[f.rel]; return had && had[0] === f.size && had[1] === Math.round(f.mtimeMs) && had.length >= 4; }).length;
      delete p.files;
    }
    return per;
  }

  /** Index one clip now (the viewer asked for it before the background got there). */
  async function clip(vid, rel, real, size, mtimeMs) {
    const f = inventory.get(vid)?.files?.get(rel);
    const [sp, sum] = await speedsFor(real, size);
    if (f && f.day && DAY.test(f.day) && f.camera === 'front') {
      const data = await load(vid, f.day);
      data[rel] = [size, Math.round(mtimeMs), sp, sum];
      touch(`${vid}/${f.day}`);
      if (!running) flush().catch(() => {});
    }
    return sp;
  }

  return { kick, day, summaries, moments, near, warm, clip, progress, status: () => ({ ...progress_ }), flush, stop() { stopped = true; } };
}

module.exports = { createSpeedIndex, summarize };
