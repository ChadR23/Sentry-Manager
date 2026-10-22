'use strict';

// The video codec of an MP4, read from its header (the moov box) without
// decoding anything: a few small reads per file, so it is cheap even on a
// share. Footage lists use it to show which recordings are already encoded
// (H.265 / AV1) and which are still Tesla's original H.264.

const fsp = require('fs/promises');

const MAX_TOP_BOXES = 64;
const MAX_MOOV = 16 * 1024 * 1024;
const CODECS = { avc1: 'h264', avc3: 'h264', hvc1: 'h265', hev1: 'h265', av01: 'av1' };
const CONTAINERS = new Set(['trak', 'mdia', 'minf', 'stbl']);

/** Child boxes of buf[start, end): [{ type, start (payload), end }]. */
function boxes(buf, start, end) {
  const out = [];
  let at = start;
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

/** The codec of the first video track in a moov payload, or null. */
function codecFromMoov(buf) {
  for (const trak of boxes(buf, 0, buf.length).filter((b) => b.type === 'trak')) {
    const found = { video: false, entry: null };
    const walk = (start, end) => {
      for (const b of boxes(buf, start, end)) {
        // hdlr: version/flags (4), pre_defined (4), handler_type (4)
        if (b.type === 'hdlr' && b.end - b.start >= 12) found.video = buf.toString('latin1', b.start + 8, b.start + 12) === 'vide';
        // stsd: version/flags (4), entry_count (4), then the first sample entry box
        else if (b.type === 'stsd' && b.end - b.start >= 16) found.entry = buf.toString('latin1', b.start + 12, b.start + 16);
        else if (CONTAINERS.has(b.type)) walk(b.start, b.end);
      }
    };
    walk(trak.start, trak.end);
    if (found.video && found.entry) return CODECS[found.entry] || found.entry;
  }
  return null;
}

/**
 * 'h264', 'h265', 'av1', another sample entry name, or null when the file
 * has no readable moov (not an MP4, still being written, truncated).
 */
async function videoCodec(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(16);
    let at = 0;
    for (let i = 0; i < MAX_TOP_BOXES && at + 8 <= size; i++) {
      const { bytesRead } = await fh.read(head, 0, 16, at);
      if (bytesRead < 8) return null;
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let header = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) return null;
        boxSize = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (boxSize === 0) {
        boxSize = size - at;
      }
      if (boxSize < header) return null;
      if (type === 'moov') {
        const len = Math.min(boxSize - header, MAX_MOOV);
        const moov = Buffer.alloc(len);
        const r = await fh.read(moov, 0, len, at + header);
        return codecFromMoov(moov.subarray(0, r.bytesRead));
      }
      at += boxSize;
    }
    return null;
  } finally {
    await fh.close();
  }
}

module.exports = { videoCodec, codecFromMoov };
