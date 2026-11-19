'use strict';

// The pure parts of the measurement harness (tools/bench): parsing what
// `docker stats`, `docker inspect`, /proc and the container's cgroup files
// print, CSV in and out, and the numbers report.js puts in its table. No
// Docker, no network and no clock here, so bench.test.js can feed it
// sample text.

const path = require('path');

// ---- sizes as docker prints them ("1.5GiB", "312kB", "0B")

const UNITS = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4
};

/** "1.5GiB" / "312kB" / "0B" / "--" -> bytes (a number), or null. */
function parseSize(text) {
  const m = String(text ?? '').trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([a-z]*)$/i);
  if (!m) return null;
  const unit = (m[2] || 'b').toLowerCase();
  if (!(unit in UNITS)) return null;
  return Math.round(Number(m[1]) * UNITS[unit]);
}

/** "12.34%" -> 12.34, or null. */
function parsePercent(text) {
  const m = String(text ?? '').trim().match(/^(-?[0-9]+(?:\.[0-9]+)?)%$/);
  return m ? Number(m[1]) : null;
}

/** "a / b" -> [bytes a, bytes b] (MemUsage, BlockIO, NetIO). */
function parsePair(text) {
  const parts = String(text ?? '').split('/').map((s) => s.trim());
  if (parts.length !== 2) return [null, null];
  return [parseSize(parts[0]), parseSize(parts[1])];
}

/** One line of `docker stats --no-stream --format '{{json .}}'`. */
function parseDockerStats(line) {
  let j;
  try {
    j = JSON.parse(String(line).trim());
  } catch {
    return null;
  }
  const [memUsage, memLimit] = parsePair(j.MemUsage);
  const [blkRead, blkWrite] = parsePair(j.BlockIO);
  const [netIn, netOut] = parsePair(j.NetIO);
  return {
    name: j.Name || null,
    id: j.ID || j.Container || null,
    cpuPct: parsePercent(j.CPUPerc),
    memUsage, memLimit,
    memPct: parsePercent(j.MemPerc),
    blkRead, blkWrite, netIn, netOut,
    pids: Number.isFinite(Number(j.PIDs)) ? Number(j.PIDs) : null
  };
}

// ---- /proc/<pid>/...

/** /proc/<pid>/stat: { pid, comm, state, ppid, utime, stime } (ticks). */
function parseProcStat(text) {
  const s = String(text || '');
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = s.slice(close + 2).trim().split(/\s+/);
  // fields after comm start at field 3 (state); utime is field 14, stime 15
  const field = (n) => Number(rest[n - 3]);
  return {
    pid: Number(s.slice(0, open).trim()),
    comm: s.slice(open + 1, close),
    state: rest[0],
    ppid: field(4),
    utime: field(14),
    stime: field(15),
    numThreads: field(20),
    starttime: field(22)
  };
}

/** /proc/<pid>/status: the fields the sampler uses (kB values in bytes). */
function parseProcStatus(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (/^(VmRSS|VmHWM|VmSize|VmSwap|RssAnon|RssFile|RssShmem)$/.test(key)) {
      const kb = value.match(/^(\d+)\s*kB/);
      out[key] = kb ? Number(kb[1]) * 1024 : null;
    } else if (key === 'Uid') out.uid = Number(value.split(/\s+/)[0]);
    else if (key === 'PPid') out.ppid = Number(value);
    else if (key === 'Name') out.name = value.trim();
    else if (key === 'Threads') out.threads = Number(value);
  }
  return out;
}

/** /proc/<pid>/io: { rchar, wchar, read_bytes, write_bytes, ... } as numbers. */
function parseProcIo(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(\w+):\s*(\d+)/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return Object.keys(out).length ? out : null;
}

