'use strict';

// Server monitor, data used: bytes per day from the cumulative network
// counters (gaps lose nothing, a span over midnight is split by time, and a
// reading once a day puts each day's bytes in that day), counter resets and
// bogus jumps never counted, the days of this container and of the whole
// server kept apart, the saved readings that let a restart of the app alone
// count on, the links counted (no tunnel over a counted link), and the
// network block of GET /api/stats with today, this week and this month.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Traffic, MAX_BPS } = require('../server/stats/traffic');
const { NetworkProvider } = require('../server/stats/network');
const { dayKey } = require('../server/stats/energy');
const M = require('./fixtures/stats/machines');
const { setup, fakeClock, trackedTimers } = require('./fixtures/stats/helpers');

const MiB = 1048576;
const H = 3600000;
const DAY = 24 * H;
// June: no clock change in any common time zone, so the hours below are real hours
const at = (d, h = 12, min = 0) => new Date(2026, 5, d, h, min).getTime();
const read = (ifs) => new Map(Object.entries(ifs).map(([name, [rx, tx]]) => [name, { rx, tx }]));
const HERE = { scope: 'container', boot: 'b0a3c1d2-0000-4000-8000-000000000001', netns: 'net:[4026532001]' };
const index = (map) => (name) => map[name] ?? null;
const day = (tr, t) => tr.summary(t).today;

test('deltas: the first reading only starts the count; then every byte counts, gaps included', () => {
  const tr = new Traffic();
  tr.add(at(10), read({ eth0: [1000, 500] }), HERE);
  assert.deepEqual(tr.summary(at(10)), { today: null, week: null, month: null }, 'nothing measured yet');
  tr.add(at(10) + 2000, read({ eth0: [3000, 900] }), HERE);
  assert.deepEqual(day(tr, at(10) + 2000), { rxB: 2000, txB: 400 });
  // two hours with nobody watching: the counter kept counting, so all of it counts
  tr.add(at(10) + 2 * H, read({ eth0: [3000 + 5e9, 900 + 1e9] }), HERE);
  assert.deepEqual(day(tr, at(10) + 2 * H), { rxB: 2000 + 5e9, txB: 400 + 1e9 });
  // nothing moved: measured, and 0 bytes more
  tr.add(at(10) + 2 * H + 2000, read({ eth0: [3000 + 5e9, 900 + 1e9] }), HERE);
  assert.deepEqual(day(tr, at(10) + 2 * H + 2000), { rxB: 2000 + 5e9, txB: 400 + 1e9 });
  // a reading that failed (null) changes nothing
  tr.add(at(10) + 2 * H + 4000, null, HERE);
  tr.add(at(10) + 2 * H + 6000, read({ eth0: [4000 + 5e9, 1000 + 1e9] }), HERE);
  assert.deepEqual(day(tr, at(10) + 2 * H + 6000), { rxB: 3000 + 5e9, txB: 500 + 1e9 });
  // and an empty one is still "measured, nothing used"
  const quiet = new Traffic();
  quiet.add(at(10), read({ eth0: [0, 0] }), HERE);
  quiet.add(at(10) + 2000, read({ eth0: [0, 0] }), HERE);
  assert.deepEqual(quiet.summary(at(10) + 2000), { today: { rxB: 0, txB: 0 }, week: { rxB: 0, txB: 0 }, month: { rxB: 0, txB: 0 } });
});

test('a span over midnight, or over several days, is split by time and adds up to the whole', () => {
  const tr = new Traffic();
  tr.add(at(10, 23), read({ eth0: [0, 0] }), HERE);
  tr.add(at(11, 1), read({ eth0: [7200, 3601] }), HERE);
  assert.deepEqual(day(tr, at(10, 23)), { rxB: 3600, txB: 1801 }, 'one hour before midnight');
  assert.deepEqual(day(tr, at(11, 1)), { rxB: 3600, txB: 1800 }, 'one hour after; rounded so the two add up');

  const days = new Traffic();
  days.add(at(10), read({ eth0: [1e6, 0] }), HERE);
  days.add(at(13), read({ eth0: [1e6 + 72e6, 72] }), HERE); // three days later, noon to noon
  assert.deepEqual([10, 11, 12, 13].map((d) => day(days, at(d)).rxB), [12e6, 24e6, 24e6, 12e6]);
  assert.deepEqual([10, 11, 12, 13].map((d) => day(days, at(d)).txB), [12, 24, 24, 12]);
  assert.deepEqual(days.summary(at(13)).week, { rxB: 72e6, txB: 72 });
  assert.equal(days.summary(at(14)).today, null, 'a day nothing measured');

  // odd numbers never lose or make up a byte across the days
  const odd = new Traffic();
  odd.add(at(1, 7, 13), read({ eth0: [0, 0] }), HERE);
  odd.add(at(9, 16, 41), read({ eth0: [987654321, 123456789] }), HERE);
  const all = Object.values(odd.toJSON().days.container);
  assert.equal(all.length, 9);
  assert.equal(all.reduce((n, v) => n + v.rx, 0), 987654321);
  assert.equal(all.reduce((n, v) => n + v.tx, 0), 123456789);
  assert.ok(all.every((v) => Number.isInteger(v.rx) && Number.isInteger(v.tx)));

  // a gap of months: only the kept 62 days get their share, nothing loops for long
  const long = new Traffic();
  long.add(at(1) - 400 * DAY, read({ eth0: [0, 0] }), HERE);
  long.add(at(1), read({ eth0: [400e6, 0] }), HERE);
  const kept = long.toJSON().days.container;
  assert.equal(Object.keys(kept).length, 62);
  assert.equal(kept[dayKey(at(1))].rx, 0.5e6, 'midnight to noon of a 400-day span');
});

