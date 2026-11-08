'use strict';

// CAN to footage sync: where on the CAN logs' clock a clip's first frame is.
//
// A clip's file name gives its start on the car's clock to the second; the
// CAN Bridge stamps frames with its own clock. The two can be seconds apart,
// so the Viewer's CAN values would lag or lead the picture. The front
// camera's per-frame record (speed, pedals, blinkers, brake, steering; see
// server/telemetry.js) says what the car did at each frame, and the CAN logs
// say the same things, so the two can be lined up:
//
//   1. coarse: speed (and steering) cross-correlated over ±10 s;
//   2. fine: edges, the moments brake, blinkers and accelerator change, matched
//      one to one (each frame's state changed between it and the frame before,
//      so an edge is placed between the two: many edges give sub-frame
//      precision);
//   3. per drive: the clips of one recording follow each other, so their
//      edges together fit one offset and drift (linear) for the whole drive.
//
// The result for a clip: canTime = nameTime + offsetMs + clipTime * rate,
// with how it was found: 'edges-drive', 'edges', 'speed', or 'clock' (no
// data: the file name's time as it is). `matches` is the number of edges
// used, `spreadMs` how far they scatter around the fit (one edge's error).
//
// Cached per car key, in <DATA>/can-index/<key>/sync.json, forgotten for the
// drives a newly indexed log covers.

const fsp = require('fs/promises');
const path = require('path');

const SIG = {
  speed: 'DI_vehicleSpeed', // kph
  brake: 'IBST_driverBrakeApply', // 1 not applied, 2 driver applying
  left: 'VCFRONT_turnSignalLeftStatus', // 0 off, 1 on
  right: 'VCFRONT_turnSignalRightStatus',
  accel: 'DI_accelPedalPos', // %
  steer: 'SteeringAngle129' // degrees
};
const NAMES = Object.values(SIG);
const SEARCH_MS = 10_000; // how far the clocks may be apart
const GRID_MS = 5; // the CAN signals sampled this finely for the correlation
const TEL_STEP = 50; // the footage's signals every 50 ms
const ACCEL_STEPS = [5, 20]; // accelerator edges: crossing these (%)
const FORMAT = 1;

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (n) => Math.round(n * 10) / 10;

// ---- the footage's per-frame records (the same fields as web/statDash.js decodeRecord)
function decodeRecord(buf) {
  const out = { v: 0, acc: 0, steer: 0, left: false, right: false, brake: false };
  let p = 0;
  const vint = () => {
    let n = 0;
    let mul = 1;
    for (;;) {
      if (p >= buf.length) throw new RangeError('short');
      const b = buf[p++];
      n += (b & 0x7f) * mul;
      if (!(b & 0x80)) return n;
      mul *= 128;
      if (mul > 2 ** 63) throw new RangeError('long');
    }
  };
  try {
    while (p < buf.length) {
      const tag = vint();
      const field = Math.floor(tag / 8);
      const type = tag % 8;
      let value;
      if (type === 0) value = vint();
      else if (type === 5) { if (p + 4 > buf.length) return null; value = buf.readFloatLE(p); p += 4; } else if (type === 1) { if (p + 8 > buf.length) return null; value = buf.readDoubleLE(p); p += 8; } else if (type === 2) { p += vint(); continue; } else return null;
      if (field === 4) out.v = value * 3.6;
      else if (field === 5) out.acc = value;
      else if (field === 6) out.steer = value;
      else if (field === 7) out.left = Boolean(value);
      else if (field === 8) out.right = Boolean(value);
      else if (field === 9) out.brake = Boolean(value);
    }
  } catch { return null; }
  return out;
}

