'use strict';

// The Health page's encoder check counts the GPUs this container can use from
// detectGpus()'s { gpus, nvidia, hints } (it used to read it as a list, so it
// never saw a GPU and a broken GPU encoder showed as OK).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHealth } = require('../server/health');

const quiet = { info() {}, warn() {}, error() {}, debug() {}, scope() { return quiet; } };
const memDb = () => { const m = new Map(); return { get: (k, d = null) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) }; };

async function encoderCheck(found, encoder) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-health-gpu-'));
  const h = createHealth({
    db: memDb(), dataDir, vehicles: { list: () => [] }, ffmpegPath: process.execPath, ffprobePath: process.execPath,
    diskSpace: async () => ({ free: 100e9, total: 200e9 }), detectGpus: async () => found,
    runtime: () => ({ encodingNow: () => false, selectEncoder: async () => encoder }), log: quiet
  });
  const r = await h.run();
  return r.checks.find((c) => c.id === 'encoder');
}

const intel = { vendor: 'intel', vendorName: 'Intel', passedThrough: true, virtual: false };

test('a passed-in GPU whose encoder works: GPU encoder works, ok', async () => {
  const c = await encoderCheck({ gpus: [intel], nvidia: [], hints: [] }, { codec: 'hevc_qsv', hardware: true });
  assert.equal(c.label, 'GPU encoder works');
  assert.equal(c.status, 'ok');
});

test('a passed-in GPU whose encoder fails: a warning that says the GPU is visible', async () => {
  const c = await encoderCheck({ gpus: [intel], nvidia: [], hints: [] }, { codec: 'libx265', hardware: false });
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /1 GPU visible/);
  assert.match(c.hint, /encoder failed a test encode/);
});

test('NVIDIA in the container counts; a host GPU not passed in, or a virtual one, does not', async () => {
  const nv = await encoderCheck({ gpus: [{ vendor: 'nvidia', passedThrough: false }], nvidia: [{ name: 'RTX 4070' }], hints: [] }, { codec: 'libx265', hardware: false });
  assert.match(nv.detail, /1 GPU visible/);
  const none = await encoderCheck({ gpus: [{ vendor: 'amd', passedThrough: false }, { vendor: 'intel', passedThrough: true, virtual: true }], nvidia: [], hints: [] }, { codec: 'libx265', hardware: false });
  assert.equal(none.status, 'ok');
  assert.equal(none.label, 'Encoder');
});
