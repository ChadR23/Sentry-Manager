'use strict';

// Several GPUs, each set by hand: a job's lanes ([{ device, concurrency }])
// give every GPU its own number of conversions at once. Each lane's workers
// encode on their own GPU, the numbers change live, a restart keeps them, a
// GPU that is gone never stalls the job, and a job without lanes (one GPU,
// or none) runs exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeLanes, lanesTotal, DEVICE_ID, LANES, nodeKeyOf, nodeDeviceOf } = require('../src/main/converter/contracts');
const { createJobStore } = require('../src/main/converter/jobStore');
const { createEncoderPlanner } = require('../src/main/converter/encoderPlanner');
const { createHarness, fakeProbe, desktopWorks, gpuOf, until, sleep, recoveryFacts, ARC, UHD, T400, CPU } = require('./fixtures/lanesHarness');

const hold = (args) => (args.includes('pipe:1') ? 'hold' : undefined);
const TAIL = ['-tag:v', 'hvc1', '-fps_mode', 'passthrough', '-start_at_zero', '-avoid_negative_ts', 'make_zero', '-use_editlist', '0'];
const MISSING = 'pci:0000:09:00.0';

function captureWarnings(t) {
  const lines = [];
  t.mock.method(console, 'warn', (...args) => { lines.push(args.join(' ')); });
  return lines;
}

test('lanes: device ids only, 1 to 16 entries, a total of 1 to 64, zeros left out', () => {
  assert.equal(normalizeLanes(undefined), null);
  assert.equal(normalizeLanes(null), null);
  const lanes = normalizeLanes([{ device: ARC.id, concurrency: 3 }, { device: 'cpu', concurrency: 0 }, { device: UHD.id, concurrency: 1 }]);
  assert.deepEqual(lanes, [{ device: ARC.id, concurrency: 3 }, { device: UHD.id, concurrency: 1 }]);
  assert.equal(lanesTotal(lanes), 4);
  assert.equal(LANES.maxEntries, 16);
  assert.ok(DEVICE_ID.test('cpu') && DEVICE_ID.test(ARC.id) && !DEVICE_ID.test('/dev/dri/renderD128') && !DEVICE_ID.test('nvidia0'));
  const sixteen = [{ device: 'cpu', concurrency: 1 }, ...Array.from({ length: 15 }, (_, i) => ({ device: `pci:0000:${String(i + 10).padStart(2, '0')}:00.0`, concurrency: 1 }))];
  assert.equal(normalizeLanes(sixteen).length, 16);
  const bad = [
    [], 'pci:0000:03:00.0', {}, [{ device: ARC.id, concurrency: 0 }],
    [{ device: '/dev/dri/renderD128', concurrency: 1 }], [{ device: 'nvidia0', concurrency: 1 }],
    [{ device: 'PCI:0000:03:00.0', concurrency: 1 }], [{ device: 'pci:0000:03:00.8', concurrency: 1 }],
    [{ device: ARC.id, concurrency: 1.5 }], [{ device: ARC.id, concurrency: -1 }], [{ device: ARC.id, concurrency: 65 }],
    [{ device: ARC.id, concurrency: 40 }, { device: UHD.id, concurrency: 30 }],
    [{ device: ARC.id, concurrency: 1 }, { device: ARC.id, concurrency: 2 }],
    [{ device: ARC.id, concurrency: 1, node: '/dev/dri/renderD129' }], [{ device: ARC.id }],
    [...sixteen, { device: 'pci:0000:30:00.0', concurrency: 1 }]
  ];
  for (const value of bad) assert.throws(() => normalizeLanes(value), { code: 'INVALID_LANES' }, JSON.stringify(value));
});

test('lanes on a node: one per GPU of the node and its CPU, and the whole node of an older version', () => {
  const node = 'node:abcdefabcdef';
  for (const id of [node, `${node}@cpu`, `${node}@pci:0000:01:00.0`]) assert.ok(DEVICE_ID.test(id), id);
  for (const id of ['node:abc', `${node}@`, `${node}@nvidia0`, `${node}@pci:0000:01:00.8`, `${node}@node:bbbbbbbbbbbb`, `${node}@cpu@cpu`, `${node}@CPU`]) {
    assert.equal(DEVICE_ID.test(id), false, id);
  }
  // one node's GPU and CPU are separate lanes; the whole node may sit beside them (a saved job)
  assert.deepEqual(normalizeLanes([{ device: `${node}@pci:0000:01:00.0`, concurrency: 2 }, { device: `${node}@cpu`, concurrency: 1 }, { device: node, concurrency: 1 }]).length, 3);
  // per node: the node of any of its lanes; its own device id
  assert.equal(nodeKeyOf(`${node}@cpu`), node);
  assert.equal(nodeKeyOf(node), node);
  assert.equal(nodeKeyOf('cpu'), null);
  assert.equal(nodeKeyOf(ARC.id), null);
  assert.equal(nodeDeviceOf(`${node}@pci:0000:01:00.0`), 'pci:0000:01:00.0');
  assert.equal(nodeDeviceOf(node), null);
  assert.equal(nodeDeviceOf(`${node}@nvidia0`), null);
});

test('a job keeps its lanes with the total as its concurrency; a malformed saved value still loads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lanes-store-'));
  try {
    const store = createJobStore({ rootDir: dir, fs: fs.promises });
    const h = createHarness();
    const base = { state: 'paused', createdAt: 1, updatedAt: 1, items: [], summary: null, summaryDismissed: false, discoveryComplete: true };
    const job = await store.create({ ...base, config: h.config({ concurrency: 9, lanes: [{ device: ARC.id, concurrency: 3 }, { device: UHD.id, concurrency: 0 }, { device: 'cpu', concurrency: 1 }] }) });
    await h.close();
    assert.deepEqual(job.config.lanes, [{ device: ARC.id, concurrency: 3 }, { device: 'cpu', concurrency: 1 }]);
    assert.equal(job.config.concurrency, 4, 'concurrency is always the total');
    const { lanes: _lanes, ...withoutLanes } = job.config;
    const plain = await store.create({ ...base, config: { ...withoutLanes, concurrency: 2 } });
    assert.equal('lanes' in plain.config, false, 'no lanes: as before');

    // written by something else: lanes this version cannot use are left out
    for (const lanes of [[{ device: '/dev/dri/renderD128', concurrency: 2 }], 'every GPU', [{ device: ARC.id, concurrency: 0 }], { [ARC.id]: 3 }]) {
      const file = path.join(dir, job.id, 'job.json');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      saved.config = { ...saved.config, lanes, concurrency: 3 };
      fs.writeFileSync(file, JSON.stringify(saved));
      const loaded = await createJobStore({ rootDir: dir, fs: fs.promises }).load(job.id);
      assert.ok(loaded, 'still loads');
      assert.equal('lanes' in loaded.config, false);
      assert.equal(loaded.config.concurrency, 3);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('each lane gets its own workers on its own GPU', async () => {
  const h = createHarness({ clips: 12, behave: hold });
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: ARC.id, concurrency: 3 }, { device: UHD.id, concurrency: 1 }] }));
    assert.ok(await until(() => h.held().length === 4), 'four encodes at once');
    await sleep(30);
    assert.equal(h.held().length, 4, 'and no more');
    assert.deepEqual(h.running(), { [ARC.id]: 3, [UHD.id]: 1 });
    const onArc = h.held().filter((entry) => entry.gpu === ARC.node);
    const onUhd = h.held().filter((entry) => entry.gpu === UHD.node);
    assert.equal(onArc.length, 3);
    assert.equal(onUhd.length, 1);
    const args = onArc[0].args;
    assert.deepEqual(args.slice(args.indexOf('-init_hw_device'), args.indexOf('-c:v') + 2),
      ['-init_hw_device', 'qsv=qsvenc:hw_any,child_device=/dev/dri/renderD129', '-c:v', 'hevc_qsv']);
    assert.deepEqual(args.slice(5, 9), ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD129'], 'decoded on the same GPU');
    const live = h.service.activeEncodes();
    assert.ok(live.filter((entry) => entry.deviceId === ARC.id).every((entry) => entry.device === ARC.node && entry.encoder === 'hevc_qsv'));
    assert.ok(live.filter((entry) => entry.deviceId === UHD.id).every((entry) => entry.device === UHD.node));
    const job = await h.service.get(id);
    assert.equal(job.config.concurrency, 4);
    await assert.rejects(h.service.setConcurrency(id, 0), { code: 'INVALID_CONCURRENCY' });
    await assert.rejects(h.service.setLanes(id, [{ device: '/dev/dri/renderD128', concurrency: 1 }]), { code: 'INVALID_LANES' });
    const done = await h.finishJob(id);
    assert.equal(done.state, 'completed');
    assert.equal(done.items.filter((item) => item.state === 'completed').length, 12);
    await assert.rejects(h.service.setLanes(id, [{ device: ARC.id, concurrency: 1 }]), { code: 'JOB_NOT_ACTIVE' });
  } finally {
    await h.close();
  }
});

