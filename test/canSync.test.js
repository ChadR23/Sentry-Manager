'use strict';

// CAN to footage sync (server/canSync.js): synthetic drives where the true
// offset between the CAN clock and the clips' names is known.

const test = require('node:test');
const assert = require('node:assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { estimateClip, solveDrive, telemetryFrames, createCanSync, NAMES } = require('../server/canSync');

// a seeded random, so a failure can be repeated
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// ---- protobuf records as the car writes them (fields as in web/statDash.js decodeRecord)
function record({ v, acc, steer, left, right, brake }) {
  const parts = [];
  const f32 = (field, x) => { const b = Buffer.alloc(5); b[0] = (field << 3) | 5; b.writeFloatLE(x, 1); parts.push(b); };
  const vi = (field, x) => { if (x) parts.push(Buffer.from([(field << 3), 1])); };
  f32(4, v / 3.6);
  if (acc) f32(5, acc / 100); // this car: 0-1
  f32(6, steer);
  vi(7, left); vi(8, right); vi(9, brake);
  return Buffer.concat(parts).toString('base64');
}

/**
 * A drive, as the car did it, on a common (car) time line in ms: speed,
 * steering, accelerator, brake and blinkers. Returns state(tMs).
 */
function makeDrive(seed, lengthMs, { edges = true } = {}) {
  const rand = rng(seed);
  const events = []; // [start, end, kind]
  if (edges) {
    for (let t = 2000; t < lengthMs; t += 4000 + rand() * 6000) events.push([t, t + 600 + rand() * 2500, rand() < 0.4 ? 'brake' : rand() < 0.5 ? 'left' : 'right']);
  }
  const knots = [];
  for (let t = -20000; t <= lengthMs + 20000; t += 3000) knots.push(20 + rand() * 60);
  const smooth = (t) => {
    const x = (t + 20000) / 3000;
    const i = Math.max(0, Math.min(knots.length - 2, Math.floor(x)));
    const f = x - i;
    const w = (1 - Math.cos(Math.PI * f)) / 2;
    return knots[i] * (1 - w) + knots[i + 1] * w;
  };
  return (t) => {
    let brake = false;
    let left = false;
    let right = false;
    for (const [a, b, k] of events) {
      if (t < a || t >= b) continue;
      if (k === 'brake') brake = true;
      // a blinker's lamp: on 360 ms, off 330 ms
      if (k === 'left' || k === 'right') { const on = (t - a) % 690 < 360; if (k === 'left') left = on; else right = on; }
    }
    const v = smooth(t);
    const acc = brake ? 0 : Math.max(0, Math.min(100, (smooth(t + 1500) - v) * 3 + 8 * Math.sin(t / 2300) + 6));
    return { v, acc, steer: 30 * Math.sin(t / 3100) + 10 * Math.sin(t / 900), brake, left, right };
  }
}

/** The CAN log of that drive: canTime = carTime + offset(carTime), sampled as the index keeps it. */
function canSeries(state, fromCar, toCar, toCan, rand) {
  const out = Object.fromEntries(NAMES.map((n) => [n, []]));
  const push = (name, tCan, v) => {
    const pts = out[name];
    const last = pts[pts.length - 1];
    if (last && last[1] === v && tCan - last[0] < 1000) return;
    if (last && tCan - last[0] < 50 && name !== 'IBST_driverBrakeApply' && !name.startsWith('VCFRONT')) return; // ≤ 20 a second
    pts.push([Math.round(tCan), v]);
  };
  for (let t = fromCar; t <= toCar; t += 10) {
    const s = state(t);
    const tc = toCan(t) + rand() * 2; // a little bus jitter
    push('DI_vehicleSpeed', tc, Math.round((s.v) / 0.08) * 0.08);
    push('SteeringAngle129', tc, Math.round(s.steer * 10) / 10);
    push('DI_accelPedalPos', tc, Math.round(s.acc / 0.4) * 0.4);
    push('IBST_driverBrakeApply', tc, s.brake ? 2 : 1);
    push('VCFRONT_turnSignalLeftStatus', tc, s.left ? 1 : 0);
    push('VCFRONT_turnSignalRightStatus', tc, s.right ? 1 : 0);
  }
  return out;
}

/** One clip's telemetry JSON: frames at ~36 fps from the clip's true start (car time); the next clip starts a frame after its last. */
function clip(state, carStart, durMs, rand) {
  const frames = [];
  let t = 0;
  for (; t < durMs; t += 27.78 + (rand() - 0.5) * 2) frames.push([Math.round(t * 1000) / 1000, record(state(carStart + t))]);
  return { body: JSON.stringify({ v: 1, frames }), next: carStart + frames[frames.length - 1][0] + 27.78 };
}
const clipBody = (...a) => clip(...a).body;

const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
const OFFSET = 1370;
const DRIFT = 40e-6; // the CAN clock runs 40 ppm fast

test('one clip: edges line CAN up with the footage within 20 ms', () => {
  const rand = rng(7);
  const state = makeDrive(1, 60_000);
  const carStart = T0 + 437; // the clip really started 0.437 s after its name's second
  const toCan = (t) => t + OFFSET + DRIFT * (t - T0);
  const rel = (t) => state(t - carStart);
  const series = canSeries(rel, carStart - 15_000, carStart + 75_000, toCan, rand);
  const frames = telemetryFrames(clipBody(rel, carStart, 60_000, rand));
  const est = estimateClip({ frames, series, start: T0 });
  const truth = toCan(carStart) - T0;
  assert.equal(est.result.method, 'edges');
  assert.ok(est.result.matches >= 10, `${est.result.matches} edges`);
  assert.ok(Math.abs(est.result.offsetMs - truth) <= 20, `offset ${est.result.offsetMs} vs ${truth}`);
  assert.ok(est.result.spreadMs < 30, `spread ${est.result.spreadMs}`);
});

test('a drive of clips: one offset and drift for them all, each clip within 20 ms', () => {
  const rand = rng(11);
  const n = 6;
  const state = makeDrive(2, n * 60_000 + 5000);
  const toCan = (t) => t + OFFSET + 2.5 * DRIFT * (t - T0); // 100 ppm
  const clips = [];
  let carStart = T0 + 612;
  const allSeries = canSeries((t) => state(t - T0), T0 - 15_000, T0 + n * 60_000 + 20_000, toCan, rand);
  for (let k = 0; k < n; k++) {
    const dur = 60_000 + (rand() - 0.5) * 300;
    const name = Math.floor(carStart / 1000) * 1000;
    const made = clip((t) => state(t - T0), carStart, dur, rand);
    let { body } = made;
    if (k === 2) { // a clip with nothing that changes but speed: it rides on the drive's fit
      body = JSON.stringify({ v: 1, frames: JSON.parse(body).frames.map(([t]) => { const s = state(carStart + t - T0); return [t, record({ ...s, brake: false, left: false, right: false, acc: 0 })]; }) });
    }
    const frames = telemetryFrames(body);
    const series = Object.fromEntries(Object.entries(allSeries).map(([nm, pts]) => [nm, pts.filter((p) => p[0] >= name - 12_000 && p[0] <= name + 72_000)]));
    clips.push({ start: name, carStart, est: estimateClip({ frames, series, start: name }) });
    carStart = made.next; // the next clip starts where this one ends
  }
  const out = solveDrive(clips);
  clips.forEach((c, k) => {
    assert.equal(out[k].method, 'edges-drive', `clip ${k}: ${out[k].method}`);
    for (const t of [0, 30_000, 59_000]) {
      const truth = toCan(c.carStart + t);
      const got = c.start + out[k].offsetMs + t * out[k].rate;
      assert.ok(Math.abs(got - truth) <= 20, `clip ${k} at ${t / 1000} s: ${(got - truth).toFixed(1)} ms off`);
    }
  });
  assert.ok(out[0].matches >= 30, `${out[0].matches} edges`);
  assert.ok(Math.abs(out[0].driftPpm - 100) < 30, `drift ${out[0].driftPpm} ppm`);
});

test('a drive whose clips do not follow on (0.2-0.7 s between them, as real Tesla clips): no clip made worse, the quiet ones found by their speed', () => {
  const rand = rng(21);
  const n = 7;
  const busy = makeDrive(8, n * 61_000 + 5000);
  // 118-246 s into the drive: a steady cruise (under 3 km/h of wobble: no sync of a clip's own), nothing else changes
  const state = (t) => (t >= 118_000 && t <= 246_000
    ? { v: 100 + 0.9 * Math.sin(t / 4100) + 0.5 * Math.sin(t / 1300), acc: 0, steer: 2, brake: false, left: false, right: false }
    : busy(t));
  const toCan = (t) => t + OFFSET;
  const allSeries = canSeries((t) => state(t - T0), T0 - 15_000, T0 + n * 61_000 + 20_000, toCan, rand);
  const clips = [];
  let carStart = T0 + 380;
  for (let k = 0; k < n; k++) {
    const dur = 60_000 + (rand() - 0.5) * 400;
    const name = Math.floor(carStart / 1000) * 1000;
    const made = clip((t) => state(t - T0), carStart, dur, rand);
    const frames = telemetryFrames(made.body);
    const series = Object.fromEntries(Object.entries(allSeries).map(([nm, pts]) => [nm, pts.filter((p) => p[0] >= name - 12_000 && p[0] <= name + 72_000)]));
    clips.push({ start: name, carStart, est: estimateClip({ frames, series, start: name }) });
    carStart = made.next + 200 + rand() * 500; // the next clip starts a fraction of a second later
  }
  assert.ok(clips.slice(2, 4).every((c) => c.est.result.method === 'clock'), `the cruise's clips have no sync of their own: ${clips.map((c) => c.est.result.method)}`);
  const out = solveDrive(clips);
  clips.forEach((c, k) => {
    const truth = toCan(c.carStart) - c.start;
    const own = c.est.result;
    if (own.method !== 'clock') assert.ok(Math.abs(out[k].offsetMs - truth) <= Math.abs(own.offsetMs - truth) + 5, `clip ${k}: ${out[k].method} ${out[k].offsetMs} vs own ${own.method} ${own.offsetMs}, truth ${truth.toFixed(1)}`);
    // a clip of its own within 60 ms; one of the cruise, placed by its gentle speed alone, within 150 ms
    const tol = own.method === 'clock' ? 150 : 60;
    assert.ok(Math.abs(out[k].offsetMs - truth) <= tol, `clip ${k}: ${out[k].method} ${out[k].offsetMs} vs truth ${truth.toFixed(1)} (${(out[k].offsetMs - truth).toFixed(0)} ms)`);
  });
});

test('speed only (no edges): the speed correlation, within 60 ms', () => {
  const rand = rng(5);
  const state = makeDrive(3, 60_000, { edges: false });
  const carStart = T0 + 250;
  const toCan = (t) => t - 2840;
  const rel = (t) => state(t - carStart);
  const series = canSeries(rel, carStart - 15_000, carStart + 75_000, toCan, rand);
  for (const k of ['IBST_driverBrakeApply', 'VCFRONT_turnSignalLeftStatus', 'VCFRONT_turnSignalRightStatus', 'DI_accelPedalPos']) delete series[k];
  const frames = telemetryFrames(clipBody(rel, carStart, 60_000, rand));
  // (the footage's speed and steering only)
  const est = estimateClip({ frames: frames.map((f) => ({ ...f, acc: 0, brake: false, left: false, right: false })), series, start: T0 });
  const truth = toCan(carStart) - T0;
  assert.equal(est.result.method, 'speed');
  assert.ok(Math.abs(est.result.offsetMs - truth) <= 60, `offset ${est.result.offsetMs} vs ${truth}`);
});

test('no false match: speeds that only rise together, or are far apart, are not a sync', () => {
  const rand = rng(9);
  // the footage: a car speeding up steadily from 20 to 110 km/h over the minute
  const ramp = (t) => ({ v: 20 + (90 * Math.max(0, Math.min(60_000, t))) / 60_000, acc: 0, steer: 0, left: false, right: false, brake: false });
  const frames = telemetryFrames(clipBody(ramp, T0, 60_000, rand));
  // the CAN: another steady ramp (0 to 100 km/h), unrelated in time: no edges, no shape to match
  const series = { DI_vehicleSpeed: [] };
  for (let t = T0 - 15_000; t <= T0 + 75_000; t += 20) series.DI_vehicleSpeed.push([t, Math.max(0, (t - T0 + 15_000) / 900)]);
  assert.equal(estimateClip({ frames, series, start: T0 }).result.method, 'clock', 'two ramps correlate at every lag: no offset from them');
  // the same shape as the footage but a different speed throughout (another car, wrong units): not a match either
  const drive = makeDrive(6, 60_000, { edges: false });
  const fr2 = telemetryFrames(clipBody(drive, T0, 60_000, rand));
  const other = canSeries((t) => ({ ...drive(t), v: drive(t).v * 0.6 }), T0 - 15_000, T0 + 75_000, (t) => t, rand);
  for (const k of ['IBST_driverBrakeApply', 'VCFRONT_turnSignalLeftStatus', 'VCFRONT_turnSignalRightStatus', 'DI_accelPedalPos', 'SteeringAngle129']) delete other[k];
  assert.equal(estimateClip({ frames: fr2.map((f) => ({ ...f, acc: 0, brake: false, left: false, right: false, steer: 0 })), series: other, start: T0 }).result.method, 'clock');
});

test('no data: the clock as it is', () => {
  const none = estimateClip({ frames: [], series: {}, start: T0 });
  assert.deepEqual(none.result, { offsetMs: 0, method: 'clock', matches: 0, spreadMs: null });
  // footage but no CAN for it
  const rand = rng(3);
  const state = makeDrive(4, 60_000);
  const frames = telemetryFrames(clipBody(state, T0, 60_000, rand));
  assert.equal(estimateClip({ frames, series: {}, start: T0 }).result.method, 'clock');
  // a parked car: CAN but nothing moves
  const parked = Object.fromEntries(NAMES.map((n) => [n, [[T0 - 5000, n === 'IBST_driverBrakeApply' ? 1 : 0], [T0 + 30_000, n === 'IBST_driverBrakeApply' ? 1 : 0]]]));
  const still = frames.map((f) => ({ ...f, v: 0, acc: 0, steer: 0, brake: false, left: false, right: false }));
  assert.equal(estimateClip({ frames: still, series: parked, start: T0 }).result.method, 'clock');
  assert.deepEqual(solveDrive([{ start: T0, est: none }]), [none.result]);
});

test('the service: worked out on the first request, cached, and forgotten when a log covering it is indexed', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cansync-'));
  try {
    const root = path.join(dir, 'footage');
    const rel = 'TeslaCam/RecentClips/2026-06-01_12-00-00-front.mp4';
    const real = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(real), { recursive: true });
    await fsp.writeFile(real, 'x');
    const rand = rng(9);
    const state = makeDrive(5, 60_000);
    const carStart = T0 + 100;
    const toCan = (t) => t + OFFSET;
    const relState = (t) => state(t - carStart);
    const all = canSeries(relState, carStart - 15_000, carStart + 75_000, toCan, rand);
    const body = clipBody(relState, carStart, 60_000, rand);
    let reads = 0;
    const v = { id: 'car' };
    const sync = createCanSync({
      dir: path.join(dir, 'can-index'),
      series: async () => all,
      telemetry: async () => { reads++; return body; },
      vehicles: { list: () => [v], rootOf: () => root },
      inventory: { get: () => ({ files: new Map([[rel, { camera: 'front' }]]), recordings: [{ id: 'r1', clipRels: [rel] }] }) },
      keysFor: async () => ['MY-car'],
      startOf: () => T0,
      pauseMs: 0
    });
    const first = await sync.forClip({ v, keys: ['MY-car'], real, start: T0 });
    assert.equal(first.method, 'edges');
    assert.ok(Math.abs(first.offsetMs - (toCan(carStart) - T0)) <= 20);
    await sync.settled();
    const again = await sync.forClip({ v, keys: ['MY-car'], real, start: T0 });
    assert.equal(again.method, 'edges-drive', 'the drive worked out in the background');
    assert.ok(Math.abs(again.offsetMs - (toCan(carStart) - T0)) <= 20);
    const saved = JSON.parse(await fsp.readFile(path.join(dir, 'can-index', 'MY-car', 'sync.json'), 'utf8'));
    assert.equal(saved.clips[real].sync.method, 'edges-drive');
    const before = reads;
    await sync.forClip({ v, keys: ['MY-car'], real, start: T0 });
    assert.equal(reads, before, 'from the cache');
    await sync.indexed('MY-car', T0 - 600_000, T0 - 300_000);
    await sync.settled();
    assert.equal(reads, before, 'a log of another time changes nothing');
    await sync.indexed('MY-car', T0, T0 + 600_000);
    await sync.settled();
    assert.ok(reads > before, 'worked out again');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---- the service's cache and background

/** A drive's clip with its CAN log, and a service over a vehicle folder in a temp dir. */
async function serviceFor(dir, { linkRoot = false, keys = ['MY-car'], rec = true, series, telemetry, log, rels } = {}) {
  const footage = path.join(dir, 'footage');
  rels = rels || ['TeslaCam/RecentClips/2026-06-01_12-00-00-front.mp4'];
  for (const r of rels) {
    const file = path.join(footage, ...r.split('/'));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, 'x');
  }
  let root = footage;
  if (linkRoot) { root = path.join(dir, 'link'); await fsp.symlink(footage, root); }
  const rand = rng(9);
  const state = makeDrive(5, 60_000);
  const carStart = T0 + 100;
  const toCan = (t) => t + OFFSET;
  const relState = (t) => state(t - carStart);
  const all = canSeries(relState, carStart - 15_000, carStart + 75_000, toCan, rand);
  const body = clipBody(relState, carStart, 60_000, rand);
  const counts = { reads: 0 };
  const v = { id: 'car' };
  const sync = createCanSync({
    dir: path.join(dir, 'can-index'),
    series: series ? (...a) => series(all, ...a) : async () => all,
    telemetry: async (real) => { counts.reads++; return telemetry ? telemetry(body, real) : body; },
    vehicles: { list: () => [v], rootOf: () => root },
    inventory: { get: () => ({ files: new Map(rels.map((r) => [r, { camera: 'front' }])), recordings: rec ? [{ id: 'r1', clipRels: rels }] : [] }) },
    keysFor: async () => keys,
    startOf: () => T0,
    log,
    pauseMs: 0
  });
  // what forClip is given: the clip's real path (symlinks resolved), as studioReadable.resolve gives it
  const realOf = (r) => path.join(footage, ...r.split('/'));
  return { sync, v, counts, realOf, rels, truth: toCan(carStart) - T0 };
}
const withDir = async (fn) => {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'cansync-')));
  try { await fn(dir); } finally { await fsp.rm(dir, { recursive: true, force: true }); }
};

