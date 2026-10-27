'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diskSpace, _units } = require('../src/main/converter/fsSpace');

// Docker Desktop for Mac (virtiofs): f_bsize 1 MiB, blocks counted in 4 KiB
// fragments. A 494 GB Mac mini disk with 300 GB used.
const MAC = { type: 0x65735546, bsize: 1048576, blocks: 120_605_000, bfree: 47_363_000, bavail: 47_363_000 };
const fsp = (sfs) => ({ statfs: async (_p, opts) => (opts?.bigint ? Object.fromEntries(Object.entries(sfs).map(([k, v]) => [k, BigInt(v)])) : sfs) });
const stat = (out, err = null) => (cmd, args, opts, cb) => { assert.deepEqual([cmd, args.slice(0, 3)], ['stat', ['-f', '-c', '%S']]); cb(err, out); };

test('disk space: counts blocks in the fragment size, so Docker on a Mac shows the real disk, not 256 times it', async () => {
  _units.clear();
  const s = await diskSpace(fsp(MAC), '/data', { platform: 'linux', run: stat('4096\n') });
  assert.equal(s.unit, 4096);
  assert.equal(Math.round(s.total / 1e9), 494, 'about 494 GB, not 126 TB');
  assert.equal(Math.round(s.free / 1e9), 194);
  const big = await diskSpace(fsp(MAC), '/data', { platform: 'linux', bigint: true });
  assert.equal(big.free, BigInt(MAC.bavail) * 4096n, 'the same in BigInt (the converter\'s free-space checks), from the cached unit');
});

test('disk space: ordinary disks and a missing stat keep bsize; other systems never run stat', async () => {
  _units.clear();
  const ext4 = { type: 0xef53, bsize: 4096, blocks: 1000, bfree: 400, bavail: 300 };
  assert.deepEqual(await diskSpace(fsp(ext4), '/x', { platform: 'linux', run: stat('4096') }), { total: 4096000, free: 1228800, used: 2457600, type: 0xef53, unit: 4096 });
  _units.clear();
  assert.equal((await diskSpace(fsp(MAC), '/y', { platform: 'linux', run: stat('', new Error('no stat')) })).unit, 1048576, 'falls back to bsize');
  assert.equal((await diskSpace(fsp(MAC), '/z', { platform: 'darwin', run: () => { throw new Error('never run'); } })).unit, 1048576);
});
