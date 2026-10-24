'use strict';

// Tesla cuts each minute file in the middle of a group of pictures: a side or
// back camera file often starts with frames that only decode with the end of
// the previous minute's file. Decoders drop those frames, so a plain encode
// is shorter than its original (by up to ~1.5 s) and the verifier rightly
// refuses to replace it.
//
// The converter keeps every frame instead. The encoder repeats the first
// frame that decodes once for each lead-in frame (FFmpeg's tpad filter in
// clone mode), and before the telemetry is written the encoded track gets
// the original's own sample timing back, one sample for one sample: the same
// frame count, the same timestamp and duration for every frame, the same
// length. Each frame's Tesla telemetry is read from the original without
// decoding the picture, so the lead-in frames keep theirs as well.
//
// A clip that starts on a keyframe has no lead-in and is encoded exactly as
// before. A clip without any keyframe, or whose frames are reordered
// (B-frames), gets no hold and fails verification as it always did.

const { findBoxes, sampleTable, buildSampleIndex, parseMp4, selectVideoTrack, serializedBoxHeaderSize } = require('./mp4');

const UINT32_MAX = 0xffffffff;

function leadInError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function payloadOf(buffer, node) {
  return buffer.subarray(Number(node.contentStart), Number(node.end));
}

function readSyncSampleNumbers(buffer, stbl) {
  const tables = (stbl.children || []).filter((child) => child.type === 'stss');
  if (tables.length === 0) return null; // no stss: every sample is a sync sample
  if (tables.length > 1) throw leadInError('Duplicate stss boxes', 'INVALID_MP4');
  const payload = payloadOf(buffer, tables[0]);
  if (payload.length < 8 || payload.readUInt8(0) !== 0) throw leadInError('Unsupported stss box', 'UNSUPPORTED_CONTAINER');
  const count = payload.readUInt32BE(4);
  if (payload.length < 8 + count * 4) throw leadInError('Truncated stss table', 'INVALID_MP4');
  const numbers = [];
  for (let index = 0; index < count; index += 1) numbers.push(payload.readUInt32BE(8 + index * 4));
  return numbers;
}

/**
 * The lead-in of an H.264 original: how many samples come before its first
 * sync sample (keyframe) in decode order, and the original's sample timing
 * the encoded track takes back when those frames are held.
 *
 * `hold` is the number of frames the encoder repeats; it is 0 whenever the
 * clip is to be encoded exactly as before (no lead-in, no keyframe at all,
 * reordered frames, or timing that cannot be carried over).
 */
function describeLeadIn(buffer, track, samples, timescale) {
  const none = (fields) => Object.freeze({ frames: 0, hold: 0, syncSampleIndex: 0, reason: null, ...fields });
  let syncNumbers;
  // An unreadable sync table changes nothing: the clip is encoded as before.
  try { syncNumbers = readSyncSampleNumbers(buffer, sampleTable(track)); } catch (_) {
    return none({ frames: null, syncSampleIndex: null, reason: 'unreadable' });
  }
  if (samples.length === 0) return none({ frames: null, syncSampleIndex: null, reason: 'no-samples' });
  if (syncNumbers === null) return none({});
  const syncIndexes = syncNumbers.filter((number) => number >= 1 && number <= samples.length).map((number) => number - 1);
  if (syncIndexes.length === 0) return none({ frames: null, syncSampleIndex: null, reason: 'no-keyframe' });
  const first = syncIndexes.reduce((low, index) => (index < low ? index : low), Infinity);
  if (first === 0) return none({});
  // A terminal zero-duration sample is container bookkeeping that decoders
  // leave out (see the verifier); the encoded track never has it.
  const tail = samples.at(-1).duration === 0n ? 1 : 0;
  const realCount = samples.length - tail;
  const result = { frames: first, syncSampleIndex: first, hold: 0, reason: null };
  if (first >= realCount) return Object.freeze({ ...result, reason: 'no-decodable-frame' });
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].pts <= samples[index - 1].pts) return Object.freeze({ ...result, reason: 'reordered' });
  }
  const durationTicks = [];
  for (let index = 0; index < realCount; index += 1) {
    const duration = samples[index].duration;
    if (duration <= 0n || duration > BigInt(UINT32_MAX)) return Object.freeze({ ...result, reason: 'timing' });
    durationTicks.push(Number(duration));
  }
  if (samples[0].pts !== 0n || !Number.isSafeInteger(timescale) || timescale <= 0 || timescale > UINT32_MAX) {
    return Object.freeze({ ...result, reason: 'timing' });
  }
  return Object.freeze({
    ...result,
    hold: first,
    timescale,
    durationTicks: Object.freeze(durationTicks)
  });
}

