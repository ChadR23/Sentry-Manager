// The Sentry USB tab, the same in every interface: what each car's Sentry USB
// (the Pi in the car) last wrote to its archive share, in its info file
// .sentryusb/device-status.json (docs/sentry-usb.md, "The Sentry USB tab";
// read by server/sentryUsb.js and server/sentryUsbDevice.js). No pairing and
// no link: the version, the Pi's storage (space used and left), the car's
// drives, the CPU temperature and the Car card, as of when the Pi wrote it.
// Read-only, for every signed-in account.
//
//   const page = createSentryUsbPage(el, { h24: () => bool });
//   page.destroy();

import '/web/units.js';

// the one unit choice (web/units.js): miles shows °F and psi, kilometres °C and bar
const UNITS = globalThis.SentryUnits;
const STALE_S = 24 * 3600; // older than this: "not heard from since"
const REFRESH_MS = 60_000;

const CSS = `
.sentry-sul{display:flex;flex-direction:column;gap:20px;font-size:14px;line-height:1.45;min-width:0}
.sentry-sul section{display:flex;flex-direction:column;gap:8px;min-width:0}
.sentry-sul h2{margin:0;font-size:17px}
.sentry-sul h3{margin:6px 0 0;font-size:14px}
.sentry-sul p{margin:0}
.sentry-sul .sul-muted{opacity:.72}
.sentry-sul .sul-err{color:#ff7b7b}
.sentry-sul .sul-warn{color:#e0a030;font-weight:700}
.sentry-sul .sul-dev-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
.sentry-sul .sul-dev-head h2{overflow-wrap:anywhere}
.sentry-sul .sul-box{border:1px solid rgba(127,127,127,.3);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px;min-width:0}
.sentry-sul .sul-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(46%,170px),1fr));gap:8px}
.sentry-sul .sul-stat{border:1px solid rgba(127,127,127,.22);border-radius:8px;padding:8px 10px;min-width:0}
.sentry-sul .sul-stat span{display:block;font-size:12px;opacity:.72}
.sentry-sul .sul-stat b{display:block;font-size:17px;line-height:1.25;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.sentry-sul .sul-stat small{display:block;font-size:11.5px;opacity:.68}
.sentry-sul .sul-bar{height:8px;border-radius:999px;background:rgba(127,127,127,.22);overflow:hidden}
.sentry-sul .sul-bar i{display:block;height:100%;border-radius:inherit;background:var(--sul-car-accent,currentColor);opacity:.85}
.sentry-sul .sul-bar.full i{background:var(--sul-car-warn,#e0a030)}
.sentry-sul .sul-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:14px;align-items:start}
.sentry-sul .sul-car{border:1px solid var(--sul-car-line,rgba(127,127,127,.3));border-radius:var(--sul-car-radius,10px);padding:12px;display:flex;flex-direction:column;gap:12px;min-width:0;background:var(--sul-car-bg,transparent)}
.sentry-sul .sul-car-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}
.sentry-sul .sul-car-head h3{margin:0;font-size:15px}
.sentry-sul .sul-car-state{font-weight:600;color:var(--sul-car-accent,inherit)}
.sentry-sul .sul-car-chips{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.sentry-sul .sul-car-chip,.sentry-sul .sul-tire{border:1px solid var(--sul-car-line,rgba(127,127,127,.22));border-radius:var(--sul-car-tile-radius,8px);padding:8px 10px;min-width:0;background:var(--sul-car-tile,transparent)}
.sentry-sul .sul-car-chip span,.sentry-sul .sul-tire span{display:block;font-size:12px;opacity:.72}
.sentry-sul .sul-car-chip b,.sentry-sul .sul-tire b{display:block;font-size:18px;line-height:1.25;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.sentry-sul .sul-car-chip small,.sentry-sul .sul-tire small{display:block;font-size:11.5px;opacity:.68}
.sentry-sul .sul-car-chip.charging b{color:var(--sul-car-ok,#3ddc84)}
.sentry-sul .sul-car-tires{display:flex;flex-direction:column;gap:8px}
.sentry-sul .sul-car-tires-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sentry-sul .sul-car-tires-head b{font-size:13px}
.sentry-sul .sul-car-badge{font-size:12px;font-weight:700;padding:1px 8px;border-radius:999px;border:1px solid currentColor}
.sentry-sul .sul-car-badge.optimal{color:var(--sul-car-ok,#3ddc84)}
.sentry-sul .sul-car-badge.check{color:var(--sul-car-warn,#e0a030)}
.sentry-sul .sul-car-badge.unsafe{color:var(--sul-car-bad,#ff7b7b)}
.sentry-sul .sul-car-plan{display:grid;grid-template-columns:minmax(0,1fr) 58px minmax(0,1fr);grid-template-rows:auto auto;gap:8px 10px;align-items:stretch;max-width:460px}
.sentry-sul .sul-tire[data-tire="fl"],.sentry-sul .sul-tire[data-tire="rl"]{text-align:right}
.sentry-sul .sul-car-body{grid-column:2;grid-row:1 / span 2;position:relative;border:2px solid var(--sul-car-body,rgba(127,127,127,.55));border-radius:26px 26px 20px 20px;min-height:120px;box-sizing:border-box}
.sentry-sul .sul-car-body::before{content:"";position:absolute;left:7px;right:7px;top:22%;height:16%;border-radius:8px 8px 3px 3px;background:var(--sul-car-glass,rgba(127,127,127,.32))}
.sentry-sul .sul-car-body::after{content:"";position:absolute;left:9px;right:9px;bottom:12%;height:11%;border-radius:3px 3px 7px 7px;background:var(--sul-car-glass,rgba(127,127,127,.32))}
@media (max-width:520px){.sentry-sul .sul-car-chips{grid-template-columns:repeat(2,minmax(0,1fr))}.sentry-sul .sul-car-chip:first-child{grid-column:1 / -1}.sentry-sul .sul-car-plan{grid-template-columns:minmax(0,1fr) 44px minmax(0,1fr);gap:8px}.sentry-sul .sul-car-chip b,.sentry-sul .sul-tire b{font-size:16px}}
`;

