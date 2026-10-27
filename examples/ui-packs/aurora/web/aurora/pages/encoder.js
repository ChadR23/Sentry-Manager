// Encoder: a radial progress ring with an orbiting light for every clip being
// converted (coloured by device), the live numbers beside it, the controls,
// and below: the clips, a new conversion, automatic conversion and a benchmark.

import {
  $, $$, esc, icon, api, invoke, state, current, footageRoot, bytes, plural, pct, num, dur, when, ago, fin, ring, meter, toast,
  confirmDialog, openDialog, store, empty
} from '../core.js';
import { splitDevices, deviceLabel, laneValue, jobLanes, groupMemory, groupBodyId, wireGroups } from '../nodelanes.js';
import { follow, onBenchmark, streamReady, counts, Pace, ACTIVE, PAUSED, STATE_TEXT, CODEC, PROFILES, GROUPS, explain, apply, refreshCurrent } from '../conv.js';

const LANE_COLORS = ['#46f0a8', '#9b7dff', '#2fd6d8', '#e86ee0', '#ffd27a', '#8fd0ff'];
const QUALITY = [['high', 'High'], ['balanced', 'Balanced'], ['small', 'Small']];
const INTERVALS = [[15, 'Every 15 minutes'], [30, 'Every 30 minutes'], [60, 'Every hour'], [180, 'Every 3 hours'], [360, 'Every 6 hours'], [720, 'Every 12 hours'], [1440, 'Once a day']];
const ITEM_TEXT = { queued: 'Waiting', processing: 'Converting', completed: 'Done', skipped: 'Skipped', failed: 'Failed', cancelled: 'Cancelled' };
const PHASES = [['inspect', 'Inspect'], ['source', 'Read source'], ['timeline', 'Timeline'], ['encode', 'Encode'], ['metadata', 'Driving data'], ['checkWait', 'Wait for check'], ['picture', 'Picture check'], ['verify', 'Verify'], ['saveWait', 'Wait to save'], ['save', 'Save'], ['cleanup', 'Clean up']];

// (what was saved over the defaults: the Nodes page may have saved only a lane)
const form = Object.assign({
  codec: 'h265', profileId: 'balanced', qualityLevel: 'balanced', bitrateKbps: 2500, outputMode: 'replace', verifyMode: 'quick',
  groups: ['SavedClips', 'SentryClips', 'RecentClips'], included: ['RecentClips', 'SavedClips', 'SentryClips'], networkMode: 'auto', concurrency: 2, lanes: {}, dest: {}
}, store.get('enc-form', {}));
const saveForm = () => store.set('enc-form', form);
// the next run's number for a device (a node's devices other than its default start at 0)
const laneNext = (d) => laneValue(form.lanes, d, d.kind === 'cpu' ? 0 : 2);
// which node groups are open, per browser
const groupMem = groupMemory(store, 'enc-node-groups');

