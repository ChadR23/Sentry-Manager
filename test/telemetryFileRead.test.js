'use strict';

// The dashboard's telemetry read gives the parser the file a few KB at a time
// instead of the whole clip: the same records, timestamps and notes as reading
// the whole clip, with memory that does not grow with the clip.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadParser, readRecords } = require('../server/telemetry');
const {
  h264Mp4, h265Mp4, av1Mp4, hevcNal, teslaSeiNal, lengthPrefixedSample, unrelatedSeiNal
} = require('./fixtures/fixtureBuilders');

const SRC = path.join(__dirname, '..', 'src');
const Reader = loadParser(SRC);
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** The read as it was: the whole clip in memory, then the parser. */
function wholeRead(real) {
  const buf = fs.readFileSync(real);
  const bytes = new Uint8Array(new ArrayBuffer(buf.length));
  bytes.set(buf);
  let frames = [];
  let note = null;
  try {
    frames = new Reader(bytes.buffer).parseFrames(null);
  } catch (err) {
    note = `No telemetry in ${path.basename(real)}: ${err.message}`;
  }
  const records = [];
  for (const f of frames) for (const [t, sei] of Reader.recordsOf(f)) records.push([t, Buffer.from(sei).toString('base64')]);
  return { body: JSON.stringify({ v: 1, frames: records }), note };
}

async function same(file, label = path.basename(file)) {
  const want = wholeRead(file);
  const got = await readRecords(Reader, file, fs.statSync(file).size);
  assert.deepEqual(got, want, label);
  return got;
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// a record with gear, frame and speed, as the car writes it
function record(n) {
  const f = Buffer.alloc(4);
  f.writeFloatLE(0.3 + n / 2);
  return Buffer.concat([Buffer.from([0x10, 0x01, 0x18, n & 0x7f, 0x25]), f]);
}

function noise(n, seed) {
  const out = Buffer.alloc(n);
  let x = seed * 2654435761 >>> 0;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; out[i] = x >>> 24; }
  return out;
}

function h264Samples(count, pictureBytes, lengthSize = 4) {
  return Array.from({ length: count }, (_, i) => {
    const nals = [];
    if (i % 10 === 0) nals.push(Buffer.from([0x67, 0x64, 0x00, 0x1f, i]), Buffer.from([0x68, 0xee, 0x3c, 0x80]));
    if (i % 7 === 3) nals.push(unrelatedSeiNal(Buffer.from([0x05, 0x02, 0x11, 0x22])));
    // frames 20-29 without a record; one record with an emulation byte run
    if (i < 20 || i >= 30) nals.push(teslaSeiNal(i === 5 ? Buffer.from([0x10, 0x00, 0x00, 0x03, 0x01]) : record(i)));
    nals.push(Buffer.concat([Buffer.from([i % 10 === 0 ? 0x65 : 0x41]), noise(pictureBytes, i)]));
    return lengthPrefixedSample(nals, lengthSize);
  });
}

function h265Samples(count, pictureBytes) {
  return Array.from({ length: count }, (_, i) => {
    const nals = [hevcNal(35, Buffer.from([0x50]))];
    if (i % 10 === 0) nals.push(hevcNal(32, Buffer.from([1, 2, 3, 4])), hevcNal(33, Buffer.from([5, 6, 7])), hevcNal(34, Buffer.from([8, 9])));
    if (i % 4 !== 1) nals.push(Buffer.concat([Buffer.from([0x66, 0x01]), teslaSeiNal(record(i)).subarray(2)]));
    nals.push(Buffer.concat([hevcNal(i % 10 === 0 ? 19 : 1), noise(pictureBytes, i)]));
    nals.push(Buffer.from([0x61, 0x01, 0x80]));
    return lengthPrefixedSample(nals, 4);
  });
}

