// Nodes: other servers that convert clips for this one (each one is an extra
// engine on the Encoder page), and this server working as a node for another.
import { h, ico, api, app, toast, ask, askText, act, stamp, since, count, pill, panelHead, blank } from '../core.js';

export default {
  async mount(el, { alive, status }) {
    let timer = 0;
    let on = true;
    let saving = false;

    async function draw(force = true) {
      const { nodes, worker } = await api('/api/nodes');
      const benches = Object.fromEntries(await Promise.all(nodes.map(async (n) => [n.id, (await api(`/api/nodes/${encodeURIComponent(n.id)}/benchmark`).catch(() => ({}))).benchmark || null])));
      if (!on) return;
      const running = Object.values(benches).some((b) => b?.state === 'running');
      const typing = [...el.querySelectorAll('#n-pair input')].some((i) => i.value) || (el.contains(document.activeElement) && document.activeElement.matches('input, select'));
      if (!force && typing) { later(4000); return; }
      const carName = (id) => app.vehicles.find((x) => x.id === id)?.name || id;
      const encs = (e) => [['H.265', e?.h265], ['AV1', e?.av1]].filter(([, x]) => x).map(([k, x]) => `${k} <span class="mono small">${h(x)}</span>`).join(' · ') || '—';
      const card = (n) => {
        const b = benches[n.id];
        const list = n.cars || [];
        const left = app.vehicles.filter((x) => !list.includes(x.id));
        return `<article class="panel hud ${n.online ? 'cyan' : 'orange'} node">
          ${panelHead(`${ico('nodes')}${h(n.name)}`, n.online ? pill('online', 'grn') : pill('offline', 'red'))}
          <p class="mono small faint">${h(n.address)}</p>
          ${n.online ? '' : `<p class="small badtx">${h(n.error || '')}</p>`}
          <dl class="kv" style="margin-top:8px"><dt>Encoders</dt><dd>${encs(n.encoders)}</dd>
            <dt>Clips</dt><dd class="num">${n.online && n.slots ? (n.encoding === null ? `${h(n.busy ?? 0)} of ${h(n.slots)} busy` : `${h(n.encoding)} of ${h(n.slots)} converting${n.busy > n.encoding ? ` · ${h(n.busy - n.encoding)} waiting` : ''}`) : '—'}</dd>
            <dt>Paired</dt><dd>${h(stamp(n.pairedAt))}</dd><dt>Fingerprint</dt><dd class="mono small wrap-any">${h(n.fingerprint || '—')}</dd></dl>
          <div class="nsub"><b class="small">Vehicles first</b><p class="small faint">${list.length ? "Automatic conversion sends these vehicles' clips here first, in this order." : 'None: it helps whichever vehicle is converting.'}</p>
            ${list.length ? `<ol class="carlist">${list.map((id, i) => `<li><span class="num faint">${i + 1}</span><span class="grow">${h(carName(id))}</span><button class="btn icon ghost" type="button" data-up="${h(n.id)}" data-car="${h(id)}" aria-label="Move ${h(carName(id))} up"${i ? '' : ' disabled'}>${ico('up')}</button><button class="btn icon ghost" type="button" data-rm="${h(n.id)}" data-car="${h(id)}" aria-label="Remove ${h(carName(id))}">${ico('x')}</button></li>`).join('')}</ol>` : ''}
            ${left.length ? `<label class="sr-only" for="add-${h(n.id)}">Add a vehicle for ${h(n.name)}</label><select class="in" id="add-${h(n.id)}" data-add="${h(n.id)}"><option value="">Add a vehicle…</option>${left.map((x) => `<option value="${h(x.id)}">${h(x.name)}</option>`).join('')}</select>` : ''}</div>
          <label class="chk nsub"><input type="checkbox" data-trust="${h(n.id)}"${n.trusted ? ' checked' : ''}><span><b>Trusted</b> <span class="small faint">${n.trusted ? 'its encodes replace originals without the picture check (streams, length, frames and telemetry are still verified)' : 'its encodes get the picture check here; trust only a computer of your own'}</span></span></label>
          ${b ? `<div class="nsub"><b class="small">Dyno run · ${h(b.codec === 'av1' ? 'AV1' : 'H.265')}</b> <span class="small faint">${b.state === 'running' ? `${h(b.phase || 'running')}…` : b.state === 'failed' ? `failed: ${h(b.error || '')}` : h(b.state)}${b.samples ? ` · ${h(count(b.samples, 'sample clip'))}` : ''}</span>
            ${(b.results || []).length ? `<div class="tblwrap"><table class="tbl"><tbody>${b.results.map((r) => `<tr class="${r.level === b.suggested ? 'hi' : ''}"><td class="num">${h(r.level)} at once</td><td class="num">${r.failed ? `${h(r.failed)} failed` : `${h(r.clipsPerMinute)} clips/min`}</td><td class="small faint num">${h(r.clips)} clips in ${h(r.seconds)} s</td></tr>`).join('')}</tbody></table></div>` : ''}
            <div class="row">${b.state === 'running' ? `<button class="btn sm" type="button" data-bstop="${h(n.id)}">${ico('stop')}Stop</button>` : `${b.suggested ? `<button class="btn sm go" type="button" data-buse="${h(n.id)}" data-level="${h(b.suggested)}">Use ${h(b.suggested)} at once</button>` : ''}<button class="btn sm" type="button" data-bench="${h(n.id)}" data-codec="${h(b.codec)}">Run again</button>`}</div></div>` : ''}
          <div class="row nsub">
            ${n.online && !b ? `<button class="btn sm" type="button" data-bench="${h(n.id)}" data-codec="h265"${running ? ' disabled' : ''}>${ico('tacho')}Dyno run</button>${n.encoders?.av1 ? `<button class="btn sm" type="button" data-bench="${h(n.id)}" data-codec="av1"${running ? ' disabled' : ''}>Dyno run AV1</button>` : ''}` : ''}
            <button class="btn sm" type="button" data-rename="${h(n.id)}">Rename</button>
            <button class="btn sm danger" type="button" data-remove="${h(n.id)}">${ico('bin')}Remove</button>
          </div></article>`;
      };
      const pairing = worker.pairing;
      const mins = pairing ? Math.max(1, Math.round((pairing.expiresAt - Date.now()) / 60000)) : 0;
      el.innerHTML = `
        <section class="ptitle hud"><div><h1 class="chrome">Nodes</h1><p>Other servers running Sentry Six Manager can convert clips for this one over pinned HTTPS. Nodes never get share passwords and never touch your footage.</p></div></section>
        <div class="cols">
          <div class="stack">
            <div class="ph strip"><h2>${ico('nodes')}Nodes this server uses</h2><span class="small dim">${count(nodes.length, 'node')}</span></div>
            ${nodes.map(card).join('') || `<section class="panel hud">${blank('No nodes yet. Pair one below.')}</section>`}
            <form class="panel hud orange form" id="n-pair">
              ${panelHead(`${ico('plus')}Pair a node`)}
              <div class="grid2">
                <label class="fld">Node address<input class="in mono" name="address" placeholder="192.168.1.30 or nas.local:9000" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>
                <label class="fld">Pairing code<input class="in mono" name="code" placeholder="ABCD-EFGH-JKLM" autocomplete="off" autocapitalize="characters" spellcheck="false" required></label>
              </div>
              <p class="small faint">On the other server open Nodes → Let another server use this one → Show pairing code. Pairing asks for your password.</p>
              <div class="row"><button class="btn go" type="submit">${ico('plus')}Pair node</button></div>
              ${nodes.length ? '<p class="small faint">Each node becomes an engine block on the Encoder page: set how many clips it converts at once there.</p>' : ''}
            </form>
          </div>
          <section class="panel hud" aria-label="Let another server use this one">
            ${panelHead(`${ico('wifi')}Let another server use this one`, worker.enabled ? pill('node mode on', 'grn') : pill('off', ''))}
            ${worker.available ? `
              <p class="small dim">A main server paired here sends this one clips to convert and takes the results back. It can do nothing else here.</p>
              <div class="grid2" style="margin-top:12px">
                <label class="chk span-all"><input type="checkbox" id="w-on"${worker.enabled ? ' checked' : ''}> Convert for paired main servers</label>
                <label class="fld">Clips at once<select class="in" id="w-slots">${[1, 2, 3, 4, 6, 8].map((x) => `<option${x === worker.slots ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
                <label class="fld">Convert with<select class="in" id="w-use">${[['gpu', 'GPU (the CPU without one)'], ['gpu-cpu', 'GPU, then CPU if it fails'], ['cpu', 'CPU only']].map(([x, l]) => `<option value="${x}"${x === worker.use ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
              </div>
              <p class="small faint" style="margin-top:8px">${worker.busy ? `${worker.busy} clip(s) converting for a main server now · ` : ''}name: <span class="mono">${h(worker.name || '')}</span></p>
              ${pairing ? `<div class="pair"><span class="small dim">Pairing code · single use · ${count(mins, 'minute')} left</span><b class="mono pair-code">${h(pairing.code)}</b><span class="small">On the main server: Nodes → Pair a node, with the address <b class="mono">${h(location.hostname)}${location.port && location.port !== '9000' ? `:${h(location.port)}` : ''}</b> and this code.</span><button class="btn sm" type="button" id="w-cancel">Cancel code</button></div>`
                : '<div class="row" style="margin-top:10px"><button class="btn" type="button" id="w-pair">Show pairing code</button></div>'}
              ${worker.mains.length ? `<h3 class="sub-h">Main servers</h3><div class="tblwrap"><table class="tbl stack"><thead><tr><th>Main server</th><th>Paired</th><th class="r">Access</th></tr></thead><tbody>${worker.mains.map((m) => `<tr><td data-label="Main server"><b>${h(m.name)}</b><div class="mono small faint">${h(m.address || '')}</div></td><td data-label="Paired" class="small">${h(stamp(m.pairedAt))}${m.lastSeenAt ? `<div class="faint">seen ${h(since(m.lastSeenAt))}</div>` : ''}</td><td class="r"><button class="btn sm danger" type="button" data-revoke="${h(m.id)}">Revoke</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="small faint" style="margin-top:10px">No main server uses this one yet.</p>'}`
              : '<p class="dim">This server runs without its own HTTPS (TLS_MODE=off), so it cannot be a node.</p>'}
          </section>
        </div>`;
      status(`${count(nodes.length, 'node')}${worker.enabled ? ' · node mode on' : ''}`);
      wire(nodes, worker);
      later(running ? 2500 : nodes.length ? 6000 : 0);
    }
    function later(ms) {
      clearTimeout(timer);
      if (ms && on) timer = setTimeout(() => { if (on && alive() && document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) draw(false).catch(() => {}); else later(ms); }, ms);
    }
    const once = (fn) => async (...a) => {
      if (saving) return;
      saving = true;
      try { await fn(...a); } finally { saving = false; }
    };
    function wire(nodes, worker) {
      const $ = (s) => el.querySelector(s);
      $('#n-pair').onsubmit = (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        act(e.target.querySelector('[type=submit]'), async () => {
          await api('/api/nodes', { body: { address: f.get('address'), code: f.get('code') } });
          toast('Node paired. Set how many clips it converts at once on the Encoder page.');
          e.target.reset();
          await draw();
        });
      };
      const carsOf = (id) => [...(nodes.find((x) => x.id === id)?.cars || [])];
      const saveCars = once(async (id, cars) => { await act(null, () => api(`/api/nodes/${encodeURIComponent(id)}`, { method: 'PUT', body: { cars } })); await draw(); });
      el.querySelectorAll('[data-add]').forEach((s) => { s.onchange = () => s.value && saveCars(s.dataset.add, [...carsOf(s.dataset.add), s.value]); });
      el.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => saveCars(b.dataset.rm, carsOf(b.dataset.rm).filter((x) => x !== b.dataset.car)); });
      el.querySelectorAll('[data-up]').forEach((b) => {
        b.onclick = () => {
          const l = carsOf(b.dataset.up);
          const i = l.indexOf(b.dataset.car);
          if (i > 0) [l[i - 1], l[i]] = [l[i], l[i - 1]];
          saveCars(b.dataset.up, l);
        };
      });
      el.querySelectorAll('[data-trust]').forEach((box) => {
        box.onchange = once(async () => {
          const want = box.checked;
          if (want && !(await ask({ title: 'Trust this node?', body: '<p>Its encodes will replace your originals without the picture check. Only for a computer of your own that nobody else can change. This asks for your password.</p>', yes: 'Trust it' }))) { box.checked = false; return; }
          await act(null, async () => {
            await api(`/api/nodes/${encodeURIComponent(box.dataset.trust)}`, { method: 'PUT', body: { trusted: want } });
            toast(want ? 'Trusted: its encodes skip the picture check.' : 'Not trusted: its encodes get the picture check.');
          });
          await draw();
        });
      });
      el.querySelectorAll('[data-rename]').forEach((b) => {
        b.onclick = once(async () => {
          const n = nodes.find((x) => x.id === b.dataset.rename);
          const name = await askText({ title: 'Rename node', label: 'Name', value: n?.name || '', max: 64, body: '<p class="small faint">Shown here and on the Encoder page. The node keeps its own name.</p>' });
          if (!name || name.trim() === n?.name) return;
          await act(null, () => api(`/api/nodes/${encodeURIComponent(n.id)}`, { method: 'PUT', body: { name: name.trim() } }));
          await draw();
        });
      });
      el.querySelectorAll('[data-remove]').forEach((b) => {
        b.onclick = once(async () => {
          const n = nodes.find((x) => x.id === b.dataset.remove);
          if (!(await ask({ title: 'Remove this node?', body: `<p><b>${h(n?.name || '')}</b> gets no more clips from this server. Pair it again with a new code to use it.</p>`, yes: 'Remove', danger: true }))) return;
          await act(null, () => api(`/api/nodes/${encodeURIComponent(n.id)}`, { method: 'DELETE' }));
          await draw();
        });
      });
      el.querySelectorAll('[data-bench]').forEach((b) => { b.onclick = () => act(b, async () => { await api(`/api/nodes/${encodeURIComponent(b.dataset.bench)}/benchmark`, { body: { codec: b.dataset.codec } }); await draw(); }); });
      el.querySelectorAll('[data-bstop]').forEach((b) => { b.onclick = () => act(b, async () => { await api(`/api/nodes/${encodeURIComponent(b.dataset.bstop)}/benchmark`, { method: 'DELETE' }); await draw(); }); });
      el.querySelectorAll('[data-buse]').forEach((b) => {
        b.onclick = () => act(b, async () => {
          await api(`/api/nodes/${encodeURIComponent(b.dataset.buse)}/slots`, { body: { slots: Number(b.dataset.level) } });
          toast(`The node now converts ${b.dataset.level} at once.`);
          await draw();
        });
      });
      if (!worker.available) return;
      const saveWorker = () => act(null, async () => {
        await api('/api/nodes/worker', { body: { enabled: $('#w-on').checked, slots: Number($('#w-slots').value), use: $('#w-use').value } });
        toast('Saved.');
        await draw();
      });
      $('#w-on').onchange = saveWorker;
      $('#w-slots').onchange = saveWorker;
      $('#w-use').onchange = saveWorker;
      $('#w-pair')?.addEventListener('click', (e) => act(e.currentTarget, async () => { await api('/api/nodes/worker/pair', { body: {} }); await draw(); }));
      $('#w-cancel')?.addEventListener('click', (e) => act(e.currentTarget, async () => { await api('/api/nodes/worker/pair', { method: 'DELETE' }); await draw(); }));
      el.querySelectorAll('[data-revoke]').forEach((b) => {
        b.onclick = async () => {
          const m = worker.mains.find((x) => x.id === b.dataset.revoke);
          if (!(await ask({ title: 'Revoke this main server?', body: `<p><b>${h(m?.name || '')}</b> can no longer send clips here. Clips it is converting now stop.</p>`, yes: 'Revoke', danger: true }))) return;
          await act(b, () => api(`/api/nodes/worker/mains/${encodeURIComponent(m.id)}`, { method: 'DELETE' }));
          await draw();
        };
      });
    }
    await draw();
    return { unmount() { on = false; clearTimeout(timer); } };
  }
};
