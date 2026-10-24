// Mockup only: injects sample "Server" and "Hardware" panels into the real pages.
const spark = (pts, w = 220, h = 40, color = 'var(--accent)') => {
  const max = Math.max(...pts), min = Math.min(...pts);
  const xy = pts.map((p, i) => `${(i / (pts.length - 1)) * w},${h - 3 - ((p - min) / (max - min || 1)) * (h - 6)}`).join(' ');
  return `<svg class="nd-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${xy}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/><polyline points="0,${h} ${xy} ${w},${h}" fill="${color}" opacity="0.08" stroke="none"/></svg>`;
};
const cpuHist = [22,25,31,28,35,41,38,33,37,44,52,48,39,36,41,37,35,33,38,37];
const vidHist = [60,72,88,91,94,93,95,92,94,96,94,93,95,94,92,94,95,94,93,94];
const netHist = [80,95,101,110,108,112,99,104,111,112,109,113,110,108,112,111,107,112,110,112];
const cores = [41,37,55,28,61,33,47,22,39,30,52,26];
const bar = (pct, cls = '') => `<div class="nd-bar ${cls}"><span style="width:${pct}%"></span></div>`;

const serverHtml = `
<section class="card nd-server">
  <div class="nd-head">
    <div><h2>Server</h2>
      <p class="muted small">nas-box · Ubuntu 24.04 · kernel 6.8.0 · up 12 d 4 h · app up 3 h 12 m · version 98d4861</p></div>
    <div class="nd-head-right"><span class="chip amber"><span class="cdot"></span>1 warning</span>
      <label class="check small"><input type="checkbox" checked> Nerd stats</label></div>
  </div>
  <div class="nd-alert"><b>Warning</b> NVMe data disk at 71 °C (throttles at 75 °C) · <a href="#/overview/logs">Logs</a></div>
  <div class="nd-grid">
    <div class="nd-tile">
      <div class="nd-title"><span>CPU</span><span class="muted">Intel Core i5-12500 · 6 cores / 12 threads</span></div>
      <div class="nd-big"><b>37%</b><span class="muted small">whole server</span></div>
      ${spark(cpuHist)}
      <div class="nd-cores">${cores.map((c) => `<i style="--v:${c}%" title="${c}%"></i>`).join('')}</div>
      <dl class="nd-kv"><dt>Clock</dt><dd>4.1 GHz</dd><dt>Temp</dt><dd>58 °C</dd><dt>Load</dt><dd>2.4 · 1.9 · 1.6</dd><dt>This app</dt><dd>22% (ffmpeg ×4: 18%)</dd></dl>
    </div>
    <div class="nd-tile">
      <div class="nd-title"><span>GPU</span><span class="muted">Intel Arc A380 · xe · renderD128</span></div>
      <div class="nd-big"><b>94%</b><span class="muted small">video engine (encoding)</span></div>
      ${spark(vidHist, 220, 40, 'var(--info)')}
      <div class="nd-rows">
        <div><span>Render / 3D</span>${bar(12)}<b>12%</b></div>
        <div><span>Video</span>${bar(94, 'hot')}<b>94%</b></div>
        <div><span>VRAM</span>${bar(18)}<b>1.1 / 6 GB</b></div>
      </div>
      <dl class="nd-kv"><dt>Clock</dt><dd>1.95 GHz</dd><dt>Temp</dt><dd>61 °C</dd><dt>Power</dt><dd>24 W</dd><dt>Clients</dt><dd>4 × ffmpeg</dd></dl>
    </div>
    <div class="nd-tile">
      <div class="nd-title"><span>Power</span><span class="muted">measured, not estimated</span></div>
      <div class="nd-big"><b>68 W</b><span class="muted small">CPU + GPU</span></div>
      <div class="nd-rows">
        <div><span>CPU package</span>${bar(55)}<b>41 W</b></div>
        <div><span>GPU</span>${bar(32)}<b>24 W</b></div>
      </div>
      <dl class="nd-kv"><dt>Today</dt><dd>0.94 kWh · ≈ $0.14</dd><dt>This week</dt><dd>5.2 kWh · ≈ $0.78</dd><dt>Converting</dt><dd>0.31 kWh this run</dd></dl>
    </div>
    <div class="nd-tile">
      <div class="nd-title"><span>Memory</span><span class="muted">31.3 GB</span></div>
      <div class="nd-big"><b>18.2 GB</b><span class="muted small">used (58%)</span></div>
      ${bar(58)}
      <dl class="nd-kv"><dt>This app</dt><dd>640 MB</dd><dt>Cache</dt><dd>9.1 GB</dd><dt>Swap</dt><dd>0 / 2 GB</dd></dl>
    </div>
    <div class="nd-tile nd-wide">
      <div class="nd-title"><span>Storage</span><span class="muted">disks and shares</span></div>
      <div class="nd-disks">
        <div class="nd-disk"><div><b>Footage share</b><span class="muted small">//nas/teslacam · SMB 3.1.1</span></div>${bar(76)}<span class="small">6.1 of 8 TB · read 96 MB/s · write 41 MB/s · answers in 3 ms</span></div>
        <div class="nd-disk"><div><b>Data volume</b><span class="muted small">nvme0n1 · /data</span></div>${bar(24)}<span class="small">112 of 476 GB · read 2 MB/s · write 14 MB/s · <span class="nd-warn">71 °C</span></span></div>
        <div class="nd-disk"><div><b>sda</b><span class="muted small">WDC WD80EFZZ · not mounted here</span></div>${bar(0)}<span class="small">I/O only: read 0 MB/s · write 0 MB/s · 38 °C</span></div>
      </div>
    </div>
    <div class="nd-tile">
      <div class="nd-title"><span>Network</span><span class="muted">eth0 · 2.5 Gbit/s</span></div>
      <div class="nd-big"><b>↓ 112 MB/s</b><span class="muted small">↑ 44 MB/s</span></div>
      ${spark(netHist, 220, 40, 'var(--info)')}
      <dl class="nd-kv"><dt>NAS</dt><dd>95% of traffic</dd><dt>Viewers</dt><dd>2 devices · 6 MB/s</dd></dl>
    </div>
    <div class="nd-tile">
      <div class="nd-title"><span>Sensors</span><span class="muted">every one the server reports</span></div>
      <dl class="nd-kv nd-sensors"><dt>CPU package</dt><dd>58 °C</dd><dt>Core max</dt><dd>63 °C</dd><dt>GPU</dt><dd>61 °C</dd><dt>NVMe</dt><dd class="nd-warn">71 °C</dd><dt>sda</dt><dd>38 °C</dd><dt>Fan 1</dt><dd>1,180 rpm</dd><dt>Fan 2</dt><dd>910 rpm</dd></dl>
    </div>
    <div class="nd-tile nd-wide">
      <div class="nd-title"><span>Top processes</span><span class="muted">whole server</span></div>
      <table class="nd-procs"><thead><tr><th>Process</th><th>CPU</th><th>Memory</th><th>GPU</th></tr></thead><tbody>
        <tr><td>ffmpeg · hevc_vaapi ×4</td><td>18%</td><td>412 MB</td><td>94% video</td></tr>
        <tr><td>plex (another container)</td><td>9%</td><td>1.2 GB</td><td>—</td></tr>
        <tr><td>sentry-six-manager</td><td>4%</td><td>228 MB</td><td>—</td></tr>
        <tr><td>smbd</td><td>3%</td><td>64 MB</td><td>—</td></tr></tbody></table>
    </div>
  </div>
  <p class="muted small nd-foot">Shown only when the server provides it. More with one optional line each in <code>docker-compose.yml</code>: CPU power (read-only energy counter) · whole-server processes and network (<code>pid: host</code>). Every number stays on this server.</p>
</section>`;

