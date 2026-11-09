'use strict';

// Sentry USB's drive data: the drive-data.json the Pi writes to the archive
// share root (the folder that holds RecentClips/) after each archive cycle
// that found new drives. Where a car's share has one, the Drives tab is built
// from it, the way Sentry Studio's Drives tab is (and Sentry USB's own Drives
// page): the same grouping, plus Autopilot / FSD shares, the route and the
// drive tags. Without one, or while it cannot be read, Drives groups the
// car's own clips (server/drives.js).
//
// The file (Sentry USB: crates/drives/src/types.rs StoreData, json_compat.rs):
//   { "processedFiles": [...], "routes": [Route...], "driveTags": { key: [tag...] },
//     "telemetrySamples": [...], "chargeTags": {...}, "chargeCosts": {...} }
// Route: { file, date, points: [[lat, lng]...], gearStates, autopilotStates
//   (Go []uint8: a base64 string, or an array of numbers), speeds (m/s per
//   point), accelPositions, rawParkCount, rawFrameCount,
//   gearRuns: [{ gear, frames }] (raw frames), apRuns, flagRuns, source, ... }.
// Older files (and Studio's notes) use PascalCase names; both are read.
//
// It can be over a gigabyte, so it is never read whole: a small streaming
// tokenizer walks it a chunk at a time and parses one route at a time, and
// each route is boiled down at once to a few numbers per driving segment
// (distance, top speed, Autopilot distance and time, its ends and a handful
// of route points). That is what is kept, in memory and on disk under the
// data folder (drive-data/<car>.json, with the file's size and modification
// time), so the file is read again only when it changes. Reads run one at a
// time in the background, chunk by chunk with a pause between, slower while
// the server is busy; the API never waits for one. rsync may replace the file
// in place, so a file changed in the last seconds is left until it settles,
// and a read that fails (cut short, not JSON) keeps the last good result.
// Nothing is ever written to the share.
//
// Grouping (crates/drives/src/grouper.rs group_clips): routes in event
// folders (SavedClips, SentryClips) and in dot folders are left out; the rest
// sorted by the clip time in the file name; a clip starting more than the gap
// (5 minutes) after the one before starts a new drive; then Park of 2 seconds
// or more (by the gear runs, in raw frames) ends a drive inside a clip
// (legacy files without gear runs: a clip that is mostly Park). Autopilot
// shares are by distance, as Sentry USB and Studio show them.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const FILE = 'drive-data.json';
const CLIP_MS = 60_000;
const PARK_GAP_MS = 2000;
const DEFAULT_GAP_S = 5 * 60;
const SEG_POINTS = 8; // route points kept per driving segment (about one a clip's 8 s)
const DRIVE_POINTS = 96; // route points per drive in the API
const MAX_ROUTE_BYTES = 32 * 1024 * 1024; // a route bigger than this is skipped
const MAX_TAG_BYTES = 16 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const CACHE_VERSION = 1;
const TS = /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/;

// ---------------------------------------------------------------------------
// the streaming tokenizer

const S_START = 0; const S_KEY_OR_END = 1; const S_KEY = 2; const S_COLON = 3; const S_VALUE = 4;
const S_AFTER = 5; const S_ARR = 6; const S_ARR_NEXT = 7; const S_VAL = 8; const S_DONE = 9;
const ws = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
const BOM = [0xef, 0xbb, 0xbf];
const ROUTE_KEYS = new Set(['routes', 'Routes']);
const TAG_KEYS = new Set(['driveTags', 'DriveTags']);

/**
 * Walks a StoreData JSON text pushed in chunks (Buffers). Each element of
 * its routes array is parsed alone and handed to onRoute(obj); driveTags to
 * onTags(obj); every other top-level value (processedFiles, the telemetry,
 * ...) is stepped over without being kept. Throws on text that is not a
 * StoreData object; end() throws when the text stopped part way.
 */
class StoreDataScanner {
  constructor({ onRoute = () => {}, onTags = () => {}, maxRoute = MAX_ROUTE_BYTES, maxTags = MAX_TAG_BYTES } = {}) {
    Object.assign(this, { onRoute, onTags, maxRoute, maxTags });
    this.st = S_START;
    this.at = 0; // bytes seen
    this.key = null;
    this.keyBytes = [];
    this.esc = false;
    this.target = null; // 'route' | 'tags' | null (skip)
    this.parts = null;
    this.capLen = 0;
    this.over = false;
    this.depth = 0;
    this.inStr = false;
    this.prim = false;
    this.routes = 0;
    this.skipped = 0;
    this.keys = [];
    this.bom = 0;
  }

