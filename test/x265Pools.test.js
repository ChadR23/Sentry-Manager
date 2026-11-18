'use strict';

// libx265 sizes its thread pool with libnuma, whose calls Docker's default
// seccomp profile blocks (unless the container has SYS_NICE): x265 then
// encodes with no pool, about 3x slower. On Linux it is given one, one thread
// per CPU this process may use (its cpuset and its cgroup's CPU limit).

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEncodeArgs, defaultX265Pools, usableCpus, cpuListCount } = require('../src/main/converter/encoderPlanner');
// the Rust planner checks the same cases (usable_cpus_cases)
const CASES = require('../lean/src/converter/testdata/usableCpusCases.json');

test('the CPUs this process may use: its cpuset and its cgroup CPU limit, rounded up', () => {
  for (const { name, files, cpus } of CASES) assert.equal(usableCpus((p) => files[p] ?? ''), cpus, name);
  assert.deepEqual(['0-11', '5', '0-3,8,10-11', '', '3-1', '0-', 'a', '0-3 5', '4194303', '4194304', '9007199254740993-9007199254740994'].map(cpuListCount), [12, 1, 7, 0, 0, 0, 0, 0, 1, 0, 0]);
});

test('libx265 gets a thread pool of those CPUs on Linux, nothing elsewhere', () => {
  assert.deepEqual([defaultX265Pools('linux', 12), defaultX265Pools('darwin', 12), defaultX265Pools('win32', 8), defaultX265Pools('linux', 0)], [12, 0, 0, 0]);
  const args = (encoder, x265Pools) => buildEncodeArgs({ codec: encoder === 'libsvtav1' ? 'av1' : 'h265', encoder, bitrate: 1_000_000, ...(x265Pools === undefined ? {} : { x265Pools }) });
  const x = args('libx265', 8);
  assert.deepEqual(x.slice(x.indexOf('-preset'), x.indexOf('-preset') + 4), ['-preset', 'medium', '-x265-params', 'pools=8']);
  assert.equal(args('libx265', 0).includes('-x265-params'), false, "0: x265's own choice");
  assert.equal(args('hevc_vaapi', 8).includes('-x265-params'), false);
  assert.equal(args('libsvtav1', 8).includes('-x265-params'), false);
  const here = defaultX265Pools(process.platform, usableCpus());
  assert.equal(args('libx265').includes(`pools=${here}`), here > 0, 'this machine');
  assert.equal(args('libx265', null).includes(`pools=${here}`), here > 0, 'null: this machine');
  for (const bad of [-1, 1.5, '8', NaN, Infinity]) assert.throws(() => args('libx265', bad), RangeError);
});
