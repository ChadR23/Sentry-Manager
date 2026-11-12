'use strict';

// The real server, started as a child process against a temporary
// TeslaCam tree, exercised over HTTP like the browser does.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'server', 'index.js');
const SUPERVISOR = path.join(REPO, 'server', 'supervisor.js');
const HELPER = path.join(__dirname, '..', 'build', 'noreplace-rename');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function writeClip(file, real) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (real && hasFfmpeg) {
    const { createTeslaH264Fixture } = require(path.join(REPO, 'test/fixtures/ffmpegFixtures'));
    await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: file, durationSeconds: 2, frameRate: 12, size: '320x240', spatialNoise: 4,
      telemetryPattern: Array.from({ length: 24 }, (_, i) => Buffer.from([0x20, i])) });
  } else {
    await fsp.writeFile(file, crypto.randomBytes(2048));
  }
}

async function makeFootage(root) {
  const T = path.join(root, 'TeslaCam');
  await writeClip(path.join(T, 'RecentClips/2020-01-01_08-00-00-front.mp4'), true);
  await writeClip(path.join(T, 'RecentClips/2020-01-01_08-00-00-back.mp4'));
  await writeClip(path.join(T, 'RecentClips/2020-01-01_08-01-00-front.mp4'));
  await writeClip(path.join(T, 'RecentClips/2020-01-01_09-30-00-front.mp4'));
  await writeClip(path.join(T, 'SentryClips/2020-01-02_12-30-00/2020-01-02_12-29-00-front.mp4'));
  await fsp.writeFile(path.join(T, 'SentryClips/2020-01-02_12-30-00/event.json'), JSON.stringify({ city: 'Austin', reason: 'sentry_aware_object_detection' }));
  await writeClip(path.join(T, 'SavedClips/2020-01-03_10-00-00/2020-01-03_09-59-00-front.mp4'));
  await fsp.writeFile(path.join(T, 'SentryClips/2020-01-02_12-30-00/thumb.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64'));
  await fsp.writeFile(path.join(root, 'notes.txt'), 'not footage');
}

async function startServer(dir, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC',
      SENTRY_NOREPLACE_RENAME: HELPER, LOG_LEVEL: 'warn', TLS_MODE: 'off', ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  let cookie = '';
  const call = async (method, p, body, { raw = false, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'X-Requested-With': 'sentry-six-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual'
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return res;
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data };
  };
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', (code) => resolve(code));
    child.kill('SIGTERM');
  });
  return { base, call, child, stop, output: () => output, setCookie: (c) => { cookie = c; }, getCookie: () => cookie };
}

async function tmp() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sm-server-'));
}

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
}

