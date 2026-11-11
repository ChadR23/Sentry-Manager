'use strict';

// The Sentry USB management link (docs/sentry-usb-link.md): the handshake both
// ways, wrong proofs and fingerprints, the pairing slot, rate limits, the
// allowlist, chunked answers, request limits and a misbehaving Pi.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { TlsManager } = require('../server/tls');
const L = require('../server/sentryUsbLink');
const { encodeFrame } = require('../server/wsFrames');
const { connectFakePi, sendAnswer } = require('./fixtures/fakeSentryUsb');

const quiet = { info() {}, warn() {}, debug() {} };
const memDb = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? structuredClone(m.get(k)) : f), set: (k, v) => m.set(k, structuredClone(v)), raw: m };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ITER = 1000; // fast in tests; the real count is checked against the test vector below

let material = null;
async function certs() {
  if (material) return material;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-link-'));
  const t = new TlsManager({ dir: path.join(dir, 'tls'), log: quiet, hostnames: ['127.0.0.1'] });
  await t.ensure();
  material = { key: fs.readFileSync(path.join(dir, 'tls', 'server.key')), cert: fs.readFileSync(path.join(dir, 'tls', 'server.crt')) };
  return material;
}

async function setup(opts = {}) {
  const m = await certs();
  const db = opts.db || memDb();
  const link = L.createSentryUsbLink({ db, log: quiet, iterations: ITER, ...opts });
  const srv = https.createServer({ key: m.key, cert: m.cert, minVersion: 'TLSv1.2' }, (req, res) => { res.writeHead(404); res.end(); });
  srv.on('upgrade', (req, socket, head) => link.handleUpgrade(req, socket, head));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const pis = [];
  const pi = async (o) => { const p = await connectFakePi({ port, iterations: ITER, ...o }); pis.push(p); return p; };
  const close = async () => { link.close(); for (const p of pis) p.ws?.terminate(); srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); };
  return { db, link, port, pi, close };
}
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await wait(20); }
};

test('pairing: the Pi proves K, gets a link key; later connections use the key, both sides prove themselves', async () => {
  const t = await setup();
  try {
    await t.link.openPairing({ name: 'Model 3', username: 'pi', password: 'raspberry' });
    assert.equal(t.link.wanted(), true, 'the port listens while a slot is open');
    const p = await t.pi({ mode: 'pair', username: 'pi', password: 'raspberry' });
    assert.equal(p.result, 'ok', 'the Pi checked Manager\'s proof too');
    assert.match(p.linkKey, /^[0-9a-f]{64}$/);
    assert.equal(p.hello.v, 1);
    assert.equal(p.hello.fp, p.fp, 'hello carries the certificate the TLS session uses');
    assert.equal(t.link.pairing().open, false, 'the slot is used once');
    assert.equal(t.link.pairing().last.ok, true);
    await until(() => t.link.devices()[0]?.status);
    const d = t.link.devices()[0];
    assert.equal(d.name, 'Model 3');
    assert.equal(d.online, true);
    assert.equal(d.version, 'v3.28.10-test.7');
    assert.equal(d.status.sbc_model, 'Raspberry Pi 4 Model B Rev 1.5');
    // the key is stored, never shown
    assert.equal(t.db.get('sentryusb').devices[0].key, p.linkKey);
    assert.equal(JSON.stringify(t.link.devices()).includes(p.linkKey), false);
    assert.equal(JSON.stringify(t.link.pairing()).includes(p.linkKey), false);
    p.close();
    await until(() => !t.link.devices()[0].online);
    const again = await t.pi({ mode: 'key', key: p.linkKey, pin: p.fp });
    assert.equal(again.result, 'ok');
    // a key-mode Pi with a wrong key: not paired
    const wrong = await t.pi({ mode: 'key', key: crypto.randomBytes(32).toString('hex') });
    assert.deepEqual([wrong.result, wrong.why], ['denied', 'not paired']);
  } finally { await t.close(); }
});

