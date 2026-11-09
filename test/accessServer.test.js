'use strict';

// Settings → Security for a server open to the internet, on the real
// server: bans, the two-step rules and admin work only from the home
// network. The tests run on loopback, so "where a request comes from" is
// set the way a reverse proxy does it: TRUST_PROXY with X-Forwarded-For from
// a proxy on the local network (loopback here). 192.168.1.5 is a device at
// home, 203.0.113.x the internet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { totp } = require('../server/accounts');

const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'server', 'index.js');
const HOME = { 'X-Forwarded-For': '192.168.1.5' };
const OUT = { 'X-Forwarded-For': '203.0.113.9' };
const out = (n) => ({ 'X-Forwarded-For': `203.0.113.${n}` });

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer(dir, env = {}) {
  const port = await freePort();
  await fsp.mkdir(path.join(dir, 'footage', 'TeslaCam', 'RecentClips'), { recursive: true });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC',
      LOG_LEVEL: 'info', TLS_MODE: 'off', TRUST_PROXY: 'true', UPDATE_CHECK: 'off', ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // one client per "device": its own cookies
  const device = (from) => {
    const jar = new Map();
    const call = async (method, p, body, headers = {}) => {
      const res = await fetch(base + p, {
        method,
        headers: { 'X-Requested-With': 'sentry-six-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...from, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        const v = pair.slice(i + 1);
        if (v && !/Max-Age=0/.test(c)) jar.set(pair.slice(0, i), v); else jar.delete(pair.slice(0, i));
      }
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, location: res.headers.get('location') };
    };
    return { call, jar, from: (f) => { from = f; } };
  };
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', (code) => resolve(code));
    child.kill('SIGTERM');
  });
  return { base, device, stop, output: () => output };
}

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'sm-access-'));
const settle = () => new Promise((r) => setTimeout(r, 300));

