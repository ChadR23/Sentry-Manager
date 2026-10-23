'use strict';

const crypto = require('crypto');
const nodeFs = require('fs');
const nodePath = require('path');

const { CONCURRENCY, DEVICE_ID } = require('./contracts');
const { createJobStore } = require('./jobStore');
const { createFilesystemTransactionAdapters } = require('./filesystemTransactions');
const { scanTeslaFootage } = require('./scanner');
const { runConverterBenchmark } = require('./benchmark');
const { createEncoderPlanner, decodeAccelArgs } = require('./encoderPlanner');
const { createDeviceDiscovery, CPU_DEVICE } = require('./encodeDevices');
const { createAutoConverter } = require('./autoConvert');
const { extractH264TelemetryTimeline } = require('./telemetryTimeline');
const { createConverterAdapters } = require('./converterAdapters');
const { createVerificationSnapshot } = require('./verificationSnapshot');
const {
  classifyPath,
  checkStagingSpace,
  chooseStagingMode,
  createFileTransaction
} = require('./staging');
const { createConverterJobService } = require('./jobService');
const { createConvertedIndex } = require('./convertedIndex');
const { readMp4VideoCodec } = require('./mp4Header');

const ACTIVE_RECOVERY_STATES = new Set([
  'discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry',
  'verifying', 'copying', 'replacing', 'paused', 'paused_network'
]);
const STAGING_CHUNK_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_DIRECTORY_PREFIX = 'sentry-six-verification-';
const MAX_MEDIA_PROCESS_MS = 12 * 60 * 60 * 1000;
const RETRYABLE_PATH_CODES = new Set([
  'ENOENT', 'ENOTCONN', 'ENETDOWN', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EIO'
]);

function runtimeError(code) {
  return Object.assign(new Error(code), { code });
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function containedPath(root, candidate, pathApi, platform) {
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  if (platform === 'win32') {
    const normalized = relative.toLowerCase();
    return normalized === '' || (normalized !== '..' && !normalized.startsWith(`..${pathApi.sep}`)
      && !pathApi.isAbsolute(relative));
  }
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relative));
}

async function ensureContainedDestinationParent({ destinationRoot, destination, fs, pathApi = nodePath,
  platform = process.platform }) {
  if (typeof destinationRoot !== 'string' || typeof destination !== 'string'
      || !pathApi.isAbsolute(destinationRoot) || !pathApi.isAbsolute(destination)) {
    throw runtimeError('UNSAFE_DESTINATION_PATH');
  }
  const root = pathApi.resolve(destinationRoot);
  const parent = pathApi.dirname(pathApi.resolve(destination));
  if (!containedPath(root, parent, pathApi, platform)) throw runtimeError('UNSAFE_DESTINATION_PATH');

  async function lstatDirectory(target) {
    const stat = await fs.lstat(target, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()
        || !['bigint', 'number'].includes(typeof stat.dev)
        || !['bigint', 'number'].includes(typeof stat.ino)) {
      throw runtimeError('UNSAFE_DESTINATION_PATH');
    }
    return stat;
  }

  let existing = root;
  while (true) {
    try {
      await fs.lstat(existing, { bigint: true });
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const next = pathApi.dirname(existing);
      if (next === existing) throw error;
      existing = next;
    }
  }
  if (!containedPath(existing, parent, pathApi, platform)) throw runtimeError('UNSAFE_DESTINATION_PATH');

  const existingStat = await lstatDirectory(existing);
  const realExisting = await fs.realpath(existing);
  const relative = pathApi.relative(existing, parent);
  const components = relative === '' ? [] : relative.split(pathApi.sep).filter(Boolean);
  const captured = [{ path: existing, real: realExisting, dev: String(existingStat.dev), ino: String(existingStat.ino) }];
  let current = existing;
  let expectedReal = realExisting;
  for (const component of components) {
    current = pathApi.join(current, component);
    expectedReal = pathApi.join(expectedReal, component);
    let stat;
    try {
      stat = await lstatDirectory(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try { await fs.mkdir(current); } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      stat = await lstatDirectory(current);
    }
    const real = await fs.realpath(current);
    if (!sameResolvedPath(real, expectedReal, pathApi, platform)
        || !containedPath(realExisting, real, pathApi, platform)) throw runtimeError('UNSAFE_DESTINATION_PATH');
    captured.push({ path: current, real, dev: String(stat.dev), ino: String(stat.ino) });
  }

  async function revalidate() {
    for (const proof of captured) {
      let stat;
      let real;
      try {
        stat = await lstatDirectory(proof.path);
        real = await fs.realpath(proof.path);
      } catch (error) {
        if (RETRYABLE_PATH_CODES.has(error?.code)) throw error;
        throw runtimeError('UNSAFE_DESTINATION_PATH');
      }
      if (String(stat.dev) !== proof.dev || String(stat.ino) !== proof.ino
          || !sameResolvedPath(real, proof.real, pathApi, platform)) {
        throw runtimeError('UNSAFE_DESTINATION_PATH');
      }
    }
  }
  return Object.freeze({ atomicContainment: false, revalidate });
}

function sameResolvedPath(left, right, pathApi, platform) {
  const resolvedLeft = pathApi.resolve(left);
  const resolvedRight = pathApi.resolve(right);
  return platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function validateProcessRequest(command, args, options) {
  if (typeof command !== 'string' || command.length === 0 || command.length > 32_768 || command.includes('\0')
      || !Array.isArray(args) || args.length > 1_024
      || args.some((arg) => typeof arg !== 'string' || arg.length > 32_768 || arg.includes('\0'))
      || options?.shell === true) throw runtimeError('INVALID_PROCESS_REQUEST');
}

// An ffmpeg that picks an NVIDIA GPU by its index (-gpu N, -hwaccel_device N)
// numbers the GPUs as nvidia-smi does, in PCI order. Everything else keeps
// CUDA's own order ("fastest first"), so a job without lanes encodes on the
// GPU it always did.
function cudaOrderOptions(args, spawnOptions = {}) {
  const byIndex = args.some((arg, index) => (arg === '-gpu' || arg === '-hwaccel_device') && /^\d+$/.test(args[index + 1] || ''));
  return byIndex ? { env: { ...(spawnOptions.env || process.env), CUDA_DEVICE_ORDER: 'PCI_BUS_ID' } } : {};
}

function createBoundedProcessRunner(options = {}) {
  if (typeof options.spawn !== 'function') throw new TypeError('spawn is required');
  const defaultTimeoutMs = positiveInteger(options.timeoutMs, 30_000);
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, 1024 * 1024);

  return function run(command, args, requestOptions = {}) {
    try {
      validateProcessRequest(command, args, requestOptions);
    } catch (error) {
      return Promise.reject(error);
    }
    const timeoutMs = positiveInteger(requestOptions.timeoutMs, defaultTimeoutMs);
    const signal = requestOptions.signal;
    if (signal?.aborted) {
      return Promise.resolve({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: false, aborted: true });
    }
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let outputLimitExceeded = false;
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let timer;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', abortListener);
        resolve({
          status: result.status,
          signal: result.signal || null,
          stdout: outputLimitExceeded ? '' : stdout,
          stderr: outputLimitExceeded ? '' : stderr,
          timedOut,
          ...(aborted ? { aborted: true } : {}),
          ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
          ...(result.error ? { error: result.error } : {})
        });
      };
      const terminate = () => {
        if (!child || child.killed) return;
        try { child.kill('SIGTERM'); } catch (_error) { /* close/error remains authoritative */ }
      };
      const abortListener = () => { aborted = true; terminate(); };
      const capture = (kind, chunk) => {
        if (outputLimitExceeded) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        outputBytes += bytes.length;
        if (outputBytes > maxOutputBytes) {
          outputLimitExceeded = true;
          stdout = '';
          stderr = '';
          terminate();
          return;
        }
        if (kind === 'stdout') stdout += bytes.toString('utf8');
        else stderr += bytes.toString('utf8');
      };

      try {
        child = options.spawn(command, args, {
          cwd: requestOptions.cwd,
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...cudaOrderOptions(args)
        });
      } catch (_error) {
        finish({ status: null, signal: null, error: { code: 'PROCESS_START_FAILED' } });
        return;
      }
      child.stdout?.on('data', (chunk) => capture('stdout', chunk));
      child.stderr?.on('data', (chunk) => capture('stderr', chunk));
      child.once('error', () => finish({ status: null, signal: null, error: { code: 'PROCESS_START_FAILED' } }));
      child.once('close', (status, closeSignal) => finish({
        status: Number.isInteger(status) ? status : null,
        signal: closeSignal
      }));
      signal?.addEventListener?.('abort', abortListener, { once: true });
      timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    });
  };
}

