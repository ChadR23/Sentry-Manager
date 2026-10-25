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

// ---- the security review's findings, each pinned by a test

const { judge, comparePictures } = require('../src/main/converter/pictureCheck');
const { createHarness, CPU } = require('./fixtures/lanesHarness');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const tls = require('tls');

test('picture check: real encodes pass, black or other footage does not', { skip: !hasTools, timeout: 120_000 }, async () => {
  assert.equal(judge('n:1 Y:0.99 All:0.995 (23)\nn:2 Y:0.99 All:0.99 (20)\n').ok, true);
  assert.equal(judge('n:1 All:0.02\nn:2 All:0.03\n').ok, false);
  assert.equal(judge('n:1 All:0.99\nn:2 All:0.30\n').ok, false, 'one swapped frame is enough');
  assert.equal(judge('').ok, false);
  const dir = await tmp();
  try {
    const source = path.join(dir, 'src.mp4');
    await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: source, durationSeconds: 2, frameRate: 12, size: '320x240', spatialNoise: 3, telemetryPattern: Array.from({ length: 24 }, (_, i) => Buffer.from([0x20, i])) });
    const enc = (name, vf) => {
      const out = path.join(dir, name);
      assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', source, ...(vf ? ['-vf', vf] : []), '-c:v', 'libx265', '-b:v', '300k', '-an', out]).status, 0);
      return out;
    };
    const run = async (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      return { status: r.status, stdout: r.stdout };
    };
    assert.equal((await comparePictures({ source, candidate: enc('good.mp4'), run })).ok, true);
    assert.equal((await comparePictures({ source, candidate: enc('black.mp4', 'drawbox=t=fill:c=black'), run })).ok, false);
    assert.equal((await comparePictures({ source, candidate: path.join(dir, 'missing.mp4'), run })).ok, false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a node encode whose pictures do not match is thrown away and encoded here', async () => {
  const NODE = { id: 'node:abcdefabcdef', kind: 'node', name: 'pc (node)', encoders: { h265: 'hevc_nvenc', av1: null }, online: true };
  const compared = [];
  const h = createHarness({
    clips: 1, devices: [NODE, CPU], defaultDevice: null, gpuDecode: false,
    works: (encoder) => encoder.startsWith('lib'),
    remoteEncode: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() => child.emit('close', 0, null));
      return child;
    },
    comparePicture: async (request) => { compared.push(request.candidate); return { ok: false, mean: 0.03 }; }
  });
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: NODE.id, concurrency: 1 }] }));
    const job = await h.finishJob(id);
    const [item] = job.items.filter((entry) => entry.kind === 'video');
    assert.equal(compared.length, 1, 'the node\'s encode was compared');
    assert.equal(item.resultCode, 'converted');
    assert.equal(item.encoder, 'libx265', 'and the clip was encoded here instead');
    assert.equal(h.encodes().length, 1, 'one local encode, after the node\'s');
  } finally {
    await h.close();
  }
});

test('the worker refuses anything but an MP4, limits wrong pairing codes per address, and a node cannot hang the main', { skip: !hasTools, timeout: 120_000 }, async () => {
  const dir = await tmp();
  const material = await certs(dir, 'worker-tls');
  const w = await startWorker(dir, material);
  const nodes = createNodes({ db: memDb(), log: quiet, audit: quiet, name: 'main-nas', pollMs: 100 });
  let rogue = null;
  try {
    // three wrong codes from one address: that address is refused, the code lives on
    const { pairing } = w.worker.startPairing();
    for (let i = 0; i < 3; i++) await assert.rejects(nodes.add({ address: `127.0.0.1:${w.port}`, code: 'AAAA-BBBB-CCCC' }), /Wrong pairing code/);
    await assert.rejects(nodes.add({ address: `127.0.0.1:${w.port}`, code: pairing.code }), /Too many wrong pairing codes/);
    assert.ok(w.worker.status().pairing, 'the code was not cancelled for everyone');

    // a DASH manifest (which could point ffmpeg at the node's own files) is refused
    // (as a main already paired: its token stored on the worker)
    w.worker.cancelPairing();
    const token = crypto.randomBytes(32).toString('base64url');
    w.db.set('nodeWorker', { ...w.db.get('nodeWorker'), enabled: true, mains: [{ id: 'aaaaaaaaaaaa', name: 'm', tokenHash: crypto.createHash('sha256').update(token).digest('hex'), pairedAt: 1 }] });
    const manifest = Buffer.from('<?xml version="1.0"?><MPD><Period><AdaptationSet><Representation><BaseURL>file:///etc/hostname</BaseURL></Representation></AdaptationSet></Period></MPD>');
    const upload = await new Promise((resolve, reject) => {
      const req = require('https').request({ host: '127.0.0.1', port: w.port, path: '/node/v1/jobs', method: 'POST', rejectUnauthorized: false,
        headers: { Authorization: `Bearer ${token}`, 'Content-Length': manifest.length, 'X-Node-Job': JSON.stringify({ codec: 'h265', bitrate: 400000 }) } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end(manifest);
    });
    assert.equal(upload, 415);

    // a "node" that answers with an endless body: refused, and quickly
    const fake = await certs(dir, 'rogue-tls');
    rogue = tls.createServer({ key: fake.key, cert: fake.cert }, (socket) => {
      socket.on('data', () => {});
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"name":"');
      const t = setInterval(() => socket.write('x'.repeat(16 * 1024)), 5);
      socket.on('close', () => clearInterval(t));
      socket.on('error', () => {});
    });
    await new Promise((r) => rogue.listen(0, '127.0.0.1', r));
    const fp = crypto.createHash('sha256').update(new crypto.X509Certificate(fake.cert).raw).digest('hex');
    const db = memDb();
    db.set('nodes', [{ id: 'roguerogue12', name: 'rogue', host: '127.0.0.1', port: rogue.address().port, token: 't'.repeat(43), pin: { fingerprint: fp, authority: null }, pairedAt: 1 }]);
    const victim = createNodes({ db, log: quiet, audit: quiet, name: 'main', pollMs: 100 });
    const started = Date.now();
    const info = await victim.refresh('roguerogue12');
    assert.equal(info.online, false);
    assert.match(info.error, /too much/);
    assert.ok(Date.now() - started < 5000, 'it did not hang');
  } finally {
    rogue?.close();
    w.server.close();
    w.worker.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
