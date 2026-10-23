'use strict';

// Kills the converter for real (SIGKILL, like docker kill or a power cut) at a
// named point of a conversion, for the crash-recovery tests
// (test/converterCrash*.test.js). Run as a script (env BASE, POINT, MODE,
// NETMODE, CONCURRENCY) it starts a job in BASE and dies at POINT; the test
// then starts the converter again on the same folders and checks the result.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');


const REPO = path.join(__dirname, '..', '..');
const { createConverterRuntime } = require(path.join(REPO, 'src/main/converter/runtime'));
const { createJobStore } = require(path.join(REPO, 'src/main/converter/jobStore'));
const { createPosixOwnedFs, createNoReplaceRename } = require(path.join(REPO, 'server/posixOwnedFs'));
const { RETRYABLE } = require(path.join(REPO, 'server/converterHost'));

const HELPER = path.join(REPO, 'build', 'noreplace-rename');
const EVENT = path.join('TeslaCam', 'SentryClips', '2026-10-20_07-44-14');
const clipName = (index) => `2026-10-20_07-${String(40 + index).padStart(2, '0')}-00-front.mp4`;

const available = () => spawnSync('ffmpeg', ['-version']).status === 0 && fs.existsSync(HELPER);

// One Tesla-like H.264 clip, made once per test process and copied (each copy
// is a file of its own: its own inode, like the car's clips).
let template = null;
async function clipTemplate() {
  if (template && fs.existsSync(template)) return template;
  const { createTeslaH264Fixture } = require('./ffmpegFixtures');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-crash-clip-'));
  template = path.join(folder, 'clip.mp4');
  await createTeslaH264Fixture({
    ffmpegPath: 'ffmpeg', outputPath: template, durationSeconds: 2, frameRate: 12, size: '320x240', spatialNoise: 4,
    telemetryPattern: Array.from({ length: 24 }, (_, n) => Buffer.from([0x20, n]))
  });
  process.once('exit', () => fs.rmSync(folder, { recursive: true, force: true }));
  return template;
}

async function makeBase(clips = 1) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-crash-'));
  const folder = path.join(base, 'footage', EVENT);
  fs.mkdirSync(folder, { recursive: true });
  const source = await clipTemplate();
  for (let index = 0; index < clips; index += 1) fs.copyFileSync(source, path.join(folder, clipName(index)));
  for (const name of ['data', 'temp', 'out']) fs.mkdirSync(path.join(base, name));
  return { base, folder };
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const codecOf = (file) => String(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file]).stdout).trim();

// The whole process group, ffmpeg included, as docker kill stops a container.
function die() {
  try { process.kill(-process.pid, 'SIGKILL'); } catch (_) { /* not a group leader */ }
  process.kill(process.pid, 'SIGKILL');
}

// The kill points. Each names where the conversion is when the converter dies.
//  fsOpen(file, flags, handle): a file the converter opens (the telemetry
//    writer, copies to the share, the staged copy)
//  beforeWrite / afterWrite(manifest or patch): around a job-file write
//  onPromote / afterPromote(request): around a no-replace move
//  onRename(from, to): the native helper's moves (quarantine before a removal)
//  ffmpeg: a wrapper that kills the converter when the encode starts
const isTemp = (file) => /^TEMP-H265-/.test(path.basename(file));
const isPartial = (file) => /\.partial$/.test(file);
const isStaged = (file) => /-source\.mp4$/.test(file);
const itemsOf = (value) => Array.isArray(value?.items) ? value.items : [];
const anyItem = (value, predicate) => itemsOf(value).some(predicate);

function halfWrite(handle) {
  const write = handle.write.bind(handle);
  handle.write = async (buffer, offset, length, position) => {
    if (typeof length === 'number' && length > 1) await write(buffer, offset, Math.floor(length / 2), position);
    die();
  };
  return handle;
}

