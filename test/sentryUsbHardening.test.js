'use strict';

// Hardening of the Sentry USB link against a stranger on the device port and
// against a Pi that holds a valid link key but misbehaves.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { WsConnection, encodeFrame, MAX_PARTS } = require('../server/wsFrames');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await wait(20); }
};

// a server-side WsConnection on one end of a local TCP pair, the raw client socket on the other
function pair() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      const ws = new WsConnection(sock, { role: 'server', maxMessage: 16 * 1024 });
      resolve({ ws, client, close: () => { client.destroy(); sock.destroy(); srv.close(); } });
    });
    let client = null;
    srv.listen(0, '127.0.0.1', () => { client = net.connect(srv.address().port, '127.0.0.1'); });
  });
}

test('WebSocket: a message in endless empty fragments is refused (1009), not piled up', async () => {
  const p = await pair();
  try {
    let code = null;
    p.ws.on('close', (c) => { code = c; });
    const start = encodeFrame(0x1, '', true);
    start[0] = 0x01; // text, not FIN
    const cont = encodeFrame(0x0, '', true);
    cont[0] = 0x00; // continuation, not FIN
    p.client.write(Buffer.concat([start, ...Array.from({ length: MAX_PARTS + 50 }, () => cont)]));
    await until(() => code !== null);
    assert.equal(code, 1009);
  } finally { p.close(); }
});

test('WebSocket: a peer that floods pings and never reads is dropped once its unsent pongs pile up', async () => {
  const p = await pair();
  try {
    let closed = false;
    p.ws.on('close', () => { closed = true; });
    p.client.pause(); // never reads
    const ping = encodeFrame(0x9, Buffer.alloc(125, 1), true);
    const burst = Buffer.concat(Array.from({ length: 2000 }, () => ping));
    for (let i = 0; i < 200 && !closed; i++) {
      p.client.write(burst);
      await wait(5);
    }
    await until(() => closed);
    assert.equal(closed, true);
  } finally { p.close(); }
});
