'use strict';

// Vehicles first, per node: automatic conversion runs a job per vehicle at
// once, each on devices of its own. A node converts for the first vehicle on
// its list that has new clips; with none waiting it helps the others, and it
// goes back to its vehicle when that one has new clips again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAutoConverter, planLanes } = require('../src/main/converter/autoConvert');
const { createHarness, until, ARC, UHD, CPU } = require('./fixtures/lanesHarness');

const GPU = 'pci:0000:03:00.0';
const N2 = 'node:aaaaaaaaaaaa';
const N3 = 'node:bbbbbbbbbbbb';
const devices = [{ id: GPU, kind: 'gpu' }, { id: N2, kind: 'node', online: true, slots: 2 }, { id: N3, kind: 'node', online: true, slots: 3 }];
const car = (name, lanes) => ({ sourceRoot: `/cars/${name}`, destinationRoot: null, codec: 'h265', profileId: 'balanced', networkMode: 'direct', outputMode: 'replace',
  includedGroups: ['RecentClips'], replacementConfirmed: true, concurrency: 2, verifyMode: 'quick', ...(lanes ? { lanes } : {}) });

test('planning: a node serves the first vehicle on its list, else helps the one on this server\'s GPU', () => {
  const a = car('a', [{ device: GPU, concurrency: 2 }, { device: N2, concurrency: 2 }]);
  const b = car('b', [{ device: GPU, concurrency: 1 }]);
  const cars = [a, b];
  // node 2 lists car b: b gets it (at the node's slots), a keeps the GPU
  let plan = planLanes({ cars, wanting: new Set(['/cars/a', '/cars/b']), localHolder: '/cars/a', devices, priorities: { [N2]: ['/cars/b'] } });
  assert.deepEqual(plan.get('/cars/a'), [{ device: GPU, concurrency: 2 }]);
  assert.deepEqual(plan.get('/cars/b'), [{ device: N2, concurrency: 2 }]);
  // car b has nothing new: node 2 helps car a
  plan = planLanes({ cars, wanting: new Set(['/cars/a']), localHolder: '/cars/a', devices, priorities: { [N2]: ['/cars/b'] } });
  assert.deepEqual(plan.get('/cars/a'), [{ device: GPU, concurrency: 2 }, { device: N2, concurrency: 2 }]);
  // a node no vehicle lists and no vehicle's settings use stays out
  assert.equal(plan.get('/cars/a').some((lane) => lane.device === N3), false);
  // an offline node is given to nobody
  plan = planLanes({ cars, wanting: new Set(['/cars/b']), localHolder: null, devices: [{ id: N2, kind: 'node', online: false }], priorities: { [N2]: ['/cars/b'] } });
  assert.deepEqual(plan.get('/cars/b'), []);
});

function fakeService() {
  const jobs = new Map();
  const log = [];
  return {
    jobs, log,
    start: async (config) => {
      for (const job of jobs.values()) {
        if (job.state === 'completed' || job.state === 'paused') continue;
        if (job.config.sourceRoot === config.sourceRoot || job.config.lanes.some((l) => config.lanes.some((m) => m.device === l.device))) {
          throw Object.assign(new Error('busy'), { code: 'JOB_ACTIVE' });
        }
      }
      const id = `job-${jobs.size + 1}`;
      jobs.set(id, { id, state: 'encoding', config: { ...config }, items: [] });
      log.push(['start', path.basename(config.sourceRoot), config.lanes.map((l) => l.device)]);
      return id;
    },
    setLanes: async (id, lanes) => { jobs.get(id).config.lanes = lanes; log.push(['lanes', path.basename(jobs.get(id).config.sourceRoot), lanes.map((l) => l.device)]); },
    pause: async (id) => { jobs.get(id).state = 'paused'; log.push(['pause', path.basename(jobs.get(id).config.sourceRoot)]); },
    resume: async (id) => { jobs.get(id).state = 'encoding'; log.push(['resume', path.basename(jobs.get(id).config.sourceRoot)]); },
    get: async (id) => jobs.get(id) || null,
    list: async () => [...jobs.values()]
  };
}

