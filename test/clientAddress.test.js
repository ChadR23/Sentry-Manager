'use strict';

// The client address every security decision uses: the socket's own, and
// X-Forwarded-For only from a trusted proxy (TRUST_PROXY and a connection
// from the local network or TRUSTED_PROXIES), read from the right.

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIp, parseCidr, isLocalNetwork, proxyMatcher, clientAddress, fromTrustedProxy, homeMatcher, banKey } = require('../server/clientAddress');

const req = (from, xff, extra = {}) => ({ socket: { remoteAddress: from }, headers: { ...(xff !== undefined ? { 'x-forwarded-for': xff } : {}), ...extra } });
const proxied = { trustProxy: true };

test('addresses: ::ffff: taken off, brackets and ports dropped, IPv6 in one spelling, junk refused', () => {
  assert.equal(normalizeIp('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeIp('::FFFF:7f00:1'), '127.0.0.1');
  assert.equal(normalizeIp('[2001:DB8:0:0::1]:443'), '2001:db8::1');
  assert.equal(normalizeIp('198.51.100.7:51234'), '198.51.100.7');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  for (const junk of ['', 'unknown', '1.2.3', '<script>', 'a'.repeat(200), null]) assert.equal(normalizeIp(junk), null, String(junk));
  assert.deepEqual(parseCidr('10.1.0.0/16'), { address: '10.1.0.0', prefix: 16, family: 'ipv4', text: '10.1.0.0/16' });
  assert.equal(parseCidr('10.1.0.0/33'), null);
  assert.equal(parseCidr('2001:db8::/48').text, '2001:db8::/48');
});

test('the local network: loopback, private, link-local, unique local; not CGNAT/Tailscale, not public', () => {
  for (const ip of ['127.0.0.1', '10.2.3.4', '172.16.0.1', '172.31.255.254', '192.168.1.5', '169.254.1.1', '::1', 'fd00::5', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isLocalNetwork(ip), true, ip);
  for (const ip of ['100.64.0.1', '100.100.100.100', '172.32.0.1', '8.8.8.8', '203.0.113.9', '2001:db8::1', 'fd7b::1'.replace('fd7b', '2600'), 'junk']) assert.equal(isLocalNetwork(ip), false, ip);
});

test('without TRUST_PROXY the socket is the client, whatever X-Forwarded-For says', () => {
  assert.equal(clientAddress(req('203.0.113.9', '192.168.1.5')), '203.0.113.9');
  assert.equal(clientAddress(req('::ffff:198.51.100.7', '127.0.0.1')), '198.51.100.7');
  assert.equal(clientAddress(req('127.0.0.1', '203.0.113.9')), '127.0.0.1', 'not even from loopback');
  assert.equal(clientAddress(req(undefined)), '?');
});

test('TRUST_PROXY: a spoofed X-Forwarded-For from an internet connection is not trusted', () => {
  // someone on the internet talks to the port directly and claims to be at home
  assert.equal(clientAddress(req('203.0.113.9', '192.168.1.5'), proxied), '203.0.113.9');
  assert.equal(clientAddress(req('2001:db8::66', '127.0.0.1, 10.0.0.1'), proxied), '2001:db8::66');
  assert.equal(fromTrustedProxy(req('203.0.113.9'), proxied), false, 'its X-Forwarded-Proto does not count either');
  assert.equal(clientAddress(req('100.70.1.2', '192.168.1.5'), proxied), '100.70.1.2', 'a Tailscale/CGNAT address is no proxy by default');
});

test('TRUST_PROXY: the forwarded address from a proxy on the local network is used, read from the right', () => {
  assert.equal(clientAddress(req('172.17.0.1', '203.0.113.9'), proxied), '203.0.113.9');
  assert.equal(clientAddress(req('::ffff:172.17.0.1', '::ffff:198.51.100.7'), proxied), '198.51.100.7');
  // the client sent "192.168.1.5" itself; the proxy added the real address on the right
  assert.equal(clientAddress(req('172.17.0.1', '192.168.1.5, 203.0.113.9'), proxied), '203.0.113.9');
  // two proxies on the local network: the rightmost address that is not one of them
  assert.equal(clientAddress(req('127.0.0.1', '1.1.1.1, 203.0.113.9, 10.0.0.2'), proxied), '203.0.113.9');
  // a device at home through the proxy: home
  assert.equal(clientAddress(req('172.17.0.1', '192.168.1.20'), proxied), '192.168.1.20');
  assert.equal(clientAddress(req('172.17.0.1', '10.0.0.5, 192.168.1.20'), proxied), '10.0.0.5');
  // several headers count as one list
  assert.equal(clientAddress(req('172.17.0.1', ['192.168.1.5', '203.0.113.9']), proxied), '203.0.113.9');
  // no header: the proxy itself
  assert.equal(clientAddress(req('172.17.0.1'), proxied), '172.17.0.1');
  // a hop that is not an address ends the walk, and is never home
  const odd = clientAddress(req('172.17.0.1', '192.168.1.5, <evil>'), proxied);
  assert.match(odd, /^unknown\(/);
  assert.equal(homeMatcher()(odd), false);
  assert.equal(fromTrustedProxy(req('172.17.0.1'), proxied), true);
  assert.equal(fromTrustedProxy(req('172.17.0.1'), { trustProxy: false }), false);
});

test('TRUSTED_PROXIES: only the listed proxies may forward an address', () => {
  const trusted = proxyMatcher('10.0.0.2, 100.64.0.0/10');
  const o = { trustProxy: true, trusted };
  assert.equal(clientAddress(req('10.0.0.2', '203.0.113.9'), o), '203.0.113.9');
  assert.equal(clientAddress(req('100.101.1.1', '203.0.113.9'), o), '203.0.113.9', 'a proxy reached over Tailscale');
  assert.equal(clientAddress(req('127.0.0.1', '192.168.1.5'), o), '127.0.0.1', 'loopback is not listed: its header is ignored');
  assert.equal(clientAddress(req('10.0.0.3', '8.8.8.8'), o), '10.0.0.3');
  assert.throws(() => proxyMatcher('nonsense'), /TRUSTED_PROXIES/);
  assert.equal(proxyMatcher(''), isLocalNetwork);
});

test('the home network: local ranges always, Tailscale and extra ranges only when set', () => {
  const plain = homeMatcher();
  assert.equal(plain('192.168.1.5'), true);
  assert.equal(plain('::ffff:10.1.1.1'), true);
  assert.equal(plain('100.101.1.1'), false);
  assert.equal(plain('203.0.113.9'), false);
  const ts = homeMatcher({ tailscale: true });
  assert.equal(ts('100.101.1.1'), true);
  assert.equal(ts('fd7a:115c:a1e0::1234'), true);
  const extra = homeMatcher({ extra: ['198.51.100.0/24', '2001:db8:aa::/48', '203.0.113.77'] });
  assert.equal(extra('198.51.100.200'), true);
  assert.equal(extra('2001:db8:aa:1::5'), true);
  assert.equal(extra('203.0.113.77'), true);
  assert.equal(extra('203.0.113.78'), false);
});

test('ban keys: an IPv4 address, or an IPv6 /64', () => {
  assert.equal(banKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(banKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(banKey('2001:db8:1:2:bbbb::9'), '2001:db8:1:2::/64');
  assert.equal(banKey('2001:db8::1'), '2001:db8::/64');
});
