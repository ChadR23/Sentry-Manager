// Drawing helpers retained from Original so all measurements remain reachable.
import { esc } from './core.js';
const plural = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;

const fin = (n) => typeof n === 'number' && Number.isFinite(n);
const clampPct = (n) => Math.max(0, Math.min(100, Math.round((fin(n) ? n : 0) * 10) / 10));
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const sizeUnit = (b) => {
  let i = 0;
  for (let v = Math.abs(b); v >= 1024 && i < SIZE_UNITS.length - 1; v /= 1024) i++;
  return i;
};
const sizeNum = (b, i) => {
  const v = b / 1024 ** i;
  return v >= 100 || i === 0 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
};
// like the mockup: 18.2 GB, 640 MB, "112 of 476 GB", "1.1 / 6 GB"
const size = (b) => (fin(b) ? `${sizeNum(b, sizeUnit(b))} ${SIZE_UNITS[sizeUnit(b)]}` : '—');
const sizeOf = (used, total, sep = ' of ') =>
  `${sizeNum(used, sizeUnit(total))}${sep}${sizeNum(total, sizeUnit(total))} ${SIZE_UNITS[sizeUnit(total)]}`;
const rate = (bps) => {
  if (!fin(bps)) return '—';
  if (bps > 0 && bps < 1024 ** 2) return `${Math.max(1, Math.round(bps / 1024))} KB/s`;
  const i = Math.max(2, sizeUnit(bps));
  return `${sizeNum(bps, i)} ${SIZE_UNITS[i]}/s`;
};
const pct = (n) => `${Math.round(n)}%`;
const watts = (w) => `${w >= 10 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, '')} W`;
// in the one unit choice (web/units.js): °F with miles, °C with kilometres
// a server's words with a temperature in them ("CPU at 92 °C") in the chosen unit
const unitText = (t) => (globalThis.SentryUnits ? SentryUnits.inText(t) : t);
const temp = (c) => (globalThis.SentryUnits ? SentryUnits.tempText(c) : `${Math.round(c)} °C`);
const clock = (mhz) =>
  mhz >= 1000 ? `${Number((mhz / 1000).toFixed(2))} GHz` : `${Math.round(mhz)} MHz`;
// "12.4 Wh" below 100 Wh, so a run's first minutes visibly count up; "412 Wh"; then "5.2 kWh"
const energyText = (wh) => {
  if (Math.round(wh * 10) / 10 < 100) return `${(Math.round(wh * 10) / 10).toFixed(1)} Wh`;
  if (Math.round(wh) < 1000) return `${Math.round(wh)} Wh`;
  const k = wh / 1000;
  return `${Math.round(k * 10) / 10 < 100 ? k.toFixed(1) : Math.round(k).toLocaleString()} kWh`;
};
// $0.14 but 1.20 kr
const inCurrency = (n, cur) => {
  const c = String(cur || '$');
  return /^[a-z]+$/i.test(c) ? `${n} ${c}` : `${c}${n}`;
};
/** "≈ $0.14"; costs come summed by the server (time-of-use plans), never kWh × one price. */
const money = (v, cur) =>
  `≈ ${inCurrency(v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2), cur)}`;
const span = (s) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d
    ? `${d} d ${h} h`
    : h
      ? `${h} h ${m} m`
      : m
        ? `${m} m`
        : `${Math.max(0, Math.round(s))} s`;
};
const answer = (ms) =>
  ms < 1
    ? 'under 1 ms'
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`;
const linkSpeed = (mbps) =>
  !fin(mbps) || mbps <= 0
    ? ''
    : mbps >= 1000
      ? `${Number((mbps / 1000).toFixed(1))} Gbit/s`
      : `${Math.round(mbps)} Mbit/s`;
const cpuName = (m) =>
  String(m || '')
    .replace(/\((R|TM)\)/gi, '')
    .replace(/\s+CPU\s+@.*$/i, '')
    .replace(/\s+with\s+Radeon.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A sparkline, 0 at the bottom; null points are gaps (no sample then).
 * `also` adds more lines ([points, color]) on the same scale, drawn over it.
 */
function spark(points, color, floor, also = []) {
  const clean = (list) =>
    (Array.isArray(list) ? list : []).map((p) => (fin(p) ? Math.max(0, p) : null));
  const series = [[clean(points), color], ...also.map(([p, c]) => [clean(p), c])].filter(
    ([vals]) => vals.filter((v) => v !== null).length > 1,
  );
  if (!series.length) return '';
  const w = 220;
  const h = 40;
  const top = Math.max(
    floor,
    ...series.flatMap(([vals]) => vals.filter((v) => v !== null)).map((v) => v * 1.15),
  );
  const lines = series.flatMap(([vals, c]) => {
    const x = (i) => ((i / (vals.length - 1)) * w).toFixed(1);
    const segs = [];
    let seg = [];
    vals.forEach((v, i) => {
      if (v === null) {
        if (seg.length) segs.push(seg);
        seg = [];
      } else {
        seg.push([x(i), (h - 3 - (v / top) * (h - 6)).toFixed(1)]);
      }
    });
    if (seg.length) segs.push(seg);
    return segs
      .filter((s) => s.length > 1)
      .map((s) => {
        const pts = s.map((p) => p.join(',')).join(' ');
        return `<polyline points="${s[0][0]},${h} ${pts} ${s[s.length - 1][0]},${h}" fill="${c}" opacity="0.08" stroke="none"/><polyline points="${pts}" fill="none" stroke="${c}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
      });
  });
  return `<svg class="nd-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${lines.join('')}</svg>`;
}
const sparkBlock = (svg, day) =>
  svg && day ? `${svg}<div class="nd-axis"><span>24 h ago</span><span>now</span></div>` : svg;
