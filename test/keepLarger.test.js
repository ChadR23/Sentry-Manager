'use strict';

// "Always convert, even if larger" (opt-in, constant quality and custom
// bitrate): a clip that is still not smaller after the retries under the
// original's bitrate (85%, then 60%) is kept converted instead of staying
// H.264, as long as it passed every other check. Off by default.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHarness, CPU } = require('./fixtures/lanesHarness');

const SOURCE = 4_000_000;
const BIGGER = SOURCE + 50_000;

// Stands in for the verifier: never smaller; ok and marked only when asked
function neverSmaller(calls, { other = null } = {}) {
  return async (options) => {
    calls.push(options);
    if (other) return { ok: false, reason: other, outputBytes: BIGGER, retryable: false };
    if (options.allowLarger !== true) return { ok: false, reason: 'not-smaller', sourceBytes: SOURCE, outputBytes: BIGGER, retryable: false, details: { savedBytes: SOURCE - BIGGER } };
    return { ok: true, reason: null, outputBytes: BIGGER, publicationArtifact: null, details: { larger: true, largerBytes: BIGGER - SOURCE } };
  };
}

async function run(verifier, extra = {}) {
  const h = createHarness({
    clips: 1, devices: [CPU], defaultDevice: null, gpuDecode: false,
    works: (encoder) => encoder.startsWith('lib'),
    copyAsset: async ({ destination }) => ({ finalPath: destination, outputBytes: SOURCE, ownedPaths: {}, ownedArtifacts: {} }),
    verifier
  });
  try {
    const id = await h.service.start(h.config({ profileId: 'quality', qualityLevel: 'balanced', bitrateKbps: undefined, ...extra }));
    const job = await h.finishJob(id);
    return { job, item: job.items.find((entry) => entry.kind === 'video'), encodes: h.encodes().length };
  } finally {
    await h.close();
  }
}

test('option off: after the two retries under the original bitrate the original is kept', async () => {
  const calls = [];
  const { item, encodes } = await run(neverSmaller(calls));
  assert.equal(encodes, 3, 'quality, then 85%, then 60%');
  assert.equal(item.resultCode, 'no-savings');
  assert.ok(calls.every((o) => o.allowLarger === undefined), 'the verifier is never asked to allow larger');
});

test('option on: the same retries come first, only the last copy is kept although larger', async () => {
  const calls = [];
  const { job, item, encodes } = await run(neverSmaller(calls), { keepLarger: true });
  assert.equal(job.config.keepLarger, true);
  assert.equal(encodes, 3, 'quality, then 85%, then 60%');
  assert.deepEqual(calls.map((o) => o.allowLarger === true), [false, false, true], 'allowed only on the last attempt');
  assert.equal(item.state, 'completed');
  assert.equal(item.resultCode, 'converted');
});

test('option on: any other failure (telemetry, say) still fails', async () => {
  const { item } = await run(neverSmaller([], { other: 'telemetry-mismatch' }), { keepLarger: true });
  assert.equal(item.state, 'failed');
  assert.equal(item.failure?.code, 'telemetry-mismatch');
});

test('the job store keeps the setting only without a size target', async () => {
  const h = createHarness({ clips: 1, devices: [CPU], defaultDevice: null, gpuDecode: false, works: (e) => e.startsWith('lib'), verifier: neverSmaller([]) });
  try {
    const sized = await h.service.start(h.config({ profileId: 'balanced', bitrateKbps: undefined, keepLarger: true }));
    assert.equal('keepLarger' in (await h.finishJob(sized)).config, false, 'a size profile does not store it');
    await assert.rejects(() => h.service.start(h.config({ profileId: 'quality', qualityLevel: 'balanced', bitrateKbps: undefined, keepLarger: 'yes' })));
  } finally {
    await h.close();
  }
});

test('IPC: only constant quality and custom bitrate may turn it on', async () => {
  const { registerConverterIpc } = require('../src/main/converter/ipc');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-keeplarger-ipc-'));
  for (const name of ['source', 'out']) fs.mkdirSync(path.join(dir, name));
  const handlers = new Map();
  const started = [];
  const registration = registerConverterIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    service: { subscribe: () => () => {}, start: async (config) => { started.push(config); return 'job-1'; }, list: async () => [] },
    capabilities: { replacement: 'available' },
    auto: { configure: async (settings) => ({ settings }) }
  });
  const invoke = (name, payload) => handlers.get(`converter:${name}`)({ sender: null }, payload);
  const config = (over = {}) => ({
    sourceRoot: path.join(dir, 'source'), destinationRoot: path.join(dir, 'out'), codec: 'h265', profileId: 'quality', qualityLevel: 'balanced',
    networkMode: 'direct', outputMode: 'separate', includedGroups: ['RecentClips'], replacementConfirmed: false, ...over
  });
  try {
    assert.equal((await invoke('start', config({ keepLarger: true }))).ok, true);
    assert.equal(started.at(-1).keepLarger, true);
    assert.equal((await invoke('start', (({ qualityLevel, ...c }) => c)(config({ profileId: 'custom', bitrateKbps: 2500, keepLarger: true })))).ok, true);
    for (const bad of [config({ keepLarger: 'true' }), (({ qualityLevel, ...c }) => c)(config({ profileId: 'balanced', keepLarger: true }))]) {
      assert.equal((await invoke('start', bad)).error?.code, 'INVALID_KEEP_LARGER', JSON.stringify(bad));
    }
  } finally {
    registration.unregister();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifier: not smaller fails without the option; with it, ok and marked; never for a size profile', async () => {
  const { verifyCandidate } = require('../src/main/converter/verifier');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-keeplarger-verify-'));
  const source = path.join(dir, 'source.mp4');
  const bigger = path.join(dir, 'bigger.mp4');
  fs.writeFileSync(source, Buffer.alloc(1_000_000, 1));
  fs.writeFileSync(bigger, Buffer.alloc(1_000_500, 3));
  const never = async () => { throw new Error('not used'); };
  const verify = (extra) => verifyCandidate({ source, candidate: bigger, codec: 'h265', profileId: 'quality', runFfprobe: never, runFullDecode: never, verifyMode: 'off', ...extra });
  const cleanup = (r) => { if (r?.publicationArtifact?.path) fs.rmSync(path.dirname(r.publicationArtifact.path), { recursive: true, force: true }); };
  try {
    const off = await verify({});
    cleanup(off);
    assert.equal(off.reason, 'not-smaller');
    const on = await verify({ allowLarger: true });
    cleanup(on);
    assert.equal(on.ok, true, JSON.stringify(on));
    assert.deepEqual([on.details.larger, on.details.largerBytes], [true, 500]);
    const sized = await verify({ allowLarger: true, profileId: 'balanced' });
    cleanup(sized);
    assert.equal(sized.reason, 'not-smaller');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
