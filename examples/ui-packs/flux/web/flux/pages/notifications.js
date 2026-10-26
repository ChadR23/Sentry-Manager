// Notifications: list, mark read, dismiss. The unread badge lives in the shell.
import { esc, api, state, loadNotes, ago, isoish, icon, toast, busy, plural } from '../core.js';
import { seg, wireSeg, empty, chip } from '../ui.js';

const TONE = { critical: 'red', warning: 'amber', info: 'cyan' };

export default {
  async mount(el) {
    let show = 'open';
    el.innerHTML = `<div class="phead"><div><h1>Notifications</h1><p class="muted small" id="nt-sub"></p></div>
      <div class="phead-actions"><button class="btn" type="button" id="nt-read">${icon('check')}Mark all read</button></div></div>
      <div class="toolbar">${seg('nshow', [['open', 'Open'], ['unread', 'Unread'], ['all', 'All, incl. resolved']], show, 'Show')}</div>
      <ul class="notes" id="nt-list"></ul>`;
    const $ = (s) => el.querySelector(s);
    function draw() {
      const all = state.notes;
      const list = all.filter((n) => (show === 'all' ? true : show === 'unread' ? !n.readAt && !n.resolvedAt : !n.resolvedAt));
      const unread = all.filter((n) => !n.readAt && !n.resolvedAt).length;
      $('#nt-sub').textContent = `${all.filter((n) => !n.resolvedAt).length} open · ${unread} unread · ${all.length} kept`;
      $('#nt-read').disabled = !unread;
      $('#nt-list').innerHTML = list.map((n) => `<li class="note-item ${esc(n.level)}${n.readAt ? '' : ' unread'}${n.resolvedAt ? ' resolved' : ''}" data-id="${n.id}">
        <i class="lvl" aria-hidden="true"></i>
        <div class="note-body"><div class="note-top"><b>${esc(n.title)}</b>${chip(n.level, TONE[n.level] || '')}${n.kind ? `<span class="faint small mono">${esc(n.kind)}</span>` : ''}${n.readAt ? '' : '<span class="dotnew" title="unread"></span>'}</div>
          <p class="small muted">${esc(n.message || '')}</p>
          <p class="faint small num">${esc(isoish(n.createdAt))} · ${esc(ago(n.updatedAt || n.createdAt))}${n.resolvedAt ? ` · resolved ${esc(ago(n.resolvedAt))}` : ''}</p></div>
        <div class="note-acts">${n.readAt ? '' : '<button class="btn sm" type="button" data-read>Mark read</button>'}${n.resolvedAt ? '' : '<button class="btn sm" type="button" data-dismiss>Dismiss</button>'}</div></li>`).join('') || `<li>${empty(show === 'open' ? 'No open notifications. All clear.' : 'Nothing here.')}</li>`;
    }
    $('#nt-list').addEventListener('click', async (e) => {
      const li = e.target.closest('[data-id]');
      if (!li) return;
      const id = Number(li.dataset.id);
      if (e.target.closest('[data-read]')) await busy(e.target.closest('button'), () => api('/api/notifications/read', { body: { ids: [id] } }));
      else if (e.target.closest('[data-dismiss]')) await busy(e.target.closest('button'), async () => { await api(`/api/notifications/${id}/dismiss`, { body: {} }); toast('Dismissed.'); });
      else return;
      await loadNotes().catch(() => {});
      draw();
    });
    $('#nt-read').onclick = (e) => busy(e.currentTarget, async () => {
      const ids = state.notes.filter((n) => !n.readAt).map((n) => n.id);
      await api('/api/notifications/read', { body: { ids } });
      await loadNotes();
      toast(`Marked ${plural(ids.length, 'notification')} read.`);
      draw();
    });
    wireSeg(el, 'nshow', (x) => { show = x; draw(); });
    await loadNotes().catch(() => {});
    draw();
    return { onTopics(t) { if (t.includes('notifications')) draw(); } };
  }
};
