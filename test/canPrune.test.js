'use strict';

// CAN logs live and die with their footage (server/canPrune.js): a log paired
// with the clips of its minute goes when they are deleted for good (the
// Recycle Bin emptied), stays while they are only in the bin, stays with
// protected footage, and logs with no footage are bounded by the car's oldest
// footage. Nothing is touched for unmapped keys, pending uploads or judgements,
// an unreachable share or an incomplete scan, or with the setting off.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { ManagerDB } = require('../server/db');
const { Inventory } = require('../server/inventory');
const { RecycleBin } = require('../server/recycleBin');
const { createCanLogs } = require('../server/canLogs');
const { createCanTrust } = require('../server/canTrust');
const { createCanPrune, spans, overlaps } = require('../server/canPrune');

const quiet = { info() {}, warn() {}, error() {} };
const KEY = 'car-key-1';

/** A clip name's wall clock in `tz` as UTC ms (as index.js reads clip names). */
function startOf(v, name) {
  const m = /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const off = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: v.timezone || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  };
  return guess - off(guess - off(guess));
}
/** The CAN log name of a UTC moment. */
const logName = (iso, key = KEY, seq = 1) => `${key}_${iso.replace(/[-:]/g, '').replace(/\.\d+/, '')}_${seq}.log.xz`;

async function fixture({ timezone = 'UTC', clips = [], events = {}, mapped = true } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-canprune-'));
  const root = path.join(dir, 'footage');
  const canDir = path.join(dir, 'can');
  for (const c of clips) {
    const f = path.join(root, 'TeslaCam', 'RecentClips', `${c}-front.mp4`);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, 'x');
  }
  for (const [folder, list] of Object.entries(events)) {
    for (const c of list) {
      const f = path.join(root, 'TeslaCam', 'SentryClips', folder, `${c}-front.mp4`);
      await fsp.mkdir(path.dirname(f), { recursive: true });
      await fsp.writeFile(f, 'x');
    }
  }
  await fsp.mkdir(root, { recursive: true });
  const db = new ManagerDB(':memory:');
  const share = { healthy: true, isHealthy() { return this.healthy; }, isWritable() { return this.healthy; } };
  const v = { id: 'car', name: 'Daily Driver', timezone, source: { type: 'path', path: root } };
  const vehicles = { get: (id) => (id === 'car' ? v : null), list: () => [v], share: () => share, rootOf: () => root };
  const inventory = new Inventory({ vehicles, db, log: quiet });
  const jobs = { start: () => 1, finish() {} };
  let prune = null;
  const bin = new RecycleBin({ db, vehicles, inventory, jobs, log: quiet, onDeleted: (item) => prune?.footageGone(item.vehicleId, item) });
  const canLogs = createCanLogs({ dir: canDir });
  const canTrust = createCanTrust({ dir: canDir });
  if (mapped) db.set('can-vehicles', { [KEY]: 'car' });
  const dropped = [];
  const audits = [];
  const logs = [];
  prune = createCanPrune({
    db, vehicles, inventory, canLogs, canTrust, startOf, withLock: (vid, fn) => bin.withLock(vid, fn),
    keysOf: (vid) => Object.entries(db.get('can-vehicles', {}) || {}).filter(([, id]) => id === vid).map(([k]) => k),
    drop: async (key, name) => { dropped.push(name); },
    audit: { info: (m) => audits.push(m) }, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, soonMs: 3_600_000
  });
  /** A finished, judged log (unsigned: an older bridge), or one still pending. */
  const addLog = async (name, { judged = true, sidecar = true, sidecarPart = false } = {}) => {
    const kdir = path.join(canDir, name.split('_')[0]);
    await fsp.mkdir(kdir, { recursive: true });
    await fsp.writeFile(path.join(kdir, name), 'log');
    if (sidecar) await fsp.writeFile(path.join(kdir, `${name}.json`), '{}');
    if (sidecarPart) await fsp.writeFile(path.join(kdir, `${name}.json.part`), '{');
    if (judged) await canTrust.check(name.split('_')[0], name);
  };
  const exists = (name) => fs.existsSync(path.join(canDir, name.split('_')[0], name));
  const recOf = (name) => inventory.get('car').recordings.find((r) => r.files.some((f) => f.includes(name)));
  await inventory.scan('car');
  return { dir, root, db, v, share, inventory, bin, canLogs, canTrust, prune, addLog, exists, recOf, dropped, audits, logs, done: () => { prune.stop(); return fsp.rm(dir, { recursive: true, force: true }); } };
}

