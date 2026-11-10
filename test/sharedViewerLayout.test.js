'use strict';

// Layout of the shared web modules every interface uses (the built-in one and
// each pack): the startup-check bar publishes its height like the update bar,
// the floating car-data boxes keep clear of the Viewer's playback controls and
// a pack's fixed bottom bars, and tap targets on touch screens.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/** web/critical.js in a small stand-in page; `banner` is what /api/health/banner answers. */
async function criticalPage(banner) {
  const props = new Map();
  const classes = new Set();
  const make = (tag) => {
    const el = {
      tagName: tag.toUpperCase(), children: [], parentNode: null, style: {}, attrs: {}, listeners: {}, textContent: '', height: 48,
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { this.listeners[t] = f; },
      append(...c) { for (const x of c) { if (typeof x === 'object') { x.parentNode = this; this.children.push(x); } } },
      appendChild(c) { this.append(c); return c; },
      prepend(c) { c.parentNode = this; this.children.unshift(c); },
      remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter((x) => x !== this); this.parentNode = null; } },
      get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === body; },
      get nextSibling() { const p = this.parentNode; return p ? p.children[p.children.indexOf(this) + 1] || null : null; },
      after(c) { const p = this.parentNode; c.parentNode = p; p.children.splice(p.children.indexOf(this) + 1, 0, c); },
      getBoundingClientRect() { return { height: this.height, bottom: this.height }; }
    };
    return el;
  };
  const body = make('body');
  const head = make('head');
  const find = (n, id) => (n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean) || null);
  const document = {
    body, head, hidden: false,
    documentElement: { style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) }, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } },
    createElement: make, createElementNS: (ns, t) => make(t), getElementById: (id) => find(body, id) || find(head, id),
    addEventListener() {}
  };
  const observers = [];
  const window = {
    matchMedia: () => ({ matches: false }), addEventListener() {},
    ResizeObserver: class { constructor(f) { this.f = f; observers.push(this); } observe(el) { this.el = el; } disconnect() { this.gone = true; } }
  };
  window.top = window;
  window.self = window;
  const fetch = async (url) => ({ ok: true, json: async () => (url.includes('banner') ? banner() : {}) });
  const ctx = vm.createContext({ window, document, fetch, sessionStorage: { getItem: () => null, setItem() {} }, setTimeout: () => 0, setInterval: () => 0, console });
  vm.runInContext(read('web/critical.js'), ctx);
  await new Promise((r) => setImmediate(r));
  return { props, classes, bar: () => find(body, 'sentry-health-bar'), observers };
}

test('the startup-check bar publishes its height on <html> while it shows, as the update bar does', async () => {
  const problems = [{ label: 'Daily Driver: Free space on the share', detail: '8.9 GB free' }];
  const page = await criticalPage(() => ({ problems }));
  const bar = page.bar();
  assert.ok(bar, 'the bar shows');
  assert.equal(page.props.get('--startup-check-bar'), '48px');
  assert.ok(page.classes.has('has-startup-check'));
  // it wraps to more lines on a narrow window: the height follows
  bar.height = 125;
  page.observers.find((o) => o.el === bar).f();
  assert.equal(page.props.get('--startup-check-bar'), '125px');
  // closed: gone, and so is its height
  bar.children.find((c) => c.tagName === 'BUTTON').listeners.click();
  assert.equal(page.bar(), null);
  assert.equal(page.props.has('--startup-check-bar'), false);
  assert.ok(!page.classes.has('has-startup-check'));
  assert.ok(page.observers.every((o) => o.gone), 'no longer watched');
});

test('the packs that measure the server\'s bars themselves still find them by id', () => {
  const critical = read('web/critical.js');
  assert.match(critical, /const ID = 'sentry-critical-update';/);
  assert.match(critical, /const ID = 'sentry-health-bar';/);
  for (const f of ['examples/ui-packs/aurora/web/aurora/main.js', 'examples/ui-packs/daylight/web/dl/app.js']) {
    assert.match(read(f), /\['sentry-critical-update', 'sentry-health-bar'\]/, f);
  }
});

