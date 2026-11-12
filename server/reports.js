'use strict';

// Feedback and diagnostics for the developers (Settings → Help & feedback).
//
// OPT-IN ONLY. Nothing leaves this server unless an admin:
//   - presses Send for one feedback message ("Send feedback"),
//   - presses "Send diagnostics to support" for one support report, or
//   - turns on "Share diagnostics with the developers", which then sends a
//     report after a crash or an unhandled error, a health summary once a
//     day, and a short heartbeat every hour (the version, health, how much
//     footage and space saved: numbers only, see heartbeat below). Turning it
//     off stops that and drops the automatic reports still waiting to go.
// "Send anonymously" replaces every identifier with "ANON" (server/
// reportsScrub.js) and sends no contact. Secrets are never in a report,
// anonymous or not.
//
// Where they go: only the developers' private receiver (server/
// reportsConfig.js). Each report is sealed to the
// receiver's key before it leaves this process (server/reportsProtocol.js),
// signed with this install's own key (data/reports/install-key.pem; a second
// key, anon-key.pem, signs anonymous ones so they cannot be tied to the
// install), and carries a small proof of work. HTTPS only, the system's
// certificate checks, 20 s, redirects never followed.
//
// A report that cannot go now waits, sealed, in data/reports/outbox (at most
// 20 reports, 50 MB, 7 days; never plaintext) and is tried again with
// backoff. Without a receiver key in this build nothing is ever built or sent.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const P = require('./reportsProtocol');
const { reportsConfig, checkEndpoint } = require('./reportsConfig');
const { cleanReport } = require('./reportsScrub');
const { MODELS: CAR_MODELS } = require('./carModels');

const OUTBOX_MAX = 20;
const OUTBOX_BYTES = 50 * 1024 * 1024;
const OUTBOX_DAYS = 7;
const TIMEOUT_MS = 20_000;
const CONFIG_TTL_MS = 10 * 60_000;
const MAX_BITS = 26; // a receiver asking for more is not followed (a stamp would take minutes)
const MANUAL_PER_HOUR = 5;
const DAY_MS = 86_400_000;
const AUTO_KINDS = new Set(['crash', 'daily', 'heartbeat']);
// the heartbeat: 10 to 60 seconds after a start (right away when sharing is
// turned on), then every hour, each give or take a little so installs that
// update at once spread out
const HEARTBEAT_FIRST_MS = 35_000;
const HEARTBEAT_FIRST_JITTER_MS = 25_000;
const HEARTBEAT_EVERY_MS = 3600_000;
const HEARTBEAT_JITTER_MS = 4 * 60_000;
const defaultTimer = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) };
const NOT_SET_UP = "Reporting isn't set up in this build.";

class ReportError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) { this.code = code; this.expose = true; }
  }
}

/** POST/GET over HTTPS with no redirects: { status, headers, body }. */
function defaultTransport({ method, url, headers = {}, body = null, timeoutMs = TIMEOUT_MS }) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let done = false;
    let req = null;
    // the whole exchange within timeoutMs (the socket's own timeout is only
    // for silence: a receiver sending a byte now and then would hold it for ever)
    const deadline = setTimeout(() => {
      finish(reject, new Error('The receiver did not answer in time.'));
      req?.destroy();
    }, timeoutMs);
    deadline.unref?.();
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(deadline); fn(v); } };
    req = mod.request(u, { method, headers: { 'User-Agent': 'sentry-six-manager-reports', ...headers, ...(body ? { 'Content-Length': body.length } : {}) }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > 256 * 1024) { res.destroy(); finish(reject, new Error('The receiver answered too much.')); return; }
        chunks.push(c);
      });
      res.on('end', () => finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (err) => finish(reject, err));
    });
    req.on('timeout', () => req.destroy(new Error('The receiver did not answer in time.')));
    req.on('error', (err) => finish(reject, err));
    req.end(body || undefined);
  });
}

/** The proof of work, in a worker thread so the event loop keeps going. */
function workerPow(envHash, nonce, bits) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    const w = new Worker(`const { parentPort, workerData } = require('worker_threads');
      const { solvePow } = require(workerData.protocol);
      parentPort.postMessage(solvePow(Buffer.from(workerData.h, 'hex'), workerData.nonce, workerData.bits));`,
    { eval: true, workerData: { protocol: path.join(__dirname, 'reportsProtocol.js'), h: envHash.toString('hex'), nonce, bits } });
    w.once('message', (pow) => { resolve(pow); w.terminate(); });
    w.once('error', reject);
    w.once('exit', (code) => { if (code) reject(new Error('The proof of work stopped.')); });
  });
}

