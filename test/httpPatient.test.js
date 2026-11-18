'use strict';

// A JSON answer that takes longer than the server's idle cut (the encoder
// benchmark): sendJsonPatiently keeps the connection busy, so the answer
// arrives; a plain answer that slow is cut off.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { sendJson, sendJsonPatiently } = require('../server/http');

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.setTimeout(300); // as index.js does with 2 minutes: an idle connection is closed
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function ask(srv) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', path: '/' }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text }));
      res.on('error', (err) => resolve({ error: err.message }));
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.end();
  });
}

const slow = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));

test('an answer slower than the idle cut arrives whole, and parses as JSON', async () => {
  const srv = await serve((req, res) => { sendJsonPatiently(res, () => slow(1200, { ok: true, value: { best: 6 } }), { beatMs: 100 }); });
  try {
    const got = await ask(srv);
    assert.equal(got.status, 200);
    assert.match(got.type, /application\/json/);
    assert.deepEqual(JSON.parse(got.text), { ok: true, value: { best: 6 } });
    assert.ok(/^ +\{/.test(got.text), 'spaces first, then the JSON');
  } finally { srv.close(); }
});

test('without it, the same slow answer is cut off (what the benchmark hit at 2 minutes)', async () => {
  const srv = await serve(async (req, res) => { const out = await slow(1200, { ok: true }); if (!res.destroyed) sendJson(res, 200, out); });
  try {
    const got = await ask(srv);
    assert.ok(got.error, `cut off: ${JSON.stringify(got)}`);
  } finally { srv.close(); }
});

test('a failing job still ends the answer with JSON', async () => {
  const srv = await serve((req, res) => { sendJsonPatiently(res, async () => { await slow(50); throw Object.assign(new Error('x'), { code: 'BENCHMARK_FAILED' }); }, { beatMs: 20 }); });
  try {
    const got = await ask(srv);
    assert.deepEqual(JSON.parse(got.text), { ok: false, error: { code: 'BENCHMARK_FAILED' } });
  } finally { srv.close(); }
});
