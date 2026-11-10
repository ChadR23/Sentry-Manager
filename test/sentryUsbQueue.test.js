'use strict';

// Queued actions for an away Sentry USB (docs/sentry-usb-link.md, 6a): order,
// run-once across a restart, the settings merge and its conflict skip, the
// wait for an idle archive, expiry and kept files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSentryUsbQueue, archiveBusy } = require('../server/sentryUsbQueue');
const { fakeState, answer, statusBody } = require('./fixtures/fakeSentryUsb');

const quiet = { info() {}, warn() {}, debug() {} };
const memDb = () => {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? structuredClone(m.get(k)) : f), set: (k, v) => m.set(k, structuredClone(v)) };
};
const ID = 'pi-0123456789abcdef';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// a link with one Pi answering like the fake Pi, without a network
function fakeLink(st = fakeState(), { online = true } = {}) {
  const sent = [];
  const link = {
    on: online, st, sent, hold: null,
    has: (id) => id === ID, online: (id) => id === ID && link.on, name: () => 'Model 3',
    status: () => (link.on ? statusBody(st) : null),
    request: async (id, req) => {
      sent.push(`${req.method} ${req.path}`);
      if (link.hold && link.hold(req)) return new Promise(() => {}); // never answers
      const a = answer(st, req);
      return a.buf ? { status: a.status, type: a.type, buf: a.buf } : { status: a.status, type: a.type, body: a.body };
    }
  };
  return link;
}
const make = (o = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-suq-'));
  const notes = [];
  const q = createSentryUsbQueue({ db: o.db || memDb(), link: o.link, dir: o.dir || dir, log: quiet, notify: (n) => notes.push(n), idlePollMs: 20, ...o.opts });
  return { q, notes, dir: o.dir || dir };
};

test('queued actions run in order, one at a time, update and reboot last; a notification says how it went', async () => {
  const link = fakeLink(fakeState(), { online: false });
  const { q, notes } = make({ link });
  q.add(ID, { kind: 'reboot' }, 'admin');
  q.add(ID, { kind: 'update' }, 'admin');
  q.add(ID, { kind: 'sync' }, 'admin');
  q.add(ID, { kind: 'diagnostics' }, 'admin');
  q.add(ID, { kind: 'backup' }, 'admin');
  assert.equal(q.add(ID, { kind: 'sync' }, 'admin'), q.list(ID).queued.find((x) => x.kind === 'sync').id, 'a second sync adds nothing');
  assert.deepEqual(q.list(ID).queued.map((x) => x.kind), ['sync', 'diagnostics', 'backup', 'update', 'reboot']);
  assert.equal(link.sent.length, 0, 'nothing is sent while the Pi is away');
  link.on = true;
  await q.kick(ID);
  assert.deepEqual(link.sent, [
    'POST /api/system/trigger-sync',
    'POST /api/diagnostics/refresh', 'GET /api/diagnostics',
    'POST /api/system/backup',
    'POST /api/system/check-update', 'POST /api/system/update',
    'POST /api/system/reboot'
  ]);
  const l = q.list(ID);
  assert.equal(l.queued.length, 0);
  assert.ok(l.results.every((x) => x.state === 'done'), JSON.stringify(l.results));
  assert.equal(l.files.length, 1, 'the diagnostics report is kept (a backup stays on the Pi)');
  assert.match(l.results.find((x) => x.kind === 'backup').result.message, /archive share/);
  assert.match(fs.readFileSync(q.file(ID, l.files.find((f) => f.name.startsWith('diagnostics')).name), 'utf8'), /Sentry USB diagnostics/);
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /5 queued actions ran/);
  assert.equal(q.file(ID, '../manager.db'), null);
});

test('an action runs at most once: a restart in the middle reports it interrupted and does not send it again', async () => {
  const db = memDb();
  const link = fakeLink();
  link.on = false;
  const a = make({ db, link });
  a.q.add(ID, { kind: 'update' }, 'admin');
  a.q.add(ID, { kind: 'sync' }, 'admin');
  link.on = true;
  link.hold = (req) => req.path === '/api/system/trigger-sync'; // Manager "stops" while this one runs
  a.q.kick(ID);
  await wait(50);
  assert.equal(db.get('sentryusb-queue').items.find((x) => x.kind === 'sync').state, 'running', 'saved as running before it was sent');
  // a new Manager on the same database
  link.hold = null;
  link.sent.length = 0;
  const b = make({ db, link });
  const sync = b.q.list(ID).results.find((x) => x.kind === 'sync');
  assert.equal(sync.state, 'interrupted');
  await b.q.kick(ID);
  assert.deepEqual(link.sent, ['POST /api/system/check-update', 'POST /api/system/update'], 'the update runs; the interrupted sync is not sent again');
});

