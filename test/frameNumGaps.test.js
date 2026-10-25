'use strict';

// Tesla's encoder sometimes skips a frame: the next picture's frame_num jumps
// although the SPS allows no gaps. Where the jump crosses the wrap of
// frame_num back to 0, FFmpeg never outputs that picture, so the encode has
// one frame fewer than the original. The converter proves which samples
// those are from the bitstream, gives the output the original's timing with
// each dropped sample's time and telemetry on the frame before it, and the
// verifier accepts exactly that many frames fewer, nothing else loosened.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const { buildEncodeArgs } = require(path.join(REPO, 'src/main/converter/encoderPlanner'));
const { droppedPictures, parseSps, avcParameterSets, undecodableFrames } = require(path.join(REPO, 'src/main/converter/frameNumGaps'));
const { sourceTimingFor, retimeToSource } = require(path.join(REPO, 'src/main/converter/leadIn'));
const { extractH264TelemetryTimeline, mapTimelineToOutput, parseH264Nals } = require(path.join(REPO, 'src/main/converter/telemetryTimeline'));
const { injectH265Telemetry, inspectH265Telemetry } = require(path.join(REPO, 'src/main/converter/h265Telemetry'));
const { inspectAv1Telemetry } = require(path.join(REPO, 'src/main/converter/av1Telemetry'));
const { outputTiming } = require(path.join(REPO, 'src/main/converter/converterAdapters'));
const { verifyCandidate } = require(path.join(REPO, 'src/main/converter/verifier'));
const { createConverterRuntime } = require(path.join(REPO, 'src/main/converter/runtime'));
const { createPosixOwnedFs } = require(path.join(REPO, 'server/posixOwnedFs'));
const { RETRYABLE } = require(path.join(REPO, 'server/converterHost'));
const { createMidGopTeslaH264Fixture, runProcess } = require('./fixtures/ffmpegFixtures');

const HELPER = process.env.SENTRY_NOREPLACE_RENAME || path.join(REPO, 'build', 'noreplace-rename');
const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString() || '';
const has = (name) => new RegExp(`\\s${name}\\s`).test(encoders);
const needsFfmpeg = has('libx264') && has('libx265') ? false : 'needs ffmpeg with libx264 and libx265';
const needsRuntime = needsFfmpeg || (fs.existsSync(HELPER) ? false : 'needs build/noreplace-rename');
const needsAv1 = needsRuntime || (has('libsvtav1') ? false : 'needs ffmpeg with libsvtav1');

const telemetryFor = (frames, gapsAt = []) => Array.from({ length: frames }, (_, n) => (gapsAt.includes(n) ? null : Buffer.from([0x20, n & 0xff, n >> 8])));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// x264 at these settings writes what Tesla writes: log2_max_frame_num 4 (so
// frame_num wraps inside an 18-frame group), no gaps allowed, picture order
// count type 2, every picture a reference. Skipping the picture numbered 0
// after the wrap (position 16 of a group) gives the next one frame_num 1
// after 15: FFmpeg's "Frame num gap 1 15", as on the real clip.
const gapClip = (outputPath, options) => createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath, gop: 18, cut: 0, size: '160x120',
  ...options, telemetryPattern: options.telemetryPattern || telemetryFor(options.frames) });

// What FFmpeg outputs for a file: the decoded frame count, the samples it
// leaves out (by timestamp) and its gap messages.
async function ffmpegView(file, fx) {
  const counted = await runProcess('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]);
  assert.strictEqual(counted.status, 0, counted.stderr);
  const frames = await runProcess('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts', '-of', 'json', file]);
  const shown = new Set(JSON.parse(frames.stdout).frames.map((frame) => Number(frame.pts)));
  let pts = 0;
  const missing = [];
  fx.durations.slice(0, -1).forEach((duration, index) => {
    if (!shown.has(pts)) missing.push(index);
    pts += duration;
  });
  const log = await runProcess('ffmpeg', ['-nostdin', '-v', 'debug', '-i', file, '-f', 'null', '-']);
  return { decoded: Number(counted.stdout.trim()), missing, gaps: log.stderr.match(/Frame num gap \d+ \d+/g) || [] };
}

