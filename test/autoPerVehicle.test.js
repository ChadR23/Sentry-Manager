'use strict';

// Automatic conversion per vehicle: each vehicle's folder has its own saved
// settings and its own on/off. One round checks every automatic folder in
// turn and converts one job at a time; a folder whose share is down never
// stops the others; turning one off leaves the rest as they are.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAutoConverter } = require('../src/main/converter/autoConvert');

const config = (sourceRoot, codec = 'h265') => ({ sourceRoot, destinationRoot: null, codec, profileId: 'balanced', networkMode: 'direct', outputMode: 'replace',
  includedGroups: ['RecentClips'], replacementConfirmed: true, concurrency: 2, verifyMode: 'quick' });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-auto-cars-'));
  const jobs = new Map();
  const started = [];
  const clips = { '/cars/a': 2, '/cars/b': 0, '/cars/c': 3 };
  const down = new Set();
  const service = {
    start: async (cfg) => {
      const id = `job-${started.length + 1}`;
      started.push({ id, sourceRoot: cfg.sourceRoot, codec: cfg.codec, auto: cfg.autoConvert });
      jobs.set(id, { id, state: 'encoding', config: cfg, items: [] });
      return id;
    },
    get: async (id) => jobs.get(id) || null,
    list: async () => [...jobs.values()],
    pause: async () => {}, resume: async () => {}
  };
  const scanner = async function* (cfg) {
    if (down.has(cfg.sourceRoot)) throw Object.assign(new Error('down'), { code: 'SOURCE_UNAVAILABLE' });
    for (let n = 0; n < (clips[cfg.sourceRoot] || 0); n++) yield { relativePath: `RecentClips/${n}.mp4`, sourceBytes: 100, mtimeMs: 1 };
  };
  const finish = (id) => { jobs.get(id).state = 'completed'; };
  const auto = createAutoConverter({ service, scanner, fs: fs.promises, directory: dir, timers: { setInterval: () => null, clearInterval: () => {} } });
  return { dir, auto, started, finish, down, clips };
}

const shared = { intervalMinutes: 60, window: null, holdManual: false, keepRunning: false, openAtLogin: false };

test('each vehicle keeps its own settings; one round converts them one after another', async () => {
  const { dir, auto, started, finish } = setup();
  try {
    await auto.configure({ ...shared, enabled: true, config: config('/cars/a', 'h265') });
    await auto.configure({ ...shared, enabled: true, config: config('/cars/b', 'av1') });
    await auto.configure({ ...shared, enabled: true, config: config('/cars/c', 'av1') });
    assert.deepEqual(auto.getState().settings.configs.map((c) => [c.sourceRoot, c.codec]), [['/cars/a', 'h265'], ['/cars/b', 'av1'], ['/cars/c', 'av1']]);
    await auto.tick();
    assert.deepEqual(started.map((j) => [j.sourceRoot, j.codec, j.auto]), [['/cars/a', 'h265', true]]);
    assert.equal(auto.getState().status.activeSource, '/cars/a');
    await auto.tick(); // still converting car A: nothing else starts
    assert.equal(started.length, 1);
    finish('job-1');
    await auto.tick(); // car B has nothing new, car C is next
    assert.deepEqual(started.map((j) => j.sourceRoot), ['/cars/a', '/cars/c']);
    assert.equal(started[1].codec, 'av1', 'car C with its own settings');
    assert.equal(auto.getState().status.sources['/cars/b'].lastNewFiles, 0);
    finish('job-2');
    await auto.tick(); // round done: the next one waits for the schedule
    assert.equal(started.length, 2);
    assert.ok(auto.getState().status.nextCheckAt > Date.now());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a vehicle whose share is down does not stop the others; turning one off keeps the rest', async () => {
  const { dir, auto, started, down } = setup();
  try {
    down.add('/cars/a');
    await auto.configure({ ...shared, enabled: true, config: config('/cars/a') });
    await auto.configure({ ...shared, enabled: true, config: config('/cars/c') });
    await auto.tick();
    assert.deepEqual(started.map((j) => j.sourceRoot), ['/cars/c']);
    assert.equal(auto.getState().status.sources['/cars/a'].error, 'SOURCE_UNAVAILABLE');

    await auto.configure({ ...shared, enabled: false, removeSource: '/cars/a' });
    assert.deepEqual(auto.getState().settings.configs.map((c) => c.sourceRoot), ['/cars/c']);
    assert.equal(auto.getState().settings.enabled, true);
    // changing only the shared schedule from a vehicle that is off changes no vehicle
    await auto.configure({ ...shared, intervalMinutes: 180, enabled: false });
    assert.deepEqual(auto.getState().settings.configs.map((c) => c.sourceRoot), ['/cars/c']);
    assert.equal(auto.getState().settings.intervalMinutes, 180);
    await auto.configure({ ...shared, enabled: false, removeSource: '/cars/c' });
    assert.equal(auto.getState().settings.enabled, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings saved before there was one per vehicle become that vehicle\'s', async () => {
  const { dir } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ...shared, enabled: true, config: config('/cars/a') }));
    const auto = createAutoConverter({ service: { list: async () => [], get: async () => null }, scanner: async function* () {}, fs: fs.promises, directory: dir, timers: { setInterval: () => null, clearInterval: () => {} } });
    await auto.start();
    auto.stop();
    assert.deepEqual(auto.getState().settings.configs.map((c) => c.sourceRoot), ['/cars/a']);
    assert.equal(auto.getState().settings.enabled, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
