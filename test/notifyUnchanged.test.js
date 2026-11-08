'use strict';

// A warning raised again unchanged (the archive check runs about ten times an
// hour) is left as it is: no new time, no 'changed' sent to every open page.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ManagerDB } = require('../server/db');
const { Notifications } = require('../server/activity');

test('raising the same open warning again changes nothing and sends nothing; a changed one does', async () => {
  const db = new ManagerDB(':memory:');
  const notes = new Notifications({ db });
  const sent = [];
  notes.on('changed', (id) => sent.push(id));
  const n = { kind: 'archive', level: 'warning', vehicleId: null, title: 'Car: Sat 7 Nov looks only partly archived', message: 'About 3 minutes ...', dedupeKey: 'archive:car:2026-11-07' };
  const id = notes.raise(n);
  assert.equal(sent.length, 1);
  const first = db.notifications({ open: true })[0];
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(notes.raise({ ...n }), id, 'the same id, so the caller knows it is raised');
  assert.equal(sent.length, 1, 'nothing sent for the same warning');
  assert.equal(db.notifications({ open: true })[0].updatedAt, first.updatedAt);
  assert.equal(notes.raise({ ...n, message: 'About 4 minutes ...' }), id);
  assert.equal(sent.length, 2);
  assert.equal(db.notifications({ open: true })[0].message, 'About 4 minutes ...');
  assert.ok(db.notifications({ open: true })[0].updatedAt > first.updatedAt);
});
