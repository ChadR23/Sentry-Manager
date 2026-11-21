'use strict';

// The measurement harness (tools/bench): its parsing of docker / /proc /
// cgroup output, the CSV and report, and run.sh's refusals, all on sample
// data. Nothing here needs Docker or a long run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');

const BENCH = __dirname;
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('bench: docker sizes, percents and a docker stats line', () => {
  assert.equal(lib.parseSize('0B'), 0);
  assert.equal(lib.parseSize('312kB'), 312_000);
  assert.equal(lib.parseSize('1.5GiB'), 1.5 * 1024 ** 3);
  assert.equal(lib.parseSize('245.3MiB'), Math.round(245.3 * 1024 ** 2));
  assert.equal(lib.parseSize('--'), null);
  assert.equal(lib.parsePercent('12.34%'), 12.34);
  const s = lib.parseDockerStats('{"BlockIO":"1.2GB / 45.1MB","CPUPerc":"103.52%","Container":"abc","ID":"abc123","MemPerc":"11.98%","MemUsage":"245.3MiB / 2GiB","Name":"manager-baseline","NetIO":"1.1kB / 0B","PIDs":"23"}');
  assert.deepEqual(
    { name: s.name, cpu: s.cpuPct, mem: s.memUsage, limit: s.memLimit, read: s.blkRead, write: s.blkWrite, pids: s.pids },
    { name: 'manager-baseline', cpu: 103.52, mem: Math.round(245.3 * 1024 ** 2), limit: 2 * 1024 ** 3, read: 1.2e9, write: 45.1e6, pids: 23 }
  );
  assert.equal(lib.parseDockerStats('not json'), null);
});

test('bench: /proc stat (a command name with spaces and parentheses), status and io', () => {
  const stat = lib.parseProcStat('4242 (node (x) y) S 17 4242 17 0 -1 4194560 9000 0 3 0 1234 567 0 0 20 0 11 0 98765 1000000 5000 18446744073709551615');
  assert.deepEqual({ pid: stat.pid, comm: stat.comm, state: stat.state, ppid: stat.ppid, utime: stat.utime, stime: stat.stime, threads: stat.numThreads, start: stat.starttime },
    { pid: 4242, comm: 'node (x) y', state: 'S', ppid: 17, utime: 1234, stime: 567, threads: 11, start: 98765 });
  const status = lib.parseProcStatus('Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nPPid:\t17\nVmHWM:\t  312000 kB\nVmRSS:\t  250000 kB\nVmSwap:\t       0 kB\nThreads:\t11\n');
  assert.equal(status.uid, 1000);
  assert.equal(status.VmRSS, 250000 * 1024);
  assert.equal(status.VmHWM, 312000 * 1024);
  assert.equal(status.threads, 11);
  const io = lib.parseProcIo('rchar: 5000\nwchar: 10\nsyscr: 3\nsyscw: 1\nread_bytes: 4096\nwrite_bytes: 0\ncancelled_write_bytes: 0\n');
  assert.equal(io.read_bytes, 4096);
  assert.equal(io.rchar, 5000);
  assert.equal(lib.parseProcIo(''), null);
});

test('bench: cgroup files', () => {
  assert.equal(lib.parseCgroupNumber('max\n'), Infinity);
  assert.equal(lib.parseCgroupNumber('123456\n'), 123456);
  assert.deepEqual(lib.parseKeyValues('low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n'), { low: 0, high: 0, max: 3, oom: 1, oom_kill: 1 });
  assert.deepEqual(lib.parseIoStat('8:0 rbytes=1000 wbytes=10 rios=2 wios=1 dbytes=0 dios=0\n259:0 rbytes=500 wbytes=0 rios=1 wios=0\n'),
    { rbytes: 1500, wbytes: 10, rios: 3, wios: 1 });
  assert.equal(lib.parseIoStat(''), null);
  // a cgroup v1 host: the same figures under other names
  const v1 = lib.cgroupFigures({
    'memory.current': '',
    'memory/memory.usage_in_bytes': '3361853440\n', 'memory/memory.max_usage_in_bytes': '4802064384\n',
    'memory/memory.stat': 'cache 1\nrss 2\nswap 0\ntotal_cache 2222342144\ntotal_rss 1140011008\ntotal_swap 4096\n',
    'memory/memory.oom_control': 'oom_kill_disable 0\nunder_oom 0\noom_kill 3\n',
    'cpuacct/cpuacct.usage': '2776732778696\n',
    'blkio/blkio.throttle.io_service_bytes': '8:0 Read 1000\n8:0 Write 20\n8:16 Read 500\nTotal 1520\n'
  });
  assert.deepEqual(v1, { current: 3361853440, peak: 4802064384, swap: 4096, mstat: { anon: 1140011008, file: 2222342144 }, events: { oom_kill: 3, oom: 0 }, io: { rbytes: 1500, wbytes: 20 }, cpuUsec: 2776732779 });
});