const H = { 'X-Requested-With': 'sentry-six-manager' };
async function api(url) {
  const r = await fetch(url, { credentials: 'same-origin', headers: H });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((d && typeof d.error === 'string' && d.error) || `That did not work (${r.status}).`), { status: r.status });
  return d;
}

// ---- DOM from text only: h('b', { class: 'x' }, 'text', child, …)
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = Boolean(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** 1 decimal under 100, whole above: "98.1 GB", "1.4 TB" (1000-based, as drives are sold). */
export function bytesText(b) {
  const n = num(b);
  if (n === null) return '—';
  if (n < 1000) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n; let i = -1;
  do { v /= 1000; i++; } while (v >= 1000 && i < u.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
const DRIVE_NAMES = { cam: 'Dashcam', music: 'Music', lightshow: 'Light shows', boombox: 'Boombox' };

const KPA_PER_PSI = 6.894757;
const TIRE_NAMES = { fl: 'Front left', fr: 'Front right', rl: 'Rear left', rr: 'Rear right' };
const TIRE_STATE = { optimal: 'Optimal', check: 'Check tires', unsafe: 'Unsafe' };
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** "just now", "12 min ago", "2h ago", "3 d ago" for a Unix time in seconds. */
export function carAge(atS, now = Date.now()) {
  if (!Number.isInteger(atS)) return null;
  const s = Math.max(0, now / 1000 - atS);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const span = (s) => { const m = Math.max(0, Math.floor(s / 60)); const d = Math.floor(m / 1440); const hh = Math.floor((m % 1440) / 60); return d ? `${d} d ${hh} h` : hh ? `${hh} h ${m % 60} min` : `${m} min`; };

/** What the Car card says, as text: null when there is no car data. */
export function carView(car, { now = Date.now(), metric = UNITS.metric() } = {}) {
  if (!car || typeof car !== 'object' || Array.isArray(car)) return null;
  const tempF = !metric;
  const bar = Boolean(metric);
  const temp = (c) => UNITS.tempText(c, { m: metric, space: false });
  const pressure = (kpa) => (bar ? `${(kpa / 100).toFixed(2)} bar` : `${Math.round(kpa / KPA_PER_PSI)} psi`);
  const get = (o, k, lo, hi) => (o && typeof o === 'object' && finite(o[k]) && o[k] >= lo && o[k] <= hi ? o[k] : null);
  const v = { units: `${tempF ? '°F' : '°C'} · ${bar ? 'bar' : 'psi'}`, state: null, battery: null, interior: null, exterior: null, tires: null };
  const pct = get(car.battery, 'pct', 0, 100);
  if (pct !== null) v.battery = { label: car.battery.charging === true ? 'Charging' : 'Battery', value: `${Math.round(pct)}%`, age: carAge(car.battery.at, now), charging: car.battery.charging === true };
  for (const [k, label, lo, hi] of [['interior', 'Interior', -60, 100], ['exterior', 'Exterior', -70, 70]]) {
    const c = get(car[k], 'c', lo, hi);
    if (c !== null) v[k] = { label, value: temp(c), age: carAge(car[k].at, now) };
  }
  if (car.tires && typeof car.tires === 'object') {
    const t = {};
    for (const p of Object.keys(TIRE_NAMES)) {
      const kpa = get(car.tires[p], 'kpa', 0, 1000);
      t[p] = kpa === null ? null : { label: TIRE_NAMES[p], value: pressure(kpa), age: carAge(car.tires[p].at, now) };
    }
    if (Object.values(t).some(Boolean)) v.tires = { ...t, state: TIRE_STATE[car.tires.state] ? { kind: car.tires.state, label: TIRE_STATE[car.tires.state] } : null };
  }
  const dr = car.drive && typeof car.drive === 'object' ? car.drive : null;
  if (dr?.state === 'driving') v.state = 'Driving';
  else if (dr?.state === 'parked') v.state = Number.isInteger(dr.since) && now / 1000 - dr.since >= 60 ? `Parked · ${span(now / 1000 - dr.since)}` : 'Parked';
  if (v.battery?.charging) v.state = v.state ? `${v.state} · charging` : 'Charging';
  return v.battery || v.interior || v.exterior || v.tires || v.state ? v : null;
}

/** The Car card: battery, the two temperatures and the four tires around a car seen from above. */
function carCard(car) {
  const v = carView(car);
  const head = (extra) => h('div', { class: 'sul-car-head' }, h('h3', {}, 'Car'), extra);
  if (!v) {
    return h('section', { class: 'sul-car', 'aria-label': 'Car' }, head(null),
      h('p', {}, 'No car data yet'),
      h('p', { class: 'sul-muted' }, 'Battery, temperatures and tire pressures show here once the Sentry USB reads them from the car over Tesla BLE.'));
  }
  const chip = (c, cls = '') => h('div', { class: `sul-car-chip${cls}` }, h('span', {}, c ? c.label : ''), h('b', {}, c ? c.value : '—'), c?.age ? h('small', {}, c.age) : null);
  const tire = (p) => {
    const t = v.tires?.[p];
    return h('div', { class: 'sul-tire', 'data-tire': p }, h('span', {}, TIRE_NAMES[p]), h('b', {}, t ? t.value : '—'), t?.age ? h('small', {}, t.age) : null);
  };
  return h('section', { class: 'sul-car', 'aria-label': 'Car' },
    head(v.state ? h('span', { class: 'sul-car-state' }, v.state) : null),
    h('div', { class: 'sul-car-chips' },
      chip(v.battery || { label: 'Battery', value: '—' }, v.battery?.charging ? ' charging' : ''),
      chip(v.interior || { label: 'Interior', value: '—' }),
      chip(v.exterior || { label: 'Exterior', value: '—' })),
    v.tires ? h('div', { class: 'sul-car-tires' },
      h('div', { class: 'sul-car-tires-head' }, h('b', {}, 'Tires'), v.tires.state ? h('span', { class: `sul-car-badge ${v.tires.state.kind}` }, v.tires.state.label) : null),
      h('div', { class: 'sul-car-plan' }, tire('fl'), h('div', { class: 'sul-car-body', 'aria-hidden': 'true' }), tire('fr'), tire('rl'), tire('rr'))) : null,
    h('p', { class: 'sul-muted' }, `From the car over Tesla BLE · ${v.units}`));
}


/** The storage, version and CPU card of one Sentry USB, from its info file. */
export function infoView(info, { now = Date.now(), metric = UNITS.metric() } = {}) {
  if (!info || typeof info !== 'object') return null;
  const s = info.storage || null;
  const total = num(s?.totalBytes);
  const used = num(s?.usedBytes) ?? (total !== null && num(s?.freeBytes) !== null ? total - s.freeBytes : null);
  const free = num(s?.freeBytes) ?? (total !== null && used !== null ? total - used : null);
  const pct = total ? Math.max(0, Math.min(100, Math.round(((used ?? (total - free)) / total) * 100))) : null;
  const ageS = Number.isInteger(info.writtenUnix) ? Math.max(0, now / 1000 - info.writtenUnix) : null;
  return {
    version: info.version || null,
    asOf: carAge(info.writtenUnix, now),
    stale: ageS !== null && ageS > STALE_S,
    used: used === null ? null : bytesText(used),
    free: free === null ? null : bytesText(free),
    total: total === null ? null : bytesText(total),
    pct,
    drives: (Array.isArray(info.drives) ? info.drives : []).map((d) => ({ label: DRIVE_NAMES[d.name] || d.name, value: bytesText(d.sizeBytes) })),
    cpu: num(info.cpuTempC) === null ? null : UNITS.tempText(info.cpuTempC, { m: metric, space: false })
  };
}

function infoCard(info, h24) {
  const v = infoView(info);
  const stat = (label, value, small = null) => h('div', { class: 'sul-stat' }, h('span', {}, label), h('b', {}, value ?? '—'), small ? h('small', {}, small) : null);
  const when = new Date(info.writtenUnix * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: !h24() });
  return h('section', { class: 'sul-box', 'aria-label': 'Sentry USB' },
    v.stale
      ? h('p', { class: 'sul-warn' }, `Not heard from since ${when}`)
      : h('p', { class: 'sul-muted' }, `As of ${when} (${v.asOf}). The Sentry USB writes this while it reaches the share, so away from home it shows the last time it was home.`),
    h('div', { class: 'sul-grid' },
      stat('Space used', v.used, v.total ? `of ${v.total}${v.pct !== null ? ` · ${v.pct}%` : ''}` : null),
      stat('Space left', v.free),
      v.version ? stat('Version', v.version) : null,
      v.cpu ? stat('CPU', v.cpu) : null),
    v.pct !== null ? h('div', { class: `sul-bar${v.pct >= 90 ? ' full' : ''}`, role: 'img', 'aria-label': `${v.pct}% used` }, h('i', { style: `width:${v.pct}%` })) : null,
    v.drives.length ? h('div', {}, h('h3', {}, 'Drives the car sees'),
      h('div', { class: 'sul-grid' }, v.drives.map((d) => stat(d.label, d.value)))) : null);
}

export function createSentryUsbPage(el, { h24 = () => false } = {}) {
  if (!document.getElementById('sentry-sul-css')) {
    const style = document.createElement('style');
    style.id = 'sentry-sul-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const root = h('div', { class: 'sentry-sul' });
  el.replaceChildren(root);
  let alive = true;
  let last = null;

  function draw() {
    if (!last) return;
    const list = last.devices || [];
    if (!list.length) {
      root.replaceChildren(h('section', {},
        h('h2', {}, 'No Sentry USB found yet'),
        h('p', {}, 'Nothing to pair: Sentry USB shows here on its own once it is home and has written its info file to a car\'s share (Sentry USB v3.28.10-test.35 or later).'),
        h('p', { class: 'sul-muted' }, 'It writes .sentryusb/device-status.json in the share it archives to, next to its archive status. Its own settings, updates and logs stay on its own web page.')));
      return;
    }
    root.replaceChildren(...list.map((d) => h('section', { 'aria-label': d.vehicle.name },
      h('div', { class: 'sul-dev-head' }, h('h2', {}, d.vehicle.name)),
      d.info
        ? h('div', { class: 'sul-cards' }, infoCard(d.info, h24), carCard(d.info.car))
        : h('p', { class: 'sul-err' }, `Its info file could not be read (${d.error || 'unreadable'}).`))));
  }
  async function load() {
    try {
      last = await api('/api/sentryusb');
      if (alive) draw();
    } catch (err) {
      if (alive) root.replaceChildren(h('p', { class: 'sul-err' }, err.message));
    }
  }
  const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
  const onUnits = () => draw();
  window.addEventListener('sentry-units', onUnits);
  load();
  return {
    refresh: load,
    destroy() { alive = false; clearInterval(timer); window.removeEventListener('sentry-units', onUnits); }
  };
}
