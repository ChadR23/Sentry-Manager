'use strict';

// Footage on a share is not trusted: anyone who can write to the share can put
// a crafted MP4 there, and the converter parses it inside the server process.
// A small file must never make the parser allocate gigabytes or spin for
// minutes; it is refused quickly with an MP4 error instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const { box, fullBox, u32 } = require('./fixtures/fixtureBuilders');
const { parseMp4, findBoxes, selectVideoTrack, buildSampleIndex } = require('../src/main/converter/mp4');
const { describeLeadIn } = require('../src/main/converter/leadIn');

function mp4(sampleTable, mdats = [box('mdat', Buffer.alloc(16))]) {
  const tkhd = fullBox('tkhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(7)]));
  const hdlr = fullBox('hdlr', 0, 0, Buffer.concat([u32(0), Buffer.from('vide')]));
  const trak = box('trak', Buffer.concat([tkhd, box('mdia', Buffer.concat([hdlr, box('minf', box('stbl', Buffer.concat(sampleTable)))]))]));
  return Buffer.concat([box('moov', trak), ...mdats]);
}
const index = (buffer) => buildSampleIndex(selectVideoTrack(parseMp4(buffer)));
const stts = (count, duration = 1) => fullBox('stts', 0, 0, Buffer.concat([u32(1), u32(count), u32(duration)]));

test('a 200-byte file claiming 4 billion samples is refused, not allocated', () => {
  const file = mp4([
    fullBox('stsz', 0, 0, Buffer.concat([u32(1), u32(0xffffffff), u32(0)])),
    fullBox('stco', 0, 0, Buffer.concat([u32(1), u32(0)])),
    fullBox('stsc', 0, 0, Buffer.concat([u32(1), u32(1), u32(1), u32(1)])),
    stts(1)
  ]);
  assert.ok(file.length < 256);
  const before = process.memoryUsage().rss;
  assert.throws(() => index(file), (err) => err.code === 'INVALID_MP4' && /exceeds the file/.test(err.message));
  assert.ok(process.memoryUsage().rss - before < 200 * 1024 * 1024);
});

test('a sample-to-chunk table as long as the chunk table is read in linear time', () => {
  const N = 300000; // before: ~N^2/2 steps, minutes of a blocked server
  const offsets = Buffer.alloc(4 + N * 4);
  offsets.writeUInt32BE(N, 0);
  const stsc = Buffer.alloc(4 + N * 12);
  stsc.writeUInt32BE(N, 0);
  for (let i = 0; i < N; i += 1) {
    offsets.writeUInt32BE(0, 4 + i * 4);
    stsc.writeUInt32BE(i + 1, 4 + i * 12);
    stsc.writeUInt32BE(1, 8 + i * 12);
    stsc.writeUInt32BE(1, 12 + i * 12);
  }
  const file = mp4([fullBox('stsz', 0, 0, Buffer.concat([u32(1), u32(N), u32(0)])), fullBox('stco', 0, 0, offsets), fullBox('stsc', 0, 0, stsc), stts(N - 1)]);
  const started = Date.now();
  assert.throws(() => index(file), /stts sample count does not match/);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test('many samples across many mdat boxes are checked without samples x boxes work', () => {
  const N = 100000;
  // one 1-byte sample per chunk, each chunk in its own 9-byte mdat
  const moovFor = (base) => {
    const offsets = Buffer.alloc(4 + N * 4);
    offsets.writeUInt32BE(N, 0);
    for (let i = 0; i < N; i += 1) offsets.writeUInt32BE(base + i * 9 + 8, 4 + i * 4);
    return mp4([
      fullBox('stsz', 0, 0, Buffer.concat([u32(1), u32(N), u32(0)])),
      fullBox('stco', 0, 0, offsets),
      fullBox('stsc', 0, 0, Buffer.concat([u32(1), u32(1), u32(1), u32(1)])),
      stts(N)
    ], []);
  };
  const base = moovFor(0).length;
  const mdats = Array.from({ length: N }, () => box('mdat', Buffer.alloc(1)));
  const file = Buffer.concat([moovFor(base), ...mdats]);
  const started = Date.now();
  const samples = index(file);
  assert.equal(samples.length, N);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  // a sample that starts in one mdat's header is still refused
  const bad = Buffer.from(file);
  const tree = parseMp4(bad);
  const [stco] = findBoxes(tree, 'stco');
  bad.writeUInt32BE(base + 9, Number(stco.contentStart) + 8);
  assert.throws(() => index(bad), /outside mdat/);
});

test('a lead-in with a very long sync-sample table does not overflow the stack', () => {
  const N = 300000;
  const stss = Buffer.alloc(4 + N * 4);
  stss.writeUInt32BE(N, 0);
  for (let i = 0; i < N; i += 1) stss.writeUInt32BE(i + 2, 4 + i * 4);
  const file = mp4([fullBox('stss', 0, 0, stss)]);
  const track = selectVideoTrack(parseMp4(file));
  const samples = Array.from({ length: N + 1 }, (_, i) => ({ pts: BigInt(i), duration: 1n }));
  const leadIn = describeLeadIn(file, track, samples, 30000);
  assert.equal(leadIn.frames, 1);
});
