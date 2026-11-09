'use strict';

// Drives (server/drives.js, GET /api/vehicles/:id/drives, web/drives.js): the
// car's clips grouped into trips as Sentry Studio's Drives tab groups them (a
// gap of more than 5 minutes starts a new drive), Sentry and Saved events left
// out, recording while parked left out where the speed index has read it, the
// start and end named by a saved place or a Sentry event's street, a page at a
// time; readable by watch-only accounts, and a Drives tab in every interface.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const drives = require('../server/drives');
const { statsOf } = require('../server/speedIndex');
const placesLib = require('../server/places');

const REPO = path.join(__dirname, '..');

// a scan's recordings, as the inventory builds them (only what drives.js reads)
const rec = (id, type, keys, extra = {}) => ({
  id, type, day: keys[0].slice(0, 10), eventId: type === 'RecentClips' ? null : extra.eventId || keys[0],
  clipRels: keys.flatMap((k) => [`${type}/${k}-front.mp4`, `${type}/${k}-back.mp4`]), ...extra
});
const minutes = (day, hh, mm, n) => Array.from({ length: n }, (_, i) => {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, hh, mm + i)).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
});
const run = (recs, stats = () => null, opts) => drives.group(drives.clipsOf(recs), stats, opts);
const keysOf = (out) => out.drives.map((d) => [d.clips[0].key, d.clips[d.clips.length - 1].key]);

test('drives: clips back to back are one drive; a gap of more than 5 minutes starts the next, newest first', async () => {
  const recs = [
    rec('a', 'RecentClips', minutes('2026-10-01', 8, 0, 3)), // 08:00-08:03
    rec('b', 'RecentClips', minutes('2026-10-01', 8, 8, 2)), // starts 5 min after the last clip ends: same drive
    rec('c', 'RecentClips', minutes('2026-10-01', 8, 16, 1)), // 6 min after: a new drive
    rec('d', 'RecentClips', minutes('2026-10-01', 23, 58, 4)) // over midnight: one drive
  ];
  const out = await run(recs);
  assert.deepEqual(keysOf(out), [
    ['2026-10-01_23-58-00', '2026-10-02_00-01-00'],
    ['2026-10-01_08-16-00', '2026-10-01_08-16-00'],
    ['2026-10-01_08-00-00', '2026-10-01_08-09-00']
  ]);
  assert.equal(out.more, false);
  // the gap is a setting: 10 minutes joins the first two drives, 2 splits 08:00 from 08:08
  assert.equal((await run(recs, undefined, { gapS: 600 })).drives.length, 2);
  assert.deepEqual(keysOf(await run(recs, undefined, { gapS: 120 })).slice(1), [
    ['2026-10-01_08-16-00', '2026-10-01_08-16-00'], ['2026-10-01_08-08-00', '2026-10-01_08-09-00'], ['2026-10-01_08-00-00', '2026-10-01_08-02-00']
  ]);
  const d = drives.describe(out.drives[2], () => null);
  assert.deepEqual([d.start, d.end, d.seconds, d.clips, d.recordings, d.distance], ['2026-10-01 08:00:00', '2026-10-01 08:10:00', 600, 5, 2, null]);
  assert.deepEqual(d.open, { recording: 'a', day: '2026-10-01', clip: '2026-10-01_08-00-00', second: 0 });
  // a drive over midnight opens in its recording's day
  assert.equal(drives.describe(out.drives[0], () => null).open.day, '2026-10-01');
});

test('drives: Sentry and Saved events are not drives, and do not join two drives', async () => {
  const recs = [
    rec('a', 'RecentClips', minutes('2026-10-01', 8, 0, 2)),
    rec('s', 'SentryClips', minutes('2026-10-01', 8, 4, 10)),
    rec('v', 'SavedClips', minutes('2026-10-01', 8, 1, 1)),
    rec('b', 'RecentClips', minutes('2026-10-01', 8, 14, 2))
  ];
  const out = await run(recs);
  assert.deepEqual(keysOf(out), [['2026-10-01_08-14-00', '2026-10-01_08-15-00'], ['2026-10-01_08-00-00', '2026-10-01_08-01-00']]);
  assert.ok(out.drives.every((d) => d.clips.every((c) => c.rec.type === 'RecentClips')));
  assert.deepEqual((await run([rec('s', 'SentryClips', minutes('2026-10-01', 8, 4, 10))])).drives, []);
});

