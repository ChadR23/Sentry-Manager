'use strict';

// The Encoder's Hardware panel: the run's energy and device come from the
// right job, and no sentence about what limits the run is made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const { encoderBlock } = require('../server/encoderStats');

const worker = (over = {}) => ({ jobId: 'j1', itemId: 'i1', relativePath: 'RecentClips/a-front.mp4', encoder: 'hevc_vaapi', hardware: true, decode: 'gpu', device: '/dev/dri/renderD128', fps: 400, ...over });

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
  assert.equal('bottleneck' in out, false, 'no bottleneck or room-to-spare sentence');
});

test('no job and nothing running: no block', () => {
  assert.equal(encoderBlock({ snapshot: {}, jobs: new Map([['x', { id: 'x', state: 'completed' }]]) }), null);
});

test('one GPU, no lanes: a clip decoded or redone on the CPU keeps the panel as it always was', async () => {
  const path = require('path');
  const { pathToFileURL } = require('url');
  const { renderHardware } = await import(pathToFileURL(path.join(__dirname, '..', 'src/renderer/scripts/features/hardwarePanel.js')).href);
  const jobs = new Map([['j1', { id: 'j1', state: 'encoding', items: [], counters: {} }]]);
  const snapshot = { cpu: { usage: 30 }, gpus: [{ name: 'Intel Arc A380', node: 'renderD128', video: 95, busy: 20 }], filesystems: [] };
  const page = (workers) => {
    const encoder = encoderBlock({ snapshot, jobs, workers });
    return { encoder, html: renderHardware({ ...snapshot, encoder }) };
  };
  const qsv = (over) => worker({ encoder: 'hevc_qsv', deviceId: null, ...over });
  // QSV decoding on the GPU names renderD128; a clip decoded on the CPU names no node
  const cpuDecode = page([qsv({ itemId: 'a' }), qsv({ itemId: 'b' }), qsv({ itemId: 'c', device: null, decode: 'cpu' })]);
  // a clip redone with the CPU encoder after a failed GPU encode
  const redone = page([worker({ itemId: 'a', deviceId: null }), worker({ itemId: 'b', deviceId: null, encoder: 'libx265', hardware: false, decode: 'cpu', device: null })]);
  for (const { encoder, html } of [cpuDecode, redone]) {
    assert.equal(encoder.devices.length, 1, 'one device: the GPU the job uses');
    assert.doesNotMatch(html, /nd-devices/, 'no line per device');
    assert.match(html, /<span>Video engine<\/span>/);
  }
  assert.match(cpuDecode.html, /hevc_qsv · Intel Arc A380 · renderD128/, 'the encoder chip stays');
  assert.match(redone.html, /hevc_vaapi · Intel Arc A380 · renderD128/);
});

test('a GPU lane next to the CPU lane: the GPU comes first whichever clip is listed first', () => {
  const jobs = new Map([['j1', { id: 'j1', state: 'encoding', items: [], counters: {} }]]);
  const snapshot = { cpu: { usage: 30 }, gpus: [{ name: 'Intel Arc A380', node: 'renderD128', video: 97 }, { name: 'NVIDIA T400', node: 'nvidia0', video: 0 }], filesystems: [] };
  const arc = (itemId) => worker({ itemId, encoder: 'hevc_qsv', deviceId: 'pci:0000:03:00.0' });
  const cpu = worker({ itemId: 'c', encoder: 'libx265', hardware: false, decode: 'cpu', device: null, deviceId: 'cpu' });
  for (const workers of [[cpu, arc('a'), arc('b')], [arc('a'), cpu, arc('b')]]) {
    const out = encoderBlock({ snapshot, jobs, workers });
    assert.deepEqual(out.devices.map((d) => [d.id, d.name, d.workers, d.video]), [['pci:0000:03:00.0', 'Intel Arc A380', 2, 97], ['cpu', 'CPU', 1, null]], workers.map((w) => w.itemId).join());
    assert.equal('bottleneck' in out, false);
  }
});
