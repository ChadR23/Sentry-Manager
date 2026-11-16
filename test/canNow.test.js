'use strict';

// Live CAN stats for a Stream Deck (server/canNow.js, GET /api/can/now): the
// newest values the CAN index has, footage or not, in the units asked for; a
// read-only token made in the CAN Nerd panel; plain text per stat for a key.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { createCanIndex } = require('../server/canIndex');
const { latestStats, STAT_IDS, stateWords } = require('../server/canNow');

const REPO = path.join(__dirname, '..');
const T0 = Date.UTC(2026, 10, 16, 18, 0, 0);
const line = (ms, id, payload, bus = 'can0') => `(${Math.floor(ms / 1000)}.${String(Math.round((ms % 1000) * 1000)).padStart(6, '0')}) ${bus} ${id}#${payload}`;
const volts = (ms, v) => { const b = Buffer.alloc(8); b.writeUInt16LE(Math.round(v / 0.01), 0); return line(ms, '132', b.toString('hex').toUpperCase()); };

// a fake index: { name: [[ms, value], ...] } and its signals' metadata
const fakeIndex = (series, meta = {}, minutes = [T0]) => ({
  minuteTimes: async () => minutes,
  clipData: async (keys, from, to, names) => ({ series: Object.fromEntries(Object.entries(series).filter(([n]) => names.includes(n))) }),
  signals: async () => meta
});

test('stats: the newest value of each, the first signal with one, in miles or kilometres', async () => {
  const index = fakeIndex({
    DI_vehicleSpeed: [[T0 + 1000, 50], [T0 + 2000, 100]],
    SOCUI292: [[T0 + 2000, 78.4]],
    BattVoltage132: [[T0 + 2000, 380.25]],
    SmoothBattCurrent132: [[T0 + 2000, 20]],
    VCFRONT_tempAmbientFiltered: [[T0 + 2000, 7.8]],
    VCSEC_TPMSPressure0: [[T0 + 2000, 2.9]],
    DI_gear: [[T0 + 2000, 4]],
    BMS_uiChargeStatus: [[T0 + 2000, 7]]
  }, {
    DI_vehicleSpeed: { unit: 'kph' }, BattVoltage132: { unit: 'V' }, SmoothBattCurrent132: { unit: 'A' },
    VCFRONT_tempAmbientFiltered: { unit: 'C' }, VCSEC_TPMSPressure0: { unit: 'bar' },
    DI_gear: { unit: '', factor: 1, values: { 1: 'DI_GEAR_P', 4: 'DI_GEAR_D', 7: 'DI_GEAR_SNA' } },
    BMS_uiChargeStatus: { unit: '', factor: 1, values: { 7: 'BMS_UI_CHARGE_STATUS_SNA' } }
  });
  const mi = await latestStats({ index, key: 'K', units: 'mi', now: T0 + 62_000 });
  const by = Object.fromEntries(mi.stats.map((s) => [s.id, s]));
  assert.equal(mi.at, T0 + 2000);
  assert.equal(mi.ageSec, 60);
  assert.equal(mi.stale, false);
  assert.equal(by.speed.text, '62 mph', 'the newest point, km/h to mph');
  assert.equal(by.battery.text, '78%', 'whole percent');
  assert.equal(by.batteryVoltage.text, '380 V');
  assert.equal(by.batteryPower.text, '7.6 kW', 'worked out from volts and amps');
  assert.equal(by.outsideTemp.text, '46 °F');
  assert.equal(by.tire1.text, '42 psi');
  assert.equal(by.gear.text, 'D', 'a named state in words');
  assert.equal(by.charging, undefined, 'SNA: no value');
  const km = await latestStats({ index, key: 'K', units: 'km', now: T0 + 62_000 });
  const k = Object.fromEntries(km.stats.map((s) => [s.id, s.text]));
  assert.deepEqual([k.speed, k.outsideTemp, k.tire1], ['100 km/h', '7.8 °C', '2.90 bar']);
  assert.equal((await latestStats({ index, key: 'K', now: T0 + 10 * 60_000 })).stale, true, 'older than 5 minutes');
  assert.equal(await latestStats({ index: fakeIndex({}, {}, []), key: 'K' }), null, 'nothing indexed');
  const charge = ['BMS_UI_CHARGE_STATUS_DISCONNECTED', 'BMS_UI_CHARGE_STATUS_CHARGING', 'BMS_UI_CHARGE_STATUS_NOT_CHARGING', 'BMS_UI_CHARGE_STATUS_SNA'];
  assert.deepEqual([stateWords('DI_GEAR_R', ['DI_GEAR_P', 'DI_GEAR_R', 'DI_GEAR_D']), stateWords('CHARGING'), stateWords(charge[1], charge), stateWords(charge[2], charge)], ['R', 'Charging', 'Charging', 'Not charging']);
  assert.ok(STAT_IDS.includes('battery') && STAT_IDS.includes('tire4'));
});