test('bench: which process is which', () => {
  assert.equal(lib.roleOf('node --disable-warning=ExperimentalWarning /app/server/index.js'), 'server');
  assert.equal(lib.roleOf('/usr/local/bin/node /app/server/supervisor.js'), 'supervisor');
  assert.equal(lib.roleOf('/usr/bin/tini -- node /app/server/supervisor.js'), 'tini');
  assert.equal(lib.roleOf('/usr/local/bin/ffprobe -v error -show_streams x.mp4'), 'ffprobe');
  assert.equal(lib.roleOf('ffmpeg -i a.mp4'), 'ffmpeg');
  assert.equal(lib.roleOf('/usr/local/bin/sentry-lean'), 'server');
  assert.equal(lib.roleOf('/usr/local/bin/sentry-lean-supervisor'), 'supervisor');
  assert.equal(lib.roleOf('', 'sentry-lean-sup'), 'supervisor');
  assert.equal(lib.roleOf('/usr/bin/tini -- /usr/local/bin/sentry-lean-supervisor'), 'tini');
  assert.equal(lib.roleOf('node -e fetch()'), 'node-other');
  assert.equal(lib.roleOf('timeout 100 node server/index.js'), 'other', 'a wrapper is not the app');
  assert.equal(lib.roleOf('', 'sh'), 'other');
});

// what the in-container script prints: tini, the supervisor, the app, one
// ffprobe, the sampler's own shell (left out), and the cgroup files
function sampleDump({ appTicks = 1000, ffprobe = true } = {}) {
  const proc = (pid, comm, ppid, uid, rssKb, ticks, cmd, io) => [
    `@@proc ${pid}`, '@stat', `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 ${pid * 10} 0 0`,
    '@status', `Name:\t${comm}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nPPid:\t${ppid}\nVmHWM:\t${rssKb + 100} kB\nVmRSS:\t${rssKb} kB`,
    '@cmdline', cmd, '@io', io || ''
  ].join('\n');
  return [
    proc(1, 'tini', 0, 0, 1000, 0, '/usr/bin/tini -- node /app/server/supervisor.js'),
    proc(7, 'node', 1, 0, 60000, 200, 'node /app/server/supervisor.js', 'rchar: 10\nread_bytes: 4096'),
    proc(20, 'node', 7, 1000, 300000, appTicks, 'node --disable-warning=ExperimentalWarning /app/server/index.js'),
    ...(ffprobe ? [proc(55, 'ffprobe', 20, 1000, 20000, 5, '/usr/local/bin/ffprobe -v error clip.mp4')] : []),
    proc(90, 'sh', 0, 0, 900, 0, 'sh -c : BENCH_SAMPLER; for d in /proc/[0-9]*; do'),
    proc(91, 'cat', 90, 0, 500, 0, 'cat /proc/91/status'),
    '@@cg memory.current', '400000000',
    '@@cg memory.peak', '500000000',
    '@@cg memory.swap.current', '0',
    '@@cg memory.stat', 'anon 300000000\nfile 90000000\nkernel 1000',
    '@@cg memory.events', 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0',
    '@@cg cpu.stat', `usage_usec ${appTicks * 10_000}\nuser_usec 1\nsystem_usec 1`,
    '@@cg io.stat', '8:0 rbytes=123456 wbytes=0 rios=10 wios=0',
    '@@end'
  ].join('\n');
}