export default {
  title: 'Encoder',
  kicker: 'Orbit',
  icon: 'orbit',
  topics: ['vehicles'],
  async mount(ctx) {
    const { body } = ctx;
    // (the Nodes page may have set a lane since this page was last open)
    form.lanes = store.get('enc-form', null)?.lanes || form.lanes;
    let snap = null;
    let caps = null;
    let devices = [];
    let ctxInfo = null;
    let auto = null;
    let enc = null; // /api/stats encoder block
    let statsTimer = 0;
    let dead = false;
    let bench = { running: false, progress: null, result: null, error: null };
    const pace = new Pace();
    let vehicleId = current()?.id || null;
    let confirmed = false;
    let vehiclesKey = JSON.stringify(state.vehicles.map((v) => [v.id, v.name, v.share?.writable !== false, footageRoot(v)]));

    body.innerHTML = `<section class="orbit-wrap">
        <div class="orbit" id="orbit" aria-hidden="true"></div>
        <div id="live"></div>
      </section>
      <section class="panel" id="lanes-panel" hidden><div class="panel-head"><h2>Lanes</h2><span class="muted small" id="lanes-sub"></span></div><div class="lane-list" id="lanes"></div></section>
      <section class="panel" id="clips-panel" hidden><div class="panel-head"><h2>Clips</h2><div class="clip-states" id="clip-states"></div></div><div class="items" id="items"></div><div id="timings"></div></section>
      <section class="panel" id="start-panel"></section>
      <section class="panel" id="auto-panel"><div class="panel-head"><h2>Automatic conversion</h2></div><p class="loading">Loading…</p></section>
      <section class="panel" id="bench-panel"></section>`;

    // ---------- the orbit ----------
    function drawOrbit() {
      const c = counts(snap);
      const frac = snap && c.total ? c.done / c.total : 0;
      const active = snap && ACTIVE.has(snap.state);
      // the lanes from /api/stats; until it answers, one light per clip at work
      const busyNow = snap ? (snap.progress?.encodingNow ?? c.working) : 0;
      const workers = enc?.workers?.length ? enc.workers : Array.from({ length: busyNow }, (_, i) => ({ itemId: `w${i}` }));
      const devs = [...new Set(workers.map((w) => w.node || w.deviceId || w.device || (w.hardware ? 'gpu' : 'cpu')))];
      const lanesHtml = (active ? workers : []).map((w, i) => {
        const key = w.node || w.deviceId || w.device || (w.hardware ? 'gpu' : 'cpu');
        const color = LANE_COLORS[devs.indexOf(key) % LANE_COLORS.length];
        const period = 14 + (i % 4) * 3;
        return `<div class="lane${w.started === false || w.waitingOnNode ? ' idle' : ''}" style="--c:${color};--period:${period}s;--delay:${(-(i * period) / Math.max(1, workers.length)).toFixed(2)}s;inset:${-2 - (i % 2) * 3}%"><i></i></div>`;
      }).join('');
      $('#orbit', body).innerHTML = `<div class="orbit-path"></div><div class="orbit-path p2"></div>
        ${ring(frac, { size: 300, stroke: 14, cls: snap?.state === 'failed' ? 'bad' : PAUSED.has(snap?.state) ? 'warn' : '', label: `${pct(frac * 100)} converted` })}
        <div class="lanes${PAUSED.has(snap?.state) ? ' paused-orbit' : ''}">${lanesHtml}</div>
        <div class="orbit-core"><span class="orbit-pct">${snap ? pct(frac * 100) : '—'}</span><span class="orbit-state">${snap ? esc(STATE_TEXT[snap.state] || snap.state) : 'Ready'}</span>${snap ? `<span class="muted small">${c.done} of ${c.total} clips</span>` : ''}</div>`;
      $('#orbit', body).setAttribute('aria-hidden', 'true');
    }

    // ---------- live numbers + controls ----------
    let liveShape = '';
    function drawLive() {
      const el = $('#live', body);
      if (!snap) {
        liveShape = '';
        el.innerHTML = `<h2 style="font-size:30px;font-weight:250">Nothing converting</h2>
          <p class="lead" style="margin-top:8px">Converting the footage to H.265 or AV1 keeps every frame and the driving data, and usually saves a lot of space. Every result is verified before an original is replaced.</p>
          <div class="actions start"><a class="btn primary" href="#start-panel" id="go-start">${icon('plus')} Start a conversion</a></div>`;
        return;
      }
      const c = counts(snap);
      const p = pace.read(snap);
      const active = ACTIVE.has(snap.state);
      const paused = PAUSED.has(snap.state);
      const cfg = snap.config || {};
      const veh = state.vehicles.find((x) => footageRoot(x) === cfg.sourceRoot || x.root === cfg.sourceRoot);
      const saved = snap.summary?.savedBytes ?? snap.counters?.savedBytes ?? 0;
      const src = snap.summary?.sourceVideoBytes ?? snap.counters?.sourceVideoBytes ?? 0;
      const lanes = Array.isArray(cfg.lanes) && cfg.lanes.length ? cfg.lanes : null;
      const prog = snap.progress || {};
      const headHtml = `<p class="muted small">${esc(veh?.name || cfg.sourceRoot || '')} · ${esc(CODEC[cfg.codec] || cfg.codec || '')} · ${esc((PROFILES.find((x) => x[0] === cfg.profileId) || [])[1] || cfg.profileId || '')}${cfg.qualityLevel ? ` (${esc(cfg.qualityLevel)})` : ''} · ${cfg.outputMode === 'replace' ? 'replacing originals' : 'separate folder'} · verify ${esc(cfg.verifyMode || 'full')}${cfg.autoConvert ? ' · automatic' : ''}</p>
        <h2 style="font-size:30px;font-weight:250;margin:6px 0 16px">${esc(STATE_TEXT[snap.state] || snap.state)}</h2>`;
      const statsHtml = `        <div class="enc-stats">
          <div class="stat"><span class="stat-label">Clips</span><span class="stat-val">${c.done} / ${c.total}</span>${meter(c.total ? (c.done / c.total) * 100 : 0)}</div>
          <div class="stat"><span class="stat-label">Speed</span><span class="stat-val">${p.perMin ? `${num(p.perMin, 1)}/min` : '—'}</span><span class="muted tiny">${fin(prog.fps) ? `${num(prog.fps, 1)} fps now` : ''}</span></div>
          <div class="stat"><span class="stat-label">Time left</span><span class="stat-val">${active && !paused ? dur(p.leftMs) : '—'}</span><span class="muted tiny">started ${esc(when(snap.createdAt))}</span></div>
          <div class="stat"><span class="stat-label">Saved</span><span class="stat-val">${bytes(saved)}</span><span class="muted tiny">${src ? `${pct((saved / src) * 100)} of ${bytes(src)}` : ''}</span></div>
          <div class="stat"><span class="stat-label">Working now</span><span class="stat-val">${prog.encodingNow ?? c.working}</span><span class="muted tiny">${prog.waitingOnNode ? `${plural(prog.waitingOnNode, 'clip')} waiting on nodes` : enc?.run?.wh ? `${num(enc.run.wh, 1)} Wh so far` : ''}</span></div>
          <div class="stat"><span class="stat-label">Problems</span><span class="stat-val" style="${c.failed ? 'color:var(--bad)' : ''}">${c.failed}</span><span class="muted tiny">${c.skipped ? `${c.skipped} skipped` : ''}</span></div>
        </div>`;
      const ctrlHtml = `        ${active && !lanes ? `<div class="row" style="margin-top:18px"><span class="small">Conversions at once</span><div class="stepper" role="group" aria-label="Conversions at once"><button class="btn ghost" type="button" data-conc="-1" aria-label="Fewer at once">−</button><output id="conc">${cfg.concurrency || 1}</output><button class="btn ghost" type="button" data-conc="1" aria-label="More at once">+</button></div></div>` : ''}
        ${active && lanes ? `<div class="stack" style="margin-top:18px;gap:8px"><span class="small">Conversions at once, per device</span>${laneSteppers(lanes, true)}</div>` : ''}
        <div class="actions start">
          ${active && !paused ? `<button class="btn" type="button" data-act="pause">${icon('pause')} Pause</button>` : ''}
          ${paused || (snap.state === 'failed' && snap.error?.code === 'RECOVERY_REQUIRED') ? `<button class="btn primary" type="button" data-act="resume">${icon('play')} Resume</button>` : ''}
          ${active ? `<button class="btn danger" type="button" data-act="cancel">${icon('stop')} Cancel</button>` : ''}
          ${['completed', 'failed'].includes(snap.state) && c.failed && snap.error?.code !== 'RECOVERY_REQUIRED' ? `<button class="btn" type="button" data-act="retryFailed">${icon('refresh')} Retry failed</button>` : ''}
          ${snap.state === 'completed' ? `<button class="btn" type="button" data-act="dismissSummary">${icon('check')} Dismiss</button>` : ''}
          <button class="btn${active || snap.state === 'completed' ? ' ghost' : ''}" type="button" data-act="discard" title="${active ? 'For a job that can’t be cancelled: set it aside' : 'Clear this job from the Encoder'}">${active ? 'Set aside' : `${icon('x')} Clear`}</button>
        </div>
        ${snap.error?.code ? `<p class="note bad" style="margin-top:14px">${esc(explain(snap.error))}</p>` : ''}`;
      const shape = JSON.stringify([snap.id, active ? (paused ? 'paused' : 'run') : snap.state, lanes, cfg.concurrency, c.failed > 0, snap.error?.code || '']);
      if (shape !== liveShape || !$('#live-ctrl', el)) {
        liveShape = shape;
        el.innerHTML = `<div id="live-head">${headHtml}</div><div id="live-stats">${statsHtml}</div><div id="live-ctrl">${ctrlHtml}</div>`;
        wireGroups(el, groupMem);
      } else {
        $('#live-head', el).innerHTML = headHtml;
        $('#live-stats', el).innerHTML = statsHtml;
      }
    }

    function laneSteppers(lanes, live) {
      const devs = devices.length ? devices : lanes.map((l) => ({ id: l.device, name: l.device }));
      const running = jobLanes(devs, lanes);
      const valueOf = (d) => (live ? running.get(d.id) || 0 : laneNext(d));
      const scope = live ? 'live' : 'next';
      let color = 0;
      const row = (d, label) => `<div class="lane-row" style="--c:${LANE_COLORS[color++ % LANE_COLORS.length]}"><span class="swatch"></span><span><b>${esc(label)}</b>${d.encoders ? `<br><span class="muted tiny">${d.deviceId === 'cpu' ? 'its CPU cores · slower than a GPU' : ['h265', 'av1'].filter((k) => d.encoders?.[k]).map((k) => CODEC[k]).join(' · ') || (d.online === false ? 'offline' : 'no hardware encoder')}</span>` : ''}</span>
          <div class="stepper" role="group" aria-label="${esc(d.name || d.id)}: conversions at once"><button class="btn ghost" type="button" data-lane="${esc(d.id)}" data-step="-1" data-live="${live ? 1 : 0}" aria-label="Fewer">−</button><output data-lane-value>${valueOf(d)}</output><button class="btn ghost" type="button" data-lane="${esc(d.id)}" data-step="1" data-live="${live ? 1 : 0}" aria-label="More">+</button></div></div>`;
      const { own, nodes } = splitDevices(devs);
      // each node that lists its GPUs: a constellation of its own, opened from its header
      const groups = nodes.map((g) => {
        const total = g.devices.reduce((n, d) => n + (Number(valueOf(d)) || 0), 0);
        const c = LANE_COLORS[color % LANE_COLORS.length];
        return `<div class="lane-group${g.online ? '' : ' offline'}${total ? '' : ' is-off'}" style="--c:${c}" data-group-box>
          <button type="button" class="lane-group-h" data-node-group="${scope}|${esc(g.key)}" aria-expanded="false" aria-controls="${groupBodyId(scope, g.key)}">
            <span class="swatch"></span><span class="lane-group-n"><b>${esc(g.name)}</b><span class="muted tiny">${g.online ? 'Online' : 'Offline: check it under Nodes'} · ${plural(g.devices.length, 'device')}</span></span>
            <span class="chip lane-group-t" data-group-total>${total ? `${total} at once` : 'Off'}</span><span class="chev" aria-hidden="true">${icon('right')}</span></button>
          <div class="lane-group-b lane-list" id="${groupBodyId(scope, g.key)}" role="group" aria-label="${esc(g.name)}: GPUs and CPU" hidden>${g.devices.map((d) => row(d, deviceLabel(d))).join('')}</div></div>`;
      }).join('');
      return own.map((d) => row(d, d.name || d.id)).join('') + groups;
    }
    // each node group's header: its conversions at once in all
    function groupTotals(root) {
      root.querySelectorAll('[data-group-box]').forEach((box) => {
        const n = [...box.querySelectorAll('[data-lane-value]')].reduce((sum, o) => sum + (Number(o.textContent) || 0), 0);
        const out = box.querySelector('[data-group-total]');
        if (out) out.textContent = n ? `${n} at once` : 'Off';
        box.classList.toggle('is-off', n === 0);
      });
    }

    // ---------- lanes (from /api/stats) ----------
    function drawLanes() {
      const panel = $('#lanes-panel', body);
      const workers = (enc?.workers || []);
      const active = snap && ACTIVE.has(snap.state);
      panel.hidden = !active || !workers.length;
      if (panel.hidden) return;
      const keys = [...new Set(workers.map((w) => w.node || w.deviceId || w.device || (w.hardware ? 'gpu' : 'cpu')))];
      $('#lanes-sub', body).textContent = (enc.devices || []).map((d) => `${d.name || 'CPU'}: ${d.workers}${fin(d.video) ? ` · video ${pct(d.video)}` : ''}`).join(' · ');
      $('#lanes', body).innerHTML = workers.map((w) => {
        const key = w.node || w.deviceId || w.device || (w.hardware ? 'gpu' : 'cpu');
        const color = LANE_COLORS[keys.indexOf(key) % LANE_COLORS.length];
        const f = w.durationUs && w.outTimeUs ? (w.outTimeUs / w.durationUs) * 100 : null;
        return `<div class="lane-row" style="--c:${color}"><span class="swatch"></span><span style="min-width:0"><b>${esc(String(w.relativePath || w.itemId || '').split('/').pop())}</b><br><span class="muted tiny">${esc(w.node ? `${w.node} (node)` : w.hardware ? (w.device || 'GPU') : 'CPU')} · ${esc(w.encoder || '')}${w.waitingOnNode ? ' · waiting on the node' : w.started === false ? ' · starting' : ''}</span>${meter(f)}</span><span class="small mono">${fin(w.fps) ? `${num(w.fps, 0)} fps` : '—'}${fin(w.speed) ? ` · ${num(w.speed, 1)}×` : ''}</span></div>`;
      }).join('');
    }

    // ---------- clips ----------
    function drawClips() {
      const panel = $('#clips-panel', body);
      const items = snap?.items || [];
      panel.hidden = !snap;
      if (!snap) return;
      const c = counts(snap);
      $('#clip-states', body).innerHTML = `<span class="chip green">${c.completed} done</span><span class="chip teal">${c.working} working</span><span class="chip">${c.queued} waiting</span>${c.failed ? `<span class="chip red">${c.failed} failed</span>` : ''}${c.skipped ? `<span class="chip">${c.skipped} skipped</span>` : ''}`;
      const box = $('#items', body);
      const top = box.scrollTop;
      const order = { processing: 0, failed: 1, queued: 2, completed: 3, skipped: 4 };
      const shown = [...items].sort((a, b) => (order[a.state] ?? 5) - (order[b.state] ?? 5)).slice(0, 200);
      box.innerHTML = shown.length ? `<table class="tbl stack-sm"><thead><tr><th>Clip</th><th>State</th><th>Size</th></tr></thead><tbody>${shown.map((i) => `<tr><td data-label="Clip">${esc(i.relativePath || i.id)}${i.kind === 'asset' ? ' <span class="muted tiny">(event file)</span>' : ''}</td>
        <td data-label="State"><span class="chip ${i.state === 'completed' ? 'green' : i.state === 'failed' ? 'red' : i.state === 'processing' ? 'teal' : ''}">${esc(ITEM_TEXT[i.state] || i.state)}</span>${i.resultCode && i.state !== 'completed' ? ` <span class="muted tiny">${esc(String(i.resultCode).replace(/[_-]+/g, ' '))}</span>` : ''}</td>
        <td data-label="Size" class="mono small">${bytes(i.sourceBytes)}${fin(i.outputBytes) ? ` → ${bytes(i.outputBytes)}` : ''}</td></tr>`).join('')}</tbody></table>${snap.itemsTruncated ? `<p class="muted tiny" style="padding:8px 12px">Showing ${shown.length} of ${snap.itemCount} clips.</p>` : ''}` : '<p class="muted" style="padding:12px">Finding clips…</p>';
      box.scrollTop = top;
      const t = snap.timings?.totalMs;
      if (t && snap.timings.files) {
        const all = Object.values(t).reduce((a, b) => a + b, 0) || 1;
        $('#timings', body).innerHTML = `<details class="more-info"><summary>Where the time goes (${plural(snap.timings.files, 'clip')})</summary><div class="stack" style="gap:8px;margin-top:6px">${PHASES.filter(([k]) => t[k]).map(([k, label]) => `<div><div class="stat-label"><span>${label}</span><span>${dur(t[k] / snap.timings.files)} per clip</span></div>${meter((t[k] / all) * 100, 'violet')}</div>`).join('')}</div></details>`;
      } else $('#timings', body).innerHTML = '';
    }

    // ---------- the start form ----------
    function veh() { return state.vehicles.find((x) => x.id === vehicleId) || current(); }
    function destFor(v) {
      if (form.dest[v.id]) return form.dest[v.id];
      const root = ctxInfo?.outputRoots?.[0] || '';
      return root ? `${root.replace(/\/+$/, '')}/${v.name.replace(/[^\w.-]+/g, '_')}` : '';
    }
    function multiDevice() { return devices.filter((d) => d.kind !== 'cpu').length > 0; }

    function buildConfig() {
      const v = veh();
      if (!v) throw new Error('Add a vehicle first.');
      const replace = form.outputMode === 'replace';
      const included = GROUPS.map(([g]) => g).filter((g) => form.included.includes(g));
      if (!included.length) throw new Error('Pick at least one kind of clip.');
      const cfg = {
        sourceRoot: footageRoot(v),
        destinationRoot: replace ? null : (form.dest[v.id] || destFor(v)),
        codec: form.codec,
        profileId: form.profileId,
        networkMode: form.networkMode,
        outputMode: form.outputMode,
        includedGroups: included,
        groupOrder: [...form.groups],
        replacementConfirmed: replace ? confirmed : false,
        verifyMode: form.verifyMode
      };
      if (!replace && !cfg.destinationRoot) throw new Error('Choose a folder for the converted copies.');
      if (form.profileId === 'custom') cfg.bitrateKbps = Math.round(Number(form.bitrateKbps));
      if (form.profileId === 'quality') cfg.qualityLevel = form.qualityLevel;
      if (multiDevice()) {
        const lanes = devices.map((d) => ({ device: d.id, concurrency: Number(laneNext(d)) })).filter((l) => l.concurrency > 0);
        if (!lanes.length) throw new Error('Set at least one device to convert.');
        cfg.lanes = lanes;
      } else cfg.concurrency = Math.max(1, Math.min(64, Number(form.concurrency) || 1));
      return cfg;
    }

    function drawStart() {
      const panel = $('#start-panel', body);
      const v = veh();
      const busy = snap && ACTIVE.has(snap.state);
      if (!v) {
        panel.innerHTML = empty('No vehicle yet', 'Add one in Settings to convert its footage.', `<a class="btn primary" href="#/settings/vehicles/new">${icon('plus')} Add a vehicle</a>`);
        return;
      }
      const canReplace = caps?.replacement === 'available' && v.share?.writable !== false;
      if (!canReplace && form.outputMode === 'replace') form.outputMode = 'separate';
      const replace = form.outputMode === 'replace';
      panel.innerHTML = `<div class="panel-head"><h2>New conversion</h2>${busy ? '<span class="chip amber">one at a time: wait for the running job</span>' : ''}</div>
        <form id="start" class="stack" novalidate>
          <div class="form">
            <label class="field">Vehicle<select class="input" id="f-veh">${state.vehicles.map((x) => `<option value="${esc(x.id)}"${x.id === v.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
            <div class="field">Codec<div class="seg big" role="group" aria-label="Codec">${['h265', 'av1'].map((k) => `<button type="button" data-f="codec" data-v="${k}" aria-pressed="${form.codec === k}">${CODEC[k]}</button>`).join('')}</div></div>
          </div>
          <div class="field">Size<div class="choice-grid">${PROFILES.map(([k, label, hint]) => `<label class="choice"><input type="radio" name="profile" value="${k}"${form.profileId === k ? ' checked' : ''}><b>${label}</b><span>${hint}</span></label>`).join('')}</div></div>
          ${form.profileId === 'quality' ? `<div class="field">Quality level<div class="seg big" role="group" aria-label="Quality level">${QUALITY.map(([k, l]) => `<button type="button" data-f="qualityLevel" data-v="${k}" aria-pressed="${form.qualityLevel === k}">${l}</button>`).join('')}</div></div>` : ''}
          ${form.profileId === 'custom' ? '<label class="field" style="max-width:280px">Bitrate (kbit/s)<input class="input" id="f-bitrate" type="number" inputmode="numeric" min="250" max="100000" step="50" value="' + esc(form.bitrateKbps) + '"></label>' : ''}
          <div class="field">Output<div class="choice-grid">
            <label class="choice"><input type="radio" name="out" value="replace"${replace ? ' checked' : ''}${canReplace ? '' : ' disabled'}><b>Replace originals</b><span>${canReplace ? 'after each result is verified; saves the space' : 'not possible on this storage'}</span></label>
            <label class="choice"><input type="radio" name="out" value="separate"${replace ? '' : ' checked'}><b>Separate folder</b><span>keep originals, write copies</span></label></div></div>
          ${replace ? `<label class="check note warn" style="padding:6px 14px"><input type="checkbox" id="f-confirm"${confirmed ? ' checked' : ''}> I understand the originals of ${esc(v.name)} are replaced by the verified, smaller files.</label>`
            : `<div class="row" style="align-items:flex-end"><label class="field" style="flex:1;min-width:220px">Folder for the copies<input class="input mono" id="f-dest" value="${esc(destFor(v))}" autocomplete="off" spellcheck="false"></label><button class="btn" type="button" id="f-browse">${icon('folder')} Browse</button></div>`}
          <div class="form">
            <div class="field">Verify<div class="seg big" role="group" aria-label="Verify">${[['quick', 'Quick'], ['full', 'Full (decode every frame)']].map(([k, l]) => `<button type="button" data-f="verifyMode" data-v="${k}" aria-pressed="${form.verifyMode === k}">${l}</button>`).join('')}</div></div>
            ${multiDevice() ? '' : `<div class="field">Conversions at once<div class="stepper" role="group" aria-label="Conversions at once"><button class="btn ghost" type="button" data-fc="-1" aria-label="Fewer">−</button><output id="f-conc">${form.concurrency}</output><button class="btn ghost" type="button" data-fc="1" aria-label="More">+</button></div></div>`}
          </div>
          ${multiDevice() ? `<div class="field">Conversions at once, per device<div class="lane-list">${laneSteppers([], false)}</div></div>` : ''}
          <div class="field">Clips, in this order<ol class="order">${form.groups.map((g, i) => `<li><label class="check"><input type="checkbox" data-group="${g}"${form.included.includes(g) ? ' checked' : ''}> ${esc(GROUPS.find((x) => x[0] === g)[1])}</label><button class="btn ghost icon" type="button" data-up="${i}" aria-label="Move ${esc(GROUPS.find((x) => x[0] === g)[1])} up"${i ? '' : ' disabled'}>${icon('up')}</button></li>`).join('')}</ol></div>
          <details class="more-info"><summary>Network</summary><div class="seg big" role="group" aria-label="Network mode" style="margin-top:6px">${[['auto', 'Automatic'], ['staging', 'Copy to the server first'], ['direct', 'Read in place']].map(([k, l]) => `<button type="button" data-f="networkMode" data-v="${k}" aria-pressed="${form.networkMode === k}">${l}</button>`).join('')}</div></details>
          <p class="err" id="start-err" role="alert"></p>
          <div class="actions"><button class="btn primary" type="submit" id="f-start"${busy ? ' disabled' : ''}>${icon('play')} Start converting ${esc(v.name)}</button></div>
        </form>`;
      wireGroups(panel, groupMem);
    }

    // ---------- automatic conversion ----------
    function drawAuto() {
      const panel = $('#auto-panel', body);
      if (!auto) {
        panel.innerHTML = '<div class="panel-head"><h2>Automatic conversion</h2></div><p class="muted">Not available on this server.</p>';
        return;
      }
      const s = auto.settings || {};
      const st = auto.status || {};
      const w = s.window;
      const winMode = !w ? 'any' : w.follow === 'off-peak' ? 'offpeak' : 'hours';
      const name = (root) => state.vehicles.find((x) => footageRoot(x) === root || x.root === root)?.name || root;
      const hours = Array.from({ length: 24 }, (_, h) => h);
      panel.innerHTML = `<div class="panel-head"><h2>Automatic conversion</h2><span class="chip ${s.enabled ? 'green' : ''}">${s.enabled ? 'On' : 'Off'}</span></div>
        <p class="lead">New footage is converted by itself, with the settings above, for the vehicles you turn on here.</p>
        ${(s.configs || []).length ? `<ul class="list" style="margin-top:14px">${s.configs.map((c) => `<li class="attn"><div><b>${esc(name(c.sourceRoot))}</b><br><span class="muted small">${esc(CODEC[c.codec] || c.codec)} · ${esc(c.profileId)}${c.qualityLevel ? ` (${esc(c.qualityLevel)})` : ''} · ${c.outputMode === 'replace' ? 'replace originals' : 'separate folder'}${st.activeSource === c.sourceRoot ? ' · converting now' : ''}</span></div><button class="btn sm" type="button" data-auto-remove="${esc(c.sourceRoot)}">Remove</button></li>`).join('')}</ul>` : '<p class="muted small" style="margin-top:10px">No vehicle is converted automatically.</p>'}
        <div class="form" style="margin-top:16px">
          <label class="field">How often<select class="input" id="a-int">${INTERVALS.map(([m, l]) => `<option value="${m}"${s.intervalMinutes === m ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field">When<select class="input" id="a-win"><option value="any"${winMode === 'any' ? ' selected' : ''}>Any time</option><option value="offpeak"${winMode === 'offpeak' ? ' selected' : ''}>Off-peak electricity hours</option><option value="hours"${winMode === 'hours' ? ' selected' : ''}>Between set hours</option></select></label>
          ${winMode === 'hours' ? `<label class="field">From<select class="input" id="a-from">${hours.map((h) => `<option value="${h}"${w.startHour === h ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label><label class="field">Until<select class="input" id="a-to">${hours.map((h) => `<option value="${h}"${w.endHour === h ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label>` : ''}
          <label class="check full"><input type="checkbox" id="a-hold"${s.holdManual ? ' checked' : ''}> Also pause conversions I start by hand outside these hours</label>
          <label class="check full"><input type="checkbox" id="a-keep"${s.keepRunning ? ' checked' : ''}> Let a running conversion finish when the hours end</label>
        </div>
        <p class="muted small">${st.lastCheckAt ? `Last checked ${esc(ago(st.lastCheckAt))}${fin(st.lastNewFiles) ? `, ${plural(st.lastNewFiles, 'new clip')}` : ''}. ` : ''}${s.enabled && st.nextCheckAt ? `Next check ${esc(when(st.nextCheckAt))}.` : ''}${st.pausedForWindow ? ' Paused outside the hours.' : ''}${st.error ? ` <span style="color:var(--bad)">${esc(typeof st.error === 'string' ? st.error : explain(st.error))}</span>` : ''}</p>
        <div class="actions">
          <button class="btn" type="button" id="a-check"${s.enabled ? '' : ' disabled'}>${icon('refresh')} Check now</button>
          ${s.enabled ? '<button class="btn" type="button" id="a-off">Turn off</button>' : ''}
          <button class="btn primary" type="button" id="a-save">${icon('check')} ${s.enabled && (s.configs || []).some((c) => c.sourceRoot === footageRoot(veh())) ? `Update ${esc(veh()?.name || '')}` : `Convert ${esc(veh()?.name || 'this vehicle')} automatically`}</button>
        </div>`;
    }
    function autoPayload(extra = {}) {
      const s = auto.settings || {};
      const winMode = $('#a-win', body)?.value || 'any';
      let windowV = null;
      if (winMode === 'offpeak') windowV = { follow: 'off-peak' };
      else if (winMode === 'hours') windowV = { startHour: Number($('#a-from', body)?.value ?? 22), endHour: Number($('#a-to', body)?.value ?? 6) };
      return {
        enabled: s.enabled, intervalMinutes: Number($('#a-int', body)?.value || s.intervalMinutes || 60), window: windowV,
        holdManual: Boolean($('#a-hold', body)?.checked), keepRunning: Boolean($('#a-keep', body)?.checked), openAtLogin: Boolean(s.openAtLogin), ...extra
      };
    }
    async function setAuto(payload, done) {
      const r = await invoke('setAuto', payload);
      if (!r.ok) { toast(explain(r.error), 'bad'); return; }
      auto = r.value;
      if (done) toast(done);
      drawAuto();
    }

    // ---------- benchmark ----------
    function drawBench() {
      const panel = $('#bench-panel', body);
      const b = bench;
      const runs = b.result ? (b.result.codecs || [b.result]) : [];
      const devRuns = b.result?.devices || [];
      const table = (run) => {
        if (run.error) return `<p class="note warn">${esc(CODEC[run.codec] || run.codec)}: ${esc(run.error === 'UNSUPPORTED' ? 'no encoder for it here' : explain({ code: run.error }))}</p>`;
        const best = run.best?.level ?? run.best;
        return `<h3 style="margin:12px 0 6px">${esc(CODEC[run.codec] || run.codec)} · ${esc(run.encoder?.codec || '')}${run.encoder?.hardware ? ' (GPU)' : ''}</h3>
          <div class="table-wrap"><table class="tbl bench-table stack-sm"><thead><tr><th>At once</th><th>Clips/min</th><th>fps</th><th>Saved</th><th>Energy</th></tr></thead><tbody>${(run.results || []).map((r) => `<tr class="${r.level === best ? 'best' : ''}"><td data-label="At once">${r.level}${r.level === best ? ' ★' : ''}</td><td data-label="Clips/min">${fin(r.filesPerMinute) ? num(r.filesPerMinute, 1) : '—'}${r.failed ? ` <span class="chip red">${r.failed} failed</span>` : ''}</td><td data-label="fps">${fin(r.fps) ? num(r.fps, 0) : '—'}</td><td data-label="Saved">${fin(r.savedPercent) ? pct(r.savedPercent) : '—'}</td><td data-label="Energy">${fin(r.filesPerWh) ? `${num(r.filesPerWh, 1)} clips/Wh` : '—'}</td></tr>`).join('')}</tbody></table></div>
          ${best ? `<div class="actions start"><button class="btn sm" type="button" data-use-level="${best}">Use ${best} at once</button></div>` : ''}`;
      };
      const p = b.progress;
      panel.innerHTML = `<div class="panel-head"><h2>Benchmark</h2></div>
        <p class="lead">Converts a few sample clips (copies; your footage is only read) at 1, 2, 4… at once with the settings above, and shows which is fastest on this server.</p>
        <div class="row" style="margin-top:14px"><label class="check"><input type="checkbox" id="b-h265"${store.get('b-h265', true) ? ' checked' : ''}> H.265</label><label class="check"><input type="checkbox" id="b-av1"${store.get('b-av1', false) ? ' checked' : ''}> AV1</label><span class="spacer"></span>
          ${b.running ? `<button class="btn danger" type="button" id="b-cancel">${icon('stop')} Cancel</button>` : `<button class="btn" type="button" id="b-run"${snap && ACTIVE.has(snap.state) ? ' disabled title="Wait for the conversion to finish"' : ''}>${icon('speed')} Run benchmark</button>`}</div>
        ${b.running ? `<p class="muted" style="margin-top:12px">${esc(p ? `${p.codec ? `${CODEC[p.codec] || p.codec}: ` : ''}${p.step === 'scan' ? 'finding sample clips' : p.step === 'copy' ? `copying sample ${p.index}/${p.total}` : p.step === 'run' ? `${p.level} at once (${p.index}/${p.total})` : p.step === 'verify' ? `timing ${p.verifyMode} verification` : p.step || 'working'}…` : 'Starting…')}</p>` : ''}
        ${b.error ? `<p class="note bad" style="margin-top:12px">${esc(b.error)}</p>` : ''}
        ${runs.map(table).join('')}
        ${devRuns.map((d) => `<h3 style="margin-top:16px">${esc(d.device?.name || d.device?.id || '')}</h3>${(d.codecs || []).map(table).join('')}`).join('')}`;
    }

    // ---------- data ----------
    const pollStats = async () => {
      clearTimeout(statsTimer);
      if (dead) return;
      if (!document.hidden) {
        try {
          const s = await api('/api/stats', { timeoutMs: 8000 });
          enc = s.encoder;
          if (!dead) { drawOrbit(); drawLanes(); drawLive(); }
        } catch { /* next time */ }
      }
      statsTimer = setTimeout(pollStats, snap && ACTIVE.has(snap.state) ? 2000 : 6000);
    };

    let lastState = null;
    const stop = follow((s) => {
      snap = s;
      if (dead) return;
      drawOrbit();
      drawLive();
      drawLanes();
      drawClips();
      const st = s?.state || null;
      if (st && ACTIVE.has(st) && !(lastState && ACTIVE.has(lastState))) pollStats();
      if (st !== lastState) {
        const wasActive = lastState && ACTIVE.has(lastState);
        lastState = st;
        drawStart();
        drawBench();
        if (wasActive && !ACTIVE.has(st)) toast(st === 'completed' ? 'Conversion finished.' : `Conversion ${STATE_TEXT[st] || st}.`, st === 'failed' ? 'bad' : 'ok');
      }
    });
    const stopBench = onBenchmark((p) => {
      bench.progress = p;
      if (!dead && bench.running) drawBench();
    });

    const [capR, devR, autoR, info] = await Promise.all([
      invoke('getCapabilities'), invoke('devices'), invoke('getAuto'), api('/api/studio/context').catch(() => null)
    ]);
    caps = capR.ok ? capR.value : null;
    devices = devR.ok ? (devR.value?.devices || []) : [];
    auto = autoR.ok ? autoR.value : null;
    ctxInfo = info;
    if (!capR.ok) toast(explain(capR.error), 'bad');
    drawOrbit();
    drawLive();
    drawStart();
    drawAuto();
    drawBench();
    pollStats();

    // ---------- events ----------
    const act = async (name) => {
      if (!snap) return;
      if (name === 'cancel' && !(await confirmDialog({ title: 'Cancel this conversion?', body: '<p>Clips already converted and verified stay converted; the rest stay as they are.</p>', ok: 'Cancel conversion', cancel: 'Keep going', danger: true }))) return;
      if (name === 'discard' && ACTIVE.has(snap.state) && !(await confirmDialog({ title: 'Set this job aside?', body: '<p>For a job that can’t be cancelled or resumed: the Encoder stops it and forgets it. Converted clips stay converted; nothing is deleted.</p>', ok: 'Set aside', danger: true }))) return;
      const r = await invoke(name, { jobId: snap.id });
      if (!r.ok) { toast(explain(r.error), 'bad'); return; }
      if (name === 'discard') apply(r.value || null);
      else if (name === 'dismissSummary') await refreshCurrent();
      else if (r.value) apply(r.value);
      toast({ pause: 'Paused.', resume: 'Resumed.', cancel: 'Cancelling…', retryFailed: 'Retrying the failed clips.', dismissSummary: 'Dismissed.', discard: 'Cleared.' }[name] || 'Done.');
    };

    body.addEventListener('click', async (e) => {
      const t = e.target;
      const a = t.closest('[data-act]');
      if (a) { a.disabled = true; await act(a.dataset.act); a.disabled = false; return; }
      if (t.closest('#go-start')) {
        e.preventDefault();
        $('#start-panel', body).scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      const conc = t.closest('[data-conc]');
      if (conc && snap) {
        const n = Math.max(1, Math.min(64, (snap.config?.concurrency || 1) + Number(conc.dataset.conc)));
        const r = await invoke('setConcurrency', { jobId: snap.id, concurrency: n });
        if (r.ok) apply(r.value); else toast(explain(r.error), 'bad');
        return;
      }
      const lane = t.closest('[data-lane]');
      if (lane) {
        const id = lane.dataset.lane;
        const delta = Number(lane.dataset.step);
        if (lane.dataset.live === '1' && snap) {
          const running = jobLanes(devices, snap.config.lanes);
          const cur = devices.map((d) => ({ device: d.id, concurrency: running.get(d.id) || 0 }));
          const row = cur.find((l) => l.device === id) || (cur.push({ device: id, concurrency: 0 }), cur[cur.length - 1]);
          row.concurrency = Math.max(0, Math.min(64, row.concurrency + delta));
          const r = await invoke('setLanes', { jobId: snap.id, lanes: cur });
          if (r.ok) apply(r.value); else toast(explain(r.error), 'bad');
        } else {
          const d = devices.find((x) => x.id === id) || { id };
          form.lanes[id] = Math.max(0, Math.min(64, Number(laneNext(d)) + delta));
          saveForm();
          lane.parentElement.querySelector('output').textContent = form.lanes[id];
          groupTotals($('#start-panel', body));
        }
        return;
      }
      const fc = t.closest('[data-fc]');
      if (fc) {
        form.concurrency = Math.max(1, Math.min(64, form.concurrency + Number(fc.dataset.fc)));
        saveForm();
        $('#f-conc', body).textContent = form.concurrency;
        return;
      }
      const f = t.closest('[data-f]');
      if (f) {
        form[f.dataset.f] = f.dataset.v;
        saveForm();
        $$(`[data-f="${f.dataset.f}"]`, body).forEach((b) => b.setAttribute('aria-pressed', String(b === f)));
        return;
      }
      const up = t.closest('[data-up]');
      if (up) {
        const i = Number(up.dataset.up);
        [form.groups[i - 1], form.groups[i]] = [form.groups[i], form.groups[i - 1]];
        saveForm();
        drawStart();
        return;
      }
      if (t.closest('#f-browse')) { browse(); return; }
      const rm = t.closest('[data-auto-remove]');
      if (rm) {
        const left = (auto.settings.configs || []).filter((c) => c.sourceRoot !== rm.dataset.autoRemove);
        await setAuto(autoPayload({ enabled: left.length ? auto.settings.enabled : false, removeSource: rm.dataset.autoRemove }), 'Removed from automatic conversion.');
        return;
      }
      if (t.closest('#a-save')) {
        let config;
        try { config = buildConfig(); } catch (err) { toast(err.message, 'bad'); return; }
        if (config.outputMode === 'replace' && !config.replacementConfirmed) { toast('Tick the box under Output to confirm that originals may be replaced.', 'bad'); return; }
        delete config.concurrency;
        if (!config.lanes) config.concurrency = Math.max(1, form.concurrency);
        await setAuto(autoPayload({ enabled: true, config }), `${veh().name} is converted automatically.`);
        return;
      }
      if (t.closest('#a-off')) { await setAuto(autoPayload({ enabled: false }), 'Automatic conversion is off.'); return; }
      if (t.closest('#a-check')) {
        const r = await invoke('checkAutoNow');
        if (r.ok) { auto = r.value; drawAuto(); toast('Checking for new footage…'); } else toast(explain(r.error), 'bad');
        return;
      }
      if (t.closest('#b-run')) { runBench(); return; }
      if (t.closest('#b-cancel')) { await invoke('cancelBenchmark'); return; }
      const use = t.closest('[data-use-level]');
      if (use) {
        form.concurrency = Number(use.dataset.useLevel);
        saveForm();
        drawStart();
        toast(`New conversions run ${form.concurrency} at once.`);
      }
    });

    body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'f-veh') { vehicleId = t.value; confirmed = false; drawStart(); drawAuto(); return; }
      if (t.name === 'profile') { form.profileId = t.value; saveForm(); drawStart(); return; }
      if (t.name === 'out') { form.outputMode = t.value; saveForm(); drawStart(); return; }
      if (t.id === 'f-confirm') { confirmed = t.checked; return; }
      if (t.id === 'f-dest') { form.dest[veh().id] = t.value.trim(); saveForm(); return; }
      if (t.id === 'f-bitrate') { form.bitrateKbps = Number(t.value); saveForm(); return; }
      if (t.matches('[data-group]')) {
        const g = t.dataset.group;
        form.included = t.checked ? [...new Set([...form.included, g])] : form.included.filter((x) => x !== g);
        saveForm();
        return;
      }
      if (t.id === 'a-win') { auto.settings.window = t.value === 'any' ? null : t.value === 'offpeak' ? { follow: 'off-peak' } : { startHour: 22, endHour: 6 }; drawAuto(); return; }
      if (['a-int', 'a-from', 'a-to', 'a-hold', 'a-keep'].includes(t.id) && auto.settings.enabled) setAuto(autoPayload(), 'Saved.');
      if (t.id === 'b-h265' || t.id === 'b-av1') store.set(t.id, t.checked);
    });

    body.addEventListener('submit', async (e) => {
      if (e.target.id !== 'start') return;
      e.preventDefault();
      const err = $('#start-err', body);
      err.textContent = '';
      let cfg;
      try { cfg = buildConfig(); } catch (x) { err.textContent = x.message; return; }
      if (cfg.outputMode === 'replace' && !cfg.replacementConfirmed) { err.textContent = 'Tick the box to confirm that the originals may be replaced.'; return; }
      const btn = $('#f-start', body);
      btn.disabled = true;
      const r = await invoke('start', cfg);
      if (!r.ok) {
        err.textContent = explain(r.error);
        btn.disabled = false;
        return;
      }
      toast('Conversion started.');
      await refreshCurrent();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    async function browse() {
      let where = $('#f-dest', body)?.value || null;
      const list = async (p) => api('/api/studio/browse', { body: { path: p || null } });
      let cur;
      try { cur = await list(null); } catch (x) { toast(x.message, 'bad'); return; }
      const draw = (form2) => {
        form2.querySelector('#br-list').innerHTML = `${cur.parent ? `<button class="vw-item" type="button" data-br="${esc(cur.parent)}">${icon('up')}<span>Up</span></button>` : ''}${cur.path ? '' : ''}${(cur.entries || []).map((x) => `<button class="vw-item" type="button" data-br="${esc(x.path || `${cur.path}/${x.name}`)}">${icon('folder')}<span>${esc(x.name)}</span></button>`).join('') || '<p class="muted">No folders inside.</p>'}`;
        form2.querySelector('#br-path').textContent = cur.path || 'Choose a place';
      };
      const res = await openDialog(`<h2>Choose a folder</h2><p class="mono small" id="br-path"></p><div class="vw-list" id="br-list" style="margin-top:12px;max-height:50dvh;overflow:auto"></div>
        <label class="field dlg-field">New folder inside (optional)<input class="input" id="br-new" autocomplete="off" spellcheck="false" placeholder="${esc(veh()?.name || 'Converted')}"></label>
        <div class="dlg-actions"><button class="btn" value="cancel" type="submit">Cancel</button><button class="btn primary" value="ok" type="submit" id="br-ok">Use this folder</button></div>`, {
        wide: true,
        onOpen: (f) => {
          draw(f);
          f.querySelector('#br-list').addEventListener('click', async (e2) => {
            const b = e2.target.closest('[data-br]');
            if (!b) return;
            try { cur = await list(b.dataset.br); draw(f); } catch (x) { toast(x.message, 'bad'); }
          });
        }
      });
      if (res.value !== 'ok' || !cur.path) return;
      const extra = res.form.querySelector('#br-new').value.trim().replace(/[/\\]+/g, '_');
      where = extra ? `${cur.path}/${extra}` : cur.path;
      form.dest[veh().id] = where;
      saveForm();
      drawStart();
    }

    async function runBench() {
      const codecs = [$('#b-h265', body)?.checked && 'h265', $('#b-av1', body)?.checked && 'av1'].filter(Boolean);
      if (!codecs.length) { toast('Pick H.265, AV1 or both.', 'bad'); return; }
      const v = veh();
      const req = { codecs, sourceRoot: v ? footageRoot(v) : null, profileId: form.profileId, verifyMode: form.verifyMode };
      if (form.profileId === 'custom') req.bitrateKbps = Math.round(Number(form.bitrateKbps));
      if (form.profileId === 'quality') req.qualityLevel = form.qualityLevel;
      bench = { running: true, progress: null, result: null, error: null };
      drawBench();
      await streamReady();
      const r = await invoke('runBenchmark', req);
      bench.running = false;
      if (r.ok) bench.result = r.value;
      else bench.error = r.error?.code === 'CANCELLED' ? 'Cancelled.' : explain(r.error);
      if (!dead) drawBench();
    }

    return {
      refresh() {
        // vehicles changed: only a new list of vehicles (or one that became
        // read-only) redraws the form; inventory ticks during a conversion
        // must not wipe what is being filled in
        const key = JSON.stringify(state.vehicles.map((v) => [v.id, v.name, v.share?.writable !== false, footageRoot(v)]));
        if (key === vehiclesKey) return;
        vehiclesKey = key;
        drawStart();
        drawAuto();
      },
      destroy() {
        dead = true;
        clearTimeout(statsTimer);
        stop();
        stopBench();
      }
    };
  }
};