/** A clip's frames from its telemetry JSON (GET /api/telemetry's body): [{ t, v (kph), acc (%), steer, left, right, brake }]. */
function telemetryFrames(body) {
  let json = body;
  try { if (typeof body === 'string' || Buffer.isBuffer(body)) json = JSON.parse(body); } catch { return []; }
  const out = [];
  for (const item of json?.frames || []) {
    if (!Array.isArray(item)) continue;
    const r = decodeRecord(Buffer.from(String(item[1] || ''), 'base64'));
    const t = Number(item[0]);
    if (r && Number.isFinite(t)) out.push({ t, ...r });
  }
  out.sort((a, b) => a.t - b.t);
  // (the accelerator is 0-1 on some cars, 0-100 on others)
  let max = 0;
  for (const f of out) if (f.acc > max) max = f.acc;
  if (max <= 1.01) for (const f of out) f.acc *= 100;
  return out;
}

/** How long a clip runs: its last frame plus one frame. */
function clipDuration(frames) {
  if (!frames.length) return 0;
  const dts = [];
  for (let i = 1; i < frames.length; i++) dts.push(frames[i].t - frames[i - 1].t);
  return frames[frames.length - 1].t + (dts.length ? median(dts) : 0);
}

// ---- the CAN side
function canChannels(series = {}) {
  const num = (name) => (series[name] || []).filter((p) => Number.isFinite(p[1]));
  const bool = (name, on, off) => (series[name] || []).filter((p) => p[1] === on || p[1] === off).map((p) => [p[0], p[1] === on]);
  return {
    speed: num(SIG.speed), steer: num(SIG.steer), accel: num(SIG.accel),
    brake: bool(SIG.brake, 2, 1), left: bool(SIG.left, 1, 0), right: bool(SIG.right, 1, 0)
  };
}

// ---- edges: { type, t }
const BOOLS = ['brake', 'left', 'right'];
const MAX_FRAME_GAP = 200; // an edge across dropped frames is too vague

function telEdges(frames) {
  const out = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (b.t - a.t > MAX_FRAME_GAP) continue;
    for (const k of BOOLS) if (a[k] !== b[k]) out.push({ type: `${k}${b[k] ? '+' : '-'}`, t: (a.t + b.t) / 2 });
    for (const th of ACCEL_STEPS) {
      if ((a.acc < th) !== (b.acc < th)) out.push({ type: `acc${th}${b.acc >= th ? '+' : '-'}`, t: a.t + ((th - a.acc) / (b.acc - a.acc)) * (b.t - a.t) });
    }
  }
  return out;
}

function canEdges(ch) {
  const out = [];
  for (const k of BOOLS) {
    const pts = ch[k];
    for (let i = 1; i < pts.length; i++) if (pts[i][1] !== pts[i - 1][1]) out.push({ type: `${k}${pts[i][1] ? '+' : '-'}`, t: pts[i][0] });
  }
  const acc = ch.accel;
  for (let i = 1; i < acc.length; i++) {
    const [ta, a] = acc[i - 1];
    const [tb, b] = acc[i];
    for (const th of ACCEL_STEPS) {
      if ((a < th) === (b < th)) continue;
      // points come at most every 50 ms while the pedal moves: in between, the crossing is interpolated
      const t = tb - ta <= 100 ? ta + ((th - a) / (b - a)) * (tb - ta) : tb;
      out.push({ type: `acc${th}${b >= th ? '+' : '-'}`, t });
    }
  }
  return out;
}

const byType = (edges) => {
  const m = new Map();
  for (const e of edges) (m.get(e.type) || m.set(e.type, []).get(e.type)).push(e.t);
  for (const list of m.values()) list.sort((a, b) => a - b);
  return m;
};

/** The densest offset of CAN edges against the footage's (same kind) in [center - range, center + range]. */
function edgeMode(tel, can, start, center, range) {
  const cm = byType(can);
  const d = [];
  for (const e of tel) {
    const list = cm.get(e.type);
    if (!list) continue;
    const lo = start + e.t + center - range;
    const hi = start + e.t + center + range;
    for (const t of list) if (t >= lo && t <= hi) d.push(t - start - e.t);
  }
  if (!d.length) return null;
  d.sort((a, b) => a - b);
  const W = 40;
  const wins = [];
  let j = 0;
  for (let i = 0; i < d.length; i++) {
    while (j < d.length && d[j] <= d[i] + W) j++;
    wins.push({ n: j - i, mid: (d[i] + d[j - 1]) / 2, i, j });
  }
  let best = wins[0];
  for (const w of wins) if (w.n > best.n || (w.n === best.n && Math.abs(w.mid - center) < Math.abs(best.mid - center))) best = w;
  let second = 0;
  for (const w of wins) if (Math.abs(w.mid - best.mid) > 150 && w.n > second) second = w.n;
  return { offsetMs: median(d.slice(best.i, best.j)), count: best.n, second };
}

