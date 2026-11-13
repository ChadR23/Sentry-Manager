import { clearFootageSelections } from './pages/footage.js';
import { api, esc, sheet, act, toast, scope, offline, OFFLINE_TEXT } from './core.js';
import { icon } from './icons.js';
import { showStudio, hideStudio } from './studio.js';
import { notifications } from './pages/notifications.js';
import { bellTone } from './status.js';
export const state = {
  vehicles: [],
  vehicleId: localStorage.getItem('s6:vehicle'),
  notes: [],
  h24: false,
  glass: Number(localStorage.getItem('s6:glass') ?? 50),
};
export const current = () => state.vehicles.find((v) => v.id === state.vehicleId) || null;
const nav = [
  ['overview', 'Overview', 'dashboard'],
  ['footage', 'Footage', 'folder_open'],
  ['viewer', 'Viewer', 'videocam'],
  ['encoder', 'Encoder', 'conversion_path'],
  ['sentryusb', 'Sentry USB', 'usb'],
  ['activity', 'Activity', 'task'],
  ['bin', 'Recycle Bin', 'delete'],
  ['health', 'Health', 'cardiology'],
  ['settings', 'Settings', 'settings'],
];
const link = ([route, label, glyph]) =>
  `<a href="#/${route}" data-route="${route}">${icon(glyph)}<span>${label}</span></a>`;
document.getElementById('brand-icon').innerHTML = icon('shield');
document.getElementById('nav').innerHTML = nav
  .map((n, i) => (i === 4 ? '<small>Manage</small>' : '') + link(n))
  .join('');
document.getElementById('phone-nav').innerHTML =
  [nav[0], nav[1], nav[2], nav[5]].map(link).join('') +
  `<button id="more">${icon('menu')}<span>More</span></button>`;
document.getElementById('more').onclick = (e) => {
  const el = document.createElement('nav');
  el.className = 'more-list';
  el.innerHTML = [
    ['drives', 'Trips & map', 'conversion_path'],
    nav[3],
    nav[4],
    nav[6],
    nav[7],
    nav[8],
  ]
    .map(link)
    .join('');
  const close = sheet(el, { anchor: e.currentTarget });
  el.onclick = (ev) => {
    if (ev.target.closest('a')) close();
  };
};
document.getElementById('bell').onclick = act((e) => notifications(e.currentTarget, current));
export function applyGlass() {
  document.documentElement.classList.toggle('no-glass', state.glass === 0);
  document.documentElement.style.setProperty('--lg-glass', String(state.glass / 50));
  document.documentElement.style.setProperty('--lg-glow', String(state.glass / 50));
}
applyGlass();
const page = document.getElementById('page');
// a slider's track is filled up to its value (--fill), wherever one appears
const fillRange = (el) => {
  const min = Number(el.min || 0),
    max = Number(el.max || 100);
  el.style.setProperty('--fill', (100 * (Number(el.value) - min)) / (max - min || 1) + '%');
};
document.addEventListener?.('input', (e) => e.target.matches?.('input[type="range"]') && fillRange(e.target));
if (typeof MutationObserver !== 'undefined' && document.body) new MutationObserver(() => document.querySelectorAll('input[type="range"]:not([data-filled])').forEach((el) => {
  el.dataset.filled = '';
  fillRange(el);
})).observe(document.body, { childList: true, subtree: true });
let cleanup = () => {},
  shown = false, // the page on screen is a finished render
  seq = 0,
  renderScope;
