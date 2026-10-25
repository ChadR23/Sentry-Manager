'use strict';

// Tesla's encoder now and then skips a frame: the next picture's frame_num
// jumps, although the stream's SPS says no gaps are allowed. FFmpeg (every
// decoder the converter uses goes through its H.264 decoder) logs "Frame num
// gap", fills the gap with a copy of the previous picture and decodes on.
// Where the skipped numbers include the wrap of frame_num back to 0, its gap
// filling misses the wrap: the picture after the gap gets a picture order
// count lower than the picture before it and is never output. Such a clip's
// encode legitimately has one frame fewer than the original.
//
// This module proves which samples those are from the bitstream alone,
// without decoding: the SPS from the avcC box and, per sample, the first
// slice header. The output then keeps the original's timing with each
// dropped sample's duration added to the frame before it (leadIn.js), and
// the verifier expects exactly that many frames fewer.
//
// Only the case seen on real clips and reproduced with FFmpeg is excused:
// picture order count type 2 (from frame_num), frames only, every picture a
// reference, the dropped picture followed directly by an IDR. Anything else
// (gaps allowed, other order count types, field pictures, several parameter
// sets, a slice header that does not parse, a memory-management reset, a gap
// whose picture is followed by more pictures before the next IDR) makes the
// answer "unknown": no frame is excused and the clip is verified exactly as
// before. A gap FFmpeg conceals (no wrap) excuses nothing either: every
// frame is decoded.

const { removeEmulationPreventionBytes } = require('./teslaSei');

const UINT32_MAX = 0xffffffff;
// Slice headers sit at the very start of a NAL unit; only this much of each
// is unescaped (the whole unit when a header would run past it).
const HEADER_BYTES = 256;
// Profiles whose SPS carries chroma format, bit depths and scaling lists.
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function gapError(message) {
  const error = new Error(message);
  error.code = 'UNSUPPORTED_H264';
  return error;
}

function bitReader(rbsp) {
  let position = 0;
  const bit = () => {
    if (position >= rbsp.length * 8) throw Object.assign(gapError('Header runs past its data'), { truncated: true });
    const value = (rbsp[position >> 3] >> (7 - (position & 7))) & 1;
    position += 1;
    return value;
  };
  const u = (bits) => {
    let value = 0;
    for (let index = 0; index < bits; index += 1) value = value * 2 + bit();
    return value;
  };
  const ue = () => {
    let zeros = 0;
    while (bit() === 0) {
      zeros += 1;
      if (zeros > 31) throw gapError('Exp-Golomb code is too long');
    }
    return 2 ** zeros - 1 + u(zeros);
  };
  const se = () => {
    const value = ue();
    return value % 2 === 1 ? (value + 1) / 2 : -(value / 2);
  };
  return { u, ue, se };
}

// Parse a NAL unit's payload with its emulation-prevention bytes removed:
// the first bytes, or the whole unit when the header is longer.
function withRbsp(nal, parse) {
  if (nal.length > 1 + HEADER_BYTES) {
    const head = removeEmulationPreventionBytes(nal.subarray(1, 1 + HEADER_BYTES));
    if (head) {
      try { return parse(bitReader(head)); } catch (error) { if (!error.truncated) throw error; }
    }
  }
  const rbsp = removeEmulationPreventionBytes(nal.subarray(1));
  if (!rbsp) throw gapError('Invalid emulation prevention');
  return parse(bitReader(rbsp));
}

