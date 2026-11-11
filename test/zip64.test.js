'use strict';

// Zip64 in server/zip.js: written only when needed (a file or offset of
// 4 GiB or more, or 65,535 files or more), every field where APPNOTE puts it,
// and a small archive byte for byte as before. Nothing large is written to
// disk: the 4 GiB case streams zeros to a sink that keeps only the records.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { PassThrough, Readable, Writable } = require('stream');
const { spawnSync } = require('child_process');
const { streamZip, writeZip, readZip } = require('../server/zip');

const MAX32 = 0xffffffff;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const collect = (s) => { const parts = []; s.on('data', (c) => parts.push(c)); return () => Buffer.concat(parts); };
const has = (cmd, args) => spawnSync(cmd, args).status === 0;

/** The end of a zip: the classic end record, and the Zip64 end record and locator when there. */
function ends(buf, base = 0) {
  const e = buf.length - 22;
  assert.equal(buf.readUInt32LE(e), 0x06054b50);
  const classic = { disk: buf.readUInt16LE(e + 4), cdDisk: buf.readUInt16LE(e + 6), here: buf.readUInt16LE(e + 8), count: buf.readUInt16LE(e + 10), cdSize: buf.readUInt32LE(e + 12), cdAt: buf.readUInt32LE(e + 16), comment: buf.readUInt16LE(e + 20) };
  if (buf.readUInt32LE(e - 20) !== 0x07064b50) return { classic };
  const l = e - 20;
  const locator = { disk: buf.readUInt32LE(l + 4), at: Number(buf.readBigUInt64LE(l + 8)), disks: buf.readUInt32LE(l + 16) };
  const z = locator.at - base;
  assert.equal(z, l - 56, 'the Zip64 end record is right before its locator');
  assert.equal(buf.readUInt32LE(z), 0x06064b50);
  const end64 = {
    rest: Number(buf.readBigUInt64LE(z + 4)), madeBy: buf.readUInt16LE(z + 12), needed: buf.readUInt16LE(z + 14), disk: buf.readUInt32LE(z + 16), cdDisk: buf.readUInt32LE(z + 20),
    here: Number(buf.readBigUInt64LE(z + 24)), count: Number(buf.readBigUInt64LE(z + 32)), cdSize: Number(buf.readBigUInt64LE(z + 40)), cdAt: Number(buf.readBigUInt64LE(z + 48))
  };
  return { classic, locator, end64 };
}

/** The central directory records in buf (from `at`, buf starting at file offset `base`). */
function centralOf(buf, at, count) {
  const out = [];
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const extra = buf.subarray(at + 46 + nameLen, at + 46 + nameLen + extraLen);
    out.push({
      madeBy: buf.readUInt16LE(at + 4), needed: buf.readUInt16LE(at + 6), flags: buf.readUInt16LE(at + 8), method: buf.readUInt16LE(at + 10), crc: buf.readUInt32LE(at + 16),
      csize: buf.readUInt32LE(at + 20), usize: buf.readUInt32LE(at + 24), comment: buf.readUInt16LE(at + 32), offset: buf.readUInt32LE(at + 42),
      name: buf.toString('utf8', at + 46, at + 46 + nameLen), extra
    });
    at += 46 + nameLen + extraLen + buf.readUInt16LE(at + 32);
  }
  return { list: out, end: at };
}

/** A Zip64 extra field's 8-byte values (and that it is the only extra field). */
function zip64Values(extra) {
  assert.equal(extra.readUInt16LE(0), 0x0001);
  const len = extra.readUInt16LE(2);
  assert.equal(extra.length, 4 + len, 'nothing else in the extra field');
  return Array.from({ length: len / 8 }, (_, i) => Number(extra.readBigUInt64LE(4 + 8 * i)));
}

