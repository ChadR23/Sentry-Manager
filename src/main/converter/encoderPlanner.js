'use strict';

// These conservative 8-bit 4:2:0 floors avoid known encoder initialization
// failures at impractically low bitrates. They are the only bitrate clamps;
// the planner deliberately has no maximum clamp that could defeat a byte target.
const SAFE_VIDEO_BITRATE_FLOORS = Object.freeze({ h265: 250_000, av1: 200_000 });
const RETRY_REASONS = Object.freeze({ PROFILE_SIZE: 'profile-size' });
const DEFAULT_PROBE_BITRATE = 500_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
// A CPU encoder that ffmpeg lists is always there; a slow probe only means a
// busy or slow computer, so it gets longer before it counts as failed.
const CPU_PROBE_TIMEOUT_MS = 45_000;

const CANDIDATES = Object.freeze({
  h265: Object.freeze({
    win32: Object.freeze(['hevc_nvenc', 'hevc_qsv', 'hevc_amf']),
    darwin: Object.freeze(['hevc_videotoolbox']),
    linux: Object.freeze(['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_vaapi']),
    cpu: Object.freeze(['libx265'])
  }),
  av1: Object.freeze({
    win32: Object.freeze(['av1_nvenc', 'av1_qsv', 'av1_amf']),
    darwin: Object.freeze(['av1_videotoolbox']),
    linux: Object.freeze(['av1_nvenc', 'av1_qsv', 'av1_amf', 'av1_vaapi']),
    cpu: Object.freeze(['libsvtav1', 'libaom-av1'])
  })
});

function requireFamily(codec) {
  if (!Object.prototype.hasOwnProperty.call(CANDIDATES, codec)) {
    throw new RangeError(`Unsupported encoder family: ${codec}`);
  }
  return codec;
}

function requirePositive(name, value) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`);
  return value;
}

function requireNonNegative(name, value) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative finite number`);
  return value;
}

function requirePositiveSafeInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive finite safe integer`);
  return value;
}

function bitrateFloor(codec) {
  return SAFE_VIDEO_BITRATE_FLOORS[requireFamily(codec)];
}

function encoderBelongsToFamily(codec, encoder) {
  const family = CANDIDATES[codec];
  return family.cpu.includes(encoder) || Object.entries(family)
    .filter(([key]) => key !== 'cpu')
    .map(([, value]) => value)
    .filter(Array.isArray)
    .some((encoders) => encoders.includes(encoder));
}

/**
 * Build output arguments shared by real probes and converter jobs.
 * The MP4 muxer is forced to avoid edit lists and shift negative timestamps to
 * zero while passthrough frame mode prevents implicit duplication or dropping.
 */
// Constant-quality settings per encoder family, for each named level. Scales
// differ by encoder (NVENC/QSV 0-51, AMF/VAAPI AV1 0-255, VideoToolbox 1-100
// where higher is better, x265 CRF 0-51, SVT-AV1/libaom CRF 0-63).
const QUALITY_VALUES = Object.freeze({
  hw51: Object.freeze({ high: 24, balanced: 28, small: 32 }),
  hw255: Object.freeze({ high: 96, balanced: 112, small: 128 }),
  videotoolbox: Object.freeze({ high: 65, balanced: 55, small: 45 }),
  x265: Object.freeze({ high: 22, balanced: 26, small: 30 }),
  av1crf: Object.freeze({ high: 30, balanced: 36, small: 42 })
});

function qualityRateArgs(codec, encoder, level) {
  if (!Object.prototype.hasOwnProperty.call(QUALITY_VALUES.hw51, level)) throw new RangeError(`Unknown quality level: ${level}`);
  const pick = (table) => String(QUALITY_VALUES[table][level]);
  if (encoder.endsWith('_nvenc')) return ['-rc', 'vbr', '-cq', pick('hw51'), '-b:v', '0'];
  if (encoder.endsWith('_qsv')) return ['-global_quality', pick('hw51')];
  if (encoder.endsWith('_amf')) {
    const qp = codec === 'av1' ? pick('hw255') : pick('hw51');
    return ['-rc', 'cqp', '-qp_i', qp, '-qp_p', qp];
  }
  // av1_vaapi has no -qp option (FFmpeg ignores it with a warning); every
  // VA-API encoder takes the constant-QP value from -global_quality instead.
  if (encoder.endsWith('_vaapi')) return codec === 'av1'
    ? ['-rc_mode', 'CQP', '-global_quality', pick('hw255')]
    : ['-rc_mode', 'CQP', '-qp', pick('hw51')];
  if (encoder.endsWith('_videotoolbox')) return ['-q:v', pick('videotoolbox')];
  if (encoder === 'libx265') return ['-crf', pick('x265')];
  if (encoder === 'libaom-av1') return ['-crf', pick('av1crf'), '-b:v', '0'];
  return ['-crf', pick('av1crf')]; // libsvtav1
}

// A render node (Intel/AMD) or a CUDA index (NVIDIA) of an encoding device
// chosen per GPU; without one, every argument is what it always was.
function deviceNode(device) {
  const node = device?.node;
  if (typeof node !== 'string' || node.length === 0) throw new RangeError('device.node must be a non-empty path');
  return node;
}

function deviceIndex(device) {
  if (!Number.isSafeInteger(device?.index) || device.index < 0) throw new RangeError('device.index must be a non-negative integer');
  return String(device.index);
}

function buildEncodeArgs({ codec, encoder, bitrate, quality = null, vaapiDevice = '/dev/dri/renderD128', hwFrames = false, device = null }) {
  requireFamily(codec);
  if (quality === null) requirePositive('bitrate', bitrate);
  if (typeof encoder !== 'string' || !encoderBelongsToFamily(codec, encoder)) {
    throw new RangeError(`Encoder ${encoder} is not a ${codec} candidate`);
  }

  const args = [];
  if (encoder.endsWith('_vaapi')) {
    const node = device ? deviceNode(device) : vaapiDevice;
    if (typeof node !== 'string' || node.length === 0) throw new RangeError('vaapiDevice must be a non-empty path');
    args.push('-vaapi_device', node, '-vf', 'format=nv12,hwupload');
  }
  // A global option: the QSV session opens on this GPU's render node.
  if (device && encoder.endsWith('_qsv')) args.push('-init_hw_device', `qsv=qsvenc:hw_any,child_device=${deviceNode(device)}`);

  args.push('-c:v', encoder);
  if (device && encoder.endsWith('_nvenc')) args.push('-gpu', deviceIndex(device));
  if (quality !== null) args.push(...qualityRateArgs(codec, encoder, quality));
  else args.push('-b:v', String(Math.round(bitrate)));

  // GPU-resident input frames (zero-copy decode) are already 8-bit 4:2:0 and
  // cannot pass through a software pixel-format conversion.
  if (hwFrames) { /* keep frames on the GPU */ }
  else if (encoder.endsWith('_qsv')) args.push('-pix_fmt', 'nv12');
  else if (!encoder.endsWith('_vaapi')) args.push('-pix_fmt', 'yuv420p');

  if (encoder.endsWith('_amf') && quality === null) args.push('-rc', 'vbr_peak');
  if (encoder === 'libx265') args.push('-preset', 'medium');
  if (encoder === 'libsvtav1') args.push('-preset', '8');
  if (encoder === 'libaom-av1') args.push('-cpu-used', '6', '-row-mt', '1');
  if (codec === 'h265') args.push('-bf', '0');

  args.push(
    '-tag:v', codec === 'h265' ? 'hvc1' : 'av01',
    '-fps_mode', 'passthrough',
    '-start_at_zero',
    '-avoid_negative_ts', 'make_zero',
    '-use_editlist', '0'
  );
  return args;
}

/**
 * Input arguments that decode on the same GPU family as a hardware encoder.
 * Decoded frames are copied back to system memory, so the encode arguments
 * stay identical with or without them. CPU encoders get no GPU decode.
 */
function decodeAccelArgs(encoder, { platform = process.platform, vaapiDevice = '/dev/dri/renderD128', zeroCopy = false, device = null } = {}) {
  if (typeof encoder !== 'string') return null;
  // With a device, the GPU that encodes also decodes.
  const cudaDevice = () => (device ? ['-hwaccel_device', deviceIndex(device)] : []);
  // Zero-copy: NVDEC frames stay in GPU memory and go straight into NVENC.
  if (zeroCopy) return encoder.endsWith('_nvenc') ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', ...cudaDevice()] : null;
  const vaapi = () => ['-hwaccel', 'vaapi', '-hwaccel_device', device ? deviceNode(device) : vaapiDevice];
  if (encoder.endsWith('_nvenc')) return ['-hwaccel', 'cuda', ...cudaDevice()];
  if (encoder.endsWith('_videotoolbox')) return ['-hwaccel', 'videotoolbox'];
  if (encoder.endsWith('_vaapi')) return vaapi();
  if (encoder.endsWith('_qsv') || encoder.endsWith('_amf')) {
    if (platform === 'win32') return ['-hwaccel', 'd3d11va'];
    if (platform === 'linux') return vaapi();
  }
  return null;
}

function failedProof(candidate, reason, details) {
  return { ...candidate, usable: false, reason, details: details || null };
}

function processFailure(result) {
  if (!result || result.timedOut || result.timeout) return 'timeout';
  if (result.error) return 'runner error result';
  if (result.status !== 0) return 'non-zero status';
  return null;
}

/**
 * Prove one advertised candidate with a short, real MP4 encode. The runner
 * contract is (command, argumentArray, options) and shell use is forbidden.
 */
async function probeCandidate({
  runProbe,
  ffmpegPath = 'ffmpeg',
  platform = process.platform,
  family,
  candidate,
  bitrate = DEFAULT_PROBE_BITRATE,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  vaapiDevice = '/dev/dri/renderD128',
  device = null
}) {
  if (typeof runProbe !== 'function') throw new TypeError('runProbe must be a function');
  requireFamily(family);
  requirePositiveSafeInteger('timeoutMs', timeoutMs);
  const normalized = typeof candidate === 'string'
    ? { codec: candidate, hardware: !CANDIDATES[family].cpu.includes(candidate) }
    : { ...candidate };
  let encodeArgs;
  try {
    encodeArgs = buildEncodeArgs({ codec: family, encoder: normalized.codec, bitrate, vaapiDevice, ...(device ? { device } : {}) });
  } catch (error) {
    if (!device) throw error;
    return failedProof(normalized, 'invalid device', error.message);
  }
  const outputPath = platform === 'win32' ? 'NUL' : '/dev/null';
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=duration=0.5:size=640x360:rate=8',
    '-an', '-frames:v', '4',
    ...encodeArgs,
    '-f', 'mp4', outputPath
  ];

  try {
    const result = await Promise.resolve(runProbe(ffmpegPath, args, {
      timeoutMs,
      windowsHide: true,
      shell: false
    }));
    const reason = processFailure(result);
    if (reason) return failedProof(normalized, reason, result.stderr || result.error?.message);
    return { ...normalized, usable: true, reason: null, probeArgs: args };
  } catch (error) {
    return failedProof(normalized, 'runner error', error.message);
  }
}

function encoderIsAdvertised(output, codec) {
  const escaped = codec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'm').test(output);
}

const FAMILY_LABELS = Object.freeze({ h265: 'H.265', av1: 'AV1' });
const ENCODER_PREFIX = Object.freeze({ h265: 'hevc', av1: 'av1' });

// Hardware encoders worth trying on one GPU (Linux only; other systems have
// no per-GPU choice): QSV then VA-API on Intel, VA-API on AMD, NVENC on NVIDIA.
function deviceCandidates(family, device, platform) {
  if (platform !== 'linux') return [];
  const prefix = ENCODER_PREFIX[family];
  if (device.kind === 'dri' && device.vendor === 'intel') return [`${prefix}_qsv`, `${prefix}_vaapi`];
  if (device.kind === 'dri' && device.vendor === 'amd') return [`${prefix}_vaapi`];
  if (device.kind === 'nvidia') return [`${prefix}_nvenc`];
  return [];
}

function platformCandidates(family, platform) {
  const hardware = CANDIDATES[family][platform] || [];
  return [
    ...hardware.map((codec) => Object.freeze({ codec, hardware: true })),
    ...CANDIDATES[family].cpu.map((codec) => Object.freeze({ codec, hardware: false }))
  ];
}

function createEncoderPlanner({
  runProbe,
  platform = process.platform,
  ffmpegPath = 'ffmpeg',
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  vaapiDevice = '/dev/dri/renderD128'
} = {}) {
  if (typeof runProbe !== 'function') throw new TypeError('runProbe must be a function');
  requirePositiveSafeInteger('timeoutMs', timeoutMs);
  let advertisedPromise;
  const proofCache = new Map();
  const selectionCache = new Map();

  async function advertisedEncoders() {
    if (!advertisedPromise) {
      advertisedPromise = Promise.resolve().then(() => runProbe(ffmpegPath, ['-hide_banner', '-encoders'], {
        timeoutMs,
        windowsHide: true,
        shell: false
      })).then((result) => {
        const reason = processFailure(result);
        if (reason) throw new Error(`Encoder discovery failed: ${reason}`);
        return `${result.stdout || ''}\n${result.stderr || ''}`;
      }).catch((error) => {
        advertisedPromise = undefined;
        throw error instanceof Error && /Encoder discovery failed/.test(error.message)
          ? error
          : new Error(`Encoder discovery failed: ${error.message || error}`);
      });
    }
    return advertisedPromise;
  }

  async function prove(family, candidate, device = null) {
    const key = device ? `${family}:${candidate.codec}:${device.id}` : `${family}:${candidate.codec}`;
    if (!proofCache.has(key)) {
      const pending = probeCandidate({
        runProbe,
        ffmpegPath,
        platform,
        family,
        candidate,
        timeoutMs: candidate.hardware === false ? Math.max(timeoutMs, CPU_PROBE_TIMEOUT_MS) : timeoutMs,
        vaapiDevice,
        ...(device ? { device } : {})
      });
      proofCache.set(key, pending);
      // A probe that only ran out of time is tried again next time instead of
      // ruling the encoder out for the rest of the session.
      pending.then((proof) => {
        if (proof?.reason === 'timeout' && proofCache.get(key) === pending) proofCache.delete(key);
      }, () => {});
    }
    return proofCache.get(key);
  }

  async function selectFrom(family, candidates, cacheKey) {
    requireFamily(family);
    if (selectionCache.has(cacheKey)) return selectionCache.get(cacheKey);
    const output = await advertisedEncoders();
    for (const candidate of candidates) {
      if (!encoderIsAdvertised(output, candidate.codec)) continue;
      const proof = await prove(family, candidate);
      if (proof.usable) {
        const selected = Object.freeze({ family, codec: candidate.codec, hardware: candidate.hardware });
        selectionCache.set(cacheKey, selected);
        return selected;
      }
    }
    throw new Error(`No proven ${family} encoder is available`);
  }

  function selectCpuFallback(family) {
    requireFamily(family);
    return selectFrom(
      family,
      CANDIDATES[family].cpu.map((codec) => ({ codec, hardware: false })),
      `${family}:cpu`
    );
  }

  // The encoder for one chosen GPU, proven with that GPU's own arguments. A
  // GPU that cannot encode the family converts its clips on the CPU encoder.
  // With `probe: false` only an answer known already is given (null when
  // there is none), so a GPU that is converting right now is not tested:
  // a test encode it fails only for being busy would rule it out for good.
  const cpuWarned = new Set();
  async function selectFor(family, device, { probe = true } = {}) {
    requireFamily(family);
    if (!device || typeof device.id !== 'string') throw new TypeError('device is required');
    if (device.kind === 'cpu') {
      if (!probe && !selectionCache.has(`${family}:cpu`)) return null;
      const cpu = await selectCpuFallback(family);
      return Object.freeze({ family, codec: cpu.codec, hardware: false, device: Object.freeze({ id: 'cpu', kind: 'cpu' }) });
    }
    const cacheKey = `${family}:device:${device.id}`;
    if (selectionCache.has(cacheKey)) return selectionCache.get(cacheKey);
    if (!probe) return null;
    const chosen = Object.freeze({
      id: device.id, kind: device.kind, node: device.node ?? null, index: device.index ?? null
    });
    const output = await advertisedEncoders();
    let timedOut = false;
    for (const codec of deviceCandidates(family, device, platform)) {
      if (!encoderIsAdvertised(output, codec)) continue;
      const proof = await prove(family, { codec, hardware: true }, chosen);
      if (proof.usable) {
        const selected = Object.freeze({ family, codec, hardware: true, device: chosen });
        selectionCache.set(cacheKey, selected);
        return selected;
      }
      if (proof.reason === 'timeout') timedOut = true;
    }
    const cpu = await selectCpuFallback(family);
    // A probe that only ran out of time proves nothing: this time the CPU
    // encodes (timedOut says why), the GPU is tried again next time and is
    // not said to be unable.
    if (timedOut) return Object.freeze({ family, codec: cpu.codec, hardware: false, device: chosen, timedOut: true });
    if (!cpuWarned.has(cacheKey)) {
      cpuWarned.add(cacheKey);
      console.warn(`[CONVERTER] ${device.name || device.id} cannot encode ${FAMILY_LABELS[family]}; its conversions use the CPU encoder.`);
    }
    const selected = Object.freeze({ family, codec: cpu.codec, hardware: false, device: chosen });
    selectionCache.set(cacheKey, selected);
    return selected;
  }

  return Object.freeze({
    // `probe: false`: only a choice made already, else null (see selectFor)
    select(family, { probe = true } = {}) {
      requireFamily(family);
      if (!probe) return Promise.resolve(selectionCache.get(`${family}:preferred`) || null);
      return selectFrom(family, platformCandidates(family, platform), `${family}:preferred`);
    },
    selectFor,
    selectCpuFallback
  });
}

function calculateInitialBitrate({
  codec,
  targetBytes,
  durationSeconds,
  containerReserveBytes,
  telemetryReserveBytes
}) {
  requireFamily(codec);
  requirePositive('targetBytes', targetBytes);
  requirePositive('durationSeconds', durationSeconds);
  requireNonNegative('containerReserveBytes', containerReserveBytes);
  requireNonNegative('telemetryReserveBytes', telemetryReserveBytes);
  const reservedBytes = containerReserveBytes + telemetryReserveBytes;
  if (reservedBytes >= targetBytes) throw new RangeError('Container and telemetry reserve must be smaller than targetBytes');
  const calculated = Math.floor(((targetBytes - reservedBytes) * 8) / durationSeconds);
  return requirePositiveSafeInteger('calculated bitrate', Math.max(bitrateFloor(codec), calculated));
}

function calculateRetryBitrate(currentBitrate, actualBytes, targetBytes, options = {}) {
  requirePositive('currentBitrate', currentBitrate);
  requirePositive('actualBytes', actualBytes);
  requirePositive('targetBytes', targetBytes);
  const codec = typeof options === 'string' ? options : (options.codec || 'h265');
  const calculated = Math.round(currentBitrate * (targetBytes / actualBytes));
  return requirePositiveSafeInteger('calculated bitrate', Math.max(bitrateFloor(codec), calculated));
}

function decideSizeRetry({
  retryCount,
  failureReason,
  codec,
  encoder,
  currentBitrate,
  actualBytes,
  targetBytes
}) {
  if (!Number.isInteger(retryCount) || retryCount < 0) throw new RangeError('retryCount must be a non-negative integer');
  const correctionLimit = encoder === 'libaom-av1' ? 2 : 1;
  if (failureReason !== RETRY_REASONS.PROFILE_SIZE || retryCount >= correctionLimit) {
    return { retry: false, bitrate: null };
  }
  return {
    retry: true,
    bitrate: calculateRetryBitrate(currentBitrate, actualBytes, targetBytes, { codec })
  };
}

module.exports = {
  SAFE_VIDEO_BITRATE_FLOORS,
  decodeAccelArgs,
  RETRY_REASONS,
  buildEncodeArgs,
  probeCandidate,
  createEncoderPlanner,
  calculateInitialBitrate,
  calculateRetryBitrate,
  decideSizeRetry,
  nextBitrate: calculateRetryBitrate
};
