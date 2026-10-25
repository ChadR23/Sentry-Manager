'use strict';

// Sentry Six Manager server: the Sentry Studio viewer and converter as a web app,
// plus file management (vehicles, footage, Recycle Bin, policies, jobs,
// notifications, settings, sign-in, update notices).
//
// Security, in short (README "Security" has the details):
//   - HTTPS on the same port; plain HTTP only redirects to it.
//   - Sign-in required; the first account needs the setup code from the log;
//     cookies are HttpOnly, SameSite=Strict, Secure + __Host- over HTTPS.
//   - Changes that could hand someone the shares or the server need the
//     password again (vehicle sources, certificates, deleting forever).
//   - State-changing requests need X-Requested-With and a matching Origin.
//   - Every file path is resolved through safePath's real-path guard.
//   - When supervised (the Docker image), this process runs as an
//     unprivileged user; the root supervisor only mounts shares and keeps
//     the HTTPS certificate authority.

process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';
// the database holds password hashes and SMB passwords: nothing we create is world-readable
process.umask(0o027);

const fs = require('fs');
const http = require('http');
const http2 = require('http2');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { Logger } = require('./log');
const { ManagerDB } = require('./db');
const { Auth } = require('./auth');
const { VehicleManager } = require('./vehicles');
const { Inventory } = require('./inventory');
const { RecycleBin, formatBytes } = require('./recycleBin');
const { Policies } = require('./policies');
const { Jobs, Notifications } = require('./activity');
const { ImageUpdates } = require('./imageUpdates');
const { Thumbnails } = require('./thumbnails');
const { detectGpus } = require('./gpu');
const { createSupport, MAX_MEDIA_BYTES } = require('./support');
const { createConverterHost } = require('./converterHost');
const { createStats } = require('./stats');
const { encoderBlock, jobProgress, RUNNING: CONVERTER_RUNNING } = require('./encoderStats');
const { parsePowerSettings, priceAt, rateNameAt, isCheapest, PriceError } = require('./powerPrice');
const { createConverterBridge } = require('./converterBridge');
const { hiddenPath, readDir, stat, sendMedia, readTextConfined } = require('./studioApi');
const { createRealGuard, isInside } = require('./safePath');
const { createLocalMounter, createIpcMounter } = require('./mounter');
const { VERSIONS, DEFAULT_VERSION, securitySummary } = require('./mountSpec');
const { TlsManager, localTlsSource, supervisorTlsSource, parseHostnames } = require('./tls');
const { Router, HttpError, sendJson, readJson, readRaw, serveFile } = require('./http');
const { createNodes } = require('./nodes');
const { createNodeWorker } = require('./nodeWorker');
const { createNodeBenchmark } = require('./nodeBenchmark');
const { run } = require('./proc');
const { Telemetry } = require('./telemetry');

const APP_ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const SRC = path.join(APP_ROOT, 'src');
const WEB = path.join(APP_ROOT, 'web');
const DATA = path.resolve(process.env.DATA_PATH || '/data');
const RUN_DIR = path.resolve(process.env.RUN_DIR || '/run/sentry-six-manager');
const FOOTAGE_ROOT = path.resolve(process.env.FOOTAGE_ROOT || '/footage');
const PORT = Number(process.env.PORT || 9000);
const HOST = process.env.HOST || '0.0.0.0';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const TLS_MODE = (process.env.TLS_MODE || 'auto').toLowerCase(); // auto | off
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const SUPERVISED = process.env.SENTRY_SUPERVISED === '1' && typeof process.send === 'function';
const TRUSTED_HOSTS = (process.env.TRUSTED_HOSTS || '').split(/[\s,]+/).filter(Boolean).map((h) => h.toLowerCase());

const CONVERTER_ACTIVE = new Set(['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing', 'paused', 'paused_network']);
const ITEM_DONE = new Set(['completed', 'skipped', 'failed', 'cancelled']);

// Pages may load scripts, styles, frames and data only from this server, and
// never run inline scripts. Styles allow inline attributes (both UIs set
// style="" in markup). The embedded Studio viewer additionally needs
// 'unsafe-eval' (its bundled protobuf.js builds the telemetry decoder with
// new Function) and map tiles; the shell and sign-in pages get neither.
const cspWith = ({ script = "'self'", img = "'self' data: blob:" }) => [
  "default-src 'self'",
  `script-src ${script}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src ${img}`,
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');
const CSP = cspWith({});
const STUDIO_CSP = cspWith({ script: "'self' 'unsafe-eval'", img: "'self' data: blob: https://*.google.com https://*.tile.openstreetmap.org" });
// The Encoder tab's page: the converter only (no telemetry decoder, no map),
// so it gets the plain policy.
const ENCODER_PAGE = '/studio/encoder.html';

function readBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'BUILD_INFO.json'), 'utf8'));
  } catch {
    return {};
  }
}

function studioHtml(html) {
  // Runs before any Studio script: marks web mode and installs window.electronAPI.
  const inject = '<meta name="color-scheme" content="dark">\n<script src="/web/webFlag.js"></script>\n<script src="/web/electronApiShim.js"></script>\n<script src="/web/studioTouch.js"></script>\n<link rel="stylesheet" href="/web/studioEmbed.css">';
  return html.replace(/<head([^>]*)>/i, (m) => `${m}\n${inject}`);
}

function encoderHtml(html) {
  // The same, without holding up the page's first paint (its loading
  // skeleton): the scripts are deferred (they still run before encoder.js, in
  // order) and the stylesheet is preloaded, then applied by encoder.js with
  // the page's own. No touch drags on this page.
  const inject = '<meta name="color-scheme" content="dark">\n<script src="/web/webFlag.js" defer></script>\n<script src="/web/electronApiShim.js" defer></script>\n<link rel="preload" href="/web/studioEmbed.css" as="style">';
  // The skeleton's stylesheet goes inline: it paints with the first bytes.
  let skeleton = null;
  try {
    skeleton = fs.readFileSync(path.join(WEB, 'encoderSkeleton.css'), 'utf8');
  } catch {
    // left as a link
  }
  return html.replace(/<head([^>]*)>/i, (m) => `${m}\n${inject}`)
    .replace('<link rel="stylesheet" href="/web/encoderSkeleton.css">', (link) => (skeleton === null || skeleton.includes('</') ? link : `<style>\n${skeleton}</style>`));
}

