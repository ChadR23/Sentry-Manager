#!/usr/bin/env node
'use strict';
// Reference decoder for the CAN Bridge's `canbridge-columns-xz/2` logs (spec: docs/sentry-manager-format.md,
// "Columns format"). Gives back the exact candump text a `canbridge-candump-xz/1` log of the same frames holds.
// Node only, no dependencies; Sentry Manager may copy this file as it is.
//
//   xz -dc LOG.log.xz | node tools/columns-to-candump.js > LOG.log
//   node tools/columns-to-candump.js LOG.log.xz > LOG.log        (runs xz -dc itself)
//
// A candump text log (it starts with "# canbridge v1") is passed through unchanged, so both formats can be fed in.
//
// Copied unchanged (apart from this note) from the CAN Bridge repository (SMO), tools/columns-to-candump.js at
// commit db853c8, as its own header allows. Sentry Six Manager reads it through canLogReader.js (off the main
// thread, in canColumnsWorker.js); fix it there first, then copy it again.

const MAGIC = Buffer.from('CANBRIDGE-COLUMNS/2\n', 'ascii');
const MAX_KEYS = 65536;
const MAX_KEY_BYTES = 64;
const MAX_DATA = 64;
const MAX_LINE = 65536;
const MAX_TIME_US = 999999999999999999n;

function isColumns(buf) {
  return buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * Decodes a whole columns body (the bytes after xz -dc) and calls onLine(text) for each line, without its LF, in the
 * original order. Throws on anything malformed; never allocates more than a small multiple of the body's size.
 */
function decodeColumns(body, onLine) {
  if (!isColumns(body)) throw new Error('not a columns log');
  let pos = MAGIC.length;
  const byte = () => { if (pos >= body.length) throw new Error('cut off'); return body[pos++]; };
  const varint = () => {               // unsigned LEB128, up to 64 bits, as a BigInt
    let v = 0n, shift = 0n;
    for (;;) {
      if (shift > 63n) throw new Error('varint too long');
      const c = byte();
      v |= BigInt(c & 0x7f) << shift;
      if ((c & 0x80) === 0) return v;
      shift += 7n;
    }
  };
  const small = () => {                // varints that fit a JS number (counts, indexes)
    let v = 0, mul = 1;
    for (let i = 0; ; i++) {
      if (i > 7) throw new Error('number too large');
      const c = byte();
      v += (c & 0x7f) * mul;
      if ((c & 0x80) === 0) return v;
      mul *= 128;
    }
  };
  const count = (max) => { const n = small(); if (n > max) throw new Error(`count ${n} out of range`); return n; };
  const bytes = (n) => { if (n > body.length - pos) throw new Error('cut off'); const b = body.subarray(pos, pos + n); pos += n; return b; };

  const keyCount = count(MAX_KEYS);
  const keys = [];
  for (let k = 0; k < keyCount; k++) keys.push(bytes(count(MAX_KEY_BYTES)).toString('latin1'));
  const noteCount = count(body.length);
  const notePos = new Array(noteCount), notes = new Array(noteCount);
  for (let j = 0; j < noteCount; j++) {
    notePos[j] = small();
    if (j > 0 && notePos[j] < notePos[j - 1]) throw new Error('notes out of order');
    notes[j] = bytes(count(MAX_LINE));
  }
  const frames = count(Math.floor((body.length - pos) / 3));   // each frame takes at least 3 bytes
  if (noteCount > 0 && notePos[noteCount - 1] > frames) throw new Error('note after the last frame');

  const sec = new Array(frames), usec = new Int32Array(frames);
  let t = 0n;
  for (let f = 0; f < frames; f++) {
    const z = varint();
    t += (z & 1n) ? -((z >> 1n) + 1n) : (z >> 1n);   // zigzag
    if (t < 0n || t > MAX_TIME_US) throw new Error('time out of range');
    sec[f] = (t / 1000000n).toString();
    usec[f] = Number(t % 1000000n);
  }
  const keyOf = new Int32Array(frames);
  for (let f = 0; f < frames; f++) { const k = small(); if (k >= keyCount) throw new Error('bad key index'); keyOf[f] = k; }

  // Frames grouped by key, in their original order within each key.
  const start = new Int32Array(keyCount + 1);
  for (let f = 0; f < frames; f++) start[keyOf[f] + 1]++;
  for (let k = 0; k < keyCount; k++) start[k + 1] += start[k];
  const fill = start.slice(0, keyCount);
  const order = new Int32Array(frames);
  for (let f = 0; f < frames; f++) order[fill[keyOf[f]]++] = f;

  const lens = new Uint8Array(frames);
  for (let x = 0; x < frames; x++) { const n = byte(); if (n > MAX_DATA) throw new Error('data too long'); lens[order[x]] = n; }
  const at = new Int32Array(frames);
  let total = 0;
  for (let f = 0; f < frames; f++) { at[f] = total; total += lens[f]; }
  if (total > body.length - pos) throw new Error('data cut off');
  const data = new Uint8Array(total);
  for (let k = 0; k < keyCount; k++) {
    let longest = 0;
    for (let x = start[k]; x < start[k + 1]; x++) longest = Math.max(longest, lens[order[x]]);
    for (let j = 0; j < longest; j++) {
      for (let x = start[k]; x < start[k + 1]; x++) {
        const f = order[x];
        if (lens[f] > j) data[at[f] + j] = byte();
      }
    }
  }
  if (pos !== body.length) throw new Error('trailing bytes');

  const HEX = '0123456789ABCDEF';
  let note = 0;
  for (let f = 0; f <= frames; f++) {
    while (note < noteCount && notePos[note] === f) onLine(notes[note++].toString('latin1'));
    if (f === frames) break;
    let hex = '';
    for (let j = 0; j < lens[f]; j++) { const v = data[at[f] + j]; hex += HEX[v >> 4] + HEX[v & 15]; }
    onLine(`(${sec[f]}.${String(usec[f]).padStart(6, '0')}) ${keys[keyOf[f]]}#${hex}`);
  }
}

module.exports = { MAGIC, isColumns, decodeColumns };

if (require.main === module) {
  const { spawnSync } = require('child_process');
  const file = process.argv[2];
  let body;
  if (file) {
    const r = spawnSync('xz', ['-dc', file], { maxBuffer: 4 << 30 });
    if (r.error || r.status !== 0) { process.stderr.write(`xz -dc ${file} failed: ${r.error ? r.error.message : r.stderr}\n`); process.exit(1); }
    body = r.stdout;
  } else {
    body = require('fs').readFileSync(0);
  }
  if (!isColumns(body)) { process.stdout.write(body); return; }
  const out = [];
  let size = 0;
  const flush = () => { process.stdout.write(out.join(''), 'latin1'); out.length = 0; size = 0; };   // bytes as stored
  decodeColumns(body, (line) => { out.push(line, '\n'); size += line.length; if (size > 1 << 20) flush(); });
  flush();
}
