'use strict';

// MALLOC_ARENA_MAX (set by the image, see the Dockerfile) has done its work
// for this process by now (glibc reads it at start); the ffmpeg processes
// started from here keep glibc's default, which encodes a little faster.
delete process.env.MALLOC_ARENA_MAX;

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

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const http2 = require('http2');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const gzipAsync = require('util').promisify(zlib.gzip);
const { spawn } = require('child_process');
const { Logger } = require('./log');
const { ManagerDB } = require('./db');
const { Auth, parseCookies } = require('./auth');
const { VehicleManager } = require('./vehicles');
const carModels = require('./carModels');
const { Inventory } = require('./inventory');
const { RecycleBin, formatBytes } = require('./recycleBin');
const { createScrubFrames } = require('./scrubFrames');
const { createScrubPrepare } = require('./scrubPrepare');
const { Policies, dayInZone } = require('./policies');
const { Jobs, Notifications } = require('./activity');
const { ImageUpdates, criticalFromFile } = require('./imageUpdates');
const { Thumbnails } = require('./thumbnails');
const { detectGpus } = require('./gpu');
const { createHealth } = require('./health');
const { createSnapshots, applyPendingRestore } = require('./snapshots');
const { createIntegrity } = require('./integrity');
const { createAccounts, viewerMay } = require('./accounts');
const placesLib = require('./places');
const drivesLib = require('./drives');
const driveDataLib = require('./driveData');
const { writeZip, streamZip, waitDrain, ZIP_LIMIT } = require('./zip');
const { createConverterHost } = require('./converterHost');
const { createStats } = require('./stats');
const { encoderBlock, jobProgress, RUNNING: CONVERTER_RUNNING } = require('./encoderStats');
const { createSavings } = require('./savings');
const { parsePowerSettings, priceAt, rateNameAt, isCheapest, PriceError } = require('./powerPrice');
const { createConverterBridge } = require('./converterBridge');
const { hiddenPath, readDir, stat, sendMedia, readTextConfined } = require('./studioApi');
const { createRealGuard, isInside } = require('./safePath');
const { createLocalMounter, createIpcMounter } = require('./mounter');
const { VERSIONS, DEFAULT_VERSION, securitySummary } = require('./mountSpec');
const { TlsManager, localTlsSource, supervisorTlsSource, parseHostnames } = require('./tls');
const { canUploadSecure } = require('./canSecure');
const { Router, HttpError, sendJson, readJson, readRaw, serveFile, sendText } = require('./http');
const { createStudioTranslations } = require('./studioTranslations');
const { createUiPacks, originalPack, MAX_ZIP_BYTES: MAX_UI_PACK_BYTES } = require('./uiPacks');
const { createSmbTester } = require('./smbTest');
const { diskSpace } = require('../src/main/converter/fsSpace');
const { createNodes } = require('./nodes');
const { createNodeWorker } = require('./nodeWorker');
const { powerReport, combine: combinePower } = require('./nodePower');
const { createNodeBenchmark } = require('./nodeBenchmark');
const { run } = require('./proc');
const { Telemetry } = require('./telemetry');
const { createSpeedIndex } = require('./speedIndex');
const { createExporter } = require('./exporter');
const { createCanLogs, parseName: parseCanName } = require('./canLogs');
const { createCanIndex, CLIP_STEP_MS: CAN_CLIP_STEP_MS } = require('./canIndex');
const { openCanLog, stopWhenStalled, FORMATS: CAN_FORMATS } = require('./canLogReader');
const { createCanTrust } = require('./canTrust');
const { createCanPort } = require('./canPort');
const sentryUsbLinkLib = require('./sentryUsbLink');
const { createSentryUsbQueue } = require('./sentryUsbQueue');
const { createSentryUsbAudit } = require('./sentryUsbAudit');
const { createCanSync } = require('./canSync');
const canCalc = require('./canCalc');
const { createCanPrune } = require('./canPrune');
const { createCanFootage } = require('./canFootage');
const { createRecordingPlaces, minuteFileOf } = require('./recordingPlace');
const { createArchiveGap } = require('./archiveGap');
const { createSentryUsbStatus, stampSec: clipStampSec } = require('./sentryUsb');
const { createOriginalChecksums } = require('./originalChecksums');
const { createArrivalChecksums } = require('./arrivalChecksums');
const { createCanSearch, createSearchQueue, footageAt, clipStamps, localTime, parseWhen } = require('./canSearch');
const { clientAddress, fromTrustedProxy, proxyMatcher, banKey } = require('./clientAddress');
const { createAccess, validate: validateAccess } = require('./access');

/** A wall-clock time in an IANA time zone (as a TeslaCam clip is named) in UTC milliseconds. */
function zonedToUtc(y, mo, d, h, mi, sec, timeZone) {
  const offsetAt = (ms) => {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
    } catch { return 0; }
  };
  const guess = Date.UTC(y, mo - 1, d, h, mi, sec);
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first); // again, for a change of clocks in between
}

/** Run fn over items, at most n at a time. */
async function eachLimit(items, n, fn) {
  let next = 0;
  const work = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, work));
}

const APP_ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const SRC = path.join(APP_ROOT, 'src');
const WEB = path.join(APP_ROOT, 'web');
const DATA = path.resolve(process.env.DATA_PATH || '/data');
const RUN_DIR = path.resolve(process.env.RUN_DIR || '/run/sentry-six-manager');
const FOOTAGE_ROOT = path.resolve(process.env.FOOTAGE_ROOT || '/footage');
const PORT = Number(process.env.PORT || 9000);
// the CAN Bridge's uploads: a port of their own, open only while they are turned on
const CAN_PORT = Number(process.env.CAN_PORT || 10000);
const HOST = process.env.HOST || '0.0.0.0';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const TLS_MODE = (process.env.TLS_MODE || 'auto').toLowerCase(); // auto | off
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
// which connections may say who the client is (X-Forwarded-For, -Proto,
// -Host): TRUSTED_PROXIES when given, else any address on the local network
// (server/clientAddress.js)
const PROXY = { trustProxy: TRUST_PROXY, trusted: proxyMatcher(process.env.TRUSTED_PROXIES) };
const SUPERVISED = process.env.SENTRY_SUPERVISED === '1' && typeof process.send === 'function';
const TRUSTED_HOSTS = (process.env.TRUSTED_HOSTS || '').split(/[\s,]+/).filter(Boolean).map((h) => h.toLowerCase());

const CONVERTER_ACTIVE = new Set(['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing', 'paused', 'paused_network']);

// Pages may load scripts, styles, frames and data only from this server, and
// never run inline scripts. Styles allow inline attributes (both UIs set
// style="" in markup). The embedded Studio viewer additionally needs
// 'unsafe-eval' (its bundled protobuf.js builds the telemetry decoder with
// new Function) and its map: MapLibre fetches OpenFreeMap's style, tiles,
// fonts and icons and Google's satellite tiles (the satellite probe is an
// <img>); the shell and sign-in pages get neither.
const MAP_HOSTS = 'https://tiles.openfreemap.org https://*.google.com';
const cspWith = ({ script = "'self'", img = "'self' data: blob:", connect = "'self'" }) => [
  "default-src 'self'",
  `script-src ${script}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src ${img}`,
  "media-src 'self' blob:",
  "font-src 'self' data:",
  `connect-src ${connect}`,
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');
const CSP = cspWith({});
// The main page: an interface pack draws the Viewer's map in it (with
// web/viewerMap.js), so it may fetch the same map hosts as the Viewer.
const SHELL_CSP = cspWith({ img: `'self' data: blob: ${MAP_HOSTS}`, connect: `'self' ${MAP_HOSTS}` });
const STUDIO_CSP = cspWith({ script: "'self' 'unsafe-eval'", img: `'self' data: blob: ${MAP_HOSTS}`, connect: `'self' ${MAP_HOSTS}` });
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

// The critical-update bar (web/critical.js) goes into every page the server
// serves, the built-in ones and every interface pack's, so no interface can
// leave it out. The login page has no status to show yet.
const CRITICAL_TAG = '<script src="/web/critical.js" defer></script>';
function withCriticalBar(html) {
  if (html.includes(CRITICAL_TAG)) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, (m) => `${CRITICAL_TAG}\n${m}`);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, (m) => `${CRITICAL_TAG}\n${m}`);
  return `${html}\n${CRITICAL_TAG}\n`;
}

// Versioned asset links: a page's own scripts and stylesheets are linked as
// /v/<version>/<path>, which the server answers like <path> but lets the
// browser keep for a year without asking again. The version changes with
// the build and the interface chosen, so a new one is always fetched; the
// page itself is never kept. Modules a script imports by a relative path
// get the same prefix by themselves.
const VERSIONED = /^\/v\/([A-Za-z0-9_-]{1,40})(\/.*)$/;
const LONG_CACHE = 'private, max-age=31536000, immutable';
/**
 * A versioned script's own links to the shared scripts (import '/web/x.js',
 * import('/web/x.js'), script.src = '/web/x.js', and the same under
 * /shared/) get its version too, so the modules it pulls in are kept as long
 * as it is, instead of asked for again on every visit. Only quoted paths of
 * .js files under /web/ and /shared/ change.
 */
