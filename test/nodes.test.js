'use strict';

// Nodes: another server encodes clips for this one over HTTPS. Pairing needs
// the one-time code and the certificate the main really saw; afterwards every
// connection must present the paired certificate (or one its authority
// issued) and every request the token. Settings are fixed choices, never
// ffmpeg arguments. A real clip is sent, encoded and brought back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const http2 = require('http2');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TlsManager } = require('../server/tls');
const { createNodeWorker, parseJobSettings, pairText, hmac, normalizeCode } = require('../server/nodeWorker');
const { createNodes, parseAddress } = require('../server/nodes');
const { createTeslaH264Fixture } = require('./fixtures/ffmpegFixtures');

const hasTools = spawnSync('openssl', ['version']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;
const quiet = { info() {}, warn() {}, error() {} };
const memDb = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? structuredClone(m.get(k)) : f), set: (k, v) => m.set(k, structuredClone(v)) };
};
const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'sm-nodes-'));

async function certs(dir, name) {
  const t = new TlsManager({ dir: path.join(dir, name), log: quiet, hostnames: ['127.0.0.1'] });
  await t.ensure();
  return { key: fs.readFileSync(path.join(dir, name, 'server.key')), cert: fs.readFileSync(path.join(dir, name, 'server.crt')), ca: t.caPem() };
}

