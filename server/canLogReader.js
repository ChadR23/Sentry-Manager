'use strict';

// The one place a stored CAN Bridge log (<name>.log.xz) is read as text, in
// either format the bridge writes (docs/can-bridge-api.md, "Log formats"):
//
//   canbridge-candump-xz/1   candump text, xz: `xz -dc` and its lines as they come
//   canbridge-columns-xz/2   the same lines kept as columns, xz: `xz -dc` starts
//                            with "CANBRIDGE-COLUMNS/2\n"; the whole body is
//                            needed to rebuild the lines (canColumns.js, the
//                            CAN Bridge's own decoder), so it is collected up to
//                            MAX_COLUMNS_BODY and decoded in a worker thread
//
// Which one a file holds is told by its first bytes, not by the sidecar (which
// may be missing, late, or wrong). Either way the reader gives exactly the
// candump text a /1 file of the same frames holds, so the indexer (lines) and
// the candump download (text) need not know the format. The stored file is
// never changed: its bytes are what the bridge signed (canTrust.js hashes the
// file itself, not this text).
//
// Bounds, so a crafted file (a tiny file that unpacks to terabytes, one endless
// line, a columns body with absurd counts) cannot use up memory:
// - no line longer than MAX_LINE (a candump line is under 100 bytes), longer ones skipped;
// - at most MAX_UNPACKED bytes of text from one log (a one-minute log is about 10 MB of text);
// - a columns body of at most MAX_COLUMNS_BODY, decoded with at most DECODE_HEAP_MB of
//   memory and at most MAX_DECODERS at a time; over any of these, or malformed, the log
//   is refused (an error, as for any unreadable log).

const path = require('path');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const { MAGIC, isColumns } = require('./canColumns');

const FORMAT_CANDUMP = 'canbridge-candump-xz/1';
const FORMAT_COLUMNS = 'canbridge-columns-xz/2';
const FORMATS = [FORMAT_CANDUMP, FORMAT_COLUMNS];
const MAX_LINE = 512;
const MAX_UNPACKED = 4 * 1024 ** 3;
// the bridge closes a compact file early once it holds 48 MB in memory (sidecar closed_because "size");
// a body is no larger than what the bridge held, so 64 MB leaves a third over that and still refuses
// anything far beyond what the bridge can write. Measured: a 48 MB body (4.2 million frames, about
// 180 MB of text) decodes in about 3.2 s, so it is done in a worker (the main thread's event loop
// stays under 60 ms late meanwhile); a one-minute log (4 to 5 MB) takes a few hundred ms.
const MAX_COLUMNS_BODY = 64 * 1024 ** 2;
// the decoder's heap: a 48 MB body of real-looking frames needs 200 to 256 MB; the worst a 64 MB body
// can be (22 million frames of 3 bytes each) fits in 512 MB too. Past it, the log is refused.
const DECODE_HEAP_MB = 512;
const MAX_DECODERS = 2;

/** Lines from a stream, each at most maxLine bytes (longer ones are skipped), stopping after maxTotal bytes. */
async function* boundedLines(stream, { maxLine = MAX_LINE, maxTotal = MAX_UNPACKED, onLimit = () => {} } = {}) {
  let rest = '';
  let total = 0;
  let skipping = false;
  const chunks = (async function* read() {
    // a stream closed early (xz could not start, or was stopped) just ends the lines
    try { for await (const c of stream) yield c; } catch (err) { if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err; }
  }());
  for await (const chunk of chunks) {
    total += chunk.length;
    if (total > maxTotal) { onLimit(); return; }
    const text = chunk.toString('latin1');
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl < 0) break;
      if (skipping) skipping = false;
      else {
        const line = rest + text.slice(start, nl);
        if (line.length <= maxLine) yield line;
      }
      rest = '';
      start = nl + 1;
    }
    if (!skipping) {
      rest += text.slice(start);
      if (rest.length > maxLine) { rest = ''; skipping = true; }
    }
  }
  if (!skipping && rest) yield rest;
}

