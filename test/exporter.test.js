'use strict';

// Export (server/exporter.js): a stretch of footage rendered into one MP4.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createExporter, normalize, layoutFor, overlayAss, partArgs, wallAt } = require('../server/exporter');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const clip = (key, from, to, cams = ['front']) => ({ key, from, to, files: Object.fromEntries(cams.map((c) => [c, `/footage/${key}-${c}.mp4`])) });

test('wall-clock time of a clip plus seconds, 12- or 24-hour', () => {
  assert.equal(wallAt('2026-11-03_23-59-50', 15), '2026-11-04 12:00:05 AM');
  assert.equal(wallAt('2026-11-03_13-00-00', 5.9, true), '2026-11-03 13:00:05');
  assert.equal(wallAt('nonsense', 0), '');
});

test('a request is checked: something to export, at most 60 minutes, a known camera', () => {
  assert.throws(() => normalize({ clips: [] }), /start and an end/);
  assert.throws(() => normalize({ clips: [{ key: 'x', files: { front: '/a' }, from: 0, to: 5 }] }), /no valid time/);
  assert.throws(() => normalize({ clips: [{ key: '2026-11-03_10-00-00', files: {}, from: 0, to: 5 }] }), /no video/);
  assert.throws(() => normalize({ clips: [clip('2026-11-03_10-00-00', 5, 5.2)] }), /no time to export/);
  const long = Array.from({ length: 61 }, (_, i) => clip(`2026-11-03_10-${String(i % 60).padStart(2, '0')}-00`, 0, 60));
  assert.throws(() => normalize({ clips: long }), /60 minutes/);
  assert.throws(() => normalize({ clips: [clip('2026-11-03_10-00-00', 0, 5)], camera: 'trunk' }), /all cameras or one/);
  assert.throws(() => normalize({ clips: [clip('2026-11-03_10-00-00', 0, 5)], camera: 'back' }), /None of these clips has the Rear camera/);
  const ok = normalize({ clips: [clip('2026-11-03_10-00-00', 40, 60), clip('2026-11-03_10-01-00', 0, 15)], units: 'kmh' });
  assert.equal(ok.camera, 'grid');
  assert.equal(ok.units, 'kmh');
  assert.equal(ok.seconds, 35);
  // only camera names Tesla uses
  assert.deepEqual(Object.keys(normalize({ clips: [{ key: '2026-11-03_10-00-00', from: 0, to: 5, files: { front: '/a', evil: '/b' } }] }).clips[0].files), ['front']);
});

test('the grid is laid out as the cameras sit on the car: 3 x 2 with pillars, 2 x 2 without', () => {
  const hw3 = layoutFor([clip('2026-11-03_10-00-00', 0, 5, ['front', 'back'])], 'grid');
  assert.deepEqual(hw3.cams, ['front', 'back', 'left_repeater', 'right_repeater']);
  assert.deepEqual([hw3.cols, hw3.w, hw3.h], [2, 1280, 960]);
  const hw4 = layoutFor([clip('2026-11-03_10-00-00', 0, 5, ['front', 'left_pillar'])], 'grid');
  assert.deepEqual(hw4.cams, ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater']);
  assert.deepEqual([hw4.cols, hw4.w, hw4.h], [3, 1920, 960]);
  assert.deepEqual(layoutFor([clip('2026-11-03_10-00-00', 0, 5)], 'back').cams, ['back']);
});

test('the overlay: date, time and speed each second of the part, camera names on the tiles', () => {
  const c = clip('2026-11-03_10-00-00', 1.5, 4);
  const layout = layoutFor([c], 'grid');
  const ass = overlayAss({ clip: c, speeds: [0, 10, 20, null, 30], units: 'mph', clock24: false, width: layout.w, height: layout.h, layout });
  const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue: 0,') && l.includes(',Bar,'));
  assert.deepEqual(lines.map((l) => l.split(',Bar,,0,0,0,,')[1]), ['2026-11-03 10:00:01 AM   22 mph', '2026-11-03 10:00:02 AM   45 mph', '2026-11-03 10:00:03 AM']);
  // times are relative to the part: the first line starts at 0, the last ends at its end
  assert.match(lines[0], /^Dialogue: 0,0:00:00\.00,0:00:00\.50,/);
  assert.match(lines[2], /,0:00:01\.50,0:00:02\.50,/);
  assert.match(ass, /\{\\pos\(648,8\)\}Rear/);
  assert.match(overlayAss({ clip: c, speeds: [0, 10], units: 'kmh', clock24: true, width: 640, height: 480, layout: layoutFor([c], 'front') }), /10:00:01   36 km\/h/);
});

test('ffmpeg is given the part only, a black tile for a missing camera, and the grid', () => {
  const c = clip('2026-11-03_10-00-00', 12.5, 30, ['front', 'back']);
  const args = partArgs({ clip: c, layout: layoutFor([c], 'grid'), assName: 'part-0.ass', outName: 'part-0.mp4' });
  const s = args.join(' ');
  assert.match(s, /-ss 12\.500 -t 17\.500 -i \/footage\/2026-11-03_10-00-00-front\.mp4/);
  assert.match(s, /-f lavfi -t 17\.500 -i color=c=black:s=640x480/);
  assert.match(s, /xstack=inputs=4:layout=0_0\|640_0\|0_480\|640_480/);
  assert.match(s, /subtitles=part-0\.ass/);
  assert.match(s, /-c:v libx264 -preset veryfast -crf 23 -r 30/);
});

function fakeJobs() {
  const jobs = new Map();
  let n = 0;
  return {
    jobs,
    start(j) { jobs.set(++n, { ...j, status: 'running' }); return n; },
    update(id, f) { Object.assign(jobs.get(id), f); },
    finish(id, f) { Object.assign(jobs.get(id), { status: 'done', ...f, finished: true }); }
  };
}

async function testClip(file, seconds) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=s=320x240:r=30:d=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  assert.equal(r.status, 0, String(r.stderr));
}
function duration(file) {
  return Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim());
}

