'use strict';

// Smallest (CPU only): libx265 on this server's CPU at CRF 27 (veryfast), peaks
// capped at 60% of each clip's own bitrate, with B-frames. H.265 only. Its
// frames are shown at the original's times, each with its own telemetry.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const { buildEncodeArgs } = require(path.join(REPO, 'src/main/converter/encoderPlanner'));
const { smallestMaxrate, hasSizeTarget } = require(path.join(REPO, 'src/main/converter/contracts'));
const { extractH264TelemetryTimeline, mapTimelineToOutput } = require(path.join(REPO, 'src/main/converter/telemetryTimeline'));
const { injectH265Telemetry, inspectH265Telemetry } = require(path.join(REPO, 'src/main/converter/h265Telemetry'));
const { outputTiming } = require(path.join(REPO, 'src/main/converter/converterAdapters'));
const { createConverterRuntime } = require(path.join(REPO, 'src/main/converter/runtime'));
const { createPosixOwnedFs } = require(path.join(REPO, 'server/posixOwnedFs'));
const { RETRYABLE } = require(path.join(REPO, 'server/converterHost'));
const { Telemetry } = require(path.join(REPO, 'server/telemetry'));
const { readSpeeds } = require(path.join(REPO, 'server/speedReader'));
const { createTeslaH264Fixture, createMidGopTeslaH264Fixture, runProcess } = require('./fixtures/ffmpegFixtures');
const { createHarness, ARC, UHD, CPU } = require('./fixtures/lanesHarness');

const HELPER = process.env.SENTRY_NOREPLACE_RENAME || path.join(REPO, 'build', 'noreplace-rename');
const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString() || '';
const has = (name) => new RegExp(`\\s${name}\\s`).test(encoders);
const needsFfmpeg = has('libx264') && has('libx265') ? false : 'needs ffmpeg with libx264 and libx265';
const needsRuntime = needsFfmpeg || (fs.existsSync(HELPER) ? false : 'needs build/noreplace-rename');

const TAIL = ['-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-preset', 'veryfast'];

test('arguments: CRF 27 veryfast with B-frames, peaks capped, frames shown at the original times', () => {
  assert.deepEqual(buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: null, smallest: { maxrate: 3_000_000 } }), [
    '-c:v', 'libx265', '-crf', '27', '-maxrate', '3000000', '-bufsize', '6000000', ...TAIL,
    '-tag:v', 'hvc1', '-fps_mode', 'passthrough', '-enc_time_base', 'demux', '-start_at_zero', '-use_editlist', '0', '-movflags', '+negative_cts_offsets'
  ]);
  // no known bitrate: no cap; CPU_ENCODER_PRESET does not change it
  assert.deepEqual(buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: null, cpuPreset: 'faster', smallest: { maxrate: null } }), [
    '-c:v', 'libx265', '-crf', '27', ...TAIL,
    '-tag:v', 'hvc1', '-fps_mode', 'passthrough', '-enc_time_base', 'demux', '-start_at_zero', '-use_editlist', '0', '-movflags', '+negative_cts_offsets'
  ]);
  // a retry under the original's bitrate: that bitrate, still B-frames
  assert.deepEqual(buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: 2_000_000.4, smallest: { maxrate: 3_000_000 } }), [
    '-c:v', 'libx265', '-b:v', '2000000', ...TAIL,
    '-tag:v', 'hvc1', '-fps_mode', 'passthrough', '-enc_time_base', 'demux', '-start_at_zero', '-use_editlist', '0', '-movflags', '+negative_cts_offsets'
  ]);
  // a clip given back the original's timing keeps its frame order
  assert.deepEqual(buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: null, holdFrames: 3, smallest: { maxrate: 3_000_000 }, keepOrder: true }), [
    '-vf', 'tpad=start=3:start_mode=clone', '-c:v', 'libx265', '-crf', '27', '-maxrate', '3000000', '-bufsize', '6000000', ...TAIL, '-bf', '0',
    '-tag:v', 'hvc1', '-fps_mode', 'passthrough', '-start_at_zero', '-avoid_negative_ts', 'make_zero', '-use_editlist', '0'
  ]);
  // every other profile is as before
  const plain = buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: 2_000_000 });
  assert.ok(plain.includes('-bf') && plain.includes('make_zero') && !plain.includes('-movflags') && !plain.includes('-crf'));
});

