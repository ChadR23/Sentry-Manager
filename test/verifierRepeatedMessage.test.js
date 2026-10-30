'use strict';

// FFmpeg's log callback (libavutil/log.c) prints a message identical to the
// one before it only once, then "    Last message repeated N times" when the
// next different message arrives. A retimed frame_num-gap clip makes the null
// muxer print the same duplicate-DTS message several times in a row, so the
// verifier saw that repeat line as unknown stderr and refused a good file
// (HW4 2026-07-21 20-00-02 left_pillar and right_repeater). The repeat line is
// tolerated only when the message it repeats was tolerated.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { needsTool } = require('./fixtures/platformSkip');

const REPO = path.join(__dirname, '..');
const { verifyCandidate, withoutToleratedStderr } = require(path.join(REPO, 'src/main/converter/verifier'));
const { buildEncodeArgs } = require(path.join(REPO, 'src/main/converter/encoderPlanner'));
const { sourceTimingFor, retimeToSource } = require(path.join(REPO, 'src/main/converter/leadIn'));
const { extractH264TelemetryTimeline, mapTimelineToOutput } = require(path.join(REPO, 'src/main/converter/telemetryTimeline'));
const { injectH265Telemetry } = require(path.join(REPO, 'src/main/converter/h265Telemetry'));
const { outputTiming } = require(path.join(REPO, 'src/main/converter/converterAdapters'));
const { createMidGopTeslaH264Fixture, runProcess } = require('./fixtures/ffmpegFixtures');

const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString() || '';
const has = (name) => new RegExp(`\\s${name}\\s`).test(encoders);
const needsFfmpeg = needsTool(has('libx264') && has('libx265'), 'needs ffmpeg with libx264 and libx265');

const DUP = (n) => `[null @ 0x55911466dd00] Application provided invalid, non monotonically increasing dts to muxer in stream 0: ${n} >= ${n}`;
const REPEAT = (n) => `    Last message repeated ${n} times`;
const DECODER_ERROR = '[hevc @ 0x5632f4bb2380] Could not find ref with POC 12';

test('a repeat of a tolerated duplicate-DTS message is tolerated, any count, LF, CRLF or CR', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    assert.strictEqual(withoutToleratedStderr([DUP(31), REPEAT(2), ''].join(eol)), '');
    assert.strictEqual(withoutToleratedStderr([DUP(10), DUP(29), REPEAT(1), DUP(48), REPEAT(117), ''].join(eol)), '');
  }
  // As the HW4 night clips printed it: the same message twice, folded.
  assert.strictEqual(withoutToleratedStderr(`${DUP(1062)}\n${REPEAT(1)}\n${DUP(1555)}\n`), '');
  // A component prefix before the repeat text is accepted too.
  assert.strictEqual(withoutToleratedStderr(`${DUP(7)}\n[null @ 0x1] Last message repeated 3 times\n`), '');
});

test('a repeat of an intolerable message, or with no message before it, still fails', () => {
  assert.notStrictEqual(withoutToleratedStderr(`${DECODER_ERROR}\n${REPEAT(4)}\n`).trim(), '');
  assert.match(withoutToleratedStderr(`${DECODER_ERROR}\n${REPEAT(4)}\n`), /Last message repeated 4 times/);
  assert.match(withoutToleratedStderr(`${REPEAT(1)}\n`), /Last message repeated 1 times/);
  assert.match(withoutToleratedStderr(`\n\n${REPEAT(1)}\n${DUP(3)}\n`), /Last message repeated 1 times/);
  // Tolerated, then an error, then its repeat: the repeat belongs to the error.
  assert.match(withoutToleratedStderr(`${DUP(3)}\n${DECODER_ERROR}\n${REPEAT(2)}\n`), /Could not find ref[\s\S]*Last message repeated 2 times/);
  // A tolerated-looking message with anything appended is not tolerated, nor its repeat.
  assert.match(withoutToleratedStderr(`${DUP(3)} extra\n${REPEAT(2)}\n`), /extra[\s\S]*repeated 2 times/);
  // Not a repeat line: other text around it.
  assert.match(withoutToleratedStderr(`${DUP(3)}\n    Last message repeated 2 times, then crashed\n`), /crashed/);
  // A message from another muxer is not tolerated.
  assert.notStrictEqual(withoutToleratedStderr('[mp4 @ 0x1] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 3 >= 3\n'), '');
});