test('Viewer: the floating car-data boxes keep clear of the playback controls in every interface', () => {
  const extras = read('web/viewerExtras.js');
  // the row each interface gives for its buttons is in its playback controls
  assert.match(extras, /attachStatDash\(\{ stage, videos, main, over: stepsFixed, controls: buttons \}\)/);
  for (const [f, row] of [
    ['examples/ui-packs/aurora/web/aurora/pages/viewer.js', "buttons: q('#c-full').parentElement"],
    ['examples/ui-packs/daylight/web/dl/pages/viewer.js', "buttons: $('#full').parentElement"],
    ['examples/ui-packs/flux/web/flux/pages/viewer.js', "buttons: $('#vw-export').parentElement"],
    ['examples/ui-packs/horizon/web/hz/pages/viewer.js', "buttons: $('#vw-export').parentElement"],
    ['web/electronApiShim.js', "buttons: document.getElementById('settingsBtn')?.parentElement"]
  ]) assert.ok(read(f).includes(row), `${f} gives its controls' row`);
  const sd = read('web/statDash.js');
  // under a pack's fixed bottom bars (a tab bar, a dock): the pack's own z-index for the boxes still wins
  assert.match(sd, /\.sentry-sd\.float\{position:absolute;z-index:var\(--sd-float-z,2147482000\)/);
  assert.match(read('examples/ui-packs/aurora/web/aurora/app.css'), /body > \.sentry-sd\.float, body > \.sentry-sd\.sd-listpanel\.float \{ z-index: 25; \}/);
});

test('Touch screens: the Viewer\'s small shared buttons are at least 40 px to tap', () => {
  const sd = read('web/statDash.js');
  const coarse = sd.slice(sd.indexOf('@media (pointer:coarse){'), sd.indexOf('@media (max-width:640px){'));
  assert.match(coarse, /\.sentry-sd button\.sd-btn\.sd-size\{width:40px;height:40px/, 'the resize grips');
  assert.match(coarse, /\.sentry-sd \.sd-list-ch\{min-height:40px/, '"Changing only"');
  assert.match(coarse, /\.sentry-sd\.sd-listpanel\.below,\.sentry-sd\.sd-listpanel\.float\{padding-bottom:44px\}/, 'room for the List\'s grip');
  assert.match(read('web/layouts.js'), /@media \(pointer:coarse\)\{\.sentry-ls button\{min-width:40px;height:40px/, 'layout slots 1 2 3');
  assert.match(read('web/viewerExtras.js'), /@media \(pointer:coarse\)\{\.sentry-x-btn\{min-width:40px;min-height:40px/, 'Pop out');
});

test('Viewer on a phone: the frame-step bubbles go to the sides of a small camera, still at least 40 px', () => {
  const x = read('web/viewerExtras.js');
  assert.match(x, /const side = r\.width < 480 \|\| r\.height < 270;/);
  assert.match(x, /\.sentry-x-steps\.sx-side\{top:50%;bottom:auto;transform:translateY\(-50%\);justify-content:space-between/);
  assert.match(x, /\.sentry-x-steps\.sx-side button\{width:44px;height:44px/);
  assert.match(x, /\.sentry-x-steps\.sx-side\.sx-tiny button\{width:40px;height:40px/);
  // (class names of their own: Daylight's side bar is .side)
  assert.doesNotMatch(x, /\.sentry-x-steps\.side\b/);
  // Horizon's own rule puts them at the sides of its main camera the same way
  assert.match(read('examples/ui-packs/horizon/web/hz/app.css'), /\.cam\.main \.sentry-x-steps \{ top: 50%; bottom: auto; transform: translateY\(-50%\); justify-content: space-between;/);
});

test('Viewer: a narrow List (a 320 px phone) shows each stat on two lines, its source under its name, not cut to nothing', () => {
  const sd = read('web/statDash.js');
  assert.match(sd, /const two = \(scroll\.clientWidth \|\| Infinity\) < NARROW_LIST;/);
  assert.match(sd, /const NARROW_LIST = 400;/);
  assert.match(sd, /const ROW_TWO = 44;/);
  assert.match(sd, /\.sentry-sd \.sd-list-two \.sd-list-m\{grid-area:2\/1\}/);
  assert.match(sd, /\.sentry-sd \.sd-list-two \.sd-list-r\{height:44px\}/, 'the rows as tall as they are placed');
  // every row is placed at the row height in use
  assert.doesNotMatch(sd, /style="top:\$\{\(first \+ k\) \* ROW\}px"/);
});
