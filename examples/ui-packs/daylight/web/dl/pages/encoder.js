// Encoder: make footage smaller (H.265 or AV1) without losing any of it.
// What is converting now, a guided "save space" flow, how many clips at
// once (per GPU / node), automatic conversion, and a speed test.

import { api, esc, enc, icon, bytes, plural, pct, duration, meter, chip, emptyState, details, kv, confirmDialog, modal, toast, fail, busy, invoke, store, ago, fin } from '../core.js';
import { state, vehicle, setVehicle, vehiclePicker, vehicleById } from '../state.js';
import { go } from '../app.js';
import { splitDevices, deviceLabel, savedLane, jobLanes, groupMemory, groupBodyId, wireGroups } from '../nodelanes.js';
import { follow, counts, workingMs, Pace, ACTIVE, PAUSED, STATE_WORDS, CODEC_WORD, PROFILE_WORD, GROUP_WORD, GROUPS, describe, applySnapshot, onBenchmark, streamReady } from '../convert.js';

const footageOf = (v) => v.studioRoot || v.root;
const vehicleForRoot = (root) => state.vehicles.find((v) => footageOf(v) === root || v.root === root || (root && root.startsWith(`${footageOf(v)}/`))) || null;
const CONC_MAX = 64;
const FAIL_WORDS = {
  'profile-size': 'Didn’t shrink by the chosen amount (try Constant quality)',
  'not-smaller': 'Wouldn’t get any smaller',
  'telemetry-mismatch': 'Driving data didn’t match',
  'telemetry-invalid': 'Driving data was damaged',
  'duration-mismatch': 'Length didn’t match',
  'frame-count-mismatch': 'Frames didn’t match',
  'dimension-mismatch': 'Picture size didn’t match',
  'decode-failed': 'The original couldn’t be read',
  'probe-failed': 'The original couldn’t be read',
  'picture-mismatch': 'The picture check failed',
  'encode-failed': 'The encoder stopped'
};
const QUALITY_WORD = { high: 'Best picture', balanced: 'Balanced', small: 'Smallest files' };

// shared between visits: the converter's abilities, devices and folders
const info = { caps: null, devices: null, context: null };
async function loadInfo() {
  const [caps, devices, context] = await Promise.all([
    info.caps ? info.caps : invoke('getCapabilities').catch(() => null),
    invoke('devices').catch(() => null),
    info.context ? info.context : api('/api/studio/context').catch(() => null)
  ]);
  info.caps = caps;
  info.context = context;
  // several GPUs, or a helper server (node: each of its graphics cards and
  // its processor is a device of its own, grouped under the helper)
  const list = Array.isArray(devices?.devices) ? devices.devices : [];
  const gpus = list.filter((d) => d.kind !== 'cpu' && d.id !== 'cpu');
  info.devices = gpus.length >= 2 || gpus.some((d) => d.kind === 'node')
    ? { lanes: [...gpus, list.find((d) => d.id === 'cpu') || { id: 'cpu', kind: 'cpu', name: 'CPU (software encoder)' }], defaults: devices.defaultDevices || {}, defaultDevice: devices.defaultDevice }
    : null;
}
const canReplace = () => info.caps?.replacement === 'available';

// ---------- how many at once ----------
const defaultConcurrency = () => Math.max(1, Math.min(CONC_MAX, Number(store.get('concurrency', 3)) || 3));
function laneCounts() {
  const saved = store.get('lanes', null);
  const out = new Map();
  // (a helper's number saved before it listed its devices is its main device's now)
  for (const d of info.devices?.lanes || []) out.set(d.id, savedLane(saved, d) ?? 0);
  if (![...out.values()].some((n) => n > 0) && info.devices) {
    const first = info.devices.defaultDevice || info.devices.lanes.find((d) => d.kind !== 'cpu')?.id || 'cpu';
    out.set(first, defaultConcurrency());
  }
  return out;
}
const saveLanes = (map) => store.set('lanes', Object.fromEntries(map));
function parallelConfig() {
  if (!info.devices) return { concurrency: defaultConcurrency() };
  const lanes = [...laneCounts()].filter(([, n]) => n > 0).map(([device, concurrency]) => ({ device, concurrency }));
  const total = lanes.reduce((n, l) => n + l.concurrency, 0);
  if (!total) return { concurrency: defaultConcurrency() };
  return { concurrency: total, lanes };
}
const deviceName = (d) => (d.kind === 'cpu' || d.id === 'cpu' ? 'Processor (CPU)' : d.kind === 'node' ? `Helper server: ${d.name || d.id}` : d.name || d.id);
// a helper's own device, under its helper's name
const helperDeviceName = (d) => (d.deviceId === 'cpu' ? 'Processor (CPU)' : deviceLabel(d));
// which helpers are open under "Clips at once", per browser
const groupMem = groupMemory(store, 'nodeGroups');

// ---------- the guided flow's choices ----------
function lastChoices() {
  const c = store.get('choices', {});
  return {
    mode: c.mode === 'separate' ? 'separate' : 'replace',
    vehicleId: c.vehicleId,
    groups: Array.isArray(c.groups) && c.groups.length ? c.groups.filter((g) => GROUPS.includes(g)) : [...GROUPS],
    codec: c.codec === 'av1' ? 'av1' : 'h265',
    profile: ['conservative', 'balanced', 'aggressive', 'quality'].includes(c.profile) ? c.profile : 'balanced',
    quality: ['high', 'balanced', 'small'].includes(c.quality) ? c.quality : 'balanced',
    verify: c.verify === 'full' ? 'full' : 'quick',
    destination: typeof c.destination === 'string' ? c.destination : ''
  };
}
function defaultDestination(v) {
  const root = info.context?.outputRoots?.[0];
  return root ? `${root}/${String(v?.name || v?.id || 'vehicle').replace(/[^\w.-]+/g, '-')}` : '';
}
function configFrom(ch, v) {
  return {
    sourceRoot: footageOf(v),
    destinationRoot: ch.mode === 'replace' ? null : (ch.destination || defaultDestination(v)),
    codec: ch.codec,
    profileId: ch.profile,
    ...(ch.profile === 'quality' ? { qualityLevel: ch.quality } : {}),
    networkMode: 'auto',
    outputMode: ch.mode,
    includedGroups: GROUPS.filter((g) => ch.groups.includes(g)),
    groupOrder: [...GROUPS],
    replacementConfirmed: ch.mode === 'replace',
    ...parallelConfig(),
    verifyMode: ch.verify
  };
}

export async function render(ctx) {
  const { view, params, query } = ctx;
  if (query.get('vehicle') && vehicleById(query.get('vehicle'))) setVehicle(query.get('vehicle'));
  view.innerHTML = '<div class="page"><div class="loading"><span class="spin"></span><span>Waking up the converter…</span></div></div>';
  await loadInfo();
  if (!ctx.alive()) return;
  if (params[0] === 'new') return wizard(ctx);
  if (params[0] === 'speed-test') return speedTest(ctx);
  return overview(ctx);
}

