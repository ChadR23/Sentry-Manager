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