test('bench: the in-container dump becomes processes and cgroup files; io read as the app user is merged in', () => {
  const dump = lib.parseExecDump(sampleDump());
  assert.deepEqual(dump.procs.map((p) => [p.pid, p.role]), [[1, 'tini'], [7, 'supervisor'], [20, 'server'], [55, 'ffprobe']], 'the sampler\'s own sh and cat are left out');
  const app = dump.procs.find((p) => p.role === 'server');
  assert.equal(app.rss, 300000 * 1024);
  assert.equal(app.uid, 1000);
  assert.equal(app.io, null, 'root without CAP_SYS_PTRACE could not read it');
  assert.equal(dump.procs.find((p) => p.role === 'supervisor').io.read_bytes, 4096);
  lib.mergeIo(dump.procs, '@@proc 20\n@io\nrchar: 999\nread_bytes: 777\n@@proc 55\n@io\n@@end\n');
  assert.equal(app.io.read_bytes, 777);
  assert.equal(dump.procs.find((p) => p.pid === 55).io, null);
  assert.equal(dump.cgroup['memory.current'], '400000000');
  // the script itself uses only sh, cat and tr, and marks itself
  const script = lib.sampleScript();
  assert.match(script, /BENCH_SAMPLER/);
  assert.match(script, /\/sys\/fs\/cgroup\/memory\.events/);
  assert.doesNotMatch(lib.sampleScript({ ioOnly: true }), /cgroup|status/);
});

test('bench: one tick -> a samples.csv row, with CPU % from the change since the last tick', () => {
  const at0 = Date.parse('2026-01-01T00:00:00Z');
  const first = lib.tickRows({ at: at0, startedAt: at0 - 10_000, phase: 'indexing', docker: null, dump: lib.parseExecDump(sampleDump()) });
  assert.equal(first.row.server_cpu_pct, '', 'no CPU % on the first tick');
  const docker = lib.parseDockerStats('{"MemUsage":"381.5MiB / 15.6GiB","CPUPerc":"99.9%","MemPerc":"2.4%","BlockIO":"5MB / 0B","PIDs":"9"}');
  // 5 s later the app used 250 more ticks (2.5 s of CPU): 50 %
  const second = lib.tickRows({ at: at0 + 5000, startedAt: at0 - 10_000, phase: 'indexing', docker, dump: lib.parseExecDump(sampleDump({ appTicks: 1250, ffprobe: false })), prev: first.next });
  const r = second.row;
  assert.equal(r.server_cpu_pct, 50);
  assert.equal(r.cpu_pct_cgroup, 50);
  assert.equal(r.elapsed_s, 15);
  assert.equal(r.server_rss, 300000 * 1024);
  assert.equal(r.server_hwm, 300100 * 1024);
  assert.equal(r.mem_usage, Math.round(381.5 * 1024 ** 2));
  assert.equal(r.cg_io_rbytes, 123456);
  assert.equal(r.cg_oom_kill, 0);
  assert.equal(r.ffprobe_n, 0);
  assert.equal(first.row.ffprobe_n, 1);
  assert.equal(first.row.ffprobe_rss_sum, 20000 * 1024);
  assert.equal(r.phase, 'indexing');
  assert.deepEqual(Object.keys(r), lib.SAMPLE_COLUMNS, 'the row has exactly the CSV columns, in order');
  assert.deepEqual(Object.keys(second.procRows[0]), lib.PROC_COLUMNS);
});

test('bench: CSV out and back in, quotes and commas included', () => {
  const cols = ['a', 'b', 'c'];
  const text = `${cols.join(',')}\n${lib.csvLine(cols, { a: 1, b: 'x, "y"', c: '' })}${lib.csvLine(cols, { a: 2, b: 'line\nbreak', c: null })}`;
  assert.deepEqual(lib.parseCsv(text), [{ a: '1', b: 'x, "y"', c: '' }, { a: '2', b: 'line\nbreak', c: '' }]);
  assert.deepEqual(lib.parseCsv(''), []);
});

