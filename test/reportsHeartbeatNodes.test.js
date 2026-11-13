'use strict';

// The heartbeat's GPU naming and its `nodes`: convert.device is exactly the
// name of one of `gpus` (the GPU the encode opened, as usableGpus names it)
// or the `cpu`, never a second spelling of the same GPU; each paired node
// gives its CPU, its GPUs and its conversions the same way (and nothing that
// names it); a node reports its hardware over the pinned connection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const http2 = require('http2');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../server/reportsProtocol');
const { createReports, normalizeHeartbeat } = require('../server/reports');
const { createConvertStats, heartbeatHardware, hardwareFromDevices, nodeDeviceName } = require('../server/convertStats');
const { usableGpus, encodeGpuName } = require('../server/gpu');
const { startReceiver } = require('./fixtures/reportsReceiver');

const L = P.HEARTBEAT_LIMITS;
const quiet = { info() {}, warn() {}, error() {} };
const memoryDb = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? structuredClone(m.get(k)) : d), set: (k, v) => m.set(k, structuredClone(v)) }; };
const OLD = {
  uptimeSec: 7210, health: { overall: 'ok', warnings: 0, problems: 0 }, vehicles: 1, footageBytes: 1, recordings: 1,
  spaceSavedBytes: 0, distanceKm: 0, freeBytes: null, totalBytes: null, converting: false, jobsQueued: 0,
  features: { can: false, sentryUsbPaired: false, gpu: true }
};
const payload = (heartbeat) => ({
  kind: 'heartbeat', sentAt: '2026-11-12T10:00:00.000Z', install: 'ANON', anonymous: true,
  build: { build: 131, sha: '9b50039', builtAt: null, tag: 'latest' }, ui: 'horizon', heartbeat
});
const errsOf = (h) => P.validatePayload(payload(h));

// what detectGpus() finds on three kinds of server
const AMD_APU = {
  gpus: [{ node: '/dev/dri/renderD128', vendor: 'amd', vendorName: 'AMD', name: 'AMD Radeon 780M Graphics (phoenix)', passedThrough: true }],
  nvidia: []
};
const INTEL_TWO = {
  gpus: [
    { node: '/dev/dri/renderD128', vendor: 'intel', vendorName: 'Intel', name: 'Intel graphics (iHD)', passedThrough: true },
    { node: '/dev/dri/renderD129', vendor: 'intel', vendorName: 'Intel', name: null, passedThrough: true }
  ],
  nvidia: []
};
const MIXED = {
  gpus: [
    { node: '/dev/dri/renderD128', vendor: 'amd', vendorName: 'AMD', name: 'AMD Radeon Graphics (renoir)', passedThrough: true },
    { node: '/dev/dri/renderD129', vendor: 'nvidia', vendorName: 'NVIDIA', name: null, passedThrough: true },
    { node: '/dev/dri/renderD130', vendor: 'nvidia', vendorName: 'NVIDIA', name: null, passedThrough: true }
  ],
  nvidia: [{ name: 'NVIDIA GeForce RTX 4070', driver: '560.35' }, { name: 'NVIDIA T400', driver: '560.35' }]
};
const names = (found) => usableGpus(found).map((g) => g.name);

