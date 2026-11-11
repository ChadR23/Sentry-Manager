'use strict';

// The demo's owner page: only local addresses (not through Cloudflare, not
// the Docker gateway), only with DEMO_OWNER_PASSWORD, over HTTPS; probes are
// redirected to / and logged; normal demo traffic is never logged; bans
// through Cloudflare hit the visitor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createOwnerPage, parseGateways, isOwnerLocal } = require('../server/ownerPage');
const { clientAddress, proxyMatcher, cloudflareMatcher } = require('../server/clientAddress');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');

test('the address check: local passes; public, Cloudflare and the Docker gateway do not', () => {
  const route4 = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\neth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n';
  const route6 = '00000000000000000000000000000000 00 00000000000000000000000000000000 00 fd000000000000000000000000000001 00000400 00000001 00000000 00000003 eth0\n';
  const gateways = parseGateways(route4, route6);
  assert.deepEqual(gateways, ['172.17.0.1', 'fd00::1']);
  for (const [cfg, expectTrust] of [[{ trustProxy: false }, false], [{ trustProxy: true }, true]]) {
    const proxy = { ...cfg, trusted: proxyMatcher(''), cloudflare: cloudflareMatcher() };
    const page = createOwnerPage({ password: 'x', clientKey: (r) => clientAddress(r, proxy), proxy, gateways });
    const r = (from, headers = {}) => ({ socket: { remoteAddress: from }, headers });
    for (const ip of ['192.168.1.5', '10.0.0.3', '172.20.1.2', '127.0.0.1', '::1', 'fd12::3', 'fe80::9', '::ffff:192.168.1.5']) assert.equal(page.local(r(ip)), true, ip);
    for (const ip of ['203.0.113.9', '100.64.0.1', '169.254.1.1', '2001:db8::1', '172.32.0.1']) assert.equal(page.local(r(ip)), false, ip);
    // Docker's userland proxy: every public visitor is the gateway, and a forwarded header from it is not believed
    assert.equal(page.local(r('172.17.0.1')), false);
    assert.equal(page.local(r('172.17.0.1', { 'x-forwarded-for': '192.168.1.5' })), false, `TRUST_PROXY ${expectTrust}`);
    assert.equal(page.local(r('fd00::1')), false);
    // through Cloudflare: public, whatever it says
    assert.equal(page.local(r('173.245.48.10', { 'cf-connecting-ip': '192.168.1.5' })), false);
    assert.equal(page.local(r('192.168.1.7', { 'cf-connecting-ip': '192.168.1.7' })), false, 'a tunnel on the LAN');
  }
  // a reverse proxy on the gateway that TRUSTED_PROXIES names: its forwarded address counts
  const listed = proxyMatcher('172.17.0.1');
  const proxy = { trustProxy: true, trusted: listed };
  const page = createOwnerPage({ password: 'x', clientKey: (r) => clientAddress(r, proxy), proxy, listedProxies: listed, gateways });
  assert.equal(page.local({ socket: { remoteAddress: '172.17.0.1' }, headers: { 'x-forwarded-for': '192.168.1.5' } }), true);
  assert.equal(page.local({ socket: { remoteAddress: '172.17.0.1' }, headers: { 'x-forwarded-for': '203.0.113.9' } }), false);
  assert.equal(isOwnerLocal('8.8.8.8'), false);
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startServer(dir, env = {}) {
  const port = await freePort();
  await fsp.mkdir(path.join(dir, 'footage', 'TeslaCam', 'RecentClips'), { recursive: true });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC', LOG_LEVEL: 'info',
      TLS_MODE: 'off', TRUST_PROXY: 'true', UPDATE_CHECK: 'off', DEMO_OWNER_PASSWORD: 'owner pass', TRUST_CLOUDFLARE: '1', ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const device = (from) => {
    const jar = new Map();
    const cookies = [];
    const call = async (method, p, body, headers = {}) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: { 'X-Requested-With': 'sentry-six-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...from, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      for (const c of res.headers.getSetCookie()) {
        cookies.push(c);
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (pair.slice(i + 1) && !/Max-Age=0/.test(c)) jar.set(pair.slice(0, i), pair.slice(i + 1)); else jar.delete(pair.slice(0, i));
      }
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, location: res.headers.get('location'), type: res.headers.get('content-type') };
    };
    return { call, cookies };
  };
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  return { device, stop, output: () => output };
}

const HTTPS = { 'X-Forwarded-Proto': 'https' };
const HOME = { 'X-Forwarded-For': '192.168.1.5', ...HTTPS };
// a visitor through Cloudflare (Cloudflare's address as the hop that reached the local proxy)
const viaCf = (visitor) => ({ 'X-Forwarded-For': '173.245.48.10', 'CF-Connecting-IP': visitor, ...HTTPS });

