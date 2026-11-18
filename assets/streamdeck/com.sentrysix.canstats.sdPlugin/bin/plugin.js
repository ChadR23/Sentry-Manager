'use strict';

// Sentry Six CAN Stats, a Stream Deck plugin run by Stream Deck's own Node.js:
// each key shows one of the car's newest CAN values from Sentry Six Manager
// (GET /api/can/now?token=…, docs/can-bridge-api.md, "Live stats for a Stream
// Deck"). The link, units, car and how often to ask are shared by every key
// (global settings); each key picks its stat. One request for all keys, every
// few seconds while any key is on the deck; a key press asks again at once.
//
// Node, not Stream Deck's browser, so it can trust Sentry Six Manager's own
// certificate without installing it: the link carries a pin (pin=ca:<sha256>
// for the server's local certificate authority, pin=cert:<sha256> for its own
// certificate). The authority's certificate is fetched once (it is public, no
// token) and kept only when its fingerprint is the pin; every connection's
// certificate is then checked against it before the token is sent. Without a
// pin (a certificate the computer already trusts): the usual checks.
//
// No packages: Stream Deck's socket is spoken here (a WebSocket client in a
// few lines), and the requests use node:https.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { CAN_STATS } = require('../stats.js');

const LABEL = Object.fromEntries(CAN_STATS);
const arg = (name) => { const i = process.argv.indexOf(`-${name}`); return i >= 0 ? process.argv[i + 1] : null; };

// ---- Stream Deck's socket (ws://127.0.0.1:<port>): a minimal WebSocket client
function streamDeckSocket(port, { onOpen, onMessage, onClose }) {
  const sock = net.connect(Number(port), '127.0.0.1', () => {
    const key = crypto.randomBytes(16).toString('base64');
    sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  let buf = Buffer.alloc(0);
  let open = false;
  let parts = [];
  const frame = (op, data) => {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const mask = crypto.randomBytes(4);
    let head;
    if (body.length < 126) head = Buffer.from([0x80 | op, 0x80 | body.length]);
    else if (body.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(body.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
    const masked = Buffer.from(body);
    for (let k = 0; k < masked.length; k++) masked[k] ^= mask[k & 3];
    sock.write(Buffer.concat([head, mask, masked]));
  };
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!open) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      if (!/^HTTP\/1\.1 101/.test(buf.subarray(0, end).toString('latin1'))) { sock.destroy(); return; }
      buf = buf.subarray(end + 4);
      open = true;
      onOpen();
    }
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 127;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      let mask = null;
      if (buf[1] & 128) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4; }
      if (buf.length < off + len) return;
      let payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let k = 0; k < payload.length; k++) payload[k] ^= mask[k & 3];
      const fin = buf[0] & 128;
      const op = buf[0] & 15;
      buf = buf.subarray(off + len);
      if (op === 8) { sock.end(); return; }
      if (op === 9) { frame(10, payload); continue; }
      if (op === 1 || op === 0) {
        parts.push(payload);
        if (fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; try { onMessage(JSON.parse(text)); } catch { /* not ours */ } }
      }
    }
  });
  sock.on('close', () => onClose());
  sock.on('error', () => {});
  return { send: (o) => { if (open) frame(1, JSON.stringify(o)); } };
}