test('encodeGpuName: the GPU an encode opened, by exactly its name in gpus (AMD, Intel, NVIDIA); a generic name only without a match', () => {
  // the server that said "AMD graphics" in convert.device and the full name in gpus
  assert.equal(encodeGpuName(AMD_APU, { device: '/dev/dri/renderD128', api: 'vaapi' }), 'AMD Radeon 780M Graphics (phoenix)');
  assert.equal(encodeGpuName(AMD_APU, { device: null, api: 'vaapi' }), 'AMD Radeon 780M Graphics (phoenix)', 'VA-API without a device: renderD128');
  assert.equal(encodeGpuName(AMD_APU, { device: null, api: 'amf' }), 'AMD Radeon 780M Graphics (phoenix)');
  // Intel: by render node (the unnamed one by usableGpus' own name for it), QSV without a device on the first
  assert.equal(encodeGpuName(INTEL_TWO, { device: '/dev/dri/renderD128', api: 'qsv' }), 'Intel graphics (iHD)');
  assert.equal(encodeGpuName(INTEL_TWO, { device: '/dev/dri/renderD129', api: 'vaapi' }), 'Intel GPU');
  assert.equal(encodeGpuName(INTEL_TWO, { device: 'renderD129', api: 'vaapi' }), 'Intel GPU', 'a bare node name');
  assert.equal(encodeGpuName(INTEL_TWO, { device: null, api: 'qsv' }), 'Intel graphics (iHD)');
  // NVIDIA: by index (the converter's -gpu, "nvidia<N>"), NVENC without one on the first
  assert.equal(encodeGpuName(MIXED, { device: 'nvidia0', api: 'nvenc' }), 'NVIDIA GeForce RTX 4070');
  assert.equal(encodeGpuName(MIXED, { device: 'nvidia1', api: 'nvenc' }), 'NVIDIA T400');
  assert.equal(encodeGpuName(MIXED, { device: null, api: 'nvenc' }), 'NVIDIA GeForce RTX 4070');
  assert.equal(encodeGpuName(MIXED, { device: '/dev/dri/renderD128', api: 'vaapi' }), 'AMD Radeon Graphics (renoir)');
  // every one of these is in that server's gpus
  for (const [found, ref] of [[AMD_APU, { device: '/dev/dri/renderD128', api: 'vaapi' }], [INTEL_TWO, { device: '/dev/dri/renderD129' }], [MIXED, { device: 'nvidia1' }]]) {
    assert.ok(names(found).includes(encodeGpuName(found, ref)), JSON.stringify(ref));
  }
  // no match: generic, by the API's maker
  assert.equal(encodeGpuName(MIXED, { device: 'nvidia7', api: 'nvenc' }), 'NVIDIA GPU');
  assert.equal(encodeGpuName(AMD_APU, { device: '/dev/dri/renderD140', api: 'vaapi' }), 'GPU');
  assert.equal(encodeGpuName(null, { device: null, api: 'qsv' }), 'Intel GPU');
  assert.equal(encodeGpuName({ gpus: [], nvidia: [] }, { device: null, api: 'vaapi' }), 'GPU');
  assert.equal(encodeGpuName(null, { device: '/dev/dri/renderD128', vendor: 'amd' }), 'AMD GPU');
});

test('convertStats: the device is named when the heartbeat is made, as gpus are then; a CPU encode is the cpu; each node apart', () => {
  let t = 5_000_000;
  const db = memoryDb();
  const cpu = 'AMD Ryzen 7 7840HS w/ Radeon 780M Graphics';
  const cs = createConvertStats({ db, now: () => t });
  cs.sample([{ encoder: 'hevc_vaapi', hardware: true, device: '/dev/dri/renderD128', fps: 240, started: true }]);
  const h = heartbeatHardware({ found: AMD_APU, cpu, stats: cs });
  assert.deepEqual(h.gpus, ['AMD Radeon 780M Graphics (phoenix)']);
  assert.equal(h.convert.device, h.gpus[0], 'convert.device is the gpus entry, not "AMD graphics"');
  assert.deepEqual(h.nodes, []);
  // the CPU
  t += 30_000;
  cs.sample([{ encoder: 'libx265', hardware: false, device: null, fps: 40 }]);
  const c = heartbeatHardware({ found: AMD_APU, cpu, stats: cs });
  assert.equal(c.convert.device, c.cpu);
  assert.equal(c.convert.api, 'cpu');
  // NVIDIA by index, after a restart (only what the encode used is kept: the name is worked out again)
  t += 30_000;
  cs.sample([{ encoder: 'hevc_nvenc', hardware: true, device: 'nvidia1', fps: 500 }]);
  const again = createConvertStats({ db, now: () => t });
  assert.equal(heartbeatHardware({ found: MIXED, cpu, stats: again }).convert.device, 'NVIDIA T400');
  // a record kept by an older version (a device name and no reference): named again from its API
  const old = memoryDb();
  old.set('convert-stats', { encoder: 'hevc_vaapi', device: 'AMD graphics', api: 'vaapi', codec: 'h265', fps: 120, at: t });
  assert.equal(heartbeatHardware({ found: AMD_APU, cpu, stats: createConvertStats({ db: old, now: () => t }) }).convert.device, 'AMD Radeon 780M Graphics (phoenix)');
  old.set('convert-stats', { encoder: 'libsvtav1', device: 'Ryzen', api: 'cpu', codec: 'av1', fps: 30, at: t });
  assert.equal(heartbeatHardware({ found: AMD_APU, cpu, stats: createConvertStats({ db: old, now: () => t }) }).convert.device, cpu);
  // nothing converted yet: all nulls
  assert.deepEqual(heartbeatHardware({ found: AMD_APU, cpu, stats: createConvertStats({ db: memoryDb() }) }).convert, { fps: null, encoder: null, device: null, api: null, codec: null });
});

