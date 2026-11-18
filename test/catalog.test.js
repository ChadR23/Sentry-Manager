'use strict';

// The footage catalog (catalog.js): each scan's files and the clips' codecs
// are kept in the database. The inventory answers exactly as it did when
// every file was a plain object and the codecs one settings value; codecs
// are not read again after a restart; an older database gains the tables and
// keeps what it had; the footage folders are only ever read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ManagerDB } = require('../server/db');
const { Inventory, buildRecordings, summarizeDays, encodedOf } = require('../server/inventory');
const { classify, localDay } = require('../server/footage');
const { videoCodec } = require('../server/mp4codec');

const CAMERAS = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];
const quiet = { info() {}, warn() {} };
const old = new Date(Date.now() - 24 * 3600 * 1000);

const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
/** The smallest MP4 whose header names a video codec (avc1, hvc1, av01). */
function mp4(entry, pad = 0) {
  const hdlr = box('hdlr', Buffer.alloc(8), Buffer.from('vide', 'latin1'), Buffer.alloc(13));
  const stsd = box('stsd', Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), box(entry, Buffer.alloc(8)));
  const moov = box('moov', box('trak', box('mdia', hdlr, box('minf', box('stbl', stsd)))));
  return Buffer.concat([box('ftyp', Buffer.from('isom', 'latin1'), Buffer.alloc(4)), moov, box('mdat', Buffer.alloc(pad))]);
}

async function put(root, rel, data) {
  const file = path.join(root, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, data);
  await fsp.utimes(file, old, old);
}

/** A small archive: two drives, a Sentry and a Saved event, all six cameras, some clips encoded. */
async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-catalog-'));
  let n = 0;
  const clips = async (dir, stamps, codec = () => 'avc1') => {
    for (const s of stamps) for (const cam of CAMERAS) await put(root, `${dir}/${s}-${cam}.mp4`, mp4(codec(s, cam), n++ % 50));
  };
  await clips('TeslaCam/RecentClips', ['2026-11-01_09-00-00', '2026-11-01_09-01-00', '2026-11-01_09-02-00'], (s) => (s.endsWith('01-00') ? 'hvc1' : 'avc1'));
  await clips('TeslaCam/RecentClips', ['2026-11-02_18-30-00', '2026-11-02_18-31-00'], () => 'av01');
  const sentry = 'TeslaCam/SentryClips/2026-11-01_12-00-00';
  await clips(sentry, ['2026-11-01_11-50-00', '2026-11-01_11-51-00']);
  await put(root, `${sentry}/event.json`, JSON.stringify({ timestamp: '2026-11-01T12:00:00', city: 'Somewhere', est_lat: '1', est_lon: '2', reason: 'sentry_aware_object_detection' }));
  await put(root, `${sentry}/thumb.png`, Buffer.alloc(40, 3));
  const saved = 'TeslaCam/SavedClips/2026-11-03_08-15-00';
  await clips(saved, ['2026-11-03_08-05-00', '2026-11-03_08-06-00'], (s, cam) => (cam === 'front' ? 'hvc1' : 'avc1'));
  await put(root, `${saved}/event.json`, '{}');
  await put(root, `${saved}/thumb.png`, Buffer.alloc(30, 3));
  await put(root, 'TeslaCam/RecentClips/2026-11-04/dashcam.mp4', mp4('avc1')); // not Tesla-named, in a date folder
  await put(root, 'TeslaCam/RecentClips/broken-front.mp4', Buffer.alloc(10)); // no codec to read
  for (const d of ['TeslaCam/RecentClips', sentry, saved, 'TeslaCam/RecentClips/2026-11-04']) await fsp.utimes(path.join(root, d), old, old);
  return root;
}

/** Every file and folder under root with its size and times: what "never written" is checked by. */
function tree(root) {
  const out = {};
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const st = fs.statSync(abs);
      out[path.relative(root, abs)] = [ent.isDirectory(), st.size, st.mtimeMs];
      if (ent.isDirectory()) walk(abs);
    }
  };
  walk(root);
  return out;
}

/** What the inventory answered before the catalog: plain-object entries, codecs read straight from each clip. */
async function before(inv, vid) {
  const files = new Map();
  for (const f of inv.get(vid).files.values()) {
    const info = classify(f.rel);
    files.set(f.rel, { rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, ctimeMs: f.ctimeMs, birthtimeMs: f.birthtimeMs, ...info, day: info.day || localDay(f.mtimeMs) });
  }
  const codecs = new Map();
  const root = inv.vehicles.rootOf();
  for (const f of files.values()) {
    if (f.kind !== 'clip' || !/\.mp4$/i.test(f.rel)) continue;
    codecs.set(f.rel, { size: f.size, mtimeMs: f.mtimeMs, codec: await videoCodec(path.join(root, f.rel)) });
  }
  const recordings = buildRecordings(files, { vehicleId: vid, protectedRels: new Set() });
  return { files, codecs, recordings };
}

