'use strict';

// The CAN log store's limits: a stolen token cannot fill the disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCanLogs } = require('../server/canLogs');

const put = (logs, name, body = Buffer.from(name)) => logs.receive(name, body, { offset: 0, length: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') });

test('at most so many files per car, and a floor of free disk kept for everything else', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canlogs-'));
  const logs = createCanLogs({ dir, maxFilesPerCar: 3, minFree: 0 });
  for (let i = 1; i <= 3; i++) assert.equal((await put(logs, `K_20200101T08000${i}Z_${i}.log.xz`)).complete, true);
  await assert.rejects(put(logs, 'K_20200101T080009Z_9.log.xz'), (e) => e.status === 507 && e.code === 'car_full');
  // another car is not affected
  assert.equal((await put(logs, 'L_20200101T080000Z_1.log.xz')).complete, true);
  // a disk below the floor takes nothing more
  const tight = createCanLogs({ dir, freeBytes: async () => 1024 ** 3, minFree: 2 * 1024 ** 3 });
  await assert.rejects(put(tight, 'M_20200101T080000Z_1.log.xz'), (e) => e.status === 507 && e.code === 'no_space');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the cap counts finished logs only (sidecars are not), and the default allows years of 24/7 uploads', async () => {
  const { MAX_LOGS_PER_CAR } = require('../server/canLogs');
  assert.ok(MAX_LOGS_PER_CAR >= 144 * 365 * 3, 'three years of a log every 10 minutes');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canlogs-'));
  const logs = createCanLogs({ dir, maxFilesPerCar: 2, minFree: 0 });
  for (let i = 1; i <= 2; i++) {
    await put(logs, `K_20200101T08000${i}Z_${i}.log.xz`);
    await put(logs, `K_20200101T08000${i}Z_${i}.log.xz.json`, Buffer.from('{"frames":5}'));
  }
  await assert.rejects(put(logs, 'K_20200101T080009Z_9.log.xz'), (e) => e.status === 507 && e.code === 'car_full');
  // a sidecar for a log already here still comes in
  await logs.remove('K_20200101T080002Z_2.log.xz');
  assert.equal((await put(logs, 'K_20200101T080009Z_9.log.xz')).complete, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the list comes from a catalogue kept current by uploads and deletes, and sees changes made from outside', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canlogs-'));
  let t = 1_000_000;
  const logs = createCanLogs({ dir, minFree: 0, now: () => t });
  await put(logs, 'K_20200101T080001Z_1.log.xz', Buffer.from('aaaa'));
  await put(logs, 'K_20200101T080001Z_1.log.xz.json', Buffer.from('{"frames":7,"app_version":"1.0"}'));
  await put(logs, 'K_20200101T081001Z_2.log.xz', Buffer.from('bb'));
  let out = await logs.list();
  assert.deepEqual(out.logs.map((l) => [l.name, l.bytes, l.frames, l.appVersion, l.sidecar]), [
    ['K_20200101T081001Z_2.log.xz', 2, null, null, false],
    ['K_20200101T080001Z_1.log.xz', 4, 7, '1.0', true]
  ]);
  assert.equal(out.bytes, 4 + 2 + 32);
  assert.deepEqual(await logs.summary(), { bytes: 38, count: 2, keys: ['K'] });
  // reads nothing from disk while nothing changed
  const fsp = require('fs/promises');
  const real = { readFile: fsp.readFile, readdir: fsp.readdir };
  let reads = 0;
  fsp.readFile = async (...a) => { reads++; return real.readFile(...a); };
  fsp.readdir = async (...a) => { if (String(a[0]).endsWith(`${path.sep}K`)) reads++; return real.readdir(...a); };
  try {
    await logs.list();
    await logs.summary();
    await put(logs, 'K_20200101T082001Z_3.log.xz', Buffer.from('c'));
    reads = 0;
    out = await logs.list();
    assert.equal(out.count, 3);
    assert.equal(reads, 0, 'an upload updated the catalogue itself');
    await logs.remove('K_20200101T080001Z_1.log.xz');
    out = await logs.list();
    assert.deepEqual(out.logs.map((l) => l.name), ['K_20200101T082001Z_3.log.xz', 'K_20200101T081001Z_2.log.xz']);
    assert.equal(out.bytes, 3);
    assert.equal(reads, 0);
  } finally { Object.assign(fsp, real); }
  // a log put there by hand: the folder's time changed, so it is read again
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(dir, 'K', 'K_20200101T083001Z_4.log.xz'), 'dddd');
  assert.equal((await logs.list()).count, 3);
  // and at least every 10 minutes anyway
  fs.writeFileSync(path.join(dir, 'K', 'K_20200101T081001Z_2.log.xz.json'), '{"frames":9}');
  t += 11 * 60_000;
  assert.equal((await logs.list()).logs.find((l) => l.name === 'K_20200101T081001Z_2.log.xz').frames, 9);
  fs.rmSync(dir, { recursive: true, force: true });
});
