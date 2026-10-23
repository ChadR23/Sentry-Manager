'use strict';

// Tesla telemetry (speed, steering, pedals, GPS, ...) for the web viewer.
//
// The desktop viewer reads a clip from the local disk and pulls the
// telemetry records out of its H.264 / H.265 / AV1 frames itself. In the web
// version that meant downloading the whole front-camera file (~80 MB a
// minute) a second time, next to the video stream, before anything showed.
// Here the server reads the file from the share instead, with Studio's own
// parser (src/renderer/scripts/data/dashcam-mp4.js, unchanged), and sends
// only each frame's timestamp and raw telemetry record (a few hundred KB).
// The browser decodes the records exactly as before, so the dashboard, map
// and their timing are the same as in the desktop app.
//
// Results are cached under /data/telemetry by file, size and modification
// time; a converted clip (new size and time) is read again.
//
// Reading a clip is a second or more of solid work, so it runs in a worker
// thread: on the server's own thread it held up every other request while
// the viewer opened new clips (a page could take 15 s to appear).

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const vm = require('vm');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { limiter } = require('./scanner');

const MAX_FILE = 1024 * 1024 * 1024;
const MAX_CACHE_FILES = 4000;

/** Studio's DashcamMP4, loaded from its browser script without a browser. */
function loadParser(srcRoot) {
  const file = path.join(srcRoot, 'renderer', 'scripts', 'data', 'dashcam-mp4.js');
  const sandbox = { window: {}, DataView, Uint8Array, ArrayBuffer, Error, Math, Number, String };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const DashcamMP4 = sandbox.window.DashcamMP4;
  // keep each frame's raw telemetry record instead of decoding it here
  return class RecordReader extends DashcamMP4 {
    decodeSei(nal) {
      return this.seiPayload(nal);
    }
  };
}

/** Read the clip and list [timestampMs, base64 record] for frames with telemetry. */
async function readRecords(Reader, real, size) {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  const fh = await fsp.open(real, 'r');
  try {
    let at = 0;
    while (at < size) {
      const { bytesRead } = await fh.read(bytes, at, Math.min(16 * 1024 * 1024, size - at), at);
      if (!bytesRead) break;
      at += bytesRead;
    }
    if (at !== size) throw new Error('The clip changed while it was read');
  } finally {
    await fh.close();
  }
  let frames = [];
  let note = null;
  try {
    frames = new Reader(bytes.buffer).parseFrames(null);
  } catch (err) {
    // not a Tesla clip (or a damaged one): no telemetry, like the desktop viewer
    note = `No telemetry in ${path.basename(real)}: ${err.message}`;
  }
  const records = [];
  for (const f of frames) if (f.sei) records.push([f.timestamp, Buffer.from(f.sei).toString('base64')]);
  return { body: JSON.stringify({ v: 1, frames: records }), note };
}

// The worker thread: one clip, then it ends (and its memory goes with it).
if (!isMainThread && workerData?.telemetryClip) {
  const { srcRoot, real, size } = workerData;
  readRecords(loadParser(srcRoot), real, size)
    .then((out) => parentPort.postMessage(out), (err) => parentPort.postMessage({ error: err.message }));
}

class Telemetry {
  constructor({ srcRoot, cacheDir, log }) {
    loadParser(srcRoot); // fail at start-up, not on the first clip
    this.srcRoot = srcRoot;
    this.cacheDir = cacheDir;
    this.log = log;
    this.limit = limiter(2); // each read holds one clip in memory
    this.pending = new Map();
    this.sinceSweep = 0;
  }

  /** Cache key of a file as it is now. */
  static key(real, st) {
    return crypto.createHash('sha1').update(`${real}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex');
  }

  /** { key, body (JSON text) } for a clip; real must already be checked. */
  async forFile(real) {
    const st = await fsp.stat(real);
    if (!st.isFile()) throw Object.assign(new Error('Not a file'), { status: 404 });
    if (st.size > MAX_FILE) throw Object.assign(new Error('File too large'), { status: 413 });
    const key = Telemetry.key(real, st);
    const cached = path.join(this.cacheDir, `${key}.json`);
    const body = await fsp.readFile(cached, 'utf8').catch(() => null);
    if (body) return { key, body };
    if (!this.pending.has(key)) {
      const job = this.limit(() => this.read(real, st.size)).then(async (out) => {
        await fsp.mkdir(this.cacheDir, { recursive: true });
        const tmp = `${cached}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, out);
        await fsp.rename(tmp, cached);
        if (++this.sinceSweep >= 100) this.sweep().catch(() => {});
        return { key, body: out };
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, job);
    }
    return this.pending.get(key);
  }

  /** The clip's telemetry as JSON text, read in a worker thread. */
  read(real, size) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { telemetryClip: true, srcRoot: this.srcRoot, real, size } });
      let answered = false;
      worker.once('message', (out) => {
        answered = true;
        if (out.note) this.log?.info(out.note);
        if (out.error) reject(new Error(out.error));
        else resolve(out.body);
      });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (!answered) reject(new Error(`The telemetry reader stopped (${code})`));
      });
    });
  }

  /** Keep the cache to the newest MAX_CACHE_FILES results. */
  async sweep() {
    this.sinceSweep = 0;
    const names = (await fsp.readdir(this.cacheDir)).filter((n) => n.endsWith('.json'));
    if (names.length <= MAX_CACHE_FILES) return;
    const stats = await Promise.all(names.map(async (n) => ({ n, t: (await fsp.stat(path.join(this.cacheDir, n)).catch(() => null))?.mtimeMs || 0 })));
    stats.sort((a, b) => a.t - b.t);
    for (const { n } of stats.slice(0, stats.length - MAX_CACHE_FILES)) await fsp.rm(path.join(this.cacheDir, n), { force: true });
  }
}

module.exports = { Telemetry };