// ---------- the overview ----------
async function overview(ctx) {
  const { view } = ctx;
  const pace = new Pace();
  let snap;
  let nodeWaiting = null;
  let auto = null;
  let autoOpen = false;
  let drawn = false;

  const jobCard = () => {
    if (snap === undefined) return '<div class="card"><div class="loading"><span class="spin"></span><span>Checking…</span></div></div>';
    const active = snap && ACTIVE.has(snap.state);
    // a stopped job can't be put away on the server: this browser hides it
    const finished = snap && !active && !snap.summaryDismissed && !store.get('hiddenJobs', []).includes(snap.id);
    if (!active && !finished) {
      return `<div class="card enc-hero"><div class="row" style="gap:16px"><div class="status-icon" style="width:56px;height:56px;border-radius:18px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)">${icon('sparkle')}</div>
        <div class="grow" style="flex:1;min-width:200px"><h2>Nothing is converting</h2><p class="muted">Converting keeps every clip and its driving data, checks each result, and usually frees a lot of room.</p></div></div>
        <div class="row"><a class="btn btn-primary" href="#/encoder/new">${icon('sparkle')} Save space on my footage</a><a class="btn" href="#/encoder/speed-test">${icon('speed')} Test this server’s speed</a></div></div>`;
    }
    const c = counts(snap);
    const p = pace.read(snap);
    const v = vehicleForRoot(snap.config?.sourceRoot);
    const frac = c.total ? c.done / c.total : 0;
    const paused = PAUSED.has(snap.state);
    const scanning = active && snap.discoveryComplete === false;
    const saved = Number(snap.counters?.savedBytes) || 0;
    const waiting = nodeWaiting && nodeWaiting.jobId === snap.id ? nodeWaiting.count : 0;
    const encodingNow = nodeWaiting && nodeWaiting.jobId === snap.id && Number.isSafeInteger(nodeWaiting.encoding) ? Math.min(nodeWaiting.encoding, c.inFlight) : Math.max(0, c.inFlight - waiting);
    const title = active ? STATE_WORDS[snap.state] || 'Converting' : snap.state === 'completed' ? (c.failed ? `Finished, but ${plural(c.failed, 'clip')} couldn’t be converted` : 'All done') : STATE_WORDS[snap.state] || 'Stopped';
    const summary = snap.summary;
    return `<div class="card enc-hero" id="job">
      <div class="row-between"><div><p class="eyebrow">${esc(v?.name || 'Footage')} · ${esc(CODEC_WORD[snap.config?.codec] || '')} · ${snap.config?.outputMode === 'replace' ? 'replacing originals' : 'keeping originals'}</p>
        <h2 aria-live="polite">${esc(title)}</h2></div>
        ${active ? (paused ? chip('Paused', 'warn') : chip('Working', 'teal', 'bolt')) : snap.state === 'completed' ? (c.failed ? chip('Finished with problems', 'warn') : chip('Finished', 'good', 'check')) : chip(snap.state === 'cancelled' ? 'Stopped' : 'Problem', snap.state === 'cancelled' ? 'grey' : 'bad')}</div>
      <div><div class="big-progress"><b>${pct(frac * 100)}</b><span class="muted">${c.done.toLocaleString()} of ${c.total.toLocaleString()}${scanning ? '+' : ''} clips</span></div>
        <div style="margin-top:12px">${meter(frac, active && !paused ? 'big live' : paused ? 'big warn' : 'big')}</div>
        ${scanning ? '<p class="muted small" style="margin-top:8px">Still looking for clips, so the total may grow.</p>' : ''}</div>
      <div class="stat-row">
        <div class="stat"><span>Speed</span><b>${p.perMinute ? `${p.perMinute.toFixed(p.perMinute < 10 ? 1 : 0)}/min` : '—'}</b></div>
        <div class="stat"><span>Time left</span><b>${p.leftMs ? `${scanning ? '≥ ' : ''}${duration(p.leftMs)}` : active ? '—' : 'none'}</b></div>
        <div class="stat"><span>Working for</span><b>${duration(workingMs(snap))}</b></div>
        <div class="stat"><span>Space saved</span><b>${bytes(summary?.savedBytes ?? saved)}</b></div>
        ${active ? `<div class="stat"><span>Converting now</span><b>${encodingNow}</b></div>` : ''}
        ${waiting ? `<div class="stat"><span>Waiting on helpers</span><b>${waiting}</b></div>` : ''}
        ${c.failed ? `<div class="stat"><span>Couldn’t convert</span><b style="color:var(--bad)">${c.failed}</b></div>` : ''}
        ${c.skipped ? `<div class="stat"><span>Skipped (already converted)</span><b>${c.skipped}</b></div>` : ''}
      </div>
      ${snap.state === 'paused_network' ? `<div class="note note-warn">${icon('network')}<span>The footage share dropped off the network. Converting carries on by itself once it’s back.</span></div>` : ''}
      ${snap.cleanupPendingCount ? `<div class="note note-warn">${icon('info')}<span>${plural(snap.cleanupPendingCount, 'file')} still need a cleanup step. They are safe; the space comes back once it’s done.</span></div>` : ''}
      ${active ? liveParallel(snap) : ''}
      <div class="row">
        ${active ? (paused ? `<button class="btn btn-primary" type="button" data-cmd="resume">${icon('play')} Resume</button>` : `<button class="btn btn-primary" type="button" data-cmd="pause">${icon('pause')} Pause</button>`)
          + `<button class="btn" type="button" data-cmd="cancel">${icon('close')} Stop</button>`
          : `${c.failed ? `<button class="btn" type="button" data-cmd="retryFailed">${icon('refresh')} Try the failed clips again</button>` : ''}<button class="btn btn-primary" type="button" data-cmd="dismissSummary">${icon('check')} Done</button><a class="btn" href="#/encoder/new">Convert more</a>`}
      </div>
      ${details('More details', `${kv([
        ['Footage', `<span class="mono">${esc(snap.config?.sourceRoot || '')}</span>`],
        ['Copies go to', snap.config?.outputMode === 'replace' ? 'Replace the originals after checking' : `<span class="mono">${esc(snap.config?.destinationRoot || '')}</span>`],
        ['Format', esc(`${CODEC_WORD[snap.config?.codec] || ''} · ${PROFILE_WORD[snap.config?.profileId] || snap.config?.profileId || ''}${snap.config?.qualityLevel ? ` (${QUALITY_WORD[snap.config.qualityLevel]})` : ''}`)],
        ['Checking', snap.config?.verifyMode === 'full' ? 'Thorough (decodes every frame)' : 'Quick (streams, length, frames, driving data)'],
        ['Kinds', esc((snap.config?.includedGroups || []).map((g) => GROUP_WORD[g] || g).join(', '))],
        ['Original size', summary ? bytes(summary.sourceVideoBytes) : bytes(snap.counters?.sourceVideoBytes)],
        ['New size', summary ? bytes(summary.outputVideoBytes) : bytes(snap.counters?.outputVideoBytes)],
        ['Live encoder', snap.progress?.fps ? `${snap.progress.fps} frames/s` : ''],
        ['Job', `<span class="mono">${esc(snap.id)}</span>`]
      ])}${c.failedItems.length ? `<h4 style="margin:14px 0 6px">Clips that couldn’t be converted</h4><ul class="files">${c.failedItems.map((i) => `<li><span>${esc(i.relativePath || i.id)}</span><span class="muted">${esc(FAIL_WORDS[i.failure?.code] || String(i.failure?.code || 'failed').replace(/[-_]/g, ' '))}</span></li>`).join('')}</ul><p class="muted small">The originals of these clips were kept exactly as they were.</p>` : ''}`)}
    </div>`;
  };

  const liveParallel = (s) => {
    if (info.devices) {
      const running = jobLanes(info.devices.lanes, s.config?.lanes);
      return `<div><h3 style="margin-bottom:4px">Clips at once</h3><p class="muted small">Changes apply right away. Clips already converting finish first.</p>
        ${laneRows((d) => running.get(d.id) ?? 0, 'live')}</div>`;
    }
    const n = Number(s.config?.concurrency) || 1;
    return `<div class="row-between"><div><h3>Clips at once</h3><p class="muted small">More is faster if the server has room. Changes apply right away.</p></div>
      ${stepper('live-conc', n)}</div>`;
  };
  const stepper = (id, n, label = 'clips at once') => `<div class="stepper" role="group" aria-label="${esc(label)}">
    <button type="button" data-step="${id}" data-d="-1" aria-label="Fewer"${n <= 1 ? ' disabled' : ''}>${icon('minus')}</button>
    <output id="${id}" aria-live="polite">${n}</output>
    <button type="button" data-step="${id}" data-d="1" aria-label="More"${n >= CONC_MAX ? ' disabled' : ''}>${icon('plus')}</button></div>`;
  // this server's devices as rows, then each helper as a group that opens to its graphics cards and processor
  const laneRows = (countOf, scope) => {
    const { own, nodes } = splitDevices(info.devices.lanes);
    return own.map((d) => laneRow(d, countOf(d), scope)).join('') + nodes.map((g) => {
      const total = g.devices.reduce((n, d) => n + countOf(d), 0);
      const id = groupBodyId(scope, g.key);
      return `<div class="lane-group${total ? '' : ' is-off'}${g.online ? '' : ' offline'}" data-group-box>
        <button type="button" class="lane-group-head" data-node-group="${scope}|${esc(g.key)}" aria-expanded="false" aria-controls="${id}">
          <span class="grow"><b>Helper server: ${esc(g.name)}</b><br><span class="muted small">${g.online ? `${plural(g.devices.length, 'device')} · tap to choose which ones convert` : 'Offline: check it under Helper servers'}</span></span>
          <span class="lane-group-total" data-group-total>${total ? `${total} at once` : 'Off'}</span><span class="lane-group-chev" aria-hidden="true">${icon('next')}</span></button>
        <div class="lane-group-body" id="${id}" role="group" aria-label="${esc(g.name)}: graphics cards and processor" hidden>${g.devices.map((d) => laneRow(d, countOf(d), scope, helperDeviceName(d))).join('')}</div></div>`;
    }).join('');
  };
  const laneRow = (d, n, scope, shown = deviceName(d)) => `<div class="lane"><div class="grow"><b>${esc(shown)}</b><br><span class="muted small">${d.kind === 'node' && d.online === false ? 'Offline: check it under Helper servers' : d.kind === 'cpu' || d.id === 'cpu' ? 'Slower, but always there' : d.deviceId === 'cpu' ? 'Its processor: slower, but always there' : esc(Object.entries(d.encoders || {}).filter(([, e]) => e).map(([c, e]) => `${CODEC_WORD[c] || c}: ${e}`).join(' · '))}</span></div>
    <div class="stepper" role="group" aria-label="${esc(d.kind === 'node' && d.nodeName ? `${d.nodeName}, ${shown}` : shown)}: clips at once">
      <button type="button" data-lane="${esc(d.id)}" data-scope="${scope}" data-d="-1" aria-label="Fewer"${n <= 0 ? ' disabled' : ''}>${icon('minus')}</button>
      <output>${n === 0 ? 'Off' : n}</output>
      <button type="button" data-lane="${esc(d.id)}" data-scope="${scope}" data-d="1" aria-label="More">${icon('plus')}</button></div></div>`;

  const nextParallel = () => {
    if (info.devices) {
      const counts2 = laneCounts();
      return `<div class="card"><h2>Clips at once</h2><p class="muted" style="margin:6px 0 10px">How many clips each device converts at the same time, for the next conversion. A speed test finds the best number.</p>
        ${laneRows((d) => counts2.get(d.id) || 0, 'next')}
        <div class="actions"><a class="btn btn-soft btn-sm" href="#/encoder/speed-test">${icon('speed')} Find the best numbers</a></div></div>`;
    }
    return `<div class="card"><div class="row-between"><div><h2>Clips at once</h2><p class="muted" style="margin-top:6px">For the next conversion. More is faster when the server has room to spare.</p></div>${stepper('next-conc', defaultConcurrency())}</div>
      <div class="actions"><a class="btn btn-soft btn-sm" href="#/encoder/speed-test">${icon('speed')} Find the best number</a></div></div>`;
  };

  const autoCard = () => {
    if (!auto) return `<div class="card"><h2>Automatic conversion</h2><p class="muted" style="margin-top:6px">${auto === false ? 'Not available on this server.' : 'Loading…'}</p></div>`;
    const v = vehicle();
    const s = auto.settings;
    const st = auto.status || {};
    const mine = v ? s.configs.find((c) => c.sourceRoot === footageOf(v) || vehicleForRoot(c.sourceRoot)?.id === v.id) : null;
    const on = Boolean(s.enabled && mine);
    const others = s.configs.filter((c) => c !== mine).map((c) => vehicleForRoot(c.sourceRoot)?.name || c.sourceRoot);
    const ch = mine ? { codec: mine.codec, profile: mine.profileId, quality: mine.qualityLevel || 'balanced', groups: mine.includedGroups, mode: mine.outputMode, verify: mine.verifyMode || 'quick' } : { ...lastChoices(), mode: canReplace() ? lastChoices().mode : 'separate' };
    const win = s.window?.follow === 'off-peak' ? 'offpeak' : s.window ? 'hours' : 'any';
    const hours = Array.from({ length: 24 }, (_, h) => h);
    const hourName = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
    const running = st.active && typeof st.active === 'object' ? Object.keys(st.active) : [];
    const statusLine = !s.enabled ? 'Off'
      : st.checking ? 'Checking for new clips…'
        : running.length ? `Converting new clips of ${running.map((r) => vehicleForRoot(r)?.name || 'a vehicle').join(', ')}`
          : st.nextCheckAt ? `Next check ${new Date(st.nextCheckAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${st.lastCheckAt ? ` · last ${ago(st.lastCheckAt)}${Number.isSafeInteger(st.lastNewFiles) ? `, ${plural(st.lastNewFiles, 'new clip')}` : ''}` : ''}`
            : 'Checks shortly';
    return `<div class="card" id="auto"><div class="row-between"><div><h2>Automatic conversion</h2><p class="muted" style="margin-top:6px">New footage is converted by itself, a little at a time.</p></div>
        <label class="switch"><input type="checkbox" id="auto-on"${on ? ' checked' : ''}${v ? '' : ' disabled'}><span>${v ? `For ${esc(v.name)}` : 'Add a vehicle first'}</span></label></div>
      <p class="small" style="margin-top:12px">${chip(s.enabled ? 'On' : 'Off', s.enabled ? 'good' : 'grey')} <span class="muted">${esc(statusLine)}</span></p>
      ${others.length ? `<p class="muted small" style="margin-top:6px">Also converting automatically: ${esc(others.join(', '))}.</p>` : ''}
      ${st.error ? `<div class="note note-warn" style="margin-top:10px">${icon('alert')}<span>The last check didn’t work: ${esc(describe({ code: st.error }))}</span></div>` : ''}
      <details class="more"${autoOpen ? ' open' : ''} id="auto-more"><summary>Options</summary><div class="more-body"><form id="auto-form" class="form-grid">
        <label class="field"><span>Check for new clips</span><select class="input" name="interval">${[[15, 'Every 15 minutes'], [30, 'Every 30 minutes'], [60, 'Every hour'], [180, 'Every 3 hours'], [360, 'Every 6 hours'], [720, 'Twice a day'], [1440, 'Once a day']].map(([m, t]) => `<option value="${m}"${s.intervalMinutes === m ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="field"><span>When</span><select class="input" name="window"><option value="any"${win === 'any' ? ' selected' : ''}>Any time</option><option value="hours"${win === 'hours' ? ' selected' : ''}>Only between certain hours</option><option value="offpeak"${win === 'offpeak' ? ' selected' : ''}>Only when electricity is cheapest (off-peak)</option></select></label>
        <label class="field" data-hours${win === 'hours' ? '' : ' hidden'}><span>From</span><select class="input" name="start">${hours.map((h) => `<option value="${h}"${(s.window?.startHour ?? 1) === h ? ' selected' : ''}>${hourName(h)}</option>`).join('')}</select></label>
        <label class="field" data-hours${win === 'hours' ? '' : ' hidden'}><span>Until</span><select class="input" name="end">${hours.map((h) => `<option value="${h}"${(s.window?.endHour ?? 6) === h ? ' selected' : ''}>${hourName(h)}</option>`).join('')}</select></label>
        <label class="check full" data-window${win === 'any' ? ' hidden' : ''}><input type="checkbox" name="hold"${s.holdManual ? ' checked' : ''}> <span>Pause conversions I start myself outside these times too</span></label>
        <label class="field"><span>Format</span><select class="input" name="codec"><option value="h265"${ch.codec === 'h265' ? ' selected' : ''}>H.265 (plays everywhere)</option><option value="av1"${ch.codec === 'av1' ? ' selected' : ''}>AV1 (smallest, slower)</option></select></label>
        <label class="field"><span>How much smaller</span><select class="input" name="profile">${['conservative', 'balanced', 'aggressive', 'quality'].map((p) => `<option value="${p}"${ch.profile === p ? ' selected' : ''}>${esc(PROFILE_WORD[p])}</option>`).join('')}</select></label>
        <label class="field"><span>Originals</span><select class="input" name="mode"><option value="replace"${ch.mode === 'replace' ? ' selected' : ''}${canReplace() ? '' : ' disabled'}>Replace them once each copy checks out</option><option value="separate"${ch.mode === 'separate' ? ' selected' : ''}>Keep them; put copies in the converted folder</option></select></label>
        <fieldset class="full" style="border:0;padding:0;margin:0"><legend class="field" style="margin-bottom:6px">Which footage</legend><div class="row">${GROUPS.map((g) => `<label class="check"><input type="checkbox" name="group" value="${g}"${ch.groups.includes(g) ? ' checked' : ''}> ${GROUP_WORD[g]}</label>`).join('')}</div></fieldset>
        <div class="full row"><button class="btn btn-primary" type="submit">Save options</button><button class="btn" type="button" id="auto-check"${s.enabled ? '' : ' disabled'}>${icon('refresh')} Check now</button></div>
      </form></div></details></div>`;
  };

  const draw = () => {
    if (!ctx.alive()) return;
    const typing = view.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox]), select, textarea');
    if (drawn && typing) {
      // only the job card while the owner picks something
      const job = view.querySelector('#job-slot');
      if (job) { job.innerHTML = jobCard(); wireJob(); }
      return;
    }
    const focusId = document.activeElement?.id;
    view.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>Encoder</h1><p class="lede">Make your footage smaller without losing any of it. Every converted clip is checked before an original is touched.</p></div>
        <div class="head-actions">${vehiclePicker()}</div></div>
      ${state.vehicles.length ? '' : `<div style="margin-bottom:18px">${emptyState({ art: 'car', title: 'Add a vehicle first', text: 'The Encoder converts a vehicle’s footage. Add your car and come back.', action: '<a class="btn btn-primary" href="#/settings/add-vehicle">Add my vehicle</a>' })}</div>`}
      <div id="job-slot">${jobCard()}</div>
      <div class="grid grid-2 section">${snap && ACTIVE.has(snap.state) ? '' : nextParallel()}${autoCard()}</div>
    </div>`;
    drawn = true;
    wire();
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  };

  const command = async (cmd, btn) => {
    if (!snap?.id) return;
    if (cmd === 'cancel' && !(await confirmDialog({ title: 'Stop converting?', body: '<p>Clips finished so far stay converted. Clips in progress are left exactly as they were. You can start again any time.</p>', ok: 'Stop', danger: true }))) return;
    if (cmd === 'dismissSummary' && snap.state !== 'completed') {
      store.set('hiddenJobs', [...store.get('hiddenJobs', []).slice(-20), snap.id]);
      draw();
      return;
    }
    await busy(btn, async () => {
      try {
        const next = await invoke(cmd, { jobId: snap.id });
        if (next) applySnapshot(next);
        if (cmd === 'pause') toast('Pausing at a safe point…');
        if (cmd === 'dismissSummary') { snap = null; draw(); }
      } catch (err) {
        if (cmd === 'cancel' && err.code && err.code !== 'NETWORK_ERROR') {
          if (await confirmDialog({ title: 'This job can’t be stopped normally', body: `<p>${esc(describe(err))}</p><p>Set it aside instead? Its finished clips stay converted.</p>`, ok: 'Set it aside' })) {
            try { applySnapshot(await invoke('discard', { jobId: snap.id })); } catch (e2) { toast(describe(e2), { kind: 'bad' }); }
          }
        } else toast(describe(err), { kind: 'bad' });
      }
    });
  };
  // live changes go one after another
  let chain = Promise.resolve();
  const live = (fn) => { chain = chain.then(fn).catch((err) => toast(describe(err), { kind: 'bad' })); };

  const wireJob = () => {
    view.querySelectorAll('[data-cmd]').forEach((b) => { b.onclick = () => command(b.dataset.cmd, b); });
    wireGroups(view, groupMem);
    view.querySelectorAll('[data-step="live-conc"]').forEach((b) => {
      b.onclick = () => {
        const n = Math.max(1, Math.min(CONC_MAX, (Number(snap?.config?.concurrency) || 1) + Number(b.dataset.d)));
        const id = snap.id;
        live(async () => { applySnapshot(await invoke('setConcurrency', { jobId: id, concurrency: n })); toast(`Now ${n} at once. Clips already converting finish first.`); });
      };
    });
    view.querySelectorAll('[data-lane][data-scope="live"]').forEach((b) => {
      b.onclick = () => {
        const cur = jobLanes(info.devices?.lanes, snap?.config?.lanes);
        if (!cur.size && snap?.config?.concurrency) {
          const def = info.devices?.defaults?.[snap.config.codec] || info.devices?.defaultDevice;
          if (def) cur.set(def, Number(snap.config.concurrency));
        }
        const n = Math.max(0, Math.min(CONC_MAX, (cur.get(b.dataset.lane) || 0) + Number(b.dataset.d)));
        cur.set(b.dataset.lane, n);
        const lanes = [...cur].filter(([, x]) => x > 0).map(([device, concurrency]) => ({ device, concurrency }));
        if (!lanes.length) return toast('At least one device has to keep converting.');
        const id = snap.id;
        live(async () => { applySnapshot(await invoke('setLanes', { jobId: id, lanes })); toast('Changed. Clips already converting finish first.'); });
        return undefined;
      };
    });
  };
  const wire = () => {
    wireJob();
    view.querySelector('#vehicle-pick')?.addEventListener('change', (e) => { setVehicle(e.target.value); draw(); });
    view.querySelectorAll('[data-step="next-conc"]').forEach((b) => {
      b.onclick = () => {
        const n = Math.max(1, Math.min(CONC_MAX, defaultConcurrency() + Number(b.dataset.d)));
        store.set('concurrency', n);
        draw();
        view.querySelector(`[data-step="next-conc"][data-d="${b.dataset.d}"]`)?.focus();
      };
    });
    view.querySelectorAll('[data-lane][data-scope="next"]').forEach((b) => {
      b.onclick = () => {
        const map = laneCounts();
        map.set(b.dataset.lane, Math.max(0, Math.min(CONC_MAX, (map.get(b.dataset.lane) || 0) + Number(b.dataset.d))));
        if (![...map.values()].some((n) => n > 0)) return toast('At least one device has to be on.');
        saveLanes(map);
        draw();
        return undefined;
      };
    });
    const form = view.querySelector('#auto-form');
    if (form) {
      view.querySelector('#auto-more').addEventListener('toggle', (e) => { autoOpen = e.target.open; });
      form.window.onchange = () => {
        form.querySelectorAll('[data-hours]').forEach((x) => { x.hidden = form.window.value !== 'hours'; });
        form.querySelector('[data-window]').hidden = form.window.value === 'any';
      };
      form.onsubmit = (e) => { e.preventDefault(); saveAuto(view.querySelector('#auto-on').checked, e.submitter); };
      view.querySelector('#auto-on').onchange = (e) => saveAuto(e.target.checked, e.target);
      view.querySelector('#auto-check').onclick = (e) => busy(e.currentTarget, async () => {
        try { auto = await invoke('checkAutoNow'); toast('Checking for new clips now.'); draw(); } catch (err) { toast(describe(err), { kind: 'bad' }); }
      });
    }
  };

  async function saveAuto(turnOn, btn) {
    const v = vehicle();
    const form = view.querySelector('#auto-form');
    if (!v || !form || !auto) return;
    const f = new FormData(form);
    const win = f.get('window');
    const start = Number(f.get('start'));
    const end = Number(f.get('end'));
    if (win === 'hours' && start === end) return toast('Pick different start and end hours.', { kind: 'bad' });
    const common = {
      intervalMinutes: Number(f.get('interval')) || 60,
      window: win === 'offpeak' ? { follow: 'off-peak' } : win === 'hours' ? { startHour: start, endHour: end } : null,
      holdManual: win !== 'any' && f.get('hold') === 'on',
      keepRunning: Boolean(auto.settings.keepRunning),
      openAtLogin: Boolean(auto.settings.openAtLogin)
    };
    const groups = f.getAll('group');
    if (!groups.length) return toast('Pick at least one kind of footage.', { kind: 'bad' });
    const ch = { mode: f.get('mode') === 'replace' && canReplace() ? 'replace' : 'separate', codec: f.get('codec'), profile: f.get('profile'), quality: 'balanced', groups, verify: 'quick', destination: '' };
    const mine = auto.settings.configs.find((c) => c.sourceRoot === footageOf(v) || vehicleForRoot(c.sourceRoot)?.id === v.id);
    const others = auto.settings.configs.filter((c) => c !== mine);
    return busy(btn, async () => {
      try {
        if (turnOn) {
          if (ch.mode === 'replace' && !mine && !(await confirmDialog({ title: 'Replace originals automatically?', body: `<p>New clips of ${esc(v.name)} will be converted and each original replaced once its smaller copy has been checked (picture, length, frames and driving data).</p>`, ok: 'Turn it on' }))) {
            draw();
            return;
          }
          auto = await invoke('setAuto', { enabled: true, ...common, config: configFrom(ch, v) });
          toast(`Automatic conversion is on for ${v.name}.`, { kind: 'good' });
        } else if (mine) {
          auto = await invoke('setAuto', { enabled: false, ...common, removeSource: mine.sourceRoot });
          // the other vehicles keep converting
          if (others.length) auto = await invoke('setAuto', { enabled: true, ...common, config: others[0] });
          toast(`Automatic conversion is off for ${v.name}.`);
        } else {
          auto = await invoke('setAuto', { enabled: auto.settings.enabled && others.length > 0, ...common, ...(auto.settings.enabled && others.length ? { config: others[0] } : {}) });
          toast('Options saved.');
        }
      } catch (err) {
        toast(describe(err), { kind: 'bad' });
        auto = await invoke('getAuto').catch(() => auto);
      }
      draw();
    });
  }

  draw();
  invoke('getAuto').then((a) => { auto = a; draw(); }, () => { auto = false; draw(); });
  let lastState;
  const stop = follow((s, nw) => {
    snap = s;
    nodeWaiting = nw;
    const slot = view.querySelector('#job-slot');
    const phase = !s ? 'none' : ACTIVE.has(s.state) ? 'active' : `${s.id}:${s.state}:${s.summaryDismissed ? 'd' : ''}`;
    const stateChanged = phase !== lastState;
    lastState = phase;
    if (!slot) return;
    // keep the page still: only the job card follows the numbers
    if (stateChanged && !(view.contains(document.activeElement) && document.activeElement.matches('select, input:not([type=checkbox])'))) draw();
    else {
      const focused = slot.contains(document.activeElement) ? document.activeElement : null;
      const key = focused && (focused.dataset.cmd ? `[data-cmd="${focused.dataset.cmd}"]` : focused.dataset.step ? `[data-step="${focused.dataset.step}"][data-d="${focused.dataset.d}"]` : focused.dataset.lane ? `[data-lane="${CSS.escape(focused.dataset.lane)}"][data-d="${focused.dataset.d}"]` : focused.dataset.nodeGroup ? `[data-node-group="${CSS.escape(focused.dataset.nodeGroup)}"]` : null);
      const openDetails = slot.querySelector('details')?.open;
      slot.innerHTML = jobCard();
      if (openDetails) slot.querySelector('details').open = true;
      wireJob();
      if (key) slot.querySelector(key)?.focus({ preventScroll: true });
    }
  });
  ctx.cleanup(stop);
  ctx.every(5000, async () => {
    // the times (working for, time left) move on between updates
    const slot = view.querySelector('#job-slot');
    if (slot && snap && ACTIVE.has(snap.state) && !slot.contains(document.activeElement)) { const o = slot.querySelector('details')?.open; slot.innerHTML = jobCard(); if (o) slot.querySelector('details').open = true; wireJob(); }
    if (auto && auto.settings?.enabled) { const a = await invoke('getAuto').catch(() => null); if (a && JSON.stringify(a.status) !== JSON.stringify(auto.status)) { auto = a; const card = view.querySelector('#auto'); if (card && !card.contains(document.activeElement)) draw(); } }
  });
  ctx.on('vehicle', draw);
  ctx.on('vehicles', () => { if (!view.contains(document.activeElement)) draw(); });
}

// ---------- the guided flow ----------
async function wizard(ctx) {
  const { view } = ctx;
  const ch = lastChoices();
  if (!canReplace()) ch.mode = 'separate';
  ch.vehicleId = vehicleById(ch.vehicleId) ? ch.vehicleId : vehicle()?.id;
  let step = 1;
  let confirmed = false;
  if (!state.vehicles.length) {
    view.innerHTML = `<div class="page">${emptyState({ art: 'car', title: 'Add a vehicle first', action: '<a class="btn btn-primary" href="#/settings/add-vehicle">Add my vehicle</a>' })}</div>`;
    return;
  }
  const current = await invoke('getCurrent').catch(() => null);
  if (current && ACTIVE.has(current.state)) {
    view.innerHTML = `<div class="page wizard"><a class="back-link" href="#/encoder">${icon('back')} Encoder</a>${emptyState({ art: 'encoder', title: 'Something is converting already', text: 'One conversion runs at a time. Watch it, pause it or stop it on the Encoder page.', action: '<a class="btn btn-primary" href="#/encoder">See progress</a>' })}</div>`;
    return;
  }
  const STEPS = ['What to do', 'Which footage', 'How small', 'Ready'];
  const v = () => vehicleById(ch.vehicleId) || vehicle();

  const stepBody = () => {
    if (step === 1) {
      return `<h2>What do you want to do?</h2><p class="muted" style="margin:6px 0 18px">You can change your mind before anything starts.</p>
        <div class="choices" role="group" aria-label="What to do">
          <button type="button" class="choice" data-mode="replace" aria-pressed="${ch.mode === 'replace'}"${canReplace() ? '' : ' disabled'}><span class="choice-icon">${icon('sparkle')}</span><span><b>Shrink my footage</b><span>Each clip is converted, checked, and only then takes the place of the original. Frees the most space.${canReplace() ? '' : ' (Not possible on this storage.)'}</span></span></button>
          <button type="button" class="choice" data-mode="separate" aria-pressed="${ch.mode === 'separate'}"><span class="choice-icon">${icon('folder')}</span><span><b>Make smaller copies</b><span>Originals stay untouched; converted copies go to another folder.</span></span></button>
          <a class="choice" href="#/encoder/speed-test"><span class="choice-icon">${icon('speed')}</span><span><b>Test how fast this server converts</b><span>Tries a few clips at different settings and suggests the best one. Your footage is only read.</span></span></a>
        </div>`;
    }
    if (step === 2) {
      return `<h2>Which footage?</h2><p class="muted" style="margin:6px 0 18px">Pick the vehicle and the kinds of clips to convert.</p>
        <div class="choices compact" role="group" aria-label="Vehicle">${state.vehicles.map((x) => `<button type="button" class="choice" data-vehicle="${esc(x.id)}" aria-pressed="${x.id === ch.vehicleId}"><span class="choice-icon">${icon('car')}</span><span><b>${esc(x.name)}</b><span>${x.inventory ? `${plural(x.inventory.recordings, 'recording')} · ${bytes(x.inventory.bytes)}` : 'Not scanned yet'}</span></span></button>`).join('')}</div>
        <h3 style="margin:22px 0 10px">Kinds of clips</h3>
        <div class="stack-sm">${GROUPS.map((g) => `<label class="check"><input type="checkbox" data-group="${g}"${ch.groups.includes(g) ? ' checked' : ''}> <span><b>${GROUP_WORD[g]}</b> <span class="muted">${g === 'RecentClips' ? 'everyday driving' : g === 'SavedClips' ? 'clips you saved with the horn or the screen' : 'what the car saw while parked'}</span></span></label>`).join('')}</div>`;
    }
    if (step === 3) {
      return `<h2>How small?</h2><p class="muted" style="margin:6px 0 18px">The defaults suit most people.</p>
        <h3 style="margin-bottom:10px">Format</h3>
        <div class="choices compact" role="group" aria-label="Format">
          <button type="button" class="choice" data-codec="h265" aria-pressed="${ch.codec === 'h265'}"><span><b>H.265</b><span>Plays on nearly everything. Recommended.</span></span></button>
          <button type="button" class="choice" data-codec="av1" aria-pressed="${ch.codec === 'av1'}"><span><b>AV1</b><span>Even smaller, takes longer, needs newer players.</span></span></button></div>
        <h3 style="margin:22px 0 10px">How much smaller</h3>
        <div class="choices compact" role="group" aria-label="How much smaller">${[['conservative', 'Light', 'About 5% smaller, looks identical'], ['balanced', 'Balanced', 'About 20% smaller. Recommended'], ['aggressive', 'Strong', 'About half the size'], ['quality', 'Constant quality', 'Size varies: still scenes shrink most']].map(([p, t, d]) => `<button type="button" class="choice" data-profile="${p}" aria-pressed="${ch.profile === p}"><span><b>${t}</b><span>${d}</span></span></button>`).join('')}</div>
        ${ch.profile === 'quality' ? `<label class="field" style="margin-top:14px"><span>Quality</span><select class="input" id="quality">${Object.entries(QUALITY_WORD).map(([k, t]) => `<option value="${k}"${ch.quality === k ? ' selected' : ''}>${t}</option>`).join('')}</select></label>` : ''}
        ${details('More details', `<label class="field"><span>How carefully to check each result</span><select class="input" id="verify"><option value="quick"${ch.verify === 'quick' ? ' selected' : ''}>Quick: streams, length, frames, size and driving data (recommended)</option><option value="full"${ch.verify === 'full' ? ' selected' : ''}>Thorough: also decodes every frame (slower)</option></select></label>
          ${ch.mode === 'separate' ? `<label class="field" style="margin-top:12px"><span>Where the copies go</span><div class="row" style="flex-wrap:nowrap"><input class="input mono" id="dest" value="${esc(ch.destination || defaultDestination(v()))}" style="flex:1;min-width:0"><button class="btn" type="button" id="browse">Browse</button></div></label>` : ''}
          <p class="muted small" style="margin-top:12px">Clips at once: ${parallelConfig().concurrency}${parallelConfig().lanes ? ` across ${plural(parallelConfig().lanes.length, 'device')}` : ''}. Change it on the Encoder page.</p>`, ch.mode === 'separate')}`;
    }
    const x = v();
    return `<h2>Ready when you are</h2><p class="muted" style="margin:6px 0 18px">Here’s what will happen.</p>
      <ul class="summary-list">
        <li>${icon('car')}<span>Convert <b>${esc(x.name)}</b>’s ${esc(ch.groups.map((g) => GROUP_WORD[g].toLowerCase()).join(', '))}${x.inventory ? ` (up to ${bytes(x.inventory.bytes)})` : ''}.</span></li>
        <li>${icon('sparkle')}<span>To <b>${CODEC_WORD[ch.codec]}</b>, ${esc(PROFILE_WORD[ch.profile].toLowerCase())}${ch.profile === 'quality' ? `, ${QUALITY_WORD[ch.quality].toLowerCase()}` : ''}.</span></li>
        <li>${icon('shieldCheck')}<span>Every converted clip is checked (${ch.verify === 'full' ? 'thoroughly' : 'quickly'}) against its original, driving data included.</span></li>
        <li>${icon(ch.mode === 'replace' ? 'restore' : 'folder')}<span>${ch.mode === 'replace' ? 'Then it takes the original’s place. Each original is backed up first and put back if anything goes wrong.' : `Copies go to <span class="mono">${esc(ch.destination || defaultDestination(x))}</span>; originals stay as they are.`}</span></li>
        <li>${icon('clock')}<span>It runs in the background. You can pause or stop it any time.</span></li>
      </ul>
      ${ch.mode === 'replace' ? `<label class="check" style="margin-top:20px"><input type="checkbox" id="confirm-replace"${confirmed ? ' checked' : ''}> <span>I understand that originals are replaced once their smaller copies check out.</span></label>` : ''}`;
  };

  const draw = () => {
    view.innerHTML = `<div class="page wizard"><a class="back-link" href="#/encoder">${icon('back')} Encoder</a>
      <h1 style="margin-bottom:18px">Save space</h1>
      <ol class="steps">${STEPS.map((s, i) => `<li class="${i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}"${i + 1 === step ? ' aria-current="step"' : ''}><span class="n">${i + 1 < step ? icon('check') : i + 1}</span><span class="${i + 1 === step ? '' : 'hide-phone'}">${s}</span></li>`).join('')}</ol>
      <div class="card">${stepBody()}
        <div class="wiz-foot"><button class="btn" type="button" id="back">${step === 1 ? 'Cancel' : 'Back'}</button>
          <button class="btn btn-primary" type="button" id="next">${step === 4 ? `${icon('play')} Start converting` : `Next ${icon('next')}`}</button></div></div></div>`;
    wire();
  };
  const remember = () => store.set('choices', ch);
  const wire = () => {
    view.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => { ch.mode = b.dataset.mode; remember(); step = 2; draw(); }; });
    view.querySelectorAll('[data-vehicle]').forEach((b) => { b.onclick = () => { ch.vehicleId = b.dataset.vehicle; ch.destination = ''; remember(); draw(); }; });
    view.querySelectorAll('[data-group]').forEach((b) => { b.onchange = () => { ch.groups = GROUPS.filter((g) => view.querySelector(`[data-group="${g}"]`).checked); remember(); }; });
    view.querySelectorAll('[data-codec]').forEach((b) => { b.onclick = () => { ch.codec = b.dataset.codec; remember(); draw(); }; });
    view.querySelectorAll('[data-profile]').forEach((b) => { b.onclick = () => { ch.profile = b.dataset.profile; remember(); draw(); }; });
    view.querySelector('#quality')?.addEventListener('change', (e) => { ch.quality = e.target.value; remember(); });
    view.querySelector('#verify')?.addEventListener('change', (e) => { ch.verify = e.target.value; remember(); });
    view.querySelector('#dest')?.addEventListener('change', (e) => { ch.destination = e.target.value.trim(); remember(); });
    view.querySelector('#browse')?.addEventListener('click', async () => {
      const chosen = await pickFolder(ch.destination || info.context?.outputRoots?.[0]);
      if (chosen) { ch.destination = chosen; remember(); draw(); }
    });
    view.querySelector('#confirm-replace')?.addEventListener('change', (e) => { confirmed = e.target.checked; });
    view.querySelector('#back').onclick = () => { if (step === 1) go('#/encoder'); else { step -= 1; draw(); } };
    view.querySelector('#next').onclick = async (e) => {
      if (step === 2 && !ch.groups.length) return toast('Pick at least one kind of clip.', { kind: 'bad' });
      if (step < 4) { step += 1; draw(); view.querySelector('.card h2')?.focus?.(); return undefined; }
      if (ch.mode === 'replace' && !confirmed) return toast('Tick the box to confirm, then start.', { kind: 'bad' });
      return busy(e.currentTarget, async () => {
        try {
          const config = configFrom(ch, v());
          const { jobId } = await invoke('start', config);
          applySnapshot({ id: jobId, state: 'discovering', revision: 0, createdAt: Date.now(), updatedAt: Date.now(), config, items: [], counters: {}, summary: null });
          toast('Started. You can leave this page; it carries on.', { kind: 'good' });
          go('#/encoder');
        } catch (err) {
          toast(describe(err), { kind: 'bad' });
        }
      });
    };
  };
  draw();
}

