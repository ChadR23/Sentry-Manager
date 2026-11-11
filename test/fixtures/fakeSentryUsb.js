'use strict';

// A fake Sentry USB (the Pi) for tests and development: it connects to
// Manager's device port like the real Pi (docs/sentry-usb-link.md), proves
// it holds P (from K and the pairing code Manager showed, protocol v2) or the
// link key, pushes its status and answers allowlisted
// requests with JSON shaped like the real handlers (sentry-usb
// crates/api/src: status.rs, setup.rs, update.rs, healthcheck.rs, logs.rs,
// snapshots.rs, backup.rs, system.rs).
//
//   const pi = await connectFakePi({ port, mode: 'pair', username, password, code });
//   pi.result  'ok' | 'denied';  pi.why;  pi.linkKey;  pi.close()
//
// From a shell (development, screenshots):
//   node test/fixtures/fakeSentryUsb.js --port 10076 --user pi --password raspberry --code K7QP-M2XD-9WRT --state /tmp/pi.json

const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');
const { WsConnection } = require('../../server/wsFrames');
const { pairingKey, pairCodeSecret, normalizePairingCode, piProof, managerProof, sameHex, fpHex, isSecretKey, SETTABLE, secretsNeeded, V } = require('../../server/sentryUsbLink');

const MIB = 1024 * 1024;
const now = () => Math.floor(Date.now() / 1000);

// ---- realistic answers (field names and shapes from the real handlers)
function fakeState() {
  const config = {
    SSID: 'HomeNet', WIFIPASS: 'hunter22', AP_SSID: 'SentryUSB', AP_PASS: '', SENTRYUSB_HOSTNAME: 'sentryusb-model3', TIME_ZONE: 'America/Los_Angeles',
    ARCHIVE_SYSTEM: 'cifs', ARCHIVE_SERVER: 'nas.local', SHARE_NAME: 'TeslaCam', SHARE_USER: 'sentry', SHARE_PASSWORD: 'smbpass', CIFS_VERSION: '3.0',
    ARCHIVE_RECENTCLIPS: 'true', ARCHIVE_SAVEDCLIPS: 'true', ARCHIVE_SENTRYCLIPS: 'true', ARCHIVE_VERIFY: 'true', ARCHIVE_AUTO_DELETE_VERIFIED: 'true', ARCHIVE_DELAY: '20',
    CAM_SIZE: '40G', MUSIC_SIZE: '4G', LIGHTSHOW_SIZE: '1G', SNAPSHOT_INTERVAL: '480', DRIVE_MAP_ENABLED: 'true', SAMBA_ENABLED: 'false',
    WEB_USERNAME: 'pi', WEB_PASSWORD: 'raspberry', NTFY_ENABLED: 'true', NTFY_URL: 'https://ntfy.sh/sentry-car', NTFY_TOKEN: 'tk_123', MOBILE_PUSH_ENABLED: 'true',
    TESLA_BLE_VIN: '5YJ3E1EA4JF000001', TEMPERATURE_POSTARCHIVE: 'true', TEMPERATURE_UNIT: 'C', REPO: 'Sentry-Six'
  };
  const commented = { RSYNC_USER: '', RSYNC_SERVER: '', RCLONE_DRIVE: '', BOOMBOX_SIZE: '100M', USE_EXFAT: 'true', DISCORD_ENABLED: 'true', DISCORD_WEBHOOK_URL: '', TELEGRAM_BOT_TOKEN: '', CPU_GOVERNOR: 'conservative' };
  // config and commented hold the real values, secrets included; reads mask them as the Pi does
  return { config, commented, drives: true, archiving: false, version: 'v3.28.10-test.7', snapshots: makeSnapshots(), updateStatus: null };
}

function makeSnapshots() {
  const t = now();
  return [6, 5, 4, 3, 2, 1].map((h, i) => ({
    id: `snap-${String(41 + i).padStart(6, '0')}`, cumulative_reclaim_bytes: (i + 1) * 812_000_000, older_count: i, created_unix: t - h * 3600 * 8,
    archive: { state: i < 4 ? 'verified' : i === 4 ? 'pending' : 'unverified', clips: 120 - i * 7, verified: i < 4 ? 120 - i * 7 : 0, verified_twice: i < 3 ? 120 - i * 7 : 0, converted: i < 2 ? 12 : 0, quick: 0, basic: 0 }
  }));
}