// a node's hardware as server/nodes.js hardware() gives it
const GARAGE = { id: 'abcdefghijkl', hardware: { cpu: 'Intel(R) Core(TM) i5-12400', gpus: ['Intel Arc A380', 'NVIDIA GeForce RTX 3060'], devices: [{ id: 'pci:0000:03:00.0', name: 'Intel Arc A380' }, { id: 'pci:0000:01:00.0', name: 'NVIDIA GeForce RTX 3060' }, { id: 'cpu', name: 'Intel(R) Core(TM) i5-12400' }] } };
const OFFICE = { id: 'mnopqrstuvwx', hardware: { cpu: 'AMD Ryzen 5 3600 6-Core Processor', gpus: [], devices: [{ id: 'cpu', name: 'AMD Ryzen 5 3600 6-Core Processor' }] } };
const OLDER = { id: 'yz0123456789', hardware: null };

test('reportHeartbeat\'s nodes: from the paired nodes\' hardware and their clips\' speeds; the device is one of that node\'s gpus or its cpu', () => {
  let t = 9_000_000;
  const db = memoryDb();
  const cs = createConvertStats({ db, now: () => t });
  const remote = (lane, encoder, fps, extra = {}) => ({ encoder, hardware: !encoder.startsWith('lib'), device: null, node: 'Garage PC', remote: true, started: true, deviceId: lane, fps, ...extra });
  // this server converts on its GPU, the garage node on its Arc (two clips) and the office node on its CPU
  cs.sample([
    { encoder: 'hevc_vaapi', hardware: true, device: '/dev/dri/renderD128', fps: 200, started: true },
    remote(`node:${GARAGE.id}@pci:0000:03:00.0`, 'hevc_qsv', 150),
    remote(`node:${GARAGE.id}@pci:0000:03:00.0`, 'hevc_qsv', 120),
    remote(`node:${OFFICE.id}@cpu`, 'libx265', 35.5),
    // a node's clip not started yet, and one waiting on it: left out
    remote(`node:${OLDER.id}`, 'hevc_nvenc', 999, { started: false }),
    remote(`node:${OLDER.id}`, 'hevc_nvenc', 999, { waitingOnNode: true })
  ]);
  const paired = [GARAGE, OFFICE, OLDER];
  const hw = heartbeatHardware({ found: AMD_APU, cpu: 'AMD Ryzen 7 7840HS', stats: cs, paired });
  assert.equal(hw.convert.fps, 200, 'this server\'s own speed leaves the nodes\' out');
  assert.equal(hw.convert.device, 'AMD Radeon 780M Graphics (phoenix)');
  assert.deepEqual(hw.nodes, [
    { cpu: 'Intel(R) Core(TM) i5-12400', gpus: ['Intel Arc A380', 'NVIDIA GeForce RTX 3060'], convert: { fps: 270, encoder: 'hevc_qsv', device: 'Intel Arc A380', api: 'qsv', codec: 'h265' } },
    { cpu: 'AMD Ryzen 5 3600 6-Core Processor', gpus: [], convert: { fps: 35.5, encoder: 'libx265', device: 'AMD Ryzen 5 3600 6-Core Processor', api: 'cpu', codec: 'h265' } },
    { cpu: null, gpus: [], convert: { fps: null, encoder: null, device: null, api: null, codec: null } }
  ]);
  for (const n of hw.nodes) if (n.convert.device) assert.ok(n.gpus.includes(n.convert.device) || n.convert.device === n.cpu, n.convert.device);
  // the garage node then on its NVIDIA card through a whole-node lane (its first GPU) and by device
  t += 30_000;
  cs.sample([remote(`node:${GARAGE.id}@pci:0000:01:00.0`, 'hevc_nvenc', 400)]);
  assert.equal(heartbeatHardware({ found: AMD_APU, cpu: null, stats: cs, paired }).nodes[0].convert.device, 'NVIDIA GeForce RTX 3060');
  assert.equal(nodeDeviceName(GARAGE.hardware, { hardware: true, device: null, api: 'qsv' }), 'Intel Arc A380', 'a whole-node lane: its first GPU');
  assert.equal(nodeDeviceName(null, { hardware: true, device: 'pci:0000:01:00.0', api: 'nvenc' }), 'NVIDIA GPU', 'an older node: generic');
  assert.equal(nodeDeviceName(null, { hardware: false, device: null, api: 'cpu' }), null);
  // the numbers stay across a restart; a node no longer paired is forgotten
  const again = createConvertStats({ db, now: () => t });
  assert.equal(heartbeatHardware({ found: AMD_APU, cpu: null, stats: again, paired }).nodes[1].convert.device, 'AMD Ryzen 5 3600 6-Core Processor');
  heartbeatHardware({ found: AMD_APU, cpu: null, stats: again, paired: [GARAGE] });
  assert.deepEqual(Object.keys(db.get('convert-stats-nodes', {})), [GARAGE.id]);
  // at most 8
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `node${String(i).padStart(8, '0')}`, hardware: OFFICE.hardware }));
  assert.equal(heartbeatHardware({ found: null, cpu: null, stats: again, paired: many }).nodes.length, L.nodes);

  // through normalizeHeartbeat: exactly right, and nothing that names a node
  const h = normalizeHeartbeat({ ...OLD, ...hw });
  assert.deepEqual(errsOf(h), []);
  assert.deepEqual(h.nodes, hw.nodes);
  const text = JSON.stringify(h);
  for (const id of [GARAGE.id, OFFICE.id, OLDER.id, 'Garage PC', 'pci:', 'node:']) assert.ok(!text.includes(id), `${id} is not in the heartbeat`);
});