test('a small archive is byte for byte what it was before Zip64 (streamZip and writeZip)', async () => {
  const out = new PassThrough();
  const all = collect(out);
  const d = Buffer.alloc(100000, 7);
  await streamZip(out, [
    { name: 'a.txt', data: Buffer.from('hello'), mtime: Date.UTC(2026, 3, 4, 5, 6, 7) },
    { name: 'K/b.log.xz', size: d.length, mtime: Date.UTC(2026, 10, 8), open: () => Readable.from([d]) },
    { name: 'K/c.log', size: null, maxSize: 1 << 20, open: () => Readable.from([Buffer.from('x\n'), Buffer.from('ünï\n')]) },
    { name: 'ids.csv', make: async () => Buffer.from('m\n') }
  ]);
  out.end();
  // (the hashes of the same archives made by the code before Zip64)
  assert.equal(sha(all()), '52a5b63ec77af2c39bd030d36d0099f20aac21973437524b4a56c9998a208ea8');
  assert.equal(sha(writeZip([{ name: 'web/x.js', data: Buffer.from('1') }, { name: 'ü', data: Buffer.alloc(0) }])), 'fd1c32a4c806a234466aeb1c39af9bdb66f87a522c7517920904b1c6c31db842');
  assert.equal(ends(all()).end64, undefined, 'no Zip64 records');
});

test('a candump entry of unknown size with no bound is Zip64 from its local header on, its descriptor 8-byte', async () => {
  const out = new PassThrough();
  const all = collect(out);
  await streamZip(out, [{ name: 'c.log', size: null, open: () => Readable.from([Buffer.from('abc')]) }]);
  out.end();
  const zip = all();
  assert.equal(zip.readUInt16LE(4), 45, 'version needed 4.5');
  assert.equal(zip.readUInt16LE(6), 0x808);
  assert.equal(zip.readUInt32LE(14), 0, 'CRC in the descriptor');
  assert.equal(zip.readUInt32LE(18), MAX32);
  assert.equal(zip.readUInt32LE(22), MAX32);
  assert.equal(zip.readUInt16LE(28), 20);
  assert.deepEqual(zip64Values(zip.subarray(30 + 5, 30 + 5 + 20)), [0, 0], 'uncompressed and compressed, zeros (sizes follow)');
  const d = 30 + 5 + 20 + 3;
  assert.equal(zip.readUInt32LE(d), 0x08074b50);
  assert.equal(zip.readUInt32LE(d + 4), zlib.crc32(Buffer.from('abc')));
  assert.equal(Number(zip.readBigUInt64LE(d + 8)), 3);
  assert.equal(Number(zip.readBigUInt64LE(d + 16)), 3);
  const [c] = centralOf(zip, d + 24, 1).list;
  assert.deepEqual([c.csize, c.usize, c.offset, c.extra.length, c.needed], [3, 3, 0, 0, 20], 'the central directory has its real sizes: nothing overflowed');
  assert.equal(readZip(zip)[0].data.toString(), 'abc');
});

