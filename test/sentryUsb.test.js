'use strict';

// Sentry Six Manager's side of the Sentry USB archive share contract
// (docs/sentry-usb.md): the checksum record of originals replaced in place,
// a replacement that never leaves the original's name missing, converted
// output Sentry USB recognises, its files ignored, and its status file read.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const { createOriginalChecksums, locate, lineFor, parseRecord } = require('../server/originalChecksums');
const { createSentryUsbStatus, parseStatus, interpret, inRange, describe } = require('../server/sentryUsb');
const { classify } = require('../server/footage');
const { scanFootage } = require('../server/scanner');
const { analyze, stampSec } = require('../server/archiveGap');
const { createFileTransaction } = require('../src/main/converter/staging');
const { scanTeslaFootage } = require('../src/main/converter/scanner');
const { createPosixOwnedFs } = require('../server/posixOwnedFs');

const HELPER = path.join(REPO, 'build', 'noreplace-rename');
const helperSkip = fs.existsSync(HELPER) ? false : 'needs build/noreplace-rename';
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-usb-')));
const DAY = 86_400_000;

// ── the checksum record ────────────────────────────────────────────────────

test('record: the share root is the folder above RecentClips/SentryClips/SavedClips, with or without a TeslaCam level', () => {
  assert.deepEqual(locate('/footage/car/RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4', '/footage/car'),
    { root: '/footage/car', rel: 'RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4' });
  assert.deepEqual(locate('/footage/car/TeslaCam/SentryClips/2026-11-08_13-00-00/2026-11-08_12-59-00-back.mp4', '/footage/car'),
    { root: '/footage/car/TeslaCam', rel: 'SentryClips/2026-11-08_13-00-00/2026-11-08_12-59-00-back.mp4' });
  assert.deepEqual(locate('/footage/car/TeslaCam/RecentClips/2026-11-08_12-59-00-front.mp4', '/footage/car/TeslaCam/RecentClips'),
    { root: '/footage/car/TeslaCam', rel: 'RecentClips/2026-11-08_12-59-00-front.mp4' }, 'a job of one group folder still records at the share root');
  assert.deepEqual(locate('/footage/car/misc/clip.mp4', '/footage/car'), { root: '/footage/car', rel: 'misc/clip.mp4' }, 'no group folder: the job folder');
  assert.equal(lineFor('A'.repeat(64), 'RecentClips/x.mp4'), `${'a'.repeat(64)}  RecentClips/x.mp4\n`, 'lowercase hex, two spaces, LF');
  assert.throws(() => lineFor('a'.repeat(64), 'RecentClips/a\nb.mp4'));
  assert.throws(() => lineFor('xyz', 'RecentClips/a.mp4'));
});