/** A folder picker over the vehicle footage and output folders. */
async function pickFolder(start) {
  let current = null;
  const show = async (dlg, p) => {
    const list = dlg.querySelector('#pick-list');
    list.innerHTML = '<li class="loading"><span class="spin"></span><span>Loading…</span></li>';
    let data;
    try { data = await api('/api/studio/browse', { body: { path: p || null } }); } catch (err) { list.innerHTML = `<li class="muted" style="padding:12px">${esc(err.message)}</li>`; return; }
    current = data.path;
    dlg.querySelector('#pick-path').textContent = current || 'Choose a starting place';
    list.innerHTML = `${current ? `<li><button type="button" data-p="${esc(data.parent || '')}">${icon('back')} Up</button></li>` : ''}${data.entries.map((e) => `<li><button type="button" data-p="${esc(e.path)}">${icon('folder')} ${esc(e.name)}</button></li>`).join('') || '<li class="muted" style="padding:12px">No folders here. You can still pick this one; a new folder can be typed in the box.</li>'}`;
    list.querySelectorAll('[data-p]').forEach((b) => { b.onclick = () => show(dlg, b.dataset.p || null); });
  };
  const out = await modal({
    title: 'Choose a folder',
    body: '<p class="muted small mono" id="pick-path"></p><ul class="picker-list" id="pick-list"></ul>',
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Use this folder', value: 'ok', kind: 'primary' }],
    onOpen: (dlg) => show(dlg, start && start.startsWith('/') ? start.replace(/\/[^/]*$/, '') || null : null)
  });
  return out?.value === 'ok' ? current : null;
}

