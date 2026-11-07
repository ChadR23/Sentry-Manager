// Overview: live telemetry console from /api/stats and /api/stats/history.
import { esc, api, state, current, bytes, rate, pct, num, watts, energy, money, dur, ago, when, isoish, tod, fin, store, toast, confirmDialog, busy, plural, icon, debounce, liveDraw } from '../core.js';
import { TimeChart, HeatStrip, C, PALETTE, coreBars } from '../charts.js';
import { split, seg, wireSeg, meter, chip } from '../ui.js';
import { fullIn } from '/web/fullIn.js';

const MAX_POINTS = 450;

export default {
  async mount(el) {
    let range = store.get('ov:range', 'live');
    let snap = null;
    let error = null;
    let timer = null;
    let alive = true;
    let hist24 = null;
    let hist24At = 0;
    const buf = { t: [], cpu: [], mem: [], gpuBusy: [], gpuVideo: [], power: [], rx: [], tx: [], temp: [], cores: [], diskR: [], diskW: [], diskBusy: [], ff: [] };
    const charts = {};
    const logs = { level: store.get('ov:logLevel', 'problems'), filter: '', scope: '', auto: store.get('ov:logAuto', true), lines: [], timer: null };

    el.innerHTML = `
      <div class="phead">
        <div><h1>Overview</h1><p class="muted small" id="ov-host">Connecting to the server…</p></div>
        <div class="phead-actions">
          ${seg('range', [['live', 'Live 15 min'], ['24h', '24 h']], range, 'Chart range')}
          <a class="btn" href="/api/stats/export.csv?range=24h" download>${icon('download')}CSV 24 h</a>
          <a class="btn" href="/api/stats/export.csv?range=15m" download>${icon('download')}CSV 15 min</a>
        </div>
      </div>
      <div class="kpis" id="ov-kpis"></div>
      <div id="ov-split">
        <section class="ov-charts" aria-label="Telemetry charts">
          <div class="ov-alerts" id="ov-alerts"></div>
          <div class="cgrid">
            <article class="card ctile wide" id="t-cpu"><header><h2>CPU</h2><span class="muted small" id="cpu-sub"></span><b class="big num" id="cpu-big">—</b></header><div id="ch-cpu"></div><div class="tile-label"><span>per core · live</span><span class="faint" id="cpu-heat-note"></span></div><div id="ch-heat"></div><div id="cpu-cores"></div><dl class="kv tight" id="cpu-kv"></dl></article>
            <article class="card ctile" id="t-gpu"><header><h2>GPU</h2><span class="muted small" id="gpu-sub"></span><b class="big num" id="gpu-big">—</b></header><div id="ch-gpu"></div><div id="gpu-rows"></div></article>
            <article class="card ctile" id="t-power"><header><h2>Power</h2><span class="muted small" id="power-sub">measured</span><b class="big num" id="power-big">—</b></header><div id="ch-power"></div><dl class="kv tight" id="power-kv"></dl></article>
            <article class="card ctile" id="t-mem"><header><h2>Memory</h2><span class="muted small" id="mem-sub"></span><b class="big num" id="mem-big">—</b></header><div id="ch-mem"></div><dl class="kv tight" id="mem-kv"></dl></article>
            <article class="card ctile" id="t-net"><header><h2>Network</h2><span class="muted small" id="net-sub"></span><b class="big num" id="net-big">—</b></header><div id="ch-net"></div><dl class="kv tight" id="net-kv"></dl></article>
            <article class="card ctile wide" id="t-disk"><header><h2>Disks</h2><span class="muted small">read / write · busy (I/O wait) · live</span><b class="big num" id="disk-big">—</b></header><div class="two"><div id="ch-disk"></div><div id="ch-diskbusy"></div></div><div class="tscroll"><table class="dtable" id="disk-table"></table></div></article>
            <article class="card ctile" id="t-temp"><header><h2>Temperatures</h2><span class="muted small" id="temp-sub">hottest sensor</span><b class="big num" id="temp-big">—</b></header><div id="ch-temp"></div><dl class="kv tight" id="temp-kv"></dl></article>
            <article class="card ctile" id="t-procs"><header><h2>Top processes</h2><span class="muted small" id="proc-sub"></span></header><div class="tscroll"><table class="dtable" id="proc-table"></table></div></article>
          </div>
        </section>
        <aside class="ov-rail" aria-label="Vehicles and attention">
          <section class="card"><header class="card-h"><h2>Vehicles</h2><a class="btn sm" href="#/settings/vehicles">Manage</a></header><div id="ov-vehicles"></div></section>
          <section class="card"><header class="card-h"><h2>Attention</h2><a class="btn sm" href="#/notifications">All</a></header><div id="ov-attn"></div></section>
          <section class="card" id="ov-enc-card" hidden><header class="card-h"><h2>Encoder</h2><a class="btn sm" href="#/encoder">Open</a></header><div id="ov-enc"></div></section>
          <section class="card"><header class="card-h"><h2>Storage</h2></header><div id="ov-fs"></div></section>
        </aside>
      </div>
      <section class="card logs" id="ov-logs" aria-label="Log tail">
        <header class="card-h"><h2>Log tail</h2><span class="muted small" id="log-count"></span></header>
        <div class="toolbar">
          ${seg('loglevel', [['problems', 'Warnings + errors'], ['all', 'Everything']], logs.level, 'Log level')}
          <input class="input" type="search" placeholder="Filter lines  ( / )" data-filter id="log-filter" aria-label="Filter log lines">
          <select class="input" id="log-scope" aria-label="Scope"><option value="">All scopes</option></select>
          <label class="check"><input type="checkbox" id="log-auto"${logs.auto ? ' checked' : ''}> Follow</label>
          <button class="btn" type="button" id="log-refresh">${icon('refresh')}Refresh</button>
          <a class="btn" href="/api/logs/download" download>${icon('download')}Download</a>
          <button class="btn" type="button" id="log-clear">Clear…</button>
        </div>
        <div class="logbox" id="log-box" tabindex="0" aria-label="Log lines"></div>
        <details class="archives" id="log-arch"><summary>Cleared logs (archives)</summary><div id="log-arch-list" class="small muted">Loading…</div></details>
      </section>`;

    split(el.querySelector('#ov-split'), { id: 'overview', initial: Math.max(560, Math.round((el.clientWidth || 1200) - 380)), min: 480, max: 2400 });

    const pctFmt = (v) => `${Math.round(v)}%`;
    const timeFmt = () => (range === '24h' ? (t) => tod(t) : null);
    charts.cpu = new TimeChart(el.querySelector('#ch-cpu'), { height: 130, max: 100, format: pctFmt, series: [{ key: 'cpu', label: 'CPU', color: C.violet }, { key: 'ff', label: 'ffmpeg', color: C.cyan, fill: false, dash: [4, 3] }] });
    charts.heat = new HeatStrip(el.querySelector('#ch-heat'), { height: 64 });
    charts.gpu = new TimeChart(el.querySelector('#ch-gpu'), { height: 110, max: 100, format: pctFmt, series: [{ key: 'gpuBusy', label: 'Busy / 3D', color: C.pink }, { key: 'gpuVideo', label: 'Video engine', color: C.cyan }] });
    charts.power = new TimeChart(el.querySelector('#ch-power'), { height: 110, floor: 10, format: (v) => `${Math.round(v)} W`, series: [{ key: 'power', label: 'Watts', color: C.amber }] });
    charts.mem = new TimeChart(el.querySelector('#ch-mem'), { height: 110, max: 100, format: pctFmt, series: [{ key: 'mem', label: 'Used', color: C.green }] });
    charts.net = new TimeChart(el.querySelector('#ch-net'), { height: 110, floor: 64 * 1024, format: (v) => rate(v), series: [{ key: 'rx', label: '↓ down', color: C.cyan }, { key: 'tx', label: '↑ up', color: C.violet }] });
    charts.disk = new TimeChart(el.querySelector('#ch-disk'), { height: 110, floor: 1024 * 1024, format: (v) => rate(v), series: [{ key: 'diskR', label: 'read', color: C.green }, { key: 'diskW', label: 'write', color: C.amber }] });
    charts.diskBusy = new TimeChart(el.querySelector('#ch-diskbusy'), { height: 110, max: 100, format: pctFmt, legend: true, series: [{ key: 'diskBusy', label: 'busy / wait %', color: C.red }] });
    charts.temp = new TimeChart(el.querySelector('#ch-temp'), { height: 110, floor: 50, format: (v) => `${Math.round(v)}°C`, series: [{ key: 'temp', label: 'Hottest', color: C.orange }] });

    // ---- data ----
    function push(key, v) {
      buf[key].push(fin(v) ? v : null);
      if (buf[key].length > MAX_POINTS) buf[key].shift();
    }
    async function prefill() {
      try {
        const h = await api('/api/stats/history?range=15m', { timeoutMs: 15000 });
        const s = h.series || {};
        const n = (s.cpu || []).length;
        for (let i = 0; i < n; i++) {
          buf.t.push(h.start + i * h.step);
          buf.cpu.push(s.cpu?.[i] ?? null); buf.mem.push(s.memory?.[i] ?? null); buf.gpuBusy.push(s.gpuBusy?.[i] ?? null);
          buf.gpuVideo.push(s.gpuVideo?.[i] ?? null); buf.power.push(s.powerW?.[i] ?? null); buf.rx.push(s.rxBps?.[i] ?? null);
          buf.tx.push(s.txBps?.[i] ?? null); buf.temp.push(s.tempMax?.[i] ?? null); buf.ff.push(null);
          buf.cores.push(null); buf.diskR.push(null); buf.diskW.push(null); buf.diskBusy.push(null);
        }
        // trim leading empty history so live charts start at real samples
        let first = buf.cpu.findIndex((v) => v !== null);
        if (first < 0) first = n;
        for (const k of Object.keys(buf)) buf[k].splice(0, first);
      } catch { /* live samples only */ }
    }
    let liveFrom = null; // time of the first live sample: disks and per-core have no history
    function ingest(s) {
      const t = s.at || Date.now();
      if (liveFrom === null) liveFrom = t;
      if (buf.t.length && t <= buf.t[buf.t.length - 1]) return;
      buf.t.push(t);
      if (buf.t.length > MAX_POINTS) buf.t.shift();
      const g = (s.gpus || []);
      const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
      push('cpu', s.cpu?.usage);
      push('ff', s.cpu?.app?.ffmpegUsage);
      push('mem', fin(s.memory?.usedB) && s.memory.totalB ? (s.memory.usedB / s.memory.totalB) * 100 : null);
      push('gpuBusy', avg(g.map((x) => x.busy).filter(fin)));
      push('gpuVideo', avg(g.map((x) => x.video).filter(fin)));
      const pw = fin(s.power?.totalW) ? s.power.totalW : [s.power?.cpuW, s.power?.gpuW].filter(fin).reduce((a, b) => a + b, 0) || null;
      push('power', pw);
      const ifs = s.network?.interfaces || [];
      push('rx', ifs.some((i) => fin(i.rxBps)) ? ifs.reduce((n, i) => n + (i.rxBps || 0), 0) : null);
      push('tx', ifs.some((i) => fin(i.txBps)) ? ifs.reduce((n, i) => n + (i.txBps || 0), 0) : null);
      const temps = [s.cpu?.tempC, ...(s.sensors || []).filter((x) => x.kind === 'temp').map((x) => x.value), ...g.map((x) => x.tempC), ...(s.disks || []).map((d) => d.tempC)].filter(fin);
      push('temp', temps.length ? Math.max(...temps) : null);
      buf.cores.push(Array.isArray(s.cpu?.perCore) ? s.cpu.perCore.slice() : null);
      if (buf.cores.length > MAX_POINTS) buf.cores.shift();
      const disks = s.disks || [];
      push('diskR', disks.some((d) => fin(d.readBps)) ? disks.reduce((n, d) => n + (d.readBps || 0), 0) : null);
      push('diskW', disks.some((d) => fin(d.writeBps)) ? disks.reduce((n, d) => n + (d.writeBps || 0), 0) : null);
      const busyV = disks.map((d) => d.busy).filter(fin);
      push('diskBusy', busyV.length ? Math.max(...busyV) : null);
    }

    // ---- drawing ----
    const $ = (s) => el.querySelector(s);
    function series(keyMap) {
      if (range === '24h' && hist24?.series) {
        const s = hist24.series;
        const times = (s.cpu || []).map((_, i) => hist24.start + i * hist24.step);
        const out = {};
        for (const [k, hk] of Object.entries(keyMap)) out[k] = hk ? s[hk] || [] : [];
        return [times, out];
      }
      const out = {};
      for (const k of Object.keys(keyMap)) out[k] = buf[k];
      return [buf.t, out];
    }
    function drawCharts() {
      const tf = timeFmt();
      for (const c of Object.values(charts)) if (c.opts) c.opts.timeFormat = tf;
      charts.cpu.set(...series({ cpu: 'cpu', ff: null }));
      charts.gpu.set(...series({ gpuBusy: 'gpuBusy', gpuVideo: 'gpuVideo' }));
      charts.power.set(...series({ power: 'powerW' }));
      charts.mem.set(...series({ mem: 'memory' }));
      charts.net.set(...series({ rx: 'rxBps', tx: 'txBps' }));
      charts.temp.set(...series({ temp: 'tempMax' }));
      // per-core and disks are live only: drawn over the live samples, not
      // squeezed into the right edge of the 15 min history axis
      let i0 = liveFrom === null ? buf.t.length : buf.t.findIndex((t) => t >= liveFrom);
      if (i0 < 0) i0 = buf.t.length;
      const lt = buf.t.slice(i0);
      const live = (k) => buf[k].slice(i0);
      charts.disk.set(lt, { diskR: live('diskR'), diskW: live('diskW') });
      charts.diskBusy.set(lt, { diskBusy: live('diskBusy') });
      const cores = live('cores');
      const ncore = Math.max(0, ...cores.map((c) => (c ? c.length : 0)));
      const rows = Array.from({ length: ncore }, (_, r) => cores.map((c) => (c ? c[r] : null)));
      charts.heat.set(lt, rows);
      $('#cpu-heat-note').textContent = ncore ? `${ncore} threads × ${buf.cores.filter(Boolean).length} samples` : 'no per-core numbers from this server';
    }

    // why a server's CPU watts are missing (/api/stats power.cpuUnavailable)
    const CPU_NA = { windows: 'CPU watts aren\'t available on Docker Desktop for Windows (Windows doesn\'t share them with Docker). NVIDIA GPU watts show when the card reports them.', vm: 'CPU watts aren\'t available inside a virtual machine.' };
    const CPU_NA_SHORT = { windows: 'CPU n/a (Windows)', vm: 'CPU n/a (VM)' };

    function kv(rows) {
      return rows.filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k, v, tone]) => `<dt>${esc(k)}</dt><dd class="num${tone ? ` ${tone}` : ''}">${esc(v)}</dd>`).join('');
    }

    // what a poll redraws (a highlight in the vehicles, attention or the log holds none of it)
    const TILES = [$('#ov-host'), $('#ov-kpis'), $('#ov-alerts'), el.querySelector('.cgrid'), $('#ov-enc'), $('#ov-fs')];
    function drawTiles() {
      const s = snap;
      if (!s) return;
      const h = s.host || {};
      $('#ov-host').innerHTML = `${[h.hostname, h.os, h.kernel && `kernel ${h.kernel}`, h.arch, fin(h.uptimeS) && `up ${dur(h.uptimeS * 1000)}`, fin(h.appUptimeS) && `app ${dur(h.appUptimeS * 1000)}`, h.version && `v${h.version}`, h.node && `node ${h.node}`, h.ffmpeg && `ffmpeg ${h.ffmpeg}`].filter(Boolean).map((x) => `<span class="mono">${esc(x)}</span>`).join(' · ')}${error ? ' · <span class="bad-text">not updating right now</span>' : ''}`;
      // CPU
      const cpu = s.cpu || {};
      $('#cpu-big').textContent = pct(cpu.usage);
      $('#cpu-sub').textContent = [cpu.model, fin(cpu.cores) && `${cpu.cores}c/${cpu.threads}t`].filter(Boolean).join(' · ');
      $('#cpu-cores').innerHTML = Array.isArray(cpu.perCore) && cpu.perCore.length ? coreBars(cpu.perCore) : '';
      $('#cpu-kv').innerHTML = kv([
        ['load 1/5/15', Array.isArray(cpu.load) ? cpu.load.map((x) => (fin(x) ? x.toFixed(2) : '—')).join(' / ') : null],
        ['clock', fin(cpu.freqMHz) ? `${(cpu.freqMHz / 1000).toFixed(2)} GHz` : null],
        ['temp', fin(cpu.tempC) ? `${Math.round(cpu.tempC)} °C` : null, cpu.tempC >= 90 ? 'bad-text' : ''],
        ['this app', fin(cpu.app?.usage) ? pct(cpu.app.usage, 1) : null],
        ['ffmpeg', cpu.app?.ffmpegCount ? `${cpu.app.ffmpegCount} × · ${pct(cpu.app.ffmpegUsage, 1)}` : '0'],
        ['throttling', cpu.throttling ? 'yes' : 'no', cpu.throttling ? 'bad-text' : ''],
        ['sockets', cpu.sockets > 1 ? String(cpu.sockets) : null]
      ]);
      // GPU
      const gpus = s.gpus || [];
      $('#gpu-big').textContent = gpus.length ? pct(Math.max(...gpus.map((g) => Math.max(g.busy || 0, g.video || 0)))) : 'none';
      $('#gpu-sub').textContent = gpus.length ? gpus.map((g) => g.name).join(', ') : 'no GPU visible: encodes use the CPU';
      $('#gpu-rows').innerHTML = gpus.map((g) => `<div class="gpu-row"><b>${esc(g.name || g.id)}</b><span class="muted small">${esc([g.vendor, g.driver, g.node].filter(Boolean).join(' · '))}</span>
        <div class="bars"><span>busy</span>${meter(g.busy, 'pink')}<b class="num">${pct(g.busy)}</b><span>video</span>${meter(g.video, 'cyan')}<b class="num">${pct(g.video)}</b>
        ${fin(g.vramTotalB) ? `<span>vram</span>${meter((g.vramUsedB / g.vramTotalB) * 100, 'violet')}<b class="num">${bytes(g.vramUsedB)} / ${bytes(g.vramTotalB)}</b>` : ''}</div>
        <dl class="kv tight">${kv([['clock', fin(g.clockMHz) ? `${g.clockMHz} MHz` : null], ['temp', fin(g.tempC) ? `${g.tempC} °C` : null], ['power', fin(g.powerW) ? watts(g.powerW) : null], ['clients', fin(g.clients) ? String(g.clients) : null]])}</dl></div>`).join('') || '<p class="muted small">The GPU chart fills in when a GPU is passed into the container.</p>';
      // power
      const p = s.power || {};
      const cur = s.price?.currency || state.power?.currency || '$';
      const tot = fin(p.totalW) ? p.totalW : [p.cpuW, p.gpuW].filter(fin).reduce((a, b) => a + b, 0) || null;
      // with nodes: all servers together up top, then a row per server
      const all = p.combined && (p.nodes || []).length ? p.combined : null;
      const split = (w, c, g, na) => [fin(w) ? watts(w) : null, fin(c) ? `cpu ${watts(c)}` : null, fin(g) ? `gpu ${watts(g)}` : null].filter(Boolean).join(' · ') || 'not measured';
      $('#power-big').textContent = all ? watts(all.totalW) : watts(tot);
      const why = CPU_NA[p.cpuUnavailable] || '';
      $('#power-sub').textContent = all ? `all servers · ${all.reporting}/${all.servers} reporting` : p.cpuSource || p.gpuSource ? `measured · ${[p.cpuSource, p.gpuSource].filter(Boolean).join(' + ')}` : why ? CPU_NA_SHORT[p.cpuUnavailable] : 'no power sensor readable';
      const perHour = fin(tot) && fin(s.price?.now) ? (tot / 1000) * s.price.now : null;
      $('#power-kv').innerHTML = (all ? kv([
        ['this server', split(tot, p.cpuW, p.gpuW, p.cpuUnavailable)],
        ...p.nodes.map((n) => [n.name, !n.online ? 'offline' : fin(n.totalW) || CPU_NA_SHORT[n.cpuUnavailable] ? split(n.totalW, n.cpuW, n.gpuW, n.cpuUnavailable) : 'unknown', n.online && fin(n.totalW) ? '' : 'faint']),
        ['all today', `${energy(all.todayWh)}${fin(all.todayCost) ? ` · ${money(all.todayCost, cur)}` : ''}`],
        ['all this week', `${energy(all.weekWh)}${fin(all.weekCost) ? ` · ${money(all.weekCost, cur)}` : ''}`]
      ]) + '<dt class="kv-sep">this server</dt><dd class="kv-sep"></dd>' : '') + kv([
        ['CPU package', fin(p.cpuW) ? watts(p.cpuW) : null], ['GPU', fin(p.gpuW) ? watts(p.gpuW) : null], ['whole chip', fin(p.chipW) ? watts(p.chipW) : null],
        ['today', `${energy(p.todayWh)}${fin(p.todayCost) ? ` · ${money(p.todayCost, cur)}` : ''}`],
        ['this week', `${energy(p.weekWh)}${fin(p.weekCost) ? ` · ${money(p.weekCost, cur)}` : ''}`],
        ['price now', fin(s.price?.now) ? `${money(s.price.now, cur)}/kWh${s.price.rate ? ` · ${s.price.rate}` : ''}` : 'not set'],
        ['cost per hour', perHour !== null ? `≈ ${money(perHour, cur)}/h` : null],
        ['converting', s.encoder?.run && fin(s.encoder.run.wh) ? `${energy(s.encoder.run.wh)} · avg ${watts(s.encoder.run.avgW)}${s.encoder.run.nodeWh > 0 ? ` · ${energy(s.encoder.run.nodeWh)} on nodes` : ''}` : null]
      ]) + (why ? `<dd class="kv-note">${esc(why)}</dd>` : '');
      // memory
      const m = s.memory || {};
      const mp = fin(m.usedB) && m.totalB ? (m.usedB / m.totalB) * 100 : null;
      $('#mem-big').textContent = pct(mp);
      $('#mem-sub').textContent = `${bytes(m.usedB)} of ${bytes(m.totalB)}`;
      $('#mem-kv').innerHTML = kv([['available', bytes(m.availableB)], ['cache', bytes(m.cacheB)], ['this app', bytes(m.appB)], ['swap', m.swapTotalB ? `${bytes(m.swapUsedB)} / ${bytes(m.swapTotalB)}` : 'none']]);
      // network
      const net = s.network || {};
      const ifs = net.interfaces || [];
      $('#net-big').textContent = `↓ ${rate(buf.rx[buf.rx.length - 1])}`;
      $('#net-sub').textContent = `${ifs.map((i) => i.name).join(', ')} · ${net.scope === 'host' ? 'whole server' : 'this container'}`;
      $('#net-kv').innerHTML = kv([
        ...ifs.map((i) => [i.name, `↓ ${rate(i.rxBps)} ↑ ${rate(i.txBps)}${fin(i.speedMbps) ? ` · ${i.speedMbps} Mb/s` : ''}`]),
        ['today', net.today ? `↓ ${bytes(net.today.rxB)} ↑ ${bytes(net.today.txB)}` : null],
        ['this week', net.week ? `↓ ${bytes(net.week.rxB)} ↑ ${bytes(net.week.txB)}` : null],
        ['this month', net.month ? `↓ ${bytes(net.month.rxB)} ↑ ${bytes(net.month.txB)}` : null]
      ]);
      // disks
      const disks = s.disks || [];
      $('#disk-big').textContent = `${rate(buf.diskR[buf.diskR.length - 1])} r · ${rate(buf.diskW[buf.diskW.length - 1])} w`;
      $('#disk-table').innerHTML = `<thead><tr><th>disk</th><th>kind</th><th class="r">read</th><th class="r">write</th><th class="r">busy</th><th class="r">temp</th></tr></thead><tbody>${disks.map((d) => `<tr><td class="mono">${esc(d.name)}<div class="faint small">${esc(d.model || '')}</div></td><td>${esc(d.kind || '')}</td><td class="r num">${rate(d.readBps)}</td><td class="r num">${rate(d.writeBps)}</td><td class="r num">${pct(d.busy)}</td><td class="r num">${fin(d.tempC) ? `${d.tempC} °C` : '—'}</td></tr>`).join('')}</tbody>`;
      // temps
      const sensors = (s.sensors || []).filter((x) => fin(x.value));
      const t = buf.temp[buf.temp.length - 1];
      $('#temp-big').textContent = fin(t) ? `${Math.round(t)} °C` : '—';
      $('#temp-sub').textContent = sensors.length ? `${sensors.length} sensors` : 'no temperature sensors readable';
      $('#temp-kv').innerHTML = kv(sensors.slice(0, 14).map((x) => [`${x.chip} ${x.label}`, x.kind === 'fan' ? `${Math.round(x.value)} rpm` : `${Math.round(x.value)} °C`, x.kind === 'temp' && x.value >= 85 ? 'bad-text' : '']));
      // processes
      const procs = s.processes?.top || [];
      $('#proc-sub').textContent = s.processes?.scope === 'host' ? 'whole server' : 'this container';
      $('#proc-table').innerHTML = `<thead><tr><th>pid</th><th>name</th><th class="r">cpu</th><th class="r">mem</th><th class="r">gpu</th></tr></thead><tbody>${procs.slice(0, 12).map((x) => `<tr><td class="num faint">${esc(x.pid)}</td><td class="mono">${esc(x.name)}</td><td class="r num">${pct(x.cpu, 1)}</td><td class="r num">${bytes(x.memB)}</td><td class="r num">${fin(x.gpuVideo) ? pct(x.gpuVideo) : '—'}</td></tr>`).join('')}</tbody>`;
      // alerts / unlock hints
      const alerts = (s.alerts || []).map((a) => `<div class="alert ${a.level === 'error' ? 'bad' : 'warn'}">${icon('alert')}<span>${esc(a.message)}</span></div>`).join('');
      const unlock = (s.unlock || []).length ? `<details class="unlock"><summary>${plural(s.unlock.length, 'more number')} available with one line in docker-compose.yml</summary>${s.unlock.map((u) => `<div class="small"><b>${esc(u.adds)}</b> <code>${esc(u.compose || '')}</code></div>`).join('')}</details>` : '';
      // (kept open across redraws: it closed every few seconds as it was read)
      const box = $('#ov-alerts');
      const open = box.querySelector('details.unlock')?.open === true;
      box.innerHTML = alerts + unlock;
      if (open) box.querySelector('details.unlock')?.setAttribute('open', '');
      // encoder
      const e = s.encoder;
      $('#ov-enc-card').hidden = !e;
      if (e) {
        $('#ov-enc').innerHTML = `<div class="kv tight"><dt>state</dt><dd>${chip(e.state || 'idle', e.running ? 'cyan' : 'amber')}</dd><dt>lanes</dt><dd class="num">${e.workers.length} / ${e.concurrency ?? '—'}</dd>
          <dt>device</dt><dd>${esc(e.device ? `${e.device.encoder}${e.device.gpuName ? ` · ${e.device.gpuName}` : ''}` : '—')}</dd><dt>clips</dt><dd class="num">${num(e.run?.clips)}</dd><dt>saved</dt><dd class="num">${bytes(e.run?.savedB)}</dd></div>
          ${e.workers.map((w) => `<div class="lane-mini"><span class="mono ell" title="${esc(w.relativePath)}">${esc(String(w.relativePath || '').split('/').pop())}</span>${meter(w.durationUs ? (w.outTimeUs / w.durationUs) * 100 : 0, 'cyan')}<span class="num">${fin(w.fps) ? `${w.fps} fps` : ''}</span></div>`).join('')}`;
      }
      // storage
      $('#ov-fs').innerHTML = (s.filesystems || []).map((f) => {
        const used = fin(f.usedB) && f.totalB ? (f.usedB / f.totalB) * 100 : null;
        return `<div class="fs"><div class="fs-top"><b>${esc(f.label)}</b><span class="num small">${used === null ? '—' : `${bytes(f.freeB)} free`}</span></div>${meter(used, used > 92 ? 'red' : used > 80 ? 'amber' : 'violet')}<div class="faint small mono ell" title="${esc(f.path)}">${esc(f.path)}</div>
          <div class="small muted">${esc([f.fsType, f.smbVersion && `SMB ${f.smbVersion}`, f.reachable === false ? 'not reachable' : fin(f.latencyMs) ? `answers in ${f.latencyMs} ms` : null, f.checkedAt && `checked ${ago(f.checkedAt)}`].filter(Boolean).join(' · '))}</div></div>`;
      }).join('') || '<p class="muted small">No storage numbers yet.</p>';
      drawKpis();
    }

    function drawKpis() {
      const s = snap;
      const vs = state.vehicles;
      const inv = vs.reduce((n, v) => n + (v.inventory?.bytes || 0), 0);
      const recs = vs.reduce((n, v) => n + (v.inventory?.recordings || 0), 0);
      const healthy = vs.filter((v) => v.share?.healthy).length;
      const binB = vs.reduce((n, v) => n + (v.binBytes || 0), 0);
      const savedB = vs.reduce((n, v) => n + (v.saved?.bytes || 0), 0);
      const savedN = vs.reduce((n, v) => n + (v.saved?.clips || 0), 0);
      const open = state.notes.filter((n) => !n.resolvedAt);
      const v = current();
      const free = v?.share?.freeBytes;
      const tot = s ? (fin(s.power?.totalW) ? s.power.totalW : null) : null;
      const k = (label, value, sub, tone = '', href = '') => `<${href ? `a href="${href}"` : 'div'} class="kpi ${tone}"><span class="kpi-l">${esc(label)}</span><b class="kpi-v num">${esc(value)}</b><span class="kpi-s">${esc(sub)}</span></${href ? 'a' : 'div'}>`;
      $('#ov-kpis').innerHTML = [
        k('Vehicles', `${healthy}/${vs.length}`, 'shares reachable', healthy < vs.length ? 'warn' : '', '#/settings/vehicles'),
        k('Footage', bytes(inv), plural(recs, 'recording'), '', '#/footage'),
        k('Free', bytes(free), v ? `on ${v.name}` : '—', fin(free) && v?.share?.totalBytes && free / v.share.totalBytes < 0.05 ? 'bad' : ''),
        (() => { const f = fullIn(v?.storage); return k('Full in', f ? f.short : '—', f ? (v.storage.capped ? 'policies delete old footage' : `at ${bytes(v.storage.perDay)} a day · ${v.name}`) : 'not known yet', f?.tone === 'bad' ? 'bad' : f?.tone === 'warn' ? 'warn' : ''); })(),
        k('Space saved', savedB ? bytes(savedB) : 'none yet', savedB ? `${plural(savedN, 'clip')} converted · all cars` : 'by conversions', '', '#/encoder'),
        // days with any footage (any car's; one day once)
        k('Days of footage', fin(state.footageDays) ? state.footageDays.toLocaleString() : '—', vs.length > 1 ? 'all cars' : v?.inventory?.firstDay ? `since ${v.inventory.firstDay}` : 'recorded', '', '#/footage'),
        k('Recycle Bin', bytes(binB), plural(vs.reduce((n, x) => n + (x.binItems || 0), 0), 'item'), '', '#/bin'),
        k('Attention', String(open.length), open.some((n) => n.level === 'critical') ? 'critical open' : 'open notifications', open.some((n) => n.level === 'critical') ? 'bad' : open.length ? 'warn' : '', '#/notifications'),
        k('CPU', pct(s?.cpu?.usage), s?.cpu?.load ? `load ${s.cpu.load[0]}` : '—'),
        s?.power?.combined && s.power.nodes?.length
          ? k('Power', watts(s.power.combined.totalW), `all servers · this one ${watts(tot)}`)
          : k('Power', watts(tot), s?.power?.todayWh ? `${energy(s.power.todayWh)} today` : 'no sensor'),
        k('Encoder', s?.encoder ? (s.encoder.running ? 'running' : s.encoder.state || 'idle') : 'idle', s?.encoder ? `${s.encoder.workers.length} lanes busy` : 'no job', s?.encoder?.running ? 'hot' : '', '#/encoder')
      ].join('');
    }

    function drawVehicles() {
      const box = $('#ov-vehicles');
      if (!state.vehicles.length) {
        box.innerHTML = '<p class="muted small">No vehicles yet.</p><a class="btn primary sm" href="#/settings/vehicles?add=1">Add a vehicle</a>';
        return;
      }
      box.innerHTML = state.vehicles.map((v) => {
        const s = v.share || {};
        const used = fin(s.totalBytes) && s.totalBytes ? (1 - s.freeBytes / s.totalBytes) * 100 : null;
        const status = !s.healthy ? chip('unavailable', 'red') : s.writable === false ? chip('read-only', 'amber') : chip('online', 'green');
        const cats = Object.entries(v.inventory?.byCategory || {}).map(([c, x]) => `<span class="cat ${c}">${esc(c)} ${x.recordings}</span>`).join('');
        return `<div class="veh"><div class="veh-top"><b>${esc(v.name)}</b>${status}</div>
          ${meter(used, used > 95 ? 'red' : used > 85 ? 'amber' : 'violet')}
          <div class="small muted num">${bytes(s.freeBytes)} free of ${bytes(s.totalBytes)} · ${bytes(v.inventory?.bytes)} footage · ${fin(v.inventory?.days) ? plural(v.inventory.days, 'day') : '— days'} · saved ${v.saved?.bytes ? `${bytes(v.saved.bytes)} · ${plural(v.saved.clips, 'clip')}` : 'none yet'}</div>
          <div class="cats">${cats}</div>
          ${s.warning ? `<p class="small amber-text">${esc(s.warning)}</p>` : ''}${s.lastError ? `<p class="small bad-text">${esc(s.lastError)}</p>` : ''}
          <div class="small faint">${v.scanning ? 'scanning…' : `scanned ${ago(v.inventory?.scannedAt)}`} · ${esc(v.timezone || '')}</div>
          <div class="row-actions"><button class="btn sm" type="button" data-scan="${esc(v.id)}">${icon('refresh')}Refresh inventory</button>${s.healthy ? '' : `<button class="btn sm" type="button" data-reconnect="${esc(v.id)}">Reconnect</button>`}<a class="btn sm" href="#/footage">Footage</a></div></div>`;
      }).join('');
      box.querySelectorAll('[data-scan]').forEach((b) => {
        b.onclick = () => busy(b, async () => { await api(`/api/vehicles/${encodeURIComponent(b.dataset.scan)}/scan`, { body: {} }); toast('Refreshing the inventory… Jobs shows the progress.'); });
      });
      box.querySelectorAll('[data-reconnect]').forEach((b) => {
        b.onclick = () => busy(b, async () => { await api(`/api/vehicles/${encodeURIComponent(b.dataset.reconnect)}/reconnect`, { body: {} }); toast('Reconnecting…'); });
      });
    }

    function drawAttention() {
      const open = state.notes.filter((n) => !n.resolvedAt).slice(0, 6);
      $('#ov-attn').innerHTML = open.length ? open.map((n) => `<div class="attn ${n.level}"><i></i><div><b>${esc(n.title)}</b><div class="small muted">${esc(n.message || '')}</div><div class="faint small">${ago(n.createdAt)}</div></div></div>`).join('') : '<p class="muted small">All clear. Nothing needs you.</p>';
    }

    // ---- logs ----
    function drawLogs() {
      const box = $('#log-box');
      const q = logs.filter.toLowerCase();
      const lines = logs.lines.filter((l) => (!logs.scope || l.scope === logs.scope) && (!q || `${l.message} ${l.scope} ${l.level}`.toLowerCase().includes(q)));
      $('#log-count').textContent = `${lines.length} of ${logs.lines.length} lines · newest first`;
      const atTop = box.scrollTop < 8;
      box.innerHTML = lines.length ? lines.map((l) => `<div class="ll ${esc(l.level)}"><span class="ll-t">${esc(isoish(l.at))}</span><span class="ll-l">${esc(l.level)}</span><span class="ll-s">${esc(l.scope)}</span><span class="ll-m">${esc(l.message)}</span></div>`).join('') : `<p class="muted small" style="padding:10px">${logs.level === 'all' ? 'Nothing logged yet.' : 'No warnings or errors. Choose Everything to see all activity.'}</p>`;
      if (atTop) box.scrollTop = 0;
      const scopes = [...new Set(logs.lines.map((l) => l.scope))].sort();
      const sel = $('#log-scope');
      const want = `<option value="">All scopes</option>${scopes.map((s) => `<option${s === logs.scope ? ' selected' : ''}>${esc(s)}</option>`).join('')}`;
      if (sel.innerHTML !== want && document.activeElement !== sel) sel.innerHTML = want;
    }
    async function loadLogs() {
      try {
        const out = await api(`/api/logs?level=${logs.level === 'all' ? 'all' : 'problems'}&limit=500`, { timeoutMs: 15000 });
        logs.lines = out.lines || [];
      } catch (err) {
        logs.lines = [{ at: Date.now(), level: 'error', scope: 'flux', message: `Could not load the log: ${err.message}` }];
      }
      if (alive) liveDraw($('#log-box'), drawLogs);
    }
    async function loadArchives() {
      try {
        const { archives = [] } = await api('/api/logs/archive');
        $('#log-arch-list').innerHTML = archives.length ? `<ul>${archives.map((a) => `<li><a href="/api/logs/archive/${encodeURIComponent(a.name)}" download>${esc(when(a.at))}</a> <span class="faint">${bytes(a.bytes)}</span></li>`).join('')}</ul>` : 'None yet. Clear moves the logs here instead of deleting them.';
      } catch (err) {
        $('#log-arch-list').textContent = err.message;
      }
    }
    wireSeg(el, 'loglevel', (v) => { logs.level = v; store.set('ov:logLevel', v); loadLogs(); });
    $('#log-filter').addEventListener('input', debounce((e) => { logs.filter = e.target.value; drawLogs(); }, 120));
    $('#log-scope').onchange = (e) => { logs.scope = e.target.value; drawLogs(); };
    $('#log-auto').onchange = (e) => { logs.auto = e.target.checked; store.set('ov:logAuto', logs.auto); };
    $('#log-refresh').onclick = () => loadLogs();
    $('#log-clear').onclick = async () => {
      if (!(await confirmDialog({ title: 'Clear the logs?', body: '<p>The log starts empty. Nothing is deleted: the current lines move to <code>logs/archive/</code> and stay downloadable under Cleared logs.</p>', ok: 'Clear logs' }))) return;
      await busy(null, async () => { await api('/api/logs/clear', { body: {} }); toast('Logs cleared. The earlier lines are under Cleared logs.'); });
      loadLogs();
      loadArchives();
    };
    $('#log-arch').addEventListener('toggle', (e) => { if (e.target.open) loadArchives(); });

    // ---- polling ----
    async function poll() {
      if (!alive) return;
      if (document.visibilityState === 'visible') {
        try {
          const wantDay = range === '24h' && Date.now() - hist24At > 60000;
          const [s, h] = await Promise.all([api('/api/stats', { timeoutMs: 10000 }), wantDay ? api('/api/stats/history?range=24h', { timeoutMs: 20000 }).catch(() => null) : null]);
          if (!alive) return;
          snap = s;
          error = null;
          if (h) { hist24 = h; hist24At = Date.now(); }
          ingest(s);
          liveDraw(TILES, drawTiles);
          drawCharts();
        } catch (err) {
          error = err.message;
          if (snap) liveDraw(TILES, drawTiles);
          else $('#ov-host').innerHTML = `<span class="bad-text">Can't read the server's numbers: ${esc(err.message)}</span>`;
        }
      }
      timer = setTimeout(poll, 2000);
    }
    let logTick = 0;
    logs.timer = setInterval(() => {
      if (logs.auto && document.visibilityState === 'visible' && ++logTick % 2 === 0) loadLogs();
    }, 2500);
    wireSeg(el, 'range', (v) => { range = v; store.set('ov:range', v); hist24At = 0; if (v === '24h') { clearTimeout(timer); poll(); } else drawCharts(); });

    drawKpis();
    drawVehicles();
    drawAttention();
    await prefill();
    drawCharts();
    poll();
    loadLogs();

    return {
      unmount() {
        alive = false;
        clearTimeout(timer);
        clearInterval(logs.timer);
        Object.values(charts).forEach((c) => c.destroy());
      },
      onTopics(topics) {
        if (topics.some((t) => ['vehicles', 'inventory', 'bin'].includes(t))) { liveDraw($('#ov-vehicles'), drawVehicles); liveDraw($('#ov-kpis'), drawKpis); }
        if (topics.includes('notifications')) { liveDraw($('#ov-attn'), drawAttention); liveDraw($('#ov-kpis'), drawKpis); }
      },
      onVehicle() { drawKpis(); },
      onKey(e) {
        if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
          el.querySelector(`[data-seg="range"] button[data-v="${range === 'live' ? '24h' : 'live'}"]`)?.click();
          return true;
        }
        return false;
      },
      commands: () => [
        { group: 'Overview', label: 'Range: live 15 minutes', icon: 'overview', run: () => el.querySelector('[data-seg="range"] button[data-v="live"]')?.click() },
        { group: 'Overview', label: 'Range: last 24 hours', icon: 'overview', run: () => el.querySelector('[data-seg="range"] button[data-v="24h"]')?.click() },
        { group: 'Overview', label: 'Log tail: everything', icon: 'jobs', run: () => el.querySelector('[data-seg="loglevel"] button[data-v="all"]')?.click() }
      ]
    };
  }
};
