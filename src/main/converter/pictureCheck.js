'use strict';

// A clip encoded on another server (Nodes) must show the same pictures as
// the original. Verification checks frames, timing and telemetry, but a node
// that was tampered with could send back other pictures with the same
// timing. Both files are decoded to tiny grey frames and compared frame by
// frame (SSIM), after lining them up by frame rather than by
// timestamp: Tesla's edit lists, held lead-in frames and frames Tesla's
// encoder skipped shift timestamps, and on fast footage (a repeater at speed)
// a frame or two apart already looks different. Black, swapped or frozen
// footage scores far below any real encode.

const W = 160;
const H = 120;
const BLOCK = 8;
const FRAME = W * H;
const MAX_FRAMES = 20_000; // about 9 minutes at 36 fps
const SHIFT = 48; // the largest constant offset searched (lead-in frames)
const DRIFT = 2; // and the local slack around it (a skipped frame or two)
const PICTURE_MEAN = 0.9;
const PICTURE_LOW = 0.75; // the 5th percentile of frame scores
// Clips this long or more are checked on SAMPLE_COUNT stretches of
// SAMPLE_SECONDS each (see comparePictures); shorter ones on every frame.
const SAMPLE_MIN_SECONDS = 20;
const SAMPLE_COUNT = 3;
const SAMPLE_SECONDS = 3;
const SAMPLE_MARGIN_SECONDS = 1.5;

// SSIM over 8x8 blocks (the usual constants for 8-bit pictures), averaged
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;
function similarity(a, b) {
  let total = 0;
  let blocks = 0;
  const n = BLOCK * BLOCK;
  for (let by = 0; by + BLOCK <= H; by += BLOCK) {
    for (let bx = 0; bx + BLOCK <= W; bx += BLOCK) {
      let sa = 0; let sb = 0; let saa = 0; let sbb = 0; let sab = 0;
      for (let y = by; y < by + BLOCK; y++) {
        const row = y * W;
        for (let x = bx; x < bx + BLOCK; x++) {
          const va = a[row + x];
          const vb = b[row + x];
          sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
        }
      }
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      blocks++;
    }
  }
  return total / blocks;
}

function split(buffer) {
  const count = Math.min(Math.floor(buffer.length / FRAME), MAX_FRAMES);
  const frames = [];
  for (let n = 0; n < count; n++) frames.push(buffer.subarray(n * FRAME, (n + 1) * FRAME));
  return frames;
}

/**
 * Original and encoded frames (W x H grey) -> { ok, mean, low, frames, shift }.
 * The encoded frames may start up to `maxShift` frames later (a stretch of
 * the encode read from earlier on than the original's) or `minShift` earlier.
 */
function judgeFrames(sourceBuf, candidateBuf, { minShift = -SHIFT, maxShift = SHIFT, expect = 0 } = {}) {
  const src = split(sourceBuf);
  const cand = split(candidateBuf);
  if (src.length === 0 || cand.length === 0) return { ok: false, reason: 'no-frames' };
  const at = (i, j) => (j >= 0 && j < cand.length ? similarity(src[i], cand[j]) : -1);
  // the constant offset that lines them up best: first on every 32nd frame,
  // then on every 8th near the best of those (a quarter of the work of
  // trying every offset on every 8th frame)
  const offsetScore = (shift, step) => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < src.length; i += step) {
      const v = at(i, i + shift);
      if (v === -1) continue;
      sum += v;
      n++;
    }
    // at least half the sampled frames overlap at this offset (short clips too)
    return n > 0 && n >= Math.ceil(src.length / step) / 2 ? sum / n : -Infinity;
  };
  // Offsets that score alike (a still scene: a parked car) are a tie, won by
  // the one nearest the expected offset; the first best used to win, often
  // far off, dropping frames that then counted as missing.
  const TIE = 0.002;
  const better = (shift, score, best) => score > best.score + TIE
    || (score >= best.score - TIE && Math.abs(shift - expect) < Math.abs(best.shift - expect));
  const coarse = src.length >= 64 ? 32 : 8;
  let best = { shift: expect, score: -Infinity };
  for (let shift = minShift; shift <= maxShift; shift++) {
    const score = offsetScore(shift, coarse);
    if (better(shift, score, best)) best = { shift, score };
  }
  if (coarse !== 8) {
    const around = best.shift;
    best = { shift: around, score: -Infinity };
    for (let shift = Math.max(minShift, around - 4); shift <= Math.min(maxShift, around + 4); shift++) {
      const score = offsetScore(shift, 8);
      if (better(shift, score, best)) best = { shift, score };
    }
  }
  // every frame against its best match near that offset; a frame that
  // already matches well at the offset is not searched further (its score
  // can only be lower than its best, so the check is never looser)
  const scores = [];
  for (let i = 0; i < src.length; i++) {
    let top = at(i, i + best.shift);
    if (top < PICTURE_MEAN) {
      for (let d = -DRIFT; d <= DRIFT; d++) if (d !== 0) top = Math.max(top, at(i, i + best.shift + d));
    }
    if (top !== -1) scores.push(top);
  }
  if (scores.length < Math.min(src.length, cand.length) * 0.9) return { ok: false, reason: 'frames-missing', frames: scores.length };
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const low = [...scores].sort((a, b) => a - b)[Math.floor(scores.length * 0.05)];
  const round = (v) => Math.round(v * 1000) / 1000;
  return { ok: mean >= PICTURE_MEAN && low >= PICTURE_LOW, mean: round(mean), low: round(low), frames: scores.length, shift: best.shift };
}