test('bench: the archive must be mounted read-only, and nothing of it writable elsewhere', () => {
  const inspect = (mounts) => JSON.stringify([{ Mounts: mounts }]);
  const ro = { Type: 'bind', Source: '/mnt/tank/tesla', Destination: '/footage/car', Mode: 'ro', RW: false };
  const data = { Type: 'bind', Source: '/srv/bench/data', Destination: '/data', Mode: '', RW: true };
  assert.equal(lib.checkArchiveMount(inspect([data, ro])).ok, true);
  assert.equal(lib.checkArchiveMount(inspect([data, ro])).source, '/mnt/tank/tesla');
  const rw = lib.checkArchiveMount(inspect([data, { ...ro, Mode: '', RW: true }]));
  assert.equal(rw.ok, false);
  assert.match(rw.problems[0], /read-write/);
  assert.equal(lib.checkArchiveMount(inspect([data])).ok, false, 'no archive mount at all');
  const twice = lib.checkArchiveMount(inspect([data, ro, { Type: 'bind', Source: '/mnt/tank/tesla/TeslaCam', Destination: '/footage/other', RW: true }]));
  assert.equal(twice.ok, false);
  assert.match(twice.problems.join(' '), /also mounted read-write/);
  assert.equal(lib.checkArchiveMount(inspect([{ ...ro, Type: 'volume' }])).ok, false);
});

test('bench: images must be pinned unless forced', () => {
  const digest = 'ghcr.io/skittles-fivem/sentry-manager@sha256:b366c96f5caac430d2ca83e7abc284c0a9cd5695b794d93279e602bf0124800b';
  assert.deepEqual(lib.checkImageRef(digest), { ok: true, pinned: true });
  assert.equal(lib.checkImageRef('ghcr.io/skittles-fivem/sentry-manager:latest').ok, false);
  assert.equal(lib.checkImageRef('ghcr.io/skittles-fivem/sentry-manager').ok, false, 'no tag means latest');
  assert.equal(lib.checkImageRef('ghcr.io/skittles-fivem/sentry-manager:latest', { forceLatest: true }).ok, true);
  assert.deepEqual(lib.checkImageRef('localhost:5000/sentry-manager:bench-new'), { ok: true, pinned: false });
  assert.equal(lib.checkImageRef('ghcr.io/x/y@sha256:abc').ok, false);
  assert.equal(lib.checkImageRef('').ok, false);
});

test('bench: paths inside one another', () => {
  assert.equal(lib.isInside('/a/b/c', '/a/b'), true);
  assert.equal(lib.isInside('/a/b', '/a/b'), true);
  assert.equal(lib.isInside('/a/bc', '/a/b'), false);
  assert.equal(lib.isInside('/a', '/a/b'), false);
});

test('bench: sign-in helpers: env file, cookies, https only, the event to open', () => {
  assert.deepEqual(lib.parseEnvFile('UI_USERNAME=bench\nUI_PASSWORD=a=b c\n# comment\nNODE_OPTIONS=--require=/x --y\n'),
    { UI_USERNAME: 'bench', UI_PASSWORD: 'a=b c', NODE_OPTIONS: '--require=/x --y' });
  const { jar, header } = lib.cookieHeader(['__Host-sm_session=abc; HttpOnly; Secure; Path=/', 'sm_pending=; Max-Age=0']);
  assert.equal(header, '__Host-sm_session=abc');
  assert.equal(lib.cookieHeader(['__Host-sm_session=; Max-Age=0'], jar).header, '');
  assert.equal(lib.checkBaseUrl('http://localhost:9100').ok, false);
  assert.equal(lib.checkBaseUrl('https://localhost:9100').ok, true);
  assert.equal(lib.checkBaseUrl('nope').ok, false);
  assert.equal(lib.pickEvent([{ id: 'r', category: 'Recent' }, { id: 's', category: 'Sentry' }]).id, 's');
  assert.equal(lib.pickEvent([{ id: 'r', category: 'Recent' }]).id, 'r');
  assert.equal(lib.pickEvent([]), null);
});

