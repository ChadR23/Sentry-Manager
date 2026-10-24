'use strict';

// Tesla cuts each minute file in the middle of a group of pictures: side and
// back camera files often start with frames that only decode with the end of
// the previous file. The converter keeps those frames as repeats of the
// first decodable picture and gives the output the original's own timing, so
// it has the original's frame count, per-frame timestamps, length and
// telemetry, and the verifier accepts it without any loosened check.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const { buildEncodeArgs } = require(path.join(REPO, 'src/main/converter/encoderPlanner'));
const { leadInHoldFrames, retimeToSource } = require(path.join(REPO, 'src/main/converter/leadIn'));
const { extractH264TelemetryTimeline, mapTimelineToOutput } = require(path.join(REPO, 'src/main/converter/telemetryTimeline'));
const { injectH265Telemetry, inspectH265Telemetry } = require(path.join(REPO, 'src/main/converter/h265Telemetry'));
const { inspectAv1Telemetry } = require(path.join(REPO, 'src/main/converter/av1Telemetry'));
const { outputTiming } = require(path.join(REPO, 'src/main/converter/converterAdapters'));
const { verifyCandidate } = require(path.join(REPO, 'src/main/converter/verifier'));
const { createConverterRuntime } = require(path.join(REPO, 'src/main/converter/runtime'));
const { createPosixOwnedFs } = require(path.join(REPO, 'server/posixOwnedFs'));
const { RETRYABLE } = require(path.join(REPO, 'server/converterHost'));
const { createMidGopTeslaH264Fixture, runProcess } = require('./fixtures/ffmpegFixtures');
const { createHarness, T400, CPU } = require('./fixtures/lanesHarness');
const { box, fullBox, u32 } = require('./fixtures/fixtureBuilders');
const { parseMp4, findBoxes } = require(path.join(REPO, 'src/main/converter/mp4'));

const HELPER = process.env.SENTRY_NOREPLACE_RENAME || path.join(REPO, 'build', 'noreplace-rename');
const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString() || '';
const has = (name) => new RegExp(`\\s${name}\\s`).test(encoders);
const needsFfmpeg = has('libx264') && has('libx265') ? false : 'needs ffmpeg with libx264 and libx265';
const needsRuntime = needsFfmpeg || (fs.existsSync(HELPER) ? false : 'needs build/noreplace-rename');
const needsAv1 = needsRuntime || (has('libsvtav1') ? false : 'needs ffmpeg with libsvtav1');

const telemetryFor = (frames, gapAt = null) => Array.from({ length: frames }, (_, n) => (n === gapAt ? null : Buffer.from([0x20, n & 0xff, n >> 8])));

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Every packet's timestamp in microseconds, exactly, with its flags.
async function packets(file) {
  const result = await runProcess('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=time_base:packet=pts,duration,flags', '-of', 'json', file]);
  assert.strictEqual(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const [num, den] = parsed.streams[0].time_base.split('/').map(Number);
  return {
    timeBase: parsed.streams[0].time_base,
    tickUs: (num * 1e6) / den,
    list: parsed.packets.map((packet) => ({
      ptsUs: (Number(packet.pts) * num * 1e6) / den,
      discard: packet.flags.includes('D')
    }))
  };
}

// Every decoded frame as 8-bit luma.
async function grayFrames(file, width, height) {
  const chunks = [];
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`decode exited ${code}`))));
  });
  const all = Buffer.concat(chunks);
  const size = width * height;
  return Array.from({ length: all.length / size }, (_, index) => all.subarray(index * size, (index + 1) * size));
}

function meanAbsDiff(left, right) {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += Math.abs(left[index] - right[index]);
  return sum / left.length;
}

