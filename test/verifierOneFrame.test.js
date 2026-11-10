'use strict';
// An encode one frame off the original passes only when its length is
// within three quarters of the original's average frame (Sentry USB's basic
// verification, test.18 and later).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { oneFrameOffLength } = require(path.join(__dirname, '..', 'src/main/converter/verifier'));

const timing = (frames, durationUs) => ({ samples: new Array(frames).fill({}), durationUs });

test('one frame off: within three quarters of an average frame passes, a whole frame shorter fails', () => {
  const src = timing(1800, 60_000_000); // 30 fps, 33,333 µs a frame: three quarters is 25,000 µs
  assert.equal(oneFrameOffLength(src, timing(1799, 60_000_000)), null, 'the frame_num gap: same length');
  assert.equal(oneFrameOffLength(src, timing(1799, 59_990_000)), null, '10 ms short');
  assert.equal(oneFrameOffLength(src, timing(1799, 59_980_000)), null, '0.6 of a frame short (what real clips do)');
  assert.equal(oneFrameOffLength(src, timing(1801, 60_025_000)), null, 'one more, exactly three quarters longer');
  assert.deepEqual(oneFrameOffLength(src, timing(1799, 59_966_667)), { deltaUs: 33_333, toleranceUs: 25_000 }, 'last frame lost');
  assert.deepEqual(oneFrameOffLength(src, timing(1801, 60_026_000)), { deltaUs: 26_000, toleranceUs: 25_000 });
});

test('the same frame count, or more than one off, is left to the frame count checks', () => {
  const src = timing(1800, 60_000_000);
  assert.equal(oneFrameOffLength(src, timing(1800, 59_900_000)), null);
  assert.equal(oneFrameOffLength(src, timing(1798, 50_000_000)), null);
  assert.equal(oneFrameOffLength(null, timing(1800, 1)), null);
});
