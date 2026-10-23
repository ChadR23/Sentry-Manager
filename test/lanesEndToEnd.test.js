'use strict';

// Several GPUs from the Encoder page to ffmpeg and back, through the web
// bridge, the IPC handlers, the real runtime and job service: the device
// list with two (pretend) GPUs, a start with a lane per GPU, the encodes on
// each GPU's own device, a lane set to 0 mid-run whose clips finish first,
// and a benchmark that tests each GPU alone with results of its own.
//
// ffmpeg is a wrapper that writes down how it was called, holds encodes
// while a "hold" file exists, refuses every hardware AV1 encoder (neither
// pretend GPU can do AV1) and then converts on the CPU: GPU encoders become
// libx265 and the device arguments are left out.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ARC = Object.freeze({ id: 'pci:0000:03:00.0', kind: 'dri', vendor: 'intel', name: 'Intel Arc A380', node: '/dev/dri/renderD129', index: null, pci: '0000:03:00.0' });
const T400 = Object.freeze({ id: 'pci:0000:01:00.0', kind: 'nvidia', vendor: 'nvidia', name: 'NVIDIA T400', node: null, index: 0, pci: '0000:01:00.0' });
const CPU = Object.freeze({ id: 'cpu', kind: 'cpu', vendor: null, name: 'CPU (software encoder)', node: null, index: null, pci: null });

const HELPER = path.join(__dirname, '..', 'build', 'noreplace-rename');
const canConvert = spawnSync('ffmpeg', ['-version']).status === 0 && fs.existsSync(HELPER);
const CLIPS = 8;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The promise's answer, or undefined after ms (the timer never outlives it).
async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(fn, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(20);
  }
  return false;
}

