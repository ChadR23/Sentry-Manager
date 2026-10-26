// Nodes: other servers that encode for this one, and this one working for another.
import { esc, api, state, icon, toast, confirmDialog, promptDialog, busy, when, ago, plural } from '../core.js';
import { chip, empty } from '../ui.js';

export default {
  async mount(el, { seq }) {
    let timer = null;
    let alive = true;
    let saving = false;

    async function draw(force = true) {
      const [{ nodes, worker }, cars] = await Promise.all([api('/api/nodes'), Promise.resolve(state.vehicles)]);
      const benches = Object.fromEntries(await Promise.all(nodes.map(async (n) => [n.id, (await api(`/api/nodes/${encodeURIComponent(n.id)}/benchmark`).catch(() => ({}))).benchmark || null])));
      if (!alive) return;
      const benchRunning = Object.values(benches).some((b) => b?.state === 'running');
      const typed = [...el.querySelectorAll('#node-add input')].some((i) => i.value);
      if (!force && (typed || (el.contains(document.activeElement) && document.activeElement.matches('input, select')))) {
        schedule(benchRunning || nodes.length ? 4000 : 0);
        return;
      }
      const carName = (id) => cars.find((x) => x.id === id)?.name || id;
      const enc = (e) => [['H.265', e?.h265], ['AV1', e?.av1]].filter(([, x]) => x).map(([k, x]) => `${k}: <span class="mono">${esc(x)}</span>`).join(' · ') || '—';
      const nodeCard = (n) => {
        const b = benches[n.id];
        const list = n.cars || [];
        const left = cars.filter((x) => !list.includes(x.id));
        return `<article class="card node">
          <header class="card-h"><div><h3>${esc(n.name)}</h3><span class="mono small faint">${esc(n.address)}</span></div>${n.online ? chip('online', 'green') : chip('offline', 'red')}</header>
          ${n.online ? '' : `<p class="small bad-text">${esc(n.error || '')}</p>`}
          <dl class="kv tight"><dt>encoders</dt><dd>${enc(n.encoders)}</dd><dt>clips</dt><dd class="num">${n.online && n.slots ? (n.encoding === null ? `${n.busy ?? 0} of ${n.slots} busy` : `${n.encoding} of ${n.slots} converting${n.busy > n.encoding ? ` · ${n.busy - n.encoding} waiting` : ''}`) : '—'}</dd>
            <dt>paired</dt><dd>${esc(when(n.pairedAt))}</dd><dt>fingerprint</dt><dd class="mono small wrap">${esc(n.fingerprint || '—')}</dd></dl>
          <div class="sub-block"><b class="small">Vehicles first</b> <span class="faint small">${list.length ? 'automatic conversion sends these vehicles\' clips here first, in order' : 'none: it helps whichever vehicle is converting'}</span>
            ${list.length ? `<ol class="carlist">${list.map((id, i) => `<li><span class="num faint">${i + 1}</span><span>${esc(carName(id))}</span><button class="btn sm icon" type="button" data-car-up="${esc(n.id)}" data-car="${esc(id)}" aria-label="Move ${esc(carName(id))} up"${i ? '' : ' disabled'}>${icon('up')}</button><button class="btn sm icon" type="button" data-car-rm="${esc(n.id)}" data-car="${esc(id)}" aria-label="Remove ${esc(carName(id))}">${icon('x')}</button></li>`).join('')}</ol>` : ''}
            ${left.length ? `<select class="input" data-car-add="${esc(n.id)}" aria-label="Add a vehicle for ${esc(n.name)}"><option value="">Add a vehicle…</option>${left.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>` : ''}</div>
          <label class="check sub-block"><input type="checkbox" data-trust="${esc(n.id)}"${n.trusted ? ' checked' : ''}><span><b>Trusted</b> <span class="faint small">${n.trusted ? 'its encodes replace originals without the picture check (streams, length, frames and telemetry are still verified)' : 'its encodes get the picture check here; trust only a computer of your own'}</span></span></label>
          ${b ? `<div class="sub-block"><b class="small">Benchmark ${esc(b.codec === 'av1' ? 'AV1' : 'H.265')}</b> <span class="faint small">${b.state === 'running' ? `${esc(b.phase || 'running')}…` : b.state === 'failed' ? `failed: ${esc(b.error || '')}` : esc(b.state)}${b.samples ? ` · ${plural(b.samples, 'sample clip')}` : ''}</span>
            ${(b.results || []).length ? `<div class="tscroll"><table class="dtable"><tbody>${b.results.map((r) => `<tr class="${r.level === b.suggested ? 'best' : ''}"><td class="num">${r.level} at once</td><td class="num">${r.failed ? `${r.failed} failed` : `${r.clipsPerMinute} clips/min`}</td><td class="faint small num">${r.clips} clips in ${r.seconds}s</td></tr>`).join('')}</tbody></table></div>` : ''}
            <div class="row-actions">${b.state === 'running' ? `<button class="btn sm" type="button" data-bench-cancel="${esc(n.id)}">Cancel</button>` : `${b.suggested ? `<button class="btn sm cyan" type="button" data-bench-use="${esc(n.id)}" data-level="${b.suggested}">Use ${b.suggested} at once</button>` : ''}<button class="btn sm" type="button" data-bench="${esc(n.id)}" data-codec="${esc(b.codec)}">Run again</button>`}</div></div>` : ''}
          <div class="row-actions">
            ${n.online && !b ? `<button class="btn sm" type="button" data-bench="${esc(n.id)}" data-codec="h265"${benchRunning ? ' disabled' : ''}>${icon('gauge')}Benchmark</button>${n.encoders?.av1 ? `<button class="btn sm" type="button" data-bench="${esc(n.id)}" data-codec="av1"${benchRunning ? ' disabled' : ''}>Benchmark AV1</button>` : ''}` : ''}
            <button class="btn sm" type="button" data-rename="${esc(n.id)}">Rename</button>
            <button class="btn sm danger" type="button" data-remove="${esc(n.id)}">Remove</button>
          </div></article>`;
      };
      const pairing = worker.pairing;
      const mins = pairing ? Math.max(1, Math.round((pairing.expiresAt - Date.now()) / 60000)) : 0;
      el.innerHTML = `
        <div class="phead"><div><h1>Nodes</h1><p class="muted small">Other servers running Sentry Six Manager encode clips for this one over pinned HTTPS. Nodes never get share passwords and never touch footage.</p></div></div>
        <div class="node-cols">
          <section aria-label="Nodes this server uses">
            <div class="section-h"><h2>Nodes this server uses</h2><span class="faint small">${plural(nodes.length, 'node')}</span></div>
            <div class="node-grid">${nodes.map(nodeCard).join('') || empty('No nodes yet. Pair one below.')}</div>
            <form class="card form-card" id="node-add">
              <header class="card-h"><h3>Pair a node</h3></header>
              <div class="grid2">
                <label class="field">Node address<input class="input mono" name="address" placeholder="192.168.1.30 or nas.local:9000" autocomplete="off" required></label>
                <label class="field">Pairing code<input class="input mono" name="code" placeholder="ABCD-EFGH-JKLM" autocomplete="off" required></label>
              </div>
              <p class="faint small">On the other server: Nodes → Let another server use this one → Show pairing code. Pairing asks for your password.</p>
              <div class="row-actions"><button class="btn primary" type="submit">${icon('plus')}Pair node</button></div>
            </form>
            ${nodes.length ? '<p class="faint small">Each node is a lane on the Encoder page: set how many clips it converts at once there.</p>' : ''}
          </section>
          <section aria-label="Let another server use this one">
            <div class="section-h"><h2>Let another server use this one</h2>${worker.enabled ? chip('node mode on', 'green') : chip('off', '')}</div>
            <div class="card">
              ${worker.available ? `
              <p class="small muted">A main server paired here sends this one clips to encode and takes the results back. It can do nothing else here.</p>
              <div class="grid2" style="margin-top:12px">
                <label class="check span2"><input type="checkbox" id="w-on"${worker.enabled ? ' checked' : ''}> Encode for paired main servers</label>
                <label class="field">Clips at once<select class="input" id="w-slots">${[1, 2, 3, 4, 6, 8].map((x) => `<option${x === worker.slots ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
                <label class="field">Encode with<select class="input" id="w-use">${[['gpu', 'GPU (CPU without one)'], ['gpu-cpu', 'GPU, then CPU if it fails'], ['cpu', 'CPU only']].map(([x, l]) => `<option value="${x}"${x === worker.use ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
              </div>
              <p class="small faint">${worker.busy ? `${worker.busy} clip(s) converting for a main server now · ` : ''}name: <span class="mono">${esc(worker.name || '')}</span></p>
              ${pairing ? `<div class="pair"><span class="small muted">Pairing code · one use · ${plural(mins, 'minute')} left</span><b class="mono pair-code">${esc(pairing.code)}</b><span class="small">On the main server: Nodes → Pair a node, address <b class="mono">${esc(location.hostname)}${location.port && location.port !== '9000' ? `:${esc(location.port)}` : ''}</b> and this code.</span><button class="btn sm" type="button" id="pair-cancel">Cancel code</button></div>`
                : '<div class="row-actions"><button class="btn" type="button" id="pair-start">Show pairing code</button></div>'}
              ${worker.mains.length ? `<div class="tscroll"><table class="dtable stack"><thead><tr><th>main server</th><th>paired</th><th></th></tr></thead><tbody>${worker.mains.map((m) => `<tr><td><b>${esc(m.name)}</b><div class="mono small faint">${esc(m.address || '')}</div></td><td class="small">${esc(when(m.pairedAt))}${m.lastSeenAt ? `<div class="faint">seen ${esc(ago(m.lastSeenAt))}</div>` : ''}</td><td class="r"><button class="btn sm danger" type="button" data-revoke="${esc(m.id)}">Revoke</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="faint small">No main server uses this one yet.</p>'}`
                : '<p class="muted">This server runs without its own HTTPS (TLS_MODE=off), so it cannot be a node.</p>'}
            </div>
          </section>
        </div>`;
      wire(nodes, worker);
      schedule(benchRunning ? 2500 : nodes.length ? 6000 : 0);
    }
    function schedule(ms) {
      clearTimeout(timer);
      if (ms && alive) timer = setTimeout(() => { if (alive && seq() && document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) draw(false).catch(() => {}); else schedule(ms); }, ms);
    }
    const once = (fn) => async (...a) => {
      if (saving) return;
      saving = true;
      try { await fn(...a); } finally { saving = false; }
    };
    function wire(nodes, worker) {
      const $ = (s) => el.querySelector(s);
      $('#node-add').onsubmit = (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        busy(e.target.querySelector('[type=submit]'), async () => {
          await api('/api/nodes', { body: { address: f.get('address'), code: f.get('code') } });
          toast('Node paired. Set its clips at once on the Encoder page.');
          e.target.reset();
          await draw();
        });
      };
      const carsOf = (id) => [...(nodes.find((x) => x.id === id)?.cars || [])];
      const saveCars = once(async (id, cars) => { await busy(null, () => api(`/api/nodes/${encodeURIComponent(id)}`, { method: 'PUT', body: { cars } })); await draw(); });
      el.querySelectorAll('[data-car-add]').forEach((s) => { s.onchange = () => s.value && saveCars(s.dataset.carAdd, [...carsOf(s.dataset.carAdd), s.value]); });
      el.querySelectorAll('[data-car-rm]').forEach((b) => { b.onclick = () => saveCars(b.dataset.carRm, carsOf(b.dataset.carRm).filter((x) => x !== b.dataset.car)); });
      el.querySelectorAll('[data-car-up]').forEach((b) => {
        b.onclick = () => {
          const l = carsOf(b.dataset.carUp);
          const i = l.indexOf(b.dataset.car);
          if (i > 0) [l[i - 1], l[i]] = [l[i], l[i - 1]];
          saveCars(b.dataset.carUp, l);
        };
      });
      el.querySelectorAll('[data-trust]').forEach((box) => {
        box.onchange = once(async () => {
          const on = box.checked;
          if (on && !(await confirmDialog({ title: 'Trust this node?', body: '<p>Its encodes will replace your originals without the picture check. Only for a computer of your own that nobody else can change. This asks for your password.</p>', ok: 'Trust it' }))) { box.checked = false; return; }
          await busy(null, async () => {
            await api(`/api/nodes/${encodeURIComponent(box.dataset.trust)}`, { method: 'PUT', body: { trusted: on } });
            toast(on ? 'Trusted: its encodes skip the picture check.' : 'Not trusted: its encodes get the picture check.');
          });
          await draw();
        });
      });
      el.querySelectorAll('[data-rename]').forEach((b) => {
        b.onclick = once(async () => {
          const n = nodes.find((x) => x.id === b.dataset.rename);
          const name = await promptDialog({ title: 'Rename node', label: 'Name', value: n?.name || '', maxlength: 64, body: '<p class="faint small">Shown here and on the Encoder page. The node keeps its own name.</p>' });
          if (!name || name.trim() === n?.name) return;
          await busy(null, () => api(`/api/nodes/${encodeURIComponent(n.id)}`, { method: 'PUT', body: { name: name.trim() } }));
          await draw();
        });
      });
      el.querySelectorAll('[data-remove]').forEach((b) => {
        b.onclick = once(async () => {
          const n = nodes.find((x) => x.id === b.dataset.remove);
          if (!(await confirmDialog({ title: 'Remove this node?', body: `<p><b>${esc(n?.name || '')}</b> gets no more clips from this server. Pair it again with a new code to use it.</p>`, ok: 'Remove', danger: true }))) return;
          await busy(null, () => api(`/api/nodes/${encodeURIComponent(n.id)}`, { method: 'DELETE' }));
          await draw();
        });
      });
      el.querySelectorAll('[data-bench]').forEach((b) => {
        b.onclick = () => busy(b, async () => { await api(`/api/nodes/${encodeURIComponent(b.dataset.bench)}/benchmark`, { body: { codec: b.dataset.codec } }); await draw(); });
      });
      el.querySelectorAll('[data-bench-cancel]').forEach((b) => {
        b.onclick = () => busy(b, async () => { await api(`/api/nodes/${encodeURIComponent(b.dataset.benchCancel)}/benchmark`, { method: 'DELETE' }); await draw(); });
      });
      el.querySelectorAll('[data-bench-use]').forEach((b) => {
        b.onclick = () => busy(b, async () => {
          await api(`/api/nodes/${encodeURIComponent(b.dataset.benchUse)}/slots`, { body: { slots: Number(b.dataset.level) } });
          toast(`The node now converts ${b.dataset.level} at once.`);
          await draw();
        });
      });
      if (!worker.available) return;
      const saveWorker = () => busy(null, async () => {
        await api('/api/nodes/worker', { body: { enabled: $('#w-on').checked, slots: Number($('#w-slots').value), use: $('#w-use').value } });
        toast('Saved.');
        await draw();
      });
      $('#w-on').onchange = saveWorker;
      $('#w-slots').onchange = saveWorker;
      $('#w-use').onchange = saveWorker;
      $('#pair-start')?.addEventListener('click', (e) => busy(e.currentTarget, async () => { await api('/api/nodes/worker/pair', { body: {} }); await draw(); }));
      $('#pair-cancel')?.addEventListener('click', (e) => busy(e.currentTarget, async () => { await api('/api/nodes/worker/pair', { method: 'DELETE' }); await draw(); }));
      el.querySelectorAll('[data-revoke]').forEach((b) => {
        b.onclick = async () => {
          const m = worker.mains.find((x) => x.id === b.dataset.revoke);
          if (!(await confirmDialog({ title: 'Revoke this main server?', body: `<p><b>${esc(m?.name || '')}</b> can no longer send clips here. Clips it is converting now stop.</p>`, ok: 'Revoke', danger: true }))) return;
          await busy(b, () => api(`/api/nodes/worker/mains/${encodeURIComponent(m.id)}`, { method: 'DELETE' }));
          await draw();
        };
      });
    }

    await draw();
    return {
      unmount() { alive = false; clearTimeout(timer); },
      commands: () => [{ group: 'Nodes', label: 'Show a pairing code', icon: 'nodes', run: () => el.querySelector('#pair-start')?.click() }]
    };
  }
};
