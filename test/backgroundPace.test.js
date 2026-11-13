'use strict';

// The background pace: more clips at once while the server keeps up, fewer
// when it strains, none while busy or right after a long stall, one while
// the Viewer plays. Time and the event loop's lateness are simulated.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBackgroundPace } = require('../server/backgroundPace');
const { createSpeedIndex } = require('../server/speedIndex');

function sim({ busy = () => false } = {}) {
  let t = 1_000_000;
  const lag = { p99: 5, max: 20, percentile() { return this.p99 * 1e6; }, get max_() { return this.max; }, reset() {} };
  Object.defineProperty(lag, 'max', { get() { return lag._max * 1e6; }, set(v) { lag._max = v; } });
  lag.max = 20;
  const pace = createBackgroundPace({ busy, now: () => t, lag });
  // n seconds at this lateness, a clip read every `every` ms while `reading` are in reading
  const run = (n, { p99 = 5, max = 20, reading = pace.allowed(t), every = 500, ms = 400 } = {}) => {
    for (let i = 0; i < n; i++) {
      lag.p99 = p99;
      lag.max = max;
      for (let at = 0; at < 1000; at += every) pace.done(ms, t + at);
      t += 1000;
      pace.demand(reading === 'all' ? pace.allowed(t) : reading, true);
      pace.tick(t);
    }
  };
  return { pace, run, now: () => t };
}

test('pace: one at first, one more after calm seconds with every slot in use', () => {
  const { pace, run } = sim();
  assert.equal(pace.allowed(), 1);
  run(12, { reading: 'all' });
  assert.equal(pace.allowed(), 2);
});

test('pace: a step up that reads no more clips a minute is taken back', () => {
  const { pace, run } = sim();
  run(12, { reading: 'all', every: 500 });
  assert.equal(pace.allowed(), 2);
  run(21, { reading: 'all', every: 500 }); // same clips a minute with two
  assert.equal(pace.allowed(), 1);
  run(30, { reading: 'all' });
  assert.equal(pace.allowed(), 1, 'held off a good while before trying again');
});

test('pace: a step up that reads more is kept, up to the most', () => {
  const { pace, run } = sim();
  let every = 500;
  for (let i = 0; i < 12; i++) {
    run(12, { reading: 'all', every });
    every = Math.max(50, Math.round(every / 1.6));
    run(21, { reading: 'all', every });
  }
  assert.equal(pace.allowed(), 4);
});

test('pace: a late event loop for two seconds halves it; a long stall stops it a moment', () => {
  const { pace, run } = sim();
  let every = 500;
  for (let i = 0; i < 3; i++) {
    run(12, { reading: 'all', every });
    every = Math.round(every / 1.6);
    run(21, { reading: 'all', every });
  }
  const before = pace.allowed();
  assert.ok(before >= 3);
  run(1, { p99: 150, every });
  assert.equal(pace.allowed(), before, 'one late second is not enough');
  run(1, { p99: 150, every });
  assert.equal(pace.allowed(), Math.floor(before / 2));
  assert.equal(pace.strained(), true, 'other background work waits too');
  run(1, { max: 2500, every });
  assert.equal(pace.allowed(), 0, 'stopped right after a long stall');
  run(5, { every });
  assert.equal(pace.allowed(), 1);
});

test('pace: reads much slower than before count as strain', () => {
  const { pace, run } = sim();
  run(5, { ms: 300 });
  run(1, { ms: 3000 });
  run(1, { ms: 3000 });
  assert.equal(pace.strained(), true);
});

test('pace: one at a time while the Viewer plays and a while after; none while busy', () => {
  let busy = false;
  const { pace, run, now } = sim({ busy: () => busy });
  let every = 500;
  for (let i = 0; i < 2; i++) {
    run(12, { reading: 'all', every });
    every = Math.round(every / 1.6);
    run(21, { reading: 'all', every });
  }
  assert.ok(pace.allowed() >= 2);
  const res = new EventEmitter();
  pace.viewer(res);
  assert.equal(pace.allowed(), 1);
  res.emit('finish');
  res.emit('close'); // counted once
  assert.equal(pace.status().viewers, 0);
  assert.equal(pace.allowed(now()), 1);
  assert.ok(pace.allowed(now() + 31_000) >= 2);
  busy = true;
  assert.equal(pace.allowed(now() + 31_000), 0);
});

test('speed index: several clips at once, each from another day, all kept', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speedpar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = new Map();
  for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) {
    for (let i = 0; i < 4; i++) {
      const rel = `RecentClips/${day}_10-0${i}-00-front.mp4`;
      fs.mkdirSync(path.join(dir, 'RecentClips'), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), 'not an mp4');
      files.set(rel, { rel, kind: 'clip', camera: 'front', day, size: 10, mtimeMs: 1000 });
    }
  }
  let now = 0;
  let most = 0;
  const together = [];
  const telemetry = {
    limit: (fn) => fn(),
    read: async (real) => {
      now++;
      most = Math.max(most, now);
      together.push(path.basename(real).slice(0, 10));
      await new Promise((r) => setTimeout(r, 20));
      now--;
      return '{"frames":[]}';
    },
  };
  const pace = { allowed: () => 3, demand() {}, done() {}, status: () => ({ limit: 3 }) };
  const idx = createSpeedIndex({ dir: path.join(dir, 'speeds'), inventory: { get: () => ({ files }) }, vehicles: { list: () => [{ id: 'v1' }], rootOf: () => dir }, telemetry, pace });
  await idx.kick();
  assert.equal(idx.status().done, 12);
  assert.equal(most, 3);
  assert.deepEqual(new Set(together.slice(0, 3)), new Set(['2026-10-03', '2026-10-02', '2026-10-01']), 'the first three from three days');
  for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) assert.equal(Object.keys(await idx.day('v1', day)).length, 4);
});

test('speed index: a clip that changed while it was read is not kept', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speedchg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rel = 'RecentClips/2026-10-01_10-00-00-front.mp4';
  fs.mkdirSync(path.join(dir, 'RecentClips'), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), 'x');
  const files = new Map([[rel, { rel, kind: 'clip', camera: 'front', day: '2026-10-01', size: 1, mtimeMs: 1000 }]]);
  const telemetry = { limit: (fn) => fn(), read: async () => { files.set(rel, { ...files.get(rel), size: 2 }); return '{"frames":[]}'; } };
  const idx = createSpeedIndex({ dir: path.join(dir, 'speeds'), inventory: { get: () => ({ files }) }, vehicles: { list: () => [{ id: 'v1' }], rootOf: () => dir }, telemetry });
  await idx.kick();
  assert.equal(fs.existsSync(path.join(dir, 'speeds', 'v1', '2026-10-01.json')) ? Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'speeds', 'v1', '2026-10-01.json'), 'utf8'))).length : 0, 0);
});

test('pace: a slot counts as in use if it was at any moment since the last second', () => {
  const { pace, run } = sim();
  // each read ends and the next starts between two ticks: in use, though empty when ticked
  for (let i = 0; i < 12; i++) {
    pace.demand(1, true);
    pace.demand(0, true);
    run(1, { reading: 0 });
  }
  assert.equal(pace.allowed(), 2);
});

test('pace: a Viewer request already closed does not hold it at one for good', () => {
  const { pace, now } = sim();
  const res = new EventEmitter();
  res.destroyed = true;
  pace.viewer(res);
  assert.equal(pace.status().viewers, 0);
  assert.equal(pace.allowed(now() + 31_000), 1);
});
