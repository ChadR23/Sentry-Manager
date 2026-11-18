'use strict';

// Automatic conversion, the benchmark and the device list run by the Node
// converter on scenarios the Rust tests write, for their parity tests
// (lean/src/converter/parity_tests.rs):
//
//   node lean/parity/converterAuto.js auto <scenario.json>      every state and call, step by step, and the files written
//   node lean/parity/converterAuto.js bench <scenario.json>     the progress events and the result
//   node lean/parity/converterAuto.js devices <scenario.json>   the device list and devices()
//
// A scenario is plain data, so both sides run exactly the same thing.

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const req = (p) => require(path.join(REPO, p));

// ---- automatic conversion

function fakeService(calls) {
  const jobs = new Map();
  let n = 0;
  return {
    jobs,
    start: async (config) => {
      if (calls.refuse) {
        const code = calls.refuse;
        calls.refuse = null;
        throw Object.assign(new Error(code), { code });
      }
      n += 1;
      const id = `job-${n}`;
      calls.list.push(['start', id, config]);
      jobs.set(id, { id, state: 'encoding', config: JSON.parse(JSON.stringify(config)), items: [] });
      return id;
    },
    get: async (id) => (jobs.has(id) ? JSON.parse(JSON.stringify(jobs.get(id))) : null),
    list: async () => [...jobs.values()].map((j) => JSON.parse(JSON.stringify(j))),
    pause: async (id) => { calls.list.push(['pause', id]); if (jobs.has(id)) jobs.get(id).state = 'paused'; return {}; },
    resume: async (id) => { calls.list.push(['resume', id]); if (jobs.has(id) && jobs.get(id).state === 'paused') jobs.get(id).state = 'encoding'; return {}; },
    setLanes: async (id, lanes) => { calls.list.push(['setLanes', id, lanes]); return {}; }
  };
}

async function auto(scenario) {
  const { createAutoConverter } = req('src/main/converter/autoConvert');
  const dir = scenario.directory;
  const calls = { list: [], refuse: null };
  const service = fakeService(calls);
  const world = { now: scenario.now || 0, hour: scenario.hour ?? 12, clips: scenario.clips || {}, down: new Set(), devices: scenario.devices ?? null, priorities: scenario.priorities || {}, busy: false, cheap: null, ticks: 0 };
  const scanner = async function* (config) {
    if (world.down.has(config.sourceRoot)) throw Object.assign(new Error('down'), { code: 'SOURCE_UNAVAILABLE' });
    for (const clip of world.clips[config.sourceRoot] || []) yield clip;
  };
  const make = () => createAutoConverter({
    service, scanner, fs: fs.promises, directory: dir,
    timers: { setInterval: () => null, clearInterval: () => {} },
    // (each tick asks the hour, or the rate, exactly once: the ticks are counted)
    now: () => world.now, hourOf: () => { world.ticks += 1; return world.hour; }, isBusy: async () => world.busy,
    isCheapNow: () => { world.ticks += 1; return world.cheap; },
    devices: async () => { if (world.devices === 'fail') throw new Error('x'); return world.devices; },
    nodePriorities: async () => world.priorities
  });
  let a = make();
  const out = [];
  for (const step of scenario.steps) {
    let value = null;
    world.ticks = 0;
    switch (step.op) {
      case 'start': value = await a.start(); break;
      case 'restart': a.stop(); a = make(); value = await a.start(); break;
      case 'configure': try { value = await a.configure(step.value); } catch (e) { value = { error: e.code }; } break;
      case 'tick': await a.tick(); break;
      case 'checkNow': await a.checkNow(); break;
      case 'finish': {
        const job = service.jobs.get(step.id);
        Object.assign(job, { state: step.state || 'completed', items: step.items || [], ...(step.moreAfter ? { moreAfter: step.moreAfter } : {}) });
        break;
      }
      case 'manual': service.jobs.set(step.id, { id: step.id, state: step.state || 'encoding', config: { sourceRoot: '/manual' }, items: [] }); break;
      case 'set': Object.assign(world, step.world); if (step.down) world.down = new Set(step.down); break;
      case 'refuse': calls.refuse = step.code; break;
      case 'setLanes': try { await a.setLanes(step.lanes, step.root); } catch (e) { value = { error: e.code }; } break;
      case 'setConcurrency': await a.setConcurrency(step.value, step.root); break;
      case 'saveVehicle': try { await a.saveVehicle(step.config); } catch (e) { value = { error: e.code }; } break;
      case 'forgetVehicle': await a.forgetVehicle(step.root); break;
      case 'ownerResumed': await a.ownerResumed(step.id); break;
      case 'isKnown': value = a.isKnown(step.config, step.clip); break;
      default: throw new Error(`unknown step ${step.op}`);
    }
    // a tick the step started is joined, or one more runs: the Rust side runs
    // as many as were counted here
    await a.tick();
    out.push({ op: step.op, ticks: world.ticks, value: step.op === 'isKnown' || (value && value.error) ? value : null, state: a.getState(), calls: calls.list.splice(0) });
  }
  a.stop();
  const files = {};
  for (const name of fs.readdirSync(dir).sort()) files[name] = fs.readFileSync(path.join(dir, name), 'utf8');
  return { steps: out, files };
}

