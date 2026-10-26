// Helper servers (Nodes): other servers running Sentry Six Manager that
// convert clips for this one, and letting another server use this one.

import { api, esc, enc, icon, plural, when, chip, emptyState, details, confirmDialog, promptDialog, toast, fail, busy } from '../core.js';
import { state } from '../state.js';

let saving = false;
const once = (fn) => async (...a) => {
  if (saving) return;
  saving = true;
  try { await fn(...a); } finally { saving = false; }
};

export async function render(ctx) {
  const { view } = ctx;
  let data;
  let benches = {};
  const load = async () => {
    data = await api('/api/nodes');
    benches = Object.fromEntries(await Promise.all(data.nodes.map(async (n) => [n.id, (await api(`/api/nodes/${enc(n.id)}/benchmark`).catch(() => ({}))).benchmark || null])));
  };
  await load();
  if (!ctx.alive()) return;
  const openPanels = new Set();

  const encoders = (e) => [['H.265', e?.h265], ['AV1', e?.av1]].filter(([, x]) => x).map(([k, x]) => `${k}: ${x}`).join(' · ') || 'Unknown';
  const benchPanel = (n) => {
    const b = benches[n.id];
    if (!b) return '';
    const codec = b.codec === 'av1' ? 'AV1' : 'H.265';
    const status = b.state === 'running' ? `${esc(b.phase || 'Running')}…` : b.state === 'failed' ? `didn’t finish: ${esc(b.error || '')}` : b.state === 'cancelled' ? 'cancelled' : `done${b.samples ? ` with ${plural(b.samples, 'sample clip')} of your footage (only read)` : ''}`;
    return `<div class="card" style="background:var(--surface-2);box-shadow:none;margin-top:12px;padding:16px"><b>Speed test, ${codec}</b> <span class="muted small">${status}</span>
      ${b.results?.length ? `<div style="overflow-x:auto;margin-top:8px"><table class="bench-table"><thead><tr><th>At once</th><th>Speed</th><th>Clips</th></tr></thead><tbody>${b.results.map((r) => `<tr class="${r.level === b.suggested ? 'best' : ''}"><td>${r.level}${r.level === b.suggested ? ' (best)' : ''}</td><td>${r.failed ? `${r.failed} failed` : `${r.clipsPerMinute} clips/min`}</td><td class="muted">${r.clips} in ${r.seconds} s</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${b.state === 'running' ? `${b.state === 'running' ? '<div class="loading" style="padding:10px 0"><span class="spin"></span><span>Measuring…</span></div>' : ''}<button class="btn btn-sm" type="button" data-bench-cancel="${esc(n.id)}">Cancel</button>`
        : `<div class="row" style="margin-top:10px">${b.suggested ? `<button class="btn btn-primary btn-sm" type="button" data-bench-use="${esc(n.id)}" data-level="${b.suggested}">Use ${b.suggested} at once</button>` : ''}<button class="btn btn-sm" type="button" data-bench-start="${esc(n.id)}" data-codec="${esc(b.codec)}">Test again</button></div>`}</div>`;
  };
  const carsPanel = (n) => {
    const cars = state.vehicles;
    if (!cars.length) return '';
    const list = (n.cars || []).filter((id) => cars.some((v) => v.id === id));
    const left = cars.filter((v) => !list.includes(v.id));
    const name = (id) => cars.find((v) => v.id === id)?.name || id;
    return `<h4 style="margin-top:6px">Vehicles first</h4><p class="muted small">${list.length ? 'Automatic conversion sends this helper these vehicles’ new clips first, in this order. With none waiting, it helps the others.' : 'None: it helps whichever vehicle is converting.'}</p>
      ${list.length ? `<ol class="stack-sm" style="padding-left:20px;margin:8px 0">${list.map((id, i) => `<li><div class="row"><span>${esc(name(id))}</span>${i > 0 ? `<button class="btn btn-ghost btn-sm" type="button" data-car-up="${esc(n.id)}" data-car="${esc(id)}" aria-label="Move ${esc(name(id))} up">↑ Up</button>` : ''}<button class="btn btn-ghost btn-sm" type="button" data-car-remove="${esc(n.id)}" data-car="${esc(id)}" aria-label="Remove ${esc(name(id))}">Remove</button></div></li>`).join('')}</ol>` : ''}
      ${left.length ? `<label class="field" style="max-width:320px;margin-top:8px"><span class="sr-only">Add a vehicle for ${esc(n.name)}</span><select class="input" data-car-add="${esc(n.id)}"><option value="">Add a vehicle…</option>${left.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></label>` : ''}`;
  };
  const benchRunning = () => Object.values(benches).some((b) => b?.state === 'running');
  const nodeCard = (n) => `<li class="card" data-node="${esc(n.id)}" style="list-style:none">
    <div class="row-between"><div><h3>${esc(n.name)}</h3><p class="muted small mono">${esc(n.address)}</p></div>
      ${n.online ? chip('Online', 'good') : chip('Offline', 'bad')}</div>
    ${n.online ? '' : `<p class="small" style="color:var(--bad);margin-top:6px">${esc(n.error || 'It isn’t answering.')}</p>`}
    <div class="stat-row" style="margin-top:12px">
      <div class="stat"><span>Converting</span><b>${n.online && n.slots ? (n.encoding === null || n.encoding === undefined ? `${n.busy ?? 0} of ${n.slots}` : `${n.encoding} of ${n.slots}`) : '—'}</b></div>
      ${n.online && n.busy > (n.encoding ?? n.busy) ? `<div class="stat"><span>Waiting</span><b>${n.busy - n.encoding}</b></div>` : ''}
    </div>
    <label class="check" style="margin-top:14px"><input type="checkbox" data-trust="${esc(n.id)}"${n.trusted ? ' checked' : ''}> <span><b>Trusted</b> <span class="muted small">${n.trusted ? 'Its results replace originals without the extra picture check (length, frames and driving data are still checked).' : 'Its results get an extra picture check here. Only trust a computer of your own.'}</span></span></label>
    ${benchPanel(n)}
    <div class="row" style="margin-top:14px">
      ${n.online && !benches[n.id] ? `<button class="btn btn-sm" type="button" data-bench-start="${esc(n.id)}" data-codec="h265"${benchRunning() ? ' disabled' : ''}>${icon('speed')} Speed test</button>${n.encoders?.av1 ? `<button class="btn btn-sm" type="button" data-bench-start="${esc(n.id)}" data-codec="av1"${benchRunning() ? ' disabled' : ''}>Speed test AV1</button>` : ''}` : ''}
      <button class="btn btn-sm" type="button" data-rename="${esc(n.id)}">Rename</button>
      <button class="btn btn-ghost btn-sm" type="button" data-remove="${esc(n.id)}">Remove</button></div>
    <details class="more" data-panel="${esc(n.id)}"${openPanels.has(n.id) ? ' open' : ''}><summary>More details</summary><div class="more-body">
      <p class="small"><b>Encoders:</b> ${esc(encoders(n.encoders))}</p>${carsPanel(n)}
      <p class="muted small" style="margin-top:10px">How many clips it converts at once is set on the Encoder page, like your own devices.</p></div></details>
  </li>`;

  const draw = () => {
    const w = data.worker;
    const pairing = w.pairing;
    const mins = pairing ? Math.max(1, Math.round((pairing.expiresAt - Date.now()) / 60000)) : 0;
    view.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>Helper servers</h1><p class="lede">Other computers running Sentry Six Manager can convert clips for this one (these are called Nodes). They never get your passwords and never touch your footage directly.</p></div></div>
      <section><h2 style="margin-bottom:14px">Helpers this server uses</h2>
        ${data.nodes.length ? `<ul class="grid grid-2" style="padding:0;margin:0">${data.nodes.map(nodeCard).join('')}</ul>` : emptyState({ art: 'nodes', title: 'No helpers yet', text: 'Pair another server below and conversions get faster.' })}
        <form class="card section stack" id="add-node"><h3>Pair a helper</h3>
          <p class="muted small">On the other server, open Helper servers → “Let another server use this one” → Show pairing code.</p>
          <div class="form-grid"><label class="field"><span>Its address</span><input class="input" name="address" placeholder="192.168.1.30 or nas.local:9000" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>
            <label class="field"><span>Pairing code</span><input class="input mono" name="code" placeholder="ABCD-EFGH-JKLM" autocomplete="off" autocapitalize="characters" spellcheck="false" required></label></div>
          <div><button class="btn btn-primary" type="submit">${icon('plus')} Pair</button></div></form></section>
      <section class="section"><div class="card stack"><h2>Let another server use this one</h2>
        ${w.available ? `<p class="muted">A main server you pair here sends clips to convert and takes the results back. It can do nothing else here: no footage, settings or passwords.</p>
          <label class="switch"><input type="checkbox" id="worker-on"${w.enabled ? ' checked' : ''}><span>Convert for paired main servers</span></label>
          <div class="form-grid"><label class="field"><span>Clips at once</span><select class="input" id="worker-slots">${[1, 2, 3, 4, 6, 8].map((n) => `<option${n === w.slots ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
            <label class="field"><span>Convert with</span><select class="input" id="worker-use">${[['gpu', 'Graphics card (processor if there is none)'], ['gpu-cpu', 'Graphics card, then processor if it fails'], ['cpu', 'Processor only']].map(([k, t]) => `<option value="${k}"${k === w.use ? ' selected' : ''}>${t}</option>`).join('')}</select></label></div>
          ${pairing ? `<div class="note note-good" style="flex-direction:column"><span class="muted small">Pairing code (works once, ${plural(mins, 'minute')} left)</span><span class="pair-code">${esc(pairing.code)}</span>
              <span class="small">On the main server: Helper servers → Pair a helper, with this server’s address <b class="mono">${esc(location.hostname)}${location.port && location.port !== '9000' ? `:${esc(location.port)}` : ''}</b> and this code.</span>
              <button class="btn btn-sm" type="button" id="pair-cancel">Cancel the code</button></div>`
            : '<div><button class="btn" type="button" id="pair-start">Show pairing code</button></div>'}
          ${w.mains.length ? `<h3>Main servers using this one</h3><ul class="list">${w.mains.map((m) => `<li class="list-item"><div class="grow"><b>${esc(m.name)}</b><p class="muted small mono">${esc(m.address || '')}</p><p class="muted small">Paired ${esc(when(m.pairedAt))}${m.lastSeenAt ? ` · last seen ${esc(when(m.lastSeenAt))}` : ''}</p></div><div class="item-actions"><button class="btn btn-sm" type="button" data-revoke="${esc(m.id)}">Revoke</button></div></li>`).join('')}</ul>` : ''}`
          : '<p class="muted">This server runs without its own HTTPS (TLS_MODE=off), so it can’t help another server: the main server must be able to check its certificate.</p>'}
      </div></section></div>`;
    wire();
  };
  const refresh = async () => { try { await load(); } catch (err) { return fail(err); } if (ctx.alive()) draw(); return undefined; };
  const nodeOf = (id) => data.nodes.find((n) => n.id === id);
  const wire = () => {
    view.querySelectorAll('[data-panel]').forEach((d) => d.addEventListener('toggle', () => { if (d.open) openPanels.add(d.dataset.panel); else openPanels.delete(d.dataset.panel); }));
    view.querySelector('#add-node').onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      busy(e.submitter, async () => {
        try {
          await api('/api/nodes', { body: { address: String(f.get('address')).trim(), code: String(f.get('code')).trim() } });
          toast('Paired. Set how many clips it converts at once on the Encoder page.', { kind: 'good' });
          refresh();
        } catch (err) { fail(err); }
      });
    };
    view.querySelectorAll('[data-bench-start]').forEach((b) => { b.onclick = () => busy(b, async () => { try { await api(`/api/nodes/${enc(b.dataset.benchStart)}/benchmark`, { body: { codec: b.dataset.codec } }); } catch (err) { fail(err); } refresh(); }); });
    view.querySelectorAll('[data-bench-cancel]').forEach((b) => { b.onclick = () => busy(b, async () => { await api(`/api/nodes/${enc(b.dataset.benchCancel)}/benchmark`, { method: 'DELETE' }).catch(fail); refresh(); }); });
    view.querySelectorAll('[data-bench-use]').forEach((b) => {
      b.onclick = () => busy(b, async () => {
        const level = Number(b.dataset.level);
        try {
          await api(`/api/nodes/${enc(b.dataset.benchUse)}/slots`, { body: { slots: level } });
          // the Encoder's row for this helper follows for the next conversion
          const lanes = JSON.parse(localStorage.getItem('daylight:lanes') || '{}') || {};
          lanes[`node:${b.dataset.benchUse}`] = level;
          localStorage.setItem('daylight:lanes', JSON.stringify(lanes));
          toast(`It now converts ${level} at once.`, { kind: 'good' });
        } catch (err) { fail(err); }
        refresh();
      });
    });
    view.querySelectorAll('[data-trust]').forEach((box) => {
      box.onchange = once(async () => {
        const on = box.checked;
        if (on && !(await confirmDialog({ title: 'Trust this helper?', body: '<p>Its results will replace your originals without the extra picture check. Only do this for a computer of your own that nobody else can change.</p>', ok: 'Trust it' }))) { box.checked = false; return; }
        try {
          await api(`/api/nodes/${enc(box.dataset.trust)}`, { method: 'PUT', body: { trusted: on } });
          toast(on ? 'Trusted.' : 'No longer trusted: its results get the picture check.', { kind: 'good' });
        } catch (err) { fail(err); }
        refresh();
      });
    });
    const saveCars = once(async (id, list) => { await api(`/api/nodes/${enc(id)}`, { method: 'PUT', body: { cars: list } }).catch(fail); refresh(); });
    const carsOf = (id) => [...(nodeOf(id)?.cars || [])];
    view.querySelectorAll('[data-car-add]').forEach((s) => { s.onchange = () => { if (s.value) saveCars(s.dataset.carAdd, [...carsOf(s.dataset.carAdd), s.value]); }; });
    view.querySelectorAll('[data-car-remove]').forEach((b) => { b.onclick = () => saveCars(b.dataset.carRemove, carsOf(b.dataset.carRemove).filter((x) => x !== b.dataset.car)); });
    view.querySelectorAll('[data-car-up]').forEach((b) => {
      b.onclick = () => {
        const list = carsOf(b.dataset.carUp);
        const i = list.indexOf(b.dataset.car);
        if (i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
        saveCars(b.dataset.carUp, list);
      };
    });
    view.querySelectorAll('[data-rename]').forEach((b) => {
      b.onclick = once(async () => {
        const n = nodeOf(b.dataset.rename);
        const name = await promptDialog({ title: 'Rename helper', label: 'Name', value: n?.name || '', note: 'Shown here and on the Encoder page. The other server keeps its own name.' });
        if (!name || !name.trim() || name.trim() === n?.name) return;
        await api(`/api/nodes/${enc(n.id)}`, { method: 'PUT', body: { name: name.trim() } }).then(() => toast('Renamed.', { kind: 'good' }), fail);
        refresh();
      });
    });
    view.querySelectorAll('[data-remove]').forEach((b) => {
      b.onclick = once(async () => {
        const n = nodeOf(b.dataset.remove);
        if (!(await confirmDialog({ title: 'Remove this helper?', body: `<p><b>${esc(n?.name || '')}</b> gets no more clips from this server. To use it again, pair it again with a new code.</p>`, ok: 'Remove', danger: true }))) return;
        await api(`/api/nodes/${enc(n.id)}`, { method: 'DELETE' }).then(() => toast('Removed.'), fail);
        refresh();
      });
    });
    if (!data.worker.available) return;
    const saveWorker = async () => {
      try { await api('/api/nodes/worker', { body: { enabled: view.querySelector('#worker-on').checked, slots: Number(view.querySelector('#worker-slots').value), use: view.querySelector('#worker-use').value } }); toast('Saved.', { kind: 'good' }); } catch (err) { fail(err); }
      refresh();
    };
    view.querySelector('#worker-on').onchange = saveWorker;
    view.querySelector('#worker-slots').onchange = saveWorker;
    view.querySelector('#worker-use').onchange = saveWorker;
    view.querySelector('#pair-start')?.addEventListener('click', (e) => busy(e.currentTarget, async () => { try { await api('/api/nodes/worker/pair', { body: {} }); } catch (err) { fail(err); } refresh(); }));
    view.querySelector('#pair-cancel')?.addEventListener('click', (e) => busy(e.currentTarget, async () => { await api('/api/nodes/worker/pair', { method: 'DELETE' }).catch(fail); refresh(); }));
    view.querySelectorAll('[data-revoke]').forEach((b) => {
      b.onclick = async () => {
        const m = data.worker.mains.find((x) => x.id === b.dataset.revoke);
        if (!(await confirmDialog({ title: 'Revoke this main server?', body: `<p><b>${esc(m?.name || '')}</b> can no longer send clips here. Clips it is converting now stop.</p>`, ok: 'Revoke', danger: true }))) return;
        await api(`/api/nodes/worker/mains/${enc(m.id)}`, { method: 'DELETE' }).catch(fail);
        refresh();
      };
    });
  };
  draw();
  // follow the helpers' clips and a running speed test (not while typing)
  ctx.every(5000, async () => {
    if (!data.nodes.length && !data.worker.pairing) return;
    const typing = document.activeElement?.matches?.('input:not([type=checkbox]), select, textarea') || [...view.querySelectorAll('#add-node input')].some((i) => i.value);
    if (typing || document.querySelector('dialog[open]')) return;
    await refresh();
  });
}
