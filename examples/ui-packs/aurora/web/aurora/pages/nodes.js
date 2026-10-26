// Nodes: other Sentry Six servers that encode clips for this one (pair,
// rename, trust, vehicles first, benchmark, remove), and this server as a node
// for another ("let another server use this one").

import { $, $$, esc, icon, api, state, plural, when, toast, confirmDialog, promptDialog, empty, store } from '../core.js';

export default {
  title: 'Nodes',
  kicker: 'Constellation',
  icon: 'nodes',
  topics: ['vehicles'],
  async mount(ctx) {
    const { body } = ctx;
    let dead = false;
    let timer = 0;
    let saving = false;

    async function load() {
      const [{ nodes, worker }, cars] = await Promise.all([api('/api/nodes'), Promise.resolve(state.vehicles)]);
      const benches = Object.fromEntries(await Promise.all(nodes.map(async (n) => [n.id, (await api(`/api/nodes/${encodeURIComponent(n.id)}/benchmark`).catch(() => ({}))).benchmark || null])));
      return { nodes, worker, cars, benches };
    }

    function benchHtml(n, b, running) {
      if (!b) {
        return n.online ? `<div class="row"><button class="btn sm" type="button" data-bench="${esc(n.id)}" data-codec="h265"${running ? ' disabled' : ''}>${icon('speed')} Benchmark H.265</button>${n.encoders?.av1 ? `<button class="btn sm" type="button" data-bench="${esc(n.id)}" data-codec="av1"${running ? ' disabled' : ''}>Benchmark AV1</button>` : ''}</div>` : '';
      }
      const rows = (b.results || []).map((r) => `<tr${r.level === b.suggested ? ' class="best"' : ''}><td data-label="At once">${r.level}${r.level === b.suggested ? ' ★' : ''}</td><td data-label="Speed">${r.failed ? `${r.failed} failed` : `${r.clipsPerMinute} clips/min`}</td><td data-label="Sample">${r.clips} clips in ${r.seconds} s</td></tr>`).join('');
      return `<div class="panel" style="padding:14px"><b>Benchmark, ${b.codec === 'av1' ? 'AV1' : 'H.265'}</b> <span class="muted small">${b.state === 'running' ? `${esc(b.phase || 'running')}…` : b.state === 'failed' ? `failed: ${esc(b.error || '')}` : b.state === 'cancelled' ? 'cancelled' : `done${b.samples ? ` · ${plural(b.samples, 'sample clip')}` : ''}`}</span>
        ${rows ? `<div class="table-wrap"><table class="tbl bench-table stack-sm" style="margin-top:8px"><thead><tr><th>At once</th><th>Speed</th><th>Sample</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
        <div class="actions start">${b.state === 'running' ? `<button class="btn sm" type="button" data-bench-cancel="${esc(n.id)}">Cancel</button>` : `${b.suggested ? `<button class="btn sm primary" type="button" data-bench-use="${esc(n.id)}" data-level="${b.suggested}">Use ${b.suggested} at once</button>` : ''}<button class="btn sm" type="button" data-bench="${esc(n.id)}" data-codec="${esc(b.codec)}"${running ? ' disabled' : ''}>Run again</button>`}</div></div>`;
    }

    function nodeHtml(n, d, running) {
      const carName = (id) => d.cars.find((v) => v.id === id)?.name || id;
      const list = n.cars || [];
      const left = d.cars.filter((v) => !list.includes(v.id));
      const enc = [['H.265', n.encoders?.h265], ['AV1', n.encoders?.av1]].filter(([, x]) => x).map(([k, x]) => `${k}: ${esc(x)}`).join(' · ') || 'no encoders reported';
      return `<article class="node-card">
        <div class="node-top"><div><h3>${esc(n.name)}</h3><p class="muted small mono">${esc(n.address)}</p></div>
          <div class="row">${n.online ? '<span class="chip green"><span class="dot ok"></span>Online</span>' : '<span class="chip red"><span class="dot bad"></span>Offline</span>'}${n.trusted ? '<span class="chip violet">Trusted</span>' : ''}</div></div>
        ${n.online ? '' : `<p class="note bad">${esc(n.error || 'Not answering.')}</p>`}
        <p class="small">${enc}${n.online && n.slots ? ` · ${n.encoding === null || n.encoding === undefined ? `${n.busy ?? 0} of ${n.slots} busy` : `${n.encoding} of ${n.slots} converting${n.busy > n.encoding ? `, ${n.busy - n.encoding} waiting` : ''}`}` : ''}</p>
        <label class="check"><input type="checkbox" data-trust="${esc(n.id)}"${n.trusted ? ' checked' : ''}> <span><b>Trusted</b> <span class="muted small">${n.trusted ? 'its encodes skip the picture check (streams, length, frames and driving data are still verified)' : 'its encodes get a picture check here; trust only a computer of your own'}</span></span></label>
        ${d.cars.length ? `<div><b class="small">Vehicles first</b> <span class="muted small">${list.length ? 'automatic conversion sends these vehicles’ new clips here first, in this order' : 'none: it helps whichever vehicle converts'}</span>
          ${list.length ? `<ol class="cars-first" style="margin-top:8px">${list.map((id, i) => `<li><span class="rank">${i + 1}</span><span>${esc(carName(id))}</span>${i ? `<button class="btn ghost icon" type="button" data-car-up="${esc(n.id)}" data-car="${esc(id)}" aria-label="Move ${esc(carName(id))} up">${icon('up')}</button>` : ''}<button class="btn ghost icon" type="button" data-car-rm="${esc(n.id)}" data-car="${esc(id)}" aria-label="Remove ${esc(carName(id))}">${icon('x')}</button></li>`).join('')}</ol>` : ''}
          ${left.length ? `<label class="field" style="margin-top:8px;max-width:320px"><span class="sr-only">Add a vehicle for ${esc(n.name)}</span><select class="input" data-car-add="${esc(n.id)}"><option value="">Add a vehicle…</option>${left.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></label>` : ''}</div>` : ''}
        ${benchHtml(n, d.benches[n.id], running)}
        <div class="row"><button class="btn sm" type="button" data-rename="${esc(n.id)}">Rename</button><button class="btn sm danger" type="button" data-remove="${esc(n.id)}">${icon('trash')} Remove</button></div>
      </article>`;
    }

    function workerHtml(w) {
      if (!w.available) return '<p class="muted">This server runs without its own HTTPS (TLS_MODE=off), so it can’t be a node: a main server must be able to check its certificate.</p>';
      const p = w.pairing;
      const mins = p ? Math.max(1, Math.round((p.expiresAt - Date.now()) / 60000)) : 0;
      return `<p class="lead">A main server paired here sends this one clips to encode and takes the results back. It can do nothing else: no footage, settings or passwords.</p>
        <div class="form" style="margin-top:14px">
          <label class="check full"><input type="checkbox" id="w-on"${w.enabled ? ' checked' : ''}> Encode for paired main servers${w.busy ? ` <span class="chip teal">${w.busy} busy</span>` : ''}</label>
          <label class="field">Clips at once<select class="input" id="w-slots">${[1, 2, 3, 4, 6, 8].map((n) => `<option${n === w.slots ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="field">Encode with<select class="input" id="w-use">${[['gpu', 'GPU (CPU without one)'], ['gpu-cpu', 'GPU, then CPU if it fails'], ['cpu', 'CPU only']].map(([v, t]) => `<option value="${v}"${v === w.use ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        </div>
        ${p ? `<div class="note ok" style="margin-top:14px"><p class="small">Pairing code · one use · ${plural(mins, 'minute')} left</p><p class="pair-code">${esc(p.code)}</p>
            <p class="small">On the main server: Nodes → Pair a node, with this server’s address <b class="mono">${esc(location.host)}</b> and this code.</p><div class="actions start"><button class="btn sm" type="button" id="pair-cancel">Cancel code</button></div></div>`
          : `<div class="actions start"><button class="btn" type="button" id="pair-start">${icon('key')} Show a pairing code</button></div>`}
        ${w.mains.length ? `<h3 style="margin-top:18px">Main servers using this one</h3><div class="stack" style="margin-top:10px;gap:10px">${w.mains.map((m) => `<div class="bin-item"><div><b>${esc(m.name)}</b><br><span class="muted small">${esc(m.address || '')} · paired ${esc(when(m.pairedAt))}${m.lastSeenAt ? ` · seen ${esc(when(m.lastSeenAt))}` : ''}</span></div><div class="row"><button class="btn sm danger" type="button" data-revoke="${esc(m.id)}">Revoke</button></div></div>`).join('')}</div>` : ''}`;
    }

    async function draw() {
      let d;
      try { d = await load(); } catch (err) {
        body.innerHTML = `<p class="note bad">${esc(err.message)}</p>`;
        return;
      }
      if (dead) return;
      const running = Object.values(d.benches).some((b) => b?.state === 'running');
      const typed = $$('#pair-form input', body).some((i) => i.value);
      const keepAddr = $('#n-addr', body)?.value || '';
      const keepCode = $('#n-code', body)?.value || '';
      body.innerHTML = `<div class="grid2" style="align-items:start">
        <section class="panel"><div class="panel-head"><h2>Nodes this server uses</h2><span class="chip">${plural(d.nodes.length, 'node')}</span></div>
          <p class="lead">Other servers running Sentry Six Manager can encode clips for this one. Each clip goes to the node over HTTPS and is checked here before anything is saved. Nodes never get share passwords and never touch the footage.</p>
          <div style="margin-top:16px">${d.nodes.length ? d.nodes.map((n) => nodeHtml(n, d, running)).join('') : empty('No nodes yet', 'Pair one below.')}</div>
          ${d.nodes.length ? `<p class="muted small" style="margin-top:12px">Each node is a lane in the Encoder: set how many clips it converts at once there.</p><div class="actions start"><a class="btn sm" href="#/encoder">${icon('orbit')} Encoder</a></div>` : ''}
          <form id="pair-form" class="form" style="margin-top:18px" novalidate>
            <h3 class="full">Pair a node</h3>
            <label class="field">Node address<input class="input" id="n-addr" name="address" placeholder="192.168.1.30 or nas.local:9000" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>
            <label class="field">Pairing code<input class="input mono" id="n-code" name="code" placeholder="ABCD-EFGH-JKLM" autocomplete="off" autocapitalize="characters" spellcheck="false" required></label>
            <p class="muted small full">On the other server: Nodes → Let another server use this one → Show a pairing code.</p>
            <div class="full actions" style="margin-top:0"><button class="btn primary" type="submit">${icon('plus')} Pair node</button></div>
          </form></section>
        <section class="panel"><div class="panel-head"><h2>Let another server use this one</h2></div>${workerHtml(d.worker)}</section></div>`;
      if (typed || keepAddr || keepCode) {
        $('#n-addr', body).value = keepAddr;
        $('#n-code', body).value = keepCode;
      }
      clearTimeout(timer);
      if (d.nodes.length || running || d.worker.pairing) timer = setTimeout(follow, running ? 2500 : 6000);
    }
    const follow = () => {
      if (dead) return;
      const a = document.activeElement;
      if (document.hidden || (a && body.contains(a) && a.matches('input, select, textarea')) || document.querySelector('dialog[open]') || saving) {
        timer = setTimeout(follow, 3000);
        return;
      }
      draw();
    };
    const once = (fn) => async (...args) => {
      if (saving) return;
      saving = true;
      try { await fn(...args); } finally { saving = false; }
      draw();
    };
    const nodeName = (id) => $(`[data-rename="${CSS.escape(id)}"]`, body)?.closest('.node-card')?.querySelector('h3')?.textContent || '';
    const carsOf = (id) => [...$$(`[data-car-rm="${CSS.escape(id)}"]`, body)].map((b) => b.dataset.car);

    body.addEventListener('submit', once(async (e) => {
      if (e.target.id !== 'pair-form') return;
      e.preventDefault();
      const f = new FormData(e.target);
      if (!f.get('address') || !f.get('code')) { toast('Enter the node’s address and its pairing code.', 'bad'); return; }
      try {
        await api('/api/nodes', { body: { address: String(f.get('address')).trim(), code: String(f.get('code')).trim() } });
        toast('Node paired. Set its clips in the Encoder.');
        e.target.reset();
      } catch (err) { toast(err.message, 'bad'); }
    }));
    body.addEventListener('click', async (e) => {
      const t = e.target;
      const b = t.closest('[data-bench]');
      if (b) return once(async () => { await api(`/api/nodes/${encodeURIComponent(b.dataset.bench)}/benchmark`, { body: { codec: b.dataset.codec } }).catch((err) => toast(err.message, 'bad')); })();
      const bc = t.closest('[data-bench-cancel]');
      if (bc) return once(async () => { await api(`/api/nodes/${encodeURIComponent(bc.dataset.benchCancel)}/benchmark`, { method: 'DELETE' }).catch(() => {}); })();
      const bu = t.closest('[data-bench-use]');
      if (bu) {
        return once(async () => {
          const level = Number(bu.dataset.level);
          try {
            await api(`/api/nodes/${encodeURIComponent(bu.dataset.benchUse)}/slots`, { body: { slots: level } });
            const f = store.get('enc-form', null);
            if (f) { f.lanes = { ...(f.lanes || {}), [`node:${bu.dataset.benchUse}`]: level }; store.set('enc-form', f); }
            toast(`The node now converts ${level} at once; its Encoder lane is set to ${level} too.`);
          } catch (err) { toast(err.message, 'bad'); }
        })();
      }
      const rn = t.closest('[data-rename]');
      if (rn) {
        return once(async () => {
          const name = await promptDialog({ title: 'Rename node', label: 'Name', value: nodeName(rn.dataset.rename), maxlength: 64, body: '<p class="muted small">Shown here and in the Encoder. The node keeps its own name.</p>' });
          if (!name || !name.trim()) return;
          await api(`/api/nodes/${encodeURIComponent(rn.dataset.rename)}`, { method: 'PUT', body: { name: name.trim() } }).catch((err) => toast(err.message, 'bad'));
        })();
      }
      const rm = t.closest('[data-remove]');
      if (rm) {
        return once(async () => {
          if (!(await confirmDialog({ title: 'Remove this node?', body: `<p><b>${esc(nodeName(rm.dataset.remove))}</b> gets no more clips from this server. To use it again, pair it again with a new code.</p>`, ok: 'Remove', danger: true }))) return;
          await api(`/api/nodes/${encodeURIComponent(rm.dataset.remove)}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'bad'));
        })();
      }
      const up = t.closest('[data-car-up]');
      if (up) {
        return once(async () => {
          const list = carsOf(up.dataset.carUp);
          const i = list.indexOf(up.dataset.car);
          if (i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
          await api(`/api/nodes/${encodeURIComponent(up.dataset.carUp)}`, { method: 'PUT', body: { cars: list } }).catch((err) => toast(err.message, 'bad'));
        })();
      }
      const cr = t.closest('[data-car-rm]');
      if (cr) return once(async () => { await api(`/api/nodes/${encodeURIComponent(cr.dataset.carRm)}`, { method: 'PUT', body: { cars: carsOf(cr.dataset.carRm).filter((x) => x !== cr.dataset.car) } }).catch((err) => toast(err.message, 'bad')); })();
      if (t.closest('#pair-start')) return once(async () => { await api('/api/nodes/worker/pair', { body: {} }).catch((err) => toast(err.message, 'bad')); })();
      if (t.closest('#pair-cancel')) return once(async () => { await api('/api/nodes/worker/pair', { method: 'DELETE' }).catch(() => {}); })();
      const rv = t.closest('[data-revoke]');
      if (rv) {
        return once(async () => {
          if (!(await confirmDialog({ title: 'Revoke this main server?', body: '<p>It can no longer send clips here. Clips it is converting now stop.</p>', ok: 'Revoke', danger: true }))) return;
          await api(`/api/nodes/worker/mains/${encodeURIComponent(rv.dataset.revoke)}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'bad'));
        })();
      }
      return undefined;
    });
    body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('[data-trust]')) {
        once(async () => {
          const on = t.checked;
          if (on && !(await confirmDialog({ title: 'Trust this node?', body: '<p>Its encodes will replace your originals without the picture check. Only for a computer of your own that nobody else can change. The server asks for your password.</p>', ok: 'Trust it' }))) return;
          try {
            await api(`/api/nodes/${encodeURIComponent(t.dataset.trust)}`, { method: 'PUT', body: { trusted: on } });
            toast(on ? 'Trusted: its encodes skip the picture check.' : 'Not trusted: its encodes get the picture check.');
          } catch (err) { toast(err.message, 'bad'); }
        })();
        return;
      }
      if (t.matches('[data-car-add]') && t.value) {
        once(async () => { await api(`/api/nodes/${encodeURIComponent(t.dataset.carAdd)}`, { method: 'PUT', body: { cars: [...carsOf(t.dataset.carAdd), t.value] } }).catch((err) => toast(err.message, 'bad')); })();
        return;
      }
      if (['w-on', 'w-slots', 'w-use'].includes(t.id)) {
        once(async () => {
          try {
            await api('/api/nodes/worker', { body: { enabled: $('#w-on', body).checked, slots: Number($('#w-slots', body).value), use: $('#w-use', body).value } });
            toast('Saved.');
          } catch (err) { toast(err.message, 'bad'); }
        })();
      }
    });

    body.innerHTML = '<p class="loading">Looking for nodes…</p>';
    await draw();
    return {
      refresh() { if (!saving) draw(); },
      destroy() { dead = true; clearTimeout(timer); }
    };
  }
};
