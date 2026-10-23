'use strict';

// The video codec of an MP4 from its header alone: the top-level box headers,
// then only the moov box (at the start or the end of the file), then the
// first video track's sample entry. A few small reads per clip, so discovery
// can tell an already-converted clip from an original without ffprobe and
// without waiting for an encode slot. Anything unexpected (not an MP4, cut
// off, a moov too large) answers null: the clip then takes the normal path.

const nodeFs = require('fs');

const MAX_MOOV_BYTES = 4 * 1024 * 1024;
const MAX_TOP_BOXES = 64;
// Two reads per clip as a rule: a small one at the start (ftyp and the next
// box header: the mdat's, or the moov's in a +faststart file), then the moov
// itself, which the read at the end of the file holds whole. Kept small: on a
// share every byte of 44,000 clips crosses the network.
const HEAD_READ_BYTES = 4 * 1024;
const MOOV_READ_BYTES = 128 * 1024;
const CODECS = Object.freeze({ avc1: 'h264', avc3: 'h264', hvc1: 'h265', hev1: 'h265', av01: 'av1' });

function cancelled() {
  return Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
}

// Box headers in buffer[start, end): { type, start (payload), end }. Stops at
// the first header that does not fit, so a damaged box never reads past it.
function childBoxes(buffer, start, end) {
  const boxes = [];
  let at = start;
  while (at + 8 <= end) {
    let size = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      const large = buffer.readBigUInt64BE(at + 8);
      if (large > BigInt(end - at)) break;
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    boxes.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return boxes;
}

function findChild(buffer, box, type) {
  return childBoxes(buffer, box.start, box.end).find((child) => child.type === type) || null;
}

/** The sample entry fourcc of the first video track in a moov payload, or null. */
function videoSampleEntry(moov) {
  if (!Buffer.isBuffer(moov)) return null;
  for (const trak of childBoxes(moov, 0, moov.length)) {
    if (trak.type !== 'trak') continue;
    const mdia = findChild(moov, trak, 'mdia');
    if (!mdia) continue;
    // hdlr: version/flags (4), pre_defined (4), handler_type (4)
    const hdlr = findChild(moov, mdia, 'hdlr');
    if (!hdlr || hdlr.end - hdlr.start < 12 || moov.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'vide') continue;
    const minf = findChild(moov, mdia, 'minf');
    const stbl = minf ? findChild(moov, minf, 'stbl') : null;
    const stsd = stbl ? findChild(moov, stbl, 'stsd') : null;
    // stsd: version/flags (4), entry_count (4), then the first entry's size (4) and type (4)
    if (!stsd || stsd.end - stsd.start < 16 || moov.readUInt32BE(stsd.start + 4) < 1) return null;
    const entrySize = moov.readUInt32BE(stsd.start + 8);
    if (entrySize < 8 || stsd.start + 8 + entrySize > stsd.end) return null;
    return moov.toString('latin1', stsd.start + 12, stsd.start + 16);
  }
  return null;
}

function codecForSampleEntry(entry) {
  return Object.prototype.hasOwnProperty.call(CODECS, entry) ? CODECS[entry] : null;
}

/**
 * Reads the first video sample entry of an MP4 file: 'avc1', 'hvc1', 'av01',
 * another fourcc, or null when the header cannot be read as an MP4.
 * options: { fs (promises API), size (bytes, when the caller already knows
 * them), signal, maxMoovBytes }. Filesystem errors (a share that is down) are
 * thrown so the caller can wait for the share; a bad file is never an error.
 */
async function readVideoSampleEntry(filePath, options = {}) {
  const fs = options.fs || nodeFs.promises;
  const signal = options.signal;
  const maxMoovBytes = options.maxMoovBytes || MAX_MOOV_BYTES;
  if (signal?.aborted) throw cancelled();
  const handle = await fs.open(filePath, 'r');
  try {
    let size = Number.isSafeInteger(options.size) && options.size >= 0 ? options.size : null;
    if (size === null) size = Number((await handle.stat()).size);
    if (!Number.isSafeInteger(size) || size < 8) return null;
    const read = async (position, length) => {
      if (signal?.aborted) throw cancelled();
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - position)));
      let filled = 0;
      // A short read is not the end of the file on every filesystem (SMB).
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, position + filled);
        if (!bytesRead) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    };
    let chunk = await read(0, HEAD_READ_BYTES);
    let chunkAt = 0;
    let at = 0;
    for (let index = 0; index < MAX_TOP_BOXES && at + 8 <= size; index += 1) {
      // The next header comes from the chunk already read when it is there.
      if (at < chunkAt || at + 16 > chunkAt + chunk.length) {
        chunk = await read(at, MOOV_READ_BYTES);
        chunkAt = at;
        if (chunk.length < 8) return null;
      }
      const offset = at - chunkAt;
      let boxSize = chunk.readUInt32BE(offset);
      const type = chunk.toString('latin1', offset + 4, offset + 8);
      let header = 8;
      if (boxSize === 1) {
        if (chunk.length < offset + 16) return null;
        const large = chunk.readBigUInt64BE(offset + 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        boxSize = Number(large);
        header = 16;
      } else if (boxSize === 0) {
        boxSize = size - at; // the last box runs to the end of the file
      }
      if (boxSize < header || at + boxSize > size) return null; // cut off or damaged
      if (type === 'moov') {
        const length = boxSize - header;
        if (length > maxMoovBytes) return null;
        const start = at + header;
        const moov = start >= chunkAt && start + length <= chunkAt + chunk.length
          ? chunk.subarray(start - chunkAt, start - chunkAt + length)
          : await read(start, length);
        if (moov.length !== length) return null;
        return videoSampleEntry(moov);
      }
      at += boxSize;
    }
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** 'h264', 'h265', 'av1', or null (any other or unreadable sample entry). */
async function readMp4VideoCodec(filePath, options = {}) {
  return codecForSampleEntry(await readVideoSampleEntry(filePath, options));
}

module.exports = {
  MAX_MOOV_BYTES,
  codecForSampleEntry,
  readMp4VideoCodec,
  readVideoSampleEntry,
  videoSampleEntry
};
