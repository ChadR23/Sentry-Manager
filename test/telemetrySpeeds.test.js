'use strict';

// The viewer's speed graph: one average speed a second from a clip's records.

const test = require('node:test');
const assert = require('node:assert/strict');
const { speedOf, speedsOf } = require('../server/telemetry');

// a record with gear (field 2, varint), frame (3, varint) and speed (4, float)
function record(speed) {
  const f = Buffer.alloc(4);
  f.writeFloatLE(speed);
  return Buffer.concat([Buffer.from([0x10, 0x01, 0x18, 0x96, 0x01, 0x25]), f]).toString('base64');
}

test('speed graph: reads the speed field past the others', () => {
  assert.equal(Math.round(speedOf(record(12.5)) * 10), 125);
  assert.equal(speedOf(Buffer.from([0x10, 0x01]).toString('base64')), null);
  assert.equal(speedOf('###'), null);
});

test('speed graph: averages each second and leaves gaps empty', () => {
  const body = JSON.stringify({ frames: [[1000, record(10)], [1500, record(20)], [3200, record(5)]] });
  assert.deepEqual(speedsOf(body), [15, null, 5]);
  assert.equal(speedsOf('{"frames":[]}'), null);
  assert.equal(speedsOf('not json'), null);
});

test('speed graph: the quick reader finds one record a second without reading the clip', async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createTeslaH264Fixture } = require('./fixtures/ffmpegFixtures');
  const { readSpeeds } = require('../server/speedReader');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speeds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clip = path.join(dir, 'clip.mp4');
  const f = Buffer.alloc(4);
  // 12 frames a second for 4 s: frame n drives n m/s; second 2 has no records
  const pattern = Array.from({ length: 48 }, (_, n) => {
    if (n >= 24 && n < 36) return null;
    f.writeFloatLE(n);
    return Buffer.concat([Buffer.from([0x10, 0x01, 0x25]), f]);
  });
  await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: clip, telemetryPattern: pattern, size: '160x120' });
  assert.deepEqual(await readSpeeds(clip), [0, 12, null, 36]);
  // the straight read (a few long reads) finds the same
  assert.deepEqual(await readSpeeds(clip, { mode: 'straight' }), [0, 12, null, 36]);
  // not an MP4: the caller falls back to the full read
  const junk = path.join(dir, 'junk.mp4');
  fs.writeFileSync(junk, Buffer.alloc(100, 7));
  await assert.rejects(readSpeeds(junk));
});

test('speed graph: the quick reader reads converted H.265 and AV1 clips like the full read', { timeout: 120_000 }, async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createTeslaH264Fixture, runProcess } = require('./fixtures/ffmpegFixtures');
  const { buildEncodeArgs } = require('../src/main/converter/encoderPlanner');
  const { extractH264TelemetryTimeline, mapTimelineToOutput } = require('../src/main/converter/telemetryTimeline');
  const { injectH265Telemetry } = require('../src/main/converter/h265Telemetry');
  const { injectAv1Telemetry } = require('../src/main/converter/av1Telemetry');
  const { outputTiming } = require('../src/main/converter/converterAdapters');
  const { Telemetry } = require('../server/telemetry');
  const { readSpeeds } = require('../server/speedReader');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speeds-conv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4');
  const f = Buffer.alloc(4);
  // (no 00 00 0x run in the floats: the converter only carries well-formed SEI)
  const pattern = Array.from({ length: 48 }, (_, n) => { f.writeFloatLE(0.3 + n / 2); return Buffer.concat([Buffer.from([0x10, 0x01, 0x25]), f]); });
  await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: source, telemetryPattern: pattern, size: '160x120' });
  const timeline = extractH264TelemetryTimeline(fs.readFileSync(source));
  const full = new Telemetry({ srcRoot: path.join(__dirname, '..', 'src'), cacheDir: path.join(dir, 'cache') });
  for (const [codec, encoder, inject] of [['h265', 'libx265', injectH265Telemetry], ['av1', 'libsvtav1', injectAv1Telemetry]]) {
    const encoded = path.join(dir, `${codec}.enc.mp4`);
    const r = await runProcess('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source, ...buildEncodeArgs({ codec, encoder, bitrate: 200_000 }), '-an', '-f', 'mp4', encoded]);
    if (r.status !== 0) { t.diagnostic(`${encoder} unavailable: ${r.stderr}`); continue; }
    const bytes = fs.readFileSync(encoded);
    const out = path.join(dir, `${codec}.mp4`);
    fs.writeFileSync(out, inject(bytes, mapTimelineToOutput(timeline, outputTiming(bytes))));
    // the full read's first record of each second
    const frames = JSON.parse(await full.read(out, fs.statSync(out).size)).frames;
    assert.ok(frames.length > 40, `${codec}: the full read found the records`);
    assert.deepEqual(await readSpeeds(out), [0.3, 6.3, 12.3, 18.3], codec);
    assert.deepEqual(await readSpeeds(out, { mode: 'straight' }), [0.3, 6.3, 12.3, 18.3], codec + ' straight');
  }
});
