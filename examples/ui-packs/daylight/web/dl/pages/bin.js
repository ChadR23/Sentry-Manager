// Recycle Bin: footage moved out of the way. Restore it, or delete it for good.

import { api, esc, enc, icon, bytes, plural, when, emptyState, confirmDialog, toast, fail, busy, chip, CATEGORY } from '../core.js';
import { state, vehiclePicker, vehicleById, loadVehicles } from '../state.js';

let filter = null; // a vehicle id, or null for all

export async function render(ctx) {
  const { view } = ctx;
  if (filter && !vehicleById(filter)) filter = null;
  let items = [];
  const load = async () => { items = (await api(`/api/bin${filter ? `?vehicle=${enc(filter)}` : ''}`)).items; };
  await load();
  if (!ctx.alive()) return;

  const draw = () => {
    const total = items.reduce((n, i) => n + i.bytes, 0);
    const v = filter ? vehicleById(filter) : null;
    view.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>Recycle Bin</h1><p class="lede">Nothing in here is deleted on its own. Restore puts footage back exactly where it was.</p></div>
        <div class="head-actions">${state.vehicles.length > 1 ? vehiclePicker({ allowAll: true, selected: filter || '', id: 'bin-vehicle' }) : ''}</div></div>
      ${items.length ? `<div class="card">
          <div class="row-between" style="margin-bottom:6px"><div><b>${plural(items.length, 'item')}</b> <span class="muted">· ${bytes(total)} you could free up</span></div>
            <button class="btn btn-danger btn-sm" type="button" id="empty">${icon('trash')} Empty Recycle Bin</button></div>
          <ul class="list">${items.map((i) => {
            const cat = CATEGORY[i.category] || CATEGORY.Other;
            const vname = state.vehicles.length > 1 ? vehicleById(i.vehicleId)?.name : '';
            return `<li class="list-item" data-item="${esc(i.id)}"><div class="grow"><b>${esc(cat.word)} · ${esc(i.startAt || i.label)}</b>
              <div class="row" style="margin-top:6px">${chip(i.reason === 'policy' ? 'Moved by a cleanup rule' : 'Moved by you', i.reason === 'policy' ? 'violet' : 'grey')}<span class="muted small">${esc(vname ? `${vname} · ` : '')}${bytes(i.bytes)} · ${plural(i.files.length, 'file')} · moved ${esc(when(i.trashedAt))}</span></div>
              ${i.files.some((f) => f.conflict) ? '<p class="small" style="color:var(--warn);margin-top:6px">Some files couldn’t be put back because a file with the same name is there now.</p>' : ''}</div>
              <div class="item-actions"><button class="btn btn-primary btn-sm" type="button" data-restore>${icon('restore')} Restore</button>
              <button class="btn btn-ghost btn-sm" type="button" data-delete>Delete forever</button></div></li>`;
          }).join('')}</ul></div>`
        : emptyState({ art: 'trash', title: 'The Recycle Bin is empty', text: `Footage you move out of the way${v ? ` for ${esc(v.name)}` : ''} waits here until you restore it or delete it for good.`, action: '<a class="btn btn-soft" href="#/footage">Go to Footage</a>' })}
    </div>`;
    wire();
  };
  const refresh = async () => { try { await load(); } catch (err) { return fail(err); } if (ctx.alive()) draw(); return undefined; };
  const wire = () => {
    view.querySelector('#bin-vehicle')?.addEventListener('change', (e) => { filter = e.target.value || null; refresh(); });
    view.querySelectorAll('[data-item]').forEach((row) => {
      const item = items.find((i) => i.id === row.dataset.item);
      row.querySelector('[data-restore]').onclick = (e) => busy(e.currentTarget, async () => {
        try {
          const out = await api(`/api/bin/${enc(item.id)}/restore`, { body: {} });
          toast(out.conflicts ? `Restored ${out.restored} file(s). ${out.conflicts} couldn’t be, because a file with that name exists.` : 'Restored. It’s back in Footage.', { kind: out.conflicts ? 'bad' : 'good' });
        } catch (err) { fail(err); }
        await loadVehicles().catch(() => {});
        refresh();
      });
      row.querySelector('[data-delete]').onclick = async (e) => {
        if (!(await confirmDialog({ title: 'Delete forever?', body: `<p><b>${esc(item.label)}</b> (${bytes(item.bytes)}) will be permanently deleted from the storage.</p><p class="muted">This can’t be undone.</p>`, ok: 'Delete forever', danger: true }))) return;
        await busy(e.currentTarget, async () => {
          try {
            await api(`/api/bin/${enc(item.id)}/delete`, { body: { confirm: true } });
            toast(`Deleted. ${bytes(item.bytes)} freed.`, { kind: 'good' });
          } catch (err) { fail(err); }
        });
        await loadVehicles().catch(() => {});
        refresh();
      };
    });
    view.querySelector('#empty')?.addEventListener('click', async (e) => {
      const total = items.reduce((n, i) => n + i.bytes, 0);
      const v = filter ? vehicleById(filter) : null;
      if (!(await confirmDialog({ title: 'Empty the Recycle Bin?', body: `<p>${plural(items.length, 'item')} (${bytes(total)})${v ? ` of ${esc(v.name)}` : ''} will be permanently deleted.</p><p class="muted">This can’t be undone.</p>`, ok: 'Empty Recycle Bin', danger: true }))) return;
      await busy(e.currentTarget, async () => {
        try {
          const out = await api('/api/bin/empty', { body: { confirm: true, vehicle: filter || null } });
          toast(`Deleted ${plural(out.deleted, 'item')} and freed ${bytes(out.bytes)}.${out.failed ? ` ${out.failed} couldn’t be deleted.` : ''}`, { kind: out.failed ? 'bad' : 'good' });
        } catch (err) { fail(err); }
      });
      await loadVehicles().catch(() => {});
      refresh();
    });
  };
  draw();
  ctx.on('topics', (t) => { if (t.includes('bin') && !document.querySelector('dialog[open]')) refresh(); });
}
