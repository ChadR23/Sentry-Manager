'use strict';

// Scrub previews: one small frame for every second of a clip (one camera),
// in a single JPEG grid. While the timeline is dragged the Viewer shows
// these at once instead of waiting for the video to seek; when it is let go
// the video takes over. Made from the clip's keyframes only (Tesla writes one
// about every second, and decoding only those is quick), the first time a
// clip is opened, and cached on the data volume by the clip's path, size and
// modification time, so a changed clip never shows stale frames. Making one
// also prepares the next clip of the same camera in the background, and the
// newest footage is prepared ahead of time (server/scrubPrepare.js).

const crypto = require('crypto');
const os = require('os');
const nodeFs = require('fs');
const nodePath = require('path');

// the grid: COLS x ROWS frames of FRAME_WIDTH pixels, frame n = second n
const COLS = 10;
const ROWS = 7;
const FRAME_WIDTH = 240;
const MAX_CACHED = 6_000; // about 1 GB at ~170 KB a grid
const MAX_QUEUED = 200;
const CLIP = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-([a-z_]+)\.mp4$/i;

function createScrubFrames(options = {}) {
  const fs = options.fs || nodeFs.promises;
  const pathApi = options.pathApi || nodePath;
  const { directory, ffmpegPath, spawn } = options;
  if (typeof directory !== 'string' || !ffmpegPath || typeof spawn !== 'function') {
    throw new TypeError('directory, ffmpegPath and spawn are required');
  }
  const timeoutMs = options.timeoutMs || 60_000;
  const maxCached = options.maxCached || MAX_CACHED;
  const maxRunning = options.concurrency || 3;
  const inFlight = new Map();
  const queue = [];
  let running = 0;
  let prepared = null;
  let written = 0;

  function run(args) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(ffmpegPath, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      } catch (_) {
        resolve(-1);
        return;
      }
      // below playback and conversions, like the exporter
      try { if (child.pid) os.setPriority(child.pid, 10); } catch (_) { /* normal priority */ }
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, timeoutMs);
      child.once('error', () => { clearTimeout(timer); resolve(-1); });
      child.once('close', (status) => { clearTimeout(timer); resolve(status); });
    });
  }

  async function prune() {
    try {
      const names = (await fs.readdir(directory)).filter((name) => name.endsWith('.jpg'));
      if (names.length <= maxCached) return;
      const stats = await Promise.all(names.map(async (name) => {
        try { return { name, at: (await fs.stat(pathApi.join(directory, name))).mtimeMs }; } catch (_) { return null; }
      }));
      const oldest = stats.filter(Boolean).sort((a, b) => a.at - b.at).slice(0, names.length - maxCached);
      await Promise.all(oldest.map(({ name }) => fs.unlink(pathApi.join(directory, name)).catch(() => {})));
    } catch (_) { /* pruning is best effort */ }
  }

  function prepareDirectory() {
    if (!prepared) prepared = fs.mkdir(directory, { recursive: true }).then(prune);
    return prepared;
  }

  async function cachePathFor(videoPath) {
    const stat = await fs.stat(videoPath);
    if (!stat.isFile() || stat.size === 0) return null;
    const key = crypto.createHash('sha1')
      .update(`scrub1\0${pathApi.resolve(videoPath)}\0${stat.size}\0${Math.round(Number(stat.mtimeMs))}`)
      .digest('hex');
    return pathApi.join(directory, `${key}.jpg`);
  }

  async function exists(target) {
    try { return (await fs.stat(target)).size > 0; } catch (_) { return false; }
  }

  async function generate(videoPath, target) {
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp.jpg`;
    try {
      // keyframes only, one frame per second of the clip (fps=1 repeats the
      // last keyframe where a second has none), laid out in the grid
      const status = await run(['-nostdin', '-hide_banner', '-loglevel', 'error',
        '-skip_frame', 'nokey', '-threads', '2', '-protocol_whitelist', 'file', '-i', videoPath,
        '-an', '-sn', '-dn', '-vf', `fps=1,scale=${FRAME_WIDTH}:-2,setsar=1,tile=${COLS}x${ROWS}`,
        '-frames:v', '1', '-q:v', '6', '-y', temporary]);
      if (status !== 0 || !(await exists(temporary))) return null;
      await fs.rename(temporary, target);
      if (++written % 200 === 0) void prune();
      return target;
    } finally {
      await fs.unlink(temporary).catch(() => {}); // gone after a successful rename
    }
  }

  function pump() {
    while (running < maxRunning && queue.length > 0) {
      const job = queue.shift();
      running += 1;
      job().finally(() => { running -= 1; pump(); });
    }
  }

  function schedule(task, urgent) {
    let job = null;
    const promise = new Promise((resolve) => {
      job = () => task().then(resolve, () => resolve(null));
      if (urgent) queue.unshift(job);
      else if (queue.length < MAX_QUEUED) queue.push(job);
      else { job = null; resolve(null); return; }
      pump();
    });
    return { promise, job };
  }

  // a grid queued in the background that someone now waits for goes first
  function hurry(entry) {
    const at = entry.job ? queue.indexOf(entry.job) : -1;
    if (at > 0) { queue.splice(at, 1); queue.unshift(entry.job); }
  }

  // The next clip of the same camera in the same folder, if any.
  async function nextClipOf(videoPath) {
    const m = pathApi.basename(videoPath).match(CLIP);
    if (!m) return null;
    const suffix = `-${m[2].toLowerCase()}.mp4`;
    try {
      const names = (await fs.readdir(pathApi.dirname(videoPath)))
        .filter((name) => CLIP.test(name) && name.toLowerCase().endsWith(suffix) && name > pathApi.basename(videoPath))
        .sort();
      return names.length ? pathApi.join(pathApi.dirname(videoPath), names[0]) : null;
    } catch (_) {
      return null;
    }
  }

  // The cached grid's path, making it first when needed (null when the clip
  // cannot be read or decoded).
  async function get(videoPath, { urgent = true, next = true, touch = true } = {}) {
    if (typeof videoPath !== 'string' || !pathApi.isAbsolute(videoPath) || !/\.mp4$/i.test(videoPath)) return null;
    let target;
    try {
      await prepareDirectory();
      target = await cachePathFor(videoPath);
    } catch (_) {
      return null;
    }
    if (!target) return null;
    if (next) void nextClipOf(videoPath).then((p) => p && get(p, { urgent: false, next: false }));
    if (await exists(target)) {
      if (!touch) return target;
      // recently used: kept longest when the cache is pruned
      const now = new Date();
      fs.utimes(target, now, now).catch(() => {});
      return target;
    }
    let entry = inFlight.get(target);
    if (!entry) {
      entry = schedule(() => generate(videoPath, target), urgent);
      entry.promise = entry.promise.finally(() => inFlight.delete(target));
      inFlight.set(target, entry);
    } else if (urgent) {
      hurry(entry);
    }
    return entry.promise;
  }

  return Object.freeze({ get });
}

module.exports = { createScrubFrames, COLS, ROWS, FRAME_WIDTH };
