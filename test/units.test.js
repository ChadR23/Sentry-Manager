'use strict';

// The one unit choice (web/units.js): miles means mph, °F and psi, kilometres
// km/h, °C and bar, in every interface. Unit spellings from DBCs, the default
// from the browser's language, a change told to every page, and each place a
// temperature is shown reading it (the owner saw °C while on miles).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const U = require('../web/units');

function withStorage(fn, { lang = 'en-US' } = {}) {
  const store = new Map();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  Object.defineProperty(globalThis, 'navigator', { value: { language: lang }, configurable: true });
  try {
    return fn(store);
  } finally {
    delete globalThis.localStorage;
    if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator;
  }
}

test('unit spellings: every way a DBC writes °C (and the others) is one unit', () => {
  for (const u of ['C', 'c', 'degC', 'deg C', 'DegC', 'DEGC', '°C', '° C', 'ºC', 'Celsius', 'celsius', 'deg_C', 'degrees C', 'Degrees Celsius', ' C ', '\u2103']) assert.equal(U.canonUnit(u), 'C', JSON.stringify(u));
  for (const u of ['F', 'degF', 'deg F', '°F', 'Fahrenheit']) assert.equal(U.canonUnit(u), 'F', u);
  for (const u of ['kph', 'KPH', 'km/h', 'Km/h', 'kmh', 'km/hr', 'KPH ']) assert.equal(U.canonUnit(u), 'km/h', u);
  for (const u of ['mph', 'MPH', 'mi/h']) assert.equal(U.canonUnit(u), 'mph', u);
  for (const u of ['km', 'KM', 'Km']) assert.equal(U.canonUnit(u), 'km', u);
  for (const u of ['mi', 'miles']) assert.equal(U.canonUnit(u), 'mi', u);
  for (const u of ['m', 'M']) assert.equal(U.canonUnit(u), 'm', u);
  for (const u of ['m/s', 'M/S']) assert.equal(U.canonUnit(u), 'm/s', u);
  for (const u of ['deg', 'Deg', 'DEG', 'degrees']) assert.equal(U.canonUnit(u), 'deg', u);
  for (const u of ['kWh', 'KWh', 'kwh']) assert.equal(U.canonUnit(u), 'kWh', u);
  for (const u of ['Nm', 'NM', 'nm']) assert.equal(U.canonUnit(u), 'Nm', u);
  for (const u of ['kPa', 'KPA', 'kpa']) assert.equal(U.canonUnit(u), 'kPa', u);
  assert.equal(U.canonUnit('bar'), 'bar');
  assert.equal(U.canonUnit('PSI'), 'psi');
  for (const u of ['', 'V', '%', 'A', 'kph/mph', null, undefined, 3]) assert.equal(U.canonUnit(u), null, String(u));
});

test('temperatures, differences and pressures in either unit', () => {
  assert.equal(U.tempText(21, { m: true }), '21 °C');
  assert.equal(U.tempText(21, { m: false }), '70 °F');
  assert.equal(U.tempText(-40, { m: false }), '-40 °F');
  assert.equal(U.tempText(36.6, { m: false, digits: 1, space: false }), '97.9°F');
  assert.equal(U.tempText(null, { m: false }), '—');
  assert.equal(U.tempText(undefined), '—');
  assert.equal(U.tempUnit(true), '°C');
  assert.equal(U.tempUnit(false), '°F');
  assert.equal(U.tempDelta(5, false), 9, 'a spread has no +32');
  assert.equal(U.pressureUnit(false), 'psi');
  assert.equal(U.pressureUnit(true), 'bar');
  assert.equal(Math.round(U.pressure(290, false)), 42);
  assert.equal(U.pressure(290, true), 2.9);
  // a server's words ("CPU at 92 °C", an alert) in °F with miles, as they are with kilometres
  assert.equal(U.inText('CPU at 92 °C', false), 'CPU at 198 °F');
  assert.equal(U.inText('NVMe disk nvme0n1 at 71 °C', false), 'NVMe disk nvme0n1 at 160 °F');
  assert.equal(U.inText('at 36.5°C', false), 'at 97.7°F');
  assert.equal(U.inText('CPU at 92 °C', true), 'CPU at 92 °C');
  assert.equal(U.inText('Memory almost full: 4% available', false), 'Memory almost full: 4% available');
});

test('the choice: miles in the US by default (as speed was), kept, told to every page; a page\'s older choice only until one is made', () => {
  withStorage((store) => {
    assert.equal(U.metric(), false, 'en-US: miles');
    assert.equal(U.chosen(), false);
    const seen = [];
    const off = U.onChange((m) => seen.push(m));
    U.set(true);
    assert.equal(store.get('sentry-driving-units'), 'km', 'the Driving page\'s key: one choice');
    assert.equal(U.metric(), true);
    assert.equal(U.adopt(false), true, 'an older page choice does not undo one made');
    U.set(false);
    assert.deepEqual(seen, [true, false]);
    off();
    U.set(true);
    assert.deepEqual(seen, [true, false], 'off');
  });
  withStorage(() => { assert.equal(U.adopt(true), true, 'nothing chosen: the older one is taken'); assert.equal(U.chosen(), true); });
  withStorage(() => { assert.equal(U.adopt(undefined), false, 'no older one: the language'); assert.equal(U.chosen(), false); });
  for (const [lang, metric] of [['en-US', false], ['en-GB', false], ['en', false], ['en-LR', false], ['en-AU', true], ['en-CA', true], ['de-DE', true], ['fr', true]]) {
    withStorage(() => assert.equal(U.metric(), metric, lang), { lang });
  }
  withStorage((store) => { store.set('sentry-driving-units', 'km'); assert.equal(U.metric(), true, 'the Driving page\'s earlier "Kilometres" counts'); });
  // storage blocked: still answers
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  try { U.set(true); assert.equal(typeof U.metric(), 'boolean'); } finally { delete globalThis.localStorage; }
});

