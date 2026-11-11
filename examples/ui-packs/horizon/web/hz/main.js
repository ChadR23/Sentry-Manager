// Horizon shell: the dashboard HUD strip with its radio display, the phone tuner
// bar and quick-action button, routing, keyboard, live updates and badges.
import { qs, qsa, h, ico, api, conv, app, car, pickCar, loadCars, loadNotes, bus, toast, sheet, act, clockPref } from './core.js';
import { hiddenRoute } from '/web/hiddenTabs.js';

export const PAGES = [
  { id: 'dashboard', label: 'Dashboard', short: 'Dash', icon: 'dash' },
  { id: 'footage', label: 'Footage', icon: 'film' },
  { id: 'viewer', label: 'Viewer', icon: 'viewer' },
  { id: 'encoder', label: 'Encoder', icon: 'engine' },
  { id: 'sentryusb', label: 'Sentry USB', icon: 'usb' },
  // the right-hand group of the top bar starts here (nav-b)
  { id: 'policies', label: 'Policies', icon: 'policy' },
  { id: 'jobs', label: 'Jobs', icon: 'jobs' },
  { id: 'bin', label: 'Recycle Bin', short: 'Bin', icon: 'bin' },
  { id: 'alerts', label: 'Notifications', short: 'Alerts', icon: 'bell' },
  // (not in the top bar, which they would overflow: the tuner and Settings reach them)
  { id: 'health', label: 'Health', icon: 'shield', bar: false },
  { id: 'account', label: 'Account', icon: 'lock', bar: false },
  { id: 'settings', label: 'Settings', icon: 'gear' }
];
// Drives is hidden for now (web/hiddenTabs.js): no navigation; its addresses open the Dashboard
const byId = Object.fromEntries([...PAGES, { id: 'drives', label: 'Drives', icon: 'route' }].map((p, i) => [p.id, { ...p, n: i + 1 }]));
const RUNNING = new Set(['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing']);

// ---------- navigation markup ----------
const navItem = (p) => `<a href="#/${p.id}" data-route="${p.id}" class="nav-i"><span class="nav-ico">${ico(p.icon)}<span class="badge" data-badge="${p.id}" hidden></span></span><span class="nav-l">${h(p.short || p.label)}</span></a>`;
const SPLIT = PAGES.findIndex((p) => p.id === 'policies');
qs('#nav-a').innerHTML = PAGES.slice(0, SPLIT).map(navItem).join('');
qs('#nav-b').innerHTML = PAGES.slice(SPLIT).filter((p) => p.bar !== false).map(navItem).join('');
qs('#tuner').innerHTML = `<div class="tuner-track" id="tuner-track">${PAGES.map((p) => `<a href="#/${p.id}" data-route="${p.id}" class="tune">${ico(p.icon)}<span>${h(p.short || p.label)}</span><span class="badge" data-badge="${p.id}" hidden></span></a>`).join('')}</div>`;

export function setBadge(id, text, tone = '') {
  qsa(`[data-badge="${id}"]`).forEach((b) => {
    b.hidden = !text;
    b.textContent = text || '';
    b.className = `badge ${tone}`;
  });
  if (id === 'alerts') {
    qs('#bell-badge').hidden = !text;
    qs('#bell-badge').textContent = text || '';
    qs('#bell').setAttribute('aria-label', text ? `Notifications, ${text} unread` : 'Notifications');
  }
}

function drawCarPick() {
  const sel = qs('#car-pick');
  const v = car();
  sel.innerHTML = app.vehicles.length ? app.vehicles.map((x) => `<option value="${h(x.id)}"${x.id === v?.id ? ' selected' : ''}>${h(x.name)}</option>`).join('') : '<option value="">No vehicle</option>';
  const many = app.vehicles.length > 1;
  sel.hidden = !many;
  qs('#car-one').hidden = many;
  qs('#car-one').textContent = v ? v.name : 'No vehicle';
  const binItems = app.vehicles.reduce((n, x) => n + (x.binItems || 0), 0);
  setBadge('bin', binItems ? String(binItems) : '');
  radioSub();
}
qs('#car-pick').addEventListener('change', (e) => pickCar(e.target.value));

