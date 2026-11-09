'use strict';

// Bans after failed sign-ins (kept across restarts, home exempt by default,
// longer for repeat offenders) and the Settings → Security validation.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccess, validate, DEFAULTS } = require('../server/access');

function memoryDb() {
  const kv = new Map();
  return { get: (k, fb = null) => (kv.has(k) ? JSON.parse(JSON.stringify(kv.get(k))) : fb), set: (k, v) => kv.set(k, JSON.parse(JSON.stringify(v))) };
}
function auditLog() {
  const lines = [];
  return { lines, warn: (l) => lines.push(l), info: (l) => lines.push(l) };
}

test('defaults: bans on (10 in 60 min, 1 h, up to 24 h, home exempt); every rule for the internet off', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULTS)), {
    bans: { enabled: true, maxFailures: 10, windowMinutes: 60, banMinutes: 60, maxBanHours: 24, exemptHome: true },
    twoFactor: { outside: false, everyone: false },
    homeOnly: { adminChanges: false, adminPages: false },
    home: { tailscale: false, extra: [] }
  });
});

test('a ban after N failures within the window; it expires; failures outside the window do not count', () => {
  let now = Date.UTC(2026, 10, 9, 12);
  const audit = auditLog();
  const a = createAccess({ db: memoryDb(), audit, now: () => now });
  for (let i = 0; i < 9; i++) assert.equal(a.fail('203.0.113.9', 'wrong password'), null);
  assert.equal(a.banned('203.0.113.9'), null);
  const b = a.fail('::ffff:203.0.113.9', 'wrong password');
  assert.equal(b.key, '203.0.113.9');
  assert.equal(b.until - b.at, 60 * 60_000);
  assert.ok(a.banned('203.0.113.9'));
  assert.equal(a.banned('203.0.113.10'), null, 'another address is not');
  assert.match(audit.lines.at(-1), /^Banned 203\.0\.113\.9 for 1 h \(until .*\) after 10 failed attempts in 60 min \(last: wrong password\)$/);
  assert.equal(a.list().length, 1);
  now += 60 * 60_000 + 1;
  assert.equal(a.banned('203.0.113.9'), null, 'expired');
  assert.equal(a.list().length, 0);
  // slow failures: never ten within the hour
  for (let i = 0; i < 20; i++) { now += 7 * 60_000; a.fail('198.51.100.1', 'wrong password'); }
  assert.equal(a.banned('198.51.100.1'), null);
});

test('repeat offenders: each ban within a week doubles, up to the longest ban', () => {
  let now = Date.UTC(2026, 10, 9, 12);
  const a = createAccess({ db: memoryDb(), now: () => now });
  a.set(validate({ bans: { maxFailures: 3, banMinutes: 60, maxBanHours: 3 } }, a.get()));
  const lengths = [];
  for (let round = 0; round < 4; round++) {
    let b = null;
    for (let i = 0; i < 3; i++) b = a.fail('203.0.113.9', 'wrong two-step code');
    lengths.push((b.until - b.at) / 60_000);
    now = b.until + 1;
  }
  assert.deepEqual(lengths, [60, 120, 180, 180]);
  // a week later it starts again
  now += 8 * 24 * 3600_000;
  let b = null;
  for (let i = 0; i < 3; i++) b = a.fail('203.0.113.9', 'x');
  assert.equal((b.until - b.at) / 60_000, 60);
});

test('bans are kept across restarts, and an unban lifts one and is in the audit log', () => {
  const now = Date.UTC(2026, 10, 9, 12);
  const db = memoryDb();
  const audit = auditLog();
  const a = createAccess({ db, audit, now: () => now });
  for (let i = 0; i < 10; i++) a.fail('2001:db8:5:6::1', 'wrong password');
  const again = createAccess({ db, audit, now: () => now + 1000 });
  assert.ok(again.banned('2001:db8:5:6:ffff::2'), 'the same /64, after a restart');
  assert.equal(again.list()[0].key, '2001:db8:5:6::/64');
  assert.throws(() => again.unban('203.0.113.1'), /not banned/);
  again.unban('2001:db8:5:6::/64', 'admin from 192.168.1.5');
  assert.equal(again.banned('2001:db8:5:6::1'), null);
  assert.equal(audit.lines.at(-1), 'Unbanned 2001:db8:5:6::/64: admin from 192.168.1.5');
  assert.equal(createAccess({ db, now: () => now }).list().length, 0, 'the unban is kept too');
});

