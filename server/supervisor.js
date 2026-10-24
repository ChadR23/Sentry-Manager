'use strict';

// Container entrypoint, and the only part of Sentry Six Manager that runs as root.
//
// It runs the app built into the image as an unprivileged user (PUID/PGID,
// default 1000): no capabilities, no_new_privs, no way back to root. Updates
// come as a new image (docker compose pull), never as code written to /data.
//
// What stays root, and why:
//   - mounting SMB shares (mount.cifs needs CAP_SYS_ADMIN). The app asks over
//     the IPC channel; requests are rebuilt from known fields and validated
//     again (mountSpec.js), the mount point is always /footage/<id>, and every
//     mount is nosuid,nodev,noexec.
//   - the HTTPS certificate authority. Its key stays in /data/tls (root only);
//     the app gets the server certificate and key, read-only.
// Nothing is ever loaded from /data, so whoever can write /data cannot change
// what runs, as root or as the app.
//
// Root never writes into a folder the app can write. /data itself is
// root:PGID with the sticky bit (like /tmp): the app creates and owns its
// files there, but cannot rename or replace root's folders (/data/tls with the
// CA key, /data/.supervisor with root's own notes).

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createLocalMounter, serveMountRequests } = require('./mounter');
const { TlsManager, exportForApp, parseHostnames } = require('./tls');

const DATA = path.resolve(process.env.DATA_PATH || '/data');
const IMAGE_ROOT = path.resolve(__dirname, '..');
const FOOTAGE_ROOT = path.resolve(process.env.FOOTAGE_ROOT || '/footage');
const ROOT_RUN = path.resolve(process.env.RUN_DIR || '/run/sentry-six-manager'); // root only: SMB credentials
const ROOT_STATE = path.join(DATA, '.supervisor'); // root only: who owns /data
const APP_TLS = path.resolve(process.env.SENTRY_APP_TLS_DIR || '/run/sentry-app/tls'); // root-owned, readable by the app group
const TLS_MODE = (process.env.TLS_MODE || 'auto').toLowerCase();

const isRoot = process.getuid?.() === 0;
const PUID = Number(process.env.PUID ?? 1000);
const PGID = Number(process.env.PGID ?? 1000);
const separate = isRoot && Number.isInteger(PUID) && PUID > 0 && Number.isInteger(PGID) && PGID > 0;

let child = null;
let stopping = false;
let tls = null;

// Also handed to the app, so mount and certificate problems show in
// the Overview's Logs (lines from before the app started wait for it).
const early = [];
function forward(level, msg) {
  const line = { type: 'supervisor-log', level, message: String(msg).slice(0, 4000) };
  if (child?.connected) child.send(line, () => {});
  else if (early.length < 100) early.push(line);
}
const log = (msg) => { console.log(`[supervisor] ${msg}`); forward('info', msg); };
const warn = (msg) => { console.error(`[supervisor] ${msg}`); forward('warn', msg); };

// CPU power for Overview > Server: the RAPL energy counters are readable by
// root only, so the supervisor reads them (fixed paths, read only) while the
// app asks, and hands the counters over. Docker hides them by default; the
// owner can bind the host's /sys/devices/virtual/powercap read-only to
// /host/powercap (docker-compose.yml shows the line).
const RAPL_ROOTS = ['/host/powercap/intel-rapl', '/host/powercap', '/sys/class/powercap'];
let raplTimer = null;

function readRapl() {
  for (const root of RAPL_ROOTS) {
    let names;
    try {
      names = fs.readdirSync(root).filter((n) => /^intel-rapl:\d+$/.test(n)).sort();
    } catch {
      continue;
    }
    const packages = [];
    for (const n of names) {
      try {
        const read = (f) => fs.readFileSync(path.join(root, n, f), 'utf8').trim();
        const energyUj = Number(read('energy_uj'));
        const maxEnergyUj = Number(read('max_energy_range_uj'));
        if (Number.isFinite(energyUj)) packages.push({ name: read('name') || n, energyUj, maxEnergyUj: Number.isFinite(maxEnergyUj) ? maxEnergyUj : null });
      } catch {
        // a package without counters (or masked) is left out
      }
    }
    if (packages.length) return packages;
  }
  return [];
}

// Each { type: 'rapl', on: true } from the app keeps the readings coming for
// 30 s; without another one they stop by themselves.
let raplUntil = 0;
let raplReadAt = 0;
function rapl(on) {
  raplUntil = on ? Date.now() + 30_000 : 0;
  if (!on) {
    clearInterval(raplTimer);
    raplTimer = null;
    return;
  }
  if (raplTimer) return;
  const send = () => {
    if (!child?.connected || Date.now() > raplUntil) return rapl(false);
    if (Date.now() - raplReadAt < 1900) return; // never more than every 2 s
    raplReadAt = Date.now();
    const packages = readRapl();
    child.send({ type: 'rapl-reading', at: Date.now(), packages }, () => {});
    if (!packages.length) rapl(false); // nothing to read: stop asking the kernel
  };
  raplTimer = setInterval(send, 2000);
  raplTimer.unref?.();
  send();
}