test('a node goes back to its vehicle when that vehicle has new clips, and helps the others meanwhile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-node-cars-'));
  try {
    const service = fakeService();
    const clips = { '/cars/a': 5, '/cars/b': 3 };
    const scanner = async function* (config) {
      for (let n = 0; n < clips[config.sourceRoot]; n++) yield { relativePath: `RecentClips/${n}.mp4`, sourceBytes: 1, mtimeMs: 1 };
    };
    const auto = createAutoConverter({
      service, scanner, fs: fs.promises, directory: dir, timers: { setInterval: () => null, clearInterval: () => {} },
      devices: async () => devices, nodePriorities: async () => ({ [N2]: ['/cars/b'] })
    });
    const shared = { intervalMinutes: 60, window: null, holdManual: false, keepRunning: false, openAtLogin: false };
    // (both turned on together)
    await auto.configure({ ...shared, configs: [car('a', [{ device: GPU, concurrency: 2 }, { device: N2, concurrency: 2 }]), car('b', [{ device: GPU, concurrency: 1 }])] });
    await auto.tick();
    // both at once: car a on this server's GPU, car b on node 2 (its list)
    assert.deepEqual(service.log.filter(([k]) => k === 'start'), [['start', 'a', [GPU]], ['start', 'b', [N2]]]);
    assert.deepEqual(Object.keys(auto.getState().status.active).sort(), ['/cars/a', '/cars/b']);

    // car b is done: node 2 helps car a
    service.jobs.get('job-2').state = 'completed';
    clips['/cars/b'] = 0;
    await auto.tick();
    assert.deepEqual(service.log.at(-1), ['lanes', 'a', [GPU, N2]]);

    // new clips for car b: node 2 leaves car a and goes back to car b
    clips['/cars/b'] = 4;
    await auto.checkNow();
    const tail = service.log.slice(-2);
    assert.deepEqual(tail, [['lanes', 'a', [GPU]], ['start', 'b', [N2]]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a vehicle whose only device goes to the vehicle it belongs to waits, then carries on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-node-wait-'));
  try {
    const service = fakeService();
    const clips = { '/cars/a': 5, '/cars/b': 0 };
    const scanner = async function* (config) {
      for (let n = 0; n < clips[config.sourceRoot]; n++) yield { relativePath: `RecentClips/${n}.mp4`, sourceBytes: 1, mtimeMs: 1 };
    };
    const auto = createAutoConverter({
      service, scanner, fs: fs.promises, directory: dir, timers: { setInterval: () => null, clearInterval: () => {} },
      devices: async () => [{ id: N2, kind: 'node', online: true, slots: 1 }], nodePriorities: async () => ({ [N2]: ['/cars/b'] })
    });
    const shared = { intervalMinutes: 60, window: null, holdManual: false, keepRunning: false, openAtLogin: false };
    await auto.configure({ ...shared, configs: [car('a', [{ device: N2, concurrency: 1 }]), car('b', [{ device: N2, concurrency: 1 }])] });
    await auto.tick();
    assert.deepEqual(service.log, [['start', 'a', [N2]]]);
    clips['/cars/b'] = 2;
    await auto.checkNow();
    assert.deepEqual(service.log.slice(1), [['pause', 'a'], ['start', 'b', [N2]]]);
    assert.equal(auto.getState().status.active['/cars/a'].pausedForDevices, true);
    service.jobs.get('job-2').state = 'completed';
    clips['/cars/b'] = 0;
    await auto.tick();
    assert.deepEqual(service.log.slice(-1), [['resume', 'a']]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the job service runs automatic jobs for two vehicles at once only on separate devices', async () => {
  const h = createHarness({ clips: 2, behave: () => 'hold', devices: [ARC, UHD] });
  try {
    const a = await h.service.start(h.config({ sourceRoot: path.join(h.dir, 'car-a'), autoConvert: true, lanes: [{ device: ARC.id, concurrency: 1 }] }));
    const b = await h.service.start(h.config({ sourceRoot: path.join(h.dir, 'car-b'), autoConvert: true, lanes: [{ device: UHD.id, concurrency: 1 }] }));
    assert.notEqual(a, b);
    // the same GPU, or a job started by hand: one at a time as always
    await assert.rejects(h.service.start(h.config({ sourceRoot: path.join(h.dir, 'car-c'), autoConvert: true, lanes: [{ device: ARC.id, concurrency: 1 }] })), { code: 'JOB_ACTIVE' });
    await assert.rejects(h.service.start(h.config({ sourceRoot: path.join(h.dir, 'car-c'), lanes: [{ device: 'renderD130', concurrency: 1 }] })), { code: 'JOB_ACTIVE' });
    for (let i = 0; i < 100 && (!h.running()[ARC.id] || !h.running()[UHD.id]); i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(h.running(), { [ARC.id]: 1, [UHD.id]: 1 }, 'both vehicles encode at the same time');
    const [ja, jb] = await Promise.all([h.finishJob(a), h.finishJob(b)]);
    assert.equal(ja.state, 'completed');
    assert.equal(jb.state, 'completed');
  } finally {
    await h.close();
  }
});

test('a node\'s clips coming back are encoded here two at a time, however many were sent ahead', async () => {
  const { EventEmitter } = require('events');
  const NODE = { id: 'node:abcdefabcdef', kind: 'node', name: 'pc (node)', encoders: { h265: 'hevc_nvenc', av1: null }, online: true };
  const { CPU } = require('./fixtures/lanesHarness');
  let most = 0;
  const h = createHarness({
    clips: 12, devices: [NODE, CPU], defaultDevice: null, gpuDecode: false,
    behave: () => 'hold',
    remoteEncode: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() => child.emit('close', 1, null)); // the node gives every clip back
      return child;
    }
  });
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: NODE.id, concurrency: 1 }] }));
    let done = false;
    const idle = h.service.whenIdle(id).then(() => { done = true; });
    for (let i = 0; i < 500 && !done; i++) {
      await new Promise((r) => setTimeout(r, 10));
      most = Math.max(most, h.held().length);
      if (i % 5 === 4) h.held()[0]?.finish(0);
    }
    await idle;
    assert.ok(most >= 1 && most <= 2, `at most two encodes here at once (${most})`);
  } finally {
    await h.close();
  }
});

test('two vehicles whose folders are one inside the other never convert at once', async () => {
  const h = createHarness({ clips: 1, behave: () => 'hold', devices: [ARC, UHD] });
  try {
    await h.service.start(h.config({ sourceRoot: path.join(h.dir, 'car'), autoConvert: true, lanes: [{ device: ARC.id, concurrency: 1 }] }));
    await assert.rejects(h.service.start(h.config({ sourceRoot: path.join(h.dir, 'car', 'TeslaCam'), autoConvert: true, lanes: [{ device: UHD.id, concurrency: 1 }] })), { code: 'JOB_ACTIVE' });
    h.releaseAll();
  } finally {
    await h.close();
  }
});