test('bench: the first index is complete once the scan is done and a speed index pass has finished', () => {
  const t0 = 1_000_000;
  const veh = (scanning, inventory) => ({ vehicles: [{ id: 'car', scanning, inventory }] });
  let s = {};
  let step = lib.indexStep(s, { at: t0 + 5000, t0, vehicles: veh(true, null), speeds: { running: false, finishedAt: null } });
  assert.equal(step.done, false);
  assert.equal(step.row.scanning, 1);
  s = step.state;
  step = lib.indexStep(s, { at: t0 + 60_000, t0, vehicles: veh(false, { recordings: 10, files: 60, scannedAt: t0 + 57_500 }), speeds: { running: true, done: 3, total: 10, finishedAt: null } });
  assert.equal(step.done, false);
  assert.equal(step.summary.scanDoneS, 57.5, 'the app\'s own end of the scan');
  s = step.state;
  step = lib.indexStep(s, { at: t0 + 120_000, t0, vehicles: veh(false, { recordings: 10, files: 60 }), speeds: { running: false, done: 10, total: 10, finishedAt: t0 + 118_000 } });
  assert.equal(step.done, true);
  assert.equal(step.summary.indexDoneS, 118, 'the app\'s own finish time');
  assert.equal(step.summary.speedTotal, 10);
  assert.equal(step.row.files, 60);
  // nothing to index: the pass ends at once, before any poll sees it running
  const quick = lib.indexStep({}, { at: t0 + 30_000, t0, vehicles: veh(false, { recordings: 0, files: 0 }), speeds: { running: false, done: 0, total: 0, finishedAt: t0 + 29_000 } });
  assert.equal(quick.done, true);
  assert.equal(quick.summary.speedTotal, 0);
  assert.equal(lib.indexStep({}, { at: t0, t0, vehicles: { vehicles: [] }, speeds: null }).done, false, 'no vehicle yet');
});

test('bench: counters that restart with a new process are added up', () => {
  assert.equal(lib.counterTotal([null, 100, 300, 50, 80]), 380);
  assert.equal(lib.counterTotal([null, null]), null);
});

// a run folder as run.sh leaves it
function writeRun(dir, { name, digest, cache, memIdle, rssPeak, oom = 0 }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ name, imageDigest: digest, cache, profileNote: name === 'baseline' ? 'no limits' : '2 GB' }));
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const phase = i < 3 ? 'indexing' : 'idle';
    rows.push(Object.fromEntries(lib.SAMPLE_COLUMNS.map((c) => [c, ''])));
    Object.assign(rows[i], {
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 5)).toISOString(), elapsed_s: i * 5, phase,
      mem_usage: phase === 'idle' ? memIdle : memIdle * 3, server_rss: i === 1 ? rssPeak : rssPeak / 2, server_pid: 20,
      cg_io_rbytes: 1000 * (i + 1), cg_oom_kill: i === 5 ? oom : 0, cpu_pct_cgroup: 10 * i, ffprobe_n: i === 1 ? 3 : 0, ffprobe_rss_sum: i === 1 ? 60e6 : 0
    });
  }
  fs.writeFileSync(path.join(dir, 'samples.csv'), `${lib.SAMPLE_COLUMNS.join(',')}\n${rows.map((r) => lib.csvLine(lib.SAMPLE_COLUMNS, r)).join('')}`);
  const lat = [['footage-days (first)', 0, 900], ['footage-days', 1, 40], ['footage-days', 2, 60], ['drives', 1, 120], ['drives', 2, 'error']];
  fs.writeFileSync(path.join(dir, 'latency.csv'), `${lib.LATENCY_COLUMNS.join(',')}\n${lat.map(([label, rep, ms]) => lib.csvLine(lib.LATENCY_COLUMNS, { label, rep, ms: ms === 'error' ? '' : ms, status: ms === 'error' ? 'error' : 200 })).join('')}`);
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ scanDoneS: 42, indexDoneS: 3725, speedTotal: 1200 }));
  fs.writeFileSync(path.join(dir, 'final.json'), JSON.stringify({ state: { OOMKilled: oom > 0 } }));
}

