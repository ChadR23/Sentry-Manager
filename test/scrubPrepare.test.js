'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScrubPrepare } = require('../server/scrubPrepare');

const HOUR = 3600_000;
const NOW = Date.parse('2026-11-07T12:00:00Z');

function setup(extra = {}) {
  const file = (rel, day, ageMs, size = 1000) => [rel, { rel, kind: 'clip', day, size, mtimeMs: NOW - ageMs }];
  const files = new Map([
    file('RecentClips/2026-11-07_10-00-00-front.mp4', '2026-11-07', 2 * HOUR),
    file('RecentClips/2026-11-07_10-01-00-front.mp4', '2026-11-07', 2 * HOUR),
    file('RecentClips/2026-11-07_11-59-00-front.mp4', '2026-11-07', 30_000), // still copying
    file('RecentClips/2026-11-05_09-00-00-back.mp4', '2026-11-05', 50 * HOUR),
    file('RecentClips/2026-11-01_09-00-00-back.mp4', '2026-11-01', 150 * HOUR), // an older day
    ['RecentClips/event.json', { rel: 'RecentClips/event.json', kind: 'asset', day: '2026-11-07', size: 10, mtimeMs: 0 }]
  ]);
  const asked = [];
  const scrubFrames = { get: async (p, opts) => { asked.push({ p, opts }); return `${p}.jpg`; } };
  const vehicles = { list: () => [{ id: 'car' }], rootOf: () => '/footage' };
  const inventory = { get: () => ({ files }) };
  return { asked, files, prep: createScrubPrepare({ inventory, vehicles, scrubFrames, pauseMs: 0, now: () => NOW, ...extra }) };
}

test('previews of the newest days are made ahead, newest first, in the background; clips still copying wait', async () => {
  const { asked, prep } = setup();
  await prep.kick();
  assert.deepEqual(asked.map((a) => a.p), [
    '/footage/RecentClips/2026-11-07_10-01-00-front.mp4',
    '/footage/RecentClips/2026-11-07_10-00-00-front.mp4',
    '/footage/RecentClips/2026-11-05_09-00-00-back.mp4'
  ]);
  for (const a of asked) assert.deepEqual(a.opts, { urgent: false, next: false, touch: false }, 'behind anything opened, and the cache order untouched');
  await prep.kick();
  assert.equal(asked.length, 3, 'nothing again when nothing changed');
});

test('`max` is a total, not per pass: later scans never creep on to older clips', async () => {
  const { asked, prep } = setup({ max: 2 });
  await prep.kick();
  assert.deepEqual(asked.map((a) => a.p), [
    '/footage/RecentClips/2026-11-07_10-01-00-front.mp4',
    '/footage/RecentClips/2026-11-07_10-00-00-front.mp4'
  ]);
  await prep.kick();
  await prep.kick();
  assert.equal(asked.length, 2, 'the older clip beyond the newest 2 is never started');
});

test('a scan that brought nothing new starts no pass', async () => {
  const { asked, files, prep } = setup();
  await prep.kick();
  const n = asked.length;
  for (let i = 0; i < 3; i++) await prep.kick();
  assert.equal(asked.length, n);
  // a new clip arrives: only it is prepared
  files.set('RecentClips/2026-11-07_10-02-00-front.mp4', { rel: 'RecentClips/2026-11-07_10-02-00-front.mp4', kind: 'clip', day: '2026-11-07', size: 1000, mtimeMs: NOW - HOUR });
  await prep.kick();
  assert.deepEqual(asked.slice(n).map((a) => a.p), ['/footage/RecentClips/2026-11-07_10-02-00-front.mp4']);
});

test('a changed clip is prepared again; 0 days turns it off; it waits while the server is busy', async () => {
  const { asked, files, prep } = setup();
  await prep.kick();
  files.get('RecentClips/2026-11-07_10-00-00-front.mp4').size = 600; // converted
  await prep.kick();
  assert.equal(asked.at(-1).p, '/footage/RecentClips/2026-11-07_10-00-00-front.mp4');
  assert.equal(asked.length, 4);

  const off = setup({ days: 0 });
  await off.prep.kick();
  assert.equal(off.asked.length, 0);

  let busy = true;
  const waiting = setup({ idle: () => !busy });
  const run = waiting.prep.kick();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(waiting.asked.length, 0, 'nothing while converting');
  busy = false;
  waiting.prep.stop();
  await run;
});
