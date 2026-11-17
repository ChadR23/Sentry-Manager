'use strict';

// Fixtures for the Rust converter's telemetry parity test
// (lean/src/converter/tests.rs): Tesla-like H.264 originals made with the
// repository's fixture builders (keyframe first, a lead-in before the first
// keyframe, frame_num gaps FFmpeg drops a picture for, no keyframe at all),
// each encoded to H.265 and AV1 with the converter's own encoder arguments.
// For every case it stores what the Node code makes of them:
//
//   <case>.json         extractH264TelemetryTimeline (summary), sourceTimingFor
//   <case>.<codec>.enc  the raw encode
//   <case>.<codec>.out  the Node writer's output (retimeToSource, mapTimelineToOutput,
//                       inject*Telemetry), or <case>.<codec>.err with the error code
//   <case>.<codec>.inspect.json  inspectH265Telemetry / inspectAv1Telemetry of .out
//
//   node lean/src/converter/testdata/telemetryFixtures.js <dir>

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const C = (name) => require(path.join(REPO, 'src/main/converter', name));
const { createTeslaH264Fixture, createMidGopTeslaH264Fixture, runProcess } = require(path.join(REPO, 'test/fixtures/ffmpegFixtures'));
const { extractH264TelemetryTimeline, mapTimelineToOutput } = C('telemetryTimeline');
const { buildEncodeArgs } = C('encoderPlanner');
const { injectH265Telemetry, inspectH265Telemetry } = C('h265Telemetry');
const { injectAv1Telemetry, inspectAv1Telemetry } = C('av1Telemetry');
const { outputTiming } = C('converterAdapters');
const { sourceTimingFor, retimeToSource, leadInHoldFrames } = C('leadIn');

const dir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('usage: node telemetryFixtures.js <dir>');
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });

const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString() || '';
const has = (name) => new RegExp(`\\s${name}\\s`).test(encoders);

const telemetryFor = (frames, gapsAt = []) => Array.from({ length: frames }, (_, n) => (gapsAt.includes(n) ? null : Buffer.from([0x20, n & 0xff, n >> 8])));

const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : Buffer.isBuffer(x) ? x.toString('hex') : x), 1);

function summary(timeline) {
  return {
    timescale: timeline.timescale,
    lengthSize: timeline.lengthSize,
    samples: timeline.samples.map((s) => ({ ptsUs: s.ptsUs, durationUs: s.durationUs, hasTelemetry: s.hasTelemetry, fingerprints: s.seiNals.map((r) => r.fingerprint), nals: s.seiNals.map((r) => r.nal.toString('hex')) })),
    events: timeline.events.length,
    leadIn: { ...timeline.leadIn, durationTicks: timeline.leadIn.durationTicks ? [...timeline.leadIn.durationTicks] : undefined },
    undecodable: { ...timeline.undecodable, samples: [...timeline.undecodable.samples], durationTicks: timeline.undecodable.durationTicks ? [...timeline.undecodable.durationTicks] : undefined },
    sourceTiming: sourceTimingFor(timeline) ? { timescale: sourceTimingFor(timeline).timescale, durationTicks: [...sourceTimingFor(timeline).durationTicks] } : null,
    hold: leadInHoldFrames(timeline)
  };
}