test('the owner page on a server: local only, password, cookie flags, probes and attacks logged, normal use not, bans hit the visitor', { timeout: 120000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-owner-'));
  const s = await startServer(dir);
  try {
    const owner = s.device(HOME);
    // normal demo use first: signing in and pages that load are never logged
    const user = s.device(viaCf('198.51.100.20'));
    assert.equal((await user.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);
    assert.equal((await user.call('GET', '/api/vehicles')).status, 200);
    assert.equal((await user.call('GET', '/')).status, 200);
    assert.equal((await user.call('GET', '/web/app.js')).status, 200);

    // public visits: an ordinary redirect to /, no hint, logged
    for (const who of [{ 'X-Forwarded-For': '203.0.113.9', ...HTTPS }, viaCf('192.168.1.5'), viaCf('198.51.100.30')]) {
      const r = await s.device(who).call('GET', '/owner');
      assert.deepEqual([r.status, r.location], [302, '/']);
      assert.equal((await s.device(who).call('POST', '/api/owner/login', { password: 'owner pass' })).location, '/');
    }
    // plain HTTP from home: the normal redirect to HTTPS
    const plain = await s.device({ 'X-Forwarded-For': '192.168.1.5' }).call('GET', '/owner');
    assert.equal(plain.status, 308);
    assert.match(plain.location, /^https:\/\/.*\/owner$/);

    // from home: the page, then the password
    const page = await owner.call('GET', '/owner');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.equal((await owner.call('GET', '/api/owner/state')).status, 401);
    assert.equal((await owner.call('POST', '/api/owner/login', { password: 'wrong' })).status, 401);
    const ok = await owner.call('POST', '/api/owner/login', { password: 'owner pass' });
    assert.equal(ok.status, 200);
    const set = owner.cookies.filter((c) => c.startsWith('sm_owner='));
    assert.deepEqual(set.map((c) => /Path=([^;]+)/.exec(c)[1]).sort(), ['/api/owner', '/owner']);
    for (const c of set) for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(c.includes(flag), `${flag} in ${c}`);

    // attacks through Cloudflare, by the visitor's address
    const bad = s.device(viaCf('198.51.100.66'));
    await bad.call('GET', '/wp-login.php');
    await bad.call('GET', '/.env');
    await bad.call('GET', '/?q=${jndi:ldap://e/a}');
    await bad.call('POST', '/api/auth/login', { username: 'root', password: 'secret-guess-1' });
    // three failures ban (the rule set to 3): the visitor, not Cloudflare
    await owner.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    await owner.call('POST', '/api/auth/confirm', { password: 'correct horse' });
    assert.equal((await owner.call('PUT', '/api/security/access', { settings: { bans: { maxFailures: 3 } } })).status, 200);
    await bad.call('POST', '/api/auth/login', { username: 'admin', password: 'secret-guess-2' });
    assert.equal((await bad.call('POST', '/api/auth/login', { username: 'demo', password: 'secret-guess-3' })).data.code, 'BANNED');
    assert.equal((await s.device(viaCf('198.51.100.67')).call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200, 'another visitor through the same Cloudflare address is not banned');

    const st = (await owner.call('GET', '/api/owner/state')).data;
    const by = Object.fromEntries(st.log.map((g) => [g.address, g]));
    assert.deepEqual(Object.keys(by).sort(), ['192.168.1.5', '198.51.100.30', '198.51.100.66', '203.0.113.9'].sort(), JSON.stringify(Object.keys(by)));
    assert.equal(by['203.0.113.9'].kinds['owner-probe'], 2);
    assert.equal(by['198.51.100.30'].kinds['owner-probe'], 2);
    assert.equal(by['192.168.1.5'].kinds['owner-probe'], 2, 'a LAN address through Cloudflare is a probe too');
    assert.equal(by['198.51.100.66'].kinds.scan, 2);
    assert.equal(by['198.51.100.66'].kinds.exploit, 1);
    assert.equal(by['198.51.100.66'].kinds.login, 3);
    assert.ok(by['198.51.100.66'].kinds.ban >= 1);
    assert.ok(!by['173.245.48.10'] && !by['198.51.100.20'] && !by['198.51.100.67'], 'not Cloudflare, not normal use');
    assert.doesNotMatch(JSON.stringify(st), /secret-guess/);
    assert.ok(st.bans.some((b) => b.key === '198.51.100.66'));
    assert.ok(st.visitors.today >= 5);
    assert.equal(st.demo.resetAvailable, false);
    assert.equal((await owner.call('POST', '/api/owner/reset')).status, 409);

    // one-tap ban, CSV
    assert.equal((await owner.call('POST', '/api/owner/ban', { address: '203.0.113.9' })).status, 200);
    assert.equal((await owner.call('POST', '/api/owner/ban', { address: '192.168.1.9' })).status, 400);
    assert.equal((await s.device({ 'X-Forwarded-For': '203.0.113.9', ...HTTPS }).call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 429);
    const csv = await owner.call('GET', '/api/owner/log.csv?kind=scan');
    assert.match(csv.type, /text\/csv/);
    assert.match(csv.data, /"198\.51\.100\.66","scan","2"/);
    assert.equal((await owner.call('POST', '/api/owner/logout')).status, 200);
    assert.equal((await owner.call('GET', '/api/owner/state')).status, 401);
  } finally {
    await s.stop();
  }
});

test('without DEMO_OWNER_PASSWORD there is no owner page', { timeout: 60000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-owner-'));
  const s = await startServer(dir, { DEMO_OWNER_PASSWORD: '' });
  try {
    const home = s.device(HOME);
    const unknown = await home.call('GET', '/no-such-page');
    const r = await home.call('GET', '/owner');
    assert.deepEqual([r.status, r.location], [unknown.status, unknown.location.replace('no-such-page', 'owner')]);
    assert.equal((await home.call('GET', '/api/owner/state')).status, (await home.call('GET', '/api/no-such')).status);
    assert.equal((await home.call('POST', '/api/owner/login', { password: '' })).status, 404);
  } finally {
    await s.stop();
  }
});