function statusBody(st) {
  return {
    cpu_temp: '51540', cpu_percent: 7.4, disk_io: { device: 'mmcblk0p3', read_bps: 0, write_bps: 182_000, busy_percent: 2.1, read_total_bytes: 9_120_000_000, write_total_bytes: 61_300_000_000 },
    num_snapshots: String(st.snapshots.length), snapshot_oldest: String(st.snapshots[0]?.created_unix || ''), snapshot_newest: String(st.snapshots.at(-1)?.created_unix || ''),
    total_space: '118274580480', free_space: '61294219264', uptime: '93721.4', drives_active: st.drives ? 'yes' : 'no', udc_state: st.drives ? 'configured' : 'not attached', cam_last_write_secs: 14,
    wifi_adapters: [{ device: 'wlan0', connected: true, strength: '-52', signal_dbm: -52, rx_bps: 21_000, tx_bps: 4_000, rate_state: 'ok' }],
    wifi_ssid: 'HomeNet', wifi_freq: '5180000000', wifi_strength: '-52', wifi_signal_dbm: -52, wifi_ip: '192.168.1.57', ether_ip: '', ether_speed: '',
    sbc_model: 'Raspberry Pi 4 Model B Rev 1.5', fan_speed: '', supply_voltage: 5.08, wifi_rx_bps: 21_000, wifi_tx_bps: 4_000, ether_rx_bps: 0, ether_tx_bps: 0,
    wifi_rate_state: 'ok', ether_rate_state: 'disconnected', wifi_sample_age_ms: 900, ether_sample_age_ms: null, sampled_at: now(),
    storage_health: { state: 'ok', message: 'Storage healthy', reserve_bytes: 4_000_000_000, free_bytes: 61_294_219_264, total_bytes: 118_274_580_480, cleanup_state: 'idle', cleanup_sampled_at: now() - 120 },
    device_suffix: 'model3', archiving: st.archiving
  };
}

// GET /api/setup/config over the link (manager_link secrets.rs mask_setup_config)
function setupConfigBody(st) {
  const out = {};
  for (const [k, v] of [...Object.entries(st.commented).map(([k, v]) => [k, { value: v, active: false }]), ...Object.entries(st.config).map(([k, v]) => [k, { value: v, active: true }])]) {
    if (isSecretKey(k)) { out[`${k}__set`] = Boolean(v.value); out[k] = { value: '', active: v.active }; } else out[k] = v;
  }
  return out;
}

// PUT /api/setup/config over the link: a full replacement of the active settings, with the Pi's rules
function putSetupConfig(st, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'bad body' };
  const incoming = Object.fromEntries(Object.entries(body).filter(([k]) => !k.endsWith('__set')).map(([k, v]) => [k, String(v)]));
  const stored = { ...st.config };
  const next = {};
  // read-only keys are written back as stored; a different value is refused, naming the key
  for (const [k, v] of Object.entries(incoming)) {
    if (SETTABLE.has(k)) continue;
    if (isSecretKey(k) ? v !== '' : v !== (stored[k] ?? '')) return { status: 400, error: `${k} can't be changed over the Sentry Manager link` };
  }
  for (const [k, v] of Object.entries(stored)) if (!SETTABLE.has(k)) next[k] = v;
  const changed = new Set();
  for (const [k, v] of Object.entries(incoming)) {
    if (!SETTABLE.has(k)) continue;
    if (isSecretKey(k)) { next[k] = v === '' ? (stored[k] ?? '') : v; continue; }
    if (v !== (stored[k] ?? null)) changed.add(k);
    next[k] = v;
  }
  for (const k of Object.keys(stored)) if (SETTABLE.has(k) && !(k in incoming)) changed.add(k);
  const missing = secretsNeeded(changed, (sec) => (incoming[sec] ?? '') !== '');
  if (missing.length) return { status: 400, error: `changing ${missing[0][1].join(', ')} needs ${missing[0][0]} sent again` };
  for (const k of Object.keys(st.config)) if (!(k in next)) st.commented[k] = st.config[k];
  for (const k of Object.keys(next)) delete st.commented[k];
  st.config = next;
  st.lastPut = body;
  return null;
}

