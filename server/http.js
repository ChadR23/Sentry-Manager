'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream');
const zlib = require('zlib');

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.icns': 'application/octet-stream', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.proto': 'text/plain; charset=utf-8',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.gif': 'image/gif', '.webp': 'image/webp'
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Text worth compressing, and how the browser asked for it (brotli or gzip).
const COMPRESSIBLE = /^(text\/|application\/(json|javascript)|image\/svg)/;
function encodingFor(req) {
  const accept = String(req?.headers?.['accept-encoding'] || '');
  return /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
}
function compress(buf, enc) {
  return enc === 'br'
    // quality 5: about gzip's speed, smaller output (the result is cached)
    ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
    : zlib.gzipSync(buf, { level: 6 });
}

// JSON answers over 1 KB go compressed when the browser accepts it: lists of
// recordings and days shrink 10-17 times (261 KB -> 15 KB for 500 recordings).
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const enc = data.length > 1024 ? encodingFor(res.req) : null;
  if (!enc) {
    res.writeHead(status, headers);
    res.end(data);
    return;
  }
  // gzip for JSON: made fresh for every answer, and it is the quicker to make
  const zipped = zlib.gzipSync(data, { level: 4 });
  res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
  res.end(zipped);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The raw body as a Buffer, refused past `limit` bytes. */
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, 'That file is too large.'));
      req.resume();
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'That file is too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const text = await readBody(req, limit);
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/** Minimal router: add('GET', '/api/x/:id', handler). */
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    })}$`);
    this.routes.push({ method, re, keys, handler, opts });
  }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      const params = {};
      try {
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      } catch {
        return null;
      }
      return { route: r, params };
    }
    return null;
  }
}

/**
 * Serve a file below `root`; resolves false if there is none. `rel` is the
 * already decoded and normalized request path below the route prefix.
 */
// Compressed copies of static files, kept by file, size, time and encoding (a
// file that changes gets a new copy), up to 48 MB in all.
const packed = new Map();
let packedBytes = 0;
const PACKED_MAX = 48 * 1024 * 1024;
async function packedCopy(abs, st, enc) {
  const key = `${abs}|${st.size}|${st.mtimeMs}|${enc}`;
  let buf = packed.get(key);
  if (buf) {
    packed.delete(key);
    packed.set(key, buf); // most recently used last
    return buf;
  }
  buf = compress(await fsp.readFile(abs), enc);
  packed.set(key, buf);
  packedBytes += buf.length;
  for (const [k, b] of packed) {
    if (packedBytes <= PACKED_MAX) break;
    packed.delete(k);
    packedBytes -= b.length;
  }
  return buf;
}

/**
 * Serve a file below `root`; resolves false if there is none. `rel` is the
 * already decoded and normalized request path below the route prefix.
 *
 * Every file carries an ETag (its size and time), so a browser asking again
 * gets "304 Not Modified" instead of the file: before, "no-cache" with no
 * ETag meant every page load downloaded every script again (6 MB for the
 * Viewer). Text is sent compressed (brotli or gzip), from a cached copy.
 */
async function serveFile(req, res, root, rel, { transform, cache = 'no-cache', headers = {} } = {}) {
  if (typeof rel !== 'string' || rel.includes('\0') || rel.split('/').some((seg) => seg === '..')) return false;
  const abs = path.resolve(root, `.${path.sep}${rel}`);
  if (abs !== root && !abs.startsWith(root + path.sep)) return false;
  let st;
  try {
    st = await fsp.lstat(abs);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const type = STATIC_MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const textual = COMPRESSIBLE.test(type);
  if (transform) {
    const body = transform(await fsp.readFile(abs, 'utf8'));
    const enc = textual && body.length > 1024 ? encodingFor(req) : null;
    const out = enc ? compress(Buffer.from(body), enc) : body;
    res.writeHead(200, { ...headers, 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      ...(enc ? { 'Content-Encoding': enc, Vary: 'Accept-Encoding' } : {}) });
    res.end(out);
    return true;
  }
  const etag = `W/"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
  const common = { ...headers, 'Content-Type': type, 'Cache-Control': cache, ETag: etag, 'X-Content-Type-Options': 'nosniff', ...(textual ? { Vary: 'Accept-Encoding' } : {}) };
  if (String(req.headers['if-none-match'] || '').split(/\s*,\s*/).includes(etag)) {
    res.writeHead(304, common);
    res.end();
    return true;
  }
  const enc = textual && st.size > 1024 ? encodingFor(req) : null;
  if (enc) {
    const buf = await packedCopy(abs, st, enc);
    res.writeHead(200, { ...common, 'Content-Encoding': enc, 'Content-Length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
    return true;
  }
  res.writeHead(200, { ...common, 'Content-Length': st.size });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  // a request the browser already cancelled never ends a stream: don't open one
  if (res.destroyed || res.stream?.destroyed) return true;
  pipeline(fs.createReadStream(abs), res, () => {});
  return true;
}

/** Text the server made (not a file): an ETag, 304, compressed like a file. */
function sendText(req, res, body, { type, etag }) {
  const common = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag, Vary: 'Accept-Encoding', 'X-Content-Type-Options': 'nosniff' };
  if (String(req.headers['if-none-match'] || '').split(/\s*,\s*/).includes(etag)) {
    res.writeHead(304, common);
    return res.end();
  }
  const enc = body.length > 1024 ? encodingFor(req) : null;
  const out = enc ? compress(Buffer.from(body), enc) : body;
  res.writeHead(200, { ...common, ...(enc ? { 'Content-Encoding': enc } : {}) });
  return res.end(req.method === 'HEAD' ? undefined : out);
}

module.exports = { Router, HttpError, sendJson, readJson, readRaw, serveFile, sendText };
