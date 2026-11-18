'use strict';

// The quick speed reader parses a clip's moov without holding a buffer the
// size of the clip, and reads every clip exactly as it did when it did.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mp4 = require('../src/main/converter/mp4');
const {
  h264Mp4, h265Mp4, av1Mp4, hevcNal, teslaSeiNal, lengthPrefixedSample, box
} = require('./fixtures/fixtureBuilders');

const READER = require.resolve('../server/speedReader');

// the reader as it is, and the reader as it was: the parts laid into a zeroed
// buffer the size of the file, then parsed whole
function loadReader(old) {
  const saved = mp4.parseMp4Parts;
  if (old) {
    mp4.parseMp4Parts = (fileSize, parts) => {
      const image = Buffer.alloc(fileSize);
      for (const part of parts) part.bytes.copy(image, part.start);
      return mp4.parseMp4(image);
    };
  }
  delete require.cache[READER];
  try {
    return require(READER);
  } finally {
    mp4.parseMp4Parts = saved;
    delete require.cache[READER];
  }
}
const now = loadReader(false);
const before = loadReader(true);

async function outcome(reader, file) {
  try {
    return { samples: await reader.readSamples(file) };
  } catch (error) {
    return { error: `${error.name}: ${error.message}`, code: error.code };
  }
}

// a record with gear (field 2) and speed (field 4)
function record(speed) {
  const f = Buffer.alloc(4);
  f.writeFloatLE(speed);
  return Buffer.concat([Buffer.from([0x10, 0x01, 0x25]), f]);
}

// 30 frames a second for 3 s, frame n driving n / 2 m/s
const FRAMES = 90;
const speedAt = (n) => 0.5 + n / 2;

function avcClip(picture = 64) {
  const samples = Array.from({ length: FRAMES }, (_, n) => lengthPrefixedSample([teslaSeiNal(record(speedAt(n))), Buffer.concat([Buffer.from([0x65]), Buffer.alloc(picture, 0x11)])]));
  return h264Mp4({ samples });
}

function hevcClip() {
  const samples = Array.from({ length: FRAMES }, (_, n) => lengthPrefixedSample([hevcNal(51, teslaSeiNal(record(speedAt(n))).subarray(2)), hevcNal(19, Buffer.alloc(64, 0x22))]));
  return h265Mp4({ samples, chunks: [30, 30, 30], chunkPadding: 5 });
}

// AV1 as the converter writes it: the records in a first media box, each
// frame's ended by a picture marker, then the pictures, then the moov
function av1Clip() {
  const samples = Array.from({ length: FRAMES }, () => Buffer.alloc(48, 0x33));
  const plain = av1Mp4({ samples, moovAfterMdat: true });
  const marker = Buffer.from([0x61, 0x01, 0x80]);
  const carrier = box('mdat', Buffer.concat(Array.from({ length: FRAMES }, (_, n) => lengthPrefixedSample([teslaSeiNal(record(speedAt(n))), marker]))));
  const moved = mp4.rewriteChunkOffsets(plain, mp4.parseMp4(plain), BigInt(carrier.length));
  return Buffer.concat([carrier, moved]);
}

// a small deterministic generator, so a failure repeats
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function writer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-mem-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  return (bytes) => {
    const file = path.join(dir, `${n++}.mp4`);
    fs.writeFileSync(file, bytes);
    return file;
  };
}

test('speed reader: the moov-only parse gives the same tree as the whole file', () => {
  for (const bytes of [avcClip(), hevcClip(), av1Clip()]) {
    const whole = mp4.parseMp4(bytes);
    const moov = whole.children.find((b) => b.type === 'moov');
    const parts = whole.children.filter((b) => b !== moov).map((b) => ({ start: Number(b.start), bytes: bytes.subarray(Number(b.start), Number(b.contentStart)) }));
    parts.push({ start: Number(moov.start), bytes: bytes.subarray(Number(moov.start), Number(moov.end)) });
    const sparse = mp4.parseMp4Parts(bytes.length, parts);
    const shape = (node) => [node.type, node.start, node.end, node.children.map(shape)];
    assert.deepEqual(shape(sparse), shape(whole));
    const a = mp4.selectVideoTrack(whole);
    const b = mp4.selectVideoTrack(sparse);
    assert.equal(b.id, a.id);
    assert.deepEqual(mp4.buildSampleIndex(b), mp4.buildSampleIndex(a));
    for (const type of ['mdhd', 'stsd', 'stsz', 'stco']) {
      assert.deepEqual(mp4.boxContent(sparse, mp4.findBoxes(b, type)[0]), mp4.boxContent(whole, mp4.findBoxes(a, type)[0]), type);
    }
  }
});

