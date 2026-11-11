'use strict';

// Clips Sentry Six Manager deleted for good (server/deletedClips.js): recorded
// on every delete for good (the Recycle Bin), kept 8 days, capped, and never
// "Pi missed" in the archive check (server/archiveGap.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { ManagerDB } = require('../server/db');
const { Inventory } = require('../server/inventory');
const { RecycleBin } = require('../server/recycleBin');
const { createDeletedClips, KEEP_MS } = require('../server/deletedClips');
const { parseCarFiles } = require('../server/carFiles');
const { analyze } = require('../server/archiveGap');

const quiet = { info() {}, warn() {}, error() {} };
const DAY = 86400_000;
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const rel = (stamp, cam = 'front') => `TeslaCam/RecentClips/${stamp.slice(0, 10)}/${stamp}-${cam}.mp4`;

test('the record: kept 8 days, then pruned; only recent clip names; capped, the newest kept', () => {
  const db = new ManagerDB(':memory:');
  let now = NOW;
  const rec = createDeletedClips({ db, now: () => now });
  assert.equal(rec.add('car', [rel('2026-11-09_08-00-00'), 'TeslaCam/notes.txt', rel('2026-10-01_08-00-00')]), 1, 'a clip of last month is out of the Pi\'s list anyway');
  assert.deepEqual(rec.list('car'), [rel('2026-11-09_08-00-00')]);
  assert.deepEqual(rec.list('other'), []);
  now = NOW + KEEP_MS - 1;
  assert.equal(rec.list('car').length, 1, 'still there just under 8 days later');
  now = NOW + KEEP_MS + 1;
  assert.deepEqual(rec.list('car'), [], 'gone after 8 days');
  rec.add('car', [rel('2026-11-18_08-00-00')]);
  assert.equal(db.get('deleted-clips:car').length, 1, 'the stored list is pruned when written');

  // the cap: the newest kept
  now = NOW;
  const capped = createDeletedClips({ db, now: () => now, max: 5 });
  for (let i = 0; i < 8; i++) { now = NOW + i * 1000; capped.add('cap', [rel(`2026-11-09_08-0${i}-00`)]); }
  const left = capped.list('cap');
  assert.equal(left.length, 5);
  assert.deepEqual(left, [3, 4, 5, 6, 7].map((i) => rel(`2026-11-09_08-0${i}-00`)));
  capped.forget('cap');
  assert.deepEqual(capped.list('cap'), []);
});

test('emptying the Recycle Bin records the clips deleted for good', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-deleted-'));
  const root = path.join(dir, 'footage');
  const stamp = new Date(Date.now() - DAY).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  for (const cam of ['front', 'back']) {
    const f = path.join(root, rel(stamp, cam));
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, 'x');
  }
  try {
    const db = new ManagerDB(':memory:');
    const share = { healthy: true, isHealthy() { return true; }, isWritable() { return true; } };
    const v = { id: 'car', name: 'Car', timezone: 'UTC', source: { type: 'path', path: root } };
    const vehicles = { get: (id) => (id === 'car' ? v : null), list: () => [v], share: () => share, rootOf: () => root };
    const inventory = new Inventory({ vehicles, db, log: quiet });
    await inventory.scan('car');
    const bin = new RecycleBin({ db, vehicles, inventory, jobs: { start: () => 1, finish() {} }, log: quiet });
    const recs = inventory.get('car').recordings;
    await bin.trash('car', recs.map((r) => r.id));
    assert.deepEqual(bin.deletedClips.list('car'), [], 'in the bin: not deleted yet');
    await bin.empty('car');
    assert.deepEqual(bin.deletedClips.list('car').sort(), [rel(stamp, 'back'), rel(stamp, 'front')]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a clip deleted in Manager is never "Pi missed", and its minutes are not missing', () => {
  const at = (d, h, m = 0) => Date.UTC(2026, 10, d, h, m, 0);
  const key = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  const files = new Map();
  const share = (from, to) => { for (let t = from; t < to; t += 60_000) { const r = rel(key(t)); files.set(r, { rel: r, size: 1e6, mtimeMs: t, ctimeMs: t + 61_000, birthtimeMs: t + 61_000, kind: 'clip', type: 'RecentClips', camera: 'front' }); } };
  share(at(9, 8), at(9, 8, 30));
  share(at(9, 18), at(9, 18, 5));
  const lines = [];
  for (let t = at(9, 8); t < at(9, 8, 40); t += 60_000) lines.push(`${t / 1000 + 60}\tRecentClips/${key(t)}-front.mp4\t1000\t${t / 1000 + 60}`);
  const carFiles = { list: parseCarFiles(lines.join('\n')), fileUnix: NOW / 1000 - 300, archivedUnix: at(9, 19) / 1000 };
  const can = [];
  for (let t = at(9, 8); t < at(9, 8, 40); t += 60_000) can.push(Date.UTC(2026, 10, 9, 8, (t - at(9, 8)) / 60_000) / 1000);
  // 08:30-08:39 are not on the share: Pi missed ...
  const missed = analyze({ files, nowMs: NOW, canDriving: can, carFiles });
  assert.equal(missed.days['2026-11-09'].carFiles.piMissed, 10);
  // ... unless Manager deleted them (the Recycle Bin emptied, a policy)
  const deleted = [];
  for (let t = at(9, 8, 30); t < at(9, 8, 40); t += 60_000) deleted.push(rel(key(t)));
  const res = analyze({ files, nowMs: NOW, canDriving: can, carFiles, deleted });
  assert.equal(res.days['2026-11-09'], undefined, 'nothing missing, no tag');
  const day = res.carFiles.days['2026-11-09'];
  assert.equal(day.piMissed, 0);
  assert.equal(day.carMissed, 0);
  assert.equal(day.deleted, 10, 'a neutral count');
  assert.equal(day.deletedClips, 10);
});
