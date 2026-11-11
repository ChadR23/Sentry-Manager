'use strict';

// The reports' scrubber (server/reportsScrub.js): secrets never leave, and
// with "Send anonymously" every identifier becomes ANON, in fields and in
// free text (log lines, stack traces).

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripSecrets, stripSecretText, anonymize, cleanReport, makeAnonymizer, isSecretKey, isIdKey, ANON, REMOVED } = require('../server/reportsScrub');

test('secrets by field name, at any depth; yes/no flags kept', () => {
  const out = stripSecrets({
    password: 'hunter2', smbPassword: 'x', passwordSet: true, token: 'abc', tokenHash: 'deadbeef', apiKey: 'k', api_key: 'k', privateKey: 'p', secret: 's',
    cookie: 'c', webhook: 'w', discordWebhook: 'w', linkKey: 'l', recoveryCodes: ['a'], totp: { secret: 'x' }, session: 's', sessionId: 'i', credentials: { user: 'u' },
    authorization: 'Bearer x', psk: 'wifi', setupCode: '123', pairingCode: 'AB-12',
    nested: [{ deep: { password: 'p2', ok: 'kept' } }],
    harmless: { keyframe: 1, monkeyName: 'kept', name: 'kept', tokens: null }
  });
  for (const k of ['password', 'smbPassword', 'token', 'tokenHash', 'apiKey', 'api_key', 'privateKey', 'secret', 'cookie', 'webhook', 'discordWebhook', 'linkKey', 'recoveryCodes', 'totp', 'session', 'sessionId', 'credentials', 'authorization', 'psk', 'setupCode', 'pairingCode']) {
    assert.equal(out[k], REMOVED, k);
  }
  assert.equal(out.passwordSet, true);
  assert.equal(out.nested[0].deep.password, REMOVED);
  assert.equal(out.nested[0].deep.ok, 'kept');
  assert.equal(out.harmless.keyframe, 1);
  assert.equal(out.harmless.name, 'kept');
  assert.equal(out.harmless.tokens, null);
  assert.ok(isSecretKey('SMB_PASSWORD') && isSecretKey('link-key') && !isSecretKey('keyframe') && !isSecretKey('name'));
});

test('secrets inside text: keys, URLs with passwords, webhooks, headers, pairs, tokens', () => {
  const text = [
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----',
    'mount //nas/share -o username=bob,password=s3cret!,vers=3.1.1',
    'smb://bob:s3cret@nas.local/TeslaCam',
    'https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz',
    'https://hooks.slack.com/services/T0/B0/xyz',
    'Authorization: Bearer abcdefghijklmnop.qrs',
    'token=abc123 secret: "x y z" api_key=K-1 sm_session=zzz; other=1',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    // a key cut off part way: everything after its start goes
    '-----BEGIN EC PRIVATE KEY-----\nabcSECRETrest'
  ].join('\n');
  const out = stripSecretText(text);
  for (const s of ['MIIEvQIBADANBg', 's3cret', 'abcdefghijklmnopqrstuvwxyz', 'services/T0', 'abcdefghijklmnop', 'abc123', 'x y z', 'K-1', 'zzz', 'eyJhbGci', 'ghp_', 'SECRETrest']) {
    assert.ok(!out.includes(s), `${s} is gone`);
  }
  assert.match(out, /vers=3\.1\.1/, 'what is not secret stays');
  assert.match(out, /other=1/);
  assert.match(out, /smb:\/\/\[removed\]@nas\.local/);
});

test('anonymous: identifiers by field name', () => {
  const out = anonymize({
    hostname: 'tower', ip: '10.0.0.4', mac: 'aa:bb:cc:dd:ee:ff', ssid: 'Home WiFi', vin: '5YJ3E1EA7KF123456', email: 'a@b.co', username: 'bob', accounts: ['bob', 'kid'],
    lat: 30.26, lon: -97.74, city: 'Austin', path: '/footage/car', share: '//nas/TeslaCam', home: { ssid: 'x', gw: '10.0.0.1' }, install: 'f'.repeat(32),
    keep: { paired: true, cores: 8, model: 'Intel(R) Core(TM) i5', kernel: '6.18.44-fc' }
  });
  for (const k of ['hostname', 'ip', 'mac', 'ssid', 'vin', 'email', 'username', 'accounts', 'lat', 'lon', 'city', 'path', 'share', 'home', 'install']) assert.equal(out[k], ANON, k);
  assert.deepEqual(out.keep, { paired: true, cores: 8, model: 'Intel(R) Core(TM) i5', kernel: '6.18.44-fc' });
  assert.ok(isIdKey('host_name') && isIdKey('IPAddress') && !isIdKey('cores'));
});