/** Each footage edge with the nearest CAN edge of its kind within `win` of where `predict` puts it: [{ t, y }]. */
function matchEdges(tel, can, predict, win) {
  const cm = byType(can);
  const out = [];
  for (const e of tel) {
    const list = cm.get(e.type);
    if (!list) continue;
    const want = predict(e.t);
    let lo = 0;
    let hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < want) lo = mid + 1; else hi = mid; }
    let best = null;
    for (const k of [lo - 1, lo]) if (k >= 0 && k < list.length && Math.abs(list[k] - want) <= win && (best === null || Math.abs(list[k] - want) < Math.abs(best - want))) best = list[k];
    if (best !== null) out.push({ t: e.t, y: best });
  }
  return out;
}

/**
 * A robust fit of z = a + b·x (b = 0 unless `slope` and the points span two
 * minutes): outliers dropped until what is left sits within 3 sigma (at
 * least `floor` ms). { a, b, n, spreadMs, keep } or null.
 */
function robustFit(points, { slope = false, floor = 15 } = {}) {
  if (!points.length) return null;
  let pts = points;
  let a = median(pts.map((p) => p.z));
  let b = 0;
  // (at first wide enough for a drift of 200 ppm over the points' span)
  let thr = slope ? Math.max(60, 2e-4 * (Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)))) : 60;
  for (let iter = 0; iter < 8; iter++) {
    const keep = pts.filter((p) => Math.abs(p.z - (a + b * p.x)) <= thr);
    if (!keep.length) return null;
    const xs = keep.map((p) => p.x);
    const span = Math.max(...xs) - Math.min(...xs);
    if (slope && keep.length >= 10 && span >= 120_000) {
      const mx = xs.reduce((s, x) => s + x, 0) / keep.length;
      const mz = keep.reduce((s, p) => s + p.z, 0) / keep.length;
      let sxx = 0;
      let sxz = 0;
      for (const p of keep) { sxx += (p.x - mx) ** 2; sxz += (p.x - mx) * (p.z - mz); }
      b = Math.max(-1e-3, Math.min(1e-3, sxz / sxx)); // clocks drift far less than 1000 ppm
      a = mz - b * mx;
    } else {
      b = 0;
      a = keep.reduce((s, p) => s + p.z, 0) / keep.length;
    }
    const res = keep.map((p) => p.z - (a + b * p.x));
    const sigma = 1.4826 * median(res.map((r) => Math.abs(r - median(res))));
    const next = Math.max(floor, 3 * sigma);
    const same = keep.length === pts.length && Math.abs(next - thr) < 0.01;
    pts = keep;
    thr = next;
    if (same) break;
  }
  const keep = pts.filter((p) => Math.abs(p.z - (a + b * p.x)) <= thr);
  const res = keep.map((p) => p.z - (a + b * p.x));
  const mean = res.reduce((s, r) => s + r, 0) / (res.length || 1);
  const spreadMs = res.length > 1 ? Math.sqrt(res.reduce((s, r) => s + (r - mean) ** 2, 0) / (res.length - 1)) : null;
  return { a, b, n: keep.length, spreadMs, keep };
}

