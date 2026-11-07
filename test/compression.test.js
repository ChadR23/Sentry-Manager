'use strict';

// Static files carry an ETag (a revisit gets 304, not the file again) and
// text goes compressed (brotli or gzip, from a cached copy); JSON over 1 KB
// goes gzipped. Before, every page load downloaded every script in full.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { serveFile, sendJson } = require('../server/http');

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` }));
  });
}
const get = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

test('a static file: compressed for a browser that accepts it, an ETag, and 304 when unchanged', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-static-'));
  const js = 'const x = 1;\n'.repeat(500);
  await fsp.writeFile(path.join(dir, 'app.js'), js);
  await fsp.writeFile(path.join(dir, 'tiny.js'), 'x');
  await fsp.writeFile(path.join(dir, 'pic.png'), Buffer.alloc(5000, 1));
  const { s, base } = await server((req, res) => serveFile(req, res, dir, req.url.slice(1)).then((ok) => { if (!ok) { res.writeHead(404); res.end(); } }));
  try {
    const br = await get(`${base}/app.js`, { 'Accept-Encoding': 'gzip, deflate, br' });
    assert.equal(br.status, 200);
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(zlib.brotliDecompressSync(br.body).toString(), js);
    assert.ok(br.body.length < js.length / 10, 'much smaller');
    assert.match(br.headers.etag, /^W\/".+"$/);
    assert.equal(br.headers.vary, 'Accept-Encoding');
    const gz = await get(`${base}/app.js`, { 'Accept-Encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(gz.body).toString(), js);
    const plain = await get(`${base}/app.js`);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body.toString(), js);
    // the browser asks again with its ETag: 304, no body
    const again = await get(`${base}/app.js`, { 'If-None-Match': br.headers.etag, 'Accept-Encoding': 'br' });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    // a changed file: a new ETag, the new content
    await fsp.writeFile(path.join(dir, 'app.js'), `${js}// changed\n`);
    const changed = await get(`${base}/app.js`, { 'If-None-Match': br.headers.etag, 'Accept-Encoding': 'br' });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.etag, br.headers.etag);
    assert.match(zlib.brotliDecompressSync(changed.body).toString(), /changed/);
    // small text and images are sent as they are (with an ETag)
    assert.equal((await get(`${base}/tiny.js`, { 'Accept-Encoding': 'br' })).headers['content-encoding'], undefined);
    const png = await get(`${base}/pic.png`, { 'Accept-Encoding': 'br' });
    assert.equal(png.headers['content-encoding'], undefined);
    assert.ok(png.headers.etag);
  } finally {
    s.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('JSON over 1 KB goes gzipped when accepted; small JSON as it is', async () => {
  const big = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `recording ${i}` })) };
  const { s, base } = await server((req, res) => sendJson(res, 200, req.url === '/big' ? big : { ok: true }));
  try {
    const r = await get(`${base}/big`, { 'Accept-Encoding': 'gzip, br' });
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.deepEqual(JSON.parse(zlib.gunzipSync(r.body)), big);
    assert.equal(r.headers['cache-control'], 'no-store');
    const plain = await get(`${base}/big`);
    assert.deepEqual(JSON.parse(plain.body), big);
    const small = await get(`${base}/small`, { 'Accept-Encoding': 'gzip' });
    assert.equal(small.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(small.body), { ok: true });
  } finally {
    s.close();
  }
});

test('a finished job\'s summary is saved beside it and read back after a restart instead of the job', async () => {
  const { createHarness, CPU } = require('./fixtures/lanesHarness');
  const h = createHarness({ clips: 2, devices: [CPU], defaultDevice: null, gpuDecode: false, works: (e) => e.startsWith('lib') });
  try {
    const id = await h.service.start(h.config({ concurrency: 1 }));
    const job = await h.finishJob(id);
    assert.equal(job.state, 'completed');
    const first = (await h.store.summaries()).find((j) => j.id === id);
    assert.equal(first.items.length, 0);
    const saved = path.join(h.dir, 'jobs', id, 'summary.json');
    assert.ok(fs.existsSync(saved), 'saved beside the job');
    // a new store (a restart) reads the summary file, not the job
    const { createJobStore } = require('../src/main/converter/jobStore');
    const reads = [];
    const spyFs = new Proxy(fs.promises, { get: (t, k) => (k === 'open' ? (p, ...rest) => { reads.push(String(p)); return t.open(p, ...rest); } : t[k]) });
    const fresh = createJobStore({ rootDir: path.join(h.dir, 'jobs'), fs: spyFs });
    const again = (await fresh.summaries()).find((j) => j.id === id);
    assert.deepEqual(again.itemCounts, first.itemCounts);
    assert.equal(reads.filter((p) => p.endsWith('job.json')).length, 0, 'the job itself is not read');
  } finally {
    await h.close();
  }
});
