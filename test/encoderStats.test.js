'use strict';

// The Encoder's Hardware panel: the run's energy and device come from the
// right job, and no sentence about what limits the run is made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const { encoderBlock } = require('../server/encoderStats');

const worker = (over = {}) => ({ jobId: 'j1', itemId: 'i1', relativePath: 'RecentClips/a-front.mp4', encoder: 'hevc_vaapi', hardware: true, decode: 'gpu', device: '/dev/dri/renderD128', fps: 400, ...over });

test('the block names the running job, its GPU, energy and saved space', () => {
  const jobs = new Map([
    ['old', { id: 'old', state: 'completed', items: [] }],
    ['j1', { id: 'j1', state: 'encoding', createdAt: 1000, counters: { savedBytes: 5e9 },
      items: [{ kind: 'video', state: 'completed' }, { kind: 'video', state: 'completed', eligibleVideo: false }, { kind: 'video', state: 'waiting' }] }]
  ]);
  const snapshot = { cpu: { usage: 25 }, gpus: [{ name: 'Intel Arc A380', node: 'renderD128', video: 94 }], filesystems: [] };
  const energy = { byJob: { j1: { wh: 312.44, avgW: 67.6, seconds: 16000, cost: 0.041, base: { clips: 0, savedB: 1e9, wh: 12.44 } } } };
  const out = encoderBlock({ snapshot, jobs, workers: [worker(), worker({ jobId: 'other' })], energy });
  assert.equal(out.jobId, 'j1');
  assert.equal(out.running, true);
  assert.equal(out.workers.length, 1, 'only this job\'s clips');
  assert.deepEqual(out.device, { encoder: 'hevc_vaapi', hardware: true, gpuName: 'Intel Arc A380', node: '/dev/dri/renderD128', decode: 'gpu' });
  assert.deepEqual(out.run, { wh: 312.4, avgW: 68, cost: 0.041, clips: 1, savedB: 4e9, sinceWh: 300, cpuMeasured: null, startedAt: 1000 });
  assert.equal('bottleneck' in out, false, 'no bottleneck or room-to-spare sentence');
});

test('clips and space per kWh count from where the job stood when its energy began to be measured', () => {
  // the owner's run: 10,412 clips in when the container was restarted, energy measured since then
  const items = (n) => Array.from({ length: n }, () => ({ kind: 'video', state: 'completed' }));
  const job = (done, saved) => new Map([['j1', { id: 'j1', state: 'encoding', items: items(done), counters: { savedBytes: saved } }]]);
  const gpuOnly = { power: { totalW: 31, cpuW: null, gpuW: 31, cpuSource: null, gpuSource: 'hwmon' }, gpus: [] };
  const base = { clips: 10412, savedB: 211e12, wh: 0 };
  const block = (done, saved, wh, b = base, snapshot = gpuOnly) => encoderBlock({ snapshot, jobs: job(done, saved), workers: [worker()], energy: { byJob: { j1: { wh, avgW: 31, seconds: 90, cost: null, base: b } } } }).run;
  const start = block(10412, 211e12, 0.8);
  assert.deepEqual([start.wh, start.clips, start.savedB, start.sinceWh, start.cpuMeasured], [0.8, 0, 0, 0.8, false], 'nothing finished since measuring began');
  const later = block(10442, 211e12 + 6e9, 15.04);
  assert.deepEqual([later.wh, later.clips, later.savedB, later.sinceWh], [15, 30, 6e9, 15]);
  // a record saved before baselines were kept: measured on from its baseline's Wh
  const old = block(10442, 211e12 + 6e9, 15.04, { ...base, wh: 10 });
  assert.equal(old.sinceWh, 5);
  // no baseline yet (the job was not known when its energy began): nothing to divide yet
  assert.deepEqual(['clips', 'savedB', 'sinceWh'].map((k) => block(10442, 1, 3, null)[k]), [0, 0, 0]);
  // never negative (a retried clip, a smaller saving)
  assert.deepEqual(['clips', 'savedB'].map((k) => block(10400, 200e12, 3)[k]), [0, 0]);
  // no power reading at all: the job's own totals, with no energy to divide by
  const none = encoderBlock({ snapshot: {}, jobs: job(12, 5e9), workers: [worker()], energy: { byJob: {} } }).run;
  assert.deepEqual([none.wh, none.clips, none.savedB, none.sinceWh], [null, 12, 5e9, null]);
});