test('sign-in, CSRF header and throttling', async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const s = await startServer(dir);
  try {
    assert.equal((await s.call('GET', '/api/vehicles')).status, 401);
    const page = await s.call('GET', '/', undefined, { raw: true });
    assert.equal(page.status, 302);
    assert.match(page.headers.get('location'), /^\/login/);
    assert.equal((await s.call('GET', '/login', undefined, { raw: true })).status, 200);
    assert.equal((await s.call('POST', '/api/auth/setup', { username: 'x', password: 'whatever123' })).status, 409, 'account came from UI_PASSWORD');
    for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/api/auth/login', { username: 'admin', password: 'nope' })).status, 401);
    assert.equal((await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 429, 'throttled after repeated failures');
  } finally {
    await s.stop();
  }
  const s2 = await startServer(dir);
  try {
    assert.equal((await s2.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);
    assert.equal((await s2.call('GET', '/api/vehicles')).status, 200);
    const noHeader = await s2.call('POST', '/api/vehicles/daily-driver/scan', {}, { headers: { 'X-Requested-With': 'x' } });
    assert.equal(noHeader.status, 403, 'mutations need the X-Requested-With header');
    const crossSite = await s2.call('POST', '/api/vehicles/daily-driver/scan', {}, { headers: { Origin: 'http://evil.example' } });
    assert.equal(crossSite.status, 403, 'mutations from another site are refused');
    // a stray cookie with bad %-encoding must not break the session
    const stray = await s2.call('GET', '/api/vehicles', undefined, { headers: { Cookie: `other=100%; ${s2.getCookie()}` } });
    assert.equal(stray.status, 200);
    // static files: one decoded path decides; encoded tricks never reach a file
    s2.setCookie('');
    for (const u of ['/web/login%2F..%2Fapp.js', '/web/fonts/..%2Findex.html', '/web/login%2F..%2FelectronApiShim.js']) {
      assert.equal((await s2.call('GET', u, undefined, { raw: true })).status, 400, u);
    }
    assert.equal((await s2.call('GET', '/web/app.js', undefined, { raw: true })).status, 302, 'the app needs sign-in');
    assert.equal((await s2.call('GET', '/web/login.js', undefined, { raw: true })).status, 200, 'the sign-in script does not');
    const headers = (await s2.call('GET', '/login', undefined, { raw: true })).headers;
    assert.match(headers.get('content-security-policy'), /script-src 'self'(;|$)/);
    assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN');
    await s2.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    assert.equal((await s2.call('POST', '/api/auth/logout', {})).status, 200);
    assert.equal((await s2.call('GET', '/api/vehicles')).status, 401);
  } finally {
    await s2.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('footage, protect, Recycle Bin and policies never lose files', { timeout: 120000 }, async () => {
  const dir = await tmp();
  const root = path.join(dir, 'footage');
  await makeFootage(root);
  const before = Object.fromEntries(['RecentClips/2020-01-01_08-00-00-front.mp4', 'SentryClips/2020-01-02_12-30-00/event.json'].map((r) => [r, sha(path.join(root, 'TeslaCam', r))]));
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const { data: { vehicles } } = await s.call('GET', '/api/vehicles');
    assert.equal(vehicles.length, 1);
    assert.equal(vehicles[0].studioRoot, path.join(root, 'TeslaCam'), 'Studio opens the TeslaCam folder');
    const list = await waitFor(async () => {
      const r = await s.call('GET', '/api/vehicles/daily-driver/recordings');
      return r.data.total ? r.data : null;
    });
    const by = Object.fromEntries(list.recordings.map((r) => [`${r.category} ${r.start}`, r]));
    assert.deepEqual(Object.keys(by).sort(), ['Recent 2020-01-01 08:00:00', 'Recent 2020-01-01 09:30:00', 'Saved 2020-01-03 09:59:00', 'Sentry 2020-01-02 12:29:00']);
    assert.equal(by['Recent 2020-01-01 08:00:00'].fileCount, 3, 'one drive = consecutive minutes');
    assert.equal(by['Sentry 2020-01-02 12:29:00'].eventAt, '2020-01-02 12:30:00');
    const detail = await s.call('GET', `/api/vehicles/daily-driver/recordings/${by['Sentry 2020-01-02 12:29:00'].id}`);
    assert.equal(detail.data.event.city, 'Austin');

    // footage by day: newest first, what each day holds, the day's thumbnail
    // (its first event, else its first drive), codecs read from the clips
    const daysOf = async () => (await s.call('GET', '/api/vehicles/daily-driver/days')).data;
    const days = await waitFor(async () => {
      const d = await daysOf();
      return d.days.length === 3 && d.days.every((x) => x.unknown === 0) ? d : null;
    });
    assert.deepEqual(days.days.map((d) => d.day), ['2020-01-03', '2020-01-02', '2020-01-01']);
    // Inclusive bounds, invalid values, and the legacy exact-date precedence.
    const ranged = (await s.call('GET', '/api/vehicles/daily-driver/days?from=2020-01-02&to=2020-01-02')).data;
    assert.deepEqual(ranged.days.map(d => d.day), ['2020-01-02']);
    assert.equal((await s.call('GET', '/api/vehicles/daily-driver/days?from=2020-01-01&to=2020-01-03')).data.total, days.total);
    assert.equal((await s.call('GET', '/api/vehicles/daily-driver/days?from=nonsense')).data.total, days.total);
    assert.deepEqual((await s.call('GET', '/api/vehicles/daily-driver/days?to=2020-01-01')).data.days.map(d => d.day), ['2020-01-01']);
    assert.deepEqual((await s.call('GET', '/api/vehicles/daily-driver/days?date=2020-01-01&from=2020-01-03')).data.days.map(d => d.day), ['2020-01-01']);
    const recs = (await s.call('GET', '/api/vehicles/daily-driver/recordings?from=2020-01-02&to=2020-01-02')).data.recordings;
    assert.ok(recs.length && recs.every(r => r.day === '2020-01-02'));
    const jan1 = days.days[2];
    assert.deepEqual([jan1.recordings, jan1.byCategory, jan1.minutes, jan1.encodedRecordings], [2, { Recent: 2 }, 3, 0]);
    assert.equal(jan1.thumbId, by['Recent 2020-01-01 08:00:00'].id);
    assert.equal(days.days[1].thumbId, by['Sentry 2020-01-02 12:29:00'].id);
    // the recording's file list says each clip's codec (non-clips carry none),
    // so the page can show which clips still need converting
    const filesOf = (await s.call('GET', `/api/vehicles/daily-driver/recordings/${by['Recent 2020-01-01 08:00:00'].id}`)).data.files;
    for (const f of filesOf) {
      if (/\.mp4$/i.test(f.rel)) assert.ok('codec' in f && (f.codec === null || typeof f.codec === 'string'), f.rel);
      else assert.equal('codec' in f, false, f.rel);
    }
    if (hasFfmpeg && /libx265/.test(execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString())) {
      // a clip converted to H.265 shows as encoded once the share is scanned again
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '1', '-c:v', 'libx265', '-x265-params', 'log-level=error',
        '-pix_fmt', 'yuv420p', '-f', 'mp4', path.join(root, 'TeslaCam/RecentClips/2020-01-01_09-30-00-front.mp4')]);
      await s.call('POST', '/api/vehicles/daily-driver/scan', {});
      const enc = await waitFor(async () => {
        const d = (await daysOf()).days.find((x) => x.day === '2020-01-01');
        return d && d.encodedRecordings === 1 && d.unknown === 0 ? d : null;
      });
      assert.deepEqual([enc.encodedRecordings, enc.codecs], [1, ['h265']]);
      const drive = (await s.call('GET', '/api/vehicles/daily-driver/recordings?date=2020-01-01')).data.recordings.find((x) => x.start === '2020-01-01 09:30:00');
      assert.deepEqual(drive.encoded, { clips: 1, encoded: 1, unknown: 0, codecs: ['h265'] });
    }
    // "Delete through this date": counted first, protected recordings stay
    await s.call('POST', '/api/vehicles/daily-driver/protect', { ids: [by['Recent 2020-01-01 09:30:00'].id], protected: true });
    const preview = await s.call('POST', '/api/vehicles/daily-driver/trash-days', { day: '2020-01-02', through: true, preview: true });
    assert.deepEqual([preview.data.recordings, preview.data.protected, preview.data.days, preview.data.started], [2, 1, 2, false]);
    await s.call('POST', '/api/vehicles/daily-driver/protect', { ids: [by['Recent 2020-01-01 09:30:00'].id], protected: false });
    assert.equal((await s.call('POST', '/api/vehicles/daily-driver/trash-days', { day: 'yesterday' })).status, 400);

    if (hasFfmpeg) {
      const thumb = await s.call('GET', `/api/vehicles/daily-driver/recordings/${by['Recent 2020-01-01 08:00:00'].id}/thumbnail`, undefined, { raw: true });
      assert.equal(thumb.status, 200);
      assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
    }

    // media: ranges, and nothing outside the shares
    const clip = path.join(root, 'TeslaCam/RecentClips/2020-01-01_08-00-00-back.mp4');
    const part = await s.call('GET', `/api/media?path=${encodeURIComponent(clip)}`, undefined, { raw: true, headers: { Range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 10);
    // an open-ended range (what a video asks for) is answered in parts of at most 1 MiB
    const big = path.join(root, 'TeslaCam/RecentClips/2020-01-01_08-02-00-front.mp4');
    await fsp.writeFile(big, crypto.randomBytes(5 * 1024 * 1024));
    const head = await s.call('GET', `/api/media?path=${encodeURIComponent(big)}`, undefined, { raw: true, headers: { Range: 'bytes=0-' } });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-range'), `bytes 0-${1024 * 1024 - 1}/${5 * 1024 * 1024}`);
    assert.equal((await head.arrayBuffer()).byteLength, 1024 * 1024);
    const tail = await s.call('GET', `/api/media?path=${encodeURIComponent(big)}`, undefined, { raw: true, headers: { Range: `bytes=${4 * 1024 * 1024}-` } });
    assert.equal(tail.headers.get('content-range'), `bytes ${4 * 1024 * 1024}-${5 * 1024 * 1024 - 1}/${5 * 1024 * 1024}`);
    assert.equal((await tail.arrayBuffer()).byteLength, 1024 * 1024);
    assert.equal((await s.call('GET', `/api/media?path=${encodeURIComponent('/etc/passwd')}`, undefined, { raw: true })).status, 403);
    assert.equal((await s.call('POST', '/api/studio/readDir', { path: '/etc' })).status, 403);
    // scrub previews: a JPEG grid per clip, only inside the shares, only signed in
    if (hasFfmpeg) {
      const real = path.join(root, 'TeslaCam/RecentClips/2020-01-01_08-00-00-front.mp4');
      const g = await s.call('GET', `/api/scrub?path=${encodeURIComponent(real)}`, undefined, { raw: true });
      assert.equal(g.status, 200);
      assert.equal(g.headers.get('content-type'), 'image/jpeg');
      assert.ok((await g.arrayBuffer()).byteLength > 1000);
    }
    assert.equal((await s.call('GET', `/api/scrub?path=${encodeURIComponent(clip)}`, undefined, { raw: true })).status, 404, 'not a video: no previews');
    assert.equal((await s.call('GET', `/api/scrub?path=${encodeURIComponent('/etc/passwd')}`, undefined, { raw: true })).status, 403);
    const anon = await fetch(`${s.base}/api/scrub?path=${encodeURIComponent(clip)}`);
    assert.equal(anon.status, 401);

    // protected recordings are never trashed
    const sentry = by['Sentry 2020-01-02 12:29:00'];
    await s.call('POST', '/api/vehicles/daily-driver/protect', { ids: [sentry.id], protected: true });
    let r = await s.call('POST', '/api/vehicles/daily-driver/trash', { ids: [sentry.id] });
    assert.deepEqual(r.data.moved, []);
    assert.equal(r.data.skipped[0].reason, 'protected');
    await s.call('POST', '/api/vehicles/daily-driver/protect', { ids: [sentry.id], protected: false });

    // trash -> files move inside the share, nothing deleted, hidden from the viewer
    r = await s.call('POST', '/api/vehicles/daily-driver/trash', { ids: [sentry.id, by['Recent 2020-01-01 08:00:00'].id] });
    assert.equal(r.data.moved.length, 2);
    assert.equal(fs.existsSync(path.join(root, 'TeslaCam/SentryClips/2020-01-02_12-30-00')), false, 'empty event folder removed');
    assert.ok(fs.existsSync(path.join(root, 'TeslaCam/SentryClips')), 'clip folders kept');
    const binFiles = execFileSync('find', [path.join(root, '.sentry-recycle-bin'), '-type', 'f']).toString().trim().split('\n');
    assert.equal(binFiles.length, 6);
    assert.ok(binFiles.every((f) => f.endsWith('.binned')), 'binned files are invisible to the converter');
    const rootListing = await s.call('POST', '/api/studio/readDir', { path: root });
    assert.ok(!rootListing.data.some((e) => e.name === '.sentry-recycle-bin'), 'viewer never sees the bin');
    const { data: { items } } = await s.call('GET', '/api/bin?vehicle=daily-driver');
    assert.equal(items.length, 2);
    const withThumb = items.find(i => i.category === 'Sentry');
    const thumbnail = await s.call('GET', '/api/bin/' + withThumb.id + '/thumbnail', undefined, { raw: true });
    assert.equal(thumbnail.status, 200);
    assert.equal(thumbnail.headers.get('content-type'), 'image/png');
    assert.ok((await thumbnail.arrayBuffer()).byteLength > 0);
    assert.equal((await s.call('GET', '/api/bin/does-not-exist/thumbnail', undefined, { raw: true })).status, 404);
    if (hasFfmpeg) {
      const drive = items.find(i => i.category === 'Recent');
      const frame = await s.call('GET', '/api/bin/' + drive.id + '/thumbnail', undefined, { raw: true });
      assert.equal(frame.status, 200, 'ffmpeg reads the .binned front clip');
      assert.equal(frame.headers.get('content-type'), 'image/jpeg');
    }

    // restore -> byte-identical
    for (const item of items) assert.equal((await s.call('POST', `/api/bin/${item.id}/restore`, {})).status, 200);
    for (const [rel, h] of Object.entries(before)) assert.equal(sha(path.join(root, 'TeslaCam', rel)), h, `${rel} restored unchanged`);
    assert.equal((await s.call('GET', '/api/bin')).data.items.length, 0);

    // policies only move to the bin, and skip protected
    const allBack = async () => waitFor(async () => ((await s.call('GET', '/api/vehicles/daily-driver/recordings')).data.total === 4 ? true : null));
    assert.ok(await allBack());

    // "Delete this day" moves that day to the bin (as a job); restore it again
    r = await s.call('POST', '/api/vehicles/daily-driver/trash-days', { day: '2020-01-02' });
    assert.deepEqual([r.data.recordings, r.data.started], [1, true]);
    const dayItem = await waitFor(async () => (await s.call('GET', '/api/bin')).data.items[0] || null);
    assert.equal(dayItem.category, 'Sentry');
    assert.equal((await s.call('POST', `/api/bin/${dayItem.id}/restore`, {})).status, 200);
    assert.ok(await allBack());
    const saved = (await s.call('GET', '/api/vehicles/daily-driver/recordings?category=Saved')).data.recordings[0];
    await s.call('POST', '/api/vehicles/daily-driver/protect', { ids: [saved.id], protected: true });
    const pol = await s.call('PUT', '/api/vehicles/daily-driver/policy', { enabled: false, keepDays: { Recent: 30, Sentry: 30, Saved: 30 } });
    assert.equal(pol.data.preview.recordings, 3, 'everything from 2020 except the protected one');
    assert.equal((await s.call('PUT', '/api/vehicles/daily-driver/policy', { keepDays: { Recent: 0 } })).status, 400);
    r = await s.call('POST', '/api/vehicles/daily-driver/policy/run', {});
    assert.equal(r.data.moved.length, 3);
    assert.ok(fs.existsSync(path.join(root, 'TeslaCam/SavedClips/2020-01-03_10-00-00/2020-01-03_09-59-00-front.mp4')), 'protected kept');
    const binned = (await s.call('GET', '/api/bin')).data.items;
    assert.equal(binned.length, 3);
    assert.ok(binned.every((i) => i.reason === 'policy'));

    // permanent deletion only with explicit confirmation
    assert.equal((await s.call('POST', `/api/bin/${binned[0].id}/delete`, {})).status, 400);
    assert.equal((await s.call('POST', '/api/bin/empty', {})).status, 400);
    assert.equal((await s.call('POST', `/api/bin/${binned[0].id}/delete`, { confirm: true })).status, 200);
    const emptied = await s.call('POST', '/api/bin/empty', { confirm: true, vehicle: 'daily-driver' });
    assert.equal(emptied.data.deleted, 2);
    assert.ok(fs.existsSync(path.join(root, 'notes.txt')), 'non-footage files are never touched');
    const jobs = (await s.call('GET', '/api/jobs')).data.jobs.map((j) => j.type);
    for (const t of ['trash', 'restore', 'policy', 'empty-bin']) assert.ok(jobs.includes(t), `job recorded: ${t}`);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Studio is served with the web shim; converter bridge enforces Quick and allowed paths', { timeout: 120000 }, async () => {
  const dir = await tmp();
  const root = path.join(dir, 'footage');
  await makeFootage(root);
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const studioRes = await s.call('GET', '/studio/index.html', undefined, { raw: true });
    assert.match(studioRes.headers.get('content-security-policy'), /script-src 'self' 'unsafe-eval'/, 'Studio needs eval for its protobuf decoder');
    assert.match(studioRes.headers.get('content-security-policy'), /connect-src 'self' https:\/\/tiles\.openfreemap\.org https:\/\/\*\.google\.com;/, 'its map fetches OpenFreeMap and Google Satellite');
    const shellCsp = (await s.call('GET', '/', undefined, { raw: true })).headers.get('content-security-policy');
    assert.doesNotMatch(shellCsp, /unsafe-eval/, 'the shell does not');
    assert.match(shellCsp, /connect-src 'self' https:\/\/tiles\.openfreemap\.org https:\/\/\*\.google\.com;/, 'an interface pack draws the map in the main page');
    assert.doesNotMatch((await s.call('GET', '/login', undefined, { raw: true })).headers.get('content-security-policy'), /openfreemap/, 'the sign-in page has no map');
    const html = await studioRes.text();
    assert.match(html, /webFlag\.js[\s\S]*electronApiShim\.js/);
    assert.ok(!/<script>/.test(html.split('</head>')[0].split('<head>')[1].split('<title>')[0]), 'nothing inline is injected');
    assert.equal((await s.call('GET', '/shared/mapProviders.js', undefined, { raw: true })).status, 200);
    assert.equal((await s.call('GET', '/assets/pedal_brake.png', undefined, { raw: true })).headers.get('content-type'), 'image/png');
    // a versioned Studio page's ../../assets/… lands on /v/assets/…: the same images
    const pedal = await s.call('GET', '/v/assets/pedal_acc.png', undefined, { raw: true });
    assert.equal(pedal.status, 200, 'the accelerator icon of the built-in Viewer');
    assert.equal(pedal.headers.get('content-type'), 'image/png');
    assert.ok([400, 404].includes((await s.call('GET', '/v/assets/..%2F..%2Fserver/index.js', undefined, { raw: true })).status), 'still only the assets folder');
    assert.ok([400, 404].includes((await s.call('GET', '/studio/..%2F..%2Fserver/index.js', undefined, { raw: true })).status));

    await waitFor(async () => (await s.call('POST', '/api/converter/invoke/getCapabilities')).data.ok);
    const outside = await s.call('POST', '/api/converter/invoke/start', {
      sourceRoot: '/etc', destinationRoot: null, outputMode: 'replace', replacementConfirmed: true, codec: 'h265', profileId: 'balanced',
      networkMode: 'direct', includedGroups: ['RecentClips'], verifyMode: 'off'
    });
    assert.deepEqual(outside.data, { ok: false, error: { code: 'PATH_NOT_ALLOWED' } });

    const started = await s.call('POST', '/api/converter/invoke/start', {
      sourceRoot: path.join(root, 'TeslaCam'), destinationRoot: path.join(dir, 'data', 'converted'), outputMode: 'separate', replacementConfirmed: false,
      codec: 'h265', profileId: 'balanced', networkMode: 'direct', includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'], verifyMode: 'off'
    }, { headers: { 'X-Client-Id': 'test-client' } });
    assert.equal(started.data.ok, true, JSON.stringify(started.data));
    const cur = await s.call('POST', '/api/converter/invoke/getCurrent');
    assert.equal(cur.data.value.config.verifyMode, 'quick', 'Off is never used for a real conversion');
    await waitFor(async () => {
      const c = await s.call('POST', '/api/converter/invoke/getCurrent');
      return ['completed', 'failed', 'cancelled'].includes(c.data.value?.state);
    }, 120000);
    const jobs = (await s.call('GET', '/api/jobs')).data.jobs;
    assert.ok(jobs.some((j) => j.type === 'conversion' && j.status !== 'running'), 'conversion mirrored into Jobs');

    // Clear jobs takes the finished conversion off the list and touches
    // nothing of the converter's: its job files stay as they were
    const converterFiles = () => {
      const out = {};
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else out[path.relative(dir, p)] = sha(p);
        }
      };
      walk(path.join(dir, 'data', 'converter'));
      return out;
    };
    const filesBefore = converterFiles();
    assert.ok(Object.keys(filesBefore).length > 0, 'the converter keeps its job on disk');
    const cleared = await s.call('POST', '/api/jobs/clear', { vehicle: 'daily-driver', confirm: true });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
    assert.ok(cleared.data.cleared >= 1);
    assert.ok(!(await s.call('GET', '/api/jobs?vehicle=daily-driver')).data.jobs.some((j) => j.type === 'conversion'), 'the conversion left the list');
    assert.deepEqual(converterFiles(), filesBefore, 'the converter\'s job files are untouched');
    const kept = await s.call('POST', '/api/converter/invoke/getCurrent');
    assert.equal(kept.data.value?.id, cur.data.value.id, 'the Encoder still has its job');
    // the converter's next word about the same finished job does not bring it back
    assert.equal(kept.data.value.state, 'completed');
    const dismissed = await s.call('POST', '/api/converter/invoke/dismissSummary', { jobId: kept.data.value.id });
    assert.equal(dismissed.data.ok, true, JSON.stringify(dismissed.data));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!(await s.call('GET', '/api/jobs')).data.jobs.some((j) => j.type === 'conversion'), 'a dismissed summary is no news');

  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the viewer gets a clip\'s telemetry from the server, read off the main thread', { skip: !hasFfmpeg && 'ffmpeg missing', timeout: 120000 }, async () => {
  const dir = await tmp();
  const root = path.join(dir, 'footage');
  await makeFootage(root);
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const clip = path.join(root, 'TeslaCam/RecentClips/2020-01-01_08-00-00-front.mp4');
    const url = `/api/telemetry?path=${encodeURIComponent(clip)}`;
    const res = await s.call('GET', url);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.v, 1);
    assert.equal(res.data.frames.length, 24, 'one record per frame of the 2 s, 12 fps clip');
    assert.ok(res.data.frames.every(([ms, rec]) => Number.isFinite(ms) && typeof rec === 'string' && rec.length > 0));
    // cached by file, size and time: the second answer is a 304 for the same ETag
    const first = await s.call('GET', url, undefined, { raw: true });
    const etag = first.headers.get('etag');
    assert.equal((await s.call('GET', url, undefined, { raw: true, headers: { 'If-None-Match': etag } })).status, 304);
    // a file that is not a Tesla clip has no telemetry, like the desktop viewer
    const junk = path.join(root, 'TeslaCam/RecentClips/2020-01-01_08-00-00-back.mp4');
    const none = await s.call('GET', `/api/telemetry?path=${encodeURIComponent(junk)}`);
    assert.equal(none.status, 200);
    assert.deepEqual(none.data.frames, []);
    assert.equal((await s.call('GET', `/api/telemetry?path=${encodeURIComponent('/etc/passwd')}`)).status, 403);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the Encoder tab is a page of its own: the converter with the shim, its skeleton painted first', async () => {
  const dir = await tmp();
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const res = await s.call('GET', '/studio/encoder.html?embed=encoder&vehicle=daily-driver', undefined, { raw: true });
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.headers.get('content-security-policy'), /unsafe-eval|openfreemap|google/, 'only the converter: no eval, no map tiles');
    const html = await res.text();
    const head = html.split('</head>')[0];
    // (links are versioned: /v/<version>/..., see versionLinks in server/index.js)
    assert.match(head, /<script src="(?:\/v\/[\w-]+)?\/web\/webFlag\.js" defer><\/script>\s*<script src="(?:\/v\/[\w-]+)?\/web\/electronApiShim\.js" defer><\/script>/, 'the shim is injected');
    assert.ok(head.indexOf('electronApiShim.js') < head.search(/src="(?:\/v\/[\w-]+\/studio\/)?encoder\.js"/), 'and runs before the page script');
    assert.match(head, /<link rel="preload" href="(?:\/v\/[\w-]+)?\/web\/studioEmbed\.css" as="style">/);
    // nothing holds up the first paint (the skeleton): no blocking script or
    // stylesheet, the skeleton's styles inline
    assert.doesNotMatch(head, /<script\b(?![^>]*\b(?:defer|async|type="module"))[^>]*>/, 'no blocking script');
    assert.doesNotMatch(head, /<link rel="stylesheet"/, 'no blocking stylesheet');
    assert.match(head, /<style>[^<]*\.enc-sk-bay/, 'the skeleton is styled inline');
    assert.ok(html.indexOf('class="enc-skeleton"') < html.indexOf('id="converterWorkspace"'), 'and comes first');
    assert.doesNotMatch(html, /id="(clipBrowser|dropOverlay|clipDriveTabBar|videoContainer|chooseFolderBtn)"|script\.js/, 'none of the viewer');
    // an old Encoder link opens the new page; the Viewer keeps Studio's
    const old = await s.call('GET', '/studio/index.html?embed=encoder&vehicle=daily-driver', undefined, { raw: true });
    assert.equal(old.status, 302);
    assert.equal(old.headers.get('location'), '/studio/encoder.html?embed=encoder&vehicle=daily-driver');
    const viewer = await s.call('GET', '/studio/index.html?embed=viewer', undefined, { raw: true });
    assert.equal(viewer.status, 200);
    assert.match(await viewer.text(), /electronApiShim\.js/);
    // the shell paints the same skeleton before its script arrives
    const shell = await (await s.call('GET', '/', undefined, { raw: true })).text();
    assert.match(shell, /<script src="(?:\/v\/[\w-]+)?\/web\/boot\.js"><\/script>[\s\S]*id="encoder-skeleton"/);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
  // the shell's Encoder tab opens that page (with the vehicle), the Viewer Studio's
  const app = fs.readFileSync(path.join(REPO, 'web', 'app.js'), 'utf8');
  const src = app.match(/\n {2}function studioUrl\([\s\S]*?\n {2}\}\n/)[0];
  const studioUrl = new Function('current', 'state', `${src}; return studioUrl;`)(() => ({ id: 'car', root: '/footage/car', studioRoot: '/footage/car/TeslaCam' }), { vehicleId: 'car' });
  const encoder = new URL(studioUrl('encoder', { source: '/footage/car/TeslaCam' }), 'http://x');
  assert.equal(encoder.pathname, '/studio/encoder.html');
  assert.deepEqual([encoder.searchParams.get('vehicle'), encoder.searchParams.get('source')], ['car', '/footage/car/TeslaCam']);
  assert.equal(new URL(studioUrl('viewer'), 'http://x').pathname, '/studio/index.html');
});

