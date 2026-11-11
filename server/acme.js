'use strict';

// Let's Encrypt certificates (ACME v2, RFC 8555), with Node's own crypto and
// https and nothing else.
//
//   TLS_ACME_DOMAIN=demo.example.com[,www.example.com]
//   TLS_ACME_EMAIL=you@example.com        optional, for Let's Encrypt's notices
//   TLS_ACME_STAGING=true                 Let's Encrypt's staging server (test certificates)
//
// The HTTP-01 check comes as plain HTTP to port 80, which the owner maps to
// 9000 (-p 80:9000 -p 443:9000). The plain-HTTP side of port 9000 answers
// /.well-known/acme-challenge/<token> for the exact tokens of a pending order
// and redirects everything else to HTTPS, as before.
//
// Files, all 0600 in the TLS directory (root's /data/tls in the Docker image):
//   acme-account.key   the account key (ES256), made once
//   acme.key/.crt      the certificate's key and the chain from Let's Encrypt
//   acme-state.json    account URL, failures and when to try again
// Their names are fixed: nothing an ACME server sends ever becomes a path.
//
// Until the first certificate is issued, and whenever the one on disk does not
// fit, the self-signed certificate is served (the page works, with a warning).
// The certificate is renewed when less than 30 days are left (checked daily);
// failures back off from 15 minutes to a day, remembered across restarts, so
// a restart loop never hammers Let's Encrypt's rate limits.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');

const LE_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';
const LE_STAGING_DIRECTORY = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const CHALLENGE_PREFIX = '/.well-known/acme-challenge/';
// RFC 8555 8.3: base64url, at least 128 bits of entropy (Let's Encrypt: 43 characters)
const TOKEN_RE = /^[A-Za-z0-9_-]{22,128}$/;
const KEY_AUTH_RE = /^[A-Za-z0-9_-]{22,128}\.[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE = 256 * 1024; // a chain is a few KB; directory, orders and problems far less
const MAX_DOMAINS = 10;
const REQUEST_TIMEOUT_MS = 30_000;
const DAY = 24 * 3600 * 1000;
const RENEW_BEFORE_MS = 30 * DAY;
const BACKOFF_MS = [15 * 60_000, 3600_000, 4 * 3600_000, 12 * 3600_000, DAY];
const FILES = { accountKey: 'acme-account.key', key: 'acme.key', crt: 'acme.crt', state: 'acme-state.json' };
const DNS_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
/** Untrusted text from an ACME server, made safe for a log line or the UI. */
const clean = (s, max = 300) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

/** The domains of TLS_ACME_DOMAIN: public DNS names only (HTTP-01 cannot do IPs or wildcards). */
function parseDomains(value) {
  const out = [];
  for (const raw of String(value || '').split(/[\s,]+/)) {
    const d = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!d) continue;
    if (!DNS_RE.test(d) || net.isIP(d)) throw new Error(`TLS_ACME_DOMAIN: "${clean(raw, 80)}" is not a public DNS name (no IP addresses or wildcards).`);
    if (!out.includes(d)) out.push(d);
  }
  if (out.length > MAX_DOMAINS) throw new Error(`TLS_ACME_DOMAIN: at most ${MAX_DOMAINS} names.`);
  return out;
}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

/** Which directory: TLS_ACME_DIRECTORY (tests, other CAs), else Let's Encrypt or its staging server. */
function directoryUrl({ staging = false, directory = null } = {}) {
  return directory || (staging ? LE_STAGING_DIRECTORY : LE_DIRECTORY);
}

