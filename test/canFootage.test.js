'use strict';

// The green "CAN" tag on the Footage page (server/canFootage.js): a recording
// has CAN Bridge data when an indexed minute of one of its car's CAN keys
// overlaps its clips; the clip names are read in the car's time zone; the
// minutes are kept until the index, the car's keys or its zone change.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanFootage, minuteIn, clipRange } = require('../server/canFootage');

/** A clip name's start in UTC in a zone (as server/index.js does it). */
function startOf(v, name) {
  const m = /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const offsetAt = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: v.timezone || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  };
  return guess - offsetAt(guess - offsetAt(guess));
}

const rec = (...stamps) => ({ id: stamps[0], startKey: stamps[0], clipRels: stamps.flatMap((s) => [`RecentClips/${s}-front.mp4`, `RecentClips/${s}-back.mp4`]) });

function harness() {
  const st = {
    gen: 1, map: {}, single: false, keys: ['A-car', 'B-car'],
    minutes: { 'A-car': [], 'B-car': [] }, reads: 0
  };
  const footage = createCanFootage({
    keysFor: async (vid) => st.keys.filter((k) => st.map[k] === vid || (!st.map[k] && st.single)),
    minuteTimes: async (key) => { st.reads++; return [...(st.minutes[key] || [])]; },
    generation: () => st.gen,
    startOf
  });
  return { st, footage };
}

test('minuteIn and clipRange', () => {
  const m = [Date.UTC(2026, 10, 8, 15, 0)];
  assert.equal(minuteIn(m, m[0] - 62_000, m[0]), false, 'a clip ending where the minute starts');
  assert.equal(minuteIn(m, m[0] - 62_000, m[0] + 1), true);
  assert.equal(minuteIn(m, m[0] + 59_999, m[0] + 70_000), true);
  assert.equal(minuteIn(m, m[0] + 60_000, m[0] + 120_000), false, 'a clip starting where the minute ends');
  assert.equal(minuteIn([], 0, 1e15), false);
  assert.deepEqual(clipRange(rec('2026-11-08_10-03-00', '2026-11-08_10-01-00', '2026-11-08_10-02-00')), { first: '2026-11-08_10-01-00', last: '2026-11-08_10-03-00' });
  assert.equal(clipRange({ clipRels: [] }), null);
  assert.deepEqual(clipRange({ startKey: '2026-11-08_10-00-00', clipRels: [] }), { first: '2026-11-08_10-00-00', last: '2026-11-08_10-00-00' });
});

test('a recording overlapped by an indexed minute of a key mapped to its car has CAN data; other cars, unmapped keys and no data do not', async () => {
  const { st, footage } = harness();
  const car = { id: 'car1', timezone: 'UTC' };
  const other = { id: 'car2', timezone: 'UTC' };
  const r = rec('2026-11-08_15-00-00', '2026-11-08_15-01-00', '2026-11-08_15-02-00');
  // no CAN data at all
  assert.equal((await footage.forVehicle(car))(r), false);
  // data of a key that is not mapped (two cars: the Viewer shows it for none)
  st.minutes['A-car'] = [Date.UTC(2026, 10, 8, 15, 1)];
  st.gen++;
  assert.equal((await footage.forVehicle(car))(r), false, 'unmapped key');
  // mapped to the other car
  st.map['A-car'] = 'car2';
  assert.equal((await footage.forVehicle(car))(r), false, 'another car\'s key');
  assert.equal((await footage.forVehicle(other))(r), true, 'that car has it');
  // mapped to this car
  st.map['A-car'] = 'car1';
  const has = await footage.forVehicle(car);
  assert.equal(has(r), true);
  // only recordings whose clips overlap a minute
  assert.equal(has(rec('2026-11-08_15-05-00', '2026-11-08_15-06-00')), false, 'later footage');
  assert.equal(has(rec('2026-11-08_14-58-00', '2026-11-08_14-59-00')), false, 'a recording that ends just before the minute (14:59:00 + 62 s < 15:01)');
  assert.equal(has(rec('2026-11-08_15-00-30')), true, 'a clip running into the minute');
  assert.equal(has(rec('2026-11-08_14-59-30')), false, 'one that ends before it');
  assert.equal(has(rec('2026-11-08_15-01-59')), true);
  assert.equal(has(rec('2026-11-08_15-02-00')), false, 'a clip from the minute\'s end on');
  // a long recording whose middle has the data
  assert.equal(has(rec('2026-11-08_14-30-00', '2026-11-08_15-30-00')), true);
  // one car: a key not mapped at all is that car's (as the Viewer reads it)
  delete st.map['A-car'];
  st.single = true;
  assert.equal((await footage.forVehicle(car))(r), true, 'one car: an unmapped key is its own');
});

