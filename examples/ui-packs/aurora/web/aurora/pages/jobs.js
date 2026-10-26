// Jobs: what the server did and is doing, as a timeline. Clear takes the
// finished ones off the list (after a confirmation with how many).

import { $, esc, icon, api, state, plural, whenFull, dur, energy, watts, money, fin, toast, confirmDialog, empty, emit, store } from '../core.js';

const STATUS = { running: ['amber', 'Running'], done: ['green', 'Done'], failed: ['red', 'Failed'], cancelled: ['', 'Cancelled'], interrupted: ['', 'Interrupted'] };

export default {
  title: 'Jobs',
  kicker: 'Timeline',
  icon: 'jobs',
  topics: ['jobs'],
  async mount(ctx) {
    const { body, actions } = ctx;
    let dead = false;
    let scope = store.get('jobs-scope', 'all');
    if (scope !== 'all' && !state.vehicles.some((v) => v.id === scope)) scope = 'all';
    actions.innerHTML = `${state.vehicles.length > 1 ? `<label class="veh-pick"><span class="sr-only">Vehicle</span>${icon('car')}<select class="input" id="j-scope"><option value="all">All vehicles</option>${state.vehicles.map((v) => `<option value="${esc(v.id)}"${v.id === scope ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>` : ''}<button class="btn" type="button" id="j-clear">${icon('x')} Clear finished</button>`;

    async function load() {
      const { jobs } = await api(`/api/jobs${scope === 'all' ? '' : `?vehicle=${encodeURIComponent(scope)}`}`);
      if (dead) return;
      const running = jobs.filter((j) => j.status === 'running');
      emit('jobs-running', { running: running.length, converting: running.some((j) => j.type === 'conversion') });
      $('#j-clear', actions).disabled = !jobs.some((j) => j.status !== 'running');
      ctx.sub(jobs.length ? `${plural(jobs.length, 'job')}${running.length ? ` · ${running.length} running` : ''}` : '');
      const name = (id) => state.vehicles.find((v) => v.id === id)?.name || '';
      const cur = state.power?.currency || '$';
      body.innerHTML = jobs.length ? `<ol class="timeline">${jobs.map((j) => {
        const [chip, word] = STATUS[j.status] || ['', j.status];
        const took = j.status === 'interrupted' ? '' : j.finishedAt ? dur(j.finishedAt - j.startedAt) : 'running…';
        const e = j.energy;
        return `<li class="${esc(j.status)}"><div class="tl-top"><b>${esc(j.title)}</b><span class="chip ${chip}">${esc(word)}</span></div>
          ${j.detail ? `<p class="small" style="color:var(--ink-2)">${esc(j.detail)}</p>` : ''}
          <p class="muted tiny">${esc(j.type)}${j.vehicleId && name(j.vehicleId) ? ` · ${esc(name(j.vehicleId))}` : ''} · ${esc(whenFull(j.startedAt))}${took ? ` · ${esc(took)}` : ''}${e && fin(e.wh) ? ` · ${energy(e.wh)}${fin(e.avgW) ? `, avg ${watts(e.avgW)}` : ''}${fin(e.cost) ? `, ${money(e.cost, cur)}` : ''}` : ''}</p></li>`;
      }).join('')}</ol>` : empty('No jobs yet', 'Scans, conversions, Recycle Bin moves and policy runs show up here.');
    }

    actions.addEventListener('change', (e) => {
      if (e.target.id !== 'j-scope') return;
      scope = e.target.value;
      store.set('jobs-scope', scope);
      load();
    });
    $('#j-clear', actions).addEventListener('click', async () => {
      const req = { vehicle: scope === 'all' ? null : scope };
      let pre;
      try { pre = await api('/api/jobs/clear', { body: { ...req, preview: true } }); } catch (err) { toast(err.message, 'bad'); return; }
      if (!pre.jobs) { toast('Nothing to clear: running, waiting and paused jobs stay.'); return; }
      if (!(await confirmDialog({
        title: 'Clear finished jobs?',
        body: `<p>${plural(pre.jobs, 'finished job')} (done, failed, cancelled or interrupted) leave${pre.jobs === 1 ? 's' : ''} the list. Running, waiting and paused jobs stay.</p><p class="muted">Only the list changes: footage, converted files and what a paused conversion needs to resume are untouched.</p>`,
        ok: 'Clear jobs'
      }))) return;
      try {
        const out = await api('/api/jobs/clear', { body: { ...req, confirm: true } });
        toast(`Cleared ${plural(out.cleared, 'finished job')}.`);
      } catch (err) { toast(err.message, 'bad'); }
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
