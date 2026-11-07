'use strict';

// A clip's speed, one value a second, without reading the whole clip.
//
// The viewer's speed graph needs a speed a second, not the dashboard's every
// frame. Reading the clip for the dashboard (server/telemetry.js) loads the
// whole file (~80 MB a minute) to pull a record out of each frame; here only
// the file's index (moov) and the first few KB of one frame a second are read,
// as Tesla writes each frame's telemetry record ahead of its picture. A
// converted clip keeps the records the same way: H.265 in a compatibility
// record in each frame, AV1 all together in a first media box (read whole,
// it holds only the records).
//
// Anything unexpected throws, and the caller reads the clip the slow way.

const fsp = require('fs/promises');
const { parseMp4, selectVideoTrack, buildSampleIndex, findBoxes } = require('../src/main/converter/mp4');

const HEAD = 4096;
const MAX_MOOV = 64 * 1024 * 1024;
const MAX_CARRIER = 16 * 1024 * 1024;

/** The speed (field 4, float, m/s) in a record's protobuf bytes, or null. */
function speedOfBytes(buf) {
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

/**
 * The fields the indexes use from a record's protobuf bytes: speed (4, m/s),
 * latitude and longitude (11, 12, degrees) and acceleration along and across
 * the car (14, 15, m/s²); null for a record that cannot be read.
 */
function sampleOfBytes(buf) {
  const out = { v: null, lat: null, lon: null, ax: null, ay: null };
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
        if (p + 4 > buf.length) break;
        if (field === 4) out.v = buf.readFloatLE(p);
        p += 4;
      } else if (type === 1) {
        if (p + 8 > buf.length) break;
        const d = buf.readDoubleLE(p);
        if (field === 11) out.lat = d;
        else if (field === 12) out.lon = d;
        else if (field === 14) out.ax = d;
        else if (field === 15) out.ay = d;
        p += 8;
      } else if (type === 0) vint();
      else if (type === 2) p += vint();
      else break;
    }
  } catch { /* a short record: what was read */ }
  for (const k of Object.keys(out)) if (out[k] !== null && !Number.isFinite(out[k])) out[k] = null;
  return out;
}

/** Tesla's protobuf inside an SEI NAL (06 05 size 42.. 69 payload 80), or null (dashcam-mp4.js seiPayload). */
function teslaPayload(nal) {
  if (nal.length < 6 || (nal[0] & 31) !== 6 || nal[1] !== 5 || nal[nal.length - 1] !== 0x80) return null;
  const rbsp = [];
  let zeros = 0;
  for (let i = 1; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    rbsp.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  let i = 1;
  let size = 0;
  while (i < rbsp.length && rbsp[i] === 255) { size += 255; i++; }
  if (i >= rbsp.length) return null;
  size += rbsp[i++];
  if (size !== rbsp.length - i - 1) return null;
  const prefix = i;
  while (i < rbsp.length && rbsp[i] === 0x42) i++;
  if (i === prefix || rbsp[i++] !== 0x69 || i >= rbsp.length - 1) return null;
  return Buffer.from(rbsp.slice(i, rbsp.length - 1));
}

/** The NAL records in buf (length-prefixed); a record cut off by the end of buf ends the list. */
function nals(buf, lengthSize) {
  const out = [];
  for (let p = 0; p + lengthSize <= buf.length;) {
    let len = 0;
    for (let k = 0; k < lengthSize; k++) len = len * 256 + buf[p + k];
    p += lengthSize;
    if (!len) throw new Error('zero-length NAL record');
    if (p + len > buf.length) { out.cut = true; break; }
    out.push(buf.subarray(p, p + len));
    p += len;
  }
  return out;
}

const isMarker = (nal) => nal.length === 3 && nal[0] === 0x61 && nal[1] === 0x01 && nal[2] === 0x80;

/** A frame's telemetry record (protobuf bytes) from its NAL records; undefined when the picture came first. */
function recordIn(list, codec) {
  for (const nal of list) {
    if (codec === 'avc1') {
      const type = nal[0] & 31;
      if (type === 6) { const p = teslaPayload(nal); if (p) return p; }
      else if (type === 1 || type === 5) return null; // records come before the picture
    } else if (nal.length >= 2 && nal[0] === 0x66 && nal[1] === 0x01) {
      const p = teslaPayload(Buffer.concat([Buffer.from([6, 5]), nal.subarray(2)]));
      if (p) return p;
    }
  }
  return undefined;
}

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  let at = 0;
  while (at < len) {
    const { bytesRead } = await fh.read(buf, at, len - at, pos + at);
    if (!bytesRead) throw new Error('The clip ended early');
    at += bytesRead;
  }
  return buf;
}

