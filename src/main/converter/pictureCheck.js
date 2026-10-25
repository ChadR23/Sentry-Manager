'use strict';

// A clip encoded on another server (Nodes) must show the same pictures as
// the original. Verification checks frames, timing and telemetry, but a node
// that was tampered with could send back other pictures with the same
// timing. Both are decoded small, in grey, and compared frame by frame
// (SSIM). Measured on Tesla-like footage: real encodes score 0.99 and more
// even heavily compressed; another camera of the same moment 0.78, a heavy
// blur 0.86, black frames 0.03.

const PICTURE_MEAN = 0.9;
const PICTURE_MIN = 0.6;
const FILTER = '[0:v]scale=320:-2,format=gray[a];[1:v]scale=320:-2,format=gray[b];[a][b]ssim=stats_file=-';

/** ffmpeg's per-frame SSIM lines -> { ok, mean, min, frames }. */
function judge(stats) {
  const values = [...String(stats || '').matchAll(/All:([0-9.]+)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
  if (values.length === 0) return { ok: false, reason: 'no-frames' };
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const min = Math.min(...values);
  const round = (v) => Math.round(v * 1000) / 1000;
  return { ok: mean >= PICTURE_MEAN && min >= PICTURE_MIN, mean: round(mean), min: round(min), frames: values.length };
}

/** run(command, args, options) -> { status, stdout }: the converter's process runner. */
async function comparePictures({ source, candidate, signal, ffmpegPath = 'ffmpeg', run }) {
  const result = await run(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', source, '-i', candidate, '-lavfi', FILTER, '-f', 'null', '-'], { signal, shell: false, timeoutMs: 30 * 60_000 });
  if (result?.status !== 0) return { ok: false, reason: 'compare-failed' };
  return judge(result.stdout);
}

module.exports = { comparePictures, judge, PICTURE_MEAN, PICTURE_MIN };