/** cgroup v2 flat key/value files (memory.stat, memory.events, cpu.stat). */
function parseKeyValues(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(\d+)$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** cgroup v2 io.stat: summed rbytes / wbytes / rios / wios over all devices. */
function parseIoStat(text) {
  const sum = { rbytes: 0, wbytes: 0, rios: 0, wios: 0 };
  let any = false;
  for (const line of String(text || '').split('\n')) {
    for (const m of line.matchAll(/\b(rbytes|wbytes|rios|wios)=(\d+)/g)) {
      sum[m[1]] += Number(m[2]);
      any = true;
    }
  }
  return any ? sum : null;
}

/** "max" or a number in a cgroup file. */
function parseCgroupNumber(text) {
  const s = String(text ?? '').trim();
  if (s === 'max') return Infinity;
  return /^\d+$/.test(s) ? Number(s) : null;
}

// ---- which process is which

/** What a process in the container is, from its command line. */
function roleOf(cmdline, comm = '') {
  const cmd = String(cmdline || '');
  const exe = path.basename(cmd.split(' ')[0] || comm || '');
  if (exe === 'tini' || comm === 'tini') return 'tini'; // (its command line names the supervisor)
  const isNode = exe === 'node' || comm === 'node';
  if (isNode && /server\/index\.js(\s|$)/.test(cmd)) return 'server';
  if (isNode && /server\/supervisor\.js(\s|$)/.test(cmd)) return 'supervisor';
  // the Rust server (Dockerfile): the supervisor and the app it starts
  // (comm is cut to 15 characters: "sentry-lean-sup")
  if (exe === 'sentry-lean-supervisor' || comm === 'sentry-lean-sup') return 'supervisor';
  if (exe === 'sentry-lean' || comm === 'sentry-lean') return 'server';
  if (exe === 'ffprobe' || comm === 'ffprobe') return 'ffprobe';
  if (exe === 'ffmpeg' || comm === 'ffmpeg') return 'ffmpeg';
  if (exe === 'node' || comm === 'node') return 'node-other';
  return 'other';
}

/**
 * The text the sampler's `docker exec ... sh -c` prints, split into one
 * record per process plus the cgroup files. The script prints sections:
 *   @@proc <pid>            then @stat / @status / @cmdline / @io blocks
 *   @@cg <file>             then the file's contents
 * (sampleScript below writes exactly this).
 */
function parseExecDump(text) {
  const procs = new Map();
  const cgroup = {};
  let cur = null; // { kind: 'proc', pid, part } or { kind: 'cg', file }
  let buf = [];
  const flush = () => {
    if (!cur) return;
    const body = buf.join('\n');
    if (cur.kind === 'cg') cgroup[cur.file] = body;
    else if (cur.part) {
      const p = procs.get(cur.pid) || { pid: cur.pid };
      p[cur.part] = body;
      procs.set(cur.pid, p);
    }
    buf = [];
  };
  for (const line of String(text || '').split('\n')) {
    let m;
    if ((m = line.match(/^@@proc (\d+)$/))) {
      flush();
      cur = { kind: 'proc', pid: Number(m[1]), part: null };
    } else if (cur?.kind === 'proc' && (m = line.match(/^@(stat|status|cmdline|io)$/))) {
      flush();
      cur = { ...cur, part: m[1] };
    } else if ((m = line.match(/^@@cg (\S+)$/))) {
      flush();
      cur = { kind: 'cg', file: m[1] };
    } else if (line === '@@end') {
      flush();
      cur = null;
    } else buf.push(line);
  }
  flush();
  const list = [];
  for (const raw of procs.values()) {
    const stat = parseProcStat(raw.stat);
    if (!stat) continue; // the process ended while it was read
    const status = parseProcStatus(raw.status);
    const cmdline = String(raw.cmdline || '').replace(/\0/g, ' ').trim();
    if (/BENCH_SAMPLER/.test(cmdline)) continue; // the sampler's own shell
    if ((stat.comm === 'cat' || stat.comm === 'tr') && /^(cat|tr)( |$)/.test(cmdline)) continue; // its cat / tr
    list.push({
      pid: stat.pid, ppid: stat.ppid, comm: stat.comm, uid: status.uid ?? null,
      cmdline, role: roleOf(cmdline, stat.comm),
      utime: stat.utime, stime: stat.stime, starttime: stat.starttime,
      rss: status.VmRSS ?? null, hwm: status.VmHWM ?? null, swap: status.VmSwap ?? null,
      rssAnon: status.RssAnon ?? null, rssFile: status.RssFile ?? null,
      io: parseProcIo(raw.io)
    });
  }
  return { procs: list.sort((a, b) => a.pid - b.pid), cgroup };
}

/**
 * /proc/<pid>/io blocks from a second exec as the app's own user, merged into
 * procs: root without CAP_SYS_PTRACE cannot read another user's io file.
 */
function mergeIo(procs, ioDump) {
  const byPid = new Map();
  let pid = null;
  let buf = [];
  const flush = () => {
    const io = pid === null ? null : parseProcIo(buf.join('\n'));
    if (io) byPid.set(pid, io);
    buf = [];
  };
  for (const line of String(ioDump || '').split('\n')) {
    const m = line.match(/^@@proc (\d+)$/);
    if (m || line === '@@end') {
      flush();
      pid = m ? Number(m[1]) : null;
    } else if (line !== '@io') buf.push(line);
  }
  flush();
  for (const p of procs) if (!p.io && byPid.has(p.pid)) p.io = byPid.get(p.pid);
  return procs;
}

/**
 * The shell script run inside the container each tick (it uses only sh and
 * cat, which the image has). `cgroupFiles` are read from /sys/fs/cgroup,
 * the container's own cgroup (cgroup v2 namespaces it).
 */
function sampleScript({ ioOnly = false } = {}) {
  const cg = ['memory.current', 'memory.peak', 'memory.max', 'memory.swap.current', 'memory.swap.max',
    'memory.stat', 'memory.events', 'cpu.stat', 'io.stat', 'pids.current',
    // cgroup v1 hosts (older Docker setups): the same figures under other names
    'memory/memory.usage_in_bytes', 'memory/memory.max_usage_in_bytes', 'memory/memory.stat', 'memory/memory.oom_control',
    'cpuacct/cpuacct.usage', 'blkio/blkio.throttle.io_service_bytes'];
  const parts = ioOnly ? ['io'] : ['stat', 'status', 'cmdline', 'io'];
  return [
    ': BENCH_SAMPLER;',
    'for d in /proc/[0-9]*; do',
    '  p=${d#/proc/};',
    '  echo "@@proc $p";',
    ...parts.map((part) => (part === 'cmdline'
      ? '  echo "@cmdline"; tr "\\000" " " 2>/dev/null < $d/cmdline; echo;'
      : `  echo "@${part}"; cat $d/${part} 2>/dev/null;`)),
    'done;',
    ...(ioOnly ? [] : cg.map((f) => `echo "@@cg ${f}"; cat /sys/fs/cgroup/${f} 2>/dev/null;`)),
    'echo "@@end"'
  ].join('\n');
}

/**
 * The container's cgroup figures from v2 files, or the v1 ones where the
 * host has cgroup v1: { current, peak, swap, mstat: {anon, file}, events:
 * {oom, oom_kill}, io: {rbytes, wbytes}, cpuUsec }.
 */
function cgroupFigures(files) {
  const v2 = files['memory.current'] !== undefined && files['memory.current'].trim() !== '';
  if (v2) {
    return {
      current: parseCgroupNumber(files['memory.current']),
      peak: parseCgroupNumber(files['memory.peak']),
      swap: parseCgroupNumber(files['memory.swap.current']),
      mstat: parseKeyValues(files['memory.stat']),
      events: parseKeyValues(files['memory.events']),
      io: parseIoStat(files['io.stat']),
      cpuUsec: parseKeyValues(files['cpu.stat']).usage_usec ?? null
    };
  }
  const st = parseKeyValues(files['memory/memory.stat']);
  const oom = parseKeyValues(files['memory/memory.oom_control']);
  let io = null;
  for (const line of String(files['blkio/blkio.throttle.io_service_bytes'] || '').split('\n')) {
    const m = line.trim().match(/^\S+\s+(Read|Write)\s+(\d+)$/);
    if (m) {
      io ||= { rbytes: 0, wbytes: 0 };
      io[m[1] === 'Read' ? 'rbytes' : 'wbytes'] += Number(m[2]);
    }
  }
  const ns = parseCgroupNumber(files['cpuacct/cpuacct.usage']);
  return {
    current: parseCgroupNumber(files['memory/memory.usage_in_bytes']),
    peak: parseCgroupNumber(files['memory/memory.max_usage_in_bytes']),
    swap: st.total_swap ?? st.swap ?? null,
    mstat: { anon: st.total_rss ?? st.rss, file: st.total_cache ?? st.cache },
    events: { oom_kill: oom.oom_kill, oom: oom.under_oom },
    io,
    cpuUsec: ns === null ? null : Math.round(ns / 1000)
  };
}

// ---- one CSV row per tick

const SAMPLE_COLUMNS = [
  'ts', 'elapsed_s', 'phase',
  'mem_usage', 'mem_limit', 'mem_pct', 'cpu_pct_docker', 'blk_read', 'blk_write', 'pids',
  'cg_mem_current', 'cg_mem_peak', 'cg_anon', 'cg_file', 'cg_swap', 'cg_oom_kill', 'cg_oom', 'cg_io_rbytes', 'cg_io_wbytes', 'cpu_pct_cgroup',
  'server_pid', 'server_rss', 'server_hwm', 'server_cpu_pct', 'server_read_bytes', 'server_rchar',
  'supervisor_rss', 'supervisor_cpu_pct', 'supervisor_read_bytes',
  'ffprobe_n', 'ffprobe_rss_sum', 'ffprobe_rss_max', 'ffmpeg_n', 'ffmpeg_rss_sum',
  'other_rss_sum', 'procs_rss_sum', 'procs_read_bytes_sum'
];

const PROC_COLUMNS = ['ts', 'elapsed_s', 'pid', 'ppid', 'uid', 'role', 'rss', 'hwm', 'swap', 'cpu_pct', 'read_bytes', 'rchar', 'cmd'];

/**
 * One tick's rows from the parsed inputs. prev: the previous tick's
 * { at, procs: Map pid -> {utime, stime, starttime}, cpuUsec } for CPU %.
 * clkTck: the kernel's clock ticks per second (getconf CLK_TCK, 100).
 */
function tickRows({ at, startedAt, phase, docker, dump, prev, clkTck = 100 }) {
  const dt = prev ? (at - prev.at) / 1000 : null;
  const cpuOf = (p) => {
    const before = prev?.procs.get(p.pid);
    if (!dt || !before || before.starttime !== p.starttime) return null;
    const ticks = (p.utime + p.stime) - (before.utime + before.stime);
    return Math.round((ticks / clkTck / dt) * 1000) / 10;
  };
  const procs = dump.procs;
  const cg = cgroupFigures(dump.cgroup || {});
  const { mstat, events, io, cpuUsec } = cg;
  const cgCpu = dt && cpuUsec !== null && prev?.cpuUsec != null ? Math.round(((cpuUsec - prev.cpuUsec) / 1e6 / dt) * 1000) / 10 : null;

  const ts = new Date(at).toISOString();
  const elapsed = Math.round((at - startedAt) / 100) / 10;
  const by = (role) => procs.filter((p) => p.role === role);
  const server = by('server').sort((a, b) => (b.rss || 0) - (a.rss || 0))[0] || null;
  const supervisor = by('supervisor')[0] || null;
  const ffprobe = by('ffprobe');
  const ffmpeg = by('ffmpeg');
  const sum = (list, f) => list.reduce((s, p) => s + (f(p) || 0), 0);
  const others = procs.filter((p) => !['server', 'supervisor', 'ffprobe', 'ffmpeg'].includes(p.role));

  const row = {
    ts, elapsed_s: elapsed, phase: phase || '',
    mem_usage: docker?.memUsage ?? '', mem_limit: docker?.memLimit ?? '', mem_pct: docker?.memPct ?? '',
    cpu_pct_docker: docker?.cpuPct ?? '', blk_read: docker?.blkRead ?? '', blk_write: docker?.blkWrite ?? '', pids: docker?.pids ?? '',
    cg_mem_current: cg.current ?? '',
    cg_mem_peak: cg.peak ?? '',
    cg_anon: mstat.anon ?? '', cg_file: mstat.file ?? '',
    cg_swap: cg.swap ?? '',
    cg_oom_kill: events.oom_kill ?? '', cg_oom: events.oom ?? '',
    cg_io_rbytes: io?.rbytes ?? '', cg_io_wbytes: io?.wbytes ?? '',
    cpu_pct_cgroup: cgCpu ?? '',
    server_pid: server?.pid ?? '', server_rss: server?.rss ?? '', server_hwm: server?.hwm ?? '',
    server_cpu_pct: server ? cpuOf(server) ?? '' : '',
    server_read_bytes: server?.io?.read_bytes ?? '', server_rchar: server?.io?.rchar ?? '',
    supervisor_rss: supervisor?.rss ?? '', supervisor_cpu_pct: supervisor ? cpuOf(supervisor) ?? '' : '',
    supervisor_read_bytes: supervisor?.io?.read_bytes ?? '',
    ffprobe_n: ffprobe.length, ffprobe_rss_sum: sum(ffprobe, (p) => p.rss),
    ffprobe_rss_max: ffprobe.reduce((m, p) => Math.max(m, p.rss || 0), 0),
    ffmpeg_n: ffmpeg.length, ffmpeg_rss_sum: sum(ffmpeg, (p) => p.rss),
    other_rss_sum: sum(others, (p) => p.rss),
    procs_rss_sum: sum(procs, (p) => p.rss),
    procs_read_bytes_sum: sum(procs, (p) => p.io?.read_bytes)
  };
  const procRows = procs.map((p) => ({
    ts, elapsed_s: elapsed, pid: p.pid, ppid: p.ppid, uid: p.uid ?? '', role: p.role,
    rss: p.rss ?? '', hwm: p.hwm ?? '', swap: p.swap ?? '', cpu_pct: cpuOf(p) ?? '',
    read_bytes: p.io?.read_bytes ?? '', rchar: p.io?.rchar ?? '', cmd: p.cmdline.slice(0, 160)
  }));
  const next = { at, cpuUsec, procs: new Map(procs.map((p) => [p.pid, { utime: p.utime, stime: p.stime, starttime: p.starttime }])) };
  return { row, procRows, next };
}

// ---- CSV

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(columns, row) {
  return `${columns.map((c) => csvCell(row[c])).join(',')}\n`;
}

/** CSV text -> array of objects (strings; '' for empty). Handles quotes. */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// ---- safety checks for run.sh (also used by its dry run)

/**
 * The archive mount in `docker inspect` output (JSON text or object):
 * { ok, problems[] }. It must exist, be a bind mount and be read-only.
 */
function checkArchiveMount(inspect, destination = '/footage/car') {
  let info = inspect;
  if (typeof info === 'string') info = JSON.parse(info);
  if (Array.isArray(info)) info = info[0];
  const mounts = info?.Mounts || [];
  const problems = [];
  const hit = mounts.find((m) => m.Destination === destination);
  if (!hit) problems.push(`no mount at ${destination}`);
  else {
    if (hit.RW !== false) problems.push(`${destination} is mounted read-write (RW=${hit.RW}); it must be :ro`);
    if (hit.Type && hit.Type !== 'bind') problems.push(`${destination} is a ${hit.Type} mount, not a bind mount of the archive`);
  }
  // nothing else of the archive may be writable through another mount
  for (const m of mounts) {
    if (m !== hit && hit && m.Source && hit.Source && (m.Source === hit.Source || m.Source.startsWith(`${hit.Source}/`)) && m.RW !== false) {
      problems.push(`${m.Source} (part of the archive) is also mounted read-write at ${m.Destination}`);
    }
  }
  return { ok: problems.length === 0, problems, source: hit?.Source || null };
}

/** An image reference that names a fixed build: a digest, or a tag that is not "latest". */
function checkImageRef(ref, { forceLatest = false } = {}) {
  const s = String(ref || '').trim();
  if (!s) return { ok: false, problem: 'no image given' };
  if (/@sha256:[0-9a-f]{64}$/.test(s)) return { ok: true, pinned: true };
  if (/@/.test(s)) return { ok: false, problem: `${s}: a digest must be @sha256:<64 hex>` };
  const last = s.split('/').pop();
  const tag = last.includes(':') ? last.split(':').pop() : 'latest';
  if (tag === 'latest' && !forceLatest) {
    return { ok: false, problem: `${s} follows "latest", which changes under you; pin a digest (image@sha256:...) or pass --force-latest` };
  }
  return { ok: true, pinned: false };
}

/** Whether `inner` is `outer` or inside it (both absolute, normalised). */
function isInside(inner, outer) {
  const rel = path.relative(path.resolve(outer), path.resolve(inner));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Extra `docker run` arguments of each named run. */
const RUN_PROFILES = {
  baseline: { args: [], note: 'no limits' },
  'constrained-2g': { args: ['--cpus=4', '--memory=2g'], note: '4 CPUs, 2 GB' },
  'constrained-1g': { args: ['--memory=1g'], note: '1 GB' },
  diagnostic: { args: [], note: 'memlog preload, heap snapshots on SIGUSR2; numbers include the preload, never compare them with the others' }
};

// ---- latency.js helpers

/** KEY=value lines (a docker --env-file) -> object. */
function parseEnvFile(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/\r$/, '');
  }
  return out;
}

