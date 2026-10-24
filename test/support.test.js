'use strict';

// Settings > Support: the chat is relayed to the Sentry Six support server.
// The ticket's token never reaches a browser, only the support server's own
// paths are requested, and what comes back is cleaned before a page sees it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const { createSupport, publicMessage, scrub } = require('../server/support');

function memDb() {
  const m = new Map();
  return { get: (k, f = null) => (m.has(k) ? m.get(k) : f), set: (k, v) => m.set(k, v) };
}
const quiet = { info() {}, warn() {}, error() {} };

function harness(reply) {
  const calls = [];
  const db = memDb();
  const support = createSupport({
    db, log: quiet, buildInfo: { sha: 'abcdef1234567890' }, detectGpus: async () => ({ nvidia: [], gpus: [] }),
    recentLogs: () => [{ at: 0, level: 'warn', scope: 'share', message: 'mount //192.168.1.20/TeslaCam failed for me@example.com at /footage/car/2026' }],
    requestImpl: async (req) => {
      calls.push(req);
      return reply(req);
    }
  });
  return { support, calls, db };
}

test('the first message opens a ticket; the token stays on the server; later messages go to that ticket', async () => {
  const { support, calls, db } = harness((req) => (req.path === '/chat/ticket' ? { success: true, ticketId: 'T-123', authToken: 'secret-token' } : { success: true }));
  assert.deepEqual(support.status().open, false);
  assert.deepEqual(await support.send({ message: 'help', includeDiagnostics: false }), { ok: true, created: true });
  const st = support.status();
  assert.equal(st.open, true);
  assert.equal(st.ticketId, 'T-123');
  assert.equal(JSON.stringify(st).includes('secret-token'), false, 'the token is never sent to the page');
  assert.equal(db.get('supportTicket').authToken, 'secret-token');
  await support.send({ message: 'more', includeDiagnostics: false });
  assert.equal(calls[1].path, '/chat/ticket/T-123/message');
  assert.equal(calls[1].token, 'secret-token');
});

test('two tabs sending at once open one ticket', async () => {
  let opened = 0;
  const { support, calls } = harness(async (req) => {
    if (req.path === '/chat/ticket') {
      opened += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ticketId: 'T1', authToken: 'tok' };
    }
    return { success: true };
  });
  await Promise.all([support.send({ message: 'a' }), support.send({ message: 'b' })]);
  assert.equal(opened, 1);
  assert.equal(calls.filter((c) => c.path === '/chat/ticket/T1/message').length, 1);
});

test('an unusable ticket id from the server is refused, so it can never become a path', async () => {
  const { support } = harness(() => ({ ticketId: '../../admin', authToken: 'tok' }));
  await assert.rejects(support.send({ message: 'x' }), /unusable ticket/);
  assert.equal(support.status().open, false);
});

