'use strict';

// The counts and sums some modules make from the scan's file map (storage's
// last 14 days, the clips that arrived lately, the clips canPrune keeps CAN
// data for) come out the same from the footage catalog, after scans, a
// restart, Recycle Bin moves and restores, and a move made while a scan runs.
// (They still read the map: while it is in memory it is the quicker of the
// two; see docs/performance-ideas.md. This keeps the catalog able to answer.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ManagerDB } = require('../server/db');
const { Inventory } = require('../server/inventory');

const quiet = { info() {}, warn() {} };
const DAY = 86_400_000;
const CAMERAS = ['front', 'back', 'left_repeater', 'right_repeater'];
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-00`;
};
const old = new Date(Date.now() - 2 * DAY);

async function put(root, rel, bytes) {
  const file = path.join(root, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, Buffer.alloc(bytes, 1));
  await fsp.utimes(file, old, old);
}

/** Drives and events over the last month (some inside the last 14 days, some before). */
async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-answers-'));
  let n = 0;
  for (const ago of [30, 20, 13, 6, 1]) {
    const t = Date.now() - ago * DAY;
    for (let m = 0; m < 2; m++) for (const c of CAMERAS) await put(root, `TeslaCam/RecentClips/${stamp(t + m * 60_000)}-${c}.mp4`, 100 + n++);
    const ev = `TeslaCam/SentryClips/${stamp(t + 3600_000)}`;
    for (const c of CAMERAS) await put(root, `${ev}/${stamp(t + 3540_000)}-${c}.mp4`, 100 + n++);
    await put(root, `${ev}/event.json`, 30);
    await put(root, `${ev}/thumb.png`, 40);
  }
  return root;
}

function setup(root, dbFile) {
  const db = new ManagerDB(dbFile);
  const v = { id: 'car', name: 'Car' };
  const vehicles = { get: (id) => (id === 'car' ? v : null), rootOf: () => root, share: () => null };
  return { db, inv: new Inventory({ vehicles, db, log: quiet }) };
}

const since14 = () => new Date(Date.now() - 14 * DAY).toISOString().slice(0, 10);

/** As the modules work them out now, from the map. */
function fromMap(inv) {
  const files = inv.get('car').files;
  // index.js storageOf: the last 14 days' bytes and the first of those days
  const since = since14();
  let bytes = 0;
  let first = null;
  for (const f of files.values()) {
    if (!f.day || f.day < since) continue;
    bytes += f.size || 0;
    if (!first || f.day < first) first = f.day;
  }
  // canPrune footageOf / deleteWith: every clip on the share
  const clips = [...files.values()].filter((f) => f.kind === 'clip').map((f) => f.rel).sort();
  return { recent: { bytes, first }, arrived: [0, Date.now() - DAY, Date.now() + DAY].map((s) => inv.arrivedClips('car', s)), clips };
}

/** The same from the catalog: catalog.summary by day, and its rows. */
function fromCatalog(db) {
  const since = since14();
  const sum = db.catalog.summary('car');
  let bytes = 0;
  let first = null;
  for (const [day, d] of Object.entries(sum.days)) {
    if (!day || day === 'null' || day < since) continue;
    bytes += d.bytes;
    if (!first || day < first) first = day;
  }
  const rows = db.catalog.files('car');
  const arrived = [0, Date.now() - DAY, Date.now() + DAY].map((s) => {
    const out = { sentry: 0, dashcam: 0 };
    for (const f of rows) {
      if (f.kind !== 'clip') continue;
      const at = f.birthtimeMs > 0 ? f.birthtimeMs : f.ctimeMs || 0;
      if (!(at >= s)) continue;
      if (f.type === 'SentryClips') out.sentry++;
      else out.dashcam++;
    }
    return out;
  });
  const clips = rows.filter((f) => f.kind === 'clip').map((f) => f.rel).sort();
  return { recent: { bytes, first }, arrived, clips };
}

function same(inv, db, what) {
  const a = fromMap(inv);
  assert.ok(a.recent.bytes > 0 && a.clips.length > 0, 'something to count');
  assert.deepEqual(fromCatalog(db), a, what);
  return a;
}

test('the catalog answers as the file map does, scan after scan, across a restart and the Recycle Bin', async () => {
  const root = await fixture();
  const bin = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-answers-bin-'));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-answers-db-'));
  const dbFile = path.join(dir, 'manager.db');
  try {
    let { db, inv } = setup(root, dbFile);
    await inv.scan('car');
    const first = same(inv, db, 'after a scan');

    // moved to the Recycle Bin (recycleBin.js: moved, gone from the map, rebuilt)
    const files = inv.get('car').files;
    const moved = [...files.values()].filter((f) => f.rel.startsWith('TeslaCam/SentryClips/') && f.day >= since14());
    for (const f of moved) {
      await fsp.rename(path.join(root, f.rel), path.join(bin, f.rel.replace(/\//g, '_')));
      files.delete(f.rel);
    }
    inv.rebuild('car');
    const after = same(inv, db, 'after a Recycle Bin move');
    assert.ok(after.recent.bytes < first.recent.bytes && after.clips.length < first.clips.length);

    // restored (recycleBin.js: moved back, then a scan)
    for (const f of moved) await fsp.rename(path.join(bin, f.rel.replace(/\//g, '_')), path.join(root, f.rel));
    await inv.scan('car');
    assert.deepEqual(same(inv, db, 'after a restore'), first);

    // a restart (the first scan starts from the catalog) and a light rescan
    db.close();
    ({ db, inv } = setup(root, dbFile));
    await inv.scan('car', { light: true });
    assert.ok(inv.get('car').lightScans > 0, 'resumed');
    assert.deepEqual(same(inv, db, 'after a restart'), first);
    await inv.scan('car', { light: true });
    same(inv, db, 'after a light rescan');
    db.close();
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(bin, { recursive: true, force: true });
  }
});

test('a Recycle Bin move while a scan runs leaves the catalog as the scan found it, as the map is', async () => {
  // A rebuild in the middle of a scan used to bring the catalog in line with
  // the map from before the scan, dropping rows the scan had just written for
  // new files; later scans saw those files unchanged and never wrote them back.
  const root = await fixture();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-answers-db-'));
  const { db, inv } = setup(root, path.join(dir, 'manager.db'));
  try {
    await inv.scan('car');
    const added = `TeslaCam/RecentClips/${stamp(Date.now() - 2 * 3600_000)}-front.mp4`;
    await put(root, added, 555);
    const gone = [...inv.get('car').files.keys()].find((rel) => rel.startsWith('TeslaCam/SentryClips/') && rel.endsWith('-back.mp4'));
    // the scan writes its rows, then (before it has finished) a Recycle Bin move rebuilds
    const putFiles = db.catalog.putFiles.bind(db.catalog);
    let once = false;
    db.catalog.putFiles = (vid, list) => {
      putFiles(vid, list);
      if (once) return;
      once = true;
      inv.get('car').files.delete(gone);
      inv.rebuild('car');
    };
    await inv.scan('car');
    db.catalog.putFiles = putFiles;
    assert.ok(once, 'the move came mid-scan');
    assert.ok(db.catalog.files('car').some((r) => r.rel === added), 'the new file has its row');
    same(inv, db, 'after the scan');
    await inv.scan('car', { light: true });
    same(inv, db, 'and the next');
  } finally {
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});
