// Flux shell: router, sidebar, command palette, keyboard shortcuts, live updates.
import { $, $$, esc, icon, api, state, store, bus, current, setVehicle, loadVehicles, loadNotes, toast, infoDialog, invoke } from './core.js';
import overview from './pages/overview.js';
import footage from './pages/footage.js';
import viewer from './pages/viewer.js';
import encoder from './pages/encoder.js';
import nodes from './pages/nodes.js';
import policies from './pages/policies.js';
import jobs from './pages/jobs.js';
import bin from './pages/bin.js';
import notifications from './pages/notifications.js';
import support from './pages/support.js';
import settings from './pages/settings.js';

const PAGES = [
  { id: 'overview', label: 'Overview', icon: 'overview', key: 'o', mod: overview, group: 'Monitor' },
  { id: 'footage', label: 'Footage', icon: 'footage', key: 'f', mod: footage, group: 'Monitor' },
  { id: 'viewer', label: 'Viewer', icon: 'viewer', key: 'v', mod: viewer, group: 'Monitor' },
  { id: 'encoder', label: 'Encoder', icon: 'encoder', key: 'e', mod: encoder, group: 'Process' },
  { id: 'nodes', label: 'Nodes', icon: 'nodes', key: 'n', mod: nodes, group: 'Process' },
  { id: 'policies', label: 'Policies', icon: 'policies', key: 'p', mod: policies, group: 'Process' },
  { id: 'jobs', label: 'Jobs', icon: 'jobs', key: 'j', mod: jobs, group: 'Process' },
  { id: 'bin', label: 'Recycle Bin', icon: 'bin', key: 'b', mod: bin, group: 'Process' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', key: 'a', mod: notifications, group: 'System' },
  { id: 'support', label: 'Support', icon: 'support', key: 'h', mod: support, group: 'System' },
  { id: 'settings', label: 'Settings', icon: 'settings', key: 's', mod: settings, group: 'System' }
];
const byId = Object.fromEntries(PAGES.map((p) => [p.id, p]));

// ---------- sidebar ----------
const app = $('#app');
function drawNav() {
  let group = '';
  $('#nav').innerHTML = PAGES.map((p) => {
    const head = p.group !== group ? `<div class="nav-group">${esc((group = p.group))}</div>` : '';
    return `${head}<a href="#/${p.id}" data-route="${p.id}" title="${esc(p.label)} (g ${p.key})"><svg class="ico"><use href="#i-${p.icon}"/></svg><span class="nav-label">${esc(p.label)}</span><span class="nav-badge" data-badge="${p.id}" hidden></span><kbd class="nav-kbd" aria-hidden="true">g ${p.key}</kbd></a>`;
  }).join('');
}
drawNav();
if (store.get('collapsed', false)) app.classList.add('collapsed');
document.documentElement.classList.toggle('dense', Boolean(store.get('dense', false)));
function toggleSidebar() {
  if (matchMedia('(max-width: 860px)').matches) return openMenu(!app.classList.contains('menu-open'));
  app.classList.toggle('collapsed');
  store.set('collapsed', app.classList.contains('collapsed'));
  $('#side-toggle').setAttribute('aria-label', app.classList.contains('collapsed') ? 'Expand sidebar' : 'Collapse sidebar');
  setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
  return undefined;
}
function openMenu(on) {
  app.classList.toggle('menu-open', on);
  $('#scrim').hidden = !on;
  $('#menu-btn').setAttribute('aria-expanded', String(on));
  if (on) $('#nav a.active, #nav a')?.focus({ preventScroll: true });
}
$('#side-toggle').onclick = toggleSidebar;
$('#menu-btn').onclick = () => openMenu(true);
$('#side-close').onclick = () => openMenu(false);
$('#scrim').onclick = () => openMenu(false);
$('#nav').addEventListener('click', (e) => { if (e.target.closest('a')) openMenu(false); });
// swipe the menu closed on touch
let touchX = null;
$('#side').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
$('#side').addEventListener('touchend', (e) => {
  if (touchX !== null && e.changedTouches[0].clientX - touchX < -60) openMenu(false);
  touchX = null;
}, { passive: true });

export function setBadge(id, text, tone = '') {
  const b = document.querySelector(`[data-badge="${id}"]`);
  if (b) {
    b.hidden = !text;
    b.textContent = text || '';
    b.className = `nav-badge ${tone}`;
  }
  if (id === 'notifications') {
    $('#bell-badge').hidden = !text;
    $('#bell-badge').textContent = text || '';
  }
}

function drawVehiclePicker() {
  const sel = $('#veh-pick');
  const v = current();
  sel.innerHTML = state.vehicles.length
    ? state.vehicles.map((x) => `<option value="${esc(x.id)}"${x.id === v?.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')
    : '<option value="">No vehicles</option>';
  const single = state.vehicles.length < 2;
  sel.hidden = single;
  $('#veh-name').hidden = !single;
  $('#veh-name').textContent = v ? v.name : 'no vehicle';
  $('#veh-pick-wrap').classList.toggle('single', single);
  const binItems = state.vehicles.reduce((n, x) => n + (x.binItems || 0), 0);
  setBadge('bin', binItems ? String(binItems) : '');
}
$('#veh-pick').onchange = (e) => setVehicle(e.target.value);
bus.on('vehicles', drawVehiclePicker);
bus.on('vehicle', drawVehiclePicker);

function drawNoteBadge() {
  const unread = state.notes.filter((n) => !n.resolvedAt && !n.readAt).length;
  const open = state.notes.filter((n) => !n.resolvedAt);
  const crit = open.some((n) => n.level === 'critical');
  setBadge('notifications', unread ? String(unread) : '', crit ? 'bad' : 'warn');
}
bus.on('notes', drawNoteBadge);

async function refreshJobBadges() {
  try {
    const { jobs: list } = await api('/api/jobs?limit=50');
    const running = list.filter((j) => j.status === 'running');
    setBadge('jobs', running.length ? String(running.length) : '', 'busy');
  } catch { /* shown on the page */ }
  const cur = await invoke('getCurrent');
  const st = cur.ok ? cur.value?.state : null;
  const active = ['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing'].includes(st);
  setBadge('encoder', active ? '●' : st === 'paused' || st === 'paused_network' ? 'II' : '', active ? 'busy' : 'warn');
}
bus.on('converter-state', (st) => {
  const active = ['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing'].includes(st);
  setBadge('encoder', active ? '●' : st === 'paused' || st === 'paused_network' ? 'II' : '', active ? 'busy' : 'warn');
});

// ---------- router ----------
let mounted = null;
let mountedId = null;
const page = $('#page');

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const [route, ...rest] = path.split('/');
  return { route: byId[route] ? route : 'overview', sub: rest.join('/'), params: new URLSearchParams(query) };
}

export function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const { route, sub, params } = parseHash();
  const p = byId[route];
  if (app.classList.contains('menu-open')) openMenu(false);
  try { mounted?.unmount?.(); } catch (err) { console.warn(err); }
  mounted = null;
  document.querySelectorAll('.drawer').forEach((d) => d.remove());
  mountedId = route;
  $$('#nav a').forEach((a) => {
    const on = a.dataset.route === route;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('#crumb-page').textContent = p.label.toLowerCase();
  document.title = `${p.label} · Flux · Sentry Six Manager`;
  document.body.dataset.route = route;
  page.className = `page page-${route}`;
  page.innerHTML = '<div class="loading"><i></i><i></i><i></i></div>';
  try {
    const m = await p.mod.mount(page, { sub, params, go, seq: () => seq === renderSeq });
    if (seq !== renderSeq) { m?.unmount?.(); return; }
    mounted = m || {};
  } catch (err) {
    if (seq === renderSeq) page.innerHTML = `<div class="empty"><div class="empty-glyph">!</div><p>${esc(err.message)}</p><button class="btn" type="button" id="retry">Retry</button></div>`;
    $('#retry')?.addEventListener('click', render);
  }
  if (seq === renderSeq) page.animate?.([{ opacity: 0.4, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 180, easing: 'ease-out' });
}
window.addEventListener('hashchange', render);
// phones show the rows of .stack tables as blocks; each cell carries its column name
let labelTimer = 0;
new MutationObserver(() => {
  cancelAnimationFrame(labelTimer);
  labelTimer = requestAnimationFrame(() => {
    for (const t of page.querySelectorAll('table.stack')) {
      const names = [...t.querySelectorAll(':scope > thead th')].map((th) => th.textContent.trim());
      for (const tr of t.querySelectorAll(':scope > tbody > tr')) [...tr.children].forEach((td, i) => { if (names[i] && !td.dataset.label && td.colSpan === 1) td.dataset.label = names[i]; });
    }
  });
}).observe(page, { childList: true, subtree: true });
bus.on('vehicle', () => {
  // pages showing one vehicle redraw for the new one
  if (mounted?.onVehicle) mounted.onVehicle();
  else if (['footage', 'policies', 'jobs', 'bin', 'overview'].includes(mountedId)) render();
});

// ---------- live updates ----------
let es = null;
let esRetry = 1000;
function connect() {
  es = new EventSource('/api/events');
  const live = $('#live');
  es.addEventListener('open', () => { live.className = 'livedot on'; live.title = 'Live updates: connected'; esRetry = 1000; });
  es.addEventListener('error', () => {
    live.className = 'livedot off';
    live.title = 'Live updates: reconnecting…';
    if (es.readyState === EventSource.CLOSED) {
      setTimeout(connect, esRetry);
      esRetry = Math.min(esRetry * 2, 30000);
    }
  });
  es.addEventListener('changed', async (e) => {
    let topics = [];
    try { ({ topics } = JSON.parse(e.data)); } catch { return; }
    if (topics.includes('interface')) { location.reload(); return; }
    live.classList.add('pulse');
    setTimeout(() => live.classList.remove('pulse'), 600);
    if (topics.some((t) => ['vehicles', 'inventory', 'bin'].includes(t))) await loadVehicles().catch(() => {});
    if (topics.includes('notifications')) await loadNotes().catch(() => {});
    if (topics.includes('jobs')) refreshJobBadges();
    bus.emit('topics', topics);
    try { mounted?.onTopics?.(topics); } catch (err) { console.warn(err); }
  });
}

// ---------- command palette ----------
const pal = $('#palette');
const palInput = $('#pal-input');
const palList = $('#pal-list');
let palItems = [];
let palIndex = 0;

function baseCommands() {
  const cmds = PAGES.map((p) => ({ group: 'Go to', label: p.label, hint: `g ${p.key}`, icon: p.icon, run: () => go(`#/${p.id}`) }));
  for (const v of state.vehicles) cmds.push({ group: 'Vehicle', label: `Switch to ${v.name}`, icon: 'car', run: () => setVehicle(v.id) });
  const v = current();
  cmds.push(
    { group: 'Action', label: 'Refresh inventory', icon: 'refresh', run: () => v && api(`/api/vehicles/${encodeURIComponent(v.id)}/scan`, { body: {} }).then(() => toast('Refreshing the inventory…'), (err) => toast(err.message, 'bad')) },
    { group: 'Action', label: 'New conversion…', icon: 'encoder', run: () => go('#/encoder?new=1') },
    { group: 'Action', label: 'Pause conversion', icon: 'pause', run: () => bus.emit('cmd', 'converter:pause') },
    { group: 'Action', label: 'Resume conversion', icon: 'play', run: () => bus.emit('cmd', 'converter:resume') },
    { group: 'Action', label: 'Export server stats (CSV, 24 h)', icon: 'download', run: () => { location.href = '/api/stats/export.csv?range=24h'; } },
    { group: 'Action', label: 'Download logs', icon: 'download', run: () => { location.href = '/api/logs/download'; } },
    { group: 'Action', label: 'Mark all notifications read', icon: 'check', run: async () => { const ids = state.notes.filter((n) => !n.readAt).map((n) => n.id); await api('/api/notifications/read', { body: { ids } }).catch(() => {}); loadNotes(); } },
    { group: 'Action', label: 'Clear finished jobs…', icon: 'jobs', run: () => go('#/jobs?clear=1') },
    { group: 'Action', label: 'Add a vehicle', icon: 'plus', run: () => go('#/settings/vehicles?add=1') },
    { group: 'Action', label: 'Settings: Interface (switch pack / Original)', icon: 'settings', run: () => go('#/settings/interface') },
    { group: 'Action', label: 'Settings: Security (CA certificate)', icon: 'lock', run: () => go('#/settings/security') },
    { group: 'Action', label: 'Settings: Electricity price', icon: 'bolt', run: () => go('#/settings/power') },
    { group: 'Action', label: 'Toggle sidebar', hint: '[', icon: 'sidebar', run: toggleSidebar },
    { group: 'Action', label: 'Keyboard shortcuts', hint: '?', icon: 'keyboard', run: showShortcuts },
    { group: 'Action', label: 'Sign out', icon: 'logout', run: signOut }
  );
  return cmds;
}

function score(label, q) {
  if (!q) return 1;
  const l = label.toLowerCase();
  if (l.startsWith(q)) return 100 - l.length / 100;
  const at = l.indexOf(q);
  if (at >= 0) return 60 - at / 10;
  // in-order letters
  let i = 0;
  for (const ch of l) if (ch === q[i]) i++;
  return i === q.length ? 20 - l.length / 100 : 0;
}

function drawPalette() {
  const q = palInput.value.trim().toLowerCase();
  const extra = mounted?.commands?.() || [];
  palItems = [...extra, ...baseCommands()].map((c) => ({ ...c, s: score(`${c.group} ${c.label}`, q) || score(c.label, q) })).filter((c) => c.s > 0);
  if (q) palItems.sort((a, b) => b.s - a.s);
  palIndex = Math.min(palIndex, Math.max(0, palItems.length - 1));
  let last = '';
  palList.innerHTML = palItems.length ? palItems.map((c, i) => {
    const head = !q && c.group !== last ? `<li class="pal-group" role="presentation">${esc((last = c.group))}</li>` : '';
    return `${head}<li role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === palIndex}" class="${i === palIndex ? 'on' : ''}">${icon(c.icon || 'bolt')}<span>${esc(c.label)}</span>${c.hint ? `<kbd>${esc(c.hint)}</kbd>` : ''}</li>`;
  }).join('') : '<li class="pal-none">No match</li>';
  palInput.setAttribute('aria-activedescendant', palItems.length ? `pal-${palIndex}` : '');
  palList.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
}
function openPalette() {
  if (pal.open) return;
  palInput.value = '';
  palIndex = 0;
  drawPalette();
  pal.showModal();
  palInput.focus();
}
function runPalette(i) {
  const c = palItems[i];
  if (!c) return;
  pal.close();
  Promise.resolve().then(() => c.run());
}
palInput.addEventListener('input', () => { palIndex = 0; drawPalette(); });
palInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { palIndex = Math.min(palItems.length - 1, palIndex + 1); drawPalette(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { palIndex = Math.max(0, palIndex - 1); drawPalette(); e.preventDefault(); }
  else if (e.key === 'Enter') { runPalette(palIndex); e.preventDefault(); }
});
palList.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) runPalette(Number(li.dataset.i));
});
pal.addEventListener('click', (e) => { if (e.target === pal) pal.close(); });
$('#cmdk-btn').onclick = openPalette;
$('#cmdk-btn').querySelector('.cmdk-kbd').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';

