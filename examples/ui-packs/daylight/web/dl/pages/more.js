// More (phones): everything that isn't on the tab bar.

import { esc, icon } from '../core.js';
import { unreadCount, binCount, state } from '../state.js';
import { MORE_ROUTES, routeInfo, signOut, setTheme, currentTheme } from '../app.js';

export async function render(ctx) {
  const { view } = ctx;
  const draw = () => {
    const badge = (k) => {
      const n = k === 'notifications' ? unreadCount() : k === 'bin' ? binCount() : k === 'jobs' ? state.runningJobs.length : 0;
      return n ? `<b class="badge${k === 'notifications' ? ' badge-bad' : k === 'jobs' ? ' badge-busy' : ''}">${n}</b>` : '';
    };
    const t = currentTheme();
    view.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>More</h1><p class="lede">Looking after your footage, and setting things up.</p></div></div>
      <div class="card"><ul class="list more-list">${MORE_ROUTES.map((k) => {
        const r = routeInfo(k);
        return `<li><a class="list-item" href="#/${k}"><span class="mi-icon">${icon(r.icon)}</span><span class="grow mi-text"><b>${esc(r.label)}</b><span>${esc(r.desc || '')}</span></span>${badge(k)}<span class="chev">${icon('next')}</span></a></li>`;
      }).join('')}</ul></div>
      <div class="card section"><h2>Look</h2><p class="muted" style="margin:6px 0 14px">Light, dark, or follow your device.</p>
        <div class="seg" role="group" aria-label="Look">${[['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button type="button" data-theme-pick="${k}" aria-pressed="${t === k}">${l}</button>`).join('')}</div></div>
      <div class="section"><button class="btn btn-block" type="button" id="signout">${icon('logout')} Sign out</button></div>
    </div>`;
    view.querySelectorAll('[data-theme-pick]').forEach((b) => { b.onclick = () => { setTheme(b.dataset.themePick); draw(); view.querySelector(`[data-theme-pick="${b.dataset.themePick}"]`)?.focus(); }; });
    view.querySelector('#signout').onclick = signOut;
  };
  draw();
  ctx.on('notes', draw);
  ctx.on('vehicles', draw);
  ctx.on('theme', draw);
}
