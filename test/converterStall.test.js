'use strict';

// A long conversion must never freeze with clips left in the queue (seen on a
// 12,162-clip job: one clip "converting", nothing encoding, only Cancel
// helped). Each case drives the real converter on small Tesla-style clips.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const { createConverterRuntime } = require(path.join(REPO, 'src/main/converter/runtime'));
const { scanTeslaFootage } = require(path.join(REPO, 'src/main/converter/scanner'));
const { createAutoConverter } = require(path.join(REPO, 'src/main/converter/autoConvert'));
const { createPosixOwnedFs } = require(path.join(REPO, 'server/posixOwnedFs'));
const { RETRYABLE } = require(path.join(REPO, 'server/converterHost'));

const HELPER = path.join(REPO, 'build', 'noreplace-rename');
const canConvert = spawnSync('ffmpeg', ['-version']).status === 0 && fs.existsSync(HELPER);
const skip = canConvert ? false : 'needs ffmpeg and build/noreplace-rename';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let fixtures = null;
async function fixtureClips() {
  if (fixtures) return fixtures;
  const { createTeslaH264Fixture } = require(path.join(REPO, 'test/fixtures/ffmpegFixtures'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-stall-fx-'));
  fixtures = [];
  for (let i = 0; i < 2; i++) {
    const file = path.join(dir, `base${i}.mp4`);
    await createTeslaH264Fixture({
      ffmpegPath: 'ffmpeg', outputPath: file, durationSeconds: 2, frameRate: 12, size: '320x240', spatialNoise: 4 + i,
      telemetryPattern: Array.from({ length: 24 }, (_, n) => Buffer.from([0x20, n]))
    });
    fixtures.push(file);
  }
  return fixtures;
}

// The runtime as server/converterHost.js composes it, with an fs whose reads
// a test can intercept (to make a clip vanish or the share go down).
async function setup({ concurrency = 2, outputMode = 'replace', events = 2, ffmpegPath = 'ffmpeg', encodeStallMs } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-stall-'));
  const root = path.join(base, 'footage', 'TeslaCam');
  const clips = [];
  fs.mkdirSync(root, { recursive: true });
  const base0 = await fixtureClips();
  for (let e = 0; e < events; e++) {
    const event = path.join(root, 'SentryClips', `2026-10-20_07-${44 + e}-14`);
    fs.mkdirSync(event, { recursive: true });
    for (const [c, cam] of ['front', 'back'].entries()) {
      const file = path.join(event, `2026-10-20_07-${43 + e}-00-${cam}.mp4`);
      fs.copyFileSync(base0[(e + c) % 2], file);
      clips.push(file);
    }
  }
  const hooks = { readFile: null, access: null, rename: null };
  const pfs = Object.create(fs.promises);
  pfs.readFile = async (p, ...a) => { await hooks.readFile?.(String(p)); return fs.promises.readFile(p, ...a); };
  pfs.access = async (p, ...a) => { await hooks.access?.(String(p)); return fs.promises.access(p, ...a); };
  const wrappedFs = Object.create(fs);
  Object.defineProperty(wrappedFs, 'promises', { value: pfs });
  const network = {
    isRetryable: (error) => RETRYABLE.has(error?.code),
    checkPath: async (target, options = {}) => {
      let probe = path.resolve(target);
      for (;;) {
        try { await pfs.access(probe); return true; } catch (error) {
          if (error?.code !== 'ENOENT' || options.allowAncestor !== true) return false;
          if (path.dirname(probe) === probe) return false;
          probe = path.dirname(probe);
        }
      }
    }
  };
  process.env.SENTRY_NOREPLACE_RENAME = HELPER;
  const owned = createPosixOwnedFs();
  for (const d of ['data', 'temp']) fs.mkdirSync(path.join(base, d));
  const runtime = await createConverterRuntime({
    userDataPath: fs.realpathSync(path.join(base, 'data')),
    tempPath: fs.realpathSync(path.join(base, 'temp')),
    ffmpegPath, ffprobePath: 'ffprobe', spawn, fs: wrappedFs, pathApi: path, platform: process.platform,
    removeOwned: owned.removeOwned, network, autoConvert: false,
    // the same helper; a test can step in just before a clip replaces its original
    renameExclusive: Object.assign((...args) => owned.renameExclusive(...args), owned.renameExclusive, {
      promote: async (...args) => { await hooks.rename?.(...args); return owned.renameExclusive.promote(...args); }
    }),
    gpuDecode: false, encodeStallMs,
    networkBackoff: { initialMs: 50, maximumMs: 200 }
  });
  await runtime.start();
  const sourceRoot = fs.realpathSync(root);
  const config = {
    sourceRoot,
    destinationRoot: outputMode === 'replace' ? null : path.join(base, 'out'),
    codec: 'h265', profileId: 'custom', bitrateKbps: 250, networkMode: 'direct', outputMode,
    includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'], groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'],
    replacementConfirmed: outputMode === 'replace', concurrency, verifyMode: 'quick'
  };
  return { base, runtime, hooks, config, sourceRoot, clips: clips.map((c) => fs.realpathSync(c)).sort() };
}

// Resolves with the job once it ends on its own; fails the test if it does not.
async function settle(runtime, jobId, ms = 60_000) {
  let timer;
  const ended = await Promise.race([
    runtime.service.whenIdle(jobId).then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })
  ]);
  clearTimeout(timer);
  const job = await runtime.service.get(jobId);
  if (!ended) {
    await runtime.service.cancel(jobId).catch(() => {});
    assert.fail(`job did not end on its own: ${job.state}, ${job.items.filter((i) => i.state === 'processing').length} clip(s) processing`);
  }
  return job;
}