test('record: appended, fsynced, folder created; concurrent appends are whole lines; a later line wins', async () => {
  const root = tmp();
  try {
    const share = path.join(root, 'car', 'TeslaCam');
    const clips = path.join(share, 'RecentClips', '2026-11-08');
    fs.mkdirSync(clips, { recursive: true });
    const rec = createOriginalChecksums({ allowedRoot: (dir) => dir.startsWith(path.join(root, 'car')) });
    const names = Array.from({ length: 40 }, (_, i) => `2026-11-08_12-${String(i).padStart(2, '0')}-00-front.mp4`);
    const hashes = names.map((n) => sha(Buffer.from(n)));
    // every line is fsynced before record() resolves
    const probe = await fsp.open(__filename, 'r');
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    const realSync = proto.sync;
    let syncs = 0;
    proto.sync = function sync(...args) { syncs++; return realSync.apply(this, args); };
    try {
      await Promise.all(names.map((n, i) => rec.record({ source: path.join(clips, n), sourceRoot: path.join(root, 'car'), sha256: hashes[i] })));
    } finally {
      proto.sync = realSync;
    }
    assert.ok(syncs >= 40 + 2, `each append fsynced, and the new folder and file (${syncs})`);
    const file = path.join(share, '.sentrymanager', 'original-checksums.sha256');
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.endsWith('\n'));
    const lines = text.split('\n').filter(Boolean);
    assert.equal(lines.length, 40, 'every append is one whole line');
    for (const line of lines) assert.match(line, /^[0-9a-f]{64} {2}RecentClips\/2026-11-08\/2026-11-08_12-\d{2}-00-front\.mp4$/);
    assert.deepEqual(new Set(parseRecord(text).map((x) => x.rel)), new Set(names.map((n) => `RecentClips/2026-11-08/${n}`)));
    // the same clip again (converted from a new upload): appended, the last one counts
    const rel = `RecentClips/2026-11-08/${names[0]}`;
    await rec.record({ source: path.join(clips, names[0]), sourceRoot: path.join(root, 'car'), sha256: 'b'.repeat(64) });
    const all = parseRecord(fs.readFileSync(file, 'utf8')).filter((x) => x.rel === rel);
    assert.deepEqual(all.map((x) => x.sha256), [hashes[0], 'b'.repeat(64)], 'never deduped: the later line wins for the reader');
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    assert.ok(!fs.readdirSync(path.join(share, '.sentrymanager')).some((n) => n.includes('.tmp-')), 'no temporary files left');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('record: pruning keeps at least 30 days (45), drops older lines by when they were written, not by the clip date', async () => {
  const root = tmp();
  try {
    const share = path.join(root, 'car');
    fs.mkdirSync(path.join(share, 'RecentClips'), { recursive: true });
    let clock = Date.UTC(2026, 0, 1, 12);
    const rec = createOriginalChecksums({ now: () => clock });
    const add = (name, h) => rec.record({ source: path.join(share, 'RecentClips', name), sourceRoot: share, sha256: h });
    // an old backlog clip converted on day 0, others over the following weeks
    await add('2020-05-05_10-00-00-front.mp4', '1'.repeat(64));
    await add('2026-01-01_10-00-00-front.mp4', '2'.repeat(64));
    for (let day = 1; day <= 60; day++) {
      clock = Date.UTC(2026, 0, 1, 12) + day * DAY;
      await add(`2026-01-${String(1 + (day % 28)).padStart(2, '0')}_11-00-00-front.mp4`, sha(Buffer.from(String(day))));
      const lines = parseRecord(fs.readFileSync(path.join(share, '.sentrymanager', 'original-checksums.sha256'), 'utf8'));
      // whatever was written in the last 30 days is always there
      const kept = new Set(lines.map((l) => l.sha256));
      for (let back = 0; back < 30 && day - back >= 1; back++) assert.ok(kept.has(sha(Buffer.from(String(day - back)))), `day ${day}: the line of day ${day - back} is kept`);
      if (day < 45) assert.ok(kept.has('1'.repeat(64)), `day ${day}: the backlog clip of day 0 is still kept (converted ${day} days ago)`);
    }
    const lines = parseRecord(fs.readFileSync(path.join(share, '.sentrymanager', 'original-checksums.sha256'), 'utf8'));
    assert.ok(!lines.some((l) => l.sha256 === '1'.repeat(64)), 'after 52+ days the oldest lines went');
    assert.ok(lines.length < 62 && lines.length >= 45, `pruned to the last weeks (${lines.length} lines)`);
    assert.ok(!fs.readdirSync(path.join(share, '.sentrymanager')).some((n) => n.includes('.tmp-')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── the replacement as Sentry USB sees it ─────────────────────────────────

function stagingEnv({ hook, failReplaceOver = false, noLinks = false } = {}) {
  const root = tmp();
  const share = path.join(root, 'car');
  const footage = path.join(share, 'TeslaCam', 'RecentClips', '2026-11-08');
  const tempRoot = path.join(root, 'tmp', 'sentry-six-converter');
  const snapshotFolder = path.join(root, 'tmp', 'sentry-six-verification-abc');
  for (const dir of [tempRoot, footage, snapshotFolder]) fs.mkdirSync(dir, { recursive: true });
  const conversion = Buffer.concat([Buffer.from('....hvc1'), crypto.randomBytes(150_000)]);
  const token = crypto.randomUUID();
  const snapshotPath = path.join(snapshotFolder, `${token}.mp4`);
  fs.writeFileSync(snapshotPath, conversion, { mode: 0o400 });
  const artifact = { path: snapshotPath, token, sha256: sha(conversion), size: conversion.length };
  const source = path.join(footage, '2026-11-08_12-59-00-front.mp4');
  const original = crypto.randomBytes(400_000);
  fs.writeFileSync(source, original, { mode: 0o644 });
  const stat = fs.lstatSync(source, { bigint: true });
  const expectedSource = { size: original.length, sha256: sha(original), device: String(stat.dev), inode: String(stat.ino) };
  const owned = createPosixOwnedFs({ helperPath: HELPER });
  // what a reader of the folder sees at every step the converter takes
  const views = [];
  const look = (step) => {
    const bytes = fs.existsSync(source) ? fs.readFileSync(source) : null;
    views.push({ step, at: bytes === null ? 'missing' : bytes.equals(original) ? 'original' : bytes.equals(conversion) ? 'conversion' : 'other',
      record: fs.existsSync(path.join(share, 'TeslaCam', '.sentrymanager', 'original-checksums.sha256')) });
  };
  const wrap = (name, fn) => async (request) => {
    look(`before ${name}`);
    try { return await fn(request); } finally { look(`after ${name}`); }
  };
  const staging = createFileTransaction({
    tempRoot,
    validatePublicationArtifact: async () => true,
    removeOwned: { ...owned.removeOwned, remove: wrap('remove', owned.removeOwned.remove) },
    renameExclusive: { ...owned.renameExclusive,
      promote: wrap('promote', owned.renameExclusive.promote),
      linkBackup: wrap('linkBackup', noLinks ? async () => ({ unsupported: true }) : owned.renameExclusive.linkBackup),
      replaceOver: wrap('replaceOver', failReplaceOver ? async () => { throw Object.assign(new Error('refused'), { code: 'EBUSY' }); } : owned.renameExclusive.replaceOver) },
    privateTempCleanup: 'identity',
    ...(hook ? { beforeReplaceOriginal: async (request) => { look('record'); await hook(request); look('recorded'); } } : {})
  });
  const writes = [];
  const operation = {
    jobId: 'job-1', itemId: 'item-000001', codec: 'h265', source, sourceRoot: share, expectedSource,
    publicationArtifact: artifact, persistTransaction: async (snapshot) => { writes.push(snapshot); }
  };
  return { root, share, footage, source, original, conversion, staging, operation, views, writes,
    record: path.join(share, 'TeslaCam', '.sentrymanager', 'original-checksums.sha256'),
    done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('replace: the record line is written before the original is touched, and the original\'s name is never missing', { skip: helperSkip }, async () => {
  const rec = createOriginalChecksums();
  const env = stagingEnv({ hook: (request) => rec.record(request) });
  try {
    const result = await env.staging.replaceOriginal(env.operation);
    assert.equal(result.phase, 'backup-deleted');
    assert.deepEqual(fs.readFileSync(env.source), env.conversion);
    assert.deepEqual(fs.readdirSync(env.footage), [path.basename(env.source)], 'no TEMP-/BACKUP- left');
    assert.equal(fs.readFileSync(env.record, 'utf8'), `${sha(env.original)}  RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4\n`);
    assert.ok(env.views.every((v) => v.at !== 'missing' && v.at !== 'other'), `the name always holds a whole file: ${JSON.stringify(env.views)}`);
    const firstTouch = env.views.findIndex((v) => v.step === 'before linkBackup');
    assert.ok(firstTouch > 0 && env.views.slice(0, firstTouch).some((v) => v.step === 'recorded' && v.record), 'recorded before the original was linked or moved');
    assert.deepEqual(env.views.find((v) => v.step === 'after replaceOver').at, 'conversion', 'the conversion takes the name in one rename');
  } finally {
    env.done();
  }
});

test('replace: a rename over the original that fails leaves the line (harmless), the original intact and nothing else', { skip: helperSkip }, async () => {
  const rec = createOriginalChecksums();
  const env = stagingEnv({ hook: (request) => rec.record(request), failReplaceOver: true });
  try {
    await assert.rejects(env.staging.replaceOriginal(env.operation));
    assert.deepEqual(fs.readFileSync(env.source), env.original, 'the original is intact at its name');
    assert.equal(fs.statSync(env.source).nlink, 1, 'its backup link is gone');
    assert.deepEqual(fs.readdirSync(env.footage), [path.basename(env.source)]);
    assert.equal(parseRecord(fs.readFileSync(env.record, 'utf8'))[0].sha256, sha(env.original));
    assert.ok(env.views.every((v) => v.at === 'original'));
  } finally {
    env.done();
  }
});

test('replace: a record that cannot be written keeps the original as it is', { skip: helperSkip }, async () => {
  const env = stagingEnv({ hook: async () => { throw Object.assign(new Error('share read-only'), { code: 'EROFS' }); } });
  try {
    await assert.rejects(env.staging.replaceOriginal(env.operation), { code: 'CHECKSUM_RECORD_FAILED' });
    assert.deepEqual(fs.readFileSync(env.source), env.original);
    assert.deepEqual(fs.readdirSync(env.footage), [path.basename(env.source)]);
    assert.ok(!env.views.some((v) => /linkBackup|promote|replaceOver/.test(v.step)), 'the original was never linked or moved');
  } finally {
    env.done();
  }
});

test('replace on a share without hard links: moved aside and in as before, the line still first', { skip: helperSkip }, async () => {
  const rec = createOriginalChecksums();
  const env = stagingEnv({ hook: (request) => rec.record(request), noLinks: true });
  try {
    await env.staging.replaceOriginal(env.operation);
    assert.deepEqual(fs.readFileSync(env.source), env.conversion);
    assert.equal(parseRecord(fs.readFileSync(env.record, 'utf8'))[0].sha256, sha(env.original));
    const recorded = env.views.findIndex((v) => v.step === 'recorded');
    const moved = env.views.findIndex((v) => v.step === 'before promote');
    assert.ok(recorded >= 0 && recorded < moved);
  } finally {
    env.done();
  }
});

test('separate output mode writes no record', { skip: helperSkip }, async () => {
  let called = 0;
  const env = stagingEnv({ hook: async () => { called++; } });
  try {
    const destination = path.join(env.root, 'out', 'RecentClips', '2026-11-08', path.basename(env.source));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await env.staging.publishSeparate({ ...env.operation, destination });
    assert.equal(called, 0);
    assert.deepEqual(fs.readFileSync(env.source), env.original);
    assert.ok(!fs.existsSync(env.record));
  } finally {
    env.done();
  }
});

// The real converter, as server/converterHost.js composes it: the record's
// hash is the original's, and the output is what Sentry USB recognises.
function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  for (let at = start; at + 8 <= end;) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(at + 8)); header = 16; } else if (size === 0) size = end - at;
    if (size < header) break;
    out.push({ type, start: at, end: at + size, header });
    at += size;
  }
  return out;
}
function sampleEntry(buf) {
  const moov = boxes(buf).find((b) => b.type === 'moov');
  const into = (box, type) => boxes(buf, box.start + box.header, box.end).filter((b) => b.type === type);
  for (const trak of into(moov, 'trak')) {
    const mdia = into(trak, 'mdia')[0];
    const hdlr = into(mdia, 'hdlr')[0];
    if (buf.toString('latin1', hdlr.start + 16, hdlr.start + 20) !== 'vide') continue;
    const stsd = into(into(into(mdia, 'minf')[0], 'stbl')[0], 'stsd')[0];
    return buf.toString('latin1', stsd.start + 16 + 4, stsd.start + 16 + 8);
  }
  return null;
}

test('the real converter: record line = SHA-256 of the original; output hvc1 with moov in the first or last MiB; nothing left', { skip: (!hasFfmpeg && 'ffmpeg missing') || helperSkip, timeout: 600000 }, async () => {
  const { createConverterRuntime } = require(path.join(REPO, 'src/main/converter/runtime'));
  const { createEncoderPlanner } = require(path.join(REPO, 'src/main/converter/encoderPlanner'));
  const { createTeslaH264Fixture } = require(path.join(REPO, 'test/fixtures/ffmpegFixtures'));
  const root = tmp();
  try {
    const share = path.join(root, 'footage', 'car', 'TeslaCam');
    const clips = path.join(share, 'RecentClips', '2026-08-30');
    fs.mkdirSync(clips, { recursive: true });
    fs.mkdirSync(path.join(root, 'user'));
    fs.mkdirSync(path.join(root, 'tmp'));
    const clip = path.join(clips, '2026-08-30_12-00-00-front.mp4');
    await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: clip, durationSeconds: 3, frameRate: 36, size: '640x360', spatialNoise: 12,
      telemetryPattern: Array.from({ length: 108 }, (_, i) => (i % 3 ? Buffer.from([0x20, i & 0xff]) : null)) });
    // a partial upload and a renamed-aside mismatch beside it: never converted
    fs.mkdirSync(path.join(clips, '.sentryusb-partial'));
    fs.copyFileSync(clip, path.join(clips, '.sentryusb-partial', '2026-08-30_12-01-00-front.mp4'));
    fs.copyFileSync(clip, path.join(clips, '2026-08-30_12-02-00-front.mp4.mismatch-1762646400'));
    const originalSha = sha(fs.readFileSync(clip));
    const originalSample = sampleEntry(fs.readFileSync(clip));
    const rec = createOriginalChecksums();
    const { removeOwned, renameExclusive } = createPosixOwnedFs({ helperPath: HELPER });
    const runtime = await createConverterRuntime({
      userDataPath: path.join(root, 'user'), tempPath: path.join(root, 'tmp'),
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', spawn, fs, pathApi: path, platform: 'linux',
      processTimeoutMs: 300000, removeOwned, renameExclusive, autoConvert: false,
      beforeReplaceOriginal: (request) => rec.record(request),
      factories: { createEncoderPlanner(options) {
        const real = createEncoderPlanner(options);
        return { select: real.selectCpuFallback, selectCpuFallback: real.selectCpuFallback };
      } }
    });
    await runtime.start();
    let job;
    try {
      const jobId = await runtime.service.start({
        sourceRoot: path.join(root, 'footage', 'car'), destinationRoot: null, outputMode: 'replace', replacementConfirmed: true,
        codec: 'h265', profileId: 'balanced', networkMode: 'direct', includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'],
        concurrency: 1, verifyMode: 'quick'
      });
      job = await runtime.service.whenIdle(jobId);
    } finally {
      await runtime.shutdown();
    }
    assert.deepEqual(job.items.map((i) => [i.relativePath, i.state]), [['TeslaCam/RecentClips/2026-08-30/2026-08-30_12-00-00-front.mp4', 'completed']],
      'only the clip: not the partial upload, not the mismatch');
    const record = fs.readFileSync(path.join(share, '.sentrymanager', 'original-checksums.sha256'), 'utf8');
    assert.equal(record, `${originalSha}  RecentClips/2026-08-30/2026-08-30_12-00-00-front.mp4\n`);
    const out = fs.readFileSync(clip);
    assert.equal(originalSample, 'avc1');
    assert.equal(sampleEntry(out), 'hvc1', 'H.265 sample entry hvc1');
    const top = boxes(out);
    const moov = top.find((b) => b.type === 'moov');
    const MiB = 1024 * 1024;
    assert.ok(moov.start < MiB || moov.start >= out.length - MiB, `moov at ${moov.start} of ${out.length}`);
    assert.ok(moov.end - moov.start < MiB, 'the whole moov fits in a MiB');
    // what Sentry USB's check reads: the tag in the first or last MiB
    const ends = Buffer.concat([out.subarray(0, MiB), out.subarray(Math.max(0, out.length - MiB))]);
    assert.ok(/hvc1|hev1|av01/.test(ends.toString('latin1')));
    assert.deepEqual(fs.readdirSync(clips).sort(), ['.sentryusb-partial', '2026-08-30_12-00-00-front.mp4', '2026-08-30_12-02-00-front.mp4.mismatch-1762646400']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Sentry USB's files are ignored ─────────────────────────────────────────

test('ignored: *.mp4.mismatch-* in event and date folders, dot folders (.sentryusb-partial, .sentryusb, .sentryusbtmp, .sentrymanager)', async () => {
  assert.equal(classify('TeslaCam/SentryClips/2026-11-08_13-00-00/2026-11-08_12-59-00-front.mp4.mismatch-1762646400'), null, 'not an event asset');
  assert.equal(classify('TeslaCam/RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4.mismatch-1762646400'), null);
  assert.equal(classify('TeslaCam/RecentClips/2026-11-08/.sentryusb-partial/2026-11-08_12-59-00-front.mp4'), null);
  assert.equal(classify('TeslaCam/SentryClips/2026-11-08_13-00-00/event.json').kind, 'asset', 'real event assets still count');
  const root = tmp();
  try {
    const T = path.join(root, 'TeslaCam');
    const files = {
      'RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4': 'clip',
      'RecentClips/2026-11-08/2026-11-08_12-58-00-front.mp4.mismatch-1762646400': 'old',
      'RecentClips/2026-11-08/.sentryusb-partial/2026-11-08_13-00-00-front.mp4': 'partial',
      'SentryClips/2026-11-08_13-00-00/2026-11-08_12-59-00-back.mp4': 'clip',
      'SentryClips/2026-11-08_13-00-00/2026-11-08_12-59-00-back.mp4.mismatch-1762646400': 'old',
      'SentryClips/2026-11-08_13-00-00/event.json': '{}',
      '.sentryusb/archive-status.json': '{}',
      '.sentryusbtmp/2026-11-08_12-57-00-front.mp4': 'tmp',
      '.sentrymanager/original-checksums.sha256': ''
    };
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(T, rel)), { recursive: true });
      fs.writeFileSync(path.join(T, rel), body);
    }
    const { files: found } = await scanFootage(root);
    assert.deepEqual([...found.keys()].sort(), [
      'TeslaCam/RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4',
      'TeslaCam/SentryClips/2026-11-08_13-00-00/2026-11-08_12-59-00-back.mp4',
      'TeslaCam/SentryClips/2026-11-08_13-00-00/event.json'
    ]);
    const conv = [];
    for await (const item of scanTeslaFootage({ sourceRoot: root, destinationRoot: null }, { path, platform: 'linux' })) conv.push(item.relativePath);
    assert.deepEqual(conv.sort(), [
      'TeslaCam/RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4',
      'TeslaCam/SentryClips/2026-11-08_13-00-00/2026-11-08_12-59-00-back.mp4',
      'TeslaCam/SentryClips/2026-11-08_13-00-00/event.json'
    ], 'the converter queues no partial upload, temp file or mismatch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── the status file ────────────────────────────────────────────────────────

const STATUS = {
  schema: 1, device: 'sentryusb', written_unix: 1762646400,
  archive: { result: 'ok', started_unix: 1762646000, finished_unix: 1762646390, files_archived: 120, files_not_archived: 0,
    last_clip: 'RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4' },
  verification: { enabled: true, ran: true, matched: 118, converted: 2, resending: 0, no_pi_copy: 0, still_queued: 0, stopped: null },
  auto_delete_enabled: false, state: 'idle', transfer: null
};
const transferring = (startedUnix, extra = {}) => ({
  ...STATUS, state: 'transferring', archive: { ...STATUS.archive, result: 'in_progress' },
  transfer: { started_unix: startedUnix, files: 42, bytes: 1.2e9, first_clip: 'SentryClips/2026-11-08_13-05-00/2026-11-08_13-00-00-front.mp4',
    last_clip: 'RecentClips/2026-11-08/2026-11-08_13-30-00-back.mp4', expected_finish_unix: startedUnix + 600, give_up_unix: startedUnix + 1500, ...extra }
});

test('status: schema 1 parsed; anything else (missing fields, bad JSON, other schema, unsafe paths) tolerated', () => {
  const s = parseStatus(JSON.stringify(STATUS));
  assert.equal(s.archive.lastClip, 'RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4');
  assert.deepEqual([s.verification.matched, s.verification.converted, s.state, s.transfer], [118, 2, 'idle', null]);
  assert.equal(parseStatus('{'), null);
  assert.equal(parseStatus(JSON.stringify({ ...STATUS, schema: 2 })), null);
  assert.equal(parseStatus('[]'), null);
  const odd = parseStatus(JSON.stringify({ schema: 1, archive: { last_clip: '../../etc/passwd', files_archived: -3 }, state: 'weird' }));
  assert.deepEqual([odd.archive.lastClip, odd.archive.filesArchived, odd.state], [null, null, 'idle']);
});

test('status: the transferring range by clip name, overdue past give_up_unix, and the line shown', () => {
  const start = Date.UTC(2026, 10, 8, 13, 31) / 1000;
  const s = parseStatus(transferring(start));
  const during = interpret(s, (start + 60) * 1000);
  assert.deepEqual(during, { transferring: true, overdue: false, range: { first: '2026-11-08_13-00-00-front.mp4', last: '2026-11-08_13-30-00-back.mp4' } });
  assert.ok(inRange(during.range, '2026-11-08_13-15-00-left_repeater.mp4'));
  assert.ok(inRange(during.range, '2026-11-08_13-30-00-back.mp4') && !inRange(during.range, '2026-11-08_13-30-00-front.mp4'), 'by name, as the Pi sorts');
  assert.ok(!inRange(during.range, '2026-11-08_12-59-00-front.mp4'));
  assert.equal(interpret(s, (start + 1501) * 1000).overdue, true);
  const view = describe(s, { nowMs: (start + 60) * 1000, tz: 'UTC' });
  assert.equal(view.tone, 'info');
  assert.match(view.summary, /^Sentry USB is copying 42 files \(13:00–13:30\) since 13:31, expected by 13:41\./);
  const late = describe(s, { nowMs: (start + 3600) * 1000, tz: 'UTC' });
  assert.equal(late.tone, 'waiting');
  assert.match(late.summary, /^Waiting for Sentry USB since 13:31: .*Nothing is lost: the clips stay on the Sentry USB and the rest arrives at its next archive\.$/);
  const idle = describe(parseStatus(STATUS), { nowMs: 1762646395_000, tz: 'UTC' });
  assert.equal(idle.tone, 'ok');
  assert.equal(idle.summary, 'Sentry USB\'s last archive (23:59) copied 120 files, newest clip 8 Nov 12:59.', 'times on the car\'s clock, the date when not today');
  assert.equal(idle.detail, 'Checksums: 118 matched, 2 converted here.');
  const failed = describe(parseStatus({ ...STATUS, archive: { ...STATUS.archive, result: 'failed', files_archived: 100, files_not_archived: 20 } }), { nowMs: 1762646400_000, tz: 'UTC' });
  assert.equal(failed.tone, 'amber');
  assert.match(failed.summary, /copied 100 files; 20 files did not make it and are tried again at its next archive/);
});

test('status API shape: transferring, then waiting past give_up_unix; times in ms; stale after 24 h', () => {
  const { apiView } = require('../server/sentryUsb');
  const start = Date.UTC(2026, 10, 8, 13, 31) / 1000;
  const s = parseStatus({ ...transferring(start), written_unix: start });
  const now = apiView(s, { nowMs: (start + 60) * 1000, readAt: 5 });
  assert.equal(now.state, 'transferring');
  assert.deepEqual(now.transfer, { startedAt: start * 1000, files: 42, bytes: 1.2e9, firstClip: 'SentryClips/2026-11-08_13-05-00/2026-11-08_13-00-00-front.mp4',
    lastClip: 'RecentClips/2026-11-08/2026-11-08_13-30-00-back.mp4', expectedFinishAt: (start + 600) * 1000, giveUpAt: (start + 1500) * 1000 });
  assert.equal(now.stale, false);
  assert.equal(apiView(s, { nowMs: (start + 1600) * 1000 }).state, 'waiting');
  assert.equal(apiView(s, { nowMs: (start + 25 * 3600) * 1000 }).stale, true);
  assert.deepEqual(apiView(null), { present: false });
  assert.deepEqual(apiView(null, { error: 'unreadable' }), { present: false, error: 'unreadable' });
  const bare = apiView(parseStatus({ schema: 1, state: 'idle' }), { nowMs: 0 });
  assert.deepEqual([bare.verification, bare.autoDeleteEnabled, bare.transfer, bare.writtenAt, bare.stale], [null, null, null, null, true]);
});

test('status: read per car from the TeslaCam folder, cached by mtime, polled while transferring, holds clips in range', async () => {
  const root = tmp();
  try {
    const carRoot = path.join(root, 'car');
    const share = path.join(carRoot, 'TeslaCam');
    fs.mkdirSync(path.join(share, '.sentryusb'), { recursive: true });
    const file = path.join(share, '.sentryusb', 'archive-status.json');
    const v = { id: 'car', timezone: 'UTC' };
    const vehicles = { list: () => [v], get: (id) => (id === 'car' ? v : null), rootOf: () => carRoot, studioRoot: () => share,
      vehicleForPath: (p) => (p.startsWith(carRoot + path.sep) ? v : null) };
    const clock = Date.UTC(2026, 10, 8, 13, 32);
    const changes = [];
    let tick = null;
    const status = createSentryUsbStatus({ vehicles, now: () => clock, onChange: (vid) => changes.push(vid), timers: { setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => {} } });
    assert.equal(await status.refresh('car'), null, 'no file: no status');
    fs.writeFileSync(file, JSON.stringify(transferring(Date.UTC(2026, 10, 8, 13, 31) / 1000)));
    assert.equal((await status.refresh('car')).state, 'transferring');
    assert.deepEqual(changes, ['car']);
    await status.refresh('car');
    assert.deepEqual(changes, ['car'], 'unchanged file: not re-read, no change');
    assert.ok(status.holds(path.join(share, 'RecentClips', '2026-11-08', '2026-11-08_13-10-00-front.mp4')));
    assert.ok(!status.holds(path.join(share, 'RecentClips', '2026-11-08', '2026-11-08_12-10-00-front.mp4')));
    assert.ok(!status.holds('/elsewhere/2026-11-08_13-10-00-front.mp4'));
    assert.equal(status.view('car').tone, 'info');
    // the Pi finishes: the minute's poll sees the new file
    fs.writeFileSync(file, JSON.stringify(STATUS));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    status.start();
    await tick();
    await tick();
    assert.equal(status.get('car').state, 'idle');
    assert.ok(!status.holds(path.join(share, 'RecentClips', '2026-11-08', '2026-11-08_13-10-00-front.mp4')));
    fs.writeFileSync(file, '{ not json');
    fs.utimesSync(file, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
    assert.equal(await status.refresh('car'), null, 'an unreadable file is no status');
    status.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('status: while sending, the clips of the transfer already on the share are counted, once a second at most', async () => {
  const root = tmp();
  try {
    const carRoot = path.join(root, 'car');
    const share = path.join(carRoot, 'TeslaCam');
    fs.mkdirSync(path.join(share, '.sentryusb'), { recursive: true });
    const file = path.join(share, '.sentryusb', 'archive-status.json');
    const v = { id: 'car', timezone: 'UTC' };
    const vehicles = { list: () => [v], get: (id) => (id === 'car' ? v : null), rootOf: () => carRoot, studioRoot: () => share };
    let clock = Date.UTC(2026, 10, 8, 13, 32);
    const status = createSentryUsbStatus({ vehicles, now: () => clock, timers: { setInterval: () => 1, clearInterval: () => {} } });
    fs.writeFileSync(file, JSON.stringify(STATUS));
    await status.refresh('car');
    assert.equal(await status.arrived('car'), null, 'not sending: nothing counted');
    fs.writeFileSync(file, JSON.stringify(transferring(Date.UTC(2026, 10, 8, 13, 31) / 1000)));
    fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    await status.refresh('car');
    const put = (rel, size) => { const f = path.join(share, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(size)); };
    put('RecentClips/2026-11-08/2026-11-08_13-10-00-front.mp4', 100);
    put('RecentClips/2026-11-08/2026-11-08_13-30-00-back.mp4', 50);
    put('RecentClips/2026-11-08/2026-11-08_13-30-00-right_repeater.mp4', 25); // same minute as the last clip: in
    put('SentryClips/2026-11-08_13-05-00/2026-11-08_13-00-00-front.mp4', 10);
    put('SentryClips/2026-11-08_13-05-00/event.json', 5); // not a clip
    put('RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4', 1000); // before the range
    put('RecentClips/2026-11-08/2026-11-08_13-31-00-front.mp4', 1000); // after it
    put('RecentClips/2026-11-08/.sentryusb-partial/2026-11-08_13-20-00-front.mp4', 1000); // still uploading
    put('RecentClips/2026-11-08/2026-11-08_13-15-00-front.mp4.mismatch-1762646400', 1000); // set aside
    assert.deepEqual(await status.arrived('car'), { files: 4, bytes: 185, countedAt: clock });
    put('RecentClips/2026-11-08/2026-11-08_13-11-00-front.mp4', 15);
    assert.equal((await status.arrived('car')).files, 4, 'within the second: the last count');
    clock += 1000;
    assert.deepEqual(await status.arrived('car'), { files: 5, bytes: 200, countedAt: clock });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── archive gaps and automatic conversion ─────────────────────────────────

const key = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
function drive(files, from, to) {
  for (let t = from; t < to; t += 60_000) {
    for (const camera of ['back', 'front']) {
      const rel = `TeslaCam/RecentClips/${key(t).slice(0, 10)}/${key(t)}-${camera}.mp4`;
      files.set(rel, { rel, size: 30e6, mtimeMs: t + 60_000, ctimeMs: t + 61_000, birthtimeMs: t + 61_000, kind: 'clip', type: 'RecentClips', camera, day: key(t).slice(0, 10) });
    }
  }
  return files;
}

test('archive gaps: minutes Sentry USB is copying are not missing; past give-up the day waits for Sentry USB', () => {
  const NOW = Date.UTC(2026, 10, 8, 18, 0);
  const at = (h, m = 0) => Date.UTC(2026, 10, 8, h, m);
  const files = drive(new Map(), at(8), at(9));
  drive(files, at(15), at(15, 10)); // a later drive is on the share (the archive got past 9-10)
  const can = [];
  for (let t = at(9); t < at(10); t += 60_000) can.push(stampSec(key(t)));
  const base = analyze({ files, nowMs: NOW, canDriving: can });
  assert.equal(base.days['2026-11-08'].state, 'partial', 'without the status file: 60 minutes missing');
  const range = { transferring: true, overdue: false, firstS: stampSec('2026-11-08_09-00-00'), lastS: stampSec('2026-11-08_09-59-00') };
  const copying = analyze({ files, nowMs: NOW, canDriving: can, sentryUsb: range });
  const d = copying.days['2026-11-08'];
  assert.equal(d.state, 'filling');
  assert.equal(d.missingMinutes, 0);
  assert.equal(d.sentryUsb, 'transferring');
  assert.match(d.summary, /^Still being copied: Sentry USB is copying this day's clips now; 60 minutes are still on the way\.$/);
  // a day in the range with no other evidence (no CAN, no speeds) is tagged too
  const plain = analyze({ files: drive(new Map(), at(8), at(9)), nowMs: NOW, sentryUsb: { transferring: true, overdue: false, firstS: stampSec('2026-11-08_08-30-00'), lastS: stampSec('2026-11-08_08-59-00') } });
  assert.equal(plain.days['2026-11-08'].state, 'filling');
  assert.equal(plain.days['2026-11-08'].sentryUsb, 'transferring');
  assert.equal(plain.days['2026-11-08'].summary, 'Still being copied: Sentry USB is copying this day\'s clips now.');
  // only the range: minutes outside it still count
  const narrow = analyze({ files, nowMs: NOW, canDriving: can, sentryUsb: { ...range, lastS: stampSec('2026-11-08_09-29-00') } });
  assert.equal(narrow.days['2026-11-08'].state, 'partial');
  assert.equal(narrow.days['2026-11-08'].missingMinutes, 29);
  // past give_up_unix (overdue): everything from first_clip on waits, nothing is "missing"
  const waiting = analyze({ files, nowMs: NOW, canDriving: can, sentryUsb: { ...range, lastS: stampSec('2026-11-08_09-10-00'), overdue: true } });
  const w = waiting.days['2026-11-08'];
  assert.equal(w.state, 'waiting');
  assert.equal(w.sentryUsb, 'waiting');
  assert.match(w.summary, /^Waiting for Sentry USB: Sentry USB's transfer stopped part way .*Nothing is lost: the clips stay on the Sentry USB and the rest arrives at its next archive\.$/);
  assert.equal(waiting.signals.sentryUsb, 'waiting');
});

test('automatic conversion skips clips in the range Sentry USB is still copying, and finds them once it is done', async () => {
  const { createAutoConverter } = require('../src/main/converter/autoConvert');
  const dir = tmp();
  try {
    let holding = true;
    const clips = ['2026-11-08_13-10-00-front.mp4', '2026-11-08_12-10-00-front.mp4']
      .map((n) => ({ relativePath: `RecentClips/2026-11-08/${n}`, sourcePath: `/cars/a/RecentClips/2026-11-08/${n}`, sourceBytes: 10, mtimeMs: 1 }));
    const started = [];
    const jobs = new Map();
    const service = {
      start: async (cfg) => { const id = `job-${started.length + 1}`; started.push(id); jobs.set(id, { id, state: 'encoding', config: cfg, items: [] }); return id; },
      get: async (id) => jobs.get(id) || null, list: async () => [...jobs.values()], pause: async () => {}, resume: async () => {}
    };
    const auto = createAutoConverter({
      service, fs: fsp, directory: dir, timers: { setInterval: () => null, clearInterval: () => {} },
      scanner: async function* () { for (const c of clips) yield c; },
      holdDiscovered: (config, discovered) => holding && inRange({ first: '2026-11-08_13-00-00-front.mp4', last: '2026-11-08_13-30-00-back.mp4' }, path.basename(discovered.sourcePath))
    });
    await auto.configure({ intervalMinutes: 60, window: null, holdManual: false, keepRunning: false, openAtLogin: false, enabled: true,
      config: { sourceRoot: '/cars/a', destinationRoot: null, codec: 'h265', profileId: 'balanced', networkMode: 'direct', outputMode: 'replace',
        includedGroups: ['RecentClips'], replacementConfirmed: true, concurrency: 1, verifyMode: 'quick' } });
    await auto.tick();
    assert.equal(auto.getState().status.sources['/cars/a'].lastNewFiles, 1, 'the clip in the range is not new yet');
    jobs.get('job-1').state = 'completed';
    holding = false;
    await auto.checkNow();
    assert.equal(auto.getState().status.sources['/cars/a'].lastNewFiles, 2, 'found once the transfer is done (the other was not handled by the fake job)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the API, on the real server ───────────────────────────────────────────

test('server: GET /api/vehicles/:id/sentry-usb and /days carry the status; mismatch files and partial uploads are not footage', { timeout: 120000 }, async () => {
  const net = require('net');
  const dir = tmp();
  const T = path.join(dir, 'footage', 'TeslaCam');
  const write = (rel, body = crypto.randomBytes(2048)) => { fs.mkdirSync(path.dirname(path.join(T, rel)), { recursive: true }); fs.writeFileSync(path.join(T, rel), body); };
  write('RecentClips/2020-01-01/2020-01-01_08-00-00-front.mp4');
  write('RecentClips/2020-01-01/2020-01-01_08-01-00-front.mp4.mismatch-1762646400');
  write('RecentClips/2020-01-01/.sentryusb-partial/2020-01-01_08-02-00-front.mp4');
  write('SentryClips/2020-01-02_12-30-00/2020-01-02_12-29-00-front.mp4');
  write('SentryClips/2020-01-02_12-30-00/2020-01-02_12-28-00-front.mp4.mismatch-1762646400');
  write('.sentryusb/archive-status.json', JSON.stringify(STATUS));
  const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(REPO, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC', SENTRY_NOREPLACE_RENAME: HELPER, LOG_LEVEL: 'warn', TLS_MODE: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'X-Requested-With': 'sentry-six-manager', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
    assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200, output);
    let days;
    for (let i = 0; i < 100; i++) {
      days = (await call('GET', '/api/vehicles/daily-driver/days')).data;
      if (days?.days?.length === 2 && days.sentryUsb) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(days.sentryUsb.present, true);
    assert.match(days.sentryUsb.summary, /^Sentry USB's last archive \(.+\) copied 120 files, newest clip/);
    const { record, ...api } = (await call('GET', '/api/vehicles/daily-driver/sentry-usb')).data;
    // the checksums Manager records for every arrived clip (arrivalChecksums.js): these two arrived just now
    assert.deepEqual({ ...record, pending: typeof record.pending, backlog: record.backlog && Object.keys(record.backlog) }, { enabled: true, today: 0, lastAt: null, pending: 'number', lines: 0, windowDays: 7, older: true,
      backlog: record.backlog && ['total', 'done', 'left', 'failed', 'bytesLeft', 'etaMinutes'], canBackfill: true });
    // (the 2020 clips arrived just now: in the recent window, still settling; nothing older)
    let rec;
    for (let i = 0; i < 100; i++) {
      rec = (await call('GET', '/api/vehicles/daily-driver/sentry-usb')).data.record;
      if (rec.backlog) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.deepEqual(rec.backlog, { total: 0, done: 0, left: 0, failed: 0, bytesLeft: 0, etaMinutes: 0 });
    assert.equal((await call('POST', '/api/vehicles/daily-driver/sentry-usb/record', { days: 30 })).status, 400, 'the old "last N days" form is gone');
    const off = await call('POST', '/api/vehicles/daily-driver/sentry-usb/record', { older: false });
    assert.equal(off.status, 200);
    assert.equal(off.data.record.older, false);
    assert.equal(off.data.record.backlog, null);
    assert.equal((await call('POST', '/api/vehicles/daily-driver/sentry-usb/record', { older: true })).data.record.older, true);
    assert.deepEqual({ ...api, readAt: typeof api.readAt }, {
      present: true, readAt: 'number', writtenAt: 1762646400_000, device: 'sentryusb', state: 'idle',
      archive: { result: 'ok', startedAt: 1762646000_000, finishedAt: 1762646390_000, filesArchived: 120, filesNotArchived: 0,
        lastClip: 'RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4' },
      verification: { enabled: true, ran: true, matched: 118, converted: 2, resending: 0, noPiCopy: 0, stillQueued: 0, stopped: null },
      autoDeleteEnabled: false, transfer: null, stale: true,
      summary: api.summary, detail: 'Checksums: 118 matched, 2 converted here.', tone: 'ok'
    });
    // a file that is not a status file: present false, with why
    fs.writeFileSync(path.join(T, '.sentryusb', 'archive-status.json'), '{ nope');
    assert.equal((await call('POST', '/api/vehicles/daily-driver/scan', {})).status < 300, true);
    let bad;
    for (let i = 0; i < 100; i++) {
      bad = (await call('GET', '/api/vehicles/daily-driver/sentry-usb')).data;
      if (bad.present === false) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.deepEqual({ ...bad, record: undefined }, { present: false, error: 'not a schema 1 status file', record: undefined });
    const recs = (await call('GET', '/api/vehicles/daily-driver/recordings')).data.recordings;
    assert.equal(recs.length, 2);
    for (const r of recs) {
      const detail = (await call('GET', `/api/vehicles/daily-driver/recordings/${r.id}`)).data;
      const names = (detail.files || []).map((f) => f.rel || f.name || f);
      assert.ok(!names.some((n) => /mismatch|sentryusb/.test(JSON.stringify(n))), `no Sentry USB file in ${JSON.stringify(names)}`);
    }
    assert.equal((await call('GET', '/api/vehicles/nope/sentry-usb')).status, 404);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