test('spans and overlaps: a log is a minute (to ten), a clip about a minute', () => {
  const rows = [{ name: 'a', startedAtMs: 0, seq: 1 }, { name: 'b', startedAtMs: 60_000, seq: 1 }, { name: 'c', startedAtMs: 3_600_000, seq: 1 }];
  assert.deepEqual(spans(rows).map((s) => [s.row.name, s.from, s.to]), [['a', 0, 60_000], ['b', 60_000, 660_000], ['c', 3_600_000, 3_660_000]]);
  assert.equal(overlaps([120_000], 60_000, 120_000), false, 'a clip that starts as the log ends');
  assert.equal(overlaps([0], 61_000, 121_000), true, 'a clip a little over a minute');
  assert.equal(overlaps([], 0, 1), false);
});

test('emptying the Recycle Bin deletes the paired logs; while it is only in the bin they stay; a restore keeps them', async () => {
  const f = await fixture({ clips: ['2026-11-01_10-00-00', '2026-11-01_10-01-00', '2026-11-01_12-00-00', '2026-11-01_12-01-00'] });
  try {
    const a = logName('2026-11-01T10:00:00Z');
    const b = logName('2026-11-01T10:01:00Z');
    const c = logName('2026-11-01T12:00:00Z');
    for (const n of [a, b, c]) await f.addLog(n);
    // the 10:00 drive to the bin
    const rec = f.recOf('2026-11-01_10-00-00');
    await f.bin.trash('car', [rec.id]);
    let out = await f.prune.check('car');
    assert.equal(out.removed, 0, 'in the bin: kept');
    assert.ok(f.exists(a) && f.exists(b));
    assert.equal((await f.prune.pairing(KEY)).get(a), 'paired', 'footage in the bin still pairs');
    // restored: still kept
    const item = f.db.binItems('car')[0];
    await f.bin.restore(item.id);
    await f.inventory.scan('car');
    out = await f.prune.check('car');
    assert.equal(out.removed, 0);
    // to the bin again, and the bin emptied
    await f.bin.trash('car', [f.recOf('2026-11-01_10-00-00').id]);
    await f.bin.empty('car');
    out = await f.prune.check('car');
    assert.equal(out.removed, 2);
    assert.equal(out.footage, 2);
    assert.ok(!f.exists(a) && !f.exists(b) && f.exists(c), 'the 12:00 log keeps its footage');
    assert.ok(!fs.existsSync(path.join(f.dir, 'can', KEY, `${a}.json`)), 'its sidecar goes too');
    assert.deepEqual(f.dropped.sort(), [a, b].sort(), 'taken out of the index and the sync');
    assert.equal((await f.canTrust.record(KEY, a)).deleted, true, 'its trust record is kept, marked deleted (for the chain)');
    assert.match(f.audits.join('\n'), /CAN logs deleted with their footage \(car Daily Driver\): 2 \(2 with their footage deleted\)/);
    assert.match(f.logs.join('\n'), /CAN logs: removed 2 with their footage \(car Daily Driver\)/);
    // done with: the deleted minutes are forgotten, a run again removes nothing
    assert.equal(f.db.get('can-prune:car').gone.length, 0);
    assert.equal((await f.prune.check('car')).removed, 0);
  } finally { await f.done(); }
});

