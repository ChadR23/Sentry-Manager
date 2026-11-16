// Sentry Six CAN Stats: each key shows one of the car's newest CAN values from
// Sentry Six Manager (GET /api/can/now?token=…, docs/can-bridge-api.md, "Live
// stats for a Stream Deck"). The server address, the link's token, the units,
// the car and how often to ask are shared by every key (global settings); each
// key picks its stat. One request for all keys, every few seconds while any
// key is on the deck; a key press asks again at once.

/* global CAN_STATS */
let ws = null;
let pluginUUID = null;
let global = { server: '', token: '', units: 'mi', car: '', every: 5 };
const keys = new Map(); // context -> { stat }
let last = null; // { ok, data, error, at }
let timer = null;
let asking = false;

const LABEL = Object.fromEntries(CAN_STATS);
const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// "12 min ago", "3 h ago"
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
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" rx="18" fill="#0d1210"/>
    <rect x="3" y="3" width="138" height="138" rx="16" fill="none" stroke="${dim ? '#2a332f' : '#1f6b45'}" stroke-width="2"/>
    <text x="72" y="30" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${title.length > 15 ? 13 : title.length > 12 ? 15 : 17}" fill="#5fd38d">${esc(title)}</text>
    <text x="72" y="${unit ? 86 : 92}" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-weight="700" font-size="${size}" fill="${color}">${esc(v)}</text>
    ${unit ? `<text x="72" y="110" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="17" fill="#b7c2cc">${esc(unit)}</text>` : ''}
    <text x="72" y="133" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="13" fill="#7b8794">${esc(foot)}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

function draw(context) {
  const k = keys.get(context);
  if (!k) return;
  const stat = k.stat || 'battery';
  const title = (LABEL[stat] || stat).replace(/ temp$/, '');
  let image;
  if (!global.server || !global.token) image = picture({ title, value: 'Set up', unit: '', foot: 'open this key', warn: true });
  else if (!last) image = picture({ title, value: '…', unit: '', foot: '', dim: true });
  else if (!last.ok) image = picture({ title, value: '!', unit: '', foot: last.error, warn: true });
  else {
    const s = last.data.stats?.[stat];
    if (!s) image = picture({ title, value: '—', unit: '', foot: last.data.at ? 'no value' : 'no CAN data yet', dim: true });
    else {
      const num = typeof s.value === 'number';
      // "78%" stays one piece; "62 mph": the number big, the unit under it
      const value = num && s.unit && s.unit !== '%' ? s.text.slice(0, s.text.length - s.unit.length).trim() : s.text;
      image = picture({ title, value, unit: num && s.unit !== '%' ? s.unit : '', foot: age(last.data.ageSec), dim: last.data.stale });
    }
  }
  send({ event: 'setImage', context, payload: { image, target: 0 } });
}
const drawAll = () => { for (const c of keys.keys()) draw(c); };

async function ask() {
  if (asking || !global.server || !global.token || !keys.size) return;
  asking = true;
  try {
    const base = String(global.server).trim().replace(/\/+$/, '');
    const q = new URLSearchParams({ token: global.token, units: global.units === 'km' ? 'km' : 'mi' });
    if (global.car) q.set('car', global.car);
    const ctl = new AbortController();
    const stop = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`${base}/api/can/now?${q}`, { cache: 'no-store', signal: ctl.signal }).finally(() => clearTimeout(stop));
    if (r.status === 401) last = { ok: false, error: 'link token?' };
    else if (r.status === 404) last = { ok: false, error: 'link off?' };
    else if (!r.ok) last = { ok: false, error: `HTTP ${r.status}` };
    else last = { ok: true, data: await r.json() };
  } catch {
    // (a certificate this computer does not trust ends here too)
    last = { ok: false, error: 'can\'t reach' };
  } finally {
    asking = false;
    drawAll();
  }
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (!keys.size) return;
  const every = Math.max(2, Math.min(300, Number(global.every) || 5));
  timer = setInterval(ask, every * 1000);
  ask();
}

// Stream Deck calls this when it loads the plugin
// eslint-disable-next-line no-unused-vars
function connectElgatoStreamDeckSocket(port, uuid, registerEvent) {
  pluginUUID = uuid;
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.onopen = () => {
    send({ event: registerEvent, uuid });
    send({ event: 'getGlobalSettings', context: uuid });
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    const { event, context, payload } = m;
    if (event === 'didReceiveGlobalSettings') {
      global = { ...global, ...(payload?.settings || {}) };
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
  };
  ws.onclose = () => { clearInterval(timer); };
}
window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
window.__pluginUUID = () => pluginUUID;