test('arguments: only libx265 without a quality level, with a positive peak', () => {
  const bad = [
    { codec: 'av1', encoder: 'libsvtav1' },
    { codec: 'h265', encoder: 'hevc_vaapi' },
    { codec: 'h265', encoder: 'libx265', quality: 'small' },
    { codec: 'h265', encoder: 'libx265', smallest: { maxrate: 0 } },
    { codec: 'h265', encoder: 'libx265', smallest: { maxrate: 1.5 } },
    { codec: 'h265', encoder: 'libx265', bitrate: 0 }
  ];
  for (const over of bad) {
    assert.throws(() => buildEncodeArgs({ bitrate: null, smallest: { maxrate: 3_000_000 }, ...over }), RangeError, JSON.stringify(over));
  }
});

test('the peak is 60% of the clip\'s own average bitrate; no size target', () => {
  assert.equal(smallestMaxrate(4_000_000, 2), 9_600_000);
  assert.equal(smallestMaxrate(37_500_000, 60.03), 2_998_500);
  for (const [bytes, seconds] of [[0, 2], [4_000_000, 0], [Number.NaN, 2], [4_000_000, Number.NaN], [1, 1e9], [1e300, 1e-300]]) {
    assert.equal(smallestMaxrate(bytes, seconds), null, `${bytes} B in ${seconds} s`);
  }
  assert.equal(hasSizeTarget('smallest'), false);
});

