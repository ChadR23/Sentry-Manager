// Aurora shell: the sky, the floating dock, glass windows (one per page),
// live updates from /api/events, badges and keyboard shortcuts.

import { $, $$, esc, icon, api, state, loadVehicles, loadNotes, setVehicle, on, emit, toast, store, infoDialog, motionOK } from './core.js';
import { createSky } from './sky.js';
import sky from './pages/sky.js';
import footage from './pages/footage.js';
import viewer from './pages/viewer.js';
import encoder from './pages/encoder.js';
import nodes from './pages/nodes.js';
import policies from './pages/policies.js';
import jobs from './pages/jobs.js';
import bin from './pages/bin.js';
import alerts from './pages/alerts.js';
import support from './pages/support.js';
import settings from './pages/settings.js';

const PAGES = { sky, footage, viewer, encoder, nodes, policies, jobs, bin, alerts, support, settings };
// [route, label, icon, key (g + key), primary on phones]
const DOCK = [
  ['sky', 'Sky', 'sky', 's', true],
  ['footage', 'Footage', 'film', 'f', true],
  ['viewer', 'Viewer', 'cockpit', 'v', true],
  ['encoder', 'Encoder', 'orbit', 'e', true],
  '|',
  ['nodes', 'Nodes', 'nodes', 'n', false],
  ['policies', 'Policies', 'shield', 'p', false],
  ['jobs', 'Jobs', 'jobs', 'j', false],
  ['bin', 'Bin', 'trash', 'b', false],
  ['alerts', 'Alerts', 'bell', 'a', true],
  ['support', 'Support', 'chat', 'h', false],
  '|',
  ['settings', 'Settings', 'gear', ',', false]
];
const LONG = { bin: 'Recycle Bin', alerts: 'Notifications', sky: 'Sky (home)' };

// ---------- the sky ----------
export const skyFx = createSky({ canvas: $('#sky'), stars: $('#stars'), shoot: $('#shoot') });
window.auroraSky = skyFx;

// ---------- dock ----------
const dock = $('#dock');
const more = $('#more');
const narrowMq = matchMedia('(max-width: 699px)');
const badges = { alerts: '', jobs: '', bin: '', encoder: '' };

function dockItem([route, label, ico]) {
  return `<a class="dock-item" href="#/${route}" data-route="${route}" aria-label="${esc(LONG[route] || label)}">
    <span class="dock-ico">${icon(ico)}<span class="badge" data-badge="${route}" hidden></span></span>
    <span class="dock-label">${esc(label)}</span></a>`;
}
function renderDock() {
  const narrow = narrowMq.matches;
  const items = DOCK.filter((d) => d !== '|' && (!narrow || d[4]));
  let html = '';
  if (narrow) {
    html = items.map(dockItem).join('') + `<button class="dock-item" type="button" id="more-btn" aria-expanded="false" aria-controls="more" aria-label="More pages">
      <span class="dock-ico">${icon('grid')}<span class="badge" data-badge="more" hidden></span></span><span class="dock-label">More</span></button>`;
  } else {
    html = DOCK.map((d) => (d === '|' ? '<span class="dock-sep" aria-hidden="true"></span>' : dockItem(d))).join('');
  }
  dock.innerHTML = html;
  more.innerHTML = `<p class="more-title">More places</p><div class="more-grid">${DOCK.filter((d) => d !== '|' && !d[4]).map(([route, label, ico]) => `<a class="more-tile" href="#/${route}" data-route="${route}">
    <span class="more-ico">${icon(ico)}<span class="badge" data-badge="${route}" hidden></span></span><span>${esc(LONG[route] || label)}</span></a>`).join('')}</div>`;
  $('#more-btn')?.addEventListener('click', () => toggleMore());
  markDock();
  paintBadges();
}
function toggleMore(force) {
  const open = force ?? more.hidden;
  more.hidden = !open;
  $('#more-btn')?.setAttribute('aria-expanded', String(open));
  if (open) more.querySelector('a')?.focus({ preventScroll: true });
}
document.addEventListener('pointerdown', (e) => {
  if (!more.hidden && !more.contains(e.target) && !e.target.closest('#more-btn')) toggleMore(false);
});
narrowMq.addEventListener('change', () => { toggleMore(false); renderDock(); });