// Every packet's timestamp and duration in microseconds, exactly.
async function packets(file) {
  const result = await runProcess('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=time_base:packet=pts,duration,flags', '-of', 'json', file]);
  assert.strictEqual(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const [num, den] = parsed.streams[0].time_base.split('/').map(Number);
  return {
    timeBase: parsed.streams[0].time_base,
    list: parsed.packets.map((packet) => ({ ptsUs: (Number(packet.pts) * num * 1e6) / den, discard: packet.flags.includes('D') }))
  };
}

// The output frames a gap clip must have: every real sample but the dropped
// ones, each at its original time, a dropped sample's duration (in 1/10000 s
// ticks) added to the frame before it.
function expectedFrames(durations, dropped) {
  const frames = [];
  let pts = 0;
  durations.slice(0, -1).forEach((ticks, index) => {
    if (dropped.includes(index)) frames.at(-1).durationUs += ticks * 100;
    else frames.push({ ptsUs: pts * 100, durationUs: ticks * 100 });
    pts += ticks;
  });
  return frames;
}

// Telemetry the output must carry: each kept sample's records on its frame,
// a dropped sample's after the frame before it, the zero-duration tail's on
// the last frame.
function expectedTelemetry(timeline, dropped) {
  const expected = [];
  timeline.samples.forEach((sample, index) => {
    const fingerprints = sample.seiNals.map((record) => record.fingerprint);
    if (index < timeline.samples.length - 1 && !dropped.includes(index)) expected.push(fingerprints);
    else expected.at(-1).push(...fingerprints);
  });
  return expected;
}

// The same file with gaps_in_frame_num_value_allowed_flag set in its SPS: the
// one bit whose flip changes that field and nothing else the SPS says.
function allowGaps(file) {
  const bytes = Buffer.from(fs.readFileSync(file));
  const at = bytes.indexOf(Buffer.from('avcC'));
  const avcC = bytes.subarray(at + 4, at - 4 + bytes.readUInt32BE(at - 4));
  const [unit] = avcParameterSets(avcC).sps;
  const before = JSON.stringify(parseSps(unit));
  for (let bit = 8; bit < unit.length * 8; bit += 1) {
    const copy = Buffer.from(unit);
    copy[bit >> 3] ^= 0x80 >> (bit & 7);
    let after;
    try { after = parseSps(copy); } catch (_) { continue; }
    if (after.gapsAllowed === 1 && JSON.stringify({ ...after, gapsAllowed: 0 }) === before) {
      unit[bit >> 3] ^= 0x80 >> (bit & 7);
      fs.writeFileSync(file, bytes);
      return;
    }
  }
  throw new Error('no gaps flag found');
}

// A sample's NAL units rewritten (4-byte length prefixes, as x264 writes).
function editNals(bytes, edit) {
  const nals = edit(parseH264Nals(Buffer.from(bytes), { format: 'length-prefixed', lengthSize: 4 }));
  return Buffer.concat(nals.flatMap((nal) => { const size = Buffer.alloc(4); size.writeUInt32BE(nal.length); return [size, nal]; }));
}

// editSample for the fixture: sample `at`'s slice header starts with three
// zero bytes, which H.264 forbids inside a NAL unit.
const corruptSlice = (at) => (index, bytes) => (index !== at ? bytes : editNals(bytes, (nals) => nals.map((nal) => {
  if ((nal[0] & 0x1f) !== 1) return nal;
  const copy = Buffer.from(nal);
  copy.fill(0, 1, 4);
  return copy;
})));

