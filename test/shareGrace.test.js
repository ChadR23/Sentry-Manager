'use strict';

// A footage share that drops is retried quietly; only one still down after
// the grace time raises the offline alert (server/activity.js syncShare).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Notifications } = require('../server/activity');

function fakeDb() {
  const open = new Map();
  return {
    open,
    notify: (n) => { open.set(n.dedupeKey, n); return 1; },
    resolve: (key) => { open.delete(key); },
    resolveId() {}
  };
}

test('a share back within the grace time raises nothing; one still down raises the alert, and it clears when it is back', async () => {
  const db = fakeDb();
  const notes = new Notifications({ db, shareGraceMs: 80 });
  const car = { id: 'car', name: 'Daily Driver' };
  const down = { healthy: false, lastError: 'Host is down', hint: 'Is the NAS on?' };
  notes.syncShare(car, down);
  assert.equal(db.open.has('share:car'), false, 'not straight away');
  notes.syncShare(car, { healthy: true, writable: true });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(db.open.has('share:car'), false, 'a short drop: nothing');

  notes.syncShare(car, down);
  await new Promise((r) => setTimeout(r, 120));
  const alert = db.open.get('share:car');
  assert.ok(alert, 'still down after the grace time');
  assert.equal(alert.level, 'critical');
  assert.match(alert.message, /Not reachable for 0 minutes; still retrying\. Host is down Is the NAS on\?/);
  notes.syncShare(car, { healthy: true, writable: true });
  assert.equal(db.open.has('share:car'), false, 'back: resolved');
});

test('notification rules: a kind turned off is not raised; the others are', () => {
  const raised = [];
  const store = new Map([['notify-muted', ['storage']]]);
  const db = { get: (k, d) => (store.has(k) ? store.get(k) : d), notify: (n) => { raised.push(n.kind); return raised.length; }, resolve() {} };
  const notes = new Notifications({ db });
  assert.equal(notes.raise({ kind: 'storage', title: 'full' }), null);
  notes.raise({ kind: 'share', title: 'offline' });
  assert.deepEqual(raised, ['share']);
});