test('diagnostics leave out addresses, share names, footage paths and emails', async () => {
  const { support, calls } = harness(() => ({ ticketId: 'T1', authToken: 'tok' }));
  await support.send({ message: 'x', includeDiagnostics: true });
  const sent = calls[0].body;
  assert.match(sent, /"appVersion":"abcdef123456/);
  for (const leak of ['192.168.1.20', 'TeslaCam', 'me@example.com', '/footage/car']) assert.equal(sent.includes(leak), false, leak);
  assert.equal(scrub('smb://u:pw@nas/x').includes('pw'), false);
});

test('messages: only known fields, attachments through this server, the since id checked', async () => {
  const { support, calls } = harness((req) => {
    if (req.path === '/chat/ticket') return { ticketId: 'T1', authToken: 'tok' };
    return {
      success: true,
      messages: [{
        id: 'm1', sender: 'support', content: '<b>hi</b>', responder: 'Sam', timestamp: '2026-10-24T10:00:00Z', read: false, extra: 'x',
        attachments: [
          { name: 'a.png', type: 'image/png', url: '/chat/media/T1/a.png' },
          { name: 'b.html', type: 'text/html', url: 'https://api.sentry-six.com/chat/media/T1/b.html' },
          { name: 'evil', type: 'image/png', url: 'https://evil.example/x.png' },
          { name: 'up', type: 'image/png', url: '/chat/../../etc/passwd' }
        ]
      }]
    };
  });
  await support.send({ message: 'x' });
  const out = await support.messages({ since: 'm0' });
  assert.equal(calls.at(-1).path, '/chat/ticket/T1/messages?since=m0');
  await support.messages({ since: 'x&y=1/../' });
  assert.equal(calls.at(-1).path, '/chat/ticket/T1/messages', 'an odd since id is dropped');
  const [m] = out.messages;
  assert.equal(m.extra, undefined);
  assert.equal(m.content, '<b>hi</b>', 'text is kept as text; the page escapes it');
  assert.deepEqual(m.attachments.map((a) => a.url), [
    `/api/support/attachment?u=${encodeURIComponent('/chat/media/T1/a.png')}`,
    `/api/support/attachment?u=${encodeURIComponent('/chat/media/T1/b.html')}`,
    null, null
  ]);
  assert.equal(m.attachments[1].type, '', 'only pictures and videos are shown inline');
  assert.equal(publicMessage({ sender: 'admin' }).sender, 'support');
});

test('a ticket the support server no longer has is forgotten; a closed one too', async () => {
  let gone = false;
  const { support } = harness((req) => {
    if (req.path === '/chat/ticket') return { ticketId: 'T1', authToken: 'tok' };
    if (gone) throw Object.assign(new Error('Ticket not found'), { gone: true });
    return { status: 'closed', messages: [] };
  });
  await support.send({ message: 'x' });
  const out = await support.messages({});
  assert.equal(out.closed, true);
  assert.equal(support.status().open, false);
  await support.send({ message: 'again' });
  gone = true;
  await assert.rejects(support.messages({}), /no longer exists/);
  assert.equal(support.status().open, false);
});

test('attachments: only support-server paths, streamed with a safe type', async () => {
  const { support, calls } = harness((req) => {
    if (req.path === '/chat/ticket') return { ticketId: 'T1', authToken: 'tok' };
    const up = new PassThrough();
    up.statusCode = 200;
    up.headers = { 'content-type': req.path.endsWith('.png') ? 'image/png' : 'text/html', 'content-length': '3' };
    setImmediate(() => up.end('abc'));
    return up;
  });
  await support.send({ message: 'x' });
  for (const bad of ['https://evil.example/x', '//evil.example/x', '/a/../b', 'chat/x', '/a b',
    '/chat/%2e%2e/admin', '/chat/%2E%2E/admin', '/chat/.%2e/x', '/%2fevil.example/x', '/a%2F%2Fb', '/a%5c..%5cb']) {
    await assert.rejects(support.attachment({}, bad), /Not a support attachment/, bad);
  }
  const res = new PassThrough();
  let head;
  res.writeHead = (status, headers) => { head = { status, headers }; };
  await support.attachment(res, '/chat/media/T1/x.html');
  assert.equal(head.headers['Content-Type'], 'application/octet-stream');
  assert.equal(head.headers['Content-Disposition'], 'attachment');
  assert.equal(head.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(calls.at(-1).token, 'tok');
});

test('media: a file with no ticket yet opens one, then uploads to it', async () => {
  const { support, calls } = harness((req) => (req.path === '/chat/ticket' ? { ticketId: 'T1', authToken: 'tok' } : { success: true }));
  await support.media({ bytes: Buffer.from('png'), fileName: '../x.png', fileType: 'image/png', message: '' });
  assert.equal(calls[0].path, '/chat/ticket');
  assert.equal(calls[1].path, '/chat/ticket/T1/media');
  const body = JSON.parse(calls[1].body);
  assert.equal(body.fileName, '.._x.png');
  assert.equal(Buffer.from(body.mediaData, 'base64').toString(), 'png');
  await assert.rejects(support.send({ message: 'x'.repeat(4001) }), /under 4000/);
});

test('attachments: a support server that stops mid-file ends the page\'s response too', async () => {
  let up;
  const { support } = harness((req) => {
    if (req.path === '/chat/ticket') return { ticketId: 'T1', authToken: 'tok' };
    up = new PassThrough();
    up.statusCode = 200;
    up.headers = { 'content-type': 'image/png', 'content-length': '1000' };
    return up;
  });
  await support.send({ message: 'x' });
  const res = new PassThrough();
  res.writeHead = () => {};
  await support.attachment(res, '/chat/media/T1/a.png');
  up.write('abc');
  up.destroy(new Error('socket hang up'));
  await new Promise((r) => setImmediate(r));
  assert.equal(res.destroyed, true, 'the page is not left waiting for the rest');
});
