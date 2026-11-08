'use strict';

// Decodes one columns log body (canbridge-columns-xz/2) off the main thread
// for canLogReader.js: a 48 MB body takes about 3 s, too long to hold up
// requests. The candump text goes back in chunks; each chunk waits for a
// credit from the reader (a shared counter), so a slow reader (the indexer)
// never has the whole text (several times the body) queued in memory.

const { parentPort, workerData } = require('worker_threads');
const { decodeColumns } = require('./canColumns');

const CHUNK = 256 * 1024;
const { body: ab, credit: sab } = workerData;
const credit = new Int32Array(sab);
const body = Buffer.from(ab);

function take() {
  for (;;) {
    const v = Atomics.load(credit, 0);
    if (v > 0) { if (Atomics.compareExchange(credit, 0, v, v - 1) === v) return; continue; }
    Atomics.wait(credit, 0, v, 1000); // the reader ends this worker when it stops reading
  }
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