test('week and month: the 7 calendar days ending today and the current calendar month', () => {
  const tr = new Traffic();
  tr.load({
    days: {
      container: {
        '2026-05-27': { rx: 1, tx: 10 }, '2026-05-28': { rx: 2, tx: 20 }, '2026-05-31': { rx: 4, tx: 40 },
        '2026-06-01': { rx: 8, tx: 80 }, '2026-06-03': { rx: 16, tx: 160 }, '2026-06-04': { rx: 32, tx: 320 }
      }
    }
  });
  assert.deepEqual(tr.summary(at(3)), {
    today: { rxB: 16, txB: 160 },
    week: { rxB: 2 + 4 + 8 + 16, txB: 20 + 40 + 80 + 160 },
    month: { rxB: 8 + 16, txB: 80 + 160 }
  }, 'May 27 is 8 days back; June 4 (a clock set back) is not "this month so far"');
  assert.deepEqual(tr.summary(at(2)).today, null, 'nothing measured on June 2');
  assert.deepEqual(tr.summary(at(11)).week, null, 'June 5 to 11');
  assert.deepEqual(tr.summary(at(11)).month, { rxB: 8 + 16 + 32, txB: 80 + 160 + 320 });
});

test('a counter that went down starts a new count: reset, recreated link, 32-bit wrap', () => {
  const tr = new Traffic();
  const t = at(10);
  tr.add(t, read({ eth0: [5e9, 2e9] }), HERE);
  tr.add(t + 2000, read({ eth0: [5e9 + 1000, 2e9 + 100] }), HERE);
  assert.deepEqual(day(tr, t), { rxB: 1000, txB: 100 });
  // the interface was made again (or the container restarted): both counters from 0
  tr.add(t + 4000, read({ eth0: [300, 30] }), HERE);
  assert.deepEqual(day(tr, t), { rxB: 1000, txB: 100 }, 'never a negative');
  tr.add(t + 6000, read({ eth0: [800, 80] }), HERE);
  assert.deepEqual(day(tr, t), { rxB: 1500, txB: 150 }, 'counted on from the new count');
  // only one direction went down: still a new count for the link, nothing counted
  tr.add(t + 8000, read({ eth0: [700, 5000] }), HERE);
  assert.deepEqual(day(tr, t), { rxB: 1500, txB: 150 });
  // an old driver's 32-bit counter wraps: a new count, never 4 GB made up
  const wrap = new Traffic();
  wrap.add(t, read({ eth0: [4294967000, 10] }), HERE);
  wrap.add(t + 2000, read({ eth0: [200, 20] }), HERE);
  assert.deepEqual(day(wrap, t), null, 'nothing measured yet: the first span was a reset');
  wrap.add(t + 4000, read({ eth0: [1200, 30] }), HERE);
  assert.deepEqual(day(wrap, t), { rxB: 1000, txB: 10 });
  // a reading back in time (the clock was set back) is a new count too
  const back = new Traffic();
  back.add(t, read({ eth0: [0, 0] }), HERE);
  back.add(t - 60000, read({ eth0: [1000, 1000] }), HERE);
  assert.deepEqual(back.summary(t), { today: null, week: null, month: null });
});

