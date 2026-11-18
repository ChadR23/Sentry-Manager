'use strict';

// With B-frames an encoder stores pictures 0 3 1 2 6 4 5 ...: each P picture
// before the B pictures shown ahead of it. A clip's n-th frame's telemetry
// belongs to the n-th picture shown, not to the n-th sample in the file.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { mapTimelineToOutput } = require(path.join(REPO, 'src/main/converter/telemetryTimeline'));

const FRAME_US = 33_333;
const ORDER = [0, 3, 1, 2, 6, 4, 5, 9, 7, 8, 11, 10];

function record(n) {
  return { nal: Buffer.from([6, n]), fingerprint: `f${n}` };
}

function timeline(count, { tail = false, undecodable = null } = {}) {
  const samples = Array.from({ length: count }, (_, index) => ({
    sampleIndex: index,
    ptsUs: index * FRAME_US,
    durationUs: tail && index === count - 1 ? 0 : FRAME_US,
    hasTelemetry: true,
    seiNals: [record(index)]
  }));
  const events = samples.map((sample) => ({ sourceSampleIndex: sample.sampleIndex, sourcePtsUs: sample.ptsUs, ...sample.seiNals[0] }));
  return { samples, events, ...(undecodable ? { undecodable } : {}) };
}

const reordered = (order) => order.map((shown) => ({ ptsUs: shown * FRAME_US, durationUs: FRAME_US }));
const records = (sample) => sample.seiNals.map((entry) => entry.fingerprint);

test('each frame\'s records go to the picture shown in its place', () => {
  const mapped = mapTimelineToOutput(timeline(12), reordered(ORDER));
  ORDER.forEach((shown, sample) => assert.deepStrictEqual(records(mapped[sample]), [`f${shown}`], `sample ${sample}`));
});

test('a zero-duration tail goes to the last picture shown, not the last sample', () => {
  const mapped = mapTimelineToOutput(timeline(13, { tail: true }), reordered(ORDER));
  assert.deepStrictEqual(records(mapped[10]), ['f11', 'f12']);
  assert.deepStrictEqual(records(mapped[11]), ['f10']);
});

test('a sample no decoder outputs goes to the picture shown before it', () => {
  const mapped = mapTimelineToOutput(timeline(13, { undecodable: { frames: 1, samples: [4] } }), reordered(ORDER));
  assert.deepStrictEqual(records(mapped[1]), ['f3', 'f4']);
  assert.deepStrictEqual(records(mapped[5]), ['f5']);
  assert.deepStrictEqual(records(mapped[4]), ['f7']);
});

test('frames in file order map as before', () => {
  const inOrder = Array.from({ length: 12 }, (_, index) => index);
  const mapped = mapTimelineToOutput(timeline(12), reordered(inOrder));
  inOrder.forEach((index) => assert.deepStrictEqual(records(mapped[index]), [`f${index}`]));
});
