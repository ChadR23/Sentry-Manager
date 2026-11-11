#!/usr/bin/env node
'use strict';

// A stand-in Sentry USB (the Pi in the car) for the demo and for trying
// features without a car. It connects to Manager's device port over the real
// link protocol (test/fixtures/fakeSentryUsb.js: v2, pairing code, key mode)
// and keeps its state in a folder, so what Manager changes survives restarts:
//
//   <state>/sentryusb.conf   the setup config, in the Pi's own format
//   <state>/state.json       link key, version, boot, snapshots, backups, ...
//   <state>/logs/<name>.log  the logs /api/logs/<name> serves
//
// Settings are checked with the Pi's rules (sentry-usb crates/manager_link
// src/secrets.rs): only the settable keys change over the link, typed values
// are validated, secrets are masked on read and kept when sent empty, and a
// secret is not kept when where it goes changed. Every saved change is
// logged ("Setup config: ARCHIVE_DELAY changed 20 → 30 (from Sentry
// Manager)"; secrets only as "changed").
//
// Actions take effect: reboot drops the link and comes back 20-30 s later,
// shut down stays away until this tool is restarted, sync archives for about
// 30 s (status "archiving", the share's .sentryusb/archive-status.json when
// --share is given), setup re-runs its phases, an update installs and comes
// back on the new version. Status is pushed every 30 s (a Raspberry Pi 5).
//
// Usage (development and demos only: it trusts any certificate on its first
// connection, then pins it, as the real Pi does):
//   node tools/demo-sentry-usb.js --state DIR --manager 127.0.0.1:10000 --code K7QP-M2XD-9WRT
//   node tools/demo-sentry-usb.js --state DIR --manager 127.0.0.1:10000 \
//     --auto-pair https://127.0.0.1:9000 --admin admin --admin-password '...' --name 'Demo Model Y'
// Options: --user/--password (the Pi's web login, used to pair; default the
// config's WEB_USERNAME/WEB_PASSWORD), --share DIR (the share root holding
// RecentClips), --impostor-once (one fingerprint alert: the security log
// shows a possible hijack attempt), --id HEX.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { connectFakePi } = require('../test/fixtures/fakeSentryUsb');
const { isSecretKey } = require('../server/sentryUsbLink');

const MIB = 1024 * 1024;
const OFFICIAL_UPDATE_REPO = 'Sentry-Six/Sentry-USB-Rusty';
const BOARD = 'Raspberry Pi 5 Model B Rev 1.0';
const MAX_LOG = 512 * 1024;

// ---- the Pi's write rules (crates/manager_link/src/secrets.rs)
const SETTABLE = new Set([
  'SSID', 'WIFIPASS', 'AP_SSID', 'AP_PASS', 'AP_IP', 'SENTRYUSB_HOSTNAME', 'TIME_ZONE',
  'SHARE_PASSWORD', 'CIFS_NOSERVERINO', 'ARCHIVE_DELAY', 'ARCHIVE_STALL_GRACE_SECONDS',
  'ARCHIVE_RECENTCLIPS', 'ARCHIVE_SAVEDCLIPS', 'ARCHIVE_SENTRYCLIPS', 'ARCHIVE_TRACKMODECLIPS', 'ARCHIVE_VERIFY', 'ARCHIVE_VERIFY_MODE',
  'ARCHIVE_VERIFY_MAX_SECONDS', 'ARCHIVE_VERIFY_RECHECK_SECONDS', 'ARCHIVE_VERIFY_PARALLEL', 'ARCHIVE_VERIFY_MANAGER_WAIT_HOURS', 'ARCHIVE_AUTO_DELETE_VERIFIED', 'SNAPSHOT_INTERVAL',
  'TRIGGER_FILE_SAVED', 'TRIGGER_FILE_SENTRY', 'TRIGGER_FILE_RECENT', 'TRIGGER_FILE_ANY', 'SENTRY_CASE', 'DRIVE_MAP_ENABLED', 'DRIVE_MAP_UNIT', 'DRIVE_MAP_WHILE_AWAY',
  'NOTIFICATION_TITLE', 'PUSHOVER_ENABLED', 'PUSHOVER_USER_KEY', 'PUSHOVER_APP_KEY', 'GOTIFY_ENABLED', 'GOTIFY_DOMAIN', 'GOTIFY_APP_TOKEN', 'GOTIFY_PRIORITY',
  'DISCORD_ENABLED', 'DISCORD_WEBHOOK_URL', 'TELEGRAM_ENABLED', 'TELEGRAM_CHAT_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_SILENT_NOTIFY', 'IFTTT_ENABLED', 'IFTTT_EVENT_NAME',
  'IFTTT_KEY', 'SLACK_ENABLED', 'SLACK_WEBHOOK_URL', 'SIGNAL_ENABLED', 'SIGNAL_URL', 'SIGNAL_FROM_NUM', 'SIGNAL_TO_NUM', 'MATRIX_ENABLED', 'MATRIX_SERVER_URL',
  'MATRIX_USERNAME', 'MATRIX_PASSWORD', 'MATRIX_ROOM', 'SNS_ENABLED', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SNS_TOPIC_ARN', 'WEBHOOK_ENABLED',
  'WEBHOOK_URL', 'NTFY_ENABLED', 'NTFY_URL', 'NTFY_TOKEN', 'NTFY_PRIORITY', 'MOBILE_PUSH_ENABLED', 'KEEP_AWAKE_WEBHOOK_URL', 'TESLAFI_API_TOKEN', 'TESSIE_API_TOKEN',
  'TESSIE_VIN', 'TESLA_BLE_VIN', 'TEMPERATURE_WARNING', 'TEMPERATURE_CAUTION', 'TEMPERATURE_INTERVAL', 'TEMPERATURE_POSTARCHIVE', 'TEMPERATURE_UNIT', 'SYSTEM_TEMPERATURE_UNIT', 'PRESSURE_UNIT'
]);
const ARGUMENT_KEYS = new Set(['SSID', 'AP_SSID', 'AP_IP', 'SENTRYUSB_HOSTNAME', 'TIME_ZONE', 'ARCHIVE_SERVER', 'SHARE_NAME', 'SHARE_USER', 'SHARE_DOMAIN', 'CIFS_VERSION', 'CIFS_SEC', 'RSYNC_USER', 'RSYNC_SERVER', 'RSYNC_PATH', 'RSYNC_SSH_PORT', 'RCLONE_DRIVE', 'RCLONE_PATH', 'MUSIC_SHARE_NAME', 'TESSIE_VIN', 'TESLA_BLE_VIN']);
const MOUNT_OPTION_KEYS = new Set(['SHARE_USER', 'SHARE_DOMAIN', 'CIFS_VERSION', 'CIFS_SEC']);
const NUMBER_KEYS = new Set(['ARCHIVE_DELAY', 'ARCHIVE_STALL_GRACE_SECONDS', 'ARCHIVE_VERIFY_MAX_SECONDS', 'ARCHIVE_VERIFY_RECHECK_SECONDS', 'ARCHIVE_VERIFY_PARALLEL', 'ARCHIVE_VERIFY_MANAGER_WAIT_HOURS', 'SNAPSHOT_INTERVAL', 'GOTIFY_PRIORITY', 'NTFY_PRIORITY', 'TEMPERATURE_WARNING', 'TEMPERATURE_CAUTION', 'TEMPERATURE_INTERVAL', 'SENTRY_CASE', 'RSYNC_SSH_PORT']);
const BOOL_VALUES = new Set(['true', 'false', 'yes', 'no', '1', '0', 'on', 'off']);
const BOOL_KEYS = new Set(['ARCHIVE_RECENTCLIPS', 'ARCHIVE_SAVEDCLIPS', 'ARCHIVE_SENTRYCLIPS', 'ARCHIVE_TRACKMODECLIPS', 'ARCHIVE_VERIFY', 'ARCHIVE_AUTO_DELETE_VERIFIED', 'CIFS_NOSERVERINO', 'DRIVE_MAP_WHILE_AWAY', 'TELEGRAM_SILENT_NOTIFY', 'TEMPERATURE_POSTARCHIVE']);
const TOKEN_KEYS = new Set(['ARCHIVE_VERIFY_MODE', 'DRIVE_MAP_UNIT', 'TEMPERATURE_UNIT', 'SYSTEM_TEMPERATURE_UNIT', 'PRESSURE_UNIT', 'AWS_REGION', 'TESSIE_VIN', 'TESLA_BLE_VIN', 'IFTTT_EVENT_NAME']);
const URL_KEYS = new Set(['GOTIFY_DOMAIN', 'MATRIX_SERVER_URL', 'SIGNAL_URL', 'DISCORD_WEBHOOK_URL', 'SLACK_WEBHOOK_URL', 'WEBHOOK_URL', 'NTFY_URL', 'KEEP_AWAKE_WEBHOOK_URL']);
const SECRET_TARGETS = [
  ['SHARE_PASSWORD', ['ARCHIVE_SYSTEM', 'ARCHIVE_SERVER', 'SHARE_USER', 'SHARE_DOMAIN']], ['WIFIPASS', ['SSID']], ['MATRIX_PASSWORD', ['MATRIX_SERVER_URL', 'MATRIX_USERNAME']],
  ['GOTIFY_APP_TOKEN', ['GOTIFY_DOMAIN']], ['NTFY_TOKEN', ['NTFY_URL']], ['AWS_SECRET_ACCESS_KEY', ['AWS_REGION', 'AWS_ACCESS_KEY_ID']]
];
const isValidKey = (k) => /^[A-Z_][A-Z0-9_]*$/.test(k) && k.length <= 64;
const isBoolKey = (k) => k.endsWith('_ENABLED') || BOOL_KEYS.has(k);
// (Rust's char::is_control: C0, DEL and C1)
const hasControl = (v) => /[\u0000-\u001f\u007f-\u009f]/.test(v);
const only = (v, re) => [...v].every((c) => re.test(c));

