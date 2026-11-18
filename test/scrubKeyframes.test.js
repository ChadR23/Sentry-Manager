'use strict';

// Scrub previews from the keyframes alone (server/scrubKeyframes.js): the same
// grid as FFmpeg's -skip_frame nokey over the whole clip, byte for byte, while
// reading only the keyframe samples.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { keyframePlan, picksFor } = require('../server/scrubKeyframes');
const { createScrubFrames } = require('../server/scrubFrames');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('which keyframe shows each second: as the fps filter (round near, eof pass) picks it', () => {
  const k = (pts, duration = 10, index = pts) => ({ pts, duration, index });
  // timescale 100: keyframes at 0, 0.4, 1.6, 2.4 s; the last ends at 2.5 s
  const keys = [k(0), k(40), k(160), k(240)];
  // second 0: the last that rounds to 0 (0.4); 1: still 0.4; 2: 1.6 and 2.4 both round to 2, the later wins;
  // the seconds end where the last keyframe ends, rounded up (2.5 -> 3)
  assert.deepEqual(picksFor(keys, 100, null).map((x) => x.pts), [40, 40, 240]);
  // starting late: the first second shown is the first keyframe's (0.7 -> 1); 1.7 ends at 1.8 -> 2
  assert.deepEqual(picksFor([k(70), k(170)], 100, null).map((x) => x.pts), [70]);
  // a keyframe past the edit list's end is not shown
  assert.deepEqual(picksFor([k(0), k(100), k(200)], 100, 150).map((x) => x.pts), [0, 100]);
  assert.deepEqual(picksFor([], 100, null), []);
});

function clip(file, args) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, file]);
  assert.equal(r.status, 0, String(r.stderr));
}

function oldGrid(file, out) {
  const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-skip_frame', 'nokey', '-threads', '2', '-protocol_whitelist', 'file', '-i', file,
    '-an', '-sn', '-dn', '-vf', 'fps=1:eof_action=pass,scale=240:-2,setsar=1,tile=10x7', '-frames:v', '1', '-q:v', '6', '-y', out]);
  assert.equal(r.status, 0, String(r.stderr));
  return fs.readFileSync(out);
}

test('the grid from the keyframes is the one FFmpeg makes from the whole clip, reading only the keyframes', { skip: !hasFfmpeg && 'needs ffmpeg', timeout: 120000 }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scrub-keys-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const cases = [
    // a keyframe every second at 30 fps, like Tesla's, no B-frames
    ['2026-01-01_10-00-00-front.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30:d=12.4', '-c:v', 'libx264', '-bf', '0', '-g', '30', '-pix_fmt', 'yuv420p']],
    // two a second at an odd rate (Tesla's ~36 fps), starting off the second
    ['2026-01-01_10-01-00-back.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=36:d=9.7', '-c:v', 'libx264', '-bf', '0', '-g', '18', '-pix_fmt', 'yuv420p']]
  ];
  let checked = 0;
  for (const [name, args] of cases) {
    const file = path.join(dir, name);
    clip(file, args);
    const plan = await keyframePlan(file);
    assert.ok(plan && plan.write, `${name}: read from its sample table`);
    assert.ok(plan.gap <= 1.1);
    const keyBytes = plan.picks.reduce((sum, k, i) => sum + (i && plan.picks[i - 1].index === k.index ? 0 : k.size), 0);
    assert.ok(keyBytes < fs.statSync(file).size, 'less than the whole clip is read');
    await plan.close();
    const frames = createScrubFrames({ directory: path.join(dir, 'scrub'), ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', spawn });
    const grid = await frames.get(file, { next: false });
    assert.ok(grid, name);
    assert.ok(fs.readFileSync(grid).equals(oldGrid(file, path.join(dir, `${name}.old.jpg`))), `${name}: the same grid, byte for byte`);
    checked++;
  }
  assert.equal(checked, 2);
});

test('a clip the sample table cannot serve is made as before', { skip: !hasFfmpeg && 'needs ffmpeg', timeout: 60000 }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scrub-keys-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  // B-frames: FFmpeg writes an edit list that does not start at 0, which the parser does not take
  const file = path.join(dir, '2026-01-01_10-00-00-front.mp4');
  clip(file, ['-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30:d=4', '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p']);
  const frames = createScrubFrames({ directory: path.join(dir, 'scrub'), ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', spawn });
  const grid = await frames.get(file, { next: false });
  assert.ok(grid && fs.readFileSync(grid).equals(oldGrid(file, path.join(dir, 'old.jpg'))));
  assert.equal(await keyframePlan(path.join(dir, 'missing.mp4')), null);
  await fsp.writeFile(path.join(dir, 'junk.mp4'), Buffer.alloc(4096, 7));
  assert.equal(await keyframePlan(path.join(dir, 'junk.mp4')), null);
});

test('a grid made ahead takes the clip\'s time, so pruning drops the oldest footage first', { skip: !hasFfmpeg && 'needs ffmpeg', timeout: 60000 }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scrub-keys-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '2026-01-01_10-00-00-front.mp4');
  clip(file, ['-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30:d=3', '-c:v', 'libx264', '-bf', '0', '-g', '30', '-pix_fmt', 'yuv420p']);
  const when = new Date('2026-01-01T10:01:00Z');
  await fsp.utimes(file, when, when);
  const frames = createScrubFrames({ directory: path.join(dir, 'scrub'), ffmpegPath: 'ffmpeg', spawn });
  const grid = await frames.get(file, { next: false, touch: false, urgent: false });
  assert.equal(Math.round(fs.statSync(grid).mtimeMs), when.getTime());
});