test('lanes change live: a GPU set higher starts now, one removed finishes its clips first', async () => {
  const h = createHarness({ clips: 24, behave: hold });
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: ARC.id, concurrency: 1 }, { device: UHD.id, concurrency: 1 }] }));
    assert.ok(await until(() => h.held().length === 2));
    let job = await h.service.setLanes(id, [{ device: ARC.id, concurrency: 3 }, { device: UHD.id, concurrency: 1 }]);
    assert.equal(job.config.concurrency, 4);
    assert.ok(await until(() => h.held().length === 4), 'two more on the Arc at once');
    assert.deepEqual(h.running(), { [ARC.id]: 3, [UHD.id]: 1 });

    // the Arc off, the UHD up: nothing running is stopped
    job = await h.service.setLanes(id, [{ device: ARC.id, concurrency: 0 }, { device: UHD.id, concurrency: 2 }]);
    assert.deepEqual(job.config.lanes, [{ device: UHD.id, concurrency: 2 }]);
    assert.equal(job.config.concurrency, 2);
    assert.ok(await until(() => h.held().length === 5));
    assert.deepEqual(h.running(), { [ARC.id]: 3, [UHD.id]: 2 });
    assert.ok(h.spawned.every((entry) => !entry.child.killed), 'no clip was cancelled');
    const arcEncodes = h.encodes().filter((entry) => entry.gpu === ARC.node).length;
    for (const entry of h.held()) entry.finish(0);
    assert.ok(await until(() => h.held().length === 2));
    await sleep(30);
    assert.deepEqual(h.running(), { [UHD.id]: 2 }, 'only the UHD converts now');
    assert.equal(h.encodes().filter((entry) => entry.gpu === ARC.node).length, arcEncodes, 'the Arc took no new clip');

    // down to one on the UHD
    await h.service.setLanes(id, [{ device: UHD.id, concurrency: 1 }]);
    for (const entry of h.held()) entry.finish(0);
    assert.ok(await until(() => h.held().length === 1));
    await sleep(30);
    assert.equal(h.held().length, 1);
    const done = await h.finishJob(id);
    assert.equal(done.state, 'completed');
    assert.equal(done.items.filter((item) => item.state === 'completed').length, 24);
    assert.deepEqual(done.config.lanes, [{ device: UHD.id, concurrency: 1 }], 'kept with the job');
  } finally {
    await h.close();
  }
});

test('setLanes on a job without lanes: the default workers finish their clip, lane workers take over', async () => {
  const h = createHarness({ clips: 12, behave: hold });
  try {
    const id = await h.service.start(h.config({ concurrency: 2 }));
    assert.ok(await until(() => h.held().length === 2));
    assert.deepEqual(h.running(), { default: 2 });
    assert.ok(h.held().every((entry) => entry.gpu === null && !entry.args.includes('-init_hw_device')), 'the default path names no GPU');
    await assert.rejects(h.service.setLanes(id, [{ device: ARC.id, concurrency: 0 }]), { code: 'INVALID_LANES' });
    await h.service.setLanes(id, [{ device: ARC.id, concurrency: 2 }]);
    assert.ok(await until(() => h.held().length === 4));
    assert.deepEqual(h.running(), { default: 2, [ARC.id]: 2 });
    for (const entry of h.held().filter((e) => e.gpu === null)) entry.finish(0);
    for (const entry of h.held().filter((e) => e.gpu === ARC.node)) entry.finish(0);
    assert.ok(await until(() => h.held().length === 2));
    await sleep(30);
    assert.deepEqual(h.running(), { [ARC.id]: 2 });
    const done = await h.finishJob(id);
    assert.equal(done.state, 'completed');
    assert.deepEqual(done.config.lanes, [{ device: ARC.id, concurrency: 2 }]);
  } finally {
    await h.close();
  }
});

test('lanes for the GPU a job without lanes runs on: that GPU never runs more at once than it was set to', async () => {
  const h = createHarness({ clips: 20, behave: hold });
  // encodes on the UHD 770: the default path (no GPU named) or its lane
  const onUhd = () => h.held().filter((entry) => entry.gpu === null || entry.gpu === UHD.node).length;
  try {
    const id = await h.service.start(h.config({ concurrency: 3 }));
    assert.ok(await until(() => h.held().length === 3));
    await h.service.setLanes(id, [{ device: UHD.id, concurrency: 3 }, { device: ARC.id, concurrency: 1 }]);
    assert.ok(await until(() => h.held().length === 4), 'the Arc, a GPU added, starts at once');
    await sleep(30);
    assert.deepEqual(h.running(), { default: 3, [ARC.id]: 1 });
    assert.equal(onUhd(), 3, 'the UHD lane waits for the clips already on the UHD');
    // each old clip done: a UHD lane worker takes its place
    for (let lane = 1; lane <= 3; lane += 1) {
      h.held().find((entry) => entry.gpu === null).finish(0);
      assert.ok(await until(() => (h.running()[UHD.id] || 0) === lane), `${lane} on the UHD lane`);
      await sleep(20);
      assert.equal(onUhd(), 3, 'never more than 3 on the UHD');
    }
    assert.deepEqual(h.running(), { [UHD.id]: 3, [ARC.id]: 1 });
    const done = await h.finishJob(id);
    assert.equal(done.state, 'completed');
    assert.equal(done.items.filter((item) => item.state === 'completed').length, 20);
  } finally {
    await h.close();
  }
});

test('one number for a job with lanes: its one GPU still here takes it, else the job carries on without lanes', async (t) => {
  captureWarnings(t);
  // the T400 is gone: the Arc's lane gets the number
  const h = createHarness({ clips: 12, behave: hold });
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: ARC.id, concurrency: 2 }, { device: T400.id, concurrency: 2 }] }));
    assert.ok(await until(() => h.held().length === 2));
    const job = await h.service.setConcurrency(id, 3);
    assert.deepEqual(job.config.lanes, [{ device: ARC.id, concurrency: 3 }]);
    assert.equal(job.config.concurrency, 3);
    assert.ok(await until(() => h.held().length === 3));
    assert.deepEqual(h.running(), { [ARC.id]: 3 });
    assert.equal((await h.finishJob(id)).state, 'completed');
  } finally {
    await h.close();
  }
  // both GPUs here: no lanes, on the GPU the single number always used;
  // the UHD lane's clip there counts, so the UHD never runs more than 2
  const two = createHarness({ clips: 12, behave: hold });
  const onUhd = () => two.held().filter((entry) => entry.gpu === null || entry.gpu === UHD.node).length;
  try {
    const id = await two.service.start(two.config({ lanes: [{ device: UHD.id, concurrency: 1 }, { device: ARC.id, concurrency: 2 }] }));
    assert.ok(await until(() => two.held().length === 3));
    const job = await two.service.setConcurrency(id, 2);
    assert.equal('lanes' in job.config, false);
    assert.equal(job.config.concurrency, 2);
    assert.ok(await until(() => two.held().length === 4));
    await sleep(30);
    assert.deepEqual(two.running(), { [UHD.id]: 1, [ARC.id]: 2, default: 1 });
    assert.equal(onUhd(), 2);
    for (const entry of two.held().filter((e) => e.gpu !== null)) entry.finish(0);
    assert.ok(await until(() => JSON.stringify(two.running()) === JSON.stringify({ default: 2 })), JSON.stringify(two.running()));
    const done = await two.finishJob(id);
    assert.equal(done.state, 'completed');
    assert.equal(done.items.filter((item) => item.state === 'completed').length, 12);
    assert.equal('lanes' in done.config, false);
  } finally {
    await two.close();
  }
});

