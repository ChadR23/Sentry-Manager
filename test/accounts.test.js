'use strict';

// Accounts: what a watch-only account may do, and recovery codes typed with
// or without the dash.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccounts, viewerMay, totp } = require('../server/accounts');

function memoryDb() {
  const kv = new Map();
  const users = [{ username: 'admin', created_at: 1 }];
  return {
    get: (k, fb = null) => (kv.has(k) ? kv.get(k) : fb),
    set: (k, v) => kv.set(k, v),
    listUsers: () => users,
    getUser: (u) => users.find((x) => x.username === u) || null,
    deleteUser: (u) => users.splice(users.findIndex((x) => x.username === u), 1)
  };
}

test('watch-only accounts: exports, stars and places yes; settings and deleting no', () => {
  assert.equal(viewerMay('POST', '/api/exports'), true);
  assert.equal(viewerMay('POST', '/api/vehicles/car/exports'), true);
  assert.equal(viewerMay('DELETE', '/api/exports/abc'), true);
  assert.equal(viewerMay('POST', '/api/notifications/read'), true);
  assert.equal(viewerMay('POST', '/api/stars'), true);
  assert.equal(viewerMay('POST', '/api/settings'), false);
  assert.equal(viewerMay('POST', '/api/vehicles/car/trash'), false);
  assert.equal(viewerMay('GET', '/api/logs'), false);
  assert.equal(viewerMay('GET', '/api/vehicles'), true);
  assert.equal(viewerMay('GET', '/api/can/settings'), false, 'the Nerd settings are for admins');
  assert.equal(viewerMay('PUT', '/api/dashboards'), true, 'their own Viewer dashboards');
  assert.equal(viewerMay('POST', '/api/can/enable'), false);
  assert.equal(viewerMay('DELETE', '/api/can/files/x.log.xz'), false);
});

test('two-step sign-in: a code is used once; recovery codes work with or without the dash, once each', () => {
  let now = Date.UTC(2026, 10, 7, 12);
  const acc = createAccounts({ db: memoryDb(), now: () => now });
  const { secret } = acc.startTotp('admin');
  const codes = acc.enableTotp('admin', totp(secret, Math.floor(now / 30000)));
  assert.equal(codes.length, 10);
  assert.match(codes[0], /^[0-9a-f]{5}-[0-9a-f]{5}$/);
  now += 30000;
  const code = totp(secret, Math.floor(now / 30000));
  assert.equal(acc.verifyCode('admin', code), true);
  assert.equal(acc.verifyCode('admin', code), false, 'the same code again');
  assert.equal(acc.verifyCode('admin', codes[0].replace('-', '')), true, 'without the dash');
  assert.equal(acc.verifyCode('admin', codes[0]), false, 'used already');
  assert.equal(acc.verifyCode('admin', ` ${codes[1].toUpperCase().replace('-', ' ')} `), true, 'a space and capitals');
  assert.equal(acc.recoveryLeft('admin'), 8);
});
