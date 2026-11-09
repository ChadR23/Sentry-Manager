// Cleanup rules (retention policies): how long to keep each kind of footage.

// Per car (Encoding per vehicle) is its sub-tab (Cleanup rules | Per car, web/subTabs.js): #/policies/<tab>,
// each the page module it always was, taken down with the page.
import { pickSubTab, subTabsHtml } from '/web/subTabs.js';
import * as perCar from './vehicles.js';
import { api, esc, enc, icon, bytes, plural, when, emptyState, confirmDialog, toast, fail, busy, CATEGORY } from '../core.js';
import { vehicle, setVehicle, vehiclePicker } from '../state.js';

const CATS = ['Recent', 'Sentry', 'Saved', 'Other'];
const PRESETS = [['', 'Keep forever'], ['7', '1 week'], ['14', '2 weeks'], ['30', '1 month'], ['60', '2 months'], ['90', '3 months'], ['180', '6 months'], ['365', '1 year']];

async function renderRetention(ctx) {
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
      <div class="page-head"><div><h1>Cleanup rules</h1><p class="lede">Keep footage for as long as you like. Older recordings move to the Recycle Bin once a day; protected ones always stay, and nothing is deleted for good unless you set the Recycle Bin to empty itself.</p></div>
        <div class="head-actions">${vehiclePicker()}</div></div>
      <form class="card stack" id="pol">
        <label class="switch"><input type="checkbox" name="enabled"${policy.enabled ? ' checked' : ''}><span>Tidy up ${esc(v.name)}’s footage every day</span></label>
        <div class="form-grid">${CATS.map(daySelect).join('')}
          <label class="field"><span>At what time</span><input class="input" type="time" name="runAt" value="${esc(policy.runAt || '03:30')}"><span class="hint">The server’s time</span></label>
          <label class="field"><span>Empty the Recycle Bin after</span><input class="input" type="number" inputmode="numeric" min="1" max="365" name="binDays" value="${esc(policy.binDays ?? '')}" placeholder="Never"><span class="hint">Days in the bin before it is deleted for good. Empty: only when you empty it.</span></label>
          <label class="field"><span>Keep the footage under</span><input class="input" type="number" inputmode="decimal" min="1" step="any" name="maxGB" value="${esc(policy.maxGB ?? '')}" placeholder="No limit"><span class="hint">GB. Past it, the oldest recordings move to the Recycle Bin (protected ones stay).</span></label></div>
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
      keepDays: Object.fromEntries(CATS.map((c) => { const x = f.get(`keep-${c}`); return [c, x && x !== 'custom' ? Number(x) : null]; })),
      binDays: f.get('binDays') ? Number(f.get('binDays')) : null,
      maxGB: f.get('maxGB') ? Number(f.get('maxGB')) : null
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

export const POLICY_TABS = [['retention', 'Cleanup rules', { render: renderRetention }], ['per-car', 'Per car', perCar]];

export async function render(ctx) {
  const tab = pickSubTab('sentry-policies-tab', POLICY_TABS.map(([k]) => k), ctx.params[0]);
  const [, , mod] = POLICY_TABS.find(([k]) => k === tab);
  ctx.view.innerHTML = `<div class="page subtab-bar">${subTabsHtml(POLICY_TABS, tab, { href: (k) => `#/policies/${k}`, label: 'Cleanup rules sections', cls: 'seg' })}</div><div data-subview></div>`;
  await mod.render({ ...ctx, view: ctx.view.querySelector('[data-subview]'), params: ctx.params.slice(1) });
}
