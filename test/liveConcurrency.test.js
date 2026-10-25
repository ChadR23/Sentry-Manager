'use strict';

// Parallel conversions can change while a job runs (the GPU is needed
// elsewhere): more starts new encodes right away, fewer lets the extra ones
// finish their clip, nothing is cancelled, and the number is kept with the job.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { open, HELPER } = require('./fixtures/replaceCrash');
const { createTeslaH264Fixture } = require('./fixtures/ffmpegFixtures');

const skip = spawnSync('ffmpeg', ['-version']).status === 0 && fs.existsSync(HELPER) ? false : 'needs ffmpeg and build/noreplace-rename';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ffmpeg that marks each encode while it runs (and takes a moment), so the
// number running at once can be counted
function trackingFfmpeg(base) {
  const running = path.join(base, 'running');
  fs.mkdirSync(running);
  const script = path.join(base, 'ffmpeg-track.sh');
  fs.writeFileSync(script, `#!/bin/sh
case "$*" in *-progress*) touch "${running}/$$"; sleep 1.5; ffmpeg "$@"; s=$?; rm -f "${running}/$$"; exit $s ;; esac
exec ffmpeg "$@"
`, { mode: 0o755 });
  return { script, count: () => fs.readdirSync(running).length };
}

test('Parallel conversions changes mid-run: up now, down after the current clips, kept with the job', { skip, timeout: 240_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-live-'));
  let env;
  try {
    const event = path.join(base, 'footage', 'TeslaCam', 'SentryClips', '2026-10-20_07-44-14');
    fs.mkdirSync(event, { recursive: true });
    const first = path.join(event, '2026-10-20_07-10-00-front.mp4');
    await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: first, durationSeconds: 2, frameRate: 12, size: '320x240', spatialNoise: 4,
      telemetryPattern: Array.from({ length: 24 }, (_, n) => Buffer.from([0x20, n])) });
    for (let i = 11; i < 24; i++) fs.copyFileSync(first, path.join(event, `2026-10-20_07-${i}-00-front.mp4`));
    for (const d of ['data', 'temp', 'out']) fs.mkdirSync(path.join(base, d));
    const ff = trackingFfmpeg(base);
    env = await open(base, { ffmpegPath: ff.script });
    await env.runtime.start();
    const id = await env.runtime.service.start({ ...env.config, outputMode: 'separate', destinationRoot: fs.realpathSync(path.join(base, 'out')), replacementConfirmed: false, concurrency: 1 });

    let peak = 0;
    const watch = setInterval(() => { peak = Math.max(peak, ff.count()); }, 20);
    await sleep(2500);
    assert.ok(peak <= 1, `one at a time at first (saw ${peak})`);
    let job = await env.runtime.service.setConcurrency(id, 3);
    assert.equal(job.config.concurrency, 3);
    peak = 0;
    await sleep(3500);
    assert.equal(peak, 3, 'three at once right after raising it');
    await env.runtime.service.setConcurrency(id, 1);
    await sleep(2500); // the extra clips finish their encode first
    peak = 0;
    await sleep(3000);
    clearInterval(watch);
    assert.ok(peak <= 1, `back to one at a time (saw ${peak})`);

    await Promise.race([env.runtime.service.whenIdle(id), sleep(120_000)]);
    job = await env.runtime.service.get(id);
    assert.equal(job.state, 'completed', 'nothing was cancelled');
    assert.equal(job.items.filter((i) => i.state === 'completed').length, 14);
    assert.equal(job.config.concurrency, 1, 'kept with the job');
    await assert.rejects(env.runtime.service.setConcurrency(id, 2), { code: 'JOB_NOT_ACTIVE' });
  } finally {
    await env?.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an invalid number is refused', { skip }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-live-'));
  try {
    for (const d of ['data', 'temp', 'footage/TeslaCam']) fs.mkdirSync(path.join(base, d), { recursive: true });
    const env = await open(base);
    await assert.rejects(env.runtime.service.setConcurrency('job-x', 0), { code: 'INVALID_CONCURRENCY' });
    await assert.rejects(env.runtime.service.setConcurrency('job-x', 1.5), { code: 'INVALID_CONCURRENCY' });
    await env.runtime.shutdown().catch(() => {});
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('for an automatic job, the saved automatic settings follow the change', async () => {
  const { createAutoConverter } = require('../src/main/converter/autoConvert');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-live-auto-'));
  try {
    const auto = createAutoConverter({
      service: { list: async () => [], get: async () => null }, scanner: async function* () {}, fs: fs.promises, directory: dir,
      timers: { setInterval: () => null, clearInterval: () => {} }
    });
    const config = { sourceRoot: dir, destinationRoot: null, codec: 'h265', profileId: 'balanced', networkMode: 'direct', outputMode: 'replace',
      includedGroups: ['SavedClips'], groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'], replacementConfirmed: true, concurrency: 6, verifyMode: 'quick' };
    await auto.configure({ enabled: true, intervalMinutes: 60, window: null, config });
    await auto.setConcurrency(2);
    assert.equal(auto.getState().settings.configs[0].concurrency, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).configs[0].concurrency, 2, 'saved for the next automatic job');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
