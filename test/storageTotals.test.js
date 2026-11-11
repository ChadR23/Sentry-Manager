'use strict';

// The heartbeat's free and total space count each share or disk once.

const test = require('node:test');
const assert = require('node:assert/strict');
const { storageTotals, storageKey } = require('../server/storageTotals');

const GB = 1e9;
const smb = (id, share) => ({ id, source: { type: 'smb', share } });
const local = (id, p) => ({ id, source: { type: 'path', path: p } });

test('two vehicles on the same SMB share (different folders, any case) count once; another share adds', () => {
  const list = [smb('a', '//NAS/TeslaCam/car1'), smb('b', '//nas/teslacam/car2'), smb('c', '//nas/Other')];
  const status = { a: { freeBytes: 100 * GB, totalBytes: 400 * GB }, b: { freeBytes: 100 * GB, totalBytes: 400 * GB }, c: { freeBytes: 10 * GB, totalBytes: 50 * GB } };
  const t = storageTotals(list, { statusOf: (v) => status[v.id], rootOf: () => '/x', statImpl: () => ({ dev: 1 }) });
  assert.deepEqual(t, { freeBytes: 110 * GB, totalBytes: 450 * GB });
  assert.equal(storageKey(list[0]), storageKey(list[1]));
});

test('local folders on the same disk count once, on another disk add; no space reported: null', () => {
  const list = [local('a', '/footage/a'), local('b', '/footage/b'), local('c', '/mnt/other')];
  const dev = { '/footage/a': 7, '/footage/b': 7, '/mnt/other': 9 };
  const st = { freeBytes: 5 * GB, totalBytes: 20 * GB };
  const t = storageTotals(list, { statusOf: () => st, rootOf: (v) => v.source.path, statImpl: (p) => ({ dev: dev[p] }) });
  assert.deepEqual(t, { freeBytes: 10 * GB, totalBytes: 40 * GB });
  assert.deepEqual(storageTotals(list, { statusOf: () => ({}), rootOf: (v) => v.source.path, statImpl: () => ({ dev: 1 }) }), { freeBytes: null, totalBytes: null });
});
