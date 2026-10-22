'use strict';

// Footage by day: the codec read from an MP4's header (moov at the start or
// the end), and the per-day summary behind the day cards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { videoCodec } = require('../server/mp4codec');
const { buildRecordings, summarizeDays } = require('../server/inventory');

const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString() || '';

test('the video codec comes from the MP4 header, wherever the moov box is', { skip: !encoders, timeout: 60000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-codec-'));
  try {
    const cases = [['libx264', 'h264', []], ['libx264', 'h264', ['-movflags', '+faststart']], ['libx265', 'h265', []], ['libsvtav1', 'av1', []]];
    for (const [encoder, want, flags] of cases) {
      if (!encoders.includes(` ${encoder} `)) continue;
      const file = path.join(dir, `${encoder}${flags.length ? '-fast' : ''}.mp4`);
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '1', '-c:v', encoder,
        ...(encoder === 'libx265' ? ['-x265-params', 'log-level=error'] : []), '-pix_fmt', 'yuv420p', ...flags, file]);
      assert.equal(r.status, 0, r.stderr?.toString());
      assert.equal(await videoCodec(file), want, `${encoder} ${flags.join(' ')}`);
    }
    // not an MP4, or cut off before the moov: no codec
    await fsp.writeFile(path.join(dir, 'junk.mp4'), Buffer.from('not a video at all'));
    assert.equal(await videoCodec(path.join(dir, 'junk.mp4')), null);
    const whole = await fsp.readFile(path.join(dir, 'libx264.mp4'));
    await fsp.writeFile(path.join(dir, 'cut.mp4'), whole.subarray(0, 64));
    assert.equal(await videoCodec(path.join(dir, 'cut.mp4')), null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('days: newest first, counts, minutes, the thumbnail recording and how much is encoded', () => {
  const files = new Map();
  const add = (rel, extra = {}) => files.set(rel, { rel, size: 100, mtimeMs: 1, kind: 'clip', camera: 'front', day: rel.match(/(\d{4}-\d{2}-\d{2})_/)[1], ...extra });
  add('TeslaCam/RecentClips/2026-10-20_08-00-00-front.mp4', { type: 'RecentClips' });
  add('TeslaCam/RecentClips/2026-10-20_08-01-00-front.mp4', { type: 'RecentClips' });
  add('TeslaCam/RecentClips/2026-10-21_07-00-00-front.mp4', { type: 'RecentClips' });
  add('TeslaCam/SentryClips/2026-10-21_12-15-00/2026-10-21_12-14-00-front.mp4', { type: 'SentryClips', eventId: '2026-10-21_12-15-00' });
  add('TeslaCam/SentryClips/2026-10-21_12-15-00/2026-10-21_12-14-00-back.mp4', { type: 'SentryClips', eventId: '2026-10-21_12-15-00', camera: 'back' });
  const recordings = buildRecordings(files, { vehicleId: 'car' });
  const codecs = new Map([
    ['TeslaCam/RecentClips/2026-10-20_08-00-00-front.mp4', { codec: 'h265' }],
    ['TeslaCam/RecentClips/2026-10-20_08-01-00-front.mp4', { codec: 'h265' }],
    ['TeslaCam/RecentClips/2026-10-21_07-00-00-front.mp4', { codec: 'h264' }],
    ['TeslaCam/SentryClips/2026-10-21_12-15-00/2026-10-21_12-14-00-front.mp4', { codec: 'av1' }]
    // the Sentry back camera has not been read yet
  ]);
  const days = summarizeDays(recordings, codecs);
  assert.deepEqual(days.map((d) => d.day), ['2026-10-21', '2026-10-20']);
  const [oct21, oct20] = days;
  assert.deepEqual(oct21.byCategory, { Recent: 1, Sentry: 1 });
  assert.equal(oct21.thumbId, recordings.find((r) => r.category === 'Sentry').id, 'an event stands for the day before a drive');
  assert.deepEqual([oct21.clips, oct21.encoded, oct21.unknown, oct21.encodedRecordings, oct21.codecs], [3, 1, 1, 0, ['av1']]);
  assert.deepEqual([oct20.recordings, oct20.minutes, oct20.encodedRecordings, oct20.codecs], [1, 2, 1, ['h265']]);
  assert.equal(oct20.bytes, 200);
});
