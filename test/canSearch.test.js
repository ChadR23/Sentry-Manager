'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createCanSearch, footageAt, clipStamps, localKey, parseWhen } = require('../server/canSearch');

const T0 = Date.UTC(2026, 9, 1, 12, 0); // 2026-10-01 12:00 UTC
const MIN = 60_000;
const name = (t) => `${new Date(t).toISOString().slice(0, 16).replace(/[-:]/g, '')}.json.gz`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-search-'));
  const put = (key, t, signals, ids = {}) => {
    fs.mkdirSync(path.join(dir, key), { recursive: true });
    fs.writeFileSync(path.join(dir, key, name(t)), zlib.gzipSync(JSON.stringify({ minute: name(t).slice(0, 13), signals, ids })));
  };
  return { dir, put, search: createCanSearch({ dir }), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('signal search: first match oldest first, episodes, counts and ops', async () => {
  const s = setup();
  try {
    // speed per minute: 10, 30, 50 (at 20 s), 60, 20, 45
    const speeds = [[[0, 10]], [[0, 30]], [[0, 35], [20_000, 50]], [[0, 60]], [[0, 20]], [[0, 45]]];
    speeds.forEach((pts, i) => s.put('car', T0 + i * MIN, { Speed: pts, Gear: [[0, i < 3 ? 1 : 4]] }, { 'can0:257': 10 }));
    fs.writeFileSync(path.join(s.dir, 'car', 'signals.json'), JSON.stringify({ Gear: { unit: '', values: { 1: 'PARK', 4: 'DRIVE' } }, Speed: { unit: 'kph' } }));

    let r = await s.search.signal(['car'], { signal: 'Speed', op: '>', value: '40', all: true });
    assert.equal(r.first.at, T0 + 2 * MIN + 20_000, 'the first point over 40');
    assert.equal(r.first.value, 50);
    assert.deepEqual(r.matches.map((m) => m.at), [T0 + 2 * MIN + 20_000, T0 + 5 * MIN], 'one per episode (50→60 is one, 45 is the next)');
    assert.equal(r.matchingMinutes, 3);
    assert.equal(r.complete, true);
    assert.equal(r.unit, 'kph');

    r = await s.search.signal(['car'], { signal: 'Speed', op: '>', value: 40, limit: 1 });
    assert.equal(r.matches.length, 1);
    assert.equal(r.scannedMinutes, 3, 'stops once it has the first');
    assert.equal(r.complete, false);

    assert.equal((await s.search.signal(['car'], { signal: 'Speed', op: '<=', value: 20 })).matches.map((m) => m.value).join(), '10,20');
    assert.equal((await s.search.signal(['car'], { signal: 'Speed', op: '=', value: 60 })).first.at, T0 + 3 * MIN);
    assert.equal((await s.search.signal(['car'], { signal: 'Speed', op: '!=', value: 10 })).first.at, T0 + MIN);
    assert.equal((await s.search.signal(['car'], { signal: 'Speed', op: '<', value: 0 })).first, null);
    assert.equal((await s.search.signal(['car'], { signal: 'Speed', op: '>=', value: 60 })).first.value, 60);

    // a value name from the DBC
    r = await s.search.signal(['car'], { signal: 'Gear', op: '=', value: 'drive' });
    assert.equal(r.first.at, T0 + 3 * MIN);
    assert.equal(r.first.text, 'DRIVE');
    await assert.rejects(s.search.signal(['car'], { signal: 'Gear', op: '=', value: 'warp' }), /not a value/);
    await assert.rejects(s.search.signal(['car'], { signal: 'Gear', op: '~', value: 1 }), /condition/);

    // changed: every change, with what it was
    r = await s.search.signal(['car'], { signal: 'Gear', op: 'changed', all: true });
    assert.equal(r.matches.length, 1);
    assert.deepEqual([r.first.at, r.first.previous, r.first.value, r.first.previousText], [T0 + 3 * MIN, 1, 4, 'PARK']);

    // a time window
    r = await s.search.signal(['car'], { signal: 'Speed', op: '>', value: 40, from: T0 + 4 * MIN });
    assert.equal(r.first.at, T0 + 5 * MIN);
    r = await s.search.signal(['car'], { signal: 'Speed', op: '>', value: 40, to: T0 + 2 * MIN + 10_000 });
    assert.equal(r.first, null);
  } finally { s.done(); }
});

test('signal search: appeared, gaps, two keys of one car, out of time', async () => {
  const s = setup();
  try {
    s.put('a', T0, { Other: [[0, 1]] });
    s.put('a', T0 + MIN, { Other: [[0, 1]] });
    s.put('b', T0 + MIN, { Fault: [[30_000, 1]] });
    s.put('a', T0 + 2 * MIN, { Fault: [[0, 1]] });
    s.put('a', T0 + 10 * MIN, { Fault: [[5_000, 1]] }); // after the car slept: a new episode
    let r = await s.search.signal(['a', 'b'], { signal: 'Fault', op: 'appeared' });
    assert.equal(r.first.at, T0 + MIN + 30_000, 'the first data of the signal, from either key');
    assert.deepEqual(r.matches.map((m) => m.at), [T0 + MIN + 30_000, T0 + 10 * MIN + 5_000]);
    r = await s.search.signal(['a', 'b'], { signal: 'Fault', op: '=', value: 1, all: true });
    assert.equal(r.matchingMinutes, 3);
    assert.equal(r.minutesWithData, 3);
    assert.equal(r.totalMinutes, 4);
    // a scan out of time says where to go on
    let clock = 0;
    const slow = createCanSearch({ dir: s.dir, now: () => (clock += 1000) });
    r = await slow.signal(['a'], { signal: 'Fault', op: 'appeared', budgetMs: 2500 });
    assert.equal(r.complete, false);
    assert.equal(r.resumeFrom, T0 + 2 * MIN, 'two minutes read in the time given');
    assert.equal(r.scannedMinutes, 2);
  } finally { s.done(); }
});

test('id events: appeared after a date, after the first hour, and stopped while awake', async () => {
  const s = setup();
  try {
    // 100 awake minutes: 2E5 every minute but stops for 15 at 40..54, 3C2 only from minute 70,
    // 1F9 now and then (not regular), 102 always
    for (let i = 0; i < 100; i++) {
      const ids = { 'can0:102': 50 };
      if (i < 40 || i >= 55) ids['can0:2E5'] = 10;
      if (i >= 70) ids['can1:3C2'] = 5;
      if (i % 7 === 0) ids['can0:1F9'] = 1;
      s.put('car', T0 + i * MIN, {}, ids);
    }
    let r = await s.search.ids(['car'], { gap: 10 });
    assert.equal(r.awakeMinutes, 100);
    assert.equal(r.idCount, 4);
    assert.deepEqual(r.appeared.map((x) => [x.id, x.at]), [['can1:3C2', T0 + 70 * MIN]], 'new after the first hour of data');
    assert.equal(r.stopped.length, 1);
    assert.deepEqual([r.stopped[0].id, r.stopped[0].at, r.stopped[0].back, r.stopped[0].missingMinutes], ['can0:2E5', T0 + 40 * MIN, T0 + 55 * MIN, 15]);
    assert.equal(r.stopped[0].lastSeen, T0 + 39 * MIN + 59_999);

    r = await s.search.ids(['car'], { gap: 20 });
    assert.equal(r.stopped.length, 0, 'a gap shorter than asked is no stop');

    // never seen before a date (as after a software update)
    r = await s.search.ids(['car'], { before: T0 + 60 * MIN, from: T0 + 90 * MIN });
    assert.deepEqual(r.appeared.map((x) => x.id), ['can1:3C2'], 'reads from the start, whatever from says');
    r = await s.search.ids(['car'], { before: T0 + 80 * MIN });
    assert.deepEqual(r.appeared, []);

    // one id, any bus
    r = await s.search.ids(['car'], { id: '0x3c2', before: T0 });
    assert.deepEqual(r.ids, [{ id: 'can1:3C2', first: T0 + 70 * MIN, last: T0 + 99 * MIN + 59_999, seenMinutes: 30 }]);

    // still missing at the end of the data
    for (let i = 100; i < 115; i++) s.put('car', T0 + i * MIN, {}, { 'can0:102': 50, 'can0:2E5': 1 });
    for (let i = 115; i < 130; i++) s.put('car', T0 + i * MIN, {}, { 'can0:102': 50 });
    r = await s.search.ids(['car'], { gap: 10 });
    const last = r.stopped.filter((x) => x.id === 'can0:2E5').pop();
    assert.deepEqual([last.at, last.back, last.missingMinutes], [T0 + 115 * MIN, null, 15]);
    assert.ok(r.stopped.some((x) => x.id === 'can1:3C2' && x.at === T0 + 100 * MIN && x.back === null), 'and 3C2, gone since minute 100');
  } finally { s.done(); }
});

test('footage at a moment: the clip in the car\'s time zone, and the second in it', () => {
  const recs = [{ clipRels: ['RecentClips/2026-10-01_14-00-00-front.mp4', 'RecentClips/2026-10-01_14-00-00-back.mp4', 'RecentClips/2026-10-01_14-01-00-front.mp4'] },
    { clipRels: ['SentryClips/2026-10-01_14-30-00/2026-10-01_14-29-05-front.mp4'] }];
  const stamps = clipStamps(recs);
  assert.deepEqual(stamps, ['2026-10-01_14-00-00', '2026-10-01_14-01-00', '2026-10-01_14-29-05']);
  const tz = 'Europe/Amsterdam'; // UTC+2 in October
  assert.equal(localKey(T0, tz), '2026-10-01_14-00-00');
  assert.deepEqual(footageAt(stamps, T0 + 75_000, tz), { at: T0 + 75_000, localTime: '2026-10-01 14:01:15', day: '2026-10-01', clip: '2026-10-01_14-01-00', second: 15 });
  assert.equal(footageAt(stamps, T0 + 5 * MIN, tz), null, 'no clip then');
  assert.equal(footageAt(stamps, T0 + 29 * MIN + 30_000, tz).second, 25);
  assert.equal(footageAt(stamps, T0 - 1000, tz), null);
  assert.equal(footageAt([], T0, tz), null);
});

test('times in a query: ms, ISO with a zone, the car\'s wall clock, a day\'s end', () => {
  const toUtc = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s) - 2 * 3600_000; // a car at UTC+2
  assert.equal(parseWhen(String(T0), toUtc), T0);
  assert.equal(parseWhen('2026-10-01T12:00:00Z', toUtc), T0);
  assert.equal(parseWhen('2026-10-01T14:00', toUtc), T0);
  assert.equal(parseWhen('2026-10-01', toUtc), Date.UTC(2026, 8, 30, 22));
  assert.equal(parseWhen('2026-10-01', toUtc, true), Date.UTC(2026, 9, 1, 22) - 1);
  assert.equal(parseWhen('', toUtc), null);
  assert.equal(parseWhen('soon', toUtc), null);
});
