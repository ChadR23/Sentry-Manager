'use strict';

// Settings > System lists the GPUs the container can see. On Windows (WSL)
// /dev/dri holds a D3D12 bridge, not a GPU: it is named as such, with no
// "encodes nothing" warning, while the NVIDIA card is listed once by name.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectGpus } = require('../server/gpu');

function fakeHost({ wsl, vainfo, smi }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-gpu-'));
  fs.mkdirSync(path.join(dir, 'dri'));
  fs.writeFileSync(path.join(dir, 'dri', 'renderD128'), '');
  fs.mkdirSync(path.join(dir, 'drm', 'renderD128'), { recursive: true }); // no device/vendor, like WSL
  if (wsl) fs.writeFileSync(path.join(dir, 'dxg'), '');
  const runImpl = async (cmd) => (cmd === 'vainfo' ? vainfo : smi);
  return { dir, opts: { driDir: path.join(dir, 'dri'), sysDrm: path.join(dir, 'drm'), dxg: path.join(dir, 'dxg'), runImpl } };
}

const SMI = { code: 0, stdout: 'NVIDIA GeForce RTX 4070 Ti, 617.42\n', stderr: '' };

test('WSL: the D3D12 bridge is named, not reported as a GPU that encodes nothing', async () => {
  const vainfo = { code: 0, stdout: 'vainfo: Driver version: Mesa Gallium driver 24.0.5 for D3D12 (NVIDIA GeForce RTX 4070 Ti)\nVAProfileH264Main : VAEntrypointVLD\n', stderr: '' };
  const { dir, opts } = fakeHost({ wsl: true, vainfo, smi: SMI });
  try {
    const out = await detectGpus(opts);
    assert.equal(out.gpus[0].virtual, true);
    assert.equal(out.gpus[0].name, 'Windows (WSL) graphics bridge');
    assert.deepEqual(out.hints, []);
    assert.deepEqual(out.nvidia, [{ name: 'NVIDIA GeForce RTX 4070 Ti', driver: '617.42' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WSL without a working VA-API driver: still the bridge, no warning', async () => {
  const { dir, opts } = fakeHost({ wsl: true, vainfo: { code: 1, stdout: '', stderr: 'vaInitialize failed' }, smi: SMI });
  try {
    const out = await detectGpus(opts);
    assert.equal(out.gpus[0].virtual, true);
    assert.deepEqual(out.hints, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a real GPU whose driver lacks H.265 still gets its hint', async () => {
  const vainfo = { code: 0, stdout: 'Driver version: Intel iHD driver for Intel(R) Gen Graphics\nVAProfileH264Main : VAEntrypointEncSlice\n', stderr: '' };
  const { dir, opts } = fakeHost({ wsl: false, vainfo, smi: { code: 1, stdout: '', stderr: '' } });
  try {
    const out = await detectGpus(opts);
    assert.equal(out.gpus[0].virtual, undefined);
    assert.equal(out.hints.length, 1);
    assert.match(out.hints[0], /no H\.265 encoder/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
