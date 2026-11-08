'use strict';

// Settings > Places on the real server: suggestions from where the car's
// Sentry and Saved events were (event.json est_lat / est_lon), a place's
// radius checked and used for the Footage page's "at Home" tag, and a
// watch-only account reading the suggestions.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const HELPER = path.join(__dirname, '..', 'build', 'noreplace-rename');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const HOME = { lat: 41.8781, lon: -87.6298 };
const WORK = { lat: 41.9, lon: -87.7 };
const north = (p, m) => ({ ...p, lat: Math.round((p.lat + m / 111195) * 1e6) / 1e6 });
const stamp = (daysAgo, hh) => {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return `${d.toISOString().slice(0, 10)}_${hh}-30-00`;
};

async function event(root, type, key, info) {
  const dir = path.join(root, 'TeslaCam', type, key);
  await fsp.mkdir(dir, { recursive: true });
  const clip = key.replace(/-30-00$/, '-29-00');
  await fsp.writeFile(path.join(dir, `${clip}-front.mp4`), crypto.randomBytes(2048));
  await fsp.writeFile(path.join(dir, 'event.json'), JSON.stringify({ timestamp: key.replace('_', 'T').replace(/-(\d\d)-(\d\d)$/, ':$1:$2'), reason: 'sentry_aware_object_detection', ...info }));
}

test('places: suggestions where the car parks, radius checked and used for the tag, watch-only reads them', { timeout: 120000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-places-'));
  const root = path.join(dir, 'footage');
  const ll = (p) => ({ est_lat: String(p.lat), est_lon: String(p.lon) });
  await event(root, 'SentryClips', stamp(1, '20'), { ...ll(HOME), city: 'Chicago', street: 'W Madison St' });
  await event(root, 'SentryClips', stamp(2, '21'), { ...ll(north(HOME, 40)), city: 'Chicago', street: 'W Madison St' });
  await event(root, 'SavedClips', stamp(3, '19'), { ...ll(north(HOME, -90)), city: 'Chicago', street: 'W Madison St' });
  await event(root, 'SentryClips', stamp(1, '10'), { ...ll(WORK), city: 'Chicago', street: 'N Elston Ave' });
  await event(root, 'SentryClips', stamp(2, '11'), { ...ll(north(WORK, 80)), city: 'Chicago', street: 'N Elston Ave' });
  // 450 m north of Home, once
  await event(root, 'SentryClips', stamp(4, '12'), { ...ll(north(HOME, 450)), city: 'Chicago' });
  // too old for the suggestions (over 90 days), and one without a position
  await event(root, 'SentryClips', stamp(200, '12'), { ...ll(WORK), city: 'Chicago' });
  await event(root, 'SentryClips', stamp(5, '12'), { city: 'Nowhere' });

  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: root,
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC',
      SENTRY_NOREPLACE_RENAME: HELPER, LOG_LEVEL: 'warn', TLS_MODE: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  const client = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: { 'X-Requested-With': 'sentry-six-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* text */ }
      return { status: res.status, data };
    };
  };
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const admin = client();
    assert.equal((await admin('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);
    for (let i = 0; i < 200; i++) {
      const v = (await admin('GET', '/api/vehicles')).data.vehicles?.[0];
      if (v?.inventory && !v.inventory.scanning && (await admin('GET', '/api/vehicles/daily-driver/recordings')).data.total >= 8) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    // where the car parks most: Home (3 events) then Work (2); the lone spot, the old event and the one without a position are not suggestions
    let s = (await admin('GET', '/api/places/suggestions')).data;
    assert.equal(s.days, 90);
    assert.equal(s.events, 7, 'the old event is past 90 days');
    assert.equal(s.withPosition, 6);
    assert.deepEqual(s.suggestions.map((x) => [x.count, x.street, x.city]), [[3, 'W Madison St', 'Chicago'], [2, 'N Elston Ave', 'Chicago']]);
    assert.ok(s.suggestions[0].last, 'when it was last there');
    assert.deepEqual(s.counts, {});

    // saving one (as the "Save as Home" button does): a radius of 200 m, and its events are not suggested again
    const home = (await admin('POST', '/api/places', { name: 'Home', lat: s.suggestions[0].lat, lon: s.suggestions[0].lon })).data.place;
    assert.equal(home.radius, 200);
    s = (await admin('GET', '/api/places/suggestions')).data;
    assert.deepEqual(s.suggestions.map((x) => x.street), ['N Elston Ave']);
    assert.equal(s.counts[home.id], 3);
    const tags = async () => Object.fromEntries((await admin('GET', '/api/vehicles/daily-driver/recordings')).data.recordings.filter((r) => r.eventId).map((r) => [r.eventId, r.place ?? null]));
    let t = await tags();
    assert.equal(Object.values(t).filter((x) => x === 'Home').length, 3, 'the Footage page tags the three events at Home');
    assert.equal(t[stamp(4, '12')], null, '450 m away is not at Home');

    // the radius: checked, then used
    for (const radius of [20, 49, 2001, 'far', [300]]) {
      assert.equal((await admin('PATCH', `/api/places/${home.id}`, { radius })).status, 400, String(radius));
      assert.equal((await admin('POST', '/api/places', { name: 'X', lat: 1, lon: 1, radius })).status, 400, String(radius));
    }
    assert.equal((await admin('PATCH', `/api/places/${home.id}`, {})).status, 400, 'a name or a radius');
    assert.equal((await admin('PATCH', `/api/places/${home.id}`, { name: '  ' })).status, 400);
    assert.equal((await admin('POST', '/api/places', { name: 'X', lat: '', lon: '' })).status, 400, 'empty coordinates are not 0, 0');
    assert.equal((await admin('POST', '/api/places', { name: 'X', lat: '41.8 N', lon: 1 })).status, 400, 'numbers only: the browser reads what was pasted');
    const wider = (await admin('PATCH', `/api/places/${home.id}`, { radius: 500 })).data.place;
    assert.deepEqual([wider.name, wider.radius], ['Home', 500], 'the radius alone keeps the name');
    t = await tags();
    assert.equal(t[stamp(4, '12')], 'Home', 'within 500 m now');
    assert.equal((await admin('PATCH', `/api/places/${home.id}`, { name: 'House', radius: 50 })).data.place.radius, 50);
    t = await tags();
    assert.equal(Object.values(t).filter((x) => x === 'House').length, 1, 'only the event nearest the middle is within 50 m');
    const work = (await admin('POST', '/api/places', { name: 'Work', lat: 41.9, lon: -87.7, radius: 300 })).data.place;
    assert.deepEqual([work.lat, work.lon, work.radius], [41.9, -87.7, 300]);
    assert.equal((await admin('GET', '/api/places/suggestions')).data.counts[work.id], 2);

    // a watch-only account reads the suggestions like the places (and writes places as before)
    assert.equal((await admin('POST', '/api/accounts', { username: 'kid', password: 'watching only', role: 'viewer' })).status, 200);
    const kid = client();
    assert.equal((await kid('POST', '/api/auth/login', { username: 'kid', password: 'watching only' })).status, 200);
    assert.equal((await kid('GET', '/api/places/suggestions')).status, 200);
    assert.equal((await kid('GET', '/api/places')).data.places.length, 2);
    assert.equal((await kid('PUT', '/api/settings/power', { mode: 'flat' })).status, 403, 'other settings stay for admins');

    assert.equal((await admin('DELETE', `/api/places/${work.id}`)).status, 200);
    assert.equal((await admin('DELETE', `/api/places/${work.id}`)).status, 404);
  } catch (err) {
    console.error(output);
    throw err;
  } finally {
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGTERM');
    });
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
