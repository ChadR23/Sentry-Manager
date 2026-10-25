'use strict';

// A converter job service whose ffmpeg is a fake child the test controls
// (hold an encode, finish it, fail it), with the real job store and the real
// encoder planner over a fake probe runner. For the lanes tests: which GPU
// each clip encodes on, and how many run at once per GPU.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createJobStore } = require('../../src/main/converter/jobStore');
const { createConverterJobService } = require('../../src/main/converter/jobService');
const { createEncoderPlanner, decodeAccelArgs } = require('../../src/main/converter/encoderPlanner');

const ARC = Object.freeze({ id: 'pci:0000:03:00.0', kind: 'dri', vendor: 'intel', name: 'Intel Arc A380', node: '/dev/dri/renderD129', index: null, pci: '0000:03:00.0' });
const UHD = Object.freeze({ id: 'pci:0000:00:02.0', kind: 'dri', vendor: 'intel', name: 'Intel UHD Graphics 770', node: '/dev/dri/renderD128', index: null, pci: '0000:00:02.0' });
const T400 = Object.freeze({ id: 'pci:0000:01:00.0', kind: 'nvidia', vendor: 'nvidia', name: 'NVIDIA T400', node: null, index: 0, pci: '0000:01:00.0' });
const CPU = Object.freeze({ id: 'cpu', kind: 'cpu', vendor: null, name: 'CPU (software encoder)', node: null, index: null, pci: null });

const ADVERTISED = ['libx265', 'libsvtav1', 'hevc_nvenc', 'av1_nvenc', 'hevc_qsv', 'av1_qsv', 'hevc_vaapi', 'av1_vaapi'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(5);
  }
  return false;
}

// Where an encode's arguments put it: a render node, an NVIDIA index or none.
function gpuOf(args) {
  const at = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  if (at('-gpu')) return `nvidia${at('-gpu')}`;
  const qsv = /child_device=([^,]+)/.exec(at('-init_hw_device') || '');
  if (qsv) return qsv[1];
  return at('-vaapi_device');
}

// The probe runner the planner uses: `works(encoder, args)` says which test
// encodes succeed (the arguments name the GPU, or none for the default one).
function fakeProbe(works) {
  const calls = [];
  const runProbe = async (_command, args) => {
    calls.push(args);
    if (args.includes('-encoders')) return { status: 0, stdout: ADVERTISED.map((name) => ` V..... ${name}  x`).join('\n'), stderr: '' };
    const encoder = args[args.indexOf('-c:v') + 1];
    const result = works(encoder, args);
    if (result === 'timeout') return { status: null, timedOut: true, stdout: '', stderr: '' };
    return result ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: 'not here' };
  };
  return { runProbe, calls };
}

// QSV on the Arc and (H.265 only) on the UHD 770, which is also the default
// GPU without device arguments; NVENC on the T400. No VA-API.
function desktopWorks(encoder, args) {
  if (encoder.startsWith('lib')) return true;
  const gpu = gpuOf(args);
  if (encoder.endsWith('_qsv')) {
    if (gpu === ARC.node) return true;
    if (gpu === UHD.node || gpu === null) return encoder === 'hevc_qsv';
    return false;
  }
  if (encoder.endsWith('_nvenc')) return gpu === 'nvidia0';
  return false;
}

function clipName(index) {
  return `2026-10-20_07-${String(10 + Math.floor(index / 60)).padStart(2, '0')}-${String(index % 60).padStart(2, '0')}-front.mp4`;
}

/**
 * options:
 *   clips          how many clips the scan finds
 *   devices        what resolveDevice finds (by id)
 *   defaultDevice  the id a job without lanes encodes on (the UHD when listed)
 *   works          probe results (see desktopWorks)
 *   behave(args)   'hold' (until released), a number (exit code) or undefined (0 at once)
 *   dir, store     reuse a previous harness's folder (a restart)
 *   timeline       what readTimeline returns for every clip
 *   verifier       replaces the verifier (default: every candidate passes)
 *   copyAsset      replaces the staging copy of a kept original (default: refused)
 */
