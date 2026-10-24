'use strict';

// Server monitor, history: 2 s samples for 15 minutes, 1-minute averages for
// 24 hours, the tiles' sparklines, CSV export, and the file in the data
// folder that keeps graphs and energy across a restart.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { History, SERIES } = require('../server/stats/history');
const M = require('./fixtures/stats/machines');
const { setup, fakeClock } = require('./fixtures/stats/helpers');

const row = (cpu, extra = {}) => SERIES.map((name) => (name === 'cpu' ? cpu : extra[name] ?? null));
const heldTimers = () => ({ setTimeout: () => ({ unref() {} }), clearTimeout() {} });

test('15 minutes: one slot per 2 s sample on a grid ending now, null where nothing was sampled', () => {
  const h = new History({ intervalMs: 2000 });
  const t0 = Date.UTC(2026, 9, 23, 10, 0, 0);
  // 20 minutes of samples, then 30 s with nobody watching
  for (let i = 0; i < 600; i++) h.add(t0 + i * 2000, row(i % 100, { rxBps: 1000 + i }));
  const end = t0 + 599 * 2000 + 30000;
  const r = h.range('15m', end);
  assert.equal(r.step, 2000);
  assert.equal(r.series.cpu.length, 450);
  assert.equal(r.start, end - 449 * 2000);
  assert.deepEqual(Object.keys(r.series), SERIES);
  assert.deepEqual(r.series.cpu.slice(-15), new Array(15).fill(null), 'the last 30 s: nothing sampled');
  assert.equal(r.series.cpu[434], 599 % 100, 'the last sample sits 15 slots from the end');
  assert.equal(r.series.rxBps[434], 1599);
  assert.equal(r.series.gpuVideo.every((v) => v === null), true);
  // jittered sample times still land in their own slot
  const j = new History({ intervalMs: 2000 });
  for (let i = 0; i < 10; i++) j.add(t0 + i * 2000 + (i % 2 ? 37 : -41), row(i));
  const jr = j.range('15m', t0 + 18000);
  assert.deepEqual(jr.series.cpu.slice(-10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('24 hours: 1-minute averages, the minute in progress included, older than a day dropped', () => {
  const h = new History({ intervalMs: 2000 });
  const t0 = Date.UTC(2026, 9, 23, 0, 0, 0);
  // minute 0: 10 and 30 alternating -> 20; minute 1: 50; then a 2-hour gap; minute 122: half a minute of 80
  for (let i = 0; i < 30; i++) h.add(t0 + i * 2000, row(i % 2 ? 30 : 10, { powerW: 60 }));
  for (let i = 0; i < 30; i++) h.add(t0 + 60000 + i * 2000, row(50));
  for (let i = 0; i < 15; i++) h.add(t0 + 122 * 60000 + i * 2000, row(80, { tempMax: 70.25 }));
  const now = t0 + 122 * 60000 + 29000;
  const r = h.range('24h', now);
  assert.equal(r.step, 60000);
  assert.equal(r.series.cpu.length, 1440);
  assert.equal(r.start, t0 + 122 * 60000 - 1439 * 60000);
  const at = (t) => (t - r.start) / 60000;
  assert.equal(r.series.cpu[at(t0)], 20);
  assert.equal(r.series.powerW[at(t0)], 60);
  assert.equal(r.series.cpu[at(t0 + 60000)], 50);
  assert.equal(r.series.cpu[at(t0 + 120000)], null);
  assert.equal(r.series.cpu[1439], 80, 'the minute in progress');
  assert.equal(r.series.tempMax[1439], 70.3);
  assert.equal(r.series.powerW[1439], null);
  // a day later the first minutes are gone
  h.add(t0 + 86400000 + 61000, row(1));
  h.add(t0 + 86400000 + 121000, row(1));
  const later = h.range('24h', t0 + 86400000 + 121000);
  assert.equal(later.series.cpu.filter((v) => v === 20 || v === 50).length, 0);
  assert.ok(h.minutes.length <= 1441);
});

test('sparklines: at most 90 points of the last 15 minutes, averaged, no gaps', () => {
  const h = new History({ intervalMs: 2000 });
  const t0 = Date.UTC(2026, 9, 23, 10, 0, 0);
  for (let i = 0; i < 450; i++) h.add(t0 + i * 2000, row(i % 5 === 0 ? null : 50, { gpuVideo: 94, rxBps: i < 225 ? 100 : 300 }));
  const s = h.sparks(t0 + 449 * 2000);
  assert.equal(s.cpu.length, 90);
  assert.ok(s.cpu.every((v) => v === 50), 'missing samples are skipped, not drawn as 0');
  assert.equal(s.gpuVideo.length, 90);
  assert.equal(s.rxBps[0], 100);
  assert.equal(s.rxBps[89], 300);
  const few = new History({ intervalMs: 2000 });
  few.add(t0, row(10));
  few.add(t0 + 2000, row(20));
  assert.deepEqual(few.sparks(t0 + 2000), { cpu: [10, 20], gpuVideo: [], gpuBusy: [], rxBps: [] });
});

test('CSV: an ISO time column, the series in order, empty cells for no data', () => {
  const h = new History({ intervalMs: 2000 });
  const t0 = Date.UTC(2026, 9, 23, 10, 0, 0);
  h.add(t0, [12.34, 58.04, null, 94, 68.25, 117440512, 46137344, 71.85]);
  h.add(t0 + 2000, [13, 58, null, null, null, 0, 0, null]);
  const text = h.csv('15m', t0 + 2000);
  assert.equal(text, [
    'time,cpu,memory,gpuBusy,gpuVideo,powerW,rxBps,txBps,tempMax',
    '2026-10-23T10:00:00.000Z,12.3,58,,94,68.3,117440512,46137344,71.9',
    '2026-10-23T10:00:02.000Z,13,58,,,,0,0,',
    ''
  ].join('\n'));
  const day = h.csv('24h', t0 + 2000).split('\n');
  assert.equal(day[0], 'time,cpu,memory,gpuBusy,gpuVideo,powerW,rxBps,txBps,tempMax');
  assert.equal(day[1], '2026-10-23T10:00:00.000Z,12.7,58,,94,68.3,58720256,23068672,71.9');
  assert.equal(day.length, 3);
});

test('the engine saves history and energy to stats-history.json and reads them back after a restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-stats-data-'));
  const clock = fakeClock();
  const file = path.join(dataDir, 'stats-history.json');
  const first = setup(M.intelArc, { clock, dataDir, timers: heldTimers() });
  try {
    await first.run(2);
    first.stats.markJob('job-9');
    for (let p = 3; p <= 40; p++) {
      first.m.update(M.intelArc(p));
      clock.advance(2000);
      first.stats.sampleNow();
      await first.stats.settle();
    }
    first.stats.markJob(null);
    assert.equal(fs.existsSync(file), false, 'not every sample: every 5 minutes, and on stop');
    const before = { h15: first.stats.history('15m'), h24: first.stats.history('24h'), energy: first.stats.energy(), csv: first.stats.csv('24h') };
    first.stats.stop();
    assert.ok(fs.existsSync(file));
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
    assert.deepEqual(fs.readdirSync(dataDir), ['stats-history.json'], 'no temp file left behind');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.v, 1);
    assert.ok(saved.history.recent.length >= 40);
    assert.ok(saved.energy.jobs['job-9'].wh > 0);

    // a restart a few seconds later
    clock.advance(5000);
    const again = setup(M.intelArc, { clock, dataDir, timers: heldTimers() });
    try {
      const h15 = again.stats.history('15m');
      assert.deepEqual(h15.series.cpu.filter((v) => v !== null), before.h15.series.cpu.filter((v) => v !== null));
      assert.deepEqual(again.stats.history('24h').series, before.h24.series);
      assert.deepEqual(again.stats.energy(), before.energy);
      assert.equal(again.stats.csv('24h'), before.csv);
      assert.deepEqual(again.stats.snapshot().sparks, { cpu: [], gpuVideo: [], gpuBusy: [], rxBps: [] }, 'sparks come with the first sample');
      again.stats.sampleNow();
      assert.ok(again.stats.snapshot().sparks.cpu.length > 30, 'the tiles keep their last 15 minutes');
    } finally {
      again.done();
    }
  } finally {
    first.m.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('while sampling, the file is written every 5 minutes', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-stats-data-'));
  const s = setup(M.amd, { appPid: 8, dataDir, timers: heldTimers() });
  try {
    await s.run(1);
    s.clock.advance(5 * 60 * 1000);
    s.stats.sampleNow();
    assert.ok(fs.existsSync(path.join(dataDir, 'stats-history.json')));
  } finally {
    s.done();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a damaged, foreign or oversized history file is set aside quietly; a missing data folder is created', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-stats-data-'));
  const file = path.join(dataDir, 'stats-history.json');
  const warnings = [];
  const log = { warn: (m) => warnings.push(m), info() {} };
  try {
    for (const content of ['{"v":1,"history":', '[]', '{"v":2,"history":{}}', JSON.stringify({ v: 1, history: { series: 'x', recent: 5 }, energy: { days: { bad: -1, '2026-10-23': 'x' }, jobs: { a: null } } })]) {
      fs.writeFileSync(file, content);
      const s = setup(M.pi, { appPid: 20, dataDir, options: { log } });
      assert.doesNotThrow(() => s.stats.sampleNow());
      assert.deepEqual(s.stats.energy(), { todayWh: 0, weekWh: 0, todayCost: null, weekCost: null, byJob: {} });
      s.m.cleanup();
    }
    assert.equal(warnings.length, 1, 'unreadable JSON is reported once per start');
    fs.writeFileSync(file, Buffer.alloc(9 * 1024 * 1024, 32));
    const big = setup(M.pi, { appPid: 20, dataDir, options: { log } });
    assert.ok(big.stats.history('15m').series.cpu.every((v) => v === null));
    big.m.cleanup();
    // older columns load by name; a series added later loads empty
    fs.writeFileSync(file, JSON.stringify({ v: 1, history: { series: ['rxBps', 'cpu'], recent: [[Date.now(), 5, 7]], minutes: [] }, energy: {} }));
    const named = setup(M.pi, { appPid: 20, dataDir, clock: fakeClock(Date.now() + 1000) });
    const r = named.stats.history('15m');
    assert.equal(r.series.cpu.filter((v) => v !== null)[0], 7);
    assert.equal(r.series.rxBps.filter((v) => v !== null)[0], 5);
    assert.ok(r.series.memory.every((v) => v === null));
    named.m.cleanup();
    // the data folder does not exist yet
    const nested = path.join(dataDir, 'not', 'yet');
    const s = setup(M.pi, { appPid: 20, dataDir: nested });
    s.stats.sampleNow();
    s.done();
    assert.ok(fs.existsSync(path.join(nested, 'stats-history.json')));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