test('telemetry read: built H.264 clips (timing, length sizes, records) read the same as the whole clip', async (t) => {
  const dir = tmpDir(t);
  const cases = {
    plain: h264Mp4({ samples: h264Samples(40, 3000) }),
    // 29.97 fps with B-frame reordering and a 2-byte NAL length
    ctts: h264Mp4({
      samples: h264Samples(40, 9000, 2), lengthSize: 2, timescale: 30_000,
      durations: Array.from({ length: 40 }, (_, i) => (i % 3 ? 1001 : 1002)),
      compositionOffsets: Array.from({ length: 40 }, (_, i) => [2002, -1001, 0][i % 3])
    }),
    oneByte: h264Mp4({ samples: h264Samples(30, 200, 1), lengthSize: 1, timescale: 90_000, durations: Array(30).fill(3003) }),
    noRecords: h264Mp4({ samples: Array.from({ length: 12 }, (_, i) => lengthPrefixedSample([Buffer.concat([Buffer.from([0x65]), noise(5000, i)])])) })
  };
  for (const [name, bytes] of Object.entries(cases)) {
    const file = path.join(dir, `${name}.mp4`);
    fs.writeFileSync(file, bytes);
    const out = await same(file, name);
    if (name === 'noRecords') assert.deepEqual(JSON.parse(out.body).frames, []);
    else assert.ok(JSON.parse(out.body).frames.length > 10, name);
  }
});

test('telemetry read: built H.265 and AV1 layouts read the same as the whole clip', async (t) => {
  const dir = tmpDir(t);
  const samples = h265Samples(36, 6000);
  const cases = {
    hevc: h265Mp4({ samples }),
    hevcChunks: h265Mp4({ samples, chunks: [10, 10, 16], chunkPadding: 333, co64: true, extendedMoov: true, extendedMdat: true, audioSamples: [Buffer.alloc(50, 1), Buffer.alloc(70, 2)] }),
    hevcTiming: h265Mp4({ samples, timescale: 10_000, durations: Array.from({ length: 36 }, (_, i) => 270 + (i % 5)), compositionOffsets: Array.from({ length: 36 }, (_, i) => (i % 2) * 300) }),
    // a frame with two markers: the parser's marker count check
    hevcMarkers: h265Mp4({ samples: samples.map((s, i) => (i === 7 ? Buffer.concat([s, lengthPrefixedSample([Buffer.from([0x61, 0x01, 0x80])])]) : s)) }),
    // not a converted clip's carrier layout: the AV1 checks' notes
    av1NoCarrier: av1Mp4({ samples: Array.from({ length: 8 }, (_, i) => noise(4000, i)) }),
    av1MoovLast: av1Mp4({ samples: Array.from({ length: 8 }, (_, i) => noise(4000, i)), moovAfterMdat: true })
  };
  for (const [name, bytes] of Object.entries(cases)) {
    const file = path.join(dir, `${name}.mp4`);
    fs.writeFileSync(file, bytes);
    await same(file, name);
  }
});

test('telemetry read: a converted clip gives every record of its original, the closing one too', async (t) => {
  const dir = tmpDir(t);
  // the original: 36 pictures and Tesla's closing zero-length sample, each with its own record
  const n = 36;
  const durations = [...Array(n).fill(1000), 0];
  const original = h264Mp4({
    samples: Array.from({ length: n + 1 }, (_, i) => lengthPrefixedSample([
      ...(i === 0 ? [Buffer.from([0x67, 0x64, 0x00, 0x1f, 1]), Buffer.from([0x68, 0xee, 0x3c, 0x80])] : []),
      teslaSeiNal(record(i)), Buffer.concat([Buffer.from([i === 0 ? 0x65 : 0x41]), noise(500, i)])
    ])),
    durations
  });
  // converted: the closing sample has no picture, so its record rides on the last picture, after that picture's own
  const converted = h265Mp4({
    samples: Array.from({ length: n }, (_, i) => lengthPrefixedSample([
      hevcNal(35, Buffer.from([0x50])),
      ...(i === 0 ? [hevcNal(32, Buffer.from([1, 2, 3, 4])), hevcNal(33, Buffer.from([5, 6, 7])), hevcNal(34, Buffer.from([8, 9]))] : []),
      Buffer.concat([Buffer.from([0x66, 0x01]), teslaSeiNal(record(i)).subarray(2)]),
      ...(i === n - 1 ? [Buffer.concat([Buffer.from([0x66, 0x01]), teslaSeiNal(record(n)).subarray(2)])] : []),
      Buffer.concat([hevcNal(i === 0 ? 19 : 1), noise(500, i)]),
      Buffer.from([0x61, 0x01, 0x80])
    ], 4)),
    durations: Array(n).fill(1000)
  });
  const a = path.join(dir, 'original.mp4');
  const b = path.join(dir, 'converted.mp4');
  fs.writeFileSync(a, original);
  fs.writeFileSync(b, converted);
  const ra = JSON.parse((await same(a)).body).frames;
  const rb = JSON.parse((await same(b)).body).frames;
  assert.equal(ra.length, n + 1);
  assert.equal(rb.length, n + 1, 'the closing record is not dropped');
  assert.deepEqual(rb.map((x) => x[1]), ra.map((x) => x[1]), 'the same records, in order');
  assert.deepEqual(rb.map((x) => x[0]), ra.map((x) => x[0]), 'at the same times: the closing one a frame after the last picture');
  // the last picture still shows its own record
  const frames = new Reader(new Uint8Array(converted).buffer).parseFrames(null);
  assert.equal(Buffer.from(frames.at(-1).sei).toString('base64'), ra.at(-2)[1]);
});