test('a jump faster than any link is dropped; the speed a link reports is no limit, nor is a long gap', () => {
  const t = at(10);
  // 400 Gbit/s is 100 GB in 2 s: 200 GB is a bogus number, never a day's
  const fast = new Traffic();
  fast.add(t, read({ eth0: [0, 0] }), HERE);
  fast.add(t + 2000, read({ eth0: [200e9, 0] }), HERE);
  assert.equal(day(fast, t), null);
  fast.add(t + 4000, read({ eth0: [200e9 + 64, 1] }), HERE);
  assert.deepEqual(day(fast, t), { rxB: 64, txB: 1 }, 'counted from the dropped reading on');
  assert.equal(MAX_BPS, 50e9);

  // a virtual machine's emulated NIC says 1 Gbit/s and carries 300 MB/s for a
  // minute, read every 2 s: every byte counts (the speed is not passed at all)
  const vm = new Traffic();
  vm.add(t, read({ eth0: [0, 0] }), HERE);
  for (let i = 1; i <= 30; i++) vm.add(t + i * 2000, read({ eth0: [i * 600 * MiB, 0] }), HERE);
  assert.deepEqual(day(vm, t), { rxB: 30 * 600 * MiB, txB: 0 });

  // a busy server nobody looked at for a week: 10.6 TB (140 Mbit/s on average) is all counted
  const week = new Traffic();
  const fri = new Date(2026, 5, 5, 9).getTime();
  week.add(fri, read({ enp3s0: [0, 0] }), HERE);
  week.add(fri + 7 * DAY, read({ enp3s0: [10.6e12, 1e12] }), HERE);
  assert.deepEqual(week.summary(fri + 7 * DAY).month, { rxB: 10.6e12, txB: 1e12 }, 'June 5 to 12');
  // ...but never more than a link could carry in that time
  const most = MAX_BPS * 7 * 86400 * 1.1;
  week.add(fri + 14 * DAY, read({ enp3s0: [10.6e12 + most * 1.01, 1e12] }), HERE);
  assert.deepEqual(week.summary(fri + 14 * DAY).month, { rxB: 10.6e12, txB: 1e12 });

  // NaN, negative and missing counters are no reading for that link
  const odd = new Traffic();
  odd.add(t, new Map([['a', { rx: NaN, tx: 1 }], ['b', { rx: -5, tx: 1 }], ['c', null], ['d', { rx: 1, tx: 1 }]]), HERE);
  odd.add(t + 2000, new Map([['a', { rx: 9, tx: 9 }], ['b', { rx: 9, tx: 9 }], ['c', { rx: 9, tx: 9 }], ['d', { rx: 2, tx: 2 }]]), HERE);
  assert.deepEqual(day(odd, t), { rxB: 1, txB: 1 }, 'only d had a reading to count from');
});

test('this container and the whole server (pid: host) keep their own days; the scope read last is shown', () => {
  const t = at(10);
  const HOST = { scope: 'host', boot: HERE.boot, netns: null };
  const tr = new Traffic();
  tr.add(t - H, read({ eth0: [0, 0] }), HERE);
  tr.add(t, read({ eth0: [5e9, 1e9] }), HERE);
  assert.deepEqual(day(tr, t), { rxB: 5e9, txB: 1e9 });
  // the owner adds pid: host: the server's NIC, with its own count from its first reading
  tr.add(t + 60000, read({ enp3s0: [9e11, 9e11] }), HOST);
  assert.equal(tr.summary(t + 60000).today, null, 'nothing of the server measured yet; never the container\'s bytes');
  tr.add(t + 62000, read({ enp3s0: [9e11 + 2e6, 9e11 + 1e6] }), HOST);
  assert.deepEqual(tr.summary(t + 62000), { today: { rxB: 2e6, txB: 1e6 }, week: { rxB: 2e6, txB: 1e6 }, month: { rxB: 2e6, txB: 1e6 } });

  // saved and loaded: both scopes, and which one is shown (with pid: host no
  // readings can be saved, so the scope is kept on its own)
  const json = JSON.parse(JSON.stringify(tr));
  assert.equal(json.scope, 'host');
  assert.equal(json.last, null);
  assert.deepEqual(json.days, { container: { [dayKey(t)]: { rx: 5e9, tx: 1e9 } }, host: { [dayKey(t)]: { rx: 2e6, tx: 1e6 } } });
  const again = new Traffic();
  again.load(json);
  assert.deepEqual(again.summary(t).today, { rxB: 2e6, txB: 1e6 });

  // and back to this container: its own days again, counted on from a new start
  again.add(t + 120000, read({ eth0: [100, 100] }), HERE);
  again.add(t + 122000, read({ eth0: [300, 200] }), HERE);
  assert.deepEqual(again.summary(t + 122000).today, { rxB: 5e9 + 200, txB: 1e9 + 100 });

  // a scope that is neither (a damaged file) is shown as this container
  const odd = new Traffic();
  odd.load({ scope: 'mars', days: { mars: { [dayKey(t)]: { rx: 1, tx: 1 } }, ['__proto__']: { [dayKey(t)]: { rx: 1, tx: 1 } } } });
  assert.deepEqual(JSON.parse(JSON.stringify(odd)), { scope: 'container', days: { container: {}, host: {} }, last: null });
  assert.equal(Object.prototype[dayKey(t)], undefined);
});

