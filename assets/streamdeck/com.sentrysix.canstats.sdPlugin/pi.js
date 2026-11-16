// The key's settings: its stat (this key), and the server, token, units, car and
// how often to ask (every key: global settings). The link pasted from the
// Nerd panel gives the server and the token.
/* global CAN_STATS */
let ws = null;
let uuid = null;
let action = null;
let global = {};
const $ = (id) => document.getElementById(id);
const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

for (const [id, label] of CAN_STATS) $('stat').add(new Option(label, id));

/** { server, token } from a link like https://host:9000/api/can/now/battery?token=… */
function fromLink(text) {
  try {
    const u = new URL(String(text).trim());
    const token = u.searchParams.get('token');
    if (!token) return null;
    return { server: u.origin, token };
  } catch { return null; }
}
function show() {
  $('units').value = global.units === 'km' ? 'km' : 'mi';
  $('every').value = global.every || 5;
  $('car').value = global.car || '';
  if (global.server && global.token && !$('link').value) $('link').value = `${global.server}/api/can/now?token=${global.token}`;
  $('saved').textContent = global.server && global.token ? `Connected to ${global.server}.` : 'Not set up yet: paste the link.';
}
function saveGlobal() {
  const got = fromLink($('link').value);
  global = { ...global, ...(got || {}), units: $('units').value, every: Math.max(2, Math.min(300, Number($('every').value) || 5)), car: $('car').value.trim() };
  if (!got && $('link').value.trim()) $('saved').textContent = 'That link has no token: copy the whole link from the Nerd panel.';
  send({ event: 'setGlobalSettings', context: uuid, payload: global });
  show();
}

// eslint-disable-next-line no-unused-vars
function connectElgatoStreamDeckSocket(port, inUUID, registerEvent, info, actionInfo) {
  uuid = inUUID;
  try { action = JSON.parse(actionInfo); } catch { action = null; }
  $('stat').value = action?.payload?.settings?.stat || 'battery';
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.onopen = () => {
    send({ event: registerEvent, uuid });
    send({ event: 'getGlobalSettings', context: uuid });
    // a new key: its stat saved at once, so the key shows it
    send({ event: 'setSettings', context: uuid, payload: { stat: $('stat').value } });
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.event === 'didReceiveGlobalSettings') { global = m.payload?.settings || {}; show(); }
  };
}
window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;

$('stat').addEventListener('change', () => send({ event: 'setSettings', context: uuid, payload: { stat: $('stat').value } }));
for (const id of ['link', 'units', 'every', 'car']) $(id).addEventListener('change', saveGlobal);