// The same file with a ctts (one composition offset per sample) in its
// sample table; the moov is last, so no media offset moves.
function withCtts(file, offsets) {
  const tree = parseMp4(file);
  const [stbl] = findBoxes(tree, 'stbl');
  const ctts = fullBox('ctts', 0, 0, Buffer.concat([u32(offsets.length), ...offsets.flatMap((offset) => [u32(1), u32(offset)])]));
  const serialize = (node) => {
    let payload = node.children.length ? Buffer.concat(node.children.map(serialize)) : file.subarray(Number(node.contentStart), Number(node.end));
    if (node === stbl) payload = Buffer.concat([payload, ctts]);
    return box(node.type, payload);
  };
  return Buffer.concat(tree.children.map(serialize));
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('buildEncodeArgs: without a lead-in every encoder keeps exactly its arguments; a lead-in adds one clone pad in front', () => {
  const families = {
    h265: ['libx265', 'hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_vaapi', 'hevc_videotoolbox'],
    av1: ['libsvtav1', 'libaom-av1', 'av1_nvenc', 'av1_qsv', 'av1_amf', 'av1_vaapi', 'av1_videotoolbox']
  };
  const pad = 'tpad=start=17:start_mode=clone';
  for (const [codec, list] of Object.entries(families)) {
    for (const encoder of list) {
      for (const extra of [{}, { quality: 'balanced' }, { device: { node: '/dev/dri/renderD129', index: 1 } }]) {
        const base = { codec, encoder, bitrate: 1_000_000, ...extra };
        const before = buildEncodeArgs(base);
        assert.deepStrictEqual(buildEncodeArgs({ ...base, holdFrames: 0 }), before, `${encoder}: holdFrames 0 changes nothing`);
        assert.ok(!before.some((arg) => String(arg).includes('tpad')));
        const held = buildEncodeArgs({ ...base, holdFrames: 17 });
        assert.strictEqual(held.filter((arg) => arg === '-vf').length, 1, `${encoder}: one filter chain`);
        const chain = held[held.indexOf('-vf') + 1];
        if (encoder.endsWith('_vaapi')) {
          assert.strictEqual(chain, `${pad},format=nv12,hwupload`, 'the repeat runs before the upload');
          assert.deepStrictEqual(held.filter((arg) => arg !== chain), before.filter((arg) => arg !== 'format=nv12,hwupload'));
        } else {
          assert.strictEqual(chain, pad);
          assert.deepStrictEqual(held.filter((arg, index) => arg !== chain && !(arg === '-vf' && held[index + 1] === chain)), before);
        }
      }
    }
  }
  // GPU-resident frames are never given to the frame repeat.
  assert.throws(() => buildEncodeArgs({ codec: 'h265', encoder: 'hevc_nvenc', bitrate: 1e6, hwFrames: true, holdFrames: 3 }), /system-memory/);
  assert.throws(() => buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: 1e6, holdFrames: -1 }), RangeError);
  assert.throws(() => buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: 1e6, holdFrames: 1.5 }), RangeError);
});

