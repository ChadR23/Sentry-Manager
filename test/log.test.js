'use strict';

// Overview > Logs: every warning and error (the converter's too) is kept in
// the data folder, with secrets masked, and survives a restart.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Logger } = require('../server/log');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-log-')), 'logs', 'manager.log');

test('lines go to the file with secrets masked, and come back after a restart', () => {
  const file = tmpFile();
  const first = new Logger({ silent: true, file });
  first.scope('share').warn('mount failed: username=tesla,password=hunter2 smb://me:hunter2@nas/cam');
  first.scope('server').info('Listening');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('hunter2'), 'no secret in the file');
  assert.match(text, /WARN {2}\[share\] mount failed: username=tesla,password=\*\*\* smb:\/\/\*\*\*@nas\/cam/);
  const again = new Logger({ silent: true, file });
  assert.deepEqual(again.recent(10, { minLevel: 'warn' }).map((l) => [l.level, l.scope]), [['warn', 'share']]);
  assert.equal(again.recent(10).length, 2);
  fs.rmSync(path.dirname(path.dirname(file)), { recursive: true, force: true });
});

test('the file is capped: one previous file is kept, and the download has both', async () => {
  const file = tmpFile();
  const logger = new Logger({ silent: true, file, maxBytes: 400 });
  for (let i = 0; i < 30; i++) logger.scope('t').warn(`line ${i}`);
  assert.ok(fs.statSync(file).size <= 400);
  assert.ok(fs.existsSync(`${file}.1`));
  const all = await logger.fileText();
  assert.ok(all.includes('line 29'));
  assert.ok(all.indexOf(`line ${all.match(/line (\d+)/)[1]}`) < all.indexOf('line 29'), 'oldest first');
  fs.rmSync(path.dirname(path.dirname(file)), { recursive: true, force: true });
});

test('console output from anywhere in the app is captured with its scope', () => {
  const file = tmpFile();
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const logger = new Logger({ silent: true, file });
  try {
    logger.captureConsole();
    console.warn('[CONVERTER] Verification failed:', 'SentryClips/a/back.mp4', 'duration-mismatch', JSON.stringify({ deltaUs: 41000 }));
    console.error(new Error('boom'));
  } finally {
    Object.assign(console, saved);
  }
  const [warn, error] = logger.recent(10);
  assert.equal(warn.scope, 'converter');
  assert.equal(warn.level, 'warn');
  assert.equal(warn.message, 'Verification failed: SentryClips/a/back.mp4 duration-mismatch {"deltaUs":41000}');
  assert.equal(error.level, 'error');
  assert.match(error.message, /Error: boom/);
  fs.rmSync(path.dirname(path.dirname(file)), { recursive: true, force: true });
});

test('Clear moves the logs into logs/archive/ and loses nothing; only its own names can be read back', async () => {
  const file = tmpFile();
  const logger = new Logger({ silent: true, file, maxBytes: 200 });
  for (let i = 0; i < 8; i++) logger.scope('t').warn(`line ${i} password=hunter2`);
  assert.ok(fs.existsSync(`${file}.1`), 'the small limit rolled the file over');
  const before = fs.readFileSync(`${file}.1`, 'utf8') + fs.readFileSync(file, 'utf8');
  const name = logger.archive();
  assert.match(name, /^manager-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.log$/);
  assert.equal(logger.recent().length, 0, 'the Logs start empty');
  assert.equal(fs.existsSync(file) || fs.existsSync(`${file}.1`), false);
  const text = await logger.archiveText(name);
  assert.equal(text, before, 'every line on disk at the moment of Clear is kept, in order');
  assert.match(text, /line 7 /);
  assert.equal(text.includes('hunter2'), false, 'still masked');
  assert.equal((fs.statSync(path.join(path.dirname(file), 'archive', name)).mode & 0o777), 0o600);
  assert.deepEqual(logger.archives().map((a) => a.name), [name]);
  logger.scope('t').info('after');
  assert.equal(logger.recent().length, 1);
  for (const bad of ['../manager.log', 'manager.log', `${name}/../../x`, '/etc/passwd']) assert.equal(await logger.archiveText(bad), null, bad);
  // a link planted under an archive name is not followed
  const planted = 'manager-2020-01-01T00-00-00-000Z.log';
  fs.symlinkSync('/etc/hostname', path.join(path.dirname(file), 'archive', planted));
  assert.equal(await logger.archiveText(planted), null);
  assert.equal(new Logger({ silent: true, file: tmpFile() }).archive(), null, 'nothing to keep: no empty archive');
});