  begin(target) {
    this.target = target;
    this.parts = target ? [] : null;
    this.capLen = 0;
    this.over = false;
    this.depth = 0;
    this.inStr = false;
    this.esc = false;
    this.prim = false;
    this.st = S_VAL;
  }

  finish(buf, from, end) {
    const target = this.target;
    const after = target === 'route' ? S_ARR_NEXT : S_AFTER;
    const tail = target && !this.over ? buf.subarray(from, end) : null;
    if (tail && this.capLen + tail.length > (target === 'route' ? this.maxRoute : this.maxTags)) this.over = true;
    if (target && !this.over) {
      const text = (this.parts.length ? Buffer.concat([...this.parts, tail]) : tail).toString('utf8');
      this.parts = null;
      let obj;
      try { obj = JSON.parse(text); } catch (err) { throw new Error(`not JSON at byte ${this.at + end}: ${err.message}`); }
      if (target === 'route') { this.routes++; this.onRoute(obj); } else this.onTags(obj);
    } else if (target === 'route') this.skipped++;
    this.parts = null;
    this.target = null;
    this.st = after;
  }

  push(buf) {
    const n = buf.length;
    let from = 0; // where this chunk's part of a captured value starts
    for (let i = 0; i < n; i++) {
      const c = buf[i];
      switch (this.st) {
        case S_VAL: {
          if (this.inStr) {
            if (this.esc) this.esc = false;
            else if (c === 0x5c) this.esc = true;
            else if (c === 0x22) {
              this.inStr = false;
              if (this.depth === 0) this.finish(buf, from, i + 1);
            }
          } else if (this.prim) {
            if (c === 0x2c || c === 0x7d || c === 0x5d || ws(c)) { this.finish(buf, from, i); i--; }
          } else if (c === 0x22) this.inStr = true;
          else if (c === 0x7b || c === 0x5b) this.depth++;
          else if (c === 0x7d || c === 0x5d) {
            this.depth--;
            if (this.depth === 0) this.finish(buf, from, i + 1);
            else if (this.depth < 0) throw new Error(`unexpected ${String.fromCharCode(c)} at byte ${this.at + i}`);
          } else if (this.depth === 0 && !ws(c)) this.prim = true;
          break;
        }
        case S_START:
          if (ws(c)) break;
          if (this.at + i === this.bom && c === BOM[this.bom]) { this.bom++; break; } // a byte order mark
          if (c !== 0x7b) throw new Error('not a JSON object');
          this.st = S_KEY_OR_END;
          break;
        case S_KEY_OR_END:
          if (ws(c)) break;
          if (c === 0x22) { this.st = S_KEY; this.keyBytes = []; this.esc = false; break; }
          if (c === 0x7d) { this.st = S_DONE; break; }
          throw new Error(`expected a key at byte ${this.at + i}`);
        case S_KEY:
          if (this.esc) { this.esc = false; this.keyBytes.push(c); } else if (c === 0x5c) { this.esc = true; this.keyBytes.push(c); } else if (c === 0x22) {
            this.key = Buffer.from(this.keyBytes).toString('utf8');
            if (this.keys.length < 32) this.keys.push(this.key);
            this.st = S_COLON;
          } else {
            this.keyBytes.push(c);
            if (this.keyBytes.length > 256) throw new Error('a key too long');
          }
          break;
        case S_COLON:
          if (ws(c)) break;
          if (c !== 0x3a) throw new Error(`expected : at byte ${this.at + i}`);
          this.st = S_VALUE;
          break;
        case S_VALUE:
          if (ws(c)) break;
          if (ROUTE_KEYS.has(this.key) && c === 0x5b) { this.st = S_ARR; break; }
          this.begin(TAG_KEYS.has(this.key) ? 'tags' : null);
          from = i;
          i--;
          break;
        case S_ARR:
          if (ws(c)) break;
          if (c === 0x5d) { this.st = S_AFTER; break; }
          this.begin('route');
          from = i;
          i--;
          break;
        case S_ARR_NEXT:
          if (ws(c)) break;
          if (c === 0x2c) { this.st = S_ARR; break; }
          if (c === 0x5d) { this.st = S_AFTER; break; }
          throw new Error(`expected , or ] at byte ${this.at + i}`);
        case S_AFTER:
          if (ws(c)) break;
          if (c === 0x2c) { this.st = S_KEY_OR_END; break; }
          if (c === 0x7d) { this.st = S_DONE; break; }
          throw new Error(`expected , or } at byte ${this.at + i}`);
        case S_DONE:
          if (!ws(c) && c !== 0) throw new Error(`text after the end at byte ${this.at + i}`);
          break;
        default:
          throw new Error('scanner state');
      }
    }
    // a captured value goes on in the next chunk: keep its part of this one (a copy: the chunk is not kept)
    if (this.st === S_VAL && this.target && !this.over) {
      const part = buf.subarray(from);
      this.capLen += part.length;
      const max = this.target === 'route' ? this.maxRoute : this.maxTags;
      if (this.capLen > max) { this.over = true; this.parts = null; } else this.parts.push(Buffer.from(part));
    }
    this.at += n;
  }