// ---- the coarse step: speed (and steering) correlated
function canGrid(pts, from, n, step) {
  const out = new Float64Array(n).fill(NaN);
  if (!pts.length) return out;
  const end = pts[pts.length - 1][0] + 1500; // points come at least once a second
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = from + i * step;
    while (k + 1 < pts.length && pts[k + 1][0] <= t) k++;
    if (t < pts[0][0] || t > end) continue;
    // a value that moves comes as points 50 ms apart: in between it is interpolated, else it holds
    const b = pts[k + 1];
    out[i] = b && b[0] - pts[k][0] <= 120 ? pts[k][1] + ((t - pts[k][0]) / (b[0] - pts[k][0])) * (b[1] - pts[k][1]) : pts[k][1];
  }
  return out;
}
function telGrid(frames, key) {
  const t0 = frames[0].t;
  const n = Math.floor((frames[frames.length - 1].t - t0) / TEL_STEP) + 1;
  const ts = new Float64Array(n);
  const vs = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * TEL_STEP;
    while (k + 1 < frames.length && frames[k + 1].t <= t) k++;
    const a = frames[k];
    const b = frames[Math.min(k + 1, frames.length - 1)];
    ts[i] = t;
    vs[i] = b.t > a.t && b.t - a.t <= MAX_FRAME_GAP ? a[key] + ((t - a.t) / (b.t - a.t)) * (b[key] - a[key]) : a[key];
  }
  return { ts, vs };
}
const deriv = (arr, h) => {
  const out = new Float64Array(arr.length).fill(NaN);
  for (let i = h; i + h < arr.length; i++) out[i] = arr[i + h] - arr[i - h];
  return out;
};
function pearson(tv, cv, ts, base, lag) {
  let n = 0; let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
  for (let i = 0; i < ts.length; i++) {
    const x = tv[i];
    const j = Math.round((ts[i] + lag - base) / GRID_MS);
    const y = j >= 0 && j < cv.length ? cv[j] : NaN;
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  if (n < 200) return null; // ten seconds at least
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  if (vx <= 1e-9 || vy <= 1e-9) return null;
  return (sxy - (sx * sy) / n) / Math.sqrt(vx * vy);
}

/** How far apart two speed curves are at a lag: mean absolute difference (kph), or null. */
function meanGap(tv, cv, ts, base, lag) {
  let n = 0;
  let sum = 0;
  let mean = 0;
  for (let i = 0; i < tv.length; i++) {
    const j = Math.round((ts[i] + lag - base) / GRID_MS);
    const y = j >= 0 && j < cv.length ? cv[j] : NaN;
    if (Number.isNaN(tv[i]) || Number.isNaN(y)) continue;
    n++;
    sum += Math.abs(tv[i] - y);
    mean += tv[i];
  }
  return n >= 200 ? { gap: sum / n, mean: mean / n } : null;
}

/**
 * The offset that lines up the footage's speed with the CAN speed: { offsetMs, score } or null.
 * A match must also mean something: the two speeds about equal there (not just rising together),
 * and clearly better than at offsets far from it (two ramps correlate at every lag).
 */
function speedOffset(frames, ch, start, { center = 0, range = SEARCH_MS } = {}) {
  if (frames.length < 50 || ch.speed.length < 10) return null;
  const sp = telGrid(frames, 'v');
  let lo = Infinity; let hi = -Infinity;
  for (const v of sp.vs) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo < 3) return null; // a steady speed says nothing about time
  const st = telGrid(frames, 'steer');
  const base = start + sp.ts[0] + center - range - 1000;
  const n = Math.ceil((sp.ts[sp.ts.length - 1] - sp.ts[0] + 2 * range + 2000) / GRID_MS);
  const cs = canGrid(ch.speed, base, n, GRID_MS);
  const cst = ch.steer.length >= 10 ? canGrid(ch.steer, base, n, GRID_MS) : null;
  const tsAbs = sp.ts.map((t) => t + start);
  const tdv = deriv(sp.vs, 3);
  const cdv = deriv(cs, (3 * TEL_STEP) / GRID_MS);
  const score = (lag, fine) => {
    const rs = pearson(sp.vs, cs, tsAbs, base, lag);
    if (rs === null) return null;
    const parts = [rs];
    if (fine) { const rd = pearson(tdv, cdv, tsAbs, base, lag); if (rd !== null) parts.push(rd); }
    if (cst) { const rt = pearson(st.vs, cst, tsAbs, base, lag); if (rt !== null) parts.push(Math.abs(rt)); } // (either sign)
    return { rs, s: parts.reduce((a, b) => a + b, 0) / parts.length };
  };
  let best = null;
  const coarse = [];
  for (let lag = center - range; lag <= center + range; lag += 100) {
    const s = score(lag, false);
    if (s) coarse.push({ lag, s: s.s });
    if (s && (!best || s.s > best.s)) best = { lag, ...s };
  }
  if (!best) return null;
  // distinct: the best offset beats every offset 2 s or more away by a clear margin
  const far = coarse.filter((x) => Math.abs(x.lag - best.lag) >= 2000);
  if (far.length && best.s - Math.max(...far.map((x) => x.s)) < 0.03) return null;
  const fine = [];
  for (let lag = best.lag - 250; lag <= best.lag + 250; lag += GRID_MS) fine.push({ lag, sc: score(lag, true) });
  let k = -1;
  for (let i = 0; i < fine.length; i++) if (fine[i].sc && (k < 0 || fine[i].sc.s > fine[k].sc.s)) k = i;
  if (k < 0 || fine[k].sc.rs < 0.85) return null;
  // the same speed there, not only the same shape (within 3 km/h or 8 %)
  const agree = meanGap(sp.vs, cs, tsAbs, base, fine[k].lag);
  if (!agree || agree.gap > Math.max(3, 0.08 * agree.mean)) return null;
  let off = fine[k].lag;
  // the peak between grid steps (a parabola through the best three)
  if (k > 0 && k + 1 < fine.length && fine[k - 1].sc && fine[k + 1].sc) {
    const [y0, y1, y2] = [fine[k - 1].sc.s, fine[k].sc.s, fine[k + 1].sc.s];
    const den = y0 - 2 * y1 + y2;
    if (den < 0) off += (GRID_MS * (y0 - y2)) / (2 * den);
  }
  return { offsetMs: off, score: fine[k].sc.s };
}

