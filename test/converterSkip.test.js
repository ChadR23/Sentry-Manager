'use strict';

// Clips that are already H.265 / AV1 are skipped while the job discovers
// files, from the converted-clips index without opening them or else from a
// quick read of their MP4 header, never by a worker with ffprobe (that took
// ~3 s per clip and an encode slot on the owner's 44,000-clip share). Waiting
// and the time remaining then count only clips that will really be converted.
// Also: the live numbers of each running ffmpeg (activeEncodes).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const { createConverterRuntime } = require(path.join(REPO, 'src/main/converter/runtime'));
const { sanitizeSnapshot } = require(path.join(REPO, 'src/main/converter/ipc'));
const { createJobStore } = require(path.join(REPO, 'src/main/converter/jobStore'));
const { scanTeslaFootage } = require(path.join(REPO, 'src/main/converter/scanner'));
const { createPosixOwnedFs } = require(path.join(REPO, 'server/posixOwnedFs'));
const { RETRYABLE } = require(path.join(REPO, 'server/converterHost'));
const { createTeslaH264Fixture } = require('./fixtures/ffmpegFixtures');

const HELPER = path.join(REPO, 'build', 'noreplace-rename');
const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString() || '';
const skip = /\slibx265\s/.test(encoders) && fs.existsSync(HELPER) ? false : 'needs ffmpeg with libx265 and build/noreplace-rename';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One original (Tesla-style H.264) and one converted clip (H.265, as the
// converter writes it: hvc1, moov at the end), copied as often as needed.
let samples = null;
async function sampleClips() {
  if (samples) return samples;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-skip-fx-'));
  const original = path.join(dir, 'original.mp4');
  await createTeslaH264Fixture({
    ffmpegPath: 'ffmpeg', outputPath: original, durationSeconds: 4, frameRate: 12, size: '320x240', spatialNoise: 4,
    telemetryPattern: Array.from({ length: 48 }, (_, n) => Buffer.from([0x20, n]))
  });
  const converted = path.join(dir, 'converted.mp4');
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=12:duration=1',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', converted]);
  assert.strictEqual(made.status, 0, made.stderr?.toString());
  samples = { dir, original, converted };
  return samples;
}

const stamp = (n) => new Date(Date.UTC(2025, 0, 1) + n * 60_000).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');

// The runtime as server/converterHost.js composes it, with every spawned
// process and every file opened recorded.
async function openRuntime(base, { ffmpegPath = 'ffmpeg' } = {}) {
  const record = { spawned: [], opened: [] };
  const pfs = Object.create(fs.promises);
  pfs.open = async (p, ...rest) => { record.opened.push(String(p)); return fs.promises.open(p, ...rest); };
  const wrappedFs = Object.create(fs);
  Object.defineProperty(wrappedFs, 'promises', { value: pfs });
  process.env.SENTRY_NOREPLACE_RENAME = HELPER;
  const owned = createPosixOwnedFs();
  const runtime = await createConverterRuntime({
    userDataPath: fs.realpathSync(path.join(base, 'data')),
    tempPath: fs.realpathSync(path.join(base, 'temp')),
    ffmpegPath, ffprobePath: 'ffprobe', fs: wrappedFs, pathApi: path, platform: process.platform,
    spawn: (command, args, options) => {
      const child = spawn(command, args, options);
      record.spawned.push({ command, args, pid: child.pid });
      return child;
    },
    removeOwned: owned.removeOwned, renameExclusive: owned.renameExclusive, autoConvert: false, gpuDecode: false,
    network: {
      isRetryable: (error) => RETRYABLE.has(error?.code),
      checkPath: async (target) => fs.promises.access(target).then(() => true, () => false)
    }
  });
  await runtime.start();
  return { runtime, record };
}

function makeBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-skip-'));
  for (const dir of ['data', 'temp', 'footage/TeslaCam/RecentClips']) fs.mkdirSync(path.join(base, dir), { recursive: true });
  return { base, root: fs.realpathSync(path.join(base, 'footage', 'TeslaCam')) };
}