test('bench: report.js turns run folders into one markdown table', (t) => {
  const dir = tmp(t);
  writeRun(path.join(dir, 'baseline-1'), { name: 'baseline', digest: 'ghcr.io/x@sha256:b366c96f5caac430d2ca83e7abc284c0a9cd5695b794d93279e602bf0124800b', cache: 'warm', memIdle: 200 * 1024 ** 2, rssPeak: 900 * 1024 ** 2 });
  writeRun(path.join(dir, 'c2g-1'), { name: 'constrained-2g', digest: 'ghcr.io/x@sha256:1111111111111111111111111111111111111111111111111111111111111111', cache: 'cold', memIdle: 150 * 1024 ** 2, rssPeak: 600 * 1024 ** 2, oom: 2 });
  const { readRun } = require('./report');
  const run = readRun(path.join(dir, 'baseline-1'));
  assert.equal(run.memIdle, 200 * 1024 ** 2);
  assert.equal(run.memPeak, 600 * 1024 ** 2);
  assert.equal(run.rssPeak, 900 * 1024 ** 2);
  assert.equal(run.diskRead.cgroup, 6000);
  assert.equal(run.latency['footage-days'].median, 50);
  assert.equal(run.latency['footage-days (first)'], undefined, 'the first call is left out unless asked for');
  assert.equal(run.latency.drives.n, 1, 'failed calls are left out');
  assert.equal(readRun(path.join(dir, 'baseline-1'), { withFirst: true }).latency['footage-days (first)'].median, 900);

  const out = path.join(dir, 'report.md');
  const r = spawnSync(process.execPath, [path.join(BENCH, 'report.js'), path.join(dir, 'baseline-1'), path.join(dir, 'c2g-1'), '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(out, 'utf8');
  assert.match(md, /^\| {2}\| \*\*baseline\*\* \| \*\*constrained-2g\*\* \|$/m);
  assert.match(md, /^\| Image \| `sha256:b366c96f5caa` \| `sha256:111111111111` \|$/m);
  assert.match(md, /^\| Cache \| warm \| cold \|$/m);
  assert.match(md, /^\| Container memory, idle \(median\) \| 200\.0 MiB \| 150\.0 MiB \|$/m);
  assert.match(md, /^\| Server RSS, peak \| 900\.0 MiB \| 600\.0 MiB \|$/m);
  assert.match(md, /^\| First index complete \(scan \+ speed index\) \| 1 h 2 min \| 1 h 2 min \|$/m);
  assert.match(md, /^\| OOM kills \(cgroup\) \/ OOMKilled \| 0 \/ false \| 2 \/ true \|$/m);
  assert.match(md, /^\| footage-days \(median \/ p95\) \| 50 ms \/ 60 ms \| 50 ms \/ 60 ms \|$/m);
  assert.match(md, /^\| ffprobe children, peak RSS \(sum\) \/ most at once \| 57\.2 MiB \/ 3 \|/m);
  // a missing file leaves "–", not a crash
  fs.mkdirSync(path.join(dir, 'empty'));
  const empty = spawnSync(process.execPath, [path.join(BENCH, 'report.js'), path.join(dir, 'empty')], { encoding: 'utf8' });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /\| Container memory, peak \| – \|/);
});

test('bench: run.sh refuses unsafe runs before touching Docker (dry run)', (t) => {
  const dir = tmp(t);
  const archive = path.join(dir, 'archive');
  fs.mkdirSync(path.join(archive, 'TeslaCam'), { recursive: true });
  const digest = 'ghcr.io/skittles-fivem/sentry-manager@sha256:b366c96f5caac430d2ca83e7abc284c0a9cd5695b794d93279e602bf0124800b';
  const run = (...extra) => spawnSync('bash', [path.join(BENCH, 'run.sh'), 'run', '--archive', archive, '--out', path.join(dir, 'runs'), '--dry-run', '--port', '39911', '--device-port', '39912', ...extra], { encoding: 'utf8' });
  const ok = run('--name', 'constrained-1g', '--image', digest, '--data', path.join(dir, 'data'), '--cache', 'warm');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`-v ${archive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:/footage/car:ro`));
  assert.match(ok.stdout, /--memory=1g/);
  assert.doesNotMatch(ok.stdout, /--cpus/);
  assert.equal(fs.existsSync(path.join(dir, 'data')), false, 'a dry run makes nothing');
  assert.match(run('--name', 'baseline', '--image', 'ghcr.io/skittles-fivem/sentry-manager:latest', '--data', path.join(dir, 'data'), '--cache', 'warm').stderr, /latest/);
  assert.match(run('--name', 'baseline', '--image', digest, '--data', path.join(archive, 'data'), '--cache', 'warm').stderr, /inside the archive/);
  fs.mkdirSync(path.join(dir, 'used'));
  fs.writeFileSync(path.join(dir, 'used', 'db.sqlite'), '');
  assert.match(run('--name', 'baseline', '--image', digest, '--data', path.join(dir, 'used'), '--cache', 'warm').stderr, /not empty/);
  assert.match(run('--name', 'baseline', '--image', digest, '--data', path.join(dir, 'data')).stderr, /--cache warm\|cold/);
  assert.match(run('--name', 'fast', '--image', digest, '--data', path.join(dir, 'data'), '--cache', 'warm').stderr, /--name must be/);
  const diag = run('--name', 'diagnostic', '--image', digest, '--data', path.join(dir, 'data'), '--cache', 'cold');
  assert.equal(diag.status, 0, diag.stderr);
  assert.match(diag.stdout, /memlog\.js:\/bench\/memlog\.js:ro/);
  assert.match(diag.stdout, /drop_caches/);
});

