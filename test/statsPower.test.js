'use strict';

// Server monitor, power and energy: RAPL watts across the counter's
// wrap-around (read here or sent by the supervisor), Wh per day and per
// conversion job, and the benchmark's power meter.

const test = require('node:test');
const assert = require('node:assert/strict');
const { energyDelta, packageWatts, PowerProvider } = require('../server/stats/power');
const { Energy, dayKey } = require('../server/stats/energy');
const M = require('./fixtures/stats/machines');
const { setup } = require('./fixtures/stats/helpers');

const MAX = M.RAPL_MAX;
const reading = (at, energyUj, name = 'package-0') => ({ at, packages: [{ name, energyUj, maxEnergyUj: MAX }] });
// timers that never fire: the test drives every sample itself
const heldTimers = () => ({ setTimeout: () => ({ unref() {} }), clearTimeout() {} });

test('RAPL: watts from energy deltas, across the wrap-around', () => {
  assert.equal(energyDelta(100, 300, MAX), 200);
  assert.equal(energyDelta(MAX - 50, 150, MAX), 200, 'counted up to the max, then from 0');
  assert.equal(energyDelta(500, 100, null), null, 'a step back without a known range is no answer');
  assert.equal(energyDelta(MAX + 10, 5, MAX), null);
  assert.equal(energyDelta(NaN, 5, MAX), null);
  assert.equal(packageWatts(reading(0, MAX - 40e6), reading(2000, 42e6)), 41);
  assert.equal(packageWatts(reading(0, 0), reading(0, 10)), null, 'no time passed');
  assert.equal(packageWatts(reading(0, 0), reading(120000, 10)), null, 'too far apart: it could have wrapped twice');
  assert.equal(packageWatts(reading(0, 0), reading(1000, 5e9)), null, '5 kW is not a CPU');
  // only packages; the core/uncore/dram parts are inside them
  const two = (at, a, b, core) => ({ at, packages: [{ name: 'package-0', energyUj: a }, { name: 'package-1', energyUj: b }, { name: 'core', energyUj: core }] });
  assert.equal(packageWatts(two(0, 0, 0, 0), two(1000, 30e6, 20e6, 99e6)), 50);
});

test('RAPL from the supervisor: fresh readings only, out-of-order and malformed ones ignored', () => {
  let t = 100000;
  const p = new PowerProvider({ sysRoot: '/nonexistent', now: () => t, intervalMs: 2000 });
  p.probe();
  assert.equal(p.direct, false);
  assert.equal(p.cpu(t), null);
  p.setRapl(reading(t - 2000, MAX - 10e6));
  p.setRapl(reading(t, 50e6));
  assert.equal(p.cpu(t), 30);
  p.setRapl(reading(t - 1000, 1)); // older than the last one
  p.setRapl({ at: 'soon', packages: 'all' });
  p.setRapl(null);
  p.setRapl({ at: t + 1, packages: [{ name: 'package-0', energyUj: 'x' }] });
  assert.equal(p.cpu(t), 30);
  assert.equal(p.hasRapl(t), true);
  t += 11000; // the supervisor went quiet
  assert.equal(p.cpu(t), null);
});

test('energy: Wh integrated from samples, gaps not guessed, per day in local time', () => {
  const e = new Energy({ intervalMs: 2000 });
  const r = (n) => Math.round(n * 1000) / 1000;
  // 60 s at 120 W ending at 23:59:58, then 60 s into the next day
  const start = new Date(2026, 9, 23, 23, 58, 58).getTime();
  let t = start;
  for (let i = 0; i <= 30; i++, t += 2000) e.add(t, 120);
  for (let i = 0; i < 30; i++, t += 2000) e.add(t, 120);
  t -= 2000;
  assert.equal(dayKey(start), '2026-10-23');
  assert.equal(r(e.days['2026-10-23']), 2, '60 s at 120 W');
  assert.equal(e.summary(t).todayWh, 2, 'the next day: also 60 s');
  assert.equal(e.summary(t).weekWh, 4);
  // nobody watched for ten minutes: that gap is not counted
  e.add(t + 600000, 120);
  e.add(t + 602000, 120);
  const after = r(2 + 120 * 2 / 3600);
  assert.equal(e.summary(t + 602000).todayWh, after);
  // an unknown reading breaks the chain too
  e.add(t + 604000, null);
  e.add(t + 606000, 120);
  assert.equal(e.summary(t + 606000).todayWh, after);
  // eight days later both days are out of the week
  assert.equal(e.summary(t + 8 * 86400000).weekWh, 0);
});

