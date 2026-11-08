// The Viewer's stats dashboard, the same in every interface: blocks of the
// car's data at the moment the footage shows, like a car's own dash.
//
//   small  one stat, big:            "15.8 V · Low Bus"
//   wide   three stats in rows:      Battery Inlet / High Bus / Power
//   gauge  speed, gear and Autopilot
//   state  an icon that lights up:   brake, blinkers, Autopilot
//
// "Customize" turns on editing: add, remove, drag to reorder, pick each
// block's stat, below the cameras or over them, mph or km/h. Dashboards are
// kept on the server for each account (/api/dashboards), so they follow to
// every interface and device.
//
// The data comes from the front camera's per-frame record (GET
// /api/telemetry: Tesla's SeiMetadata). CAN signals from the CAN Bridge join
// the same list later (registerSignals), with nothing else to change.
//
// "Raw" (when the clip has CAN data) opens the nerd raw view under the blocks:
// every CAN id at the moment shown, known to the DBC or not, with the bytes
// that changed in the last half second lit up (createRawView).
//
//   const dash = attachStatDash({ stage, videos: () => [...], main: () => video, over: false });
//   dash.destroy();

const STYLE = `
.sentry-sd{--sd-bg:rgba(18,20,24,.86);--sd-tile:rgba(255,255,255,.07);--sd-line:rgba(255,255,255,.14);--sd-fg:#f2f4f7;--sd-dim:rgba(242,244,247,.62);--sd-on:#43d17a;--sd-amber:#ffb547;--sd-blue:#4aa8ff;
  box-sizing:border-box;color:var(--sd-fg);font:14px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none}
.sentry-sd *{box-sizing:border-box}
.sentry-sd.below{margin:8px 0;background:var(--sd-bg);border:1px solid var(--sd-line);border-radius:18px;padding:8px}
.sentry-sd.float{position:fixed;z-index:2147482000;left:0;top:0;max-width:min(96vw,1180px);background:rgba(18,20,24,.97);border:1px solid var(--sd-line);border-radius:16px;padding:6px;box-shadow:0 12px 32px rgba(0,0,0,.45)}
.sentry-sd .sd-move{cursor:grab;touch-action:none;-webkit-user-select:none;user-select:none}
.sentry-sd .sd-move:active,.sentry-sd.moving .sd-move{cursor:grabbing}
.sentry-sd.moving{opacity:.92;box-shadow:0 16px 40px rgba(0,0,0,.6)}
.sentry-sd.over{position:absolute;left:8px;right:8px;bottom:8px;z-index:6;background:rgba(10,12,15,.55);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border-radius:16px;padding:6px;pointer-events:auto}
.sentry-sd .sd-row{display:flex;flex-wrap:wrap;gap:6px;align-items:stretch}
.sentry-sd .sd-b{position:relative;background:var(--sd-tile);border:1px solid var(--sd-line);border-radius:12px;padding:8px 12px;min-height:64px;display:flex;flex-direction:column;justify-content:center}
.sentry-sd .sd-small{flex:1 1 104px;max-width:170px;align-items:center;text-align:center}
.sentry-sd .sd-wide{flex:2 1 220px;max-width:340px;gap:2px}
.sentry-sd .sd-gauge{flex:0 0 132px;align-items:center;text-align:center;padding:6px}
.sentry-sd .sd-state{flex:0 1 92px;align-items:center;text-align:center}
.sentry-sd .sd-v{font-weight:800;font-size:24px;letter-spacing:-.01em;font-variant-numeric:tabular-nums;white-space:nowrap}
.sentry-sd .sd-u{font-weight:600;font-size:12px;color:var(--sd-dim);margin-left:2px}
.sentry-sd .sd-l{font-size:12px;color:var(--sd-dim);font-weight:600;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.sentry-sd .sd-line{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:3px 0;border-top:1px solid var(--sd-line)}
.sentry-sd .sd-line:first-child{border-top:0}
.sentry-sd .sd-line .sd-v{font-size:17px}
.sentry-sd .sd-line .sd-l{margin:0;font-size:13px;color:var(--sd-fg)}
.sentry-sd .sd-ring{width:96px;height:96px;border-radius:50%;border:2px solid var(--sd-line);display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(circle,rgba(255,255,255,.05),transparent 70%)}
.sentry-sd .sd-ring .sd-v{font-size:30px;line-height:1}
.sentry-sd .sd-gears{font:700 12px/1.4 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.2em;color:var(--sd-dim);margin-top:4px}
.sentry-sd .sd-gears b{color:var(--sd-fg);background:rgba(255,255,255,.18);border-radius:3px;padding:0 1px}
.sentry-sd .sd-ap{font-size:11px;font-weight:700;color:var(--sd-blue);min-height:14px;margin-top:2px}
.sentry-sd .sd-ico{font-size:24px;line-height:1;opacity:.28;transition:opacity .08s}
.sentry-sd .sd-state.on .sd-ico{opacity:1}
.sentry-sd .sd-state.on.sd-brake .sd-ico{color:#ff5d5d}
.sentry-sd .sd-state.on.sd-blink .sd-ico{color:var(--sd-on)}
.sentry-sd .sd-state.on.sd-ap .sd-ico{color:var(--sd-blue)}
.sentry-sd .sd-bar{height:4px;border-radius:2px;background:var(--sd-line);margin-top:5px;width:100%;overflow:hidden}
.sentry-sd .sd-bar i{display:block;height:100%;background:var(--sd-on);width:0}
.sentry-sd .sd-tools{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px}
.sentry-sd.over .sd-tools{margin-top:4px}
.sentry-sd button.sd-btn,.sentry-sd select{all:unset;box-sizing:border-box;cursor:pointer;padding:4px 10px;border-radius:8px;border:1px solid var(--sd-line);background:rgba(255,255,255,.06);color:var(--sd-fg);font:600 12px/1.6 system-ui,sans-serif;max-width:100%}
.sentry-sd select{padding-right:22px;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 12px) 55%,calc(100% - 7px) 55%;background-size:5px 5px;background-repeat:no-repeat}
.sentry-sd select option{color:#111;background:#fff}
.sentry-sd button.sd-btn:focus-visible,.sentry-sd select:focus-visible{outline:2px solid var(--sd-blue);outline-offset:2px}
.sentry-sd button.sd-btn[aria-pressed="true"]{background:rgba(74,168,255,.25);border-color:var(--sd-blue)}
.sentry-sd:not(.editing) .sd-edit{display:none!important}
.sentry-sd.editing .sd-edit{display:flex}
.sentry-sd.editing .sd-b{padding-top:30px;border-style:dashed}
.sentry-sd .sd-bar-edit{position:absolute;left:4px;right:4px;top:4px;gap:4px;align-items:center}
.sentry-sd .sd-grip{cursor:grab;touch-action:none;padding:2px 6px;border-radius:6px;font-size:13px;color:var(--sd-dim)}
.sentry-sd .sd-grip:active{cursor:grabbing}
.sentry-sd .sd-x{margin-left:auto}
.sentry-sd .sd-b.dragging{opacity:.4}
.sentry-sd .sd-pick{display:flex;flex-direction:column;gap:4px;margin-top:6px;width:100%}
.sentry-sd .sd-pick select{font-size:11px;padding:2px 20px 2px 6px;width:100%}
.sentry-sd .sd-none{color:var(--sd-dim);font-size:12px;padding:4px 6px}
.sentry-sd .sd-hide{margin-left:auto}
.sentry-sd .sd-sync{font-size:11px;color:var(--sd-dim);white-space:nowrap}
.sentry-sd .sd-sync.sd-warn{color:var(--sd-amber);font-weight:700}
.sentry-sd button.sd-btn[hidden]{display:none}
.sentry-sd .sd-raw{margin-top:6px;min-width:0;max-width:100%;-webkit-user-select:text;user-select:text}
.sentry-sd .sd-raw[hidden]{display:none}
.sentry-sd .sd-raw.sd-raw-loading .sd-raw-scroll{opacity:.5}
.sentry-sd .sd-raw-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}
.sentry-sd .sd-raw-bar input{all:unset;box-sizing:border-box;flex:1 1 140px;min-width:0;max-width:260px;padding:4px 10px;border-radius:8px;border:1px solid var(--sd-line);background:rgba(255,255,255,.06);color:var(--sd-fg);font:600 12px/1.6 system-ui,sans-serif}
.sentry-sd .sd-raw-bar input:focus-visible{outline:2px solid var(--sd-blue);outline-offset:2px}
.sentry-sd .sd-raw-n{font-size:12px;color:var(--sd-dim)}
.sentry-sd .sd-raw-scroll{overflow:auto;max-height:46vh;max-width:100%;background:var(--sd-tile);border:1px solid var(--sd-line);border-radius:12px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
.sentry-sd.over .sd-raw-scroll{max-height:30vh}
.sentry-sd .sd-raw table{border-collapse:collapse;width:100%;font:12px/1.35 ui-monospace,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
.sentry-sd .sd-raw th{position:sticky;top:0;background:#1d2026;color:var(--sd-dim);font:700 11px/1.6 system-ui,sans-serif;text-align:left;padding:4px 8px;white-space:nowrap}
.sentry-sd .sd-raw td{padding:2px 8px;border-top:1px solid var(--sd-line);white-space:nowrap}
.sentry-sd .sd-raw td.sd-raw-hz{text-align:right;color:var(--sd-dim)}
.sentry-sd .sd-raw td.sd-raw-p{width:100%}
.sentry-sd .sd-raw td.sd-raw-name{font-family:system-ui,sans-serif;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.sentry-sd .sd-raw td.sd-raw-name.unknown{color:var(--sd-amber);font-style:italic}
.sentry-sd .sd-raw .sd-raw-p i{font-style:normal;padding:0 2px;border-radius:3px;margin-right:1px}
.sentry-sd .sd-raw .sd-raw-p i.hot{background:var(--sd-amber);color:#111}
.sentry-sd .sd-raw .sd-raw-p.none{color:var(--sd-dim)}
@media (max-width:640px){
  .sentry-sd .sd-small{flex-basis:88px}
  .sentry-sd .sd-v{font-size:20px}
  .sentry-sd .sd-gauge{flex-basis:112px}
  .sentry-sd .sd-ring{width:84px;height:84px}
  .sentry-sd .sd-ring .sd-v{font-size:26px}
  .sentry-sd.over{left:4px;right:4px;bottom:4px}
}
`;