// ---------- the top bar: one row when everything fits, else two ----------
// Each part is measured by what it holds, not by the room its column gives
// it, so the answer is the same in either layout and never flips back and
// forth: brand, both page groups, the radio and the tools. The car is counted
// as wide as it shows on one row, where the page groups give way first: the
// name up to its max-width in app.css (then "…"), the picker (two or more
// vehicles) at its set width.
const CAR_MAX = 160;
const wide = matchMedia('(min-width: 1024px)');
const w = (el) => (el && el.getClientRects().length ? el.getBoundingClientRect().width : 0);
function inner(el, gap, size = w) {
  const kids = [...el.children].filter((k) => k.getClientRects().length);
  return kids.reduce((n, k) => n + size(k), 0) + gap * Math.max(0, kids.length - 1);
}
function fitBar() {
  const dash = qs('#dash');
  if (!wide.matches) { dash.classList.remove('two'); return; }
  const pick = qs('#car-pick-wrap');
  const carSize = (k) => (k.id === 'car-one' ? Math.min(k.scrollWidth, CAR_MAX) : w(k));
  const tools = inner(qs('.dash-tools'), 4, (k) => (k === pick ? inner(pick, 6, carSize) : w(k)));
  const cs = getComputedStyle(dash);
  const room = dash.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  // the page groups sit in equal columns either side of the radio: each
  // side needs room for the longer of the two
  const side = Math.max(inner(qs('#nav-a'), 2), inner(qs('#nav-b'), 2));
  const need = inner(qs('.dash-brand'), 10) + 6 + 2 * side + w(qs('.radio')) + tools + 4 * 10;
  dash.classList.toggle('two', need > room);
}
new ResizeObserver(() => fitBar()).observe(qs('#dash'));
wide.addEventListener('change', fitBar);
document.fonts?.ready.then(fitBar);
bus.on('cars', fitBar);
bus.on('car', fitBar);
fitBar();
bus.on('cars', drawCarPick);
bus.on('car', drawCarPick);

function drawNoteBadge() {
  const open = app.notes.filter((n) => !n.resolvedAt);
  const unread = open.filter((n) => !n.readAt).length;
  setBadge('alerts', unread ? String(unread) : '', open.some((n) => n.level === 'critical') ? 'bad' : 'warn');
}
bus.on('notes', drawNoteBadge);

// ---------- the converter: badge and the "engine running" cue ----------
function converterState(st) {
  app.converter = st || null;
  const on = RUNNING.has(st);
  window.HorizonSky?.engine(on);
  setBadge('encoder', on ? '●' : st === 'paused' || st === 'paused_network' ? 'II' : '', on ? 'live' : 'warn');
  qs('#dash').classList.toggle('engine', on);
}
bus.on('converter-state', converterState);
let convTimer = 0;
async function pollConverter() {
  clearTimeout(convTimer);
  if (document.visibilityState === 'visible' && mountedId !== 'encoder') {
    const r = await conv('getCurrent');
    if (r.ok) converterState(r.value?.state || null);
  }
  convTimer = setTimeout(pollConverter, RUNNING.has(app.converter) ? 5000 : 15000);
}
async function refreshJobs() {
  try {
    const { jobs } = await api('/api/jobs?limit=50');
    const n = jobs.filter((j) => j.status === 'running').length;
    setBadge('jobs', n ? String(n) : '', 'live');
  } catch { /* the page shows errors */ }
}

// ---------- router ----------
const view = qs('#view');
let mounted = null;
let mountedId = null;
let seq = 0;
let subText = '';

