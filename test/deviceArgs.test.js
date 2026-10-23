'use strict';

// ffmpeg arguments for a GPU chosen per lane, and the arguments without one,
// which must stay exactly what they always were (one GPU, or none).

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEncodeArgs, decodeAccelArgs, probeCandidate } = require('../src/main/converter/encoderPlanner');

const ARC = Object.freeze({ id: 'pci:0000:03:00.0', kind: 'dri', node: '/dev/dri/renderD129', index: null });
const RTX = Object.freeze({ id: 'pci:0000:02:00.0', kind: 'nvidia', node: null, index: 1 });
const TAIL = ['-tag:v', 'hvc1', '-fps_mode', 'passthrough', '-start_at_zero', '-avoid_negative_ts', 'make_zero', '-use_editlist', '0'];
const AV1_TAIL = ['-tag:v', 'av01', '-fps_mode', 'passthrough', '-start_at_zero', '-avoid_negative_ts', 'make_zero', '-use_editlist', '0'];

test('without a device every encoder gets exactly today\'s arguments', () => {
  const bitrate = 1_234_567;
  assert.deepEqual(buildEncodeArgs({ codec: 'h265', encoder: 'hevc_vaapi', bitrate }),
    ['-vaapi_device', '/dev/dri/renderD128', '-vf', 'format=nv12,hwupload', '-c:v', 'hevc_vaapi', '-b:v', '1234567', '-bf', '0', ...TAIL]);
  assert.deepEqual(buildEncodeArgs({ codec: 'h265', encoder: 'hevc_qsv', bitrate }),
    ['-c:v', 'hevc_qsv', '-b:v', '1234567', '-pix_fmt', 'nv12', '-bf', '0', ...TAIL]);
  assert.deepEqual(buildEncodeArgs({ codec: 'h265', encoder: 'hevc_nvenc', bitrate }),
    ['-c:v', 'hevc_nvenc', '-b:v', '1234567', '-pix_fmt', 'yuv420p', '-bf', '0', ...TAIL]);
  assert.deepEqual(buildEncodeArgs({ codec: 'h265', encoder: 'hevc_nvenc', bitrate, hwFrames: true }),
    ['-c:v', 'hevc_nvenc', '-b:v', '1234567', '-bf', '0', ...TAIL]);
  assert.deepEqual(buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate }),
    ['-c:v', 'libx265', '-b:v', '1234567', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-bf', '0', ...TAIL]);
  assert.deepEqual(buildEncodeArgs({ codec: 'av1', encoder: 'av1_vaapi', quality: 'balanced' }),
    ['-vaapi_device', '/dev/dri/renderD128', '-vf', 'format=nv12,hwupload', '-c:v', 'av1_vaapi', '-rc_mode', 'CQP', '-global_quality', '112', ...AV1_TAIL]);
  assert.deepEqual(buildEncodeArgs({ codec: 'av1', encoder: 'av1_qsv', quality: 'high' }),
    ['-c:v', 'av1_qsv', '-global_quality', '24', '-pix_fmt', 'nv12', ...AV1_TAIL]);
  assert.deepEqual(buildEncodeArgs({ codec: 'h265', encoder: 'hevc_vaapi', bitrate, vaapiDevice: '/dev/dri/renderD130' }).slice(0, 2),
    ['-vaapi_device', '/dev/dri/renderD130']);

  assert.deepEqual(decodeAccelArgs('hevc_vaapi', { platform: 'linux' }), ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128']);
  assert.deepEqual(decodeAccelArgs('hevc_qsv', { platform: 'linux' }), ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128']);
  assert.deepEqual(decodeAccelArgs('hevc_qsv', { platform: 'win32' }), ['-hwaccel', 'd3d11va']);
  assert.deepEqual(decodeAccelArgs('hevc_nvenc', { platform: 'linux' }), ['-hwaccel', 'cuda']);
  assert.deepEqual(decodeAccelArgs('hevc_nvenc', { platform: 'linux', zeroCopy: true }), ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']);
  assert.equal(decodeAccelArgs('hevc_vaapi', { platform: 'linux', zeroCopy: true }), null);
  assert.equal(decodeAccelArgs('libx265', { platform: 'linux' }), null);
});

test('a chosen GPU: VA-API and QSV on its render node, NVENC by its index', () => {
  const vaapi = buildEncodeArgs({ codec: 'h265', encoder: 'hevc_vaapi', bitrate: 800_000, device: ARC });
  assert.deepEqual(vaapi.slice(0, 6), ['-vaapi_device', '/dev/dri/renderD129', '-vf', 'format=nv12,hwupload', '-c:v', 'hevc_vaapi']);
  assert.equal(vaapi.filter((arg) => arg === '-vaapi_device').length, 1);

  const qsv = buildEncodeArgs({ codec: 'av1', encoder: 'av1_qsv', bitrate: 800_000, device: ARC });
  assert.deepEqual(qsv.slice(0, 4), ['-init_hw_device', 'qsv=qsvenc:hw_any,child_device=/dev/dri/renderD129', '-c:v', 'av1_qsv']);
  assert.ok(qsv.indexOf('-init_hw_device') < qsv.indexOf('-c:v'), 'the global option comes before -c:v');
  assert.deepEqual(qsv.slice(4), ['-b:v', '800000', '-pix_fmt', 'nv12', ...AV1_TAIL]);

  const nvenc = buildEncodeArgs({ codec: 'h265', encoder: 'hevc_nvenc', quality: 'small', device: RTX });
  assert.deepEqual(nvenc.slice(0, 4), ['-c:v', 'hevc_nvenc', '-gpu', '1']);
  assert.deepEqual(nvenc.slice(4, 10), ['-rc', 'vbr', '-cq', '32', '-b:v', '0']);

  // a CPU encoder ignores a device
  assert.deepEqual(buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: 800_000, device: ARC }),
    buildEncodeArgs({ codec: 'h265', encoder: 'libx265', bitrate: 800_000 }));

  assert.deepEqual(decodeAccelArgs('hevc_vaapi', { platform: 'linux', device: ARC }), ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD129']);
  assert.deepEqual(decodeAccelArgs('av1_qsv', { platform: 'linux', device: ARC }), ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD129']);
  assert.equal(decodeAccelArgs('hevc_qsv', { platform: 'linux', device: ARC, zeroCopy: true }), null, 'no zero-copy tier for QSV');
  assert.deepEqual(decodeAccelArgs('hevc_nvenc', { platform: 'linux', device: RTX }), ['-hwaccel', 'cuda', '-hwaccel_device', '1']);
  assert.deepEqual(decodeAccelArgs('hevc_nvenc', { platform: 'linux', device: RTX, zeroCopy: true }),
    ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-hwaccel_device', '1']);
});

test('a probe for a chosen GPU encodes with that GPU\'s arguments', async () => {
  const seen = [];
  const runProbe = async (_command, args) => { seen.push(args); return { status: 0, stdout: '', stderr: '' }; };
  const proof = await probeCandidate({ runProbe, platform: 'linux', family: 'h265', candidate: { codec: 'hevc_qsv', hardware: true }, device: ARC });
  assert.equal(proof.usable, true);
  assert.ok(seen[0].includes('qsv=qsvenc:hw_any,child_device=/dev/dri/renderD129'));
  await probeCandidate({ runProbe, platform: 'linux', family: 'h265', candidate: { codec: 'hevc_qsv', hardware: true } });
  assert.ok(!seen[1].includes('-init_hw_device'), 'no device, no device arguments');
  const broken = await probeCandidate({ runProbe, platform: 'linux', family: 'h265', candidate: { codec: 'hevc_nvenc', hardware: true }, device: { id: 'x', kind: 'nvidia' } });
  assert.equal(broken.usable, false, 'a device without an index cannot be probed');
  assert.equal(seen.length, 2);
});
