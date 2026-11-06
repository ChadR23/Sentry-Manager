'use strict';

// Scrub previews (server/scrubFrames.js): one frame per second of a clip in
// one JPEG grid, made once from the keyframes and cached; the next clip of
// the same camera is prepared in the background.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createScrubFrames, COLS, ROWS, FRAME_WIDTH } = require('../server/scrubFrames');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const size = (file) => spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim();

function clip(file, seconds) {
  // a keyframe every second, like Tesla's
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=s=320x240:r=30:d=${seconds}`, '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', file]);
  assert.equal(r.status, 0, String(r.stderr));
}

test('a grid per clip: one frame a second, cached, remade when the clip changes, the next clip prepared', { skip: !hasFfmpeg && 'needs ffmpeg', timeout: 60000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-scrub-'));
  try {
    const cams = path.join(dir, 'RecentClips');
    await fsp.mkdir(cams);
    const a = path.join(cams, '2026-11-05_10-00-00-front.mp4');
    const b = path.join(cams, '2026-11-05_10-01-00-front.mp4');
    const other = path.join(cams, '2026-11-05_10-01-00-back.mp4');
    clip(a, 12);
    clip(b, 5);
    clip(other, 5);
    const store = path.join(dir, 'scrub');
    const frames = createScrubFrames({ directory: store, ffmpegPath: 'ffmpeg', spawn });
    const grid = await frames.get(a);
    assert.ok(grid && fs.existsSync(grid));
    assert.equal(size(grid), `${COLS * FRAME_WIDTH},${ROWS * 180}`, '10 x 7 frames of 240 x 180');
    // asked again: the same file, not made again
    const at = fs.statSync(grid).ino;
    assert.equal(await frames.get(a), grid);
    assert.equal(fs.statSync(grid).ino, at);
    // the next clip of the same camera is made in the background (not the other camera)
    for (let i = 0; i < 100 && fs.readdirSync(store).filter((n) => n.endsWith('.jpg')).length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.readdirSync(store).filter((n) => n.endsWith('.jpg')).length, 2);
    assert.ok(fs.existsSync(await frames.get(b, { next: false })));
    // a changed clip gets a new grid
    clip(a, 3);
    const again = await frames.get(a, { next: false });
    assert.notEqual(again, grid);
    // nothing that is not a video
    assert.equal(await frames.get(path.join(dir, 'notes.txt')), null);
    await fsp.writeFile(path.join(cams, 'broken-front.mp4'), Buffer.alloc(4096, 7));
    assert.equal(await frames.get(path.join(cams, 'broken-front.mp4')), null);
    // no temporary files left
    assert.deepEqual(fs.readdirSync(store).filter((n) => n.includes('.tmp')), []);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the cache stays bounded: the oldest grids go first', { skip: !hasFfmpeg && 'needs ffmpeg', timeout: 60000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-scrub-'));
  try {
    const store = path.join(dir, 'scrub');
    await fsp.mkdir(store);
    for (let i = 0; i < 5; i++) {
      const f = path.join(store, `old${i}.jpg`);
      await fsp.writeFile(f, 'x');
      const t = new Date(Date.now() - (10 - i) * 60000);
      await fsp.utimes(f, t, t);
    }
    const a = path.join(dir, '2026-11-05_10-00-00-front.mp4');
    clip(a, 2);
    const frames = createScrubFrames({ directory: store, ffmpegPath: 'ffmpeg', spawn, maxCached: 3 });
    assert.ok(await frames.get(a, { next: false }));
    const left = fs.readdirSync(store).filter((n) => n.endsWith('.jpg')).sort();
    assert.ok(!left.includes('old0.jpg') && !left.includes('old1.jpg'), `the oldest went: ${left}`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