// ---- the benchmark

async function bench(scenario) {
  const { runConverterBenchmark } = req('src/main/converter/benchmark');
  let clock = 0;
  let token = 0;
  const events = [];
  const meter = scenario.meter ? {
    start: () => { if (scenario.meter.failStart) throw new Error('no'); token += 1; return `token-${token}`; },
    stop: (t) => {
      const r = scenario.meter.readings[Number(t.slice(6)) - 1];
      if (r === 'error') throw new Error('gone');
      return r ?? null;
    }
  } : null;
  const result = await runConverterBenchmark({
    clips: scenario.clips.map((c) => ({ sourcePath: path.join(scenario.directory, c.name), name: c.name })),
    tempRoot: scenario.directory,
    countFrames: async (p) => fs.readFileSync(p).length,
    encoder: scenario.encoder,
    now: () => clock,
    powerMeter: meter,
    compareVerifyModes: scenario.compare || [],
    onProgress: (e) => events.push(e),
    runLevel: async ({ level, sourceRoot, verifyMode }) => {
      clock += (scenario.seconds[String(level)] ?? 1) * 1000 + (verifyMode === 'full' ? 500 : 0);
      if (scenario.cancelAt === level) throw Object.assign(new Error('c'), { code: 'CANCELLED' });
      const dir = path.join(sourceRoot, 'RecentClips');
      const items = fs.readdirSync(dir).sort().map((n) => {
        const body = fs.readFileSync(path.join(dir, n), 'utf8');
        const rule = (scenario.fail || []).find((f) => (f.content === undefined || f.content === body) && (f.fromLevel === undefined || level >= f.fromLevel));
        return rule
          ? { state: 'failed', relativePath: `RecentClips/${n}`, failure: { code: rule.code } }
          : { state: 'completed', relativePath: `RecentClips/${n}`, sourceBytes: 1000, outputBytes: 400 };
      });
      return { items, timings: { files: items.length, totalMs: { verify: 1234 * items.length } } };
    }
  }).catch((e) => ({ error: e.code }));
  return { events, result };
}

// ---- devices

function fakeProbe(works) {
  const gpuOf = (args) => {
    const at = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
    if (at('-gpu')) return `nvidia${at('-gpu')}`;
    const qsv = /child_device=([^,]+)/.exec(at('-init_hw_device') || '');
    if (qsv) return qsv[1];
    return at('-vaapi_device') || 'default';
  };
  return async (_c, args) => {
    if (args.includes('-encoders')) return { status: 0, stdout: works.advertised.map((n) => ` V..... ${n}  x`).join('\n'), stderr: '' };
    const encoder = args[args.indexOf('-c:v') + 1];
    if (encoder.startsWith('lib')) return { status: 0, stdout: '', stderr: '' };
    const gpu = gpuOf(args);
    if ((works.timeout || []).includes(`${encoder}@${gpu}`)) return { status: null, timedOut: true, stdout: '', stderr: '' };
    return (works.ok[encoder] || []).includes(gpu) ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: 'no' };
  };
}

async function devices(scenario) {
  const { createDeviceDiscovery } = req('src/main/converter/encodeDevices');
  const lists = [];
  for (const m of scenario.machines || []) {
    const discovery = createDeviceDiscovery({
      devRoot: m.dev, sysRoot: m.sys, platform: 'linux', statRdev: null,
      runCommand: async () => m.nvidia ?? { status: null, error: { code: 'PROCESS_START_FAILED' }, stdout: '' }
    });
    lists.push(await discovery.list());
  }
  const { createConverterRuntime } = req('src/main/converter/runtime');
  const { createEncoderPlanner } = req('src/main/converter/encoderPlanner');
  const answers = [];
  for (const [n, c] of (scenario.cases || []).entries()) {
    const dir = path.join(scenario.directory, `rt-${n}`);
    for (const name of ['data', 'temp']) fs.mkdirSync(path.join(dir, name), { recursive: true });
    const runtime = await createConverterRuntime({
      userDataPath: fs.realpathSync(path.join(dir, 'data')), tempPath: fs.realpathSync(path.join(dir, 'temp')),
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', spawn: require('child_process').spawn, autoConvert: false,
      factories: {
        createEncoderPlanner: () => createEncoderPlanner({ runProbe: fakeProbe(c.works), platform: 'linux' }),
        createDeviceDiscovery: () => ({ list: async () => c.devices })
      }
    });
    const first = await runtime.devices();
    const again = await runtime.devices();
    const resolved = [];
    for (const id of c.resolve || []) resolved.push(await runtime.resolveDevice(id));
    answers.push({ first, again, resolved });
    await runtime.shutdown();
  }
  return { lists, answers };
}

(async () => {
  const [mode, file] = process.argv.slice(2);
  const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
  const run = { auto, bench, devices }[mode];
  if (!run) throw new Error(`unknown mode ${mode}`);
  process.stdout.write(JSON.stringify(await run(scenario)));
})().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(2);
});