function checkUrl(key, value) {
  if (value === '') return null;
  const bad = `${key} must be an http:// or https:// address of another machine`;
  const rest = value.startsWith('https://') ? value.slice(8) : value.startsWith('http://') ? value.slice(7) : null;
  if (rest === null || /[\s"'`\\<>$]/.test(value)) return bad;
  const authority = rest.split(/[/?#]/)[0];
  if (authority.includes('@')) return bad;
  let host = authority.startsWith('[') ? authority.slice(1).split(']')[0] : authority.includes(':') ? authority.slice(0, authority.lastIndexOf(':')) : authority;
  host = host.replace(/\.+$/, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return bad;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 && v4.slice(1).every((n) => Number(n) <= 255)) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0 || (a === 169 && b === 254)) return bad;
  } else if (host.includes(':')) {
    if (host === '::1' || host === '::' || /^fe[89ab]/.test(host) || /^::ffff:(127|0|169\.254)\./.test(host)) return bad;
  } else if (/^[0-9.]+$/.test(host) || host.startsWith('0x')) return bad;
  return null;
}

/** validate_value: null when fine, else the Pi's message. */
function validateValue(key, value) {
  if (Buffer.byteLength(value) > 1024) return `${key} is too long`;
  if (hasControl(value)) return `${key} must be a single line of text`;
  if (ARGUMENT_KEYS.has(key) && value.trimStart().startsWith('-')) return `${key} must not start with '-'`;
  if (MOUNT_OPTION_KEYS.has(key) && /[,=]/.test(value)) return `${key} must not contain ',' or '='`;
  if (NUMBER_KEYS.has(key)) return value !== '' && (value.length > 12 || !/^[0-9]+$/.test(value)) ? `${key} must be a whole number` : null;
  if (isBoolKey(key)) return value !== '' && !BOOL_VALUES.has(value.toLowerCase()) ? `${key} must be true or false` : null;
  if (TOKEN_KEYS.has(key)) return !/^[A-Za-z0-9._-]*$/.test(value) || value.startsWith('-') ? `${key} must be letters, digits, '.', '_' or '-'` : null;
  if (key.startsWith('TRIGGER_FILE_')) return value === '.' || value === '..' || !/^[A-Za-z0-9._-]*$/.test(value) ? `${key} must be a plain file name` : null;
  if (URL_KEYS.has(key)) return checkUrl(key, value);
  if (key === 'AP_IP' && value !== '' && !/^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(value)) return `${key} must be an IPv4 address`;
  if (key === 'TELEGRAM_CHAT_ID' && value !== '' && !(/^-?[0-9]*$/.test(value) || /^@[A-Za-z0-9_]*$/.test(value))) return `${key} must be a chat id or @channel`;
  if (key === 'SENTRYUSB_HOSTNAME' && (value === '' || value.length > 63 || !/^[A-Za-z0-9-]+$/.test(value))) return `${key} must be letters, digits and '-'`;
  if (key === 'TIME_ZONE' && (value.includes('..') || !only(value, /[A-Za-z0-9/_+-]/))) return `${key} must be a time zone name like Europe/Berlin`;
  return null;
}

/**
 * prepare_setup_config_write: the new active settings, or { error } as the Pi
 * answers it (400). `active` is the stored active map.
 */
function prepareSetupConfigWrite(body, active) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Expected a JSON object of settings' };
  const keys = Object.keys(body).sort(); // serde_json's map is ordered by key
  if (keys.length > 512) return { error: 'Too many settings' };
  const has = (k) => Object.prototype.hasOwnProperty.call(active, k);
  const out = {};
  for (const [k, v] of Object.entries(active)) if (!SETTABLE.has(k)) out[k] = v;
  for (const key of keys) {
    const value = body[key];
    if (key.endsWith('__set') && isValidKey(key.slice(0, -5))) continue;
    if (!isValidKey(key)) return { error: `Invalid setting name ${JSON.stringify(key)}` };
    if (typeof value !== 'string') return { error: `${key} must be a string` };
    const secret = isSecretKey(key);
    if (!SETTABLE.has(key)) {
      if ((has(key) && active[key] === value) || (secret && value === '')) continue;
      return { error: `${key} can only be changed on the Sentry USB itself` };
    }
    if (secret && value === '') { if (has(key)) out[key] = active[key]; continue; }
    const bad = validateValue(key, value);
    if (bad) return { error: bad };
    out[key] = value;
  }
  for (const [k, v] of Object.entries(active)) if (isSecretKey(k) && !(k in body) && !(k in out)) out[k] = v;
  for (const [k, v] of Object.entries(active)) {
    const sentNew = typeof body[k] === 'string' && body[k] !== '';
    if (!isSecretKey(k) || v === '' || sentNew || !(k in out)) continue;
    const targets = SECRET_TARGETS.find(([s]) => s === k)?.[1] || [];
    for (const t of targets) if ((out[t] ?? '') !== (active[t] ?? '')) return { error: `${t} changed: enter ${k} again to send it there` };
  }
  return { config: out };
}

const releaseNumber = (v) => {
  const core = String(v).trim().replace(/^v+/, '').split(/[-+]/)[0];
  const p = core.split('.');
  if (p.length > 3 || !p.every((x) => /^[0-9]+$/.test(x))) return null;
  return [Number(p[0]), Number(p[1] ?? 0), Number(p[2] ?? 0)];
};
const older = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const testNumber = (v) => Number(/-test\.(\d+)$/.exec(v)?.[1] ?? 0);
const nextTestVersion = (v) => (/-test\.\d+$/.test(v) ? v.replace(/-test\.(\d+)$/, (_, n) => `-test.${Number(n) + 1}`) : `${v}-test.1`);

// ---- sentryusb.conf: `export KEY=value` lines; `#export` lines are kept but not in use
const CONF_TEMPLATE = `# SentryUSB configuration (written by the setup wizard)
# Remove the "#" before "export" to activate a line.

############ Network ############
export SSID=HomeNet-5G
export WIFIPASS='correct-battery-staple'
export AP_SSID=SentryUSB-ModelY
export AP_PASS='car-hotspot-99'
#export AP_IP='192.168.66.1'
export SENTRYUSB_HOSTNAME=sentryusb-modely
export TIME_ZONE=America/Chicago

############ Archive ############
export ARCHIVE_SYSTEM=cifs
export ARCHIVE_SERVER=nas.home.arpa
export SHARE_NAME=TeslaCam
export SHARE_USER=sentry
export SHARE_PASSWORD='smb-pass-2026'
export CIFS_VERSION=3.0
#export SHARE_DOMAIN=WORKGROUP
#export ARCHIVE_SYSTEM=rsync
#export RSYNC_USER=username
#export RSYNC_SERVER=hostname_or_ip
#export RSYNC_PATH=path_on_server
export ARCHIVE_RECENTCLIPS=true
export ARCHIVE_SAVEDCLIPS=true
export ARCHIVE_SENTRYCLIPS=true
#export ARCHIVE_TRACKMODECLIPS=false
export ARCHIVE_VERIFY=true
export ARCHIVE_VERIFY_MODE=basic
export ARCHIVE_AUTO_DELETE_VERIFIED=true
#export ARCHIVE_VERIFY_MAX_SECONDS=1800
#export ARCHIVE_VERIFY_PARALLEL=32
export ARCHIVE_VERIFY_MANAGER_WAIT_HOURS=24
export ARCHIVE_DELAY=20
#export ARCHIVE_STALL_GRACE_SECONDS=60
export SNAPSHOT_INTERVAL=3480
export DRIVE_MAP_ENABLED=true
export DRIVE_MAP_UNIT=mi

############ Drives ############
export CAM_SIZE=40G
export MUSIC_SIZE=4G
export LIGHTSHOW_SIZE=1G
#export BOOMBOX_SIZE=100M
export USE_EXFAT=true
#export SAMBA_ENABLED=true

############ Web and updates ############
export WEB_USERNAME=pi
export WEB_PASSWORD=raspberry
export REPO=${OFFICIAL_UPDATE_REPO}
#export BRANCH=main

############ Notifications ############
export NOTIFICATION_TITLE='Model Y'
export NTFY_ENABLED=true
export NTFY_URL=https://ntfy.sh/modely-sentry-8f2c
export NTFY_TOKEN=tk_7x2m9qv4hd3k1p
export NTFY_PRIORITY=3
export MOBILE_PUSH_ENABLED=true
#export PUSHOVER_ENABLED=true
#export PUSHOVER_USER_KEY=user_key
#export PUSHOVER_APP_KEY=app_key
#export DISCORD_ENABLED=true
#export DISCORD_WEBHOOK_URL=put_your_webhook_url_here
#export TELEGRAM_ENABLED=true
#export TELEGRAM_CHAT_ID=123456789
#export TELEGRAM_BOT_TOKEN=put_your_bot_token_here

############ Car and temperatures ############
export TESLA_BLE_VIN=7SAYGDEE5PA000001
export TEMPERATURE_POSTARCHIVE=true
export TEMPERATURE_WARNING=70
export TEMPERATURE_CAUTION=60
export TEMPERATURE_UNIT=F
export PRESSURE_UNIT=psi
`;

function unquote(s) {
  s = s.trim();
  if (s.length >= 2 && ((s[0] === "'" && s.at(-1) === "'") || (s[0] === '"' && s.at(-1) === '"'))) return s.slice(1, -1).replace(/'\\''/g, "'");
  if (s.startsWith("$'") && s.endsWith("'") && s.length >= 3) return s.slice(2, -1);
  for (let i = 1; i < s.length; i++) if (s[i] === '#' && (s[i - 1] === ' ' || s[i - 1] === '\t')) return s.slice(0, i - 1).trim();
  return s;
}
function quote(s) {
  if (s === '') return "''";
  if (![...s].some((c) => " \t\n\r'\"\\$!#&|;(){}[]<>?*~`".includes(c))) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
const exportLine = (line) => { const m = /^\s*export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line); return m ? [m[1], unquote(m[2])] : null; };
const commentedLine = (line) => { const m = /^\s*#\s*export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line); return m ? [m[1], unquote(m[2])] : null; };
function parseConf(text) {
  const active = {};
  const commented = {};
  for (const line of text.split('\n')) {
    let kv = exportLine(line);
    if (kv) { active[kv[0]] = kv[1]; continue; }
    kv = commentedLine(line);
    if (kv) commented[kv[0]] = kv[1];
  }
  return { active, commented };
}
/** write_file: lines for keys not in `config` are commented out, new keys appended. */
function writeConf(text, config) {
  const seen = new Set();
  const out = [];
  for (const line of text.replace(/\n$/, '').split('\n')) {
    const a = exportLine(line);
    const c = a ? null : commentedLine(line);
    const kv = a || c;
    if (!kv) { out.push(line); continue; }
    seen.add(kv[0]);
    if (kv[0] in config) out.push(`export ${kv[0]}=${quote(config[kv[0]])}`);
    else out.push(a ? `#${line}` : line);
  }
  for (const [k, v] of Object.entries(config)) if (!seen.has(k)) out.push(`export ${k}=${quote(v)}`);
  return `${out.join('\n')}\n`;
}

// ---- time stamps as the Pi's logs write them (UTC)
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');
const hms = (d) => `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
const dateStamp = (ms) => { const d = new Date(ms); return `${DAY[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${hms(d)} UTC ${d.getUTCFullYear()}`; };
const sysStamp = (ms) => { const d = new Date(ms); return `${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${hms(d)}`; };
const isoStamp = (ms) => `${new Date(ms).toISOString().slice(0, 23)}Z`;
const clipKey = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
const LOG_NAMES = ['archiveloop', 'manager-link', 'setup', 'diagnostics', 'syslog', 'kern', 'auth', 'daemon', 'sentryusb', 'sentryusb-ble'];
const SETUP_PHASES = [
  ['verify', 'Verifying configuration'], ['required_packages', 'Installing required packages'], ['system_basics', 'System configuration'],
  ['wifi_regdom', 'WiFi regulatory domain'], ['dwc2_overlay', 'USB gadget overlay'], ['cmdline_modules', 'Boot configuration'], ['uas_quirks', 'USB drive compatibility'],
  ['partitions', 'Disk partitioning'], ['mount_partitions', 'Mounting partitions'], ['automount', 'Snapshot automount'], ['archive', 'Archive configuration'],
  ['runtime_scripts', 'Installing runtime scripts'], ['web_mount', 'TeslaCam mount'], ['wifi_ap', 'WiFi access point'], ['avahi', 'mDNS service'], ['ssh', 'SSH hardening'],
  ['tesla_ble', 'Tesla BLE peripheral'], ['rtc', 'Real-time clock'], ['readonly', 'Read-only filesystem']
];

/**
 * The Pi's state and its answers. Options: dir (state folder), share (share
 * root, optional), timing overrides (rebootMs [min, max], syncMs, setupStepMs,
 * updateStepMs), now, random. Events through `on(fn)`: { t: 'drop', backInMs }
 * (null: shut down), { t: 'status' } (something the status shows changed).
 */
function createDemoSentryUsb(o = {}) {
  const dir = o.dir;
  if (!dir) throw new Error('a state folder is needed');
  const now = o.now || Date.now;
  const rand = o.random || Math.random;
  const T = { rebootMs: o.rebootMs || [20_000, 30_000], syncMs: o.syncMs ?? 30_000, setupStepMs: o.setupStepMs ?? 600, updateStepMs: o.updateStepMs ?? 1500 };
  const share = o.share || null;
  const listeners = new Set();
  const emit = (e) => { for (const f of listeners) { try { f(e); } catch { /* a listener's problem */ } } };
  const timers = new Set();
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const confFile = path.join(dir, 'sentryusb.conf');
  const stateFile = path.join(dir, 'state.json');
  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const fresh = !fs.existsSync(stateFile);
  if (!fs.existsSync(confFile)) fs.writeFileSync(confFile, CONF_TEMPLATE, { mode: 0o600 });
  const unix = () => Math.floor(now() / 1000);
  const writeJson = (file, v) => { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v, null, 1), { mode: 0o600 }); fs.renameSync(tmp, file); };

  let st = fresh ? null : JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (!st) {
    const t = unix();
    st = {
      id: o.id || crypto.randomBytes(16).toString('hex'), key: null, fp: null, version: 'v3.29.0-test.3', bootId: crypto.randomUUID(), bootAt: now() - 3 * 86400_000 - 4 * 3600_000,
      drives: true, snapSeq: 0, snapshots: [], backups: [
        { date: dayOf(t - 8 * 86400), timestamp: new Date((t - 8 * 86400) * 1000).toISOString().replace(/\.\d+Z$/, 'Z'), location: 'archive', size: 18_044, filename: `sentryusb-backup-${dayOf(t - 8 * 86400)}.json` },
        { date: dayOf(t - 15 * 86400), timestamp: new Date((t - 15 * 86400) * 1000).toISOString().replace(/\.\d+Z$/, 'Z'), location: 'archive', size: 17_902, filename: `sentryusb-backup-${dayOf(t - 15 * 86400)}.json` }
      ],
      backupHash: null, diagnosticsAt: null, freeBytes: 61_294_219_264, clipsArchived: 4_812, lastArchive: { at: t - 5400, clips: 48 }, updateCache: null
    };
    seedSnapshots(t);
  }
  function dayOf(u) { return new Date(u * 1000).toISOString().slice(0, 10); }
  function seedSnapshots(t) {
    // the newest snapshots the share's status file lists, when there is one; else six of its own
    let names = [];
    try { names = (JSON.parse(fs.readFileSync(path.join(share, '.sentryusb', 'archive-status.json'), 'utf8')).snapshots || []).slice(-6).map((s) => [s.name, s.started_unix]); } catch { /* none */ }
    if (!names.length) names = [6, 5, 4, 3, 2, 1].map((h, i) => [`snap-${String(41 + i).padStart(6, '0')}`, t - h * 3480]);
    st.snapshots = names.map(([id, created], i) => ({
      id, cumulative_reclaim_bytes: (i + 1) * 812_000_000, older_count: i, created_unix: created,
      archive: { state: i < names.length - 1 ? 'verified' : 'pending', clips: 96 + ((i * 37) % 41), verified: i < names.length - 1 ? 96 + ((i * 37) % 41) : 0, verified_twice: i < names.length - 2 ? 96 + ((i * 37) % 41) : 0, converted: i < 2 ? 12 : 0, quick: 0, basic: i < names.length - 1 ? 96 + ((i * 37) % 41) : 0 }
    }));
    st.snapSeq = Math.max(0, ...st.snapshots.map((s) => Number(/(\d+)$/.exec(s.id)?.[1] || 0)));
  }
  const save = () => writeJson(stateFile, st);
  const readConf = () => parseConf(fs.readFileSync(confFile, 'utf8'));

  // ---- logs
  const logFile = (name) => path.join(logDir, `${name}.log`);
  function log(name, text, { proc = 'sentryusb', level = 'INFO', target = 'sentryusb' } = {}) {
    const host = readConf().active.SENTRYUSB_HOSTNAME || 'sentryusb';
    const t = now();
    const line = name === 'archiveloop' || name === 'setup' ? `${dateStamp(t)}: ${text}`
      : name === 'manager-link' || name === 'sentryusb' || name === 'sentryusb-ble' ? `${isoStamp(t)}  ${level.padStart(5)} ${target}: ${text}`
        : `${sysStamp(t)} ${host} ${proc}: ${text}`;
    const file = logFile(name);
    fs.appendFileSync(file, `${line}\n`);
    try { if (fs.statSync(file).size > MAX_LOG) { const all = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, all.slice(all.indexOf('\n', all.length - MAX_LOG / 2) + 1)); st.logEpoch = (st.logEpoch || 0) + 1; } } catch { /* gone */ }
  }
  const sys = (text, proc = 'sentryusb[812]') => log('syslog', text, { proc });
  function logBoot() {
    const cfg = readConf().active;
    log('kern', `Booting Linux on physical CPU 0x0000000000 [0x414fd0b1]`, { proc: 'kernel:' });
    log('kern', `Linux version 6.12.25+rpt-rpi-2712 (serge@raspberrypi.com) (aarch64-linux-gnu-gcc-12) #1 SMP PREEMPT Debian 1:6.12.25-1+rpt1`, { proc: 'kernel:' });
    log('kern', `Machine model: ${BOARD}`, { proc: 'kernel:' });
    log('kern', 'dwc2 1000480000.usb: DWC OTG Controller', { proc: 'kernel:' });
    sys(`Linux version 6.12.25+rpt-rpi-2712 booted, boot id ${st.bootId}`, 'kernel:');
    sys(`Reached target multi-user.target - Multi-User System.`, 'systemd[1]:');
    log('daemon', `Started sentryusb.service - Sentry USB ${st.version}.`, { proc: 'systemd[1]:' });
    log('daemon', `wlan0: connected to ${cfg.SSID || 'HomeNet-5G'}, 5180 MHz`, { proc: 'wpa_supplicant[611]:' });
    log('auth', 'Server listening on 0.0.0.0 port 22.', { proc: 'sshd[702]:' });
    log('sentryusb', `Sentry USB ${st.version} starting on ${BOARD} (boot ${st.bootId})`, { target: 'sentryusb' });
    log('sentryusb', `USB drives ${st.drives ? 'presented to the car' : 'off'} (cam ${cfg.CAM_SIZE || '?'}, music ${cfg.MUSIC_SIZE || '?'})`, { target: 'sentryusb_drives' });
    log('sentryusb-ble', `BLE peripheral ready for VIN ${cfg.TESLA_BLE_VIN || 'unknown'}`, { target: 'sentryusb_ble' });
    log('archiveloop', `Starting archiveloop (archive server ${cfg.ARCHIVE_SERVER || '?'}, every ${cfg.SNAPSHOT_INTERVAL || 3480} s)`);
    log('manager-link', 'Connecting to Sentry Manager', { target: 'manager_link' });
    sys(`Sentry USB ${st.version} started`);
  }
  if (fresh) {
    // a few days of history
    const t0 = now();
    const cfg = readConf().active;
    const old = (name, agoS, text, opts) => {
      const t = t0 - agoS * 1000;
      const host = cfg.SENTRYUSB_HOSTNAME;
      const line = name === 'archiveloop' || name === 'setup' ? `${dateStamp(t)}: ${text}` : name === 'manager-link' || name === 'sentryusb' || name === 'sentryusb-ble' ? `${isoStamp(t)}   INFO ${opts?.target || 'sentryusb'}: ${text}` : `${sysStamp(t)} ${host} ${opts?.proc || 'sentryusb[812]'}: ${text}`;
      fs.appendFileSync(logFile(name), `${line}\n`);
    };
    const setupAgo = 9 * 86400;
    old('setup', setupAgo, 'Setup started');
    SETUP_PHASES.forEach(([id, label], i) => old('setup', setupAgo - i * 40, `phase: ${label} (${id})`));
    old('setup', setupAgo - 900, 'Setup finished, rebooting');
    for (let k = 72; k >= 2; k -= 6) {
      const s = k * 3600;
      const n = 20 + ((k * 13) % 37);
      old('archiveloop', s, `Archive server ${cfg.ARCHIVE_SERVER} reachable`);
      old('archiveloop', s - 20, `Taking snapshot, then archiving ${n} clips to ${cfg.ARCHIVE_SERVER}`);
      old('archiveloop', s - 380, `Archived ${n} clips, verified ${n} (basic)`);
      old('syslog', s - 381, `archive: ${n} clips archived to //${cfg.ARCHIVE_SERVER}/${cfg.SHARE_NAME}`);
    }
    old('auth', 86400 * 2, 'Accepted publickey for pi from 192.168.1.20 port 51522 ssh2: ED25519 SHA256:q2Tx…', { proc: 'sshd[4122]:' });
    old('manager-link', 3600, 'Sentry Manager link up');
    old('sentryusb-ble', 7200, 'Car woke up; BLE keep-awake sent', { target: 'sentryusb_ble' });
    logBoot();
    save();
  }

  // ---- status, with values that wander as a real one does
  const sense = st.sense || (st.sense = { tempC: 52.4, dbm: -54, fan: 2950, volt: 5.09 });
  const walk = (v, step, lo, hi) => Math.max(lo, Math.min(hi, v + (rand() * 2 - 1) * step));
  let archive = null; // the sync running: { started, files, bytes, done, timer }
  let setupRun = null; // { phases: [], timer }
  let update = null; // { status, message, percent, target }
  let down = null; // { reason, backAt } while rebooting or off
  function tick() {
    sense.tempC = walk(sense.tempC + (archive ? 0.8 : -0.2), 1.2, 44, 71);
    sense.dbm = Math.round(walk(sense.dbm, 3, -67, -46));
    sense.fan = Math.round(walk(sense.fan + (sense.tempC > 58 ? 120 : -60), 150, 0, 5200));
    sense.volt = Math.round(walk(sense.volt, 0.02, 5.02, 5.14) * 100) / 100;
    if (st.drives) st.freeBytes -= Math.round(40 + rand() * 160) * MIB; // the car writing
    st.freeBytes = Math.max(4_000_000_000, Math.min(110_000_000_000, st.freeBytes));
  }
  function statusBody() {
    const cfg = readConf().active;
    const t = unix();
    const total = 118_274_580_480;
    const busy = Boolean(archive || setupRun);
    return {
      cpu_temp: String(Math.round(sense.tempC * 1000)), cpu_percent: Math.round((busy ? 28 + rand() * 30 : 3 + rand() * 9) * 10) / 10,
      disk_io: { device: 'mmcblk0p3', read_bps: archive ? Math.round(5_000_000 + rand() * 3_000_000) : 0, write_bps: st.drives ? Math.round(120_000 + rand() * 150_000) : 0, busy_percent: Math.round((archive ? 40 : 2) + rand() * 6), read_total_bytes: 9_120_000_000 + st.clipsArchived * 31_000_000, write_total_bytes: 61_300_000_000 + (110_000_000_000 - st.freeBytes) },
      num_snapshots: String(st.snapshots.length), snapshot_oldest: String(st.snapshots[0]?.created_unix || ''), snapshot_newest: String(st.snapshots.at(-1)?.created_unix || ''),
      total_space: String(total), free_space: String(st.freeBytes), uptime: ((now() - st.bootAt) / 1000).toFixed(2), drives_active: st.drives ? 'yes' : 'no', udc_state: st.drives ? 'configured' : 'not attached',
      cam_last_write_secs: st.drives ? Math.round(2 + rand() * 40) : -1,
      wifi_adapters: [{ device: 'wlan0', connected: true, strength: String(sense.dbm), signal_dbm: sense.dbm, rx_bps: Math.round(18_000 + rand() * 9000), tx_bps: archive ? Math.round(4_500_000 + rand() * 2_000_000) : Math.round(3000 + rand() * 3000), rate_state: 'ok' }],
      wifi_ssid: cfg.SSID || '', wifi_freq: '5180000000', wifi_strength: String(sense.dbm), wifi_signal_dbm: sense.dbm, wifi_ip: '192.168.1.57', ether_ip: '', ether_speed: '',
      sbc_model: BOARD, fan_speed: String(sense.fan), supply_voltage: sense.volt,
      wifi_rx_bps: Math.round(18_000 + rand() * 9000), wifi_tx_bps: archive ? Math.round(4_500_000 + rand() * 2_000_000) : Math.round(3000 + rand() * 3000), ether_rx_bps: 0, ether_tx_bps: 0,
      wifi_rate_state: 'ok', ether_rate_state: 'disconnected', wifi_sample_age_ms: Math.round(400 + rand() * 1200), ether_sample_age_ms: null, sampled_at: t,
      storage_health: { state: st.freeBytes < 8_000_000_000 ? 'warn' : 'ok', message: st.freeBytes < 8_000_000_000 ? 'Backing files almost full' : 'Storage healthy', reserve_bytes: 4_000_000_000, free_bytes: st.freeBytes, total_bytes: total, cleanup_state: 'idle', cleanup_sampled_at: t - 120 },
      device_suffix: String(cfg.SENTRYUSB_HOSTNAME || 'sentryusb').split('-').pop(), archiving: Boolean(archive)
    };
  }
  const netFrame = () => ({ ssid: readConf().active.SSID || 'HomeNet-5G', iface: 'wlan0', ip: '192.168.1.57', gw: '192.168.1.1' });

  // ---- the share's status file (docs/sentry-usb.md), when given
  function writeShareStatus(patch) {
    if (!share) return;
    const file = path.join(share, '.sentryusb', 'archive-status.json');
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* a first one */ }
    const cfg = readConf().active;
    const next = { schema: 1, device: cfg.SENTRYUSB_HOSTNAME || 'sentryusb', snapshot_interval_s: Number(cfg.SNAPSHOT_INTERVAL) || 3480, auto_delete_enabled: cfg.ARCHIVE_AUTO_DELETE_VERIFIED === 'true', ...cur, ...patch, written_unix: unix() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, next); // (replaced, never written in place: the share's copy may be a hard link)
  }

  // ---- actions
  function goDown(reason, backInMs) {
    if (archive) stopArchive('the Sentry USB shut down');
    down = { reason, backAt: backInMs == null ? null : now() + backInMs };
    save();
    emit({ t: 'drop', backInMs });
    if (backInMs != null) later(backInMs, () => { boot(); });
  }
  function boot() {
    st.bootId = crypto.randomUUID();
    st.bootAt = now();
    down = null;
    save();
    logBoot();
    emit({ t: 'up' });
  }
  const rebootIn = () => Math.round(T.rebootMs[0] + rand() * (T.rebootMs[1] - T.rebootMs[0]));
  function reboot(why) {
    sys(`${why}: rebooting`);
    log('sentryusb', `${why}: rebooting`);
    sys('Stopping sentryusb.service - Sentry USB...', 'systemd[1]:');
    sys('Reached target reboot.target - System Reboot.', 'systemd[1]:');
    later(1200, () => goDown('reboot', rebootIn()));
  }
  function startArchive() {
    const cfg = readConf().active;
    const files = 24 + Math.floor(rand() * 36);
    const started = now();
    const id = `snap-${String(++st.snapSeq).padStart(6, '0')}`;
    const snap = { id, cumulative_reclaim_bytes: 0, older_count: st.snapshots.length, created_unix: Math.floor(started / 1000), archive: { state: 'unverified', clips: files, verified: 0, verified_twice: 0, converted: 0, quick: 0, basic: 0 } };
    st.snapshots.push(snap);
    archive = { started, files, bytes: files * 31_457_280, copied: 0, snap, steps: [] };
    log('archiveloop', 'Sync requested from Sentry Manager');
    log('archiveloop', `Archive server ${cfg.ARCHIVE_SERVER} reachable`);
    log('archiveloop', `Took snapshot ${id}; archiving ${files} clips (${(archive.bytes / 1e9).toFixed(2)} GB) to //${cfg.ARCHIVE_SERVER}/${cfg.SHARE_NAME}`);
    sys(`archive: started, ${files} clips to //${cfg.ARCHIVE_SERVER}/${cfg.SHARE_NAME}`);
    const first = started - files / 4 * 60_000;
    const day = clipKey(first).slice(0, 10);
    archive.firstClip = `RecentClips/${day}/${clipKey(Math.floor(first / 60_000) * 60_000)}-front.mp4`;
    archive.lastClip = `RecentClips/${clipKey(started).slice(0, 10)}/${clipKey(Math.floor(started / 60_000) * 60_000 - 60_000)}-front.mp4`;
    writeShareStatus({ state: 'transferring', archive: { result: 'in_progress', started_unix: Math.floor(started / 1000), finished_unix: null, files_archived: 0, files_not_archived: 0, last_clip: null }, transfer: { started_unix: Math.floor(started / 1000), files, bytes: archive.bytes, first_clip: archive.firstClip, last_clip: archive.lastClip, expected_finish_unix: Math.floor((started + T.syncMs) / 1000) + 5, give_up_unix: Math.floor((started + T.syncMs) / 1000) + 600 }, snapshots: shareSnapshots(snap) });
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      archive.steps.push(later((T.syncMs * i) / (steps + 1), () => {
        if (!archive) return;
        archive.copied = Math.round((files * i) / steps);
        log('archiveloop', `Copied ${archive.copied} of ${files} clips (${((archive.bytes * i) / steps / 1e9).toFixed(2)} GB)`);
      }));
    }
    archive.steps.push(later(T.syncMs, () => finishArchive()));
    save();
    emit({ t: 'status' });
  }
  function shareSnapshots(snap) {
    if (!share) return undefined;
    let list = [];
    try { list = JSON.parse(fs.readFileSync(path.join(share, '.sentryusb', 'archive-status.json'), 'utf8')).snapshots || []; } catch { /* none */ }
    if (!list.some((s) => s.name === snap.id)) list.push({ name: snap.id, started_unix: snap.created_unix, kept: true });
    return list.slice(-1000);
  }
  function finishArchive() {
    if (!archive) return;
    const a = archive;
    archive = null;
    const cfg = readConf().active;
    a.snap.archive = { ...a.snap.archive, state: cfg.ARCHIVE_VERIFY === 'true' ? 'verified' : 'unverified', verified: cfg.ARCHIVE_VERIFY === 'true' ? a.files : 0, basic: cfg.ARCHIVE_VERIFY === 'true' ? a.files : 0 };
    st.clipsArchived += a.files;
    st.lastArchive = { at: unix(), clips: a.files };
    if (cfg.ARCHIVE_AUTO_DELETE_VERIFIED === 'true') st.freeBytes += a.bytes;
    log('archiveloop', `Archived ${a.files} clips, verified ${cfg.ARCHIVE_VERIFY === 'true' ? a.files : 0} (${cfg.ARCHIVE_VERIFY_MODE || 'basic'})`);
    log('archiveloop', `Archive cycle done in ${Math.round((now() - a.started) / 1000)} s; ${st.clipsArchived.toLocaleString('en-US')} clips archived in all`);
    sys(`archive: ${a.files} clips archived to //${cfg.ARCHIVE_SERVER}/${cfg.SHARE_NAME}`);
    writeShareStatus({ state: 'idle', transfer: null, archive: { result: 'ok', started_unix: Math.floor(a.started / 1000), finished_unix: unix(), files_archived: a.files, files_not_archived: 0, last_clip: a.lastClip }, verification: { enabled: cfg.ARCHIVE_VERIFY === 'true', ran: cfg.ARCHIVE_VERIFY === 'true', matched: a.files, converted: 0, resending: 0, no_pi_copy: 0, still_queued: 0, stopped: null } });
    save();
    emit({ t: 'status' });
  }
  function stopArchive(why) {
    const a = archive;
    if (!a) return;
    archive = null;
    for (const t of a.steps) { clearTimeout(t); timers.delete(t); }
    log('archiveloop', `Archive stopped (${why}) after ${a.copied} of ${a.files} clips; the rest go with the next archive`);
    sys(`archive: stopped after ${a.copied} of ${a.files} clips (${why})`);
    st.clipsArchived += a.copied;
    a.snap.archive.clips = a.files;
    writeShareStatus({ state: 'idle', transfer: null, archive: { result: 'failed', started_unix: Math.floor(a.started / 1000), finished_unix: unix(), files_archived: a.copied, files_not_archived: a.files - a.copied, last_clip: null } });
    save();
    emit({ t: 'status' });
  }
  function runSetup() {
    setupRun = { phases: [], step: 0 };
    log('setup', 'Setup started (requested from Sentry Manager)');
    sys('setup: started from Sentry Manager');
    const step = () => {
      if (!setupRun) return;
      const ph = SETUP_PHASES[setupRun.step++];
      if (!ph) {
        log('setup', 'Setup finished, rebooting');
        sys('setup: finished');
        setupRun = null;
        st.setupFinishedAt = unix();
        save();
        reboot('Setup finished');
        return;
      }
      setupRun.phases.push({ id: ph[0], label: ph[1] });
      log('setup', `phase: ${ph[1]} (${ph[0]})`);
      if (ph[0] === 'verify') log('setup', 'Configuration OK');
      if (ph[0] === 'archive') { const c = readConf().active; log('setup', `Archive: ${c.ARCHIVE_SYSTEM} //${c.ARCHIVE_SERVER}/${c.SHARE_NAME} (SMB ${c.CIFS_VERSION || 'default'})`); }
      if (ph[0] === 'wifi_ap') log('setup', `Access point ${readConf().active.AP_SSID || 'off'}`);
      later(T.setupStepMs, step);
    };
    later(T.setupStepMs, step);
  }
  function installUpdate(target) {
    update = { status: 'checking', message: 'Checking release…', percent: null, target };
    log('sentryusb', `Update to ${target} requested from Sentry Manager`, { target: 'sentryusb_update' });
    sys(`update: installing ${target} (from Sentry Manager)`);
    const plan = [
      ['downloading', `Downloading ${target}…`, 0], ['downloading', `Downloading ${target}…`, 35], ['downloading', `Downloading ${target}…`, 70], ['downloading', `Downloading ${target}…`, 100],
      ['remounting', 'Preparing filesystem…', null], ['installing', 'Installing update…', null], ['installing', 'Installing components…', null], ['complete', `Installed ${target}`, null], ['restarting', 'Restarting Pi to apply update…', null]
    ];
    plan.forEach(([status, message, percent], i) => later(T.updateStepMs * (i + 1), () => {
      if (!update) return;
      Object.assign(update, { status, message, percent });
      log('sentryusb', `update: ${status}${percent != null ? ` ${percent}%` : ''}: ${message}`, { target: 'sentryusb_update' });
      if (status === 'restarting') {
        const from = st.version;
        st.version = target;
        st.updateCache = { update_available: false, current_version: target, latest_version: target, source_repo: OFFICIAL_UPDATE_REPO, checked_at: new Date(now()).toISOString().replace(/\.\d+Z$/, 'Z') };
        sys(`update: ${from} → ${target} installed`);
        update = null;
        save();
        later(800, () => goDown('update', rebootIn()));
      }
    }));
  }

  // ---- settings
  function setupConfigBody() {
    const { active, commented } = readConf();
    const out = {};
    const put = (k, value, isActive) => {
      if (isSecretKey(k)) { out[`${k}__set`] = value !== ''; out[k] = { value: '', active: isActive }; } else out[k] = { value, active: isActive };
    };
    for (const [k, v] of Object.entries(commented)) put(k, v, false);
    for (const [k, v] of Object.entries(active)) put(k, v, true);
    return out;
  }
  function saveSetupConfig(body) {
    const { active } = readConf();
    const r = prepareSetupConfigWrite(body, active);
    if (r.error) {
      log('manager-link', `PUT /api/setup/config refused: ${r.error}`, { level: 'WARN', target: 'manager_link' });
      return r;
    }
    const next = r.config;
    const lines = [];
    for (const k of new Set([...Object.keys(active), ...Object.keys(next)])) {
      const a = active[k];
      const b = next[k];
      if (a === b) continue;
      if (a !== undefined && b === undefined) lines.push(`${k} turned off`);
      else if (isSecretKey(k)) lines.push(`${k} changed`);
      else if (a === undefined) lines.push(`${k} set to ${b}`);
      else lines.push(`${k} changed ${a === '' ? "''" : a} → ${b === '' ? "''" : b}`);
    }
    fs.writeFileSync(`${confFile}.tmp`, writeConf(fs.readFileSync(confFile, 'utf8'), next), { mode: 0o600 });
    fs.renameSync(`${confFile}.tmp`, confFile);
    if (!lines.length) log('setup', 'Setup config saved from Sentry Manager: nothing changed');
    for (const l of lines) {
      const text = `Setup config: ${l} (from Sentry Manager)`;
      log('setup', text);
      sys(text);
    }
    return { changed: lines };
  }

  // ---- diagnostics and health
  function diagnosticsText() {
    const cfg = readConf().active;
    const at = st.diagnosticsAt;
    const up = (now() - st.bootAt) / 1000;
    const used = 118_274_580_480 - st.freeBytes;
    const recent = (() => { try { return fs.readFileSync(logFile('archiveloop'), 'utf8').trimEnd().split('\n').slice(-12).join('\n'); } catch { return ''; } })();
    return `====== Sentry USB diagnostics ======
Version: ${st.version}
Board: ${BOARD}
Host name: ${cfg.SENTRYUSB_HOSTNAME}
Uptime: ${Math.floor(up / 86400)} day(s), ${p2(Math.floor((up % 86400) / 3600))}:${p2(Math.floor((up % 3600) / 60))}
Boot id: ${st.bootId}
CPU temperature: ${sense.tempC.toFixed(1)}°C · fan ${sense.fan} rpm · supply ${sense.volt.toFixed(2)} V
Throttled: 0x0

====== df -h ======
Filesystem      Size  Used Avail Use% Mounted on
/dev/mmcblk0p2   29G  6.4G   22G  23% /
/dev/mmcblk0p3  111G  ${Math.round(used / 1e9)}G   ${Math.round(st.freeBytes / 1e9)}G  ${Math.round((used / 118_274_580_480) * 100)}% /backingfiles

====== USB gadget ======
drives: ${st.drives ? 'presented to the car (configured)' : 'off (not attached)'}
cam_disk.bin ${cfg.CAM_SIZE}, music_disk.bin ${cfg.MUSIC_SIZE}, lightshow_disk.bin ${cfg.LIGHTSHOW_SIZE}

====== network ======
wlan0: ${cfg.SSID}, ${sense.dbm} dBm, 192.168.1.57/24 via 192.168.1.1
archive server ${cfg.ARCHIVE_SERVER}: reachable (SMB ${cfg.CIFS_VERSION})

====== snapshots ======
${st.snapshots.map((s) => `${s.id}  ${new Date(s.created_unix * 1000).toISOString()}  ${s.archive.state}  ${s.archive.clips} clips`).join('\n')}

====== archiveloop (last 12) ======
${recent}
Capture completed (UTC): ${at ? new Date(at * 1000).toISOString().replace(/\.\d+Z$/, 'Z') : 'never'}
====== end of diagnostics ======
`;
  }
  function healthCheck() {
    const cfg = readConf().active;
    const items = [
      ['Hardware', [{ name: 'CPU temperature', status: sense.tempC > 70 ? 'warn' : 'pass', detail: `${sense.tempC.toFixed(1)}°C` }, { name: 'Power/throttling', status: 'pass', detail: `${sense.volt.toFixed(2)} V, not throttled` }, { name: 'Fan', status: 'pass', detail: `${sense.fan} rpm` }, { name: 'Binary variant', status: 'pass', detail: 'aarch64-cortex-a76' }]],
      ['Storage', [{ name: 'Backing files', status: st.freeBytes < 8e9 ? 'warn' : 'pass', detail: `${Math.round(st.freeBytes / 1e9)} GB free` }, { name: 'Snapshots', status: 'pass', detail: `${st.snapshots.length} snapshots` }]],
      ['Archive', [{ name: 'Archive server reachable', status: 'pass', detail: cfg.ARCHIVE_SERVER }, { name: 'Last archive', status: 'pass', detail: `${st.lastArchive?.clips ?? 0} clips, ${cfg.ARCHIVE_VERIFY === 'true' ? 'verified' : 'not verified'}` }]],
      ['Network', [{ name: 'Wi-Fi', status: sense.dbm < -70 ? 'warn' : 'pass', detail: `${cfg.SSID}, ${sense.dbm} dBm` }, { name: 'Internet', status: 'pass' }]]
    ].map(([name, list]) => ({ name, items: list }));
    const all = items.flatMap((c) => c.items);
    const warn = all.filter((i) => i.status === 'warn').length;
    return { summary: `${all.length - warn} passed${warn ? `, ${warn} warning${warn === 1 ? '' : 's'}` : ''}`, categories: items };
  }

  // ---- logs over the link
  function readLog(name) {
    if (name === 'diagnostics') return st.diagnosticsAt ? diagnosticsText() : '';
    try { return fs.readFileSync(logFile(name), 'utf8'); } catch { return null; }
  }
  function logPage(name, q) {
    const text = readLog(name);
    if (text === null) return null;
    const buf = Buffer.from(text);
    const lines = Math.max(1, Math.min(Number(q.get('lines')) || 50, 2000));
    let end = q.get('before') != null && /^\d+$/.test(q.get('before')) ? Math.min(Number(q.get('before')), buf.length) : buf.length;
    let start = end;
    let n = 0;
    while (start > 0 && n <= lines) { start = buf.lastIndexOf(10, start - 2) + 1; n++; if (start === 0) break; }
    if (n > lines) start = buf.indexOf(10, start) + 1;
    if (end < start) end = start;
    return { content: buf.subarray(start, end).toString(), before: start > 0 ? start : null, has_more: start > 0 };
  }
  function logTail(name, q) {
    const text = readLog(name);
    if (text === null) return null;
    const buf = Buffer.from(text);
    const m = /^(\d+)\.(\d+)$/.exec(q.get('cursor') || '');
    const epoch = st.logEpoch || 0;
    if (!m) { const start = Math.max(0, buf.length - 64 * 1024); return { content: buf.subarray(start).toString(), cursor: `${epoch}.${buf.length}`, before: start, reset: false, has_more: start > 0 }; }
    const reset = Number(m[1]) !== epoch || Number(m[2]) > buf.length;
    const from = reset ? 0 : Number(m[2]);
    return { content: buf.subarray(from).toString(), cursor: `${epoch}.${buf.length}`, before: from, reset, has_more: false };
  }

  /** The Pi's answer to one request from Manager: { status, type, body } or { status, type, buf }. */
  function answer({ method, path: p, query, body }) {
    const json = (b, status = 200) => ({ status, type: 'application/json', body: b });
    const fail = (status, error) => json({ error }, status);
    const ok = () => json({ success: true });
    const r = route(method, p, new URLSearchParams(query || ''), body, json, fail, ok);
    if (!(method === 'GET' && (p === '/api/status' || p.startsWith('/api/logs/') || p === '/api/system/update-status' || p === '/api/system/version'))) log('manager-link', `${method} ${p} → ${r.status}`, { target: 'manager_link' });
    return r;
  }
  function route(method, p, q, body, json, fail, ok) {
    const key = `${method} ${p}`;
    switch (key) {
      case 'GET /api/health': return json({ ok: true });
      case 'GET /api/status': return json(statusBody());
      case 'GET /api/system/version': return json({ version: st.version, binary_version: st.version.replace(/^v/, ''), sbc_model: BOARD, boot_id: st.bootId });
      case 'GET /api/setup/config': return json(setupConfigBody());
      case 'PUT /api/setup/config': { const r = saveSetupConfig(body); return r.error ? fail(400, r.error) : ok(); }
      case 'GET /api/setup/status': return json({ setup_finished: !setupRun, setup_running: Boolean(setupRun), boot_id: st.bootId });
      case 'GET /api/setup/phases': return json({ phases: setupRun ? setupRun.phases : SETUP_PHASES.map(([id, label]) => ({ id, label })) });
      case 'POST /api/setup/run':
        if (setupRun) return fail(409, 'Setup is already running');
        runSetup();
        return json({ status: 'started' });
      case 'POST /api/system/check-update': {
        const latest = nextTestVersion(st.version);
        const notes = `Test build ${testNumber(latest)} of ${st.version.split('-')[0]}.\n- Faster archive checks on large shares\n- Sentry Manager link: status pushes carry the supply voltage on Pi 5`;
        const res = { current_version: st.version, source_repo: OFFICIAL_UPDATE_REPO, checked_at: new Date(now()).toISOString().replace(/\.\d+Z$/, 'Z'), update_available: true, latest_version: latest, release_url: `https://github.com/${OFFICIAL_UPDATE_REPO}/releases/tag/${latest}`, release_notes: notes, prerelease: { version: latest, release_url: `https://github.com/${OFFICIAL_UPDATE_REPO}/releases/tag/${latest}`, release_notes: notes, available: true } };
        st.updateCache = res;
        save();
        log('sentryusb', `Update check: ${latest} available (running ${st.version})`, { target: 'sentryusb_update' });
        return json(res);
      }
      case 'GET /api/system/update-status':
        if (update) return json({ status: update.status, message: update.message, percent: update.percent, update_available: true, latest_version: update.target });
        return json(st.updateCache || { update_available: false, checked_at: '' });
      case 'POST /api/system/update': {
        let target = st.updateCache?.update_available ? st.updateCache.latest_version : null;
        if (body !== null && body !== undefined) {
          if (typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Expected {"version": ...} or no body');
          const v = body.version;
          if (typeof v === 'string') {
            if (!(v && v.length <= 64 && !v.includes('..') && /^[A-Za-z0-9._+-]+$/.test(v))) return fail(400, 'version must be a release tag like v3.29.0');
            const want = releaseNumber(v);
            const have = releaseNumber(st.version);
            if (!want && have) return fail(400, 'version must be a release tag like v3.29.0');
            if (want && have && older(want, have) < 0) return fail(403, 'Over Sentry Manager the Sentry USB can\'t be moved to an older version.');
            target = v;
          } else if (v !== undefined && v !== null) return fail(400, 'version must be a release tag like v3.29.0');
        }
        if (update) return fail(409, 'An update is already running');
        if (!target || target === st.version) return fail(409, 'No update available');
        installUpdate(target);
        return json({ status: 'started' });
      }
      case 'GET /api/system/check-internet': return json({ connected: true });
      case 'GET /api/system/health-check': return json(healthCheck());
      case 'GET /api/diagnostics': return { status: 200, type: 'text/plain', body: st.diagnosticsAt ? diagnosticsText() : 'Diagnostics have not been generated yet.\nClick the Refresh button above to generate a diagnostics report.' };
      case 'POST /api/diagnostics/refresh': st.diagnosticsAt = unix(); save(); log('sentryusb', 'Diagnostics gathered (from Sentry Manager)'); return ok();
      case 'POST /api/diagnostics/download': if (!st.diagnosticsAt) { st.diagnosticsAt = unix(); save(); } return { status: 200, type: 'text/plain', buf: Buffer.from(diagnosticsText()) };
      case 'POST /api/system/reboot': reboot('Reboot requested from Sentry Manager'); return json({ success: true, message: 'Rebooting...' });
      case 'POST /api/system/shutdown':
        sys('Shutdown requested from Sentry Manager: powering off');
        sys('Reached target poweroff.target - System Power Off.', 'systemd[1]:');
        later(1200, () => goDown('shutdown', null));
        return json({ success: true, message: 'Shutting down...' });
      case 'POST /api/system/trigger-sync':
        if (archive) return fail(409, 'archive cycle is still active');
        startArchive();
        return ok();
      case 'POST /api/system/cancel-archive':
        if (!archive) return fail(409, 'archive cycle has already ended; refresh status');
        stopArchive('cancelled from Sentry Manager');
        return json({ success: true }, 202);
      case 'POST /api/system/toggle-drives': return drives(!st.drives, ok);
      case 'POST /api/system/gadget-enable': return drives(true, ok);
      case 'POST /api/system/gadget-disable': return drives(false, ok);
      case 'GET /api/snapshots': return json({ snapshots: st.snapshots, verification: readConf().active.ARCHIVE_VERIFY === 'true', total_allocated_bytes: st.snapshots.length * 812_000_000, sizes_computed_at: unix() - 300, sizes_pending: false });
      case 'GET /api/snapshots/live': return json({ car_last_write_ts: st.drives ? unix() - 14 : null, next_scheduled_ts: unix() + 420, server_ts: unix() });
      case 'POST /api/system/backup': {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(confFile)).digest('hex');
        const date = dayOf(unix());
        if (hash === st.backupHash) { log('sentryusb', `[backup] Skipped config backup — no changes detected (hash ${hash.slice(0, 12)})`, { target: 'sentryusb_backup' }); return json({ success: true, skipped: true, reason: 'no changes detected', drive_data_refreshed: false, date }); }
        st.backupHash = hash;
        st.backups = [{ date, timestamp: new Date(now()).toISOString().replace(/\.\d+Z$/, 'Z'), location: 'archive', size: 18_000 + Math.floor(rand() * 600), filename: `sentryusb-backup-${date}.json` }, ...st.backups.filter((b) => b.date !== date)].slice(0, 30);
        save();
        log('sentryusb', `[backup] Config backup ${date} written to //${readConf().active.ARCHIVE_SERVER}/${readConf().active.SHARE_NAME}/sentryusb-backups (from Sentry Manager)`, { target: 'sentryusb_backup' });
        return json({ success: true, date, location: 'archive' });
      }
      case 'GET /api/system/backups': return json(st.backups);
      default: break;
    }
    let m = /^\/api\/logs\/([A-Za-z0-9_.-]+)(\/page|\/tail)?$/.exec(p);
    if (method === 'GET' && m) {
      if (!LOG_NAMES.includes(m[1])) return fail(404, 'Unknown log');
      if (!m[2]) { const text = readLog(m[1]); return text === null ? fail(404, 'Log not found') : { status: 200, type: 'text/plain', body: text.slice(-512 * 1024) }; }
      const r = m[2] === '/page' ? logPage(m[1], q) : logTail(m[1], q);
      return r ? json(r) : fail(404, 'Log not found');
    }
    m = /^\/api\/snapshots\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/.exec(p);
    if (method === 'DELETE' && m) {
      const s = st.snapshots.find((x) => x.id === m[1]);
      if (!s) return fail(404, 'snapshot not found');
      if (archive && archive.snap === s) return fail(409, 'snapshot is being archived');
      st.snapshots = st.snapshots.filter((x) => x !== s);
      st.freeBytes += s.cumulative_reclaim_bytes || 400_000_000;
      save();
      const text = `Snapshot ${s.id} (${new Date(s.created_unix * 1000).toISOString().replace(/\.\d+Z$/, 'Z')}) deleted (from Sentry Manager)`;
      log('archiveloop', text);
      sys(text);
      emit({ t: 'status' });
      return ok();
    }
    return fail(403, 'Not allowed over the Sentry Manager link');
  }
  function drives(on, ok) {
    if (st.drives !== on) {
      st.drives = on;
      save();
      const text = on ? 'USB drives presented to the car (from Sentry Manager)' : 'USB drives removed from the car (from Sentry Manager)';
      sys(text);
      log('sentryusb', text, { target: 'sentryusb_drives' });
      emit({ t: 'status' });
    }
    return ok();
  }

  return {
    answer, statusBody, netFrame, tick, readConf, log, logBoot,
    get state() { return st; }, get down() { return down; }, get archiving() { return Boolean(archive); }, get setupRunning() { return Boolean(setupRun); }, get updating() { return update; },
    saveLink(v) { Object.assign(st, v); save(); },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** after a shut down, the tool was started again: power came back */
    powerOn() { if (down && down.backAt == null) boot(); },
    close() { for (const t of timers) clearTimeout(t); timers.clear(); save(); }
  };
}

// ---- Manager's API, for --auto-pair (opens a pairing slot as an admin)
function apiCall(base, method, p, body, cookie) {
  const u = new URL(p, base);
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request(u, { method, rejectUnauthorized: false, headers: { 'X-Requested-With': 'sentry-six-manager', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: j, cookies: (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]) });
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('timed out')));
    req.end(data);
  });
}
async function openPairingSlot({ base, admin, adminPassword, name, username, password }) {
  const login = await apiCall(base, 'POST', '/api/auth/login', { username: admin, password: adminPassword });
  if (login.status !== 200) throw new Error(`Sentry Manager sign-in: ${login.status} ${login.body?.error || ''}`);
  const cookie = login.cookies.join('; ');
  const conf = await apiCall(base, 'POST', '/api/auth/confirm', { password: adminPassword }, cookie);
  if (conf.status !== 200) throw new Error(`Sentry Manager password confirmation: ${conf.status} ${conf.body?.error || ''}`);
  const r = await apiCall(base, 'POST', '/api/sentryusb/pair', { name, username, password }, cookie);
  if (r.status !== 200 || !r.body?.pairing?.code) throw new Error(`Sentry Manager pairing: ${r.status} ${r.body?.error || ''}`);
  return r.body.pairing.code;
}