test('telemetry read: damaged clips and other files give the same notes', async (t) => {
  const dir = tmpDir(t);
  const good = h264Mp4({ samples: h264Samples(30, 2000) });
  const cases = {
    empty: Buffer.alloc(0),
    junk: Buffer.alloc(1000, 7),
    moovOnly: good.subarray(0, 200),
    halfMdat: good.subarray(0, Math.floor(good.length / 2)),
    lastByte: good.subarray(0, good.length - 1)
  };
  // a zero NAL length inside a frame
  const zero = Buffer.from(good);
  zero.writeUInt32BE(0, zero.indexOf(Buffer.from([0x65])) - 4);
  cases.zeroNal = zero;
  // a NAL running past its frame (the last frame's picture ends the file)
  const long = Buffer.from(good);
  long.writeUInt32BE(1_000_000, long.length - 2001 - 4);
  cases.longNal = long;
  for (const [name, bytes] of Object.entries(cases)) {
    const file = path.join(dir, `${name}.mp4`);
    fs.writeFileSync(file, bytes);
    const out = await same(file, name);
    assert.ok(out.note, `${name} has a note`);
  }
});

test('telemetry read: a clip that shrinks while it is read fails as before', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, h264Mp4({ samples: h264Samples(30, 2000) }));
  const size = fs.statSync(file).size;
  fs.truncateSync(file, size - 500);
  await assert.rejects(readRecords(Reader, file, size), /changed while it was read/);
});

