'use strict';

// The first scan after a restart starts from the footage catalog's last
// finished scan (its files and folder times) as a light rescan does from the
// last scan in memory: unchanged folders keep what the catalog knew, without
// a stat per file, and the answers are the same as a full scan's, whatever
// changed while the server was down. A catalog it cannot vouch for (none, an
// older version, another folder, a write cut short) means a full scan.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ManagerDB } = require('../server/db');
const { Inventory } = require('../server/inventory');

const quiet = { info() {}, warn() {} };
const old = new Date(Date.now() - 24 * 3600 * 1000);
const CAMERAS = ['front', 'back', 'left_repeater', 'right_repeater'];
const RC = 'TeslaCam/RecentClips';
const EV = 'TeslaCam/SentryClips/2026-11-01_12-00-00';
const SV = 'TeslaCam/SavedClips/2026-11-03_08-15-00';

async function put(root, rel, bytes = 10, when = old) {
  const file = path.join(root, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, Buffer.alloc(bytes, 1));
  await fsp.utimes(file, when, when);
}
const settle = (root, dirs) => Promise.all(dirs.map((d) => fsp.utimes(path.join(root, d), old, old)));

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-resume-'));
  let n = 0;
  for (const s of ['2026-11-01_09-00-00', '2026-11-01_09-01-00', '2026-11-02_18-30-00']) for (const c of CAMERAS) await put(root, `${RC}/${s}-${c}.mp4`, 10 + n++);
  for (const s of ['2026-11-01_11-50-00', '2026-11-01_11-51-00']) for (const c of CAMERAS) await put(root, `${EV}/${s}-${c}.mp4`, 10 + n++);
  await put(root, `${EV}/event.json`, 20);
  for (const c of CAMERAS) await put(root, `${SV}/2026-11-03_08-05-00-${c}.mp4`, 10 + n++);
  await settle(root, [RC, EV, SV, 'TeslaCam/SentryClips', 'TeslaCam/SavedClips', 'TeslaCam', '.']);
  return root;
}

function setup(root, dbFile) {
  const db = new ManagerDB(dbFile);
  const v = { id: 'car', name: 'Car' };
  const vehicles = { get: (id) => (id === 'car' ? v : null), rootOf: () => root, share: () => null };
  return { db, inv: new Inventory({ vehicles, db, log: quiet }) };
}

/** What the inventory answers: every file entry field for field, and the recordings. */
function answers(inv) {
  const e = inv.get('car');
  const files = [...e.files.values()].sort((a, b) => a.rel.localeCompare(b.rel))
    .map((f) => [f.rel, f.size, f.mtimeMs, f.ctimeMs, f.birthtimeMs, f.kind, f.type, f.day, f.camera, f.eventId, f.encodable]);
  const recordings = JSON.parse(JSON.stringify(e.recordings.map((r) => ({ ...r, clipRels: [...r.clipRels].sort() }))));
  return { files, recordings };
}

/** A full scan of the same folder by an inventory with no database. */
async function fullScan(root) {
  const v = { id: 'car', name: 'Car' };
  const inv = new Inventory({ vehicles: { get: () => v, rootOf: () => root, share: () => null }, db: { protectedSet: () => new Set() }, log: quiet });
  await inv.scan('car');
  return answers(inv);
}

/** Counts the stats of footage files (not folders) while fn runs. */
async function fileStats(fn) {
  const real = fsp.stat;
  let n = 0;
  fsp.stat = (p, ...rest) => { if (/\.(mp4|json)$/i.test(String(p))) n++; return real(p, ...rest); };
  try {
    const out = await fn();
    return { n, out };
  } finally {
    fsp.stat = real;
  }
}

/** A first run that scans and closes; returns the database file. */
async function firstRun(root) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-resume-db-'));
  const dbFile = path.join(dir, 'manager.db');
  const { db, inv } = setup(root, dbFile);
  await inv.scan('car');
  db.close();
  return dbFile;
}

/** A restart: a new inventory on the same database, its first scan light (index.js, the share's health). */
async function restart(root, dbFile) {
  const { db, inv } = setup(root, dbFile);
  const { n } = await fileStats(() => inv.scan('car', { light: true }));
  return { db, inv, stats: n };
}