test('a clip with a lead-in skips zero-copy decoding on NVIDIA and gets the frame repeat; a keyframe-first clip keeps zero-copy', async () => {
  const nvidiaOnly = (encoder) => encoder === 'hevc_nvenc' || encoder.startsWith('lib');
  const leadIn = { frames: 5, hold: 5, syncSampleIndex: 5, reason: null, timescale: 10_000, durationTicks: Array(40).fill(417) };
  const held = createHarness({ clips: 1, devices: [T400, CPU], works: nvidiaOnly, timeline: { frames: [], leadIn } });
  try {
    const id = await held.service.start(held.config());
    assert.strictEqual((await held.finishJob(id)).state, 'completed');
    const args = held.encodes()[0].args;
    assert.deepStrictEqual(args.slice(5, 7), ['-hwaccel', 'cuda'], 'GPU decode');
    assert.strictEqual(args.includes('-hwaccel_output_format'), false, 'frames come back to system memory');
    assert.strictEqual(args[args.indexOf('-vf') + 1], 'tpad=start=5:start_mode=clone');
  } finally {
    await held.close();
  }
  const plain = createHarness({ clips: 1, devices: [T400, CPU], works: nvidiaOnly, timeline: { frames: [], leadIn: { frames: 0, hold: 0 } } });
  try {
    const id = await plain.service.start(plain.config());
    assert.strictEqual((await plain.finishJob(id)).state, 'completed');
    const args = plain.encodes()[0].args;
    assert.deepStrictEqual(args.slice(5, 9), ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']);
    assert.strictEqual(args.includes('-vf'), false);
  } finally {
    await plain.close();
  }
});

test('lead-in detection: frames before the first keyframe, none for a keyframe-first clip, no hold without any keyframe', { skip: needsFfmpeg, timeout: 60_000 }, async () => {
  const dir = tmpDir('sm-leadin-detect-');
  try {
    const cases = [
      { name: 'mid', frames: 40, gop: 8, cut: 3, expect: { frames: 5, hold: 5, reason: null } },
      { name: 'first', frames: 40, gop: 8, cut: 0, expect: { frames: 0, hold: 0, reason: null } },
      { name: 'none', frames: 4, gop: 8, cut: 3, expect: { frames: null, hold: 0, reason: 'no-keyframe' } },
      // the only keyframe is the zero-duration last sample decoders leave out
      { name: 'tail', frames: 6, gop: 8, cut: 3, expect: { frames: 5, hold: 0, reason: 'no-decodable-frame' } }
    ];
    for (const entry of cases) {
      const file = path.join(dir, `${entry.name}.mp4`);
      const fx = await createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: file, frames: entry.frames, gop: entry.gop, cut: entry.cut,
        size: '160x120', telemetryPattern: telemetryFor(entry.frames) });
      const timeline = extractH264TelemetryTimeline(fs.readFileSync(file));
      const { frames, hold, reason } = timeline.leadIn;
      assert.deepStrictEqual({ frames, hold, reason }, entry.expect, entry.name);
      assert.strictEqual(leadInHoldFrames(timeline), entry.expect.hold);
      if (entry.expect.hold > 0) {
        // the timing the output takes back: every real frame, no zero-duration tail
        assert.deepStrictEqual(timeline.leadIn.durationTicks, fx.durations.slice(0, -1));
        assert.strictEqual(timeline.leadIn.timescale, 10_000);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retimeToSource refuses anything but the original frames in order', { skip: needsFfmpeg, timeout: 60_000 }, async () => {
  const dir = tmpDir('sm-leadin-retime-');
  try {
    const source = path.join(dir, 'source.mp4');
    await createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: source, frames: 24, gop: 8, cut: 5, size: '160x120', telemetryPattern: telemetryFor(24) });
    const { leadIn } = extractH264TelemetryTimeline(fs.readFileSync(source));
    assert.strictEqual(leadIn.hold, 3);
    // The converter's own encode arguments, plus what each case changes.
    const encode = async (name, holdFrames, extra = []) => {
      const out = path.join(dir, name);
      const result = await runProcess('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source,
        ...buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: 200_000, holdFrames }), ...extra, '-an', '-f', 'mp4', out]);
      assert.strictEqual(result.status, 0, result.stderr);
      return fs.readFileSync(out);
    };
    // Without the frame repeat the encode is short by the lead-in.
    const short = await encode('short.mp4', 0);
    assert.throws(() => retimeToSource(short, leadIn), (error) => error.code === 'FRAME_COUNT_MISMATCH' && /Encoded 20 frames, the original has 23/.test(error.message));
    // With it: exactly the original timing, at the original timescale.
    const held = await encode('held.mp4', leadIn.hold);
    const retimed = retimeToSource(held, leadIn);
    let pts = 0;
    const expected = leadIn.durationTicks.map((ticks) => { const sample = { ptsUs: pts * 100, durationUs: ticks * 100 }; pts += ticks; return sample; });
    assert.deepStrictEqual(outputTiming(retimed), expected);
    // An edit list, a moov ahead of its media, or reordered frames are refused.
    const faststart = await encode('fast.mp4', leadIn.hold, ['-movflags', '+faststart']);
    assert.throws(() => retimeToSource(faststart, leadIn), (error) => error.code === 'CONTAINER_INVALID' && /moov/.test(error.message));
    const editList = await encode('edts.mp4', leadIn.hold, ['-use_editlist', '1']);
    assert.ok(editList.includes(Buffer.from('elst')), 'the case has an edit list');
    assert.throws(() => retimeToSource(editList, leadIn), (error) => error.code === 'CONTAINER_INVALID' && /edit list/.test(error.message));
    const reordered = await encode('bf.mp4', leadIn.hold, ['-x265-params', 'bframes=3:b-adapt=0']);
    assert.throws(() => retimeToSource(reordered, leadIn), (error) => error.code === 'CONTAINER_INVALID' && /reordered/.test(error.message));
    // A constant decode delay (a ctts that reorders nothing) is dropped with
    // the encoder's timing; one that reorders is refused.
    const delayed = withCtts(held, outputTiming(held).map(() => 1024));
    assert.ok(outputTiming(delayed)[0].ptsUs > 0, 'the case has a decode delay');
    const undelayed = retimeToSource(delayed, leadIn);
    assert.deepStrictEqual(outputTiming(undelayed), expected);
    assert.strictEqual(findBoxes(parseMp4(undelayed), 'ctts').length, 0);
    const swapped = withCtts(held, outputTiming(held).map((_, index) => (index === 0 ? 2048 : 0)));
    assert.throws(() => retimeToSource(swapped, leadIn), (error) => error.code === 'CONTAINER_INVALID' && /reordered/.test(error.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the verifier refuses a lead-in clip whose frames do not keep their original timestamps, and accepts it once they do', { skip: needsFfmpeg, timeout: 120_000 }, async () => {
  const dir = tmpDir('sm-leadin-verify-');
  try {
    const source = path.join(dir, 'source.mp4');
    const frames = 48;
    // Close to 24 fps so the encoder's 1/24 s grid keeps the total length
    // within tolerance: only the per-frame check can tell.
    await createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: source, frames, gop: 12, cut: 4, frameRate: 24, size: '160x120',
      telemetryPattern: telemetryFor(frames), durations: Array.from({ length: frames }, (_, n) => (n % 3 === 0 ? 400 : 425)) });
    const timeline = extractH264TelemetryTimeline(fs.readFileSync(source));
    assert.strictEqual(timeline.leadIn.hold, 8);
    const encoded = path.join(dir, 'encoded.mp4');
    const result = await runProcess('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source,
      ...buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: 200_000, holdFrames: 8 }), '-an', '-f', 'mp4', encoded]);
    assert.strictEqual(result.status, 0, result.stderr);
    const run = (command, args, options) => runProcess(command, args, options);
    const verify = (candidate) => verifyCandidate({ source, candidate, codec: 'h265', profileId: 'custom', runFfprobe: run, runFullDecode: run, verifyMode: 'full', sourceTimeline: timeline });

    // Telemetry written, but the encoder's own timestamps kept.
    const bytes = fs.readFileSync(encoded);
    const unretimed = path.join(dir, 'unretimed.mp4');
    fs.writeFileSync(unretimed, injectH265Telemetry(bytes, mapTimelineToOutput(timeline, outputTiming(bytes))));
    const refused = await verify(unretimed);
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'duration-mismatch');
    assert.strictEqual(refused.details.kind, 'source-output-frame-timing', JSON.stringify(refused.details));
    assert.strictEqual(refused.details.leadInFrames, 8);
    assert.strictEqual(refused.details.sourceFrames, refused.details.outputFrames, 'the frame count alone would have passed');

    // The converter's path: the original's timing first, then the telemetry.
    const retimedBytes = retimeToSource(bytes, timeline.leadIn);
    const accepted = path.join(dir, 'accepted.mp4');
    fs.writeFileSync(accepted, injectH265Telemetry(retimedBytes, mapTimelineToOutput(timeline, outputTiming(retimedBytes))));
    const ok = await verify(accepted);
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.strictEqual(ok.details.outputFrames, frames - 1);
    assert.strictEqual(ok.details.leadInFrames, 8);
    assert.strictEqual(ok.details.frameTiming, 'exact');
    assert.strictEqual(ok.details.frameCountTolerance, 0);
    assert.strictEqual(ok.details.telemetryEvents, frames);
    fs.rmSync(path.dirname(ok.publicationArtifact.path), { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The runtime as server/converterHost.js composes it, every spawn recorded.
async function openRuntime(base, { gpuDecode = false } = {}) {
  const spawned = [];
  process.env.SENTRY_NOREPLACE_RENAME = HELPER;
  const owned = createPosixOwnedFs();
  const runtime = await createConverterRuntime({
    userDataPath: fs.realpathSync(path.join(base, 'data')),
    tempPath: fs.realpathSync(path.join(base, 'temp')),
    ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', fs, pathApi: path, platform: process.platform,
    spawn: (command, args, options) => { spawned.push({ command, args }); return spawn(command, args, options); },
    removeOwned: owned.removeOwned, renameExclusive: owned.renameExclusive, autoConvert: false, gpuDecode,
    network: {
      isRetryable: (error) => RETRYABLE.has(error?.code),
      checkPath: async (target) => fs.promises.access(target).then(() => true, () => false)
    }
  });
  await runtime.start();
  return { runtime, spawned };
}

function makeBase() {
  const base = tmpDir('sm-leadin-e2e-');
  for (const dir of ['data', 'temp', 'footage/TeslaCam/RecentClips']) fs.mkdirSync(path.join(base, dir), { recursive: true });
  return { base, root: fs.realpathSync(path.join(base, 'footage', 'TeslaCam')) };
}

async function runJob(runtime, root, codec, profile = { profileId: 'custom', bitrateKbps: 250 }) {
  const jobId = await runtime.service.start({
    sourceRoot: root, destinationRoot: null, codec, ...profile, networkMode: 'direct', outputMode: 'replace',
    includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'], groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'],
    replacementConfirmed: true, concurrency: 1, verifyMode: 'full'
  });
  let timer;
  const ended = await Promise.race([
    runtime.service.whenIdle(jobId).then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), 240_000); })
  ]);
  clearTimeout(timer);
  if (!ended) {
    await runtime.service.cancel(jobId).catch(() => {});
    assert.fail('the job did not end');
  }
  return runtime.service.get(jobId);
}