test('interfaces that come and go are counted each on its own', () => {
  const t = at(10);
  const tr = new Traffic();
  tr.add(t, read({ eth0: [0, 0] }), HERE);
  tr.add(t + 2000, read({ eth0: [100, 10] }), HERE);
  // the VPN comes up: its first reading only starts its count
  tr.add(t + 4000, read({ eth0: [200, 20], wg0: [7000, 7000] }), HERE);
  assert.deepEqual(day(tr, t), { rxB: 200, txB: 20 });
  tr.add(t + 6000, read({ eth0: [300, 30], wg0: [8000, 7500] }), HERE);
  assert.deepEqual(day(tr, t), { rxB: 300 + 1000, txB: 30 + 500 });
  // it goes away; eth0 carries on
  tr.add(t + 8000, read({ eth0: [400, 40] }), HERE);
  assert.deepEqual(day(tr, t), { rxB: 400 + 1000, txB: 40 + 500 });
  // and comes back, a new link (even with a bigger counter than before): a new count
  tr.add(t + 10000, read({ eth0: [500, 50], wg0: [9000, 9000] }), HERE);
  assert.deepEqual(day(tr, t), { rxB: 500 + 1000, txB: 50 + 500 });
  tr.add(t + 12000, read({ eth0: [600, 60], wg0: [9100, 9010] }), HERE);
  assert.deepEqual(day(tr, t), { rxB: 600 + 1100, txB: 60 + 510 });
  // another namespace (or scope, see below): every link starts again
  tr.add(t + 14000, read({ eth0: [700, 70], wg0: [9200, 9020] }), { ...HERE, netns: 'net:[4026532999]' });
  assert.deepEqual(day(tr, t), { rxB: 600 + 1100, txB: 60 + 510 });
  tr.add(t + 16000, read({ eth0: [800, 80], wg0: [9300, 9030] }), { ...HERE, netns: 'net:[4026532999]' });
  assert.deepEqual(day(tr, t), { rxB: 700 + 1200, txB: 70 + 520 });
});

test('saved and loaded: the days and the last readings come back, damaged entries do not', () => {
  const t = at(10);
  const tr = new Traffic();
  tr.add(t - DAY, read({ eth0: [0, 0], wg0: [0, 0] }), HERE, index({ eth0: 2, wg0: 9 }));
  tr.add(t, read({ eth0: [86400, 864], wg0: [5, 5] }), HERE, index({ eth0: 2, wg0: 9 }));
  const json = JSON.parse(JSON.stringify(tr));
  assert.deepEqual(json.last, { ...HERE, ifaces: { eth0: { rx: 86400, tx: 864, t, ifindex: 2 }, wg0: { rx: 5, tx: 5, t, ifindex: 9 } } });
  const again = new Traffic();
  again.load(json);
  assert.deepEqual(again.summary(t), tr.summary(t));
  assert.deepEqual(JSON.parse(JSON.stringify(again)), json, 'saved again before any reading: the same readings');

  // 62 days kept, like energy
  const many = new Traffic();
  const daysIn = {};
  for (let i = 0; i < 80; i++) daysIn[dayKey(t - i * DAY)] = { rx: i, tx: i };
  many.load({ days: { container: daysIn, host: daysIn } });
  assert.equal(Object.keys(many.toJSON().days.container).length, 62);
  assert.equal(Object.keys(many.toJSON().days.host).length, 62);
  assert.deepEqual(many.summary(t).today, { rxB: 0, txB: 0 });

  // garbage from a damaged or hand-edited file
  const bad = new Traffic();
  bad.load({
    days: { container: { bad: { rx: 1, tx: 1 }, '2026-06-10': { rx: -1, tx: 1 }, '2026-06-09': 'x', ['__proto__']: { rx: 1, tx: 1 }, '2026-06-08': { rx: 5, tx: 6 } }, host: 'x' },
    last: { ...HERE, ifaces: { 'a/b': { rx: 1, tx: 1, t, ifindex: 2 }, eth0: { rx: 1, tx: 1, t, ifindex: 0 }, wg0: { rx: 'x', tx: 1, t, ifindex: 3 }, ok0: { rx: 1, tx: 1, t, ifindex: 4 } } }
  });
  assert.deepEqual(Object.keys(bad.toJSON().days.container), ['2026-06-08']);
  assert.deepEqual(Object.keys(bad.toJSON().days.host), []);
  assert.deepEqual(Object.keys(bad.toJSON().last.ifaces), ['ok0']);
  assert.equal(Object.prototype.rx, undefined);
  for (const junk of [null, 'x', 5, [], { days: 'x', last: 'y' }, { days: { container: [1, 2] } }, { last: { boot: 1, netns: 'n', ifaces: {} } }]) {
    const j = new Traffic();
    assert.doesNotThrow(() => j.load(junk));
    assert.deepEqual(j.summary(t), { today: null, week: null, month: null });
  }

  // readings a restart could not check (no boot id or namespace) are not saved
  const blind = new Traffic();
  blind.add(t, read({ eth0: [1, 1] }), { scope: 'host', boot: null, netns: null }, index({ eth0: 2 }));
  assert.equal(blind.toJSON().last, null);
});

