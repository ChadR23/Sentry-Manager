'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isWithinProfile } = require('../src/main/converter/contracts');
const { verifyCandidate } = require('../src/main/converter/verifier');
const { createVerificationSnapshot } = require('../src/main/converter/verificationSnapshot');
const { buildEncodeArgs } = require('../src/main/converter/encoderPlanner');
const { extractH264TelemetryTimeline, mapTimelineToOutput } = require('../src/main/converter/telemetryTimeline');
const { outputTiming } = require('../src/main/converter/converterAdapters');
const { injectH265Telemetry } = require('../src/main/converter/h265Telemetry');
const { injectAv1Telemetry } = require('../src/main/converter/av1Telemetry');
const { box } = require('./fixtures/fixtureBuilders');
const { createTeslaH264Fixture, runProcess } = require('./fixtures/ffmpegFixtures');

// Literal byte limits for a 1 MB source; keep the existing upper tolerance.
const profiles = [
  { id: 'conservative', oldLower: 930_000, target: 950_000, upper: 970_000 },
  { id: 'balanced', oldLower: 780_000, target: 800_000, upper: 820_000 },
  { id: 'aggressive', oldLower: 480_000, target: 500_000, upper: 520_000 }
];
const modes = ['off', 'quick', 'full'];

for (const profile of profiles) {
  test(`${profile.id} accepts extra savings and still enforces its upper size limit`, () => {
    for (const output of [1, 100_000, profile.oldLower - 1, profile.oldLower, profile.target, profile.upper]) {
      assert.equal(isWithinProfile(1_000_000, output, profile.id), true, `${output} bytes`);
    }
    assert.equal(isWithinProfile(1_000_000, profile.upper + 1, profile.id), false);
    assert.equal(isWithinProfile(1_000_000, 1_000_000, profile.id), false);
  });
}

test('Balanced accepts recorded below-target sizes but still rejects the two over-limit outputs', () => {
  for (const [source, output, accepted] of [
    [25_909_775, 20_204_641, true], // right repeater: just 4,984 bytes below the old lower bound
    [9_763_242, 7_499_006, true], // front
    [29_734_968, 4_914_281, true], // right pillar's first attempt, before the old upward correction
    [29_734_968, 25_613_967, false], // right pillar's historical final retry
    [25_073_277, 20_983_151, false] // left repeater's final retry
  ]) {
    assert.equal(isWithinProfile(source, output, 'balanced'), accepted, `${output}/${source}`);
  }
});

test('accepting smaller sizes never admits missing or empty candidates', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-profile-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4');
  fs.writeFileSync(source, Buffer.alloc(1000));
  const empty = path.join(dir, 'empty.mp4');
  fs.writeFileSync(empty, Buffer.alloc(0));
  for (const verifyMode of modes) {
    for (const [candidate, reason] of [[empty, 'empty-output'], [path.join(dir, 'missing.mp4'), 'candidate-unreadable']]) {
      const result = await verifyCandidate({
        source, candidate, codec: 'h265', profileId: 'balanced', verifyMode,
        runFfprobe: runProcess, runFullDecode: runProcess
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, reason, verifyMode);
      assert.equal(result.publicationArtifact, undefined);
    }
  }
});

const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString() || '';
const has = (encoder) => new RegExp(`\\s${encoder}\\s`).test(encoders);

// Appending a valid free box controls file size without changing video,
// timestamps or telemetry, so all size boundaries use the same real clip.
function padTo(bytes, size) {
  assert.ok(size - bytes.length >= 8, 'fixture must leave room for a free box');
  return Buffer.concat([bytes, box('free', Buffer.alloc(size - bytes.length - 8))]);
}

