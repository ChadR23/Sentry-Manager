'use strict';

// The server monitor's screens: Overview > Server (web/app.js) and the
// Encoder's Hardware panel (scripts/features/hardwarePanel.js), drawn from
// sample GET /api/stats bodies of different machines. Only tiles with
// numbers are drawn, every string from the machine is escaped, and the
// panel asks the server only while it can be seen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..');
const sample = (name = '') => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `statsSample${name ? `-${name}` : ''}.json`), 'utf8'));
const SAMPLES = ['', 'amd', 'nvidia', 'pi', 'idle'];
const hardware = () => import(pathToFileURL(path.join(REPO, 'src/renderer/scripts/features/hardwarePanel.js')).href);

// app.js is one browser script; its drawing part has no DOM and runs here as is
function overview() {
  const app = fs.readFileSync(path.join(REPO, 'web/app.js'), 'utf8');
  const start = app.indexOf('// ---- server monitor: drawing');
  const end = app.indexOf('// ---- server monitor: end of drawing ----');
  assert.ok(start > 0 && end > start, 'the drawing block is marked in app.js');
  const helpers = ['esc', 'plural'].map((name) => app.match(new RegExp(`\\n  const ${name} = .*;\\n`))[0]).join('');
  return new Function(`${helpers}${app.slice(start, end)}
    return { serverBody, hostLine, alertChip, spark, size, sizeOf, rate, kwh, money, sensorName, cpuName };`)();
}

const HOSTILE = '<img src=x onerror=alert(1)>';
const tileTitles = (html) => [...html.matchAll(/<div class="nd-title"><span>([^<]+)<\/span>/g)].map((m) => m[1]);

