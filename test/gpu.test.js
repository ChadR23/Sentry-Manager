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
  fs.writeFileSync(path.join(dir, 'version'), 'Linux version 6.8.0-45-generic (buildd@lcy02-amd64-075)\n');
  return { dir, opts: { driDir: path.join(dir, 'dri'), sysDrm: path.join(dir, 'drm'), dxg: path.join(dir, 'dxg'), runImpl, procVersion: path.join(dir, 'version') } };
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

test('WSL with /dev/dri left out: the bridge is not listed and no "pass it in" hint', async () => {
  const { dir, opts } = fakeHost({ wsl: false, vainfo: { code: 1, stdout: '', stderr: '' }, smi: SMI });
  try {
    fs.rmSync(path.join(dir, 'dri', 'renderD128')); // in the host's list only
    const out = await detectGpus(opts);
    assert.deepEqual(out.gpus, []);
    assert.deepEqual(out.hints, []);
    assert.equal(out.nvidia.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an AMD or Intel GPU on the host that is not passed in still gets its hint', async () => {
  const { dir, opts } = fakeHost({ wsl: false, vainfo: { code: 1, stdout: '', stderr: '' }, smi: { code: 1, stdout: '', stderr: '' } });
  try {
    fs.rmSync(path.join(dir, 'dri', 'renderD128'));
    fs.mkdirSync(path.join(dir, 'drm', 'renderD128', 'device'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'drm', 'renderD128', 'device', 'vendor'), '0x1002\n');
    const out = await detectGpus(opts);
    assert.equal(out.gpus.length, 1);
    assert.match(out.hints[0], /AMD GPU found on the host but \/dev\/dri is not passed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Docker Desktop on a Mac: no GPU, and the reason is said plainly (Docker cannot use the Mac\'s GPU)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-gpu-'));
  try {
    fs.writeFileSync(path.join(dir, 'version'), 'Linux version 6.10.14-linuxkit (root@buildkitsandbox) (gcc (Alpine 13.2.1_git20240309) 13.2.1) #1 SMP Fri Nov 29 17:22:03 UTC 2024\n');
    const none = { code: 1, stdout: '', stderr: '' };
    const opts = { driDir: path.join(dir, 'no-dri'), sysDrm: path.join(dir, 'no-drm'), dxg: path.join(dir, 'no-dxg'), runImpl: async () => none, procVersion: path.join(dir, 'version') };
    const mac = await detectGpus({ ...opts, arch: 'arm64' });
    assert.deepEqual([mac.gpus.length, mac.nvidia.length], [0, 0]);
    assert.equal(mac.hints.length, 1);
    assert.match(mac.hints[0], /Docker cannot use a Mac's GPU/);
    assert.match((await detectGpus({ ...opts, arch: 'x64' })).hints[0], /Docker Desktop/);
    // an ordinary Linux host with no GPU: no such note
    fs.writeFileSync(path.join(dir, 'version'), 'Linux version 6.8.0-45-generic\n');
    assert.deepEqual((await detectGpus({ ...opts, arch: 'arm64' })).hints, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