function versionScriptLinks(js, version) {
  return js.replace(/(['"`])\/(web|shared)\/([A-Za-z0-9_./-]+\.m?js)\1/g, (m, q, dir, rest) => (rest.includes('..') ? m : `${q}/v/${version}/${dir}/${rest}${q}`));
}

function versionLinks(html, pageDir, version) {
  return html.replace(/<(?:script|link)\b[^>]*>/gi, (tag) => tag.replace(/\b(src|href)=(["'])([^"']+)\2/i, (m, attr, q, url) => {
    if (/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(url)) return m; // another site, data:, an anchor
    const [file, rest = ''] = url.split(/(?=[?#])/, 2);
    if (!/\.(m?js|css)$/i.test(file)) return m;
    const abs = file.startsWith('/') ? path.posix.normalize(file) : path.posix.join(pageDir, file);
    if (!abs.startsWith('/') || abs.startsWith('/api/') || abs.startsWith('/v/')) return m;
    return `${attr}=${q}/v/${version}${abs}${rest}${q}`;
  }));
}

/** The critical text this image was built with (CRITICAL_UPDATE.txt, if any). */
function readOwnCritical() {
  try {
    return criticalFromFile(fs.readFileSync(path.join(APP_ROOT, 'CRITICAL_UPDATE.txt'), 'utf8'));
  } catch {
    return null;
  }
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
  return fromTrustedProxy(req, PROXY) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

/** The Host header, if it is a plain host[:port] (and trusted, when TRUSTED_HOSTS is set). */
function cleanHost(req) {
  // HTTP/2 sends the host as :authority
  const raw = String((fromTrustedProxy(req, PROXY) && req.headers['x-forwarded-host']) || req.headers.host || req.headers[':authority'] || '').split(',')[0].trim();
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
  const page = pathname.split('?')[0];
  res.setHeader('Content-Security-Policy', page.startsWith('/studio/') && page !== ENCODER_PAGE ? STUDIO_CSP
    : page === '/' || page === '/index.html' ? SHELL_CSP : CSP);
  // No HSTS: with Manager's own certificate it takes the browser's "continue"
  // away on some devices and forces HTTPS on every port of the NAS's address;
  // plain HTTP is already redirected here and never shows the app.
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// the client address, worked out once per request (clientKey)
const CLIENT = Symbol('client address');
// what a banned address is told: the same whatever it tried, so it says
// nothing about accounts
const BANNED_TEXT = 'Too many failed attempts from this address, so it is blocked for a while. Try again later.';
const TWO_FACTOR_OUTSIDE_TEXT = 'This account has no two-step sign-in, so it can only sign in from the home network. Sign in at home and turn it on under Account (two-step sign-in), then you can sign in from anywhere.';
const TWO_FACTOR_EVERYONE_TEXT = 'Every account needs two-step sign-in, and this one has none yet. Sign in once from the home network to set it up.';
const HOME_ONLY_CHANGES_TEXT = 'Changes that need an admin can only be made from the home network (Settings → Security). Viewing works from anywhere.';
const HOME_ONLY_PAGES_TEXT = 'From outside the home network, admin accounts can only watch (Settings → Security). Settings and the other admin pages open at home.';
const TWO_FACTOR_SETUP_TEXT = 'Turn on two-step sign-in first: every account needs it (Settings → Security).';

function confirmRequired() {
  return Object.assign(new HttpError(403, 'Enter your password to confirm this change.'), { code: 'CONFIRM_PASSWORD', expose: true });
}

async function main() {
  const logger = new Logger({ level: process.env.LOG_LEVEL || 'info', file: path.join(DATA, 'logs', 'manager.log') });
  logger.captureConsole();
  const log = logger.scope('server');
  fs.mkdirSync(DATA, { recursive: true });
  const buildInfo = readBuildInfo();
  // a snapshot chosen in Settings → Health takes the database's place first
  try { applyPendingRestore(path.join(DATA, 'manager.db'), log); } catch (err) { log.error(`Restoring the database snapshot failed: ${err.message}`); }
  const db = new ManagerDB(path.join(DATA, 'manager.db'));
  // (a snapshot keeps no Sentry USB link key, nor a queued settings change's values)
  const snapshots = createSnapshots({
    db, dbFile: path.join(DATA, 'manager.db'), dir: path.join(DATA, 'snapshots'), log: logger.scope('snapshots'),
    secret: { sentryusb: sentryUsbLinkLib.withoutKeys, 'sentryusb-queue': () => ({ items: [] }) }
  });
  snapshots.start();
  const auth = new Auth({ db, log: logger.scope('auth'), isSecure, setupFile: path.join(DATA, 'setup-code.txt') });
  const accounts = createAccounts({ db });
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
  const smbTester = createSmbTester({ mounter, vehicles, log: logger.scope('vehicles') });
  vehicles.bootstrapFromEnv();
  let speedIndex = null;
  let driveData = null; // Sentry USB drive-data.json per car (driveData.js)
  let speedIndexBusy = () => false; // a conversion or the benchmark runs (set where the converter is made)
  let scrubPrepare = null;
  let archiveGapRef = null; // footage the car recorded that has not reached the share (set where CAN is known)
  let integrityRef = null; // the footage check: one cut short by a restart goes on after the first scan
  let arrivalRef = null; // every arrived clip's checksum for Sentry USB (arrivalChecksums.js, set where the converter is known)
  let canUploadRef = null; // CAN Bridge uploads (set where canLogs is made)
  let canPruneRef = null; // CAN logs that go with their footage (canPrune.js, set where canLogs is made)
  let canIndexRef = null; // the CAN index (set where it is made): a vehicle's car model changed
  let canFootageRef = null; // which recordings have CAN Bridge data (canFootage.js, set where the CAN index is made)
  let recPlacesRef = null; // where a recording was, for its place tag (recordingPlace.js, set with canFootageRef)
  /** The CAN logs footage would take with it ("Also delete its CAN data"), counted; null: no key mapped to the car. */
  const canWith = async (vid, what) => {
    const r = await canPruneRef?.deleteWith(vid, { ...what, dryRun: true }).catch(() => null);
    if (!r || r.skip === 'no CAN Bridge key is mapped to this car' || r.skip === 'no such car') return null;
    return { logs: r.logs || 0, kept: r.kept || 0, ...(r.skip ? { skip: r.skip } : {}) };
  };
  let canPort = null; // opens or closes the CAN Bridge's own port, one call at a time (set where the servers start)
  // the device port (CAN_PORT) listens while CAN uploads are on, or a Sentry USB is paired or pairing
  let sentryLink = null;
  const devicePortWanted = () => Boolean(db.get('can', null)?.enabled) || Boolean(sentryLink?.wanted());
  const syncDevicePort = () => canPort?.set(devicePortWanted()).catch((err) => log.warn(`Device port: ${err.message}`));
  const canUpload = (req, res, p) => (canUploadRef ? canUploadRef(req, res, p) : sendJson(res, 404, { error: 'Not found' }));
  // Sentry USB's status file on each car's share (sentryUsb.js): read on every
  // scan, and every minute while it says a transfer runs
  const sentryUsb = createSentryUsbStatus({
    vehicles, log: logger.scope('sentry-usb'),
    onChange: (vid) => { archiveGapRef?.check(vid); announce('inventory'); }
  });
  const inventory = new Inventory({ vehicles, db, log: logger.scope('inventory'), onChange: () => announce('inventory'), onScanned: (vid) => {
    speedIndex?.kick(); scrubPrepare?.kick(); integrityRef?.resume(vid);
    // (the gap check and the checksum record read the status the scan just found)
    sentryUsb.refresh(vid).catch(() => null).finally(() => { archiveGapRef?.check(vid); arrivalRef?.kick(); });
    driveData?.check(vid).catch(() => null);
  } });
  // the SHA-256 of every original the converter replaces in place, for
  // Sentry USB (originalChecksums.js), written inside a vehicle's folder only
  const originalChecksums = createOriginalChecksums({
    log: logger.scope('converter'),
    allowedRoot: (dir) => Boolean(vehicles.vehicleForPath(dir))
  });
  const thumbs = new Thumbnails({ dir: path.join(DATA, 'thumbnails'), ffmpegPath: FFMPEG });
  const telemetry = new Telemetry({ srcRoot: SRC, cacheDir: path.join(DATA, 'telemetry'), log: logger.scope('telemetry') });
  // every front clip's speed, a value a second, indexed in the background for the Viewer's speed graph
  // (not while a conversion or the benchmark runs: the speed reads share the data disk; both are declared below)
  // Sentry USB's drive-data.json on each car's share (driveData.js): read when
  // the drives API asks and it changed, kept boiled down under the data folder
  driveData = driveDataLib.createDriveData({ dir: path.join(DATA, 'drive-data'), vehicles, log: logger.scope('drives'), idle: () => !speedIndexBusy() });
  speedIndex = createSpeedIndex({ dir: path.join(DATA, 'speeds'), inventory, vehicles, telemetry, log: logger.scope('speeds'), idle: () => !speedIndexBusy() });
  // the place search's cache, filled quietly half a minute after start
  setTimeout(() => speedIndex.warm(vehicles.list().map((v) => v.id)).catch((err) => log.warn(`Place search: ${err.message}`)), 30_000).unref?.();

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
  // The clips a conversion has in hand right now (absolute paths). Only
  // those are refused by the Recycle Bin: a clip still queued may go, the
  // converter skips a clip that is gone when it gets there.
  const busyPaths = () => {
    const out = new Set();
    for (const s of converterJobs.values()) {
      if (!CONVERTER_ACTIVE.has(s.state) || !s.config?.sourceRoot) continue;
      for (const i of s.items || []) if (i.state === 'processing' && i.relativePath) out.add(path.join(s.config.sourceRoot, i.relativePath));
    }
    return out;
  };
  const bin = new RecycleBin({ db, vehicles, inventory, jobs, log: logger.scope('bin'), busyPaths, onDeleted: (item) => canPruneRef?.footageGone(item.vehicleId, item) });

  // ---- server stats (Overview > Server, the Encoder's Hardware panel):
  // sampled only while a page asks or a conversion runs
  const converterRunning = () => [...converterJobs.values()].some((s) => CONVERTER_RUNNING.has(s.state));
  let benchmarking = null; // the benchmark's energy token while it runs
  speedIndexBusy = () => converterRunning() || benchmarking !== null;
  // every clip that reaches a Sentry USB share gets a line in the checksum
  // record, converted or not (arrivalChecksums.js): the Pi then never reads it
  // back. One file at a time, rate-limited, not while a conversion runs.
  arrivalRef = createArrivalChecksums({
    dir: path.join(DATA, 'arrival-checksums'), vehicles, inventory, log: logger.scope('sentry-usb'),
    record: (request) => originalChecksums.record(request),
    holds: (abs) => sentryUsb.holds(abs), busyPaths, idle: () => !speedIndexBusy(),
    // "Record checksums for older clips" (on unless an admin turned it off for the car): every clip, any age
    olderOf: (vid) => (db.get('sentry-usb-record', {}) || {})[vid]?.older !== false
  });
  arrivalRef.start();
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
  // space saved by conversions, per vehicle, kept when jobs are cleared
  const savings = createSavings({ db });
  // savings by month: what was counted before months were kept goes to the
  // month its conversion finished (the job history)
  savings.backfill((jobId) => {
    const j = db.jobByExternal(`converter:${jobId}`);
    const t = j?.finishedAt || j?.finished_at || j?.startedAt || j?.started_at;
    if (!t) return null;
    const d = new Date(Number(t));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  // Nodes: other servers that encode for this one (server/nodes.js)
  const nodes = createNodes({
    db, log: logger.scope('nodes'), audit: logger.scope('audit'),
    // each node's power as it reports it: its share of a running job's energy
    onPower: (nodeId, at, w, encoding) => stats.nodePower(nodeId, at, w, encoding)
  });
  // Settings > Interface: an interface of the owner's own (server/uiPacks.js)
  // (the packs that come with the app: ui-packs in the image, examples/ui-packs in a checkout)
  const builtinPacks = [path.join(APP_ROOT, 'ui-packs'), path.join(APP_ROOT, 'examples', 'ui-packs')].find((d) => fs.existsSync(d)) || null;
  const uiPacks = createUiPacks({ dir: path.join(DATA, 'ui-packs'), db, log: logger.scope('ui'), builtinDir: builtinPacks });
  // (the browser opened /original: the built-in interface there)
  const UI_COOKIE = 'sm_ui_original';
  const originalOnly = (req) => parseCookies(req.headers.cookie || '')[UI_COOKIE] === '1';
  // the version in /v/<version>/ links: this build (or this start, without a
  // build id) and the interface this browser is shown. An uploaded pack is
  // never changed in place (a new upload has a new id).
  const bootId = buildInfo.sha || `start-${Date.now()}`;
  const assetVersion = (req) => {
    const key = `${bootId}|${originalOnly(req) ? 'original' : uiPacks.active() || 'builtin'}`;
    return crypto.createHash('sha256').update(key).digest('base64url').slice(0, 12);
  };
  await uiPacks.tidy().catch((err) => logger.scope('ui').warn(`UI packs folder: ${err.message}`));
  const host = createConverterHost({
    // in place: the original's SHA-256 goes into the share's checksum record
    // (fsynced) before the original is touched
    beforeReplaceOriginal: async (request) => {
      try {
        await originalChecksums.record(request);
      } catch (err) {
        logger.scope('converter').error(`Could not record the original's checksum for Sentry USB, so it was kept: ${path.basename(String(request.source || ''))}: ${err.code || err.message}`);
        throw err;
      }
    },
    // clips Sentry USB is still copying to the share wait for a later run
    holdDiscovered: (config, discovered) => sentryUsb.holds(discovered.sourcePath),
    // our in-place output: the record's line stays the original's (never the converted bytes')
    onClipConverted: (outputPath) => { arrivalRef?.converted(outputPath).catch(() => {}); },
    remoteNodes: {
      list: () => nodes.list(),
      encode: (request) => nodes.encode(request),
      // a trusted node's encodes skip the picture check (Nodes page)
      trusted: (device) => nodes.trusted(device),
      // a node's rows under Encoder > Parallel conversions set its clips at
      // once: a number for a whole node, { lane: n } for its devices
      setSlots: (device, slots) => nodes.setSlots(String(device), slots),
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
  const studioTranslations = createStudioTranslations(path.join(SRC, 'renderer/scripts/data/translations.js'));
  let clipThumbs = null;
  // the Viewer's scrub previews (see scrubFrames.js)
  const scrubFrames = createScrubFrames({ directory: path.join(DATA, 'scrub'), ffmpegPath: FFMPEG, ffprobePath: FFPROBE, spawn });
  // the newest footage's previews, made ahead in the background (not while converting)
  const prepareDays = Number.parseInt(process.env.SCRUB_PREPARE_DAYS ?? '2', 10);
  scrubPrepare = createScrubPrepare({
    inventory, vehicles, scrubFrames, days: Number.isFinite(prepareDays) ? Math.max(0, Math.min(prepareDays, 30)) : 2,
    idle: () => !converterRunning() && benchmarking === null, log: logger.scope('scrub')
  });

  const updates = new ImageUpdates({
    db, log: logger.scope('updates'), buildInfo, notes, ownCritical: readOwnCritical(), enabled: !/^(off|false|0|no)$/i.test(process.env.UPDATE_CHECK || '')
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
    runtime: () => host.runtime,
    // this server's power for the main's "All servers" total: the main asks
    // about every 30 s, so sampling holds 45 s and the numbers stay live
    power: () => {
      statsAskedAt = Date.now();
      stats.touch(45_000);
      return powerReport(stats.snapshot());
    }
  });

  // ---- live events to the browser
  const clients = new Set();
  const MAX_EVENT_CLIENTS = 200;
  const seenAt = new Map(); // session hash -> when its "last used" was last written
  // Early data for the main page (web/prefetch.js): the API calls a page
  // makes in its first two seconds are noted, per account and interface
  // version; the ones it made the last two times are asked for at once the
  // next time, while its scripts still load
  const PREFETCH_WINDOW = 2000;
  const learning = new Map(); // session hash -> { key, until, urls: Set }
  // (kept in the database, so a restart does not start over)
  const learnt = new Map(Object.entries(db.get('prefetch', {}) || {})); // `${user}|${version}` -> { last: [urls], hints: [urls] }
  function noteStartCall(req, h, p, search) {
    const l = learning.get(h);
    if (!l || Date.now() > l.until || l.urls.size >= 20) return;
    // fetch() calls only: images and video are asked for by the page itself
    if (req.headers['sec-fetch-dest'] !== 'empty') return;
    if (/^\/api\/(events|media|scrub|converter\/events)\b/.test(p)) return;
    l.urls.add(p + search);
  }
  function startLearning(h, key) {
    if (!h) return;
    const l = { key, until: Date.now() + PREFETCH_WINDOW, urls: new Set() };
    learning.set(h, l);
    setTimeout(() => {
      if (learning.get(h) === l) learning.delete(h);
      const urls = [...l.urls];
      const had = learnt.get(key);
      // only what the last two openings both asked for: a call made once, or
      // with a changing address, is not fetched for nothing
      const hints = had ? urls.filter((u) => had.last.includes(u)) : [];
      const sameSet = (a, b) => a.length === b.length && a.every((u) => b.includes(u)); // (the order calls come in varies)
      const same = had && sameSet(had.hints, hints) && sameSet(had.last, urls);
      learnt.delete(key);
      learnt.set(key, { last: urls, hints });
      if (learnt.size > 200) learnt.delete(learnt.keys().next().value);
      if (!same) db.set('prefetch', Object.fromEntries(learnt));
    }, PREFETCH_WINDOW + 100).unref?.();
  }
  /** The shell page with web/prefetch.js first in its head, given what this interface asked for before. */
  function withPrefetch(html, key) {
    const hints = learnt.get(key)?.hints || [];
    if (!hints.length) return html;
    const tag = `<script src="/web/prefetch.js" data-urls="${escHtml(JSON.stringify(hints))}"></script>`;
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`) : `${tag}\n${html}`;
  }
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
  // Days until full: the share's free space (its status, read with each
  // health check) against how much footage a day the car has added lately
  // (the last 14 days, by the car's dates, at the files' size now).
  const DAY_MS = 86_400_000;
  const recentFootage = new Map(); // vehicle id -> the last 14 days' bytes, per scan
  function storageOf(v) {
    const st = vehicles.share(v.id)?.status?.();
    const disk = st && Number.isFinite(st.freeBytes) ? { free: st.freeBytes, total: st.totalBytes } : null;
    if (!disk) return null;
    const inv = inventory.get(v.id);
    const since = new Date(Date.now() - 14 * DAY_MS).toISOString().slice(0, 10);
    let had = recentFootage.get(v.id);
    if (!had || had.files !== inv?.files || had.since !== since) {
      let bytes = 0;
      let first = null;
      for (const f of inv?.files?.values() || []) {
        if (!f.day || f.day < since) continue;
        bytes += f.size || 0;
        if (!first || f.day < first) first = f.day;
      }
      had = { files: inv?.files, since, bytes, first };
      recentFootage.set(v.id, had);
    }
    // over the last 14 days, or since the first footage when that is newer
    const span = had.first ? Math.min(14, Math.max(1, Math.round((Date.now() - Date.parse(`${had.first}T00:00:00Z`)) / DAY_MS))) : 14;
    const perDay = had.bytes / span;
    const policy = policies.get(v.id);
    // a policy that deletes every kind of footage after some days keeps the share from filling
    const capped = Boolean(policy?.enabled && Object.values(policy.keepDays || {}).every((d) => Number.isFinite(d) && d > 0));
    return {
      free: disk.free, total: disk.total, perDay: Math.round(perDay),
      daysLeft: perDay > 0 ? Math.floor(disk.free / perDay) : null,
      capped
    };
  }
  // the car each vehicle is (its model and year: which DBC set decodes its CAN data), set below with the CAN index
  let carSummaryRef = null;
  const withCar = async (v) => ({ ...vehicleSummary(v), car: carSummaryRef ? await carSummaryRef(v).catch(() => null) : { setting: carModels.normalizeCar(v.car), detected: null, ...carModels.resolveCar(v.car, null) } });
  const vehicleSummary = (v) => ({
    ...vehicles.publicView(v),
    security: v.source.type === 'smb' ? securitySummary({ encrypt: v.source.encrypt !== false, version: v.source.version }) : null,
    inventory: inventory.totals(v.id),
    scanning: Boolean(inventory.get(v.id)?.scanning),
    binBytes: bin.binBytes(v.id),
    binItems: db.binItems(v.id).length,
    policy: policies.get(v.id),
    saved: savings.forVehicle(v.id),
    storage: storageOf(v)
  });
  // Who the throttle, the bans, the home-network rules and the audit log
  // count as the client (server/clientAddress.js): the connection's own
  // address; behind a trusted reverse proxy (TRUST_PROXY, and the connection
  // comes from it) the rightmost X-Forwarded-For hop that is not one of the
  // proxies. Without TRUST_PROXY, or from any other connection, that header
  // is ignored: anyone could send it. Keying on the real client means one
  // attacker cannot lock out everyone behind the proxy.
  const clientKey = (req) => {
    if (!req[CLIENT]) req[CLIENT] = clientAddress(req, PROXY);
    return req[CLIENT];
  };
  // who did what, for the log: security-relevant actions only, never secrets
  const audit = logger.scope('audit');
  // Settings → Security: bans, two-step rules, the home network (server/access.js)
  const access = createAccess({ db, audit });
  const fromHome = (req) => access.isHome(clientKey(req));
  /** A banned address gets this on every sign-in step. */
  const refuseBanned = (req) => {
    if (!access.banned(clientKey(req))) return;
    throw Object.assign(new HttpError(429, BANNED_TEXT), { code: 'BANNED', expose: true });
  };
  /**
   * One failed attempt from this request's address. A ban it brings that
   * came from a signed-in session (a wrong password confirmation) also
   * signs that session out.
   */
  const failedAttempt = (req, reason, { session = false } = {}) => {
    const b = access.fail(clientKey(req), reason);
    if (b && session) {
      const h = auth.sessionHash(req);
      if (h) db.deleteSession(h);
    }
    return b;
  };
  // the two-step rules (Settings → Security), for a signed-in account here:
  // 'ok'; 'out' (no two-step sign-in, outside the home network, and a rule
  // needs it there: signed out); 'setup' (every account needs it, at home:
  // only setting it up is open)
  const twoFactorState = (user, home) => {
    const rules = access.get().twoFactor;
    if (!user || (!rules.outside && !rules.everyone) || accounts.twoFactorOn(user)) return 'ok';
    if (!home) return 'out';
    return rules.everyone ? 'setup' : 'ok';
  };
  // an admin who may make admin changes from where this request comes
  const adminHere = (req, user) => {
    if (accounts.roleOf(user) !== 'admin') return false;
    const rules = access.get().homeOnly;
    return !((rules.adminChanges || rules.adminPages) && !fromHome(req));
  };
  // an admin outside the home network with "Settings and admin pages only
  // from the home network" on has watch-only rights there
  const roleFor = (req, user) => {
    const role = accounts.roleOf(user);
    if (role === 'admin' && access.get().homeOnly.adminPages && !fromHome(req)) return 'viewer';
    return role;
  };
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
  r.add('GET', '/api/auth/me', (req) => {
    const user = auth.user(req);
    const home = fromHome(req);
    const rules = access.get();
    const limited = user && accounts.roleOf(user) === 'admin' && !home ? (rules.homeOnly.adminPages ? 'pages' : rules.homeOnly.adminChanges ? 'changes' : null) : null;
    return {
      user, role: user ? roleFor(req, user) : accounts.roleOf(user), twoFactor: user ? accounts.twoFactorOn(user) : false, needsSetup: auth.needsSetup(), secure: isSecure(req), fingerprint: req.socket?.encrypted ? certFingerprint() : null,
      // where the server sees this device: the home network or not, and what that limits
      homeNetwork: home, ...(limited ? { adminLimited: limited } : {}), ...(user && twoFactorState(user, home) === 'setup' ? { twoFactorSetupRequired: true } : {})
    };
  }, { public: true });
  // two-step sign-in: the password was right, the code is still to come
  const PENDING_COOKIE = 'sm_pending';
  const pendingToken = (req) => { const t = parseCookies(req.headers.cookie || '')[PENDING_COOKIE]; return typeof t === 'string' && /^[A-Za-z0-9_-]{20,80}$/.test(t) ? t : null; };
  const pendingCookie = (req, value, maxAge) => `${PENDING_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;
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
    refuseBanned(req);
    // per address, and per account from that address: wrong guesses from
    // elsewhere never lock the owner out
    const keys = [clientKey(req), `user:${String(body?.username || '').toLowerCase().slice(0, 64)}@${clientKey(req)}`];
    const wait = Math.max(...keys.map((k) => auth.throttled(k)));
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} s.`);
    if (!(await guarded(keys, () => auth.check(body?.username, body?.password)))) {
      keys.forEach((k) => auth.noteFailure(k));
      audit.warn(`Sign-in failed for "${String(body?.username || '').slice(0, 64)}" from ${clientKey(req)}`);
      // (the same for a name that does not exist)
      if (failedAttempt(req, 'wrong password')) throw Object.assign(new HttpError(429, BANNED_TEXT), { code: 'BANNED', expose: true });
      throw new HttpError(401, 'Wrong user name or password.');
    }
    keys.forEach((k) => auth.noteSuccess(k));
    // the two-step rules: an account without it signs in only where they allow
    const rule = twoFactorState(body.username, fromHome(req));
    if (rule === 'out') {
      audit.warn(`Sign-in refused (no two-step sign-in, outside the home network): ${by(req, body.username)}`);
      throw Object.assign(new HttpError(403, access.get().twoFactor.everyone ? TWO_FACTOR_EVERYONE_TEXT : TWO_FACTOR_OUTSIDE_TEXT), { code: 'TWO_FACTOR_REQUIRED', expose: true });
    }
    if (accounts.twoFactorOn(body.username)) {
      // the code comes next, on /login/code (every page sends a pending sign-in there)
      res.setHeader('Set-Cookie', pendingCookie(req, accounts.startPending(body.username), 300));
      audit.info(`Password right, waiting for the two-step code: ${by(req, body.username)}`);
      return { ok: true, twoFactor: true, next: '/login/code' };
    }
    auth.login(req, res, body.username, { ip: clientKey(req) });
    if (rule === 'setup') {
      audit.info(`Signed in to set up two-step sign-in (every account needs it): ${by(req, body.username)}`);
      return { ok: true, twoFactorSetup: true, next: '/login/two-factor' };
    }
    audit.info(`Signed in: ${by(req, body.username)}`);
    return { ok: true };
  }, { public: true });
  r.add('POST', '/api/auth/2fa/code', async (req, res, { body }) => {
    refuseBanned(req);
    const key = `code:${clientKey(req)}`;
    const wait = auth.throttled(key);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} s.`);
    let username;
    try {
      username = accounts.finishPending(pendingToken(req), body?.code);
    } catch (err) {
      auth.noteFailure(key);
      if (err.expired) res.setHeader('Set-Cookie', pendingCookie(req, '', 0));
      audit.warn(`Two-step code wrong from ${clientKey(req)}`);
      if (failedAttempt(req, 'wrong two-step code')) throw Object.assign(new HttpError(429, BANNED_TEXT), { code: 'BANNED', expose: true });
      throw new HttpError(err.status || 401, err.message);
    }
    auth.noteSuccess(key);
    auth.login(req, res, username, { ip: clientKey(req) });
    const set = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...[].concat(set || []), pendingCookie(req, '', 0)]);
    audit.info(`Signed in with a two-step code: ${by(req, username)}`);
    return { ok: true };
  }, { public: true });
  // ---- Account: two-step sign-in, signed-in devices, other accounts
  r.add('GET', '/api/auth/2fa', (req, res, { user }) => ({ enabled: accounts.twoFactorOn(user), recoveryLeft: accounts.recoveryLeft(user) }));
  r.add('POST', '/api/auth/2fa/start', (req, res, { user }) => { requireConfirmed(req); return accounts.startTotp(user); });
  r.add('POST', '/api/auth/2fa/enable', (req, res, { body, user }) => {
    const recovery = accounts.enableTotp(user, body?.code);
    audit.warn(`Two-step sign-in turned on: ${by(req, user)}`);
    return { recovery };
  });
  r.add('POST', '/api/auth/2fa/disable', (req, res, { user }) => {
    requireConfirmed(req);
    accounts.disableTotp(user);
    audit.warn(`Two-step sign-in turned off: ${by(req, user)}`);
    return { ok: true };
  });
  r.add('GET', '/api/auth/sessions', (req, res, { user }) => {
    const mine = auth.sessionHash(req);
    return { sessions: db.sessionsFor(user).map((x) => ({ id: x.token_hash.slice(0, 16), current: x.token_hash === mine, agent: x.agent, ip: x.ip, createdAt: x.created_at, seenAt: x.seen_at })) };
  });
  r.add('POST', '/api/auth/sessions/:id/end', (req, res, { params, user }) => {
    const hit = db.sessionsFor(user).find((x) => x.token_hash.slice(0, 16) === params.id);
    if (!hit) throw new HttpError(404, 'No such session.');
    db.deleteSession(hit.token_hash);
    audit.info(`Signed out a device: ${by(req, user)}`);
    return { ok: true };
  });
  r.add('POST', '/api/auth/sessions-end-others', (req, res, { user }) => {
    const mine = auth.sessionHash(req);
    let n = 0;
    for (const x of db.sessionsFor(user)) if (x.token_hash !== mine) { db.deleteSession(x.token_hash); n++; }
    audit.warn(`Signed out everywhere else (${n} session${n === 1 ? '' : 's'}): ${by(req, user)}`);
    return { ended: n };
  });
  r.add('GET', '/api/accounts', () => ({ accounts: accounts.list() }));
  r.add('POST', '/api/accounts', (req, res, { body, user }) => {
    requireConfirmed(req);
    const name = String(body?.username || '');
    if (db.getUser(name)) throw new HttpError(409, 'There is an account with that name already.');
    auth.setPassword(name, String(body?.password || ''));
    accounts.setRole(name, body?.role === 'admin' ? 'admin' : 'viewer');
    audit.warn(`Account "${name}" (${accounts.roleOf(name)}) created: ${by(req, user)}`);
    return { accounts: accounts.list() };
  });
  r.add('PATCH', '/api/accounts/:name', (req, res, { params, body, user }) => {
    requireConfirmed(req);
    accounts.setRole(params.name, body?.role);
    // a role change takes effect on the next request; nothing to sign out
    audit.warn(`Account "${params.name}" is now ${body?.role}: ${by(req, user)}`);
    return { accounts: accounts.list() };
  });
  r.add('DELETE', '/api/accounts/:name', (req, res, { params, user }) => {
    requireConfirmed(req);
    if (params.name === user) throw new HttpError(400, 'You cannot remove the account you are signed in with.');
    accounts.remove(params.name);
    audit.warn(`Account "${params.name}" removed: ${by(req, user)}`);
    return { accounts: accounts.list() };
  });
  r.add('POST', '/api/auth/setup', async (req, res, { body }) => {
    refuseBanned(req);
    const key = `setup:${clientKey(req)}`;
    const wait = auth.throttled(key);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} s.`);
    try {
      auth.setup(String(body?.username || ''), String(body?.password || ''), body?.code);
    } catch (err) {
      if (err.status === 403) {
        auth.noteFailure(key);
        audit.warn(`Account setup with a wrong setup code from ${clientKey(req)}`);
        if (failedAttempt(req, 'wrong setup code')) throw Object.assign(new HttpError(429, BANNED_TEXT), { code: 'BANNED', expose: true });
      }
      throw err;
    }
    auth.login(req, res, body.username, { ip: clientKey(req) });
    audit.info(`Account "${body.username}" created with the setup code: ${by(req, body.username)}`);
    return { ok: true };
  }, { public: true });
  r.add('POST', '/api/auth/logout', (req, res, { user }) => {
    auth.logout(req, res);
    audit.info(`Signed out: ${by(req, user)}`);
    return { ok: true };
  });
  r.add('POST', '/api/auth/confirm', async (req, res, { body, user }) => {
    refuseBanned(req);
    const key = `confirm:${user}`;
    const wait = auth.throttled(key);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} s.`);
    if (!(await guarded([key], () => auth.confirm(req, user, body?.password)))) {
      auth.noteFailure(key);
      audit.warn(`Password confirmation failed: ${by(req, user)}`);
      if (failedAttempt(req, 'wrong password confirmation', { session: true })) throw Object.assign(new HttpError(429, BANNED_TEXT), { code: 'BANNED', expose: true });
      throw new HttpError(401, 'That password is not right.');
    }
    auth.noteSuccess(key);
    audit.info(`Password confirmed for sensitive changes: ${by(req, user)}`);
    return { ok: true };
  });
  r.add('POST', '/api/auth/password', async (req, res, { body, user }) => {
    // the same throttle as confirmation: a stolen session must not guess the
    // password here instead
    refuseBanned(req);
    const key = `confirm:${user}`;
    const wait = auth.throttled(key);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} s.`);
    if (!(await guarded([key], () => auth.check(user, body?.current)))) {
      auth.noteFailure(key);
      audit.warn(`Password change with a wrong current password: ${by(req, user)}`);
      if (failedAttempt(req, 'wrong current password', { session: true })) throw Object.assign(new HttpError(429, BANNED_TEXT), { code: 'BANNED', expose: true });
      throw new HttpError(401, 'The current password is wrong.');
    }
    auth.noteSuccess(key);
    auth.setPassword(user, String(body?.next || ''));
    db.deleteSessionsFor(user);
    auth.forgetConfirmations();
    auth.login(req, res, user, { ip: clientKey(req) });
    audit.info(`Password changed (all other sessions signed out): ${by(req, user)}`);
    return { ok: true };
  });

  r.add('GET', '/api/system', async (req) => ({
    version: buildInfo,
    converter: host.runtime ? { ready: true, capabilities: host.runtime.capabilities } : { ready: false, error: host.lastError?.code || null },
    nativeHelper: host.helperAvailable,
    gpu: await detectGpus(),
    dataFree: await diskSpace(fs.promises, DATA).then((s) => s.free).catch(() => null),
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
    canPort?.server()?.setSecureContext?.({ key: out.key, cert: out.cert });
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

  // Settings → Security, for a server open to the internet: bans, the
  // two-step rules and the home network (server/access.js)
  const accessView = (req) => {
    const ip = clientKey(req);
    return {
      settings: access.get(), bans: access.list(), watching: access.watching(),
      you: { address: ip, banKey: banKey(ip), home: access.isHome(ip) },
      trustProxy: TRUST_PROXY, trustedProxies: process.env.TRUSTED_PROXIES || null,
      twoFactor: { yours: accounts.twoFactorOn(auth.user(req)), without: accounts.list().filter((a) => !a.twoFactor).map((a) => a.username) }
    };
  };
  r.add('GET', '/api/security/access', (req) => accessView(req));
  r.add('PUT', '/api/security/access', (req, res, { body, user }) => {
    requireConfirmed(req);
    const before = access.get();
    const next = validateAccess(body?.settings ?? body, before);
    // never lock yourself out with the change itself
    const mine = accounts.twoFactorOn(user);
    const home = access.isHome(clientKey(req));
    if (next.twoFactor.everyone && !before.twoFactor.everyone && !mine) throw new HttpError(409, 'Turn on two-step sign-in for your own account first (Account), then every account can be made to need it.');
    if (next.twoFactor.outside && !before.twoFactor.outside && !mine && !home) throw new HttpError(409, 'You are outside the home network without two-step sign-in: this would sign you out. Turn it on for your account first (Account).');
    access.set(next);
    const changes = [];
    for (const part of Object.keys(next)) {
      for (const k of Object.keys(next[part])) {
        const a = JSON.stringify(before[part][k]);
        const b = JSON.stringify(next[part][k]);
        if (a !== b) changes.push(`${part}.${k} ${a} → ${b}`);
      }
    }
    if (changes.length) audit.warn(`Security settings changed (${changes.join(', ')}): ${by(req, user)}`);
    return accessView(req);
  });
  r.add('POST', '/api/security/unban', (req, res, { body, user }) => {
    access.unban(String(body?.address || '').slice(0, 64), by(req, user));
    return accessView(req);
  });

  // Overview > Logs: the newest lines first; problems (warnings and errors)
  // unless everything is asked for. The download is the whole kept file.
  r.add('GET', '/api/logs', (req, res, { query }) => ({
    lines: logger.recent(Math.min(1000, Number(query.limit) || 300), { minLevel: query.level === 'all' ? 'debug' : 'warn' }).reverse()
  }));
  // The support chat is gone; its ticket and access token are not kept
  if (db.get('supportTicket', null) !== null) db.set('supportTicket', null);
  // ---- Settings > Interface
  r.add('GET', '/api/ui-packs', (req) => ({ active: uiPacks.active(), packs: uiPacks.list(), original: originalOnly(req) }));
  r.add('PUT', '/api/ui-packs/active', (req, res, { body, user }) => {
    const id = body?.id ?? null;
    if (id !== null && typeof id !== 'string') throw new HttpError(400, 'Choose an interface.');
    // a pack's scripts run as whoever signs in: the password again
    if (id !== null) requireConfirmed(req);
    const before = uiPacks.active();
    const now = uiPacks.setActive(id);
    // and this browser leaves /original, to see the choice
    if (originalOnly(req)) res.setHeader('Set-Cookie', `${UI_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${auth.isSecure(req) ? '; Secure' : ''}`);
    // every open page loads the new interface
    if (now !== before) announce('interface');
    if (now !== before) (now ? audit.warn : audit.info).call(audit, `Interface: ${now ? `"${uiPacks.list().find((x) => x.id === now)?.name}" (${now})` : 'the built-in one'}, for everyone: ${by(req, user)}`);
    return { ok: true, active: now };
  });
  r.add('DELETE', '/api/ui-packs/:id', async (req, res, { params, user }) => {
    const name = uiPacks.list().find((x) => x.id === params.id)?.name;
    const wasActive = uiPacks.active() === params.id;
    await uiPacks.remove(params.id);
    if (wasActive) announce('interface');
    audit.info(`Interface "${name}" (${params.id}) deleted: ${by(req, user)}`);
    return { ok: true, active: uiPacks.active() };
  });
  let originalZip = null;
  r.add('GET', '/api/ui-packs/original.zip', async (req, res) => {
    originalZip ??= await originalPack({ web: WEB, studio: path.join(SRC, 'renderer'), version: process.env.APP_VERSION || '' });
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="sentry-six-manager-interface.zip"', 'Content-Length': originalZip.length, 'Cache-Control': 'no-store' });
    res.end(originalZip);
  });

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

  // ---- metrics (Prometheus text): the numbers a dashboard needs, nothing private
  const startedAt = Date.now();
  function metricsText() {
    const lines = [];
    const metric = (name, help, type, rows) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of rows) if (Number.isFinite(value)) lines.push(`${name}${labels} ${value}`);
    };
    const lab = (v) => `{vehicle="${String(v.id).replace(/["\\\n]/g, '_')}"}`;
    const list = vehicles.list();
    const st = (v) => vehicles.share(v.id)?.status?.() || {};
    metric('sentry_up', 'The app is running', 'gauge', [['', 1]]);
    metric('sentry_uptime_seconds', 'Seconds since the app started', 'gauge', [['', Math.round((Date.now() - startedAt) / 1000)]]);
    metric('sentry_process_resident_bytes', 'Memory the app uses', 'gauge', [['', process.memoryUsage().rss]]);
    metric('sentry_share_up', 'The footage share can be read (1) or not (0)', 'gauge', list.map((v) => [lab(v), st(v).healthy ? 1 : 0]));
    metric('sentry_share_writable', 'The footage share can be written', 'gauge', list.map((v) => [lab(v), st(v).writable ? 1 : 0]));
    metric('sentry_share_free_bytes', 'Free space on the footage share', 'gauge', list.map((v) => [lab(v), st(v).freeBytes ?? NaN]));
    metric('sentry_share_total_bytes', 'Size of the footage share', 'gauge', list.map((v) => [lab(v), st(v).totalBytes ?? NaN]));
    metric('sentry_footage_bytes', 'Footage size', 'gauge', list.map((v) => [lab(v), inventory.totals(v.id)?.bytes ?? NaN]));
    metric('sentry_recordings', 'Recordings', 'gauge', list.map((v) => [lab(v), inventory.totals(v.id)?.recordings ?? NaN]));
    metric('sentry_recycle_bin_bytes', 'Bytes in the Recycle Bin', 'gauge', list.map((v) => [lab(v), bin.binBytes(v.id) ?? NaN]));
    metric('sentry_saved_bytes', 'Space saved by conversions', 'gauge', list.map((v) => [lab(v), savings.forVehicle(v.id)?.bytes ?? NaN]));
    metric('sentry_days_until_full', 'Days until the share is full at the last 14 days\' rate', 'gauge', list.map((v) => [lab(v), storageOf(v)?.daysLeft ?? NaN]));
    metric('sentry_conversion_running', 'A conversion is running', 'gauge', [['', converterRunning() ? 1 : 0]]);
    const open = db.notifications({ open: true, limit: 1000 });
    metric('sentry_notifications_open', 'Open notifications', 'gauge', ['critical', 'warning', 'info'].map((l) => [`{level="${l}"}`, open.filter((n) => n.level === l).length]));
    const last = health.last();
    metric('sentry_health_checks_failing', 'Health checks failing at the last run', 'gauge', [['', last ? last.checks.filter((c) => c.status === 'bad').length : NaN]]);
    return `${lines.join('\n')}\n`;
  }
  r.add('GET', '/api/metrics/settings', () => ({ enabled: Boolean(db.get('metrics', null)?.enabled) }));
  r.add('POST', '/api/metrics/enable', (req, res, { user }) => {
    requireConfirmed(req);
    const token = crypto.randomBytes(24).toString('base64url');
    db.set('metrics', { enabled: true, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), at: Date.now() });
    audit.warn(`Metrics turned on (new token): ${by(req, user)}`);
    return { enabled: true, token };
  });
  r.add('POST', '/api/metrics/disable', (req, res, { user }) => {
    requireConfirmed(req);
    db.set('metrics', { enabled: false });
    audit.warn(`Metrics turned off: ${by(req, user)}`);
    return { enabled: false };
  });
  // Notification rules: which kinds of notification are raised
  const NOTIFY_KINDS = ['share', 'storage', 'server', 'health', 'conversion', 'update', 'archive'];
  r.add('GET', '/api/notification-rules', () => {
    const muted = db.get('notify-muted', []) || [];
    return { rules: NOTIFY_KINDS.map((kind) => ({ kind, on: !muted.includes(kind) })) };
  });
  r.add('PUT', '/api/notification-rules', (req, res, { body, user }) => {
    const muted = NOTIFY_KINDS.filter((k) => body?.rules?.[k] === false);
    db.set('notify-muted', muted);
    audit.info(`Notification rules: ${muted.length ? `off for ${muted.join(', ')}` : 'all on'}: ${by(req, user)}`);
    return { rules: NOTIFY_KINDS.map((kind) => ({ kind, on: !muted.includes(kind) })) };
  });

  // ---- Settings → Health: checks with what to do, the startup self-check,
  // database snapshots, log search by date and the support bundle
  const health = createHealth({
    db, dataDir: DATA, vehicles, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, spawn,
    diskSpace: (dir) => diskSpace(fs.promises, dir), runtime: () => host.runtime, detectGpus, snapshots,
    tls: () => ({ mode: TLS_MODE, trustProxy: TRUST_PROXY, error: (() => { try { return tlsSource?.status()?.error || null; } catch (err) { return err.message; } })() }),
    log: logger.scope('health')
  });
  // after every start: what fails is a notification and the amber bar on every page
  const healthLog = logger.scope('health');
  setTimeout(() => {
    health.run({ startup: true }).then((res) => {
      const bad = res.checks.filter((c) => c.status === 'bad');
      for (const c of res.checks) {
        if (c.status === 'bad') notes.raise({ kind: 'health', level: 'critical', dedupeKey: `health:${c.id}`, title: `Startup check: ${c.label}${c.detail ? `: ${c.detail}` : ''}`, message: c.hint || 'Settings → Health has the details.' });
        else notes.resolve(`health:${c.id}`);
      }
      if (bad.length) healthLog.error(`Startup check: ${bad.map((c) => `${c.label}${c.detail ? ` (${c.detail})` : ''}`).join('; ')}`);
      else healthLog.info(`Startup check: all ${res.checks.length} checks passed or were skipped`);
    }).catch((err) => healthLog.warn(`Startup check did not run: ${err.message}`));
  }, 60_000).unref?.();
  r.add('GET', '/api/health', async () => health.last() || health.run());
  r.add('POST', '/api/health/run', async () => health.run());
  // for the amber bar (web/critical.js): what the startup check found broken
  // (a vehicle's check says which vehicle: three cars on one full disk read
  // "Free space on the share" three times)
  r.add('GET', '/api/health/banner', () => {
    const last = health.last();
    const named = (c) => (/^Vehicle: /.test(c.group || '') ? `${c.group.slice(9)}: ${c.label}` : c.label);
    return { problems: last ? last.checks.filter((c) => c.status === 'bad').map((c) => ({ label: named(c), detail: c.detail })) : [] };
  });
  r.add('GET', '/api/snapshots', () => ({ snapshots: snapshots.list(), keep: 7 }));
  r.add('POST', '/api/snapshots', (req, res, { user }) => {
    const name = snapshots.take({ force: true });
    audit.info(`Database snapshot ${name} made: ${by(req, user)}`);
    return { snapshots: snapshots.list() };
  });
  r.add('POST', '/api/snapshots/:name/restore', (req, res, { params, user }) => {
    // it replaces accounts and settings: the password again
    requireConfirmed(req);
    snapshots.prepareRestore(params.name);
    audit.warn(`Database snapshot ${params.name} chosen to restore; restarting: ${by(req, user)}`);
    setTimeout(() => shutdown('restore'), 500);
    return { ok: true, restarting: true };
  });
  // Logs between two dates (and archived ones), optionally filtered by text
  r.add('GET', '/api/logs/search', async (req, res, { query }) => {
    const at = (v, end) => { if (!v) return null; const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${end ? '23:59:59.999' : '00:00:00'}` : v); return Number.isFinite(t) ? t : null; };
    const lines = await logger.search({ from: at(query.from, false), to: at(query.to, true), text: query.q || '', minLevel: ['debug', 'info', 'warn', 'error'].includes(query.level) ? query.level : 'info', limit: query.download ? 50000 : 2000 });
    if (!query.download) return { lines: lines.reverse() };
    const text = lines.map((l) => `${new Date(l.at).toISOString()} ${l.level.toUpperCase().padEnd(5)} [${l.scope}] ${l.message}`).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename="sentry-six-manager-${query.from || 'start'}-to-${query.to || 'now'}.log"` });
    res.end(`${text}\n`);
    return undefined;
  });
  // Support bundle: what someone helping needs, without passwords (already
  // masked in the logs), footage paths, share names, IP addresses or e-mails
  r.add('GET', '/api/support-bundle', async (req, res) => {
    const list = vehicles.list();
    const swaps = [];
    list.forEach((v, i) => {
      for (const p of [vehicles.rootOf(v), vehicles.studioRoot?.(v), v.source?.path]) if (p && p.length > 1) swaps.push([p, `<footage-${i + 1}>`]);
      if (v.source?.share) swaps.push([v.source.share, `<share-${i + 1}>`]);
      if (v.source?.username) swaps.push([v.source.username, `<share-user-${i + 1}>`]);
      if (v.name) swaps.push([v.name, `<vehicle-${i + 1}>`]);
    });
    swaps.push([DATA, '<data>']);
    swaps.sort((a, b) => b[0].length - a[0].length);
    const scrub = (text) => {
      let t = String(text);
      for (const [from, to] of swaps) t = t.split(from).join(to);
      return t.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>').replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<email>')
        .replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, '<ip6>');
    };
    const week = Date.now() - 7 * 86400000;
    const lines = await logger.search({ from: week, minLevel: 'info', limit: 50000 });
    const results = health.last() || await health.run();
    const system = {
      made: new Date().toISOString(), version: buildInfo, node: process.version, platform: `${process.platform} ${process.arch}`,
      supervised: SUPERVISED, tlsMode: TLS_MODE, trustProxy: TRUST_PROXY, timezone: process.env.TZ || null,
      gpus: await detectGpus().catch(() => []), converter: host.runtime ? host.runtime.capabilities : { ready: false },
      vehicles: list.map((v, i) => {
        const st = vehicles.share(v.id)?.status?.() || {};
        return { vehicle: `<vehicle-${i + 1}>`, type: v.source?.type, healthy: st.healthy, writable: st.writable, freeBytes: st.freeBytes, totalBytes: st.totalBytes, recordings: inventory.totals(v.id)?.recordings ?? null, policy: policies.get(v.id) };
      }),
      uiPack: uiPacks.active()
    };
    const files = [
      { name: 'README.txt', data: Buffer.from('Sentry Six Manager support bundle.\nsystem.json: version, GPUs, converter, shares (no paths or names).\nhealth.json: Settings > Health checks.\nlogs.txt: the last 7 days of logs.\nsentryusb-security.csv: the Sentry USB security log (the newest 1000 rows).\nPasswords are masked in logs; footage paths, share names, vehicle names, IP addresses and e-mail addresses are replaced with <placeholders>.\n') },
      { name: 'system.json', data: Buffer.from(scrub(JSON.stringify(system, null, 2))) },
      { name: 'health.json', data: Buffer.from(scrub(JSON.stringify(results, null, 2))) },
      { name: 'logs.txt', data: Buffer.from(scrub(lines.map((l) => `${new Date(l.at).toISOString()} ${l.level.toUpperCase().padEnd(5)} [${l.scope}] ${l.message}`).join('\n'))) },
      // the Sentry USB security log (no keys or passwords are ever in it; addresses become <ip>)
      { name: 'sentryusb-security.csv', data: Buffer.from(scrub(securityLog.csv(securityLog.list({ limit: 1000 }), (id) => sentryLink.name(id) || id))) }
    ];
    const zip = writeZip(files);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="sentry-six-manager-support-${new Date().toISOString().slice(0, 10)}.zip"` });
    res.end(zip);
    return undefined;
  });

  r.add('GET', '/api/vehicles', async () => {
    const list = vehicles.list();
    // days with footage from any vehicle (two cars on one day: one day)
    const footageDays = new Set(list.flatMap((v) => inventory.footageDays(v.id))).size;
    const out = [];
    for (const v of list) out.push(await withCar(v));
    // (the choices of the vehicle settings' "Car model" and "Year")
    return { vehicles: out, footageDays, carModels: carModels.choices() };
  });

  // ---- Export: a stretch of footage rendered into one MP4 (server/exporter.js)
  const exporter = createExporter({
    dir: path.join(DATA, 'exports'), ffmpegPath: FFMPEG, ffprobePath: FFPROBE,
    jobs, log: logger.scope('export'), clock24: () => Boolean(db.get('appearance', {}).clock24),
    // a file of this vehicle's footage, as a real path, or null
    resolve: async (p, vehicle) => {
      const real = await studioReadable.resolve(p);
      if (!real || hiddenPath(real)) return null;
      return vehicleForReal(real)?.vehicle.id === vehicle.id ? real : null;
    },
    // the speed of each second of a clip, from the speed index
    speedsFor: async (real) => {
      const owner = vehicleForReal(real);
      if (!owner) return null;
      const st = await fs.promises.stat(real);
      return speedIndex.clip(owner.vehicle.id, path.relative(owner.root, real).split(path.sep).join('/'), real, st.size, st.mtimeMs);
    }
  });
  exporter.tidy().catch((err) => logger.scope('export').warn(`Exports folder: ${err.message}`));
  setInterval(() => exporter.tidy().catch(() => {}), 3600 * 1000).unref();
  r.add('POST', '/api/vehicles/:id/exports', async (req, res, { params, body }) => exporter.start({ vehicle: vehicleOr404(params.id), body }));
  // the built-in Viewer: the vehicle is the one whose footage the clips are
  r.add('POST', '/api/exports', async (req, res, { body }) => {
    const first = Object.values(body?.clips?.[0]?.files || {}).find((p) => typeof p === 'string');
    const real = first ? await studioReadable.resolve(first) : null;
    const owner = real && !hiddenPath(real) ? vehicleForReal(real) : null;
    if (!owner) throw new HttpError(400, 'These clips are not in any vehicle\'s footage.');
    return exporter.start({ vehicle: owner.vehicle, body });
  });
  r.add('GET', '/api/exports', (req, res, { query }) => ({ exports: exporter.list(query.vehicle || null) }));
  r.add('GET', '/api/exports/:id', (req, res, { params }) => {
    const x = exporter.get(params.id);
    if (!x) throw new HttpError(404, 'No such export (exports are kept for a day).');
    return x;
  });
  r.add('DELETE', '/api/exports/:id', (req, res, { params }) => ({ ok: exporter.cancel(params.id) }));
  r.add('GET', '/api/exports/:id/file', async (req, res, { params }) => {
    const f = exporter.file(params.id);
    if (!f) throw new HttpError(404, 'This export is not ready, or it was removed after a day.');
    const st = await fs.promises.stat(f.file);
    res.writeHead(200, {
      'Content-Type': 'video/mp4', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="${f.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`
    });
    fs.createReadStream(f.file).pipe(res);
    return undefined;
  });
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
      // Everything is checked (and the password asked for) before anything
      // is saved: a request refused part way used to keep its earlier parts.
      if (body?.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) throw new HttpError(400, 'Enter a name.');
      if (body?.trusted !== undefined && typeof body.trusted !== 'boolean') throw new HttpError(400, 'Trusted is on or off.');
      // trusted: its encodes then replace originals without the picture check
      if (body?.trusted === true) requireConfirmed(req);
      let cars;
      if (body?.cars !== undefined) {
        if (!Array.isArray(body.cars) || body.cars.some((id) => typeof id !== 'string')) throw new HttpError(400, 'A list of vehicles.');
        // a vehicle removed meanwhile is left out instead of refusing the list
        const known = new Set(vehicles.list().map((v) => v.id));
        cars = body.cars.filter((id) => known.has(id));
      }
      if (body?.name !== undefined) {
        const renamed = nodes.rename(params.id, body.name);
        audit.info(`Node "${renamed.previous}" renamed "${renamed.name}": ${by(req, user)}`);
        out.name = renamed.name;
      }
      if (body?.trusted !== undefined) {
        out.trusted = nodes.setTrusted(params.id, body.trusted);
        (out.trusted ? audit.warn : audit.info).call(audit, `Node ${params.id} ${out.trusted ? 'trusted: its encodes skip the picture check' : 'no longer trusted: its encodes get the picture check'}: ${by(req, user)}`);
      }
      if (cars) {
        out.cars = nodes.setCars(params.id, cars);
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
    // (slots and use: from an older page; the main picks devices and numbers now)
    const status = nodeWorker.setEnabled(body?.enabled === true, body?.slots, body?.use);
    audit.info(`Node mode ${status.enabled ? 'on' : 'off'}: ${by(req, user)}`);
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

  // Settings > a vehicle > Test connection: the typed SMB details, nothing saved
  r.add('POST', '/api/vehicles/test-smb', async (req, res, { body, user }) => {
    const vehicleId = typeof body?.vehicleId === 'string' && body.vehicleId ? body.vehicleId : null;
    if (vehicleId) vehicleOr404(vehicleId);
    const result = await smbTester.test(body?.source, vehicleId);
    audit.info(`SMB connection test of ${String(body?.source?.share || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 200)}: ${result.ok ? 'connected' : `failed (${result.stage})`}: ${by(req, user)}`);
    return result;
  });
  r.add('POST', '/api/vehicles', (req, res, { body, user }) => {
    requireConfirmed(req);
    const v = vehicles.add(body || {});
    audit.info(`Vehicle "${v.name}" (${v.id}) added, ${describeSource(v.source)}: ${by(req, user)}`);
    return withCar(v);
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
    const carWas = carModels.normalizeCar(before.car);
    const carNow = carModels.normalizeCar(v.car);
    if (carWas.model !== carNow.model || carWas.generation !== carNow.generation) {
      const say = (c) => (c.model === 'auto' ? 'Automatic' : `Model ${c.model}${c.generation === 'auto' ? '' : ` ${carModels.generationById(c.generation)?.label || c.generation}`}`);
      audit.info(`Vehicle ${v.id} car model: ${say(carWas)} -> ${say(carNow)}: ${by(req, user)}`);
      // (a car whose DBC set changes has its CAN logs decoded again, in the background)
      canIndexRef?.kick();
    }
    return withCar(v);
  });
  // Space saved starts over for one vehicle (its footage is gone, say).
  // Only the number: no footage or conversion is touched.
  r.add('DELETE', '/api/vehicles/:id/saved', (req, res, { params, user }) => {
    const v = vehicleOr404(params.id);
    const before = savings.forVehicle(v.id);
    savings.reset(v.id);
    audit.info(`Space saved of "${v.name}" reset (was ${formatBytes(before.bytes)}, ${before.clips} clips): ${by(req, user)}`);
    announce('inventory');
    return { ok: true, saved: savings.forVehicle(v.id) };
  });
  r.add('DELETE', '/api/vehicles/:id', async (req, res, { params, user }) => {
    requireConfirmed(req);
    const v = vehicleOr404(params.id);
    await vehicles.remove(params.id);
    savings.forget(params.id);
    archiveGapRef?.forget(params.id);
    sentryUsb.forget(params.id);
    driveData.forget(params.id);
    arrivalRef?.forget(params.id);
    { const rec = { ...(db.get('sentry-usb-record', {}) || {}) }; if (rec[params.id]) { delete rec[params.id]; db.set('sentry-usb-record', rec); } }
    // and from every node's Vehicles first list
    nodes.forgetCar(params.id);
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
  /** rec -> whether CAN Bridge data covers it (as the Viewer would show), or null when there is none to look at. */
  const canOf = async (vehicleId) => {
    if (!canFootageRef) return null;
    try { return await canFootageRef.forVehicle(vehicleOr404(vehicleId)); } catch (err) { log.warn(`CAN tags: ${err.message}`); return null; }
  };
  const filtered = (vehicleId, query) => {
    let list = inventory.get(vehicleId)?.recordings || [];
    if (query.category && query.category !== 'all') list = list.filter((x) => x.category === query.category);
    if (query.date) list = list.filter((x) => x.day === query.date);
    return list;
  };
  // Footage by day: the day cards (their recordings come from /recordings?date=)
  r.add('GET', '/api/vehicles/:id/days', async (req, res, { params, query }) => {
    vehicleOr404(params.id);
    const inv = inventory.get(params.id);
    const days = inventory.days(params.id, filtered(params.id, query));
    const offset = Math.max(0, Number(query.offset) || 0);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 30));
    // how much of each day the speed index has read (the "Indexed" tag)
    const shown = days.slice(offset, offset + limit);
    const idx = await speedIndex.progress(params.id, shown.map((d) => d.day)).catch(() => ({}));
    // footage that looks only partly copied to the share yet (the "Partly archived?" tag)
    const gaps = archiveGapRef ? archiveGapRef.forDays(params.id) : {};
    for (const d of shown) { d.speedIndex = idx[d.day] || { clips: 0, indexed: 0 }; d.archive = gaps[d.day] || null; }
    // how many of each day's recordings have CAN Bridge data (the green "CAN" tag)
    const hasCan = await canOf(params.id);
    if (hasCan) {
      const want = new Map(shown.map((d) => [d.day, d]));
      for (const d of shown) d.canRecordings = 0;
      for (const rec of filtered(params.id, query)) { const d = want.get(rec.day); if (d && hasCan(rec)) d.canRecordings++; }
    }
    return {
      // Sentry USB's status file on this share (as GET /api/vehicles/:id/sentry-usb)
      sentryUsb: sentryUsb.api(params.id),
      total: days.length, recordings: days.reduce((n, d) => n + d.recordings, 0), offset, limit,
      scannedAt: inv?.scannedAt || null, scanning: Boolean(inv?.scanning), error: inv?.lastError || null,
      dates: [...new Set((inv?.recordings || []).map((x) => x.day))].sort().reverse(),
      days: days.slice(offset, offset + limit)
    };
  });
  // "Delete this day" / "Delete through this date": the recordings of that day
  // (or that day and every older one) go to the Recycle Bin, protected ones
  // stay. preview: true only counts them for the confirmation.
  r.add('POST', '/api/vehicles/:id/trash-days', async (req, res, { params, body, user }) => {
    const v = vehicleOr404(params.id);
    const day = String(body?.day || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, 'Choose a day.');
    const list = filtered(v.id, { category: body?.category }).filter((x) => (body?.through ? x.day <= day : x.day === day));
    const movable = list.filter((x) => !x.protected);
    const summary = {
      recordings: movable.length, bytes: movable.reduce((n, x) => n + x.bytes, 0), protected: list.length - movable.length,
      days: new Set(movable.map((x) => x.day)).size, oldest: movable.length ? movable.reduce((a, x) => (x.day < a ? x.day : a), day) : null
    };
    // "Also delete its CAN data": the logs of the moved recordings' minutes, and with Delete through
    // this date every log of the car up to the end of that day (not those still covered by footage
    // that stays: protected, or another category); can: null when no CAN Bridge key is mapped to the car
    const until = body?.through ? zonedToUtc(...day.split('-').map(Number), 23, 59, 59, v.timezone || 'UTC') + 1000 : null;
    if (body?.preview === true || !movable.length) {
      const can = movable.length ? await canWith(v.id, { rels: movable.flatMap((x) => x.files), until }) : null;
      return { ...summary, can, started: false };
    }
    const withCan = body?.withCan === true;
    const ids = new Set(movable.map((x) => x.id));
    const recs = new Map(movable.map((x) => [x.id, x]));
    bin.trash(v.id, [...ids]).then(async (out) => {
      // only when footage really moved, and only the minutes of the recordings that did (not protected or converting ones)
      if (!withCan || !out?.moved?.length) return;
      const rels = out.moved.flatMap((id) => recs.get(id)?.files || []);
      const r = await canPruneRef?.deleteWith(v.id, { rels, until, by: by(req, user) });
      if (r) log.info(`CAN data with ${v.name}'s footage: ${r.skip ? `none deleted (${r.skip})` : `${r.removed} deleted, ${r.kept} kept (footage that stays), ${r.pending} still arriving`}`);
      announce('can');
    }).catch((err) => log.warn(`Moving ${v.name}'s footage to the Recycle Bin failed: ${err.message}`))
      .finally(() => {
        announce('inventory');
        announce('bin');
      });
    return { ...summary, started: true };
  });
  r.add('GET', '/api/vehicles/:id/recordings', async (req, res, { params, query }) => {
    vehicleOr404(params.id);
    const inv = inventory.get(params.id);
    let list = filtered(params.id, query);
    if (query.protected === '1') list = list.filter((x) => x.protected);
    const offset = Math.max(0, Number(query.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 100));
    const page = list.slice(offset, offset + limit);
    const places = placeList();
    const tagged = page.map(publicRecording);
    // recordings with CAN Bridge data (the green "CAN" tag): can: true, else left out
    const hasCan = await canOf(params.id);
    if (hasCan) page.forEach((rec, i) => { if (hasCan(rec)) tagged[i].can = true; });
    // recordings at a saved place get its name (place: started and ended there), else from and to
    // when it started or ended at one; placeSource says from what: CAN Bridge GPS, the cameras'
    // GPS (the speed index) or an event's event.json (recordingPlace.js)
    if (places.length && recPlacesRef) {
      const v = vehicleOr404(params.id);
      const placeOf = (pos) => placesLib.placeOf(pos, places);
      const eventPos = async (rec) => (await eventSpot(params.id, rec).catch(() => null))?.pos || null;
      await eachLimit(page.map((rec, i) => [rec, i]), 6, async ([rec, i]) => {
        try {
          Object.assign(tagged[i], await recPlacesRef.tag(v, rec, { hasCan, eventPos, placeOf }));
        } catch (err) {
          log.warn(`Place tag: ${err.message}`);
        }
      });
    }
    return {
      total: list.length, offset, limit, scannedAt: inv?.scannedAt || null, scanning: Boolean(inv?.scanning), error: inv?.lastError || null,
      dates: [...new Set((inv?.recordings || []).map((x) => x.day))].sort().reverse(),
      recordings: tagged
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
  // The Viewer's speed graph: a day's indexed speeds (one value a second per
  // front clip, keyed by the clip's path as the recording lists it) ...
  r.add('GET', '/api/vehicles/:id/speeds', async (req, res, { params, query }) => {
    const v = vehicleOr404(params.id);
    const root = vehicles.rootOf(v);
    const byRel = await speedIndex.day(v.id, String(query.date || ''));
    return { speeds: Object.fromEntries(Object.entries(byRel).map(([rel, sp]) => [path.join(root, rel), sp])) };
  });
  // Find moments: a day's hard braking, swerves and top speeds (speedIndex.moments)
  const clipKeyOf = (rel) => (/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/.exec(rel) || [])[1] || null;
  r.add('GET', '/api/vehicles/:id/moments', async (req, res, { params, query }) => {
    const v = vehicleOr404(params.id);
    const day = String(query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, 'Give a day (date=YYYY-MM-DD).');
    const root = vehicles.rootOf(v);
    const list = await speedIndex.moments(v.id, day);
    const idx = (await speedIndex.progress(v.id, [day]).catch(() => ({})))[day] || { clips: 0, indexed: 0 };
    // the day in numbers, from the front camera's speed a second: how far
    // (speed × 1 s), how long moving (over 0.5 m/s), how fast
    let distance = 0;
    let driving = 0;
    let top = 0;
    for (const sp of Object.values(await speedIndex.day(v.id, day))) {
      for (const x of sp || []) {
        if (!Number.isFinite(x)) continue;
        distance += x;
        if (x > 0.5) driving += 1;
        if (x > top) top = x;
      }
    }
    return {
      moments: list.map((m) => ({ kind: m.kind, path: path.join(root, m.rel), clip: clipKeyOf(m.rel), second: m.second, value: m.value })),
      clips: idx.clips, indexed: idx.indexed,
      summary: { distance: Math.round(distance), driving, top: Math.round(top * 100) / 100 }
    };
  });
  // Starred moments: a moment marked with a note, kept on the server for
  // every interface; starring one also protects its recording, so policies
  // and Delete through this date leave it alone
  const MAX_STARS = 2000;
  const starList = () => (Array.isArray(db.get('stars', [])) ? db.get('stars', []) : []);
  const cleanNote = (n) => String(n ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
  r.add('GET', '/api/stars', (req, res, { query }) => {
    const vid = query.vehicle ? String(query.vehicle) : null;
    const known = new Set(vehicles.list().map((v) => v.id));
    return { stars: starList().filter((x) => known.has(x.vehicle) && (!vid || x.vehicle === vid)).sort((a, b) => `${b.clip}`.localeCompare(`${a.clip}`) || b.second - a.second) };
  });
  const recordingOfClip = (vid, clip) => (inventory.get(vid)?.recordings || []).find((x) => x.files.some((rel) => rel.includes(clip)));
  r.add('POST', '/api/stars', async (req, res, { body, user }) => {
    const v = vehicleOr404(String(body?.vehicle || ''));
    const clip = String(body?.clip || '');
    const second = Math.floor(Number(body?.second));
    if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(clip) || !Number.isFinite(second) || second < 0 || second > 7200) throw new HttpError(400, 'Give the clip and second to star.');
    const list = starList();
    if (list.length >= MAX_STARS) throw new HttpError(400, `There are ${MAX_STARS} starred moments already: remove some first.`);
    const star = { id: crypto.randomBytes(6).toString('hex'), vehicle: v.id, day: clip.slice(0, 10), clip, second, note: cleanNote(body?.note), createdAt: new Date().toISOString() };
    // its recording is protected (by an admin's star: a watch-only account changes nothing kept)
    const rec = recordingOfClip(v.id, clip);
    const mayProtect = adminHere(req, user);
    if (rec && !rec.protected && mayProtect) star.protects = rec.id;
    db.set('stars', [...list, star]);
    if (star.protects) {
      await bin.setProtected(v.id, rec.files, true);
      inventory.rebuild(v.id);
      announce('inventory');
    }
    return { star, protected: Boolean(rec && (rec.protected || star.protects)) };
  });
  r.add('PATCH', '/api/stars/:id', (req, res, { params, body }) => {
    const list = starList();
    const star = list.find((x) => x.id === params.id);
    if (!star) throw new HttpError(404, 'No such starred moment.');
    star.note = cleanNote(body?.note);
    db.set('stars', list);
    return { star };
  });
  r.add('DELETE', '/api/stars/:id', async (req, res, { params }) => {
    const list = starList();
    const star = list.find((x) => x.id === params.id);
    if (!star) throw new HttpError(404, 'No such starred moment.');
    const rest = list.filter((x) => x.id !== params.id);
    db.set('stars', rest);
    // a recording that only this star protected is no longer kept for it
    if (star.protects) {
      const rec = recordingOfClip(star.vehicle, star.clip);
      const others = rest.some((x) => x.vehicle === star.vehicle && rec && rec.files.some((rel) => rel.includes(x.clip)));
      if (rec?.protected && !others) {
        await bin.setProtected(star.vehicle, rec.files, false);
        inventory.rebuild(star.vehicle);
        announce('inventory');
      }
    }
    return { ok: true };
  });
  // Driving by week: distance, time moving, hard braking and swerves, top
  // speed and days driven, from the speed index (weeks start on Monday)
  r.add('GET', '/api/vehicles/:id/driving', async (req, res, { params, query }) => {
    const v = vehicleOr404(params.id);
    const weeks = Math.max(1, Math.min(52, Number(query.weeks) || 12));
    const monday = (d) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
    const thisWeek = monday(dayInZone(new Date(), v.timezone || 'UTC')); // the car's today, as footage days are
    const first = new Date(`${thisWeek}T12:00:00Z`);
    first.setUTCDate(first.getUTCDate() - 7 * (weeks - 1));
    const since = first.toISOString().slice(0, 10);
    const out = new Map();
    for (let i = 0; i < weeks; i++) {
      const w = new Date(first);
      w.setUTCDate(first.getUTCDate() + 7 * i);
      const key = w.toISOString().slice(0, 10);
      out.set(key, { week: key, distance: 0, driving: 0, top: 0, hardBrakes: 0, swerves: 0, days: 0 });
    }
    for (const d of inventory.footageDays(v.id).filter((x) => x >= since)) {
      const w = out.get(monday(d));
      if (!w) continue;
      let moved = false;
      for (const sp of Object.values(await speedIndex.day(v.id, d))) {
        for (const x of sp || []) {
          if (!Number.isFinite(x)) continue;
          w.distance += x;
          if (x > 0.5) { w.driving += 1; moved = true; }
          if (x > w.top) w.top = x;
        }
      }
      if (moved) w.days += 1;
      for (const m of await speedIndex.moments(v.id, d)) {
        if (m.kind === 'brake') w.hardBrakes += 1;
        else if (m.kind === 'swerve') w.swerves += 1;
      }
    }
    return { weeks: [...out.values()].map((w) => ({ ...w, distance: Math.round(w.distance), top: Math.round(w.top * 100) / 100 })) };
  });
  // The event map: every Sentry and Saved event with a position (Tesla's
  // event.json est_lat / est_lon), newest first; each event.json is read once
  // and kept while it does not change
  const eventSpots = new Map(); // `${vid}/${rel}` -> { stamp, info }
  /** An event recording's event.json (where and why), read once while it does not change. */
  async function eventSpot(vid, rec) {
    const inv = inventory.get(vid);
    const rel = rec.files.find((f) => /\/event\.json$/i.test(f));
    const f = rel && inv?.files?.get(rel);
    if (!f) return null;
    const key = `${vid}/${rel}`;
    const stamp = `${f.size}/${Math.round(f.mtimeMs)}`;
    let had = eventSpots.get(key);
    if (!had || had.stamp !== stamp) {
      had = { stamp, info: await inventory.eventInfo(vid, rec).catch(() => null) };
      // a failed read (the share dropped) is tried again next time
      if (had.info) eventSpots.set(key, had);
      if (eventSpots.size > 20000) eventSpots.delete(eventSpots.keys().next().value);
    }
    const lat = Number(had.info?.est_lat);
    const lon = Number(had.info?.est_lon);
    const pos = Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
    return { info: had.info, pos };
  }
  /** The saved place an event happened at (nearest within that place's radius, 200 m by default: the car's position is an estimate), or null. */
  const placeAt = (pos, places = placeList()) => placesLib.placeAt(pos, places);
  r.add('GET', '/api/vehicles/:id/event-map', async (req, res, { params }) => {
    const v = vehicleOr404(params.id);
    const inv = inventory.get(v.id);
    const recs = (inv?.recordings || []).filter((x) => x.eventId).sort((a, b) => String(b.startKey).localeCompare(String(a.startKey))).slice(0, 1000);
    const out = [];
    const places = placeList();
    await eachLimit(recs, 6, async (rec) => {
      const spot = await eventSpot(v.id, rec).catch(() => null);
      if (!spot?.pos) return;
      const { info } = spot;
      out.push({
        recording: rec.id, category: rec.category, day: rec.day, start: rec.start, startKey: rec.startKey, lat: spot.pos.lat, lon: spot.pos.lon,
        reason: info.reason || null, city: info.city || null, street: info.street || null, at: info.timestamp || null, place: placeAt(spot.pos, places)
      });
    });
    out.sort((a, b) => String(b.startKey).localeCompare(String(a.startKey)));
    return { events: out, withoutPosition: recs.length - out.length };
  });
  // Drives (server/drives.js): the car's trips, newest first, a page at a
  // time; each with its times, length, distance, where it started and ended
  // (a saved place, else the street and town of a Sentry or Saved event
  // there), CAN Bridge data, and where the Viewer starts it
  const DRIVE_SPOTS = 3000;
  const driveSpots = new WeakMap(); // recordings array -> event spots of that scan
  async function eventSpotsOf(vid) {
    const recsAll = inventory.get(vid)?.recordings;
    if (!recsAll) return [];
    let p = driveSpots.get(recsAll);
    if (!p) {
      p = (async () => {
        const recs = recsAll.filter((x) => x.eventId).sort((a, b) => String(b.startKey).localeCompare(String(a.startKey))).slice(0, DRIVE_SPOTS);
        const spots = [];
        await eachLimit(recs, 6, async (rec) => {
          const spot = await eventSpot(vid, rec).catch(() => null);
          if (spot?.pos && (spot.info?.city || spot.info?.street)) spots.push({ ...spot.pos, city: spot.info.city || null, street: spot.info.street || null });
        });
        return spots;
      })();
      driveSpots.set(recsAll, p);
    }
    return p;
  }
  const clipKeys = new WeakMap(); // clipsOf() list -> clip key -> clip
  const clipKeyMap = (clips) => {
    let m = clipKeys.get(clips);
    if (!m) { m = new Map(clips.map((c) => [c.key, c])); clipKeys.set(clips, m); }
    return m;
  };
  const keyOfMs = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  r.add('GET', '/api/vehicles/:id/drives', async (req, res, { params, query }) => {
    const v = vehicleOr404(params.id);
    const inv = inventory.get(v.id);
    const gapMin = query.gap === undefined ? drivesLib.DEFAULT_GAP_S / 60 : Number(query.gap);
    if (!Number.isFinite(gapMin) || gapMin < 1 || gapMin > 120) throw new HttpError(400, 'The gap is 1 to 120 minutes.');
    const limit = Math.max(1, Math.min(200, Math.floor(Number(query.limit)) || 50));
    const before = query.before ? String(query.before) : null;
    if (before && !/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(before)) throw new HttpError(400, 'before is a clip time (YYYY-MM-DD_HH-MM-SS).');
    const clips = drivesLib.clipsOf(inv?.recordings);
    const byDay = new Map();
    const statsFor = (c) => {
      const s = byDay.get(c.day);
      return s ? s[c.rel] || null : null;
    };
    const readDays = async (list) => {
      for (const c of list) if (!byDay.has(c.day)) byDay.set(c.day, await speedIndex.clipStats(v.id, c.day).catch(() => ({})));
    };
    const places = placeList();
    const labelFor = async (needSpots) => {
      const spots = needSpots ? await eventSpotsOf(v.id).catch(() => []) : [];
      return drivesLib.labeller({ placeOf: (pos) => placesLib.placeOf(pos, places), spots, metres: placesLib.metres });
    };
    // Sentry USB's drive data, when the car's share has it and it was read
    // (driveData.js): its drives; else (and while a first read runs) the clips'
    driveData.check(v.id).catch(() => null);
    const dd = driveData.view(v.id);
    const usbDrives = dd.usable ? driveData.drives(v.id, gapMin * 60) : [];
    if (usbDrives.length) {
      let i = 0;
      if (before) while (i < usbDrives.length && keyOfMs(usbDrives[i].startMs) >= before) i++;
      const page = usbDrives.slice(i, i + limit);
      const more = i + limit < usbDrives.length;
      const byKey = clipKeyMap(clips);
      const clipOf = (k) => byKey.get(k) || null;
      await readDays(page.flatMap((d) => d.keys.map(clipOf).filter(Boolean)));
      const label = await labelFor(page.some((d) => d.from || d.to));
      const hasCan = await canOf(v.id);
      const tags = driveData.tags(v.id);
      const list = page.map((d) => driveDataLib.describeDrive(d, { tags, clipOf, statsOf: statsFor, label, hasCan }));
      return {
        drives: list, more, next: more && list.length ? list[list.length - 1].id : null, gap: gapMin,
        source: 'sentry-usb', driveData: dd.meta, reading: dd.reading,
        scanning: Boolean(inv?.scanning), indexing: Boolean(speedIndex.status().running)
      };
    }
    const { drives, more } = await drivesLib.group(clips, async (c) => {
      if (!byDay.has(c.day)) byDay.set(c.day, await speedIndex.clipStats(v.id, c.day).catch(() => ({})));
      return statsFor(c);
    }, { gapS: gapMin * 60, limit, before });
    const label = await labelFor(drives.some((d) => d.clips.some((c) => statsFor(c)?.a)));
    const hasCan = await canOf(v.id);
    const list = drives.map((d) => drivesLib.describe(d, statsFor, { label, hasCan }));
    // where a drive with CAN Bridge data started and ended: its GPS (good fixes only) over the cameras'
    if (recPlacesRef && list.some((d) => d.can)) {
      const keys = [...await canKeysFor(v.id)].sort();
      const stamp = (wall) => wall.replace(' ', '_').replace(/:/g, '-');
      await eachLimit(list.filter((d) => d.can), 4, async (d) => {
        const { a, z } = await recPlacesRef.canEnds(keys, canStartOf(v, stamp(d.start)), canStartOf(v, stamp(d.end))).catch(() => ({ a: null, z: null }));
        if (a) d.from = { lat: a.lat, lon: a.lon, ...label({ lat: a.lat, lon: a.lon }) };
        if (z) d.to = { lat: z.lat, lon: z.lon, ...label({ lat: z.lat, lon: z.lon }) };
      });
    }
    return {
      drives: list,
      more,
      next: more && list.length ? list[list.length - 1].id : null,
      gap: gapMin,
      source: 'clips',
      driveData: dd.meta,
      reading: dd.reading,
      scanning: Boolean(inv?.scanning),
      indexing: Boolean(speedIndex.status().running)
    };
  });
  // The Viewer's stats dashboards (web/statDash.js): each account's own
  // (list: every stat, scrolled, with its own search kept as `q`)
  const DASH_TYPES = { small: 1, wide: 3, gauge: 1, state: 1, list: 0 };
  // a box's spot for wide and narrow screens: x a share of the room across the page (0 to 1), y a
  // share of the room down it, and top its place on the page in px (the page, not the window: it
  // scrolls with what is under it; a spot saved before has no top). The box is placed from its
  // spot relative to the cameras, which
  // reflow with the window: h (l, r, or R past their right) and v (t, b, or B below them), the
  // corner of them nearest the box, dx and dy its px from that corner, over whether it was put on the video, and bar the same for a
  // List put by a floating bar (web/statDash.js: spotFor). A spot may have either form, or both.
  const SCREENS = ['wide', 'narrow'];
  const share = (v) => Math.max(0, Math.min(1, v));
  const px = (v) => Math.round(Math.max(-100000, Math.min(100000, v)));
  const anchored = (a) => ['l', 'r', 'R'].includes(a?.h) && ['t', 'b', 'B'].includes(a?.v) && Number.isFinite(a?.dx) && Number.isFinite(a?.dy);
  const cleanAnchor = (a) => ({ h: a.h, v: a.v, dx: px(a.dx), dy: px(a.dy) });
  const cleanSpots = (o) => Object.fromEntries(SCREENS.map((k) => [k, o?.[k]]).filter(([, p]) => (Number.isFinite(p?.x) && Number.isFinite(p?.y)) || anchored(p))
    .map(([k, p]) => [k, {
      ...(Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: share(p.x), y: share(p.y) } : {}),
      ...(Number.isFinite(p.top) ? { top: Math.round(Math.max(0, Math.min(100000, p.top))) } : {}),
      ...(anchored(p) ? { ...cleanAnchor(p), over: p.over === true, ...(anchored(p.bar) ? { bar: cleanAnchor(p.bar) } : {}) } : {})
    }]));
  // a box's size for wide and narrow screens, in px (w only when it floats; either may be left out)
  const cleanSizes = (o) => Object.fromEntries(SCREENS.map((k) => [k, o?.[k]]).filter(([, z]) => Number.isFinite(z?.w) || Number.isFinite(z?.h))
    .map(([k, z]) => [k, { ...(Number.isFinite(z.w) ? { w: Math.round(Math.max(120, Math.min(8000, z.w))) } : {}), ...(Number.isFinite(z.h) ? { h: Math.round(Math.max(40, Math.min(8000, z.h))) } : {}) }]));
  const cleanBoards = (body) => {
    const boards = (Array.isArray(body?.boards) ? body.boards : []).slice(0, 12).map((b, i) => ({
      id: /^[\w-]{1,24}$/.test(String(b?.id)) ? String(b.id) : `b${i}`,
      name: String(b?.name ?? 'Dashboard').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40) || 'Dashboard',
      placement: ['over', 'float'].includes(b?.placement) ? b.placement : 'below',
      // where a bar pulled out to float goes back to ("Put back")
      barHome: b?.barHome === 'over' ? 'over' : 'below',
      // where a floating bar was moved to, and its size
      float: cleanSpots(b?.float),
      size: cleanSizes(b?.size),
      // the list box: under the car data (dock) or anywhere, where it was dragged; and its size
      listPlacement: b?.listPlacement === 'float' ? 'float' : 'dock',
      listFloat: cleanSpots(b?.listFloat),
      listSize: cleanSizes(b?.listSize),
      metric: typeof b?.metric === 'boolean' ? b.metric : null,
      blocks: (Array.isArray(b?.blocks) ? b.blocks : []).slice(0, 32).filter((x) => Object.hasOwn(DASH_TYPES, String(x?.type))).map((x) => ({
        type: x.type, signals: (Array.isArray(x.signals) ? x.signals : []).slice(0, DASH_TYPES[x.type]).map((id) => String(id)).filter((id) => /^[\w.:-]{1,80}$/.test(id)),
        ...(x.type === 'list' ? { q: String(x.q ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 60), changing: x.changing === true } : {})
      }))
    }));
    if (!boards.length) throw new HttpError(400, 'Send at least one dashboard.');
    const active = boards.some((b) => b.id === body?.active) ? body.active : boards[0].id;
    return { boards, active };
  };
  r.add('GET', '/api/dashboards', (req, res, { user }) => db.get(`dash:${user}`, null) || { boards: [], active: null });
  r.add('PUT', '/api/dashboards', (req, res, { body, user }) => {
    const clean = cleanBoards(body);
    db.set(`dash:${user}`, clean);
    return clean;
  });

  // Saved places: named spots (Home, Work) for the maps and the place search
  const placeList = () => (Array.isArray(db.get('places', [])) ? db.get('places', []) : []);
  const placeName = (n) => String(n ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60);
  r.add('GET', '/api/places', () => ({ places: placeList() }));
  const placeRadius = (v) => {
    const r = placesLib.cleanRadius(v);
    if (r === null) throw new HttpError(400, `The radius is ${placesLib.MIN_RADIUS} to ${placesLib.MAX_RADIUS} m.`);
    return r;
  };
  // a place's position, as POST and PATCH take it (numbers only, both)
  const placePos = (b) => {
    const lat = placesLib.coord(b?.lat);
    const lon = placesLib.coord(b?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new HttpError(400, 'That is not a place on the map.');
    return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
  };
  r.add('POST', '/api/places', (req, res, { body }) => {
    const name = placeName(body?.name);
    if (!name) throw new HttpError(400, 'Give the place a name.');
    const { lat, lon } = placePos(body);
    const radius = body?.radius === undefined || body?.radius === null ? placesLib.DEFAULT_RADIUS : placeRadius(body.radius);
    const list = placeList();
    if (list.length >= 200) throw new HttpError(400, 'There are 200 saved places already: remove some first.');
    const place = { id: crypto.randomBytes(5).toString('hex'), name, lat, lon, radius };
    db.set('places', [...list, place]);
    return { place };
  });
  // a new name, a new radius, a new position (lat and lon, from the map in
  // Settings > Places), or any of them together
  r.add('PATCH', '/api/places/:id', (req, res, { params, body }) => {
    const list = placeList();
    const place = list.find((x) => x.id === params.id);
    if (!place) throw new HttpError(404, 'No such place.');
    const hasName = body?.name !== undefined;
    const hasRadius = body?.radius !== undefined;
    const hasAt = body?.lat !== undefined || body?.lon !== undefined;
    if (!hasName && !hasRadius && !hasAt) throw new HttpError(400, 'Send a name, a radius or a position.');
    const name = hasName ? placeName(body.name) : place.name;
    if (!name) throw new HttpError(400, 'Give the place a name.');
    const radius = hasRadius ? placeRadius(body.radius) : null;
    const at = hasAt ? placePos(body) : null;
    place.name = name;
    if (radius !== null) place.radius = radius;
    if (at) Object.assign(place, at);
    db.set('places', list);
    return { place };
  });
  r.add('DELETE', '/api/places/:id', (req, res, { params }) => {
    const list = placeList();
    if (!list.some((x) => x.id === params.id)) throw new HttpError(404, 'No such place.');
    db.set('places', list.filter((x) => x.id !== params.id));
    return { ok: true };
  });
  // Settings > Places: where the car parks most (Sentry and Saved events of
  // the last 90 days, at most the newest 1500 across the vehicles, grouped
  // within 150 m, leaving out what a saved place covers already), and how
  // many of those events are at each saved place
  const SUGGEST_DAYS = 90;
  const SUGGEST_EVENTS = 1500;
  r.add('GET', '/api/places/suggestions', async () => {
    const since = new Date(Date.now() - SUGGEST_DAYS * 86400000).toISOString().slice(0, 10);
    const recs = [];
    for (const v of vehicles.list()) {
      for (const rec of inventory.get(v.id)?.recordings || []) {
        if (rec.eventId && (!rec.day || rec.day >= since)) recs.push([v, rec]);
      }
    }
    recs.sort((a, b) => String(b[1].startKey).localeCompare(String(a[1].startKey)));
    const picked = recs.slice(0, SUGGEST_EVENTS);
    const spots = [];
    await eachLimit(picked, 6, async ([v, rec]) => {
      const spot = await eventSpot(v.id, rec).catch(() => null);
      if (!spot?.pos) return;
      spots.push({ ...spot.pos, key: rec.startKey, at: spot.info?.timestamp || rec.start || rec.day || null, city: spot.info?.city || null, street: spot.info?.street || null, vehicle: v.name || v.id });
    });
    const places = placeList();
    return {
      days: SUGGEST_DAYS, events: picked.length, withPosition: spots.length,
      suggestions: placesLib.suggestPlaces(spots, places),
      counts: placesLib.countAtPlaces(spots, places)
    };
  });
  // Footage check: clips that will not play (cut off, empty, not MP4)
  const integrity = createIntegrity({
    dir: path.join(DATA, 'integrity'), inventory, vehicles, log: logger.scope('integrity'),
    marks: { get: (vid) => db.get(`integrity-running:${vid}`, false) === true, set: (vid, on) => db.set(`integrity-running:${vid}`, on) }
  });
  integrityRef = integrity;
  r.add('GET', '/api/vehicles/:id/integrity', async (req, res, { params }) => integrity.results(vehicleOr404(params.id).id));
  r.add('POST', '/api/vehicles/:id/integrity', async (req, res, { params }) => {
    const v = vehicleOr404(params.id);
    if (!inventory.get(v.id)?.files) await inventory.scan(v.id);
    return integrity.start(v.id);
  });
  // ---- CAN Bridge logs (the hidden Nerd settings; docs/can-bridge-api.md)
  const canLogs = createCanLogs({ dir: path.join(DATA, 'can'), freeBytes: () => diskSpace(fs.promises, DATA).then((x) => x.free).catch(() => Infinity) });
  // each log decoded once in the background (not while a conversion runs), so the Viewer gets it ready
  let canSync = null;
  // signatures, pairing and the chain of each car's logs (canTrust.js): a log is decoded only when it may be used
  const canTrust = createCanTrust({ dir: path.join(DATA, 'can'), log: logger.scope('can') });
  // the Nerd panel follows uploads, checks and the index live ('can' on /api/events); the index's progress at most once a second
  let canProgressAt = 0;
  let canProgressTimer = null;
  const canProgress = () => {
    if (canProgressTimer) return;
    const wait = Math.max(0, canProgressAt + 1000 - Date.now());
    canProgressTimer = setTimeout(() => { canProgressTimer = null; canProgressAt = Date.now(); announce('can'); }, wait);
    canProgressTimer.unref?.();
  };
  // which DBC set decodes a car key's logs: its vehicle's "Car model" setting, else what the car's
  // VIN says (carModels.js); a change has that key's logs decoded again (canIndex.js)
  const canIndex = createCanIndex({ usable: (k, n) => canTrust.usable(k, n), canDir: path.join(DATA, 'can'), dir: path.join(DATA, 'can-index'), log: logger.scope('can'), idle: () => !converterRunning(), profileOf: async (key) => (await carForKey(key)).profile, onIndexed: (key, from, to) => {
    archiveGapRef?.indexed(key, from, to);
    // and the cars of that key are checked for archive gaps again (CAN driving with no footage)
    if (archiveGapRef) for (const v of vehicles.list()) canKeysFor(v.id).then((keys) => { if (keys.includes(key)) archiveGapRef.soon(v.id); }).catch(() => {});
    canSync?.indexed(key, from, to).catch(() => {});
  }, onProgress: canProgress });
  canIndexRef = canIndex;
  setTimeout(() => canIndex.kick(), 20_000).unref?.();
  canFootageRef = createCanFootage({ keysFor: (vid) => canKeysFor(vid), minuteTimes: (key) => canIndex.minuteTimes(key), generation: () => canIndex.generation(), startOf: (v, name) => canStartOf(v, name) });
  recPlacesRef = createRecordingPlaces({
    keysFor: (vid) => canKeysFor(vid), canFile: minuteFileOf(path.join(DATA, 'can-index')), utcOf: (v, stamp) => canStartOf(v, stamp),
    clipStats: (vid, day) => speedIndex.clipStats(vid, day), clipsRead: (vid, day) => speedIndex.clipsRead(vid, day),
    filesOf: (vid) => inventory.get(vid)?.files, generation: () => canIndex.generation()
  });
  // which car each CAN Bridge key is (a key of its own when there is one car)
  const canMap = () => db.get('can-vehicles', {}) || {};
  async function canKeysFor(vid) {
    const map = canMap();
    let keys = [];
    try { keys = (await fs.promises.readdir(path.join(DATA, 'can-index'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
    const single = vehicles.list().length === 1;
    return keys.filter((k) => map[k] === vid || (!map[k] && single));
  }
  // archive gaps (archiveGap.js): driving per CAN Bridge, drives cut off, minutes missing cameras
  archiveGapRef = createArchiveGap({
    inventory, vehicles, notes, db, speedIndex, canKeysFor, canKeyMapped: (k) => Boolean(canMap()[k]), canDir: path.join(DATA, 'can-index'), log: logger.scope('archive'),
    // the range Sentry USB is still copying: not missing (sentryUsb.js)
    sentryUsbFor: (vid) => {
      const n = sentryUsb.now(vid);
      if (!n.transferring || !n.range) return null;
      return { transferring: true, overdue: n.overdue, firstS: clipStampSec(n.range.first), lastS: clipStampSec(n.range.last) };
    },
    // the snapshots Sentry USB lists (sentryUsb.js): missing minutes it did not catch in time
    snapshotsFor: (vid) => sentryUsb.snapshots(vid),
    clock24: () => Boolean(db.get('appearance', {}).clock24)
  });
  sentryUsb.start();
  // driveData is not started: the Drives tab is hidden, so drive-data.json is read
  // only when the drives API asks (driveData.check there), and costs nothing otherwise
  // Sentry USB's last archive and checksum results, or what it is copying now
  // (record: the checksums Manager records for it, arrivalChecksums.js; canBackfill: this account may turn the older clips on or off)
  // missed snapshots that count: the ones that cost footage (the archive gap check found missing
  // minutes in them, while the car drove or was in Sentry Mode); the others (the car most likely
  // asleep or off) only as a number
  const countedMisses = (vid, view) => {
    const snaps = view?.snapshots;
    if (!snaps || !Array.isArray(snaps.missed)) return view;
    const costly = new Set();
    try {
      for (const d of Object.values(archiveGapRef?.forDays(vid) || {})) for (const g of d?.missedSnapshots || []) if (Number.isFinite(g.fromUnix)) costly.add(g.fromUnix * 1000);
    } catch { /* no check yet: none counted */ }
    const missed = snaps.missed.filter((g) => costly.has(g.from));
    return { ...view, snapshots: { ...snaps, missed, missedIdle: snaps.missed.length - missed.length } };
  };
  const sentryUsbView = (v, user, req) => countedMisses(v.id, { ...sentryUsb.api(v.id), record: { ...arrivalRef.view(v.id), canBackfill: adminHere(req, user) } });
  r.add('GET', '/api/vehicles/:id/sentry-usb', async (req, res, { params, user }) => {
    const v = vehicleOr404(params.id);
    // while a transfer runs the page asks every second: the status file is
    // looked at again (a stat) and what has arrived on the share is counted
    await sentryUsb.fresh(v.id);
    const view = sentryUsbView(v, user, req);
    if (view.transfer && view.state === 'transferring') view.transfer.arrived = await sentryUsb.arrived(v.id);
    return view;
  });
  // "Record checksums for older clips" on or off for the car: { older: true | false }
  // (admin: a POST a watch-only account may not make)
  r.add('POST', '/api/vehicles/:id/sentry-usb/record', async (req, res, { params, body, user }) => {
    const v = vehicleOr404(params.id);
    if (typeof body?.older !== 'boolean') throw Object.assign(new Error('Send { "older": true } or { "older": false }: every clip is recorded, newest first, unless older clips are turned off.'), { status: 400 });
    const rec = { ...(db.get('sentry-usb-record', {}) || {}) };
    rec[v.id] = { ...(rec[v.id] || {}), older: body.older };
    db.set('sentry-usb-record', rec);
    arrivalRef.kick();
    audit.info(`Checksum record of "${v.name}": older clips ${body.older ? 'on' : 'off'}: ${by(req, user)}`);
    return sentryUsbView(v, user, req);
  });
  r.add('GET', '/api/vehicles/:id/archive-gaps', async (req, res, { params }) => {
    const v = vehicleOr404(params.id);
    const out = await archiveGapRef.results(v.id);
    return { vehicleId: v.id, timezone: v.timezone || 'UTC', checkedAt: out.checkedAt || null, signals: out.signals || {}, stalled: out.stalled || null,
      days: Object.values(out.days || {}).sort((a, b) => b.day.localeCompare(a.day)) };
  });
  /** A clip's start in UTC from its name (the car's zone), or null. */
  const canStartOf = (v, name) => {
    const m = /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(name);
    return m ? zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], v.timezone || 'UTC') : null;
  };
  /** The car, its CAN keys and the clip's start in UTC, for a clip file. */
  async function canClipOf(p) {
    const real = String(p || '');
    const v = vehicles.list().find((x) => { const root = vehicles.rootOf(x); return root && (real === root || real.startsWith(`${root}${path.sep}`)); });
    if (!v) throw new HttpError(404, 'Not a clip of a vehicle.');
    const start = canStartOf(v, path.basename(real));
    if (start === null) throw new HttpError(400, 'Not a TeslaCam clip name.');
    return { v, keys: await canKeysFor(v.id), start };
  }
  // where on the CAN clock each clip's first frame is, from its own telemetry (server/canSync.js)
  canSync = createCanSync({
    dir: path.join(DATA, 'can-index'), series: canIndex.series, telemetry: async (real) => (await telemetry.forFile(real)).body,
    vehicles, inventory, keysFor: canKeysFor, startOf: canStartOf, log: logger.scope('can'),
    idle: () => !converterRunning() && !canIndex.status().running
  });
  // the Viewer: every signal there is for this car (for the stat picker) ...
  r.add('GET', '/api/can/signals', async (req, res, { query }) => {
    const { keys } = await canClipOf(query.path);
    return { signals: await canIndex.signals(keys) };
  });
  // signals=* (the Viewer's list block: every signal, each one's value every 250 ms) is the costly
  // answer: at most two are made at once, a few wait (more get 429), one whose page closed is not
  // made, and the last few are kept ready (another viewer of the same clip, a replay), until the
  // index changes
  const canEvery = { running: 0, waiting: [], ready: new Map() };
  const CAN_EVERY_AT_ONCE = 2;
  const CAN_EVERY_WAITING = 8;
  async function canEverySlot(res) {
    if (canEvery.running < CAN_EVERY_AT_ONCE) { canEvery.running++; return; }
    if (canEvery.waiting.length >= CAN_EVERY_WAITING) throw new HttpError(429, 'The car data is busy: try again in a moment.');
    await new Promise((ok, fail) => {
      const w = { ok, fail };
      canEvery.waiting.push(w);
      res.on('close', () => { const i = canEvery.waiting.indexOf(w); if (i >= 0) { canEvery.waiting.splice(i, 1); fail(new HttpError(409, 'Stopped: the page closed.')); } });
    });
  }
  function canEveryDone() {
    const next = canEvery.waiting.shift();
    if (next) next.ok(); else canEvery.running--;
  }
  // ... and the chosen ones over this clip (UTC times), already decoded
  r.add('GET', '/api/can/clip', async (req, res, { query }) => {
    const { v, keys, start: named } = await canClipOf(query.path);
    // signals=* : every signal of the clip (the Viewer's list block)
    const every = query.signals === '*';
    const names = every ? null : String(query.signals || '').split(',').map((x) => x.trim()).filter((x) => /^\w{1,80}$/.test(x)).slice(0, 64);
    if ((!every && !names.length) || !keys.length) return { start: named, series: {} };
    // the clip's start on the CAN clock: its name's time, corrected by the sync
    const real = await studioReadable.resolve(String(query.path || ''));
    const sync = real && !hiddenPath(real) ? await canSync.forClip({ v, keys, real, start: named }).catch((err) => { log.warn(`CAN sync: ${err.message}`); return null; }) : null;
    const start = Math.round((named + (sync?.offsetMs || 0)) * 10) / 10;
    // how far it can be trusted (verified, unsigned, or override: a log that failed its check,
    // used anyway), from the same minutes as the signals, each read once
    if (!every) {
      const got = await canIndex.clipData(keys, start - 2000, start + 70_000, names);
      return { start, sync, trust: got.trust, series: got.series };
    }
    // Every signal, each thinned to its last value every step= ms (250 by default; the list shows
    // the value now). cols=1 (the Viewer's List): values the same as the one before left out,
    // `changing` the names whose value moves (from every point), and the points as columns:
    // { name: [[ms after `base`, then after the one before…], [values…]] } (a fifth the size of
    // [[UTC ms, value], …] pairs, and typed arrays in the browser). Without cols=1: pairs.
    const step = Math.max(CAN_CLIP_STEP_MS, Math.min(5000, Math.round(Number(query.step) || CAN_CLIP_STEP_MS)));
    const cols = query.cols === '1';
    const id = `${keys.join(',')}|${start}|${JSON.stringify(sync)}|${step}|${cols ? 'c' : 'p'}|${canIndex.generation()}`;
    let body = canEvery.ready.get(id);
    if (!body) {
      await canEverySlot(res);
      try {
        if (res.destroyed) return undefined;
        let answer;
        if (cols) {
          const changing = new Set();
          const got = await canIndex.clipData(keys, start - 2000, start + 70_000, null, { step, dropRepeats: true, changing });
          const base = Math.round(start);
          const out = {};
          for (const [name, pts] of Object.entries(got.series)) {
            const dt = new Array(pts.length);
            const val = new Array(pts.length);
            let prev = base;
            for (let k = 0; k < pts.length; k++) { dt[k] = Math.round(pts[k][0] - prev); prev += dt[k]; val[k] = pts[k][1]; }
            out[name] = [dt, val];
          }
          answer = { start, sync, trust: got.trust, step, base, changing: [...changing], cols: out };
        } else {
          const got = await canIndex.clipData(keys, start - 2000, start + 70_000, null, { step });
          answer = { start, sync, trust: got.trust, series: got.series };
        }
        const json = Buffer.from(JSON.stringify(answer));
        body = { json, gz: await gzipAsync(json, { level: 4 }) };
      } finally { canEveryDone(); }
      canEvery.ready.set(id, body);
      while (canEvery.ready.size > 4) canEvery.ready.delete(canEvery.ready.keys().next().value);
    }
    const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(gz ? { 'Content-Encoding': 'gzip' } : {}), Vary: 'Accept-Encoding' });
    res.end(gz ? body.gz : body.json);
    return undefined;
  });
  // "when did this start" (canSearch.js): one search at a time, each match with the clip that covers it.
  // Each user has one search at most (a newer one stops the older), a few
  // may wait (more get 429), and a search whose page closed stops.
  const canSearch = createCanSearch({ dir: path.join(DATA, 'can-index') });
  const canQueue = createSearchQueue({ waiting: 4 });
  const canStamps = new Map(); // vehicle id -> { of, stamps }
  // `options(when)` reads the query (a bad time is a 400 before anything waits), `fn(keys, options, stop)` searches
  async function canSearchRun(req, res, user, query, options, fn) {
    const v = vehicleOr404(String(query.vehicle || ''));
    const keys = await canKeysFor(v.id);
    const tz = v.timezone || 'UTC';
    const when = (s, end) => parseWhen(s, (...a) => zonedToUtc(...a, tz), end);
    let opts;
    try { opts = options(when); } catch (err) { throw new HttpError(err.status || 400, err.message); }
    const job = canQueue.run(user || clientKey(req), (stop) => fn(keys, opts, stop));
    res.on('close', () => { if (!res.writableEnded) job.cancel('Stopped: the page closed.'); });
    let out;
    try { out = await job.done; } catch (err) { throw new HttpError(err.status || 500, err.message); }
    const inv = inventory.get(v.id);
    let c = canStamps.get(v.id);
    if (inv?.recordings && c?.of !== inv.recordings) {
      c = { of: inv.recordings, stamps: clipStamps(inv.recordings) };
      canStamps.set(v.id, c);
    }
    const add = (m) => { if (m && Number.isFinite(m.at)) { m.localTime = localTime(m.at, tz); m.footage = footageAt(c?.stamps, m.at, tz); } };
    for (const list of [out.matches, out.appeared, out.stopped]) list?.forEach(add);
    return { vehicle: v.id, timezone: tz, keys, ...out };
  }
  r.add('GET', '/api/can/vehicle-signals', async (req, res, { query }) => ({ signals: await canIndex.signals(await canKeysFor(vehicleOr404(String(query.vehicle || '')).id)) }));
  // `resume` (from an answer out of time) goes on with that same search
  r.add('GET', '/api/can/search', (req, res, { query, user }) => canSearchRun(req, res, user, query, (when) => (query.resume ? { resume: query.resume } : {
    signal: query.signal, op: query.op, value: query.value, from: when(query.from), to: when(query.to, true), limit: query.limit, all: query.all === '1' || query.all === 'true'
  }), (keys, opts, stop) => canSearch.signal(keys, { ...opts, stop })));
  r.add('GET', '/api/can/id-events', (req, res, { query, user }) => canSearchRun(req, res, user, query, (when) => (query.resume ? { resume: query.resume } : {
    from: when(query.from), to: when(query.to, true), before: when(query.before), gap: query.gap, id: query.id || null, limit: query.limit
  }), (keys, opts, stop) => canSearch.ids(keys, { ...opts, stop })));
  // ... and the nerd raw view: every id's payload changes over the clip (or from/to ms into it), decodable or not
  r.add('GET', '/api/can/raw', async (req, res, { query }) => {
    const { v, keys, start: named } = await canClipOf(query.path);
    // on the CAN clock, as /api/can/clip (the same sync), so raw frames and signals agree
    const real = keys.length ? await studioReadable.resolve(String(query.path || '')) : null;
    const sync = real && !hiddenPath(real) ? await canSync.forClip({ v, keys, real, start: named }).catch(() => null) : null;
    const start = Math.round((named + (sync?.offsetMs || 0)) * 10) / 10;
    const ms = (x, d) => { const n = Number(x); return x !== undefined && x !== '' && Number.isFinite(n) ? Math.max(-120_000, Math.min(180_000, n)) : d; };
    const from = start + ms(query.from, -2000);
    const to = start + ms(query.to, 70_000);
    const ids = keys.length && to >= from ? await canIndex.raw(keys, from, to) : [];
    // probe=1: only how many ids there are (whether the Viewer offers the raw view)
    if (query.probe) return { start, count: ids.length };
    // (sync too: its rate is the drive's drift, which the raw view applies as the signals do)
    return { start, sync, from, to, ids };
  });
  r.add('POST', '/api/can/vehicle-map', (req, res, { body, user }) => {
    requireConfirmed(req); // (which car a key's data belongs to)
    const key = String(body?.key || '');
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) throw new HttpError(400, 'Give the CAN Bridge car key.');
    const vid = body?.vehicleId ? vehicleOr404(String(body.vehicleId)).id : null;
    const map = { ...canMap() };
    if (vid) map[key] = vid; else delete map[key];
    db.set('can-vehicles', map);
    audit.info(`CAN car ${key} is ${vid || 'no vehicle'}: ${by(req, user)}`);
    canIndex.kick(); // (the car's model can differ: its logs are decoded with its DBC set)
    return { map };
  });
  // ---- who may upload: one token per car (docs/can-bridge-api.md, "Tokens")
  // db 'can': { enabled, at, tokens: [{ id, hash, vehicleId, key, label, createdAt, lastUsedAt }] }
  // A token is bound to one CAN Bridge car key (on its first upload, or when
  // made) and can only send that car's logs; only its SHA-256 is kept.
  const canCfg = () => {
    const c = db.get('can', null) || { enabled: false };
    // (one token from before tokens were per car)
    if (c.tokenHash && !Array.isArray(c.tokens)) return { enabled: c.enabled, at: c.at, tokens: [{ id: 'first', hash: c.tokenHash, vehicleId: null, key: null, label: 'First token', createdAt: c.at || null, lastUsedAt: null }] };
    return { ...c, tokens: Array.isArray(c.tokens) ? c.tokens : [] };
  };
  const saveCanCfg = (c) => db.set('can', { enabled: Boolean(c.enabled), at: c.at || null, tokens: c.tokens });
  const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
  /** The token a request carries (compared in constant time with every token), or null. */
  const canTokenOf = (req) => {
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!given || given.length > 200) return null;
    const h = Buffer.from(tokenHash(given));
    let found = null;
    for (const t of canCfg().tokens) {
      if (typeof t.hash === 'string' && t.hash.length === 64 && crypto.timingSafeEqual(h, Buffer.from(t.hash))) found = t;
    }
    return found;
  };
  // wrong tokens: an address that keeps trying is refused for a while (tokens are 256-bit; this keeps logs quiet)
  const canBadTries = new Map(); // address -> { n, until }
  const canBlocked = (ip) => { const b = canBadTries.get(ip); return b && b.until > Date.now() && b.n >= 20; };
  const canBadTry = (ip) => {
    const b = canBadTries.get(ip);
    const fresh = !b || b.until < Date.now();
    canBadTries.set(ip, { n: fresh ? 1 : b.n + 1, until: fresh ? Date.now() + 10 * 60_000 : b.until });
    if (canBadTries.size > 5000) canBadTries.delete(canBadTries.keys().next().value);
  };
  // a right token's pace: requests per 10 minutes
  const canPace = new Map(); // token id -> { n, until }
  const canTokenPace = (id) => {
    const p = canPace.get(id);
    if (!p || p.until < Date.now()) { canPace.set(id, { n: 1, until: Date.now() + 10 * 60_000 }); return true; }
    p.n++;
    return p.n <= 1200;
  };
  /** The car key a token is for: the one it is tied to, else this one (tied now, before anything is written). */
  const claimToken = (tok, key) => {
    const c = canCfg();
    const t = c.tokens.find((x) => x.id === tok.id);
    if (!t) return null;
    if (!t.key) {
      t.key = key;
      saveCanCfg(c);
      log.info(`CAN Bridge token "${t.label}" is now for car key ${key}`);
      if (t.vehicleId && !canMap()[key]) db.set('can-vehicles', { ...canMap(), [key]: t.vehicleId });
    }
    return t.key;
  };
  /** A token's first upload binds it to that car key (and the key to the token's car). */
  const bindToken = (tok, key) => {
    const c = canCfg();
    const t = c.tokens.find((x) => x.id === tok.id);
    if (!t) return;
    if (!t.key) {
      t.key = key;
      log.info(`CAN Bridge token "${t.label}" is now for car key ${key}`);
      if (t.vehicleId && !canMap()[key]) db.set('can-vehicles', { ...canMap(), [key]: t.vehicleId });
    }
    t.lastUsedAt = Date.now();
    saveCanCfg(c);
  };
  /** Judge a log (after its log or sidecar arrived), then decode it if it may be used. */
  const judgeCanLog = async (key, logName) => {
    const before = await canTrust.record(key, logName).catch(() => null);
    const rec = await canTrust.check(key, logName).catch((err) => { log.warn(`CAN trust ${logName}: ${err.message}`); return null; });
    if (rec && rec.status !== 'waiting') canIndex.kick();
    // its check changed (waiting -> verified, …): the Nerd panel shows it
    if (rec && (rec.status !== before?.status || rec.reason !== before?.reason)) announce('can');
    return rec;
  };
  // at start, and every few minutes: logs not judged yet, or waiting for a sidecar that never came
  const judgePending = async () => { for (const { key, name } of await canTrust.pending()) await judgeCanLog(key, name); };
  setTimeout(() => judgePending().catch(() => {}), 15_000).unref?.();
  setInterval(() => judgePending().catch(() => {}), 5 * 60_000).unref?.();
  // half-finished uploads older than two days are dropped
  setInterval(() => canLogs.cleanStale(2 * 24 * 3600_000).catch(() => {}), 3600_000).unref?.();

  /** A log's data taken out of the index (and the sync told to work those times out again). */
  const dropCanLog = async (key, name) => {
    await canIndex.removeLog(key, name).catch((err) => log.warn(`CAN index: removing ${name}: ${err.message}`));
    const n = parseCanName(name);
    if (n) canSync?.indexed(key, n.startedAt - 2 * 60_000, n.startedAt + 30 * 60_000).catch(() => {});
  };
  // CAN logs live and die with their footage (canPrune.js): only keys mapped to a car, through the
  // same steps as a delete here (the file, the index, the sync, the trust record), one audit line a run
  const canPrune = createCanPrune({
    db, vehicles, inventory, canLogs, canTrust, startOf: canStartOf, withLock: (vid, fn) => bin.withLock(vid, fn),
    keysOf: (vid) => Object.entries(canMap()).filter(([, id]) => id === vid).map(([k]) => k),
    drop: (key, name) => dropCanLog(key, name), audit, log: logger.scope('can'), onChange: () => announce('can')
  });
  canPruneRef = canPrune;
  // every hour (footage the car or the archive removed, logs past the car's oldest footage); first after 10 minutes
  setTimeout(() => canPrune.sweep().catch(() => {}), 10 * 60_000).unref?.();
  setInterval(() => canPrune.sweep().catch(() => {}), 3600_000).unref?.();
  // HTTPS for an upload (canSecure.js): on the CAN port a forwarded "https" counts only from the local network
  const canSecure = (req) => canUploadSecure(req, { canPort: CAN_PORT, isSecure });
  canUploadRef = async (req, res, rawPath) => {
    const cfg = canCfg();
    const fail = (status, code, error, extra = {}) => sendJson(res, status, { error, code, ...extra });
    if (!cfg.enabled || !cfg.tokens.length) return fail(404, 'off', 'Not found');
    if (!canSecure(req)) return fail(403, 'https_only', 'CAN logs are only taken over HTTPS.');
    // on the CAN port the address is the connection's own (nothing there is behind a proxy, so a
    // forwarded header could only be a lie); on the web port it is the usual client address
    const ip = req.socket?.localPort === CAN_PORT ? req.socket.remoteAddress || '?' : clientKey(req);
    const tok = canTokenOf(req);
    if (!tok) {
      // wrong tokens: an address that keeps trying is refused for a while (a right token never is)
      if (canBlocked(ip)) return fail(429, 'slow_down', 'Too many wrong tokens from this address; try again later.');
      canBadTry(ip);
      res.setHeader('WWW-Authenticate', 'Bearer');
      return fail(401, 'bad_token', 'A valid CAN Bridge token is needed.');
    }
    // a right token is still limited: 1,200 requests in 10 minutes is far more than the bridge sends
    if (!canTokenPace(tok.id)) return fail(429, 'slow_down', 'Too many requests with this token; try again later.');
    const sub = rawPath.slice('/api/can/logs'.length);
    try {
      if (req.method === 'GET' && sub === '/ping') {
        // formats: every log format all the readers here handle (canLogReader.js); the bridge writes the compact
        // one only while it is listed, so it is listed only because the indexer and the downloads read it
        return sendJson(res, 200, { ok: true, api: 1, vehicleKey: tok.key || null, maxChunk: canLogs.MAX_CHUNK, maxFile: canLogs.MAX_FILE, maxSidecar: canLogs.MAX_SIDECAR, formats: CAN_FORMATS });
      }
      if (req.method === 'POST' && sub === '/status') {
        let body;
        try { body = JSON.parse((await readRaw(req, 1024 * 1024)).toString('utf8') || '{}'); } catch { return fail(400, 'bad_request', 'Send JSON: { "names": [...] }.'); }
        // a token sees only its own car's files; a token not tied to a car yet is tied by the names it asks about (one car only)
        let key = tok.key;
        if (!key && Array.isArray(body?.names)) {
          const keys = [...new Set(body.names.map((x) => parseCanName(x)?.vehicleKey).filter(Boolean))];
          if (keys.length > 1) return fail(400, 'mixed_cars', 'A token is for one car: ask about one car key\'s files.');
          if (keys.length === 1) key = claimToken(tok, keys[0]);
        }
        return sendJson(res, 200, await canLogs.status(body?.names, { key: key || '\u0000none' }));
      }
      let name = '';
      try { name = sub.startsWith('/') ? decodeURIComponent(sub.slice(1)) : ''; } catch { return fail(400, 'bad_name', 'That is not a CAN Bridge log name.'); }
      const n = parseCanName(name);
      if (req.method === 'POST' && n) {
        // tied to its car before anything is written (in one step: two first uploads cannot claim two cars)
        const key = claimToken(tok, n.vehicleKey);
        if (key !== n.vehicleKey) return fail(403, 'wrong_car', `This token is for car key ${key}, not ${n.vehicleKey}.`);
        const num = (h) => (req.headers[h] === undefined || req.headers[h] === '' ? NaN : Number(req.headers[h]));
        const body = await readRaw(req, canLogs.MAX_CHUNK);
        const out = await canLogs.receive(name, body, { offset: num('upload-offset'), length: num('upload-length'), sha256: String(req.headers['upload-sha256'] || '').toLowerCase() });
        bindToken(tok, n.vehicleKey);
        if (out.complete && !out.already) {
          log.info(`CAN Bridge: received ${name} (${out.length} bytes)`);
          announce('can');
          // checked against its signature before anything uses it, then decoded for the Viewer
          judgeCanLog(n.vehicleKey, name.replace(/\.json$/, ''));
        }
        return sendJson(res, out.complete ? 201 : 200, out);
      }
      return fail(404, 'not_found', 'Not found');
    } catch (err) {
      if (err.status) return fail(err.status, err.code || 'error', err.message, err.received !== undefined ? { received: err.received } : {});
      log.warn(`CAN Bridge upload: ${err.message}`);
      return fail(500, 'server_error', 'The server could not take this file now; try again later.');
    }
  };
  r.add('GET', '/api/can/settings', async () => {
    const cfg = canCfg();
    const { bytes, count, keys: logKeys } = await canLogs.summary();
    const keys = [...new Set([...logKeys, ...cfg.tokens.map((t) => t.key).filter(Boolean)])].sort();
    return {
      enabled: Boolean(cfg.enabled), since: cfg.at || null, logs: count, bytes, port: { ...(canPort?.state() || { listening: false, error: null, port: CAN_PORT }), https: Boolean(tlsSource) },
      keys, map: canMap(), vehicles: vehicles.list().map((v) => ({ id: v.id, name: v.name })), index: canIndex.status(),
      tokens: cfg.tokens.map((t) => ({ id: t.id, label: t.label, vehicleId: t.vehicleId, key: t.key, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })),
      trust: await Promise.all(keys.map((k) => canTrust.summary(k))),
      keep: canPrune.status()
    };
  });
  // "Delete CAN logs with their footage" (on by default)
  r.add('POST', '/api/can/keep', (req, res, { body, user }) => {
    requireConfirmed(req);
    const ok = ['withFootage', 'deleteUnlinked'].some((k) => typeof body?.[k] === 'boolean') || body?.unlinkedDays !== undefined;
    const days = body?.unlinkedDays;
    if (!ok || (days !== undefined && !(Number.isInteger(days) && days >= 1 && days <= 365))) throw new HttpError(400, 'Send { "withFootage": true | false, "deleteUnlinked": true | false, "unlinkedDays": 1-365 } (any of them).');
    const out = canPrune.set(body);
    audit.warn(`CAN logs: ${out.withFootage ? 'deleted with their footage' : 'not deleted with their footage'}; ${out.deleteUnlinked ? `deleted when not linked to footage after ${out.unlinkedDays} days` : 'kept when not linked to footage'}: ${by(req, user)}`);
    announce('can');
    return out;
  });
  /** A new token for a car (shown once). */
  const newCanToken = (cfg, { vehicleId = null, label = '' } = {}) => {
    const token = crypto.randomBytes(32).toString('base64url');
    const v = vehicleId ? vehicleOr404(String(vehicleId)) : vehicles.list().length === 1 ? vehicles.list()[0] : null;
    // a car whose CAN Bridge key is known already: the token is tied to it now
    const known = v ? Object.entries(canMap()).filter(([, vid]) => vid === v.id).map(([k]) => k) : [];
    const entry = {
      id: crypto.randomBytes(6).toString('hex'), hash: tokenHash(token), vehicleId: v?.id || null, key: known.length === 1 ? known[0] : null,
      label: String(label || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40) || `${v?.name || 'Car'} CAN Bridge`, createdAt: Date.now(), lastUsedAt: null
    };
    if (cfg.tokens.length >= 20) throw new HttpError(400, 'There are 20 tokens already: revoke some first.');
    cfg.tokens.push(entry);
    return { token, entry };
  };
  r.add('POST', '/api/can/enable', (req, res, { user, body }) => {
    requireConfirmed(req);
    const cfg = canCfg();
    cfg.enabled = true;
    cfg.at = cfg.at || Date.now();
    // the first token comes with turning it on; more are made per car below
    const made = cfg.tokens.length ? null : newCanToken(cfg, { vehicleId: body?.vehicleId });
    saveCanCfg(cfg);
    audit.warn(`CAN Bridge uploads turned on${made ? ` (token "${made.entry.label}")` : ''}: ${by(req, user)}`);
    syncDevicePort();
    return { enabled: true, token: made?.token || null, tokenId: made?.entry.id || null, fingerprint: certFingerprint(), port: CAN_PORT };
  });
  r.add('POST', '/api/can/disable', (req, res, { user }) => {
    requireConfirmed(req);
    const cfg = canCfg();
    saveCanCfg({ ...cfg, enabled: false }); // the tokens stay, unusable while off
    audit.warn(`CAN Bridge uploads turned off: ${by(req, user)}`);
    syncDevicePort();
    return { enabled: false };
  });
  // ---- Sentry USB, the Pi in the car: the management link (docs/sentry-usb-link.md).
  // The Pi connects to the device port; these routes (main port) list it, pair it
  // and send it requests. Reads for every signed-in account, writes for admins.
  const sentryAudit = logger.scope('sentryusb');
  // the security log (6b): every device-port event and action, with its flags;
  // a possible hijack attempt is always notified, network notices per Pi
  const securityLog = createSentryUsbAudit({
    db, log: logger.scope('sentryusb-security'), device: (id) => sentryLink?.info(id) || null,
    keepDays: Number(db.get('sentryusb-audit-days', 180)) || 180,
    notify: ({ always, ...n }) => {
      if (!always) return notes.raise(n);
      const nid = db.notify(n);
      notes.emit('changed', nid);
      return nid;
    }
  });
  sentryLink = sentryUsbLinkLib.createSentryUsbLink({
    db, log: sentryAudit,
    onChange: () => { announce('sentryusb'); syncDevicePort(); },
    onStatus: (id, first) => { if (first) sentryQueue?.kick(id); },
    onEvent: (e) => {
      if (e.type === 'unpaired' && e.byPi) {
        // (still known here: the record goes right after this event)
        notes.raise({ kind: 'sentryusb', level: 'info', dedupeKey: `sentryusb-unpaired:${e.id}:${Date.now()}`, title: `${sentryLink.name(e.id) || 'A Sentry USB'} was unpaired on the Sentry USB itself`, message: 'Sentry Manager forgot it and what was queued for it. Pair it again from Settings → Sentry USB.' });
        sentryQueue.forgetDevice(e.id);
      }
      return securityLog.linkEvent(e);
    }
  });
  const sentryQueue = createSentryUsbQueue({
    db, link: sentryLink, dir: path.join(DATA, 'sentryusb'), log: sentryAudit, onChange: () => announce('sentryusb'),
    notify: (n) => notes.raise(n),
    onResult: (r) => securityLog.action({ deviceId: r.deviceId, who: r.by, route: `queued ${r.label.toLowerCase()}`, result: `${r.ok ? 'done' : 'failed'}${r.message ? `: ${r.message}` : ''}`, queued: true })
  });
  setInterval(() => sentryQueue.expire(), 60_000).unref();
  setInterval(() => securityLog.prune(), 3600_000).unref();
  const sentryOr404 = (id) => {
    if (!sentryLink.has(id)) throw new HttpError(404, 'No such Sentry USB.');
    return id;
  };
  const sentryWriter = (req, user) => {
    if (!adminHere(req, user)) throw new HttpError(403, 'This account can only watch. An admin account can do this.');
  };
  const sentryFingerprint = () => {
    const fp = certFingerprint();
    return fp ? sentryUsbLinkLib.fpGroups(sentryUsbLinkLib.fpHex(fp)) : null;
  };
  const NO_HTTPS_TEXT = 'This server runs without its own HTTPS (TLS_MODE=off, behind a reverse proxy). A Sentry USB pins the certificate of the port it connects to, port 10000, so pairing needs Sentry Manager\'s own HTTPS: set TLS_MODE=auto (the default).';
  r.add('GET', '/api/sentryusb', (req, res, { user }) => {
    const admin = adminHere(req, user);
    // where each Pi connects from and the networks it reports are for admins, as the security log is
    const devices = sentryLink.devices().map((d) => (admin ? d : { ...d, address: null, net: null, home: null }));
    return {
      https: Boolean(tlsSource), noHttpsText: tlsSource ? null : NO_HTTPS_TEXT, fingerprint: sentryFingerprint(),
      port: { ...(canPort?.state() || { listening: false, error: null, port: CAN_PORT }) },
      pairing: sentryLink.pairing(), devices, admin, queueKinds: sentryQueue.KINDS
    };
  });
  r.add('POST', '/api/sentryusb/pair', async (req, res, { body, user }) => {
    sentryWriter(req, user);
    requireConfirmed(req);
    if (!tlsSource) throw Object.assign(new HttpError(409, NO_HTTPS_TEXT), { code: 'NO_HTTPS', expose: true });
    let out;
    try {
      out = await sentryLink.openPairing({ name: body?.name, username: body?.username, password: body?.password });
    } catch (err) {
      throw new HttpError(err.status || 500, err.message);
    }
    audit.warn(`Sentry USB pairing opened for "${out.name}" (15 minutes): ${by(req, user)}`);
    await syncDevicePort();
    return { pairing: out, fingerprint: sentryFingerprint(), port: canPort?.state() || null };
  });
  r.add('DELETE', '/api/sentryusb/pair', (req, res, { user }) => {
    sentryWriter(req, user);
    sentryLink.cancelPairing();
    audit.info(`Sentry USB pairing cancelled: ${by(req, user)}`);
    return { pairing: sentryLink.pairing() };
  });
  // the security log: admins (it holds addresses), filters, CSV
  r.add('GET', '/api/sentryusb/security', (req, res, { query, user }) => {
    sentryWriter(req, user);
    return { rows: securityLog.list({ filter: query.filter, deviceId: query.device || null, limit: query.limit, before: query.before }), keepDays: Number(db.get('sentryusb-audit-days', 180)) || 180, flags: securityLog.FLAGS };
  });
  r.add('GET', '/api/sentryusb/security.csv', (req, res, { query, user }) => {
    sentryWriter(req, user);
    const text = securityLog.csv(securityLog.list({ filter: query.filter, deviceId: query.device || null, limit: 1000 }), (id) => sentryLink.name(id) || id);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename="sentryusb-security-${new Date().toISOString().slice(0, 10)}.csv"` });
    res.end(`\ufeff${text}`);
    return undefined;
  });
  r.add('PUT', '/api/sentryusb/security/settings', (req, res, { body, user }) => {
    sentryWriter(req, user);
    const days = Math.round(Number(body?.days));
    if (!(days >= 7 && days <= 3650)) throw new HttpError(400, 'Keep it 7 to 3650 days.');
    db.set('sentryusb-audit-days', days);
    securityLog.setKeepDays(days);
    audit.info(`Sentry USB security log kept ${days} days: ${by(req, user)}`);
    return { keepDays: days };
  });
  r.add('PATCH', '/api/sentryusb/:id', (req, res, { params, body, user }) => {
    sentryWriter(req, user);
    sentryOr404(params.id);
    let name = sentryLink.name(params.id);
    if (body?.name !== undefined) {
      try { name = sentryLink.rename(params.id, body.name); } catch (err) { throw new HttpError(err.status || 400, err.message); }
      audit.info(`Sentry USB ${params.id} renamed "${name}": ${by(req, user)}`);
    }
    let net = null;
    if (body?.notifyNetwork !== undefined || body?.home !== undefined) {
      net = sentryLink.configure(params.id, { notifyNetwork: typeof body.notifyNetwork === 'boolean' ? body.notifyNetwork : undefined, home: body.home === undefined ? undefined : body.home });
      audit.info(`Sentry USB "${name}": network notices ${net.notifyNetwork ? 'on' : 'off'}, home network ${net.home ? 'set by hand' : 'learned'}: ${by(req, user)}`);
    }
    return { ok: true, name, ...(net || {}) };
  });
  r.add('DELETE', '/api/sentryusb/:id', (req, res, { params, user }) => {
    sentryWriter(req, user);
    requireConfirmed(req);
    const name = sentryLink.name(sentryOr404(params.id));
    sentryLink.unpair(params.id, user);
    sentryQueue.forgetDevice(params.id);
    audit.warn(`Sentry USB "${name}" (${params.id}) unpaired: ${by(req, user)}`);
    return { ok: true };
  });
  r.add('GET', '/api/sentryusb/:id/last-config', (req, res, { params, user }) => {
    sentryWriter(req, user); // its settings: admins, like the proxied read
    return sentryLink.lastConfig(sentryOr404(params.id));
  });
  // queued actions: run when the Pi is home (section 6a)
  r.add('GET', '/api/sentryusb/:id/queue', (req, res, { params }) => sentryQueue.list(sentryOr404(params.id)));
  r.add('POST', '/api/sentryusb/:id/queue', (req, res, { params, body, user }) => {
    sentryWriter(req, user);
    sentryOr404(params.id);
    if (body?.kind === 'settings') requireConfirmed(req); // it can carry passwords
    let qid;
    try { qid = sentryQueue.add(params.id, { kind: body?.kind, params: body?.params, expiresInDays: body?.expiresInDays ?? 14 }, user); } catch (err) { throw new HttpError(err.status || 400, err.message); }
    securityLog.action({ deviceId: params.id, who: user, route: `queued ${String(sentryQueue.KINDS[body.kind]).toLowerCase()}`, result: 'waiting', queued: true });
    audit.info(`Sentry USB "${sentryLink.name(params.id)}": queued ${String(sentryQueue.KINDS[body.kind]).toLowerCase()}${body.kind === 'settings' ? ` (${Object.keys(body.params?.changes || {}).join(', ').slice(0, 300)})` : ''}: ${by(req, user)}`);
    return { ok: true, id: qid, ...sentryQueue.list(params.id) };
  });
  r.add('DELETE', '/api/sentryusb/:id/queue/:qid', (req, res, { params, user }) => {
    sentryWriter(req, user);
    sentryOr404(params.id);
    let ok;
    try { ok = sentryQueue.cancel(params.id, params.qid); } catch (err) { throw new HttpError(err.status || 400, err.message); }
    if (!ok) throw new HttpError(404, 'No such queued action.');
    audit.info(`Sentry USB "${sentryLink.name(params.id)}": queued action cancelled: ${by(req, user)}`);
    return { ok: true, ...sentryQueue.list(params.id) };
  });
  // fetched diagnostics reports (admins)
  r.add('GET', '/api/sentryusb/:id/files/:name', (req, res, { params, user }) => {
    sentryWriter(req, user);
    const f = sentryQueue.file(sentryOr404(params.id), params.name);
    if (!f) throw new HttpError(404, 'No such file.');
    const data = fs.readFileSync(f);
    res.writeHead(200, {
      'Content-Type': params.name.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="sentryusb-${params.name}"`, 'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
    return undefined;
  });
  // one request over the link, checked against Manager's copy of the allowlist
  // (the path comes from the raw request target: no %-escapes, dots or double slashes)
  const CONFIRM_ROUTES = new Set(['PUT /api/setup/config', 'POST /api/setup/run', 'PUT /api/system/update-source', 'PUT /api/notifications/settings']);
  const ADMIN_READS = []; // (reads an admin alone may make, logged like changes: none since backups stay on the Pi)
  // reads for admins only, as Manager's own logs and settings are: the Pi's
  // logs (auth, syslog), diagnostics, its settings and notification settings
  // (addresses, accounts, VINs, maybe tokens) and its backups list
  const PRIVATE_READS = [/^\/api\/logs\//, /^\/api\/diagnostics$/, /^\/api\/setup\/config$/, /^\/api\/notifications\/settings$/, /^\/api\/system\/backups$/, /^\/api\/system\/update-source$/, /^\/api\/system\/keep-accessory-config$/];
  const proxyTo = async (req, res, { params, body, user }) => {
    const id = sentryOr404(params.id);
    const raw = String(req.url || '');
    const q = raw.indexOf('?');
    const rawPath = q < 0 ? raw : raw.slice(0, q);
    const query = q < 0 ? '' : raw.slice(q + 1);
    const prefix = `/api/sentryusb/${id}/proxy`;
    if (!rawPath.startsWith(`${prefix}/`)) throw new HttpError(400, 'Bad path.');
    const target = sentryUsbLinkLib.proxyTarget(req.method, rawPath.slice(prefix.length));
    if (target instanceof Error) throw new HttpError(target.status, target.message);
    // the Pi's rule: these characters and whole %XX escapes only
    if (query.length > 2048 || !/^(?:[A-Za-z0-9._~=&+,:-]|%[0-9A-Fa-f]{2})*$/.test(query)) throw new HttpError(400, 'Bad query.');
    if (req.method !== 'GET' || ADMIN_READS.some((re) => re.test(target)) || PRIVATE_READS.some((re) => re.test(target))) sentryWriter(req, user);
    if (CONFIRM_ROUTES.has(`${req.method} ${target}`)) requireConfirmed(req);
    if (req.method === 'PUT' && target === '/api/setup/config') {
      const bad = sentryUsbLinkLib.badSetupBody(body);
      if (bad) throw new HttpError(400, bad);
    }
    const name = sentryLink.name(id);
    if (req.method !== 'GET') audit.info(`Sentry USB "${name}": ${req.method} ${target}: ${by(req, user)}`);
    else sentryAudit.debug(`"${name}": GET ${target} for ${user}`);
    const out = await sentryLink.request(id, { method: req.method, path: target, query, body: req.method === 'GET' ? null : body ?? null });
    // the security log: every change (reads are many: only logged at debug)
    if (req.method !== 'GET' || ADMIN_READS.some((re) => re.test(target))) securityLog.action({ deviceId: id, who: user, route: `${req.method} ${target}`, result: out.error ? `${out.status} ${out.error}` : String(out.status) });
    if (out.error) return sendJson(res, out.status, { error: out.error, code: out.status === 503 ? 'OFFLINE' : undefined });
    // the Pi's 401 would sign this browser out: it is the Pi's answer, not ours
    // (and a 1xx is no final answer: the browser would wait for one)
    const status = sentryUsbLinkLib.answerStatus(out.status);
    if (target === '/api/setup/config' && req.method === 'GET' && status === 200 && out.type === 'application/json' && !out.buf) {
      // secrets masked here too, whatever the Pi sent; kept for editing while it is away
      const masked = sentryUsbLinkLib.maskConfig(out.body);
      sentryLink.keepConfig(id, masked);
      return sendJson(res, 200, masked);
    }
    if (out.type === 'application/json' && !out.buf) return sendJson(res, status, out.body);
    const data = out.buf || Buffer.from(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? null), 'utf8');
    const ext = { 'application/json': 'json', 'text/plain': 'txt', 'application/zip': 'zip', 'application/gzip': 'gz', 'application/x-gzip': 'gz', 'application/x-tar': 'tar' }[out.type] || 'bin';
    const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'sentryusb';
    res.writeHead(status, {
      'Content-Type': out.type === 'text/plain' ? 'text/plain; charset=utf-8' : out.type, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="sentryusb-${slug(name)}-${slug(target.slice(5))}.${ext}"`, 'Content-Security-Policy': "sandbox; default-src 'none'"
    });
    res.end(data);
    return undefined;
  };
  for (const m of ['GET', 'POST', 'PUT', 'DELETE']) r.add(m, '/api/sentryusb/:id/proxy/.+', proxyTo);

  r.add('POST', '/api/can/tokens', (req, res, { user, body }) => {
    requireConfirmed(req);
    const cfg = canCfg();
    const made = newCanToken(cfg, { vehicleId: body?.vehicleId, label: body?.label });
    saveCanCfg(cfg);
    audit.warn(`CAN Bridge token "${made.entry.label}" made: ${by(req, user)}`);
    return { token: made.token, id: made.entry.id, fingerprint: certFingerprint(), port: CAN_PORT };
  });
  r.add('DELETE', '/api/can/tokens/:id', (req, res, { params, user }) => {
    requireConfirmed(req);
    const cfg = canCfg();
    const t = cfg.tokens.find((x) => x.id === params.id);
    if (!t) throw new HttpError(404, 'No such token.');
    cfg.tokens = cfg.tokens.filter((x) => x !== t);
    saveCanCfg(cfg);
    audit.warn(`CAN Bridge token "${t.label}" revoked: ${by(req, user)}`);
    return { ok: true };
  });
  // pairing: trust the new key a car's logs are signed with, or forget the pairing
  r.add('POST', '/api/can/pairing/:key/trust', async (req, res, { params, body, user }) => {
    requireConfirmed(req);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(params.key)) throw new HttpError(400, 'Not a car key.');
    try {
      const out = await canTrust.trustKey(params.key, String(body?.fingerprint || ''));
      audit.warn(`CAN Bridge ${params.key}: key ${out.pin?.fingerprint} trusted: ${by(req, user)}`);
      announce('can');
      canIndex.kick();
      return out;
    } catch (err) { throw new HttpError(err.status || 500, err.message); }
  });
  r.add('POST', '/api/can/pairing/:key/forget', async (req, res, { params, user }) => {
    requireConfirmed(req);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(params.key)) throw new HttpError(400, 'Not a car key.');
    const out = await canTrust.forgetPin(params.key);
    audit.warn(`CAN Bridge ${params.key}: pairing forgotten: ${by(req, user)}`);
    announce('can');
    return out;
  });
  // every log of a car key the bridge could not sign ("signed": false with an "error") used anyway at once, or none
  // of them: the same per-log override as "Use anyway", on exactly those logs
  r.add('POST', '/api/can/pairing/:key/could-not-sign', async (req, res, { params, body, user }) => {
    requireConfirmed(req);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(params.key)) throw new HttpError(400, 'Not a car key.');
    if (typeof body?.use !== 'boolean') throw new HttpError(400, 'Send { "use": true | false }.');
    const names = await canTrust.setOverrideCouldNotSign(params.key, body.use);
    audit.warn(`CAN Bridge ${params.key}: ${names.length} log${names.length === 1 ? '' : 's'} the bridge could not sign ${body.use ? 'used anyway' : 'no longer used'}${names.length ? ` (${names[0]}${names.length > 1 ? ` to ${names[names.length - 1]}` : ''})` : ''}: ${by(req, user)}`);
    // no longer used: their data leaves the Viewer, the search, the raw view and the sync
    if (!body.use) for (const n of names) await dropCanLog(params.key, n);
    canIndex.kick();
    announce('can');
    return { changed: names.length, names, summary: await canTrust.summary(params.key) };
  });
  // a failed log used anyway (the dashboard warns), or not
  r.add('POST', '/api/can/files/:name/use', async (req, res, { params, body, user }) => {
    requireConfirmed(req);
    const n = parseCanName(params.name);
    if (!n || n.sidecar) throw new HttpError(400, 'Not a CAN log name.');
    try { await canTrust.setOverride(n.vehicleKey, params.name, body?.use === true); } catch (err) { throw new HttpError(err.status || 500, err.message); }
    audit.warn(`CAN log ${params.name} ${body?.use === true ? 'used despite failing its check' : 'no longer used'}: ${by(req, user)}`);
    // no longer used: its data leaves the Viewer, the search, the raw view and the sync
    if (body?.use !== true) await dropCanLog(n.vehicleKey, params.name);
    canIndex.kick();
    announce('can');
    return { ok: true };
  });
  r.add('GET', '/api/can/files', async (req, res, { query }) => {
    const out = await canLogs.list({ limit: Number(query.limit) || 200 });
    // each log's check: verified, failed (why), unsigned, waiting; and its footage: paired, none, or null (no car chosen)
    const pairs = new Map();
    for (const l of out.logs) {
      const rec = await canTrust.record(l.vehicleKey, l.name);
      l.check = rec ? { status: rec.status, kind: rec.kind || null, reason: rec.reason || null, index: rec.index ?? null, override: Boolean(rec.override), chainNote: rec.chainNote || null } : { status: 'waiting', reason: null };
      if (!pairs.has(l.vehicleKey)) pairs.set(l.vehicleKey, await canPrune.pairing(l.vehicleKey).catch(() => null));
      l.footage = pairs.get(l.vehicleKey)?.get(l.name) || null;
    }
    return out;
  });
  r.add('DELETE', '/api/can/files/:name', async (req, res, { params, user }) => {
    requireConfirmed(req);
    try { await canLogs.remove(params.name); } catch (err) { throw new HttpError(err.status || 500, err.message); }
    const n = parseCanName(params.name);
    if (n) {
      await dropCanLog(n.vehicleKey, params.name);
      await canTrust.deleted(n.vehicleKey, params.name).catch(() => {});
    }
    audit.info(`CAN log deleted: ${params.name}: ${by(req, user)}`);
    announce('can');
    return { ok: true };
  });

  // ---- CAN downloads (the Nerd panel, admins only: accounts.js keeps /api/can/files and /api/can/export
  // from watch-only accounts; the upload token reaches only /api/can/logs, so it cannot read anything).
  // For diagnosing a Tesla update: one log as it came (or as candump text, for tools that only read that),
  // a bundle of a car key's logs over a time range with every CAN id seen (new ones stand out), the
  // decoded signals as CSV, and the ids new since a date.
  const CAN_KEY = /^[A-Za-z0-9-]{1,64}$/;
  const CAN_BUNDLE_DAYS = 7;
  // logs (and as many sidecars): a bridge logs a minute a file around the clock (it used to be 10
  // minutes), so the longest range is 10,080 logs; a quarter more leaves room for logs split early
  // (seq) and still stops a runaway count
  const CAN_BUNDLE_FILES = CAN_BUNDLE_DAYS * 24 * 60 * 1.25;
  const CAN_DECODED_HOURS = 24;
  // rows of one decoded export (gzip makes them about 8 times smaller on the wire); by default only
  // changes are written (each signal is kept once a second in the index even when it stays the same)
  const CAN_DECODED_ROWS = 5_000_000;
  const CAN_HEARTBEAT_MS = 60_000; // ... and a signal that stays the same once a minute
  // a cell that starts like a formula (= + - @, a tab or a return) is written with a ' first, so a
  // spreadsheet shows it as text; numbers (negative ones too) are left as they are
  const csvCell = (v) => {
    let t = String(v ?? '');
    if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const csvLine = (cells) => `${cells.map(csvCell).join(',')}\n`;
  const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '');
  /** The car a CAN key belongs to (its map, else the only car), for the time zone a date is read in. */
  const canCarOf = (key) => {
    const vid = canMap()[key];
    const list = vehicles.list();
    return list.find((v) => v.id === vid) || (!vid && list.length === 1 ? list[0] : null);
  };
  /** The VIN the car of a vehicle sent (the latest any of its CAN keys kept), or null. */
  async function detectedCarOf(vid) {
    let best = null;
    for (const k of await canKeysFor(vid)) {
      const c = await canIndex.carOf(k);
      if (c && (!best || (c.seenAt || 0) > (best.seenAt || 0))) best = c;
    }
    return best;
  }
  /** What a car key's car is (carModels.resolveCar): its vehicle's setting, its own VIN, else the vehicle's. */
  async function carForKey(key) {
    const v = canCarOf(key);
    const own = await canIndex.carOf(key);
    return carModels.resolveCar(v?.car, own || (v ? await detectedCarOf(v.id) : null));
  }
  /** A vehicle's car for the API: { setting, detected (VIN without its serial number), and what it resolves to }. */
  async function carSummary(v) {
    const det = await detectedCarOf(v.id).catch(() => null);
    return {
      setting: carModels.normalizeCar(v.car),
      detected: det ? { model: det.model, year: det.year, plant: det.plant, via: det.via, vin: carModels.maskVin(det.vin), seenAt: det.seenAt } : null,
      ...carModels.resolveCar(v.car, det)
    };
  }
  carSummaryRef = carSummary;
  const canKeyOr400 = (k) => {
    const key = String(k || '');
    if (!CAN_KEY.test(key)) throw new HttpError(400, 'Give a CAN Bridge car key.');
    return key;
  };
  /** from/to of a query (the car's own clock, or ISO with a zone): both needed, in order, at most `maxMs` apart. */
  const canRange = (key, query, maxMs, what) => {
    const tz = canCarOf(key)?.timezone || 'UTC';
    let from;
    let to;
    try {
      from = parseWhen(query.from, (...a) => zonedToUtc(...a, tz));
      to = parseWhen(query.to, (...a) => zonedToUtc(...a, tz), true);
    } catch (err) { throw new HttpError(400, err.message); }
    if (from === null || to === null) throw new HttpError(400, 'Give a start and an end (from, to).');
    if (to < from) throw new HttpError(400, 'The end is before the start.');
    if (to - from > maxMs) throw new HttpError(400, `${what} can cover at most ${maxMs >= 86_400_000 ? `${Math.round(maxMs / 86_400_000)} days` : `${Math.round(maxMs / 3_600_000)} hours`}.`);
    return { from, to, tz };
  };
  /** A finished CAN file of the data folder (a log or its sidecar), only by a name canLogs accepts, never a link: { file, size, mtime } or null. */
  const canFileOf = async (name) => {
    const n = parseCanName(name);
    if (!n) return null;
    const dir = path.join(DATA, 'can', n.vehicleKey);
    const file = path.join(dir, name);
    if (path.dirname(file) !== dir) return null;
    const st = await fs.promises.lstat(file).catch(() => null);
    return st?.isFile() ? { file, size: st.size, mtime: st.mtimeMs, ...n } : null;
  };
  /** Write to a response, waiting when its buffer is full; false once the reader has gone. */
  const writeOut = async (res, text) => {
    if (res.destroyed) return false;
    if (!res.write(text)) await waitDrain(res);
    return !res.destroyed;
  };
  const attachment = (name) => `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"`;
  /**
   * A log's candump text (canLogReader.js: either format, the stored file untouched). What goes wrong
   * after the text has started (a log cut off, or refused) ends it with a # line saying so: candump
   * readers skip those, as they skip the bridge's own # lines.
   */
  async function* canCandumpText(reader, chunks = reader.chunks(), { maxBytes = Infinity } = {}) {
    let sent = 0;
    try {
      for await (const c of chunks) {
        if (sent + c.length > maxBytes) {
          // (a bundle's share for this log): cut after the last whole line that fits, then say so; leaving the
          // loop stops xz and the decoder
          const room = maxBytes - sent;
          const cut = room > 0 ? c.lastIndexOf(10, room - 1) + 1 : 0;
          if (cut) yield c.subarray(0, cut);
          yield Buffer.from(`\n# Sentry Six Manager: cut here: this bundle holds at most ${maxBytes} bytes of this log's candump text; download the log alone ("candump .log") for all of it\n`);
          return;
        }
        sent += c.length;
        yield c;
      }
      if (reader.truncated) yield Buffer.from(`\n# Sentry Six Manager: this log ends early: ${reader.truncated.replace(/[\r\n]+/g, ' ')}\n`);
    } catch (err) {
      if (err.retry) throw err;
      yield Buffer.from(`\n# Sentry Six Manager: could not read this log as candump text: ${String(err.message).replace(/[\r\n]+/g, ' ')}\n`);
    }
  }
  /**
   * How many bytes of a log's candump text a bundle holds at most: from the sidecar's frames, else the
   * file's size. The sidecar is the uploader's word, so this is also the cap the bundle cuts that log's
   * text at (canCandumpText maxBytes): the size the check reports then holds, whatever the log decodes to.
   */
  const candumpEstimate = async (f, format) => {
    let side = null;
    try { side = JSON.parse(await fs.promises.readFile(`${f.file}.json`, 'utf8')); } catch { /* none */ }
    // a frame line is about 47 bytes ("(1794099498.000437) can0 34C#01690000204C0001"), 50 with a 29-bit id
    // and 8 bytes: 64 a frame leaves room for those and for the bridge's own # lines
    if (Number.isSafeInteger(side?.frames) && side.frames >= 0) return side.frames * 64 + 64 * 1024;
    // no sidecar: xz packs candump text about 8 times, columns about 17 times (the CAN Bridge's test files)
    return f.size * ((side?.format || format) === 'canbridge-columns-xz/2' ? 40 : 16) + 64 * 1024;
  };
  // a CAN download whose reader stops taking data for this long is ended (it holds a decoder slot)
  const CAN_STALL_MS = 60_000;

  // one log (or its sidecar), exactly as it was received
  r.add('GET', '/api/can/files/:name/download', async (req, res, { params, user }) => {
    const f = await canFileOf(params.name);
    if (!f) throw new HttpError(parseCanName(params.name) ? 404 : 400, parseCanName(params.name) ? 'No such CAN file.' : 'That is not a CAN Bridge log name.');
    res.writeHead(200, {
      'Content-Type': f.sidecar ? 'application/json' : 'application/x-xz', 'Content-Length': f.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': attachment(params.name)
    });
    if (req.method === 'HEAD') return res.end();
    audit.info(`CAN file downloaded: ${params.name}: ${by(req, user)}`);
    require('stream').pipeline(fs.createReadStream(f.file, { start: 0, end: Math.max(0, f.size - 1) }), res, () => {});
    return undefined;
  });

  // one log as candump text (<name>.log, plain), decoded as it streams, for SavvyCAN, cantools and other tools
  // that only read candump: the same lines whichever format the log was stored in
  r.add('GET', '/api/can/files/:name/candump', async (req, res, { params, user }) => {
    const n = parseCanName(params.name);
    if (!n || n.sidecar) throw new HttpError(400, 'That is not a CAN Bridge log name.');
    const f = await canFileOf(params.name);
    if (!f) throw new HttpError(404, 'No such CAN file.');
    // downloads have a decoder slot of their own (canLogReader.js): busy for half a minute, try again later
    const reader = openCanLog(f.file, { pool: 'download', slotWaitMs: 30_000 });
    const chunks = reader.chunks();
    // the first text before the answer: a log that cannot be read at all (a columns log is checked whole
    // before its first line; a file xz cannot read gives nothing) is an error, not an empty file
    let first;
    try { first = await chunks.next(); } catch (err) {
      throw new HttpError(err.retry ? 503 : 422, err.busy ? 'Another CAN log is being turned into candump text; try again in a minute.' : err.retry ? 'The log cannot be read just now; try again.' : `This log cannot be turned into candump text: ${err.message}`);
    }
    if (first.done && reader.truncated) throw new HttpError(422, `This log cannot be turned into candump text: xz could not read it: ${reader.truncated}`);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=us-ascii', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': attachment(params.name.replace(/\.xz$/, ''))
    });
    if (req.method === 'HEAD') { await chunks.return(); return res.end(); }
    audit.info(`CAN file downloaded as candump text: ${params.name}: ${by(req, user)}`);
    stopWhenStalled(res, CAN_STALL_MS);
    const { Readable } = require('stream');
    require('stream').pipeline(Readable.from((async function* all() { if (!first.done) yield first.value; yield* canCandumpText(reader, chunks); }())), res, () => {});
    return undefined;
  });

  /** The ids.csv of a bundle: every id seen, the ones the DBC does not know flagged. */
  const idsCsv = (ids) => [
    csvLine(['bus', 'id_hex', 'message', 'unknown', 'frames', 'hz', 'first_seen_utc', 'last_seen_utc', 'minutes_seen']),
    ...ids.map((e) => csvLine([e.bus, `0x${e.id}`, e.name || 'unknown', e.name ? '' : 'UNKNOWN', e.frames, e.hz, isoOf(e.firstSeen), isoOf(e.lastSeen), e.minutes]))
  ].join('');

  // a car key's logs and sidecars over a time range (at most a week), with ids.csv, as one .zip streamed as it is read
  r.add('GET', '/api/can/export/bundle', async (req, res, { query, user }) => {
    const key = canKeyOr400(query.key);
    const { from, to } = canRange(key, query, CAN_BUNDLE_DAYS * 86_400_000, 'A bundle');
    let names = [];
    try { names = await fs.promises.readdir(path.join(DATA, 'can', key)); } catch { /* no logs */ }
    const logs = names.map((nm) => ({ nm, n: parseCanName(nm) })).filter((x) => x.n && !x.n.sidecar && x.n.vehicleKey === key).sort((a, b) => a.n.startedAt - b.n.startedAt || a.n.seq - b.n.seq);
    // the logs that start in the range, and the one already running at its start (a log is a minute,
    // at most a few; a log starting exactly at the end holds nothing of the range)
    const inside = logs.filter((x) => x.n.startedAt >= from && (x.n.startedAt < to || x.n.startedAt === from));
    const before = logs.filter((x) => x.n.startedAt < from && x.n.startedAt >= from - 30 * 60_000).pop();
    const picked = before ? [before, ...inside] : inside;
    if (!picked.length) throw new HttpError(404, 'No logs of this car key in that time.');
    if (picked.length > CAN_BUNDLE_FILES) throw new HttpError(413, `That is ${picked.length} logs: at most ${CAN_BUNDLE_FILES} go in one bundle. Take a shorter time.`);
    // candump=1: each log's candump text too (<name>.log, made as it streams), beside the log as received
    const withText = query.candump === '1' || query.candump === 'true';
    const entries = [];
    const manifest = [];
    let total = 0;
    let textBytes = 0;
    for (const { nm } of picked) {
      let format = null;
      for (const name of [nm, `${nm}.json`]) {
        const f = await canFileOf(name);
        if (!f) continue;
        total += f.size + 200;
        entries.push({ name: `${key}/${name}`, size: f.size, mtime: f.mtime, open: () => fs.createReadStream(f.file, { start: 0, end: Math.max(0, f.size - 1) }) });
        if (f.sidecar) { try { format = JSON.parse(await fs.promises.readFile(f.file, 'utf8'))?.format ?? null; } catch { /* not JSON */ } }
      }
      const log = await canFileOf(nm);
      if (withText && log) {
        const most = await candumpEstimate(log, format);
        textBytes += most + 400; // (and the note when it is cut, and the zip's headers)
        entries.push({ name: `${key}/${nm.replace(/\.xz$/, '')}`, size: null, mtime: log.mtime, open: () => { const rd = openCanLog(log.file, { pool: 'download' }); return require('stream').Readable.from(canCandumpText(rd, rd.chunks(), { maxBytes: most })); } });
      }
      const rec = await canTrust.record(key, nm).catch(() => null);
      manifest.push({ name: nm, startedAt: isoOf(parseCanName(nm).startedAt), bytes: log?.size ?? null, sidecar: Boolean(await canFileOf(`${nm}.json`)), format: typeof format === 'string' ? format.slice(0, 64) : null, check: rec?.status || 'waiting', ...(rec?.reason ? { reason: rec.reason } : {}) });
    }
    if (total + textBytes > ZIP_LIMIT - 64 * 1024 * 1024) throw new HttpError(413, `That bundle would be over 4 GB${withText ? ' with the candump text' : ''}: take a shorter time.`);
    // check=1: what it would hold (the panel asks first, so a mistake is a message, not a downloaded error)
    if (query.check) return { logs: picked.length, files: entries.length, bytes: total, ...(withText ? { candumpBytes: textBytes } : {}), from, to };
    const file = `can-${key}-${isoOf(from).slice(0, 16).replace(/[-:]/g, '')}-to-${isoOf(to).slice(0, 16).replace(/[-:]/g, '')}.zip`;
    // the logs go first, so the download starts at once; ids.csv and manifest.json (made from the
    // index while the logs stream, only the top of each minute read) come last. The sizes were
    // checked with 64 MB to spare, far more than the two small files need.
    let ids = null;
    const idsOf = async () => (ids ||= await canIndex.idSummary(key, from, to, { stop: () => res.destroyed }));
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': attachment(file) });
    audit.info(`CAN bundle downloaded: ${key} ${isoOf(from)} to ${isoOf(to)} (${picked.length} logs): ${by(req, user)}`);
    if (withText) stopWhenStalled(res, CAN_STALL_MS);
    try {
      await streamZip(res, [
        ...entries,
        { name: 'ids.csv', mtime: Date.now(), make: async () => Buffer.from(idsCsv(await idsOf())) },
        {
          name: 'manifest.json', mtime: Date.now(), make: async () => Buffer.from(`${JSON.stringify({
            vehicleKey: key, from: isoOf(from), to: isoOf(to), madeAt: isoOf(Date.now()), logs: manifest,
            ids: { count: (await idsOf()).length, unknown: (await idsOf()).filter((e) => !e.name).length },
            note: `The .log.xz files are exactly as the CAN Bridge uploaded them and signed them (xz; "format" says which: canbridge-candump-xz/1 is candump text, canbridge-columns-xz/2 the same lines as columns, which only Sentry Six Manager and the CAN Bridge's tools/columns-to-candump.js read).${withText ? ' Each .log beside it is that log as candump text, made from it for this download (not signed: check the .log.xz).' : ''} ids.csv is every CAN id seen in the range, from the index (frames per minute); "unknown" ones are not in the DBC set this server decodes the car with (its model's: model3dbc with opendbc's and the firmware overrides for a Model 3/Y, docs/can-bridge-api.md).`
          }, null, 2)}\n`)
        }
      ]);
      res.end();
    } catch (err) {
      log.warn(`CAN bundle ${file}: ${err.message}`);
      res.destroy();
    }
    return undefined;
  });

  /**
   * The rows a decoded export writes, signal by signal: every point the index keeps (`every`), or
   * only changes, with a signal that stays the same once a minute (so "the same" can be told from
   * "stopped sending"). `last` carries each signal's last written point across minutes.
   */
  const decodedRows = (data, t, from, to, only, every, last, plan = null) => {
    const pts = [];
    // (the computed stats' inputs are read too, and written only when asked for)
    const read = plan ? new Set([...(only || []), ...plan.inputs]) : only;
    for (const [name, list] of Object.entries(data.signals || {})) {
      if (read && !read.has(name)) continue;
      let l = last.get(name);
      for (const [ms, v] of list) {
        const at = t + ms;
        if (at < from || at > to) continue;
        if (!every && l && l.v === v && at - l.at < CAN_HEARTBEAT_MS) continue;
        if (!l) last.set(name, (l = { v, at }));
        else { l.v = v; l.at = at; }
        pts.push([at, name, v]);
      }
    }
    const sorted = pts.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    if (!plan) return sorted;
    // the computed stats (web/carCalc.js, as the Viewer shows them) from the inputs' latest values
    const calc = canCalc.calcPoints(sorted, plan, plan.state, every, CAN_HEARTBEAT_MS);
    const kept = only ? sorted.filter((p) => only.has(p[1])) : sorted;
    return calc.length ? kept.concat(calc).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)) : kept;
  };
  /** The computed stats an export writes (asked for by id, or all with every signal), with the state they carry across minutes. */
  const decodedPlan = (only) => {
    const plan = canCalc.calcPlan(only);
    return plan.calcs.length ? { ...plan, state: {} } : null;
  };

  // the decoded signals of a car key over a time range (at most a day) as CSV, streamed minute by
  // minute (gzip when the browser takes it, as browsers do for a download: about 8 times smaller).
  // mode=changes (the default without a signal list) or mode=every (the default with one).
  r.add('GET', '/api/can/export/decoded', async (req, res, { query, user }) => {
    const key = canKeyOr400(query.key);
    const { from, to } = canRange(key, query, CAN_DECODED_HOURS * 3_600_000, 'A decoded export');
    // (a computed stat by its id: calc.batteryPower)
    const only = query.signals ? new Set(String(query.signals).split(',').map((x) => x.trim()).filter((x) => /^\w{1,80}$/.test(x) || canCalc.isCalc(x)).slice(0, 200)) : null;
    const every = query.mode === 'every' || (Boolean(only) && query.mode !== 'changes');
    const meta = await canIndex.signals([key]);
    if (query.check) {
      // how many rows it would be: a few minutes of the range counted, times its minutes
      const times = await canIndex.minuteTimes(key, from, to);
      const picks = [...new Set([0, 0.5, 1].map((f) => times[Math.min(times.length - 1, Math.floor(f * (times.length - 1)))]).filter((t) => t !== undefined))];
      let rows = 0;
      for (const t of picks) {
        const data = (await canIndex.minutesIn(key, t, t).next()).value?.[1];
        if (data) rows += decodedRows(data, t, -Infinity, Infinity, only, every, new Map(), decodedPlan(only)).length;
      }
      const estimatedRows = picks.length ? Math.round((rows / picks.length) * times.length) : 0;
      return {
        ok: true, from, to, signals: only ? [...only].filter((x) => meta[x] || canCalc.isCalc(x)).length : Object.keys(meta).length + canCalc.POINT.length, mode: every ? 'every' : 'changes',
        minutes: times.length, estimatedRows, rowLimit: CAN_DECODED_ROWS, willStop: estimatedRows > CAN_DECODED_ROWS
      };
    }
    const file = `can-${key}-decoded-${isoOf(from).slice(0, 16).replace(/[-:]/g, '')}-to-${isoOf(to).slice(0, 16).replace(/[-:]/g, '')}.csv`;
    const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': attachment(file),
      ...(gz ? { 'Content-Encoding': 'gzip' } : {}), Vary: 'Accept-Encoding'
    });
    audit.info(`CAN decoded export: ${key} ${isoOf(from)} to ${isoOf(to)}: ${by(req, user)}`);
    let out = res;
    if (gz) {
      out = zlib.createGzip({ level: 4 });
      require('stream').pipeline(out, res, () => {});
    }
    const put = async (text) => {
      if (res.destroyed || out.destroyed) return false;
      if (!out.write(text)) await waitDrain(out);
      return !res.destroyed && !out.destroyed;
    };
    let rows = 0;
    const last = new Map();
    const plan = decodedPlan(only);
    if (!(await put(csvLine(['timestamp_utc', 'signal', 'value', 'unit', 'value_name'])))) return undefined;
    outer: for await (const [t, data] of canIndex.minutesIn(key, from, to)) {
      let chunk = '';
      for (const [at, name, v] of decodedRows(data, t, from, to, only, every, last, plan)) {
        if (rows >= CAN_DECODED_ROWS) { chunk += `# stopped at ${CAN_DECODED_ROWS} rows: export a shorter time, or fewer signals\n`; await put(chunk); break outer; }
        const m = canCalc.isCalc(name) ? { unit: canCalc.calcUnit(name) } : meta[name] || {};
        chunk += csvLine([isoOf(at), name, v, m.unit || '', m.values?.[v] ?? '']);
        rows++;
      }
      if (chunk && !(await put(chunk))) return undefined;
    }
    out.end();
    return undefined;
  });

  // CAN ids first seen on or after a date (as after a software update), from per-day id summaries
  // the index keeps (complete, however long the history); JSON for the panel, or CSV
  r.add('GET', '/api/can/export/new-ids', async (req, res, { query, user }) => {
    const key = canKeyOr400(query.key);
    const tz = canCarOf(key)?.timezone || 'UTC';
    let since;
    try { since = parseWhen(query.since, (...a) => zonedToUtc(...a, tz)); } catch (err) { throw new HttpError(400, err.message); }
    if (since === null) throw new HttpError(400, 'Give the date to look from (since).');
    const out = await canIndex.newIds(key, since, { limit: 1000, stop: () => res.destroyed });
    const profile = await canIndex.profileFor(key);
    const rows = out.appeared.map((x) => {
      const [bus, id] = x.id.split(':');
      const name = canIndex.messageName(x.id, undefined, [], profile);
      return { key: x.id, bus, id, name, unknown: !name, firstSeen: x.at, lastSeen: x.lastSeen, minutesSeen: x.seenMinutes, localTime: localTime(x.at, tz) };
    });
    const answer = { key, since, timezone: tz, ids: rows, count: out.appearedCount, idCount: out.idCount, complete: out.complete, scannedMinutes: out.scannedMinutes, totalMinutes: out.totalMinutes };
    if (query.format !== 'csv') return answer;
    const day = String(query.since).slice(0, 10).replace(/[^0-9-]/g, '');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': attachment(`can-${key}-new-ids-since-${day}.csv`) });
    res.end([
      csvLine(['bus', 'id_hex', 'message', 'unknown', 'first_seen_utc', 'last_seen_utc', 'minutes_seen']),
      ...rows.map((x) => csvLine([x.bus, `0x${x.id}`, x.name || 'unknown', x.unknown ? 'UNKNOWN' : '', isoOf(x.firstSeen), isoOf(x.lastSeen), x.minutesSeen])),
      ...(out.appearedCount > rows.length ? [`# the first ${rows.length} of ${out.appearedCount}\n`] : [])
    ].join(''));
    return undefined;
  });

  // Savings by month (the main pages' chart)
  r.add('GET', '/api/vehicles/:id/savings-by-month', (req, res, { params, query }) => {
    const v = vehicleOr404(params.id);
    const months = Math.max(3, Math.min(36, Number(query.months) || 12));
    return { months: savings.byMonth(v.id, months), total: savings.forVehicle(v.id) };
  });
  // Search by place: every clip that passed near a point (speedIndex.near)
  r.add('GET', '/api/places/near', async (req, res, { query }) => {
    const lat = Number(query.lat);
    const lon = Number(query.lon);
    const radius = Math.max(25, Math.min(5000, Number(query.radius) || 150));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new HttpError(400, 'Give a place (lat, lon).');
    const list = vehicles.list();
    const byId = new Map(list.map((v) => [v.id, v]));
    const hits = await speedIndex.near(list.map((v) => v.id), lat, lon, radius);
    return {
      radius,
      results: hits.filter((h) => inventory.get(h.vid)?.files?.has(h.rel)).map((h) => ({
        vehicle: h.vid, vehicleName: byId.get(h.vid)?.name || h.vid, day: h.day, clip: clipKeyOf(h.rel),
        path: path.join(vehicles.rootOf(byId.get(h.vid)), h.rel), second: h.second, metres: h.metres
      }))
    };
  });
  // "Index speeds" on the Footage page: start a pass now, and how far it is
  r.add('GET', '/api/speeds/status', () => speedIndex.status());
  r.add('POST', '/api/speeds/index', () => {
    speedIndex.kick();
    return speedIndex.status();
  });
  // ... and up to 40 clips the index has not reached yet, read now (and indexed);
  // a clip without telemetry, or out of reach, is null
  r.add('POST', '/api/telemetry/speeds', async (req, res, { body }) => {
    const paths = Array.isArray(body?.paths) ? body.paths.filter((p) => typeof p === 'string').slice(0, 40) : [];
    const speeds = [];
    for (const p of paths) {
      try {
        const real = await studioReadable.resolve(p);
        if (!real || hiddenPath(real)) { speeds.push(null); continue; }
        const st = await fs.promises.stat(real);
        const owner = vehicleForReal(real);
        const rel = owner ? path.relative(owner.root, real).split(path.sep).join('/') : null;
        speeds.push(await speedIndex.clip(owner?.vehicle.id, rel, real, st.size, st.mtimeMs));
      } catch {
        speeds.push(null);
      }
    }
    return { speeds };
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
  r.add('POST', '/api/vehicles/:id/trash', async (req, res, { params, body, user }) => {
    vehicleOr404(params.id);
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    const recs = new Map((inventory.get(params.id)?.recordings || []).map((r) => [r.id, r]));
    const out = await bin.trash(params.id, ids);
    // "Also delete its CAN data": the logs of the moved recordings' minutes go now, for good
    if (body?.withCan === true && out.moved?.length) {
      out.can = await canPruneRef?.deleteWith(params.id, { rels: out.moved.flatMap((id) => recs.get(id)?.files || []), by: by(req, user) });
      announce('can');
    }
    announce('inventory');
    announce('bin');
    return out;
  });
  // for the Move to trash confirmation: how many CAN logs "Also delete its CAN data" would delete
  // (can: null when no CAN Bridge key is mapped to the car)
  r.add('POST', '/api/vehicles/:id/trash-preview', async (req, res, { params, body }) => {
    vehicleOr404(params.id);
    const wanted = new Set(Array.isArray(body?.ids) ? body.ids : []);
    const recs = (inventory.get(params.id)?.recordings || []).filter((r) => wanted.has(r.id) && !r.protected);
    return { recordings: recs.length, can: recs.length ? await canWith(params.id, { rels: recs.flatMap((r) => r.files) }) : null };
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
    // its CAN logs now (an automatic delete waits a little for more)
    if (item?.vehicleId) canPruneRef?.soon(item.vehicleId, 1000);
    announce('bin');
    return out;
  });
  r.add('POST', '/api/bin/empty', async (req, res, { body, user }) => {
    if (body?.confirm !== true) throw new HttpError(400, 'Confirm emptying the Recycle Bin.');
    requireConfirmed(req);
    if (body?.vehicle) vehicleOr404(body.vehicle);
    const out = await bin.empty(body?.vehicle || null);
    audit.info(`Recycle Bin emptied${body?.vehicle ? ` for ${body.vehicle}` : ''}: ${out.deleted} item(s), ${formatBytes(out.bytes)}: ${by(req, user)}`);
    for (const v of body?.vehicle ? [vehicleOr404(body.vehicle)] : vehicles.list()) canPruneRef?.soon(v.id, 1000);
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
    // every node's power with this server's: "All servers" (nodePower.js);
    // with no nodes, nothing is added
    const nodePower = combinePower(snapshot.power, nodes.power(), priceNow);
    // the most each server (and all of them together) has drawn: the power
    // bars are full at it
    if (nodePower.combined) {
      nodePower.combined.peakW = stats.peak('all', nodePower.combined.totalW);
      for (const n of nodePower.nodes) n.peakW = stats.peak(`node:${n.id}`, n.totalW);
    }
    return {
      ...snapshot,
      ...(nodePower.combined ? { power: { ...snapshot.power, nodes: nodePower.nodes, combined: nodePower.combined } } : {}),
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
    appearance: { reduceEffects: false, clock24: false, ...db.get('appearance', {}) },
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
  // (a field left out keeps its value: clock24 is the 24-hour clock, 12-hour
  // when off)
  r.add('PUT', '/api/settings/appearance', (req, res, { body }) => {
    const next = { reduceEffects: false, clock24: false, ...db.get('appearance', {}) };
    for (const k of ['reduceEffects', 'clock24']) if (body && k in body) next[k] = Boolean(body[k]);
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
  // (the viewer's 12/24-hour clock is the manager's, Settings > Appearance)
  const clock24 = () => Boolean(db.get('appearance', {}).clock24);
  r.add('GET', '/api/studio/settings', () => ({ ...db.get('studio-settings', {}), timeFormat: clock24() ? '24h' : '12h' }));
  r.add('POST', '/api/studio/settings', (req, res, { body }) => {
    if (!body || typeof body.key !== 'string' || body.key.length > 100) throw new HttpError(400, 'Invalid setting');
    if (body.key === 'timeFormat') {
      db.set('appearance', { reduceEffects: false, ...db.get('appearance', {}), clock24: body.value === '24h' });
      return { ok: true };
    }
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
  const PUBLIC_STATIC = new Set(['/login', '/web/login.js', '/web/shell.css', '/web/icon.png', '/login/code', '/web/login-code.js', '/web/login-two-factor.js']);
  // the sign-in steps a banned address is refused, signed in or not
  const BAN_STEPS = new Set(['/api/auth/login', '/api/auth/2fa/code', '/api/auth/setup', '/api/auth/confirm', '/api/auth/password']);
  // all a session may do while its account still has to set up two-step sign-in
  const SETUP_ONLY_API = new Set(['GET /api/auth/me', 'GET /api/auth/2fa', 'POST /api/auth/2fa/start', 'POST /api/auth/2fa/enable', 'POST /api/auth/confirm', 'POST /api/auth/logout']);
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
      // Metrics for the owner's own monitoring (Prometheus): off unless turned
      // on in Health, then only with the token made there (read-only numbers)
      if (rawPath === '/metrics') {
        const cfg = db.get('metrics', null);
        if (!cfg?.enabled || !cfg.tokenHash) return sendJson(res, 404, { error: 'Not found' });
        const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const ok = given && crypto.timingSafeEqual(Buffer.from(crypto.createHash('sha256').update(given).digest('hex')), Buffer.from(cfg.tokenHash));
        if (!ok) {
          res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' });
          return res.end('Bearer token required');
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(metricsText());
      }
      // CAN Bridge uploads (docs/can-bridge-api.md): opt-in, HTTPS only, a
      // write-only token; no cookies, so the page checks below do not apply
      if (rawPath === '/api/can/logs' || rawPath.startsWith('/api/can/logs/')) return canUpload(req, res, rawPath);
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
      // /v/<version>/<path>: <path>, kept for a year when the version is the
      // current one (versionLinks)
      let longCache = false;
      // the Studio pages (served at /v/<version>/studio/) name the app's
      // images as ../../assets/…, written for the desktop app's folders: from
      // a versioned page that lands on /v/assets/…, so it is /assets/…
      if (p.startsWith('/v/assets/')) p = p.slice(2);
      const versioned = VERSIONED.exec(p);
      if (versioned && !versioned[2].startsWith('/api/') && !versioned[2].startsWith('/v/')) {
        p = versioned[2];
        longCache = versioned[1] === assetVersion(req);
      }

      let user = auth.user(req);
      const isApi = p.startsWith('/api/');
      // a banned address: every sign-in step (and anything else without a
      // session) is refused; a session it already has keeps working
      if (isApi && p !== '/api/auth/me' && (!user || BAN_STEPS.has(p)) && access.banned(clientKey(req))) {
        return sendJson(res, 429, { error: BANNED_TEXT, code: 'BANNED' });
      }
      // the two-step rules (Settings → Security), checked on every request,
      // so turning one on also applies to devices already signed in
      let setupOnly = false;
      if (user) {
        const state = twoFactorState(user, fromHome(req));
        if (state === 'out') {
          const h = auth.sessionHash(req);
          if (h) db.deleteSession(h);
          audit.warn(`Signed out (no two-step sign-in, outside the home network): ${by(req, user)}`);
          if (isApi) return sendJson(res, 401, { error: access.get().twoFactor.everyone ? TWO_FACTOR_EVERYONE_TEXT : TWO_FACTOR_OUTSIDE_TEXT, code: 'TWO_FACTOR_REQUIRED' });
          user = null;
        } else if (state === 'setup') {
          setupOnly = true;
          if (isApi && !SETUP_ONLY_API.has(`${req.method} ${p}`)) return sendJson(res, 403, { error: TWO_FACTOR_SETUP_TEXT, code: 'TWO_FACTOR_SETUP' });
        }
      }
      if (user) {
        // when and from where each signed-in device was last used
        // (at most once a minute each: video and scrub requests come many a second)
        const h = auth.sessionHash(req);
        const nowMs = Date.now();
        if (h && isApi && req.method === 'GET') noteStartCall(req, h, p, url.search);
        if (h && !(seenAt.get(h) > nowMs - 60_000)) {
          seenAt.set(h, nowMs);
          if (seenAt.size > 5000) seenAt.clear();
          db.touchSession(h, clientKey(req));
        }
        // a watch-only account watches: no deleting, converting or settings
        if (isApi && !viewerMay(req.method, p)) {
          const role = accounts.roleOf(user);
          if (role === 'viewer') return sendJson(res, 403, { error: 'This account can only watch footage. An admin account can do this.' });
          // an admin outside the home network, when Settings → Security keeps admin work at home
          const rules = access.get().homeOnly;
          if ((rules.adminPages || (rules.adminChanges && req.method !== 'GET' && req.method !== 'HEAD')) && !fromHome(req)) {
            return sendJson(res, 403, { error: rules.adminPages ? HOME_ONLY_PAGES_TEXT : HOME_ONLY_CHANGES_TEXT, code: 'HOME_NETWORK_ONLY' });
          }
        }
      }
      const publicStatic = PUBLIC_STATIC.has(p) || (p.startsWith('/web/fonts/') && !p.slice(11).includes('/'));

      if (isApi) {
        const m = r.match(req.method, rawPath);
        if (!m && p !== '/api/events' && p !== '/api/converter/events' && p !== '/api/media' && p !== '/api/scrub' && p !== '/api/ui-packs/upload') return sendJson(res, 404, { error: 'Not found' });
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
        if (p === '/api/scrub') {
          // one clip's scrub previews (a JPEG grid), made the first time it is asked for
          const real = await studioReadable.resolve(url.searchParams.get('path') || '');
          if (!real || hiddenPath(real) || !/\.mp4$/i.test(real)) return sendJson(res, 403, { error: 'Outside the vehicle shares.' });
          const grid = await scrubFrames.get(real);
          if (!grid) return sendJson(res, 404, { error: 'No previews for this clip.' });
          const size = (await fs.promises.stat(grid)).size;
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': size, 'Cache-Control': 'private, max-age=86400' });
          if (req.method === 'HEAD') return res.end();
          return require('stream').pipeline(fs.createReadStream(grid), res, () => {});
        }
        if (p === '/api/ui-packs/upload') {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
          // a pack's scripts run as whoever signs in: the password again
          requireConfirmed(req);
          // the .zip comes as the raw body, its name in a header
          const bytes = await readRaw(req, MAX_UI_PACK_BYTES);
          let fileName = '';
          try {
            fileName = decodeURIComponent(String(req.headers['x-file-name'] || ''));
          } catch {
            // no name: the pack's ui.json or a default
          }
          const pack = await uiPacks.install(bytes, fileName);
          audit.warn(`Interface "${pack.name}" (${pack.id}) uploaded, ${pack.files} files: ${by(req, user)}`);
          return sendJson(res, 200, { ok: true, pack });
        }
        const body = req.method === 'GET' ? undefined : await readJson(req, p.startsWith('/api/converter/') ? 256 * 1024 : 1024 * 1024);
        const out = await m.route.handler(req, res, { params: m.params, query: Object.fromEntries(url.searchParams), body, user });
        if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
        return undefined;
      }

      // A browser that opens /original shows the built-in interface from then
      // on (a cookie), whatever pack is chosen: a pack that breaks the pages
      // never locks anyone out. /original?off=1 goes back to the choice.
      if (p === '/original') {
        const off = url.searchParams.get('off') === '1';
        res.writeHead(302, {
          Location: '/#/settings/interface',
          'Set-Cookie': `${UI_COOKIE}=${off ? '' : '1'}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${off ? 0 : 365 * 86400}${auth.isSecure(req) ? '; Secure' : ''}`,
          'Cache-Control': 'no-store'
        });
        return res.end();
      }
      // every account needs two-step sign-in and this one has none: its page to set it up, nothing else
      if (setupOnly && !publicStatic && p !== '/login/two-factor' && (p === '/' || /\.html?$/i.test(p) || p.startsWith('/studio'))) {
        res.writeHead(302, { Location: '/login/two-factor', 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (!user && !publicStatic) {
        // a sign-in waiting for its two-step code goes to the code page
        const where = accounts.pendingUser(pendingToken(req)) ? '/login/code' : '/login';
        res.writeHead(302, { Location: `${where}${p === '/' ? '' : `?next=${encodeURIComponent(p + url.search)}`}` });
        return res.end();
      }
      // a script asked for by its version: its links to the shared scripts get that version too
      const scriptVersion = versioned && /\.m?js$/i.test(p) ? versioned[1] : null;
      const versionedScript = (opts) => (scriptVersion && !opts.transform ? { ...opts, transform: (js) => versionScriptLinks(js, scriptVersion), transformKey: scriptVersion, cache: longCache ? LONG_CACHE : 'no-cache' } : opts);
      const serve = async (root, rel, opts = {}) => {
        if (longCache) opts = { ...opts, cache: LONG_CACHE };
        opts = versionedScript(opts);
        if (!(await serveFile(req, res, root, rel, opts))) notFound(res);
      };
      // the chosen interface's file first, else the built-in one
      const ui = async (kind, root, rel, opts = {}) => {
        if (/\.html?$/i.test(rel)) {
          const inner = opts.transform;
          const version = assetVersion(req);
          const pageDir = p.endsWith('/') ? p : `${path.posix.dirname(p)}/`;
          const critical = rel !== 'login.html'; // the login page has no status to show yet
          opts = { ...opts, transform: (html) => {
            const page = inner ? inner(html) : html;
            return versionLinks(critical ? withCriticalBar(page) : page, pageDir, version);
          } };
        }
        const own = originalOnly(req) ? null : uiPacks.root(kind);
        if (own && await serveFile(req, res, own, rel, versionedScript({ ...opts, cache: longCache ? LONG_CACHE : 'no-cache' }))) return undefined;
        return serve(root, rel, opts);
      };
      if (p === '/' || p === '/index.html') {
        const key = `${user}|${assetVersion(req)}`;
        startLearning(auth.sessionHash(req), key);
        return ui('web', WEB, 'index.html', { transform: (html) => withPrefetch(html, key) });
      }
      if (p === '/login') return ui('web', WEB, 'login.html');
      // the two-step code page: always the built-in one, for every interface
      if (p === '/login/code') return serve(WEB, 'login-code.html');
      // setting up two-step sign-in when every account needs it: the built-in page too
      if (p === '/login/two-factor') return serve(WEB, 'login-two-factor.html');
      // always the built-in one: an interface pack cannot replace the bar
      if (p === '/web/critical.js') return serve(WEB, 'critical.js');
      if (p.startsWith('/web/')) return ui('web', WEB, p.slice(5), { cache: p.includes('/fonts/') ? 'public, max-age=604800' : 'no-cache' });
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
      // the built-in Viewer's translations: English with the page, any other
      // language when it is first shown (server/studioTranslations.js)
      if (p === '/studio/scripts/data/translations.js') {
        const t = await studioTranslations.module();
        return sendText(req, res, t.body, { type: 'text/javascript; charset=utf-8', etag: t.etag, ...(longCache ? { cache: LONG_CACHE } : {}) });
      }
      const lang = /^\/studio\/i18n\/([a-z]{2,3}(?:-[A-Za-z]{2,4})?)\.json$/.exec(p);
      if (lang) {
        const t = await studioTranslations.language(lang[1]);
        return t ? sendText(req, res, t.body, { type: 'application/json; charset=utf-8', etag: t.etag }) : notFound(res);
      }
      if (p.startsWith('/studio/')) {
        const rel = p.slice('/studio/'.length);
        const opts = rel === 'index.html' ? { transform: studioHtml } : rel === 'encoder.html' ? { transform: encoderHtml } : {};
        if (rel.startsWith('fonts/')) opts.cache = 'public, max-age=604800';
        return ui('studio', path.join(SRC, 'renderer'), rel, opts);
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
  // shows the app, so no password or footage ever goes over it: every
  // request is redirected straight to the HTTPS address (the browser's own
  // certificate warning is the only step on a new device).
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
    const redirect = http.createServer((req, res) => {
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
      res.writeHead(308, { Location: httpsUrl, 'Cache-Control': 'no-store' });
      return res.end();
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
  // The CAN Bridge's port (CAN_PORT, 10000): only the CAN upload API
  // (/api/can/logs…), with the same certificate; it listens only while the
  // uploads are on (the Nerd settings), so the port is closed otherwise
  canPort = createCanPort({
    port: CAN_PORT, host: HOST, log, url: `${tlsSource ? 'https' : 'http'}://${HOST}:${CAN_PORT} (CAN Bridge uploads at /api/can/logs${tlsSource ? ', Sentry USB link at wss://…/api/sentryusb/link' : ''})`,
    make: async () => {
      const only = (req, res) => {
        const p = String(req.url || '').split('?')[0];
        if (p === '/api/can/logs' || p.startsWith('/api/can/logs/')) return canUpload(req, res, p);
        securityHeaders(req, res, p);
        return sendJson(res, 404, { error: 'Not found' });
      };
      let srv;
      if (tlsSource) {
        const m = await tlsSource.load();
        srv = https.createServer({ key: m.key, cert: m.cert, minVersion: 'TLSv1.2' }, only);
      } else srv = http.createServer(only); // behind a reverse proxy that does HTTPS
      // the Sentry USB management link (docs/sentry-usb-link.md): TLS only, its
      // proof covers this port's certificate; nothing else upgrades
      srv.on('upgrade', (req, socket, head) => {
        if (!tlsSource || !sentryLink) {
          socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return socket.destroy();
        }
        return sentryLink.handleUpgrade(req, socket, head);
      });
      srv.setTimeout(120_000);
      // a client that sends its headers slowly, or a body for ever, is cut off (TLS 1.2 and 1.3 are both accepted)
      srv.headersTimeout = 20_000;
      srv.requestTimeout = 10 * 60_000;
      srv.maxConnections = 256;
      // one address cannot take every connection (the bridge uses one or two): at most 6 each,
      // and a connection that has not sent a request within 15 s is closed
      const perAddress = new Map();
      // (over TLS the raw socket never emits 'data': its first request or
      // upgrade, found by address and port, is what clears the timer; before
      // this, every TLS connection was cut 15 s after it opened)
      const idleTimers = new Map(); // "address|port" -> timer
      const idleKey = (sock) => `${sock.remoteAddress}|${sock.remotePort}`;
      const seen = (req) => { const k = idleKey(req.socket); clearTimeout(idleTimers.get(k)); idleTimers.delete(k); };
      srv.on('request', seen);
      srv.on('upgrade', seen);
      srv.on('connection', (socket) => {
        const ip = socket.remoteAddress || '?';
        const n = (perAddress.get(ip) || 0) + 1;
        if (n > 6) { socket.destroy(); return; }
        perAddress.set(ip, n);
        socket.once('close', () => { const m = (perAddress.get(ip) || 1) - 1; if (m > 0) perAddress.set(ip, m); else perAddress.delete(ip); });
        const k = idleKey(socket);
        const idle = setTimeout(() => { idleTimers.delete(k); socket.destroy(); }, 15_000);
        idle.unref?.();
        idleTimers.set(k, idle);
        if (!tlsSource) socket.once('data', () => { clearTimeout(idle); idleTimers.delete(k); });
        socket.once('close', () => { clearTimeout(idle); if (idleTimers.get(k) === idle) idleTimers.delete(k); });
      });
      return srv;
    }
  });
  if (devicePortWanted()) syncDevicePort();
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
      recordSavings(event.snapshot);
      converterJobs.set(event.snapshot.id, slimJob(event.snapshot));
    });
    // jobs from before a restart (a paused one still owns its clips)
    // (only a list that loaded settles rows: a failed one would end them all)
    // (summaries: counts without every clip of every job ever run)
    const listed = await (runtime.service.listSummaries ? runtime.service.listSummaries() : runtime.service.list()).catch(() => null);
    for (const listedJob of listed || []) {
      // a job still under way is kept whole (its clips: what is in hand)
      const s = CONVERTER_ACTIVE.has(listedJob.state) && !listedJob.items?.length
        ? await runtime.service.get(listedJob.id).catch(() => listedJob) : listedJob;
      // (and the space saved by jobs from before savings were kept)
      recordSavings(s);
      if (!converterJobs.has(s.id)) converterJobs.set(s.id, slimJob(s));
    }
    if (Array.isArray(listed)) {
      converterListed = true;
      settleConversionRows();
    }
  }).catch((err) => log.error(`Converter unavailable: ${err.code || err.message}`));

  // A job that has ended, as kept here: its counts without its clip list (a
  // large job lists tens of thousands of clips; kept for every job, they grew
  // the server past a gigabyte). Running and paused jobs stay whole.
  function slimJob(s) {
    if (!s || CONVERTER_ACTIVE.has(s.state) || !Array.isArray(s.items) || s.items.length === 0) return s;
    const { items: _items, ...rest } = s;
    return { ...rest, items: [], itemCounts: converterCounts(s), progressClips: jobProgress(s).clips };
  }

  // Clip results of a converter job (its counters only hold files and bytes).
  function converterCounts(s) {
    if (s.itemCounts && !s.items?.length) return s.itemCounts;
    const out = { converted: 0, skipped: 0, failed: 0 };
    for (const item of s.items || []) {
      if (item?.kind !== 'video') continue;
      if (item.state === 'completed' && item.eligibleVideo !== false) out.converted++;
      else if (item.state === 'skipped') out.skipped++;
      else if (item.state === 'failed') out.failed++;
    }
    return out;
  }

  /** A converter job's saved space, onto its vehicle's total. */
  function recordSavings(s) {
    const src = s?.config?.sourceRoot || '';
    const v = vehicleForReal(src)?.vehicle || vehicles.vehicleForPath(src);
    if (!v) return;
    try {
      savings.record(s.id, v.id, { bytes: Number(s.counters?.savedBytes) || 0, clips: jobProgress(s).clips });
    } catch (err) {
      log.warn(`Space saved: ${err.message}`);
    }
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
    if (!jobId) jobId = jobs.start({ type: 'conversion', vehicleId: v?.id || null, title: `Convert ${v ? v.name : src} to ${({ h265: 'H.265', av1: 'AV1' })[s.config?.codec] || String(s.config?.codec || '').toUpperCase()}${s.config?.part > 1 ? ` (part ${s.config.part})` : ''}`, externalId });
    const existing = db.jobByExternal(externalId);
    if (terminal && existing?.status === 'running') {
      const measured = stats.energy().byJob?.[s.id] || null;
      // (its baseline stays with the stats engine)
      const energy = measured ? { wh: measured.wh, avgW: measured.avgW, seconds: measured.seconds, cost: measured.cost, ...(measured.nodeWh ? { nodeWh: measured.nodeWh } : {}) } : null;
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
    // (light: unchanged folders keep what they knew; see inventory.scan)
    for (const v of vehicles.list()) if (vehicles.share(v.id)?.isHealthy()) inventory.scan(v.id, { light: true }).then(() => announce('inventory')).catch(() => {});
  }, Number(process.env.SCAN_INTERVAL_MINUTES || 15) * 60 * 1000).unref();
  // renew the HTTPS certificate before it expires (checked daily)
  if (tlsSource) {
    setInterval(async () => {
      try {
        const m = await tlsSource.load();
        httpsServer?.setSecureContext({ key: m.key, cert: m.cert });
        canPort?.server()?.setSecureContext?.({ key: m.key, cert: m.cert });
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
    sentryLink?.close();
    exporter.stop();
    scrubPrepare.stop();
    driveData.stop();
    snapshots.stop();
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
      tlsSource.load().then((x) => { httpsServer.setSecureContext({ key: x.key, cert: x.cert }); canPort?.server()?.setSecureContext?.({ key: x.key, cert: x.cert }); }, (err) => log.warn(`Reloading the certificate failed: ${err.message}`));
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