test('settings: only the changed fields are applied; a field changed on the Pi too is skipped and reported', async () => {
  const st = fakeState();
  const link = fakeLink(st, { online: false });
  const { q } = make({ link });
  q.add(ID, {
    kind: 'settings', params: {
      apply: true,
      changes: { SSID: { from: 'HomeNet', to: 'WorkNet' }, ARCHIVE_DELAY: { from: '20', to: '30' }, WIFIPASS: { from: null, to: 'newwifipass', secret: true }, DISCORD_ENABLED: { from: null, to: 'true' } }
    }
  }, 'admin');
  // meanwhile, on the Pi: ARCHIVE_DELAY (the same field) and SNAPSHOT_INTERVAL (another one)
  st.config.ARCHIVE_DELAY = '45';
  st.config.SNAPSHOT_INTERVAL = '600';
  assert.deepEqual(q.list(ID).queued[0].params, { apply: true, fields: ['SSID', 'ARCHIVE_DELAY', 'WIFIPASS', 'DISCORD_ENABLED'] }, 'values are not shown');
  link.on = true;
  await q.kick(ID);
  const r = q.list(ID).results[0];
  assert.equal(r.state, 'done');
  assert.deepEqual(r.result.skipped, ['ARCHIVE_DELAY']);
  assert.deepEqual(r.result.applied.sort(), ['DISCORD_ENABLED', 'SSID', 'WIFIPASS']);
  assert.match(r.result.message, /Skipped ARCHIVE_DELAY/);
  assert.equal(st.config.SSID, 'WorkNet');
  assert.equal(st.config.ARCHIVE_DELAY, '45', 'the Pi\'s own change stays');
  assert.equal(st.config.SNAPSHOT_INTERVAL, '600', 'another field changed on the Pi is not overwritten');
  assert.equal(st.config.DISCORD_ENABLED, 'true', 'a commented line can be turned on');
  assert.equal(st.config.WIFIPASS, 'newwifipass');
  assert.equal(st.config.SHARE_PASSWORD, 'smbpass', 'a secret sent back empty is kept');
  assert.equal(st.lastPut.SHARE_PASSWORD, '', 'other secrets go back empty: kept');
  assert.equal(st.setupRuns, 1, 'and setup re-ran');
  assert.equal(JSON.stringify(q.list(ID)).includes('newwifipass'), false, 'the new password is not in the list');
  // everything conflicting: nothing written
  st.lastPut = null;
  q.add(ID, { kind: 'settings', params: { changes: { ARCHIVE_DELAY: { from: '20', to: '70' } } } }, 'admin');
  await q.kick(ID);
  assert.equal(st.lastPut, null);
  assert.match(q.list(ID).results[0].result.message, /Nothing applied/);
  // the Pi's rules, checked when queueing: read-only keys, and a secret that must follow its destination
  assert.throws(() => q.add(ID, { kind: 'settings', params: { changes: { CAM_SIZE: { from: '40G', to: '60G' } } } }), /CAM_SIZE cannot be changed/);
  assert.throws(() => q.add(ID, { kind: 'settings', params: { changes: { WEB_PASSWORD: { from: null, to: 'x', secret: true } } } }), /WEB_PASSWORD cannot be changed/);
  assert.throws(() => q.add(ID, { kind: 'settings', params: { changes: { ARCHIVE_SERVER: { from: 'nas.local', to: 'evil.example' } } } }), /needs SHARE_PASSWORD entered again/);
  assert.throws(() => q.add(ID, { kind: 'settings', params: { changes: { SSID: { from: 'WorkNet', to: 'Other' } } } }), /needs WIFIPASS/);
});

