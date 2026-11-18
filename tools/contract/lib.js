'use strict';

// Shared by record.js and compare.js: an HTTP client that signs in the way
// the pages do, the normalisers for fields that change by themselves, and a
// structural diff.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');

// ---- client

/**
 * A client for one server. Passwords are only ever sent over HTTPS (repo
 * rule); a self-signed certificate is accepted only when named (`ca`, the
 * server's /api/security/ca.crt) or when `insecure` is set explicitly.
 */
function createClient({ base, ca = null, insecure = false, cookie = null, timeoutMs = 60_000 }) {
  const url = new URL(base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Not an http(s) address: ${base}`);
  const secure = url.protocol === 'https:';
  const agent = secure
    ? new https.Agent({ keepAlive: true, ...(ca ? { ca: fs.readFileSync(ca) } : {}), ...(insecure ? { rejectUnauthorized: false } : {}) })
    : new http.Agent({ keepAlive: true });
  let session = cookie;

  function request(method, path, { body, headers = {} } = {}) {
    const target = new URL(path, url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = {
      Accept: 'application/json, */*',
      'Accept-Encoding': 'identity',
      ...(method !== 'GET' && method !== 'HEAD' ? { 'X-Requested-With': 'sentry-six-manager' } : {}),
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      ...(session ? { Cookie: session } : {}),
      ...headers
    };
    return new Promise((resolve, reject) => {
      const req = (secure ? https : http).request(target, { method, headers: h, agent }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${path}: no answer in ${timeoutMs / 1000} s`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function login(username, password) {
    if (!secure) throw new Error('Refusing to send a password over plain HTTP: use an https:// address (or --cookie for a session made elsewhere).');
    const res = await request('POST', '/api/auth/login', { body: { username, password } });
    const data = parseJson(res.body);
    if (res.status !== 200) throw new Error(`Sign-in failed (${res.status}): ${data?.error || res.body.toString().slice(0, 200)}`);
    if (data?.twoFactor) throw new Error('This account uses two-step sign-in: sign in in a browser and pass its session cookie with --cookie.');
    const set = [].concat(res.headers['set-cookie'] || []);
    const c = set.map((s) => s.split(';')[0]).find((s) => /^[^=]+=.{8,}/.test(s));
    if (!c) throw new Error('Signed in, but the server set no session cookie.');
    session = c;
    return c;
  }

  return { request, login, base: url.origin, cookie: () => session, close: () => agent.destroy() };
}

function parseJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined;
  }
}

// ---- normalisers

// Header fields that say something about the answer (kept in goldens);
// dates, lengths of compressed bodies and connection details are not.
const KEPT_HEADERS = ['content-type', 'content-range', 'content-disposition', 'cache-control', 'accept-ranges', 'x-content-type-options', 'www-authenticate', 'location'];

/**
 * Key names that change by themselves on every server: times, uptimes,
 * process figures, random ids. Matched against the key alone, at any depth,
 * and only for plain values (a key holding an object is walked into).
 * '<time>' keeps "there is a time here": null stays null, so a time that
 * appears or vanishes still differs. Durations of footage (seconds, minutes,
 * frame times) are never in this list: they are what the gate checks.
 */
const VOLATILE_KEYS = [
  [/^(at|ts|now|time|when|since|until|started|finished|updated|created|expires)$/i, 'recent'],
  [/(At|Time|Since|Until|Stamp)$/, 'recent'],
  [/^(?!duration).*Ms$/, 'recent'], // mtimeMs, checkedMs; durationMs stays
  [/^(uptime|uptimeS|appUptimeS|pid|rss|heapUsed|heapTotal|loadavg|elapsedMs|tookMs)$/i, 'number'],
  [/^(sessionId|token|csrf|nonce|clientId|requestId|etag|fingerprint)$/i, 'id']
];

/** `v` with its volatile part taken out, the way `kind` says. */
function scrub(kind, v, ctx = {}) {
  if (kind === 'shape') return shape(v);
  if (kind === 'keys') return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, '<value>'])) : '<value>';
  if (v === null || v === undefined) return v;
  if (kind === 'drop') return '<dropped>';
  if (kind === 'time') return typeof v === 'number' || typeof v === 'string' ? '<time>' : v;
  if (kind === 'recent') return (typeof v === 'number' || typeof v === 'string') && recent(typeof v === 'number' ? epochMs(v) : Date.parse(v), ctx) ? '<time>' : v;
  if (kind === 'number') return typeof v === 'number' ? '<number>' : v;
  if (kind === 'id') return typeof v === 'string' || typeof v === 'number' ? '<id>' : v;
  if (kind === 'bytes') return typeof v === 'number' ? '<bytes>' : v;
  throw new Error(`Unknown normaliser "${kind}"`);
}

