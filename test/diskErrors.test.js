'use strict';

// Disk read/write errors (server/stats/disks.js, alerts.js): counted from
// the app's start, an alert once a disk has two of its own, and none for
// errors that reach most disks at once or come across a stall.

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
  assert.match(raised[0].message, /Hard disk sda \(WDC WD80EFZZ\) keeps reporting read\/write errors \(2 of its own since the app started\): check its health \(SMART\)/);
});

function fakeDisks(t, names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diskerr-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sys = path.join(root, 'sys');
  const set = (name, n) => fs.writeFileSync(path.join(sys, 'block', name, 'device', 'ioerr_cnt'), `0x${n.toString(16)}\n`);
  for (const name of names) {
    fs.mkdirSync(path.join(sys, 'block', name, 'device'), { recursive: true });
    fs.mkdirSync(path.join(sys, 'block', name, 'queue'), { recursive: true });
    fs.writeFileSync(path.join(sys, 'block', name, 'size'), '1000\n');
    fs.writeFileSync(path.join(sys, 'block', name, 'queue', 'rotational'), '1\n');
    set(name, 0);
  }
  fs.mkdirSync(path.join(root, 'proc'), { recursive: true });
  // a counter line per disk, so samples have a time between them
  fs.writeFileSync(path.join(root, 'proc', 'diskstats'), names.map((n, i) => `8 ${i} ${n} 1 0 8 1 1 0 8 1 0 1 1`).join('\n'));
  const clock = { now: 0 };
  const disks = new DisksProvider({ procRoot: path.join(root, 'proc'), sysRoot: sys, now: () => clock.now, sensors: { diskTemp: () => null } });
  disks.probe();
  return { disks, set, clock };
}

test('one error on every disk in the same moment (a stall, a bus reset) is the server\'s, not each disk\'s: no alert', (t) => {
  const { disks, set, clock } = fakeDisks(t, ['sda', 'sdb', 'sdc', 'sdd', 'sde']);
  disks.sample();
  clock.now += 5000;
  for (const n of ['sda', 'sdb', 'sdc', 'sdd', 'sde']) set(n, 1);
  const got = disks.sample();
  assert.deepEqual(got.map((d) => [d.name, d.ioErrors, d.ioErrorsShared]), [['sda', 0, 1], ['sdb', 0, 1], ['sdc', 0, 1], ['sdd', 0, 1], ['sde', 0, 1]]);
  const raised = [];
  const alerts = new Alerts({ onAlert: (a) => raised.push(a) });
  alerts.evaluate(0, { disks: got });
  alerts.evaluate(31000, { disks: got });
  assert.equal(raised.length, 0);
  // later, one disk alone keeps erring: that one is its own
  clock.now += 5000;
  set('sdc', 2);
  disks.sample();
  clock.now += 5000;
  set('sdc', 3);
  const later = disks.sample();
  assert.deepEqual(later.map((d) => d.ioErrors), [0, 0, 2, 0, 0]);
  alerts.evaluate(40000, { disks: later });
  alerts.evaluate(71000, { disks: later });
  assert.deepEqual(raised.map((a) => a.key), ['disk-errors:sdc']);
});

test('errors that arrive across a stall (no sample for minutes) are not the disk\'s own; one error alone is no alert', (t) => {
  const { disks, set, clock } = fakeDisks(t, ['sda', 'sdb', 'sdc']);
  disks.sample();
  clock.now += 3 * 60_000; // the server froze for three minutes
  set('sda', 1);
  assert.deepEqual(disks.sample().map((d) => d.ioErrors), [0, 0, 0]);
  clock.now += 5000;
  set('sdb', 1); // one error, one disk
  const got = disks.sample();
  assert.deepEqual(got.map((d) => d.ioErrors), [0, 1, 0]);
  const raised = [];
  const alerts = new Alerts({ onAlert: (a) => raised.push(a) });
  alerts.evaluate(0, { disks: got });
  alerts.evaluate(31000, { disks: got });
  assert.equal(raised.length, 0, 'a single error is not "keeps reporting"');
});
