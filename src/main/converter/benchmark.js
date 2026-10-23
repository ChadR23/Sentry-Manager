'use strict';

// Real-pipeline benchmark: runs the actual converter (telemetry extraction and
// injection, full verification, staging and saving) on copies of real clips at
// every parallel-conversion level (1, 2, 4, 6, 8), and reports files per
// minute. With fewer sample clips than a level needs, clips are reused under
// other names so every slot has work. A clip that fails verification on its
// own (a damaged or odd recording) is left out and the level run again, so
// one bad clip does not fail the whole benchmark. The user's footage is only
// read; every run writes into a temporary folder.

const nodeFs = require('fs');
const nodePath = require('path');
const { CONCURRENCY } = require('./contracts');

// Failures that belong to the clip, not to the encoder or the setting: the
// clip is left out and the level measured again without it.
const CLIP_FAILURES = new Set([
  'duration-mismatch', 'frame-count-mismatch', 'dimension-mismatch', 'container-invalid',
  'decode-failed', 'probe-failed', 'telemetry-invalid', 'telemetry-mismatch', 'not-smaller'
]);

const LEVELS = Object.freeze([1, 2, 4, 6, 8]);
const MAX_CLIPS = 8;
const TESLA_STAMP = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/;

function benchmarkError(code) {
  return Object.assign(new Error(code), { code });
}

async function placeClip(fs, from, to) {
  try { await fs.link(from, to); } catch (_) { await fs.copyFile(from, to); }
}

/**
 * options:
 *   clips: [{ sourcePath, name }] real Tesla clips (read only)
 *   runLevel({ level, sourceRoot, workRoot, signal }) → job snapshot (runs the real converter)
 *   countFrames(path) → frames in a clip
 *   encoder: { codec, hardware } the converter will use
 * Returns { encoder, clips, results: [{ level, clips, completed, failed, failures, seconds,
 *   filesPerMinute, fps, ok }], best, skipped: [{ name, code }] }.
 */