// pages that moved inside another as its sub-tab: their old addresses open them there
const MOVED = { driving: 'drives/driving', map: 'drives/map', vehicles: 'policies/per-car', nodes: 'settings/nodes' };
function movedHash() {
  const was = /^#\/?([\w-]+)\/?(\?.*)?$/.exec(location.hash);
  if (was && MOVED[was[1]]) history.replaceState(null, '', `#/${MOVED[was[1]]}${was[2] || ''}`);
  if (hiddenRoute(location.hash.replace(/^#\/?/, '').split(/[/?]/)[0])) history.replaceState(null, '', '#/dashboard');
}
export function parse() {
  movedHash();
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const [route, ...rest] = path.split('/');
  return { route: byId[route] ? route : 'dashboard', sub: rest.join('/'), params: new URLSearchParams(query) };
}
export function go(hash) {
  if (location.hash === hash) render(); else location.hash = hash;
}
function radioSub() {
  const v = car();
  qs('#radio-sub').textContent = subText || (v ? v.name : 'no vehicle');
}
function status(text) {
  subText = text || '';
  radioSub();
}

async function render() {
  const mine = ++seq;
  const { route, sub, params } = parse();
  const p = byId[route];
  try { mounted?.unmount?.(); } catch (err) { console.warn(err); }
  mounted = null;
  mountedId = route;
  subText = '';
  window.HorizonSky?.hold('video', false);
  qsa('[data-route]').forEach((a) => {
    const on = a.dataset.route === route;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  qs('#radio-ch').textContent = `CH ${String(p.n).padStart(2, '0')}`;
  qs('#radio-name').textContent = p.label;
  radioSub();
  document.title = `${p.label} · Horizon · Sentry Six Manager`;
  document.body.dataset.route = route;
  view.className = `view v-${route}`;
  // each visit gets its own box, so a late reply of the page just left only ever
  // touches that (now detached) box, never the new page
  const host = document.createElement('div');
  host.className = 'page';
  host.innerHTML = '<div class="loading" role="status"><span class="sr-only">Loading</span><i></i><i></i><i></i></div>';
  view.replaceChildren(host);
  // keep the active tuner button in view
  const tune = qs(`#tuner [data-route="${route}"]`);
  if (tune) {
    const track = qs('#tuner-track');
    const left = tune.offsetLeft - (track.clientWidth - tune.offsetWidth) / 2;
    track.scrollTo({ left: Math.max(0, left), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  try {
    const mod = await import(`./pages/${route}.js`);
    if (mine !== seq) return;
    const m = await mod.default.mount(host, { sub, params, go, status: (t) => { if (mine === seq) status(t); }, alive: () => mine === seq });
    if (mine !== seq) { m?.unmount?.(); return; }
    mounted = m || {};
  } catch (err) {
    if (mine !== seq) return;
    console.warn(err);
    host.innerHTML = `<div class="blank hud"><p>${h(err.message || 'This page could not load.')}</p><button class="btn" type="button" id="retry">${ico('refresh')}Try again</button></div>`;
    qs('#retry')?.addEventListener('click', render);
  }
  if (mine === seq && !matchMedia('(prefers-reduced-motion: reduce)').matches) view.animate?.([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'ease-out' });
}
window.addEventListener('hashchange', render);
function seek(d) {
  const i = PAGES.findIndex((p) => p.id === mountedId);
  go(`#/${PAGES[(i + d + PAGES.length) % PAGES.length].id}`);
}
qs('#seek-prev').onclick = () => seek(-1);
qs('#seek-next').onclick = () => seek(1);
bus.on('car', () => {
  if (mounted?.onCar) mounted.onCar();
  else if (['footage', 'policies', 'jobs', 'bin', 'dashboard'].includes(mountedId)) render();
});

// ---------- live updates ----------
let es = null;
let wait = 1000;
function live() {
  es = new EventSource('/api/events');
  const dot = qs('#radio-live');
  es.addEventListener('open', () => { dot.className = 'radio-live on'; dot.title = 'Live updates: connected'; wait = 1000; });
  es.addEventListener('error', () => {
    dot.className = 'radio-live off';
    dot.title = 'Live updates: reconnecting';
    if (es.readyState === EventSource.CLOSED) {
      setTimeout(live, wait);
      wait = Math.min(wait * 2, 30000);
    }
  });
  es.addEventListener('changed', async (e) => {
    let topics = [];
    try { ({ topics } = JSON.parse(e.data)); } catch { return; }
    if (topics.includes('interface')) { location.reload(); return; }
    if (topics.some((t) => ['vehicles', 'inventory', 'bin'].includes(t))) await loadCars().catch(() => {});
    if (topics.includes('notifications')) await loadNotes().catch(() => {});
    if (topics.includes('jobs')) refreshJobs();
    try { mounted?.onTopics?.(topics); } catch (err) { console.warn(err); }
  });
}

// ---------- quick actions (phones and tablets) ----------
async function quick() {
  const v = car();
  const st = app.converter;
  const mode = window.HorizonSky?.choice || 'auto';
  const items = [
    ['play', 'Play the newest footage', '#/viewer'],
    ['engine', 'Start a conversion', '#/encoder?new=1'],
    ...(RUNNING.has(st) ? [['pause', 'Pause the conversion', 'pause']] : st === 'paused' || st === 'paused_network' ? [['play', 'Resume the conversion', 'resume']] : []),
    ['refresh', v ? `Refresh ${v.name}'s inventory` : 'Refresh the inventory', 'scan'],
    ['check', 'Mark every notification read', 'read'],
    ['film', 'Footage track list', '#/footage'],
    ['gear', 'Interface and background', '#/settings/interface']
  ];
  await sheet('Quick actions', `<div class="quick">${items.map(([i, l, a]) => `<button class="btn quick-i" type="button" value="${h(a)}">${ico(i)}<span>${h(l)}</span></button>`).join('')}
    ${app.vehicles.length > 1 ? `<label class="fld">Vehicle<select class="in" id="q-car">${app.vehicles.map((x) => `<option value="${h(x.id)}"${x.id === v?.id ? ' selected' : ''}>${h(x.name)}</option>`).join('')}</select></label>` : ''}
    <div class="fld">Background effect<div class="segs" role="radiogroup" aria-label="Background effect">${[['auto', 'Auto'], ['full', 'Full'], ['calm', 'Calm'], ['off', 'Off']].map(([k, l]) => `<button type="button" role="radio" data-sky="${k}" aria-checked="${k === mode}" class="${k === mode ? 'on' : ''}">${l}</button>`).join('')}</div></div></div>`, {
    wide: false,
    onOpen(form, dlg) {
      form.querySelector('#q-car')?.addEventListener('change', (e) => { pickCar(e.target.value); dlg.close('car'); });
      form.querySelectorAll('[data-sky]').forEach((b) => {
        b.onclick = () => {
          window.HorizonSky?.setChoice(b.dataset.sky);
          form.querySelectorAll('[data-sky]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
        };
      });
      form.querySelectorAll('.quick-i').forEach((b) => {
        b.onclick = async (e) => {
          e.preventDefault();
          const a = b.value;
          dlg.close(a);
          if (a.startsWith('#')) { go(a); return; }
          if (a === 'scan' && v) await act(null, async () => { await api(`/api/vehicles/${encodeURIComponent(v.id)}/scan`, { body: {} }); toast('Refreshing the inventory. Jobs shows the progress.'); });
          if (a === 'read') {
            await act(null, async () => {
              const ids = app.notes.filter((n) => !n.readAt).map((n) => n.id);
              if (ids.length) await api('/api/notifications/read', { body: { ids } });
              await loadNotes();
              toast(ids.length ? 'All notifications marked read.' : 'Nothing unread.');
            });
          }
          if (a === 'pause' || a === 'resume') {
            const cur = await conv('getCurrent');
            const id = cur.ok ? cur.value?.id : null;
            if (!id) return;
            const r = await conv(a, { jobId: id });
            if (r.ok) { toast(a === 'pause' ? 'Conversion paused.' : 'Conversion resumed.'); converterState(r.value?.state || (a === 'pause' ? 'paused' : 'encoding')); bus.emit('converter-refresh'); } else toast(`Converter: ${r.error?.code || 'failed'}`, 'bad');
          }
        };
      });
    }
  });
}
qs('#fab').onclick = quick;

// ---------- keyboard ----------
const GLOBAL_KEYS = [['[ / ]', 'Previous / next page (tune the radio)'], ['?', 'This sheet'], ['Esc', 'Close a dialog']];
function keysSheet() {
  const own = mounted?.keys || [];
  const row = ([k, d]) => `<div class="kb"><span>${k.split(' ').map((x) => (['/', 'or', '·'].includes(x) ? `<span class="dim">${h(x)}</span>` : `<kbd>${h(x)}</kbd>`)).join(' ')}</span><span>${h(d)}</span></div>`;
  sheet('Keyboard shortcuts', `<section class="kbs"><h3>Everywhere</h3>${GLOBAL_KEYS.map(row).join('')}</section>${own.length ? `<section class="kbs"><h3>${h(byId[mountedId].label)}</h3>${own.map(row).join('')}</section>` : ''}<p class="dim small">Every shortcut has a button too, so everything also works by touch.</p>`);
}
qs('#keys-btn').onclick = keysSheet;
const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) && !(el.tagName === 'INPUT' && ['checkbox', 'radio', 'button', 'range'].includes(el.type));
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (typing(e.target)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (mounted?.onKey?.(e)) { e.preventDefault(); return; }
  if (e.key === '[') { e.preventDefault(); seek(-1); }
  else if (e.key === ']') { e.preventDefault(); seek(1); }
  else if (e.key === '?') { e.preventDefault(); keysSheet(); }
});

// tuner: a mouse wheel scrolls the bar sideways
qs('#tuner').addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { qs('#tuner-track').scrollLeft += e.deltaY; }
}, { passive: true });

// dialogs: a click on the backdrop closes
qs('#hz-dlg').addEventListener('click', (e) => { if (e.target.id === 'hz-dlg') e.target.close('no'); });

// ---------- start ----------
(async () => {
  try {
    const s = await api('/api/settings');
    app.power = s.power || null;
    document.documentElement.classList.toggle('calm-ui', Boolean(s.appearance?.reduceEffects));
    clockPref.h24 = Boolean(s.appearance?.clock24);
  } catch { /* pages show errors */ }
  await Promise.all([loadCars().catch(() => {}), loadNotes().catch(() => {})]);
  drawCarPick();
  drawNoteBadge();
  render();
  live();
  refreshJobs();
  pollConverter();
})();

// Footage thumbnails flip through their recording under the mouse (web/scrub.js)
import('/web/scrub.js').then((m) => m.hoverFrames(document.body, '.album-art, .tk-art, .pl-art')).catch(() => {});
// saved by converting, month by month, wherever a page puts a placeholder (web/savingsChart.js)
import('/web/savingsChart.js').then((m) => m.watchSavingsCharts(document.body)).catch(() => {});
// the hidden Nerd settings: tap Version seven times on the Settings page (web/nerd.js)
import('/web/nerd.js').then((m) => m.watchNerdUnlock(document.body)).catch(() => {});
