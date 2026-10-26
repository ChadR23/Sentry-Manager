'use strict';

// Discovery adds clips to a job a few at a time. Each addition used to
// rewrite the whole job file (job.json, MBs for a large archive) and sync
// it to disk; on hard disks that kept every other step waiting for as long
// as discovery lasted. New clips are journal lines now, like progress.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createHarness } = require('./fixtures/lanesHarness');
const { createJobStore } = require('../src/main/converter/jobStore');

test('discovering clips appends them to the journal; the job file is not rewritten for each', async () => {
  const realOpen = fs.promises.open;
  let fullWrites = 0;
  fs.promises.open = async (file, ...rest) => {
    if (String(file).endsWith('job.json.tmp')) fullWrites += 1;
    return realOpen.call(fs.promises, file, ...rest);
  };
  const h = createHarness({ clips: 400 });
  try {
    const id = await h.service.start(h.config({ concurrency: 2 }));
    const job = await h.finishJob(id, 120_000);
    assert.equal(job.items.filter((item) => item.resultCode === 'converted').length, 400);
    // every clip found and converted: a full write only when the journal fills (1,000 records)
    assert.ok(fullWrites <= 6, `${fullWrites} full writes of the job file for 400 clips`);
    // the job as it was, from job.json and the journal, after a restart
    const again = await createJobStore({ rootDir: path.join(h.dir, 'jobs'), fs: fs.promises }).load(id);
    assert.equal(again.items.length, job.items.length);
    assert.deepEqual(again.items.map((item) => [item.id, item.state, item.resultCode]), job.items.map((item) => [item.id, item.state, item.resultCode]));
    assert.equal(again.revision, job.revision);
  } finally {
    fs.promises.open = realOpen;
    await h.close();
  }
});

test('a journal line that adds clips is checked like the rest: a damaged one is refused', async () => {
  const h = createHarness({ clips: 3, keep: true });
  try {
    const id = await h.service.start(h.config({ concurrency: 1 }));
    await h.finishJob(id, 60_000);
    await h.close();
    const journal = fs.readdirSync(path.join(h.dir, 'jobs', id)).find((name) => name === 'job.journal');
    if (!journal) return; // (compacted: nothing to damage)
    const file = path.join(h.dir, 'jobs', id, journal);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const withAdd = lines.findIndex((line) => JSON.parse(line).add);
    assert.ok(withAdd >= 0, 'clips were added by journal lines');
    const record = JSON.parse(lines[withAdd]);
    record.add = 'not a list';
    lines[withAdd] = JSON.stringify(record);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    await assert.rejects(createJobStore({ rootDir: path.join(h.dir, 'jobs'), fs: fs.promises }).load(id), (err) => typeof err.code === 'string');
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});
