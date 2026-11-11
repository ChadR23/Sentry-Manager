'use strict';

// tools/demo-sentry-usb.js: the demo Pi keeps what Manager changes, logs it,
// masks secrets, refuses what the real Pi refuses, and comes back after a reboot.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { TlsManager } = require('../server/tls');
const L = require('../server/sentryUsbLink');
const { createDemoSentryUsb, runDemoSentryUsb } = require('../tools/demo-sentry-usb');

const quiet = { info() {}, warn() {}, debug() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await wait(20); } };
const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'demo-pi-'));
const memDb = () => { const m = new Map(); return { get: (k, f = null) => (m.has(k) ? structuredClone(m.get(k)) : f), set: (k, v) => m.set(k, structuredClone(v)) }; };
const fullBody = (cfg) => Object.fromEntries(Object.entries(cfg).filter(([k, v]) => !k.endsWith('__set') && v.active).map(([k, v]) => [k, v.value]));

test('a saved setting persists across restarts and is logged; secrets only as "changed"', async () => {
  const dir = await tmp();
  let pi = createDemoSentryUsb({ dir });
  const cfg = pi.answer({ method: 'GET', path: '/api/setup/config' }).body;
  assert.equal(cfg.ARCHIVE_DELAY.value, '20');
  const body = { ...fullBody(cfg), ARCHIVE_DELAY: '30', NTFY_TOKEN: 'tk_new_secret_value' };
  assert.equal(pi.answer({ method: 'PUT', path: '/api/setup/config', body }).status, 200);
  pi.close();
  pi = createDemoSentryUsb({ dir }); // restarted
  const again = pi.answer({ method: 'GET', path: '/api/setup/config' }).body;
  assert.equal(again.ARCHIVE_DELAY.value, '30');
  assert.match(fs.readFileSync(path.join(dir, 'sentryusb.conf'), 'utf8'), /^export NTFY_TOKEN=tk_new_secret_value$/m);
  for (const name of ['setup', 'syslog']) {
    const log = pi.answer({ method: 'GET', path: `/api/logs/${name}` }).body;
    assert.match(log, /Setup config: ARCHIVE_DELAY changed 20 → 30 \(from Sentry Manager\)/);
    assert.match(log, /Setup config: NTFY_TOKEN changed \(from Sentry Manager\)/);
    assert.ok(!log.includes('tk_new_secret_value'), 'a secret value is never logged');
  }
  pi.close();
});

test('reads mask every secret; an empty secret keeps the stored one; read-only keys and moved secrets are refused', async () => {
  const pi = createDemoSentryUsb({ dir: await tmp() });
  const cfg = pi.answer({ method: 'GET', path: '/api/setup/config' }).body;
  assert.deepEqual(cfg.WIFIPASS, { value: '', active: true });
  assert.equal(cfg.WIFIPASS__set, true);
  assert.equal(cfg.WEB_PASSWORD.value, '');
  assert.ok(!JSON.stringify(cfg).includes('correct-battery-staple'));
  const put = (b) => pi.answer({ method: 'PUT', path: '/api/setup/config', body: { ...fullBody(cfg), ...b } });
  // CAM_SIZE resizes (and so erases) the drive: only on the Pi itself
  const ro = put({ CAM_SIZE: '50G' });
  assert.equal(ro.status, 400);
  assert.equal(ro.body.error, 'CAM_SIZE can only be changed on the Sentry USB itself');
  assert.equal(put({ ARCHIVE_SERVER: 'evil.example' }).body.error, 'ARCHIVE_SERVER can only be changed on the Sentry USB itself');
  assert.equal(put({ SSID: 'OtherNet' }).body.error, 'SSID changed: enter WIFIPASS again to send it there');
  assert.equal(put({ SSID: 'OtherNet', WIFIPASS: 'other-pass' }).status, 200);
  assert.equal(put({ ARCHIVE_DELAY: '2x' }).body.error, 'ARCHIVE_DELAY must be a whole number');
  assert.equal(put({ NTFY_URL: 'http://127.0.0.1/x' }).body.error, 'NTFY_URL must be an http:// or https:// address of another machine');
  const after = pi.answer({ method: 'GET', path: '/api/setup/config' }).body;
  assert.equal(after.CAM_SIZE.value, '40G');
  assert.equal(after.SSID.value, 'OtherNet');
  assert.equal(after.WEB_PASSWORD__set, true, 'the web password was sent empty and kept');
  assert.match(pi.answer({ method: 'GET', path: '/api/logs/manager-link' }).body, /refused: CAM_SIZE can only be changed/);
  pi.close();
});

test('over the real link: pairs with a code, then reboot goes away and comes back with a new boot id', async () => {
  const dir = await tmp();
  const t = new TlsManager({ dir: path.join(dir, 'tls'), log: quiet, hostnames: ['127.0.0.1'] });
  await t.ensure();
  const link = L.createSentryUsbLink({ db: memDb(), log: quiet, iterations: 1000 });
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'tls', 'server.key')), cert: fs.readFileSync(path.join(dir, 'tls', 'server.crt')) }, (q, s) => s.end());
  srv.on('upgrade', (q, s, h) => link.handleUpgrade(q, s, h));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const pi = createDemoSentryUsb({ dir: path.join(dir, 'pi'), rebootMs: [300, 400], syncMs: 300 });
  const { code } = await link.openPairing({ name: 'Demo Model Y', username: 'pi', password: 'raspberry' });
  const run = runDemoSentryUsb(pi, { host: '127.0.0.1', port: srv.address().port, code, iterations: 1000, say: () => {} });
  try {
    await until(() => link.devices()[0]?.online && link.devices()[0]?.status);
    const d = link.devices()[0];
    assert.equal(d.name, 'Demo Model Y');
    assert.equal(d.status.sbc_model, 'Raspberry Pi 5 Model B Rev 1.0');
    assert.ok(d.status.supply_voltage > 5);
    const boot = (await link.request(d.id, { method: 'GET', path: '/api/system/version' })).body.boot_id;
    // sync: archiving, then idle with more clips
    assert.equal((await link.request(d.id, { method: 'POST', path: '/api/system/trigger-sync' })).status, 200);
    await until(() => link.devices()[0].status.archiving === true);
    await until(() => link.devices()[0].status.archiving === false);
    assert.equal((await link.request(d.id, { method: 'POST', path: '/api/system/reboot' })).status, 200);
    await until(() => !link.devices()[0].online);
    await until(() => link.devices()[0].online, 5000);
    const v = (await link.request(d.id, { method: 'GET', path: '/api/system/version' })).body;
    assert.notEqual(v.boot_id, boot);
    assert.match(fs.readFileSync(path.join(dir, 'pi', 'logs', 'syslog.log'), 'utf8'), /Reboot requested from Sentry Manager[\s\S]*booted, boot id/);
  } finally {
    run.stop();
    link.close();
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});