async function main() {
  const cases = [];
  const add = async (name, make) => { const file = path.join(dir, `${name}.mp4`); await make(file); cases.push({ name, file }); };
  await add('plain', (f) => createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: f, telemetryPattern: telemetryFor(36, [5, 6]), durationSeconds: 3, frameRate: 12, size: '160x120' }));
  await add('leadin', (f) => createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: f, frames: 40, gop: 8, cut: 3, size: '160x120', telemetryPattern: telemetryFor(40) }));
  await add('first', (f) => createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: f, frames: 40, gop: 8, cut: 0, size: '160x120', telemetryPattern: telemetryFor(40) }));
  await add('nokey', (f) => createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: f, frames: 4, gop: 8, cut: 3, size: '160x120', telemetryPattern: telemetryFor(4) }));
  await add('gap', (f) => createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: f, frames: 54, gop: 18, cut: 0, size: '160x120', skip: [16], telemetryPattern: telemetryFor(54) }));
  await add('gap-leadin', (f) => createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: f, frames: 54, gop: 18, cut: 7, size: '160x120', skip: [27], telemetryPattern: telemetryFor(54) }));
  await add('gap-unknown', (f) => createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: f, frames: 54, gop: 30, cut: 0, size: '160x120', skip: [16], telemetryPattern: telemetryFor(54) }));
  // encoded as Smallest (CPU only) encodes them (H.265 only): B-frames, and a lead-in clip that keeps its frame order
  await add('smallest', (f) => createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: f, frames: 40, gop: 8, cut: 0, size: '160x120', telemetryPattern: telemetryFor(40) }));
  await add('smallest-leadin', (f) => createMidGopTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: f, frames: 40, gop: 8, cut: 3, size: '160x120', telemetryPattern: telemetryFor(40) }));

  const codecs = [];
  if (has('libx265')) codecs.push(['h265', 'libx265', injectH265Telemetry, inspectH265Telemetry]);
  if (has('libsvtav1')) codecs.push(['av1', 'libsvtav1', injectAv1Telemetry, inspectAv1Telemetry]);

  for (const { name, file } of cases) {
    const source = fs.readFileSync(file);
    const timeline = extractH264TelemetryTimeline(source);
    fs.writeFileSync(path.join(dir, `${name}.json`), json(summary(timeline)));
    for (const [codec, encoder, inject, inspect] of codecs) {
      // (SVT-AV1 can stall on a clip of a few frames; the H.265 case covers it)
      if (codec === 'av1' && timeline.samples.length < 10) continue;
      const smallest = name.startsWith('smallest');
      if (smallest && codec !== 'h265') continue;
      const enc = path.join(dir, `${name}.${codec}.enc`);
      const holdFrames = leadInHoldFrames(timeline);
      const args = smallest
        ? buildEncodeArgs({ codec, encoder, bitrate: null, holdFrames, smallest: { maxrate: 300_000 }, keepOrder: sourceTimingFor(timeline) !== null })
        : buildEncodeArgs({ codec, encoder, bitrate: 200_000, holdFrames });
      const r = await runProcess('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', file, ...args, '-an', '-f', 'mp4', enc]);
      if (r.status !== 0) throw new Error(`encode ${name} ${codec}: ${r.stderr}`);
      const bytes = fs.readFileSync(enc);
      try {
        const timing = sourceTimingFor(timeline);
        const retimed = timing ? retimeToSource(bytes, timing) : bytes;
        const out = inject(retimed, mapTimelineToOutput(timeline, outputTiming(retimed)));
        fs.writeFileSync(path.join(dir, `${name}.${codec}.out`), out);
        fs.writeFileSync(path.join(dir, `${name}.${codec}.inspect.json`), json(inspect(out)));
      } catch (error) {
        fs.writeFileSync(path.join(dir, `${name}.${codec}.err`), String(error.code || 'NO_CODE'));
      }
      // the inspection of the raw encode too (no telemetry: refused or invalid)
      try {
        fs.writeFileSync(path.join(dir, `${name}.${codec}.raw-inspect.json`), json(inspect(bytes)));
      } catch (error) {
        fs.writeFileSync(path.join(dir, `${name}.${codec}.raw-inspect.json`), json({ error: error.code || 'NO_CODE' }));
      }
    }
  }
  fs.writeFileSync(path.join(dir, 'cases.json'), JSON.stringify({ cases: cases.map((c) => c.name), codecs: codecs.map((c) => c[0]) }));
}

main().catch((error) => { console.error(error); process.exit(1); });
