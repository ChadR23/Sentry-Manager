'use strict';

// The Encoder page with several GPUs: one "at once" row per GPU (and the
// CPU) instead of the single number, what Start, the automatic settings and
// live changes send, and the benchmark with a section per GPU. Driven
// through the real controller with a small stand-in DOM. A server with one
// GPU (or none) must look and behave exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..');
const MODULE = pathToFileURL(path.join(REPO, 'src/renderer/scripts/features/footageConverter.js')).href;
const HARDWARE = pathToFileURL(path.join(REPO, 'src/renderer/scripts/features/hardwarePanel.js')).href;

// ---- a stand-in DOM: just what the controller uses ------------------------
class Node {
  constructor(doc, tag) {
    Object.assign(this, {
      ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parent: null, text: '', attributes: {}, dataset: {},
      hidden: false, disabled: false, checked: false, className: '', title: '', type: '', value: '', style: {}, listeners: {}
    });
  }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (name) => names().includes(name),
      add: (name) => { if (!names().includes(name)) this.className = [...names(), name].join(' '); },
      toggle: (name, force) => {
        const on = force === undefined ? !names().includes(name) : Boolean(force);
        this.className = [...names().filter((n) => n !== name), ...(on ? [name] : [])].join(' ');
        return on;
      }
    };
  }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this.text; }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  append(...nodes) {
    for (const node of nodes) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.text = '';
    this.append(...nodes);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ target: this }); }
  click() { if (!this.disabled) this.fire('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() {}
  close() {}
  /** every descendant matching the test */
  all(match) { return this.children.flatMap((c) => [...(match(c) ? [c] : []), ...c.all(match)]); }
  find(match) { return this.all(match)[0] || null; }
}

function makeDoc() {
  const doc = { activeElement: null, createElement: (tag) => new Node(doc, tag) };
  return doc;
}

function makeElements(doc) {
  const el = (tag = 'div', init = {}) => Object.assign(doc.createElement(tag), init);
  const option = (key, value, checked) => { const o = el('input', { checked }); o.dataset[key] = value; return o; };
  const elements = {
    sourcePath: el('input', { value: '/footage/model3' }), destinationPath: el('input', { value: '/out' }),
    groupOptions: [option('converterGroup', 'RecentClips', true)],
    orderRows: [], profileOptions: [], pipelineStages: [],
    codecOptions: [option('converterCodec', 'h265', true), option('converterCodec', 'av1', false)],
    outputOptions: [option('converterOutput', 'separate', true)],
    profileSelect: el('select', { value: 'balanced' }), verifyMode: el('select', { value: 'quick' }),
    concurrency: el('select', { value: '5' }), concurrencyCustom: el('input', { value: '12' }), concurrencyCustomRow: el('label', { hidden: true }),
    lanes: el('div', { hidden: true }), lanesTotal: el('p'),
    autoEnabled: el('input'), autoInterval: el('select', { value: '60' }), autoWindowEnabled: el('input'), autoStart: el('select', { value: '1' }),
    autoEnd: el('select', { value: '6' }), autoOffPeak: el('input'), autoHoldManual: el('input'), autoKeepRunning: el('input'), autoLogin: el('input'),
    autoStatus: el(), startButton: el('button'),
    benchmarkButton: el('button'), benchmarkDialog: el('dialog'), benchmarkIntro: el('p', { text: 'one-GPU intro' }), benchmarkStatus: el('p'),
    benchmarkTable: el('table', { hidden: true }), benchmarkHead: el('thead'), benchmarkRows: el('tbody'),
    benchmarkVerifyTable: el('table', { hidden: true }), benchmarkVerifyHead: el('thead'), benchmarkVerifyRows: el('tbody'),
    benchmarkBest: el('p', { hidden: true }), benchmarkDevices: el('div', { hidden: true }),
    benchmarkRun: el('button'), benchmarkApply: el('button', { hidden: true }), benchmarkApplyAlt: el('button', { hidden: true }), benchmarkClose: el('button')
  };
  elements.lanes.append(elements.lanesTotal);
  return elements;
}

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

const ARC = { id: 'pci:0000:03:00.0', kind: 'dri', vendor: 'intel', name: 'Intel Arc A380', node: '/dev/dri/renderD128', index: null, pci: '0000:03:00.0', encoders: { h265: 'hevc_qsv', av1: 'av1_qsv' } };
const UHD = { id: 'pci:0000:00:02.0', kind: 'dri', vendor: 'intel', name: 'Intel UHD Graphics 770', node: '/dev/dri/renderD129', index: null, pci: '0000:00:02.0', encoders: { h265: 'hevc_qsv', av1: null } };
const CPU = { id: 'cpu', kind: 'cpu', vendor: null, name: 'CPU (software encoder)', node: null, index: null, pci: null, encoders: { h265: 'libx265', av1: 'libsvtav1' } };
const TWO = { devices: [ARC, UHD, CPU], defaultDevice: ARC.id };
const ONE = { devices: [ARC, CPU], defaultDevice: ARC.id };

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function page({ devices = TWO, job = null, storage = makeStorage(), benchmark = null, startError = null, api: extra = {} } = {}) {
  const { createFootageConverterController } = await import(MODULE);
  const doc = makeDoc();
  const elements = makeElements(doc);
  const sent = { start: [], conc: [], lanes: [], auto: [], benchmark: [], notes: [] };
  let revision = 10;
  let progress = null;
  const delay = () => new Promise((resolve) => setTimeout(resolve, 10));
  // the job on the server, as the backend keeps it
  let jobConfig = job?.config || null;
  const api = {
    getConverterDevices: async () => (devices instanceof Error ? { ok: false, error: { code: 'NETWORK_ERROR' } } : { ok: true, value: devices }),
    getConverterAuto: async () => ({ ok: true, value: { settings: { enabled: false, intervalMinutes: 60, window: null, config: null }, status: {} } }),
    setConverterAuto: async (s) => { sent.auto.push(s); return { ok: true, value: { settings: s, status: {} } }; },
    getConverterCapabilities: async () => ({ ok: true, value: { replacement: 'available' } }),
    getCurrentConverterJob: async () => ({ ok: true, value: job }),
    startConverter: async (config) => {
      sent.start.push(config);
      if (startError) return { ok: false, error: startError };
      jobConfig = config;
      return { ok: true, value: { jobId: 'job-2' } };
    },
    setConverterConcurrency: async (id, concurrency) => {
      sent.conc.push([id, concurrency]);
      await delay();
      // (setConcurrency is refused on a job with lanes)
      if (jobConfig?.lanes) return { ok: false, error: { code: 'INVALID_CONCURRENCY' } };
      jobConfig = { ...jobConfig, concurrency };
      return { ok: true, value: { id, revision: ++revision, state: 'encoding', config: jobConfig, items: [] } };
    },
    setConverterLanes: async (id, lanes) => {
      sent.lanes.push([id, lanes]);
      await delay();
      jobConfig = { ...jobConfig, lanes, concurrency: lanes.reduce((s, l) => s + l.concurrency, 0) };
      return { ok: true, value: { id, revision: ++revision, state: 'encoding', config: jobConfig, items: [] } };
    },
    runConverterBenchmark: async (request, onProgress) => {
      sent.benchmark.push(request);
      for (const p of benchmark?.progress || []) onProgress(p);
      return { ok: true, value: benchmark?.result };
    },
    onConverterProgress: (cb) => { progress = cb; return () => {}; },
    ...extra
  };
  const c = createFootageConverterController({ api, elements, storage, autoPollMs: 0, notify: (text, opts) => sent.notes.push([text, opts?.type]) });
  await c.init();
  await settle();
  const row = (id) => elements.lanes.find((n) => n.dataset.device === id);
  const lane = (id) => {
    const r = row(id);
    if (!r) return null;
    const [minus, plus] = r.all((n) => n.tagName === 'BUTTON');
    return {
      row: r, minus, plus,
      count: r.find((n) => n.tagName === 'OUTPUT').textContent,
      name: r.find((n) => n.tagName === 'STRONG').textContent,
      note: r.find((n) => n.tagName === 'SMALL').textContent,
      label: r.find((n) => n.className === 'converter-stepper').getAttribute('aria-label')
    };
  };
  const start = async () => {
    elements.startButton.fire('click');
    await settle();
    return sent.start.at(-1);
  };
  const push = (snapshot) => progress({ jobId: snapshot.id, revision: snapshot.revision, snapshot });
  return { c, doc, elements, sent, storage, lane, row, start, push };
}

const running = (config) => ({ id: 'job-1', revision: 1, state: 'encoding', config, items: [] });

test('one GPU (or none): the single number, and Start sends just that, as before', async () => {
  for (const devices of [ONE, { devices: [CPU], defaultDevice: 'cpu' }, new Error('down')]) {
    const p = await page({ devices });
    assert.equal(p.elements.concurrency.hidden, false, 'the select stays');
    assert.equal(p.elements.lanes.hidden, true, 'no rows');
    assert.equal(p.elements.lanes.children.length, 1, 'only the (empty) total line');
    assert.equal(p.elements.benchmarkIntro.textContent, 'one-GPU intro');
    const config = await p.start();
    assert.equal(config.concurrency, 5);
    assert.ok(!('lanes' in config), 'no lanes in a one-GPU job');
  }
  // the Electron app has no devices call at all
  const p = await page({ api: { getConverterDevices: undefined } });
  assert.equal(p.elements.lanes.hidden, true);
  assert.ok(!('lanes' in await p.start()));
});

test('two GPUs: a row per GPU and the CPU; the default GPU starts with the number, the rest Off', async () => {
  const p = await page({ storage: makeStorage({ converterConcurrency: '3' }) });
  assert.equal(p.elements.concurrency.hidden, true, 'the single select gives way');
  assert.equal(p.elements.concurrencyCustomRow.hidden, true);
  assert.equal(p.elements.lanes.hidden, false);
  assert.deepEqual(p.elements.lanes.children.map((n) => n.dataset.device || 'total'), [ARC.id, UHD.id, 'cpu', 'total'], 'CPU last, the total under the rows');
  const arc = p.lane(ARC.id);
  assert.equal(arc.count, '3');
  assert.equal(arc.name, 'Intel Arc A380');
  assert.equal(arc.note, 'H.265: hevc_qsv · AV1: av1_qsv');
  assert.equal(arc.label, 'Intel Arc A380: conversions at once');
  assert.deepEqual([arc.minus.getAttribute('aria-label'), arc.minus.textContent, arc.plus.getAttribute('aria-label'), arc.plus.textContent], ['Fewer', '−', 'More', '+']);
  assert.equal(p.lane(UHD.id).count, 'Off');
  assert.equal(p.lane(UHD.id).note, 'H.265: hevc_qsv', 'only what it can encode');
  assert.equal(p.lane('cpu').count, 'Off');
  assert.equal(p.lane('cpu').note, "Uses the server's CPU cores; slower than a GPU");
  assert.equal(p.elements.lanesTotal.textContent, '3 at once in total. Each GPU takes its next clip when it is free, so a faster one converts more of them.');
  assert.match(p.elements.benchmarkIntro.textContent, /on each GPU in turn/);
  assert.match(p.elements.benchmarkIntro.textContent, /\(Quick, Full\)/);
  // without a stored number: 5
  assert.equal((await page()).lane(ARC.id).count, '5');
  // two cards of the same model are told apart
  const twins = await page({ devices: { devices: [ARC, { ...ARC, id: 'pci:0000:04:00.0', node: '/dev/dri/renderD129', pci: '0000:04:00.0' }, CPU], defaultDevice: ARC.id } });
  assert.equal(twins.lane(ARC.id).name, 'Intel Arc A380 (renderD128)');
  assert.equal(twins.lane('pci:0000:04:00.0').name, 'Intel Arc A380 (renderD129)');
});

test('send rule: lanes only when more than the default GPU converts; rows are remembered', async () => {
  const storage = makeStorage({ converterConcurrency: '3' });
  const p = await page({ storage });
  let config = await p.start();
  assert.equal(config.concurrency, 3);
  assert.ok(!('lanes' in config), 'only the default GPU: the plain number, today\'s path');
  p.lane(UHD.id).plus.click();
  config = await p.start();
  assert.deepEqual(config.lanes, [{ device: ARC.id, concurrency: 3 }, { device: UHD.id, concurrency: 1 }]);
  assert.equal(config.concurrency, 4, 'the sum rides along');
  assert.equal(p.elements.lanesTotal.textContent.split('.')[0], '4 at once in total');
  for (let i = 0; i < 3; i++) p.lane(ARC.id).minus.click();
  assert.equal(p.lane(ARC.id).count, 'Off');
  config = await p.start();
  assert.deepEqual(config.lanes, [{ device: UHD.id, concurrency: 1 }], 'another GPU alone is a lane too');
  // the last one on can't be turned off; the total never passes 64
  assert.equal(p.lane(UHD.id).minus.disabled, true);
  assert.deepEqual(JSON.parse(storage.map.get('converterLanes')), { [ARC.id]: 0, [UHD.id]: 1, cpu: 0 });
  // the next visit comes back to the same rows
  const again = await page({ storage });
  assert.deepEqual([again.lane(ARC.id).count, again.lane(UHD.id).count, again.lane('cpu').count], ['Off', '1', 'Off']);
  // automatic conversion saves the same thing
  p.lane('cpu').plus.click();
  p.elements.autoEnabled.checked = true;
  p.elements.autoEnabled.fire('change');
  await settle();
  assert.deepEqual(p.sent.auto.at(-1).config.lanes, [{ device: UHD.id, concurrency: 1 }, { device: 'cpu', concurrency: 1 }]);
  assert.equal(p.sent.auto.at(-1).config.concurrency, 2);
});

test('live during a run: the plain number while only the default GPU, lanes otherwise, the last choice wins', async () => {
  const p = await page({ job: running({ concurrency: 3 }), storage: makeStorage() });
  assert.equal(p.lane(ARC.id).count, '3', 'the rows show the running job');
  p.lane(ARC.id).plus.click();
  await settle();
  assert.deepEqual(p.sent.conc, [['job-1', 4]], 'a job without lanes, default GPU only: setConverterConcurrency');
  assert.deepEqual(p.sent.lanes, []);
  assert.equal(p.sent.notes.at(-1)[0], 'Now 4 on Intel Arc A380. Clips already converting finish first.');
  p.lane(UHD.id).plus.click();
  await settle();
  assert.deepEqual(p.sent.lanes, [['job-1', [{ device: ARC.id, concurrency: 4 }, { device: UHD.id, concurrency: 1 }]]]);
  assert.equal(p.sent.notes.at(-1)[0], 'Now 4 on Intel Arc A380 and 1 on Intel UHD Graphics 770. Clips already converting finish first.');
  // quick changes go one after another; back to the default GPU alone on
  // a job that now has lanes is a lane change, not a plain number
  p.lane(UHD.id).minus.click();
  p.lane(ARC.id).plus.click();
  p.lane('cpu').plus.click();
  await settle(120);
  assert.equal(p.sent.conc.length, 1, 'setConverterConcurrency is never used on a lanes job');
  assert.deepEqual(p.sent.lanes.slice(1).map(([, lanes]) => lanes), [
    [{ device: ARC.id, concurrency: 4 }],
    [{ device: ARC.id, concurrency: 5 }],
    [{ device: ARC.id, concurrency: 5 }, { device: 'cpu', concurrency: 1 }]
  ]);
  assert.equal(p.sent.notes.at(-1)[0], 'Now 5 on Intel Arc A380 and 1 on CPU (software encoder). Clips already converting finish first.');
  assert.equal(p.c.snapshot.config.concurrency, 6);
});

test('a live change the server refuses: the error is shown and the rows go back to the job', async () => {
  const p = await page({ job: running({ concurrency: 3 }), api: { setConverterLanes: async () => ({ ok: false, error: { code: 'INVALID_LANES' } }) } });
  p.lane(UHD.id).plus.focus();
  p.lane(UHD.id).plus.click();
  assert.equal(p.lane(UHD.id).count, '1');
  await settle();
  assert.deepEqual(p.sent.notes.at(-1), ["These GPU settings can't be used. Reload the page and set them again.", 'error']);
  assert.deepEqual([p.lane(ARC.id).count, p.lane(UHD.id).count], ['3', 'Off'], 'what the job really runs, even with the button focused');
});

test('a GPU that can\'t encode the codec says so, is Off and disabled, and is never sent', async () => {
  const p = await page({ storage: makeStorage({ converterConcurrency: '3' }) });
  p.lane(UHD.id).plus.click();
  p.lane(UHD.id).plus.click();
  p.elements.codecOptions[0].checked = false;
  p.elements.codecOptions[1].checked = true;
  p.elements.codecOptions[1].fire('change');
  const uhd = p.lane(UHD.id);
  assert.equal(uhd.note, "Can't encode AV1");
  assert.equal(uhd.count, 'Off');
  assert.equal(uhd.plus.disabled, true);
  assert.equal(uhd.minus.disabled, true);
  assert.ok(uhd.row.classList.contains('is-unsupported'));
  uhd.plus.fire('click');
  assert.equal(p.lane(UHD.id).count, 'Off', 'even a click that gets through changes nothing');
  // back to H.265: the row has its number again
  const pick = (index) => {
    p.elements.codecOptions.forEach((option, i) => { option.checked = i === index; });
    p.elements.codecOptions[index].fire('change');
  };
  pick(0);
  assert.equal(p.lane(UHD.id).count, '2');
  assert.equal(p.lane(UHD.id).note, 'H.265: hevc_qsv');
  pick(1);
  const config = await p.start();
  assert.equal(config.codec, 'av1');
  assert.equal(config.concurrency, 3);
  assert.ok(!('lanes' in config), 'the Arc alone again: the plain number');
});

test('during a run the rows are for the running job\'s codec, and a GPU it converts on is never dropped', async () => {
  const lanes = [{ device: UHD.id, concurrency: 5 }, { device: ARC.id, concurrency: 3 }];
  // an H.265 job on the UHD 770 and the Arc; AV1 clicked meanwhile (that is for the next job)
  const p = await page({ job: running({ codec: 'h265', lanes, concurrency: 8 }) });
  assert.deepEqual([p.lane(ARC.id).count, p.lane(UHD.id).count], ['3', '5']);
  p.elements.codecOptions[0].checked = false;
  p.elements.codecOptions[1].checked = true;
  p.elements.codecOptions[1].fire('change');
  assert.equal(p.lane(UHD.id).count, '5', 'still the running job\'s rows');
  assert.equal(p.lane(UHD.id).plus.disabled, false);
  p.lane('cpu').plus.click();
  await settle();
  assert.deepEqual(p.sent.lanes, [['job-1', [{ device: ARC.id, concurrency: 3 }, { device: UHD.id, concurrency: 5 }, { device: 'cpu', concurrency: 1 }]]],
    'the UHD keeps its 5');

  // the device list says the UHD can't (its test encode failed while it was busy), yet the job converts on it
  const busy = { ...UHD, encoders: { h265: null, av1: null } };
  const q = await page({ devices: { devices: [ARC, busy, CPU], defaultDevice: ARC.id }, job: running({ codec: 'h265', lanes, concurrency: 8 }) });
  assert.equal(q.lane(UHD.id).count, '5');
  q.lane(ARC.id).plus.click();
  await settle();
  assert.deepEqual(q.sent.lanes, [['job-1', [{ device: ARC.id, concurrency: 4 }, { device: UHD.id, concurrency: 5 }]]]);
});

test('the default GPU is per codec: AV1 goes to the GPU a job without lanes uses for AV1, sent as the plain number', async () => {
  // an Arc A380 and a T400 (NVENC: H.265 only); without lanes H.265 runs on the T400 and AV1 on the Arc
  const T400 = { id: 'pci:0000:01:00.0', kind: 'nvidia', vendor: 'nvidia', name: 'NVIDIA T400', node: null, index: 0, pci: '0000:01:00.0', encoders: { h265: 'hevc_nvenc', av1: null } };
  const devices = { devices: [ARC, T400, CPU], defaultDevice: T400.id, defaultDevices: { h265: T400.id, av1: ARC.id } };
  const pick = (p, index) => {
    p.elements.codecOptions.forEach((option, i) => { option.checked = i === index; });
    p.elements.codecOptions[index].fire('change');
  };
  const p = await page({ devices, storage: makeStorage({ converterConcurrency: '3' }) });
  assert.deepEqual([p.lane(ARC.id).count, p.lane(T400.id).count], ['Off', '3'], 'H.265: the T400');
  // nothing set by hand yet: the number follows the codec's default GPU
  pick(p, 1);
  assert.deepEqual([p.lane(ARC.id).count, p.lane(T400.id).count], ['3', 'Off'], 'AV1: the Arc');
  let config = await p.start();
  assert.equal(config.codec, 'av1');
  assert.equal(config.concurrency, 3);
  assert.ok(!('lanes' in config), 'today\'s path for AV1');
  // set by hand: the rows stay as they are
  const q = await page({ devices, storage: makeStorage({ converterConcurrency: '3' }) });
  pick(q, 1);
  q.lane('cpu').plus.click();
  pick(q, 0);
  assert.deepEqual([q.lane(ARC.id).count, q.lane(T400.id).count, q.lane('cpu').count], ['3', 'Off', '1']);
  const h265 = await page({ devices, storage: makeStorage({ converterConcurrency: '3' }) });
  assert.ok(!('lanes' in await h265.start()), 'H.265 on the T400 alone: the plain number');

  // the last job was AV1 without lanes: its number is on the Arc
  const lastConfig = { sourceRoot: '/footage/model3', destinationRoot: '/out', codec: 'av1', profileId: 'balanced', outputMode: 'separate',
    includedGroups: ['RecentClips'], verifyMode: 'quick', concurrency: 4 };
  const last = await page({ devices, job: { id: 'job-1', revision: 1, state: 'completed', config: lastConfig, items: [] } });
  assert.deepEqual([last.lane(ARC.id).count, last.lane(T400.id).count], ['4', 'Off']);
  config = await last.start();
  assert.equal(config.codec, 'av1');
  assert.ok(!('lanes' in config));
  assert.equal(config.concurrency, 4);

  // a default GPU that can't encode the codec (a GT 1030 without NVENC next to an RTX): the first one that can
  const GT = { ...T400, name: 'NVIDIA GeForce GT 1030', encoders: { h265: null, av1: null } };
  const RTX = { ...T400, id: 'pci:0000:02:00.0', pci: '0000:02:00.0', index: 1, name: 'NVIDIA GeForce RTX 3060', encoders: { h265: 'hevc_nvenc', av1: null } };
  const nv = await page({ devices: { devices: [GT, RTX, CPU], defaultDevice: null, defaultDevices: { h265: null, av1: null } } });
  assert.deepEqual([nv.lane(GT.id).count, nv.lane(RTX.id).count], ['Off', '5']);
  assert.deepEqual((await nv.start()).lanes, [{ device: RTX.id, concurrency: 5 }]);
});

test('Start refused with DEVICE_UNSUPPORTED names the GPU and the codec', async () => {
  const p = await page({ startError: { code: 'DEVICE_UNSUPPORTED', details: { device: 'Intel UHD Graphics 770', codec: 'av1' } } });
  await p.start();
  assert.deepEqual(p.sent.notes.at(-1), ["Intel UHD Graphics 770 can't encode AV1. Set it to Off or pick another codec.", 'error']);
});

test('the rows follow the job (its lanes, or its number on the default GPU), but not while a stepper has focus', async () => {
  const p = await page({ job: running({ concurrency: 2 }) });
  assert.deepEqual([p.lane(ARC.id).count, p.lane(UHD.id).count], ['2', 'Off']);
  p.push({ ...running({ lanes: [{ device: UHD.id, concurrency: 2 }, { device: 'cpu', concurrency: 1 }], concurrency: 3 }), revision: 20 });
  assert.deepEqual([p.lane(ARC.id).count, p.lane(UHD.id).count, p.lane('cpu').count], ['Off', '2', '1']);
  p.lane(ARC.id).plus.focus();
  p.push({ ...running({ lanes: [{ device: ARC.id, concurrency: 6 }], concurrency: 6 }), revision: 21 });
  assert.deepEqual([p.lane(ARC.id).count, p.lane(UHD.id).count], ['Off', '2'], 'the owner is on it');
  p.doc.activeElement = null;
  p.push({ ...running({ lanes: [{ device: ARC.id, concurrency: 6 }], concurrency: 6 }), revision: 22 });
  assert.deepEqual([p.lane(ARC.id).count, p.lane(UHD.id).count, p.lane('cpu').count], ['6', 'Off', 'Off']);
  // a saved lanes value naming a GPU that is gone: its number lands on the default GPU
  p.push({ ...running({ lanes: [{ device: 'pci:0000:09:00.0', concurrency: 4 }], concurrency: 4 }), revision: 23 });
  assert.equal(p.lane(ARC.id).count, '4');
});

// ---- benchmark --------------------------------------------------------------
const level = (n, rate, extra = {}) => ({ level: n, ok: true, filesPerMinute: rate, fps: rate * 10, savedPercent: 40, ...extra });
const verify = (best) => [
  { verifyMode: 'quick', ok: true, filesPerMinute: best, verifySecondsPerClip: 0.4 },
  { verifyMode: 'full', ok: true, filesPerMinute: best - 2, verifySecondsPerClip: 2.1 }
];
const run = (codec, encoder, levels, bestLevel) => {
  const results = levels.map(([n, rate]) => level(n, rate));
  const best = results.find((r) => r.level === bestLevel);
  return { codec, encoder: { codec: encoder, hardware: true }, clips: 8, results, best, efficient: null, verifyComparison: verify(best.filesPerMinute), skipped: [] };
};
const DEVICES_RESULT = {
  devices: [
    { device: { id: ARC.id, name: ARC.name }, codecs: [run('h265', 'hevc_qsv', [[1, 5], [2, 9], [4, 14]], 4), run('av1', 'av1_qsv', [[1, 4], [2, 7], [4, 8]], 2)] },
    { device: { id: UHD.id, name: UHD.name }, codecs: [run('h265', 'hevc_qsv', [[1, 3], [2, 5], [4, 5]], 2), { codec: 'av1', error: 'UNSUPPORTED' }] }
  ]
};

test('benchmark with several GPUs: a section per GPU, its own tables and lines, no Off', async () => {
  const p = await page({
    storage: makeStorage({ converterConcurrency: '3' }),
    benchmark: {
      result: DEVICES_RESULT,
      progress: [{ step: 'run', codec: 'h265', codecIndex: 1, codecTotal: 2, level: 4, index: 3, total: 5, device: { id: ARC.id, name: ARC.name }, deviceIndex: 1, deviceTotal: 2 }]
    }
  });
  const statuses = [];
  const set = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent').set;
  Object.defineProperty(p.elements.benchmarkStatus, 'textContent', { set(v) { statuses.push(String(v)); set.call(this, v); }, get() { return this.text; } });
  p.elements.benchmarkRun.click();
  await settle();
  assert.deepEqual(p.sent.benchmark[0].codecs, ['h265', 'av1']);
  assert.ok(!('device' in p.sent.benchmark[0]), 'the request is unchanged');
  assert.ok(statuses.includes('Intel Arc A380 (1 of 2) · H.265 (1 of 2): converting with 4 at once… (3 of 5)'), statuses.join('\n'));
  // the dialog's single tables, best line and Use buttons stand aside
  for (const key of ['benchmarkTable', 'benchmarkVerifyTable', 'benchmarkBest', 'benchmarkApply', 'benchmarkApplyAlt']) {
    assert.equal(p.elements[key].hidden, true, key);
  }
  assert.equal(p.elements.benchmarkDevices.hidden, false);
  const sections = p.elements.benchmarkDevices.all((n) => n.className === 'converter-benchmark-device');
  assert.deepEqual(sections.map((s) => s.dataset.device), [ARC.id, UHD.id]);
  assert.deepEqual(sections.map((s) => s.find((n) => n.tagName === 'H4').textContent), ['Intel Arc A380', 'Intel UHD Graphics 770']);
  const [arc, uhd] = sections;
  const heads = (s, cls) => s.find((n) => n.tagName === 'TABLE' && n.className === cls).find((n) => n.tagName === 'THEAD').find((n) => n.tagName === 'TR').children.map((c) => c.textContent);
  assert.deepEqual(heads(arc, 'converter-benchmark-table'), ['At once', 'H.265 Files/min', 'FPS', 'Saved', 'AV1 Files/min', 'FPS', 'Saved']);
  assert.deepEqual(heads(uhd, 'converter-benchmark-table'), ['At once', 'H.265 Files/min', 'FPS', 'Saved'], 'only what this GPU ran');
  assert.deepEqual(heads(arc, 'converter-benchmark-table converter-benchmark-verify'), ['Verification', 'Quick', 'Full'], 'no Off column');
  const rows = arc.find((n) => n.className === 'converter-benchmark-table').find((n) => n.tagName === 'TBODY').children;
  assert.deepEqual(rows.map((r) => r.children[0].textContent), ['1', '2', '4']);
  const lines = (s) => s.find((n) => n.className === 'converter-benchmark-best').textContent.split('\n');
  for (const line of lines(arc)) assert.match(line, /^Intel Arc A380 · /);
  assert.deepEqual(lines(uhd), [
    'Intel UHD Graphics 770 · H.265: fastest at 2 at once — 5 files/min, saves 40%',
    "Intel UHD Graphics 770 · AV1: this GPU can't encode it, so it was not tested"
  ]);
  const buttons = (s) => s.all((n) => n.tagName === 'BUTTON');
  assert.deepEqual(buttons(arc).map((b) => b.textContent), ['Use H.265 · 4 at once', 'Use AV1 · 2 at once']);
  assert.equal(buttons(arc)[1].getAttribute('aria-label'), 'Use AV1 · 2 at once on Intel Arc A380');
  assert.match(p.elements.benchmarkStatus.textContent, /converted on each of 2 GPUs/);

  // a GPU's Use button sets that GPU's row (and the codec) only
  p.lane('cpu').plus.click();
  buttons(arc)[1].click();
  assert.equal(p.elements.codecOptions[1].checked, true, 'AV1 selected');
  assert.deepEqual([p.lane(ARC.id).count, p.lane(UHD.id).count, p.lane('cpu').count], ['2', 'Off', '1']);
  assert.match(p.sent.notes.at(-1)[0], /^Set Intel Arc A380 to 2 at once with AV1\.$/);
});

test('benchmark: "Use H.265 on every GPU" sets each GPU to its own best and the CPU Off', async () => {
  const p = await page({ benchmark: { result: DEVICES_RESULT } });
  p.lane('cpu').plus.click();
  p.elements.benchmarkRun.click();
  await settle();
  const combined = p.elements.benchmarkDevices.find((n) => n.className === 'converter-benchmark-combined');
  const [every, ...more] = combined.all((n) => n.tagName === 'BUTTON');
  assert.equal(every.textContent, 'Use H.265 on every GPU (Arc A380: 4 · UHD 770: 2)');
  assert.equal(more.length, 0, 'AV1 has a best on one GPU only: no button for it');
  assert.equal(combined.find((n) => n.tagName === 'P').textContent, 'Each GPU was tested alone; together they share the CPU and drives, so the total can be a little lower.');
  every.click();
  assert.deepEqual([p.lane(ARC.id).count, p.lane(UHD.id).count, p.lane('cpu').count], ['4', '2', 'Off']);
  assert.equal(p.elements.codecOptions[0].checked, true);
  const config = await p.start();
  assert.deepEqual(config.lanes, [{ device: ARC.id, concurrency: 4 }, { device: UHD.id, concurrency: 2 }]);
});

test('benchmark with one GPU: the dialog as before, Quick and Full only', async () => {
  const single = run('h265', 'hevc_vaapi', [[1, 5], [2, 9], [4, 14]], 4);
  single.verifyComparison.unshift({ verifyMode: 'off', ok: true, filesPerMinute: 16, verifySecondsPerClip: 0 }); // (an older server)
  const p = await page({ devices: ONE, benchmark: { result: { codecs: [single] } } });
  p.elements.benchmarkRun.click();
  await settle();
  assert.equal(p.elements.benchmarkDevices.hidden, true);
  assert.equal(p.elements.benchmarkTable.hidden, false);
  assert.deepEqual(p.elements.benchmarkHead.children[0].children.map((c) => c.textContent), ['At once', 'H.265 Files/min', 'FPS', 'Saved']);
  assert.equal(p.elements.benchmarkRows.children.length, 3);
  assert.deepEqual(p.elements.benchmarkVerifyHead.children[0].children.map((c) => c.textContent), ['Verification', 'Quick', 'Full']);
  assert.deepEqual(p.elements.benchmarkVerifyRows.children[0].children.map((c) => c.textContent), ['H.265 · 4 at once', '14 (0.4 s)', '12 (2.1 s)']);
  assert.equal(p.elements.benchmarkBest.textContent, 'H.265: fastest at 4 at once — 14 files/min, saves 40%');
  assert.equal(p.elements.benchmarkApply.hidden, false);
  assert.equal(p.elements.benchmarkApply.textContent, 'Use H.265 · 4 at once');
  assert.equal(p.elements.benchmarkApplyAlt.hidden, true);
  assert.equal(p.elements.benchmarkStatus.textContent, 'Done — 8 real clips converted with H.265 on hevc_vaapi (GPU).');
  p.elements.benchmarkApply.click();
  assert.equal(p.elements.concurrency.value, '4');
});

test('the Encoder page: rows and benchmark sections have their places, the intro says Quick and Full', () => {
  const html = fs.readFileSync(path.join(REPO, 'src/renderer/encoder.html'), 'utf8');
  const parallel = html.slice(html.indexOf('ui.converter.parallelConversions"'), html.indexOf('ui.converter.verification"'));
  assert.match(parallel, /<div id="converterLanes" class="converter-lanes" hidden>\s*<p id="converterLanesTotal" class="converter-disclosure"><\/p>\s*<\/div>/);
  const dialog = html.slice(html.indexOf('<dialog id="converterBenchmarkDialog"'), html.indexOf('</dialog>'));
  assert.match(dialog, /<div id="converterBenchmarkDevices" class="converter-benchmark-devices" hidden><\/div>/);
  assert.match(dialog, /each verification mode \(Quick, Full\)/);
  assert.doesNotMatch(dialog, /Off, Quick, Full/);
  const css = fs.readFileSync(path.join(REPO, 'src/renderer/styles/encoderPage.css'), 'utf8');
  const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
  assert.match(coarse, /\.converter-stepper button \{\s*width: 44px;\s*height: 44px;/, 'big enough to tap');
  assert.match(css, /\.converter-lane \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/, 'the name gives way, never the stepper');
});

// ---- Hardware panel ---------------------------------------------------------
const sample = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'statsSample.json'), 'utf8'));