test('IPC: H.265 only, no size-target option, the benchmark measures H.265 alone', async () => {
  const { registerConverterIpc } = require(path.join(REPO, 'src/main/converter/ipc'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-smallest-ipc-'));
  for (const name of ['source', 'out']) fs.mkdirSync(path.join(dir, name));
  const handlers = new Map();
  const started = [];
  const benchmarks = [];
  const registration = registerConverterIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    service: { subscribe: () => () => {}, start: async (config) => { started.push(config); return 'job-1'; }, list: async () => [] },
    capabilities: { replacement: 'available' },
    auto: { configure: async (settings) => ({ settings }) },
    benchmark: { run: async (request) => { benchmarks.push(request); return {}; }, cancel: () => {} },
    // a GPU that cannot encode H.265
    devices: async () => ({ devices: [{ id: 'pci:0000:01:00.0', name: 'Old GPU', encoders: { h265: null, av1: null } }] })
  });
  const invoke = (name, payload) => handlers.get(`converter:${name}`)({ sender: null }, payload);
  const config = (over = {}) => ({
    sourceRoot: path.join(dir, 'source'), destinationRoot: path.join(dir, 'out'), codec: 'h265', profileId: 'smallest',
    networkMode: 'direct', outputMode: 'separate', includedGroups: ['RecentClips'], replacementConfirmed: false, ...over
  });
  try {
    assert.equal((await invoke('start', config())).ok, true);
    assert.equal(started.at(-1).profileId, 'smallest');
    assert.equal((await invoke('start', config({ keepLarger: true }))).ok, true);
    // it has no lanes: they become their total, so a GPU row that cannot encode H.265 does not stop it
    const lanes = [{ device: 'pci:0000:01:00.0', concurrency: 1 }, { device: 'cpu', concurrency: 2 }];
    assert.equal((await invoke('start', config({ lanes }))).ok, true);
    assert.deepEqual(['lanes' in started.at(-1), started.at(-1).concurrency], [false, 3]);
    const saved = await invoke('setAuto', { enabled: true, intervalMinutes: 60, window: null, keepRunning: false, openAtLogin: false, config: config({ lanes }) });
    assert.deepEqual(['lanes' in saved.value.settings.config, saved.value.settings.config.concurrency], [false, 3]);
    assert.equal((await invoke('start', config({ profileId: 'quality', qualityLevel: 'small', lanes }))).error?.code, 'DEVICE_UNSUPPORTED');
    for (const [bad, code] of [
      [config({ codec: 'av1' }), 'INVALID_CODEC'],
      [config({ keepOffTarget: true }), 'INVALID_KEEP_OFF_TARGET'],
      [config({ qualityLevel: 'small' }), 'INVALID_QUALITY'],
      [config({ bitrateKbps: 2500 }), 'INVALID_BITRATE']
    ]) assert.equal((await invoke('start', bad)).error?.code, code, JSON.stringify(bad));
    const auto = (c) => invoke('setAuto', { enabled: true, intervalMinutes: 60, window: null, keepRunning: false, openAtLogin: false, config: c });
    assert.equal((await auto(config({ codec: 'av1' }))).error?.code, 'INVALID_CODEC');
    assert.equal((await invoke('runBenchmark', { codecs: ['h265', 'av1'], profileId: 'smallest' })).error?.code, 'INVALID_CODEC');
    assert.equal((await invoke('runBenchmark', { codec: 'av1', profileId: 'smallest' })).error?.code, 'INVALID_CODEC');
    assert.equal((await invoke('runBenchmark', { codecs: ['h265'], profileId: 'smallest' })).ok, true);
    assert.deepEqual([benchmarks.length, benchmarks[0].profileId, benchmarks[0].codecs], [1, 'smallest', ['h265']]);
  } finally {
    registration.unregister();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a job encodes every clip with libx265 here, never on its GPU lanes, peaks at 60% of the clip\'s bitrate', async () => {
  const h = createHarness({ clips: 4, devices: [ARC, UHD, CPU] });
  try {
    await assert.rejects(() => h.service.start(h.config({ profileId: 'smallest', bitrateKbps: undefined, codec: 'av1' })));
    const id = await h.service.start(h.config({
      profileId: 'smallest', bitrateKbps: undefined, concurrency: 2,
      lanes: [{ device: ARC.id, concurrency: 1 }, { device: UHD.id, concurrency: 1 }]
    }));
    const job = await h.finishJob(id);
    assert.equal(job.items.filter((item) => item.kind === 'video' && item.state === 'completed').length, 4);
    const encodes = h.encodes();
    assert.equal(encodes.length, 4);
    for (const { args } of encodes) {
      assert.equal(args[args.indexOf('-c:v') + 1], 'libx265');
      // 4,000,000 bytes in 2 s: 16 Mbit/s, so 9.6 Mbit/s at most
      assert.deepEqual(args.slice(args.indexOf('-crf'), args.indexOf('-crf') + 6), ['-crf', '27', '-maxrate', '9600000', '-bufsize', '19200000']);
      assert.equal(args.includes('-bf'), false);
      assert.equal(args.includes('+negative_cts_offsets'), true);
      assert.equal(args.some((arg) => /renderD|vaapi|qsv/.test(arg)), false, args.join(' '));
    }
  } finally {
    await h.close();
  }
});

test('a running Smallest job refuses lanes (its number at once is the plain number)', async () => {
  const h = createHarness({ clips: 2, devices: [ARC, UHD, CPU], behave: () => 'hold' });
  try {
    const id = await h.service.start(h.config({ profileId: 'smallest', bitrateKbps: undefined, concurrency: 1 }));
    await assert.rejects(() => h.service.setLanes(id, [{ device: ARC.id, concurrency: 1 }]), (error) => error.code === 'INVALID_LANES');
    const job = await h.service.setConcurrency(id, 2);
    assert.deepEqual([job.config.concurrency, 'lanes' in job.config], [2, false]);
  } finally {
    await h.close();
  }
});

test('a clip that is not smaller is encoded again under its original bitrate, still with B-frames', async () => {
  let calls = 0;
  const h = createHarness({
    clips: 1, devices: [CPU], defaultDevice: null, gpuDecode: false, works: (encoder) => encoder.startsWith('lib'),
    verifier: async () => (calls++ === 0
      ? { ok: false, reason: 'not-smaller', sourceBytes: 4_000_000, outputBytes: 4_100_000, retryable: false }
      : { ok: true, outputBytes: 3_000_000, publicationArtifact: null })
  });
  try {
    const job = await h.finishJob(await h.service.start(h.config({ profileId: 'smallest', bitrateKbps: undefined })));
    assert.equal(job.items.find((item) => item.kind === 'video').state, 'completed');
    const [first, retry] = h.encodes().map((entry) => entry.args);
    assert.equal(first.includes('-crf'), true);
    assert.equal(retry.includes('-crf') || retry.includes('-maxrate'), false);
    assert.ok(Number(retry[retry.indexOf('-b:v') + 1]) > 0);
    assert.equal(retry.includes('-bf'), false);
    assert.equal(retry[retry.indexOf('-c:v') + 1], 'libx265');
  } finally {
    await h.close();
  }
});

// speeds 0.3, 0.8, 1.3 ... m/s, one a frame (no 00 00 0x run in the floats)
function speedRecords(frames) {
  const f = Buffer.alloc(4);
  return Array.from({ length: frames }, (_, n) => { f.writeFloatLE(0.3 + n / 2); return Buffer.concat([Buffer.from([0x10, 0x01, 0x25]), f]); });
}

function reorderings(timing) {
  let count = 0;
  let shown = -Infinity;
  for (const sample of timing) {
    if (sample.ptsUs < shown) count += 1;
    shown = Math.max(shown, sample.ptsUs);
  }
  return count;
}

// each sample's place in the order shown
function shownRank(timing) {
  const order = timing.map((sample, index) => ({ pts: sample.ptsUs, index })).sort((a, b) => a.pts - b.pts || a.index - b.index);
  const rank = new Array(timing.length);
  order.forEach((entry, place) => { rank[entry.index] = place; });
  return rank;
}

test('a B-frame encode carries each frame\'s records on the picture shown in its place; both speed readers find them', { skip: needsFfmpeg, timeout: 120_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-smallest-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4');
  await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: source, telemetryPattern: speedRecords(48), size: '160x120' });
  const timeline = extractH264TelemetryTimeline(fs.readFileSync(source));
  const encoded = path.join(dir, 'encoded.mp4');
  const r = await runProcess('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source,
    ...buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: null, smallest: { maxrate: 720_000 } }), '-an', '-f', 'mp4', encoded]);
  assert.equal(r.status, 0, r.stderr);
  const bytes = fs.readFileSync(encoded);
  const timing = outputTiming(bytes);
  assert.equal(timing.length, 48);
  assert.ok(reorderings(timing) > 0, 'the encode stores frames out of the order shown');
  // shown at the original's times, the first at 0
  const shown = timing.map((sample) => sample.ptsUs).sort((a, b) => a - b);
  shown.forEach((pts, index) => assert.ok(Math.abs(pts - timeline.samples[index].ptsUs) <= 1, `frame ${index}: ${pts} vs ${timeline.samples[index].ptsUs}`));
  const out = path.join(dir, 'converted.mp4');
  fs.writeFileSync(out, injectH265Telemetry(bytes, mapTimelineToOutput(timeline, timing)));
  const inspected = inspectH265Telemetry(fs.readFileSync(out));
  assert.equal(inspected.accepted, true);
  const rank = shownRank(timing);
  inspected.samples.forEach((sample, index) => assert.deepEqual(sample.telemetryFingerprints,
    timeline.samples[rank[index]].seiNals.map((record) => record.fingerprint), `sample ${index}`));
  // the first record shown in each second, by either reader
  assert.deepEqual(await readSpeeds(out), [0.3, 6.3, 12.3, 18.3]);
  assert.deepEqual(await readSpeeds(out, { mode: 'straight' }), [0.3, 6.3, 12.3, 18.3]);
  // the full read lists the records in the order shown
  const full = new Telemetry({ srcRoot: path.join(REPO, 'src'), cacheDir: path.join(dir, 'cache') });
  const frames = JSON.parse(await full.read(out, fs.statSync(out).size)).frames;
  assert.equal(frames.length, 48);
  assert.ok(frames.every((frame, index) => index === 0 || frame[0] >= frames[index - 1][0]), 'in time order');
  const speeds = frames.map(([, record]) => Math.round(Buffer.from(record, 'base64').readFloatLE(3) * 10) / 10);
  assert.deepEqual(speeds, Array.from({ length: 48 }, (_, n) => Math.round((0.3 + n / 2) * 10) / 10));
});