// ---------- shortcuts ----------
const GLOBAL_KEYS = [
  ['Ctrl/⌘ K', 'Command palette'], ['?', 'This sheet'], ['[', 'Collapse / expand the sidebar'], ['/', 'Focus the page filter'],
  ...PAGES.map((p) => [`g ${p.key}`, `Go to ${p.label}`])
];
const PAGE_KEYS = {
  Footage: [['j / k', 'Move the cursor down / up'], ['Shift + j / k', 'Extend the selection'], ['x or Space', 'Select the row'], ['Ctrl/⌘ A', 'Select every row shown'], ['Enter or o', 'Play the row'], ['i', 'Raw JSON inspector'], ['p', 'Protect / unprotect'], ['Delete', 'Move the selection to the Recycle Bin'], ['Esc', 'Clear the selection']],
  Viewer: [['Space or k', 'Play / pause'], [', and .', 'One frame back / forward'], ['← / →', 'Seek 5 s (Shift: 1 s)'], ['[ / ]', 'Slower / faster'], ['n / p', 'Next / previous clip'], ['1 … 6', 'Focus a camera'], ['0', 'All cameras'], ['l', 'Next camera layout'], ['t', 'Telemetry panel'], ['f', 'Fullscreen']],
  Encoder: [['+ / −', 'More / fewer conversions at once (running job)'], ['Space', 'Pause / resume the running job'], ['/', 'Filter clips']],
  Overview: [['r', 'Switch the range (live / 24 h)'], ['/', 'Filter the log tail']]
};
function showShortcuts() {
  const row = ([k, d]) => `<div class="kb-row"><span>${k.split(' ').map((x) => (['/', 'or', 'and', '+', '…', '·'].includes(x) ? `<span class="faint">${esc(x)}</span>` : `<kbd>${esc(x)}</kbd>`)).join(' ')}</span><span>${esc(d)}</span></div>`;
  infoDialog('Keyboard shortcuts', `<div class="kb-grid"><section><h3>Everywhere</h3>${GLOBAL_KEYS.map(row).join('')}</section>
    ${Object.entries(PAGE_KEYS).map(([name, list]) => `<section><h3>${esc(name)}</h3>${list.map(row).join('')}</section>`).join('')}</div>`);
}
$('#help-btn').onclick = showShortcuts;

