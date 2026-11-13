'use strict';

// The speed index: fills in the background, keeps across restarts, reads a
// clip again only when it changes, and leaves out clips that changed since.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSpeedIndex } = require('../server/speedIndex');
const { createTeslaH264Fixture } = require('./fixtures/ffmpegFixtures');

test('speed index: indexes front clips once, and again when they change', { timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speedidx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'car');
  fs.mkdirSync(path.join(root, 'RecentClips'), { recursive: true });
  const f = Buffer.alloc(4);
  const pattern = Array.from({ length: 48 }, (_, n) => { f.writeFloatLE(0.3 + n); return Buffer.concat([Buffer.from([0x10, 0x01, 0x25]), f]); });
  const clip = path.join(root, 'RecentClips', '2026-10-11_10-00-11-front.mp4');
  await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: clip, telemetryPattern: pattern, size: '160x120' });
  fs.writeFileSync(path.join(root, 'RecentClips', '2026-10-11_10-00-11-back.mp4'), 'not read');

  const files = new Map();
  const scan = () => {
    files.clear();
    for (const name of fs.readdirSync(path.join(root, 'RecentClips'))) {
      const st = fs.statSync(path.join(root, 'RecentClips', name));
      files.set(`RecentClips/${name}`, { rel: `RecentClips/${name}`, kind: 'clip', camera: name.includes('front') ? 'front' : 'back', day: '2026-10-11', size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  scan();
  const inventory = { get: () => ({ files }) };
  const vehicles = { list: () => [{ id: 'v1' }], rootOf: () => root };
  const reads = [];
  const telemetry = { limit: (fn) => fn(), read: async () => { reads.push(1); return '{"frames":[]}'; } };
  const make = () => createSpeedIndex({ dir: path.join(dir, 'speeds'), inventory, vehicles, telemetry, pauseMs: 0 });

  const idx = make();
  assert.deepEqual(await idx.day('v1', '2026-10-11'), {});
  assert.equal(idx.status().running, false);
  const pass = idx.kick();
  assert.equal(idx.status().running, true, 'running as soon as it is started');
  await pass;
  assert.deepEqual((({ running, done, total, last }) => ({ running, done, total, last }))(idx.status()), { running: false, done: 1, total: 1, last: 1 });
  assert.deepEqual(await idx.day('v1', '2026-10-11'), { 'RecentClips/2026-10-11_10-00-11-front.mp4': [0.3, 12.3, 24.3, 36.3] });
  assert.equal(reads.length, 0, 'the quick read sufficed');

  // after a restart: read from disk, nothing indexed again
  const again = make();
  assert.equal(Object.keys(await again.day('v1', '2026-10-11')).length, 1);
  const before = fs.statSync(path.join(dir, 'speeds', 'v1', '2026-10-11.json')).mtimeMs;
  await again.kick();
  assert.equal(fs.statSync(path.join(dir, 'speeds', 'v1', '2026-10-11.json')).mtimeMs, before);

  // the clip changes (converted, say): left out until indexed again, which the
  // next pass does; a clip the quick reader cannot read falls back to the full read
  fs.writeFileSync(clip, Buffer.alloc(200, 1));
  scan();
  assert.deepEqual(await again.day('v1', '2026-10-11'), {});
  await again.kick();
  assert.deepEqual(await again.day('v1', '2026-10-11'), { 'RecentClips/2026-10-11_10-00-11-front.mp4': null });
  assert.equal(reads.length, 1);
  assert.deepEqual(await again.day('v1', 'nonsense'), {});
});

test('speed index: a footage folder set a level up or down keeps what was read', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speedmove-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const day = '2026-10-11';
  const entry = (rel) => ({ rel, kind: 'clip', camera: 'front', day, size: 1000, mtimeMs: 5000.4 });
  const sum = { b: null, t: null, v: [3, 20], g: [], k: 2 };
  fs.mkdirSync(path.join(dir, 'speeds', 'v1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'speeds', 'v1', day + '.json'), JSON.stringify({
    'RecentClips/2026-10-11_10-00-11-front.mp4': [1000, 5000, [1, 2], sum],
    // another copy of a clip with the same name (a saved event): not this file
    'SavedClips/2026-10-11_10-05-00/2026-10-11_10-00-11-front.mp4': [1000, 5000, [9], sum],
  }));
  // the car's folder is now the one above TeslaCam
  const files = new Map([
    ['TeslaCam/RecentClips/2026-10-11_10-00-11-front.mp4', entry('TeslaCam/RecentClips/2026-10-11_10-00-11-front.mp4')],
  ]);
  const read = [];
  const idx = createSpeedIndex({
    dir: path.join(dir, 'speeds'),
    inventory: { get: () => ({ files }) },
    vehicles: { list: () => [{ id: 'v1' }], rootOf: () => dir },
    telemetry: { limit: (fn) => fn(), read: async (real) => { read.push(real); throw new Error('no'); } },
    pauseMs: 0,
  });
  await idx.kick();
  assert.equal(idx.status().total, 0, 'nothing to read again');
  assert.deepEqual(read, []);
  assert.deepEqual(await idx.day('v1', day), { 'TeslaCam/RecentClips/2026-10-11_10-00-11-front.mp4': [1, 2] });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'speeds', 'v1', day + '.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), [
    'SavedClips/2026-10-11_10-05-00/2026-10-11_10-00-11-front.mp4',
    'TeslaCam/RecentClips/2026-10-11_10-00-11-front.mp4',
  ]);

  // a clip under its old path that has changed since (size or time) is read again
  files.set('TeslaCam/RecentClips/2026-10-11_11-00-00-front.mp4', { ...entry('TeslaCam/RecentClips/2026-10-11_11-00-00-front.mp4'), size: 2000 });
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'speeds', 'v1', day + '.json'), 'utf8'));
  data['RecentClips/2026-10-11_11-00-00-front.mp4'] = [1000, 5000, [4], sum];
  fs.writeFileSync(path.join(dir, 'speeds', 'v1', day + '.json'), JSON.stringify(data));
  const fresh = createSpeedIndex({
    dir: path.join(dir, 'speeds'),
    inventory: { get: () => ({ files }) },
    vehicles: { list: () => [{ id: 'v1' }], rootOf: () => dir },
    telemetry: { limit: (fn) => fn(), read: async (real) => { read.push(real); throw new Error('no'); } },
    pauseMs: 0,
  });
  await fresh.kick();
  assert.equal(fresh.status().total, 1);
});