async function signIn(d, user = 'admin', password = 'correct horse') {
  const r = await d.call('POST', '/api/auth/login', { username: user, password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r;
}
async function saveRules(admin, settings) {
  await admin.call('POST', '/api/auth/confirm', { password: 'correct horse' });
  return admin.call('PUT', '/api/security/access', { settings });
}

test('bans: failed sign-ins from the internet ban the address (kept across a restart), never the home network; unban; audit lines', { timeout: 120000 }, async () => {
  const dir = await tmp();
  let s = await startServer(dir);
  try {
    const admin = s.device(HOME);
    await signIn(admin);
    let v = await admin.call('GET', '/api/security/access');
    assert.equal(v.status, 200);
    assert.equal(v.data.you.address, '192.168.1.5');
    assert.equal(v.data.you.home, true);
    assert.equal(v.data.settings.bans.maxFailures, 10);
    // changing the rules checks what is sent
    assert.equal((await saveRules(admin, { bans: { maxFailures: 1 } })).status, 400);
    v = await saveRules(admin, { bans: { maxFailures: 3 } });
    assert.equal(v.status, 200, JSON.stringify(v.data));
    assert.equal(v.data.settings.bans.maxFailures, 3);

    // the internet: three wrong passwords (one for a name that does not exist), the third bans
    const bad = s.device(OUT);
    assert.equal((await bad.call('POST', '/api/auth/login', { username: 'admin', password: 'nope1' })).status, 401);
    assert.equal((await bad.call('POST', '/api/auth/login', { username: 'nobody', password: 'nope2' })).status, 401);
    const third = await bad.call('POST', '/api/auth/login', { username: 'admin', password: 'nope3' });
    assert.equal(third.status, 429);
    assert.equal(third.data.code, 'BANNED');
    const msg = third.data.error;
    assert.doesNotMatch(msg, /admin|user|exist/i, 'nothing about accounts');
    // now even the right password is refused, the same way for any name
    const right = await bad.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    assert.deepEqual([right.status, right.data.error], [429, msg]);
    assert.deepEqual([(await bad.call('POST', '/api/auth/login', { username: 'nobody', password: 'x' })).data.error], [msg]);
    assert.equal((await bad.call('POST', '/api/auth/2fa/code', { code: '123456' })).status, 429);
    assert.equal((await bad.call('GET', '/api/vehicles')).status, 429);
    assert.equal((await bad.call('GET', '/login')).status, 200, 'the sign-in page still opens, to say so');
    // another internet address is not banned
    assert.equal((await s.device(out(10)).call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);

    // the home network is never banned (the slow-down still applies)
    const home = s.device({ 'X-Forwarded-For': '192.168.1.77' });
    for (let i = 0; i < 4; i++) assert.equal((await home.call('POST', '/api/auth/login', { username: 'admin', password: `wrong${i}` })).status, 401);
    v = await admin.call('GET', '/api/security/access');
    assert.deepEqual(v.data.bans.map((b) => b.key), ['203.0.113.9']);
    assert.equal(v.data.bans[0].failures, 3);
    assert.equal(v.data.bans[0].reason, 'wrong password');
    assert.ok(v.data.bans[0].until - v.data.bans[0].at === 3600_000);

    // a signed-in session guessing its password in confirmations: banned, and signed out
    const thief = s.device(out(20));
    await signIn(thief);
    for (let i = 0; i < 2; i++) assert.equal((await thief.call('POST', '/api/auth/confirm', { password: `guess${i}` })).status, 401);
    assert.equal((await thief.call('POST', '/api/auth/confirm', { password: 'guess3' })).data.code, 'BANNED');
    assert.equal((await thief.call('GET', '/api/vehicles')).status, 429, 'its session is gone');

    // a wrong current password counts too (the slow-down's count for the account starts again after a right confirmation)
    await admin.call('POST', '/api/auth/confirm', { password: 'correct horse' });
    const pw = s.device(out(30));
    await signIn(pw);
    for (let i = 0; i < 3; i++) await pw.call('POST', '/api/auth/password', { current: `wrong${i}`, next: 'something new 1' });
    assert.ok((await admin.call('GET', '/api/security/access')).data.bans.some((b) => b.key === '203.0.113.30' && b.reason === 'wrong current password'));
  } finally {
    await s.stop();
  }
  // kept across a restart
  s = await startServer(dir);
  try {
    const admin = s.device(HOME);
    await signIn(admin);
    const v = await admin.call('GET', '/api/security/access');
    assert.ok(v.data.bans.some((b) => b.key === '203.0.113.9'));
    assert.equal((await s.device(OUT).call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).data.code, 'BANNED');
    // Unban: the address can sign in again
    const u = await admin.call('POST', '/api/security/unban', { address: '203.0.113.9' });
    assert.equal(u.status, 200);
    assert.ok(!u.data.bans.some((b) => b.key === '203.0.113.9'));
    assert.equal((await admin.call('POST', '/api/security/unban', { address: '203.0.113.9' })).status, 404);
    assert.equal((await s.device(OUT).call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);
    // a watch-only account cannot see or change any of it
    await admin.call('POST', '/api/auth/confirm', { password: 'correct horse' });
    assert.equal((await admin.call('POST', '/api/accounts', { username: 'kid', password: 'kid password', role: 'viewer' })).status, 200);
    const kid = s.device(HOME);
    await signIn(kid, 'kid', 'kid password');
    assert.equal((await kid.call('GET', '/api/security/access')).status, 403);
    assert.equal((await kid.call('POST', '/api/security/unban', { address: '203.0.113.30' })).status, 403);
    assert.equal((await kid.call('PUT', '/api/security/access', { settings: { bans: { enabled: false } } })).status, 403);
    await settle();
    const log = s.output();
    assert.match(log, /\[audit\] Unbanned 203\.0\.113\.9: admin from 192\.168\.1\.5/);
  } finally {
    await s.stop();
  }
  // the first run's log is in the data folder
  const kept = await fsp.readFile(path.join(dir, 'data', 'logs', 'manager.log'), 'utf8');
  assert.match(kept, /\[audit\] Security settings changed \(bans\.maxFailures 10 → 3\): admin from 192\.168\.1\.5/);
  assert.match(kept, /\[audit\] Banned 203\.0\.113\.9 for 1 h \(until [^)]+\) after 3 failed attempts in 60 min \(last: wrong password\)/);
  assert.match(kept, /\[audit\] Banned 203\.0\.113\.20 .*last: wrong password confirmation/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('two-step rules: outside the home network only with two-step sign-in (a recovery code works); every account; no bypass with a session from home', { timeout: 120000 }, async () => {
  const dir = await tmp();
  const s = await startServer(dir);
  try {
    const admin = s.device(HOME);
    await signIn(admin);
    await admin.call('POST', '/api/auth/confirm', { password: 'correct horse' });
    assert.equal((await admin.call('POST', '/api/accounts', { username: 'kid', password: 'kid password', role: 'viewer' })).status, 200);
    // off by default: anyone signs in from anywhere
    assert.equal((await s.device(OUT).call('POST', '/api/auth/login', { username: 'kid', password: 'kid password' })).status, 200);
    // the kid's phone, signed in at home
    const phone = s.device(HOME);
    await signIn(phone, 'kid', 'kid password');

    // (a) outside needs two-step sign-in. The admin has none, but is at home: allowed.
    // From outside without it, turning it on would sign the admin out: refused.
    const away = s.device(OUT);
    await signIn(away);
    assert.equal((await saveRules(away, { twoFactor: { outside: true } })).status, 409);
    assert.equal((await saveRules(admin, { twoFactor: { outside: true } })).status, 200);
    // that admin session outside is signed out on its next request
    const gone = await away.call('GET', '/api/vehicles');
    assert.equal(gone.status, 401);
    assert.equal(gone.data.code, 'TWO_FACTOR_REQUIRED');
    phone.from(HOME);
    assert.equal((await phone.call('GET', '/api/vehicles')).status, 200, 'at home it still works');
    // the same session taken outside: signed out, and stays signed out at home
    phone.from(OUT);
    assert.equal((await phone.call('GET', '/api/vehicles')).data.code, 'TWO_FACTOR_REQUIRED');
    phone.from(HOME);
    assert.equal((await phone.call('GET', '/api/vehicles')).status, 401);
    // sign-in from outside without it: refused with what to do; at home: fine
    const refused = await s.device(OUT).call('POST', '/api/auth/login', { username: 'kid', password: 'kid password' });
    assert.equal(refused.status, 403);
    assert.equal(refused.data.code, 'TWO_FACTOR_REQUIRED');
    assert.match(refused.data.error, /home network/);
    // a wrong password from outside is still just wrong
    assert.equal((await s.device(OUT).call('POST', '/api/auth/login', { username: 'kid', password: 'nope' })).status, 401);
    await signIn(s.device(HOME), 'kid', 'kid password');

    // the admin turns two-step sign-in on (at home)
    await admin.call('POST', '/api/auth/confirm', { password: 'correct horse' });
    const { secret } = (await admin.call('POST', '/api/auth/2fa/start', {})).data;
    const step = Math.floor(Date.now() / 30000);
    const en = await admin.call('POST', '/api/auth/2fa/enable', { code: totp(secret, step) });
    assert.equal(en.status, 200);
    // from outside now: the password, then the code; a recovery code works as the code
    const trip = s.device(OUT);
    const first = await trip.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    assert.equal(first.data.twoFactor, true);
    assert.equal((await trip.call('POST', '/api/auth/2fa/code', { code: en.data.recovery[0] })).status, 200);
    assert.equal((await trip.call('GET', '/api/vehicles')).status, 200);
    const trip2 = s.device(out(11));
    await trip2.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    assert.equal((await trip2.call('POST', '/api/auth/2fa/code', { code: totp(secret, step + 1) })).status, 200);
    assert.equal((await trip2.call('GET', '/api/vehicles')).status, 200);

    // (b) every account: the kid at home may only set it up; from outside not at all
    assert.equal((await saveRules(admin, { twoFactor: { everyone: true } })).status, 200);
    const home = s.device(HOME);
    const r = await signIn(home, 'kid', 'kid password');
    assert.equal(r.data.twoFactorSetup, true);
    assert.equal(r.data.next, '/login/two-factor');
    const blocked = await home.call('GET', '/api/vehicles');
    assert.deepEqual([blocked.status, blocked.data.code], [403, 'TWO_FACTOR_SETUP']);
    assert.equal((await home.call('GET', '/')).location, '/login/two-factor');
    const page = await home.call('GET', '/login/two-factor');
    assert.equal(page.status, 200);
    assert.match(page.data, /Set up two-step sign-in/);
    assert.equal((await home.call('GET', '/api/auth/me')).data.twoFactorSetupRequired, true);
    const kidSetup = (await home.call('POST', '/api/auth/2fa/start', {})).data;
    assert.ok(kidSetup.secret);
    assert.equal((await home.call('POST', '/api/auth/2fa/enable', { code: totp(kidSetup.secret, Math.floor(Date.now() / 30000)) })).status, 200);
    assert.equal((await home.call('GET', '/api/vehicles')).status, 200, 'set up: everything opens');
    const outKid = await s.device(OUT).call('POST', '/api/auth/login', { username: 'kid', password: 'kid password' });
    assert.equal(outKid.data.twoFactor, true, 'and from outside it is the code now');
    // an account without it, from outside, under (b) alone
    assert.equal((await saveRules(admin, { twoFactor: { outside: false } })).status, 200);
    await admin.call('POST', '/api/accounts', { username: 'gran', password: 'gran password', role: 'viewer' });
    const gran = await s.device(OUT).call('POST', '/api/auth/login', { username: 'gran', password: 'gran password' });
    assert.deepEqual([gran.status, gran.data.code], [403, 'TWO_FACTOR_REQUIRED']);
    assert.match(gran.data.error, /Every account needs two-step sign-in/);
    await settle();
    assert.match(s.output(), /\[audit\] Sign-in refused \(no two-step sign-in, outside the home network\): kid from 203\.0\.113\.9/);
    assert.match(s.output(), /\[audit\] Signed out \(no two-step sign-in, outside the home network\): kid from 203\.0\.113\.9/);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('admin work only from the home network: changes refused from outside, viewing allowed; the stricter rule makes admins watch-only outside', { timeout: 120000 }, async () => {
  const dir = await tmp();
  const s = await startServer(dir);
  try {
    const admin = s.device(HOME);
    await signIn(admin);
    assert.equal((await saveRules(admin, { homeOnly: { adminChanges: true } })).status, 200);
    const away = s.device(OUT);
    await signIn(away);
    await away.call('POST', '/api/auth/confirm', { password: 'correct horse' });
    // viewing works
    for (const p of ['/api/vehicles', '/api/settings', '/api/security', '/api/security/access', '/api/accounts', '/api/logs']) assert.equal((await away.call('GET', p)).status, 200, p);
    // every admin change is refused, with what to do
    for (const [m, p, b] of [
      ['PUT', '/api/security/access', { settings: { homeOnly: { adminChanges: false } } }],
      ['POST', '/api/accounts', { username: 'x', password: 'whatever123', role: 'admin' }],
      ['POST', '/api/vehicles/daily-driver/scan', {}],
      ['POST', '/api/security/unban', { address: '203.0.113.1' }],
      ['POST', '/api/can/tokens', { name: 'x' }],
      ['PUT', '/api/ui-packs/active', { id: null }],
      ['POST', '/api/ui-packs/upload', {}]
    ]) {
      const r = await away.call(m, p, b);
      assert.deepEqual([r.status, r.data.code], [403, 'HOME_NETWORK_ONLY'], `${m} ${p}`);
      assert.match(r.data.error, /home network/);
    }
    // what any account may do still works (own password check, signing out other devices)
    assert.equal((await away.call('POST', '/api/auth/confirm', { password: 'correct horse' })).status, 200);
    assert.equal((await away.call('GET', '/api/auth/me')).data.adminLimited, 'changes');
    // at home the same change works
    assert.equal((await admin.call('POST', '/api/vehicles/daily-driver/scan', {})).status, 200);

    // stricter: admin pages too
    assert.equal((await saveRules(admin, { homeOnly: { adminPages: true } })).status, 200);
    const me = (await away.call('GET', '/api/auth/me')).data;
    assert.equal(me.role, 'viewer', 'outside, the admin is shown as watch-only');
    assert.equal(me.adminLimited, 'pages');
    assert.equal((await away.call('GET', '/api/vehicles')).status, 200);
    for (const p of ['/api/security/access', '/api/accounts', '/api/logs']) assert.equal((await away.call('GET', p)).data.code, 'HOME_NETWORK_ONLY', p);
    assert.equal((await admin.call('GET', '/api/auth/me')).data.role, 'admin', 'at home: admin');
    assert.equal((await admin.call('GET', '/api/security/access')).status, 200);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('turning on "every account" needs two-step sign-in on your own account; wrong setup codes count towards a ban', { timeout: 120000 }, async () => {
  let dir = await tmp();
  let s = await startServer(dir);
  try {
    const admin = s.device(HOME);
    await signIn(admin);
    const r = await saveRules(admin, { twoFactor: { everyone: true } });
    assert.deepEqual([r.status, /your own account/.test(r.data.error)], [409, true]);
    // nothing else changed either
    assert.equal((await admin.call('GET', '/api/security/access')).data.settings.twoFactor.everyone, false);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
  // a first start with no account: the setup code, guessed from the internet
  dir = await tmp();
  s = await startServer(dir, { UI_PASSWORD: '' });
  try {
    const d = s.device(OUT);
    const codes = [];
    for (let i = 0; i < 10; i++) codes.push((await d.call('POST', '/api/auth/setup', { username: 'admin', password: 'a long password', code: 'AAAAA-AAAAA-AAAAA' })).status);
    assert.deepEqual(codes.slice(0, 5), [403, 403, 403, 403, 403]);
    // the slow-down holds it after five; the ban (10 in an hour by default) is reached when it lets the next ones through
    assert.ok(codes.slice(5).every((c) => c === 429));
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the client address: X-Forwarded-For counts only from a trusted proxy; without TRUST_PROXY never', { timeout: 120000 }, async () => {
  // the proxy is 10.255.255.1 only: these loopback connections are not it, so their header is ignored
  for (const env of [{ TRUSTED_PROXIES: '10.255.255.1' }, { TRUST_PROXY: 'false' }]) {
    const dir = await tmp();
    const s = await startServer(dir, env);
    try {
      const d = s.device(OUT);
      assert.equal((await d.call('POST', '/api/auth/login', { username: 'admin', password: 'nope' })).status, 401);
      await signIn(d);
      const v = await d.call('GET', '/api/security/access');
      assert.equal(v.data.you.address, '127.0.0.1', JSON.stringify(env));
      // X-Forwarded-Proto is not believed from it either
      assert.equal((await d.call('GET', '/api/security', undefined, { 'X-Forwarded-Proto': 'https' })).data.https, false);
      await settle();
      assert.match(s.output(), /Sign-in failed for "admin" from 127\.0\.0\.1/);
      assert.doesNotMatch(s.output(), /203\.0\.113\.9/);
    } finally {
      await s.stop();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }
});
