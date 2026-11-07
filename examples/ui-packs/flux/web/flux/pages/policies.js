// Policies: per-vehicle retention (keep N days per category), preview and run now.
import { esc, api, state, current, bytes, plural, when, icon, toast, confirmDialog, busy, liveDraw } from '../core.js';
import { empty, chip } from '../ui.js';

const CATS = ['Recent', 'Sentry', 'Saved', 'Other'];

export default {
  async mount(el) {
    const draw = async () => {
      if (!state.vehicles.length) {
        el.innerHTML = `<div class="phead"><div><h1>Policies</h1></div></div>${empty('Add a vehicle first.', '<a class="btn primary" href="#/settings/vehicles?add=1">Add a vehicle</a>')}`;
        return;
      }
      const all = await Promise.all(state.vehicles.map(async (v) => [v, await api(`/api/vehicles/${encodeURIComponent(v.id)}/policy`).catch((err) => ({ error: err.message }))]));
      const cur = current();
      el.innerHTML = `<div class="phead"><div><h1>Policies</h1><p class="muted small">Recordings older than the days you set move to the Recycle Bin once a day. Protected recordings are always skipped; nothing is deleted for good unless you set the Recycle Bin to empty itself. Empty means keep forever.</p></div></div>
        <div class="pol-grid">${all.map(([v, d]) => {
          if (d.error) return `<article class="card"><h2>${esc(v.name)}</h2><p class="bad-text">${esc(d.error)}</p></article>`;
          const p = d.policy;
          const pv = d.preview || {};
          return `<form class="card form-card pol${v.id === cur?.id ? ' current' : ''}" data-v="${esc(v.id)}">
            <header class="card-h"><h2>${esc(v.name)}</h2>${p.enabled ? chip('runs daily', 'green') : chip('off', '')}</header>
            <label class="check"><input type="checkbox" name="enabled"${p.enabled ? ' checked' : ''}> Run this policy every day</label>
            <div class="grid4">${CATS.map((c) => `<label class="field">Keep ${c} (days)<input class="input num" type="number" min="1" max="3650" name="keep-${c}" value="${p.keepDays?.[c] ?? ''}" placeholder="forever"></label>`).join('')}</div>
            <label class="field narrow">Run at (server time)<input class="input num" type="time" name="runAt" value="${esc(p.runAt || '03:30')}"></label>
            <label class="field narrow">Empty the Recycle Bin after (days)<input class="input num" type="number" min="1" max="365" name="binDays" value="${p.binDays ?? ''}" placeholder="never: you empty it"></label>
            <label class="field narrow">Keep the footage under (GB)<input class="input num" type="number" min="1" step="any" name="maxGB" value="${p.maxGB ?? ''}" placeholder="no limit"></label>
            <div class="note ${pv.recordings ? 'amber' : ''}">${pv.recordings ? `With the saved settings the next run moves <b>${plural(pv.recordings, 'recording')}</b> (<b class="num">${bytes(pv.bytes)}</b>) to the Recycle Bin.` : 'With the saved settings nothing would move right now.'}
              ${p.lastRunAt ? `<br><span class="small">Last run ${esc(when(p.lastRunAt))}: ${p.lastResult?.error ? esc(p.lastResult.error) : `${p.lastResult?.moved ?? 0} moved, ${p.lastResult?.skipped ?? 0} skipped`}.</span>` : ''}</div>
            <div class="row-actions"><button class="btn" type="button" data-run>${icon('play')}Run now…</button><button class="btn primary" type="submit">Save policy</button></div>
          </form>`;
        }).join('')}</div>`;
      el.querySelectorAll('form.pol').forEach((form) => {
        const id = form.dataset.v;
        const read = () => {
          const fd = new FormData(form);
          return { enabled: fd.get('enabled') === 'on', runAt: fd.get('runAt') || '03:30', keepDays: Object.fromEntries(CATS.map((c) => [c, fd.get(`keep-${c}`) ? Number(fd.get(`keep-${c}`)) : null])), binDays: fd.get('binDays') ? Number(fd.get('binDays')) : null, maxGB: fd.get('maxGB') ? Number(fd.get('maxGB')) : null };
        };
        form.onsubmit = (e) => {
          e.preventDefault();
          busy(form.querySelector('[type=submit]'), async () => {
            await api(`/api/vehicles/${encodeURIComponent(id)}/policy`, { method: 'PUT', body: read() });
            toast('Policy saved.');
            await draw();
          });
        };
        form.querySelector('[data-run]').onclick = (e) => busy(e.currentTarget, async () => {
          await api(`/api/vehicles/${encodeURIComponent(id)}/policy`, { method: 'PUT', body: read() });
          const d = await api(`/api/vehicles/${encodeURIComponent(id)}/policy`);
          if (!d.preview?.recordings) { toast('Nothing to move right now.'); await draw(); return; }
          if (!(await confirmDialog({ title: 'Run the policy now?', body: `<p>${plural(d.preview.recordings, 'recording')} (<b class="num">${bytes(d.preview.bytes)}</b>) move to the Recycle Bin. You can restore them from there.</p>`, ok: 'Run now' }))) return;
          const out = await api(`/api/vehicles/${encodeURIComponent(id)}/policy/run`, { body: {} });
          toast(`${plural(out.moved?.length ?? 0, 'recording')} moved to the Recycle Bin.`);
          await draw();
        });
      });
    };
    await draw();
    return {
      onTopics(t) {
        if ((t.includes('inventory') || t.includes('vehicles')) && !el.contains(document.activeElement)) liveDraw(el, draw);
      },
      onVehicle() { el.querySelector(`form.pol[data-v="${CSS.escape(current()?.id || '')}"]`)?.scrollIntoView({ block: 'start' }); }
    };
  }
};
