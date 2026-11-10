'use strict';

// The Sentry USB security log (docs/sentry-usb-link.md, 6b): its flags, the
// collapse of repeated failures, the row cap, CSV escaping, and a Pi's alert
// frames becoming possible-hijack entries.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { ManagerDB } = require('../server/db');
const { TlsManager } = require('../server/tls');
const { createSentryUsbAudit } = require('../server/sentryUsbAudit');
const { createSentryUsbLink } = require('../server/sentryUsbLink');
const { connectFakePi } = require('./fixtures/fakeSentryUsb');

const quiet = { info() {}, warn() {}, debug() {} };
const PI = 'pi-0123456789abcdef';
function make(o = {}) {
  const db = new ManagerDB(':memory:');
  const notes = [];
  let clock = o.start || Date.parse('2026-11-01T12:00:00Z');
  const devices = { [PI]: { name: 'Model 3', notifyNetwork: true, home: null }, ...(o.devices || {}) };
  const a = createSentryUsbAudit({ db, notify: (n) => notes.push(n), device: (id) => devices[id] || null, log: quiet, now: () => clock, ...(o.opts || {}) });
  return { a, db, notes, devices, tick: (ms) => { clock += ms; } };
}

test('new address: a paired Pi from an address it has not used in 90 days', () => {
  const { a, notes, tick } = make();
  a.linkEvent({ type: 'connected', id: PI, ip: '192.168.1.57', port: 50000 });
  assert.deepEqual(a.list()[0].flags, [], 'the first connection sets what is usual');
  tick(3600_000);
  a.linkEvent({ type: 'connected', id: PI, ip: '192.168.1.57', port: 50001 });
  assert.deepEqual(a.list()[0].flags, []);
  a.linkEvent({ type: 'connected', id: PI, ip: '192.168.1.88', port: 50002 });
  assert.deepEqual(a.list()[0].flags, ['new']);
  assert.equal(notes.at(-1).level, 'info');
  assert.match(notes.at(-1).title, /new address/);
  // 91 days on, the old one counts as new again
  tick(91 * 86_400_000);
  a.linkEvent({ type: 'connected', id: PI, ip: '192.168.1.57', port: 50003 });
  assert.deepEqual(a.list()[0].flags, ['new']);
});

test('outside home: a public source address, or a Wi-Fi or gateway other than the usual one (learned or set by hand)', () => {
  const { a, notes, devices, tick } = make();
  a.linkEvent({ type: 'connected', id: PI, ip: '203.0.113.9', port: 40000 });
  assert.ok(a.list()[0].flags.includes('outside'), 'public address');
  for (let i = 0; i < 3; i++) { a.linkEvent({ type: 'net', id: PI, ssid: 'HomeNet', iface: 'wlan0', netIp: '192.168.1.57', gw: '192.168.1.1' }); tick(2 * 3600_000); }
  assert.deepEqual(a.list({ filter: 'network' }).filter((r) => r.kind === 'net'), [], 'home is home');
  assert.deepEqual(a.home(PI), { ssid: 'HomeNet', gw: '192.168.1.1', byHand: false });
  a.linkEvent({ type: 'net', id: PI, ssid: 'CafeWiFi', iface: 'wlan0', netIp: '10.0.0.7', gw: '10.0.0.1' });
  assert.deepEqual(a.list()[0].flags.sort(), ['new', 'outside']);
  // set by hand: the café is home now
  devices[PI].home = { ssid: 'CafeWiFi', gw: '10.0.0.1' };
  tick(2 * 3600_000);
  a.linkEvent({ type: 'net', id: PI, ssid: 'CafeWiFi', iface: 'wlan0', netIp: '10.0.0.7', gw: '10.0.0.1' });
  assert.deepEqual(a.list()[0].flags, []);
  // notices off for this Pi: logged, not notified
  devices[PI].notifyNetwork = false;
  const before = notes.length;
  a.linkEvent({ type: 'net', id: PI, ssid: 'Airport', gw: '172.16.0.1' });
  assert.ok(a.list()[0].flags.includes('outside'));
  assert.equal(notes.length, before);
});

test('possible hijack attempt: a paired id with a bad proof, pairing with nothing open, a burst of failed proofs; always notified as a warning', () => {
  const { a, notes } = make();
  a.linkEvent({ type: 'fail', why: 'bad proof', paired: true, id: PI, ip: '192.168.1.200', port: 1 });
  assert.deepEqual(a.list()[0].flags, ['hijack']);
  assert.deepEqual([notes.at(-1).level, notes.at(-1).always, notes.at(-1).kind], ['warning', true, 'security']);
  a.linkEvent({ type: 'fail', why: 'no slot', ip: '192.168.1.201', port: 2, claimed: 'pi-x' });
  assert.deepEqual(a.list()[0].flags, ['hijack']);
  // an unknown id once is just a failure; wrong passwords in a burst are an attempt
  a.linkEvent({ type: 'fail', why: 'unknown id', ip: '192.168.1.202', claimed: 'pi-nobody-123' });
  assert.deepEqual(a.list()[0].flags, []);
  a.linkEvent({ type: 'fail', why: 'wrong password', ip: '192.168.1.203' });
  a.linkEvent({ type: 'fail', why: 'wrong password', ip: '192.168.1.203' });
  assert.deepEqual(a.list({ filter: 'attempts' })[0].flags, [], 'two is not a burst');
  a.linkEvent({ type: 'fail', why: 'wrong password', ip: '192.168.1.203' });
  assert.deepEqual(a.list()[0].flags, ['hijack'], 'the third is');
  assert.equal(a.list({ filter: 'attempts' }).length, 5);
  assert.equal(a.list({ filter: 'actions' }).length, 0);
});