test('an older node (no `hardware`): named from the devices it lists, online or as last listed; generic only without a list', () => {
  const t = 9_000_000;
  const cs = createConvertStats({ db: memoryDb(), now: () => t });
  const id = 'node00000077';
  const devices = [
    { id: 'pci:0000:01:00.0', kind: 'nvidia', name: 'NVIDIA GeForce RTX 4070 Ti' },
    { id: 'cpu', kind: 'cpu', name: 'CPU (software encoder)' }
  ];
  cs.sample([{ encoder: 'hevc_nvenc', hardware: true, device: null, remote: true, started: true, deviceId: `node:${id}@pci:0000:01:00.0`, fps: 310 }]);
  const node = (extra) => heartbeatHardware({ found: null, cpu: null, stats: cs, paired: [{ id, hardware: null, ...extra }] }).nodes[0];
  assert.deepEqual(node({ devices }), { cpu: null, gpus: ['NVIDIA GeForce RTX 4070 Ti'], convert: { fps: 310, encoder: 'hevc_nvenc', device: 'NVIDIA GeForce RTX 4070 Ti', api: 'nvenc', codec: 'h265' } },
    'the GPU by its real name, not "NVIDIA GPU"; the CPU entry is not a model name, so no cpu');
  // a CPU entry that names its model is the cpu
  assert.equal(hardwareFromDevices([{ id: 'cpu', name: 'AMD Ryzen 9 7950X 16-Core Processor' }]).cpu, 'AMD Ryzen 9 7950X 16-Core Processor');
  for (const generic of ['CPU', 'CPU (software encoder)', 'cpu']) assert.equal(hardwareFromDevices([{ id: 'cpu', name: generic }]), null, generic);
  // a device listed only by its id (no name) is not a name
  assert.equal(hardwareFromDevices([{ id: 'pci:0000:02:00.0', name: 'pci:0000:02:00.0' }]), null);
  // no list at all: the generic name, as before
  assert.equal(node({ devices: null }).convert.device, 'NVIDIA GPU');
  assert.deepEqual(node({ devices: null }).gpus, []);
  // the hardware a newer node sends still wins over its list
  assert.deepEqual(node({ hardware: { cpu: 'Intel(R) Core(TM) i7-13700K', gpus: ['NVIDIA GeForce RTX 4070 Ti'], devices: [{ id: 'pci:0000:01:00.0', name: 'NVIDIA GeForce RTX 4070 Ti' }] }, devices }).cpu, 'Intel(R) Core(TM) i7-13700K');
  // through normalizeHeartbeat: valid, within the 60-character limits
  const long = [{ id: 'pci:0000:01:00.0', name: `NVIDIA ${'X'.repeat(90)}` }];
  const h = normalizeHeartbeat({ ...OLD, cpu: null, gpus: [], convert: null, nodes: [node({ devices }), heartbeatHardware({ found: null, cpu: null, stats: cs, paired: [{ id, hardware: null, devices: long }] }).nodes[0]] });
  assert.deepEqual(errsOf(h), []);
  assert.ok(h.nodes[1].gpus[0].length <= L.nodeGpu && h.nodes[1].convert.device.length <= L.nodeDevice);
});