test('anonymous: identifiers by pattern in every string (logs and stacks too)', () => {
  const a = makeAnonymizer([]);
  const cases = [
    ['from 192.168.1.50:445 ok', 'from ANON:445 ok'],
    ['peer ::ffff:10.1.2.3 and fe80::1%eth0 and 2001:db8::8a2e:370:7334', null],
    ['mac 00:1A:2B:3C:4D:5E / 00-1a-2b-3c-4d-5e', 'mac ANON / ANON'],
    ['car 5YJ3E1EA7KF123456 and LRW3E7EK1NC123456 and 7SAYGDEE1PA123456', 'car ANON and ANON and ANON'],
    ['mail bob.smith+x@example.co.uk now', 'mail ANON now'],
    ['at 30.267153, -97.743057 today', 'at ANON today'],
    ['{"lat":30.2672,"lon":-97.7431}', '{"lat":ANON,"lon":ANON}'],
    ['share \\\\nas\\TeslaCam\\RecentClips and //nas2/cam', 'share ANON and ANON'],
    ['host pi.local and tower.lan and car.tail1234.ts.net', 'host ANON and ANON and ANON'],
    ['fetch https://my-ddns.example.net/x failed, https://github.com/a ok', 'fetch https://ANON/x failed, https://github.com/a ok']
  ];
  for (const [input, want] of cases) {
    const got = a(input);
    if (want) assert.equal(got, want, input);
    assert.doesNotMatch(got, /\d+\.\d+\.\d+\.\d+|fe80|2001:db8|@example|5YJ|30\.26|nas\b|pi\.local/i, `${input} -> ${got}`);
  }
  // what is not an identifier stays as it was
  for (const keep of ['2026-11-11T18:20:30.000Z', 'at 12:30:00', 'node v26.13.0', 'ffmpeg version 7.1.1', 'kernel 6.18.44-fc-v378', 'sha 1345348', 'Build 130', 'a 1:2 ratio', 'Error: x\n    at foo (/app/server/index.js:12:5)']) {
    assert.equal(a(keep), keep, keep);
  }
});

test('anonymous: the server\'s own identifiers wherever they appear, keys too', () => {
  const ids = ['Daily Driver', 'veh-abc123', 'tower', '/footage/daily', 'bob', 'SentryPi', 'Home WiFi', 'Mom\'s house'];
  const out = anonymize({
    note: 'Daily Driver (veh-abc123) on tower: /footage/daily/TeslaCam missing; signed in as bob; SentryPi on Home WiFi near Mom\'s house',
    policies: { 'veh-abc123': { keepDays: 30 }, other: 1 },
    logs: ['2026-11-11 WARN [share] daily driver share /footage/daily went away'],
    stack: 'Error: ENOENT /footage/daily/x\n    at read (/app/server/x.js:1:1)'
  }, { identifiers: ids });
  const all = JSON.stringify(out);
  for (const s of ['Daily Driver', 'daily driver', 'veh-abc123', 'tower', '/footage/daily', 'bob', 'SentryPi', 'Home WiFi', 'Mom']) assert.ok(!all.includes(s), s);
  assert.deepEqual(Object.keys(out.policies), ['ANON-1', 'other']);
  assert.equal(out.policies['ANON-1'].keepDays, 30);
  assert.match(out.stack, /at read \(\/app\/server\/x\.js:1:1\)/, 'the code\'s own paths stay');
  // short or empty identifiers are not used (they would eat ordinary words)
  assert.equal(makeAnonymizer(['a', '', null, 'ok'])('a car is ok'), 'a car is ok');
  // whole words only
  assert.equal(makeAnonymizer(['Car'])('Scarlet Car car'), 'Scarlet ANON ANON');
});

test('cleanReport: secrets always, identifiers only when anonymous', () => {
  const v = { hostname: 'tower', password: 'x', log: 'login from 10.0.0.9 token=abc' };
  assert.deepEqual(cleanReport(v), { hostname: 'tower', password: REMOVED, log: 'login from 10.0.0.9 token=[removed]' });
  assert.deepEqual(cleanReport(v, { anonymous: true }), { hostname: ANON, password: REMOVED, log: 'login from ANON token=[removed]' });
});

test('secrets inside JSON text and cifs pass= are removed (an error message or a log line quoting a settings object)', () => {
  const t = stripSecretText('Mount failed: {"username":"bob","password":"hunter 2","smbPass": "x9"} -o username=bob,pass=hunter2,vers=3.0');
  assert.doesNotMatch(t, /hunter|x9/);
  assert.match(t, /"username":"bob"/, 'the rest stays');
  assert.match(t, /vers=3\.0/);
});

test('anonymous: an IPv6 address right after a word and a colon (ip:2001:db8::1) becomes ANON; times and line numbers stay', () => {
  const anon = makeAnonymizer([]);
  assert.equal(anon('ip:2001:db8::1 peer:fe80::1%eth0'), 'ip:ANON peer:ANON');
  assert.equal(anon('10:00:00 at x.js:10:5 2026-11-11T10:00:00.000Z'), '10:00:00 at x.js:10:5 2026-11-11T10:00:00.000Z');
});