const hasXz = spawnSync('xz', ['--version']).status === 0;
test('from a real CAN index: the newest minute\'s values, whether or not footage is paired', { skip: !hasXz && 'needs xz' }, async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'cannow-'));
  try {
    const name = 'K_20261116T180000Z_1.log.xz';
    await fsp.mkdir(path.join(base, 'can', 'K'), { recursive: true });
    const lines = [];
    for (let i = 0; i < 100; i++) lines.push(volts(T0 + i * 1000, 370 + i * 0.1));
    await fsp.writeFile(path.join(base, 'can', 'K', name), execFileSync('xz', ['-1', '-c'], { input: `${lines.join('\n')}\n` }));
    const index = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx') });
    await index.indexLog('K', name);
    const got = await latestStats({ index, key: 'K', now: T0 + 100_000 });
    assert.equal(got.at, T0 + 99_000);
    assert.equal(got.stats.find((s) => s.id === 'batteryVoltage').value, 380, 'the last frame (379.9 V, shown whole)');
  } finally { await fsp.rm(base, { recursive: true, force: true }); }
});

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

test('GET /api/can/now: off until a link is made in the Nerd panel; only with its token; plain text per stat', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-cannow-'));
  await fsp.mkdir(path.join(dir, 'footage', 'TeslaCam', 'RecentClips'), { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(REPO, 'server', 'index.js')], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC',
      SENTRY_NOREPLACE_RENAME: path.join(REPO, 'build', 'noreplace-rename'), LOG_LEVEL: 'warn', TLS_MODE: 'off', TRUST_PROXY: 'true', UPDATE_CHECK: 'off', REPORTS: 'off'
    },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 100)); }
    let cookie = '';
    const call = async (method, p, body, headers = {}) => {
      const res = await fetch(base + p, { method, headers: { 'X-Forwarded-Proto': 'https', 'X-Requested-With': 'sentry-six-manager', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, type: res.headers.get('content-type') };
    };
    const bare = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };
    assert.equal((await bare('/api/can/now?token=x')).status, 404, 'off: not found');
    assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);
    const made = await call('POST', '/api/can/stream-deck');
    assert.equal(made.status, 200);
    assert.ok(made.data.token.length >= 30);
    assert.ok(made.data.stats.some((s) => s.id === 'battery'));
    const tok = encodeURIComponent(made.data.token);
    assert.equal((await bare('/api/can/now')).status, 401, 'no token');
    assert.equal((await bare('/api/can/now?token=wrong')).status, 401);
    const all = await fetch(`${base}/api/can/now?token=${tok}`).then((r) => r.json());
    assert.deepEqual(all, { car: null, at: null, stale: true, units: 'mi', stats: {} }, 'no CAN data yet');
    assert.equal((await bare(`/api/can/now/battery?token=${tok}`)).text, '—');
    const bearer = await fetch(`${base}/api/can/now/battery`, { headers: { Authorization: `Bearer ${made.data.token}` } });
    assert.equal(bearer.status, 200, 'or as a Bearer header');
    assert.equal((await bare(`/api/can/now/nope?token=${tok}`)).status, 404);
    assert.equal((await call('GET', '/api/can/stream-deck')).data.enabled, true);
    // a new link: the old token stops
    const again = await call('POST', '/api/can/stream-deck');
    assert.equal((await bare(`/api/can/now?token=${tok}`)).status, 401);
    assert.equal((await bare(`/api/can/now?token=${encodeURIComponent(again.data.token)}`)).status, 200);
    assert.equal((await call('DELETE', '/api/can/stream-deck')).data.enabled, false);
    assert.equal((await bare(`/api/can/now?token=${encodeURIComponent(again.data.token)}`)).status, 404, 'off again');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the Stream Deck section is only in the CAN Nerd panel', () => {
  const nerd = fs.readFileSync(path.join(REPO, 'web', 'nerd.js'), 'utf8');
  assert.match(nerd, /\$\{carDataHtml\(\)\}\s*\$\{deckHtml\(\)\}/);
  const walk = (d) => fs.readdirSync(path.join(REPO, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : /\.(js|html)$/.test(e.name) ? [`${d}/${e.name}`] : []));
  for (const f of [...walk('web'), ...walk('examples/ui-packs')]) if (f !== 'web/nerd.js') assert.equal(/stream-deck|api\/can\/now/.test(fs.readFileSync(path.join(REPO, f), 'utf8')), false, f);
});