// a tile's sparkline keeps its room while it has fewer than two points
const sparkOrRoom = (svg) =>
  svg || '<svg class="nd-spark" viewBox="0 0 220 40" aria-hidden="true"></svg>';
const ndBar = (value, hot = false, bad = false) =>
  `<div class="nd-bar${bad ? ' bad' : hot ? ' hot' : ''}"><span style="width:${clampPct(value)}%"></span></div>`;
const ndBig = (value, label) =>
  `<div class="nd-big"><b>${value}</b>${label ? `<span class="muted small">${label}</span>` : ''}</div>`;
/** key/value rows; values are HTML already escaped by the caller, rows without a value are left out */
const ndKv = (rows, cls = '') => {
  const r = rows.filter((row) => row && row[1]);
  return r.length
    ? `<dl class="nd-kv${cls}">${r.map(([k, v, hot]) => `<dt>${esc(k)}</dt><dd${hot ? ' class="nd-warn"' : ''}>${v}</dd>`).join('')}</dl>`
    : '';
};
/**
 * A tile's rows, steady while the page is open: a row the tile has shown
 * keeps its place, with '—' (or the row's own placeholder, row[3]), while
 * the server has no value for it or leaves it out for a moment, so the
 * page does not jump with every poll. `seen` (the caller's, kept between
 * polls) maps a tile to the rows it has shown, in order; rows that never
 * had a value are left out as before. A label that comes twice (two NVMe
 * drives are both "NVMe") is two rows, told apart by their order.
 */
function steady(seen, tile, rows) {
  const list = rows.filter((row) => row && row[0]);
  if (!seen) return list;
  // "2:NVMe" is the second row called NVMe
  const times = new Map();
  const keyed = list.map((row) => {
    times.set(row[0], (times.get(row[0]) || 0) + 1);
    return [`${times.get(row[0])}:${row[0]}`, row];
  });
  const order = [...(seen.get(tile) || [])];
  let at = -1;
  for (const [key, row] of keyed) {
    const i = order.indexOf(key);
    if (i >= 0) at = i;
    else if (row[1]) order.splice(++at, 0, key);
  }
  seen.set(tile, order);
  const now = new Map(keyed);
  return order.map((key) => {
    const row = now.get(key);
    return row && row[1] ? row : [key.slice(key.indexOf(':') + 1), row?.[3] ?? '—'];
  });
}
const ndTile = (title, sub, body, wide = false) =>
  `<div class="nd-tile${wide ? ' nd-wide' : ''}"><div class="nd-title"><span>${esc(title)}</span>${sub ? `<span class="muted" title="${esc(sub)}">${esc(sub)}</span>` : ''}</div>${body}</div>`;
const moreButton = (key, shown, total, open) =>
  total > shown || open
    ? `<button type="button" class="nd-more" data-nd-more="${key}">${open ? 'Show fewer' : `Show all ${total}`}</button>`
    : '';

function cpuTile(cpu, points, day, seen = null) {
  if (!cpu || !fin(cpu.usage)) return '';
  const counts = fin(cpu.cores)
    ? fin(cpu.threads) && cpu.threads !== cpu.cores
      ? `${cpu.cores} cores / ${cpu.threads} threads`
      : plural(cpu.cores, 'core')
    : '';
  const per = (Array.isArray(cpu.perCore) ? cpu.perCore : []).filter(fin);
  // one bar per thread; big machines get rows of 16 (or 32) thinner bars
  const cols = per.length <= 16 ? per.length : per.length <= 64 ? 16 : 32;
  const cores =
    per.length > 1
      ? `<div class="nd-cores${per.length > 16 ? ' dense' : ''}" style="--cols:${cols}">${per.map((c, i) => `<i style="--v:${clampPct(c)}%" title="CPU ${i}: ${pct(c)}"></i>`).join('')}</div>`
      : '';
  const app = cpu.app || {};
  const appText = fin(app.usage)
    ? `${pct(app.usage)}${app.ffmpegCount > 0 && fin(app.ffmpegUsage) ? ` (ffmpeg ×${app.ffmpegCount}: ${pct(app.ffmpegUsage)})` : ''}`
    : '';
  // two or more sockets: "2 × <model>" (the counts are totals) and a short line per socket
  const multi = fin(cpu.sockets) && cpu.sockets > 1;
  const name = multi
    ? cpuName(cpu.model)
      ? `${cpu.sockets} × ${cpuName(cpu.model)}`
      : `${cpu.sockets} CPUs`
    : cpuName(cpu.model);
  const socketLines = (multi && Array.isArray(cpu.perSocket) ? cpu.perSocket : [])
    .map((s, i) => {
      if (!s) return '';
      const bits = [
        fin(s.usage) && pct(s.usage),
        fin(s.tempC) &&
          (s.tempC >= 90 ? `<span class="nd-warn">${temp(s.tempC)}</span>` : temp(s.tempC)),
        fin(s.powerW) && watts(s.powerW),
      ].filter(Boolean);
      const own = fin(s.cores)
        ? fin(s.threads) && s.threads !== s.cores
          ? `${s.cores} cores / ${s.threads} threads`
          : plural(s.cores, 'core')
        : '';
      // numbered from 1 by the kernel's physical id, as the Sensors tile names the packages
      const n =
        Number.isInteger(s.socket) && s.socket >= 0 && s.socket < 1024 ? s.socket + 1 : i + 1;
      return bits.length
        ? `<div${own ? ` title="${esc(own)}"` : ''}><span>CPU ${n}</span>${bits.map((b) => `<span>${b}</span>`).join('')}</div>`
        : '';
    })
    .join('');
  return ndTile(
    'CPU',
    [name, counts].filter(Boolean).join(' · '),
    ndBig(pct(cpu.usage), 'whole server') +
      sparkBlock(sparkOrRoom(spark(points, 'var(--accent)', 10)), day) +
      cores +
      (socketLines ? `<div class="nd-sockets">${socketLines}</div>` : '') +
      ndKv(
        steady(seen, 'cpu', [
          ['Clock', fin(cpu.freqMHz) ? clock(cpu.freqMHz) : ''],
          ['Temp', fin(cpu.tempC) ? temp(cpu.tempC) : '', cpu.tempC >= 90],
          [
            'Load',
            Array.isArray(cpu.load) && cpu.load.some(fin)
              ? cpu.load.map((l) => (fin(l) ? l.toFixed(1) : '—')).join(' · ')
              : '',
          ],
          ['This app', appText],
          ['Throttling', cpu.throttling ? 'yes: too hot, running slower' : '', true, 'no'],
        ]),
      ),
  );
}