test('drives: where the speeds are read, standing still is not driving, and a drive is its moving seconds', async () => {
  // 08:00 parked, 08:01 moves from second 20, 08:02-08:03 moving to second 30, 08:04-08:15 parked (Sentry), 08:16 moving
  const speeds = (from, to) => Array.from({ length: 60 }, (_, i) => (i >= from && i <= to ? 10 : 0));
  const by = {
    '08-00': speeds(-1, -1), '08-01': speeds(20, 59), '08-02': speeds(0, 59), '08-03': speeds(0, 30), '08-16': speeds(0, 59)
  };
  for (let m = 4; m < 16; m++) by[`08-${String(m).padStart(2, '0')}`] = speeds(-1, -1);
  const sum = (lat) => ({ g: [[0, lat, -87.6], [55, Math.round((lat + 0.001) * 1e5) / 1e5, -87.6]], b: [3, 5], t: null, v: [1, 10], k: 2 });
  const stats = (c) => { const k = c.key.slice(11, 16); return by[k] ? statsOf(by[k], k === '08-01' ? sum(41.8) : k === '08-03' ? sum(41.9) : null) : null; };
  const out = await run([rec('a', 'RecentClips', minutes('2026-10-01', 8, 0, 17))], stats);
  assert.equal(out.drives.length, 2, 'twelve minutes parked between them');
  const first = drives.describe(out.drives[1], stats);
  assert.deepEqual([first.start, first.end, first.clips, first.moving, first.distance, first.top, first.hardBrakes], ['2026-10-01 08:01:20', '2026-10-01 08:03:31', 3, 40 + 60 + 31, 1310, 10, 2]);
  assert.deepEqual(first.open, { recording: 'a', day: '2026-10-01', clip: '2026-10-01_08-01-00', second: 20 }, 'played from the first second moving');
  assert.deepEqual([first.from.lat, first.to.lat], [41.8, 41.901]);
  // only parked: no drive at all; a clip with no speeds counts as a minute of driving
  assert.deepEqual((await run([rec('p', 'RecentClips', minutes('2026-10-01', 9, 0, 5))], () => statsOf(speeds(-1, -1), null))).drives, []);
  assert.equal(statsOf([null, null], null), null, 'no speed at all is not "standing still"');
});

test('drives: a page at a time, newest first; before goes on from the last drive shown', async () => {
  const recs = Array.from({ length: 7 }, (_, i) => rec(`r${i}`, 'RecentClips', minutes('2026-10-01', 8 + i, 0, 2)));
  const p1 = await run(recs, undefined, { limit: 3 });
  assert.equal(p1.more, true);
  const ids = (p) => p.drives.map((d) => drives.describe(d, () => null).id);
  assert.deepEqual(ids(p1), ['2026-10-01_14-00-00', '2026-10-01_13-00-00', '2026-10-01_12-00-00']);
  const p2 = await run(recs, undefined, { limit: 3, before: ids(p1)[2] });
  assert.deepEqual(ids(p2), ['2026-10-01_11-00-00', '2026-10-01_10-00-00', '2026-10-01_09-00-00']);
  const p3 = await run(recs, undefined, { limit: 3, before: ids(p2)[2] });
  assert.deepEqual([ids(p3), p3.more], [['2026-10-01_08-00-00'], false]);
});

test('drives: start and end named by a saved place, else a Sentry event\'s street and town nearby, else its town', () => {
  const places = [{ id: 'h', name: 'Home', lat: 41.8781, lon: -87.6298, radius: 200 }];
  const spots = [{ lat: 41.9, lon: -87.7, street: 'N Elston Ave', city: 'Chicago' }];
  const label = drives.labeller({ placeOf: (p) => placesLib.placeOf(p, places), spots, metres: placesLib.metres });
  assert.deepEqual(label({ lat: 41.8785, lon: -87.6298 }), { place: 'Home', label: 'Home' });
  assert.deepEqual(label({ lat: 41.9009, lon: -87.7 }), { place: null, label: 'N Elston Ave, Chicago' }, '100 m away');
  assert.deepEqual(label({ lat: 41.91, lon: -87.7 }), { place: null, label: 'Chicago' }, '1.1 km away: the town');
  assert.deepEqual(label({ lat: 42.5, lon: -87.7 }), { place: null, label: null });
});

