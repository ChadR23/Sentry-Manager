'use strict';

// A replacing conversion that dies mid-replacement, for the crash-recovery
// tests (test/converterRecovery.test.js). Run as a script, it starts a job and
// kills its own process just before (KILL=before) or just after (KILL=after)
// the converted file is moved onto the original's name.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const { createConverterRuntime } = require(path.join(REPO, 'src/main/converter/runtime'));
const { createPosixOwnedFs } = require(path.join(REPO, 'server/posixOwnedFs'));
const { RETRYABLE } = require(path.join(REPO, 'server/converterHost'));

const HELPER = path.join(REPO, 'build', 'noreplace-rename');
const CLIP = '2026-10-20_07-43-00-front.mp4';

async function makeBase(base) {
  const { createTeslaH264Fixture } = require('./ffmpegFixtures');
  const event = path.join(base, 'footage', 'TeslaCam', 'SentryClips', '2026-10-20_07-44-14');
  fs.mkdirSync(event, { recursive: true });
  await createTeslaH264Fixture({
    ffmpegPath: 'ffmpeg', outputPath: path.join(event, CLIP), durationSeconds: 2, frameRate: 12, size: '320x240', spatialNoise: 4,
    telemetryPattern: Array.from({ length: 24 }, (_, n) => Buffer.from([0x20, n]))
  });
  for (const d of ['data', 'temp']) fs.mkdirSync(path.join(base, d));
  return event;
}

// The runtime as server/converterHost.js composes it; onPromote / afterPromote
// run around each no-replace move.
async function open(base, { onPromote, afterPromote, ffprobePath = 'ffprobe', ffmpegPath = 'ffmpeg' } = {}) {
  process.env.SENTRY_NOREPLACE_RENAME = HELPER;
  const owned = createPosixOwnedFs();
  const renameExclusive = Object.assign((...args) => owned.renameExclusive(...args), owned.renameExclusive, {
    promote: async (request) => {
      await onPromote?.(request);
      const out = await owned.renameExclusive.promote(request);
      await afterPromote?.(request);
      return out;
    }
  });
  const network = {
    isRetryable: (error) => RETRYABLE.has(error?.code),
    checkPath: async (target) => fs.promises.access(target).then(() => true, () => false)
  };
  const runtime = await createConverterRuntime({
    userDataPath: fs.realpathSync(path.join(base, 'data')),
    tempPath: fs.realpathSync(path.join(base, 'temp')),
    ffmpegPath, ffprobePath, spawn, fs, pathApi: path, platform: process.platform,
    removeOwned: owned.removeOwned, renameExclusive, network, autoConvert: false, gpuDecode: false,
    privateTempIdentityCleanup: true,
    networkBackoff: { initialMs: 50, maximumMs: 200 }
  });
  const config = {
    sourceRoot: fs.realpathSync(path.join(base, 'footage', 'TeslaCam')), destinationRoot: null,
    codec: 'h265', profileId: 'custom', bitrateKbps: 250, networkMode: 'direct', outputMode: 'replace',
    includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'], groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'],
    replacementConfirmed: true, concurrency: 1, verifyMode: 'quick'
  };
  return { runtime, config };
}

module.exports = { makeBase, open, CLIP, HELPER };

if (require.main === module) {
  (async () => {
    const die = (request) => { if (path.basename(request.to) === CLIP) process.kill(process.pid, 'SIGKILL'); };
    const env = await open(process.env.BASE, process.env.KILL === 'after' ? { afterPromote: die } : { onPromote: die });
    await env.runtime.start();
    await env.runtime.service.start(env.config);
    await new Promise(() => {}); // until the kill
  })();
}