  end() {
    if (this.st !== S_DONE) throw new Error(`the file ends part way (at byte ${this.at})`);
    return { routes: this.routes, skipped: this.skipped, keys: this.keys };
  }
}

/**
 * Read a drive-data.json a chunk at a time. pause(bytesSoFar) is awaited
 * between chunks (the idle-friendly part); aborted() stops it.
 */
async function readStoreData(file, { onRoute, onTags, pause = () => new Promise((r) => setImmediate(r)), aborted = () => false, chunk = CHUNK } = {}) {
  const scanner = new StoreDataScanner({ onRoute, onTags });
  const fh = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    for (;;) {
      if (aborted()) throw new Error('stopped');
      const buf = Buffer.allocUnsafe(chunk);
      const { bytesRead } = await fh.read(buf, 0, chunk, null);
      if (!bytesRead) break;
      scanner.push(bytesRead === chunk ? buf : buf.subarray(0, bytesRead));
      await pause(scanner.at);
    }
  } finally {
    await fh.close().catch(() => {});
  }
  return scanner.end();
}

// ---------------------------------------------------------------------------
// one route, boiled down

const pick = (o, a, b) => (o[a] !== undefined && o[a] !== null ? o[a] : o[b]);
/** A Go []uint8 field: base64 text, or an array of numbers. */
function bytesOf(v) {
  if (Array.isArray(v)) return v.map((x) => Number(x) || 0);
  if (typeof v === 'string' && v.length) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(v)) return [];
    return [...Buffer.from(v, 'base64')];
  }
  return [];
}
const nums = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'number' ? x : Number(x))) : []);
const nullIsland = (lat, lng) => Math.abs(lat) < 1 && Math.abs(lng) < 1;
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const r1 = (x) => Math.round(x * 10) / 10;

function haversine(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** The clip time in a route's file name: { key, t (wall seconds, as if UTC) } or null. */
function clipTime(file) {
  const name = String(file).split('/').pop();
  const m = TS.exec(name);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  return Number.isFinite(t) ? { key: m[0], t } : null;
}

/** A parallel array of the points, when it has (about) one value per point: Studio allows 20% either way. */
const aligned = (arr, n) => (arr.length && n && arr.length / n >= 0.8 && arr.length / n <= 1.2 ? arr : null);
const at = (arr, i) => arr[Math.min(i, arr.length - 1)];

/** gearRuns as [{ gear, frames }] (also { Gear, Frames } and the older { Gear, StartFrame, EndFrame }). */
function runsOf(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const gear = Number(pick(r, 'gear', 'Gear')) || 0;
    let frames = Number(pick(r, 'frames', 'Frames'));
    if (!Number.isFinite(frames)) frames = Number(pick(r, 'endFrame', 'EndFrame')) - Number(pick(r, 'startFrame', 'StartFrame'));
    if (Number.isFinite(frames) && frames > 0) out.push({ gear, frames: Math.round(frames) });
  }
  return out;
}

/**
 * A clip's raw-frame segments: [{ sf, ef, parked }], driving runs merged,
 * Park of 2 s or more a segment of its own (the clip as a minute, as Studio
 * splits); null when nothing splits it.
 */
function parkPlan(runs) {
  const total = runs.reduce((n, r) => n + r.frames, 0);
  if (!total) return null;
  const merged = [];
  let f = 0;
  for (const r of runs) {
    const parked = r.gear === 0 && r.frames * CLIP_MS >= PARK_GAP_MS * total;
    const last = merged[merged.length - 1];
    if (last && !last.parked && !parked) last.ef = f + r.frames;
    else merged.push({ sf: f, ef: f + r.frames, parked });
    f += r.frames;
  }
  return merged.some((s) => s.parked) ? { total, segs: merged } : null;
}

