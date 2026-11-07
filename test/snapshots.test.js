'use strict';

// Database snapshots (server/snapshots.js) and log search by date (server/log.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ManagerDB } = require('../server/db');
const { createSnapshots, applyPendingRestore } = require('../server/snapshots');
const { Logger } = require('../server/log');

test('a snapshot a day, the newest 7 kept; restoring puts one in place at the next start', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbFile = path.join(dir, 'manager.db');
  let db = new ManagerDB(dbFile);
  db.set('marker', 'monday');
  let day = new Date('2026-11-01T12:00:00Z');
  const snaps = createSnapshots({ db, dbFile, dir: path.join(dir, 'snapshots'), now: () => day });
  assert.equal(snaps.take(), 'manager-2026-11-01.db');
  assert.equal(snaps.take(), null, 'once a day');
  for (let d = 2; d <= 9; d++) {
    day = new Date(`2026-11-0${d === 9 ? 9 : d}T12:00:00Z`);
    db.set('marker', `day ${d}`);
    snaps.take();
  }
  assert.deepEqual(snaps.list().map((x) => x.day), ['2026-11-09', '2026-11-08', '2026-11-07', '2026-11-06', '2026-11-05', '2026-11-04', '2026-11-03']);

  db.set('marker', 'broken later');
  assert.throws(() => snaps.prepareRestore('manager-2026-11-01.db'), /No such snapshot/, 'an old one that was pruned');
  assert.throws(() => snaps.prepareRestore('../manager.db'), /No such snapshot/);
  snaps.prepareRestore('manager-2026-11-05.db');
  db.db.close();
  assert.equal(applyPendingRestore(dbFile), true);
  db = new ManagerDB(dbFile);
  assert.equal(db.get('marker'), 'day 5');
  assert.ok(fs.existsSync(`${dbFile}.before-restore`), 'the replaced one is kept');
  assert.equal(applyPendingRestore(dbFile), false, 'nothing pending');
  db.db.close();
});

test('log search: between two dates, archived lines too, by text and level', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logsearch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'manager.log');
  fs.writeFileSync(file, [
    '2026-11-01T10:00:00.000Z INFO  [inventory] Car: 3 recordings',
    '2026-11-03T10:00:00.000Z WARN  [share] Car: share slow',
    '2026-11-05T10:00:00.000Z ERROR [converter] clip failed'
  ].join('\n') + '\n');
  const logger = new Logger({ file, silent: true });
  logger.archive(); // the lines above move to logs/archive/
  logger.write('info', 'inventory', 'Car: 4 recordings');
  const all = await logger.search({});
  assert.equal(all.length, 4, 'archived and current');
  const range = await logger.search({ from: Date.parse('2026-11-02T00:00:00Z'), to: Date.parse('2026-11-05T23:59:59Z') });
  assert.deepEqual(range.map((l) => l.scope), ['share', 'converter']);
  assert.deepEqual((await logger.search({ text: 'RECORDINGS' })).map((l) => l.message), ['Car: 3 recordings', 'Car: 4 recordings']);
  assert.deepEqual((await logger.search({ minLevel: 'warn' })).map((l) => l.level), ['warn', 'error']);
});
