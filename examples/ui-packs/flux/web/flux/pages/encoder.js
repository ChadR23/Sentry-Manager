// Encoder: start, watch and steer conversions through /api/converter/invoke/* and
// the /api/converter/events stream. Per-lane throughput comes from /api/stats.
import { esc, api, invoke, state, current, sourceOf, bytes, rate, pct, num, dur, energy, watts, money, icon, toast, confirmDialog, busy, store, fin, plural, isoish, debounce, bus, CLIENT_ID } from '../core.js';
import { split, seg, wireSeg, meter, chip, empty } from '../ui.js';
import { spark, C, PALETTE } from '../charts.js';
import { splitDevices, deviceLabel, laneValue, jobLanes, groupMemory, groupBodyId, wireGroups } from '../nodelanes.js';

const ACTIVE = new Set(['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing', 'paused', 'paused_network']);
const RUNNING = new Set(['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing']);
const GROUPS = ['RecentClips', 'SavedClips', 'SentryClips'];
const PHASES = [
  ['inspect', 'inspect source', C.blue], ['source', 'read source', C.teal], ['timeline', 'telemetry timeline', C.lime], ['encode', 'encode', C.violet],
  ['metadata', 'write telemetry', C.pink], ['checkWait', 'wait: picture check', '#8b8fb0'], ['picture', 'picture check', C.orange], ['verify', 'verify', C.cyan],
  ['saveWait', 'wait: save slot', '#6c7090'], ['save', 'save', C.green], ['cleanup', 'cleanup', C.amber]
];
const ERRORS = {
  REPLACEMENT_CONFIRMATION_REQUIRED: 'Tick the confirmation to replace originals.',
  REPLACEMENT_UNAVAILABLE: 'Replacing originals is not available on this share.',
  PATH_NOT_ALLOWED: 'That folder is outside the vehicle shares and output folders.',
  PATH_OVERLAP: 'The destination cannot be inside the source (or the other way round).',
  PATH_UNAVAILABLE: 'The folder cannot be reached right now.',
  INVALID_PATH: 'That is not a usable folder.',
  INVALID_GROUP_SELECTION: 'Choose at least one clip group.',
  INVALID_BITRATE: 'Enter a bitrate between 250 and 100000 kbit/s.',
  INVALID_CONCURRENCY: 'Conversions at once: 1 to 64.',
  INVALID_LANES: 'These device settings cannot be used (1 to 64 in total).',
  DEVICE_UNSUPPORTED: 'One of the GPUs cannot encode this codec. Set it to 0 or pick another codec.',
  JOB_ACTIVE: 'Another conversion is running. Pause or cancel it first.',
  BENCHMARK_ACTIVE: 'A benchmark is already running.',
  BENCHMARK_SOURCE_REQUIRED: 'No clips to benchmark with in this vehicle\'s footage.',
  AUTO_CONFIG_REQUIRED: 'Automatic conversion needs the settings above.',
  INVALID_AUTO_WINDOW: 'Choose different start and end hours.',
  RECOVERY_REQUIRED: 'This job stopped in the middle of replacing an original. Resume it to finish safely.',
  CONVERTER_STARTING: 'The converter is still starting. Try again in a moment.',
  NETWORK_ERROR: 'Could not reach the server.'
};
const errText = (e) => (e?.code === 'DEVICE_UNSUPPORTED' && e.details ? `${e.details.device} can't encode ${String(e.details.codec).toUpperCase()}. Set it to 0 or pick another codec.` : ERRORS[e?.code] || `Converter: ${e?.code || 'failed'}`);
const unwrap = (r) => {
  if (r?.ok) return r.value;
  throw Object.assign(new Error(errText(r?.error)), { code: r?.error?.code });
};
const STATE_TONE = { encoding: 'cyan', discovering: 'violet', waiting: 'violet', staging: 'violet', verifying: 'cyan', copying: 'cyan', replacing: 'cyan', 'writing-telemetry': 'cyan', paused: 'amber', paused_network: 'amber', completed: 'green', failed: 'red', cancelled: '' };