/** A segment's numbers over points [si, ei) of the clip. */
function segStats(c, si, ei) {
  const { pts, speeds, ap, dt, sei } = c;
  let d = 0; let top = 0; let moving = 0;
  let fsdM = 0; let asM = 0; let taccM = 0; let assistM = 0; let fsdS = 0; let asS = 0; let taccS = 0;
  let a = null; let z = null;
  for (let i = si; i < ei; i++) {
    const p = pts[i];
    if (!p || nullIsland(p[0], p[1])) continue;
    if (!a) a = p;
    z = p;
  }
  for (let i = si + 1; i < ei; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    if (!p || !q || nullIsland(p[0], p[1]) || nullIsland(q[0], q[1])) continue;
    const m = haversine(p[0], p[1], q[0], q[1]);
    if (!sei && dt > 0 && m / dt > 70) continue; // a GPS jump
    d += m;
    let v = null;
    if (sei) { const s = at(speeds, i); if (s >= 0 && s < 100) v = s; } else if (dt > 0 && m / dt < 70) v = m / dt;
    if (v !== null) {
      if (v > top) top = v;
      if (v > 0.5) moving += dt;
    }
    if (ap) {
      const s = at(ap, i);
      if (s !== 0) {
        assistM += m;
        if (s === 1) { fsdM += m; fsdS += dt; } else if (s === 2) { asM += m; asS += dt; } else if (s === 3) { taccM += m; taccS += dt; }
      }
    }
  }
  // a few points of the route, evenly spaced
  const span = [];
  for (let i = si; i < ei; i++) { const p = pts[i]; if (p && !nullIsland(p[0], p[1])) span.push(p); }
  const keep = [];
  if (span.length) {
    const want = Math.min(SEG_POINTS, span.length);
    for (let k = 0; k < want; k++) {
      const p = span[want === 1 ? 0 : Math.round((k * (span.length - 1)) / (want - 1))];
      keep.push([r5(p[0]), r5(p[1])]);
    }
  }
  const out = { d: Math.round(d * 10) / 10, v: r1(top), mv: r1(moving), a: a ? [r5(a[0]), r5(a[1])] : null, z: z ? [r5(z[0]), r5(z[1])] : null, p: keep };
  if (ap) {
    out.ap = [fsdM, asM, taccM, assistM, fsdS, asS, taccS].map(r1);
    out.ap0 = at(ap, si);
  }
  return out;
}

/** Whether a route's path is one Drives leaves out: an event folder, a dot folder or dot file. */
function leftOut(file) {
  const parts = file.split('/').filter(Boolean);
  if (parts.some((p) => p.startsWith('.'))) return true;
  return parts.slice(0, -1).some((p) => p === 'SavedClips' || p === 'SentryClips');
}

/**
 * One route as kept: { k (clip key), t, native, runs, lp, gs, segs } where
 * segs are driving segments ({ sf, ef, tf, d, v, mv, a, z, p, ap?, ap0? })
 * and 0 for a Park gap; null for a route Drives does not use.
 */
function reduceRoute(r) {
  if (!r || typeof r !== 'object') return null;
  const file = String(pick(r, 'file', 'File') || '').replace(/\\/g, '/');
  if (!file || leftOut(file)) return null;
  const time = clipTime(file);
  if (!time) return null;
  const rawPts = Array.isArray(pick(r, 'points', 'Points')) ? pick(r, 'points', 'Points') : [];
  const pts = [];
  let objSpeeds = null;
  for (const p of rawPts) {
    if (Array.isArray(p)) pts.push([Number(p[0]), Number(p[1])]);
    else if (p && typeof p === 'object') {
      pts.push([Number(pick(p, 'lat', 'Lat')), Number(pick(p, 'lng', 'Lng'))]);
      const s = pick(p, 'speed', 'Speed');
      if (s !== undefined) (objSpeeds = objSpeeds || []).push(Number(s));
    } else pts.push(null);
  }
  for (let i = 0; i < pts.length; i++) if (pts[i] && !(Number.isFinite(pts[i][0]) && Number.isFinite(pts[i][1]))) pts[i] = null;
  const n = pts.length;
  const speeds = aligned(objSpeeds || nums(pick(r, 'speeds', 'Speeds')), n);
  const ap = aligned(bytesOf(pick(r, 'autopilotStates', 'AutopilotStates')), n);
  const gears = bytesOf(pick(r, 'gearStates', 'GearStates'));
  const runs = runsOf(pick(r, 'gearRuns', 'GearRuns'));
  const rawFrames = Number(pick(r, 'rawFrameCount', 'RawFrameCount')) || 0;
  const rawPark = Number(pick(r, 'rawParkCount', 'RawParkCount')) || 0;
  const source = pick(r, 'source', 'Source');
  const c = { pts, speeds, ap, dt: n > 1 ? CLIP_MS / 1000 / (n - 1) : 0, sei: Boolean(speeds && speeds.some((s) => s > 0)) };
  const total = runs.reduce((x, run) => x + run.frames, 0);
  const plan = runs.length ? parkPlan(runs) : null;
  const segs = [];
  if (!plan) {
    segs.push({ sf: 0, ef: total || 1, tf: total || 1, ...segStats(c, 0, n) });
  } else {
    for (const s of plan.segs) {
      if (s.parked) { segs.push(0); continue; }
      let si = Math.round((s.sf / plan.total) * n);
      let ei = Math.round((s.ef / plan.total) * n);
      if (si >= n) si = Math.max(0, n - 1);
      if (ei > n) ei = n;
      if (ei <= si) ei = si + 1;
      if (ei > n) continue; // no points at all
      segs.push({ sf: s.sf, ef: s.ef, tf: plan.total, ...segStats(c, si, ei) });
    }
  }
  let parkCount = 0;
  for (const g of gears) if (g === 0) parkCount++;
  return {
    k: time.key,
    t: time.t,
    native: (source === undefined || source === null || source === 'sei') && !file.includes('-front-bridge.mp4'),
    runs: runs.length > 0,
    gs: gears.length > 0,
    lp: rawFrames > 0 ? rawPark / rawFrames > 0.5 : gears.length > 0 && parkCount > gears.length / 2,
    segs
  };
}