test('a lane whose GPU is not in the container is skipped and logged; with none found the job runs as before', async (t) => {
  const warnings = captureWarnings(t);
  const h = createHarness({ clips: 8, behave: hold, devices: [ARC, CPU] });
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: ARC.id, concurrency: 1 }, { device: MISSING, concurrency: 3 }] }));
    assert.ok(await until(() => h.held().length === 1));
    await sleep(30);
    assert.deepEqual(h.running(), { [ARC.id]: 1 });
    assert.ok(warnings.includes(`[CONVERTER] Encoding device ${MISSING} is not in the container; its 3 conversions at once are not started.`), warnings.join('\n'));
    // the Hardware panel keeps a row only for the conversions that run
    assert.equal((await h.service.get(id)).config.concurrency, 4);
    assert.equal(h.service.slotsOf(id), 1);
    assert.equal(h.service.slotsOf('no-such-job'), null);
    // only GPUs that are gone: the default workers run the whole job, never stalls
    await h.service.setLanes(id, [{ device: MISSING, concurrency: 2 }]);
    for (const entry of h.held()) entry.finish(0);
    assert.ok(await until(() => h.held().length === 2));
    await sleep(30);
    assert.deepEqual(h.running(), { default: 2 });
    assert.equal(h.service.slotsOf(id), 2, 'the default workers');
    assert.ok(h.held().every((entry) => entry.gpu === null), 'planner.select, no GPU named');
    assert.equal((await h.finishJob(id)).state, 'completed');

    const again = await h.service.start(h.config({ lanes: [{ device: MISSING, concurrency: 2 }] }));
    assert.ok(await until(() => h.held().length === 2));
    assert.deepEqual(h.running(), { default: 2 });
    const done = await h.finishJob(again);
    assert.equal(done.state, 'completed');
    assert.equal(done.items.filter((item) => item.state === 'completed').length, 8);
  } finally {
    await h.close();
  }
});

test('a stop and restart keep the lanes; so do a pause and resume', async () => {
  const first = createHarness({ clips: 10, behave: hold, keep: true });
  let second;
  try {
    const id = await first.service.start(first.config({ lanes: [{ device: ARC.id, concurrency: 2 }, { device: UHD.id, concurrency: 1 }] }));
    assert.ok(await until(() => first.held().length === 3));
    await first.service.shutdown();
    const stopped = await first.service.get(id);
    assert.equal(stopped.state, 'paused');
    assert.deepEqual(stopped.config.lanes, [{ device: ARC.id, concurrency: 2 }, { device: UHD.id, concurrency: 1 }]);

    second = createHarness({ dir: first.dir, clips: 10, behave: hold });
    const recovering = second.service.recover(id, recoveryFacts);
    assert.ok(await until(() => second.held().length === 3), 'the job carries on with its lanes');
    assert.deepEqual(second.running(), { [ARC.id]: 2, [UHD.id]: 1 });

    await second.service.pause(id);
    for (const entry of second.held()) entry.finish(0);
    assert.ok(await until(async () => (await second.service.get(id)).state === 'paused'));
    assert.equal(second.held().length, 0, 'paused: nothing new starts');
    await second.service.resume(id);
    assert.ok(await until(() => second.held().length === 3));
    assert.deepEqual(second.running(), { [ARC.id]: 2, [UHD.id]: 1 });
    const done = await second.finishJob(id);
    await recovering;
    assert.equal(done.state, 'completed');
    assert.equal(done.items.filter((item) => item.state === 'completed').length, 10);
  } finally {
    await second?.close();
    fs.rmSync(first.dir, { recursive: true, force: true });
  }
});

test('a job without lanes runs ffmpeg with exactly the arguments it always had', async () => {
  // the default GPU encodes through QSV (decoded with VA-API on renderD128)
  const qsv = createHarness({ clips: 1 });
  try {
    const id = await qsv.service.start(qsv.config({ concurrency: 1 }));
    assert.equal((await qsv.finishJob(id)).state, 'completed');
    const source = path.join(qsv.dir, 'footage', 'RecentClips', '2026-10-20_07-10-00-front.mp4');
    const target = path.join(qsv.dir, 'work', 'item-000001-encoded.mp4');
    assert.deepEqual(qsv.encodes().map((entry) => entry.args), [[
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
      '-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128',
      '-i', source,
      '-c:v', 'hevc_qsv', '-b:v', '250000', '-pix_fmt', 'nv12', '-bf', '0', ...TAIL,
      '-an', '-sn', '-dn', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', target
    ]]);
    assert.deepEqual(qsv.resolved, [], 'no device is looked up');
  } finally {
    await qsv.close();
  }
  // NVIDIA as the default: zero-copy decode, no GPU index
  const nvidia = createHarness({ clips: 1, works: (encoder) => encoder === 'hevc_nvenc' || encoder.startsWith('lib') });
  try {
    const id = await nvidia.service.start(nvidia.config({ concurrency: 1 }));
    assert.equal((await nvidia.finishJob(id)).state, 'completed');
    const args = nvidia.encodes()[0].args;
    assert.deepEqual(args.slice(0, 13), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
      '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i', args[10], '-c:v', 'hevc_nvenc']);
    assert.deepEqual(args.slice(13, 17), ['-b:v', '250000', '-bf', '0']);
    assert.equal(args.includes('-gpu'), false);
    assert.equal(args.includes('-hwaccel_device'), false);
  } finally {
    await nvidia.close();
  }
});

test('a GPU that cannot encode the codec converts its lane\'s clips on the CPU encoder', async (t) => {
  const warnings = captureWarnings(t);
  const h = createHarness({ clips: 4, behave: hold });
  try {
    const id = await h.service.start(h.config({ codec: 'av1', lanes: [{ device: UHD.id, concurrency: 1 }, { device: ARC.id, concurrency: 1 }] }));
    assert.ok(await until(() => h.held().length === 2));
    const live = h.service.activeEncodes();
    const uhd = live.find((entry) => entry.deviceId === UHD.id);
    const arc = live.find((entry) => entry.deviceId === ARC.id);
    assert.deepEqual([uhd.encoder, uhd.hardware, uhd.device, uhd.decode], ['libsvtav1', false, null, 'cpu']);
    assert.deepEqual([arc.encoder, arc.hardware, arc.device], ['av1_qsv', true, ARC.node]);
    assert.equal(warnings.filter((line) => line === '[CONVERTER] Intel UHD Graphics 770 cannot encode AV1; its conversions use the CPU encoder.').length, 1);
    assert.equal((await h.finishJob(id)).state, 'completed');
    assert.equal(warnings.filter((line) => /cannot encode/.test(line)).length, 1, 'said once');
  } finally {
    await h.close();
  }
});