test('energy per job, and what it cost at the price of each moment', () => {
  const e = new Energy({ intervalMs: 2000 });
  let t = new Date(2026, 9, 23, 12, 0, 0).getTime();
  e.add(t, 50, 0.3);
  e.markJob('job-1');
  for (let i = 0; i < 9; i++) {
    t += 2000;
    // a time-of-use plan: the price changes half-way through the job
    e.add(t, 50, i < 4 ? 0.36 : 0.12);
  }
  e.markJob(null);
  t += 2000;
  e.add(t, 50, 0.36); // after the job: not counted for it
  const s = e.summary(t);
  const wh = 50 * 2 / 3600;
  assert.deepEqual(s.byJob['job-1'], {
    wh: 0.25, avgW: 50, seconds: 18, cost: Math.round(((4 * wh * 0.36) + (5 * wh * 0.12)) / 1000 * 1e6) / 1e6
  });
  assert.equal(s.todayWh, 0.278);
  assert.equal(s.todayCost, Math.round(((5 * wh * 0.36) + (5 * wh * 0.12)) / 1000 * 1e6) / 1e6);
  assert.equal(s.weekCost, s.todayCost);
  // no price set: the energy counts, the cost is unknown (not 0)
  const free = new Energy({ intervalMs: 2000 });
  free.markJob('j');
  free.add(t, 80);
  free.add(t + 2000, 80);
  assert.deepEqual(free.summary(t + 2000), { todayWh: 0.044, weekWh: 0.044, todayCost: null, weekCost: null, byJob: { j: { wh: 0.044, avgW: 80, seconds: 2, cost: null } } });
  // job ids are data
  e.markJob('__proto__');
  e.add(t + 2000, 10);
  assert.equal(Object.getPrototypeOf(e.summary(t + 2000).byJob), Object.prototype);
  assert.ok(Object.hasOwn(e.summary(t + 2000).byJob, '__proto__'));
});

test('the engine: markJob counts a job\'s energy, keeps sampling and shows it on the snapshot', async () => {
  const s = setup(M.intelArc, { timers: heldTimers() });
  try {
    await s.run(2);
    s.stats.markJob('conv-7');
    assert.equal(s.stats.sampling, true, 'a job keeps the sampler running');
    for (let p = 3; p <= 5; p++) {
      s.m.update(M.intelArc(p));
      s.clock.advance(2000);
      s.stats.sampleNow();
      await s.stats.settle();
    }
    s.stats.markJob(null);
    const byJob = s.stats.energy().byJob['conv-7'];
    assert.equal(byJob.seconds, 6);
    assert.equal(byJob.avgW, 65, 'CPU 41 W + Arc 24 W');
    assert.equal(byJob.wh, Math.round(65 * 6 / 3600 * 1000) / 1000);
    assert.equal(byJob.cost, null, 'no price set');
    assert.ok(s.stats.energy().todayWh >= byJob.wh);
  } finally {
    s.done();
  }
});

test('no RAPL on an x86 machine: a hint after a few seconds, gone once the supervisor sends readings', async () => {
  const s = setup(M.amd, { appPid: 8, timers: heldTimers() });
  try {
    s.stats.touch();
    assert.ok(!s.stats.snapshot().unlock.some((u) => u.key === 'cpu-power'), 'not at once: the supervisor may still answer');
    for (let p = 1; p <= 3; p++) {
      s.m.update(M.amd(p));
      s.clock.advance(2000);
      s.stats.touch();
      s.stats.sampleNow();
      await s.stats.settle();
    }
    const hint = s.stats.snapshot().unlock.find((u) => u.key === 'cpu-power');
    assert.ok(hint, 'shown after three intervals without a reading');
    assert.match(hint.compose, /powercap.*:ro/);
    assert.match(hint.adds, /CPU power/);
    s.stats.setRapl(reading(s.clock.t - 2000, 1e9));
    s.stats.setRapl(reading(s.clock.t, 1e9 + 70e6));
    s.clock.advance(300);
    s.stats.sampleNow();
    const snap = s.stats.snapshot();
    assert.ok(!snap.unlock.some((u) => u.key === 'cpu-power'));
    assert.equal(snap.power.cpuW, 35);
    assert.equal(snap.power.cpuSource, 'rapl');
    assert.equal(snap.power.totalW, 120, 'CPU 35 W + RX 6600 85 W');
  } finally {
    s.done();
  }
});

test('the engine: costs at the price of each moment, from options.priceAt', async () => {
  let price = 0.4;
  const s = setup(M.intelArc, { timers: heldTimers(), options: { priceAt: () => price } });
  try {
    await s.run(2);
    s.stats.markJob('night-run');
    for (let p = 3; p <= 4; p++) {
      if (p === 4) price = 0.1; // off-peak starts
      s.m.update(M.intelArc(p));
      s.clock.advance(2000);
      s.stats.sampleNow();
      await s.stats.settle();
    }
    const snap = s.stats.snapshot();
    const step = (65 * 2 / 3600) / 1000;
    assert.equal(snap.power.priceNow, 0.1);
    assert.equal(s.stats.energy().byJob['night-run'].cost, Math.round((step * 0.4 + step * 0.1) * 1e6) / 1e6);
    assert.ok(snap.power.todayCost > 0);
    assert.equal(snap.power.weekCost, snap.power.todayCost);
    // a price function that throws or answers nonsense is no price
    price = 'cheap';
    s.m.update(M.intelArc(5));
    s.clock.advance(2000);
    s.stats.sampleNow();
    assert.equal(s.stats.snapshot().power.priceNow, null);
  } finally {
    s.done();
  }
});
