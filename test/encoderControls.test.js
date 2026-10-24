'use strict';

// The Encoder's automatic-conversion and Parallel conversions controls, driven
// through the real controller with stand-in elements: what they send.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const MODULE = pathToFileURL(path.join(__dirname, '..', 'src/renderer/scripts/features/footageConverter.js')).href;

function el(init = {}) {
  const listeners = {};
  return Object.assign({
    value: '', checked: false, disabled: false, hidden: false, dataset: {},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type) { for (const fn of listeners[type] || []) fn({ target: this }); },
    focus() {}, classList: { toggle() {} }, setAttribute() {}, options: []
  }, init);
}

async function controller({ jobConcurrency = 5, extra = {} } = {}) {
  const { createFootageConverterController } = await import(MODULE);
  const elements = {
    groupOptions: [], codecOptions: [], profileOptions: [], outputOptions: [], pipelineStages: [], orderRows: [],
    autoEnabled: el(), autoInterval: el({ value: '60' }), autoWindowEnabled: el(), autoStart: el({ value: '1' }), autoEnd: el({ value: '6' }),
    autoOffPeak: el(), autoHoldManual: el(), autoKeepRunning: el(), autoLogin: el(), autoStatus: el(),
    concurrency: el({ value: String(jobConcurrency) }), concurrencyCustom: el({ value: '12' }), concurrencyCustomRow: el(), startButton: el(),
    ...extra
  };
  const sent = { auto: [], conc: [] };
  let autoState = { settings: { enabled: false, intervalMinutes: 60, window: null, holdManual: false, keepRunning: false, openAtLogin: false, config: null }, status: {} };
  let revision = 10;
  let progress = null;
  const api = {
    getConverterAuto: async () => ({ ok: true, value: autoState }),
    setConverterAuto: async (s) => { sent.auto.push(s); autoState = { settings: s, status: {} }; return { ok: true, value: autoState }; },
    getConverterCapabilities: async () => ({ ok: true, value: { replacement: 'available' } }),
    getCurrentConverterJob: async () => ({ ok: true, value: { id: 'job-1', revision: 1, state: 'encoding', config: { concurrency: jobConcurrency }, items: [] } }),
    setConverterConcurrency: async (id, n) => {
      sent.conc.push([id, n]);
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, value: { id, revision: ++revision, state: 'encoding', config: { concurrency: n }, items: [] } };
    },
    onConverterProgress: (cb) => { progress = cb; return () => {}; }
  };
  const c = createFootageConverterController({ api, elements, notify: () => {}, storage: null, autoPollMs: 0 });
  await c.init();
  return { elements, sent, snapshot: (s) => progress(s), settle: () => new Promise((r) => setTimeout(r, 80)) };
}

test('ticking "Only at off-peak" saves the off-peak window (and "pause my own" with it)', async () => {
  const { elements, sent, settle } = await controller();
  elements.autoOffPeak.checked = true;
  elements.autoOffPeak.fire('change');
  await settle();
  assert.deepEqual(sent.auto.at(-1).window, { follow: 'off-peak' });
  elements.autoHoldManual.checked = true;
  elements.autoHoldManual.fire('change');
  await settle();
  assert.equal(sent.auto.at(-1).holdManual, true);
  assert.deepEqual(sent.auto.at(-1).window, { follow: 'off-peak' });
});

test('Parallel conversions during a run: Custom… sends nothing until a number is typed', async () => {
  const { elements, sent, settle } = await controller();
  elements.concurrency.value = 'custom';
  elements.concurrency.fire('change');
  await settle();
  assert.deepEqual(sent.conc, [], 'not the custom box\'s old 12');
  elements.concurrencyCustom.value = '6';
  elements.concurrencyCustom.fire('change');
  await settle();
  assert.deepEqual(sent.conc, [['job-1', 6]]);
});

test('a snapshot with the same number leaves a half-typed number alone', async () => {
  const { elements, snapshot, settle } = await controller();
  elements.concurrency.value = 'custom';
  elements.concurrencyCustom.value = '3';
  snapshot({ jobId: 'job-1', revision: 20, snapshot: { id: 'job-1', revision: 20, state: 'encoding', config: { concurrency: 5 }, items: [] } });
  await settle();
  assert.equal(elements.concurrencyCustom.value, '3');
});

test('quick changes: the last choice is what the job ends with', async () => {
  const { elements, sent, settle } = await controller({ jobConcurrency: 4 });
  elements.concurrency.value = '2';
  elements.concurrency.fire('change');
  elements.concurrency.value = '4';
  elements.concurrency.fire('change');
  await settle(); await settle();
  assert.deepEqual(sent.conc.at(-1), ['job-1', 4]);
});

test('a highlighted counter keeps its number while the run goes on, and catches up once the highlight is gone', async () => {
  const listeners = {};
  let selection = { isCollapsed: true, rangeCount: 0 };
  const doc = { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }, getSelection: () => selection };
  const inside = { text: true };
  let writes = 0;
  let text = '0';
  const waiting = el({ ownerDocument: doc, contains: (node) => node === inside });
  Object.defineProperty(waiting, 'textContent', { get: () => text, set: (v) => { writes++; text = v; } });
  const { snapshot, settle } = await controller({ extra: { countWaiting: waiting } });
  const job = (revision, queued) => ({ jobId: 'job-1', revision, snapshot: { id: 'job-1', revision, state: 'encoding', config: { concurrency: 5 }, itemStateCounts: { queued }, items: [] } });
  snapshot(job(20, 500));
  await settle();
  assert.equal(waiting.textContent, '500');
  // the same number again: the text (and a highlight in it) is left alone
  const before = writes;
  snapshot(job(21, 500));
  await settle();
  assert.equal(writes, before, 'not rewritten');
  // the reader highlights it; the next update has another number
  selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ commonAncestorContainer: inside }) };
  snapshot(job(22, 480));
  await settle();
  assert.equal(waiting.textContent, '500', 'the highlight stays');
  assert.equal(writes, before);
  // the highlight is gone: the new number at once
  selection = { isCollapsed: true, rangeCount: 0 };
  listeners.selectionchange.forEach((fn) => fn());
  assert.equal(waiting.textContent, '480', 'caught up at once');
  // the mouse button held down on it (a highlight about to start)
  listeners.pointerdown.forEach((fn) => fn({ button: 0, target: inside }));
  snapshot(job(23, 470));
  await settle();
  assert.equal(waiting.textContent, '480');
  listeners.pointerup.forEach((fn) => fn({}));
  await settle();
  assert.equal(waiting.textContent, '470');
});
