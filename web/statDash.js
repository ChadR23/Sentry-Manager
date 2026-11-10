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
// Both boxes (the bar and the "Every stat" list) have a Move handle and a
// resize grip at all times: dragged (mouse, pen or finger) or moved with the
// keys, a box leaves its place and floats on the PAGE where it is dropped (it
// scrolls with what is under it); "Put back" / "Dock" returns it. Spots and
// sizes are kept per dashboard, one for wide screens and one for narrow ones;
// a spot is kept relative to the cameras, so a resized window keeps each box
// in its place in the Viewer's layout (see placeFor).
//
// The data comes from the front camera's per-frame record (GET
// /api/telemetry: Tesla's SeiMetadata). CAN signals from the CAN Bridge join
// the same list later (registerSignals), with nothing else to change.
//
// The stats people most like to see (speed, battery %, range, power, ...:
// POPULAR) come first in the "List" box and the stat picker, under
// "Popular", each once; then every other stat, by group.
//
// "Raw" (when the clip has CAN data) opens the nerd raw view under the blocks:
// every CAN id at the moment shown, known to the DBC or not, with the bytes
// that changed in the last half second lit up (createRawView).
//
//   const dash = attachStatDash({ stage, videos: () => [...], main: () => video, over: false });
//   dash.destroy();
//
// Battery power, charging power, efficiency and the like are worked out from
// the car's own signals (web/carCalc.js, shared with the decoded CSV export):
// "Computed" stats, each fetching the CAN signals it needs.

import '/web/carCalc.js';