/**
 * One clip on its own: { result: { offsetMs, method, matches, spreadMs }, dur,
 * tel (edges), can (edges), hasCan }. `start` is the file name's time (UTC ms),
 * `series` the CAN signals around the clip (canIndex.series).
 */
function estimateClip({ frames, series, start }) {
  const ch = canChannels(series);
  const hasCan = NAMES.some((n) => series?.[n]?.length);
  const dur = clipDuration(frames || []);
  const tel = frames?.length ? telEdges(frames) : [];
  const can = canEdges(ch);
  const clock = { offsetMs: 0, method: 'clock', matches: 0, spreadMs: null };
  if (!frames?.length || !hasCan) return { result: clock, dur, tel, can, hasCan };
  const sp = speedOffset(frames, ch, start);
  const mode = edgeMode(tel, can, start, sp ? sp.offsetMs : 0, sp ? 600 : SEARCH_MS);
  let fit = null;
  // without speed to go by, only a clear winner (blinkers repeat every ~0.7 s)
  if (mode && (sp || (mode.count >= 3 && mode.second <= 0.6 * mode.count))) {
    const pairs = matchEdges(tel, can, (t) => start + t + mode.offsetMs, 100);
    fit = robustFit(pairs.map((p) => ({ x: p.t, z: p.y - start - p.t })));
  }
  let result = clock;
  if (fit && fit.n >= 3) result = { offsetMs: r1(fit.a), method: 'edges', matches: fit.n, spreadMs: fit.spreadMs === null ? null : r1(fit.spreadMs) };
  else if (sp) result = { offsetMs: r1(sp.offsetMs), method: 'speed', matches: 0, spreadMs: null };
  return { result, dur, tel, can, hasCan };
}

/**
 * A drive: its clips in order ([{ start, est }], est from estimateClip). Clips
 * that follow on (the next one starts where this one ends, give or take the
 * name's second) share one time line; their edges fit one offset and drift.
 * Returns each clip's result (with `rate` for the drift).
 */