test('speed index: every finished footage scan starts an indexing pass', async () => {
  const { Inventory } = require('../server/inventory');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speedscan-'));
  try {
    const scanned = [];
    const vehicles = { get: () => ({ id: 'v1', name: 'Car' }), share: () => null, rootOf: () => dir };
    const db = { protectedSet: () => new Set() };
    const inv = new Inventory({ vehicles, db, log: { info() {}, warn() {} }, onScanned: (id) => scanned.push(id) });
    inv.probeCodecs = () => {};
    await inv.scan('v1');
    await inv.scan('v1');
    assert.deepEqual(scanned, ['v1', 'v1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('speed index: each clip also keeps its hardest braking, sideways g, top speed and where it was', { timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speedsum-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'car');
  fs.mkdirSync(path.join(root, 'RecentClips'), { recursive: true });
  // 4 seconds of 12 frames: 20, 20, 12 (hard braking), 11 m/s; 3 m/s² sideways in second 1;
  // driving north from 37.7749, -122.4194
  const speeds = [20, 20, 12, 11];
  const record = (n) => {
    const sec = Math.floor(n / 12);
    const b = [];
    const f = Buffer.alloc(4); f.writeFloatLE(speeds[sec]); b.push(Buffer.from([0x25]), f);
    const dbl = (tag, v) => { const d = Buffer.alloc(8); d.writeDoubleLE(v); b.push(Buffer.from([tag]), d); };
    dbl(0x59, 37.7749 + sec * 0.001); // field 11, type 1
    dbl(0x61, -122.4194); // field 12
    dbl(0x71, -1); // field 14
    dbl(0x79, sec === 1 ? -3 : 0.5); // field 15
    return Buffer.concat(b);
  };
  const clip = path.join(root, 'RecentClips', '2026-10-11_10-00-11-front.mp4');
  await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: clip, telemetryPattern: Array.from({ length: 48 }, (_, n) => record(n)), size: '160x120' });
  const st = fs.statSync(clip);
  const files = new Map([['RecentClips/2026-10-11_10-00-11-front.mp4', { rel: 'RecentClips/2026-10-11_10-00-11-front.mp4', kind: 'clip', camera: 'front', day: '2026-10-11', size: st.size, mtimeMs: st.mtimeMs }]]);
  const idx = createSpeedIndex({ dir: path.join(dir, 'speeds'), inventory: { get: () => ({ files }) }, vehicles: { list: () => [{ id: 'v1' }], rootOf: () => root }, telemetry: {}, pauseMs: 0 });
  await idx.kick();
  assert.deepEqual(await idx.day('v1', '2026-10-11'), { 'RecentClips/2026-10-11_10-00-11-front.mp4': [20, 20, 12, 11] });
  assert.deepEqual(await idx.summaries('v1', '2026-10-11'), {
    'RecentClips/2026-10-11_10-00-11-front.mp4': { b: [1, 8], t: [1, 3], v: [0, 20], g: [[0, 37.7749, -122.4194]], k: 2 }
  });

  // an entry from before summaries existed is read again
  const file = path.join(dir, 'speeds', 'v1', '2026-10-11.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data['RecentClips/2026-10-11_10-00-11-front.mp4'].length = 3;
  fs.writeFileSync(file, JSON.stringify(data));
  const again = createSpeedIndex({ dir: path.join(dir, 'speeds'), inventory: { get: () => ({ files }) }, vehicles: { list: () => [{ id: 'v1' }], rootOf: () => root }, telemetry: {}, pauseMs: 0 });
  assert.deepEqual(await again.summaries('v1', '2026-10-11'), {});
  await again.kick();
  assert.equal(Object.keys(await again.summaries('v1', '2026-10-11')).length, 1);

  // and so is one from an older summary (before braking came from the accelerometer), however old the clip
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete old['RecentClips/2026-10-11_10-00-11-front.mp4'][3].k;
  old['RecentClips/2026-10-11_10-00-11-front.mp4'][3].b = null;
  fs.writeFileSync(file, JSON.stringify(old));
  const third = createSpeedIndex({ dir: path.join(dir, 'speeds'), inventory: { get: () => ({ files }) }, vehicles: { list: () => [{ id: 'v1' }], rootOf: () => root }, telemetry: {}, pauseMs: 0 });
  await third.kick();
  assert.deepEqual(Object.values(await third.summaries('v1', '2026-10-11'))[0].b, [1, 8]);
});

test('hard braking from the accelerometer, in a second where the car is slowing (the one-a-second speed misses it)', () => {
  const { summarize } = require('../server/speedIndex');
  const s = (v, ax) => ({ v, lat: null, lon: null, ax, ay: null });
  // 20 m/s to 17 to 14: 3 m/s a second by speed, but the car felt 0.6 g at second 1
  assert.deepEqual(summarize([s(20, 0), s(17, -5.9), s(14, -2), s(14, 0)]).b, [1, 5.9]);
  // a jolt while not slowing (a bump, speeding up) is not braking
  assert.deepEqual(summarize([s(10, 0), s(10, -6), s(12, 2), s(14, 0)]).b, null);
});

test('moments: hard braking and swerves over the line, strongest first, and the three fastest clips; places: clips that passed near', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clip = (n) => `RecentClips/2026-10-11_10-0${n}-00-front.mp4`;
  const files = new Map([1, 2, 3, 4, 5].map((n) => [clip(n), { rel: clip(n), kind: 'clip', camera: 'front', day: '2026-10-11', size: 100 + n, mtimeMs: 1000 }]));
  const sum = (b, tt, v, g = []) => ({ b, t: tt, v, g });
  const data = {
    [clip(1)]: [101, 1000, [], sum([12, 3.0], [3, 2], [0, 20])], // nothing hard
    [clip(2)]: [102, 1000, [], sum([30, 7.2], [5, 1], [10, 25], [[0, 37.7749, -122.4194], [5, 37.7760, -122.4194]])],
    [clip(3)]: [103, 1000, [], sum([2, 4.5], [40, 5.1], [20, 31])],
    [clip(4)]: [104, 1000, [], sum(null, null, [1, 33])],
    [clip(5)]: [999, 1000, [], sum([1, 9], null, [1, 40])] // changed since: left out
  };
  fs.mkdirSync(path.join(dir, 'speeds', 'v1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'speeds', 'v1', '2026-10-11.json'), JSON.stringify(data));
  const idx = createSpeedIndex({ dir: path.join(dir, 'speeds'), inventory: { get: () => ({ files }) }, vehicles: { list: () => [] }, telemetry: {}, pauseMs: 0 });
  assert.deepEqual((await idx.moments('v1', '2026-10-11')).map((m) => [m.kind, m.rel.slice(23, 31), m.second, m.value]), [
    ['brake', '10-02-00', 30, 7.2],
    ['swerve', '10-03-00', 40, 5.1],
    ['brake', '10-03-00', 2, 4.5],
    ['speed', '10-04-00', 1, 33],
    ['speed', '10-03-00', 20, 31],
    ['speed', '10-02-00', 10, 25]
  ]);
  const near = await idx.near(['v1'], 37.7759, -122.4194, 150);
  assert.deepEqual(near.map(({ rel, second, metres }) => [rel.slice(23, 31), second, metres]), [['10-02-00', 5, 11]]);
  assert.deepEqual(await idx.near(['v1'], 40, -100, 150), [], 'nowhere near');
});

test('place search cache: filled ahead (warm), then a search reads no day file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-warm-'));
  fs.mkdirSync(path.join(dir, 'car'));
  for (const day of ['2026-11-01', '2026-11-02']) {
    fs.writeFileSync(path.join(dir, 'car', `${day}.json`), JSON.stringify({ [`TeslaCam/RecentClips/${day}_10-00-00-front.mp4`]: [1, 1, [10], { b: null, t: null, v: [0, 10], g: [[0, 37.788, -122.4193], [5, 37.8, -122.5]] }] }));
  }
  const si = createSpeedIndex({ dir, inventory: { get: () => null }, vehicles: { list: () => [] }, telemetry: {} });
  await si.warm(['car'], 0);
  const fsp = require('fs/promises');
  const realRead = fsp.readFile;
  let reads = 0;
  fsp.readFile = async (...a) => { reads++; return realRead(...a); };
  try {
    const hits = await si.near(['car'], 37.788, -122.4193, 100);
    assert.deepEqual(hits.map((h) => [h.day, h.second, h.metres]), [['2026-11-02', 0, 0], ['2026-11-01', 0, 0]]);
    assert.equal(reads, 0, 'every day came from the cache');
  } finally {
    fsp.readFile = realRead;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hard braking counts only deceleration: the peak of a pull, or a jolt up, is not braking', () => {
  const { summarize } = require('../server/speedIndex');
  const s = (v, ax) => ({ v, lat: null, lon: null, ax, ay: null });
  // accelerating at 0.43 g, then lifting off (regen takes 0.5 m/s): only the speed lost counts
  assert.deepEqual(summarize([s(8, 3), s(12, 4.5), s(15, 4.2), s(14.5, 0.5), s(14.5, 0)]).b, [2, 0.5]);
  // a positive spike in a slowing second is not braking either
  assert.deepEqual(summarize([s(20, 0), s(18, 6.5), s(16, 0), s(16, 0)]).b, [0, 2]);
  // a one-sample bump far beyond what the speed lost
  assert.deepEqual(summarize([s(20, 0), s(19.5, -9), s(19.5, 0), s(19.5, 0)]).b, [0, 0.5]);
});

test('an older summary whose speeds have no slowing second is upgraded in place, not read again', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rel = (n) => `RecentClips/2026-10-11_10-0${n}-00-front.mp4`;
  const files = new Map([1, 2].map((n) => [rel(n), { rel: rel(n), kind: 'clip', camera: 'front', day: '2026-10-11', size: 100 + n, mtimeMs: 1000 }]));
  fs.mkdirSync(path.join(dir, 'speeds', 'v1'), { recursive: true });
  const parked = { b: null, t: [3, 0.2], v: [0, 0], g: [] };
  fs.writeFileSync(path.join(dir, 'speeds', 'v1', '2026-10-11.json'), JSON.stringify({
    [rel(1)]: [101, 1000, [0, 0, 0, 0.1, 0.2], parked], // parked Sentry clip: cannot change
    [rel(2)]: [102, 1000, [20, 18, 16], { b: [0, 2], t: null, v: [0, 20], g: [] }] // slows: read again
  }));
  const read = [];
  const root = path.join(dir, 'car');
  const idx = createSpeedIndex({ dir: path.join(dir, 'speeds'), inventory: { get: () => ({ files }) }, vehicles: { list: () => [{ id: 'v1' }], rootOf: () => root }, telemetry: { limit: (fn) => fn(), read: async (real) => { read.push(path.basename(real)); throw new Error('gone'); } }, pauseMs: 0 });
  await idx.kick();
  assert.deepEqual(read, ['2026-10-11_10-02-00-front.mp4']);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'speeds', 'v1', '2026-10-11.json'), 'utf8'));
  assert.deepEqual(saved[rel(1)], [101, 1000, [0, 0, 0, 0.1, 0.2], { ...parked, k: 2 }]);
});

test('index.js waits for the converter and the benchmark before reading speeds', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(src, /createSpeedIndex\(\{[^}]*idle: \(\) => !speedIndexBusy\(\)/);
  assert.match(src, /speedIndexBusy = \(\) => converterRunning\(\) \|\| benchmarking !== null;/);
});