// Converted in place: same frame count, every frame at its original time,
// the same length, telemetry 1:1 including the lead-in, and the lead-in
// frames show the first keyframe's picture.
async function assertHeldConversion({ original, converted, fx, inspect, width, height }) {
  const source = await packets(original);
  const output = await packets(converted);
  const sourceFrames = source.list.filter((packet) => !packet.discard);
  assert.strictEqual(output.list.length, fx.frames - 1, 'every frame but the zero-duration tail');
  assert.strictEqual(sourceFrames.length, output.list.length);
  assert.strictEqual(output.timeBase, source.timeBase, 'the original time base');
  const maxDiff = Math.max(...output.list.map((packet, index) => Math.abs(packet.ptsUs - sourceFrames[index].ptsUs)));
  assert.ok(maxDiff <= output.tickUs / 2, `per-frame pts differ by up to ${maxDiff} us`);
  const durationUs = fx.durations.reduce((sum, value) => sum + value, 0) * 100;
  const probed = await runProcess('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', converted]);
  assert.strictEqual(Math.round(Number(probed.stdout.trim()) * 1e6), durationUs, 'the original length');

  // Telemetry: frame i carries the original frame i's records; the last frame
  // also carries the zero-duration tail's.
  const sourceTimeline = extractH264TelemetryTimeline(fs.readFileSync(original));
  const expected = sourceTimeline.samples.slice(0, -1).map((sample) => sample.seiNals.map((record) => record.fingerprint));
  expected[expected.length - 1].push(...sourceTimeline.samples.at(-1).seiNals.map((record) => record.fingerprint));
  const inspected = inspect(fs.readFileSync(converted));
  assert.strictEqual(inspected.accepted, true);
  assert.deepStrictEqual(inspected.samples.map((sample) => sample.telemetryFingerprints), expected);
  for (let index = 0; index < fx.leadIn; index += 1) assert.strictEqual(inspected.samples[index].telemetryFingerprints.length, 1, `lead-in frame ${index} keeps its telemetry`);

  // Pictures: the held frames repeat the first keyframe's.
  const outFrames = await grayFrames(converted, width, height);
  const srcFrames = await grayFrames(original, width, height);
  assert.strictEqual(outFrames.length, output.list.length, 'every frame decodes');
  assert.strictEqual(srcFrames.length, output.list.length - fx.leadIn, 'the original decodes only from its keyframe');
  // Each held frame is the original keyframe's picture (srcFrames[0], up to
  // encoding loss), clearly not the next original picture: the test pattern
  // moves by ~3-5 levels per frame, encoding loss here stays well under that.
  const held = Array.from({ length: fx.leadIn }, (_, index) => ({
    key: meanAbsDiff(outFrames[index], srcFrames[0]),
    next: meanAbsDiff(outFrames[index], srcFrames[1])
  }));
  assert.ok(held.every(({ key, next }) => key < 2.5 && key < next * 0.6),
    `held frames show the keyframe: ${held.map(({ key, next }) => `${key.toFixed(2)}/${next.toFixed(2)}`)}`);
  assert.ok(meanAbsDiff(outFrames[fx.leadIn], srcFrames[0]) < 2.5, 'then the keyframe itself');
  assert.ok(meanAbsDiff(outFrames[fx.leadIn + 4], srcFrames[4]) < 2.5 && meanAbsDiff(outFrames[fx.leadIn + 4], srcFrames[0]) > 5,
    'later frames are their own pictures (the comparison can tell frames apart)');
  return { maxDiff, frames: output.list.length };
}