const MPS_MPH = 2.236936;
const MPS_KMH = 3.6;
const G = 9.80665;
const GEARS = ['P', 'D', 'R', 'N'];
const AUTOPILOT = ['', 'Self-driving', 'Autosteer', 'Cruise'];
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');

// ---- signals: what a block can show. CAN signals are added the same way.
// { id, label, group, kind: 'number' | 'text' | 'bool', unit(ctx), value(rec, ctx) → number | string | boolean | null, digits, bar(rec) 0..1 }
const SIGNALS = new Map();
let signalsVersion = 0; // goes up with each change of SIGNALS (the picker's options are built once per version)
export function registerSignals(list) { for (const s of list) SIGNALS.set(s.id, s); if (list.length) signalsVersion++; }
registerSignals([
  { id: 'dash.speed', label: 'Speed', group: 'Driving', kind: 'number', unit: (c) => (c.metric ? 'km/h' : 'mph'), value: (r, c) => (r.speedMps == null ? null : r.speedMps * (c.metric ? MPS_KMH : MPS_MPH)), digits: 0 },
  { id: 'dash.gear', label: 'Gear', group: 'Driving', kind: 'text', value: (r) => r.gear ?? null },
  // (0-1 on some cars, 0-100 on others)
  { id: 'dash.accelerator', label: 'Accelerator', group: 'Driving', kind: 'number', unit: () => '%', value: (r) => (r.accelerator == null ? null : r.accelerator * (r.accelerator > 1 ? 1 : 100)), digits: 0, bar: (r) => (r.accelerator ?? 0) * (r.accelerator > 1 ? 0.01 : 1) },
  { id: 'dash.brake', label: 'Brake', group: 'Driving', kind: 'bool', value: (r) => r.brake ?? null, icon: '●' },
  { id: 'dash.steering', label: 'Steering', group: 'Driving', kind: 'number', unit: () => '°', value: (r) => r.steering ?? null, digits: 0 },
  { id: 'dash.blinkLeft', label: 'Left blinker', group: 'Driving', kind: 'bool', value: (r) => r.blinkLeft ?? null, icon: '◀' },
  { id: 'dash.blinkRight', label: 'Right blinker', group: 'Driving', kind: 'bool', value: (r) => r.blinkRight ?? null, icon: '▶' },
  { id: 'dash.autopilot', label: 'Autopilot', group: 'Driving', kind: 'text', value: (r) => r.autopilot || 'Off', bool: (r) => Boolean(r.autopilot), icon: '◎' },
  { id: 'dash.accelLong', label: 'Accel (fwd)', group: 'Motion', kind: 'number', unit: () => 'g', value: (r) => (r.ax == null ? null : r.ax / G), digits: 2 },
  { id: 'dash.accelLat', label: 'Accel (side)', group: 'Motion', kind: 'number', unit: () => 'g', value: (r) => (r.ay == null ? null : r.ay / G), digits: 2 },
  { id: 'dash.accelVert', label: 'Accel (up)', group: 'Motion', kind: 'number', unit: () => 'g', value: (r) => (r.az == null ? null : r.az / G), digits: 2 },
  { id: 'dash.heading', label: 'Heading', group: 'Motion', kind: 'text', value: (r) => (Number.isFinite(r.heading) ? `${Math.round(((r.heading % 360) + 360) % 360)}° ${COMPASS[Math.round((((r.heading % 360) + 360) % 360) / 45) % 8]}` : null) },
  { id: 'dash.lat', label: 'Latitude', group: 'Position', kind: 'number', unit: () => '°', value: (r) => r.lat ?? null, digits: 5 },
  { id: 'dash.lon', label: 'Longitude', group: 'Position', kind: 'number', unit: () => '°', value: (r) => r.lon ?? null, digits: 5 },
  { id: 'dash.frame', label: 'Frame no.', group: 'Nerd', kind: 'number', unit: () => '', value: (r) => r.frame ?? null, digits: 0 }
]);

