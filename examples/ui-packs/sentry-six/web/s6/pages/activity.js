import { ownedRender } from '../core.js';
import { esc, act } from '../core.js';
import { describeJob, jobProgress } from '../jobs.js';
import { plural, dayLabel, dayKey, timeLabel, duration, size } from '../format.js';
import { icon } from '../icons.js';
import { follow, counts, ACTIVE, PAUSED, Pace, workingMs, hardwareLabel } from '../convert.js';
async function renderPage(el, ctx) {
  const { api, confirmDialog, toast, invoke } = ctx.scope;
  const { current, state, alive } = ctx;
  const admin = (await api('/api/auth/me')).role === 'admin';
  const v = current();
  let stopped = false,
    busy = false,
    jobs = [],
    speed = {},
    snapshot = null,
    encoder = null;
  const pace = new Pace(),
    valid = () => alive() && !stopped;
  function draw() {
    if (!valid()) return;
    const running = jobs.filter((j) => ['running', 'waiting', 'paused'].includes(j.status)),
      history = jobs.filter((j) => !running.includes(j));
    const mine =
      snapshot &&
      v &&
      (snapshot.config?.vehicleId === v.id ||
        [v.root, v.studioRoot].includes(snapshot.config?.sourceRoot)) &&
      ACTIVE.has(snapshot.state)
        ? snapshot
        : null;
    const c = mine ? counts(mine) : null,
      p = mine ? pace.read(mine) : null;
    const hardware = mine ? hardwareLabel(mine, encoder) : '';
    const row = (j) => {
      const d = describeJob(j),
        progress = jobProgress(j);
      return `<article class="card row">${d.status === 'running' && !progress ? '<span class="spinner" aria-label="Running"></span>' : icon(d.icon)}<div class="grow"><h3>${esc(d.title)}</h3><p class="${d.status === 'failed' ? 'bad' : ''}">${esc(d.outcome)}</p>${Number.isFinite(j.energy?.wh) ? `<p>${j.energy.wh < 1000 ? j.energy.wh.toFixed(1) + ' Wh' : (j.energy.wh / 1000).toFixed(1) + ' kWh'}${Number.isFinite(j.energy.avgW) ? ' · average ' + Math.round(j.energy.avgW) + ' W' : ''}${Number.isFinite(j.energy.cost) ? ' · about ' + esc(state.power?.currency || '$') + j.energy.cost.toFixed(2) : ''}</p>` : ''}${progress ? `<progress max="100" value="${progress.pct}" aria-label="Export progress"></progress><p>${esc(progress.text)} rendered · ${progress.pct}%</p>` : ''}</div><div><span class="${d.status === 'failed' ? 'bad' : ''}">${esc(d.statusText)}</span><p><time>${timeLabel(j.startedAt, state.h24)}</time>${j.finishedAt ? ' · ' + duration((j.finishedAt - j.startedAt) / 60000) : ''}</p></div></article>`;
    };
    const groups = new Map();
    for (const j of history) {
      const day = dayKey(new Date(j.startedAt || Date.now()));
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(j);
    }
    el.innerHTML = `<div class="toolbar"><span class="grow"></span>${admin ? `<button data-clear ${!history.length ? 'disabled' : ''}>Clear finished</button>` : ''}</div>${running.length || mine || speed.running ? '<h2>Now</h2>' : '<p>Nothing running right now</p>'}${mine ? `<section class="card"><h3>Converting ${esc(v.name)}</h3><p>${esc(hardware || 'Preparing the encoder')} · started ${timeLabel(mine.createdAt, state.h24)}</p>${c.total ? `<progress value="${c.done}" max="${c.total}" aria-label="Conversion progress"></progress><p>${Number(c.done || 0).toLocaleString()} of ${plural(c.total, 'clip')} · ${Math.round((100 * c.done) / c.total)}%</p>` : '<p>Looking for clips…</p>'}${p.leftMs != null ? `<p>About ${duration(p.leftMs / 60000)} left</p>` : ''}${Number.isFinite(mine.counters?.savedBytes) ? `<p>${size(mine.counters.savedBytes)} saved so far</p>` : ''}${p.perMinute ? `<p>${p.perMinute.toFixed(1)} clips/min</p>` : ''}${mine.discoveryComplete === false ? '<p>Still looking for clips; the total may grow.</p>' : ''}<div class="row">${admin ? `<button data-command="${PAUSED.has(mine.state) ? 'resume' : 'pause'}">${PAUSED.has(mine.state) ? 'Resume' : 'Pause'}</button><button data-command="cancel">Stop</button>` : ''}<a href="#/encoder">Open Encoder</a></div></section>` : ''}${speed.running ? `<section class="card"><h3>Indexing speed data</h3>${speed.total ? `<progress value="${speed.done}" max="${speed.total}"></progress><p>${Number(speed.done || 0).toLocaleString()} of ${plural(speed.total, 'clip')} read</p>` : '<p>Reading clips…</p>'}${speed.day ? `<p>Working on ${dayLabel(speed.day)}</p>` : ''}</section>` : ''}${running
      .filter((j) => !mine || j.type !== 'conversion')
      .map(row)
      .join(
        '',
      )}${[...groups].map(([day, list]) => `<h2>${dayLabel(day)}</h2>${list.map(row).join('')}`).join('')}`;
    el.onclick = act(async (e) => {
      const b = e.target.closest('button');
      if (!b || !admin) return;
      if (b.hasAttribute('data-clear')) {
        const body = v ? { vehicle: v.id } : {};
        const preview = await api('/api/jobs/clear', {
          body: { ...body, preview: true },
        });
        if (!preview.jobs) return;
        if (
          !(await confirmDialog({
            title: 'Clear finished jobs?',
            body: `<p>${plural(preview.jobs, 'finished job')} leave the list. Running, waiting and paused jobs stay. Footage, converted files and the Encoder's recovery records are not touched.</p>`,
            ok: 'Clear finished',
          }))
        )
          return;
        await api('/api/jobs/clear', { body: { ...body, confirm: true } });
        await load();
      }
      if (b.dataset.command && mine) {
        if (
          b.dataset.command === 'cancel' &&
          !(await confirmDialog({
            title: 'Stop converting?',
            body: '<p>Finished clips stay converted. Clips in progress stop at a safe point.</p>',
            ok: 'Stop',
            danger: true,
          }))
        )
          return;
        await invoke(b.dataset.command, { jobId: mine.id });
      }
    });
  }
  async function load() {
    if (!valid() || busy) return;
    busy = true;
    try {
      const [j, s, stats] = await Promise.all([
        api('/api/jobs' + (v ? '?vehicle=' + encodeURIComponent(v.id) : '')),
        api('/api/speeds/status'),
        api('/api/stats').catch(() => ({})),
      ]);
      // The server includes this vehicle's jobs and shared server jobs.
      jobs = j.jobs || [];
      speed = s;
      encoder = stats.encoder;
      draw();
    } catch (e) {
      toast(e.message, true);
    } finally {
      busy = false;
    }
  }
  await load();
  if (!valid()) return () => {};
  const stop = follow((s) => {
      snapshot = s;
      draw();
    }, ctx.scope),
    timer = setInterval(load, 5000);
  return () => {
    stopped = true;
    stop();
    clearInterval(timer);
  };
}

export const render = ownedRender(renderPage);
