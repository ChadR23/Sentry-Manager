#!/usr/bin/env node
'use strict';

// The 5-second sampler: reads a running container from the outside only
// (`docker stats`, and `docker exec` running sh + cat over /proc and the
// container's cgroup files) and appends one row per tick to samples.csv, plus
// one row per process per tick to procs.csv. Nothing in the app is asked.
//
//   node tools/bench/sample.js --container manager-baseline --out bench-runs/<run>
//        [--interval 5] [--phase-file <file>] [--puid 1000] [--duration <s>]
//        [--once]       one tick to stdout, then stop (a quick check)
//        [--dry-run]    print the commands and the in-container script only
//
// It stops when the container stops (or on SIGINT/SIGTERM, or after
// --duration), and writes final.json: the container's last State from
// `docker inspect` (OOMKilled, ExitCode, restarts).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const lib = require('./lib');

function args(argv) {
  const out = { interval: 5, puid: '1000' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--container') out.container = val();
    else if (a === '--out') out.out = val();
    else if (a === '--interval') out.interval = Number(val());
    else if (a === '--phase-file') out.phaseFile = val();
    else if (a === '--puid') out.puid = val();
    else if (a === '--duration') out.duration = Number(val());
    else if (a === '--once') out.once = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  return out;
}

function docker(argv, { timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', argv, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }));
      else resolve(String(stdout));
    });
  });
}

async function main() {
  const opt = args(process.argv.slice(2));
  if (opt.help || !opt.container) {
    console.log(lib.usage(__filename));
    process.exit(opt.help ? 0 : 2);
  }
  const statsArgs = ['stats', '--no-stream', '--format', '{{json .}}', opt.container];
  const rootArgs = ['exec', '-u', '0', opt.container, 'sh', '-c', lib.sampleScript()];
  const ioArgs = ['exec', '-u', `${opt.puid}`, opt.container, 'sh', '-c', lib.sampleScript({ ioOnly: true })];
  if (opt.dryRun) {
    console.log(`every ${opt.interval} s:`);
    console.log(`  docker ${statsArgs.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' ')}`);
    console.log(`  docker exec -u 0 ${opt.container} sh -c <script below>`);
    console.log(`  docker exec -u ${opt.puid} ${opt.container} sh -c <the same, /proc/<pid>/io only>`);
    console.log(`columns: ${lib.SAMPLE_COLUMNS.join(',')}`);
    console.log('--- in-container script ---');
    console.log(lib.sampleScript());
    return;
  }

  const inspect = JSON.parse(await docker(['inspect', opt.container]))[0];
  const startedAt = Date.parse(inspect.State.StartedAt) || Date.now();
  const clkTck = Number((await docker(['exec', opt.container, 'getconf', 'CLK_TCK']).catch(() => '100')).trim()) || 100;

  let samplesOut = null;
  let procsOut = null;
  if (!opt.once) {
    if (!opt.out) throw new Error('--out <run dir> is needed');
    fs.mkdirSync(opt.out, { recursive: true });
    const samplesFile = path.join(opt.out, 'samples.csv');
    const procsFile = path.join(opt.out, 'procs.csv');
    if (!fs.existsSync(samplesFile)) fs.writeFileSync(samplesFile, `${lib.SAMPLE_COLUMNS.join(',')}\n`);
    if (!fs.existsSync(procsFile)) fs.writeFileSync(procsFile, `${lib.PROC_COLUMNS.join(',')}\n`);
    samplesOut = fs.createWriteStream(samplesFile, { flags: 'a' });
    procsOut = fs.createWriteStream(procsFile, { flags: 'a' });
  }

  let prev = null;
  let stopping = false;
  let wake = () => {};
  const stop = () => { stopping = true; wake(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const until = opt.duration ? Date.now() + opt.duration * 1000 : Infinity;

  async function tick() {
    const at = Date.now();
    // the three reads at once: docker stats itself takes about 1-2 s
    const [statsText, dumpText, ioText] = await Promise.all([
      docker(statsArgs).catch(() => ''),
      docker(rootArgs),
      docker(ioArgs).catch(() => '')
    ]);
    const dockerStats = lib.parseDockerStats(statsText.split('\n').find((l) => l.trim()) || '');
    const dump = lib.parseExecDump(dumpText);
    lib.mergeIo(dump.procs, ioText);
    let phase = '';
    if (opt.phaseFile) { try { phase = fs.readFileSync(opt.phaseFile, 'utf8').trim(); } catch { /* not yet */ } }
    const { row, procRows, next } = lib.tickRows({ at, startedAt, phase, docker: dockerStats, dump, prev, clkTck });
    prev = next;
    return { row, procRows };
  }

  if (opt.once) {
    await tick();
    await new Promise((r) => setTimeout(r, 1000));
    const { row, procRows } = await tick();
    console.log(JSON.stringify(row, null, 2));
    for (const p of procRows) console.log(`${p.pid}\t${p.role}\t${lib.fmtBytes(Number(p.rss) || 0)}\t${p.cpu_pct}%\t${p.cmd}`);
    return;
  }

  while (!stopping && Date.now() < until) {
    const began = Date.now();
    try {
      const { row, procRows } = await tick();
      samplesOut.write(lib.csvLine(lib.SAMPLE_COLUMNS, row));
      for (const p of procRows) procsOut.write(lib.csvLine(lib.PROC_COLUMNS, p));
    } catch (err) {
      // the container stopped (or was OOM killed): record why, then end
      const state = await docker(['inspect', '-f', '{{json .State}}', opt.container]).then(JSON.parse).catch(() => null);
      if (!state?.Running) break;
      process.stderr.write(`sample: ${err.message.split('\n')[0]}\n`);
    }
    const wait = opt.interval * 1000 - (Date.now() - began);
    if (wait > 0 && !stopping) await new Promise((r) => { const t = setTimeout(r, wait); wake = () => { clearTimeout(t); r(); }; });
  }
  const final = await docker(['inspect', '-f', '{{json .State}}', opt.container]).then(JSON.parse).catch(() => null);
  const restarts = await docker(['inspect', '-f', '{{.RestartCount}}', opt.container]).then((s) => Number(s.trim())).catch(() => null);
  fs.writeFileSync(path.join(opt.out, 'final.json'), `${JSON.stringify({ at: new Date().toISOString(), restartCount: restarts, state: final }, null, 2)}\n`);
  await Promise.all([samplesOut, procsOut].map((s) => new Promise((r) => s.end(r))));
}

main().catch((err) => {
  console.error(`sample.js: ${err.message}`);
  process.exit(1);
});
