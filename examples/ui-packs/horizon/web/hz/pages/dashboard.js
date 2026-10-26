// Dashboard: the instrument cluster. A storage speedometer, a fuel gauge for free
// space, trip counters, warning lights, server telemetry and the black-box log.
import { h, ico, api, app, car, size, perSec, pc, fixed, count, span, since, stampFull, watt, wh, cash, ok, toast, ask, act, local, segs, onSegs, pill, bar, panelHead, debounce } from '../core.js';
import { dial, setDial, fuel, setFuel, spark } from '../gauges.js';

const KEEP = 180; // samples kept for the sparklines (6 min at 2 s)

export default {
  async mount(el, { status }) {
    let alive = true;
    let stats = null;
    let statErr = null;
    let timer = 0;
    let logTimer = 0;
    let dayInfo = null;
    const hist = { cpu: [], mem: [], gpu: [], power: [], rx: [], tx: [], dr: [], dw: [], temp: [] };
    const log = { level: local.get('log.level', 'problems'), text: '', scope: '', follow: local.get('log.follow', true), lines: [] };

    el.innerHTML = `
      <section class="cluster hud" aria-label="Instrument cluster">
        <div class="cl-left">${dial({ max: 100, majors: 10, label: 'Storage used', unit: 'used', red: 0.9, fmt: (v) => String(Math.round(v / 10)), cls: 'speedo' })}</div>
        <div class="cl-mid">
          <div class="trip" id="d-trip"></div>
          <div class="lamps" id="d-lamps" role="list" aria-label="Warning lights"></div>
        </div>
        <div class="cl-right">
          ${fuel('Free space')}
          <div class="mini-dials">
            ${dial({ max: 100, majors: 5, label: 'CPU', unit: '%', red: 0.85, fmt: (v) => String(Math.round(v)), cls: 'mini' })}
            ${dial({ max: 100, majors: 5, label: 'Memory', unit: '%', red: 0.9, fmt: (v) => String(Math.round(v)), cls: 'mini' })}
          </div>
        </div>
      </section>
      <div class="cols dash-cols">
        <section class="panel hud cyan" aria-label="Server telemetry">${panelHead(`${ico('tacho')}Telemetry`, `<a class="btn sm" href="/api/stats/export.csv?range=15m" download>${ico('download')}CSV 15 min</a><a class="btn sm" href="/api/stats/export.csv?range=24h" download>${ico('download')}CSV 24 h</a>`)}
          <p class="small dim" id="d-host">Reading the server…</p>
          <div class="meters" id="d-meters"></div>
          <div id="d-alerts"></div>
        </section>
        <div class="stack">
          <section class="panel hud" aria-label="Vehicles">${panelHead(`${ico('car')}Vehicles`, '<a class="btn sm" href="#/settings/vehicles">Garage</a>')}<div id="d-cars"></div></section>
          <section class="panel hud orange" aria-label="Attention">${panelHead(`${ico('warn')}Attention`, '<a class="btn sm" href="#/alerts">All alerts</a>')}<div id="d-attn"></div></section>
        </div>
        <div class="stack">
          <section class="panel hud cyan" aria-label="Encoder">${panelHead(`${ico('engine')}Engine room`, '<a class="btn sm" href="#/encoder">Encoder</a>')}<div id="d-enc"></div></section>
          <section class="panel hud" aria-label="Storage">${panelHead(`${ico('disk')}Storage`)}<div id="d-fs"></div></section>
        </div>
      </div>
      <div class="cols">
        <section class="panel hud" aria-label="GPUs and sensors">${panelHead(`${ico('temp')}GPUs and sensors`)}<div id="d-gpu"></div></section>
        <section class="panel hud" aria-label="Disks and processes">${panelHead(`${ico('jobs')}Disks and processes`)}<div id="d-procs"></div></section>
      </div>
      <section class="panel hud blackbox" aria-label="Server log">
        ${panelHead(`${ico('flag')}Black box <span class="faint tiny" id="d-logn"></span>`, `<a class="btn sm" href="/api/logs/download" download>${ico('download')}Download</a><button class="btn sm" type="button" id="d-logclear">Clear…</button>`)}
        <div class="row logbar">
          ${segs('lvl', [['problems', 'Warnings + errors'], ['all', 'Everything']], log.level, 'Log level')}
          <input class="in grow" type="search" id="d-logq" placeholder="Filter lines" aria-label="Filter log lines">
          <select class="in" id="d-logscope" aria-label="Scope"><option value="">Every scope</option></select>
          <label class="chk"><input type="checkbox" id="d-follow"${log.follow ? ' checked' : ''}> Follow</label>
          <button class="btn sm" type="button" id="d-logref">${ico('refresh')}Refresh</button>
        </div>
        <div class="logbox" id="d-log" tabindex="0" aria-label="Log lines"></div>
        <details class="arch" id="d-arch"><summary>Cleared logs (archives)</summary><div id="d-archl" class="small dim">Loading…</div></details>
      </section>`;
    const $ = (s) => el.querySelector(s);

    // ---------- trip counters + gauges from the vehicle ----------
    async function loadDays() {
      const v = car();
      if (!v) { dayInfo = null; return; }
      try {
        const d = await api(`/api/vehicles/${encodeURIComponent(v.id)}/days?limit=100`);
        dayInfo = { minutes: d.days.reduce((n, x) => n + (x.minutes || 0), 0), clips: d.days.reduce((n, x) => n + (x.clips || 0), 0), encoded: d.days.reduce((n, x) => n + (x.encoded || 0), 0), days: d.total };
      } catch { dayInfo = null; }
    }
    const digits = (value, n = 6) => {
      const s = String(value).padStart(n, ' ').slice(-Math.max(n, String(value).length));
      return `<span class="odo" aria-hidden="true">${[...s].map((c) => `<i>${c === ' ' ? '0' : h(c)}</i>`).join('')}</span>`;
    };
    function drawCluster() {
      const v = car();
      const sh = v?.share || {};
      const used = ok(sh.totalBytes) && sh.totalBytes ? (1 - sh.freeBytes / sh.totalBytes) * 100 : null;
      setDial(el.querySelector('.speedo'), used, ok(used) ? `${Math.round(used)}` : '—', ok(used) ? '% used' : 'no share');
      const freeF = ok(sh.totalBytes) && sh.totalBytes ? sh.freeBytes / sh.totalBytes : null;
      setFuel(el, freeF, size(sh.freeBytes), ok(sh.totalBytes) ? `free of ${size(sh.totalBytes)}` : 'not known');
      const inv = v?.inventory || {};
      const hours = dayInfo ? dayInfo.minutes / 60 : null;
      $('#d-trip').innerHTML = `
        <div class="trip-h"><span>${ico('car')}${h(v ? v.name : 'No vehicle')}</span><span class="faint tiny">${v ? (v.scanning ? 'scanning…' : `inventory ${since(inv.scannedAt)}`) : ''}</span></div>
        <div class="trips">
          <div class="tr"><span class="tr-l">TRIP A · footage hours</span>${digits(ok(hours) ? hours.toFixed(1) : '0.0', 6)}<span class="sr-only">${ok(hours) ? hours.toFixed(1) : 0} hours of footage</span></div>
          <div class="tr"><span class="tr-l">TRIP B · clips</span>${digits(dayInfo?.clips ?? 0, 6)}<span class="sr-only">${dayInfo?.clips ?? 0} clips</span></div>
          <div class="tr"><span class="tr-l">ODO · recordings</span>${digits(inv.recordings ?? 0, 6)}<span class="sr-only">${inv.recordings ?? 0} recordings</span></div>
          <div class="tr"><span class="tr-l">LOAD · footage size</span><b class="tr-big num">${size(inv.bytes)}</b></div>
        </div>
        <div class="trip-f small dim">${dayInfo ? `${count(dayInfo.days, 'day')} · ${dayInfo.encoded}/${dayInfo.clips} clips converted` : ''}${v?.binItems ? ` · Recycle Bin ${size(v.binBytes)}` : ''}</div>`;
      drawLamps();
      status(v ? `${v.name} · ${ok(used) ? `${Math.round(used)}% used` : 'storage unknown'}` : 'no vehicle');
    }
    function drawLamps() {
      const v = car();
      const sh = v?.share || {};
      const open = app.notes.filter((n) => !n.resolvedAt);
      const crit = open.filter((n) => n.level === 'critical').length;
      const warn = open.filter((n) => n.level === 'warning').length;
      const freeF = ok(sh.totalBytes) && sh.totalBytes ? sh.freeBytes / sh.totalBytes : null;
      const st = stats?.encoder?.state || app.converter;
      const running = Boolean(stats?.encoder?.running) || ['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing'].includes(st);
      const lamps = [
        ['wifi', 'Share', v && !sh.healthy ? 'red' : '', v ? (sh.healthy ? 'connected' : 'offline') : 'none'],
        ['fuel', 'Low space', ok(freeF) && freeF < 0.1 ? 'org' : '', ok(freeF) ? `${Math.round(freeF * 100)}% free` : '—'],
        ['warn', 'Critical', crit ? 'red' : '', crit ? count(crit, 'alert') : 'none'],
        ['bell', 'Warnings', warn ? 'org' : '', warn ? count(warn, 'warning') : 'none'],
        ['engine', 'Engine', running ? 'cyan' : st === 'paused' || st === 'paused_network' ? 'org' : '', running ? 'converting' : st || 'idle'],
        ['refresh', 'Scanning', v?.scanning ? 'cyan' : '', v?.scanning ? 'busy' : 'idle'],
        ['bin', 'Bin', v?.binItems ? 'mag' : '', v?.binItems ? count(v.binItems, 'item') : 'empty'],
        ['policy', 'Policy', v?.policy?.enabled ? 'grn' : '', v?.policy?.enabled ? 'daily' : 'off'],
        ['temp', 'Heat', stats?.cpu?.throttling || (ok(stats?.cpu?.tempC) && stats.cpu.tempC >= 90) ? 'red' : '', ok(stats?.cpu?.tempC) ? `${Math.round(stats.cpu.tempC)} °C` : 'n/a']
      ];
      $('#d-lamps').innerHTML = lamps.map(([i, l, tone, s]) => `<div class="lamp ${tone ? `lit ${tone}` : ''}" role="listitem">${ico(i)}<b>${h(l)}</b><span>${h(s)}</span></div>`).join('');
    }

    // ---------- telemetry ----------
    function push(k, v) {
      hist[k].push(ok(v) ? v : null);
      if (hist[k].length > KEEP) hist[k].shift();
    }
    async function prefill() {
      try {
        const r = await api('/api/stats/history?range=15m', { timeout: 15000 });
        const s = r.series || {};
        const tail = (a) => (a || []).slice(-KEEP);
        hist.cpu = tail(s.cpu); hist.mem = tail(s.memory); hist.gpu = tail(s.gpuBusy); hist.power = tail(s.powerW);
        hist.rx = tail(s.rxBps); hist.tx = tail(s.txBps); hist.temp = tail(s.tempMax);
      } catch { /* live samples only */ }
    }
    function ingest(s) {
      const g = s.gpus || [];
      const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
      push('cpu', s.cpu?.usage);
      push('mem', ok(s.memory?.usedB) && s.memory.totalB ? (s.memory.usedB / s.memory.totalB) * 100 : null);
      push('gpu', avg(g.map((x) => Math.max(x.busy || 0, x.video || 0)).filter(ok)));
      const pw = ok(s.power?.totalW) ? s.power.totalW : [s.power?.cpuW, s.power?.gpuW].filter(ok).reduce((a, b) => a + b, 0) || null;
      push('power', pw);
      const ifs = s.network?.interfaces || [];
      push('rx', ifs.some((i) => ok(i.rxBps)) ? ifs.reduce((n, i) => n + (i.rxBps || 0), 0) : null);
      push('tx', ifs.some((i) => ok(i.txBps)) ? ifs.reduce((n, i) => n + (i.txBps || 0), 0) : null);
      const disks = s.disks || [];
      push('dr', disks.some((d) => ok(d.readBps)) ? disks.reduce((n, d) => n + (d.readBps || 0), 0) : null);
      push('dw', disks.some((d) => ok(d.writeBps)) ? disks.reduce((n, d) => n + (d.writeBps || 0), 0) : null);
      const temps = [s.cpu?.tempC, ...(s.sensors || []).filter((x) => x.kind === 'temp').map((x) => x.value), ...g.map((x) => x.tempC), ...(s.disks || []).map((d) => d.tempC)].filter(ok);
      push('temp', temps.length ? Math.max(...temps) : null);
    }
    const last = (k) => hist[k][hist[k].length - 1];
    function meter(label, value, p, sparkKey, opts = {}) {
      return `<div class="meter"><div class="m-top"><span class="m-l">${h(label)}</span><b class="m-v num">${h(value)}</b></div>${bar(p, opts.tone || '')}${spark(hist[sparkKey], { max: opts.max ?? null, tone: opts.tone === 'org' ? 'org' : 'cyan', w: 240, h: 30 })}${opts.sub ? `<span class="m-s small faint">${h(opts.sub)}</span>` : ''}</div>`;
    }
    function drawStats() {
      const s = stats;
      if (!s) return;
      const hst = s.host || {};
      $('#d-host').innerHTML = [hst.hostname, hst.os, hst.kernel && `kernel ${hst.kernel}`, hst.arch, ok(hst.uptimeS) && `up ${span(hst.uptimeS * 1000)}`, ok(hst.appUptimeS) && `app ${span(hst.appUptimeS * 1000)}`, hst.version && `v${hst.version}`, hst.ffmpeg && `ffmpeg ${hst.ffmpeg}`].filter(Boolean).map((x) => `<span class="mono">${h(x)}</span>`).join(' · ') + (statErr ? ` · <span class="badtx">not updating: ${h(statErr)}</span>` : '');
      const cpu = s.cpu || {};
      const m = s.memory || {};
      const memP = ok(m.usedB) && m.totalB ? (m.usedB / m.totalB) * 100 : null;
      setDial(el.querySelector('.mini-dials .dial:nth-child(1)'), cpu.usage, ok(cpu.usage) ? `${Math.round(cpu.usage)}` : '—');
      setDial(el.querySelector('.mini-dials .dial:nth-child(2)'), memP, ok(memP) ? `${Math.round(memP)}` : '—');
      const g = s.gpus || [];
      const p = s.power || {};
      const tot = ok(p.totalW) ? p.totalW : [p.cpuW, p.gpuW].filter(ok).reduce((a, b) => a + b, 0) || null;
      const cur = s.price?.currency || app.power?.currency || '$';
      const perHour = ok(tot) && ok(s.price?.now) ? (tot / 1000) * s.price.now : null;
      const t = last('temp');
      $('#d-meters').innerHTML = [
        meter('CPU', pc(cpu.usage), cpu.usage, 'cpu', { max: 100, sub: [cpu.model, ok(cpu.cores) && `${cpu.cores} cores / ${cpu.threads} threads`, Array.isArray(cpu.load) && `load ${cpu.load.map((x) => (ok(x) ? x.toFixed(2) : '—')).join(' ')}`, cpu.app?.ffmpegCount ? `ffmpeg ×${cpu.app.ffmpegCount}${ok(cpu.app.ffmpegUsage) ? ` ${pc(cpu.app.ffmpegUsage)}` : ''}` : null, ok(cpu.freqMHz) && `${(cpu.freqMHz / 1000).toFixed(2)} GHz`].filter(Boolean).join(' · ') }),
        meter('Memory', pc(memP), memP, 'mem', { max: 100, sub: `${size(m.usedB)} of ${size(m.totalB)} · app ${size(m.appB)} · cache ${size(m.cacheB)}${m.swapTotalB ? ` · swap ${size(m.swapUsedB)}/${size(m.swapTotalB)}` : ''}` }),
        meter('GPU', g.length ? pc(last('gpu')) : 'none', last('gpu'), 'gpu', { max: 100, sub: g.length ? g.map((x) => x.name).join(', ') : 'No GPU visible: encodes use the CPU' }),
        meter('Power', watt(tot), ok(tot) ? Math.min(100, tot / 3) : null, 'power', { tone: 'org', sub: ok(tot) || p.todayWh ? `today ${wh(p.todayWh)}${ok(p.todayCost) ? ` ${cash(p.todayCost, cur)}` : ''} · week ${wh(p.weekWh)}${ok(p.weekCost) ? ` ${cash(p.weekCost, cur)}` : ''}${perHour !== null ? ` · ≈${cash(perHour, cur)}/h` : ''}${ok(s.price?.now) ? ` · ${cash(s.price.now, cur)}/kWh` : ''}` : 'No power sensor readable' }),
        meter('Network ↓', perSec(last('rx')), null, 'rx', { sub: `↑ ${perSec(last('tx'))} · ${(s.network?.interfaces || []).map((i) => `${i.name}${ok(i.speedMbps) ? ` ${i.speedMbps} Mb/s` : ''}`).join(', ')} · ${s.network?.scope === 'host' ? 'whole server' : 'this container'}${s.network?.today ? ` · today ↓${size(s.network.today.rxB)} ↑${size(s.network.today.txB)}` : ''}` }),
        meter('Disk read', perSec(last('dr')), null, 'dr', { sub: `write ${perSec(last('dw'))}` }),
        meter('Hottest', ok(t) ? `${Math.round(t)} °C` : '—', ok(t) ? t : null, 'temp', { tone: 'org', max: 100, sub: ok(t) ? 'CPU, GPU, disks and sensors' : 'No temperature sensor readable' })
      ].join('');
      const alerts = (s.alerts || []).map((a) => `<div class="note ${a.level === 'error' ? 'red' : 'org'}">${h(a.message)}</div>`).join('');
      const unlock = (s.unlock || []).length ? `<details class="arch"><summary>${count(s.unlock.length, 'more reading')} available with one line in docker-compose.yml</summary>${s.unlock.map((u) => `<p class="small"><b>${h(u.adds)}</b> <code>${h(u.compose || '')}</code></p>`).join('')}</details>` : '';
      $('#d-alerts').innerHTML = alerts + unlock;
      // GPUs + sensors
      const sensors = (s.sensors || []).filter((x) => ok(x.value));
      $('#d-gpu').innerHTML = (g.length ? g.map((x) => `<div class="gpu"><div class="row"><b>${h(x.name || x.id)}</b><span class="faint small">${h([x.vendor, x.driver, x.node].filter(Boolean).join(' · '))}</span></div>
          <div class="gpu-b"><span class="small">busy</span>${bar(x.busy)}<b class="num small">${pc(x.busy)}</b><span class="small">video</span>${bar(x.video, 'org')}<b class="num small">${pc(x.video)}</b>${ok(x.vramTotalB) ? `<span class="small">VRAM</span>${bar((x.vramUsedB / x.vramTotalB) * 100)}<b class="num small">${size(x.vramUsedB)}</b>` : ''}</div>
          <p class="small faint">${[ok(x.clockMHz) && `${x.clockMHz} MHz`, ok(x.tempC) && `${x.tempC} °C`, ok(x.powerW) && watt(x.powerW), ok(x.clients) && `${x.clients} clients`].filter(Boolean).join(' · ')}</p></div>`).join('') : '<p class="small dim">No GPU is passed into the container, so conversions use the CPU.</p>')
        + (sensors.length ? `<dl class="kv sensors">${sensors.slice(0, 16).map((x) => `<dt>${h(`${x.chip} ${x.label}`)}</dt><dd class="num${x.kind === 'temp' && x.value >= 85 ? ' badtx' : ''}">${x.kind === 'fan' ? `${Math.round(x.value)} rpm` : `${Math.round(x.value)} °C`}</dd>`).join('')}</dl>` : '<p class="small faint">No temperature or fan sensors are readable here.</p>');
      const disks = s.disks || [];
      const procs = s.processes?.top || [];
      $('#d-procs').innerHTML = `<div class="tblwrap"><table class="tbl"><thead><tr><th>Disk</th><th class="r">Read</th><th class="r">Write</th><th class="r">Busy</th><th class="r">Temp</th></tr></thead><tbody>${disks.map((d) => `<tr><td><span class="mono">${h(d.name)}</span><div class="faint small">${h([d.model, d.kind].filter(Boolean).join(' · '))}</div></td><td class="r num">${perSec(d.readBps)}</td><td class="r num">${perSec(d.writeBps)}</td><td class="r num">${pc(d.busy)}</td><td class="r num">${ok(d.tempC) ? `${d.tempC} °C` : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="dim">No disks reported.</td></tr>'}</tbody></table></div>
        <h3 class="sub-h">Top processes <span class="faint tiny">${s.processes?.scope === 'host' ? 'whole server' : 'this container'}</span></h3>
        <div class="tblwrap"><table class="tbl"><thead><tr><th>Process</th><th class="r">CPU</th><th class="r">Memory</th><th class="r">GPU</th></tr></thead><tbody>${procs.slice(0, 8).map((x) => `<tr><td><span class="mono">${h(x.name)}</span> <span class="faint small">${h(x.pid)}</span></td><td class="r num">${pc(x.cpu, 1)}</td><td class="r num">${size(x.memB)}</td><td class="r num">${ok(x.gpuVideo) ? pc(x.gpuVideo) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
      // encoder + storage
      const e = s.encoder;
      $('#d-enc').innerHTML = e ? `<div class="row"><span class="pill ${e.running ? 'cyan' : 'org'}">${h(e.state || 'idle')}</span><span class="small dim">${e.workers.length} of ${e.concurrency ?? '—'} lanes busy${e.device ? ` · ${h(e.device.encoder)}${e.device.gpuName ? ` on ${h(e.device.gpuName)}` : ''}` : ''}</span></div>
          ${e.workers.map((w) => `<div class="lane-mini"><span class="mono ell small">${h(String(w.relativePath || '').split('/').pop())}</span>${bar(w.durationUs ? (w.outTimeUs / w.durationUs) * 100 : 0)}<span class="num small">${ok(w.fps) ? `${Math.round(w.fps)} fps` : ''}</span></div>`).join('')}
          <p class="small faint">${fixed(e.run?.clips)} clips this run · saved ${size(e.run?.savedB)}${e.run && ok(e.run.wh) ? ` · ${wh(e.run.wh)}` : ''}</p>` : '<p class="small dim">The engine is idle. No conversion is running.</p><a class="btn sm" href="#/encoder?new=1">' + ico('play') + 'Start a conversion</a>';
      $('#d-fs').innerHTML = (s.filesystems || []).map((f) => {
        const u = ok(f.usedB) && f.totalB ? (f.usedB / f.totalB) * 100 : null;
        return `<div class="fs"><div class="row"><b>${h(f.label)}</b><span class="num small dim">${u === null ? '—' : `${size(f.freeB)} free`}</span></div>${bar(u, u > 92 ? 'red' : u > 80 ? 'org' : '')}<p class="mono tiny faint ell">${h(f.path)}</p>
          <p class="small faint">${h([f.fsType, f.smbVersion && `SMB ${f.smbVersion}`, f.reachable === false ? 'not reachable' : ok(f.latencyMs) ? `answers in ${f.latencyMs} ms` : null, f.checkedAt && `checked ${since(f.checkedAt)}`].filter(Boolean).join(' · '))}</p></div>`;
      }).join('') || '<p class="small dim">No storage readings yet.</p>';
      drawLamps();
    }

    function drawCars() {
      const box = $('#d-cars');
      if (!app.vehicles.length) {
        box.innerHTML = '<p class="dim small">No vehicles yet.</p><a class="btn go sm" href="#/settings/vehicles?add=1">' + ico('plus') + 'Add a vehicle</a>';
        return;
      }
      box.innerHTML = app.vehicles.map((v) => {
        const sh = v.share || {};
        const u = ok(sh.totalBytes) && sh.totalBytes ? (1 - sh.freeBytes / sh.totalBytes) * 100 : null;
        const cats = Object.entries(v.inventory?.byCategory || {}).map(([c, x]) => pill(`${c} ${x.recordings}`, c === 'Sentry' ? 'org' : c === 'Saved' ? 'grn' : 'cyan')).join('');
        return `<div class="carcard"><div class="row"><b>${h(v.name)}</b>${!sh.healthy ? pill('offline', 'red') : sh.writable === false ? pill('read-only', 'org') : pill('online', 'grn')}</div>
          ${bar(u, u > 95 ? 'red' : u > 85 ? 'org' : '')}
          <p class="small dim num">${size(sh.freeBytes)} free of ${size(sh.totalBytes)} · ${size(v.inventory?.bytes)} of footage</p>
          <div class="row">${cats}</div>
          ${sh.warning ? `<p class="small warm">${h(sh.warning)}</p>` : ''}${sh.lastError ? `<p class="small badtx">${h(sh.lastError)}</p>` : ''}
          <div class="row"><button class="btn sm" type="button" data-scan="${h(v.id)}">${ico('refresh')}Refresh inventory</button>${sh.healthy ? '' : `<button class="btn sm" type="button" data-recon="${h(v.id)}">Reconnect</button>`}</div></div>`;
      }).join('');
      box.querySelectorAll('[data-scan]').forEach((b) => { b.onclick = () => act(b, async () => { await api(`/api/vehicles/${encodeURIComponent(b.dataset.scan)}/scan`, { body: {} }); toast('Refreshing the inventory. Jobs shows the progress.'); }); });
      box.querySelectorAll('[data-recon]').forEach((b) => { b.onclick = () => act(b, async () => { await api(`/api/vehicles/${encodeURIComponent(b.dataset.recon)}/reconnect`, { body: {} }); toast('Reconnecting…'); }); });
    }
    function drawAttn() {
      const open = app.notes.filter((n) => !n.resolvedAt).slice(0, 5);
      $('#d-attn').innerHTML = open.length ? open.map((n) => `<div class="attn ${h(n.level)}"><span class="attn-dot" aria-hidden="true"></span><div><b>${h(n.title)}</b><p class="small dim">${h(n.message || '')}</p><p class="tiny faint">${h(since(n.createdAt))}</p></div></div>`).join('') : '<p class="dim small">All clear. Nothing needs you right now.</p>';
    }

    // ---------- black box ----------
    function drawLog() {
      const box = $('#d-log');
      const q = log.text.toLowerCase();
      const lines = log.lines.filter((l) => (!log.scope || l.scope === log.scope) && (!q || `${l.message} ${l.scope} ${l.level}`.toLowerCase().includes(q)));
      $('#d-logn').textContent = `${lines.length} of ${log.lines.length} lines · newest first`;
      box.innerHTML = lines.length ? lines.slice(0, 300).map((l) => `<div class="ll ${h(l.level)}"><span class="ll-t num">${h(stampFull(l.at))}</span><span class="ll-l">${h(l.level)}</span><span class="ll-s">${h(l.scope)}</span><span class="ll-m">${h(l.message)}</span></div>`).join('') : `<p class="dim small ll-empty">${log.level === 'all' ? 'Nothing logged yet.' : 'No warnings or errors. Pick Everything to see all activity.'}</p>`;
      const scopes = [...new Set(log.lines.map((l) => l.scope))].sort();
      const sel = $('#d-logscope');
      const want = `<option value="">Every scope</option>${scopes.map((x) => `<option${x === log.scope ? ' selected' : ''}>${h(x)}</option>`).join('')}`;
      if (sel.innerHTML !== want && document.activeElement !== sel) sel.innerHTML = want;
    }
    async function loadLog() {
      try {
        const r = await api(`/api/logs?level=${log.level === 'all' ? 'all' : 'problems'}&limit=500`, { timeout: 15000 });
        log.lines = r.lines || [];
      } catch (err) {
        log.lines = [{ at: Date.now(), level: 'error', scope: 'horizon', message: `The log could not load: ${err.message}` }];
      }
      if (alive) drawLog();
    }
    async function loadArch() {
      try {
        const { archives = [] } = await api('/api/logs/archive');
        $('#d-archl').innerHTML = archives.length ? `<ul class="arch-l">${archives.map((a) => `<li><a class="btn sm" href="/api/logs/archive/${encodeURIComponent(a.name)}" download>${ico('download')}${h(stampFull(a.at))}</a> <span class="faint small">${size(a.bytes)}</span></li>`).join('')}</ul>` : 'None yet. Clear moves the log here instead of deleting it.';
      } catch (err) { $('#d-archl').textContent = err.message; }
    }
    onSegs(el, 'lvl', (v) => { log.level = v; local.set('log.level', v); loadLog(); });
    $('#d-logq').addEventListener('input', debounce((e) => { log.text = e.target.value; drawLog(); }, 120));
    $('#d-logscope').onchange = (e) => { log.scope = e.target.value; drawLog(); };
    $('#d-follow').onchange = (e) => { log.follow = e.target.checked; local.set('log.follow', log.follow); };
    $('#d-logref').onclick = loadLog;
    $('#d-logclear').onclick = async () => {
      if (!(await ask({ title: 'Clear the log?', body: '<p>The log starts empty. Nothing is lost: the current lines move to the archives below and stay downloadable.</p>', yes: 'Clear log' }))) return;
      await act($('#d-logclear'), async () => { await api('/api/logs/clear', { body: {} }); toast('Log cleared. The earlier lines are under Cleared logs.'); });
      loadLog();
      loadArch();
    };
    $('#d-arch').addEventListener('toggle', (e) => { if (e.target.open) loadArch(); });

    // ---------- polling ----------
    async function poll() {
      if (!alive) return;
      if (document.visibilityState === 'visible') {
        try {
          const s = await api('/api/stats', { timeout: 10000 });
          if (!alive) return;
          stats = s;
          statErr = null;
          ingest(s);
        } catch (err) {
          statErr = err.message;
        }
        drawStats();
      }
      timer = setTimeout(poll, 2000);
    }
    logTimer = setInterval(() => { if (log.follow && document.visibilityState === 'visible') loadLog(); }, 5000);

    await loadDays();
    drawCluster();
    drawCars();
    drawAttn();
    await prefill();
    poll();
    loadLog();

    return {
      unmount() { alive = false; clearTimeout(timer); clearInterval(logTimer); },
      async onTopics(t) {
        if (t.some((x) => ['vehicles', 'inventory', 'bin'].includes(x))) { await loadDays(); drawCluster(); drawCars(); }
        if (t.includes('notifications')) { drawAttn(); drawLamps(); }
      },
      async onCar() { await loadDays(); drawCluster(); },
      keys: [['l', 'Focus the log filter']],
      onKey(e) {
        if (e.key === 'l') { $('#d-logq').focus(); return true; }
        return false;
      }
    };
  }
};