async function runConverterBenchmark(options = {}) {
  const {
    clips, runLevel, countFrames, encoder = null, tempRoot,
    signal, onProgress = () => {}, now = Date.now
  } = options;
  const fs = options.fs || nodeFs.promises;
  const pathApi = options.pathApi || nodePath;
  if (typeof runLevel !== 'function' || typeof countFrames !== 'function' || !tempRoot) {
    throw new TypeError('benchmark dependencies are required');
  }
  if (!Array.isArray(clips) || clips.length === 0) throw benchmarkError('BENCHMARK_SOURCE_REQUIRED');
  const checkAborted = () => { if (signal?.aborted) throw benchmarkError('CANCELLED'); };

  const workRoot = await fs.mkdtemp(pathApi.join(tempRoot, 'benchmark-'));
  try {
    // Copy the sample clips once; every level hard-links (or copies) from here.
    const chosen = clips.slice(0, MAX_CLIPS);
    const library = pathApi.join(workRoot, 'clips');
    await fs.mkdir(library, { recursive: true });
    const samples = [];
    for (const [index, clip] of chosen.entries()) {
      checkAborted();
      onProgress({ step: 'copy', index: index + 1, total: chosen.length });
      const target = pathApi.join(library, clip.name);
      await fs.copyFile(clip.sourcePath, target);
      samples.push({ name: clip.name, origin: clip.name, path: target, frames: await countFrames(target) });
    }

    // One real conversion run of `batch` at `level` parallel conversions.
    async function measure(level, batch, runKey, variant = {}) {
      const levelRoot = pathApi.join(workRoot, runKey);
      const sourceRoot = pathApi.join(levelRoot, 'source');
      const clipDir = pathApi.join(sourceRoot, 'RecentClips');
      await fs.mkdir(clipDir, { recursive: true });
      for (const sample of batch) {
        const target = pathApi.join(clipDir, sample.name);
        // a reused clip gets its own file: the converter tells clips apart by file identity
        if (sample.reused) await fs.copyFile(sample.path, target);
        else await placeClip(fs, sample.path, target);
      }

      const started = now();
      const job = await runLevel({ level, sourceRoot, workRoot: levelRoot, signal, ...variant });
      const seconds = Math.max(0.001, (now() - started) / 1000);
      checkAborted();
      const items = Array.isArray(job?.items) ? job.items : [];
      const completed = items.filter((item) => item.state === 'completed');
      const failedItems = items.filter((item) => item.state === 'failed').map((item) => ({
        origin: batch.find((entry) => item.relativePath?.endsWith(entry.name))?.origin,
        code: item.failure?.code || item.resultCode || 'failed'
      }));
      const failures = [...new Set(failedItems.map((entry) => entry.code))];
      const frames = completed.reduce((sum, item) => {
        const sample = batch.find((entry) => item.relativePath?.endsWith(entry.name));
        return sum + (sample?.frames || 0);
      }, 0);
      const filesPerMinute = Math.round((completed.length / seconds) * 600) / 10;
      // Space saved by this codec/profile on these clips (converted ones only).
      const sourceTotal = completed.reduce((sum, item) => sum + (item.sourceBytes || 0), 0);
      const outputTotal = completed.reduce((sum, item) => sum + (item.outputBytes || 0), 0);
      const savedPercent = sourceTotal > 0 && outputTotal > 0 ? Math.round(1000 - (outputTotal / sourceTotal) * 1000) / 10 : null;
      // Average time each clip spent in post-conversion verification.
      const timedFiles = job?.timings?.files;
      const verifyMs = job?.timings?.totalMs?.verify;
      const verifySecondsPerClip = Number.isSafeInteger(timedFiles) && timedFiles > 0 && Number.isFinite(verifyMs)
        ? Math.round(verifyMs / timedFiles / 100) / 10 : null;
      await fs.rm(levelRoot, { recursive: true, force: true }).catch(() => {});
      return {
        level,
        clips: batch.length,
        completed: completed.length,
        failed: items.filter((item) => item.state === 'failed').length,
        failures,
        seconds: Math.round(seconds * 10) / 10,
        filesPerMinute,
        savedPercent,
        verifySecondsPerClip,
        fps: Math.round((frames / seconds) * 10) / 10,
        ok: completed.length === batch.length,
        failedItems
      };
    }
    // Give every parallel slot real work: at least two clips, else one per
    // slot, reusing the samples under new (still Tesla-style) names.
    const batchFor = (level) => Array.from({ length: Math.max(level, 2) }, (_, i) => {
      const sample = samples[i % samples.length];
      if (i < samples.length) return sample;
      const stamp = `2000-01-01_00-${String(i).padStart(2, '0')}-00`;
      const name = TESLA_STAMP.test(sample.name) ? sample.name.replace(TESLA_STAMP, stamp) : `${stamp}-${sample.name}`;
      return { ...sample, name, reused: true };
    });

    // Leaves out the sample clips that fail on their own; true when the level
    // is worth measuring again with the ones left. At one conversion at a time
    // a failure is the clip's; at more, the clips are first tried again one
    // at a time, since a busy encoder can fail a clip that is fine.
    const skipped = [];
    async function leaveOutBadClips(result, level) {
      if (result.ok || !result.failedItems.length || !result.failedItems.every((entry) => CLIP_FAILURES.has(entry.code) && entry.origin)) return false;
      let bad = result.failedItems;
      if (level > 1) {
        const suspects = samples.filter((sample) => bad.some((entry) => entry.origin === sample.origin));
        checkAborted();
        bad = (await measure(1, suspects, `check-${level}`)).failedItems;
      }
      for (const entry of bad) {
        const index = samples.findIndex((sample) => sample.origin === entry.origin);
        if (index === -1 || !CLIP_FAILURES.has(entry.code)) continue;
        skipped.push({ name: entry.origin, code: entry.code });
        samples.splice(index, 1);
      }
      return bad.length > 0 && samples.length > 0;
    }
    const publicResult = ({ failedItems, ...result }) => result;

    const levels = LEVELS.filter((level) => level <= CONCURRENCY.max);
    const results = [];
    for (const [index, level] of levels.entries()) {
      checkAborted();
      onProgress({ step: 'run', level, index: index + 1, total: levels.length, encoder: encoder?.codec, hardware: encoder?.hardware === true });
      let result = await measure(level, batchFor(level), `level-${level}`);
      if (await leaveOutBadClips(result, level)) {
        checkAborted();
        result = await measure(level, batchFor(level), `level-${level}-again`);
      }
      results.push(publicResult(result));
      // A failing level usually means the hardware refused another session;
      // higher ones would only fail the same way.
      if (!result.ok) break;
    }
    // Recommend the lightest setting within 5% of the fastest.
    const successful = results.filter((entry) => entry.ok);
    const top = Math.max(0, ...successful.map((entry) => entry.filesPerMinute));
    const best = successful.filter((entry) => entry.filesPerMinute >= top * 0.95)
      .sort((left, right) => left.level - right.level)[0] || null;

    // Verification modes side by side: all modes run back to back at the
    // recommended setting on the full set of sample clips, so the numbers are
    // measured the same way (the sweep's own runs are not reused).
    const verifyComparison = [];
    const compareModes = Array.isArray(options.compareVerifyModes) ? options.compareVerifyModes : [];
    if (best && compareModes.length) {
      for (const [index, mode] of compareModes.entries()) {
        checkAborted();
        onProgress({ step: 'verify', verifyMode: mode, level: best.level, index: index + 1, total: compareModes.length });
        verifyComparison.push({ verifyMode: mode, ...publicResult(await measure(best.level, samples, `verify-${mode}`, { verifyMode: mode })) });
      }
    }
    return { encoder, clips: samples.length, results, best, verifyComparison, skipped };
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { runConverterBenchmark, LEVELS, MAX_CLIPS };
