// Jobs: scans, conversions, Recycle Bin moves and policy runs.
import { esc, api, state, current, dur, isoish, energy, watts, money, plural, icon, toast, confirmDialog, busy, fin, debounce } from '../core.js';
import { seg, wireSeg, chip, empty } from '../ui.js';

const TONE = { done: 'green', failed: 'red', running: 'cyan', cancelled: '', interrupted: 'amber' };

export default {
  async mount(el, { params }) {
    let filter = 'all';
    let text = '';
    let scope = 'vehicle';
    let list = [];
    el.innerHTML = `<div class="phead"><div><h1>Jobs</h1><p class="muted small" id="jobs-sub"></p></div>
      <div class="phead-actions"><button class="btn" type="button" id="jobs-clear">Clear finished…</button></div></div>
      <div class="toolbar wrap">${seg('jst', [['all', 'All'], ['running', 'Running'], ['done', 'Done'], ['failed', 'Failed'], ['other', 'Cancelled / interrupted']], 'all', 'Status')}
        ${seg('jscope', [['vehicle', 'This vehicle'], ['all', 'Every vehicle']], scope, 'Vehicles')}
        <input class="input grow" type="search" data-filter id="jobs-text" placeholder="Filter jobs  ( / )" aria-label="Filter jobs"></div>
      <div class="card flush"><div class="tscroll"><table class="dtable stack" id="jobs-table"></table></div></div>`;
    const $ = (s) => el.querySelector(s);
    async function load() {
      const v = current();
      const q = scope === 'vehicle' && v ? `?vehicle=${encodeURIComponent(v.id)}` : '';
      ({ jobs: list } = await api(`/api/jobs${q}`));
      draw();
    }
    function draw() {
      const v = current();
      const rows = list.filter((j) => (filter === 'all' || (filter === 'other' ? ['cancelled', 'interrupted'].includes(j.status) : j.status === filter))
        && (!text || `${j.title} ${j.type} ${j.detail || ''} ${j.status}`.toLowerCase().includes(text)));
      const running = list.filter((j) => j.status === 'running').length;
      $('#jobs-sub').textContent = `${plural(list.length, 'job')} · ${running} running${scope === 'vehicle' && v ? ` · ${v.name} and jobs of no vehicle` : ''}`;
      const withEnergy = list.some((j) => fin(j.energy?.wh));
      const cur = state.power?.currency || '$';
      $('#jobs-table').innerHTML = `<thead><tr><th>job</th><th>status</th><th>details</th><th>started</th><th class="r">took</th>${withEnergy ? '<th class="r">energy</th>' : ''}</tr></thead><tbody>
        ${rows.map((j) => `<tr><td><b>${esc(j.title)}</b><div class="faint small mono">${esc(j.type)} · #${esc(j.id)}</div></td>
          <td>${j.status === 'running' ? `<span class="chip cyan"><i class="spin" aria-hidden="true"></i>running</span>` : chip(j.status, TONE[j.status] || '')}</td>
          <td class="small wrap">${esc(j.detail || '')}</td><td class="num small nowrap">${esc(isoish(j.startedAt))}</td>
          <td class="r num">${j.status === 'interrupted' ? '—' : j.finishedAt ? dur(j.finishedAt - j.startedAt) : dur(Date.now() - j.startedAt)}</td>
          ${withEnergy ? `<td class="r num small">${fin(j.energy?.wh) ? `${energy(j.energy.wh)}${fin(j.energy.avgW) ? ` · ${watts(j.energy.avgW)}` : ''}${fin(j.energy.cost) ? ` · ${money(j.energy.cost, cur)}` : ''}` : ''}</td>` : ''}</tr>`).join('') || `<tr><td colspan="6">${empty(list.length ? 'No job matches.' : 'No jobs yet. Scans, conversions, Recycle Bin moves and policy runs show up here.')}</td></tr>`}</tbody>`;
      $('#jobs-clear').disabled = !list.some((j) => j.status !== 'running');
    }
    async function clearJobs() {
      const v = scope === 'vehicle' ? current() : null;
      const body = { vehicle: v?.id || null };
      let preview;
      try { preview = await api('/api/jobs/clear', { body: { ...body, preview: true } }); } catch (err) { toast(err.message, 'bad'); return; }
      if (!preview.jobs) { toast('Nothing to clear: running, waiting and paused jobs stay.'); return; }
      if (!(await confirmDialog({ title: 'Clear finished jobs?', body: `<p><b>${plural(preview.jobs, 'finished job')}</b> (done, failed, cancelled or interrupted)${v ? ` of ${esc(v.name)}` : ''} leave the list. Running, waiting and paused ones stay.</p><p class="muted">Only the list changes: footage, converted files and what a paused conversion needs are untouched.</p>`, ok: 'Clear jobs' }))) return;
      await busy($('#jobs-clear'), async () => {
        const out = await api('/api/jobs/clear', { body: { ...body, confirm: true } });
        toast(`Cleared ${plural(out.cleared, 'job')}.`);
      });
      await load();
    }
    wireSeg(el, 'jst', (x) => { filter = x; draw(); });
    wireSeg(el, 'jscope', (x) => { scope = x; load(); });
    $('#jobs-text').addEventListener('input', debounce((e) => { text = e.target.value.toLowerCase(); draw(); }, 100));
    $('#jobs-clear').onclick = clearJobs;
    await load();
    const tick = setInterval(() => { if (list.some((j) => j.status === 'running')) draw(); }, 1000);
    if (params.get('clear')) setTimeout(clearJobs, 50);
    return {
      unmount() { clearInterval(tick); },
      onTopics(t) { if (t.includes('jobs')) load().catch(() => {}); },
      onVehicle() { load().catch(() => {}); },
      commands: () => [{ group: 'Jobs', label: 'Clear finished jobs', icon: 'jobs', run: clearJobs }]
    };
  }
};