test('pairing: a wrong password, no slot, a man in the middle (other fingerprint) and a bad Manager proof all fail', async () => {
  const t = await setup();
  try {
    const none = await t.pi({ mode: 'pair', username: 'pi', password: 'raspberry' });
    assert.deepEqual([none.result, none.why], ['denied', 'no pairing open']);
    await t.link.openPairing({ name: 'Car', username: 'pi', password: 'raspberry' });
    const wrong = await t.pi({ mode: 'pair', username: 'pi', password: 'nope' });
    assert.deepEqual([wrong.result, wrong.why], ['denied', 'wrong password']);
    assert.equal(t.link.pairing().last.why, 'wrong password');
    // the Pi saw another certificate (something in between): its proof covers that one
    const mitm = await t.pi({ mode: 'pair', username: 'pi', password: 'raspberry', tamper: { fp: 'ab'.repeat(32) } });
    assert.deepEqual([mitm.result, mitm.why], ['denied', 'wrong password']);
    assert.equal(t.link.devices().length, 0);
    // a Pi that pinned another fingerprint does not even start
    const pinned = await t.pi({ mode: 'key', key: '00'.repeat(32), pin: 'cd'.repeat(32) });
    assert.equal(pinned.result, 'pin mismatch');
    // still open after 2 failures; the right password pairs
    assert.equal(t.link.pairing().open, true);
    const ok = await t.pi({ mode: 'pair', username: 'pi', password: 'raspberry' });
    assert.equal(ok.result, 'ok');
  } finally { await t.close(); }
});

test('pairing: the slot expires, and closes after 5 wrong passwords', async () => {
  const t = await setup({ slotMs: 150 });
  try {
    await t.link.openPairing({ name: 'Car', username: 'pi', password: 'raspberry' });
    await wait(250);
    assert.equal(t.link.pairing().open, false);
    assert.equal(t.link.pairing().last.why, 'expired');
    assert.equal(t.link.wanted(), false, 'nothing paired, no slot: the port may close');
    const late = await t.pi({ mode: 'pair', username: 'pi', password: 'raspberry' });
    assert.equal(late.why, 'no pairing open');
  } finally { await t.close(); }
  const u = await setup();
  try {
    await u.link.openPairing({ name: 'Car', username: 'pi', password: 'raspberry' });
    for (let i = 0; i < L.SLOT_FAILURES; i++) assert.equal((await u.pi({ mode: 'pair', username: 'pi', password: `guess${i}` })).why, 'wrong password');
    assert.equal(u.link.pairing().open, false, 'brute force closes the slot');
    assert.equal(u.link.pairing().last.why, 'too many tries');
    assert.equal((await u.pi({ mode: 'pair', username: 'pi', password: 'raspberry' })).why, 'no pairing open', 'even the right password is too late');
  } finally { await u.close(); }
});

test('handshake: at most 10 failures a minute per address, then the upgrade is refused', async () => {
  const t = await setup();
  try {
    for (let i = 0; i < L.FAILS_PER_MINUTE; i++) assert.equal((await t.pi({ mode: 'key', key: '11'.repeat(32) })).why, 'not paired');
    const next = await t.pi({ mode: 'key', key: '11'.repeat(32) });
    assert.deepEqual([next.result, next.httpStatus], ['refused', 429]);
  } finally { await t.close(); }
});

