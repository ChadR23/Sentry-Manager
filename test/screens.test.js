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
    return { serverBody, hostLine, alertChip, spark, size, sizeOf, rate, energyText, money, sensorName, cpuName, steady };`)();
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
  assert.match(html, /940 Wh · ≈ \$0\.14/, 'below 1 kWh in Wh');
  assert.match(html, /5\.2 kWh · ≈ \$0\.78/);
  assert.match(html, /310 Wh this run/);
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

test('Overview: the Power tile and the Jobs page show energy below 1 kWh in Wh', () => {
  const { serverBody } = overview();
  const owner = sample('amd');
  Object.assign(owner.power, { todayWh: 12.44, weekWh: 0.8, todayCost: null, weekCost: null });
  owner.encoder.run = { ...owner.encoder.run, wh: 0.8 };
  const html = serverBody(owner, { currency: '€' });
  assert.match(html, /<dt>Today<\/dt><dd>12\.4 Wh<\/dd><dt>This week<\/dt><dd>0\.8 Wh<\/dd><dt>Converting<\/dt><dd>0\.8 Wh this run<\/dd>/);
  // the Jobs page's energy column uses the same words
  const app = fs.readFileSync(path.join(REPO, 'web/app.js'), 'utf8');
  assert.match(app, /const energy = \(e\) => \(fin\(e\?\.wh\) \? `\$\{energyText\(e\.wh\)\}/);
  assert.doesNotMatch(app, /\bkwh\(/, 'one energy format everywhere');
});

// the owner's server between two polls: Ryzen 7 8700G, Radeon 780M, no RAPL
function ownerPoll(i) {
  const s = sample('amd');
  s.gpus = [{ ...s.gpus[0], name: 'AMD Radeon 780M', integrated: true, video: i % 2 ? null : 72, clients: i % 2 ? 0 : 4, clockMHz: i % 2 ? null : 2700 }];
  s.cpu.tempC = i % 2 ? null : 61;
  s.processes.top = [
    { pid: 41, name: 'ffmpeg', cpu: 4, memB: 1e8, gpuVideo: i % 2 ? null : 20 },
    { pid: 7, name: 'node', cpu: 2, memB: 2e8, gpuVideo: null },
    ...(i % 2 ? [] : [{ pid: 90, name: 'ffprobe', cpu: 1, memB: 3e7, gpuVideo: null }])
  ];
  s.sensors = [{ chip: 'k10temp', label: 'Tctl', kind: 'temp', value: 61 }, ...(i % 2 ? [{ chip: 'amdgpu', label: 'edge', kind: 'temp', value: null }] : [{ chip: 'amdgpu', label: 'edge', kind: 'temp', value: 58 }])];
  return s;
}