/** The answers the footage pages and counts are made of. */
function answers(inv, vid, recordings = inv.get(vid).recordings) {
  return {
    // (clipRels come in the order the scan's stats returned, which differs from scan to scan)
    recordings: JSON.parse(JSON.stringify(recordings.map((r) => ({ ...r, clipRels: [...r.clipRels].sort() })))),
    encoded: recordings.map((r) => inv.encoded(vid, r)),
    days: inv.days(vid, recordings),
    totals: { ...inv.totals(vid), scannedAt: null },
    footageDays: inv.footageDays(vid)
  };
}

function setup(root, dbFile) {
  const db = new ManagerDB(dbFile);
  const v = { id: 'car', name: 'Car' };
  const vehicles = { get: (id) => (id === 'car' ? v : null), rootOf: () => root, share: () => null };
  return { db, inv: new Inventory({ vehicles, db, log: quiet }) };
}

test('the inventory answers as before: footage lists, counts, sizes and codecs', async () => {
  const root = await fixture();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-catalog-db-'));
  const untouched = tree(root);
  const { db, inv } = setup(root, path.join(dir, 'manager.db'));
  try {
    await inv.scan('car');
    assert.ok(await inv.probeCodecs('car') > 0);
    const was = await before(inv, 'car');
    const now = answers(inv, 'car');
    assert.equal(now.recordings.length, 4);
    assert.deepEqual(JSON.parse(JSON.stringify(inv.get('car').recordings)), JSON.parse(JSON.stringify(was.recordings)), 'recordings');
    assert.deepEqual(now.encoded, was.recordings.map((r) => encodedOf(r, was.codecs)), 'encoded clips per recording');
    assert.deepEqual(now.days, summarizeDays(was.recordings, was.codecs), 'days');
    assert.ok(now.days.some((d) => d.encoded > 0) && now.days.some((d) => d.codecs.includes('av1')), 'codec answers are there');
    // a file entry reads as the old plain object did, field for field
    for (const [rel, f] of was.files) {
      const e = inv.get('car').files.get(rel);
      for (const k of Object.keys(f)) assert.equal(e[k], f[k], `${rel} ${k}`);
    }
    // and the codec map answers the same for every clip
    for (const [rel, c] of was.codecs) {
      const got = inv.codecs('car').get(rel);
      assert.deepEqual([got?.size, got?.mtimeMs, got?.codec], [c.size, c.mtimeMs, c.codec], rel);
    }
    assert.deepEqual(tree(root), untouched, 'nothing in the footage folders changed');
  } finally {
    db.close();
  }
});