test('selectFor proves each GPU with its own arguments, caches the proof, retries a timeout', async (t) => {
  const warnings = captureWarnings(t);
  let arcTimesOut = true;
  const probe = fakeProbe((encoder, args) => {
    if (arcTimesOut && encoder === 'hevc_qsv' && args.includes(`qsv=qsvenc:hw_any,child_device=${ARC.node}`)) return 'timeout';
    return desktopWorks(encoder, args);
  });
  const planner = createEncoderPlanner({ runProbe: probe.runProbe, platform: 'linux' });
  const probes = () => probe.calls.filter((args) => !args.includes('-encoders')).length;

  assert.deepEqual(await planner.select('h265'), { family: 'h265', codec: 'hevc_qsv', hardware: true }, 'unchanged without a device');
  const uhd = await planner.selectFor('h265', UHD);
  assert.deepEqual(uhd, { family: 'h265', codec: 'hevc_qsv', hardware: true, device: { id: UHD.id, kind: 'dri', node: UHD.node, index: null } });
  assert.ok(Object.isFrozen(uhd) && Object.isFrozen(uhd.device));
  assert.deepEqual(await planner.selectFor('h265', T400), { family: 'h265', codec: 'hevc_nvenc', hardware: true, device: { id: T400.id, kind: 'nvidia', node: null, index: 0 } });
  assert.deepEqual(await planner.selectFor('av1', CPU), { family: 'av1', codec: 'libsvtav1', hardware: false, device: { id: 'cpu', kind: 'cpu' } });
  const noAv1 = await planner.selectFor('av1', UHD);
  assert.deepEqual([noAv1.codec, noAv1.hardware, noAv1.device.id], ['libsvtav1', false, UHD.id]);
  const before = probes();
  await planner.selectFor('h265', UHD);
  await planner.selectFor('av1', UHD);
  assert.equal(probes(), before, 'proofs and choices are kept');
  assert.equal(warnings.filter((line) => /cannot encode AV1/.test(line)).length, 1);

  // a probe that only ran out of time is tried again, and then it works
  const slow = await planner.selectFor('h265', ARC);
  assert.equal(slow.hardware, false);
  arcTimesOut = false;
  const retried = await planner.selectFor('h265', ARC);
  assert.deepEqual([retried.codec, retried.hardware, retried.device.node], ['hevc_qsv', true, ARC.node]);
  assert.ok(probe.calls.some((args) => args.includes('-gpu') && args[args.indexOf('-gpu') + 1] === '0'), 'NVENC probed with its index');
});

test('one GPU\'s broken GPU decode does not turn it off on another GPU', async () => {
  // decoding on the Arc fails (the encode works once decoded on the CPU)
  const h = createHarness({
    clips: 6,
    behave: (args) => (args.includes('pipe:1') && args.includes('-hwaccel_device') && args[args.indexOf('-hwaccel_device') + 1] === ARC.node ? 1 : undefined)
  });
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: ARC.id, concurrency: 1 }, { device: UHD.id, concurrency: 1 }] }));
    const done = await h.finishJob(id);
    assert.equal(done.state, 'completed');
    assert.equal(done.items.filter((item) => item.state === 'completed').length, 6);
    const onArc = h.encodes().filter((entry) => entry.gpu === ARC.node);
    const onUhd = h.encodes().filter((entry) => entry.gpu === UHD.node);
    assert.ok(onArc.length >= 2 && onUhd.length >= 1);
    assert.ok(onArc[0].args.includes('-hwaccel'), 'tried with GPU decoding first');
    assert.ok(onArc.slice(2).every((entry) => !entry.args.includes('-hwaccel')), 'then the Arc decodes on the CPU');
    assert.ok(onUhd.every((entry) => entry.args.includes('-hwaccel') && entry.args.includes(UHD.node)), 'the UHD keeps decoding on its GPU');
  } finally {
    await h.close();
  }
});

// ---- runtime: devices(), the benchmark per GPU

function fakeServiceFactory(record) {
  return () => {
    const started = new Map();
    return {
      start: async (config) => {
        const id = `job-${record.length + 1}`;
        record.push(config);
        started.set(id, config);
        return id;
      },
      whenIdle: async (id) => ({
        items: fs.readdirSync(path.join(started.get(id).sourceRoot, 'RecentClips'))
          .map((name) => ({ state: 'completed', relativePath: `RecentClips/${name}`, sourceBytes: 100, outputBytes: 50 }))
      }),
      cancel: async () => {}, shutdown: async () => {}, list: async () => [], subscribe: () => () => {}, activeEncodes: () => []
    };
  };
}

async function openRuntime(dir, { devices, works = desktopWorks, service = null, listMs = 0 } = {}) {
  const { createConverterRuntime } = require('../src/main/converter/runtime');
  const { spawn } = require('child_process');
  const probe = fakeProbe(works);
  // (ms: how long one lookup takes)
  const discovery = { calls: 0, ms: listMs };
  for (const name of ['data', 'temp']) fs.mkdirSync(path.join(dir, name), { recursive: true });
  const runtime = await createConverterRuntime({
    userDataPath: fs.realpathSync(path.join(dir, 'data')), tempPath: fs.realpathSync(path.join(dir, 'temp')),
    ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', spawn, autoConvert: false,
    factories: {
      createEncoderPlanner: () => createEncoderPlanner({ runProbe: probe.runProbe, platform: 'linux' }),
      createDeviceDiscovery: () => ({
        list: async () => {
          discovery.calls += 1;
          if (discovery.ms) await sleep(discovery.ms);
          return devices;
        }
      }),
      ...(service ? { createConverterJobService: service } : {})
    }
  });
  return { runtime, probe, discovery };
}

