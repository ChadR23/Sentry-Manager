'use strict';

// Same answers for the footage area's writing routes: the Recycle Bin,
// protect, Move to trash, Delete this day, cleanup policies, stars, the
// footage check and the vehicle settings. Each server gets its own copy of
// the parity archive (lean/parity/makeArchive.js), since these routes move
// files; the same requests go to both, one after the other, and every
// answer is compared after the per-server parts are normalised: the footage
// folder, the Recycle Bin item and star ids (random), and the server's own
// times.
//
//   node lean/parity/compareFootage.js [--keep]
//
// Needs the lean binary (cargo build --release in lean/). Exit 0 when every
// answer matches, 1 with the differences listed.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const LEAN = process.env.LEAN_BIN || path.join(REPO, 'lean', 'target', 'release', 'sentry-lean');
const VID = 'daily-driver';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function start(kind, work, footage) {
  const port = await freePort();
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(work, `${kind}-data`), FOOTAGE_PATH: footage,
    VEHICLE_NAME: 'Daily Driver', TZ: 'UTC', APP_ROOT: REPO, RUN_DIR: path.join(work, `${kind}-run`), UI_PASSWORD: 'correct horse',
    LOG_LEVEL: 'warn', TLS_MODE: 'off', FOOTAGE_ROOT: path.join(work, 'mounts')
  };
  const child = kind === 'node'
    ? spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(REPO, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(LEAN, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { 'X-Requested-With': 'sentry-six-manager' } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, body: data, type: res.headers.get('content-type') };
  };
  if (kind === 'node') {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' },
      body: JSON.stringify({ username: 'admin', password: 'correct horse' })
    });
    if (!res.ok) throw new Error(`Node sign-in failed: ${res.status} ${log}`);
    cookie = res.headers.get('set-cookie').split(';')[0];
  }
  const stop = () => new Promise((r) => {
    if (child.exitCode !== null || child.signalCode !== null) return r();
    child.once('exit', r);
    child.kill('SIGTERM');
  });
  return { kind, call, footage, log: () => log, stop, ids: new Map() };
}

/** The scan is done (and not running again). */
async function scanned(s) {
  for (let i = 0; i < 600; i++) {
    const days = (await s.call('GET', `/api/vehicles/${VID}/days?limit=100`)).body;
    if (days.scannedAt && !days.scanning) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${s.kind} did not scan:\n${s.log()}`);
}

const TIME_KEYS = /^(trashedAt|createdAt|lastRunAt|startedAt|finishedAt|checkedAt|writeCheckedAt|mountedAt|scannedAt|jobId|freeBytes|totalBytes|free|total|ms)$/;

/** The per-server parts out: its folder, its random ids (in the order first seen), its own times. */
function norm(s, v, key = null) {
  if (v === null || v === undefined) return v;
  if (key && TIME_KEYS.test(key) && (typeof v === 'number' || typeof v === 'string')) return '<time>';
  if (typeof v === 'string') {
    let out = v.split(s.footage).join('{root}');
    out = out.replace(/\b[a-z0-9]{6,10}-[a-f0-9]{8}\b/g, (id) => {
      if (!s.ids.has(id)) s.ids.set(id, `item${s.ids.size}`);
      return s.ids.get(id);
    });
    out = out.replace(/^[a-f0-9]{12}$/, (id) => {
      if (!s.ids.has(id)) s.ids.set(id, `star${s.ids.size}`);
      return s.ids.get(id);
    });
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => norm(s, x));
  // (the speed index is not this area's: lean/parity/compare.js compares it once both are done)
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'speedIndex').map(([k, x]) => [k, norm(s, x, k)]));
  return v;
}

const diffs = [];
function compare(where, a, b) {
  const t = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);
  if (t(a) !== t(b)) return diffs.push(`${where}: node ${JSON.stringify(a)?.slice(0, 300)} / lean ${JSON.stringify(b)?.slice(0, 300)}`);
  if (t(a) === 'array') {
    if (a.length !== b.length) diffs.push(`${where}: node has ${a.length} items, lean ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) compare(`${where}[${i}]`, a[i], b[i]);
  } else if (t(a) === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.join() !== kb.join() && ka.length === kb.length && ka.every((k) => k in b)) diffs.push(`${where}: keys in another order: node ${ka.join(',')} / lean ${kb.join(',')}`);
    for (const k of new Set([...ka, ...kb])) {
      if (!(k in a)) diffs.push(`${where}.${k}: only lean has it`);
      else if (!(k in b)) diffs.push(`${where}.${k}: only node has it`);
      else compare(`${where}.${k}`, a[k], b[k]);
    }
  } else if (a !== b) diffs.push(`${where}: node ${JSON.stringify(a)} / lean ${JSON.stringify(b)}`);
  return undefined;
}

