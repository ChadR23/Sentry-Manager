'use strict';

// A small ACME v2 server (RFC 8555) for tests, on Node's https with a
// self-signed certificate: it checks every JWS (signature, nonce, url, kid),
// runs the HTTP-01 check against the app (plain HTTP and HTTPS) and signs the
// CSR with its own CA through openssl. Never Let's Encrypt.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');

const b64u = (b) => Buffer.from(b).toString('base64url');

function thumb(jwk) {
  return b64u(crypto.createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());
}

function get(url, host, insecure) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { Host: host }, rejectUnauthorized: !insecure, timeout: 5000 }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: t, location: res.headers.location }));
    });
    req.on('error', (err) => resolve({ status: 0, text: err.message }));
    req.on('timeout', () => req.destroy());
  });
}

async function startFakeAcme(dir, {
  validate = null, // { httpBase, httpsBase } of the app; null: accept without checking
  days = 90, failChallenge = false, rateLimit = null, badNonceOnce = true, hostile = null
} = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  const ssl = (...a) => execFileSync('openssl', a, { stdio: 'pipe' });
  // the server's own TLS certificate (what the client trusts via TLS_ACME_CA_FILE)
  ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', f('srv.key'), '-out', f('srv.crt'),
    '-days', '2', '-subj', '/CN=fake acme', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost');
  // the CA that signs the "Let's Encrypt" certificates
  ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.crt'),
    '-days', '2', '-subj', '/CN=Fake LE Root', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');

  const nonces = new Set();
  const accounts = new Map(); // kid -> jwk
  const orders = new Map();
  const authzs = new Map();
  const log = { requests: 0, checks: [], csrs: [], accountsCreated: 0, contacts: [], ordersCreated: 0 };
  let nonceTricked = !badNonceOnce;
  let base;

  const newNonce = () => {
    const n = b64u(crypto.randomBytes(16));
    nonces.add(n);
    return n;
  };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Replay-Nonce': newNonce(), 'Content-Type': typeof body === 'string' ? 'application/pem-certificate-chain' : 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const problem = (res, status, type, detail, headers) => send(res, status, { type: `urn:ietf:params:acme:error:${type}`, detail }, headers);

  function verify(req, raw) {
    const jws = JSON.parse(raw);
    const prot = JSON.parse(Buffer.from(jws.protected, 'base64url'));
    if (prot.alg !== 'ES256') throw Object.assign(new Error('alg'), { t: 'badSignatureAlgorithm' });
    if (prot.url !== `${base}${req.url}`) throw Object.assign(new Error(`url ${prot.url}`), { t: 'unauthorized' });
    if (!nonces.delete(prot.nonce)) throw Object.assign(new Error('nonce'), { t: 'badNonce' });
    if (!nonceTricked) {
      nonceTricked = true;
      throw Object.assign(new Error('nonce (test)'), { t: 'badNonce' });
    }
    let jwk;
    if (prot.jwk) {
      if (prot.kid) throw new Error('both kid and jwk');
      jwk = prot.jwk;
    } else {
      jwk = accounts.get(prot.kid);
      if (!jwk) throw Object.assign(new Error('no such account'), { t: 'accountDoesNotExist' });
    }
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const ok = crypto.verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(jws.signature, 'base64url'));
    if (!ok) throw Object.assign(new Error('signature'), { t: 'malformed' });
    return { jwk, kid: prot.kid, payload: jws.payload ? JSON.parse(Buffer.from(jws.payload, 'base64url')) : null };
  }

  async function check(az, jwk) {
    const ch = az.challenges[0];
    const want = `${ch.token}.${thumb(jwk)}`;
    const p = `/.well-known/acme-challenge/${ch.token}`;
    let ok = !failChallenge;
    if (validate && ok) {
      const plain = await get(`${validate.httpBase}${p}`, az.identifier.value, false);
      const tls = validate.httpsBase ? await get(`${validate.httpsBase}${p}`, az.identifier.value, true) : null;
      log.checks.push({ domain: az.identifier.value, token: ch.token, plain, tls, want });
      ok = plain.status === 200 && plain.text === want;
    }
    ch.status = ok ? 'valid' : 'invalid';
    az.status = ch.status;
    if (!ok) ch.error = { type: 'urn:ietf:params:acme:error:connection', detail: `${az.identifier.value}: Fetching http://${az.identifier.value}${p}: Connection refused` };
  }

  const server = https.createServer({ key: fs.readFileSync(f('srv.key')), cert: fs.readFileSync(f('srv.crt')) }, (req, res) => {
    log.requests++;
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      try {
        if (hostile === 'huge' && req.url === '/directory') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(`{"x":"${'a'.repeat(2 * 1024 * 1024)}"}`);
        }
        if (req.url === '/directory') {
          return send(res, 200, {
            newNonce: `${base}/new-nonce`, newAccount: `${base}/new-account`,
            newOrder: hostile === 'elsewhere' ? 'https://evil.example/new-order' : `${base}/new-order`,
            meta: { termsOfService: `${base}/terms` }
          });
        }
        if (req.url === '/new-nonce') {
          res.writeHead(200, { 'Replay-Nonce': newNonce(), 'Cache-Control': 'no-store' });
          return res.end();
        }
        let v;
        try {
          v = verify(req, raw);
        } catch (err) {
          return problem(res, 400, err.t || 'malformed', err.message);
        }
        if (req.url === '/new-account') {
          if (!v.payload?.termsOfServiceAgreed) return problem(res, 400, 'userActionRequired', 'terms');
          const existing = [...accounts].find(([, j]) => thumb(j) === thumb(v.jwk));
          if (existing) return send(res, 200, { status: 'valid' }, { Location: existing[0] });
          const kid = `${base}/acct/${accounts.size + 1}`;
          accounts.set(kid, v.jwk);
          log.accountsCreated++;
          log.contacts.push(v.payload.contact || null);
          return send(res, 201, { status: 'valid' }, { Location: kid });
        }
        if (req.url === '/new-order') {
          if (rateLimit) return problem(res, 429, 'rateLimited', 'too many certificates already issued', { 'Retry-After': String(rateLimit) });
          const id = String(orders.size + 1);
          const order = { status: 'pending', identifiers: v.payload.identifiers, authorizations: [], finalize: `${base}/finalize/${id}` };
          for (const ident of v.payload.identifiers) {
            const aid = `${id}-${ident.value}`;
            const token = hostile === 'token' ? '../../../../etc/passwd' : b64u(crypto.randomBytes(32));
            authzs.set(aid, { status: 'pending', identifier: ident, challenges: [{ type: 'http-01', url: `${base}/chall/${aid}`, token, status: 'pending' }] });
            order.authorizations.push(`${base}/authz/${aid}`);
          }
          orders.set(id, order);
          log.ordersCreated++;
          return send(res, 201, order, { Location: `${base}/order/${id}` });
        }
        let m;
        if ((m = req.url.match(/^\/authz\/(.+)$/))) return send(res, 200, authzs.get(m[1]));
        if ((m = req.url.match(/^\/chall\/(.+)$/))) {
          const az = authzs.get(m[1]);
          az.challenges[0].status = 'processing';
          send(res, 200, az.challenges[0]);
          setTimeout(() => check(az, v.jwk), 50);
          return undefined;
        }
        if ((m = req.url.match(/^\/order\/(\d+)$/))) {
          const o = orders.get(m[1]);
          if (o.status === 'pending' && o.authorizations.every((u) => authzs.get(u.split('/authz/')[1]).status === 'valid')) o.status = 'ready';
          if (o.status === 'pending' && o.authorizations.some((u) => authzs.get(u.split('/authz/')[1]).status === 'invalid')) o.status = 'invalid';
          return send(res, 200, o);
        }
        if ((m = req.url.match(/^\/finalize\/(\d+)$/))) {
          const o = orders.get(m[1]);
          if (o.status !== 'ready') return problem(res, 403, 'orderNotReady', o.status);
          const csr = Buffer.from(v.payload.csr, 'base64url');
          fs.writeFileSync(f(`o${m[1]}.csr`), csr);
          log.csrs.push(execFileSync('openssl', ['req', '-inform', 'DER', '-in', f(`o${m[1]}.csr`), '-verify', '-noout', '-text'], { stdio: 'pipe' }).toString());
          ssl('x509', '-req', '-inform', 'DER', '-in', f(`o${m[1]}.csr`), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-set_serial', `0x${crypto.randomBytes(8).toString('hex')}`,
            '-days', String(days), '-copy_extensions', 'copyall', '-out', f(`o${m[1]}.crt`));
          o.status = 'valid';
          o.certificate = `${base}/cert/${m[1]}`;
          return send(res, 200, o, { Location: `${base}/order/${m[1]}` });
        }
        if ((m = req.url.match(/^\/cert\/(\d+)$/))) {
          if (hostile === 'chain') return send(res, 200, '-----BEGIN CERTIFICATE-----\nnot a cert\n-----END CERTIFICATE-----\n');
          return send(res, 200, fs.readFileSync(f(`o${m[1]}.crt`), 'utf8') + fs.readFileSync(f('ca.crt'), 'utf8'));
        }
        return problem(res, 404, 'malformed', 'no such resource');
      } catch (err) {
        return problem(res, 500, 'serverInternal', err.message);
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `https://127.0.0.1:${server.address().port}`;
  return {
    directory: `${base}/directory`, caFile: f('srv.crt'), issuerPem: fs.readFileSync(f('ca.crt'), 'utf8'), log,
    set: (o) => { if ('failChallenge' in o) failChallenge = o.failChallenge; if ('rateLimit' in o) rateLimit = o.rateLimit; if ('hostile' in o) hostile = o.hostile; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
  };
}

module.exports = { startFakeAcme, httpGet: get };
