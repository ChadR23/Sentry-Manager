'use strict';

// Space saved per vehicle: a job counts once however often its snapshot
// comes in, totals stay after the job is gone, and go with the vehicle.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSavings } = require('../server/savings');

const memoryDb = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)) };
};

test('space saved: each job adds only what it adds since its last snapshot', () => {
  const db = memoryDb();
  const s = createSavings({ db });
  s.record('j1', 'car', { bytes: 100, clips: 1 });
  s.record('j1', 'car', { bytes: 100, clips: 1 });
  s.record('j1', 'car', { bytes: 250, clips: 3 });
  s.record('j2', 'car', { bytes: 50, clips: 1 });
  s.record('j3', 'other', { bytes: 7, clips: 1 });
  assert.deepEqual(s.forVehicle('car'), { bytes: 300, clips: 4 });
  assert.deepEqual(s.forVehicle('other'), { bytes: 7, clips: 1 });
  assert.deepEqual(s.forVehicle('none'), { bytes: 0, clips: 0 });
  // a fresh instance (a restart) reads the same totals and does not recount
  const again = createSavings({ db });
  again.record('j1', 'car', { bytes: 250, clips: 3 });
  assert.deepEqual(again.forVehicle('car'), { bytes: 300, clips: 4 });
  // nonsense never lowers a total
  again.record('j1', 'car', { bytes: -5, clips: NaN });
  assert.deepEqual(again.forVehicle('car'), { bytes: 300, clips: 4 });
  again.forget('car');
  assert.deepEqual(again.forVehicle('car'), { bytes: 0, clips: 0 });
  assert.deepEqual(again.forVehicle('other'), { bytes: 7, clips: 1 });
});

test('space saved: a reset starts one vehicle over, and a running job adds only what it saves next', () => {
  const s = createSavings({ db: memoryDb() });
  s.record('j1', 'car', { bytes: 400, clips: 4 });
  s.record('j2', 'other', { bytes: 9, clips: 1 });
  assert.equal(s.reset('car'), true);
  assert.deepEqual(s.forVehicle('car'), { bytes: 0, clips: 0 });
  assert.deepEqual(s.forVehicle('other'), { bytes: 9, clips: 1 }, 'other vehicles keep theirs');
  // the same job's next snapshot does not bring the old total back
  s.record('j1', 'car', { bytes: 400, clips: 4 });
  assert.deepEqual(s.forVehicle('car'), { bytes: 0, clips: 0 });
  s.record('j1', 'car', { bytes: 450, clips: 5 });
  assert.deepEqual(s.forVehicle('car'), { bytes: 50, clips: 1 });
  assert.equal(s.reset('none'), false);
});