async function main() {
  if (!fs.existsSync(LEAN)) {
    console.error(`No lean binary at ${LEAN} (cargo build --release in lean/)`);
    process.exit(2);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-footage-'));
  fs.mkdirSync(path.join(work, 'mounts'));
  const made = path.join(work, 'archive');
  if (spawnSync(process.execPath, [path.join(__dirname, 'makeArchive.js'), made], { stdio: 'inherit' }).status !== 0) process.exit(2);
  // a copy each, with the same times (cp -a)
  for (const kind of ['node', 'lean']) {
    if (spawnSync('cp', ['-a', made, path.join(work, `footage-${kind}`)]).status !== 0) process.exit(2);
    // (without the recordings that start at the same time: their order is the Node scan's
    // most common one only, lean/parity/compare.js checks it; here it would make noise)
    for (const tie of ['SentryClips/2025-02-20_10-05-00', 'SentryClips/2025-02-20_10-02-00', 'SentryClips/2025-02-20_10-09-00', 'SentryClips/2025-02-20_10-01-00',
      'SavedClips/2025-02-20_10-03-00', 'SavedClips/2025-02-22_10-00-00', 'Other/2025-02-22_10-00-00-front.mp4', 'RecentClips/2025-02-22']) {
      fs.rmSync(path.join(work, `footage-${kind}`, 'TeslaCam', tie), { recursive: true, force: true });
    }
  }
  const node = await start('node', work, path.join(work, 'footage-node'));
  const lean = await start('lean', work, path.join(work, 'footage-lean'));
  const servers = [node, lean];
  let checked = 0;
  const both = async (label, method, p, body, after = null) => {
    checked++;
    const out = [];
    for (const s of servers) {
      const r = await s.call(method, typeof p === 'function' ? await p(s) : p, typeof body === 'function' ? await body(s) : body);
      if (after) await after(s);
      out.push(r);
    }
    const [a, b] = out;
    // (bin items moved in the same millisecond have no order of their own: by label)
    for (const r of out) if (Array.isArray(r.body?.items)) r.body.items.sort((x, y) => `${x.label}|${x.startAt}`.localeCompare(`${y.label}|${y.startAt}`));
    if (a.status !== b.status) diffs.push(`${label}: status node ${a.status} / lean ${b.status} (${JSON.stringify(a.body).slice(0, 200)} / ${JSON.stringify(b.body).slice(0, 200)})`);
    compare(label, norm(node, a.body), norm(lean, b.body));
    return out;
  };
  // the recording ids are the same on both (they come from the vehicle and the paths)
  const recs = async () => (await node.call('GET', `/api/vehicles/${VID}/recordings?limit=500`)).body.recordings;
  const settle = async () => Promise.all(servers.map(scanned));
  const items = async (s) => (await s.call('GET', '/api/bin')).body.items;
  try {
    await settle();
    const base = `/api/vehicles/${VID}`;
    await both('GET /api/vehicles', 'GET', '/api/vehicles');
    await both('GET /api/bin (empty)', 'GET', '/api/bin');
    await both('GET policy', 'GET', `${base}/policy`);
    await both('GET stars', 'GET', '/api/stars');
    await both('GET integrity (none yet)', 'GET', `${base}/integrity`);
    for (const p of ['/api/vehicles/nope/policy', '/api/vehicles/nope/integrity']) await both(`GET ${p}`, 'GET', p);

    const all = await recs();
    const byStart = (start, cat) => all.find((r) => r.start === start && (!cat || r.category === cat))?.id;
    const drive = byStart('2025-03-09 08:00:00', 'Recent');
    const event = all.find((r) => r.category === 'Sentry' && r.eventId === '2025-03-04_12-30-00')?.id;
    const saved = all.find((r) => r.category === 'Saved' && r.eventId === '2025-03-05_09-00-00')?.id;
    const other = all.find((r) => r.category === 'Other')?.id;
    if (!drive || !event || !saved || !other) throw new Error(`the archive has not the recordings this needs: ${JSON.stringify(all.map((r) => [r.start, r.category, r.eventId]))}`);

    // protect, then Move to trash: the protected one stays
    await both('protect', 'POST', `${base}/protect`, { ids: [drive, 'nope', drive] });
    await both('recordings?protected=1', 'GET', `${base}/recordings?protected=1`);
    await both('days after protect', 'GET', `${base}/days`);
    await both('trash-preview', 'POST', `${base}/trash-preview`, { ids: [drive, event, 'x'] });
    await both('trash (one protected)', 'POST', `${base}/trash`, { ids: [drive, event, saved, 5] });
    await both('bin after trash', 'GET', '/api/bin');
    await both(`bin of ${VID}`, 'GET', `/api/bin?vehicle=${VID}`);
    await both('bin of nobody', 'GET', '/api/bin?vehicle=nope');
    await both('recordings after trash', 'GET', `${base}/recordings?limit=500`);
    await both('vehicles after trash', 'GET', '/api/vehicles');
    await both('bin thumbnail (the event: thumb.png)', 'GET', async (s) => `/api/bin/${(await items(s)).find((i) => i.category === 'Sentry').id}/thumbnail`);
    await both('bin thumbnail of nothing', 'GET', '/api/bin/nope/thumbnail');

    // restore the event; a full scan follows
    await both('restore the event', 'POST', async (s) => `/api/bin/${(await items(s)).find((i) => i.category === 'Sentry').id}/restore`, {}, scanned);
    await both('restore of nothing', 'POST', '/api/bin/nope/restore', {});
    await both('bin after restore', 'GET', '/api/bin');
    await both('recordings after restore', 'GET', `${base}/recordings?limit=500`);

    // Delete this day / through this date
    await both('trash-days bad day', 'POST', `${base}/trash-days`, { day: '2025-3-1' });
    await both('trash-days preview', 'POST', `${base}/trash-days`, { day: '2025-03-01', through: true, preview: true });
    await both('trash-days preview Saved', 'POST', `${base}/trash-days`, { day: '2025-03-06', category: 'Saved', preview: true });
    await both('trash-days nothing', 'POST', `${base}/trash-days`, { day: '1999-01-01' });
    await both('trash-days', 'POST', `${base}/trash-days`, { day: '2025-02-21' }, async (s) => {
      const moved = async () => { const l = await items(s); return l.length >= 2 && !l.some((i) => i.files.some((f) => f.pending)); };
      for (let i = 0; i < 100 && !(await moved()); i++) await new Promise((r) => setTimeout(r, 50));
    });
    await both('bin after trash-days', 'GET', '/api/bin');

    // delete for good and empty
    await both('delete without confirm', 'POST', async (s) => `/api/bin/${(await items(s))[0].id}/delete`, {});
    await both('delete', 'POST', async (s) => `/api/bin/${(await items(s)).find((i) => i.category === 'Saved').id}/delete`, { confirm: true });
    await both('delete of nothing', 'POST', '/api/bin/nope/delete', { confirm: true });
    await both('empty without confirm', 'POST', '/api/bin/empty', {});
    await both('empty of nobody', 'POST', '/api/bin/empty', { confirm: true, vehicle: 'nope' });
    await both('empty', 'POST', '/api/bin/empty', { confirm: true, vehicle: VID });
    await both('bin after empty', 'GET', '/api/bin');

    // cleanup policies
    for (const body of [{ runAt: '25:00' }, { keepDays: { Recent: 0 } }, { keepDays: { Sentry: 'x' } }, { binDays: 400 }, { maxGB: 0.5 }, { maxGB: 'lots' }]) {
      await both(`policy refused ${JSON.stringify(body)}`, 'PUT', `${base}/policy`, body);
    }
    await both('policy nope', 'PUT', '/api/vehicles/nope/policy', {});
    await both('policy set', 'PUT', `${base}/policy`, { enabled: true, runAt: '23:59', keepDays: { Recent: '30', Other: 10, Saved: '' }, binDays: 7, maxGB: '12.34' });
    await both('policy set size', 'PUT', `${base}/policy`, { maxGB: 0.0001 + 1 });
    await both('policy get', 'GET', `${base}/policy`);
    await both('policy run, another rule confirmed', 'POST', `${base}/policy/run`, { expect: { keepDays: { Recent: 31 } } });
    await both('policy run', 'POST', `${base}/policy/run`, { expect: { keepDays: { Recent: 30, Other: 10 }, binDays: 7, maxGB: 1 } }, scanned);
    await both('policy after run', 'GET', `${base}/policy`);
    await both('bin after policy', 'GET', '/api/bin');
    await both('recordings after policy', 'GET', `${base}/recordings?limit=500`);
    await both('vehicles after policy', 'GET', '/api/vehicles');

    // stars
    const left = await recs();
    const clip = left[left.length - 1]?.startKey;
    for (const body of [{}, { vehicle: 'nope', clip, second: 1 }, { vehicle: VID, clip: 'x', second: 1 }, { vehicle: VID, clip, second: -1 }, { vehicle: VID, clip, second: 8000 }]) {
      await both(`star refused ${JSON.stringify(body)}`, 'POST', '/api/stars', body);
    }
    await both('star', 'POST', '/api/stars', { vehicle: VID, clip, second: 12.9, note: ' a\tnote\n' });
    await both('star again', 'POST', '/api/stars', { vehicle: VID, clip, second: 40 });
    await both('star of no recording', 'POST', '/api/stars', { vehicle: VID, clip: '2001-01-01_00-00-00', second: 0 });
    await both('stars', 'GET', '/api/stars');
    await both(`stars of ${VID}`, 'GET', `/api/stars?vehicle=${VID}`);
    await both('recordings with stars', 'GET', `${base}/recordings?protected=1`);
    const starIds = async (s) => (await s.call('GET', '/api/stars')).body.stars.map((x) => x.id);
    await both('star note', 'PATCH', async (s) => `/api/stars/${(await starIds(s))[0]}`, { note: 'x'.repeat(300) });
    await both('star note of nothing', 'PATCH', '/api/stars/nope', {});
    for (let i = 0; i < 3; i++) await both(`unstar ${i}`, 'DELETE', async (s) => `/api/stars/${(await starIds(s))[0]}`);
    await both('unstar nothing', 'DELETE', '/api/stars/nope');
    await both('recordings after unstar', 'GET', `${base}/recordings?protected=1`);

    // the footage check
    await both('integrity start', 'POST', `${base}/integrity`, {}, async (s) => {
      for (let i = 0; i < 200 && (await s.call('GET', `${base}/integrity`)).body.running; i++) await new Promise((r) => setTimeout(r, 50));
    });
    await both('integrity', 'GET', `${base}/integrity`);

    // vehicle settings
    for (const body of [
      { name: 'Bad', source: { type: 'path', path: '/' } }, { name: 'Bad', source: { type: 'path', path: '/etc' } },
      { name: 'Bad', source: { type: 'path', path: 'relative' } }, { name: '  ', source: { type: 'path', path: '/tmp' } },
      { name: 'Bad', timezone: 'Mars/Base', source: { type: 'path', path: '/tmp' } },
      { name: 'Bad', source: { share: 'nas', username: 'u', password: 'p' } }, { name: 'Bad', source: { share: '//nas/cam', password: 'p' } },
      { name: 'Bad', source: { share: '//nas/cam', username: 'a b', password: 'p' } }, { name: 'Bad', source: { share: '//nas/cam', username: 'u' } },
      { name: 'Bad', source: { share: '//nas/cam', username: 'u', password: 'p', version: '2.1' } },
      { name: 'Bad', source: { share: '//nas/cam', username: 'u', password: 'p', port: 70000 } },
      { name: 'Bad', source: { share: '//nas/cam', username: 'u', password: 'p', domain: '-x' } }
    ]) await both(`vehicle refused ${JSON.stringify(body)}`, 'POST', '/api/vehicles', body);
    await both('vehicle overlapping', 'POST', '/api/vehicles', (s) => ({ name: 'Twin', source: { type: 'path', path: path.join(s.footage, 'TeslaCam') } }));
    await both('rename', 'PUT', `${base}`, { name: '  Daily  Driver 2 ', timezone: 'Europe/Berlin', car: { model: 'S', generation: 'S-2015' } });
    await both('rename refused', 'PUT', `${base}`, { timezone: 'nope' });
    await both('rename of nobody', 'PUT', '/api/vehicles/nope', {});
    await both('vehicles after rename', 'GET', '/api/vehicles');
    await both('test-smb details', 'POST', '/api/vehicles/test-smb', { source: { share: '//nas/cam', username: 'u' } });
    await both('test-smb of nobody', 'POST', '/api/vehicles/test-smb', { vehicleId: 'nope', source: {} });
    await both('reconnect of nobody', 'POST', '/api/vehicles/nope/reconnect', {});
    await both('scan of nobody', 'POST', '/api/vehicles/nope/scan', {});
    await both('remove nobody', 'DELETE', '/api/vehicles/nope');
    await both('a second folder vehicle', 'POST', '/api/vehicles', (s) => ({ name: 'Second car', source: { type: 'path', path: `${s.footage}-second` } }), async (s) => {
      fs.mkdirSync(`${s.footage}-second`, { recursive: true });
    });
    await both('remove it', 'DELETE', '/api/vehicles/second-car');
    await both('vehicles at the end', 'GET', '/api/vehicles');
  } catch (err) {
    for (const s of servers) console.error(`--- ${s.kind} log:\n${s.log().slice(-3000)}`);
    throw err;
  } finally {
    await Promise.all(servers.map((s) => s.stop()));
    if (!process.argv.includes('--keep')) fs.rmSync(work, { recursive: true, force: true });
    else console.log(`kept ${work}`);
  }
  if (diffs.length) {
    console.log(`${diffs.length} difference(s) in ${checked} requests:\n${diffs.join('\n')}`);
    process.exit(1);
  }
  console.log(`${checked} requests: the Node and lean servers answer the footage area's writing routes the same`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(2);
});
