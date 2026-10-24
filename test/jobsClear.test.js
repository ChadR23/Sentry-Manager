'use strict';

// Jobs > Clear jobs, in the store (server/db.js, server/activity.js): the
// finished jobs of the vehicle shown (and those of no vehicle) leave the
// list; running ones, and conversions the converter still has going, stay.
// A cleared conversion does not come back from a later word about the same
// finished job, only when it runs again. Jobs a restart stopped are
// interrupted instead of running forever.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ManagerDB } = require('../server/db');
const { Jobs } = require('../server/activity');

function fixture() {
  const db = new ManagerDB(':memory:');
  const jobs = new Jobs({ db });
  const make = (type, vehicleId, status, externalId = null) => {
    const id = jobs.start({ type, vehicleId, title: `${type} ${status}`, externalId });
    if (status !== 'running') jobs.finish(id, { status, detail: status });
    return id;
  };
  const ids = {
    scanning: make('scan', 'car', 'running'),
    scanned: make('scan', 'car', 'done'),
    trashFailed: make('trash', 'car', 'failed'),
    convCancelled: make('conversion', 'car', 'cancelled', 'converter:c1'),
    van: make('scan', 'van', 'done'),
    noVehicle: make('restore', null, 'done'),
    convPaused: make('conversion', 'car', 'running', 'converter:c2'),
    // its row says failed, but the converter runs it again (Retry failed)
    convRetried: make('conversion', 'car', 'failed', 'converter:c3')
  };
  const listed = (opts) => jobs.list(opts).map((j) => j.id).sort((a, b) => a - b);
  return { db, jobs, ids, listed };
}

test('Clear jobs: the finished jobs of the vehicle (and of no vehicle) leave the list, the rest stay', () => {
  const { db, jobs, ids, listed } = fixture();
  let changed = 0;
  jobs.on('changed', () => changed++);
  const opts = { vehicleId: 'car', keepExternal: ['converter:c2', 'converter:c3'] };
  assert.equal(jobs.finished(opts), 4, 'done, failed, cancelled of the car and the job of no vehicle');
  assert.equal(changed, 0, 'counting changes nothing');
  assert.equal(jobs.clear(opts), 4);
  assert.equal(changed, 1, 'announced once, so other open pages update');
  assert.deepEqual(listed({ vehicleId: 'car' }), [ids.scanning, ids.convPaused, ids.convRetried].sort((a, b) => a - b));
  assert.deepEqual(listed(), [ids.scanning, ids.van, ids.convPaused, ids.convRetried].sort((a, b) => a - b), 'another vehicle keeps its jobs');
  assert.ok(jobs.list().every((j) => j.status === 'running' || j.id === ids.van || j.id === ids.convRetried));
  // nothing left to clear: no announcement
  assert.equal(jobs.clear(opts), 0);
  assert.equal(changed, 1);
  // every vehicle: the van's job too, and the retried conversion once it is not going any more
  assert.equal(jobs.clear(), 2);
  assert.deepEqual(listed(), [ids.scanning, ids.convPaused].sort((a, b) => a - b));
  db.close();
});

test('Clear jobs: a cleared conversion is remembered until it runs again', () => {
  const { db, jobs } = fixture();
  jobs.clear({ vehicleId: 'car', keepExternal: ['converter:c2'] });
  assert.equal(db.jobByExternal('converter:c1'), null, 'the row is gone');
  assert.equal(db.jobCleared('converter:c1'), true, 'and remembered as cleared');
  assert.equal(db.jobCleared('converter:c2'), false, 'a paused conversion is not cleared');
  assert.equal(db.jobCleared('nope'), false);
  // it runs again (Retry failed): a new row, and it is no longer cleared
  const again = jobs.start({ type: 'conversion', vehicleId: 'car', title: 'Convert again', externalId: 'converter:c1' });
  assert.equal(db.jobByExternal('converter:c1').id, again);
  assert.equal(db.jobByExternal('converter:c1').status, 'running');
  assert.equal(db.jobCleared('converter:c1'), false);
  assert.equal(jobs.list({ vehicleId: 'car' })[0].id, again, 'on top of the list, as the newest job');
  db.close();
});

test('Clear jobs: only so many cleared conversions are remembered, the newest', async () => {
  const db = new ManagerDB(':memory:');
  const jobs = new Jobs({ db });
  const batch = (from, n) => {
    for (let i = from; i < from + n; i++) jobs.finish(jobs.start({ type: 'conversion', vehicleId: 'car', title: 'c', externalId: `converter:x${i}` }), { status: 'done' });
    return jobs.clear();
  };
  assert.equal(batch(0, 1500), 1500);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(batch(1500, 600), 600);
  const kept = Number(db.db.prepare('SELECT COUNT(*) AS n FROM jobs_cleared').get().n);
  assert.equal(kept, 2000);
  assert.equal(db.jobCleared('converter:x2099'), true);
  assert.equal(db.jobCleared('converter:x0'), false, 'the oldest are forgotten');
  db.close();
});

test('jobs a restart stopped are interrupted; conversions stay with the converter', () => {
  const { db, jobs, ids } = fixture();
  jobs.update(ids.scanning, { detail: '120 of 300 folders' });
  const idle = jobs.start({ type: 'empty-bin', vehicleId: 'car', title: 'Empty the Recycle Bin' });
  let changed = 0;
  jobs.on('changed', () => changed++);
  assert.equal(jobs.interruptLeftovers(), 2);
  assert.equal(changed, 1);
  const byId = new Map(jobs.list().map((j) => [j.id, j]));
  assert.equal(byId.get(ids.scanning).status, 'interrupted');
  assert.equal(byId.get(ids.scanning).detail, '120 of 300 folders · stopped by a restart');
  assert.ok(byId.get(ids.scanning).finishedAt > 0);
  assert.equal(byId.get(idle).detail, 'stopped by a restart');
  assert.equal(byId.get(ids.convPaused).status, 'running', 'a paused conversion resumes with the converter');
  assert.equal(byId.get(ids.scanned).status, 'done', 'finished jobs keep their status');
  // and Clear jobs takes them off the list
  jobs.clear({ vehicleId: 'car', keepExternal: ['converter:c2', 'converter:c3'] });
  assert.ok(!jobs.list().some((j) => j.status === 'interrupted'));
  assert.equal(jobs.interruptLeftovers(), 0);
  db.close();
});
