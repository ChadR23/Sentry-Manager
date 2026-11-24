'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const file = path.join(__dirname, 'frozen.js');
const localRequire = createRequire(file);
const routes = localRequire('../../lean/tests/fixtures/contract/routes.json').routes;

// Only startup and API answers are replaced: main's shutdown and directory removal run unchanged.
async function run(t, { mode = 'graceful', different = false, removeError = false, args = [] } = {}) {
  const messages = [], warnings = [], logs = [];
  let child, dir, removal;
  const proc = new EventEmitter();
  proc.argv = ['node', file, ...args];
  proc.env = {};
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  const context = vm.createContext({
    __dirname, module: { exports: {} }, process: proc, setTimeout, clearTimeout,
    console: { log: (...xs) => logs.push(xs.join(' ')), warn: (...xs) => warnings.push(xs.join(' ')) },
    require: (name) => {
      if (name === './compare') return { compare: async () => ({ byRoute: Object.fromEntries(
        Object.entries(routes).filter(([, state]) => state !== 'not compared').map(([key]) => [key,
          different && key === 'GET /api/health'
            ? { same: 0, different: 1, answers: [{ diffs: [{ path: 'body.test', golden: 1, actual: 2 }] }] }
            : { same: 1, different: 0, answers: [] }
        ])
      ) }) };
      if (name === './live') return { script: async () => ({}), compareLive: () => ({ byRoute: {} }) };
      if (name === 'fs') return { ...fs, rmSync: (folder, options) => {
        removal = options;
        if (removeError) throw Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' });
        fs.rmSync(folder, options);
      } };
      return localRequire(name);
    },
    start: async (_, folder) => {
      dir = folder;
      child = spawn(process.execPath, ['-e', `
        const fs = require('node:fs');
        const path = require('node:path');
        setInterval(() => {}, 1000);
        process.on('SIGTERM', () => {
          if (process.argv[2] === 'ignore') return;
          setTimeout(() => {
            fs.writeFileSync(path.join(process.argv[1], 'last-write'), 'stopped');
            process.send('wrote before exit', () => process.exit(0));
          }, 100);
        });
        process.send('ready');
      `, dir, mode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.on('message', (message) => messages.push(message));
      await once(child, 'message');
      if (mode === 'exited') {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      return { base: 'https://127.0.0.1', ca: '', child };
    }
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  vm.runInContext('startLean = start', context);
  const code = await vm.runInContext('main()', context);
  return { code, child, dir, removal, messages, warnings, logs, proc };
}

test('frozen: waits for the server\'s last write and exit before removing its folder', { skip: process.platform === 'win32' }, async (t) => {
  const r = await run(t);
  assert.equal(r.code, 0);
  assert.equal(r.child.exitCode, 0, 'the server must finish its shutdown');
  assert.ok(r.messages.includes('wrote before exit'));
  assert.equal(fs.existsSync(r.dir), false);
  assert.ok(r.removal.maxRetries > 0 && r.removal.retryDelay > 0);
  assert.equal(r.proc.listenerCount('exit'), 1, 'the synchronous safety net remains');
});

test('frozen: kills a server that ignores SIGTERM and waits for its exit', { skip: process.platform === 'win32', timeout: 20000 }, async (t) => {
  const r = await run(t, { mode: 'ignore' });
  assert.equal(r.code, 0);
  assert.equal(r.child.signalCode, 'SIGKILL');
  assert.equal(fs.existsSync(r.dir), false);
});

test('frozen: does not wait again for a server already exited by signal', { timeout: 5000 }, async (t) => {
  const r = await run(t, { mode: 'exited' });
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(r.dir), false);
});

for (const different of [false, true]) {
  test(`frozen: removal failure preserves ${different ? 'FAIL' : 'PASS'} and its exit code`, async (t) => {
    const r = await run(t, { mode: 'exited', different, removeError: true });
    assert.equal(r.code, different ? 1 : 0);
    assert.ok(r.logs.some((line) => line.startsWith(`\n${different ? 'FAIL' : 'PASS'}:`)));
    assert.equal(r.warnings.length, 1);
    assert.ok(r.warnings[0].includes(r.dir));
    assert.ok(r.warnings[0].includes('ENOTEMPTY'));
    assert.equal(r.warnings[0].split('\n').length, 1);
    assert.equal(fs.existsSync(r.dir), true);
  });
}

test('frozen: --keep preserves the server folder', async (t) => {
  const r = await run(t, { mode: 'exited', args: ['--keep'] });
  assert.equal(r.code, 0);
  assert.equal(r.removal, undefined);
  assert.equal(fs.existsSync(r.dir), true);
});