test('handshake: replays, other ids, bad versions, early frames and silence are refused', async () => {
  const t = await setup({ handshakeMs: 300 });
  try {
    await t.link.openPairing({ name: 'A', username: 'pi', password: 'pw-a' });
    const a = await t.pi({ id: 'pi-aaaaaaaaaaaaaaaa', mode: 'pair', username: 'pi', password: 'pw-a' });
    await t.link.openPairing({ name: 'B', username: 'pi', password: 'pw-b' });
    const b = await t.pi({ id: 'pi-bbbbbbbbbbbbbbbb', mode: 'pair', username: 'pi', password: 'pw-b' });
    assert.equal(a.result, 'ok');
    assert.equal(b.result, 'ok');
    // B with its own key, claiming to be A
    const imp = await t.pi({ id: 'pi-aaaaaaaaaaaaaaaa', mode: 'key', key: b.linkKey });
    assert.equal(imp.why, 'not paired');
    // a recorded auth sent again: the new hello has a new nonce, so the proof is stale
    const replay = await t.pi({ id: 'pi-aaaaaaaaaaaaaaaa', mode: 'key', key: '00'.repeat(32), tamper: { proof: a.auth.proof, nonce: a.auth.nonce } });
    assert.equal(replay.why, 'not paired');
    // the Pi's nonce may not be Manager's own (a reflected hello)
    const v2 = await t.pi({ mode: 'key', key: a.linkKey, id: 'pi-aaaaaaaaaaaaaaaa', tamper: { v: 2 } });
    assert.equal(v2.why, 'version');
    const early = await t.pi({ mode: 'key', key: a.linkKey, tamper: { frameFirst: true } });
    assert.equal(early.why, 'bad message');
    // connects and says nothing: closed after the handshake time
    const silent = await new Promise((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: t.port, rejectUnauthorized: false }, () => {
        s.write(`GET /api/sentryusb/link HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let got = '';
      s.on('data', (c) => { got += c.toString('latin1'); });
      s.on('close', () => resolve(got));
    });
    assert.match(silent, /"why":"timeout"/);
    // one connection per Pi: a new one replaces the old
    const a2 = await t.pi({ id: 'pi-aaaaaaaaaaaaaaaa', mode: 'key', key: a.linkKey });
    assert.equal(a2.result, 'ok');
    await until(() => a.ws.closed);
    assert.equal(a.closedCode, 4000);
  } finally { await t.close(); }
});

test('the link: only the link path upgrades, other paths and plain requests get nothing', async () => {
  const t = await setup();
  try {
    const other = await t.pi({ path: '/api/sentryusb/devices', mode: 'key', key: '00'.repeat(32) });
    assert.deepEqual([other.result, other.httpStatus], ['refused', 404]);
  } finally { await t.close(); }
});

test('allowlist: Manager\'s copy refuses other routes and path tricks', () => {
  const ok = (m, p) => assert.equal(L.proxyTarget(m, p), `/api${p}`, `${m} ${p}`);
  const no = (m, p, status) => { const r = L.proxyTarget(m, p); assert.ok(r instanceof Error, `${m} ${p} refused`); if (status) assert.equal(r.status, status, `${m} ${p}`); };
  ok('GET', '/status');
  ok('PUT', '/setup/config');
  ok('GET', '/logs/archiveloop/tail');
  ok('DELETE', '/snapshots/snap-000042');
  no('GET', '/system/backup/2026-11-10', 403); // a backup holds every secret: it never leaves the Pi
  no('GET', '/logs', 403); // no such route on the Pi
  no('GET', '/manager-link/status', 403);
  no('POST', '/status', 403); // wrong method
  no('GET', '/terminal', 403);
  no('POST', '/auth/login', 403);
  no('POST', '/system/restore', 403);
  no('DELETE', '/files', 403);
  no('POST', '/system/ble-pair', 403);
  no('GET', '/system/ssh-pubkey', 403);
  no('POST', '/lockchime/community/admin/validate', 403);
  no('GET', '/logs/bluetooth/bundle', 403);
  no('GET', '/logs/../auth/check', 400);
  no('GET', '/logs/%2e%2e/auth', 400);
  no('GET', '/logs%2Fsyslog', 400);
  no('GET', '/logs/a%2fb/tail', 400);
  no('GET', '//status', 400);
  no('GET', '/status/', 400);
  no('GET', '/./status', 400);
  no('GET', '/logs\\..\\x', 400);
  no('GET', '/logs/a\u0000', 400);
  no('GET', 'status', 400);
  no('GET', '/logs/..', 400);
  no('DELETE', '/snapshots/..', 400);
  no('GET', '/system/backup/..', 400);
  ok('POST', '/system/backup');
  ok('GET', '/system/backups');
});

test('requests: answers inline, in base64 and in chunks; 8 in flight; 60 s timeout; the 64 MiB cap', async () => {
  const t = await setup({ requestMs: 300 });
  try {
    await t.link.openPairing({ name: 'Car', username: 'pi', password: 'raspberry' });
    const big = crypto.randomBytes(3 * 1024 * 1024 + 17);
    const hold = [];
    const p = await t.pi({
      mode: 'pair', username: 'pi', password: 'raspberry',
      onRequest: (m) => {
        if (m.path === '/api/status/storage') { hold.push(m); return false; } // never answered
        return true;
      },
      answer: (m) => (m.path === '/api/diagnostics' ? { status: 200, type: 'application/zip', buf: big } : null)
    });
    const id = p.auth.id;
    const st = await t.link.request(id, { method: 'GET', path: '/api/status' });
    assert.equal(st.status, 200);
    assert.equal(st.body.drives_active, 'yes');
    const zip = await t.link.request(id, { method: 'GET', path: '/api/diagnostics' });
    assert.equal(zip.type, 'application/zip');
    assert.ok(zip.buf.equals(big), 'four chunks put back together');
    // 8 waiting: the 9th is refused at once; after the timeout they are free again
    const waiting = Array.from({ length: L.MAX_IN_FLIGHT }, () => t.link.request(id, { method: 'GET', path: '/api/status/storage' }));
    const ninth = await t.link.request(id, { method: 'GET', path: '/api/status' });
    assert.equal(ninth.status, 429);
    const timedOut = await Promise.all(waiting);
    assert.ok(timedOut.every((r) => r.status === 504));
    assert.equal((await t.link.request(id, { method: 'GET', path: '/api/status' })).status, 200);
    // offline and unknown Pis
    assert.equal((await t.link.request('pi-nobody-0000000', { method: 'GET', path: '/api/status' })).status, 404);
  } finally { await t.close(); }
});

test('a misbehaving Pi: endless chunks stop at 64 MiB, stray answers and garbage close it, a huge frame is refused unread', async () => {
  const t = await setup({ requestMs: 5000 });
  try {
    await t.link.openPairing({ name: 'Car', username: 'pi', password: 'raspberry' });
    const MIB = 1024 * 1024;
    const p = await t.pi({
      mode: 'pair', username: 'pi', password: 'raspberry',
      onRequest: (m, me) => {
        if (m.path !== '/api/system/backups') return true;
        // chunks for ever (65 of 1 MiB)
        me.ws.send(JSON.stringify({ t: 'res', id: m.id, status: 200, type: 'application/zip', chunked: true }));
        const part = Buffer.alloc(MIB, 7).toString('base64');
        for (let seq = 0; seq < 65; seq++) me.ws.send(JSON.stringify({ t: 'chunk', id: m.id, seq, data: part }));
        return false;
      }
    });
    const id = p.auth.id;
    const capped = await t.link.request(id, { method: 'GET', path: '/api/system/backups' });
    assert.equal(capped.status, 502);
    assert.match(capped.error, /64 MiB/);
    // answers for request ids it was never sent: ignored, then closed after many
    for (let i = 0; i < 25; i++) p.send({ t: 'res', id: `x${i}`, status: 200, body: {} });
    await until(() => p.ws.closed);
    await until(() => !t.link.devices()[0].online);
    assert.match(t.link.devices()[0].protocolError.why, /not asked/);

    // a frame header announcing 100 MiB: closed with 1009 without reading it
    const q = await t.pi({ mode: 'key', key: p.linkKey, id });
    const hdr = Buffer.alloc(14);
    hdr[0] = 0x81; hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(100 * MIB), 2);
    q.ws.socket.write(hdr);
    await until(() => q.ws.closed);
    assert.equal(q.closedCode, 1009);

    // an unmasked frame from a client is a protocol error
    const r = await t.pi({ mode: 'key', key: p.linkKey, id });
    r.ws.socket.write(encodeFrame(0x1, '{"t":"status","body":{}}', false));
    await until(() => r.ws.closed);
    assert.equal(r.closedCode, 1002);

    // before the handshake, frames over 16 KiB are refused
    const s = await new Promise((resolve) => {
      const sock = tls.connect({ host: '127.0.0.1', port: t.port, rejectUnauthorized: false }, () => {
        sock.write(`GET /api/sentryusb/link HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        setTimeout(() => sock.write(encodeFrame(0x1, 'x'.repeat(20000), true)), 50);
      });
      let got = Buffer.alloc(0);
      sock.on('data', (c) => { got = Buffer.concat([got, c]); });
      sock.on('close', () => resolve(got));
    });
    const closeAt = s.lastIndexOf(Buffer.from([0x88]));
    assert.ok(closeAt > 0 && s.readUInt16BE(closeAt + 2) === 1009, 'closed as too large');

    // binary frames and broken JSON after the handshake close it
    const u = await t.pi({ mode: 'key', key: p.linkKey, id });
    u.ws.socket.write(encodeFrame(0x2, Buffer.from([1, 2, 3]), true));
    await until(() => u.ws.closed);
    assert.equal(u.closedCode, 1003);
  } finally { await t.close(); }
});

