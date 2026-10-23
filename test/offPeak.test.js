'use strict';

// Automatic conversion "only at off-peak": the automatic job pauses when the
// cheapest rate ends and resumes when it starts again; with "also pause
// conversions I start myself", manual jobs do the same (once per peak: one the
// owner resumes is left running). Survives a restart in between.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAutoConverter } = require('../src/main/converter/autoConvert');
const { parsePowerSettings, isCheapest } = require('../server/powerPrice');

process.env.TZ = 'UTC';
const at = (iso) => Date.parse(`${iso}Z`);
// off-peak 23:00-07:00 every day, 0.09; other hours 0.20
const plan = parsePowerSettings({ mode: 'tou', defaultPrice: 0.2, rates: [{ label: 'Off-peak', price: 0.09, days: [0, 1, 2, 3, 4, 5, 6], from: '23:00', to: '07:00' }] });

function fakeService(jobs) {
  const calls = [];
  return {
    calls,
    list: async () => jobs.map((j) => ({ ...j })),
    get: async (id) => ({ ...jobs.find((j) => j.id === id) }),
    pause: async (id) => { calls.push(['pause', id]); jobs.find((j) => j.id === id).state = 'paused'; },
    resume: async (id) => {
      calls.push(['resume', id]);
      const job = jobs.find((j) => j.id === id);
      if (job.state !== 'paused') throw Object.assign(new Error('not paused'), { code: 'JOB_NOT_PAUSED' });
      job.state = 'encoding';
    },
    start: async () => 'job-new'
  };
}

function makeAuto(dir, service, clock) {
  return createAutoConverter({
    service, scanner: async function* () {}, fs: fs.promises, directory: dir,
    timers: { setInterval: () => null, clearInterval: () => {} },
    now: () => clock.t, isBusy: async () => true,
    isCheapNow: (ms) => isCheapest(plan, ms)
  });
}

const config = (dir) => ({ sourceRoot: dir, destinationRoot: null, codec: 'h265', profileId: 'balanced', networkMode: 'direct', outputMode: 'replace',
  includedGroups: ['SavedClips'], groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'], replacementConfirmed: true, concurrency: 4, verifyMode: 'quick' });

test('the automatic job pauses when off-peak ends and resumes when it starts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-offpeak-'));
  try {
    const jobs = [{ id: 'auto1', state: 'encoding', config: { ...config(dir), autoConvert: true } }];
    const service = fakeService(jobs);
    const clock = { t: at('2026-10-23T06:59:30') };
    const auto = makeAuto(dir, service, clock);
    await auto.configure({ enabled: true, intervalMinutes: 60, window: { follow: 'off-peak' }, config: config(dir) });
    await auto.start();
    await auto.tick();
    assert.equal(jobs[0].state, 'encoding', 'still off-peak at 06:59:30');
    clock.t = at('2026-10-23T07:00:30');
    await auto.tick();
    assert.equal(jobs[0].state, 'paused', 'paused 30 s after off-peak ended');
    assert.equal(auto.getState().status.pausedForWindow, true);
    clock.t = at('2026-10-23T12:00:00');
    await auto.tick();
    assert.equal(jobs[0].state, 'paused', 'stays paused at the day rate');
    clock.t = at('2026-10-23T23:00:30');
    await auto.tick();
    assert.equal(jobs[0].state, 'encoding', 'resumed when off-peak started');
    auto.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('"also pause my own": manual jobs pause at peak, resume at off-peak, and the owner can override', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-offpeak-'));
  try {
    const jobs = [
      { id: 'mine', state: 'encoding', config: config(dir) },
      { id: 'mine2', state: 'waiting', config: config(dir) }
    ];
    const service = fakeService(jobs);
    const clock = { t: at('2026-10-23T06:00:00') };
    let auto = makeAuto(dir, service, clock);
    await auto.configure({ enabled: false, intervalMinutes: 60, window: { follow: 'off-peak' }, holdManual: true, config: null });
    await auto.start();
    await auto.tick();
    assert.deepEqual(jobs.map((j) => j.state), ['encoding', 'waiting'], 'off-peak: both run');
    clock.t = at('2026-10-23T07:00:30');
    await auto.tick();
    assert.deepEqual(jobs.map((j) => j.state), ['paused', 'paused'], 'peak: both paused');
    // the owner resumes one during the peak: it is left running
    jobs[1].state = 'encoding';
    clock.t = at('2026-10-23T09:00:00');
    await auto.tick();
    assert.deepEqual(jobs.map((j) => j.state), ['paused', 'encoding']);
    // the app restarts during the peak, then off-peak starts
    auto.stop();
    auto = makeAuto(dir, service, clock);
    await auto.start();
    await auto.tick(); // the check start() begins
    clock.t = at('2026-10-23T23:00:30');
    await auto.tick();
    assert.deepEqual(jobs.map((j) => j.state), ['encoding', 'encoding'], 'the one it paused is resumed after the restart');
    assert.deepEqual(auto.getState().status.heldManual, []);
    auto.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without a time-of-use plan, off-peak means any time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-offpeak-'));
  try {
    const jobs = [{ id: 'auto1', state: 'encoding', config: { ...config(dir), autoConvert: true } }];
    const service = fakeService(jobs);
    const auto = createAutoConverter({
      service, scanner: async function* () {}, fs: fs.promises, directory: dir,
      timers: { setInterval: () => null, clearInterval: () => {} }, now: () => at('2026-10-23T17:00:00'), isBusy: async () => true,
      isCheapNow: () => null
    });
    await auto.configure({ enabled: true, intervalMinutes: 60, window: { follow: 'off-peak' }, config: config(dir) });
    await auto.start();
    await auto.tick();
    assert.equal(jobs[0].state, 'encoding');
    auto.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
