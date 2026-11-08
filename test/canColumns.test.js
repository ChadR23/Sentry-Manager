'use strict';

// The CAN Bridge's compact log format (canbridge-columns-xz/2) read through the
// one log reader (server/canLogReader.js): its test files decode to exactly the
// candump text, the index is the same whichever format a log came in, a
// malformed or oversized body is refused cleanly, and stopping early leaves no
// xz or decoder behind.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');
const { openCanLog, FORMAT_CANDUMP, FORMAT_COLUMNS, MAX_COLUMNS_BODY } = require('../server/canLogReader');
const { createCanIndex } = require('../server/canIndex');
const { encodeColumns } = require('./fixtures/columnsEncode');

const skip = spawnSync('xz', ['--version']).status !== 0 && 'needs xz';
const COLUMNS = path.join(__dirname, 'fixtures', 'columns-sample.log.xz');
const CANDUMP = path.join(__dirname, 'fixtures', 'columns-sample.candump.log.xz');
const SAMPLE_SHA256 = '94b7e2f631382aaf09df4303fc0256156759c64c20cd34397adbe4fb9b72a5a6';
const xzc = (buf) => execFileSync('xz', ['-1', '-c'], { input: buf, maxBuffer: 1 << 28 });

async function textOf(file, opts) {
  const r = openCanLog(file, opts);
  const parts = [];
  for await (const c of r.chunks()) parts.push(c);
  return { text: Buffer.concat(parts), format: r.format, truncated: r.truncated };
}
const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'cancolumns-'));

test('the CAN Bridge\'s test files: the columns log decodes to exactly the candump text (10,851 lines, its SHA-256)', { skip }, async () => {
  const cols = await textOf(COLUMNS);
  const text = await textOf(CANDUMP);
  assert.equal(cols.format, FORMAT_COLUMNS);
  assert.equal(text.format, FORMAT_CANDUMP);
  // the hash is over the decompressed text, LF after every line
  assert.equal(crypto.createHash('sha256').update(text.text).digest('hex'), SAMPLE_SHA256, 'the reference text');
  assert.equal(crypto.createHash('sha256').update(cols.text).digest('hex'), SAMPLE_SHA256, 'the columns log, decoded');
  assert.ok(cols.text.equals(text.text));
  let lines = 0;
  for await (const l of openCanLog(COLUMNS).lines()) { assert.ok(!l.includes('\n')); lines++; }
  assert.equal(lines, 10_851);
  assert.equal(cols.truncated, null);
  // the test encoder (from the spec) makes the bridge's body byte for byte: the synthetic logs below are real ones
  const body = execFileSync('xz', ['-dc', COLUMNS]);
  assert.ok(encodeColumns(text.text.toString('latin1').replace(/\n$/, '').split('\n')).equals(body));
});