test('update and reboot wait for the archive to finish, at most 2 hours, then stay queued', async () => {
  const st = fakeState();
  st.archiving = true;
  const link = fakeLink(st);
  assert.equal(archiveBusy(statusBody(st)), true);
  let clock = 1_000_000;
  const { q } = make({ link, opts: { now: () => clock, idleWaitMs: 2 * 3600_000 } });
  link.on = false;
  q.add(ID, { kind: 'reboot' }, 'admin');
  q.add(ID, { kind: 'sync' }, 'admin');
  link.on = true;
  const run = q.kick(ID);
  await wait(60);
  assert.deepEqual(link.sent, ['POST /api/system/trigger-sync'], 'sync runs; the reboot waits');
  assert.match(q.list(ID).queued[0].note, /Waiting for the archive/);
  st.archiving = false;
  await run;
  assert.deepEqual(link.sent.at(-1), 'POST /api/system/reboot');
  // never idle: after 2 hours it stays queued, said so
  st.archiving = true;
  link.sent.length = 0;
  q.add(ID, { kind: 'update' }, 'admin');
  const run2 = q.kick(ID);
  await wait(40);
  clock += 2 * 3600_000 + 1;
  await run2;
  assert.equal(link.sent.length, 0);
  const u = q.list(ID).queued[0];
  assert.equal(u.state, 'queued');
  assert.match(u.note, /Waited too long/);
});

test('queued actions expire (14 days by default, adjustable) and can be cancelled; expired ones are never sent', async () => {
  let clock = 5_000_000;
  const link = fakeLink(fakeState(), { online: false });
  const { q } = make({ link, opts: { now: () => clock } });
  const a = q.add(ID, { kind: 'sync' }, 'admin');
  const b = q.add(ID, { kind: 'diagnostics', expiresInDays: 30 }, 'admin');
  const c = q.add(ID, { kind: 'backup' }, 'admin');
  assert.throws(() => q.add(ID, { kind: 'reboot', expiresInDays: 0 }), /1 to 90/);
  assert.throws(() => q.add(ID, { kind: 'terminal' }), /cannot be queued/);
  assert.throws(() => q.add('pi-other-000000', { kind: 'sync' }), /No such/);
  assert.equal(q.cancel(ID, c), true);
  clock += 15 * 86_400_000;
  const l = q.list(ID);
  assert.equal(l.results.find((x) => x.id === a).state, 'expired');
  assert.equal(l.results.find((x) => x.id === c).state, 'cancelled');
  assert.equal(l.queued.map((x) => x.id).join(), b);
  assert.throws(() => q.cancel(ID, a), /Only a waiting action/);
  link.on = true;
  await q.kick(ID);
  assert.deepEqual(link.sent, ['POST /api/diagnostics/refresh', 'GET /api/diagnostics']);
});

test('fetched files: the newest 5 per Pi are kept; a Pi\'s error is the failure reason', async () => {
  let clock = Date.parse('2026-11-10T10:00:00Z');
  const link = fakeLink();
  const { q } = make({ link, opts: { now: () => clock } });
  for (let i = 0; i < 7; i++) {
    clock += 60_000;
    q.add(ID, { kind: 'diagnostics' }, 'admin');
    await q.kick(ID);
    await wait(5); // distinct file times
  }
  assert.equal(q.list(ID).files.length, 5);
  link.st.archiving = true; // trigger-sync answers 409: "already running", not a failure
  q.add(ID, { kind: 'sync' }, 'admin');
  await q.kick(ID);
  assert.equal(q.list(ID).results[0].state, 'done');
  link.request = async () => ({ status: 500, type: 'application/json', body: { error: 'USB gadget enable failed: busy' } });
  q.add(ID, { kind: 'reboot' }, 'admin');
  link.st.archiving = false;
  await q.kick(ID);
  const r = q.list(ID).results[0];
  assert.deepEqual([r.state, r.result.message], ['failed', 'USB gadget enable failed: busy']);
  q.forgetDevice(ID);
  assert.equal(q.list(ID).files.length, 0);
});

test('a queued settings change with a control character in a value is refused, as the proxy refuses it', () => {
  const { q } = make({ link: fakeLink(fakeState(), { online: false }) });
  for (const to of ['Home\nexport PATH=/tmp', 'a\rb', 'a\u0000b', 'a\u001bb', 'a\u007fb']) {
    assert.throws(() => q.add(ID, { kind: 'settings', params: { changes: { SSID: { from: 'x', to }, WIFIPASS: { from: null, to: 'secret123' } } } }, 'admin'), /Bad value for SSID/, JSON.stringify(to));
  }
  assert.ok(q.add(ID, { kind: 'settings', params: { changes: { SSID: { from: 'x', to: 'Home 2' }, WIFIPASS: { from: null, to: 'secret123' } } } }, 'admin'));
});
