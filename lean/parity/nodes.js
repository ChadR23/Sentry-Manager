'use strict';

// Helper servers, Node against Rust (lean/src/nodes/tests.rs runs these):
//
//   node lean/parity/nodes.js worker <dir> <tls dir>
//       Node's node worker (server/nodeWorker.js) on HTTPS with <tls dir>'s
//       server.crt / server.key / ca.crt, a pairing code shown; prints
//       { port, code } and serves until stdin closes. The Rust main pairs
//       with it and encodes there.
//   node lean/parity/nodes.js compare <dir> <tls dir> <rust port> <rust code> <clip>
//       Starts Node's worker too, then sends both workers the same requests
//       (pairing refusals, pairing by Node's main, tokens, info, slots, jobs,
//       a real encode, its output, deletes, the throttle) and compares the
//       answers; Node's main (server/nodes.js) also encodes on the Rust
//       worker. Prints { main, count, differences }.
//
// Both workers run software encoders (libx265, libsvtav1) and list no
// devices, as test/nodes.test.js's startWorker.

const fs = require('fs');
const path = require('path');
const http2 = require('http2');
const https = require('https');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const { createNodeWorker, hmac, pairText } = require(path.join(REPO, 'server', 'nodeWorker'));
const { createNodes } = require(path.join(REPO, 'server', 'nodes'));

const quiet = { info() {}, warn() {}, error() {} };
const memDb = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? structuredClone(m.get(k)) : f), set: (k, v) => m.set(k, structuredClone(v)) };
};
const runtime = {
  selectEncoder: async (family) => ({ codec: family === 'h265' ? 'libx265' : 'libsvtav1', hardware: false }),
  cpuEncoder: async (family) => ({ codec: family === 'h265' ? 'libx265' : 'libsvtav1', hardware: false })
};

async function startWorker(dir, tlsDir, name) {
  const material = { key: fs.readFileSync(path.join(tlsDir, 'server.key')), cert: fs.readFileSync(path.join(tlsDir, 'server.crt')), ca: fs.readFileSync(path.join(tlsDir, 'ca.crt'), 'utf8') };
  const db = memDb();
  const worker = createNodeWorker({ db, log: quiet, audit: quiet, authority: () => material.ca, workDir: path.join(dir, 'node-work'), runtime: () => runtime, name });
  const server = http2.createSecureServer({ key: material.key, cert: material.cert, allowHTTP1: true }, async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (!(await worker.handle(req, res, p, '127.0.0.1'))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { worker, server, db, port: server.address().port };
}

function call(port, { method = 'GET', path: p, token = null, headers = {}, body = null, chunked = false }) {
  return new Promise((resolve) => {
    const h = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers };
    if (body !== null && !chunked) h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ host: '127.0.0.1', port, path: p, method, rejectUnauthorized: false, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(data.toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, type: res.headers['content-type'] || null, length: Number(res.headers['content-length'] ?? -1), json, bytes: data.length });
      });
    });
    req.on('error', (err) => resolve({ status: 0, error: err.code || err.message }));
    if (body !== null && chunked) { req.write(body); req.end(); } else req.end(body === null ? undefined : body);
  });
}