const DIAGNOSTICS = `====== Sentry USB diagnostics ======
Version: v3.28.10-test.7
Board: Raspberry Pi 4 Model B Rev 1.5
Uptime: 1 day, 2:02

====== df -h ======
Filesystem      Size  Used Avail Use% Mounted on
/dev/mmcblk0p2   29G  6.1G   22G  22% /
/dev/mmcblk0p3  110G   53G   57G  49% /backingfiles

====== archiveloop (last 20) ======
Tue Nov 10 14:02:11 UTC 2026: Archiving 48 clips to nas.local
Tue Nov 10 14:09:47 UTC 2026: Archived 48 clips, verified 48
Capture completed (UTC): 2026-11-10T14:12:00Z
====== end of diagnostics ======
`;

const LOG_LINES = (name) => Array.from({ length: 40 }, (_, i) => `Tue Nov 10 14:${String(i).padStart(2, '0')}:0${i % 10} UTC 2026: ${name}: ${['waiting for archive server', 'archive server reachable', 'snapshot taken', 'copying clips', 'verified clips'][i % 5]} (${i})`).join('\n') + '\n';

/** The Pi's answer to one request: { status, type, body } or { status, type, buf }. */
function answer(st, { method, path, query, body }) {
  const json = (b, status = 200) => ({ status, type: 'application/json', body: b });
  const ok = () => json({ success: true });
  const key = `${method} ${path}`;
  switch (key) {
    case 'GET /api/health': return json({ ok: true });
    case 'GET /api/status': return json(statusBody(st));
    case 'GET /api/system/version': return json({ version: st.version, binary_version: st.version.replace(/^v/, ''), sbc_model: 'Raspberry Pi 4 Model B Rev 1.5', boot_id: 'b7c1e0a2-5f0e-4a61-9d1b-3a0f1c2d4e5f' });
    case 'GET /api/setup/config': return json(setupConfigBody(st));
    case 'PUT /api/setup/config': {
      const refused = putSetupConfig(st, body);
      return refused ? json({ error: refused.error }, refused.status) : ok();
    }
    case 'GET /api/setup/status': return json({ setup_finished: true, setup_running: false, boot_id: 'b7c1e0a2-5f0e-4a61-9d1b-3a0f1c2d4e5f' });
    case 'POST /api/setup/run': st.setupRuns = (st.setupRuns || 0) + 1; return json({ status: 'started' });
    case 'GET /api/setup/phases': return json({ phases: [] });
    case 'POST /api/system/check-update': return json({ current_version: st.version, source_repo: 'Sentry-Six/Sentry-USB', checked_at: new Date().toISOString(), update_available: true, latest_version: 'v3.29.0', release_url: 'https://github.com/Sentry-Six/Sentry-USB/releases/tag/v3.29.0', release_notes: 'Faster archive checks.\nAway Mode fixes.', stable: { version: 'v3.29.0', available: true, release_url: '', release_notes: 'Faster archive checks.' } });
    case 'GET /api/system/update-status': return json(st.updateStatus || { update_available: true, current_version: st.version, latest_version: 'v3.29.0', checked_at: new Date(Date.now() - 3600_000).toISOString() });
    case 'POST /api/system/update':
      if (body && typeof body === 'object' && body.version !== undefined && !(typeof body.version === 'string' && /^[A-Za-z0-9._+-]{1,64}$/.test(body.version) && !body.version.includes('..'))) return json({ error: 'bad version' }, 400);
      st.updates = (st.updates || 0) + 1; st.updateStatus = { status: 'running', update_available: true, latest_version: 'v3.29.0' }; return json({ status: 'started' });
    case 'GET /api/system/check-internet': return json({ connected: true });
    case 'GET /api/system/health-check': return json({ summary: '9 passed, 1 warning', categories: [
      { name: 'Hardware', items: [{ name: 'CPU temperature', status: 'pass', detail: '51.5°C' }, { name: 'Power/throttling', status: 'warn', detail: 'past event: 0x50000' }, { name: 'Binary variant', status: 'pass', detail: 'aarch64-cortex-a72' }] },
      { name: 'Storage', items: [{ name: 'Backing files', status: 'pass', detail: '57 GB free' }, { name: 'Snapshots', status: 'pass', detail: `${st.snapshots.length} snapshots` }] },
      { name: 'Archive', items: [{ name: 'Archive server reachable', status: 'pass', detail: 'nas.local' }, { name: 'Last archive', status: 'pass', detail: '48 clips, verified' }] },
      { name: 'Network', items: [{ name: 'Wi-Fi', status: 'pass', detail: 'HomeNet, -52 dBm' }, { name: 'Internet', status: 'pass' }] }
    ] });
    case 'GET /api/diagnostics': return { status: 200, type: 'text/plain', body: st.diagnosticsRefreshed ? DIAGNOSTICS : 'Diagnostics have not been generated yet.\nClick the Refresh button above to generate a diagnostics report.' };
    case 'POST /api/diagnostics/refresh': st.diagnosticsRefreshed = true; return ok();
    case 'POST /api/diagnostics/download': return { status: 200, type: 'text/plain', buf: Buffer.from(DIAGNOSTICS) };
    case 'POST /api/system/reboot': st.reboots = (st.reboots || 0) + 1; return json({ success: true, message: 'Rebooting...' });
    case 'POST /api/system/shutdown': return json({ success: true, message: 'Shutting down...' });
    case 'POST /api/system/trigger-sync': st.syncs = (st.syncs || 0) + 1; return st.archiving ? json({ error: 'archive cycle is still active' }, 409) : ok();
    case 'POST /api/system/cancel-archive': return st.archiving ? json({ success: true }, 202) : json({ error: 'archive cycle has already ended; refresh status' }, 409);
    case 'POST /api/system/toggle-drives': st.drives = !st.drives; return ok();
    case 'POST /api/system/gadget-enable': st.drives = true; return ok();
    case 'POST /api/system/gadget-disable': st.drives = false; return ok();
    case 'GET /api/snapshots': return json({ snapshots: st.snapshots, verification: true, total_allocated_bytes: 4_900_000_000, sizes_computed_at: now() - 300, sizes_pending: false });
    case 'GET /api/snapshots/live': return json({ car_last_write_ts: now() - 14, next_scheduled_ts: now() + 420, server_ts: now() });
    case 'POST /api/system/backup': st.backups = st.backups || []; st.backups.unshift({ date: '2026-11-10', timestamp: new Date().toISOString(), location: 'archive', size: 18_211, filename: 'sentryusb-backup-2026-11-10.json' }); return json({ success: true, date: '2026-11-10', location: 'archive' });
    case 'GET /api/system/backups': return json(st.backups || [{ date: '2026-11-03', timestamp: '2026-11-03T03:00:00Z', location: 'archive', size: 18_044, filename: 'sentryusb-backup-2026-11-03.json' }, { date: '2026-10-27', timestamp: '2026-10-27T03:00:00Z', location: 'ssd', size: 17_902, filename: 'sentryusb-backup-2026-10-27.json' }]);
    default: break;
  }
  let m = /^\/api\/logs\/([A-Za-z0-9_.-]+)(\/page|\/tail)?$/.exec(path);
  if (method === 'GET' && m) {
    const text = LOG_LINES(m[1]);
    if (!m[2]) return { status: 200, type: 'text/plain', body: text };
    if (m[2] === '/page') return json({ content: text, before: null, has_more: false });
    const q = new URLSearchParams(query || '');
    const first = !q.get('cursor');
    return json({ content: first ? text : `Tue Nov 10 14:59:00 UTC 2026: ${m[1]}: still running\n`, cursor: `c${Date.now()}`, before: 0, reset: false, has_more: false });
  }
  m = /^\/api\/snapshots\/(snap-[0-9]+)$/.exec(path);
  if (method === 'DELETE' && m) {
    const before = st.snapshots.length;
    st.snapshots = st.snapshots.filter((s) => s.id !== m[1]);
    return st.snapshots.length < before ? ok() : json({ error: 'snapshot not found' }, 404);
  }
  return json({ error: 'Not allowed over the Sentry Manager link' }, 403);
}

