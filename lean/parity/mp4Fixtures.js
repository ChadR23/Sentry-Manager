'use strict';

// Writes MP4 fixtures into <dir> and what the Node implementation reads from
// each into <dir>/expected.json, for the lean backend's parity tests
// (lean/tests/mp4_parity.rs):
//
//   codec    server/mp4codec.js videoCodec
//   samples  server/speedReader.js readSamples
//   speeds   server/speedReader.js readSpeeds
//   summary  server/speedIndex.js summarize of those samples (what the speed index keeps)
//   info     src/main/converter/mp4.js: the video track's sample index,
//            timescale, durations and sync samples (keyframes)
//   records  server/telemetry.js readRecords (Studio's parser): every record with its time
//   index    what server/speedIndex.js keeps for the clip, [speeds, summary]: the quick
//            read, else the full read (the fallback-* fixtures are made for that)
//
// A call that throws is recorded as { error: true }.
//
//   node lean/parity/mp4Fixtures.js <dir>

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const B = require(path.join(REPO, 'test/fixtures/fixtureBuilders'));
const { parseMp4, findBoxes, selectVideoTrack, buildSampleIndex } = require(path.join(REPO, 'src/main/converter/mp4'));
const { injectAv1Telemetry } = require(path.join(REPO, 'src/main/converter/av1Telemetry'));
const { readSamples, readSpeeds } = require(path.join(REPO, 'server/speedReader'));
const { videoCodec } = require(path.join(REPO, 'server/mp4codec'));
const { summarize, createSpeedIndex } = require(path.join(REPO, 'server/speedIndex'));
const { Telemetry, loadParser, readRecords: readTelemetry } = require(path.join(REPO, 'server/telemetry'));
const { record, drivePattern, teslaH264, converted, plain } = require('./clips');

const dir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('usage: node lean/parity/mp4Fixtures.js <dir>');
  process.exit(2);
}

/** The video track as mp4.js reads it (whole file in memory: fixtures are small). */
function info(file) {
  const buf = fs.readFileSync(file);
  const tree = parseMp4(buf);
  const track = selectVideoTrack(tree);
  const samples = buildSampleIndex(track);
  const mdhd = findBoxes(track, 'mdhd')[0];
  const md = buf.subarray(Number(mdhd.contentStart), Number(mdhd.end));
  const v1 = md[0] === 1;
  const timescale = v1 ? md.readUInt32BE(20) : md.readUInt32BE(12);
  const mdhdDuration = v1 ? Number(md.readBigUInt64BE(24)) : md.readUInt32BE(16);
  const stsd = findBoxes(track, 'stsd')[0];
  const entry = buf.toString('ascii', Number(stsd.contentStart) + 12, Number(stsd.contentStart) + 16);
  // stss as src/main/converter/leadIn.js reads it: null = every sample is a keyframe
  const stss = findBoxes(track, 'stss')[0];
  let keyframes = null;
  if (stss) {
    const p = buf.subarray(Number(stss.contentStart), Number(stss.end));
    keyframes = Array.from({ length: p.readUInt32BE(4) }, (_, i) => p.readUInt32BE(8 + i * 4));
  }
  const ticks = samples.reduce((n, s) => n + s.duration, 0n);
  return {
    trackId: track.id, entry, timescale, mdhdDuration, durationTicks: Number(ticks), duration: Number(ticks) / timescale,
    keyframes,
    samples: samples.map((s) => [Number(s.offset), s.size, Number(s.dts), Number(s.pts), Number(s.duration), s.sampleDescriptionIndex])
  };
}

async function attempt(fn) {
  try {
    return await fn();
  } catch {
    return { error: true };
  }
}

const sei = (fields) => B.teslaSeiNal(record(fields));
const picture = (n, idr = false) => Buffer.concat([Buffer.from([idr ? 0x65 : 0x41]), Buffer.alloc(40 + (n % 7), 0x11 + (n % 5))]);

