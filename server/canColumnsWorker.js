'use strict';

// Decodes one columns log body (canbridge-columns-xz/2) off the main thread
// for canLogReader.js: a 48 MB body takes about 3 s, too long to hold up
// requests. The candump text goes back in chunks; each chunk waits for a
// credit from the reader (a shared counter), so a slow reader (the indexer)
// never has the whole text (several times the body) queued in memory.
// Before decoding, the frame count in the body's header is checked against
// maxFrames: the decoder's typed arrays (about 17 bytes a frame) are outside
// the worker's heap limit, so a body claiming millions of tiny frames is
// refused before any of them is allocated.

const { parentPort, workerData } = require('worker_threads');
const { MAGIC, decodeColumns } = require('./canColumns');

const CHUNK = 256 * 1024;
const { body: ab, credit: sab, maxFrames } = workerData;
const credit = new Int32Array(sab);
const body = Buffer.from(ab);

function take() {
  for (;;) {
    const v = Atomics.load(credit, 0);
    if (v > 0) { if (Atomics.compareExchange(credit, 0, v, v - 1) === v) return; continue; }
    Atomics.wait(credit, 0, v, 1000); // the reader ends this worker when it stops reading
  }
}

/**
 * The frame count a columns body says it holds (its header read the way canColumns.js reads it:
 * keys, notes, then the count), or a malformed header left to the decoder to report (-1).
 */
function frameCount(b) {
  let pos = MAGIC.length;
  const small = () => {
    let v = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      if (pos >= b.length) return -1;
      const c = b[pos++];
      v += (c & 0x7f) * mul;
      if ((c & 0x80) === 0) return v;
      mul *= 128;
    }
    return -1;
  };
  const keys = small();
  if (keys < 0) return -1;
  for (let k = 0; k < keys; k++) { const n = small(); if (n < 0 || n > b.length - pos) return -1; pos += n; }
  const notes = small();
  if (notes < 0) return -1;
  for (let j = 0; j < notes; j++) {
    if (small() < 0) return -1;
    const n = small();
    if (n < 0 || n > b.length - pos) return -1;
    pos += n;
  }
  return small();
}

let out = [];
let size = 0;
const flush = () => {
  if (!size) return;
  take();
  parentPort.postMessage({ chunk: Buffer.from(out.join(''), 'latin1') });
  out = [];
  size = 0;
};
try {
  const frames = frameCount(body);
  if (frames > maxFrames) throw new Error(`it holds ${frames.toLocaleString('en')} frames, more than the ${maxFrames.toLocaleString('en')} a log of the CAN Bridge can`);
  decodeColumns(body, (line) => {
    out.push(line, '\n');
    size += line.length + 1;
    if (size >= CHUNK) flush();
  });
  flush();
  parentPort.postMessage({ done: true });
} catch (err) {
  parentPort.postMessage({ error: String(err?.message || err).slice(0, 200) });
}