/** Real directory (not a symlink) at exactly this path? */
function isPlainDir(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() && fs.realpathSync(p) === path.resolve(p);
  } catch {
    return false;
  }
}

/** Write a file atomically, never following a link (used in root-only folders). */
function safeWrite(dir, name, data, mode = 0o644) {
  if (!isPlainDir(dir)) throw new Error(`${dir} is not a plain directory`);
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  fs.rmSync(tmp, { force: true });
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try {
    fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path.join(dir, name));
}

/** Read a small file without following a link. */
function readNoFollow(file, max = 64 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) throw new Error('not a small regular file');
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A root-only folder: if what is there is not a plain root-owned 0700
 * directory (someone swapped it), set it aside and start a fresh one.
 */
function ensureRootDir(dir) {
  try {
    const st = fs.lstatSync(dir);
    const ok = st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && fs.realpathSync(dir) === dir;
    if (!ok) {
      const aside = `${dir}.untrusted-${Date.now()}`;
      warn(`${dir} was not a root-owned folder; moved it to ${aside} and starting a fresh one`);
      fs.renameSync(dir, aside);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chownSync(dir, 0, 0);
  fs.chmodSync(dir, 0o700);
}

/** lchown a tree to the app user, never following symlinks or crossing into other mounts. */
function chownTree(dir, skip) {
  const stack = [dir];
  let dev = null;
  try {
    dev = fs.lstatSync(dir).dev;
  } catch {
    return;
  }
  while (stack.length) {
    const cur = stack.pop();
    if (skip.includes(cur)) continue;
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || st.dev !== dev) continue;
    if (st.uid !== PUID || st.gid !== PGID) fs.lchownSync(cur, PUID, PGID);
    if (st.isDirectory()) for (const name of fs.readdirSync(cur)) stack.push(path.join(cur, name));
  }
}

function prepareDirs() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(ROOT_RUN, { recursive: true, mode: 0o700 });
  fs.chmodSync(ROOT_RUN, 0o700);
  fs.mkdirSync(FOOTAGE_ROOT, { recursive: true, mode: 0o755 });
  if (!separate) {
    fs.mkdirSync(ROOT_STATE, { recursive: true, mode: 0o700 });
    return;
  }
  if (!isPlainDir(DATA)) throw new Error(`${DATA} must be a plain directory`);
  // /data: root:PGID, sticky, so the app owns its files but not root's folders
  fs.chownSync(DATA, 0, PGID);
  fs.chmodSync(DATA, 0o1770);
  ensureRootDir(path.join(DATA, 'tls'));
  ensureRootDir(ROOT_STATE);
  const want = `${PUID}:${PGID}`;
  let have = null;
  try {
    have = readNoFollow(path.join(ROOT_STATE, 'owner')).trim();
  } catch {
    // first start, or data from a version that ran as root
  }
  if (have !== want) {
    log(`giving the files in ${DATA} to ${want} (one time)`);
    for (const name of fs.readdirSync(DATA)) {
      const p = path.join(DATA, name);
      if (p === path.join(DATA, 'tls') || p === ROOT_STATE || name.includes('.untrusted-')) continue;
      chownTree(p, []);
    }
    safeWrite(ROOT_STATE, 'owner', `${want}\n`, 0o600);
  }
  // FOOTAGE_ROOT stays root's (mount points are created here); folder vehicles are bind mounts below it
  fs.chownSync(FOOTAGE_ROOT, 0, 0);
  for (const dir of [path.dirname(APP_TLS), APP_TLS]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    if (!isPlainDir(dir)) throw new Error(`${dir} must be a plain directory`);
    fs.chownSync(dir, 0, PGID);
    fs.chmodSync(dir, 0o750);
  }
}

/** Write the app's copy of the TLS files: root-owned, group-readable (0640 for the key). */
async function exportTls() {
  if (!tls) return;
  if (!separate) return; // the app manages TLS itself
  await exportForApp(tls, APP_TLS);
  for (const name of fs.readdirSync(APP_TLS)) {
    const f = path.join(APP_TLS, name);
    fs.lchownSync(f, 0, PGID);
    fs.chmodSync(f, name.endsWith('.key') ? 0o640 : 0o644);
  }
}

/** Group ids that own the GPU device nodes, so the app can use VA-API / NVENC. */
function deviceGroups() {
  const gids = new Set();
  for (const dir of ['/dev/dri', '/dev']) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (dir === '/dev' && !/^nvidia/.test(n)) continue;
      try {
        const st = fs.statSync(path.join(dir, n));
        const groupRw = (st.mode & 0o060) === 0o060;
        const otherRw = (st.mode & 0o006) === 0o006;
        if (st.isCharacterDevice() && st.gid !== 0 && groupRw && !otherRw) gids.add(st.gid);
      } catch {
        // gone
      }
    }
  }
  gids.delete(PGID);
  return [...gids];
}