function createHarness(options = {}) {
  const dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lanes-'));
  const clips = options.clips ?? 6;
  const devices = options.devices || [ARC, UHD, CPU];
  const store = createJobStore({ rootDir: path.join(dir, 'jobs'), fs: fs.promises });
  const probe = fakeProbe(options.works || desktopWorks);
  const planner = createEncoderPlanner({ runProbe: probe.runProbe, platform: 'linux', ffmpegPath: 'ffmpeg' });
  const spawned = [];
  const resolved = [];
  let pid = 1000;

  function spawnProcess(command, args) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = (pid += 1);
    const entry = { command, args, child, done: false, gpu: gpuOf(args) };
    const finish = (code, signal = null) => {
      if (entry.done) return;
      entry.done = true;
      setImmediate(() => child.emit('close', code, signal));
    };
    entry.finish = (code = 0) => finish(code);
    child.kill = (signal) => finish(null, signal || 'SIGTERM');
    spawned.push(entry);
    const behaviour = options.behave ? options.behave(args, entry) : undefined;
    if (behaviour !== 'hold') {
      setImmediate(() => {
        child.stdout.emit('data', 'fps=100\nprogress=end\n');
        finish(typeof behaviour === 'number' ? behaviour : 0);
      });
    }
    return child;
  }

  async function* scanner(config) {
    for (let index = 0; index < clips; index += 1) {
      const name = clipName(index);
      yield {
        kind: 'video', group: 'RecentClips', eventId: null,
        relativePath: `RecentClips/${name}`, sourcePath: path.join(config.sourceRoot, 'RecentClips', name),
        sourceBytes: 4_000_000, mtimeMs: 1_700_000_000_000 + index, timestampKey: name.slice(0, 19), camera: 'front'
      };
    }
  }

  const owned = { ownedPaths: {}, ownedArtifacts: {} };
  const stagingManager = {
    reserveEncodeOutput: async ({ itemId }) => ({ path: path.join(dir, 'work', `${itemId}-encoded.mp4`), ...owned }),
    adoptEncodeOutput: async ({ itemId }) => ({ path: path.join(dir, 'work', `${itemId}-encoded.mp4`), ...owned }),
    copyAsset: options.copyAsset || (async () => { throw Object.assign(new Error('no assets here'), { code: 'UNEXPECTED' }); }),
    publishSeparate: async ({ destination }) => ({ finalPath: destination, outputBytes: 1_000_000, ...owned }),
    replaceOriginal: async () => { throw Object.assign(new Error('no replace here'), { code: 'UNEXPECTED' }); },
    cleanupOwnedArtifacts: async () => ({ cleaned: true })
  };

  const deps = {
    store,
    scanner,
    planner,
    stagingManager,
    ensureDestinationParent: async () => ({ revalidate: async () => {} }),
    inspectVideo: async () => ({ codec: 'h264', durationSeconds: 2, containerReserveBytes: 0, telemetryReserveBytes: 0 }),
    readTimeline: async () => options.timeline || ({ frames: [] }),
    writers: { h265: async () => {}, av1: async () => {} },
    verifier: options.verifier || (async () => ({ ok: true, outputBytes: 1_000_000, publicationArtifact: null })),
    spawnProcess,
    ffmpegPath: 'ffmpeg',
    decodeAccel: options.gpuDecode === false ? undefined : (encoder, accel = {}) => decodeAccelArgs(encoder, {
      platform: 'linux', zeroCopy: accel.zeroCopy === true, ...(accel.device ? { device: accel.device } : {})
    }),
    resolveDevice: async (id) => {
      resolved.push(id);
      return devices.find((device) => device.id === id) || null;
    },
    // the GPU a job without lanes encodes on: QSV without a device opens
    // renderD128, the UHD 770 here
    defaultDevice: async () => (options.defaultDevice !== undefined ? options.defaultDevice
      : devices.some((device) => device.id === UHD.id) ? UHD.id : null),
    encodeStallMs: 60_000
  };
  const service = createConverterJobService(deps);
  const destinationRoot = path.join(dir, 'out');

  const config = (over = {}) => ({
    sourceRoot: path.join(dir, 'footage'), destinationRoot,
    codec: 'h265', profileId: 'custom', bitrateKbps: 250, networkMode: 'direct', outputMode: 'separate',
    includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'], groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'],
    replacementConfirmed: false, concurrency: 1, verifyMode: 'quick', ...over
  });

  // encodes running now, per lane (device id, or 'default')
  const running = () => {
    const counts = {};
    for (const live of service.activeEncodes()) {
      const key = live.deviceId ?? 'default';
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  };
  const held = () => spawned.filter((entry) => !entry.done);
  const releaseAll = () => { for (const entry of held()) entry.finish(0); };
  const encodes = () => spawned.filter((entry) => entry.args.includes('pipe:1'));

  async function finishJob(id, ms = 10_000) {
    let done = false;
    const idle = service.whenIdle(id).then(() => { done = true; });
    const end = Date.now() + ms;
    while (!done && Date.now() < end) {
      releaseAll();
      await sleep(5);
    }
    await Promise.race([idle, sleep(50)]);
    if (!done) throw new Error('the job did not finish');
    return service.get(id);
  }

  async function close() {
    for (const job of await service.list()) {
      if (!['completed', 'failed', 'cancelled'].includes(job.state)) await service.cancel(job.id).catch(() => {});
    }
    releaseAll();
    await service.shutdown().catch(() => {});
    if (!options.keep) fs.rmSync(dir, { recursive: true, force: true });
  }

  return { dir, store, service, planner, probe, spawned, encodes, resolved, config, running, held, releaseAll, finishJob, close, destinationRoot };
}

const recoveryFacts = async () => ({
  candidateExists: false, partialExists: false, finalExists: false, sourceExists: true,
  backupExists: false, finalValid: false, partialFinalSameIdentity: false
});

module.exports = { createHarness, fakeProbe, desktopWorks, gpuOf, until, sleep, recoveryFacts, ARC, UHD, T400, CPU, ADVERTISED };