test('a node\'s clips are checked here a few at a time (its number + 2), however many were sent ahead', async () => {
  const { EventEmitter } = require('events');
  const NODE = { id: 'node:abcdefabcdef', kind: 'node', name: 'mini (node)', encoders: { h265: 'hevc_vaapi', av1: null }, online: true };
  let checking = 0;
  let most = 0;
  const h = createHarness({
    clips: 20, devices: [NODE], defaultDevice: null, gpuDecode: false,
    remoteEncode: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
      setTimeout(() => { child.stdout.emit('data', 'out_time_us=1\nprogress=end\n'); child.emit('close', 0, null); }, 20);
      return child;
    },
    // the check of each clip takes a while (decoding both files)
    comparePicture: async () => {
      checking += 1;
      most = Math.max(most, checking);
      await new Promise((r) => setTimeout(r, 40));
      checking -= 1;
      return { ok: true };
    }
  });
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: NODE.id, concurrency: 2 }] }));
    const job = await h.finishJob(id, 30_000);
    assert.equal(job.items.filter((item) => item.resultCode === 'converted').length, 20);
    assert.ok(most <= 2 + 2, `${most} clips checked at once (the node's 2, + 2)`);
    // and the time breakdown shows the picture check and the wait for it apart from Verify
    assert.ok(job.timings.totalMs.picture >= 20 * 35, `picture check time recorded (${job.timings.totalMs.picture} ms)`);
    assert.ok(Number.isSafeInteger(job.timings.totalMs.checkWait), 'the wait for it too');
  } finally {
    await h.close();
  }
});

test('a node lane set higher than the node\'s own setting sends and checks only for what the node takes', async () => {
  const { EventEmitter } = require('events');
  const NODE = { id: 'node:abcdefabcdef', kind: 'node', name: 'mini (node)', encoders: { h265: 'hevc_vaapi', av1: null }, online: true, slots: 2 };
  let inFlight = 0;
  let mostSent = 0;
  let checking = 0;
  let mostChecked = 0;
  const h = createHarness({
    clips: 40, devices: [NODE], defaultDevice: null, gpuDecode: false,
    remoteEncode: () => {
      inFlight += 1;
      mostSent = Math.max(mostSent, inFlight);
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
      setTimeout(() => { inFlight -= 1; child.stdout.emit('data', 'out_time_us=1\nprogress=end\n'); child.emit('close', 0, null); }, 60);
      return child;
    },
    comparePicture: async () => {
      checking += 1;
      mostChecked = Math.max(mostChecked, checking);
      await new Promise((r) => setTimeout(r, 20));
      checking -= 1;
      return { ok: true };
    }
  });
  try {
    // the lane says 10; the node itself converts 2 at once
    const id = await h.service.start(h.config({ lanes: [{ device: NODE.id, concurrency: 10 }] }));
    await h.finishJob(id, 30_000);
    assert.ok(mostSent <= 2 + 15, `${mostSent} sent at once (2 converting + 15 waiting at most)`);
    assert.ok(mostChecked <= 2 + 2, `${mostChecked} checked at once`);
  } finally {
    await h.close();
  }
});

test('a node\'s row under Parallel conversions tells the node how many to convert at once (at most 8)', async () => {
  const { EventEmitter } = require('events');
  for (const [row, expected] of [[4, 4], [10, 8]]) {
    const NODE = { id: 'node:abcdefabcdef', kind: 'node', name: 'mini (node)', encoders: { h265: 'hevc_vaapi', av1: null }, online: true, slots: 2 };
    const told = [];
    let checking = 0;
    let mostChecked = 0;
    const h = createHarness({
      clips: 30, devices: [NODE], defaultDevice: null, gpuDecode: false,
      setNodeSlots: async (id, slots) => { told.push([id, slots]); NODE.slots = slots; },
      remoteEncode: () => {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
        setTimeout(() => { child.stdout.emit('data', 'out_time_us=1\nprogress=end\n'); child.emit('close', 0, null); }, 30);
        return child;
      },
      comparePicture: async () => {
        checking += 1;
        mostChecked = Math.max(mostChecked, checking);
        await new Promise((r) => setTimeout(r, 30));
        checking -= 1;
        return { ok: true };
      }
    });
    try {
      const id = await h.service.start(h.config({ lanes: [{ device: NODE.id, concurrency: row }] }));
      await h.finishJob(id, 30_000);
      assert.deepEqual(told[0], [NODE.id, expected], `row ${row}: the node is told ${expected}`);
      assert.ok(mostChecked <= expected + 2, `row ${row}: ${mostChecked} checked at once`);
    } finally {
      await h.close();
    }
  }
});

test('clips waiting in a node\'s queue are reported apart from the clips converting', async () => {
  const { EventEmitter } = require('events');
  const NODE = { id: 'node:abcdefabcdef', kind: 'node', name: 'mini (node)', encoders: { h265: 'hevc_vaapi', av1: null }, online: true, slots: 1 };
  let turn = 0;
  const h = createHarness({
    clips: 8, devices: [NODE], defaultDevice: null, gpuDecode: false,
    remoteEncode: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
      // each clip waits on the node a while (one at a time), then converts
      const wait = 30 + 40 * turn++;
      const tick = setInterval(() => child.stdout.emit('data', 'queued=1\n'), 10);
      setTimeout(() => {
        clearInterval(tick);
        child.stdout.emit('data', 'out_time_us=1000\nprogress=continue\n');
        setTimeout(() => { child.stdout.emit('data', 'out_time_us=2000\nprogress=end\n'); child.emit('close', 0, null); }, 20);
      }, wait);
      return child;
    },
    comparePicture: async () => ({ ok: true })
  });
  const seen = [];
  const off = h.service.subscribe((event) => { if (event.type === 'progress' && Number.isSafeInteger(event.progress?.waitingOnNode)) seen.push(event.progress.waitingOnNode); });
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: NODE.id, concurrency: 1 }] }));
    await h.finishJob(id, 30_000);
    assert.ok(Math.max(...seen) >= 3, `several clips reported waiting on the node (${Math.max(...seen)})`);
    assert.equal(seen.at(-1), 0, 'none waiting at the end');
    // and the page gets the number (the progress filter lets it through)
    const { sanitizeLiveProgress } = require('../src/main/converter/ipc')._test || {};
    if (sanitizeLiveProgress) assert.equal(sanitizeLiveProgress({ phase: 'continue', waitingOnNode: 5 }).waitingOnNode, 5);
  } finally {
    off();
    await h.close();
  }
});

