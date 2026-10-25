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

/** Original and encoded frames (W x H grey) -> { ok, mean, low, frames, shift }. */
function judgeFrames(sourceBuf, candidateBuf) {
  const src = split(sourceBuf);
  const cand = split(candidateBuf);
  if (src.length === 0 || cand.length === 0) return { ok: false, reason: 'no-frames' };
  const at = (i, j) => (j >= 0 && j < cand.length ? similarity(src[i], cand[j]) : -1);
  // the constant offset that lines them up best, on every 8th frame
  let best = { shift: 0, score: -Infinity };
  for (let shift = -SHIFT; shift <= SHIFT; shift++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < src.length; i += 8) {
      const v = at(i, i + shift);
      if (v === -1) continue;
      sum += v;
      n++;
    }
    // at least half the sampled frames overlap at this offset (short clips too)
    if (n > 0 && n >= Math.ceil(src.length / 8) / 2 && sum / n > best.score) best = { shift, score: sum / n };
  }
  // every frame against its best match near that offset
  const scores = [];
  for (let i = 0; i < src.length; i++) {
    let top = -1;
    for (let d = -DRIFT; d <= DRIFT; d++) top = Math.max(top, at(i, i + best.shift + d));
    if (top !== -1) scores.push(top);
  }
  if (scores.length < Math.min(src.length, cand.length) * 0.9) return { ok: false, reason: 'frames-missing', frames: scores.length };
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const low = [...scores].sort((a, b) => a - b)[Math.floor(scores.length * 0.05)];
  const round = (v) => Math.round(v * 1000) / 1000;
  return { ok: mean >= PICTURE_MEAN && low >= PICTURE_LOW, mean: round(mean), low: round(low), frames: scores.length, shift: best.shift };
}

/** decode(file, { width, height, signal }) -> Buffer of grey frames. */
async function comparePictures({ source, candidate, signal, decode }) {
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
  const once = (file, { width, height, signal }, hw) => new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...hw, '-i', file,
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
  return async (file, { width, height, signal } = {}) => {
    const hw = accel ? await Promise.resolve(accel()).catch(() => null) : null;
    if (hw?.length) {
      try {
        return await once(file, { width, height, signal }, hw);
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    }
    return once(file, { width, height, signal }, []);
  };
}

module.exports = { comparePictures, judgeFrames, ffmpegDecoder, PICTURE_MEAN, PICTURE_LOW, W, H };
