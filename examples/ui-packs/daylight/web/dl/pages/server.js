// Server & logs: what the server is doing (CPU, GPU, power, memory, disks,
// network, temperatures, programs) and its log, newest first.

import { api, esc, icon, bytes, pct, fin, meter, when, chip, details, confirmDialog, toast, fail, busy, store, plural } from '../core.js';
import { state } from '../state.js';

const rate = (bps) => (fin(bps) ? `${bytes(bps)}/s` : '—');
const temp = (c) => `${Math.round(c)} °C`;
const watts = (w) => `${w >= 10 ? Math.round(w) : w.toFixed(1)} W`;
const span = (s) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
};
const energy = (wh) => (wh < 1000 ? `${wh.toFixed(wh < 100 ? 1 : 0)} Wh` : `${(wh / 1000).toFixed(1)} kWh`);

function spark(points, color = 'var(--accent)', floor = 10, extra = null) {
  const clean = (l) => (Array.isArray(l) ? l : []).map((p) => (fin(p) ? Math.max(0, p) : null));
  const series = [[clean(points), color], ...(extra ? [[clean(extra[0]), extra[1]]] : [])].filter(([v]) => v.filter((x) => x !== null).length > 1);
  if (!series.length) return '<svg class="spark" viewBox="0 0 240 44" aria-hidden="true"></svg>';
  const top = Math.max(floor, ...series.flatMap(([v]) => v.filter((x) => x !== null)).map((x) => x * 1.15));
  const paths = series.map(([vals, c]) => {
    const x = (i) => ((i / (vals.length - 1)) * 240).toFixed(1);
    const y = (v) => (42 - (v / top) * 38).toFixed(1);
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`;
      pen = true;
    });
    return `<path d="${d}" fill="none" stroke="${c}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
  }).join('');
  return `<svg class="spark" viewBox="0 0 240 44" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>`;
}
const tile = (title, sub, body, wide = false) => `<div class="card tile${wide ? ' wide' : ''}"><div class="tile-head"><h3>${esc(title)}</h3>${sub ? `<span title="${esc(sub)}">${esc(sub)}</span>` : ''}</div>${body}</div>`;
const rows = (list) => {
  const r = list.filter((x) => x && x[1] !== '' && x[1] !== null && x[1] !== undefined);
  return r.length ? `<dl class="kv">${r.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>` : '';
};
const bar = (label, frac, text) => `<div><span>${esc(label)}</span>${meter(frac, frac > 0.9 ? 'warn' : '')}<b>${text}</b></div>`;