function isSecure(req) {
  if (req.socket?.encrypted) return true;
  return TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

/** The Host header, if it is a plain host[:port] (and trusted, when TRUSTED_HOSTS is set). */
function cleanHost(req) {
  // HTTP/2 sends the host as :authority
  const raw = String((TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host || req.headers[':authority'] || '').split(',')[0].trim();
  if (!/^[A-Za-z0-9.\-[\]:]{1,300}$/.test(raw)) return null;
  if (TRUSTED_HOSTS.length) {
    const name = raw.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!TRUSTED_HOSTS.includes(name)) return null;
  }
  return raw;
}

function securityHeaders(req, res, pathname = '') {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=(), fullscreen=(self)');
  res.setHeader('Content-Security-Policy', pathname.startsWith('/studio/') && pathname !== ENCODER_PAGE ? STUDIO_CSP : CSP);
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function confirmRequired() {
  return Object.assign(new HttpError(403, 'Enter your password to confirm this change.'), { code: 'CONFIRM_PASSWORD', expose: true });
}

async function main() {
  const logger = new Logger({ level: process.env.LOG_LEVEL || 'info', file: path.join(DATA, 'logs', 'manager.log') });
  logger.captureConsole();
  const log = logger.scope('server');
  fs.mkdirSync(DATA, { recursive: true });
  const buildInfo = readBuildInfo();
  const db = new ManagerDB(path.join(DATA, 'manager.db'));
  const auth = new Auth({ db, log: logger.scope('auth'), isSecure, setupFile: path.join(DATA, 'setup-code.txt') });
  auth.bootstrap();
  const jobs = new Jobs({ db });
  // a scan or a move to the Recycle Bin that a restart stopped: interrupted
  const stoppedJobs = jobs.interruptLeftovers();
  if (stoppedJobs) log.info(`${stoppedJobs} job(s) were stopped by the restart; Jobs shows them as interrupted`);
  const notes = new Notifications({ db });

  const mounter = SUPERVISED
    ? createIpcMounter({ channel: process, footageRoot: FOOTAGE_ROOT })
    : createLocalMounter({
      footageRoot: FOOTAGE_ROOT, credDir: RUN_DIR,
      uid: Number(process.env.PUID ?? process.getuid?.() ?? 0), gid: Number(process.env.PGID ?? process.getgid?.() ?? 0)
    });
  const folderRoots = [FOOTAGE_ROOT, ...(process.env.FOLDER_ROOTS || '').split(':').filter(Boolean)];
  // FOOTAGE_PATH comes from the container environment (trusted), not the UI
  if (process.env.FOOTAGE_PATH) folderRoots.push(process.env.FOOTAGE_PATH);
  const protectedDirs = [DATA, APP_ROOT, RUN_DIR];
  const vehicles = new VehicleManager({ db, footageRoot: FOOTAGE_ROOT, folderRoots, protectedDirs, logger, mounter });
  vehicles.bootstrapFromEnv();
  const inventory = new Inventory({ vehicles, db, log: logger.scope('inventory'), onChange: () => announce('inventory') });
  const thumbs = new Thumbnails({ dir: path.join(DATA, 'thumbnails'), ffmpegPath: FFMPEG });
  const telemetry = new Telemetry({ srcRoot: SRC, cacheDir: path.join(DATA, 'telemetry'), log: logger.scope('telemetry') });

  // ---- paths
  // Default place for converted copies ("keep originals" mode); EXTRA_ROOTS adds more.
  fs.mkdirSync(path.join(DATA, 'converted'), { recursive: true });
  const outputRoots = () => [path.join(DATA, 'converted'), ...(process.env.EXTRA_ROOTS || '').split(':').filter(Boolean)];
  const allowedRoots = () => [...vehicles.roots(), ...outputRoots()];
  const deny = () => [DATA, APP_ROOT, RUN_DIR, '/proc', '/sys', '/dev', '/etc', '/root', '/run', '/boot'];
  const allowed = createRealGuard(allowedRoots, { deny });
  const studioReadable = createRealGuard(() => [...allowedRoots(), path.join(DATA, 'thumbnails'), path.join(DATA, 'clip-thumbnails'), path.join(DATA, 'exports')], { deny });

  /** The vehicle whose footage contains this real path, and that root. */
  const vehicleForReal = (real) => {
    for (const v of vehicles.list()) {
      const root = vehicles.rootOf(v);
      let realRoot = root;
      try {
        realRoot = fs.realpathSync(root);
      } catch {
        // not reachable
      }
      if (isInside(real, realRoot)) return { vehicle: v, root: realRoot };
      if (isInside(real, root)) return { vehicle: v, root };
    }
    return null;
  };

  // ---- converter
  const converterJobs = new Map(); // job id -> latest snapshot
  const isBusy = (abs) => {
    for (const s of converterJobs.values()) {
      if (!CONVERTER_ACTIVE.has(s.state) || !s.config?.sourceRoot) continue;
      if ((s.items || []).some((i) => !ITEM_DONE.has(i.state) && i.relativePath && path.join(s.config.sourceRoot, i.relativePath) === abs)) return true;
    }
    return false;
  };
  const bin = new RecycleBin({ db, vehicles, inventory, jobs, log: logger.scope('bin'), isBusy });

  // ---- server stats (Overview > Server, the Encoder's Hardware panel):
  // sampled only while a page asks or a conversion runs
  const converterRunning = () => [...converterJobs.values()].some((s) => CONVERTER_RUNNING.has(s.state));
  let benchmarking = null; // the benchmark's energy token while it runs
  // Server alerts from before a restart: the new run raises them again if
  // they still hold (a stale one could otherwise never be cleared)
  db.resolvePrefix('server:');
  const statsLog = logger.scope('stats');
  const stats = createStats({
    dataDir: DATA,
    isBusy: () => converterRunning() || benchmarking !== null,
    readShares: () => [{ label: 'Data volume', path: DATA }, ...vehicles.list().map((v) => ({ label: v.name, path: vehicles.rootOf(v), vehicle: true, network: v.source?.type === 'smb' }))],
    // every running ffmpeg (a benchmark's too), to name processes and GPU clients
    activeEncodes: () => host.runtime?.activeEncodes?.() || [],
    ffmpegPath: FFMPEG,
    // costs are summed at the price of each moment (time-of-use plans)
    priceAt: (ms) => priceAt(db.get('power', null), ms),
    // where a job stands at each sample while its energy is counted (clips
    // and space per kWh count from where measuring began)
    jobProgress: (jobId) => (converterJobs.has(jobId) ? jobProgress(converterJobs.get(jobId)) : null),
    log: statsLog,
    onAlert: ({ key, level, message }) => {
      statsLog[level === 'error' ? 'error' : 'warn'](message);
      notes.raise({
        kind: 'server', level: level === 'error' ? 'critical' : 'warning', dedupeKey: `server:${key}`,
        title: message, message: 'Overview > Server shows the live numbers.'
      });
    },
    onAlertClear: ({ key }) => {
      statsLog.info(`Back to normal: ${key}`);
      notes.resolve(`server:${key}`);
    },
    // CPU power right away when sampling starts (the keepalive below follows)
    onSampling: (on) => {
      if (on && SUPERVISED && process.connected) process.send({ type: 'rapl', on: true }, () => {});
    }
  });
  // CPU power: the root supervisor reads the energy counters while asked
  let statsAskedAt = 0;
  const raplKeepalive = setInterval(() => {
    if (SUPERVISED && process.connected && (stats.sampling || Date.now() - statsAskedAt < 20_000)) process.send({ type: 'rapl', on: true }, () => {});
  }, 10_000);
  raplKeepalive.unref();
  let statsJob = null;
  const policies = new Policies({ db, vehicles, inventory, bin, log: logger.scope('policies') });

  // Nodes: other servers that encode for this one (server/nodes.js)
  const nodes = createNodes({ db, log: logger.scope('nodes'), audit: logger.scope('audit') });
  const host = createConverterHost({
    remoteNodes: {
      list: () => nodes.list(),
      encode: (request) => nodes.encode(request),
      // a node's row under Encoder > Parallel conversions sets its clips at once
      setSlots: (device, slots) => nodes.setSlots(String(device).replace(/^node:/, ''), slots),
      // each node's vehicles, as the footage folders automatic conversion uses
      priorities: () => Object.fromEntries(Object.entries(nodes.carLists()).map(([device, ids]) => [device, ids.map((id) => {
        const v = vehicles.list().find((x) => x.id === id);
        try { return v ? vehicles.studioRoot(v) : null; } catch (_) { return null; }
      }).filter(Boolean)]))
    },
    dataDir: path.join(DATA, 'converter'),
    tempDir: path.join(DATA, 'converter-temp'),
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    log: logger.scope('converter'),
    // automatic conversion "off-peak only" follows the plan in Settings
    isCheapNow: (ms) => isCheapest(db.get('power', null), ms),
    // the benchmark measures energy per setting with the stats engine
    // (one energy account, 'benchmark', measured as the difference across
    // each level, so benchmarks never pile up entries)
    powerMeter: {
      start: () => {
        const before = stats.energy().byJob?.benchmark || { wh: 0, seconds: 0 };
        benchmarking = { wh: before.wh, seconds: before.seconds, at: Date.now() };
        stats.markJob('benchmark');
        return benchmarking;
      },
      stop: (token) => {
        if (benchmarking === token) {
          stats.markJob(statsJob); // a conversion's own count carries on
          benchmarking = null;
        }
        // the account's average watts over the level's own time (its energy
        // steps with the 2 s samples, coarse for a level of a few seconds)
        const after = stats.energy().byJob?.benchmark;
        const wh = after ? after.wh - token.wh : 0;
        const seconds = after ? after.seconds - token.seconds : 0;
        if (!(wh > 0 && seconds > 0)) return null;
        const avgW = (wh * 3600) / seconds;
        const elapsed = (Date.now() - token.at) / 1000;
        return { wh: elapsed > 0 ? (avgW * elapsed) / 3600 : wh, avgW };
      }
    }
  });
  let bridge = null;
  let clipThumbs = null;

  const updates = new ImageUpdates({
    db, log: logger.scope('updates'), buildInfo, notes, enabled: !/^(off|false|0|no)$/i.test(process.env.UPDATE_CHECK || '')
  });
  updates.announce();
  // left over from the old in-app updater: updates now come with the image
  fs.promises.rm(path.join(DATA, 'app'), { recursive: true, force: true }).catch(() => {});

  // ---- HTTPS
  const tlsSource = TLS_MODE === 'off' ? null : SUPERVISED && process.env.SENTRY_TLS_DIR
    ? supervisorTlsSource({ dir: process.env.SENTRY_TLS_DIR, channel: process })
    : localTlsSource(new TlsManager({
      dir: path.join(DATA, 'tls'), log: logger.scope('tls'), hostnames: parseHostnames(process.env.TLS_HOSTNAMES || ''),
      certFile: process.env.TLS_CERT_FILE || null, keyFile: process.env.TLS_KEY_FILE || null
    }));

  // Nodes > Benchmark: sample clips lent to a node, timed from here
  const nodeBench = createNodeBenchmark({
    nodes, vehicles, run, ffprobePath: FFPROBE, workDir: path.join(DATA, 'converter-temp', 'node-benchmark'), log: logger.scope('nodes')
  });

  // Nodes, the other way: a main server's clips encoded here (server/nodeWorker.js).
  // Needs this server's own HTTPS: the main pins its certificate.
  const nodeWorker = createNodeWorker({
    db, log: logger.scope('nodes'), audit: logger.scope('audit'),
    authority: () => tlsSource?.caPem() || null,
    workDir: path.join(DATA, 'node-work'), ffmpegPath: FFMPEG,
    runtime: () => host.runtime
  });

  // ---- live events to the browser
  const clients = new Set();
  const MAX_EVENT_CLIENTS = 200;
  let converterStreams = 0; // open /api/converter/events streams
  const pending = new Set();
  let flushTimer = null;
  const announce = (topic) => {
    pending.add(topic);
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const topics = [...pending];
      pending.clear();
      for (const res of clients) res.write(`event: changed\ndata: ${JSON.stringify({ topics })}\n\n`);
    }, 400);
  };
  jobs.on('changed', () => announce('jobs'));
  notes.on('changed', () => announce('notifications'));
  vehicles.on('changed', () => announce('vehicles'));
  vehicles.on('status', (id) => {
    const v = vehicles.get(id);
    if (v) notes.syncShare(v, vehicles.share(id)?.status());
    announce('vehicles');
  });
  vehicles.on('health', (id, healthy) => {
    if (!healthy) return;
    bin.reconcile(id).catch((err) => log.warn(`Recycle Bin check of ${id}: ${err.message}`))
      .then(() => inventory.scan(id)).then(() => announce('inventory'), () => {});
  });

  // ---- routes
  const r = new Router();
  const vehicleOr404 = (id) => {
    const v = vehicles.get(id);
    if (!v) throw new HttpError(404, 'No such vehicle.');
    return v;
  };
  const requireConfirmed = (req) => {
    if (!auth.recentlyConfirmed(req)) throw confirmRequired();
  };
  const vehicleSummary = (v) => ({
    ...vehicles.publicView(v),
    security: v.source.type === 'smb' ? securitySummary({ encrypt: v.source.encrypt !== false, version: v.source.version }) : null,
    inventory: inventory.totals(v.id),
    scanning: Boolean(inventory.get(v.id)?.scanning),
    binBytes: bin.binBytes(v.id),
    binItems: db.binItems(v.id).length,
    policy: policies.get(v.id)
  });
  // Who the throttle and the audit log count as the client. Behind a trusted
  // reverse proxy every request arrives from the proxy's own address, so the
  // real client is the first X-Forwarded-For hop (the proxy sets it); without
  // TRUST_PROXY that header is attacker-controlled and ignored. Keying on the
  // real client means one attacker cannot lock out everyone behind the proxy.
  const clientKey = (req) => {
    if (TRUST_PROXY) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || '?';
  };
  // who did what, for the log: security-relevant actions only, never secrets
  const audit = logger.scope('audit');
  const by = (req, user) => `${user || 'someone'} from ${clientKey(req)}`;
  const describeSource = (src) => (src?.type === 'path' ? `folder ${src.path}` : `SMB ${src?.share} as ${src?.username} (SMB ${src?.version}, ${src?.encrypt === false ? 'signed only' : 'encrypted'})`);

  // the certificate's fingerprint lets the sign-in page show it (to compare with the log)
  const certFingerprint = () => {
    try {
      return tlsSource?.status()?.certificate?.fingerprint || null;
    } catch {
      return null;
    }
  };
  r.add('GET', '/api/auth/me', (req) => ({ user: auth.user(req), needsSetup: auth.needsSetup(), secure: isSecure(req), fingerprint: req.socket?.encrypted ? certFingerprint() : null }), { public: true });
  // one password check at a time per throttle key (auth.attempt)
  const guarded = async (keys, check) => {
    try {
      return await auth.attempt(keys, check);
    } catch (err) {
      if (err.status === 429) throw new HttpError(429, err.message);
      throw err;
    }
  };
  r.add('POST', '/api/auth/login', async (req, res, { body }) => {
    // per address, and per account from that address: wrong guesses from
    // elsewhere never lock the owner out
    const keys = [clientKey(req), `user:${String(body?.username || '').toLowerCase().slice(0, 64)}@${clientKey(req)}`];
    const wait = Math.max(...keys.map((k) => auth.throttled(k)));
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} s.`);
    if (!(await guarded(keys, () => auth.check(body?.username, body?.password)))) {
      keys.forEach((k) => auth.noteFailure(k));
      audit.warn(`Sign-in failed for "${String(body?.username || '').slice(0, 64)}" from ${clientKey(req)}`);
      throw new HttpError(401, 'Wrong user name or password.');
    }
    keys.forEach((k) => auth.noteSuccess(k));
    auth.login(req, res, body.username);
    audit.info(`Signed in: ${by(req, body.username)}`);
    return { ok: true };
  }, { public: true });
  r.add('POST', '/api/auth/setup', async (req, res, { body }) => {
    const key = `setup:${clientKey(req)}`;
    const wait = auth.throttled(key);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} s.`);
    try {
      auth.setup(String(body?.username || ''), String(body?.password || ''), body?.code);
    } catch (err) {
      if (err.status === 403) {
        auth.noteFailure(key);
        audit.warn(`Account setup with a wrong setup code from ${clientKey(req)}`);
      }
      throw err;
    }
    auth.login(req, res, body.username);
    audit.info(`Account "${body.username}" created with the setup code: ${by(req, body.username)}`);
    return { ok: true };
  }, { public: true });
  r.add('POST', '/api/auth/logout', (req, res, { user }) => {
    auth.logout(req, res);
    audit.info(`Signed out: ${by(req, user)}`);
    return { ok: true };
  });
  r.add('POST', '/api/auth/confirm', async (req, res, { body, user }) => {
    const key = `confirm:${user}`;
    const wait = auth.throttled(key);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} s.`);
    if (!(await guarded([key], () => auth.confirm(req, user, body?.password)))) {
      auth.noteFailure(key);
      audit.warn(`Password confirmation failed: ${by(req, user)}`);
      throw new HttpError(401, 'That password is not right.');
    }
    auth.noteSuccess(key);
    audit.info(`Password confirmed for sensitive changes: ${by(req, user)}`);
    return { ok: true };
  });
  r.add('POST', '/api/auth/password', async (req, res, { body, user }) => {
    // the same throttle as confirmation: a stolen session must not guess the
    // password here instead
    const key = `confirm:${user}`;
    const wait = auth.throttled(key);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} s.`);
    if (!(await guarded([key], () => auth.check(user, body?.current)))) {
      auth.noteFailure(key);
      audit.warn(`Password change with a wrong current password: ${by(req, user)}`);
      throw new HttpError(401, 'The current password is wrong.');
    }
    auth.noteSuccess(key);
    auth.setPassword(user, String(body?.next || ''));
    db.deleteSessionsFor(user);
    auth.forgetConfirmations();
    auth.login(req, res, user);
    audit.info(`Password changed (all other sessions signed out): ${by(req, user)}`);
    return { ok: true };
  });

  r.add('GET', '/api/system', async (req) => ({
    version: buildInfo,
    converter: host.runtime ? { ready: true, capabilities: host.runtime.capabilities } : { ready: false, error: host.lastError?.code || null },
    nativeHelper: host.helperAvailable,
    gpu: await detectGpus(),
    dataFree: await fs.promises.statfs(DATA).then((s) => Number(s.bavail) * Number(s.bsize)).catch(() => null),
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    security: {
      https: isSecure(req), tlsMode: TLS_MODE, supervised: SUPERVISED,
      runningAsRoot: process.getuid?.() === 0, uid: process.getuid?.() ?? null
    },
    smbVersions: VERSIONS,
    smbDefaultVersion: DEFAULT_VERSION
  }));

  r.add('GET', '/api/security', (req) => {
    let tls = null;
    try {
      tls = tlsSource ? tlsSource.status() : null;
    } catch (err) {
      tls = { error: err.message };
    }
    return {
      https: isSecure(req), tlsMode: TLS_MODE, trustProxy: TRUST_PROXY, tls,
      supervised: SUPERVISED, runningAsRoot: process.getuid?.() === 0,
      currentHost: cleanHost(req), confirmed: auth.recentlyConfirmed(req)
    };
  });
  r.add('PUT', '/api/security/hostnames', async (req, res, { body, user }) => {
    requireConfirmed(req);
    if (!tlsSource) throw new HttpError(409, 'HTTPS is turned off (TLS_MODE=off).');
    const list = parseHostnames(Array.isArray(body?.hostnames) ? body.hostnames.join(',') : String(body?.hostnames || ''));
    const out = await tlsSource.setHostnames(list);
    if (httpsServer) httpsServer.setSecureContext({ key: out.key, cert: out.cert });
    audit.info(`HTTPS certificate names set to [${list.join(', ')}]${out.caReplaced ? ' (new certificate authority)' : ''}: ${by(req, user)}`);
    return { ok: true, caReplaced: Boolean(out.caReplaced), tls: tlsSource.status() };
  });
  r.add('GET', '/api/security/ca.crt', (req, res) => {
    const pem = tlsSource?.caPem();
    if (!pem) throw new HttpError(404, 'This server uses its own certificate; there is no local certificate authority.');
    res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="sentry-six-manager-ca.crt"', 'Cache-Control': 'no-store' });
    res.end(pem);
    return undefined;
  });

  // Overview > Logs: the newest lines first; problems (warnings and errors)
  // unless everything is asked for. The download is the whole kept file.
  r.add('GET', '/api/logs', (req, res, { query }) => ({
    lines: logger.recent(Math.min(1000, Number(query.limit) || 300), { minLevel: query.level === 'all' ? 'debug' : 'warn' }).reverse()
  }));
  // Settings > Support: the Sentry Six support chat, relayed (server/support.js)
  let supportUploading = false;
  const support = createSupport({ db, log: audit, buildInfo, detectGpus, recentLogs: () => logger.recent(150, { minLevel: 'warn' }) });
  r.add('GET', '/api/support', () => support.status());
  r.add('GET', '/api/support/messages', (req, res, { query }) => support.messages({ since: query.since }));
  r.add('POST', '/api/support/message', (req, res, { body }) => support.send({ message: body?.message, includeDiagnostics: body?.includeDiagnostics === true }));
  r.add('POST', '/api/support/read', () => support.read());
  r.add('POST', '/api/support/close', () => support.close());
  r.add('GET', '/api/support/attachment', (req, res, { query }) => support.attachment(res, query.u));
  // Clear: the logs move into logs/archive/ (never deleted); each archive can
  // be downloaded later.
  r.add('POST', '/api/logs/clear', (req, res, { user }) => {
    const name = logger.archive();
    audit.info(`Logs cleared${name ? ` (earlier lines kept in logs/archive/${name})` : ''}: ${by(req, user)}`);
    return { ok: true, archived: name };
  });
  r.add('GET', '/api/logs/archive', () => ({ archives: logger.archives() }));
  r.add('GET', '/api/logs/archive/:name', async (req, res, { params }) => {
    const text = await logger.archiveText(params.name);
    if (text === null) throw new HttpError(404, 'No such archived log.');
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="sentry-six-manager-${params.name.slice('manager-'.length)}"`
    });
    res.end(text);
    return undefined;
  });
  r.add('GET', '/api/logs/download', async (req, res) => {
    const text = await logger.fileText();
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="sentry-six-manager-${new Date().toISOString().slice(0, 10)}.log"`
    });
    res.end(text);
    return undefined;
  });

  r.add('GET', '/api/vehicles', () => ({ vehicles: vehicles.list().map(vehicleSummary) }));
  // ---- Nodes (server/nodes.js, server/nodeWorker.js)
  r.add('GET', '/api/nodes', async () => ({
    nodes: await nodes.overview(),
    worker: { ...nodeWorker.status(), available: Boolean(tlsSource), name: os.hostname() }
  }));
  r.add('POST', '/api/nodes', async (req, res, { body, user }) => {
    // it will be sent footage: like adding a vehicle, the password again
    requireConfirmed(req);
    try {
      const node = await nodes.add({ address: body?.address, code: body?.code });
      audit.info(`Node "${node.name}" paired at ${node.host}:${node.port}: ${by(req, user)}`);
      return { ok: true, id: node.id };
    } catch (err) {
      throw new HttpError(err.status && err.status < 500 ? err.status : 502, err.message);
    }
  });
  r.add('GET', '/api/nodes/:id/benchmark', (req, res, { params }) => ({ benchmark: nodeBench.view(params.id) }));
  r.add('POST', '/api/nodes/:id/benchmark', (req, res, { params, body, user }) => {
    if (!nodes.has(params.id)) throw new HttpError(404, 'No such node.');
    const started = nodeBench.start(params.id, { codec: body?.codec === 'av1' ? 'av1' : 'h265' });
    audit.info(`Node benchmark started for ${params.id}: ${by(req, user)}`);
    return { benchmark: started };
  });
  r.add('DELETE', '/api/nodes/:id/benchmark', (req, res, { params }) => ({ benchmark: nodeBench.cancel(params.id) }));
  r.add('POST', '/api/nodes/:id/slots', async (req, res, { params, body, user }) => {
    try {
      await nodes.setSlots(params.id, Number(body?.slots));
    } catch (err) {
      throw new HttpError(err.status && err.status < 500 ? err.status : 502, err.message);
    }
    audit.info(`Node ${params.id} set to ${Number(body?.slots)} clips at once: ${by(req, user)}`);
    return { ok: true };
  });
  r.add('PUT', '/api/nodes/:id', (req, res, { params, body, user }) => {
    if (!nodes.has(params.id)) throw new HttpError(404, 'No such node.');
    const out = { ok: true };
    try {
      if (body?.name !== undefined) {
        const renamed = nodes.rename(params.id, body.name);
        audit.info(`Node "${renamed.previous}" renamed "${renamed.name}": ${by(req, user)}`);
        out.name = renamed.name;
      }
      if (body?.cars !== undefined) {
        const known = new Set(vehicles.list().map((v) => v.id));
        if (!Array.isArray(body.cars) || body.cars.some((id) => !known.has(id))) throw new HttpError(400, 'Unknown vehicle.');
        out.cars = nodes.setCars(params.id, body.cars);
        audit.info(`Node ${params.id} converts first for: ${out.cars.join(', ') || 'no vehicle in particular'}: ${by(req, user)}`);
      }
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(err.status || 400, err.message);
    }
    return out;
  });
  r.add('DELETE', '/api/nodes/:id', (req, res, { params, user }) => {
    const node = nodes.remove(params.id);
    if (!node) throw new HttpError(404, 'No such node.');
    audit.info(`Node "${node.name}" removed: ${by(req, user)}`);
    return { ok: true };
  });
  r.add('POST', '/api/nodes/worker', (req, res, { body, user }) => {
    if (!tlsSource) throw new HttpError(409, 'This server runs without its own HTTPS (TLS_MODE=off), so it cannot be a node.');
    const status = nodeWorker.setEnabled(body?.enabled === true, body?.slots, body?.use);
    audit.info(`Node mode ${status.enabled ? 'on' : 'off'} (${status.slots} clips at once, encode with ${status.use}): ${by(req, user)}`);
    return status;
  });
  r.add('POST', '/api/nodes/worker/pair', (req, res, { user }) => {
    if (!tlsSource) throw new HttpError(409, 'This server runs without its own HTTPS (TLS_MODE=off), so it cannot be a node.');
    // the code lets another server send this one work: the password again
    requireConfirmed(req);
    audit.info(`Node pairing code shown: ${by(req, user)}`);
    return nodeWorker.startPairing();
  });
  r.add('DELETE', '/api/nodes/worker/pair', () => nodeWorker.cancelPairing());
  r.add('DELETE', '/api/nodes/worker/mains/:id', (req, res, { params, user }) => {
    const main = nodeWorker.revoke(params.id);
    if (!main) throw new HttpError(404, 'No such main server.');
    audit.info(`Main server "${main.name}" can no longer use this node: ${by(req, user)}`);
    return nodeWorker.status();
  });

  r.add('POST', '/api/vehicles', (req, res, { body, user }) => {
    requireConfirmed(req);
    const v = vehicles.add(body || {});
    audit.info(`Vehicle "${v.name}" (${v.id}) added, ${describeSource(v.source)}: ${by(req, user)}`);
    return vehicleSummary(v);
  });
  r.add('PUT', '/api/vehicles/:id', async (req, res, { params, body, user }) => {
    const before = vehicleOr404(params.id);
    if (body?.source !== undefined) requireConfirmed(req);
    const v = await vehicles.update(params.id, body || {});
    if (JSON.stringify(before.source) !== JSON.stringify(v.source)) {
      const what = before.source.type === v.source.type && before.source.share === v.source.share && before.source.path === v.source.path
        ? describeSource(v.source) : `${describeSource(before.source)} -> ${describeSource(v.source)}`;
      audit.info(`Vehicle "${v.name}" (${v.id}) footage source changed: ${what}${before.source.password !== v.source.password ? ', new password' : ''}: ${by(req, user)}`);
    } else if (before.name !== v.name || before.timezone !== v.timezone) {
      audit.info(`Vehicle ${v.id} renamed or time zone changed: ${by(req, user)}`);
    }
    return vehicleSummary(v);
  });
  r.add('DELETE', '/api/vehicles/:id', async (req, res, { params, user }) => {
    requireConfirmed(req);
    const v = vehicleOr404(params.id);
    await vehicles.remove(params.id);
    audit.info(`Vehicle "${v.name}" (${v.id}) removed (its footage is untouched): ${by(req, user)}`);
    return { ok: true };
  });
  r.add('POST', '/api/vehicles/:id/reconnect', async (req, res, { params }) => {
    vehicleOr404(params.id);
    const s = vehicles.share(params.id);
    return { share: s ? await s.reconnect() : null };
  });
  r.add('POST', '/api/vehicles/:id/scan', async (req, res, { params }) => {
    const v = vehicleOr404(params.id);
    const jobId = jobs.start({ type: 'scan', vehicleId: v.id, title: `Refresh inventory of ${v.name}` });
    inventory.scan(v.id)
      .then((e) => jobs.finish(jobId, { detail: `${e.recordings.length} recordings, ${e.files.size} files${e.errorCount ? `, ${e.errorCount} unreadable` : ''}` }))
      .catch((err) => jobs.finish(jobId, { status: 'failed', detail: err.message }))
      .finally(() => announce('inventory'));
    return { ok: true, jobId };
  });

  const publicRecording = (rec) => {
    const { files, clipRels, ...rest } = rec;
    return { ...rest, encoded: inventory.encoded(rec.vehicleId, rec) };
  };
  const filtered = (vehicleId, query) => {
    let list = inventory.get(vehicleId)?.recordings || [];
    if (query.category && query.category !== 'all') list = list.filter((x) => x.category === query.category);
    if (query.date) list = list.filter((x) => x.day === query.date);
    return list;
  };
  // Footage by day: the day cards (their recordings come from /recordings?date=)
  r.add('GET', '/api/vehicles/:id/days', (req, res, { params, query }) => {
    vehicleOr404(params.id);
    const inv = inventory.get(params.id);
    const days = inventory.days(params.id, filtered(params.id, query));
    const offset = Math.max(0, Number(query.offset) || 0);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 30));
    return {
      total: days.length, recordings: days.reduce((n, d) => n + d.recordings, 0), offset, limit,
      scannedAt: inv?.scannedAt || null, scanning: Boolean(inv?.scanning), error: inv?.lastError || null,
      dates: [...new Set((inv?.recordings || []).map((x) => x.day))].sort().reverse(),
      days: days.slice(offset, offset + limit)
    };
  });
  // "Delete this day" / "Delete through this date": the recordings of that day
  // (or that day and every older one) go to the Recycle Bin, protected ones
  // stay. preview: true only counts them for the confirmation.
  r.add('POST', '/api/vehicles/:id/trash-days', async (req, res, { params, body }) => {
    const v = vehicleOr404(params.id);
    const day = String(body?.day || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, 'Choose a day.');
    const list = filtered(v.id, { category: body?.category }).filter((x) => (body?.through ? x.day <= day : x.day === day));
    const movable = list.filter((x) => !x.protected);
    const summary = {
      recordings: movable.length, bytes: movable.reduce((n, x) => n + x.bytes, 0), protected: list.length - movable.length,
      days: new Set(movable.map((x) => x.day)).size, oldest: movable.length ? movable.reduce((a, x) => (x.day < a ? x.day : a), day) : null
    };
    if (body?.preview === true || !movable.length) return { ...summary, started: false };
    // a big batch takes a while on a share: it runs as a job (bin.trash starts one)
    bin.trash(v.id, movable.map((x) => x.id)).catch((err) => log.warn(`Moving ${v.name}'s footage to the Recycle Bin failed: ${err.message}`))
      .finally(() => {
        announce('inventory');
        announce('bin');
      });
    return { ...summary, started: true };
  });
  r.add('GET', '/api/vehicles/:id/recordings', (req, res, { params, query }) => {
    vehicleOr404(params.id);
    const inv = inventory.get(params.id);
    let list = filtered(params.id, query);
    if (query.protected === '1') list = list.filter((x) => x.protected);
    const offset = Math.max(0, Number(query.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 100));
    return {
      total: list.length, offset, limit, scannedAt: inv?.scannedAt || null, scanning: Boolean(inv?.scanning), error: inv?.lastError || null,
      dates: [...new Set((inv?.recordings || []).map((x) => x.day))].sort().reverse(),
      recordings: list.slice(offset, offset + limit).map(publicRecording)
    };
  });
  // a clip's telemetry records for the viewer (server/telemetry.js)
  r.add('GET', '/api/telemetry', async (req, res, { query }) => {
    const real = await studioReadable.resolve(String(query.path || ''));
    if (!real || hiddenPath(real)) throw new HttpError(403, 'Outside the vehicle shares.');
    const { key, body } = await telemetry.forFile(real);
    const etag = `"${key}"`;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-cache', ETag: etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return undefined;
    }
    const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    res.writeHead(200, { ...headers, ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
    res.end(gzip ? zlib.gzipSync(body) : body);
    return undefined;
  });
  r.add('GET', '/api/vehicles/:id/recordings/:rid', async (req, res, { params }) => {
    const v = vehicleOr404(params.id);
    const rec = inventory.recording(v.id, params.rid);
    if (!rec) throw new HttpError(404, 'Recording not found (it may have moved; refresh the inventory).');
    const root = vehicles.rootOf(v);
    // codec per clip (h264 = not encoded yet, null = not checked yet), so the
    // page can tell which clips of a recording still need converting
    const codecs = inventory.codecs(v.id);
    const files = rec.files.map((rel) => ({
      rel, path: path.join(root, rel), size: inventory.get(v.id).files.get(rel)?.size ?? null,
      ...(/\.mp4$/i.test(rel) ? { codec: codecs.get(rel)?.codec ?? null } : {})
    }));
    return { ...publicRecording(rec), root, folderPath: path.join(root, rec.folder), files, event: await inventory.eventInfo(v.id, rec) };
  });
  r.add('GET', '/api/vehicles/:id/recordings/:rid/thumbnail', async (req, res, { params }) => {
    const v = vehicleOr404(params.id);
    const rec = inventory.recording(v.id, params.rid);
    if (!rec) throw new HttpError(404, 'Not found');
    const root = vehicles.rootOf(v);
    const source = rec.thumbRel ? path.join(root, rec.thumbRel) : rec.frontRel ? path.join(root, rec.frontRel) : null;
    const real = source && await allowed.resolve(source);
    if (!real) throw new HttpError(404, 'No thumbnail');
    const file = rec.thumbRel ? real : await thumbs.forClip(real);
    if (!file) throw new HttpError(404, 'No thumbnail');
    await sendMedia(req, res, file, studioReadable.fdInside);
    return undefined;
  });
  r.add('POST', '/api/vehicles/:id/protect', async (req, res, { params, body }) => {
    const v = vehicleOr404(params.id);
    const on = body?.protected !== false;
    const recs = (Array.isArray(body?.ids) ? body.ids : []).map((id) => inventory.recording(v.id, id)).filter(Boolean);
    await bin.setProtected(v.id, recs.flatMap((x) => x.files), on);
    inventory.rebuild(v.id);
    announce('inventory');
    return { ok: true, count: recs.length };
  });
  r.add('POST', '/api/vehicles/:id/trash', async (req, res, { params, body }) => {
    vehicleOr404(params.id);
    const out = await bin.trash(params.id, Array.isArray(body?.ids) ? body.ids : []);
    announce('inventory');
    announce('bin');
    return out;
  });

  r.add('GET', '/api/bin', (req, res, { query }) => ({ items: bin.list(query.vehicle || null) }));
  r.add('POST', '/api/bin/:item/restore', async (req, res, { params }) => {
    const out = await bin.restore(params.item);
    announce('bin');
    announce('inventory');
    return out;
  });
  r.add('POST', '/api/bin/:item/delete', async (req, res, { params, body, user }) => {
    if (body?.confirm !== true) throw new HttpError(400, 'Confirm permanent deletion.');
    requireConfirmed(req);
    const item = db.binItem(params.item);
    const out = await bin.deleteForever(params.item);
    audit.info(`Deleted forever from the Recycle Bin: ${item?.label || params.item} (${formatBytes(out.bytes)}): ${by(req, user)}`);
    announce('bin');
    return out;
  });
  r.add('POST', '/api/bin/empty', async (req, res, { body, user }) => {
    if (body?.confirm !== true) throw new HttpError(400, 'Confirm emptying the Recycle Bin.');
    requireConfirmed(req);
    if (body?.vehicle) vehicleOr404(body.vehicle);
    const out = await bin.empty(body?.vehicle || null);
    audit.info(`Recycle Bin emptied${body?.vehicle ? ` for ${body.vehicle}` : ''}: ${out.deleted} item(s), ${formatBytes(out.bytes)}: ${by(req, user)}`);
    announce('bin');
    return out;
  });

  r.add('GET', '/api/vehicles/:id/policy', (req, res, { params }) => ({ policy: policies.get(vehicleOr404(params.id).id), preview: policies.preview(params.id) }));
  r.add('PUT', '/api/vehicles/:id/policy', (req, res, { params, body }) => {
    const policy = policies.set(params.id, body || {});
    return { policy, preview: policies.preview(params.id) };
  });
  r.add('POST', '/api/vehicles/:id/policy/run', async (req, res, { params }) => {
    vehicleOr404(params.id);
    const out = await policies.run(params.id);
    announce('inventory');
    announce('bin');
    return out;
  });

  r.add('GET', '/api/jobs', (req, res, { query }) => ({
    jobs: jobs.list({ vehicleId: query.vehicle || undefined, limit: Math.min(500, Number(query.limit) || 200) })
      .map((j) => (j.result?.energy ? { ...j, energy: { wh: j.result.energy.wh, avgW: j.result.energy.avgW, cost: j.result.energy.cost ?? null } } : j))
  }));
  // Jobs > Clear jobs: the finished jobs (done, failed, cancelled,
  // interrupted) of the vehicle the page shows, and those of no vehicle, as
  // the list shows them, leave it. Running ones stay, and so does every
  // conversion the converter still has going (waiting or paused) whatever
  // its row says. Only the list changes: the converter's job files, which a
  // paused or interrupted conversion resumes from, are never touched.
  // The page's request only: { vehicle, preview: true } counts them for the
  // confirmation, { vehicle, confirm: true } clears them. vehicle is a
  // vehicle's id, or null for every vehicle (a server with none yet, where
  // the list shows them all); anything else is refused, never read as
  // "every vehicle".
  r.add('POST', '/api/jobs/clear', (req, res, { body, user }) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Say which jobs to clear.');
    const { vehicle = null, preview = false } = body;
    if (vehicle !== null && (typeof vehicle !== 'string' || !vehicle)) throw new HttpError(400, 'Choose a vehicle, or none for every vehicle.');
    if (typeof preview !== 'boolean') throw new HttpError(400, 'preview is true or false.');
    if (!preview && body.confirm !== true) throw new HttpError(400, 'Confirm clearing the finished jobs.');
    const vehicleId = vehicle === null ? null : vehicleOr404(vehicle).id;
    // rows of conversions the converter no longer runs get their real end first
    settleConversionRows();
    const keepExternal = [...converterJobs.values()].filter((s) => CONVERTER_ACTIVE.has(s.state)).map((s) => `converter:${s.id}`);
    if (preview) return { jobs: jobs.finished({ vehicleId, keepExternal }) };
    const cleared = jobs.clear({ vehicleId, keepExternal });
    audit.info(`Jobs cleared: ${cleared} finished job(s)${vehicleId ? ` of ${vehicleId}` : ''}: ${by(req, user)}`);
    return { cleared };
  });

  /**
   * A conversion's row on Jobs follows the converter's job, but a job the
   * converter no longer has (discarded, set aside, from an older version) or
   * one that ended while its row was not told stayed "running" for good, and
   * Clear jobs could never take it off. Once the converter has listed its
   * jobs, such a row gets the job's real end, or "interrupted" when the
   * converter no longer has it. Rows of jobs it still runs or holds paused
   * are left alone.
   */
  let converterListed = false;
  function settleConversionRows() {
    if (!converterListed) return 0;
    let n = 0;
    for (const row of db.jobs({ limit: 500 })) {
      if (row.type !== 'conversion' || row.status !== 'running' || !String(row.externalId || '').startsWith('converter:')) continue;
      const s = converterJobs.get(row.externalId.slice('converter:'.length));
      if (s && CONVERTER_ACTIVE.has(s.state)) continue;
      if (s) mirrorConverterJob(s);
      else jobs.finish(row.id, { status: 'interrupted', detail: `${row.detail ? `${row.detail} · ` : ''}the converter no longer has this job` });
      n++;
    }
    if (n) log.info(`Jobs: ${n} conversion row(s) the converter no longer runs were settled`);
    return n;
  }

  // Overview > Server and the Encoder's Hardware panel
  r.add('GET', '/api/stats', () => {
    statsAskedAt = Date.now();
    stats.touch();
    const snapshot = stats.snapshot();
    const power = db.get('power', null);
    const now = Date.now();
    const priceNow = priceAt(power, now);
    return {
      ...snapshot,
      price: priceNow === null ? null : { currency: power.currency, mode: power.mode, now: priceNow, rate: rateNameAt(power, now) },
      // the job's own clips (a running benchmark's are left out)
      encoder: encoderBlock({
        snapshot, jobs: converterJobs, workers: host.runtime?.service?.activeEncodes?.() || [], energy: stats.energy(),
        // (a lane whose GPU is not in the container starts no conversions)
        slotsOf: (jobId) => host.runtime?.service?.slotsOf?.(jobId) ?? null
      })
    };
  });
  r.add('GET', '/api/stats/history', (req, res, { query }) => {
    stats.touch();
    return stats.history(query.range === '24h' ? '24h' : '15m');
  });
  r.add('GET', '/api/stats/export.csv', (req, res, { query }) => {
    const range = query.range === '15m' ? '15m' : '24h';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="sentry-six-manager-stats-${range}.csv"`
    });
    res.end(stats.csv(range));
    return undefined;
  });
  r.add('GET', '/api/notifications', (req, res, { query }) => ({ notifications: notes.list({ open: query.open === '1' ? true : undefined, vehicleId: query.vehicle || undefined }) }));
  r.add('POST', '/api/notifications/:id/dismiss', (req, res, { params }) => {
    notes.dismiss(Number(params.id));
    return { ok: true };
  });
  r.add('POST', '/api/notifications/read', (req, res, { body }) => {
    notes.markRead((Array.isArray(body?.ids) ? body.ids : []).map(Number).filter(Number.isFinite));
    return { ok: true };
  });

  r.add('GET', '/api/settings', () => ({
    appearance: db.get('appearance', { reduceEffects: false }),
    power: db.get('power', { currency: '$', mode: 'flat', pricePerKwh: null, defaultPrice: null, rates: [] })
  }));
  // electricity price (one price or a time-of-use plan) for the costs shown
  // next to energy; Settings > System
  r.add('PUT', '/api/settings/power', (req, res, { body }) => {
    let next;
    try {
      next = parsePowerSettings(body || {});
    } catch (err) {
      if (err instanceof PriceError) throw Object.assign(new HttpError(400, err.message), { expose: true });
      throw err;
    }
    db.set('power', next);
    return next;
  });
  r.add('PUT', '/api/settings/appearance', (req, res, { body }) => {
    const next = { reduceEffects: Boolean(body?.reduceEffects) };
    db.set('appearance', next);
    return next;
  });
  r.add('GET', '/api/updates', () => updates.status());
  r.add('POST', '/api/updates/check', () => updates.check());

  // Converter (Encoder tab) — the Studio converter UI talks to these.
  r.add('POST', '/api/converter/invoke/:name', async (req, res, { params, body }) => {
    if (!bridge) return { ok: false, error: { code: host.lastError?.code || 'CONVERTER_STARTING' } };
    return bridge.invoke(params.name, body, req.headers['x-client-id']);
  });

  // Viewer (Studio) file access, confined to the vehicle shares.
  const confined = async (p, guard = studioReadable, opts) => {
    const real = await guard.resolve(p, opts);
    if (!real || hiddenPath(real)) throw new HttpError(403, 'That path is outside the vehicle shares.');
    return real;
  };
  r.add('POST', '/api/studio/readDir', async (req, res, { body }) => {
    const real = await confined(body?.path);
    try {
      return await readDir(real);
    } catch {
      return [];
    }
  });
  r.add('POST', '/api/studio/readFile', async (req, res, { body }) => {
    const real = await confined(body?.path);
    const text = await readTextConfined(real, studioReadable.fdInside, 8 * 1024 * 1024);
    if (text === null) throw new HttpError(404, 'Not readable');
    return { text };
  });
  r.add('POST', '/api/studio/exists', async (req, res, { body }) => {
    const real = await studioReadable.resolve(body?.path);
    return Boolean(real && !hiddenPath(real));
  });
  r.add('POST', '/api/studio/stat', async (req, res, { body }) => {
    const real = await studioReadable.resolve(body?.path);
    return real && !hiddenPath(real) ? stat(real) : null;
  });
  r.add('POST', '/api/studio/thumbnail', async (req, res, { body }) => {
    const real = await studioReadable.resolve(body?.path);
    // clips only: ffmpeg must never be pointed at a playlist on a share
    if (!real || hiddenPath(real) || !clipThumbs || !/\.(mp4|mov)$/i.test(real)) return null;
    try {
      return await clipThumbs.get(real);
    } catch {
      return null;
    }
  });
  r.add('POST', '/api/studio/trashFolder', async (req, res, { body }) => {
    // Studio's "delete folder" (trash icon on an event): goes to the Recycle Bin.
    const real = await confined(body?.path, allowed);
    const found = vehicleForReal(real);
    if (!found) throw new HttpError(403, 'Not inside a vehicle share.');
    const v = found.vehicle;
    if (!inventory.get(v.id)?.recordings) await inventory.scan(v.id);
    const rel = path.relative(found.root, real).split(path.sep).join('/');
    const ids = inventory.get(v.id).recordings.filter((x) => x.folder === rel || x.folder.startsWith(`${rel}/`)).map((x) => x.id);
    if (!ids.length) return { success: false, error: 'Nothing to move to the Recycle Bin in that folder.' };
    const out = await bin.trash(v.id, ids);
    announce('inventory');
    announce('bin');
    return out.skipped.length && !out.moved.length
      ? { success: false, error: out.skipped[0].reason === 'protected' ? 'This recording is protected.' : out.skipped[0].reason === 'converting' ? 'This recording is being converted right now.' : 'Could not move it to the Recycle Bin.' }
      : { success: true };
  });
  r.add('GET', '/api/studio/settings', () => db.get('studio-settings', {}));
  r.add('POST', '/api/studio/settings', (req, res, { body }) => {
    if (!body || typeof body.key !== 'string' || body.key.length > 100) throw new HttpError(400, 'Invalid setting');
    const all = db.get('studio-settings', {});
    all[body.key] = body.value;
    db.set('studio-settings', all);
    return { ok: true };
  });
  const appVersion = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'version.json'), 'utf8')).version || null;
    } catch {
      return null;
    }
  })();
  r.add('GET', '/api/studio/context', () => ({
    version: appVersion ? `${appVersion} (web)` : 'web',
    vehicles: vehicles.list().map((v) => ({ id: v.id, name: v.name, root: vehicles.rootOf(v), timezone: v.timezone })),
    outputRoots: outputRoots()
  }));
  r.add('POST', '/api/studio/browse', async (req, res, { body }) => {
    // Folder picker for the converter / viewer: only allowed roots and their subfolders.
    const roots = allowedRoots().map((x) => (typeof x === 'string' ? x : x.path));
    if (!body?.path) return { path: null, parent: null, entries: roots.map((p) => ({ name: vehicles.vehicleForPath(p)?.name || (p === path.join(DATA, 'converted') ? 'Converted copies' : p), path: p, isDirectory: true })) };
    const real = await confined(body.path, allowed);
    const entries = (await readDir(real).catch(() => [])).filter((e) => e.isDirectory && !e.name.startsWith('.'));
    const realRoots = await Promise.all(roots.map((p) => fs.promises.realpath(p).catch(() => p)));
    const atRoot = roots.some((p) => path.resolve(p) === real) || realRoots.includes(real);
    return { path: real, parent: atRoot ? null : path.dirname(real), entries };
  });

  // ---- HTTP handler
  const PUBLIC_STATIC = new Set(['/login', '/web/login.js', '/web/shell.css', '/web/icon.png']);
  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Bad request' });
    }
    const rawPath = url.pathname;
    try {
      securityHeaders(req, res, rawPath);
      if (rawPath === '/healthz') {
        // readable cross-origin: the plain-HTTP page checks with it whether this device trusts the certificate
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'cross-origin' });
        return res.end('ok');
      }
      // Nodes: a paired main server's requests, by token over HTTPS only (no
      // cookies, so the host-name and same-origin checks below do not apply)
      if (rawPath.startsWith('/node/v1/')) {
        if (tlsSource && await nodeWorker.handle(req, res, rawPath, clientKey(req))) return undefined;
        return sendJson(res, 404, { error: 'Not found' });
      }
      const reqHost = cleanHost(req);
      if (!reqHost) return sendJson(res, 421, { error: 'Unknown host name.' });
      // one decoded, normalized path for every static decision: no %2F tricks
      let p;
      try {
        p = decodeURIComponent(rawPath);
      } catch {
        return sendJson(res, 400, { error: 'Bad request' });
      }
      if (p.includes('\0') || p.includes('\\') || path.posix.normalize(p) !== p) return sendJson(res, 400, { error: 'Bad request' });

      const user = auth.user(req);
      const isApi = p.startsWith('/api/');
      const publicStatic = PUBLIC_STATIC.has(p) || (p.startsWith('/web/fonts/') && !p.slice(11).includes('/'));

      if (isApi) {
        const m = r.match(req.method, rawPath);
        if (!m && p !== '/api/events' && p !== '/api/converter/events' && p !== '/api/media' && p !== '/api/support/media') return sendJson(res, 404, { error: 'Not found' });
        if (!user && !(m && m.route.opts.public)) return sendJson(res, 401, { error: 'Sign in first.' });
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          if (req.headers['x-requested-with'] !== 'sentry-six-manager') return sendJson(res, 403, { error: 'Missing X-Requested-With header.' });
          const origin = req.headers.origin;
          if (origin && origin !== 'null') {
            let originHost = null;
            try {
              originHost = new URL(origin).host;
            } catch {
              // fall through: refused
            }
            if (originHost !== reqHost) return sendJson(res, 403, { error: 'Cross-site request refused.' });
          }
        }
        if (p === '/api/events') {
          // a signed-in page may hold one; a cap stops a buggy or hostile
          // client from piling up event streams and exhausting sockets
          if (clients.size >= MAX_EVENT_CLIENTS) return sendJson(res, 503, { error: 'Too many open connections.' });
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          res.write('event: hello\ndata: {}\n\n');
          clients.add(res);
          const ping = setInterval(() => res.write(': ping\n\n'), 20000);
          req.on('close', () => {
            clearInterval(ping);
            clients.delete(res);
          });
          return undefined;
        }
        if (p === '/api/converter/events') {
          if (!bridge) return sendJson(res, 503, { error: 'Converter is starting' });
          // capped like /api/events
          if (converterStreams >= MAX_EVENT_CLIENTS) return sendJson(res, 503, { error: 'Too many open connections.' });
          converterStreams += 1;
          req.on('close', () => { converterStreams -= 1; });
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          res.write('event: hello\ndata: {}\n\n');
          bridge.attachEvents(String(url.searchParams.get('client') || '').slice(0, 64), res);
          return undefined;
        }
        if (p === '/api/media') {
          const real = await studioReadable.resolve(url.searchParams.get('path') || '');
          if (!real || hiddenPath(real)) return sendJson(res, 403, { error: 'Outside the vehicle shares.' });
          return sendMedia(req, res, real, studioReadable.fdInside);
        }
        if (p === '/api/support/media') {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
          // one upload at a time: each holds up to ~4x the file in memory
          // (the body, base64 and the JSON sent on)
          if (supportUploading) return sendJson(res, 429, { error: 'Another file is being sent to support. Try again when it is done.' });
          supportUploading = true;
          res.on('close', () => { supportUploading = false; });
          // the file comes as the raw body (not JSON), its name and the message in headers
          const bytes = await readRaw(req, MAX_MEDIA_BYTES);
          const header = (k) => {
            try {
              return decodeURIComponent(String(req.headers[k] || ''));
            } catch {
              return '';
            }
          };
          return sendJson(res, 200, await support.media({
            bytes, fileName: header('x-file-name'), fileType: String(req.headers['content-type'] || ''),
            message: header('x-message'), includeDiagnostics: req.headers['x-diagnostics'] === '1'
          }));
        }
        const body = req.method === 'GET' ? undefined : await readJson(req, p.startsWith('/api/converter/') ? 256 * 1024 : 1024 * 1024);
        const out = await m.route.handler(req, res, { params: m.params, query: Object.fromEntries(url.searchParams), body, user });
        if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
        return undefined;
      }

      if (!user && !publicStatic) {
        res.writeHead(302, { Location: `/login${p === '/' ? '' : `?next=${encodeURIComponent(p + url.search)}`}` });
        return res.end();
      }
      const serve = async (root, rel, opts) => {
        if (!(await serveFile(req, res, root, rel, opts))) notFound(res);
      };
      if (p === '/' || p === '/index.html') return serve(WEB, 'index.html');
      if (p === '/login') return serve(WEB, 'login.html');
      if (p.startsWith('/web/')) return serve(WEB, p.slice(5), { cache: p.includes('/fonts/') ? 'public, max-age=604800' : 'no-cache' });
      if (p === '/studio' || p === '/studio/') {
        res.writeHead(302, { Location: `/studio/index.html${url.search}` });
        return res.end();
      }
      // The Encoder tab has a page of its own: an old Encoder link never
      // shows the whole Studio app.
      if (p === '/studio/index.html' && url.searchParams.get('embed') === 'encoder') {
        res.writeHead(302, { Location: `${ENCODER_PAGE}${url.search}` });
        return res.end();
      }
      if (p.startsWith('/studio/')) {
        const rel = p.slice('/studio/'.length);
        const opts = rel === 'index.html' ? { transform: studioHtml } : rel === 'encoder.html' ? { transform: encoderHtml } : {};
        if (rel.startsWith('fonts/')) opts.cache = 'public, max-age=604800';
        return serve(path.join(SRC, 'renderer'), rel, opts);
      }
      if (p.startsWith('/shared/')) return serve(path.join(SRC, 'shared'), p.slice(8));
      if (p.startsWith('/assets/')) return serve(path.join(APP_ROOT, 'assets'), p.slice(8));
      return notFound(res);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error(`${req.method} ${rawPath}: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, status, { error: status >= 500 && !err.status ? 'Internal error' : err.message || 'Error', ...(err.expose && err.code ? { code: err.code } : {}) });
      else res.end();
      return undefined;
    }
  };
  function notFound(res) {
    sendJson(res, 404, { error: 'Not found' });
  }

  // ---- listen: HTTPS, with plain HTTP on the same port. Plain HTTP never
  // shows the app, so no password or footage ever goes over it: a browser
  // gets a short page (web/continue.html) that explains the certificate
  // warning it will see once and moves on by itself when the device already
  // trusts the certificate; anything else is redirected.
  let httpsServer = null;
  const servers = [];
  if (!tlsSource) {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(PORT, HOST, () => log.warn(`Sentry Six Manager on http://${HOST}:${PORT} WITHOUT HTTPS (TLS_MODE=off): only use this behind a reverse proxy that does HTTPS.`));
  } else {
    const material = await tlsSource.load();
    // HTTP/2: the Viewer plays six cameras at once next to live updates and
    // telemetry; over HTTP/1.1 browsers allow only six connections per
    // server, so some cameras waited for a free one and fell behind.
    httpsServer = http2.createSecureServer({ key: material.key, cert: material.cert, minVersion: 'TLSv1.2', allowHTTP1: true }, handler);
    // A connection left idle (no request, no reply) is closed after 2
    // minutes: live updates send something every 20 s at most, so only
    // abandoned or deliberately held connections go.
    httpsServer.setTimeout(120_000);
    const continuePage = fs.readFileSync(path.join(WEB, 'continue.html'), 'utf8');
    const CONTINUE_FILES = new Set(['/web/continue.js', '/web/shell.css', '/web/icon.png']);
    const redirect = http.createServer(async (req, res) => {
      let u;
      try {
        u = new URL(req.url, 'http://localhost');
      } catch {
        u = new URL('http://localhost/');
      }
      if (u.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }
      const target = cleanHost(req) || `localhost:${PORT}`;
      const httpsUrl = `https://${target}${u.pathname}${u.search}`;
      if (req.method === 'GET' && (CONTINUE_FILES.has(u.pathname) || (u.pathname.startsWith('/web/fonts/') && !u.pathname.slice(11).includes('/')))) {
        if (!(await serveFile(req, res, WEB, u.pathname.slice(5)))) notFound(res);
        return undefined;
      }
      if (req.method !== 'GET' || !/text\/html/.test(String(req.headers.accept || ''))) {
        res.writeHead(308, { Location: httpsUrl, 'Cache-Control': 'no-store' });
        return res.end();
      }
      let fingerprint = '';
      try {
        fingerprint = tlsSource.status().certificate?.fingerprint || '';
      } catch {
        // shown in the container log instead
      }
      const page = continuePage.replace('{{FINGERPRINT}}', escHtml(fingerprint || 'shown in the container log').replace(/:/g, ':<wbr>')).replace('{{HTTPS_URL}}', escHtml(httpsUrl));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src https://${target}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      });
      return res.end(page);
    });
    const front = net.createServer((socket) => {
      socket.setTimeout(15000, () => socket.destroy());
      socket.on('error', () => socket.destroy());
      socket.once('data', (chunk) => {
        socket.setTimeout(0);
        socket.pause();
        socket.unshift(chunk);
        // a TLS connection starts with a handshake record (0x16)
        (chunk[0] === 0x16 ? httpsServer : redirect).emit('connection', socket);
        process.nextTick(() => socket.resume());
      });
    });
    // more open connections than a household's devices ever need are refused
    front.maxConnections = 1024;
    servers.push(front, httpsServer, redirect);
    front.listen(PORT, HOST, () => log.info(`Sentry Six Manager on https://${HOST}:${PORT} (${buildInfo.sha ? buildInfo.sha.slice(0, 7) : 'dev'})`));
  }
  vehicles.startAll();

  // Converter starts in the background; the Encoder tab shows "starting" until ready.
  host.start().then(async (runtime) => {
    bridge = createConverterBridge({ runtime, resolvePath: (p, opts) => allowed.resolve(p, opts), log: logger.scope('converter') });
    const { createClipThumbnails } = require(path.join(SRC, 'main/clipThumbnails'));
    clipThumbs = createClipThumbnails({ directory: path.join(DATA, 'clip-thumbnails'), ffmpegPath: FFMPEG, ffprobePath: FFPROBE, spawn });
    runtime.service.subscribe((event) => {
      if (event?.type !== 'snapshot' || !event.snapshot) return;
      converterJobs.set(event.snapshot.id, event.snapshot);
      // (while a benchmark measures, its own account is marked; the job's
      // mark comes back when it stops)
      if (CONVERTER_RUNNING.has(event.snapshot.state)) {
        if (statsJob !== event.snapshot.id) {
          statsJob = event.snapshot.id;
          if (benchmarking === null) stats.markJob(statsJob);
        }
      } else if (statsJob === event.snapshot.id) {
        statsJob = null;
        if (benchmarking === null) stats.markJob(null);
      }
      mirrorConverterJob(event.snapshot);
    });
    // jobs from before a restart (a paused one still owns its clips)
    // (only a list that loaded settles rows: a failed one would end them all)
    const listed = await runtime.service.list().catch(() => null);
    for (const s of listed || []) if (!converterJobs.has(s.id)) converterJobs.set(s.id, s);
    if (Array.isArray(listed)) {
      converterListed = true;
      settleConversionRows();
    }
  }).catch((err) => log.error(`Converter unavailable: ${err.code || err.message}`));

  // Clip results of a converter job (its counters only hold files and bytes).
  function converterCounts(s) {
    const out = { converted: 0, skipped: 0, failed: 0 };
    for (const item of s.items || []) {
      if (item?.kind !== 'video') continue;
      if (item.state === 'completed' && item.eligibleVideo !== false) out.converted++;
      else if (item.state === 'skipped') out.skipped++;
      else if (item.state === 'failed') out.failed++;
    }
    return out;
  }

  const mirroredLines = new Map();
  function mirrorConverterJob(s) {
    const externalId = `converter:${s.id}`;
    const src = s.config?.sourceRoot || '';
    const v = vehicleForReal(src)?.vehicle || vehicles.vehicleForPath(src);
    const c = converterCounts(s);
    const saved = Number(s.counters?.savedBytes) || 0;
    const detail = [`${c.converted} converted`, `${c.skipped} skipped`, `${c.failed} failed`].join(', ') + (saved > 0 ? ` · ${formatBytes(saved)} saved` : '');
    let jobId = db.jobByExternal(externalId)?.id;
    const terminal = !CONVERTER_ACTIVE.has(s.state);
    // a finished conversion taken off Jobs by Clear jobs stays off (its
    // summary dismissed in the Encoder is no news); running again brings it back
    if (!jobId && terminal && db.jobCleared(externalId)) return;
    if (!jobId) jobId = jobs.start({ type: 'conversion', vehicleId: v?.id || null, title: `Convert ${v ? v.name : src} to ${String(s.config?.codec || '').toUpperCase()}`, externalId });
    const existing = db.jobByExternal(externalId);
    if (terminal && existing?.status === 'running') {
      const measured = stats.energy().byJob?.[s.id] || null;
      // (its baseline stays with the stats engine)
      const energy = measured ? { wh: measured.wh, avgW: measured.avgW, seconds: measured.seconds, cost: measured.cost } : null;
      jobs.finish(jobId, { status: c.failed > 0 || s.state === 'failed' ? 'failed' : s.state === 'cancelled' ? 'cancelled' : 'done', detail, ...(energy ? { result: { energy } } : {}) });
      if (c.failed > 0) {
        notes.raise({ kind: 'conversion', level: 'warning', vehicleId: v?.id || null, dedupeKey: `conversion-failed:${s.id}`,
          title: `${c.failed} clip(s) could not be converted`, message: 'The originals were kept. Open the Encoder tab for details and Retry failed.' });
      }
    } else if (!terminal) {
      // (the Jobs list and every open page hear of it only when its line changes)
      const line = `${s.state}: ${detail}`;
      if (mirroredLines.get(jobId) !== line) {
        mirroredLines.set(jobId, line);
        jobs.update(jobId, { detail: line });
      }
    }
    if (terminal) mirroredLines.delete(jobId);
  }

  // housekeeping
  setInterval(() => {
    policies.tick().then(() => announce('bin')).catch(() => {});
    updates.tick().catch(() => {});
    db.pruneSessions();
    // data used: the network counters once a day, with no page open too
    stats.tick();
  }, 60 * 1000).unref();
  setInterval(() => {
    for (const v of vehicles.list()) if (vehicles.share(v.id)?.isHealthy()) inventory.scan(v.id).then(() => announce('inventory')).catch(() => {});
  }, Number(process.env.SCAN_INTERVAL_MINUTES || 15) * 60 * 1000).unref();
  // renew the HTTPS certificate before it expires (checked daily)
  if (tlsSource) {
    setInterval(async () => {
      try {
        const m = await tlsSource.load();
        httpsServer?.setSecureContext({ key: m.key, cert: m.cert });
      } catch (err) {
        log.warn(`HTTPS certificate check failed: ${err.message}`);
      }
    }, 24 * 3600 * 1000).unref();
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: shutting down`);
    for (const res of clients) res.end();
    for (const s of servers) s.close();
    try { stats.stop(); } catch { /* history is saved on a best-effort basis */ }
    nodeWorker.close();
    await host.stop().catch(() => {});
    await vehicles.stopAll();
    db.close();
    log.info('Stopped cleanly');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  if (SUPERVISED) {
    process.on('disconnect', () => shutdown('supervisor gone'));
    // the supervisor renewed the certificate
    process.on('message', (m) => {
      if (m?.type === 'shutdown') return shutdown('supervisor asked');
      if (m?.type === 'rapl-reading') return stats.setRapl(m);
      if (m?.type === 'supervisor-log') return logger.write(m.level === 'warn' || m.level === 'error' ? m.level : 'info', 'supervisor', String(m.message || '').slice(0, 4000), { echo: false });
      if (m?.type !== 'tls-updated' || !tlsSource || !httpsServer) return;
      tlsSource.load().then((x) => httpsServer.setSecureContext({ key: x.key, cert: x.cert }), (err) => log.warn(`Reloading the certificate failed: ${err.message}`));
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
