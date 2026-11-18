'use strict';

// Scrub previews: one small frame for every second of a clip (one camera),
// in a single JPEG grid. While the timeline is dragged the Viewer shows
// these at once instead of waiting for the video to seek; when it is let go
// the video takes over. Made from the clip's keyframes only when it has one
// at least every 1.1 s (Tesla's own clips: decoding only those takes a
// quarter of a second); a clip with fewer (converted footage: one every 2 s,
// or every ~7 s before that) has every frame decoded, about 3 s a minute of
// footage, as keyframes alone showed a second up to 6 s early. Made the
// first time a clip is opened, and cached on the data volume by the clip's path, size and
// modification time, so a changed clip never shows stale frames. Making one
// also prepares the next clip of the same camera in the background, and the
// newest footage is prepared ahead of time (server/scrubPrepare.js).

const crypto = require('crypto');
const os = require('os');
const nodeFs = require('fs');
const nodePath = require('path');
const { keyframePlan } = require('./scrubKeyframes');

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
  const ffprobePath = options.ffprobePath || null;
  if (typeof directory !== 'string' || !ffmpegPath || typeof spawn !== 'function') {
    throw new TypeError('directory, ffmpegPath and spawn are required');
  }
  const timeoutMs = options.timeoutMs || 60_000;
  const maxCached = options.maxCached || MAX_CACHED;
  // a number, or a function read each time (server/workLimits.js)
  const most = typeof options.concurrency === 'function' ? options.concurrency : () => options.concurrency || 3;
  const inFlight = new Map();
  const queue = [];
  let running = 0;
  let prepared = null;
  let written = 0;

  // `feed(stdin)`, when given, writes FFmpeg's input (the keyframes, scrubKeyframes.js)
  function run(args, feed = null) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(ffmpegPath, args, { shell: false, windowsHide: true, stdio: [feed ? 'pipe' : 'ignore', 'ignore', 'ignore'] });
      } catch (_) {
        resolve(-1);
        return;
      }
      // below playback and conversions, like the exporter
      try { if (child.pid) os.setPriority(child.pid, 10); } catch (_) { /* normal priority */ }
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, timeoutMs);
      child.once('error', () => { clearTimeout(timer); resolve(-1); });
      child.once('close', (status) => { clearTimeout(timer); resolve(status); });
      if (feed) {
        // FFmpeg may stop reading early (it has its one grid): a closed pipe is no error
        child.stdin.on('error', () => {});
        feed(child.stdin).catch(() => { try { child.stdin.destroy(); } catch (_) { /* gone */ } });
      }
    });
  }

  // The longest gap between the clip's keyframes, in seconds (Infinity when
  // unknown): read from the packets' flags, nothing is decoded.
  function keyframeGap(videoPath) {
    if (!ffprobePath) return Promise.resolve(Infinity);
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', '-protocol_whitelist', 'file', videoPath],
          { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (_) {
        resolve(Infinity);
        return;
      }
      let last = null;
      let gap = 0;
      let rest = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, 20_000);
      child.stdout.on('data', (chunk) => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const line of lines) {
          const [t, flags] = line.split(',');
          if (!flags || !flags.includes('K')) continue;
          const at = Number(t);
          if (!Number.isFinite(at)) continue;
          if (last !== null) gap = Math.max(gap, at - last);
          last = at;
        }
      });
      child.once('error', () => { clearTimeout(timer); resolve(Infinity); });
      child.once('close', (status) => { clearTimeout(timer); resolve(status === 0 && last !== null ? gap : Infinity); });
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
      .update(`scrub2\0${pathApi.resolve(videoPath)}\0${stat.size}\0${Math.round(Number(stat.mtimeMs))}`)
      .digest('hex');
    return pathApi.join(directory, `${key}.jpg`);
  }

  async function exists(target) {
    try { return (await fs.stat(target)).size > 0; } catch (_) { return false; }
  }

  // `ahead`: made before anyone asked (scrubPrepare.js); the grid then takes
  // the clip's own time, so pruning drops the oldest footage's grids first
  // and never the newest clips' made ahead (which were made first)
  async function generate(videoPath, target, ahead = false) {
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp.jpg`;
    try {
      // one frame per second of the clip, laid out in the grid: from the
      // keyframes alone when there is one every second or so, else from
      // every frame (deblocking skipped: nothing to see at this size). The
      // sample table gives the keyframes (scrubKeyframes.js): an H.264 clip
      // with one a second sends FFmpeg only those, read by offset, instead
      // of the whole clip; the grid is the same.
      const plan = await keyframePlan(videoPath);
      const quick = (plan ? plan.gap : await keyframeGap(videoPath)) <= 1.1;
      const tail = ['-an', '-sn', '-dn', '-frames:v', '1', '-q:v', '6', '-y', temporary];
      let status;
      if (quick && plan?.write && plan.picks.length) {
        status = await run(['-hide_banner', '-loglevel', 'error', '-threads', '2', '-f', 'h264', '-framerate', '1', '-i', 'pipe:0',
          '-vf', `scale=${FRAME_WIDTH}:-2,setsar=1,tile=${COLS}x${ROWS}`, ...tail], plan.write);
      } else {
        if (plan?.close) await plan.close();
        status = await run(['-nostdin', '-hide_banner', '-loglevel', 'error',
          ...(quick ? ['-skip_frame', 'nokey'] : ['-skip_loop_filter', 'all']), '-threads', '2', '-protocol_whitelist', 'file', '-i', videoPath,
          '-vf', `fps=1:eof_action=pass,scale=${FRAME_WIDTH}:-2,setsar=1,tile=${COLS}x${ROWS}`, ...tail]);
      }
      if (status !== 0 || !(await exists(temporary))) return null;
      if (ahead) {
        try {
          const clip = await fs.stat(videoPath);
          await fs.utimes(temporary, clip.mtime, clip.mtime);
        } catch (_) { /* the time it was made, then */ }
      }
      await fs.rename(temporary, target);
      if (++written % 200 === 0) void prune();
      return target;
    } finally {
      await fs.unlink(temporary).catch(() => {}); // gone after a successful rename
    }
  }

  function pump() {
    while (running < most() && queue.length > 0) {
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
      entry = schedule(() => generate(videoPath, target, !touch), urgent);
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