test('whether the CPU was measured stays put for the job while a sample cannot tell', () => {
  const items = [{ kind: 'video', state: 'completed' }];
  const measured = (id, power) => encoderBlock({ snapshot: { power, gpus: [] }, jobs: new Map([[id, { id, state: 'encoding', items, counters: {} }]]), workers: [worker({ jobId: id })], energy: { byJob: { [id]: { wh: 3, avgW: 31, seconds: 90, cost: null, base: null } } } }).run.cpuMeasured;
  const gpuOnly = { cpuSource: null, gpuSource: 'hwmon' };
  const none = { cpuSource: null, gpuSource: null };
  const rapl = { cpuSource: 'rapl', gpuSource: 'hwmon' };
  // the owner's server (no RAPL): a sample without the GPU's reading is still GPU only
  assert.equal(measured('apu', none), null, 'nothing known yet');
  assert.equal(measured('apu', gpuOnly), false);
  assert.equal(measured('apu', none), false, 'no reading this time: as before');
  // with RAPL, a stale CPU reading does not make the run GPU only for a poll
  assert.equal(measured('rapl', rapl), true);
  assert.equal(measured('rapl', gpuOnly), true);
  assert.equal(measured('rapl', none), true);
  // another job starts over
  assert.equal(measured('next', gpuOnly), false);
});

test('the Hardware panel: per kWh from 0, counting up as clips finish; Wh below 1 kWh; GPU only when the CPU is not measured', async () => {
  const path = require('path');
  const { pathToFileURL } = require('url');
  const { renderHardware, energyText, panelMemory } = await import(pathToFileURL(path.join(__dirname, '..', 'src/renderer/scripts/features/hardwarePanel.js')).href);
  const panel = (run, memo = null) => renderHardware({ encoder: { running: true, state: 'encoding', workers: [worker()], device: { encoder: 'hevc_vaapi', hardware: true }, run } }, memo);
  const eff = (html) => Object.fromEntries([...html.matchAll(/<div><span>([^<]+)<\/span><b>([^<]+)<\/b><\/div>/g)].map((m) => [m[1], m[2]]));
  // the owner's screen after the restart: 0.8 Wh measured, nothing finished since
  const start = panel({ wh: 0.8, clips: 0, savedB: 0, sinceWh: 0.8, cpuMeasured: false });
  assert.deepEqual(eff(start), { 'This run': '0.8 Wh', 'Clips per kWh': '0', 'Space saved per kWh': '0 GB' });
  assert.match(start, /<p class="nd-eff-note">GPU only \(CPU not measured\)<\/p>/);
  // until 10 Wh are measured, each clip counts up from 0 (no ratio of a
  // fraction of a Wh); from there on the real ratio, with no jump between
  const perKwh = (clips, sinceWh) => eff(panel({ wh: 16.5 + sinceWh, clips, savedB: clips * 2e8, sinceWh, cpuMeasured: false }))['Clips per kWh'];
  assert.deepEqual([[1, 0.1], [2, 0.9], [3, 1.2], [44, 4], [100, 9.9]].map(([c, w]) => perKwh(c, w)), ['100', '200', '300', '4,400', '10,000']);
  assert.equal(perKwh(100, 10), '10,000', 'the same at the floor');
  assert.equal(perKwh(440, 10), '44,000');
  assert.equal(perKwh(880, 20), '44,000');
  assert.equal(eff(panel({ wh: 0.9, clips: 2, savedB: 4e8, sinceWh: 0.9, cpuMeasured: false }))['Space saved per kWh'], '37.3 GB');
  const later = eff(panel({ wh: 12.4, clips: 30, savedB: 6 * 1024 ** 3, sinceWh: 12, cpuMeasured: true }));
  assert.deepEqual(later, { 'This run': '12.4 Wh', 'Clips per kWh': '2,500', 'Space saved per kWh': '500 GB' });
  assert.doesNotMatch(panel({ wh: 12.4, clips: 30, savedB: 1, sinceWh: 12, cpuMeasured: true }), /GPU only/);
  // a server that sends no sinceWh (an older one): no ratio of the whole job's clips
  assert.equal(eff(panel({ wh: 0.8, clips: 10412, savedB: 2e12 }))['Clips per kWh'], '0');
  assert.equal(eff(panel({ wh: 1840, clips: 96, savedB: 1, sinceWh: 1840 }))['This run'], '1.8 kWh');
  // the GPU only line stays while a sample cannot tell
  const memo = panelMemory();
  const note = /nd-eff-note/;
  assert.match(panel({ wh: 2, clips: 1, savedB: 1, sinceWh: 2, cpuMeasured: false }, memo), note);
  assert.match(panel({ wh: 2.1, clips: 1, savedB: 1, sinceWh: 2.1, cpuMeasured: null }, memo), note, 'kept');
  assert.doesNotMatch(panel({ wh: 2.1, clips: 1, savedB: 1, sinceWh: 2.1, cpuMeasured: null }), note, 'never known: no line');
  assert.equal(energyText(12.44), '12.4 Wh');
  assert.equal(energyText(0), '0.0 Wh');
  assert.equal(energyText(99.96), '100 Wh');
  assert.equal(energyText(412), '412 Wh', 'no .0 for hundreds');
  assert.equal(energyText(999.4), '999 Wh');
  assert.equal(energyText(999.96), '1.0 kWh');
  assert.equal(energyText(99960), '100 kWh');
  assert.equal(energyText(250000), '250 kWh');
});

