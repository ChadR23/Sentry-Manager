'use strict';

// The Node side of lean/tests/reports_parity.rs: what the Node code makes of
// the same input, so the Rust port can be checked against it.
//
//   node lean/parity/reports.js scrub       stdin: [{ value, anonymous, identifiers }] -> [cleanReport(...)]
//   node lean/parity/reports.js validate    stdin: [payload] -> [validatePayload(payload)]
//   node lean/parity/reports.js heartbeat   stdin: [raw] -> [normalizeHeartbeat(raw)]
//   node lean/parity/reports.js receiver    the local fake receiver (test/fixtures/reportsReceiver.js)
//                                           on 127.0.0.1; prints { url, line, control } and serves
//                                           GET <control>/index (what it received, opened) and
//                                           POST <control>/opts (difficulty, limitHour) until stdin closes.
//
// Nothing here talks to anything but 127.0.0.1.

const http = require('http');
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const { cleanReport } = require(path.join(REPO, 'server/reportsScrub'));
const P = require(path.join(REPO, 'server/reportsProtocol'));
const { normalizeHeartbeat } = require(path.join(REPO, 'server/reports'));
const { startReceiver } = require(path.join(REPO, 'test/fixtures/reportsReceiver'));

function stdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'scrub') {
    const cases = JSON.parse(await stdin());
    process.stdout.write(JSON.stringify(cases.map((c) => cleanReport(c.value, { anonymous: c.anonymous, identifiers: c.identifiers || [] }))));
    return;
  }
  if (mode === 'validate') {
    process.stdout.write(JSON.stringify(JSON.parse(await stdin()).map((p) => P.validatePayload(p))));
    return;
  }
  if (mode === 'heartbeat') {
    process.stdout.write(JSON.stringify(JSON.parse(await stdin()).map((h) => normalizeHeartbeat(h))));
    return;
  }
  if (mode === 'receiver') {
    const rec = await startReceiver({ difficulty: Number(process.argv[3] || 6), movedTo: process.argv[4] || undefined });
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
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