/** Clips oldest first, one per clip time, each with its real span (ms): the next native clip's start when within a minute. */
function finishClips(list) {
  const byKey = new Map();
  for (const c of list) if (!byKey.has(c.k)) byKey.set(c.k, c);
  const clips = [...byKey.values()].sort((a, b) => a.t - b.t);
  let prev = null;
  for (const c of clips) {
    c.span = CLIP_MS;
    if (!c.native) continue;
    if (prev) {
      const gap = (c.t - prev.t) * 1000;
      if (gap > 0 && gap <= CLIP_MS) prev.span = gap;
    }
    prev = c;
  }
  return clips;
}

// ---------------------------------------------------------------------------
// drives

/** ms into a clip of a raw frame, rounded as Sentry USB does (frame_offset_ms). */
const frameMs = (frame, total, span) => (total ? Math.floor((frame * span + Math.floor(total / 2)) / total) : 0);

/** A time group (clips within the gap) split at Park: arrays of { c, seg }. */
function splitAtPark(group) {
  const out = [];
  let cur = [];
  const cut = () => { if (cur.length) out.push(cur); cur = []; };
  if (group.some((c) => c.runs)) {
    for (const c of group) {
      for (const seg of c.segs) {
        if (seg === 0) cut();
        else cur.push({ c, seg });
      }
    }
  } else if (group.some((c) => c.gs || c.lp)) {
    for (const c of group) {
      if (c.lp) cut();
      else for (const seg of c.segs) if (seg) cur.push({ c, seg });
    }
  } else {
    for (const c of group) for (const seg of c.segs) if (seg) cur.push({ c, seg });
  }
  cut();
  return out;
}

function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const out = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

/** A drive from its parts: times (ms of wall clock), distance, top speed, Autopilot, the route. */
function buildDrive(parts) {
  const first = parts[0];
  const last = parts[parts.length - 1];
  const startMs = first.c.t * 1000 + frameMs(first.seg.sf, first.seg.tf, first.c.span);
  const endMs = last.c.t * 1000 + frameMs(last.seg.ef, last.seg.tf, last.c.span);
  let d = 0; let top = 0; let moving = 0; let hasAp = false;
  const ap = [0, 0, 0, 0, 0, 0, 0]; // fsd m, autosteer m, tacc m, assisted m, fsd s, autosteer s, tacc s
  let prevEnd = null;
  let a = null; let z = null;
  const pts = [];
  const keys = [];
  for (const { c, seg } of parts) {
    if (keys[keys.length - 1] !== c.k) keys.push(c.k);
    d += seg.d;
    moving += seg.mv;
    if (seg.v > top) top = seg.v;
    if (seg.ap) { hasAp = true; for (let i = 0; i < 7; i++) ap[i] += seg.ap[i]; }
    // the stretch between one clip's last point and the next one's first (Sentry USB counts it)
    if (prevEnd && seg.a) {
      const gap = haversine(prevEnd[0], prevEnd[1], seg.a[0], seg.a[1]);
      d += gap;
      if (seg.ap0 === 1) ap[0] += gap; else if (seg.ap0 === 2) ap[1] += gap; else if (seg.ap0 === 3) ap[2] += gap;
      if (seg.ap0) ap[3] += gap;
    }
    if (seg.z || seg.a) prevEnd = seg.z || seg.a;
    if (!a && seg.a) a = seg.a;
    if (seg.z) z = seg.z;
    for (const p of seg.p) pts.push(p);
  }
  const pct = (m) => (d > 0 ? r1((m / d) * 100) : 0);
  return {
    startMs, endMs, keys, routes: keys.length,
    distance: Math.round(d), top: r1(top), moving: Math.round(moving),
    from: a, to: z,
    autopilot: hasAp ? {
      percent: pct(ap[3]), fsd: pct(ap[0]), autosteer: pct(ap[1]), tacc: pct(ap[2]),
      fsdSeconds: Math.round(ap[4]), autosteerSeconds: Math.round(ap[5]), taccSeconds: Math.round(ap[6]),
      fsdMetres: Math.round(ap[0]), assistedMetres: Math.round(ap[3])
    } : null,
    route: downsample(pts, DRIVE_POINTS),
    // Sentry USB's drive tag key: the start, "YYYY-MM-DDTHH:MM:SS.mmm"
    tagKey: new Date(startMs).toISOString().slice(0, 23)
  };
}

