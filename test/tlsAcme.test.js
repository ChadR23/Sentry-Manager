'use strict';

// Let's Encrypt (server/acme.js) against a local fake ACME server
// (test/fixtures/fakeAcme.js). Never calls Let's Encrypt.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { spawn, spawnSync } = require('child_process');
const acme = require('../server/acme');
const { TlsManager, localTlsSource, supervisorTlsSource } = require('../server/tls');
const { startFakeAcme, httpGet } = require('./fixtures/fakeAcme');

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'sm-acme-'));
const quiet = { info() {}, warn() {}, error() {} };
const DAY = 24 * 3600 * 1000;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** The plain-HTTP side of port 9000, in small: the challenge for pending tokens, a redirect for everything else. */
async function front(lookup) {
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const ka = p.startsWith(acme.CHALLENGE_PREFIX) ? lookup(p.slice(acme.CHALLENGE_PREFIX.length)) : null;
    if (ka) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(ka);
    }
    res.writeHead(308, { Location: `https://${req.headers.host}${req.url}` });
    return res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

test('RFC 7638 thumbprint example, JWS, key authorization', () => {
  // RFC 7638 section 3.1
  const rfc = {
    kty: 'RSA', e: 'AQAB',
    n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw'
  };
  assert.equal(acme.thumbprint(rfc), 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  // the same key through jwkOf (only the required members, in order)
  const rsa = crypto.createPublicKey({ key: rfc, format: 'jwk' });
  assert.equal(acme.thumbprint(acme.jwkOf(rsa)), 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');

  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = acme.jwkOf(privateKey);
  assert.deepEqual(Object.keys(jwk), ['crv', 'kty', 'x', 'y']);
  assert.equal(jwk.d, undefined, 'never the private part');
  // RFC 8555 8.1: token "." thumbprint
  const ka = acme.keyAuthorization('evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA', privateKey);
  assert.match(ka, acme.KEY_AUTH_RE);
  assert.equal(ka.split('.')[1], acme.thumbprint(jwk));

  // jwk for new accounts, kid afterwards; ES256 as 64 raw bytes; empty payload for POST-as-GET
  const a = acme.signJws(privateKey, { url: 'https://x/new-account', nonce: 'n1' }, { termsOfServiceAgreed: true });
  const prot = JSON.parse(Buffer.from(a.protected, 'base64url'));
  assert.deepEqual([prot.alg, prot.nonce, prot.url, prot.kid], ['ES256', 'n1', 'https://x/new-account', undefined]);
  assert.deepEqual(prot.jwk, jwk);
  const sig = Buffer.from(a.signature, 'base64url');
  assert.equal(sig.length, 64);
  assert.ok(crypto.verify('sha256', Buffer.from(`${a.protected}.${a.payload}`), { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, sig));
  const g = acme.signJws(privateKey, { url: 'https://x/o', nonce: 'n2', kid: 'https://x/acct/1' }, null);
  assert.equal(g.payload, '');
  const gp = JSON.parse(Buffer.from(g.protected, 'base64url'));
  assert.deepEqual([gp.kid, gp.jwk], ['https://x/acct/1', undefined]);
});

test('the CSR verifies and names every domain', { skip: !hasOpenssl }, async () => {
  const dir = await tmp();
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  fs.writeFileSync(path.join(dir, 'c.der'), acme.createCsr(privateKey, ['demo.example.com', 'www.example.com']));
  const out = spawnSync('openssl', ['req', '-inform', 'DER', '-in', path.join(dir, 'c.der'), '-verify', '-noout', '-text']);
  assert.equal(out.status, 0, out.stderr.toString());
  const text = out.stdout.toString() + out.stderr.toString();
  assert.match(text, /verify OK/i);
  assert.match(text, /CN ?= ?demo\.example\.com/);
  assert.match(text, /DNS:demo\.example\.com, DNS:www\.example\.com/);
});

test('settings from the environment: domains, staging switch, directory', () => {
  assert.equal(acme.acmeConfigFromEnv({}), null);
  const c = acme.acmeConfigFromEnv({ TLS_ACME_DOMAIN: 'Shop.Example.com, www.example.com', TLS_ACME_EMAIL: 'a@b.co' });
  assert.deepEqual(c.domains, ['shop.example.com', 'www.example.com']);
  assert.equal(c.directory, 'https://acme-v02.api.letsencrypt.org/directory');
  assert.equal(c.staging, false);
  const s = acme.acmeConfigFromEnv({ TLS_ACME_DOMAIN: 'shop.example.com', TLS_ACME_STAGING: 'true' });
  assert.equal(s.directory, 'https://acme-staging-v02.api.letsencrypt.org/directory');
  assert.equal(s.staging, true);
  assert.equal(acme.acmeConfigFromEnv({ TLS_ACME_DOMAIN: 'a.example', TLS_ACME_DIRECTORY: 'https://127.0.0.1:1/directory' }).directory, 'https://127.0.0.1:1/directory');
  for (const bad of ['*.example.com', '203.0.113.5', 'localhost', 'a/../b.com', 'x..y.com']) assert.throws(() => acme.parseDomains(bad), /TLS_ACME_DOMAIN/, bad);
  assert.throws(() => acme.acmeConfigFromEnv({ TLS_ACME_DOMAIN: 'a.example', TLS_ACME_DIRECTORY: 'http://insecure/dir' }), /https/);
  assert.throws(() => acme.acmeConfigFromEnv({ TLS_ACME_DOMAIN: 'a.example', TLS_ACME_EMAIL: 'not an email' }), /email/);
});

test('renewal timing and backoff', () => {
  const from = Date.parse('2026-01-01T00:00:00Z');
  // 90 days: 30 days before the end
  assert.equal(acme.renewAt({ validFrom: from, validTo: from + 90 * DAY }), from + 60 * DAY);
  // short-lived (6 days): a third of the lifetime
  assert.equal(acme.renewAt({ validFrom: from, validTo: from + 6 * DAY }), from + 4 * DAY);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(acme.backoffMs), [15 * 60_000, 3600_000, 4 * 3600_000, 12 * 3600_000, DAY, DAY]);
  assert.equal(acme.retryAfterAt('120', 1000), 121_000);
  assert.equal(acme.retryAfterAt('Wed, 21 Oct 2026 07:28:00 GMT'), Date.parse('2026-10-21T07:28:00Z'));
  assert.equal(acme.retryAfterAt(undefined), null);
});

test('issuance: files 0600, hot-swap, no repeat, renewal, failure backoff, staging switch', { skip: !hasOpenssl, timeout: 120000 }, async () => {
  const dir = await tmp();
  let mgr = null;
  const fr = await front((t) => mgr?.challenge(t));
  const fake = await startFakeAcme(path.join(dir, 'fake'), { validate: { httpBase: `http://127.0.0.1:${fr.port}` } });
  const tlsDir = path.join(dir, 'tls');
  let clock = Date.now();
  const opts = {
    dir: tlsDir, log: quiet, hostnames: [],
    acme: { domains: ['demo.example.test'], email: 'owner@example.test', directory: fake.directory, caFile: fake.caFile, port: fr.port, pollMs: 50, readyTimeoutMs: 5000, now: () => clock }
  };
  try {
    const tm = new TlsManager(opts);
    mgr = tm.acme;
    // before the first certificate: the self-signed one, covering the domain too
    const first = await tm.ensure();
    assert.equal(first.acme, undefined);
    assert.ok(new crypto.X509Certificate(first.cert).checkHost('demo.example.test'));
    assert.equal(tm.status().serving, 'self-signed');
    assert.match(tm.status().summary, /not issued yet/);

    const changes = [];
    const published = [];
    tm.startAcme({ publish: (t, k) => published.push([t, k]), unpublish: (t) => published.push([t, null]), onChange: (c) => changes.push(c), delayMs: 0 });
    while (!changes.length) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(changes, [{ certChanged: true }]);
    assert.equal(fake.log.checks.length, 1);
    assert.equal(fake.log.checks[0].plain.text, fake.log.checks[0].want, 'the check got the key authorization');
    assert.deepEqual(fake.log.contacts, [['mailto:owner@example.test']]);
    assert.match(fake.log.csrs[0], /DNS:demo\.example\.test/);
    // published then withdrawn; nothing pending afterwards
    assert.equal(published.length, 2);
    assert.equal(published[1][1], null);
    assert.equal(mgr.pending.size, 0);
    assert.equal(mgr.challenge(published[0][0]), null, 'a finished token is not served any more');

    // files, all 0600
    for (const n of ['acme-account.key', 'acme.key', 'acme.crt', 'acme-state.json']) {
      assert.equal(fs.statSync(path.join(tlsDir, n)).mode & 0o777, 0o600, n);
    }
    // the next load is the Let's Encrypt one (what index.js hands to setSecureContext)
    const issued = await tm.ensure();
    assert.equal(issued.acme, true);
    const leaf = new crypto.X509Certificate(issued.cert);
    assert.ok(leaf.checkIssued(new crypto.X509Certificate(fake.issuerPem)));
    assert.ok(leaf.checkHost('demo.example.test'));
    const st = tm.status();
    assert.equal(st.mode, 'acme');
    assert.equal(st.serving, 'acme');
    assert.match(st.summary, /^Let's Encrypt for demo\.example\.test, renews on \d{4}-\d\d-\d\d/);
    // nothing secret in the status
    assert.doesNotMatch(JSON.stringify(st), /PRIVATE KEY/);

    // hot swap on a live TLS server
    const srv = tls.createServer({ key: first.key, cert: first.cert }, (s) => s.end());
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const peer = () => new Promise((resolve, reject) => {
      const s = tls.connect({ port: srv.address().port, host: '127.0.0.1', servername: 'demo.example.test', rejectUnauthorized: false }, () => {
        resolve(s.getPeerX509Certificate().fingerprint256);
        s.end();
      });
      s.on('error', reject);
    });
    assert.equal(await peer(), new crypto.X509Certificate(first.cert).fingerprint256);
    srv.setSecureContext({ key: issued.key, cert: issued.cert });
    assert.equal(await peer(), leaf.fingerprint256);
    srv.close();

    // a fresh check does not order again while the certificate is good
    const orders = fake.log.ordersCreated;
    assert.equal(mgr.due().issue, false);
    await mgr.tick();
    assert.equal(fake.log.ordersCreated, orders);

    // 25 days before the end (90-day certificate): renewal, same account
    clock = Date.parse(leaf.validTo) - 25 * DAY;
    assert.equal(mgr.due().issue, true);
    assert.equal(await mgr.tick(), true);
    assert.equal(fake.log.ordersCreated, orders + 1);
    assert.equal(fake.log.accountsCreated, 1, 'the account is reused');
    assert.notEqual(new crypto.X509Certificate((await tm.ensure()).cert).fingerprint256, leaf.fingerprint256);
    clock = Date.now();

    // failure: explained, backed off (and remembered across a restart), nothing sent before then
    fake.set({ failChallenge: true });
    assert.equal(await mgr.attempt('test'), false);
    let state = mgr.state();
    assert.equal(state.failures, 1);
    assert.match(state.lastError, /Let's Encrypt couldn't reach http:\/\/demo\.example\.test\/\.well-known\/acme-challenge\/[A-Za-z0-9_-]+: check DNS points here and port 80 is forwarded to \d+/);
    assert.equal(state.nextAttemptAt, clock + 15 * 60_000);
    assert.equal((await tm.ensure()).acme, true, 'the current certificate stays in use');
    const reqs = fake.log.requests;
    const again = new TlsManager(opts); // a restart
    assert.deepEqual(again.acme.due(), { issue: false, at: clock + 15 * 60_000 });
    await again.acme.tick();
    again.acme.stop();
    assert.equal(fake.log.requests, reqs, 'no request to the ACME server before the backoff ends');
    assert.equal(await mgr.attempt('test'), false);
    assert.equal(mgr.state().nextAttemptAt, clock + 3600_000, 'the second failure waits an hour');

    // rate limited: Retry-After wins when it is longer
    fake.set({ failChallenge: false, rateLimit: 3 * 3600 });
    assert.equal(await mgr.attempt('test'), false);
    state = mgr.state();
    assert.match(state.lastError, /rate limit/);
    assert.ok(state.nextAttemptAt >= clock + 3 * 3600_000 - 1000 && state.nextAttemptAt <= clock + 4 * 3600_000);
    fake.set({ rateLimit: null });

    // staging switch: a certificate from another directory does not count, so it is ordered again
    const staged = new TlsManager({ ...opts, acme: { ...opts.acme, directory: `${fake.directory}?staging` } });
    assert.equal(staged.acme.current(), null);
    assert.equal(staged.acme.directory, `${fake.directory}?staging`);
    staged.acme.stop();
    mgr.stop();
  } finally {
    mgr?.stop();
    await fake.close();
    await fr.close();
  }
});

test('a hostile ACME server: huge answers, other hosts, bad tokens, bad chains', { skip: !hasOpenssl, timeout: 60000 }, async () => {
  const dir = await tmp();
  const fake = await startFakeAcme(path.join(dir, 'fake'), { badNonceOnce: false });
  const ca = fs.readFileSync(fake.caFile);
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { privateKey: certKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const client = () => new acme.AcmeClient({ directory: fake.directory, accountKey: privateKey, ca, pollMs: 20 });
  const published = [];
  const issue = () => client().issue({ domains: ['a.example.test'], certKey, publish: (t) => published.push(t), unpublish: () => {} });
  try {
    fake.set({ hostile: 'huge' });
    await assert.rejects(issue(), /too large/);
    fake.set({ hostile: 'elsewhere' });
    await assert.rejects(issue(), /another host/);
    fake.set({ hostile: 'token' });
    await assert.rejects(issue(), /unusable challenge token/);
    assert.deepEqual(published, [], 'a bad token is never served');
    fake.set({ hostile: 'chain' });
    const chain = await issue();
    assert.equal(acme.checkChain(chain, certKey.export({ type: 'pkcs8', format: 'pem' }), ['a.example.test']), null, 'a bad chain is refused before it is written');
    // only https
    await assert.rejects(acme.request('http://127.0.0.1:1/x'), /non-HTTPS/);
  } finally {
    await fake.close();
  }

  // the supervised app only takes well-formed tokens from the supervisor, and serves exact ones
  const channel = new (require('events'))();
  channel.send = () => {};
  const src = supervisorTlsSource({ dir, channel });
  const token = 'a'.repeat(43);
  const ka = `${token}.${'b'.repeat(43)}`;
  channel.emit('message', { type: 'acme-challenge', token: '../../x', keyAuthorization: ka });
  channel.emit('message', { type: 'acme-challenge', token, keyAuthorization: 'x' });
  assert.equal(src.challenge('../../x'), null);
  assert.equal(src.challenge(token), null);
  channel.emit('message', { type: 'acme-challenge', token, keyAuthorization: ka });
  assert.equal(src.challenge(token), ka);
  assert.equal(src.challenge(`${token}/`), null);
  assert.equal(src.challenge(token.slice(1)), null);
  channel.emit('message', { type: 'acme-challenge-done', token });
  assert.equal(src.challenge(token), null);
  assert.equal(localTlsSource(new TlsManager({ dir, log: quiet })).challenge(token), null, 'without Let\'s Encrypt nothing is served');
});

test('the server: challenge on plain HTTP and HTTPS, other paths redirected, port-less redirect, hot swap', { skip: !hasOpenssl, timeout: 120000 }, async () => {
  const dir = await tmp();
  const port = await freePort();
  const fake = await startFakeAcme(path.join(dir, 'fake'), { validate: { httpBase: `http://127.0.0.1:${port}`, httpsBase: `https://127.0.0.1:${port}` } });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'), RUN_DIR: path.join(dir, 'run'),
      TZ: 'UTC', LOG_LEVEL: 'info', SENTRY_SUPERVISED: '', TLS_ACME_DOMAIN: 'demo.example.test', TLS_ACME_DIRECTORY: fake.directory, TLS_ACME_CA_FILE: fake.caFile,
      SENTRY_NOREPLACE_RENAME: path.join(__dirname, '..', 'build', 'noreplace-rename')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const peer = () => new Promise((resolve) => {
    const s = tls.connect({ port, host: '127.0.0.1', servername: 'demo.example.test', rejectUnauthorized: false }, () => {
      resolve(s.getPeerX509Certificate());
      s.end();
    });
    s.on('error', () => resolve(null));
  });
  try {
    // the Let's Encrypt certificate replaces the self-signed one without a restart
    let cert = null;
    for (let i = 0; i < 300; i++) {
      cert = await peer();
      if (cert && cert.checkIssued(new crypto.X509Certificate(fake.issuerPem))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(cert?.checkIssued(new crypto.X509Certificate(fake.issuerPem)), `not swapped in:\n${output}`);
    assert.equal(child.exitCode, null, 'no restart');
    // the check reached the app on plain HTTP and on HTTPS (Cloudflare's "Always Use HTTPS")
    const c = fake.log.checks[0];
    assert.equal(c.plain.status, 200);
    assert.equal(c.plain.text, c.want);
    assert.equal(c.tls.status, 200, JSON.stringify(c.tls));
    assert.equal(c.tls.text, c.want);
    assert.match(output, /Let's Encrypt: certificate for demo\.example\.test issued/);
    assert.doesNotMatch(output, /PRIVATE KEY/);

    // the finished token, unknown tokens and traversal are redirected like everything else
    for (const p of [`/.well-known/acme-challenge/${c.token}`, '/.well-known/acme-challenge/../../data/tls/acme.key', '/.well-known/acme-challenge/', '/settings']) {
      const r = await httpGet(`http://127.0.0.1:${port}${p}`, 'demo.example.test');
      assert.equal(r.status, 308, p);
    }
    // a Host without a port goes to https:// without one
    const r = await httpGet(`http://127.0.0.1:${port}/x?y=1`, 'demo.example.test');
    assert.equal(r.location, 'https://demo.example.test/x?y=1');
    const withPort = await httpGet(`http://127.0.0.1:${port}/x`, `demo.example.test:${port}`);
    assert.equal(withPort.location, `https://demo.example.test:${port}/x`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    await fake.close();
  }
});