const workers = [
  ['SentryClips/2026-10-20_07-43-03/…-front.mp4', 412, '6.9×', '4.1 Mb/s', 71, '0 / 0'],
  ['SentryClips/2026-10-20_07-43-03/…-back.mp4', 398, '6.6×', '3.8 Mb/s', 54, '0 / 0'],
  ['SentryClips/2026-10-20_07-43-03/…-left_repeater.mp4', 405, '6.8×', '2.9 Mb/s', 33, '0 / 0'],
  ['SentryClips/2026-10-20_07-43-03/…-right_repeater.mp4', 401, '6.7×', '3.0 Mb/s', 12, '0 / 0']
];
const hwHtml = `
<section class="nd-hw">
  <div class="nd-hw-head"><h3>Hardware</h3>
    <span class="nd-chip">hevc_vaapi · Intel Arc A380 · renderD128</span><span class="nd-chip">decode: GPU</span><span class="nd-chip">4 at once</span></div>
  <div class="nd-hw-tiles">
    <div><span>Video engine</span><b>94%</b>${bar(94, 'hot')}</div>
    <div><span>CPU (conversions)</span><b>18%</b>${bar(18)}</div>
    <div><span>Power</span><b>68 W</b><small>CPU 41 · GPU 24</small></div>
    <div><span>Temperatures</span><b>61 °C</b><small>GPU 61 · CPU 58</small></div>
  </div>
  <div class="nd-hint"><b>Bottleneck: the GPU's video engine</b> is 94% busy, so more conversions at once won't go faster. The NAS (96 MB/s of 280) and CPU have room.</div>
  <div class="nd-eff"><div><span>This run</span><b>0.31 kWh</b></div><div><span>Clips per kWh</span><b>1,329</b></div><div><span>Space saved per kWh</span><b>125 GB</b></div><div><span>Cost so far</span><b>≈ $0.05</b></div></div>
  <div class="nd-workers">${workers.map(([c, f, s, b, p]) => `<div class="nd-w"><div class="nd-w-top"><span class="nd-clip">${c.split('/').pop().replace('…-', '07-38-45-')}</span><span>${p}%</span></div><div class="nd-bar"><span style="width:${p}%"></span></div><div class="nd-w-meta">${f} fps · ${s} realtime · ${b} · no dropped frames</div></div>`).join('')}</div>
</section>`;