test('the index is the same whichever format a log came in', { skip }, async () => {
  const base = await tmp();
  try {
    const name = 'K_20261108T005818Z_1.log.xz';
    const out = {};
    for (const [tag, src] of [['v1', CANDUMP], ['v2', COLUMNS]]) {
      await fsp.mkdir(path.join(base, tag, 'can', 'K'), { recursive: true });
      await fsp.copyFile(src, path.join(base, tag, 'can', 'K', name));
      const idx = createCanIndex({ canDir: path.join(base, tag, 'can'), dir: path.join(base, tag, 'idx') });
      const r = await idx.indexLog('K', name);
      const files = {};
      for (const f of (await fsp.readdir(path.join(base, tag, 'idx', 'K'))).sort()) {
        const b = await fsp.readFile(path.join(base, tag, 'idx', 'K', f));
        files[f] = JSON.parse((f.endsWith('.gz') ? zlib.gunzipSync(b) : b).toString('utf8'));
      }
      out[tag] = { r, files };
    }
    assert.ok(out.v1.r.frames > 10_000, `frames read (${out.v1.r.frames})`);
    assert.deepEqual(out.v2.r, out.v1.r);
    assert.deepEqual(Object.keys(out.v2.files), Object.keys(out.v1.files));
    assert.ok(Object.keys(out.v1.files).some((f) => f.endsWith('.raw.json.gz')));
    assert.deepEqual(out.v2.files, out.v1.files);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('a columns log that is malformed, cut off or too big is refused (an error for that log, never a crash); the file is not touched', { skip, timeout: 60000 }, async () => {
  const base = await tmp();
  try {
    await fsp.mkdir(path.join(base, 'can', 'K'), { recursive: true });
    const put = async (name, body) => { const f = path.join(base, 'can', 'K', name); await fsp.writeFile(f, body); return f; };
    const good = execFileSync('xz', ['-dc', COLUMNS]);
    const magic = good.subarray(0, 20);
    const cases = {
      'K_20200101T080000Z_1.log.xz': [xzc(Buffer.concat([magic, Buffer.from([5])])), /cut off/],
      'K_20200101T080100Z_2.log.xz': [xzc(Buffer.concat([good, Buffer.from([0])])), /trailing bytes/],
      'K_20200101T080200Z_3.log.xz': [xzc(Buffer.concat([magic, Buffer.from([0xff, 0xff, 0xff, 0x7f])])), /out of range/],
      // the xz itself cut off: a columns body is all or nothing
      'K_20200101T080300Z_4.log.xz': [fs.readFileSync(COLUMNS).subarray(0, 20_000), /xz:/]
    };
    const idx = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx') });
    for (const [name, [body, why]] of Object.entries(cases)) {
      const file = await put(name, body);
      await assert.rejects(idx.indexLog('K', name), (err) => {
        assert.match(err.message, /could not read .*canbridge-columns-xz\/2/);
        assert.match(err.message, why);
        assert.ok(!err.retry, 'the log\'s own fault: not tried again until it changes');
        return true;
      }, name);
      assert.ok(fs.readFileSync(file).equals(body), 'kept as it came');
    }
    // kick: each one is an error once, marked done, nothing left pending
    await idx.kick();
    assert.match(idx.status().lastError, /could not read/);
    assert.deepEqual(await idx.pendingLogs(), []);

    // more than the most a columns body can be: stopped while unpacking (xz too), not decoded
    const big = await put('K_20200101T080400Z_5.log.xz', xzc(Buffer.concat([magic, Buffer.alloc(MAX_COLUMNS_BODY + 1024)])));
    await assert.rejects(textOf(big), /unpacks to more than 64 MB/);
    // (a smaller bound, the same way)
    await assert.rejects(textOf(COLUMNS, { maxBody: 64 * 1024 }), /unpacks to more than 64 KB/);
    // a body that needs more memory to decode than the decoder may have: refused
    const lines = [];
    for (let i = 0; i < 400_000; i++) lines.push(`(${1794099498 + Math.floor(i / 1000)}.${String((i % 1000) * 1000).padStart(6, '0')}) can0 ${(0x100 + (i % 50)).toString(16).toUpperCase()}#0102030405060708`);
    const heavy = await put('K_20200101T080500Z_6.log.xz', xzc(encodeColumns(lines)));
    await assert.rejects(textOf(heavy, { heapMb: 8 }), /needs more than 8 MB to decode/);
    // ... and with the normal bound it decodes
    let n = 0;
    for await (const l of openCanLog(heavy).lines()) { if (l.startsWith('(')) n++; }
    assert.equal(n, 400_000);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('stopping early ends xz and the decoder: the next logs still read (no decoder slot is lost)', { skip, timeout: 60000 }, async () => {
  for (let i = 0; i < 5; i++) {
    for await (const l of openCanLog(COLUMNS).lines()) { assert.ok(l); break; }
    const r = openCanLog(COLUMNS).chunks();
    await r.next();
    await r.return();
  }
  // a throw in the reader's loop
  await assert.rejects((async () => { for await (const l of openCanLog(COLUMNS).lines()) throw new Error(`stop at ${l.slice(0, 5)}`); })(), /stop at/);
  const { text } = await textOf(COLUMNS);
  assert.equal(crypto.createHash('sha256').update(text).digest('hex'), SAMPLE_SHA256);
  // two at once, and more waiting for a slot
  const all = await Promise.all([1, 2, 3, 4].map(() => textOf(COLUMNS)));
  for (const t of all) assert.ok(t.text.equals(text));
});

test('a candump text log reads as before: lines as they come, a short file, an empty file', { skip }, async () => {
  const base = await tmp();
  try {
    const short = path.join(base, 'short.log.xz');
    fs.writeFileSync(short, xzc(Buffer.from('(1.000000) can0 1#')));
    assert.deepEqual(await textOf(short), { text: Buffer.from('(1.000000) can0 1#'), format: FORMAT_CANDUMP, truncated: null });
    const empty = path.join(base, 'empty.log.xz');
    fs.writeFileSync(empty, xzc(Buffer.alloc(0)));
    assert.deepEqual(await textOf(empty), { text: Buffer.alloc(0), format: null, truncated: null });
    const cut = path.join(base, 'cut.log.xz');
    fs.writeFileSync(cut, fs.readFileSync(CANDUMP).subarray(0, 40_000));
    const r = await textOf(cut);
    assert.equal(r.format, FORMAT_CANDUMP);
    assert.ok(r.text.length > 0 && r.truncated, 'what was read, and why it ended');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});