function tiles(s, hist, showAll) {
  const day = hist?.series || null;
  const out = [];
  const cpu = s.cpu;
  if (cpu && fin(cpu.usage)) {
    const per = (cpu.perCore || []).filter(fin);
    const cols = per.length <= 16 ? per.length : per.length <= 64 ? 16 : 32;
    out.push(tile('Processor', [String(cpu.model || '').replace(/\((R|TM)\)/gi, ''), fin(cpu.cores) ? plural(cpu.cores, 'core') : ''].filter(Boolean).join(' · '),
      `<div class="big">${pct(cpu.usage)}<small>busy</small></div>${spark(day ? day.cpu : s.sparks?.cpu)}
      ${per.length > 1 ? `<div class="cores" style="--cols:${cols}" aria-label="Each core">${per.map((c, i) => `<i style="height:${Math.max(4, Math.min(100, c))}%" title="Core ${i}: ${pct(c)}"></i>`).join('')}</div>` : ''}
      ${rows([['Speed', fin(cpu.freqMHz) ? `${(cpu.freqMHz / 1000).toFixed(2)} GHz` : ''], ['Temperature', fin(cpu.tempC) ? temp(cpu.tempC) : ''], ['Load', Array.isArray(cpu.load) ? cpu.load.map((l) => (fin(l) ? l.toFixed(1) : '—')).join(' · ') : ''],
        ['Sentry Six uses', fin(cpu.app?.usage) ? `${pct(cpu.app.usage)}${cpu.app.ffmpegCount ? ` (${cpu.app.ffmpegCount} × ffmpeg: ${pct(cpu.app.ffmpegUsage || 0)})` : ''}` : ''], ['Too hot, slowing down', cpu.throttling ? 'Yes' : '']])}`));
  }
  for (const g of (s.gpus || []).filter(Boolean)) {
    const big = fin(g.busy) ? pct(g.busy) : fin(g.video) ? pct(g.video) : '—';
    out.push(tile('Graphics card', [g.name, g.driver].filter(Boolean).join(' · '),
      `<div class="big">${big}<small>${fin(g.busy) ? 'in use' : 'video engine'}</small></div>${spark(day ? (day.gpuVideo?.some(fin) ? day.gpuVideo : day.gpuBusy) : s.sparks?.gpuVideo?.length ? s.sparks.gpuVideo : s.sparks?.gpuBusy, 'var(--violet)')}
      <div class="bars">${fin(g.busy) ? bar('3D', g.busy / 100, pct(g.busy)) : ''}${fin(g.video) ? bar('Video', g.video / 100, pct(g.video)) : ''}${fin(g.vramTotalB) && g.vramTotalB > 0 ? bar('Memory', (g.vramUsedB || 0) / g.vramTotalB, `${bytes(g.vramUsedB)} / ${bytes(g.vramTotalB)}`) : ''}</div>
      ${rows([['Temperature', fin(g.tempC) ? temp(g.tempC) : ''], ['Power', fin(g.powerW) ? watts(g.powerW) : ''], ['Clock', fin(g.clockMHz) ? `${Math.round(g.clockMHz)} MHz` : ''], ['Converting on it', g.clients ? `${g.clients} × ffmpeg` : '']])}`));
  }
  const p = s.power;
  if (p && (fin(p.totalW) || p.todayWh > 0 || p.weekWh > 0)) {
    const cur = s.price?.currency || state.power?.currency || '$';
    const money = (c) => (fin(c) ? ` · about ${/^[a-z]+$/i.test(cur) ? `${c.toFixed(2)} ${cur}` : `${cur}${c.toFixed(2)}`}` : '');
    out.push(tile('Power', 'measured', `<div class="big">${fin(p.totalW) ? watts(p.totalW) : '—'}<small>now</small></div>
      ${rows([['Processor', fin(p.cpuW) ? watts(p.cpuW) : fin(p.chipW) ? `${watts(p.chipW)} (whole chip)` : ''], ['Graphics', fin(p.gpuW) ? watts(p.gpuW) : fin(p.discreteW) ? watts(p.discreteW) : ''],
        ['Today', fin(p.todayWh) ? `${energy(p.todayWh)}${money(p.todayCost)}` : ''], ['This week', fin(p.weekWh) ? `${energy(p.weekWh)}${money(p.weekCost)}` : ''],
        ['This conversion', s.encoder?.running && fin(s.encoder.run?.wh) ? energy(s.encoder.run.wh) : ''], ['Price now', fin(s.price?.now) ? `${cur}${s.price.now} per kWh${s.price.rate ? ` (${esc(s.price.rate)})` : ''}` : '']])}`));
  }
  const m = s.memory;
  if (m && fin(m.totalB) && m.totalB > 0) {
    out.push(tile('Memory', bytes(m.totalB), `<div class="big">${bytes(m.usedB)}<small>used</small></div>${meter(m.usedB / m.totalB, m.usedB / m.totalB > 0.95 ? 'bad' : '')}
      ${rows([['Sentry Six uses', fin(m.appB) ? bytes(m.appB) : ''], ['Cache', fin(m.cacheB) ? bytes(m.cacheB) : ''], ['Swap', fin(m.swapTotalB) ? (m.swapTotalB ? `${bytes(m.swapUsedB || 0)} of ${bytes(m.swapTotalB)}` : 'none') : '']])}`));
  }
  const fss = (s.filesystems || []).filter(Boolean);
  const disks = (s.disks || []).filter((d) => d && d.name);
  if (fss.length || disks.length) {
    const shown = showAll.disks ? disks : disks.slice(0, 6);
    out.push(tile('Storage', 'shares and disks', `${fss.map((f) => {
      const known = fin(f.totalB) && f.totalB > 0 && fin(f.usedB);
      const down = f.mounted === false ? 'not connected' : f.reachable === false ? 'not answering' : '';
      return `<div class="disk-row"><div class="row-between"><b>${esc(f.label || f.path)}</b>${down ? chip(down, 'bad') : fin(f.latencyMs) ? `<span class="muted small">answers in ${f.latencyMs < 1 ? '<1' : Math.round(f.latencyMs)} ms</span>` : ''}</div>
        ${known ? `${meter(f.usedB / f.totalB, f.usedB / f.totalB > 0.9 ? 'warn' : '')}<span class="muted small">${bytes(f.totalB - f.usedB)} free of ${bytes(f.totalB)}</span>` : ''}
        <span class="muted tiny mono">${esc(f.path || '')}</span></div>`;
    }).join('')}
      ${shown.map((d) => `<div class="disk-row"><div class="row-between"><b>${esc(d.name)}</b><span class="muted small">${esc([d.model, { nvme: 'NVMe', ssd: 'SSD', hdd: 'hard disk' }[d.kind]].filter(Boolean).join(' · '))}</span></div>
        <span class="small">reading ${rate(d.readBps)} · writing ${rate(d.writeBps)}${fin(d.tempC) ? ` · ${temp(d.tempC)}` : ''}</span></div>`).join('')}
      ${disks.length > 6 ? `<button class="btn btn-ghost btn-sm" type="button" data-more="disks">${showAll.disks ? 'Show fewer' : `Show all ${disks.length} disks`}</button>` : ''}`, true));
  }
  const net = s.network;
  const ifs = (net?.interfaces || []).filter((i) => i && (fin(i.rxBps) || fin(i.txBps)));
  if (ifs.length) {
    const sum = (k) => ifs.reduce((n, i) => n + (fin(i[k]) ? i[k] : 0), 0);
    const used = (u) => (u ? `↓ ${bytes(u.rxB || 0)} · ↑ ${bytes(u.txB || 0)}` : '');
    out.push(tile('Network', ifs.length === 1 ? ifs[0].name : `${ifs.length} connections`, `<div class="big" style="font-size:26px">↓ ${rate(sum('rxBps'))}<small>↑ ${rate(sum('txBps'))}</small></div>
      ${spark(day ? day.rxBps : s.sparks?.rxBps, 'var(--accent)', 64 * 1024, [day ? day.txBps : s.sparks?.txBps, 'var(--violet)'])}
      ${rows([['Counted for', net.scope === 'host' ? 'the whole server' : 'this container'], ['Today', used(net.today)], ['This week', used(net.week)], ['This month', used(net.month)]])}`));
  }
  const sensors = (s.sensors || []).filter((x) => x && fin(x.value));
  if (sensors.length) {
    const shown = showAll.sensors ? sensors : sensors.slice(0, 10);
    out.push(tile('Temperatures and fans', `${sensors.length} sensors`, `${rows(shown.map((x) => [x.label || x.chip || 'Sensor', x.kind === 'fan' ? `${Math.round(x.value)} rpm` : temp(x.value)]))}
      ${sensors.length > 10 ? `<button class="btn btn-ghost btn-sm" type="button" data-more="sensors">${showAll.sensors ? 'Show fewer' : `Show all ${sensors.length}`}</button>` : ''}`));
  }
  const procs = (s.processes?.top || []).filter((x) => x && x.name);
  if (procs.length) {
    const hasGpu = procs.some((x) => fin(x.gpuVideo));
    out.push(tile('Busiest programs', s.processes.scope === 'host' ? 'whole server' : 'this container', `<div style="overflow-x:auto"><table class="procs"><thead><tr><th>Program</th><th>CPU</th><th>Memory</th>${hasGpu ? '<th>Video</th>' : ''}</tr></thead>
      <tbody>${(showAll.procs ? procs : procs.slice(0, 10)).map((x) => `<tr><td title="${esc(x.name)}">${esc(x.name)}</td><td>${pct(x.cpu || 0)}</td><td>${bytes(x.memB)}</td>${hasGpu ? `<td>${fin(x.gpuVideo) ? pct(x.gpuVideo) : '—'}</td>` : ''}</tr>`).join('')}</tbody></table></div>${procs.length > 10 ? `<button class="btn btn-ghost btn-sm" type="button" data-more="procs">${showAll.procs ? 'Show fewer' : `Show all ${procs.length}`}</button>` : ''}`, true));
  }
  return out.join('');
}