function markDock() {
  for (const a of $$('[data-route]', document)) {
    const on = a.dataset.route === state.route;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const btn = $('#more-btn');
  if (btn) btn.classList.toggle('on', DOCK.some((d) => d !== '|' && !d[4] && d[0] === state.route));
}
function setBadge(route, text) {
  badges[route] = text || '';
  paintBadges();
}
function paintBadges() {
  for (const el of $$('[data-badge]')) {
    const key = el.dataset.badge;
    const text = key === 'more' ? (['jobs', 'bin'].some((k) => badges[k]) ? '•' : '') : badges[key];
    el.hidden = !text;
    el.textContent = text || '';
    el.classList.toggle('dot', text === '•');
  }
}
on('notes', (list) => {
  // the open ones not read yet (Notifications > Mark read clears them)
  const n = list.filter((x) => !x.readAt).length;
  setBadge('alerts', n ? String(n > 99 ? '99+' : n) : '');
});
on('vehicles', (list) => {
  const n = list.reduce((s, v) => s + (v.binItems || 0), 0);
  setBadge('bin', n ? String(n) : '');
});
on('jobs-running', ({ running, converting }) => {
  setBadge('jobs', running ? String(running) : '');
  setBadge('encoder', converting ? '•' : '');
});
async function refreshJobsBadge() {
  try {
    const { jobs: list } = await api('/api/jobs?limit=50');
    const running = list.filter((j) => j.status === 'running');
    emit('jobs-running', { running: running.length, converting: running.some((j) => j.type === 'conversion') });
  } catch { /* the next update tries again */ }
}

// ---------- windows ----------
const stage = $('#stage');
let active = null; // { route, ctl, win }
let pending = new Set();
let seq = 0;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  const route = PAGES[parts[0]] ? parts[0] : 'sky';
  return { route, params: PAGES[parts[0]] ? parts.slice(1) : [], query: new URLSearchParams(qs) };
}

export function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}
window.auroraGo = go;

async function render() {
  const my = ++seq;
  const { route, params, query } = parseHash();
  const page = PAGES[route];
  toggleMore(false);
  // a question asked by the page being left is answered "cancel"
  const dlg = $('#dlg');
  if (dlg.open) dlg.close('cancel');
  // a window whose page was still loading when another was asked for goes too
  for (const w of stage.querySelectorAll(':scope > .win')) if (w !== active?.win) w.remove();
  if (active) {
    try { active.ctl?.destroy?.(); } catch (err) { console.warn(err); }
    const old = active.win;
    active = null;
    if (motionOK() && old.isConnected) {
      old.style.width = `${old.getBoundingClientRect().width}px`;
      old.classList.add('leaving');
      setTimeout(() => old.remove(), 160);
    } else old.remove();
  }
  pending = new Set();
  state.route = route;
  document.body.dataset.route = route;
  document.title = `${page.title} · Sentry Six Manager`;
  $('#where').textContent = page.title;
  markDock();
  skyFx.hold('video', false);

  const win = document.createElement('section');
  win.className = `win${page.chrome === false ? ' bare' : ' glass'}${page.wide ? ' wide' : ''} entering`;
  win.setAttribute('aria-labelledby', `title-${route}`);
  win.innerHTML = page.chrome === false
    ? `<h1 class="sr-only" id="title-${route}">${esc(page.title)}</h1><div class="win-body"></div>`
    : `<header class="win-head"><div class="win-titles"><p class="win-kicker">${icon(page.icon || 'sky')}<span>${esc(page.kicker || 'Sentry Six')}</span></p><h1 id="title-${route}">${esc(page.title)}</h1><p class="win-sub muted" data-sub></p></div><div class="win-actions" data-actions></div></header><div class="win-body"></div>`;
  stage.append(win);
  requestAnimationFrame(() => requestAnimationFrame(() => win.classList.remove('entering')));
  const ctx = {
    win,
    body: win.querySelector('.win-body'),
    actions: win.querySelector('[data-actions]'),
    params,
    query,
    alive: () => my === seq,
    sub(text) {
      const el = win.querySelector('[data-sub]');
      if (el) el.textContent = text || '';
    },
    go
  };
  let ctl = null;
  try {
    ctl = await page.mount(ctx);
  } catch (err) {
    if (my === seq) ctx.body.innerHTML = `<div class="empty"><h3>Something went wrong</h3><p class="muted">${esc(err.message)}</p><button class="btn" type="button" data-retry>Try again</button></div>`;
    ctx.body.querySelector('[data-retry]')?.addEventListener('click', () => render());
  }
  if (my !== seq) {
    try { ctl?.destroy?.(); } catch { /* gone */ }
    win.remove();
    return;
  }
  active = { route, ctl, win, page };
}

window.addEventListener('hashchange', () => {
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
});

// the title-bar vehicle pickers, wherever they are
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-vehicle-pick]')) {
    setVehicle(e.target.value);
  }
});
on('vehicle', () => {
  if (!active?.page?.vehicle) return;
  // a day or a recording of the other vehicle means nothing for this one
  if (parseHash().params.length) go(`#/${state.route}`);
  else render();
});

