'use strict';

// Live job snapshots: a working job sends at most one every 250 ms (the
// latest wins), the end of a job (or a pause, an outage, a recovery or a
// failure) goes out at once, and nothing is prepared while no window listens.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHarness, sleep } = require('./fixtures/lanesHarness');

test('a busy job sends at most one snapshot every 250 ms, and its end at once', async () => {
  const h = createHarness({ clips: 12, behave: () => 'hold' });
  const events = [];
  const unsubscribe = h.service.subscribe((event) => {
    if (event.type === 'snapshot') events.push({ at: Date.now(), state: event.snapshot.state, revision: event.revision });
  });
  try {
    const id = await h.service.start(h.config({ concurrency: 3 }));
    // release the encodes a few at a time, over a second or so
    const done = h.service.whenIdle(id);
    let finished = false;
    done.then(() => { finished = true; });
    while (!finished) {
      const [first] = h.held();
      if (first) first.finish(0);
      await sleep(15);
    }
    const job = await h.service.get(id);
    assert.equal(job.state, 'completed');
    assert.ok(events.length >= 2);
    const last = events.at(-1);
    assert.equal(last.state, 'completed', 'the final state is always sent');
    assert.equal(last.revision, job.revision, 'and it is the latest');
    // every snapshot but the last (the job's end, sent at once) came 250 ms
    // or more after the one before it
    for (let index = 1; index < events.length - 1; index += 1) {
      assert.ok(events[index].at - events[index - 1].at >= 240, `snapshots ${index - 1} and ${index} ${events[index].at - events[index - 1].at} ms apart`);
    }
    assert.ok(events.length < job.revision / 3, `${events.length} snapshots for ${job.revision} job-file changes`);
  } finally {
    unsubscribe();
    await h.close();
  }
});

test('the live-update bridge prepares nothing while no window listens', async () => {
  const { registerConverterIpc } = require('../src/main/converter/ipc');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-live-ipc-'));
  let listener = null;
  const ipcMain = { handle: () => {}, removeHandler: () => {} };
  const registration = registerConverterIpc({
    ipcMain, dialog: { showOpenDialog: async () => ({ canceled: true }) },
    service: { subscribe: (fn) => { listener = fn; return () => {}; }, list: async () => [] },
    capabilities: { replacement: 'available' }
  });
  try {
    let read = 0;
    const snapshot = new Proxy({ id: 'job-1', state: 'encoding', items: [] }, {
      get: (target, key) => { read += 1; return target[key]; },
      ownKeys: (target) => { read += 1; return Reflect.ownKeys(target); }
    });
    listener({ type: 'snapshot', jobId: 'job-1', revision: 3, snapshot });
    listener({ type: 'progress', jobId: 'job-1', revision: 3, progress: { fps: 10 } });
    assert.equal(read, 0, 'the snapshot was not even looked at');
  } finally {
    registration?.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
