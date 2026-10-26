// Recycle Bin: restore, delete forever, empty — per vehicle or all.
import { esc, api, state, current, bytes, plural, isoish, icon, toast, confirmDialog, busy, loadVehicles, debounce } from '../core.js';
import { seg, wireSeg, empty, chip } from '../ui.js';

export default {
  async mount(el) {
    let scope = 'vehicle';
    let items = [];
    let text = '';
    const sel = new Set();
    el.innerHTML = `<div class="phead"><div><h1>Recycle Bin</h1><p class="muted small" id="bin-sub"></p></div>
      <div class="phead-actions"><button class="btn danger" type="button" id="bin-empty">${icon('bin')}Empty…</button></div></div>
      <p class="note green small">Nothing here is deleted automatically. Restore puts recordings back exactly where they were; only Delete forever and Empty free the space.</p>
      <div class="toolbar wrap">${seg('bscope', [['vehicle', 'This vehicle'], ['all', 'Every vehicle']], scope, 'Vehicles')}
        <input class="input grow" type="search" data-filter id="bin-text" placeholder="Filter  ( / )" aria-label="Filter the Recycle Bin">
        <button class="btn" type="button" id="bin-restore-sel" disabled>${icon('refresh')}Restore selected</button></div>
      <div class="card flush"><div class="tscroll"><table class="dtable stack" id="bin-table"></table></div></div>`;
    const $ = (s) => el.querySelector(s);
    async function load() {
      const v = current();
      ({ items } = await api(`/api/bin${scope === 'vehicle' && v ? `?vehicle=${encodeURIComponent(v.id)}` : ''}`));
      for (const id of [...sel]) if (!items.some((i) => i.id === id)) sel.delete(id);
      draw();
    }
    function draw() {
      const v = current();
      const rows = items.filter((i) => !text || `${i.label} ${i.reason}`.toLowerCase().includes(text));
      const total = items.reduce((n, i) => n + i.bytes, 0);
      $('#bin-sub').textContent = `${plural(items.length, 'item')} · ${bytes(total)}${scope === 'vehicle' && v ? ` · ${v.name}` : ' · every vehicle'}`;
      $('#bin-empty').disabled = !items.length;
      $('#bin-restore-sel').disabled = !sel.size;
      const name = (id) => state.vehicles.find((x) => x.id === id)?.name || id;
      $('#bin-table').innerHTML = `<thead><tr><th class="cb"><label class="cbl"><input type="checkbox" id="bin-all" aria-label="Select all"${rows.length && rows.every((i) => sel.has(i.id)) ? ' checked' : ''}></label></th><th>recording</th>${scope === 'all' ? '<th>vehicle</th>' : ''}<th class="r">size</th><th>moved</th><th>why</th><th class="r">actions</th></tr></thead><tbody>
        ${rows.map((i) => `<tr data-item="${esc(i.id)}" class="${sel.has(i.id) ? 'sel' : ''}"><td class="cb"><label class="cbl"><input type="checkbox" aria-label="Select ${esc(i.label)}"${sel.has(i.id) ? ' checked' : ''}></label></td>
          <td><b>${esc(i.label)}</b><div class="faint small">${plural(i.files?.length || 0, 'file')}${(i.files || []).some((f) => f.conflict) ? ' · some files could not be restored (name taken)' : ''}</div></td>
          ${scope === 'all' ? `<td>${esc(name(i.vehicleId))}</td>` : ''}
          <td class="r num">${bytes(i.bytes)}</td><td class="num small nowrap">${esc(isoish(i.trashedAt))}</td><td>${chip(i.reason === 'policy' ? 'policy' : 'you', i.reason === 'policy' ? 'violet' : '')}</td>
          <td class="r nowrap"><button class="btn sm" type="button" data-restore>${icon('refresh')}Restore</button><button class="btn sm danger" type="button" data-del>Delete forever</button></td></tr>`).join('') || `<tr><td colspan="7">${empty(items.length ? 'Nothing matches.' : 'The Recycle Bin is empty.')}</td></tr>`}</tbody>`;
    }
    async function restore(ids) {
      let ok = 0;
      let conflicts = 0;
      for (const id of ids) {
        try {
          const out = await api(`/api/bin/${encodeURIComponent(id)}/restore`, { body: {} });
          ok++;
          conflicts += out.conflicts || 0;
        } catch (err) { toast(err.message, 'bad'); }
      }
      if (ok) toast(conflicts ? `Restored ${ok}; ${conflicts} file(s) could not be (name taken).` : `Restored ${plural(ok, 'item')}.`, conflicts ? 'bad' : 'ok');
      ids.forEach((id) => sel.delete(id));
      await loadVehicles().catch(() => {});
      await load();
    }
    $('#bin-table').addEventListener('click', async (e) => {
      if (e.target.closest('label.cbl') && !e.target.matches('input')) return;
      if (e.target.id === 'bin-all') {
        const on = e.target.checked;
        items.forEach((i) => (on ? sel.add(i.id) : sel.delete(i.id)));
        draw();
        return;
      }
      const tr = e.target.closest('tr[data-item]');
      if (!tr) return;
      const id = tr.dataset.item;
      const item = items.find((i) => i.id === id);
      if (e.target.matches('input[type=checkbox]')) { if (e.target.checked) sel.add(id); else sel.delete(id); draw(); return; }
      if (e.target.closest('[data-restore]')) { await busy(e.target.closest('button'), () => restore([id])); return; }
      if (e.target.closest('[data-del]')) {
        if (!(await confirmDialog({ title: 'Delete forever?', body: `<p><b>${esc(item.label)}</b> (${bytes(item.bytes)}) is permanently deleted from the share. This cannot be undone.</p>`, ok: 'Delete forever', danger: true }))) return;
        await busy(null, async () => { await api(`/api/bin/${encodeURIComponent(id)}/delete`, { body: { confirm: true } }); toast('Deleted.'); });
        await loadVehicles().catch(() => {});
        await load();
      }
    });
    $('#bin-restore-sel').onclick = (e) => busy(e.currentTarget, () => restore([...sel]));
    $('#bin-empty').onclick = async () => {
      const v = scope === 'vehicle' ? current() : null;
      const total = items.reduce((n, i) => n + i.bytes, 0);
      if (!(await confirmDialog({ title: 'Empty the Recycle Bin?', body: `<p>${plural(items.length, 'item')} (<b class="num">${bytes(total)}</b>) of ${esc(v ? v.name : 'every vehicle')} are permanently deleted. This cannot be undone.</p>`, ok: 'Empty Recycle Bin', danger: true }))) return;
      await busy($('#bin-empty'), async () => {
        const out = await api('/api/bin/empty', { body: { confirm: true, vehicle: v?.id || null } });
        toast(`Deleted ${plural(out.deleted, 'item')} (${bytes(out.bytes)}).`, out.failed ? 'bad' : 'ok');
      });
      await loadVehicles().catch(() => {});
      await load();
    };
    wireSeg(el, 'bscope', (x) => { scope = x; load(); });
    $('#bin-text').addEventListener('input', debounce((e) => { text = e.target.value.toLowerCase(); draw(); }, 100));
    await load();
    return {
      onTopics(t) { if (t.includes('bin')) load().catch(() => {}); },
      onVehicle() { load().catch(() => {}); },
      commands: () => [{ group: 'Recycle Bin', label: 'Restore every item shown', icon: 'refresh', run: () => restore(items.map((i) => i.id)) }]
    };
  }
};