test('an app restart counts on from the saved readings only for the same boot, namespace and interface', () => {
  const t = at(10);
  const before = new Traffic();
  before.add(t - 4000, read({ eth0: [1000, 100], wg0: [50, 50] }), HERE, index({ eth0: 2, wg0: 9 }));
  before.add(t, read({ eth0: [3000, 300], wg0: [60, 60] }), HERE, index({ eth0: 2, wg0: 9 }));
  const file = JSON.parse(JSON.stringify(before));
  const restart = (where, ifindexes, ifs, ms = 30000) => {
    const tr = new Traffic();
    tr.load(file);
    tr.add(t + ms, read(ifs), where, index(ifindexes));
    return day(tr, t + ms);
  };
  const was = day(before, t);
  assert.deepEqual(was, { rxB: 2010, txB: 210 });
  // the app alone restarted, 30 s later: nothing lost
  assert.deepEqual(restart(HERE, { eth0: 2, wg0: 9 }, { eth0: [9000, 900], wg0: [70, 70] }), { rxB: 2010 + 6000 + 10, txB: 210 + 600 + 10 });
  // ...and a day later, split over the two days
  const later = new Traffic();
  later.load(file);
  later.add(t + DAY, read({ eth0: [3000 + 86400, 300] }), HERE, index({ eth0: 2 }));
  assert.deepEqual(day(later, t), { rxB: 2010 + 43200, txB: 210 });
  assert.deepEqual(day(later, t + DAY), { rxB: 43200, txB: 0 });
  // the VPN was made again (another index): a new count for it, eth0 counts on
  assert.deepEqual(restart(HERE, { eth0: 2, wg0: 11 }, { eth0: [9000, 900], wg0: [70, 70] }), { rxB: 2010 + 6000, txB: 210 + 600 });
  // the server rebooted, or the container restarted (another namespace): a new count
  assert.deepEqual(restart({ ...HERE, boot: 'another-boot' }, { eth0: 2, wg0: 9 }, { eth0: [9000, 900], wg0: [70, 70] }), was);
  assert.deepEqual(restart({ ...HERE, netns: 'net:[4026532999]' }, { eth0: 2, wg0: 9 }, { eth0: [9000, 900], wg0: [70, 70] }), was);
  // the counters are lower than saved: they started again, whatever the names say
  assert.deepEqual(restart(HERE, { eth0: 2, wg0: 9 }, { eth0: [2000, 900], wg0: [70, 70] }), { rxB: 2010 + 10, txB: 210 + 10 });
  // unknown boot, namespace or index: only a new count
  assert.deepEqual(restart({ ...HERE, boot: null }, { eth0: 2 }, { eth0: [9000, 900] }), was);
  assert.deepEqual(restart({ ...HERE, netns: null }, { eth0: 2 }, { eth0: [9000, 900] }), was);
  assert.deepEqual(restart(HERE, {}, { eth0: [9000, 900] }), was);
  // the saved readings stand in once: a link that shows up later starts its own count
  const once = new Traffic();
  once.load(file);
  once.add(t + 2000, read({ eth0: [3100, 310] }), HERE, index({ eth0: 2, wg0: 9 }));
  once.add(t + 4000, read({ eth0: [3200, 320], wg0: [80, 80] }), HERE, index({ eth0: 2, wg0: 9 }));
  assert.deepEqual(day(once, t + 4000), { rxB: 2010 + 200, txB: 210 + 20 });
});

// ---- the engine and GET /api/stats

test('GET /api/stats: the network block gains today, week and month; the rest is as it was', async () => {
  const s = setup(M.intelArc);
  try {
    const first = (s.stats.sampleNow(), s.stats.snapshot().network);
    assert.deepEqual(first, { scope: 'host', interfaces: [{ name: 'enp3s0', speedMbps: 2500, rxBps: null, txBps: null }], today: null, week: null, month: null });
    const snap = await s.run(2, 1);
    const used = { rxB: 2 * 2 * 112 * MiB, txB: 2 * 2 * 44 * MiB };
    assert.deepEqual(Object.keys(snap.network), ['scope', 'interfaces', 'today', 'week', 'month']);
    assert.deepEqual(snap.network, { scope: 'host', interfaces: [{ name: 'enp3s0', speedMbps: 2500, rxBps: 112 * MiB, txBps: 44 * MiB }], today: used, week: used, month: used });
    assert.deepEqual(s.stats.traffic(), { today: used, week: used, month: used });
    assert.deepEqual(snap.sparks.rxBps.slice(-1), [112 * MiB], 'the graphs are as they were');
  } finally {
    s.done();
  }
  // its own interfaces only (docker0, veth and lo are left out here too)
  const amd = setup(M.amd, { appPid: 8 });
  try {
    const snap = await amd.run(2);
    assert.equal(snap.network.scope, 'container');
    assert.deepEqual(snap.network.interfaces, [{ name: 'eth0', speedMbps: null, rxBps: 1000000, txBps: 100000 }]);
    assert.deepEqual(snap.network.today, { rxB: 4e6, txB: 4e5 });
  } finally {
    amd.done();
  }
  // nothing readable: null, never 0 made up
  const bare = setup(M.bare);
  try {
    const snap = await bare.run(3);
    assert.deepEqual(snap.network, { scope: 'container', interfaces: [], today: null, week: null, month: null });
    assert.deepEqual(bare.stats.snapshot().network.today, null);
  } finally {
    bare.done();
  }
  // before the first sample: the same keys
  const idle = setup(M.pi, { appPid: 20 });
  try {
    assert.deepEqual(idle.stats.snapshot().network, { scope: 'container', interfaces: [], today: null, week: null, month: null });
  } finally {
    idle.done();
  }
});