// what is the moment's, not the server's: ids, numbers that move
function normal(v) {
  if (typeof v === 'string') return /^[0-9a-f]{32}$/.test(v) ? '<id>' : v;
  if (Array.isArray(v)) return v.map(normal);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = ['outTimeUs', 'fps', 'speed', 'outputBytes', 'pairedAt', 'lastSeenAt', 'at'].includes(k) ? (x === null ? null : typeof x) : normal(x);
    }
    return out;
  }
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function script(port, code, clip, dir, label) {
  const out = [];
  const note = (name, r, extra = {}) => out.push({ name, status: r.status, type: r.type, json: normal(r.json), ...extra });
  const json = { 'Content-Type': 'application/json' };
  note('pair GET', await call(port, { path: '/node/v1/pair' }));
  note('pair bad JSON', await call(port, { method: 'POST', path: '/node/v1/pair', headers: json, body: 'not json' }));
  note('pair too large', await call(port, { method: 'POST', path: '/node/v1/pair', headers: json, body: JSON.stringify({ name: 'x'.repeat(5000) }) }));
  note('pair empty', await call(port, { method: 'POST', path: '/node/v1/pair', headers: json, body: '{}' }));
  note('pair no proof', await call(port, { method: 'POST', path: '/node/v1/pair', headers: json, body: JSON.stringify({ name: 'm', proof: 5 }) }));
  note('pair wrong', await call(port, { method: 'POST', path: '/node/v1/pair', headers: json, body: JSON.stringify({ name: 'm', proof: hmac('AAAABBBBCCCC', pairText.main('00'.repeat(32), 'm')) }) }));
  // Node's main pairs
  const db = memDb();
  const nodes = createNodes({ db, log: quiet, audit: quiet, name: 'main-nas', pollMs: 100 });
  const main = {};
  let node;
  try {
    node = await nodes.add({ address: `127.0.0.1:${port}`, code });
  } catch (err) {
    return { out, main: { error: err.message } };
  }
  main.paired = /^[a-z0-9]{12}$/.test(node.id);
  main.name = node.name;
  main.authority = Boolean(node.pin.authority);
  const token = node.token;
  note('pair again', await call(port, { method: 'POST', path: '/node/v1/pair', headers: json, body: '{}' }));
  note('info without token', await call(port, { path: '/node/v1/info' }));
  note('info wrong token', await call(port, { path: '/node/v1/info', token: 'x'.repeat(43) }));
  note('info malformed token', await call(port, { path: '/node/v1/info', token: 'short' }));
  note('info', await call(port, { path: '/node/v1/info', token }));
  note('info POST', await call(port, { method: 'POST', path: '/node/v1/info', token, body: '' }));
  note('slots 3', await call(port, { method: 'POST', path: '/node/v1/slots', token, headers: json, body: JSON.stringify({ slots: 3 }) }));
  note('slots 9', await call(port, { method: 'POST', path: '/node/v1/slots', token, headers: json, body: JSON.stringify({ slots: 9 }) }));
  note('slots text', await call(port, { method: 'POST', path: '/node/v1/slots', token, headers: json, body: JSON.stringify({ slots: '3' }) }));
  note('slots per device', await call(port, { method: 'POST', path: '/node/v1/slots', token, headers: json, body: JSON.stringify({ slots: { cpu: 1 } }) }));
  note('slots bad JSON', await call(port, { method: 'POST', path: '/node/v1/slots', token, headers: json, body: '{' }));
  note('slots empty', await call(port, { method: 'POST', path: '/node/v1/slots', token, headers: json, body: '' }));
  const bytes = fs.readFileSync(clip);
  const job = (s) => ({ 'X-Node-Job': JSON.stringify(s) });
  note('job no settings', await call(port, { method: 'POST', path: '/node/v1/jobs', token, body: bytes }));
  note('job bad settings', await call(port, { method: 'POST', path: '/node/v1/jobs', token, headers: job({ codec: 'h264', bitrate: 3e6 }), body: bytes }));
  note('job ffmpeg args', await call(port, { method: 'POST', path: '/node/v1/jobs', token, headers: job({ codec: 'h265', bitrate: 3e6, args: ['-f', 'lavfi'] }), body: bytes }));
  note('job without length', await call(port, { method: 'POST', path: '/node/v1/jobs', token, headers: job({ codec: 'h265', bitrate: 400000 }), body: bytes, chunked: true }));
  note('job unknown device', await call(port, { method: 'POST', path: '/node/v1/jobs', token, headers: job({ codec: 'h265', bitrate: 400000, device: 'pci:0000:09:00.0' }), body: bytes }));
  note('job cpu without devices', await call(port, { method: 'POST', path: '/node/v1/jobs', token, headers: job({ codec: 'h265', bitrate: 400000, device: 'cpu' }), body: bytes }));
  note('job manifest', await call(port, { method: 'POST', path: '/node/v1/jobs', token, headers: job({ codec: 'h265', bitrate: 400000 }), body: '<?xml version="1.0"?><MPD></MPD>' }));
  const sent = await call(port, { method: 'POST', path: '/node/v1/jobs', token, headers: job({ codec: 'h265', bitrate: 400000, holdFrames: 0, durationUs: 2e6 }), body: bytes });
  note('job', sent);
  const id = sent.json?.id;
  let state = null;
  let last = null;
  for (let i = 0; i < 600 && state !== 'done' && state !== 'failed'; i++) {
    await sleep(50);
    last = await call(port, { path: `/node/v1/jobs/${id}`, token });
    state = last.json?.state;
  }
  note('job done', last);
  const output = await call(port, { path: `/node/v1/jobs/${id}/output`, token });
  out.push({ name: 'job output', status: output.status, type: output.type, whole: output.length === output.bytes && output.bytes > 0 });
  note('job PATCH', await call(port, { method: 'PATCH', path: `/node/v1/jobs/${id}`, token }));
  note('job delete', await call(port, { method: 'DELETE', path: `/node/v1/jobs/${id}`, token }));
  note('job gone', await call(port, { path: `/node/v1/jobs/${id}`, token }));
  note('job bad id', await call(port, { path: '/node/v1/jobs/zz', token }));
  note('other path', await call(port, { path: '/node/v1/other', token }));
  note('info after', await call(port, { path: '/node/v1/info', token }));

  // Node's main: lanes, a real encode, a cancel, Use 3
  const lanes = await nodes.list();
  main.lanes = lanes.map((l) => ({ ...l, id: l.id.replace(node.id, '<node>'), nodeId: '<node>' }));
  main.encode = await new Promise((resolve) => {
    const child = nodes.encode({ device: { id: `node:${node.id}` }, source: clip, target: path.join(dir, `${label}-main.mp4`), codec: 'h265', bitrate: 400000, quality: null, holdFrames: 0, durationUs: 2e6 });
    child.once('close', resolve);
  });
  main.codec = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path.join(dir, `${label}-main.mp4`)], { encoding: 'utf8' }).stdout.trim();
  main.cancel = await new Promise((resolve) => {
    const child = nodes.encode({ device: { id: `node:${node.id}` }, source: clip, target: path.join(dir, `${label}-cancel.mp4`), codec: 'h265', bitrate: 400000, quality: null });
    // (at its first progress: the node has the job and is encoding it, so the cancel always reaches a job there)
    child.stdout.once('data', () => child.kill('SIGTERM'));
    child.once('close', (c, signal) => resolve(signal));
  });
  // (the cancel's DELETE reaches the worker after the main side closes: wait for the slot to be freed there,
  // asking the worker each time, as overview() may answer with numbers from before the encodes)
  const freed = (i) => i?.online === true && i.busy === 0 && i.encoding === 0;
  const until = Date.now() + 10_000;
  let after = null;
  do {
    after = await nodes.refresh(node.id);
    if (freed(after)) break;
    await sleep(100);
  } while (Date.now() < until);
  main.freed = freed(after);
  await nodes.setSlots(node.id, 3);
  main.slots = (await nodes.overview())[0].slots;
  main.overview = normal({ ...(await nodes.overview())[0], id: '<node>', address: '<address>', fingerprint: '<fp>', defaultLane: 'node:<node>' });
  main.refused = await nodes.setSlots(node.id, 9).then(() => null, (err) => err.message);
  // the throttle: twenty wrong tokens from one address, then even the right one waits
  for (let i = 0; i < 20; i++) await call(port, { path: '/node/v1/info', token: 'y'.repeat(43) });
  note('throttled', await call(port, { path: '/node/v1/info', token }));
  return { out, main };
}

