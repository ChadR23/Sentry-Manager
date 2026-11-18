'use strict';

// Encoding per vehicle: settings saved for a vehicle without automatic
// conversion, the converter channels that save them (validated like a
// manual start), and the plain words every interface shows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAutoConverter } = require('../src/main/converter/autoConvert');
const { registerConverterIpc, CHANNELS } = require('../src/main/converter/ipc');
const words = require('../web/vehicleEncoding');

const shared = { intervalMinutes: 60, window: null, holdManual: false, keepRunning: false, openAtLogin: false };
const config = (sourceRoot, over = {}) => ({ sourceRoot, destinationRoot: null, codec: 'h265', profileId: 'balanced', networkMode: 'auto', outputMode: 'replace',
  includedGroups: ['RecentClips'], replacementConfirmed: true, concurrency: 2, verifyMode: 'quick', ...over });

function autoSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-veh-enc-'));
  const service = { start: async () => 'job', get: async () => null, list: async () => [], pause: async () => {}, resume: async () => {} };
  const scanner = async function* () {};
  const make = () => createAutoConverter({ service, scanner, fs: fs.promises, directory: dir, timers: { setInterval: () => null, clearInterval: () => {} } });
  return { dir, make };
}

test('saved without automatic conversion: kept, survives a restart, never converts', async () => {
  const { dir, make } = autoSetup();
  try {
    const auto = make();
    await auto.start();
    let state = await auto.saveVehicle(config('/cars/y', { codec: 'av1' }));
    assert.deepEqual(state.saved.map((c) => [c.sourceRoot, c.codec]), [['/cars/y', 'av1']]);
    assert.equal(state.settings.enabled, false, 'saving is not turning automatic on');
    assert.deepEqual(state.settings.configs, []);
    // saved again: replaced, not added
    state = await auto.saveVehicle(config('/cars/y', { codec: 'h265' }));
    assert.deepEqual(state.saved.map((c) => c.codec), ['h265']);
    auto.stop();
    const again = make();
    await again.start();
    assert.deepEqual(again.getState().saved.map((c) => [c.sourceRoot, c.codec]), [['/cars/y', 'h265']]);
    state = await again.forgetVehicle('/cars/y');
    assert.deepEqual(state.saved, []);
    again.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('automatic on moves a vehicle out of saved; turning it off keeps its settings', async () => {
  const { dir, make } = autoSetup();
  try {
    const auto = make();
    await auto.start();
    await auto.saveVehicle(config('/cars/a', { codec: 'av1' }));
    let state = await auto.configure({ ...shared, enabled: true, config: config('/cars/a') });
    assert.deepEqual(state.saved, [], 'one place per vehicle');
    assert.deepEqual(state.settings.configs.map((c) => c.sourceRoot), ['/cars/a']);
    // saving a vehicle that converts automatically updates its automatic settings
    state = await auto.saveVehicle(config('/cars/a', { verifyMode: 'full' }));
    assert.equal(state.settings.configs[0].verifyMode, 'full');
    assert.deepEqual(state.saved, []);
    state = await auto.configure({ ...shared, enabled: false, removeSource: '/cars/a' });
    assert.deepEqual(state.settings.configs, []);
    assert.deepEqual(state.saved.map((c) => [c.sourceRoot, c.verifyMode]), [['/cars/a', 'full']]);
    auto.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function ipcSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-veh-ipc-'));
  for (const name of ['source', 'out']) fs.mkdirSync(path.join(dir, name));
  const handlers = new Map();
  const calls = { save: [], forget: [] };
  const registration = registerConverterIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    service: { subscribe: () => () => {}, list: async () => [] },
    capabilities: { replacement: 'available' },
    auto: {
      saveVehicle: async (c) => { calls.save.push(c); return { saved: [c] }; },
      forgetVehicle: async (root) => { calls.forget.push(root); return { saved: [] }; }
    }
  });
  const invoke = (name, payload) => handlers.get(`converter:${name}`)({ sender: null }, payload);
  const src = path.join(dir, 'source');
  return { dir, invoke, calls, src, close: () => { registration.unregister(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('IPC saveVehicle: the same validation as a start', async () => {
  assert.ok(CHANNELS.includes('converter:saveVehicle') && CHANNELS.includes('converter:forgetVehicle'));
  const h = ipcSetup();
  try {
    let out = await h.invoke('saveVehicle', { config: config(h.src) });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(h.calls.save[0].sourceRoot, fs.realpathSync(h.src));
    // replacing originals without the confirmation is refused
    out = await h.invoke('saveVehicle', { config: config(h.src, { replacementConfirmed: false }) });
    assert.equal(out.error.code, 'REPLACEMENT_CONFIRMATION_REQUIRED');
    // replacing never without checks: Off becomes Quick
    out = await h.invoke('saveVehicle', { config: config(h.src, { verifyMode: 'off' }) });
    assert.equal(h.calls.save.at(-1).verifyMode, 'quick');
    // a separate folder inside the footage is refused
    out = await h.invoke('saveVehicle', { config: config(h.src, { outputMode: 'separate', replacementConfirmed: false, destinationRoot: path.join(h.src, 'x') }) });
    assert.equal(out.error.code, 'PATH_OVERLAP');
    for (const bad of [{ config: config(h.src), extra: 1 }, { config: { ...config(h.src), surprise: true } }, null, { config: config(h.src, { profileId: 'custom' }) }]) {
      out = await h.invoke('saveVehicle', bad);
      assert.equal(out.ok, false, JSON.stringify(bad));
    }
    assert.equal(h.calls.save.length, 2, 'nothing refused was saved');
    out = await h.invoke('forgetVehicle', { forgetSource: '/gone/share' });
    assert.equal(out.ok, true);
    assert.deepEqual(h.calls.forget, ['/gone/share']);
    for (const bad of [{}, { forgetSource: '' }, { forgetSource: 3 }, { forgetSource: '/a', more: 1 }]) assert.equal((await h.invoke('forgetVehicle', bad)).error.code, 'INVALID_REQUEST');
  } finally {
    h.close();
  }
});

test('the web bridge checks the folders of saveVehicle and clamps its verification', async () => {
  const { createConverterBridge } = require('../server/converterBridge');
  const seen = [];
  const runtime = {
    service: { subscribe: () => () => {}, list: async () => [] }, capabilities: { replacement: 'available' }, runBenchmark: async () => ({}), cancelBenchmark: () => {},
    auto: { saveVehicle: async (c) => { seen.push(c); return { saved: [c] }; }, forgetVehicle: async () => ({ saved: [] }) }
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-veh-bridge-'));
  try {
    const bridge = createConverterBridge({ runtime, resolvePath: async (p) => (p.startsWith(dir) ? fs.realpathSync(p) : null) });
    assert.ok(bridge.channels.includes('converter:saveVehicle'));
    assert.equal((await bridge.invoke('saveVehicle', { config: config('/etc') })).error.code, 'PATH_NOT_ALLOWED');
    const out = await bridge.invoke('saveVehicle', { config: config(dir, { verifyMode: 'off' }) });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(seen[0].verifyMode, 'quick');
    // forgetting never needs the share to be there
    assert.equal((await bridge.invoke('forgetVehicle', { forgetSource: '/gone' })).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plain words for a vehicle\'s settings', () => {
  assert.equal(words.summary(config('/a')), 'H.265 · Balanced · Replace · Quick');
  assert.equal(words.summary(config('/a', { codec: 'av1', profileId: 'quality', qualityLevel: 'high', outputMode: 'separate', destinationRoot: '/o', verifyMode: 'full' })), 'AV1 · Quality High · Separate · Full');
  assert.equal(words.summary(config('/a', { profileId: 'custom', bitrateKbps: 4500, verifyMode: 'off' })), 'H.265 · 4.5 Mbps · Replace · Quick', 'replacing is never unchecked');
  const rows = Object.fromEntries(words.describe({ config: config('/a', { lanes: [{ device: 'cpu', concurrency: 2 }, { device: 'node:n1@gpu0', concurrency: 1 }], keepOffTarget: true }), automatic: true },
    { intervalMinutes: 180, window: { startHour: 1, endHour: 6 } }, [{ id: 'node:n1@gpu0', name: 'Arc A380 on garage' }]));
  assert.equal(rows.Size, 'Balanced — about 20% smaller');
  assert.match(rows['Keep clips that miss the target'], /^On/);
  assert.equal(rows.Devices, 'CPU: 2 at once · Arc A380 on garage: 1 at once');
  assert.equal(rows['Automatic conversion'], 'On — checks for new clips every 3 hours, only from 01:00 to 06:00');
  assert.equal(rows['Clip groups and order'], 'Recent drives');
  const quality = Object.fromEntries(words.describe({ config: config('/a', { profileId: 'quality', qualityLevel: 'small' }), automatic: false }, {}, []));
  assert.equal('Keep clips that miss the target' in quality, false, 'no size target, no row');
  assert.match(quality['Automatic conversion'], /^Off/);
  // Smallest (CPU only): no size target, this server's CPU (lanes it carries are not used)
  assert.equal(words.summary(config('/a', { profileId: 'smallest' })), 'H.265 · Smallest (CPU only) · Replace · Quick');
  const smallest = Object.fromEntries(words.describe({ config: config('/a', { profileId: 'smallest', concurrency: 2, lanes: [{ device: 'cpu', concurrency: 2 }] }), automatic: false }, {}, []));
  assert.match(smallest.Size, /^Smallest \(CPU only\): x265 with B-frames/);
  assert.equal(smallest.Devices, 'This server’s CPU, 2 clips at once');
  assert.equal('Keep clips that miss the target' in smallest, false);
  assert.match(smallest['Always convert'], /^Off/);
  const state = { settings: { configs: [config('/a')] }, saved: [config('/b', { codec: 'av1' })] };
  assert.equal(words.savedFor(state, '/a').automatic, true);
  assert.equal(words.savedFor(state, '/b').config.codec, 'av1');
  assert.equal(words.savedFor(state, '/c'), null);
});
