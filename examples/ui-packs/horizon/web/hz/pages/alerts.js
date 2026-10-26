// Notifications as warning lights: open, unread, resolved; mark read or dismiss.
import { h, ico, api, app, loadNotes, since, stampFull, toast, act, count, segs, onSegs, pill, blank, paint } from '../core.js';

const TONE = { critical: 'red', warning: 'org', info: 'cyan' };

export default {
  async mount(el, { status }) {
    let show = 'open';
    el.innerHTML = `<section class="ptitle hud"><div><h1 class="chrome">Notifications</h1><p id="a-sub"></p></div>
        <div class="pacts"><button class="btn" type="button" id="a-read">${ico('check')}Mark all read</button></div></section>
      <section class="panel hud"><div class="row" style="margin-bottom:12px">${segs('as', [['open', 'Open'], ['unread', 'Unread'], ['all', 'All, with resolved']], show, 'Show')}</div><ul class="alerts" id="a-list"></ul></section>`;
    const $ = (s) => el.querySelector(s);
    function draw() {
      const all = app.notes;
      const list = all.filter((n) => (show === 'all' ? true : show === 'unread' ? !n.readAt && !n.resolvedAt : !n.resolvedAt));
      const unread = all.filter((n) => !n.readAt && !n.resolvedAt).length;
      const open = all.filter((n) => !n.resolvedAt).length;
      $('#a-sub').textContent = `${open} open · ${unread} unread · ${count(all.length, 'notification')} kept`;
      status(`${open} open · ${unread} unread`);
      $('#a-read').disabled = !unread;
      paint($('#a-list'), list.map((n) => `<li class="alert-i ${h(n.level)}${n.readAt ? '' : ' unread'}${n.resolvedAt ? ' done' : ''}" data-id="${n.id}">
          <span class="alamp ${TONE[n.level] || ''}" aria-hidden="true">${ico(n.level === 'info' ? 'info' : 'warn')}</span>
          <div class="al-main"><div class="row"><b>${h(n.title)}</b>${pill(n.level, TONE[n.level] || '')}${n.readAt ? '' : pill('new', 'mag')}${n.kind ? `<span class="tiny faint mono">${h(n.kind)}</span>` : ''}</div>
            <p class="small dim">${h(n.message || '')}</p>
            <p class="tiny faint num">${h(stampFull(n.createdAt))} · ${h(since(n.updatedAt || n.createdAt))}${n.resolvedAt ? ` · resolved ${h(since(n.resolvedAt))}` : ''}</p></div>
          <div class="row al-acts">${n.readAt ? '' : '<button class="btn sm" type="button" data-read>Mark read</button>'}${n.resolvedAt ? '' : '<button class="btn sm" type="button" data-dismiss>Dismiss</button>'}</div></li>`).join('') || `<li>${blank(show === 'open' ? 'No open notifications. All lights are off.' : 'Nothing here.')}</li>`);
    }
    $('#a-list').addEventListener('click', async (e) => {
      const li = e.target.closest('[data-id]');
      if (!li) return;
      const id = Number(li.dataset.id);
      if (e.target.closest('[data-read]')) await act(e.target.closest('button'), () => api('/api/notifications/read', { body: { ids: [id] } }));
      else if (e.target.closest('[data-dismiss]')) await act(e.target.closest('button'), async () => { await api(`/api/notifications/${id}/dismiss`, { body: {} }); toast('Dismissed.'); });
      else return;
      await loadNotes().catch(() => {});
      draw();
    });
    $('#a-read').onclick = (e) => act(e.currentTarget, async () => {
      const ids = app.notes.filter((n) => !n.readAt).map((n) => n.id);
      await api('/api/notifications/read', { body: { ids } });
      await loadNotes();
      toast(`Marked ${count(ids.length, 'notification')} read.`);
      draw();
    });
    onSegs(el, 'as', (x) => { show = x; draw(); });
    await loadNotes().catch(() => {});
    draw();
    return { onTopics(t) { if (t.includes('notifications')) draw(); } };
  }
};
