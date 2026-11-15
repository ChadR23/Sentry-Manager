'use strict';

// Runs the Node server and the lean server on the same footage archive and
// the same CAN Bridge logs (lean/parity/canFixtures.js, at the archive's
// drive), with Sentry USB's files on the share, and compares what the CAN and
// Sentry USB routes answer: the Nerd panel's lists, the Viewer's signals,
// clip data and raw view, the searches, the downloads (bytes or rows), the
// upload API while it is off, and the errors.
//
//   node lean/parity/canCompare.js [--keep]
//
// Needs the lean binary (cargo build --release in lean/). Exit 0 when every
// answer matches, 1 with the differences listed.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const LEAN = process.env.LEAN_BIN || path.join(REPO, 'lean', 'target', 'release', 'sentry-lean');
const VID = 'daily-driver';
const T0 = '2025-03-09T08:00:00Z';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function start(kind, work, footage) {
  const port = await freePort();
  const data = path.join(work, `${kind}-data`);
  fs.mkdirSync(data, { recursive: true });
  fs.cpSync(path.join(work, 'fx', 'can'), path.join(data, 'can'), { recursive: true, preserveTimestamps: true });
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: data, FOOTAGE_PATH: footage, VEHICLE_NAME: 'Daily Driver', TZ: 'UTC', APP_ROOT: REPO,
    RUN_DIR: path.join(work, `${kind}-run`), UI_PASSWORD: 'correct horse', LOG_LEVEL: 'warn', TLS_MODE: 'off', CAN_PORT: String(await freePort())
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
  if (kind === 'node') {
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' }, body: JSON.stringify({ username: 'admin', password: 'correct horse' }) });
    if (!res.ok) throw new Error(`Node sign-in failed: ${res.status} ${log}`);
    cookie = res.headers.get('set-cookie').split(';')[0];
  }
  const get = (p, headers = {}) => fetch(base + p, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
  const send = (method, p, body, headers = {}) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body });
  const json = async (p) => {
    const res = await get(p);
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
  };
  return { kind, data, child, get, send, json, log: () => log, stop: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill('SIGTERM'); }) };
}

const diffs = [];
function compare(where, a, b, ignore = new Set()) {
  const t = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);
  if (t(a) !== t(b)) return diffs.push(`${where}: node ${JSON.stringify(a)?.slice(0, 300)} / lean ${JSON.stringify(b)?.slice(0, 300)}`);
  if (t(a) === 'array') {
    if (a.length !== b.length) diffs.push(`${where}: node has ${a.length} items, lean ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) compare(`${where}[${i}]`, a[i], b[i], ignore);
  } else if (t(a) === 'object') {
    const ka = Object.keys(a).filter((k) => !ignore.has(k));
    const kb = Object.keys(b).filter((k) => !ignore.has(k));
    if (ka.join() !== kb.join() && ka.length === kb.length && ka.every((k) => k in b)) diffs.push(`${where}: key order node ${ka.join()} / lean ${kb.join()}`);
    for (const k of new Set([...ka, ...kb])) {
      if (!(k in a)) diffs.push(`${where}.${k}: only lean has it`);
      else if (!(k in b)) diffs.push(`${where}.${k}: only node has it`);
      else compare(`${where}.${k}`, a[k], b[k], ignore);
    }
  } else if (a !== b) diffs.push(`${where}: node ${JSON.stringify(a)?.slice(0, 300)} / lean ${JSON.stringify(b)?.slice(0, 300)}`);
  return undefined;
}

/** Both servers have judged and indexed every log. */
async function settled(s, want) {
  for (let i = 0; i < 900; i++) {
    const st = (await s.json('/api/can/settings')).body;
    if (st?.index && !st.index.running && st.index.indexed + (st.index.lastError ? 0 : 0) >= want && st.trust.every((t) => t.counts.waiting === 0)) return st;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${s.kind} did not index the CAN logs:\n${s.log().slice(-3000)}`);
}

// the server's own times (receivedAt, checkedAt, ...) and per-instance things
const OWN = new Set(['receivedAt', 'lastAt', 'checkedAt', 'firstSeen', 'pinnedAt', 'at', 'now', 'readAt', 'countedAt', 'madeAt', 'since']);