test('Hardware panel: one line per device when several convert; one device is unchanged', async () => {
  const { renderHardware } = await import(HARDWARE);
  const before = renderHardware(sample());
  const one = sample();
  one.encoder.devices = [{ id: ARC.id, name: 'Intel Arc A380', node: '/dev/dri/renderD128', encoder: 'hevc_vaapi', hardware: true, workers: 4, video: 94, busy: 12 }];
  assert.equal(renderHardware(one), before, 'one device: exactly as before');
  const noLanes = sample();
  noLanes.encoder.devices = [
    { id: null, name: 'Intel Arc A380', node: '/dev/dri/renderD128', encoder: 'hevc_vaapi', hardware: true, workers: 3, video: 94, busy: 12 },
    { id: null, name: 'CPU', node: null, encoder: 'libx265', hardware: false, workers: 1, video: null, busy: null }
  ];
  assert.equal(renderHardware(noLanes), before, 'entries without lanes (a job without lanes): as before');
  const two = sample();
  two.encoder.devices = [
    { id: ARC.id, name: 'Intel Arc A380', node: '/dev/dri/renderD128', encoder: 'hevc_qsv', hardware: true, workers: 3, video: 72, busy: 10 },
    { id: UHD.id, name: 'Intel UHD Graphics 770', node: '/dev/dri/renderD129', encoder: 'hevc_qsv', hardware: true, workers: 1, video: null, busy: 40 },
    { id: 'cpu', name: 'CPU (software encoder)', node: null, encoder: 'libx265', hardware: false, workers: [{}, {}], video: null, busy: null }
  ];
  two.gpus[1].tempC = 70;
  const html = renderHardware(two);
  assert.match(html, /<div class="nd-dev" title="Intel Arc A380 · hevc_qsv · 3 converting · video 72%">Intel Arc A380 · hevc_qsv · 3 converting · video 72%<\/div>/);
  assert.match(html, />Intel UHD Graphics 770 · hevc_qsv · 1 converting · GPU 40%</);
  assert.match(html, />CPU \(software encoder\) · libx265 · 2 converting</);
  assert.doesNotMatch(html, /hevc_vaapi · Intel Arc A380 · renderD128/, 'no single-device chip');
  assert.doesNotMatch(html, /Video engine/, 'each GPU has its own line instead');
  assert.match(html, /<small>GPU 70 · CPU 58<\/small>/, 'the hottest GPU in use');
  two.encoder.devices[0].name = '<img src=x onerror=alert(1)>';
  assert.doesNotMatch(renderHardware(two), /<img/);
});

