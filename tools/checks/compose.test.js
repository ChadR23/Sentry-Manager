'use strict';

// The docker-compose.yml people download must start on any Docker host as it
// is: no bind mount of a host path that only some machines have, and the
// capabilities the supervisor needs to prepare /data and run the app.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const compose = fs.readFileSync(path.join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8');
const active = compose.split('\n').filter((line) => !/^\s*#/.test(line) && line.trim() !== '');

test('a fresh install starts anywhere: only ./data is mounted from the host by default', () => {
  const mounts = active.filter((line) => /^\s+- [./~\w-]*\/[^:]*:\//.test(line));
  assert.deepEqual(mounts.map((line) => line.trim()), ['- ./data:/data']);
  assert.ok(compose.includes('\n#      - /sys/devices/virtual/powercap:/host/powercap:ro\n'), 'CPU watts stay one deleted # away');
  assert.equal(active.some((line) => /^\s+devices:|^\s+deploy:/.test(line)), false, 'GPU blocks are opt-in');
});

test('the supervisor keeps the capabilities it needs to start', () => {
  for (const cap of ['SYS_ADMIN', 'DAC_READ_SEARCH', 'DAC_OVERRIDE', 'SETUID', 'SETGID', 'SETPCAP', 'CHOWN', 'KILL']) {
    assert.ok(active.some((line) => line.trim() === `- ${cap}`), cap);
  }
  assert.ok(active.some((line) => line.trim() === '- ALL'), 'everything else is dropped');
});

test('no tabs and consistent two-space indentation (a stray space breaks the whole file)', () => {
  for (const line of active) {
    assert.equal(line.includes('\t'), false, line);
    assert.equal((line.match(/^ */)[0].length) % 2, 0, `odd indentation: ${JSON.stringify(line)}`);
  }
});

// truenas/sentry-six-manager.yaml is pasted into TrueNAS's "Install via
// YAML": no .env file there (relative paths mean nothing), TrueNAS's apps
// user, and the same capabilities and indentation rules as above.
const truenas = fs.readFileSync(path.join(__dirname, '..', '..', 'truenas', 'sentry-six-manager.yaml'), 'utf8');
const truenasActive = truenas.split('\n').filter((line) => !/^\s*#/.test(line) && line.trim() !== '');

test('TrueNAS: datasets by absolute path, no .env, apps user, only /data mounted by default', () => {
  assert.equal(truenasActive.some((line) => /env_file|\$\{|\.\/data/.test(line)), false);
  const mounts = truenasActive.filter((line) => /^\s+- [^"]*:\//.test(line)).map((line) => line.trim());
  assert.deepEqual(mounts, ['- /mnt/tank/apps/sentry-six-manager:/data']);
  assert.ok(truenasActive.some((line) => line.trim() === 'PUID: "568"'));
  assert.ok(truenasActive.some((line) => line.trim() === 'PGID: "568"'));
  assert.ok(truenas.includes('\n#      - /mnt/tank/TeslaCam:/footage/my-car\n'));
  assert.equal(truenasActive.some((line) => /^\s+devices:|^\s+deploy:/.test(line)), false, 'GPU blocks are opt-in');
});

test('TrueNAS: same capabilities, image and clean indentation as docker-compose.yml', () => {
  for (const cap of ['SYS_ADMIN', 'DAC_READ_SEARCH', 'DAC_OVERRIDE', 'SETUID', 'SETGID', 'SETPCAP', 'CHOWN', 'KILL', 'ALL']) {
    assert.ok(truenasActive.some((line) => line.trim() === `- ${cap}`), cap);
  }
  assert.ok(truenasActive.some((line) => line.trim() === 'image: ghcr.io/skittles-fivem/sentry-manager:latest'));
  for (const line of truenasActive) {
    assert.equal(line.includes('\t'), false, line);
    assert.equal((line.match(/^ */)[0].length) % 2, 0, `odd indentation: ${JSON.stringify(line)}`);
  }
});

// Optional lines carry their # in the first column and are already lined up:
// deleting that one character turns the line on, with nothing to re-indent.
for (const [name, text] of [['docker-compose.yml', compose], ['truenas/sentry-six-manager.yaml', truenas]]) {
  test(`${name}: every optional line turns on by deleting its # alone`, () => {
    const body = text.slice(text.indexOf('\nservices:'));
    const optional = body.split('\n').filter((line) => line.startsWith('#'));
    assert.ok(optional.length >= 4, 'optional lines are there');
    for (const line of optional) {
      const on = line.slice(1);
      assert.match(on, /^ {4,}\S/, `lined up under services: ${JSON.stringify(line)}`);
      assert.equal(on.match(/^ */)[0].length % 2, 0, `odd indentation once on: ${JSON.stringify(line)}`);
    }
    // explanations are indented comments; none sits in the first column below services:
    assert.equal(body.split('\n').some((line) => /^# /.test(line) && !/^# {3,}/.test(line)), false);
  });
}