test('the clip names are read in the car\'s time zone', async () => {
  const { st, footage } = harness();
  st.map['A-car'] = 'car1';
  // 15:01 UTC is 10:01 in New York (EST, after the clocks went back on 2026-11-01) and 16:01 in Berlin
  st.minutes['A-car'] = [Date.UTC(2026, 10, 8, 15, 1)];
  const ny = { id: 'car1', timezone: 'America/New_York' };
  assert.equal((await footage.forVehicle(ny))(rec('2026-11-08_10-01-00')), true);
  assert.equal((await footage.forVehicle(ny))(rec('2026-11-08_15-01-00')), false, 'the UTC name is not the car\'s time');
  const berlin = { id: 'car1', timezone: 'Europe/Berlin' };
  assert.equal((await footage.forVehicle(berlin))(rec('2026-11-08_16-01-00')), true, 'the zone changed: read again');
  assert.equal((await footage.forVehicle(berlin))(rec('2026-11-08_10-01-00')), false);
  // a summer clip in New York (EDT, UTC-4)
  st.minutes['A-car'] = [Date.UTC(2026, 6, 4, 14, 0)];
  st.gen++;
  assert.equal((await footage.forVehicle(ny))(rec('2026-07-04_10-00-00')), true);
});

test('the minutes are read once per index generation and per car keys; a change is seen at once', async () => {
  const { st, footage } = harness();
  const car = { id: 'car1', timezone: 'UTC' };
  st.map['A-car'] = 'car1';
  st.minutes['A-car'] = [Date.UTC(2026, 10, 8, 15, 0)];
  const r = rec('2026-11-08_15-00-00');
  const later = rec('2026-11-08_16-00-00');
  assert.equal((await footage.forVehicle(car))(r), true);
  const reads = st.reads;
  for (let i = 0; i < 5; i++) assert.equal((await footage.forVehicle(car))(r), true);
  assert.equal(st.reads, reads, 'kept while nothing changed');
  // a new upload indexed (the generation moves)
  st.minutes['A-car'].push(Date.UTC(2026, 10, 8, 16, 0));
  assert.equal((await footage.forVehicle(car))(later), false, 'not seen before the index says it changed');
  st.gen++;
  assert.equal((await footage.forVehicle(car))(later), true, 'a new upload');
  // a log deleted (its minutes leave the index)
  st.minutes['A-car'] = [Date.UTC(2026, 10, 8, 16, 0)];
  st.gen++;
  assert.equal((await footage.forVehicle(car))(r), false, 'a delete');
  assert.equal((await footage.forVehicle(car))(later), true);
  // the mapping changed (no index change): another key's minutes join
  st.minutes['B-car'] = [Date.UTC(2026, 10, 8, 15, 0)];
  assert.equal((await footage.forVehicle(car))(r), false);
  st.map['B-car'] = 'car1';
  assert.equal((await footage.forVehicle(car))(r), true, 'a key mapped to the car');
  st.map['A-car'] = 'car2';
  assert.equal((await footage.forVehicle(car))(later), false, 'a key mapped away');
});