test('a node set to Off in a vehicle\'s Encoder rows stays off for it, even with that vehicle first on its list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-node-off-'));
  try {
    const service = fakeService();
    const scanner = async function* () {
      for (let n = 0; n < 5; n++) yield { relativePath: `RecentClips/${n}.mp4`, sourceBytes: 1, mtimeMs: 1 };
    };
    const auto = createAutoConverter({
      service, scanner, fs: fs.promises, directory: dir, timers: { setInterval: () => null, clearInterval: () => {} },
      devices: async () => devices, nodePriorities: async () => ({ [N2]: ['/cars/chad'] })
    });
    const shared = { intervalMinutes: 60, window: null, holdManual: false, keepRunning: false, openAtLogin: false };
    await auto.configure({ ...shared, enabled: true, config: car('chad', [{ device: GPU, concurrency: 2 }, { device: N2, concurrency: 2 }]) });
    await auto.tick();
    assert.deepEqual(service.log.at(-1), ['start', 'chad', [GPU, N2]]);

    // the owner turns the node's row to Off during the run
    await service.setLanes('job-1', [{ device: GPU, concurrency: 2 }]);
    await auto.setLanes([{ device: GPU, concurrency: 2 }], '/cars/chad');
    assert.deepEqual(auto.getState().settings.configs[0].nodesOff, [N2, N3]);
    for (let i = 0; i < 3; i++) await auto.tick();
    assert.deepEqual(service.jobs.get('job-1').config.lanes, [{ device: GPU, concurrency: 2 }], 'not put back');
    assert.equal(service.log.filter(([k, , lanes]) => k === 'lanes' && lanes.includes(N2)).length, 0);

    // and back on: it helps again, and the Off is forgotten
    await auto.setLanes([{ device: GPU, concurrency: 2 }, { device: N2, concurrency: 1 }], '/cars/chad');
    assert.deepEqual(auto.getState().settings.configs[0].nodesOff, [N3]);
    await auto.tick();
    assert.deepEqual(service.jobs.get('job-1').config.lanes.map((l) => l.device), [GPU, N2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('planning: a node is not given to a vehicle that set it to Off, but still helps the others', () => {
  const a = { ...car('a', [{ device: GPU, concurrency: 2 }]), nodesOff: [N2] };
  const b = car('b', [{ device: N2, concurrency: 1 }]);
  const plan = planLanes({ cars: [a, b], wanting: new Set(['/cars/a', '/cars/b']), localHolder: '/cars/a', devices, priorities: { [N2]: ['/cars/a', '/cars/b'] } });
  assert.deepEqual(plan.get('/cars/a'), [{ device: GPU, concurrency: 2 }]);
  assert.deepEqual(plan.get('/cars/b'), [{ device: N2, concurrency: 1 }]);
});

test('a node\'s row set to Off takes back the clips waiting in its queue; they are converted here, none fails', async () => {
  const { EventEmitter } = require('events');
  const NODE = { id: 'node:abcdefabcdef', kind: 'node', name: 'mini (node)', encoders: { h265: 'hevc_vaapi', av1: null }, online: true, slots: 1 };
  let sent = 0;
  let killed = 0;
  let releaseFirst = null;
  const h = createHarness({
    clips: 12, devices: [NODE, CPU], defaultDevice: null, gpuDecode: false,
    remoteEncode: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      const first = sent++ === 0;
      let tick = null;
      child.kill = (signal = 'SIGTERM') => { killed += 1; clearInterval(tick); setImmediate(() => child.emit('close', null, signal)); return true; };
      if (first) {
        // the clip the node converts: it finishes when the test says so
        child.stdout.emit('data', 'out_time_us=1000\nprogress=continue\n');
        releaseFirst = () => { child.stdout.emit('data', 'out_time_us=2000\nprogress=end\n'); child.emit('close', 0, null); };
      } else {
        // the others wait in the node's queue until taken back
        tick = setInterval(() => child.stdout.emit('data', 'queued=1\n'), 10);
        setImmediate(() => child.stdout.emit('data', 'queued=1\n'));
      }
      return child;
    },
    comparePicture: async () => ({ ok: true })
  });
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: NODE.id, concurrency: 1 }, { device: 'cpu', concurrency: 1 }] }));
    // the node has its clip and several waiting
    for (let i = 0; i < 200 && h.service.activeEncodes().filter((e) => e.waitingOnNode).length < 5; i++) await new Promise((r) => setTimeout(r, 20));
    const waiting = h.service.activeEncodes().filter((e) => e.waitingOnNode).length;
    assert.ok(waiting >= 5, `clips waiting on the node (${waiting})`);
    // the owner sets the node's row to Off
    await h.service.setLanes(id, [{ device: 'cpu', concurrency: 1 }]);
    for (let i = 0; i < 100 && h.service.activeEncodes().some((e) => e.waitingOnNode); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.service.activeEncodes().filter((e) => e.waitingOnNode).length, 0, 'none left waiting on the node');
    assert.ok(killed >= waiting, `the waiting clips were taken back (${killed} of ${waiting})`);
    const sentBefore = sent;
    releaseFirst();
    const job = await h.finishJob(id, 30_000);
    const videos = job.items.filter((item) => item.kind === 'video');
    assert.equal(sent, sentBefore, 'nothing more sent to the node');
    assert.equal(videos.filter((item) => item.state === 'failed').length, 0, 'none failed');
    assert.equal(videos.filter((item) => item.resultCode === 'converted').length, 12);
    assert.ok(videos.every((item) => (item.attempts || 0) <= 1), 'a clip taken back is not counted as a try');
  } finally {
    await h.close();
  }
});