function jobConfig(root, { outputMode = 'replace', concurrency = 1, destinationRoot = null } = {}) {
  return {
    sourceRoot: root, destinationRoot: outputMode === 'replace' ? null : destinationRoot,
    codec: 'h265', profileId: 'custom', bitrateKbps: 250, networkMode: 'direct', outputMode,
    includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'], groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'],
    replacementConfirmed: outputMode === 'replace', concurrency, verifyMode: 'quick'
  };
}

async function settle(runtime, jobId, ms = 120_000) {
  let timer;
  const ended = await Promise.race([
    runtime.service.whenIdle(jobId).then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })
  ]);
  clearTimeout(timer);
  const job = await runtime.service.get(jobId);
  if (!ended) {
    await runtime.service.cancel(jobId).catch(() => {});
    assert.fail(`job did not end on its own: ${job.state}`);
  }
  return job;
}

const touches = (record, paths) => {
  const set = new Set(paths);
  return {
    spawned: record.spawned.filter((entry) => entry.args.some((arg) => set.has(arg))),
    opened: record.opened.filter((entry) => set.has(entry))
  };
};

test('20,000 converted clips and 100 originals: every skip happens while discovering, the encode slot only sees originals', { skip, timeout: 300_000 }, async () => {
  const { base, root } = makeBase();
  const { original, converted } = await sampleClips();
  const recent = path.join(root, 'RecentClips');
  const originals = [];
  const convertedClips = [];
  for (let n = 0; n < 20_100; n += 1) {
    const file = path.join(recent, `${stamp(n)}-front.mp4`);
    // the originals are spread through the converted ones, as after a run that was stopped
    if (n % 201 === 100) { fs.copyFileSync(original, file); originals.push(file); } else { fs.copyFileSync(converted, file); convertedClips.push(file); }
  }
  const env = await openRuntime(base);
  try {
    const started = Date.now();
    const jobId = await env.runtime.service.start(jobConfig(root, { outputMode: 'separate', destinationRoot: path.join(base, 'out') }));
    // The worker parks after at most one clip; discovery goes on.
    await env.runtime.service.pause(jobId);
    let job;
    for (let i = 0; i < 2400; i += 1) {
      job = await env.runtime.service.get(jobId);
      if (job.discoveryComplete) break;
      await sleep(100);
    }
    const seconds = (Date.now() - started) / 1000;
    assert.strictEqual(job.discoveryComplete, true, `discovery stopped at ${job.items.length} clips`);
    assert.ok(seconds < 120, `discovery took ${seconds} s`);
    const skipped = job.items.filter((item) => item.state === 'skipped');
    assert.strictEqual(skipped.length, convertedClips.length);
    assert.ok(skipped.every((item) => item.resultCode === 'already-converted' && item.eligibleVideo === false));
    assert.deepStrictEqual(new Set(skipped.map((item) => item.sourcePath)), new Set(convertedClips));
    const toConvert = job.items.filter((item) => item.state !== 'skipped');
    assert.deepStrictEqual(toConvert.map((item) => item.sourcePath).sort(), [...originals].sort());
    assert.ok(job.items.every((item) => !('ino' in item)), 'the job file keeps no inode');
    // What the Encoder page shows: waiting counts only the originals.
    const counts = sanitizeSnapshot(job).itemStateCounts;
    assert.strictEqual(counts.skipped, convertedClips.length);
    assert.strictEqual(counts.queued + counts.active + counts.completed + counts.failed, originals.length);
    assert.ok(counts.queued >= originals.length - 1, `waiting ${counts.queued}`);
    // No ffprobe or ffmpeg ever saw a converted clip; each was opened once,
    // for its header.
    const seen = touches(env.record, convertedClips);
    assert.strictEqual(seen.spawned.length, 0, 'no process for a converted clip');
    assert.strictEqual(seen.opened.length, convertedClips.length);
    await env.runtime.service.cancel(jobId);
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('converted clips are remembered: the next run skips every clip without opening one', { skip, timeout: 300_000 }, async () => {
  const { base, root } = makeBase();
  const { original, converted } = await sampleClips();
  const recent = path.join(root, 'RecentClips');
  const originals = [];
  const convertedClips = [];
  for (let n = 0; n < 33; n += 1) {
    const file = path.join(recent, `${stamp(n)}-front.mp4`);
    if (n % 11 === 5) { fs.copyFileSync(original, file); originals.push(file); } else { fs.copyFileSync(converted, file); convertedClips.push(file); }
  }
  let env = await openRuntime(base);
  try {
    let jobId = await env.runtime.service.start(jobConfig(root, { concurrency: 2 }));
    let job = await settle(env.runtime, jobId);
    assert.strictEqual(job.state, 'completed');
    assert.deepStrictEqual(job.items.filter((item) => item.resultCode === 'converted').map((item) => item.sourcePath).sort(), [...originals].sort());
    assert.strictEqual(job.items.filter((item) => item.resultCode === 'already-converted').length, convertedClips.length);
    assert.strictEqual(touches(env.record, convertedClips).spawned.length, 0, 'no ffprobe for a converted clip');
    assert.ok(fs.existsSync(path.join(base, 'data', 'converter-index', 'converted-clips.json')));

    // An app restart (an update), then a new run over the same footage. One
    // converted clip was touched since: it alone is looked at again.
    await env.runtime.shutdown();
    const changed = convertedClips[3];
    fs.utimesSync(changed, new Date(), new Date(Date.UTC(2026, 0, 1)));
    env = await openRuntime(base);
    jobId = await env.runtime.service.start(jobConfig(root, { concurrency: 2 }));
    job = await settle(env.runtime, jobId);
    assert.strictEqual(job.state, 'completed');
    assert.strictEqual(job.items.length, originals.length + convertedClips.length);
    assert.ok(job.items.every((item) => item.state === 'skipped' && item.resultCode === 'already-converted'),
      'the clips converted by the first run are known as converted too');
    const seen = touches(env.record, [...originals, ...convertedClips]);
    assert.strictEqual(seen.spawned.length, 0, 'no process at all for a known clip');
    assert.deepStrictEqual(seen.opened, [changed], 'only the clip that changed was opened (its header)');
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a job saved mid-discovery before this update resumes; its old queued clips take the worker path and are remembered too', { skip, timeout: 300_000 }, async () => {
  const { base, root } = makeBase();
  const { original, converted } = await sampleClips();
  const recent = path.join(root, 'RecentClips');
  const originals = [];
  const convertedClips = [];
  for (let n = 0; n < 8; n += 1) {
    const file = path.join(recent, `${stamp(n)}-front.mp4`);
    if (n === 1 || n === 6) { fs.copyFileSync(original, file); originals.push(file); } else { fs.copyFileSync(converted, file); convertedClips.push(file); }
  }
  // The job file an older version left behind when it stopped half way
  // through discovery: the first four clips found and queued as they were
  // (converted or not), no inode, no index.
  const found = [];
  for await (const item of scanTeslaFootage({ sourceRoot: root })) found.push(item);
  const config = jobConfig(root, { concurrency: 2 });
  const store = createJobStore({ rootDir: path.join(base, 'data', 'converter-jobs'), fs: fs.promises });
  const old = await store.create({
    state: 'discovering', createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000, config, discoveryComplete: false,
    items: found.slice(0, 4).map(({ ino, ...item }, index) => ({ ...item, id: `item-${String(index + 1).padStart(6, '0')}`, state: 'queued', attempts: 0 }))
  });
  const oldClips = found.slice(0, 4).map((item) => item.sourcePath);
  const env = await openRuntime(base);
  let next = null;
  try {
    let job = await settle(env.runtime, old.id);
    assert.strictEqual(job.state, 'completed');
    assert.strictEqual(job.items.length, 8, 'discovery finished the other four');
    assert.deepStrictEqual(job.items.filter((item) => item.resultCode === 'converted').map((item) => item.sourcePath).sort(), [...originals].sort());
    assert.deepStrictEqual(job.items.filter((item) => item.resultCode === 'already-converted').map((item) => item.sourcePath).sort(), [...convertedClips].sort());
    // the old queued converted clips were probed by a worker, as before; the
    // ones found after the update were not
    const probed = touches(env.record, convertedClips).spawned.map((entry) => entry.args.at(-1));
    assert.deepStrictEqual(probed.sort(), convertedClips.filter((file) => oldClips.includes(file)).sort());
    await env.runtime.shutdown();
    // all of them are remembered now: a new run opens none
    next = await openRuntime(base);
    const jobId = await next.runtime.service.start(config);
    job = await settle(next.runtime, jobId);
    assert.ok(job.items.every((item) => item.resultCode === 'already-converted'));
    const seen = touches(next.record, [...originals, ...convertedClips]);
    assert.deepStrictEqual([seen.spawned.length, seen.opened.length], [0, 0]);
  } finally {
    await env.runtime.shutdown().catch(() => {});
    await next?.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('activeEncodes reports each running ffmpeg with its live numbers', { skip, timeout: 120_000 }, async () => {
  const { base, root } = makeBase();
  const { original } = await sampleClips();
  const clip = path.join(root, 'RecentClips', `${stamp(0)}-front.mp4`);
  fs.copyFileSync(original, clip);
  // An encode at the clip's own pace that reports often, so it can be watched.
  const wrapper = path.join(base, 'ffmpeg');
  fs.writeFileSync(wrapper, '#!/bin/sh\ncase "$*" in *"pipe:1 -nostats -f mp4"*) exec ffmpeg -re -stats_period 0.2 "$@";; esac\nexec ffmpeg "$@"\n', { mode: 0o755 });
  const env = await openRuntime(base, { ffmpegPath: wrapper });
  try {
    assert.deepStrictEqual(env.runtime.activeEncodes(), []);
    const jobId = await env.runtime.service.start(jobConfig(root));
    let live = null;
    for (let i = 0; i < 600 && !live; i += 1) {
      live = env.runtime.activeEncodes().find((entry) => entry.frame > 0 && entry.outTimeUs > 0 && entry.fps !== null) || null;
      if (!live) await sleep(50);
    }
    assert.ok(live, 'a running encode showed its progress');
    assert.deepStrictEqual(Object.keys(live).sort(), [
      'bitrateKbps', 'decode', 'device', 'deviceId', 'dropFrames', 'dupFrames', 'durationUs', 'encoder', 'fps', 'frame',
      'hardware', 'itemId', 'jobId', 'outTimeUs', 'pid', 'relativePath', 'speed', 'totalSizeB'
    ]);
    assert.strictEqual(live.deviceId, null, 'a job without lanes runs on no lane');
    const job = await env.runtime.service.get(jobId);
    assert.strictEqual(live.jobId, jobId);
    assert.strictEqual(live.itemId, job.items[0].id);
    assert.strictEqual(live.relativePath, `RecentClips/${stamp(0)}-front.mp4`);
    assert.strictEqual(typeof live.encoder, 'string');
    assert.strictEqual(live.hardware, live.encoder !== 'libx265');
    assert.strictEqual(live.decode, 'cpu', 'GPU decoding is off here');
    assert.ok(live.device === null || live.device.startsWith('/dev/'));
    const encodes = env.record.spawned.filter((entry) => entry.args.includes('pipe:1') && entry.args.includes('mp4'));
    assert.ok(encodes.some((entry) => entry.pid === live.pid), 'pid of the ffmpeg that encodes it');
    assert.ok(Math.abs(live.durationUs - 4_000_000) < 500_000, `duration ${live.durationUs}`);
    assert.ok(Number.isSafeInteger(live.frame) && live.frame <= 48);
    assert.ok(live.speed === null || (live.speed > 0 && live.speed < 50), `speed ${live.speed}`);
    assert.ok(live.bitrateKbps === null || live.bitrateKbps >= 0);
    assert.ok(Number.isSafeInteger(live.dropFrames) && Number.isSafeInteger(live.dupFrames));
    assert.ok(live.totalSizeB === null || Number.isSafeInteger(live.totalSizeB));
    // a copy: changing it changes nothing inside the converter
    live.fps = -1;
    assert.notStrictEqual(env.runtime.service.activeEncodes()[0]?.fps, -1);
    const done = await settle(env.runtime, jobId);
    assert.strictEqual(done.items[0].resultCode, 'converted');
    assert.deepStrictEqual(env.runtime.activeEncodes(), [], 'nothing listed once ffmpeg is done');
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test.after(() => { if (samples) fs.rmSync(samples.dir, { recursive: true, force: true }); });
