// Jobs: the pit log. Scans, conversions, Recycle Bin moves and policy runs, each
// with a status lamp, newest first.
import { h, ico, api, app, car, span, stampFull, wh, watt, cash, count, toast, ask, act, segs, onSegs, ok, debounce, blank, paint } from '../core.js';

const LAMP = { done: 'grn', failed: 'red', running: 'cyan', cancelled: '', interrupted: 'org' };

export default {
  async mount(el, { params, status }) {
    let show = 'all';
    let scope = 'car';
    let q = '';
    let list = [];
    el.innerHTML = `<section class="ptitle hud"><div><h1 class="chrome">Jobs</h1><p id="j-sub">The pit log: scans, conversions, Recycle Bin moves and policy runs.</p></div>
        <div class="pacts"><button class="btn" type="button" id="j-clear">${ico('bin')}Clear finished…</button></div></section>
      <section class="panel hud">
        <div class="row" style="margin-bottom:12px">${segs('js', [['all', 'All'], ['running', 'Running'], ['done', 'Done'], ['failed', 'Failed'], ['other', 'Stopped']], show, 'Status')}
          ${segs('jsc', [['car', 'This vehicle'], ['all', 'Every vehicle']], scope, 'Vehicles')}
          <input class="in grow" type="search" id="j-q" placeholder="Filter jobs" aria-label="Filter jobs"></div>
        <ol class="pitlog" id="j-list"></ol>
      </section>`;
    const $ = (s) => el.querySelector(s);
    async function load() {
      const v = car();
      ({ jobs: list } = await api(`/api/jobs${scope === 'car' && v ? `?vehicle=${encodeURIComponent(v.id)}` : ''}`));
      draw();
    }
    function draw() {
      const v = car();
      const rows = list.filter((j) => (show === 'all' || (show === 'other' ? ['cancelled', 'interrupted'].includes(j.status) : j.status === show)) && (!q || `${j.title} ${j.type} ${j.detail || ''} ${j.status}`.toLowerCase().includes(q)));
      const running = list.filter((j) => j.status === 'running').length;
      $('#j-sub').textContent = `${count(list.length, 'job')} · ${running} running${scope === 'car' && v ? ` · ${v.name} and jobs of no vehicle` : ' · every vehicle'}`;
      status(`${running} running · ${count(list.length, 'job')}`);
      const cur = app.power?.currency || '$';
      paint($('#j-list'), rows.map((j) => {
        const took = j.status === 'interrupted' ? '—' : j.finishedAt ? span(j.finishedAt - j.startedAt) : span(Date.now() - j.startedAt);
        return `<li class="pit ${LAMP[j.status] || ''}"><span class="pit-lamp" aria-hidden="true"></span>
          <div class="pit-main"><b>${h(j.title)}</b><span class="small dim wrap-any">${h(j.detail || '')}</span><span class="tiny faint mono">${h(j.type)} · #${h(j.id)}</span></div>
          <div class="pit-meta"><span class="pill ${LAMP[j.status] || ''}">${j.status === 'running' ? '<span class="spin sm" aria-hidden="true"></span>' : ''}${h(j.status)}</span>
            <span class="small num">${h(stampFull(j.startedAt))}</span><span class="small num dim">took ${h(took)}</span>
            ${ok(j.energy?.wh) ? `<span class="small num faint">${wh(j.energy.wh)}${ok(j.energy.avgW) ? ` · ${watt(j.energy.avgW)}` : ''}${ok(j.energy.cost) ? ` · ${cash(j.energy.cost, cur)}` : ''}</span>` : ''}</div></li>`;
      }).join('') || `<li>${blank(list.length ? 'No job matches.' : 'No jobs yet. Scans, conversions, Recycle Bin moves and policy runs show up here.')}</li>`);
      $('#j-clear').disabled = !list.some((j) => j.status !== 'running');
    }
    async function clear() {
      const v = scope === 'car' ? car() : null;
      let pv;
      try { pv = await api('/api/jobs/clear', { body: { vehicle: v?.id || null, preview: true } }); } catch (err) { toast(err.message, 'bad'); return; }
      if (!pv.jobs) { toast('Nothing to clear: running, waiting and paused jobs stay.'); return; }
      if (!(await ask({ title: 'Clear finished jobs?', body: `<p><b>${count(pv.jobs, 'finished job')}</b> (done, failed, cancelled or interrupted)${v ? ` of ${h(v.name)}` : ''} leave the list. Running, waiting and paused ones stay.</p><p class="dim">Only the list changes: footage, converted files and what a paused conversion needs are untouched.</p>`, yes: 'Clear jobs' }))) return;
      await act($('#j-clear'), async () => {
        const out = await api('/api/jobs/clear', { body: { vehicle: v?.id || null, confirm: true } });
        toast(`Cleared ${count(out.cleared, 'job')}.`);
      });
      await load();
    }
    onSegs(el, 'js', (x) => { show = x; draw(); });
    onSegs(el, 'jsc', (x) => { scope = x; load(); });
    $('#j-q').addEventListener('input', debounce((e) => { q = e.target.value.toLowerCase(); draw(); }, 120));
    $('#j-clear').onclick = clear;
    await load();
    const tick = setInterval(() => { if (list.some((j) => j.status === 'running')) draw(); }, 1000);
    if (params.get('clear')) setTimeout(clear, 50);
    return {
      unmount() { clearInterval(tick); },
      onTopics(t) { if (t.includes('jobs')) load().catch(() => {}); },
      onCar() { load().catch(() => {}); }
    };
  }
};