test('with several vehicles on automatic, a row changed during a run is saved for that vehicle, not another', async () => {
  const { createConverterRuntime } = require('../src/main/converter/runtime');
  const fsp = fs.promises;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-auto-rows-'));
  try {
    for (const name of ['data', 'temp', 'chad/TeslaCam', 'bingbong/TeslaCam']) await fsp.mkdir(path.join(dir, name), { recursive: true });
    const fakeService = () => ({
      start: async () => 'job-1', list: async () => [], get: async () => null, subscribe: () => () => {},
      activeEncodes: () => [], cancel: async () => {}, shutdown: async () => {}
    });
    const runtime = await createConverterRuntime({
      userDataPath: await fsp.realpath(path.join(dir, 'data')), tempPath: await fsp.realpath(path.join(dir, 'temp')),
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', spawn: require('child_process').spawn, autoConvert: false,
      factories: { createConverterJobService: fakeService }
    });
    try {
      const chad = path.join(dir, 'chad', 'TeslaCam');
      const bingbong = path.join(dir, 'bingbong', 'TeslaCam');
      const shared = { intervalMinutes: 60, window: null, holdManual: false, keepRunning: false, openAtLogin: false };
      const lanes = (n) => [{ device: GPU, concurrency: 1 }, { device: N2, concurrency: n }];
      await runtime.auto.configure({ ...shared, configs: [{ ...car('chad', lanes(2)), sourceRoot: chad }, { ...car('bingbong', lanes(2)), sourceRoot: bingbong }] });
      // the second vehicle's row for the node goes to Off (its folder is passed on)
      await runtime.auto.setLanes([{ device: GPU, concurrency: 1 }], bingbong);
      const saved = Object.fromEntries(runtime.auto.get().settings.configs.map((c) => [path.basename(path.dirname(c.sourceRoot)), c.lanes]));
      assert.deepEqual(saved.bingbong, [{ device: GPU, concurrency: 1 }], 'saved for the vehicle whose row changed');
      assert.deepEqual(saved.chad, lanes(2), 'the other vehicle keeps its own');
      await runtime.auto.setConcurrency(3, chad);
      assert.equal(runtime.auto.get().settings.configs.find((c) => c.sourceRoot === chad).concurrency, 3);
    } finally {
      await runtime.shutdown();
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('originals are read no more than two at a time, however many clips a node takes ahead', async () => {
  const { EventEmitter } = require('events');
  const NODE = { id: 'node:abcdefabcdef', kind: 'node', name: 'mini (node)', encoders: { h265: 'hevc_vaapi', av1: null }, online: true, slots: 2 };
  let reading = 0;
  let most = 0;
  const h = createHarness({
    clips: 20, devices: [NODE, CPU], defaultDevice: null, gpuDecode: false,
    // copying each original takes a while (the share's hard disks)
    stageSource: async ({ source, itemId }) => {
      reading += 1;
      most = Math.max(most, reading);
      await new Promise((r) => setTimeout(r, 30));
      reading -= 1;
      return { stagedSource: source, path: source, ownedPaths: null, ownedArtifacts: null, itemId };
    },
    remoteEncode: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
      setTimeout(() => { child.stdout.emit('data', 'out_time_us=1\nprogress=end\n'); child.emit('close', 0, null); }, 20);
      return child;
    },
    comparePicture: async () => ({ ok: true })
  });
  try {
    const id = await h.service.start(h.config({ networkMode: 'staging', lanes: [{ device: NODE.id, concurrency: 2 }, { device: 'cpu', concurrency: 1 }] }));
    const job = await h.finishJob(id, 30_000);
    assert.equal(job.items.filter((item) => item.resultCode === 'converted').length, 20);
    assert.ok(most >= 1 && most <= 2, `${most} originals read at once`);
  } finally {
    await h.close();
  }
});

test('a node marked trusted: its clips skip the picture check; another node\'s still get it', async () => {
  const { EventEmitter } = require('events');
  const MINE = { id: 'node:aaaaaaaaaaaa', kind: 'node', name: 'mini (node)', encoders: { h265: 'hevc_vaapi', av1: null }, online: true, slots: 1 };
  const OTHER = { id: 'node:bbbbbbbbbbbb', kind: 'node', name: 'other (node)', encoders: { h265: 'hevc_nvenc', av1: null }, online: true, slots: 1 };
  const checked = [];
  const sentTo = new Map();
  const h = createHarness({
    clips: 40, devices: [MINE, OTHER], defaultDevice: null, gpuDecode: false,
    remoteEncode: ({ device, target }) => {
      sentTo.set(target, device.id);
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
      setTimeout(() => { child.stdout.emit('data', 'out_time_us=1\nprogress=end\n'); child.emit('close', 0, null); }, 10);
      return child;
    },
    comparePicture: async ({ candidate }) => { checked.push(sentTo.get(candidate)); return { ok: true }; },
    nodeTrusted: (id) => id === MINE.id
  });
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: MINE.id, concurrency: 1 }, { device: OTHER.id, concurrency: 1 }] }));
    const job = await h.finishJob(id, 30_000);
    assert.equal(job.items.filter((item) => item.resultCode === 'converted').length, 40);
    const used = new Set(sentTo.values());
    assert.ok(used.has(MINE.id) && used.has(OTHER.id), `both nodes converted clips (${[...used].join(', ')}; checked ${checked.join(', ')})`);
    assert.ok(checked.length > 0 && checked.every((node) => node === OTHER.id), `only the other node's clips checked (${checked.join(', ')})`);
  } finally {
    await h.close();
  }
});