const POINTS = {
  // several clips encoding at once, then fewer at once (one), then the stop
  lowered: { hold: true },
  // before the save slot
  'staging-copy': { fsOpen: (file, flags, handle) => (flags === 'wx' && isStaged(file) ? halfWrite(handle) : handle) },
  encode: { ffmpeg: true },
  writer: {
    fsOpen: (file, flags, handle) => {
      if (flags !== 'r+' || !/-encoded\.mp4$/.test(file)) return handle;
      const truncate = handle.truncate.bind(handle);
      handle.truncate = async (size) => { await truncate(size); die(); };
      return handle;
    }
  },
  verify: { ffprobeKill: /sentry-six-verification-/ },
  'temp-created': { fsOpen: (file, flags, handle) => { if (flags === 'wx' && (isTemp(file) || isPartial(file))) die(); return handle; } },
  'temp-torn': { fsOpen: (file, flags, handle) => (flags === 'wx' && (isTemp(file) || isPartial(file)) ? halfWrite(handle) : handle) },
  'temp-complete': {
    fsOpen: (file, flags, handle) => {
      if (flags !== 'wx' || !(isTemp(file) || isPartial(file))) return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); die(); };
      return handle;
    }
  },
  // the clip's copy beside its original (or destination) is recorded as
  // complete: the clip waits for (or is about to take) the save slot
  'copy-recorded': {
    afterWrite: (manifest) => anyItem(manifest, (item) => ['owned', 'cleanup-pending'].includes(item.ownedArtifacts?.replacementCandidate?.state
      || item.ownedArtifacts?.destinationPartial?.state) && !item.replacementPhase && manifest.state !== 'copying')
  },
  // in the save slot
  'slot-entered': { afterWrite: (manifest) => manifest.replacementPhase === 'candidate-written' || manifest.state === 'copying' },
  'backup-renamed': { afterPromote: (request) => /^BACKUP-/.test(path.basename(request.to)) },
  'backup-recorded': { afterWrite: (manifest) => manifest.replacementPhase === 'original-backed-up' },
  'before-final': { onPromote: (request) => !/^BACKUP-/.test(path.basename(request.to)) && /front\.mp4$/.test(request.to) },
  'after-final': { afterPromote: (request) => !/^BACKUP-/.test(path.basename(request.to)) && /front\.mp4$/.test(request.to) },
  'final-recorded': { afterWrite: (manifest) => manifest.replacementPhase === 'candidate-promoted' },
  quarantined: { onRename: (from, to) => /^\.sentry-owned-remove-/.test(path.basename(to)) && /^BACKUP-/.test(path.basename(from)) },
  // the backup is gone; the clip's result is about to be written
  'before-result': {
    beforeWrite: (patch, current) => anyItem(patch, (item) => item.state === 'completed'
      && !current.items.find((entry) => entry.id === item.id && entry.state === 'completed'))
  },
  'after-result': {
    afterWrite: (manifest, previous) => anyItem(manifest, (item) => item.state === 'completed'
      && !previous?.items.find((entry) => entry.id === item.id && entry.state === 'completed'))
  }
};

function proxiedFs(point) {
  if (!point.fsOpen) return fs;
  const promises = Object.create(fs.promises);
  promises.open = async (file, flags, mode) => point.fsOpen(String(file), flags, await fs.promises.open(file, flags, mode));
  const wrapped = Object.create(fs);
  Object.defineProperty(wrapped, 'promises', { value: promises });
  return wrapped;
}

function toolWrapper(base, name, body) {
  const script = path.join(base, `${name}-crash.sh`);
  fs.writeFileSync(script, `#!/bin/sh\n${body}\nexec ${name} "$@"\n`, { mode: 0o755 });
  return script;
}

