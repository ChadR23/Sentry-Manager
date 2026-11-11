'use strict';

// The public demo's owner page: GET /owner and /api/owner/* (docs/security.md,
// "The demo's owner page"). It shows the attack log (server/attackLog.js),
// visitor counts, the demo reset and the certificate.
//
// It exists only when DEMO_OWNER_PASSWORD is set (else /owner is any unknown
// path), and opens only:
// - from a private, LAN or loopback address (the real client address,
//   server/clientAddress.js). A request through Cloudflare is public, and so
//   is the container's default gateway: Docker's userland proxy makes every
//   visitor from outside look like it (172.17.0.1, or the gateway of the
//   container's own network). Anything else is redirected to / with an
//   ordinary 302 and noted as 'owner-probe';
// - over HTTPS (plain HTTP gets the normal redirect);
// - with the password, compared in constant time and throttled, which gives a
//   session cookie for /owner and /api/owner only (HttpOnly, Secure,
//   SameSite=Strict).

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { sendJson, readJson, serveFile, HttpError } = require('./http');
const { normalizeIp, viaCloudflare } = require('./clientAddress');

const COOKIE = 'sm_owner';
const SESSION_MS = 8 * 3600_000;
const OWNER_LOCAL = (() => {
  const bl = new net.BlockList();
  for (const [a, n] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8]]) bl.addSubnet(a, n, 'ipv4');
  for (const [a, n] of [['::1', 128], ['fc00::', 7], ['fe80::', 10]]) bl.addSubnet(a, n, 'ipv6');
  return bl;
})();

/** A private, LAN or loopback address (the owner page's ranges). */
function isOwnerLocal(ip) {
  const a = normalizeIp(ip);
  return Boolean(a) && OWNER_LOCAL.check(a, net.isIPv6(a) ? 'ipv6' : 'ipv4');
}

/** The default gateways in /proc/net/route and /proc/net/ipv6_route texts. */
function parseGateways(route4 = '', route6 = '') {
  const out = [];
  for (const line of String(route4).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || f[1] !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(f[2]) || f[2] === '00000000') continue;
    const b = f[2].match(/../g).map((h) => parseInt(h, 16)).reverse();
    out.push(b.join('.'));
  }
  for (const line of String(route6).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || !/^0{32}$/.test(f[0]) || f[1] !== '00' || !/^[0-9a-f]{32}$/i.test(f[4]) || /^0{32}$/.test(f[4])) continue;
    const ip = normalizeIp(f[4].match(/.{4}/g).join(':'));
    if (ip) out.push(ip);
  }
  return [...new Set(out)];
}

/** This container's default gateways (none when /proc is not there). */
function readGateways() {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  return parseGateways(read('/proc/net/route'), read('/proc/net/ipv6_route'));
}

/**
 * @param {object} o
 * @param {string} o.password DEMO_OWNER_PASSWORD ('' or unset: no owner page)
 * @param {any} o.attackLog
 * @param {(req: any) => string} o.clientKey the real client address
 * @param {object} o.proxy the options clientAddress takes (Cloudflare included)
 * @param {((ip: string) => boolean) | null} o.listedProxies TRUSTED_PROXIES when set
 * @param {string[]} o.gateways
 */
