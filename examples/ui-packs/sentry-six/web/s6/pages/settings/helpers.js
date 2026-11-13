import { ownedRender } from '../../core.js';
import { esc } from '../../core.js';
import { icon } from '../../icons.js';
import { plural, ago as when } from '../../format.js';
async function renderPage(page, ctx) {
  const { api, confirmDialog, toast } = ctx.scope;
  const render = ctx.render,
    $ = (id) => page.querySelector('#' + id) || document.getElementById(id);
  let nodeSaving = false;

  const [{ nodes, worker }, { vehicles: cars = [] }] = await Promise.all([
    api('/api/nodes'),
    api('/api/vehicles').catch(() => ({ vehicles: [] })),
  ]);
  const benches = Object.fromEntries(
    await Promise.all(
      nodes.map(async (n) => [
        n.id,
        (await api(`/api/nodes/${encodeURIComponent(n.id)}/benchmark`).catch(() => ({})))
          .benchmark || null,
      ]),
    ),
  );
  if (!ctx.alive()) return;
  const benchRunning = Object.values(benches).some((b) => b?.state === 'running');
  const benchPanel = (n) => {
    const b = benches[n.id];
    if (!b) return '';
    const codec = b.codec === 'av1' ? 'AV1' : 'H.265';
    // (a node that lists its GPUs is measured on its default one: its first GPU, else its CPU)
    const on = n.defaultDeviceName ? ` on ${esc(n.defaultDeviceName)}` : '';
    const rows = b.results
      .map(
        (r) =>
          `<tr${r.level === b.suggested ? ' class="is-best"' : ''}><td>${r.level} at once</td><td>${r.failed ? `${r.failed} failed` : `${r.clipsPerMinute} clips/min`}</td><td class="muted small">${plural(r.clips, 'clip')} in ${r.seconds} s</td></tr>`,
      )
      .join('');
    return `<div class="node-panel node-bench">
        <div><b>Benchmark, ${codec}${on}</b> <span class="muted small">${b.state === 'running' ? esc(b.phase || 'Running') + '…' : b.state === 'failed' ? `failed: ${esc(b.error || '')}` : b.state === 'cancelled' ? 'cancelled' : `done${b.samples ? ` · ${plural(b.samples, 'sample clip')} from your footage, only read${b.converted ? ' (already converted ones: no originals are left)' : ''}` : ''}`}</span></div>
        ${rows ? `<table class="table" style="margin-top:8px"><tbody>${rows}</tbody></table>` : ''}
        <div class="form-actions" style="margin-top:8px">
          ${
            b.state === 'running'
              ? `<button class="btn sm" data-bench-cancel="${esc(n.id)}">Cancel</button>`
              : `${b.suggested ? `<button class="btn sm solid" data-bench-use="${esc(n.id)}" data-level="${b.suggested}">Use ${b.suggested} at once${on}</button>` : ''}<button class="btn sm" data-bench-start="${esc(n.id)}" data-codec="${esc(b.codec)}">Run again</button>`
          }
        </div></div>`;
  };
  // the vehicles a node converts for first, in order (automatic conversion)
  const carName = (id) => cars.find((v) => v.id === id)?.name || id;
  const carsPanel = (n) => {
    if (!cars.length) return '';
    const list = n.cars || [];
    const left = cars.filter((v) => !list.includes(v.id));
    const items = list
      .map(
        (id, i) =>
          `<li><span class="node-car-rank">${i + 1}</span><span class="grow">${esc(carName(id))}</span>${i > 0 ? `<button class="btn sm ghost" data-car-up="${esc(n.id)}" data-car="${esc(id)}" aria-label="Move ${esc(carName(id))} up">↑</button>` : ''}<button class="btn sm ghost" data-car-remove="${esc(n.id)}" data-car="${esc(id)}" aria-label="Remove ${esc(carName(id))}">✕</button></li>`,
      )
      .join('');
    return `<div class="node-panel node-cars">
        <b>Vehicles first</b> <span class="muted small">${list.length ? "Automatic conversion sends this node these vehicles' new clips first, in this order; with none waiting, it helps the others." : 'None: it helps whichever vehicle is converting.'}</span>
        ${items ? `<ol class="node-car-list">${items}</ol>` : ''}
        ${left.length ? `<select class="input node-car-add" data-car-add="${esc(n.id)}" aria-label="Add a vehicle for ${esc(n.name)}"><option value="">Add a vehicle…</option>${left.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select>` : ''}
      </div>`;
  };
  // a node of your own: its encodes skip the picture check (faster, less safe)
  const trustPanel = (
    n,
  ) => `<div class="node-panel"><label class="check node-trust">
        <input type="checkbox" data-node-trust="${esc(n.id)}"${n.trusted ? ' checked' : ''}>
        <span><b>Trusted</b> <span class="muted small">${
          n.trusted
            ? 'Its encodes replace originals without the picture check (streams, length, frames and telemetry are still verified). Turn off if anyone else could change this computer.'
            : 'Its encodes get the picture check here: a few random stretches of each clip compared with the original. Trust only a computer of your own: it skips that check.'
        }</span></span>
      </label></div>`;
  const encodersText = (e) =>
    [
      ['H.265', e?.h265],
      ['AV1', e?.av1],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${esc(v)}`)
      .join(' · ') || '—';
  // a node that lists its GPUs and CPU: each with its encoders
  const nodeEncoders = (n) =>
    Array.isArray(n.devices) && n.devices.length
      ? n.devices
          .map(
            (d) =>
              `<span class="words"><b>${esc(d.name)}</b><br><span class="muted">${encodersText(d.encoders)}</span></span>`,
          )
          .join('<br>')
      : encodersText(n.encoders);
  const nodeRows = nodes
    .map(
      (n) => `<section class="node"><div class="node-head">
        <div class="node-name"><b>${esc(n.name)}</b><span class="muted small mono">${esc(n.address)}</span></div>
        <div>${n.online ? '<span class="chip green"><span class="dot ok"></span>Online</span>' : `<span class="chip red"><span class="dot bad"></span>Offline</span><div class="muted small words">${esc(n.error || '')}</div>`}</div>
        <div class="small node-encoders">${nodeEncoders(n)}</div>
        <div class="small node-clips">${n.online && n.slots ? (n.encoding === null ? `${n.busy ?? 0} of ${n.slots} busy` : `${n.encoding} of ${n.slots} converting${n.busy > n.encoding ? ` · ${n.busy - n.encoding} waiting` : ''}`) : '—'}</div>
        <div class="node-actions">${n.online && !benches[n.id] ? `<button class="btn sm" data-bench-start="${esc(n.id)}" data-codec="h265"${benchRunning ? ' disabled' : ''}>Benchmark</button>${n.encoders?.av1 ? `<button class="btn sm" data-bench-start="${esc(n.id)}" data-codec="av1"${benchRunning ? ' disabled' : ''}>Benchmark AV1</button>` : ''}` : ''}<button class="btn sm" data-rename-node="${esc(n.id)}">Rename</button><button class="btn sm" data-remove-node="${esc(n.id)}">Remove</button></div></div>${benchPanel(n)}${carsPanel(n)}${trustPanel(n)}</section>`,
    )
    .join('');
  const pairing = worker.pairing;
  const mins = pairing ? Math.max(1, Math.round((pairing.expiresAt - Date.now()) / 60000)) : 0;
  const mainRows = worker.mains
    .map(
      (m) => `<tr>
        <td class="words"><b>${esc(m.name)}</b><br><span class="muted small mono">${esc(m.address || '')}</span></td>
        <td class="small">Paired ${when(m.pairedAt)}${m.lastSeenAt ? `<br><span class="muted">last seen ${when(m.lastSeenAt)}</span>` : ''}</td>
        <td class="actions"><button class="btn sm" data-revoke-main="${esc(m.id)}">Revoke</button></td></tr>`,
    )
    .join('');

  document.title = 'Nodes · Settings · Sentry Six Manager';
  page.innerHTML = `
      <div class="card"><h2>Nodes this server uses</h2>
        <p class="muted" style="margin-top:6px">Other servers running Sentry Six Manager can encode clips for this one. This server reads each clip, sends it to the node over HTTPS and checks the encoded file before it saves anything, as with its own GPUs. Nodes never get your share passwords and never touch the footage.</p>
        ${
          nodes.length
            ? `<div class="node-list">${nodeRows}</div>
          <p class="muted small" style="margin-top:10px">Each node is a group under <a href="#/encoder">Encoder</a> → Parallel conversions: open it to pick which of its GPUs (and its CPU) convert, and how many clips each converts at once.</p>`
            : '<p style="margin-top:12px">No nodes yet.</p>'
        }
        <form id="node-add" class="form" style="margin-top:18px">
          <label class="field">Node address<input class="input" name="address" placeholder="192.168.1.30 or nas.local:9000" autocomplete="off" required></label>
          <label class="field">Pairing code<input class="input mono" name="code" placeholder="ABCD-EFGH-JKLM" autocomplete="off" required></label>
          <div class="full form-actions" style="margin-top:0"><button class="btn solid" type="submit">${icon('plus')} Add node</button></div>
        </form>
        <p class="muted small">On the other server, open Settings → Helper servers → Let another server use this one → Show pairing code.</p>
      </div>

      <div class="card" style="margin-top:20px"><h2>Let another server use this one</h2>
        ${
          worker.available
            ? `
        <p class="muted" style="margin-top:6px">Pair a main server here and it sends this server clips to encode, then takes the encoded files back. It can’t do anything else here: no footage, settings or passwords.</p>
        <div class="form" style="margin-top:14px">
          <label class="check"><input type="checkbox" id="worker-on"${worker.enabled ? ' checked' : ''}> Encode for paired main servers</label>
        </div>
        <p class="muted small" style="margin-top:8px">The main server picks which of this server's GPUs (and its CPU) encode, and how many clips each converts at once, in its own Encoder.</p>
        ${
          pairing
            ? `<div class="note green pair-code" style="margin-top:14px">
            <div class="muted small">Pairing code (one use, ${plural(mins, 'minute')} left)</div>
            <div class="mono pair-code-value">${esc(pairing.code)}</div>
            <div class="small">On the main server: Settings → Helper servers → Add node, with this server's address <b class="mono">${esc(location.hostname)}${location.port && location.port !== '9000' ? `:${esc(location.port)}` : ''}</b> and the code.</div>
            <button class="btn sm" id="pair-cancel" style="margin-top:10px">Cancel</button></div>`
            : '<div class="form-actions" style="margin-top:14px"><button class="btn" id="pair-start">Show pairing code</button></div>'
        }
        ${worker.mains.length ? `<table class="table" style="margin-top:16px"><thead><tr><th>Main server</th><th>Paired</th><th></th></tr></thead><tbody>${mainRows}</tbody></table>` : ''}
        `
            : '<p class="muted" style="margin-top:6px">This server runs without its own HTTPS (TLS_MODE=off), so it cannot be a node: a main server must be able to check its certificate.</p>'
        }
      </div>`;

  $('node-add').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/api/nodes', {
        body: { address: f.get('address'), code: f.get('code') },
      });
      toast('Node paired. Set its clips under Encoder → Parallel conversions.');
      if (ctx.alive()) render();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  };
  page.querySelectorAll('[data-bench-start]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        await api(`/api/nodes/${encodeURIComponent(b.dataset.benchStart)}/benchmark`, {
          body: { codec: b.dataset.codec },
        });
      } catch (err) {
        toast(err.message, true);
      }
      if (ctx.alive()) render();
    };
  });
  page.querySelectorAll('[data-bench-cancel]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/nodes/${encodeURIComponent(b.dataset.benchCancel)}/benchmark`, {
        method: 'DELETE',
      }).catch(() => {});
      if (ctx.alive()) render();
    };
  });
  page.querySelectorAll('[data-bench-use]').forEach((b) => {
    b.onclick = async () => {
      const level = Number(b.dataset.level);
      const n = nodes.find((x) => x.id === b.dataset.benchUse);
      try {
        // the device that was benchmarked (the node's default one), on the node
        await api(`/api/nodes/${encodeURIComponent(b.dataset.benchUse)}/slots`, {
          body: { slots: level },
        });
        // and its row under Encoder > Parallel conversions, for the next run
        try {
          const key = 'converterLanes';
          const lanes = JSON.parse(localStorage.getItem(key) || '{}') || {};
          const lane = n?.defaultLane || `node:${b.dataset.benchUse}`;
          lanes[lane] = level;
          // (the whole-node row of before stands for the same device)
          if (lane !== `node:${b.dataset.benchUse}`) delete lanes[`node:${b.dataset.benchUse}`];
          localStorage.setItem(key, JSON.stringify(lanes));
        } catch {
          /* a preference only */
        }
        toast(
          n?.defaultDeviceName
            ? `${n.defaultDeviceName} on ${n.name} now converts ${level} at once; its row under Encoder is set to ${level} too.`
            : `The node now converts ${level} at once; its Encoder row is set to ${level} too.`,
        );
      } catch (err) {
        toast(err.message, true);
      }
      if (ctx.alive()) render();
    };
  });
  // follow a running benchmark, and the nodes' clips (converting, waiting)
  // while any node is paired: the numbers were the ones from when the page
  // opened. Hidden tabs and something being typed or picked wait.
  if (benchRunning || nodes.length) {
    const every = benchRunning ? 2500 : 5000;
    const follow = () => {
      if (!ctx.alive() || !location.hash.startsWith('#/settings/helpers')) return;
      // (nor a node address or pairing code typed and not sent yet)
      const typed = [...page.querySelectorAll('input[name="address"], input[name="code"]')].some(
        (input) => input.value,
      );
      if (document.hidden || typed || document.activeElement?.matches?.('input, select, textarea'))
        setTimeout(follow, every);
      else render();
    };
    setTimeout(follow, every);
  }
  // one node change at a time: a second click while one saves would work
  // from the list as it was before the first
  const once =
    (fn) =>
    async (...args) => {
      if (nodeSaving) return;
      nodeSaving = true;
      try {
        await fn(...args);
      } finally {
        nodeSaving = false;
      }
    };
  page.querySelectorAll('[data-node-trust]').forEach((box) => {
    box.addEventListener(
      'change',
      once(async () => {
        const on = box.checked;
        if (
          on &&
          !confirm(
            'Trust this node? Its encodes will replace your originals without the picture check. Only for a computer of your own that nobody else can change.',
          )
        ) {
          box.checked = false;
          return;
        }
        try {
          await api(`/api/nodes/${encodeURIComponent(box.dataset.nodeTrust)}`, {
            method: 'PUT',
            body: { trusted: on },
          });
          toast(
            on
              ? 'Trusted: its encodes skip the picture check.'
              : 'Not trusted: its encodes get the picture check.',
          );
        } catch (err) {
          toast(err.message, true);
        }
        if (ctx.alive()) render();
      }),
    );
  });
  const saveCars = once(async (id, list) => {
    await api(`/api/nodes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: { cars: list },
    }).catch((err) => toast(err.message, true));
    if (ctx.alive()) render();
  });
  const carsOf = (id) => [...(nodes.find((x) => x.id === id)?.cars || [])];
  page.querySelectorAll('[data-car-add]').forEach((sel) => {
    sel.onchange = () => {
      if (sel.value) saveCars(sel.dataset.carAdd, [...carsOf(sel.dataset.carAdd), sel.value]);
    };
  });
  page.querySelectorAll('[data-car-remove]').forEach((b) => {
    b.onclick = () =>
      saveCars(
        b.dataset.carRemove,
        carsOf(b.dataset.carRemove).filter((id) => id !== b.dataset.car),
      );
  });
  page.querySelectorAll('[data-car-up]').forEach((b) => {
    b.onclick = () => {
      const list = carsOf(b.dataset.carUp);
      const i = list.indexOf(b.dataset.car);
      if (i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
      saveCars(b.dataset.carUp, list);
    };
  });
  page.querySelectorAll('[data-rename-node]').forEach((b) => {
    b.onclick = once(async () => {
      const n = nodes.find((x) => x.id === b.dataset.renameNode);
      const asked = confirmDialog({
        title: 'Rename node',
        ok: 'Save',
        body: `<label class="field">Name<input class="input" id="node-new-name" maxlength="64" autocomplete="off" value="${esc(n?.name || '')}"></label><p class="muted small">Shown here and under Encoder → Parallel conversions. The node itself keeps its own name.</p>`,
      });
      const input = $('node-new-name');
      input.select();
      // Enter saves (the dialog's first button is Cancel)
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          document.querySelector('dialog[open]').close('ok');
        }
      };
      const ok = await asked;
      const name = input.value.trim();
      if (!ok || !name || name === n?.name) return;
      await api(`/api/nodes/${encodeURIComponent(b.dataset.renameNode)}`, {
        method: 'PUT',
        body: { name },
      }).catch((err) => toast(err.message, true));
      if (ctx.alive()) render();
    });
  });
  page.querySelectorAll('[data-remove-node]').forEach((b) => {
    b.onclick = once(async () => {
      const n = nodes.find((x) => x.id === b.dataset.removeNode);
      if (
        !(await confirmDialog({
          title: 'Remove this node?',
          body: `<p><b>${esc(n?.name || '')}</b> gets no more clips from this server. To use it again, pair it again with a new code.</p>`,
          ok: 'Remove',
        }))
      )
        return;
      await api(`/api/nodes/${encodeURIComponent(b.dataset.removeNode)}`, {
        method: 'DELETE',
      }).catch((err) => toast(err.message, true));
      if (ctx.alive()) render();
    });
  });
  if (!worker.available) return;
  const saveWorker = async () => {
    try {
      await api('/api/nodes/worker', {
        body: { enabled: $('worker-on').checked },
      });
    } catch (err) {
      toast(err.message, true);
    }
    if (ctx.alive()) render();
  };
  $('worker-on').onchange = saveWorker;
  if ($('pair-start'))
    $('pair-start').onclick = async () => {
      try {
        await api('/api/nodes/worker/pair', { body: {} });
      } catch (err) {
        toast(err.message, true);
      }
      if (ctx.alive()) render();
    };
  if ($('pair-cancel'))
    $('pair-cancel').onclick = async () => {
      await api('/api/nodes/worker/pair', { method: 'DELETE' }).catch(() => {});
      if (ctx.alive()) render();
    };
  page.querySelectorAll('[data-revoke-main]').forEach((b) => {
    b.onclick = async () => {
      const m = worker.mains.find((x) => x.id === b.dataset.revokeMain);
      if (
        !(await confirmDialog({
          title: 'Revoke this main server?',
          body: `<p><b>${esc(m?.name || '')}</b> can no longer send clips here. Clips it is converting now stop.</p>`,
          ok: 'Revoke',
          danger: true,
        }))
      )
        return;
      await api(`/api/nodes/worker/mains/${encodeURIComponent(b.dataset.revokeMain)}`, {
        method: 'DELETE',
      }).catch((err) => toast(err.message, true));
      if (ctx.alive()) render();
    };
  });
}

export const render = ownedRender(renderPage);