function fakeFfmpeg(dir) {
  const log = path.join(dir, 'ffmpeg-calls.jsonl');
  const hold = path.join(dir, 'hold');
  const script = path.join(dir, 'ffmpeg-gpu.js');
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require('fs');
const { spawn } = require('child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const encoder = args[args.indexOf('-c:v') + 1] || '';
if (/^av1_(qsv|vaapi|nvenc)$/.test(encoder)) {
  process.stderr.write('No AV1 on this GPU\\n');
  process.exit(1);
}
const out = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (['-init_hw_device', '-hwaccel', '-hwaccel_device', '-hwaccel_output_format', '-vaapi_device', '-gpu'].includes(a)) { i += 1; continue; }
  if (a === '-vf' && args[i + 1] === 'format=nv12,hwupload') { i += 1; continue; }
  if (a === '-c:v' && /^hevc_(qsv|vaapi|nvenc)$/.test(args[i + 1] || '')) { out.push('-c:v', 'libx265'); i += 1; continue; }
  if (a === '-pix_fmt' && args[i + 1] === 'nv12') { out.push('-pix_fmt', 'yuv420p'); i += 1; continue; }
  out.push(a);
}
let child = null;
process.on('SIGTERM', () => { if (child) child.kill('SIGTERM'); else process.exit(1); });
const run = () => {
  child = spawn('ffmpeg', out, { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
};
// an encode (it reports progress on pipe:1) waits while the test holds it
if (args.includes('pipe:1') && fs.existsSync(${JSON.stringify(hold)})) {
  const wait = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(hold)})) return;
    clearInterval(wait);
    run();
  }, 20);
} else run();
`, { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return {
    script,
    calls,
    encodes: () => calls().filter(isEncode),
    hold: () => fs.writeFileSync(hold, ''),
    release: () => fs.rmSync(hold, { force: true })
  };
}

// A clip's encode reports progress on pipe:1; so does Full verification's
// decode, which has no -c:v.
const isEncode = (args) => args.includes('pipe:1') && args.includes('-c:v');

const flagValue = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);

// The GPU an encode's arguments put it on, as the Hardware panel names it.
function gpuOf(args) {
  if (flagValue(args, '-gpu') !== null) return `nvidia${flagValue(args, '-gpu')}`;
  const qsv = /child_device=([^,]+)/.exec(flagValue(args, '-init_hw_device') || '');
  if (qsv) return qsv[1];
  return flagValue(args, '-vaapi_device');
}

// The GPU an encode or a decode runs on (a decode names it with -hwaccel_device).
function placeOf(args) {
  const gpu = gpuOf(args);
  if (gpu) return gpu;
  const decoder = flagValue(args, '-hwaccel_device');
  if (decoder === null) return null;
  return decoder.startsWith('/dev/') ? decoder : `nvidia${decoder}`;
}

// The converter's server-sent events for one browser, as the bridge writes them.
function eventStream(bridge, clientId) {
  const events = [];
  const closers = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    write(chunk) {
      const match = /^event: (.+)\ndata: (.+)\n\n$/s.exec(String(chunk));
      if (match) events.push({ channel: match[1], payload: JSON.parse(match[2]) });
      return true;
    },
    on(event, fn) { if (event === 'close') closers.push(fn); }
  };
  bridge.attachEvents(clientId, res);
  return {
    events,
    close() {
      res.writableEnded = true;
      for (const fn of closers.splice(0)) fn();
    }
  };
}

async function makeFootage(dir) {
  const { createTeslaH264Fixture } = require('./fixtures/ffmpegFixtures');
  const recent = path.join(dir, 'footage', 'TeslaCam', 'RecentClips');
  fs.mkdirSync(recent, { recursive: true });
  const first = path.join(recent, '2026-10-20_07-40-00-front.mp4');
  await createTeslaH264Fixture({
    ffmpegPath: 'ffmpeg', outputPath: first, durationSeconds: 1, frameRate: 12, size: '160x120', spatialNoise: 4,
    telemetryPattern: Array.from({ length: 12 }, (_, n) => Buffer.from([0x20, n]))
  });
  for (let i = 1; i < CLIPS; i += 1) fs.copyFileSync(first, path.join(recent, `2026-10-20_07-4${i}-00-front.mp4`));
  return fs.realpathSync(path.join(dir, 'footage', 'TeslaCam'));
}

test('two GPUs end to end: devices, a lane each, live lanes, a benchmark per GPU', { skip: !canConvert && 'needs ffmpeg and build/noreplace-rename', timeout: 300_000 }, async () => {
  const { createConverterRuntime } = require('../src/main/converter/runtime');
  const { createConverterBridge } = require('../server/converterBridge');
  const { createPosixOwnedFs } = require('../server/posixOwnedFs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lanes-e2e2-'));
  const previousHelper = process.env.SENTRY_NOREPLACE_RENAME;
  let runtime;
  let stream;
  try {
    const sourceRoot = await makeFootage(dir);
    for (const name of ['data', 'temp', 'out']) fs.mkdirSync(path.join(dir, name));
    const destinationRoot = fs.realpathSync(path.join(dir, 'out'));
    const ffmpeg = fakeFfmpeg(dir);
    process.env.SENTRY_NOREPLACE_RENAME = HELPER;
    const owned = createPosixOwnedFs();
    runtime = await createConverterRuntime({
      userDataPath: fs.realpathSync(path.join(dir, 'data')), tempPath: fs.realpathSync(path.join(dir, 'temp')),
      ffmpegPath: ffmpeg.script, ffprobePath: 'ffprobe', spawn, fs, pathApi: path, platform: 'linux',
      removeOwned: owned.removeOwned, renameExclusive: owned.renameExclusive, autoConvert: false,
      factories: { createDeviceDiscovery: () => ({ list: async () => [ARC, T400, CPU] }) }
    });
    await runtime.start();
    const bridge = createConverterBridge({
      runtime,
      resolvePath: async (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } }
    });
    stream = eventStream(bridge, 'browser-1');

    // ---- the Encoder page asks for the devices
    const listed = await bridge.invoke('devices', undefined, 'browser-1');
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.deepEqual(listed.value.devices.map((d) => [d.id, d.kind, d.name, d.encoders]), [
      [ARC.id, 'dri', ARC.name, { h265: 'hevc_qsv', av1: null }],
      [T400.id, 'nvidia', T400.name, { h265: 'hevc_nvenc', av1: null }],
      ['cpu', 'cpu', CPU.name, { h265: 'libx265', av1: 'libsvtav1' }]
    ]);
    assert.equal(listed.value.defaultDevice, T400.id, 'NVENC without a device is NVIDIA index 0');
    const probes = ffmpeg.calls().filter((args) => args.includes('testsrc2=duration=0.5:size=640x360:rate=8'));
    assert.ok(probes.some((args) => args.includes(`qsv=qsvenc:hw_any,child_device=${ARC.node}`)), 'the Arc proved with its own node');
    assert.ok(probes.some((args) => args.includes('hevc_nvenc') && args[args.indexOf('-gpu') + 1] === '0'), 'the T400 proved with its index');

    const config = (over = {}) => ({
      sourceRoot, destinationRoot, codec: 'h265', profileId: 'custom', bitrateKbps: 250, networkMode: 'direct',
      outputMode: 'separate', includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'],
      groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'], replacementConfirmed: false, concurrency: 5, verifyMode: 'quick', ...over
    });

    // a GPU set on a codec it cannot encode: refused, the GPU named for the page
    const refused = await bridge.invoke('start', config({ codec: 'av1', lanes: [{ device: T400.id, concurrency: 1 }, { device: 'cpu', concurrency: 1 }] }), 'browser-1');
    assert.deepEqual(refused, { ok: false, error: { code: 'DEVICE_UNSUPPORTED', retryable: false, details: { device: T400.name, codec: 'av1' } } });
    assert.equal(ffmpeg.encodes().length, 0, 'nothing was converted');

    // ---- start with two on the Arc and one on the T400 (CPU off)
    ffmpeg.hold();
    const started = await bridge.invoke('start', config({ lanes: [{ device: ARC.id, concurrency: 2 }, { device: T400.id, concurrency: 1 }, { device: 'cpu', concurrency: 0 }] }), 'browser-1');
    assert.equal(started.ok, true, JSON.stringify(started));
    const jobId = started.value.jobId;
    const job = await runtime.service.get(jobId);
    assert.deepEqual(job.config.lanes, [{ device: ARC.id, concurrency: 2 }, { device: T400.id, concurrency: 1 }], 'the CPU row at 0 is left out');
    assert.equal(job.config.concurrency, 3, 'the total');

    const perDevice = () => {
      const counts = {};
      for (const live of runtime.activeEncodes()) counts[live.deviceId ?? 'default'] = (counts[live.deviceId ?? 'default'] || 0) + 1;
      return counts;
    };
    assert.ok(await until(() => ffmpeg.encodes().length === 3 && runtime.activeEncodes().length === 3), 'three held encodes');
    await sleep(100);
    assert.equal(ffmpeg.encodes().length, 3, 'and no more');
    assert.deepEqual(perDevice(), { [ARC.id]: 2, [T400.id]: 1 });
    for (const live of runtime.activeEncodes()) {
      if (live.deviceId === ARC.id) assert.deepEqual([live.encoder, live.hardware, live.device], ['hevc_qsv', true, ARC.node]);
      else assert.deepEqual([live.encoder, live.hardware, live.device], ['hevc_nvenc', true, 'nvidia0']);
    }
    // the arguments ffmpeg got: each GPU's own device, decoded on the same GPU
    const held = ffmpeg.encodes();
    const onArc = held.filter((args) => gpuOf(args) === ARC.node);
    const onT400 = held.filter((args) => gpuOf(args) === 'nvidia0');
    assert.equal(onArc.length, 2);
    assert.equal(onT400.length, 1);
    for (const args of onArc) {
      assert.deepEqual(args.slice(args.indexOf('-init_hw_device'), args.indexOf('-c:v') + 2),
        ['-init_hw_device', `qsv=qsvenc:hw_any,child_device=${ARC.node}`, '-c:v', 'hevc_qsv']);
      assert.deepEqual(args.slice(args.indexOf('-hwaccel'), args.indexOf('-hwaccel') + 4), ['-hwaccel', 'vaapi', '-hwaccel_device', ARC.node]);
      assert.equal(args.includes('-gpu'), false);
    }
    const nv = onT400[0];
    assert.deepEqual(nv.slice(nv.indexOf('-c:v'), nv.indexOf('-c:v') + 4), ['-c:v', 'hevc_nvenc', '-gpu', '0']);
    assert.equal(nv[nv.indexOf('-hwaccel') + 1], 'cuda');
    assert.equal(nv[nv.indexOf('-hwaccel_device') + 1], '0', 'NVDEC on the same GPU');
    assert.equal(nv.includes('-init_hw_device'), false);

    // ---- the Arc set to Off and the T400 to 2 while the clips are converting
    const lowered = await bridge.invoke('setLanes', { jobId, lanes: [{ device: ARC.id, concurrency: 0 }, { device: T400.id, concurrency: 2 }] }, 'browser-1');
    assert.equal(lowered.ok, true, JSON.stringify(lowered));
    assert.deepEqual(lowered.value.config.lanes, [{ device: T400.id, concurrency: 2 }]);
    assert.equal(lowered.value.config.concurrency, 2);
    assert.ok(await until(() => runtime.activeEncodes().length === 4 && ffmpeg.encodes().length === 4), 'one more on the T400 at once');
    assert.deepEqual(perDevice(), { [ARC.id]: 2, [T400.id]: 2 }, 'the Arc\'s clips are not stopped');
    assert.equal(ffmpeg.encodes().filter((args) => gpuOf(args) === 'nvidia0').length, 2);

    ffmpeg.release();
    assert.ok(await until(() => !perDevice()[ARC.id], 60_000), 'the Arc\'s clips finish');
    assert.equal(ffmpeg.encodes().filter((args) => gpuOf(args) === ARC.node).length, 2, 'and its workers retire');
    await within(runtime.service.whenIdle(jobId), 120_000);
    const done = await runtime.service.get(jobId);
    assert.equal(done.state, 'completed');
    assert.equal(done.items.filter((item) => item.kind === 'video' && item.resultCode === 'converted').length, CLIPS);
    const encodes = ffmpeg.encodes();
    assert.equal(encodes.filter((args) => gpuOf(args) === ARC.node).length, 2, 'the Arc took no new clip after it was set to Off');
    assert.equal(encodes.filter((args) => gpuOf(args) === 'nvidia0').length, CLIPS - 2, 'the T400 converted the rest');
    assert.equal(done.items.filter((item) => item.encoder === 'hevc_qsv').length, 2, 'the Arc\'s two clips finished, not cancelled');
    assert.equal(done.items.filter((item) => item.encoder === 'hevc_nvenc').length, CLIPS - 2);
    assert.deepEqual(done.config.lanes, [{ device: T400.id, concurrency: 2 }]);

    // ---- the benchmark: every GPU alone, one after another, its own results
    const before = ffmpeg.calls().length;
    const bench = await bridge.invoke('runBenchmark', { codecs: ['h265', 'av1'], sourceRoot, profileId: 'custom', bitrateKbps: 250, verifyMode: 'quick' }, 'browser-1');
    assert.equal(bench.ok, true, JSON.stringify(bench));
    assert.deepEqual(Object.keys(bench.value), ['devices'], 'a result per GPU, nothing shared');
    assert.deepEqual(bench.value.devices.map((entry) => entry.device), [{ id: ARC.id, name: ARC.name }, { id: T400.id, name: T400.name }]);
    for (const [entry, codec] of [[bench.value.devices[0], 'hevc_qsv'], [bench.value.devices[1], 'hevc_nvenc']]) {
      const [h265, av1] = entry.codecs;
      assert.equal(h265.codec, 'h265');
      assert.equal(h265.error, undefined, JSON.stringify(h265));
      assert.deepEqual(h265.encoder, { family: 'h265', codec, hardware: true });
      assert.deepEqual(h265.results.map((r) => r.level), [1, 2, 4, 6, 8]);
      assert.ok(h265.results.every((r) => r.ok), JSON.stringify(h265.results));
      assert.ok(h265.best && Number.isSafeInteger(h265.best.level));
      assert.deepEqual(h265.verifyComparison.map((r) => r.verifyMode), ['quick', 'full'], 'no Off');
      assert.deepEqual([av1.codec, av1.error], ['av1', 'UNSUPPORTED'], 'neither GPU can encode AV1');
    }
    // every encode, and every Full verification's decode, on the GPU under test
    const benchCalls = ffmpeg.calls().slice(before).filter((args) => args.includes('pipe:1'));
    const benchEncodes = benchCalls.filter(isEncode);
    assert.ok(benchCalls.length > benchEncodes.length, 'Full verification decoded the clips');
    const where = benchCalls.map((args) => placeOf(args));
    const firstT400 = where.indexOf('nvidia0');
    assert.ok(firstT400 > 0, where.join(' '));
    assert.ok(where.slice(0, firstT400).every((gpu) => gpu === ARC.node), `the Arc first, on its own: ${where.join(' ')}`);
    assert.ok(where.slice(firstT400).every((gpu) => gpu === 'nvidia0'), `then the T400, on its own: ${where.join(' ')}`);
    assert.deepEqual([...new Set(benchEncodes.map((args) => args[args.indexOf('-c:v') + 1]))], ['hevc_qsv', 'hevc_nvenc'],
      'AV1 was not benchmarked on the CPU instead');
    // progress names the GPU under test
    const progress = stream.events.filter((event) => event.channel === 'converter:benchmarkProgress').map((event) => event.payload);
    assert.equal(progress[0].step, 'scan');
    const runs = progress.filter((step) => step.step === 'run');
    assert.ok(runs.length > 0);
    assert.ok(runs.every((step) => step.deviceTotal === 2 && [1, 2].includes(step.deviceIndex)));
    assert.deepEqual([...new Set(runs.map((step) => `${step.deviceIndex}:${step.device.id}:${step.device.name}`))],
      [`1:${ARC.id}:${ARC.name}`, `2:${T400.id}:${T400.name}`]);
  } finally {
    stream?.close();
    await runtime?.shutdown().catch(() => {});
    if (previousHelper === undefined) delete process.env.SENTRY_NOREPLACE_RENAME;
    else process.env.SENTRY_NOREPLACE_RENAME = previousHelper;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