/** The pair-mode secret as the Pi derives it: P = HMAC(K, "pair-code|" + normalized code). */
async function pairSecret(username, password, code, iterations) {
  const k = await pairingKey(username, password, iterations);
  // a code the Pi would refuse ("That isn't a valid pairing code") still gives a (wrong) secret here, for tests
  return pairCodeSecret(k, normalizePairingCode(code) || String(code ?? ''));
}

/**
 * Connects once. Options: port, host, id, mode ('pair'|'key'), username,
 * password, code (the pairing code Manager shows, pair mode), key (hex), pin (fingerprint hex the Pi saved), name (its host name), answer (override),
 * state, status (send a status push after ok, default true),
 * tamper: { fp, proof, v, nonce, secret, frameFirst } for tests.
 */
function connectFakePi(o = {}) {
  const st = o.state || fakeState();
  const id = o.id || '0123456789abcdef0123456789abcdef'; // the Pi's ids: 32 lowercase hex
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: o.host || '127.0.0.1', port: o.port, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    const out = { result: null, why: null, linkKey: null, fp: null, state: st, requests: [], ws: null, statusSent: 0 };
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    sock.once('error', (err) => { if (!settled) { settled = true; reject(err); } });
    sock.once('secureConnect', () => {
      out.fp = fpHex(sock.getPeerCertificate().fingerprint256);
      if (o.pin && o.pin !== out.fp) { out.result = 'pin mismatch'; sock.destroy(); return done(out); }
      const wsKey = crypto.randomBytes(16).toString('base64');
      sock.write(`GET ${o.path || '/api/sentryusb/link'} HTTP/1.1\r\nHost: ${o.host || '127.0.0.1'}:${o.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      let head = Buffer.alloc(0);
      const onHead = (c) => {
        head = Buffer.concat([head, c]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        sock.off('data', onHead);
        const lines = head.subarray(0, end).toString('latin1');
        out.httpStatus = Number(lines.split(' ')[1]);
        if (out.httpStatus !== 101) { out.result = 'refused'; sock.destroy(); return done(out); }
        const ws = new WsConnection(sock, { role: 'client', maxMessage: 4 * MIB, head: head.subarray(end + 4) });
        out.ws = ws;
        out.close = () => ws.close(1000, 'bye');
        out.send = (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
        out.pushStatus = () => { out.statusSent++; ws.send(JSON.stringify({ t: 'status', body: statusBody(st) })); };
        ws.on('close', (code) => { out.closedCode = code; if (!out.result) { out.result = 'closed'; done(out); } o.onClose?.(code); });
        let secret = null;
        let mNonce = null;
        const piNonce = crypto.randomBytes(32).toString('hex');
        ws.on('message', async (text) => {
          const m = JSON.parse(text);
          if (m.t === 'hello') {
            out.hello = m;
            mNonce = m.nonce;
            // as the Pi: a Manager on another protocol version is told so
            if (m.v !== V) { out.result = 'denied by pi'; out.why = 'version'; ws.send(JSON.stringify({ t: 'denied', why: 'version' })); ws.close(1008, 'denied'); return done(out); }
            if (o.tamper?.frameFirst) return ws.send(JSON.stringify({ t: 'status', body: {} }));
            secret = o.tamper?.secret ? o.tamper.secret : o.mode === 'key' ? Buffer.from(o.key, 'hex') : await pairSecret(o.username, o.password, o.code, o.iterations);
            const fp = o.tamper?.fp || out.fp; // the fingerprint the Pi saw
            const auth = { t: 'auth', v: o.tamper?.v ?? V, id, mode: o.mode || 'pair', nonce: o.tamper?.nonce || piNonce, name: o.name || 'sentryusb-model3', version: st.version, proof: o.tamper?.proof || piProof(secret, mNonce, piNonce, fp, id) };
            out.auth = auth;
            return ws.send(JSON.stringify(auth));
          }
          if (m.t === 'denied') { out.result = 'denied'; out.why = m.why; return done(out); }
          if (m.t === 'ok') {
            if (!sameHex(m.proof, managerProof(secret, mNonce, piNonce, out.fp, id))) { out.result = 'bad manager proof'; ws.close(1008, 'proof'); return done(out); }
            out.result = 'ok';
            out.linkKey = m.linkKey || o.key || null;
            // right after the handshake: the network it is on (6b), then anything it has to report
            if (o.net !== false) ws.send(JSON.stringify({ t: 'net', ssid: 'HomeNet', iface: 'wlan0', ip: '192.168.1.57', gw: '192.168.1.1', ...(o.net || {}) }));
            for (const a of o.alerts || []) ws.send(JSON.stringify({ t: 'alert', ...a }));
            if (o.status !== false) out.pushStatus();
            return done(out);
          }
          if (m.t === 'req') {
            out.requests.push(m);
            if (o.onRequest && (await o.onRequest(m, out)) === false) return undefined;
            const a = (o.answer && o.answer(m, st)) || answer(st, m);
            if (!a) return undefined;
            return sendAnswer(ws, m.id, a);
          }
          return undefined;
        });
        return undefined;
      };
      sock.on('data', onHead);
    });
  });
}

/** An answer as the Pi sends it: inline, base64, or in 1 MiB chunks. */
function sendAnswer(ws, id, a) {
  // the Pi sends JSON as body, anything else (logs, diagnostics) as bodyB64; an empty answer has body null
  const buf = a.buf || (a.type !== 'application/json' && typeof a.body === 'string' ? Buffer.from(a.body, 'utf8') : null);
  if (!buf) return ws.send(JSON.stringify({ t: 'res', id, status: a.status, type: a.type, body: a.body }));
  if (buf.length <= MIB) return ws.send(JSON.stringify({ t: 'res', id, status: a.status, type: a.type, bodyB64: buf.toString('base64') }));
  ws.send(JSON.stringify({ t: 'res', id, status: a.status, type: a.type, chunked: true }));
  for (let seq = 0, off = 0; off < buf.length; seq++, off += MIB) ws.send(JSON.stringify({ t: 'chunk', id, seq, data: buf.subarray(off, off + MIB).toString('base64') }));
  return ws.send(JSON.stringify({ t: 'end', id }));
}

module.exports = { connectFakePi, pairSecret, fakeState, answer, statusBody, sendAnswer };

// ---- from a shell: pair once (or use the saved key) and stay connected, pushing status
if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
  const port = Number(arg('port', '10000'));
  const file = arg('state', null);
  const saved = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const st = fakeState();
  const id = arg('id', saved.id || crypto.randomBytes(16).toString('hex'));
  let delay = 1000;
  const loop = async () => {
    try {
      // an alert is sent once, on the first good connection (the Pi clears it after sending)
      const alerts = arg('alert', null) && !loop.alerted ? [{ kind: 'fingerprint', seen: crypto.createHash('sha256').update('another certificate').digest('hex'), at: Math.floor(Date.now() / 1000) - 3600 }] : [];
      loop.alerted = true;
      const pi = await connectFakePi({ port, host: arg('host', '127.0.0.1'), id, state: st, alerts, net: arg('ssid', null) ? { ssid: arg('ssid'), gw: arg('gw', '10.0.0.1') } : undefined, ...(saved.key ? { mode: 'key', key: saved.key, pin: saved.fp } : { mode: 'pair', username: arg('user', 'pi'), password: arg('password', 'raspberry'), code: arg('code', '') }), onClose: () => setTimeout(loop, delay) });
      console.log(`fake Pi ${id}: ${pi.result}${pi.why ? ` (${pi.why})` : ''}`);
      if (pi.result === 'ok') {
        delay = 1000;
        if (pi.linkKey && pi.linkKey !== saved.key) { Object.assign(saved, { id, key: pi.linkKey, fp: pi.fp }); if (file) fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 }); }
        const t = setInterval(() => (pi.ws.closed ? clearInterval(t) : pi.pushStatus()), 30_000);
      } else delay = Math.min(delay * 2, 30_000);
      if (pi.result !== 'ok' && pi.result !== 'closed' && !pi.ws) setTimeout(loop, delay);
    } catch (err) {
      console.log(`fake Pi: ${err.message}`);
      setTimeout(loop, delay);
      delay = Math.min(delay * 2, 30_000);
    }
  };
  loop();
}
