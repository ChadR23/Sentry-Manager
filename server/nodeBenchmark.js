'use strict';

// Nodes > Benchmark: how fast a paired node converts, measured from here. A
// node has no footage of its own, so this server lends it a few sample clips
// from a vehicle's share (only read) and sends them at 1, 2, 4, 6 and 8 at
// once, exactly as a conversion would. The encoded files come back and are
// deleted; nothing on the share changes. The result suggests the lightest
// setting within 5% of the fastest, like the Encoder's own benchmark.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { videoCodec } = require('./mp4codec');

const LEVELS = [1, 2, 4, 6, 8];
const SAMPLES = 4;
const MIN_BYTES = 2 * 1024 * 1024; // a real clip (a few seconds or more), not a stub
const MAX_BYTES = 200 * 1024 * 1024;
const WITHIN = 0.05;
const CLIP_NAME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-(front|back|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$/;

/** Newest H.264 Tesla clips under a TeslaCam folder, one per camera first. */
async function pickSamples(root, { limit = SAMPLES, codecOf = videoCodec, minBytes = MIN_BYTES } = {}) {
  const found = [];
  for (const group of ['RecentClips', 'SavedClips', 'SentryClips']) {
    const dir = path.join(root, group);
    let names;
    try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    const entries = [];
    for (const d of names) {
      if (d.isFile() && CLIP_NAME.test(d.name)) entries.push(path.join(dir, d.name));
      else if (d.isDirectory() && /^\d{4}-\d{2}-\d{2}_/.test(d.name)) {
        try {
          for (const f of await fsp.readdir(path.join(dir, d.name))) if (CLIP_NAME.test(f)) entries.push(path.join(dir, d.name, f));
        } catch { /* a folder that went away */ }
      }
    }
    entries.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
    found.push(...entries.slice(0, 200));
    if (found.length >= 200) break;
  }
  const picked = [];
  const cameras = new Set();
  for (const pass of [true, false]) {
    for (const file of found) {
      if (picked.length >= limit) break;
      if (picked.includes(file)) continue;
      const camera = CLIP_NAME.exec(path.basename(file))[1];
      if (pass && cameras.has(camera)) continue;
      let st;
      try { st = await fsp.stat(file); } catch { continue; }
      if (!st.isFile() || st.size < minBytes || st.size > MAX_BYTES) continue;
      if (await codecOf(file).catch(() => null) !== 'h264') continue;
      picked.push(file);
      cameras.add(camera);
    }
  }
  return picked;
}

/** The lightest level within WITHIN of the fastest: [{ level, clipsPerMinute }] -> level. */
function suggest(results) {
  const ok = results.filter((r) => r.clipsPerMinute > 0);
  if (!ok.length) return null;
  const fastest = Math.max(...ok.map((r) => r.clipsPerMinute));
  return ok.filter((r) => r.clipsPerMinute >= fastest * (1 - WITHIN)).sort((a, b) => a.level - b.level)[0].level;
}

/**
 * deps: { nodes (server/nodes.js), vehicles, run (server/proc.js run),
 * ffprobePath, workDir, log; minBytes and levels for tests }.
 */
function createNodeBenchmark({ nodes, vehicles, run, ffprobePath = 'ffprobe', workDir, log, minBytes = MIN_BYTES, levels = LEVELS }) {
  const states = new Map(); // node id -> state
  let running = null;

  async function durationOf(file) {
    const r = await run(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeoutMs: 30_000 });
    const seconds = Number.parseFloat(r.stdout);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  async function samples() {
    for (const v of vehicles.list()) {
      let root;
      try { root = vehicles.studioRoot(v); } catch { continue; }
      const picked = await pickSamples(root, { minBytes });
      if (picked.length) return picked;
    }
    return [];
  }

  function encodeOne(nodeId, sample, codec, signal) {
    return new Promise((resolve) => {
      const target = path.join(workDir, `${crypto.randomBytes(8).toString('hex')}.mp4`);
      let child;
      try {
        child = nodes.encode({ device: { id: `node:${nodeId}` }, source: sample.file, target, codec, bitrate: sample.bitrate, quality: null, durationUs: Math.round(sample.seconds * 1e6), benchmark: true });
      } catch {
        resolve(false);
        return;
      }
      const stop = () => child.kill('SIGTERM');
      signal.addEventListener('abort', stop, { once: true });
      child.once('close', (code) => {
        signal.removeEventListener('abort', stop);
        fsp.rm(target, { force: true }).catch(() => {});
        resolve(code === 0);
      });
    });
  }

  async function runLevel(nodeId, level, list, codec, signal) {
    // twice as many clips as run at once, so the level is measured full
    const queue = Array.from({ length: Math.max(level * 2, 2) }, (_, i) => list[i % list.length]);
    const started = Date.now();
    let done = 0;
    let failed = 0;
    await Promise.all(Array.from({ length: level }, async () => {
      while (queue.length && !signal.aborted) {
        const sample = queue.shift();
        if (await encodeOne(nodeId, sample, codec, signal)) done++;
        else failed++;
      }
    }));
    const minutes = (Date.now() - started) / 60_000;
    return { level, clips: done, failed, seconds: Math.round(minutes * 600) / 10, clipsPerMinute: failed || !minutes ? 0 : Math.round((done / minutes) * 10) / 10 };
  }

  async function benchmark(state) {
    const signal = state.controller.signal;
    await fsp.mkdir(workDir, { recursive: true, mode: 0o700 });
    state.phase = 'Picking sample clips';
    const files = await samples();
    if (!files.length) throw new Error('No H.264 Tesla clips of a minute or so were found on the vehicles\' shares to lend the node.');
    const list = [];
    for (const file of files) {
      const seconds = await durationOf(file);
      if (!seconds) continue;
      const { size } = await fsp.stat(file);
      // about 20% smaller than the original, like the Balanced profile
      list.push({ file, seconds, bitrate: Math.max(500_000, Math.floor(((size * 8) / seconds) * 0.8)) });
    }
    if (!list.length) throw new Error('The sample clips could not be read.');
    state.samples = list.length;
    for (const level of levels) {
      if (signal.aborted) return;
      state.phase = `Converting ${level} at once`;
      const result = await runLevel(state.id, level, list, state.codec, signal);
      state.results.push(result);
      // a level where clips failed (or one far slower) ends the run
      if (result.failed) break;
      const best = Math.max(...state.results.map((r) => r.clipsPerMinute));
      if (result.clipsPerMinute < best * 0.8) break;
    }
    state.suggested = suggest(state.results);
  }

  function start(id, { codec = 'h265' } = {}) {
    if (running) throw Object.assign(new Error('A node benchmark is already running.'), { status: 409 });
    if (codec !== 'h265' && codec !== 'av1') throw Object.assign(new Error('Codec: h265 or av1.'), { status: 400 });
    const state = { id, codec, state: 'running', phase: 'Starting', results: [], suggested: null, error: null, startedAt: Date.now(), controller: new AbortController() };
    states.set(id, state);
    running = state;
    benchmark(state).then(() => {
      state.state = state.controller.signal.aborted ? 'cancelled' : 'done';
    }, (err) => {
      state.state = 'failed';
      state.error = err.message;
      log?.warn(`Node benchmark: ${err.message}`);
    }).finally(() => {
      state.phase = null;
      state.endedAt = Date.now();
      running = null;
    });
    return view(id);
  }

  function cancel(id) {
    const state = states.get(id);
    if (state?.state === 'running') state.controller.abort();
    return view(id);
  }

  function view(id) {
    const s = states.get(id);
    if (!s) return null;
    return { state: s.state, phase: s.phase, codec: s.codec, results: s.results, suggested: s.suggested, error: s.error, startedAt: s.startedAt, endedAt: s.endedAt || null, samples: s.samples || null };
  }

  return { start, cancel, view, busy: () => Boolean(running) };
}

module.exports = { createNodeBenchmark, pickSamples, suggest, LEVELS };