test('frame_num rule: only a gap across the wrap, followed by an IDR, drops a picture; anything unmodelled is refused', () => {
  const pic = (frameNum, extra = {}) => ({ idr: false, refIdc: 2, frameNum, resets: false, field: 0, ...extra });
  const idr = () => pic(0, { idr: true, refIdc: 3 });
  const group = (from, to) => Array.from({ length: to - from + 1 }, (_, n) => pic((from + n) % 16));
  // 0..15, then 1 (0 skipped across the wrap), then an IDR: as on the real clip.
  assert.deepStrictEqual(droppedPictures([idr(), ...group(1, 15), pic(1), idr(), ...group(1, 5)], 16, 2), [16]);
  assert.deepStrictEqual(droppedPictures([idr(), ...group(1, 14), pic(1), idr()], 16, 2), [15], 'several numbers skipped');
  assert.deepStrictEqual(droppedPictures([idr(), ...group(1, 17), idr()], 16, 2), [], 'a clean wrap');
  // Gaps FFmpeg conceals (decodes from a copy of the previous picture).
  assert.deepStrictEqual(droppedPictures([idr(), ...group(1, 4), ...group(6, 17), idr()], 16, 2), [], 'no wrap');
  assert.deepStrictEqual(droppedPictures([idr(), ...group(1, 14), pic(0), pic(1), idr()], 16, 2), [], 'the gap ends on 0');
  // What this model does not cover.
  const refused = {
    'pictures after the dropped one': [idr(), ...group(1, 15), pic(1), pic(2), idr()],
    'the last picture dropped': [idr(), ...group(1, 15), pic(1)],
    'a repeated number': [idr(), pic(1), pic(1), idr()],
    'a non-reference picture': [idr(), pic(1, { refIdc: 0 }), idr()],
    'an IDR not numbered 0': [pic(3, { idr: true })],
    'a memory-management reset': [idr(), pic(1, { resets: true }), idr()],
    'a field picture': [idr(), pic(1, { field: 1 }), idr()],
    'no IDR first': [pic(1), idr()]
  };
  for (const [name, pictures] of Object.entries(refused)) assert.throws(() => droppedPictures(pictures, 16, 2), name);
  assert.throws(() => droppedPictures([idr(), ...group(1, 15), pic(1), idr()], 16, 0), 'a gap with another picture order count type');
  assert.deepStrictEqual(droppedPictures([idr(), ...group(1, 17), idr()], 16, 0), [], 'no gap: any order count type');
});

