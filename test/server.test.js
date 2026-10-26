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
    // an open-ended range (what a video asks for) is answered in parts of at most 2 MiB
    const big = path.join(root, 'TeslaCam/RecentClips/2020-01-01_08-02-00-front.mp4');
    await fsp.writeFile(big, crypto.randomBytes(5 * 1024 * 1024));
    const head = await s.call('GET', `/api/media?path=${encodeURIComponent(big)}`, undefined, { raw: true, headers: { Range: 'bytes=0-' } });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-range'), `bytes 0-${2 * 1024 * 1024 - 1}/${5 * 1024 * 1024}`);
    assert.equal((await head.arrayBuffer()).byteLength, 2 * 1024 * 1024);
    const tail = await s.call('GET', `/api/media?path=${encodeURIComponent(big)}`, undefined, { raw: true, headers: { Range: `bytes=${4 * 1024 * 1024}-` } });
    assert.equal(tail.headers.get('content-range'), `bytes ${4 * 1024 * 1024}-${5 * 1024 * 1024 - 1}/${5 * 1024 * 1024}`);
    assert.equal((await tail.arrayBuffer()).byteLength, 1024 * 1024);
    assert.equal((await s.call('GET', `/api/media?path=${encodeURIComponent('/etc/passwd')}`, undefined, { raw: true })).status, 403);
    assert.equal((await s.call('POST', '/api/studio/readDir', { path: '/etc' })).status, 403);

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
    assert.equal(binFiles.length, 5);
    assert.ok(binFiles.every((f) => f.endsWith('.binned')), 'binned files are invisible to the converter');
    const rootListing = await s.call('POST', '/api/studio/readDir', { path: root });
    assert.ok(!rootListing.data.some((e) => e.name === '.sentry-recycle-bin'), 'viewer never sees the bin');
    const { data: { items } } = await s.call('GET', '/api/bin?vehicle=daily-driver');
    assert.equal(items.length, 2);

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
    assert.doesNotMatch((await s.call('GET', '/', undefined, { raw: true })).headers.get('content-security-policy'), /unsafe-eval/, 'the shell does not');
    const html = await studioRes.text();
    assert.match(html, /webFlag\.js[\s\S]*electronApiShim\.js/);
    assert.ok(!/<script>/.test(html.split('</head>')[0].split('<head>')[1].split('<title>')[0]), 'nothing inline is injected');
    assert.equal((await s.call('GET', '/shared/mapProviders.js', undefined, { raw: true })).status, 200);
    assert.equal((await s.call('GET', '/assets/pedal_brake.png', undefined, { raw: true })).headers.get('content-type'), 'image/png');
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
    assert.doesNotMatch(res.headers.get('content-security-policy'), /unsafe-eval|openstreetmap/, 'only the converter: no eval, no map tiles');
    const html = await res.text();
    const head = html.split('</head>')[0];
    assert.match(head, /<script src="\/web\/webFlag\.js" defer><\/script>\s*<script src="\/web\/electronApiShim\.js" defer><\/script>/, 'the shim is injected');
    assert.ok(head.indexOf('electronApiShim.js') < head.indexOf('src="encoder.js"'), 'and runs before the page script');
    assert.match(head, /<link rel="preload" href="\/web\/studioEmbed\.css" as="style">/);
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
    assert.match(shell, /<script src="\/web\/boot\.js"><\/script>[\s\S]*id="encoder-skeleton"/);
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

test('Settings > Support: one file upload at a time, and the upload path answers only POST', async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    assert.equal((await s.call('GET', '/api/support/media')).status, 405);
    assert.equal(s.output().includes('Internal error') || /TypeError/.test(s.output()), false);
    // a first upload still coming in holds the slot
    const http = require('http');
    const { port } = new URL(s.base);
    const first = http.request({ host: '127.0.0.1', port, path: '/api/support/media', method: 'POST',
      headers: { 'X-Requested-With': 'sentry-six-manager', Cookie: s.getCookie(), 'Content-Type': 'image/png', 'Content-Length': 1024 * 1024 } });
    first.on('error', () => {});
    first.write(Buffer.alloc(1024));
    await new Promise((r) => setTimeout(r, 300));
    const second = await s.call('POST', '/api/support/media', undefined, { headers: { 'Content-Type': 'image/png' } });
    assert.equal(second.status, 429);
    first.destroy();
    // released when the first goes away: the next one gets as far as reading
    // its body (empty here, so refused for that)
    await waitFor(async () => (await s.call('POST', '/api/support/media', undefined, { headers: { 'Content-Type': 'image/png' } })).status === 400, 5000);
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
    assert.deepEqual(builtin, ['aurora', 'daylight', 'flux', 'horizon']);
    assert.ok(list.packs.some((x) => x.id === meta.id && !x.builtin));
    assert.equal((await s.call('DELETE', '/api/ui-packs/flux')).status, 400);
    assert.equal((await s.call('PUT', '/api/ui-packs/active', { id: 'daylight' })).status, 200);
    assert.equal(await text('/web/login.js'), fs.readFileSync(path.join(REPO, 'examples', 'ui-packs', 'daylight', 'web', 'login.js'), 'utf8'), 'a built-in pack serves its own files');
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
    assert.deepEqual(list.packs.map((x) => x.id), ['aurora', 'daylight', 'flux', 'horizon']);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
