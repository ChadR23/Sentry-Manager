'use strict';

// Recycle Bin auto-empty (server/policies.js binDays): at the policy's run,
// what has been in the bin longer than the set days is deleted for good.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Policies, normalizePolicy } = require('../server/policies');

test('binDays: 1 to 365 days or none', () => {
  assert.equal(normalizePolicy({ binDays: 30 }).binDays, 30);
  assert.equal(normalizePolicy({ binDays: '' }, { ...normalizePolicy({}), binDays: 30 }).binDays, null);
  assert.throws(() => normalizePolicy({ binDays: 0 }), /1 to 365 days/);
  assert.throws(() => normalizePolicy({ binDays: 400 }), /1 to 365 days/);
  assert.equal(normalizePolicy({}).binDays, null, 'off by default');
});

test('a policy run with binDays deletes only bin items older than that, and says so in its result', async () => {
  const DAY = 86400000;
  const now = Date.now();
  const store = new Map([['policy:car', { enabled: true, binDays: 30, keepDays: { Recent: null, Sentry: null, Saved: null, Other: null } }]]);
  const items = [
    { id: 'old', label: 'old', trashedAt: now - 40 * DAY, bytes: 100 },
    { id: 'new', label: 'new', trashedAt: now - 5 * DAY, bytes: 50 }
  ];
  const deleted = [];
  const db = { get: (k) => store.get(k), set: (k, v) => store.set(k, v), binItems: () => items };
  const bin = { trash: async () => ({ moved: [], skipped: [], bytes: 0 }), deleteForever: async (id) => { deleted.push(id); return { bytes: items.find((x) => x.id === id).bytes }; } };
  const vehicles = { get: () => ({ id: 'car', timezone: 'UTC' }), list: () => [] };
  const inventory = { scan: async () => {}, get: () => ({ recordings: [] }) };
  const p = new Policies({ db, vehicles, inventory, bin, log: { info() {}, warn() {} } });
  await p.run('car');
  assert.deepEqual(deleted, ['old']);
  assert.deepEqual((({ emptied, freed }) => ({ emptied, freed }))(store.get('policy:car').lastResult), { emptied: 1, freed: 100 });
});

test('maxGB: the oldest unprotected recordings past the limit move, after the age rules', () => {
  const GB = 1024 ** 3;
  const recs = [
    { id: 'a', category: 'Recent', day: '2026-11-01', startKey: '2026-11-01_10-00-00', bytes: 3 * GB },
    { id: 'b', category: 'Sentry', day: '2026-11-02', startKey: '2026-11-02_10-00-00', bytes: 3 * GB, protected: true },
    { id: 'c', category: 'Recent', day: '2026-11-03', startKey: '2026-11-03_10-00-00', bytes: 3 * GB },
    { id: 'd', category: 'Recent', day: '2026-11-04', startKey: '2026-11-04_10-00-00', bytes: 3 * GB }
  ];
  const store = new Map([['policy:car', { enabled: true, maxGB: 7, keepDays: { Recent: null, Sentry: null, Saved: null, Other: null } }]]);
  const p = new Policies({ db: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) }, vehicles: { get: () => ({ timezone: 'UTC' }) }, inventory: { get: () => ({ recordings: recs }) }, bin: {}, log: {} });
  const out = p.preview('car');
  assert.deepEqual(out.ids, ['a', 'c'], '12 GB down to 6 GB: the two oldest that are not protected');
  assert.equal(out.overLimit, 2);
  assert.throws(() => normalizePolicy({ maxGB: 0 }), /1 GB or more/);
  assert.equal(normalizePolicy({ maxGB: '250' }).maxGB, 250);
});
