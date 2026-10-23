'use strict';

// A replacing conversion interrupted by a restart (an update of the container,
// a power cut) must finish that clip after the restart, never get stuck in a
// state that can only be discarded. The converter dies for real (SIGKILL) at
// the most delicate moments, right before and right after the converted file
// takes the original's name.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeBase, open, CLIP, HELPER } = require('./fixtures/replaceCrash');

const skip = spawnSync('ffmpeg', ['-version']).status === 0 && fs.existsSync(HELPER) ? false : 'needs ffmpeg and build/noreplace-rename';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const codec = (file) => String(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file]).stdout).trim();

async function crashThenRestart(kill) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-recover-'));
  const folder = await makeBase(base);
  const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures', 'replaceCrash.js')], { env: { ...process.env, BASE: base, KILL: kill }, timeout: 90_000 });
  assert.strictEqual(child.signal, 'SIGKILL', 'the converter died mid-replacement');
  assert.ok(fs.readdirSync(folder).some((name) => name.startsWith('BACKUP-')), 'the original is still kept as a backup');
  const env = await open(base);
  await env.runtime.start();
  const [job] = await env.runtime.service.list();
  await Promise.race([env.runtime.service.whenIdle(job.id), sleep(30_000)]);
  return { base, folder, env, jobId: job.id };
}

async function settled(env, jobId) {
  await Promise.race([env.runtime.service.whenIdle(jobId), sleep(30_000)]);
  return env.runtime.service.get(jobId);
}

test('a restart right after the converted file took the original\'s name finishes the clip', { skip, timeout: 180_000 }, async () => {
  const { base, folder, env, jobId } = await crashThenRestart('after');
  try {
    const job = await settled(env, jobId);
    assert.strictEqual(job.state, 'completed');
    assert.strictEqual(job.items[0].resultCode, 'converted');
    assert.deepStrictEqual(fs.readdirSync(folder), [CLIP], 'backup removed, nothing left over');
    assert.strictEqual(codec(path.join(folder, CLIP)), 'hevc');
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a restart right before it moves the file in finishes the clip by itself (no Resume)', { skip, timeout: 180_000 }, async () => {
  const { base, folder, env, jobId } = await crashThenRestart('before');
  try {
    const job = await settled(env, jobId);
    assert.strictEqual(job.state, 'completed');
    assert.strictEqual(job.recovery ?? null, null);
    assert.strictEqual(job.items[0].resultCode, 'converted');
    assert.deepStrictEqual(fs.readdirSync(folder), [CLIP]);
    assert.strictEqual(codec(path.join(folder, CLIP)), 'hevc');
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a job an earlier version left waiting for Resume mid-replacement finishes when the converter starts', { skip, timeout: 180_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-recover-'));
  let env;
  try {
    const folder = await makeBase(base);
    const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures', 'replaceCrash.js')], { env: { ...process.env, BASE: base, KILL: 'before' }, timeout: 90_000 });
    assert.strictEqual(child.signal, 'SIGKILL');
    env = await open(base);
    // what earlier versions saved after taking one step of the recovery
    const [stopped] = await env.runtime.store.list();
    await env.runtime.store.transition(stopped.id, {
      state: 'paused', recovery: { fromState: 'replacing', phase: stopped.replacementPhase, action: 'manual-intervention' }
    });
    await env.runtime.start();
    const job = await settled(env, stopped.id);
    assert.strictEqual(job.state, 'completed');
    assert.strictEqual(job.items[0].resultCode, 'converted');
    assert.deepStrictEqual(fs.readdirSync(folder), [CLIP]);
    assert.strictEqual(codec(path.join(folder, CLIP)), 'hevc');
  } finally {
    await env?.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});