/** Set-Cookie headers -> one Cookie header value (name=value pairs only). */
function cookieHeader(setCookie, jar = new Map()) {
  for (const c of [].concat(setCookie || [])) {
    const [pair] = String(c).split(';');
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (value === '' || /;\s*Max-Age=0/i.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
  return { jar, header: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
}

/** A base URL the harness may send a password to: https only. */
function checkBaseUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, problem: `${url} is not a URL` };
  }
  if (u.protocol !== 'https:') return { ok: false, problem: `${url}: the password is only sent over HTTPS (https://localhost:<port>)` };
  return { ok: true, url: u };
}

/** The recording to time "open an event" with: newest Sentry or Saved, else the newest of any kind. */
function pickEvent(recordings) {
  const list = [...(recordings || [])];
  return list.find((r) => r.category === 'Sentry' || r.category === 'Saved') || list[0] || null;
}

/**
 * One index poll folded into the running state. `vehicles` is GET
 * /api/vehicles, `speeds` GET /api/speeds/status, `at` ms, `t0` ms (the
 * container's start). The scan is done once every vehicle has an inventory
 * and none is scanning; the first index is complete once, after that, the
 * speed index is idle with a pass finished after the scan.
 */
function indexStep(state, { at, t0, vehicles, speeds }) {
  const s = { scanDoneAt: null, indexDoneAt: null, sawSpeedRun: false, speedTotal: null, ...state };
  const list = vehicles?.vehicles || [];
  const scanned = list.length > 0 && list.every((v) => v.inventory && !v.scanning);
  if (scanned && s.scanDoneAt === null) {
    // the app's own end-of-scan time (inventory.scannedAt, ms) when plausible
    const own = Math.max(...list.map((v) => Number(v.inventory.scannedAt) || 0));
    s.scanDoneAt = own >= t0 && own <= at ? own : at;
  }
  if (speeds?.running) {
    s.sawSpeedRun = true;
    if (Number.isFinite(speeds.total)) s.speedTotal = Math.max(s.speedTotal || 0, speeds.total);
  }
  // (a pass only starts when a scan has finished: finishedAt set means one ran)
  if (s.indexDoneAt === null && scanned && speeds && !speeds.running && speeds.finishedAt) {
    // the app's own finish time when it is plausible, else when this poll saw it
    s.indexDoneAt = speeds.finishedAt >= t0 && speeds.finishedAt <= at ? speeds.finishedAt : at;
    if (s.speedTotal === null && Number.isFinite(speeds.total)) s.speedTotal = speeds.total;
  }
  const totals = list.reduce((acc, v) => ({ recordings: acc.recordings + (v.inventory?.recordings || 0), files: acc.files + (v.inventory?.files || 0) }), { recordings: 0, files: 0 });
  const row = {
    ts: new Date(at).toISOString(), elapsed_s: Math.round((at - t0) / 100) / 10,
    vehicles: list.length, scanning: list.some((v) => v.scanning) ? 1 : 0,
    recordings: totals.recordings, files: totals.files,
    speed_running: speeds?.running ? 1 : 0, speed_done: speeds?.done ?? '', speed_total: speeds?.total ?? '', speed_day: speeds?.day ?? ''
  };
  const summary = {
    t0: new Date(t0).toISOString(),
    scanDoneS: s.scanDoneAt === null ? null : Math.round((s.scanDoneAt - t0) / 100) / 10,
    indexDoneS: s.indexDoneAt === null ? null : Math.round((s.indexDoneAt - t0) / 100) / 10,
    speedTotal: s.speedTotal, recordings: totals.recordings, files: totals.files
  };
  return { state: s, row, summary, done: s.indexDoneAt !== null };
}