async function main() {
  const [mode, dir, tlsDir, ...rest] = process.argv.slice(2);
  if (mode === 'worker') {
    const w = await startWorker(dir, tlsDir, 'node-garage');
    const { pairing } = w.worker.startPairing();
    process.stdout.write(`${JSON.stringify({ port: w.port, code: pairing.code })}\n`);
    process.stdin.resume();
    process.stdin.on('end', () => { w.server.close(); w.worker.close(); process.exit(0); });
    return;
  }
  if (mode === 'compare') {
    const [rustPort, rustCode, clip] = rest;
    const w = await startWorker(dir, tlsDir, 'garage-pc');
    const { pairing } = w.worker.startPairing();
    const ours = await script(w.port, pairing.code, clip, dir, 'node');
    const theirs = await script(Number(rustPort), rustCode, clip, dir, 'rust');
    const differences = [];
    const n = Math.max(ours.out.length, theirs.out.length);
    for (let i = 0; i < n; i++) {
      if (JSON.stringify(ours.out[i]) !== JSON.stringify(theirs.out[i])) differences.push({ node: ours.out[i], rust: theirs.out[i] });
    }
    for (const k of ['paired', 'name', 'authority', 'lanes', 'encode', 'codec', 'cancel', 'slots', 'overview', 'refused']) {
      if (JSON.stringify(ours.main[k]) !== JSON.stringify(theirs.main[k])) differences.push({ main: k, node: ours.main[k], rust: theirs.main[k] });
    }
    if (!ours.main.freed || !theirs.main.freed) differences.push({ main: 'freed', node: ours.main.freed, rust: theirs.main.freed });
    // (the cleanup on the node after the cancel: wait for it)
    for (let i = 0; i < 100 && fs.readdirSync(path.join(dir, 'node-work')).length > 0; i++) await sleep(100);
    if (fs.readdirSync(path.join(dir, 'node-work')).length) differences.push({ nodeWork: fs.readdirSync(path.join(dir, 'node-work')) });
    w.server.close();
    w.worker.close();
    process.stdout.write(JSON.stringify({ main: theirs.main, count: n, differences }));
    process.exit(0);
  }
  throw new Error(`unknown mode ${mode}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