/**
 * Keeps the demo Pi connected: pairs (a code, or --auto-pair), then the
 * link key; status every statusMs; follows the Pi's reboots and shutdown.
 */
function runDemoSentryUsb(pi, o) {
  let stopped = false;
  let current = null;
  let statusTimer = null;
  let retry = null;
  let delay = 1000;
  let alertSent = !o.impostorOnce;
  let code = o.code || null;
  const say = o.say || ((m) => console.log(`demo Sentry USB: ${m}`));
  const schedule = (ms) => { clearTimeout(retry); if (!stopped) retry = setTimeout(connect, ms); };
  const pushStatus = () => { if (current?.ws && !current.ws.closed) { pi.tick(); current.send({ t: 'status', body: pi.statusBody() }); } };
  pi.on((e) => {
    if (e.t === 'status') pushStatus();
    if (e.t === 'drop') {
      say(e.backInMs == null ? 'shut down: offline until this tool is started again' : `${e.backInMs ? 'rebooting' : 'restarting'}: back in ${Math.round(e.backInMs / 1000)} s`);
      clearTimeout(retry);
      current?.ws?.close(1001, 'going away');
    }
    if (e.t === 'up') { say(`booted (${pi.state.version})`); schedule(300); }
  });
  async function connect() {
    if (stopped || pi.down) return;
    const st = pi.state;
    try {
      let mode = st.key ? 'key' : 'pair';
      if (mode === 'pair' && !code && o.autoPair) {
        const cfg = pi.readConf().active;
        code = await openPairingSlot({ ...o.autoPair, username: o.username || cfg.WEB_USERNAME, password: o.password || cfg.WEB_PASSWORD });
        say('opened a pairing slot on Sentry Manager');
      }
      if (mode === 'pair' && !code) { say('not paired: give --code (the pairing code Sentry Manager shows) or --auto-pair'); return; }
      const cfg = pi.readConf().active;
      const alerts = alertSent ? [] : [{ kind: 'fingerprint', seen: crypto.createHash('sha256').update('a certificate that is not Sentry Manager\'s').digest('hex'), at: Math.floor(Date.now() / 1000) - 1800 }];
      const c = await connectFakePi({
        port: o.port, host: o.host, id: st.id, name: cfg.SENTRYUSB_HOSTNAME, iterations: o.iterations, state: { version: st.version }, status: false, net: pi.netFrame(), alerts,
        ...(mode === 'key' ? { mode, key: st.key, pin: st.fp } : { mode, username: o.username || cfg.WEB_USERNAME, password: o.password || cfg.WEB_PASSWORD, code }),
        answer: (m) => pi.answer(m),
        onClose: (closeCode) => {
          clearInterval(statusTimer);
          if (current === c) current = null;
          if (stopped) return;
          if (closeCode === 4001) { say('unpaired by Sentry Manager: forgetting the link key'); pi.saveLink({ key: null, fp: null }); code = null; pi.log('manager-link', 'Unpaired by Sentry Manager', { level: 'WARN', target: 'manager_link' }); if (!o.autoPair) return; }
          if (pi.down) return; // it comes back by itself (or stays off)
          pi.log('manager-link', `Link to Sentry Manager closed (${closeCode}); reconnecting`, { level: 'WARN', target: 'manager_link' });
          schedule(delay);
          delay = Math.min(delay * 2, 30_000);
        }
      });
      if (c.result !== 'ok') {
        say(`connection ${c.result}${c.why ? ` (${c.why})` : ''}`);
        if (mode === 'pair') code = null; // a code is good once
        if (mode === 'key' && (c.result === 'denied' || c.result === 'pin mismatch') && o.autoPair) { pi.saveLink({ key: null, fp: null }); say('the link key was refused: pairing again'); }
        if (!c.ws || c.result !== 'closed') schedule(delay);
        delay = Math.min(delay * 2, 30_000);
        return;
      }
      if (!alertSent) { alertSent = true; say('sent one fingerprint alert (--impostor-once)'); }
      delay = 1000;
      current = c;
      if (mode === 'pair') { pi.saveLink({ key: c.linkKey, fp: c.fp }); code = null; say(`paired (id ${st.id})`); pi.log('manager-link', 'Paired with Sentry Manager', { target: 'manager_link' }); }
      pi.log('manager-link', 'Sentry Manager link up', { target: 'manager_link' });
      say(`connected (${st.version})`);
      pushStatus();
      clearInterval(statusTimer);
      statusTimer = setInterval(pushStatus, o.statusMs || 30_000);
    } catch (err) {
      say(`connection failed: ${err.message}`);
      schedule(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
  pi.powerOn();
  connect();
  return {
    get connected() { return Boolean(current?.ws && !current.ws.closed); },
    stop() { stopped = true; clearTimeout(retry); clearInterval(statusTimer); current?.ws?.close(1000, 'bye'); pi.close(); }
  };
}

module.exports = { createDemoSentryUsb, runDemoSentryUsb, prepareSetupConfigWrite, validateValue, parseConf, writeConf, SETTABLE, CONF_TEMPLATE };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const flag = (n) => argv.includes(`--${n}`);
  const dir = arg('state');
  if (!dir || flag('help')) {
    console.log('node tools/demo-sentry-usb.js --state DIR [--manager HOST:PORT] [--code CODE | --auto-pair https://HOST:PORT --admin USER --admin-password PASS --name NAME] [--user PI_USER --password PI_PASS] [--share DIR] [--impostor-once]');
    process.exit(dir ? 0 : 2);
  }
  const [host, port] = (arg('manager', '127.0.0.1:10000')).split(/:(?=\d+$)/);
  const pi = createDemoSentryUsb({ dir, share: arg('share'), id: arg('id') });
  const autoPair = arg('auto-pair') ? { base: arg('auto-pair'), admin: arg('admin', 'admin'), adminPassword: arg('admin-password', ''), name: arg('name', 'Demo Sentry USB') } : null;
  const run = runDemoSentryUsb(pi, { host, port: Number(port), code: arg('code'), username: arg('user'), password: arg('password'), autoPair, impostorOnce: flag('impostor-once') });
  const bye = () => { run.stop(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