// these drivers report the video engine and render use whenever this app
// has a client open; their rows stay in place (with '—') in between
const VIDEO_VENDORS = new Set(['amd', 'intel', 'nvidia']);
const reportsVideo = (g) => Boolean(g) && VIDEO_VENDORS.has(g.vendor);
// AMD and NVIDIA drivers report the whole GPU's use (anything on the server,
// not only conversions): their tile leads with it, 0 % when idle. Intel only
// tells this app's own share, so its tile leads with the video engine.
const OVERALL_VENDORS = new Set(['amd', 'nvidia']);
const reportsOverall = (g) => Boolean(g) && OVERALL_VENDORS.has(g.vendor);
// what a GPU's tile needs to be drawn again while a sample leaves it out
const GPU_NAMES = ['id', 'name', 'vendor', 'driver', 'node', 'vramTotalB', 'integrated'];

// (`g.held`: a GPU the page has shown that this sample left out, drawn with '—')
function gpuTile(g, points, day, seen = null, key = 'gpu') {
  const steadyRows = reportsVideo(g);
  if (
    !g ||
    (!steadyRows &&
      !g.held &&
      !['busy', 'video', 'vramUsedB', 'clockMHz', 'tempC', 'powerW'].some((k) => fin(g[k])))
  )
    return '';
  const dash = (n) => (fin(n) ? pct(n) : '—');
  const big = reportsOverall(g)
    ? ndBig(fin(g.busy) ? pct(g.busy) : g.held ? '—' : '0%', 'in use')
    : steadyRows
      ? ndBig(dash(g.video), 'video engine')
      : fin(g.video)
        ? ndBig(pct(g.video), 'video engine')
        : fin(g.busy)
          ? ndBig(pct(g.busy), 'busy')
          : g.held
            ? ndBig('—', 'busy')
            : '';
  const vram = fin(g.vramTotalB) && g.vramTotalB > 0;
  const rows = [
    (steadyRows || fin(g.busy)) &&
      `<div><span>Render / 3D</span>${ndBar(g.busy, g.busy >= 90)}<b>${dash(g.busy)}</b></div>`,
    (steadyRows || fin(g.video)) &&
      `<div><span>Video</span>${ndBar(g.video, g.video >= 90)}<b>${dash(g.video)}</b></div>`,
    vram &&
      `<div><span>VRAM</span>${ndBar(fin(g.vramUsedB) ? (g.vramUsedB / g.vramTotalB) * 100 : 0)}<b>${fin(g.vramUsedB) ? sizeOf(g.vramUsedB, g.vramTotalB, ' / ') : '—'}</b></div>`,
  ].filter(Boolean);
  return ndTile(
    'GPU',
    [g.name, g.driver, g.node].filter(Boolean).join(' · '),
    big +
      sparkBlock(points ? sparkOrRoom(spark(points, 'var(--info)', 10)) : '', day) +
      (rows.length ? `<div class="nd-rows">${rows.join('')}</div>` : '') +
      ndKv(
        steady(seen, key, [
          ['Clock', fin(g.clockMHz) ? clock(g.clockMHz) : ''],
          ['Temp', fin(g.tempC) ? temp(g.tempC) : '', g.tempC >= 90],
          // a built-in GPU's reading is the whole chip's, CPU included
          [
            'Power',
            fin(g.powerW) ? `${watts(g.powerW)}${g.integrated ? ' · whole chip' : ''}` : '',
          ],
          [
            'Clients',
            g.clients > 0 ? `${g.clients} × ffmpeg` : '',
            false,
            g.clients === 0 ? 'none' : '—',
          ],
        ]),
      ),
  );
}

/**
 * Nodes' power with this server's (/api/stats power.combined and
 * power.nodes): the total of every server that reports, then a line per
 * server with its CPU and GPU watts. '' with no nodes.
 */
function serversPower(p, energy) {
  const c = p?.combined;
  if (!c || !Array.isArray(p.nodes) || !p.nodes.length) return '';
  const split = (cpu, gpu) =>
    [fin(cpu) && `CPU ${Math.round(cpu)}`, fin(gpu) && `GPU ${Math.round(gpu)}`]
      .filter(Boolean)
      .join(' · ');
  const line = (total, cpu, gpu, na) =>
    esc(
      [fin(total) ? watts(total) : '', split(cpu, gpu)].filter(Boolean).join(' · ') ||
        'not measured',
    );
  const rows = [['This server', line(p.totalW, p.cpuW, p.gpuW, p.cpuUnavailable)]];
  for (const n of p.nodes)
    rows.push([
      n.name,
      !n.online
        ? '<span class="muted">offline</span>'
        : fin(n.totalW) || CPU_NA_SHORT[n.cpuUnavailable]
          ? line(n.totalW, n.cpuW, n.gpuW, n.cpuUnavailable)
          : '<span class="muted">unknown</span>',
    ]);
  const reporting =
    fin(c.reporting) && fin(c.servers) && c.reporting < c.servers
      ? ` (${c.reporting} of ${c.servers} reporting)`
      : ` (${plural(c.servers || p.nodes.length + 1, 'server')})`;
  return (
    `<div class="nd-servers">${ndBig(fin(c.totalW) ? watts(c.totalW) : '—', esc(`all servers${reporting}`))}` +
    ndKv(
      [
        ...rows,
        ['All servers today', energy(c.todayWh, c.todayCost)],
        ['All servers this week', energy(c.weekWh, c.weekCost)],
      ],
      ' nd-kv-servers',
    ) +
    '</div>'
  );
}

