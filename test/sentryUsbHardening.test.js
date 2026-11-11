'use strict';

// Hardening of the Sentry USB link against a stranger on the device port and
// against a Pi that holds a valid link key but misbehaves.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { WsConnection, encodeFrame, MAX_PARTS } = require('../server/wsFrames');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await wait(20); }
};

// a server-side WsConnection on one end of a local TCP pair, the raw client socket on the other
function pair() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      const ws = new WsConnection(sock, { role: 'server', maxMessage: 16 * 1024 });
      resolve({ ws, client, close: () => { client.destroy(); sock.destroy(); srv.close(); } });
    });
    let client = null;
    srv.listen(0, '127.0.0.1', () => { client = net.connect(srv.address().port, '127.0.0.1'); });
  });
}

test('WebSocket: a message in endless empty fragments is refused (1009), not piled up', async () => {
  const p = await pair();
  try {
    let code = null;
    p.ws.on('close', (c) => { code = c; });
    const start = encodeFrame(0x1, '', true);
    start[0] = 0x01; // text, not FIN
    const cont = encodeFrame(0x0, '', true);
    cont[0] = 0x00; // continuation, not FIN
    p.client.write(Buffer.concat([start, ...Array.from({ length: MAX_PARTS + 50 }, () => cont)]));
    await until(() => code !== null);
    assert.equal(code, 1009);
  } finally { p.close(); }
});

test('WebSocket: a peer that floods pings and never reads is dropped once its unsent pongs pile up', async () => {
  const p = await pair();
  try {
    let closed = false;
    p.ws.on('close', () => { closed = true; });
    p.client.pause(); // never reads
    const ping = encodeFrame(0x9, Buffer.alloc(125, 1), true);
    const burst = Buffer.concat(Array.from({ length: 2000 }, () => ping));
    for (let i = 0; i < 200 && !closed; i++) {
      p.client.write(burst);
      await wait(5);
    }
    await until(() => closed);
    assert.equal(closed, true);
  } finally { p.close(); }
});

// ---- a link server with a fake Pi (as in sentryUsbLink.test.js)
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { TlsManager } = require('../server/tls');
const L = require('../server/sentryUsbLink');
const { connectFakePi } = require('./fixtures/fakeSentryUsb');

const quiet = { info() {}, warn() {}, debug() {} };
const memDb = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? structuredClone(m.get(k)) : f), set: (k, v) => m.set(k, structuredClone(v)), raw: m };
};
let material = null;
async function certs() {
  if (material) return material;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-harden-'));
  const t = new TlsManager({ dir: path.join(dir, 'tls'), log: quiet, hostnames: ['127.0.0.1'] });
  await t.ensure();
  material = { key: fs.readFileSync(path.join(dir, 'tls', 'server.key')), cert: fs.readFileSync(path.join(dir, 'tls', 'server.crt')) };
  return material;
}
async function setup(opts = {}) {
  const m = await certs();
  const db = memDb();
  const events = [];
  const link = L.createSentryUsbLink({ db, log: quiet, iterations: 1000, onEvent: (e) => events.push(e), ...opts });
  const srv = https.createServer({ key: m.key, cert: m.cert }, (req, res) => { res.writeHead(404); res.end(); });
  srv.on('upgrade', (req, socket, head) => link.handleUpgrade(req, socket, head));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const pis = [];
  // a pair-mode Pi types the code of the slot opened last, as the owner would
  let code = null;
  const open = link.openPairing;
  link.openPairing = async (o) => { const r = await open(o); code = r.code; return r; };
  const pi = async (o) => { const p = await connectFakePi({ port, iterations: 1000, ...(o?.mode === 'pair' ? { code } : {}), ...o }); pis.push(p); return p; };
  const close = async () => { link.close(); for (const p of pis) p.ws?.terminate(); srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); };
  return { db, link, port, pi, close, events };
}
const deep = (n) => JSON.parse(`${'['.repeat(n)}${']'.repeat(n)}`);

