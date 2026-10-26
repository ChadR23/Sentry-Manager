// Recycle Bin: restore, delete forever, empty, per vehicle.

import { $, esc, icon, api, state, bytes, plural, whenFull, toast, confirmDialog, empty, loadVehicles, store } from '../core.js';

export default {
  title: 'Recycle Bin',
  kicker: 'Nothing is lost',
  icon: 'trash',
  topics: ['bin'],
  async mount(ctx) {
    const { body, actions } = ctx;
    let dead = false;
    let scope = store.get('bin-scope', state.vehicles.length > 1 ? 'all' : (state.vehicles[0]?.id || 'all'));
    if (scope !== 'all' && !state.vehicles.some((v) => v.id === scope)) scope = 'all';
    let items = [];
    actions.innerHTML = `${state.vehicles.length > 1 ? `<label class="veh-pick"><span class="sr-only">Vehicle</span>${icon('car')}<select class="input" id="b-scope"><option value="all">All vehicles</option>${state.vehicles.map((v) => `<option value="${esc(v.id)}"${v.id === scope ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>` : ''}<button class="btn danger" type="button" id="b-empty">${icon('trash')} Empty</button>`;
    const name = (id) => state.vehicles.find((v) => v.id === id)?.name || '';

    async function load() {
      const out = await api(`/api/bin${scope === 'all' ? '' : `?vehicle=${encodeURIComponent(scope)}`}`);
      if (dead) return;
      items = out.items || [];
      const total = items.reduce((n, i) => n + (i.bytes || 0), 0);
      $('#b-empty', actions).disabled = !items.length;
      ctx.sub(items.length ? `${plural(items.length, 'item')} · ${bytes(total)}` : '');
      body.innerHTML = `<p class="note ok" style="margin-bottom:18px">${icon('shield', 'ico-sm')} Nothing here is deleted by itself. Restore puts a recording back exactly where it was; only Delete forever and Empty free the space.</p>
        ${items.length ? items.map((i) => `<div class="bin-item" data-item="${esc(i.id)}"><div><b>${esc(i.label)}</b><br><span class="muted small">${plural(i.files?.length || 0, 'file')} · ${bytes(i.bytes)} · moved ${esc(whenFull(i.trashedAt))} by ${i.reason === 'policy' ? 'a policy' : 'you'}${scope === 'all' && name(i.vehicleId) ? ` · ${esc(name(i.vehicleId))}` : ''}${(i.files || []).some((f) => f.conflict) ? ' · some files could not be restored (name taken)' : ''}</span></div>
          <div class="row"><button class="btn sm" type="button" data-restore>${icon('refresh')} Restore</button><button class="btn sm danger" type="button" data-delete>Delete forever</button></div></div>`).join('')
          : empty('The Recycle Bin is empty', 'Recordings you move here, or that a policy moves, wait here until you restore or delete them.')}`;
    }

    actions.addEventListener('change', (e) => {
      if (e.target.id !== 'b-scope') return;
      scope = e.target.value;
      store.set('bin-scope', scope);
      load();
    });
    $('#b-empty', actions).addEventListener('click', async () => {
      const total = items.reduce((n, i) => n + (i.bytes || 0), 0);
      if (!(await confirmDialog({ title: 'Empty the Recycle Bin?', body: `<p>${plural(items.length, 'item')} (${bytes(total)})${scope === 'all' ? '' : ` of ${esc(name(scope))}`} will be deleted for good. This can’t be undone.</p>`, ok: 'Empty the Bin', danger: true }))) return;
      try {
        const out = await api('/api/bin/empty', { body: { confirm: true, vehicle: scope === 'all' ? null : scope } });
        toast(`Deleted ${plural(out.deleted, 'item')} (${bytes(out.bytes)}).`, out.failed > 0 ? 'bad' : 'ok');
      } catch (err) { toast(err.message, 'bad'); }
      await loadVehicles().catch(() => {});
      load();
    });
    body.addEventListener('click', async (e) => {
      const row = e.target.closest('[data-item]');
      if (!row) return;
      const item = items.find((i) => i.id === row.dataset.item);
      if (e.target.closest('[data-restore]')) {
        try {
          const out = await api(`/api/bin/${encodeURIComponent(item.id)}/restore`, { body: {} });
          toast(out.conflicts ? `Restored ${out.restored} file(s); ${out.conflicts} could not be (a file with that name exists).` : 'Restored.', out.conflicts ? 'bad' : 'ok');
        } catch (err) { toast(err.message, 'bad'); }
      } else if (e.target.closest('[data-delete]')) {
        if (!(await confirmDialog({ title: 'Delete forever?', body: `<p><b>${esc(item.label)}</b> (${bytes(item.bytes)}) will be deleted from the share. This can’t be undone.</p>`, ok: 'Delete forever', danger: true }))) return;
        try {
          await api(`/api/bin/${encodeURIComponent(item.id)}/delete`, { body: { confirm: true } });
          toast('Deleted.');
        } catch (err) { toast(err.message, 'bad'); }
      } else return;
      await loadVehicles().catch(() => {});
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