// ---- every place a temperature is shown reads the one choice ----------------
const PACKS = ['aurora', 'daylight', 'flux', 'horizon'];
const TEMP_FILES = [
  'web/app.js', 'web/sentryUsbLink.js', 'web/statDash.js', 'src/renderer/scripts/features/hardwarePanel.js',
  'examples/ui-packs/flux/web/flux/pages/overview.js', 'examples/ui-packs/horizon/web/hz/pages/dashboard.js',
  'examples/ui-packs/aurora/web/aurora/pages/sky.js', 'examples/ui-packs/daylight/web/dl/pages/server.js'
];

test('no page writes a fixed °C: each temperature goes through the one choice', () => {
  for (const f of TEMP_FILES) {
    // (comments, and the fallback for a page without web/units.js, which says so on its line)
    const code = read(f).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l) && !/SentryUnits \?|units\(\) \?/.test(l)).join('\n');
    // a template that puts "°C" after a number (the old `${Math.round(c)} °C`), outside web/units.js
    assert.doesNotMatch(code, /\}\s?°C[`'"<]/, `${f}: a fixed °C`);
    assert.match(read(f), /SentryUnits|UNITS\./, `${f} reads web/units.js`);
  }
  assert.match(read('web/app.js'), /const temp = \(c\) => \(globalThis\.SentryUnits \? SentryUnits\.tempText\(c\)/);
});

test('the one choice is loaded where each interface needs it, and every Viewer\'s speed button uses it', () => {
  const index = read('web/index.html');
  assert.ok(index.indexOf('<script src="/web/units.js"></script>') > 0 && index.indexOf('/web/units.js') < index.indexOf('/web/app.js'), 'before app.js');
  const server = read('server/index.js');
  assert.match(server, /<script src="\/web\/electronApiShim\.js"><\/script>\\n<script src="\/web\/units\.js"><\/script>/, 'the Studio Viewer');
  assert.match(server, /<script src="\/web\/units\.js" defer><\/script>/, 'the Encoder (its Hardware panel)');
  const studio = read('src/renderer/script.js');
  assert.match(studio, /const sharedUnits = window\.SentryUnits \|\| null;/);
  assert.match(studio, /sharedUnits\.adopt\(typeof saved === 'boolean' \? saved : undefined\)/, 'Studio\'s saved useMetric only until a choice is made');
  assert.match(studio, /sharedUnits\.set\(useMetric\)/, 'its toggle sets the one choice');
  assert.match(studio, /sharedUnits\?\.onChange\(/, 'and follows it');
  for (const f of ['web/statDash.js', 'web/sentryUsbLink.js', 'web/driving.js', 'web/drives.js']) assert.match(read(f), /^import '\/web\/units\.js';$/m, f);
  assert.match(read('web/statDash.js'), /if \(t\.matches\('\[data-units\]'\)\) \{ UNITS\.set\(!UNITS\.metric\(\)\); return; \}/, 'the car data\'s mph/km/h button');
  assert.match(read('web/statDash.js'), /const conv = canUnit\(m\.unit\);/, 'a CAN unit by its one spelling');
  for (const pack of PACKS) {
    const dir = { aurora: 'aurora', daylight: 'dl', flux: 'flux', horizon: 'hz' }[pack];
    const v = read(`examples/ui-packs/${pack}/web/${dir}/pages/viewer.js`);
    assert.match(v, /^import '\/web\/units\.js';$/m, `${pack} Viewer`);
    assert.match(v, /UNITS\.adopt\(savedUnits\(\)\) \? 'kmh' : 'mph'/, `${pack}: starts from the one choice`);
    assert.match(v, /if \(UNITS\.metric\(\) !== \(u === 'kmh'\)\) UNITS\.set\(u === 'kmh'\);/, `${pack}: its button sets it`);
    assert.match(v, /UNITS\.onChange\(/, `${pack}: follows it`);
    assert.doesNotMatch(v, /(store|local)\.set\('vw[.:]units'|store\.set\('units?'/, `${pack}: no unit of its own`);
    const notes = read(`examples/ui-packs/${pack}/web/${dir}/pages/${pack === 'horizon' || pack === 'aurora' ? 'alerts' : 'notifications'}.js`);
    assert.match(notes, /unitText\(n\.title\)/, `${pack}: a server alert's °C in the chosen unit`);
  }
  assert.match(read('examples/ui-packs/horizon/web/hz/pages/settings.js'), /globalThis\.SentryUnits\.set\(e\.target\.checked\)/, 'Horizon Settings');
  assert.match(read('web/app.js'), /esc\(unitText\(n\.title\)\)/, 'built-in notifications');
});