/** decode(file, { width, height, signal }) -> Buffer of grey frames. */
async function comparePictures({ source, candidate, signal, decode, durationSeconds = null, random = Math.random }) {
  // A clip long enough: a few short stretches at random places, chosen only
  // now that the encode is back (the node cannot know which), instead of
  // every frame: a tenth of the decoding. Each stretch of the encode is read
  // from a little earlier and longer, as its frames may sit a little off the
  // original's (lead-in frames, edit lists).
  if (Number.isFinite(durationSeconds) && durationSeconds >= SAMPLE_MIN_SECONDS) {
    const span = durationSeconds - SAMPLE_SECONDS;
    // one stretch in each part of the clip, somewhere random in that part,
    // all decoded at once
    const starts = Array.from({ length: SAMPLE_COUNT }, (_, n) => Math.round(((n + random()) / SAMPLE_COUNT) * span * 100) / 100);
    let results;
    try {
      results = await Promise.all(starts.map(async (start) => {
        const from = Math.max(0, start - SAMPLE_MARGIN_SECONDS);
        const [a, b] = await Promise.all([
          decode(source, { width: W, height: H, signal, start, length: SAMPLE_SECONDS }),
          decode(candidate, { width: W, height: H, signal, start: from, length: SAMPLE_SECONDS + (start - from) + SAMPLE_MARGIN_SECONDS })
        ]);
        // the encode's stretch starts (start - from) seconds early: its frames
        // sit that many frames on (~36 fps, up to 40), give or take the lead-in
        const early = Math.round((start - from) * 36);
        const slack = Math.ceil((start - from) * 4) + SHIFT;
        return { ...judgeFrames(a, b, { minShift: early - slack, maxShift: early + slack, expect: early }), at: start };
      }));
    } catch (err) {
      return { ok: false, reason: 'decode-failed', detail: String(err?.code || err?.message || err).slice(0, 80) };
    }
    const failed = results.find((r) => !r.ok);
    if (failed) return { ...failed, sampled: results.length };
    const round = (v) => Math.round(v * 1000) / 1000;
    return {
      ok: true,
      mean: round(results.reduce((sum, r) => sum + r.mean, 0) / results.length),
      low: Math.min(...results.map((r) => r.low)),
      frames: results.reduce((sum, r) => sum + r.frames, 0),
      sampled: results.length
    };
  }
  let a;
  let b;
  try {
    [a, b] = await Promise.all([decode(source, { width: W, height: H, signal }), decode(candidate, { width: W, height: H, signal })]);
  } catch (err) {
    return { ok: false, reason: 'decode-failed', detail: String(err?.code || err?.message || err).slice(0, 80) };
  }
  return judgeFrames(a, b);
}

/**
 * The decoder used in the app: ffmpeg writes the frames as raw grey bytes.
 * spawn: child_process.spawn (or the converter's); limited to MAX_FRAMES.
 * accel: async () => GPU decode arguments (frames come back to system memory,
 * so the same filter scales them) or null; a GPU decode that fails is done
 * again on the CPU.
 */
function ffmpegDecoder({ spawn, ffmpegPath = 'ffmpeg', timeoutMs = 30 * 60_000, accel = null }) {
  const once = (file, { width, height, signal, start = null, length = null }, hw) => new Promise((resolve, reject) => {
    // (a stretch: seeks to it, decoding from the keyframe before it)
    const range = [
      ...(Number.isFinite(start) && start > 0 ? ['-ss', start.toFixed(3)] : []),
      ...(Number.isFinite(length) && length > 0 ? ['-t', length.toFixed(3)] : [])
    ];
    const child = spawn(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...hw, '-protocol_whitelist', 'file', ...range, '-i', file,
      '-vf', `scale=${width}:${height}:flags=area,format=gray`, '-frames:v', String(MAX_FRAMES),
      '-f', 'rawvideo', '-'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0;
    const limit = width * height * MAX_FRAMES;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > limit) child.kill('SIGKILL');
      else chunks.push(c);
    });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(Object.assign(new Error('decode failed'), { code: 'DECODE_FAILED' }));
    });
  });
  return async (file, { width, height, signal, start = null, length = null } = {}) => {
    const hw = accel ? await Promise.resolve(accel()).catch(() => null) : null;
    if (hw?.length) {
      try {
        return await once(file, { width, height, signal, start, length }, hw);
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    }
    return once(file, { width, height, signal, start, length }, []);
  };
}

module.exports = { comparePictures, judgeFrames, ffmpegDecoder, PICTURE_MEAN, PICTURE_LOW, W, H };
