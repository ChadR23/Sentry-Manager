'use strict';

// Tesla-like clips for the lean backend's parity checks, made with the
// repository's own fixture builders: an H.264 original with a telemetry
// record ahead of each picture (as the car writes it), and the same clip
// converted to H.265 and AV1 the way the converter does it (the records in
// compatibility NALs, or all together in a first mdat for AV1).

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const { createTeslaH264Fixture, runProcess } = require(path.join(REPO, 'test/fixtures/ffmpegFixtures'));
const { buildEncodeArgs } = require(path.join(REPO, 'src/main/converter/encoderPlanner'));
const { extractH264TelemetryTimeline, mapTimelineToOutput } = require(path.join(REPO, 'src/main/converter/telemetryTimeline'));
const { injectH265Telemetry } = require(path.join(REPO, 'src/main/converter/h265Telemetry'));
const { injectAv1Telemetry } = require(path.join(REPO, 'src/main/converter/av1Telemetry'));
const { outputTiming } = require(path.join(REPO, 'src/main/converter/converterAdapters'));

/** H.264 emulation prevention: 00 00 followed by 00..03 gets a 03 in between. */
function escape(raw) {
  const out = [];
  let zeros = 0;
  for (const b of raw) {
    if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

function varint(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

/**
 * A telemetry record as protobuf bytes, escaped for an SEI: gear (2), frame
 * (3), speed (4, float m/s), latitude / longitude (11, 12, double) and
 * acceleration along / across (14, 15, double). Left-out fields are absent.
 */
function record({ gear = 1, frame = 0, speed, lat, lon, ax, ay } = {}) {
  const parts = [Buffer.from([0x10]), varint(gear), Buffer.from([0x18]), varint(frame)];
  if (speed !== undefined) { const f = Buffer.alloc(4); f.writeFloatLE(speed); parts.push(Buffer.from([0x25]), f); }
  const dbl = (tag, v) => { if (v === undefined) return; const d = Buffer.alloc(8); d.writeDoubleLE(v); parts.push(Buffer.from([tag]), d); };
  dbl((11 << 3) | 1, lat);
  dbl((12 << 3) | 1, lon);
  dbl((14 << 3) | 1, ax);
  dbl((15 << 3) | 1, ay);
  return escape(Buffer.concat(parts));
}

/** One record per frame: a drive that speeds up, brakes, turns; `gap` frames have none. */
function drivePattern(frames, { fps = 12, gap = null, seed = 0 } = {}) {
  return Array.from({ length: frames }, (_, n) => {
    if (gap && n >= gap[0] && n < gap[1]) return null;
    const t = n / fps;
    const speed = n < frames / 2 ? 2 + t * 3 + seed : 2 + (frames / 2 / fps) * 3 + seed - (t - frames / 2 / fps) * 6;
    return record({
      frame: n, speed: Math.max(0, speed),
      // 0.0 at the start: eight zero bytes, which need escaping
      lat: n < fps ? 0 : 30.26 + n * 1e-5, lon: n < fps ? 0 : -97.74 - n * 1e-5,
      ax: n < frames / 2 ? 1.2 : -4.5, ay: Math.sin(n / 5) * 2.5
    });
  });
}

async function teslaH264(file, { seconds = 4, fps = 12, size = '160x120', pattern } = {}) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: file, telemetryPattern: pattern || drivePattern(seconds * fps, { fps }), durationSeconds: seconds, frameRate: fps, size });
  return file;
}

/** The H.264 clip at `source` converted to codec ('h265' | 'av1') with its telemetry carried over; false when the encoder is missing. */
// (smallest: as the Smallest (CPU only) profile encodes, with B-frames)
async function converted(source, file, codec, { smallest = false } = {}) {
  const encoder = codec === 'h265' ? 'libx265' : 'libsvtav1';
  const tmp = `${file}.enc.mp4`;
  const args = smallest ? buildEncodeArgs({ codec, encoder, bitrate: null, smallest: { maxrate: 300_000 } }) : buildEncodeArgs({ codec, encoder, bitrate: 200_000 });
  const r = await runProcess('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source, ...args, '-an', '-f', 'mp4', tmp]);
  if (r.status !== 0) return false;
  const bytes = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  const timeline = extractH264TelemetryTimeline(fs.readFileSync(source));
  const inject = codec === 'h265' ? injectH265Telemetry : injectAv1Telemetry;
  fs.writeFileSync(file, inject(bytes, mapTimelineToOutput(timeline, outputTiming(bytes))));
  return true;
}

/** A plain ffmpeg encode (no telemetry), moov at the end unless faststart. */
async function plain(file, encoder, { faststart = false, seconds = 1 } = {}) {
  const r = await runProcess('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=160x120:rate=10`, '-t', String(seconds), '-c:v', encoder,
    ...(encoder === 'libx265' ? ['-x265-params', 'log-level=error'] : []), '-pix_fmt', 'yuv420p', ...(faststart ? ['-movflags', '+faststart'] : []), file]);
  return r.status === 0;
}

module.exports = { escape, record, drivePattern, teslaH264, converted, plain };
