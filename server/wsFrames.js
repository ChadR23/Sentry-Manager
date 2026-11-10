'use strict';

// A small WebSocket (RFC 6455) connection over a socket that has already
// been upgraded, with Node built-ins only: text and control frames, masking,
// fragmentation, ping/pong and the close handshake. Used by the Sentry USB
// management link (server/sentryUsbLink.js) on the device port, and by its
// test Pi (client side, which masks what it sends).
//
// Sizes are checked from the frame header, before any payload is kept: a
// frame or message over `maxMessage` closes the connection (1009) without
// reading it. Binary frames are refused (1003): the link sends JSON text.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// a message in more parts than this is refused (1009): empty continuation
// frames cost a few bytes each to send, and would otherwise pile up unbounded
const MAX_PARTS = 1024;
// what a server may leave unsent to a peer that does not read (pongs to a
// ping flood), on top of 16 of its largest messages: over this the
// connection is dropped (4 MiB before the link's handshake, about 36 MiB after)
const MAX_UNSENT = 4 * 1024 * 1024;
const acceptKey = (key) => crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');

/** One frame: FIN set, the payload masked when `mask` (a client's frames). */
function encodeFrame(opcode, payload, mask = false) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
  const n = data.length;
  const len = n < 126 ? 0 : n < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + len + (mask ? 4 : 0));
  head[0] = 0x80 | opcode;
  head[1] = (mask ? 0x80 : 0) | (len === 0 ? n : len === 2 ? 126 : 127);
  if (len === 2) head.writeUInt16BE(n, 2);
  else if (len === 8) head.writeBigUInt64BE(BigInt(n), 2);
  if (!mask) return Buffer.concat([head, data]);
  const key = crypto.randomBytes(4);
  key.copy(head, 2 + len);
  const out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) out[i] = data[i] ^ key[i & 3];
  return Buffer.concat([head, out]);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * @param {import('net').Socket} socket  upgraded (101 already written or read)
 * @param {object} o
 * @param {'server'|'client'} o.role  a server needs masked frames and sends unmasked ones
 * @param {number} [o.maxMessage]  largest frame or message, bytes (settable later: ws.maxMessage)
 * @param {Buffer} [o.head]  bytes that came after the upgrade headers
 * Events: 'message' (text), 'close' (code, reason), 'pong'.
 */
class WsConnection extends EventEmitter {
  constructor(socket, { role = 'server', maxMessage = 2 * 1024 * 1024, head = null } = {}) {
    super();
    this.socket = socket;
    this.role = role;
    this.maxMessage = maxMessage;
    this.closed = false; // the socket is gone
    this.closing = false; // a close frame was sent
    this.lastHeard = Date.now();
    this.chunks = [];
    this.have = 0;
    this.need = 2;
    this.frag = null; // { opcode, parts, bytes } while a fragmented message arrives
    socket.setNoDelay?.(true);
    socket.setTimeout?.(0);
    socket.on('data', (c) => this.onData(c));
    socket.on('error', () => this.gone(1006, ''));
    socket.on('close', () => this.gone(1006, ''));
    if (head?.length) process.nextTick(() => this.onData(head));
  }