test('the service: a clip whose named start moved (the car\'s time zone changed) is worked out again', () => withDir(async (dir) => {
  const { sync, v, counts, realOf, rels } = await serviceFor(dir, { rec: false });
  await sync.forClip({ v, keys: ['MY-car'], real: realOf(rels[0]), start: T0 });
  await sync.settled();
  const before = counts.reads;
  await sync.forClip({ v, keys: ['MY-car'], real: realOf(rels[0]), start: T0 + 8 * 3600_000 });
  assert.ok(counts.reads > before, 'not the entry worked out for the old start');
  await sync.settled();
}));

test('the service: a vehicle folder behind a symlink still gets its drive worked out', () => withDir(async (dir) => {
  const { sync, v, realOf, rels, truth } = await serviceFor(dir, { linkRoot: true });
  const first = await sync.forClip({ v, keys: ['MY-car'], real: realOf(rels[0]), start: T0 });
  assert.equal(first.method, 'edges');
  await sync.settled();
  const again = await sync.forClip({ v, keys: ['MY-car'], real: realOf(rels[0]), start: T0 });
  assert.equal(again.method, 'edges-drive', 'the drive worked out in the background is what the viewer gets');
  assert.ok(Math.abs(again.offsetMs - truth) <= 20);
}));

test('the service: a log under a car\'s second key forgets what is kept under its first', () => withDir(async (dir) => {
  let have = false; // B's log is not indexed yet: no CAN
  const { sync, v, realOf, rels } = await serviceFor(dir, { keys: ['A', 'B'], rec: false, series: async (all) => (have ? all : {}) });
  const first = await sync.forClip({ v, keys: ['A', 'B'], real: realOf(rels[0]), start: T0 });
  assert.equal(first.method, 'clock');
  await sync.settled();
  have = true;
  await sync.indexed('B', T0, T0 + 600_000);
  await sync.settled();
  const again = await sync.forClip({ v, keys: ['A', 'B'], real: realOf(rels[0]), start: T0 });
  assert.equal(again.method, 'edges', 'worked out again with the new log');
  await sync.settled();
}));