// The runtime as server/converterHost.js composes it, with the kill point's hooks.
async function open(base, { point = null, concurrency = 1, mode = 'replace', networkMode = 'direct', factories } = {}) {
  process.env.SENTRY_NOREPLACE_RENAME = HELPER;
  const hooks = point ? POINTS[point] : {};
  if (point && !hooks) throw new Error(`unknown kill point ${point}`);
  const realRename = createNoReplaceRename();
  const owned = createPosixOwnedFs({ noReplace: {
    available: realRename.available,
    rename: async (from, to) => {
      await realRename.rename(from, to);
      if (hooks.onRename?.(from, to)) die();
    }
  } });
  const renameExclusive = Object.assign({}, owned.renameExclusive, {
    promote: async (request) => {
      if (hooks.onPromote?.(request)) die();
      const out = await owned.renameExclusive.promote(request);
      if (hooks.afterPromote?.(request)) die();
      return out;
    }
  });
  const network = {
    isRetryable: (error) => RETRYABLE.has(error?.code),
    checkPath: async (target) => fs.promises.access(target).then(() => true, () => false)
  };
  if (hooks.ffmpeg || hooks.ffprobeKill || hooks.hold) process.on('SIGUSR2', die);
  const ffmpegPath = hooks.ffmpeg
    ? toolWrapper(base, 'ffmpeg', 'case "$*" in *-progress*) kill -USR2 $PPID; exit 1;; esac')
    : hooks.hold
      ? toolWrapper(base, 'ffmpeg', `case "$*" in *-progress*) while [ ! -f "${base}/release" ]; do kill -0 $PPID 2>/dev/null || exit 1; sleep 0.05; done;; esac`)
      : 'ffmpeg';
  const ffprobePath = hooks.ffprobeKill
    ? toolWrapper(base, 'ffprobe', 'case "$*" in *sentry-six-verification-*) kill -USR2 $PPID; exit 1;; esac') : 'ffprobe';
  const storeFactory = (options) => {
    const store = (factories?.createJobStore || createJobStore)(options);
    if (!hooks.beforeWrite && !hooks.afterWrite) return store;
    let last = null;
    return Object.freeze({
      ...store,
      transition: async (id, patch) => {
        if (hooks.beforeWrite && last && hooks.beforeWrite(patch, last)) die();
        const next = await store.transition(id, patch);
        if (hooks.afterWrite?.(next, last)) die();
        last = next;
        return next;
      },
      recover: async (...args) => {
        const next = await store.recover(...args);
        last = next;
        return next;
      }
    });
  };
  const runtime = await createConverterRuntime({
    userDataPath: fs.realpathSync(path.join(base, 'data')),
    tempPath: fs.realpathSync(path.join(base, 'temp')),
    ffmpegPath, ffprobePath, spawn, fs: proxiedFs(hooks), pathApi: path, platform: process.platform,
    removeOwned: owned.removeOwned, renameExclusive, network, autoConvert: false, gpuDecode: false,
    privateTempIdentityCleanup: true,
    networkBackoff: { initialMs: 50, maximumMs: 200 },
    factories: { ...(factories || {}), createJobStore: storeFactory }
  });
  const config = {
    sourceRoot: fs.realpathSync(path.join(base, 'footage', 'TeslaCam')),
    destinationRoot: mode === 'replace' ? null : fs.realpathSync(path.join(base, 'out')),
    codec: 'h265', profileId: 'custom', bitrateKbps: 250, networkMode, outputMode: mode,
    includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'], groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'],
    replacementConfirmed: mode === 'replace', concurrency, verifyMode: 'quick'
  };
  return { runtime, config };
}

// Runs a job in a child process (a process group of its own) that dies at the
// kill point; resolves once it died.
function crash(base, { point, concurrency = 1, mode = 'replace', networkMode = 'direct', timeout = 120_000 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename], {
      env: { ...process.env, BASE: base, POINT: point, CONCURRENCY: String(concurrency), MODE: mode, NETMODE: networkMode },
      detached: true, stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* gone */ } }, timeout);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