test('a clip of the same minute elsewhere (a Sentry event) keeps the log; a clip in the car\'s zone pairs by its UTC minute', async () => {
  const f = await fixture({ timezone: 'Europe/Berlin', clips: ['2026-11-01_11-00-00', '2026-11-01_13-00-00'], events: { '2026-11-01_11-00-30': ['2026-11-01_11-00-00'] } });
  try {
    // 11:00 in Berlin (UTC+1 in November) is 10:00 UTC
    const a = logName('2026-11-01T10:00:00Z');
    const b = logName('2026-11-01T12:00:00Z');
    await f.addLog(a);
    await f.addLog(b);
    const pairs = await f.prune.pairing(KEY);
    assert.equal(pairs.get(a), 'paired');
    assert.equal(pairs.get(b), 'paired');
    const recent = f.inventory.get('car').recordings.find((r) => r.category === 'Recent' && r.files.some((x) => x.includes('11-00-00')));
    await f.bin.trash('car', [recent.id]);
    await f.bin.empty('car');
    assert.equal((await f.prune.check('car')).removed, 0, 'the Sentry clip of that minute still covers it');
    assert.ok(f.exists(a));
  } finally { await f.done(); }
});

test('protected footage keeps its log', async () => {
  const f = await fixture({ clips: ['2026-11-01_09-00-00', '2026-11-01_10-00-00'] });
  try {
    const a = logName('2026-11-01T10:00:00Z');
    await f.addLog(a);
    const rec = f.recOf('2026-11-01_10-00-00');
    await f.bin.setProtected('car', rec.files, true);
    f.inventory.rebuild('car');
    // a policy or a delete cannot move it, so emptying the bin leaves it and its log
    const moved = await f.bin.trash('car', [rec.id, f.recOf('2026-11-01_09-00-00').id]);
    assert.deepEqual(moved.skipped.map((x) => x.reason), ['protected']);
    await f.bin.empty('car');
    // and even with its minute noted as deleted (another camera's copy deleted), protection covers it
    f.prune.footageGone('car', { files: [{ rel: 'TeslaCam/RecentClips/2026-11-01_10-00-00-back.mp4' }] });
    // the protected clip is counted even if a scan were to miss it
    f.inventory.get('car').files.delete(rec.files[0]);
    assert.equal((await f.prune.check('car')).removed, 0);
    assert.ok(f.exists(a));
  } finally { await f.done(); }
});

