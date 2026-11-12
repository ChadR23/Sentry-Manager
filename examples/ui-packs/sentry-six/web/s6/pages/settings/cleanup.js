import { ownedRender, scope } from '../../core.js';
import { esc } from '../../core.js';
import { plural, size as bytes, ago as when } from '../../format.js';
async function renderPage(page, ctx) {
  const { api, confirmDialog, toast } = ctx.scope;
  const { current, render } = ctx,
    $ = (id) => page.querySelector('#' + id);
  const v = current();
  let html = '';
  if (!v) {
    page.innerHTML = `${html}<div class="empty">Add a vehicle in Settings first.</div>`;
    return;
  }
  const { policy, preview } = await api(`/api/vehicles/${v.id}/policy`);
  html += `<div class="card"><h2>Retention for ${esc(v.name)}</h2>
      <p>Recordings older than the number of days below are moved to the Recycle Bin once a day. Protected recordings are always skipped, and nothing is deleted for good unless you set the Recycle Bin to empty itself after some days. Leave a field empty to keep that category forever.</p>
      <form id="pol" style="margin-top:22px">
        <label class="setting-row" style="margin-bottom:18px">Run this policy every day<input type="checkbox" class="toggle-switch" role="switch" name="enabled"${policy.enabled ? ' checked' : ''}></label>
        <div class="keep">${['Recent', 'Sentry', 'Saved', 'Other'].map((c) => `<label class="field">Keep ${{ Recent: 'Driving', Sentry: 'Sentry', Saved: 'Saved', Other: 'other' }[c]} clips (days)<input class="input" type="number" min="1" max="3650" name="keep-${c}" value="${esc(policy.keepDays[c] ?? '')}" placeholder="forever"></label>`).join('')}</div>
        <div class="form" style="margin-top:16px"><label class="field">Run at (server time)<input class="input" type="time" name="runAt" value="${esc(policy.runAt)}"></label>
          <label class="field">Empty the Recycle Bin after (days)<input class="input" type="number" min="1" max="365" name="binDays" value="${esc(policy.binDays ?? '')}" placeholder="never: you empty it"></label>
          <label class="field">Keep the footage under (GB)<input class="input" type="number" min="1" step="any" name="maxGB" value="${esc(policy.maxGB ?? '')}" placeholder="no limit"></label></div>
        <div class="note${preview.recordings ? ' amber' : ''}">${preview.recordings ? `With these settings, the next run moves ${plural(preview.recordings, 'recording')} (${bytes(preview.bytes)}) to the Recycle Bin.` : 'With these settings, nothing would be moved right now.'}
          ${policy.lastRunAt ? `<br>Last run ${when(policy.lastRunAt)}: ${policy.lastResult?.error ? esc(policy.lastResult.error) : `${Number(policy.lastResult?.moved ?? 0).toLocaleString()} moved, ${Number(policy.lastResult?.skipped ?? 0).toLocaleString()} skipped`}.` : ''}</div>
        <div class="form-actions"><button class="btn" type="button" id="pol-run">Run now</button><button class="btn solid" type="submit">Save policy</button></div>
      </form></div>`;
  page.innerHTML = html;
  const form = $('pol');
  const read = () => {
    const fd = new FormData(form);
    return {
      enabled: fd.get('enabled') === 'on',
      runAt: fd.get('runAt'),
      keepDays: Object.fromEntries(
        ['Recent', 'Sentry', 'Saved', 'Other'].map((c) => [c, fd.get(`keep-${c}`) || null]),
      ),
      binDays: fd.get('binDays') || null,
      maxGB: fd.get('maxGB') || null,
    };
  };
  let running = null;
  form.oninput = form.onchange = () => running?.abort();
  form.onsubmit = async (e) => {
    e.preventDefault();
    running?.abort();
    try {
      await api(`/api/vehicles/${v.id}/policy`, {
        method: 'PUT',
        body: read(),
      });
      toast('Policy saved.');
      if (ctx.alive()) render();
    } catch (err) {
      toast(err.message, true);
    }
  };
  $('pol-run').onclick = async () => {
    if (running?.alive()) return;
    const flow = scope(read, { signal: ctx.scope.signal });
    running = flow;
    try {
      await flow.api(`/api/vehicles/${v.id}/policy`, {
        method: 'PUT',
        body: read(),
      });
      const p = await flow.api(`/api/vehicles/${v.id}/policy`);
      const saved = p.policy;
      if (!saved) throw new Error('Could not read the saved policy. Try again.');
      if (!p.preview.recordings && !saved.binDays) return toast('Nothing to move right now.');
      if (
        !(await flow.confirmDialog({
          title: 'Run the policy now?',
          body: `<p>${plural(p.preview.recordings, 'recording')} (${bytes(p.preview.bytes)}) will move to the Recycle Bin. You can restore them from there.</p>${saved.binDays ? '<p>Items already in the Recycle Bin older than ' + esc(saved.binDays) + ' days will be deleted for good. This cannot be undone.</p>' : ''}`,
          ok: 'Run now',
          danger: !!saved.binDays,
        }))
      )
        return;
      const out = await flow.api(`/api/vehicles/${v.id}/policy/run`, { body: { expect: saved } });
      toast(`${plural(out.moved.length, 'recording')} moved to the Recycle Bin.`);
      if (ctx.alive()) render();
    } catch (err) {
      if (err.name !== 'AbortError') flow.toast(err.message, true);
    } finally {
      flow.abort();
      if (running === flow) running = null;
    }
  };
  return () => {
    form.oninput = form.onchange = null;
    running?.abort();
  };
}

export const render = ownedRender(renderPage);