export async function render(ctx) {
  const { view } = ctx;
  let snap = null;
  let hist = null;
  let histAt = 0;
  let error = null;
  let range = store.get('statsRange', '15m') === '24h' ? '24h' : '15m';
  const showAll = {};
  const logs = { all: false, lines: null, archives: null };

  view.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Server &amp; logs</h1><p class="lede" id="host-line">Asking the server…</p></div>
      <div class="head-actions"><div class="seg" role="group" aria-label="Graphs over"><button type="button" data-range="15m">15 min</button><button type="button" data-range="24h">24 hours</button></div>
        <a class="btn btn-sm" href="/api/stats/export.csv?range=24h" download>${icon('download')} Spreadsheet</a></div></div>
    <div id="alerts"></div>
    <div class="tiles" id="tiles"><div class="loading"><span class="spin"></span><span>Loading…</span></div></div>
    <p class="muted small" id="unlock" style="margin-top:14px"></p>
    <section class="section card" id="logs"><div class="row-between"><div><h2>Logs</h2><p class="muted small" style="margin-top:4px">Newest first. Kept on the server in <code>logs/manager.log</code>.</p></div>
      <div class="row"><div class="seg" role="group" aria-label="Which lines"><button type="button" data-logs="problems">Problems only</button><button type="button" data-logs="all">Everything</button></div>
        <button class="btn btn-sm" type="button" id="log-refresh">${icon('refresh')} Refresh</button>
        <a class="btn btn-sm" href="/api/logs/download" download>${icon('download')} Download</a>
        <button class="btn btn-ghost btn-sm" type="button" id="log-clear">Clear</button></div></div>
      <p class="sr-only" role="status" id="log-status"></p>
      <div class="logbox" id="log-list" style="margin-top:14px" tabindex="0" aria-label="Log lines"><div class="loading" style="padding:14px"><span class="spin"></span><span>Loading…</span></div></div>
      <details class="more" id="archives"><summary>Earlier, cleared logs</summary><div class="more-body" id="archive-list"><p class="muted small">Loading…</p></div></details>
    </section></div>`;

  const $ = (sel) => view.querySelector(sel);
  const drawRange = () => view.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
  const drawStats = () => {
    if (!ctx.alive()) return;
    // a highlight the owner is making waits
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && $('#tiles').contains(sel.anchorNode)) return;
    const h = snap?.host;
    $('#host-line').innerHTML = error && !snap ? `<span style="color:var(--bad)">Can’t get the numbers: ${esc(error)}</span>`
      : h ? esc([h.hostname, h.os, h.kernel && `kernel ${h.kernel}`, fin(h.uptimeS) && `on for ${span(h.uptimeS)}`, fin(h.appUptimeS) && `Sentry Six up ${span(h.appUptimeS)}`, h.version && `version ${h.version}`].filter(Boolean).join(' · ')) + (error ? ' · <span style="color:var(--warn)">not updating right now</span>' : '') : 'Asking the server…';
    if (!snap) return;
    $('#alerts').innerHTML = (snap.alerts || []).filter((a) => a?.message).map((a) => `<div class="note note-${a.level === 'error' ? 'bad' : 'warn'}" style="margin-bottom:12px">${icon('alert')}<span><b>${a.level === 'error' ? 'Problem' : 'Worth a look'}:</b> ${esc(a.message)}</span></div>`).join('');
    $('#tiles').innerHTML = tiles(snap, range === '24h' ? hist : null, showAll) || '<p class="muted">The server has no numbers to show here.</p>';
    const unlock = (snap.unlock || []).filter((u) => u?.adds);
    $('#unlock').innerHTML = unlock.length ? `More numbers are available with one optional line each in docker-compose.yml: ${unlock.map((u) => `${esc(u.adds)}${u.compose ? ` (<code>${esc(u.compose)}</code>)` : ''}`).join('; ')}. Every number stays on this server.` : 'Every number stays on this server.';
    view.querySelectorAll('[data-more]').forEach((b) => { b.onclick = () => { showAll[b.dataset.more] = !showAll[b.dataset.more]; drawStats(); }; });
  };
  const poll = async () => {
    try {
      const want24 = range === '24h' && Date.now() - histAt > 60000;
      const [s, hh] = await Promise.all([api('/api/stats', { timeoutMs: 10000 }), want24 ? api('/api/stats/history?range=24h', { timeoutMs: 15000 }).catch(() => null) : null]);
      snap = s;
      if (hh) { hist = hh; histAt = Date.now(); }
      error = null;
    } catch (err) { error = err.message; }
    drawStats();
  };
  view.querySelectorAll('[data-range]').forEach((b) => { b.onclick = () => { range = b.dataset.range; store.set('statsRange', range); drawRange(); histAt = 0; poll(); }; });
  drawRange();
  poll();
  ctx.every(2000, poll);

  // logs
  const drawLogs = () => {
    view.querySelectorAll('[data-logs]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.logs === 'all') === logs.all)));
    if (!logs.lines) return;
    $('#log-list').innerHTML = logs.lines.length ? logs.lines.map((l) => `<div class="logline ${esc(l.level)}"><span class="muted">${esc(when(l.at))}</span><span class="lvl">${esc(l.level)}</span><span class="muted">${esc(l.scope)}</span><span class="msg">${esc(l.message)}</span></div>`).join('')
      : `<p class="muted" style="padding:14px;font-family:var(--font)">${logs.all ? 'The log is empty.' : 'No warnings or errors. All good.'}</p>`;
  };
  const loadLogs = async (tell = false) => {
    try {
      logs.lines = (await api(`/api/logs?level=${logs.all ? 'all' : 'problems'}`, { timeoutMs: 15000 })).lines;
      drawLogs();
      if (tell) $('#log-status').textContent = `${plural(logs.lines.length, 'line')} loaded.`;
    } catch (err) { fail(err); }
  };
  const loadArchives = async () => {
    try {
      const { archives = [] } = await api('/api/logs/archive');
      $('#archive-list').innerHTML = archives.length ? `<ul class="stack-sm" style="padding-left:18px">${archives.map((a) => `<li><a class="btn btn-ghost btn-sm" href="/api/logs/archive/${encodeURIComponent(a.name)}" download>${icon('download')} ${esc(when(a.at))}</a> <span class="muted small">${bytes(a.bytes)}</span></li>`).join('')}</ul>` : '<p class="muted small">None yet. Clearing the log keeps its lines here.</p>';
    } catch (err) { $('#archive-list').innerHTML = `<p class="muted small">${esc(err.message)}</p>`; }
  };
  view.querySelectorAll('[data-logs]').forEach((b) => { b.onclick = () => { logs.all = b.dataset.logs === 'all'; drawLogs(); loadLogs(true); }; });
  $('#log-refresh').onclick = (e) => busy(e.currentTarget, () => loadLogs(true));
  $('#log-clear').onclick = async (e) => {
    if (!(await confirmDialog({ title: 'Clear the log?', body: '<p>The current lines move to “Earlier, cleared logs”, where you can still download them. Nothing is deleted.</p>', ok: 'Clear' }))) return;
    await busy(e.currentTarget, async () => {
      try { await api('/api/logs/clear', { method: 'POST' }); toast('Log cleared. The old lines are kept.', { kind: 'good' }); } catch (err) { fail(err); }
      await loadLogs();
      loadArchives();
    });
  };
  $('#archives').addEventListener('toggle', (e) => { if (e.target.open) loadArchives(); });
  drawLogs();
  loadLogs();
}