test('nodes.hardware(): a node\'s devices go with it, from its last answer or, offline after a restart, from what was kept with the node', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'nodes.js'), 'utf8');
  const fn = src.slice(src.indexOf('function hardware()'), src.indexOf('/** What the Nodes page shows. */'));
  assert.match(fn, /i\?\.devices \|\| \(Array\.isArray\(node\.devices\) \? node\.devices : null\)/);
  assert.match(fn, /hardware: i\?\.hardware \|\| null, devices:/);
});

test('normalizeHeartbeat: nodes are cut to their limits, keep only cpu, gpus and convert, and the device keeps the same truncation as the name it is', () => {
  const long = `Intel(R) Xeon(R) Gold 6338N CPU @ 2.20GHz with a very long marketing suffix`;
  const gpu = 'NVIDIA GeForce RTX 4090 Laptop GPU with an even longer name than usual';
  const h = normalizeHeartbeat({
    ...OLD, cpu: long, gpus: [gpu], convert: { fps: 1, encoder: 'libx265', device: long, api: 'cpu', codec: 'h265' },
    nodes: [
      { cpu: long, gpus: [gpu, '', null, 'A', 'B', 'C', 'D'], convert: { fps: 412.34, encoder: 'hevc_nvenc', device: gpu, api: 'nvenc', codec: 'h265', node: 'Garage PC' }, name: 'Garage PC', id: 'abcdefghijkl', host: '192.168.1.20', address: 'garage.local:9000' },
      { cpu: long, gpus: [], convert: { fps: 1, encoder: 'libx265', device: long, api: 'cpu', codec: 'h265' } },
      null, 'Garage PC',
      ...Array(10).fill({ cpu: null, gpus: [], convert: null })
    ]
  });
  assert.deepEqual(errsOf(h), []);
  assert.equal(h.nodes.length, L.nodes);
  assert.deepEqual(Object.keys(h.nodes[0]), ['cpu', 'gpus', 'convert']);
  assert.deepEqual(Object.keys(h.nodes[0].convert), ['fps', 'encoder', 'device', 'api', 'codec']);
  assert.equal(h.nodes[0].cpu.length, L.nodeCpu);
  assert.deepEqual(h.nodes[0].gpus.length, L.nodeGpus);
  assert.equal(h.nodes[0].convert.fps, 412.3);
  // the device, cut, is still exactly its gpus entry or cpu, here and on each node
  assert.equal(h.convert.device, h.cpu);
  assert.equal(h.nodes[0].convert.device, h.nodes[0].gpus[0]);
  assert.equal(h.nodes[1].convert.device, h.nodes[1].cpu);
  assert.deepEqual(h.nodes[2], { cpu: null, gpus: [], convert: { fps: null, encoder: null, device: null, api: null, codec: null } });
  for (const x of ['Garage PC', 'abcdefghijkl', '192.168.1.20', 'garage.local']) assert.ok(!JSON.stringify(h).includes(x), x);
  // a Manager with no nodes paired sends an empty list; one that is told of none still passes
  assert.deepEqual(normalizeHeartbeat({ ...OLD }).nodes, []);
  assert.deepEqual(errsOf({ ...OLD }), [], 'an old heartbeat without nodes is still right');
});

