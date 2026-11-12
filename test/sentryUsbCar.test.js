'use strict';

// Sentry USB's info file on the share (docs/sentry-usb.md, "The info file"):
// the server keeps only known keys with sane values (server/sentryUsbCar.js,
// server/sentryUsbDevice.js), reads it beside the status file
// (server/sentryUsb.js), and the Sentry USB tab (web/sentryUsbInfo.js) shows
// it in the Manager's own units, in every interface. No pairing, no link.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { cleanCar } = require('../server/sentryUsbCar');
const { parseDevice } = require('../server/sentryUsbDevice');
const { createSentryUsbStatus } = require('../server/sentryUsb');
// the shared page module (web/sentryUsbInfo.js) as text for a data: import, its import of
// the one unit choice (web/units.js) pointed at the file
const pageSource = () => fs.readFileSync(path.join(__dirname, '..', 'web', 'sentryUsbInfo.js'), 'utf8')
  .replace("import '/web/units.js';", `import ${JSON.stringify(require('node:url').pathToFileURL(path.join(__dirname, '..', 'web', 'units.js')).href)};`);

const REPO = path.join(__dirname, '..');
const NOW = Date.parse('2026-11-10T18:00:00Z');
const T = NOW / 1000;
const GOOD = {
  battery: { pct: 89, charging: false, at: T - 60 },
  interior: { c: 9.4, at: T - 60 },
  exterior: { c: 7.8, at: T - 120 },
  tires: { fl: { kpa: 289.6, at: T - 7200 }, fr: { kpa: 289.6, at: T - 7200 }, rl: { kpa: 282.7, at: T - 28800 }, rr: { kpa: 289.6, at: T - 28800 }, state: 'optimal' },
  drive: { state: 'parked', since: T - 9000 },
  units: { temp: 'F', pressure: 'psi' }
};
const clean = (car) => cleanCar(car, { now: NOW });
const withPart = (k, v) => ({ ...structuredClone(GOOD), [k]: v });

test('car: a good car object is kept as it is', () => {
  assert.deepEqual(clean(GOOD), GOOD);
  // every part is optional
  assert.deepEqual(clean({ battery: { pct: 50 } }), { battery: { pct: 50 } });
  assert.deepEqual(clean({ drive: { state: 'driving', at: T - 5 } }), { drive: { state: 'driving', at: T - 5 } });
});

test('car: unknown keys are not kept, anywhere', () => {
  const car = { ...structuredClone(GOOD), location: 'Home', latitude: 41.9, vin: '5YJ3E1EA4JF000001' };
  car.battery.range_mi = 230;
  car.tires.fl.psi = 42;
  car.tires.spare = { kpa: 200 };
  car.units.distance = 'mi';
  const out = clean(car);
  assert.deepEqual(out, GOOD);
  assert.doesNotMatch(JSON.stringify(out), /Home|41\.9|5YJ3|range|spare|distance|"psi":/);
});

test('car: a reading with a bad value is dropped, the others are kept', () => {
  const bad = [
    ['battery', { pct: 101 }], ['battery', { pct: -1 }], ['battery', { pct: '89' }], ['battery', { pct: null }], ['battery', { pct: NaN }],
    ['battery', { pct: 80, charging: 'yes' }], ['battery', { charging: true }], ['battery', [89]], ['battery', 'full'],
    ['interior', { c: 120 }], ['interior', { c: -61 }], ['interior', { c: Infinity }], ['exterior', { c: 71 }], ['exterior', { c: '7' }],
    ['battery', { pct: 80, at: 12 }], ['battery', { pct: 80, at: T + 2 * 86400 }], ['battery', { pct: 80, at: T - 0.5 }], ['battery', { pct: 80, at: '1762800000' }],
    ['drive', { state: 'flying' }], ['drive', { state: 'parked', since: -5 }], ['drive', { state: 'parked', since: 1.5e9 + 0.5 }], ['drive', {}]
  ];
  for (const [k, v] of bad) {
    const out = clean(withPart(k, v));
    assert.equal(out[k], undefined, `${k} ${JSON.stringify(v)} is dropped`);
    const rest = Object.keys(GOOD).filter((x) => x !== k);
    for (const x of rest) assert.deepEqual(out[x], GOOD[x], `${x} is kept when ${k} is bad`);
  }
  // one bad tire goes, the other three stay; a bad state is not kept
  const tires = clean(withPart('tires', { ...GOOD.tires, rl: { kpa: 5000 }, fr: { kpa: -1 }, state: 'great' })).tires;
  assert.deepEqual(Object.keys(tires), ['fl', 'rr']);
  assert.equal(clean(withPart('tires', { state: 'optimal' })).tires, undefined, 'a state without a tire is no tires');
  // units out of the list are not kept; units alone are no car
  assert.equal(clean(withPart('units', { temp: 'K', pressure: 'atm' })).units, undefined);
  assert.equal(clean({ units: { temp: 'F' } }), null);
});

