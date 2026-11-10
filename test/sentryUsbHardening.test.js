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
  const pi = async (o) => { const p = await connectFakePi({ port, iterations: 1000, ...o }); pis.push(p); return p; };
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