test('a short B-frame clip (10 frames or fewer, matched by time): each record on its own picture', { skip: needsFfmpeg, timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-smallest-short-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4');
  await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: source, telemetryPattern: speedRecords(8), durationSeconds: 1, frameRate: 8, size: '160x120' });
  const timeline = extractH264TelemetryTimeline(fs.readFileSync(source));
  const encoded = path.join(dir, 'encoded.mp4');
  const r = await runProcess('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source,
    ...buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: null, smallest: { maxrate: 720_000 } }), '-an', '-f', 'mp4', encoded]);
  assert.equal(r.status, 0, r.stderr);
  const bytes = fs.readFileSync(encoded);
  const timing = outputTiming(bytes);
  assert.equal(timing.length, 8);
  assert.ok(reorderings(timing) > 0, 'stored out of the order shown');
  // the original's own times: no two pictures share one, so matching by time is exact
  assert.deepEqual(timing.map((sample) => sample.ptsUs).sort((a, b) => a - b), timeline.samples.map((sample) => sample.ptsUs));
  const mapped = mapTimelineToOutput(timeline, timing);
  const rank = shownRank(timing);
  mapped.forEach((sample, index) => assert.deepEqual(sample.seiNals.map((record) => record.fingerprint),
    timeline.samples[rank[index]].seiNals.map((record) => record.fingerprint), `sample ${index}`));
});