const INDEX_COLUMNS = ['ts', 'elapsed_s', 'vehicles', 'scanning', 'recordings', 'files', 'speed_running', 'speed_done', 'speed_total', 'speed_day'];
const LATENCY_COLUMNS = ['ts', 'phase', 'label', 'method', 'route', 'rep', 'status', 'ms', 'ttfb_ms', 'bytes'];

/** A script's opening comment block, as its --help text. */
function usage(file) {
  const lines = require('fs').readFileSync(file, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('//'));
  const out = [];
  for (let i = from; i >= 0 && i < lines.length && lines[i].startsWith('//'); i++) out.push(lines[i].replace(/^\/\/ ?/, ''));
  return out.join('\n');
}

// ---- report

const num = (v) => (v === '' || v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v));
const max = (list) => list.reduce((m, v) => (v === null ? m : m === null ? v : Math.max(m, v)), null);
const median = (list) => {
  const xs = list.filter((v) => v !== null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
};
const percentile = (list, p) => {
  const xs = list.filter((v) => v !== null).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
};

/** Counters that only grow, but restart at 0 with a new process: the total. */
function counterTotal(values) {
  let total = 0;
  let last = null;
  for (const v of values) {
    if (v === null) continue;
    if (last === null) total += v;
    else if (v >= last) total += v - last;
    else total += v; // a new process started from 0
    last = v;
  }
  return last === null ? null : total;
}

/**
 * The numbers of one run from its samples.csv / latency.csv / index.json
 * rows and meta.json. Idle = the samples whose phase is "idle"; peak = all.
 */
function summarizeRun({ meta = {}, samples = [], latency = [], index = null }) {
  const col = (rows, c) => rows.map((r) => num(r[c]));
  const idle = samples.filter((r) => r.phase === 'idle');
  // the container's memory: docker stats' figure, else the cgroup's
  const mem = (rows) => rows.map((r) => num(r.mem_usage) ?? num(r.cg_mem_current));
  const lastOf = (rows, c) => { for (let i = rows.length - 1; i >= 0; i--) { const v = num(rows[i][c]); if (v !== null) return v; } return null; };
  const firstOf = (rows, c) => { for (const r of rows) { const v = num(r[c]); if (v !== null) return v; } return null; };
  const diskRead = (() => {
    const cg = lastOf(samples, 'cg_io_rbytes');
    const first = firstOf(samples, 'cg_io_rbytes');
    const docker = lastOf(samples, 'blk_read');
    return { cgroup: cg, cgroupFromFirst: cg !== null && first !== null ? cg - first : null, docker, server: counterTotal(col(samples, 'server_read_bytes')) };
  })();
  const serverPids = [...new Set(samples.map((r) => r.server_pid).filter(Boolean))];
  const routes = {};
  for (const r of latency) {
    if (r.status && !/^2/.test(r.status)) continue;
    (routes[r.label] ||= []).push(num(r.ms));
  }
  const latencyOut = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, { n: v.length, median: median(v), p95: percentile(v, 95), max: max(v) }]));
  return {
    name: meta.name || '?',
    image: meta.imageDigest || meta.image || '?',
    cache: meta.cache || '?',
    limits: meta.profileNote || '',
    samples: samples.length,
    durationS: lastOf(samples, 'elapsed_s'),
    memPeak: max(mem(samples)),
    cgPeak: max(col(samples, 'cg_mem_peak')),
    memIdle: median(mem(idle)),
    memIdleEnd: idle.length ? mem(idle).at(-1) : null,
    rssPeak: max(col(samples, 'server_rss')),
    rssIdle: median(col(idle, 'server_rss')),
    hwm: max(col(samples, 'server_hwm')),
    supervisorRss: median(col(samples, 'supervisor_rss')),
    ffprobePeak: max(col(samples, 'ffprobe_rss_sum')),
    ffprobeMaxN: max(col(samples, 'ffprobe_n')),
    swapPeak: max(col(samples, 'cg_swap')),
    oomKills: max(col(samples, 'cg_oom_kill')) ?? 0,
    oomKilled: meta.final?.OOMKilled ?? null,
    serverRestarts: Math.max(0, serverPids.length - 1),
    cpuPeak: max(col(samples, 'cpu_pct_cgroup').map((v, i) => v ?? num(samples[i].cpu_pct_docker))),
    diskRead,
    index,
    latency: latencyOut
  };
}

