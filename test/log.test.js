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

test('the file is capped: one previous file is kept, and the download has both', () => {
  const file = tmpFile();
  const logger = new Logger({ silent: true, file, maxBytes: 400 });
  for (let i = 0; i < 30; i++) logger.scope('t').warn(`line ${i}`);
  assert.ok(fs.statSync(file).size <= 400);
  assert.ok(fs.existsSync(`${file}.1`));
  const all = logger.fileText();
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
