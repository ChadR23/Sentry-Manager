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