test('car: no car, a broken car or one with nothing valid left is no car', () => {
  for (const v of [undefined, null, 0, 'car', [], [GOOD], {}, { battery: { pct: 200 } }, { tires: { fl: { kpa: 'x' } } }]) assert.equal(clean(v), null, JSON.stringify(v));
});

// ---- the info file
const FILE = (over = {}) => ({
  schema: 1, written_unix: T - 300, version: 'v3.28.10-test.32',
  storage: { total_bytes: 256e9, used_bytes: 98.1e9, free_bytes: 157.9e9 },
  drives: [{ name: 'cam', size_bytes: 64e9 }, { name: 'music', size_bytes: 4e9 }],
  cpu_temp_c: 51.24, car: GOOD, ...over
});

test('info file: a good one is kept; the car checked as the Car card wants it', () => {
  const d = parseDevice(JSON.stringify(FILE()), { now: NOW });
  assert.deepEqual(d, {
    writtenUnix: T - 300, version: 'v3.28.10-test.32',
    storage: { totalBytes: 256e9, usedBytes: 98.1e9, freeBytes: 157.9e9 },
    drives: [{ name: 'cam', sizeBytes: 64e9 }, { name: 'music', sizeBytes: 4e9 }],
    cpuTempC: 51.2, car: (() => { const c = clean(GOOD); delete c.units; return c; })()
  });
  // only schema and written_unix are needed
  assert.deepEqual(parseDevice({ schema: 1, written_unix: T }, { now: NOW }), { writtenUnix: T, version: null, storage: null, drives: [], cpuTempC: null, car: null });
});

test('info file: anything wrong is dropped, field by field; no schema or a bad time is no file', () => {
  for (const bad of ['', 'not json', '[]', JSON.stringify({ written_unix: T }), JSON.stringify(FILE({ schema: 2 })),
    JSON.stringify(FILE({ written_unix: 1000 })), JSON.stringify(FILE({ written_unix: T + 3 * 86400 })), JSON.stringify(FILE({ written_unix: 'now' }))]) {
    assert.equal(parseDevice(bad, { now: NOW }), null, bad.slice(0, 60));
  }
  const d = parseDevice(FILE({
    version: 'v1\u0000<b>x</b>'.padEnd(200, 'y'),
    storage: { total_bytes: 10, used_bytes: 50, free_bytes: -1 },
    drives: [{ name: 'cam', size_bytes: 5 }, { name: 'cam', size_bytes: 6 }, { name: 'secret', size_bytes: 1 }, { name: 'music', size_bytes: 'big' }, 'x'],
    cpu_temp_c: 900, car: { battery: 'full' }, extra: { deep: true }
  }), { now: NOW });
  assert.equal(d.version.length, 64, 'capped');
  assert.doesNotMatch(d.version, /\u0000/);
  assert.deepEqual(d.storage, { totalBytes: null, usedBytes: 50, freeBytes: null }, 'a total smaller than what it holds is not believed; negative bytes dropped');
  assert.deepEqual(d.drives, [{ name: 'cam', sizeBytes: 5 }], 'known names, once each, sizes as numbers');
  assert.equal(d.cpuTempC, null);
  assert.equal(d.car, null);
  assert.equal('extra' in d, false);
});

