'use strict';

// A finished job is not kept in memory: its clip list (tens of MB for a
// large job) lives on disk only, and the frequent questions (which job is
// current, is one running) are answered from cached summaries that are only
// read again when a job's files change. Kept for every job ever run, they
// grew the server past a gigabyte.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHarness, CPU } = require('./fixtures/lanesHarness');

test('a finished job: summaries count its clips without listing them, the whole job still loads, nothing is read again while nothing changes', async () => {
  const h = createHarness({ clips: 3, devices: [CPU], defaultDevice: null, gpuDecode: false, works: (e) => e.startsWith('lib') });
  try {
    const id = await h.service.start(h.config({ concurrency: 1 }));
    const job = await h.finishJob(id);
    assert.equal(job.state, 'completed');
    const videos = job.items.filter((i) => i.kind === 'video').length;
    assert.ok(videos > 0);

    // the converter no longer holds it: not among the live jobs
    for (let i = 0; i < 50 && h.service.liveJobs().some((j) => j.id === id); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.service.liveJobs().some((j) => j.id === id), false, 'let go once it ended');

    // a summary: counts, no clips
    const [summary] = (await h.service.listSummaries()).filter((j) => j.id === id);
    assert.equal(summary.state, 'completed');
    assert.deepEqual(summary.items, []);
    assert.equal(summary.itemCounts.converted, videos);
    assert.equal(summary.progressClips, videos);
    assert.equal(summary.itemTotal, job.items.length);

    // the whole job, clips and all, from disk
    const whole = await h.service.get(id);
    assert.equal(whole.items.length, job.items.length);

    // asked again with nothing changed: the job file is not read again
    const reads = [];
    const realRead = fs.promises.readFile;
    const realOpen = fs.promises.open;
    fs.promises.open = async (p, ...rest) => { if (String(p).endsWith('.json')) reads.push(String(p)); return realOpen(p, ...rest); };
    fs.promises.readFile = async (p, ...rest) => { if (String(p).endsWith('.json')) reads.push(String(p)); return realRead(p, ...rest); };
    try {
      const again = (await h.service.listSummaries()).find((j) => j.id === id);
      assert.equal(again.itemCounts.converted, videos);
    } finally {
      fs.promises.readFile = realRead;
      fs.promises.open = realOpen;
    }
    assert.deepEqual(reads, [], 'answered from the cached summary');
  } finally {
    await h.close();
  }
});

test('the Encoder\'s current job comes whole, chosen from summaries', async () => {
  const { registerConverterIpc } = require('../src/main/converter/ipc');
  const handlers = new Map();
  const whole = { id: 'job-2', state: 'completed', updatedAt: 2, revision: 1, summaryDismissed: false, items: [{ id: 'item-000001' }], config: {} };
  let fullLists = 0;
  const service = {
    subscribe: () => () => {},
    list: async () => { fullLists++; return [whole]; },
    listSummaries: async () => [{ id: 'job-1', state: 'completed', updatedAt: 1, revision: 1, items: [], config: {} }, { ...whole, items: [] }],
    get: async (id) => (id === 'job-2' ? whole : null)
  };
  const registration = registerConverterIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    service,
    capabilities: { replacement: 'available' }
  });
  try {
    const out = await handlers.get('converter:getCurrent')({ sender: null }, undefined);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.value.id, 'job-2', 'the newest one');
    assert.equal(out.value.items.length, 1, 'with its clips');
    assert.equal(fullLists, 0, 'no job was read whole but the chosen one');
  } finally {
    registration.unregister();
  }
});
