'use strict';

// The car in a Sentry USB's status push (docs/sentry-usb-link.md section 4,
// "The car"): the server keeps only known keys with sane values
// (server/sentryUsbCar.js), stores it with the status, and the Status tab's
// Car card (web/sentryUsbLink.js) says it in the Pi's units, in every interface.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { cleanCar } = require('../server/sentryUsbCar');
const { TlsManager } = require('../server/tls');
const L = require('../server/sentryUsbLink');
const { connectFakePi, makeCar } = require('./fixtures/fakeSentryUsb');

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

// ---- the link: a Pi pushes it, Manager keeps the checked one with the status
const quiet = { info() {}, warn() {}, debug() {} };
const memDb = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? structuredClone(m.get(k)) : f), set: (k, v) => m.set(k, structuredClone(v)), raw: m };
};
async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-car-'));
  const tls = new TlsManager({ dir: path.join(dir, 'tls'), log: quiet, hostnames: ['127.0.0.1'] });
  await tls.ensure();
  const link = L.createSentryUsbLink({ db: memDb(), log: quiet, iterations: 1000 });
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'tls', 'server.key')), cert: fs.readFileSync(path.join(dir, 'tls', 'server.crt')) }, (req, res) => { res.writeHead(404); res.end(); });
  srv.on('upgrade', (req, socket, head) => link.handleUpgrade(req, socket, head));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const pis = [];
  const close = async () => { link.close(); for (const p of pis) p.ws?.terminate(); srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); };
  const pair = async (state) => {
    const { code } = await link.openPairing({ name: 'Car', username: 'pi', password: 'raspberry' });
    const p = await connectFakePi({ port: srv.address().port, iterations: 1000, mode: 'pair', username: 'pi', password: 'raspberry', code, state, net: false });
    pis.push(p);
    return p;
  };
  return { link, pair, close };
}
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

test('link: the car is stored with the status, checked; a bad one is not stored', async () => {
  const t = await setup();
  try {
    const { fakeState } = require('./fixtures/fakeSentryUsb');
    const st = fakeState();
    const p = await t.pair(st);
    assert.equal(p.result, 'ok');
    await until(() => t.link.devices()[0]?.status);
    const car = t.link.devices()[0].status.car;
    assert.equal(car.battery.pct, 89);
    assert.equal(car.drive.state, 'parked');
    assert.deepEqual(car.units, { temp: 'F', pressure: 'psi' });

    // a Pi sending junk in its car: the junk is not kept, the rest of the status is
    st.car = { ...makeCar(), battery: { pct: 1e9 }, extra: { deep: 'x' }, tires: { fl: { kpa: 290, sneaky: '<img src=x onerror=alert(1)>' } } };
    const sent = t.link.devices()[0].statusAt;
    p.pushStatus();
    await until(() => t.link.devices()[0].statusAt !== sent);
    const s2 = t.link.devices()[0].status;
    assert.equal(s2.drives_active, 'yes');
    assert.equal(s2.car.battery, undefined);
    assert.equal(s2.car.extra, undefined);
    assert.deepEqual(s2.car.tires, { fl: { kpa: 290 } });
    assert.doesNotMatch(JSON.stringify(s2), /onerror|sneaky/);

    // nothing valid: no car key at all
    st.car = { battery: 'full' };
    const sent2 = t.link.devices()[0].statusAt;
    p.pushStatus();
    await until(() => t.link.devices()[0].statusAt !== sent2);
    assert.equal('car' in t.link.devices()[0].status, false);
  } finally { await t.close(); }
});

// ---- the Car card's words (the same module in every interface)
const page = () => import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(REPO, 'web', 'sentryUsbLink.js'), 'utf8'))}`);

test('Car card: battery, temperatures and four tires with their ages, in the Pi\'s units', async () => {
  const { carView } = await page();
  const v = carView(GOOD, { now: NOW });
  assert.equal(v.state, 'Parked · 2 h 30 min');
  assert.deepEqual(v.battery, { label: 'Battery', value: '89%', age: 'just now', charging: false });
  assert.deepEqual([v.interior.value, v.exterior.value], ['49°F', '46°F']);
  assert.deepEqual(['fl', 'fr', 'rl', 'rr'].map((p) => [v.tires[p].label, v.tires[p].value, v.tires[p].age]), [
    ['Front left', '42 psi', '2h ago'], ['Front right', '42 psi', '2h ago'], ['Rear left', '41 psi', '8h ago'], ['Rear right', '42 psi', '8h ago']
  ]);
  assert.deepEqual(v.tires.state, { kind: 'optimal', label: 'Optimal' });
  assert.equal(v.units, '°F · psi');
  // °C and bar when the Pi shows those
  const m = carView({ ...GOOD, units: { temp: 'C', pressure: 'bar' } }, { now: NOW });
  assert.deepEqual([m.interior.value, m.exterior.value, m.tires.fl.value, m.units], ['9°C', '8°C', '2.90 bar', '°C · bar']);
  // no units sent: °F and psi, as the Pi's dashboard shows them by default for this owner
  assert.equal(carView({ ...GOOD, units: undefined }, { now: NOW }).units, '°F · psi');
  // charging, driving, a tire missing, a check state
  const c = carView({ ...GOOD, battery: { pct: 61.6, charging: true, at: T - 30 }, drive: { state: 'driving', at: T }, tires: { ...GOOD.tires, rr: undefined, state: 'check' } }, { now: NOW });
  assert.deepEqual([c.battery.label, c.battery.value, c.battery.age, c.state], ['Charging', '62%', 'just now', 'Driving · charging']);
  assert.equal(c.tires.rr, null);
  assert.deepEqual(c.tires.state, { kind: 'check', label: 'Check tires' });
  // nothing to show: the card says "No car data yet"
  for (const none of [null, undefined, {}, [], 'x', { units: { temp: 'F' } }]) assert.equal(carView(none, { now: NOW }), null, JSON.stringify(none));
});

test('Car card: on the Status tab, text only, styled in every interface', () => {
  const src = fs.readFileSync(path.join(REPO, 'web', 'sentryUsbLink.js'), 'utf8');
  assert.match(src, /carCard\(s\.car\)/, 'the Status tab shows it');
  assert.match(src, /'No car data yet'/);
  const card = src.slice(src.indexOf('function carCard'), src.indexOf('// why pairing did not work'));
  assert.doesNotMatch(card, /innerHTML|insertAdjacentHTML|outerHTML/, 'the Pi\'s values go in as text');
  const sheets = {
    'built-in': 'web/shell.css', aurora: 'examples/ui-packs/aurora/web/aurora/app.css', daylight: 'examples/ui-packs/daylight/web/dl/app.css',
    flux: 'examples/ui-packs/flux/web/flux.css', horizon: 'examples/ui-packs/horizon/web/hz/app.css'
  };
  for (const [name, f] of Object.entries(sheets)) {
    const css = fs.readFileSync(path.join(REPO, f), 'utf8');
    for (const v of ['--sul-car-bg', '--sul-car-accent', '--sul-car-ok', '--sul-car-warn', '--sul-car-bad']) assert.match(css, new RegExp(`${v}:`), `${name} sets ${v}`);
  }
});
