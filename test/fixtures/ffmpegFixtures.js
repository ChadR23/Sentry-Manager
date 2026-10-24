'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { injectTeslaTelemetryIntoH264Mp4 } = require('./fixtureBuilders');

function executableName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

async function locateBundledTools(rootDir = path.resolve(__dirname, '..', '..')) {
  const ffmpegPath = path.join(rootDir, 'ffmpeg_bin', executableName('ffmpeg'));
  const ffprobePath = path.join(rootDir, 'ffmpeg_bin', executableName('ffprobe'));
  const [ffmpeg, ffprobe] = await Promise.all([
    fs.promises.stat(ffmpegPath),
    fs.promises.stat(ffprobePath)
  ]);
  if (!ffmpeg.isFile() || !ffprobe.isFile()) throw new Error('Bundled FFmpeg/FFprobe files are unavailable');
  return Object.freeze({ ffmpegPath, ffprobePath });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs || 120_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut: signal === 'SIGTERM' });
    });
  });
}

function probeRequiredEncodersSync(rootDir = path.resolve(__dirname, '..', '..')) {
  const ffmpegPath = path.join(rootDir, 'ffmpeg_bin', executableName('ffmpeg'));
  const candidates = { h265: ['libx265'], av1: ['libsvtav1', 'libaom-av1'] };
  const selected = {};
  const failures = [];
  for (const [codec, encoders] of Object.entries(candidates)) {
    for (const encoder of encoders) {
      const output = process.platform === 'win32' ? 'NUL' : '/dev/null';
      const result = spawnSync(ffmpegPath, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=duration=0.25:size=64x64:rate=4',
        '-frames:v', '1', '-an', '-c:v', encoder,
        ...(encoder === 'libx265' ? ['-preset', 'ultrafast'] : []),
        ...(encoder === 'libsvtav1' ? ['-preset', '12'] : []),
        ...(encoder === 'libaom-av1' ? ['-cpu-used', '8'] : []),
        '-f', 'mp4', output
      ], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
      if (result.status === 0) { selected[codec] = encoder; break; }
      failures.push(`${encoder}: ${(result.stderr || result.error?.message || `status ${result.status}`).trim().split(/\r?\n/).at(-1)}`);
    }
  }
  const missing = Object.keys(candidates).filter((codec) => !selected[codec]);
  return Object.freeze({
    available: missing.length === 0,
    selected: Object.freeze(selected),
    reason: missing.length ? `required encoder probe failed for ${missing.join(', ')} (${failures.join('; ')})` : null
  });
}

async function createTeslaH264Fixture({
  ffmpegPath,
  outputPath,
  telemetryPattern,
  durationSeconds = 4,
  frameRate = 12,
  size = '320x180',
  spatialNoise = 0
}) {
  const frameCount = durationSeconds * frameRate;
  if (!Array.isArray(telemetryPattern) || telemetryPattern.length !== frameCount) {
    throw new RangeError(`telemetryPattern must contain ${frameCount} frame entries`);
  }
  const basePath = `${outputPath}.base.mp4`;
  const result = await runProcess(ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    // Static spatial noise adds camera-like detail without artificial frame-to-frame entropy.
    '-f', 'lavfi', '-i', `testsrc2=duration=${durationSeconds}:size=${size}:rate=${frameRate}`
      + (spatialNoise ? `,noise=alls=${spatialNoise}:allf=u:all_seed=41` : ''),
    '-frames:v', String(frameCount), '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '1200k', '-minrate', '1200k', '-maxrate', '1200k', '-bufsize', '2400k',
    '-g', String(frameRate), '-bf', '0', '-pix_fmt', 'yuv420p', '-tag:v', 'avc1',
    '-movflags', '+faststart', '-use_editlist', '0', basePath
  ]);
  if (result.status !== 0) throw new Error(`H.264 fixture encode failed: ${result.stderr}`);
  const encoded = await fs.promises.readFile(basePath);
  const patched = injectTeslaTelemetryIntoH264Mp4(encoded, telemetryPattern);
  await fs.promises.writeFile(outputPath, patched);
  await fs.promises.unlink(basePath);
  return Object.freeze({ outputPath, frameCount, durationSeconds, sourceBytes: patched.length });
}