test('Overview: rows and columns stay in place between polls, with — while there is no value', () => {
  const { serverBody } = overview();
  const seen = new Map();
  const rowsOf = (html, tile) => {
    const at = html.indexOf(`<span>${tile}</span>`);
    const part = html.slice(at, html.indexOf('<div class="nd-tile', at + 1) === -1 ? undefined : html.indexOf('<div class="nd-tile', at + 1));
    return [...part.matchAll(/<(?:dt|span)>([^<]+)<\/(?:dt|span)>(?:<div class="nd-bar[^"]*"><span[^>]*><\/span><\/div>)?<(?:dd|b)[^>]*>([^<]*)<\/(?:dd|b)>/g)].map((m) => `${m[1]}=${m[2]}`);
  };
  const a = serverBody(ownerPoll(0), { seen });
  const b = serverBody(ownerPoll(1), { seen });
  assert.deepEqual(rowsOf(a, 'GPU'), ['Render / 3D=31%', 'Video=72%', 'VRAM=0.9 / 8 GB', 'Clock=2.7 GHz', 'Temp=54 °C', 'Power=39 W', 'Clients=4 × ffmpeg']);
  assert.deepEqual(rowsOf(b, 'GPU'), ['Render / 3D=31%', 'Video=—', 'VRAM=0.9 / 8 GB', 'Clock=—', 'Temp=54 °C', 'Power=39 W', 'Clients=none'], 'the Video row stays while a new clip starts');
  assert.match(b, /<b>—<\/b><span class="muted small">video engine<\/span>/, 'the big number keeps its label');
  assert.deepEqual(rowsOf(b, 'CPU').filter((r) => r.startsWith('Temp')), ['Temp=—']);
  assert.match(b, /<dt>GPU<\/dt><dd>—<\/dd>/, 'a sensor without a reading keeps its row');
  // the GPU column stays with a GPU in the server; 8 rows always
  for (const html of [a, b]) {
    const table = html.slice(html.indexOf('<table class="nd-procs">'), html.indexOf('</table>'));
    assert.match(table, /<th>GPU<\/th>/);
    assert.equal((table.match(/<tr/g) || []).length, 1 + 8, 'a header and 8 rows');
    assert.equal((table.match(/<tr class="nd-pad" aria-hidden="true">/g) || []).length, 8 - (html === a ? 3 : 2));
  }
  // the same tiles, the same rows, in the same order
  const shape = (html) => html.replace(/>[^<]*</g, '><').replace(/style="[^"]*"/g, '').replace(/ title="[^"]*"/g, '').replace(/<tr class="nd-pad"[^]*?<\/tr>|<tr><td>[^]*?<\/tr>/g, '<tr/>');
  assert.equal(shape(b), shape(a));
  // a page that has seen nothing keeps the old rule: rows only with values
  const fresh = rowsOf(serverBody(ownerPoll(1)), 'GPU');
  assert.ok(!fresh.some((r) => r.startsWith('Clock')), 'no Clock row it never had');
  assert.ok(fresh.includes('Video=—'), 'a GPU that reports its video engine always has the row');
});

test('Overview: steady() keeps rows a tile has shown, in their order, and nothing it never showed', () => {
  const { steady } = overview();
  const seen = new Map();
  assert.deepEqual(steady(seen, 't', [['A', '1'], ['B', ''], ['C', '3']]), [['A', '1'], ['C', '3']]);
  assert.deepEqual(steady(seen, 't', [['A', ''], ['B', '2'], ['C', '4']]), [['A', '—'], ['B', '2'], ['C', '4']], 'B joins where the tile lists it; A keeps its place');
  assert.deepEqual(steady(seen, 't', [['C', '5']]), [['A', '—'], ['B', '—'], ['C', '5']], 'rows left out keep their place too');
  assert.deepEqual(steady(seen, 't', [['A', '', false, 'no']]), [['A', 'no'], ['B', '—'], ['C', '—']], "a row's own placeholder");
  assert.deepEqual(steady(seen, 'other', [['A', '']]), [], 'per tile');
  assert.deepEqual(steady(null, 't', [['A', '1'], null]), [['A', '1']], 'no memory: as given');
  // the same label twice is two rows, in their order
  const twice = new Map();
  assert.deepEqual(steady(twice, 's', [['NVMe', '78 °C', true], ['NVMe', '41 °C'], ['GPU', '50 °C']]), [['NVMe', '78 °C', true], ['NVMe', '41 °C'], ['GPU', '50 °C']]);
  assert.deepEqual(steady(twice, 's', [['NVMe', ''], ['NVMe', '42 °C'], ['GPU', '51 °C']]), [['NVMe', '—'], ['NVMe', '42 °C'], ['GPU', '51 °C']]);
  assert.deepEqual(steady(twice, 's', [['GPU', '52 °C']]), [['NVMe', '—'], ['NVMe', '—'], ['GPU', '52 °C']]);
  assert.deepEqual(steady(twice, 's', [['1:x', 'a:b']])[0], ['1:x', 'a:b'], 'a label with a colon in it');
  assert.deepEqual(steady(twice, 's', [])[0], ['1:x', '—']);
});

test('Overview: two drives (or GPUs) with the same sensor name each keep their row; a hot one stays marked', () => {
  const { serverBody } = overview();
  const s = sample('amd');
  s.sensors = [
    { chip: 'nvme', label: 'Composite', kind: 'temp', value: 78 },
    { chip: 'nvme', label: 'Composite', kind: 'temp', value: 41 },
    { chip: 'amdgpu', label: 'edge', kind: 'temp', value: 50 },
    { chip: 'amdgpu', label: 'edge', kind: 'temp', value: 66 }
  ];
  const sensors = (html) => [...html.slice(html.indexOf('nd-sensors')).matchAll(/<dt>([^<]+)<\/dt><dd( class="nd-warn")?>([^<]+)<\/dd>/g)].map((m) => `${m[1]}=${m[3]}${m[2] ? ' (hot)' : ''}`);
  const want = ['NVMe=78 °C (hot)', 'NVMe=41 °C', 'GPU=50 °C', 'GPU=66 °C'];
  assert.deepEqual(sensors(serverBody(s)), want, 'without memory');
  const seen = new Map();
  assert.deepEqual(sensors(serverBody(s, { seen })), want, 'with memory');
  s.sensors[1] = { ...s.sensors[1], value: null };
  assert.deepEqual(sensors(serverBody(s, { seen })), ['NVMe=78 °C (hot)', 'NVMe=—', 'GPU=50 °C', 'GPU=66 °C']);
});

test('Overview: a GPU left out of one sample keeps its tile and place; processes stay one line', () => {
  const { serverBody } = overview();
  const seen = new Map();
  const full = sample();
  const titles = (html) => tileTitles(html).join(',');
  const a = serverBody(full, { seen });
  const gone = sample();
  gone.gpus = []; // the GPU read failed outright for a moment
  const b = serverBody(gone, { seen });
  assert.equal(titles(b), titles(a), 'the same tiles in the same order');
  assert.match(b, /Intel Arc A380 · xe · renderD128/, 'named as before');
  assert.match(b, /<b>—<\/b><span class="muted small">video engine<\/span>/);
  assert.match(b, /<th>GPU<\/th>/, 'the processes keep their GPU column');
  const shape = (html) => html.replace(/>[^<]*</g, '><').replace(/(style|title)="[^"]*"/g, '').replace(/ hot"/g, '"');
  const gpuPart = (html) => html.slice(html.indexOf('<div class="nd-tile"><div class="nd-title"><span>GPU'), html.indexOf('<div class="nd-tile"><div class="nd-title"><span>Power'));
  assert.equal(shape(gpuPart(b)), shape(gpuPart(a)), 'the GPU tiles have the same rows');
  assert.equal(titles(serverBody(gone)), titles(a).replace(/GPU,/g, ''), 'without memory: only what the sample has');
  // the process name: one line, its count kept outside the part that is cut short
  assert.match(a, /<td title="ffmpeg · hevc_vaapi ×4"><span class="nd-pname"><span>ffmpeg · hevc_vaapi<\/span><span>×4<\/span><\/span><\/td>/);
  const css = fs.readFileSync(path.join(REPO, 'web/shell.css'), 'utf8');
  assert.match(css, /\.nd-pname > span:first-child \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
});

test('Overview: "Not updating right now" keeps its room in the head while the numbers are fresh', () => {
  const app = fs.readFileSync(path.join(REPO, 'web/app.js'), 'utf8');
  assert.match(app, /<span class="nd-nb nd-stale\$\{monitor\.error \? '' : ' off'\}"/);
  assert.match(fs.readFileSync(path.join(REPO, 'web/shell.css'), 'utf8'), /\.nd-stale\.off \{ visibility: hidden; \}/);
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
  const { size, sizeOf, rate, energyText, money, cpuName, sensorName } = overview();
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
  // below 1 kWh in Wh (one decimal below 100), so a run's first minutes visibly count up
  assert.equal(energyText(0), '0.0 Wh');
  assert.equal(energyText(12.44), '12.4 Wh');
  assert.equal(energyText(99.96), '100 Wh');
  assert.equal(energyText(412), '412 Wh');
  assert.equal(energyText(940), '940 Wh');
  assert.equal(energyText(999.96), '1.0 kWh');
  assert.equal(energyText(5200), '5.2 kWh');
  assert.equal(energyText(99960), '100 kWh');
  assert.equal(energyText(250000), '250 kWh');
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
  assert.match(html, /<span class="nd-chip" title="hevc_vaapi · Intel Arc A380 · renderD128">hevc_vaapi · Intel Arc A380 · renderD128<\/span><span class="nd-chip">decode: GPU<\/span><span class="nd-chip nd-chip-fit"><span>4 at once<\/span>/);
  assert.match(html, /<span>Video engine<\/span><b>94%<\/b><div class="nd-bar hot">/);
  assert.match(html, /<span>CPU \(conversions\)<\/span><b>18%<\/b>/);
  assert.match(html, /<b>65 W<\/b><small>CPU 41 · GPU 24<\/small>/);
  assert.match(html, /<b>61 °C<\/b><small>GPU 61 · CPU 58<\/small>/);
  assert.doesNotMatch(html, /Bottleneck|Room to spare|nd-hint/, 'no sentence about what limits the run');
  assert.match(html, /This run<\/span><b>310 Wh/);
  assert.match(html, /Clips per kWh<\/span><b>1,329/);
  assert.match(html, /Space saved per kWh<\/span><b>125 GB/);
  assert.doesNotMatch(html, /GPU only/, 'the CPU is measured on this server');
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
  assert.match(amd, /This run<\/span><b>1\.8 kWh/);
  assert.match(amd, /<p class="nd-eff-note">GPU only \(CPU not measured\)<\/p>/, 'no RAPL: the per-kWh numbers are the GPU\'s alone');
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

test('Hardware panel: one row per conversion at once; a clip keeps its row, a free one waits for the next clip', async () => {
  const { clipRows, renderHardware, panelMemory } = await hardware();
  const w = (itemId) => ({ itemId, relativePath: `SentryClips/${itemId}.mp4`, fps: 300 });
  const ids = (r) => r.rows.map((x) => x?.itemId ?? null);
  let r = clipRows([w('a'), w('b'), w('c'), w('d')], 4);
  assert.deepEqual(ids(r), ['a', 'b', 'c', 'd']);
  // b finishes; e starts later: a, c, d stay where they were, e takes b's row
  r = clipRows([w('a'), w('c'), w('d')], 4, r.keys);
  assert.deepEqual(ids(r), ['a', null, 'c', 'd']);
  r = clipRows([w('a'), w('c'), w('d'), w('e')], 4, r.keys);
  assert.deepEqual(ids(r), ['a', 'e', 'c', 'd']);
  assert.deepEqual(ids(clipRows([], 3)), [null, null, null], 'nothing running: the rows stay');
  assert.deepEqual(ids(clipRows([w('x'), w('y')], 1)), ['x', 'y'], 'more running than set (lowered while running): a row each');
  assert.deepEqual(ids(clipRows([w('x')], null)), ['x'], 'no concurrency known: as many as run');

  const memo = panelMemory();
  const body = (workers) => {
    const s = sample();
    s.encoder.concurrency = 4;
    s.encoder.state = 'encoding';
    s.encoder.workers = s.encoder.workers.slice(0, workers);
    return s;
  };
  const four = renderHardware(body(4), memo);
  const one = renderHardware(body(1), memo);
  assert.equal((one.match(/class="nd-w"/g) || []).length, 1);
  assert.equal((one.match(/class="nd-w nd-w-idle"/g) || []).length, 3);
  assert.match(one, /<span class="nd-clip">Waiting for the next clip<\/span>/);
  assert.equal((four.match(/class="nd-w[ "]/g) || []).length, (one.match(/class="nd-w[ "]/g) || []).length, 'the same number of rows');
  const none = renderHardware(body(0), memo);
  assert.equal((none.match(/nd-w-idle/g) || []).length, 4, 'checking and saving: four rows still');
  // the state chip holds every wording it can show, so its width (and the
  // head's lines) stay put: "4 at once", "saving…" between clips, "scanning…"
  const chipOf = (html) => html.match(/<span class="nd-chip nd-chip-fit">(.*?)<\/span><\/div>/)[1];
  const wordings = (html) => [...chipOf(html).matchAll(/<span[^>]*>([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(wordings(four), ['4 at once', 'scanning…', 'saving…']);
  assert.deepEqual(wordings(one), ['1 at once', '4 at once', 'scanning…', 'saving…']);
  assert.deepEqual(wordings(none), ['saving…', '4 at once', 'scanning…']);
  assert.match(chipOf(none), /^<span>saving…<\/span><span aria-hidden="true">4 at once<\/span>/, 'the one shown comes first; the others only hold the width');
  const scanning = body(0);
  scanning.encoder.state = 'discovering';
  assert.deepEqual(wordings(renderHardware(scanning, memo)), ['scanning…', '4 at once', 'saving…']);
  assert.doesNotMatch(none, /checking and saving|finding clips/, 'no wording wider than "4 at once"');
});

test('Hardware panel: tiles and device lines keep their place while a number is missing; another job starts over', async () => {
  const { renderHardware, panelMemory } = await hardware();
  const tilesOf = (html) => [...(html.split('<div class="nd-hw-tiles">')[1] || '').split('<div class="nd-eff">')[0].matchAll(/<div(?: class="hot")?><span>([^<]+)<\/span><b>([^<]+)<\/b>/g)].map((m) => `${m[1]}=${m[2]}`);
  const memo = panelMemory();
  const full = sample();
  const gap = sample();
  gap.gpus[0].video = null; // a new clip's ffmpeg: not measured yet
  gap.cpu.app = { usage: null, ffmpegUsage: null, ffmpegCount: 4 };
  gap.power.totalW = null;
  gap.cpu.tempC = null;
  gap.gpus[0].tempC = null;
  assert.deepEqual(tilesOf(renderHardware(full, memo)), ['Video engine=94%', 'CPU (conversions)=18%', 'Power=65 W', 'Temperatures=61 °C']);
  assert.deepEqual(tilesOf(renderHardware(gap, memo)), ['Video engine=—', 'CPU (conversions)=—', 'Power=—', 'Temperatures=—']);
  assert.equal(memo.fresh, true, 'the first view of a job');
  memo.fresh = false;
  // never seen on this page: the video engine of a GPU that reports one, nothing else
  assert.deepEqual(tilesOf(renderHardware(gap)), ['Video engine=—']);
  // the same body for another job: the panel starts over
  const next = sample();
  next.encoder.jobId = 'conv-next';
  Object.assign(next.power, { totalW: null });
  assert.deepEqual(tilesOf(renderHardware(next, memo)).map((t) => t.split('=')[0]), ['Video engine', 'CPU (conversions)', 'Temperatures']);
  assert.equal(memo.fresh, true);
  // two GPUs converting: a lane without a running clip for a moment keeps its line
  const ARC = 'pci:0000:03:00.0';
  const UHD = 'pci:0000:00:02.0';
  const lanes = sample();
  lanes.encoder.devices = [
    { id: UHD, name: 'Intel UHD Graphics 770', node: '/dev/dri/renderD129', encoder: 'hevc_qsv', hardware: true, workers: 1, video: 40, busy: 10 },
    { id: ARC, name: 'Intel Arc A380', node: '/dev/dri/renderD128', encoder: 'hevc_qsv', hardware: true, workers: 3, video: 72, busy: 10 }
  ];
  const m2 = panelMemory();
  const both = renderHardware(lanes, m2);
  lanes.encoder.devices = [lanes.encoder.devices[1]];
  const one = renderHardware(lanes, m2);
  assert.equal((both.match(/class="nd-dev[ "]/g) || []).length, 2);
  assert.equal((one.match(/class="nd-dev[ "]/g) || []).length, 2, 'still two lines');
  assert.match(one, />Intel UHD Graphics 770 · hevc_qsv · 0 converting</);
  assert.doesNotMatch(one, /hevc_vaapi · Intel Arc A380 · renderD128/, 'still the several-GPU view');
  assert.equal(renderHardware(lanes).includes('nd-devices'), false, 'without memory: as before');
});

test('Hardware panel: a sample without the GPU or its power reading changes no line of it', async () => {
  const { renderHardware, panelMemory } = await hardware();
  const memo = panelMemory();
  // a GPU whose power is read some of the time, and no CPU power (as on the owner's server)
  const poll = (over) => {
    const s = sample();
    s.encoder.run = { ...s.encoder.run, cpuMeasured: false };
    over(s);
    return renderHardware(s, memo);
  };
  const shape = (html) => html.replace(/>[^<]*</g, '><').replace(/(style|title)="[^"]*"/g, '').replace(/ (hot|nd-w-idle)"/g, '"').replace(/<span aria-hidden="true"><\/span>/g, '');
  const first = poll(() => {});
  assert.match(first, /<span>Video engine<\/span>/);
  assert.match(first, /nd-eff-note/);
  // no power reading this time: the server cannot tell whether the CPU was measured
  const noPower = poll((s) => { s.encoder.run.cpuMeasured = null; s.power.totalW = null; s.gpus[0].powerW = null; });
  assert.match(noPower, /nd-eff-note/, 'the GPU only line stays');
  // the GPU read failed outright: the tile keeps its name
  const noGpu = poll((s) => { s.gpus = []; });
  assert.match(noGpu, /<span>Video engine<\/span><b>—<\/b>/);
  assert.equal(shape(noPower), shape(first));
  assert.equal(shape(noGpu), shape(first));
});

test('Hardware panel: never shorter while a job runs; back to its own height when the job changes or the Encoder is shown again', async (t) => {
  const { startHardwarePanel } = await hardware();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = {};
  const on = (target) => (type, fn) => { (listeners[`${target}:${type}`] ||= []).push(fn); };
  let height = 600;
  const panel = { hidden: true, innerHTML: '', style: { minHeight: '' }, closest: () => null, parentElement: null };
  Object.defineProperty(panel, 'offsetHeight', { get: () => Math.max(height, parseFloat(panel.style.minHeight) || 0) });
  const doc = { visibilityState: 'visible', getElementById: (id) => (id === 'converterHardware' ? panel : null), addEventListener: on('doc') };
  const win = { location: { origin: 'https://nas' }, addEventListener: on('win'), innerWidth: 1440 };
  let body = sample();
  const fetchImpl = async () => ({ ok: true, json: async () => body });
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const poll = async () => { t.mock.timers.tick(2000); await settle(); };
  startHardwarePanel({ doc, win, fetchImpl });
  await settle();
  assert.equal(panel.style.minHeight, '600px');
  height = 480; // a clip row and a tile went away
  await poll();
  assert.equal(panel.style.minHeight, '600px', 'kept');
  height = 640;
  await poll();
  assert.equal(panel.style.minHeight, '640px', 'the tallest so far');
  // another job: its own height
  body = sample();
  body.encoder.jobId = 'conv-other';
  height = 500;
  await poll();
  assert.equal(panel.style.minHeight, '500px');
  // put away and shown again
  height = 420;
  listeners['win:message'].forEach((fn) => fn({ origin: 'https://nas', data: { type: 'pause' } }));
  listeners['win:message'].forEach((fn) => fn({ origin: 'https://nas', data: { type: 'shown' } }));
  await settle();
  assert.equal(panel.style.minHeight, '420px');
  // a phone turned: laid out anew
  height = 700;
  win.innerWidth = 844;
  listeners['win:resize'].forEach((fn) => fn());
  assert.equal(panel.style.minHeight, '700px');
  height = 650;
  await poll();
  assert.equal(panel.style.minHeight, '700px');
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
