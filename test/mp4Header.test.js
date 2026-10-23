'use strict';

// Discovery tells converted clips from originals by the MP4 header alone: the
// box headers, then only the moov box (at the start or the end of the file),
// then the first video sample entry. Anything it cannot read is left to the
// normal path (null), never guessed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readMp4VideoCodec, readVideoSampleEntry, codecForSampleEntry } = require('../src/main/converter/mp4Header');
const { createTeslaH264Fixture } = require('./fixtures/ffmpegFixtures');

const encoderList = spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString() || '';
const hasEncoder = (name) => new RegExp(`\\s${name.replace(/[-]/g, '\\-')}\\s`).test(encoderList);
const av1Encoder = ['libsvtav1', 'libaom-av1'].find(hasEncoder) || null;
const noFfmpeg = encoderList ? false : 'needs ffmpeg';

function encode(file, encoder, extra = [], source = 'testsrc2=size=320x240:rate=12:duration=1') {
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', source,
    '-c:v', encoder,
    ...(encoder === 'libx265' ? ['-preset', 'ultrafast', '-x265-params', 'log-level=error'] : []),
    ...(encoder === 'libsvtav1' ? ['-preset', '12'] : []),
    ...(encoder === 'libaom-av1' ? ['-cpu-used', '8'] : []),
    '-pix_fmt', 'yuv420p', ...extra, file
  ]);
  assert.equal(result.status, 0, result.stderr?.toString());
  return file;
}

// The top-level box types in order, read the slow way, so a test can say
// where the moov box sits.
function topBoxes(file) {
  const bytes = fs.readFileSync(file);
  const types = [];
  for (let at = 0; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(at);
    types.push(bytes.toString('latin1', at + 4, at + 8));
    if (size < 8) break;
    at += size;
  }
  return types;
}

// An fs whose reads are counted (calls and bytes).
function countingFs() {
  const counts = { opens: 0, reads: 0, bytes: 0 };
  const wrapped = Object.create(fsp);
  wrapped.open = async (...args) => {
    counts.opens += 1;
    const handle = await fsp.open(...args);
    return {
      stat: (...a) => handle.stat(...a),
      close: () => handle.close(),
      read: async (...a) => {
        counts.reads += 1;
        const result = await handle.read(...a);
        counts.bytes += result.bytesRead;
        return result;
      }
    };
  };
  return { fs: wrapped, counts };
}

