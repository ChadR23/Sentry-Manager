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
    // (cleanup runs on the node after the cancel: wait for it, a busy machine is slow)
    for (let i = 0; i < 100 && fs.readdirSync(path.join(dir, 'work')).length > 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.existsSync(target2), false);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'work')), []);

    // cancelled once the whole clip is on the node, before its answer with
    // the job's id: the answer is still taken, and the job deleted there
    const target3 = path.join(dir, 'out3.mp4');
    const full = fs.statSync(clip).size;
    await new Promise((resolve) => {
      const child = nodes.encode({ device, source: clip, target: target3, codec: 'h265', bitrate: 400_000, quality: null });
      const arrived = () => fs.readdirSync(path.join(dir, 'work')).some((f) => f.endsWith('-in.mp4') && fs.statSync(path.join(dir, 'work', f)).size === full);
      const wait = setInterval(() => {
        let ok = false;
        try { ok = arrived(); } catch { /* a file that went away */ }
        if (ok) { clearInterval(wait); child.kill('SIGTERM'); }
      }, 1);
      child.once('close', () => { clearInterval(wait); resolve(); });
    });
    for (let i = 0; i < 100 && fs.readdirSync(path.join(dir, 'work')).length > 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.existsSync(target3), false);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'work')), [], 'a job cancelled before its id came back is deleted on the node');

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

const { judgeFrames, comparePictures, ffmpegDecoder, W, H } = require('../src/main/converter/pictureCheck');
const { createHarness, CPU } = require('./fixtures/lanesHarness');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const tls = require('tls');

test('picture check: real encodes pass even shifted by some frames; black, frozen or other footage does not', { skip: !hasTools, timeout: 120_000 }, async () => {
  // synthetic frames: a moving gradient
  const frames = (n, f) => Buffer.concat(Array.from({ length: n }, (_, k) => Buffer.from(Array.from({ length: W * H }, (_, i) => f(k, i % W, Math.floor(i / W)) & 255))));
  const moving = (k, x, y) => (x * 3 + y * 2 + k * 5) + ((x * y + k) % 7);
  const src = frames(60, moving);
  assert.equal(judgeFrames(src, src).ok, true);
  const shifted = frames(60, (k, x, y) => moving(k + 6, x, y)); // the copy starts 6 frames later
  const r = judgeFrames(src, shifted);
  assert.equal(r.ok, true);
  assert.equal(r.shift, -6);
  assert.equal(judgeFrames(src, frames(60, () => 0)).ok, false, 'black');
  assert.equal(judgeFrames(src, frames(60, (k, x, y) => moving(0, x, y))).ok, false, 'one frame frozen');
  assert.equal(judgeFrames(src, frames(60, (k, x, y) => (y * 7 + k * 3) ^ x)).ok, false, 'other footage');
  assert.equal(judgeFrames(src, Buffer.alloc(0)).ok, false);

  // and with real ffmpeg: a genuine encode passes, a blacked-out one does not
  const dir = await tmp();
  try {
    const source = path.join(dir, 'src.mp4');
    await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: source, durationSeconds: 2, frameRate: 12, size: '320x240', spatialNoise: 3, telemetryPattern: Array.from({ length: 24 }, (_, i) => Buffer.from([0x20, i])) });
    const enc = (name, vf) => {
      const out = path.join(dir, name);
      assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', source, ...(vf ? ['-vf', vf] : []), '-c:v', 'libx265', '-b:v', '300k', '-an', out]).status, 0);
      return out;
    };
    const decode = ffmpegDecoder({ spawn: require('child_process').spawn });
    assert.equal((await comparePictures({ source, candidate: enc('good.mp4'), decode })).ok, true);
    assert.equal((await comparePictures({ source, candidate: enc('black.mp4', 'drawbox=t=fill:c=black'), decode })).ok, false);
    assert.equal((await comparePictures({ source, candidate: path.join(dir, 'missing.mp4'), decode })).ok, false);
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
    assert.equal(item.encoder, 'libx265', 'and the clip was encoded here instead (this test server has no GPU)');
    assert.equal(h.encodes().length, 1, 'one local encode, after the node\'s');
  } finally {
    await h.close();
  }
});

