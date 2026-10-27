// Encoder: the garage and its dyno. Throughput is a tachometer, each device's
// conversion lanes are cylinders, and the job's progress is a lap counter.
// Everything goes through /api/converter/invoke/* and /api/converter/events.
import { h, ico, api, conv, app, car, carRoot, size, perSec, pc, fixed, count, span, stampFull, watt, wh, cash, ok, toast, ask, act, local, segs, onSegs, pill, bar, panelHead, bus, debounce, CLIENT } from '../core.js';
import { dial, setDial, ring, setRing } from '../gauges.js';
import { splitDevices, deviceLabel, laneValue, jobLanes, groupMemory, groupBodyId, wireGroups } from '../nodelanes.js';

const ACTIVE = new Set(['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing', 'paused', 'paused_network']);
const RUNNING = new Set(['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing']);
const GROUPS = ['RecentClips', 'SavedClips', 'SentryClips'];
const PHASES = [
  ['inspect', 'Inspect source', '#7aa8ff'], ['source', 'Read source', '#3df0ff'], ['timeline', 'Telemetry timeline', '#5dffb0'], ['encode', 'Encode', '#ff3fb4'],
  ['metadata', 'Write telemetry', '#a77bff'], ['checkWait', 'Wait for picture check', '#8b84b0'], ['picture', 'Picture check', '#ff8a3d'], ['verify', 'Verify', '#ffe46b'],
  ['saveWait', 'Wait for save slot', '#6c6890'], ['save', 'Save', '#2fd6a0'], ['cleanup', 'Clean up', '#ffb36b']
];
const WHY = {
  REPLACEMENT_CONFIRMATION_REQUIRED: 'Tick the box to confirm replacing the originals.',
  REPLACEMENT_UNAVAILABLE: 'Replacing originals is not possible on this share.',
  PATH_NOT_ALLOWED: 'That folder is outside the vehicle shares and the output folders.',
  PATH_OVERLAP: 'The destination cannot be inside the source, or the other way round.',
  PATH_UNAVAILABLE: 'That folder cannot be reached right now.',
  INVALID_PATH: 'That is not a usable folder.',
  INVALID_GROUP_SELECTION: 'Pick at least one clip group.',
  INVALID_BITRATE: 'Use a bitrate from 250 to 100000 kbit/s.',
  INVALID_CONCURRENCY: 'Conversions at once: 1 to 64.',
  INVALID_LANES: 'These device settings cannot be used (1 to 64 in all).',
  DEVICE_UNSUPPORTED: 'One of the GPUs cannot encode this codec. Set it to 0 or choose the other codec.',
  JOB_ACTIVE: 'Another conversion is running. Pause or cancel it first.',
  BENCHMARK_ACTIVE: 'A dyno run is already going.',
  BENCHMARK_SOURCE_REQUIRED: 'This vehicle has no clips to test with.',
  AUTO_CONFIG_REQUIRED: 'Automatic conversion needs the tune-up settings.',
  INVALID_AUTO_WINDOW: 'Pick different start and end hours.',
  RECOVERY_REQUIRED: 'This job stopped while replacing an original. Resume it to finish safely.',
  CONVERTER_STARTING: 'The converter is still starting. Try again in a moment.',
  NETWORK_ERROR: 'The server cannot be reached.'
};
const why = (e) => (e?.code === 'DEVICE_UNSUPPORTED' && e.details ? `${e.details.device} cannot encode ${String(e.details.codec).toUpperCase()}. Set it to 0 or choose the other codec.` : WHY[e?.code] || `Converter: ${e?.code || 'failed'}`);
const must = (r) => {
  if (r?.ok) return r.value;
  throw Object.assign(new Error(why(r?.error)), { code: r?.error?.code });
};
const TONE = { encoding: 'cyan', discovering: 'mag', waiting: 'mag', staging: 'mag', verifying: 'cyan', copying: 'cyan', replacing: 'cyan', 'writing-telemetry': 'cyan', paused: 'org', paused_network: 'org', completed: 'grn', failed: 'red', cancelled: '' };
const TACH = [60, 120, 240, 480, 960, 1920, 3840];