/** Clips (oldest first) into drives, newest first. */
function groupDrives(clips, { gapS = DEFAULT_GAP_S } = {}) {
  const out = [];
  let group = [];
  let prevT = null;
  const flush = () => { for (const parts of splitAtPark(group)) out.push(buildDrive(parts)); group = []; };
  for (const c of clips) {
    if (prevT !== null && c.t - prevT > gapS) flush();
    group.push(c);
    prevT = c.t;
  }
  flush();
  return out.reverse();
}

/** The tags of a drive: by Sentry USB's key, else the same second, else Studio's other keys (its clip name, its day). */
function tagsOf(tags, drive) {
  if (!tags) return [];
  const sec = drive.tagKey.slice(0, 19);
  const clip = drive.keys[0];
  const hit = tags.exact.get(drive.tagKey) || tags.second.get(sec) || tags.exact.get(clip) || tags.exact.get(sec);
  return hit || [];
}

/** driveTags as lookups (a bounded number of keys and tags). */
function tagIndex(obj) {
  const exact = new Map();
  const second = new Map();
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { exact, second, count: 0 };
  let count = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (count >= 50000) break;
    if (!Array.isArray(v)) continue;
    const list = [...new Set(v.filter((x) => typeof x === 'string').map((x) => x.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60)).filter(Boolean))].slice(0, 20);
    if (!list.length) continue;
    const key = String(k).slice(0, 64);
    exact.set(key, list);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(key)) {
      const s = key.slice(0, 19);
      if (!second.has(s)) second.set(s, list);
    }
    count++;
  }
  return { exact, second, count };
}

/** "YYYY-MM-DD HH:MM:SS" and the clip key of wall ms. */
const wall = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19).replace('T', ' ');
const keyOf = (ms) => wall(ms).replace(' ', '_').replace(/:/g, '-');

/**
 * A drive for the API, in the shape server/drives.js describe() gives, plus
 * source, autopilot, tags, route and footage. clipOf(key) gives the car's
 * clip in the scan (drives.clipsOf) or null; statsOf(clip) the speed index's
 * numbers (for hard braking and swerves); label(pos) names a position.
 */
function describeDrive(drive, { tags = null, clipOf = () => null, statsOf = () => null, label = () => null, hasCan = null } = {}) {
  const found = [];
  for (const k of drive.keys) { const c = clipOf(k); if (c) found.push(c); }
  let brakes = 0; let swerves = 0; let read = 0;
  for (const c of found) {
    const s = statsOf(c);
    if (!s) continue;
    read++;
    brakes += s.b;
    swerves += s.t;
  }
  // the Viewer: the clip the drive starts in (or the first one there is), at its second
  let open = null;
  const startKey = drive.keys[0];
  const startClip = clipOf(startKey);
  if (startClip) {
    const second = Math.max(0, Math.min(59, Math.round(drive.startMs / 1000 - startClip.t)));
    open = { recording: startClip.rec?.id || null, day: startClip.rec?.day || startClip.day, clip: startClip.key, second };
  } else if (found.length) {
    open = { recording: found[0].rec?.id || null, day: found[0].rec?.day || found[0].day, clip: found[0].key, second: 0 };
  }
  const end = (pos) => (pos ? { lat: pos[0], lon: pos[1], ...label({ lat: pos[0], lon: pos[1] }) } : null);
  const recs = new Set(found.map((c) => c.rec?.id).filter(Boolean));
  const lastKey = drive.keys[drive.keys.length - 1];
  return {
    id: keyOf(drive.startMs),
    date: wall(drive.startMs).slice(0, 10),
    start: wall(drive.startMs),
    end: wall(drive.endMs),
    seconds: Math.max(0, Math.round((drive.endMs - drive.startMs) / 1000)),
    clips: drive.routes,
    recordings: recs.size,
    footage: found.length,
    indexed: read,
    distance: drive.distance,
    moving: drive.moving,
    top: drive.top,
    hardBrakes: read ? brakes : null,
    swerves: read ? swerves : null,
    from: end(drive.from),
    to: end(drive.to),
    can: hasCan ? Boolean(hasCan({ clipRels: [`RecentClips/${startKey}-front.mp4`, `RecentClips/${lastKey}-front.mp4`], startKey })) : false,
    autopilot: drive.autopilot,
    tags: tagsOf(tags, drive),
    route: drive.route,
    open
  };
}