// How many frames the encoder must repeat at the start (0: encode as before).
function leadInHoldFrames(timeline) {
  const leadIn = timeline?.leadIn;
  if (!leadIn || !Number.isSafeInteger(leadIn.hold) || leadIn.hold <= 0) return 0;
  if (!Array.isArray(leadIn.durationTicks) || leadIn.hold >= leadIn.durationTicks.length) return 0;
  return leadIn.hold;
}

function runLength(values) {
  const entries = [];
  for (const value of values) {
    const previous = entries.at(-1);
    if (previous && previous.value === value) previous.count += 1;
    else entries.push({ count: 1, value });
  }
  return entries;
}

// version 0, no flags, then the run-length entries
function sttsPayload(durations) {
  const entries = runLength(durations);
  const payload = Buffer.alloc(8 + entries.length * 8);
  payload.writeUInt32BE(entries.length, 4);
  entries.forEach(({ count, value }, index) => {
    payload.writeUInt32BE(count, 8 + index * 8);
    payload.writeUInt32BE(value, 12 + index * 8);
  });
  return payload;
}

// mvhd/tkhd/mdhd keep everything but the fields named here; a duration that
// no longer fits 32 bits moves the box to version 1.
function timedHeaderPayload(buffer, node, { timescale = null, duration }) {
  const original = payloadOf(buffer, node);
  const version = original.readUInt8(0);
  if (version !== 0 && version !== 1) throw leadInError(`Unsupported ${node.type} version`, 'UNSUPPORTED_CONTAINER');
  const wide = version === 1 || duration > BigInt(UINT32_MAX);
  // Layout after version/flags: times (4/8 each), then for mvhd/mdhd the
  // timescale and duration, for tkhd the track id, reserved and duration.
  const timeWidth = version === 1 ? 8 : 4;
  const newTimeWidth = wide ? 8 : 4;
  const headerFields = node.type === 'tkhd' ? 8 : 4; // tkhd: track_ID + reserved; others: timescale
  const oldDurationOffset = 4 + timeWidth * 2 + headerFields;
  const oldRestOffset = oldDurationOffset + timeWidth;
  if (original.length < oldRestOffset) throw leadInError(`Truncated ${node.type} box`, 'INVALID_MP4');
  const readTime = (offset) => (version === 1 ? original.readBigUInt64BE(offset) : BigInt(original.readUInt32BE(offset)));
  const rest = original.subarray(oldRestOffset);
  const output = Buffer.alloc(4 + newTimeWidth * 2 + headerFields + newTimeWidth + rest.length);
  output.writeUInt8(wide ? 1 : 0, 0);
  original.copy(output, 1, 1, 4);
  let cursor = 4;
  for (const offset of [4, 4 + timeWidth]) {
    const value = readTime(offset);
    if (wide) output.writeBigUInt64BE(value, cursor);
    else output.writeUInt32BE(Number(value), cursor);
    cursor += newTimeWidth;
  }
  original.copy(output, cursor, 4 + timeWidth * 2, 4 + timeWidth * 2 + headerFields);
  if (timescale !== null) output.writeUInt32BE(timescale, cursor);
  cursor += headerFields;
  if (wide) output.writeBigUInt64BE(duration, cursor);
  else output.writeUInt32BE(Number(duration), cursor);
  cursor += newTimeWidth;
  rest.copy(output, cursor);
  return output;
}

function movieTimescale(buffer, mvhd) {
  const payload = payloadOf(buffer, mvhd);
  const offset = payload.readUInt8(0) === 1 ? 20 : 12;
  if (payload.length < offset + 4) throw leadInError('Truncated mvhd box', 'INVALID_MP4');
  const value = payload.readUInt32BE(offset);
  if (value === 0) throw leadInError('Invalid movie timescale', 'INVALID_MP4');
  return value;
}

// replacements: node -> new payload, or null to leave the box out.
function serialize(buffer, node, replacements) {
  const replacement = replacements.get(node);
  let payload;
  if (replacement) payload = replacement;
  else if (node.children && node.children.length) {
    payload = Buffer.concat(node.children.filter((child) => replacements.get(child) !== null)
      .map((child) => serialize(buffer, child, replacements)));
  } else payload = payloadOf(buffer, node);
  const headerSize = serializedBoxHeaderSize(BigInt(payload.length), node.headerSize);
  const output = Buffer.alloc(Number(headerSize) + payload.length);
  if (headerSize === 16n) {
    output.writeUInt32BE(1, 0);
    output.write(node.type, 4, 4, 'ascii');
    output.writeBigUInt64BE(BigInt(output.length), 8);
  } else {
    output.writeUInt32BE(output.length, 0);
    output.write(node.type, 4, 4, 'ascii');
  }
  payload.copy(output, Number(headerSize));
  return output;
}

