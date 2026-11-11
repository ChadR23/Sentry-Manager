'use strict';

// The Sentry USB link through the whole server: pairing needs a fresh
// password confirmation and Manager's own HTTPS, the device port says nothing
// to strangers, the proxy checks the allowlist on the raw path, watch-only
// accounts only read, and the link key is in no API answer, log or support
// bundle.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { readZip } = require('../server/zip');
const { connectFakePi } = require('./fixtures/fakeSentryUsb');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const hasOpenssl = require('node:child_process').spawnSync('openssl', ['version']).status === 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// one request as sent: the path goes out exactly as given (no normalizing)
function req(port, method, p, { body, cookie, headers = {}, tls = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = (tls ? https : http).request({
      host: '127.0.0.1', port, method, path: p, rejectUnauthorized: false,
      headers: { Host: `127.0.0.1:${port}`, 'X-Requested-With': 'sentry-six-manager', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8'), json, cookie: (res.headers['set-cookie'] || [])[0]?.split(';')[0] });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function start(env = {}, reuse = null) {
  const dir = reuse || await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-sul-'));
  fs.mkdirSync(path.join(dir, 'footage'), { recursive: true });
  const port = await freePort();
  const canPort = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env, PORT: String(port), CAN_PORT: String(canPort), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC', LOG_LEVEL: 'debug', TLS_HOSTNAMES: '127.0.0.1', UPDATE_CHECK: 'off', ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const tls = env.TLS_MODE !== 'off';
  for (let i = 0; i < 200; i++) {
    try { if ((await req(port, 'GET', '/healthz', { tls })).status === 200) break; } catch { /* not up yet */ }
    await wait(100);
  }
  const login = async (username, password) => (await req(port, 'POST', '/api/auth/login', { body: { username, password }, tls })).cookie;
  const stop = () => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); return undefined; });
  return { dir, port, canPort, tls, login, stop, output: () => output, call: (m, p, o = {}) => req(port, m, p, { tls, ...o }) };
}

test('the Sentry USB link through the server', { skip: !hasOpenssl, timeout: 120_000 }, async () => {
  // signed in before a restart: the session lives on, its fresh confirmation does not
  const s0 = await start();
  const admin = await s0.login('admin', 'correct horse');
  assert.ok(admin, 'signed in');
  await s0.stop();
  const s = await start({}, s0.dir);
  let pi = null;
  try {
    // signed out: nothing about devices
    assert.equal((await s.call('GET', '/api/sentryusb')).status, 401);
    // the device port is closed: nothing is paired, CAN uploads are off
    await assert.rejects(req(s.canPort, 'GET', '/'), /ECONNREFUSED/);

    // pairing needs the password again, the CSRF header and a name/user/password
    const fresh = await s.call('POST', '/api/sentryusb/pair', { cookie: admin, body: { name: 'Model 3', username: 'pi', password: 'raspberry' } });
    assert.equal(fresh.status, 403);
    assert.equal(fresh.json.code, 'CONFIRM_PASSWORD');
    assert.equal((await s.call('POST', '/api/auth/confirm', { cookie: admin, body: { password: 'correct horse' } })).status, 200);
    const csrf = await s.call('POST', '/api/sentryusb/pair', { cookie: admin, body: { name: 'Model 3', username: 'pi', password: 'raspberry' }, headers: { 'X-Requested-With': 'x' } });
    assert.equal(csrf.status, 403);
    const cross = await s.call('POST', '/api/sentryusb/pair', { cookie: admin, body: { name: 'Model 3', username: 'pi', password: 'raspberry' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
    const pair = await s.call('POST', '/api/sentryusb/pair', { cookie: admin, body: { name: 'Model 3', username: 'pi', password: 'raspberry' } });
    assert.equal(pair.status, 200, pair.text);
    assert.equal(pair.json.pairing.open, true);
    assert.match(pair.json.fingerprint, /^([0-9A-F]{4} ){15}[0-9A-F]{4}$/, '16 groups of 4, as the Pi shows it');
    assert.equal(pair.text.includes('raspberry'), false, 'the password is not sent back');

    // the device port now listens, and says nothing to a stranger
    const stranger = await req(s.canPort, 'GET', '/');
    assert.equal(stranger.status, 404);
    assert.equal(/version|sentry|manager/i.test(stranger.text + JSON.stringify(stranger.headers)), false, stranger.text);
    assert.equal((await req(s.canPort, 'GET', '/api/sentryusb/link')).status, 404, 'no WebSocket, nothing');
    assert.equal((await req(s.canPort, 'GET', '/api/sentryusb')).status, 404, 'no device list on the device port');
    // and the link is not on the main port
    const onMain = await connectFakePi({ port: s.port, mode: 'pair', username: 'pi', password: 'raspberry' }).catch((err) => ({ result: err.message }));
    assert.notEqual(onMain.result, 'ok');

    pi = await connectFakePi({ port: s.canPort, mode: 'pair', username: 'pi', password: 'raspberry' });
    const piSince = Date.now();
    assert.equal(pi.result, 'ok');
    assert.equal(pi.fp, pair.json.fingerprint.replace(/ /g, '').toLowerCase(), 'the fingerprint shown is the device port\'s certificate');
    let list;
    for (let i = 0; i < 50; i++) { list = await s.call('GET', '/api/sentryusb', { cookie: admin }); if (list.json.devices[0]?.status) break; await wait(100); }
    const d = list.json.devices[0];
    assert.equal(d.online, true);
    assert.equal(d.name, 'Model 3');
    assert.equal(list.json.pairing.last.ok, true);
    assert.equal(list.text.includes(pi.linkKey), false, 'the key is in no answer');
    const id = d.id;
    const P = `/api/sentryusb/${id}/proxy`;

    // the proxy: allowlisted routes only, on the raw path
    const st = await s.call('GET', `${P}/status`, { cookie: admin });
    assert.equal(st.status, 200);
    assert.equal(st.json.drives_active, 'yes');
    const cfg = await s.call('GET', `${P}/setup/config`, { cookie: admin });
    assert.equal(cfg.json.WIFIPASS.value, '');
    assert.equal(cfg.json.WIFIPASS__set, true);
    const diag = await s.call('POST', `${P}/diagnostics/download`, { cookie: admin, body: {} });
    assert.equal(diag.status, 200);
    assert.match(diag.headers['content-disposition'], /^attachment; filename="sentryusb-model-3-diagnostics-download\.txt"$/);
    assert.equal(diag.headers['x-content-type-options'], 'nosniff');
    assert.match(diag.headers['content-security-policy'], /sandbox/);
    for (const [m, p, want] of [
      ['POST', `${P}/auth/login`, 403], ['GET', `${P}/terminal`, 403], ['POST', `${P}/system/restore`, 403], ['GET', `${P}/files/ls`, 403],
      ['GET', `${P}/logs/%2e%2e/auth/check`, 400], ['GET', `${P}/logs%2Fsyslog`, 400], ['GET', `${P}//status`, 400], ['GET', `${P}/status?x=<script>`, 400],
      ['GET', `/api/sentryusb/${id}/proxy/../../auth/me`, 404] // the URL resolves the dots before routing: no route, not the Pi
    ]) {
      const r = await s.call(m, p, { cookie: admin, ...(m === 'POST' ? { body: {} } : {}) });
      assert.equal(r.status, want, `${m} ${p}: ${r.text}`);
    }
    assert.ok(pi.requests.every((x) => !/auth|terminal|restore|files/.test(x.path)), 'nothing off the list reached the Pi');
    // the Pi's 400 naming a key reaches the page (changed destinations need their secrets again)
    const put = await s.call('PUT', `${P}/setup/config`, { cookie: admin, body: { SSID: 'x' } });
    assert.equal(put.status, 400);
    assert.match(put.json.error, /needs (WIFIPASS|SHARE_PASSWORD) sent again/);
    // a value that would start a new line in sentryusb.conf stops here, before the Pi
    const sent = pi.requests.length;
    const nl = await s.call('PUT', `${P}/setup/config`, { cookie: admin, body: { SSID: 'Home\nexport LD_PRELOAD=/tmp/x.so' } });
    assert.equal(nl.status, 400);
    assert.equal(pi.requests.length, sent, 'not sent to the Pi');

    // a watch-only account reads, and cannot change anything
    assert.equal((await s.call('POST', '/api/accounts', { cookie: admin, body: { username: 'watcher', password: 'watching123', role: 'viewer' } })).status, 200);
    const viewer = await s.login('watcher', 'watching123');
    assert.equal((await s.call('GET', '/api/sentryusb', { cookie: viewer })).status, 200);
    assert.equal((await s.call('GET', `${P}/status`, { cookie: viewer })).status, 200);
    for (const [m, p] of [['POST', `${P}/system/reboot`], ['PUT', `${P}/setup/config`], ['DELETE', `${P}/snapshots/snap-000041`], ['POST', '/api/sentryusb/pair'],
      ['DELETE', `/api/sentryusb/${id}`], ['PATCH', `/api/sentryusb/${id}`], ['POST', `/api/sentryusb/${id}/queue`], ['GET', `${P}/system/backup/2026-11-03`], ['GET', `/api/sentryusb/${id}/files/x.txt`]]) {
      const r = await s.call(m, p, { cookie: viewer, ...(m === 'GET' ? {} : { body: { kind: 'reboot', name: 'x' } }) });
      assert.equal(r.status, 403, `viewer ${m} ${p}: ${r.text}`);
    }
    assert.equal(pi.state.reboots || 0, 0);
    // its logs, diagnostics, settings and backups list are for admins, as Manager's own are
    for (const p of [`${P}/logs/auth`, `${P}/logs/syslog/tail`, `${P}/diagnostics`, `${P}/setup/config`, `${P}/notifications/settings`, `${P}/system/backups`, `/api/sentryusb/${id}/last-config`]) {
      const r = await s.call('GET', p, { cookie: viewer });
      assert.equal(r.status, 403, `viewer GET ${p}: ${r.text}`);
    }
    // and where it connects from, with the networks it reports
    const seen = (await s.call('GET', '/api/sentryusb', { cookie: viewer })).json.devices[0];
    assert.deepEqual([seen.address, seen.net, seen.home], [null, null, null]);
    assert.ok((await s.call('GET', '/api/sentryusb', { cookie: admin })).json.devices[0].address, 'an admin sees it');

    // a queued action (online: it runs at once); its fetched file downloads as an attachment
    const q = await s.call('POST', `/api/sentryusb/${id}/queue`, { cookie: admin, body: { kind: 'diagnostics' } });
    assert.equal(q.status, 200, q.text);
    let ql;
    for (let i = 0; i < 50; i++) { ql = await s.call('GET', `/api/sentryusb/${id}/queue`, { cookie: admin }); if (ql.json.files.length) break; await wait(100); }
    const f = await s.call('GET', `/api/sentryusb/${id}/files/${ql.json.files[0].name}`, { cookie: admin });
    assert.equal(f.status, 200);
    assert.match(f.headers['content-disposition'], /^attachment/);
    assert.ok([400, 404].includes((await s.call('GET', `/api/sentryusb/${id}/files/..%2Fmanager.db`, { cookie: admin })).status));

    // the key is in no log and no support bundle
    const bundle = await s.call('GET', '/api/support-bundle', { cookie: admin });
    assert.equal(bundle.status, 200);
    for (const e of readZip(bundle.buf)) assert.equal(e.data.toString('utf8').includes(pi.linkKey), false, e.name);
    await wait(300);
    const logs = fs.readFileSync(path.join(s.dir, 'data', 'logs', 'manager.log'), 'utf8') + s.output();
    assert.equal(logs.includes(pi.linkKey), false, 'no key in the logs');
    assert.equal(logs.includes('raspberry'), false, 'no Pi password in the logs');
    assert.match(logs, /Sentry USB "Model 3": POST \/api\/diagnostics\/download: admin/, 'actions are logged: who, which Pi, which route');
    // a database snapshot keeps no key
    assert.equal((await s.call('POST', '/api/snapshots', { cookie: admin, body: {} })).status, 200);
    const snapDir = path.join(s.dir, 'data', 'snapshots');
    for (const n of fs.readdirSync(snapDir)) assert.equal(fs.readFileSync(path.join(snapDir, n)).includes(Buffer.from(pi.linkKey)), false, n);

    // a link outlives the device port's 15-second first-request timer (TLS: cleared by the upgrade)
    while (Date.now() - piSince < 16_500) await wait(250);
    assert.equal(pi.ws.closed, false, 'still connected after 16 s');
    assert.equal((await s.call('GET', '/api/sentryusb', { cookie: admin })).json.devices[0].online, true);

    // a live save with a password still works (the page sends every active line)
    const cur = (await s.call('GET', `${P}/setup/config`, { cookie: admin })).json;
    const all = Object.fromEntries(Object.entries(cur).filter(([k, v]) => !k.endsWith('__set') && v && typeof v === 'object' && v.active).map(([k, v]) => [k, v.value]));
    const live = await s.call('PUT', `${P}/setup/config`, { cookie: admin, body: { ...all, SSID: 'CabinNet', WIFIPASS: 'live-wifi-pass-31' } });
    assert.equal(live.status, 200, live.text);
    assert.deepEqual([pi.state.config.SSID, pi.state.config.WIFIPASS], ['CabinNet', 'live-wifi-pass-31']);

    // away: password changes are never queued; a mix queues the rest and says why
    pi.ws.terminate();
    for (let i = 0; i < 50; i++) { if (!(await s.call('GET', '/api/sentryusb', { cookie: admin })).json.devices[0].online) break; await wait(100); }
    const Q = `/api/sentryusb/${id}/queue`;
    const only = await s.call('POST', Q, { cookie: admin, body: { kind: 'settings', params: { changes: { WIFIPASS: { from: null, to: 'queued-wifi-pass-77', secret: true } } } } });
    assert.equal(only.status, 400);
    assert.equal(only.json.code, 'SECRET_ONLINE');
    assert.equal(only.json.error, 'Password changes need the Sentry USB online. Save them while it\'s connected.');
    const mix = await s.call('POST', Q, { cookie: admin, body: { kind: 'settings', params: { changes: {
      TIME_ZONE: { from: 'Europe/London', to: 'Europe/Paris' }, SSID: { from: 'CabinNet', to: 'WorkNet' },
      WIFIPASS: { from: null, to: 'queued-wifi-pass-77', secret: true }, SHARE_PASSWORD: { from: null, to: 'queued-share-pass-78' }
    } } } });
    assert.equal(mix.status, 200, mix.text);
    assert.deepEqual(mix.json.held.sort(), ['SHARE_PASSWORD', 'SSID', 'WIFIPASS']);
    assert.match(mix.json.note, /^Password changes need the Sentry USB online\. Save them while it's connected\. Also left for then: SSID goes with WIFIPASS\.$/);
    assert.deepEqual(mix.json.queued[0].params.fields, ['TIME_ZONE'], 'only the other field is queued');
    // nothing secret reaches the database (nor its write-ahead log)
    await wait(300);
    const dataDir = path.join(s.dir, 'data');
    for (const n of fs.readdirSync(dataDir).filter((n) => n.startsWith('manager.db'))) {
      const bytes = fs.readFileSync(path.join(dataDir, n));
      for (const secret of ['queued-wifi-pass-77', 'queued-share-pass-78', 'live-wifi-pass-31']) assert.equal(bytes.includes(Buffer.from(secret)), false, `${secret} in ${n}`);
    }

    // unpair: the key goes, the link closes, the port closes (nothing else needs it)
    assert.equal((await s.call('DELETE', `/api/sentryusb/${id}`, { cookie: admin })).status, 200);
    for (let i = 0; i < 50 && !pi.ws.closed; i++) await wait(50);
    assert.equal(pi.ws.closed, true);
    for (let i = 0; i < 50; i++) { try { await req(s.canPort, 'GET', '/'); } catch { break; } await wait(50); }
    await assert.rejects(req(s.canPort, 'GET', '/'), /ECONNREFUSED/);
  } finally {
    pi?.ws?.terminate();
    await s.stop();
  }
});

test('without its own HTTPS (behind a reverse proxy) Manager refuses to pair and says why', { timeout: 60_000 }, async () => {
  const s = await start({ TLS_MODE: 'off' });
  try {
    const admin = await s.login('admin', 'correct horse');
    await s.call('POST', '/api/auth/confirm', { cookie: admin, body: { password: 'correct horse' } });
    const r = await s.call('POST', '/api/sentryusb/pair', { cookie: admin, body: { name: 'Car', username: 'pi', password: 'raspberry' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'NO_HTTPS');
    const l = await s.call('GET', '/api/sentryusb', { cookie: admin });
    assert.equal(l.json.https, false);
    assert.match(l.json.noHttpsText, /TLS_MODE/);
  } finally { await s.stop(); }
});