// Everything the converter may leave behind that it should not.
function leftovers(base, folder) {
  const found = [];
  for (const name of fs.readdirSync(folder)) {
    if (/^(TEMP-|BACKUP-|\.sentry-owned-remove-)/.test(name) || name.endsWith('.partial')) found.push(name);
  }
  const out = path.join(base, 'out');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.partial') || entry.name.startsWith('.sentry-owned-remove-')) found.push(path.relative(base, file));
    }
  };
  if (fs.existsSync(out)) walk(out);
  const temp = path.join(base, 'temp');
  for (const name of fs.readdirSync(temp)) {
    if (name === 'sentry-six-converter') {
      for (const inner of fs.readdirSync(path.join(temp, name))) found.push(`temp/${name}/${inner}`);
    } else if (name.startsWith('sentry-six-verification-')) found.push(`temp/${name}`);
  }
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Dies at the point, starts again on the same folders, waits for the job.
// Returns what a test checks: the job, each clip's codec (and whether a
// separate run kept the original), and anything left behind.
async function crashAndRecover({ point, mode = 'replace', networkMode = 'direct', concurrency = 1, clips = concurrency, beforeStart }) {
  const { base, folder } = await makeBase(clips);
  const names = fs.readdirSync(folder).sort();
  const before = Object.fromEntries(names.map((name) => [name, sha256(path.join(folder, name))]));
  const died = await crash(base, { point, concurrency, mode, networkMode });
  let env;
  try {
    env = await open(base, { concurrency, mode, networkMode });
    if (beforeStart) await beforeStart(env);
    await env.runtime.start();
    const [listed] = await env.runtime.service.list();
    await Promise.race([env.runtime.service.whenIdle(listed.id), sleep(90_000)]);
    const job = await env.runtime.service.get(listed.id);
    const clipsAfter = names.map((name) => {
      const output = mode === 'replace' ? path.join(folder, name) : path.join(base, 'out', 'SentryClips', path.basename(path.dirname(path.join(folder, name))), name);
      return {
        name,
        codec: fs.existsSync(output) ? codecOf(output) : null,
        originalKept: fs.existsSync(path.join(folder, name)) && sha256(path.join(folder, name)) === before[name]
      };
    });
    return { died, job, clips: clipsAfter, leftovers: leftovers(base, folder), names: fs.readdirSync(folder).sort(), expectedNames: names };
  } finally {
    await env?.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function assertRecovered(result, { mode = 'replace' } = {}) {
  assert.equal(result.died.signal, 'SIGKILL', `the converter died at the point (${result.died.stderr.slice(0, 300)})`);
  assert.equal(result.job.state, 'completed', `finished by itself: ${JSON.stringify(result.job.recovery || null)}`);
  assert.equal(result.job.recovery ?? null, null);
  for (const item of result.job.items) {
    assert.equal(item.state, 'completed', `${item.relativePath}: ${item.state} ${item.resultCode || ''}`);
    assert.equal(item.resultCode, 'converted');
  }
  for (const clip of result.clips) {
    assert.equal(clip.codec, 'hevc', `${clip.name} holds its conversion`);
    if (mode === 'separate') assert.ok(clip.originalKept, `${clip.name}: the original is untouched`);
  }
  assert.deepEqual(result.names, result.expectedNames, 'only the clips are in the folder');
  assert.deepEqual(result.leftovers, [], 'nothing left behind');
}

module.exports = { POINTS, open, crash, crashAndRecover, assertRecovered, makeBase, leftovers, available, clipName, sha256, codecOf, HELPER, EVENT };

if (require.main === module) {
  (async () => {
    const env = await open(process.env.BASE, {
      point: process.env.POINT,
      concurrency: Number(process.env.CONCURRENCY || 1),
      mode: process.env.MODE || 'replace',
      networkMode: process.env.NETMODE || 'direct'
    });
    await env.runtime.start();
    const id = await env.runtime.service.start(env.config);
    if (process.env.POINT === 'lowered') {
      while (env.runtime.activeEncodes().length < env.config.concurrency) await new Promise((r) => setTimeout(r, 20));
      await env.runtime.service.setConcurrency(id, 1);
      die();
    }
    // A point the run never reached: report it (the test fails on a clean exit).
    await env.runtime.service.whenIdle(id);
    process.stderr.write('kill point not reached\n');
    process.exit(3);
  })().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(2);
  });
}