/**
 * Give an encoded single-track MP4 the original's sample timing, one sample
 * for one sample: the media timescale becomes the original's and every
 * sample's duration the original sample's, so every frame keeps its original
 * timestamp. The encoded frames must be exactly the original's (lead-in frames
 * included), in presentation order; anything else is refused, never guessed.
 */
function retimeToSource(encodedMp4, leadIn) {
  if (!Buffer.isBuffer(encodedMp4)) throw new TypeError('Encoded MP4 must be a Buffer');
  if (!leadIn || !Array.isArray(leadIn.durationTicks) || !Number.isSafeInteger(leadIn.timescale)) {
    throw new TypeError('Source timing is required');
  }
  const tree = parseMp4(encodedMp4);
  const traks = findBoxes(tree, 'trak');
  if (traks.length !== 1) throw leadInError('Encoded file must hold only the video track', 'CONTAINER_INVALID');
  const track = selectVideoTrack(tree);
  if (findBoxes(track, 'edts').length > 0) throw leadInError('Encoded track has an edit list', 'CONTAINER_INVALID');
  const samples = buildSampleIndex(track);
  if (samples.length !== leadIn.durationTicks.length) {
    throw leadInError(`Encoded ${samples.length} frames, the original has ${leadIn.durationTicks.length}`, 'FRAME_COUNT_MISMATCH');
  }
  // Decode order must be presentation order: the samples get new timestamps
  // by position. A constant decode delay (a ctts that reorders nothing, as
  // some hardware encoders write without B-frames) goes with the old timing.
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].pts <= samples[index - 1].pts) throw leadInError('Encoded frames are reordered', 'CONTAINER_INVALID');
  }
  // Sample tables grow; only a moov after every mdat keeps chunk offsets valid.
  const moovs = tree.children.filter((child) => child.type === 'moov');
  const mdats = tree.children.filter((child) => child.type === 'mdat');
  if (moovs.length !== 1 || mdats.length === 0 || mdats.some((mdat) => mdat.end > moovs[0].start)) {
    throw leadInError('Encoded moov must follow its media data', 'CONTAINER_INVALID');
  }
  const stbl = sampleTable(track);
  const [stts] = (stbl.children || []).filter((child) => child.type === 'stts');
  const ctts = (stbl.children || []).filter((child) => child.type === 'ctts');
  const [mdhd] = findBoxes(track, 'mdhd');
  const [tkhd] = findBoxes(track, 'tkhd');
  const [mvhd] = findBoxes(tree, 'mvhd');
  if (!stts || !mdhd || !tkhd || !mvhd) throw leadInError('Encoded track is missing timing boxes', 'CONTAINER_INVALID');

  const total = leadIn.durationTicks.reduce((sum, value) => sum + BigInt(value), 0n);
  const movieDuration = (total * BigInt(movieTimescale(encodedMp4, mvhd)) + BigInt(leadIn.timescale) / 2n) / BigInt(leadIn.timescale);
  const replacements = new Map([
    [stts, sttsPayload(leadIn.durationTicks)],
    [mdhd, timedHeaderPayload(encodedMp4, mdhd, { timescale: leadIn.timescale, duration: total })],
    [tkhd, timedHeaderPayload(encodedMp4, tkhd, { duration: movieDuration })],
    [mvhd, timedHeaderPayload(encodedMp4, mvhd, { duration: movieDuration })],
    ...ctts.map((node) => [node, null])
  ]);
  const output = Buffer.concat(tree.children.map((node) => serialize(encodedMp4, node, replacements)));

  // Prove the result: the same samples at the same bytes, the original timing.
  const check = buildSampleIndex(selectVideoTrack(parseMp4(output)));
  let pts = 0n;
  const same = check.length === samples.length && check.every((sample, index) => {
    const expected = BigInt(leadIn.durationTicks[index]);
    const ok = sample.offset === samples[index].offset && sample.size === samples[index].size
      && sample.dts === pts && sample.pts === pts && sample.duration === expected;
    pts += expected;
    return ok;
  });
  if (!same) throw leadInError('Retimed track does not match the original timing', 'CONTAINER_INVALID');
  return output;
}

module.exports = { describeLeadIn, leadInHoldFrames, retimeToSource };
