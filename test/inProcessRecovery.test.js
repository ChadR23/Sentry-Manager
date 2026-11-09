'use strict';

// A clip that could not be finished safely while the app kept running (the
// share refused the move of the converted file onto the original's name, and
// then the move of the original back): the job pauses for a decision, and
// Resume or Cancel then work without a restart. Seen: Resume answered
// INSPECTION_FAILED until the container was restarted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeBase, open, CLIP, HELPER } = require('./fixtures/replaceCrash');

const skip = spawnSync('ffmpeg', ['-version']).status === 0 && fs.existsSync(HELPER) ? false : 'needs ffmpeg and build/noreplace-rename';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The first two moves onto the clip's name fail: the converted file's, then
// the rollback's move of the original back. (On a share without hard links:
// with them the original never leaves its name, so there is nothing to move
// back; see the last test.)
async function stoppedJob(base, { noLinks = true } = {}) {
  const folder = await makeBase(base);
  let refusals = 2;
  const env = await open(base, {
    noLinks,
    onPromote: (request) => {
      if (path.basename(request.to) !== CLIP || refusals === 0) return;
      refusals -= 1;
      throw Object.assign(new Error('share hiccup'), { code: 'EPERM' });
    }
  });
  await env.runtime.start();
  const id = await env.runtime.service.start(env.config);
  let job;
  for (let i = 0; i < 600; i++) {
    job = await env.runtime.service.get(id);
    if (['paused', 'completed', 'failed', 'cancelled'].includes(job.state)) break;
    await sleep(100);
  }
  return { env, id, folder, job };
}

test('a clip stopped mid-replacement: Resume finishes it without a restart', { skip, timeout: 180_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'inproc-resume-'));
  const { env, id, folder, job } = await stoppedJob(base);
  try {
    assert.equal(job.state, 'paused');
    assert.equal(job.recovery?.fromState, 'replacing');
    const resumed = await env.runtime.service.resume(id);
    assert.notEqual(resumed.state, 'paused');
    await env.runtime.service.whenIdle(id);
    const done = await env.runtime.service.get(id);
    assert.equal(done.state, 'completed');
    assert.deepEqual(done.items.map((item) => `${item.state}/${item.resultCode}`), ['completed/converted']);
    assert.deepEqual(fs.readdirSync(folder), [CLIP]);
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a clip stopped mid-replacement: Cancel works without a restart and leaves one clip', { skip, timeout: 180_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'inproc-cancel-'));
  const { env, id, folder, job } = await stoppedJob(base);
  try {
    assert.equal(job.state, 'paused');
    await env.runtime.service.cancel(id);
    await env.runtime.service.whenIdle(id);
    const done = await env.runtime.service.get(id);
    assert.equal(done.state, 'cancelled');
    assert.deepEqual(fs.readdirSync(folder), [CLIP]);
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('with hard links the same refusals never leave the clip\'s name empty: the rename over it is refused, the second link goes, and the clip fails with its original kept (no decision needed)', { skip, timeout: 180_000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'inproc-links-'));
  const { env, folder, job } = await stoppedJob(base, { noLinks: false });
  try {
    assert.equal(job.state, 'completed', JSON.stringify(job.recovery || null));
    assert.equal(job.recovery ?? null, null, 'not parked for a decision');
    assert.deepEqual(job.items.map((item) => `${item.state}/${item.resultCode}`), ['failed/replacement-failed']);
    assert.deepEqual(fs.readdirSync(folder), [CLIP], 'no TEMP- or BACKUP- left');
    const codec = String(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path.join(folder, CLIP)]).stdout).trim();
    assert.equal(codec, 'h264', 'the original, untouched');
    assert.equal(fs.statSync(path.join(folder, CLIP)).nlink, 1);
  } finally {
    await env.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});
