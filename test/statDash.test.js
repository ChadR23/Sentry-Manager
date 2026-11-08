'use strict';

// The Viewer's stats dashboard (web/statDash.js) and its nerd raw view, driven
// with a small stand-in DOM: the raw view lines up with the footage exactly as
// the CAN signals do (one sync, with the drive's drift), it stays on screen
// while the clip changes, a clip with no CAN data yet is asked again later,
// destroy() stops everything, and the stat pickers are built only when used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// (the browser module, as an .mjs copy: the package itself is CommonJS)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'statdash-'));
const MODULE = path.join(TMP, 'statDash.mjs');
fs.copyFileSync(path.join(__dirname, '..', 'web', 'statDash.js'), MODULE);
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ---- a stand-in DOM: just what the dashboard uses ---------------------------
const VOID = new Set(['input', 'br', 'img']);
const decode = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attrs = {};
    this.text = '';
    this.listeners = {};
    this.style = {};
    this.hidden = false;
    this.selected = false;
    const self = this;
    this.dataset = new Proxy({}, {
      get: (_, k) => self.attrs[`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`],
      set: (_, k, v) => { self.setAttribute(`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, v); return true; }
    });
  }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = String(v); }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const set = (list) => { this.className = list.join(' '); };
    return {
      contains: (n) => names().includes(n),
      add: (n) => { if (!names().includes(n)) set([...names(), n]); },
      remove: (n) => set(names().filter((x) => x !== n)),
      toggle: (n, force) => { const on = force === undefined ? !names().includes(n) : Boolean(force); set([...names().filter((x) => x !== n), ...(on ? [n] : [])]); return on; }
    };
  }
  setAttribute(n, v) { this.attrs[n] = String(v); if (n === 'hidden') this.hidden = true; if (n === 'selected') this.selected = true; }
  getAttribute(n) { return this.attrs[n] ?? null; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this.text; }
  set textContent(v) { this.removeAll(); this.text = String(v); }
  set innerHTML(html) { this.removeAll(); parseInto(this, String(html)); }
  removeAll() { for (const c of this.children) c.parentElement = null; this.children = []; this.text = ''; }
  appendChild(node) {
    if (node.isFragment) { for (const c of [...node.children]) this.appendChild(c); return node; }
    node.remove();
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  remove() { if (this.parentElement) { const p = this.parentElement; p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
  after(node) { node.remove(); const p = this.parentElement; p.children.splice(p.children.indexOf(this) + 1, 0, node); node.parentElement = p; }
  get previousElementSibling() { const p = this.parentElement; if (!p) return null; return p.children[p.children.indexOf(this) - 1] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(sel) { return this.all().filter((n) => n.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  matches(sel) {
    // one compound selector: tag, .class and [attr] / [attr="value"]
    const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(sel.trim());
    if (!m) throw new Error(`selector not supported: ${sel}`);
    if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
    for (const c of m[2].split('.').filter(Boolean)) if (!this.classList.contains(c)) return false;
    for (const [, n, v] of m[3].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      if (!(n in this.attrs)) return false;
      if (v !== undefined && this.attrs[n] !== v) return false;
    }
    return true;
  }
  closest(sel) { for (let n = this; n; n = n.parentElement) if (n.matches(sel)) return n; return null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  focus() {}
  setPointerCapture() {}
  insertAdjacentHTML(where, html) {
    const tmp = new El('div');
    parseInto(tmp, html);
    const kids = [...tmp.children];
    if (where === 'beforeend') { for (const k of kids) this.appendChild(k); return; }
    const p = this.parentElement; // afterend
    let at = p.children.indexOf(this) + 1;
    for (const k of kids) { k.remove(); p.children.splice(at++, 0, k); k.parentElement = p; }
  }
  // ---- a simple page layout (the move and resize tests): a box (.sentry-sd) docked sits at
  // dockTop on the page, full width; floating, where its style puts it, at its natural size
  // unless its style gives one. Anything inside a box is at the box's top left, 60 x 30.
  getBoundingClientRect() {
    const L = globalThis.__layout;
    if (!L) return null;
    if (!this.classList.contains('sentry-sd')) {
      const box = this.closest('.sentry-sd');
      const r = box ? box.getBoundingClientRect() : { left: 0, top: 0 };
      return { left: r.left, top: r.top, width: 60, height: 30, right: r.left + 60, bottom: r.top + 30 };
    }
    const list = this.classList.contains('sd-listpanel');
    const float = this.classList.contains('float');
    const width = parseFloat(this.style.width) || (float ? (list ? 560 : 600) : L.pageW);
    const height = parseFloat(this.style.height) || (list ? 400 : 150);
    const left = (float ? parseFloat(this.style.left) || 0 : 0) - globalThis.scrollX;
    const top = (float ? parseFloat(this.style.top) || 0 : list ? L.dockTop + 160 : L.dockTop) - globalThis.scrollY;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  get offsetWidth() { return this.getBoundingClientRect()?.width ?? 0; }
  get offsetHeight() { return this.getBoundingClientRect()?.height ?? 0; }
  get options() { return this.querySelectorAll('option'); }
  get value() {
    if (this.tagName === 'SELECT') { const o = this.options; return (o.filter((x) => x.selected).pop() || o[0])?.attrs.value ?? ''; }
    return this.attrs.value ?? '';
  }
  set value(v) {
    if (this.tagName === 'SELECT') { for (const o of this.options) o.selected = o.attrs.value === String(v); return; }
    this.attrs.value = String(v);
  }
}
function parseInto(root, html) {
  let cur = root;
  for (const [, close, tag, attrs, text] of html.matchAll(/<(\/?)([a-z]+)([^>]*)>|([^<]+)/gi)) {
    if (text !== undefined) { if (text.trim()) { const t = new El('#text'); t.text = decode(text); cur.appendChild(t); } continue; }
    if (close) { cur = cur.parentElement || root; continue; }
    const node = new El(tag.toLowerCase());
    for (const [, n, , v] of attrs.matchAll(/([\w-]+)(="([^"]*)")?/g)) node.setAttribute(n, decode(v ?? ''));
    cur.appendChild(node);
    if (!VOID.has(node.tagName.toLowerCase())) cur = node;
  }
}
/** An event at `target`, bubbling up to the dashboard's listeners. */
function fire(target, type, extra = {}) {
  const e = { target, preventDefault() {}, stopPropagation() {}, ...extra };
  for (let n = target; n; n = n.parentElement) for (const fn of n.listeners[type] || []) fn(e);
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

// ---- the server, as the dashboard asks it -----------------------------------
const S = 1_600_000_000_000; // the clip's start on the CAN clock (UTC ms)
const clipPath = (n) => `/footage/TeslaCam/RecentClips/2020-09-13_12-0${n}-00-front.mp4`;
function server(routes) {
  const asked = [];
  const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
  globalThis.fetch = (url, opts = {}) => {
    const u = new URL(url, 'https://car.test');
    asked.push({ url: u, signal: opts.signal, method: opts.method || 'GET', body: opts.body });
    if (u.pathname === '/api/dashboards') return Promise.resolve(json(routes.boards || { boards: [], active: null }));
    if (u.pathname === '/api/telemetry') return Promise.resolve(json(routes.telemetry ? routes.telemetry(u.searchParams.get('path')) : { frames: [] }));
    const route = routes[u.pathname === '/api/can/raw' && u.searchParams.get('probe') ? 'probe' : u.pathname];
    if (!route) return Promise.resolve(json(null, 404));
    return Promise.resolve(route(u.searchParams.get('path'), u, opts)).then((r) => (r && r.status ? json(r.body, r.status) : json(r)));
  };
  return asked;
}
let instance = 0;
async function dashboard({ rawOpen = true, routes = {}, clip = clipPath(1), before = null } = {}) {
  const store = new Map([['sentry-sd-raw', rawOpen ? '1' : '0']]);
  const frames = [];
  Object.assign(globalThis, {
    document: Object.assign(new El('#document'), { head: new El('head'), getElementById: () => null, createElement: (t) => new El(t), createDocumentFragment: () => Object.assign(new El('#fragment'), { isFragment: true }), elementFromPoint: () => null }),
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => {},
    getComputedStyle: () => ({ position: 'relative' })
  });
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });
  const asked = server(routes);
  // a fresh copy of the module for each dashboard: its caches start empty
  const mod = await import(`${pathToFileURL(MODULE).href}?n=${++instance}`);
  const page = new El('main');
  const stage = page.appendChild(new El('div'));
  const video = { currentTime: 0, src: '', getAttribute: () => video.src };
  video.src = `/api/media?path=${encodeURIComponent(clip)}`;
  before?.();
  const dash = mod.attachStatDash({ stage, main: () => video, videos: () => [video] });
  // one animation frame (the dashboard's loop), then whatever it asked for
  const frame = async () => { const fn = frames.shift(); fn?.(); await settle(); };
  await settle();
  await frame();
  return { dash, el: dash.el, stage, video, asked, frame, raw: () => dash.el.querySelector('.sd-raw'), rawButton: () => dash.el.querySelector('[data-raw]') };
}
// the payload the raw view shows for one id right now
const payload = (d, id) => {
  const row = d.raw().querySelectorAll('tr').find((tr) => tr.children[0]?.textContent === id);
  return row ? row.lastElementChild.textContent : null;
};
const board = (blocks) => ({ boards: [{ id: 'b', name: 'B', placement: 'below', blocks }], active: 'b' });
const META = { signals: { DI_brake: { unit: '', bus: 'ChassisBus', message: 'ID145ESP' } } };
// one id that changes at 50 s into the clip (on the CAN clock)
const rawIds = (start) => [{ id: '145', bus: 'can0', name: 'ID145ESP', hz: 50, changes: [[start - 1000, '00'], [start + 50_000, '01']] }];

test('the raw view applies the drive\'s drift (rate) as the signals do', async () => {
  // 1000 ppm: at 49.96 s into the clip the CAN clock is at 50.01 s, past the change
  const sync = { method: 'edges-drive', offsetMs: 0, rate: 1.001 };
  const d = await dashboard({
    routes: {
      boards: board([{ type: 'small', signals: ['dash.speed'] }]),
      '/api/can/signals': () => META,
      '/api/can/raw': () => ({ start: S, sync, from: S - 2000, to: S + 70_000, ids: rawIds(S) })
    }
  });
  assert.equal(d.raw().hidden, false, 'the raw view is open');
  d.video.currentTime = 49.96;
  await d.frame();
  assert.equal(payload(d, '145'), '01', 'the change at 50 s on the CAN clock is shown at 49.96 s of footage');
  d.dash.destroy();
});

test('the raw view uses the signals\' sync for the clip, and a newer sync makes both ask again', async () => {
  let clipStart = S; // the signals' first answer: the clip-only estimate
  const clipAsks = [];
  const T = S + 50_030; // the brake, on the CAN clock: in the series and in the raw frames alike
  const d = await dashboard({
    routes: {
      boards: board([{ type: 'state', signals: ['can.DI_brake'] }]),
      '/api/can/signals': () => META,
      '/api/can/clip': () => { clipAsks.push(clipStart); return { start: clipStart, sync: { method: 'speed', offsetMs: 0, rate: 1 }, series: { DI_brake: [[S - 1000, 0], [T, 1]] } }; },
      // asked later, after the drive's solve: 67 ms more
      '/api/can/raw': () => { clipStart = S + 67; return { start: S + 67, sync: { method: 'edges-drive', offsetMs: 67, rate: 1 }, ids: [{ id: '145', bus: 'can0', name: 'ID145ESP', hz: 50, changes: [[S - 1000, '00'], [T, '01']] }] }; }
    }
  });
  await d.frame();
  assert.deepEqual(clipAsks, [S, S + 67], 'the raw answer\'s newer sync makes the signals ask again');
  const brakeOn = () => d.el.querySelector('.sd-state').classList.contains('on');
  d.video.currentTime = 49.9;
  await d.frame();
  assert.equal(brakeOn(), false);
  assert.equal(payload(d, '145'), '00', 'the raw bytes agree with the signal');
  // 49.98 s of footage: past the brake on the new sync (S + 67 + 49980), before it on the old one
  d.video.currentTime = 49.98;
  await d.frame();
  assert.equal(brakeOn(), true, 'the signal on the newest sync');
  assert.equal(payload(d, '145'), '01', 'and the raw bytes change at the same moment');
  d.dash.destroy();
});

test('the raw view stays on screen while the clip changes, with no extra probe', async () => {
  let release;
  const d = await dashboard({
    routes: {
      boards: board([{ type: 'small', signals: ['dash.speed'] }]),
      '/api/can/signals': () => META,
      probe: () => ({ start: S, count: 1 }),
      '/api/can/raw': (p) => (p === clipPath(2) ? new Promise((r) => { release = () => r({ start: S + 60_000, ids: rawIds(S + 60_000) }); }) : { start: S, ids: rawIds(S) })
    }
  });
  assert.equal(d.raw().hidden, false);
  d.video.src = `/api/media?path=${encodeURIComponent(clipPath(2))}`;
  await d.frame();
  assert.equal(d.raw().hidden, false, 'the table stays while the next clip loads');
  assert.equal(d.rawButton().hidden, false, 'and the Raw button too');
  assert.equal(d.raw().querySelector('[data-raw-n]').textContent, 'Loading…');
  assert.ok(d.raw().querySelectorAll('tr').length > 1, 'the last clip\'s rows stay (dimmed) until the new ones come');
  release();
  await settle();
  assert.equal(d.raw().classList.contains('sd-raw-loading'), false);
  assert.equal(d.raw().querySelector('[data-raw-n]').textContent, '1 of 1 ids');
  assert.equal(d.asked.filter((a) => a.url.searchParams.get('probe')).length, 0, 'while open, the download itself says whether there is data');
  d.dash.destroy();
});

test('a clip with no CAN data yet is asked again later, not remembered as empty', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let count = 0; // not indexed yet
  const d = await dashboard({
    rawOpen: false,
    routes: {
      boards: board([{ type: 'small', signals: ['dash.speed'] }]),
      '/api/can/signals': () => META,
      probe: () => ({ start: S, count })
    }
  });
  assert.equal(d.rawButton().hidden, true, 'nothing to show yet');
  count = 2; // the background index has reached the clip
  t.mock.timers.tick(32_000);
  await d.frame();
  assert.equal(d.asked.filter((a) => a.url.searchParams.get('probe')).length, 2, 'asked again');
  assert.equal(d.rawButton().hidden, false, 'and Raw is offered now');
  d.dash.destroy();
});

test('a failed raw download is not kept: the view asks again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let fail = true;
  const d = await dashboard({
    routes: {
      boards: board([{ type: 'small', signals: ['dash.speed'] }]),
      '/api/can/signals': () => META,
      '/api/can/raw': () => (fail ? { status: 500, body: { error: 'busy' } } : { start: S, ids: rawIds(S) })
    }
  });
  assert.equal(d.raw().hidden, true, 'nothing to show after the failure');
  fail = false;
  t.mock.timers.tick(32_000);
  await d.frame();
  assert.equal(d.raw().hidden, false, 'shown once the server answers');
  assert.equal(d.raw().querySelector('[data-raw-n]').textContent, '1 of 1 ids');
  d.dash.destroy();
});

test('destroy() stops the raw view: no download after it, and one in flight is stopped', async () => {
  let releaseMeta;
  const d = await dashboard({
    routes: {
      boards: board([{ type: 'small', signals: ['dash.speed'] }]),
      '/api/can/signals': () => new Promise((r) => { releaseMeta = () => r(META); }),
      '/api/can/raw': () => ({ start: S, ids: rawIds(S) })
    }
  });
  d.dash.destroy();
  releaseMeta();
  await settle();
  assert.equal(d.asked.filter((a) => a.url.pathname === '/api/can/raw').length, 0, 'nothing is downloaded for a dashboard that is gone');

  const e = await dashboard({
    routes: {
      boards: board([{ type: 'small', signals: ['dash.speed'] }]),
      '/api/can/signals': () => META,
      '/api/can/raw': (p, u, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    }
  });
  const download = e.asked.find((a) => a.url.pathname === '/api/can/raw');
  assert.ok(download, 'the download has started');
  e.dash.destroy();
  assert.equal(download.signal.aborted, true, 'and is stopped by destroy()');
});

test('a stat picker: a button while customizing, opening a list searched by name, group or id', async () => {
  const d = await dashboard({
    rawOpen: false,
    routes: { boards: board([{ type: 'wide', signals: ['dash.speed', 'dash.steering', 'dash.brake'] }, { type: 'small', signals: ['can.DI_brake'] }]) }
  });
  assert.equal(d.el.querySelectorAll('[data-pick]').length, 0, 'no pickers while not customizing');
  fire(d.el.querySelector('[data-edit]'), 'click');
  const picks = d.el.querySelectorAll('button[data-pick]');
  assert.equal(picks.length, 4);
  assert.equal(picks[3].textContent, 'DI_brake (no data yet)');
  assert.equal(d.el.querySelectorAll('[data-opt]').length, 0, 'no list until one is opened');
  fire(picks[1], 'click');
  const pop = d.el.querySelector('.sd-pop');
  assert.ok(pop, 'opened');
  assert.ok(pop.querySelectorAll('[data-opt]').length >= 15, 'every stat to pick from');
  assert.equal(pop.querySelector('.cur').textContent, 'Steering', 'its own stat marked');
  const q = pop.querySelector('[data-pop-q]');
  q.value = 'accel';
  fire(q, 'input');
  const found = pop.querySelectorAll('[data-opt]').map((o) => o.children[0].textContent);
  assert.ok(found.includes('Accelerator'), `found: ${found}`);
  assert.ok(!found.includes('Steering'));
  q.value = 'zzzz nothing';
  fire(q, 'input');
  assert.equal(pop.querySelectorAll('[data-opt]').length, 0);
  assert.match(pop.textContent, /No stat matches/);
  // picking one (a click on it)
  q.value = 'accelerator';
  fire(q, 'input');
  fire(pop.querySelector('[data-opt]'), 'click');
  assert.equal(d.el.querySelector('.sd-pop'), null, 'closed once picked');
  assert.equal(d.el.querySelector('.sd-wide').querySelectorAll('.sd-l')[1].textContent, 'Accelerator');
  // Escape closes without changing anything
  fire(d.el.querySelectorAll('button[data-pick]')[0], 'click');
  const e = { target: d.el.querySelector('[data-pop-q]'), key: 'Escape', preventDefault() {}, stopPropagation() {} };
  for (const fn of d.el.querySelector('.sd-pop').listeners.keydown) fn(e);
  assert.equal(d.el.querySelector('.sd-pop'), null);
  assert.equal(d.el.querySelector('.sd-wide').querySelectorAll('.sd-l')[0].textContent, 'Speed');
  d.dash.destroy();
});

test('the list block: every stat of the clip, asked for all at once, filtered, live as the footage plays', async () => {
  const META2 = { signals: { DI_brake: { unit: '', bus: 'ChassisBus', message: 'ID145ESP' }, BMS_packVoltage: { unit: 'V', bus: 'VehicleBus', message: 'ID132HVBattAmpVolt' }, VCFRONT_never: { unit: '', bus: 'VehicleBus', message: 'ID3F2X' } } };
  let asked = '';
  const d = await dashboard({
    rawOpen: false,
    routes: {
      boards: board([{ type: 'list', signals: [], q: '', changing: false }]),
      '/api/can/signals': () => META2,
      '/api/can/clip': (p, u) => { asked = u.searchParams.get('signals'); return { start: S, sync: { method: 'clock' }, series: { DI_brake: [[S - 1000, 0], [S + 10_000, 1]], BMS_packVoltage: [[S - 1000, 398.5]] } }; }
    }
  });
  await d.frame();
  await d.frame();
  assert.equal(asked, '*', 'every signal of the clip');
  assert.equal(d.el.querySelectorAll('.sd-list').length, 0, 'the list is not in the bar');
  assert.equal(d.el.nextElementSibling ?? d.el.parentElement.children[d.el.parentElement.children.indexOf(d.el) + 1], d.dash.panel, 'its own box, right under the bar');
  const rows = () => d.dash.panel.querySelectorAll('.sd-list-r').map((r) => `${r.children[0].textContent}=${r.querySelector('[data-lv]').textContent}`);
  assert.equal(rows().length >= 2, true, 'the CAN stats with data');
  assert.ok(rows().some((x) => /398\.5V$/.test(x)), `pack voltage shown: ${rows()}`);
  assert.ok(!rows().some((x) => /never/i.test(x)), 'a signal with no data in this clip is left out');
  // the footage moves on: the brake turns on
  d.video.currentTime = 11;
  await d.frame();
  assert.ok(d.dash.panel.querySelectorAll('.sd-list-r.hot').length >= 1, 'a value that changed lights up');
  // Customize redraws the bar: the list is drawn again in the new one
  fire(d.el.querySelector('[data-edit]'), 'click');
  await d.frame();
  assert.ok(d.dash.panel.querySelectorAll('.sd-list-r').length >= 2, 'rows after a redraw');
  fire(d.el.querySelector('[data-edit]'), 'click');
  await d.frame();
  // filter
  const q = d.dash.panel.querySelector('[data-list-q]');
  q.value = 'volt';
  fire(q, 'input');
  assert.equal(d.dash.panel.querySelectorAll('.sd-list-r').length, 1);
  // changing only: the voltage does not change in this clip
  q.value = '';
  fire(q, 'input');
  const ch = d.dash.panel.querySelector('[data-list-changing]');
  ch.checked = true;
  fire(ch, 'change');
  assert.ok(rows().every((x) => !/398/.test(x)), `only what changes: ${rows()}`);
  assert.ok(rows().length >= 1, 'the brake changes');
  d.dash.destroy();
});

// ---- the stats people like most: first in the List and the picker ---------------
const POP_META = {
  signals: {
    BMS_packFoo: { unit: 'V', bus: 'VehicleBus', message: 'ID100AAA' },
    SOCUI292: { unit: '%', bus: 'VehicleBus', message: 'ID292BMS_SOC' },
    UI_SOC: { unit: '%', bus: 'VehicleBus', message: 'ID33AUI_rangeSOC' },
    UI_Range: { unit: 'mi', bus: 'VehicleBus', message: 'ID33AUI_rangeSOC', min: 0, max: 1023 },
    DI_vehicleSpeed: { unit: 'kph', bus: 'VehicleBus', message: 'ID257DIspeed', min: -40, max: 285 },
    BattVoltage132: { unit: 'V', bus: 'VehicleBus', message: 'ID132HVBattAmpVolt' },
    SomethingElseVolt: { unit: 'V', bus: 'VehicleBus', message: 'ID999ZZZ' }
  }
};
async function popDash(series, block = { type: 'list', signals: [], q: '', changing: false }) {
  return dashboard({
    rawOpen: false,
    routes: {
      boards: board([block, { type: 'small', signals: ['dash.speed'] }]),
      '/api/can/signals': () => POP_META,
      '/api/can/clip': () => ({ start: S, sync: { method: 'clock' }, series })
    }
  });
}
const listed = (d) => d.dash.panel.querySelectorAll('.sd-list-r').map((r) => (r.classList.contains('sd-list-h') ? `# ${r.textContent}` : r.children[0].textContent));

test('the List: the popular stats first, under their own heading, each once', async (t) => {
  // no SOCUI292 in this clip: Battery % comes from UI_SOC, the next of its ids
  const d = await popDash({ BMS_packFoo: [[S - 1000, 1]], UI_SOC: [[S - 1000, 80]], UI_Range: [[S - 1000, 250]], DI_vehicleSpeed: [[S - 1000, 50], [S + 5000, 60]], BattVoltage132: [[S - 1000, 398]], SomethingElseVolt: [[S - 1000, 3]] });
  t.after(() => d.dash.destroy());
  await d.frame();
  await d.frame();
  const rows = listed(d);
  assert.deepEqual(rows.slice(0, 6), ['# Popular', 'Speed', 'Battery %', 'Range', 'Battery voltage', '# All stats'], `rows: ${rows}`);
  // Speed: no dash telemetry here, so the CAN speed (in mph by default: 50 km/h)
  const speed = d.dash.panel.querySelectorAll('.sd-list-r')[1];
  assert.equal(speed.querySelector('[data-lv]').textContent, '31mph');
  assert.equal(speed.children[1].textContent, 'Vehicle Speed', 'which signal it is');
  const range = d.dash.panel.querySelectorAll('.sd-list-r')[3];
  assert.equal(range.querySelector('[data-lv]').textContent, '250mi');
  // each once: the signals chosen are not listed again below
  const values = d.dash.panel.querySelectorAll('.sd-list-r[data-row]').map((r) => r.getAttribute('title'));
  assert.equal(new Set(values).size, values.length, 'no duplicates');
  assert.equal(values.filter((t) => /DI_vehicleSpeed/.test(t)).length, 1);
  assert.equal(values.filter((t) => /UI_SOC/.test(t)).length, 1);
  assert.match(d.dash.panel.querySelector('[data-list-n]').textContent, /^6 stats/, 'headings are not counted');
  // changing only: still applies to the popular rows
  const ch = d.dash.panel.querySelector('[data-list-changing]');
  ch.checked = true;
  fire(ch, 'change');
  assert.deepEqual(listed(d), ['# Popular', 'Speed'], 'only the speed changes');
  // a search: the popular match leads the matches as good
  ch.checked = false;
  fire(ch, 'change');
  const q = d.dash.panel.querySelector('[data-list-q]');
  q.value = 'volt';
  fire(q, 'input');
  const found = listed(d);
  assert.equal(found[0], 'Battery voltage', `found: ${found}`);
  assert.ok(!found.some((x) => x.startsWith('#')), 'no headings in a search');
  q.value = 'battery %';
  fire(q, 'input');
  assert.deepEqual(listed(d), ['Battery %']);
  d.dash.destroy();
});

test('the picker: a Popular group first, the first id there for each, then every stat once', async (t) => {
  const d = await popDash({}, { type: 'small', signals: ['dash.steering'] });
  t.after(() => d.dash.destroy());
  fire(d.el.querySelector('[data-edit]'), 'click');
  fire(d.el.querySelector('button[data-pick]'), 'click');
  const pop = d.el.querySelector('.sd-pop');
  const heads = pop.querySelectorAll('.sd-pop-g').map((g) => g.textContent);
  assert.equal(heads[0], 'Popular');
  const opts = pop.querySelectorAll('[data-opt]').map((o) => o.children[0].textContent);
  // the built-in speed wins over the CAN one; SOCUI292 (first) over UI_SOC
  assert.deepEqual(opts.slice(0, 4), ['Speed', 'Battery %', 'Range', 'Gear'], `opts: ${opts}`);
  assert.equal(opts.filter((x) => x === 'Speed').length, 1, 'the built-in speed is not listed again');
  assert.equal(opts.filter((x) => x === 'Steering').length, 1);
  const battery = pop.querySelectorAll('[data-opt]')[1];
  assert.equal(battery.querySelector('small').textContent, 'SOCUI292', 'which signal it is');
  // the next ids stay in their own group
  assert.ok(opts.includes('Vehicle speed') || opts.some((x) => /speed/i.test(x) && x !== 'Speed'), 'the CAN speed is still in its group');
  // a search: popular first of the matches as good
  const q = pop.querySelector('[data-pop-q]');
  q.value = 'volt';
  fire(q, 'input');
  const found = pop.querySelectorAll('[data-opt]').map((o) => o.children[0].textContent);
  assert.equal(found[0], 'Battery voltage', `found: ${found}`);
  // picking a popular stat stores its real id
  q.value = 'battery %';
  fire(q, 'input');
  fire(pop.querySelector('[data-opt]'), 'click');
  fire(d.el.querySelector('[data-edit]'), 'click');
  assert.equal(d.el.querySelector('.sd-small').querySelector('.sd-l').textContent, 'Battery %', 'the tile says what it is, not SOCUI292');
  d.dash.destroy();
});

// ---- the List across clips, the built-in stats, fullscreen, the List's own answer ----
/** One telemetry record (SEI, as /api/telemetry sends it): speed (m/s) and steering (°). */
const rec = (speedMps, steering) => {
  const b = Buffer.alloc(10);
  b[0] = 0x25; b.writeFloatLE(speedMps, 1); // field 4 (speed), 32-bit
  b[5] = 0x35; b.writeFloatLE(steering, 6); // field 6 (steering), 32-bit
  return b.toString('base64');
};
const listBoard = (more = []) => board([{ type: 'list', signals: [], q: '', changing: false }, ...more]);
const labels = (d) => d.dash.panel.querySelectorAll('.sd-list-r[data-row]').map((r) => `${r.children[0].textContent}=${r.querySelector('[data-lv]').textContent}`);

test('the List after a clip change: the new clip\'s stats, names and values together', async (t) => {
  const many = (p, n) => Object.fromEntries(Array.from({ length: n }, (_, k) => [`${p}_sig${p}${k}`, { unit: p === 'AAA' ? 'V' : 'A', bus: 'VehicleBus', message: `ID1${k}X` }]));
  const meta = { signals: { ...many('AAA', 40), ...many('BBB', 40) } };
  const data = (p, v, start) => ({ start, sync: { method: 'clock' }, series: Object.fromEntries(Array.from({ length: 40 }, (_, k) => [`${p}_sig${p}${k}`, [[start - 1000, v]]])) });
  const d = await dashboard({
    rawOpen: false,
    routes: {
      boards: listBoard(),
      '/api/can/signals': () => meta,
      '/api/can/clip': (p) => (p === clipPath(1) ? data('AAA', 111, S) : data('BBB', 222, S + 60_000))
    }
  });
  t.after(() => d.dash.destroy());
  await d.frame();
  assert.match(labels(d)[0], /^Sig AAA0=111\.0V$/, `clip 1: ${labels(d)[0]}`);
  d.video.src = `/api/media?path=${encodeURIComponent(clipPath(2))}`;
  await d.frame();
  await d.frame();
  const rows = labels(d);
  assert.ok(rows.length > 10);
  assert.ok(rows.every((x) => /^Sig BBB\d+=222\.0A$/.test(x)), `every row is clip 2's, name and value: ${rows.slice(0, 3)}`);
  assert.equal(d.dash.panel.querySelectorAll('.sd-list-r.hot').length, 0, 'nothing lit: a new clip\'s values are not changes');
});

test('the next clip shows no CAN value until its own answer is here (not the last clip\'s)', async (t) => {
  let release;
  const d = await dashboard({
    rawOpen: false,
    routes: {
      boards: board([{ type: 'small', signals: ['can.BattVoltage132'] }]),
      '/api/can/signals': () => POP_META,
      '/api/can/clip': (p) => (p === clipPath(1)
        ? { start: S, sync: { method: 'clock' }, series: { BattVoltage132: [[S - 1000, 300], [S + 5000, 350]] } }
        : new Promise((r) => { release = () => r({ start: S + 60_000, sync: { method: 'clock' }, series: { BattVoltage132: [[S + 59_000, 400]] } }); }))
    }
  });
  t.after(() => d.dash.destroy());
  const shown = () => d.el.querySelector('[data-v="0"]').textContent;
  d.video.currentTime = 6;
  await d.frame();
  assert.equal(shown(), '350.0');
  d.video.src = `/api/media?path=${encodeURIComponent(clipPath(2))}`;
  await d.frame();
  assert.equal(shown(), '—', 'nothing while the next clip\'s answer is on its way');
  assert.equal(d.el.querySelector('[data-sync]').textContent, '', 'and no sync note of the last clip');
  release();
  await settle();
  await d.frame();
  assert.equal(shown(), '400.0', 'then its own value');
});

test('the List, "Changing only": built-in stats that change are kept, those that hold are not', async (t) => {
  const frames = Array.from({ length: 20 }, (_, k) => [k * 100, rec(10 + k, 5)]); // speed moves, steering holds
  const d = await dashboard({
    rawOpen: false,
    routes: { boards: listBoard(), telemetry: () => ({ frames }) }
  });
  t.after(() => d.dash.destroy());
  await d.frame();
  const names = () => listed(d).filter((x) => !x.startsWith('#'));
  assert.ok(names().includes('Speed') && names().includes('Steering'), `with data: ${names()}`);
  assert.ok(!names().includes('Latitude'), 'a built-in stat with no data in the clip is left out');
  const ch = d.dash.panel.querySelector('[data-list-changing]');
  ch.checked = true;
  fire(ch, 'change');
  assert.deepEqual(names(), ['Speed'], 'the speed changes; the steering holds');
});

test('fullscreen: with the cameras themselves fullscreen, the List and the picker are inside them; back out, they go back', async (t) => {
  const d = await dashboard({ rawOpen: false, routes: { boards: listBoard([{ type: 'small', signals: ['dash.speed'] }]) } });
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
  t.after(() => { delete globalThis.document.fullscreenElement; delete globalThis.innerWidth; delete globalThis.innerHeight; d.dash.destroy(); });
  const page = d.stage.parentElement;
  assert.equal(d.dash.panel.parentElement, page, 'docked under the bar');
  globalThis.document.fullscreenElement = d.stage;
  for (const fn of globalThis.document.listeners.fullscreenchange || []) fn({});
  assert.equal(d.el.parentElement, d.stage, 'the bar over the cameras');
  assert.equal(d.dash.panel.parentElement, d.stage, 'the List floats over them');
  assert.ok(d.dash.panel.classList.contains('float'));
  fire(d.el.querySelector('[data-edit]'), 'click');
  fire(d.el.querySelector('button[data-pick]'), 'click');
  assert.equal(d.stage.querySelectorAll('.sd-pop').length, 1, 'the picker opens inside what is fullscreen');
  delete globalThis.document.fullscreenElement;
  for (const fn of globalThis.document.listeners.fullscreenchange || []) fn({});
  assert.equal(d.stage.querySelectorAll('.sd-pop').length, 0, 'an open picker closes');
  assert.equal(d.dash.panel.parentElement, page, 'docked again');
  assert.equal(d.dash.panel.classList.contains('float'), false);
  assert.equal(d.el.parentElement, page, 'the bar back under the cameras');
});

test('destroy() keeps a List filter typed a moment before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const d = await dashboard({ rawOpen: false, routes: { boards: listBoard() } });
  const q = d.dash.panel.querySelector('[data-list-q]');
  q.value = 'batt';
  fire(q, 'input');
  d.dash.destroy();
  t.mock.timers.tick(1000);
  const puts = d.asked.filter((a) => a.url.pathname === '/api/dashboards' && a.method === 'PUT');
  assert.equal(puts.length, 1, 'saved, once');
  assert.equal(JSON.parse(puts[0].body).boards[0].blocks[0].q, 'batt', 'with the filter');
});

test('a box resized just before the Viewer goes is saved at once, not half a second later (when the page is gone)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const d = await dashboard({ rawOpen: false, routes: { boards: listBoard() } });
  fire(d.dash.panel.querySelector('[data-size-list]'), 'keydown', { key: 'ArrowDown', shiftKey: true });
  const puts = () => d.asked.filter((a) => a.url.pathname === '/api/dashboards' && a.method === 'PUT');
  assert.equal(puts().length, 0, 'waiting (saves wait for a pause)');
  d.dash.destroy();
  assert.equal(puts().length, 1, 'sent as it goes');
  assert.ok(Number.isFinite(JSON.parse(puts()[0].body).boards[0].listSize.wide?.h), 'with the new height');
  t.mock.timers.tick(1000);
  assert.equal(puts().length, 1, 'once');
});

test('the List asks for its own thinned answer as columns, and the bar\'s signals by name', async (t) => {
  const asks = [];
  const d = await dashboard({
    rawOpen: false,
    routes: {
      boards: listBoard([{ type: 'small', signals: ['can.BattVoltage132'] }]),
      '/api/can/signals': () => POP_META,
      '/api/can/clip': (p, u) => {
        asks.push(Object.fromEntries(u.searchParams));
        if (u.searchParams.get('signals') !== '*') return { start: S, sync: { method: 'clock' }, series: { BattVoltage132: [[S - 1000, 300], [S + 5000, 350]] } };
        // every 250 ms: base, then ms after the one before
        return { start: S, sync: { method: 'clock' }, step: 250, base: S, changing: ['BattVoltage132'], cols: { BattVoltage132: [[-1000, 6000], [300, 350]], UI_Range: [[-1000], [250]] } };
      }
    }
  });
  t.after(() => d.dash.destroy());
  await d.frame();
  const list = asks.find((a) => a.signals === '*');
  assert.deepEqual([list.step, list.cols], ['250', '1'], 'the List: every signal, a value every 250 ms, as columns');
  assert.ok(asks.some((a) => a.signals === 'BattVoltage132'), 'the bar: its own signal, every point');
  d.video.currentTime = 6;
  await d.frame();
  assert.equal(d.el.querySelector('[data-v="0"]').textContent, '350.0');
  const rows = labels(d);
  assert.ok(rows.includes('Range=250mi'), `from the columns: ${rows}`);
  assert.ok(rows.includes('Battery voltage=350.0V'), `${rows}`);
  const ch = d.dash.panel.querySelector('[data-list-changing]');
  ch.checked = true;
  fire(ch, 'change');
  assert.deepEqual(labels(d), ['Battery voltage=350.0V'], 'what changes: the server\'s list');
});

// ---- CAN values shown right: decimals from the step, units, "not available" ----
test('CAN values: decimals from the DBC step, every unit converted, SNA and the like as no data', async (t) => {
  const meta = {
    // a tire pressure: 255 is "SNA" (read as words, it showed "3.2" with no unit)
    VCSEC_TPMSPressure0: { unit: 'bar', bus: 'VehicleBus', message: 'ID219VCSEC_TPMSData', min: 0, max: 6.35, factor: 0.025, offset: 0, values: { 255: 'SNA' } },
    VCSEC_TPMSPressure1: { unit: 'bar', bus: 'VehicleBus', message: 'ID219VCSEC_TPMSData', min: 0, max: 6.35, factor: 0.025, offset: 0, values: { 255: 'SNA' } },
    // a position in millionths of a degree (with 0 decimals it showed 40 and -108)
    GPSLatitude04F: { unit: 'Deg', bus: 'ChassisBus', message: 'ID04FGPSLatLong', min: -134.218, max: 134.218, factor: 1e-6, offset: 0 },
    // a speed limit in the car's units: UI_mapSpeedLimitUnits says which; 0 is "UNKNOWN_SNA", 31 "NONE"
    DAS_fusedSpeedLimit: { unit: 'kph/mph', bus: 'ChassisBus', message: 'ID399DAS_status', min: 0, max: 150, factor: 5, offset: 0, values: { 0: 'UNKNOWN_SNA', 31: 'NONE' } },
    UI_mapSpeedLimitUnits: { unit: '', bus: 'ChassisBus', message: 'ID3D9UI_gpsVehicleSpeed', min: 0, max: 1, factor: 1, offset: 0, values: { 0: 'MPH', 1: 'KPH' } },
    Elevation3D8: { unit: 'M', bus: 'VehicleBus', message: 'ID3D8Elevation', min: -8192, max: 8191, factor: 1, offset: 0 },
    DAS_leadVehDx: { unit: 'm', bus: 'ChassisBus', message: 'ID309DAS_object', min: 0, max: 127, factor: 0.5, offset: 0 },
    // a model temperature that sends 0 (-40 C) when it has none
    BattBrickModelTMin332: { unit: 'C', bus: 'VehicleBus', message: 'ID332BattBrickMinMax', min: -40, max: 87.5, factor: 0.5, offset: -40, values: { 0: 'SNA' } },
    // the battery temperature now, and the old one (its layout changed: not a popular stat any more)
    BattBrickTempMax332: { label: 'Max Batt Brick Temp', unit: 'C', bus: 'VehicleBus', message: 'ID332BattBrickMinMax', min: -40, max: 87.5, factor: 0.5, offset: -40 },
    BMSmaxPackTemperature: { unit: 'C', bus: 'VehicleBus', message: 'ID312BMSthermal', min: -25, max: 100, factor: 0.25, offset: -25 },
    // a series named after its message (two messages have the name): read by its signal's name
    UI_cpuTemperature_353: { label: 'UI_cpuTemperature', signal: 'UI_cpuTemperature', unit: 'C', bus: 'VehicleBus', message: 'ID353UI_status', min: -40, max: 87, factor: 1, offset: 40 },
    // a state (whole steps, every value named) stays words
    VCRIGHT_hvacRecirc: { unit: '', bus: 'VehicleBus', message: 'ID243VCRIGHT_hvacStatus', min: 0, max: 2, factor: 1, offset: 0, values: { 0: 'AUTO', 1: 'RECIRC', 2: 'FRESH' } }
  };
  const series = {
    VCSEC_TPMSPressure0: [[S - 1000, 2.575]],
    VCSEC_TPMSPressure1: [[S - 1000, 6.375]],
    GPSLatitude04F: [[S - 1000, 40.199897]],
    DAS_fusedSpeedLimit: [[S - 1000, 55], [S + 10_000, 90], [S + 20_000, 0], [S + 30_000, 155]],
    UI_mapSpeedLimitUnits: [[S - 1000, 0], [S + 10_000, 1]],
    Elevation3D8: [[S - 1000, 194]],
    DAS_leadVehDx: [[S - 1000, 30.5]],
    BattBrickModelTMin332: [[S - 1000, -40]],
    BattBrickTempMax332: [[S - 1000, 21.5]],
    BMSmaxPackTemperature: [[S - 1000, -25]],
    UI_cpuTemperature_353: [[S - 1000, 30]],
    VCRIGHT_hvacRecirc: [[S - 1000, 2]]
  };
  const d = await dashboard({
    rawOpen: false,
    routes: {
      boards: board([{ type: 'list', signals: [], q: '', changing: false }, { type: 'small', signals: ['dash.speed'] }]),
      '/api/can/signals': () => ({ signals: meta }),
      '/api/can/clip': () => ({ start: S, sync: { method: 'clock' }, series })
    }
  });
  t.after(() => d.dash.destroy());
  await d.frame();
  await d.frame();
  const rows = () => Object.fromEntries(d.dash.panel.querySelectorAll('.sd-list-r[data-row]').map((r) => [r.getAttribute('title').match(/, (\w+)\)$/)?.[1] || r.children[0].textContent, r.querySelector('[data-lv]').textContent]));
  const at = async (ms) => { d.video.currentTime = ms / 1000; await d.frame(); return rows(); };
  let v = await at(1000);
  assert.equal(v.VCSEC_TPMSPressure0, '37.35psi', 'a pressure is a number, in psi');
  assert.equal(v.VCSEC_TPMSPressure1, '—', '255 raw is "not available"');
  assert.equal(v.GPSLatitude04F, '40.199897°', 'six decimals for a millionth of a degree');
  assert.equal(v.DAS_fusedSpeedLimit, '55mph', 'the car says mph');
  assert.equal(v.Elevation3D8, '636ft');
  assert.equal(v.DAS_leadVehDx, '100.1ft', '"m" in feet too');
  assert.equal(v.BattBrickModelTMin332, '—', 'raw 0 (-40 C) is no value');
  assert.equal(v.VCRIGHT_hvacRecirc, 'FRESH', 'a state stays words');
  v = await at(11_000);
  assert.equal(v.DAS_fusedSpeedLimit, '56mph', '90 km/h when the car says km/h');
  v = await at(21_000);
  assert.equal(v.DAS_fusedSpeedLimit, '—', '0 is "UNKNOWN_SNA", not 0.0 kph/mph');
  v = await at(31_000);
  assert.equal(v.DAS_fusedSpeedLimit, '—', '31 is "NONE": no limit, not 155');
  // the popular battery temperature: the bricks', in °F; the old 0x312 one is not chosen
  const list = listed(d);
  assert.ok(list.includes('Battery temp (max)'), `rows: ${list}`);
  const pop = d.dash.panel.querySelectorAll('.sd-list-r[data-row]').find((r) => r.children[0].textContent === 'Battery temp (max)');
  assert.match(pop.getAttribute('title'), /BattBrickTempMax332/);
  assert.equal(pop.querySelector('[data-lv]').textContent, '70.7°F');
  // a series named after its message is labelled by its signal
  const cpu = d.dash.panel.querySelectorAll('.sd-list-r[data-row]').find((r) => /UI_cpuTemperature_353/.test(r.getAttribute('title')));
  assert.equal(cpu.children[0].textContent, 'Cpu Temperature');
  assert.equal(cpu.querySelector('[data-lv]').textContent, '86°F');
  d.dash.destroy();
});

// ---- moving and resizing both boxes ----------------------------------------------
/** A page 1400 x 3000 in a 1400 x 900 window, scrolled to scrollY; window listeners kept here. */
function layoutPage(t, { scrollY = 0, width = 1400 } = {}) {
  const win = {};
  Object.assign(globalThis, {
    __layout: { pageW: width, dockTop: 500 }, innerWidth: width, innerHeight: 900, scrollX: 0, scrollY,
    addEventListener: (type, fn) => { (win[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { win[type] = (win[type] || []).filter((f) => f !== fn); }
  });
  t.after(() => { for (const k of ['__layout', 'innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'addEventListener', 'removeEventListener']) delete globalThis[k]; });
  // (after dashboard() made the document)
  const finish = () => {
    document.body = new El('body');
    document.documentElement = { clientWidth: globalThis.innerWidth, clientHeight: 900, scrollHeight: 3000 };
    globalThis.getComputedStyle = (n) => ({ position: n === document.body ? 'static' : 'relative', transform: 'none' });
  };
  // a pointer event on the window (as the browser sends it once a drag has started)
  const send = (type, x, y, extra = {}) => { for (const fn of [...(win[type] || [])]) fn({ pointerId: 1, clientX: x, clientY: y, preventDefault() {}, ...extra }); };
  return { win, finish, send };
}
async function pageDash(t, blocks, extra = {}, opts = {}) {
  const page = layoutPage(t, opts);
  const d = await dashboard({ rawOpen: false, routes: { boards: { boards: [{ id: 'b', name: 'B', placement: 'below', blocks, ...extra }], active: 'b' } }, before: page.finish });
  t.after(() => d.dash.destroy());
  const saved = async () => { await new Promise((r) => setTimeout(r, 600)); const put = d.asked.filter((a) => a.method === 'PUT').pop(); return put && JSON.parse(put.body).boards[0]; };
  return { ...d, ...page, saved };
}

test('the bar: its Move handle pulls it out of its place to float on the page where dropped; Put back returns it', async (t) => {
  const d = await pageDash(t, [{ type: 'small', signals: ['dash.speed'] }], {}, { scrollY: 200 });
  const bar = d.el;
  assert.ok(bar.querySelector('[data-move-bar]'), 'a Move handle in every placement');
  assert.ok(bar.querySelector('[data-size-bar]'), 'and a resize grip');
  // the bar is under the cameras at 500 on the page (300 in the window, scrolled by 200)
  fire(bar.querySelector('[data-move-bar]'), 'pointerdown', { pointerId: 1, clientX: 10, clientY: 310, button: 0 });
  d.send('pointermove', 60, 260);
  // a redraw during the drag (a clip's signals arriving): the drag goes on, the box is not put back
  fire(bar.querySelector('[data-edit]'), 'click');
  fire(bar.querySelector('[data-edit]'), 'click');
  d.send('pointermove', 110, 210);
  assert.ok(bar.classList.contains('float'), 'it floats');
  assert.equal(bar.parentElement, document.body, 'on the page (in <body>, position:absolute)');
  assert.deepEqual([bar.style.left, bar.style.top], ['100px', '400px'], 'the handle stays under the pointer, in page coordinates');
  d.send('pointerup', 110, 210);
  const b = await d.saved();
  assert.equal(b.placement, 'float');
  assert.equal(b.barHome, 'below');
  assert.deepEqual(b.float.wide, { x: 0.125, y: Math.round((400 / (3000 - 150)) * 1000) / 1000, top: 400 }, 'kept on the page: top in px');
  // scrolling leaves it on the page: a redraw after a scroll puts it at the same page spot
  globalThis.scrollY = 900;
  for (const fn of d.win.resize || []) fn();
  assert.equal(bar.style.top, '400px');
  // after a drag that ended, a move with no button down does nothing
  d.send('pointermove', 500, 500);
  assert.equal(bar.style.left, '100px');
  // the arrow keys move a focused handle
  fire(bar.querySelector('[data-move-bar]'), 'keydown', { key: 'ArrowRight' });
  assert.equal(bar.style.left, '110px');
  fire(bar.querySelector('[data-move-bar]'), 'keydown', { key: 'ArrowUp', shiftKey: true });
  assert.equal(bar.style.top, '350px');
  // kept inside the page
  for (let i = 0; i < 40; i++) fire(bar.querySelector('[data-move-bar]'), 'keydown', { key: 'ArrowRight', shiftKey: true });
  assert.equal(bar.style.left, `${1400 - 600}px`, 'never past the right edge');
  // Put back
  fire(bar.querySelector('[data-dock-bar]'), 'click');
  assert.ok(bar.classList.contains('below') && !bar.classList.contains('float'));
  assert.equal(bar.style.left, '');
  assert.ok(bar.querySelector('[data-move-bar]'), 'the handle is still there');
  assert.equal(bar.querySelector('[data-dock-bar]'), null);
});

test('a spot saved before (a share of the window) is put on the page as it was at the top', async (t) => {
  const d = await pageDash(t, [{ type: 'small', signals: ['dash.speed'] }], { placement: 'float', float: { wide: { x: 0.5, y: 0.5 } } }, { scrollY: 300 });
  assert.deepEqual([d.el.style.left, d.el.style.top], [`${0.5 * 800}px`, `${0.5 * (900 - 150)}px`]);
  assert.ok(d.el.querySelector('[data-dock-bar]'), 'Put back, floating');
});

test('the List box: resized from its grip (height docked, both floating), clamped, kept per screen kind', async (t) => {
  const d = await pageDash(t, [{ type: 'small', signals: ['dash.speed'] }, { type: 'list', signals: [], q: '', changing: false }]);
  const box = d.dash.panel;
  const grip = box.querySelector('[data-size-list]');
  assert.ok(grip, 'a resize grip');
  // docked: only the height
  fire(grip, 'pointerdown', { pointerId: 1, clientX: 1390, clientY: 1050, button: 0 });
  d.send('pointermove', 1440, 1150);
  assert.equal(box.style.height, '500px');
  assert.equal(box.style.width, '', 'docked: as wide as the page');
  assert.ok(box.classList.contains('sized'), 'its rows grow with it');
  d.send('pointerup', 1440, 1150);
  assert.deepEqual((await d.saved()).listSize, { wide: { h: 500 } });
  // never taller than the window, never smaller than its least
  fire(box.querySelector('[data-size-list]'), 'pointerdown', { pointerId: 2, clientX: 0, clientY: 0, button: 0 });
  d.send('pointermove', 0, 5000, { pointerId: 2 });
  assert.equal(box.style.height, '900px');
  d.send('pointermove', 0, -5000, { pointerId: 2 });
  assert.equal(box.style.height, '170px');
  d.send('pointercancel', 0, -5000, { pointerId: 2 });
  // Shift and the arrow keys on the grip
  fire(box.querySelector('[data-size-list]'), 'keydown', { key: 'ArrowDown', shiftKey: true });
  assert.equal(box.style.height, '220px');
  // the Move handle's arrow keys take it out of its dock; then its width can change too
  fire(box.querySelector('[data-move-list]'), 'keydown', { key: 'ArrowRight' });
  assert.ok(box.classList.contains('float') && box.parentElement === document.body);
  assert.ok(box.querySelector('[data-dock-list]'), 'Dock');
  fire(box.querySelector('[data-size-list]'), 'keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.equal(box.style.width, `${560 - 50}px`);
  for (let i = 0; i < 20; i++) fire(box.querySelector('[data-size-list]'), 'keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.equal(box.style.width, '260px', 'its least width');
  const b = await d.saved();
  assert.deepEqual(b.listSize.wide, { h: 220, w: 260 });
  assert.equal(b.listPlacement, 'float');
  assert.equal(Number.isFinite(b.listFloat.wide.top), true);
  // a narrow window has its own (none yet): today's size
  globalThis.innerWidth = 500;
  document.documentElement.clientWidth = 500;
  for (const fn of d.win.resize || []) fn();
  assert.deepEqual([box.style.width, box.style.height], ['', '']);
  // back to wide: the size again, within the window
  globalThis.innerWidth = 1400;
  document.documentElement.clientWidth = 1400;
  for (const fn of d.win.resize || []) fn();
  assert.deepEqual([box.style.width, box.style.height], ['260px', '220px']);
  // Dock: back under the bar, its height kept
  fire(box.querySelector('[data-dock-list]'), 'click');
  assert.ok(box.classList.contains('below'));
  assert.deepEqual([box.style.width, box.style.height], ['', '220px']);
});

test('a bar over a short video is no taller than the video: its grip, on its top, stays where it can be reached', async (t) => {
  const d = await pageDash(t, [{ type: 'small', signals: ['dash.speed'] }], { placement: 'over', size: { wide: { h: 600 } } });
  d.stage.clientHeight = 250;
  for (const fn of d.win.resize || []) fn();
  assert.ok(d.el.classList.contains('over'));
  assert.equal(d.el.style.height, `${250 - 16}px`, 'as tall as the video, less its margins');
  // dragged up from the grip, it stops there too
  fire(d.el.querySelector('[data-size-bar]'), 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
  d.send('pointermove', 100, -400);
  assert.equal(d.el.style.height, `${250 - 16}px`);
  d.send('pointerup', 100, -400);
});