function createOwnerPage({
  password = '', attackLog = null, clientKey, proxy = {}, listedProxies = null, gateways = [], isSecure, hostOf,
  throttle, access = null, failedAttempt = () => null, audit = null, webDir,
  sessionsActive = () => 0, tlsStatus = () => null, resetMinutes = 60, demoMode = () => null, now = () => Date.now()
}) {
  const enabled = typeof password === 'string' && password.length > 0;
  const want = enabled ? crypto.createHash('sha256').update(password).digest() : null;
  const sessions = new Map(); // sha256(token) -> expires

  /** Whether this request may see the owner page at all (the address check). */
  function local(req) {
    if (viaCloudflare(req, proxy)) return false;
    const sock = normalizeIp(req.socket?.remoteAddress);
    // the gateway's own connections, and whatever it forwards, are public
    // (unless TRUSTED_PROXIES names it: a reverse proxy the owner runs there)
    if (sock && gateways.includes(sock) && !(listedProxies && listedProxies(sock))) return false;
    const ip = clientKey(req);
    return isOwnerLocal(ip) && !gateways.includes(normalizeIp(ip));
  }

  const tokenOf = (req) => {
    const m = /(?:^|;\s*)sm_owner=([A-Za-z0-9_-]{20,80})/.exec(String(req.headers.cookie || ''));
    return m ? m[1] : null;
  };
  const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
  function signedIn(req) {
    const t = tokenOf(req);
    if (!t) return false;
    const exp = sessions.get(hash(t));
    if (!exp || exp <= now()) { sessions.delete(hash(t)); return false; }
    return true;
  }
  /** The two cookies (one per path the page uses), with these flags. */
  const cookies = (value, maxAge) => ['/owner', '/api/owner'].map((p) => `${COOKIE}=${value}; Path=${p}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);

  const isOwnerPath = (p) => p === '/owner' || p.startsWith('/owner/') || p === '/api/owner' || p.startsWith('/api/owner/');

  function tls() {
    try {
      const s = tlsStatus();
      if (!s) return { mode: 'off' };
      const c = s.certificate || {};
      return { mode: s.mode || null, issuer: c.issuer || null, subject: c.subject || null, validTo: c.validTo || null, expiresAt: c.expiresAt || null, names: c.names || s.hostnames || [], fingerprint: c.fingerprint || null, error: s.error || null, ...(s.acme ? { acme: s.acme } : {}) };
    } catch (err) {
      return { mode: 'unknown', error: err.message };
    }
  }

  const filters = (url) => ({ kind: String(url.searchParams.get('kind') || '').slice(0, 24), address: String(url.searchParams.get('address') || '').slice(0, 80), sort: url.searchParams.get('sort') === 'active' ? 'active' : 'newest' });

  /** Handles an owner path; false for any other path (or no owner page). */
  async function handle(req, res, p, url) {
    if (!enabled || !isOwnerPath(p)) return false;
    if (!local(req)) {
      attackLog?.note('owner-probe', req, `${req.method} ${req.url}`);
      res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    if (!isSecure(req)) {
      res.writeHead(308, { Location: `https://${hostOf(req) || 'localhost'}${req.url}`, 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    const api = p.startsWith('/api/');
    try {
      if (!api) {
        if (p === '/owner' || p === '/owner/') {
          if (!(await serveFile(req, res, webDir, 'owner.html', { cache: 'no-store' }))) sendJson(res, 404, { error: 'Not found' });
        } else if (p === '/owner/owner.js') {
          if (!(await serveFile(req, res, webDir, 'owner.js', { cache: 'no-store' }))) sendJson(res, 404, { error: 'Not found' });
        } else sendJson(res, 404, { error: 'Not found' });
        return true;
      }
      const post = req.method === 'POST';
      if (post && req.headers['x-requested-with'] !== 'sentry-six-manager') throw new HttpError(403, 'Missing X-Requested-With header.');
      if (p === '/api/owner/login' && post) {
        const ip = clientKey(req);
        const key = `owner:${ip}`;
        if (access?.banned(ip)) throw new HttpError(429, 'Too many failed attempts from this address. Try again later.');
        const wait = throttle.throttled(key);
        if (wait) {
          attackLog?.note('rate-limit', req, 'owner password');
          throw new HttpError(429, `Too many attempts. Try again in ${wait} s.`);
        }
        const body = await readJson(req, 4096);
        const given = crypto.createHash('sha256').update(String(body?.password ?? '').slice(0, 1024)).digest();
        if (!crypto.timingSafeEqual(given, want)) {
          throttle.noteFailure(key);
          attackLog?.note('login', req, '(owner password)');
          audit?.warn(`Owner page: wrong password from ${ip}`);
          if (failedAttempt(req, 'wrong owner password')) attackLog?.note('ban', req, 'wrong owner password');
          throw new HttpError(401, 'That password is not right.');
        }
        throttle.noteSuccess(key);
        const token = crypto.randomBytes(32).toString('base64url');
        for (const [h, exp] of sessions) if (exp <= now()) sessions.delete(h);
        while (sessions.size >= 50) sessions.delete(sessions.keys().next().value);
        sessions.set(hash(token), now() + SESSION_MS);
        res.setHeader('Set-Cookie', cookies(token, SESSION_MS / 1000));
        audit?.info(`Owner page: signed in from ${ip}`);
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (!signedIn(req)) throw new HttpError(401, 'Enter the owner password.');
      if (p === '/api/owner/logout' && post) {
        const t = tokenOf(req);
        if (t) sessions.delete(hash(t));
        res.setHeader('Set-Cookie', cookies('', 0));
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (p === '/api/owner/state' && req.method === 'GET') {
        const dm = demoMode();
        sendJson(res, 200, {
          log: attackLog ? attackLog.list(filters(url)) : [],
          stats: attackLog ? attackLog.stats() : null,
          visitors: { today: attackLog ? attackLog.stats().visitorsToday : 0, sessions: sessionsActive() },
          bans: access ? access.list().map((b) => ({ key: b.key, until: b.until, reason: b.reason })) : [],
          demo: { resetMinutes, resetAvailable: typeof dm?.reset === 'function' },
          tls: tls(),
          you: clientKey(req)
        });
        return true;
      }
      if (p === '/api/owner/log.csv' && req.method === 'GET') {
        const text = attackLog ? attackLog.csv(filters(url)) : '';
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="attack-log-${new Date(now()).toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
        res.end(text);
        return true;
      }
      if (p === '/api/owner/ban' && post) {
        const body = await readJson(req, 4096);
        const ip = normalizeIp(body?.address);
        if (!ip) throw new HttpError(400, 'Not an address.');
        if (isOwnerLocal(ip)) throw new HttpError(400, 'A local address is not banned from here.');
        if (!access) throw new HttpError(409, 'Bans are not available.');
        const b = access.banNow(ip, 'banned from the owner page');
        attackLog?.note('ban', ip, 'banned from the owner page');
        audit?.warn(`Owner page: banned ${b.key} from ${clientKey(req)}`);
        sendJson(res, 200, { ok: true, ban: { key: b.key, until: b.until } });
        return true;
      }
      if (p === '/api/owner/reset' && post) {
        const dm = demoMode();
        if (typeof dm?.reset !== 'function') throw new HttpError(409, 'This build has no demo reset.');
        await dm.reset();
        audit?.warn(`Owner page: demo reset now from ${clientKey(req)}`);
        sendJson(res, 200, { ok: true });
        return true;
      }
      sendJson(res, 404, { error: 'Not found' });
      return true;
    } catch (err) {
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Internal error' });
      return true;
    }
  }

  return { enabled, handle, local };
}

/** require('./demoMode'), or null when this build has none. */
function loadDemoMode() {
  const file = path.join(__dirname, 'demoMode.js');
  return fs.existsSync(file) ? require(file) : null;
}

module.exports = { createOwnerPage, parseGateways, readGateways, isOwnerLocal, loadDemoMode, COOKIE };