export default {
  async mount(el, { params }) {
    let snap = null;
    let live = null;
    let enc = null; // /api/stats encoder block
    let price = null;
    let devices = [];
    let caps = {};
    let auto = null;
    let ctx = { outputRoots: [] };
    let bench = { running: false, progress: null, result: store.get('enc:bench', null) };
    let alive = true;
    let es = null;
    let statsTimer = null;
    let logTimer = null;
    let lastRev = -1;
    const laneHist = new Map(); // device key -> fps history
    const groupMem = groupMemory(store, 'enc:nodeGroups');
    let ctlHtml = null;
    const tableF = { state: 'all', text: '' };
    const v = current();
    // (what was saved over the defaults: the Nodes page may have saved only a lane)
    const form = Object.assign({
      codec: 'h265', profileId: 'balanced', bitrateKbps: 4000, qualityLevel: 'balanced', outputMode: 'replace', verifyMode: 'quick',
      groups: [...GROUPS], groupOrder: ['SentryClips', 'SavedClips', 'RecentClips'], concurrency: 2, lanes: {}, dest: ''
    }, store.get('enc:form', {}));

    el.innerHTML = `
      <div class="phead">
        <div><h1>Encoder <span id="enc-state"></span></h1><p class="muted small" id="enc-sub">Loading the converter…</p></div>
        <div class="phead-actions" id="enc-actions"></div>
      </div>
      <div class="kpis" id="enc-kpis"></div>
      <div id="enc-split">
        <section class="enc-setup" aria-label="Setup">
          <form class="card form-card" id="enc-form" novalidate></form>
          <section class="card" id="enc-auto"></section>
          <section class="card" id="enc-bench"></section>
        </section>
        <section class="enc-live" aria-label="Live">
          <section class="card" id="enc-lanes"></section>
          <section class="card" id="enc-timing"></section>
          <section class="card" id="enc-items-card">
            <header class="card-h"><h2>Clips</h2><span class="faint small" id="enc-items-n"></span></header>
            <div class="toolbar wrap">${seg('ist', [['all', 'All'], ['active', 'Active'], ['queued', 'Waiting'], ['done', 'Done'], ['failed', 'Failed'], ['skipped', 'Skipped']], 'all', 'Clip state')}<input class="input grow" type="search" data-filter id="enc-ifilter" placeholder="Filter clips  ( / )" aria-label="Filter clips"></div>
            <div class="tscroll tall"><table class="dtable" id="enc-items"></table></div>
          </section>
        </section>
      </div>
      <section class="card logs" aria-label="Converter log">
        <header class="card-h"><h2>Converter log</h2><span class="faint small" id="enc-log-n"></span></header>
        <div class="toolbar"><input class="input grow" type="search" id="enc-log-filter" placeholder="Filter" aria-label="Filter the converter log"><label class="check"><input type="checkbox" id="enc-log-all"> All scopes</label><button class="btn" type="button" id="enc-log-refresh">${icon('refresh')}Refresh</button></div>
        <div class="logbox short" id="enc-log" tabindex="0" aria-label="Converter log lines"></div>
      </section>`;
    const $ = (s) => el.querySelector(s);
    split($('#enc-split'), { id: 'encoder', initial: 420, min: 320, max: 640 });

    // ---------- helpers ----------
    const jobVehicle = () => {
      const src = snap?.config?.sourceRoot;
      return state.vehicles.find((x) => src && (sourceOf(x) === src || x.root === src || src.startsWith(`${x.root}/`))) || null;
    };
    const videoItems = () => (snap?.items || []).filter((i) => i.kind === 'video');
    function counts() {
      if (!snap) return null;
      const items = videoItems();
      const c = { total: items.length, completed: 0, skipped: 0, failed: 0, queued: 0, processing: 0, cancelled: 0 };
      for (const i of items) c[i.state] = (c[i.state] || 0) + 1;
      if (snap.itemsTruncated && snap.itemStateCounts) {
        const s = snap.itemStateCounts;
        Object.assign(c, { total: snap.itemCount, completed: s.completed, skipped: s.skipped, failed: s.failed, queued: s.queued, processing: s.active });
      }
      c.done = c.completed + c.skipped + c.failed;
      return c;
    }
    const workerOf = (id) => (enc?.workers || []).find((w) => w.itemId === id) || null;
    function itemState(i) {
      if (i.state === 'processing') {
        const w = workerOf(i.id);
        if (w?.waitingOnNode) return ['waiting on node', 'amber'];
        if (w) return [`encoding ${w.durationUs ? Math.round((w.outTimeUs / w.durationUs) * 100) : 0}%`, 'cyan'];
        if (snap?.state === 'discovering') return ['discovering', 'violet'];
        return [live?.waitingOnNode ? 'on node / verify / save' : 'verify / save', 'violet'];
      }
      if (i.state === 'queued') return [snap?.state === 'discovering' ? 'discovered' : 'waiting', ''];
      if (i.state === 'completed') return [i.kind === 'asset' || i.eligibleVideo === false ? 'copied' : 'done', 'green'];
      if (i.state === 'failed') return [`failed: ${i.resultCode || i.failure?.code || ''}`, 'red'];
      if (i.state === 'skipped') return [`skipped${i.resultCode ? `: ${i.resultCode}` : ''}`, ''];
      return [i.state, ''];
    }

    // ---------- header + KPIs ----------
    function drawHead() {
      const s = snap;
      const stName = s?.state || 'idle';
      $('#enc-state').innerHTML = chip(stName.replace('_', ' '), STATE_TONE[stName] || '');
      bus.emit('converter-state', s?.state || null);
      const jv = jobVehicle();
      $('#enc-sub').innerHTML = s ? `<span class="mono">${esc(s.id.slice(0, 8))}</span> · ${esc(jv?.name || s.config?.sourceRoot || '')} → ${esc(String(s.config?.codec || '').toUpperCase())} · ${esc(s.config?.outputMode === 'replace' ? 'replace originals' : `copies in ${s.config?.destinationRoot}`)} · verify ${esc(s.config?.verifyMode || 'full')}${s.config?.autoConvert ? ' · automatic' : ''} · started ${esc(isoish(s.createdAt))}` : 'No conversion yet. Set one up on the left.';
      const a = [];
      if (s && RUNNING.has(s.state)) a.push(`<button class="btn" type="button" data-job="pause">${icon('pause')}Pause</button>`);
      if (s && (s.state === 'paused' || s.state === 'paused_network')) a.push(`<button class="btn primary" type="button" data-job="resume">${icon('play')}Resume</button>`);
      if (s && ACTIVE.has(s.state)) a.push(`<button class="btn danger" type="button" data-job="cancel">${icon('stop')}Cancel</button>`);
      const c = counts();
      if (s && !RUNNING.has(s.state) && c?.failed) a.push(`<button class="btn" type="button" data-job="retryFailed">${icon('refresh')}Retry failed</button>`);
      if (s && s.state === 'completed') a.push(`<button class="btn" type="button" data-job="dismissSummary">Dismiss</button>`);
      if (s && (s.state === 'paused' || s.state === 'paused_network' || s.recovery)) a.push(`<button class="btn ghost" type="button" data-job="discard">Set aside…</button>`);
      $('#enc-actions').innerHTML = a.join('');
    }
    $('#enc-actions').addEventListener('click', (e) => {
      const b = e.target.closest('[data-job]');
      if (b) jobAction(b.dataset.job, b);
    });
    async function jobAction(name, btn) {
      if (!snap) return;
      if (name === 'cancel' && !(await confirmDialog({ title: 'Cancel this conversion?', body: '<p>Clips already converted stay converted; the rest stay as they are. Originals are never left half-replaced.</p>', ok: 'Cancel conversion', cancel: 'Keep going', danger: true }))) return;
      if (name === 'discard' && !(await confirmDialog({ title: 'Set this job aside?', body: '<p>Use this only for a job that cannot be resumed or cancelled. Its record is kept on the server; the Encoder shows the next job.</p>', ok: 'Set aside', danger: true }))) return;
      await busy(btn, async () => {
        const out = unwrap(await invoke(name, { jobId: snap.id }));
        if (name === 'discard' || name === 'dismissSummary') { snap = name === 'discard' ? out : null; lastRev = -1; }
        else if (out?.id) applySnap(out, true);
        toast({ pause: 'Paused.', resume: 'Resumed.', cancel: 'Cancelled.', retryFailed: 'Retrying the failed clips.', dismissSummary: 'Dismissed.', discard: 'Set aside.' }[name]);
        drawAll();
      });
    }

    function drawKpis() {
      const s = snap;
      const c = counts();
      const elapsed = s ? ((RUNNING.has(s.state) ? Date.now() : s.updatedAt) - s.createdAt) : null;
      const doneV = c ? c.completed + c.failed + c.skipped : 0;
      const remaining = c ? c.total - doneV : 0;
      const per = doneV > 0 && elapsed ? elapsed / doneV : null;
      const conc = Math.max(1, enc?.concurrency || s?.config?.concurrency || 1);
      const eta = per && remaining > 0 && RUNNING.has(s.state) ? per * remaining : null;
      const srcB = s?.counters?.sourceVideoBytes || 0;
      const outB = s?.counters?.outputVideoBytes || 0;
      const thr = elapsed > 0 ? srcB / (elapsed / 1000) : null;
      const fpsNow = (enc?.workers || []).reduce((n, w) => n + (fin(w.fps) ? w.fps : 0), 0) || live?.fps || null;
      const cur = price?.currency || state.power?.currency || '$';
      const k = (label, value, sub = '', tone = '') => `<div class="kpi ${tone}"><span class="kpi-l">${esc(label)}</span><b class="kpi-v num">${value}</b><span class="kpi-s">${esc(sub)}</span></div>`;
      $('#enc-kpis').innerHTML = [
        k('Clips', c ? `${doneV}<span class="faint">/${c.total}</span>` : '—', c ? `${c.completed} converted · ${c.skipped} skipped` : 'no job'),
        k('Failed', c ? String(c.failed) : '—', c?.failed ? 'originals kept' : 'none', c?.failed ? 'bad' : ''),
        k('Progress', c?.total ? pct((doneV / c.total) * 100) : '—', s?.discoveryComplete === false ? 'still discovering' : `${remaining} to go`),
        k('Saved', esc(bytes(s?.counters?.savedBytes)), srcB ? `${pct((1 - outB / srcB) * 100, 1)} smaller` : '—', 'hot'),
        k('Throughput', esc(thr ? rate(thr) : '—'), fpsNow ? `${num(fpsNow, 1)} fps now` : 'source bytes / s'),
        k('Time left', eta ? esc(dur(eta)) : '—', elapsed ? `running ${dur(elapsed)}` : ''),
        k('Lanes', `${live?.encodingNow ?? enc?.workers?.length ?? 0}<span class="faint">/${conc}</span>`, `${live?.waitingOnNode || 0} waiting on node`),
        k('Energy', esc(enc?.run && fin(enc.run.wh) ? energy(enc.run.wh) : '—'), enc?.run && fin(enc.run.cost) ? money(enc.run.cost, cur) : enc?.run?.avgW ? `avg ${watts(enc.run.avgW)}` : 'not measured')
      ].join('');
    }

    // ---------- lanes ----------
    function drawLanes() {
      const s = snap;
      const ws = enc?.workers || [];
      const devs = enc?.devices || [];
      const lanesCfg = s?.config?.lanes;
      for (const d of devs) {
        const key = d.id || d.node || 'cpu';
        const fps = ws.filter((w) => (w.deviceId || w.device || null) === (d.id || null) || (!d.id && !w.deviceId)).reduce((n, w) => n + (fin(w.fps) ? w.fps : 0), 0);
        const h = laneHist.get(key) || [];
        h.push(fps);
        if (h.length > 90) h.shift();
        laneHist.set(key, h);
      }
      const devHtml = devs.map((d, i) => {
        const key = d.id || d.node || 'cpu';
        const h = laneHist.get(key) || [];
        return `<div class="dev"><div class="dev-top"><b>${esc(d.name || key)}</b><span class="faint small mono">${esc(d.encoder || '')}${d.hardware ? ' · hw' : ' · sw'}</span><span class="num small">${d.workers} busy</span></div>
          ${spark(h, PALETTE[i % PALETTE.length], 240, 30)}<div class="faint small num">${num(h[h.length - 1] || 0, 1)} fps now · peak ${num(Math.max(0, ...h), 1)}${fin(d.video) ? ` · video engine ${pct(d.video)}` : ''}${fin(d.busy) ? ` · busy ${pct(d.busy)}` : ''}</div></div>`;
      }).join('');
      const rows = ws.map((w) => {
        const p = w.durationUs ? (w.outTimeUs / w.durationUs) * 100 : 0;
        return `<tr><td class="mono small ell" title="${esc(w.relativePath)}">${esc(String(w.relativePath || '').split('/').slice(-2).join('/'))}</td><td class="mono small">${esc(w.encoder || '')}${w.remote ? ' · node' : ''}</td><td class="w-prog">${meter(p, 'cyan')}</td><td class="r num">${pct(p)}</td><td class="r num">${fin(w.fps) ? num(w.fps, 0) : '—'}</td><td class="r num">${fin(w.speed) ? `${num(w.speed, 2)}×` : '—'}</td><td class="r num">${fin(w.bitrateKbps) ? `${num(w.bitrateKbps, 0)}k` : '—'}</td></tr>`;
      }).join('');
      // live controls
      let ctl = '';
      if (s && ACTIVE.has(s.state)) {
        if (Array.isArray(lanesCfg) && lanesCfg.length) {
          const all = devices.length ? devices : lanesCfg.map((l) => ({ id: l.device, name: l.device }));
          const running = jobLanes(all, lanesCfg);
          ctl = `<div class="live-ctl"><span class="small muted">Conversions at once per device</span><div class="lanes-in live-lanes">${laneFields(all, 'live', (d) => running.get(d.id) ?? 0)}</div><button class="btn sm primary" type="button" id="lanes-apply">Apply</button></div>`;
        } else {
          const cc = s.config?.concurrency || enc?.concurrency || 1;
          ctl = `<div class="live-ctl"><span class="small muted">Conversions at once</span><div class="stepper-row"><button class="btn icon" type="button" data-cc="-1" aria-label="Fewer at once (−)">−</button><output class="num big-out" id="cc-out">${cc}</output><button class="btn icon" type="button" data-cc="1" aria-label="More at once (+)">+</button></div><span class="faint small">applies to the running job at once</span></div>`;
        }
      }
      const box = $('#enc-lanes');
      if (!$('#enc-lanes-ctl')) box.innerHTML = '<header class="card-h"><h2>Lanes</h2><span class="faint small" id="enc-lanes-sub"></span></header><div id="enc-lanes-ctl"></div><div id="enc-lanes-body"></div>';
      $('#enc-lanes-sub').textContent = `${ws.length} encoding · ${live?.waitingOnNode || 0} waiting on node`;
      $('#enc-lanes-body').innerHTML = `<div class="devs">${devHtml || '<p class="muted small">No lane is busy right now.</p>'}</div>
        ${rows ? `<div class="tscroll"><table class="dtable"><thead><tr><th>clip</th><th>encoder</th><th>progress</th><th class="r">%</th><th class="r">fps</th><th class="r">speed</th><th class="r">bitrate</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
      // the live controls only change with the job's settings, and never under the user's finger
      const ctlBox = $('#enc-lanes-ctl');
      if (ctl === ctlHtml || (ctl && ctlBox.contains(document.activeElement))) return;
      ctlHtml = ctl;
      ctlBox.innerHTML = ctl;
      wireGroups(ctlBox, groupMem);
      ctlBox.oninput = () => groupTotals(ctlBox);
      el.querySelectorAll('[data-cc]').forEach((b) => { b.onclick = () => changeConcurrency(Number(b.dataset.cc)); });
      $('#lanes-apply')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
        const lanes = [...el.querySelectorAll('[data-lane]')].map((i) => ({ device: i.dataset.lane, concurrency: Math.max(0, Math.min(64, Number(i.value) || 0)) }));
        applySnap(unwrap(await invoke('setLanes', { jobId: snap.id, lanes })), true);
        toast('Lanes changed for the running job.');
      }));
    }
    let ccPending = null;
    function changeConcurrency(d) {
      if (!snap || !ACTIVE.has(snap.state) || snap.config?.lanes?.length) return;
      const out = $('#cc-out');
      const next = Math.max(1, Math.min(64, Number(out?.textContent || snap.config?.concurrency || 1) + d));
      if (out) out.textContent = String(next);
      clearTimeout(ccPending);
      ccPending = setTimeout(async () => {
        const r = await invoke('setConcurrency', { jobId: snap.id, concurrency: next });
        if (r.ok) { applySnap(r.value, true); toast(`${next} at once.`); } else toast(errText(r.error), 'bad');
      }, 350);
    }

    // ---------- timings ----------
    function drawTimings() {
      const t = snap?.timings;
      const tot = t ? PHASES.reduce((n, [k]) => n + (t.totalMs?.[k] || 0), 0) : 0;
      if (!t || !tot) {
        $('#enc-timing').innerHTML = '<header class="card-h"><h2>Timings</h2></header><p class="muted small">Where each converted clip\'s time goes shows here once clips finish.</p>';
        return;
      }
      $('#enc-timing').innerHTML = `<header class="card-h"><h2>Timings</h2><span class="faint small">${plural(t.files, 'clip')} · ${dur(tot)} of work · ${dur(tot / t.files)} per clip</span></header>
        <div class="stackbar" role="img" aria-label="Time per phase">${PHASES.filter(([k]) => t.totalMs?.[k]).map(([k, label, color]) => `<i style="flex:${t.totalMs[k]};background:${color}" title="${esc(label)} ${pct((t.totalMs[k] / tot) * 100, 1)}"></i>`).join('')}</div>
        <div class="tscroll"><table class="dtable"><thead><tr><th>phase</th><th class="r">total</th><th class="r">per clip</th><th class="r">share</th></tr></thead><tbody>
        ${PHASES.filter(([k]) => t.totalMs?.[k]).map(([k, label, color]) => `<tr><td><i class="dot" style="background:${color}"></i>${esc(label)}</td><td class="r num">${dur(t.totalMs[k])}</td><td class="r num">${(t.totalMs[k] / t.files / 1000).toFixed(2)}s</td><td class="r num">${pct((t.totalMs[k] / tot) * 100, 1)}</td></tr>`).join('')}
        </tbody></table></div>`;
    }

    // ---------- clips table ----------
    function drawItems() {
      const items = snap?.items || [];
      const q = tableF.text.toLowerCase();
      const pick = (i) => {
        if (tableF.state === 'all') return true;
        if (tableF.state === 'active') return i.state === 'processing';
        if (tableF.state === 'done') return i.state === 'completed';
        return i.state === tableF.state;
      };
      const list = items.filter((i) => pick(i) && (!q || `${i.relativePath} ${i.state} ${i.resultCode || ''}`.toLowerCase().includes(q)));
      const order = { processing: 0, failed: 1, queued: 2, completed: 3, skipped: 4, cancelled: 5 };
      list.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || String(a.relativePath).localeCompare(String(b.relativePath)));
      $('#enc-items-n').textContent = `${list.length} shown of ${snap?.itemCount || items.length}${snap?.itemsTruncated ? ' (the server sends the newest 256)' : ''}`;
      $('#enc-items').innerHTML = `<thead><tr><th>clip</th><th>group</th><th>cam</th><th>state</th><th class="r">in</th><th class="r">out</th><th class="r">saved</th><th class="r">tries</th></tr></thead><tbody>
        ${list.slice(0, 400).map((i) => {
          const [label, tone] = itemState(i);
          const saved = i.outputBytes && i.sourceBytes && i.kind === 'video' ? (1 - i.outputBytes / i.sourceBytes) * 100 : null;
          return `<tr class="ist-${esc(i.state)}"><td class="mono small ell" title="${esc(i.relativePath)}">${esc(String(i.relativePath || '').split('/').slice(-2).join('/'))}</td><td class="small">${esc(String(i.group || '').replace('Clips', ''))}</td><td class="small">${esc(i.camera || i.assetType || '')}</td><td>${chip(label, tone)}</td><td class="r num">${bytes(i.sourceBytes)}</td><td class="r num">${i.outputBytes ? bytes(i.outputBytes) : '—'}</td><td class="r num">${saved === null ? '—' : pct(saved, 1)}</td><td class="r num">${i.attempts ?? 0}</td></tr>`;
        }).join('') || `<tr><td colspan="8" class="muted" style="padding:14px">${snap ? 'No clips match.' : 'No conversion yet.'}</td></tr>`}</tbody>`;
    }
    wireSeg(el, 'ist', (x) => { tableF.state = x; drawItems(); });
    $('#enc-ifilter').addEventListener('input', debounce((e) => { tableF.text = e.target.value; drawItems(); }, 120));

    // ---------- setup form ----------
    const vehicleOpts = (sel) => state.vehicles.map((x) => `<option value="${esc(x.id)}"${x.id === sel ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    const defaultDest = (veh) => `${ctx.outputRoots?.[0] || '/data/converted'}/${veh?.id || 'vehicle'}`;
    function drawForm() {
      const busyJob = snap && ACTIVE.has(snap.state);
      const veh = state.vehicles.find((x) => x.id === (form.vehicle || v?.id)) || v;
      const lanesMode = devices.length > 1;
      const replaceOk = caps.replacement === 'available';
      if (!replaceOk && form.outputMode === 'replace') form.outputMode = 'separate';
      $('#enc-form').innerHTML = `
        <header class="card-h"><h2>New conversion</h2>${busyJob ? chip('a job is running', 'amber') : ''}</header>
        ${state.vehicles.length ? '' : '<p class="muted">Add a vehicle in Settings first.</p>'}
        <fieldset ${busyJob || !state.vehicles.length ? 'disabled' : ''}>
          <label class="field">Vehicle<select class="input" name="vehicle">${vehicleOpts(veh?.id)}</select><span class="faint small mono ell" title="${esc(sourceOf(veh) || '')}">${esc(sourceOf(veh) || '')}</span></label>
          <div class="field">Codec${seg('codec', [['h265', 'H.265'], ['av1', 'AV1']], form.codec, 'Codec')}</div>
          <label class="field">Size profile<select class="input" name="profileId">
            ${[['conservative', 'Conservative · about 5% smaller'], ['balanced', 'Balanced · about 20% smaller'], ['aggressive', 'Aggressive · about 50% smaller'], ['quality', 'Constant quality'], ['custom', 'Custom bitrate']].map(([x, l]) => `<option value="${x}"${form.profileId === x ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field" data-show="custom"${form.profileId === 'custom' ? '' : ' hidden'}>Bitrate (kbit/s)<input class="input num" type="number" name="bitrateKbps" min="250" max="100000" step="50" value="${esc(form.bitrateKbps)}"></label>
          <label class="field" data-show="quality"${form.profileId === 'quality' ? '' : ' hidden'}>Quality<select class="input" name="qualityLevel">${['high', 'balanced', 'small'].map((x) => `<option${form.qualityLevel === x ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
          <div class="field">Output${seg('outputMode', [['replace', 'Replace originals'], ['separate', 'Separate folder']], form.outputMode, 'Output')}${replaceOk ? '' : '<span class="faint small">Replacing is not available on this share.</span>'}</div>
          <label class="field" data-out="separate"${form.outputMode === 'separate' ? '' : ' hidden'}>Destination folder<input class="input mono" name="dest" value="${esc(form.dest || defaultDest(veh))}" spellcheck="false"><span class="faint small">inside ${esc((ctx.outputRoots || []).join(', ') || 'the output folders')}</span></label>
          <label class="check" data-out="replace"${form.outputMode === 'replace' ? '' : ' hidden'}><input type="checkbox" name="confirmReplace"> Replace each original after it is verified (a backup is kept until the swap succeeds)</label>
          <div class="field">Verify${seg('verifyMode', [['quick', 'Quick'], ['full', 'Full decode']], form.verifyMode, 'Verify')}<span class="faint small">Telemetry is always compared frame by frame; Full also decodes every frame.</span></div>
          <div class="field">Clip groups, in order
            <ol class="grouplist">${form.groupOrder.map((g, i) => `<li><label class="check"><input type="checkbox" name="g-${g}"${form.groups.includes(g) ? ' checked' : ''}> ${esc(g)}</label><span><button class="btn sm icon" type="button" data-gup="${g}" aria-label="Move ${g} up"${i ? '' : ' disabled'}>${icon('up')}</button><button class="btn sm icon" type="button" data-gdown="${g}" aria-label="Move ${g} down"${i < 2 ? '' : ' disabled'}>${icon('down')}</button></span></li>`).join('')}</ol></div>
          ${lanesMode ? `<div class="field">Conversions at once per device<div class="lanes-in">${laneFields(devices, 'next', laneNext)}</div></div>`
            : `<label class="field">Conversions at once<input class="input num" type="number" name="concurrency" min="1" max="64" value="${esc(form.concurrency)}"></label>`}
          <div class="row-actions"><button class="btn primary" type="submit" id="enc-start">${icon('play')}Start conversion</button></div>
        </fieldset>`;
      const f = $('#enc-form');
      wireSeg(f, 'codec', (x) => { form.codec = x; save(); });
      wireSeg(f, 'outputMode', (x) => {
        form.outputMode = x;
        f.querySelectorAll('[data-out]').forEach((n) => { n.hidden = n.dataset.out !== x; });
        save();
      });
      wireSeg(f, 'verifyMode', (x) => { form.verifyMode = x; save(); });
      f.profileId.onchange = () => {
        form.profileId = f.profileId.value;
        f.querySelectorAll('[data-show]').forEach((n) => { n.hidden = n.dataset.show !== form.profileId; });
        save();
      };
      f.vehicle.onchange = () => { form.vehicle = f.vehicle.value; form.dest = ''; save(); drawForm(); drawAuto(); };
      f.querySelectorAll('[data-gup],[data-gdown]').forEach((b) => {
        b.onclick = () => {
          const g = b.dataset.gup || b.dataset.gdown;
          const i = form.groupOrder.indexOf(g);
          const j = b.dataset.gup ? i - 1 : i + 1;
          [form.groupOrder[i], form.groupOrder[j]] = [form.groupOrder[j], form.groupOrder[i]];
          readForm();
          save();
          drawForm();
        };
      });
      f.oninput = () => { readForm(); save(); groupTotals(f); };
      wireGroups(f, groupMem);
    }
    // the next run's number for a device (a node's devices other than its default start at 0)
    const laneNext = (d) => laneValue(form.lanes, d, d.kind === 'cpu' ? 2 : 1);
    // this server's devices as rows; each node that lists its GPUs as a group that opens
    function laneFields(list, scope, valueOf) {
      const { own, nodes } = splitDevices(list);
      const field = (d, label) => `<label class="stepper"><span title="${esc(d.id)}">${esc(label)}</span><input class="input num" type="number" min="0" max="64" ${scope === 'live' ? `data-lane="${esc(d.id)}"` : `name="lane:${esc(d.id)}"`} data-lane-value value="${esc(valueOf(d))}"></label>`;
      const groups = nodes.map((g) => {
        const total = g.devices.reduce((n, d) => n + (Number(valueOf(d)) || 0), 0);
        const gpus = g.devices.filter((d) => d.deviceId !== 'cpu').length;
        const parts = [gpus ? `${gpus} gpu${gpus === 1 ? '' : 's'}` : '', g.devices.some((d) => d.deviceId === 'cpu') ? 'cpu' : ''].filter(Boolean).join(' + ');
        return `<div class="ngroup${g.online ? '' : ' offline'}${total ? '' : ' is-off'}" data-group-box>
          <button type="button" class="ngroup-h" data-node-group="${scope}|${esc(g.key)}" aria-expanded="false" aria-controls="${groupBodyId(scope, g.key)}">
            <span class="ngroup-n"><b>${esc(g.name)}</b><span class="mono faint">node · ${g.online ? '<span class="ok-text">online</span>' : '<span class="bad-text">offline</span>'} · ${esc(parts)}</span></span>
            <span class="ngroup-t num" data-group-total>${total ? `${total}×` : 'off'}</span><span class="chev" aria-hidden="true"></span></button>
          <div class="ngroup-b" id="${groupBodyId(scope, g.key)}" role="group" aria-label="${esc(g.name)}: GPUs and CPU" hidden>${g.devices.map((d) => field(d, deviceLabel(d))).join('')}</div></div>`;
      }).join('');
      return own.map((d) => field(d, d.name || d.id)).join('') + groups;
    }
    // each node group's header: its clips at once in all
    function groupTotals(root) {
      root.querySelectorAll('[data-group-box]').forEach((box) => {
        const n = [...box.querySelectorAll('[data-lane-value]')].reduce((sum, i) => sum + Math.max(0, Number(i.value) || 0), 0);
        const out = box.querySelector('[data-group-total]');
        if (out) out.textContent = n ? `${n}×` : 'off';
        box.classList.toggle('is-off', n === 0);
      });
    }
    function save() { store.set('enc:form', form); }
    function readForm() {
      const f = $('#enc-form');
      if (!f.vehicle) return;
      form.vehicle = f.vehicle.value;
      form.groups = GROUPS.filter((g) => f[`g-${g}`]?.checked);
      if (f.bitrateKbps) form.bitrateKbps = Number(f.bitrateKbps.value);
      if (f.qualityLevel) form.qualityLevel = f.qualityLevel.value;
      if (f.concurrency) form.concurrency = Number(f.concurrency.value);
      if (f.dest) form.dest = f.dest.value.trim();
      f.querySelectorAll('[name^="lane:"]').forEach((i) => { form.lanes[i.name.slice(5)] = Number(i.value) || 0; });
    }
    function configFor(veh) {
      readForm();
      const source = sourceOf(veh);
      if (!source) throw new Error('Choose a vehicle.');
      if (!form.groups.length) throw new Error('Choose at least one clip group.');
      const cfg = {
        sourceRoot: source,
        destinationRoot: form.outputMode === 'replace' ? null : (form.dest || defaultDest(veh)),
        codec: form.codec,
        profileId: form.profileId,
        ...(form.profileId === 'custom' ? { bitrateKbps: Math.round(form.bitrateKbps) } : {}),
        ...(form.profileId === 'quality' ? { qualityLevel: form.qualityLevel } : {}),
        networkMode: 'auto',
        outputMode: form.outputMode,
        includedGroups: form.groupOrder.filter((g) => form.groups.includes(g)),
        groupOrder: [...form.groupOrder],
        replacementConfirmed: form.outputMode === 'replace',
        verifyMode: form.verifyMode
      };
      if (devices.length > 1) {
        const lanes = devices.map((d) => ({ device: d.id, concurrency: Math.max(0, Math.min(64, laneNext(d))) })).filter((l) => l.concurrency > 0);
        if (!lanes.length) throw new Error('Turn on at least one device.');
        cfg.lanes = lanes;
      } else {
        cfg.concurrency = Math.max(1, Math.min(64, Math.round(form.concurrency || 1)));
      }
      return cfg;
    }
    $('#enc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const veh = state.vehicles.find((x) => x.id === (form.vehicle || v?.id)) || v;
      let cfg;
      try { cfg = configFor(veh); } catch (err) { toast(err.message, 'bad'); return; }
      if (cfg.outputMode === 'replace') {
        if (!$('#enc-form').confirmReplace?.checked) { toast(ERRORS.REPLACEMENT_CONFIRMATION_REQUIRED, 'bad'); return; }
        if (!(await confirmDialog({ title: `Replace ${veh.name}'s originals?`, body: `<p>Each clip in <span class="mono">${esc(cfg.sourceRoot)}</span> is converted to ${esc(cfg.codec.toUpperCase())}, verified, and only then swapped in for the original. A failed swap restores the backup.</p>`, ok: 'Start and replace' }))) return;
      }
      await busy($('#enc-start'), async () => {
        const out = unwrap(await invoke('start', cfg));
        toast('Conversion started.');
        lastRev = -1;
        snap = { id: out.jobId, state: 'discovering', revision: 0, createdAt: Date.now(), updatedAt: Date.now(), config: cfg, items: [], counters: {} };
        drawAll();
        refreshCurrent();
      });
    });

    // ---------- automatic ----------
    function drawAuto() {
      const box = $('#enc-auto');
      if (!auto) { box.innerHTML = '<header class="card-h"><h2>Automatic conversion</h2></header><p class="muted small">Not available.</p>'; return; }
      const s = auto.settings || {};
      const veh = state.vehicles.find((x) => x.id === (form.vehicle || v?.id)) || v;
      const src = sourceOf(veh);
      const mine = (s.configs || []).find((c) => c.sourceRoot === src || c.config?.sourceRoot === src);
      const on = Boolean(s.enabled && mine);
      const w = s.window;
      const wmode = !w ? 'none' : w.follow === 'off-peak' ? 'offpeak' : 'hours';
      const st = auto.status || {};
      const last = st.sources?.[src] || {};
      const status = st.checking ? 'checking for new clips…' : st.activeJobId ? `converting ${st.activeSource === src ? 'this vehicle' : 'another vehicle'}` : st.pausedForWindow ? 'paused outside the time window' : last.error ? `last check failed: ${last.error}` : Number.isSafeInteger(last.lastNewFiles) ? `${last.lastNewFiles} new clips at ${isoish(last.lastCheckAt)}` : '';
      box.innerHTML = `<header class="card-h"><h2>Automatic conversion</h2>${chip(on ? 'on' : 'off', on ? 'green' : '')}</header>
        <p class="small muted">Checks ${esc(veh?.name || 'the vehicle')}'s footage for new clips and converts them with the settings above.</p>
        <form id="auto-form" class="grid2">
          <label class="check span2"><input type="checkbox" name="on"${on ? ' checked' : ''}> Convert ${esc(veh?.name || 'this vehicle')}'s new clips automatically</label>
          <label class="field">Check every<select class="input" name="interval">${[[15, '15 min'], [30, '30 min'], [60, '1 h'], [180, '3 h'], [360, '6 h'], [720, '12 h'], [1440, '24 h']].map(([m, l]) => `<option value="${m}"${(s.intervalMinutes || 60) === m ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field">When<select class="input" name="wmode"><option value="none"${wmode === 'none' ? ' selected' : ''}>Any time</option><option value="hours"${wmode === 'hours' ? ' selected' : ''}>Between hours</option><option value="offpeak"${wmode === 'offpeak' ? ' selected' : ''}>Off-peak electricity</option></select></label>
          <label class="field" data-w="hours"${wmode === 'hours' ? '' : ' hidden'}>From (hour)<input class="input num" type="number" min="0" max="23" name="start" value="${w?.startHour ?? 1}"></label>
          <label class="field" data-w="hours"${wmode === 'hours' ? '' : ' hidden'}>To (hour)<input class="input num" type="number" min="0" max="23" name="end" value="${w?.endHour ?? 6}"></label>
          <label class="check span2"><input type="checkbox" name="hold"${s.holdManual ? ' checked' : ''}> Hold my own conversions to the window too</label>
          <label class="check span2"><input type="checkbox" name="keep"${s.keepRunning ? ' checked' : ''}> Keep running past the window until the job ends</label>
          <div class="row-actions span2"><button class="btn primary" type="submit">Save automatic</button><button class="btn" type="button" id="auto-now">${icon('refresh')}Check now</button></div>
        </form>
        <p class="small faint">${esc(status)}${st.nextCheckAt ? ` · next check ${esc(isoish(st.nextCheckAt))}` : ''}${(s.configs || []).length ? ` · ${(s.configs || []).length} vehicle(s) set up` : ''}</p>`;
      const f = $('#auto-form');
      f.wmode.onchange = () => f.querySelectorAll('[data-w]').forEach((n) => { n.hidden = f.wmode.value !== 'hours'; });
      f.onsubmit = async (e) => {
        e.preventDefault();
        const want = f.on.checked;
        const window = f.wmode.value === 'offpeak' ? { follow: 'off-peak' } : f.wmode.value === 'hours' ? { startHour: Number(f.start.value), endHour: Number(f.end.value) } : null;
        const others = (s.configs || []).filter((c) => (c.sourceRoot || c.config?.sourceRoot) !== src).length;
        let body;
        try {
          body = {
            enabled: want || others > 0,
            intervalMinutes: Number(f.interval.value),
            window,
            holdManual: Boolean(window) && f.hold.checked,
            keepRunning: f.keep.checked,
            openAtLogin: Boolean(s.openAtLogin),
            ...(want ? { config: configFor(veh) } : mine ? { removeSource: src } : {})
          };
        } catch (err) { toast(err.message, 'bad'); return; }
        await busy(f.querySelector('[type=submit]'), async () => {
          auto = unwrap(await invoke('setAuto', body));
          toast(want ? 'Automatic conversion saved.' : 'Automatic conversion is off for this vehicle.');
          drawAuto();
        });
      };
      $('#auto-now').onclick = (e) => busy(e.currentTarget, async () => {
        auto = unwrap(await invoke('checkAutoNow'));
        toast('Checking for new clips…');
        drawAuto();
      });
    }

    // ---------- benchmark ----------
    function drawBench() {
      const b = bench;
      const p = b.progress;
      const runs = b.result?.codecs || (b.result ? [b.result] : []);
      $('#enc-bench').innerHTML = `<header class="card-h"><h2>Benchmark</h2>${b.running ? chip('running', 'cyan') : ''}</header>
        <p class="small muted">Encodes copies of a few sample clips at 1, 2, 4… at once and suggests the fastest setting. Originals are only read.</p>
        <div class="row-actions">${seg('bcodec', [['h265', 'H.265'], ['av1', 'AV1'], ['both', 'Both']], store.get('enc:bcodec', 'h265'), 'Benchmark codec')}
          ${b.running ? `<button class="btn danger" type="button" id="bench-cancel">${icon('stop')}Cancel</button>` : `<button class="btn" type="button" id="bench-run"${snap && ACTIVE.has(snap.state) ? ' disabled title="Not while a conversion runs"' : ''}>${icon('gauge')}Run benchmark</button>`}</div>
        ${b.running ? `<div class="bench-prog">${meter(p?.total ? ((p.index || 0) / p.total) * 100 : 5, 'violet')}<span class="small mono">${esc(p ? `${p.codec ? `${String(p.codec).toUpperCase()} · ` : ''}${p.step}${p.level ? ` · ${p.level} at once` : ''}${p.total ? ` · ${p.index}/${p.total}` : ''}` : 'starting…')}</span></div>` : ''}
        ${runs.map((r) => `<div class="bench-run"><b>${esc(String(r.codec || '').toUpperCase())}</b> <span class="faint small">${esc(r.error ? `error: ${r.error}` : `${r.encoder?.codec || ''}${r.encoder?.hardware ? ' (hardware)' : ''} · ${r.clips} sample clips`)}</span>
          ${(r.results || []).length ? `<div class="tscroll"><table class="dtable"><thead><tr><th>at once</th><th class="r">clips/min</th><th class="r">fps</th><th class="r">saved</th><th class="r">time</th><th></th></tr></thead><tbody>${r.results.map((x) => `<tr class="${r.best?.level === x.level ? 'best' : ''}"><td class="num">${x.level}</td><td class="r num">${num(x.filesPerMinute, 1)}</td><td class="r num">${num(x.fps, 0)}</td><td class="r num">${fin(x.savedPercent) ? pct(x.savedPercent, 1) : '—'}</td><td class="r num">${x.seconds}s</td><td>${x.ok ? (r.best?.level === x.level ? chip('best', 'green') : '') : chip(`${x.failed} failed`, 'red')}</td></tr>`).join('')}</tbody></table></div>` : ''}
          ${r.best ? `<button class="btn sm cyan" type="button" data-use-level="${r.best.level}">Use ${r.best.level} at once</button>` : ''}</div>`).join('')}`;
      wireSeg($('#enc-bench'), 'bcodec', (x) => store.set('enc:bcodec', x));
      $('#bench-run')?.addEventListener('click', runBench);
      $('#bench-cancel')?.addEventListener('click', async () => { await invoke('cancelBenchmark'); toast('Cancelling the benchmark…'); });
      el.querySelectorAll('[data-use-level]').forEach((x) => {
        x.onclick = () => { form.concurrency = Number(x.dataset.useLevel); save(); drawForm(); toast(`Set to ${form.concurrency} at once.`); };
      });
    }
    async function runBench() {
      const veh = state.vehicles.find((x) => x.id === (form.vehicle || v?.id)) || v;
      const c = store.get('enc:bcodec', 'h265');
      readForm();
      bench = { running: true, progress: null, result: null };
      drawBench();
      const req = {
        codecs: c === 'both' ? ['h265', 'av1'] : [c], sourceRoot: sourceOf(veh), profileId: form.profileId, verifyMode: form.verifyMode,
        ...(form.profileId === 'custom' ? { bitrateKbps: Math.round(form.bitrateKbps) } : {}), ...(form.profileId === 'quality' ? { qualityLevel: form.qualityLevel } : {})
      };
      const r = await invoke('runBenchmark', req);
      bench.running = false;
      if (r.ok) {
        bench.result = r.value;
        store.set('enc:bench', r.value);
        toast('Benchmark finished.');
      } else {
        toast(r.error?.code === 'CANCELLED' ? 'Benchmark cancelled.' : errText(r.error), r.error?.code === 'CANCELLED' ? 'ok' : 'bad');
      }
      if (alive) drawBench();
    }

    // ---------- converter log ----------
    async function loadLog() {
      try {
        const all = $('#enc-log-all').checked;
        const out = await api('/api/logs?level=all&limit=400', { timeoutMs: 15000 });
        const q = $('#enc-log-filter').value.toLowerCase();
        const lines = (out.lines || []).filter((l) => (all || /converter|nodes|stats/.test(l.scope)) && (!q || `${l.scope} ${l.message}`.toLowerCase().includes(q)));
        $('#enc-log-n').textContent = `${lines.length} lines`;
        $('#enc-log').innerHTML = lines.length ? lines.slice(0, 200).map((l) => `<div class="ll ${esc(l.level)}"><span class="ll-t">${esc(isoish(l.at).slice(11))}</span><span class="ll-l">${esc(l.level)}</span><span class="ll-s">${esc(l.scope)}</span><span class="ll-m">${esc(l.message)}</span></div>`).join('') : '<p class="muted small" style="padding:10px">Nothing from the converter yet.</p>';
      } catch (err) {
        $('#enc-log').textContent = err.message;
      }
    }
    $('#enc-log-refresh').onclick = loadLog;
    $('#enc-log-all').onchange = loadLog;
    $('#enc-log-filter').addEventListener('input', debounce(loadLog, 200));

    // ---------- live data ----------
    function applySnap(s, force = false) {
      if (!s || !s.id) return;
      if (snap && s.id === snap.id && !force && Number.isSafeInteger(s.revision) && s.revision < lastRev) return;
      if (snap && s.id === snap.id && !s.items && snap.items) s = { ...snap, ...s, items: snap.items };
      snap = s;
      lastRev = s.revision ?? lastRev;
    }
    let drawQueued = false;
    function drawAll() {
      if (drawQueued) return;
      drawQueued = true;
      requestAnimationFrame(() => {
        drawQueued = false;
        if (!alive) return;
        drawHead();
        drawKpis();
        drawLanes();
        drawTimings();
        drawItems();
        const f = $('#enc-form');
        const disabled = f.querySelector('fieldset')?.disabled;
        const want = Boolean(snap && ACTIVE.has(snap.state)) || !state.vehicles.length;
        if (disabled !== want) drawForm();
        if (!bench.running && $('#bench-run')) $('#bench-run').disabled = Boolean(snap && ACTIVE.has(snap.state));
      });
    }
    async function refreshCurrent() {
      const r = await invoke('getCurrent');
      if (r.ok) {
        if (r.value) applySnap(r.value, true);
        else snap = null;
      } else if (r.error?.code === 'CONVERTER_STARTING') {
        $('#enc-sub').textContent = 'The converter is starting…';
      }
      drawAll();
    }
    function connect() {
      es = new EventSource(`/api/converter/events?client=${encodeURIComponent(CLIENT_ID)}`);
      let first = true;
      es.addEventListener('hello', async () => {
        await invoke('subscribeProgress');
        if (!first) refreshCurrent();
        first = false;
      });
      es.addEventListener('converter:progress', (e) => {
        let p;
        try { p = JSON.parse(e.data); } catch { return; }
        const s = p.snapshot;
        if (!s) return;
        if (s.progress && !s.items) {
          if (!snap || snap.id !== p.jobId) { refreshCurrent(); return; }
          live = s.progress;
        } else {
          if (snap && snap.id !== s.id) lastRev = -1;
          applySnap(s);
          if (!ACTIVE.has(s.state)) live = null;
        }
        drawAll();
      });
      es.addEventListener('converter:benchmarkProgress', (e) => {
        try { bench.progress = JSON.parse(e.data); } catch { return; }
        bench.running = true;
        drawBench();
      });
      es.addEventListener('error', () => {
        if (es.readyState === EventSource.CLOSED && alive) setTimeout(() => { if (alive) connect(); }, 3000);
      });
    }
    async function pollStats() {
      if (!alive) return;
      if (document.visibilityState === 'visible') {
        try {
          const s = await api('/api/stats', { timeoutMs: 10000 });
          enc = s.encoder;
          price = s.price;
          drawAll();
        } catch { /* keep the last */ }
      }
      statsTimer = setTimeout(pollStats, 2000);
    }

    // ---------- start ----------
    const [d, c, a, x] = await Promise.all([invoke('devices'), invoke('getCapabilities'), invoke('getAuto'), api('/api/stats').catch(() => ({}))]);
    devices = d.ok ? d.value?.devices || [] : [];
    caps = c.ok ? c.value || {} : {};
    auto = a.ok ? a.value : null;
    const dataVol = (x?.filesystems || []).find((f) => !f.vehicle)?.path;
    ctx = { outputRoots: dataVol ? [`${dataVol}/converted`] : [] };
    enc = x?.encoder || null;
    if (params.get('vehicle')) form.vehicle = params.get('vehicle');
    else if (params.get('new') && v) form.vehicle = v.id;
    drawForm();
    drawAuto();
    drawBench();
    await refreshCurrent();
    connect();
    pollStats();
    loadLog();
    logTimer = setInterval(() => { if (document.visibilityState === 'visible' && snap && ACTIVE.has(snap.state)) loadLog(); }, 4000);
    if (params.get('new')) $('#enc-form')?.scrollIntoView({ block: 'start' });
    const cmdOff = bus.on('cmd', (cmd) => {
      if (cmd === 'converter:pause' && snap && RUNNING.has(snap.state)) jobAction('pause');
      if (cmd === 'converter:resume' && snap && !RUNNING.has(snap.state)) jobAction('resume');
    });

    return {
      unmount() {
        alive = false;
        cmdOff();
        clearTimeout(statsTimer);
        clearInterval(logTimer);
        es?.close();
        invoke('unsubscribeProgress');
      },
      onTopics(t) { if (t.includes('vehicles')) drawForm(); },
      onVehicle() { form.vehicle = current()?.id; save(); drawForm(); drawAuto(); },
      onKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        if (e.key === '+' || e.key === '=') { changeConcurrency(1); return true; }
        if (e.key === '-' || e.key === '_') { changeConcurrency(-1); return true; }
        if (e.key === ' ' && snap && ACTIVE.has(snap.state)) { jobAction(RUNNING.has(snap.state) ? 'pause' : 'resume'); return true; }
        return false;
      },
      commands: () => [
        ...(snap && RUNNING.has(snap.state) ? [{ group: 'Encoder', label: 'Pause the conversion', icon: 'pause', run: () => jobAction('pause') }] : []),
        ...(snap && !RUNNING.has(snap.state) && ACTIVE.has(snap.state) ? [{ group: 'Encoder', label: 'Resume the conversion', icon: 'play', run: () => jobAction('resume') }] : []),
        ...(snap && ACTIVE.has(snap.state) ? [{ group: 'Encoder', label: 'Cancel the conversion', icon: 'stop', run: () => jobAction('cancel') }] : []),
        { group: 'Encoder', label: 'Start conversion with the form', icon: 'play', run: () => $('#enc-form').requestSubmit() },
        { group: 'Encoder', label: 'Run benchmark', icon: 'gauge', run: () => $('#bench-run')?.click() }
      ]
    };
  }
};
