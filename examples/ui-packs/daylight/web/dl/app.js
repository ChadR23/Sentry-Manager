// Daylight: the shell. Navigation (side bar on wide screens, tab bar on
// phones), the router, the look switch and live updates from the server.

import { $, $$, api, esc, icon, store, toast, reducedMotion } from './core.js';
import { state, emit, on, loadVehicles, loadNotes, loadJobs, unreadCount, binCount } from './state.js';

const ROUTES = {
  home: { label: 'Today', icon: 'home', group: 'main', load: () => import('./pages/home.js') },
  footage: { label: 'Footage', icon: 'film', group: 'main', load: () => import('./pages/footage.js') },
  viewer: { label: 'Viewer', icon: 'playOutline', group: 'main', load: () => import('./pages/viewer.js') },
  encoder: { label: 'Encoder', icon: 'encoder', group: 'main', load: () => import('./pages/encoder.js') },
  more: { label: 'More', icon: 'more', group: 'phone', load: () => import('./pages/more.js') },
  bin: { label: 'Recycle Bin', icon: 'trash', group: 'care', desc: 'Restore or delete for good', load: () => import('./pages/bin.js') },
  policies: { label: 'Cleanup rules', icon: 'rules', group: 'care', desc: 'Keep footage for as long as you like', load: () => import('./pages/policies.js') },
  jobs: { label: 'Activity', icon: 'activity', group: 'care', desc: 'What the server has been doing', load: () => import('./pages/jobs.js') },
  notifications: { label: 'Alerts', icon: 'bell', group: 'care', desc: 'Things that may need you', load: () => import('./pages/notifications.js') },
  nodes: { label: 'Helper servers', icon: 'nodes', group: 'setup', desc: 'Other computers that convert for you (Nodes)', load: () => import('./pages/nodes.js') },
  server: { label: 'Server & logs', icon: 'server', group: 'setup', desc: 'CPU, memory, disks, temperatures, logs', load: () => import('./pages/server.js') },
  support: { label: 'Help & support', icon: 'chat', group: 'setup', desc: 'Chat with the Sentry Six team', load: () => import('./pages/support.js') },
  settings: { label: 'Settings', icon: 'gear', group: 'setup', desc: 'Vehicles, account, look, security', load: () => import('./pages/settings.js') }
};
export const MORE_ROUTES = ['bin', 'policies', 'jobs', 'notifications', 'nodes', 'server', 'support', 'settings'];
export const routeInfo = (r) => ROUTES[r];

// ---------- the look ----------
const THEMES = ['auto', 'light', 'dark'];
const THEME_WORD = { auto: 'Look: follows your device', light: 'Look: light', dark: 'Look: dark' };
function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const glyph = icon(t === 'auto' ? 'auto' : t === 'light' ? 'sun' : 'moon');
  $('#theme-top').innerHTML = glyph;
  $('#theme-top').setAttribute('aria-label', `${THEME_WORD[t]}. Change`);
  $('#theme-side').innerHTML = `${glyph}<span>${THEME_WORD[t]}</span>`;
  $('#theme-side').setAttribute('aria-label', `${THEME_WORD[t]}. Change`);
}
export function setTheme(t) {
  store.set('theme', t);
  applyTheme(t);
  emit('theme', t);
}
export const currentTheme = () => store.get('theme', 'auto');
const cycleTheme = () => setTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]);

// ---------- navigation ----------
function navLink(key, cls) {
  const r = ROUTES[key];
  return `<a href="#/${key}" class="${cls}" data-route="${key}">${icon(r.icon)}<span>${esc(r.label)}</span><b class="badge" data-badge="${key}" hidden></b></a>`;
}
function drawNav() {
  const group = (g, title) => `${title ? `<p class="side-group">${title}</p>` : ''}${Object.keys(ROUTES).filter((k) => ROUTES[k].group === g).map((k) => navLink(k, 'side-link')).join('')}`;
  $('#side-nav').innerHTML = group('main', '') + group('care', 'Looking after') + group('setup', 'Set up &amp; help');
  $('#tabbar').innerHTML = ['home', 'footage', 'viewer', 'encoder', 'more'].map((k) => navLink(k, 'tab')).join('');
  $('#brand-mark').innerHTML = icon('shieldCheck');
  $('#brand-mark-top').innerHTML = icon('shieldCheck');
  $('#bell-top').innerHTML = `${icon('bell')}<b class="badge dot" data-badge="notifications" hidden></b>`;
  $('#signout-side').innerHTML = `${icon('logout')}<span>Sign out</span>`;
}

export function updateBadges() {
  const unread = unreadCount();
  const bin = binCount();
  const running = state.runningJobs.length;
  const converting = state.runningJobs.some((j) => j.type === 'conversion');
  const set = (key, text, tone = '') => {
    $$(`[data-badge="${key}"]`).forEach((b) => {
      b.hidden = !text;
      b.textContent = b.classList.contains('dot') ? (text ? String(text) : '') : text;
      b.className = `badge${b.classList.contains('dot') ? ' dot' : ''}${tone ? ` badge-${tone}` : ''}`;
    });
  };
  set('notifications', unread ? String(unread) : '', 'bad');
  set('bin', bin ? String(bin) : '');
  set('jobs', running ? String(running) : '', 'busy');
  set('encoder', converting ? '•' : '', 'busy');
  set('more', unread ? String(unread) : '', 'bad');
  $('#bell-top').setAttribute('aria-label', unread ? `Alerts, ${unread} new` : 'Alerts');
  document.title = `${unread ? `(${unread}) ` : ''}${ROUTES[current.route]?.label || 'Today'} · Sentry Six`;
}