function sameArtifact(left, right) {
  return left && right
    && left.path === right.path
    && left.token === right.token
    && left.sha256 === right.sha256
    && left.size === right.size;
}

function structurallyOwnedSnapshot(artifact, pathApi, tempRoot) {
  if (!artifact || typeof artifact.path !== 'string' || typeof artifact.token !== 'string'
      || !/^[a-z0-9_-]{1,128}$/i.test(artifact.token)
      || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.size) || artifact.size <= 0) return false;
  const absolute = pathApi.resolve(artifact.path);
  const relative = pathApi.relative(pathApi.resolve(tempRoot), absolute);
  if (relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) return false;
  return pathApi.basename(absolute) === `${artifact.token}.mp4`
    && pathApi.basename(pathApi.dirname(absolute)).startsWith(SNAPSHOT_DIRECTORY_PREFIX);
}

function createVerificationSnapshotRegistry(options = {}) {
  if (typeof options.createSnapshot !== 'function') throw new TypeError('createSnapshot is required');
  const pathApi = options.pathApi || nodePath;
  const tempRoot = pathApi.resolve(options.tempRoot || require('os').tmpdir());
  const live = new Map();
  const consumed = new Set();

  async function createSnapshot(input) {
    const snapshot = await options.createSnapshot({ ...input, tempRoot });
    let artifact;
    try {
      artifact = { path: snapshot.path, token: snapshot.token, sha256: snapshot.sha256, size: snapshot.size };
      if (!structurallyOwnedSnapshot(artifact, pathApi, tempRoot)) throw runtimeError('INVALID_PUBLICATION_ARTIFACT');
    } catch (_error) {
      const rejected = runtimeError('INVALID_PUBLICATION_ARTIFACT');
      try {
        // Only the factory's bounded capability owns this newly created file.
        // Never delete a rejected artifact by its untrusted path or after transfer.
        if (snapshot?.transferred !== true && typeof snapshot?.cleanup === 'function') await snapshot.cleanup();
      } catch (cleanupError) { rejected.cause = cleanupError; }
      throw rejected;
    }
    live.set(artifact.token, artifact);
    return snapshot;
  }

  async function validate(artifact, context = {}) {
    if (!structurallyOwnedSnapshot(artifact, pathApi, tempRoot)) return false;
    if (context.mode === 'consume') {
      const expected = live.get(artifact.token);
      if (!sameArtifact(expected, artifact) || consumed.has(artifact.token)) return false;
      consumed.add(artifact.token);
      return true;
    }
    if (context.mode === 'reconcile') {
      return sameArtifact(artifact, context.persistedArtifact);
    }
    return false;
  }

  return Object.freeze({ createSnapshot, validate });
}