test('a Pi that sends deeply nested arrays where text belongs does not end the process; its link is closed or the value dropped', async () => {
  const t = await setup();
  try {
    await t.link.openPairing({ name: 'Car', username: 'pi', password: 'raspberry' });
    const p = await t.pi({ mode: 'pair', username: 'pi', password: 'raspberry', net: false, status: false });
    const id = p.auth.id;
    const nest = deep(150_000);
    // each of these used to throw "Maximum call stack size exceeded" out of the socket's data handler
    p.send({ t: 'net', ssid: nest, iface: nest, ip: nest, gw: nest });
    p.send({ t: 'alert', kind: 'fingerprint', seen: nest, at: nest });
    p.send({ t: 'status', body: { deep: deep(5000) } });
    await wait(200);
    assert.equal(t.link.devices()[0].online, true, 'still connected: the values were only dropped');
    assert.equal(t.link.devices()[0].net.ssid, null);
    assert.equal(t.link.devices()[0].status, null, 'a status nested beyond any real one is not kept');
    const alert = t.events.find((e) => e.type === 'alert');
    assert.equal(alert.seen, null);
    assert.equal(alert.at, null);
    // an answer whose type is a nested array: the answer gets a safe type
    const q = await t.pi({ mode: 'key', key: p.linkKey, id, net: false, status: false, answer: () => null, onRequest: (m, me) => { me.ws.send(JSON.stringify({ t: 'res', id: m.id, status: 200, type: nest, body: { ok: true } })); return false; } });
    const r = await t.link.request(id, { method: 'GET', path: '/api/status' });
    assert.equal(r.status, 200);
    assert.equal(r.type, 'application/octet-stream');
    // and one that ends a chunked answer with a nested error
    q.ws.close();
    const s = await t.pi({ mode: 'key', key: p.linkKey, id, net: false, status: false, onRequest: (m, me) => { me.ws.send(JSON.stringify({ t: 'res', id: m.id, status: 200, type: 'text/plain', chunked: true })); me.ws.send(JSON.stringify({ t: 'end', id: m.id, error: nest })); return false; } });
    const e = await t.link.request(id, { method: 'GET', path: '/api/status' });
    assert.equal(e.status, 502);
    s.ws.close();
  } finally { await t.close(); }
});

test('maskConfig: values that are not plain text are emptied, numbers and booleans kept', () => {
  const m = L.maskConfig({ A: { value: deep(150_000), active: true }, B: { value: 5, active: true }, C: { value: true, active: false } });
  assert.deepEqual(m, { A: { value: '', active: true }, B: { value: '5', active: true }, C: { value: 'true', active: false } });
});

test('a Pi that floods network reports and alerts: at most 20 in 10 minutes reach the database and the security log', async () => {
  const t = await setup();
  try {
    await t.link.openPairing({ name: 'Car', username: 'pi', password: 'raspberry' });
    const p = await t.pi({ mode: 'pair', username: 'pi', password: 'raspberry', net: false, status: false });
    for (let i = 0; i < 100; i++) p.send({ t: i % 2 ? 'net' : 'alert', ssid: `Net${i}`, kind: 'proof', seen: `x${i}` });
    await wait(300);
    const notices = t.events.filter((e) => e.type === 'net' || e.type === 'alert');
    assert.equal(notices.length, L.NOTICES);
    assert.equal(t.link.devices()[0].online, true);
  } finally { await t.close(); }
});

test('a Pi\'s chunked answers together are held to 96 MiB, not 8 x 64 MiB', async () => {
  const t = await setup({ requestMs: 30_000 });
  try {
    await t.link.openPairing({ name: 'Car', username: 'pi', password: 'raspberry' });
    const MIB = 1024 * 1024;
    const part = Buffer.alloc(MIB, 7).toString('base64');
    const p = await t.pi({
      mode: 'pair', username: 'pi', password: 'raspberry', net: false, status: false,
      onRequest: (m, me) => {
        me.ws.send(JSON.stringify({ t: 'res', id: m.id, status: 200, type: 'application/zip', chunked: true }));
        for (let seq = 0; seq < 50; seq++) me.ws.send(JSON.stringify({ t: 'chunk', id: m.id, seq, data: part }));
        return false; // never ends
      }
    });
    const id = p.auth.id;
    const answers = [0, 1].map(() => t.link.request(id, { method: 'GET', path: '/api/system/backups' }));
    const first = await Promise.race([...answers, wait(15_000).then(() => null)]);
    assert.equal(first?.status, 502);
    assert.ok(first, 'one of them was stopped');
    assert.match(first.error, /too much at once/);
  } finally { await t.close(); }
});

test('proxy checks: the bluetooth log in every form, setup bodies that could start a new line, and 1xx answers', () => {
  for (const p of ['/logs/bluetooth', '/logs/bluetooth/page', '/logs/bluetooth/tail']) assert.equal(L.proxyTarget('GET', p).status, 403, p);
  assert.equal(L.proxyTarget('GET', '/logs/syslog'), '/api/logs/syslog');
  assert.equal(L.badSetupBody({ SSID: 'Home', WIFIPASS: '', WIFIPASS__set: true, ARCHIVE_DELAY: 20, X: false }), null);
  for (const b of [null, [], 'SSID=x', { SSID: 'Home\nexport PATH=/tmp' }, { SSID: 'a\rb' }, { SSID: 'a\u0000' }, { ssid: 'x' }, { 'A B': 'x' }, { SSID: { value: 'x' } }, { SSID: 'x'.repeat(5000) }]) {
    assert.ok(L.badSetupBody(b), JSON.stringify(b).slice(0, 60));
  }
  assert.deepEqual([100, 101, 199, 200, 204, 401, 407, 404, 500].map(L.answerStatus), [502, 502, 502, 200, 204, 502, 502, 404, 500]);
});