function skipScalingList(reader, size) {
  let last = 8;
  let next = 8;
  for (let index = 0; index < size; index += 1) {
    if (next !== 0) next = (last + reader.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

function parseSps(nal) {
  return withRbsp(nal, (reader) => {
    const profile = reader.u(8);
    reader.u(16); // constraint flags, level
    const id = reader.ue();
    let chromaFormat = 1;
    let separateColourPlane = 0;
    if (HIGH_PROFILES.has(profile)) {
      chromaFormat = reader.ue();
      if (chromaFormat === 3) separateColourPlane = reader.u(1);
      reader.ue(); // bit_depth_luma_minus8
      reader.ue(); // bit_depth_chroma_minus8
      reader.u(1); // qpprime_y_zero_transform_bypass_flag
      if (reader.u(1)) {
        for (let index = 0; index < (chromaFormat !== 3 ? 8 : 12); index += 1) {
          if (reader.u(1)) skipScalingList(reader, index < 6 ? 16 : 64);
        }
      }
    }
    const log2MaxFrameNum = reader.ue() + 4;
    if (log2MaxFrameNum > 16) throw gapError('Invalid log2_max_frame_num');
    const pocType = reader.ue();
    let log2MaxPocLsb = 0;
    let deltaPocAlwaysZero = 0;
    if (pocType === 0) log2MaxPocLsb = reader.ue() + 4;
    else if (pocType === 1) {
      deltaPocAlwaysZero = reader.u(1);
      reader.se();
      reader.se();
      const cycle = reader.ue();
      if (cycle > 255) throw gapError('Invalid POC cycle');
      for (let index = 0; index < cycle; index += 1) reader.se();
    } else if (pocType !== 2) throw gapError('Invalid pic_order_cnt_type');
    const maxRefFrames = reader.ue();
    const gapsAllowed = reader.u(1);
    const widthMbs = reader.ue() + 1;
    const heightMapUnits = reader.ue() + 1;
    const frameMbsOnly = reader.u(1);
    return {
      id, chromaArrayType: separateColourPlane ? 0 : chromaFormat, separateColourPlane, log2MaxFrameNum,
      pocType, log2MaxPocLsb, deltaPocAlwaysZero, maxRefFrames, gapsAllowed, widthMbs, heightMapUnits, frameMbsOnly
    };
  });
}

function parsePps(nal) {
  return withRbsp(nal, (reader) => {
    const id = reader.ue();
    const spsId = reader.ue();
    const entropyCoding = reader.u(1);
    const bottomFieldPocPresent = reader.u(1);
    const sliceGroups = reader.ue() + 1;
    if (sliceGroups !== 1) throw gapError('Slice groups are not supported');
    const refIdxL0 = reader.ue() + 1;
    const refIdxL1 = reader.ue() + 1;
    const weightedPred = reader.u(1);
    const weightedBipred = reader.u(2);
    reader.se(); // pic_init_qp_minus26
    reader.se(); // pic_init_qs_minus26
    reader.se(); // chroma_qp_index_offset
    reader.u(1); // deblocking_filter_control_present_flag
    reader.u(1); // constrained_intra_pred_flag
    const redundantPicCnt = reader.u(1);
    return { id, spsId, entropyCoding, bottomFieldPocPresent, refIdxL0, refIdxL1, weightedPred, weightedBipred, redundantPicCnt };
  });
}

function skipRefListModification(reader) {
  if (!reader.u(1)) return;
  for (let count = 0; ; count += 1) {
    if (count > 64) throw gapError('Too many reference list changes');
    const idc = reader.ue();
    if (idc === 3) return;
    if (idc > 2) throw gapError('Invalid reference list change');
    reader.ue();
  }
}

function skipWeights(reader, count, chroma) {
  for (let index = 0; index < count; index += 1) {
    if (reader.u(1)) { reader.se(); reader.se(); }
    if (chroma && reader.u(1)) for (let plane = 0; plane < 2; plane += 1) { reader.se(); reader.se(); }
  }
}

/**
 * The first slice header of a picture, read up to its reference marking:
 * frame_num, and whether the picture resets frame numbering (MMCO 5).
 */
function parseSliceHeader(nal, parameterSets) {
  const nalType = nal[0] & 0x1f;
  const refIdc = (nal[0] >> 5) & 3;
  const idr = nalType === 5;
  return withRbsp(nal, (reader) => {
    const firstMb = reader.ue();
    const sliceType = reader.ue();
    if (sliceType > 9) throw gapError('Invalid slice_type');
    const pps = parameterSets.pps.get(reader.ue());
    if (!pps) throw gapError('Unknown picture parameter set');
    const sps = parameterSets.sps.get(pps.spsId);
    if (!sps) throw gapError('Unknown sequence parameter set');
    if (sps.separateColourPlane) reader.u(2); // colour_plane_id
    const frameNum = reader.u(sps.log2MaxFrameNum);
    let field = 0;
    if (!sps.frameMbsOnly) {
      field = reader.u(1);
      if (field) reader.u(1);
    }
    if (idr) reader.ue(); // idr_pic_id
    if (sps.pocType === 0) {
      reader.u(sps.log2MaxPocLsb);
      if (pps.bottomFieldPocPresent && !field) reader.se();
    }
    if (sps.pocType === 1 && !sps.deltaPocAlwaysZero) {
      reader.se();
      if (pps.bottomFieldPocPresent && !field) reader.se();
    }
    if (pps.redundantPicCnt) reader.ue();
    const kind = sliceType % 5; // 0 P, 1 B, 2 I, 3 SP, 4 SI
    let refL0 = pps.refIdxL0;
    let refL1 = pps.refIdxL1;
    if (kind === 1) reader.u(1); // direct_spatial_mv_pred_flag
    if (kind === 0 || kind === 1 || kind === 3) {
      if (reader.u(1)) {
        refL0 = reader.ue() + 1;
        if (kind === 1) refL1 = reader.ue() + 1;
      }
      if (refL0 > 32 || refL1 > 32) throw gapError('Invalid reference count');
    }
    if (kind !== 2 && kind !== 4) {
      skipRefListModification(reader);
      if (kind === 1) skipRefListModification(reader);
    }
    if ((pps.weightedPred && (kind === 0 || kind === 3)) || (pps.weightedBipred === 1 && kind === 1)) {
      reader.ue();
      if (sps.chromaArrayType !== 0) reader.ue();
      skipWeights(reader, refL0, sps.chromaArrayType !== 0);
      if (kind === 1) skipWeights(reader, refL1, sps.chromaArrayType !== 0);
    }
    let resets = false;
    if (refIdc !== 0) {
      if (idr) reader.u(2);
      else if (reader.u(1)) {
        for (let count = 0; ; count += 1) {
          if (count > 64) throw gapError('Too many memory operations');
          const operation = reader.ue();
          if (operation === 0) break;
          if (operation > 6) throw gapError('Invalid memory operation');
          if (operation === 5) resets = true;
          if (operation === 1 || operation === 3) reader.ue();
          if (operation === 2) reader.ue();
          if (operation === 3 || operation === 6) reader.ue();
          if (operation === 4) reader.ue();
        }
      }
    }
    return { firstMb, sliceType, idr, refIdc, frameNum, field, resets };
  });
}

// The SPS and PPS units of an avcC configuration record.
function avcParameterSets(avcC) {
  if (!Buffer.isBuffer(avcC) || avcC.length < 7 || avcC[0] !== 1) throw gapError('Invalid avcC configuration record');
  let cursor = 5;
  const read = (count) => {
    const units = [];
    for (let index = 0; index < count; index += 1) {
      if (cursor + 2 > avcC.length) throw gapError('Truncated avcC');
      const size = avcC.readUInt16BE(cursor);
      cursor += 2;
      if (size === 0 || cursor + size > avcC.length) throw gapError('Truncated avcC');
      units.push(avcC.subarray(cursor, cursor + size));
      cursor += size;
    }
    return units;
  };
  const sps = read(avcC[cursor++] & 0x1f);
  if (cursor >= avcC.length) throw gapError('Truncated avcC');
  const pps = read(avcC[cursor++]);
  return { sps, pps };
}

/**
 * The pictures of a stream (in decode order, from its first IDR) that FFmpeg
 * decodes but never outputs because of a frame_num gap, by position. Throws
 * when the stream is not one this model is sure of.
 *
 * pictures: [{ idr, refIdc, frameNum, resets, field }]; maxFrameNum: 2^bits.
 */
function droppedPictures(pictures, maxFrameNum, pocType) {
  const dropped = [];
  let previousRef = null;
  pictures.forEach((picture, index) => {
    if (picture.field) throw gapError('Field pictures are not supported');
    if (picture.resets) throw gapError('Memory-management resets are not supported');
    // A dropped picture's successor must be an IDR: what FFmpeg does with
    // later pictures of the same group is not modelled.
    if (dropped.at(-1) === index - 1 && !picture.idr) throw gapError('Pictures follow a dropped picture');
    if (picture.idr) {
      if (picture.frameNum !== 0) throw gapError('IDR picture with a non-zero frame_num');
      previousRef = 0;
      return;
    }
    if (previousRef === null) throw gapError('No IDR picture before this one');
    if (picture.refIdc === 0) throw gapError('Non-reference pictures are not supported');
    if (picture.frameNum === previousRef) throw gapError('Repeated frame_num');
    if (picture.frameNum !== (previousRef + 1) % maxFrameNum) {
      if (pocType !== 2) throw gapError('Gap with a picture order count FFmpeg is not modelled for');
      // The skipped numbers include the wrap to 0 (the new number is lower)
      // and the picture is not numbered 0 itself: FFmpeg's gap filling ends
      // on the number before it, so its frame number offset misses the wrap.
      if (picture.frameNum < previousRef && picture.frameNum !== 0) dropped.push(index);
    }
    previousRef = picture.frameNum;
  });
  if (dropped.at(-1) === pictures.length - 1) throw gapError('The last picture is dropped');
  return dropped;
}

// The first VCL NAL unit (a coded slice) of a sample's NAL units.
function firstVclNal(nals) {
  return nals.find((nal) => {
    const type = nal[0] & 0x1f;
    return type === 1 || type === 5;
  }) || null;
}

/**
 * Reads the frame numbering of an H.264 original sample by sample (`add`,
 * with each sample's NAL units, in decode order), keeping only a few fields
 * of each picture, then `describe` tells which samples FFmpeg never outputs
 * because of a frame_num gap, and the timing the output takes when they are
 * left out: the original's per-sample durations without them, each dropped
 * sample's duration added to the sample before it, so every remaining frame
 * keeps its timestamp and the total length is unchanged.
 *
 * `frames` is the number of such samples (0 for a clean stream), or null when
 * the stream could not be modelled (`reason` says why); only `frames > 0`
 * with `durationTicks` changes anything downstream.
 */
function createFrameNumScanner(avcC) {
  let reason = null;
  let units = [];
  let sps = null;
  let parameterSets = null;
  try {
    const sets = avcParameterSets(avcC);
    if (sets.sps.length !== 1 || sets.pps.length !== 1) reason = 'parameter-sets';
    else {
      sps = parseSps(sets.sps[0]);
      const pps = parsePps(sets.pps[0]);
      if (pps.spsId !== sps.id) reason = 'parameter-sets';
      parameterSets = { sps: new Map([[sps.id, sps]]), pps: new Map([[pps.id, pps]]) };
      units = [...sets.sps, ...sets.pps];
    }
  } catch (_) {
    reason = 'unreadable';
  }
  // Gaps the SPS allows are decoded (the missing pictures are inferred):
  // nothing is excused, the clip is verified as before.
  if (!reason && sps.gapsAllowed) reason = 'gaps-allowed';
  // One entry per sample: the picture's fields, or null when it did not read.
  const pictures = [];

  function add(nals) {
    if (reason) return;
    // Parameter sets repeated in the stream must be the avcC's own.
    if (nals.some((nal) => ((nal[0] & 0x1f) === 7 || (nal[0] & 0x1f) === 8) && !units.some((unit) => unit.equals(nal)))) {
      reason = 'parameter-sets';
      return;
    }
    try {
      const nal = firstVclNal(nals);
      const header = nal ? parseSliceHeader(nal, parameterSets) : null;
      pictures.push(header && header.firstMb === 0 ? header : null);
    } catch (_) {
      pictures.push(null);
    }
  }

  function describe({ samples, timescale, leadIn }) {
    const none = (fields) => Object.freeze({ frames: 0, samples: Object.freeze([]), reason: null, ...fields });
    const unknown = (why) => none({ frames: null, reason: why });
    if (reason === 'gaps-allowed') return none({ reason });
    if (reason) return unknown(reason);
    if (pictures.length !== samples.length) return unknown('unreadable');
    // A terminal zero-duration sample is left out by every decoder anyway.
    const tail = samples.length > 0 && samples.at(-1).duration === 0n ? 1 : 0;
    const realCount = samples.length - tail;
    // The lead-in (before the first keyframe) is held by the encoder, not
    // decoded; the frame_num chain starts at the first IDR.
    const start = pictures.findIndex((picture) => picture?.idr);
    if (start === -1 || start >= realCount) return none({});
    const decoded = pictures.slice(start, realCount);
    if (decoded.includes(null)) return unknown('unreadable');
    let found;
    try {
      found = droppedPictures(decoded, 2 ** sps.log2MaxFrameNum, sps.pocType).map((position) => position + start);
    } catch (_) {
      return unknown('frame-num');
    }
    if (found.length === 0) return none({});
    const result = { frames: found.length, samples: Object.freeze(found), reason: null };
    // Lead-in frames that are not held would shift every timestamp: such a
    // clip is not retimed, and it fails verification as it always did.
    if (leadIn?.frames !== start || (start > 0 && leadIn.hold !== start)) return unknown('lead-in');
    if (samples[0].pts !== 0n || !Number.isSafeInteger(timescale) || timescale <= 0 || timescale > UINT32_MAX) return unknown('timing');
    const dropped = new Set(found);
    const durationTicks = [];
    for (let index = 0; index < realCount; index += 1) {
      const sample = samples[index];
      if (sample.pts !== sample.dts || (index > 0 && sample.pts <= samples[index - 1].pts)) return unknown('reordered');
      if (sample.duration <= 0n || sample.duration > BigInt(UINT32_MAX)) return unknown('timing');
      if (!dropped.has(index)) durationTicks.push(Number(sample.duration));
      else durationTicks[durationTicks.length - 1] += Number(sample.duration);
      if (durationTicks.at(-1) > UINT32_MAX) return unknown('timing');
    }
    return Object.freeze({ ...result, timescale, durationTicks: Object.freeze(durationTicks) });
  }

  return { add, describe };
}

// How many samples of a timeline's original are dropped by the decoder (0:
// none, or none proven); their indexes are `timeline.undecodable.samples`.
function undecodableFrames(timeline) {
  const undecodable = timeline?.undecodable;
  const samples = undecodable?.samples;
  if (!undecodable || !Number.isSafeInteger(undecodable.frames) || undecodable.frames <= 0) return 0;
  if (!Array.isArray(samples) || samples.length !== undecodable.frames) return 0;
  const ordered = samples.every((index, position) => Number.isSafeInteger(index) && index > 0
    && (position === 0 || index > samples[position - 1]));
  return ordered ? samples.length : 0;
}

module.exports = { createFrameNumScanner, undecodableFrames, droppedPictures, parseSps, parseSliceHeader, avcParameterSets };
