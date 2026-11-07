'use strict';

// Footage check (server/integrity.js): clips that will not play are found
// from their box headers; results are kept, so unchanged files are not read
// again and a cut-short check goes on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createIntegrity, checkFile } = require('../server/integrity');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('good, cut off, empty and not-MP4 clips are told apart; results are kept', { skip: !hasFfmpeg && 'needs ffmpeg', timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'car');
  const rc = path.join(root, 'RecentClips');
  fs.mkdirSync(rc, { recursive: true });
  const good = path.join(rc, '2026-11-01_10-00-00-front.mp4');
  for (const [file, extra] of [[good, ['-movflags', '+faststart']], [path.join(rc, '2026-11-01_10-01-00-front.mp4'), []]]) {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=160x120:r=10:d=3', '-c:v', 'libx264', ...extra, file]);
    assert.equal(r.status, 0, String(r.stderr));
  }
  // moov at the end, cut off before it: as when the car loses power
  const whole = fs.readFileSync(path.join(rc, '2026-11-01_10-01-00-front.mp4'));
  fs.writeFileSync(path.join(rc, '2026-11-01_10-01-00-front.mp4'), whole.subarray(0, Math.floor(whole.length * 0.6)));
  fs.writeFileSync(path.join(rc, '2026-11-01_10-02-00-front.mp4'), '');
  fs.writeFileSync(path.join(rc, '2026-11-01_10-03-00-front.mp4'), 'this is not a video at all, just text');
  assert.equal(await checkFile(good), null);
  assert.match(await checkFile(path.join(rc, '2026-11-01_10-01-00-front.mp4')), /cut off/);
  assert.equal(await checkFile(path.join(rc, '2026-11-01_10-02-00-front.mp4')), 'empty file');
  assert.equal(await checkFile(path.join(rc, '2026-11-01_10-03-00-front.mp4')), 'not an MP4 file');
  // a file that cannot be read now (the share dropped) is no verdict on the clip
  await assert.rejects(checkFile(path.join(rc, 'gone-front.mp4')));

  const files = new Map();
  for (const name of fs.readdirSync(rc)) {
    const st = fs.statSync(path.join(rc, name));
    files.set(`RecentClips/${name}`, { rel: `RecentClips/${name}`, kind: 'clip', camera: 'front', day: '2026-11-01', size: st.size, mtimeMs: st.mtimeMs });
  }
  const make = () => createIntegrity({ dir: path.join(dir, 'integrity'), inventory: { get: () => ({ files }) }, vehicles: { get: () => ({ id: 'car' }), rootOf: () => root } });
  const check = make();
  check.start('car');
  await check.wait('car');
  const res = await check.results('car');
  assert.equal(res.checked, 4);
  assert.deepEqual(res.problems.map((p) => p.rel.slice(23, 31)), ['10-03-00', '10-02-00', '10-01-00']);
  // after a restart: kept, nothing read again
  const again = make();
  assert.equal((await again.results('car')).problems.length, 3);
  again.start('car');
  await again.wait('car');
  assert.equal(again.status('car').total, 0, 'unchanged files are not read again');
});

test('a footage check cut short by a restart goes on by itself', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rc = path.join(dir, 'car', 'RecentClips');
  fs.mkdirSync(rc, { recursive: true });
  fs.writeFileSync(path.join(rc, '2026-11-01_10-00-00-front.mp4'), '');
  const files = new Map([['RecentClips/2026-11-01_10-00-00-front.mp4', { rel: 'RecentClips/2026-11-01_10-00-00-front.mp4', kind: 'clip', size: 0, mtimeMs: 1 }]]);
  const stored = new Map([['car', true]]); // it was running when the app stopped
  const marks = { get: (v) => stored.get(v) === true, set: (v, on) => stored.set(v, on) };
  const check = createIntegrity({ dir: path.join(dir, 'integrity'), inventory: { get: () => ({ files }) }, vehicles: { get: () => ({}), rootOf: () => path.join(dir, 'car') }, marks });
  check.resume('car');
  await check.wait('car');
  assert.equal((await check.results('car')).problems.length, 1);
  assert.equal(stored.get('car'), false, 'done: not again at the next start');
  check.resume('car');
  assert.equal(check.status('car').running, false);
});
