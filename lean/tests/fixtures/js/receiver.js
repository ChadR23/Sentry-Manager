'use strict';

// The stand-in receiver (reportsReceiver.js) on 127.0.0.1 for
// lean/tests/reports_parity.rs, with a control port for the test:
//
//   node lean/tests/fixtures/js/receiver.js <difficulty> [moved to]
//
// prints { url, line, control } and serves until stdin closes:
//   GET  <control>/index   what was received, each report opened
//   POST <control>/opts    changes the receiver's options
// Plain Node, no packages; nothing is sent anywhere.

const http = require('http');
const { startReceiver } = require('./reportsReceiver');

(async () => {
  const rec = await startReceiver({ difficulty: Number(process.argv[2] || 6), movedTo: process.argv[3] || undefined });
  const control = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/index') {
        const out = rec.index.map((e) => ({ ...e, payload: rec.openReport(e) }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(out));
      }
      if (req.method === 'POST' && req.url === '/opts') {
        Object.assign(rec.opts, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{}');
      }
      res.writeHead(404);
      return res.end();
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => control.once('listening', r));
  process.stdout.write(`${JSON.stringify({ url: rec.url, line: rec.keys.publicInfo().line, control: `http://127.0.0.1:${control.address().port}` })}\n`);
  process.stdin.resume();
  process.stdin.on('end', async () => { control.close(); await rec.close(); process.exit(0); });
})().catch((err) => { console.error(err); process.exit(1); });