function solveDrive(clips) {
  const out = clips.map((c) => ({ ...c.est.result }));
  // chains of clips that follow on
  const segs = [];
  let seg = null;
  clips.forEach((c, k) => {
    const prev = clips[k - 1];
    if (seg && prev.est.dur > 0 && c.est.dur > 0 && Math.abs(c.start - prev.start - prev.est.dur) <= 1500) {
      seg.push({ k, C: seg[seg.length - 1].C + prev.est.dur });
    } else {
      seg = [{ k, C: 0 }];
      segs.push(seg);
    }
  });
  for (const s of segs) {
    const live = s.filter(({ k }) => clips[k].est.hasCan && clips[k].est.tel.length);
    if (!live.length) continue;
    const collect = (predictOf, winOf, skip) => {
      const pts = [];
      for (const { k, C } of live) {
        if (skip?.has(k)) continue;
        const pr = predictOf(k, C);
        if (pr === null) continue;
        for (const p of matchEdges(clips[k].est.tel, clips[k].est.can, (t) => pr(t), winOf(k))) pts.push({ x: C + p.t, z: p.y - (C + p.t), k });
      }
      return pts;
    };
    // first from each clip's own guess, then again from the drive's fit
    const pass1 = collect((k, C) => {
      const r = clips[k].est.result;
      if (r.method === 'clock') return null;
      return (t) => clips[k].start + t + r.offsetMs;
    }, (k) => (clips[k].est.result.method === 'edges' ? 60 : 250));
    let fit = robustFit(pass1, { slope: true });
    if (!fit || fit.n < 6) continue;
    const outside = new Set();
    for (let round = 0; round < 2; round++) {
      const f = fit;
      const pts = collect((k, C) => (t) => f.a + (1 + f.b) * (C + t), () => 80, outside);
      const next = robustFit(pts, { slope: true });
      if (!next || next.n < 6) break;
      fit = next;
      // a clip that does not sit on the line (a gap between clips): on its own
      let moved = false;
      for (const { k } of live) {
        if (outside.has(k)) continue;
        const mine = pts.filter((p) => p.k === k);
        if (mine.length < 3) continue;
        const res = median(mine.map((p) => p.z - (fit.a + fit.b * p.x)));
        if (Math.abs(res) > Math.max(25, 3 * (fit.spreadMs || 0))) { outside.add(k); moved = true; }
      }
      if (!moved) break;
    }
    const used = new Set(fit.keep.map((p) => p.k));
    for (const { k, C } of s) {
      if (outside.has(k)) continue;
      out[k] = {
        offsetMs: r1(fit.a + (1 + fit.b) * C - clips[k].start),
        method: 'edges-drive', matches: fit.n, spreadMs: fit.spreadMs === null ? null : r1(fit.spreadMs),
        rate: 1 + fit.b, driftPpm: r1(fit.b * 1e6), clips: used.size
      };
    }
  }
  return out;
}