// ---------------------------------------------------------------------------
// the reader: per car, in the background, cached on disk

/**
 * vehicles: { list(), get(id), rootOf(v), studioRoot(v) }; dir: where the
 * cache goes (data folder); idle(): false while the server is busy (reads go
 * slower then). stableMs: how long a changed file is left to settle.
 */
function createDriveData({ dir, vehicles, log = null, idle = () => true, now = () => Date.now(), stableMs = 15_000, checkMs = 30_000, pollMs = 5 * 60_000, chunk = CHUNK, pauseMs = 2, busyPauseMs = 150 } = {}) {
  const cars = new Map(); // vid -> state
  const queue = [];
  let running = false;
  let stopped = false;
  let timer = null;
  const settleTimers = new Map();

  const stateOf = (vid) => {
    let s = cars.get(vid);
    if (!s) {
      s = { result: null, loaded: false, loading: null, reading: false, present: null, failed: null, lastCheck: 0, drives: new Map(), progress: null };
      cars.set(vid, s);
    }
    return s;
  };
  const cacheFile = (vid) => path.join(dir, `${encodeURIComponent(vid)}.json`);

  async function loadCache(vid) {
    const s = stateOf(vid);
    if (s.loaded) return;
    if (!s.loading) {
      s.loading = (async () => {
        try {
          const raw = JSON.parse(await fsp.readFile(cacheFile(vid), 'utf8'));
          if (raw?.v === CACHE_VERSION && Array.isArray(raw.clips) && !s.result) s.result = { ...raw, tags: tagIndex(raw.tags) };
        } catch { /* none yet */ }
        s.loaded = true;
      })();
    }
    await s.loading;
  }

  async function saveCache(vid, result, rawTags) {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${cacheFile(vid)}.tmp`;
    const { tags, ...rest } = result;
    await fsp.writeFile(tmp, JSON.stringify({ ...rest, tags: rawTags || {} }));
    await fsp.rename(tmp, cacheFile(vid));
  }

  /** The car's drive-data.json: { file, size, mtimeMs } or null. Only a plain file inside the car's folder. */
  async function locate(v) {
    const roots = [];
    try { const s = vehicles.studioRoot?.(v); if (s) roots.push(s); } catch { /* not reachable */ }
    const root = vehicles.rootOf(v);
    if (root) roots.push(root);
    let realRoot = null;
    try { realRoot = await fsp.realpath(root); } catch { return null; }
    for (const r of [...new Set(roots)]) {
      const file = path.join(r, FILE);
      try {
        const st = await fsp.lstat(file);
        if (!st.isFile()) continue; // not a symlink, not a folder
        const rel = path.relative(realRoot, await fsp.realpath(file));
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue; // outside the car's folder
        return { file, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
      } catch { /* not there */ }
    }
    return null;
  }

  const stampOf = (f) => `${f.size}/${f.mtimeMs}`;

  /** Look at the file now and then: read it (in the background) when it changed and settled. */
  async function check(vid, { force = false } = {}) {
    if (stopped) return;
    const v = vehicles.get(vid);
    if (!v) { cars.delete(vid); return; }
    const s = stateOf(vid);
    if (!force && now() - s.lastCheck < checkMs) return;
    s.lastCheck = now();
    await loadCache(vid);
    const f = await locate(v);
    s.present = f;
    if (!f) return;
    const stamp = stampOf(f);
    if (s.result?.stamp === stamp || s.failed?.stamp === stamp || s.reading || queue.includes(vid)) return;
    const age = now() - f.mtimeMs;
    if (age < stableMs) {
      // still being written, perhaps (rsync may write it in place): look again once it settled
      if (!settleTimers.has(vid)) {
        const t = setTimeout(() => { settleTimers.delete(vid); check(vid, { force: true }).catch(() => {}); }, Math.max(1000, stableMs - age + 500));
        t.unref?.();
        settleTimers.set(vid, t);
      }
      return;
    }
    queue.push(vid);
    pump();
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length && !stopped) await read(queue.shift());
    } finally {
      running = false;
    }
  }

  async function read(vid) {
    const v = vehicles.get(vid);
    const s = stateOf(vid);
    if (!v) return;
    const f = await locate(v);
    s.present = f;
    if (!f) return;
    const stamp = stampOf(f);
    if (s.result?.stamp === stamp) return;
    s.reading = true;
    s.progress = { bytes: 0, size: f.size };
    const started = now();
    const list = [];
    let rawTags = null;
    let seenRoutes = 0;
    try {
      const out = await readStoreData(f.file, {
        chunk,
        aborted: () => stopped,
        onRoute: (r) => { seenRoutes++; const c = reduceRoute(r); if (c) list.push(c); },
        onTags: (t) => { rawTags = t && typeof t === 'object' && !Array.isArray(t) ? t : null; },
        pause: async (bytes) => {
          s.progress = { bytes, size: f.size };
          const ms = idle() ? pauseMs : busyPauseMs;
          await new Promise((r) => (ms ? setTimeout(r, ms) : setImmediate(r)));
        }
      });
      // changed while it was read: read it again once it settles
      const after = await locate(v);
      if (!after || stampOf(after) !== stamp) {
        s.lastCheck = 0;
        log?.info?.(`Sentry USB drive data for ${vid} changed while it was read; reading it again later`);
        return;
      }
      const clips = finishClips(list);
      const tags = rawTags ? tagIndex(rawTags) : tagIndex(null);
      // keep only the tags (bounded) that tagIndex kept
      const keptTags = {};
      for (const [k, t] of tags.exact) keptTags[k] = t;
      const result = {
        v: CACHE_VERSION, stamp, file: path.relative(vehicles.rootOf(v), f.file).split(path.sep).join('/') || FILE,
        size: f.size, mtimeMs: f.mtimeMs, readAt: now(), routes: out.routes, used: clips.length, clips
      };
      s.result = { ...result, tags };
      s.failed = null;
      s.drives = new Map();
      await saveCache(vid, result, keptTags).catch((err) => log?.warn?.(`Drive data cache: ${err.message}`));
      log?.info?.(`Sentry USB drive data for ${vid}: ${out.routes} routes, ${clips.length} used, read in ${Math.round((now() - started) / 1000)} s`);
    } catch (err) {
      s.failed = { stamp, error: err.message, at: now() };
      log?.warn?.(`Sentry USB drive data for ${vid} (${seenRoutes} routes in): ${err.message}; keeping the last good read`);
    } finally {
      s.reading = false;
      s.progress = null;
    }
  }

  return {
    check,
    /**
     * What the API uses, without I/O: { usable, reading, meta } where
     * usable says the drives come from the file (it is there and was read).
     */
    view(vid) {
      const s = cars.get(vid);
      if (!s) return { usable: false, reading: false, meta: null, loaded: false };
      const r = s.result;
      const usable = Boolean(r && s.present && r.used > 0);
      const meta = s.present || r ? {
        file: r?.file || FILE,
        updatedAt: s.present ? s.present.mtimeMs : r?.mtimeMs ?? null,
        readOf: r ? r.mtimeMs : null,
        readAt: r?.readAt ?? null,
        routes: r?.routes ?? null,
        reading: s.reading || queue.includes(vid),
        progress: s.progress ? Math.min(99, Math.round((s.progress.bytes / Math.max(1, s.progress.size)) * 100)) : null,
        error: s.failed?.error || null
      } : null;
      return { usable, reading: Boolean(meta?.reading), meta, loaded: s.loaded };
    },
    /** The car's drives from the file (newest first) for a gap, kept per gap until the file changes. */
    drives(vid, gapS = DEFAULT_GAP_S) {
      const s = cars.get(vid);
      if (!s?.result) return [];
      let list = s.drives.get(gapS);
      if (!list) {
        list = groupDrives(s.result.clips, { gapS });
        if (s.drives.size > 6) s.drives.clear();
        s.drives.set(gapS, list);
      }
      return list;
    },
    tags(vid) { return cars.get(vid)?.result?.tags || null; },
    forget(vid) { cars.delete(vid); fsp.rm(cacheFile(vid), { force: true }).catch(() => {}); },
    start() {
      if (timer) return;
      timer = setInterval(() => { for (const v of vehicles.list()) check(v.id).catch(() => {}); }, pollMs);
      timer.unref?.();
      for (const v of vehicles.list()) check(v.id, { force: true }).catch(() => {});
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      for (const t of settleTimers.values()) clearTimeout(t);
    },
    /** For tests: wait until nothing is queued or reading. */
    async settled() {
      for (;;) {
        if (!running && !queue.length) return;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  };
}

module.exports = {
  StoreDataScanner, readStoreData, reduceRoute, finishClips, groupDrives, splitAtPark, buildDrive, describeDrive,
  tagIndex, tagsOf, bytesOf, parkPlan, createDriveData, FILE, DEFAULT_GAP_S
};
