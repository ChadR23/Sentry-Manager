'use strict';

// Runs the Node server and the lean server on the same footage archive and
// compares what the footage routes answer, field for field (and for
// /api/media the status, the range headers and the bytes).
//
//   node lean/parity/compare.js [--archive <dir>] [--keep]
//
// Without --archive it makes one (lean/parity/makeArchive.js) in a temporary
// folder. Needs the lean binary: cargo build --release in lean/.
// Exit 0 when everything matches, 1 with the differences listed.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const LEAN = process.env.LEAN_BIN || path.join(REPO, 'lean', 'target', 'release', 'sentry-lean');
const VID = 'daily-driver';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function start(kind, work, footage, extra = {}, tag = '') {
  const port = await freePort();
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(work, `${kind}${tag}-data`), FOOTAGE_PATH: footage,
    VEHICLE_NAME: 'Daily Driver', TZ: 'UTC', APP_ROOT: REPO, RUN_DIR: path.join(work, `${kind}${tag}-run`), UI_PASSWORD: 'correct horse',
    LOG_LEVEL: 'warn', TLS_MODE: 'off', ...extra
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
  {
    // (both servers have accounts: lean signs in through core as Node does)
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' },
      body: JSON.stringify({ username: 'admin', password: 'correct horse' })
    });
    if (!res.ok) throw new Error(`${kind} sign-in failed: ${res.status} ${log}`);
    cookie = res.headers.get('set-cookie').split(';')[0];
  }
  const get = (p, headers = {}) => fetch(base + p, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
  const json = async (p) => {
    const res = await get(p);
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
  };
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
  };
  const stop = () => new Promise((r) => {
    if (child.exitCode !== null || child.signalCode !== null) return r();
    child.once('exit', r);
    child.kill('SIGTERM');
  });
  return { kind, child, get, json, post, log: () => log, stop };
}

/** Both settled: the scan, the clip codecs and the speed index are done. */
async function settled(s) {
  for (let i = 0; i < 600; i++) {
    const days = (await s.json(`/api/vehicles/${VID}/days?limit=100`)).body;
    const status = (await s.json('/api/speeds/status')).body;
    const unknown = (days.days || []).reduce((n, d) => n + d.unknown, 0);
    if (days.scannedAt && !days.scanning && unknown === 0 && status && !status.running && status.finishedAt) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${s.kind} did not settle:\n${s.log()}`);
}

/** The scan alone is done. */
async function scannedOnly(s) {
  for (let i = 0; i < 600; i++) {
    const days = (await s.json(`/api/vehicles/${VID}/days?limit=100`)).body;
    if (days.scannedAt && !days.scanning) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${s.kind} did not scan:\n${s.log()}`);
}