test('a vehicle with a node set to Off still starts its automatic jobs (the Off stays out of the job)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-node-off-start-'));
  try {
    const service = fakeService();
    // the real job store refuses a config field it does not know
    const start = service.start;
    service.start = async (config) => {
      if ('nodesOff' in config) throw Object.assign(new Error('invalid'), { code: 'INVALID_MANIFEST' });
      return start(config);
    };
    const scanner = async function* () { yield { relativePath: 'RecentClips/0.mp4', sourceBytes: 1, mtimeMs: 1 }; };
    const auto = createAutoConverter({
      service, scanner, fs: fs.promises, directory: dir, timers: { setInterval: () => null, clearInterval: () => {} },
      devices: async () => devices, nodePriorities: async () => ({})
    });
    const shared = { intervalMinutes: 60, window: null, holdManual: false, keepRunning: false, openAtLogin: false };
    // saved with the nodes' rows at Off: the vehicle's settings remember it
    await auto.configure({ ...shared, enabled: true, config: car('chad', [{ device: GPU, concurrency: 2 }]) });
    assert.deepEqual(auto.getState().settings.configs[0].nodesOff, [N2, N3]);
    await auto.tick();
    assert.deepEqual(service.log.filter(([k]) => k === 'start'), [['start', 'chad', [GPU]]], 'the job started');
    assert.equal('nodesOff' in service.jobs.get('job-1').config, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a node clip whose picture check is cut short by a shutdown is not called a mismatch', async () => {
  const { EventEmitter } = require('events');
  const NODE = { id: 'node:abcdefabcdef', kind: 'node', name: 'mini (node)', encoders: { h265: 'hevc_vaapi', av1: null }, online: true, slots: 2 };
  let inCheck = 0;
  const h = createHarness({
    clips: 20, devices: [NODE, CPU], defaultDevice: null, gpuDecode: false,
    remoteEncode: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
      setTimeout(() => { child.stdout.emit('data', 'out_time_us=1\nprogress=end\n'); child.emit('close', 0, null); }, 20);
      return child;
    },
    // the decode is killed by the shutdown, as ffmpeg's is
    comparePicture: ({ signal }) => new Promise((resolve) => {
      inCheck += 1;
      const done = () => resolve({ ok: false, reason: 'decode-failed', detail: 'DECODE_FAILED' });
      if (signal?.aborted) return done();
      signal?.addEventListener('abort', done, { once: true });
    })
  });
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => { warned.push(args.join(' ')); };
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: NODE.id, concurrency: 2 }, { device: 'cpu', concurrency: 1 }] }));
    for (let i = 0; i < 200 && inCheck < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(inCheck >= 2, 'clips were in their picture check');
    await h.service.shutdown();
    assert.equal(warned.filter((line) => line.includes('does not show the original')).length, 0, warned.join('\n'));
    const job = await h.store.load(id);
    assert.equal(job.items.filter((item) => item.state === 'failed').length, 0, 'none failed');
  } finally {
    console.warn = warn;
    await h.close();
  }
});

test('a node encode that fails verification is encoded here instead, not failed', async () => {
  const { EventEmitter } = require('events');
  const NODE = { id: 'node:abcdefabcdef', kind: 'node', name: 'mini (node)', encoders: { h265: 'hevc_vaapi', av1: null }, online: true, slots: 1 };
  const fromNode = new Set();
  let rejected = 0;
  const h = createHarness({
    clips: 4, devices: [NODE, CPU], defaultDevice: null, gpuDecode: false,
    remoteEncode: ({ target }) => {
      fromNode.add(target);
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
      setTimeout(() => { child.stdout.emit('data', 'out_time_us=1\nprogress=end\n'); child.emit('close', 0, null); }, 10);
      return child;
    },
    comparePicture: async () => ({ ok: true }),
    nodeTrusted: () => true,
    // every file the node sends back is cut off
    verifier: async ({ candidate }) => {
      if (fromNode.delete(candidate)) {
        rejected += 1;
        return { ok: false, reason: 'probe-failed', details: { target: 'candidate', kind: 'invalid-runner-result' } };
      }
      return { ok: true, outputBytes: 1_000_000, publicationArtifact: null };
    }
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: NODE.id, concurrency: 1 }] }));
    const job = await h.finishJob(id, 30_000);
    const videos = job.items.filter((item) => item.kind === 'video');
    assert.ok(rejected >= 1, 'the node\'s files were rejected');
    assert.equal(videos.filter((item) => item.state === 'failed').length, 0, 'none failed');
    assert.equal(videos.filter((item) => item.resultCode === 'converted').length, 4, 'all converted here');
  } finally {
    console.warn = warn;
    await h.close();
  }
});

test('a cancelled job waiting for its turn to read originals does not hold up another job', async () => {
  let entered = 0;
  const h = createHarness({
    clips: 4, devices: [ARC, UHD, CPU], gpuDecode: false,
    stageSource: async ({ source, itemId, signal }) => {
      entered += 1;
      if (source.includes('job1')) {
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'CANCELLED' })), { once: true });
        });
      }
      return { stagedSource: source, path: source, ownedPaths: null, ownedArtifacts: null, itemId };
    }
  });
  try {
    const id1 = await h.service.start(h.config({ sourceRoot: path.join(h.dir, 'job1'), destinationRoot: path.join(h.dir, 'out1'), networkMode: 'staging', autoConvert: true, lanes: [{ device: ARC.id, concurrency: 4 }] }));
    assert.ok(await until(() => entered === 2), 'job 1 reads two clips (the limit)');
    await new Promise((r) => setTimeout(r, 100)); // its two other workers wait for a turn
    const id2 = await h.service.start(h.config({ sourceRoot: path.join(h.dir, 'job2'), destinationRoot: path.join(h.dir, 'out2'), networkMode: 'staging', autoConvert: true, lanes: [{ device: UHD.id, concurrency: 1 }] }));
    await new Promise((r) => setTimeout(r, 100)); // job 2 waits behind them
    assert.equal(entered, 2);
    await h.service.cancel(id1);
    await h.service.whenIdle(id1);
    assert.ok(await until(() => entered > 2, 3000), `job 2 never got its turn (state ${(await h.service.get(id2)).state})`);
  } finally {
    await h.close();
  }
});