/** A log this server will not read (malformed, or past a bound): kept, and reported like any unreadable log. */
const refused = (name, why) => Object.assign(new Error(`could not read ${name} (${FORMAT_COLUMNS}): ${why}`), { code: 'CAN_LOG_REFUSED' });
const mb = (n) => (n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.round(n / 1024)} KB`);

// at most MAX_DECODERS workers at once (the indexer reads one log at a time; downloads may add a few)
let decoding = 0;
const queue = [];
async function decoderSlot() {
  if (decoding < MAX_DECODERS) { decoding++; return; }
  await new Promise((ok) => queue.push(ok)); // the slot is handed over as it is
}
function releaseSlot() {
  const next = queue.shift();
  if (next) next(); else decoding--;
}

/** The candump text of a whole columns body, decoded in a worker, in chunks taken as they are read. */
async function* decodeInWorker(name, parts, length, { heapMb = DECODE_HEAP_MB } = {}) {
  // a fresh buffer of its own (handed to the worker, never one of Node's shared pool)
  const ab = new ArrayBuffer(length);
  const u8 = new Uint8Array(ab);
  let at = 0;
  for (const p of parts) { u8.set(p, at); at += p.length; }
  parts.length = 0;
  await decoderSlot();
  const credit = new Int32Array(new SharedArrayBuffer(4));
  credit[0] = 2; // chunks the worker may send ahead of the reader
  let worker;
  try {
    worker = new Worker(path.join(__dirname, 'canColumnsWorker.js'), {
      workerData: { body: ab, credit: credit.buffer }, transferList: [ab], resourceLimits: { maxOldGenerationSizeMb: heapMb }
    });
  } catch (err) {
    releaseSlot();
    throw Object.assign(new Error(`the columns decoder could not be started for ${name}: ${err.message}`), { retry: true });
  }
  const inbox = [];
  let wake = null;
  const put = (m) => { inbox.push(m); if (wake) { wake(); wake = null; } };
  worker.on('message', put);
  worker.on('error', (err) => put({ error: err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? `it needs more than ${heapMb} MB to decode` : err.message }));
  worker.on('exit', (code) => put({ exit: code }));
  try {
    for (;;) {
      while (!inbox.length) await new Promise((ok) => { wake = ok; });
      const m = inbox.shift();
      if (m.chunk) {
        yield Buffer.from(m.chunk.buffer, m.chunk.byteOffset, m.chunk.byteLength);
        Atomics.add(credit, 0, 1);
        Atomics.notify(credit, 0);
      } else if (m.done) return;
      else if (m.error) throw refused(name, m.error);
      else throw refused(name, `the decoder stopped (exit ${m.exit})`);
    }
  } finally {
    await worker.terminate().catch(() => {});
    releaseSlot();
  }
}

/**
 * Open a stored log for reading. Nothing starts until chunks() or lines() is iterated (once).
 * - chunks(): the candump text, in Buffers (latin1 bytes as stored);
 * - lines({ maxLine }): its lines, without LF, bounded as above.
 * Stopping early (break, or a throw in the loop) stops xz and the decoder.
 * Throws while reading: xz (or the decoder) could not be started (`retry`: not the log's fault),
 * or a columns log refused (code CAN_LOG_REFUSED). After reading, `format` is the format found
 * (null for an empty file) and `truncated` is why a candump text log ended early, or null:
 * what was read before is good (a log cut off when the bridge lost power).
 */
function openCanLog(file, { xz = 'xz', maxUnpacked = MAX_UNPACKED, maxBody = MAX_COLUMNS_BODY, heapMb = DECODE_HEAP_MB } = {}) {
  const name = path.basename(file);
  const state = { format: null, truncated: null };
  async function* chunks() {
    const child = spawn(xz, ['-dc', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let spawnError = null;
    child.stderr.on('data', (c) => { if (stderr.length < 4096) stderr += c; });
    // how xz ended: its exit code, or null when it could not be started (no xz, no free process slot) or was stopped
    const exited = new Promise((ok) => {
      child.once('error', (err) => { spawnError = err; child.stdout.destroy(); ok(null); });
      child.once('close', (code) => ok(code));
    });
    const out = (async function* read() {
      try { for await (const c of child.stdout) yield c; } catch (err) { if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err; }
    }());
    let ended = false;
    try {
      let head = [];
      let headLen = 0;
      let columns = null; // null until the first bytes say which
      const body = [];
      let total = 0;
      let tooBig = false;
      for await (let c of out) {
        total += c.length;
        if (columns === null) {
          head.push(c);
          headLen += c.length;
          if (headLen < MAGIC.length) continue;
          c = Buffer.concat(head);
          head = null;
          columns = isColumns(c);
          state.format = columns ? FORMAT_COLUMNS : FORMAT_CANDUMP;
        }
        if (total > (columns ? maxBody : maxUnpacked)) { tooBig = true; child.kill(); break; }
        if (columns) body.push(c);
        else yield c;
      }
      if (columns === null && headLen) {
        // shorter than the magic: candump text (or nothing useful)
        state.format = FORMAT_CANDUMP;
        yield Buffer.concat(head);
      }
      const code = await exited;
      if (spawnError) throw Object.assign(new Error(`xz could not be started for ${name}: ${spawnError.message}`), { retry: true });
      const xzWhy = `${stderr.trim().slice(0, 200) || `exit ${code}`}`;
      if (columns) {
        // a columns body is all or nothing: cut off, it cannot be decoded
        if (tooBig) throw refused(name, `it unpacks to more than ${mb(maxBody)}, more than the CAN Bridge writes`);
        if (code !== 0) throw refused(name, `xz: ${xzWhy}`);
        let text = 0;
        for await (const t of decodeInWorker(name, body, total, { heapMb })) {
          text += t.length;
          if (text > maxUnpacked) throw refused(name, `it decodes to more than ${mb(maxUnpacked)}`);
          yield t;
        }
      } else if (code !== 0 || tooBig) {
        state.truncated = tooBig ? `it unpacks to more than ${mb(maxUnpacked)} (stopped there)` : xzWhy;
      }
      ended = true;
    } finally {
      // stopped early (or a failure): stop xz, which would wait for ever on its full pipe
      if (!ended && child.exitCode === null && child.signalCode === null) { child.kill(); child.stdout.destroy(); }
    }
  }
  return {
    chunks,
    lines: ({ maxLine = MAX_LINE } = {}) => boundedLines(chunks(), { maxLine, maxTotal: Infinity }),
    get format() { return state.format; },
    get truncated() { return state.truncated; }
  };
}

module.exports = { openCanLog, boundedLines, FORMATS, FORMAT_CANDUMP, FORMAT_COLUMNS, MAX_LINE, MAX_UNPACKED, MAX_COLUMNS_BODY, DECODE_HEAP_MB };