test('the detector agrees with what FFmpeg outputs, and says unknown where it is not sure', { skip: needsFfmpeg, timeout: 120_000 }, async () => {
  const dir = tmpDir('sm-gap-detect-');
  try {
    const cases = [
      { name: 'real-clip pattern', frames: 54, skip: [16], expect: { frames: 1, samples: [16] } },
      { name: 'two numbers skipped', frames: 54, skip: [15, 16], expect: { frames: 1, samples: [15] } },
      { name: 'two gaps', frames: 60, skip: [16, 34], expect: { frames: 2, samples: [16, 33] } },
      { name: 'second wrap of a long group', frames: 70, gop: 34, skip: [32], expect: { frames: 1, samples: [32] } },
      { name: 'after a lead-in', frames: 54, cut: 7, skip: [27], expect: { frames: 1, samples: [27] } },
      { name: 'concealed gap', frames: 54, skip: [5], expect: { frames: 0, samples: [] } },
      { name: 'gap ending on 0', frames: 54, skip: [15], expect: { frames: 0, samples: [] } },
      { name: 'clean', frames: 54, skip: [], expect: { frames: 0, samples: [] } },
      // FFmpeg drops the gap picture and more of the group after it: unknown.
      { name: 'pictures after the gap', frames: 54, gop: 30, skip: [16], expect: { frames: null, samples: [], reason: 'frame-num' } }
    ];
    for (const entry of cases) {
      const file = path.join(dir, `${entry.name.replace(/ /g, '-')}.mp4`);
      const fx = await gapClip(file, { frames: entry.frames, gop: entry.gop || 18, cut: entry.cut || 0, skip: entry.skip });
      const { undecodable, leadIn } = extractH264TelemetryTimeline(fs.readFileSync(file));
      assert.deepStrictEqual({ frames: undecodable.frames, samples: [...undecodable.samples], reason: undecodable.reason },
        { reason: null, ...entry.expect }, entry.name);
      const view = await ffmpegView(file, fx);
      assert.strictEqual(view.gaps.length > 0, entry.skip.length > 0, `${entry.name}: ${view.gaps}`);
      const leadInFrames = leadIn.frames;
      if (entry.expect.frames === null) {
        assert.ok(view.decoded < entry.frames - 1 - leadInFrames - 1, `${entry.name}: FFmpeg drops more than the gap picture (${view.decoded})`);
        continue;
      }
      // ffprobe decodes every sample but the predicted ones (and the lead-in).
      assert.strictEqual(view.decoded, entry.frames - 1 - leadInFrames - entry.expect.frames, entry.name);
      assert.deepStrictEqual(view.missing, [...Array.from({ length: leadInFrames }, (_, n) => n), ...entry.expect.samples], entry.name);
      if (entry.expect.frames > 0) {
        assert.strictEqual(undecodableFrames({ undecodable }), entry.expect.frames);
        assert.deepStrictEqual([...undecodable.durationTicks], expectedFrames(fx.durations, entry.expect.samples).map((frame) => frame.durationUs / 100));
        assert.strictEqual(undecodable.durationTicks.reduce((sum, value) => sum + value, 0), fx.durations.reduce((sum, value) => sum + value, 0), 'the same length');
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gaps allowed by the SPS, other parameter sets in the stream, or a slice header that does not read excuse nothing', { skip: needsFfmpeg, timeout: 60_000 }, async () => {
  const dir = tmpDir('sm-gap-unknown-');
  try {
    // Gaps allowed: the SPS promises the decoder infers them; nothing is
    // excused, although FFmpeg still leaves the picture out.
    const allowed = path.join(dir, 'allowed.mp4');
    const fx = await gapClip(allowed, { frames: 54, skip: [16] });
    allowGaps(allowed);
    const timeline = extractH264TelemetryTimeline(fs.readFileSync(allowed));
    assert.deepStrictEqual({ frames: timeline.undecodable.frames, reason: timeline.undecodable.reason }, { frames: 0, reason: 'gaps-allowed' });
    assert.strictEqual(sourceTimingFor(timeline), null, 'no retiming');
    assert.strictEqual((await ffmpegView(allowed, fx)).decoded, 52);

    // A picture parameter set repeated in the stream with other bytes (a
    // trailing zero byte FFmpeg ignores): not modelled, so unknown.
    // (the PPS is known once the clip exists: the plain clip has the same)
    const plainBytes = fs.readFileSync(allowed);
    const at = plainBytes.indexOf(Buffer.from('avcC'));
    const { pps: [pps] } = avcParameterSets(plainBytes.subarray(at + 4, at - 4 + plainBytes.readUInt32BE(at - 4)));
    const inBand = path.join(dir, 'in-band.mp4');
    await gapClip(inBand, { frames: 54, skip: [16], editSample: (index, bytes) => (index !== 20 ? bytes : editNals(bytes, (nals) => [Buffer.concat([pps, Buffer.from([0])]), ...nals])) });
    const inBandTimeline = extractH264TelemetryTimeline(fs.readFileSync(inBand));
    assert.deepStrictEqual({ frames: inBandTimeline.undecodable.frames, reason: inBandTimeline.undecodable.reason }, { frames: null, reason: 'parameter-sets' });
    assert.strictEqual(sourceTimingFor(inBandTimeline), null);
    assert.strictEqual((await ffmpegView(inBand, fx)).decoded, 52, 'FFmpeg decodes it as the plain clip');

    // A slice header that does not read (bytes H.264 forbids) in a picture
    // the decoder would show: unknown, the clip is treated as before.
    const corrupt = path.join(dir, 'corrupt.mp4');
    await gapClip(corrupt, { frames: 54, skip: [16], editSample: corruptSlice(10) });
    const corruptTimeline = extractH264TelemetryTimeline(fs.readFileSync(corrupt));
    assert.deepStrictEqual({ frames: corruptTimeline.undecodable.frames, reason: corruptTimeline.undecodable.reason }, { frames: null, reason: 'unreadable' });
    assert.strictEqual(sourceTimingFor(corruptTimeline), null);
    // ... and its telemetry maps as it always did (one record per frame).
    const mapped = mapTimelineToOutput(corruptTimeline, corruptTimeline.samples.slice(0, -1).map((sample) => ({ ptsUs: sample.ptsUs, durationUs: sample.durationUs })));
    assert.strictEqual(mapped.reduce((sum, frame) => sum + frame.seiNals.length, 0), 54);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retiming and the verifier: exactly the dropped frames fewer, each frame at its original time, telemetry carried', { skip: needsFfmpeg, timeout: 120_000 }, async () => {
  const dir = tmpDir('sm-gap-verify-');
  try {
    const source = path.join(dir, 'source.mp4');
    const frames = 54;
    const fx = await gapClip(source, { frames, skip: [16] });
    const timeline = extractH264TelemetryTimeline(fs.readFileSync(source));
    assert.strictEqual(timeline.undecodable.frames, 1);
    const encoded = path.join(dir, 'encoded.mp4');
    const result = await runProcess('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source,
      ...buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: 200_000 }), '-an', '-f', 'mp4', encoded]);
    assert.strictEqual(result.status, 0, result.stderr);
    const bytes = fs.readFileSync(encoded);
    assert.strictEqual(outputTiming(bytes).length, frames - 2, 'the encode lacks the gap picture');
    const run = (command, args, options) => runProcess(command, args, options);
    const verify = (candidate) => verifyCandidate({ source, candidate, codec: 'h265', profileId: 'custom', runFfprobe: run, runFullDecode: run, verifyMode: 'full', sourceTimeline: timeline });
    const write = (name, retimed) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, injectH265Telemetry(retimed, mapTimelineToOutput(timeline, outputTiming(retimed))));
      return file;
    };

    // Retiming refuses an encode with any other frame count.
    const full = { timescale: 10_000, durationTicks: fx.durations.slice(0, -1) };
    assert.throws(() => retimeToSource(bytes, full), (error) => error.code === 'FRAME_COUNT_MISMATCH');

    // The right count, but the dropped sample's time not given to the frame
    // before it (every later frame one sample early): refused.
    const shifted = { timescale: 10_000, durationTicks: fx.durations.slice(0, -1).filter((_, index) => index !== 16) };
    const refused = await verify(write('shifted.mp4', retimeToSource(bytes, shifted)));
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'duration-mismatch');
    assert.strictEqual(refused.details.kind, 'source-output-frame-timing', JSON.stringify(refused.details));
    assert.strictEqual(refused.details.undecodableFrames, 1);
    assert.strictEqual(refused.details.sampleIndex, 15);

    // The converter's path.
    const plan = sourceTimingFor(timeline);
    assert.deepStrictEqual(plan, { timescale: 10_000, durationTicks: timeline.undecodable.durationTicks });
    const accepted = write('accepted.mp4', retimeToSource(bytes, plan));
    assert.deepStrictEqual(outputTiming(fs.readFileSync(accepted)), expectedFrames(fx.durations, [16]));
    const ok = await verify(accepted);
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.strictEqual(ok.details.sourceFrames, frames - 1);
    assert.strictEqual(ok.details.outputFrames, frames - 2);
    assert.strictEqual(ok.details.undecodableFrames, 1);
    assert.strictEqual(ok.details.frameTiming, 'exact');
    assert.strictEqual(ok.details.frameCountTolerance, 0);
    assert.strictEqual(ok.details.telemetryEvents, frames, 'telemetry 1:1, the dropped frame\'s included');
    assert.deepStrictEqual(inspectH265Telemetry(fs.readFileSync(accepted)).samples.map((sample) => sample.telemetryFingerprints), expectedTelemetry(timeline, [16]));
    fs.rmSync(path.dirname(ok.publicationArtifact.path), { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    removeOwned: owned.removeOwned, renameExclusive: owned.renameExclusive, autoConvert: false, gpuDecode: false,
    network: {
      isRetryable: (error) => RETRYABLE.has(error?.code),
      checkPath: async (target) => fs.promises.access(target).then(() => true, () => false)
    }
  });
  await runtime.start();
  return { runtime, spawned };
}