// ---- the web shim -----------------------------------------------------------
test('web shim: getConverterDevices and setConverterLanes call the server; the benchmark request is unchanged', async () => {
  const calls = [];
  const listeners = () => ({ addEventListener() {}, removeEventListener() {} });
  const sandbox = {
    location: { search: '', pathname: '/studio/encoder.html', origin: 'https://nas', href: '' },
    URLSearchParams, JSON, Promise, Set, Map, Object, String, Error, setTimeout, clearTimeout,
    crypto: { randomUUID: () => 'client-1' },
    document: { documentElement: { dataset: {} }, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    fetch: async (url, init = {}) => {
      calls.push([url, init.body]);
      return { status: 200, ok: true, json: async () => (url.includes('/api/vehicles') ? { vehicles: [] } : { ok: true, value: url }) };
    },
    EventSource: class { constructor() { this.readyState = 1; } addEventListener() {} },
    MutationObserver: class { observe() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'test' }
  };
  sandbox.window = Object.assign(sandbox, listeners());
  sandbox.top = sandbox.window;
  vm.runInNewContext(fs.readFileSync(path.join(REPO, 'web/electronApiShim.js'), 'utf8'), sandbox);
  const api = sandbox.window.electronAPI;
  await api.getConverterDevices();
  await api.setConverterLanes('job-1', [{ device: ARC.id, concurrency: 3 }]);
  await api.runConverterBenchmark({ codecs: ['h265', 'av1'], verifyMode: 'quick' }, () => {});
  const invoked = calls.filter(([url]) => url.startsWith('/api/converter/invoke/'));
  assert.deepEqual(invoked, [
    ['/api/converter/invoke/devices', ''],
    ['/api/converter/invoke/setLanes', JSON.stringify({ jobId: 'job-1', lanes: [{ device: ARC.id, concurrency: 3 }] })],
    ['/api/converter/invoke/runBenchmark', JSON.stringify({ codecs: ['h265', 'av1'], verifyMode: 'quick' })]
  ]);
});

test('web shim: after a reconnect the page catches up on the current job; a stream closed by an error answer is opened again', async () => {
  const calls = [];
  const streams = [];
  const timers = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.readyState = 1; this.handlers = {}; streams.push(this); }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    fire(type, data) { for (const fn of this.handlers[type] || []) fn(data); }
  }
  FakeEventSource.CLOSED = 2;
  const listeners = () => ({ addEventListener() {}, removeEventListener() {} });
  const current = { id: 'auto-job', revision: 7, state: 'discovering', progress: { discovered: 25400 } };
  const sandbox = {
    location: { search: '', pathname: '/studio/encoder.html', origin: 'https://nas', href: '' },
    URLSearchParams, JSON, Promise, Set, Map, Object, String, Error, Math, clearTimeout,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    crypto: { randomUUID: () => 'client-1' },
    document: { documentElement: { dataset: {} }, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    fetch: async (url, init = {}) => {
      calls.push(url);
      return { status: 200, ok: true, json: async () => (url.endsWith('/getCurrent') ? { ok: true, value: current } : { ok: true, value: null }) };
    },
    EventSource: FakeEventSource,
    MutationObserver: class { observe() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'test' }
  };
  sandbox.window = Object.assign(sandbox, listeners());
  sandbox.top = sandbox.window;
  vm.runInNewContext(fs.readFileSync(path.join(REPO, 'web/electronApiShim.js'), 'utf8'), sandbox);
  const seen = [];
  sandbox.window.electronAPI.onConverterProgress((p) => seen.push(p));
  const flush = () => new Promise((r) => setImmediate(r));

  // the page's own first hello: subscribe, nothing to catch up on
  streams[0].fire('hello');
  await flush(); await flush();
  assert.equal(seen.length, 0);
  assert.equal(calls.filter((u) => u.endsWith('/getCurrent')).length, 0);

  // a reconnect (the server restarted): the current job arrives as a full update
  streams[0].fire('hello');
  await flush(); await flush(); await flush();
  assert.deepEqual(seen.map((p) => [p.jobId, p.revision, p.snapshot.progress.discovered]), [['auto-job', 7, 25400]]);

  // an error answer closes the stream for good: a new one is opened after a delay
  streams[0].readyState = FakeEventSource.CLOSED;
  streams[0].fire('error');
  assert.equal(streams.length, 1, 'not straight away');
  const retry = timers.find((t) => t.ms === 1000);
  assert.ok(retry, 'retried after a second');
  retry.fn();
  assert.equal(streams.length, 2);
  assert.match(streams[1].url, /\/api\/converter\/events\?client=client-1/);
  // its hello is a reconnect too
  streams[1].fire('hello');
  await flush(); await flush(); await flush();
  assert.equal(seen.length, 2);
  // a dropped connection the browser retries itself (still CONNECTING) opens nothing new
  streams[1].readyState = 0;
  streams[1].fire('error');
  assert.equal(timers.filter((t) => t.ms >= 1000).length, 1);
});