/** The receiver's answer as an object ({} for anything else: junk, null, a list). */
const json = (buf) => {
  try {
    const d = JSON.parse(buf.toString('utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch { return {}; }
};

/**
 * o: db, dataDir, buildInfo, ui() (the interface in use), diagnostics()
 * (async: the diagnostics object, its DIAG_KEYS), heartbeat() (async: the
 * heartbeat's numbers, see normalizeHeartbeat), identifiers() (async:
 * strings an anonymous report must not contain), log, audit, env, now,
 * transport, pow (envHash, nonce, bits) => Promise<pow>, timer ({ set, clear }:
 * the heartbeat's schedule), random () => [0, 1).
 */
function createReports({
  db, dataDir, buildInfo = {}, ui = () => 'original', diagnostics = async () => ({}), heartbeat = async () => ({}), identifiers = async () => [],
  log = { info() {}, warn() {}, error() {} }, env = process.env, now = () => Date.now(), transport = defaultTransport, pow = workerPow,
  timer = defaultTimer, random = Math.random
}) {
  const dir = path.join(dataDir, 'reports');
  const outboxDir = path.join(dir, 'outbox');
  const crashFile = path.join(dir, 'crashes.json');
  const cfg = reportsConfig(env);
  if (cfg.error) log.warn(`Reports: ${cfg.error} Reporting is off.`);
  const configured = cfg.keys.length > 0;
  const offText = cfg.off ? 'Reporting is turned off on this server (REPORTS=off).' : NOT_SET_UP;
  const previews = new Map(); // id -> { payload, until, kind }
  let remote = null; // { endpoint, at, data }
  let clockOffset = 0;
  let timers = [];
  let flushing = null;
  let started = false;
  let hbTimer = null;
  let hbNextAt = null;

  const settings = () => ({ share: false, anonymous: false, ...(db.get('reports-settings', null) || {}) });
  const state = () => db.get('reports-state', null) || {};
  const setState = (patch) => db.set('reports-state', { ...state(), ...patch });

  function ensureDir(d) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(d, 0o700); } catch { /* not ours */ }
  }
  function installId() {
    let id = state().installId;
    if (!/^[0-9a-f]{32}$/.test(id || '')) {
      id = crypto.randomBytes(16).toString('hex');
      setState({ installId: id });
    }
    return id;
  }
  /** The install's signing key (or the anonymous one), made once, mode 600. */
  function signingKey(anonymous) {
    ensureDir(dir);
    const file = path.join(dir, anonymous ? 'anon-key.pem' : 'install-key.pem');
    try {
      return crypto.createPrivateKey(fs.readFileSync(file));
    } catch { /* none yet */ }
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'w' });
    fs.chmodSync(file, 0o600);
    return privateKey;
  }
  function endpoint() {
    if (cfg.fromEnv.url) return cfg.endpoint;
    const m = state().moved;
    if (m?.url) {
      try { return checkEndpoint(m.url, env); } catch { /* a bad one is ignored */ }
    }
    return cfg.endpoint;
  }

  // ---- the outbox: sealed envelopes only
  function outbox() {
    let names = [];
    try { names = fs.readdirSync(outboxDir).filter((n) => /^[0-9a-f]{24}\.json$/.test(n)); } catch { return []; }
    const out = [];
    for (const n of names) {
      const file = path.join(outboxDir, n);
      try {
        const e = JSON.parse(fs.readFileSync(file, 'utf8'));
        out.push({ ...e, file, bytes: fs.statSync(file).size });
      } catch {
        try { fs.unlinkSync(file); } catch { /* gone */ }
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }
  function saveEntry(e) {
    ensureDir(outboxDir);
    const { file: _f, bytes: _b, ...keep } = e;
    const file = path.join(outboxDir, `${e.id}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(keep), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return file;
  }
  const dropEntry = (e) => { try { fs.unlinkSync(path.join(outboxDir, `${e.id}.json`)); } catch { /* gone */ } };
  /**
   * The outbox within its caps: older than 7 days out; only the newest
   * heartbeat; then, over 20 reports or 50 MB, that heartbeat first (a
   * heartbeat never pushes a real report out), then the oldest.
   */
  function trimOutbox() {
    let list = outbox();
    for (const e of list) if (now() - e.createdAt > OUTBOX_DAYS * DAY_MS) dropEntry(e);
    list = list.filter((e) => now() - e.createdAt <= OUTBOX_DAYS * DAY_MS);
    const beats = list.filter((e) => e.kind === 'heartbeat');
    for (const e of beats.slice(0, -1)) dropEntry(e);
    list = list.filter((e) => e.kind !== 'heartbeat' || e === beats.at(-1));
    let bytes = list.reduce((s, e) => s + e.bytes, 0);
    while (list.length > OUTBOX_MAX || bytes > OUTBOX_BYTES) {
      const hb = list.findIndex((e) => e.kind === 'heartbeat');
      const [e] = list.splice(hb >= 0 ? hb : 0, 1);
      bytes -= e.bytes;
      dropEntry(e);
    }
    return list;
  }
  /**
   * Keeps an entry for a later try: only one still in the outbox (one the
   * caps took out while it was being tried stays out), and a heartbeat only
   * while there is room (see trimOutbox).
   */
  function keepForLater(e) {
    if (!fs.existsSync(path.join(outboxDir, `${e.id}.json`))) return;
    saveEntry(e);
    if (e.kind === 'heartbeat') trimOutbox();
  }
  /** What the status shows: a heartbeat has its own line, and never hides the last real report or problem. */
  function noteOutcome(e, { sent = null, error = null }) {
    if (e.kind === 'heartbeat') {
      const prev = state().lastHeartbeat || {};
      setState({ lastHeartbeat: sent ? { at: sent.at, error: null } : { at: prev.at || null, error: error ? { at: now(), message: error } : null } });
      return;
    }
    setState(sent ? { lastSent: sent, lastError: null } : { lastError: { at: now(), message: error } });
  }

  // ---- the receiver's settings (GET /v1/config), and a signed move
  async function remoteConfig(force = false) {
    const ep = endpoint();
    if (!force && remote && remote.endpoint === ep && now() - remote.at < CONFIG_TTL_MS) return remote.data;
    const res = await transport({ method: 'GET', url: `${ep}/v1/config`, headers: { Accept: 'application/json' } });
    if (res.status !== 200) throw Object.assign(new Error(`The receiver answered ${res.status} for its settings.`), { retry: true, status: res.status });
    const data = json(res.body);
    if (!Number.isInteger(data.difficulty) || data.difficulty < 0) throw Object.assign(new Error('The receiver sent no difficulty.'), { retry: true });
    if (Number.isFinite(data.time)) {
      const off = data.time - now();
      clockOffset = Math.abs(off) > 60_000 ? off : 0;
    }
    if (data.moved && !cfg.fromEnv.url) {
      const prev = state().moved;
      if (P.verifyMoved(data.moved, cfg.keys) && !(prev?.at >= data.moved.at)) {
        try {
          const url = checkEndpoint(data.moved.url, env);
          if (url !== ep) {
            setState({ moved: { url, at: data.moved.at } });
            log.warn(`Reports: the receiver moved to ${url} (signed by its key)`);
            remote = null;
            return remoteConfig(true);
          }
        } catch (err) {
          log.warn(`Reports: a move notice was ignored: ${err.message}`);
        }
      } else if (!P.verifyMoved(data.moved, cfg.keys)) log.warn('Reports: a move notice with no valid signature was ignored');
    }
    remote = { endpoint: ep, at: now(), data };
    return data;
  }

  /** One delivery attempt: 'sent' | 'retry' | 'dropped'. */
  async function deliver(e, again = true) {
    const conf = await remoteConfig(!again);
    const bits = conf.difficulty;
    if (bits > MAX_BITS) throw Object.assign(new Error(`The receiver asks for a proof of work of ${bits} bits (more than ${MAX_BITS}).`), { retry: true });
    const ts = Math.round(now() + clockOffset);
    const nonce = P.b64(crypto.randomBytes(16));
    const env0 = e.env;
    const stamp = await pow(P.envelopeHash(env0), nonce, bits);
    // sharing turned off while this one was on its way (the settings asked
    // for, or the proof of work): an automatic report does not go after all
    if (AUTO_KINDS.has(e.kind) && !settings().share) {
      dropEntry(e);
      return { result: 'dropped', message: 'Sharing is off.' };
    }
    const body = P.sign(env0, signingKey(e.anonymous), { ts, nonce, pow: stamp, bits });
    const res = await transport({ method: 'POST', url: `${endpoint()}/v1/report`, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: Buffer.from(JSON.stringify(body)) });
    const d = json(res.body);
    if (res.status === 202 && d.ok) {
      dropEntry(e);
      const sent = { at: now(), kind: e.kind, ref: typeof d.ref === 'string' ? d.ref.slice(0, 20) : null, id: typeof d.id === 'string' ? d.id.slice(0, 40) : null };
      noteOutcome(e, { sent });
      if (e.kind !== 'heartbeat') log.info(`Reports: ${e.kind} report sent${sent.ref ? ` (${sent.ref})` : ''}`);
      return { result: 'sent', ...sent };
    }
    // the difficulty or the clock changed in between: once more with fresh settings
    if (res.status === 400 && (d.code === 'POW' || d.code === 'TIME') && again) {
      remote = null;
      if (Number.isFinite(d.time)) clockOffset = d.time - now();
      return deliver(e, false);
    }
    if (res.status === 429 || res.status >= 500 || res.status === 408) {
      const wait = Math.max(60, Math.min(6 * 3600, Number(res.headers?.['retry-after']) || Number(d.retryAfter) || 0));
      e.attempts = (e.attempts || 0) + 1;
      e.nextAt = now() + Math.max(wait * 1000, backoff(e.attempts));
      keepForLater(e);
      const msg = res.status === 429 ? 'The receiver is busy (too many reports): it will be tried again later.' : `The receiver answered ${res.status}: it will be tried again later.`;
      noteOutcome(e, { error: msg });
      return { result: 'retry', status: res.status, message: msg };
    }
    // refused for good (malformed, banned, too large): kept would never go
    dropEntry(e);
    const msg = `The receiver refused the report (${res.status}${d.error ? `: ${String(d.error).slice(0, 160)}` : ''}).`;
    noteOutcome(e, { error: msg });
    log.warn(`Reports: ${msg}`);
    return { result: 'dropped', status: res.status, message: msg };
  }
  const backoff = (n) => Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(n, 10)) * (0.8 + Math.random() * 0.4);

  async function attempt(e) {
    try {
      return await deliver(e);
    } catch (err) {
      e.attempts = (e.attempts || 0) + 1;
      e.nextAt = now() + backoff(e.attempts);
      keepForLater(e);
      const msg = `Could not reach the receiver (${String(err.message || err).slice(0, 160)}): it will be tried again later.`;
      noteOutcome(e, { error: msg });
      return { result: 'retry', message: msg };
    }
  }

  /** Every waiting report that is due (one pass at a time). */
  function flush({ all = false } = {}) {
    if (!configured) return Promise.resolve([]);
    if (flushing) return flushing;
    flushing = (async () => {
      const out = [];
      for (const e of trimOutbox()) {
        if (AUTO_KINDS.has(e.kind) && !settings().share) { dropEntry(e); continue; }
        if (!all && e.nextAt > now()) continue;
        out.push(await attempt(e));
      }
      return out;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  // ---- building a report
  function buildBlock() {
    const sha = typeof buildInfo.sha === 'string' && /^[0-9a-f]{7,64}$/.test(buildInfo.sha) ? buildInfo.sha : null;
    const str = (x, n) => (typeof x === 'string' && x ? x.slice(0, n) : null);
    return { build: Number.isSafeInteger(buildInfo.build) && buildInfo.build > 0 ? buildInfo.build : null, sha, builtAt: str(buildInfo.builtAt, 40), tag: str(buildInfo.tag, 120) };
  }

  /** The payload exactly as it would be sealed (cleaned, checked). */
  async function buildPayload({ kind, message, contact, attach = true, crash = null }) {
    if (!configured) throw new ReportError(409, offText, 'NOT_SET_UP');
    const anonymous = Boolean(settings().anonymous);
    const p = { kind, sentAt: new Date(now()).toISOString(), install: anonymous ? P.ANON : installId(), anonymous, build: buildBlock(), ui: String(ui() || 'original').slice(0, P.LIMITS.ui) };
    if (kind === 'feedback') {
      const m = String(message ?? '').trim();
      if (!m) throw new ReportError(400, 'Write a message first.');
      if (m.length > P.LIMITS.message) throw new ReportError(400, `The message is longer than ${P.LIMITS.message} characters.`);
      p.message = m;
      const c = String(contact ?? '').trim();
      if (c.length > P.LIMITS.contact) throw new ReportError(400, `The contact is longer than ${P.LIMITS.contact} characters.`);
      if (c && !anonymous) p.contact = c;
    } else if (kind === 'support') {
      const m = String(message ?? '').trim();
      if (m.length > P.LIMITS.note) throw new ReportError(400, `The note is longer than ${P.LIMITS.note} characters.`);
      if (m) p.message = m;
    }
    if (crash) p.crash = crash;
    if (kind === 'heartbeat') {
      // numbers, yes/no, fixed words and the hardware's and cars' model
      // names: nothing in it names anyone. Its text goes through the
      // scrubber all the same, as an anonymous report's does whether this
      // one is anonymous or not (no host, path, name or address ever belongs
      // in a heartbeat), then normalizeHeartbeat keeps only plain text of
      // the protocol's lengths (a car's model only from the list of models).
      const raw = { ...((await heartbeat()) || {}) };
      const text = {};
      for (const k of HEARTBEAT_TEXT) if (raw[k] !== undefined) text[k] = raw[k];
      const ids = [installId(), ...(await identifiers().catch(() => []))];
      Object.assign(raw, cleanReport(text, { anonymous: true, identifiers: ids }), { crashes24h: crashes24h() });
      p.heartbeat = normalizeHeartbeat(raw);
      const errs = P.validatePayload(p);
      if (errs.length) throw new ReportError(500, `The heartbeat did not come out right: ${errs.slice(0, 3).join(', ')}`);
      return p;
    }
    if (kind !== 'feedback' || attach) p.diagnostics = await diagnostics({ kind });
    // contents through the scrubber (secrets always; identifiers when anonymous)
    const ids = anonymous ? [installId(), ...(await identifiers().catch(() => []))] : [];
    for (const k of ['message', 'crash', 'diagnostics']) {
      if (p[k] !== undefined) p[k] = cleanReport(p[k], { anonymous, identifiers: ids });
    }
    if (p.crash) {
      p.crash.message = String(p.crash.message ?? '').slice(0, P.LIMITS.crashMessage);
      p.crash.stack = String(p.crash.stack ?? '').slice(0, P.LIMITS.crashStack);
      p.crash.name = String(p.crash.name ?? 'Error').slice(0, 120);
    }
    if (p.message !== undefined && kind === 'feedback' && !p.message.trim()) p.message = P.ANON;
    const errs = P.validatePayload(p);
    if (errs.length) throw new ReportError(500, `The report did not come out right: ${errs.slice(0, 3).join(', ')}`);
    return p;
  }

  /** Seals a payload into the outbox and tries it now: { result, ref?, message? }. */
  async function enqueue(payload) {
    const key = cfg.keys[0];
    const e = { id: crypto.randomBytes(12).toString('hex'), kind: payload.kind, anonymous: payload.anonymous, createdAt: now(), attempts: 0, nextAt: now(), env: P.seal(payload, key) };
    if (Buffer.byteLength(JSON.stringify(e.env)) > P.MAX_BODY - 4096) throw new ReportError(413, 'This report is too large to send.');
    saveEntry(e);
    trimOutbox();
    return attempt(e);
  }

  function takeManual(kind) {
    const t = now();
    const all = state().manual || {};
    const list = (all[kind] || []).filter((x) => t - x < 3600_000);
    if (list.length >= MANUAL_PER_HOUR) {
      const wait = Math.ceil((list[0] + 3600_000 - t) / 60_000);
      throw new ReportError(429, `That is ${MANUAL_PER_HOUR} in the last hour already. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`);
    }
    list.push(t);
    setState({ manual: { ...all, [kind]: list } });
  }

  // ---- crashes and unhandled errors (kept locally; sent only when sharing is on)
  function readCrashes() {
    try {
      const list = JSON.parse(fs.readFileSync(crashFile, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }
  /** Notes a crash or an unhandled error, synchronously (it may be the process's last act). */
  function noteCrash(err, source = 'crash') {
    try {
      ensureDir(dir);
      const list = readCrashes().filter((c) => now() - Date.parse(c.at) < OUTBOX_DAYS * DAY_MS).slice(-19);
      const e = err instanceof Error ? err : new Error(String(err));
      list.push({ at: new Date(now()).toISOString(), name: String(e.name || 'Error').slice(0, 120), message: String(e.message || '').slice(0, P.LIMITS.crashMessage), stack: String(e.stack || '').slice(0, P.LIMITS.crashStack), source, sent: false });
      const tmp = `${crashFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
      fs.renameSync(tmp, crashFile);
    } catch { /* nothing more to do */ }
    if (source === 'error') setTimeout(() => sendCrashes().catch(() => {}), 5_000).unref?.();
  }
  /** Crashes and unhandled errors noted in the last 24 hours (the heartbeat's crashes24h). */
  const crashes24h = () => readCrashes().filter((c) => now() - Date.parse(c.at) < DAY_MS).length;
  /** The recent crash stacks for diagnostics (the newest 5). */
  const recentCrashes = () => readCrashes().slice(-5).map(({ sent: _s, ...c }) => c);
  /** Sends what was noted and not sent yet: at most one report an hour for the same error, 6 a day. */
  async function sendCrashes() {
    if (!configured || !settings().share) return [];
    const list = readCrashes();
    const st = state();
    const sentLog = (st.crashSent || []).filter((x) => now() - x.at < DAY_MS);
    const out = [];
    for (const c of list) {
      if (c.sent) continue;
      c.sent = true;
      const sig = crypto.createHash('sha256').update(`${c.name}|${c.message}|${String(c.stack).split('\n').slice(0, 3).join('|')}`).digest('hex').slice(0, 16);
      if (sentLog.length >= 6 || sentLog.some((x) => x.sig === sig && now() - x.at < 3600_000)) continue;
      sentLog.push({ sig, at: now() });
      try {
        out.push(await enqueue(await buildPayload({ kind: 'crash', crash: { at: c.at, name: c.name, message: c.message, stack: c.stack, source: c.source === 'error' ? 'error' : 'crash' } })));
      } catch (err) {
        log.warn(`Reports: the crash report was not made: ${err.message}`);
      }
    }
    try { fs.writeFileSync(crashFile, JSON.stringify(list), { mode: 0o600 }); } catch { /* next time */ }
    setState({ crashSent: sentLog });
    return out;
  }
  async function dailyIfDue() {
    if (!configured || !settings().share) return null;
    const last = state().lastDailyAt || 0;
    if (now() - last < DAY_MS - 60_000) return null;
    setState({ lastDailyAt: now() });
    try {
      return await enqueue(await buildPayload({ kind: 'daily' }));
    } catch (err) {
      log.warn(`Reports: the daily summary was not made: ${err.message}`);
      return null;
    }
  }

  // ---- the hourly heartbeat (sharing on only)
  /**
   * Sends one heartbeat now, when sharing is on: the one still waiting (if
   * any) is replaced, so at most one is ever in the outbox.
   */
  async function sendHeartbeat() {
    if (!configured || !settings().share) return null;
    let payload;
    try {
      payload = await buildPayload({ kind: 'heartbeat' });
    } catch (err) {
      log.warn(`Reports: the heartbeat was not made: ${err.message}`);
      return null;
    }
    if (!settings().share) return null; // turned off while it was made
    for (const e of outbox()) if (e.kind === 'heartbeat') dropEntry(e);
    return enqueue(payload);
  }
  const jitter = (ms) => Math.round((random() * 2 - 1) * ms);
  /** The next heartbeat in `ms` (it reschedules itself an hour later). */
  function scheduleHeartbeat(ms) {
    if (hbTimer) timer.clear(hbTimer);
    hbNextAt = now() + ms;
    hbTimer = timer.set(() => {
      hbTimer = null;
      return sendHeartbeat().catch(() => null).finally(() => {
        if (started && !hbTimer) scheduleHeartbeat(HEARTBEAT_EVERY_MS + jitter(HEARTBEAT_JITTER_MS));
      });
    }, ms);
    hbTimer?.unref?.();
  }
  const firstHeartbeatIn = () => HEARTBEAT_FIRST_MS + jitter(HEARTBEAT_FIRST_JITTER_MS);

  // ---- what the routes call
  function status() {
    const list = configured ? outbox() : [];
    const s = state();
    return {
      configured, notSetUpText: configured ? null : offText, endpoint: configured ? endpoint() : null, kid: cfg.keys[0]?.kid || null,
      settings: settings(), lastSent: s.lastSent || null, lastError: s.lastError || null,
      lastHeartbeat: s.lastHeartbeat || null, nextHeartbeatAt: configured && settings().share && started ? hbNextAt : null,
      outbox: { count: list.length, bytes: list.reduce((n, e) => n + e.bytes, 0) },
      manualPerHour: MANUAL_PER_HOUR
    };
  }
  function setSettings(patch, by = '') {
    if (!configured) throw new ReportError(409, offText, 'NOT_SET_UP');
    const before = settings();
    const next = { ...before };
    for (const k of ['share', 'anonymous']) {
      if (patch?.[k] === undefined) continue;
      if (typeof patch[k] !== 'boolean') throw new ReportError(400, `${k} is on or off.`);
      next[k] = patch[k];
    }
    next.changedAt = now();
    db.set('reports-settings', next);
    if (before.share && !next.share) for (const e of outbox()) if (AUTO_KINDS.has(e.kind)) dropEntry(e);
    // the first daily summary a day after turning it on; the first heartbeat
    // right away (then hourly from now). After a restart the first one waits
    // 10 to 60 seconds, so a fleet updating at once does not report in the
    // same second.
    if (!before.share && next.share) {
      setState({ lastDailyAt: now() });
      if (started) {
        scheduleHeartbeat(HEARTBEAT_EVERY_MS + jitter(HEARTBEAT_JITTER_MS));
        sendHeartbeat().then(() => flush()).catch(() => null);
      }
    }
    return { before, after: next, by };
  }
  async function preview(opts) {
    // a sample heartbeat, to look at (it is never sent by hand)
    if (opts?.kind === 'heartbeat') return { previewId: null, sample: true, payload: await buildPayload({ kind: 'heartbeat' }) };
    const kind = opts?.kind === 'support' ? 'support' : 'feedback';
    const payload = await buildPayload({ kind, message: opts?.message, contact: opts?.contact, attach: opts?.attach !== false });
    for (const [k, v] of previews) if (v.until < now()) previews.delete(k);
    while (previews.size >= 10) previews.delete(previews.keys().next().value);
    const id = crypto.randomBytes(12).toString('hex');
    previews.set(id, { payload, until: now() + 10 * 60_000 });
    return { previewId: id, payload };
  }
  /** Sends exactly what a preview showed (one feedback message or one support report). */
  async function sendPreview(previewId) {
    if (!configured) throw new ReportError(409, offText, 'NOT_SET_UP');
    const p = previews.get(String(previewId || ''));
    if (!p || p.until < now()) throw new ReportError(409, 'The preview is too old: look at what will be sent again.');
    if (p.payload.anonymous !== Boolean(settings().anonymous)) throw new ReportError(409, '"Send anonymously" changed since the preview: look at what will be sent again.');
    takeManual(p.payload.kind);
    previews.delete(String(previewId));
    const r = await enqueue(p.payload);
    return { kind: p.payload.kind, ...r };
  }

  function start() {
    if (!configured) return;
    const every = (ms, fn) => { const t = setInterval(() => fn().catch(() => {}), ms); t.unref?.(); timers.push(t); };
    every(60_000, () => flush());
    every(3600_000, () => dailyIfDue());
    const t = setTimeout(() => { sendCrashes().catch(() => {}); dailyIfDue().catch(() => {}); }, 90_000);
    t.unref?.();
    timers.push(t);
    started = true;
    // ticks with sharing off send nothing (and keep the hour going for when it is on)
    scheduleHeartbeat(firstHeartbeatIn());
  }
  function stop() {
    for (const t of timers) { clearInterval(t); clearTimeout(t); }
    timers = [];
    started = false;
    if (hbTimer) timer.clear(hbTimer);
    hbTimer = null;
    hbNextAt = null;
  }

  return { configured, status, setSettings, preview, sendPreview, buildPayload, enqueue, flush, outbox, trimOutbox, noteCrash, recentCrashes, sendCrashes, dailyIfDue, sendHeartbeat, installId, start, stop, endpoint, remoteConfig };
}

// the heartbeat's fields with text in them (through the scrubber before normalizeHeartbeat)
const HEARTBEAT_TEXT = ['platform', 'arch', 'cpu', 'gpus', 'cars', 'convert'];
const HL = P.HEARTBEAT_LIMITS;
/**
 * Text as the protocol takes it (reportsProtocol.js isPlain), or null: letters
 * with accents lose them, other characters outside printable ASCII (and " and
 * \) go, runs of spaces become one, at most `max` characters, trimmed.
 */
function plainText(x, max) {
  if (typeof x !== 'string') return null;
  const t = x.normalize('NFKD').replace(/\s+/g, ' ').replace(/[^\x20\x21\x23-\x5b\x5d-\x7e]/g, '').replace(/ {2,}/g, ' ').trim().slice(0, max).trim();
  return t || null;
}
// a car's model: one of these names only (a code '3', 'Y', 'S', 'X' becomes its name)
const MODEL_NAMES = [...Object.values(CAR_MODELS), 'Cybertruck'];
function modelName(x) {
  const s = typeof x === 'string' ? x.trim() : '';
  if (Object.hasOwn(CAR_MODELS, s)) return CAR_MODELS[s];
  return MODEL_NAMES.find((m) => m.toLowerCase() === s.toLowerCase()) || null;
}
// a Tesla software version (2025.14.3.1, maybe with its build hash): nothing else
const FIRMWARE_RE = /^20\d\d\.\d{1,2}(?:\.\d{1,3}){0,3}(?: [0-9a-f]{4,12})?$/;
const firmwareText = (x) => { const t = plainText(x, HL.firmware); return t && FIRMWARE_RE.test(t) ? t : null; };
const countIn = (x, max) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.min(max, Math.round(Number(x))) : 0);

/**
 * The heartbeat block, exactly the protocol's fields (reportsProtocol.js
 * HEARTBEAT_FIELDS, and the HEARTBEAT_OPTIONAL ones this Manager always
 * fills in) from what the server counted: whole non-negative numbers,
 * yes/no, the overall health worked out from the counts, and plain text cut
 * to the protocol's lengths. Anything else the caller had is left out.
 */
function normalizeHeartbeat(h = {}) {
  const n = (x, max = Number.MAX_SAFE_INTEGER) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.min(max, Math.round(Number(x))) : 0);
  const warnings = n(h.health?.warnings, 1000);
  const problems = n(h.health?.problems, 1000);
  const known = Number.isFinite(h.freeBytes) && Number.isFinite(h.totalBytes) && h.totalBytes > 0;
  const total = known ? n(h.totalBytes) : null;
  return {
    uptimeSec: n(h.uptimeSec, 100 * 365 * 86400),
    health: { overall: P.healthOverall(warnings, problems), warnings, problems },
    vehicles: n(h.vehicles, 1000),
    footageBytes: n(h.footageBytes),
    recordings: n(h.recordings, 1e9),
    spaceSavedBytes: n(h.spaceSavedBytes),
    distanceKm: Number.isFinite(Number(h.distanceKm)) && Number(h.distanceKm) > 0 ? Math.round(Math.min(10_000_000, Number(h.distanceKm)) * 10) / 10 : 0,
    freeBytes: known ? Math.min(n(h.freeBytes), total) : null,
    totalBytes: total,
    converting: h.converting === true,
    jobsQueued: n(h.jobsQueued, 100_000),
    features: { can: h.features?.can === true, sentryUsbPaired: h.features?.sentryUsbPaired === true, gpu: h.features?.gpu === true },
    ...optionalHeartbeat(h)
  };
}
/** The optional fields (all of them; platform and arch only when known). */
function optionalHeartbeat(h) {
  const out = { footageSeconds: countIn(h.footageSeconds, HL.footageSeconds) };
  const platform = plainText(h.platform, HL.platform);
  const arch = plainText(h.arch, HL.arch);
  if (platform) out.platform = platform;
  if (arch) out.arch = arch;
  out.cpu = plainText(h.cpu, HL.cpu);
  out.gpus = (Array.isArray(h.gpus) ? h.gpus : []).map((g) => plainText(g, HL.gpu)).filter(Boolean).slice(0, HL.gpus);
  out.cars = (Array.isArray(h.cars) ? h.cars : []).slice(0, HL.cars).map((c) => ({ model: modelName(c?.model), firmware: firmwareText(c?.firmware) }));
  out.clips24h = { sentry: countIn(h.clips24h?.sentry, HL.clips), dashcam: countIn(h.clips24h?.dashcam, HL.clips) };
  const c = h.convert || {};
  const fps = Number(c.fps);
  out.convert = {
    fps: c.fps !== null && c.fps !== undefined && Number.isFinite(fps) && fps >= 0 ? Math.round(Math.min(HL.fps, fps) * 10) / 10 : null,
    encoder: plainText(c.encoder, HL.encoder), device: plainText(c.device, HL.device), api: plainText(c.api, HL.api), codec: plainText(c.codec, HL.codec)
  };
  out.crashes24h = countIn(h.crashes24h, HL.crashes);
  return out;
}

module.exports = { createReports, normalizeHeartbeat, plainText, defaultTransport, workerPow, ReportError, NOT_SET_UP, OUTBOX_MAX, OUTBOX_BYTES, OUTBOX_DAYS, MANUAL_PER_HOUR, MAX_BITS, HEARTBEAT_FIRST_MS, HEARTBEAT_EVERY_MS };