test('WebSocket: ping is answered with pong, fragmented messages are joined, and close is echoed', async () => {
  const t = await setup();
  try {
    await t.link.openPairing({ name: 'Car', username: 'pi', password: 'raspberry' });
    const p = await t.pi({ mode: 'pair', username: 'pi', password: 'raspberry', status: false });
    const pong = new Promise((r) => p.ws.once('pong', r));
    p.ws.socket.write(encodeFrame(0x9, 'hi', true));
    await pong;
    // a status in two fragments
    const text = JSON.stringify({ t: 'status', body: { uptime: '12' } });
    const a = encodeFrame(0x1, text.slice(0, 10), true); a[0] = 0x01; // not FIN
    const b = encodeFrame(0x0, text.slice(10), true); // continuation, FIN
    p.ws.socket.write(Buffer.concat([a, b]));
    await until(() => t.link.devices()[0]?.status?.uptime === '12');
    p.close();
    await until(() => p.ws.closed);
    assert.equal(p.closedCode, 1000, 'the close was answered');
  } finally { await t.close(); }
});

test('unpair deletes the key and closes the link; the next handshake fails', async () => {
  const t = await setup();
  try {
    await t.link.openPairing({ name: 'Car', username: 'pi', password: 'raspberry' });
    const p = await t.pi({ mode: 'pair', username: 'pi', password: 'raspberry' });
    assert.equal(t.link.unpair(p.auth.id), true);
    await until(() => p.ws.closed);
    assert.equal(t.link.devices().length, 0);
    assert.equal(t.link.wanted(), false);
    assert.equal((await t.pi({ mode: 'key', key: p.linkKey, id: p.auth.id })).why, 'not paired');
    // a snapshot of the settings keeps no key
    assert.deepEqual(L.withoutKeys({ devices: [{ id: 'x', key: 'secret', name: 'n' }] }), { devices: [{ id: 'x', name: 'n' }] });
  } finally { await t.close(); }
});