const count = (job, state) => job.items.filter((i) => i.state === state && /\.mp4$/.test(i.relativePath)).length;

test('a clip moved away mid-job fails on its own while a pause settles', { skip, timeout: 120_000 }, async () => {
  const env = await setup({ concurrency: 2, events: 3 });
  try {
    const victim = env.clips[1];
    let jobId;
    // Gone right after the converter looked at it, as when a retention policy
    // or "Delete through this date" moves it to the Recycle Bin.
    env.hooks.readFile = async (p) => {
      if (p !== victim || !fs.existsSync(victim)) return;
      fs.renameSync(victim, `${victim}.binned`);
      setTimeout(() => env.runtime.service.pause(jobId), 100); // as the automatic window does
    };
    jobId = await env.runtime.service.start(env.config);
    let job;
    for (let i = 0; i < 300; i++) {
      job = await env.runtime.service.get(jobId);
      if (job.state === 'paused') break;
      await sleep(100);
    }
    assert.strictEqual(job.state, 'paused', 'the pause took effect');
    assert.strictEqual(job.items.find((i) => i.sourcePath === victim).failure?.code, 'source-missing');
    assert.strictEqual(count(job, 'processing'), 0);
    await env.runtime.service.resume(jobId);
    job = await settle(env.runtime, jobId);
    assert.strictEqual(job.state, 'completed');
    assert.strictEqual(count(job, 'completed'), env.clips.length - 1);
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});

test('the window reopening while a clip is being replaced resumes the job', { skip, timeout: 120_000 }, async () => {
  const env = await setup({ concurrency: 2, events: 2 });
  try {
    let jobId;
    let resumed = null;
    // The automatic window closes and reopens while a clip is mid-replacement.
    env.hooks.rename = async () => {
      if (resumed) return;
      resumed = (async () => {
        await env.runtime.service.pause(jobId);
        return env.runtime.service.resume(jobId);
      })();
      await resumed.catch(() => {});
    };
    jobId = await env.runtime.service.start(env.config);
    const job = await settle(env.runtime, jobId);
    await assert.doesNotReject(resumed, 'resume was accepted mid-replacement');
    assert.strictEqual(job.state, 'completed');
    assert.strictEqual(count(job, 'completed'), env.clips.length);
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});

test('a share outage on one worker while another saves is waited out', { skip, timeout: 120_000 }, async () => {
  const env = await setup({ concurrency: 2, outputMode: 'separate', events: 2 });
  try {
    const victim = env.clips[0];
    let downUntil = 0;
    const down = (p) => {
      if (Date.now() < downUntil && p.startsWith(env.sourceRoot)) throw Object.assign(new Error('EHOSTDOWN'), { code: 'EHOSTDOWN', path: p });
    };
    // The first clip's read starts a 3 s outage once the second worker has its
    // clip; that worker then saves while the first waits.
    env.hooks.readFile = async (p) => {
      if (p === victim && downUntil === 0) { await sleep(1000); downUntil = Date.now() + 3000; }
      down(p);
    };
    env.hooks.access = async (p) => down(p);
    const jobId = await env.runtime.service.start(env.config);
    const job = await settle(env.runtime, jobId);
    assert.strictEqual(job.state, 'completed');
    assert.strictEqual(count(job, 'completed'), env.clips.length, 'nothing failed: the outage was waited out');
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});

test('a share that drops to its empty mount folder is waited for, not read as deleted clips', { skip, timeout: 120_000 }, async () => {
  const env = await setup({ concurrency: 2, events: 2 });
  try {
    const victim = env.clips[0];
    let downUntil = 0;
    // An unmounted share: its top folder is still there (the empty mount
    // folder), everything below it is not.
    const gone = (p) => {
      if (Date.now() < downUntil && p.startsWith(`${env.sourceRoot}${path.sep}`)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: p });
      }
    };
    env.hooks.readFile = async (p) => {
      if (p === victim && downUntil === 0) downUntil = Date.now() + 3000;
      gone(p);
    };
    env.hooks.access = async (p) => gone(p);
    const jobId = await env.runtime.service.start(env.config);
    const job = await settle(env.runtime, jobId);
    assert.strictEqual(job.state, 'completed');
    assert.strictEqual(count(job, 'completed'), env.clips.length, 'no clip failed as missing');
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});

test('a frozen encode is stopped and the job goes on', { skip, timeout: 120_000 }, async () => {
  // An ffmpeg that never reports progress for one clip, as with a hung GPU.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-stall-ff-'));
  const wrapper = path.join(dir, 'ffmpeg');
  fs.writeFileSync(wrapper, '#!/bin/sh\ncase "$*" in *-43-00-front*pipe:1*) exec sleep 600;; esac\nexec ffmpeg "$@"\n', { mode: 0o755 });
  const env = await setup({ concurrency: 2, events: 2, ffmpegPath: wrapper, encodeStallMs: 2000 });
  try {
    const jobId = await env.runtime.service.start(env.config);
    const job = await settle(env.runtime, jobId);
    assert.strictEqual(job.state, 'completed');
    const frozen = job.items.find((i) => i.relativePath.endsWith('-43-00-front.mp4'));
    assert.strictEqual(frozen.state, 'failed');
    assert.strictEqual(count(job, 'completed'), env.clips.length - 1);
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(env.base, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery finds every clip past 10,000, so the time remaining covers them all', { skip, timeout: 180_000 }, async () => {
  const env = await setup({ concurrency: 1, outputMode: 'separate', events: 0 });
  try {
    const recent = path.join(env.sourceRoot, 'RecentClips');
    fs.mkdirSync(recent, { recursive: true });
    const total = 10_050;
    for (let n = 0; n < total; n++) {
      const stamp = new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
      fs.writeFileSync(path.join(recent, `${stamp}-front.mp4`), 'x');
    }
    const jobId = await env.runtime.service.start(env.config);
    await env.runtime.service.pause(jobId); // the workers stop; discovery must not
    let job;
    for (let i = 0; i < 600; i++) {
      job = await env.runtime.service.get(jobId);
      if (job.discoveryComplete) break;
      await sleep(100);
    }
    assert.strictEqual(job.discoveryComplete, true, `discovery stopped at ${job.items.length} clips`);
    assert.strictEqual(job.items.length, total);
    await env.runtime.service.cancel(jobId);
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});

test('the scan skips a folder deleted while it runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-stall-scan-'));
  const teslacam = path.join(root, 'TeslaCam');
  for (const event of ['2026-10-20_07-44-14', '2026-10-20_07-45-14']) {
    fs.mkdirSync(path.join(teslacam, 'SentryClips', event), { recursive: true });
    fs.writeFileSync(path.join(teslacam, 'SentryClips', event, `${event.slice(0, 11)}07-43-00-front.mp4`), 'x');
  }
  try {
    for (const concurrency of [1, 4]) {
      const gone = path.join(teslacam, 'SentryClips', '2026-10-20_07-44-14');
      const found = [];
      for await (const item of scanTeslaFootage({ sourceRoot: teslacam }, {
        concurrency,
        // Listed, then moved to the Recycle Bin before it is opened.
        opendir: async (p) => {
          if (p === gone) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: p });
          return fs.promises.opendir(p);
        }
      })) found.push(item.relativePath);
      assert.deepStrictEqual(found, ['SentryClips/2026-10-20_07-45-14/2026-10-20_07-43-00-front.mp4'], `concurrency ${concurrency}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the automatic window resumes a pause that has not settled yet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-stall-auto-'));
  let hour = 12;
  const calls = [];
  // An automatic job whose pause still waits on a worker: it reads as working.
  const job = { id: 'job-1', state: 'encoding', config: { autoConvert: true, sourceRoot: dir } };
  const service = {
    list: async () => [job],
    get: async () => job,
    pause: async () => { calls.push('pause'); },
    resume: async () => { calls.push('resume'); }
  };
  const auto = createAutoConverter({
    service, scanner: async function* () {}, fs: fs.promises, directory: dir,
    hourOf: () => hour, timers: { setInterval: () => null, clearInterval: () => {} }
  });
  try {
    await auto.start();
    await auto.configure({ enabled: true, intervalMinutes: 60, window: { startHour: 22, endHour: 6 }, config: { sourceRoot: dir } });
    await auto.tick();
    await auto.tick();
    assert.deepStrictEqual(calls, ['pause'], 'outside the window the job is paused');
    hour = 23;
    await auto.tick();
    assert.deepStrictEqual(calls, ['pause', 'resume'], 'back inside the window it is resumed, settled or not');
    assert.strictEqual(auto.getState().status.pausedForWindow, false);
  } finally {
    auto.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