test('Drives tab: hidden in the built-in interface and every pack (Driving and Map with it), the page kept, opening the Viewer at the drive\'s start', () => {
  const src = fs.readFileSync(path.join(REPO, 'web', 'drives.js'), 'utf8');
  assert.match(src, /import \{ footMinutes \} from '\/web\/duration\.js';/, 'lengths in days, hours and minutes like the rest');
  const index = fs.readFileSync(path.join(REPO, 'web', 'index.html'), 'utf8');
  for (const r of ['drives', 'driving', 'map']) assert.doesNotMatch(index, new RegExp(`data-route="${r}"`), `no ${r} in the built-in navigation`);
  const app = fs.readFileSync(path.join(REPO, 'web', 'app.js'), 'utf8');
  assert.match(app, /pages\.drives = [\s\S]*?createDrivesPage\([\s\S]*?openStudio\('viewer', \{ date: at\.day, at: `\$\{at\.clip\}~\$\{at\.second\}` \}\)/, 'the page is kept');
  assert.match(app, /if \(\/\^#\\\/\?drives\(\\\/\|\\\?\|\$\)\/\.test\(location\.hash\)\) \{[\s\S]*?sentry-show-drives[\s\S]*?history\.replaceState\(null, '', '#\/overview'\)/, 'its address opens the Overview');
  const hidden = fs.readFileSync(path.join(REPO, 'web', 'hiddenTabs.js'), 'utf8');
  assert.match(hidden, /export const HIDDEN_ROUTES = \['drives', 'driving', 'map'\];/);
  const ROOT = path.join(REPO, 'examples', 'ui-packs');
  const shell = {
    aurora: ['aurora/main.js', /\['drives', /, /history\.replaceState\(null, '', '#\/sky'\)/],
    daylight: ['dl/app.js', /group: 'hidden'/, /history\.replaceState\(null, '', '#\/home'\)/],
    flux: ['flux/main.js', /\{ id: 'drives', label: 'Drives', icon: 'route', key/, /history\.replaceState\(null, '', '#\/overview'\)/],
    horizon: ['hz/main.js', /\{ id: 'drives', label: 'Drives', icon: 'route' \},\n/, /history\.replaceState\(null, '', '#\/dashboard'\)/]
  };
  for (const [pack, [file, navRe, homeRe]] of Object.entries(shell)) {
    const main = fs.readFileSync(path.join(ROOT, pack, 'web', file), 'utf8');
    if (pack === 'daylight') assert.match(main, navRe, 'daylight: in no navigation group');
    else assert.doesNotMatch(main, navRe, `${pack}: not in the navigation`);
    assert.doesNotMatch(main, /\['driving', |\{ id: 'driving'|\['map', |\{ id: 'map'|^\s+(driving|map): \{ label/m, `${pack}: no Driving or Map either`);
    assert.match(main, /import \{ hiddenRoute \} from '\/web\/hiddenTabs\.js';/, `${pack}: hides it`);
    assert.match(main, homeRe, `${pack}: its address opens the home page`);
    if (pack === 'daylight') assert.doesNotMatch(main, /MORE_ROUTES = \[[^\]]*'drives'/, 'not in More');
    const dir = path.dirname(path.join(ROOT, pack, 'web', file));
    const page = fs.readFileSync(path.join(dir, 'pages', 'drives.js'), 'utf8');
    assert.match(page, /import \{ createDrivesPage \} from '\/web\/drives\.js';/, `${pack} keeps the shared page`);
    assert.match(page, /DRIVES_TABS = \[\['trips', 'Drives', trips\], \['driving', 'Driving', driving\], \['map', 'Map', map\]\]/, `${pack}: Drives | Driving | Map`);
    assert.match(page, /#\/viewer[^`]*at=\$\{encodeURIComponent\(`\$\{at\.clip\}~\$\{at\.second\}`\)\}|at=\$\{enc\(`\$\{at\.clip\}~\$\{at\.second\}`\)\}/, `${pack} opens the Viewer at the start`);
    assert.match(page, /h24: \(\) => clockPref\.h24/, `${pack} follows its 24-hour clock`);
  }
});

test('Drives hidden: Sentry USB\'s drive-data.json is read only when the drives API asks, never in the background', () => {
  const src = fs.readFileSync(path.join(REPO, 'server', 'index.js'), 'utf8');
  assert.doesNotMatch(src, /driveData\.start\(\)/);
  assert.match(src, /r\.add\('GET', '\/api\/vehicles\/:id\/drives'[\s\S]*?driveData\.check\(v\.id\)/);
});

test('sub-tabs (web/subTabs.js): the one asked for, else the last one used here, else the first; remembered', async () => {
  const src = fs.readFileSync(path.join(REPO, 'web', 'subTabs.js'), 'utf8');
  const store = new Map();
  global.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  try {
    const m = await import(`data:text/javascript,${encodeURIComponent(src)}`);
    assert.equal(m.pickSubTab('k', ['a', 'b', 'c'], undefined), 'a');
    assert.equal(m.pickSubTab('k', ['a', 'b', 'c'], 'c'), 'c');
    assert.equal(m.pickSubTab('k', ['a', 'b', 'c'], ''), 'c', 'remembered');
    assert.equal(m.pickSubTab('k', ['a', 'b', 'c'], 'nope'), 'c');
    global.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    assert.equal(m.pickSubTab('k', ['a', 'b'], undefined), 'a', 'storage blocked: the first');
    const html = m.subTabsHtml([['a', 'One'], ['b', 'Two']], 'b', { href: (k) => `#/p/${k}`, cls: 'seg' });
    assert.match(html, /<nav class="sentry-subtabs seg" aria-label="Sections"><a class="" href="#\/p\/a" data-subtab="a">One<\/a><a class=" on" href="#\/p\/b" data-subtab="b" aria-current="page">Two<\/a><\/nav>/);
  } finally {
    delete global.localStorage;
  }
});

test('duration: a drive\'s length in days, hours and minutes', async () => {
  const src = fs.readFileSync(path.join(REPO, 'web', 'duration.js'), 'utf8');
  const dur = await import(`data:text/javascript,${encodeURIComponent(src)}`);
  // web/drives.js's driveLength: footMinutes of the seconds, "under 1 min" below a minute
  const driveLength = (s) => (s > 0 && s < 60 ? 'under 1 min' : dur.footMinutes(s / 60));
  assert.equal(driveLength(85 * 60), '1 h 25 min');
  assert.equal(driveLength(86400), '1 day');
  assert.equal(driveLength(20), 'under 1 min');
  assert.match(fs.readFileSync(path.join(REPO, 'web', 'drives.js'), 'utf8'), /export const driveLength = \(s\) => \(s > 0 && s < 60 \? 'under 1 min' : footMinutes\(s \/ 60\)\);/);
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('drives API: grouped from the scan and the speed index, places named, events left out, watch-only reads', { timeout: 120000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-drives-'));
  const root = path.join(dir, 'footage');
  const recent = path.join(root, 'TeslaCam', 'RecentClips');
  await fsp.mkdir(recent, { recursive: true });
  const DAY = '2026-10-05';
  const HOME = { lat: 41.8781, lon: -87.6298 };
  // a morning drive 08:00-08:02 from Home, a Sentry recording at 12:00 while parked, an evening drive 18:00-18:01
  const speeds = {};
  const moving = Array.from({ length: 60 }, () => 12);
  const parked = Array.from({ length: 60 }, () => 0);
  const clip = async (key, sp, g) => {
    for (const cam of ['front', 'back']) await fsp.writeFile(path.join(recent, `${key}-${cam}.mp4`), crypto.randomBytes(2048));
    const st = await fsp.stat(path.join(recent, `${key}-front.mp4`));
    speeds[`TeslaCam/RecentClips/${key}-front.mp4`] = [st.size, Math.round(st.mtimeMs), sp, { b: null, t: null, v: [0, Math.max(...sp)], g, k: 2 }];
  };
  await clip(`${DAY}_08-00-00`, moving, [[0, HOME.lat, HOME.lon]]);
  await clip(`${DAY}_08-01-00`, moving, [[0, 41.89, -87.65]]);
  await clip(`${DAY}_08-02-00`, moving, [[55, 41.9, -87.7]]);
  for (const k of ['12-00-00', '12-01-00', '12-02-00']) await clip(`${DAY}_${k}`, parked, [[0, 41.9, -87.7]]);
  await clip(`${DAY}_18-00-00`, moving, []);
  await clip(`${DAY}_18-01-00`, moving, []);
  // a Sentry event near where the morning drive ended (its street names the end), and a Saved one in the evening
  const ev = path.join(root, 'TeslaCam', 'SentryClips', `${DAY}_12-30-00`);
  await fsp.mkdir(ev, { recursive: true });
  await fsp.writeFile(path.join(ev, `${DAY}_12-29-00-front.mp4`), crypto.randomBytes(2048));
  await fsp.writeFile(path.join(ev, 'event.json'), JSON.stringify({ timestamp: `${DAY}T12:30:00`, city: 'Chicago', street: 'N Elston Ave', est_lat: '41.9005', est_lon: '-87.7', reason: 'sentry_aware_object_detection' }));
  const saved = path.join(root, 'TeslaCam', 'SavedClips', `${DAY}_20-00-00`);
  await fsp.mkdir(saved, { recursive: true });
  await fsp.writeFile(path.join(saved, `${DAY}_19-59-00-front.mp4`), crypto.randomBytes(2048));
  const data = path.join(dir, 'data');
  await fsp.mkdir(path.join(data, 'speeds', 'daily-driver'), { recursive: true });
  await fsp.writeFile(path.join(data, 'speeds', 'daily-driver', `${DAY}.json`), JSON.stringify(speeds));

  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(REPO, 'server', 'index.js')], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: data, FOOTAGE_PATH: root,
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC',
      SENTRY_NOREPLACE_RENAME: path.join(REPO, 'build', 'noreplace-rename'), LOG_LEVEL: 'warn', TLS_MODE: 'off', UPDATE_CHECK: 'off'
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
      let out = text;
      try { out = JSON.parse(text); } catch { /* text */ }
      return { status: res.status, data: out };
    };
  };
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal((await client()('GET', '/api/vehicles/daily-driver/drives')).status, 401, 'signed in only');
    const admin = client();
    assert.equal((await admin('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);
    for (let i = 0; i < 200; i++) {
      if ((await admin('GET', '/api/vehicles/daily-driver/recordings')).data.total >= 4) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal((await admin('POST', '/api/places', { name: 'Home', ...HOME })).status, 200);

    const res = await admin('GET', '/api/vehicles/daily-driver/drives');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const list = res.data.drives;
    assert.deepEqual(list.map((d) => [d.start, d.end, d.seconds, d.clips]), [
      [`${DAY} 18:00:00`, `${DAY} 18:02:00`, 120, 2],
      [`${DAY} 08:00:00`, `${DAY} 08:03:00`, 180, 3]
    ], 'the parked Sentry recording at noon is no drive; the Sentry and Saved events neither');
    const [evening, morning] = list;
    assert.equal(morning.distance, 12 * 180);
    assert.equal(morning.moving, 180);
    assert.equal(morning.top, 12);
    assert.deepEqual([morning.from.label, morning.from.place, morning.to.label], ['Home', 'Home', 'N Elston Ave, Chicago']);
    assert.deepEqual([evening.from, evening.to], [null, null], 'no GPS');
    assert.equal(morning.can, false);
    assert.equal(morning.open.clip, `${DAY}_08-00-00`);
    assert.equal(morning.open.second, 0);
    assert.equal(morning.open.day, DAY);
    assert.ok(morning.open.recording);
    assert.equal(res.data.more, false);

    // a page of one, then the next; the gap; bad input
    const one = (await admin('GET', '/api/vehicles/daily-driver/drives?limit=1')).data;
    assert.deepEqual([one.drives.length, one.more, one.next], [1, true, `${DAY}_18-00-00`]);
    const two = (await admin('GET', `/api/vehicles/daily-driver/drives?limit=1&before=${one.next}`)).data;
    assert.deepEqual([two.drives[0].id, two.more], [`${DAY}_08-00-00`, false]);
    assert.equal((await admin('GET', '/api/vehicles/daily-driver/drives?gap=120')).data.drives.length, 2, 'parked time is not a gap that joins: it is not driving');
    for (const q of ['gap=0', 'gap=500', 'gap=x', 'before=yesterday']) assert.equal((await admin('GET', `/api/vehicles/daily-driver/drives?${q}`)).status, 400, q);
    assert.equal((await admin('GET', '/api/vehicles/nope/drives')).status, 404);

    // a watch-only account reads the drives
    assert.equal((await admin('POST', '/api/accounts', { username: 'kid', password: 'watching only', role: 'viewer' })).status, 200);
    const kid = client();
    assert.equal((await kid('POST', '/api/auth/login', { username: 'kid', password: 'watching only' })).status, 200);
    const seen = await kid('GET', '/api/vehicles/daily-driver/drives');
    assert.equal(seen.status, 200);
    assert.equal(seen.data.drives.length, 2);
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