// ---- the service: cache, lazy requests, the background
function createCanSync({ dir, series, telemetry, vehicles, inventory, keysFor, startOf, idle = () => true, log = null, pauseMs = 200 }) {
  // key -> the promise of { v, clips: { front: entry } }: kept as a promise, so
  // two requests that load the same key at once share one object
  const stores = new Map();
  const fileOf = (key) => path.join(dir, key, 'sync.json');
  function load(key) {
    if (!stores.has(key)) stores.set(key, readStore(key));
    return stores.get(key);
  }
  async function readStore(key) {
    let data = null;
    try { data = JSON.parse(await fsp.readFile(fileOf(key), 'utf8')); } catch { /* none yet */ }
    if (!data || data.v !== FORMAT || typeof data.clips !== 'object') data = { v: FORMAT, clips: {} };
    return data;
  }
  let writing = Promise.resolve();
  const save = (key) => (writing = writing.then(async () => {
    const data = await stores.get(key);
    if (!data) return;
    await fsp.mkdir(path.join(dir, key), { recursive: true });
    const file = fileOf(key);
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data));
    await fsp.rename(tmp, file);
  }).catch((err) => log?.warn?.(`CAN sync: ${err.message}`)));

  const frontOf = (real) => real.replace(/-(front|back|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$/i, '-front.mp4');
  const stampOf = async (real) => { const st = await fsp.stat(real); return `${st.size}/${Math.round(st.mtimeMs)}`; };
  const inside = (rel) => rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  /**
   * A clip's path in its vehicle's folder ('TeslaCam/...'), or null. The clip
   * comes in as a real path (symlinks resolved), the folder as set up, which
   * can be a symlink or sit under one: so the real folder is tried as well.
   */
  async function relOf(v, real) {
    const root = vehicles.rootOf(v);
    if (!root) return null;
    let rel = path.relative(root, real);
    if (!inside(rel)) {
      let realRoot = null;
      try { realRoot = await fsp.realpath(root); } catch { /* not there */ }
      rel = realRoot ? path.relative(realRoot, real) : null;
    }
    return inside(rel) ? rel.split(path.sep).join('/') : null;
  }
  /** Where a clip's entry is kept: its path under the vehicle's folder as set up, as solveRecording keeps it. */
  const entryOf = (v, rel, real) => { const root = vehicles.rootOf(v); return rel && root ? path.join(root, ...rel.split('/')) : real; };

  /** The recording (inventory) a clip is in, with its front clips in order. */
  function recordingOf(v, rel) {
    const rec = inventory.get(v.id)?.recordings?.find((r) => r.clipRels?.includes(rel));
    return rec ? { id: rec.id, fronts: frontsOf(v, rec) } : null;
  }
  function frontsOf(v, rec) {
    const files = inventory.get(v.id)?.files;
    const root = vehicles.rootOf(v);
    if (!root) return [];
    return (rec.clipRels || []).filter((r) => (files?.get(r)?.camera || (/-front\.mp4$/i.test(r) ? 'front' : null)) === 'front')
      .map((rel) => ({ rel, real: path.join(root, ...rel.split('/')), start: startOf(v, path.posix.basename(rel)) }))
      .filter((c) => Number.isFinite(c.start)).sort((a, b) => a.start - b.start);
  }

  // failed: the telemetry could not be read (not the same as a clip with none),
  // so what comes of it is not kept and is worked out again next time
  async function estimate(keys, real, start) {
    let frames = [];
    let failed = false;
    try { frames = telemetryFrames(await telemetry(real)); } catch { frames = []; failed = true; }
    const dur = clipDuration(frames) || 60_000;
    const s = frames.length ? await series(keys, start - SEARCH_MS - 2000, start + dur + SEARCH_MS + 2000, NAMES) : {};
    return { ...estimateClip({ frames, series: s, start }), failed };
  }

  const storeKey = (keys) => [...keys].sort()[0];
  const keysTag = (keys) => [...keys].sort().join(',');

  /** A clip's sync (lazily: worked out on its own now, for its whole drive in the background). */
  async function forClip({ v, keys, real, start }) {
    if (!keys?.length) return null;
    const front = frontOf(real);
    let stamp;
    try { stamp = await stampOf(front); } catch { return null; }
    const key = storeKey(keys);
    const data = await load(key);
    const rel = await relOf(v, front);
    const at = entryOf(v, rel, front);
    const had = data.clips[at];
    // the start counts too: it moves when the car's time zone is changed
    if (had && had.stamp === stamp && had.keys === keysTag(keys) && had.start === start) {
      if (!had.drive && rel) queue(v, rel);
      return had.sync;
    }
    const est = await estimate(keys, front, start);
    if (est.failed) return est.result;
    const rec = rel ? recordingOf(v, rel) : null;
    data.clips[at] = { stamp, keys: keysTag(keys), start, end: start + (est.dur || 60_000), rec: rec?.id || null, drive: !est.hasCan, sync: est.result };
    save(key);
    if (est.hasCan && rel) queue(v, rel);
    return est.result;
  }

  // the background: one drive at a time, only while the server has nothing else to do
  const todo = new Map(); // `${vid}|${recId}` -> { vid, rel }
  let running = null;
  const status = { running: false, drives: 0, pending: 0, lastError: null };
  function queue(v, rel) {
    const rec = inventory.get(v.id)?.recordings?.find((r) => r.clipRels?.includes(rel));
    if (!rec) return;
    const id = `${v.id}|${rec.id}`;
    if (!todo.has(id)) todo.set(id, { vid: v.id, rel });
    status.pending = todo.size;
    run();
  }
  function run() {
    if (running) return running;
    running = (async () => {
      status.running = true;
      while (todo.size) {
        const [id, job] = todo.entries().next().value;
        todo.delete(id);
        status.pending = todo.size;
        try { await solveRecording(job.vid, job.rel); status.drives++; } catch (err) { status.lastError = err.message; log?.warn?.(`CAN sync: ${err.message}`); }
      }
    })().finally(() => {
      running = null;
      status.running = false;
      // a drive queued while this run was ending: run() saw it still running
      if (todo.size) run();
    });
    return running;
  }
  const wait = async () => { while (!idle()) await new Promise((r) => setTimeout(r, 2000)); };

  async function solveRecording(vid, rel) {
    const v = vehicles.list().find((x) => x.id === vid);
    if (!v) return;
    const keys = await keysFor(vid);
    if (!keys.length) return;
    const rec = recordingOf(v, rel);
    if (!rec?.fronts.length) return;
    const clips = [];
    for (const c of rec.fronts) {
      await wait();
      let stamp;
      try { stamp = await stampOf(c.real); } catch { continue; }
      clips.push({ ...c, stamp, est: await estimate(keys, c.real, c.start) });
      if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    }
    const results = solveDrive(clips);
    const key = storeKey(keys);
    const data = await load(key);
    clips.forEach((c, k) => {
      if (c.est.failed) return; // its telemetry could not be read: tried again when it is viewed
      data.clips[c.real] = { stamp: c.stamp, keys: keysTag(keys), start: c.start, end: c.start + (c.est.dur || 60_000), rec: rec.id, drive: true, sync: results[k] };
    });
    save(key);
    const best = results.find((r) => r.method === 'edges-drive');
    if (best) log?.info?.(`CAN sync: ${path.posix.basename(rel)}'s drive: ${best.offsetMs} ms, ${best.matches} edges, ±${best.spreadMs} ms`);
  }

  /**
   * A log was indexed (canIndex): what was worked out for the drives it
   * covers is forgotten, and those drives are worked out again.
   */
  async function indexed(key, from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    // the cars this key is for, and the stores their entries are kept in
    // (a car with more than one key keeps them under its first: storeKey)
    const cars = [];
    const where = new Set([key]);
    for (const v of vehicles.list()) {
      const keys = await keysFor(v.id);
      if (!keys.includes(key)) continue;
      cars.push(v);
      where.add(storeKey(keys));
    }
    for (const k of where) await forget(k, from, to);
    for (const v of cars) {
      for (const rec of inventory.get(v.id)?.recordings || []) {
        const fronts = frontsOf(v, rec);
        if (!fronts.length || fronts[0].start > to + 60_000 || fronts[fronts.length - 1].start + 60_000 < from) continue;
        queue(v, fronts[0].rel);
      }
    }
  }

  /** In one store: what was worked out for the drives that overlap from..to is forgotten. */
  async function forget(key, from, to) {
    const data = await load(key);
    const recs = new Set();
    for (const e of Object.values(data.clips)) if (e.end >= from - 60_000 && e.start <= to + 60_000) recs.add(e.rec || e);
    let changed = false;
    for (const [real, e] of Object.entries(data.clips)) {
      if (recs.has(e) || (e.rec && recs.has(e.rec))) { delete data.clips[real]; changed = true; }
    }
    if (changed) save(key);
  }

  /** Once the background and the writes are done (for tests). */
  async function settled() {
    while (running) await running;
    await writing;
  }

  return { forClip, indexed, status: () => ({ ...status }), settled };
}

module.exports = { createCanSync, estimateClip, solveDrive, telemetryFrames, decodeRecord, canChannels, telEdges, canEdges, robustFit, speedOffset, clipDuration, NAMES, SIG };