test('the block says how many clips the job converts at once (the panel keeps a row for each)', () => {
  const block = (config, slotsOf = null) => encoderBlock({ snapshot: {}, jobs: new Map([['j1', { id: 'j1', state: 'encoding', items: [], counters: {}, config }]]), workers: [worker()], slotsOf });
  assert.equal(block({ concurrency: 4 }).concurrency, 4);
  assert.equal(block({ concurrency: 4, lanes: [{ device: 'pci:0000:03:00.0', concurrency: 3 }, { device: 'cpu', concurrency: 1 }] }).concurrency, 4);
  assert.equal(block({ lanes: [{ device: 'pci:0000:03:00.0', concurrency: 3 }, { device: 'cpu', concurrency: 2 }] }).concurrency, 5, 'the lanes together');
  assert.equal(block({}).concurrency, null);
  assert.equal(block({ concurrency: 'x', lanes: 'y' }).concurrency, null);
  // as the converter runs the job: a lane whose GPU is not in the container starts none
  const lanes = { concurrency: 4, lanes: [{ device: 'pci:0000:c5:00.0', concurrency: 2 }, { device: 'pci:0000:03:00.0', concurrency: 2 }] };
  const asked = [];
  assert.equal(block(lanes, (id) => { asked.push(id); return 2; }).concurrency, 2);
  assert.deepEqual(asked, ['j1']);
  for (const odd of [() => null, () => 0, () => 'x', () => { throw new Error('gone'); }]) assert.equal(block(lanes, odd).concurrency, 4, 'else the job\'s own number');
});

test('no job and nothing running: no block', () => {
  assert.equal(encoderBlock({ snapshot: {}, jobs: new Map([['x', { id: 'x', state: 'completed' }]]) }), null);
});

test('one GPU, no lanes: a clip decoded or redone on the CPU keeps the panel as it always was', async () => {
  const path = require('path');
  const { pathToFileURL } = require('url');
  const { renderHardware } = await import(pathToFileURL(path.join(__dirname, '..', 'src/renderer/scripts/features/hardwarePanel.js')).href);
  const jobs = new Map([['j1', { id: 'j1', state: 'encoding', items: [], counters: {} }]]);
  const snapshot = { cpu: { usage: 30 }, gpus: [{ name: 'Intel Arc A380', node: 'renderD128', video: 95, busy: 20 }], filesystems: [] };
  const page = (workers) => {
    const encoder = encoderBlock({ snapshot, jobs, workers });
    return { encoder, html: renderHardware({ ...snapshot, encoder }) };
  };
  const qsv = (over) => worker({ encoder: 'hevc_qsv', deviceId: null, ...over });
  // QSV decoding on the GPU names renderD128; a clip decoded on the CPU names no node
  const cpuDecode = page([qsv({ itemId: 'a' }), qsv({ itemId: 'b' }), qsv({ itemId: 'c', device: null, decode: 'cpu' })]);
  // a clip redone with the CPU encoder after a failed GPU encode
  const redone = page([worker({ itemId: 'a', deviceId: null }), worker({ itemId: 'b', deviceId: null, encoder: 'libx265', hardware: false, decode: 'cpu', device: null })]);
  for (const { encoder, html } of [cpuDecode, redone]) {
    assert.equal(encoder.devices.length, 1, 'one device: the GPU the job uses');
    assert.doesNotMatch(html, /nd-devices/, 'no line per device');
    assert.match(html, /<span>Video engine<\/span>/);
  }
  assert.match(cpuDecode.html, /hevc_qsv · Intel Arc A380 · renderD128/, 'the encoder chip stays');
  assert.match(redone.html, /hevc_vaapi · Intel Arc A380 · renderD128/);
});

test('a GPU lane next to the CPU lane: the GPU comes first whichever clip is listed first', () => {
  const jobs = new Map([['j1', { id: 'j1', state: 'encoding', items: [], counters: {} }]]);
  const snapshot = { cpu: { usage: 30 }, gpus: [{ name: 'Intel Arc A380', node: 'renderD128', video: 97 }, { name: 'NVIDIA T400', node: 'nvidia0', video: 0 }], filesystems: [] };
  const arc = (itemId) => worker({ itemId, encoder: 'hevc_qsv', deviceId: 'pci:0000:03:00.0' });
  const cpu = worker({ itemId: 'c', encoder: 'libx265', hardware: false, decode: 'cpu', device: null, deviceId: 'cpu' });
  for (const workers of [[cpu, arc('a'), arc('b')], [arc('a'), cpu, arc('b')]]) {
    const out = encoderBlock({ snapshot, jobs, workers });
    assert.deepEqual(out.devices.map((d) => [d.id, d.name, d.workers, d.video]), [['pci:0000:03:00.0', 'Intel Arc A380', 2, 97], ['cpu', 'CPU', 1, null]], workers.map((w) => w.itemId).join());
    assert.equal('bottleneck' in out, false);
  }
});