// amd's own eth0, with what identifies its counters
const known = (offset = 0, boot = HERE.boot) => (phase) => ({
  ...M.amd(phase + offset),
  'proc/sys/kernel/random/boot_id': `${boot}\n`,
  'proc/self/ns/net': { link: HERE.netns },
  'sys/class/net/eth0/ifindex': '17\n'
});

test('the engine saves the data used with the history; an app restart loses nothing', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-stats-data-'));
  const file = path.join(dataDir, 'stats-history.json');
  const clock = fakeClock();
  try {
    const first = setup(known(), { appPid: 8, clock, dataDir });
    await first.run(2);
    first.done();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.traffic.days, { container: { [dayKey(clock.t)]: { rx: 4e6, tx: 4e5 } }, host: {} });
    assert.equal(saved.traffic.scope, 'container');
    assert.deepEqual(saved.traffic.last, {
      scope: 'container', boot: HERE.boot, netns: HERE.netns, ifaces: { eth0: { rx: 1000 + 2 * 2e6, tx: 1000 + 2 * 2e5, t: clock.t, ifindex: 17 } }
    });
    assert.ok(saved.history && saved.energy, 'the same file, next to the graphs and energy');

    // the app restarts a minute later; eth0 moved on to phase 10 meanwhile
    clock.advance(60000);
    const again = setup(known(10), { appPid: 8, clock, dataDir });
    try {
      assert.deepEqual(again.stats.traffic().today, { rxB: 4e6, txB: 4e5 }, 'loaded back');
      again.stats.sampleNow();
      assert.deepEqual(again.stats.snapshot().network.today, { rxB: 20e6, txB: 2e6 }, 'counted on from the saved reading');
    } finally {
      again.done();
    }

    // the server rebooted meanwhile: the first reading only starts a new count
    clock.advance(60000);
    const rebooted = setup(known(20, 'b0a3c1d2-0000-4000-8000-000000000002'), { appPid: 8, clock, dataDir });
    try {
      rebooted.stats.sampleNow();
      assert.deepEqual(rebooted.stats.snapshot().network.today, { rxB: 20e6, txB: 2e6 });
      await rebooted.run(1, 1);
      assert.deepEqual(rebooted.stats.snapshot().network.today, { rxB: 22e6, txB: 2.2e6 });
    } finally {
      rebooted.done();
    }

    // no boot id or namespace to check (fixtures without them): never counted across a restart
    clock.advance(60000);
    const blind = setup((p) => M.amd(p + 40), { appPid: 8, clock, dataDir });
    try {
      blind.stats.sampleNow();
      assert.deepEqual(blind.stats.snapshot().network.today, { rxB: 22e6, txB: 2.2e6 });
    } finally {
      blind.done();
    }
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).traffic.last, null, 'nothing a restart could check');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('tick(): one reading a day with no page open, so each day holds its own bytes; no timer, no sampling', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-stats-tick-'));
  const file = path.join(dataDir, 'stats-history.json');
  const clock = fakeClock(new Date(2026, 9, 19, 9).getTime()); // Monday 09:00
  const set = (d, h, min = 0, sec = 0) => { clock.t = new Date(2026, 9, d, h, min, sec).getTime(); };
  const GB = 1024 ** 3;
  const timers = trackedTimers();
  const engine = () => setup(known(), { appPid: 8, clock, dataDir, timers });
  let s = engine();
  const eth0 = (rx, tx) => {
    s.m.file('proc/net/dev', M.netDev({ lo: [1, 1], eth0: [rx, tx] }));
    s.m.file('proc/1/net/dev', M.netDev({ lo: [1, 1], eth0: [rx, tx] }));
  };
  const days = () => JSON.parse(fs.readFileSync(file, 'utf8')).traffic.days.container;
  try {
    eth0(0, 0);
    s.stats.tick();
    assert.equal(s.stats.sampling, false);
    assert.equal(timers.live.size, 0, 'no timer, and nothing sampled');
    assert.equal(s.stats.snapshot().at, null);
    assert.deepEqual(s.stats.traffic(), { today: null, week: null, month: null }, 'the first reading starts the count');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).traffic.last.ifaces, { eth0: { rx: 0, tx: 0, t: clock.t, ifindex: 17 } }, 'and is saved');

    // 40 GB on Monday night; the calls during the day read nothing more
    set(19, 23, 59);
    eth0(40 * GB, GB);
    s.stats.tick();
    assert.equal(s.stats.traffic().today, null);
    // the housekeeping's call in the minute after each midnight reads them once
    for (const d of [20, 21, 22, 23]) {
      set(d, 0, 0, 30);
      s.stats.tick();
      set(d, 0, 1, 30);
      s.stats.tick();
    }
    assert.equal(timers.live.size, 0);
    // Friday 09:00: a page opens
    set(23, 9);
    s.stats.sampleNow();
    const monRx = Math.round(40 * GB * (15 * H) / (15 * H + 30000));
    const monTx = Math.round(GB * (15 * H) / (15 * H + 30000));
    assert.deepEqual(days(), {
      '2026-10-19': { rx: monRx, tx: monTx },
      '2026-10-20': { rx: 40 * GB - monRx, tx: GB - monTx }, // its first 30 s, a 1800th of the span
      '2026-10-21': { rx: 0, tx: 0 }, '2026-10-22': { rx: 0, tx: 0 }, '2026-10-23': { rx: 0, tx: 0 }
    }, 'read and saved at each midnight');
    const net = s.stats.snapshot().network;
    assert.deepEqual(net.today, { rxB: 0, txB: 0 }, 'nothing moved on Friday, and Friday says so');
    assert.deepEqual(net.week, { rxB: 40 * GB, txB: GB });

    // a sample read them today already: the next day's first call is the next reading
    set(23, 10);
    eth0(40 * GB + 5e6, GB);
    s.stats.tick();
    assert.deepEqual(s.stats.traffic().today, { rxB: 0, txB: 0 });
    s.stats.stop();
    // stopped: nothing more
    set(24, 0, 0, 30);
    s.stats.tick();
    assert.equal(days()['2026-10-24'], undefined);
    s.m.cleanup();

    // the app restarted (the same boot and namespace): its first call counts on from the saved reading
    s = engine();
    eth0(40 * GB + 8e6, GB + 1e6);
    set(24, 0, 0, 40);
    s.stats.tick();
    // from Friday's 09:00 sample: 15 h on Friday, 40 s on Saturday
    const share = (b) => b - Math.round(b * (15 * H) / (15 * H + 40000));
    assert.deepEqual(s.stats.traffic().today, { rxB: share(8e6), txB: share(1e6) });
    assert.deepEqual(days()['2026-10-23'], { rx: 8e6 - share(8e6), tx: 1e6 - share(1e6) });
    assert.equal(timers.live.size, 0);
  } finally {
    s.done();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the links counted: a VPN or tunnel only when no link that carries it is there', () => {
  const links = (spec, fn) => {
    const m = M.build(spec);
    try {
      let t = 0;
      const n = new NetworkProvider({ procRoot: m.proc, sysRoot: m.sys, now: () => t });
      n.probe();
      return fn(n, m, (ms) => { t += ms; });
    } finally {
      m.cleanup();
    }
  };
  const names = (n) => n.sample().interfaces.map((i) => i.name);
  // pid: host on a server with Tailscale, WireGuard, ZeroTier and PPPoE: only
  // the NIC (the tunnels' bytes cross it as well), for the rates and the data used
  links({
    'proc/net/dev': M.netDev({ lo: [1, 1], eth0: [1, 1] }),
    'proc/1/net/dev': M.netDev({ lo: [1, 1], enp3s0: [1e9, 1e9], tailscale0: [5e8, 5e8], wg0: [1e8, 1e8], zt5u4y6abc: [1, 1], ppp0: [1, 1], docker0: [1, 1] })
  }, (n) => {
    assert.equal(n.scope, 'host');
    assert.deepEqual(names(n), ['enp3s0']);
    assert.deepEqual([...n.counters.keys()], ['enp3s0']);
  });
  // its own links (network_mode: host, or a VPN container's network): sysfs
  // tells a WireGuard or tun link by any name
  const own = M.netDev({ lo: [1, 1], eth0: [1, 1], mullvad: [1, 1], office: [1, 1] });
  links({
    'proc/net/dev': own, 'proc/1/net/dev': own,
    'sys/class/net/eth0/type': '1\n', 'sys/class/net/mullvad/type': '65534\n', 'sys/class/net/office/type': '1\n', 'sys/class/net/office/tun_flags': '0x1002\n'
  }, (n) => assert.deepEqual(names(n), ['eth0']));
  // a modem's ppp0 is the only way out: counted
  const modem = M.netDev({ lo: [1, 1], ppp0: [5, 5] });
  links({ 'proc/net/dev': modem, 'proc/1/net/dev': modem }, (n) => assert.deepEqual(names(n), ['ppp0']));

  // the daily reading counts the same links and leaves the live rates alone
  const dev = (rx) => M.netDev({ lo: [1, 1], eth0: [rx, 0], wg0: [rx, 0] });
  links({ 'proc/net/dev': dev(0), 'proc/1/net/dev': dev(0) }, (n, m, advance) => {
    n.sample();
    advance(1000);
    m.file('proc/net/dev', dev(5000));
    n.read();
    assert.deepEqual([...n.counters], [['eth0', { rx: 5000, tx: 0 }]]);
    assert.equal(n.readAt, 1000);
    advance(1000);
    m.file('proc/net/dev', dev(8000));
    assert.deepEqual(n.sample().interfaces, [{ name: 'eth0', speedMbps: null, rxBps: 4000, txBps: 0 }], 'over the 2 s since the last sample');
    // nothing readable: no counters, the last reading's time is kept
    m.remove('proc/net/dev');
    n.read();
    assert.equal(n.counters, null);
    assert.equal(n.readAt, 2000);
  });
});