// why a server's CPU watts are missing (/api/stats power.cpuUnavailable)
const CPU_NA = {
  windows:
    "CPU watts aren't available on Docker Desktop for Windows (Windows doesn't share them with Docker). NVIDIA GPU watts show when the card reports them.",
  vm: "CPU watts aren't available inside a virtual machine.",
};
const CPU_NA_SHORT = { windows: 'CPU n/a (Windows)', vm: 'CPU n/a (VM)' };

function powerTile(p, enc, price, currency, seen = null) {
  if (!p) return '';
  // A built-in GPU (an APU such as the Ryzen 8700G's 780M) is part of the
  // CPU chip: its reading and the CPU package's are the same power, so the
  // chip is one figure, and only other GPUs are added to it. Once shown,
  // it stays one figure while a sample has no reading.
  if (fin(p.chipW) && seen) seen.set('power-whole-chip', true);
  const chip = fin(p.chipW) || Boolean(seen?.get('power-whole-chip'));
  const partW = chip
    ? { 'Whole chip': p.chipW, GPU: p.discreteW }
    : { 'CPU package': p.cpuW, GPU: p.gpuW };
  const parts = Object.entries(partW).filter(([, w]) => fin(w));
  // a part seen before keeps its bar while its reading is missing for a moment
  const bars = steady(
    seen,
    chip ? 'power-chip' : 'power-parts',
    Object.entries(partW).map(([name, w]) => [name, fin(w) ? watts(w) : '']),
  ).filter((row) => row[1]);
  const total = fin(p.totalW)
    ? p.totalW
    : parts.length
      ? parts.reduce((n, [, w]) => n + w, 0)
      : null;
  // no power reading at all (and nothing measured earlier this week): no tile
  const energy = (wh, c) =>
    fin(wh) ? esc(`${energyText(wh)}${fin(c) ? ` · ${money(c, currency)}` : ''}`) : '';
  // with nodes: every server's power together first, then this server's own
  const all = serversPower(p, energy);
  const why = CPU_NA[p.cpuUnavailable] || '';
  if (
    !all &&
    !why &&
    !fin(total) &&
    !p.cpuSource &&
    !p.gpuSource &&
    !(p.todayWh > 0) &&
    !(p.weekWh > 0)
  )
    return '';
  const label = chip
    ? fin(p.discreteW) || bars.length === 2
      ? 'whole chip + GPU'
      : 'whole chip (CPU + built-in GPU)'
    : parts.length === 2
      ? 'CPU + GPU'
      : parts.length
        ? parts[0][0] === 'GPU'
          ? 'GPU (CPU not measured)'
          : 'CPU package'
        : '';
  const priceNow = fin(price?.now)
    ? `${esc(inCurrency(price.now.toFixed(price.now < 1 ? 3 : 2).replace(/(\.\d\d)0$/, '$1'), price.currency || currency))} per kWh${price.rate ? ` · ${esc(price.rate)}` : ''}`
    : '';
  return ndTile(
    'Power',
    'measured, not estimated',
    all +
      (fin(total)
        ? ndBig(watts(total), all ? `this server · ${label}` : label)
        : bars.length
          ? ndBig('—', all ? `this server · ${label}` : label)
          : '') +
      (bars.length
        ? `<div class="nd-rows">${bars.map(([name, text]) => `<div><span>${name}</span>${ndBar(fin(partW[name]) && total > 0 ? (partW[name] / total) * 100 : 0)}<b>${text}</b></div>`).join('')}</div>`
        : '') +
      ndKv(
        steady(seen, 'power', [
          ['Today', energy(p.todayWh, p.todayCost)],
          ['This week', energy(p.weekWh, p.weekCost)],
          [
            'Converting',
            enc?.running && fin(enc.run?.wh)
              ? `${energyText(enc.run.wh)} this run${enc.run.nodeWh > 0 ? ` (${energyText(enc.run.nodeWh)} on nodes)` : ''}`
              : '',
          ],
          ['Price now', priceNow],
        ]),
      ) +
      (why ? `<p class="muted small nd-note">${esc(why)}</p>` : ''),
  );
}

function memoryTile(m, seen = null) {
  if (!m || !fin(m.totalB) || !fin(m.usedB) || m.totalB <= 0) return '';
  const used = (m.usedB / m.totalB) * 100;
  return ndTile(
    'Memory',
    size(m.totalB),
    ndBig(size(m.usedB), `used (${pct(used)})`) +
      ndBar(used, used >= 95) +
      ndKv(
        steady(seen, 'memory', [
          ['This app', fin(m.appB) ? size(m.appB) : ''],
          ['Cache', fin(m.cacheB) ? size(m.cacheB) : ''],
          [
            'Swap',
            fin(m.swapTotalB)
              ? m.swapTotalB > 0
                ? sizeOf(m.swapUsedB || 0, m.swapTotalB, ' / ')
                : 'none'
              : '',
          ],
        ]),
      ),
  );
}

const DISK_KIND = { nvme: 'NVMe', ssd: 'SSD', hdd: 'hard disk' };
// the temperatures the server's alerts use
const diskHot = (d) => fin(d.tempC) && d.tempC >= (d.kind === 'hdd' ? 55 : 70);
const DISKS_SHOWN = 8;