test('real FFmpeg: a retimed frame_num-gap clip whose decode prints "Last message repeated" verifies; foreign repeats fail', { skip: needsFfmpeg, timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-verify-repeat-'));
  try {
    const frames = 54;
    // Three very short samples in a row: the null muxer gives them one DTS,
    // so the same duplicate-DTS message comes out three times in a row.
    const durations = Array.from({ length: frames }, () => 400);
    durations[30] = durations[31] = durations[32] = 40;
    const source = path.join(dir, 'source.mp4');
    await createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: source, gop: 18, cut: 0, size: '160x120', frames, skip: [16], durations,
      telemetryPattern: Array.from({ length: frames }, (_, n) => Buffer.from([0x20, n & 0xff, n >> 8])) });
    const timeline = extractH264TelemetryTimeline(fs.readFileSync(source));
    assert.strictEqual(timeline.undecodable.frames, 1);
    const encoded = path.join(dir, 'encoded.mp4');
    const encode = await runProcess('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source,
      ...buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: 200_000 }), '-an', '-f', 'mp4', encoded]);
    assert.strictEqual(encode.status, 0, encode.stderr);
    const retimed = retimeToSource(fs.readFileSync(encoded), sourceTimingFor(timeline));
    const candidate = path.join(dir, 'candidate.mp4');
    fs.writeFileSync(candidate, injectH265Telemetry(retimed, mapTimelineToOutput(timeline, outputTiming(retimed))));

    const decodes = [];
    const run = (command, args, options) => runProcess(command, args, options);
    const recordDecode = async (command, args, options) => {
      const result = await runProcess(command, args, options);
      decodes.push(result);
      return result;
    };
    const verify = (runFullDecode) => verifyCandidate({ source, candidate, codec: 'h265', profileId: 'custom', runFfprobe: run, runFullDecode, verifyMode: 'full', sourceTimeline: timeline });
    const cleanup = (result) => { if (result?.publicationArtifact?.path) fs.rmSync(path.dirname(result.publicationArtifact.path), { recursive: true, force: true }); };

    const ok = await verify(recordDecode);
    cleanup(ok);
    // The condition the fix is for really happened in this decode.
    const stderr = decodes.map((result) => result.stderr).join('');
    assert.match(stderr, /non monotonically increasing dts to muxer in stream 0: (\d+) >= \1\r?\n {4}Last message repeated [1-9]\d* times/, stderr);
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.strictEqual(ok.details.outputFrames, frames - 2);

    // The same decode, its repeat line now following a real decoder error: refused.
    const withStderr = (text) => async (command, args, options) => ({ ...(await runProcess(command, args, options)), stderr: text });
    const refused = await verify(withStderr(`${DUP(31)}\n${DECODER_ERROR}\n${REPEAT(2)}\n`));
    cleanup(refused);
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'decode-failed');
    assert.strictEqual(refused.details.kind, 'stderr-output', JSON.stringify(refused.details));

    // A repeat line with nothing before it: refused.
    const orphan = await verify(withStderr(`${REPEAT(1)}\n`));
    cleanup(orphan);
    assert.strictEqual(orphan.ok, false);
    assert.strictEqual(orphan.reason, 'decode-failed');
    assert.strictEqual(orphan.details.kind, 'stderr-output', JSON.stringify(orphan.details));

    // Tolerated messages and their repeats only: accepted.
    const folded = await verify(withStderr(`${DUP(10)}\n${REPEAT(1)}\n${DUP(29)}\n${REPEAT(5)}\n`));
    cleanup(folded);
    assert.strictEqual(folded.ok, true, JSON.stringify(folded));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