// ---- CAN signals (CAN Bridge logs, indexed on the server: /api/can/signals, /api/can/clip)
const CAN_UNITS = {
  C: { metric: ['°C', (v) => v], imperial: ['°F', (v) => v * 1.8 + 32] },
  degC: { metric: ['°C', (v) => v], imperial: ['°F', (v) => v * 1.8 + 32] },
  kph: { metric: ['km/h', (v) => v], imperial: ['mph', (v) => v / 1.609344] },
  'km/h': { metric: ['km/h', (v) => v], imperial: ['mph', (v) => v / 1.609344] },
  km: { metric: ['km', (v) => v], imperial: ['mi', (v) => v / 1.609344] },
  kPa: { metric: ['kPa', (v) => v], imperial: ['psi', (v) => v * 0.1450377] },
  bar: { metric: ['bar', (v) => v], imperial: ['psi', (v) => v * 14.50377] }
};
const canSeriesAt = (pts, ms) => {
  if (!pts?.length || ms < pts[0][0]) return null;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid][0] <= ms) lo = mid; else hi = mid - 1;
  }
  return pts[lo][1];
};
/** A readable name: the DBC's description (up to its first comma), else the signal name in words. */
function canLabel(name, comment) {
  const c = String(comment || '').split(/[,(;]/)[0].trim();
  if (c && c !== name && c.length <= 28) return c;
  const words = String(name)
    .replace(/^[A-Z0-9]{2,8}_/, '') // the sender (DI_, BMS_, VCFRONT_)
    .replace(/(?<=[a-z])\d{3}$|^ID[0-9A-F]+/, '') // the message id at the end (BattVoltage132)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}
function registerCanSignals(meta) {
  const list = [];
  for (const [name, m] of Object.entries(meta || {})) {
    const id = `can.${name}`;
    if (SIGNALS.has(id)) continue;
    const conv = CAN_UNITS[m.unit];
    const named = m.values && Object.keys(m.values).length ? m.values : null;
    // words only when every value has a name (a gear, a state); a number with a
    // name for one special value (SNA: not available) stays a number
    const span = Number.isFinite(m.max) && Number.isFinite(m.min) ? m.max - m.min : Infinity;
    const allNamed = Boolean(named) && span <= 16;
    const label = canLabel(name, m.label);
    list.push({
      id, label, group: `CAN · ${String(m.bus || '').replace(/Bus$/, '') || 'bus'} · ${String(m.message || '').replace(/^ID[0-9A-F]+/, '') || 'message'}`,
      kind: allNamed ? 'text' : 'number', source: 'can', canName: name,
      unit: (c) => (conv ? conv[c.metric ? 'metric' : 'imperial'][0] : m.unit || ''),
      value: (r, c) => {
        const v = c.can(name);
        if (v == null) return null;
        // (value names are for raw values: used for named states, whose scale is 1)
        if (allNamed) return named[String(Math.round(v))] ?? String(v);
        return conv ? conv[c.metric ? 'metric' : 'imperial'][1](v) : v;
      },
      bool: (r, c) => { const v = c.can(name); return v != null && v !== 0; },
      digits: Math.abs((m.max ?? 0) - (m.min ?? 0)) > 200 ? 0 : 1
    });
  }
  registerSignals(list);
  return list.length;
}
// An answer that says "nothing (yet)", or a request that failed, is kept only
// for RETRY_MS: the server indexes CAN logs in the background, so a clip with
// no CAN data now can have it a minute later. A good answer is kept.
const RETRY_MS = 30_000;
/** The cache entry { p: Promise, settled, until } for `key`, asked with get(entry) when missing or expired. */
function cachedGet(map, key, max, get, good) {
  const hit = map.get(key);
  if (hit && !(hit.until && Date.now() > hit.until)) return hit;
  const entry = { p: null, settled: false, until: 0 };
  entry.p = get(entry).then((d) => {
    entry.settled = true;
    if (!good(d)) entry.until = Date.now() + RETRY_MS;
    return d;
  });
  map.delete(key);
  map.set(key, entry);
  if (map.size > max) map.delete(map.keys().next().value);
  return entry;
}
const hasKeys = (o) => Boolean(o && Object.keys(o).length);
let optionsBuilt = { v: -1, html: '' };
/** Every signal as <optgroup>s of <option>s, built once per change of SIGNALS. */
function signalOptions() {
  if (optionsBuilt.v === signalsVersion) return optionsBuilt.html;
  const groups = new Map();
  for (const s of SIGNALS.values()) (groups.get(s.group) || groups.set(s.group, []).get(s.group)).push(s);
  const html = [...groups].map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('')}</optgroup>`).join('');
  optionsBuilt = { v: signalsVersion, html };
  return html;
}
const canMetaCache = new Map(); // front path -> entry of Promise<meta>
const canClipCache = new Map(); // front path + names -> entry of Promise<{ start, sync, series } | null>
function canMetaFor(path) {
  return cachedGet(canMetaCache, path, 8, () => fetch(`/api/can/signals?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((d) => d?.signals || {}).catch(() => ({})), hasKeys).p;
}
const canClipGood = (d) => Object.values(d?.series || {}).some((pts) => pts?.length);
function canClipFor(path, names) {
  return cachedGet(canClipCache, `${path}|${names.join(',')}`, 16, () => fetch(`/api/can/clip?path=${encodeURIComponent(path)}&signals=${encodeURIComponent(names.join(','))}`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null), canClipGood).p;
}
/** Forget every /api/can/clip answer for this clip (to ask again with the newest sync). */
function dropCanClip(path) {
  for (const key of [...canClipCache.keys()]) if (key.startsWith(`${path}|`)) canClipCache.delete(key);
}
/**
 * A moment of the clip (ms in) on the CAN clock: the clip's start there, and
 * the drive's drift as rate. The signals and the raw view both use this, with
 * the same answer, so their frames agree.
 */
function canTime(sync, ms) { return sync.start + ms * (sync.sync?.rate || 1); }