// ---------- router ----------
const view = $('#view');
const current = { route: 'home', cleanup: [], seq: 0 };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  const route = ROUTES[parts[0]] ? parts[0] : 'home';
  return { route, params: parts.slice(1), query: new URLSearchParams(queryPart) };
}

export function go(hash, { replace = false } = {}) {
  if (replace) {
    history.replaceState(null, '', hash);
    render();
  } else if (location.hash === hash) render();
  else location.hash = hash;
}

function runCleanup() {
  for (const fn of current.cleanup.splice(0)) {
    try { fn(); } catch (err) { console.warn(err); }
  }
}

async function render() {
  const seq = ++current.seq;
  const { route, params, query } = parseHash();
  const changed = route !== current.route;
  runCleanup();
  current.route = route;
  // navigation highlight (More stands for every page behind it on phones)
  $$('[data-route]').forEach((a) => {
    const active = a.dataset.route === route || (a.dataset.route === 'more' && MORE_ROUTES.includes(route));
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#topbar-title').textContent = ROUTES[route].label;
  document.body.dataset.route = route;
  updateBadges();
  const ctx = {
    view, route, params, query, seq,
    alive: () => seq === current.seq,
    on: (topic, fn) => current.cleanup.push(on(topic, fn)),
    every: (ms, fn) => {
      let t = null;
      const loop = async () => {
        if (seq !== current.seq) return;
        if (document.visibilityState === 'visible') {
          try { await fn(); } catch (err) { console.warn(err); }
        }
        if (seq === current.seq) t = setTimeout(loop, ms);
      };
      t = setTimeout(loop, ms);
      current.cleanup.push(() => clearTimeout(t));
    },
    cleanup: (fn) => current.cleanup.push(fn),
    rerender: () => { if (seq === current.seq) render(); }
  };
  let mod;
  try {
    mod = await ROUTES[route].load();
  } catch (err) {
    view.innerHTML = `<div class="page"><div class="note note-bad">${icon('alert')}<span>This page couldn’t load: ${esc(err.message)}</span></div></div>`;
    return;
  }
  if (seq !== current.seq) return;
  view.classList.remove('enter');
  try {
    await mod.render(ctx);
  } catch (err) {
    if (err?.status === 401) return;
    if (seq === current.seq) view.innerHTML = `<div class="page"><div class="note note-bad">${icon('alert')}<span>${esc(err.message || String(err))}</span></div><p style="margin-top:16px"><button class="btn" type="button" id="retry">Try again</button></p></div>`;
    $('#retry')?.addEventListener('click', () => render());
  }
  if (seq !== current.seq) return;
  if (changed) {
    if (!reducedMotion()) {
      void view.offsetWidth;
      view.classList.add('enter');
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    // keyboard and screen-reader users land on the new page
    if (document.activeElement && document.activeElement.closest('#side-nav, #tabbar')) view.focus({ preventScroll: true });
  }
}
window.addEventListener('hashchange', render);

// ---------- live updates ----------
function connect() {
  let retry = 1000;
  const open = () => {
    const es = new EventSource('/api/events');
    es.addEventListener('open', () => { retry = 1000; });
    es.addEventListener('changed', async (e) => {
      let topics = [];
      try { topics = JSON.parse(e.data).topics || []; } catch { return; }
      if (topics.includes('interface')) {
        location.reload();
        return;
      }
      const jobs = [];
      if (topics.some((t) => ['vehicles', 'inventory', 'bin'].includes(t))) jobs.push(loadVehicles().catch(() => {}));
      if (topics.includes('notifications')) jobs.push(loadNotes().catch(() => {}));
      if (topics.includes('jobs')) jobs.push(loadJobs().catch(() => {}));
      await Promise.all(jobs);
      updateBadges();
      emit('topics', topics);
    });
    es.addEventListener('error', () => {
      if (es.readyState !== EventSource.CLOSED) return;
      // closed for good (signed out, or the server restarted): check and reopen
      api('/api/auth/me').then((me) => {
        if (!me.user) location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
        else setTimeout(open, retry);
      }, () => setTimeout(open, retry));
      retry = Math.min(retry * 2, 30000);
    });
  };
  open();
}

// ---------- start ----------
drawNav();
applyTheme(currentTheme());
$('#theme-top').addEventListener('click', cycleTheme);
$('#theme-side').addEventListener('click', cycleTheme);
$('#signout-side').addEventListener('click', signOut);
on('notes', updateBadges);
on('vehicles', updateBadges);
on('jobs-running', updateBadges);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => emit('theme', currentTheme()));

export async function signOut() {
  await api('/api/auth/logout', { body: {} }).catch(() => {});
  location.href = '/login';
}

// on touch screens, a field being typed in stays above the on-screen keyboard
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement) || !el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select')) return;
  if (!window.matchMedia('(pointer: coarse)').matches) return;
  setTimeout(() => {
    const vv = window.visualViewport;
    const r = el.getBoundingClientRect();
    if (!vv || r.bottom > vv.height - 12 || r.top < 60) el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, 350);
});

// thumbnails that fail show a soft placeholder (no inline handlers: CSP)
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.classList.contains('thumb-img')) img.replaceWith(Object.assign(document.createElement('span'), { className: 'thumb-fallback', innerHTML: icon('film') }));
}, true);

(async () => {
  view.innerHTML = '<div class="page"><div class="loading"><span class="spin"></span><span>Getting things ready…</span></div></div>';
  try {
    const [settings] = await Promise.all([api('/api/settings').catch(() => null), loadVehicles(), loadNotes(), loadJobs()]);
    if (settings?.appearance?.reduceEffects) document.documentElement.classList.add('calm');
    state.power = settings?.power || null;
  } catch (err) {
    if (err?.status !== 401) toast(err.message, { kind: 'bad' });
  }
  state.loaded = true;
  render();
  connect();
})();
