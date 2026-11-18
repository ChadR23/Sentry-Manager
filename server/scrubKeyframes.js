'use strict';

// The scrub preview of a clip with a keyframe every second or so (Tesla's
// own clips), made from its keyframes alone, without reading the rest of the
// clip: the sample table (moov) says where each keyframe is and when it is
// shown, only those samples are read, and FFmpeg gets them as an H.264
// stream of one picture per second. FFmpeg's own way (`-skip_frame nokey` on
// the whole file, then fps=1) decodes the same keyframes but reads every byte
// of the clip; this reads about a sixth of it and makes the same grid, byte
// for byte (test/scrubKeyframes.test.js).
//
// Which keyframe shows second n is worked out the way FFmpeg's fps filter
// (round=near, eof_action=pass) picks it: each keyframe belongs to the second
// its time rounds to, a second shows the last keyframe that belongs to it or
// to an earlier second, the first second shown is the first keyframe's, and
// the seconds end where the last keyframe ends (rounded up). Keyframes after
// the edit list's end are left out, as FFmpeg leaves them out.
//
// The sample table also gives the longest gap between keyframes, so no
// ffprobe pass over every packet is needed to choose this way or the other.
// A clip this cannot read (not an MP4 the parser takes, an edit list it does
// not take, no video track) answers null, and the caller does as before.

const fsp = require('fs/promises');
const path = require('path');

const { parseMp4Parts, selectVideoTrack, buildSampleIndex, findBoxes, boxContent, sampleTable } = require(path.join(__dirname, '..', 'src', 'main', 'converter', 'mp4'));

const MAX_MOOV = 64 * 1024 * 1024;
const MAX_TOP_BOXES = 64;
const START_CODE = Buffer.from([0, 0, 0, 1]);

async function readAt(fh, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

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
    if (out.length > MAX_TOP_BOXES) throw new Error('Too many top-level boxes');
  }
  return out;
}

const timescaleOf = (content) => (content[0] === 1 ? content.readUInt32BE(20) : content.readUInt32BE(12));

/** SPS and PPS from an avcC box's content, and its NAL length size. */
function avcConfig(desc) {
  const at = desc.indexOf('avcC');
  if (at < 4) return null;
  const c = at + 4;
  const lengthSize = (desc[c + 4] & 3) + 1;
  const sets = [];
  let p = c + 5;
  const sps = desc[p++] & 31;
  for (let i = 0; i < sps; i++) { const n = desc.readUInt16BE(p); sets.push(Buffer.from(desc.subarray(p + 2, p + 2 + n))); p += 2 + n; }
  const pps = desc[p++];
  for (let i = 0; i < pps; i++) { const n = desc.readUInt16BE(p); sets.push(Buffer.from(desc.subarray(p + 2, p + 2 + n))); p += 2 + n; }
  if (!sets.length || p > desc.length || lengthSize === 3) return null;
  return { lengthSize, sets };
}

// round half away from zero, as av_rescale_q_rnd(AV_ROUND_NEAR_INF)
const roundNear = (x) => (x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5));

/** The keyframe for each second shown, in order (see the top of this file). */
function picksFor(keys, scale, editEnd) {
  const shown = keys.filter((k) => editEnd === null || k.pts < editEnd).sort((a, b) => a.pts - b.pts);
  if (!shown.length) return [];
  const second = (k) => roundNear(k.pts / scale);
  const last = shown.at(-1);
  const end = Math.ceil((last.pts + last.duration) / scale);
  const picks = [];
  let j = 0;
  for (let t = second(shown[0]); t < end && picks.length < 7200; t++) {
    while (j + 1 < shown.length && second(shown[j + 1]) <= t) j++;
    picks.push(shown[j]);
  }
  return picks;
}

/**
 * What the sample table says about a clip: { gap } (the longest gap between
 * keyframes, seconds) and, for H.264, { picks, write } to make the grid from
 * the keyframes alone. null when the clip cannot be read this way.
 */