function makeBase() {
  const base = tmpDir('sm-gap-e2e-');
  for (const dir of ['data', 'temp', 'footage/TeslaCam/RecentClips']) fs.mkdirSync(path.join(base, dir), { recursive: true });
  return { base, root: fs.realpathSync(path.join(base, 'footage', 'TeslaCam')) };
}

async function runJob(runtime, root, codec) {
  const jobId = await runtime.service.start({
    sourceRoot: root, destinationRoot: null, codec, profileId: 'custom', bitrateKbps: 250, networkMode: 'direct', outputMode: 'replace',
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

// Converted in place: exactly the dropped frames fewer, every frame at its
// original time with the dropped time on the frame before, the original
// length and time base, telemetry 1:1 with the dropped records moved, and
// every frame decodes.
async function assertGapConversion({ original, converted, fx, dropped, inspect }) {
  const expected = expectedFrames(fx.durations, dropped);
  const output = await packets(converted);
  assert.strictEqual(output.list.length, expected.length, 'every frame but the dropped ones and the zero-duration tail');
  assert.strictEqual(output.timeBase, (await packets(original)).timeBase, 'the original time base');
  assert.deepStrictEqual(outputTiming(fs.readFileSync(converted)), expected, 'every frame at its original time');
  const probed = await runProcess('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', converted]);
  assert.strictEqual(Math.round(Number(probed.stdout.trim()) * 1e6), fx.durations.reduce((sum, value) => sum + value, 0) * 100, 'the original length');
  const counted = await runProcess('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', converted]);
  assert.strictEqual(Number(counted.stdout.trim()), expected.length, 'every frame decodes');
  const timeline = extractH264TelemetryTimeline(fs.readFileSync(original));
  const inspected = inspect(fs.readFileSync(converted));
  assert.strictEqual(inspected.accepted, true);
  assert.deepStrictEqual(inspected.samples.map((sample) => sample.telemetryFingerprints), expectedTelemetry(timeline, dropped));
  assert.strictEqual(inspected.telemetryFingerprints.length, timeline.events.length, 'telemetry 1:1');
}

const stamp = (n) => new Date(Date.UTC(2026, 9, 20, 21) + n * 60_000).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');

test('replace mode, H.265: gap clips convert with exact timing and telemetry; a normal clip is unchanged; unproven gaps fail as before, originals untouched', { skip: needsRuntime, timeout: 300_000 }, async () => {
  const { base, root } = makeBase();
  const recent = path.join(root, 'RecentClips');
  const clip = (n, camera) => path.join(recent, `${stamp(n)}-${camera}.mp4`);
  const keep = path.join(base, 'originals');
  fs.mkdirSync(keep);
  const clips = {
    // the dropped sample has telemetry of its own: it moves to sample 15
    gap: { file: clip(0, 'left_repeater'), options: { frames: 54, skip: [16], telemetryPattern: telemetryFor(54, [30]) }, dropped: [16] },
    // two gaps, the second dropped sample without telemetry
    twice: { file: clip(1, 'right_repeater'), options: { frames: 60, skip: [16, 34], telemetryPattern: telemetryFor(60, [33]) }, dropped: [16, 33] },
    // a lead-in held on the first keyframe, and a gap later
    leadGap: { file: clip(2, 'back'), options: { frames: 54, cut: 7, skip: [27] }, dropped: [27], leadIn: 11 },
    normal: { file: clip(3, 'front'), options: { frames: 40 } },
    allowed: { file: clip(4, 'left_pillar'), options: { frames: 54, skip: [16] }, prepare: allowGaps },
    // a P slice header the detector cannot read (bytes H.264 forbids)
    unreadable: { file: clip(5, 'right_pillar'), options: { frames: 54, skip: [16], editSample: corruptSlice(10) } }
  };
  for (const [name, entry] of Object.entries(clips)) {
    entry.fx = await gapClip(entry.file, entry.options);
    entry.prepare?.(entry.file);
    entry.original = path.join(keep, `${name}.mp4`);
    fs.copyFileSync(entry.file, entry.original);
    entry.sha = sha(entry.file);
  }
  const env = await openRuntime(base);
  try {
    const job = await runJob(env.runtime, root, 'h265');
    const item = (entry) => job.items.find((candidate) => candidate.sourcePath === entry.file);
    const encodeArgs = (entry) => env.spawned.filter((spawned) => spawned.args.includes('pipe:1') && spawned.args.includes('-c:v')
      && spawned.args.some((arg) => arg.includes(path.basename(entry.file)) || arg.includes(item(entry).id))).at(-1).args;
    const plainArgs = buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: 250_000 });

    for (const name of ['gap', 'twice', 'leadGap']) {
      const entry = clips[name];
      assert.strictEqual(item(entry).state, 'completed', `${name}: ${JSON.stringify(item(entry).failure || item(entry).resultCode)}`);
      assert.strictEqual(item(entry).resultCode, 'converted');
      const args = encodeArgs(entry);
      if (entry.leadIn) assert.strictEqual(args[args.indexOf('-vf') + 1], `tpad=start=${entry.leadIn}:start_mode=clone`);
      else assert.deepStrictEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-an')), plainArgs, `${name}: encoded as any clip`);
      await assertGapConversion({ original: entry.original, converted: entry.file, fx: entry.fx, dropped: entry.dropped, inspect: inspectH265Telemetry });
    }

    // A normal clip: the same arguments and the encoder's own timing.
    assert.strictEqual(item(clips.normal).state, 'completed', JSON.stringify(item(clips.normal).failure));
    const normalArgs = encodeArgs(clips.normal);
    assert.deepStrictEqual(normalArgs.slice(normalArgs.indexOf('-c:v'), normalArgs.indexOf('-an')), plainArgs);
    assert.notStrictEqual((await packets(clips.normal.file)).timeBase, '1/10000', 'no retiming for a normal clip');

    // Gaps allowed, or a slice header that does not read: nothing excused,
    // the clip fails on its frame count exactly as before, nothing replaced.
    for (const name of ['allowed', 'unreadable']) {
      const entry = clips[name];
      assert.strictEqual(item(entry).state, 'failed', `${name}: ${item(entry).resultCode}`);
      assert.strictEqual(item(entry).failure.code, 'frame-count-mismatch', `${name}: ${JSON.stringify(item(entry).failure)}`);
      assert.strictEqual(sha(entry.file), entry.sha, `${name}: the original is untouched`);
    }
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('replace mode, AV1: a gap clip converts with exact timing, the same length and its telemetry 1:1', { skip: needsAv1, timeout: 300_000 }, async () => {
  const { base, root } = makeBase();
  const file = path.join(root, 'RecentClips', `${stamp(0)}-left_repeater.mp4`);
  const fx = await gapClip(file, { frames: 54, skip: [16], size: '320x240', telemetryPattern: telemetryFor(54, [40]) });
  const original = path.join(base, 'original.mp4');
  fs.copyFileSync(file, original);
  const env = await openRuntime(base);
  try {
    const job = await runJob(env.runtime, root, 'av1');
    assert.strictEqual(job.items[0].state, 'completed', JSON.stringify(job.items[0].failure));
    assert.strictEqual(job.items[0].resultCode, 'converted');
    const args = env.spawned.find((spawned) => spawned.args.includes('pipe:1') && spawned.args.includes('-c:v')).args;
    assert.strictEqual(args[args.indexOf('-c:v') + 1], 'libsvtav1');
    await assertGapConversion({ original, converted: file, fx, dropped: [16], inspect: inspectAv1Telemetry });
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});
