// Cleanup rules (retention policies): how long to keep each kind of footage.

import { api, esc, enc, icon, bytes, plural, when, emptyState, confirmDialog, toast, fail, busy, CATEGORY } from '../core.js';
import { vehicle, setVehicle, vehiclePicker } from '../state.js';

const CATS = ['Recent', 'Sentry', 'Saved', 'Other'];
const PRESETS = [['', 'Keep forever'], ['7', '1 week'], ['14', '2 weeks'], ['30', '1 month'], ['60', '2 months'], ['90', '3 months'], ['180', '6 months'], ['365', '1 year']];

export async function render(ctx) {
  const { view } = ctx;
  const v = vehicle();
  if (!v) {
    view.innerHTML = `<div class="page"><div class="page-head"><div><h1>Cleanup rules</h1></div></div>${emptyState({ art: 'rules', title: 'Add a vehicle first', text: 'Cleanup rules work per vehicle.', action: '<a class="btn btn-primary" href="#/settings/add-vehicle">Add my vehicle</a>' })}</div>`;
    return;
  }
  let { policy, preview } = await api(`/api/vehicles/${enc(v.id)}/policy`);
  if (!ctx.alive()) return;

  const daySelect = (c) => {
    const val = policy.keepDays[c] === null || policy.keepDays[c] === undefined ? '' : String(policy.keepDays[c]);
    const known = PRESETS.some(([k]) => k === val);
    return `<label class="field"><span>${esc((CATEGORY[c] || CATEGORY.Other).many)}</span>
      <select class="input" name="keep-${c}">${PRESETS.map(([k, t]) => `<option value="${k}"${k === val ? ' selected' : ''}>${k ? `Keep for ${t}` : t}</option>`).join('')}${known ? '' : `<option value="${esc(val)}" selected>Keep for ${esc(val)} days</option>`}<option value="custom">Another number of days…</option></select></label>`;
  };
  const draw = () => {
    view.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>Cleanup rules</h1><p class="lede">Keep footage for as long as you like. Older recordings move to the Recycle Bin once a day; protected ones always stay, and nothing is ever deleted by a rule.</p></div>
        <div class="head-actions">${vehiclePicker()}</div></div>
      <form class="card stack" id="pol">
        <label class="switch"><input type="checkbox" name="enabled"${policy.enabled ? ' checked' : ''}><span>Tidy up ${esc(v.name)}’s footage every day</span></label>
        <div class="form-grid">${CATS.map(daySelect).join('')}
          <label class="field"><span>At what time</span><input class="input" type="time" name="runAt" value="${esc(policy.runAt || '03:30')}"><span class="hint">The server’s time</span></label></div>
        <div class="note ${preview.recordings ? 'note-warn' : 'note-good'}">${icon(preview.recordings ? 'info' : 'checkCircle')}<span>${preview.recordings ? `With these rules, the next run moves <b>${plural(preview.recordings, 'recording')}</b> (${bytes(preview.bytes)}) to the Recycle Bin.` : 'With these rules, nothing would be moved right now.'}
          ${policy.lastRunAt ? `<br><span class="muted small">Last run ${esc(when(policy.lastRunAt))}: ${policy.lastResult?.error ? esc(policy.lastResult.error) : `${policy.lastResult?.moved ?? 0} moved, ${policy.lastResult?.skipped ?? 0} kept`}.</span>` : ''}</span></div>
        <div class="row"><button class="btn btn-primary" type="submit">Save rules</button><button class="btn" type="button" id="run">${icon('play')} Run now</button></div>
      </form></div>`;
    wire();
  };
  const read = () => {
    const f = new FormData(view.querySelector('#pol'));
    return {
      enabled: f.get('enabled') === 'on',
      runAt: f.get('runAt') || '03:30',
      keepDays: Object.fromEntries(CATS.map((c) => { const x = f.get(`keep-${c}`); return [c, x && x !== 'custom' ? Number(x) : null]; }))
    };
  };
  const save = async () => {
    const out = await api(`/api/vehicles/${enc(v.id)}/policy`, { method: 'PUT', body: read() });
    policy = out.policy;
    preview = out.preview;
  };
  const wire = () => {
    view.querySelector('#vehicle-pick')?.addEventListener('change', (e) => { setVehicle(e.target.value); ctx.rerender(); });
    view.querySelectorAll('select[name^="keep-"]').forEach((s) => {
      s.addEventListener('change', async () => {
        if (s.value !== 'custom') return;
        const { promptDialog } = await import('../core.js');
        const n = await promptDialog({ title: 'Keep for how many days?', label: 'Days (1 to 3650)', type: 'number', value: '45', ok: 'Use it' });
        const days = Math.round(Number(n));
        const c = s.name.slice(5);
        if (n !== null && days >= 1 && days <= 3650) policy.keepDays[c] = days;
        draw();
      });
    });
    view.querySelector('#pol').onsubmit = (e) => {
      e.preventDefault();
      busy(e.submitter, async () => {
        try { await save(); toast('Rules saved.', { kind: 'good' }); draw(); } catch (err) { fail(err); }
      });
    };
    view.querySelector('#run').onclick = (e) => busy(e.currentTarget, async () => {
      try {
        await save();
        draw();
        if (!preview.recordings) return toast('Nothing needs moving right now.');
        if (!(await confirmDialog({ title: 'Run the rules now?', body: `<p>${plural(preview.recordings, 'recording')} (${bytes(preview.bytes)}) will move to the Recycle Bin. You can restore them from there.</p>`, ok: 'Run now' }))) return undefined;
        const out = await api(`/api/vehicles/${enc(v.id)}/policy/run`, { body: {} });
        toast(`${plural(out.moved?.length ?? 0, 'recording')} moved to the Recycle Bin.`, { kind: 'good' });
        ({ policy, preview } = await api(`/api/vehicles/${enc(v.id)}/policy`));
        draw();
      } catch (err) { fail(err); }
      return undefined;
    });
  };
  draw();
}