async function keyframePlan(videoPath) {
  let fh;
  try {
    fh = await fsp.open(videoPath, 'r');
    const { size: fileSize } = await fh.stat();
    const top = await topBoxes(fh, fileSize);
    const moov = top.find((b) => b.type === 'moov');
    if (!moov || moov.size > MAX_MOOV) throw new Error('No usable moov');
    const parts = top.filter((b) => b !== moov).map((b) => ({ start: b.start, bytes: b.bytes }));
    parts.push({ start: moov.start, bytes: await readAt(fh, moov.start, moov.size) });
    const tree = parseMp4Parts(fileSize, parts);
    const track = selectVideoTrack(tree);
    const samples = buildSampleIndex(track);
    if (!samples.length) throw new Error('No samples');
    const scale = timescaleOf(boxContent(tree, findBoxes(track, 'mdhd')[0]));
    if (!scale) throw new Error('No timescale');
    const stss = (sampleTable(track).children || []).filter((c) => c.type === 'stss');
    if (stss.length > 1) throw new Error('Duplicate stss');
    let syncIndexes;
    if (stss.length) {
      const p = boxContent(tree, stss[0]);
      const count = p.readUInt32BE(4);
      if (p.length < 8 + count * 4) throw new Error('Truncated stss');
      syncIndexes = [];
      for (let i = 0; i < count; i++) { const n = p.readUInt32BE(8 + i * 4); if (n >= 1 && n <= samples.length) syncIndexes.push(n - 1); }
    } else syncIndexes = samples.map((s) => s.index);
    const keys = syncIndexes.map((i) => samples[i]).map((s) => ({ index: s.index, pts: Number(s.pts), duration: Number(s.duration), offset: Number(s.offset), size: s.size }));
    if (!keys.length) throw new Error('No keyframe');
    // the longest gap between keyframes, in packet order (as ffprobe lists them)
    let gap = 0;
    for (let i = 1; i < keys.length; i++) gap = Math.max(gap, (keys[i].pts - keys[i - 1].pts) / scale);
    // the edit list's end, on the track's clock (parseMp4Parts takes only one zero-based entry)
    let editEnd = null;
    const elst = findBoxes(track, 'elst')[0];
    if (elst) {
      const e = boxContent(tree, elst);
      const movieScale = timescaleOf(boxContent(tree, findBoxes(tree, 'mvhd')[0]));
      const segment = e[0] === 1 ? Number(e.readBigUInt64BE(8)) : e.readUInt32BE(8);
      if (movieScale && segment) editEnd = (segment * scale) / movieScale;
    }
    const desc = boxContent(tree, findBoxes(track, 'stsd')[0]);
    const config = desc.toString('ascii', 12, 16) === 'avc1' ? avcConfig(desc) : null;
    if (!config) { await fh.close(); fh = null; return { gap, picks: null, write: null }; }
    const picks = picksFor(keys, scale, editEnd);
    const handle = fh;
    fh = null;
    /** Write the picked keyframes to `out` (a writable stream) as H.264 with start codes, then end it. */
    const write = async (out) => {
      const drained = () => new Promise((resolve) => {
        const done = () => { out.off('drain', done); out.off('close', done); resolve(); };
        out.on('drain', done);
        out.on('close', done);
      });
      try {
        let last = null;
        for (const k of picks) {
          if (out.destroyed) return;
          if (!last || last.index !== k.index) last = { index: k.index, data: await readAt(handle, k.offset, k.size) };
          const chunks = [];
          for (const set of config.sets) chunks.push(START_CODE, set);
          const data = last.data;
          for (let p = 0; p + config.lengthSize <= data.length;) {
            const n = data.readUIntBE(p, config.lengthSize);
            p += config.lengthSize;
            if (n === 0 || p + n > data.length) break;
            chunks.push(START_CODE, data.subarray(p, p + n));
            p += n;
          }
          if (!out.write(Buffer.concat(chunks))) await drained();
        }
      } finally {
        await handle.close().catch(() => {});
        if (!out.destroyed) out.end();
      }
    };
    return { gap, picks, write, close: () => handle.close().catch(() => {}) };
  } catch (_) {
    if (fh) await fh.close().catch(() => {});
    return null;
  }
}

module.exports = { keyframePlan, picksFor };
