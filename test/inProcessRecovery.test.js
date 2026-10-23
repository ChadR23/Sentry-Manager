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
// the rollback's move of the original back.
async function stoppedJob(base) {
  const folder = await makeBase(base);
  let refusals = 2;
  const env = await open(base, {
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
