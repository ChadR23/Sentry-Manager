// Policies: how long each kind of recording stays before the policy moves it
// to the Recycle Bin (never deleted by a policy; protected ones always stay).

import { $, esc, icon, api, current, vehiclePicker, bytes, plural, whenFull, toast, confirmDialog, empty } from '../core.js';

const CATS = [['Recent', 'Drives (RecentClips)', 'var(--au-teal)'], ['Sentry', 'Sentry events', 'var(--au-magenta)'], ['Saved', 'Saved clips', 'var(--au-green)'], ['Other', 'Other', 'var(--au-violet)']];

export default {
  title: 'Policies',
  kicker: 'Retention',
  icon: 'shield',
  vehicle: true,
  topics: ['inventory'],
  async mount(ctx) {
    const { body, actions } = ctx;
    const v = current();
    actions.innerHTML = vehiclePicker();
    if (!v) {
      body.innerHTML = empty('No vehicle yet', 'Add one in Settings first.', `<a class="btn primary" href="#/settings/vehicles/new">${icon('plus')} Add a vehicle</a>`);
      return {};
    }
    let dead = false;
    const url = `/api/vehicles/${encodeURIComponent(v.id)}/policy`;

    function note({ policy, preview }) {
      const el = $('#pol-note', body);
      if (!el) return;
      el.className = `note ${preview.recordings ? 'warn' : 'ok'}`;
      el.innerHTML = `${preview.recordings ? `With these settings the next run moves ${plural(preview.recordings, 'recording')} (${bytes(preview.bytes)}) to the Recycle Bin.` : 'With these settings nothing would move right now.'}${policy.lastRunAt ? `<br>Last run ${esc(whenFull(policy.lastRunAt))}: ${policy.lastResult?.error ? esc(policy.lastResult.error) : `${policy.lastResult?.moved ?? 0} moved, ${policy.lastResult?.skipped ?? 0} skipped`}.` : ''}`;
    }
    function draw({ policy, preview }) {
      body.innerHTML = `<form id="pol" class="stack" novalidate>
        <section class="panel"><div class="panel-head"><h2>Retention for ${esc(v.name)}</h2>
          <label class="check"><input type="checkbox" name="enabled"${policy.enabled ? ' checked' : ''}> Run every day</label></div>
          <p class="lead">Recordings older than the days below move to the Recycle Bin once a day. A policy never deletes anything, and protected recordings always stay. Leave a field empty to keep that kind forever.</p>
          <div class="keep-grid" style="margin-top:18px">${CATS.map(([c, label, color]) => `<label class="keep"><span class="row"><span class="cat-dot" style="background:${color};box-shadow:0 0 10px ${color}"></span><b>${esc(label)}</b></span>
            <span class="field">Keep for (days)<input class="input" type="number" inputmode="numeric" min="1" max="3650" name="keep-${c}" value="${policy.keepDays[c] ?? ''}" placeholder="forever"></span></label>`).join('')}</div>
          <div class="form" style="margin-top:16px"><label class="field">Run at (server time)<input class="input" type="time" name="runAt" value="${esc(policy.runAt)}" required></label></div>
          <p class="note" id="pol-note" style="margin-top:16px"></p>
          <div class="actions"><button class="btn" type="button" id="run">${icon('play')} Run now</button><button class="btn primary" type="submit">${icon('check')} Save</button></div>
        </section></form>`;
      note({ policy, preview });
    }
    const read = () => {
      const fd = new FormData($('#pol', body));
      return { enabled: fd.get('enabled') === 'on', runAt: String(fd.get('runAt') || ''), keepDays: Object.fromEntries(CATS.map(([c]) => [c, fd.get(`keep-${c}`) ? Number(fd.get(`keep-${c}`)) : null])) };
    };
    const load = async (full = true) => {
      const out = await api(url);
      if (dead) return;
      if (full || !$('#pol', body)) draw(out);
      else note(out);
    };
    body.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const out = await api(url, { method: 'PUT', body: read() });
        toast('Policy saved.');
        note(out);
      } catch (err) { toast(err.message, 'bad'); }
    });
    body.addEventListener('click', async (e) => {
      if (!e.target.closest('#run')) return;
      try {
        const saved = await api(url, { method: 'PUT', body: read() });
        note(saved);
        if (!saved.preview.recordings) { toast('Nothing to move right now.'); return; }
        if (!(await confirmDialog({ title: 'Run the policy now?', body: `<p>${plural(saved.preview.recordings, 'recording')} (${bytes(saved.preview.bytes)}) move to the Recycle Bin. You can restore them from there.</p>`, ok: 'Run now' }))) return;
        const out = await api(`${url}/run`, { body: {} });
        toast(`${plural(out.moved?.length ?? out.moved ?? 0, 'recording')} moved to the Recycle Bin.`);
        await load(false);
      } catch (err) { toast(err.message, 'bad'); }
    });
    await load();
    return {
      refresh() { load(false).catch(() => {}); },
      destroy() { dead = true; }
    };
  }
};
