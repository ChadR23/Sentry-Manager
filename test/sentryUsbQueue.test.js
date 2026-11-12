'use strict';

// Queued actions for an away Sentry USB (docs/sentry-usb-link.md, 6a): order,
// run-once across a restart, the settings merge and its conflict skip, the
// wait for an idle archive, expiry and kept files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSentryUsbQueue, archiveBusy, splitSecrets, SECRETS_ONLINE_TEXT } = require('../server/sentryUsbQueue');
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
      changes: { TIME_ZONE: { from: 'America/Los_Angeles', to: 'Europe/Paris' }, ARCHIVE_DELAY: { from: '20', to: '30' }, DISCORD_ENABLED: { from: null, to: 'true' } }
    }
  }, 'admin');
  // meanwhile, on the Pi: ARCHIVE_DELAY (the same field) and SNAPSHOT_INTERVAL (another one)
  st.config.ARCHIVE_DELAY = '45';
  st.config.SNAPSHOT_INTERVAL = '600';
  assert.deepEqual(q.list(ID).queued[0].params, { apply: true, fields: ['TIME_ZONE', 'ARCHIVE_DELAY', 'DISCORD_ENABLED'] }, 'values are not shown');
  link.on = true;
  await q.kick(ID);
  const r = q.list(ID).results[0];
  assert.equal(r.state, 'done');
  assert.deepEqual(r.result.skipped, ['ARCHIVE_DELAY']);
  assert.deepEqual(r.result.applied.sort(), ['DISCORD_ENABLED', 'TIME_ZONE']);
  assert.match(r.result.message, /Skipped ARCHIVE_DELAY/);
  assert.equal(st.config.TIME_ZONE, 'Europe/Paris');
  assert.equal(st.config.ARCHIVE_DELAY, '45', 'the Pi\'s own change stays');
  assert.equal(st.config.SNAPSHOT_INTERVAL, '600', 'another field changed on the Pi is not overwritten');
  assert.equal(st.config.DISCORD_ENABLED, 'true', 'a commented line can be turned on');
  assert.equal(st.config.SHARE_PASSWORD, 'smbpass', 'a secret sent back empty is kept');
  assert.equal(st.lastPut.SHARE_PASSWORD, '', 'secrets go back empty: kept');
  assert.equal(st.lastPut.WIFIPASS, '');
  assert.equal(st.setupRuns, 1, 'and setup re-ran');
  // everything conflicting: nothing written
  st.lastPut = null;
  q.add(ID, { kind: 'settings', params: { changes: { ARCHIVE_DELAY: { from: '20', to: '70' } } } }, 'admin');
  await q.kick(ID);
  assert.equal(st.lastPut, null);
  assert.match(q.list(ID).results[0].result.message, /Nothing applied/);
  // the Pi's rules, checked when queueing: read-only keys, and a secret that must follow its destination
  assert.throws(() => q.add(ID, { kind: 'settings', params: { changes: { CAM_SIZE: { from: '40G', to: '60G' } } } }), /CAM_SIZE cannot be changed/);
  assert.throws(() => q.add(ID, { kind: 'settings', params: { changes: { WEB_PASSWORD: { from: null, to: 'x', secret: true } } } }), /WEB_PASSWORD cannot be changed/);
  assert.throws(() => q.add(ID, { kind: 'settings', params: { changes: { ARCHIVE_SERVER: { from: 'nas.local', to: 'evil.example' } } } }), /needs SHARE_PASSWORD entered again\. Password changes need the Sentry USB online/);
  assert.throws(() => q.add(ID, { kind: 'settings', params: { changes: { SSID: { from: 'WorkNet', to: 'Other' } } } }), /needs WIFIPASS/);
});