const STYLE = `
.sentry-sd{--sd-bg:rgba(18,20,24,.86);--sd-tile:rgba(255,255,255,.07);--sd-line:rgba(255,255,255,.14);--sd-fg:#f2f4f7;--sd-dim:rgba(242,244,247,.78);--sd-on:#43d17a;--sd-amber:#ffb547;--sd-blue:#4aa8ff;
  box-sizing:border-box;color:var(--sd-fg);font:14px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none}
.sentry-sd *{box-sizing:border-box}
.sentry-sd.below{position:relative;margin:8px 0;background:var(--sd-bg);border:1px solid var(--sd-line);border-radius:18px;padding:8px}
.sentry-sd.float{position:absolute;z-index:2147482000;left:0;top:0;max-width:min(96vw,1180px);background:rgba(18,20,24,.97);border:1px solid var(--sd-line);border-radius:16px;padding:6px;box-shadow:0 12px 32px rgba(0,0,0,.45)}
.sentry-sd.moving{opacity:.92;box-shadow:0 16px 40px rgba(0,0,0,.6)}
.sentry-sd.over{position:absolute;left:8px;right:8px;bottom:8px;z-index:11;background:rgba(10,12,15,.55);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border-radius:16px;padding:6px;pointer-events:auto}
/* (no taller than the cameras: Customize's tools scroll in it instead of going past their top;
   while customizing it is over the Viewer's own floating panels (Clips, map, dashboard), which hid Done) */
.sentry-sd.over{max-height:calc(100% - 16px);overflow-y:auto}
.sentry-sd.over.editing{z-index:102}
.sentry-sd .sd-row{display:flex;flex-wrap:wrap;gap:6px;align-items:stretch}
.sentry-sd .sd-b{position:relative;background:var(--sd-tile);border:1px solid var(--sd-line);border-radius:12px;padding:8px 12px;min-height:64px;display:flex;flex-direction:column;justify-content:center}
.sentry-sd .sd-small{flex:1 1 104px;max-width:170px;align-items:center;text-align:center}
.sentry-sd .sd-wide{flex:2 1 220px;max-width:340px;gap:2px}
.sentry-sd .sd-gauge{flex:0 0 132px;align-items:center;text-align:center;padding:6px}
.sentry-sd .sd-state{flex:0 1 92px;align-items:center;text-align:center}
.sentry-sd .sd-v{font-weight:800;font-size:24px;letter-spacing:-.01em;font-variant-numeric:tabular-nums;white-space:nowrap}
.sentry-sd .sd-u{font-weight:600;font-size:13px;color:var(--sd-dim);margin-left:2px}
.sentry-sd .sd-l{font-size:14px;color:var(--sd-dim);font-weight:600;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.sentry-sd .sd-line{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:3px 0;border-top:1px solid var(--sd-line)}
.sentry-sd .sd-line:first-child{border-top:0}
.sentry-sd .sd-line .sd-v{font-size:18px}
.sentry-sd .sd-line .sd-l{margin:0;font-size:14px;color:var(--sd-fg)}
.sentry-sd .sd-ring{width:96px;height:96px;border-radius:50%;border:2px solid var(--sd-line);display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(circle,rgba(255,255,255,.05),transparent 70%)}
.sentry-sd .sd-ring .sd-v{font-size:30px;line-height:1}
.sentry-sd .sd-gears{font:700 14px/1.4 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.2em;color:var(--sd-dim);margin-top:4px}
.sentry-sd .sd-gears b{color:var(--sd-fg);background:rgba(255,255,255,.18);border-radius:3px;padding:0 1px}
.sentry-sd .sd-ap{font-size:13px;font-weight:700;color:var(--sd-blue);min-height:14px;margin-top:2px}
.sentry-sd .sd-ico{font-size:24px;line-height:1;opacity:.28;transition:opacity .08s}
.sentry-sd .sd-state.on .sd-ico{opacity:1}
.sentry-sd .sd-state.on.sd-brake .sd-ico{color:#ff5d5d}
.sentry-sd .sd-state.on.sd-blink .sd-ico{color:var(--sd-on)}
.sentry-sd .sd-state.on.sd-ap .sd-ico{color:var(--sd-blue)}
.sentry-sd .sd-bar{height:4px;border-radius:2px;background:var(--sd-line);margin-top:5px;width:100%;overflow:hidden}
.sentry-sd .sd-bar i{display:block;height:100%;background:var(--sd-on);width:0}
.sentry-sd .sd-tools{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px}
.sentry-sd.over .sd-tools{margin-top:4px}
.sentry-sd button.sd-btn,.sentry-sd select{all:unset;box-sizing:border-box;cursor:pointer;padding:4px 10px;border-radius:8px;border:1px solid var(--sd-line);background:rgba(255,255,255,.06);color:var(--sd-fg);font:600 14px/1.6 system-ui,sans-serif;max-width:100%}
.sentry-sd select{padding-right:22px;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 12px) 55%,calc(100% - 7px) 55%;background-size:5px 5px;background-repeat:no-repeat}
.sentry-sd select option{color:#111;background:#fff}
.sentry-sd button.sd-btn:focus-visible,.sentry-sd select:focus-visible{outline:2px solid var(--sd-blue);outline-offset:2px}
.sentry-sd button.sd-btn[aria-pressed="true"]{background:rgba(74,168,255,.25);border-color:var(--sd-blue)}
.sentry-sd button.sd-btn.sd-move{cursor:grab;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.sentry-sd button.sd-btn.sd-move:active,.sentry-sd.moving button.sd-btn.sd-move{cursor:grabbing}
.sentry-sd button.sd-btn.sd-size{position:absolute;right:3px;bottom:3px;z-index:3;width:26px;height:26px;padding:0;display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1;color:var(--sd-dim);background:rgba(255,255,255,.06);border-color:transparent;border-radius:7px 7px 13px 7px;cursor:nwse-resize;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.sentry-sd.over > button.sd-btn.sd-size{bottom:auto;top:3px;border-radius:7px 13px 7px 7px;cursor:nesw-resize}
.sentry-sd button.sd-btn.sd-size:hover,.sentry-sd.sizing button.sd-btn.sd-size{color:var(--sd-fg);background:rgba(255,255,255,.16)}
.sentry-sd:not(.sd-listpanel):not(.over) > .sd-tools{padding-right:30px}
.sentry-sd.over:not(.sd-listpanel) > .sd-row{padding-right:30px}
.sentry-sd.sizing{opacity:.95}
.sentry-sd.sized:not(.sd-listpanel){display:flex;flex-direction:column}
.sentry-sd.sized:not(.sd-listpanel) > .sd-row{flex:1 1 auto;min-height:36px;overflow:auto;align-content:flex-start;overscroll-behavior:contain}
.sentry-sd.sized:not(.sd-listpanel) > .sd-tools,.sentry-sd.sized:not(.sd-listpanel) > .sd-raw{flex:0 0 auto}
.sentry-sd:not(.editing) .sd-edit{display:none!important}
.sentry-sd.editing .sd-edit{display:flex}
.sentry-sd.editing .sd-b{padding-top:30px;border-style:dashed}
.sentry-sd .sd-bar-edit{position:absolute;left:4px;right:4px;top:4px;gap:3px;align-items:center}
.sentry-sd .sd-bar-edit .sd-btn{padding:0 7px;line-height:1.5}
.sentry-sd.editing .sd-small,.sentry-sd.editing .sd-state{min-width:124px}
.sentry-sd .sd-grip{cursor:grab;touch-action:none;padding:2px 6px;border-radius:6px;font-size:13px;color:var(--sd-dim)}
.sentry-sd .sd-grip:active{cursor:grabbing}
.sentry-sd .sd-x{margin-left:auto}
.sentry-sd .sd-b.dragging{opacity:.4}
.sentry-sd .sd-pick{display:flex;flex-direction:column;gap:4px;margin-top:6px;width:100%}
.sentry-sd .sd-pickbtn{display:block;width:100%;padding:4px 8px;font-size:13px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sentry-sd .sd-pickbtn::before{content:'⌕ ';color:var(--sd-dim)}
.sentry-sd .sd-none{color:var(--sd-dim);font-size:14px;padding:4px 6px}
.sentry-sd .sd-hide{margin-left:auto}
.sentry-sd .sd-sync{font-size:13px;color:var(--sd-dim);white-space:nowrap}
.sentry-sd .sd-sync.sd-warn{color:var(--sd-amber);font-weight:700}
.sentry-sd button.sd-btn[hidden]{display:none}
.sentry-sd .sd-raw{margin-top:6px;min-width:0;max-width:100%;-webkit-user-select:text;user-select:text}
.sentry-sd .sd-raw[hidden]{display:none}
.sentry-sd .sd-raw.sd-raw-loading .sd-raw-scroll{opacity:.5}
.sentry-sd .sd-raw-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}
.sentry-sd .sd-raw-bar input{all:unset;box-sizing:border-box;flex:1 1 140px;min-width:0;max-width:260px;padding:4px 10px;border-radius:8px;border:1px solid var(--sd-line);background:rgba(255,255,255,.06);color:var(--sd-fg);font:600 14px/1.6 system-ui,sans-serif}
.sentry-sd .sd-raw-bar input:focus-visible{outline:2px solid var(--sd-blue);outline-offset:2px}
.sentry-sd .sd-raw-n{font-size:13px;color:var(--sd-dim)}
.sentry-sd .sd-raw-scroll{overflow:auto;max-height:46vh;max-width:100%;background:var(--sd-tile);border:1px solid var(--sd-line);border-radius:12px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
.sentry-sd.over .sd-raw-scroll{max-height:30vh}
.sentry-sd .sd-raw table{border-collapse:collapse;width:100%;font:13px/1.4 ui-monospace,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
.sentry-sd .sd-raw th{position:sticky;top:0;background:#1d2026;color:var(--sd-dim);font:700 12px/1.6 system-ui,sans-serif;text-align:left;padding:4px 8px;white-space:nowrap}
.sentry-sd .sd-raw td{padding:2px 8px;border-top:1px solid var(--sd-line);white-space:nowrap}
.sentry-sd .sd-raw td.sd-raw-hz{text-align:right;color:var(--sd-dim)}
.sentry-sd .sd-raw td.sd-raw-p{width:100%}
.sentry-sd .sd-raw td.sd-raw-name{font-family:system-ui,sans-serif;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.sentry-sd .sd-raw td.sd-raw-name.unknown{color:var(--sd-amber);font-style:italic}
.sentry-sd .sd-raw .sd-raw-p i{font-style:normal;padding:0 2px;border-radius:3px;margin-right:1px}
.sentry-sd .sd-raw .sd-raw-p i.hot{background:var(--sd-amber);color:#111}
.sentry-sd .sd-raw .sd-raw-p.none{color:var(--sd-dim)}
.sentry-sd.sd-pop{position:fixed;z-index:2147483000;left:8px;top:8px;width:min(400px,calc(100vw - 16px));display:flex;flex-direction:column;gap:6px;padding:8px;background:#15171c;border:1px solid rgba(255,255,255,.24);border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.6)}
.sentry-sd.sd-pop input{all:unset;box-sizing:border-box;width:100%;padding:9px 12px;border-radius:10px;border:1px solid var(--sd-line);background:rgba(255,255,255,.08);color:var(--sd-fg);font:600 16px/1.4 system-ui,sans-serif;-webkit-user-select:text;user-select:text}
.sentry-sd.sd-pop input:focus-visible{outline:2px solid var(--sd-blue);outline-offset:1px}
.sentry-sd .sd-pop-n{font-size:13px;color:var(--sd-dim);padding:0 4px}
.sentry-sd .sd-pop-list{list-style:none;margin:0;padding:0;overflow:auto;max-height:50vh;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.sentry-sd .sd-pop-g{position:sticky;top:0;z-index:1;background:#15171c;font:800 12px/1.8 system-ui,sans-serif;color:var(--sd-amber);letter-spacing:.04em;padding:6px 10px 2px}
.sentry-sd .sd-pop-o{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:9px 10px;border-radius:8px;cursor:pointer;font:500 15px/1.3 system-ui,sans-serif;color:var(--sd-fg)}
.sentry-sd .sd-pop-o small{font-size:12px;color:var(--sd-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%;flex:0 1 auto}
.sentry-sd .sd-pop-o:hover{background:rgba(255,255,255,.08)}
.sentry-sd .sd-pop-o[aria-selected="true"]{background:rgba(74,168,255,.3)}
.sentry-sd .sd-pop-o.cur{color:var(--sd-blue);font-weight:800}
.sentry-sd .sd-pop-o.cur::after{content:'✓';margin-left:auto}
.sentry-sd .sd-pop-none{padding:10px;color:var(--sd-dim);font-size:14px}
.sentry-sd .sd-row:has(.sd-list){align-items:flex-start}
.sentry-sd.sd-listpanel.below{position:relative;margin:8px 0;background:var(--sd-bg);border:1px solid var(--sd-line);border-radius:18px;padding:8px}
.sentry-sd.sd-listpanel.float{position:absolute;z-index:2147481900;left:0;top:0;width:min(560px,calc(100vw - 16px));background:rgba(18,20,24,.97);border:1px solid var(--sd-line);border-radius:16px;padding:6px;box-shadow:0 12px 32px rgba(0,0,0,.45)}
.sentry-sd.sd-listpanel.moving{opacity:.92}
.sentry-sd.sd-listpanel.below,.sentry-sd.sd-listpanel.float{padding-bottom:30px}
.sentry-sd.sd-listpanel.sized{display:flex;flex-direction:column}
.sentry-sd.sd-listpanel.sized > .sd-row{flex:1 1 auto;min-height:0;align-items:stretch}
.sentry-sd.sd-listpanel.sized .sd-list-scroll{height:auto;flex:1 1 0;min-height:60px}
.sentry-sd .sd-listhead{margin:0 0 6px}
.sentry-sd .sd-listtitle{font-size:14px;font-weight:800}
.sentry-sd.sd-listpanel .sd-list{max-width:none}
.sentry-sd.sd-listpanel.below .sd-list{max-width:760px}
.sentry-sd .sd-list{flex:1 1 340px;max-width:620px;padding:8px;justify-content:flex-start;gap:6px}
.sentry-sd .sd-list-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sentry-sd .sd-list-bar input[type=search]{all:unset;box-sizing:border-box;flex:1 1 140px;min-width:0;padding:5px 10px;border-radius:8px;border:1px solid var(--sd-line);background:rgba(255,255,255,.06);color:var(--sd-fg);font:600 14px/1.5 system-ui,sans-serif;-webkit-user-select:text;user-select:text}
.sentry-sd .sd-list-bar input[type=search]:focus-visible{outline:2px solid var(--sd-blue);outline-offset:1px}
.sentry-sd .sd-list-ch{font-size:13px;color:var(--sd-dim);display:flex;gap:5px;align-items:center;cursor:pointer;white-space:nowrap}
.sentry-sd .sd-list-n{font-size:12px;color:var(--sd-dim);white-space:nowrap}
.sentry-sd .sd-list-scroll{position:relative;overflow:auto;height:min(452px,48vh);border:1px solid var(--sd-line);border-radius:10px;background:rgba(0,0,0,.22);overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.sentry-sd.over .sd-list-scroll{height:min(302px,32vh)}
.sentry-sd .sd-list-scroll:focus-visible{outline:2px solid var(--sd-blue);outline-offset:1px}
.sentry-sd .sd-list-pad{position:relative}
.sentry-sd .sd-list-r{position:absolute;left:0;right:0;height:30px;display:flex;align-items:center;gap:10px;padding:0 10px;border-bottom:1px solid rgba(255,255,255,.06)}
.sentry-sd .sd-list-l{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600}
.sentry-sd .sd-list-m{flex:0 1 30%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--sd-dim)}
.sentry-sd .sd-list-v{flex:0 0 auto;min-width:88px;text-align:right;font:700 14px/1 ui-monospace,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;border-radius:4px;padding:4px 5px;transition:background .5s}
.sentry-sd .sd-list-v small{font:600 12px/1 system-ui,sans-serif;color:var(--sd-dim);margin-left:3px}
.sentry-sd .sd-list-r.hot .sd-list-v{background:rgba(255,181,71,.4);transition:none}
.sentry-sd .sd-list-h{border-bottom-color:var(--sd-line);background:#1d2026}
.sentry-sd .sd-list-h .sd-list-l{font:800 12px/1 system-ui,sans-serif;color:var(--sd-amber);letter-spacing:.04em;text-transform:uppercase}
.sentry-sd .sd-list-empty{padding:12px;color:var(--sd-dim);font-size:14px}
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
  KPH: { metric: ['km/h', (v) => v], imperial: ['mph', (v) => v / 1.609344] },
  km: { metric: ['km', (v) => v], imperial: ['mi', (v) => v / 1.609344] },
  KM: { metric: ['km', (v) => v], imperial: ['mi', (v) => v / 1.609344] },
  mi: { metric: ['km', (v) => v * 1.609344], imperial: ['mi', (v) => v] },
  M: { metric: ['m', (v) => v], imperial: ['ft', (v) => v * 3.28084] },
  m: { metric: ['m', (v) => v], imperial: ['ft', (v) => v * 3.28084] },
  'm/s': { metric: ['km/h', (v) => v * MPS_KMH], imperial: ['mph', (v) => v * MPS_MPH] },
  mph: { metric: ['km/h', (v) => v * 1.609344], imperial: ['mph', (v) => v] },
  MPH: { metric: ['km/h', (v) => v * 1.609344], imperial: ['mph', (v) => v] },
  'km/hr': { metric: ['km/h', (v) => v], imperial: ['mph', (v) => v / 1.609344] },
  deg: { metric: ['°', (v) => v], imperial: ['°', (v) => v] },
  Deg: { metric: ['°', (v) => v], imperial: ['°', (v) => v] },
  KWh: { metric: ['kWh', (v) => v], imperial: ['kWh', (v) => v] },
  kWh: { metric: ['kWh', (v) => v], imperial: ['kWh', (v) => v] },
  NM: { metric: ['Nm', (v) => v], imperial: ['Nm', (v) => v] },
  kPa: { metric: ['kPa', (v) => v], imperial: ['psi', (v) => v * 0.1450377] },
  bar: { metric: ['bar', (v) => v], imperial: ['psi', (v) => v * 14.50377] }
};
// ---- computed stats (web/carCalc.js): each from the CAN signals it `needs` (the bar
// fetches them with it; the List has them all), counted as there when its inputs are
const CALC_UNITS = {
  kW: () => ['kW', (v) => v],
  W: () => ['W', (v) => v],
  kWh: () => ['kWh', (v) => v],
  C: (m) => CAN_UNITS.C[m ? 'metric' : 'imperial'],
  Cdelta: (m) => (m ? ['°C', (v) => v] : ['°F', (v) => v * 1.8]),
  'Wh/mi': (m) => (m ? ['Wh/km', (v) => v / 1.609344] : ['Wh/mi', (v) => v]),
  mi: (m) => (m ? ['km', (v) => v * 1.609344] : ['mi', (v) => v])
};
registerSignals((globalThis.SentryCarCalc?.CALCS || []).map((d) => {
  const conv = CALC_UNITS[d.unit];
  const inputs = d.uses.flat();
  return {
    id: d.id, label: d.label, group: 'Computed', kind: conv ? 'number' : 'text', source: 'calc', about: d.about,
    uses: d.uses, inputs: [...new Set([...inputs, ...(d.also || [])])], needs: [...new Set([...inputs, ...(d.also || [])])],
    unit: (c) => (conv ? conv(c.metric)[0] : ''),
    value: (r, c) => {
      const v = d.value(c.can, d.window ? { at: c.canAt, since: c.since } : null);
      if (v == null) return null;
      return conv && typeof v === 'number' ? conv(c.metric)[1](v) : v;
    },
    digits: d.digits ?? 1
  };
}));
// a speed in the car's own units ("kph/mph": a speed limit, a set offset): UI_mapSpeedLimitUnits says which (0 mph, 1 km/h)
const CAR_UNITS = 'UI_mapSpeedLimitUnits';
function carSpeed(c, v) {
  const u = c.can(CAR_UNITS);
  if (u == null) return [v, 'km/h or mph'];
  const kmh = u === 1 ? v : v * 1.609344;
  return c.metric ? [kmh, 'km/h'] : [kmh / 1.609344, 'mph'];
}
// value names that mean "no value" (the signal is not available): shown as no data; a number's
// NONE or UNKNOWN too (a speed limit's 31 "NONE" is no limit, not 155), a state's stays a word
const SNA_NAME = /(^|_)SNA($|_)|^(INVALID|UNAVAILABLE|NOT_?AVAILABLE)$/i;
const NO_NUMBER = /^(NONE|UNKNOWN)$/i;
/** How many decimals a signal's value is shown with: from its step (the DBC factor), else from its range. */
function canDigits(m) {
  const f = Math.abs(Number(m.factor));
  if (Number.isFinite(f) && f > 0) return f >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(f) - 1e-9));
  return Math.abs((m.max ?? 0) - (m.min ?? 0)) > 200 ? 0 : 1;
}
/** A series' value at `ms`: [[ms, value], …] pairs, or { t: Float64Array, v } columns (the List's answer). */
const canSeriesAt = (pts, ms) => {
  if (pts && !Array.isArray(pts)) {
    const { t, v } = pts;
    if (!t.length || ms < t[0]) return null;
    let lo = 0;
    let hi = t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t[mid] <= ms) lo = mid; else hi = mid - 1;
    }
    return v[lo];
  }
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
// ---- value names in plain words: BMS_CHARGE_COMPLETE "Charge complete", LIGHT_OFF and
// BRAKES_NOT_APPLIED "Off" (the DBC's own name stays in the tooltip)
const ACRONYMS = new Set(['AC', 'DC', 'HV', 'LV', 'EVSE', 'PCS', 'BMS', 'DI', 'UI', 'FL', 'FR', 'RL', 'RR', 'CAN', 'USB', 'GPS', 'ABS', 'ESP', 'TPMS', 'AP', 'FSD', 'ID', 'OTA', 'PTC', 'HVAC', 'DCDC', 'SOC', 'LED', 'ECU', 'VIN', 'ACC', 'TC', 'NA', 'EU', 'US', 'CN']);
const OFF_NAME = /^(OFF|DISABLED|INACTIVE|NOT_ACTIVE|NOT_APPLIED|NONE_APPLIED)$|_(OFF|NOT_APPLIED)$/;
const ON_NAME = /^(ON|ENABLED|ACTIVE|APPLIED)$|_(ON|APPLIED)$/;
/** One value name in words, after the words every name of the signal starts with (`drop`). */
function prettyName(name, drop = 0) {
  const raw = String(name);
  if (!/^[A-Z0-9_]+$/.test(raw)) return raw; // (already words: "Error", "12vChg")
  const words = raw.split('_').filter(Boolean).slice(drop);
  const rest = words.join('_');
  if (OFF_NAME.test(rest)) return 'Off';
  if (ON_NAME.test(rest)) return 'On';
  const out = words.map((w, k) => (ACRONYMS.has(w) || /\d/.test(w) ? w : k ? w.toLowerCase() : w[0] + w.slice(1).toLowerCase())).join(' ');
  return out || raw;
}
/** A signal's value names in words: { raw value: words }, the words every name starts with left out. */
export function prettyNames(named) {
  const names = Object.values(named || {}).filter((t) => !SNA_NAME.test(t) && /^[A-Z0-9_]+$/.test(t));
  let drop = 0;
  if (names.length >= 2) {
    const split = names.map((t) => t.split('_').filter(Boolean));
    while (split.every((w) => w.length > drop + 1 && w[drop] === split[0][drop])) drop++;
  }
  return Object.fromEntries(Object.entries(named || {}).map(([k, t]) => [k, SNA_NAME.test(t) ? t : prettyName(t, drop)]));
}
function registerCanSignals(meta) {
  const list = [];
  for (const [name, m] of Object.entries(meta || {})) {
    const id = `can.${name}`;
    if (SIGNALS.has(id)) continue;
    const conv = CAN_UNITS[m.unit];
    const speedInCarUnits = m.unit === 'kph/mph';
    const named = m.values && Object.keys(m.values).length ? m.values : null;
    const span = Number.isFinite(m.max) && Number.isFinite(m.min) ? m.max - m.min : Infinity;
    // (the raw value under a scaled one: what the value names are for; known when the index says the scale)
    const scaled = Number.isFinite(m.factor) && m.factor !== 0;
    const rawOf = (v) => (scaled ? Math.round((v - (m.offset || 0)) / m.factor) : Math.round(v));
    const rawsNamed = (re) => new Set(Object.entries(named || {}).filter(([, t]) => re.test(t)).map(([k]) => Number(k)));
    const sna = rawsNamed(SNA_NAME);
    // words only for a state (a gear, a mode): a small range of whole steps with names for its
    // values; a number with a name for one special value (SNA: not available) stays a number
    // (a tire pressure has names too: 255 "SNA"; read as words it showed "3.2" with no unit)
    const states = named ? Object.keys(named).filter((k) => !sna.has(Number(k))).length : 0;
    const allNamed = Boolean(named) && span <= 16 && (scaled ? Math.abs(m.factor) === 1 && states >= 2 : true);
    // the raw values that mean "no value": no data, not a number (or a word)
    const noValue = allNamed ? sna : new Set([...sna, ...rawsNamed(NO_NUMBER)]);
    const words = allNamed ? prettyNames(named) : null;
    // (a popular stat's signal with no readable name of its own, SOCUI292, takes the popular name;
    // a series named after its message too, UI_cpuTemperature_353, is read by its signal's name)
    const own = canLabel(m.signal || name, m.label);
    const label = own === (m.signal || name) && POPULAR_NAME.has(id) ? POPULAR_NAME.get(id) : own;
    list.push({
      id, label, group: `CAN · ${String(m.bus || '').replace(/Bus$/, '') || 'bus'} · ${String(m.message || '').replace(/^ID[0-9A-F]+/, '') || 'message'}`,
      kind: allNamed ? 'text' : 'number', source: 'can', canName: name,
      // (a speed in the car's units needs the signal that says which)
      ...(speedInCarUnits ? { needs: [CAR_UNITS] } : {}),
      unit: (c) => (speedInCarUnits ? carSpeed(c, 0)[1] : conv ? conv[c.metric ? 'metric' : 'imperial'][0] : m.unit || ''),
      value: (r, c) => {
        const v = c.can(name);
        if (v == null || noValue.has(rawOf(v))) return null;
        // (value names are for raw values: used for named states, whose scale is 1)
        if (allNamed) return words[String(rawOf(v))] ?? String(v);
        if (speedInCarUnits) return carSpeed(c, v)[0];
        return conv ? conv[c.metric ? 'metric' : 'imperial'][1](v) : v;
      },
      // (the DBC's own name for the value shown, for the tooltip)
      rawName: allNamed ? (r, c) => { const v = c.can(name); return v == null ? null : named[String(rawOf(v))] ?? null; } : null,
      bool: (r, c) => { const v = c.can(name); return v != null && v !== 0 && !noValue.has(rawOf(v)); },
      digits: canDigits(m)
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

// ---- the stats people most like to see (what Tesla dash apps put first),
// shown first in the List and the picker, in this order. Each is a name and
// the ids that can give it, best first: the first one there wins (a built-in
// stat, else the CAN signal; a car whose DBC names differ still gets the
// stat from the next id). The one chosen is shown once, at the top, and not
// again below; the others stay in their own group. Ids from model3dbc's
// Model3CAN.dbc with the firmware overrides (server/dbc), checked against a
// 2026 Model Y's logs: a signal whose layout is not known on newer firmware
// (the 0x312 pack temperatures, the 0x3FE brake temperatures) is not here,
// nor is the GPS position (0x04F, on the Model Y from the Screenmate's can3):
// raw latitude and longitude are no stat to watch; they are in the full list.
// A name in two messages has the message id after it (RCM_longitudinalAccel_111).
// Battery power, efficiency, charging power and the like have no one signal:
// they are worked out from others (calc.*, web/carCalc.js).
// A legacy Model S or X (2012-2020) has other messages for the same stats
// (server/dbc/sx-legacy.dbc, opendbc's): each stat lists them after the Model
// 3/Y ones, so the first one a car has is the one shown (DI_vehicleSpeed_116:
// the powertrain bus's, then the chassis bus's copy).
const POPULAR = [
  ['Speed', 'dash.speed', 'can.DI_vehicleSpeed', 'can.DI_vehicleSpeed_116', 'can.DI_vehicleSpeed_118', 'can.UI_gpsVehicleSpeed'],
  ['Battery %', 'can.SOCUI292', 'can.UI_SOC', 'can.SOCave292', 'can.SOCUI302'],
  ['Range', 'can.UI_Range', 'can.UI_idealRange', 'can.RatedRange338', 'can.IdealRange338'],
  ['Battery power', 'calc.batteryPower'],
  ['Efficiency now', 'calc.efficiency'],
  ['Range at this efficiency', 'calc.rangeNow'],
  ['Rear motor power', 'can.RearPower266'],
  ['Front motor power', 'can.FrontPower2E5'],
  ['Drive power', 'calc.drivePower'],
  ['Regen power', 'calc.regenPower'],
  ['Energy used (this clip)', 'calc.energyClip'],
  ['Gear', 'dash.gear', 'can.DI_gear', 'can.DI_gear_116', 'can.DI_gear_118'],
  ['Accelerator', 'dash.accelerator', 'can.DI_accelPedalPos', 'can.DI_pedalPos_106', 'can.DI_pedalPos_108'],
  ['Brake', 'dash.brake', 'can.DI_brakePedalState', 'can.IBST_driverBrakeApply', 'can.ESP_driverBrakeApply', 'can.DI_brakePedalState_116', 'can.DI_brakePedalState_118'],
  ['Steering', 'dash.steering', 'can.SteeringAngle129', 'can.StW_Angl'],
  ['Autopilot', 'dash.autopilot', 'can.DAS_autopilotState'],
  ['Left blinker', 'dash.blinkLeft', 'can.VCFRONT_turnSignalLeftStatus', 'can.VCLEFT_turnSignalStatus'],
  ['Right blinker', 'dash.blinkRight', 'can.VCFRONT_turnSignalRightStatus', 'can.VCRIGHT_turnSignalStatus'],
  ['Battery voltage', 'can.BattVoltage132', 'can.BattVoltage102'],
  ['Battery current', 'can.SmoothBattCurrent132', 'can.RawBattCurrent132'],
  ['Battery temp', 'calc.battTemp', 'can.BattTemp102'],
  ['Battery temp (max)', 'can.BattBrickTempMax332'],
  ['Battery temp (min)', 'can.BattBrickTempMin332'],
  ['Battery temp spread', 'calc.battTempSpread'],
  ['Outside temp', 'can.VCFRONT_tempAmbientFiltered', 'can.VCFRONT_tempAmbient', 'can.VCRIGHT_tempAmbientRaw'],
  ['Cabin temp', 'can.VCRIGHT_hvacCabinTempEst'],
  ['Battery coolant temp', 'can.VCFRONT_tempCoolantBatInlet'],
  ['Powertrain coolant temp', 'can.VCFRONT_tempCoolantPTInlet'],
  ['12V battery', 'can.v12vBattVoltage261'],
  ['12V battery power', 'calc.lv12Power'],
  ['12V battery state', 'calc.lv12State'],
  ['12V battery temp', 'can.v12vBattTemp261'],
  ['Rear motor torque', 'can.DIR_torqueActual', 'can.RearTorque1D8'],
  ['Front motor torque', 'can.DIF_torqueActual', 'can.FrontTorque1D5'],
  // (the hottest part each drive unit reports: its stator's end winding)
  ['Rear motor temp', 'can.DIR_statorEndWindingTemp', 'can.MotorTemp306'],
  ['Front motor temp', 'can.DIF_statorEndWindingTemp'],
  ['Odometer', 'can.UI_odometer', 'can.Odometer3B6', 'can.Odometer5D8'],
  // (a sensor slot, not a fixed wheel: which wheel each is, is not known yet on newer firmware)
  ['Tire pressure 1', 'can.VCSEC_TPMSPressure0', 'can.TPMSFLpressure31F'],
  ['Tire pressure 2', 'can.VCSEC_TPMSPressure1', 'can.TPMSFRpressure31F'],
  ['Tire pressure 3', 'can.VCSEC_TPMSPressure2', 'can.TPMSRLpressure31F'],
  ['Tire pressure 4', 'can.VCSEC_TPMSPressure3', 'can.TPMSRRpressure31F'],
  ['Charging', 'can.BMS_uiChargeStatus', 'can.CP_hvChargeStatus_13D', 'can.CP_hvChargeStatus_23D', 'can.PCS_hvChargeStatus'],
  ['Charging power', 'calc.chargingPower', 'can.ChargerPower222'],
  ['DC charger power', 'calc.dcChargerPower'],
  ['Charge time left', 'can.ChargeHoursRemaining132'],
  ['Energy remaining', 'can.BMS_nominalEnergyRemaining', 'can.BMS_expectedEnergyRemaining'],
  ['Full pack energy', 'can.BMS_nominalFullPackEnergy'],
  ['Heading', 'dash.heading', 'can.UI_gpsVehicleHeading'],
  ['Elevation', 'can.Elevation3D8'],
  ['Accel (fwd)', 'dash.accelLong', 'can.RCM_longitudinalAccel_111', 'can.RCM_longitudinalAccel_116'],
  ['Accel (side)', 'dash.accelLat', 'can.RCM_lateralAccel_111', 'can.RCM_lateralAccel_116'],
  ['Set speed', 'can.DAS_setSpeed', 'can.DAS_setSpeed_2BF', 'can.DAS_setSpeed_2B9'],
  ['Speed limit', 'can.DAS_fusedSpeedLimit', 'can.UI_mppSpeedLimit'],
  ['Latitude', 'dash.lat'],
  ['Longitude', 'dash.lon'],
  ['Lifetime charged', 'can.TotalChargeKWh3D2'],
  ['Lifetime used', 'can.TotalDischargeKWh3D2']
].map(([name, ...ids]) => ({ name, ids }));
const POPULAR_NAME = new Map(POPULAR.flatMap((p) => p.ids.map((id) => [id, p.name])));
/**
 * The popular stats, in order: for each, the first of its ids there (and
 * with ok(s), e.g. "has data in this clip"), as a copy of the signal named
 * the popular way, popular: its place. Everything else of the signal (id,
 * value, unit) is its own.
 */
function popularSignals(ok = () => true) {
  const out = [];
  POPULAR.forEach((p, k) => {
    for (const id of p.ids) {
      const s = SIGNALS.get(id);
      if (!s || !ok(s)) continue;
      out.push({ ...s, label: p.name, ownLabel: s.label === p.name ? s.canName || s.label : s.label, popular: k + 1 });
      break;
    }
  });
  return out;
}
let grouped = { v: -1, list: [] };
/** Every signal, its group's together (the order the picker shows with no search), built once per change of SIGNALS. */
function signalsGrouped() {
  if (grouped.v === signalsVersion) return grouped.list;
  const groups = new Map();
  for (const s of SIGNALS.values()) (groups.get(s.group) || groups.set(s.group, []).get(s.group)).push(s);
  grouped = { v: signalsVersion, list: [...groups.values()].flat() };
  return grouped.list;
}
const squash = (t) => String(t ?? '').toLowerCase().replace(/[_.\-]+/g, ' ');
/**
 * The signals a search finds: every word in the name, group or id (any
 * order, any case; "_" and "." count as spaces), names that start with it
 * first, and of those as good, the popular ones first (in POPULAR's order).
 * An empty search: the popular stats first, then every other signal, by
 * group. ok(s) picks which of a popular stat's ids counts (the List: the
 * first with data here); a stat is in the answer once.
 */
export function searchSignals(query, ok) {
  const pop = popularSignals(ok);
  const taken = new Set(pop.map((s) => s.id));
  const rest = signalsGrouped().filter((s) => !taken.has(s.id));
  const words = squash(query).split(/\s+/).filter(Boolean);
  if (!words.length) return pop.concat(rest);
  const found = [];
  for (const s of pop.concat(rest)) {
    const names = [squash(s.label)];
    if (s.ownLabel) names.push(squash(s.ownLabel));
    else if (POPULAR_NAME.has(s.id)) names.push(squash(POPULAR_NAME.get(s.id))); // ("battery %" finds the ids it did not choose)
    const hay = `${names.join(' ')} ${squash(s.group)} ${squash(s.id)} ${String(s.id).toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const rank = names.some((n) => n.startsWith(words[0])) ? 0 : names.some((n) => words.every((w) => n.includes(w))) ? 1 : 2;
    found.push({ s, rank, pop: s.popular || 1e9 });
  }
  return found.sort((a, b) => a.rank - b.rank || a.pop - b.pop).map((x) => x.s);
}
const canMetaCache = new Map(); // front path -> entry of Promise<meta>
const canClipCache = new Map(); // front path + names -> entry of Promise<{ start, sync, series } | null>
function canMetaFor(path) {
  return cachedGet(canMetaCache, path, 8, () => fetch(`/api/can/signals?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((d) => d?.signals || {}).catch(() => ({})), hasKeys).p;
}
const seriesLen = (pts) => (pts ? (Array.isArray(pts) ? pts.length : pts.t.length) : 0);
const canClipGood = (d) => Object.values(d?.series || {}).some((pts) => seriesLen(pts) > 0);
function canClipFor(path, names) {
  return cachedGet(canClipCache, `${path}|${names.join(',')}`, 16, () => fetch(`/api/can/clip?path=${encodeURIComponent(path)}&signals=${encodeURIComponent(names.join(','))}`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null), canClipGood).p;
}
// The List's answer: every signal of the clip, each at its value every
// LIST_STEP_MS (the List shows the value now, as text), as columns kept in
// typed arrays, with `changing` (the names whose value moves, worked out on
// the server from every point). An eighth of the download and a tenth of the
// memory of every point at full rate; at most 2 are kept (this clip and the
// one before), the bar's own signals (a few, at full rate) separately.
const LIST_STEP_MS = 250;
const canListCache = new Map(); // front path -> entry of Promise<{ start, sync, trust, series, changing } | null>
/** An answer as columns ({ base, cols: { name: [[dt…], [v…]] } }) as { name: { t: Float64Array, v } }; one as pairs (an older server) as it is. */
export function decodeCanCols(d) {
  if (!d || !d.cols) return d ? { ...d, changing: Array.isArray(d.changing) ? new Set(d.changing) : null } : d;
  const series = {};
  for (const [name, col] of Object.entries(d.cols)) {
    const [dt, v] = col || [];
    if (!dt?.length) continue;
    const t = new Float64Array(dt.length);
    let at = Number(d.base) || 0;
    for (let k = 0; k < dt.length; k++) { at += dt[k]; t[k] = at; }
    series[name] = { t, v: v.every((x) => typeof x === 'number') ? Float64Array.from(v) : v };
  }
  const { cols, base, ...rest } = d;
  return { ...rest, series, changing: new Set(d.changing || []) };
}
function canListFor(path) {
  return cachedGet(canListCache, path, 2, () => fetch(`/api/can/clip?path=${encodeURIComponent(path)}&signals=*&step=${LIST_STEP_MS}&cols=1`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then(decodeCanCols).catch(() => null), canClipGood).p;
}
/** Forget every /api/can/clip answer for this clip (to ask again with the newest sync). */
function dropCanClip(path) {
  for (const key of [...canClipCache.keys()]) if (key.startsWith(`${path}|`)) canClipCache.delete(key);
  canListCache.delete(path);
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
const SLOTS = { small: 1, wide: 3, gauge: 1, state: 1, list: 0 }; // (list: every stat, scrolled)
const DEFAULT_SIGNAL = { small: ['dash.speed'], wide: ['dash.speed', 'dash.accelerator', 'dash.steering'], gauge: ['dash.speed'], state: ['dash.brake'], list: [] };

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
let saveState = null; // what the waiting save sends
function sendBoards(state) {
  // (keepalive: a save as the page closes still reaches the server)
  fetch('/api/dashboards', { method: 'PUT', credentials: 'same-origin', headers: H, body: JSON.stringify(state), keepalive: true }).catch(() => {});
}
function saveBoards(state) {
  saved = Promise.resolve(state);
  clearTimeout(saveTimer);
  saveState = state;
  saveTimer = setTimeout(() => { saveTimer = 0; saveState = null; sendBoards(state); }, 500);
}
/** A save still waiting goes now (the page is closing, reloading or hidden: a box moved or resized just before is kept). */
function flushBoards() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  const st = saveState;
  saveState = null;
  if (st) sendBoards(st);
}
globalThis.addEventListener?.('pagehide', flushBoards);
globalThis.document?.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'hidden') flushBoards(); });
const metricDefault = () => !/^en-(US|GB|LR|MM)$/i.test(navigator.language || '');

// ---- where a floating box goes (rects on the page: { left, top, width, height }) ----
// A floating box is kept relative to the Viewer's layout, not to the raw page: to the cameras
// (the stage), or for the List to the bar beside it. Its spot is the corner of that reference
// nearest to the box's middle and the px from it, so a box dropped at the bottom right of the
// cameras stays at their bottom right as the window (and the cameras with it) grows or shrinks.
const overlaps = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
const centreIn = (a, b) => { const x = a.left + a.width / 2; const y = a.top + a.height / 2; return x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height; };
/** The space between two rects (0 when they touch or overlap). */
const gapBetween = (a, b) => Math.max(0, b.left - (a.left + a.width), a.left - (b.left + b.width), b.top - (a.top + a.height), a.top - (b.top + b.height));
const ANCHOR = (a) => ['l', 'r', 'R'].includes(a?.h) && ['t', 'b', 'B'].includes(a?.v) && Number.isFinite(a?.dx) && Number.isFinite(a?.dy);
/**
 * A box's spot relative to `ref`: across (h) l, its left edge from ref's left; r, its right edge
 * in from ref's right; R, wholly past ref's right, its left edge from there. Down (v) the same: t,
 * b, or B (wholly below ref, its top from ref's bottom). The edge kept is the one nearest ref's, so
 * a box shown smaller (a short window) stays by the cameras.
 */
export function anchorOf(box, ref) {
  const right = ref.left + ref.width;
  const bottom = ref.top + ref.height;
  const h = box.left >= right ? 'R' : box.left + box.width / 2 < ref.left + ref.width / 2 ? 'l' : 'r';
  const v = box.top >= bottom ? 'B' : box.top + box.height / 2 < ref.top + ref.height / 2 ? 't' : 'b';
  return {
    h, v,
    dx: Math.round(h === 'l' ? box.left - ref.left : h === 'R' ? box.left - right : right - (box.left + box.width)),
    dy: Math.round(v === 't' ? box.top - ref.top : v === 'B' ? box.top - bottom : bottom - (box.top + box.height))
  };
}
/** Where a box of this size goes for a spot relative to `ref` (anchorOf, the other way). */
export function fromAnchor(a, ref, width, height) {
  const right = ref.left + ref.width;
  const bottom = ref.top + ref.height;
  return {
    left: a.h === 'l' ? ref.left + a.dx : a.h === 'R' ? right + a.dx : right - a.dx - width,
    top: a.v === 't' ? ref.top + a.dy : a.v === 'B' ? bottom + a.dy : bottom - a.dy - height,
    width, height
  };
}
/** A box kept within bounds ({ left, top, right, bottom }): across always, down from the top (and above the bottom when it fits). */
export function fitIn(box, b) {
  const left = Math.max(b.left, Math.min(b.right - box.width, box.left));
  const top = Math.max(b.top, Math.min(Math.max(b.top, (b.bottom ?? Infinity) - box.height), box.top));
  return { ...box, left, top };
}
/**
 * A box moved the least it takes to cover none of `obstacles` ({ left, top, width, height,
 * above?: false }): beside one, below it, or above it (unless `above: false`), within `bounds`.
 * With no such place, below them all (past the bounds' bottom: see arrange).
 */
export const within = (r, b) => r.left >= b.left - 0.5 && r.left + r.width <= b.right + 0.5 && r.top >= b.top - 0.5 && r.top + r.height <= (b.bottom ?? Infinity) + 0.5;
export function clearOf(box, obstacles, bounds, gap = 8) {
  const hit = (r) => obstacles.find((o) => overlaps(r, o));
  if (!hit(box)) return box;
  // straight down may run past the bounds' bottom (the page scrolls): a box the cameras grew
  // into (a wider window, taller cameras) slides down under them, as it was, rather than
  // jumping across the page to the one side where it fits in the window
  const fits = (r) => within(r, r.down ? { ...bounds, bottom: Infinity } : bounds);
  const around = ({ down, ...r }, o) => [
    { ...r, left: o.left - gap - r.width }, { ...r, left: o.left + o.width + gap },
    { ...r, top: o.top + o.height + gap, down: true }, ...(o.above === false ? [] : [{ ...r, top: o.top - gap - r.height }])
  ];
  const cost = (r) => Math.abs(r.left - box.left) + Math.abs(r.top - box.top);
  let best = null;
  let frontier = [box];
  for (let depth = 0; depth < 3 && frontier.length && !best; depth++) {
    const next = [];
    for (const r of frontier) {
      for (const c of around(r, hit(r))) {
        if (!fits(c)) continue;
        if (!hit(c)) { if (!best || cost(c) < cost(best)) best = c; } else next.push(c);
      }
    }
    frontier = next.slice(0, 64);
  }
  if (best) { const { down, ...r } = best; return r; }
  const low = Math.max(...obstacles.map((o) => o.top + o.height));
  return { ...box, left: Math.max(bounds.left, Math.min(bounds.right - box.width, box.left)), top: low + gap };
}
/**
 * A floating box's spot as kept: anchored to the cameras (h, v, dx, dy), `over` when the box is
 * on the cameras (it stays on them; a box that is not is kept off them), and `bar`, its anchor
 * to the bar when a List sits right by a floating bar (it goes along with it). `migrated`: an
 * old spot put on the page as before; on the cameras only if its middle is.
 */
export function spotFor(box, stage, { bar = null, migrated = false } = {}) {
  const spot = { ...anchorOf(box, stage), over: stage.width > 0 && (migrated ? centreIn(box, stage) : overlaps(box, stage)) };
  if (bar && gapBetween(box, bar) <= 24) spot.bar = anchorOf(box, bar);
  return spot;
}
/**
 * Where a floating box goes now: from its spot relative to the cameras (or to the bar), kept
 * across the page, on the cameras when it was put there, off them when it was not, and off
 * `others` (the other floating box). `stage` and `bounds` as on the page now.
 */
export function placeFor(spot, { width, height }, { stage, bounds, bar = null, others = [] }) {
  const r = fitIn(spot.bar && ANCHOR(spot.bar) && bar ? fromAnchor(spot.bar, bar, width, height) : fromAnchor(spot, stage, width, height), bounds);
  const avoid = [...(spot.over || !(stage.width > 0) ? [] : [{ ...stage, above: false }]), ...others];
  return avoid.length ? clearOf(r, avoid, bounds) : r;
}
export const isAnchored = ANCHOR;

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
  // the list blocks live in their own box, outside the bar: under it, or anywhere (dragged)
  const panel = document.createElement('div');
  panel.className = 'sentry-sd sd-listpanel';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Car data at this moment');
  let state = null; // { boards, active }
  let board = null;
  let editing = false;
  let hidden = false;
  let alive = true;
  let recs = null;
  let recsFor = null;
  // the CAN data: the bar's own signals (by name, every point) and, with a
  // List, every signal (canListFor). Each is { data: { start (UTC ms of the
  // clip's 0 s), sync, trust, series }, of: its clip, key: what was asked, retry }.
  const feed = () => ({ data: null, of: null, key: null, retry: 0 });
  const canBar = feed();
  const canAll = feed();
  let shownPath = null; // the clip the cameras show now
  /** The answer for clip `p` that says how it lines up (the bar's, else the List's), or null. */
  const canFor = (p) => (canBar.data && canBar.of === p ? canBar.data : canAll.data && canAll.of === p ? canAll.data : null);
  /** The List's answer for the clip shown (never the last clip's while the next one loads). */
  const listData = () => (canAll.data && canAll.of === shownPath ? canAll.data : null);
  let raf = 0;
  // the nerd raw view (createRawView): its own element, put back after each redraw.
  // It uses the signals' sync for the clip when there is one (canTime), so both agree.
  const rawView = createRawView({
    onAvailable: (yes) => { const b = el.querySelector('[data-raw]'); if (b) b.hidden = !yes; },
    syncFor: (p) => canFor(p),
    onData: (p, d) => reconcile(p, d)
  });
  // The raw answer is asked for later, so its sync is the newer one: when it
  // differs from the signals', they ask again (once per raw answer), and both
  // then use the same sync.
  let reconciledWith = null;
  function reconcile(p, d) {
    const can = canFor(p);
    if (!alive || !can || !d || d === reconciledWith || !Number.isFinite(d.start)) return;
    const rateDiffers = d.sync !== undefined && (d.sync?.rate || 1) !== (can.sync?.rate || 1);
    if (Math.abs(d.start - can.start) <= 0.05 && !rateDiffers) return;
    reconciledWith = d;
    dropCanClip(p);
    canBar.key = null;
    canAll.key = null;
  }
  const ctx = (ms = null) => {
    // a CAN signal's value at this moment of the clip shown (dt ms from it: a computed stat over
    // the last seconds): from the bar's answer (every point) when it has the signal, else from
    // the List's (the server lines the CAN clock up with the footage: start, and the drift as rate)
    const canAt = (name, dt) => {
      if (ms === null || !shownPath) return null;
      const a = canBar.of === shownPath && canBar.data?.series?.[name] ? canBar.data : listData();
      return a ? canSeriesAt(a.series?.[name], canTime(a, ms) + dt) : null;
    };
    return { metric: board?.metric ?? metricDefault(), can: (name) => canAt(name, 0), canAt, since: ms };
  };
  // how well the CAN data is lined up with the footage, small in the tools row
  function syncNote() {
    const node = el.querySelector('[data-sync]');
    if (!node) return;
    const can = shownPath ? canFor(shownPath) : null;
    const s = can ? can.sync : null;
    const m = s?.method;
    node.textContent = !s ? '' : m === 'clock' ? 'CAN: clock only' : m === 'speed' ? 'CAN synced by speed' : `CAN synced ±${Math.max(1, Math.round(s.spreadMs ?? 0))} ms`;
    node.title = !s ? '' : m === 'clock' ? 'CAN data placed by the clip\'s time only: nothing to line it up with' : m === 'speed' ? 'CAN data lined up with the footage by its speed' : `CAN data lined up with the footage from ${s.matches} matching changes (brake, blinkers, accelerator)${m === 'edges-drive' ? ' across the drive' : ''}`;
    // a log that failed its signature check, used anyway: always said; unsigned (an older bridge): said quietly
    const trust = can ? can.trust : null;
    node.classList.toggle('sd-warn', trust === 'override');
    if (trust === 'override') {
      node.textContent = `⚠ CAN data failed its check · ${node.textContent}`;
      node.title = `Some of this CAN data comes from a log whose signature check failed and was used anyway (Nerd settings). ${node.title}`;
    } else if (trust === 'unsigned') {
      node.textContent = `${node.textContent} · unsigned`;
      node.title = `${node.title}. These logs are not signed (an older CAN Bridge).`;
    }
  }
  const hasList = () => (board?.blocks || []).some((b) => b.type === 'list');
  /**
   * The CAN signals the bar's blocks show (the List's come with its own answer), with the
   * signals a chosen one needs: a speed limit in the car's units needs the units.
   */
  const barNames = () => [...new Set((board?.blocks || []).filter((b) => b.type !== 'list').flatMap((b) => b.signals).flatMap((id) => [...(id.startsWith('can.') ? [id.slice(4)] : []), ...(SIGNALS.get(id)?.needs || [])]))].sort();
  /** Ask for one feed's answer for `path` (none: `want` false). A new clip empties it first: nothing of the last clip is shown as this one's. */
  function loadFeed(f, path, want, key, get) {
    if (key === f.key) return;
    f.key = key;
    clearTimeout(f.retry);
    if (f.of !== path || !want) { f.data = null; f.of = null; }
    if (!want) return;
    get().then((d) => {
      if (!alive || f.key !== key) return;
      f.data = d;
      f.of = path;
      syncNote();
      tick(true);
      reconcile(path, rawView.dataFor(path));
      // no data (yet): asked again in a while (the next tick, once the key is cleared)
      if (!canClipGood(d)) f.retry = setTimeout(() => { if (f.key === key) f.key = null; }, RETRY_MS + 1000);
    });
  }
  function loadCan(path) {
    const names = barNames();
    const list = hasList();
    const barKey = `${path}|${names.join(',')}`;
    const allKey = `${path}|${list ? '*' : ''}`;
    if (barKey === canBar.key && allKey === canAll.key) return;
    if (canBar.of !== path && canAll.of !== path) reconciledWith = null;
    // new names (and the stat picker) once the car's signal list is here
    canMetaFor(path).then((meta) => { if (alive && registerCanSignals(meta) && state) draw(); });
    loadFeed(canBar, path, names.length > 0, barKey, () => canClipFor(path, names));
    loadFeed(canAll, path, list, allKey, () => canListFor(path));
    syncNote();
  }

  // where the bar is: under the cameras, over them, or anywhere on the page (float: dragged by its
  // Move handle; the spot is kept per account, one for wide screens and one for narrow ones). A
  // box set to float with no spot for this kind of screen yet is where it would be docked (under
  // the cameras, the List under the bar) until it is moved: no spot is made up for it.
  const screenKind = () => ((globalThis.innerWidth ?? 1000) < 700 ? 'narrow' : 'wide');
  let fsSpots = {}; // where a box was moved to in this fullscreen (not kept: see keepFloat)
  const loose = new Set(); // a box just pulled out, floating before its spot is kept
  const spotOf = (field) => (fsHost() && fsSpots[field]) || board?.[field]?.[screenKind()] || null;
  const floatsNow = (field, node) => Boolean(spotOf(field)) || loose.has(node);
  const whereNow = () => (board?.placement === 'float' && floatsNow('float', el) ? 'float'
    : over || board?.placement === 'over' || (board?.placement === 'float' && board?.barHome === 'over') ? 'over' : 'below');
  // In fullscreen only the fullscreen element is drawn: what floats goes in it
  // (not the page's body), and when the cameras themselves are fullscreen (the
  // stage), the bar goes over them and the docked List floats over them too.
  const fsHost = () => {
    const f = globalThis.document?.fullscreenElement || globalThis.document?.webkitFullscreenElement || null;
    return f && (f === stage || f.contains?.(stage)) ? f : null;
  };
  const floatHost = () => fsHost() || document.body;
  const stageFull = () => fsHost() === stage;
  function place() {
    const where = whereNow() === 'below' && stageFull() ? 'over' : whereNow();
    el.classList.toggle('over', where === 'over');
    el.classList.toggle('below', where === 'below');
    el.classList.toggle('float', where === 'float');
    if (where === 'float') {
      if (el.parentElement !== floatHost()) floatHost().appendChild(el);
    } else {
      el.style.left = '';
      el.style.top = '';
      if (where === 'over') {
        if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
        if (el.parentElement !== stage) stage.appendChild(el);
      } else if (el.previousElementSibling !== stage) stage.after(el);
    }
  }
  // the list box: docked under the bar, or floating where it was dragged
  const listFloats = () => board?.listPlacement === 'float' && floatsNow('listFloat', panel);
  const panelFloats = () => listFloats() || stageFull();
  function placePanel() {
    const has = !hidden && board.blocks.some((b) => b.type === 'list');
    if (!has) { panel.remove(); return; }
    panel.classList.toggle('float', panelFloats());
    panel.classList.toggle('below', !panelFloats());
    if (panelFloats()) {
      if (panel.parentElement !== floatHost()) floatHost().appendChild(panel);
    } else {
      panel.style.left = '';
      panel.style.top = '';
      // right after the bar when it is under the cameras, else right after the cameras
      const after = whereNow() === 'below' ? el : stage;
      if (panel.previousElementSibling !== after) after.after(panel);
    }
  }
  // A floating box sits on the PAGE, not on the window: position:absolute in <body>, in page
  // coordinates, so it scrolls with what is under it (every interface's Viewer scrolls the
  // document). Its spot is kept relative to the cameras (the stage), which reflow with the
  // window: the nearest corner of them and the px from it (spotFor / placeFor), so a resized
  // window keeps each box where it was in the Viewer's layout, across the page, off the other
  // box, and off the cameras unless it was put on them. x, y (shares of the room) and top (px
  // down the page) are kept too, for fullscreen and as spots were before; a spot saved before
  // has only those: it is put on the page as then and anchored once, to the cameras as they are.
  // (in fullscreen the docked List floats over the cameras too: panelFloats)
  const floating = (node) => (node === panel ? panelFloats() && Boolean(panel.parentElement) : whereNow() === 'float');
  let held = null; // the box being dragged or resized: a redraw meanwhile leaves it where the pointer has it
  const rectOf = (node) => node.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
  const sx = () => globalThis.scrollX || 0;
  const sy = () => globalThis.scrollY || 0;
  const winW = () => globalThis.innerWidth || 0;
  const winH = () => globalThis.innerHeight || 0;
  const viewW = () => document.documentElement?.clientWidth || winW();
  /** The page's size without the floating boxes, and where the boxes' containing block starts on it. */
  function pageBox() {
    // in fullscreen the boxes are in the fullscreen element (fixed to the screen): its own box
    const fs = fsHost();
    if (fs) {
      const r = rectOf(fs);
      return { w: fs.clientWidth || winW(), h: fs.clientHeight || winH(), ox: r.left + sx() + (fs.clientLeft || 0), oy: r.top + sy() + (fs.clientTop || 0), fs: true };
    }
    const de = document.documentElement;
    const boxes = [el, panel].filter((n) => n.parentElement && n.classList.contains('float'));
    const was = boxes.map((n) => n.style.display);
    boxes.forEach((n) => { n.style.display = 'none'; });
    const w = viewW();
    const h = Math.max(de?.scrollHeight || 0, de?.clientHeight || 0, winH());
    boxes.forEach((n, k) => { n.style.display = was[k]; });
    let ox = 0;
    let oy = 0;
    const body = document.body;
    const cs = body && globalThis.getComputedStyle?.(body);
    if (cs && (cs.position !== 'static' || (cs.transform && cs.transform !== 'none'))) {
      const r = rectOf(body);
      ox = r.left + sx() + (body.clientLeft || 0);
      oy = r.top + sy() + (body.clientTop || 0);
    }
    return { w, h, ox, oy };
  }
  /** Put a floating box at (left, top) on the page, kept on the page; where it went. */
  function setPagePos(node, left, top, pb = pageBox()) {
    const L = Math.max(0, Math.min(pb.w - node.offsetWidth, left));
    const T = Math.max(0, Math.min(pb.h - node.offsetHeight, top));
    node.style.left = `${Math.round(L - pb.ox)}px`;
    node.style.top = `${Math.round(T - pb.oy)}px`;
    return { left: L, top: T };
  }
  const pageXY = (node) => { const r = rectOf(node); return { left: r.left + sx(), top: r.top + sy() }; };
  function floatTo(node, p, pb) {
    const left = p.x * Math.max(0, pb.w - node.offsetWidth);
    // (in fullscreen: y, a share of the screen's room; the page's top means nothing there)
    const top = Number.isFinite(p.top) && !pb.fs ? p.top : p.y * Math.max(0, (pb.fs ? pb.h : winH()) - node.offsetHeight);
    setPagePos(node, left, top, pb);
  }
  // sizes: both boxes resize from their corner grip; width only while floating (docked boxes
  // are as wide as the page), never more than the window; kept per dashboard and screen kind
  const MIN = { bar: { w: 220, h: 64 }, list: { w: 260, h: 170 } };
  const sizeField = (node) => (node === panel ? 'listSize' : 'size');
  function clampSize(node, w, h) {
    const m = node === panel ? MIN.list : MIN.bar;
    // (a floating box is never wider than the page less a margin each side)
    const W = Math.max(0, viewW() - (floating(node) ? 16 : 0));
    // (a bar over the video is no taller than the video, less its margins: its grip, on its top,
    // stays where it can be reached when the video is short, as when a tall List shares the screen)
    const room = node === el && el.classList.contains('over') ? (stage.clientHeight || 0) - 16 : 0;
    const H = room > 0 ? Math.min(winH(), room) : winH();
    return { w: Math.round(Math.max(Math.min(m.w, W), Math.min(W, w))), h: Math.round(Math.max(Math.min(m.h, H), Math.min(H, h))) };
  }
  // (a saved size the window has no room for now is shown smaller, and kept: with room again, it is back)
  function applySize(node) {
    if (node === held) return;
    const s = hidden && node === el ? null : board?.[sizeField(node)]?.[screenKind()];
    const w = floating(node) && Number.isFinite(s?.w) ? s.w : null;
    const h = Number.isFinite(s?.h) ? s.h : null;
    const c = clampSize(node, w ?? 0, h ?? 0);
    node.style.width = w == null ? '' : `${c.w}px`;
    node.style.maxWidth = w == null ? '' : 'none';
    node.style.height = h == null ? '' : `${c.h}px`;
    node.classList.toggle('sized', h != null);
  }
  const sizeOf = (node) => ({ width: node.offsetWidth, height: node.offsetHeight });
  const pageRect = (node) => ({ ...pageXY(node), ...sizeOf(node) });
  /** The cameras on the page now, and where a box may go (the page across, from its top down). */
  function layoutNow(pb) {
    const r = rectOf(stage);
    return {
      stage: { left: r.left + sx(), top: r.top + sy(), width: r.width || 0, height: r.height || 0 },
      bounds: { left: 0, top: 0, right: pb.w, bottom: pb.h }
    };
  }
  const roomy = (st) => st.width > 40 && st.height > 40;
  /** A floating box's place now, from its spot (an old spot is anchored here, once). */
  function placeOf(node, field, lay, bar, others) {
    const k = screenKind();
    let s = board[field]?.[k];
    const size = sizeOf(node);
    if (!s) return pageRect(node); // (just pulled out: where it is)
    if (!isAnchored(s)) {
      // a spot saved before: on the page as it was then (x a share of the room across, top
      // its px down the page, or y a share of the window's room), then anchored to the cameras
      const left = (Number.isFinite(s.x) ? s.x : 0.5) * Math.max(0, lay.bounds.right - size.width);
      const top = Number.isFinite(s.top) ? s.top : (Number.isFinite(s.y) ? s.y : 0.5) * Math.max(0, winH() - size.height);
      const r = fitIn({ left, top, ...size }, lay.bounds);
      if (!roomy(lay.stage)) return r; // (the cameras are not laid out yet: later)
      s = { ...s, ...spotFor(r, lay.stage, { bar, migrated: true }) };
      board[field] = { ...(board[field] || {}), [k]: s };
      saveBoards(state);
    }
    return placeFor(s, size, { stage: roomy(lay.stage) ? lay.stage : { left: 0, top: 0, width: 0, height: 0 }, bounds: lay.bounds, bar, others });
  }
  function applyFloat() {
    if (!board) return;
    applySize(el);
    if (panel.parentElement) applySize(panel);
    const barFloats = floating(el) && Boolean(el.parentElement);
    const bar = barFloats && el !== held;
    const list = floating(panel) && panel !== held;
    if (!bar && !list) return;
    const pb = pageBox();
    // measured at their own size: a box without a width of its own fits its contents, and one
    // left near the window's right edge by the last layout is squeezed there (a narrower window
    // made the bar half as wide, and it stayed so); from the page's left, each is its full size
    for (const [node, on] of [[el, bar], [panel, list]]) if (on) node.style.left = `${Math.round(-pb.ox)}px`;
    if (pb.fs) {
      // in fullscreen: shares of the screen (the page's layout means nothing there)
      const spot = (field) => fsSpots[field] || board[field]?.[screenKind()];
      const share = (p, d) => (Number.isFinite(p?.x) && Number.isFinite(p?.y) ? { x: p.x, y: p.y } : d);
      if (bar) floatTo(el, share(spot('float'), { x: 0.5, y: 0.94 }), pb);
      if (list) floatTo(panel, share(spot('listFloat'), { x: 0.98, y: 0.3 }), pb);
      return;
    }
    const lay = layoutNow(pb);
    let barAt = bar ? placeOf(el, 'float', lay, null, []) : barFloats ? pageRect(el) : null;
    // the List: by the bar if it was put by it, and never on it
    let listAt = list ? placeOf(panel, 'listFloat', lay, barAt, barAt ? [barAt] : []) : null;
    if (bar && listAt && !(within(listAt, lay.bounds) && !overlaps(listAt, barAt))) {
      // no room for the List off the bar (a page that does not scroll): the List at its spot, the bar off it
      const l2 = placeOf(panel, 'listFloat', lay, barAt, []);
      const onVideo = board.float?.[screenKind()]?.over || !roomy(lay.stage);
      const b2 = clearOf(barAt, [l2, ...(onVideo ? [] : [{ ...lay.stage, above: false }])], lay.bounds);
      if (within(b2, lay.bounds) && !overlaps(b2, l2)) { barAt = b2; listAt = l2; }
    }
    if (bar) setPagePos(el, barAt.left, barAt.top, pb);
    if (listAt) setPagePos(panel, listAt.left, listAt.top, pb);
  }
  /** Keep a floating box where it is now (after a drag, a nudge or a resize): anchored to the cameras. */
  function keepFloat(left, top, node = el) {
    const pb = pageBox();
    const at = setPagePos(node, left, top, pb);
    loose.delete(node);
    // a box moved while the cameras are fullscreen stays there until fullscreen ends; the spot
    // kept is the page's (a spot on the screen would put it somewhere else on the page)
    const r3 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
    const field = node === panel ? 'listFloat' : 'float';
    const shares = { x: r3(at.left / Math.max(1, pb.w - node.offsetWidth)), y: r3(at.top / Math.max(1, pb.h - node.offsetHeight)) };
    if (pb.fs) { fsSpots[field] = shares; return; }
    const lay = layoutNow(pb);
    const box = { ...at, ...sizeOf(node) };
    const bar = node === panel && floating(el) && el.parentElement ? pageRect(el) : null;
    board[field] = { ...(board[field] || {}), [screenKind()]: { ...shares, top: Math.round(at.top), ...spotFor(box, roomy(lay.stage) ? lay.stage : { left: 0, top: 0, width: 0, height: 0 }, { bar }) } };
    saveBoards(state);
    // (the List follows a bar it was put by; one dropped on the other is moved off it)
    if (!held) applyFloat();
  }
  /** Keep a box's size (h always; w only when it floats). */
  function keepSize(node, w, h) {
    const field = sizeField(node);
    const k = screenKind();
    const prev = board[field]?.[k] || {};
    board[field] = { ...(board[field] || {}), [k]: { ...prev, ...(floating(node) ? { w } : {}), h } };
    saveBoards(state);
  }
  // The window resized, or the page under the boxes (the cameras, the columns) reflowed: put
  // them back in their spots, once an animation frame. A new kind of screen (wide or narrow)
  // has spots of its own: a box with none there is docked.
  let reflowRaf = 0;
  let kindDrawn = null;
  const relayout = () => {
    reflowRaf = 0;
    if (!alive || held || !board) return;
    if (kindDrawn !== screenKind()) { loose.clear(); draw(); } else applyFloat();
  };
  const onResize = () => { if (!reflowRaf && board) reflowRaf = requestAnimationFrame(relayout); };
  globalThis.addEventListener?.('resize', onResize);
  // (a page that slides or scales its window in moves the cameras with no resize: once it ends)
  const onSettle = (e) => { if (e.target === stage || e.target?.contains?.(stage)) onResize(); };
  for (const type of ['transitionend', 'animationend']) document.addEventListener?.(type, onSettle, true);
  // into fullscreen and out: the boxes move to where they can be seen (an open picker closes)
  const onFullscreen = () => { if (!alive || !board) return; if (!fsHost()) fsSpots = {}; closePick(false); place(); placePanel(); applyFloat(); };
  for (const type of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener?.(type, onFullscreen);
  // the page grows as it loads (a box kept low on the page waits for it) or shrinks: put them back
  const reflow = () => {
    if (reflowRaf || !board || !(floating(el) || floating(panel) || el.classList.contains('sized'))) return;
    reflowRaf = requestAnimationFrame(relayout);
  };
  const pageWatch = globalThis.ResizeObserver ? new ResizeObserver(reflow) : null;
  for (let n = stage; n && n !== document.documentElement; n = n.parentElement) pageWatch?.observe(n);

  // A stat picker is a button showing its stat; it opens a searchable list
  // (thousands of CAN signals: a plain drop-down cannot be searched and its
  // text is tiny). The list is built only while open, at most SHOWN rows.
  const SHOWN = 250;
  const statName = (id) => { const s = SIGNALS.get(id); return s ? s.label : `${String(id).replace(/^can\./, '')} (no data yet)`; };
  const pickButton = (id, i, k) => `<button type="button" class="sd-btn sd-pickbtn" data-pick="${i}" data-slot="${k}" aria-haspopup="listbox" aria-label="Stat ${k + 1}: ${esc(statName(id))}. Change it" title="${esc(statName(id))}">${esc(statName(id))}</button>`;
  const popHost = () => fsHost() || document.body || el;
  const popId = `sdpop${Math.random().toString(36).slice(2, 8)}`;
  let pop = null; // { node, input, list, count, pick, slot, items, active, current }
  const onOutside = (e) => {
    if (!pop) return;
    for (let n = e.target; n; n = n.parentElement) if (n === pop.node || n === pop.opener) return;
    closePick(false);
  };
  function closePick(focusBack = true) {
    if (!pop) return;
    const { node, pick, slot } = pop;
    pop = null;
    node.remove();
    globalThis.removeEventListener?.('pointerdown', onOutside, true);
    if (focusBack) el.querySelector(`[data-pick="${pick}"][data-slot="${slot}"]`)?.focus();
  }
  function drawPick() {
    const q = pop.input.value || '';
    const found = searchSignals(q);
    pop.items = found.slice(0, SHOWN);
    pop.active = Math.max(0, Math.min(pop.items.length - 1, pop.active));
    let html = '';
    let group = null;
    pop.items.forEach((s, k) => {
      const g = s.popular ? 'Popular' : s.group;
      if (!q.trim() && g !== group) { group = g; html += `<li class="sd-pop-g" role="presentation">${esc(group)}</li>`; }
      // (a popular stat from CAN says which signal it is)
      const note = q.trim() ? s.group : s.popular && s.source === 'can' ? s.ownLabel : '';
      html += `<li role="option" id="${popId}-${k}" data-opt="${k}" class="sd-pop-o${s.id === pop.current ? ' cur' : ''}" aria-selected="${k === pop.active}"><span>${esc(s.label)}</span>${note ? `<small>${esc(note)}</small>` : ''}</li>`;
    });
    if (found.length > SHOWN) html += `<li class="sd-pop-none" role="presentation">${(found.length - SHOWN).toLocaleString()} more: type more of the name.</li>`;
    pop.list.innerHTML = html || `<li class="sd-pop-none" role="presentation">No stat matches "${esc(q)}".</li>`;
    pop.count.textContent = q.trim() ? `${found.length.toLocaleString()} of ${SIGNALS.size.toLocaleString()} stats` : `${SIGNALS.size.toLocaleString()} stats: type to search`;
    pop.input.setAttribute('aria-activedescendant', pop.items.length ? `${popId}-${pop.active}` : '');
  }
  function showActive() {
    pop.list.querySelectorAll('[aria-selected="true"]').forEach((n) => n.setAttribute('aria-selected', 'false'));
    const on = pop.list.querySelector(`[data-opt="${pop.active}"]`);
    on?.setAttribute('aria-selected', 'true');
    on?.scrollIntoView?.({ block: 'nearest' });
    pop.input.setAttribute('aria-activedescendant', on ? `${popId}-${pop.active}` : '');
  }
  function choosePick(k) {
    const s = pop?.items[k];
    if (!s) return;
    const { pick, slot } = pop;
    const b = board.blocks[pick];
    closePick(false);
    if (b) { b.signals[slot] = s.id; change(); }
    el.querySelector(`[data-pick="${pick}"][data-slot="${slot}"]`)?.focus();
  }
  function placePick() {
    const r = pop.opener.getBoundingClientRect?.();
    if (!r || typeof innerWidth !== 'number') return;
    const w = Math.min(400, innerWidth - 16);
    const left = Math.max(8, Math.min(innerWidth - w - 8, r.left));
    const below = innerHeight - r.bottom - 16;
    const above = r.top - 16;
    const room = Math.max(below, above);
    const listMax = Math.max(140, Math.min(440, room - 80));
    pop.list.style.maxHeight = `${listMax}px`;
    pop.node.style.left = `${Math.round(left)}px`;
    if (below >= 260 || below >= above) { pop.node.style.top = `${Math.round(r.bottom + 6)}px`; pop.node.style.bottom = 'auto'; }
    else { pop.node.style.top = 'auto'; pop.node.style.bottom = `${Math.round(innerHeight - r.top + 6)}px`; }
  }
  function openPick(btn) {
    const pick = Number(btn.dataset.pick);
    const slot = Number(btn.dataset.slot);
    const same = pop && pop.pick === pick && pop.slot === slot;
    closePick(false);
    if (same) return; // a second tap closes it
    const node = document.createElement('div');
    node.className = 'sentry-sd sd-pop';
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-label', 'Choose a stat');
    node.innerHTML = `<input type="search" data-pop-q role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="${popId}" aria-label="Search the stats" placeholder="Search: battery, voltage, brake, 0x132…" autocomplete="off" spellcheck="false">
      <div class="sd-pop-n" data-pop-n aria-live="polite"></div><ul class="sd-pop-list" id="${popId}" role="listbox" data-pop-list></ul>`;
    pop = { node, input: node.querySelector('[data-pop-q]'), list: node.querySelector('[data-pop-list]'), count: node.querySelector('[data-pop-n]'), opener: btn, pick, slot, items: [], active: 0, current: board.blocks[pick]?.signals[slot] };
    const cur = searchSignals('').findIndex((s) => s.id === pop.current);
    pop.active = Math.max(0, Math.min(SHOWN - 1, cur));
    node.addEventListener('input', () => { if (pop) { pop.active = 0; drawPick(); } });
    node.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the Viewer's own shortcuts stay quiet while typing
      if (!pop) return;
      const n = pop.items.length;
      const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[e.key];
      if (step && n) { e.preventDefault(); pop.active = Math.max(0, Math.min(n - 1, pop.active + step)); showActive(); }
      else if (e.key === 'Enter') { e.preventDefault(); choosePick(pop.active); }
      else if (e.key === 'Escape') { e.preventDefault(); closePick(); }
      else if (e.key === 'Tab') closePick(false);
    });
    node.addEventListener('pointerdown', (e) => { if (e.target.closest?.('[data-opt]')) e.preventDefault(); });
    node.addEventListener('click', (e) => { const o = e.target.closest?.('[data-opt]'); if (o) choosePick(Number(o.dataset.opt)); });
    popHost().appendChild(node);
    drawPick();
    placePick();
    showActive();
    globalThis.addEventListener?.('pointerdown', onOutside, true);
    pop.input.focus();
  }
  /** A stat's value now: { text, unit } (text "—" when it has none). */
  function valueOf(s, r, c) {
    const raw = s && (s.source === 'can' || s.source === 'calc' || r) ? s.value(r, c) : null;
    const text = raw == null ? '—' : typeof raw === 'number' ? fmt(raw, s.digits ?? 1) : typeof raw === 'boolean' ? (raw ? 'On' : 'Off') : String(raw);
    // (a value in words says the DBC's own name in its tooltip)
    const name = raw != null && s.rawName ? s.rawName(r, c) : null;
    return { text, unit: raw == null || !s?.unit || typeof raw !== 'number' ? '' : s.unit(c), title: name && name !== text ? name : '' };
  }

  // The list block: every stat with data in this clip (or only those that
  // change), filtered by its own search, live as the footage plays. With no
  // search, the popular stats come first under their own heading (for each,
  // the first of its ids with data here), then everything else; with one,
  // the popular ones lead the matches as good. Only the rows in view are
  // built (thousands of CAN signals); a value that changes lights up for a
  // moment.
  const ROW = 30;
  const lists = new WeakMap(); // block -> { key, data, recs, gen, rows, hidden, prev, hot }
  const changingOf = new WeakMap(); // the List's answer -> Set of names whose value changes
  let hotLeft = 0;
  function changingNames(data) {
    if (!data) return new Set();
    if (data.changing) return data.changing; // (the server's, from every point)
    let set = changingOf.get(data);
    if (!set) {
      // (an answer as pairs, from an older server: worked out here)
      set = new Set(Object.entries(data.series || {}).filter(([, pts]) => Array.isArray(pts) && pts.some((p) => p[1] !== pts[0][1])).map(([n]) => n));
      changingOf.set(data, set);
    }
    return set;
  }
  // The built-in (telemetry) stats with data in these records, and those whose
  // value changes: one pass over the clip's records, once per clip.
  const dashOf = new WeakMap(); // recs -> { has: Set of ids, moving: Set of ids }
  const NO_DASH = { has: new Set(), moving: new Set() };
  function dashStats() {
    if (!recs?.length) return NO_DASH;
    let d = dashOf.get(recs);
    if (d) return d;
    d = { has: new Set(), moving: new Set() };
    const c0 = { metric: true, can: () => null };
    for (const s of SIGNALS.values()) {
      if (s.source === 'can' || s.source === 'calc') continue;
      let first;
      for (const rec of recs) {
        const v = s.value(rec, c0);
        if (v == null || (typeof v === 'number' && !Number.isFinite(v))) continue;
        if (first === undefined) { first = v; d.has.add(s.id); } else if (v !== first) { d.moving.add(s.id); break; }
      }
    }
    dashOf.set(recs, d);
    return d;
  }
  let listGen = 0;
  function listRows(b) {
    const st = lists.get(b) || lists.set(b, { key: '', rows: [], hidden: 0, prev: new Map(), hot: new Map() }).get(b);
    const data = listData();
    const key = `${signalsVersion}|${b.q || ''}|${b.changing ? 1 : 0}`;
    if (st.key === key && st.data === data && st.recs === recs) return st;
    const moving = b.changing ? changingNames(data) : null;
    const dash = dashStats();
    const has = (n) => seriesLen(data?.series?.[n]) > 0;
    const shown = (s) => (s.source === 'can'
      ? (moving ? moving.has(s.canName) : has(s.canName))
      // (a computed stat: there when its inputs are; changing when one of them changes)
      : s.source === 'calc' ? s.uses.every((alts) => alts.some(has)) && (!moving || s.inputs.some((n) => moving.has(n)))
        : (moving ? dash.moving.has(s.id) : dash.has.has(s.id)));
    const found = searchSignals(b.q || '', shown);
    const rows = found.filter(shown);
    const pops = (b.q || '').trim() ? 0 : rows.filter((s) => s.popular).length;
    // (headings are rows too, with no id: the list draws only the rows in view)
    st.rows = pops ? [{ head: 'Popular' }, ...rows.slice(0, pops), ...(rows.length > pops ? [{ head: 'All stats' }] : []), ...rows.slice(pops)] : rows;
    st.count = rows.length;
    st.hidden = found.length - rows.length;
    // new data (another clip, or its records): its values are not "changes" of the last clip's
    if (st.data !== data || st.recs !== recs) { st.prev = new Map(); st.hot = new Map(); }
    st.key = key;
    st.data = data;
    st.recs = recs;
    st.gen = ++listGen; // (the rows drawn are redrawn whenever the rows are new)
    return st;
  }
  const messageOf = (s) => String(s.group || '').split(' · ').pop();
  function renderList(node, b, r, c) {
    const st = listRows(b);
    const scroll = node.querySelector('[data-list-scroll]');
    const pad = node.querySelector('[data-list-pad]');
    const count = node.querySelector('[data-list-n]');
    if (!scroll || !pad) return;
    const n = st.rows.length;
    if (count) count.textContent = `${st.count.toLocaleString()} stat${st.count === 1 ? '' : 's'}${st.hidden ? ` · ${st.hidden.toLocaleString()} ${b.changing ? 'not changing or ' : ''}with no data here` : ''}`;
    const first = Math.max(0, Math.floor((scroll.scrollTop || 0) / ROW) - 4);
    const last = Math.min(n, first + Math.ceil((scroll.clientHeight || 15 * ROW) / ROW) + 8);
    const drawn = `${st.gen}|${first}|${last}`;
    // (kept on the element: a redraw of the bar gives a new, empty one)
    if (pad.dataset.drawn !== drawn) {
      pad.dataset.drawn = drawn;
      pad.style.height = `${n * ROW}px`;
      pad.innerHTML = n
        ? st.rows.slice(first, last).map((s, k) => (s.head ? `<div class="sd-list-r sd-list-h" role="row" style="top:${(first + k) * ROW}px"><span class="sd-list-l" role="columnheader">${esc(s.head)}</span></div>` : `<div class="sd-list-r${s.popular ? ' sd-list-pop' : ''}" role="row" style="top:${(first + k) * ROW}px" data-row="${first + k}" title="${esc(`${s.label} (${s.group}${s.canName ? `, ${s.canName}` : ''})${s.about ? `: ${s.about}` : ''}`)}"><span class="sd-list-l" role="cell">${esc(s.label)}</span><span class="sd-list-m" role="cell">${esc(s.popular && s.source === 'can' ? s.ownLabel : messageOf(s))}</span><span class="sd-list-v" role="cell" data-lv></span></div>`)).join('')
        : `<div class="sd-list-empty">${b.q ? `No stat with data here matches "${esc(b.q)}".` : b.changing ? 'Nothing changes in this clip.' : 'No car data for this clip yet.'}</div>`;
    }
    const nowMs = Date.now();
    pad.querySelectorAll('[data-row]').forEach((rowEl) => {
      const s = st.rows[Number(rowEl.dataset.row)];
      if (!s || s.head) return;
      const v = valueOf(s, r, c);
      const shown = `${v.text}|${v.unit}`;
      const vEl = rowEl.querySelector('[data-lv]');
      if (vEl && vEl.dataset.shown !== shown) {
        vEl.dataset.shown = shown;
        vEl.innerHTML = `${esc(v.text)}${v.unit ? `<small>${esc(v.unit)}</small>` : ''}`;
        if (v.title) vEl.setAttribute('title', v.title); else vEl.removeAttribute?.('title');
      }
      const before = st.prev.get(s.id);
      st.prev.set(s.id, shown);
      if (before !== undefined && before !== shown) { st.hot.set(s.id, nowMs + 700); hotLeft++; }
      rowEl.classList.toggle('hot', (st.hot.get(s.id) || 0) > nowMs);
    });
  }
  /** A lit value goes out after its moment, even while paused. */
  function coolLists() {
    if (!hotLeft) return;
    const nowMs = Date.now();
    let left = 0;
    panel.querySelectorAll('.sd-list').forEach((node) => {
      const st = lists.get(board.blocks[Number(node.dataset.i)]);
      if (!st) return;
      node.querySelectorAll('.sd-list-r.hot').forEach((rowEl) => {
        const s = st.rows[Number(rowEl.dataset.row)];
        if ((st.hot.get(s?.id) || 0) <= nowMs) rowEl.classList.remove('hot'); else left++;
      });
    });
    hotLeft = left;
  }

  function blockHtml(b, i) {
    const sigs = b.signals.map((id) => SIGNALS.get(id));
    const editBar = `<div class="sd-edit sd-bar-edit"><span class="sd-grip" data-grip="${i}" title="Drag to move" aria-hidden="true">⠿</span>
      <button type="button" class="sd-btn" data-move="${i}" data-dir="-1" aria-label="Move left">‹</button><button type="button" class="sd-btn" data-move="${i}" data-dir="1" aria-label="Move right">›</button>
      <button type="button" class="sd-btn sd-x" data-remove="${i}" aria-label="Remove this block">×</button></div>`;
    const pick = editing ? `<div class="sd-edit sd-pick">${b.signals.map((id, k) => pickButton(id, i, k)).join('')}</div>` : '';
    const label = (s, k = 0) => esc(s?.label || String(b.signals[k] || '?').replace(/^can\./, ''));
    if (b.type === 'small') {
      const s = sigs[0];
      return `<div class="sd-b sd-small" data-i="${i}">${editBar}<div><span class="sd-v" data-v="0"></span><span class="sd-u" data-u="0"></span></div><div class="sd-l"${s?.about ? ` title="${esc(s.about)}"` : ''}>${label(s)}</div>${s?.bar ? '<div class="sd-bar"><i data-bar="0"></i></div>' : ''}${pick}</div>`;
    }
    if (b.type === 'wide') {
      return `<div class="sd-b sd-wide" data-i="${i}">${editBar}${sigs.map((s, k) => `<div class="sd-line"><span class="sd-l"${s?.about ? ` title="${esc(s.about)}"` : ''}>${label(s, k)}</span><span><span class="sd-v" data-v="${k}"></span><span class="sd-u" data-u="${k}"></span></span></div>`).join('')}${pick}</div>`;
    }
    if (b.type === 'gauge') {
      return `<div class="sd-b sd-gauge" data-i="${i}">${editBar}<div class="sd-ring"><span class="sd-v" data-v="0"></span><span class="sd-u" data-u="0"></span><div class="sd-gears" data-gears></div></div><div class="sd-ap" data-ap></div>${pick}</div>`;
    }
    if (b.type === 'list') {
      return `<div class="sd-b sd-list" data-i="${i}">${editBar}<div class="sd-list-bar"><input type="search" data-list-q="${i}" value="${esc(b.q || '')}" placeholder="Filter: battery, volt, brake…" aria-label="Filter the stats" autocomplete="off" spellcheck="false">
        <label class="sd-list-ch"><input type="checkbox" data-list-changing="${i}"${b.changing ? ' checked' : ''}> Changing only</label><span class="sd-list-n" data-list-n aria-live="polite"></span></div>
        <div class="sd-list-scroll" data-list-scroll="${i}" tabindex="0" role="table" aria-label="Every stat at this moment"><div class="sd-list-pad" data-list-pad role="rowgroup"></div></div></div>`;
    }
    const s = sigs[0];
    const kindClass = /brake/i.test(s?.id) ? 'sd-brake' : /blink/i.test(s?.id) ? 'sd-blink' : /autopilot/i.test(s?.id) ? 'sd-ap' : '';
    return `<div class="sd-b sd-state ${kindClass}" data-i="${i}">${editBar}<span class="sd-ico" aria-hidden="true">${esc(s?.icon || '●')}</span><div class="sd-l">${label(s)}</div>${pick}</div>`;
  }
  const MOVE_BAR = '<button type="button" class="sd-btn sd-move" data-move-bar aria-label="Move the car data: drag it anywhere, or use the arrow keys" title="Drag to move it anywhere (arrow keys work too)">⠿ Move</button>';
  const DOCK_LIST = '<button type="button" class="sd-btn" data-dock-list title="Put the list back under the car data">Dock</button>';
  const putBack = () => `<button type="button" class="sd-btn" data-dock-bar title="Put the car data back ${board.barHome === 'over' || over ? 'over the video' : 'under the cameras'}">Put back</button>`;
  function draw() {
    if (pop && (!editing || hidden || !board.blocks[pop.pick])) closePick(false);
    kindDrawn = screenKind();
    place();
    el.classList.toggle('editing', editing);
    panel.classList.toggle('editing', editing);
    placePanel();
    if (hidden) {
      el.innerHTML = '<div class="sd-tools"><button type="button" class="sd-btn" data-show>Show car data</button></div>';
      applyFloat();
      return;
    }
    const boardsSel = state.boards.length > 1 || editing
      ? `<select data-board aria-label="Dashboard">${state.boards.map((x) => `<option value="${esc(x.id)}"${x.id === board.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : '';
    const inBar = board.blocks.map((b, i) => (b.type === 'list' ? '' : blockHtml(b, i))).join('');
    const lists = board.blocks.map((b, i) => (b.type === 'list' ? blockHtml(b, i) : '')).join('');
    panel.innerHTML = lists && `<div class="sd-tools sd-listhead"><button type="button" class="sd-btn sd-move" data-move-list aria-label="Move the list: drag it, or use the arrow keys" title="Drag to move anywhere (arrow keys work too)">⠿ Move</button>
        <b class="sd-listtitle">Every stat</b>${listFloats() ? DOCK_LIST : ''}</div><div class="sd-row">${lists}</div>
        <button type="button" class="sd-btn sd-size" data-size-list aria-label="Resize the list: drag, or Shift and the arrow keys" title="Drag to resize (Shift and the arrow keys work too)">◢</button>`;
    el.innerHTML = `<div class="sd-row" data-row>${inBar || (lists ? '' : '<span class="sd-none">No blocks: Customize to add some.</span>')}</div>
      <div class="sd-tools">${MOVE_BAR}${whereNow() === 'float' ? putBack() : ''}${boardsSel}
        <button type="button" class="sd-btn" data-edit aria-pressed="${editing}">${editing ? 'Done' : 'Customize'}</button>
        <span class="sd-edit" style="gap:6px;flex-wrap:wrap;align-items:center">
          <button type="button" class="sd-btn" data-add="small">+ Small</button><button type="button" class="sd-btn" data-add="wide">+ Wide (3)</button>
          <button type="button" class="sd-btn" data-add="gauge">+ Gauge</button><button type="button" class="sd-btn" data-add="state">+ Light</button><button type="button" class="sd-btn" data-add="list">+ List (every stat)</button>
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
        <button type="button" class="sd-btn sd-hide" data-hide aria-label="Hide the car data">Hide</button></div>
      <button type="button" class="sd-btn sd-size" data-size-bar aria-label="Resize the car data: drag, or Shift and the arrow keys" title="Drag to resize (Shift and the arrow keys work too)">${whereNow() === 'over' ? '◥' : '◢'}</button>`;
    syncNote();
    el.appendChild(rawView.el);
    if (pop) { pop.opener = el.querySelector(`[data-pick="${pop.pick}"][data-slot="${pop.slot}"]`) || pop.opener; if (!pop.node.parentElement) popHost().appendChild(pop.node); }
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
    shownPath = path || null;
    if (path) { loadCan(path); rawView.setPath(path); }
    const ms = (m?.currentTime || 0) * 1000;
    const r = recs ? recordAt(recs, ms) : null;
    const key = `${path}|${r?.t ?? 'x'}|${recs ? 1 : 0}|${editing}|${canBar.data || canAll.data ? Math.floor(ms / 50) : ''}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    const c = ctx(ms);
    [...el.querySelectorAll('[data-i]'), ...panel.querySelectorAll('[data-i]')].forEach((node) => {
      const b = board.blocks[Number(node.dataset.i)];
      if (!b) return;
      if (b.type === 'list') { renderList(node, b, r, c); return; }
      b.signals.forEach((id, k) => {
        const s = SIGNALS.get(id);
        const vEl = node.querySelector(`[data-v="${k}"]`);
        const uEl = node.querySelector(`[data-u="${k}"]`);
        const v = valueOf(s, r, c);
        if (vEl) { vEl.textContent = v.text; if (v.title) vEl.setAttribute('title', v.title); else vEl.removeAttribute?.('title'); }
        if (uEl) uEl.textContent = v.unit;
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
    coolLists();
    if (!hidden) rawView.tick((main()?.currentTime || 0) * 1000);
    raf = requestAnimationFrame(loop);
  };

  // both boxes (the bar and the list box) answer the same taps and keys
  const on = (type, fn, capture) => { el.addEventListener(type, fn, capture); panel.addEventListener(type, fn, capture); };
  // editing
  on('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.matches('[data-pick]')) { openPick(t); return; }
    if (t.matches('[data-dock-list]')) { board.listPlacement = 'dock'; change(); panel.querySelector('[data-move-list]')?.focus(); return; }
    if (t.matches('[data-dock-bar]')) { board.placement = board.barHome === 'over' ? 'over' : 'below'; change(); el.querySelector('[data-move-bar]')?.focus(); return; }
    if (t.matches('[data-edit]')) { editing = !editing; draw(); return; }
    if (t.matches('[data-raw]')) { rawView.toggle(); t.setAttribute('aria-pressed', String(rawView.open)); return; }
    if (t.matches('[data-hide]')) { hidden = true; editing = false; draw(); return; }
    if (t.matches('[data-show]')) { hidden = false; draw(); return; }
    if (t.matches('[data-add]')) {
      const type = t.dataset.add;
      board.blocks.push({ type, signals: DEFAULT_SIGNAL[type].slice(0, SLOTS[type]), ...(type === 'list' ? { q: '', changing: false } : {}) });
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
      (el.querySelector(`[data-move="${j}"][data-dir="${t.dataset.dir}"]`) || panel.querySelector(`[data-move="${j}"][data-dir="${t.dataset.dir}"]`))?.focus();
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
  // a list's search and "changing only": kept with the dashboard; the list redrawn without a full redraw (the cursor stays)
  let listSave = null;
  const redrawList = (i) => { const node = panel.querySelector(`.sd-list[data-i="${i}"]`); if (node) { const m = main(); const ms = (m?.currentTime || 0) * 1000; renderList(node, board.blocks[i], recs ? recordAt(recs, ms) : null, ctx(ms)); } };
  on('input', (e) => {
    const t = e.target;
    if (!t.matches?.('[data-list-q]')) return;
    const i = Number(t.dataset.listQ);
    const b = board.blocks[i];
    if (!b) return;
    b.q = String(t.value || '').slice(0, 60);
    const scroll = panel.querySelector(`[data-list-scroll="${i}"]`);
    if (scroll) scroll.scrollTop = 0;
    redrawList(i);
    clearTimeout(listSave);
    listSave = setTimeout(() => { listSave = null; saveBoards(state); }, 600);
  });
  on('scroll', (e) => { const t = e.target; if (t?.matches?.('[data-list-scroll]')) redrawList(Number(t.dataset.listScroll)); }, true);
  on('change', (e) => {
    const t = e.target;
    if (t.matches('[data-list-changing]')) {
      const i = Number(t.dataset.listChanging);
      if (board.blocks[i]) { board.blocks[i].changing = Boolean(t.checked); saveBoards(state); redrawList(i); }
      return;
    }
    if (t.matches('[data-board]')) {
      board = state.boards.find((x) => x.id === t.value) || board;
      state.active = board.id;
      change();
    } else if (t.matches('[data-placement]')) {
      if (t.value === 'float' && whereNow() !== 'float') {
        board.barHome = whereNow() === 'over' ? 'over' : 'below';
        // no spot for this kind of screen yet: it floats from where it is now (none is made up)
        if (!spotOf('float')) { unDock(el); const p = pageXY(el); keepFloat(p.left, p.top, el); }
      }
      board.placement = t.value;
      change();
      el.querySelector('[data-placement]')?.focus();
    }
  });
  // Both boxes move with their Move handle: dragged (mouse, pen or finger), or nudged with the
  // arrow keys. A docked box leaves its place as it is first moved (the bar: "Put back" returns
  // it; the list: "Dock"). The pointer is followed on the window, not on the box: a redraw
  // during the drag (a clip's signals arriving) replaces the handle, and the drag goes on.
  const moverOf = (target) => (target.closest?.('[data-move-bar]') ? el : target.closest?.('[data-move-list]') ? panel : null);
  const sizerOf = (target) => (target.closest?.('[data-size-bar]') ? el : target.closest?.('[data-size-list]') ? panel : null);
  function unDock(node) {
    if (floating(node)) return;
    const at = pageXY(node);
    loose.add(node); // (floating where it is until its spot is kept)
    if (node === panel) {
      board.listPlacement = 'float';
      placePanel();
      const head = panel.querySelector('.sd-listhead');
      if (head && !head.querySelector('[data-dock-list]')) head.insertAdjacentHTML?.('beforeend', DOCK_LIST);
    } else {
      board.barHome = whereNow() === 'over' ? 'over' : 'below';
      board.placement = 'float';
      place();
      placePanel();
      el.querySelector('[data-move-bar]')?.insertAdjacentHTML?.('afterend', putBack());
      const sel = el.querySelector('[data-placement]');
      if (sel) sel.value = 'float';
    }
    applySize(node);
    setPagePos(node, at.left, at.top);
  }
  let gesture = null; // { kind: 'move' | 'size', node, id, ... }
  const W = globalThis;
  function endGesture(e) {
    if (!gesture || (e && e.pointerId !== gesture.id)) return;
    const g = gesture;
    gesture = null;
    held = null;
    W.removeEventListener?.('pointermove', onGestureMove, true);
    W.removeEventListener?.('pointerup', endGesture, true);
    W.removeEventListener?.('pointercancel', endGesture, true);
    g.node.classList.remove('moving');
    g.node.classList.remove('sizing');
    if (g.kind === 'move' && g.moved) { const p = pageXY(g.node); keepFloat(p.left, p.top, g.node); }
    if (g.kind === 'size' && g.moved) {
      const r = rectOf(g.node);
      keepSize(g.node, Math.round(r.width), Math.round(r.height));
      if (floating(g.node)) { const p = pageXY(g.node); keepFloat(p.left, p.top, g.node); }
      redrawLists();
    }
  }
  function onGestureMove(e) {
    const g = gesture;
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    e.preventDefault?.();
    if (g.kind === 'move') {
      if (!g.moved) {
        unDock(g.node);
        g.pb = pageBox();
        // the handle stays under the pointer, wherever it is in the box now
        const nr = rectOf(g.node);
        const hr = rectOf(g.node.querySelector('.sd-move') || g.node);
        g.dx = hr.left - nr.left + g.hx;
        g.dy = hr.top - nr.top + g.hy;
      }
      g.moved = true;
      setPagePos(g.node, e.clientX - g.dx + sx(), e.clientY - g.dy + sy(), g.pb);
      return;
    }
    g.moved = true;
    const c = clampSize(g.node, Math.min(g.room, g.w0 + dx), g.h0 + (g.up ? -dy : dy));
    if (g.free) { g.node.style.width = `${c.w}px`; g.node.style.maxWidth = 'none'; }
    g.node.style.height = `${c.h}px`;
    g.node.classList.add('sized');
    redrawLists();
  }
  function startGesture(e, g) {
    e.preventDefault();
    endGesture();
    gesture = { ...g, id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false };
    held = g.node;
    try { e.target.closest?.('button')?.setPointerCapture?.(e.pointerId); } catch { /* the window follows it anyway */ }
    W.addEventListener?.('pointermove', onGestureMove, true);
    W.addEventListener?.('pointerup', endGesture, true);
    W.addEventListener?.('pointercancel', endGesture, true);
  }
  on('pointerdown', (e) => {
    if (e.button > 0) return;
    const mover = moverOf(e.target);
    if (mover) {
      const hr = rectOf(e.target.closest('.sd-move'));
      startGesture(e, { kind: 'move', node: mover, hx: e.clientX - hr.left, hy: e.clientY - hr.top });
      mover.classList.add('moving');
      return;
    }
    const sizer = sizerOf(e.target);
    if (!sizer) return;
    const r = rectOf(sizer);
    const free = floating(sizer);
    startGesture(e, { kind: 'size', node: sizer, w0: r.width, h0: r.height, free, up: sizer === el && whereNow() === 'over', room: free ? viewW() - r.left : Infinity });
    sizer.classList.add('sizing');
  });
  const redrawLists = () => panel.querySelectorAll('.sd-list').forEach((n) => redrawList(Number(n.dataset.i)));
  on('keydown', (e) => {
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!k) return;
    const step = e.shiftKey ? 50 : 10;
    const node = moverOf(e.target);
    if (node) {
      e.preventDefault();
      unDock(node);
      const p = pageXY(node);
      keepFloat(p.left + k[0] * step, p.top + k[1] * step, node);
      node.querySelector('.sd-move')?.focus();
      return;
    }
    const sizer = sizerOf(e.target);
    if (!sizer) return;
    e.preventDefault();
    const r = rectOf(sizer);
    const free = floating(sizer);
    const up = sizer === el && whereNow() === 'over';
    const c = clampSize(sizer, free ? Math.min(viewW() - r.left, r.width + k[0] * step) : r.width, r.height + (up ? -k[1] : k[1]) * step);
    keepSize(sizer, c.w, c.h);
    applySize(sizer);
    if (free) { const p = pageXY(sizer); keepFloat(p.left, p.top, sizer); }
    redrawLists();
    sizer.querySelector('.sd-size')?.focus();
  });
  // drag a block by its grip to move it
  let drag = null;
  on('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip || !editing) return;
    e.preventDefault();
    drag = { from: Number(grip.dataset.grip), node: grip.closest('.sd-b'), id: e.pointerId };
    drag.node.classList.add('dragging');
    grip.setPointerCapture?.(e.pointerId);
  });
  on('pointermove', (e) => {
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
  on('pointerup', endDrag);
  on('pointercancel', endDrag);
  // the dashboard's own keys and taps stay its own (the Viewer's shortcuts do not fire)
  on('keydown', (e) => e.stopPropagation());

  loadBoards().then((d) => {
    if (!alive) return;
    state = { boards: d.boards.map((x) => ({ ...DEFAULT_BOARD(), ...x, blocks: (x.blocks || []).filter((b) => Object.hasOwn(SLOTS, String(b?.type))).map((b) => ({ ...(b.type === 'list' ? { q: String(b.q || ''), changing: b.changing === true } : {}), type: b.type, signals: [...(b.signals || [])].concat(DEFAULT_SIGNAL[b.type]).slice(0, SLOTS[b.type]).map((id) => (SIGNALS.has(id) || String(id).startsWith('can.') ? id : DEFAULT_SIGNAL[b.type][0])) })) })), active: d.active };
    board = state.boards.find((x) => x.id === state.active) || state.boards[0];
    draw();
    raf = requestAnimationFrame(loop);
  });
  return {
    el,
    panel, // the list box (outside the bar)
    destroy() {
      closePick(false);
      endGesture();
      // a List filter typed in the last moment is kept (its save waits for the typing to stop)
      if (listSave) { clearTimeout(listSave); listSave = null; if (state) saveBoards(state); }
      flushBoards(); // (and any save still waiting: the page is going)
      alive = false; cancelAnimationFrame(raf); cancelAnimationFrame(reflowRaf); pageWatch?.disconnect();
      clearTimeout(canBar.retry); clearTimeout(canAll.retry); globalThis.removeEventListener?.('resize', onResize);
      for (const type of ['transitionend', 'animationend']) document.removeEventListener?.(type, onSettle, true);
      for (const type of ['fullscreenchange', 'webkitfullscreenchange']) document.removeEventListener?.(type, onFullscreen);
      rawView.destroy(); el.remove(); panel.remove();
    }
  };
}