test('Overview: an Intel + Arc server mid-conversion shows every tile, like the mockup', () => {
  const { serverBody, hostLine, alertChip } = overview();
  const s = sample();
  const html = serverBody(s, { currency: '$' });
  assert.deepEqual(tileTitles(html), ['CPU', 'GPU', 'GPU', 'Power', 'Memory', 'Storage', 'Network', 'Sensors', 'Top processes']);
  assert.match(html, /Intel Core i5-12500 · 6 cores \/ 12 threads/);
  assert.match(html, /<b>37%<\/b>/);
  assert.equal((html.match(/<i style="--v:/g) || []).length, 12, 'one bar per thread');
  assert.match(html, /22% \(ffmpeg ×4: 18%\)/);
  assert.match(html, /Intel Arc A380 · xe · renderD128/);
  assert.match(html, /1\.1 \/ 6 GB/);
  assert.match(html, /4 × ffmpeg/);
  assert.match(html, /<b>65 W<\/b><span class="muted small">CPU \+ GPU/);
  assert.match(html, /0\.94 kWh · ≈ \$0\.14/);
  assert.match(html, /5\.2 kWh · ≈ \$0\.78/);
  assert.match(html, /0\.31 kWh this run/);
  assert.match(html, /18\.2 GB/);
  assert.match(html, /112 of 476 GB/);
  assert.match(html, /6\.1 of 8 TB/);
  assert.match(html, /<span class="nd-warn">71 °C<\/span>/, 'the hot NVMe disk');
  assert.match(html, /↓ 112 MB\/s/);
  assert.match(html, /<dt>Core max<\/dt><dd>63 °C<\/dd>/, 'six cores, one row');
  assert.match(html, /<dt>Fan 1<\/dt><dd>1,180 rpm<\/dd>/);
  assert.match(html, /ffmpeg · hevc_vaapi ×4/, 'the same program is one row');
  assert.match(html, /<div class="nd-alert"><b>Warning<\/b>NVMe nvme0n1 at 71 °C/);
  assert.match(html, /<code>pid: host<\/code>/);
  assert.equal((html.match(/<svg class="nd-spark"/g) || []).length, 3, 'CPU, the GPU that encodes, network');
  assert.match(hostLine(s.host), /nas-box.*kernel 6\.8\.0-45-generic.*up 12 d 4 h.*app up 3 h 12 m.*version 98d4861/);
  assert.match(alertChip(s.alerts), /chip amber.*1 warning/);
});

test('Overview: a Raspberry Pi shows only what it has', () => {
  const { serverBody } = overview();
  const html = serverBody(sample('pi'));
  assert.deepEqual(tileTitles(html), ['CPU', 'Memory', 'Storage', 'Sensors']);
  assert.doesNotMatch(html, /nd-alert/);
  assert.match(html, /Raspberry Pi 4 Model B Rev 1\.4 · 4 cores/);
  assert.match(html, /<dt>CPU<\/dt><dd>52 °C<\/dd>/);
  // an ARM board has no CPU energy counter to offer; the whole-server view is still offered
  assert.doesNotMatch(html, /CPU power in watts/);
  assert.match(html, /pid: host/, 'what the optional compose line would add');
});

test('Overview: AMD and NVIDIA servers, time-of-use price, errors before warnings', () => {
  const { serverBody, alertChip } = overview();
  const amd = serverBody(sample('amd'), { currency: '€' });
  assert.match(amd, /AMD Ryzen 7 5700G · 8 cores \/ 16 threads/);
  assert.match(amd, /GPU \(CPU not measured\)/);
  assert.match(amd, /€0\.29 per kWh · Peak/);
  assert.match(amd, /2 interfaces/);
  assert.match(amd, /the whole server/);
  assert.match(amd, /Show all 14/, 'long sensor lists fold');
  assert.match(serverBody(sample('amd'), { more: { sensors: true } }), /Show fewer/);
  const nv = sample('nvidia');
  const html = serverBody(nv);
  assert.match(html, /NVIDIA GeForce RTX 3060/);
  assert.doesNotMatch(html, /≈/, 'no price set: energy only, never a made-up cost');
  assert.match(html, /<div class="nd-alert bad"><b>Problem<\/b>Old NAS is not reachable/);
  assert.match(html, /<span class="nd-bad">not reachable<\/span>/);
  assert.match(html, /<span class="nd-warn">answers in 2\.3 s<\/span>/);
  assert.match(alertChip(nv.alerts), /chip red.*3 problems/);
});

test('Overview: names from the machine are text, never markup', () => {
  const { serverBody, hostLine } = overview();
  const s = sample('nvidia');
  assert.match(serverBody(s), /Model 3 &lt;garage&gt;/);
  const evil = sample();
  evil.host.hostname = HOSTILE;
  evil.cpu.model = HOSTILE;
  evil.gpus[0].name = HOSTILE;
  evil.gpus[0].node = '"><b>x';
  evil.disks[0].model = HOSTILE;
  evil.filesystems[0].label = HOSTILE;
  evil.network.interfaces[0].name = HOSTILE;
  evil.sensors.push({ chip: HOSTILE, label: HOSTILE, kind: 'temp', value: 40 });
  evil.processes.top[0].name = HOSTILE;
  evil.alerts[0].message = HOSTILE;
  evil.unlock[0] = { key: 'x', adds: HOSTILE, compose: HOSTILE };
  evil.price.rate = HOSTILE;
  evil.price.currency = '<b>';
  evil.encoder.device.encoder = HOSTILE;
  const html = serverBody(evil, { currency: '<b>' }) + hostLine(evil.host);
  assert.doesNotMatch(html, /<img|<b>x/);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('Overview: missing, null and odd values never break the page', () => {
  const { serverBody } = overview();
  assert.match(serverBody({}), /no numbers to show/);
  const odd = {
    cpu: { usage: 12, perCore: null, load: [null, 1, 'x'], app: null }, memory: { totalB: 0, usedB: 0 },
    gpus: 'none', power: { totalW: null }, disks: [null, { name: 'sda' }], filesystems: [{ label: 'x', totalB: null, reachable: false }],
    network: { interfaces: [{ name: 'eth0' }] }, sensors: [{ chip: 'x', label: 'y', kind: 'temp', value: null }], processes: { top: null },
    alerts: [null, { level: 'warn' }], unlock: 'x', sparks: { cpu: [1, null, 'x'] }
  };
  const html = serverBody(odd);
  assert.deepEqual(tileTitles(html), ['CPU', 'Storage']);
  assert.match(html, /read — · write —/);
  assert.doesNotMatch(html, /NaN|undefined|null/);
  for (const name of SAMPLES) assert.doesNotMatch(serverBody(sample(name)), /NaN|undefined|null|Infinity/, `statsSample ${name}`);
});

test('Overview: the 24 h graphs come from history, with gaps where the server was off', () => {
  const { serverBody, spark } = overview();
  const n = 1440;
  const series = { cpu: [], gpuVideo: [], gpuBusy: [], rxBps: [] };
  for (let i = 0; i < n; i++) {
    const off = i >= 300 && i < 330;
    series.cpu.push(off ? null : 10 + (i % 7));
    series.gpuVideo.push(null); // this GPU reports no video engine: the busy series instead
    series.gpuBusy.push(off ? null : 40);
    series.rxBps.push(off ? null : 1e6);
  }
  const html = serverBody(sample(), { range: '24h', hist: { step: 60000, start: 0, series } });
  assert.equal((html.match(/<div class="nd-axis"><span>24 h ago<\/span><span>now<\/span><\/div>/g) || []).length, 3);
  const cpu = spark(series.cpu, 'var(--accent)', 10);
  assert.equal((cpu.match(/fill="none"/g) || []).length, 2, 'two lines around the gap');
  assert.equal(spark([5], 'x', 10), '', 'one point is no line');
  assert.equal(spark(null, 'x', 10), '');
  // a quiet server is not drawn as a mountain range: 0 at the bottom, at least `floor` on top
  const flat = spark([1, 2, 1, 2], 'x', 10);
  const ys = [...flat.matchAll(/,(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).filter((y) => y < 40);
  assert.ok(Math.min(...ys) > 25, 'low values stay low');
});

test('Overview: units read like the mockup', () => {
  const { size, sizeOf, rate, kwh, money, cpuName, sensorName } = overview();
  const G = 1024 ** 3;
  assert.equal(size(31.3 * G), '31.3 GB');
  assert.equal(size(640 * 1024 ** 2), '640 MB');
  assert.equal(size(476 * G), '476 GB');
  assert.equal(sizeOf(112 * G, 476 * G), '112 of 476 GB');
  assert.equal(sizeOf(0, 2 * G, ' / '), '0 / 2 GB');
  assert.equal(rate(112 * 1024 ** 2), '112 MB/s');
  assert.equal(rate(0), '0 MB/s');
  assert.equal(rate(300 * 1024), '300 KB/s');
  assert.equal(rate(2.5 * G), '2.5 GB/s');
  assert.equal(kwh(940), '0.94 kWh');
  assert.equal(kwh(5200), '5.2 kWh');
  assert.equal(kwh(250000), '250 kWh');
  assert.equal(money(0.141, '$'), '≈ $0.14');
  assert.equal(money(1.2, 'kr'), '≈ 1.20 kr');
  assert.equal(cpuName('Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz'), 'Intel Core i7-10700');
  assert.equal(sensorName({ chip: 'k10temp', label: 'Tctl' }), 'CPU (Tctl)');
  assert.equal(sensorName({ chip: 'amdgpu', label: 'junction', kind: 'temp' }), 'GPU hotspot');
  assert.equal(sensorName({ chip: 'it8689', label: 'temp2', kind: 'temp' }), 'it8689 2');
});

test('Hardware panel: four clips on the Arc, with efficiency and cost', async () => {
  const { renderHardware } = await hardware();
  const html = renderHardware(sample());
  assert.match(html, /<span class="nd-chip" title="hevc_vaapi · Intel Arc A380 · renderD128">hevc_vaapi · Intel Arc A380 · renderD128<\/span><span class="nd-chip">decode: GPU<\/span><span class="nd-chip">4 at once<\/span>/);
  assert.match(html, /<span>Video engine<\/span><b>94%<\/b><div class="nd-bar hot">/);
  assert.match(html, /<span>CPU \(conversions\)<\/span><b>18%<\/b>/);
  assert.match(html, /<b>65 W<\/b><small>CPU 41 · GPU 24<\/small>/);
  assert.match(html, /<b>61 °C<\/b><small>GPU 61 · CPU 58<\/small>/);
  assert.doesNotMatch(html, /Bottleneck|Room to spare|nd-hint/, 'no sentence about what limits the run');
  assert.match(html, /This run<\/span><b>0\.31 kWh/);
  assert.match(html, /Clips per kWh<\/span><b>1,329/);
  assert.match(html, /Space saved per kWh<\/span><b>125 GB/);
  assert.match(html, /Cost so far<\/span><b>≈ \$0\.05/);
  assert.equal((html.match(/class="nd-w"/g) || []).length, 4);
  assert.match(html, /2026-10-20_07-38-45-front\.mp4<\/span><span>71%/);
  assert.match(html, /412 fps · 6\.9× realtime · 4\.1 Mb\/s · no dropped frames/);
});

test('Hardware panel: software encoding, NVIDIA, dropped frames, idle and paused', async () => {
  const { renderHardware } = await hardware();
  const amd = renderHardware(sample('amd'));
  assert.match(amd, /libx265 · CPU/);
  assert.doesNotMatch(amd, /Video engine/, 'no GPU in use: no video engine tile');
  assert.match(amd, /<span class="nd-warn">2 duplicated<\/span>/);
  assert.match(amd, /≈ €0\.52/);
  const nv = renderHardware(sample('nvidia'));
  assert.match(nv, /hevc_nvenc · NVIDIA GeForce RTX 3060/);
  assert.match(nv, /Video engine<\/span><b>41%/, 'the GPU found by name (NVIDIA has no render node)');
  assert.match(nv, /3 dropped/);
  assert.match(nv, /starting…/);
  assert.doesNotMatch(nv, /Cost so far/, 'no price: no cost');
  const idle = renderHardware(sample('idle'));
  assert.match(idle, /nd-hw-idle/);
  assert.match(idle, /Idle<\/span><span class="nd-chip">Intel Arc A380 · renderD128/);
  assert.doesNotMatch(idle, /nd-w"/);
  assert.match(renderHardware(sample('pi')), /CPU encoding \(no GPU encoder seen\)/);
  const paused = sample();
  paused.encoder = { ...paused.encoder, running: false, workers: [] };
  assert.match(renderHardware(paused), /Paused<\/span><span class="nd-chip">hevc_vaapi · Intel Arc A380 · renderD128/);
});

test('Hardware panel: escapes names, survives odd bodies, folds long worker lists', async () => {
  const { renderHardware, gpuFor } = await hardware();
  const evil = sample();
  evil.encoder.workers[0].relativePath = `SentryClips/${HOSTILE}.mp4`;
  evil.encoder.device.gpuName = HOSTILE;
  evil.encoder.device.encoder = '"><script>x</script>';
  // a server from before the hint was removed still sends one: never shown
  evil.encoder.bottleneck = { kind: 'cpu', message: HOSTILE };
  const html = renderHardware(evil);
  assert.doesNotMatch(html, /<img|<script/);
  assert.doesNotMatch(html, /Bottleneck|Room to spare|nd-hint/);
  assert.equal(renderHardware(null), '');
  assert.doesNotThrow(() => renderHardware({ encoder: { running: true, workers: null, run: null }, gpus: 'x', cpu: null, power: null }));
  assert.doesNotMatch(renderHardware({ encoder: { running: true, workers: [{}], run: { wh: 0, clips: 0 } } }), /NaN|undefined|Infinity/);
  const many = sample();
  many.encoder.workers = Array.from({ length: 64 }, (_, i) => ({ ...many.encoder.workers[0], itemId: `i${i}` }));
  const big = renderHardware(many);
  assert.equal((big.match(/class="nd-w"/g) || []).length, 16);
  assert.match(big, /and 48 more/);
  assert.equal(gpuFor([{ name: 'a', node: 'renderD128' }, { name: 'b', node: 'renderD129' }], { node: '/dev/dri/renderD129' }).name, 'b');
  assert.equal(gpuFor([{ name: 'a' }, { name: 'b' }], { node: null, gpuName: 'zzz' }), null, 'never a guess between two GPUs');
});

test('Hardware panel: asks every 2 s only while it can be seen', async (t) => {
  const { startHardwarePanel } = await hardware();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = {};
  const on = (target) => (type, fn) => { (listeners[`${target}:${type}`] ||= []).push(fn); };
  const panel = { hidden: true, innerHTML: '', closest: () => null, parentElement: null };
  const doc = { visibilityState: 'visible', getElementById: (id) => (id === 'converterHardware' ? panel : null), addEventListener: on('doc') };
  const win = { location: { origin: 'https://nas' }, addEventListener: on('win') };
  let asked = 0;
  const body = sample();
  const fetchImpl = async () => {
    asked++;
    return { ok: true, json: async () => body };
  };
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  startHardwarePanel({ doc, win, fetchImpl });
  await settle();
  assert.equal(asked, 1);
  assert.equal(panel.hidden, false);
  assert.match(panel.innerHTML, /Hardware/);
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(asked, 2);
  // the manager put the Encoder tab away
  listeners['win:message'].forEach((fn) => fn({ origin: 'https://nas', data: { type: 'pause' } }));
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(asked, 2, 'nothing while put away');
  listeners['win:message'].forEach((fn) => fn({ origin: 'https://evil', data: { type: 'shown' } }));
  await settle();
  assert.equal(asked, 2, 'other origins are ignored');
  listeners['win:message'].forEach((fn) => fn({ origin: 'https://nas', data: { type: 'shown' } }));
  await settle();
  assert.equal(asked, 3, 'asks at once when shown');
  // the browser tab is hidden
  doc.visibilityState = 'hidden';
  listeners['doc:visibilitychange'].forEach((fn) => fn());
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(asked, 3);
  doc.visibilityState = 'visible';
  listeners['doc:visibilitychange'].forEach((fn) => fn());
  await settle();
  assert.equal(asked, 4);
});

test('the Encoder page loads the Hardware panel without holding up its first paint', () => {
  const page = fs.readFileSync(path.join(REPO, 'src/renderer/encoder.html'), 'utf8');
  assert.match(page.split('</head>')[0], /<script type="module" src="scripts\/features\/hardwarePanel\.js"><\/script>/);
  const live = page.slice(page.indexOf('id="converterRunTitle"'), page.indexOf('id="converterReconnectBanner"'));
  assert.match(live, /<section id="converterHardware" class="nd-hw"[^>]* hidden><\/section>/, 'inside Live run, under its heading');
});