test('repeated identical failures from one address share a row; a flood is capped', () => {
  const { a, notes, tick } = make({ opts: { maxRows: 50 } });
  for (let i = 0; i < 500; i++) { a.linkEvent({ type: 'fail', why: 'bad proof', paired: true, id: PI, ip: '198.51.100.7', port: 1000 + i }); tick(1000); }
  const rows = a.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 500);
  assert.equal(rows[0].lastAt - rows[0].at, 499_000);
  assert.equal(notes.length, 1, 'one notification for the flood');
  // after an hour of quiet: a new row
  tick(3600_001);
  a.linkEvent({ type: 'fail', why: 'bad proof', paired: true, id: PI, ip: '198.51.100.7' });
  assert.equal(a.list().length, 2);
  // many addresses: at most maxRows rows are kept
  for (let i = 0; i < 400; i++) a.linkEvent({ type: 'fail', why: 'timeout', ip: `10.${i >> 8}.${i & 255}.1` });
  a.prune();
  assert.ok(a.list({ limit: 1000 }).length <= 50);
  // and old rows go after the kept days
  tick(181 * 86_400_000);
  a.prune();
  assert.equal(a.list().length, 0);
});

test('CSV: every cell quoted, quotes doubled, formula-looking cells made text', () => {
  const { a } = make();
  a.record({ kind: 'action', deviceId: PI, who: '@admin', detail: '=HYPERLINK("http://evil","x")', ip: '192.168.1.5' });
  a.record({ kind: 'action', deviceId: PI, who: '+1', detail: '-2+3' });
  a.linkEvent({ type: 'net', id: PI, ssid: 'Evil"\r\n=cmd', gw: '1.1.1.1' });
  const text = a.csv(a.list(), () => '=Model 3');
  const lines = text.trim().split('\r\n');
  assert.equal(lines.length, 4, 'no line break from a Pi value survives');
  for (const line of lines.slice(1)) {
    for (const cell of line.match(/"(?:[^"]|"")*"/g)) assert.doesNotMatch(cell, /^"[=+\-@]/, cell);
  }
  assert.match(text, /"'=HYPERLINK\(""http:\/\/evil"",""x""\)"/);
  assert.match(text, /"'@admin"/);
  assert.match(text, /"'-2\+3"/);
  assert.match(text, /"'=Model 3"/);
  assert.match(text, /wifi ""Evil""  =cmd""/, 'control characters gone, quotes doubled');
});

test('a Pi\'s alert frames (a wrong fingerprint, a failed Manager proof) become possible-hijack entries; its net frame is logged', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-aud-'));
  const t = new TlsManager({ dir: path.join(dir, 'tls'), log: quiet, hostnames: ['127.0.0.1'] });
  await t.ensure();
  const db = new ManagerDB(':memory:');
  const notes = [];
  let link = null;
  const a = createSentryUsbAudit({ db, notify: (n) => notes.push(n), device: (id) => link?.info(id) || null, log: quiet });
  link = createSentryUsbLink({ db, log: quiet, iterations: 1000, onEvent: (e) => a.linkEvent(e) });
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'tls', 'server.key')), cert: fs.readFileSync(path.join(dir, 'tls', 'server.crt')) });
  srv.on('upgrade', (req, socket, head) => link.handleUpgrade(req, socket, head));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    // a pairing attempt with nothing open
    const early = await connectFakePi({ port, iterations: 1000, mode: 'pair', username: 'pi', password: 'raspberry' });
    assert.equal(early.why, 'no pairing open');
    await link.openPairing({ name: 'Model 3', username: 'pi', password: 'raspberry' });
    const pi = await connectFakePi({ port, iterations: 1000, mode: 'pair', username: 'pi', password: 'raspberry', net: { ssid: '<img src=x onerror=alert(1)>' },
      alerts: [{ kind: 'fingerprint', seen: 'AB:CD:EF', at: 1_762_000_000 }, { kind: 'proof', at: 1_762_000_100 }] });
    assert.equal(pi.result, 'ok');
    for (let i = 0; i < 100 && a.list({ filter: 'attempts' }).filter((r) => r.kind === 'alert').length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    const alerts = a.list({ filter: 'attempts' }).filter((r) => r.kind === 'alert');
    assert.equal(alerts.length, 2);
    assert.ok(alerts.every((r) => r.flags.includes('hijack') && r.deviceId === pi.auth.id));
    assert.match(alerts.find((r) => /fingerprint/.test(r.detail)).detail, /saw AB:CD:EF/);
    assert.ok(notes.some((n) => n.always && /hijack/.test(n.title)));
    const kinds = a.list({ limit: 50 }).map((r) => r.kind);
    for (const k of ['open', 'fail-noslot', 'pair-ok', 'connected', 'net', 'alert']) assert.ok(kinds.includes(k), k);
    assert.ok(a.list().find((r) => r.kind === 'fail-noslot').flags.includes('hijack'));
    assert.equal(a.list().find((r) => r.kind === 'net').detail, 'wifi "<img src=x onerror=alert(1)>" via 192.168.1.1 on wlan0 as 192.168.1.57', 'kept as text; the page shows it as text');
    assert.equal(link.devices()[0].net.ssid, '<img src=x onerror=alert(1)>');
    link.unpair(pi.auth.id, 'admin');
    for (let i = 0; i < 100 && !a.list().some((r) => r.kind === 'disconnected'); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(a.list().some((r) => r.kind === 'unpaired' && r.who === 'admin'));
    assert.ok(a.list().some((r) => r.kind === 'disconnected'));
    assert.equal(JSON.stringify(a.list({ limit: 100 })).includes(pi.linkKey), false, 'no key in the log');
  } finally {
    link.close();
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});