// how long ago, by the server's clock (`at`, the sample's time)
const sinceText = (ts, at) =>
  ts > 0 ? (at - ts < 1000 ? 'just now' : `${span((at - ts) / 1000)} ago`) : '';

function storageTile(fss, disks, all, at = Date.now()) {
  const rows = [];
  for (const f of Array.isArray(fss) ? fss : []) {
    if (!f) continue;
    const known = fin(f.totalB) && f.totalB > 0 && fin(f.usedB);
    const used = known ? (f.usedB / f.totalB) * 100 : 0;
    const bits = [known ? sizeOf(f.usedB, f.totalB) : ''];
    const down = f.mounted === false || f.reachable === false;
    // a share that is not mounted: its folder is on this server's disk, not the share
    if (f.mounted === false) bits.push('<span class="nd-bad">not connected</span>');
    else if (f.reachable === false) bits.push('<span class="nd-bad">not reachable</span>');
    else if (fin(f.latencyMs))
      bits.push(
        f.latencyMs > 2000
          ? `<span class="nd-warn">answers in ${answer(f.latencyMs)}</span>`
          : `answers in ${answer(f.latencyMs)}`,
      );
    if (down && f.answeredAt > 0) bits.push(`last answered ${sinceText(f.answeredAt, at)}`);
    // the heartbeat: when it was last checked, and how often
    const beat = [
      f.checkedAt > 0 && `checked ${sinceText(f.checkedAt, at)}`,
      fin(f.checkEveryMs) && f.checkEveryMs > 0 && `every ${span(f.checkEveryMs / 1000)}`,
    ]
      .filter(Boolean)
      .join(' · ');
    rows.push(
      `<div class="nd-disk"><div><b>${esc(f.label || f.path)}</b><span class="muted small">${esc(f.path || '')}</span></div>${known ? ndBar(used, used >= 90) : ''}<span class="small">${bits.filter(Boolean).join(' · ')}</span>${beat ? `<span class="small muted nd-beat">${esc(beat)}</span>` : ''}</div>`,
    );
  }
  const list = (Array.isArray(disks) ? disks : []).filter((d) => d && d.name);
  for (const d of all ? list : list.slice(0, DISKS_SHOWN)) {
    const bits = [`read ${rate(d.readBps)}`, `write ${rate(d.writeBps)}`];
    if (fin(d.tempC))
      bits.push(diskHot(d) ? `<span class="nd-warn">${temp(d.tempC)}</span>` : temp(d.tempC));
    rows.push(
      `<div class="nd-disk"><div><b>${esc(d.name)}</b><span class="muted small">${esc([d.model, DISK_KIND[d.kind]].filter(Boolean).join(' · '))}</span></div><span class="small">${bits.join(' · ')}</span></div>`,
    );
  }
  if (!rows.length) return '';
  return ndTile(
    'Storage',
    'disks and shares',
    `<div class="nd-disks">${rows.join('')}</div>${moreButton('disks', DISKS_SHOWN, list.length, all)}`,
    true,
  );
}

// download in blue, upload in purple, on one scale
function networkTile(net, points, day) {
  const ifs = (Array.isArray(net?.interfaces) ? net.interfaces : []).filter(
    (i) => i && (fin(i.rxBps) || fin(i.txBps)),
  );
  if (!ifs.length) return '';
  const sum = (k) => ifs.reduce((n, i) => n + (fin(i[k]) ? i[k] : 0), 0);
  const one = ifs.length === 1 ? ifs[0] : null;
  return ndTile(
    'Network',
    one
      ? [one.name, linkSpeed(one.speedMbps)].filter(Boolean).join(' · ')
      : `${ifs.length} interfaces`,
    ndBig(
      `<span class="nd-down">↓</span> ${rate(sum('rxBps'))}`,
      `<span class="nd-up">↑ ${rate(sum('txBps'))}</span>`,
    ) +
      sparkBlock(
        spark(points?.rx, 'var(--info)', 64 * 1024, [[points?.tx, 'var(--upload)']]),
        day,
      ) +
      ndKv(
        one
          ? []
          : ifs.map((i) => [
              [i.name, linkSpeed(i.speedMbps)].filter(Boolean).join(' · '),
              `↓ ${rate(i.rxBps)} · ↑ ${rate(i.txBps)}`,
            ]),
      ) +
      // a list of its own, so long interface names never narrow its values;
      // the data used is always shown (0 B too) so the tile keeps its height
      // between polls, and a narrow tile wraps it at the dot only
      ndKv([
        ['Counted for', net.scope === 'host' ? 'the whole server' : 'this container'],
        ...[
          ['Today', net.today],
          ['This week', net.week],
          ['This month', net.month],
        ].map(([k, u]) => [
          k,
          [
            ['↓', u?.rxB],
            ['↑', u?.txB],
          ]
            .map(([arrow, b]) => `${arrow} ${size(b)}`.replace(/ /g, '\u00a0'))
            .join(' · '),
        ]),
      ]),
  );
}