test('reader: the info file beside the status file, re-read only when it changes; gone when it goes', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'su-info-'));
  try {
    const dir = path.join(root, '.sentryusb');
    await fsp.mkdir(dir);
    const v = { id: 'car1', name: 'Daily', timezone: 'UTC' };
    const vehicles = { get: (id) => (id === v.id ? v : null), list: () => [v], rootOf: () => root };
    const changes = [];
    const su = createSentryUsbStatus({ vehicles, now: () => NOW, onChange: (vid) => changes.push(vid), timers: { setInterval: () => null, clearInterval() {} } });
    await su.refresh('car1');
    assert.equal(su.device('car1'), null, 'no file: nothing');
    await fsp.writeFile(path.join(dir, 'device-status.json'), JSON.stringify(FILE()));
    await su.refresh('car1');
    const d = su.device('car1');
    assert.equal(d.present, true);
    assert.equal(d.error, null);
    assert.equal(d.info.version, 'v3.28.10-test.32');
    assert.equal(d.info.car.tires.fl.kpa, 289.6);
    assert.deepEqual(changes, ['car1']);
    await su.refresh('car1');
    assert.equal(su.device('car1').info, d.info, 'unchanged: not parsed again');
    assert.deepEqual(changes, ['car1']);
    await fsp.writeFile(path.join(dir, 'device-status.json'), '{"schema":9}');
    await fsp.utimes(path.join(dir, 'device-status.json'), new Date(), new Date(Date.now() + 5000));
    await su.refresh('car1');
    assert.deepEqual([su.device('car1').info, su.device('car1').error], [null, 'not a schema 1 info file']);
    await fsp.writeFile(path.join(dir, 'device-status.json'), 'x'.repeat(17 * 1024));
    await su.refresh('car1');
    assert.equal(su.device('car1').error, 'too large');
    await fsp.rm(path.join(dir, 'device-status.json'));
    await su.refresh('car1');
    assert.equal(su.device('car1'), null);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

// ---- the Car card's words (the same module in every interface)
const page = () => import(`data:text/javascript,${encodeURIComponent(pageSource())}`);

test('Car card: battery, temperatures and four tires with their ages, in the Manager\'s units (not the Pi\'s)', async () => {
  const { carView } = await page();
  const U = globalThis.SentryUnits;
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  try {
    const v = carView(GOOD, { now: NOW });
    assert.equal(v.state, 'Parked · 2 h 30 min');
    assert.deepEqual(v.battery, { label: 'Battery', value: '89%', age: 'just now', charging: false });
    // nothing chosen yet, a US browser: miles, so °F and psi
    assert.deepEqual([v.interior.value, v.exterior.value], ['49°F', '46°F']);
    assert.deepEqual(['fl', 'fr', 'rl', 'rr'].map((p) => [v.tires[p].label, v.tires[p].value, v.tires[p].age]), [
      ['Front left', '42 psi', '2h ago'], ['Front right', '42 psi', '2h ago'], ['Rear left', '41 psi', '8h ago'], ['Rear right', '42 psi', '8h ago']
    ]);
    assert.deepEqual(v.tires.state, { kind: 'optimal', label: 'Optimal' });
    assert.equal(v.units, '°F · psi');
    // the Pi's own °C and bar do not change it: the Manager is on miles
    const pi = carView({ ...GOOD, units: { temp: 'C', pressure: 'bar' } }, { now: NOW });
    assert.deepEqual([pi.interior.value, pi.exterior.value, pi.tires.fl.value, pi.units], ['49°F', '46°F', '42 psi', '°F · psi']);
    // kilometres chosen (any page's mph/km/h button): °C and bar, whatever the Pi says
    U.set(true);
    const m = carView({ ...GOOD, units: { temp: 'F', pressure: 'psi' } }, { now: NOW });
    assert.deepEqual([m.interior.value, m.exterior.value, m.tires.fl.value, m.units], ['9°C', '8°C', '2.90 bar', '°C · bar']);
    // and back to miles
    U.set(false);
    assert.equal(carView(GOOD, { now: NOW }).units, '°F · psi');
    // asked for one (as the page does after a change)
    assert.equal(carView(GOOD, { now: NOW, metric: true }).interior.value, '9°C');
  } finally {
    delete globalThis.localStorage;
  }
  // charging, driving, a tire missing, a check state
  const c = carView({ ...GOOD, battery: { pct: 61.6, charging: true, at: T - 30 }, drive: { state: 'driving', at: T }, tires: { ...GOOD.tires, rr: undefined, state: 'check' } }, { now: NOW });
  assert.deepEqual([c.battery.label, c.battery.value, c.battery.age, c.state], ['Charging', '62%', 'just now', 'Driving · charging']);
  assert.equal(c.tires.rr, null);
  assert.deepEqual(c.tires.state, { kind: 'check', label: 'Check tires' });
  // nothing to show: the card says "No car data yet"
  for (const none of [null, undefined, {}, [], 'x', { units: { temp: 'F' } }]) assert.equal(carView(none, { now: NOW }), null, JSON.stringify(none));
});

test('Sentry USB tab: storage, version and CPU as of when the Pi wrote them; stale after a day', async () => {
  const { infoView, bytesText } = await page();
  const info = parseDevice(FILE(), { now: NOW });
  const v = infoView(info, { now: NOW, metric: false });
  assert.deepEqual(v, {
    version: 'v3.28.10-test.32', asOf: '5 min ago', stale: false, used: '98.1 GB', free: '158 GB', total: '256 GB', pct: 38,
    drives: [{ label: 'Dashcam', value: '64.0 GB' }, { label: 'Music', value: '4.0 GB' }], cpu: '124°F'
  });
  assert.equal(infoView(info, { now: NOW, metric: true }).cpu, '51°C');
  assert.equal(infoView({ ...info, writtenUnix: T - 2 * 86400 }, { now: NOW }).stale, true);
  // only free and total: used worked out
  assert.deepEqual((({ used, free, pct }) => ({ used, free, pct }))(infoView({ ...info, storage: { totalBytes: 100e9, usedBytes: null, freeBytes: 25e9 } }, { now: NOW })), { used: '75.0 GB', free: '25.0 GB', pct: 75 });
  assert.deepEqual([bytesText(512), bytesText(1.4e12), bytesText(null)], ['512 B', '1.4 TB', '—']);
});

test('Sentry USB tab: no pairing anywhere; text only; styled in every interface; no link left on the server', () => {
  const src = fs.readFileSync(path.join(REPO, 'web', 'sentryUsbInfo.js'), 'utf8');
  assert.match(src, /carCard\(d\.info\.car\)/, 'the tab shows the Car card');
  assert.match(src, /'No car data yet'/);
  assert.match(src, /fetch\(url/);
  assert.doesNotMatch(src, /\/pair|pairing code|method:/i, 'read-only, no pairing');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/, 'the Pi\'s values go in as text');
  for (const f of ['web/app.js', 'examples/ui-packs/aurora/web/aurora/pages/sentryusb.js', 'examples/ui-packs/daylight/web/dl/pages/sentryusb.js', 'examples/ui-packs/flux/web/flux/pages/sentryusb.js', 'examples/ui-packs/horizon/web/hz/pages/sentryusb.js']) {
    const page = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.match(page, /\/web\/sentryUsbInfo\.js/, f);
    assert.doesNotMatch(page, /sentryUsbLink|pair it, see its status/, f);
  }
  const sheets = {
    'built-in': 'web/shell.css', aurora: 'examples/ui-packs/aurora/web/aurora/app.css', daylight: 'examples/ui-packs/daylight/web/dl/app.css',
    flux: 'examples/ui-packs/flux/web/flux.css', horizon: 'examples/ui-packs/horizon/web/hz/app.css'
  };
  for (const [name, f] of Object.entries(sheets)) {
    const css = fs.readFileSync(path.join(REPO, f), 'utf8');
    for (const v of ['--sul-car-bg', '--sul-car-accent', '--sul-car-ok', '--sul-car-warn', '--sul-car-bad']) assert.match(css, new RegExp(`${v}:`), `${name} sets ${v}`);
  }
  const server = fs.readFileSync(path.join(REPO, 'server', 'index.js'), 'utf8');
  assert.doesNotMatch(server, /sentryusb\/pair|sentryusb\/:id\/proxy|handleUpgrade/);
  for (const gone of ['sentryUsbLink.js', 'sentryUsbQueue.js', 'sentryUsbAudit.js', 'wsFrames.js']) assert.equal(fs.existsSync(path.join(REPO, 'server', gone)), false, gone);
});
