// Alerts (notifications): what needs attention, newest first. Dismiss one,
// mark them read (the dock badge counts the unread open ones).

import { $, esc, icon, api, state, plural, whenFull, ago, toast, empty, loadNotes } from '../core.js';

const LEVEL = { critical: ['bad', 'Critical'], warning: ['warn', 'Warning'], warn: ['warn', 'Warning'], info: ['ok', 'Info'] };

export default {
  title: 'Notifications',
  kicker: 'Signals',
  icon: 'bell',
  topics: ['notifications'],
  async mount(ctx) {
    const { body, actions } = ctx;
    let dead = false;
    let list = [];
    let show = 'open';
    actions.innerHTML = `<div class="seg" role="group" aria-label="Which"><button type="button" data-show="open" aria-pressed="true">Open</button><button type="button" data-show="all" aria-pressed="false">All</button></div>
      <button class="btn" type="button" id="n-read">${icon('check')} Mark all read</button>`;

    async function load() {
      const out = await api('/api/notifications');
      if (dead) return;
      list = out.notifications || [];
      const shown = show === 'open' ? list.filter((n) => !n.resolvedAt) : list;
      const unread = list.filter((n) => !n.readAt && !n.resolvedAt);
      $('#n-read', actions).disabled = !unread.length;
      ctx.sub(`${plural(list.filter((n) => !n.resolvedAt).length, 'open notification')}${unread.length ? ` · ${unread.length} unread` : ''}`);
      body.innerHTML = shown.length ? shown.map((n) => {
        const [dot, word] = LEVEL[n.level] || ['warn', n.level];
        const veh = state.vehicles.find((v) => v.id === n.vehicleId)?.name;
        return `<article class="note-item${n.resolvedAt ? ' resolved' : ''}${!n.readAt && !n.resolvedAt ? ' unread' : ''}" data-id="${esc(n.id)}">
          <span class="dot ${dot}" aria-hidden="true"></span>
          <div><div class="row" style="gap:8px"><b>${esc(n.title)}</b><span class="chip ${dot === 'bad' ? 'red' : dot === 'ok' ? 'green' : 'amber'}">${esc(word)}</span>${!n.readAt && !n.resolvedAt ? '<span class="chip magenta">New</span>' : ''}</div>
            ${n.message ? `<p>${esc(n.message)}</p>` : ''}
            <p class="muted tiny">${veh ? `${esc(veh)} · ` : ''}${esc(whenFull(n.createdAt))} (${esc(ago(n.createdAt))})${n.resolvedAt ? ` · resolved ${esc(whenFull(n.resolvedAt))}` : ''}</p></div>
          ${n.resolvedAt ? '' : `<div class="row">${n.readAt ? '' : `<button class="btn sm" type="button" data-read>Mark read</button>`}<button class="btn sm" type="button" data-dismiss>${icon('x')} Dismiss</button></div>`}
        </article>`;
      }).join('') : empty(show === 'open' ? 'All clear' : 'No notifications', 'Shares that go offline, storage running out and other things that need you show up here.');
    }

    actions.addEventListener('click', async (e) => {
      const s = e.target.closest('[data-show]');
      if (s) {
        show = s.dataset.show;
        actions.querySelectorAll('[data-show]').forEach((b) => b.setAttribute('aria-pressed', String(b === s)));
        load();
        return;
      }
      if (e.target.closest('#n-read')) {
        const ids = list.filter((n) => !n.readAt).map((n) => n.id);
        await api('/api/notifications/read', { body: { ids } }).catch((err) => toast(err.message, 'bad'));
        await loadNotes().catch(() => {});
        load();
      }
    });
    body.addEventListener('click', async (e) => {
      const row = e.target.closest('[data-id]');
      if (!row) return;
      const id = row.dataset.id;
      if (e.target.closest('[data-dismiss]')) {
        await api(`/api/notifications/${encodeURIComponent(id)}/dismiss`, { body: {} }).catch((err) => toast(err.message, 'bad'));
      } else if (e.target.closest('[data-read]')) {
        await api('/api/notifications/read', { body: { ids: [Number(id)] } }).catch((err) => toast(err.message, 'bad'));
      } else return;
      await loadNotes().catch(() => {});
      load();
    });
    body.innerHTML = '<p class="loading">Loading…</p>';
    await load();
    return {
      refresh() { load().catch(() => {}); },
      destroy() { dead = true; }
    };
  }
};