test('speed reader: reads avc1, hevc and av01 clips as before', async (t) => {
  const write = writer(t);
  const expected = [speedAt(0), speedAt(30), speedAt(60)].map((v) => Math.round(v * 100) / 100);
  for (const [name, bytes] of [['avc1', avcClip()], ['hevc', hevcClip()], ['av01', av1Clip()]]) {
    const file = write(bytes);
    assert.deepEqual(await now.readSpeeds(file), expected, name);
    assert.deepEqual(await outcome(now, file), await outcome(before, file), name);
  }
});

test('speed reader: a damaged clip fails or reads exactly as before', async (t) => {
  const write = writer(t);
  const random = rng(7);
  const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0); return b; };
  const avc = avcClip();
  const cases = [
    Buffer.alloc(100, 7),
    avc.subarray(0, 40),
    avc.subarray(0, avc.length - 10),
    // a size-zero last box, a box past the end, extra top-level boxes
    Buffer.concat([avc, u32(0), Buffer.from('free'), Buffer.alloc(20)]),
    Buffer.concat([avc, u32(500), Buffer.from('free'), Buffer.alloc(20)]),
    Buffer.concat([avc, box('trak', Buffer.alloc(40))]),
    Buffer.concat([avc, box('trak')]),
    Buffer.concat([avc, box('stbl', Buffer.alloc(5))]),
    Buffer.concat([avc, box('moov', Buffer.alloc(30))]),
    Buffer.concat([avc, box('moof', Buffer.alloc(8))]),
    Buffer.concat([box('free', Buffer.alloc(16)), avc])
  ];
  for (const source of [avc, hevcClip(), av1Clip()]) {
    const tree = mp4.parseMp4(source);
    const moov = tree.children.find((b) => b.type === 'moov');
    for (let i = 0; i < 150; i++) {
      const bytes = Buffer.from(source);
      // mostly in the moov, where the parse reads; now and then anywhere
      const span = random() < 0.8 ? [Number(moov.start), Number(moov.end)] : [0, bytes.length];
      for (let k = 1 + Math.floor(random() * 3); k > 0; k--) bytes[span[0] + Math.floor(random() * (span[1] - span[0]))] = Math.floor(random() * 256);
      cases.push(bytes);
    }
  }
  let failures = 0;
  for (const bytes of cases) {
    const file = write(bytes);
    const got = await outcome(now, file);
    assert.deepEqual(got, await outcome(before, file));
    if (got.error) failures++;
  }
  assert.ok(failures > 20, 'the damaged clips exercise the error paths');
});

test('speed reader: what it holds does not grow with the clip', async (t) => {
  const write = writer(t);
  const largest = async (file) => {
    const alloc = Buffer.alloc;
    const allocUnsafe = Buffer.allocUnsafe;
    const start = process.memoryUsage().arrayBuffers;
    let biggest = 0;
    let peak = 0;
    const note = (size) => {
      biggest = Math.max(biggest, size);
      peak = Math.max(peak, process.memoryUsage().arrayBuffers - start);
    };
    Buffer.alloc = function (size, ...rest) { const b = alloc.call(this, size, ...rest); note(size); return b; };
    Buffer.allocUnsafe = function (size) { const b = allocUnsafe.call(this, size); note(size); return b; };
    try {
      await now.readSpeeds(file);
    } finally {
      Buffer.alloc = alloc;
      Buffer.allocUnsafe = allocUnsafe;
    }
    return { biggest, peak };
  };
  // the same clip with ~4 KB and ~400 KB pictures: a 60x larger file
  const small = write(avcClip(4_000));
  const big = write(avcClip(400_000));
  assert.ok(fs.statSync(big).size > 30 * 1024 * 1024);
  const a = await largest(small);
  const b = await largest(big);
  assert.ok(b.biggest < 64 * 1024, `largest buffer ${b.biggest} bytes`);
  assert.ok(b.biggest <= a.biggest * 2 + 4096, `largest buffer ${a.biggest} -> ${b.biggest} bytes`);
  assert.ok(b.peak < 8 * 1024 * 1024, `held ${b.peak} bytes`);
  // a clip padded out with a free box after the media reads the same way
  const padded = write(avcClip(4_000));
  const fd = fs.openSync(padded, 'a');
  fs.writeSync(fd, Buffer.concat([Buffer.from([0x02, 0x00, 0x00, 0x08]), Buffer.from('free')]));
  fs.closeSync(fd);
  fs.truncateSync(padded, fs.statSync(small).size + 0x02000008);
  const c = await largest(padded);
  assert.ok(c.biggest < 64 * 1024 && c.peak < 8 * 1024 * 1024, `padded: ${JSON.stringify(c)}`);
});
