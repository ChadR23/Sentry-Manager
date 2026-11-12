import { ownedRender } from '../core.js';
import { esc, act } from '../core.js';
import { healthSummary } from '../status.js';
import { plural, dayKey, dayLabel, timeLabel, size, ago } from '../format.js';
import * as datepicker from './datepicker.js';
import { icon } from '../icons.js';
async function renderPage(el, ctx) {
  const { api, confirmDialog, confirmPassword, toast } = ctx.scope;
  const admin = (await api('/api/auth/me')).role === 'admin';
  if (!admin && ['logs', 'backups'].includes(ctx.sub)) {
    el.innerHTML =
      '<p>This page is available to administrators.</p><a href="#/health">Back to Health</a>';
    return;
  }
  if (ctx.sub === 'server') return (await ctx.scope.wait(import('./server.js'))).render(el, ctx);
  let stopped = false,
    timer;
  const alive = () => !stopped && ctx.alive();
  const stamp = (at) =>
    at
      ? `${dayLabel(dayKey(new Date(at)))} · ${timeLabel(Number(new Date(at)), ctx.state.h24)}`
      : 'not yet';
  const back = '<a class="back" href="#/health">‹ Health</a>';
  const check = (c) =>
    `<div class="health-check"><b class="${['fail', 'bad'].includes(c.status) ? 'bad' : c.status === 'warn' ? 'warn' : 'ok'}">${c.status === 'ok' ? '✓' : c.status === 'skip' ? '—' : '!'} ${esc(c.label || c.id)}</b>${c.detail ? `<p>${esc(c.detail)}</p>` : ''}${c.hint ? `<p>${esc(c.hint)}</p>` : ''}</div>`;
  if (ctx.sub === 'footage-check') {
    async function load() {
      const rows = await Promise.all(
        ctx.state.vehicles.map(async (v) => ({
          v,
          r: await api(`/api/vehicles/${encodeURIComponent(v.id)}/integrity`),
        })),
      );
      if (!alive()) return;
      el.innerHTML =
        back +
        '<h2>Footage check</h2><p>Find clips that will not play. Unchanged files are not read again, and interrupted checks resume where they stopped.</p>' +
        rows
          .map(
            ({ v, r }) =>
              `<section class="card"><div class="row"><h3 class="grow">${esc(v.name)}</h3>${admin ? `<button data-check="${esc(v.id)}" ${r.running ? 'disabled' : ''}>${r.running ? 'Checking…' : r.checked ? 'Check again' : 'Check now'}</button>` : ''}</div><p>${r.running ? `${r.done} of ${plural(r.total, 'file')} checked` : r.checked ? `${r.checked} of ${plural(r.files, 'file')} checked · ${plural((r.problems?.length || 0) + (r.more || 0), 'problem')}` : 'Not checked yet.'}</p>${(
                r.problems || []
              )
                .slice(0, 100)
                .map(
                  (p) =>
                    `<div class="health-check"><b>${dayLabel(p.day)}</b><p>${esc(p.rel)} · ${esc(p.problem)}</p></div>`,
                )
                .join(
                  '',
                )}${admin && r.more ? '<a href="/api/support-bundle">Download all results in a support bundle</a>' : ''}</section>`,
          )
          .join('');
      if (rows.some((x) => x.r.running))
        timer = setTimeout(() => load().catch((e) => toast(e.message, true)), 2000);
    }
    el.onclick = act(async (e) => {
      const b = e.target.closest('[data-check]');
      if (b && admin) {
        b.disabled = true;
        await api(`/api/vehicles/${encodeURIComponent(b.dataset.check)}/integrity`, {
          method: 'POST',
        });
        await load();
      }
    });
    await load();
  } else if (ctx.sub === 'logs') {
    let from = dayKey(new Date(Date.now() - 6 * 86400000)),
      to = dayKey();
    el.innerHTML =
      back +
      '<h2>Logs</h2><form class="toolbar"><button type="button" data-dates>Last 7 days</button><input name="q" type="search" aria-label="Search logs" placeholder="Search logs"><select name="level" aria-label="Level"><option value="info">Everything</option><option value="warn">Warnings and errors</option><option value="error">Errors only</option></select><button class="primary">Search</button><a data-download download>Download</a></form><div class="card log-lines" data-lines></div><a href="/api/support-bundle" download>Download a support bundle</a><p>Includes recent logs and setup with private paths, names, addresses and passwords masked.</p>';
    const query = () =>
      new URLSearchParams({
        from,
        to,
        q: el.querySelector('[name=q]').value,
        level: el.querySelector('[name=level]').value,
      });
    async function search() {
      const q = query();
      el.querySelector('[data-download]').href = '/api/logs/search?' + q + '&download=1';
      const d = await api('/api/logs/search?' + q);
      if (alive())
        el.querySelector('[data-lines]').innerHTML = d.lines.length
          ? d.lines
              .slice(0, 500)
              .map(
                (l) =>
                  `<div class="${l.level === 'error' ? 'bad' : l.level === 'warn' ? 'warn' : ''}">${esc(stamp(l.at))} ${esc(l.level)} [${esc(l.scope)}] ${esc(l.message)}</div>`,
              )
              .join('') + (d.lines.length > 500 ? '<p>Download for all matching lines.</p>' : '')
          : 'No lines match.';
    }
    el.querySelector('form').onsubmit = act(async (e) => {
      e.preventDefault();
      await search();
    });
    el.querySelector('[data-dates]').onclick = (e) =>
      datepicker.open(e.currentTarget, {
        from,
        to,
        onApply: (range) => {
          from = range.from;
          to = range.to;
          el.querySelector('[data-dates]').textContent =
            from || to
              ? `${from ? dayLabel(from) : 'Any time'} – ${to ? dayLabel(to) : 'Now'}`
              : 'Any date';
          search().catch((e) => toast(e.message, true));
        },
      });
    await search();
  } else if (ctx.sub === 'backups') {
    async function load() {
      const d = await api('/api/snapshots');
      if (!alive()) return;
      el.innerHTML =
        back +
        '<div class="row"><h2 class="grow">Backups</h2><button data-make>Make one now</button></div><p>A daily copy of accounts, vehicles, settings, cleanup rules and starred moments. The newest seven are kept. Footage is not touched.</p><section class="card">' +
        (d.snapshots
          .map(
            (s) =>
              `<div class="row health-check"><div class="grow"><b>${dayLabel(s.day)}</b><p>${size(s.bytes)}</p></div><button data-restore="${esc(s.name)}">Restore…</button></div>`,
          )
          .join('') || '<p>No snapshots yet.</p>') +
        '</section>';
    }
    el.onclick = act(async (e) => {
      const b = e.target.closest('[data-restore]');
      if (e.target.closest('[data-make]')) {
        await api('/api/snapshots', { method: 'POST' });
        await load();
      }
      if (
        b &&
        (await confirmDialog({
          title: 'Restore this backup?',
          body: '<p>Changes since then (accounts, settings, stars) are lost. Footage is not touched. The app will restart.</p>',
          ok: 'Restore and restart',
          danger: true,
        }))
      ) {
        await confirmPassword();
        await api(`/api/snapshots/${encodeURIComponent(b.dataset.restore)}/restore`, {
          method: 'POST',
        });
        toast('Restoring. The app will restart.');
        setTimeout(() => {
          if (ctx.alive()) location.reload();
        }, 15000);
      }
    });
    await load();
  } else {
    async function load(run = false) {
      const d = await api(run ? '/api/health/run' : '/api/health', run ? { method: 'POST' } : {});
      if (!alive()) return;
      const h = healthSummary(d.checks || []);
      el.innerHTML = `<div class="hero">${h.problems.some((c) => ['bad', 'fail'].includes(c.status)) ? 'Your server needs a look.' : 'Your server is working.'} ${h.problems.length ? `<span class="warn">${h.problems.length.toLocaleString()} ${h.problems.length === 1 ? 'thing needs' : 'things need'} a look.</span>` : ''}</div><div class="toolbar"><p class="grow">${plural(h.total, 'check')} · last run ${ago(d.at)}</p>${admin ? `<button data-run>Run again</button>` : ''}</div>${h.problems.length ? `<section class="card health-problems">${h.problems.map((c) => check(c) + (admin ? `<a href="${c.id?.startsWith('space-') ? '#/settings/cleanup' : c.group === 'Access' ? '#/settings/security' : '#/health/logs'}">${c.id?.startsWith('space-') ? 'Review cleanup rules' : c.group === 'Access' ? 'Security settings' : 'View logs'} →</a>` : '')).join('')}</section>` : ''}<div class="row health-section-title"><h3 class="grow muted">Checks</h3><span class="muted">${h.passed.toLocaleString()} of ${h.total.toLocaleString()} passed</span></div><section class="card health-groups">${
        h.groups
          .map(
            (g) =>
              `<details class="health-check"><summary><span class="group-icon ${g.worst === 'fail' ? 'bad' : g.worst}">${icon(g.name === 'Data folder' ? 'folder_open' : g.name === 'Video' ? 'movie' : g.name === 'Access' ? 'shield' : 'directions_car')}</span><span class="grow"><b>${esc(g.name)}</b><span class="group-result ${g.worst === 'fail' ? 'bad' : g.worst}">${esc(g.line)}</span></span><span class="muted">›</span></summary>${d.checks
                .filter((c) => c.group === g.name)
                .map(check)
                .join('')}</details>`,
          )
          .join('') || '<p>No results yet. Run the checks to get started.</p>'
      }</section><h3 class="muted health-section-title">More</h3><div class="card health-links">${[
        ['server', 'Server details', 'CPU, graphics, power, memory and storage', 'monitoring'],
        ['footage-check', 'Footage check', 'Find files that will not play', 'video_file'],
        ['logs', 'Logs', 'Search what happened on your server', 'article'],
        ['backups', 'Backups', 'Restore accounts, settings and stars', 'backup'],
      ]
        .filter(([path]) => admin || !['logs', 'backups'].includes(path))
        .map(
          ([path, title, text, glyph]) =>
            `<a class="health-more-row" href="#/health/${path}"><span class="group-icon">${icon(glyph)}</span><span class="grow"><h3>${title}</h3><p>${text}</p></span><span class="muted">›</span></a>`,
        )
        .join('')}</div>`;
      if (admin)
        el.querySelector('[data-run]').onclick = act(async (e) => {
          e.target.disabled = true;
          e.target.textContent = 'Checking…';
          try {
            await load(true);
          } finally {
            if (alive()) el.querySelector('[data-run]').disabled = false;
          }
        });
    }
    await load();
  }
  return () => {
    stopped = true;
    clearTimeout(timer);
    el.onclick = null;
  };
}

export const render = ownedRender(renderPage);
