import { api, esc, toast, confirmDialog } from '../../core.js';
import { size as bytes, ago as when } from '../../format.js';
export async function render(page, ctx) {
  const { current, render } = ctx,
    $ = (id) => page.querySelector('#' + id),
    plural = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;
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
        <label class="check" style="margin-bottom:18px"><input type="checkbox" name="enabled"${policy.enabled ? ' checked' : ''}> Run this policy every day</label>
        <div class="keep">${['Recent', 'Sentry', 'Saved', 'Other'].map((c) => `<label class="field">Keep ${c} clips (days)<input class="input" type="number" min="1" max="3650" name="keep-${c}" value="${policy.keepDays[c] ?? ''}" placeholder="forever"></label>`).join('')}</div>
        <div class="form" style="margin-top:16px"><label class="field">Run at (server time)<input class="input" type="time" name="runAt" value="${esc(policy.runAt)}"></label>
          <label class="field">Empty the Recycle Bin after (days)<input class="input" type="number" min="1" max="365" name="binDays" value="${policy.binDays ?? ''}" placeholder="never: you empty it"></label>
          <label class="field">Keep the footage under (GB)<input class="input" type="number" min="1" step="any" name="maxGB" value="${policy.maxGB ?? ''}" placeholder="no limit"></label></div>
        <div class="note${preview.recordings ? ' amber' : ''}">${preview.recordings ? `With these settings, the next run moves ${plural(preview.recordings, 'recording')} (${bytes(preview.bytes)}) to the Recycle Bin.` : 'With these settings, nothing would be moved right now.'}
          ${policy.lastRunAt ? `<br>Last run ${when(policy.lastRunAt)}: ${policy.lastResult?.error ? esc(policy.lastResult.error) : `${policy.lastResult?.moved ?? 0} moved, ${policy.lastResult?.skipped ?? 0} skipped`}.` : ''}</div>
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
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/vehicles/${v.id}/policy`, { method: 'PUT', body: read() });
      toast('Policy saved.');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
  $('pol-run').onclick = async () => {
    try {
      await api(`/api/vehicles/${v.id}/policy`, { method: 'PUT', body: read() });
      const p = await api(`/api/vehicles/${v.id}/policy`);
      if (!p.preview.recordings && !read().binDays) return toast('Nothing to move right now.');
      if (
        !(await confirmDialog({
          title: 'Run the policy now?',
          body: `<p>${plural(p.preview.recordings, 'recording')} (${bytes(p.preview.bytes)}) will move to the Recycle Bin. You can restore them from there.</p>${read().binDays ? '<p>Items already in the Recycle Bin older than ' + esc(read().binDays) + ' days are deleted permanently. This cannot be undone.</p>' : ''}`,
          ok: 'Run now',
        }))
      )
        return;
      const out = await api(`/api/vehicles/${v.id}/policy/run`, { body: {} });
      toast(`${plural(out.moved.length, 'recording')} moved to the Recycle Bin.`);
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
}