// hwmon names, in words (anything else shows as the server reports it);
// with several CPU sockets the packages go by the CPU tile's numbers
function sensorName(s, multiSocket = false) {
  const chip = String(s.chip || '');
  const label = String(s.label || '');
  let m;
  if (chip === 'coretemp' && (m = /^Package id (\d+)$/.exec(label))) {
    if (multiSocket) return `CPU ${Number(m[1]) + 1} package`;
    return m[1] === '0' ? 'CPU package' : `CPU package ${m[1]}`;
  }
  if (chip === 'k10temp' && /^T(ctl|die)$/.test(label)) return `CPU (${label})`;
  if (chip === 'k10temp' && (m = /^Tccd(\d+)$/.exec(label))) return `CPU die ${m[1]}`;
  if (/^cpu[-_]thermal$/.test(chip) || /^cpu[-_]thermal$/.test(label)) return 'CPU';
  if (chip === 'nvme')
    return label === 'Composite' || !label ? 'NVMe' : `NVMe ${label.toLowerCase()}`;
  if (/^(amdgpu|i915|xe|nouveau|radeon)$/.test(chip)) {
    if (s.kind === 'fan') return 'GPU fan';
    return (
      { edge: 'GPU', pkg: 'GPU', junction: 'GPU hotspot', mem: 'GPU memory', vram: 'GPU memory' }[
        label
      ] || `GPU ${label}`
    );
  }
  if ((m = /^fan(\d+)$/.exec(label))) return `Fan ${m[1]}`;
  if ((m = /^temp(\d+)$/.exec(label))) return `${chip} ${m[1]}`;
  return label || chip || 'Sensor';
}
const sensorHot = (s, name) =>
  s.kind === 'temp' &&
  s.value >=
    (s.chip === 'drivetemp' ? 55 : s.chip === 'nvme' ? 70 : /^(CPU|GPU)/.test(name) ? 90 : 85);
const SENSORS_SHOWN = 10;

function sensorsTile(sensors, all, sockets = 1, seen = null) {
  const rows = [];
  const coreMax = new Map(); // "Core 0" … "Core 11" of a chip: one "Core max" row
  // the packages go by the CPU tile's numbers when there is one per socket
  // (a CPU with several dies per socket has more: they keep their numbers)
  const packages = new Set(
    (Array.isArray(sensors) ? sensors : [])
      .filter((s) => s && s.chip === 'coretemp' && /^Package id \d+$/.test(s.label || ''))
      .map((s) => s.label),
  );
  const multiSocket = packages.size > 1 && packages.size === sockets;
  for (const s of Array.isArray(sensors) ? sensors : []) {
    if (!s) continue;
    // a sensor without a reading this time keeps its row once it has shown one
    if (!fin(s.value)) {
      if (!(s.kind === 'temp' && /^Core \d+$/.test(s.label || '')))
        rows.push({ ...s, name: sensorName(s, multiSocket), value: null });
      continue;
    }
    if (s.kind === 'temp' && /^Core \d+$/.test(s.label || '')) {
      const row = coreMax.get(s.chip);
      if (row) row.value = Math.max(row.value, s.value);
      else {
        const fresh = { name: 'Core max', kind: 'temp', chip: s.chip, value: s.value };
        coreMax.set(s.chip, fresh);
        rows.push(fresh);
      }
      continue;
    }
    rows.push({ ...s, name: sensorName(s, multiSocket) });
  }
  const list = steady(
    seen,
    'sensors',
    rows.map((s) => [
      s.name,
      !fin(s.value)
        ? ''
        : s.kind === 'fan'
          ? `${Math.round(s.value).toLocaleString()} rpm`
          : temp(s.value),
      fin(s.value) && sensorHot(s, s.name),
    ]),
  ).filter((row) => row[1]);
  if (!list.length) return '';
  const shown = all ? list : list.slice(0, SENSORS_SHOWN);
  return ndTile(
    'Sensors',
    'every one the server reports',
    ndKv(shown, ' nd-sensors') + moreButton('sensors', SENSORS_SHOWN, list.length, all),
  );
}

// the server sends its 8 busiest; the table keeps room for 8 rows
const PROCESS_ROWS = 8;

function processTile(procs, enc, hasGpu = false, seen = null) {
  const top = (Array.isArray(procs?.top) ? procs.top : []).filter((p) => p && p.name);
  if (!top.length) return '';
  // the same program several times (ffmpeg ×4) is one row
  const groups = new Map();
  for (const p of top) {
    const g = groups.get(p.name) || { name: p.name, n: 0, cpu: 0, memB: 0, gpu: null };
    g.n++;
    g.cpu += fin(p.cpu) ? p.cpu : 0;
    g.memB += fin(p.memB) ? p.memB : 0;
    if (fin(p.gpuVideo)) g.gpu = (g.gpu || 0) + p.gpuVideo;
    groups.set(p.name, g);
  }
  // Busy programs come first, by bands of 5 %; inside a band the rows keep
  // their places from the last poll (`seen`), so the list does not reshuffle
  // while most programs sit near 0 %. A row changes band only once it is a
  // point past the band's edge.
  const before = seen?.get('procs') || new Map(); // name -> { band, at }
  const bandOf = (g) => {
    const was = before.get(g.name)?.band;
    if (was !== undefined && g.cpu >= was * 5 - 1 && g.cpu < (was + 1) * 5 + 1) return was;
    return Math.floor(g.cpu / 5);
  };
  const rows = [...groups.values()]
    .map((g) => ({ ...g, band: bandOf(g), at: before.get(g.name)?.at ?? Infinity }))
    .sort((a, b) => b.band - a.band || a.at - b.at || b.cpu - a.cpu || b.memB - a.memB);
  if (seen) seen.set('procs', new Map(rows.map((r, i) => [r.name, { band: r.band, at: i }])));
  // with a GPU, its column stays while no process uses it
  const gpuCol = hasGpu || rows.some((r) => r.gpu !== null);
  // rows come and go (ffprobe, a mount): empty ones keep the table's height;
  // past PROCESS_ROWS the list scrolls inside the tile
  const pad =
    `<tr class="nd-pad" aria-hidden="true"><td>&nbsp;</td><td></td><td></td>${gpuCol ? '<td></td>' : ''}</tr>`.repeat(
      Math.max(0, PROCESS_ROWS - rows.length),
    );
  // The server names an ffmpeg that encodes by its encoder (ffmpeg ·
  // hevc_vaapi); the others (checks, probes, thumbnails) stay "ffmpeg".
  // One line each, so a row is as tall with ffmpeg ×3 as with one ffmpeg:
  // a long name ends in … before its count (its title has it all)
  const name = (r) => r.name;
  const nameCell = (r) =>
    `<td title="${esc(`${name(r)}${r.n > 1 ? ` ×${r.n}` : ''}`)}"><span class="nd-pname"><span>${esc(name(r))}</span>${r.n > 1 ? `<span>×${r.n}</span>` : ''}</span></td>`;
  return ndTile(
    'Top processes',
    procs.scope === 'host' ? 'whole server' : 'this container',
    `<div class="nd-procs-box" tabindex="0" aria-label="Processes, ${rows.length > PROCESS_ROWS ? 'scroll for more' : 'all shown'}"><table class="nd-procs"><thead><tr><th>Process</th><th>CPU</th><th>Memory</th>${gpuCol ? '<th>GPU</th>' : ''}</tr></thead><tbody>${rows.map((r) => `<tr>${nameCell(r)}<td>${pct(r.cpu)}</td><td>${size(r.memB)}</td>${gpuCol ? `<td>${r.gpu !== null ? `${pct(r.gpu)} video` : '—'}</td>` : ''}</tr>`).join('')}${pad}</tbody></table></div>`,
    true,
  );
}

