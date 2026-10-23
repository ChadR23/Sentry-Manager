'use strict';

// Server monitor, alerts: raised only after 30 s over the line, cleared only
// after 30 s back under a lower mark, passed on once per raise; a NAS that
// hangs shows as slow, then unreachable, without holding anything up.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Alerts } = require('../server/stats/alerts');
const M = require('./fixtures/stats/machines');
const { setup, fakeFs } = require('./fixtures/stats/helpers');

const body = ({ cpuT = 50, disks = [], filesystems = [], availPct = 50, throttling = false } = {}) => ({
  cpu: { tempC: cpuT, throttling }, gpus: [], disks, filesystems,
  memory: { totalB: 1000, availableB: availPct * 10 }
});

test('hysteresis: 30 s over 90 °C to raise, 30 s under 85 °C to clear, one call per raise', () => {
  const raised = [];
  const cleared = [];
  const a = new Alerts({ onAlert: (x) => raised.push(x), onAlertClear: (x) => cleared.push(x.key) });
  let t = 0;
  const step = (cpuT, n = 1) => {
    let out;
    for (let i = 0; i < n; i++, t += 2000) out = a.evaluate(t, body({ cpuT }));
    return out;
  };
  assert.deepEqual(step(91, 15), [], '28 s over the line: not yet');
  assert.deepEqual(step(91), [{ key: 'cpu-temp', level: 'warn', message: 'CPU at 91 °C' }]);
  assert.deepEqual(raised, [{ key: 'cpu-temp', level: 'warn', message: 'CPU at 91 °C' }]);
  step(93, 10);
  assert.equal(raised.length, 1, 'still the same alert: no new notification');
  assert.equal(a.list()[0].message, 'CPU at 93 °C', 'the banner shows the current value');
  step(87, 30);
  assert.equal(a.list().length, 1, 'between the marks it stays raised');
  step(84, 15);
  assert.equal(a.list().length, 1, '28 s under: still raised');
  step(84);
  assert.deepEqual(a.list(), []);
  assert.deepEqual(cleared, ['cpu-temp']);
  // flapping around the line never raises
  for (let i = 0; i < 40; i++) step(i % 2 ? 91 : 89);
  assert.equal(raised.length, 1);
});

test('each rule: disks by kind, full filesystems, low memory, throttling', () => {
  const raised = [];
  const a = new Alerts({ onAlert: (x) => raised.push(x) });
  const b = body({
    disks: [{ name: 'nvme0n1', kind: 'nvme', tempC: 71 }, { name: 'sda', kind: 'hdd', tempC: 56 }, { name: 'sdb', kind: 'ssd', tempC: 56 }],
    filesystems: [{ label: 'Footage share', totalB: 100, usedB: 93, freeB: 7, reachable: true, latencyMs: 3 }, { label: 'Data', totalB: 100, usedB: 50, freeB: 50, reachable: true, latencyMs: 1 }],
    availPct: 4, throttling: true
  });
  for (let t = 0; t <= 30000; t += 2000) a.evaluate(t, b);
  assert.deepEqual(raised.map((x) => [x.key, x.level, x.message]).sort(), [
    ['cpu-throttle', 'warn', 'The CPU is slowing itself down to stay cool (thermal throttling)'],
    ['disk-temp:nvme0n1', 'warn', 'NVMe disk nvme0n1 at 71 °C'],
    ['disk-temp:sda', 'warn', 'Hard disk sda at 56 °C'],
    ['fs-full:Footage share', 'warn', 'Footage share is 93% full'],
    ['memory-low', 'warn', 'Memory almost full: 4% available']
  ]);
  // a reserve for root counts as full, like df
  const df = new Alerts({ onAlert: (x) => raised.push(x) });
  raised.length = 0;
  for (let t = 0; t <= 30000; t += 2000) df.evaluate(t, body({ filesystems: [{ label: 'D', totalB: 100, usedB: 86, freeB: 9, reachable: true, latencyMs: 1 }] }));
  assert.deepEqual(raised.map((x) => x.key), ['fs-full:D'], '86 used + 9 free: 90.5 % full');
});

test('a disk or share that goes away takes its alert with it; a failing handler changes nothing', () => {
  const cleared = [];
  const a = new Alerts({ onAlert: () => { throw new Error('notifications are down'); }, onAlertClear: (x) => cleared.push(x.key) });
  const hot = body({ disks: [{ name: 'sda', kind: 'hdd', tempC: 60 }] });
  for (let t = 0; t <= 30000; t += 2000) a.evaluate(t, hot);
  assert.deepEqual(a.list().map((x) => x.key), ['disk-temp:sda']);
  // the sensor answers nothing for a while: no change either way
  for (let t = 32000; t <= 80000; t += 2000) a.evaluate(t, body({ disks: [{ name: 'sda', kind: 'hdd', tempC: null }] }));
  assert.deepEqual(a.list().map((x) => x.key), ['disk-temp:sda']);
  a.evaluate(82000, body({ disks: [] }));
  assert.deepEqual(a.list(), []);
  assert.deepEqual(cleared, ['disk-temp:sda']);
});