  onData(chunk) {
    if (this.closed) return;
    this.lastHeard = Date.now();
    this.chunks.push(chunk);
    this.have += chunk.length;
    while (!this.closed && this.have >= this.need) {
      const b = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.have);
      const used = this.parse(b);
      if (used === 0) {
        this.chunks = [b];
        break;
      }
      const rest = b.subarray(used);
      this.chunks = rest.length ? [rest] : [];
      this.have = rest.length;
      this.need = 2;
    }
  }

  // one frame from the start of b: the bytes used, or 0 (and this.need set) to wait
  parse(b) {
    if (b.length < 2) { this.need = 2; return 0; }
    const fin = (b[0] & 0x80) !== 0;
    const rsv = b[0] & 0x70;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let n = b[1] & 0x7f;
    let off = 2;
    if (rsv) return this.fail(1002, 'reserved bits');
    if (masked !== (this.role === 'server')) return this.fail(1002, masked ? 'masked frame' : 'unmasked frame');
    if (n === 126) {
      if (b.length < 4) { this.need = 4; return 0; }
      n = b.readUInt16BE(2);
      off = 4;
    } else if (n === 127) {
      if (b.length < 10) { this.need = 10; return 0; }
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.maxMessage)) return this.fail(1009, 'too large');
      n = Number(big);
      off = 10;
    }
    const control = opcode >= 0x8;
    if (control && (n > 125 || !fin)) return this.fail(1002, 'bad control frame');
    // the size is known before the payload is read: too large is refused unread
    if (n > this.maxMessage || (!control && (this.frag?.bytes || 0) + n > this.maxMessage)) return this.fail(1009, 'too large');
    const total = off + (masked ? 4 : 0) + n;
    if (b.length < total) { this.need = total; return 0; }
    let payload = b.subarray(off + (masked ? 4 : 0), total);
    if (masked) {
      const key = b.subarray(off, off + 4);
      const out = Buffer.allocUnsafe(n);
      for (let i = 0; i < n; i++) out[i] = payload[i] ^ key[i & 3];
      payload = out;
    } else payload = Buffer.from(payload);
    this.frame(fin, opcode, payload);
    return total;
  }

  frame(fin, opcode, payload) {
    if (opcode === 0x8) {
      let code = 1005;
      let reason = '';
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        try { reason = utf8.decode(payload.subarray(2)); } catch { reason = ''; }
      }
      if (!this.closing) this.write(0x8, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
      this.closing = true;
      this.socket.end();
      this.gone(code, reason);
      return;
    }
    if (opcode === 0x9) { this.write(0xA, payload); return; }
    if (opcode === 0xA) { this.emit('pong'); return; }
    if (opcode === 0x2 || (opcode === 0x0 && this.frag?.opcode === 0x2)) { this.fail(1003, 'text only'); return; }
    if (opcode === 0x1) {
      if (this.frag) { this.fail(1002, 'unfinished message'); return; }
      if (fin) { this.text(payload); return; }
      this.frag = { opcode, parts: [payload], bytes: payload.length };
      return;
    }
    if (opcode === 0x0) {
      if (!this.frag) { this.fail(1002, 'stray continuation'); return; }
      if (this.frag.parts.length >= MAX_PARTS) { this.fail(1009, 'too many fragments'); return; }
      this.frag.parts.push(payload);
      this.frag.bytes += payload.length;
      if (fin) {
        const whole = Buffer.concat(this.frag.parts, this.frag.bytes);
        this.frag = null;
        this.text(whole);
      }
      return;
    }
    this.fail(1002, 'unknown opcode');
  }

  text(buf) {
    let s;
    try { s = utf8.decode(buf); } catch { this.fail(1007, 'not UTF-8'); return; }
    this.emit('message', s);
  }

  write(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    if (this.role === 'server' && (this.socket.writableLength || 0) > MAX_UNSENT + 16 * this.maxMessage) { this.terminate(); return false; }
    try {
      return this.socket.write(encodeFrame(opcode, payload, this.role === 'client'));
    } catch {
      return false;
    }
  }

  send(text) {
    if (this.closing) return false;
    return this.write(0x1, Buffer.from(text, 'utf8'));
  }

  ping() { return this.write(0x9, Buffer.alloc(0)); }

  /** The close handshake; the socket goes after 2 s if the other side does not answer. */
  close(code = 1000, reason = '') {
    if (this.closed || this.closing) return;
    this.closing = true;
    const r = Buffer.from(String(reason).slice(0, 100), 'utf8').subarray(0, 120);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.write(0x8, p);
    const t = setTimeout(() => this.socket.destroy(), 2000);
    t.unref?.();
    this.socket.once('close', () => clearTimeout(t));
    this.socket.end();
  }

  fail(code, reason) {
    this.close(code, reason);
    this.gone(code, reason);
    return 0;
  }

  terminate() {
    this.socket.destroy();
    this.gone(1006, '');
  }

  gone(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.chunks = [];
    this.have = 0;
    this.frag = null;
    this.emit('close', code, reason);
  }
}

module.exports = { WsConnection, encodeFrame, acceptKey, MAX_PARTS, MAX_UNSENT };