test('telemetry read: Tesla and converted clips from ffmpeg read the same as the whole clip', { skip: !hasFfmpeg && 'ffmpeg missing', timeout: 180_000 }, async (t) => {
  const { createTeslaH264Fixture, runProcess } = require('./fixtures/ffmpegFixtures');
  const { buildEncodeArgs } = require('../src/main/converter/encoderPlanner');
  const { extractH264TelemetryTimeline, mapTimelineToOutput } = require('../src/main/converter/telemetryTimeline');
  const { injectH265Telemetry } = require('../src/main/converter/h265Telemetry');
  const { injectAv1Telemetry } = require('../src/main/converter/av1Telemetry');
  const { outputTiming } = require('../src/main/converter/converterAdapters');
  const dir = tmpDir(t);
  const source = path.join(dir, 'source.mp4');
  const f = Buffer.alloc(4);
  const pattern = Array.from({ length: 48 }, (_, n) => { f.writeFloatLE(0.3 + n / 2); return Buffer.concat([Buffer.from([0x10, 0x01, 0x25]), f]); });
  await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: source, telemetryPattern: pattern, size: '160x120' });
  assert.ok(JSON.parse((await same(source)).body).frames.length === 48);

  const gaps = path.join(dir, 'gaps.mp4');
  await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: gaps, telemetryPattern: pattern.map((p, i) => (i % 5 === 2 ? null : p)), size: '160x120' });
  await same(gaps);
  const none = path.join(dir, 'none.mp4');
  await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: none, telemetryPattern: pattern.map(() => null), size: '160x120' });
  assert.deepEqual(JSON.parse((await same(none)).body).frames, []);
  const cut = path.join(dir, 'cut.mp4');
  const whole = fs.readFileSync(source);
  fs.writeFileSync(cut, whole.subarray(0, Math.floor(whole.length * 0.6)));
  assert.ok((await same(cut)).note);

  const timeline = extractH264TelemetryTimeline(fs.readFileSync(source));
  for (const [codec, encoder, inject] of [['h265', 'libx265', injectH265Telemetry], ['av1', 'libsvtav1', injectAv1Telemetry]]) {
    const encoded = path.join(dir, `${codec}.enc.mp4`);
    const r = await runProcess('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source, ...buildEncodeArgs({ codec, encoder, bitrate: 200_000 }), '-an', '-f', 'mp4', encoded]);
    if (r.status !== 0) { t.diagnostic(`${encoder} unavailable: ${r.stderr}`); continue; }
    const bytes = fs.readFileSync(encoded);
    const out = path.join(dir, `${codec}.mp4`);
    const converted = inject(bytes, mapTimelineToOutput(timeline, outputTiming(bytes)));
    fs.writeFileSync(out, converted);
    assert.equal(JSON.parse((await same(out, codec)).body).frames.length, 48, codec);
    // the plain encode (no records) and a cut one
    await same(encoded, `${codec} without records`);
    const cutOut = path.join(dir, `${codec}.cut.mp4`);
    fs.writeFileSync(cutOut, converted.subarray(0, converted.length - 300));
    await same(cutOut, `${codec} cut`);
  }
});

test('telemetry read: what is read does not grow with the size of the pictures', async (t) => {
  const dir = tmpDir(t);
  const small = path.join(dir, 'small.mp4');
  const big = path.join(dir, 'big.mp4');
  fs.writeFileSync(small, h264Mp4({ samples: h264Samples(400, 1000) }));
  fs.writeFileSync(big, h264Mp4({ samples: h264Samples(400, 160_000) })); // ~64 MB
  const counts = {};
  for (const [name, file] of [['small', small], ['big', big]]) {
    const stats = {};
    const out = await readRecords(Reader, file, fs.statSync(file).size, stats);
    assert.equal(JSON.parse(out.body).frames.length, 390);
    counts[name] = stats.bytesRead;
  }
  const bigSize = fs.statSync(big).size;
  assert.ok(counts.big < bigSize / 20, `read ${counts.big} of ${bigSize} bytes`);
  assert.ok(counts.big < counts.small * 4, `read ${counts.big} bytes of the big clip, ${counts.small} of the small one`);

  // and the reading process's peak memory stays about the same. On Linux the
  // peak is the child's own (VmHWM): its maxRSS also counts what this test
  // process held when the child was started (it can be the 64 MB clip just
  // made), so it sometimes came out ~120 MB higher for one of the two clips.
  const peak = (file) => {
    const code = `const t = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'telemetry'))});
      const R = t.loadParser(${JSON.stringify(SRC)});
      const own = () => { try { return Number(/^VmHWM:\\s+(\\d+) kB/m.exec(require('fs').readFileSync('/proc/self/status', 'utf8'))[1]); } catch { return null; } };
      t.readRecords(R, process.argv[1], require('fs').statSync(process.argv[1]).size)
        .then(() => console.log(own() ?? process.resourceUsage().maxRSS));`;
    const r = spawnSync(process.execPath, ['-e', code, file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return Number(r.stdout.trim()) * 1024;
  };
  const grew = peak(big) - peak(small);
  t.diagnostic(`peak memory grew ${Math.round(grew / 1024 / 1024)} MB from a ${Math.round(fs.statSync(small).size / 1024 / 1024)} MB clip to a ${Math.round(bigSize / 1024 / 1024)} MB one`);
  assert.ok(grew < 16 * 1024 * 1024, `peak memory grew ${grew} bytes`);
});
