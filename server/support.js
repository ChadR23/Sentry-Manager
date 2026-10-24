'use strict';

// Settings > Support: the Sentry Six support chat, relayed by this server.
// The page never talks to the support server itself (the page's CSP allows
// only this server), and the ticket's access token stays here, in the
// database, never in a browser. Only https://api.sentry-six.com is ever
// contacted, only when someone opens a ticket or the Support tab is open, and
// redirects are not followed.

const https = require('https');
const os = require('os');
const { pipeline } = require('stream');
const { HttpError } = require('./http');
const { redact } = require('./log');

const HOST = 'api.sentry-six.com';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[\x21-\x7e]{1,512}$/;
const MAX_MESSAGE = 4000;
const MAX_REPLY_BYTES = 5 * 1024 * 1024;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024; // the file itself; sent base64 (~67 MB)
const MAX_ATTACHMENT_BYTES = 110 * 1024 * 1024;
// an attachment path on the support server: plain characters, no "..", no
// percent-encoded dot, slash or backslash (a server that decodes them would
// see "..", "//" or "\\" again), an optional plain query
const ATTACHMENT_PATH = /^\/(?![/\\])(?!.*\.\.)(?!.*\/\/)(?!.*%(?:2[eEfF]|5[cC]))[A-Za-z0-9._~/%-]{1,512}(\?[A-Za-z0-9._~=&%-]{0,512})?$/;
// Pictures the support team sends from Discord live on Discord's CDN; they are
// fetched through this server too (the page may load only from this server),
// without the support token.
const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const CDN_QUERY = /^\?[A-Za-z0-9._~=&%-]{0,1024}$/;
const SHOWN_TYPES = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm|quicktime))$/;

function request({ host = HOST, method, path, token = null, body = null, timeoutMs = 30000, raw = false }) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: raw ? '*/*' : 'application/json', 'User-Agent': 'SentrySixManager' };
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (token) headers['X-Auth-Token'] = token;
    const req = https.request({ hostname: host, port: 443, path, method, headers, timeout: timeoutMs }, (res) => {
      if (raw) return resolve(res);
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_REPLY_BYTES) {
          req.destroy();
          reject(new HttpError(502, 'The support server sent too much.'));
        } else chunks.push(c);
      });
      res.on('end', () => {
        let data = null;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // not JSON
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && data && typeof data === 'object') return resolve(data);
        const said = data && typeof data.error === 'string' ? data.error.slice(0, 200) : null;
        if (res.statusCode === 404) return reject(Object.assign(new HttpError(404, said || 'Ticket not found'), { gone: true }));
        if (res.statusCode === 413) return reject(new HttpError(413, 'That file is too large for the support server.'));
        return reject(new HttpError(502, said ? `Support server: ${said}` : `The support server answered ${res.statusCode}. Try again later.`));
      });
      res.on('error', reject);
      return undefined;
    });
    req.on('timeout', () => req.destroy(new HttpError(504, 'The support server did not answer in time.')));
    req.on('error', (err) => reject(err instanceof HttpError ? err : new HttpError(502, `Can't reach the support server (${err.code || err.message}).`)));
    if (body !== null) req.write(body);
    req.end();
  });
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// Where an attachment link may be fetched from: a path on the support server
// (sent with the ticket's token), or a file on Discord's CDN (sent without it).
// Anything else is null and is shown as a name only.
function attachmentTarget(u) {
  if (typeof u !== 'string' || u.length > 2048) return null;
  if (u.startsWith(`https://${HOST}/`)) u = u.slice(`https://${HOST}`.length);
  if (u.startsWith('/')) return ATTACHMENT_PATH.test(u) ? { host: HOST, path: u, withToken: true } : null;
  let url;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !CDN_HOSTS.has(url.hostname)) return null;
  const pathPart = u.slice(`https://${url.hostname}`.length).split('?')[0];
  const query = url.search;
  if (!ATTACHMENT_PATH.test(pathPart) || (query && !CDN_QUERY.test(query))) return null;
  return { host: url.hostname, path: pathPart + query, withToken: false };
}

const EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };

// An attachment as the page may show it: our own relay URL, never the support
// server's, and only a known picture/video type is shown inline.
function publicAttachment(a) {
  if (typeof a === 'string') return { name: a.slice(0, 200) };
  if (!a || typeof a !== 'object') return null;
  const target = attachmentTarget(a.url);
  const name = str(a.name, 200) || 'attachment';
  // Discord does not always say the type: the file's extension does
  const declared = str(a.type || a.contentType || a.content_type, 100).split(';')[0].trim().toLowerCase();
  const type = SHOWN_TYPES.test(declared) ? declared : EXT_TYPES[(name.match(/\.(\w{2,4})$/) || [])[1]?.toLowerCase()] || '';
  return {
    name,
    type,
    url: target ? `/api/support/attachment?u=${encodeURIComponent(target.host === HOST ? target.path : a.url)}` : null
  };
}

function publicMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const id = typeof m.id === 'string' || Number.isSafeInteger(m.id) ? String(m.id).slice(0, 128) : null;
  return {
    id,
    sender: m.sender === 'user' ? 'user' : 'support',
    content: str(m.content, 8000),
    responder: str(m.responder, 80),
    timestamp: typeof m.timestamp === 'string' || Number.isFinite(m.timestamp) ? m.timestamp : null,
    hasDiagnostics: m.hasDiagnostics === true,
    read: m.read === true,
    attachments: Array.isArray(m.attachments) ? m.attachments.slice(0, 10).map(publicAttachment).filter(Boolean) : []
  };
}

// Footage paths, share names and addresses stay out of what is sent.
function scrub(text) {
  return redact(text)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '[ip]')
    .replace(/(\/\/|\\\\)[^\s/\\]+[/\\][^\s'"]*/g, '$1[share]')
    .replace(/\/(?:footage|mnt|media|shares?|data)\/[^\s'"]*/gi, '[path]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]');
}

function createSupport({ db, log, buildInfo, detectGpus, recentLogs, requestImpl = request }) {
  const ticket = () => {
    const t = db.get('supportTicket', null);
    return t && ID.test(t.ticketId || '') && TOKEN.test(t.authToken || '') ? t : null;
  };
  const forget = () => db.set('supportTicket', null);
  let opening = null; // one ticket at a time, even from two tabs
  const droppedHosts = new Set();

  async function diagnostics() {
    const gpus = await Promise.resolve().then(detectGpus).catch(() => null);
    return {
      v: 2,
      ts: Date.now(),
      app: 'Sentry Six Manager (Docker)',
      appVersion: buildInfo?.sha ? `${String(buildInfo.sha).slice(0, 12)}${buildInfo.builtAt ? ` built ${String(buildInfo.builtAt).slice(0, 10)}` : ''}` : 'built from source',
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      hardware: {
        cpu: os.cpus()[0]?.model || null,
        cores: os.cpus().length,
        memoryGb: Math.round(os.totalmem() / 1e9),
        gpus: gpus ? [
          ...(gpus.nvidia || []).map((g) => `NVIDIA ${g.name} (driver ${g.driver})`),
          ...(gpus.gpus || []).filter((g) => g.vendor !== 'nvidia').map((g) => `${g.name || g.vendorName}${g.passedThrough ? '' : ' (not passed into the container)'}`)
        ] : []
      },
      settings: {},
      logs: { console: [], errors: [] },
      terminalLogs: (recentLogs() || []).slice(-150).map((l) => scrub(`${l.at ? new Date(l.at).toISOString() : ''} ${l.level || ''} [${l.scope || ''}] ${l.message || ''}`).slice(0, 600))
    };
  }

  const cleanMessage = (m) => {
    const text = typeof m === 'string' ? m.trim() : '';
    if (text.length > MAX_MESSAGE) throw new HttpError(400, `Keep a message under ${MAX_MESSAGE} characters.`);
    return text;
  };

  // A support-side 404 means the ticket is gone: forget it so a new one can start.
  async function withTicket(fn) {
    const t = ticket();
    if (!t) throw new HttpError(409, 'No open support ticket.');
    try {
      return await fn(t);
    } catch (err) {
      if (err.gone) {
        forget();
        throw new HttpError(409, 'This support ticket no longer exists. Send a message to start a new one.');
      }
      throw err;
    }
  }

  async function open(message, diag, hasAttachments) {
    if (opening) await opening.catch(() => {});
    if (ticket()) return { created: false };
    opening = (async () => {
      const out = await requestImpl({ method: 'POST', path: '/chat/ticket', body: JSON.stringify({ message, diagnostics: diag, hasAttachments }) });
      if (!ID.test(String(out.ticketId || '')) || !TOKEN.test(String(out.authToken || ''))) throw new HttpError(502, 'The support server sent an unusable ticket.');
      db.set('supportTicket', { ticketId: String(out.ticketId), authToken: String(out.authToken), openedAt: new Date().toISOString() });
      log.info(`Support ticket ${out.ticketId} opened`);
    })();
    try {
      await opening;
    } finally {
      opening = null;
    }
    return { created: true };
  }

  return {
    status() {
      const t = ticket();
      return { open: Boolean(t), ticketId: t?.ticketId || null, openedAt: t?.openedAt || null, server: HOST };
    },

    async send({ message, includeDiagnostics }) {
      const text = cleanMessage(message);
      if (!text) throw new HttpError(400, 'Write a message first.');
      const diag = includeDiagnostics === true ? await diagnostics() : null;
      const { created } = await open(text, diag, false);
      if (created) return { ok: true, created: true };
      await withTicket((t) => requestImpl({ method: 'POST', path: `/chat/ticket/${t.ticketId}/message`, token: t.authToken, body: JSON.stringify({ message: text, diagnostics: diag }) }));
      return { ok: true, created: false };
    },

    async media({ bytes, fileName, fileType, message, includeDiagnostics }) {
      if (!bytes.length) throw new HttpError(400, 'The file is empty.');
      const name = String(fileName || 'attachment').replace(/[\x00-\x1f/\\]/g, '_').slice(0, 200);
      const type = /^[\w.+-]+\/[\w.+-]+$/.test(fileType || '') ? fileType : 'application/octet-stream';
      const text = cleanMessage(message);
      const diag = includeDiagnostics === true ? await diagnostics() : null;
      // a first message with only a file still opens the ticket
      const { created } = await open(text || `Attachment: ${name}`, diag, true);
      // a ticket this upload just opened already carries the message and the
      // diagnostics: the file goes alone, so neither arrives twice
      const uploadTimeout = Math.min(600000, 180000 + Math.floor(bytes.length / (50 * 1024 * 1024)) * 60000);
      await withTicket((t) => requestImpl({
        method: 'POST', path: `/chat/ticket/${t.ticketId}/media`, token: t.authToken, timeoutMs: uploadTimeout,
        body: JSON.stringify({ mediaData: bytes.toString('base64'), fileName: name, fileType: type, fileSize: bytes.length, message: created ? '' : text, diagnostics: created ? null : diag })
      }));
      return { ok: true };
    },

    async messages({ since }) {
      if (!ticket()) return { open: false, messages: [] };
      const after = typeof since === 'string' && ID.test(since) ? `?since=${encodeURIComponent(since)}` : '';
      const out = await withTicket((t) => requestImpl({ method: 'GET', path: `/chat/ticket/${t.ticketId}/messages${after}`, token: t.authToken }));
      const closed = out.status === 'closed';
      if (closed) {
        forget();
        log.info('Support ticket closed by support');
      }
      const list = Array.isArray(out.messages) ? out.messages.slice(-500) : [];
      // an attachment link from somewhere new is shown as a name only: say once where it was
      for (const m of list) {
        for (const a of Array.isArray(m?.attachments) ? m.attachments : []) {
          if (!a || typeof a.url !== 'string' || attachmentTarget(a.url)) continue;
          let where = 'unreadable link';
          try {
            where = new URL(a.url, `https://${HOST}`).host;
          } catch {
            // keep the generic label
          }
          if (!droppedHosts.has(where)) {
            droppedHosts.add(where);
            log.warn(`Support attachment from ${where} not shown (not an allowed source)`);
          }
        }
      }
      return { open: !closed, closed, messages: list.map(publicMessage).filter(Boolean) };
    },

    async read() {
      if (!ticket()) return { ok: true };
      await withTicket((t) => requestImpl({ method: 'POST', path: `/chat/ticket/${t.ticketId}/mark-read`, token: t.authToken }));
      return { ok: true };
    },

    async close() {
      if (!ticket()) return { ok: true };
      try {
        await withTicket((t) => requestImpl({ method: 'POST', path: `/chat/ticket/${t.ticketId}/close`, token: t.authToken, body: JSON.stringify({ closedBy: 'User', reason: 'Closed from Sentry Six Manager' }) }));
      } finally {
        forget();
      }
      log.info('Support ticket closed');
      return { ok: true };
    },

    /** Stream one attachment of the open ticket from the support server. */
    async attachment(res, u) {
      const target = attachmentTarget(u);
      if (!target) throw new HttpError(400, 'Not a support attachment.');
      const t = ticket();
      if (!t) throw new HttpError(409, 'No open support ticket.');
      const up = await requestImpl({
        host: target.host, method: 'GET', path: target.path, token: target.withToken ? t.authToken : null, raw: true, timeoutMs: 120000
      });
      if (up.statusCode !== 200) {
        up.resume();
        throw new HttpError(up.statusCode === 404 ? 404 : 502, 'The support server could not send that file.');
      }
      const declared = Number(up.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
        up.destroy();
        throw new HttpError(502, 'That attachment is too large.');
      }
      const type = String(up.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const shown = SHOWN_TYPES.test(type);
      res.writeHead(200, {
        'Content-Type': shown ? type : 'application/octet-stream',
        ...(Number.isFinite(declared) ? { 'Content-Length': declared } : {}),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        ...(shown ? {} : { 'Content-Disposition': 'attachment' })
      });
      let sent = 0;
      up.on('data', (c) => {
        sent += c.length;
        if (sent > MAX_ATTACHMENT_BYTES) {
          up.destroy();
          res.destroy();
        }
      });
      // a support server that stops mid-file, or a page that goes away, ends
      // both sides (a plain pipe left the page's response open)
      pipeline(up, res, () => {});
      return undefined;
    }
  };
}

module.exports = { createSupport, publicMessage, publicAttachment, attachmentTarget, scrub, MAX_MEDIA_BYTES, ATTACHMENT_PATH };