// ---------- live updates ----------
const live = $('#live');
function setLive(ok) {
  live.classList.toggle('on', ok);
  const t = ok ? 'Live updates on' : 'Live updates reconnecting';
  live.title = t;
  live.setAttribute('aria-label', t);
}
function busy() {
  const a = document.activeElement;
  return Boolean(document.querySelector('dialog[open]')) || Boolean(a && a.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]), select, textarea') && stage.contains(a));
}
function deliver(topics) {
  if (!active?.ctl?.refresh) return;
  const want = active.page.topics || [];
  const hit = topics.filter((t) => want.includes(t));
  if (!hit.length) return;
  if (busy()) {
    hit.forEach((t) => pending.add(t));
    return;
  }
  active.ctl.refresh(hit);
}
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (pending.size && !busy() && active?.ctl?.refresh) {
      const list = [...pending];
      pending.clear();
      active.ctl.refresh(list);
    }
  }, 50);
});
let retry = 1000;
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', () => { setLive(true); retry = 1000; });
  es.addEventListener('changed', async (e) => {
    let topics = [];
    try { ({ topics } = JSON.parse(e.data)); } catch { return; }
    if (topics.includes('interface')) {
      location.reload();
      return;
    }
    if (topics.some((t) => ['vehicles', 'inventory', 'bin'].includes(t))) await loadVehicles().catch(() => {});
    if (topics.includes('notifications')) await loadNotes().catch(() => {});
    if (topics.includes('jobs')) refreshJobsBadge();
    deliver(topics);
  });
  es.addEventListener('error', () => {
    setLive(false);
    if (es.readyState === EventSource.CLOSED) {
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30000);
      // still signed in?
      fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json()).then((me) => {
        if (!me.user) location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
      }).catch(() => {});
    }
  });
}

// ---------- top bar ----------
function tick() {
  const el = $('#clock');
  const d = new Date();
  el.textContent = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  el.dateTime = d.toISOString();
}
tick();
setInterval(tick, 30000);
$('#signout').addEventListener('click', async () => {
  await api('/api/auth/logout', { body: {} }).catch(() => {});
  location.href = '/login';
});

// ---------- keyboard ----------
let chord = 0;
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, select, textarea, [contenteditable]') || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape' && !more.hidden) {
    toggleMore(false);
    return;
  }
  if (chord && Date.now() - chord < 1200) {
    chord = 0;
    const hit = DOCK.find((d) => d !== '|' && d[3] === e.key.toLowerCase());
    if (hit) {
      e.preventDefault();
      go(`#/${hit[0]}`);
    }
    return;
  }
  if (e.key === 'g' && state.route !== 'viewer') {
    chord = Date.now();
    return;
  }
  if (e.key === '?') {
    e.preventDefault();
    infoDialog('Keyboard shortcuts', `<table class="keys"><tbody>
      ${DOCK.filter((d) => d !== '|').map(([route, label, , key]) => `<tr><td><kbd>g</kbd> <kbd>${esc(key)}</kbd></td><td>${esc(LONG[route] || label)}</td></tr>`).join('')}
      <tr><td><kbd>?</kbd></td><td>This list</td></tr>
      <tr><td colspan="2" class="muted small">Viewer: <kbd>Space</kbd> play/pause · <kbd>←</kbd> <kbd>→</kbd> 5 s · <kbd>,</kbd> <kbd>.</kbd> one frame · <kbd>[</kbd> <kbd>]</kbd> previous/next clip · <kbd>-</kbd> <kbd>+</kbd> speed · <kbd>1</kbd>–<kbd>6</kbd> focus a camera, <kbd>0</kbd> all · <kbd>t</kbd> telemetry · <kbd>m</kbd> mirror the rear view · <kbd>f</kbd> full screen</td></tr>
      <tr><td colspan="2" class="muted small">Footage: <kbd>←</kbd> <kbd>→</kbd> move along the filmstrip of days.</td></tr>
    </tbody></table>`);
  }
});

// thumbnails that fail show the sky instead (no inline handlers: CSP)
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.classList.contains('thumb-img')) img.classList.add('broken');
}, true);

// ---------- start ----------
renderDock();
(async () => {
  try {
    const s = await api('/api/settings');
    state.power = s.power || null;
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'bad');
  }
  await Promise.all([loadVehicles().catch(() => {}), loadNotes().catch(() => {})]);
  refreshJobsBadge();
  render();
  connect();
})();

// remembered between visits: nothing else to restore
store.set('lastVisit', Date.now());
