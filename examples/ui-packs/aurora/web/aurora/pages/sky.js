// Sky: the home. A hero with the vehicle and its storage as a glowing ring,
// then floating widgets: attention, the server (live from /api/stats), the
// Encoder, the latest days, the Recycle Bin and policy, and the logs.

import {
  $, $$, esc, icon, api, state, current, setVehicle, bytes, rate, pct, plural, ago, when, whenFull, watts, energy, money, num, fin,
  ring, meter, toast, confirmDialog, loadNotes, dayParts, empty
} from '../core.js';
import { follow, counts, STATE_TEXT, ACTIVE, CODEC } from '../conv.js';

const CATS = [['Recent', 'teal', 'drive', 'drives'], ['Sentry', 'magenta', 'Sentry event', 'Sentry events'], ['Saved', 'green', 'saved clip', 'saved clips'], ['Other', 'violet', 'other recording', 'other recordings']];

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Clear skies tonight' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function spark(values, cls = 'l', area = true, max = null) {
  const v = values.filter((x) => fin(x));
  if (v.length < 2) return '<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"></svg>';
  const top = max ?? Math.max(...v, 1);
  const pts = values.map((x, i) => [(i / (values.length - 1)) * 100, fin(x) ? 38 - (x / top) * 34 : null]).filter((p) => p[1] !== null);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">${area ? `<path class="a" d="${d}L${pts[pts.length - 1][0].toFixed(1)},40L${pts[0][0].toFixed(1)},40Z"/>` : ''}<path class="${cls}" d="${d}" vector-effect="non-scaling-stroke"/></svg>`;
}

function hero(v) {
  if (!v) {
    return `<section class="sky-hero glass"><div>
      <p class="hero-hello">${esc(greeting())}</p>
      <h2 class="hero-name">Your sky is empty</h2>
      <p class="hero-line">Add a vehicle (a network share or a folder with its TeslaCam footage) to start.</p>
      <div class="hero-actions"><a class="btn primary" href="#/settings/vehicles/new">${icon('plus')} Add a vehicle</a></div></div>
      <div class="hero-gauge"><div class="halo"></div>${ring(0, { size: 240, stroke: 14, label: 'No storage yet' })}<div class="gauge-text"><span class="gauge-big">—</span><span class="gauge-small">no storage yet</span></div></div></section>`;
  }
  const inv = v.inventory || {};
  const s = v.share || {};
  const total = s.totalBytes;
  const free = s.freeBytes;
  const used = fin(total) && fin(free) ? total - free : null;
  const usedFrac = used !== null && total ? used / total : 0;
  const footFrac = fin(inv.bytes) && total ? inv.bytes / total : 0;
  const cls = usedFrac > 0.95 ? 'bad' : usedFrac > 0.85 ? 'warn' : '';
  const cars = state.vehicles.length > 1
    ? `<div class="hero-cars" role="group" aria-label="Vehicles">${state.vehicles.map((x) => `<button class="car-pill${x.id === v.id ? ' on' : ''}" type="button" data-car="${esc(x.id)}" aria-pressed="${x.id === v.id}"><span class="dot ${x.share?.healthy ? 'ok' : 'bad'}"></span>${esc(x.name)}</button>`).join('')}</div>`
    : '';
  const health = s.healthy === false
    ? `<p class="note bad" style="margin-top:14px">${icon('warn')} ${esc(s.lastError || 'The footage can’t be reached right now.')}${s.hint ? ` ${esc(s.hint)}` : ''}</p>`
    : s.writable === false ? '<p class="note warn" style="margin-top:14px">Read-only: footage can be watched, not converted or moved.</p>' : '';
  const line = inv.recordings !== undefined
    ? `${plural(inv.recordings, 'recording')} · ${bytes(inv.bytes)} of footage${v.scanning ? ' · scanning now' : inv.scannedAt ? ` · checked ${ago(inv.scannedAt)}` : ''}`
    : v.scanning ? 'Looking through the footage for the first time…' : 'Not scanned yet.';
  return `<section class="sky-hero glass">
    <div>
      <p class="hero-hello">${esc(greeting())}</p>
      <h2 class="hero-name">${esc(v.name)}</h2>
      <p class="hero-line">${esc(line)}</p>
      <div class="hero-cats">${CATS.map(([c, col, one, many]) => (inv.byCategory?.[c]?.recordings ? `<span class="chip ${col}"><i class="dot cat-${c}"></i>${plural(inv.byCategory[c].recordings, one, many)}</span>` : '')).join('')}${v.binItems ? `<span class="chip">${icon('trash')}${plural(v.binItems, 'item')} in the Bin</span>` : ''}</div>
      ${health}
      ${cars}
      <div class="hero-actions">
        <a class="btn primary" href="#/footage">${icon('film')} Browse footage</a>
        <a class="btn" href="#/viewer">${icon('play')} Play latest</a>
        <button class="btn" type="button" id="scan">${icon('refresh')} Refresh</button>
      </div>
    </div>
    <div>
      <div class="hero-gauge">
        <div class="halo"></div>
        ${ring(usedFrac, { size: 260, stroke: 16, cls, label: `Storage ${pct(usedFrac * 100)} used` })}
        <div style="position:absolute;inset:13%">${ring(footFrac, { size: 200, stroke: 8, cls: 'ring-inner', label: `Footage ${pct(footFrac * 100, 1)} of the storage` })}</div>
        <div class="gauge-text"><span class="gauge-big">${fin(free) ? esc(bytes(free)) : '—'}</span><span class="gauge-small">${fin(total) ? `free of ${esc(bytes(total))}` : 'free space unknown'}</span></div>
      </div>
      <div class="gauge-legend"><span><i style="background:var(--accent)"></i>Used ${fin(used) ? esc(bytes(used)) : '—'}</span><span><i style="background:var(--au-violet)"></i>Footage ${esc(bytes(inv.bytes))}</span>${v.binBytes ? `<span><i style="background:#ff8fb1"></i>Bin ${esc(bytes(v.binBytes))}</span>` : ''}</div>
    </div>
  </section>`;
}