// A Tesla side/back camera file as the car writes it: cut out of a longer
// recording in the middle of a group of pictures, so it starts with
// `gop - cut` P-frames that reference the previous file (the lead-in), then
// keyframes every `gop` frames. Variable frame durations in a 1/10000
// timescale, Tesla SEI telemetry per frame (telemetryPattern, one entry per
// frame of the clip), and optionally Tesla's ending: a last zero-duration
// sample left out by a zero-based edit list. A clip no longer than its
// lead-in (frames <= gop - cut) has no keyframe: an empty sync-sample table.
async function createMidGopTeslaH264Fixture({
  ffmpegPath,
  outputPath,
  telemetryPattern,
  frames,
  gop = 8,
  cut = 3,
  frameRate = 24,
  size = '320x240',
  spatialNoise = 4,
  durations = null,
  teslaEnding = true
}) {
  const { box, fullBox, u32 } = require('./fixtureBuilders');
  const { parseMp4, findBoxes, selectVideoTrack, buildSampleIndex } = require('../../src/main/converter/mp4');
  if (!Number.isInteger(frames) || frames < 1 || !Number.isInteger(gop) || gop < 2 || !Number.isInteger(cut) || cut < 0 || cut >= gop) {
    throw new RangeError('frames, gop and cut must describe a clip');
  }
  if (!Array.isArray(telemetryPattern) || telemetryPattern.length !== frames) throw new RangeError(`telemetryPattern must contain ${frames} entries`);
  const total = cut + frames;
  const basePath = `${outputPath}.gop.mp4`;
  const result = await runProcess(ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${frameRate}`
      + (spatialNoise ? `,noise=alls=${spatialNoise}:allf=u:all_seed=41` : ''),
    '-frames:v', String(total), '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '1200k', '-minrate', '1200k', '-maxrate', '1200k', '-bufsize', '2400k',
    '-x264-params', `keyint=${gop}:min-keyint=${gop}:scenecut=0:open-gop=0`, '-bf', '0',
    '-pix_fmt', 'yuv420p', '-tag:v', 'avc1', '-use_editlist', '0', basePath
  ]);
  if (result.status !== 0) throw new Error(`H.264 fixture encode failed: ${result.stderr}`);
  const encoded = await fs.promises.readFile(basePath);
  await fs.promises.unlink(basePath);
  const tree = parseMp4(encoded);
  const track = selectVideoTrack(tree);
  const all = buildSampleIndex(track);
  if (all.length !== total) throw new Error(`fixture encode made ${all.length} frames, not ${total}`);
  const kept = all.slice(cut);
  // Tesla-like variable durations around 1/24 s (deterministic).
  const sampleDurations = durations || kept.map((_, index) => 380 + ((index * 7919) % 9) * 15);
  if (sampleDurations.length !== frames) throw new RangeError('durations must have one entry per frame');
  if (teslaEnding) sampleDurations[frames - 1] = 0;
  const syncNumbers = kept.map((_, index) => index).filter((index) => (index + cut) % gop === 0).map((index) => index + 1);

  const stsd = findBoxes(track, 'stsd')[0];
  const stsdBox = encoded.subarray(Number(stsd.start), Number(stsd.end));
  const width = Number(size.split('x')[0]);
  const height = Number(size.split('x')[1]);
  const totalTicks = sampleDurations.reduce((sum, value) => sum + value, 0);
  const runs = [];
  for (const value of sampleDurations) {
    if (runs.length && runs.at(-1)[1] === value) runs.at(-1)[0] += 1;
    else runs.push([1, value]);
  }
  const matrix = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
  const media = Buffer.concat(kept.map((sample) => encoded.subarray(Number(sample.offset), Number(sample.offset) + sample.size)));
  const makeFile = (chunkOffset) => {
    const stbl = box('stbl', Buffer.concat([
      stsdBox,
      fullBox('stts', 0, 0, Buffer.concat([u32(runs.length), ...runs.flatMap(([count, value]) => [u32(count), u32(value)])])),
      fullBox('stss', 0, 0, Buffer.concat([u32(syncNumbers.length), ...syncNumbers.map(u32)])),
      fullBox('stsc', 0, 0, Buffer.concat([u32(1), u32(1), u32(frames), u32(1)])),
      fullBox('stsz', 0, 0, Buffer.concat([u32(0), u32(frames), ...kept.map((sample) => u32(sample.size))])),
      fullBox('stco', 0, 0, Buffer.concat([u32(1), u32(chunkOffset)]))
    ]));
    const minf = box('minf', Buffer.concat([
      fullBox('vmhd', 0, 1, Buffer.alloc(8)),
      box('dinf', fullBox('dref', 0, 0, Buffer.concat([u32(1), fullBox('url ', 0, 1)]))),
      stbl
    ]));
    const mdia = box('mdia', Buffer.concat([
      fullBox('mdhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(10_000), u32(totalTicks), Buffer.from([0x55, 0xc4, 0, 0])])),
      fullBox('hdlr', 0, 0, Buffer.concat([u32(0), Buffer.from('vide'), Buffer.alloc(12), Buffer.from('VideoHandler\0')])),
      minf
    ]));
    const tkhd = fullBox('tkhd', 0, 3, Buffer.concat([u32(0), u32(0), u32(1), u32(0), u32(totalTicks), Buffer.alloc(8),
      Buffer.alloc(8), matrix, u32(width << 16), u32(height << 16)]));
    const edts = teslaEnding
      ? [box('edts', fullBox('elst', 0, 0, Buffer.concat([u32(1), u32(totalTicks), u32(0), u32(0x00010000)])))]
      : [];
    const mvhd = fullBox('mvhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(10_000), u32(totalTicks), u32(0x00010000),
      Buffer.from([1, 0]), Buffer.alloc(10), matrix, Buffer.alloc(24), u32(2)]));
    const moov = box('moov', Buffer.concat([mvhd, box('trak', Buffer.concat([tkhd, ...edts, mdia]))]));
    const ftyp = box('ftyp', Buffer.concat([Buffer.from('mp42'), u32(0), Buffer.from('mp42mp41isomiso2')]));
    return { ftyp, moov };
  };
  const placeholder = makeFile(0);
  const { ftyp, moov } = makeFile(placeholder.ftyp.length + placeholder.moov.length + 8);
  const clip = Buffer.concat([ftyp, moov, box('mdat', media)]);
  const patched = injectTeslaTelemetryIntoH264Mp4(clip, telemetryPattern);
  await fs.promises.writeFile(outputPath, patched);
  return Object.freeze({
    outputPath,
    frames,
    leadIn: cut === 0 ? 0 : Math.min(gop - cut, frames),
    durations: Object.freeze([...sampleDurations]),
    sourceBytes: patched.length
  });
}

async function probeVideo(ffprobePath, inputPath) {
  const result = await runProcess(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=codec_name,codec_tag_string,width,height,duration,nb_read_frames,nb_frames,avg_frame_rate,r_frame_rate:format=duration,size',
    '-of', 'json', inputPath
  ]);
  if (result.status !== 0) throw new Error(`FFprobe failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function probeFramePts(ffprobePath, inputPath) {
  const result = await runProcess(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', inputPath
  ]);
  if (result.status !== 0 || result.timedOut) throw new Error(`Frame PTS probe failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const pts = (parsed.frames || []).map((frame) => Number(frame.best_effort_timestamp_time));
  if (!pts.length || pts.some((value) => !Number.isFinite(value))) throw new Error('Frame PTS probe returned invalid timestamps');
  return pts;
}

async function measureQuality(ffmpegPath, sourcePath, outputPath) {
  const result = await runProcess(ffmpegPath, [
    '-nostdin', '-hide_banner', '-i', sourcePath, '-i', outputPath,
    '-lavfi', '[0:v][1:v]ssim;[0:v][1:v]psnr', '-f', 'null',
    process.platform === 'win32' ? 'NUL' : '/dev/null'
  ]);
  if (result.status !== 0 || result.timedOut) throw new Error(`Quality measurement failed: ${result.stderr}`);
  const ssim = /SSIM[^\r\n]* All:([0-9.]+)/.exec(result.stderr);
  const psnr = /PSNR[^\r\n]* average:([0-9.]+)/.exec(result.stderr);
  const metrics = { ssim: Number(ssim?.[1]), psnr: Number(psnr?.[1]) };
  if (!Number.isFinite(metrics.ssim) || !Number.isFinite(metrics.psnr)) {
    throw new Error(`Quality measurement output was incomplete: ${result.stderr}`);
  }
  return Object.freeze(metrics);
}

async function assertFullDecode(ffmpegPath, inputPath) {
  const result = await runProcess(ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', inputPath,
    '-map', '0:v:0', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null'
  ]);
  if (result.status !== 0) throw new Error(`Full decode failed: ${result.stderr}`);
  return result;
}

module.exports = {
  assertFullDecode,
  createMidGopTeslaH264Fixture,
  createTeslaH264Fixture,
  locateBundledTools,
  measureQuality,
  probeFramePts,
  probeRequiredEncodersSync,
  probeVideo,
  runProcess
};