test('unpaired on the Pi: its close with 4001 makes Manager forget it too; a 1000 close does not', async () => {
  const events = [];
  const t = await setup({ onEvent: (e) => events.push(e) });
  try {
    await t.link.openPairing({ name: 'Car', username: 'pi', password: 'raspberry' });
    const p = await t.pi({ mode: 'pair', username: 'pi', password: 'raspberry' });
    // an ordinary close (the Pi turned off, a settings change): still paired
    p.close();
    await until(() => p.ws.closed);
    await until(() => !t.link.devices()[0]?.online);
    assert.equal(t.link.devices()[0].paired, true);
    const q = await t.pi({ mode: 'key', key: p.linkKey, id: p.auth.id });
    assert.equal(q.result, 'ok');
    q.ws.close(4001, 'unpaired');
    await until(() => t.link.devices().length === 0);
    const un = events.find((e) => e.type === 'unpaired');
    assert.deepEqual([un.id, un.byPi], [p.auth.id, true]);
    assert.equal((await t.pi({ mode: 'key', key: p.linkKey, id: p.auth.id })).why, 'not paired');
  } finally { await t.close(); }
});

test('K and the proofs are computed as the contract says (fixed values)', async () => {
  const k = await L.pairingKey('pi', 'raspberry');
  const again = crypto.pbkdf2Sync('raspberry', 'sentryusb-link|pi', 200000, 32, 'sha256');
  assert.ok(k.equals(again));
  const mn = '11'.repeat(32);
  const pn = '22'.repeat(32);
  const fp = '33'.repeat(32);
  const id = 'pi-0123456789abcdef';
  assert.equal(L.piProof(k, mn, pn, fp, id), crypto.createHmac('sha256', k).update(`pi|${mn}|${pn}|${fp}|${id}`).digest('hex'));
  assert.equal(L.managerProof(k, mn, pn, fp, id), crypto.createHmac('sha256', k).update(`mgr|${pn}|${mn}|${fp}|${id}`).digest('hex'));
  assert.notEqual(L.piProof(k, mn, pn, fp, id), L.managerProof(k, mn, pn, fp, id));
  assert.equal(L.sameHex('zz', 'aa'.repeat(32)), false);
  assert.equal(L.fpHex('AB:CD'), 'abcd');
  assert.equal(L.fpGroups('abcd'), 'ABCD');
  // the fake Pi's answers come chunked like the real Pi's
  const sent = [];
  sendAnswer({ send: (s) => sent.push(JSON.parse(s)) }, 'r1', { status: 200, type: 'application/zip', buf: Buffer.alloc(2 * 1024 * 1024 + 1) });
  assert.deepEqual(sent.map((f) => f.t), ['res', 'chunk', 'chunk', 'chunk', 'end']);
});