export default {
  async mount(el, { params, status }) {
    let snap = null;
    let live = null;
    let enc = null;
    let price = null;
    let devices = [];
    let caps = {};
    let auto = null;
    let outRoots = [];
    let bench = { running: false, progress: null, result: local.get('bench', null) };
    let alive = true;
    let es = null;
    let statsTimer = 0;
    let logTimer = 0;
    let rev = -1;
    let tachMax = 60;
    let ticks = 0;
    let peak = 0;
    const flt = { state: 'all', q: '' };
    // this page's own channel for live progress: a page left a moment ago may still
    // be unsubscribing its channel, which must not silence this one
    const me = `${CLIENT}`.slice(0, 40) + '-' + Math.random().toString(36).slice(2, 10);
    const call = (name, payload) => conv(name, payload, me);
    const v0 = car();
    const form = Object.assign({
      codec: 'h265', profileId: 'balanced', bitrateKbps: 4000, qualityLevel: 'balanced', outputMode: 'replace', verifyMode: 'quick',
      groups: [...GROUPS], groupOrder: ['SentryClips', 'SavedClips', 'RecentClips'], concurrency: 2, lanes: {}, dest: '', vehicle: null
    }, local.get('enc.form', {}));

    el.innerHTML = `
      <section class="ptitle hud">
        <div><h1 class="chrome">Encoder <span id="e-state"></span></h1><p id="e-sub">Warming up the converter…</p></div>
        <div class="pacts" id="e-acts"></div>
      </section>
      <section class="dyno hud" aria-label="Dyno">
        <div class="dy-tach" id="e-tach"></div>
        <div class="dy-lap">${ring('Lap')}</div>
        <div class="dy-read" id="e-read"></div>
      </section>
      <div class="enc-grid">
        <div class="stack">
          <section class="panel hud cyan" id="e-cyl" aria-label="Cylinders"></section>
          <section class="panel hud" aria-label="Clips">
            ${panelHead(`${ico('film')}Clips on the dyno <span class="faint tiny" id="e-itemn"></span>`)}
            <div class="row" style="margin-bottom:10px">${segs('ist', [['all', 'All'], ['active', 'Active'], ['queued', 'Waiting'], ['done', 'Done'], ['failed', 'Failed'], ['skipped', 'Skipped']], 'all', 'Clip state')}<input class="in grow" type="search" id="e-iq" placeholder="Filter clips" aria-label="Filter clips"></div>
            <div class="tblwrap tall"><table class="tbl stack" id="e-items"></table></div>
          </section>
          <section class="panel hud" id="e-time" aria-label="Timings"></section>
        </div>
        <div class="stack">
          <form class="panel hud orange form" id="e-form" novalidate aria-label="Tune-up sheet"></form>
          <section class="panel hud" id="e-auto" aria-label="Automatic conversion"></section>
          <section class="panel hud" id="e-bench" aria-label="Dyno run"></section>
        </div>
      </div>
      <section class="panel hud" aria-label="Converter log">
        ${panelHead(`${ico('flag')}Converter log <span class="faint tiny" id="e-logn"></span>`, `<button class="btn sm" type="button" id="e-logref">${ico('refresh')}Refresh</button>`)}
        <div class="row" style="margin-bottom:10px"><input class="in grow" type="search" id="e-logq" placeholder="Filter" aria-label="Filter the converter log"><label class="chk"><input type="checkbox" id="e-logall"> Every scope</label></div>
        <div class="logbox short" id="e-log" tabindex="0" aria-label="Converter log lines"></div>
      </section>`;
    const $ = (s) => el.querySelector(s);
    // which node blocks are open, per browser
    const groupMem = groupMemory(local, 'enc.nodeGroups');
    /** Replaces the markup only when it changed (keeps buttons stable under a tap). */
    const drawn = new WeakMap();
    const setHtml = (node, html) => {
      if (drawn.get(node) === html) return false;
      drawn.set(node, html);
      node.innerHTML = html;
      return true;
    };

    // ---------- helpers ----------
    const jobCar = () => {
      const src = snap?.config?.sourceRoot;
      return app.vehicles.find((x) => src && (carRoot(x) === src || x.root === src || src.startsWith(`${x.root}/`))) || null;
    };
    const formCar = () => app.vehicles.find((x) => x.id === (form.vehicle || v0?.id)) || v0;
    function tally() {
      if (!snap) return null;
      const items = (snap.items || []).filter((i) => i.kind === 'video');
      const c = { total: items.length, completed: 0, skipped: 0, failed: 0, queued: 0, processing: 0 };
      for (const i of items) c[i.state] = (c[i.state] || 0) + 1;
      if (snap.itemsTruncated && snap.itemStateCounts) {
        const s = snap.itemStateCounts;
        Object.assign(c, { total: snap.itemCount, completed: s.completed, skipped: s.skipped, failed: s.failed, queued: s.queued, processing: s.active });
      }
      c.done = c.completed + c.skipped + c.failed;
      return c;
    }
    const workerOf = (id) => (enc?.workers || []).find((w) => w.itemId === id) || null;
    function itemLabel(i) {
      if (i.state === 'processing') {
        const w = workerOf(i.id);
        if (w?.waitingOnNode) return ['waiting on a node', 'org'];
        if (w) return [`encoding ${w.durationUs ? Math.round((w.outTimeUs / w.durationUs) * 100) : 0}%`, 'cyan'];
        if (snap?.state === 'discovering') return ['discovering', 'mag'];
        return [live?.waitingOnNode ? 'on a node / verify / save' : 'verify / save', 'mag'];
      }
      if (i.state === 'queued') return [snap?.state === 'discovering' ? 'found' : 'waiting', ''];
      if (i.state === 'completed') return [i.kind === 'asset' || i.eligibleVideo === false ? 'copied' : 'done', 'grn'];
      if (i.state === 'failed') return [`failed ${i.resultCode || i.failure?.code || ''}`, 'red'];
      if (i.state === 'skipped') return [`skipped${i.resultCode ? ` ${i.resultCode}` : ''}`, ''];
      return [i.state, ''];
    }

    // ---------- header ----------
    function drawHead() {
      const s = snap;
      const name = s?.state || 'idle';
      setHtml($('#e-state'), pill(name.replace('_', ' '), TONE[name] || ''));
      bus.emit('converter-state', s?.state || null);
      const jc = jobCar();
      $('#e-sub').textContent = s ? `${jc?.name || s.config?.sourceRoot || ''} → ${String(s.config?.codec || '').toUpperCase()} · ${s.config?.outputMode === 'replace' ? 'replacing originals' : `copies in ${s.config?.destinationRoot}`} · verify ${s.config?.verifyMode || 'full'}${s.config?.autoConvert ? ' · automatic' : ''} · started ${stampFull(s.createdAt)} · job ${s.id.slice(0, 8)}` : 'The engine is off. Fill in the tune-up sheet to start a conversion.';
      const a = [];
      const c = tally();
      if (s && RUNNING.has(s.state)) a.push(`<button class="btn" type="button" data-job="pause">${ico('pause')}Pause</button>`);
      if (s && (s.state === 'paused' || s.state === 'paused_network')) a.push(`<button class="btn go" type="button" data-job="resume">${ico('play')}Resume</button>`);
      if (s && ACTIVE.has(s.state)) a.push(`<button class="btn danger" type="button" data-job="cancel">${ico('stop')}Cancel</button>`);
      if (s && !RUNNING.has(s.state) && c?.failed) a.push(`<button class="btn" type="button" data-job="retryFailed">${ico('refresh')}Retry failed</button>`);
      if (s && s.state === 'completed') a.push(`<button class="btn" type="button" data-job="dismissSummary">${ico('check')}Dismiss</button>`);
      if (s && (s.state === 'paused' || s.state === 'paused_network' || s.recovery)) a.push(`<button class="btn ghost" type="button" data-job="discard">Set aside…</button>`);
      setHtml($('#e-acts'), a.join(''));
    }
    $('#e-acts').addEventListener('click', (e) => {
      const b = e.target.closest('[data-job]');
      if (b) jobAct(b.dataset.job, b);
    });
    async function jobAct(name, btn) {
      if (!snap) return;
      if (name === 'cancel' && !(await ask({ title: 'Cancel this conversion?', body: '<p>Clips already converted stay converted, the rest stay as they are. An original is never left half-replaced.</p>', yes: 'Cancel conversion', no: 'Keep going', danger: true }))) return;
      if (name === 'discard' && !(await ask({ title: 'Set this job aside?', body: '<p>Only for a job that can neither resume nor cancel. Its record stays on the server and the Encoder moves on.</p>', yes: 'Set aside', danger: true }))) return;
      await act(btn, async () => {
        const out = must(await call(name, { jobId: snap.id }));
        if (name === 'discard' || name === 'dismissSummary') { snap = name === 'discard' ? out : null; rev = -1; } else if (out?.id) take(out, true);
        toast({ pause: 'Paused.', resume: 'Resumed.', cancel: 'Cancelled.', retryFailed: 'Retrying the failed clips.', dismissSummary: 'Dismissed.', discard: 'Set aside.' }[name]);
        drawAll();
      });
    }

    // ---------- the dyno: tachometer, lap counter, readouts ----------
    function drawDyno() {
      const s = snap;
      const c = tally();
      const fps = (enc?.workers || []).reduce((n, w) => n + (ok(w.fps) ? w.fps : 0), 0) || live?.fps || 0;
      peak = Math.max(peak, fps);
      const want = TACH.find((x) => x >= Math.max(fps, peak) * 1.15) || TACH[TACH.length - 1];
      if (want !== tachMax || !$('#e-tach').firstChild) {
        tachMax = want;
        $('#e-tach').innerHTML = dial({ max: tachMax, majors: 6, label: 'Throughput', unit: 'fps', red: 0.85, fmt: (x) => (tachMax >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(Math.round(x))), cls: 'tach' });
      }
      setDial($('#e-tach'), fps, fps ? fixed(fps, 0) : '0', RUNNING.has(s?.state) ? 'frames / s' : 'engine off');
      const done = c ? c.done : 0;
      setRing(el, c?.total ? done / c.total : 0, c ? `${done}/${c.total}` : '0/0', c?.total ? `${pc((done / c.total) * 100)}${s?.discoveryComplete === false ? ' · still finding clips' : ''}` : 'no job');
      const elapsed = s ? ((RUNNING.has(s.state) ? Date.now() : s.updatedAt) - s.createdAt) : null;
      const left = c ? c.total - done : 0;
      const per = done > 0 && elapsed ? elapsed / done : null;
      const eta = per && left > 0 && RUNNING.has(s?.state) ? per * left : null;
      const srcB = s?.counters?.sourceVideoBytes || 0;
      const outB = s?.counters?.outputVideoBytes || 0;
      const thr = elapsed > 0 ? srcB / (elapsed / 1000) : null;
      const conc = Math.max(1, enc?.concurrency || s?.config?.concurrency || 1);
      const cur = price?.currency || app.power?.currency || '$';
      const r = (label, value, sub, tone = '') => `<div class="rd ${tone}"><span class="rd-l">${h(label)}</span><b class="num">${value}</b><span class="rd-s">${h(sub)}</span></div>`;
      $('#e-read').innerHTML = [
        r('Speed', h(thr ? perSec(thr) : '—'), 'source read per second'),
        r('Time left', h(eta ? span(eta) : '—'), elapsed ? `running ${span(elapsed)}` : 'not running'),
        r('Saved', h(size(s?.counters?.savedBytes)), srcB ? `${pc((1 - outB / srcB) * 100, 1)} smaller` : '—', 'grn'),
        r('Failed', c ? String(c.failed) : '—', c?.failed ? 'originals kept' : 'none', c?.failed ? 'red' : ''),
        r('Lanes', `${live?.encodingNow ?? enc?.workers?.length ?? 0}<span class="faint">/${conc}</span>`, `${live?.waitingOnNode || 0} clips waiting on nodes`),
        r('Fuel used', h(enc?.run && ok(enc.run.wh) ? wh(enc.run.wh) : '—'), enc?.run && ok(enc.run.cost) ? cash(enc.run.cost, cur) : enc?.run?.avgW ? `avg ${watt(enc.run.avgW)}` : 'not measured')
      ].join('');
      el.querySelector('.dyno').classList.toggle('revving', RUNNING.has(s?.state));
      status(s ? `${(s.state || '').replace('_', ' ')} · lap ${done}/${c?.total ?? 0}` : 'engine off');
    }

    // ---------- cylinders (lanes) ----------
    function drawCyl() {
      const s = snap;
      const ws = enc?.workers || [];
      const devs = enc?.devices || [];
      const lanes = s?.config?.lanes;
      let ctl = '';
      if (s && ACTIVE.has(s.state)) {
        if (Array.isArray(lanes) && lanes.length) {
          const all = devices.length ? devices : lanes.map((l) => ({ id: l.device, name: l.device }));
          const running = jobLanes(all, lanes);
          ctl = `<div class="live-ctl"><span class="small dim">Conversions at once per device, for the running job</span>${laneFields(all, 'live', (d) => running.get(d.id) ?? 0)}<div class="row"><button class="btn go sm" type="button" id="e-lanes">Apply</button></div></div>`;
        } else {
          const cc = s.config?.concurrency || enc?.concurrency || 1;
          ctl = `<div class="live-ctl"><span class="small dim">Cylinders firing (conversions at once), for the running job</span><div class="row"><button class="btn icon" type="button" data-cc="-1" aria-label="Fewer at once (−)">${ico('minus')}</button><output class="cc num" id="e-cc" aria-live="polite">${cc}</output><button class="btn icon" type="button" data-cc="1" aria-label="More at once (+)">${ico('plus')}</button></div></div>`;
        }
      }
      const blocks = (devs.length ? devs : ws.length ? [{ name: 'CPU', workers: ws.length }] : []).map((d) => {
        const mine = ws.filter((w) => (devs.length ? ((w.deviceId || w.device || null) === (d.id || null) || (!d.id && !w.deviceId)) : true));
        const fps = mine.reduce((n, w) => n + (ok(w.fps) ? w.fps : 0), 0);
        return `<div class="block"><div class="block-h"><b>${h(d.name || d.id || 'CPU')}</b><span class="small faint mono">${h(d.encoder || '')}${d.hardware ? ' · hardware' : d.encoder ? ' · software' : ''}</span><span class="num small">${fixed(fps, 0)} fps</span></div>
          <div class="cyls">${mine.map((w) => {
            const p = w.durationUs ? (w.outTimeUs / w.durationUs) * 100 : 0;
            return `<div class="cyl${w.waitingOnNode ? ' wait' : ''}" title="${h(w.relativePath)}"><div class="bore"><i style="transform:scaleY(${(Math.max(0, Math.min(100, p)) / 100).toFixed(3)})"></i><span class="num">${Math.round(p)}%</span></div>
              <span class="cyl-n mono ell">${h(String(w.relativePath || '').split('/').pop())}</span><span class="tiny faint num">${ok(w.fps) ? `${Math.round(w.fps)} fps` : w.waitingOnNode ? 'on node' : '—'}${ok(w.speed) ? ` · ${fixed(w.speed, 1)}×` : ''}${w.remote ? ' · node' : ''}</span></div>`;
          }).join('') || '<p class="small faint">Idle.</p>'}</div>
          ${ok(d.video) || ok(d.busy) ? `<p class="tiny faint">${ok(d.video) ? `video engine ${pc(d.video)}` : ''}${ok(d.busy) ? ` · busy ${pc(d.busy)}` : ''}</p>` : ''}</div>`;
      }).join('');
      if (!$('#e-cyl .blocks')) $('#e-cyl').innerHTML = `${panelHead(`${ico('engine')}Cylinders`, '<span class="small dim" id="e-cyln"></span>')}<div id="e-ctl"></div><div class="blocks"></div>`;
      $('#e-cyln').textContent = `${ws.length} firing · ${live?.waitingOnNode || 0} waiting on nodes`;
      setHtml($('#e-cyl .blocks'), blocks || '<p class="small dim">No lane is firing. Start a conversion and each device shows up here as an engine block, one cylinder per clip being converted.</p>');
      // the live controls only change when the job's settings do, and never under the user's finger
      const ctlBox = $('#e-ctl');
      if (ctlBox.contains(document.activeElement) && drawn.has(ctlBox) && ctl) return;
      if (ccTimer && ctl.includes('data-cc')) return;
      if (!setHtml(ctlBox, ctl)) return;
      wireGroups(ctlBox, groupMem);
      ctlBox.oninput = () => groupTotals(ctlBox);
      el.querySelectorAll('[data-cc]').forEach((b) => { b.onclick = () => bump(Number(b.dataset.cc)); });
      $('#e-lanes')?.addEventListener('click', (e) => act(e.currentTarget, async () => {
        const l = [...el.querySelectorAll('[data-lane]')].map((i) => ({ device: i.dataset.lane, concurrency: Math.max(0, Math.min(64, Number(i.value) || 0)) }));
        take(must(await call('setLanes', { jobId: snap.id, lanes: l })), true);
        toast('Lanes changed for the running job.');
      }));
    }
    let ccTimer = 0;
    function bump(d) {
      if (!snap || !ACTIVE.has(snap.state) || snap.config?.lanes?.length) return;
      const out = $('#e-cc');
      const next = Math.max(1, Math.min(64, Number(out?.textContent || snap.config?.concurrency || 1) + d));
      if (out) out.textContent = String(next);
      clearTimeout(ccTimer);
      ccTimer = setTimeout(async () => {
        ccTimer = 0;
        const r = await call('setConcurrency', { jobId: snap.id, concurrency: next });
        if (r.ok) { take(r.value, true); toast(`${next} at once.`); } else toast(why(r.error), 'bad');
      }, 350);
    }

    // ---------- timings ----------
    function drawTimes() {
      const t = snap?.timings;
      const tot = t ? PHASES.reduce((n, [k]) => n + (t.totalMs?.[k] || 0), 0) : 0;
      if (!t || !tot) {
        $('#e-time').innerHTML = `${panelHead(`${ico('tacho')}Timing sheet`)}<p class="small dim">Where each clip's time goes appears here once clips finish.</p>`;
        return;
      }
      const used = PHASES.filter(([k]) => t.totalMs?.[k]);
      $('#e-time').innerHTML = `${panelHead(`${ico('tacho')}Timing sheet`, `<span class="small dim">${count(t.files, 'clip')} · ${span(tot)} of work · ${span(tot / t.files)} per clip</span>`)}
        <div class="stackbar" role="img" aria-label="Time per phase">${used.map(([k, l, c]) => `<i style="flex:${t.totalMs[k]};background:${c}"></i>`).join('')}</div>
        <div class="tblwrap"><table class="tbl"><thead><tr><th>Phase</th><th class="r">Total</th><th class="r">Per clip</th><th class="r">Share</th></tr></thead><tbody>
        ${used.map(([k, l, c]) => `<tr><td><span class="sw" style="background:${c}"></span>${h(l)}</td><td class="r num">${span(t.totalMs[k])}</td><td class="r num">${(t.totalMs[k] / t.files / 1000).toFixed(2)} s</td><td class="r num">${pc((t.totalMs[k] / tot) * 100, 1)}</td></tr>`).join('')}</tbody></table></div>`;
    }

    // ---------- clips table ----------
    function drawItems() {
      const items = snap?.items || [];
      const q = flt.q.toLowerCase();
      const pick = (i) => flt.state === 'all' || (flt.state === 'active' ? i.state === 'processing' : flt.state === 'done' ? i.state === 'completed' : i.state === flt.state);
      const order = { processing: 0, failed: 1, queued: 2, completed: 3, skipped: 4, cancelled: 5 };
      const list = items.filter((i) => pick(i) && (!q || `${i.relativePath} ${i.state} ${i.resultCode || ''}`.toLowerCase().includes(q)))
        .sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || String(a.relativePath).localeCompare(String(b.relativePath)));
      $('#e-itemn').textContent = `${list.length} shown of ${snap?.itemCount || items.length}${snap?.itemsTruncated ? ' (the server sends the newest 256)' : ''}`;
      $('#e-items').innerHTML = `<thead><tr><th>Clip</th><th>Group</th><th>Camera</th><th>State</th><th class="r">In</th><th class="r">Out</th><th class="r">Saved</th><th class="r">Tries</th></tr></thead><tbody>
        ${list.slice(0, 400).map((i) => {
          const [l, tone] = itemLabel(i);
          const saved = i.outputBytes && i.sourceBytes && i.kind === 'video' ? (1 - i.outputBytes / i.sourceBytes) * 100 : null;
          return `<tr><td data-label="Clip" class="mono small wrap-any">${h(String(i.relativePath || '').split('/').slice(-2).join('/'))}</td><td data-label="Group" class="small">${h(String(i.group || '').replace('Clips', ''))}</td><td data-label="Camera" class="small">${h(i.camera || i.assetType || '')}</td><td data-label="State">${pill(l, tone)}</td><td data-label="In" class="r num">${size(i.sourceBytes)}</td><td data-label="Out" class="r num">${i.outputBytes ? size(i.outputBytes) : '—'}</td><td data-label="Saved" class="r num">${saved === null ? '—' : pc(saved, 1)}</td><td data-label="Tries" class="r num">${i.attempts ?? 0}</td></tr>`;
        }).join('') || `<tr><td colspan="8" class="dim">${snap ? 'No clip matches.' : 'No conversion yet.'}</td></tr>`}</tbody>`;
    }
    onSegs(el, 'ist', (x) => { flt.state = x; drawItems(); });
    $('#e-iq').addEventListener('input', debounce((e) => { flt.q = e.target.value; drawItems(); }, 120));

    // ---------- tune-up sheet ----------
    const defDest = (veh) => `${outRoots[0] || '/data/converted'}/${veh?.id || 'vehicle'}`;
    function drawForm() {
      const busyJob = snap && ACTIVE.has(snap.state);
      const veh = formCar();
      const multi = devices.length > 1;
      const canReplace = caps.replacement === 'available';
      if (!canReplace && form.outputMode === 'replace') form.outputMode = 'separate';
      $('#e-form').innerHTML = `
        ${panelHead(`${ico('gear')}Tune-up sheet`, busyJob ? pill('a job is running', 'org') : '')}
        ${app.vehicles.length ? '' : '<p class="dim">Add a vehicle in Settings first.</p>'}
        <fieldset class="form plain"${busyJob || !app.vehicles.length ? ' disabled' : ''}>
          <legend class="sr-only">New conversion</legend>
          <label class="fld">Vehicle<select class="in" name="vehicle">${app.vehicles.map((x) => `<option value="${h(x.id)}"${x.id === veh?.id ? ' selected' : ''}>${h(x.name)}</option>`).join('')}</select><span class="hint mono wrap-any">${h(carRoot(veh) || '')}</span></label>
          <div class="fld">Codec${segs('codec', [['h265', 'H.265'], ['av1', 'AV1']], form.codec, 'Codec')}</div>
          <label class="fld">Size profile<select class="in" name="profileId">${[['conservative', 'Conservative · about 5% smaller'], ['balanced', 'Balanced · about 20% smaller'], ['aggressive', 'Aggressive · about 50% smaller'], ['quality', 'Constant quality'], ['custom', 'Custom bitrate']].map(([x, l]) => `<option value="${x}"${form.profileId === x ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="fld" data-show="custom"${form.profileId === 'custom' ? '' : ' hidden'}>Bitrate (kbit/s)<input class="in num" type="number" inputmode="numeric" name="bitrateKbps" min="250" max="100000" step="50" value="${h(form.bitrateKbps)}"></label>
          <label class="fld" data-show="quality"${form.profileId === 'quality' ? '' : ' hidden'}>Quality<select class="in" name="qualityLevel">${[['high', 'High'], ['balanced', 'Balanced'], ['small', 'Small']].map(([x, l]) => `<option value="${x}"${form.qualityLevel === x ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <div class="fld">Output${segs('outputMode', [['replace', 'Replace originals'], ['separate', 'Separate folder']], form.outputMode, 'Output')}${canReplace ? '' : '<span class="hint">Replacing is not possible on this share.</span>'}</div>
          <label class="fld" data-out="separate"${form.outputMode === 'separate' ? '' : ' hidden'}>Destination folder<input class="in mono" name="dest" value="${h(form.dest || defDest(veh))}" spellcheck="false" autocapitalize="none"><span class="hint">inside ${h(outRoots.join(', ') || 'the output folders')}</span></label>
          <label class="chk" data-out="replace"${form.outputMode === 'replace' ? '' : ' hidden'}><input type="checkbox" name="confirmReplace"> Replace each original once its copy is verified (a backup is kept until the swap succeeds)</label>
          <div class="fld">Verify${segs('verifyMode', [['quick', 'Quick'], ['full', 'Full decode']], form.verifyMode, 'Verify')}<span class="hint">Telemetry is always compared frame by frame; Full also decodes every frame.</span></div>
          <div class="fld">Clip groups, in order<ol class="grouplist">${form.groupOrder.map((g, i) => `<li><label class="chk"><input type="checkbox" name="g-${g}"${form.groups.includes(g) ? ' checked' : ''}> ${h(g)}</label><span class="row"><button class="btn icon ghost" type="button" data-up="${g}" aria-label="Move ${g} up"${i ? '' : ' disabled'}>${ico('up')}</button><button class="btn icon ghost" type="button" data-down="${g}" aria-label="Move ${g} down"${i < 2 ? '' : ' disabled'}>${ico('down')}</button></span></li>`).join('')}</ol></div>
          ${multi ? `<div class="fld">Conversions at once per device${laneFields(devices, 'next', laneNext)}</div>`
            : `<label class="fld">Conversions at once<input class="in num" type="number" inputmode="numeric" name="concurrency" min="1" max="64" value="${h(form.concurrency)}"></label>`}
          <button class="btn go wide" type="submit" id="e-start">${ico('play')}Start the engine</button>
        </fieldset>`;
      const f = $('#e-form');
      onSegs(f, 'codec', (x) => { form.codec = x; save(); });
      onSegs(f, 'outputMode', (x) => { form.outputMode = x; f.querySelectorAll('[data-out]').forEach((n) => { n.hidden = n.dataset.out !== x; }); save(); });
      onSegs(f, 'verifyMode', (x) => { form.verifyMode = x; save(); });
      if (f.profileId) {
        f.profileId.onchange = () => { form.profileId = f.profileId.value; f.querySelectorAll('[data-show]').forEach((n) => { n.hidden = n.dataset.show !== form.profileId; }); save(); };
        f.vehicle.onchange = () => { form.vehicle = f.vehicle.value; form.dest = ''; save(); drawForm(); drawAuto(); };
      }
      f.querySelectorAll('[data-up],[data-down]').forEach((b) => {
        b.onclick = () => {
          read();
          const g = b.dataset.up || b.dataset.down;
          const i = form.groupOrder.indexOf(g);
          const j = b.dataset.up ? i - 1 : i + 1;
          [form.groupOrder[i], form.groupOrder[j]] = [form.groupOrder[j], form.groupOrder[i]];
          save();
          drawForm();
          f.querySelector(`[data-${b.dataset.up ? 'up' : 'down'}="${g}"]`)?.focus();
        };
      });
      f.oninput = () => { read(); save(); groupTotals(f); };
      wireGroups(f, groupMem);
    }
    // the next run's number for a device (a node's devices other than its default start at 0)
    const laneNext = (d) => laneValue(form.lanes, d, d.kind === 'cpu' ? 2 : 1);
    // this server's devices as inputs; each node that lists its GPUs as an engine block that opens
    function laneFields(list, scope, valueOf) {
      const { own, nodes } = splitDevices(list);
      const field = (d, label) => `<label class="fld lane-in">${h(label)}<input class="in num" type="number" inputmode="numeric" min="0" max="64" ${scope === 'live' ? `data-lane="${h(d.id)}"` : `name="lane:${h(d.id)}"`} data-lane-value value="${h(valueOf(d))}"></label>`;
      const blocks = nodes.map((g) => {
        const total = g.devices.reduce((n, d) => n + (Number(valueOf(d)) || 0), 0);
        return `<div class="nblock${g.online ? '' : ' offline'}${total ? '' : ' is-off'}" data-group-box>
          <button type="button" class="nblock-h" data-node-group="${scope}|${h(g.key)}" aria-expanded="false" aria-controls="${groupBodyId(scope, g.key)}">
            ${ico('nodes')}<span class="nblock-n"><b>${h(g.name)}</b><span class="small faint">${g.online ? 'online' : 'offline: check it under Nodes'} · ${h(count(g.devices.length, 'device'))}</span></span>
            <span class="nblock-t num" data-group-total>${total ? h(count(total, 'cylinder')) : 'off'}</span>${ico('down', 'i chev')}</button>
          <div class="nblock-b grid2" id="${groupBodyId(scope, g.key)}" role="group" aria-label="${h(g.name)}: GPUs and CPU" hidden>${g.devices.map((d) => field(d, deviceLabel(d))).join('')}</div></div>`;
      }).join('');
      return `${own.length ? `<div class="grid2">${own.map((d) => field(d, d.name || d.id)).join('')}</div>` : ''}${blocks ? `<div class="nblocks">${blocks}</div>` : ''}`;
    }
    // each node block's header: its cylinders (clips at once) in all
    function groupTotals(root) {
      root.querySelectorAll('[data-group-box]').forEach((box) => {
        const n = [...box.querySelectorAll('[data-lane-value]')].reduce((sum, i) => sum + Math.max(0, Number(i.value) || 0), 0);
        const out = box.querySelector('[data-group-total]');
        if (out) out.textContent = n ? count(n, 'cylinder') : 'off';
        box.classList.toggle('is-off', n === 0);
      });
    }
    const save = () => local.set('enc.form', form);
    function read() {
      const f = $('#e-form');
      if (!f.vehicle) return;
      form.vehicle = f.vehicle.value;
      form.groups = GROUPS.filter((g) => f[`g-${g}`]?.checked);
      if (f.bitrateKbps) form.bitrateKbps = Number(f.bitrateKbps.value);
      if (f.qualityLevel) form.qualityLevel = f.qualityLevel.value;
      if (f.concurrency) form.concurrency = Number(f.concurrency.value);
      if (f.dest) form.dest = f.dest.value.trim();
      f.querySelectorAll('[name^="lane:"]').forEach((i) => { form.lanes[i.name.slice(5)] = Number(i.value) || 0; });
    }
    function config(veh) {
      read();
      const src = carRoot(veh);
      if (!src) throw new Error('Choose a vehicle.');
      if (!form.groups.length) throw new Error('Pick at least one clip group.');
      const cfg = {
        sourceRoot: src,
        destinationRoot: form.outputMode === 'replace' ? null : (form.dest || defDest(veh)),
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
      } else cfg.concurrency = Math.max(1, Math.min(64, Math.round(form.concurrency || 1)));
      return cfg;
    }
    $('#e-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const veh = formCar();
      let cfg;
      try { cfg = config(veh); } catch (err) { toast(err.message, 'bad'); return; }
      if (cfg.outputMode === 'replace') {
        if (!$('#e-form').confirmReplace?.checked) { toast(WHY.REPLACEMENT_CONFIRMATION_REQUIRED, 'bad'); return; }
        if (!(await ask({ title: `Replace ${veh.name}'s originals?`, body: `<p>Each clip in <span class="mono">${h(cfg.sourceRoot)}</span> is converted to ${h(cfg.codec.toUpperCase())}, verified, and only then swapped in for its original. A failed swap puts the backup back.</p>`, yes: 'Start and replace' }))) return;
      }
      await act($('#e-start'), async () => {
        const out = must(await call('start', cfg));
        toast('Engine started: conversion running.');
        rev = -1;
        peak = 0;
        snap = { id: out.jobId, state: 'discovering', revision: 0, createdAt: Date.now(), updatedAt: Date.now(), config: cfg, items: [], counters: {} };
        drawAll();
        refresh();
      });
    });

    // ---------- automatic ----------
    function drawAuto() {
      const box = $('#e-auto');
      if (!auto) { box.innerHTML = `${panelHead(`${ico('refresh')}Automatic conversion`)}<p class="small dim">Not available.</p>`; return; }
      const s = auto.settings || {};
      const veh = formCar();
      const src = carRoot(veh);
      const mine = (s.configs || []).find((c) => c.sourceRoot === src || c.config?.sourceRoot === src);
      const on = Boolean(s.enabled && mine);
      const w = s.window;
      const wm = !w ? 'none' : w.follow === 'off-peak' ? 'offpeak' : 'hours';
      const as = auto.status || {};
      const last = as.sources?.[src] || {};
      const line = as.checking ? 'checking for new clips…' : as.activeJobId ? `converting ${as.activeSource === src ? 'this vehicle' : 'another vehicle'}` : as.pausedForWindow ? 'waiting for the time window' : last.error ? `last check failed: ${last.error}` : Number.isSafeInteger(last.lastNewFiles) ? `${last.lastNewFiles} new clips at ${stampFull(last.lastCheckAt)}` : '';
      box.innerHTML = `${panelHead(`${ico('refresh')}Automatic conversion`, pill(on ? 'on' : 'off', on ? 'grn' : ''))}
        <p class="small dim">Checks ${h(veh?.name || 'the vehicle')}'s footage for new clips and converts them with the tune-up sheet above.</p>
        <form id="e-autof" class="grid2" style="margin-top:10px">
          <label class="chk span-all"><input type="checkbox" name="on"${on ? ' checked' : ''}> Convert ${h(veh?.name || 'this vehicle')}'s new clips automatically</label>
          <label class="fld">Check every<select class="in" name="interval">${[[15, '15 min'], [30, '30 min'], [60, '1 hour'], [180, '3 hours'], [360, '6 hours'], [720, '12 hours'], [1440, '24 hours']].map(([m, l]) => `<option value="${m}"${(s.intervalMinutes || 60) === m ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="fld">When<select class="in" name="wmode"><option value="none"${wm === 'none' ? ' selected' : ''}>Any time</option><option value="hours"${wm === 'hours' ? ' selected' : ''}>Between hours</option><option value="offpeak"${wm === 'offpeak' ? ' selected' : ''}>Off-peak electricity</option></select></label>
          <label class="fld" data-w${wm === 'hours' ? '' : ' hidden'}>From hour<input class="in num" type="number" inputmode="numeric" min="0" max="23" name="start" value="${w?.startHour ?? 1}"></label>
          <label class="fld" data-w${wm === 'hours' ? '' : ' hidden'}>To hour<input class="in num" type="number" inputmode="numeric" min="0" max="23" name="end" value="${w?.endHour ?? 6}"></label>
          <label class="chk span-all"><input type="checkbox" name="hold"${s.holdManual ? ' checked' : ''}> Hold my own conversions to the window too</label>
          <label class="chk span-all"><input type="checkbox" name="keep"${s.keepRunning ? ' checked' : ''}> Keep running past the window until the job ends</label>
          <div class="row span-all"><button class="btn go" type="submit">Save automatic</button><button class="btn" type="button" id="e-autonow">${ico('refresh')}Check now</button></div>
        </form>
        <p class="small faint" style="margin-top:8px">${h(line)}${as.nextCheckAt ? ` · next check ${h(stampFull(as.nextCheckAt))}` : ''}${(s.configs || []).length ? ` · ${count((s.configs || []).length, 'vehicle')} set up` : ''}</p>`;
      const f = $('#e-autof');
      f.wmode.onchange = () => f.querySelectorAll('[data-w]').forEach((n) => { n.hidden = f.wmode.value !== 'hours'; });
      f.onsubmit = async (e) => {
        e.preventDefault();
        const want = f.on.checked;
        const win = f.wmode.value === 'offpeak' ? { follow: 'off-peak' } : f.wmode.value === 'hours' ? { startHour: Number(f.start.value), endHour: Number(f.end.value) } : null;
        const others = (s.configs || []).filter((c) => (c.sourceRoot || c.config?.sourceRoot) !== src).length;
        let body;
        try {
          body = { enabled: want || others > 0, intervalMinutes: Number(f.interval.value), window: win, holdManual: Boolean(win) && f.hold.checked, keepRunning: f.keep.checked, openAtLogin: Boolean(s.openAtLogin), ...(want ? { config: config(veh) } : mine ? { removeSource: src } : {}) };
        } catch (err) { toast(err.message, 'bad'); return; }
        await act(f.querySelector('[type=submit]'), async () => {
          auto = must(await call('setAuto', body));
          toast(want ? 'Automatic conversion saved.' : 'Automatic conversion is off for this vehicle.');
          drawAuto();
        });
      };
      $('#e-autonow').onclick = (e) => act(e.currentTarget, async () => { auto = must(await call('checkAutoNow')); toast('Checking for new clips…'); drawAuto(); });
    }

    // ---------- dyno run (benchmark) ----------
    function drawBench() {
      const b = bench;
      const p = b.progress;
      const runs = b.result?.codecs || (b.result ? [b.result] : []);
      $('#e-bench').innerHTML = `${panelHead(`${ico('tacho')}Dyno run (benchmark)`, b.running ? pill('running', 'cyan') : '')}
        <p class="small dim">Encodes copies of a few sample clips at 1, 2, 4… at once and suggests the fastest setting. Originals are only read.</p>
        <div class="row" style="margin-top:10px">${segs('bcodec', [['h265', 'H.265'], ['av1', 'AV1'], ['both', 'Both']], local.get('bcodec', 'h265'), 'Benchmark codec')}
          ${b.running ? `<button class="btn danger" type="button" id="e-bcancel">${ico('stop')}Stop</button>` : `<button class="btn" type="button" id="e-brun"${snap && ACTIVE.has(snap.state) ? ' disabled' : ''}>${ico('tacho')}Run the dyno</button>`}</div>
        ${b.running ? `<div class="stack" style="margin-top:10px">${bar(p?.total ? ((p.index || 0) / p.total) * 100 : 4)}<span class="small mono">${h(p ? `${p.codec ? `${String(p.codec).toUpperCase()} · ` : ''}${p.step}${p.level ? ` · ${p.level} at once` : ''}${p.total ? ` · ${p.index}/${p.total}` : ''}` : 'starting…')}</span></div>` : ''}
        ${runs.map((r) => `<div class="bench"><b>${h(String(r.codec || '').toUpperCase())}</b> <span class="small faint">${h(r.error ? `error: ${r.error}` : `${r.encoder?.codec || ''}${r.encoder?.hardware ? ' (hardware)' : ''} · ${r.clips} sample clips`)}</span>
          ${(r.results || []).length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>At once</th><th class="r">Clips/min</th><th class="r">fps</th><th class="r">Saved</th><th class="r">Time</th><th></th></tr></thead><tbody>${r.results.map((x) => `<tr class="${r.best?.level === x.level ? 'hi' : ''}"><td class="num">${h(x.level)}</td><td class="r num">${fixed(x.filesPerMinute, 1)}</td><td class="r num">${fixed(x.fps, 0)}</td><td class="r num">${ok(x.savedPercent) ? pc(x.savedPercent, 1) : '—'}</td><td class="r num">${h(x.seconds)} s</td><td>${x.ok ? (r.best?.level === x.level ? pill('best', 'grn') : '') : pill(`${x.failed} failed`, 'red')}</td></tr>`).join('')}</tbody></table></div>` : ''}
          ${r.best ? `<button class="btn sm" type="button" data-use="${h(r.best.level)}">Use ${h(r.best.level)} at once</button>` : ''}</div>`).join('')}`;
      onSegs($('#e-bench'), 'bcodec', (x) => local.set('bcodec', x));
      $('#e-brun')?.addEventListener('click', runBench);
      $('#e-bcancel')?.addEventListener('click', async () => { await call('cancelBenchmark'); toast('Stopping the dyno run…'); });
      el.querySelectorAll('[data-use]').forEach((x) => { x.onclick = () => { form.concurrency = Number(x.dataset.use); save(); drawForm(); toast(`Set to ${form.concurrency} at once.`); }; });
    }
    async function runBench() {
      const veh = formCar();
      const c = local.get('bcodec', 'h265');
      read();
      bench = { running: true, progress: null, result: null };
      drawBench();
      const r = await call('runBenchmark', { codecs: c === 'both' ? ['h265', 'av1'] : [c], sourceRoot: carRoot(veh), profileId: form.profileId, verifyMode: form.verifyMode, ...(form.profileId === 'custom' ? { bitrateKbps: Math.round(form.bitrateKbps) } : {}), ...(form.profileId === 'quality' ? { qualityLevel: form.qualityLevel } : {}) });
      bench.running = false;
      if (r.ok) { bench.result = r.value; local.set('bench', r.value); toast('Dyno run finished.'); } else toast(r.error?.code === 'CANCELLED' ? 'Dyno run stopped.' : why(r.error), r.error?.code === 'CANCELLED' ? 'ok' : 'bad');
      if (alive) drawBench();
    }

    // ---------- converter log ----------
    async function loadLog() {
      try {
        const all = $('#e-logall').checked;
        const out = await api('/api/logs?level=all&limit=400', { timeout: 15000 });
        const q = $('#e-logq').value.toLowerCase();
        const lines = (out.lines || []).filter((l) => (all || /converter|nodes|stats/.test(l.scope)) && (!q || `${l.scope} ${l.message}`.toLowerCase().includes(q)));
        $('#e-logn').textContent = `${lines.length} lines`;
        $('#e-log').innerHTML = lines.length ? lines.slice(0, 200).map((l) => `<div class="ll ${h(l.level)}"><span class="ll-t num">${h(stampFull(l.at))}</span><span class="ll-l">${h(l.level)}</span><span class="ll-s">${h(l.scope)}</span><span class="ll-m">${h(l.message)}</span></div>`).join('') : '<p class="small dim ll-empty">Nothing from the converter yet.</p>';
      } catch (err) { $('#e-log').textContent = err.message; }
    }
    $('#e-logref').onclick = loadLog;
    $('#e-logall').onchange = loadLog;
    $('#e-logq').addEventListener('input', debounce(loadLog, 200));

    // ---------- live ----------
    function take(s, force = false) {
      if (!s || !s.id) return;
      if (snap && s.id === snap.id && !force && Number.isSafeInteger(s.revision) && s.revision < rev) return;
      if (snap && s.id === snap.id && !s.items && snap.items) s = { ...snap, ...s, items: snap.items };
      snap = s;
      rev = s.revision ?? rev;
    }
    let queued = false;
    function drawAll() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (!alive) return;
        drawHead();
        drawDyno();
        drawCyl();
        drawTimes();
        drawItems();
        const fs = $('#e-form fieldset');
        const want = Boolean(snap && ACTIVE.has(snap.state)) || !app.vehicles.length;
        if (!fs || fs.disabled !== want) drawForm();
        if (!bench.running && $('#e-brun')) $('#e-brun').disabled = Boolean(snap && ACTIVE.has(snap.state));
      });
    }
    async function refresh() {
      const r = await call('getCurrent');
      if (r.ok) { if (r.value) take(r.value, true); else snap = null; } else if (r.error?.code === 'CONVERTER_STARTING') $('#e-sub').textContent = 'The converter is starting…';
      drawAll();
    }
    function connect() {
      es = new EventSource(`/api/converter/events?client=${encodeURIComponent(me)}`);
      let first = true;
      es.addEventListener('hello', async () => {
        await call('subscribeProgress');
        if (!first) refresh();
        first = false;
      });
      es.addEventListener('converter:progress', (e) => {
        let p;
        try { p = JSON.parse(e.data); } catch { return; }
        const s = p.snapshot;
        if (!s) return;
        if (s.progress && !s.items) {
          if (!snap || snap.id !== p.jobId) { refresh(); return; }
          live = s.progress;
        } else {
          if (snap && snap.id !== s.id) rev = -1;
          take(s);
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
          const s = await api('/api/stats', { timeout: 10000 });
          enc = s.encoder;
          price = s.price;
          // a safety net for a missed live event: re-read the job now and then
          if (snap && ACTIVE.has(snap.state) && ++ticks % 3 === 0) await refresh();
          drawAll();
        } catch { /* keep the last */ }
      }
      statsTimer = setTimeout(pollStats, 2000);
    }
    const offRefresh = bus.on('converter-refresh', refresh);

    // ---------- start ----------
    const [d, c, a, st] = await Promise.all([call('devices'), call('getCapabilities'), call('getAuto'), api('/api/stats').catch(() => ({}))]);
    devices = d.ok ? d.value?.devices || [] : [];
    caps = c.ok ? c.value || {} : {};
    auto = a.ok ? a.value : null;
    const dataVol = (st?.filesystems || []).find((x) => !x.vehicle)?.path;
    outRoots = dataVol ? [`${dataVol}/converted`] : [];
    enc = st?.encoder || null;
    if (params.get('vehicle')) form.vehicle = params.get('vehicle');
    else if (params.get('new') && v0) form.vehicle = v0.id;
    drawForm();
    drawAuto();
    drawBench();
    await refresh();
    connect();
    pollStats();
    loadLog();
    logTimer = setInterval(() => { if (document.visibilityState === 'visible' && snap && ACTIVE.has(snap.state)) loadLog(); }, 5000);
    if (params.get('new')) $('#e-form')?.scrollIntoView({ block: 'start' });

    return {
      unmount() {
        alive = false;
        offRefresh();
        clearTimeout(statsTimer);
        clearInterval(logTimer);
        es?.close();
        call('unsubscribeProgress');
      },
      onTopics(t) { if (t.includes('vehicles')) drawForm(); },
      onCar() { form.vehicle = car()?.id; save(); drawForm(); drawAuto(); },
      keys: [['+ / −', 'More / fewer conversions at once (running job)'], ['Space', 'Pause / resume the running job']],
      onKey(e) {
        if (e.key === '+' || e.key === '=') { bump(1); return true; }
        if (e.key === '-' || e.key === '_') { bump(-1); return true; }
        if (e.key === ' ' && snap && ACTIVE.has(snap.state)) { jobAct(RUNNING.has(snap.state) ? 'pause' : 'resume'); return true; }
        return false;
      }
    };
  }
};