test('no footage in its minute: kept while newer than the oldest footage, deleted once older (with a margin)', async () => {
  const f = await fixture({ clips: ['2026-11-05_10-00-00', '2026-11-06_10-00-00'] });
  try {
    const gap = logName('2026-11-05T18:00:00Z'); // an archive gap between footage
    const margin = logName('2026-11-05T09:30:00Z'); // just before the oldest footage, inside the hour
    const old = logName('2026-11-04T10:00:00Z'); // a day before all footage
    for (const n of [gap, margin, old]) await f.addLog(n);
    assert.equal((await f.prune.pairing(KEY)).get(gap), 'none');
    const out = await f.prune.check('car');
    assert.equal(out.removed, 1);
    assert.equal(out.old, 1);
    assert.ok(f.exists(gap) && f.exists(margin) && !f.exists(old));
    assert.match(f.audits.join('\n'), /1 older than the car's oldest footage/);
  } finally { await f.done(); }
});

test('an unmapped key is never touched', async () => {
  const f = await fixture({ clips: ['2026-11-05_10-00-00'], mapped: false });
  try {
    const old = logName('2026-11-01T10:00:00Z');
    await f.addLog(old);
    const out = await f.prune.check('car');
    assert.equal(out.removed, 0);
    assert.match(out.skip, /no CAN Bridge key is mapped/);
    assert.ok(f.exists(old));
    assert.equal(await f.prune.pairing(KEY), null, 'no car: no pairing shown');
    // a mapped key beside it goes, the unmapped one stays
    f.db.set('can-vehicles', { other: 'car' });
    const mine = logName('2026-11-01T10:00:00Z', 'other');
    await f.addLog(mine);
    assert.equal((await f.prune.check('car')).removed, 1);
    assert.ok(f.exists(old) && !f.exists(mine));
  } finally { await f.done(); }
});

test('a log still arriving or waiting for its check is not deleted', async () => {
  const f = await fixture({ clips: ['2026-11-05_10-00-00'] });
  try {
    const waiting = logName('2026-11-01T10:00:00Z');
    const unjudged = logName('2026-11-01T10:05:00Z');
    const uploading = logName('2026-11-01T10:10:00Z');
    await f.addLog(waiting, { sidecar: false }); // judged: waiting for its sidecar
    await f.addLog(unjudged, { judged: false });
    await f.addLog(uploading, { sidecar: false, sidecarPart: true });
    assert.equal((await f.canTrust.record(KEY, waiting)).status, 'waiting');
    const out = await f.prune.check('car');
    assert.equal(out.removed, 0);
    assert.equal(out.pending, 3);
    assert.ok(f.exists(waiting) && f.exists(unjudged) && f.exists(uploading));
  } finally { await f.done(); }
});

test('share unreachable, a scan running, failed or incomplete, or no footage at all: nothing is deleted', async () => {
  const f = await fixture({ clips: ['2026-11-05_10-00-00'] });
  try {
    const old = logName('2026-11-01T10:00:00Z');
    await f.addLog(old);
    f.share.healthy = false;
    assert.match((await f.prune.check('car')).skip, /share is not reachable/);
    f.share.healthy = true;
    const entry = f.inventory.get('car');
    entry.errorCount = 3;
    assert.match((await f.prune.check('car')).skip, /could not be read/);
    entry.errorCount = 0;
    entry.scanning = true;
    assert.match((await f.prune.check('car')).skip, /scan is running/);
    entry.scanning = false;
    entry.lastError = 'EIO';
    assert.match((await f.prune.check('car')).skip, /last scan failed/);
    delete entry.lastError;
    assert.ok(f.exists(old));
    // the share looks empty (an outage, a folder unmounted): nothing
    await fsp.rm(path.join(f.root, 'TeslaCam'), { recursive: true });
    await f.inventory.scan('car');
    assert.match((await f.prune.check('car')).skip, /no footage at all/);
    assert.ok(f.exists(old));
  } finally { await f.done(); }
});

test('a deleted minute noted while the share is away is acted on once it is back', async () => {
  const f = await fixture({ clips: ['2026-11-01_09-00-00', '2026-11-01_10-00-00'] });
  try {
    const a = logName('2026-11-01T10:00:00Z');
    await f.addLog(a);
    await f.bin.trash('car', [f.recOf('2026-11-01_10-00-00').id]);
    await f.bin.empty('car');
    f.share.healthy = false;
    assert.equal((await f.prune.check('car')).removed, 0);
    assert.equal(f.db.get('can-prune:car').gone.length, 1, 'remembered');
    f.share.healthy = true;
    assert.equal((await f.prune.check('car')).removed, 1);
    assert.ok(!f.exists(a));
  } finally { await f.done(); }
});

test('the setting off: nothing is deleted; on by default', async () => {
  const f = await fixture({ clips: ['2026-11-05_10-00-00'] });
  try {
    assert.equal(f.prune.settings().withFootage, true, 'on by default');
    const old = logName('2026-11-01T10:00:00Z');
    await f.addLog(old);
    f.prune.set({ withFootage: false });
    const out = await f.prune.check('car');
    assert.equal(out.removed, 0);
    assert.equal(out.skip, 'turned off');
    await f.prune.sweep();
    assert.ok(f.exists(old));
    assert.equal(f.prune.status().withFootage, false);
    f.prune.set({ withFootage: true });
    assert.equal((await f.prune.check('car')).removed, 1);
  } finally { await f.done(); }
});

test('a run deletes at most a batch; the rest the next time', async () => {
  const f = await fixture({ clips: ['2026-11-05_10-00-00'] });
  try {
    f.prune.stop();
    const p = createCanPrune({
      db: f.db, vehicles: { get: () => f.v, list: () => [f.v], share: () => f.share }, inventory: f.inventory, canLogs: f.canLogs, canTrust: f.canTrust, startOf,
      keysOf: () => [KEY], drop: async () => {}, batch: 2, soonMs: 3_600_000
    });
    for (let i = 0; i < 5; i++) await f.addLog(logName(`2026-11-01T10:0${i}:00Z`));
    const out = await p.check('car');
    assert.equal(out.removed, 2);
    assert.equal(out.more, 3);
    assert.equal((await p.check('car')).removed, 2);
    assert.equal((await p.check('car')).removed, 1);
    p.stop();
  } finally { await f.done(); }
});