// ---- the request, with the pin
const norm = (fp) => String(fp || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
/** { kind: 'ca' | 'cert', fp } from the link's pin, or null. */
function pinOf(text) {
  const m = /^(ca|cert):([0-9a-f]{64})$/i.exec(String(text || '').trim());
  return m ? { kind: m[1].toLowerCase(), fp: m[2].toLowerCase() } : null;
}
const caCache = new Map(); // `${origin}|${fp}` -> X509Certificate

/** A TLS socket to the server whose certificate is not checked yet. */
function rawTls(u) {
  return new Promise((resolve, reject) => {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const s = tls.connect({ host, port: Number(u.port) || 443, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    s.setTimeout(8000, () => s.destroy(new Error('timeout')));
    s.once('secureConnect', () => resolve(s));
    s.once('error', reject);
  });
}
/** GET over an already open (and checked) TLS connection: { status, body }. Written by hand: node's
 * clients would check the certificate again, by the computer's own list, and refuse the server's own. */
function getOver(u, path, socket, headers = {}) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const done = () => {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return reject(new Error('no answer'));
      const head = buf.subarray(0, end).toString('latin1');
      const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(head) || [])[1]);
      let body = buf.subarray(end + 4);
      if (/\r\ntransfer-encoding:\s*chunked/i.test(head)) {
        const parts = [];
        let i = 0;
        for (;;) {
          const nl = body.indexOf('\r\n', i);
          if (nl < 0) break;
          const n = parseInt(body.subarray(i, nl).toString('latin1'), 16);
          if (!n) break;
          parts.push(body.subarray(nl + 2, nl + 2 + n));
          i = nl + 2 + n + 2;
        }
        body = Buffer.concat(parts);
      }
      resolve({ status, body: body.toString('utf8') });
    };
    socket.setTimeout(8000, () => socket.destroy(new Error('timeout')));
    socket.on('data', (d) => { buf = Buffer.concat([buf, d]); if (buf.length > 2_000_000) socket.destroy(new Error('too big')); });
    socket.on('end', done);
    socket.on('error', reject);
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${u.host}\r\nAccept: */*\r\nConnection: close\r\n${extra}\r\n`);
  });
}
async function pinnedCa(u, pin) {
  const id = `${u.origin}|${pin.fp}`;
  if (caCache.has(id)) return caCache.get(id);
  // the authority's certificate: public (no token goes out), kept only when it is the pinned one
  const s = await rawTls(u);
  const r = await getOver(u, '/api/can/now/ca.crt', s);
  if (r.status !== 200) throw Object.assign(new Error('no certificate'), { short: 'cert?' });
  const ca = new crypto.X509Certificate(r.body);
  if (norm(ca.fingerprint256) !== pin.fp) throw Object.assign(new Error('not the pinned authority'), { short: 'cert changed' });
  caCache.set(id, ca);
  return ca;
}
/** A connection whose certificate is the pinned one (or signed by the pinned authority), else an error. */
async function pinnedSocket(u, pin) {
  const ca = pin.kind === 'ca' ? await pinnedCa(u, pin) : null;
  const s = await rawTls(u);
  const raw = s.getPeerCertificate()?.raw;
  let ok = false;
  if (raw) {
    const leaf = new crypto.X509Certificate(raw);
    if (pin.kind === 'cert') ok = norm(leaf.fingerprint256) === pin.fp;
    else {
      const now = Date.now();
      ok = leaf.checkIssued(ca) && leaf.verify(ca.publicKey) && Date.parse(leaf.validFrom) <= now && now <= Date.parse(leaf.validTo);
    }
  }
  if (!ok) { s.destroy(); throw Object.assign(new Error('certificate'), { short: 'cert changed' }); }
  return s;
}
/** GET the link's JSON: { data } or { error: a short reason for the key }. */
async function fetchNow(cfg) {
  let u;
  try { u = new URL(String(cfg.server || '').trim()); } catch { return { error: 'bad link' }; }
  const q = new URLSearchParams({ token: cfg.token, units: cfg.units === 'km' ? 'km' : 'mi' });
  if (cfg.car) q.set('car', cfg.car);
  const path = `${u.pathname.replace(/\/+$/, '')}/api/can/now?${q}`;
  try {
    let r;
    const pin = pinOf(cfg.pin);
    if (u.protocol === 'https:' && pin) r = await getOver(u, path, await pinnedSocket(u, pin));
    else {
      r = await new Promise((resolve, reject) => {
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.request(new URL(path, u.origin), { method: 'GET', headers: { Accept: 'application/json' } }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.setTimeout(8000, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
      });
    }
    if (r.status === 401) return { error: 'link token?' };
    if (r.status === 404) return { error: 'link off?' };
    if (r.status !== 200) return { error: `HTTP ${r.status}` };
    return { data: JSON.parse(r.body) };
  } catch (err) {
    return { error: err.short || (/certificate|self[- ]signed|CERT|VERIFY|SIGNATURE/i.test(String(err.code || err.message)) ? 'cert?' : 'can\'t reach') };
  }
}

// ---- the keys
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function age(sec) {
  if (sec == null) return '';
  if (sec < 90) return 'now';
  if (sec < 5400) return `${Math.round(sec / 60)} min ago`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} d ago`;
}
/** The key's picture: the stat's name, its value big, its unit and age small. */
function picture({ title, value, unit, foot, dim, warn }) {
  const v = String(value);
  const size = v.length <= 3 ? 56 : v.length <= 5 ? 44 : v.length <= 7 ? 34 : 26;
  const color = warn ? '#ffb020' : dim ? '#7b8794' : '#f2f5f7';
  const font = 'Segoe UI, Helvetica, Arial, sans-serif';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" rx="18" fill="#0d1210"/>
    <rect x="3" y="3" width="138" height="138" rx="16" fill="none" stroke="${dim ? '#2a332f' : '#1f6b45'}" stroke-width="2"/>
    <text x="72" y="30" text-anchor="middle" font-family="${font}" font-size="${title.length > 15 ? 13 : title.length > 12 ? 15 : 17}" fill="#5fd38d">${esc(title)}</text>
    <text x="72" y="${unit ? 86 : 92}" text-anchor="middle" font-family="${font}" font-weight="700" font-size="${size}" fill="${color}">${esc(v)}</text>
    ${unit ? `<text x="72" y="110" text-anchor="middle" font-family="${font}" font-size="17" fill="#b7c2cc">${esc(unit)}</text>` : ''}
    <text x="72" y="133" text-anchor="middle" font-family="${font}" font-size="13" fill="#7b8794">${esc(foot)}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

function createPlugin({ send, fetch = fetchNow, setTimer = setInterval, clearTimer = clearInterval }) {
  const DEFAULTS = { server: '', token: '', pin: '', units: 'mi', car: '', every: 5 };
  let cfg = { ...DEFAULTS };
  const keys = new Map(); // context -> { stat }
  let last = null; // { data } | { error }
  let timer = null;
  let asking = null;
  let gen = 0; // the settings' version: an answer to older ones is not shown, and asked again

  function draw(context) {
    const k = keys.get(context);
    if (!k) return;
    const stat = k.stat || 'battery';
    const title = (LABEL[stat] || stat).replace(/ temp$/, '');
    let image;
    if (!cfg.server || !cfg.token) image = picture({ title, value: 'Set up', unit: '', foot: 'open this key', warn: true });
    else if (!last) image = picture({ title, value: '…', unit: '', foot: '', dim: true });
    else if (last.error) image = picture({ title, value: '!', unit: '', foot: last.error, warn: true });
    else {
      const s = last.data.stats?.[stat];
      if (!s) image = picture({ title, value: '—', unit: '', foot: last.data.at ? 'no value' : 'no CAN data yet', dim: true });
      else {
        const num = typeof s.value === 'number';
        const value = num && s.unit && s.unit !== '%' ? s.text.slice(0, s.text.length - s.unit.length).trim() : s.text;
        image = picture({ title, value, unit: num && s.unit !== '%' ? s.unit : '', foot: age(last.data.ageSec), dim: last.data.stale });
      }
    }
    send({ event: 'setImage', context, payload: { image, target: 0 } });
  }
  const drawAll = () => { for (const c of keys.keys()) draw(c); };
  function ask() {
    if (asking || !cfg.server || !cfg.token || !keys.size) return asking;
    const mine = gen;
    asking = fetch(cfg).then((r) => r).catch(() => ({ error: 'can\'t reach' })).then((r) => {
      asking = null;
      if (mine !== gen) return ask(); // the link changed meanwhile: ask with the new one
      last = r;
      drawAll();
      return undefined;
    });
    return asking;
  }
  function schedule() {
    if (timer) clearTimer(timer);
    timer = null;
    if (!keys.size) return;
    timer = setTimer(ask, Math.max(2, Math.min(300, Number(cfg.every) || 5)) * 1000);
    ask();
  }
  function onMessage(m) {
    const { event, context, payload } = m || {};
    if (event === 'didReceiveGlobalSettings') {
      // (the whole settings each time: what is left out is not kept from before, a pin least of all)
      cfg = { ...DEFAULTS, ...(payload?.settings || {}) };
      gen++;
      last = null;
      drawAll();
      schedule();
    } else if (event === 'willAppear') {
      keys.set(context, { stat: payload?.settings?.stat || 'battery' });
      draw(context);
      if (keys.size === 1) schedule(); else ask();
    } else if (event === 'willDisappear') {
      keys.delete(context);
      if (!keys.size) schedule();
    } else if (event === 'didReceiveSettings') {
      keys.set(context, { stat: payload?.settings?.stat || 'battery' });
      draw(context);
    } else if (event === 'keyDown') {
      ask();
    }
  }
  return { onMessage, ask, stop: () => { if (timer) clearTimer(timer); } };
}

if (require.main === module) {
  const port = arg('port');
  const uuid = arg('pluginUUID');
  const registerEvent = arg('registerEvent');
  let plugin = null;
  const sd = streamDeckSocket(port, {
    onOpen: () => {
      sd.send({ event: registerEvent, uuid });
      sd.send({ event: 'getGlobalSettings', context: uuid });
    },
    onMessage: (m) => plugin.onMessage(m),
    onClose: () => process.exit(0)
  });
  plugin = createPlugin({ send: sd.send });
}

module.exports = { createPlugin, fetchNow, pinOf, picture, streamDeckSocket };