test('buildPayload: node text goes through the scrubber; no identifiers, the hardware stays', async () => {
  const rec = await startReceiver();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hbnodes-'));
  const ids = ['garage-pc', 'Garage PC', '192.168.1.20', 'office.local'];
  const source = async () => ({
    ...OLD, cpu: 'AMD Ryzen 7 7840HS', gpus: ['AMD Radeon 780M Graphics (phoenix)'],
    convert: { fps: 200, encoder: 'hevc_vaapi', device: 'AMD Radeon 780M Graphics (phoenix)', api: 'vaapi', codec: 'h265' },
    nodes: [
      { cpu: 'Intel(R) Core(TM) i5-12400 on garage-pc', gpus: ['Intel Arc A380 at 192.168.1.20'], convert: { fps: 150, encoder: 'hevc_qsv', device: 'Intel Arc A380 at 192.168.1.20', api: 'qsv', codec: 'h265' }, name: 'Garage PC' },
      { cpu: 'AMD Ryzen 5 3600 6-Core Processor', gpus: [], convert: { fps: null, encoder: null, device: null, api: null, codec: null }, host: 'office.local' }
    ]
  });
  const rep = createReports({
    db: memoryDb(), dataDir, log: quiet, buildInfo: { build: 131, sha: '9b50039abcdef0', builtAt: null, tag: 'latest' }, ui: () => 'original',
    env: { NODE_ENV: 'test', REPORTS_URL: rec.url, REPORTS_PUBLIC_KEY: rec.keys.publicInfo().line },
    heartbeat: source, identifiers: async () => ids, timer: { set: () => ({}), clear() {} }
  });
  try {
    const p = await rep.buildPayload({ kind: 'heartbeat' });
    assert.deepEqual(P.validatePayload(p), []);
    const all = JSON.stringify(p);
    for (const id of ids) assert.ok(!all.includes(id), `${id} is not in a heartbeat`);
    const [garage, office] = p.heartbeat.nodes;
    assert.match(garage.cpu, /^Intel\(R\) Core\(TM\) i5-12400/);
    assert.match(garage.gpus[0], /^Intel Arc A380/);
    assert.equal(garage.convert.device, garage.gpus[0], 'scrubbed the same way as the name it is');
    assert.equal(office.cpu, 'AMD Ryzen 5 3600 6-Core Processor');
    assert.deepEqual(Object.keys(office), ['cpu', 'gpus', 'convert']);
    assert.equal(p.heartbeat.convert.device, p.heartbeat.gpus[0]);
  } finally { rep.stop(); await rec.close(); }
});