test('bench: sample.js and latency.js describe what they would do without Docker or a server', () => {
  const s = spawnSync(process.execPath, [path.join(BENCH, 'sample.js'), '--container', 'manager-baseline', '--dry-run'], { encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /docker stats --no-stream --format '\{\{json \.\}\}' manager-baseline/);
  assert.match(s.stdout, /BENCH_SAMPLER/);
  const l = spawnSync(process.execPath, [path.join(BENCH, 'latency.js'), 'routes'], { encoding: 'utf8' });
  assert.equal(l.status, 0, l.stderr);
  for (const route of ['/api/vehicles/:id/days?', '/api/vehicles/:id/recordings/:rid', '/api/vehicles/:id/driving?weeks=12', 'POST /api/converter/invoke/getCurrent']) {
    assert.ok(l.stdout.replace(/\s+/g, ' ').includes(route), route);
  }
  const plain = spawnSync(process.execPath, [path.join(BENCH, 'latency.js'), 'measure', '--url', 'http://localhost:9100', '--ca', '/dev/null', '--out', os.tmpdir()], { encoding: 'utf8' });
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /only sent over HTTPS/);
});

test('bench: the routes latency.js times exist in the server', () => {
  // (docs/api-contract.json: the routes the server answers, checked by tools/contract/frozen.js)
  const contract = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'api-contract.json'), 'utf8'));
  const keys = new Set(contract.routes.map((r) => `${r.method} ${r.path}`));
  for (const [method, route] of [['GET', '/api/vehicles'], ['GET', '/api/vehicles/:id/days'], ['GET', '/api/vehicles/:id/recordings'], ['GET', '/api/vehicles/:id/recordings/:rid'],
    ['GET', '/api/vehicles/:id/recordings/:rid/thumbnail'], ['GET', '/api/vehicles/:id/driving'], ['POST', '/api/converter/invoke/:name'], ['GET', '/api/speeds/status'], ['POST', '/api/auth/login']]) {
    assert.ok(keys.has(`${method} ${route}`), `${method} ${route}`);
  }
});

test('bench: memlog.js logs memoryUsage lines for the process it is preloaded into', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), 'setTimeout(() => {}, 400);\n');
  const r = spawnSync(process.execPath, [path.join(dir, 'server', 'index.js')], {
    encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--require=${path.join(BENCH, 'memlog.js')}`, MEMLOG_INTERVAL_MS: '250', MEMLOG_FILE: '' }
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stderr.split('\n').filter((l) => l.startsWith('[memlog] ')).map((l) => JSON.parse(l.slice(9)));
  assert.ok(lines.length >= 2, r.stderr);
  assert.equal(lines[0].role, 'server');
  for (const k of ['rss', 'heapUsed', 'arrayBuffers', 'external']) assert.ok(Number.isFinite(lines[0][k]), k);
});