test('the home network is never banned by default; the setting turns that off', () => {
  const a = createAccess({ db: memoryDb() });
  for (let i = 0; i < 30; i++) assert.equal(a.fail('192.168.1.5', 'wrong password'), null);
  assert.equal(a.banned('192.168.1.5'), null);
  a.set(validate({ bans: { exemptHome: false } }, a.get()));
  let b = null;
  for (let i = 0; i < 10; i++) b = a.fail('192.168.1.5', 'wrong password');
  assert.ok(b);
  assert.ok(a.banned('192.168.1.5'));
  // and turned back on, the home address is let in again
  a.set(validate({ bans: { exemptHome: true } }, a.get()));
  assert.equal(a.banned('192.168.1.5'), null);
  // an extra home range is exempt as well
  a.set(validate({ home: { extra: ['198.51.100.0/24'] } }, a.get()));
  for (let i = 0; i < 20; i++) assert.equal(a.fail('198.51.100.9', 'x'), null);
  // bans turned off: nothing is counted
  a.set(validate({ bans: { enabled: false } }, a.get()));
  for (let i = 0; i < 20; i++) assert.equal(a.fail('203.0.113.50', 'x'), null);
});

test('the store is bounded', () => {
  const db = memoryDb();
  const a = createAccess({ db });
  a.set(validate({ bans: { maxFailures: 3 } }, a.get()));
  for (let n = 0; n < 2100; n++) {
    const ip = `198.18.${n >> 8}.${n & 255}`;
    for (let i = 0; i < 3; i++) a.fail(ip, 'x');
  }
  assert.ok(db.get('security:bans').length <= 2000);
  assert.ok(a.banned('198.18.8.51'), 'the newest are kept');
});

test('validation: numbers in range, on/off as booleans, extra ranges checked; a part keeps the rest', () => {
  const cur = validate({}, DEFAULTS);
  assert.deepEqual(cur, JSON.parse(JSON.stringify(DEFAULTS)));
  assert.equal(validate({ twoFactor: { outside: true } }, cur).bans.maxFailures, 10);
  for (const [bad, msg] of [
    [{ bans: { maxFailures: 2 } }, /from 3 to 100/],
    [{ bans: { maxFailures: 4.5 } }, /whole number/],
    [{ bans: { windowMinutes: 0 } }, /from 1 to 1440/],
    [{ bans: { banMinutes: 120, maxBanHours: 1 } }, /cannot be shorter/],
    [{ bans: { enabled: 'yes' } }, /true or false/],
    [{ twoFactor: { sometimes: true } }, /Unknown setting/],
    [{ other: {} }, /Unknown setting/],
    [{ home: { extra: ['not-an-ip'] } }, /not an address/],
    [{ home: { extra: ['0.0.0.0/0'] } }, /too wide/],
    [{ home: { extra: ['::/0'] } }, /too wide/],
    [{ home: { extra: Array.from({ length: 33 }, (_, i) => `198.51.100.${i}`) } }, /At most 32/],
    [null, /object/]
  ]) assert.throws(() => validate(bad, cur), msg, JSON.stringify(bad));
  const ok = validate({ home: { extra: '198.51.100.0/24\n2001:DB8::/48, 198.51.100.0/24 203.0.113.5/32' } }, cur);
  assert.deepEqual(ok.home.extra, ['198.51.100.0/24', '2001:db8::/48', '203.0.113.5']);
});
