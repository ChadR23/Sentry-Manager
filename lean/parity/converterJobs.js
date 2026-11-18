'use strict';

// Conversion jobs run by the Node converter (src/main/converter/runtime.js,
// composed as server/converterHost.js and test/fixtures/crashPoints.js do),
// for the Rust job service's parity test (lean/src/converter/service/tests.rs):
//
//   node lean/parity/converterJobs.js clip <file>
//       one Tesla-like H.264 clip with telemetry (2 s, 12 fps, 320x240)
//   node lean/parity/converterJobs.js run <base> <replace|separate> <direct|staging> <noreplace helper>
//       converts <base>/footage/TeslaCam into <base>/out (separate) or in place,
//       data in <base>/data, temp in <base>/temp; prints the job and its events
//   node lean/parity/converterJobs.js resume <base> <helper>
//       starts the converter on <base> again (recovery) and waits for the job

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');

async function clip(file) {
  const { createTeslaH264Fixture } = require(path.join(REPO, 'test/fixtures/ffmpegFixtures'));
  await createTeslaH264Fixture({
    ffmpegPath: 'ffmpeg', outputPath: file, durationSeconds: 2, frameRate: 12, size: '320x240', spatialNoise: 4,
    telemetryPattern: Array.from({ length: 24 }, (_, n) => Buffer.from([0x20, n]))
  });
  return { file };
}

async function open(base, helper) {
  process.env.SENTRY_NOREPLACE_RENAME = helper;
  const { createConverterRuntime } = require(path.join(REPO, 'src/main/converter/runtime'));
  const { createPosixOwnedFs } = require(path.join(REPO, 'server/posixOwnedFs'));
  const { RETRYABLE } = require(path.join(REPO, 'server/converterHost'));
  const owned = createPosixOwnedFs();
  return createConverterRuntime({
    userDataPath: fs.realpathSync(path.join(base, 'data')),
    tempPath: fs.realpathSync(path.join(base, 'temp')),
    ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', spawn, fs, pathApi: path, platform: process.platform,
    removeOwned: owned.removeOwned, renameExclusive: owned.renameExclusive,
    network: { isRetryable: (error) => RETRYABLE.has(error?.code), checkPath: async (target) => fs.promises.access(target).then(() => true, () => false) },
    autoConvert: false, gpuDecode: false, privateTempIdentityCleanup: true,
    networkBackoff: { initialMs: 50, maximumMs: 200 }
  });
}

async function run(base, mode, networkMode, helper) {
  const runtime = await open(base, helper);
  const events = [];
  runtime.service.subscribe((event) => events.push(event));
  await runtime.start();
  const config = {
    sourceRoot: fs.realpathSync(path.join(base, 'footage', 'TeslaCam')),
    destinationRoot: mode === 'replace' ? null : fs.realpathSync(path.join(base, 'out')),
    codec: 'h265', profileId: 'custom', bitrateKbps: 250, networkMode, outputMode: mode,
    includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'], groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'],
    replacementConfirmed: mode === 'replace', concurrency: 1, verifyMode: 'quick',
    // (libx265, as on the Rust side: a hardware encoder's output differs from run to run)
    lanes: [{ device: 'cpu', concurrency: 1 }]
  };
  const id = await runtime.service.start(config);
  const job = await runtime.service.whenIdle(id);
  await runtime.shutdown();
  return { job, events: events.map((event) => event.type) };
}

async function resume(base, helper) {
  const runtime = await open(base, helper);
  await runtime.start();
  const [listed] = await runtime.service.list();
  const job = await Promise.race([runtime.service.whenIdle(listed.id), new Promise((r) => setTimeout(r, 90_000))]);
  await runtime.shutdown();
  return { job: job || await runtime.service.get(listed.id) };
}

(async () => {
  const [mode, ...args] = process.argv.slice(2);
  let result;
  if (mode === 'clip') result = await clip(args[0]);
  else if (mode === 'run') result = await run(args[0], args[1], args[2], args[3]);
  else if (mode === 'resume') result = await resume(args[0], args[1]);
  else throw new Error(`unknown mode ${mode}`);
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
})().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(2);
});
