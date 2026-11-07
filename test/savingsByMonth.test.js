'use strict';

// Savings by month (server/savings.js): what each job adds goes to the month
// it is added in; totals from before months were kept go to the month their
// job finished, once.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSavings } = require('../server/savings');

function memDb(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) };
}

test('savings by month: backfilled once from the job history, then added as jobs go', () => {
  const GB = 1024 ** 3;
  // two jobs counted before months were kept
  const db = memDb({ savings: { vehicles: { car: { bytes: 5 * GB, clips: 50 } }, jobs: { j1: { vehicleId: 'car', bytes: 3 * GB, clips: 30 }, j2: { vehicleId: 'car', bytes: 2 * GB, clips: 20 } } } });
  const s = createSavings({ db });
  const thisMonth = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
  const lastMonth = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
  assert.equal(s.backfill((id) => (id === 'j1' ? lastMonth : null)), true);
  assert.equal(s.backfill(() => lastMonth), false, 'only once');
  let months = s.byMonth('car', 12);
  assert.equal(months.length, 12);
  assert.equal(months[11].month, thisMonth);
  assert.deepEqual(months.at(-2), { month: lastMonth, bytes: 3 * GB, clips: 30 });
  assert.deepEqual(months.at(-1), { month: thisMonth, bytes: 2 * GB, clips: 20 }, 'a job without a known end: this month');
  // a running job adds what it saves since its last report
  s.record('j3', 'car', { bytes: 1 * GB, clips: 5 });
  s.record('j3', 'car', { bytes: 1.5 * GB, clips: 8 });
  months = s.byMonth('car', 12);
  assert.deepEqual(months.at(-1), { month: thisMonth, bytes: 3.5 * GB, clips: 28 });
  assert.equal(s.forVehicle('car').bytes, 6.5 * GB, 'the total still matches');
  // starting over clears the months too
  s.reset('car');
  assert.equal(s.byMonth('car', 12).every((m) => m.bytes === 0), true);
});