// A time under a time-like key (or an ISO stamp in text) is replaced only
// when it is close to the moment of the request: the server's own clock
// (when it started, scanned, checked). Times of the footage, written by the
// car (2024-05-01T08:00:00), stay and are compared. A real archive's last
// month of footage times fall in the window too: those are not compared.
const RECENT_MS = 30 * 86400_000;
function epochMs(n) {
  if (n > 1e11 && n < 1e14) return n; // milliseconds
  if (n > 1e9 && n < 1e11) return n * 1000; // seconds
  return NaN;
}
function recent(ms, ctx = {}) {
  if (!Number.isFinite(ms)) return false;
  const now = ctx.now || Date.now();
  return ms > now - RECENT_MS && ms < now + 86400_000;
}

/** Only the structure: object keys, arrays (by their first item) and "a value" (any number, text, true/false or null: these figures come and go). */
function shape(v) {
  if (v === null || v === undefined) return '<value>';
  if (Array.isArray(v)) return v.length ? [shape(v.find((x) => x !== null) ?? null)] : [];
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])]));
  return '<value>';
}

/**
 * Normalise a JSON body. `rules` (per route) add to the key rules:
 *   { path: 'stats.cpu.*', as: 'drop'|'time'|'number'|'id'|'bytes' }
 *   { path: 'jobs', sortBy: 'title' }   order an array by a field
 *   { keys: false }                     no key-name rules for this route
 * A path is dot-separated keys; '*' is any one key or array index, '**' any
 * depth. String values that look like ISO times or the run's own temporary
 * folder are replaced everywhere (see normaliseString).
 */
function normalise(value, rules = [], ctx = {}) {
  const useKeys = !rules.some((r) => r.keys === false);
  const pathRules = rules.filter((r) => r.path).map((r) => ({ ...r, re: globRe(r.path) }));
  const strings = rules.flatMap((r) => r.strings || []);
  const sctx = { ...ctx, strings: [...(ctx.strings || []), ...strings] };
  const walk = (v, at) => {
    const here = at.join('.');
    const rule = pathRules.find((r) => r.as && r.re.test(here));
    if (rule) return scrub(rule.as, v, sctx);
    if (Array.isArray(v)) {
      let out = v.map((x, i) => walk(x, [...at, String(i)]));
      const sort = pathRules.find((r) => r.sortBy && r.re.test(here));
      if (sort) out = [...out].sort((a, b) => String(pick(a, sort.sortBy)).localeCompare(String(pick(b, sort.sortBy))));
      return out;
    }
    if (v && typeof v === 'object') {
      const out = {};
      // keys too: some answers are keyed by a clip's full path
      for (const k of Object.keys(v).sort()) {
        const keyRule = useKeys && VOLATILE_KEYS.find(([re]) => re.test(k));
        const own = pathRules.find((r) => r.as && r.re.test(at.concat(k).join('.')));
        out[normaliseString(k, { ...sctx, isoTimes: false })] = own ? scrub(own.as, v[k], sctx)
          : keyRule && (typeof v[k] !== 'object' || v[k] === null) ? scrub(keyRule[1], v[k], sctx)
            : walk(v[k], [...at, k]);
      }
      return out;
    }
    if (typeof v === 'string') return normaliseString(v, sctx);
    return v;
  };
  return walk(value, []);
}

const pick = (o, dotted) => dotted.split('.').reduce((x, k) => (x == null ? x : x[k]), o);

