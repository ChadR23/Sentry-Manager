'use strict';

// An update (docker compose down / up) in the middle of a conversion: the job
// carries on by itself afterwards, wherever the stop landed, and a job the
// owner paused stays paused. Seen: a job stopped between two clips came back
// paused with nothing to resume and only Cancel helped.

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

async function footage(base, clips = 4) {
  const event = path.join(base, 'footage', 'TeslaCam', 'SentryClips', '2026-10-20_07-44-14');
  fs.mkdirSync(event, { recursive: true });
  const first = path.join(event, '2026-10-20_07-40-00-front.mp4');
  await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: first, durationSeconds: 2, frameRate: 12, size: '320x240', spatialNoise: 4,
    telemetryPattern: Array.from({ length: 24 }, (_, n) => Buffer.from([0x20, n])) });
  for (let i = 1; i < clips; i++) fs.copyFileSync(first, path.join(event, `2026-10-20_07-4${i}-00-front.mp4`));
  for (const d of ['data', 'temp']) fs.mkdirSync(path.join(base, d));
  return event;
}

// ffprobe that stops at the third clip until released: the worker is then
// between clips (nothing staged, nothing half written).
function holdingProbe(base) {
  const script = path.join(base, 'ffprobe-hold.sh');
  fs.writeFileSync(script, `#!/bin/sh
case "$*" in *07-42-00-front*) [ -f "${base}/released" ] || { touch "${base}/reached"; while [ ! -f "${base}/released" ]; do sleep 0.05; done; } ;; esac
exec ffprobe "$@"
`, { mode: 0o755 });
  return script;
}

async function until(fn, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

test('stopped between two clips, the job carries on by itself after the restart', { skip, timeout: 180_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-restart-'));
  let env;
  try {
    await footage(base);
    env = await open(base, { ffprobePath: holdingProbe(base) });
    await env.runtime.start();
    const id = await env.runtime.service.start({ ...env.config, concurrency: 1 });
    assert.ok(await until(() => fs.existsSync(path.join(base, 'reached'))), 'the third clip is reached');
    await env.runtime.shutdown();
    const stopped = await env.runtime.service.get(id);
    assert.equal(stopped.state, 'paused');
    assert.equal(stopped.activeItemId ?? null, null, 'no clip was half done');
    fs.writeFileSync(path.join(base, 'released'), '');

    env = await open(base);
    await env.runtime.start();
    await Promise.race([env.runtime.service.whenIdle(id), sleep(60_000)]);
    const job = await env.runtime.service.get(id);
    assert.equal(job.state, 'completed', 'no Resume or Cancel needed');
    assert.equal(job.items.filter((i) => i.state === 'completed').length, 4);
  } finally {
    await env?.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a job the owner paused stays paused through a restart, and Resume finishes it', { skip, timeout: 180_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-restart-'));
  let env;
  try {
    await footage(base);
    env = await open(base, { ffprobePath: holdingProbe(base) });
    await env.runtime.start();
    const id = await env.runtime.service.start({ ...env.config, concurrency: 1 });
    assert.ok(await until(() => fs.existsSync(path.join(base, 'reached'))));
    await env.runtime.service.pause(id);
    fs.writeFileSync(path.join(base, 'released'), '');
    assert.ok(await until(async () => (await env.runtime.service.get(id)).state === 'paused'), 'paused');
    await env.runtime.shutdown();

    env = await open(base);
    await env.runtime.start();
    await sleep(1500);
    let job = await env.runtime.service.get(id);
    assert.equal(job.state, 'paused', 'still paused after the restart');
    await env.runtime.service.resume(id);
    await Promise.race([env.runtime.service.whenIdle(id), sleep(60_000)]);
    job = await env.runtime.service.get(id);
    assert.equal(job.state, 'completed');
  } finally {
    await env?.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a crash while a job is paused: the converter still starts and the job stays paused', { skip, timeout: 180_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-restart-'));
  let env;
  try {
    await footage(base);
    const probe = holdingProbe(base);
    const child = spawnSync(process.execPath, ['-e', `
      const fs = require('fs'); const path = require('path');
      const { open } = require(${JSON.stringify(path.join(__dirname, 'fixtures', 'replaceCrash.js'))});
      const base = ${JSON.stringify(base)};
      (async () => {
        const env = await open(base, { ffprobePath: ${JSON.stringify(probe)} });
        await env.runtime.start();
        const id = await env.runtime.service.start({ ...env.config, concurrency: 1 });
        while (!fs.existsSync(path.join(base, 'reached'))) await new Promise((r) => setTimeout(r, 50));
        await env.runtime.service.pause(id);
        fs.writeFileSync(path.join(base, 'released'), '');
        while ((await env.runtime.service.get(id)).state !== 'paused') await new Promise((r) => setTimeout(r, 50));
        fs.writeFileSync(path.join(base, 'job-id'), id);
        process.kill(process.pid, 'SIGKILL');
      })();
    `], { timeout: 120_000 });
    assert.equal(child.signal, 'SIGKILL', 'the app died while the job was paused');
    const id = fs.readFileSync(path.join(base, 'job-id'), 'utf8');
    env = await open(base);
    await env.runtime.start();
    await sleep(1000);
    const job = await env.runtime.service.get(id);
    assert.equal(job.state, 'paused');
    await env.runtime.service.resume(id);
    await Promise.race([env.runtime.service.whenIdle(id), sleep(60_000)]);
    assert.equal((await env.runtime.service.get(id)).state, 'completed');
  } finally {
    await env?.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a pause saved by an earlier version stays paused after the update', { skip, timeout: 180_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-restart-'));
  let env;
  try {
    await footage(base);
    env = await open(base, { ffprobePath: holdingProbe(base) });
    await env.runtime.start();
    const id = await env.runtime.service.start({ ...env.config, concurrency: 1 });
    assert.ok(await until(() => fs.existsSync(path.join(base, 'reached'))));
    await env.runtime.service.pause(id);
    fs.writeFileSync(path.join(base, 'released'), '');
    assert.ok(await until(async () => (await env.runtime.service.get(id)).state === 'paused'));
    await env.runtime.shutdown();
    // what earlier versions saved for every job on a stop, paused ones too
    env = await open(base);
    await env.runtime.store.transition(id, { state: 'paused', activeItemId: null, recovery: { fromState: 'encoding', action: 'restart-encoding' } });
    await env.runtime.start();
    await sleep(1500);
    let job = await env.runtime.service.get(id);
    assert.equal(job.state, 'paused', 'not resumed by itself');
    await env.runtime.service.resume(id);
    await Promise.race([env.runtime.service.whenIdle(id), sleep(60_000)]);
    job = await env.runtime.service.get(id);
    assert.equal(job.state, 'completed', 'Resume still finishes it');
  } finally {
    await env?.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});
