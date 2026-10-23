'use strict';

// The Encoder's Hardware panel: the bottleneck is only claimed when the
// numbers show it, and the run's energy and device come from the right job.

const test = require('node:test');
const assert = require('node:assert/strict');
const { encoderBlock, bottleneck } = require('../server/encoderStats');

const worker = (over = {}) => ({ jobId: 'j1', itemId: 'i1', relativePath: 'RecentClips/a-front.mp4', encoder: 'hevc_vaapi', hardware: true, decode: 'gpu', device: '/dev/dri/renderD128', fps: 400, ...over });

test('a busy video engine is the bottleneck of a GPU run', () => {
  const b = bottleneck({ workers: [worker()], cpu: { usage: 30 }, gpu: { video: 96, busy: 20 }, filesystems: [] });
  assert.equal(b.kind, 'gpu-video');
  assert.match(b.message, /96% busy/);
});

test('a busy CPU is named for software runs, a slow share when nothing else is maxed', () => {
  assert.equal(bottleneck({ workers: [worker({ hardware: false, encoder: 'libx265' })], cpu: { usage: 97 }, gpu: null, filesystems: [] }).kind, 'cpu');
  const share = bottleneck({ workers: [worker()], cpu: { usage: 20 }, gpu: { video: 30 }, filesystems: [{ latencyMs: 1800, reachable: true }] });
  assert.equal(share.kind, 'source-read');
  assert.match(share.message, /1800 ms/);
});

test('no bottleneck is claimed without numbers', () => {
  assert.deepEqual(bottleneck({ workers: [], cpu: null, gpu: null }), { kind: 'none', message: null });
  assert.equal(bottleneck({ workers: [worker()], cpu: { usage: 75 }, gpu: { video: 70 } }).message, null);
});

test('the block names the running job, its GPU, energy and saved space', () => {
  const jobs = new Map([
    ['old', { id: 'old', state: 'completed', items: [] }],
    ['j1', { id: 'j1', state: 'encoding', createdAt: 1000, counters: { savedBytes: 5e9 },
      items: [{ kind: 'video', state: 'completed' }, { kind: 'video', state: 'completed', eligibleVideo: false }, { kind: 'video', state: 'waiting' }] }]
  ]);
  const snapshot = { cpu: { usage: 25 }, gpus: [{ name: 'Intel Arc A380', node: 'renderD128', video: 94 }], filesystems: [] };
  const out = encoderBlock({ snapshot, jobs, workers: [worker(), worker({ jobId: 'other' })], energy: { byJob: { j1: { wh: 312.44, avgW: 67.6, seconds: 16000, cost: 0.041 } } } });
  assert.equal(out.jobId, 'j1');
  assert.equal(out.running, true);
  assert.equal(out.workers.length, 1, 'only this job\'s clips');
  assert.deepEqual(out.device, { encoder: 'hevc_vaapi', hardware: true, gpuName: 'Intel Arc A380', node: '/dev/dri/renderD128', decode: 'gpu' });
  assert.deepEqual(out.run, { wh: 312.4, avgW: 68, cost: 0.041, clips: 1, savedB: 5e9, startedAt: 1000 });
  assert.equal(out.bottleneck.kind, 'gpu-video');
});

test('no job and nothing running: no block', () => {
  assert.equal(encoderBlock({ snapshot: {}, jobs: new Map([['x', { id: 'x', state: 'completed' }]]) }), null);
});
