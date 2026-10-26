// Alerts (notifications): what may need the owner. Opening the page marks
// them read; Dismiss puts one away.

import { api, esc, icon, when, emptyState, toast, fail, busy } from '../core.js';
import { loadNotes, vehicleById, state } from '../state.js';

const TONE = { critical: ['bad', 'alert'], warning: ['warn', 'alert'], info: ['info', 'info'] };

export async function render(ctx) {
  const { view } = ctx;
  let list = [];
  let showOld = false;
  const load = async () => { list = (await api('/api/notifications')).notifications; };
  await load();
  if (!ctx.alive()) return;
  const markRead = async () => {
    const ids = list.filter((n) => !n.readAt && !n.resolvedAt).map((n) => n.id);
    if (!ids.length) return;
    await api('/api/notifications/read', { body: { ids } }).catch(() => {});
    await loadNotes().catch(() => {});
  };
  const draw = () => {
    const open = list.filter((n) => !n.resolvedAt);
    const old = list.filter((n) => n.resolvedAt);
    const item = (n) => {
      const [tone, ic] = TONE[n.level] || TONE.warning;
      const vname = n.vehicleId && state.vehicles.length > 1 ? vehicleById(n.vehicleId)?.name : '';
      return `<li class="list-item" data-id="${n.id}"><div class="note note-${n.resolvedAt ? 'info' : tone}" style="flex:1;align-items:flex-start">${icon(n.resolvedAt ? 'checkCircle' : ic)}
        <div class="grow" style="flex:1;min-width:0"><b>${esc(n.title)}</b>${!n.readAt && !n.resolvedAt ? ' <span class="chip chip-teal">New</span>' : ''}
          ${n.message ? `<p style="margin-top:4px">${esc(n.message)}</p>` : ''}
          <p class="muted small" style="margin-top:4px">${esc(vname ? `${vname} · ` : '')}${esc(when(n.createdAt))}${n.resolvedAt ? ` · sorted itself out ${esc(when(n.resolvedAt))}` : ''}</p></div>
        ${n.resolvedAt ? '' : `<button class="btn btn-sm" type="button" data-dismiss="${n.id}">Dismiss</button>`}</div></li>`;
    };
    view.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>Alerts</h1><p class="lede">Things that may need you. Most sort themselves out; you’ll see that here too.</p></div>
        <div class="head-actions">${open.length > 1 ? '<button class="btn" type="button" id="dismiss-all">Dismiss all</button>' : ''}</div></div>
      ${open.length ? `<div class="card"><ul class="list">${open.map(item).join('')}</ul></div>` : emptyState({ art: 'checkCircle', title: 'All clear', text: 'Nothing needs you right now. If something ever does, it shows up here and on the bell.' })}
      ${old.length ? `<div class="section"><button class="btn btn-ghost" type="button" id="toggle-old" aria-expanded="${showOld}">${showOld ? 'Hide' : 'Show'} ${old.length} earlier</button>
        ${showOld ? `<div class="card" style="margin-top:12px"><ul class="list">${old.map(item).join('')}</ul></div>` : ''}</div>` : ''}
    </div>`;
    view.querySelectorAll('[data-dismiss]').forEach((b) => {
      b.onclick = () => busy(b, async () => {
        try { await api(`/api/notifications/${encodeURIComponent(b.dataset.dismiss)}/dismiss`, { body: {} }); } catch (err) { fail(err); }
        await refresh();
        loadNotes().catch(() => {});
      });
    });
    view.querySelector('#dismiss-all')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      for (const n of open) await api(`/api/notifications/${encodeURIComponent(n.id)}/dismiss`, { body: {} }).catch(() => {});
      toast('All dismissed.', { kind: 'good' });
      await refresh();
      loadNotes().catch(() => {});
    }));
    view.querySelector('#toggle-old')?.addEventListener('click', () => { showOld = !showOld; draw(); view.querySelector('#toggle-old')?.focus(); });
  };
  const refresh = async () => { try { await load(); } catch (err) { return fail(err); } if (ctx.alive()) draw(); return undefined; };
  draw();
  markRead();
  ctx.on('topics', async (t) => { if (t.includes('notifications')) { await refresh(); markRead(); } });
}
