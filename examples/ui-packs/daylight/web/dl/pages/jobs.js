// Activity (jobs): scans, conversions, Recycle Bin moves and rule runs.

import { api, esc, enc, icon, plural, when, duration, chip, emptyState, confirmDialog, toast, fail, busy, fin, details } from '../core.js';
import { state, vehiclePicker, vehicleById, loadJobs } from '../state.js';

let filter = null;
const STATUS = { running: ['In progress', 'teal'], done: ['Done', 'good'], failed: ['Problem', 'bad'], cancelled: ['Stopped', 'grey'], interrupted: ['Interrupted', 'warn'] };
const TYPE = { scan: 'Looking for footage', conversion: 'Converting', trash: 'Moving to Recycle Bin', policy: 'Cleanup rules', restore: 'Restoring', delete: 'Deleting' };

const energyText = (e) => {
  if (!fin(e?.wh)) return '';
  const wh = e.wh < 1000 ? `${e.wh.toFixed(e.wh < 100 ? 1 : 0)} Wh` : `${(e.wh / 1000).toFixed(1)} kWh`;
  return `${wh}${fin(e.avgW) ? ` · average ${Math.round(e.avgW)} W` : ''}${fin(e.cost) ? ` · about ${state.power?.currency || '$'}${e.cost.toFixed(2)}` : ''}`;
};

export async function render(ctx) {
  const { view } = ctx;
  if (filter && !vehicleById(filter)) filter = null;
  let jobs = [];
  const load = async () => { jobs = (await api(`/api/jobs${filter ? `?vehicle=${enc(filter)}` : ''}`)).jobs; };
  await load();
  if (!ctx.alive()) return;
  const draw = () => {
    const running = jobs.filter((j) => j.status === 'running');
    const rest = jobs.filter((j) => j.status !== 'running');
    const row = (j) => {
      const [word, tone] = STATUS[j.status] || [j.status, 'grey'];
      const vname = state.vehicles.length > 1 && j.vehicleId ? vehicleById(j.vehicleId)?.name : '';
      return `<li class="list-item"><div class="grow"><div class="row-between"><b>${esc(j.title)}</b>${chip(word, tone, j.status === 'running' ? 'bolt' : j.status === 'done' ? 'check' : '')}</div>
        <p class="muted small" style="margin-top:4px">${esc(TYPE[j.type] || j.type)}${vname ? ` · ${esc(vname)}` : ''} · started ${esc(when(j.startedAt))}${j.finishedAt && j.status !== 'interrupted' ? ` · took ${duration(j.finishedAt - j.startedAt)}` : ''}</p>
        ${j.detail ? `<p class="small" style="margin-top:4px">${esc(j.detail)}</p>` : ''}
        ${energyText(j.energy) ? `<p class="small muted" style="margin-top:4px">${icon('bolt')} ${esc(energyText(j.energy))}</p>` : ''}</div></li>`;
    };
    view.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>Activity</h1><p class="lede">What the server has been doing for you.</p></div>
        <div class="head-actions">${state.vehicles.length > 1 ? vehiclePicker({ allowAll: true, selected: filter || '', id: 'jobs-vehicle' }) : ''}
          <button class="btn" type="button" id="clear"${rest.length ? '' : ' disabled'}>Clear finished</button></div></div>
      ${jobs.length ? `${running.length ? `<div class="card" style="margin-bottom:18px"><h2 style="margin-bottom:6px">Happening now</h2><ul class="list">${running.map(row).join('')}</ul></div>` : ''}
        ${rest.length ? `<div class="card"><h2 style="margin-bottom:6px">Earlier</h2><ul class="list">${rest.map(row).join('')}</ul></div>` : ''}`
        : emptyState({ art: 'activity', title: 'Nothing yet', text: 'Footage checks, conversions, Recycle Bin moves and cleanup rules show up here.' })}
    </div>`;
    view.querySelector('#jobs-vehicle')?.addEventListener('change', (e) => { filter = e.target.value || null; refresh(); });
    view.querySelector('#clear').onclick = (e) => busy(e.currentTarget, clear);
  };
  const refresh = async () => { try { await load(); } catch (err) { return fail(err); } if (ctx.alive()) draw(); return undefined; };
  const clear = async () => {
    const body = { vehicle: filter || null };
    let preview;
    try { preview = await api('/api/jobs/clear', { body: { ...body, preview: true } }); } catch (err) { return fail(err); }
    if (!preview.jobs) return toast('Nothing to clear. Running, waiting and paused jobs always stay.');
    const v = filter ? vehicleById(filter) : null;
    if (!(await confirmDialog({ title: 'Clear finished activity?', body: `<p>${plural(preview.jobs, 'finished job')}${v ? ` of ${esc(v.name)}` : ''} will leave this list. Running, waiting and paused ones stay.</p><p class="muted">Only the list changes: footage, converted files and anything a paused conversion needs are left alone.</p>`, ok: 'Clear' }))) return undefined;
    try {
      const out = await api('/api/jobs/clear', { body: { ...body, confirm: true } });
      toast(`Cleared ${plural(out.cleared, 'finished job')}.`, { kind: 'good' });
    } catch (err) { fail(err); }
    loadJobs().catch(() => {});
    return refresh();
  };
  draw();
  ctx.on('topics', (t) => { if (t.includes('jobs') && !document.querySelector('dialog[open]')) refresh(); });
}