test('a row changed while the nodes cannot be listed keeps the vehicle\'s Off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-node-off-keep-'));
  try {
    let listing = true;
    const auto = createAutoConverter({
      service: fakeService(), scanner: async function* () {}, fs: fs.promises, directory: dir, timers: { setInterval: () => null, clearInterval: () => {} },
      devices: async () => { if (!listing) throw new Error('a node is slow to answer'); return devices; }, nodePriorities: async () => ({})
    });
    const shared = { intervalMinutes: 60, window: null, holdManual: false, keepRunning: false, openAtLogin: false };
    await auto.configure({ ...shared, enabled: true, config: car('chad', [{ device: GPU, concurrency: 2 }]) });
    assert.deepEqual(auto.getState().settings.configs[0].nodesOff, [N2, N3]);
    listing = false;
    await auto.setLanes([{ device: GPU, concurrency: 1 }], '/cars/chad');
    assert.deepEqual(auto.getState().settings.configs[0].lanes, [{ device: GPU, concurrency: 1 }], 'the row change is saved');
    assert.deepEqual(auto.getState().settings.configs[0].nodesOff, [N2, N3], 'and the Off is kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- a node that lists its GPUs and its CPU: one lane per device, while
// everything that is the node's own (its Vehicles first list, Off per
// vehicle, what it is sent ahead, its checks here) stays per node

const NODE_KEY = 'node:cccccccccccc';
const NODE_GPU = { id: `${NODE_KEY}@pci:0000:01:00.0`, kind: 'node', nodeId: 'cccccccccccc', nodeName: 'Garage PC', deviceName: 'NVIDIA GeForce RTX 4070', name: 'Garage PC · NVIDIA GeForce RTX 4070', isDefault: true, encoders: { h265: 'hevc_nvenc', av1: 'av1_nvenc' }, online: true, slots: 2 };
const NODE_CPU = { id: `${NODE_KEY}@cpu`, kind: 'node', nodeId: 'cccccccccccc', nodeName: 'Garage PC', deviceName: 'CPU (software encoder)', name: 'Garage PC · CPU (software encoder)', isDefault: false, encoders: { h265: 'libx265', av1: 'libsvtav1' }, online: true, slots: 0 };

test('planning with a node\'s devices: the node goes to one vehicle as a whole, with that vehicle\'s rows for each device', () => {
  const nodeDevices = [{ id: GPU, kind: 'gpu' }, NODE_GPU, NODE_CPU];
  const a = car('a', [{ device: GPU, concurrency: 2 }, { device: NODE_GPU.id, concurrency: 2 }, { device: NODE_CPU.id, concurrency: 1 }]);
  const b = car('b', [{ device: GPU, concurrency: 1 }]);
  // first on its list: b gets the whole node (b has no rows of its own on
  // it: its default device, at what it converts there now); a gets none of it
  let plan = planLanes({ cars: [a, b], wanting: new Set(['/cars/a', '/cars/b']), localHolder: '/cars/a', devices: nodeDevices, priorities: { [NODE_KEY]: ['/cars/b'] } });
  assert.deepEqual(plan.get('/cars/b'), [{ device: NODE_GPU.id, concurrency: 2 }]);
  assert.deepEqual(plan.get('/cars/a'), [{ device: GPU, concurrency: 2 }]);
  // b has nothing new: the node helps a, on both of a's rows for it
  plan = planLanes({ cars: [a, b], wanting: new Set(['/cars/a']), localHolder: '/cars/a', devices: nodeDevices, priorities: { [NODE_KEY]: ['/cars/b'] } });
  assert.deepEqual(plan.get('/cars/a'), [{ device: GPU, concurrency: 2 }, { device: NODE_GPU.id, concurrency: 2 }, { device: NODE_CPU.id, concurrency: 1 }]);
  // Off for a vehicle is per node: none of its devices goes there
  const off = { ...a, nodesOff: [NODE_KEY] };
  plan = planLanes({ cars: [off, b], wanting: new Set(['/cars/a']), localHolder: '/cars/a', devices: nodeDevices, priorities: { [NODE_KEY]: ['/cars/a'] } });
  assert.deepEqual(plan.get('/cars/a'), [{ device: GPU, concurrency: 2 }]);
  // a vehicle saved with the whole node ('node:<id>', before nodes listed
  // their GPUs) gets the node's default device at that number
  const old = car('old', [{ device: GPU, concurrency: 1 }, { device: NODE_KEY, concurrency: 3 }]);
  plan = planLanes({ cars: [old], wanting: new Set(['/cars/old']), localHolder: '/cars/old', devices: nodeDevices, priorities: {} });
  assert.deepEqual(plan.get('/cars/old'), [{ device: GPU, concurrency: 1 }, { device: NODE_GPU.id, concurrency: 3 }]);
  // offline: none of its devices is given out
  plan = planLanes({ cars: [a], wanting: new Set(['/cars/a']), localHolder: '/cars/a', devices: [{ id: GPU, kind: 'gpu' }, { ...NODE_GPU, online: false }, { ...NODE_CPU, online: false }], priorities: {} });
  assert.deepEqual(plan.get('/cars/a'), [{ device: GPU, concurrency: 2 }]);
});

test('a vehicle\'s Off is per node: on while any of its devices is on, Off once all of them are', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-node-dev-off-'));
  try {
    const service = fakeService();
    const auto = createAutoConverter({
      service, scanner: async function* () {}, fs: fs.promises, directory: dir, timers: { setInterval: () => null, clearInterval: () => {} },
      devices: async () => [{ id: GPU, kind: 'gpu' }, NODE_GPU, NODE_CPU, { id: N2, kind: 'node', online: true }]
    });
    const shared = { intervalMinutes: 60, window: null, holdManual: false, keepRunning: false, openAtLogin: false };
    await auto.configure({ ...shared, enabled: true, config: car('chad', [{ device: GPU, concurrency: 2 }, { device: NODE_GPU.id, concurrency: 1 }]) });
    // only the node's CPU on: the node is not Off (the older node, N2, is)
    await auto.setLanes([{ device: GPU, concurrency: 2 }, { device: NODE_CPU.id, concurrency: 1 }], '/cars/chad');
    assert.deepEqual(auto.getState().settings.configs[0].nodesOff, [N2]);
    // none of its devices: the node is Off, once, as the node
    await auto.setLanes([{ device: GPU, concurrency: 2 }], '/cars/chad');
    assert.deepEqual(auto.getState().settings.configs[0].nodesOff, [NODE_KEY, N2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two devices of one node: told in one request, 15 sent ahead for the node in all, checked here as one node', async () => {
  const { EventEmitter } = require('events');
  const gpu = { ...NODE_GPU };
  const cpu = { ...NODE_CPU };
  const told = [];
  const inFlight = { [gpu.id]: 0, [cpu.id]: 0 };
  const most = { [gpu.id]: 0, [cpu.id]: 0, total: 0 };
  let checking = 0;
  let mostChecked = 0;
  // every encode is held until 3 + 15 are under way (or 10 s pass), then all
  // finish: the most ever sent at once is what the node is given
  const held = [];
  let released = false;
  const release = () => { released = true; for (const end of held.splice(0)) end(); };
  const timer = setTimeout(release, 10_000);
  const h = createHarness({
    clips: 40, devices: [gpu, cpu, CPU], defaultDevice: null, gpuDecode: false,
    setNodeSlots: async (id, slots) => {
      told.push([id, slots]);
      for (const device of [gpu, cpu]) if (Number.isSafeInteger(slots?.[device.id])) device.slots = slots[device.id];
    },
    remoteEncode: ({ device }) => {
      inFlight[device.id] += 1;
      most[device.id] = Math.max(most[device.id], inFlight[device.id]);
      most.total = Math.max(most.total, inFlight[gpu.id] + inFlight[cpu.id]);
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
      const end = () => setTimeout(() => {
        inFlight[device.id] -= 1;
        child.stdout.emit('data', 'out_time_us=1\nprogress=end\n');
        child.emit('close', 0, null);
      }, 5);
      if (released) end(); else held.push(end);
      if (!released && inFlight[gpu.id] + inFlight[cpu.id] >= 3 + 15) release();
      return child;
    },
    comparePicture: async () => {
      checking += 1;
      mostChecked = Math.max(mostChecked, checking);
      await new Promise((r) => setTimeout(r, 15));
      checking -= 1;
      return { ok: true };
    }
  });
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: gpu.id, concurrency: 2 }, { device: cpu.id, concurrency: 1 }] }));
    const job = await h.finishJob(id, 60_000);
    assert.equal(job.items.filter((item) => item.resultCode === 'converted').length, 40);
    assert.deepEqual(told[0], [NODE_KEY, { [gpu.id]: 2, [cpu.id]: 1 }], 'both devices in one request, to the node');
    assert.equal(told.length, 1, 'and not again while nothing changes');
    assert.equal(most.total, 3 + 15, 'the node is sent 15 ahead in all, not 15 per device');
    assert.equal(most[gpu.id], 2 + 10, 'shared by their numbers: 10 for the GPU');
    assert.equal(most[cpu.id], 1 + 5, 'and 5 for the CPU');
    assert.ok(mostChecked <= 3 + 2, `${mostChecked} checked at once (the node's 3 in all, + 2)`);
  } finally {
    clearTimeout(timer);
    await h.close();
  }
});