test('the service: two requests that load a store at once both keep their entries', () => withDir(async (dir) => {
  const rels = ['TeslaCam/RecentClips/2026-06-01_12-00-00-front.mp4', 'TeslaCam/RecentClips/2026-06-01_12-01-00-front.mp4'];
  const { sync, v, realOf } = await serviceFor(dir, { rec: false, rels, series: async () => ({}) });
  await Promise.all(rels.map((r) => sync.forClip({ v, keys: ['MY-car'], real: realOf(r), start: T0 })));
  await sync.settled();
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'can-index', 'MY-car', 'sync.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.clips).sort(), rels.map(realOf).sort());
}));

test('the service: a drive queued just as the background finishes is still worked out', () => withDir(async (dir) => {
  // the moment the background ends is a few microtasks after a drive's last step: try each
  for (let n = 0; n < 30; n++) {
    const sub = path.join(dir, String(n));
    await fsp.mkdir(sub);
    let fired = false;
    let pending = null;
    let sync = null;
    const log = {
      warn() {},
      info() { // the last thing a drive's solve does
        if (fired) return;
        fired = true;
        (async () => { for (let i = 0; i < n; i++) await null; pending = sync.indexed('MY-car', T0, T0 + 600_000); })();
      }
    };
    const made = await serviceFor(sub, { log });
    sync = made.sync;
    await sync.forClip({ v: made.v, keys: ['MY-car'], real: made.realOf(made.rels[0]), start: T0 });
    await sync.settled();
    while (!pending) await new Promise((r) => setImmediate(r));
    await pending;
    await sync.settled();
    assert.equal(sync.status().pending, 0, `after ${n} microtasks: a drive left in the queue`);
  }
}));

test('the service: a telemetry read that failed is not kept, and is tried again', () => withDir(async (dir) => {
  let fail = true;
  const { sync, v, counts, realOf, rels } = await serviceFor(dir, { telemetry: (body) => { if (fail) throw new Error('telemetry reader stopped'); return body; } });
  const first = await sync.forClip({ v, keys: ['MY-car'], real: realOf(rels[0]), start: T0 });
  assert.equal(first.method, 'clock');
  await sync.settled();
  fail = false;
  const before = counts.reads;
  const again = await sync.forClip({ v, keys: ['MY-car'], real: realOf(rels[0]), start: T0 });
  assert.ok(counts.reads > before, 'read again');
  assert.equal(again.method, 'edges');
  await sync.settled();
}));
