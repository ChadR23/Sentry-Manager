'use strict';

// Who a request comes from, and whether that is the home network.
//
// The address is the connection's own (the socket), with ::ffff: taken off
// IPv4 addresses. Only with TRUST_PROXY, and only when the connection itself
// comes from a trusted proxy (an address on the local network, or one listed
// in TRUSTED_PROXIES), does X-Forwarded-For count: then the client is the
// rightmost address in it that is not a trusted proxy. Everything left of
// that was sent by the client and could say anything (an internet client can
// send "X-Forwarded-For: 192.168.1.5"; the proxy adds the real address to the
// right of it). From any other connection the header is ignored, so nobody
// can make themselves look like the home network by sending it.
//
// The home network: loopback, the private IPv4 ranges (10/8, 172.16/12,
// 192.168/16), link-local (169.254/16, fe80::/10) and IPv6 unique local
// addresses (fc00::/7). Tailscale's range (100.64/10, which is also the
// carriers' shared NAT range, and fd7a:115c:a1e0::/48) only when the setting
// says so, and any extra ranges an admin lists.

const net = require('net');

const LOCAL_V4 = [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16]];
const LOCAL_V6 = [['::1', 128], ['fc00::', 7], ['fe80::', 10]];
const TAILSCALE = [['100.64.0.0', 10, 'ipv4'], ['fd7a:115c:a1e0::', 48, 'ipv6']];

const familyOf = (ip) => (net.isIPv6(ip) ? 'ipv6' : 'ipv4');

/**
 * One spelling of an address as it arrives in a socket or a header: no
 * brackets or port, no ::ffff: on IPv4, IPv6 lower-case and shortened.
 * Not an address: null.
 */
function normalizeIp(value) {
  let s = String(value ?? '').trim();
  if (!s || s.length > 100) return null;
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracket) s = bracket[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.replace(/:\d+$/, '');
  s = s.replace(/%[A-Za-z0-9_.-]+$/, ''); // a zone (fe80::1%eth0)
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(s)) s = s.slice(7);
  if (!net.isIP(s)) return null;
  if (net.isIPv4(s)) return s;
  try {
    const out = new net.SocketAddress({ address: s, family: 'ipv6' }).address.toLowerCase();
    // ::ffff:7f00:1 is 127.0.0.1 written another way
    const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(out);
    if (dotted) return dotted[1];
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(out);
    if (mapped) {
      const hi = parseInt(mapped[1], 16);
      const lo = parseInt(mapped[2], 16);
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
    return out;
  } catch {
    return null;
  }
}

/** An address or a range (a.b.c.d/n, x::/n) as { address, prefix, family }, or null. */
function parseCidr(value) {
  const text = String(value ?? '').trim();
  const m = /^(.+?)(?:\/(\d{1,3}))?$/.exec(text);
  if (!m) return null;
  const address = normalizeIp(m[1]);
  if (!address) return null;
  const family = familyOf(address);
  const max = family === 'ipv4' ? 32 : 128;
  const prefix = m[2] === undefined ? max : Number(m[2]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { address, prefix, family, text: prefix === max ? address : `${address}/${prefix}` };
}

function blockList(ranges) {
  const list = new net.BlockList();
  for (const [address, prefix, family = familyOf(address)] of ranges) list.addSubnet(address, prefix, family);
  return list;
}
const LOCAL = blockList([...LOCAL_V4, ...LOCAL_V6]);

/** Loopback, private, link-local or unique local: the local network. */
function isLocalNetwork(ip) {
  const a = normalizeIp(ip);
  return Boolean(a) && LOCAL.check(a, familyOf(a));
}

/**
 * Which connections may tell us the client's address: TRUSTED_PROXIES (a
 * list of addresses and ranges) when given, else the local network.
 */
function proxyMatcher(list = '') {
  const entries = String(list || '').split(/[\s,]+/).filter(Boolean);
  if (!entries.length) return isLocalNetwork;
  const ranges = entries.map((e) => {
    const c = parseCidr(e);
    if (!c) throw new Error(`TRUSTED_PROXIES: "${e}" is not an address or a range.`);
    return [c.address, c.prefix, c.family];
  });
  const bl = blockList(ranges);
  return (ip) => {
    const a = normalizeIp(ip);
    return Boolean(a) && bl.check(a, familyOf(a));
  };
}

/** The X-Forwarded-For hops, left (the first client) to right (the last proxy). */
function forwardedHops(req) {
  const raw = req.headers?.['x-forwarded-for'];
  const text = Array.isArray(raw) ? raw.join(',') : String(raw || '');
  return text.split(',').map((h) => h.trim()).filter(Boolean).slice(-50);
}

/** The socket's own address (no ::ffff:), or null. */
const socketAddress = (req) => normalizeIp(req.socket?.remoteAddress);

/**
 * The client's address for every decision (sign-in throttling, bans, the
 * home network, the audit log). A hop that is not an address ends the walk
 * (it is reported cleaned, and never counts as home).
 *
 * @param {{ trustProxy?: boolean, trusted?: (ip: string) => boolean }} o
 */
function clientAddress(req, { trustProxy = false, trusted = isLocalNetwork } = {}) {
  const sock = socketAddress(req);
  if (!sock) return '?';
  if (!trustProxy || !trusted(sock)) return sock;
  const hops = forwardedHops(req);
  for (let i = hops.length - 1; i >= 0; i--) {
    const ip = normalizeIp(hops[i]);
    if (!ip) return `unknown(${hops[i].replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 40)})`;
    if (!trusted(ip)) return ip;
    if (i === 0) return ip; // every hop a proxy on the local network: the first is the client
  }
  return sock;
}

/** Whether a header the proxy sets (X-Forwarded-Proto, -Host) may be believed. */
function fromTrustedProxy(req, { trustProxy = false, trusted = isLocalNetwork } = {}) {
  const sock = socketAddress(req);
  return Boolean(trustProxy && sock && trusted(sock));
}

/**
 * The home-network test for these settings:
 * { tailscale: boolean, extra: ['192.0.2.0/24', ...] }.
 */
function homeMatcher({ tailscale = false, extra = [] } = {}) {
  const ranges = [...LOCAL_V4, ...LOCAL_V6];
  if (tailscale) ranges.push(...TAILSCALE);
  for (const e of extra || []) {
    const c = parseCidr(e);
    if (c) ranges.push([c.address, c.prefix, c.family]);
  }
  const bl = blockList(ranges);
  return (ip) => {
    const a = normalizeIp(ip);
    return Boolean(a) && bl.check(a, familyOf(a));
  };
}

/** The key bans count by: the address, or for IPv6 its /64 (one home or one server's whole block). */
function banKey(ip) {
  const a = normalizeIp(ip);
  if (!a) return String(ip || '?').slice(0, 64);
  if (net.isIPv4(a)) return a;
  // expanded, the first four groups
  const full = expandV6(a);
  return `${normalizeIp(`${full.slice(0, 4).join(':')}::`)}/64`;
}

function expandV6(a) {
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => g || '0');
}

module.exports = { normalizeIp, parseCidr, isLocalNetwork, proxyMatcher, clientAddress, fromTrustedProxy, homeMatcher, banKey, forwardedHops };