// Appendix A of the contract (docs/sentry-usb-link.md): the Pi's tests check the same values
test('the contract\'s test vectors: K, both proofs in pair and key mode, the fingerprint shown', async () => {
  const k = await L.pairingKey('admin', 'correct horse battery staple');
  assert.equal(k.toString('hex'), '42dbcc8ba07c3b03314a2cec3c9cae2adf011049eb445394ef1d3a11b94f6205');
  const mn = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  const pn = '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f';
  const fp = crypto.createHash('sha256').update('sentry-manager test certificate').digest('hex');
  assert.equal(fp, '61ecb6872005d76f9c85b9abee8c635c413381103bf5df251ec263fc331d6c27');
  const id = '0123456789abcdef0123456789abcdef';
  const linkKey = Buffer.from('404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f', 'hex');
  assert.equal(L.piProof(k, mn, pn, fp, id), '1425df08a1362d43a7d44a6059ba7f078df99375d282bc35221ccd364acebbcf');
  assert.equal(L.managerProof(k, mn, pn, fp, id), '2f864f5224cad380d328c3b8fa62104855ca1ce1eaaccf5dc12a49535cd2ce1e');
  assert.equal(L.piProof(linkKey, mn, pn, fp, id), '852e6aa89c5f0fd2bd95f2ab6471d17353ffa98b3782d8b014db20c9bf865e50');
  assert.equal(L.managerProof(linkKey, mn, pn, fp, id), 'cc691f70debff4e37baa54f32bdd250a5fcdfa8efcffeca8f1c7de92a2c54bef');
  assert.equal(L.fpGroups(fp), '61EC B687 2005 D76F 9C85 B9AB EE8C 635C 4133 8110 3BF5 DF25 1EC2 63FC 331D 6C27');
  // upper-case hex is not the same proof: only lower case is accepted
  assert.equal(L.sameHex('1425DF08A1362D43A7D44A6059BA7F078DF99375D282BC35221CCD364ACEBBCF', '1425df08a1362d43a7d44a6059ba7f078df99375d282bc35221ccd364acebbcf'), false);
});

test('an answer the Pi ends with an error ("too large", "read failed") fails; a JSON ping is answered', async () => {
  const t = await setup();
  try {
    await t.link.openPairing({ name: 'Car', username: 'pi', password: 'raspberry' });
    const p = await t.pi({
      mode: 'pair', username: 'pi', password: 'raspberry',
      onRequest: (m, me) => {
        me.ws.send(JSON.stringify({ t: 'res', id: m.id, status: 200, type: 'text/plain', chunked: true }));
        me.ws.send(JSON.stringify({ t: 'chunk', id: m.id, seq: 0, data: Buffer.from('partial').toString('base64') }));
        me.ws.send(JSON.stringify({ t: 'end', id: m.id, error: 'read failed' }));
        return false;
      }
    });
    const r = await t.link.request(p.auth.id, { method: 'GET', path: '/api/logs/syslog' });
    assert.equal(r.status, 502);
    assert.match(r.error, /read failed/);
    const pong = new Promise((resolve) => p.ws.on('message', (txt) => { if (JSON.parse(txt).t === 'pong') resolve(); }));
    p.send({ t: 'ping' });
    await pong;
  } finally { await t.close(); }
});
