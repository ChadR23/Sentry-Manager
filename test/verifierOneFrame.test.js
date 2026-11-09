'use strict';
// An encode one frame off the original passes only when its length is
// within half the original's average frame (Sentry USB's basic verification).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { oneFrameOffLength } = require(path.join(__dirname, '..', 'src/main/converter/verifier'));

const timing = (frames, durationUs) => ({ samples: new Array(frames).fill({}), durationUs });

test('one frame off: within half an average frame passes, a whole frame shorter fails', () => {
  const src = timing(1800, 60_000_000); // 30 fps, 33,333 µs a frame: half is 16,666 µs
  assert.equal(oneFrameOffLength(src, timing(1799, 60_000_000)), null, 'the frame_num gap: same length');
  assert.equal(oneFrameOffLength(src, timing(1799, 59_990_000)), null, '10 ms short');
  assert.equal(oneFrameOffLength(src, timing(1801, 60_016_000)), null, 'one more, 16 ms longer');
  assert.deepEqual(oneFrameOffLength(src, timing(1799, 59_966_667)), { deltaUs: 33_333, toleranceUs: 16_666 }, 'last frame lost');
  assert.deepEqual(oneFrameOffLength(src, timing(1801, 60_020_000)), { deltaUs: 20_000, toleranceUs: 16_666 });
});

test('the same frame count, or more than one off, is left to the frame count checks', () => {
  const src = timing(1800, 60_000_000);
  assert.equal(oneFrameOffLength(src, timing(1800, 59_900_000)), null);
  assert.equal(oneFrameOffLength(src, timing(1798, 50_000_000)), null);
  assert.equal(oneFrameOffLength(null, timing(1800, 1)), null);
});
