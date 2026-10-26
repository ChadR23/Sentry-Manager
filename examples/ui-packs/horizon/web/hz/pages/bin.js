// Recycle Bin: restore, delete forever or empty, per vehicle or for all of them.
import { h, ico, api, app, car, size, count, stampFull, toast, ask, act, segs, onSegs, pill, loadCars, debounce, blank, paint } from '../core.js';

export default {
  async mount(el, { status }) {
    let scope = 'car';
    let items = [];
    let q = '';
    const sel = new Set();
    el.innerHTML = `<section class="ptitle hud"><div><h1 class="chrome">Recycle Bin</h1><p id="b-sub"></p></div>
        <div class="pacts"><button class="btn" type="button" id="b-restore" disabled>${ico('refresh')}Restore selected</button><button class="btn danger" type="button" id="b-empty">${ico('bin')}Empty…</button></div></section>
      <p class="note grn hud-note">Nothing here is deleted by itself. Restore puts recordings back exactly where they were; only Delete forever and Empty free the space.</p>
      <section class="panel hud">
        <div class="row" style="margin-bottom:12px">${segs('bs', [['car', 'This vehicle'], ['all', 'Every vehicle']], scope, 'Vehicles')}
          <label class="chk"><input type="checkbox" id="b-all"> Select all</label>
          <input class="in grow" type="search" id="b-q" placeholder="Filter" aria-label="Filter the Recycle Bin"></div>
        <ul class="binlist" id="b-list"></ul>
      </section>`;
    const $ = (s) => el.querySelector(s);
    async function load() {
      const v = car();
      ({ items } = await api(`/api/bin${scope === 'car' && v ? `?vehicle=${encodeURIComponent(v.id)}` : ''}`));
      for (const id of [...sel]) if (!items.some((i) => i.id === id)) sel.delete(id);
      draw();
    }
    function draw() {
      const v = car();
      const rows = items.filter((i) => !q || `${i.label} ${i.reason}`.toLowerCase().includes(q));
      const total = items.reduce((n, i) => n + i.bytes, 0);
      $('#b-sub').textContent = `${count(items.length, 'item')} · ${size(total)}${scope === 'car' && v ? ` · ${v.name}` : ' · every vehicle'}`;
      status(`${count(items.length, 'item')} · ${size(total)}`);
      $('#b-empty').disabled = !items.length;
      $('#b-restore').disabled = !sel.size;
      $('#b-all').checked = rows.length > 0 && rows.every((i) => sel.has(i.id));
      const name = (id) => app.vehicles.find((x) => x.id === id)?.name || id;
      paint($('#b-list'), rows.map((i) => `<li class="binit${sel.has(i.id) ? ' sel' : ''}" data-id="${h(i.id)}">
          <label class="chk"><input type="checkbox" aria-label="Select ${h(i.label)}"${sel.has(i.id) ? ' checked' : ''}></label>
          <div class="bin-main"><b>${h(i.label)}</b><span class="small dim">${count(i.files?.length || 0, 'file')} · ${size(i.bytes)} · moved ${h(stampFull(i.trashedAt))}${scope === 'all' ? ` · ${h(name(i.vehicleId))}` : ''}</span>
            ${(i.files || []).some((f) => f.conflict) ? '<span class="small warm">Some files could not be restored: the name is taken.</span>' : ''}</div>
          ${pill(i.reason === 'policy' ? 'by policy' : 'by you', i.reason === 'policy' ? 'mag' : '')}
          <div class="row bin-acts"><button class="btn sm" type="button" data-restore>${ico('refresh')}Restore</button><button class="btn sm danger" type="button" data-del>${ico('x')}Delete forever</button></div></li>`).join('') || `<li>${blank(items.length ? 'Nothing matches.' : 'The Recycle Bin is empty.')}</li>`);
    }
    async function restore(ids) {
      let done = 0;
      let clash = 0;
      for (const id of ids) {
        try {
          const out = await api(`/api/bin/${encodeURIComponent(id)}/restore`, { body: {} });
          done++;
          clash += out.conflicts || 0;
        } catch (err) { toast(err.message, 'bad'); }
      }
      if (done) toast(clash ? `Restored ${done}; ${clash} file(s) could not be (name taken).` : `Restored ${count(done, 'item')}.`, clash ? 'bad' : 'ok');
      ids.forEach((id) => sel.delete(id));
      await loadCars().catch(() => {});
      await load();
    }
    $('#b-list').addEventListener('click', async (e) => {
      const li = e.target.closest('li[data-id]');
      if (!li) return;
      const id = li.dataset.id;
      const item = items.find((i) => i.id === id);
      if (e.target.matches('input[type=checkbox]')) { if (e.target.checked) sel.add(id); else sel.delete(id); draw(); return; }
      if (e.target.closest('[data-restore]')) { await act(e.target.closest('button'), () => restore([id])); return; }
      if (e.target.closest('[data-del]')) {
        if (!(await ask({ title: 'Delete forever?', body: `<p><b>${h(item.label)}</b> (${size(item.bytes)}) is deleted from the share for good. This cannot be undone.</p>`, yes: 'Delete forever', danger: true }))) return;
        await act(null, async () => { await api(`/api/bin/${encodeURIComponent(id)}/delete`, { body: { confirm: true } }); toast('Deleted.'); });
        await loadCars().catch(() => {});
        await load();
      }
    });
    $('#b-all').onchange = (e) => { items.filter((i) => !q || `${i.label} ${i.reason}`.toLowerCase().includes(q)).forEach((i) => (e.target.checked ? sel.add(i.id) : sel.delete(i.id))); draw(); };
    $('#b-restore').onclick = (e) => act(e.currentTarget, () => restore([...sel]));
    $('#b-empty').onclick = async () => {
      const v = scope === 'car' ? car() : null;
      const total = items.reduce((n, i) => n + i.bytes, 0);
      if (!(await ask({ title: 'Empty the Recycle Bin?', body: `<p>${count(items.length, 'item')} (<b>${size(total)}</b>) of ${h(v ? v.name : 'every vehicle')} are deleted for good. This cannot be undone.</p>`, yes: 'Empty Recycle Bin', danger: true }))) return;
      await act($('#b-empty'), async () => {
        const out = await api('/api/bin/empty', { body: { confirm: true, vehicle: v?.id || null } });
        toast(`Deleted ${count(out.deleted, 'item')} (${size(out.bytes)}).`, out.failed ? 'bad' : 'ok');
      });
      await loadCars().catch(() => {});
      await load();
    };
    onSegs(el, 'bs', (x) => { scope = x; load(); });
    $('#b-q').addEventListener('input', debounce((e) => { q = e.target.value.toLowerCase(); draw(); }, 120));
    await load();
    return { onTopics(t) { if (t.includes('bin')) load().catch(() => {}); }, onCar() { load().catch(() => {}); } };
  }
};