function hostLine(h) {
  if (!h) return '';
  return [
    h.hostname,
    h.os,
    h.kernel && `kernel ${h.kernel}`,
    fin(h.uptimeS) && `up ${span(h.uptimeS)}`,
    fin(h.appUptimeS) && `app up ${span(h.appUptimeS)}`,
    h.version && (/^Build \d/.test(h.version) ? h.version : `version ${h.version}`),
  ]
    .filter(Boolean)
    .map((part) => `<span class="nd-nb">${esc(part)}</span>`)
    .join(' · ');
}

function alertChip(alerts) {
  const n = Array.isArray(alerts) ? alerts.length : 0;
  if (!n) return '';
  const bad = alerts.some((a) => a.level === 'error');
  return `<span class="chip ${bad ? 'red' : 'amber'}"><span class="cdot"></span>${bad ? plural(n, 'problem') : plural(n, 'warning')}</span>`;
}

/**
 * The top of the Server section: the selected vehicle's last discovered
 * inventory and the free space last observed on its share, in two tiles
 * with their buttons. Drawn with the page (not with every poll), so they
 * show with Nerd stats off too; each keeps its rows, so a live update does
 * not change its height. Only a share with a problem gets a chip.
 */
/** Space saved by conversions (a vehicle's `saved`, or all of theirs together). */
const savedTotal = (list) =>
  list.reduce(
    (t, v) => ({ bytes: t.bytes + (v.saved?.bytes || 0), clips: t.clips + (v.saved?.clips || 0) }),
    { bytes: 0, clips: 0 },
  );
const savedText = (sv) =>
  sv?.bytes > 0 ? `${size(sv.bytes)} · ${plural(sv.clips, 'clip')}` : 'none yet';