function parseVideoProbe(result) {
  if (!result || result.status !== 0 || result.error || result.timedOut || result.outputLimitExceeded
      || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') throw runtimeError('VIDEO_INSPECTION_FAILED');
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch (_error) { throw runtimeError('VIDEO_INSPECTION_FAILED'); }
  const stream = Array.isArray(parsed?.streams) && parsed.streams.length === 1 ? parsed.streams[0] : null;
  const codecNames = { h264: 'h264', hevc: 'h265', av1: 'av1' };
  const codec = codecNames[stream?.codec_name];
  const duration = Number(stream?.duration || parsed?.format?.duration);
  if (!codec || !Number.isFinite(duration) || duration <= 0) throw runtimeError('VIDEO_INSPECTION_FAILED');
  return { codec, durationSeconds: duration, containerReserveBytes: 0, telemetryReserveBytes: 0 };
}

function createRecoveryInspector({ fs, pathApi }) {
  const exists = async (target, signal) => {
    if (!target) return false;
    if (signal?.aborted) throw runtimeError('CANCELLED');
    try { await fs.lstat(target); return true; } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };
  const matchesDigest = async (target, expected, signal) => {
    if (!target || !expected || !Number.isSafeInteger(expected.size) || !/^[a-f0-9]{64}$/.test(expected.sha256 || '')) return false;
    let handle;
    try {
      handle = await fs.open(target, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== expected.size) return false;
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < stat.size) {
        if (signal?.aborted) throw runtimeError('CANCELLED');
        const request = Math.min(buffer.length, stat.size - offset);
        const { bytesRead } = await handle.read(buffer, 0, request, offset);
        if (bytesRead !== request) return false;
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      return hash.digest('hex') === expected.sha256;
    } finally {
      if (handle) await handle.close();
    }
  };
  return async (manifest, options = {}) => {
    const item = (manifest.items || []).find((entry) => entry.id === manifest.activeItemId) || {};
    const owned = item.ownedPaths || manifest.ownedPaths || {};
    const artifact = item.publicationArtifact || manifest.publicationArtifact;
    const signal = options.signal;
    const replacing = manifest.state === 'replacing' || manifest.recovery?.fromState === 'replacing';
    // Replacing originals, the original at its own name is the "final" only
    // once the swap began ('replacing'); before that it is simply the
    // original, which a restart leaves where it is.
    const finalPath = manifest.config?.outputMode === 'replace'
      ? (replacing ? item.sourcePath : null)
      : manifest.config?.destinationRoot && item.relativePath
        ? pathApi.resolve(manifest.config.destinationRoot, ...item.relativePath.split('/'))
        : null;
    const copying = manifest.state === 'copying' || manifest.recovery?.fromState === 'copying';
    const [candidateExists, partialExists, finalExists, sourceExists, backupExists] = await Promise.all([
      exists(replacing ? owned.replacementCandidate : copying ? null : owned.encodedCandidate, signal),
      exists(owned.destinationPartial, signal),
      exists(replacing ? null : finalPath, signal),
      exists(replacing ? item.sourcePath : null, signal),
      exists(owned.replacementBackup, signal)
    ]);
    const finalValid = (replacing ? sourceExists : finalExists) ? await matchesDigest(finalPath, artifact, signal) : false;
    let partialFinalSameIdentity = false;
    if (partialExists && finalExists) {
      const [partial, final] = await Promise.all([
        fs.lstat(owned.destinationPartial, { bigint: true }), fs.lstat(finalPath, { bigint: true })
      ]);
      partialFinalSameIdentity = partial.isFile() && final.isFile()
        && partial.dev === final.dev && partial.ino === final.ino;
    }
    return { candidateExists, partialExists, finalExists, sourceExists, backupExists, finalValid, partialFinalSameIdentity };
  };
}

function createVolumeInfo(options = {}) {
  if (!options.fs || typeof options.fs.statfs !== 'function') throw new TypeError('statfs is required');
  const pathApi = options.pathApi || nodePath;
  const platform = options.platform || process.platform;
  const runCommand = options.runCommand;
  const powershellPath = options.powershellPath
    || (process.env.SystemRoot
      ? nodePath.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe');
  const cache = new Map();
  const networkTypes = new Set([
    0x6969n, // NFS
    0xff534d42n, // CIFS
    0xfe534d42n, // SMB2
    0x73757245n, // CODA
    0x5346414fn // AFS
  ]);

  async function freeSpace(target) {
    const stat = await options.fs.statfs(target, { bigint: true });
    const available = BigInt(stat.bavail) * BigInt(stat.bsize);
    if (available < 0n) throw runtimeError('FREE_SPACE_UNAVAILABLE');
    return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
  }

  async function classifyPath(target) {
    if (platform === 'win32') {
      if (typeof runCommand !== 'function') return null;
      const root = pathApi.parse(pathApi.resolve(target)).root;
      const key = root.toLowerCase();
      if (!cache.has(key)) {
        cache.set(key, (async () => {
          const script = '([System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($args[0]))).DriveType.ToString()';
          const result = await runCommand(powershellPath, [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, root
          ], { shell: false });
          if (!result || result.status !== 0 || result.error || result.timedOut || result.outputLimitExceeded) return null;
          const kind = String(result.stdout || '').trim();
          if (kind === 'Network') return { remote: true, certain: true };
          if (['Fixed', 'Removable', 'Ram', 'CDRom'].includes(kind)) return { remote: false, certain: true };
          return null;
        })().catch(() => null));
      }
      return cache.get(key);
    }
    try {
      const stat = await options.fs.statfs(target, { bigint: true });
      const type = BigInt(stat.type);
      if (networkTypes.has(type)) return { remote: true, certain: true };
    } catch (_error) { /* Ambiguous filesystems use direct mode. */ }
    return null;
  }

  return Object.freeze({ classifyPath, freeSpace });
}

function defaultFactories() {
  return {
    createJobStore,
    createFileTransaction,
    createEncoderPlanner,
    createConverterAdapters,
    createConverterJobService,
    createDeviceDiscovery
  };
}

// The encoding devices are looked up again at most this often while a job
// finds its lanes' GPUs (once per lane otherwise).
const DEVICE_LIST_TTL_MS = 2_000;

async function realTempPath(pfs, pathApi, target) {
  if (typeof pfs.realpath !== 'function') return target;
  try {
    await pfs.mkdir(target, { recursive: true });
    return pathApi.resolve(await pfs.realpath(target));
  } catch (_) {
    return target;
  }
}

async function createConverterRuntime(options = {}) {
  const fileSystem = options.fs || nodeFs;
  const pfs = fileSystem.promises || fileSystem;
  const pathApi = options.pathApi || nodePath;
  const platform = options.platform || process.platform;
  if (typeof options.userDataPath !== 'string' || typeof options.tempPath !== 'string'
      || !pathApi.isAbsolute(options.userDataPath) || !pathApi.isAbsolute(options.tempPath)) {
    throw runtimeError('INVALID_RUNTIME_PATH');
  }
  if (typeof options.ffmpegPath !== 'string' || options.ffmpegPath.length === 0
      || typeof options.ffprobePath !== 'string' || options.ffprobePath.length === 0) {
    throw runtimeError('CONVERTER_TOOLS_UNAVAILABLE');
  }
  if (typeof options.spawn !== 'function') throw new TypeError('spawn is required');

  const jobsRoot = pathApi.join(options.userDataPath, 'converter-jobs');
  // Clips known to be converted already, so a run skips them while it
  // discovers files (an optimisation only: losing it costs speed, not results).
  const convertedIndex = createConvertedIndex({
    file: pathApi.join(options.userDataPath, 'converter-index', 'converted-clips.json'),
    fs: pfs,
    pathApi
  });
  await convertedIndex.load();
  // Staging refuses any owned file whose real path differs from the path it
  // was given, so the temp folder is resolved to its real location first:
  // macOS reaches it through a link (/var -> /private/var) and Windows may
  // name it with short 8.3 names (C:\Users\LONGNA~1\...). Otherwise every
  // clip would fail its safety check on those machines.
  const tempPath = await realTempPath(pfs, pathApi, options.tempPath);
  const tempRoot = pathApi.join(tempPath, 'sentry-six-converter');
  await pfs.mkdir(jobsRoot, { recursive: true });
  await pfs.mkdir(tempRoot, { recursive: true });

  const factories = { ...defaultFactories(), ...(options.factories || {}) };
  const processRunner = createBoundedProcessRunner({
    spawn: options.spawn,
    timeoutMs: positiveInteger(options.processTimeoutMs, MAX_MEDIA_PROCESS_MS),
    maxOutputBytes: options.maxProcessOutputBytes
  });
  const snapshotRegistry = createVerificationSnapshotRegistry({
    createSnapshot: options.createVerificationSnapshot || createVerificationSnapshot,
    pathApi,
    tempRoot: tempPath
  });
  const store = factories.createJobStore({ rootDir: jobsRoot, fs: pfs });
  const filesystemTransactions = createFilesystemTransactionAdapters({ fs: fileSystem, platform });
  const removeOwned = options.removeOwned || filesystemTransactions.removeOwned;
  const renameExclusive = options.renameExclusive || filesystemTransactions.renameExclusive;
  const stagingOptions = {
    // One staged source and one encode output per parallel conversion.
    maxActiveLeases: CONCURRENCY.max,
    // Every copied chunk is journaled into the job manifest (twice) so a crash
    // can always prove what it owns. On a large job one manifest save costs
    // ~0.1 s, so 1 MiB chunks spent ~15 s per clip on bookkeeping; 16 MiB
    // chunks keep the same guarantees with 16x fewer saves and far fewer
    // network round trips on SMB sources and destinations.
    chunkSize: STAGING_CHUNK_BYTES,
    fs: fileSystem,
    pathApi,
    platform,
    validatePublicationArtifact: snapshotRegistry.validate,
    removeOwned,
    renameExclusive,
    // The converter's own work files are removed by exact name and identity
    // (see staging) where the host says its temp folder is private to it.
    ...(options.privateTempIdentityCleanup === true ? { privateTempCleanup: 'identity' } : {})
  };
  const stagingManager = factories.createFileTransaction({ ...stagingOptions, tempRoot });
  const planner = factories.createEncoderPlanner({
    runProbe: processRunner,
    platform,
    ffmpegPath: options.ffmpegPath
  });
  // The GPUs (and the CPU) a conversion can be set to use, one by one. Only
  // read when something asks: the Encoder page, a job with lanes, the
  // benchmark.
  const discovery = factories.createDeviceDiscovery({
    fs: fileSystem,
    pathApi,
    platform,
    runCommand: processRunner,
    ...(typeof options.deviceNameOf === 'function' ? { nameOf: options.deviceNameOf } : {}),
    ...(options.deviceDiscovery || {})
  });
  // One lookup at a time: callers while it runs share it, and its answer
  // is reused for DEVICE_LIST_TTL_MS after it arrives.
  let deviceList = null;
  async function listDevices() {
    try {
      const list = await discovery.list();
      return Array.isArray(list) && list.length > 0 ? list : [CPU_DEVICE];
    } catch (_) { return [CPU_DEVICE]; }
  }
  function lookUpDevices() {
    if (deviceList && deviceList.at === null) return deviceList.list;
    const entry = { at: null, list: null };
    entry.list = listDevices().finally(() => { entry.at = Date.now(); });
    deviceList = entry;
    return entry.list;
  }
  function recentDevices() {
    if (deviceList && (deviceList.at === null || Date.now() - deviceList.at <= DEVICE_LIST_TTL_MS)) return deviceList.list;
    return lookUpDevices();
  }
  // A lane's device id from a saved job or the browser, looked up only in
  // this list: node paths and NVIDIA indexes always come from here.
  async function resolveDevice(id) {
    if (typeof id !== 'string' || !DEVICE_ID.test(id)) return null;
    return (await recentDevices()).find((device) => device.id === id) || null;
  }
  // The device a job without lanes encodes a codec on (planner.select's
  // choice). NVENC without -gpu takes the first NVIDIA GPU that can, in
  // CUDA's own order, which the list can only tell when one NVIDIA GPU can
  // (`able` says which can; unknown counts as able). `probe: false`: only a
  // choice made already, else null.
  async function defaultDeviceOf(list, family, { able = () => true, probe = true } = {}) {
    let selected;
    try { selected = await planner.select(family, { probe }); } catch (_) { return null; }
    if (!selected) return null;
    if (selected.hardware !== true) return 'cpu';
    if (selected.codec.endsWith('_nvenc')) {
      const nvidia = list.filter((device) => device.kind === 'nvidia' && able(device));
      return nvidia.length === 1 ? nvidia[0].id : null;
    }
    return list.find((device) => device.kind === 'dri' && pathApi.basename(device.node || '') === 'renderD128')?.id || null;
  }
  const adapters = factories.createConverterAdapters({
    fs: pfs,
    runFfprobe: processRunner,
    runFullDecode: processRunner,
    verifierOptions: {
      ffmpegPath: options.ffmpegPath,
      ffprobePath: options.ffprobePath,
      createSnapshot: snapshotRegistry.createSnapshot,
      // The candidate is a private temp file: move it into the snapshot
      // instead of writing a second full copy of every converted clip.
      adoptCandidate: true,
      // and that private snapshot is hashed once where it is analysed (the
      // copy that publishes it compares its bytes with that hash again)
      ...(options.privateTempIdentityCleanup === true ? { trustedSnapshot: true } : {})
    }
  });

  const volumeInfo = options.volumeInfo || createVolumeInfo({
    fs: pfs,
    pathApi,
    platform,
    runCommand: processRunner
  });
  const probeArgs = (source) => ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,duration:format=duration', '-of', 'json', source];
  // A busy computer (or a virus scanner checking FFprobe the first time) can
  // make one probe run out of time: that probe is tried once more, longer.
  const inspectVideo = async (_item, source, signal) => {
    const first = await processRunner(options.ffprobePath, probeArgs(source), { signal, shell: false, timeoutMs: 30_000 });
    if (!first?.timedOut || signal?.aborted) return parseVideoProbe(first);
    return parseVideoProbe(await processRunner(options.ffprobePath, probeArgs(source), { signal, shell: false, timeoutMs: 120_000 }));
  };
  const readTimeline = async ({ source, signal }) => {
    if (signal?.aborted) throw runtimeError('CANCELLED');
    const bytes = await pfs.readFile(source);
    if (signal?.aborted) throw runtimeError('CANCELLED');
    return extractH264TelemetryTimeline(bytes);
  };
  const scanner = (config, scanOptions = {}) => scanTeslaFootage(config, {
    signal: scanOptions.signal,
    retryOperation: scanOptions.retryOperation,
    concurrency: 16,
    path: pathApi,
    platform
  });
  const inspectRecovery = createRecoveryInspector({ fs: pfs, pathApi });
  const network = options.network || {
    isRetryable: (error) => RETRYABLE_PATH_CODES.has(error?.code),
    checkPath: async (target, checkOptions = {}) => {
      let probe = pathApi.resolve(target);
      while (true) {
        try { await pfs.access(probe); return true; } catch (error) {
          if (error?.code !== 'ENOENT' || checkOptions.allowAncestor !== true) return false;
          const parent = pathApi.dirname(probe);
          if (parent === probe) return false;
          probe = parent;
        }
      }
    }
  };
  const spawnProcess = (command, args, spawnOptions = {}) => {
    validateProcessRequest(command, args, spawnOptions);
    return options.spawn(command, args, { ...spawnOptions, ...cudaOrderOptions(args, spawnOptions), shell: false, windowsHide: true });
  };
  // Everything a converter service needs besides its job store and staging
  // area; the benchmark builds an identical, isolated service from this.
  const serviceDeps = {
    scanner,
    planner,
    inspectVideo,
    readTimeline,
    writers: adapters.writers,
    verifier: adapters.verifier,
    spawnProcess,
    ffmpegPath: options.ffmpegPath,
    // Decode on the encoder's GPU (falls back to CPU decoding automatically).
    decodeAccel: options.gpuDecode === false ? undefined : (encoder, accel = {}) => decodeAccelArgs(encoder, {
      platform, zeroCopy: accel.zeroCopy === true, ...(accel.device ? { device: accel.device } : {})
    }),
    // A lane's GPU, from the devices this container has now.
    resolveDevice,
    // The device a job without lanes encodes on: its workers and that
    // device's lane share it while a job switches between the two.
    defaultDevice: async (codec) => defaultDeviceOf(await recentDevices(), codec),
    pathApi,
    network,
    classifyPath: (target) => classifyPath(target, { pathApi, platform, volumeInfo }),
    chooseStagingMode: (request) => chooseStagingMode(request).mode,
    checkStagingSpace: (request) => checkStagingSpace({ ...request, tempRoot, volumeInfo }),
    inspectRecovery,
    // Persist discovered files in batches and let discovery run ahead of
    // conversion (item ids are tiny; the manifest itself caps the item count),
    // instead of one full manifest rewrite per file in lock-step with encoding.
    skipDiscovered: (config, discovered) => auto.isKnown(config, discovered),
    discoveryBatchSize: 200,
    discoveryFlushMs: 250,
    // As many as a job can hold (jobStore's item limit), so discovery is
    // never held back by the queue: the job knows every clip early and the
    // time remaining covers the whole archive, not the first 10,000 clips.
    queueLimit: 50_000,
    // How long ffmpeg may go without reporting progress before it counts
    // as stuck (jobService's default when unset).
    encodeStallMs: options.encodeStallMs,
    // The MP4 header check discovery uses to skip converted clips, and the
    // stat that records a newly converted clip in the index.
    readVideoCodec: (source, readOptions = {}) => readMp4VideoCodec(source, { ...readOptions, fs: pfs }),
    statFile: (target) => pfs.stat(target),
    pathExists: async (target) => {
      try {
        await pfs.lstat(target);
        return true;
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
    },
    ensureDestinationParent: ({ destinationRoot, destination }) => ensureContainedDestinationParent({
      destinationRoot, destination, fs: pfs, pathApi, platform
    })
  };
  // Only the real service records clips in the index: the benchmark converts
  // temporary copies.
  const service = factories.createConverterJobService({ ...serviceDeps, store, stagingManager, convertedIndex });

  // Each verified clip leaves its (now empty) private snapshot folder behind
  // once the snapshot is published. Remove empty ones while nothing is
  // converting; rmdir never removes a folder that still holds a file.
  let snapshotSweep = null;
  function sweepEmptySnapshotFolders() {
    if (snapshotSweep) return snapshotSweep;
    snapshotSweep = (async () => {
      try {
        if (await hasActiveJob() || benchmarkController) return;
        const names = await pfs.readdir(tempPath);
        const cutoff = Date.now() - 60_000; // never a folder that may be in use right now
        for (const name of names) {
          if (!name.startsWith(SNAPSHOT_DIRECTORY_PREFIX)) continue;
          const folder = pathApi.join(tempPath, name);
          const stat = await pfs.stat(folder).catch(() => null);
          if (!stat?.isDirectory() || stat.mtimeMs > cutoff) continue;
          await pfs.rmdir(folder).catch(() => {});
        }
      } catch (_) { /* best effort */ }
    })().finally(() => { snapshotSweep = null; });
    return snapshotSweep;
  }

  // A crash or forced shutdown mid-conversion leaves snapshot folders that
  // still hold a partial copy, which the empty-folder sweep above never
  // removes. When no job is unfinished at all (so nothing can resume into
  // them), delete leftovers older than an hour.
  // Partial encodes left by earlier versions when a stop came while several
  // clips were converting (only one worker's was cleaned up). An encode never
  // runs an hour, and a file any saved job still names is kept.
  async function sweepLeftoverEncodes(knownJobs) {
    try {
      const owned = new Set();
      const collect = (paths) => { for (const value of Object.values(paths || {})) if (typeof value === 'string') owned.add(pathApi.resolve(value)); };
      for (const job of knownJobs || []) {
        collect(job.ownedPaths);
        for (const item of job.items || []) collect(item.ownedPaths);
      }
      const names = await pfs.readdir(tempRoot).catch(() => []);
      const cutoff = Date.now() - 60 * 60_000;
      let removed = 0;
      for (const name of names) {
        if (!/-encoded\.(mp4|mkv|mov)$/i.test(name)) continue;
        const file = pathApi.join(tempRoot, name);
        if (owned.has(pathApi.resolve(file))) continue;
        const stat = await pfs.lstat(file).catch(() => null);
        if (!stat?.isFile() || stat.mtimeMs > cutoff) continue;
        try {
          await pfs.unlink(file);
          removed += 1;
        } catch (_) { /* in use or already gone */ }
      }
      if (removed) console.log(`[CONVERTER] Removed ${removed} partial encode(s) left from an earlier stop`);
      return removed;
    } catch (_) { return 0; }
  }

  // At startup nothing converts yet, so a snapshot folder no saved job
  // records (a stop between a clip's verification and the record of its
  // snapshot) can only be a leftover, whatever its age.
  async function sweepUnreferencedSnapshotFolders(jobs) {
    try {
      const owned = [];
      const collect = (paths) => { for (const value of Object.values(paths || {})) if (typeof value === 'string') owned.push(pathApi.resolve(value)); };
      const collectArtifacts = (artifacts) => { for (const value of Object.values(artifacts || {})) if (typeof value?.path === 'string') owned.push(pathApi.resolve(value.path)); };
      for (const job of jobs) {
        collect(job.ownedPaths);
        collectArtifacts(job.ownedArtifacts);
        if (job.publicationArtifact?.path) owned.push(pathApi.resolve(job.publicationArtifact.path));
        for (const item of job.items || []) {
          collect(item.ownedPaths);
          collectArtifacts(item.ownedArtifacts);
          if (item.publicationArtifact?.path) owned.push(pathApi.resolve(item.publicationArtifact.path));
        }
      }
      const names = await pfs.readdir(tempPath);
      let removed = 0;
      for (const name of names) {
        if (!name.startsWith(SNAPSHOT_DIRECTORY_PREFIX)) continue;
        const folder = pathApi.join(tempPath, name);
        const stat = await pfs.lstat(folder).catch(() => null);
        if (!stat?.isDirectory() || stat.isSymbolicLink?.()) continue;
        const inside = pathApi.resolve(folder) + pathApi.sep;
        if (owned.some((entry) => entry === pathApi.resolve(folder) || entry.startsWith(inside))) continue;
        try {
          if (typeof pfs.rm === 'function') await pfs.rm(folder, { recursive: true, force: true });
          else await pfs.rmdir(folder);
          removed += 1;
        } catch (_) { /* already gone */ }
      }
      if (removed) console.log(`[CONVERTER] Removed ${removed} leftover verification folder(s) from before the restart`);
      return removed;
    } catch (_) { return 0; }
  }

  async function sweepLeftoverSnapshotFolders(knownJobs = null) {
    try {
      const jobs = knownJobs || await store.list();
      if (jobs.some((job) => !['completed', 'failed', 'cancelled'].includes(job.state)) || benchmarkController) return 0;
      // Never touch a folder any saved job still points into.
      const owned = [];
      const collect = (paths) => { for (const value of Object.values(paths || {})) if (typeof value === 'string') owned.push(pathApi.resolve(value)); };
      for (const job of jobs) {
        collect(job.ownedPaths);
        collect(job.ownedArtifacts);
        for (const item of job.items || []) { collect(item.ownedPaths); collect(item.ownedArtifacts); }
      }
      const names = await pfs.readdir(tempPath);
      const cutoff = Date.now() - 60 * 60_000;
      let removed = 0;
      for (const name of names) {
        if (!name.startsWith(SNAPSHOT_DIRECTORY_PREFIX)) continue;
        const folder = pathApi.join(tempPath, name);
        const stat = await pfs.lstat(folder).catch(() => null);
        if (!stat?.isDirectory() || stat.isSymbolicLink?.() || stat.mtimeMs > cutoff) continue;
        const inside = pathApi.resolve(folder) + pathApi.sep;
        if (owned.some((entry) => entry === pathApi.resolve(folder) || entry.startsWith(inside))) continue;
        try {
          if (typeof pfs.rm === 'function') await pfs.rm(folder, { recursive: true, force: true });
          else await pfs.rmdir(folder);
          removed += 1;
        } catch (_) { /* in use or already gone */ }
      }
      if (removed) console.log(`[CONVERTER] Removed ${removed} leftover work folder(s) from an earlier session`);
      return removed;
    } catch (_) { return 0; }
  }
  async function hasActiveJob() {
    return (await service.list()).some((job) => !['completed', 'failed', 'cancelled'].includes(job.state)
      && !(job.state === 'paused' && job.recovery?.action === 'manual-intervention'));
  }

  // Automatic conversion of new clips (off until the user turns it on).
  const auto = createAutoConverter({
    service,
    scanner,
    fs: pfs,
    pathApi,
    directory: pathApi.join(options.userDataPath, 'converter-auto'),
    isBusy: async () => benchmarkController !== null || await hasActiveJob(),
    ...(typeof options.isCheapNow === 'function' ? { isCheapNow: options.isCheapNow } : {}),
    onChange: (state) => { for (const listener of autoListeners) { try { listener(state); } catch (_) { /* isolated */ } } },
    ...(options.autoTimers ? { timers: options.autoTimers } : {}),
    ...(options.autoClock ? { now: options.autoClock.now, hourOf: options.autoClock.hourOf } : {})
  });
  const autoListeners = new Set();

  // Per-file timing log: one line per converted file showing where its
  // wall-clock time went (<userData>/converter-logs/<jobId>.log). Best effort:
  // logging never affects a conversion.
  const timingLogRoot = pathApi.join(options.userDataPath, 'converter-logs');
  let timingLogChain = Promise.resolve();
  const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
  if (typeof service.subscribe === 'function') service.subscribe((event) => {
    if (event?.type === 'snapshot' && ['completed', 'failed', 'cancelled'].includes(event.snapshot?.state)) {
      setTimeout(() => { void sweepEmptySnapshotFolders(); }, 1000)?.unref?.();
    }
    if (event?.type !== 'item_timing' || typeof event.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.jobId)) return;
    // Let the app pre-make a preview filmstrip for the newly saved clip.
    if (typeof options.onClipConverted === 'function' && typeof event.outputPath === 'string') {
      try { options.onClipConverted(event.outputPath); } catch (_) { /* previews are best effort */ }
    }
    const phases = Object.entries(event.phases || {}).filter(([, ms]) => ms > 0)
      .map(([phase, ms]) => `${phase}=${seconds(ms)}`).join(' ');
    // slot: how long the clip held the one-at-a-time save slot
    const slot = Number.isFinite(event.slotMs) ? ` slot=${seconds(event.slotMs)}` : '';
    const line = `${new Date().toISOString()} ${event.relativePath} total=${seconds(event.totalMs || 0)} ${phases}${slot}`
      + ` encoder=${event.encoder} attempts=${event.attempts} bytes=${event.sourceBytes}->${event.outputBytes}\n`;
    timingLogChain = timingLogChain
      .then(() => pfs.mkdir(timingLogRoot, { recursive: true }))
      .then(() => pfs.appendFile(pathApi.join(timingLogRoot, `${event.jobId}.log`), line))
      .catch(() => undefined);
  });

  const canRemoveOwned = removeOwned?.atomicOwnershipCheck === true && typeof removeOwned.remove === 'function';
  const canPromote = renameExclusive?.atomicNoReplace === true && typeof renameExclusive.promote === 'function';
  const stagingCapabilities = stagingManager.capabilities || {
    separatePublication: canPromote && canRemoveOwned ? 'native-atomic'
      : canPromote || !renameExclusive ? 'hardlink-cleanup-pending' : 'unavailable',
    ownershipCleanup: canRemoveOwned ? 'atomic-expected-ownership' : 'unavailable',
    replacement: canRemoveOwned && removeOwned.guardedRemoval === true && canPromote && renameExclusive.atomicExpectedOwnership === true ? 'available' : 'unavailable'
  };
  // Node exposes no descriptor-relative create/open primitive that can bind the
  // later transaction to this directory identity. The fallback therefore
  // advertises revalidation, not atomic containment, and fails closed on every
  // observed component/path/identity change.
  const capabilities = Object.freeze({
    ...stagingCapabilities,
    destinationContainment: 'pathname-revalidated-non-atomic'
  });
  let startPromise;
  let shutdownPromise;
  let recoveryPromise;
  // Benchmark: one at a time, never while a conversion runs (the numbers would
  // be meaningless and the encoders shared). It runs the real converter in an
  // isolated temporary job store, staging area and output folder.
  let benchmarkController = null;
  const benchmarkServices = new Set();
  // ffmpeg converting right now (a job's or the benchmark's)
  function encodingNow() {
    if (benchmarkController) return true;
    return typeof service.activeEncodes === 'function' && service.activeEncodes().length > 0;
  }
  async function findBenchmarkClips(sourceRoot, signal) {
    if (typeof sourceRoot !== 'string' || sourceRoot.length === 0) return [];
    // In an archive that is partly converted the first folders hold mostly
    // converted clips (and the odd original that failed before), so look
    // through a few thousand files. Converted clips are far smaller than the
    // originals, so the largest are tried first; at most 64 are inspected.
    const found = [];
    try {
      for await (const item of scanTeslaFootage({ sourceRoot }, { signal, path: pathApi, platform, concurrency: 16 })) {
        if (item.kind === 'video') found.push(item);
        if (found.length >= 4000) break;
      }
    } catch (_) { return []; }
    const clips = [];
    const names = new Set();
    let inspected = 0;
    for (const item of found.sort((left, right) => right.sourceBytes - left.sourceBytes)) {
      const name = pathApi.basename(item.sourcePath);
      if (names.has(name)) continue;
      if (inspected >= 64) break;
      inspected += 1;
      try {
        if ((await inspectVideo(item, item.sourcePath, signal)).codec !== 'h264') continue;
      } catch (_) { continue; }
      names.add(name);
      clips.push({ sourcePath: item.sourcePath, name });
      if (clips.length >= 8) break;
    }
    return clips;
  }

  async function countFrames(target) {
    const result = await processRunner(options.ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0', '-count_packets',
      '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', target
    ], { shell: false, timeoutMs: 60_000 });
    const frames = Number.parseInt(String(result?.stdout || '').trim(), 10);
    return Number.isSafeInteger(frames) && frames > 0 ? frames : 0;
  }

  function benchmarkLevelRunner(config) {
    // With a device, the level runs on that GPU alone (a lane of its own).
    const lanes = (level) => (config.device ? { lanes: [{ device: config.device.id, concurrency: level }] } : {});
    return async ({ level, sourceRoot, workRoot, signal, verifyMode }) => {
      const stagingRoot = pathApi.join(workRoot, 'staging');
      await pfs.mkdir(stagingRoot, { recursive: true });
      await pfs.mkdir(pathApi.join(workRoot, 'output'), { recursive: true });
      const benchService = factories.createConverterJobService({
        ...serviceDeps,
        // the GPU under test and no other (never a fallback to another one)
        ...(config.device ? { resolveDevice: async (id) => (id === config.device.id ? config.device : null) } : {}),
        store: factories.createJobStore({ rootDir: pathApi.join(workRoot, 'jobs'), fs: pfs }),
        stagingManager: factories.createFileTransaction({ ...stagingOptions, tempRoot: stagingRoot })
      });
      benchmarkServices.add(benchService);
      const jobId = await benchService.start({
        sourceRoot,
        destinationRoot: pathApi.join(workRoot, 'output'),
        codec: config.codec,
        profileId: config.profileId,
        ...(config.profileId === 'custom' ? { bitrateKbps: config.bitrateKbps } : {}),
        ...(config.profileId === 'quality' ? { qualityLevel: config.qualityLevel } : {}),
        verifyMode: verifyMode || config.verifyMode || 'quick',
        networkMode: 'direct',
        outputMode: 'separate',
        includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'],
        replacementConfirmed: false,
        concurrency: level,
        ...lanes(level)
      });
      const abort = () => { void benchService.cancel(jobId).catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        return await benchService.whenIdle(jobId);
      } finally {
        signal?.removeEventListener('abort', abort);
        await benchService.shutdown().catch(() => {});
        benchmarkServices.delete(benchService);
      }
    };
  }

  const runtime = {
    service,
    store,
    stagingManager,
    capabilities,
    // Runs the benchmark for each requested codec in turn (H.265 then AV1 by
    // default) so the results can be compared side by side. A codec this
    // computer cannot encode is reported as unsupported instead of failing.
    // With two or more GPUs, every GPU is benchmarked by itself in turn (the
    // others stay idle) and gets results of its own.
    async runBenchmark({ codec, codecs, profileId = 'balanced', bitrateKbps, qualityLevel, verifyMode = 'quick', sourceRoot = null, onProgress } = {}) {
      const requested = Array.isArray(codecs) && codecs.length > 0 ? codecs : [codec || 'h265'];
      if (shutdownPromise) throw runtimeError('SERVICE_SHUTDOWN');
      if (benchmarkController) throw runtimeError('BENCHMARK_ACTIVE');
      if (await hasActiveJob()) throw runtimeError('JOB_ACTIVE');
      const controller = new AbortController();
      benchmarkController = controller;
      try {
        onProgress?.({ step: 'scan' });
        const clips = await findBenchmarkClips(sourceRoot, controller.signal);
        if (clips.length === 0) throw runtimeError('BENCHMARK_SOURCE_REQUIRED');
        const settings = { profileId, bitrateKbps, qualityLevel, verifyMode };
        // Off only checks the file's hash and size: the comparison times the
        // two modes that verify a conversion, Quick and Full.
        const runCodecs = async ({ select, device = null, progress = {} }) => {
          const runs = [];
          for (const [index, current] of requested.entries()) {
            let encoder;
            try { encoder = await select(current); } catch (_) { encoder = null; }
            if (!encoder || (device && encoder.hardware !== true)) {
              runs.push({ codec: current, error: 'UNSUPPORTED', encoder: null, results: [], best: null, clips: 0 });
              continue;
            }
            const shown = Object.freeze({ family: encoder.family, codec: encoder.codec, hardware: encoder.hardware });
            try {
              const result = await runConverterBenchmark({
                clips, countFrames, encoder: shown, tempRoot, signal: controller.signal, pathApi, fs: pfs,
                verifyMode, compareVerifyModes: ['quick', 'full'],
                // Energy per level when the server can measure it (files per Wh).
                powerMeter: options.powerMeter,
                onProgress: (step) => onProgress?.({ ...step, codec: current, codecIndex: index + 1, codecTotal: requested.length, ...progress }),
                runLevel: benchmarkLevelRunner({ codec: current, ...settings, ...(device ? { device } : {}) })
              });
              runs.push({ codec: current, ...result });
            } catch (error) {
              if (error?.code === 'CANCELLED' || controller.signal.aborted) throw error;
              runs.push({ codec: current, error: typeof error?.code === 'string' ? error.code : 'BENCHMARK_FAILED',
                encoder: shown, results: [], best: null, clips: 0 });
            }
          }
          return runs;
        };
        const gpus = (await lookUpDevices()).filter((device) => device.kind !== 'cpu');
        if (controller.signal.aborted) throw runtimeError('CANCELLED');
        if (gpus.length < 2 || typeof planner.selectFor !== 'function') {
          const runs = await runCodecs({ select: (current) => planner.select(current) });
          // Single-codec shape kept for older callers; codecs[] holds every run.
          const first = runs.find((run) => !run.error) || runs[0];
          return { ...first, codecs: runs };
        }
        // A codec a GPU cannot encode is unsupported on that GPU; it is never
        // measured on the CPU instead. The same sample clips serve every GPU.
        const devices = [];
        for (const [deviceIndex, gpu] of gpus.entries()) {
          const named = Object.freeze({ id: gpu.id, name: gpu.name });
          devices.push({
            device: named,
            codecs: await runCodecs({
              select: (current) => planner.selectFor(current, gpu),
              device: gpu,
              progress: { device: named, deviceIndex: deviceIndex + 1, deviceTotal: gpus.length }
            })
          });
        }
        return { devices };
      } finally {
        if (benchmarkController === controller) benchmarkController = null;
      }
    },
    cancelBenchmark() {
      benchmarkController?.abort();
    },
    // The devices conversions can be set to use, each with the encoder it
    // proved for H.265 and AV1 (null: that GPU can only do it on the CPU;
    // left out: not known yet), and the one a job without lanes uses for
    // each codec. Proofs are kept, so only the first call runs test encodes.
    // With fewer than two GPUs the Encoder page keeps its single number:
    // nothing is tested or logged then (encoders null), as before lanes.
    // While something converts, a GPU is not tested either (a test encode
    // it fails only for being busy would rule it out); what is known
    // already is given.
    async devices() {
      const list = await lookUpDevices();
      if (list.filter((device) => device.kind !== 'cpu').length < 2) {
        return { devices: list.map((device) => ({ ...device, encoders: null })), defaultDevice: null, defaultDevices: null };
      }
      const probe = !encodingNow();
      const encoderFor = async (family, device) => {
        try {
          const chosen = await planner.selectFor(family, device, { probe });
          if (!chosen || chosen.timedOut === true) return undefined;
          return chosen.hardware === true || device.kind === 'cpu' ? chosen.codec : null;
        } catch (_) { return null; }
      };
      const devices = await Promise.all(list.map(async (device) => {
        const [h265, av1] = await Promise.all([encoderFor('h265', device), encoderFor('av1', device)]);
        const encoders = {};
        if (h265 !== undefined) encoders.h265 = h265;
        if (av1 !== undefined) encoders.av1 = av1;
        return { ...device, encoders };
      }));
      const defaultFor = (family) => defaultDeviceOf(list, family, {
        probe, able: (device) => devices.find((entry) => entry.id === device.id)?.encoders[family] !== null
      });
      const defaultDevices = { h265: await defaultFor('h265'), av1: await defaultFor('av1') };
      // (defaultDevice: H.265's, for pages that know only the one)
      return { devices, defaultDevice: defaultDevices.h265, defaultDevices };
    },
    resolveDevice,
    // Every ffmpeg encoding right now, a benchmark's included (those carry
    // benchmark: true and a temporary job id).
    activeEncodes() {
      const encodes = typeof service.activeEncodes === 'function' ? service.activeEncodes() : [];
      for (const benchService of benchmarkServices) {
        if (typeof benchService.activeEncodes !== 'function') continue;
        for (const entry of benchService.activeEncodes()) encodes.push({ ...entry, benchmark: true });
      }
      return encodes;
    },
    start() {
      if (shutdownPromise) return Promise.reject(runtimeError('SERVICE_SHUTDOWN'));
      if (!startPromise) {
        const attempt = (async () => {
          const manifests = await store.list();
          if (options.sweepLeftoversOnStart !== false) await sweepUnreferencedSnapshotFolders(manifests);
          const recovered = [];
          for (const manifest of manifests) {
            if (shutdownPromise) throw runtimeError('SERVICE_SHUTDOWN');
            if (!ACTIVE_RECOVERY_STATES.has(manifest.state)) continue;
            recovered.push(await service.recover(manifest.id, inspectRecovery, { deferExecution: true }));
          }
          if (shutdownPromise) throw runtimeError('SERVICE_SHUTDOWN');
          // Load automatic-conversion settings and its file index before any
          // recovered automatic job resumes discovering files.
          if (options.autoConvert !== false) await auto.start().catch(() => undefined);
          void sweepEmptySnapshotFolders();
          if (options.sweepLeftoversOnStart !== false) {
            void sweepLeftoverSnapshotFolders(manifests);
            void sweepLeftoverEncodes(manifests);
          }
          // No queue or reconnect starts until every manifest safely reconciles.
          // Serial execution preserves the singleton worker across saved jobs.
          recoveryPromise = (async () => {
            for (const manifest of recovered) {
              if (shutdownPromise) break;
              await service.continueRecovery(manifest.id);
            }
          })();
          recoveryPromise.catch(error => {
            try { options.onError?.(error); } catch (_) { /* reporting is best effort */ }
          });
          return recovered;
        })();
        const tracked = attempt.catch((error) => {
          if (startPromise === tracked) startPromise = null;
          throw shutdownPromise ? runtimeError('SERVICE_SHUTDOWN') : error;
        });
        startPromise = tracked;
      }
      return startPromise;
    },
    sweepLeftoverSnapshotFolders: () => sweepLeftoverSnapshotFolders(),
    auto: Object.freeze({
      get: () => auto.getState(),
      configure: (settings) => auto.configure(settings),
      checkNow: () => auto.checkNow(),
      setConcurrency: (value) => auto.setConcurrency(value),
      setLanes: (lanes) => auto.setLanes(lanes),
      ownerResumed: (jobId) => auto.ownerResumed(jobId),
      subscribe: (listener) => { autoListeners.add(listener); return () => autoListeners.delete(listener); }
    }),
    shutdown() {
      auto.stop();
      if (!shutdownPromise) shutdownPromise = (async () => {
        const results = await Promise.allSettled([Promise.resolve().then(() => service.shutdown()), recoveryPromise]);
        await convertedIndex.close();
        const rejected = results.find(result => result.status === 'rejected');
        if (rejected) throw rejected.reason;
      })();
      return shutdownPromise;
    }
  };
  return Object.freeze(runtime);
}

function createConverterLifecycle({ initialize, app, onError = () => {} } = {}) {
  if (typeof initialize !== 'function' || !app || typeof app.quit !== 'function') {
    throw new TypeError('initialize and app are required');
  }
  let startPromise;
  let runtimeInstance;
  let runtimeAvailable;
  let shutdownPromise;
  let quitReady = false;
  let quitRequested = false;
  const start = () => {
    if (quitRequested) return Promise.reject(runtimeError('SERVICE_SHUTDOWN'));
    if (!startPromise) {
      let available;
      runtimeAvailable = new Promise(resolve => { available = resolve; });
      const retainRuntime = runtime => {
        if (runtimeInstance && runtimeInstance !== runtime) throw runtimeError('RUNTIME_ALREADY_OWNED');
        runtimeInstance = runtime;
        available(runtime);
      };
      const attempt = Promise.resolve().then(() => initialize({
        retainRuntime, runtime: runtimeInstance, isQuitting: () => quitRequested
      })).then((runtime) => {
        retainRuntime(runtime);
        if (quitRequested) throw runtimeError('SERVICE_SHUTDOWN');
        return runtime;
      });
      const tracked = attempt.catch((error) => {
        if (startPromise === tracked) {
          startPromise = null;
        }
        available(runtimeInstance);
        throw error;
      });
      startPromise = tracked;
    }
    return startPromise;
  };
  const beforeQuit = (event) => {
    if (quitReady) return Promise.resolve();
    if (!startPromise && !runtimeInstance) {
      quitReady = true;
      quitRequested = true;
      return Promise.resolve();
    }
    event?.preventDefault?.();
    if (!shutdownPromise) {
      quitRequested = true;
      const shutdown = runtimeInstance
        ? Promise.resolve(runtimeInstance.shutdown?.())
        : runtimeAvailable.then((runtime) => runtime?.shutdown?.());
      shutdownPromise = shutdown
        .catch((error) => { onError(error); })
        .finally(() => {
          quitReady = true;
          app.quit();
        });
    }
    return shutdownPromise;
  };
  return Object.freeze({ start, beforeQuit, get runtimePromise() { return startPromise; }, get isQuitting() { return quitRequested; } });
}

async function startConverterBeforeWindow({ lifecycle, createWindow } = {}) {
  if (!lifecycle || typeof lifecycle.start !== 'function' || typeof createWindow !== 'function') {
    throw new TypeError('lifecycle and createWindow are required');
  }
  const runtime = await lifecycle.start();
  createWindow();
  return runtime;
}

async function startConverterWithRecoveryPrompt({
  lifecycle,
  createWindow,
  dialog,
  app,
  scheduleRetry = () => new Promise((resolve) => setTimeout(resolve, 250)),
  onError = () => {}
} = {}) {
  if (!dialog || typeof dialog.showMessageBox !== 'function' || !app || typeof app.quit !== 'function'
      || typeof scheduleRetry !== 'function' || typeof onError !== 'function') {
    throw new TypeError('dialog, app, scheduleRetry, and onError are required');
  }
  let recoverySucceeded = false;
  while (true) {
    try {
      return await startConverterBeforeWindow({
        lifecycle,
        createWindow: () => {
          recoverySucceeded = true;
          return createWindow();
        }
      });
    } catch (error) {
      if (lifecycle.isQuitting) return null;
      if (recoverySucceeded) throw error;
      try { onError(error); } catch (_error) { /* reporting must not bypass the recovery gate */ }
      let response;
      try {
        response = await dialog.showMessageBox({
          type: 'error',
          title: 'Converter recovery failed',
          message: 'Studio could not safely recover unfinished converter jobs.',
          detail: 'Retry recovery or quit Studio. No converter window or IPC will open until recovery succeeds.',
          buttons: ['Retry', 'Quit'],
          defaultId: 0,
          cancelId: 1,
          noLink: true
        });
      } catch (dialogError) {
        try { onError(dialogError); } catch (_error) { /* best-effort reporting */ }
        app.quit();
        return null;
      }
      if (response?.response !== 0) {
        app.quit();
        return null;
      }
      try {
        await scheduleRetry();
      } catch (scheduleError) {
        try { onError(scheduleError); } catch (_error) { /* best-effort reporting */ }
        app.quit();
        return null;
      }
    }
  }
}

module.exports = {
  createBoundedProcessRunner,
  createConverterLifecycle,
  createConverterRuntime,
  ensureContainedDestinationParent,
  createRecoveryInspector,
  createVolumeInfo,
  createVerificationSnapshotRegistry,
  parseVideoProbe,
  startConverterBeforeWindow,
  startConverterWithRecoveryPrompt
};