function fmtBytes(n) {
  if (n === null || n === undefined) return '–';
  const abs = Math.abs(n);
  if (abs >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (abs >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (abs >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
}

function fmtSeconds(s) {
  if (s === null || s === undefined) return '–';
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  if (s >= 60) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Math.round(s * 10) / 10} s`;
}

const fmtMs = (v) => (v === null || v === undefined ? '–' : `${Math.round(v)} ms`);

/** Runs (summarizeRun results) -> one markdown table, one column per run. */
function markdownReport(runs) {
  const head = ['', ...runs.map((r) => `**${r.name}**`)];
  const line = (label, f) => [label, ...runs.map((r) => { try { return f(r); } catch { return '–'; } })];
  const latencyLabels = [...new Set(runs.flatMap((r) => Object.keys(r.latency)))];
  const rows = [
    line('Image', (r) => `\`${String(r.image).replace(/^.*@/, '').slice(0, 19)}\``),
    line('Cache', (r) => r.cache),
    line('Limits', (r) => r.limits || '–'),
    line('Run length', (r) => fmtSeconds(r.durationS)),
    line('Container memory, peak', (r) => fmtBytes(r.memPeak)),
    line('Container memory, cgroup peak (incl. page cache)', (r) => fmtBytes(r.cgPeak)),
    line('Container memory, idle (median)', (r) => fmtBytes(r.memIdle)),
    line('Container memory, end of idle', (r) => fmtBytes(r.memIdleEnd)),
    line('Server RSS, peak', (r) => fmtBytes(r.rssPeak)),
    line('Server RSS, idle (median)', (r) => fmtBytes(r.rssIdle)),
    line('Server VmHWM (kernel peak)', (r) => fmtBytes(r.hwm)),
    line('supervisor RSS (median)', (r) => fmtBytes(r.supervisorRss)),
    line('ffprobe children, peak RSS (sum) / most at once', (r) => `${fmtBytes(r.ffprobePeak)} / ${r.ffprobeMaxN ?? '–'}`),
    line('CPU, peak (100% = 1 core)', (r) => (r.cpuPeak === null ? '–' : `${r.cpuPeak}%`)),
    line('Disk read (cgroup io.stat)', (r) => fmtBytes(r.diskRead.cgroup)),
    line('Disk read (docker BlockIO)', (r) => fmtBytes(r.diskRead.docker)),
    line('Disk read by the server (/proc io)', (r) => fmtBytes(r.diskRead.server)),
    line('Inventory scan', (r) => fmtSeconds(r.index?.scanDoneS)),
    line('First index complete (scan + speed index)', (r) => fmtSeconds(r.index?.indexDoneS)),
    line('Clips speed-indexed', (r) => (r.index?.speedTotal ?? '–')),
    line('Swap used, peak', (r) => fmtBytes(r.swapPeak)),
    line('OOM kills (cgroup) / OOMKilled', (r) => `${r.oomKills ?? 0} / ${r.oomKilled === null ? '–' : r.oomKilled}`),
    line('App restarts (new server pid)', (r) => r.serverRestarts),
    ...latencyLabels.map((l) => line(`${l} (median / p95)`, (r) => (r.latency[l] ? `${fmtMs(r.latency[l].median)} / ${fmtMs(r.latency[l].p95)}` : '–')))
  ];
  const md = (cells) => `| ${cells.join(' | ')} |`;
  return [md(head), md(head.map(() => '---')), ...rows.map(md)].join('\n');
}

