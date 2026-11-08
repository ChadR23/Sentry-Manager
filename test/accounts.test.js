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

test('watch-only accounts: exports and stars yes; settings, places and deleting no', () => {
  assert.equal(viewerMay('POST', '/api/exports'), true);
  assert.equal(viewerMay('POST', '/api/vehicles/car/exports'), true);
  assert.equal(viewerMay('DELETE', '/api/exports/abc'), true);
  assert.equal(viewerMay('POST', '/api/notifications/read'), true);
  assert.equal(viewerMay('POST', '/api/stars'), true);
  assert.equal(viewerMay('POST', '/api/places'), false, 'places are for admins');
  assert.equal(viewerMay('GET', '/api/places'), true);
  assert.equal(viewerMay('POST', '/api/settings'), false);
  assert.equal(viewerMay('POST', '/api/vehicles/car/trash'), false);
  assert.equal(viewerMay('POST', '/api/vehicles/car/trash-days'), false, 'no Delete this day (nor its CAN data)');
  assert.equal(viewerMay('POST', '/api/vehicles/car/trash-preview'), false);
  assert.equal(viewerMay('POST', '/api/can/keep'), false);
  assert.equal(viewerMay('GET', '/api/logs'), false);
  assert.equal(viewerMay('GET', '/api/vehicles'), true);
  assert.equal(viewerMay('GET', '/api/can/settings'), false, 'the Nerd settings are for admins');
  assert.equal(viewerMay('GET', '/api/can/files'), false, 'the CAN log list is for admins');
  assert.equal(viewerMay('GET', '/api/can/tokens'), false, 'tokens are for admins');
  assert.equal(viewerMay('GET', '/api/can/pairing/aaaaaa000001'), false, 'pairing is for admins');
  assert.equal(viewerMay('POST', '/api/can/tokens'), false);
  assert.equal(viewerMay('DELETE', '/api/can/tokens/abc'), false);
  assert.equal(viewerMay('POST', '/api/can/pairing/aaaaaa000001/trust'), false);
  for (const p of ['/api/can/signals', '/api/can/clip', '/api/can/raw', '/api/can/search', '/api/can/id-events', '/api/can/vehicle-signals']) {
    assert.equal(viewerMay('GET', p), true, `${p}: what the Viewer shows`);
  }
  assert.equal(viewerMay('PUT', '/api/dashboards'), true, 'their own Viewer dashboards');
  assert.equal(viewerMay('POST', '/api/can/enable'), false);
  assert.equal(viewerMay('DELETE', '/api/can/files/x.log.xz'), false);
  // the CAN downloads (raw logs, bundles, decoded CSV, new ids) are for admins
  for (const p of ['/api/can/files/x_20260101T000000Z_1.log.xz/download', '/api/can/files/x_20260101T000000Z_1.log.xz.json/download', '/api/can/export/bundle', '/api/can/export/decoded', '/api/can/export/new-ids', '/api/can/export']) {
    assert.equal(viewerMay('GET', p), false, `${p}: admins only`);
    assert.equal(viewerMay('HEAD', p), false, `${p}: admins only`);
  }
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