// ---- a real node over the pinned connection: its hardware as its heartbeat names it
const hasTools = spawnSync('openssl', ['version']).status === 0;
test('a node reports its hardware in /node/v1/info; the main keeps it (an older node: null; offline: as last known)', { skip: !hasTools, timeout: 60_000 }, async () => {
  const { TlsManager } = require('../server/tls');
  const { createNodeWorker } = require('../server/nodeWorker');
  const { createNodes } = require('../server/nodes');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-nodehw-'));
  const GPU = Object.freeze({ id: 'pci:0000:03:00.0', kind: 'dri', vendor: 'intel', name: 'Intel GPU (0000:03:00.0)', node: '/dev/dri/renderD129', index: null, pci: '0000:03:00.0' });
  const CPU = Object.freeze({ id: 'cpu', kind: 'cpu', vendor: null, name: 'CPU (software encoder)', node: null, index: null, pci: null });
  const found = { gpus: [{ node: '/dev/dri/renderD129', vendor: 'intel', vendorName: 'Intel', name: 'Intel graphics (iHD)', passedThrough: true }], nvidia: [] };
  const start = async (sub, hardware) => {
    const t = new TlsManager({ dir: path.join(dir, sub, 'tls'), log: quiet, hostnames: ['127.0.0.1'] });
    await t.ensure();
    const runtime = {
      selectEncoder: async (family) => ({ codec: family === 'h265' ? 'libx265' : 'libsvtav1', hardware: false }),
      cpuEncoder: async (family) => ({ codec: family === 'h265' ? 'libx265' : 'libsvtav1', hardware: false }),
      localDevices: async () => [GPU, CPU],
      selectEncoderFor: async (family, device) => ({ family, codec: family === 'h265' ? 'libx265' : 'libsvtav1', hardware: false, device: { id: device.id, kind: device.kind } }),
      encodingNow: () => false
    };
    const worker = createNodeWorker({ db: memoryDb(), log: quiet, audit: quiet, authority: () => t.caPem(), workDir: path.join(dir, sub, 'work'), runtime: () => runtime, name: 'garage-pc', platform: 'linux', hardware });
    const server = http2.createSecureServer({ key: fs.readFileSync(path.join(dir, sub, 'tls', 'server.key')), cert: fs.readFileSync(path.join(dir, sub, 'tls', 'server.crt')), allowHTTP1: true }, async (req, res) => {
      if (!(await worker.handle(req, res, new URL(req.url, 'http://x').pathname, '127.0.0.1'))) { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { worker, server, port: server.address().port };
  };
  // as server/index.js gives it: the CPU model, usableGpus' names, each device's
  const w = await start('a', async (devices) => ({
    cpu: 'Intel(R) Core(TM) i5-12400', gpus: usableGpus(found).map((g) => g.name),
    devices: devices.map((d) => ({ id: d.id, name: d.id === 'cpu' ? 'Intel(R) Core(TM) i5-12400' : encodeGpuName(found, { device: d.device?.node || null, vendor: d.device?.vendor }) }))
  }));
  const old = await start('b', null);
  const nodes = createNodes({ db: memoryDb(), log: quiet, audit: quiet, name: 'main-nas', pollMs: 100 });
  try {
    const a = await nodes.add({ address: `127.0.0.1:${w.port}`, code: w.worker.startPairing().pairing.code });
    const b = await nodes.add({ address: `127.0.0.1:${old.port}`, code: old.worker.startPairing().pairing.code });
    await nodes.refresh(a.id);
    await nodes.refresh(b.id);
    const listed = nodes.hardware();
    assert.deepEqual(listed.map(({ id, hardware }) => ({ id, hardware })), [
      { id: a.id, hardware: { cpu: 'Intel(R) Core(TM) i5-12400', gpus: ['Intel graphics (iHD)'], devices: [{ id: GPU.id, name: 'Intel graphics (iHD)' }, { id: 'cpu', name: 'Intel(R) Core(TM) i5-12400' }] } },
      { id: b.id, hardware: null }
    ]);
    // the older node's devices come along: the heartbeat names its hardware from them
    assert.ok(listed[1].devices.some((d) => d.id !== 'cpu' && d.name));
    // the heartbeat of a main converting on that node's GPU
    const cs = createConvertStats({ db: memoryDb() });
    cs.sample([{ encoder: 'hevc_vaapi', hardware: true, remote: true, started: true, node: 'garage-pc', deviceId: `node:${a.id}@${GPU.id}`, fps: 90 }]);
    const hw = heartbeatHardware({ found: null, cpu: null, stats: cs, paired: listed });
    assert.deepEqual(hw.nodes[0], { cpu: 'Intel(R) Core(TM) i5-12400', gpus: ['Intel graphics (iHD)'], convert: { fps: 90, encoder: 'hevc_vaapi', device: 'Intel graphics (iHD)', api: 'vaapi', codec: 'h265' } });
    assert.deepEqual(hw.nodes[1].gpus, listed[1].devices.filter((d) => d.id !== 'cpu').map((d) => d.name.replace(/\s*\([0-9a-f:.]+\)$/i, '')), 'the older node: its GPUs by the names it lists');
    assert.ok(!JSON.stringify(hw.nodes[1]).match(/\d{4}:\d{2}:\d{2}\.\d/), 'no bus address');
    assert.ok(!JSON.stringify(hw.nodes).includes(a.id) && !JSON.stringify(hw.nodes).includes('garage-pc'));
    // offline: as last known
    w.server.close();
    w.server.closeAllConnections?.();
    await nodes.refresh(a.id);
    assert.equal(nodes.hardware()[0].hardware.cpu, 'Intel(R) Core(TM) i5-12400');
    assert.ok(nodes.hardware()[0].devices.length, 'offline: its devices as last listed too');
  } finally {
    w.server.close();
    old.server.close();
    w.worker.close();
    old.worker.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