for (const [codec, encoder, inject] of [
  ['h265', 'libx265', injectH265Telemetry],
  ['av1', 'libsvtav1', injectAv1Telemetry]
]) {
  test(`${codec}: smaller candidates still pass the actual verifier in Off, Quick and Full`, {
    skip: has('libx264') && has(encoder) ? false : `needs ffmpeg with libx264 and ${encoder}`,
    timeout: 120_000
  }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-profile-video-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = path.join(dir, 'source.mp4');
    await createTeslaH264Fixture({
      ffmpegPath: 'ffmpeg', outputPath: source, size: '160x120', durationSeconds: 4, frameRate: 12,
      telemetryPattern: Array.from({ length: 48 }, (_, n) => Buffer.from([0x20, n]))
    });
    fs.writeFileSync(source, padTo(fs.readFileSync(source), 1_000_000));
    const timeline = extractH264TelemetryTimeline(fs.readFileSync(source));
    const encoded = path.join(dir, 'encoded.mp4');
    const made = await runProcess('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source,
      ...buildEncodeArgs({ codec, encoder, bitrate: 250_000 }), '-an', '-f', 'mp4', encoded]);
    assert.equal(made.status, 0, made.stderr);
    const bytes = fs.readFileSync(encoded);
    const converted = inject(bytes, mapTimelineToOutput(timeline, outputTiming(bytes)));
    assert.ok(converted.length < 480_000, 'fixture must be below every old lower bound');
    const candidate = path.join(dir, 'candidate.mp4');
    let decodeCalls = 0;
    const verify = (profileId, verifyMode) => verifyCandidate({
      source, candidate, codec, profileId, verifyMode, sourceDurationUs: 4_000_000,
      runFfprobe: runProcess,
      runFullDecode: (...args) => { decodeCalls += 1; return runProcess(...args); },
      createSnapshot: (options) => createVerificationSnapshot({ ...options, tempRoot: dir })
    });

    for (const verifyMode of modes) {
      for (const profile of profiles) {
        await t.test(`${verifyMode}/${profile.id}: extra savings, upper boundary and one byte over`, async () => {
          for (const [output, accepted] of [[converted, true], [padTo(converted, profile.upper), true], [padTo(converted, profile.upper + 1), false]]) {
            fs.writeFileSync(candidate, output);
            const before = decodeCalls;
            const result = await verify(profile.id, verifyMode);
            assert.equal(result.ok, accepted, JSON.stringify(result));
            assert.equal(decodeCalls - before, verifyMode === 'full' ? 1 : 0, 'the requested verification depth must be preserved');
            if (accepted) {
              assert.equal(result.details.verifyMode, verifyMode);
              assert.equal(result.publicationArtifact.size, output.length);
              assert.deepEqual(fs.readFileSync(result.publicationArtifact.path), output);
              fs.rmSync(path.dirname(result.publicationArtifact.path), { recursive: true, force: true });
            } else {
              assert.equal(result.reason, 'profile-size');
              assert.equal(result.retryable, true);
              assert.equal(result.publicationArtifact, undefined);
            }
          }
        });
      }

      await t.test(`${verifyMode}: equal or larger output is still refused`, async () => {
        for (const size of [1_000_000, 1_000_001]) {
          fs.writeFileSync(candidate, padTo(converted, size));
          const result = await verify('balanced', verifyMode);
          assert.equal(result.ok, false);
          assert.equal(result.reason, 'not-smaller');
          assert.equal(result.publicationArtifact, undefined);
        }
      });
    }

    for (const verifyMode of ['quick', 'full']) {
      await t.test(`${verifyMode}: extra savings cannot bypass telemetry or container checks`, async () => {
        fs.writeFileSync(candidate, bytes); // Valid video, but the Tesla telemetry was not restored.
        const missingTelemetry = await verify('balanced', verifyMode);
        assert.equal(missingTelemetry.ok, false);
        assert.equal(missingTelemetry.reason, 'telemetry-invalid');
        assert.equal(missingTelemetry.publicationArtifact, undefined);
        fs.writeFileSync(candidate, converted.subarray(0, 32));
        const truncated = await verify('balanced', verifyMode);
        assert.equal(truncated.ok, false);
        assert.equal(truncated.reason, 'probe-failed');
        assert.equal(truncated.publicationArtifact, undefined);
      });
    }
  });
}