const diffs = [];
function compare(where, a, b, ignore = new Set()) {
  const t = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);
  if (t(a) !== t(b)) return diffs.push(`${where}: node ${JSON.stringify(a)?.slice(0, 200)} / lean ${JSON.stringify(b)?.slice(0, 200)}`);
  if (t(a) === 'array') {
    if (a.length !== b.length) diffs.push(`${where}: node has ${a.length} items, lean ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) compare(`${where}[${i}]`, a[i], b[i], ignore);
  } else if (t(a) === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (ignore.has(k)) continue;
      if (!(k in a)) diffs.push(`${where}.${k}: only lean has it`);
      else if (!(k in b)) diffs.push(`${where}.${k}: only node has it`);
      else compare(`${where}.${k}`, a[k], b[k], ignore);
    }
  } else if (a !== b) diffs.push(`${where}: node ${JSON.stringify(a)} / lean ${JSON.stringify(b)}`);
  return undefined;
}

// Ties. Recordings that start at the same time are in the order the scan saw their files,
// and a recording is shown by its first front clip seen (the first clip seen without one).
// Node's scan answers its stats in parallel, so now and then that order differs from one scan
// to the next; the lean server always gives the order Node gives when they answer in turn
// (lean/src/scanner.rs), and the strict check below holds it to that. Only in the answers of
// the two servers, and only between genuinely tied items, is another order let through, and
// counted: the same recordings at the same places, a recording shown by another of its own
// clips of the same kind (front, or any when it has none), a day's picture from another
// recording of the same start and kind.
let tolerated = 0;
let orderNote = '';
function untie(a, b, byId) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return;
  const noFront = (x, y) => {
    if (x.frontRel === y.frontRel || x.id !== y.id || typeof x.frontRel !== 'string' || typeof y.frontRel !== 'string') return;
    const front = (x.cameras || []).includes('front');
    const kind = (rel) => !front || /-front\.mp4$/i.test(rel);
    // (an event's files are in the order seen; a drive's clips by time, only one minute's tied)
    const stamp = (rel) => (x.eventId ? '' : path.posix.basename(rel).slice(0, 19));
    if (x.frontRel.startsWith(`${x.folder}/`) && y.frontRel.startsWith(`${x.folder}/`) && kind(x.frontRel) && kind(y.frontRel)
      && stamp(x.frontRel) === stamp(y.frontRel)) {
      y.frontRel = x.frontRel;
      tolerated++;
    }
  };
  if (Array.isArray(a.recordings) && Array.isArray(b.recordings) && a.recordings.length === b.recordings.length) {
    const [x, y] = [a.recordings, b.recordings];
    for (let i = 0; i < x.length;) {
      let j = i + 1;
      while (j < x.length && x[j].startKey === x[i].startKey) j++;
      if (j - i > 1 && y.slice(i, j).every((r) => r.startKey === x[i].startKey)) {
        const ids = x.slice(i, j).map((r) => r.id);
        const run = y.slice(i, j);
        if (run.map((r) => r.id).join() !== ids.join() && [...ids].sort().join() === run.map((r) => r.id).sort().join()) {
          y.splice(i, j - i, ...ids.map((id) => run.find((r) => r.id === id)));
          tolerated++;
        }
      }
      i = j;
    }
    for (let i = 0; i < x.length; i++) noFront(x[i], y[i]);
  }
  if (a.id && a.files) noFront(a, b);
  if (Array.isArray(a.days) && Array.isArray(b.days) && a.days.length === b.days.length) {
    const event = (r) => r.category === 'Sentry' || r.category === 'Saved';
    for (let i = 0; i < a.days.length; i++) {
      const [p, q] = [byId.get(a.days[i].thumbId), byId.get(b.days[i].thumbId)];
      if (p && q && p !== q && p.startKey === q.startKey && p.day === q.day && event(p) === event(q)) {
        b.days[i].thumbId = a.days[i].thumbId;
        tolerated++;
      }
    }
  }
}

/**
 * The order Node's own scan gives most often: server/scanner.js and inventory.js
 * buildRecordings run `runs` times on the archive; the most common list of recordings
 * (key and frontRel each) and how many of the runs gave it.
 */
function nodeMostOften(footage, runs = 40) {
  const script = `
    const { scanFootage } = require(${JSON.stringify(path.join(REPO, 'server', 'scanner.js'))});
    const { buildRecordings } = require(${JSON.stringify(path.join(REPO, 'server', 'inventory.js'))});
    (async () => {
      const seen = new Map();
      for (let i = 0; i < ${runs}; i++) {
        const recs = buildRecordings((await scanFootage(process.argv[1])).files, { vehicleId: ${JSON.stringify(VID)} });
        const k = JSON.stringify(recs.map((r) => [r.key, r.frontRel]));
        seen.set(k, (seen.get(k) || 0) + 1);
      }
      const [order, n] = [...seen].sort((a, b) => b[1] - a[1])[0];
      console.log(JSON.stringify({ order: JSON.parse(order), n, kinds: seen.size }));
    })();`;
  const r = spawnSync(process.execPath, ['-e', script, footage], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

/** Every file and folder under dir with its size and times: the lean server must not change the footage. */
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      // (the Node server's own record of the originals' checksums, server/originalChecksums.js: Node writes it)
      if (name === '.sentrymanager') continue;
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      // (a folder by its name and inode: what is added to or taken from it shows as its entries)
      out.push(st.isDirectory() ? `${path.relative(dir, p)}/ ${st.ino}` : `${path.relative(dir, p)} ${st.size} ${st.mtimeMs} ${st.ctimeMs} ${st.ino}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.join('\n');
}

async function main() {
  if (!fs.existsSync(LEAN)) {
    console.error(`No lean binary at ${LEAN} (cargo build --release in lean/)`);
    process.exit(2);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-parity-'));
  let footage = arg('--archive');
  if (!footage) {
    footage = path.join(work, 'footage');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'makeArchive.js'), footage], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(2);
  }
  const before = snapshot(footage);
  const node = await start('node', work, footage);
  const lean = await start('lean', work, footage);
  let checked = 0;
  try {
    await Promise.all([settled(node), settled(lean)]);
    const both = async (p) => {
      checked++;
      return Promise.all([node.json(p), lean.json(p)]);
    };
    const byId = new Map();
    const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const same = async (p, ignore) => {
      const [a, b] = await both(p);
      if (a.status !== b.status) diffs.push(`${p}: status node ${a.status} / lean ${b.status}`);
      untie(a.body, b.body, byId);
      compare(p, a.body, b.body, ignore);
      return a.body;
    };
    // (every recording first: what a day's picture may be)
    for (const r of (await node.json(`/api/vehicles/${VID}/recordings?limit=500`)).body.recordings || []) byId.set(r.id, r);

    // the vehicle list: the footage parts (shares, savings, car models are other steps)
    {
      const [a, b] = await both('/api/vehicles');
      compare('/api/vehicles footageDays', a.body.footageDays, b.body.footageDays);
      const keys = ['id', 'name', 'timezone', 'source', 'root', 'studioRoot', 'security', 'inventory', 'scanning', 'binBytes', 'binItems', 'policy', 'saved'];
      for (let i = 0; i < a.body.vehicles.length; i++) {
        for (const k of keys) compare(`/api/vehicles .vehicles[${i}].${k}`, a.body.vehicles[i][k], b.body.vehicles[i]?.[k], new Set(['scannedAt']));
      }
    }
    const scanned = new Set(['scannedAt']);
    const base = `/api/vehicles/${VID}`;
    for (const q of ['', '?limit=3&offset=2', '?category=Saved', '?category=all', '?date=2025-03-04', '?from=2025-03-02&to=2025-03-05',
      '?from=bad&to=2025-03-01', '?limit=abc', '?offset=1.5&limit=2.5', '?limit=0', '?limit=1000', '?offset=-4', '?offset=99']) {
      await same(`${base}/days${q}`, scanned);
    }
    const all = await same(`${base}/recordings?limit=500`, scanned);
    for (const q of ['', '?limit=2&offset=1', '?category=Recent', '?date=2025-03-01', '?protected=1', '?from=2025-03-03', '?limit=1e1', '?limit=0x2']) {
      await same(`${base}/recordings${q}`, scanned);
    }
    // ties, strictly: the lean order is the one Node's scan gives most often
    {
      checked++;
      const most = nodeMostOften(footage);
      const leanOrder = (await lean.json(`${base}/recordings?limit=500`)).body.recordings.map((r) => [r.key, r.frontRel]);
      compare(`tie order (Node's most common of 40 scans: ${most.n} of them; ${most.kinds} different)`, most.order, leanOrder);
      orderNote = `; tie order as Node's most common (${most.n} of 40 scans)`;
    }
    for (const rec of all.recordings) await same(`${base}/recordings/${rec.id}`);
    await same(`${base}/recordings/nope`);
    await same('/api/vehicles/nope/days');
    await same('/api/vehicles/nope/recordings/x');
    await same('/api/no-such-route');
    const days = [...new Set(all.recordings.map((r) => r.day)), '2025-03-01', 'bad'];
    for (const d of days) await same(`${base}/speeds?date=${d}`);
    {
      const [a, b] = await both('/api/speeds/status');
      for (const k of ['running', 'done', 'total', 'last', 'limit']) compare(`/api/speeds/status .${k}`, a.body[k], b.body[k]);
    }

    // the viewer area (lean/src/viewer): moments, driving, drives, the maps, places, Studio
    for (const d of days) await same(`${base}/moments?date=${d}`);
    await same(`${base}/driving?weeks=12`);
    await same(`${base}/driving`);
    for (const q of ['', '?gap=1', '?gap=0', '?gap=abc', '?limit=1', '?before=2025-03-03_10-00-00', '?before=bad']) await same(`${base}/drives${q}`);
    await same(`${base}/event-map`);
    await same('/api/vehicles/nope/moments?date=2025-03-01');
    await same('/api/vehicles/nope/drives');
    await same('/api/places');
    await same('/api/places/suggestions');
    for (const q of ['', '?lat=37.7749&lon=-122.4194', '?lat=37.7749&lon=-122.4194&radius=5000', '?lat=91&lon=0', '?lat=x&lon=1']) await same(`/api/places/near${q}`);
    await same('/api/studio/settings');
    await same('/api/settings/work-limits');
    {
      const [a, b] = await both('/api/studio/context');
      compare('/api/studio/context', { ...a.body, outputRoots: a.body.outputRoots?.length }, { ...b.body, outputRoots: b.body.outputRoots?.length }, new Set(['version']));
    }
    const fronts = [];
    for (const rec of all.recordings) for (const f of (await node.json(`${base}/recordings/${rec.id}`)).body.files || []) if (/-front\.mp4$/i.test(f.rel)) fronts.push(f.path);
    for (const p of [...fronts, '/etc/passwd', 'relative.mp4']) await same(`/api/telemetry?path=${encodeURIComponent(p)}`);
    for (const p of [...fronts.slice(0, 2), '/etc/passwd']) {
      checked++;
      const [a, b] = await Promise.all([node.get(`/api/scrub?path=${encodeURIComponent(p)}`), lean.get(`/api/scrub?path=${encodeURIComponent(p)}`)]);
      compare(`scrub ${p}`, [a.status, a.headers.get('content-type')], [b.status, b.headers.get('content-type')]);
      if (a.ok && b.ok && sha(Buffer.from(await a.arrayBuffer())) !== sha(Buffer.from(await b.arrayBuffer()))) diffs.push(`scrub ${p}: the grids differ`);
    }
    {
      const p = fronts[0] || '/nope';
      for (const [route, body] of [['/api/studio/exists', { path: p }], ['/api/studio/exists', { path: '/etc/passwd' }], ['/api/studio/stat', { path: p }], ['/api/studio/stat', {}],
        ['/api/studio/readDir', { path: path.dirname(p) }], ['/api/studio/readDir', { path: '/etc' }], ['/api/studio/readFile', { path: '/etc/passwd' }], ['/api/telemetry/speeds', { paths: [p, '/etc/passwd', 3] }]]) {
        checked++;
        const [a, b] = await Promise.all([node.post(route, body), lean.post(route, body)]);
        compare(`POST ${route} ${JSON.stringify(body)}`, a, b);
      }
    }

    // a saved place, then what names it: the event map, the place tags on recordings, the drives, suggestions
    {
      const noId = new Set(['id']);
      for (const body of [{ name: 'Home', lat: '30.2672', lon: -97.7431, radius: '300' }, { name: '', lat: 1, lon: 1 }, { name: 'X', lat: 91, lon: 0 }, { name: 'X', lat: 1, lon: 1, radius: 10 }]) {
        checked++;
        const [a, b] = await Promise.all([node.post('/api/places', body), lean.post('/api/places', body)]);
        compare(`POST /api/places ${JSON.stringify(body)}`, a, b, noId);
      }
      const ids = await Promise.all([node.json('/api/places'), lean.json('/api/places')]);
      compare('/api/places after one was saved', ids[0], ids[1], noId);
      await same(`${base}/event-map`);
      await same(`${base}/recordings?limit=500`, scanned);
      await same(`${base}/drives`);
      await same('/api/places/suggestions', new Set(['counts']));
    }

    // footage bytes: ranges, refusals
    const root = all.recordings.length ? (await node.json(`${base}/recordings/${all.recordings[0].id}`)).body.root : footage;
    const clip = path.join(root, 'TeslaCam/RecentClips/2025-03-01_08-00-00-front.mp4');
    const media = (p) => `/api/media?path=${encodeURIComponent(p)}`;
    const cases = [
      [clip, {}], [clip, { Range: 'bytes=0-99' }], [clip, { Range: 'bytes=-100' }], [clip, { Range: 'bytes=100-' }],
      [clip, { Range: 'bytes=999999999-' }], [clip, { Range: 'bytes=abc' }], [clip, { Range: 'bytes=5-2' }],
      [clip, { Range: 'bytes=0-10', 'If-Range': '"nope"' }],
      [path.join(root, 'TeslaCam/RecentClips/2025-03-02_23-59-00-front.mp4'), {}],
      [path.join(root, 'TeslaCam/notes.txt'), {}], [path.join(root, 'nope.mp4'), {}], ['/etc/passwd', {}], ['relative.mp4', {}],
      [path.join(root, 'TeslaCam/../../outside.mp4'), {}]
    ];
    const big = path.join(root, 'TeslaCam/RecentClips/2025-03-03_10-01-00-back.mp4');
    cases.push([big, { Range: 'bytes=1000-' }]);
    const view = async (s, p, headers) => {
      const res = await s.get(p, headers);
      const body = Buffer.from(await res.arrayBuffer());
      const h = {};
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'cache-control']) h[k] = res.headers.get(k);
      // (an error's length is how it was sent, chunked or not: not part of the answer)
      if (res.status !== 200 && res.status !== 206) delete h['content-length'];
      return { status: res.status, headers: h, body: res.headers.get('content-type')?.startsWith('application/json') ? body.toString() : sha(body) };
    };
    for (const [file, headers] of cases) {
      checked++;
      const where = `media ${path.relative(root, file) || file} ${JSON.stringify(headers)}`;
      compare(where, await view(node, media(file), headers), await view(lean, media(file), headers));
    }
    // thumbnails: Tesla's thumb.png as it is, else one made from the front clip with ffmpeg
    // (the same bytes from the same ffmpeg; the cached file's ETag is its own on each side)
    const thumbs = async (a, b, label) => {
      for (const rec of [...all.recordings, { id: 'nope' }]) {
        checked++;
        const p = `${base}/recordings/${rec.id}/thumbnail`;
        const [x, y] = [await view(a, p, {}), await view(b, p, {})];
        if (!rec.thumbRel && x.status === 200) {
          made++;
          if (x.headers.etag && y.headers.etag) y.headers.etag = x.headers.etag;
        }
        compare(`${label} ${rec.id} ${rec.key || ''}`, x, y);
      }
    };
    let made = 0;
    await thumbs(node, lean, 'thumbnail');
    if (!made) diffs.push('no thumbnail was made from a clip (is ffmpeg there?)');
    if (!fs.existsSync(path.join(work, 'lean-data', 'thumbnails'))) diffs.push('lean: no thumbnails in DATA_PATH/thumbnails');
    // the stock UI's files, as they are
    for (const p of ['/web/app.js', '/web/shell.css', '/studio/scripts/app.js']) {
      checked++;
      const [a, b] = [await node.get(p), await lean.get(p)];
      if (a.status !== b.status) diffs.push(`${p}: status node ${a.status} / lean ${b.status}`);
      else if (a.ok && sha(Buffer.from(await a.arrayBuffer())) !== sha(Buffer.from(await b.arrayBuffer()))) diffs.push(`${p}: the bytes differ`);
    }
    await Promise.all([node.stop(), lean.stop()]);

    // without ffmpeg: no thumbnail made from a clip, on both (a second pair, scan only)
    const none = { FFMPEG_PATH: path.join(work, 'no-ffmpeg-here') };
    const [n2, l2] = [await start('node', work, footage, none, 'noff'), await start('lean', work, footage, none, 'noff')];
    try {
      await Promise.all([scannedOnly(n2), scannedOnly(l2)]);
      await thumbs(n2, l2, 'thumbnail without ffmpeg');
    } finally {
      await Promise.all([n2.stop(), l2.stop()]);
    }
  } finally {
    await Promise.all([node.stop(), lean.stop()]);
    const after = snapshot(footage);
    if (after !== before) {
      const was = new Set(before.split('\n'));
      const now = new Set(after.split('\n'));
      const changed = [...[...was].filter((l) => !now.has(l)).map((l) => `- ${l}`), ...[...now].filter((l) => !was.has(l)).map((l) => `+ ${l}`)];
      diffs.push(`the footage changed while the servers ran:\n${changed.slice(0, 10).join('\n')}`);
    }
    if (!process.argv.includes('--keep')) fs.rmSync(work, { recursive: true, force: true });
  }
  if (diffs.length) {
    console.log(`${diffs.length} difference(s) in ${checked} requests:\n${diffs.join('\n')}`);
    process.exit(1);
  }
  const ties = tolerated ? ` (${tolerated} tied item(s) in another order: Node's scan order varies)` : '';
  console.log(`${checked} requests: the Node and lean servers answer the same${ties}${orderNote}; the footage is unchanged`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(2);
  });
}

module.exports = { start, settled, LEAN, VID };