async function main() {
  fs.mkdirSync(dir, { recursive: true });
  const cases = [];
  const add = (name, bytes) => {
    fs.writeFileSync(path.join(dir, name), bytes);
    cases.push(name);
  };
  const made = (name) => cases.push(name);

  // ---- real encodes (ffmpeg)
  const h264 = path.join(dir, 'tesla-h264.mp4');
  await teslaH264(h264, { pattern: drivePattern(48, { gap: [24, 36] }) });
  made('tesla-h264.mp4');
  await teslaH264(path.join(dir, 'tesla-h264-long.mp4'), { seconds: 7, fps: 10, pattern: drivePattern(70, { fps: 10, seed: 1 }) });
  made('tesla-h264-long.mp4');
  const full = path.join(dir, 'tesla-src.mp4');
  await teslaH264(full, { pattern: drivePattern(48, { seed: 0.3 }) });
  made('tesla-src.mp4');
  if (await converted(full, path.join(dir, 'tesla-h265.mp4'), 'h265')) made('tesla-h265.mp4');
  if (await converted(full, path.join(dir, 'tesla-av1.mp4'), 'av1')) made('tesla-av1.mp4');
  // B-frames (Smallest (CPU only)): stored out of the order shown
  if (await converted(path.join(dir, 'tesla-h264-long.mp4'), path.join(dir, 'tesla-h265-bframes.mp4'), 'h265', { smallest: true })) made('tesla-h265-bframes.mp4');
  for (const [name, enc, faststart] of [['plain-h264-moov-end.mp4', 'libx264', false], ['plain-h264-fast.mp4', 'libx264', true],
    ['plain-h265.mp4', 'libx265', false], ['plain-av1.mp4', 'libsvtav1', false]]) {
    if (await plain(path.join(dir, name), enc, { faststart })) made(name);
  }

  // ---- synthetic files (test/fixtures/fixtureBuilders.js)
  const frames = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
  for (const lengthSize of [1, 2, 4]) {
    add(`syn-h264-len${lengthSize}.mp4`, B.h264Mp4({
      lengthSize,
      samples: frames(90, (i) => B.lengthPrefixedSample([B.unrelatedSeiNal(), sei({ frame: i, speed: i / 3, lat: 52.5 + i * 1e-6, lon: 13.4, ax: -0.5, ay: 0.25 }), picture(i, i % 30 === 0)], lengthSize))
    }));
  }
  // the picture before the record: no record for that frame
  add('syn-h264-picture-first.mp4', B.h264Mp4({
    samples: frames(60, (i) => B.lengthPrefixedSample(i % 30 === 0 ? [picture(i, true), sei({ speed: 9 })] : [sei({ speed: 4 + i / 10 }), picture(i)]))
  }));
  // a record past the first 4 KB of its frame: read again whole
  add('syn-h264-late-record.mp4', B.h264Mp4({
    samples: frames(30, (i) => B.lengthPrefixedSample([B.unrelatedSeiNal(Buffer.alloc(5000, 0x22)), sei({ speed: 7.25 }), picture(i)]))
  }));
  // timing: B-frame style composition offsets, irregular durations, 90 kHz
  add('syn-h264-ctts.mp4', B.h264Mp4({
    timescale: 90_000,
    durations: frames(45, (i) => 3000 + (i % 3) * 7),
    compositionOffsets: frames(45, (i) => (i % 2 ? -1500 : 3000)),
    samples: frames(45, (i) => B.lengthPrefixedSample([sei({ speed: 20 - i / 5, ax: -6.5 }), picture(i)]))
  }));
  // no records at all, and records without a speed: readSamples gives null
  add('syn-h264-no-records.mp4', B.h264Mp4({ samples: frames(30, (i) => B.lengthPrefixedSample([picture(i)])) }));
  add('syn-h264-no-speed.mp4', B.h264Mp4({ samples: frames(30, (i) => B.lengthPrefixedSample([sei({ lat: 1, lon: 2 }), picture(i)])) }));
  // a varint that runs long, a truncated double: read as far as it goes
  add('syn-h264-odd-records.mp4', B.h264Mp4({
    samples: frames(60, (i) => B.lengthPrefixedSample([B.teslaSeiNal(i < 30
      ? Buffer.from([0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 0x25, 0x00, 0x00, 0x40, 0x41])
      : Buffer.from([0x25, 0xcd, 0xcc, 0x4c, 0x41, 0x59, 0x01, 0x02])), picture(i)]))
  }));

  // H.265: compatibility records (66 01 …), several chunks, co64, extended boxes, an audio track
  const hevcSample = (i, lengthSize) => {
    const h264Sei = sei({ frame: i, speed: 3 + i / 4, lat: 48.1, lon: 11.5, ax: 0.75, ay: -1.5 });
    const compat = Buffer.concat([Buffer.from([0x66, 0x01]), h264Sei.subarray(2)]);
    return B.lengthPrefixedSample([B.hevcNal(39, Buffer.from([0x05, 0x02, 0x11, 0x22])), compat, B.hevcNal(i % 30 ? 1 : 19, Buffer.alloc(30, 0x33))], lengthSize);
  };
  add('syn-h265.mp4', B.h265Mp4({ samples: frames(60, (i) => hevcSample(i, 4)) }));
  add('syn-h265-chunks-co64.mp4', B.h265Mp4({
    lengthSize: 3, samples: frames(60, (i) => hevcSample(i, 3)), chunks: [10, 20, 30], co64: true, chunkPadding: 17,
    extendedMoov: true, extendedMdat: true, extendedHvcc: true, audioSamples: frames(5, () => Buffer.alloc(9, 0x44))
  }));
  // (extendedHvcc above moves the length size where speedReader.js does not look: it fails,
  // the same on both sides; this one reads)
  add('syn-h265-co64.mp4', B.h265Mp4({
    lengthSize: 3, samples: frames(60, (i) => hevcSample(i, 3)), chunks: [10, 20, 30], co64: true, chunkPadding: 17,
    extendedMoov: true, extendedMdat: true, audioSamples: frames(5, () => Buffer.alloc(9, 0x44))
  }));
  add('syn-hev1.mp4', B.h265Mp4({ sampleEntry: 'hev1', samples: frames(30, (i) => hevcSample(i, 4)) }));

  // AV1: the records in a first mdat, each frame's ended by a picture marker
  const av1Samples = frames(45, (i) => Buffer.from([0x12, 0x00, 0x32, 0x05, i & 0xff, 1, 2, 3, 4]));
  const timeline = (n, fn) => frames(n, (i) => ({ pictureMarker: true, seiNals: fn(i).map((nal) => ({ nal })) }));
  add('syn-av1.mp4', injectAv1Telemetry(B.av1Mp4({ samples: av1Samples }), timeline(45, (i) => (i >= 15 && i < 30 ? [] : [sei({ speed: 10 + i, lat: 35.6, lon: 139.7 })]))));
  add('syn-av1-moov-end.mp4', injectAv1Telemetry(B.av1Mp4({ samples: av1Samples, moovAfterMdat: true, chunks: [20, 25] }), timeline(45, (i) => [sei({ speed: 1 + i / 2 })])));
  add('syn-av1-no-carrier.mp4', B.av1Mp4({ samples: av1Samples }));

  // ---- what must fail (or fall back) the same way
  add('bad-junk.mp4', Buffer.from('not a video at all'));
  add('bad-empty.mp4', Buffer.alloc(0));
  const good = fs.readFileSync(path.join(dir, 'syn-h264-len4.mp4'));
  add('bad-cut-header.mp4', good.subarray(0, 64));
  add('bad-cut-media.mp4', good.subarray(0, good.length - 500));
  add('bad-fragmented.mp4', Buffer.concat([good, B.box('moof', Buffer.alloc(8))]));
  add('bad-size-zero.mp4', Buffer.concat([good, Buffer.from([0, 0, 0, 0]), Buffer.from('free'), Buffer.alloc(4)]));
  add('bad-zero-nal.mp4', B.h264Mp4({ samples: frames(10, () => Buffer.concat([Buffer.alloc(4), picture(1)])) }));
  add('bad-no-video.mp4', B.box('moov', B.track([B.stco([0])], 3, 'soun')));
  const twoTracks = B.box('moov', Buffer.concat([B.track([], 1), B.track([], 2)]));
  add('bad-two-video.mp4', twoTracks);
  // a sample that points past its mdat
  const shifted = Buffer.from(good);
  const stcoAt = shifted.indexOf(Buffer.from('stco')) + 12;
  shifted.writeUInt32BE(shifted.readUInt32BE(stcoAt) + 100000, stcoAt);
  add('bad-outside-mdat.mp4', shifted);
  // stsz says more samples than stts
  const counts = Buffer.from(good);
  const sttsAt = counts.indexOf(Buffer.from('stts')) + 12;
  counts.writeUInt32BE(counts.readUInt32BE(sttsAt) + 1, sttsAt);
  add('bad-stts-count.mp4', counts);
  // timescale 0
  const noScale = Buffer.from(good);
  const mdhdAt = noScale.indexOf(Buffer.from('mdhd')) + 4;
  noScale.writeUInt32BE(0, mdhdAt + 12);
  add('bad-timescale.mp4', noScale);

  // ---- the quick read gives up, the full read (telemetry.js) does not: the speed index's fallback
  // more than 64 top-level boxes (speedReader.js stops there; the parser reads on)
  const frees = Buffer.concat(Array.from({ length: 70 }, () => B.box('free', Buffer.alloc(4))));
  for (const src of ['tesla-src.mp4', 'tesla-h265.mp4', 'tesla-av1.mp4', 'tesla-h264-long.mp4', 'syn-h264-len2.mp4', 'syn-h264-ctts.mp4', 'syn-h264-odd-records.mp4', 'syn-h264-no-speed.mp4', 'syn-h265.mp4', 'syn-av1.mp4']) {
    if (cases.includes(src)) add(`fallback-${src}`, Buffer.concat([fs.readFileSync(path.join(dir, src)), frees]));
  }
  // an edit list the quick read does not take, records in every frame
  const edts = Buffer.from(fs.readFileSync(path.join(dir, 'syn-h264-len4.mp4')));
  const trakAt = edts.indexOf(Buffer.from('trak')) - 4;
  if (trakAt > 0) {
    const elst = B.fullBox('elst', 0, 0, Buffer.concat([B.u32(1), B.u32(3000), B.u32(1500), B.u32(0x10000)]));
    const edtsBox = B.box('edts', elst);
    const moovAt = edts.indexOf(Buffer.from('moov')) - 4;
    const grow = (buf, at) => buf.writeUInt32BE(buf.readUInt32BE(at) + edtsBox.length, at);
    grow(edts, moovAt);
    grow(edts, trakAt);
    // (the moov comes first here: the media moves along)
    const withEdts = Buffer.concat([edts.subarray(0, trakAt + 8), edtsBox, edts.subarray(trakAt + 8)]);
    const stco = withEdts.indexOf(Buffer.from('stco')) + 12;
    if (moovAt < withEdts.indexOf(Buffer.from('mdat'))) {
      for (let i = 0, n = withEdts.readUInt32BE(stco - 4); i < n; i++) withEdts.writeUInt32BE(withEdts.readUInt32BE(stco + i * 4) + edtsBox.length, stco + i * 4);
    }
    add('fallback-edit-list.mp4', withEdts);
  }
  // cut short: both reads fail
  add('fallback-cut.mp4', Buffer.concat([fs.readFileSync(path.join(dir, 'syn-h264-len4.mp4')), frees]).subarray(0, 3000));

  const Reader = loadParser(path.join(REPO, 'src'));
  const index = speedIndex(dir);
  const expected = {};
  for (const name of cases) {
    const file = path.join(dir, name);
    const samples = await attempt(() => readSamples(file));
    // the dashboard's read: every record with its time (hex here), or a note
    const records = await attempt(async () => {
      const out = await readTelemetry(Reader, file, fs.statSync(file).size);
      return JSON.parse(out.body).frames.map(([t, b64]) => [t, Buffer.from(b64, 'base64').toString('hex')]);
    });
    expected[name] = {
      codec: await attempt(() => videoCodec(file)),
      samples,
      summary: Array.isArray(samples) ? summarize(samples) : null,
      speeds: await attempt(() => readSpeeds(file)),
      info: await attempt(() => info(file)),
      records,
      // what the speed index keeps for the clip: [speeds, summary] (speedIndex.js speedsFor)
      index: await index.entry(file)
    };
  }
  fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify(expected, null, 1));
  console.log(`${cases.length} fixtures in ${dir}`);
}

/**
 * The speed index itself (server/speedIndex.js, its full read in a worker as on the server)
 * on one clip at a time: clip() indexes it, flush() writes the day, the entry is read back.
 */
function speedIndex(dir) {
  const work = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lean-index-'));
  const files = new Map();
  const index = createSpeedIndex({
    dir: path.join(work, 'speeds'),
    inventory: { get: () => ({ files }) },
    vehicles: { list: () => [], rootOf: () => dir },
    telemetry: new Telemetry({ srcRoot: path.join(REPO, 'src'), cacheDir: path.join(work, 'telemetry') }),
    log: null
  });
  let n = 0;
  return {
    async entry(file) {
      const st = fs.statSync(file);
      const rel = `RecentClips/2025-01-01_00-00-${String(n++ % 60).padStart(2, '0')}-front.mp4`;
      files.set(rel, { rel, day: '2025-01-01', camera: 'front', kind: 'clip', size: st.size, mtimeMs: st.mtimeMs });
      await index.clip('v', rel, file, st.size, st.mtimeMs);
      await index.flush();
      const day = JSON.parse(fs.readFileSync(path.join(work, 'speeds', 'v', '2025-01-01.json'), 'utf8'));
      return day[rel].slice(2);
    }
  };
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
