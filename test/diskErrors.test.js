'use strict';

// Disk read/write errors (server/stats/disks.js, alerts.js): the kernel's
// ioerr_cnt counts harmless rejected commands too (the NAS's SMART polling),
// so a disk's errors are its own only when they come while it moves data,
// and the alert needs a burst (5 in 10 minutes) and clears after it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DisksProvider, RECENT_MS } = require('../server/stats/disks');
const { Alerts } = require('../server/stats/alerts');

function fakeDisks(t, names, { model } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diskerr-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sys = path.join(root, 'sys');
  const set = (name, n) => fs.writeFileSync(path.join(sys, 'block', name, 'device', 'ioerr_cnt'), `0x${n.toString(16)}\n`);
  for (const name of names) {
    fs.mkdirSync(path.join(sys, 'block', name, 'device'), { recursive: true });
    fs.mkdirSync(path.join(sys, 'block', name, 'queue'), { recursive: true });
    fs.writeFileSync(path.join(sys, 'block', name, 'size'), '1000\n');
    fs.writeFileSync(path.join(sys, 'block', name, 'queue', 'rotational'), '1\n');
    if (model) fs.writeFileSync(path.join(sys, 'block', name, 'device', 'model'), `${model}\n`);
    set(name, 0);
  }
  fs.mkdirSync(path.join(root, 'proc'), { recursive: true });
  const sectors = Object.fromEntries(names.map((n) => [n, 8]));
  const writeStats = () => fs.writeFileSync(path.join(root, 'proc', 'diskstats'),
    names.map((n, i) => `8 ${i} ${n} 1 0 ${sectors[n]} 1 1 0 8 1 0 1 1`).join('\n'));
  writeStats();
  /** the disk reads some data before the next sample */
  const busy = (...which) => { for (const n of which) sectors[n] += 2048; writeStats(); };
  const clock = { now: 0 };
  const disks = new DisksProvider({ procRoot: path.join(root, 'proc'), sysRoot: sys, now: () => clock.now, sensors: { diskTemp: () => null } });
  disks.probe();
  return { disks, set, clock, busy };
}

const raisedFor = (body) => {
  const raised = [];
  const alerts = new Alerts({ onAlert: (a) => raised.push(a) });
  alerts.evaluate(0, body);
  alerts.evaluate(31000, body);
  return { raised, alerts };
};

test('errors on an idle disk (SMART polling, rejected queries) are not its own: no alert however many', (t) => {
  const { disks, set, clock } = fakeDisks(t, ['sda', 'sdb', 'sdc']);
  disks.sample();
  for (let i = 1; i <= 20; i++) {
    clock.now += 2000;
    set('sdb', i * 3);
    disks.sample();
  }
  const got = disks.sample();
  assert.deepEqual(got.map((d) => [d.name, d.ioErrors, d.ioErrorsRecent, d.ioErrorsShared]),
    [['sda', 0, 0, undefined], ['sdb', 0, 0, 60], ['sdc', 0, 0, undefined]]);
  assert.equal(raisedFor({ disks: got }).raised.length, 0);
});

test('a few errors during traffic (one SMART poll on a busy disk) are no alert; a burst of five is, and it clears after 10 minutes', (t) => {
  const { disks, set, clock, busy } = fakeDisks(t, ['sda', 'sdb', 'sdc'], { model: 'WDC WD80EFZZ' });
  set('sda', 3); // errors from before the app started
  disks.sample();
  clock.now += 2000;
  busy('sda');
  set('sda', 6);
  let got = disks.sample();
  assert.deepEqual([got[0].ioErrors, got[0].ioErrorsRecent], [3, 3], 'counted from the start, during traffic');
  assert.equal(raisedFor({ disks: got }).raised.length, 0, 'three is not a burst');

  clock.now += 2000;
  busy('sda');
  set('sda', 9);
  got = disks.sample();
  assert.equal(got[0].ioErrorsRecent, 6);
  const raised = [];
  const alerts = new Alerts({ onAlert: (a) => raised.push(a), onAlertClear: (a) => raised.push({ cleared: a.key }) });
  alerts.evaluate(0, { disks: got });
  alerts.evaluate(31000, { disks: got });
  assert.equal(raised.length, 1);
  assert.equal(raised[0].key, 'disk-errors:sda');
  assert.equal(raised[0].level, 'warn');
  assert.match(raised[0].message, /^Hard disk sda \(WDC WD80EFZZ\): 6 reads or writes failed in the last 10 minutes\. This is the kernel's error count, not SMART/);

  clock.now += RECENT_MS;
  got = disks.sample();
  assert.deepEqual([got[0].ioErrors, got[0].ioErrorsRecent], [6, 0]);
  alerts.evaluate(40000, { disks: got });
  alerts.evaluate(71000, { disks: got });
  assert.deepEqual(raised.at(-1), { cleared: 'disk-errors:sda' });
});

test('errors on most disks in the same moment, or across a stall, are the server\'s even during traffic', (t) => {
  const { disks, set, clock, busy } = fakeDisks(t, ['sda', 'sdb', 'sdc', 'sdd']);
  disks.sample();
  clock.now += 2000;
  busy('sda', 'sdb', 'sdc', 'sdd');
  for (const n of ['sda', 'sdb', 'sdc']) set(n, 10);
  let got = disks.sample();
  assert.deepEqual(got.map((d) => [d.ioErrors, d.ioErrorsShared]), [[0, 10], [0, 10], [0, 10], [0, undefined]]);
  clock.now += 3 * 60_000; // the server froze for three minutes
  busy('sdd');
  set('sdd', 10);
  got = disks.sample();
  assert.deepEqual(got.map((d) => d.ioErrors), [0, 0, 0, 0]);
  assert.equal(raisedFor({ disks: got }).raised.length, 0);
});

test('errors that came while nobody watched are not counted as the disk\'s own', (t) => {
  const { disks, set, clock, busy } = fakeDisks(t, ['sda', 'sdb', 'sdc']);
  disks.sample();
  clock.now += 2000;
  disks.sample();
  disks.resetBaseline(); // goIdle: nobody watches any more
  clock.now += 3_600_000;
  busy('sda');
  set('sda', 25);
  const got = disks.sample(); // touch(): sampling starts again
  assert.equal(got[0].readBps, null, 'no rate averaged over the idle hour');
  assert.deepEqual([got[0].ioErrors, got[0].ioErrorsShared], [0, 25]);
  assert.equal(raisedFor({ disks: got }).raised.length, 0);
});

test('a disk without the counter has none', (t) => {
  const { disks } = fakeDisks(t, ['sda']);
  fs.rmSync(path.join(disks.sysRoot, 'block', 'sda', 'device', 'ioerr_cnt'));
  assert.equal(disks.sample()[0].ioErrors, undefined);
});

test('the stats engine resets the disk baseline when it goes idle', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'stats', 'index.js'), 'utf8');
  const idle = src.slice(src.indexOf('function goIdle()'), src.indexOf('load();', src.indexOf('function goIdle()')));
  assert.match(idle, /disks\.resetBaseline\(\)/);
});