let dir;
test.before(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mp4hdr-')); });
test.after(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

test('a Tesla-style H.264 original reads as avc1 and is kept', { skip: noFfmpeg, timeout: 60_000 }, async () => {
  const file = path.join(dir, '2026-10-20_07-43-00-front.mp4');
  await createTeslaH264Fixture({
    ffmpegPath: 'ffmpeg', outputPath: file, durationSeconds: 2, frameRate: 12, size: '320x240',
    telemetryPattern: Array.from({ length: 24 }, (_, n) => Buffer.from([0x20, n]))
  });
  assert.equal(await readVideoSampleEntry(file), 'avc1');
  assert.equal(await readMp4VideoCodec(file), 'h264');
  // with its size known (discovery already has it) there is no extra stat
  assert.equal(await readMp4VideoCodec(file, { size: fs.statSync(file).size }), 'h264');
});

test('H.264 and H.265 with the moov at the end or the start', { skip: noFfmpeg || !hasEncoder('libx265') && 'needs libx265', timeout: 60_000 }, async () => {
  const cases = [
    ['libx264', [], 'avc1', 'h264', 'end'],
    ['libx264', ['-movflags', '+faststart'], 'avc1', 'h264', 'start'],
    ['libx265', ['-tag:v', 'hvc1'], 'hvc1', 'h265', 'end'],
    ['libx265', ['-tag:v', 'hvc1', '-movflags', '+faststart'], 'hvc1', 'h265', 'start'],
    ['libx265', ['-tag:v', 'hev1'], 'hev1', 'h265', 'end']
  ];
  for (const [encoder, extra, entry, codec, where] of cases) {
    const file = encode(path.join(dir, `${encoder}-${extra.join('')}.mp4`), encoder, extra);
    const boxes = topBoxes(file);
    assert.equal(boxes.indexOf('moov') < boxes.indexOf('mdat'), where === 'start', `${file}: moov at the ${where} (${boxes})`);
    assert.equal(await readVideoSampleEntry(file), entry, `${encoder} ${extra.join(' ')}`);
    assert.equal(await readMp4VideoCodec(file), codec, `${encoder} ${extra.join(' ')}`);
  }
});

test('AV1 reads as av01', { skip: noFfmpeg || !av1Encoder && 'needs an AV1 encoder (libsvtav1 or libaom-av1)', timeout: 120_000 }, async () => {
  for (const extra of [[], ['-movflags', '+faststart']]) {
    const file = encode(path.join(dir, `av1-${extra.length}.mp4`), av1Encoder, extra);
    assert.equal(await readVideoSampleEntry(file), 'av01');
    assert.equal(await readMp4VideoCodec(file), 'av1');
  }
});

test('only the box headers and the moov are read, never the video data', { skip: noFfmpeg, timeout: 60_000 }, async () => {
  // A few MB of media data in front of the moov box (the default layout).
  const file = encode(path.join(dir, 'big.mp4'), 'libx264', ['-preset', 'ultrafast', '-crf', '1'],
    'testsrc2=size=640x480:rate=12:duration=3,noise=alls=60:allf=t');
  const size = fs.statSync(file).size;
  assert.ok(size > 2 * 1024 * 1024, `fixture is ${size} bytes`);
  assert.deepEqual(topBoxes(file).slice(-1), ['moov']);
  const { fs: counted, counts } = countingFs();
  assert.equal(await readMp4VideoCodec(file, { fs: counted, size }), 'h264');
  assert.equal(counts.opens, 1);
  assert.ok(counts.reads <= 2 && counts.bytes < 64 * 1024, `${counts.reads} reads, ${counts.bytes} of ${size} bytes`);
});

test('cut off, damaged or not an MP4: null, so the normal path decides', { skip: noFfmpeg, timeout: 60_000 }, async () => {
  const atEnd = encode(path.join(dir, 'whole-end.mp4'), 'libx264');
  const atStart = encode(path.join(dir, 'whole-start.mp4'), 'libx264', ['-movflags', '+faststart']);
  const end = fs.readFileSync(atEnd);
  const start = fs.readFileSync(atStart);
  const write = (name, bytes) => { const file = path.join(dir, name); fs.writeFileSync(file, bytes); return file; };
  const moovAt = (bytes) => bytes.indexOf(Buffer.from('moov')) - 4;
  const cases = {
    // still being written / power cut: no moov yet
    'cut-before-moov.mp4': end.subarray(0, Math.floor(end.length / 2)),
    'cut-inside-moov.mp4': end.subarray(0, moovAt(end) + 64),
    'cut-inside-faststart-moov.mp4': start.subarray(0, moovAt(start) + 64),
    'only-ftyp.mp4': end.subarray(0, end.readUInt32BE(0)),
    'empty.mp4': Buffer.alloc(0),
    'junk.mp4': Buffer.from('not a video at all, just some bytes in a file'),
    'zeros.mp4': Buffer.alloc(4096),
    // a box that claims to be larger than the file
    'oversized-box.mp4': Buffer.concat([Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.from('ftyp'), Buffer.alloc(32)])
  };
  // the sample entry type overwritten with garbage: an unknown codec
  // (stsd: type, version/flags, entry count, entry size, then the entry type)
  const damaged = Buffer.from(start);
  damaged.write('xyz1', damaged.indexOf(Buffer.from('stsd')) + 16, 'latin1');
  cases['unknown-entry.mp4'] = damaged;
  for (const [name, bytes] of Object.entries(cases)) {
    const file = write(name, bytes);
    assert.equal(await readMp4VideoCodec(file), null, name);
  }
  assert.equal(await readVideoSampleEntry(path.join(dir, 'unknown-entry.mp4')), 'xyz1');
  // a moov larger than the cap is not read at all
  assert.equal(await readMp4VideoCodec(atStart, { maxMoovBytes: 64 }), null);
  assert.equal(codecForSampleEntry('mp4v'), null);
  assert.equal(codecForSampleEntry('toString'), null);
});

test('a missing file or a share error is thrown (the caller waits for the share); a cancel stops it', async () => {
  await assert.rejects(readMp4VideoCodec(path.join(dir, 'missing.mp4')), { code: 'ENOENT' });
  const down = Object.create(fsp);
  down.open = async () => { throw Object.assign(new Error('host is down'), { code: 'EHOSTDOWN' }); };
  await assert.rejects(readMp4VideoCodec('/share/clip.mp4', { fs: down }), { code: 'EHOSTDOWN' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readMp4VideoCodec('/share/clip.mp4', { signal: controller.signal }), { code: 'CANCELLED' });
});