// a worker on a real HTTPS server (HTTP/2 with HTTP/1.1, as the app serves)
async function startWorker(dir, material, { encoders = true } = {}) {
  const db = memDb();
  const runtime = {
    selectEncoder: async (family) => (encoders ? { codec: family === 'h265' ? 'libx265' : 'libsvtav1', hardware: false } : null),
    cpuEncoder: async (family) => ({ codec: family === 'h265' ? 'libx265' : 'libsvtav1', hardware: false })
  };
  const worker = createNodeWorker({ db, log: quiet, audit: quiet, authority: () => material.ca, workDir: path.join(dir, 'work'), runtime: () => runtime, name: 'garage-pc' });
  const server = http2.createSecureServer({ key: material.key, cert: material.cert, allowHTTP1: true }, async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (!(await worker.handle(req, res, p, '127.0.0.1'))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { worker, server, db, port: server.address().port };
}

test('addresses: host and port, nothing else', () => {
  assert.deepEqual(parseAddress('192.168.1.30'), { host: '192.168.1.30', port: 9000 });
  assert.deepEqual(parseAddress('https://nas.local:9443/'), { host: 'nas.local', port: 9443 });
  assert.deepEqual(parseAddress('[fd00::5]:9001'), { host: 'fd00::5', port: 9001 });
  for (const bad of ['', 'a b', 'host:99999', 'user@host', 'host;rm -rf /']) assert.equal(parseAddress(bad), null, bad);
});

test('encode settings are fixed choices; ffmpeg arguments are never taken', () => {
  assert.deepEqual(parseJobSettings(JSON.stringify({ codec: 'h265', bitrate: 3_000_000, holdFrames: 2 })),
    { codec: 'h265', bitrate: 3_000_000, quality: null, holdFrames: 2, durationUs: null });
  assert.equal(parseJobSettings(JSON.stringify({ codec: 'av1', quality: 'balanced' })).quality, 'balanced');
  for (const bad of [
    { codec: 'h264', bitrate: 3e6 }, { codec: 'h265' }, { codec: 'h265', bitrate: 3e6, quality: 'high' },
    { codec: 'h265', bitrate: 10 }, { codec: 'h265', quality: 'max' }, { codec: 'h265', bitrate: 3e6, args: ['-f', 'lavfi'] },
    { codec: 'h265', bitrate: 3e6, holdFrames: -1 }, 'nope'
  ]) assert.equal(parseJobSettings(typeof bad === 'string' ? bad : JSON.stringify(bad)), null, JSON.stringify(bad));
});

test('pairing, a changed certificate, tokens and a real remote encode', { skip: !hasTools, timeout: 180_000 }, async () => {
  const dir = await tmp();
  const material = await certs(dir, 'worker-tls');
  let w = await startWorker(dir, material);
  const mainDb = memDb();
  const nodes = createNodes({ db: mainDb, log: quiet, audit: quiet, name: 'main-nas', pollMs: 100 });
  try {
    // nothing answers until node mode is on and a code is shown
    await assert.rejects(nodes.add({ address: `127.0.0.1:${w.port}`, code: 'AAAA-BBBB-CCCC' }), /not set up as a node/);
    const { pairing } = w.worker.startPairing();
    assert.match(pairing.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // a wrong code is refused; five wrong codes end the pairing
    await assert.rejects(nodes.add({ address: `127.0.0.1:${w.port}`, code: 'AAAA-BBBB-CCCC' }), /Wrong pairing code/);

    // someone who knows the code but saw another certificate (a machine in
    // between) cannot pair: the proof covers the certificate
    const forged = await fetchPair(w.port, { name: 'evil', proof: hmac(normalizeCode(pairing.code), pairText.main('00'.repeat(32), 'evil')) });
    assert.equal(forged.status, 403);

    const node = await nodes.add({ address: `127.0.0.1:${w.port}`, code: pairing.code.toLowerCase().replace(/-/g, ' ') });
    assert.match(node.id, /^[a-z0-9]{12}$/);
    assert.ok(node.pin.authority, 'the worker\'s authority is pinned too');
    assert.equal(w.worker.status().pairing, null, 'the code is used up');
    assert.equal(w.worker.status().mains.length, 1);
    assert.equal(JSON.stringify(w.db.get('nodeWorker')).includes(node.token), false, 'the worker keeps only a hash of the token');

    const [device] = await nodes.list();
    assert.deepEqual(device.encoders, { h265: 'libx265', av1: 'libsvtav1' });
    assert.equal(device.id, `node:${node.id}`);

    // without the token, or with a wrong one: refused
    assert.equal((await fetchNode(w.port, '/node/v1/info')).status, 401);
    assert.equal((await fetchNode(w.port, '/node/v1/info', 'x'.repeat(43))).status, 401);

    // a real clip goes there and comes back encoded
    const clip = path.join(dir, 'clip.mp4');
    await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: clip, durationSeconds: 2, frameRate: 12, size: '320x240', telemetryPattern: Array.from({ length: 24 }, (_, i) => Buffer.from([0x20, i])) });
    const target = path.join(dir, 'out.mp4');
    const progress = [];
    const code = await new Promise((resolve) => {
      const child = nodes.encode({ device, source: clip, target, codec: 'h265', bitrate: 400_000, quality: null, holdFrames: 0, durationUs: 2e6 });
      child.stdout.on('data', (d) => progress.push(String(d)));
      child.once('close', resolve);
    });
    assert.equal(code, 0);
    assert.ok(progress.some((p) => p.includes('progress=end')));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', target], { encoding: 'utf8' });
    assert.equal(probe.stdout.trim(), 'hevc');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'work')), [], 'the worker keeps nothing');

    // the output is written new: an existing file is never overwritten
    const again = await new Promise((resolve) => nodes.encode({ device, source: clip, target, codec: 'h265', bitrate: 400_000, quality: null }).once('close', resolve));
    assert.equal(again, 1);

    // cancelled midway: the worker stops and deletes its files
    const target2 = path.join(dir, 'out2.mp4');
    await new Promise((resolve) => {
      const child = nodes.encode({ device, source: clip, target: target2, codec: 'h265', bitrate: 400_000, quality: null });
      setTimeout(() => child.kill('SIGTERM'), 30);
      child.once('close', (c, signal) => { assert.equal(signal, 'SIGTERM'); resolve(); });
    });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fs.existsSync(target2), false);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'work')), []);

    // the node is reset with a new certificate authority: refused before any
    // request is sent, until it is paired again
    w.server.close();
    w.worker.close();
    const other = await certs(dir, 'impostor-tls');
    const port = w.port;
    w = await startWorkerOn(dir, other, port, w.db);
    await assert.rejects(nodes.refresh(node.id).then((i) => { if (!i.online) throw new Error(i.error); }), /different certificate/);
    const failed = await new Promise((resolve) => nodes.encode({ device, source: clip, target: path.join(dir, 'out3.mp4'), codec: 'h265', bitrate: 400_000, quality: null }).once('close', resolve));
    assert.equal(failed, 1);

    // revoked on the worker: the main's token stops working
    w.server.close();
    w.worker.close();
    w = await startWorkerOn(dir, material, port, w.db);
    assert.equal((await nodes.refresh(node.id)).online, true);
    w.worker.revoke(w.worker.status().mains[0].id);
    assert.equal((await nodes.refresh(node.id)).online, false);
  } finally {
    w.server.close();
    w.worker.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

async function startWorkerOn(dir, material, port, db) {
  const runtime = { selectEncoder: async () => ({ codec: 'libx265', hardware: false }), cpuEncoder: async () => ({ codec: 'libx265', hardware: false }) };
  const worker = createNodeWorker({ db, log: quiet, audit: quiet, authority: () => material.ca, workDir: path.join(dir, 'work'), runtime: () => runtime, name: 'garage-pc' });
  const server = http2.createSecureServer({ key: material.key, cert: material.cert, allowHTTP1: true }, async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (!(await worker.handle(req, res, p, '127.0.0.1'))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { worker, server, db, port };
}

function fetchNode(port, p, token = null) {
  return new Promise((resolve, reject) => {
    const req = require('https').request({ host: '127.0.0.1', port, path: p, rejectUnauthorized: false, headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
}

function fetchPair(port, body) {
  return new Promise((resolve, reject) => {
    const req = require('https').request({ host: '127.0.0.1', port, path: '/node/v1/pair', method: 'POST', rejectUnauthorized: false, headers: { 'Content-Type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