test('a queued settings change never holds a secret: refused alone, split from a mix, dropped from an old saved queue', async () => {
  const db = memDb();
  const st = fakeState();
  const link = fakeLink(st, { online: false });
  const { q } = make({ db, link });
  // refused: every field Manager masks, flagged or not
  for (const k of ['WIFIPASS', 'SHARE_PASSWORD', 'AP_PASS', 'TELEGRAM_BOT_TOKEN', 'DISCORD_WEBHOOK_URL', 'NTFY_URL', 'IFTTT_KEY', 'AWS_SECRET_ACCESS_KEY', 'PUSHOVER_APP_KEY']) {
    assert.throws(() => q.add(ID, { kind: 'settings', params: { changes: { [k]: { from: null, to: 'sekrit-2' } } } }, 'admin'),
      (err) => err.code === 'SECRET_ONLINE' && err.message === SECRETS_ONLINE_TEXT, k);
  }
  assert.throws(() => q.add(ID, { kind: 'settings', params: { changes: { TIME_ZONE: { from: null, to: 'UTC' }, X_ENABLED: { from: null, to: 'x', secret: true } } } }, 'admin'));
  assert.equal(SECRETS_ONLINE_TEXT, 'Password changes need the Sentry USB online. Save them while it\'s connected.');
  // split: the secrets and what must go with them wait; the rest is queued
  const s = splitSecrets({
    TIME_ZONE: { from: 'America/Los_Angeles', to: 'UTC' }, SSID: { from: 'HomeNet', to: 'WorkNet' }, WIFIPASS: { from: null, to: 'sekrit-2', secret: true },
    ARCHIVE_DELAY: { from: '20', to: '25' }, MATRIX_PASSWORD: { from: null, to: 'sekrit-3' }
  });
  assert.deepEqual(Object.keys(s.keep), ['TIME_ZONE', 'ARCHIVE_DELAY']);
  assert.deepEqual(s.held, ['WIFIPASS', 'MATRIX_PASSWORD', 'SSID']);
  assert.equal(s.note, `${SECRETS_ONLINE_TEXT} Also left for then: SSID goes with WIFIPASS.`);
  assert.deepEqual(splitSecrets({ TIME_ZONE: { from: null, to: 'UTC' } }), { keep: { TIME_ZONE: { from: null, to: 'UTC' } }, held: [], note: null });
  q.add(ID, { kind: 'settings', params: { changes: s.keep } }, 'admin');
  assert.equal(JSON.stringify(db.get('sentryusb-queue')).includes('sekrit'), false, 'nothing secret is stored');
  link.on = true;
  await q.kick(ID);
  assert.equal(st.config.TIME_ZONE, 'UTC');
  assert.equal(st.lastPut.WIFIPASS, '', 'the Wi-Fi password is kept as it was');

  // a queue an older Manager saved with a secret in it: dropped at start, never sent
  const old = memDb();
  old.set('sentryusb-queue', { items: [
    { id: 'a1', seq: 1, deviceId: ID, kind: 'settings', state: 'queued', createdAt: 1, expiresAt: Date.now() + 86_400_000, params: { apply: false, changes: { WIFIPASS: { from: null, to: 'old-secret-1', secret: true } } } },
    { id: 'a2', seq: 2, deviceId: ID, kind: 'settings', state: 'queued', createdAt: 2, expiresAt: Date.now() + 86_400_000, params: { apply: false, changes: { TIME_ZONE: { from: 'America/Los_Angeles', to: 'Europe/Rome' }, SHARE_PASSWORD: { from: null, to: 'old-secret-2' } } } },
    { id: 'a3', seq: 3, deviceId: ID, kind: 'settings', state: 'running', createdAt: 3, expiresAt: Date.now() + 86_400_000, params: { apply: false, changes: { SSID: { from: 'a', to: 'b' }, WIFIPASS: { from: null, to: 'old-secret-3' } } } }
  ] });
  const st2 = fakeState();
  const b = make({ db: old, link: fakeLink(st2) });
  assert.equal(JSON.stringify(old.get('sentryusb-queue')).includes('old-secret'), false, JSON.stringify(old.get('sentryusb-queue')));
  const l = b.q.list(ID);
  assert.deepEqual(l.queued.map((x) => [x.id, x.params.fields, x.note]), [['a2', ['TIME_ZONE'], `SHARE_PASSWORD left out. ${SECRETS_ONLINE_TEXT}`]]);
  assert.deepEqual(l.results.map((x) => [x.id, x.state]).sort(), [['a1', 'cancelled'], ['a3', 'interrupted']]);
  await b.q.kick(ID);
  assert.equal(st2.config.TIME_ZONE, 'Europe/Rome');
  assert.equal(st2.lastPut.SHARE_PASSWORD, '');
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
    assert.throws(() => q.add(ID, { kind: 'settings', params: { changes: { NOTIFICATION_TITLE: { from: 'x', to } } } }, 'admin'), /Bad value for NOTIFICATION_TITLE/, JSON.stringify(to));
  }
  assert.ok(q.add(ID, { kind: 'settings', params: { changes: { NOTIFICATION_TITLE: { from: 'x', to: 'Home 2' } } } }, 'admin'));
});

