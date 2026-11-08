'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const { createCanPort } = require('../server/canPort');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const quiet = { info() {}, warn() {} };
const reachable = (port) => new Promise((resolve) => {
  const c = net.connect(port, '127.0.0.1', () => { c.destroy(); resolve(true); });
  c.on('error', () => resolve(false));
});

// make() waits like loading the certificate does, so the calls overlap
async function slowPort() {
  const port = await freePort();
  const made = [];
  const canPort = createCanPort({
    port, host: '127.0.0.1', log: quiet,
    make: async () => {
      await new Promise((r) => setTimeout(r, 30));
      const srv = http.createServer((req, res) => res.end('ok'));
      made.push(srv);
      return srv;
    }
  });
  const listening = () => made.filter((s) => s.listening).length;
  return { port, canPort, made, listening };
}

test('CAN port: two enables at once open one listener, which a disable then closes', async () => {
  const { port, canPort, listening } = await slowPort();
  await Promise.all([canPort.set(true), canPort.set(true)]);
  assert.equal(listening(), 1);
  assert.deepEqual([canPort.state().listening, canPort.state().error], [true, null], 'not "used by something else"');
  await canPort.set(false);
  assert.equal(listening(), 0);
  assert.equal(await reachable(port), false, 'nothing left listening');
});

test('CAN port: a disable while an enable waits for the certificate leaves it closed', async () => {
  const { port, canPort, listening } = await slowPort();
  const on = canPort.set(true);
  await canPort.set(false);
  await on;
  assert.equal(listening(), 0);
  assert.equal(canPort.state().listening, false);
  assert.equal(await reachable(port), false);
});

test('CAN port: many calls at once end as the last one said', async () => {
  const { port, canPort, listening } = await slowPort();
  for (const seq of [[true, false, true, true, false, true], [false, true, false, true, false], [true, true, false, false, true]]) {
    await Promise.all(seq.map((on) => canPort.set(on)));
    const last = seq[seq.length - 1];
    assert.equal(listening(), last ? 1 : 0, `after ${seq.join(',')}`);
    assert.equal(canPort.state().listening, last);
    assert.equal(canPort.state().error, null);
    assert.equal(await reachable(port), last);
  }
  await canPort.set(false);
});

test('CAN port: a port used by something else is reported, and a later enable can open it', async () => {
  const { port, canPort, listening } = await slowPort();
  const other = net.createServer().listen(port, '127.0.0.1');
  await new Promise((r) => other.once('listening', r));
  await canPort.set(true);
  assert.match(canPort.state().error, /used by something else/);
  assert.equal(canPort.server(), null);
  await new Promise((r) => other.close(r));
  await canPort.set(true);
  assert.equal(listening(), 1);
  assert.equal(canPort.state().listening, true);
  await canPort.set(false);
});
