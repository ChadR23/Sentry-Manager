'use strict';

// Server monitor, when it runs: only while a page watches (15 s after its
// last request) or something needs it (a conversion, a job, a power meter).
// Otherwise no timer and no child process is left behind.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createStats } = require('../server/stats');
const M = require('./fixtures/stats/machines');
const { setup, trackedTimers, fakeSpawn } = require('./fixtures/stats/helpers');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(10);
  }
};

test('nothing runs until a page watches; sampling stops 15 s after the last touch, with no timer left', async () => {
  const timers = trackedTimers();
  const events = [];
  const s = setup(M.intelArc, { timers, options: { intervalMs: 100, onSampling: (on) => events.push(on) } });
  try {
    assert.equal(s.stats.sampling, false);
    assert.equal(timers.live.size, 0, 'creating the engine starts nothing');
    assert.equal(s.stats.snapshot().at, null);
    s.stats.touch();
    assert.equal(s.stats.sampling, true);
    assert.notEqual(s.stats.snapshot().at, null, 'the first sample is taken at once');
    assert.equal(timers.live.size, 1, 'one timer for the next sample, nothing more');
    s.clock.advance(1000);
    await wait(250);
    assert.equal(s.stats.sampling, true, 'still watched');
    s.clock.advance(15000);
    await until(() => !s.stats.sampling);
    assert.equal(timers.live.size, 0, 'no timer left once idle');
    assert.deepEqual(events, [true, false]);
    // a new request wakes it again
    s.stats.touch();
    assert.equal(s.stats.sampling, true);
    s.clock.advance(16000);
    await until(() => !s.stats.sampling);
    assert.equal(timers.live.size, 0);
    assert.deepEqual(events, [true, false, true, false]);
  } finally {
    s.done();
  }
  assert.equal(timers.live.size, 0);
});

test('a running conversion (isBusy) keeps sampling without any page; a marked job does too', async () => {
  const timers = trackedTimers();
  let busy = true;
  const s = setup(M.amd, { appPid: 8, timers, options: { intervalMs: 100, isBusy: () => busy } });
  try {
    s.stats.markJob('job-1'); // the converter started a job: this wakes the sampler
    assert.equal(s.stats.sampling, true);
    s.clock.advance(60000);
    await wait(250);
    assert.equal(s.stats.sampling, true, 'busy and a job: keeps going without a page');
    busy = false;
    await wait(250);
    assert.equal(s.stats.sampling, true, 'the job is still marked');
    s.stats.markJob(null);
    await until(() => !s.stats.sampling);
    assert.equal(timers.live.size, 0);
    // isBusy alone, after a touch has run out
    busy = true;
    s.stats.touch();
    s.clock.advance(20000);
    await wait(250);
    assert.equal(s.stats.sampling, true);
    busy = false;
    await until(() => !s.stats.sampling);
    assert.equal(timers.live.size, 0);
    // an isBusy that throws counts as not busy
    const t2 = trackedTimers();
    const odd = setup(M.amd, { appPid: 8, timers: t2, options: { intervalMs: 100, isBusy: () => { throw new Error('no'); } } });
    odd.stats.touch();
    odd.clock.advance(16000);
    await until(() => !odd.stats.sampling);
    assert.equal(t2.live.size, 0);
    odd.done();
  } finally {
    s.done();
  }
});

test('nvidia-smi runs only while sampling: killed when the page goes away, started again on the next visit', async () => {
  const timers = trackedTimers();
  const spawn = fakeSpawn({ lines: M.NVIDIA_LINES });
  const s = setup(M.nvidia, { appPid: 10, timers, spawn, options: { intervalMs: 100 } });
  try {
    assert.equal(spawn.calls.length, 0, 'nothing started before anyone looks');
    s.stats.touch();
    const smi = () => spawn.calls.filter((c) => c.cmd === 'nvidia-smi');
    assert.equal(smi().length, 1);
    s.clock.advance(16000);
    await until(() => !s.stats.sampling);
    assert.equal(smi()[0].child.killed, 'SIGTERM');
    await wait(20);
    assert.equal(smi().length, 1, 'not restarted after it was stopped');
    assert.equal(timers.live.size, 0, 'no restart timer either');
    s.stats.touch();
    assert.equal(smi().length, 2);
    assert.equal(smi()[1].child.killed, false);
  } finally {
    s.done();
  }
  assert.equal(spawn.calls.filter((c) => c.cmd === 'nvidia-smi')[1].child.killed, 'SIGTERM');
  assert.equal(timers.live.size, 0);
});

test('stop(): idle at once, history saved, later touches ignored', async () => {
  const timers = trackedTimers();
  const dataDir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'sm-stats-stop-'));
  const s = setup(M.pi, { appPid: 20, timers, dataDir, options: { intervalMs: 100 } });
  try {
    s.stats.touch();
    await wait(150);
    s.stats.stop();
    assert.equal(s.stats.sampling, false);
    assert.equal(timers.live.size, 0);
    assert.ok(fs.existsSync(`${dataDir}/stats-history.json`));
    s.stats.touch();
    s.stats.markJob('x');
    assert.equal(s.stats.sampling, false);
    assert.equal(timers.live.size, 0);
  } finally {
    s.done();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('snapshot() never touches the disk', async () => {
  const s = setup(M.intelArc);
  try {
    await s.run(2);
    const saved = { readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, statSync: fs.statSync, readlinkSync: fs.readlinkSync };
    const boom = () => { throw new Error('snapshot() did I/O'); };
    Object.assign(fs, { readFileSync: boom, readdirSync: boom, statSync: boom, readlinkSync: boom });
    let snap;
    try {
      snap = s.stats.snapshot();
      s.stats.history('24h');
      s.stats.csv('15m');
      s.stats.energy();
    } finally {
      Object.assign(fs, saved);
    }
    assert.equal(snap.cpu.usage, 39.3);
  } finally {
    s.done();
  }
});

test('the default engine on this machine starts and stops cleanly with real timers', async () => {
  const stats = createStats({ intervalMs: 100, ffmpegVersion: null, spawn: fakeSpawn() });
  stats.touch();
  await wait(350);
  const snap = stats.snapshot();
  assert.ok(snap.at > 0);
  assert.ok(snap.cpu.usage === null || snap.cpu.usage >= 0);
  stats.stop();
  assert.equal(stats.sampling, false);
});
