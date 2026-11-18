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
//
// The parser is given the file a few KB at a time instead of the whole clip:
// it reads the index (moov) and, of each frame, only the records ahead of the
// picture. A read holds the index and a small cache of pages, not the clip.

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

/** The same reader on a file read as needed (FileBytes), not a whole clip in memory. */
function fileReader(Reader) {
  return class FileRecordReader extends Reader {
    constructor(file) {
      super(new ArrayBuffer(0));
      this.buffer = file; // .slice(start, end), as on an ArrayBuffer
      this.view = file; // getUint8 / 16 / 32, getInt32, byteLength, as on a DataView
    }

    // The parser's own NAL walk, but a picture's bytes are not read: of a
    // picture only its first two bytes and its length are looked at.
    records(start, end, lengthSize) {
      const records = [];
      for (let pos = start; pos < end;) {
        this.requireBytes(pos, lengthSize, end, 'NAL record length');
        let length = 0;
        for (let i = 0; i < lengthSize; i++) length = length * 256 + this.view.getUint8(pos++);
        if (!length) throw new Error('Invalid zero-length NAL record');
        this.requireBytes(pos, length, end, 'NAL record');
        const b0 = this.view.getUint8(pos);
        const b1 = length > 1 ? this.view.getUint8(pos + 1) : undefined;
        if (this.wholeNal(b0, b1, length)) records.push(new Uint8Array(this.buffer.slice(pos, pos + length)));
        else records.push({ 0: b0, 1: b1, length });
        pos += length;
      }
      return records;
    }

    /** Whether the parser looks past a NAL's first two bytes (records, parameter sets, markers). */
    wholeNal(b0, b1, length) {
      if (length <= 3) return true;
      const entry = this._config?.sampleEntry;
      if (entry === 'avc1') return [6, 7, 8].includes(b0 & 31);
      if (entry === 'hvc1') return b0 === 0x66 && b1 === 0x01;
      if (entry === 'av01') return b0 === 6 && b1 === 5;
      return true;
    }

    // An AV1 frame's picture is only checked to be there: once the records
    // (the first mdat) are read, the frames' own bytes are not.
    av1Telemetry(SeiMetadata, messages) {
      const groups = super.av1Telemetry(SeiMetadata, messages);
      this.buffer.skip = true;
      return groups;
    }

    readFrames(SeiMetadata, messages) {
      try {
        return super.readFrames(SeiMetadata, messages);
      } finally {
        this.buffer.skip = false;
      }
    }
  };
}

const PAGE = 4096;
const MAX_PAGES = 256; // 1 MB: the index and the frames around the one being read

/** A file read a page at a time, with the parts of ArrayBuffer and DataView the parser uses. */
class FileBytes {
  constructor(fd, size) {
    this.fd = fd;
    this.byteLength = size;
    this.pages = new Map();
    this.skip = false;
    this.bytesRead = 0;
  }

  page(n) {
    let page = this.pages.get(n);
    if (page) {
      this.pages.delete(n); // the newest last
    } else {
      const len = Math.min(PAGE, this.byteLength - n * PAGE);
      page = Buffer.allocUnsafe(len);
      this.read(page, n * PAGE);
      if (this.pages.size >= MAX_PAGES) this.pages.delete(this.pages.keys().next().value);
    }
    this.pages.set(n, page);
    return page;
  }

  read(into, at) {
    if (fs.readSync(this.fd, into, 0, into.length, at) !== into.length) throw changed();
    this.bytesRead += into.length;
  }

  getUint8(pos) {
    if (!(pos >= 0 && pos < this.byteLength)) throw new RangeError('Offset is outside the bounds of the DataView');
    return this.page(Math.floor(pos / PAGE))[pos % PAGE];
  }

  getUint16(pos) {
    if (!(pos >= 0 && pos + 2 <= this.byteLength)) throw new RangeError('Offset is outside the bounds of the DataView');
    return this.getUint8(pos) * 256 + this.getUint8(pos + 1);
  }

  getUint32(pos) {
    if (!(pos >= 0 && pos + 4 <= this.byteLength)) throw new RangeError('Offset is outside the bounds of the DataView');
    return this.getUint16(pos) * 65536 + this.getUint16(pos + 2);
  }

  getInt32(pos) {
    return this.getUint32(pos) | 0;
  }