test('a hot NVMe on a real sample stream: raised after 30 s, once, with the server told', async () => {
  const raised = [];
  const s = setup(M.intelArc, { options: { onAlert: (x) => raised.push(x) } });
  try {
    // the sensor's first answer lands with sample 1 (2 s); 30 s later is sample 16
    await s.run(15);
    assert.deepEqual(s.stats.snapshot().alerts, []);
    await s.run(16, 16);
    assert.deepEqual(s.stats.snapshot().alerts, [{ key: 'disk-temp:nvme0n1', level: 'warn', message: 'NVMe disk nvme0n1 at 72 °C' }]);
    await s.run(25, 18);
    assert.deepEqual(raised, [{ key: 'disk-temp:nvme0n1', level: 'warn', message: 'NVMe disk nvme0n1 at 72 °C' }]);
  } finally {
    s.done();
  }
});

test('a NAS that hangs: slow after 2 s, unreachable after 15 s, one check at a time, never blocking', async () => {
  const raised = [];
  const cleared = [];
  const s0 = setup(M.amd, { appPid: 8 });
  const clock = s0.clock;
  s0.done();
  const shares = { '/footage/tesla': { delayMs: 4, blocks: 1000, bfree: 500 }, '/data': { blocks: 1000, bfree: 900 } };
  const fsp = fakeFs(clock, shares);
  let statCalls = 0;
  const stat = fsp.stat;
  fsp.stat = (p) => {
    if (p === '/footage/tesla') statCalls++;
    return stat(p);
  };
  const s = setup(M.amd, {
    appPid: 8, clock,
    options: { fsp, readShares: () => [{ label: 'Footage share', path: '/footage/tesla' }, { label: 'Data', path: '/data' }], onAlert: (x) => raised.push(x), onAlertClear: (x) => cleared.push(x.key) }
  });
  try {
    await s.run(1);
    let share = s.stats.snapshot().filesystems[0];
    assert.equal(share.reachable, true);
    assert.equal(share.latencyMs, 4);
    assert.equal(statCalls, 1, 'checked at most every 10 s');
    // the share hangs; the next check (due at 10 s, sample 5) never answers
    shares['/footage/tesla'].hung = true;
    for (let p = 2; p <= 9; p++) await s.run(p, p);
    assert.equal(statCalls, 2, 'the hung check is not started again while it waits');
    share = s.stats.snapshot().filesystems[0];
    assert.equal(share.reachable, true, 'waiting 8 s: slow, not yet unreachable');
    assert.equal(share.latencyMs, 8000, 'the wait so far');
    for (let p = 10; p <= 30; p++) await s.run(p, p);
    share = s.stats.snapshot().filesystems[0];
    assert.equal(share.reachable, false, 'over 15 s');
    assert.equal(statCalls, 2);
    // unreachable says it all: no "slow" on top
    assert.deepEqual(s.stats.snapshot().alerts.map((a) => [a.key, a.level]), [['share-down:Footage share', 'error']]);
    assert.equal(s.stats.snapshot().filesystems[1].reachable, true, 'the other share is fine');
    assert.deepEqual(raised.map((x) => x.key), ['share-down:Footage share']);
    assert.deepEqual(cleared, []);
  } finally {
    s.done();
  }
});

test('a share that answers again clears its alerts after 30 s', async () => {
  const s0 = setup(M.amd, { appPid: 8 });
  const clock = s0.clock;
  s0.done();
  const shares = { '/footage/tesla': { error: 'EHOSTDOWN' } };
  const cleared = [];
  const s = setup(M.amd, {
    appPid: 8, clock,
    options: { fsp: fakeFs(clock, shares), readShares: () => [{ label: 'Footage share', path: '/footage/tesla' }], onAlertClear: (x) => cleared.push(x.key) }
  });
  try {
    await s.run(20);
    assert.deepEqual(s.stats.snapshot().alerts.map((a) => a.key), ['share-down:Footage share']);
    assert.equal(s.stats.snapshot().filesystems[0].latencyMs, null);
    shares['/footage/tesla'] = { delayMs: 2, blocks: 10, bfree: 5 };
    // the next check is due at 50 s; its answer counts from the sample after it
    await s.run(40, 21);
    assert.equal(s.stats.snapshot().alerts.length, 1, 'back for 28 s: not yet');
    await s.run(41, 41);
    assert.deepEqual(s.stats.snapshot().alerts, []);
    assert.deepEqual(cleared, ['share-down:Footage share']);
  } finally {
    s.done();
  }
});

test('low memory on a real sample stream (NVIDIA machine: 3.75 % available)', async () => {
  const s = setup(M.nvidia, { appPid: 10 });
  try {
    await s.run(16);
    assert.deepEqual(s.stats.snapshot().alerts, [{ key: 'memory-low', level: 'warn', message: 'Memory almost full: 3.8% available' }]);
  } finally {
    s.done();
  }
});
