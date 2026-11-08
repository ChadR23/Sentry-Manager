'use strict';

// The streamed .zip of the CAN bundle (server/zip.js streamZip): stored
// entries written as they are read, readable by readZip and by unzip, and an
// error (not a broken archive passed off as whole) when a file changed size.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough, Readable } = require('stream');
const { spawnSync } = require('child_process');
const { streamZip, readZip } = require('../server/zip');

const collect = (s) => { const parts = []; s.on('data', (c) => parts.push(c)); return () => Buffer.concat(parts); };

test('streamZip: buffers and streams, stored, read back byte for byte (also by unzip)', async () => {
  const big = crypto.randomBytes(3 * 1024 * 1024 + 7);
  const out = new PassThrough({ highWaterMark: 16 * 1024 });
  const all = collect(out);
  await streamZip(out, [
    { name: 'ids.csv', data: Buffer.from('bus,id\ncan0,0x7EF\n'), mtime: Date.UTC(2026, 10, 8, 12, 30, 10) },
    { name: 'K/K_20261108T120000Z_1.log.xz', size: big.length, mtime: Date.UTC(2026, 10, 8), open: () => Readable.from([big.subarray(0, 1000), big.subarray(1000)]) },
    { name: 'empty.json', size: 0, open: () => Readable.from([]) }
  ]);
  out.end();
  const zip = all();
  const files = readZip(zip, { maxFile: 8 * 1024 * 1024 });
  assert.deepEqual(files.map((f) => f.name), ['ids.csv', 'K/K_20261108T120000Z_1.log.xz', 'empty.json']);
  assert.deepEqual(files[1].data, big);
  assert.equal(files[0].data.toString(), 'bus,id\ncan0,0x7EF\n');
  if (spawnSync('unzip', ['-v']).status === 0) {
    const f = path.join(os.tmpdir(), `zipstream-${process.pid}.zip`);
    fs.writeFileSync(f, zip);
    try {
      assert.equal(spawnSync('unzip', ['-tq', f]).status, 0, 'unzip -t passes');
      assert.equal(spawnSync('unzip', ['-p', f, 'K/K_20261108T120000Z_1.log.xz'], { maxBuffer: 8 * 1024 * 1024 }).stdout.length, big.length);
    } finally { fs.rmSync(f, { force: true }); }
  }
});

test('streamZip: a file that changed size, or a reader that went away, is an error', async () => {
  const out = new PassThrough();
  collect(out);
  await assert.rejects(streamZip(out, [{ name: 'a', size: 10, open: () => Readable.from([Buffer.alloc(5)]) }]), /changed while/);
  await assert.rejects(streamZip(new PassThrough(), [{ name: 'b', size: 3, open: () => Readable.from([Buffer.alloc(9)]) }]), /changed while/);
  const gone = new PassThrough();
  gone.destroy();
  await assert.rejects(streamZip(gone, [{ name: 'c', data: Buffer.alloc(4) }]), /stopped/);
});