// ---- the nerd raw view: every CAN id at the moment shown, decodable or not
// (GET /api/can/raw), with the bytes that just changed lit up, to find which
// message moves when the footage shows the brake pressed. Fetched once per
// clip, only while open (a tiny probe decides whether "Raw" is offered).
const RAW_HOT_MS = 500;
const rawProbeCache = new Map(); // front path -> entry of Promise<boolean>
const rawDataCache = new Map(); // front path -> entry of Promise<{ start, sync, ids } | null>
const rawGet = (url, signal) => fetch(url, { credentials: 'same-origin', signal }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
function rawProbe(path) {
  return cachedGet(rawProbeCache, path, 16, () => rawGet(`/api/can/raw?path=${encodeURIComponent(path)}&probe=1`).then((d) => d?.count > 0), Boolean).p;
}
/** The cache entry (its p, and abort to stop the download) of the clip's raw data. */
function rawFor(path) {
  return cachedGet(rawDataCache, path, 3, (entry) => {
    entry.abort = new AbortController();
    return rawGet(`/api/can/raw?path=${encodeURIComponent(path)}`, entry.abort.signal);
  }, (d) => Boolean(d?.ids?.length));
}
/** The index of the last change at or before `utc` (-1: none yet). */
function rawIndexAt(changes, utc) {
  if (!changes.length || utc < changes[0][0]) return -1;
  let lo = 0;
  let hi = changes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (changes[mid][0] <= utc) lo = mid; else hi = mid - 1;
  }
  return lo;
}
/** Which bytes changed in the RAW_HOT_MS before `utc`: a string of 0/1 per byte. */
function rawHot(changes, i, utc) {
  const n = changes[i][1].length >> 1;
  const hot = new Array(n).fill('0');
  for (let j = i; j > 0 && changes[j][0] > utc - RAW_HOT_MS; j--) {
    const a = changes[j][1];
    const b = changes[j - 1][1];
    for (let k = 0; k < n; k++) if (a.substr(k * 2, 2) !== b.substr(k * 2, 2)) hot[k] = '1';
  }
  return hot.join('');
}
let rawOpenPref = false;
try { rawOpenPref = localStorage.getItem('sentry-sd-raw') === '1'; } catch { /* no storage */ }
/**
 * The raw table, its own element (kept across the dashboard's redraws):
 *   const rv = createRawView({ onAvailable(yes), syncFor(path), onData(path, data) });
 *   rv.setPath(path);  rv.tick(ms into clip);  rv.destroy()
 * syncFor(path) gives the signals' answer for the clip ({ start, sync }) when
 * there is one, so the raw view lines up with the footage exactly as they do;
 * else the raw answer's own start and sync are used. onData hears each raw
 * answer (a newer sync than the signals' tells the dashboard to ask again).
 */
function createRawView({ onAvailable = () => {}, syncFor = () => null, onData = () => {} } = {}) {
  const box = document.createElement('div');
  box.className = 'sd-raw';
  box.hidden = true;
  box.innerHTML = `<div class="sd-raw-bar"><input type="search" data-raw-filter placeholder="Filter: id or name" aria-label="Filter CAN ids by id or name" autocomplete="off" spellcheck="false">
    <button type="button" class="sd-btn" data-raw-unknown aria-pressed="false">Unknown only</button><span class="sd-raw-n" data-raw-n></span></div>
    <div class="sd-raw-scroll"><table><thead><tr><th>ID</th><th>Bus</th><th>Name</th><th>Hz</th><th>Payload</th></tr></thead><tbody data-raw-body></tbody></table></div>`;
  const body = box.querySelector('[data-raw-body]');
  const count = box.querySelector('[data-raw-n]');
  const filterEl = box.querySelector('[data-raw-filter]');
  const unknownBtn = box.querySelector('[data-raw-unknown]');
  let path = null;
  let available = false;
  let open = rawOpenPref;
  let data = null; // { start, sync, ids }
  let rows = []; // { e (the id), tr, cell, spans, idx, hot, hex }
  let unknownOnly = false;
  let lastMs = NaN;
  let token = 0;
  let dead = false; // destroyed: nothing more is asked or drawn
  let pending = null; // the raw download (cache entry) this view waits for
  let retry = 0; // the timer that asks again when there was no data (yet)

  function build() {
    rows = [];
    body.textContent = '';
    box.classList.remove('sd-raw-loading');
    if (!data?.ids?.length) {
      body.innerHTML = '<tr><td colspan="5" class="sd-none">No CAN messages for this clip.</td></tr>';
      count.textContent = '';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const e of data.ids) {
      const tr = document.createElement('tr');
      const id = e.id.padStart(e.id.length > 3 ? 8 : 3, '0'); // 00C; extended ids in 8
      tr.innerHTML = `<td>${esc(id)}</td><td>${esc(e.bus)}</td><td class="sd-raw-name${e.name ? '' : ' unknown'}" title="${esc(e.name || 'No DBC message for this id')}">${esc(e.name || 'unknown')}</td><td class="sd-raw-hz">${fmt(e.hz, e.hz < 10 ? 1 : 0)}</td><td class="sd-raw-p none">—</td>`;
      rows.push({ e, tr, cell: tr.lastElementChild, spans: [], idx: -2, hot: '', hex: '', search: `${id} ${e.id} ${e.bus}:${id} ${e.name || 'unknown'}`.toLowerCase() });
      frag.appendChild(tr);
    }
    body.appendChild(frag);
    applyFilter();
    lastMs = NaN;
  }
  function applyFilter() {
    const q = filterEl.value.trim().toLowerCase().replace(/^0x/, '');
    let shown = 0;
    for (const r of rows) {
      const hide = (unknownOnly && r.e.name) || (q && !r.search.includes(q));
      r.tr.hidden = Boolean(hide);
      if (!hide) shown++;
    }
    count.textContent = rows.length ? `${shown} of ${rows.length} ids` : '';
    lastMs = NaN;
  }
  // a row's payload cell: one span per byte, rebuilt only when the length changes
  function paint(r, utc) {
    const i = rawIndexAt(r.e.changes, utc);
    if (i < 0) {
      if (r.idx !== -1) { r.idx = -1; r.hex = ''; r.hot = ''; r.spans = []; r.cell.className = 'sd-raw-p none'; r.cell.textContent = '—'; }
      return;
    }
    const hex = r.e.changes[i][1];
    const hot = rawHot(r.e.changes, i, utc);
    if (i === r.idx && hot === r.hot) return;
    const n = hex.length >> 1;
    if (r.spans.length !== n) {
      r.cell.className = 'sd-raw-p';
      r.cell.textContent = '';
      r.spans = [];
      for (let k = 0; k < n; k++) r.spans.push(r.cell.appendChild(document.createElement('i')));
      r.hex = '';
      r.hot = '';
    }
    for (let k = 0; k < n; k++) {
      const byte = hex.substr(k * 2, 2);
      if (byte !== r.hex.substr(k * 2, 2)) r.spans[k].textContent = byte;
      if (hot[k] !== r.hot[k]) r.spans[k].classList.toggle('hot', hot[k] === '1');
    }
    r.idx = i;
    r.hex = hex;
    r.hot = hot;
  }
  function setAvailable(yes) {
    if (yes !== available) { available = yes; onAvailable(yes); }
    box.hidden = !(open && available);
  }
  // a new clip: the last clip's rows stay (dimmed, not painted) until the new
  // ones are here, so the page does not jump and the scroll stays
  function loading() {
    box.classList.add('sd-raw-loading');
    count.textContent = 'Loading…';
    if (!rows.length) body.innerHTML = '<tr><td colspan="5" class="sd-none">Loading…</td></tr>';
  }
  // ask again in a while: the server may not have indexed this clip's CAN logs yet
  function later(p) {
    clearTimeout(retry);
    retry = setTimeout(() => { if (!dead && p === path) check(p); }, RETRY_MS + 1000);
  }
  // whether the clip has raw data: only cars with CAN signals are asked; while
  // the view is open its own download says so, else a small probe does
  function check(p) {
    canMetaFor(p).then((meta) => {
      if (dead || p !== path) return;
      if (!hasKeys(meta)) { setAvailable(false); return; }
      if (open) { load(); return; }
      rawProbe(p).then((yes) => {
        if (dead || p !== path) return;
        setAvailable(yes);
        if (!yes) later(p);
      });
    });
  }
  function load() {
    if (dead || !open || !path) return;
    const my = ++token;
    const p = path;
    clearTimeout(retry);
    const entry = rawFor(p);
    pending = entry;
    entry.p.then((d) => {
      if (pending === entry) pending = null;
      if (dead || my !== token || p !== path) return;
      data = d;
      setAvailable(Boolean(d?.ids?.length));
      build();
      if (d) onData(p, d);
      if (!d?.ids?.length) later(p);
    });
  }
  filterEl.addEventListener('input', applyFilter);
  unknownBtn.addEventListener('click', () => {
    unknownOnly = !unknownOnly;
    unknownBtn.setAttribute('aria-pressed', String(unknownOnly));
    applyFilter();
  });
  return {
    el: box,
    get available() { return available; },
    get open() { return open; },
    /** The raw answer shown for this clip (null: none yet). */
    dataFor(p) { return p === path ? data : null; },
    setPath(p) {
      if (dead || p === path) return;
      path = p;
      data = null;
      token++;
      clearTimeout(retry);
      // the view and its button stay until the new clip's answer says there is nothing
      if (available) loading();
      check(p);
    },
    toggle() {
      if (dead) return;
      open = !open;
      try { localStorage.setItem('sentry-sd-raw', open ? '1' : '0'); } catch { /* no storage */ }
      rawOpenPref = open;
      box.hidden = !(open && available);
      if (open && available && !data) load();
      lastMs = NaN;
    },
    /** Payloads at this moment of the clip (cells change only where a byte does). */
    tick(ms) {
      if (dead || box.hidden || !data?.ids?.length) return;
      if (Math.abs(ms - lastMs) < 40) return; // about 25 updates a second at most
      lastMs = ms;
      const s = syncFor(path);
      const utc = canTime(Number.isFinite(s?.start) ? s : data, ms);
      for (const r of rows) if (!r.tr.hidden) paint(r, utc);
    },
    /** Stops asking and drawing; a download only this view waits for is stopped (and not kept). */
    destroy() {
      dead = true;
      token++;
      clearTimeout(retry);
      if (pending && !pending.settled) {
        pending.abort?.abort();
        for (const [k, v] of rawDataCache) if (v === pending) rawDataCache.delete(k);
      }
      pending = null;
    }
  };
}