test('a node that fails hands its clip to this server\'s own GPU first, not straight to the CPU', async () => {
  const NODE = { id: 'node:abcdefabcdef', kind: 'node', name: 'pc (node)', encoders: { h265: 'hevc_nvenc', av1: null }, online: true };
  const { ARC, UHD } = require('./fixtures/lanesHarness');
  const h = createHarness({
    clips: 1, devices: [NODE, ARC, UHD, CPU], gpuDecode: false,
    remoteEncode: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() => child.emit('close', 1, null)); // the node failed
      return child;
    }
  });
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: NODE.id, concurrency: 1 }] }));
    const job = await h.finishJob(id);
    const [item] = job.items.filter((entry) => entry.kind === 'video');
    assert.equal(item.resultCode, 'converted');
    assert.equal(item.encoder, 'hevc_qsv', 'this server\'s GPU encoder, not libx265');
  } finally {
    await h.close();
  }
});

test('a node lane is sent 15 clips ahead of its conversions at once', async () => {
  const NODE = { id: 'node:abcdefabcdef', kind: 'node', name: 'pc (node)', encoders: { h265: 'hevc_nvenc', av1: null }, online: true };
  let active = 0;
  let most = 0;
  const h = createHarness({
    clips: 20, devices: [NODE, CPU], defaultDevice: null, gpuDecode: false,
    remoteEncode: () => {
      active += 1;
      most = Math.max(most, active);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setTimeout(() => { active -= 1; child.emit('close', 1, null); }, 150); // (then encoded here)
      return child;
    }
  });
  try {
    const id = await h.service.start(h.config({ lanes: [{ device: NODE.id, concurrency: 1 }] }));
    await h.finishJob(id);
    assert.equal(most, 1 + 15, 'one converting and 15 waiting on the node');
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

// ---- Nodes > Benchmark

const { createNodeBenchmark, pickSamples, suggest } = require('../server/nodeBenchmark');
const { run: runProc } = require('../server/proc');

test('benchmark: the lightest level within 5% of the fastest is suggested', () => {
  assert.equal(suggest([{ level: 1, clipsPerMinute: 4 }, { level: 2, clipsPerMinute: 7.8 }, { level: 4, clipsPerMinute: 8 }]), 2);
  assert.equal(suggest([{ level: 1, clipsPerMinute: 4 }, { level: 2, clipsPerMinute: 6 }]), 2);
  assert.equal(suggest([{ level: 1, clipsPerMinute: 0 }]), null);
});

test('benchmark: sample clips are H.264 Tesla clips, newest first, one camera each first', async () => {
  const dir = await tmp();
  try {
    const recent = path.join(dir, 'RecentClips');
    fs.mkdirSync(recent);
    for (const name of ['2026-10-20_10-00-00-front.mp4', '2026-10-21_10-00-00-front.mp4', '2026-10-21_10-00-00-back.mp4', 'notes.txt', '2026-10-21_10-00-00-front.mov']) {
      fs.writeFileSync(path.join(recent, name), Buffer.alloc(2048));
    }
    const codecOf = async (file) => (file.includes('10-20') ? 'h265' : 'h264');
    const picked = await pickSamples(dir, { codecOf, minBytes: 1024 });
    assert.deepEqual(picked.files.map((p) => path.basename(p)), ['2026-10-21_10-00-00-front.mp4', '2026-10-21_10-00-00-back.mp4']);
    assert.equal(picked.converted, false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('benchmark: originals are found past hundreds of converted clips; with none left, converted clips are lent', async () => {
  const dir = await tmp();
  try {
    const recent = path.join(dir, 'RecentClips');
    const saved = path.join(dir, 'SavedClips', '2026-01-01_00-00-00');
    fs.mkdirSync(recent);
    fs.mkdirSync(saved, { recursive: true });
    // 600 newer clips, all converted, and one older original in SavedClips
    for (let n = 0; n < 600; n++) fs.writeFileSync(path.join(recent, `2026-10-${String(1 + Math.floor(n / 60)).padStart(2, '0')}_10-${String(n % 60).padStart(2, '0')}-00-front.mp4`), Buffer.alloc(2048));
    fs.writeFileSync(path.join(saved, '2026-01-01_00-00-00-back.mp4'), Buffer.alloc(2048));
    const codecOf = async (file) => (file.endsWith('-back.mp4') ? 'h264' : 'h265');
    const picked = await pickSamples(dir, { codecOf, minBytes: 1024 });
    assert.deepEqual(picked.files.map((p) => path.basename(p)), ['2026-01-01_00-00-00-back.mp4']);
    assert.equal(picked.converted, false);

    const none = await pickSamples(dir, { codecOf: async () => 'h265', minBytes: 1024 });
    assert.equal(none.files.length, 4);
    assert.equal(none.converted, true, 'converted clips stand in when no original is left');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a node can be given a name of your own; empty names are refused', () => {
  const db = memDb();
  db.set('nodes', [{ id: 'abcdefghijkl', name: 'garage-pc', host: '10.0.0.5', port: 9000, token: 't'.repeat(43), pin: { fingerprint: '00' } }]);
  const nodes = createNodes({ db, log: quiet, audit: quiet, name: 'main-nas' });
  assert.deepEqual(nodes.rename('abcdefghijkl', '  Garage 4070 Ti\n'), { previous: 'garage-pc', name: 'Garage 4070 Ti' });
  assert.equal(db.get('nodes')[0].name, 'Garage 4070 Ti');
  assert.equal(db.get('nodes')[0].token, 't'.repeat(43), 'nothing else changes');
  assert.throws(() => nodes.rename('abcdefghijkl', '   '), /Enter a name/);
  assert.equal(nodes.rename('nope', 'x'), null);
});

test('benchmark: real clips lent to a real node, timed per level, encodes deleted, footage untouched', { skip: !hasTools, timeout: 300_000 }, async () => {
  const dir = await tmp();
  const material = await certs(dir, 'worker-tls');
  const w = await startWorker(dir, material);
  const nodes = createNodes({ db: memDb(), log: quiet, audit: quiet, name: 'main-nas', pollMs: 100 });
  try {
    const { pairing } = w.worker.startPairing();
    const node = await nodes.add({ address: `127.0.0.1:${w.port}`, code: pairing.code });
    const tesla = path.join(dir, 'footage', 'TeslaCam', 'RecentClips');
    fs.mkdirSync(tesla, { recursive: true });
    for (const cam of ['front', 'back']) {
      await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: path.join(tesla, `2026-10-24_10-00-00-${cam}.mp4`), durationSeconds: 2, frameRate: 12, size: '320x240', spatialNoise: 3, telemetryPattern: Array.from({ length: 24 }, (_, i) => Buffer.from([0x20, i])) });
    }
    const before = fs.readdirSync(tesla).map((f) => [f, fs.statSync(path.join(tesla, f)).mtimeMs]);
    const vehicles = { list: () => [{ id: 'car' }], studioRoot: () => path.join(dir, 'footage', 'TeslaCam') };
    const work = path.join(dir, 'bench');
    const bench = createNodeBenchmark({ nodes, vehicles, run: runProc, workDir: work, log: quiet, minBytes: 1024, levels: [1, 2] });
    bench.start(node.id, { codec: 'h265' });
    assert.throws(() => bench.start(node.id), /already running/);
    for (let i = 0; i < 600 && bench.view(node.id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 200));
    const result = bench.view(node.id);
    assert.equal(result.state, 'done', JSON.stringify(result));
    assert.deepEqual(result.results.map((r) => r.level), [1, 2]);
    assert.ok(result.results.every((r) => r.clipsPerMinute > 0 && r.failed === 0));
    assert.ok([1, 2].includes(result.suggested));
    assert.deepEqual(fs.readdirSync(work), [], 'every encode was deleted');
    assert.deepEqual(fs.readdirSync(tesla).map((f) => [f, fs.statSync(path.join(tesla, f)).mtimeMs]), before, 'the footage is untouched');

    // Use: the node takes that many clips at once
    await nodes.setSlots(node.id, 3);
    assert.equal(w.worker.status().slots, 3);
    await assert.rejects(nodes.setSlots(node.id, 9), /1 to 8/);
  } finally {
    w.server.close();
    w.worker.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Encode with: GPU only by default, the CPU as well only when chosen, or the CPU alone', async () => {
  const dir = await tmp();
  try {
    let hasGpu = true;
    const runtime = {
      selectEncoder: async () => (hasGpu ? { codec: 'hevc_vaapi', hardware: true, device: { node: '/dev/dri/renderD128' } } : { codec: 'libx265', hardware: false }),
      cpuEncoder: async () => ({ codec: 'libx265', hardware: false })
    };
    const worker = createNodeWorker({ db: memDb(), log: quiet, audit: quiet, workDir: path.join(dir, 'work'), runtime: () => runtime, platform: 'linux' });
    const encoders = async () => (await worker.attempts('h265', 0)).map((a) => a.encoder);
    assert.equal(worker.status().use, 'gpu');
    assert.equal((await encoders()).includes('libx265'), false, 'a GPU clip that fails goes back to the main, not to this CPU');
    assert.ok((await encoders()).every((e) => e === 'hevc_vaapi'));
    worker.setEnabled(true, 2, 'gpu-cpu');
    assert.equal((await encoders()).at(-1), 'libx265');
    worker.setEnabled(true, 2, 'cpu');
    assert.deepEqual(await encoders(), ['libx265']);
    worker.setEnabled(true, 2, 'gpu');
    hasGpu = false;
    assert.deepEqual(await encoders(), ['libx265'], 'no GPU: the CPU');
    assert.throws(() => worker.setEnabled(true, 2, 'npu'), /Encode with/);
    worker.close();
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the picture check decodes on this server\'s GPU, and on the CPU when the GPU decode fails', async () => {
  const { ffmpegDecoder } = require('../src/main/converter/pictureCheck');
  const { EventEmitter } = require('events');
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    const gpu = args.includes('-hwaccel');
    setImmediate(() => {
      if (!gpu || okOnGpu) child.stdout.emit('data', Buffer.alloc(4));
      child.emit('close', gpu && !okOnGpu ? 1 : 0);
    });
    return child;
  };
  let okOnGpu = true;
  const decode = ffmpegDecoder({ spawn, accel: async () => ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128'] });
  assert.equal((await decode('a.mp4', { width: 2, height: 2 })).length, 4);
  assert.deepEqual(calls.map((a) => a.includes('-hwaccel')), [true]);
  assert.ok(calls[0].indexOf('-hwaccel') < calls[0].indexOf('-i'), 'decode arguments go before the input');
  okOnGpu = false;
  calls.length = 0;
  assert.equal((await decode('a.mp4', { width: 2, height: 2 })).length, 4);
  assert.deepEqual(calls.map((a) => a.includes('-hwaccel')), [true, false], 'the CPU decodes it again');
  calls.length = 0;
  await ffmpegDecoder({ spawn, accel: async () => null })('a.mp4', { width: 2, height: 2 });
  assert.deepEqual(calls.map((a) => a.includes('-hwaccel')), [false], 'no GPU: the CPU');
});

test('clips sent ahead wait on the node for a free slot, and all of them convert', { skip: !hasTools, timeout: 300_000 }, async () => {
  const dir = await tmp();
  const material = await certs(dir, 'worker-tls');
  const w = await startWorker(dir, material);
  const nodes = createNodes({ db: memDb(), log: quiet, audit: quiet, name: 'main-nas', pollMs: 100 });
  try {
    const { pairing } = w.worker.startPairing();
    const node = await nodes.add({ address: `127.0.0.1:${w.port}`, code: pairing.code });
    w.worker.setEnabled(true, 1);
    const clip = path.join(dir, 'clip.mp4');
    await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: clip, durationSeconds: 2, frameRate: 12, size: '320x240', telemetryPattern: Array.from({ length: 24 }, (_, i) => Buffer.from([0x20, i])) });
    const device = { id: `node:${node.id}` };
    let most = { busy: 0, encoding: 0 };
    const watch = setInterval(async () => {
      const r = await fetchJson(w.port, '/node/v1/info', node.token).catch(() => null);
      if (r?.busy > most.busy) most = { ...most, busy: r.busy };
      if (r?.encoding > most.encoding) most = { ...most, encoding: r.encoding };
      if (r) assert.equal(r.capacity, 1 + 15);
    }, 50);
    const sawQueued = [false, false, false];
    const codes = await Promise.all([0, 1, 2].map((n) => new Promise((resolve) => {
      const child = nodes.encode({ device, source: clip, target: path.join(dir, `out-${n}.mp4`), codec: 'h265', bitrate: 400_000, quality: null });
      child.stdout.on('data', (d) => { if (String(d).includes('queued=1')) sawQueued[n] = true; });
      child.once('close', resolve);
    })));
    clearInterval(watch);
    assert.deepEqual(codes, [0, 0, 0]);
    assert.ok(most.busy >= 2, `clips waited on the node (${most.busy} held at once)`);
    assert.equal(most.encoding, 1, 'never more encodes than its slots');
    assert.ok(sawQueued.some(Boolean), 'a waiting clip tells the main it is still alive');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'work')), []);
  } finally {
    w.server.close();
    w.worker.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

function fetchJson(port, p, token) {
  return new Promise((resolve, reject) => {
    const req = require('https').request({ host: '127.0.0.1', port, path: p, rejectUnauthorized: false, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (err) { reject(err); } });
    });
    req.on('error', reject);
    req.end();
  });
}
