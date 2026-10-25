'use strict';

// The docker-compose.yml people download must start on any Docker host as it
// is: no bind mount of a host path that only some machines have, and the
// capabilities the supervisor needs to prepare /data and run the app.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
const active = compose.split('\n').filter((line) => !/^\s*#/.test(line) && line.trim() !== '');

test('a fresh install starts anywhere: only ./data is mounted from the host by default', () => {
  const mounts = active.filter((line) => /^\s+- [./~\w-]*\/[^:]*:\//.test(line));
  assert.deepEqual(mounts.map((line) => line.trim()), ['- ./data:/data']);
  assert.ok(compose.includes('# - /sys/devices/virtual/powercap:/host/powercap:ro'), 'CPU watts stay one uncommented line away');
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