const stamp = (n) => new Date(Date.UTC(2026, 9, 11, 15) + n * 60_000).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');

test('replace mode, H.265: lead-in clips (short and several seconds) convert with every frame kept; keyframe-first unchanged; no keyframe fails safely', { skip: needsRuntime, timeout: 300_000 }, async () => {
  const { base, root } = makeBase();
  const recent = path.join(root, 'RecentClips');
  const clip = (n, camera) => path.join(recent, `${stamp(n)}-${camera}.mp4`);
  const keep = path.join(base, 'originals');
  fs.mkdirSync(keep);
  const clips = {
    mid: { file: clip(0, 'left_repeater'), options: { frames: 60, gop: 18, cut: 1, size: '320x240' }, width: 320, height: 240, gapAt: 30 },
    long: { file: clip(1, 'back'), options: { frames: 140, gop: 120, cut: 24, frameRate: 24, size: '160x120' }, width: 160, height: 120, gapAt: 110 },
    first: { file: clip(2, 'front'), options: { frames: 40, gop: 18, cut: 0, size: '160x120' } },
    none: { file: clip(3, 'right_repeater'), options: { frames: 6, gop: 18, cut: 1, size: '160x120' } }
  };
  for (const [name, entry] of Object.entries(clips)) {
    entry.fx = await createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: entry.file, ...entry.options,
      telemetryPattern: telemetryFor(entry.options.frames, entry.gapAt ?? null) });
    entry.original = path.join(keep, `${name}.mp4`);
    fs.copyFileSync(entry.file, entry.original);
    entry.sha = sha(entry.file);
  }
  assert.deepStrictEqual([clips.mid.fx.leadIn, clips.long.fx.leadIn, clips.first.fx.leadIn], [17, 96, 0]);
  const env = await openRuntime(base);
  try {
    const job = await runJob(env.runtime, root, 'h265');
    const item = (entry) => job.items.find((candidate) => candidate.sourcePath === entry.file);
    const encodeArgs = (entry) => env.spawned.filter((spawned) => spawned.args.includes('pipe:1') && spawned.args.includes('-c:v')
      && spawned.args.some((arg) => arg.includes(path.basename(entry.file)) || arg.includes(item(entry).id)));

    for (const name of ['mid', 'long']) {
      const entry = clips[name];
      assert.strictEqual(item(entry).state, 'completed', `${name}: ${JSON.stringify(item(entry).failure || item(entry).resultCode)}`);
      assert.strictEqual(item(entry).resultCode, 'converted');
      const args = encodeArgs(entry).at(-1).args;
      assert.strictEqual(args[args.indexOf('-vf') + 1], `tpad=start=${entry.fx.leadIn}:start_mode=clone`);
      await assertHeldConversion({ original: entry.original, converted: entry.file, fx: entry.fx, inspect: inspectH265Telemetry, width: entry.width, height: entry.height });
    }

    // Starts on a keyframe: encoded exactly as before (no filter, the
    // encoder's own timing), and converted as before.
    assert.strictEqual(item(clips.first).state, 'completed', JSON.stringify(item(clips.first).failure));
    const firstArgs = encodeArgs(clips.first).at(-1).args;
    assert.strictEqual(firstArgs.includes('-vf'), false);
    assert.deepStrictEqual(firstArgs.slice(firstArgs.indexOf('-c:v'), firstArgs.indexOf('-an')),
      buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: 250_000 }));
    assert.notStrictEqual((await packets(clips.first.file)).timeBase, '1/10000', 'no retiming for a keyframe-first clip');

    // No keyframe at all: nothing to hold, nothing replaced.
    assert.strictEqual(item(clips.none).state, 'failed');
    assert.strictEqual(sha(clips.none.file), clips.none.sha, 'the original is untouched');
    assert.strictEqual(encodeArgs(clips.none).every((spawned) => !spawned.args.includes('-vf')), true);
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('replace mode, AV1: a lead-in clip converts with every frame kept and its telemetry 1:1', { skip: needsAv1, timeout: 300_000 }, async () => {
  const { base, root } = makeBase();
  const file = path.join(root, 'RecentClips', `${stamp(0)}-left_repeater.mp4`);
  const fx = await createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: file, frames: 48, gop: 18, cut: 7, size: '320x240', telemetryPattern: telemetryFor(48, 20) });
  const original = path.join(base, 'original.mp4');
  fs.copyFileSync(file, original);
  assert.strictEqual(fx.leadIn, 11);
  const env = await openRuntime(base);
  try {
    const job = await runJob(env.runtime, root, 'av1');
    assert.strictEqual(job.items[0].state, 'completed', JSON.stringify(job.items[0].failure));
    const args = env.spawned.find((spawned) => spawned.args.includes('pipe:1') && spawned.args.includes('-c:v')).args;
    assert.strictEqual(args[args.indexOf('-c:v') + 1], 'libsvtav1');
    assert.strictEqual(args[args.indexOf('-vf') + 1], 'tpad=start=11:start_mode=clone');
    await assertHeldConversion({ original, converted: file, fx, inspect: inspectAv1Telemetry, width: 320, height: 240 });
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Opt-in, for real clips on real hardware (for example NVENC on a PC):
//   LEADIN_CLIPS=/clips/a.mp4,/clips/b.mp4 [LEADIN_CODEC=h265|av1] node --test --test-name-pattern "real clips" test/leadIn.test.js
// Each clip is copied into a temporary TeslaCam folder and converted there in
// replace mode with GPU decoding, full verification and constant quality;
// the clips themselves are only read. One JSON line of evidence per clip.
const realClips = (process.env.LEADIN_CLIPS || '').split(/[,;]/).map((entry) => entry.trim()).filter(Boolean);
test('real clips (opt-in): every frame kept at its original time, verified, replaced', {
  skip: realClips.length === 0 ? 'set LEADIN_CLIPS to run' : (fs.existsSync(HELPER) ? false : 'needs noreplace-rename'), timeout: 3_600_000
}, async (t) => {
  const codec = process.env.LEADIN_CODEC || 'h265';
  const { base, root } = makeBase();
  const keep = path.join(base, 'originals');
  fs.mkdirSync(keep);
  const clips = realClips.map((source, index) => {
    const camera = /(left_repeater|right_repeater|back|front|left_pillar|right_pillar)/.exec(path.basename(source))?.[1] || 'left_repeater';
    const file = path.join(root, 'RecentClips', `${stamp(index)}-${camera}.mp4`);
    fs.copyFileSync(source, file);
    const original = path.join(keep, `${index}.mp4`);
    fs.copyFileSync(source, original);
    return { source, file, original };
  });
  const env = await openRuntime(base, { gpuDecode: true });
  try {
    const job = await runJob(env.runtime, root, codec, { profileId: 'quality', qualityLevel: 'balanced' });
    for (const clip of clips) {
      const item = job.items.find((candidate) => candidate.sourcePath === clip.file);
      const encodes = env.spawned.filter((spawned) => spawned.args.includes('pipe:1') && spawned.args.includes('-c:v')
        && spawned.args.includes(clip.file)).map((spawned) => spawned.args.slice(spawned.args.indexOf('-nostdin') + 5, spawned.args.indexOf('-an')).join(' '));
      const report = { clip: clip.source, state: item?.state, resultCode: item?.resultCode, failure: item?.failure || null, encodes };
      let timeline = null;
      try { timeline = extractH264TelemetryTimeline(fs.readFileSync(clip.original)); } catch (_) { /* not H.264 */ }
      report.leadIn = timeline ? { frames: timeline.leadIn.frames, hold: timeline.leadIn.hold } : null;
      if (item?.state === 'completed' && item.resultCode === 'converted') {
        const source = await packets(clip.original);
        const output = await packets(clip.file);
        const shown = source.list.filter((packet) => !packet.discard);
        report.sourceFrames = shown.length;
        report.outputFrames = output.list.length;
        const counted = await runProcess('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', clip.file]);
        report.decodedFrames = Number(counted.stdout.trim());
        report.maxPtsDiffUs = shown.length === output.list.length
          ? Math.max(...output.list.map((packet, index) => Math.abs(packet.ptsUs - shown[index].ptsUs))) : null;
        report.timeBase = { source: source.timeBase, output: output.timeBase };
        const inspected = (codec === 'av1' ? inspectAv1Telemetry : inspectH265Telemetry)(fs.readFileSync(clip.file));
        report.telemetry = { sourceRecords: timeline.events.length, outputRecords: inspected.telemetryFingerprints.length, outputSamples: inspected.sampleCount };
        if (timeline.leadIn.hold > 0) {
          assert.strictEqual(report.outputFrames, report.sourceFrames, 'every frame kept');
          assert.strictEqual(report.maxPtsDiffUs <= output.tickUs / 2, true, 'every frame at its original time');
          assert.strictEqual(report.telemetry.outputRecords, report.telemetry.sourceRecords, 'telemetry 1:1');
        }
      }
      t.diagnostic(JSON.stringify(report));
      console.log(`LEADIN ${JSON.stringify(report)}`);
      // A lead-in clip converts, or stays the original when the encode is
      // not smaller (a size decision, not a lead-in failure).
      if (timeline?.leadIn.hold > 0) assert.ok(['converted', 'no-savings'].includes(item?.resultCode), `${clip.source}: ${item?.resultCode} ${JSON.stringify(item?.failure)}`);
    }
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});