test('70,000 files: Zip64 end records, the classic count 0xFFFF, read back (and by unzip and 7z)', async () => {
  const N = 70_000;
  const out = new PassThrough({ highWaterMark: 1 << 20 });
  const all = collect(out);
  const entries = [];
  for (let i = 0; i < N; i++) entries.push({ name: `f/${i}.txt`, data: Buffer.from(`${i}\n`), mtime: Date.UTC(2026, 10, 11) });
  await streamZip(out, entries);
  out.end();
  const zip = all();
  const { classic, locator, end64 } = ends(zip);
  assert.deepEqual(locator, { disk: 0, at: zip.length - 22 - 20 - 56, disks: 1 });
  assert.deepEqual(end64, { rest: 44, madeBy: 45, needed: 45, disk: 0, cdDisk: 0, here: N, count: N, cdSize: end64.cdSize, cdAt: end64.cdAt });
  assert.equal(end64.cdAt + end64.cdSize, locator.at, 'the central directory ends where the Zip64 end record starts');
  // only the count overflows: it is 0xFFFF, the size and offset are as they are
  assert.deepEqual(classic, { disk: 0, cdDisk: 0, here: 0xffff, count: 0xffff, cdSize: end64.cdSize, cdAt: end64.cdAt, comment: 0 });
  const { list, end } = centralOf(zip, end64.cdAt, N);
  assert.equal(end, locator.at);
  assert.ok(list.every((c) => c.extra.length === 0 && c.needed === 20), 'no entry needs Zip64 itself');
  assert.equal(list[69_999].name, 'f/69999.txt');
  const files = readZip(zip, { maxFiles: N });
  assert.equal(files.length, N);
  assert.equal(files[12345].data.toString(), '12345\n');
  assert.throws(() => readZip(zip), /Too many files/, 'the packs\' limit still holds');
  const unzip = has('unzip', ['-v']);
  const sevenZip = has('7z', ['i']);
  if (!unzip && !sevenZip) return;
  const f = path.join(os.tmpdir(), `zip64-${process.pid}.zip`);
  fs.writeFileSync(f, zip);
  try {
    if (unzip) {
      const r = spawnSync('unzip', ['-tq', f], { maxBuffer: 64 << 20 });
      assert.equal(r.status, 0, `unzip -t: ${r.stdout}${r.stderr}`);
      assert.match(spawnSync('unzip', ['-p', f, 'f/69999.txt']).stdout.toString(), /^69999\n$/);
    }
    if (sevenZip) {
      const r = spawnSync('7z', ['t', f], { maxBuffer: 64 << 20 });
      assert.equal(r.status, 0, `7z t: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout.toString(), /Files: 70000/);
      assert.doesNotMatch(r.stdout.toString(), /Warnings|Headers Error/);
    }
  } finally { fs.rmSync(f, { force: true }); }
});

test('a file over 4 GiB, and files after it at offsets past 4 GiB: every Zip64 field (streamed to a sink, nothing on disk)', async () => {
  const BIG = 2 ** 32 + 5;
  const block = Buffer.alloc(4 << 20);
  async function* zeros(n) { for (; n > 0; n -= block.length) yield n >= block.length ? block : block.subarray(0, n); }
  let crcBig = 0;
  for (let n = BIG; n > 0; n -= block.length) crcBig = zlib.crc32(n >= block.length ? block : block.subarray(0, n), crcBig);
  // the sink keeps what streamZip writes itself (headers, descriptors, small files, the end), by offset
  const kept = [];
  let total = 0;
  const sink = new Writable({
    highWaterMark: 8 << 20,
    write(c, enc, cb) { if (c !== block && c.length < 64 * 1024) kept.push([total, Buffer.from(c)]); total += c.length; cb(); }
  });
  const at = (off, len) => {
    const k = kept.find(([o, b]) => o <= off && off + len <= o + b.length);
    assert.ok(k, `bytes at ${off} were written by streamZip`);
    return k[1].subarray(off - k[0], off - k[0] + len);
  };
  await streamZip(sink, [
    { name: 'big.bin', size: BIG, mtime: Date.UTC(2026, 10, 11), open: () => Readable.from(zeros(BIG)) },
    { name: 'after.txt', data: Buffer.from('after\n'), mtime: Date.UTC(2026, 10, 11) },
    { name: 'after.log', size: null, maxSize: 1000, open: () => Readable.from([Buffer.from('candump\n')]) }
  ]);
  // the local header of the big file: sizes 0xFFFFFFFF, a Zip64 extra with zeros (in the descriptor)
  const lh = at(0, 30 + 7 + 20);
  assert.equal(lh.readUInt32LE(0), 0x04034b50);
  assert.equal(lh.readUInt16LE(4), 45);
  assert.equal(lh.readUInt16LE(6), 0x808);
  assert.equal(lh.readUInt16LE(8), 0, 'stored');
  assert.equal(lh.readUInt32LE(14), 0);
  assert.equal(lh.readUInt32LE(18), MAX32);
  assert.equal(lh.readUInt32LE(22), MAX32);
  assert.equal(lh.readUInt16LE(26), 7);
  assert.equal(lh.readUInt16LE(28), 20);
  assert.equal(lh.toString('utf8', 30, 37), 'big.bin');
  assert.deepEqual(zip64Values(lh.subarray(37)), [0, 0]);
  // its Zip64 data descriptor: 8-byte sizes
  const dAt = 57 + BIG;
  const desc = at(dAt, 24);
  assert.equal(desc.readUInt32LE(0), 0x08074b50);
  assert.equal(desc.readUInt32LE(4), crcBig >>> 0);
  assert.equal(Number(desc.readBigUInt64LE(8)), BIG);
  assert.equal(Number(desc.readBigUInt64LE(16)), BIG);
  // the next file starts past 4 GiB; its local header is classic (it has no offset field)
  const second = dAt + 24;
  assert.ok(second > MAX32);
  const lh2 = at(second, 30);
  assert.deepEqual([lh2.readUInt32LE(0), lh2.readUInt16LE(4), lh2.readUInt16LE(28)], [0x04034b50, 20, 0]);
  const third = second + 30 + 9 + 6 + 16;
  assert.deepEqual([at(third, 30).readUInt32LE(0), at(third, 30).readUInt16LE(28)], [0x04034b50, 0]);
  const cdAt = third + 30 + 9 + 8 + 16;
  // the end: central directory, Zip64 end record, locator, classic end record
  const tailFrom = cdAt;
  const rest = kept.filter(([o]) => o >= tailFrom);
  assert.equal(rest[0][0], tailFrom, 'the central directory is where the files end');
  const tail = Buffer.concat(rest.map(([, b]) => b));
  assert.equal(tailFrom + tail.length, total);
  const { classic, locator, end64 } = ends(tail, tailFrom);
  assert.deepEqual(end64, { rest: 44, madeBy: 45, needed: 45, disk: 0, cdDisk: 0, here: 3, count: 3, cdSize: end64.cdSize, cdAt });
  assert.deepEqual(locator, { disk: 0, at: cdAt + end64.cdSize, disks: 1 });
  assert.equal(total, locator.at + 56 + 20 + 22);
  // only the offset overflows: the count and the size are as they are
  assert.deepEqual(classic, { disk: 0, cdDisk: 0, here: 3, count: 3, cdSize: end64.cdSize, cdAt: MAX32, comment: 0 });
  const { list, end } = centralOf(tail, 0, 3);
  assert.equal(end, end64.cdSize);
  const [a, b, c] = list;
  // the big one: both sizes overflow, its offset (0) does not
  assert.deepEqual([a.name, a.madeBy, a.needed, a.flags, a.method, a.crc, a.csize, a.usize, a.offset], ['big.bin', 45, 45, 0x808, 0, crcBig >>> 0, MAX32, MAX32, 0]);
  assert.deepEqual(zip64Values(a.extra), [BIG, BIG], 'uncompressed, then compressed');
  // the small ones after it: only the offset
  assert.deepEqual([b.name, b.needed, b.csize, b.usize, b.offset, b.crc], ['after.txt', 45, 6, 6, MAX32, zlib.crc32(Buffer.from('after\n'))]);
  assert.deepEqual(zip64Values(b.extra), [second]);
  assert.deepEqual([c.name, c.needed, c.csize, c.usize, c.offset], ['after.log', 45, 8, 8, MAX32]);
  assert.deepEqual(zip64Values(c.extra), [third]);
});

test('writeZip and readZip: Zip64 records read back, with a Zip64 offset in the central directory', () => {
  const { zipRecords } = require('../server/zip');
  const nameBuf = Buffer.from('x.txt');
  const data = Buffer.from('zip64');
  // a file as if it sat past 4 GiB: the archive's offsets are shifted by a prefix readZip never reads
  const head = zipRecords.localHeader({ nameBuf, flags: 0x800, method: 0, time: 0, date: 0, crc: zlib.crc32(data), csize: 5, usize: 5, zip64: true });
  const cd = zipRecords.centralRecord({ nameBuf, flags: 0x800, method: 0, time: 0, date: 0, crc: zlib.crc32(data), csize: 5, usize: 5, offset: 0 });
  const zip = Buffer.concat([head, data, cd, zipRecords.endRecords(0xffff, cd.length, head.length + 5)]);
  assert.throws(() => readZip(zip, { maxFiles: 70_000 }), /damaged/, 'the count says 65,535 files; there is one');
  const ok = Buffer.concat([head, data, cd, zipRecords.endRecords(1, cd.length, head.length + 5)]);
  assert.equal(readZip(ok)[0].data.toString(), 'zip64', 'a Zip64 local header is read');
  const big = zipRecords.centralRecord({ nameBuf, flags: 0, method: 0, time: 0, date: 0, crc: 0, csize: 5, usize: MAX32 + 1, offset: MAX32 + 9 });
  assert.deepEqual([big.readUInt32LE(20), big.readUInt32LE(24), big.readUInt32LE(42)], [5, MAX32, MAX32]);
  assert.deepEqual(zip64Values(big.subarray(46 + 5)), [MAX32 + 1, MAX32 + 9], 'only what overflowed, in order');
});