  /** A copy of [start, end) as a new ArrayBuffer (an empty one while skip is set). */
  slice(start, end) {
    start = Math.max(0, Math.min(start, this.byteLength));
    end = Math.max(start, Math.min(end, this.byteLength));
    if (this.skip) return new ArrayBuffer(0);
    const out = new Uint8Array(end - start);
    if (out.length > 16 * PAGE) {
      this.read(out, start);
      return out.buffer;
    }
    for (let at = start; at < end;) {
      const n = Math.floor(at / PAGE);
      const page = this.page(n);
      const from = at - n * PAGE;
      const len = Math.min(page.length - from, end - at);
      out.set(page.subarray(from, from + len), at - start);
      at += len;
    }
    return out.buffer;
  }
}

function changed() {
  return Object.assign(new Error('The clip changed while it was read'), { changed: true });
}

/** A record's speed (field 4, float, metres per second), or null. */
function speedOf(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  let p = 0;
  const vint = () => {
    let n = 0;
    let mul = 1;
    for (;;) {
      if (p >= buf.length) throw new RangeError('short');
      const b = buf[p++];
      n += (b & 0x7f) * mul;
      if (!(b & 0x80)) return n;
      mul *= 128;
      if (mul > 2 ** 63) throw new RangeError('long');
    }
  };
  try {
    while (p < buf.length) {
      const tag = vint();
      const field = Math.floor(tag / 8);
      const type = tag % 8;
      if (type === 5) {
        if (p + 4 > buf.length) return null;
        if (field === 4) return buf.readFloatLE(p);
        p += 4;
      } else if (type === 0) vint();
      else if (type === 1) p += 8;
      else if (type === 2) p += vint();
      else return null;
    }
  } catch { /* a short record */ }
  return null;
}

/** One speed a second (the average, m/s; null for a second with none) from a clip's telemetry JSON. */
function speedsOf(body) {
  let frames;
  try {
    frames = JSON.parse(body).frames;
  } catch {
    return null;
  }
  if (!Array.isArray(frames) || !frames.length) return null;
  const sum = [];
  const n = [];
  const t0 = Number(frames[0][0]) || 0;
  for (const [t, rec] of frames) {
    const v = speedOf(rec);
    if (v === null || !Number.isFinite(v)) continue;
    const i = Math.max(0, Math.floor((Number(t) - t0) / 1000));
    if (i > 7200) break;
    sum[i] = (sum[i] || 0) + v;
    n[i] = (n[i] || 0) + 1;
  }
  const out = [];
  for (let i = 0; i < sum.length; i++) out.push(n[i] ? Math.round((sum[i] / n[i]) * 100) / 100 : null);
  return out.length ? out : null;
}

/** Read the clip and list [timestampMs, base64 record] for frames with telemetry. */
// (stats, for the tests: { bytesRead } is filled in)
async function readRecords(Reader, real, size, stats = null) {
  const fd = fs.openSync(real, 'r');
  let frames = [];
  let note = null;
  try {
    const file = new FileBytes(fd, size);
    try {
      frames = new (fileReader(Reader))(file).parseFrames(null);
    } catch (err) {
      if (err.changed) throw err;
      // not a Tesla clip (or a damaged one): no telemetry, like the desktop viewer
      note = `No telemetry in ${path.basename(real)}: ${err.message}`;
    }
    if (fs.fstatSync(fd).size < size) throw changed();
    if (stats) stats.bytesRead = file.bytesRead;
  } finally {
    fs.closeSync(fd);
  }
  const records = [];
  // every record of each frame (Reader.recordsOf: a converted clip's last picture also
  // carries Tesla's closing record, served where that sample was, one frame later)
  for (const f of frames) for (const [t, sei] of Reader.recordsOf(f)) records.push([t, Buffer.from(sei).toString('base64')]);
  // in the order shown (frames come in file order; with B-frames that differs)
  records.sort((a, b) => a[0] - b[0]);
  return { body: JSON.stringify({ v: 1, frames: records }), note };
}

// The worker thread: one clip, then it ends (and its memory goes with it).
if (!isMainThread && workerData?.telemetryClip) {
  const { srcRoot, real, size } = workerData;
  readRecords(loadParser(srcRoot), real, size)
    .then((out) => parentPort.postMessage(out), (err) => parentPort.postMessage({ error: err.message }));
}

class Telemetry {
  constructor({ srcRoot, cacheDir, log, concurrency = 2 }) {
    loadParser(srcRoot); // fail at start-up, not on the first clip
    this.srcRoot = srcRoot;
    this.cacheDir = cacheDir;
    this.log = log;
    this.limit = limiter(concurrency); // each read keeps a thread busy
    this.pending = new Map();
    this.sinceSweep = 0;
  }

  /** Cache key of a file as it is now. */
  static key(real, st) {
    // (t2: every record of a frame; answers cached before that are read again)
    return crypto.createHash('sha1').update(`t2|${real}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex');
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

module.exports = { Telemetry, speedOf, speedsOf, loadParser, readRecords };