const DEFAULT_BOARD = () => ({
  id: 'default', name: 'Drive', placement: 'below', metric: null,
  blocks: [
    { type: 'state', signals: ['dash.blinkLeft'] },
    { type: 'small', signals: ['dash.accelerator'] },
    { type: 'gauge', signals: ['dash.speed'] },
    { type: 'wide', signals: ['dash.steering', 'dash.accelLat', 'dash.accelLong'] },
    { type: 'state', signals: ['dash.brake'] },
    { type: 'state', signals: ['dash.autopilot'] },
    { type: 'state', signals: ['dash.blinkRight'] }
  ]
});
const SLOTS = { small: 1, wide: 3, gauge: 1, state: 1 };
const DEFAULT_SIGNAL = { small: ['dash.speed'], wide: ['dash.speed', 'dash.accelerator', 'dash.steering'], gauge: ['dash.speed'], state: ['dash.brake'] };

// ---- the front camera's per-frame records (the same decoding as the packs)
function decodeRecord(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = {};
  let i = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (i >= bytes.length) throw new Error('truncated');
      const b = bytes[i++];
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result;
      shift += 7;
      if (shift > 63) throw new Error('bad varint');
    }
  };
  while (i < bytes.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    let value;
    if (wire === 0) value = varint();
    else if (wire === 5) { value = view.getFloat32(i, true); i += 4; } else if (wire === 1) { value = view.getFloat64(i, true); i += 8; } else if (wire === 2) { i += varint(); continue; } else throw new Error('wire');
    switch (field) {
      case 2: out.gear = GEARS[value] ?? '?'; break;
      case 3: out.frame = value; break;
      case 4: out.speedMps = value; break;
      case 5: out.accelerator = value; break;
      case 6: out.steering = value; break;
      case 7: out.blinkLeft = Boolean(value); break;
      case 8: out.blinkRight = Boolean(value); break;
      case 9: out.brake = Boolean(value); break;
      case 10: out.autopilot = AUTOPILOT[value] ?? ''; break;
      case 11: out.lat = value; break;
      case 12: out.lon = value; break;
      case 13: out.heading = value; break;
      case 14: out.ax = value; break;
      case 15: out.ay = value; break;
      case 16: out.az = value; break;
      default: break;
    }
  }
  return { gear: 'P', speedMps: 0, accelerator: 0, steering: 0, blinkLeft: false, blinkRight: false, brake: false, autopilot: '', ...out };
}
function decodeFrames(json) {
  const out = [];
  for (const [t, data] of json?.frames || []) {
    try {
      const bin = atob(String(data));
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      out.push({ t: Number(t), ...decodeRecord(bytes) });
    } catch { /* a damaged record */ }
  }
  return out.sort((a, b) => a.t - b.t);
}
const cache = new Map(); // front path -> Promise<records>
function recordsFor(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(`/api/telemetry?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null)).then(decodeFrames).catch(() => []));
    if (cache.size > 8) cache.delete(cache.keys().next().value);
  }
  return cache.get(path);
}
function recordAt(recs, ms) {
  if (!recs?.length) return null;
  if (ms <= recs[0].t) return recs[0];
  let lo = 0;
  let hi = recs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (recs[mid].t <= ms) lo = mid; else hi = mid - 1;
  }
  return recs[lo];
}
/** The front camera's file for the clip the cameras show (from any camera's address). */
function frontPathOf(videos) {
  for (const v of videos) {
    const src = v?.currentSrc || v?.getAttribute?.('src') || '';
    const m = /[?&]path=([^&]+)/.exec(src);
    if (!m) continue;
    let p;
    try { p = decodeURIComponent(m[1]); } catch { continue; }
    const front = p.replace(/-(front|back|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$/i, '-front.mp4');
    if (front !== p || /-front\.mp4$/i.test(p)) return front;
  }
  return null;
}

// ---- saved dashboards (per account, on the server)
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' };
let saved = null; // Promise<{ boards, active }>
function loadBoards() {
  saved ||= fetch('/api/dashboards', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((d) => (d?.boards?.length ? d : { boards: [DEFAULT_BOARD()], active: 'default' }));
  return saved;
}
let saveTimer = 0;
function saveBoards(state) {
  saved = Promise.resolve(state);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/api/dashboards', { method: 'PUT', credentials: 'same-origin', headers: H, body: JSON.stringify(state) }).catch(() => {});
  }, 500);
}
const metricDefault = () => !/^en-(US|GB|LR|MM)$/i.test(navigator.language || '');

export function attachStatDash({ stage, videos = () => [], main = () => null, over = false } = {}) {
  if (!stage) return { destroy() {} };
  if (!document.getElementById('sentry-sd-css')) {
    const s = document.createElement('style');
    s.id = 'sentry-sd-css';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }
  const el = document.createElement('div');
  el.className = 'sentry-sd';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Car data at this moment');
  let state = null; // { boards, active }
  let board = null;
  let editing = false;
  let hidden = false;
  let alive = true;
  let recs = null;
  let recsFor = null;
  let can = null; // { start (UTC ms of the clip's 0 s), sync, trust, series }
  let canOf = null; // the clip `can` is for
  let canFor = null;
  let canRetry = 0; // the timer that asks again when the clip had no CAN data (yet)
  let raf = 0;
  // the nerd raw view (createRawView): its own element, put back after each redraw.
  // It uses the signals' sync for the clip when there is one (canTime), so both agree.
  const rawView = createRawView({
    onAvailable: (yes) => { const b = el.querySelector('[data-raw]'); if (b) b.hidden = !yes; },
    syncFor: (p) => (can && canOf === p ? can : null),
    onData: (p, d) => reconcile(p, d)
  });
  // The raw answer is asked for later, so its sync is the newer one: when it
  // differs from the signals', they ask again (once per raw answer), and both
  // then use the same sync.
  let reconciledWith = null;
  function reconcile(p, d) {
    if (!alive || !can || canOf !== p || !d || d === reconciledWith || !Number.isFinite(d.start)) return;
    const rateDiffers = d.sync !== undefined && (d.sync?.rate || 1) !== (can.sync?.rate || 1);
    if (Math.abs(d.start - can.start) <= 0.05 && !rateDiffers) return;
    reconciledWith = d;
    dropCanClip(p);
    canFor = null;
  }
  const ctx = (ms = null) => ({
    metric: board?.metric ?? metricDefault(),
    // a CAN signal's value at this moment of the clip
    // (the server lines the CAN clock up with the footage: start, and the drift as rate)
    can: (name) => (can && ms !== null ? canSeriesAt(can.series?.[name], canTime(can, ms)) : null)
  });
  // how well the CAN data is lined up with the footage, small in the tools row
  function syncNote() {
    const node = el.querySelector('[data-sync]');
    if (!node) return;
    const s = can && canNames().length ? can.sync : null;
    const m = s?.method;
    node.textContent = !s ? '' : m === 'clock' ? 'CAN: clock only' : m === 'speed' ? 'CAN synced by speed' : `CAN synced ±${Math.max(1, Math.round(s.spreadMs ?? 0))} ms`;
    node.title = !s ? '' : m === 'clock' ? 'CAN data placed by the clip\'s time only: nothing to line it up with' : m === 'speed' ? 'CAN data lined up with the footage by its speed' : `CAN data lined up with the footage from ${s.matches} matching changes (brake, blinkers, accelerator)${m === 'edges-drive' ? ' across the drive' : ''}`;
    // a log that failed its signature check, used anyway: always said; unsigned (an older bridge): said quietly
    const trust = can && canNames().length ? can.trust : null;
    node.classList.toggle('sd-warn', trust === 'override');
    if (trust === 'override') {
      node.textContent = `⚠ CAN data failed its check · ${node.textContent}`;
      node.title = `Some of this CAN data comes from a log whose signature check failed and was used anyway (Nerd settings). ${node.title}`;
    } else if (trust === 'unsigned') {
      node.textContent = `${node.textContent} · unsigned`;
      node.title = `${node.title}. These logs are not signed (an older CAN Bridge).`;
    }
  }
  const canNames = () => [...new Set((board?.blocks || []).flatMap((b) => b.signals).filter((id) => id.startsWith('can.')).map((id) => id.slice(4)))].sort();
  function loadCan(path) {
    const names = canNames();
    const key = `${path}|${names.join(',')}`;
    if (key === canFor) return;
    canFor = key;
    clearTimeout(canRetry);
    // new names (and the stat picker) once the car's signal list is here
    canMetaFor(path).then((meta) => { if (alive && registerCanSignals(meta) && state) draw(); });
    if (!names.length) { can = null; canOf = null; syncNote(); return; }
    canClipFor(path, names).then((d) => {
      if (!alive || canFor !== key) return;
      can = d;
      canOf = path;
      syncNote();
      tick(true);
      reconcile(path, rawView.dataFor(path));
      // no data (yet): asked again in a while (the next tick, once canFor is cleared)
      if (!canClipGood(d)) canRetry = setTimeout(() => { if (canFor === key) canFor = null; }, RETRY_MS + 1000);
    });
  }

  // where the bar is: under the cameras, over them, or anywhere on the page (float: dragged by its
  // Move handle; the spot is kept per account, one for wide screens and one for narrow ones)
  const whereNow = () => (board?.placement === 'float' ? 'float' : over || board?.placement === 'over' ? 'over' : 'below');
  const screenKind = () => (innerWidth < 700 ? 'narrow' : 'wide');
  function place() {
    const where = whereNow();
    el.classList.toggle('over', where === 'over');
    el.classList.toggle('below', where === 'below');
    el.classList.toggle('float', where === 'float');
    if (where === 'float') {
      if (el.parentElement !== document.body) document.body.appendChild(el);
    } else {
      el.style.left = '';
      el.style.top = '';
      if (where === 'over') {
        if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
        if (el.parentElement !== stage) stage.appendChild(el);
      } else if (el.previousElementSibling !== stage) stage.after(el);
    }
  }
  /** Put a floating bar where it was left: x and y are shares of the room around it, so it stays on screen at any size. */
  function applyFloat() {
    if (whereNow() !== 'float') return;
    const p = board.float?.[screenKind()] || { x: 0.5, y: 0.94 };
    const roomX = Math.max(0, innerWidth - el.offsetWidth);
    const roomY = Math.max(0, innerHeight - el.offsetHeight);
    el.style.left = `${Math.round(p.x * roomX)}px`;
    el.style.top = `${Math.round(p.y * roomY)}px`;
  }
  /** Keep where it is now (after a drag or a nudge). */
  function keepFloat(left, top) {
    const roomX = Math.max(1, innerWidth - el.offsetWidth);
    const roomY = Math.max(1, innerHeight - el.offsetHeight);
    const x = Math.max(0, Math.min(1, left / roomX));
    const y = Math.max(0, Math.min(1, top / roomY));
    board.float = { ...(board.float || {}), [screenKind()]: { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 } };
    saveBoards(state);
    applyFloat();
  }
  const onResize = () => applyFloat();
  addEventListener('resize', onResize);

  // a stat picker shows only its stat until it is opened (fillPick): with
  // thousands of CAN signals, every redraw would otherwise build them all
  const pickOption = (id) => {
    const s = SIGNALS.get(id);
    return `<option value="${esc(id)}" selected>${esc(s ? s.label : `${String(id).replace(/^can\./, '')} (no data yet)`)}</option>`;
  };
  function fillPick(sel) {
    if (sel.dataset.filled) return;
    const id = board?.blocks[Number(sel.dataset.pick)]?.signals[Number(sel.dataset.slot)];
    sel.innerHTML = (id && !SIGNALS.has(id) ? pickOption(id) : '') + signalOptions();
    sel.value = id ?? '';
    sel.dataset.filled = '1';
  }
  function blockHtml(b, i) {
    const sigs = b.signals.map((id) => SIGNALS.get(id));
    const editBar = `<div class="sd-edit sd-bar-edit"><span class="sd-grip" data-grip="${i}" title="Drag to move" aria-hidden="true">⠿</span>
      <button type="button" class="sd-btn" data-move="${i}" data-dir="-1" aria-label="Move left">‹</button><button type="button" class="sd-btn" data-move="${i}" data-dir="1" aria-label="Move right">›</button>
      <button type="button" class="sd-btn sd-x" data-remove="${i}" aria-label="Remove this block">×</button></div>`;
    const pick = editing ? `<div class="sd-edit sd-pick">${b.signals.map((id, k) => `<select data-pick="${i}" data-slot="${k}" aria-label="Stat ${k + 1}">${pickOption(id)}</select>`).join('')}</div>` : '';
    const label = (s, k = 0) => esc(s?.label || String(b.signals[k] || '?').replace(/^can\./, ''));
    if (b.type === 'small') {
      const s = sigs[0];
      return `<div class="sd-b sd-small" data-i="${i}">${editBar}<div><span class="sd-v" data-v="0"></span><span class="sd-u" data-u="0"></span></div><div class="sd-l">${label(s)}</div>${s?.bar ? '<div class="sd-bar"><i data-bar="0"></i></div>' : ''}${pick}</div>`;
    }
    if (b.type === 'wide') {
      return `<div class="sd-b sd-wide" data-i="${i}">${editBar}${sigs.map((s, k) => `<div class="sd-line"><span class="sd-l">${label(s, k)}</span><span><span class="sd-v" data-v="${k}"></span><span class="sd-u" data-u="${k}"></span></span></div>`).join('')}${pick}</div>`;
    }
    if (b.type === 'gauge') {
      return `<div class="sd-b sd-gauge" data-i="${i}">${editBar}<div class="sd-ring"><span class="sd-v" data-v="0"></span><span class="sd-u" data-u="0"></span><div class="sd-gears" data-gears></div></div><div class="sd-ap" data-ap></div>${pick}</div>`;
    }
    const s = sigs[0];
    const kindClass = /brake/i.test(s?.id) ? 'sd-brake' : /blink/i.test(s?.id) ? 'sd-blink' : /autopilot/i.test(s?.id) ? 'sd-ap' : '';
    return `<div class="sd-b sd-state ${kindClass}" data-i="${i}">${editBar}<span class="sd-ico" aria-hidden="true">${esc(s?.icon || '●')}</span><div class="sd-l">${label(s)}</div>${pick}</div>`;
  }
  function draw() {
    place();
    el.classList.toggle('editing', editing);
    if (hidden) {
      el.innerHTML = '<div class="sd-tools"><button type="button" class="sd-btn" data-show>Show car data</button></div>';
      applyFloat();
      return;
    }
    const boardsSel = state.boards.length > 1 || editing
      ? `<select data-board aria-label="Dashboard">${state.boards.map((x) => `<option value="${esc(x.id)}"${x.id === board.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : '';
    el.innerHTML = `<div class="sd-row" data-row>${board.blocks.map(blockHtml).join('') || '<span class="sd-none">No blocks: Customize to add some.</span>'}</div>
      <div class="sd-tools">${whereNow() === 'float' ? '<button type="button" class="sd-btn sd-move" data-move-bar aria-label="Move the car data: drag it, or use the arrow keys" title="Drag to move anywhere (arrow keys work too)">⠿ Move</button>' : ''}${boardsSel}
        <button type="button" class="sd-btn" data-edit aria-pressed="${editing}">${editing ? 'Done' : 'Customize'}</button>
        <span class="sd-edit" style="gap:6px;flex-wrap:wrap;align-items:center">
          <button type="button" class="sd-btn" data-add="small">+ Small</button><button type="button" class="sd-btn" data-add="wide">+ Wide (3)</button>
          <button type="button" class="sd-btn" data-add="gauge">+ Gauge</button><button type="button" class="sd-btn" data-add="state">+ Light</button>
          <select data-placement aria-label="Where the car data is">
            ${over ? '' : `<option value="below"${whereNow() === 'below' ? ' selected' : ''}>Below the cameras</option>`}
            <option value="over"${whereNow() === 'over' ? ' selected' : ''}>Over the video</option>
            <option value="float"${whereNow() === 'float' ? ' selected' : ''}>Anywhere (drag it)</option></select>
          <button type="button" class="sd-btn" data-units>${ctx().metric ? 'km/h' : 'mph'}</button>
          <button type="button" class="sd-btn" data-new>New dashboard</button><button type="button" class="sd-btn" data-rename>Rename</button>
          ${state.boards.length > 1 ? '<button type="button" class="sd-btn" data-delete>Delete</button>' : ''}
        </span>
        <span class="sd-sync" data-sync></span>
        <button type="button" class="sd-btn" data-raw aria-pressed="${rawView.open}" title="Every CAN message at this moment, decodable or not"${rawView.available ? '' : ' hidden'}>Raw</button>
        <button type="button" class="sd-btn sd-hide" data-hide aria-label="Hide the car data">Hide</button></div>`;
    syncNote();
    el.appendChild(rawView.el);
    tick(true);
    applyFloat();
  }
  const change = () => { saveBoards(state); draw(); };

  // values at the moment shown
  let lastKey = '';
  function tick(force = false) {
    if (!alive) return;
    const m = main();
    const path = frontPathOf([m, ...videos()].filter(Boolean));
    if (path && path !== recsFor) {
      recsFor = path;
      recs = null;
      recordsFor(path).then((r) => { if (alive && recsFor === path) { recs = r; tick(true); } });
    }
    if (path) { loadCan(path); rawView.setPath(path); }
    const ms = (m?.currentTime || 0) * 1000;
    const r = recs ? recordAt(recs, ms) : null;
    const key = `${r?.t ?? 'x'}|${recs ? 1 : 0}|${editing}|${can ? Math.floor(ms / 50) : ''}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    const c = ctx(ms);
    el.querySelectorAll('[data-i]').forEach((node) => {
      const b = board.blocks[Number(node.dataset.i)];
      if (!b) return;
      b.signals.forEach((id, k) => {
        const s = SIGNALS.get(id);
        const vEl = node.querySelector(`[data-v="${k}"]`);
        const uEl = node.querySelector(`[data-u="${k}"]`);
        const raw = s && (s.source === 'can' || r) ? s.value(r, c) : null;
        if (vEl) vEl.textContent = raw == null ? '—' : typeof raw === 'number' ? fmt(raw, s.digits ?? 1) : typeof raw === 'boolean' ? (raw ? 'On' : 'Off') : String(raw);
        if (uEl) uEl.textContent = raw == null || !s?.unit || typeof raw !== 'number' ? '' : s.unit(c);
        const bar = node.querySelector(`[data-bar="${k}"]`);
        if (bar && s?.bar) bar.style.width = `${Math.max(0, Math.min(1, r ? s.bar(r) : 0)) * 100}%`;
      });
      if (b.type === 'gauge') {
        const gear = r?.gear;
        node.querySelector('[data-gears]').innerHTML = ['P', 'R', 'N', 'D'].map((g) => (g === gear ? `<b>${g}</b>` : g)).join('');
        node.querySelector('[data-ap]').textContent = r?.autopilot || '';
      }
      if (b.type === 'state') {
        const s = SIGNALS.get(b.signals[0]);
        const on = Boolean(s && (s.source === 'can' || r) && (s.bool ? s.bool(r, c) : s.value(r, c)));
        node.classList.toggle('on', on);
        node.setAttribute('aria-label', `${s?.label || ''}: ${on ? 'on' : 'off'}`);
      }
    });
  }
  const loop = () => {
    if (!alive) return;
    tick();
    if (!hidden) rawView.tick((main()?.currentTime || 0) * 1000);
    raf = requestAnimationFrame(loop);
  };

  // editing
  el.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.matches('[data-edit]')) { editing = !editing; draw(); return; }
    if (t.matches('[data-raw]')) { rawView.toggle(); t.setAttribute('aria-pressed', String(rawView.open)); return; }
    if (t.matches('[data-hide]')) { hidden = true; editing = false; draw(); return; }
    if (t.matches('[data-show]')) { hidden = false; draw(); return; }
    if (t.matches('[data-add]')) {
      const type = t.dataset.add;
      board.blocks.push({ type, signals: DEFAULT_SIGNAL[type].slice(0, SLOTS[type]) });
      change();
      return;
    }
    if (t.matches('[data-remove]')) { board.blocks.splice(Number(t.dataset.remove), 1); change(); return; }
    if (t.matches('[data-move]')) {
      const i = Number(t.dataset.move);
      const j = i + Number(t.dataset.dir);
      if (j < 0 || j >= board.blocks.length) return;
      [board.blocks[i], board.blocks[j]] = [board.blocks[j], board.blocks[i]];
      change();
      el.querySelector(`[data-move="${j}"][data-dir="${t.dataset.dir}"]`)?.focus();
      return;
    }

    if (t.matches('[data-units]')) { board.metric = !ctx().metric; change(); return; }
    if (t.matches('[data-new]')) {
      const name = (prompt('Name of the new dashboard:', 'My dashboard') || '').trim().slice(0, 40);
      if (!name) return;
      const nb = { ...DEFAULT_BOARD(), id: Math.random().toString(36).slice(2, 10), name, blocks: [] };
      state.boards.push(nb);
      state.active = nb.id;
      board = nb;
      change();
      return;
    }
    if (t.matches('[data-rename]')) {
      const name = (prompt('Name of this dashboard:', board.name) || '').trim().slice(0, 40);
      if (name) { board.name = name; change(); }
      return;
    }
    if (t.matches('[data-delete]')) {
      if (!confirm(`Delete the dashboard "${board.name}"?`)) return;
      state.boards = state.boards.filter((x) => x !== board);
      board = state.boards[0];
      state.active = board.id;
      change();
    }
  });
  // a picker gets its full list as it is opened (a tap, a click or the keyboard)
  const onPickOpen = (e) => { const sel = e.target.closest?.('select[data-pick]'); if (sel) fillPick(sel); };
  el.addEventListener('pointerdown', onPickOpen);
  el.addEventListener('focusin', onPickOpen);
  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-board]')) {
      board = state.boards.find((x) => x.id === t.value) || board;
      state.active = board.id;
      change();
    } else if (t.matches('[data-pick]')) {
      const b = board.blocks[Number(t.dataset.pick)];
      if (b) { b.signals[Number(t.dataset.slot)] = t.value; change(); }
    } else if (t.matches('[data-placement]')) {
      board.placement = t.value;
      change();
      el.querySelector('[data-placement]')?.focus();
    }
  });
  // a floating bar moves with its Move handle: dragged (mouse or finger), or nudged with the arrow keys
  let barDrag = null;
  el.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('[data-move-bar]');
    if (!h || whereNow() !== 'float') return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    barDrag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    h.setPointerCapture?.(e.pointerId);
    el.classList.add('moving');
  });
  el.addEventListener('pointermove', (e) => {
    if (!barDrag || e.pointerId !== barDrag.id) return;
    barDrag.moved = true;
    const left = Math.max(0, Math.min(innerWidth - el.offsetWidth, e.clientX - barDrag.dx));
    const top = Math.max(0, Math.min(innerHeight - el.offsetHeight, e.clientY - barDrag.dy));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  });
  const endBarDrag = (e) => {
    if (!barDrag || e.pointerId !== barDrag.id) return;
    const moved = barDrag.moved;
    barDrag = null;
    el.classList.remove('moving');
    if (moved) keepFloat(parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0);
  };
  el.addEventListener('pointerup', endBarDrag);
  el.addEventListener('pointercancel', endBarDrag);
  el.addEventListener('keydown', (e) => {
    if (!e.target.closest?.('[data-move-bar]') || whereNow() !== 'float') return;
    const step = e.shiftKey ? 50 : 10;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    keepFloat(Math.max(0, Math.min(innerWidth - el.offsetWidth, r.left + d[0])), Math.max(0, Math.min(innerHeight - el.offsetHeight, r.top + d[1])));
  });
  // drag a block by its grip to move it
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip || !editing) return;
    e.preventDefault();
    drag = { from: Number(grip.dataset.grip), node: grip.closest('.sd-b'), id: e.pointerId };
    drag.node.classList.add('dragging');
    grip.setPointerCapture?.(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const over_ = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.sentry-sd .sd-b');
    if (!over_ || over_ === drag.node) return;
    const to = Number(over_.dataset.i);
    const [moved] = board.blocks.splice(drag.from, 1);
    board.blocks.splice(to, 0, moved);
    drag.from = to;
    draw();
    drag.node = el.querySelector(`[data-i="${to}"]`);
    drag.node?.classList.add('dragging');
  });
  const endDrag = () => { if (!drag) return; drag = null; el.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging')); change(); };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  // the dashboard's own keys and taps stay its own (the Viewer's shortcuts do not fire)
  el.addEventListener('keydown', (e) => e.stopPropagation());

  loadBoards().then((d) => {
    if (!alive) return;
    state = { boards: d.boards.map((x) => ({ ...DEFAULT_BOARD(), ...x, blocks: (x.blocks || []).filter((b) => SLOTS[b.type]).map((b) => ({ type: b.type, signals: [...(b.signals || [])].concat(DEFAULT_SIGNAL[b.type]).slice(0, SLOTS[b.type]).map((id) => (SIGNALS.has(id) || String(id).startsWith('can.') ? id : DEFAULT_SIGNAL[b.type][0])) })) })), active: d.active };
    board = state.boards.find((x) => x.id === state.active) || state.boards[0];
    draw();
    raf = requestAnimationFrame(loop);
  });
  return {
    el,
    destroy() { alive = false; cancelAnimationFrame(raf); clearTimeout(canRetry); removeEventListener('resize', onResize); rawView.destroy(); el.remove(); }
  };
}