// ---------- speed test ----------
async function speedTest(ctx) {
  const { view } = ctx;
  let codecs = ['h265'];
  let running = false;
  let progress = null;
  let result = null;
  let error = null;
  const v = () => vehicle();
  const levelRows = (run) => {
    if (run.error) return `<p class="muted">${esc(run.error === 'UNSUPPORTED' ? `This server can’t encode ${CODEC_WORD[run.codec]}.` : describe({ code: run.error }))}</p>`;
    const best = run.best?.level;
    return `<p class="muted small">${esc(run.encoder ? `${run.encoder.hardware ? 'Graphics card' : 'Processor'} (${run.encoder.family || run.encoder.codec || ''})` : '')} · ${plural(run.clips, 'sample clip')}</p>
      <div style="overflow-x:auto"><table class="bench-table"><thead><tr><th>At once</th><th>Clips / min</th><th>Smaller by</th><th>Power</th></tr></thead><tbody>
      ${run.results.map((r) => `<tr class="${r.level === best ? 'best' : ''}"><td>${r.level}${r.level === best ? ' (best)' : ''}</td><td>${r.ok ? r.filesPerMinute : `${r.failed} failed`}</td><td>${fin(r.savedPercent) ? `${Math.round(r.savedPercent)}%` : '—'}</td><td>${fin(r.avgW) ? `${Math.round(r.avgW)} W` : '—'}</td></tr>`).join('')}</tbody></table></div>
      ${best ? `<div class="actions"><button class="btn btn-primary btn-sm" type="button" data-use="${best}">Use ${best} at once</button></div>` : ''}`;
  };
  const resultHtml = () => {
    if (!result) return '';
    const runs = result.devices ? result.devices.flatMap((d) => d.codecs.map((c) => ({ ...c, device: d.device }))) : (result.codecs || [result]);
    return `<div class="card section"><h2>Results</h2>${runs.map((r) => `<h3 style="margin:16px 0 6px">${esc(r.device ? `${r.device.name || r.device.id}: ` : '')}${CODEC_WORD[r.codec] || r.codec}</h3>${levelRows(r)}`).join('')}</div>`;
  };
  const progressText = (p) => {
    if (!p) return 'Starting…';
    if (p.step === 'scan') return 'Finding sample clips…';
    if (p.step === 'verify') return `Comparing checking modes (${p.index} of ${p.total})…`;
    if (p.step === 'run') return `${CODEC_WORD[p.codec] || ''}: trying ${p.level} at once (${p.index} of ${p.total})${p.codecTotal > 1 ? ` · format ${p.codecIndex} of ${p.codecTotal}` : ''}`;
    return 'Working…';
  };
  const draw = () => {
    view.innerHTML = `<div class="page wizard"><a class="back-link" href="#/encoder">${icon('back')} Encoder</a>
      <h1>Speed test</h1><p class="lede muted" style="margin:8px 0 20px">Converts a few of your clips into a temporary folder at 1, 2, 4, 6 and 8 at once, and suggests the fastest setting. Your footage is only read.</p>
      <div class="card stack">
        <div class="row-between"><b>Clips from</b>${vehiclePicker()}</div>
        <fieldset style="border:0;padding:0;margin:0"><legend class="field" style="margin-bottom:8px">Formats to test</legend>
          <div class="row"><label class="check"><input type="checkbox" value="h265" data-codec${codecs.includes('h265') ? ' checked' : ''}${running ? ' disabled' : ''}> H.265</label>
          <label class="check"><input type="checkbox" value="av1" data-codec${codecs.includes('av1') ? ' checked' : ''}${running ? ' disabled' : ''}> AV1</label></div></fieldset>
        ${running ? `<div aria-live="polite"><p><b>${esc(progressText(progress))}</b></p><div style="margin-top:10px">${meter(progress?.index && progress?.total ? (progress.index - 1) / progress.total : 0.04, 'live')}</div></div>` : ''}
        ${error ? `<div class="note note-bad">${icon('alert')}<span>${esc(error)}</span></div>` : ''}
        <div class="row">${running ? `<button class="btn" type="button" id="cancel">${icon('close')} Cancel the test</button>` : `<button class="btn btn-primary" type="button" id="run"${v() ? '' : ' disabled'}>${icon('speed')} Start the test</button>`}</div>
      </div>${resultHtml()}</div>`;
    view.querySelector('#vehicle-pick')?.addEventListener('change', (e) => setVehicle(e.target.value));
    view.querySelectorAll('[data-codec]').forEach((b) => { b.onchange = () => { codecs = [...view.querySelectorAll('[data-codec]:checked')].map((x) => x.value); }; });
    view.querySelector('#cancel')?.addEventListener('click', () => invoke('cancelBenchmark').catch(() => {}));
    view.querySelectorAll('[data-use]').forEach((b) => {
      b.onclick = () => {
        const n = Number(b.dataset.use);
        store.set('concurrency', n);
        if (info.devices) { const map = laneCounts(); const def = info.devices.defaultDevice || [...map.keys()][0]; map.set(def, n); saveLanes(map); }
        toast(`Saved: ${n} at once for your next conversion.`, { kind: 'good' });
      };
    });
    view.querySelector('#run')?.addEventListener('click', async () => {
      if (!codecs.length) return toast('Pick at least one format.', { kind: 'bad' });
      running = true; error = null; result = null; progress = null;
      draw();
      const stop = onBenchmark((p) => { progress = p; if (ctx.alive()) draw(); });
      ctx.cleanup(stop);
      try {
        await streamReady();
        result = await invoke('runBenchmark', { codecs, sourceRoot: footageOf(v()), profileId: 'balanced', verifyMode: 'quick' });
      } catch (err) {
        error = err.code === 'CANCELLED' ? 'The test was cancelled.' : describe(err);
      } finally {
        stop();
        running = false;
        if (ctx.alive()) draw();
      }
      return undefined;
    });
  };
  draw();
}