test('a job saved with the whole node ("node:<id>") converts on the node\'s default device; one naming that device too keeps its own number', async () => {
  const { EventEmitter } = require('events');
  const remote = (sent) => ({ device }) => {
    sent.push(device.id);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    setTimeout(() => { child.stdout.emit('data', 'out_time_us=1\nprogress=end\n'); child.emit('close', 0, null); }, 5);
    return child;
  };
  {
    const sent = [];
    const told = [];
    const h = createHarness({ clips: 4, devices: [{ ...NODE_GPU }, { ...NODE_CPU }, CPU], defaultDevice: null, gpuDecode: false, remoteEncode: remote(sent), comparePicture: async () => ({ ok: true }), setNodeSlots: async (...args) => { told.push(args); } });
    try {
      const id = await h.service.start(h.config({ lanes: [{ device: NODE_KEY, concurrency: 3 }] }));
      const job = await h.finishJob(id);
      assert.equal(job.items.filter((item) => item.resultCode === 'converted').length, 4);
      assert.deepEqual([...new Set(sent)], [NODE_GPU.id], 'every clip went to the node\'s first GPU');
      assert.deepEqual(told[0], [NODE_KEY, { [NODE_GPU.id]: 3 }]);
      assert.deepEqual(job.config.lanes, [{ device: NODE_KEY, concurrency: 3 }], 'the saved job is left as it was');
    } finally {
      await h.close();
    }
  }
  {
    const sent = [];
    const told = [];
    const h = createHarness({ clips: 4, devices: [{ ...NODE_GPU }, { ...NODE_CPU }, CPU], defaultDevice: null, gpuDecode: false, remoteEncode: remote(sent), comparePicture: async () => ({ ok: true }), setNodeSlots: async (...args) => { told.push(args); } });
    try {
      const id = await h.service.start(h.config({ lanes: [{ device: NODE_KEY, concurrency: 3 }, { device: NODE_GPU.id, concurrency: 1 }] }));
      await h.finishJob(id);
      assert.deepEqual(told[0], [NODE_KEY, { [NODE_GPU.id]: 1 }], 'the device\'s own lane counts, the whole-node one is left out');
    } finally {
      await h.close();
    }
  }
});