test('nothing changed while down: no file is looked at again, the answers are a full scan\'s', async () => {
  const root = await fixture();
  const dbFile = await firstRun(root);
  const { db, inv, stats } = await restart(root, dbFile);
  try {
    assert.equal(stats, 0, 'no stat of any file');
    assert.deepEqual(answers(inv), await fullScan(root));
    assert.equal(inv.get('car').lightScans, 1, 'counted as a light scan: a full one still follows within the usual five');
    // the catalog still vouches for this scan: a second restart starts from it too
    db.close();
    const again = await restart(root, dbFile);
    assert.equal(again.stats, 0);
    again.db.close();
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('files added, removed and replaced while down are seen as a full scan sees them', async () => {
  const root = await fixture();
  const dbFile = await firstRun(root);
  // added and removed in RecentClips, a clip replaced by a rename in the event (the converter's swap)
  await put(root, `${RC}/2026-11-02_18-31-00-front.mp4`, 77);
  await fsp.unlink(path.join(root, `${RC}/2026-11-01_09-00-00-back.mp4`));
  const swapped = `${EV}/2026-11-01_11-50-00-front.mp4`;
  await put(root, `${swapped}.tmp`, 5);
  await fsp.rename(path.join(root, `${swapped}.tmp`), path.join(root, swapped));
  // a whole event folder gone, a new one come
  await fsp.rm(path.join(root, SV), { recursive: true });
  await put(root, 'TeslaCam/SavedClips/2026-11-04_10-00-00/2026-11-04_09-59-00-front.mp4', 33);
  const { db, inv, stats } = await restart(root, dbFile);
  try {
    assert.deepEqual(answers(inv), await fullScan(root));
    assert.equal(inv.get('car').files.get(swapped).size, 5, 'the replaced clip');
    // only the changed folders were looked at in full: RecentClips (12), the event (9), the new event (1)
    assert.equal(stats, 12 + 9 + 1);
  } finally {
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a clip still being copied when the server stopped is looked at again, however long it was down', async () => {
  const root = await fixture();
  const dbFile = await firstRun(root);
  // the last scan ran a day ago, while this clip (then a day old too) was being written
  const growing = `${EV}/2026-11-01_11-51-00-front.mp4`;
  {
    const db = new ManagerDB(dbFile);
    db.db.prepare('UPDATE catalog_scans SET started_ms = ? WHERE vehicle_id = ?').run(old.getTime() + 60_000, 'car');
    db.close();
  }
  // it was finished while the server was down: written in place, the folder's time unchanged
  const was = (await fsp.stat(path.join(root, growing))).size;
  await fsp.appendFile(path.join(root, growing), Buffer.alloc(100, 1));
  await settle(root, [EV]);
  const { db, inv } = await restart(root, dbFile);
  try {
    assert.equal(inv.get('car').files.get(growing).size, was + 100, 'its finished size');
    assert.deepEqual(answers(inv), await fullScan(root));
  } finally {
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a file rewritten in place long after the last scan: as with a light rescan, the next full scan sees it', async () => {
  // Folder times do not change when a file is rewritten in place (no rename),
  // so neither a light rescan from memory nor one from the catalog sees it
  // until the full scan that follows within five light ones (inventory.scan).
  const root = await fixture();
  const dbFile = await firstRun(root);
  const rel = `${RC}/2026-11-02_18-30-00-front.mp4`;
  const was = (await fsp.stat(path.join(root, rel))).size;
  await fsp.writeFile(path.join(root, rel), Buffer.alloc(99, 2));
  await fsp.utimes(path.join(root, rel), old, old);
  await settle(root, [RC]);
  const { db, inv } = await restart(root, dbFile);
  try {
    assert.equal(inv.get('car').files.get(rel).size, was, 'not seen yet, as a light rescan would not');
    for (let i = 0; i < 4; i++) await inv.scan('car', { light: true });
    assert.equal(inv.get('car').lightScans, 5);
    await inv.scan('car', { light: true });
    assert.equal(inv.get('car').lightScans, 0, 'the full scan');
    assert.equal(inv.get('car').files.get(rel).size, 99);
    assert.deepEqual(answers(inv), await fullScan(root));
  } finally {
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('Recycle Bin moves and restores between scans keep the catalog usable and right', async () => {
  const root = await fixture();
  const bin = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-resume-bin-'));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-resume-db-'));
  const dbFile = path.join(dir, 'manager.db');
  try {
    {
      const { db, inv } = setup(root, dbFile);
      await inv.scan('car');
      const files = inv.get('car').files;
      // moved to the bin (recycleBin.js: the files go, the map loses them, the inventory rebuilds)
      const moved = [...files.keys()].filter((rel) => rel.startsWith(`${RC}/2026-11-01_09-01-00`));
      const kept = moved.map((rel) => files.get(rel));
      for (const rel of moved) {
        await fsp.rename(path.join(root, rel), path.join(bin, path.basename(rel)));
        files.delete(rel);
      }
      inv.rebuild('car');
      assert.ok(db.catalog.lastScan('car'), 'still vouched for');
      // one restored
      await fsp.rename(path.join(bin, path.basename(moved[0])), path.join(root, moved[0]));
      files.set(moved[0], kept[0]);
      inv.rebuild('car');
      db.close();
    }
    const { db, inv, stats } = await restart(root, dbFile);
    try {
      assert.deepEqual(answers(inv), await fullScan(root));
      assert.equal(inv.get('car').files.size, 25 - 4 + 1);
      assert.equal(stats, 9, 'only RecentClips, whose time the moves changed');
    } finally {
      db.close();
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(bin, { recursive: true, force: true });
  }
});

test('a catalog it cannot vouch for means a full scan', async (t) => {
  const root = await fixture();
  const total = 25;
  const cases = {
    'none yet (an older version wrote the files only)': (db) => db.db.prepare('DELETE FROM catalog_scans').run(),
    'written by another version': (db) => db.db.prepare('UPDATE catalog_scans SET format = format + 1').run(),
    'its rows do not add up to the scan (a write cut short, an older version since)': (db) => db.db.prepare('DELETE FROM catalog_files WHERE rel LIKE ?').run('%front.mp4'),
    'no folder times': (db) => db.db.prepare('DELETE FROM catalog_dirs').run(),
    'another folder': (db) => db.db.prepare('UPDATE catalog_scans SET root = ?').run('/elsewhere')
  };
  try {
    for (const [name, spoil] of Object.entries(cases)) {
      await t.test(name, async () => {
        const dbFile = await firstRun(root);
        const db0 = new ManagerDB(dbFile);
        spoil(db0);
        db0.close();
        const { db, inv, stats } = await restart(root, dbFile);
        try {
          assert.equal(stats, total, 'every file looked at');
          assert.equal(inv.get('car').lightScans, 0, 'a full scan');
          assert.deepEqual(answers(inv), await fullScan(root));
        } finally {
          db.close();
        }
      });
    }
    await t.test('a scan that stopped halfway (the server stopped mid-scan)', async () => {
      const dbFile = await firstRun(root);
      const { db, inv } = setup(root, dbFile);
      // a scan starts writing, and never finishes
      const one = inv.resume('car', root).files.values().next().value;
      inv.catalogWriter('car', null, root).add(one);
      db.close();
      const r = await restart(root, dbFile);
      assert.equal(r.stats, total);
      r.db.close();
    });
    await t.test('the last catalog write failed in this run', async () => {
      const dbFile = await firstRun(root);
      const { db, inv } = setup(root, dbFile);
      inv.catalogBehind.add('car');
      const { n } = await fileStats(() => inv.scan('car', { light: true }));
      assert.equal(n, total);
      db.close();
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('scans with something in memory are as before: a plain scan looks at every file', async () => {
  const root = await fixture();
  const dbFile = await firstRun(root);
  const { db, inv } = setup(root, dbFile);
  try {
    const { n } = await fileStats(() => inv.scan('car'));
    assert.equal(n, 25, 'a scan not asked to be light is full, catalog or not');
    const light = await fileStats(() => inv.scan('car', { light: true }));
    assert.equal(light.n, 0, 'a light one reuses what is in memory');
  } finally {
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});
