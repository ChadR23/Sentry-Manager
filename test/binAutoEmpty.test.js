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