/** ACME settings from the environment, or null when TLS_ACME_DOMAIN is not set. */
function acmeConfigFromEnv(env = process.env) {
  const domains = parseDomains(env.TLS_ACME_DOMAIN);
  if (!domains.length) return null;
  const email = String(env.TLS_ACME_EMAIL || '').trim();
  if (email && !/^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[^\s@<>"',;:]+$/.test(email)) throw new Error('TLS_ACME_EMAIL is not an email address.');
  const staging = truthy(env.TLS_ACME_STAGING);
  const directory = env.TLS_ACME_DIRECTORY || null;
  if (directory && new URL(directory).protocol !== 'https:') throw new Error('TLS_ACME_DIRECTORY must be an https:// URL.');
  return {
    domains, email: email || null, staging, directory: directoryUrl({ staging, directory }),
    caFile: env.TLS_ACME_CA_FILE || null, port: Number(env.PORT || 9000)
  };
}

// ---- JWK, thumbprint, JWS

/** The public JWK of a key, with only the members RFC 7638 hashes. */
function jwkOf(key) {
  const j = (key?.type === 'public' ? key : crypto.createPublicKey(key)).export({ format: 'jwk' });
  if (j.kty === 'EC') return { crv: j.crv, kty: 'EC', x: j.x, y: j.y };
  if (j.kty === 'RSA') return { e: j.e, kty: 'RSA', n: j.n };
  if (j.kty === 'OKP') return { crv: j.crv, kty: 'OKP', x: j.x };
  throw new Error(`unsupported key type ${j.kty}`);
}

/** RFC 7638 thumbprint: SHA-256 of the required members in lexicographic order, no spaces. */
function thumbprint(jwk) {
  const required = { EC: ['crv', 'kty', 'x', 'y'], RSA: ['e', 'kty', 'n'], OKP: ['crv', 'kty', 'x'] }[jwk.kty];
  if (!required) throw new Error(`unsupported key type ${jwk.kty}`);
  const json = `{${required.map((k) => `${JSON.stringify(k)}:${JSON.stringify(String(jwk[k]))}`).join(',')}}`;
  return b64u(crypto.createHash('sha256').update(json).digest());
}

/** RFC 8555 8.1: token.thumbprint */
function keyAuthorization(token, accountKey) {
  return `${token}.${thumbprint(jwkOf(accountKey))}`;
}

/** A flattened JWS (RFC 8555 6.2), ES256; payload null means POST-as-GET (empty payload). */
function signJws(privateKey, { url, nonce, kid = null }, payload) {
  const protectedHeader = { alg: 'ES256', nonce, url, ...(kid ? { kid } : { jwk: jwkOf(privateKey) }) };
  const p = b64u(JSON.stringify(protectedHeader));
  const body = payload === null ? '' : b64u(JSON.stringify(payload));
  const signature = crypto.sign('sha256', Buffer.from(`${p}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return { protected: p, payload: body, signature: b64u(signature) };
}

// ---- a CSR in DER, built here (PKCS #10, RFC 2986)

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  for (let x = n; x > 0; x >>= 8) b.unshift(x & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
};
const seq = (...p) => tlv(0x30, ...p);
function oid(s) {
  const p = s.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const b = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) b.unshift(0x80 | (x & 0x7f));
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}

/** CSR for these DNS names (subjectAltName; the first one as CN when it fits), signed with the certificate key. */
function createCsr(privateKey, domains) {
  const cn = domains[0].length <= 64 ? seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(domains[0]))))) : seq();
  const san = seq(...domains.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))));
  const extensions = seq(seq(oid('2.5.29.17'), tlv(0x04, san)));
  const attributes = tlv(0xa0, seq(oid('1.2.840.113549.1.9.14'), tlv(0x31, extensions)));
  const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const info = seq(tlv(0x02, Buffer.from([0])), cn, spki, attributes);
  const sig = crypto.sign('sha256', info, privateKey);
  return seq(info, seq(oid('1.2.840.10045.4.3.2')), tlv(0x03, Buffer.from([0]), sig));
}

// ---- HTTPS requests to the ACME server

class AcmeError extends Error {
  constructor(message, { type = null, status = null, detail = null, retryAfter = null, subproblems = null } = {}) {
    super(message);
    Object.assign(this, { type, status, detail, retryAfter, subproblems });
  }
}

/** Retry-After as a time (seconds or an HTTP date), or null. */
function retryAfterAt(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  const s = Number(value);
  if (Number.isFinite(s) && s >= 0) return now + s * 1000;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * One request; the answer is cut off at MAX_RESPONSE. Only https://, and only
 * to the directory's own origin (a hostile answer cannot send our signed
 * requests anywhere else). Node's global agent is used, so the standard
 * proxy settings (NODE_USE_ENV_PROXY with HTTPS_PROXY/NO_PROXY) apply.
 */
function request(url, { method = 'GET', body = null, ca = null, origin = null, accept = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new AcmeError(`The ACME server sent an invalid URL: ${clean(url, 200)}`));
    }
    if (u.protocol !== 'https:') return reject(new AcmeError(`The ACME server sent a non-HTTPS URL: ${clean(url, 200)}`));
    if (origin && u.origin !== origin) return reject(new AcmeError(`The ACME server sent a URL on another host: ${clean(url, 200)}`));
    const data = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = https.request(u, {
      method, ...(ca ? { ca } : {}), timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent': 'sentry-six-manager-acme', Accept: accept,
        ...(data ? { 'Content-Type': 'application/jose+json', 'Content-Length': data.length } : {})
      }
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE) {
          req.destroy(new AcmeError('The ACME server sent too large a response.'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new AcmeError(`No answer from ${u.host} within ${REQUEST_TIMEOUT_MS / 1000} s.`)));
    req.on('error', reject);
    req.end(data);
  });
}

function parseJson(res) {
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return null;
  }
}

class AcmeClient {
  constructor({ directory, accountKey, ca = null, email = null, kid = null, pollMs = 2000, maxPollMs = 180_000, port = 9000, log = null }) {
    this.directoryUrl = directory;
    this.port = port;
    this.origin = new URL(directory).origin;
    this.accountKey = accountKey;
    this.ca = ca;
    this.email = email;
    this.kid = kid;
    this.pollMs = pollMs;
    this.maxPollMs = maxPollMs;
    this.log = log;
    this.dir = null;
    this.nonce = null;
  }

  async directory() {
    if (this.dir) return this.dir;
    const res = await request(this.directoryUrl, { ca: this.ca, origin: this.origin });
    const d = parseJson(res);
    if (res.status !== 200 || !d || typeof d.newNonce !== 'string' || typeof d.newAccount !== 'string' || typeof d.newOrder !== 'string') {
      throw new AcmeError(`${this.directoryUrl} is not an ACME directory (HTTP ${res.status}).`);
    }
    this.dir = d;
    return d;
  }

  async freshNonce() {
    if (this.nonce) {
      const n = this.nonce;
      this.nonce = null;
      return n;
    }
    const res = await request((await this.directory()).newNonce, { method: 'HEAD', ca: this.ca, origin: this.origin });
    const n = res.headers['replay-nonce'];
    if (!n || !/^[A-Za-z0-9_-]{1,256}$/.test(n)) throw new AcmeError('The ACME server sent no usable nonce.');
    return n;
  }

  /** A signed POST; retries a bad nonce twice (RFC 8555 6.5). */
  async post(url, payload, { jwk = false, accept } = {}) {
    for (let attempt = 0; ; attempt++) {
      const jws = signJws(this.accountKey, { url, nonce: await this.freshNonce(), kid: jwk ? null : this.kid }, payload);
      const res = await request(url, { method: 'POST', body: jws, ca: this.ca, origin: this.origin, accept });
      const n = res.headers['replay-nonce'];
      if (n && /^[A-Za-z0-9_-]{1,256}$/.test(n)) this.nonce = n;
      if (res.status < 400) return res;
      const problem = parseJson(res) || {};
      const type = typeof problem.type === 'string' ? problem.type : null;
      if (type === 'urn:ietf:params:acme:error:badNonce' && attempt < 2) continue;
      throw new AcmeError(clean(problem.detail) || `HTTP ${res.status} from the ACME server`, {
        type, status: res.status, detail: clean(problem.detail), retryAfter: retryAfterAt(res.headers['retry-after']),
        subproblems: Array.isArray(problem.subproblems) ? problem.subproblems.slice(0, 10) : null
      });
    }
  }

  async postJson(url, payload, opts) {
    const res = await this.post(url, payload, opts);
    const body = parseJson(res);
    if (!body || typeof body !== 'object') throw new AcmeError(`The ACME server's answer from ${clean(url, 200)} is not JSON.`);
    return { res, body };
  }

  /** New account, or the existing one for this key; agrees to the terms of service. */
  async account() {
    if (this.kid) return this.kid;
    const d = await this.directory();
    const { res } = await this.postJson(d.newAccount, {
      termsOfServiceAgreed: true, ...(this.email ? { contact: [`mailto:${this.email}`] } : {})
    }, { jwk: true });
    const kid = res.headers.location;
    if (!kid) throw new AcmeError('The ACME server sent no account URL.');
    if (!URL.canParse(kid)) throw new AcmeError('The ACME server sent an invalid account URL.');
    this.kid = kid;
    return kid;
  }

  /** Wait for an order or authorization to leave pending/processing. */
  async poll(url, done) {
    const deadline = Date.now() + this.maxPollMs;
    for (;;) {
      const { res, body } = await this.postJson(url, null);
      if (done(body)) return body;
      if (!['pending', 'processing', 'ready'].includes(body.status)) return body;
      if (Date.now() > deadline) throw new AcmeError(`Still ${clean(body.status, 20)} after ${Math.round(this.maxPollMs / 1000)} s.`);
      const after = retryAfterAt(res.headers['retry-after']);
      const wait = Math.min(30_000, Math.max(this.pollMs, after ? after - Date.now() : 0));
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  /**
   * The whole order: account, order, HTTP-01 for every name, finalize, chain.
   * publish(token, keyAuthorization) / unpublish(token) make the plain-HTTP
   * side answer the check; ready(domain, token, keyAuth) may check that it does.
   */
  async issue({ domains, certKey, publish, unpublish, ready = null }) {
    await this.account();
    const d = await this.directory();
    const { res: orderRes, body: created } = await this.postJson(d.newOrder, { identifiers: domains.map((value) => ({ type: 'dns', value })) });
    const orderUrl = orderRes.headers.location;
    if (!orderUrl) throw new AcmeError('The ACME server sent no order URL.');
    let order = created;
    const authzs = Array.isArray(order.authorizations) ? order.authorizations.slice(0, MAX_DOMAINS * 2) : [];
    if (!authzs.length || typeof order.finalize !== 'string') throw new AcmeError('The ACME server sent an order without authorizations.');
    const published = [];
    try {
      for (const authzUrl of authzs) {
        const { body: authz } = await this.postJson(String(authzUrl), null);
        if (authz.status === 'valid') continue;
        const domain = clean(authz.identifier?.value, 253).toLowerCase();
        if (!domains.includes(domain)) throw new AcmeError(`The ACME server asked about a name that was not ordered: ${domain}`);
        const ch = (Array.isArray(authz.challenges) ? authz.challenges : []).find((c) => c && c.type === 'http-01');
        if (!ch || typeof ch.url !== 'string') throw new AcmeError(`The ACME server offered no HTTP-01 check for ${domain}.`);
        if (typeof ch.token !== 'string' || !TOKEN_RE.test(ch.token)) throw new AcmeError('The ACME server sent an unusable challenge token.');
        const keyAuth = `${ch.token}.${thumbprint(jwkOf(this.accountKey))}`;
        publish(ch.token, keyAuth);
        published.push(ch.token);
        if (ready) await ready(domain, ch.token, keyAuth);
        this.log?.info(`Let's Encrypt: asking it to check http://${domain}${CHALLENGE_PREFIX}${ch.token}`);
        await this.postJson(ch.url, {});
        const result = await this.poll(String(authzUrl), (a) => a.status === 'valid' || a.status === 'invalid');
        if (result.status !== 'valid') throw challengeFailure(domain, ch.token, result, this.port);
      }
      order = await this.poll(orderUrl, (o) => o.status !== 'pending');
      if (order.status !== 'ready' && order.status !== 'valid') throw new AcmeError(`The order is ${clean(order.status, 20)}: ${clean(order.error?.detail) || 'no reason given'}`);
    } finally {
      for (const t of published) unpublish(t);
    }
    if (order.status === 'ready') {
      await this.postJson(order.finalize, { csr: b64u(createCsr(certKey, domains)) });
      order = await this.poll(orderUrl, (o) => o.status === 'valid' || o.status === 'invalid');
    }
    if (order.status !== 'valid' || typeof order.certificate !== 'string') throw new AcmeError(`The order ended ${clean(order.status, 20)}: ${clean(order.error?.detail) || 'no certificate'}`);
    const certRes = await this.post(order.certificate, null, { accept: 'application/pem-certificate-chain' });
    return certRes.body.toString('utf8');
  }
}

/** A failed check, explained for the owner. */
function challengeFailure(domain, token, authz, port = 9000) {
  const ch = (authz.challenges || []).find((c) => c?.type === 'http-01') || {};
  const err = ch.error || authz.error || {};
  const type = String(err.type || '').replace('urn:ietf:params:acme:error:', '');
  const said = clean(err.detail) || clean(type) || 'no reason given';
  const url = `http://${domain}${CHALLENGE_PREFIX}${token}`;
  let msg;
  if (type === 'dns') msg = `Let's Encrypt couldn't look up ${domain}: add a DNS A/AAAA record that points to this server's public IP`;
  else if (type === 'caa') msg = `A CAA record on ${domain} does not allow Let's Encrypt`;
  else msg = `Let's Encrypt couldn't reach ${url}: check DNS points here and port 80 is forwarded to ${port}`;
  return new AcmeError(`${msg} (Let's Encrypt said: ${said})`, { type: err.type || null, detail: said });
}

// ---- files in the TLS directory

/** Write a file atomically, 0600, never through an existing link. */
async function writeSecret(dir, name, data) {
  const file = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  await fsp.rm(tmp, { force: true });
  const fh = await fsp.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(data);
    await fh.chmod(0o600);
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

function readSmall(file, max = 256 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) throw new Error(`${file} is not a small regular file`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const PEM_CHAIN_RE = /^\s*(?:-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*)+$/;

/** Is this chain the certificate for this key and these names, still valid? Returns the leaf's details or null. */
function checkChain(chainPem, keyPem, domains, now = Date.now()) {
  try {
    if (!PEM_CHAIN_RE.test(chainPem)) return null;
    const leaf = new crypto.X509Certificate(chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0]);
    const pub = crypto.createPublicKey(keyPem).export({ type: 'spki', format: 'der' });
    if (!leaf.publicKey.export({ type: 'spki', format: 'der' }).equals(pub)) return null;
    for (const d of domains) if (!leaf.checkHost(d, { wildcards: false })) return null;
    const validFrom = Date.parse(leaf.validFrom);
    const validTo = Date.parse(leaf.validTo);
    if (!(validTo > now)) return null;
    return { validFrom, validTo, fingerprint: leaf.fingerprint256, issuer: leaf.issuer };
  } catch {
    return null;
  }
}

/** When to renew: 30 days before the end, or a third of the lifetime for short-lived certificates. */
function renewAt({ validFrom, validTo }) {
  const lifetime = Math.max(0, validTo - validFrom);
  return validTo - Math.min(RENEW_BEFORE_MS, lifetime / 3);
}

function backoffMs(failures) {
  return BACKOFF_MS[Math.min(BACKOFF_MS.length, Math.max(1, failures)) - 1];
}

/**
 * Keeps a Let's Encrypt certificate in `dir`: issues it, renews it, and says
 * when it changed. Runs where the TLS material lives (the root supervisor in
 * the Docker image); publish/unpublish hand the pending tokens to whoever
 * serves port 9000's plain HTTP.
 */
class AcmeManager {
  constructor({ dir, domains, email = null, staging = false, directory = null, caFile = null, port = 9000, host = null, log = null, now = Date.now, pollMs, maxPollMs, readyTimeoutMs = 120_000 }) {
    this.dir = dir;
    this.domains = domains;
    this.email = email;
    this.staging = staging;
    this.directory = directoryUrl({ staging, directory });
    this.caFile = caFile;
    this.port = port;
    this.host = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    this.log = log;
    this.now = now;
    this.pollMs = pollMs;
    this.maxPollMs = maxPollMs;
    this.readyTimeoutMs = readyTimeoutMs;
    this.pending = new Map(); // token -> key authorization, only while an order waits for its check
    this.timer = null;
    this.running = null;
    this.stopped = false;
    this.hooks = {};
    this.files = Object.fromEntries(Object.entries(FILES).map(([k, n]) => [k, path.join(dir, n)]));
  }

  state() {
    try {
      const s = JSON.parse(readSmall(this.files.state, 64 * 1024).toString('utf8'));
      return s && typeof s === 'object' ? s : {};
    } catch {
      return {};
    }
  }

  async saveState(patch) {
    const next = { ...this.state(), ...patch };
    await writeSecret(this.dir, FILES.state, JSON.stringify(next, null, 2));
    return next;
  }

  /** The certificate on disk, if it fits these names and this server and has not expired. */
  current() {
    try {
      const s = this.state();
      if (s.certDirectory !== this.directory) return null;
      const key = readSmall(this.files.key);
      const cert = readSmall(this.files.crt);
      const info = checkChain(cert.toString('utf8'), key, this.domains, this.now());
      return info ? { key, cert, info } : null;
    } catch {
      return null;
    }
  }

  /** The key authorization for an exact pending token, else null. */
  challenge(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    return this.pending.get(token) ?? null;
  }

  status() {
    const s = this.state();
    const cur = this.current();
    return {
      domains: this.domains, staging: this.staging, directory: this.directory, email: Boolean(this.email),
      issued: Boolean(cur), validTo: cur ? new Date(cur.info.validTo).toISOString() : null,
      renewsAt: cur ? new Date(renewAt(cur.info)).toISOString() : null,
      lastError: s.lastError || null, failures: s.failures || 0,
      nextAttemptAt: s.nextAttemptAt ? new Date(s.nextAttemptAt).toISOString() : null,
      lastIssuedAt: s.issuedAt ? new Date(s.issuedAt).toISOString() : null,
      working: Boolean(this.running)
    };
  }

  /** Start checking: now (or when the backoff says), then daily. */
  start({ publish = () => {}, unpublish = () => {}, onChange = () => {}, delayMs = 0 } = {}) {
    this.hooks = { publish, unpublish, onChange };
    this.stopped = false;
    this.schedule(this.now() + delayMs);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(at) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    // a timer holds at most a day (setTimeout overflows at 24.8 days); it re-checks then
    const wait = Math.max(0, Math.min(DAY, at - this.now()));
    this.timer = setTimeout(() => this.tick().catch((err) => this.log?.warn(`Let's Encrypt check failed: ${err.message}`)), wait);
    this.timer.unref?.();
  }

  /** What is due now: nothing, a renewal, or a retry after the backoff. */
  due() {
    const now = this.now();
    const s = this.state();
    if (s.nextAttemptAt && now < s.nextAttemptAt) return { issue: false, at: s.nextAttemptAt };
    const cur = this.current();
    if (!cur) return { issue: true, why: 'no certificate yet' };
    const at = renewAt(cur.info);
    if (now >= at) return { issue: true, why: `it expires ${new Date(cur.info.validTo).toISOString()}` };
    return { issue: false, at: Math.min(at, now + DAY) };
  }

  async tick() {
    if (this.running) return this.running;
    const d = this.due();
    if (!d.issue) {
      this.schedule(d.at);
      return null;
    }
    this.running = this.attempt(d.why).finally(() => { this.running = null; });
    return this.running;
  }

  async accountKey() {
    try {
      return crypto.createPrivateKey(readSmall(this.files.accountKey));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log?.warn('The Let\'s Encrypt account key could not be read; making a new account.');
    }
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await writeSecret(this.dir, FILES.accountKey, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    return privateKey;
  }

  /** Wait until this server answers plain HTTP on its port, then that it serves this token. */
  async ready(domain, token, keyAuth) {
    const get = (p) => new Promise((resolve) => {
      const req = http.get({ host: this.host, port: this.port, path: p, headers: { Host: domain }, timeout: 5000 }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (text.length < 1024) text += c; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
    });
    const until = Date.now() + this.readyTimeoutMs;
    for (;;) {
      const r = await get(`${CHALLENGE_PREFIX}${token}`);
      if (r?.status === 200 && r.text === keyAuth) return;
      if (Date.now() > until) {
        throw new AcmeError(`This server does not answer http://${domain}${CHALLENGE_PREFIX}… on its own port ${this.port} (${r ? `HTTP ${r.status}` : 'no answer'}), so Let's Encrypt was not asked to check yet.`);
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
  }

  async attempt(why) {
    const label = this.domains.join(', ');
    this.log?.info(`Let's Encrypt${this.staging ? ' (staging)' : ''}: requesting a certificate for ${label} (${why}).`);
    const s = this.state();
    try {
      await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const accountKey = await this.accountKey();
      const ca = this.caFile ? readSmall(this.caFile) : null;
      const kid = s.accounts?.[this.directory] || null;
      const client = new AcmeClient({ directory: this.directory, accountKey, ca, email: this.email, kid, pollMs: this.pollMs, maxPollMs: this.maxPollMs, port: this.port, log: this.log });
      const { privateKey: certKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const keyPem = certKey.export({ type: 'pkcs8', format: 'pem' });
      let chain;
      try {
        chain = await client.issue({
          domains: this.domains, certKey,
          publish: (t, ka) => {
            if (this.pending.size >= 50 || !TOKEN_RE.test(t) || !KEY_AUTH_RE.test(ka)) return;
            this.pending.set(t, ka);
            this.hooks.publish?.(t, ka);
          },
          unpublish: (t) => {
            this.pending.delete(t);
            this.hooks.unpublish?.(t);
          },
          ready: (domain, t, ka) => this.ready(domain, t, ka)
        });
      } finally {
        if (client.kid && client.kid !== kid) await this.saveState({ accounts: { ...(this.state().accounts || {}), [this.directory]: client.kid } });
      }
      const info = checkChain(chain, keyPem, this.domains, this.now());
      if (!info) throw new AcmeError('The certificate Let\'s Encrypt sent does not match the key or the names.');
      // the key first: a certificate never sits next to a key it does not belong to for long, and current() checks they match
      await writeSecret(this.dir, FILES.key, keyPem);
      await writeSecret(this.dir, FILES.crt, chain);
      await this.saveState({ certDirectory: this.directory, domains: this.domains, issuedAt: this.now(), failures: 0, lastError: null, nextAttemptAt: 0 });
      this.log?.info(`Let's Encrypt: certificate for ${label} issued, valid until ${new Date(info.validTo).toISOString()}; renews from ${new Date(renewAt(info)).toISOString()}.`);
      this.hooks.onChange?.({ certChanged: true });
      this.schedule(Math.min(renewAt(info), this.now() + DAY));
      return true;
    } catch (err) {
      const failures = (this.state().failures || 0) + 1;
      let next = this.now() + backoffMs(failures);
      if (err.retryAfter) next = Math.max(next, Math.min(err.retryAfter, this.now() + 7 * DAY));
      let message = clean(err.message, 600);
      if (err.type === 'urn:ietf:params:acme:error:rateLimited') message = `Let's Encrypt's rate limit was reached (${clean(err.detail)}).`;
      else if (!(err instanceof AcmeError) && (err.syscall || /CERT|TLS|SELF_SIGNED|UNABLE|ECONN|ETIMEDOUT|ENOTFOUND|EAI_/.test(String(err.code || '')))) message = `Couldn't reach Let's Encrypt at ${this.directory}: ${message}`;
      await this.saveState({ failures, lastError: message, lastAttemptAt: this.now(), nextAttemptAt: next }).catch(() => {});
      this.log?.warn(`Let's Encrypt: no certificate for ${label} yet (attempt ${failures}). ${message} Serving ${this.current() ? 'the current Let\'s Encrypt' : 'the self-signed'} certificate meanwhile; trying again at ${new Date(next).toISOString()}.`);
      this.hooks.onChange?.({ certChanged: false });
      this.schedule(next);
      return false;
    }
  }
}

module.exports = {
  LE_DIRECTORY, LE_STAGING_DIRECTORY, CHALLENGE_PREFIX, TOKEN_RE, KEY_AUTH_RE, MAX_RESPONSE, BACKOFF_MS,
  parseDomains, directoryUrl, acmeConfigFromEnv, jwkOf, thumbprint, keyAuthorization, signJws, createCsr,
  request, AcmeClient, AcmeError, AcmeManager, checkChain, renewAt, backoffMs, challengeFailure, retryAfterAt
};