function globRe(glob) {
  const parts = glob.split('.').map((p) => (p === '**' ? '(?:[^.]+\\.)*?[^.]*' : p === '*' ? '[^.]+' : p.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')));
  return new RegExp(`^${parts.join('\\.')}$`);
}

const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;

/**
 * Times written into text (an ISO stamp that is "now", not a clip's time) and
 * the server's own folders (each instance has its own data folder) are
 * replaced; everything else is kept as it is. Clip times (2024-05-01_08-00-00)
 * have no T and stay.
 */
function normaliseString(s, ctx = {}) {
  let out = s;
  for (const [from, to] of ctx.replace || []) out = out.split(from).join(to);
  for (const [re, to] of ctx.strings || []) out = out.replace(new RegExp(re.source ?? re, 'g'), to);
  if (ctx.isoTimes !== false) out = out.replace(ISO, (m) => (recent(Date.parse(m), ctx) ? '<iso-time>' : m));
  return out;
}

/** What a golden keeps of an answer: status, the kept headers, the body (normalised JSON, text, or a digest of bytes). */
function snapshot(res, spec = {}, ctx = {}) {
  const type = String(res.headers['content-type'] || '');
  const headers = {};
  for (const h of KEPT_HEADERS) if (res.headers[h] !== undefined && !(spec.ignoreHeaders || []).includes(h)) headers[h] = normaliseString(String(res.headers[h]), ctx);
  const out = { status: res.status, headers };
  if (spec.body === 'ignore') {
    out.body = '<ignored>';
  } else if (/json/.test(type) || spec.body === 'json') {
    const data = parseJson(res.body);
    out.body = data === undefined ? { '<not json>': res.body.toString('utf8').slice(0, 2000) } : normalise(data, spec.normalise || [], ctx);
  } else if (/^text\//.test(type) && spec.body !== 'digest') {
    let text = res.body.toString('utf8');
    if (spec.text === 'firstLine') text = text.split('\n')[0];
    out.body = normaliseString(text, ctx);
  } else {
    out.body = { bytes: res.body.length, sha256: spec.body === 'size' ? '<not compared>' : crypto.createHash('sha256').update(res.body).digest('hex') };
  }
  return out;
}

// ---- diff

/** Every difference between two normalised values, as { path, golden, actual }. */
function diff(a, b, at = '', out = [], limit = 200) {
  if (out.length >= limit) return out;
  if (Object.is(a, b)) return out;
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b;
  if (ta !== tb || (ta !== 'object' && ta !== 'array')) {
    out.push({ path: at || '(root)', golden: a, actual: b });
    return out;
  }
  if (ta === 'array') {
    if (a.length !== b.length) out.push({ path: `${at}.length`, golden: a.length, actual: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${at}[${i}]`, out, limit);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    const p = at ? `${at}.${k}` : k;
    if (!(k in a)) out.push({ path: p, golden: '<absent>', actual: b[k] });
    else if (!(k in b)) out.push({ path: p, golden: a[k], actual: '<absent>' });
    else diff(a[k], b[k], p, out, limit);
  }
  return out;
}

/** A short one-line text of a value for the diff listing. */
function brief(v) {
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/** The golden file name for a request: readable and unique. */
function goldenName(method, url) {
  const slug = `${method}_${url}`.replace(/^GET_/, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 90);
  const h = crypto.createHash('sha1').update(`${method} ${url}`).digest('hex').slice(0, 8);
  return `${slug}.${h}.json`;
}

// ---- shared by the command-line tools

/** --name value and --flag arguments. */
function parseArgs(argv, flags = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (flags.includes(k)) out[k] = true;
    else out[k] = argv[++i];
  }
  return out;
}

/**
 * A signed-in client from the command line: --base, --user, the password in
 * an environment variable (--password-env, default SM_PASSWORD; never on the
 * command line, where other users of the machine can read it) or a session
 * cookie (--cookie-env), --ca or --insecure-self-signed for HTTPS.
 */
async function connect(args) {
  if (!args.base) throw new Error('--base https://host:port is required');
  if (args.ca && args['insecure-self-signed']) throw new Error('Give --ca or --insecure-self-signed, not both');
  const cookie = args['cookie-env'] ? process.env[args['cookie-env']] : null;
  const client = createClient({ base: args.base, ca: args.ca || null, insecure: Boolean(args['insecure-self-signed']), cookie });
  if (!cookie) {
    const envName = args['password-env'] || 'SM_PASSWORD';
    const password = process.env[envName];
    if (!password) throw new Error(`Set the password in $${envName} (or a session cookie with --cookie-env NAME)`);
    await client.login(args.user || 'admin', password);
  }
  return client;
}

/** Put a server's own folders into a request template ({root:<id>}, {data}). */
function fill(text, folders) {
  let out = String(text);
  for (const [real, token] of folders) out = out.split(token).join(real);
  return out;
}

/** The URL of a request template on one server. */
function requestUrl(req, folders) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) q.set(k, fill(v, folders));
  const s = q.toString();
  return `${fill(req.path, folders)}${s ? `?${s}` : ''}`;
}

/** A readable name of a request template (for listings and file names). */
function requestLabel(method, req) {
  const s = Object.entries(req.query || {}).map(([k, v]) => `${k}=${v}`).join('&');
  return `${method} ${req.path}${s ? `?${s}` : ''}${req.headers?.Range ? ` [Range ${req.headers.Range}]` : ''}`;
}

module.exports = {
  createClient, parseJson, normalise, normaliseString, snapshot, diff, brief, goldenName, globRe, shape, recent,
  parseArgs, connect, fill, requestUrl, requestLabel, VOLATILE_KEYS, KEPT_HEADERS
};