function attention(stats) {
  const notes = state.notes.slice(0, 5);
  const alerts = (stats?.alerts || []).filter((a) => !notes.some((n) => n.title === a.message));
  if (!notes.length && !alerts.length) return `<div class="empty" style="padding:16px 0"><div class="empty-orb">${icon('check')}</div><p class="muted">All calm. Nothing needs you.</p></div>`;
  return `<ul class="list">${notes.map((n) => `<li class="attn ${esc(n.level)}"><span class="dot ${n.level === 'critical' ? 'bad' : n.level === 'info' ? 'ok' : 'warn'}" style="margin-top:7px"></span><div><b>${esc(n.title)}</b><br><span class="muted small">${esc(n.message || '')} · ${esc(ago(n.createdAt))}</span></div><button class="btn ghost icon" type="button" data-dismiss="${esc(n.id)}" aria-label="Dismiss ${esc(n.title)}">${icon('x')}</button></li>`).join('')}
    ${alerts.map((a) => `<li class="attn ${esc(a.level)}"><span class="dot ${a.level === 'error' ? 'bad' : 'warn'}" style="margin-top:7px"></span><div>${esc(a.message)}<br><span class="muted small">from the server monitor</span></div></li>`).join('')}</ul>`;
}

function serverHtml(s, hist) {
  if (!s) return '<p class="loading">Reading the server…</p>';
  const cpu = s.cpu || {};
  const mem = s.memory || {};
  const memPct = mem.totalB ? ((mem.totalB - (mem.availableB ?? mem.totalB - mem.usedB)) / mem.totalB) * 100 : null;
  const net = s.network || {};
  const rx = (net.interfaces || []).reduce((n, i) => n + (i.rxBps || 0), 0);
  const tx = (net.interfaces || []).reduce((n, i) => n + (i.txBps || 0), 0);
  const p = s.power || {};
  const cur = state.power?.currency || '$';
  const temps = (s.sensors || []).filter((x) => x.kind === 'temp' && fin(x.value));
  const hottest = temps.reduce((m, x) => (x.value > (m?.value ?? -1) ? x : m), null);
  const disks = (s.disks || []).filter((d) => fin(d.readBps) || fin(d.writeBps) || fin(d.busy) || fin(d.tempC));
  const fss = (s.filesystems || []).filter((f) => fin(f.totalB));
  const cpuHist = hist?.cpu || [];
  return `<div class="stat-grid">
      <div class="stat"><span class="stat-label"><span>${icon('cpu', 'ico-sm')} CPU</span><span>${esc(cpu.model || '')}</span></span>
        <span class="stat-val">${pct(cpu.usage)}${fin(cpu.tempC) ? ` · ${num(cpu.tempC)} °C` : ''}</span>${meter(cpu.usage)}
        ${cpu.perCore?.length ? `<div class="cores" aria-label="Per core">${cpu.perCore.map((c) => `<i title="${pct(c)}"><b style="height:${Math.max(0, Math.min(100, c))}%"></b></i>`).join('')}</div>` : ''}
        <span class="muted tiny">Load ${(cpu.load || []).map((x) => num(x, 2)).join(' · ') || '—'} · ${plural(cpu.threads || cpu.cores || 0, 'thread')}${cpu.throttling ? ' · <b style="color:var(--warn)">throttling</b>' : ''}</span>
        ${spark(cpuHist.slice(-90), 'l', true, 100)}</div>
      <div class="stat"><span class="stat-label"><span>Memory</span><span>${bytes(mem.totalB)}</span></span>
        <span class="stat-val">${pct(memPct)}</span>${meter(memPct, 'violet')}
        <span class="muted tiny">${bytes(mem.usedB)} used · ${bytes(mem.cacheB)} cache · this app ${bytes(mem.appB)}${mem.swapTotalB ? ` · swap ${bytes(mem.swapUsedB)}/${bytes(mem.swapTotalB)}` : ''}</span>
        ${spark((hist?.memory || []).slice(-90), 'l2', false, 100)}</div>
      <div class="stat"><span class="stat-label"><span>${icon('net', 'ico-sm')} Network</span><span>${esc(net.scope || '')}</span></span>
        <span class="stat-val">↓ ${rate(rx)} · ↑ ${rate(tx)}</span>
        <span class="muted tiny">Today ↓ ${bytes(net.today?.rxB)} ↑ ${bytes(net.today?.txB)} · week ↓ ${bytes(net.week?.rxB)}</span>
        ${spark((hist?.rxBps || []).slice(-90), 'l')}</div>
      <div class="stat"><span class="stat-label"><span>${icon('bolt', 'ico-sm')} Power</span><span>${s.price ? `${money(s.price.now, cur)}/kWh${s.price.rate ? ` · ${esc(s.price.rate)}` : ''}` : ''}</span></span>
        <span class="stat-val">${fin(p.totalW) ? watts(p.totalW) : 'not measured'}</span>
        <span class="muted tiny">${fin(p.cpuW) ? `CPU ${watts(p.cpuW)} · ` : ''}${fin(p.gpuW) ? `GPU ${watts(p.gpuW)} · ` : ''}today ${energy(p.todayWh)}${fin(p.todayCost) ? ` (${money(p.todayCost, cur)})` : ''} · week ${energy(p.weekWh)}${fin(p.weekCost) ? ` (${money(p.weekCost, cur)})` : ''}</span></div>
    </div>
    ${(s.gpus || []).length ? `<hr class="soft"><div class="stat-grid">${s.gpus.map((g) => `<div class="stat"><span class="stat-label"><span>GPU · ${esc(g.name || g.vendor || g.id)}</span><span>${fin(g.tempC) ? `${num(g.tempC)} °C` : ''}</span></span>
        <span class="stat-val">${pct(g.busy)} busy${fin(g.video) ? ` · video ${pct(g.video)}` : ''}</span>${meter(g.busy)}${fin(g.video) ? meter(g.video, 'violet') : ''}
        <span class="muted tiny">${fin(g.vramTotalB) ? `VRAM ${bytes(g.vramUsedB)} / ${bytes(g.vramTotalB)}` : ''}${fin(g.powerW) ? ` · ${watts(g.powerW)}` : ''}${fin(g.clockMHz) ? ` · ${num(g.clockMHz)} MHz` : ''}</span></div>`).join('')}</div>` : ''}
    ${disks.length || fss.length ? `<hr class="soft"><div class="stat-grid">
      ${fss.map((f) => `<div class="stat"><span class="stat-label"><span>${icon('disk', 'ico-sm')} ${esc(f.label)}</span><span>${f.reachable === false ? '<b style="color:var(--bad)">unreachable</b>' : fin(f.latencyMs) ? `${num(f.latencyMs)} ms` : ''}</span></span>
        <span class="stat-val">${bytes(f.freeB)} free</span>${meter(f.totalB ? (f.usedB / f.totalB) * 100 : 0, f.totalB && f.freeB / f.totalB < 0.05 ? 'hot' : '')}<span class="muted tiny">${bytes(f.usedB)} of ${bytes(f.totalB)}${f.fsType ? ` · ${esc(f.fsType)}` : ''}${f.smbVersion ? ` · SMB ${esc(f.smbVersion)}` : ''}</span></div>`).join('')}
      ${disks.map((d) => `<div class="stat"><span class="stat-label"><span>${icon('disk', 'ico-sm')} ${esc(d.name)}${d.model ? ` · ${esc(d.model)}` : ''}</span><span>${fin(d.tempC) ? `${num(d.tempC)} °C` : ''}</span></span>
        <span class="stat-val">R ${rate(d.readBps)} · W ${rate(d.writeBps)}</span>${fin(d.busy) ? meter(d.busy) : ''}</div>`).join('')}</div>` : ''}
    ${temps.length ? `<details class="more-info"><summary>${icon('temp', 'ico-sm')} Temperatures${hottest ? ` · hottest ${esc(hottest.label)} ${num(hottest.value)} °C` : ''}</summary><div class="row" style="margin-top:6px">${temps.map((t) => `<span class="chip${t.value >= 80 ? ' red' : t.value >= 65 ? ' amber' : ''}">${esc(t.label)} ${num(t.value)} °C</span>`).join('')}</div></details>` : ''}
    ${(s.processes?.top || []).length ? `<details class="more-info"><summary>Busiest processes (${esc(s.processes.scope || '')})</summary><div class="table-wrap"><table class="tbl stack-sm"><thead><tr><th>Process</th><th>CPU</th><th>Memory</th></tr></thead><tbody>${s.processes.top.slice(0, 8).map((x) => `<tr><td data-label="Process">${esc(x.name)} <span class="muted tiny">${esc(x.pid)}</span></td><td data-label="CPU">${pct(x.cpu, 1)}</td><td data-label="Memory">${bytes(x.memB)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
    ${(s.unlock || []).length ? `<details class="more-info"><summary>See more of the server</summary><ul class="list small">${s.unlock.map((u) => `<li><div>${esc(u.adds)}: add <code>${esc(u.compose)}</code> to the compose file.</div></li>`).join('')}</ul></details>` : ''}
    <p class="muted tiny" style="margin-top:12px">${esc(s.host?.hostname || '')} · ${esc(s.host?.os || '')} ${esc(s.host?.kernel || '')} · up ${esc(Math.round((s.host?.uptimeS || 0) / 3600))} h · Sentry Six ${esc(s.host?.version || '')}</p><div class="actions start"><a class="btn sm" href="/api/stats/export.csv?range=24h" download>${icon('download')} Export 24 h (CSV)</a><a class="btn sm" href="/api/stats/export.csv?range=15m" download>Last 15 min</a></div>`;
}

function encoderHtml(snap, enc) {
  if (!snap) return `<div class="row" style="gap:18px">${ring(0, { size: 92, stroke: 9, label: 'No conversion' })}<div><p class="stat-big">Idle</p><p class="muted small">No conversion running.</p></div></div><div class="actions start"><a class="btn sm" href="#/encoder">${icon('orbit')} Open the Encoder</a></div>`;
  const c = counts(snap);
  const frac = c.total ? c.done / c.total : 0;
  const active = ACTIVE.has(snap.state);
  return `<div class="row" style="gap:18px;flex-wrap:nowrap">${ring(frac, { size: 92, stroke: 9, cls: 'violet', label: `${pct(frac * 100)} done` })}
    <div style="min-width:0"><p class="stat-big">${pct(frac * 100)}</p><p class="muted small">${esc(STATE_TEXT[snap.state] || snap.state)} · ${c.done}/${c.total} clips · ${esc(CODEC[snap.config?.codec] || '')}</p>
    ${active && enc?.devices?.length ? `<p class="muted tiny">${enc.devices.map((d) => `${esc(d.name || 'CPU')} ×${d.workers}`).join(' · ')}</p>` : ''}
    ${snap.counters?.savedBytes ? `<p class="small" style="color:#c9ffe9">${bytes(snap.counters.savedBytes)} saved</p>` : ''}</div></div>
    <div class="actions start"><a class="btn sm" href="#/encoder">${icon('orbit')} ${active ? 'Watch it' : 'Open the Encoder'}</a></div>`;
}

const logState = { all: false, lines: null, scroll: 0 };
function logLines() {
  const lines = logState.lines;
  return lines === null ? '<p class="muted small" style="padding:8px">Loading…</p>' : lines.length ? lines.map((l) => `<div class="logline ${esc(l.level)}"><span class="lw">${esc(whenFull(l.at))}</span><span class="ll">${esc(l.level)}</span><span class="ls">${esc(l.scope)}</span><span class="lm">${esc(l.message)}</span></div>`).join('') : `<p class="muted small" style="padding:8px">${logState.all ? 'No log lines yet.' : 'No warnings or errors. Choose Everything to see all lines.'}</p>`;
}
function logsHtml() {
  return `<div class="logbar">
      <div class="seg" role="group" aria-label="Which lines"><button type="button" data-logs="problems" aria-pressed="${!logState.all}">Problems</button><button type="button" data-logs="all" aria-pressed="${logState.all}">Everything</button></div>
      <span class="spacer"></span>
      <button class="btn sm" type="button" id="log-refresh">${icon('refresh')} Refresh</button>
      <a class="btn sm" href="/api/logs/download" download>${icon('download')} Download</a>
      <button class="btn sm" type="button" id="log-clear">Clear</button></div>
    <div class="logbox" id="logbox" tabindex="0" aria-label="Log lines, newest first">${logLines()}</div>
    <details class="more-info" id="log-arch"><summary>Cleared logs (kept in the data folder)</summary><div id="log-arch-list" class="small muted">Open to list them.</div></details>`;
}

export default {
  title: 'Sky',
  chrome: false,
  topics: ['vehicles', 'inventory', 'notifications', 'bin', 'jobs'],
  async mount(ctx) {
    const { body } = ctx;
    let stats = null;
    let hist = null;
    let snap = null;
    let pollTimer = 0;
    let dead = false;
    let days = null;

    body.innerHTML = `<div id="hero"></div>
      <div class="widgets">
        <section class="widget glass" aria-labelledby="w-att"><div class="widget-head">${icon('bell')}<h2 id="w-att">Attention</h2><a class="btn sm ghost" href="#/alerts" style="margin-left:auto">All</a></div><div id="w-attention"></div></section>
        <section class="widget glass" aria-labelledby="w-enc"><div class="widget-head">${icon('orbit')}<h2 id="w-enc">Encoder</h2></div><div id="w-encoder"></div></section>
        <section class="widget glass" aria-labelledby="w-days"><div class="widget-head">${icon('film')}<h2 id="w-days">Latest days</h2><a class="btn sm ghost" href="#/footage" style="margin-left:auto">Filmstrip</a></div><div id="w-days-body"><p class="loading">Loading…</p></div></section>
        <section class="widget w8 glass" aria-labelledby="w-srv"><div class="widget-head">${icon('cpu')}<h2 id="w-srv">Server</h2><span class="live on" style="margin-left:auto" title="Live"></span></div><div id="w-server"><p class="loading">Reading the server…</p></div></section>
        <section class="widget glass" aria-labelledby="w-keep"><div class="widget-head">${icon('shield')}<h2 id="w-keep">Keeping</h2></div><div id="w-keep-body"></div></section>
        <section class="widget w12 glass" aria-labelledby="w-logs"><div class="widget-head">${icon('log')}<h2 id="w-logs">Logs</h2><span class="muted small" style="margin-left:auto">newest first</span></div><div id="w-logs-body">${logsHtml()}</div></section>
      </div>`;

    const drawHero = () => {
      $('#hero', body).innerHTML = hero(current());
    };
    const drawAttention = () => { $('#w-attention', body).innerHTML = attention(stats); };
    const drawServer = () => {
      const box = $('#w-server', body);
      const open = $$('details', box).map((d) => d.open);
      box.innerHTML = serverHtml(stats, hist);
      $$('details', box).forEach((d, i) => { if (open[i]) d.open = true; });
    };
    const drawEncoder = () => { $('#w-encoder', body).innerHTML = encoderHtml(snap, stats?.encoder); };
    const drawKeep = () => {
      const v = current();
      const el = $('#w-keep-body', body);
      if (!v) { el.innerHTML = '<p class="muted">No vehicle yet.</p>'; return; }
      const p = v.policy;
      const keeps = p ? Object.entries(p.keepDays || {}).filter(([, d]) => d) : [];
      el.innerHTML = `<div class="stat-grid">
        <div class="stat"><span class="stat-label">Recycle Bin</span><span class="stat-val">${bytes(v.binBytes)}</span><span class="muted tiny">${plural(v.binItems || 0, 'item')}</span></div>
        <div class="stat"><span class="stat-label">Policy</span><span class="stat-val">${p?.enabled ? 'On' : 'Off'}</span><span class="muted tiny">${p?.enabled ? (keeps.length ? keeps.map(([c, d]) => `${esc(c)} ${d} d`).join(' · ') : 'keeps everything') : 'nothing is moved by itself'}</span></div></div>
        <div class="actions start"><a class="btn sm" href="#/bin">${icon('trash')} Bin</a><a class="btn sm" href="#/policies">${icon('shield')} Policies</a></div>`;
    };
    const drawDays = () => {
      const v = current();
      const el = $('#w-days-body', body);
      if (!v) { el.innerHTML = '<p class="muted">No vehicle yet.</p>'; return; }
      if (!days) return;
      el.innerHTML = days.length ? `<div class="mini-days">${days.slice(0, 6).map((d) => {
        const p = dayParts(d.day);
        return `<a class="mini-day" href="#/footage/${encodeURIComponent(d.day)}" aria-label="${esc(d.day)}, ${plural(d.recordings, 'recording')}">${d.thumbId ? `<img class="thumb-img" loading="lazy" alt="" src="/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(d.thumbId)}/thumbnail">` : ''}<span>${esc(p.wd)} ${esc(p.dd)} ${esc(p.mon)}</span></a>`;
      }).join('')}</div>` : '<p class="muted">No footage yet.</p>';
    };
    const loadDays = async () => {
      const v = current();
      if (!v) { drawDays(); return; }
      try {
        days = (await api(`/api/vehicles/${encodeURIComponent(v.id)}/days?limit=6`)).days;
      } catch {
        days = [];
      }
      if (!dead) drawDays();
    };
    const loadLogs = async () => {
      try {
        const out = await api(`/api/logs?level=${logState.all ? 'all' : 'problems'}&limit=300`, { timeoutMs: 15000 });
        logState.lines = out.lines || [];
      } catch (err) {
        logState.lines = [{ at: Date.now(), level: 'error', scope: 'page', message: err.message }];
      }
      if (dead) return;
      const box = $('#logbox', body);
      if (!box) return;
      const top = box.scrollTop;
      box.innerHTML = logLines();
      box.scrollTop = top;
    };
    const loadArchives = async () => {
      const el = $('#log-arch-list', body);
      if (!el) return;
      try {
        const { archives = [] } = await api('/api/logs/archive', { timeoutMs: 15000 });
        el.innerHTML = archives.length ? `<ul class="list">${archives.map((a) => `<li><a class="btn sm" href="/api/logs/archive/${encodeURIComponent(a.name)}" download>${esc(whenFull(a.at))}</a><span class="muted">${bytes(a.bytes)}</span></li>`).join('')}</ul>` : 'None yet. Clear moves the current lines here; nothing is deleted.';
      } catch (err) {
        el.textContent = err.message;
      }
    };

    const poll = async () => {
      clearTimeout(pollTimer);
      if (dead) return;
      if (!document.hidden) {
        try {
          stats = await api('/api/stats', { timeoutMs: 10000 });
          if (hist) {
            for (const [k, val] of [['cpu', stats.cpu?.usage], ['memory', stats.memory?.totalB ? ((stats.memory.totalB - (stats.memory.availableB ?? 0)) / stats.memory.totalB) * 100 : null], ['rxBps', (stats.network?.interfaces || []).reduce((n, i) => n + (i.rxBps || 0), 0)]]) {
              (hist[k] ||= []).push(val ?? null);
              if (hist[k].length > 450) hist[k].shift();
            }
          }
          if (!dead) {
            drawServer();
            drawAttention();
            drawEncoder();
          }
        } catch { /* next poll */ }
      }
      pollTimer = setTimeout(poll, 2000);
    };

    drawHero();
    drawAttention();
    drawEncoder();
    drawKeep();
    loadDays();
    api('/api/stats/history?range=15m', { timeoutMs: 15000 }).then((h) => { hist = h.series || {}; if (!dead) drawServer(); }).catch(() => { hist = {}; });
    poll();
    setTimeout(loadLogs, 50);
    const stopConv = follow((s) => { snap = s; if (!dead) drawEncoder(); });

    body.addEventListener('click', async (e) => {
      const car = e.target.closest('[data-car]');
      if (car) { setVehicle(car.dataset.car); drawHero(); drawKeep(); loadDays(); return; }
      if (e.target.closest('#scan')) {
        const v = current();
        if (!v) return;
        try {
          await api(`/api/vehicles/${encodeURIComponent(v.id)}/scan`, { body: {} });
          toast('Looking through the footage again. Jobs shows the progress.');
        } catch (err) { toast(err.message, 'bad'); }
        return;
      }
      const dis = e.target.closest('[data-dismiss]');
      if (dis) {
        dis.disabled = true;
        await api(`/api/notifications/${encodeURIComponent(dis.dataset.dismiss)}/dismiss`, { body: {} }).catch((err) => toast(err.message, 'bad'));
        await loadNotes().catch(() => {});
        drawAttention();
        return;
      }
      const lg = e.target.closest('[data-logs]');
      if (lg) {
        logState.all = lg.dataset.logs === 'all';
        logState.lines = null;
        $$('[data-logs]', body).forEach((x) => x.setAttribute('aria-pressed', String(x === lg)));
        $('#logbox', body).innerHTML = logLines();
        loadLogs();
        return;
      }
      if (e.target.closest('#log-refresh')) { loadLogs(); return; }
      if (e.target.closest('#log-clear')) {
        if (!(await confirmDialog({ title: 'Clear the logs?', body: '<p>The log starts empty. Nothing is deleted: the current lines move to <code>logs/archive/</code> in the data folder and stay downloadable under Cleared logs.</p>', ok: 'Clear logs' }))) return;
        try {
          await api('/api/logs/clear', { body: {} });
          toast('Logs cleared. The earlier lines are under Cleared logs.');
        } catch (err) { toast(err.message, 'bad'); }
        loadLogs();
      }
    });
    body.addEventListener('toggle', (e) => { if (e.target.id === 'log-arch' && e.target.open) loadArchives(); }, true);

    return {
      refresh(topics) {
        if (topics.some((t) => ['vehicles', 'inventory', 'bin'].includes(t))) { drawHero(); drawKeep(); loadDays(); }
        if (topics.includes('notifications')) drawAttention();
      },
      destroy() {
        dead = true;
        clearTimeout(pollTimer);
        stopConv();
      }
    };
  }
};
