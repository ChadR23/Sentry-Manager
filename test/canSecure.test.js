'use strict';
// Uploads on the CAN port (which may be open to the internet): HTTPS is the
// connection's own, or a forwarded "https" from a proxy on the local network,
// never a forwarded header from an internet address.
const test = require('node:test');
const assert = require('node:assert/strict');
const { canUploadSecure } = require('../server/canSecure');

const CAN = 10000;
const forwarded = (req) => String(req.headers['x-forwarded-proto'] || '') === 'https'; // TRUST_PROXY on
const req = (port, from, { encrypted = false, proto = 'https' } = {}) => ({ socket: { localPort: port, remoteAddress: from, encrypted }, headers: { 'x-forwarded-proto': proto } });
const ok = (r) => canUploadSecure(r, { canPort: CAN, isSecure: forwarded });

test('CAN port: an encrypted connection is HTTPS from anywhere', () => {
  assert.equal(ok(req(CAN, '203.0.113.9', { encrypted: true, proto: '' })), true);
});

test('CAN port: a forwarded "https" from an internet address is not HTTPS', () => {
  for (const from of ['203.0.113.9', '::ffff:198.51.100.7', '2001:db8::1', '8.8.8.8']) assert.equal(ok(req(CAN, from)), false, from);
});

test('CAN port: a forwarded "https" from a proxy on the local network still is', () => {
  for (const from of ['127.0.0.1', '::ffff:192.168.1.5', '10.0.0.2', '172.17.0.1', '::1', 'fd00::5']) assert.equal(ok(req(CAN, from)), true, from);
  assert.equal(ok(req(CAN, '192.168.1.5', { proto: 'http' })), false, 'plain HTTP from the local network');
  assert.equal(ok(req(CAN, '')), false, 'no address');
});

test('web port: the usual rule, unchanged', () => {
  assert.equal(ok(req(9000, '203.0.113.9')), true);
  assert.equal(ok(req(9000, '203.0.113.9', { proto: 'http' })), false);
});
