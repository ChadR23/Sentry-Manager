'use strict';

// The clip codec map (megabytes for a car with 35,000 clips) is written to
// the database only when a rescan changed it, not after every rescan.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Inventory } = require('../server/inventory');

test('probeCodecs saves the map only when a clip was read or one is gone', async () => {
  const saved = { 'codecs:v1': { 'RecentClips/a-front.mp4': [10, 1, 'h264'], 'RecentClips/gone-front.mp4': [10, 1, 'h264'] } };
  const sets = [];
  const db = { get: (k, d) => saved[k] ?? d, set: (k, v) => { sets.push(k); saved[k] = v; }, protectedSet: () => new Set() };
  const vehicles = { get: () => ({ id: 'v1' }), rootOf: () => '/nowhere' };
  const inv = new Inventory({ vehicles, db, log: { info() {}, warn() {} } });
  inv.state.set('v1', { files: new Map([['RecentClips/a-front.mp4', { rel: 'RecentClips/a-front.mp4', kind: 'clip', size: 10, mtimeMs: 1 }]]) });
  assert.equal(await inv.probeCodecs('v1'), 0);
  assert.deepEqual(sets, ['codecs:v1'], 'a clip gone: saved');
  assert.deepEqual(Object.keys(saved['codecs:v1']), ['RecentClips/a-front.mp4']);
  await inv.probeCodecs('v1');
  await inv.probeCodecs('v1');
  assert.deepEqual(sets, ['codecs:v1'], 'nothing changed: not written again');
});