function hasSetpriv() {
  return spawnSync('setpriv', ['--version'], { stdio: 'ignore' }).status === 0;
}

function canDropBoundingSet() {
  // dropping the bounding set needs CAP_SETPCAP (bit 8) in our effective set
  try {
    const eff = fs.readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\s*([0-9a-f]+)/m)?.[1];
    return eff ? (BigInt(`0x${eff}`) & (1n << 8n)) !== 0n : false;
  } catch {
    return false;
  }
}

function launch() {
  log(`starting the app${separate ? ` as ${PUID}:${PGID}` : ''}`);
  const nodeArgs = ['--disable-warning=ExperimentalWarning', path.join(IMAGE_ROOT, 'server/index.js')];
  const env = { ...process.env, APP_ROOT: IMAGE_ROOT };
  delete env.UI_PASSWORD_FILE;
  let cmd = process.execPath;
  let args = nodeArgs;
  const opts = { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env, cwd: '/' };
  for (const k of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT']) delete env[k];
  if (separate) {
    env.SENTRY_SUPERVISED = '1';
    env.HOME = DATA;
    if (tls) env.SENTRY_TLS_DIR = APP_TLS;
    // the app never needs these, and the CA key is not its business
    delete env.TLS_KEY_FILE;
    delete env.TLS_CERT_FILE;
    if (hasSetpriv()) {
      const groups = deviceGroups();
      cmd = 'setpriv';
      args = [
        `--reuid=${PUID}`, `--regid=${PGID}`,
        groups.length ? `--groups=${groups.join(',')}` : '--clear-groups',
        '--inh-caps=-all', '--ambient-caps=-all',
        ...(canDropBoundingSet() ? ['--bounding-set=-all'] : []),
        '--no-new-privs', '--', process.execPath, ...nodeArgs
      ];
    } else {
      warn('setpriv is missing; dropping privileges with plain setuid (no supplementary groups, no no_new_privs).');
      opts.uid = PUID;
      opts.gid = PGID;
    }
  } else if (isRoot) {
    warn('PUID is 0: the app runs as root. Set PUID/PGID to a normal user id so a bug in the web app cannot become root.');
  }
  child = spawn(cmd, args, opts);
  for (const line of early.splice(0)) child.send(line, () => {});
  if (isRoot) {
    serveMountRequests(child, createLocalMounter({ footageRoot: FOOTAGE_ROOT, credDir: ROOT_RUN, uid: separate ? PUID : 0, gid: separate ? PGID : 0 }),
      { log: (m) => log(String(m).replace(/^\[supervisor\]\s*/, '')), error: (m) => warn(String(m).replace(/^\[supervisor\]\s*/, '')) });
    child.on('message', (msg) => {
      // the app can only ask for readings (they stop by themselves)
      if (msg?.type === 'rapl') {
        if (msg.on === true) rapl(true);
        return;
      }
      if (!msg || msg.type !== 'tls-hostnames' || typeof msg.requestId !== 'string' || !tls) return;
      (async () => {
        const names = parseHostnames((Array.isArray(msg.hostnames) ? msg.hostnames : []).slice(0, 20).map(String).join(','));
        const out = await tls.setHostnames(names);
        await exportTls();
        return { caReplaced: out.caReplaced };
      })().then(
        (r) => child?.connected && child.send({ type: 'tls-result', requestId: msg.requestId, ...r }),
        (err) => child?.connected && child.send({ type: 'tls-result', requestId: msg.requestId, error: err.message })
      );
    });
  }
  child.on('exit', (code, signal) => {
    child = null;
    rapl(false);
    if (stopping) process.exit(code ?? 0);
    warn(`server exited (${code ?? signal}); restarting in 5 s`);
    setTimeout(launch, 5000);
  });
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    if (!child) process.exit(0);
    try {
      child.kill(sig);
    } catch {
      // no CAP_KILL for a different uid: ask over IPC instead
      if (child.connected) child.send({ type: 'shutdown' });
    }
  });
}

(async () => {
  try {
    prepareDirs();
  } catch (err) {
    warn(`could not prepare folders: ${err.message}`);
  }
  if (TLS_MODE !== 'off' && separate) {
    try {
      tls = new TlsManager({
        dir: path.join(DATA, 'tls'), log: { info: log, warn },
        hostnames: parseHostnames(process.env.TLS_HOSTNAMES || ''),
        certFile: process.env.TLS_CERT_FILE || null, keyFile: process.env.TLS_KEY_FILE || null
      });
      await exportTls();
      setInterval(() => {
        exportTls().then(() => child?.connected && child.send({ type: 'tls-updated' }), (err) => warn(`certificate renewal failed: ${err.message}`));
      }, 24 * 3600 * 1000).unref();
    } catch (err) {
      warn(`HTTPS setup failed: ${err.message}`);
      tls = null;
    }
  }
  launch();
})();