test('the settings page splits a change as the server does, in the same words', async () => {
  // (its import of the one unit choice, web/units.js, pointed at the file)
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'sentryUsbLink.js'), 'utf8')
    .replace("import '/web/units.js';", `import ${JSON.stringify(require('node:url').pathToFileURL(path.join(__dirname, '..', 'web', 'units.js')).href)};`);
  const page = await import(`data:text/javascript,${encodeURIComponent(src)}`);
  assert.equal(page.SECRETS_ONLINE_TEXT, SECRETS_ONLINE_TEXT);
  const c = {
    TIME_ZONE: { from: 'UTC', to: 'Europe/Paris', secret: false }, SSID: { from: 'a', to: 'b', secret: false }, WIFIPASS: { from: null, to: 'sekrit-9', secret: true },
    ARCHIVE_SERVER: { from: 'nas', to: 'nas2', secret: false }, GOTIFY_APP_TOKEN: { from: null, to: 'sekrit-10', secret: true }, NOTIFICATION_TITLE: { from: 'x', to: 'y', secret: false }
  };
  const a = page.splitHeld(c);
  const b = splitSecrets(c);
  assert.deepEqual(Object.keys(a.keep).sort(), Object.keys(b.keep).sort());
  assert.deepEqual(a.held.sort(), b.held.sort());
  assert.deepEqual(Object.keys(a.keep).sort(), ['NOTIFICATION_TITLE', 'TIME_ZONE']);
  assert.equal(JSON.stringify(a.keep).includes('sekrit'), false, 'the page never sends a password to the queue');
});

test('a queued update installs a newer test build when there is no stable release (the Pi lists it under prerelease)', async () => {
  const link = fakeLink();
  const bodies = [];
  const real = link.request;
  link.request = async (id, req) => {
    if (req.path === '/api/system/check-update') {
      link.sent.push(`${req.method} ${req.path}`);
      return { status: 200, type: 'application/json', body: { current_version: 'v3.28.10-test.30', checked_at: '2026-11-11T05:56:00Z', update_available: false, prerelease: { version: 'v3.28.10-test.31', available: true } } };
    }
    if (req.path === '/api/system/update') bodies.push(req.body);
    return real(id, req);
  };
  const { q, notes } = make({ link });
  q.add(ID, { kind: 'update' }, 'admin');
  await q.kick(ID);
  assert.deepEqual(link.sent, ['POST /api/system/check-update', 'POST /api/system/update']);
  const sent = bodies[0] && (Buffer.isBuffer(bodies[0]) ? JSON.parse(bodies[0]) : typeof bodies[0] === 'string' ? JSON.parse(bodies[0]) : bodies[0]);
  assert.equal(sent.version, 'v3.28.10-test.31');
  assert.match(q.list(ID).results.find((x) => x.kind === 'update').result.message, /test\.31 started/);
  assert.ok(notes.length >= 0);
});

test('a queued update with no stable release and no newer test build says it is up to date', async () => {
  const link = fakeLink();
  const real = link.request;
  link.request = async (id, req) => {
    if (req.path === '/api/system/check-update') { link.sent.push(`${req.method} ${req.path}`); return { status: 200, type: 'application/json', body: { current_version: 'v3.28.10-test.31', checked_at: '2026-11-11T05:56:00Z', update_available: false, prerelease: { version: 'v3.28.10-test.31', available: false } } }; }
    return real(id, req);
  };
  const { q } = make({ link });
  q.add(ID, { kind: 'update' }, 'admin');
  await q.kick(ID);
  assert.deepEqual(link.sent, ['POST /api/system/check-update']);
  assert.match(q.list(ID).results.find((x) => x.kind === 'update').result.message, /Already up to date \(v3\.28\.10-test\.31\)/);
});