module.exports = {
  parseSize, parsePercent, parsePair, parseDockerStats,
  parseProcStat, parseProcStatus, parseProcIo, parseKeyValues, parseIoStat, parseCgroupNumber,
  roleOf, parseExecDump, mergeIo, sampleScript, cgroupFigures,
  SAMPLE_COLUMNS, PROC_COLUMNS, tickRows,
  csvCell, csvLine, parseCsv,
  checkArchiveMount, checkImageRef, isInside, RUN_PROFILES,
  usage, parseEnvFile, cookieHeader, checkBaseUrl, pickEvent, indexStep, INDEX_COLUMNS, LATENCY_COLUMNS,
  counterTotal, median, percentile, summarizeRun, markdownReport, fmtBytes, fmtSeconds
};

// run.sh's checks:  node lib.js check-image <ref> [--force-latest]
//                   node lib.js check-mount <docker inspect JSON file> [<destination>]
//                   node lib.js inside <path> <folder>      (exit 0 when it is inside)
if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'check-image') {
    const r = checkImageRef(a, { forceLatest: process.argv.includes('--force-latest') });
    if (!r.ok) { console.error(r.problem); process.exit(1); }
    console.log(r.pinned ? 'pinned' : 'tag');
  } else if (cmd === 'check-mount') {
    const r = checkArchiveMount(require('fs').readFileSync(a, 'utf8'), b && !b.startsWith('--') ? b : undefined);
    if (!r.ok) { for (const p of r.problems) console.error(p); process.exit(1); }
    console.log(`read-only: ${r.source}`);
  } else if (cmd === 'inside') process.exit(isInside(a, b) ? 0 : 1);
  else { console.error('usage: lib.js check-image|check-mount|inside ...'); process.exit(2); }
}