const css = `
.nd-server { margin-top: 18px; }
.nd-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.nd-head-right { display: flex; align-items: center; gap: 12px; }
.nd-alert { margin-top: 14px; padding: 10px 14px; border-radius: 12px; border: 1px solid rgba(255,159,90,.45); background: rgba(255,159,90,.1); font-size: 14px; }
.nd-alert b { color: var(--warn); margin-right: 8px; }
.nd-grid { display: grid; grid-auto-flow: row dense; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 14px; margin-top: 16px; }
.nd-tile { background: var(--panel-2); border: 1px solid var(--border); border-radius: 14px; padding: 16px; min-width: 0; }
.nd-wide { grid-column: span 2; }
.nd-title { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; font-weight: 700; }
.nd-title .muted { text-transform: none; letter-spacing: 0; font-weight: 500; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nd-big { display: flex; align-items: baseline; gap: 8px; margin-top: 10px; }
.nd-big b { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.nd-spark { width: 100%; height: 40px; display: block; margin-top: 8px; }
.nd-cores { display: grid; grid-template-columns: repeat(12, 1fr); gap: 3px; height: 26px; margin-top: 10px; }
.nd-cores i { background: linear-gradient(to top, var(--accent) var(--v), rgba(255,255,255,.06) var(--v)); border-radius: 3px; }
.nd-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin-top: 12px; font-size: 13px; }
.nd-kv dt { color: var(--muted); } .nd-kv dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.nd-rows { display: grid; gap: 8px; margin-top: 12px; font-size: 13px; }
.nd-rows > div { display: grid; grid-template-columns: 92px 1fr auto; align-items: center; gap: 10px; }
.nd-rows b { font-weight: 600; font-variant-numeric: tabular-nums; }
.nd-bar { height: 6px; border-radius: 99px; background: rgba(255,255,255,.07); overflow: hidden; margin-top: 8px; }
.nd-rows .nd-bar { margin-top: 0; }
.nd-bar span { display: block; height: 100%; background: var(--accent); border-radius: 99px; }
.nd-bar.hot span { background: var(--warn); }
.nd-disks { display: grid; gap: 14px; margin-top: 12px; }
.nd-disk > div { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.nd-disk .small { display: block; margin-top: 6px; color: var(--text-2); }
.nd-warn { color: var(--warn) !important; font-weight: 600; }
.nd-procs { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
.nd-procs th { text-align: left; color: var(--muted); font-weight: 600; font-size: 12px; padding: 6px 0; }
.nd-procs td { padding: 7px 0; border-top: 1px solid var(--border); }
.nd-procs td + td, .nd-procs th + th { text-align: right; }
.nd-foot { margin-top: 14px; }
@media (max-width: 760px) { .nd-wide { grid-column: auto; } .nd-grid { grid-template-columns: minmax(0,1fr); } .nd-procs th:nth-child(3), .nd-procs td:nth-child(3) { display: none; } }
/* encoder */
.nd-hw { margin: 18px 0; padding: 18px; border: 1px solid #1F2530; border-radius: 16px; background: #0F1318; }
.nd-hw-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.nd-hw-head h3 { margin: 0 8px 0 0; font-size: 16px; }
.nd-chip { font: 600 12px ui-monospace, monospace; padding: 4px 10px; border-radius: 99px; border: 1px solid #2A313D; color: #c3cad5; }
.nd-hw-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px,1fr)); gap: 10px; margin-top: 14px; }
.nd-hw-tiles > div { background: #12161D; border: 1px solid #1F2530; border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.nd-hw-tiles span { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8a94a6; font-weight: 700; }
.nd-hw-tiles b { font-size: 22px; font-variant-numeric: tabular-nums; }
.nd-hw-tiles small { color: #8a94a6; font-size: 12px; }
.nd-hw .nd-bar { height: 5px; margin-top: 4px; } .nd-hw .nd-bar span { background: #C8F25A; } .nd-hw .nd-bar.hot span { background: #FF9F5A; }
.nd-hint { margin-top: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(90,209,242,.4); background: rgba(90,209,242,.08); font-size: 13px; color: #c3cad5; }
.nd-hint b { color: #5AD1F2; }
.nd-eff { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px,1fr)); gap: 10px; margin-top: 12px; }
.nd-eff div { display: flex; flex-direction: column; } .nd-eff span { font-size: 12px; color: #8a94a6; } .nd-eff b { font-size: 16px; font-variant-numeric: tabular-nums; }
.nd-workers { display: grid; gap: 10px; margin-top: 14px; }
.nd-w { padding-top: 10px; border-top: 1px solid #1F2530; font-size: 13px; }
.nd-w-top { display: flex; justify-content: space-between; gap: 10px; font-variant-numeric: tabular-nums; }
.nd-w .nd-clip { font: 12px ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.nd-w-meta { margin-top: 6px; color: #8a94a6; font-size: 12px; font-variant-numeric: tabular-nums; }
`;
module.exports = { serverHtml, hwHtml, css };