// The picker, Studio messages and deep links all switch the same shell state.
export function selectVehicle(id) {
  if (id === state.vehicleId || !state.vehicles.some((v) => v.id === id)) return false;
  renderScope?.abort();
  clearFootageSelections();
  state.vehicleId = id;
  localStorage.setItem('s6:vehicle', id);
  const picker = document.getElementById('car');
  if (picker) picker.value = id;
  return true;
}
export const pages = {};
// quiet: a redraw after a live update; the page on screen stays until the new
// one is ready, and stays as it is when the server can't be reached
export async function render(vehicleChanged = false, { quiet = false } = {}) {
  const ticket = ++seq;
  // nothing finished to keep (a first load, or one still on its way): draw as usual
  if (!shown) quiet = false;
  if (!quiet) shown = false;
  renderScope?.abort();
  cleanup?.();
  cleanup = () => {};
  hideStudio();
  let route = location.hash.slice(2) || 'overview';
  const aliases = {
    'policies/per-car': 'settings/encoding',
    'policies/retention': 'settings/cleanup',
    jobs: 'activity',
    driving: 'drives/driving',
    map: 'drives/map',
    policies: 'settings/cleanup',
    account: 'settings/account',
    nodes: 'settings/helpers',
    'settings/nodes': 'settings/helpers',
    notifications: 'overview',
  };
  if (aliases[route]) {
    const notes = route === 'notifications';
    history.replaceState(null, '', '#/' + aliases[route]);
    route = aliases[route];
    if (notes)
      notifications(document.getElementById('bell'), current).catch((e) => toast(e.message, true));
  }
  const [name, sub] = route.split('/'),
    q = new URLSearchParams((sub || name).split('?')[1] || ''),
    key = name.split('?')[0];
  document.getElementById('title').textContent =
    (key === 'drives' ? 'Trips & map' : nav.find((n) => n[0] === key)?.[1]) || 'Sentry Six';
  document.querySelectorAll('[data-route]').forEach((a) => {
    const active = a.dataset.route === key;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (!quiet) page.innerHTML = '';
  document.body.classList.remove('selecting');
  const header = document.getElementById('page-actions');
  header.replaceChildren();
  header.onclick = null;
  const mount = document.createElement('div');
  mount.hidden = quiet;
  page.append(mount);
  const owner = scope(() => [current()?.id], { alive: () => ticket === seq });
  renderScope = owner;
  try {
    if (['viewer', 'encoder'].includes(key)) {
      if (vehicleChanged !== true) selectVehicle(q.get('vehicle'));
      showStudio(
        key,
        current(),
        Object.fromEntries([...q].map(([k, v]) => [k === 'day' ? 'date' : k, v])),
        vehicleChanged === true,
      );
      if ([...q].length) history.replaceState(null, '', '#/' + key);
      return;
    }
    if (key === 'sentryusb') {
      const m = await import('/web/sentryUsbInfo.js');
      if (ticket !== seq) return;
      const p = m.createSentryUsbPage(mount, { h24: () => state.h24 });
      cleanup = () => p?.destroy?.();
      return;
    }
    const known = ['overview', 'footage', 'activity', 'bin', 'health', 'settings', 'drives'];
    if (!known.includes(key)) throw new Error('Page not found');
    const m = await import(`./pages/${key}.js`);
    if (ticket !== seq) return;
    pages[key] = m.render;
    const teardown =
      (await m.render(mount, {
        scope: owner,
        state,
        current,
        render,
        sub: route.split('/').slice(1).join('/'),
        alive: () => ticket === seq,
      })) || (() => {});
    if (ticket === seq) {
      cleanup = teardown;
      if (quiet) {
        [...page.children].forEach((c) => c !== mount && c.remove());
        mount.hidden = false;
      }
      shown = true;
    } else teardown();
  } catch (e) {
    if (ticket !== seq || e?.name === 'AbortError' || quiet) return;
    page.innerHTML = `<div class="card"><p>${esc(offline(e) ? OFFLINE_TEXT : e.message)}</p><div class="form-actions">${offline(e) ? '<button class="btn solid" data-again>Try again</button>' : ''}<a class="btn" href="/original">Open Original</a></div></div>`;
    page.querySelector('[data-again]')?.addEventListener('click', () => render());
  } finally {
    // a quiet redraw that was not kept (failed, or overtaken by another)
    if (mount.hidden) mount.remove();
  }
}
async function refresh() {
  const [v, n, s] = await Promise.all([
    api('/api/vehicles'),
    api('/api/notifications?open=1'),
    api('/api/settings'),
  ]);
  state.vehicles = v.vehicles || [];
  if (!current()) state.vehicleId = state.vehicles[0]?.id;
  state.notes = n.notifications || [];
  state.h24 = !!s.appearance?.clock24;
  state.power = s.power || null;
  document.documentElement.classList.toggle('reduce-effects', !!s.appearance?.reduceEffects);
  const pick = document.getElementById('vehicles');
  pick.innerHTML =
    state.vehicles.length > 1
      ? `<label class="sr-only" for="car">Vehicle</label><select id="car">${state.vehicles.map((v) => `<option value="${esc(v.id)}" ${v.id === state.vehicleId ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>`
      : '';
  pick.querySelector('select')?.addEventListener('change', (e) => {
    selectVehicle(e.target.value);
    history.replaceState(null, '', location.hash.split('?')[0]);
    render(true);
  });
  const bell = document.getElementById('bell'),
    tone = bellTone(state.notes),
    unread = state.notes.filter((n) => !n.readAt).length;
  bell.className = tone;
  bell.setAttribute(
    'aria-label',
    'Notifications' +
      (unread ? `, ${unread.toLocaleString()} new` : '') +
      (tone === 'bad' ? ', something is wrong' : tone === 'warn' ? ', a warning' : ''),
  );
  bell.innerHTML =
    icon('notifications') +
    (unread ? `<span class="badge">${unread.toLocaleString()}</span>` : '');
}
window.addEventListener('hashchange', render);
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.source !== 'sentry-studio') return;
  if (e.data.type === 'showInFolder') location.hash = '#/footage';
  if (e.data.type === 'select-vehicle' && state.vehicles.some((v) => v.id === e.data.id)) {
    selectVehicle(e.data.id);
    history.replaceState(null, '', location.hash.split('?')[0]);
    render(true);
  }
});
Promise.all([api('/api/updates'), import('/web/buildLabel.js'), api('/api/auth/me')])
  .then(([u, b, me]) => {
    document.getElementById('build').textContent = 'Manager · ' + b.buildText(u.current);
    document.querySelector('.avatar').textContent = (me.user || 'S')[0].toUpperCase();
  })
  .catch(() => {});
await refresh().catch((e) => toast(e.message, true));
await render();
const events = new EventSource('/api/events');
events.addEventListener('changed', (event) => {
  let topics;
  try {
    topics = JSON.parse(event.data).topics || [];
  } catch {
    return;
  }
  if (topics.includes('interface')) {
    location.reload();
    return;
  }
  if (topics.some((t) => ['inventory', 'notifications', 'vehicles', 'share'].includes(t)))
    refresh()
      .then(() => {
        window.dispatchEvent(new CustomEvent('s6:changed', { detail: topics }));
        if (location.hash.startsWith('#/overview') || !location.hash) render(false, { quiet: true });
      })
      // a live update the server could not answer: the next one tries again
      .catch((e) => offline(e) || toast(e.message, true));
});
// Keep the shell below the shared startup and critical-update bars.
function fitUnderBarsSoon() {
  requestAnimationFrame(() => {
    let top = 0;
    for (const id of ['sentry-critical-update', 'sentry-health-bar']) {
      const el = document.getElementById(id);
      if (el && !el.hidden) top = Math.max(top, el.getBoundingClientRect().bottom);
    }
    document.documentElement.style.setProperty('--bars-top', Math.max(0, top) + 'px');
  });
}
window.addEventListener('scroll', fitUnderBarsSoon, { passive: true });
window.addEventListener('resize', fitUnderBarsSoon);
new MutationObserver(fitUnderBarsSoon).observe(document.body, {
  childList: true,
});
fitUnderBarsSoon();