async function main() {
  if (!fs.existsSync(LEAN)) { console.error(`No lean binary at ${LEAN} (cargo build --release in lean/)`); process.exit(2); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-can-'));
  const footage = path.join(work, 'footage');
  if (spawnSync(process.execPath, [path.join(__dirname, 'makeArchive.js'), footage], { stdio: 'inherit' }).status !== 0) process.exit(2);
  if (spawnSync(process.execPath, [path.join(__dirname, 'canFixtures.js'), path.join(work, 'fx')], { stdio: 'inherit', env: { ...process.env, CAN_T0: T0 } }).status !== 0) process.exit(2);
  // Sentry USB's files at the share root (the folder holding RecentClips/)
  const share = fs.existsSync(path.join(footage, 'TeslaCam')) ? path.join(footage, 'TeslaCam') : footage;
  const su = path.join(share, '.sentryusb');
  fs.mkdirSync(su, { recursive: true });
  const nowS = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(su, 'archive-status.json'), JSON.stringify({
    schema: 1, device: 'sentryusb-pi', written_unix: nowS - 600, state: 'idle', auto_delete_enabled: true,
    archive: { result: 'failed', started_unix: 1741507200, finished_unix: 1741507500, files_archived: 120, files_not_archived: 3, last_clip: 'RecentClips/2025-03-09_08-02-00-front.mp4' },
    verification: { enabled: true, ran: true, matched: 117, converted: 2, resending: 1, still_queued: 0 },
    snapshot_interval_s: 3480, snapshots: [{ name: 'snap-1', started_unix: 1741500000 }, { name: 'snap-2', started_unix: 1741503480 }, { started_unix: 1741520000 }, { name: 'bad name!', started_unix: 1741530000 }]
  }));
  fs.writeFileSync(path.join(su, 'device-status.json'), JSON.stringify({
    schema: 1, written_unix: nowS - 60, version: 'v3.28.10-test.35\u0001', storage: { total_bytes: 256060514304, used_bytes: 98100000000, free_bytes: 157960514304 },
    drives: [{ name: 'cam', size_bytes: 64424509440 }, { name: 'music', size_bytes: 4294967296 }, { name: 'cam', size_bytes: 1 }, { name: 'x', size_bytes: 2 }], cpu_temp_c: 51.24,
    car: { battery: { pct: 89.04, charging: false, at: nowS - 100 }, interior: { c: 9.4 }, exterior: { c: 99 }, tires: { fl: { kpa: 290.3, at: nowS - 7200 }, fr: { kpa: -1 }, state: 'optimal' }, drive: { state: 'parked', since: nowS - 9000 }, units: { temp: 'C' } }
  }));
  fs.writeFileSync(path.join(su, 'car-files.tsv'), '# first_seen_unix\tpath\tsize\tmtime_unix\n1741507200\tRecentClips/2025-03-09_08-00-00-front.mp4\t30000000\t1741507100\nbad\n');

  const node = await start('node', work, footage);
  const lean = await start('lean', work, footage);
  let checked = 0;
  try {
    const want = 10;
    const [sa, sb] = await Promise.all([settled(node, want), settled(lean, want)]);
    checked++;
    compare('/api/can/settings', sa, sb, new Set([...OWN, 'port']));
    const same = async (p, ignore = OWN) => {
      checked++;
      const [a, b] = await Promise.all([node.json(p), lean.json(p)]);
      if (a.status !== b.status) diffs.push(`${p}: status node ${a.status} / lean ${b.status} (${JSON.stringify(b.body).slice(0, 200)})`);
      compare(p, a.body, b.body, ignore);
      return a.body;
    };
    const bytes = async (p, how = 'sha') => {
      checked++;
      const [a, b] = await Promise.all([node.get(p, { 'Accept-Encoding': 'identity' }), lean.get(p, { 'Accept-Encoding': 'identity' })]);
      if (a.status !== b.status) diffs.push(`${p}: status node ${a.status} / lean ${b.status}`);
      for (const h of ['content-type', 'content-disposition', 'content-length']) if (a.headers.get(h) !== b.headers.get(h) && !(h === 'content-length' && a.status !== 200)) diffs.push(`${p}: ${h} node ${a.headers.get(h)} / lean ${b.headers.get(h)}`);
      const [x, y] = [Buffer.from(await a.arrayBuffer()), Buffer.from(await b.arrayBuffer())];
      if (how === 'sha' && !x.equals(y)) diffs.push(`${p}: the bytes differ (${x.length} / ${y.length}): ${x.toString().slice(0, 120)} / ${y.toString().slice(0, 120)}`);
      return [x, y];
    };

    const files = await same('/api/can/files?limit=500');
    await same('/api/can/files?limit=2');
    await same('/api/can/files?limit=-3');
    const root = (await node.json(`/api/vehicles/${VID}`)).body?.root || (await node.json('/api/vehicles')).body.vehicles[0].root;
    const clip = (n) => encodeURIComponent(path.join(root, n));
    for (const c of ['TeslaCam/RecentClips/2025-03-09_08-00-00-front.mp4', 'TeslaCam/RecentClips/2025-03-09_08-01-00-front.mp4', 'TeslaCam/RecentClips/2025-03-09_08-02-00-front.mp4', 'TeslaCam/RecentClips/2025-03-01_08-00-00-front.mp4']) {
      await same(`/api/can/signals?path=${clip(c)}`);
      await same(`/api/can/clip?path=${clip(c)}&signals=DI_vehicleSpeed,IBST_driverBrakeApply,GPSLatitude04F`);
      await same(`/api/can/clip?path=${clip(c)}&signals=*`);
      await same(`/api/can/clip?path=${clip(c)}&signals=*&cols=1&step=500`);
      await same(`/api/can/raw?path=${clip(c)}`);
      await same(`/api/can/raw?path=${clip(c)}&from=1000&to=5000`);
      await same(`/api/can/raw?path=${clip(c)}&probe=1`);
    }
    await same('/api/can/signals?path=/etc/passwd');
    await same(`/api/can/clip?path=${clip('TeslaCam/notes.txt')}&signals=x`);
    await same(`/api/can/vehicle-signals?vehicle=${VID}`);
    await same('/api/can/vehicle-signals?vehicle=nope');
    for (const qy of ['signal=DI_vehicleSpeed&op=>&value=50', 'signal=DI_vehicleSpeed&op=changed&limit=5', 'signal=DI_gear&op==&value=4&all=1', 'signal=IBST_driverBrakeApply&op=appeared',
      'signal=DI_vehicleSpeed&op=<=&value=40&from=2025-03-09T08:01&to=2025-03-09', 'signal=x&op=~&value=1', 'signal=DI_vehicleSpeed&op=>', 'signal=DI_vehicleSpeed&op=>&value=abc', 'signal=DI_vehicleSpeed&op=>&value=1&from=2025-02-30',
      'signal=DI_vehicleSpeed&op=>&value=1&from=1741507200000', 'signal=DI_vehicleSpeed&op=>&value=1&from=2025-03-09T08:01:00%2B01:00', 'resume=nope']) {
      await same(`/api/can/search?vehicle=${VID}&${qy}`);
    }
    for (const qy of ['', 'gap=2', 'before=2025-03-09T08:03', 'id=can0:6E3', 'id=0x6E4', 'id=6E3&gap=1', 'from=bad']) await same(`/api/can/id-events?vehicle=${VID}&${qy}`);
    for (const k of ['CAR1', 'K2', 'LEGACY', 'nope!']) {
      await same(`/api/can/export/new-ids?key=${k}&since=2025-03-09`);
      await bytes(`/api/can/export/new-ids?key=${k}&since=2025-03-09T08:02&format=csv`);
      await same(`/api/can/export/bundle?key=${k}&from=2025-03-09&to=2025-03-09&check=1`);
      await same(`/api/can/export/bundle?key=${k}&from=2025-03-09T08:01&to=2025-03-09T08:03&check=1&candump=1`);
      await same(`/api/can/export/decoded?key=${k}&from=2025-03-09T08:00&to=2025-03-09T08:10&check=1`);
      await same(`/api/can/export/decoded?key=${k}&from=2025-03-09T08:00&to=2025-03-09T08:10&signals=DI_vehicleSpeed,calc.batteryPower&check=1`);
      await bytes(`/api/can/export/decoded?key=${k}&from=2025-03-09T08:00&to=2025-03-09T08:10`);
      await bytes(`/api/can/export/decoded?key=${k}&from=2025-03-09T08:00&to=2025-03-09T08:10&signals=DI_vehicleSpeed,calc.batteryPower,calc.lv12State,SteeringAngle129`);
      await bytes(`/api/can/export/decoded?key=${k}&from=2025-03-09T08:00&to=2025-03-09T08:03&mode=every`);
    }
    await same('/api/can/export/decoded?key=CAR1&from=2025-03-01&to=2025-03-09');
    await same('/api/can/export/bundle?key=CAR1&from=2025-03-09&check=1');
    await same('/api/can/export/bundle?key=CAR1&to=2025-03-01&from=2025-03-02&check=1');
    await same('/api/can/export/new-ids?key=CAR1');
    // a bundle: the same files in it (unzip -l), and the logs' bytes
    {
      const [x, y] = await bytes('/api/can/export/bundle?key=CAR1&from=2025-03-09T08:00&to=2025-03-09T08:02&candump=1', 'none');
      const list = (buf, tag) => { const f = path.join(work, `${tag}.zip`); fs.writeFileSync(f, buf); return spawnSync('unzip', ['-Z1', f]).stdout?.toString() || ''; };
      if (list(x, 'n') !== list(y, 'l')) diffs.push(`bundle: other files: ${list(x, 'n')} / ${list(y, 'l')}`);
      const one = (buf, tag, name) => spawnSync('unzip', ['-p', path.join(work, `${tag}.zip`), name]).stdout;
      for (const name of list(x, 'n').split('\n').filter(Boolean)) {
        if (name === 'manifest.json') continue;
        const [p, q] = [one(x, 'n', name), one(y, 'l', name)];
        if (!p.equals(q)) diffs.push(`bundle ${name}: the bytes differ`);
      }
      const mf = (tag) => { const m = JSON.parse(one(null, tag, 'manifest.json')); delete m.madeAt; return m; };
      compare('bundle manifest.json', mf('n'), mf('l'));
    }
    for (const f of files.logs) {
      await bytes(`/api/can/files/${encodeURIComponent(f.name)}/download`);
      await bytes(`/api/can/files/${encodeURIComponent(`${f.name}.json`)}/download`);
      await bytes(`/api/can/files/${encodeURIComponent(f.name)}/candump`);
    }
    await bytes('/api/can/files/nope/download');
    await bytes('/api/can/files/K_20261108T143000Z_1.log.xz.json/candump');
    // the upload API while uploads are off; and the device files
    await same('/api/can/logs/ping');
    await same(`/api/vehicles/${VID}/sentry-usb`, new Set([...OWN, 'record', 'readAt']));
    await same('/api/vehicles/nope/sentry-usb');
    await same('/api/sentryusb', new Set([...OWN]));
    // writes: the same changes give the same answers
    const both = async (method, p, body) => {
      checked++;
      const [a, b] = await Promise.all([node.send(method, p, body === undefined ? undefined : JSON.stringify(body)), lean.send(method, p, body === undefined ? undefined : JSON.stringify(body))]);
      const [x, y] = [await a.text(), await b.text()];
      let [u, v] = [x, y];
      try { u = JSON.parse(x); v = JSON.parse(y); } catch { /* text */ }
      if (a.status !== b.status) diffs.push(`${method} ${p}: status node ${a.status} / lean ${b.status} (${y.slice(0, 200)})`);
      return [u, v];
    };
    for (const [m, p, body] of [
      ['POST', '/api/can/keep', { unlinkedDays: 400 }], ['POST', '/api/can/keep', {}], ['POST', '/api/can/viewer-car-data', { enabled: 'yes' }],
      ['POST', '/api/can/vehicle-map', { key: 'bad key' }], ['POST', '/api/can/pairing/CAR1/could-not-sign', {}], ['POST', '/api/can/files/nope/use', {}],
      ['DELETE', '/api/can/files/CAR1_20990101T000000Z_1.log.xz'], ['DELETE', '/api/can/tokens/nope'], ['POST', `/api/vehicles/${VID}/sentry-usb/record`, { older: 1 }]
    ]) {
      const [u, v] = await both(m, p, body);
      compare(`${m} ${p}`, u, v, OWN);
    }
  } finally {
    await Promise.all([node.stop(), lean.stop()]);
    if (!process.argv.includes('--keep')) fs.rmSync(work, { recursive: true, force: true });
    else console.log(`kept ${work}`);
  }
  console.log(`${checked} requests, ${diffs.length} differences`);
  for (const d of diffs.slice(0, 200)) console.log(`  ${d}`);
  process.exit(diffs.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