test('a real export: two clips joined into one MP4, a damaged camera shows black, the job says so', { skip: !hasFfmpeg && 'needs ffmpeg', timeout: 120000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-export-'));
  try {
    const src = path.join(dir, 'footage');
    await fsp.mkdir(src);
    const a = path.join(src, '2026-11-03_10-00-00-front.mp4');
    const b = path.join(src, '2026-11-03_10-01-00-front.mp4');
    const bad = path.join(src, '2026-11-03_10-01-00-back.mp4');
    await testClip(a, 4);
    await testClip(b, 4);
    await fsp.writeFile(bad, Buffer.alloc(4096, 7));
    const jobs = fakeJobs();
    const ex = createExporter({ dir: path.join(dir, 'exports'), jobs, log: { warn() {} }, resolve: async (p) => p, speedsFor: async () => [10, 10, 10, 10] });
    const x = await ex.start({
      vehicle: { id: 'car', name: 'Car' },
      body: { clips: [{ key: '2026-11-03_10-00-00', files: { front: a }, from: 2, to: 4 }, { key: '2026-11-03_10-01-00', files: { front: b, back: bad }, from: 0, to: 1.5 }] }
    });
    assert.equal(x.state, 'running');
    let s;
    for (let i = 0; i < 200; i++) {
      s = ex.get(x.id);
      if (!['waiting', 'running'].includes(s.state)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(s.state, 'done', s.error);
    const f = ex.file(x.id);
    assert.ok(Math.abs(duration(f.file) - 3.5) < 0.3, `3.5 s long, is ${duration(f.file)}`);
    assert.match(f.name, /^Sentry Car 2026-11-03 10-00-02 AM\.mp4$/);
    assert.deepEqual(s.notes, ['Rear at 10:01:00 AM could not be read (black)']);
    const job = jobs.jobs.get(x.jobId);
    assert.equal(job.type, 'export');
    assert.equal(job.status, 'done');
    assert.match(job.detail, /Ready to download: 0:04, \d+ MB\. Kept for a day\. Note: Rear at 10:01:00 AM could not be read \(black\)\./);
    // nothing of the work is left beside the file
    assert.deepEqual((await fsp.readdir(path.join(dir, 'exports'))).sort(), [`${x.id}.mp4`]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('one export at a time: the next waits, and a waiting one can be cancelled', { skip: !hasFfmpeg && 'needs ffmpeg', timeout: 120000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-export-'));
  try {
    const a = path.join(dir, '2026-11-03_10-00-00-front.mp4');
    await testClip(a, 3);
    const jobs = fakeJobs();
    const ex = createExporter({ dir: path.join(dir, 'exports'), jobs, log: { warn() {} }, resolve: async (p) => p });
    const body = { clips: [{ key: '2026-11-03_10-00-00', files: { front: a }, from: 0, to: 3 }] };
    const first = await ex.start({ vehicle: { id: 'car', name: 'Car' }, body });
    const second = await ex.start({ vehicle: { id: 'car', name: 'Car' }, body });
    assert.equal(second.state, 'waiting');
    assert.match(jobs.jobs.get(second.jobId).detail, /Waiting for the export before it/);
    assert.ok(ex.cancel(second.id));
    assert.equal(ex.get(second.id).state, 'cancelled');
    assert.equal(jobs.jobs.get(second.jobId).status, 'cancelled');
    for (let i = 0; i < 200 && ['waiting', 'running'].includes(ex.get(first.id).state); i++) await new Promise((r) => setTimeout(r, 200));
    assert.equal(ex.get(first.id).state, 'done');
    // a file outside what the vehicle may export is refused before anything runs
    const strict = createExporter({ dir: path.join(dir, 'exports2'), jobs, log: { warn() {} }, resolve: async () => null });
    await assert.rejects(strict.start({ vehicle: { id: 'car', name: 'Car' }, body }), /not in Car's footage/);
    assert.equal(fs.existsSync(path.join(dir, 'exports2')), false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