// The runtime as server/converterHost.js composes it, every spawn recorded.
async function openRuntime(base) {
  const spawned = [];
  process.env.SENTRY_NOREPLACE_RENAME = HELPER;
  const owned = createPosixOwnedFs();
  const runtime = await createConverterRuntime({
    userDataPath: fs.realpathSync(path.join(base, 'data')),
    tempPath: fs.realpathSync(path.join(base, 'temp')),
    ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', fs, pathApi: path, platform: process.platform,
    spawn: (command, args, options) => { spawned.push({ command, args }); return spawn(command, args, options); },
    removeOwned: owned.removeOwned, renameExclusive: owned.renameExclusive, autoConvert: false,
    network: {
      isRetryable: (error) => RETRYABLE.has(error?.code),
      checkPath: async (target) => fs.promises.access(target).then(() => true, () => false)
    }
  });
  await runtime.start();
  return { runtime, spawned };
}

const stamp = (n) => new Date(Date.UTC(2026, 10, 16, 15) + n * 60_000).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');

test('replace mode: on the CPU even with a GPU here; B-frames shown at the original times with their records; a lead-in clip keeps its order', { skip: needsRuntime, timeout: 300_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-smallest-e2e-'));
  for (const dir of ['data', 'temp', 'footage/TeslaCam/RecentClips', 'originals']) fs.mkdirSync(path.join(base, dir), { recursive: true });
  const root = fs.realpathSync(path.join(base, 'footage', 'TeslaCam'));
  const clips = {
    first: { camera: 'front', options: { frames: 72, gop: 18, cut: 0, size: '320x240' } },
    mid: { camera: 'left_repeater', options: { frames: 60, gop: 18, cut: 1, size: '320x240' } }
  };
  let n = 0;
  for (const [name, entry] of Object.entries(clips)) {
    entry.file = path.join(root, 'RecentClips', `${stamp(n++)}-${entry.camera}.mp4`);
    entry.fx = await createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: entry.file, ...entry.options, telemetryPattern: speedRecords(entry.options.frames) });
    entry.original = path.join(base, 'originals', `${name}.mp4`);
    fs.copyFileSync(entry.file, entry.original);
  }
  assert.deepEqual([clips.first.fx.leadIn, clips.mid.fx.leadIn], [0, 17]);
  const { runtime, spawned } = await openRuntime(base);
  try {
    const jobId = await runtime.service.start({
      sourceRoot: root, destinationRoot: null, codec: 'h265', profileId: 'smallest', networkMode: 'direct', outputMode: 'replace',
      includedGroups: ['RecentClips'], replacementConfirmed: true, concurrency: 1, verifyMode: 'full'
    });
    let timer;
    const ended = await Promise.race([
      runtime.service.whenIdle(jobId).then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), 240_000); })
    ]);
    clearTimeout(timer);
    assert.ok(ended, 'the job ended');
    const job = await runtime.service.get(jobId);
    const item = (entry) => job.items.find((candidate) => candidate.sourcePath === entry.file);
    const encodeOf = (entry) => spawned.filter((s) => s.args.includes('pipe:1') && s.args.includes('-c:v')
      && s.args.some((arg) => arg.includes(path.basename(entry.file)) || arg.includes(item(entry).id))).at(-1).args;
    for (const entry of Object.values(clips)) {
      assert.equal(item(entry).state, 'completed', JSON.stringify(item(entry).failure || item(entry).resultCode));
      assert.equal(item(entry).resultCode, 'converted');
      const args = encodeOf(entry);
      assert.equal(args[args.indexOf('-c:v') + 1], 'libx265', 'the CPU encoder, whatever GPU this computer has');
      assert.deepEqual([args[args.indexOf('-crf') + 1], args[args.indexOf('-preset') + 1]], ['27', 'veryfast']);
      assert.ok(Number(args[args.indexOf('-maxrate') + 1]) > 0);
    }
    assert.equal(encodeOf(clips.first).includes('+negative_cts_offsets'), true);
    assert.equal(encodeOf(clips.first).includes('-bf'), false);
    const midArgs = encodeOf(clips.mid);
    assert.deepEqual([midArgs[midArgs.indexOf('-bf') + 1], midArgs.includes('make_zero'), midArgs.includes('-movflags')], ['0', true, false]);

    // The keyframe-first clip: B-frames, every frame shown at its original
    // time with its own records (Tesla's closing record on the last shown)
    const out = fs.readFileSync(clips.first.file);
    const timing = outputTiming(out);
    assert.ok(reorderings(timing) > 0, 'stored out of the order shown');
    const source = extractH264TelemetryTimeline(fs.readFileSync(clips.first.original));
    assert.equal(timing.length, source.samples.length - 1, 'every frame but the zero-duration tail');
    assert.deepEqual(timing.map((sample) => sample.ptsUs).sort((a, b) => a - b), source.samples.slice(0, -1).map((sample) => sample.ptsUs));
    const expected = source.samples.slice(0, -1).map((sample) => sample.seiNals.map((record) => record.fingerprint));
    expected[expected.length - 1].push(...source.samples.at(-1).seiNals.map((record) => record.fingerprint));
    const rank = shownRank(timing);
    const inspected = inspectH265Telemetry(out);
    inspected.samples.forEach((sample, index) => assert.deepEqual(sample.telemetryFingerprints, expected[rank[index]], `sample ${index}`));
    // so both clips give the original's speed each second
    for (const entry of Object.values(clips)) {
      assert.deepEqual(await readSpeeds(entry.file), await readSpeeds(entry.original), entry.camera);
    }
  } finally {
    await runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});
