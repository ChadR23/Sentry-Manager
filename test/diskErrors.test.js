'use strict';

// Disk read/write errors (server/stats/disks.js, alerts.js): counted from
// the app's start, and an alert once any appear.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DisksProvider } = require('../server/stats/disks');
const { Alerts } = require('../server/stats/alerts');

test('a disk whose error count rises is reported, from the count at start; an alert after 30 s', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diskerr-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sys = path.join(root, 'sys');
  const dev = path.join(sys, 'block', 'sda');
  fs.mkdirSync(path.join(dev, 'device'), { recursive: true });
  fs.mkdirSync(path.join(dev, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dev, 'size'), '1000\n');
  fs.writeFileSync(path.join(dev, 'device', 'model'), 'WDC WD80EFZZ\n');
  fs.writeFileSync(path.join(dev, 'queue', 'rotational'), '1\n');
  fs.writeFileSync(path.join(dev, 'device', 'ioerr_cnt'), '0x3\n'); // errors from before the app started
  fs.mkdirSync(path.join(sys, 'block', 'nvme0n1'), { recursive: true });
  fs.writeFileSync(path.join(sys, 'block', 'nvme0n1', 'size'), '1000\n');
  fs.mkdirSync(path.join(root, 'proc'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proc', 'diskstats'), '');
  let now = 0;
  const disks = new DisksProvider({ procRoot: path.join(root, 'proc'), sysRoot: sys, now: () => now, sensors: { diskTemp: () => null } });
  disks.probe();
  const errs = () => Object.fromEntries(disks.sample().map((d) => [d.name, d.ioErrors]));
  assert.deepEqual(errs(), { nvme0n1: undefined, sda: 0 }, 'old errors do not count; a disk without the counter has none');
  fs.writeFileSync(path.join(dev, 'device', 'ioerr_cnt'), '0x5\n');
  assert.deepEqual(errs(), { nvme0n1: undefined, sda: 2 });

  const raised = [];
  const alerts = new Alerts({ onAlert: (a) => raised.push(a) });
  const body = { disks: disks.sample() };
  alerts.evaluate(0, body);
  alerts.evaluate(31000, body);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].key, 'disk-errors:sda');
  assert.equal(raised[0].level, 'error');
  assert.match(raised[0].message, /Hard disk sda \(WDC WD80EFZZ\) reported 2 read\/write errors: check its health \(SMART\)/);
});
