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
function fire(target, type) {
  const e = { target, preventDefault() {}, stopPropagation() {} };
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
    asked.push({ url: u, signal: opts.signal });
    if (u.pathname === '/api/dashboards') return Promise.resolve(json(routes.boards || { boards: [], active: null }));
    if (u.pathname === '/api/telemetry') return Promise.resolve(json({ frames: [] }));
    const route = routes[u.pathname === '/api/can/raw' && u.searchParams.get('probe') ? 'probe' : u.pathname];
    if (!route) return Promise.resolve(json(null, 404));
    return Promise.resolve(route(u.searchParams.get('path'), u, opts)).then((r) => (r && r.status ? json(r.body, r.status) : json(r)));
  };
  return asked;
}
let instance = 0;
async function dashboard({ rawOpen = true, routes = {}, clip = clipPath(1) } = {}) {
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
  const dash = mod.attachStatDash({ stage, main: () => video, videos: () => [video] });
  // one animation frame (the dashboard's loop), then whatever it asked for
  const frame = async () => { const fn = frames.shift(); fn?.(); await settle(); };
  await settle();
  await frame();
  return { dash, el: dash.el, video, asked, frame, raw: () => dash.el.querySelector('.sd-raw'), rawButton: () => dash.el.querySelector('[data-raw]') };
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