test('the catalog follows every scan, and codecs are not read again after a restart', async () => {
  const root = await fixture();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-catalog-db-'));
  const dbFile = path.join(dir, 'manager.db');
  const untouched = tree(root);
  let first;
  {
    const { db, inv } = setup(root, dbFile);
    await inv.scan('car');
    await inv.probeCodecs('car');
    const files = inv.get('car').files;
    const rows = db.catalog.files('car');
    assert.equal(rows.length, files.size);
    for (const r of rows) {
      const f = files.get(r.rel);
      assert.deepEqual(r, { rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, ctimeMs: f.ctimeMs, birthtimeMs: f.birthtimeMs, kind: f.kind, type: f.type, day: f.day, camera: f.camera, eventId: f.eventId });
    }
    const sum = db.catalog.summary('car');
    assert.equal(sum.files, files.size);
    assert.equal(sum.bytes, [...files.values()].reduce((n, f) => n + f.size, 0));
    assert.equal(sum.days['2026-11-01'].clips, 30);
    assert.equal(db.get('codecs:car'), null, 'no settings value for the codecs any more');
    first = answers(inv, 'car');
    db.close();
  }
  assert.deepEqual(tree(root), untouched, 'nothing in the footage folders changed');

  // a restart: the same database, a new inventory
  {
    const { db, inv } = setup(root, dbFile);
    await inv.scan('car');
    assert.equal(await inv.probeCodecs('car'), 0, 'no clip read again');
    assert.deepEqual(answers(inv, 'car'), first, 'the same answers');

    // a clip replaced (the converter), one gone, one new: the catalog follows
    const swapped = 'TeslaCam/RecentClips/2026-11-01_09-00-00-front.mp4';
    await put(root, swapped, mp4('hvc1', 999));
    await fsp.rm(path.join(root, 'TeslaCam/RecentClips/2026-11-01_09-02-00-back.mp4'));
    await put(root, 'TeslaCam/RecentClips/2026-11-02_18-32-00-front.mp4', mp4('av01'));
    await inv.scan('car');
    assert.equal(await inv.probeCodecs('car'), 2, 'only the replaced and the new clip are read');
    const rows = new Map(db.catalog.files('car').map((r) => [r.rel, r]));
    assert.equal(rows.size, inv.get('car').files.size);
    assert.equal(rows.get(swapped).size, inv.get('car').files.get(swapped).size);
    assert.ok(!rows.has('TeslaCam/RecentClips/2026-11-01_09-02-00-back.mp4'), 'the gone clip is forgotten');
    assert.ok(rows.has('TeslaCam/RecentClips/2026-11-02_18-32-00-front.mp4'));
    const codecs = new Map(db.catalog.codecs('car').map((c) => [c.rel, c]));
    assert.equal(codecs.get(swapped).codec, 'h265');
    assert.ok(!codecs.has('TeslaCam/RecentClips/2026-11-01_09-02-00-back.mp4'));
    assert.equal(inv.codecs('car').get(swapped).codec, 'h265');
    db.close();
  }
});

test('the codecs of an older database move from the settings value into the catalog', async () => {
  const root = await fixture();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-catalog-db-'));
  const dbFile = path.join(dir, 'manager.db');
  // a manager.db from before the catalog: its tables, a user, the codecs as one value
  const raw = new DatabaseSync(dbFile);
  raw.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE users (username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);`);
  raw.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('admin', 's', 'h', 1);
  {
    // what the old inventory saved after reading every clip
    const { db, inv } = setup(root, ':memory:');
    await inv.scan('car');
    await inv.probeCodecs('car');
    const value = Object.fromEntries([...inv.codecs('car')].map(([rel, c]) => [rel, [c.size, c.mtimeMs, c.codec]]));
    raw.prepare('INSERT INTO settings VALUES (?, ?)').run('codecs:car', JSON.stringify(value));
    db.close();
  }
  raw.close();

  const { db, inv } = setup(root, dbFile);
  try {
    assert.equal(db.getUser('admin').hash, 'h', 'what the database had is kept');
    await inv.scan('car');
    assert.equal(await inv.probeCodecs('car'), 0, 'the saved codecs are used, nothing read');
    assert.equal(db.get('codecs:car'), null, 'the settings value is gone');
    assert.ok(db.catalog.codecs('car').length > 0, 'now in the catalog');
    const days = inv.days('car', inv.get('car').recordings);
    assert.ok(days.some((d) => d.codecs.includes('h265')));
  } finally {
    db.close();
  }
  // opened again: nothing to move, the catalog answers
  const again = setup(root, dbFile);
  try {
    assert.equal(again.inv.codecs('car').size, again.db.catalog.codecs('car').length);
  } finally {
    again.db.close();
  }
});

test('files moved without a scan (Recycle Bin, restore) reach the catalog at once', async () => {
  const root = await fixture();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-catalog-db-'));
  const { db, inv } = setup(root, path.join(dir, 'manager.db'));
  try {
    await inv.scan('car');
    const files = inv.get('car').files;
    const rels = [...files.keys()].filter((rel) => rel.startsWith('TeslaCam/SentryClips/'));
    assert.ok(rels.length > 0);
    const kept = rels.map((rel) => files.get(rel));
    // moved to the Recycle Bin: recycleBin.js deletes them from the map, then rebuilds
    for (const rel of rels) files.delete(rel);
    inv.rebuild('car');
    let rows = new Set(db.catalog.files('car').map((r) => r.rel));
    assert.equal(rows.size, files.size);
    for (const rel of rels) assert.ok(!rows.has(rel), `${rel} left the catalog`);
    // restored: back in the map, then rebuilt
    for (const f of kept) files.set(f.rel, f);
    inv.rebuild('car');
    rows = new Map(db.catalog.files('car').map((r) => [r.rel, r]));
    assert.equal(rows.size, files.size);
    for (const f of kept) assert.equal(rows.get(f.rel)?.size, f.size, `${f.rel} is back`);
  } finally {
    db.close();
  }
});