// ---- the Network tile (web/app.js's drawing block, as test/screens.test.js runs it)

function serverBody() {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const start = app.indexOf('// ---- server monitor: drawing');
  const end = app.indexOf('// ---- server monitor: end of drawing ----');
  const helpers = ['esc', 'plural'].map((name) => app.match(new RegExp(`\\n  const ${name} = .*;\\n`))[0]).join('');
  return new Function(`${helpers}${app.slice(start, end)}\n    return serverBody;`)();
}

test('the Network tile shows today, this week and this month under the live rows, always in place', () => {
  const draw = serverBody();
  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'statsSample.json'), 'utf8'));
  const tile = (network) => {
    const html = draw({ ...sample, network: { ...sample.network, ...network } });
    const i = html.indexOf('<span>Network</span>');
    return html.slice(i, html.indexOf('<div class="nd-tile', i));
  };
  const rows = (html) => [...html.matchAll(/<dt>([^<]+)<\/dt><dd>([^<]+)<\/dd>/g)].map((m) => [m[1], m[2].replace(/\u00a0/g, ' ')]);
  const GB = 1024 ** 3;
  const used = tile({ today: { rxB: 12.4 * GB, txB: 1.1 * GB }, week: { rxB: 61 * GB, txB: 7.25 * GB }, month: { rxB: 1.5 * 1024 * GB, txB: 512 * MiB } });
  assert.deepEqual(rows(used).slice(-4), [
    ['Counted for', 'this container'],
    ['Today', '↓ 12.4 GB · ↑ 1.1 GB'],
    ['This week', '↓ 61 GB · ↑ 7.3 GB'],
    ['This month', '↓ 1.5 TB · ↑ 512 MB']
  ]);
  // nothing used yet, or not measured yet: the same rows, so the tile keeps its height
  const zero = tile({ today: { rxB: 0, txB: 0 }, week: { rxB: 0, txB: 0 }, month: { rxB: 0, txB: 0 } });
  assert.deepEqual(rows(zero).slice(-3).map((r) => r[1]), ['↓ 0 B · ↑ 0 B', '↓ 0 B · ↑ 0 B', '↓ 0 B · ↑ 0 B']);
  for (const html of [tile({ today: null, week: null, month: null }), tile({})]) {
    assert.deepEqual(rows(html).slice(-3), [['Today', '↓ — · ↑ —'], ['This week', '↓ — · ↑ —'], ['This month', '↓ — · ↑ —']]);
    assert.doesNotMatch(html, /NaN|undefined|null/);
  }
  assert.equal(rows(zero).length, rows(used).length);
  assert.ok(used.includes('↓\u00a012.4\u00a0GB · ↑\u00a01.1\u00a0GB'), 'a narrow tile wraps at the dot only');
  // one interface: one list; two or more: theirs, then the totals in a list of
  // their own, so a long interface name never narrows (and wraps) their values
  const lists = (html) => [...html.matchAll(/<dl class="nd-kv">(.*?)<\/dl>/g)].map((m) => rows(m[1]).map((r) => r[0]));
  assert.deepEqual(lists(used), [['Counted for', 'Today', 'This week', 'This month']]);
  const two = tile({ interfaces: [{ name: 'eth0', speedMbps: null, rxBps: 4096, txBps: 4096 }, { name: 'enp3s0', speedMbps: 2500, rxBps: 4096, txBps: 4096 }], today: null });
  assert.deepEqual(lists(two), [['eth0', 'enp3s0 · 2.5 Gbit/s'], ['Counted for', 'Today', 'This week', 'This month']]);
});