test('the supervisor only runs the app from the image, never code left in /data', { timeout: 120000 }, async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  // what the old in-app updater left behind, or what anyone who can write /data could plant
  const fakeSha = 'a'.repeat(40);
  const planted = path.join(dir, 'data/app/releases', fakeSha, 'manager/server');
  await fsp.mkdir(planted, { recursive: true });
  await fsp.writeFile(path.join(planted, 'index.js'), "console.log('PLANTED CODE RAN'); setInterval(() => {}, 1000);\n");
  await fsp.writeFile(path.join(dir, 'data/app/current.json'), JSON.stringify({ sha: fakeSha, previous: null, branch: 'x' }));
  const port = await freePort();
  const sup = spawn(process.execPath, [SUPERVISOR], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'), RUN_DIR: path.join(dir, 'run'), SENTRY_NOREPLACE_RENAME: HELPER, LOG_LEVEL: 'warn', TLS_MODE: 'off', PUID: '0', PGID: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  sup.stdout.on('data', (c) => { out += c; });
  sup.stderr.on('data', (c) => { out += c; });
  try {
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
      } catch {
        return false;
      }
    }, 60000);
    assert.match(out, /starting the app/);
    assert.doesNotMatch(out, /PLANTED CODE RAN/);
    // the app clears the old updater's folder
    await waitFor(() => !fs.existsSync(path.join(dir, 'data/app')), 10000);
  } finally {
    sup.kill('SIGTERM');
    await new Promise((r) => sup.once('exit', r));
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Settings > Updates: a build without an image to check says so and checks nothing', async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const st = (await s.call('GET', '/api/updates')).data;
    assert.equal(st.enabled, false);
    assert.equal(st.updateAvailable, false);
    assert.equal((await s.call('POST', '/api/updates/check', {})).data.enabled, false);
    for (const p of ['/api/updater', '/api/updater/branches']) assert.equal((await s.call('GET', p)).status, 404, `${p} is gone`);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Jobs: Clear jobs takes finished jobs off the list after sign-in, from the page only; jobs a restart stopped are interrupted', { timeout: 180000 }, async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  // jobs from before this start: a scan the restart stopped, a conversion the converter resumes
  const { ManagerDB } = require(path.join(REPO, 'server', 'db'));
  const db = new ManagerDB(path.join(dir, 'data', 'manager.db'));
  const stopped = db.startJob({ type: 'scan', vehicleId: 'daily-driver', title: 'Refresh inventory of Daily Driver' });
  const paused = db.startJob({ type: 'conversion', vehicleId: 'daily-driver', title: 'Convert Daily Driver to H265', detail: 'paused: 3 converted', externalId: 'converter:paused-job' });
  db.close();
  // (info: the audit line)
  const s = await startServer(dir, { LOG_LEVEL: 'info' });
  try {
    assert.equal((await s.call('POST', '/api/jobs/clear', { vehicle: 'daily-driver', confirm: true })).status, 401, 'sign in first');
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    let list = (await s.call('GET', '/api/jobs?vehicle=daily-driver')).data.jobs;
    assert.equal(list.find((j) => j.id === stopped).status, 'interrupted', 'a scan stopped by the restart is not running forever');
    assert.match(list.find((j) => j.id === stopped).detail, /stopped by a restart/);
    // a conversion row whose job the converter no longer has (discarded, set
    // aside, from an older version) is not "running" for good: once the
    // converter has listed its jobs, the row is interrupted
    const settled = await waitFor(async () => {
      const row = (await s.call('GET', '/api/jobs?vehicle=daily-driver')).data.jobs.find((j) => j.id === paused);
      return row?.status === 'interrupted' ? row : null;
    }, 60000);
    assert.match(settled.detail, /the converter no longer has this job/);
    list = (await s.call('GET', '/api/jobs?vehicle=daily-driver')).data.jobs;

    // (a busy machine: the scan may take a while; how it ends does not matter here)
    const scan = await s.call('POST', '/api/vehicles/daily-driver/scan', {});
    const scanned = await waitFor(async () => {
      const job = (await s.call('GET', '/api/jobs')).data.jobs.find((j) => j.id === scan.data.jobId);
      return job && job.status !== 'running' ? job : null;
    }, 90000);

    // a mutating route like the others: the page's header, the same origin
    assert.equal((await s.call('POST', '/api/jobs/clear', { vehicle: 'daily-driver', confirm: true }, { headers: { 'X-Requested-With': 'nope' } })).status, 403);
    assert.equal((await s.call('POST', '/api/jobs/clear', { vehicle: 'daily-driver', confirm: true }, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await s.call('GET', '/api/jobs/clear')).status, 404, 'only POST');
    assert.equal((await s.call('POST', '/api/jobs/clear', { vehicle: 'no-such-car', confirm: true })).status, 404);
    assert.equal((await s.call('POST', '/api/jobs/clear', { vehicle: 'no-such-car', preview: true })).status, 404);
    // only what the page sends: anything else is refused, never read as
    // "clear every vehicle's jobs"
    for (const body of [
      undefined, 'x', null, [], {}, 1, true,
      { vehicle: 'daily-driver' }, // no confirmation
      { vehicle: 'daily-driver', confirm: 'true' },
      { vehicle: '', preview: 'true' },
      { vehicle: '', confirm: true },
      { vehicle: 'daily-driver', preview: 'true' },
      { vehicle: 'daily-driver', preview: 1 },
      { vehicle: ['daily-driver'], confirm: true },
      { vehicle: { id: 'daily-driver' }, confirm: true },
      { vehicle: 7, confirm: true },
      { vehicle: false, preview: true }
    ]) {
      const out = await s.call('POST', '/api/jobs/clear', body);
      assert.equal(out.status, 400, `${JSON.stringify(body)} → ${out.status} ${JSON.stringify(out.data)}`);
    }
    assert.equal((await s.call('GET', '/api/jobs')).data.jobs.length, list.length + 1, 'nothing cleared by refused requests');

    const preview = await s.call('POST', '/api/jobs/clear', { vehicle: 'daily-driver', preview: true });
    assert.equal(preview.status, 200);
    const finished = (await s.call('GET', '/api/jobs?vehicle=daily-driver')).data.jobs.filter((j) => j.status !== 'running');
    assert.equal(preview.data.jobs, finished.length, 'the confirmation counts what goes');
    assert.deepEqual(finished.map((j) => j.id).sort((x, y) => x - y), [stopped, paused, scanned.id].sort((x, y) => x - y), 'the new scan, the one the restart stopped and the orphaned conversion');
    assert.equal((await s.call('GET', '/api/jobs')).data.jobs.filter((j) => j.status !== 'running').length, finished.length, 'a preview clears nothing');

    // another open page hears about it
    const events = await fetch(`${s.base}/api/events`, { headers: { Cookie: s.getCookie() } });
    const reader = events.body.getReader();
    await reader.read(); // hello
    const cleared = await s.call('POST', '/api/jobs/clear', { vehicle: 'daily-driver', confirm: true });
    assert.deepEqual(cleared.data, { cleared: finished.length });
    let seen = '';
    const until = Date.now() + 10000;
    while (!/"jobs"/.test(seen) && Date.now() < until) {
      const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ value: new Uint8Array() }), 1000))]);
      seen += new TextDecoder().decode(chunk.value || new Uint8Array());
    }
    await reader.cancel();
    assert.match(seen, /"jobs"/, 'announced on the live updates');
    list = (await s.call('GET', '/api/jobs?vehicle=daily-driver')).data.jobs;
    assert.deepEqual(list.map((j) => [j.id, j.status]), [], 'everything finished is gone, the orphaned conversion row too');
    assert.match(fs.readFileSync(path.join(dir, 'data', 'logs', 'manager.log'), 'utf8'), /\[audit\] Jobs cleared: \d+ finished job\(s\) of daily-driver: admin from/);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Logs (Overview): problems are kept in the data folder and shown and downloaded only after sign-in', async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  // a problem from before this start (a crash, an update)
  fs.mkdirSync(path.join(dir, 'data', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'logs', 'manager.log'), '2026-10-23T01:00:00.000Z WARN  [converter] Verification failed: SentryClips/a/back.mp4 duration-mismatch {"deltaUs":41000}\n');
  const s = await startServer(dir);
  try {
    assert.equal((await s.call('GET', '/api/logs')).status, 401);
    assert.equal((await s.call('GET', '/api/logs/download')).status, 401);
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const problems = (await s.call('GET', '/api/logs')).data.lines;
    assert.ok(problems.some((l) => l.scope === 'converter' && l.level === 'warn' && /duration-mismatch/.test(l.message)), 'the earlier problem is listed');
    assert.ok(problems.every((l) => l.level === 'warn' || l.level === 'error'), 'problems only');
    const res = await s.call('GET', '/api/logs/download', undefined, { raw: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="sentry-six-manager-\d{4}-\d{2}-\d{2}\.log"$/);
    assert.match(await res.text(), /Verification failed: SentryClips\/a\/back\.mp4/);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the support chat is gone: no support route answers, and the page has no Support tab', async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    for (const [method, p] of [['GET', '/api/support'], ['GET', '/api/support/messages'], ['POST', '/api/support/message'],
      ['POST', '/api/support/read'], ['POST', '/api/support/close'], ['GET', '/api/support/attachment?u=/x'], ['POST', '/api/support/media'], ['GET', '/api/support/media']]) {
      assert.equal((await s.call(method, p, method === 'POST' ? {} : undefined)).status, 404, `${method} ${p}`);
    }
    const html = String((await s.call('GET', '/')).data);
    assert.equal(/#\/support|data-route="support"/.test(html), false, 'no Support tab');
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the password change is throttled like confirmation, and converter event streams are capped like /api/events', { timeout: 120000 }, async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const s = await startServer(dir);
  const http = require('http');
  const streams = [];
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/api/auth/password', { current: `guess${i}`, next: 'another horse 1' })).status, 401);
    assert.equal((await s.call('POST', '/api/auth/password', { current: 'correct horse', next: 'another horse 1' })).status, 429,
      'a session cannot guess the current password without limit');

    const { port } = new URL(s.base);
    const agent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
    const openStream = (n) => new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, agent, path: `/api/converter/events?client=c${n}`, headers: { Cookie: s.getCookie() } }, (res) => {
        if (res.statusCode !== 200) res.resume();
        resolve({ req, res });
      });
      req.on('error', reject);
    });
    // the converter may still be starting
    await waitFor(async () => {
      const one = await openStream('probe');
      one.req.destroy();
      return one.res.statusCode === 200;
    }, 60000);
    await new Promise((r) => setTimeout(r, 200));
    for (let i = 0; i < 200; i++) {
      const st = await openStream(i);
      assert.equal(st.res.statusCode, 200, `stream ${i}`);
      streams.push(st);
    }
    const over = await openStream('over');
    assert.equal(over.res.statusCode, 503);
    streams.pop().req.destroy();
    await waitFor(async () => {
      const again = await openStream('again');
      if (again.res.statusCode === 200) streams.push(again);
      return again.res.statusCode === 200;
    }, 5000);
  } finally {
    for (const st of streams) st.req.destroy();
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('sign-in: a burst of parallel guesses is turned away, and guesses from elsewhere never lock the owner out', { timeout: 120000 }, async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  // (behind a proxy the client address comes from X-Forwarded-For: two "devices")
  const s = await startServer(dir, { TRUST_PROXY: 'true' });
  try {
    const from = (ip) => ({ headers: { 'X-Forwarded-For': ip } });
    // 40 guesses at once from one address: only a couple are even checked
    const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => s.call('POST', '/api/auth/login', { username: 'admin', password: `guess${i}` }, from('10.0.0.66'))));
    const checked = burst.filter((r) => r.status === 401).length;
    assert.ok(checked <= 2, `${checked} guesses checked at once`);
    assert.equal(burst.filter((r) => r.status === 429).length, 40 - checked);
    // the attacker locks out its own address...
    for (let i = 0; i < 5; i++) await s.call('POST', '/api/auth/login', { username: 'admin', password: `again${i}` }, from('10.0.0.66'));
    assert.equal((await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' }, from('10.0.0.66'))).status, 429);
    // ...but not the owner on another device
    assert.equal((await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' }, from('10.0.0.20'))).status, 200);
    // and a user name with a line break cannot add a line to the log
    await s.call('POST', '/api/auth/login', { username: 'x\n2026-10-25T10:00:00.000Z INFO  [audit] Signed in: admin', password: 'p' }, from('10.0.0.77'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(/\n[^\n]*\[audit\] Signed in: admin\n/.test(s.output()), false);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Nodes: a change refused part way saves none of it; a removed vehicle leaves every node list', { timeout: 120000 }, async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const { ManagerDB } = require(path.join(REPO, 'server', 'db'));
  const seed = new ManagerDB(path.join(dir, 'data', 'manager.db'));
  // (nobody answers on port 1: the node is just offline)
  seed.set('nodes', [{ id: 'abcdefghijkl', name: 'garage-pc', host: '127.0.0.1', port: 1, token: 't'.repeat(43), pin: { fingerprint: '00' } }]);
  seed.close();
  const s = await startServer(dir);
  const node = async () => {
    const db = new ManagerDB(path.join(dir, 'data', 'manager.db'));
    try { return db.get('nodes')[0]; } finally { db.close(); }
  };
  const put = (body) => s.call('PUT', '/api/nodes/abcdefghijkl', body);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    // the rename in a request refused for its other part is not saved either
    assert.equal((await put({ name: 'Shop PC', trusted: 'yes' })).status, 400);
    assert.equal((await put({ name: 'Shop PC', cars: 'daily-driver' })).status, 400);
    assert.equal((await node()).name, 'garage-pc', 'not renamed by a refused request');
    for (const body of [{ name: 5 }, { name: ['x'] }, { name: '   ' }, { trusted: 'yes' }, { cars: 'daily-driver' }, { cars: [7] }]) {
      assert.equal((await put(body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await node()).name, 'garage-pc');
    // a vehicle removed while the page was open is left out, not refused
    const saved = await put({ name: 'Shop PC', cars: ['daily-driver', 'gone-car'] });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.cars, ['daily-driver']);
    assert.equal((await node()).name, 'Shop PC');
    // removing the vehicle takes it off the node's list
    assert.equal((await s.call('POST', '/api/auth/confirm', { password: 'correct horse' })).status, 200);
    assert.equal((await s.call('DELETE', '/api/vehicles/daily-driver')).status, 200);
    assert.deepEqual((await node()).cars, []);
    // and the Nodes page answers without waiting for the offline node's full timeout
    const began = Date.now();
    assert.equal((await s.call('GET', '/api/nodes')).status, 200);
    assert.ok(Date.now() - began < 5000);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Interface: a pack uploaded in Settings serves its files for everyone, switched and switched back without a restart; /original always shows the built-in one', { timeout: 120000 }, async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const { writeZip } = require(path.join(REPO, 'server', 'zip'));
  const pack = writeZip([
    { name: 'ui.json', data: Buffer.from(JSON.stringify({ name: 'Red' })) },
    { name: 'web/shell.css', data: Buffer.from('body{background:red}') },
    { name: 'web/index.html', data: Buffer.from('<!doctype html><title>Red</title>') },
    { name: 'web/critical.js', data: Buffer.from('/* no bar */') },
    { name: 'studio/styles/footageConverter.css', data: Buffer.from('/* red encoder */') }
  ]);
  const s = await startServer(dir);
  const upload = (body) => fetch(`${s.base}/api/ui-packs/upload`, { method: 'POST', body, headers: { 'X-Requested-With': 'sentry-six-manager', 'Content-Type': 'application/zip', 'X-File-Name': 'red.zip', Cookie: s.getCookie() } });
  const text = async (p, cookie = s.getCookie()) => (await fetch(s.base + p, { headers: { Cookie: cookie }, redirect: 'manual' })).text();
  const builtCss = fs.readFileSync(path.join(REPO, 'web', 'shell.css'), 'utf8');
  try {
    assert.equal((await fetch(`${s.base}/api/ui-packs/upload`, { method: 'POST', body: pack, headers: { 'X-Requested-With': 'sentry-six-manager' } })).status, 401, 'sign in first');
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    assert.equal((await fetch(`${s.base}/api/ui-packs/upload`, { method: 'POST', body: pack, headers: { Cookie: s.getCookie() } })).status, 403, 'X-Requested-With needed');
    const res = await upload(pack);
    assert.equal(res.status, 200);
    const { pack: meta } = await res.json();
    assert.equal(meta.name, 'Red');
    let list = (await s.call('GET', '/api/ui-packs')).data;
    assert.deepEqual([list.active, list.original], [null, false]);
    // the packs that come with the app are listed first, without an upload, and cannot be deleted
    const builtin = list.packs.filter((x) => x.builtin).map((x) => x.id);
    assert.deepEqual(builtin, ['aurora', 'daylight', 'flux', 'horizon', 'sentry-six']);
    assert.ok(list.packs.some((x) => x.id === meta.id && !x.builtin));
    assert.equal((await s.call('DELETE', '/api/ui-packs/flux')).status, 400);
    // the critical-update bar is in every page the server serves, not the sign-in page
    const BAR = /<script src="\/v\/[\w-]+\/web\/critical\.js" defer><\/script>/; // versioned (see versionLinks)
    for (const p of ['/', '/studio/index.html', '/studio/encoder.html']) assert.ok(BAR.test(await text(p)), p);
    assert.ok(!BAR.test(await text('/login', '')), 'not on the sign-in page');
    assert.equal(await text('/web/critical.js'), fs.readFileSync(path.join(REPO, 'web', 'critical.js'), 'utf8'));
    assert.equal((await s.call('PUT', '/api/ui-packs/active', { id: 'daylight' })).status, 200);
    assert.equal((await text('/')).split(BAR).length, 2, 'a built-in pack\'s page has it, once');
    assert.equal(await text('/web/login.js'), fs.readFileSync(path.join(REPO, 'examples', 'ui-packs', 'daylight', 'web', 'login.js'), 'utf8'), 'a built-in pack serves its own files');
    assert.equal((await s.call('PUT', '/api/ui-packs/active', { id: 'sentry-six' })).status, 200);
    const loginCss = await fetch(s.base + '/web/s6/login.css', { redirect: 'manual' });
    assert.equal(loginCss.status, 200, 'the chosen pack login stylesheet is public');
    assert.match(await loginCss.text(), /shield-tile/);
    for (const route of ['/login', '/login/code', '/login/two-factor']) assert.match(await text(route, route.endsWith('two-factor') ? s.getCookie() : ''), /s6\/login\.css/, route);
    assert.equal(await text('/web/login-code.js', ''), fs.readFileSync(path.join(REPO, 'web/login-code.js'), 'utf8'));

    assert.equal((await s.call('PUT', '/api/ui-packs/active', { id: null })).status, 200);
    assert.equal(await text('/web/shell.css'), builtCss, 'installed, not chosen yet');
    // a bad pack is refused with its reason
    const bad = await upload(Buffer.from('not a zip, really not a zip'));
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /not a \.zip/);
    // chosen: its files, at once, for any signed-in browser; the rest stay built-in
    assert.equal((await s.call('PUT', '/api/ui-packs/active', { id: meta.id })).status, 200);
    assert.equal(await text('/web/shell.css'), 'body{background:red}');
    assert.match(await text('/'), /<title>Red<\/title>/);
    assert.ok(BAR.test(await text('/')), 'an uploaded pack\'s page has it too');
    assert.equal(await text('/web/critical.js'), fs.readFileSync(path.join(REPO, 'web', 'critical.js'), 'utf8'), 'a pack cannot replace the bar');
    assert.equal(await text('/studio/styles/footageConverter.css'), '/* red encoder */');
    assert.equal(await text('/web/app.js'), fs.readFileSync(path.join(REPO, 'web', 'app.js'), 'utf8'), 'a file the pack leaves out is the built-in one');
    assert.equal(await text('/web/shell.css', ''), 'body{background:red}', 'the sign-in page uses it too');
    // /original: this browser gets the built-in interface, whatever is chosen
    const escape = await fetch(`${s.base}/original`, { redirect: 'manual' });
    assert.equal(escape.status, 302);
    const flag = escape.headers.get('set-cookie').split(';')[0];
    assert.match(flag, /=1$/);
    const both = `${s.getCookie()}; ${flag}`;
    assert.equal(await text('/web/shell.css', both), builtCss);
    assert.doesNotMatch(await text('/', both), /<title>Red<\/title>/);
    // and back to the original for everyone
    assert.equal((await s.call('PUT', '/api/ui-packs/active', { id: null })).status, 200);
    assert.equal(await text('/web/shell.css'), builtCss);
    for (const id of ['nope', 7, '../x']) assert.equal((await s.call('PUT', '/api/ui-packs/active', { id })).status, 400, String(id));
    // the original to start from
    const orig = await fetch(`${s.base}/api/ui-packs/original.zip`, { headers: { Cookie: s.getCookie() } });
    assert.equal(orig.status, 200);
    assert.equal(orig.headers.get('content-type'), 'application/zip');
    assert.equal((await fetch(`${s.base}/api/ui-packs/original.zip`)).status, 401);
    // deleting the pack
    assert.equal((await s.call('DELETE', `/api/ui-packs/${meta.id}`)).status, 200);
    list = (await s.call('GET', '/api/ui-packs')).data;
    assert.deepEqual(list.packs.map((x) => x.id), ['aurora', 'daylight', 'flux', 'horizon', 'sentry-six']);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Vehicles: Test connection checks the typed SMB details without saving anything', { timeout: 120000 }, async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const s = await startServer(dir);
  const body = (source, extra = {}) => ({ source: { type: 'smb', share: '//127.0.0.1/none', username: 'tesla', password: 'pw', version: '3.1.1', encrypt: true, port: 1, ...source }, ...extra });
  try {
    assert.equal((await s.call('POST', '/api/vehicles/test-smb', body({}))).status, 401, 'sign in first');
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const before = (await s.call('GET', '/api/vehicles')).data;
    const bad = await s.call('POST', '/api/vehicles/test-smb', body({ share: 'not a share' }));
    assert.equal(bad.status, 200);
    assert.deepEqual([bad.data.ok, bad.data.stage], [false, 'details']);
    assert.equal((await s.call('POST', '/api/vehicles/test-smb', body({}, { vehicleId: 'no-such-car' }))).status, 404);
    // a share nobody answers for: a plain "could not connect", never a server error
    const down = await s.call('POST', '/api/vehicles/test-smb', body({}));
    assert.equal(down.status, 200);
    assert.equal(down.data.ok, false);
    assert.equal(down.data.stage, 'connect');
    assert.equal(typeof down.data.error, 'string');
    assert.deepEqual((await s.call('GET', '/api/vehicles')).data, before, 'nothing saved');
    // the test's mount point is never a vehicle's id
    const added = await s.call('POST', '/api/vehicles', { name: 'X SMB Test', source: { type: 'path', path: path.join(dir, 'footage') } });
    if (added.status === 200) assert.notEqual(added.data.id, 'x-smb-test');
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Export: a stretch of a vehicle\'s footage renders into one MP4 to download; other files are refused', { skip: !hasFfmpeg && 'needs ffmpeg', timeout: 120000 }, async () => {
  const dir = await tmp();
  const root = path.join(dir, 'footage');
  await makeFootage(root);
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const v = (await s.call('GET', '/api/vehicles')).data.vehicles[0];
    const front = path.join(root, 'TeslaCam/RecentClips/2020-01-01_08-00-00-front.mp4');
    const body = { units: 'kmh', clips: [{ key: '2020-01-01_08-00-00', files: { front }, from: 0, to: 1.5 }] };
    // a file that is not this vehicle's footage
    const bad = await s.call('POST', `/api/vehicles/${v.id}/exports`, { clips: [{ ...body.clips[0], files: { front: '/etc/passwd' } }] });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /not in Daily Driver's footage/);
    assert.equal((await s.call('POST', '/api/exports', { clips: [{ ...body.clips[0], files: { front: '/etc/passwd' } }] })).status, 400, 'nor without a vehicle');
    // the built-in Viewer's route finds the vehicle from the files
    const started = await s.call('POST', '/api/exports', body);
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.vehicleId, v.id);
    let x;
    await waitFor(async () => {
      x = (await s.call('GET', `/api/exports/${started.data.id}`)).data;
      return !['waiting', 'running'].includes(x.state);
    }, 60000);
    assert.equal(x.state, 'done', x.error);
    const res = await s.call('GET', `/api/exports/${x.id}/file`, undefined, { raw: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="Sentry Daily Driver 2020-01-01 8-00-00 AM\.mp4"/);
    assert.ok((await res.arrayBuffer()).byteLength > 1000);
    // it is a job like the others
    const jobs = (await s.call('GET', '/api/jobs')).data.jobs;
    assert.ok(jobs.some((j) => j.type === 'export' && j.status === 'done' && /Ready to download/.test(j.detail)));
    assert.equal((await s.call('GET', '/api/exports/nope')).status, 404);
    // signed out: nothing
    s.setCookie('');
    assert.equal((await s.call('GET', `/api/exports/${x.id}/file`, undefined, { raw: true })).status, 401);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('days of footage: per vehicle with the first and last day, and across all vehicles (one day once)', async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    await waitFor(async () => (await s.call('GET', '/api/vehicles')).data.vehicles[0].inventory);
    const { vehicles, footageDays } = (await s.call('GET', '/api/vehicles')).data;
    const inv = vehicles[0].inventory;
    assert.equal(inv.days, 3, 'recordings on 2020-01-01, 01-02 and 01-03');
    assert.equal(inv.firstDay, '2020-01-01');
    assert.equal(inv.lastDay, '2020-01-03');
    assert.equal(footageDays, 3);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('pages link their scripts and styles under /v/<version>/: kept a year, a new version when the interface changes', async () => {
  const dir = await tmp();
  const s = await startServer(dir);
  try {
    const login = await (await s.call('GET', '/login', undefined, { raw: true })).text();
    const loginJs = /src="(\/v\/[A-Za-z0-9_-]+)\/web\/login\.js"/.exec(login);
    assert.ok(loginJs, 'the sign-in page links its script versioned');
    const pub = await s.call('GET', `${loginJs[1]}/web/login.js`, undefined, { raw: true });
    assert.equal(pub.status, 200, 'public before sign-in like /web/login.js');
    assert.equal(pub.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal((await s.call('GET', `${loginJs[1]}/web/app.js`, undefined, { raw: true, redirect: 'manual' })).status, 302, 'the rest still needs sign-in');

    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const page = await (await s.call('GET', '/', undefined, { raw: true })).text();
    const v = /src="\/v\/([A-Za-z0-9_-]+)\/web\/app\.js"/.exec(page)[1];
    assert.match(page, new RegExp(`href="/v/${v}/web/shell\\.css"`));
    assert.match(page, new RegExp(`src="/v/${v}/web/critical\\.js"`), 'the critical-update bar too');
    const studio = await (await s.call('GET', '/studio/index.html', undefined, { raw: true })).text();
    assert.match(studio, new RegExp(`src="/v/${v}/web/webFlag\\.js"`), 'injected links');
    assert.match(studio, new RegExp(`src="/v/${v}/studio/script\\.js"|src="/v/${v}/studio/[^"]+\\.js"`), 'relative links resolved against the page');
    const app = await s.call('GET', `/v/${v}/web/app.js`, undefined, { raw: true });
    assert.equal(app.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    const stale = await s.call('GET', '/v/oldversion1/web/app.js', undefined, { raw: true });
    assert.equal(stale.status, 200, 'an old page still gets the file');
    assert.equal(stale.headers.get('cache-control'), 'no-cache', 'but not to keep');
    assert.equal((await s.call('GET', `/v/${v}/api/vehicles`, undefined, { raw: true })).status, 404, 'never the API');
    // a versioned script's imports of the shared scripts are versioned too (kept, not asked again)
    const appText = await app.text();
    assert.match(appText, new RegExp(`import\\('/v/${v}/web/scrub\\.js'\\)`), 'its import of /web/scrub.js');
    assert.ok(!/['"]\/web\/[\w./-]+\.js['"]/.test(appText), 'no plain /web/ script links left');
    const viewerMap = await (await s.call('GET', `/v/${v}/web/viewerMap.js`, undefined, { raw: true })).text();
    assert.match(viewerMap, new RegExp(`import '/v/${v}/shared/mapProviders\\.js'`), 'and under /shared/');
    const plain = await (await s.call('GET', '/web/app.js', undefined, { raw: true })).text();
    assert.match(plain, /import\('\/web\/scrub\.js'\)/, 'the file itself, asked for plainly, is as it is');

    await s.call('POST', '/api/auth/confirm', { password: 'correct horse' });
    await s.call('PUT', '/api/ui-packs/active', { id: 'horizon' });
    const packPage = await (await s.call('GET', '/', undefined, { raw: true })).text();
    const v2 = /(?:src|href)="\/v\/([A-Za-z0-9_-]+)\//.exec(packPage)[1];
    assert.notEqual(v2, v, 'another interface: other links');
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('CAN Bridge uploads: off until turned on, HTTPS and a write-only token, chunks resumed, kept only when the hash matches', async () => {
  const dir = await tmp();
  const s = await startServer(dir, { TRUST_PROXY: 'true' });
  const https = { 'X-Forwarded-Proto': 'https' };
  const name = 'MY-car_20261108T143000Z_1.log.xz';
  const file = crypto.randomBytes(300_000);
  const sha = crypto.createHash('sha256').update(file).digest('hex');
  const up = (token, body, offset, extra = {}) => fetch(`${s.base}/api/can/logs/${name}`, {
    method: 'POST', body,
    headers: { ...https, Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset), 'Upload-Length': String(file.length), 'Upload-SHA256': sha, ...extra }
  }).then(async (r) => ({ status: r.status, data: await r.json() }));
  try {
    assert.equal((await fetch(`${s.base}/api/can/logs/ping`, { headers: https })).status, 404, 'off: nothing there');
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' }, { headers: https });
    await s.call('POST', '/api/auth/confirm', { password: 'correct horse' }, { headers: https }); // (a password confirmed just now)
    const on = await s.call('POST', '/api/can/enable', {}, { headers: https });
    assert.equal(on.status, 200);
    const token = on.data.token;
    assert.ok(token.length >= 40);

    assert.equal((await fetch(`${s.base}/api/can/logs/ping`, { headers: { Authorization: `Bearer ${token}` } })).status, 403, 'plain HTTP refused');
    assert.equal((await fetch(`${s.base}/api/can/logs/ping`, { headers: { ...https, Authorization: 'Bearer wrong' } })).status, 401);
    const ping = await (await fetch(`${s.base}/api/can/logs/ping`, { headers: { ...https, Authorization: `Bearer ${token}` } })).json();
    assert.equal(ping.api, 1);
    // the token does nothing else
    assert.equal((await fetch(`${s.base}/api/vehicles`, { headers: { ...https, Authorization: `Bearer ${token}` } })).status, 401, 'no footage with the token');

    // two chunks, the connection "lost" in between: status says where to go on
    const first = await up(token, file.subarray(0, 100_000), 0);
    assert.deepEqual([first.status, first.data.received, first.data.complete], [200, 100_000, false]);
    const st = await (await fetch(`${s.base}/api/can/logs/status`, { method: 'POST', headers: { ...https, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ names: [name, `${name}.json`, 'nonsense'] }) })).json();
    assert.deepEqual(st.files[name], { state: 'partial', received: 100_000, length: 300_000 });
    assert.equal(st.files[`${name}.json`].state, 'missing');
    assert.equal(st.files.nonsense.state, 'invalid');
    const wrongOffset = await up(token, file.subarray(0, 10), 50);
    assert.deepEqual([wrongOffset.status, wrongOffset.data.code, wrongOffset.data.received], [409, 'offset_mismatch', 100_000]);
    const last = await up(token, file.subarray(100_000), 100_000);
    assert.deepEqual([last.status, last.data.complete], [201, true]);
    const again = await up(token, file.subarray(0), 0);
    assert.deepEqual([again.status, again.data.already], [201, true], 'a retry of a finished file is harmless');

    // a file that arrives different from its hash is thrown away
    const other = 'MY-car_20261108T144000Z_2.log.xz';
    const bad = await fetch(`${s.base}/api/can/logs/${other}`, { method: 'POST', body: Buffer.from('abc'), headers: { ...https, Authorization: `Bearer ${token}`, 'Upload-Offset': '0', 'Upload-Length': '3', 'Upload-SHA256': 'a'.repeat(64) } });
    assert.equal(bad.status, 422);
    // the sidecar
    const side = Buffer.from(JSON.stringify({ frames: 3_540_000, dropped: 0, appVersion: 'build-107' }));
    const sideUp = await fetch(`${s.base}/api/can/logs/${name}.json`, { method: 'POST', body: side, headers: { ...https, Authorization: `Bearer ${token}`, 'Upload-Offset': '0', 'Upload-Length': String(side.length), 'Upload-SHA256': crypto.createHash('sha256').update(side).digest('hex') } });
    assert.equal(sideUp.status, 201);

    // the Nerd panel sees them; the file is stored as it came
    const files = await s.call('GET', '/api/can/files', undefined, { headers: https });
    assert.deepEqual(files.data.logs.map((l) => [l.name, l.bytes, l.frames, l.appVersion]), [[name, 300_000, 3_540_000, 'build-107']]);
    assert.ok((await fsp.readFile(path.join(dir, 'data', 'can', 'MY-car', name))).equals(file));
    assert.equal((await s.call('DELETE', `/api/can/files/${name}`, undefined, { headers: https })).status, 200);
    assert.equal((await s.call('GET', '/api/can/files', undefined, { headers: https })).data.logs.length, 0);

    // tokens per car: another token, then the first revoked; off: gone again
    const on2 = await s.call('POST', '/api/can/tokens', {}, { headers: https });
    assert.equal((await fetch(`${s.base}/api/can/logs/ping`, { headers: { ...https, Authorization: `Bearer ${on2.data.token}` } })).status, 200);
    const tokens = (await s.call('GET', '/api/can/settings', undefined, { headers: https })).data.tokens;
    assert.equal(tokens.length, 2);
    assert.equal(tokens[0].key, 'MY-car', 'the first token is for the car it uploaded for');
    assert.ok(!('hash' in tokens[0]), 'the token\'s hash is not shown');
    assert.equal((await s.call('DELETE', `/api/can/tokens/${tokens[0].id}`, undefined, { headers: https })).status, 200);
    assert.equal((await fetch(`${s.base}/api/can/logs/ping`, { headers: { ...https, Authorization: `Bearer ${token}` } })).status, 401, 'a revoked token stops working');
    await s.call('POST', '/api/can/disable', {}, { headers: https });
    assert.equal((await fetch(`${s.base}/api/can/logs/ping`, { headers: { ...https, Authorization: `Bearer ${on2.data.token}` } })).status, 404);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('CAN Bridge upload address in the Nerd panel: an IPv6 host keeps one pair of brackets', async () => {
  // a browser module (the package is CommonJS), loaded as one
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'nerd.js'), 'utf8');
  const { canUploadAddress } = await import(`data:text/javascript,${encodeURIComponent(src)}`);
  // what a browser's location.hostname gives for each kind of host
  const host = (u) => new URL(u).hostname;
  assert.equal(canUploadAddress(host('https://[fd00::5]:9000/'), 10000), 'https://[fd00::5]:10000/api/can/logs');
  assert.equal(canUploadAddress('fd00::5', 10000), 'https://[fd00::5]:10000/api/can/logs', 'bare IPv6 gets its brackets');
  assert.equal(canUploadAddress(host('https://192.168.1.5:9000/'), 10000), 'https://192.168.1.5:10000/api/can/logs');
  assert.equal(canUploadAddress(host('https://nas.local/'), 10001, false), 'http://nas.local:10001/api/can/logs');
  assert.doesNotThrow(() => new URL(canUploadAddress(host('https://[fd00::5]:9000/'), 10000)));
});

test('Nerd panel live updates: a burst is one refresh, and at most one refresh each 5 s however often things change', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'nerd.js'), 'utf8');
  const { liveSchedule } = await import(`data:text/javascript,${encodeURIComponent(src)}`);
  let refreshes = 0;
  const s = liveSchedule(() => { refreshes++; s.fetched(); }, { gap: 5000 });
  s.fetched(); // the first draw
  for (let k = 0; k < 5; k++) { s.live(); t.mock.timers.tick(100); }
  t.mock.timers.tick(1000);
  assert.equal(refreshes, 0, 'not within 5 s of the last refresh');
  t.mock.timers.tick(4000);
  assert.equal(refreshes, 1, 'the burst: one refresh');
  // an event every second (the index decoding a backlog): one refresh each 5 s, not each second
  for (let k = 0; k < 30; k++) { s.live(); t.mock.timers.tick(1000); }
  assert.ok(refreshes >= 6 && refreshes <= 8, `${refreshes} refreshes in 30 s`);
  s.stop();
  s.live();
  t.mock.timers.tick(60_000);
  const after = refreshes;
  t.mock.timers.tick(60_000);
  assert.equal(refreshes, after, 'nothing after stop()');
});

test('Nerd panel: the Received logs filter (car key, check, text) and the download times', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'nerd.js'), 'utf8');
  const { filterLogs, localInput } = await import(`data:text/javascript,${encodeURIComponent(src)}`);
  const logs = [
    { name: 'AAA_20261108T080000Z_1.log.xz', vehicleKey: 'AAA', check: { status: 'verified' }, appVersion: '0.2.118' },
    { name: 'AAA_20261108T081000Z_2.log.xz', vehicleKey: 'AAA', check: { status: 'failed' }, appVersion: '0.2.120' },
    { name: 'BBB_20261108T080000Z_1.log.xz', vehicleKey: 'BBB', appVersion: null }
  ];
  const names = (f) => filterLogs(logs, f).map((l) => l.name.slice(0, 22));
  assert.deepEqual(names({}), ['AAA_20261108T080000Z_1', 'AAA_20261108T081000Z_2', 'BBB_20261108T080000Z_1']);
  assert.deepEqual(names({ key: 'AAA', check: 'failed' }), ['AAA_20261108T081000Z_2']);
  assert.deepEqual(names({ check: 'waiting' }), ['BBB_20261108T080000Z_1'], 'no check yet counts as waiting');
  assert.deepEqual(names({ text: ' 0.2.120 ' }), ['AAA_20261108T081000Z_2'], 'the app version');
  assert.deepEqual(names({ text: 't0810' }), ['AAA_20261108T081000Z_2'], 'the name, any case');
  assert.match(localInput(Date.UTC(2026, 10, 8, 8, 5)), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(new Date(localInput(Date.UTC(2026, 10, 8, 8, 5, 30))).getTime(), Date.UTC(2026, 10, 8, 8, 5), 'this browser\'s clock, to the minute');
});

test('CAN Bridge port: closed until uploads are on, only the CAN API while open, closed again when off', async () => {
  const dir = await tmp();
  const canPort = await freePort();
  const s = await startServer(dir, { TRUST_PROXY: 'true', CAN_PORT: String(canPort) });
  const https = { 'X-Forwarded-Proto': 'https' };
  const canBase = `http://127.0.0.1:${canPort}`;
  const reach = (p, headers = {}) => fetch(canBase + p, { headers: { ...https, ...headers } }).then((r) => r.status, () => 'closed');
  try {
    assert.equal(await reach('/api/can/logs/ping'), 'closed', 'nothing listens while off');
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' }, { headers: https });
    await s.call('POST', '/api/auth/confirm', { password: 'correct horse' }, { headers: https });
    const on = await s.call('POST', '/api/can/enable', {}, { headers: https });
    assert.equal(on.data.port, canPort);
    await waitFor(async () => (await reach('/api/can/logs/ping', { Authorization: `Bearer ${on.data.token}` })) === 200);
    assert.equal(await reach('/api/vehicles'), 404, 'only the CAN API there');
    assert.equal(await reach('/', { Cookie: s.getCookie() }), 404, 'not the app, even signed in');
    assert.equal(await reach('/api/can/logs/ping', { Authorization: 'Bearer wrong' }), 401);
    const st = (await s.call('GET', '/api/can/settings', undefined, { headers: https })).data;
    assert.deepEqual([st.port.port, st.port.listening], [canPort, true]);
    // one address cannot hold every connection: the seventh at once is closed
    const net = require('net');
    const socks = await Promise.all(Array.from({ length: 7 }, () => new Promise((ok) => { const c = net.connect(canPort, '127.0.0.1', () => ok(c)); c.on('error', () => ok(c)); })));
    await new Promise((r) => setTimeout(r, 300));
    // (the test's own earlier requests may still hold a kept-alive connection or two)
    const open = socks.filter((c) => !c.destroyed && c.readyState === 'open').length;
    assert.ok(open <= 6 && open < 7, `at most six at once from one address (${open} of 7 kept)`);
    socks.forEach((c) => c.destroy());
    await new Promise((r) => setTimeout(r, 100));
    await s.call('POST', '/api/can/disable', {}, { headers: https });
    await waitFor(async () => (await reach('/api/can/logs/ping')) === 'closed');
    // turned on and off quickly, many times at once: it ends as the last call
    // said, with one listener when on (so it can still be closed) and none when off
    const flip = (on) => s.call('POST', on ? '/api/can/enable' : '/api/can/disable', {}, { headers: https });
    const settle = async () => {
      await new Promise((r) => setTimeout(r, 500));
      return (await s.call('GET', '/api/can/settings', undefined, { headers: https })).data.port;
    };
    for (let round = 0; round < 3; round++) {
      await Promise.all([flip(true), flip(false), flip(true), flip(true), flip(false), flip(true)]);
      const up = await settle();
      assert.deepEqual([up.listening, up.error], [true, null], 'on, one listener, no "used by something else"');
      assert.equal(await reach('/api/can/logs/ping', { Authorization: `Bearer ${on.data.token}` }), 200);
      await Promise.all([flip(false), flip(true), flip(false), flip(true), flip(false)]);
      const down = await settle();
      assert.deepEqual([down.listening, down.error], [false, null]);
      assert.equal(await reach('/api/can/logs/ping'), 'closed', 'nothing left listening');
    }
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('CAN Bridge security: a token per car, signed logs verified, a changed log kept but not used, the chain checked, abuse refused', { skip: spawnSync('xz', ['--version']).status !== 0 && 'needs xz', timeout: 90000 }, async () => {
  const { signedMessage } = require('../server/canTrust');
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const s = await startServer(dir, { TRUST_PROXY: 'true' });
  const https = { 'X-Forwarded-Proto': 'https' };
  const A = 'aaaaaa000001';
  const B = 'bbbbbb000002';
  const put = (token, name, body, extra = {}) => fetch(`${s.base}/api/can/logs/${encodeURIComponent(name)}`, { method: 'POST', body, headers: { ...https, Authorization: `Bearer ${token}`, 'Upload-Offset': '0', 'Upload-Length': String(body.length), 'Upload-SHA256': crypto.createHash('sha256').update(body).digest('hex'), ...extra } }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  // the bridge: a P-256 key and a chain
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ format: 'der', type: 'spki' });
  let index = 0;
  let prev = { name: '-', sha256: '0'.repeat(64) };
  const t0 = Date.UTC(2020, 0, 1, 8, 0, 0) / 1000;
  const logFor = (minute, volts) => {
    const lines = [];
    for (let i = 0; i < 600; i++) {
      const b = Buffer.alloc(8);
      b.writeUInt16LE(Math.round(volts / 0.01), 0);
      lines.push(`(${(t0 + minute * 60 + i / 10).toFixed(6)}) can0 132#${b.toString('hex').toUpperCase()}`);
    }
    return execFileSync('xz', ['-6', '-c'], { input: `${lines.join('\n')}\n` });
  };
  const signed = (name, body, key = A) => {
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const msg = signedMessage({ vehicleKey: key, name, sha256: sha, length: body.length, index, prevName: prev.name, prevSha256: prev.sha256 });
    const integrity = { signed: true, version: 'canbridge-log-sig-v1', algorithm: 'ECDSA-P256-SHA256', public_key: der.toString('base64'), vehicle_key: key, sha256: sha, length: body.length, index, prev_name: prev.name, prev_sha256: prev.sha256, signature: crypto.sign('sha256', Buffer.from(msg), privateKey).toString('base64') };
    prev = { name, sha256: sha };
    index++;
    return Buffer.from(JSON.stringify({ format: 'canbridge-candump-xz/1', frames: 600, app_version: '0.2.118', dropped_chunks: 0, integrity }));
  };
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' }, { headers: https });
    await s.call('POST', '/api/auth/confirm', { password: 'correct horse' }, { headers: https });
    const tokA = (await s.call('POST', '/api/can/enable', {}, { headers: https })).data.token;
    const tokB = (await s.call('POST', '/api/can/tokens', {}, { headers: https })).data.token;

    // log 0 of car A, signed: verified, paired, decoded
    const n0 = `${A}_20200101T080000Z_1.log.xz`;
    const log0 = logFor(0, 390);
    assert.equal((await put(tokA, n0, log0)).status, 201);
    assert.equal((await put(tokA, `${n0}.json`, signed(n0, log0))).status, 201);
    // the token is now car A's: car B's logs are refused, and B's names are not even answered
    const nB = `${B}_20200101T080000Z_1.log.xz`;
    const wrong = await put(tokA, nB, Buffer.from('x'));
    assert.deepEqual([wrong.status, wrong.data.code], [403, 'wrong_car']);
    const st = await (await fetch(`${s.base}/api/can/logs/status`, { method: 'POST', headers: { ...https, Authorization: `Bearer ${tokA}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ names: [n0, nB] }) })).json();
    assert.deepEqual([st.files[n0].state, st.files[nB].state], ['complete', 'forbidden']);
    // car B's own token works for car B
    assert.equal((await put(tokB, nB, Buffer.from('car b'))).status, 201);
    assert.equal((await put(tokB, `${A}_20200101T090000Z_5.log.xz`, Buffer.from('x'))).data.code, 'wrong_car', 'and only for car B');

    const files = async () => Object.fromEntries((await s.call('GET', '/api/can/files', undefined, { headers: https })).data.logs.map((l) => [l.name, l]));
    await waitFor(async () => (await files())[n0]?.check.status === 'verified');
    const f0 = (await files())[n0];
    assert.deepEqual([f0.appVersion, f0.dropped, f0.check.index], ['0.2.118', 0, 0], 'the sidecar\'s own field names');
    const clip0 = path.join(dir, 'footage', 'TeslaCam', 'RecentClips', '2020-01-01_08-00-00-front.mp4');
    await waitFor(async () => (await s.call('GET', `/api/can/clip?path=${encodeURIComponent(clip0)}&signals=BattVoltage132`, undefined, { headers: https })).data.series?.BattVoltage132);
    const c0 = (await s.call('GET', `/api/can/clip?path=${encodeURIComponent(clip0)}&signals=BattVoltage132`, undefined, { headers: https })).data;
    assert.equal(c0.trust, 'verified');

    // log 1, swapped after signing: kept, failed, not decoded
    const n1 = `${A}_20200101T080100Z_2.log.xz`;
    const log1 = logFor(1, 350);
    const side1 = signed(n1, log1);
    // (a valid log, but not the one signed: another battery voltage throughout)
    const changed = logFor(1, 351);
    assert.equal((await put(tokA, n1, changed)).status, 201, 'taken (the upload hash is the file\'s own)');
    assert.equal((await put(tokA, `${n1}.json`, side1)).status, 201);
    await waitFor(async () => (await files())[n1]?.check.status === 'failed');
    assert.match((await files())[n1].check.reason, /not the one that was signed/);
    const clip1 = path.join(dir, 'footage', 'TeslaCam', 'RecentClips', '2020-01-01_08-01-00-front.mp4');
    await new Promise((r) => setTimeout(r, 1500));
    const c1 = (await s.call('GET', `/api/can/clip?path=${encodeURIComponent(clip1)}&signals=BattVoltage132`, undefined, { headers: https })).data;
    assert.ok(!(c1.series.BattVoltage132 || []).some(([t, v]) => t >= (t0 + 62) * 1000 && Math.abs(v - 351) < 1), 'the changed log\'s data is not used');
    // used anyway: decoded, and flagged
    assert.equal((await s.call('POST', `/api/can/files/${n1}/use`, { use: true }, { headers: https })).status, 200);
    await waitFor(async () => (await s.call('GET', `/api/can/clip?path=${encodeURIComponent(clip1)}&signals=BattVoltage132`, undefined, { headers: https })).data.trust === 'override');

    // log 2 never arrives; log 3 does: a gap in the chain
    signed(`${A}_20200101T080200Z_3.log.xz`, logFor(2, 380));
    const n3 = `${A}_20200101T080300Z_4.log.xz`;
    const log3 = logFor(3, 381);
    await put(tokA, n3, log3);
    await put(tokA, `${n3}.json`, signed(n3, log3));
    await waitFor(async () => (await files())[n3]?.check.status === 'verified');
    const trustA = (await s.call('GET', '/api/can/settings', undefined, { headers: https })).data.trust.find((x) => x.key === A);
    assert.deepEqual(trustA.chain.issues.map((i) => i.kind), ['failed', 'gap']);
    assert.match(trustA.chain.issues[0].text, /^log 1 .* failed its check/);
    assert.equal(trustA.chain.issues[1].text, 'log 2 is missing');
    assert.match(trustA.pin.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.deepEqual([trustA.counts.verified, trustA.counts.failed], [2, 1]);

    // abuse: names that try to leave the folder, a sidecar too large, a flood of wrong tokens
    assert.ok([400, 404].includes((await put(tokA, '../../etc/passwd', Buffer.from('x'))).status));
    assert.ok([400, 404].includes((await put(tokA, `${A}_20200101T080000Z_1.log.xz/../../x`, Buffer.from('x'))).status));
    assert.equal((await put(tokA, `${A}_20200101T090000Z_9.log.xz.json`, Buffer.alloc(10), { 'Upload-Length': String(5 * 1024 * 1024) })).status, 413);
    let last = 0;
    for (let i = 0; i < 22; i++) last = (await put(`wrong${i}`, n0, Buffer.from('x'))).status;
    assert.equal(last, 429, 'an address that keeps guessing is refused');
    // ... but the right token from that same address still works (wrong tokens cannot lock the car out)
    assert.equal((await fetch(`${s.base}/api/can/logs/ping`, { headers: { ...https, Authorization: `Bearer ${tokA}` } })).status, 200);
    // a token not tied to a car yet cannot ask about two cars at once (nor see either)
    const fresh = (await s.call('POST', '/api/can/tokens', {}, { headers: https })).data.token;
    const mixed = await fetch(`${s.base}/api/can/logs/status`, { method: 'POST', headers: { ...https, Authorization: `Bearer ${fresh}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ names: [n0, nB] }) });
    assert.deepEqual([mixed.status, (await mixed.json()).code], [400, 'mixed_cars']);

    // the CAN token cannot do anything else
    assert.equal((await fetch(`${s.base}/api/can/settings`, { headers: { ...https, Authorization: `Bearer ${tokA}` } })).status, 401);
    assert.equal((await fetch(`${s.base}/api/can/files/${n0}`, { method: 'DELETE', headers: { ...https, Authorization: `Bearer ${tokA}`, 'X-Requested-With': 'sentry-six-manager' } })).status, 401);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('CAN index: an uploaded log is decoded in the background, and a clip gets its signals at its own time', { skip: spawnSync('xz', ['--version']).status !== 0 && 'needs xz', timeout: 60000 }, async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const s = await startServer(dir, { TRUST_PROXY: 'true' });
  const https = { 'X-Forwarded-Proto': 'https' };
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' }, { headers: https });
    await s.call('POST', '/api/auth/confirm', { password: 'correct horse' }, { headers: https });
    const token = (await s.call('POST', '/api/can/enable', {}, { headers: https })).data.token;
    // a minute of the clip 2020-01-01_08-00-00 (the car's zone is UTC here): battery
    // voltage 380 V rising 0.1 V a second, speed 36 km/h, and an id no DBC knows
    const t0 = Date.UTC(2020, 0, 1, 8, 0, 0) / 1000;
    const lines = ['# canbridge v1'];
    for (let i = 0; i < 70 * 10; i++) {
      const t = t0 - 2 + i / 10;
      const volts = 380 + (t - t0) * 0.1;
      const b132 = Buffer.alloc(8);
      b132.writeUInt16LE(Math.round(volts / 0.01), 0);
      const b257 = Buffer.alloc(8);
      b257.writeUInt32LE(Math.round((36 + 40) / 0.08) << 12, 0);
      lines.push(`(${t.toFixed(6)}) can0 132#${b132.toString('hex').toUpperCase()}`, `(${t.toFixed(6)}) can0 257#${b257.toString('hex').toUpperCase()}`, `(${t.toFixed(6)}) can0 7FF#0102030405060708`,
        `(${t.toFixed(6)}) can0 7EF#AA00${(Math.floor(i / 20) & 0xff).toString(16).padStart(2, '0').toUpperCase()}00`); // unknown: byte 2 counts every 2 s
    }
    const file = execFileSync('xz', ['-6', '-c'], { input: `${lines.join('\n')}\n` });
    const name = 'MY-car_20200101T075958Z_1.log.xz';
    const up = await fetch(`${s.base}/api/can/logs/${name}`, { method: 'POST', body: file, headers: { ...https, Authorization: `Bearer ${token}`, 'Upload-Offset': '0', 'Upload-Length': String(file.length), 'Upload-SHA256': crypto.createHash('sha256').update(file).digest('hex') } });
    assert.equal(up.status, 201);
    // its sidecar (unsigned, as from a bridge before signing): the log is used once it is here
    const side = Buffer.from(JSON.stringify({ format: 'canbridge-candump-xz/1', frames: 2100 }));
    const sideUp = await fetch(`${s.base}/api/can/logs/${name}.json`, { method: 'POST', body: side, headers: { ...https, Authorization: `Bearer ${token}`, 'Upload-Offset': '0', 'Upload-Length': String(side.length), 'Upload-SHA256': crypto.createHash('sha256').update(side).digest('hex') } });
    assert.equal(sideUp.status, 201);
    const clip = path.join(dir, 'footage', 'TeslaCam', 'RecentClips', '2020-01-01_08-00-00-front.mp4');
    await waitFor(async () => (await s.call('GET', `/api/can/signals?path=${encodeURIComponent(clip)}`, undefined, { headers: https })).data.signals?.BattVoltage132);
    const meta = (await s.call('GET', `/api/can/signals?path=${encodeURIComponent(clip)}`, undefined, { headers: https })).data.signals;
    assert.equal(meta.BattVoltage132.unit, 'V');
    const got = (await s.call('GET', `/api/can/clip?path=${encodeURIComponent(clip)}&signals=BattVoltage132,DI_vehicleSpeed`, undefined, { headers: https })).data;
    assert.equal(got.start, t0 * 1000, 'the clip starts at its name, in the car\'s zone');
    const at = (pts, ms) => pts.filter((p) => p[0] <= ms).pop()?.[1];
    assert.ok(Math.abs(at(got.series.BattVoltage132, got.start + 10_000) - 381) < 0.02, 'about 381 V ten seconds in');
    assert.ok(Math.abs(at(got.series.DI_vehicleSpeed, got.start + 30_000) - 36) < 0.1, '36 km/h');
    assert.ok(got.series.BattVoltage132[0][0] <= got.start, 'with the value from before the clip starts');
    // signals=* (the Viewer's list): every signal, each one's last value every 250 ms (here 10 a second come in)
    const all = (await s.call('GET', `/api/can/clip?path=${encodeURIComponent(clip)}&signals=*`, undefined, { headers: https })).data;
    assert.ok(all.series.BattVoltage132 && all.series.DI_vehicleSpeed, 'every signal');
    const bv = all.series.BattVoltage132;
    assert.ok(bv.length <= 4 * 72 + 2 && bv.length > 4 * 60, `about four a second (${bv.length})`);
    assert.ok(Math.abs(at(bv, got.start + 10_000) - at(got.series.BattVoltage132, got.start + 10_000)) < 0.05, 'the same values, fewer of them');
    assert.equal(all.trust, got.trust);
    assert.deepEqual((await s.call('GET', `/api/can/clip?path=${encodeURIComponent(clip)}&signals=*`, undefined, { headers: https })).data, all, 'kept ready for the next viewer');
    // the List's answer: every signal, thinned to a value every 250 ms, as columns, with what changes
    const lst = (await s.call('GET', `/api/can/clip?path=${encodeURIComponent(clip)}&signals=*&step=250&cols=1`, undefined, { headers: https })).data;
    assert.equal(lst.start, got.start);
    assert.equal(lst.step, 250);
    assert.equal(lst.series, undefined, 'columns, not pairs');
    const [dt, vals] = lst.cols.BattVoltage132;
    const times = dt.reduce((a, d) => [...a, (a.length ? a[a.length - 1] : lst.base) + d], []);
    assert.ok(times[0] <= lst.start, 'the value from before the clip starts');
    assert.ok(times.every((t, k) => k <= 1 || Math.floor((t - lst.start + 2000) / 250) > Math.floor((times[k - 1] - lst.start + 2000) / 250)), `at most one value per 250 ms: ${times.slice(0, 8).map((t) => t - lst.start)}`);
    assert.ok(Math.abs(vals[times.filter((t) => t <= lst.start + 10_000).length - 1] - 381) < 0.05, 'about 381 V ten seconds in, as the full answer says');
    assert.ok(lst.changing.includes('BattVoltage132') && !lst.changing.includes('DI_vehicleSpeed'), `what changes: ${lst.changing}`);
    assert.equal(lst.trust, got.trust);
    assert.ok(all.series.BattVoltage132.length >= dt.length, 'signals=* alone (an older page): pairs, each value every 250 ms, repeats kept');
    assert.deepEqual((await s.call('GET', `/api/can/clip?path=${encodeURIComponent(clip)}&signals=*&step=250&cols=1`, undefined, { headers: https })).data, lst, 'the List\'s answer kept ready too');
    assert.equal((await s.call('GET', `/api/can/clip?path=${encodeURIComponent(clip)}&signals=*&step=0&cols=1`, undefined, { headers: https })).data.step, 250, 'never finer than 250 ms for every signal');
    // the nerd raw view: every id, the unknown one too, its payload changes in UTC
    const raw = (await s.call('GET', `/api/can/raw?path=${encodeURIComponent(clip)}`, undefined, { headers: https })).data;
    assert.equal(raw.start, got.start);
    assert.deepEqual(raw.sync, got.sync, 'the same sync as the signals (its rate is the drift)');
    assert.deepEqual(raw.ids.map((e) => [e.bus, e.id, e.name]), [['can0', '132', 'ID132HVBattAmpVolt'], ['can0', '257', 'ID257DIspeed'], ['can0', '7EF', null], ['can0', '7FF', 'ID7FFcarConfig']], 'sorted by id; null for what the DBC does not know');
    const same = raw.ids.find((e) => e.id === '7FF');
    assert.deepEqual(same.changes.map((c) => c[1]), ['0102030405060708'], 'a payload that never changes: once');
    assert.ok(same.changes[0][0] <= raw.start, 'the payload at the clip\'s start');
    assert.ok(Math.abs(same.hz - 10) < 0.5, `10 frames a second (${same.hz})`);
    const unknown = raw.ids.find((e) => e.id === '7EF').changes;
    const at0 = unknown.filter((c) => c[0] <= raw.start).pop();
    assert.equal(at0[1], 'AA000100', 'the unknown id\'s payload as the clip starts (2 s after its count began)');
    assert.ok(unknown.some((c) => c[0] === raw.start + 2000 && c[1] === 'AA000200'), 'and when it changes');
    assert.equal(unknown.filter((c) => c[0] > raw.start).length, 33, 'one change every 2 s (2 … 66 s), nothing in between');
    const volts = raw.ids.find((e) => e.id === '132').changes;
    assert.ok(volts.length > 50 && volts.every((c, i) => i === 0 || c[0] > volts[i - 1][0]), 'the changes in time order');
    const part = (await s.call('GET', `/api/can/raw?path=${encodeURIComponent(clip)}&from=10000&to=11000`, undefined, { headers: https })).data;
    assert.ok(part.ids.find((e) => e.id === '132').changes.every((c) => c[0] <= raw.start + 11000) && part.from === raw.start + 10000, 'a part of the clip');
    assert.deepEqual((await s.call('GET', `/api/can/raw?path=${encodeURIComponent(clip)}&probe=1`, undefined, { headers: https })).data, { start: raw.start, count: 4 });
    const st = (await s.call('GET', '/api/can/settings', undefined, { headers: https })).data;
    assert.deepEqual(st.keys, ['MY-car']);
    assert.equal(st.index.lastError, null);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('CAN clip: a Model Y\'s multi-bus log, two clips in a row: every stat steady from one second and clip to the next', { skip: spawnSync('xz', ['--version']).status !== 0 && 'needs xz', timeout: 60000 }, async () => {
  // the owner's car (test/canModelY.js): pages sent in turn, the same ids on can0, can1 and can3
  // with other data; read wrongly, each second showed another page (3.6 V then 15.7 V, ...)
  const { candump, EXPECTED } = require('./canModelY');
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const s = await startServer(dir, { TRUST_PROXY: 'true' });
  const https = { 'X-Forwarded-Proto': 'https' };
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' }, { headers: https });
    await s.call('POST', '/api/auth/confirm', { password: 'correct horse' }, { headers: https });
    const token = (await s.call('POST', '/api/can/enable', {}, { headers: https })).data.token;
    const t0 = Date.UTC(2020, 0, 1, 8, 0, 0);
    const file = execFileSync('xz', ['-6', '-c'], { input: candump(t0 - 2000, 1240) }); // 07:59:58 to 08:02:02
    const name = 'MY-car_20200101T075958Z_1.log.xz';
    const put = async (n, body) => (await fetch(`${s.base}/api/can/logs/${n}`, { method: 'POST', body, headers: { ...https, Authorization: `Bearer ${token}`, 'Upload-Offset': '0', 'Upload-Length': String(body.length), 'Upload-SHA256': crypto.createHash('sha256').update(body).digest('hex') } })).status;
    assert.equal(await put(name, file), 201);
    // the sidecar's bus map, as the CAN Bridge writes it
    const side = Buffer.from(JSON.stringify({ format: 'canbridge-candump-xz/1', frames: 1240 * 15, bus: { can0: 'vehicle (inferred from IDs)', can1: 'chassis (inferred from IDs)', can3: 'screenmate-internal' } }));
    assert.equal(await put(`${name}.json`, side), 201);
    const clips = ['2020-01-01_08-00-00-front.mp4', '2020-01-01_08-01-00-front.mp4'].map((c) => path.join(dir, 'footage', 'TeslaCam', 'RecentClips', c));
    const names = Object.keys(EXPECTED).join(',');
    const ask = (clip) => s.call('GET', `/api/can/clip?path=${encodeURIComponent(clip)}&signals=${names}`, undefined, { headers: https }).then((r) => r.data);
    await waitFor(async () => (await ask(clips[1])).series?.v12vBattVoltage261);
    const at = (pts, ms) => pts?.filter((p) => p[0] <= ms).pop()?.[1];
    for (const clip of clips) {
      const got = await ask(clip);
      for (const [n, want] of Object.entries(EXPECTED)) {
        for (let ms = 0; ms < 60_000; ms += 1000) {
          const v = at(got.series[n], got.start + ms);
          assert.ok(v !== undefined && Math.abs(v - want) < 0.01, `${path.basename(clip)} +${ms / 1000} s: ${n} is ${v}, not ${want}`);
        }
      }
    }
    // the decoded list has no layout not known, nor a name two messages share (of the Screenmate's own
    // bus only the car's position is decoded: test/canInternalGps.test.js)
    const meta = (await s.call('GET', `/api/can/signals?path=${encodeURIComponent(clips[0])}`, undefined, { headers: https })).data.signals;
    for (const n of ['BMSmaxPackTemperature', 'BrakeTempFL3FE', 'UI_cpuTemperature']) assert.equal(meta[n], undefined, n);
    assert.equal(meta.VCSEC_TPMSPressure0.unit, 'bar');
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('CAN downloads (Nerd): a log as received, a bundle with ids.csv, decoded CSV and new ids; admins only, never the upload token; live updates on upload',{ skip: spawnSync('xz', ['--version']).status !== 0 && 'needs xz', timeout: 90000 }, async () => {
  const { readZip } = require('../server/zip');
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const s = await startServer(dir, { TRUST_PROXY: 'true' });
  const https = { 'X-Forwarded-Proto': 'https' };
  const get = (p, headers = {}) => fetch(s.base + p, { headers: { ...https, Cookie: s.getCookie(), ...headers } });
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' }, { headers: https });
    await s.call('POST', '/api/auth/confirm', { password: 'correct horse' }, { headers: https });
    const token = (await s.call('POST', '/api/can/enable', {}, { headers: https })).data.token;
    // a minute and a bit at 08:00 UTC: battery voltage, and an id no DBC knows (7EF)
    const t0 = Date.UTC(2020, 0, 1, 8, 0, 0) / 1000;
    const lines = [];
    for (let i = 0; i < 700; i++) {
      const t = t0 - 2 + i / 10;
      const b = Buffer.alloc(8);
      b.writeUInt16LE(Math.round((380 + i * 0.01) / 0.01), 0);
      b.writeInt16LE(-25, 2); // SmoothBattCurrent132: 2.5 A out of the pack
      lines.push(`(${t.toFixed(6)}) can0 132#${b.toString('hex').toUpperCase()}`, `(${t.toFixed(6)}) can0 7EF#AA00${(i & 0xff).toString(16).padStart(2, '0').toUpperCase()}00`);
    }
    const file = execFileSync('xz', ['-6', '-c'], { input: `${lines.join('\n')}\n` });
    const name = 'MY-car_20200101T075958Z_1.log.xz';
    const side = Buffer.from(JSON.stringify({ format: 'canbridge-candump-xz/1', frames: 1400 }));
    const put = (n, body) => fetch(`${s.base}/api/can/logs/${n}`, { method: 'POST', body, headers: { ...https, Authorization: `Bearer ${token}`, 'Upload-Offset': '0', 'Upload-Length': String(body.length), 'Upload-SHA256': crypto.createHash('sha256').update(body).digest('hex') } });

    // the Nerd panel's live updates: a finished upload is announced as 'can'
    const events = await get('/api/events');
    const reader = events.body.getReader();
    await reader.read(); // hello
    assert.equal((await put(name, file)).status, 201);
    let seen = '';
    const until = Date.now() + 10000;
    while (!/"can"/.test(seen) && Date.now() < until) {
      const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ value: new Uint8Array() }), 1000))]);
      seen += new TextDecoder().decode(chunk.value || new Uint8Array());
    }
    await reader.cancel();
    assert.match(seen, /event: changed\ndata: \{"topics":\[[^\]]*"can"/, 'announced on the live updates');
    assert.equal((await put(`${name}.json`, side)).status, 201);
    // decoded in the background
    await waitFor(async () => (await s.call('GET', '/api/can/export/new-ids?key=MY-car&since=2019-12-31', undefined, { headers: https })).data.ids?.length >= 2);

    // one log and its sidecar, exactly as received
    const raw = await get(`/api/can/files/${name}/download`);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('content-disposition'), `attachment; filename="${name}"`);
    assert.equal(raw.headers.get('content-type'), 'application/x-xz');
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), file);
    const sd = await get(`/api/can/files/${name}.json/download`);
    assert.equal(sd.status, 200);
    assert.deepEqual(Buffer.from(await sd.arrayBuffer()), side);
    // only names canLogs takes, under the car's own folder
    assert.equal((await get('/api/can/files/nonsense/download')).status, 400);
    assert.equal((await get('/api/can/files/MY-car_20200101T075958Z_9.log.xz/download')).status, 404, 'a good name that is not here');
    for (const bad of ['..%2F..%2Fdb.json', '..%2Fcan%2FMY-car%2F' + name, 'MY-car_20200101T075958Z_1.log.xz.part', '%2Fetc%2Fpasswd', 'MY-car_20200101T075958Z_1.log.xz%2F..%2F..%2Fdb.json']) {
      const st = (await get(`/api/can/files/${bad}/download`)).status;
      assert.ok(st === 400 || st === 404, `${bad}: refused (${st})`);
    }
    for (const bad of ['../can', '..%2F..', 'MY car', '']) assert.equal((await get(`/api/can/export/bundle?key=${bad}&from=2020-01-01&to=2020-01-02`)).status, 400, `key ${bad}`);
    // ranges: both ends, in order, at most a week (a day for decoded)
    assert.equal((await get('/api/can/export/bundle?key=MY-car&from=2020-01-01')).status, 400);
    assert.equal((await get('/api/can/export/bundle?key=MY-car&from=2020-01-02&to=2020-01-01')).status, 400);
    assert.notEqual((await get('/api/can/export/bundle?key=MY-car&from=2020-01-01&to=2020-01-09')).status, 400, 'any range: no 7-day limit');
    assert.equal((await get('/api/can/export/bundle?key=MY-car&from=2020-01-01&to=nope')).status, 400);
    assert.equal((await get('/api/can/export/decoded?key=MY-car&from=2020-01-01&to=2020-01-03')).status, 400, 'over a day');
    assert.equal((await get('/api/can/export/bundle?key=MY-car&from=2021-01-01&to=2021-01-02')).status, 404, 'no logs then');

    // the bundle: the log and sidecar (the one running at the start counts), then ids.csv and manifest.json
    const b = await get('/api/can/export/bundle?key=MY-car&from=2020-01-01T08:00&to=2020-01-01T08:30');
    assert.equal(b.status, 200);
    assert.equal(b.headers.get('content-type'), 'application/zip');
    assert.match(b.headers.get('content-disposition'), /^attachment; filename="can-MY-car-20200101T0800-to-20200101T0830\.zip"$/);
    const zipBuf = Buffer.from(await b.arrayBuffer());
    assert.deepEqual(readZip(zipBuf).map((e) => e.name), [`MY-car/${name}`, `MY-car/${name}.json`, 'ids.csv', 'manifest.json'], 'the logs first: the download starts at once');
    const entries = Object.fromEntries(readZip(zipBuf).map((e) => [e.name, e.data]));
    assert.deepEqual(Object.keys(entries).sort(), ['MY-car/' + name, `MY-car/${name}.json`, 'ids.csv', 'manifest.json'].sort());
    assert.deepEqual(entries[`MY-car/${name}`], file, 'the log byte for byte');
    assert.deepEqual(entries[`MY-car/${name}.json`], side);
    const csv = entries['ids.csv'].toString('utf8').trim().split('\n');
    assert.equal(csv[0], 'bus,id_hex,message,unknown,frames,hz,first_seen_utc,last_seen_utc,minutes_seen');
    const row = (id) => csv.find((l) => l.startsWith(`can0,0x${id},`))?.split(',');
    assert.deepEqual(row('132').slice(2, 4), ['ID132HVBattAmpVolt', '']);
    assert.deepEqual(row('7EF').slice(2, 4), ['unknown', 'UNKNOWN'], 'an id the DBC does not know stands out');
    assert.equal(Number(row('7EF')[4]), 680, 'its frames from 08:00 on (the range), from the index');
    assert.ok(Math.abs(Number(row('7EF')[5]) - 10) < 0.5, `about 10 Hz (${row('7EF')[5]})`);
    assert.equal(row('7EF')[6], '2020-01-01T08:00:00.000Z');
    const manifest = JSON.parse(entries['manifest.json']);
    assert.deepEqual([manifest.vehicleKey, manifest.logs.length, manifest.logs[0].name, manifest.ids.unknown], ['MY-car', 1, name, 1]);
    // a real zip tool reads it too (stored entries with data descriptors)
    if (spawnSync('unzip', ['-v']).status === 0) {
      const zf = path.join(dir, 'bundle.zip');
      await fsp.writeFile(zf, zipBuf);
      assert.equal(spawnSync('unzip', ['-tq', zf]).status, 0, 'unzip -t passes');
    }

    // decoded signals as CSV
    const dec = await get('/api/can/export/decoded?key=MY-car&from=2020-01-01T08:00&to=2020-01-01T08:00:30&signals=BattVoltage132');
    assert.equal(dec.status, 200);
    assert.match(dec.headers.get('content-type'), /^text\/csv/);
    const decLines = (await dec.text()).trim().split('\n');
    assert.equal(decLines[0], 'timestamp_utc,signal,value,unit,value_name');
    assert.ok(decLines.length > 20, `rows (${decLines.length})`);
    assert.match(decLines[1], /^2020-01-01T08:00:00\.\d{3}Z,BattVoltage132,38\d\.\d*,V,$/);
    assert.ok(decLines.slice(1).every((l) => l.split(',')[0] <= '2020-01-01T08:00:30.000Z' && l.split(',')[1] === 'BattVoltage132'), 'only that signal, inside the range');
    assert.equal(dec.headers.get('content-encoding'), 'gzip', 'sent gzipped (the browser unpacks it)');
    const plain = await get('/api/can/export/decoded?key=MY-car&from=2020-01-01T08:00&to=2020-01-01T08:00:30&signals=BattVoltage132', { 'Accept-Encoding': 'identity' });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal((await plain.text()).trim().split('\n').length, decLines.length);
    // every signal: only changes (and a value that stays the same once a minute), with an estimate first
    const est = (await s.call('GET', '/api/can/export/decoded?key=MY-car&from=2020-01-01T08:00&to=2020-01-01T08:00&check=1', undefined, { headers: https })).data;
    assert.equal(est.mode, 'changes');
    assert.equal(est.minutes, 1);
    assert.ok(est.estimatedRows > 0 && est.willStop === false, JSON.stringify(est));
    const allDec = (await (await get('/api/can/export/decoded?key=MY-car&from=2020-01-01T08:00&to=2020-01-01T08:00')).text()).trim().split('\n').slice(1);
    assert.equal(allDec.length, est.estimatedRows, 'the estimate of one minute is its count');
    const every = (await (await get('/api/can/export/decoded?key=MY-car&from=2020-01-01T08:00&to=2020-01-01T08:00&mode=every')).text()).trim().split('\n').slice(1);
    assert.ok(every.length >= allDec.length, `every point the index keeps (${every.length} >= ${allDec.length})`);
    // the computed stats (as the Viewer shows them): with every signal, and by id
    const calcAll = allDec.filter((l) => l.split(',')[1] === 'calc.batteryPower');
    assert.ok(calcAll.length >= 1, 'battery power with every signal');
    assert.match(calcAll[0], /^2020-01-01T08:00:00\.\d{3}Z,calc\.batteryPower,0\.95\d*,kW,$/, 'volts x amps, positive out of the pack');
    assert.ok(!allDec.some((l) => l.split(',')[1] === 'calc.chargingPower'), 'no charging power while not charging (nothing says it charges)');
    const byId = (await (await get('/api/can/export/decoded?key=MY-car&from=2020-01-01T08:00&to=2020-01-01T08:00:30&signals=calc.batteryPower,calc.lv12Power,BattVoltage132')).text()).trim().split('\n').slice(1);
    assert.deepEqual([...new Set(byId.map((l) => l.split(',')[1]))].sort(), ['BattVoltage132', 'calc.batteryPower'], 'the inputs read, written only when asked for; no 12 V data, no 12 V power');
    const v0 = Number(byId.find((l) => l.split(',')[1] === 'BattVoltage132').split(',')[2]);
    const p0 = Number(byId.find((l) => l.split(',')[1] === 'calc.batteryPower').split(',')[2]);
    assert.ok(Math.abs(p0 - (v0 * 2.5) / 1000) < 0.06, `${p0} kW from ${v0} V x 2.5 A`);
    assert.equal(byId.filter((l) => l.split(',')[1] === 'calc.batteryPower').length, byId.filter((l) => l.split(',')[1] === 'BattVoltage132').length, 'one each time the volts change (every point, with a list)');
    const estCalc = (await s.call('GET', '/api/can/export/decoded?key=MY-car&from=2020-01-01T08:00&to=2020-01-01T08:00&check=1&signals=calc.batteryPower', undefined, { headers: https })).data;
    assert.equal(estCalc.signals, 1);

    // new ids since a date: JSON for the panel, CSV to download
    const fresh = (await s.call('GET', '/api/can/export/new-ids?key=MY-car&since=2019-12-31', undefined, { headers: https })).data;
    assert.deepEqual(fresh.ids.map((x) => [x.key, x.name, x.unknown]), [['can0:132', 'ID132HVBattAmpVolt', false], ['can0:7EF', null, true]]);
    assert.equal((await s.call('GET', '/api/can/export/new-ids?key=MY-car&since=2020-01-02', undefined, { headers: https })).data.ids.length, 0, 'nothing new after');
    const nc = await get('/api/can/export/new-ids?key=MY-car&since=2019-12-31&format=csv');
    assert.match(nc.headers.get('content-disposition'), /filename="can-MY-car-new-ids-since-2019-12-31\.csv"/);
    assert.match(await nc.text(), /^bus,id_hex,message,unknown,first_seen_utc,last_seen_utc,minutes_seen\ncan0,0x132,ID132HVBattAmpVolt,,.*\ncan0,0x7EF,unknown,UNKNOWN,/);
    assert.equal((await get('/api/can/export/new-ids?key=MY-car')).status, 400, 'since is needed');

    // the upload token reads nothing: not on the web port, and not with a cookie-less request
    const tok = { ...https, Authorization: `Bearer ${token}` };
    for (const p of [`/api/can/files/${name}/download`, '/api/can/export/bundle?key=MY-car&from=2020-01-01&to=2020-01-02', '/api/can/export/decoded?key=MY-car&from=2020-01-01&to=2020-01-01', '/api/can/export/new-ids?key=MY-car&since=2019-12-31', `/api/can/logs/${name}`, `/api/can/logs/${name}/download`]) {
      const res = await fetch(s.base + p, { headers: tok });
      assert.ok(res.status === 401 || res.status === 404, `${p} with the token: ${res.status}`);
      assert.notEqual(res.headers.get('content-type'), 'application/x-xz');
    }

    // a watch-only account gets none of it
    assert.equal((await s.call('POST', '/api/accounts', { username: 'kid', password: 'watching only', role: 'viewer' }, { headers: https })).status, 200);
    const login = await fetch(`${s.base}/api/auth/login`, { method: 'POST', headers: { ...https, 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' }, body: JSON.stringify({ username: 'kid', password: 'watching only' }) });
    assert.equal(login.status, 200);
    const kid = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    for (const p of [`/api/can/files/${name}/download`, '/api/can/export/bundle?key=MY-car&from=2020-01-01&to=2020-01-02', '/api/can/export/decoded?key=MY-car&from=2020-01-01&to=2020-01-01', '/api/can/export/new-ids?key=MY-car&since=2019-12-31&format=csv']) {
      assert.equal((await fetch(s.base + p, { headers: { ...https, Cookie: kid } })).status, 403, `${p}: watch-only refused`);
    }
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('CAN search: when a signal first met a condition and when an id appeared, with the clip that covers it', { timeout: 60000 }, async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  // three indexed minutes of the car MY-car (its only car, in UTC): 08:00 to 08:02
  const idx = path.join(dir, 'data', 'can-index', 'MY-car');
  await fsp.mkdir(idx, { recursive: true });
  const t0 = Date.UTC(2020, 0, 1, 8, 0);
  const minute = (i, signals, ids) => fsp.writeFile(path.join(idx, `20200101T080${i}.json.gz`), zlib.gzipSync(JSON.stringify({ minute: `20200101T080${i}`, signals, ids })));
  await minute(0, { DI_vehicleSpeed: [[0, 10], [30_000, 20]] }, { 'can0:257': 600 });
  await minute(1, { DI_vehicleSpeed: [[0, 30], [42_000, 55]] }, { 'can0:257': 600, 'can0:3F5': 10 });
  await minute(2, { DI_vehicleSpeed: [[0, 50]] }, { 'can0:257': 600, 'can0:3F5': 10 });
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const vid = (await s.call('GET', '/api/vehicles')).data.vehicles[0].id;
    await waitFor(async () => (await s.call('GET', `/api/vehicles/${vid}/recordings`)).data?.recordings?.length);
    const found = (await s.call('GET', `/api/can/search?vehicle=${vid}&signal=DI_vehicleSpeed&op=%3E&value=40`)).data;
    assert.equal(found.first.at, t0 + 60_000 + 42_000);
    assert.equal(found.first.value, 55);
    assert.equal(found.first.localTime, '2020-01-01 08:01:42');
    assert.deepEqual(found.first.footage, { at: t0 + 102_000, localTime: '2020-01-01 08:01:42', day: '2020-01-01', clip: '2020-01-01_08-01-00', second: 42 });
    assert.equal((await s.call('GET', `/api/can/search?vehicle=${vid}&signal=DI_vehicleSpeed&op=%3E&value=40&from=2020-01-01T08:02`)).data.first.at, t0 + 120_000);
    assert.equal((await s.call('GET', `/api/can/search?vehicle=${vid}&signal=DI_vehicleSpeed&op=~&value=40`)).status, 400);
    // a time that is not one is an error, not the whole history
    for (const bad of ['to=2020%2F01%2F01', 'from=yesterday', 'from=2020-02-31']) {
      const res = await s.call('GET', `/api/can/search?vehicle=${vid}&signal=DI_vehicleSpeed&op=%3E&value=40&${bad}`);
      assert.equal(res.status, 400, bad);
      assert.match(res.data.error, /is not a time/);
    }
    assert.equal((await s.call('GET', `/api/can/id-events?vehicle=${vid}&before=2020-13-01`)).status, 400);
    // all read: nothing to go on with; a token that is not kept is a 400
    assert.deepEqual([found.complete, found.resume], [true, null]);
    assert.equal((await s.call('GET', `/api/can/search?vehicle=${vid}&resume=0123456789abcdef01234567`)).status, 400);
    const ev = (await s.call('GET', `/api/can/id-events?vehicle=${vid}&before=2020-01-01T08:01`)).data;
    assert.deepEqual(ev.appeared.map((x) => [x.id, x.at, x.footage?.clip]), [['can0:3F5', t0 + 60_000, '2020-01-01_08-01-00']]);
    assert.ok((await s.call('GET', `/api/can/vehicle-signals?vehicle=${vid}`)).data.signals);
    assert.equal((await s.call('GET', '/api/can/search?vehicle=nope&signal=x&op=appeared')).status, 404);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Viewer dashboards: kept per account, cleaned of anything that is not a block', async () => {
  const dir = await tmp();
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    assert.deepEqual((await s.call('GET', '/api/dashboards')).data, { boards: [], active: null, carData: { enabled: false } }, 'none yet: the page uses its default (and car data in the Viewer is off on a new install)');
    const put = await s.call('PUT', '/api/dashboards', { active: 'b2', boards: [
      { id: 'b1', name: 'Drive', placement: 'below', blocks: [{ type: 'gauge', signals: ['dash.speed'] }, { type: 'wide', signals: ['a', 'b', 'c', 'd'] }, { type: 'evil', signals: ['x'] }] },
      { id: 'b2', name: '  Battery\nnerd ', placement: 'sideways', metric: true, blocks: [{ type: 'small', signals: ['can.BattVoltage132', '<script>'] }] }
    ] });
    assert.equal(put.status, 200);
    const got = (await s.call('GET', '/api/dashboards')).data;
    assert.equal(got.active, 'b2');
    assert.deepEqual(got.boards[0].blocks, [{ type: 'gauge', signals: ['dash.speed'] }, { type: 'wide', signals: ['a', 'b', 'c'] }], 'three stats at most in a wide block; unknown block types dropped');
    assert.deepEqual([got.boards[1].name, got.boards[1].placement, got.boards[1].metric, got.boards[1].blocks[0].signals], ['Battery nerd', 'below', true, ['can.BattVoltage132']]);
    assert.equal((await s.call('PUT', '/api/dashboards', { boards: [] })).status, 400);
    // a bar moved anywhere: its spot for wide and narrow screens, kept within the screen (0 to 1)
    const fl = await s.call('PUT', '/api/dashboards', { active: 'f', boards: [{ id: 'f', name: 'Float', placement: 'float', float: { wide: { x: 0.25, y: 0.1 }, narrow: { x: 7, y: -2 }, huge: { x: 1, y: 1 } }, blocks: [] }] });
    assert.deepEqual([fl.data.boards[0].placement, fl.data.boards[0].float], ['float', { wide: { x: 0.25, y: 0.1 }, narrow: { x: 1, y: 0 } }]);
    assert.equal((await s.call('PUT', '/api/dashboards', { boards: [{ id: 'x', placement: 'sideways', blocks: [] }] })).data.boards[0].placement, 'below');
    // the list box: docked, or floating where it was dragged (shares of the room, 0 to 1)
    const lb = await s.call('PUT', '/api/dashboards', { boards: [{ id: 'l', listPlacement: 'float', listFloat: { wide: { x: 0.9, y: 0.2 }, narrow: { x: -3, y: 9 }, other: { x: 0, y: 0 } }, blocks: [] }, { id: 'm', listPlacement: 'sideways', blocks: [] }] });
    assert.deepEqual([lb.data.boards[0].listPlacement, lb.data.boards[0].listFloat], ['float', { wide: { x: 0.9, y: 0.2 }, narrow: { x: 0, y: 1 } }]);
    assert.deepEqual([lb.data.boards[1].listPlacement, lb.data.boards[1].listFloat], ['dock', {}]);
    // spots on the page (top in px), sizes per screen kind (px, within sane bounds), where a pulled-out bar goes back to
    const pg = await s.call('PUT', '/api/dashboards', { boards: [{ id: 'p', placement: 'float', barHome: 'over',
      float: { wide: { x: 0.5, y: 0.2, top: 1234.6 }, narrow: { x: 0.1, y: 0.1, top: -50 } },
      listFloat: { wide: { x: 0.3, y: 0.4, top: 9e9 }, narrow: { x: 0.3, y: 0.4, top: 'high' } },
      size: { wide: { w: 640.4, h: 210 }, narrow: { h: 5 }, other: { w: 1, h: 1 } },
      listSize: { wide: { w: 99999, h: 'tall' }, narrow: { w: 'x' } }, blocks: [] }, { id: 'q', barHome: 'sideways', blocks: [] }] });
    const p0 = pg.data.boards[0];
    assert.deepEqual([p0.barHome, pg.data.boards[1].barHome], ['over', 'below']);
    assert.deepEqual(p0.float, { wide: { x: 0.5, y: 0.2, top: 1235 }, narrow: { x: 0.1, y: 0.1, top: 0 } });
    assert.deepEqual(p0.listFloat, { wide: { x: 0.3, y: 0.4, top: 100000 }, narrow: { x: 0.3, y: 0.4 } });
    assert.deepEqual(p0.size, { wide: { w: 640, h: 210 }, narrow: { h: 40 } });
    assert.deepEqual(p0.listSize, { wide: { w: 8000 } });
    assert.deepEqual([pg.data.boards[1].size, pg.data.boards[1].listSize], [{}, {}], 'old dashboards: today\'s sizes');
    // spots anchored to the cameras (the nearest corner and the px from it, on the video or not,
    // and a List's anchor to the bar), with or without the old shares; anything else dropped
    const an = await s.call('PUT', '/api/dashboards', { boards: [{ id: 'a', placement: 'float', listPlacement: 'float',
      float: { wide: { x: 0.5, y: 0.2, top: 700, h: 'r', v: 'b', dx: 20.4, dy: -190, over: true }, narrow: { h: 'l', v: 't', dx: 9e9, dy: -9e9, over: 'yes' } },
      listFloat: { wide: { h: 'R', v: 't', dx: 20, dy: 0, over: false, bar: { h: 'l', v: 'B', dx: 0, dy: 8, extra: 1 } }, narrow: { h: 'x', v: 't', dx: 0, dy: 0 } },
      blocks: [] }, { id: 'b', float: { wide: { h: 'l', v: 't', dx: 'far', dy: 0 } }, listFloat: { wide: { x: 0.1, y: 0.1, h: 'l', v: 't', dx: 1, dy: 2, bar: { h: 'q' } } }, blocks: [] }] });
    const [a0, a1] = an.data.boards;
    assert.deepEqual(a0.float, { wide: { x: 0.5, y: 0.2, top: 700, h: 'r', v: 'b', dx: 20, dy: -190, over: true }, narrow: { h: 'l', v: 't', dx: 100000, dy: -100000, over: false } });
    assert.deepEqual(a0.listFloat, { wide: { h: 'R', v: 't', dx: 20, dy: 0, over: false, bar: { h: 'l', v: 'B', dx: 0, dy: 8 } } });
    assert.deepEqual([a1.float, a1.listFloat], [{}, { wide: { x: 0.1, y: 0.1, h: 'l', v: 't', dx: 1, dy: 2, over: false } }]);
    // a list block: no stats of its own, its search and "changing only" kept
    const li = await s.call('PUT', '/api/dashboards', { boards: [{ id: 'l', blocks: [{ type: 'list', signals: ['a'], q: 'volt\u0007age', changing: true }, { type: 'toString', signals: [] }] }] });
    assert.deepEqual(li.data.boards[0].blocks, [{ type: 'list', signals: [], q: 'volt age', changing: true }]);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Viewer dashboards: "12V Battery Current" saved before shows the 12 V system\'s current; the battery\'s own can still be picked', async () => {
  const dir = await tmp();
  const { ManagerDB } = require(path.join(REPO, 'server', 'db'));
  const seed = new ManagerDB(path.join(dir, 'data', 'manager.db'));
  // (saved before the revision: no rev)
  seed.set('dash:admin', { active: 'd', boards: [{ id: 'd', name: 'Drive', placement: 'below', blocks: [
    { type: 'small', signals: ['can.v12vBattCurrent261'] },
    { type: 'wide', signals: ['dash.speed', 'can.v12vBattCurrent261', 'can.v12vBattVoltage261'] },
    { type: 'list', signals: [], q: '12v', changing: false }
  ] }] });
  seed.close();
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const got = (await s.call('GET', '/api/dashboards')).data;
    assert.equal(got.rev, 2);
    assert.deepEqual(got.boards[0].blocks, [
      { type: 'small', signals: ['can.PCS_dcdcLvOutputCurrent'] },
      { type: 'wide', signals: ['dash.speed', 'can.PCS_dcdcLvOutputCurrent', 'can.v12vBattVoltage261'] },
      { type: 'list', signals: [], q: '12v', changing: false }
    ], 'the same place, the 12 V system\'s current; everything else as it was');
    // saved by today's page: the battery's own current, picked now, stays what it is
    const put = await s.call('PUT', '/api/dashboards', { active: 'd', boards: [{ id: 'd', blocks: [{ type: 'small', signals: ['can.v12vBattCurrent261'] }, { type: 'gauge', signals: ['can.PCS_dcdcLvOutputCurrent'] }] }] });
    assert.equal(put.data.rev, 2);
    const again = (await s.call('GET', '/api/dashboards')).data;
    assert.deepEqual(again.boards[0].blocks.map((b) => b.signals[0]), ['can.v12vBattCurrent261', 'can.PCS_dcdcLvOutputCurrent']);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('early data: the calls the main page made the last two times it opened are asked for at once the next time', async () => {
  const dir = await tmp();
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const fetchLike = { headers: { 'Sec-Fetch-Dest': 'empty' } };
    const open = async (calls) => {
      const page = await (await s.call('GET', '/', undefined, { raw: true })).text();
      for (const c of calls) await s.call('GET', c, undefined, fetchLike);
      await s.call('GET', '/api/settings', undefined, { headers: { 'Sec-Fetch-Dest': 'image' } }); // not a fetch(): not noted
      await new Promise((r) => setTimeout(r, 2300));
      return page;
    };
    assert.ok(!(await open(['/api/vehicles', '/api/updates?x=1'])).includes('prefetch.js'), 'nothing learnt yet');
    assert.ok(!(await open(['/api/vehicles', '/api/updates?x=2'])).includes('prefetch.js'), 'learnt after it opened twice');
    const page = await open([]);
    const m = /<script src="\/v\/[\w-]+\/web\/prefetch\.js" data-urls="([^"]+)"><\/script>/.exec(page);
    assert.ok(m, 'the early-data script, first in the head');
    assert.deepEqual(JSON.parse(m[1].replace(/&quot;/g, '"')), ['/api/vehicles'], 'only what both openings asked for, by fetch()');
    assert.ok(page.indexOf('prefetch.js') < page.indexOf('app.js'), 'before the page\'s own scripts');
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('starred moments: kept on the server with a note, protect their recording, edited and removed; the day has a summary', async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    await waitFor(async () => (await s.call('GET', '/api/vehicles')).data.vehicles[0].inventory);
    const bad = await s.call('POST', '/api/stars', { vehicle: 'daily-driver', clip: 'nonsense', second: 3 });
    assert.equal(bad.status, 400);
    const made = await s.call('POST', '/api/stars', { vehicle: 'daily-driver', clip: '2020-01-01_08-01-00', second: 12.7, note: '  near miss\n at the light ' });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    assert.deepEqual((({ day, clip, second, note }) => ({ day, clip, second, note }))(made.data.star), { day: '2020-01-01', clip: '2020-01-01_08-01-00', second: 12, note: 'near miss  at the light' });
    assert.equal(made.data.protected, true);
    const recs = (await s.call('GET', '/api/vehicles/daily-driver/recordings?date=2020-01-01')).data.recordings;
    assert.ok(recs.find((r) => r.startKey <= '2020-01-01_08-01-00' && r.protected), 'its recording is protected');
    const id = made.data.star.id;
    assert.equal((await s.call('PATCH', `/api/stars/${id}`, { note: 'pothole' })).data.star.note, 'pothole');
    assert.deepEqual((await s.call('GET', '/api/stars?vehicle=daily-driver')).data.stars.map((x) => x.note), ['pothole']);
    assert.equal((await s.call('DELETE', `/api/stars/${id}`)).status, 200);
    assert.deepEqual((await s.call('GET', '/api/stars')).data.stars, []);
    assert.equal((await s.call('DELETE', `/api/stars/${id}`)).status, 404);
    // no driving data in these clips: a summary of nothing
    assert.deepEqual((await s.call('GET', '/api/vehicles/daily-driver/moments?date=2020-01-01')).data.summary, { distance: 0, driving: 0, top: 0 });
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('accounts: a watch-only account watches; two-step sign-in with a code (and a recovery code); devices listed and signed out', { timeout: 120000 }, async () => {
  const { totp } = require('../server/accounts');
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const s = await startServer(dir);
  // a client with its own cookies (more than one at a time)
  const client = (agent) => {
    const jar = new Map();
    return async (method, p, body) => {
      const res = await fetch(s.base + p, {
        method, redirect: 'manual',
        headers: { 'X-Requested-With': 'sentry-six-manager', 'User-Agent': agent, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      for (const c of res.headers.getSetCookie()) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i)); else jar.set(kv.slice(0, i), kv.slice(i + 1));
      }
      const text = await res.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* text */ }
      return { status: res.status, data, location: res.headers.get('location') };
    };
  };
  try {
    const admin = client('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0');
    assert.equal((await admin('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);
    assert.equal((await admin('GET', '/api/auth/me')).data.role, 'admin', 'accounts from before roles are admins');
    // (adding an account needs the password typed lately: signing in just did)
    assert.deepEqual((await admin('POST', '/api/accounts', { username: 'kid', password: 'watching only', role: 'viewer' })).data.accounts.map((a) => [a.username, a.role]), [['admin', 'admin'], ['kid', 'viewer']]);
    assert.equal((await admin('PATCH', '/api/accounts/admin', { role: 'viewer' })).status, 409, 'the last admin stays');

    const kid = client('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1');
    assert.equal((await kid('POST', '/api/auth/login', { username: 'kid', password: 'watching only' })).status, 200);
    await waitFor(async () => (await kid('GET', '/api/vehicles')).data.vehicles?.[0]?.inventory);
    assert.equal((await kid('GET', '/api/vehicles')).status, 200, 'watching is fine');
    const rec = (await kid('GET', '/api/vehicles/daily-driver/recordings')).data.recordings[0];
    assert.equal((await kid('POST', '/api/vehicles/daily-driver/trash', { ids: [rec.id] })).status, 403, 'no deleting');
    assert.equal((await kid('PUT', '/api/vehicles/daily-driver/policy', { enabled: true })).status, 403, 'no settings');
    assert.equal((await kid('GET', '/api/support-bundle')).status, 403, 'no server details');
    assert.equal((await kid('POST', '/api/stars', { vehicle: 'daily-driver', clip: '2020-01-01_08-00-00', second: 3 })).status, 200, 'starring is fine');

    // devices: the admin sees two of its own sessions after signing in elsewhere
    const phone = client('Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile');
    await phone('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const list = (await admin('GET', '/api/auth/sessions')).data.sessions;
    assert.equal(list.length, 2);
    assert.equal(list.filter((x) => x.current).length, 1);
    assert.ok(list.some((x) => /Android/.test(x.agent)));
    assert.equal((await admin('POST', '/api/auth/sessions-end-others')).data.ended, 1);
    assert.equal((await phone('GET', '/api/vehicles')).status, 401, 'signed out there');

    // two-step sign-in
    await admin('POST', '/api/auth/confirm', { password: 'correct horse' });
    const { secret } = (await admin('POST', '/api/auth/2fa/start')).data;
    assert.equal((await admin('POST', '/api/auth/2fa/enable', { code: '000000' })).status, 400);
    const now = () => Math.floor(Date.now() / 30000);
    const { recovery } = (await admin('POST', '/api/auth/2fa/enable', { code: totp(secret, now()) })).data;
    assert.equal(recovery.length, 10);
    const laptop = client('Mozilla/5.0 (Macintosh; Mac OS X 14) Safari/605');
    const first = await laptop('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    assert.equal(first.data.twoFactor, true, 'the password alone does not sign in');
    assert.equal((await laptop('GET', '/api/vehicles')).status, 401);
    assert.match((await laptop('GET', '/footage')).location, /^\/login\/code/, 'pages send it to the code page');
    assert.equal((await laptop('GET', '/login/code')).status, 200);
    assert.equal((await laptop('POST', '/api/auth/2fa/code', { code: '123456' })).status, 401);
    assert.equal((await laptop('POST', '/api/auth/2fa/code', { code: totp(secret, now() + 1) })).status, 200);
    assert.equal((await laptop('GET', '/api/vehicles')).status, 200, 'signed in with the code');
    // a recovery code works once
    const lost = client('Mozilla/5.0 (X11; Linux) Firefox/130');
    await lost('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    assert.equal((await lost('POST', '/api/auth/2fa/code', { code: recovery[0] })).status, 200);
    const again = client('Mozilla/5.0 (X11; Linux) Firefox/130');
    await again('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    assert.equal((await again('POST', '/api/auth/2fa/code', { code: recovery[0] })).status, 401, 'used already');
    assert.equal((await laptop('GET', '/api/auth/2fa')).data.recoveryLeft, 9);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('CAN bundle: a full week of a bridge logging every 10 minutes around the clock is not refused', async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  // 8 days of ten-minute logs (the files' content does not matter to the check)
  const can = path.join(dir, 'data', 'can', 'MY-car');
  await fsp.mkdir(can, { recursive: true });
  const t0 = Date.UTC(2020, 0, 1);
  for (let i = 0; i < 8 * 144; i++) await fsp.writeFile(path.join(can, `MY-car_${new Date(t0 + i * 600_000).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z_${i + 1}.log.xz`), 'x');
  const s = await startServer(dir, { TRUST_PROXY: 'true' });
  const https = { 'X-Forwarded-Proto': 'https' };
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' }, { headers: https });
    const week = await s.call('GET', '/api/can/export/bundle?key=MY-car&from=2020-01-01T00:00Z&to=2020-01-08T00:00Z&check=1', undefined, { headers: https });
    assert.equal(week.status, 200, JSON.stringify(week.data));
    assert.equal(week.data.logs, 7 * 144, 'the log that starts exactly at the end holds nothing of the range');
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