/** The top-level boxes from their headers alone: [{ type, start, size, header }]. */
async function topBoxes(fh, fileSize) {
  const out = [];
  for (let pos = 0; pos < fileSize;) {
    const h = await readAt(fh, pos, Math.min(16, fileSize - pos));
    if (h.length < 8) throw new Error('Truncated box header');
    let size = h.readUInt32BE(0);
    const type = h.toString('ascii', 4, 8);
    let header = 8;
    if (size === 1) {
      if (h.length < 16) throw new Error('Truncated box header');
      size = Number(h.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) size = fileSize - pos;
    if (size < header || pos + size > fileSize) throw new Error(`Invalid ${type} box`);
    out.push({ type, start: pos, size, header, bytes: h.subarray(0, header) });
    pos += size;
    if (out.length > 64) throw new Error('Too many top-level boxes');
  }
  return out;
}

/** One speed a second (m/s; null for a second without a record) for the clip at real. */
async function readRecords(real) {
  const fh = await fsp.open(real, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    const top = await topBoxes(fh, fileSize);
    const moov = top.find((b) => b.type === 'moov');
    if (!moov || moov.size > MAX_MOOV) throw new Error('No usable moov');
    // the file as the parser sees it: every box header, moov whole, media left empty
    const image = Buffer.alloc(fileSize);
    for (const b of top) b.bytes.copy(image, b.start);
    (await readAt(fh, moov.start, moov.size)).copy(image, moov.start);
    const tree = parseMp4(image);
    const track = selectVideoTrack(tree);
    const samples = buildSampleIndex(track);
    if (!samples.length) return [];
    const mdhd = findBoxes(track, 'mdhd')[0];
    const md = image.subarray(Number(mdhd.contentStart), Number(mdhd.end));
    const scale = md[0] === 1 ? md.readUInt32BE(20) : md.readUInt32BE(12);
    if (!scale) throw new Error('No timescale');
    const stsd = findBoxes(track, 'stsd')[0];
    const desc = image.subarray(Number(stsd.contentStart), Number(stsd.end));
    const codec = desc.toString('ascii', 12, 16);
    let lengthSize = 4;
    const cfgAt = desc.indexOf(codec === 'avc1' ? 'avcC' : 'hvcC');
    if (cfgAt >= 0 && codec === 'avc1') lengthSize = (desc[cfgAt + 8] & 3) + 1;
    else if (cfgAt >= 0 && (codec === 'hvc1' || codec === 'hev1')) lengthSize = (desc[cfgAt + 25] & 3) + 1;
    else if (codec !== 'av01') throw new Error(`Unsupported codec ${codec}`);

    // the first frame of each second
    const picks = [];
    for (const s of samples) {
      const sec = Math.floor(Number(s.dts) / scale);
      if (sec > 7200) break;
      if (picks[sec] === undefined) picks[sec] = s;
    }

    let carrier = null;
    if (codec === 'av01') {
      // the records sit in the first mdat, each frame's ended by a picture marker
      const mdats = top.filter((b) => b.type === 'mdat');
      if (mdats.length < 2 || mdats[0].size > MAX_CARRIER) throw new Error('No AV1 telemetry carrier');
      const groups = [];
      let pending = null;
      for (const nal of nals(await readAt(fh, mdats[0].start + mdats[0].header, mdats[0].size - mdats[0].header), 4)) {
        if (isMarker(nal)) { groups.push(pending); pending = null; } else pending = teslaPayload(nal) || pending;
      }
      if (groups.length !== samples.length) throw new Error('AV1 carrier does not match the frames');
      carrier = groups;
    }

    const out = [];
    for (let sec = 0; sec < picks.length; sec++) {
      const s = picks[sec];
      if (!s) { out.push(null); continue; }
      let rec;
      if (carrier) rec = carrier[s.index];
      else {
        const offset = Number(s.offset);
        let list = nals(await readAt(fh, offset, Math.min(s.size, HEAD)), lengthSize);
        rec = recordIn(list, codec);
        if (rec === undefined && list.cut) {
          list = nals(await readAt(fh, offset, s.size), lengthSize);
          rec = recordIn(list, codec);
        }
      }
      out.push(rec || null);
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** One speed a second (m/s, null where a second has none), or null for none at all. */
async function readSpeeds(real) {
  const out = (await readRecords(real)).map((rec) => {
    const v = rec ? speedOfBytes(rec) : null;
    return v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
  });
  return out.some((v) => v !== null) ? out : null;
}

/** The record of each second as sampleOfBytes reads it (null where none), or null for none at all. */
async function readSamples(real) {
  const out = (await readRecords(real)).map((rec) => (rec ? sampleOfBytes(rec) : null));
  return out.some((x) => x && x.v !== null) ? out : null;
}

module.exports = { readSpeeds, readSamples, speedOfBytes, sampleOfBytes, teslaPayload };
