'use strict';

// The Encoder benchmark tries every parallel level up to 8, even when going
// higher stops helping, and gives every slot a clip of its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { runConverterBenchmark } = require('../src/main/converter/benchmark');

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-bench-'));
  const clip = path.join(dir, '2026-10-20_17-00-00-front.mp4');
  await fsp.writeFile(clip, 'clip');
  return { dir, clips: [{ sourcePath: clip, name: path.basename(clip) }] };
}

test('every level up to 8 runs, with a clip of its own for each slot', async () => {
  const { dir, clips } = await setup();
  const seen = [];
  try {
    const out = await runConverterBenchmark({
      clips, tempRoot: dir, countFrames: async () => 100,
      runLevel: async ({ level, sourceRoot }) => {
        const names = fs.readdirSync(path.join(sourceRoot, 'RecentClips'));
        const inodes = new Set(names.map((n) => fs.statSync(path.join(sourceRoot, 'RecentClips', n)).ino));
        seen.push({ level, names, inodes: inodes.size });
        // no faster after 2: the old benchmark stopped at 4
        return { items: names.map((n) => ({ state: 'completed', relativePath: `RecentClips/${n}` })) };
      }
    });
    assert.deepEqual(out.results.map((r) => r.level), [1, 2, 4, 6, 8]);
    assert.deepEqual(seen.map((s) => s.names.length), [2, 2, 4, 6, 8]);
    for (const s of seen) {
      assert.equal(s.inodes, s.names.length, `level ${s.level}: separate files`);
      assert.ok(s.names.every((n) => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-front\.mp4$/.test(n)), 'Tesla-style names');
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a level that fails ends the sweep there', async () => {
  const { dir, clips } = await setup();
  try {
    const out = await runConverterBenchmark({
      clips, tempRoot: dir, countFrames: async () => 100,
      runLevel: async ({ level, sourceRoot }) => ({
        items: fs.readdirSync(path.join(sourceRoot, 'RecentClips')).map((n) => ({ state: level >= 6 ? 'failed' : 'completed', relativePath: `RecentClips/${n}` }))
      })
    });
    assert.deepEqual(out.results.map((r) => [r.level, r.ok]), [[1, true], [2, true], [4, true], [6, false]]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a clip that fails verification on its own is left out, not the whole benchmark', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-bench-'));
  const clips = [];
  for (const cam of ['front', 'back', 'left_repeater']) {
    const clip = path.join(dir, `2026-10-20_17-00-00-${cam}.mp4`);
    await fsp.writeFile(clip, cam);
    clips.push({ sourcePath: clip, name: path.basename(clip) });
  }
  try {
    const out = await runConverterBenchmark({
      clips, tempRoot: dir, countFrames: async () => 100,
      runLevel: async ({ sourceRoot }) => ({
        // the back camera clip (and copies made from it) never verifies
        items: fs.readdirSync(path.join(sourceRoot, 'RecentClips')).map((n) => {
          const back = fs.readFileSync(path.join(sourceRoot, 'RecentClips', n), 'utf8') === 'back';
          return back
            ? { state: 'failed', relativePath: `RecentClips/${n}`, failure: { code: 'duration-mismatch' } }
            : { state: 'completed', relativePath: `RecentClips/${n}` };
        })
      })
    });
    assert.deepEqual(out.results.map((r) => [r.level, r.ok]), [[1, true], [2, true], [4, true], [6, true], [8, true]]);
    assert.deepEqual(out.skipped, [{ name: '2026-10-20_17-00-00-back.mp4', code: 'duration-mismatch' }]);
    assert.equal(out.clips, 2);
    assert.ok(out.best, 'a recommendation from the clips that work');
    assert.ok(out.results.every((r) => !('failedItems' in r)), 'internal bookkeeping stays inside');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('when the only clip fails on its own, the benchmark says why', async () => {
  const { dir, clips } = await setup();
  try {
    const out = await runConverterBenchmark({
      clips, tempRoot: dir, countFrames: async () => 100,
      runLevel: async ({ sourceRoot }) => ({
        items: fs.readdirSync(path.join(sourceRoot, 'RecentClips')).map((n) => ({ state: 'failed', relativePath: `RecentClips/${n}`, failure: { code: 'duration-mismatch' } }))
      })
    });
    assert.deepEqual(out.results.map((r) => [r.level, r.ok, r.failures]), [[1, false, ['duration-mismatch']]]);
    assert.equal(out.best, null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a clip that only fails when many run at once is kept: the level is the limit', async () => {
  const { dir, clips } = await setup();
  try {
    const out = await runConverterBenchmark({
      clips, tempRoot: dir, countFrames: async () => 100,
      runLevel: async ({ level, sourceRoot }) => ({
        items: fs.readdirSync(path.join(sourceRoot, 'RecentClips')).map((n) => (level >= 6
          ? { state: 'failed', relativePath: `RecentClips/${n}`, failure: { code: 'decode-failed' } }
          : { state: 'completed', relativePath: `RecentClips/${n}` }))
      })
    });
    assert.deepEqual(out.results.map((r) => [r.level, r.ok]), [[1, true], [2, true], [4, true], [6, false]]);
    assert.deepEqual(out.skipped, []);
    assert.equal(out.clips, 1);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// A power meter that reads the energy of each level run from a table, in the
// order the levels run, the way the server's stats engine would report it.
function fakeMeter(readings) {
  const calls = { started: 0, stopped: [] };
  return {
    calls,
    start: () => { calls.started += 1; return `token-${calls.started}`; },
    stop: (token) => {
      calls.stopped.push(token);
      const reading = readings[Number(token.slice(6)) - 1];
      if (reading instanceof Error) throw reading;
      return reading === undefined ? null : reading;
    }
  };
}

// Level runs that take a set time each (a fake clock), all clips completed.
function timedLevels(secondsByLevel) {
  let clock = 0;
  return {
    now: () => clock,
    runLevel: async ({ level, sourceRoot }) => {
      clock += secondsByLevel[level] * 1000;
      return { items: fs.readdirSync(path.join(sourceRoot, 'RecentClips')).map((n) => ({ state: 'completed', relativePath: `RecentClips/${n}` })) };
    }
  };
}

test('with a power meter every level shows its energy; the most efficient is picked beside the fastest', async () => {
  const { dir, clips } = await setup();
  try {
    // files per minute 12, 24, 30, 40, 48: the fastest is 8 at once
    const { now, runLevel } = timedLevels({ 1: 10, 2: 5, 4: 8, 6: 9, 8: 10 });
    // files per Wh 10, 20, 25, 20, 16: the most efficient is 4 at once
    const meter = fakeMeter([{ wh: 0.2, avgW: 72 }, { wh: 0.1, avgW: 72 }, { wh: 0.16, avgW: 72 }, { wh: 0.3, avgW: 120 }, { wh: 0.5, avgW: 180 }]);
    const out = await runConverterBenchmark({ clips, tempRoot: dir, countFrames: async () => 100, now, runLevel, powerMeter: meter });
    assert.deepEqual(out.results.map((r) => [r.level, r.wh, r.avgW, r.filesPerWh]), [
      [1, 0.2, 72, 10], [2, 0.1, 72, 20], [4, 0.16, 72, 25], [6, 0.3, 120, 20], [8, 0.5, 180, 16]
    ]);
    assert.equal(out.best.level, 8, 'best stays the fastest');
    assert.equal(out.efficient.level, 4);
    assert.equal(meter.calls.started, 5);
    assert.deepEqual(meter.calls.stopped, ['token-1', 'token-2', 'token-3', 'token-4', 'token-5']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('no efficient pick unless every level has energy; a meter that fails never fails the benchmark', async () => {
  const { dir, clips } = await setup();
  try {
    const { now, runLevel } = timedLevels({ 1: 10, 2: 5, 4: 8, 6: 9, 8: 10 });
    // level 6 could not be measured, level 8's reading failed
    const meter = fakeMeter([{ wh: 0.2, avgW: 72 }, { wh: 0.1, avgW: 72 }, { wh: 0.16, avgW: 72 }, null, new Error('sensor gone')]);
    const out = await runConverterBenchmark({ clips, tempRoot: dir, countFrames: async () => 100, now, runLevel, powerMeter: meter });
    assert.deepEqual(out.results.map((r) => [r.level, r.ok, r.filesPerWh]), [[1, true, 10], [2, true, 20], [4, true, 25], [6, true, null], [8, true, null]]);
    assert.equal(out.efficient, null);
    assert.equal(out.best.level, 8);

    // no meter at all: the same results as before, with empty energy fields
    const plain = await runConverterBenchmark({ clips, tempRoot: dir, countFrames: async () => 100, ...timedLevels({ 1: 10, 2: 5, 4: 8, 6: 9, 8: 10 }) });
    assert.ok(plain.results.every((r) => r.wh === null && r.avgW === null && r.filesPerWh === null));
    assert.equal(plain.efficient, null);
    // a meter whose start fails: no numbers either
    const broken = await runConverterBenchmark({
      clips, tempRoot: dir, countFrames: async () => 100, ...timedLevels({ 1: 10, 2: 5, 4: 8, 6: 9, 8: 10 }),
      powerMeter: { start: () => { throw new Error('no RAPL'); }, stop: () => ({ wh: 1, avgW: 1 }) }
    });
    assert.equal(broken.results.length, 5);
    assert.ok(broken.results.every((r) => r.wh === null));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the meter is stopped when a level is cancelled', async () => {
  const { dir, clips } = await setup();
  try {
    const meter = fakeMeter([{ wh: 0.1, avgW: 50 }, { wh: 0.1, avgW: 50 }]);
    await assert.rejects(runConverterBenchmark({
      clips, tempRoot: dir, countFrames: async () => 100, powerMeter: meter,
      runLevel: async ({ level, sourceRoot }) => {
        if (level === 2) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
        return { items: fs.readdirSync(path.join(sourceRoot, 'RecentClips')).map((n) => ({ state: 'completed', relativePath: `RecentClips/${n}` })) };
      }
    }), { code: 'CANCELLED' });
    assert.deepEqual(meter.calls.stopped, ['token-1', 'token-2']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

const hasFfmpeg = require('child_process').spawnSync('ffmpeg', ['-version']).status === 0;

test('the runtime hands its power meter to the benchmark', { skip: !hasFfmpeg && 'needs ffmpeg', timeout: 120_000 }, async () => {
  const { createConverterRuntime } = require('../src/main/converter/runtime');
  const { createTeslaH264Fixture } = require('./fixtures/ffmpegFixtures');
  const { spawn } = require('child_process');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-bench-rt-'));
  try {
    const footage = path.join(dir, 'footage', 'TeslaCam', 'RecentClips');
    await fsp.mkdir(footage, { recursive: true });
    for (const name of ['data', 'temp']) await fsp.mkdir(path.join(dir, name));
    await createTeslaH264Fixture({
      ffmpegPath: 'ffmpeg', outputPath: path.join(footage, '2026-10-20_17-00-00-front.mp4'), durationSeconds: 1, frameRate: 12,
      size: '160x120', telemetryPattern: Array.from({ length: 12 }, (_, n) => Buffer.from([0x20, n]))
    });
    // Every level (and verification mode) "converts" its clips at once; the
    // meter reads less energy per clip at 2 at once.
    const fakeService = () => {
      const started = new Map();
      return {
        start: async (config) => { const id = `job-${started.size + 1}`; started.set(id, config); return id; },
        whenIdle: async (id) => ({
          items: fs.readdirSync(path.join(started.get(id).sourceRoot, 'RecentClips'))
            .map((n) => ({ state: 'completed', relativePath: `RecentClips/${n}`, sourceBytes: 100, outputBytes: 50 }))
        }),
        cancel: async () => {}, shutdown: async () => {}, list: async () => [], subscribe: () => () => {}, activeEncodes: () => []
      };
    };
    let level = 0;
    const perLevel = [0.2, 0.05, 0.4, 0.6, 0.8];
    const powerMeter = {
      start: () => level++,
      stop: (token) => ({ wh: perLevel[token] ?? 0.1, avgW: 10 })
    };
    const runtime = await createConverterRuntime({
      userDataPath: await fsp.realpath(path.join(dir, 'data')), tempPath: await fsp.realpath(path.join(dir, 'temp')),
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', spawn, autoConvert: false, powerMeter,
      factories: { createConverterJobService: fakeService }
    });
    try {
      const out = await runtime.runBenchmark({ codecs: ['h265'], sourceRoot: path.join(dir, 'footage', 'TeslaCam') });
      const run = out.codecs[0];
      assert.equal(run.error, undefined, `benchmark ran (${run.error})`);
      assert.deepEqual(run.results.map((r) => [r.level, r.wh]), [[1, 0.2], [2, 0.05], [4, 0.4], [6, 0.6], [8, 0.8]]);
      assert.equal(run.efficient.level, 2);
      assert.ok(run.verifyComparison.every((r) => r.wh === 0.1), 'the verification comparison runs are metered too');
    } finally {
      await runtime.shutdown();
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// A mostly converted archive: thousands of H.265 clips are scanned first, and
// the one original left is the newest, in another folder. The benchmark still finds it.
test('the benchmark finds the originals left anywhere in a mostly converted archive', { skip: !hasFfmpeg && 'needs ffmpeg', timeout: 180_000 }, async () => {
  const { createConverterRuntime } = require('../src/main/converter/runtime');
  const { createTeslaH264Fixture } = require('./fixtures/ffmpegFixtures');
  const { spawn, spawnSync } = require('child_process');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-bench-deep-'));
  try {
    const tesla = path.join(dir, 'footage', 'TeslaCam');
    // SavedClips is scanned first: it holds the converted clips
    const saved = path.join(tesla, 'SavedClips', '2026-01-01_00-00-00');
    const recent = path.join(tesla, 'RecentClips');
    await fsp.mkdir(saved, { recursive: true });
    await fsp.mkdir(recent, { recursive: true });
    for (const name of ['data', 'temp']) await fsp.mkdir(path.join(dir, name));
    const original = path.join(recent, '2026-10-24_09-00-00-front.mp4');
    await createTeslaH264Fixture({
      ffmpegPath: 'ffmpeg', outputPath: original, durationSeconds: 1, frameRate: 12,
      size: '160x120', telemetryPattern: Array.from({ length: 12 }, (_, n) => Buffer.from([0x20, n]))
    });
    const hevc = path.join(dir, 'converted.mp4');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-i', original, '-c:v', 'libx265', '-x265-params', 'log-level=none', '-tag:v', 'hvc1', hevc]).status, 0);
    // 4,200 converted clips (hard links of one), all older than the original
    for (let n = 0; n < 4200; n++) {
      const t = new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
      fs.linkSync(hevc, path.join(saved, `${t}-front.mp4`));
    }
    let seenSource = null;
    const fakeService = () => {
      const started = new Map();
      return {
        start: async (config) => { const id = `job-${started.size + 1}`; started.set(id, config); seenSource = config.sourceRoot; return id; },
        whenIdle: async (id) => ({
          items: fs.readdirSync(path.join(started.get(id).sourceRoot, 'RecentClips'))
            .map((n) => ({ state: 'completed', relativePath: `RecentClips/${n}`, sourceBytes: 100, outputBytes: 50 }))
        }),
        cancel: async () => {}, shutdown: async () => {}, list: async () => [], subscribe: () => () => {}, activeEncodes: () => []
      };
    };
    const runtime = await createConverterRuntime({
      userDataPath: await fsp.realpath(path.join(dir, 'data')), tempPath: await fsp.realpath(path.join(dir, 'temp')),
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', spawn, autoConvert: false,
      factories: { createConverterJobService: fakeService }
    });
    try {
      const out = await runtime.runBenchmark({ codecs: ['h265'], sourceRoot: tesla });
      assert.equal(out.codecs[0].error, undefined, `benchmark ran (${out.codecs[0].error})`);
      assert.ok(seenSource, 'the benchmark ran its levels');
    } finally {
      await runtime.shutdown();
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
