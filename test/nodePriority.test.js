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
const { createHarness, ARC, UHD } = require('./fixtures/lanesHarness');

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

test('a node\'s clips are checked here no more at once than the node converts, however many were sent ahead', async () => {
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
    assert.ok(most <= 2, `${most} clips checked at once`);
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
    assert.ok(mostChecked <= 2, `${mostChecked} checked at once`);
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
      assert.ok(mostChecked <= expected, `row ${row}: ${mostChecked} checked at once`);
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
