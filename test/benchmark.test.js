'use strict';

// The Encoder benchmark tries every parallel level up to 8, even when going
// higher stops helping, and gives every slot a clip of its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { runConverterBenchmark } = require('../src/main/converter/benchmark');

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-bench-'));
  const clip = path.join(dir, '2026-10-20_17-00-00-front.mp4');
  await fsp.writeFile(clip, 'clip');
  return { dir, clips: [{ sourcePath: clip, name: path.basename(clip) }] };
}

test('every level up to 8 runs, with a clip of its own for each slot', async () => {
  const { dir, clips } = await setup();
  const seen = [];
  try {
    const out = await runConverterBenchmark({
      clips, tempRoot: dir, countFrames: async () => 100,
      runLevel: async ({ level, sourceRoot }) => {
        const names = fs.readdirSync(path.join(sourceRoot, 'RecentClips'));
        const inodes = new Set(names.map((n) => fs.statSync(path.join(sourceRoot, 'RecentClips', n)).ino));
        seen.push({ level, names, inodes: inodes.size });
        // no faster after 2: the old benchmark stopped at 4
        return { items: names.map((n) => ({ state: 'completed', relativePath: `RecentClips/${n}` })) };
      }
    });
    assert.deepEqual(out.results.map((r) => r.level), [1, 2, 4, 6, 8]);
    assert.deepEqual(seen.map((s) => s.names.length), [2, 2, 4, 6, 8]);
    for (const s of seen) {
      assert.equal(s.inodes, s.names.length, `level ${s.level}: separate files`);
      assert.ok(s.names.every((n) => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-front\.mp4$/.test(n)), 'Tesla-style names');
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a level that fails ends the sweep there', async () => {
  const { dir, clips } = await setup();
  try {
    const out = await runConverterBenchmark({
      clips, tempRoot: dir, countFrames: async () => 100,
      runLevel: async ({ level, sourceRoot }) => ({
        items: fs.readdirSync(path.join(sourceRoot, 'RecentClips')).map((n) => ({ state: level >= 6 ? 'failed' : 'completed', relativePath: `RecentClips/${n}` }))
      })
    });
    assert.deepEqual(out.results.map((r) => [r.level, r.ok]), [[1, true], [2, true], [4, true], [6, false]]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a clip that fails verification on its own is left out, not the whole benchmark', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-bench-'));
  const clips = [];
  for (const cam of ['front', 'back', 'left_repeater']) {
    const clip = path.join(dir, `2026-10-20_17-00-00-${cam}.mp4`);
    await fsp.writeFile(clip, cam);
    clips.push({ sourcePath: clip, name: path.basename(clip) });
  }
  try {
    const out = await runConverterBenchmark({
      clips, tempRoot: dir, countFrames: async () => 100,
      runLevel: async ({ sourceRoot }) => ({
        // the back camera clip (and copies made from it) never verifies
        items: fs.readdirSync(path.join(sourceRoot, 'RecentClips')).map((n) => {
          const back = fs.readFileSync(path.join(sourceRoot, 'RecentClips', n), 'utf8') === 'back';
          return back
            ? { state: 'failed', relativePath: `RecentClips/${n}`, failure: { code: 'duration-mismatch' } }
            : { state: 'completed', relativePath: `RecentClips/${n}` };
        })
      })
    });
    assert.deepEqual(out.results.map((r) => [r.level, r.ok]), [[1, true], [2, true], [4, true], [6, true], [8, true]]);
    assert.deepEqual(out.skipped, [{ name: '2026-10-20_17-00-00-back.mp4', code: 'duration-mismatch' }]);
    assert.equal(out.clips, 2);
    assert.ok(out.best, 'a recommendation from the clips that work');
    assert.ok(out.results.every((r) => !('failedItems' in r)), 'internal bookkeeping stays inside');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('when the only clip fails on its own, the benchmark says why', async () => {
  const { dir, clips } = await setup();
  try {
    const out = await runConverterBenchmark({
      clips, tempRoot: dir, countFrames: async () => 100,
      runLevel: async ({ sourceRoot }) => ({
        items: fs.readdirSync(path.join(sourceRoot, 'RecentClips')).map((n) => ({ state: 'failed', relativePath: `RecentClips/${n}`, failure: { code: 'duration-mismatch' } }))
      })
    });
    assert.deepEqual(out.results.map((r) => [r.level, r.ok, r.failures]), [[1, false, ['duration-mismatch']]]);
    assert.equal(out.best, null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a clip that only fails when many run at once is kept: the level is the limit', async () => {
  const { dir, clips } = await setup();
  try {
    const out = await runConverterBenchmark({
      clips, tempRoot: dir, countFrames: async () => 100,
      runLevel: async ({ level, sourceRoot }) => ({
        items: fs.readdirSync(path.join(sourceRoot, 'RecentClips')).map((n) => (level >= 6
          ? { state: 'failed', relativePath: `RecentClips/${n}`, failure: { code: 'decode-failed' } }
          : { state: 'completed', relativePath: `RecentClips/${n}` }))
      })
    });
    assert.deepEqual(out.results.map((r) => [r.level, r.ok]), [[1, true], [2, true], [4, true], [6, false]]);
    assert.deepEqual(out.skipped, []);
    assert.equal(out.clips, 1);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
