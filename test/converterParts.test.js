'use strict';

// An archive bigger than one job: a job takes at most jobClipLimit clips
// (the job file holds 50,000, converted clips counted too), then stops
// discovering and finishes; the next part starts by itself and carries on
// right after the last clip the previous part took, until every clip is done
// once. Here the limit is 3 and the folder has 8 originals and 2 converted.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const { createConverterRuntime } = require(path.join(REPO, 'src/main/converter/runtime'));
const { compareScanPaths } = require(path.join(REPO, 'src/main/converter/scanner'));
const { createPosixOwnedFs } = require(path.join(REPO, 'server/posixOwnedFs'));
const { RETRYABLE } = require(path.join(REPO, 'server/converterHost'));
const { createTeslaH264Fixture } = require('./fixtures/ffmpegFixtures');

const HELPER = path.join(REPO, 'build', 'noreplace-rename');
const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString() || '';
const skip = /\slibx265\s/.test(encoders) && fs.existsSync(HELPER) ? false : 'needs ffmpeg with libx265 and build/noreplace-rename';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = (n) => new Date(Date.UTC(2025, 0, 1) + n * 60_000).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');

test('the scan order: groups first in their order, then names; a folder before what is inside it', () => {
  const order = ['SavedClips', 'SentryClips', 'RecentClips'];
  const paths = ['RecentClips/b.mp4', 'SentryClips/2026-01-02_10-00-00/x.mp4', 'RecentClips/a.mp4', 'SavedClips/z/a.mp4', 'SentryClips/2026-01-01_09-00-00/y.mp4'];
  assert.deepStrictEqual(paths.slice().sort((a, b) => compareScanPaths(a, b, order)),
    ['SavedClips/z/a.mp4', 'SentryClips/2026-01-01_09-00-00/y.mp4', 'SentryClips/2026-01-02_10-00-00/x.mp4', 'RecentClips/a.mp4', 'RecentClips/b.mp4']);
  assert.strictEqual(compareScanPaths('RecentClips/a.mp4', 'RecentClips/a.mp4', order), 0);
  assert.strictEqual(compareScanPaths('RecentClips', 'RecentClips/a.mp4', order), -1);
});

test('a conversion bigger than one job runs as parts, each clip converted exactly once', { skip, timeout: 300_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-parts-'));
  try {
    for (const dir of ['data', 'temp', 'footage/TeslaCam/RecentClips', 'out']) fs.mkdirSync(path.join(base, dir), { recursive: true });
    const root = fs.realpathSync(path.join(base, 'footage', 'TeslaCam'));
    const original = path.join(base, 'original.mp4');
    await createTeslaH264Fixture({
      ffmpegPath: 'ffmpeg', outputPath: original, durationSeconds: 2, frameRate: 12, size: '160x120', spatialNoise: 4,
      telemetryPattern: Array.from({ length: 24 }, (_, n) => Buffer.from([0x20, n]))
    });
    const converted = path.join(base, 'converted.mp4');
    assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=12:duration=1',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', converted]).status, 0);
    const names = [];
    for (let n = 0; n < 10; n += 1) {
      const name = `${stamp(n)}-front.mp4`;
      // two already converted, among the originals
      fs.copyFileSync(n === 1 || n === 6 ? converted : original, path.join(root, 'RecentClips', name));
      names.push(name);
    }
    process.env.SENTRY_NOREPLACE_RENAME = HELPER;
    const owned = createPosixOwnedFs();
    const runtime = await createConverterRuntime({
      userDataPath: fs.realpathSync(path.join(base, 'data')), tempPath: fs.realpathSync(path.join(base, 'temp')),
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', fs, pathApi: path, platform: process.platform, spawn: require('child_process').spawn,
      removeOwned: owned.removeOwned, renameExclusive: owned.renameExclusive, autoConvert: false, gpuDecode: false,
      jobClipLimit: 3,
      network: { isRetryable: (error) => RETRYABLE.has(error?.code), checkPath: async (t) => fs.promises.access(t).then(() => true, () => false) }
    });
    await runtime.start();
    try {
      const first = await runtime.service.start({
        sourceRoot: root, destinationRoot: path.join(base, 'out'), codec: 'h265', profileId: 'custom', bitrateKbps: 250,
        networkMode: 'direct', outputMode: 'separate', includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'],
        groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'], replacementConfirmed: false, concurrency: 1, verifyMode: 'quick'
      });
      // parts follow one another until one ends without more to do
      const parts = [];
      let id = first;
      for (let p = 1; p <= 6; p += 1) {
        await runtime.service.whenIdle(id);
        const job = await runtime.service.get(id);
        parts.push(job);
        if (!job.moreAfter) break;
        let next = null;
        for (let i = 0; i < 100 && !next; i += 1) {
          await sleep(100);
          next = (await runtime.service.list()).find((j) => j.config.part === p + 1);
        }
        assert.ok(next, `part ${p + 1} started by itself`);
        assert.strictEqual(next.config.resumeAfter, job.moreAfter, 'it starts right after the last clip of the part before');
        id = next.id;
      }
      assert.deepStrictEqual(parts.map((j) => j.state), ['completed', 'completed', 'completed', 'completed']);
      assert.deepStrictEqual(parts.map((j) => j.items.length), [3, 3, 3, 1], 'at most 3 clips a job');
      assert.deepStrictEqual(parts.map((j) => j.config.part || 1), [1, 2, 3, 4]);
      assert.strictEqual(parts[3].moreAfter, undefined, 'the last part ends the conversion');
      // every clip exactly once, in scan order, across the parts
      const all = parts.flatMap((j) => j.items.map((item) => item.relativePath));
      assert.deepStrictEqual(all, names.map((n) => `RecentClips/${n}`));
      const states = parts.flatMap((j) => j.items.map((item) => item.state));
      assert.strictEqual(states.filter((s) => s === 'completed').length, 8, 'the 8 originals converted');
      assert.strictEqual(states.filter((s) => s === 'skipped').length, 2, 'the 2 converted ones skipped');
      assert.strictEqual(fs.readdirSync(path.join(base, 'out', 'RecentClips')).length, 8);
    } finally {
      await runtime.stop?.();
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