let gPending = 0;
const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) && !(el.tagName === 'INPUT' && ['checkbox', 'radio', 'button', 'range'].includes(el.type));
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (pal.open) pal.close(); else openPalette();
    return;
  }
  if (document.querySelector('dialog[open]')) return;
  if (typing(e.target)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.altKey || e.ctrlKey || e.metaKey) {
    if (mounted?.onKey?.(e)) e.preventDefault();
    return;
  }
  if (Date.now() - gPending < 1200) {
    gPending = 0;
    const p = PAGES.find((x) => x.key === e.key.toLowerCase());
    if (p) { e.preventDefault(); go(`#/${p.id}`); }
    return;
  }
  if (mounted?.onKey?.(e)) { e.preventDefault(); return; }
  if (e.key === 'g') { gPending = Date.now(); return; }
  if (e.key === '?') { e.preventDefault(); showShortcuts(); return; }
  if (e.key === '[') { e.preventDefault(); toggleSidebar(); return; }
  if (e.key === '/') {
    const f = page.querySelector('[data-filter]');
    if (f) { e.preventDefault(); f.focus(); f.select?.(); }
  }
  if (e.key === 'Escape' && app.classList.contains('menu-open')) openMenu(false);
});

async function signOut() {
  await api('/api/auth/logout', { body: {} }).catch(() => {});
  location.href = '/login';
}

// ---------- start ----------
(async () => {
  try {
    const s = await api('/api/settings');
    state.power = s.power || null;
    document.documentElement.classList.toggle('calm', Boolean(s.appearance?.reduceEffects));
  } catch { /* shown by the pages */ }
  await Promise.all([loadVehicles().catch(() => {}), loadNotes().catch(() => {})]);
  drawVehiclePicker();
  drawNoteBadge();
  render();
  connect();
  refreshJobBadges();
})();
