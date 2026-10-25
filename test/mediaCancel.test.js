'use strict';

// The Viewer cancels video requests whenever it seeks. A request cancelled
// before the file was opened used to leave the file open until garbage
// collection ("Closing file descriptor N on garbage collection" in the logs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const http2 = require('http2');
const os = require('os');
const path = require('path');
const { sendMedia } = require('../server/studioApi');

test('a video request cancelled before or while it is answered closes its file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-media-cancel-'));
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 7));

  // count every FileHandle opened for the clip and every one closed
  const realOpen = fsp.open;
  let opened = 0;
  let closed = 0;
  fsp.open = async (...args) => {
    const fh = await realOpen(...args);
    if (args[0] === file) {
      opened += 1;
      const close = fh.close.bind(fh);
      let done = false;
      fh.close = async () => { if (!done) { done = true; closed += 1; } return close(); };
      fh.once?.('close', () => { if (!done) { done = true; closed += 1; } });
    }
    return fh;
  };

  const server = http2.createServer((req, res) => {
    const delay = Number(new URL(req.url, 'http://x').searchParams.get('d'));
    setTimeout(() => { sendMedia(req, res, file).catch(() => {}); }, delay);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
  try {
    const N = 60;
    for (let i = 0; i < N; i++) {
      const s = client.request({ ':path': `/v?d=${i % 4}`, range: `bytes=${i * 1000}-` });
      s.on('error', () => {});
      s.resume();
      setTimeout(() => s.close(http2.constants.NGHTTP2_CANCEL), i % 6);
    }
    const deadline = Date.now() + 5000;
    while ((opened < N || closed < opened) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(opened, N);
    assert.equal(closed, opened, 'every opened clip is closed again');
  } finally {
    fsp.open = realOpen;
    client.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