test('devices() lists each device with the encoder it proved, and the default device', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lanes-rt-'));
  const previousOrder = process.env.CUDA_DEVICE_ORDER;
  delete process.env.CUDA_DEVICE_ORDER;
  try {
    const { runtime, probe, discovery } = await openRuntime(dir, { devices: [UHD, ARC, T400, CPU] });
    assert.equal(process.env.CUDA_DEVICE_ORDER, undefined, 'CUDA keeps its own order for every ffmpeg that names no GPU');
    await runtime.start();
    assert.equal(probe.calls.length, 0, 'nothing is probed until something asks');
    assert.equal(discovery.calls, 0);
    const out = await runtime.devices();
    assert.deepEqual(out.devices.map((d) => [d.id, d.name, d.encoders]), [
      [UHD.id, UHD.name, { h265: 'hevc_qsv', av1: null }],
      [ARC.id, ARC.name, { h265: 'hevc_qsv', av1: 'av1_qsv' }],
      [T400.id, T400.name, { h265: 'hevc_nvenc', av1: 'av1_nvenc' }],
      ['cpu', CPU.name, { h265: 'libx265', av1: 'libsvtav1' }]
    ]);
    assert.equal(out.devices[1].node, ARC.node);
    assert.equal(out.defaultDevice, UHD.id, 'QSV without a device runs on renderD128');
    assert.deepEqual(out.defaultDevices, { h265: UHD.id, av1: 'cpu' }, 'per codec: no GPU here does AV1 without a device');
    const probed = probe.calls.length;
    await runtime.devices();
    assert.equal(probe.calls.length, probed, 'later calls are instant');
    assert.equal(discovery.calls, 2, 'the devices are looked up again each time');
    assert.equal(await runtime.resolveDevice(ARC.id), ARC);
    assert.equal(await runtime.resolveDevice('/dev/dri/renderD129'), null, 'never a node path');
    assert.equal(await runtime.resolveDevice(MISSING), null);
    await runtime.shutdown();

    const nvidia = await openRuntime(fs.mkdtempSync(path.join(dir, 'nv-')), {
      devices: [ARC, T400, CPU], works: (encoder, args) => encoder.endsWith('_nvenc') || desktopWorks(encoder, args)
    });
    assert.equal((await nvidia.runtime.devices()).defaultDevice, T400.id, 'NVENC without a device is index 0');
    await nvidia.runtime.shutdown();
    const cpuOnly = await openRuntime(fs.mkdtempSync(path.join(dir, 'cpu-')), { devices: [CPU], works: (encoder) => encoder.startsWith('lib') });
    assert.deepEqual(await cpuOnly.runtime.devices(), { devices: [{ ...CPU, encoders: null }], defaultDevice: null, defaultDevices: null });
    assert.equal(cpuOnly.probe.calls.length, 0, 'no GPU: nothing is tested');
    await cpuOnly.runtime.shutdown();
  } finally {
    if (previousOrder === undefined) delete process.env.CUDA_DEVICE_ORDER;
    else process.env.CUDA_DEVICE_ORDER = previousOrder;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('devices(): one GPU tests nothing and logs nothing; a GPU converting now, or a test that ran out of time, is not ruled out', async (t) => {
  const warnings = captureWarnings(t);
  const said = () => warnings.filter((line) => /cannot encode/.test(line));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lanes-rt-'));
  try {
    // one GPU without AV1 (a UHD 770): the page keeps its single number
    const one = await openRuntime(fs.mkdtempSync(path.join(dir, 'one-')), { devices: [UHD, CPU] });
    assert.deepEqual(await one.runtime.devices(), {
      devices: [{ ...UHD, encoders: null }, { ...CPU, encoders: null }], defaultDevice: null, defaultDevices: null
    });
    assert.equal(one.probe.calls.length, 0, 'no test encodes');
    assert.deepEqual(said(), [], 'and nothing new in the log');
    await one.runtime.shutdown();

    // two GPUs while a job converts: only what is known already
    let encoding = [{ jobId: 'job-1', encoder: 'hevc_qsv' }];
    const busy = await openRuntime(fs.mkdtempSync(path.join(dir, 'busy-')), {
      devices: [UHD, ARC, CPU], service: () => ({ ...fakeServiceFactory([])(), activeEncodes: () => encoding })
    });
    let out = await busy.runtime.devices();
    assert.equal(busy.probe.calls.length, 0, 'a GPU converting now is not tested');
    assert.deepEqual(out.devices.map((d) => d.encoders), [{}, {}, {}], 'not known yet: left out, not "can\'t"');
    assert.deepEqual(out.defaultDevices, { h265: null, av1: null });
    encoding = [];
    out = await busy.runtime.devices();
    assert.deepEqual(out.devices.map((d) => d.encoders), [
      { h265: 'hevc_qsv', av1: null }, { h265: 'hevc_qsv', av1: 'av1_qsv' }, { h265: 'libx265', av1: 'libsvtav1' }
    ]);
    await busy.runtime.shutdown();

    // a test encode that only ran out of time: not "can't", tried again next time
    let slow = true;
    const timing = await openRuntime(fs.mkdtempSync(path.join(dir, 'slow-')), {
      devices: [UHD, ARC, CPU],
      works: (encoder, args) => (slow && encoder === 'hevc_qsv' && args.includes(`qsv=qsvenc:hw_any,child_device=${ARC.node}`)
        ? 'timeout' : desktopWorks(encoder, args))
    });
    out = await timing.runtime.devices();
    assert.deepEqual(out.devices[1].encoders, { av1: 'av1_qsv' }, 'H.265 on the Arc: not known yet');
    assert.equal(said().some((line) => /Arc A380 cannot encode H\.265/.test(line)), false);
    slow = false;
    out = await timing.runtime.devices();
    assert.deepEqual(out.devices[1].encoders, { h265: 'hevc_qsv', av1: 'av1_qsv' });
    await timing.runtime.shutdown();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the default device per codec: AV1 may use another GPU than H.265; NVENC only when one NVIDIA GPU can', async (t) => {
  captureWarnings(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lanes-rt-'));
  const open = (devices, works) => openRuntime(fs.mkdtempSync(path.join(dir, 'rt-')), { devices, works });
  const RTX = { ...T400, id: 'pci:0000:02:00.0', pci: '0000:02:00.0', name: 'NVIDIA GeForce RTX 3060', index: 1 };
  try {
    // an Arc A380 on renderD128 next to a T400 (NVENC H.265, no AV1)
    const arc = { ...ARC, node: '/dev/dri/renderD128' };
    const mixed = await open([arc, T400, CPU], (encoder, args) => {
      if (encoder.startsWith('lib')) return true;
      const gpu = gpuOf(args);
      if (encoder.endsWith('_qsv')) return gpu === null || gpu === arc.node;
      return encoder === 'hevc_nvenc' && (gpu === null || gpu === 'nvidia0');
    });
    const out = await mixed.runtime.devices();
    assert.deepEqual(out.defaultDevices, { h265: T400.id, av1: arc.id }, 'AV1 without lanes runs on the Arc');
    assert.equal(out.defaultDevice, T400.id, 'H.265\'s, for pages that know one');
    await mixed.runtime.shutdown();

    // two NVIDIA GPUs that can: CUDA's own order picks, which the list cannot tell
    const both = await open([T400, RTX, CPU], (encoder) => encoder.startsWith('lib') || encoder === 'hevc_nvenc');
    assert.equal((await both.runtime.devices()).defaultDevices.h265, null);
    await both.runtime.shutdown();
    // a card without NVENC (index 0) next to one with it: the one that can
    const GT = { ...T400, name: 'NVIDIA GeForce GT 1030' };
    const one = await open([GT, RTX, CPU], (encoder, args) => encoder.startsWith('lib') || (encoder === 'hevc_nvenc' && gpuOf(args) !== 'nvidia0'));
    assert.equal((await one.runtime.devices()).defaultDevices.h265, RTX.id);
    await one.runtime.shutdown();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a job\'s lanes find their GPUs with one device lookup, however long it takes; callers at the same time share it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lanes-rt-'));
  try {
    // one lookup takes longer than an answer is reused for (2 s)
    const { runtime, discovery } = await openRuntime(dir, { devices: [UHD, ARC, CPU], works: (encoder) => encoder.startsWith('lib'), listMs: 2_200 });
    const found = [];
    for (const id of [UHD.id, ARC.id, 'cpu']) found.push(await runtime.resolveDevice(id));
    assert.deepEqual(found, [UHD, ARC, CPU]);
    assert.equal(discovery.calls, 1, 'one lookup for the three lanes');
    discovery.ms = 0;
    discovery.calls = 0;
    await Promise.all([runtime.devices(), runtime.devices(), runtime.resolveDevice(ARC.id)]);
    assert.equal(discovery.calls, 1, 'one lookup at a time');
    await runtime.shutdown();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only an ffmpeg that names an NVIDIA GPU by index numbers them in PCI order; the rest keep CUDA\'s own order', async () => {
  const { createBoundedProcessRunner, createConverterRuntime } = require('../src/main/converter/runtime');
  const { EventEmitter } = require('events');
  const seen = [];
  const spawn = (_command, _args, options) => {
    seen.push(options);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };
  const run = createBoundedProcessRunner({ spawn });
  await run('ffmpeg', ['-c:v', 'hevc_nvenc', '-gpu', '1']);
  await run('ffmpeg', ['-hwaccel', 'cuda', '-hwaccel_device', '0', '-i', 'clip.mp4']);
  await run('ffmpeg', ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128']);
  await run('ffmpeg', ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda', '-i', 'clip.mp4', '-c:v', 'hevc_nvenc']);
  assert.deepEqual(seen.map((options) => options.env?.CUDA_DEVICE_ORDER ?? null), ['PCI_BUS_ID', 'PCI_BUS_ID', null, null]);
  assert.equal('env' in seen[3], false, 'a job without lanes: the server\'s own environment, as always');
  assert.equal(seen[0].env.PATH, process.env.PATH, 'the rest of the environment is kept');

  // the converter's encodes too
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lanes-rt-'));
  try {
    for (const name of ['data', 'temp']) fs.mkdirSync(path.join(dir, name));
    let deps;
    const runtime = await createConverterRuntime({
      userDataPath: fs.realpathSync(path.join(dir, 'data')), tempPath: fs.realpathSync(path.join(dir, 'temp')),
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', spawn, autoConvert: false,
      factories: {
        createConverterJobService: (given) => { deps = deps || given; return fakeServiceFactory([])(); },
        createDeviceDiscovery: () => ({ list: async () => [CPU] })
      }
    });
    seen.length = 0;
    deps.spawnProcess('ffmpeg', ['-c:v', 'hevc_nvenc', '-gpu', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    deps.spawnProcess('ffmpeg', ['-c:v', 'hevc_nvenc'], { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.deepEqual(seen.map((options) => options.env?.CUDA_DEVICE_ORDER ?? null), ['PCI_BUS_ID', null]);
    await runtime.shutdown();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const hasFfmpeg = require('child_process').spawnSync('ffmpeg', ['-version']).status === 0;

async function benchmarkFootage(dir) {
  const { createTeslaH264Fixture } = require('./fixtures/ffmpegFixtures');
  const footage = path.join(dir, 'footage', 'TeslaCam', 'RecentClips');
  fs.mkdirSync(footage, { recursive: true });
  await createTeslaH264Fixture({
    ffmpegPath: 'ffmpeg', outputPath: path.join(footage, '2026-10-20_17-00-00-front.mp4'), durationSeconds: 1, frameRate: 12,
    size: '160x120', telemetryPattern: Array.from({ length: 12 }, (_, n) => Buffer.from([0x20, n]))
  });
  return path.join(dir, 'footage', 'TeslaCam');
}

test('benchmark: every GPU runs alone with its own lanes, in order; a codec it cannot encode is unsupported, not run on the CPU', { skip: !hasFfmpeg && 'needs ffmpeg', timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lanes-bench-'));
  try {
    const sourceRoot = await benchmarkFootage(dir);
    const started = [];
    const { runtime } = await openRuntime(dir, { devices: [ARC, UHD, CPU], service: fakeServiceFactory(started) });
    const progress = [];
    try {
      const out = await runtime.runBenchmark({ codecs: ['h265', 'av1'], sourceRoot, onProgress: (step) => progress.push(step) });
      assert.deepEqual(Object.keys(out), ['devices'], 'a result per GPU, nothing shared');
      assert.deepEqual(out.devices.map((entry) => entry.device), [{ id: ARC.id, name: ARC.name }, { id: UHD.id, name: UHD.name }]);
      const [arc, uhd] = out.devices;
      assert.deepEqual(arc.codecs.map((run) => [run.codec, run.encoder?.codec, run.error]), [['h265', 'hevc_qsv', undefined], ['av1', 'av1_qsv', undefined]]);
      assert.deepEqual(uhd.codecs.map((run) => [run.codec, run.encoder?.codec ?? null, run.error]), [['h265', 'hevc_qsv', undefined], ['av1', null, 'UNSUPPORTED']]);
      for (const run of [...arc.codecs, uhd.codecs[0]]) {
        assert.deepEqual(Object.keys(run).sort(), ['best', 'clips', 'codec', 'efficient', 'encoder', 'results', 'skipped', 'verifyComparison']);
        assert.deepEqual(run.encoder, { family: run.codec, codec: run.encoder.codec, hardware: true });
        assert.deepEqual(run.results.map((r) => r.level), [1, 2, 4, 6, 8]);
        assert.deepEqual(run.verifyComparison.map((r) => r.verifyMode), ['quick', 'full'], 'no Off');
      }
      // every level ran on one GPU alone: the Arc's first, then the UHD's (H.265 only)
      assert.ok(started.every((config) => Array.isArray(config.lanes) && config.lanes.length === 1
        && config.lanes[0].concurrency === config.concurrency), 'one lane each');
      const order = started.map((config) => `${config.lanes[0].device === ARC.id ? 'arc' : 'uhd'}:${config.codec}`);
      const firstUhd = order.indexOf(`uhd:h265`);
      assert.ok(firstUhd > 0 && order.slice(0, firstUhd).every((entry) => entry.startsWith('arc:')) && order.slice(firstUhd).every((entry) => entry === 'uhd:h265'), order.join(' '));
      assert.ok(order.slice(0, firstUhd).includes('arc:av1'));
      assert.equal(started.some((config) => config.lanes.some((lane) => lane.device === 'cpu')), false, 'the CPU is never benchmarked');
      assert.equal(started.some((config) => config.verifyMode === 'off'), false);
      const run = progress.find((step) => step.step === 'run' && step.device?.id === UHD.id);
      assert.deepEqual([run.device, run.deviceIndex, run.deviceTotal, run.codec, run.codecIndex, run.codecTotal], [{ id: UHD.id, name: UHD.name }, 2, 2, 'h265', 1, 2]);
    } finally {
      await runtime.shutdown();
    }

    // one GPU: today's result, apart from the comparison without Off
    const single = [];
    const one = await openRuntime(fs.mkdtempSync(path.join(dir, 'one-')), { devices: [ARC, CPU], service: fakeServiceFactory(single) });
    try {
      const out = await one.runtime.runBenchmark({ codecs: ['h265'], sourceRoot });
      assert.equal('devices' in out, false);
      assert.equal(out.codec, 'h265');
      assert.deepEqual(out.encoder, { family: 'h265', codec: 'hevc_qsv', hardware: true }, 'planner.select, as before');
      assert.deepEqual(out.codecs.map((r) => r.codec), ['h265']);
      assert.deepEqual(out.verifyComparison.map((r) => r.verifyMode), ['quick', 'full']);
      assert.ok(single.length > 0 && single.every((config) => !('lanes' in config)), 'no lanes with one GPU');
      assert.deepEqual([...new Set(single.map((config) => config.verifyMode))].sort(), ['full', 'quick']);
    } finally {
      await one.runtime.shutdown();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- IPC, the web bridge, automatic conversion

function ipcHarness(overrides = {}) {
  const { registerConverterIpc } = require('../src/main/converter/ipc');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lanes-ipc-'));
  for (const name of ['source', 'out']) fs.mkdirSync(path.join(dir, name));
  const handlers = new Map();
  const calls = { start: [], setLanes: [], autoLanes: [], autoConcurrency: [], configure: [] };
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) };
  const service = {
    subscribe: () => () => {},
    start: async (config) => { calls.start.push(config); return 'job-1'; },
    setLanes: async (jobId, lanes) => {
      calls.setLanes.push([jobId, lanes]);
      return { id: jobId, state: 'encoding', config: { autoConvert: overrides.autoJob === true, lanes, concurrency: lanesTotal(lanes) }, items: [] };
    },
    // (keptLane: the job had lanes and keeps that one GPU)
    setConcurrency: async (jobId, concurrency) => ({
      id: jobId, state: 'encoding', items: [],
      config: { autoConvert: overrides.autoJob === true, concurrency, ...(overrides.keptLane ? { lanes: [{ device: overrides.keptLane, concurrency }] } : {}) }
    }),
    list: async () => []
  };
  const registration = registerConverterIpc({
    ipcMain, dialog: { showOpenDialog: async () => ({ canceled: true }) }, service,
    capabilities: { replacement: 'available' },
    auto: {
      setLanes: async (lanes) => { calls.autoLanes.push(lanes); },
      setConcurrency: async (value) => { calls.autoConcurrency.push(value); },
      configure: async (settings) => { calls.configure.push(settings); return { settings }; }
    },
    devices: async () => ({
      devices: [{ ...ARC, encoders: { h265: 'hevc_qsv', av1: 'av1_qsv' } }, { ...UHD, encoders: { h265: 'hevc_qsv', av1: null } }, { ...CPU, encoders: { h265: 'libx265', av1: 'libsvtav1' } }],
      defaultDevice: UHD.id
    })
  });
  const invoke = (name, payload) => handlers.get(`converter:${name}`)({ sender: null }, payload);
  const config = (over = {}) => ({
    sourceRoot: path.join(dir, 'source'), destinationRoot: path.join(dir, 'out'), codec: 'h265', profileId: 'balanced',
    networkMode: 'direct', outputMode: 'separate', includedGroups: ['RecentClips'], replacementConfirmed: false, ...over
  });
  return { dir, invoke, calls, config, registration, close: () => { registration.unregister(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('IPC: devices, start and automatic settings with lanes, DEVICE_UNSUPPORTED, live setLanes', async () => {
  const { CHANNELS, sanitizeSnapshot } = require('../src/main/converter/ipc');
  assert.ok(CHANNELS.includes('converter:devices') && CHANNELS.includes('converter:setLanes'));
  const h = ipcHarness({ autoJob: true });
  try {
    const devices = await h.invoke('devices');
    assert.equal(devices.ok, true);
    assert.equal(devices.value.defaultDevice, UHD.id);
    assert.equal((await h.invoke('devices', { all: true })).error.code, 'INVALID_REQUEST');

    let out = await h.invoke('start', h.config({ concurrency: 9, lanes: [{ device: ARC.id, concurrency: 3 }, { device: 'cpu', concurrency: 0 }, { device: UHD.id, concurrency: 1 }] }));
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(h.calls.start[0].lanes, [{ device: ARC.id, concurrency: 3 }, { device: UHD.id, concurrency: 1 }]);
    assert.equal(h.calls.start[0].concurrency, 4, 'the total');
    out = await h.invoke('start', h.config({ concurrency: 2 }));
    assert.equal('lanes' in h.calls.start[1], false, 'no lanes, as before');
    assert.equal(h.calls.start[1].concurrency, 2);
    out = await h.invoke('start', h.config({ lanes: null }));
    assert.equal('lanes' in h.calls.start[2], false);
    for (const lanes of [[{ device: '/dev/dri/renderD128', concurrency: 1 }], [{ device: ARC.id, concurrency: 1, index: 0 }], []]) {
      assert.equal((await h.invoke('start', h.config({ lanes }))).error.code, 'INVALID_LANES');
    }
    // AV1 on the UHD 770: refused, with the GPU's name
    out = await h.invoke('start', h.config({ codec: 'av1', lanes: [{ device: ARC.id, concurrency: 2 }, { device: UHD.id, concurrency: 1 }] }));
    assert.deepEqual(out, { ok: false, error: { code: 'DEVICE_UNSUPPORTED', retryable: false, details: { device: 'Intel UHD Graphics 770', codec: 'av1' } } });
    out = await h.invoke('start', h.config({ codec: 'av1', lanes: [{ device: ARC.id, concurrency: 2 }, { device: MISSING, concurrency: 1 }] }));
    assert.equal(out.ok, true, 'a GPU that is not here is left to the job');

    // automatic settings keep a GPU that is not in the container now
    out = await h.invoke('setAuto', { enabled: true, intervalMinutes: 60, window: null, keepRunning: false, openAtLogin: false,
      config: h.config({ codec: 'av1', lanes: [{ device: MISSING, concurrency: 2 }, { device: UHD.id, concurrency: 1 }] }) });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(h.calls.configure[0].config.lanes, [{ device: MISSING, concurrency: 2 }, { device: UHD.id, concurrency: 1 }]);
    assert.equal(h.calls.configure[0].config.concurrency, 3);

    out = await h.invoke('setLanes', { jobId: 'job-1', lanes: [{ device: ARC.id, concurrency: 2 }, { device: UHD.id, concurrency: 0 }] });
    assert.equal(out.ok, true);
    assert.deepEqual(h.calls.setLanes[0], ['job-1', [{ device: ARC.id, concurrency: 2 }]]);
    assert.deepEqual(out.value.config.lanes, [{ device: ARC.id, concurrency: 2 }], 'passed through to the window');
    assert.deepEqual(h.calls.autoLanes, [[{ device: ARC.id, concurrency: 2 }]], 'an automatic job\'s settings follow');
    assert.equal((await h.invoke('setLanes', { jobId: 'job-1', lanes: [{ device: 'nvidia0', concurrency: 1 }] })).error.code, 'INVALID_LANES');
    assert.equal((await h.invoke('setLanes', { jobId: 'job-1', lanes: [{ device: ARC.id, concurrency: 1 }], extra: 1 })).error.code, 'INVALID_REQUEST');
    assert.equal((await h.invoke('setLanes', { jobId: '../x', lanes: [{ device: ARC.id, concurrency: 1 }] })).error.code, 'INVALID_JOB_ID');

    const snapshot = sanitizeSnapshot({ id: 'job-1', state: 'encoding', config: { lanes: [{ device: ARC.id, concurrency: 2 }], concurrency: 2 }, items: [] });
    assert.deepEqual(snapshot.config.lanes, [{ device: ARC.id, concurrency: 2 }]);
  } finally {
    h.close();
  }
});

test('IPC: one number on an automatic job with lanes: the saved settings follow what the job kept', async () => {
  for (const [keptLane, lanes, numbers] of [[ARC.id, [[{ device: ARC.id, concurrency: 3 }]], []], [null, [], [3]]]) {
    const h = ipcHarness({ autoJob: true, keptLane });
    try {
      const out = await h.invoke('setConcurrency', { jobId: 'job-1', concurrency: 3 });
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.deepEqual(h.calls.autoLanes, lanes, 'its one GPU kept: the settings keep it too');
      assert.deepEqual(h.calls.autoConcurrency, numbers, 'no lanes left: the plain number');
    } finally {
      h.close();
    }
  }
});

test('the web bridge allows the new channels', async () => {
  const { createConverterBridge } = require('../server/converterBridge');
  const lanesCalls = [];
  const runtime = {
    service: {
      subscribe: () => () => {}, list: async () => [],
      setLanes: async (jobId, lanes) => { lanesCalls.push(lanes); return { id: jobId, state: 'encoding', config: { lanes }, items: [] }; }
    },
    capabilities: {}, runBenchmark: async () => ({}), cancelBenchmark: () => {}, auto: {},
    devices: async () => ({ devices: [CPU], defaultDevice: 'cpu' })
  };
  const bridge = createConverterBridge({ runtime, resolvePath: async (p) => p });
  assert.ok(bridge.channels.includes('converter:devices') && bridge.channels.includes('converter:setLanes'));
  assert.deepEqual(await bridge.invoke('devices'), { ok: true, value: { devices: [CPU], defaultDevice: 'cpu' } });
  const out = await bridge.invoke('setLanes', { jobId: 'job-1', lanes: [{ device: 'cpu', concurrency: 1 }] });
  assert.equal(out.ok, true);
  assert.deepEqual(lanesCalls, [[{ device: 'cpu', concurrency: 1 }]]);
});

test('automatic conversion: setLanes saves the lanes and their total; a bad saved value is left out', async () => {
  const { createAutoConverter } = require('../src/main/converter/autoConvert');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lanes-auto-'));
  try {
    const options = {
      service: { list: async () => [], get: async () => null }, scanner: async function* () {}, fs: fs.promises, directory: dir,
      timers: { setInterval: () => null, clearInterval: () => {} }
    };
    const auto = createAutoConverter(options);
    const config = { sourceRoot: dir, destinationRoot: path.join(dir, 'out'), codec: 'h265', profileId: 'balanced', networkMode: 'direct',
      outputMode: 'separate', includedGroups: ['RecentClips'], replacementConfirmed: false, concurrency: 5, verifyMode: 'quick' };
    await auto.configure({ enabled: true, intervalMinutes: 60, window: null, config });
    await auto.setLanes([{ device: ARC.id, concurrency: 3 }, { device: UHD.id, concurrency: 1 }]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).configs[0];
    assert.deepEqual(saved.lanes, [{ device: ARC.id, concurrency: 3 }, { device: UHD.id, concurrency: 1 }]);
    assert.equal(saved.concurrency, 4);
    // one number for the whole job again: the lanes go
    await auto.setConcurrency(2);
    assert.equal('lanes' in auto.getState().settings.configs[0], false);
    assert.equal(auto.getState().settings.configs[0].concurrency, 2);

    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ enabled: true, intervalMinutes: 60, config: { ...config, lanes: [{ device: 'renderD128', concurrency: 2 }] } }));
    const reloaded = createAutoConverter(options);
    await reloaded.start();
    reloaded.stop();
    assert.equal('lanes' in reloaded.getState().settings.configs[0], false);
    assert.equal(reloaded.getState().settings.configs[0].concurrency, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the Encoder's Hardware panel

test('the encoder block has one entry per device in use', () => {
  const { encoderBlock } = require('../server/encoderStats');
  const worker = (over) => ({ jobId: 'j1', itemId: 'i', encoder: 'hevc_qsv', hardware: true, decode: 'gpu', fps: 300, ...over });
  const jobs = new Map([['j1', { id: 'j1', state: 'encoding', items: [], counters: {} }]]);
  const gpus = [{ name: 'Intel UHD Graphics 770', node: 'renderD128', video: 40, busy: 20 }, { name: 'Intel Arc A380', node: 'renderD129', video: 95, busy: 30 }];
  const workers = [
    worker({ itemId: 'a', deviceId: ARC.id, device: '/dev/dri/renderD129' }),
    worker({ itemId: 'b', deviceId: UHD.id, device: '/dev/dri/renderD128' }),
    worker({ itemId: 'c', deviceId: ARC.id, device: '/dev/dri/renderD129' }),
    worker({ itemId: 'd', deviceId: 'cpu', device: null, encoder: 'libx265', hardware: false, decode: 'cpu' })
  ];
  const out = encoderBlock({ snapshot: { cpu: { usage: 40 }, gpus, filesystems: [] }, jobs, workers });
  // GPUs by PCI slot, the CPU last
  assert.deepEqual(out.devices, [
    { id: UHD.id, name: 'Intel UHD Graphics 770', node: '/dev/dri/renderD128', encoder: 'hevc_qsv', hardware: true, workers: 1, video: 40, busy: 20 },
    { id: ARC.id, name: 'Intel Arc A380', node: '/dev/dri/renderD129', encoder: 'hevc_qsv', hardware: true, workers: 2, video: 95, busy: 30 },
    { id: 'cpu', name: 'CPU', node: null, encoder: 'libx265', hardware: false, workers: 1, video: null, busy: null }
  ]);
  assert.equal(out.device.encoder, 'hevc_qsv', 'the first device stays');
  assert.equal('bottleneck' in out, false, 'no sentence about what limits the run');

  // one GPU, no lanes: as before
  const single = encoderBlock({ snapshot: { cpu: { usage: 30 }, gpus: [gpus[1]], filesystems: [] }, jobs,
    workers: [worker({ deviceId: null, device: '/dev/dri/renderD128' }), worker({ itemId: 'e', deviceId: null, device: '/dev/dri/renderD128' })] });
  assert.equal(single.devices.length, 1);
  assert.equal(single.devices[0].workers, 2);
});

// ---- end to end: the real runtime and converter, two (pretend) GPUs

const HELPER = path.join(__dirname, '..', 'build', 'noreplace-rename');
const canConvert = hasFfmpeg && fs.existsSync(HELPER);

// ffmpeg that writes down how it was called, then encodes on the CPU: the
// GPU encoders become libx265 and the device arguments are left out.
function loggingFfmpeg(dir) {
  const log = path.join(dir, 'ffmpeg-calls.jsonl');
  const script = path.join(dir, 'ffmpeg-gpu.js');
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require('fs');
const { spawn } = require('child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const out = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (['-init_hw_device', '-hwaccel', '-hwaccel_device', '-hwaccel_output_format', '-vaapi_device', '-gpu'].includes(a)) { i += 1; continue; }
  if (a === '-vf' && args[i + 1] === 'format=nv12,hwupload') { i += 1; continue; }
  if (a === '-c:v' && /_(qsv|vaapi|nvenc)$/.test(args[i + 1] || '')) { out.push('-c:v', 'libx265'); i += 1; continue; }
  if (a === '-pix_fmt' && args[i + 1] === 'nv12') { out.push('-pix_fmt', 'yuv420p'); i += 1; continue; }
  out.push(a);
}
const child = spawn('ffmpeg', out, { stdio: 'inherit' });
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
`, { mode: 0o755 });
  return { script, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []) };
}

test('end to end: a lanes job encodes each clip on its lane\'s GPU through the real runtime', { skip: !canConvert && 'needs ffmpeg and build/noreplace-rename', timeout: 180_000 }, async () => {
  const { createConverterRuntime } = require('../src/main/converter/runtime');
  const { createPosixOwnedFs } = require('../server/posixOwnedFs');
  const { createTeslaH264Fixture } = require('./fixtures/ffmpegFixtures');
  const { spawn } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lanes-e2e-'));
  let runtime;
  try {
    const event = path.join(dir, 'footage', 'TeslaCam', 'SentryClips', '2026-10-20_07-44-14');
    fs.mkdirSync(event, { recursive: true });
    const first = path.join(event, '2026-10-20_07-40-00-front.mp4');
    await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: first, durationSeconds: 1, frameRate: 12, size: '160x120', spatialNoise: 4,
      telemetryPattern: Array.from({ length: 12 }, (_, n) => Buffer.from([0x20, n])) });
    for (let i = 1; i < 4; i++) fs.copyFileSync(first, path.join(event, `2026-10-20_07-4${i}-00-front.mp4`));
    for (const name of ['data', 'temp', 'out']) fs.mkdirSync(path.join(dir, name));
    const ffmpeg = loggingFfmpeg(dir);
    process.env.SENTRY_NOREPLACE_RENAME = HELPER;
    const owned = createPosixOwnedFs();
    runtime = await createConverterRuntime({
      userDataPath: fs.realpathSync(path.join(dir, 'data')), tempPath: fs.realpathSync(path.join(dir, 'temp')),
      ffmpegPath: ffmpeg.script, ffprobePath: 'ffprobe', spawn, fs, pathApi: path, platform: 'linux',
      removeOwned: owned.removeOwned, renameExclusive: owned.renameExclusive, autoConvert: false,
      factories: { createDeviceDiscovery: () => ({ list: async () => [UHD, ARC, CPU] }) }
    });
    await runtime.start();
    const id = await runtime.service.start({
      sourceRoot: fs.realpathSync(path.join(dir, 'footage', 'TeslaCam')), destinationRoot: fs.realpathSync(path.join(dir, 'out')),
      codec: 'h265', profileId: 'custom', bitrateKbps: 250, networkMode: 'direct', outputMode: 'separate',
      includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'], replacementConfirmed: false, verifyMode: 'quick',
      lanes: [{ device: ARC.id, concurrency: 1 }, { device: UHD.id, concurrency: 1 }]
    });
    await Promise.race([runtime.service.whenIdle(id), sleep(120_000)]);
    const job = await runtime.service.get(id);
    assert.equal(job.state, 'completed');
    assert.equal(job.items.filter((item) => item.resultCode === 'converted').length, 4);
    assert.ok(job.items.every((item) => item.encoder === 'hevc_qsv'), 'the QSV encoder proved on each GPU');
    const encodes = ffmpeg.calls().filter((args) => args.includes('pipe:1'));
    const on = (node) => encodes.filter((args) => args.includes(`qsv=qsvenc:hw_any,child_device=${node}`));
    assert.equal(on(ARC.node).length + on(UHD.node).length, encodes.length, 'every clip named its GPU');
    assert.ok(on(ARC.node).length >= 1 && on(UHD.node).length >= 1, 'both GPUs converted');
    assert.ok(on(ARC.node).every((args) => args[args.indexOf('-hwaccel_device') + 1] === ARC.node), 'decoded on the same GPU');
    const probes = ffmpeg.calls().filter((args) => args.includes('testsrc2=duration=0.5:size=640x360:rate=8'));
    assert.ok(probes.some((args) => args.includes(`qsv=qsvenc:hw_any,child_device=${ARC.node}`)), 'proved on the Arc with its own arguments');
  } finally {
    await runtime?.shutdown().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