function fullInText(st) {
  if (!st || !fin(st.free)) return '—';
  if (st.capped) return 'never <span class="muted small">policies delete old footage</span>';
  const d = st.daysLeft;
  if (!fin(d)) return '— <span class="muted small">no new footage lately</span>';
  const t =
    d < 1
      ? 'under a day'
      : d < 60
        ? `${d} day${d === 1 ? '' : 's'}`
        : d < 730
          ? `${Math.round(d / 30.4)} months`
          : `${Math.round(d / 365)} years`;
  const tone = d < 7 ? 'red' : d < 30 ? 'amber' : '';
  return `${tone ? `<span class="chip ${tone}">${t}</span>` : t} <span class="muted small">at ${size(st.perDay)} a day</span>`;
}
function vehicleTiles(v, at = Date.now(), all = [v], allDays = null) {
  if (!v) {
    return `<div class="nd-grid nd-vgrid">${ndTile('Vehicles', 'none yet', '<p class="nd-note">Each vehicle has its own footage share (SMB) or folder. Add one in Settings to start.</p><div class="nd-actions"><a class="btn sm solid" href="#/settings">Open settings</a></div>')}</div>`;
  }
  const s = v.share || {};
  const inv = v.inventory;
  const known = fin(s.totalBytes) && s.totalBytes > 0 && fin(s.freeBytes);
  const used = known ? (1 - s.freeBytes / s.totalBytes) * 100 : null;
  const problem = !s.healthy
    ? '<span class="chip red">Share unavailable</span>'
    : s.writable === false
      ? '<span class="chip amber">Read-only share</span>'
      : '';
  const scanned = v.scanning ? 'scanning…' : inv ? sinceText(inv.scannedAt, at) || '—' : 'not yet';
  const inventory = ndTile(
    'Inventory',
    'last discovered',
    ndBig(inv && fin(inv.bytes) ? size(inv.bytes) : '—', 'all categories') +
      ndKv([
        ['Recordings', inv ? Number(inv.recordings || 0).toLocaleString() : '—'],
        ['Space saved', savedText(v.saved)],
        ...(all.length > 1 ? [['All vehicles saved', savedText(savedTotal(all))]] : []),
        // days with any footage, and since when
        [
          'Days of footage',
          inv && fin(inv.days)
            ? `${inv.days.toLocaleString()}${inv.firstDay ? ` <span class="muted small">since ${esc(new Date(`${inv.firstDay}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))}</span>` : ''}`
            : '—',
        ],
        ...(all.length > 1 && fin(allDays)
          ? [['All vehicles, days', allDays.toLocaleString()]]
          : []),
        ['Scanned', esc(scanned)],
        ['Time zone', esc(v.timezone || '—')],
      ]) +
      // saved by converting, month by month (web/savingsChart.js fills it)
      `<div data-savings-chart="${esc(v.id)}" style="margin-top:12px"></div>` +
      '<div class="nd-actions"><button type="button" class="btn sm" id="refresh-inv">Refresh inventory</button></div>',
  );
  const free = ndTile(
    'Free space',
    `last observed on ${v.name}`,
    `<div class="nd-big"><b>${fin(s.freeBytes) ? size(s.freeBytes) : '—'}</b><span class="muted small">free</span>${problem}</div>` +
      // (no capacity known: an empty meter keeps the tile's height)
      ndBar(used ?? 0, used > 85, used > 95) +
      ndKv([
        ['Capacity', known ? size(s.totalBytes) : 'unknown'],
        ['Used', known ? pct(used) : '—'],
        ['Recycle Bin', fin(v.binBytes) && v.binBytes > 0 ? size(v.binBytes) : 'empty'],
        // days until full at the footage added lately (as web/fullIn.js words it)
        ['Full in', fullInText(v.storage)],
      ]) +
      `<div class="nd-actions"><a class="btn sm" href="#/settings/vehicle/${esc(v.id)}">Vehicle settings</a></div>`,
  );
  return `<div class="nd-grid nd-vgrid">${inventory}${free}</div>`;
}

/** Everything under the section's head: alerts, tiles, and what optional compose lines would add. */
/**
 * `seen` (optional, kept by the caller while the page is open) keeps rows
 * that come and go in place; see steady().
 */
function serverBody(
  s,
  { range = '15m', hist = null, currency = '$', more = {}, seen = null } = {},
) {
  const day = range === '24h' && hist?.series ? hist.series : null;
  const usable = (pts) => Array.isArray(pts) && pts.filter(fin).length > 1;
  const pts = {
    cpu: day ? day.cpu : s.sparks?.cpu,
    gpu: day ? (usable(day.gpuVideo) ? day.gpuVideo : day.gpuBusy) : s.sparks?.gpuVideo,
    gpuBusy: day ? day.gpuBusy : s.sparks?.gpuBusy,
    rx: day ? day.rxBps : s.sparks?.rxBps,
    tx: day ? day.txBps : s.sparks?.txBps,
  };
  // A GPU the page has shown keeps its tile, in its place, while a sample
  // leaves it out (its reading failed for a moment), so the tiles after it
  // stay put. `seen` holds their names (no numbers) by key.
  const sampled = (Array.isArray(s.gpus) ? s.gpus : []).filter(Boolean);
  const gpuKey = (g, i) => `gpu:${g.id || g.node || i}`;
  const shown = seen ? seen.get('gpus') || new Map() : null;
  const here = new Map(sampled.map((g, i) => [gpuKey(g, i), g]));
  const list = shown
    ? [
        ...[...shown].map(([k, g]) => [k, here.get(k) || { ...g, held: true }]),
        ...[...here].filter(([k]) => !shown.has(k)),
      ]
    : [...here];
  // one sparkline series for the GPUs: on the first that can report its
  // video engine (it stays there while the engine's use is unknown), else
  // on the first that encodes
  const sparkOn =
    list.map(([, g]) => g).find(reportsVideo) ||
    list.map(([, g]) => g).find((g) => fin(g.video)) ||
    null;
  const gpus = list
    .map(([k, g]) => {
      // the sparkline follows the tile's big number: whole-GPU use or the video engine
      const html = gpuTile(
        g,
        g === sparkOn ? (reportsOverall(g) ? pts.gpuBusy : pts.gpu) : null,
        Boolean(day),
        seen,
        k,
      );
      if (html && shown && !g.held)
        shown.set(
          k,
          Object.fromEntries(GPU_NAMES.filter((n) => g[n] !== undefined).map((n) => [n, g[n]])),
        );
      return html;
    })
    .join('');
  if (shown) seen.set('gpus', shown);
  const tiles = [
    cpuTile(s.cpu, pts.cpu, Boolean(day), seen),
    gpus,
    powerTile(s.power, s.encoder, s.price, currency, seen),
    memoryTile(s.memory, seen),
    storageTile(s.filesystems, s.disks, more.disks, fin(s.at) ? s.at : Date.now()),
    networkTile(s.network, { rx: pts.rx, tx: pts.tx }, Boolean(day)),
    sensorsTile(s.sensors, more.sensors, Number(s.cpu?.sockets) || 1, seen),
    processTile(s.processes, s.encoder, list.length > 0, seen),
  ].join('');
  // (Logs: the last tile of the same section)
  const alerts = (Array.isArray(s.alerts) ? s.alerts : [])
    .filter((a) => a && a.message)
    .map(
      (a) =>
        `<div class="nd-alert${a.level === 'error' ? ' bad' : ''}"><b>${a.level === 'error' ? 'Problem' : 'Warning'}</b>${esc(unitText(a.message))} · <a href="#/health/logs">Logs</a></div>`,
    )
    .join('');
  const unlock = (Array.isArray(s.unlock) ? s.unlock : []).filter((u) => u && u.adds);
  const foot = unlock.length
    ? `<p>Shown only when the server provides it. More with one optional line each in <code>docker-compose.yml</code>:</p>
        <ul>${unlock.map((u) => `<li>${esc(u.adds)}${u.compose ? `: <code>${esc(u.compose)}</code>` : ''}</li>`).join('')}</ul><p>Every number stays on this server.</p>`
    : '<p>Shown only when the server provides it. Every number stays on this server.</p>';
  return `${alerts}${tiles ? `<div class="nd-grid">${tiles}</div>` : '<p class="muted nd-none">The server has no numbers to show here.</p>'}<div class="muted small nd-foot">${foot}</div>`;
}

export { serverBody, hostLine };
