import { esc, invoke as previewInvoke, api as previewApi, clientId, scope } from '../core.js';
import { icon } from '../icons.js';
import { size } from '../format.js';
import { KEEP_CHIPS, LEVELS, fromSaved, toVehicleConfig, toAutoSettings, planSentence, scheduleText, nextCheckLabel, expertSummary, dayStates, levelOf, levelDevice, previewPercent, previewMeasured, previewSource, previewMegabytes, previewProgress, previewFailure, dayHeat, footageEstimate, nextAgingDay, catchUpProgress } from '../encoderModel.js';
import { onPreview, streamReady, follow, counts, ACTIVE, PAUSED, describe, applySnapshot, hardwareLabel } from '../convert.js';
import { describeJob } from '../jobs.js';

const GROUPS = {
  SavedClips: { name: 'Saved clips', description: 'Clips you saved with the horn, your voice or the screen', color: 'saved' },
  SentryClips: { name: 'Sentry clips', description: 'Recorded while parked, when something moved near the car', color: 'sentry' },
  RecentClips: { name: 'Recent clips', description: 'Everything else the car records while driving', color: 'driving' },
};
const DAY_LABELS = { kept: 'Stays as recorded', shrink: 'Will be shrunk', done: 'Already shrunk', none: 'No footage' };
const STEPS = ['Newest footage', 'Space saving', 'Schedule', 'Review'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SCHEDULES = { night: 'Every night', week: 'Once a week', month: 'Once a month', asap: 'As clips age' };
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const rootOf = (vehicle) => vehicle.studioRoot || vehicle.root;
function openExpert() {
  const expert = document.getElementById('encoder-expert');
  if (expert) { expert.checked = true; expert.dispatchEvent(new Event('change', { bubbles: true })); }
}
const errorText = (error) => error?.message || 'Could not save these settings. Try again.';
// Keep a server explanation as well as its code; the shared legacy invoke helper
// exposes only the code. Scope still owns the request and navigation cancellation.
const setupInvoke = (owner) => async (name, payload) => {
  const out = await owner.api(`/api/converter/invoke/${name}`, {
    method: 'POST', body: payload, headers: { 'X-Client-Id': clientId },
  });
  if (!out?.ok) throw Object.assign(new Error(out?.error?.message || out?.error?.code || 'Converter request failed'), { code: out?.error?.code });
  return out.value;
};
const QUALITY = {
  std: { dots: 5, note: 'Looks the same as the original. Fastest.' },
  med: { dots: 4, note: 'Very slight softness in fine detail.' },
  high: { dots: 3, note: 'Fine detail softer, plates still readable up close. Slower, uses the CPU.' },
};
const cancelPreviewId = (id) => previewApi('/api/converter/invoke/previewCancel', {
  method: 'POST', body: { id }, keepalive: true, headers: { 'X-Client-Id': clientId },
}).catch(() => {});

async function renderStatus(mount, ctx, initial, show) {
  const { api, confirmDialog } = ctx.scope;
  const invoke = setupInvoke(ctx.scope);
  const vehicle = ctx.current(), root = rootOf(vehicle), zone = browserZone();
  let auto = initial, saved = null, jobs = [], days = [], encoder = null, snapshot = null, nodeWaiting = null;
  let readError = '', commandError = '', busy = false, loading = false, loaded = false, stopped = false;
  let share = vehicle.share;
  const valid = () => !stopped && ctx.alive();
  const activeJob = () => snapshot && snapshot.config?.sourceRoot === root && ACTIVE.has(snapshot.state) &&
    auto.status?.active?.[root]?.jobId === snapshot.id ? snapshot : null;
  mount.innerHTML = `<div class="encoder-status-screen" data-encoder-screen="status">
    <section class="card"><div class="encoder-status">
      <span class="encoder-status-icon" aria-hidden="true">${icon('check_circle')}</span>
      <div class="encoder-status-copy"><div class="encoder-on-pill">Automatic shrinking is on</div><h2 tabindex="-1">${esc(vehicle.name)} is set. You can forget about it.</h2><p data-plan></p></div>
      <div class="encoder-status-actions"><button type="button" data-change>Change setup</button><button type="button" class="ghost" data-off>Turn off</button></div>
    </div><div data-custom-status hidden></div><p data-separate-output hidden>Copies go to a separate folder, so this doesn't free space on the drive.</p><div class="encoder-summary" data-status-numbers></div>
      <p class="encoder-estimate-note" data-savings-note hidden>Recorded savings for this vehicle since its savings counter was last reset.</p>
    </section>
    <section class="card encoder-catchup" data-catchup hidden aria-labelledby="encoder-catchup-heading"><div class="encoder-catchup-header"><h3 id="encoder-catchup-heading">Catching up on older footage</h3><button type="button" data-job-command hidden>Pause</button></div><div data-catchup-progress></div><small>Pause holds until you press Resume.</small></section>
    <section class="card"><h3>Coming up</h3><div class="encoder-review" data-coming-up></div><p class="encoder-estimate-note" data-next-work></p><small>Check times shown in ${esc(zone)}. Footage dates use ${esc(vehicle.timezone)}.</small></section>
    <section class="card encoder-problems" data-problems hidden aria-labelledby="encoder-problems-heading"><h3 id="encoder-problems-heading">Needs attention</h3><div data-problem-list role="status"></div><div class="form-actions"><button type="button" data-refresh>Check again</button><a class="btn" href="#/activity">Activity</a><button type="button" data-problem-expert>Open Expert</button></div></section>
  </div>`;
  const update = (selector, html) => {
    const el = mount.querySelector(selector);
    if (el.innerHTML !== html) el.innerHTML = html;
  };
  function draw() {
    if (!valid()) return;
    const config = auto.settings?.configs?.find((c) => c.sourceRoot === root);
    if (!config) return;
    const choice = fromSaved(config, auto.settings), status = auto.status || {};
    const active = activeJob(), c = active ? counts(active) : null;
    update('[data-plan]', esc(planSentence(choice)));
    const custom = mount.querySelector('[data-custom-status]');
    custom.hidden = choice.level !== 'custom';
    update('[data-custom-status]', `<h3>Customized in Expert</h3><p>${esc(expertSummary(config))}</p>`);
    const numbers = [];
    const separate = config.outputMode === 'separate';
    mount.querySelector('[data-separate-output]').hidden = !separate;
    if (Number.isFinite(saved?.bytes)) numbers.push([size(saved.bytes), separate ? 'size saved by the copies' : 'space saved so far']);
    if (Number.isFinite(saved?.clips)) numbers.push([saved.clips.toLocaleString(), 'clips shrunk since counter reset']);
    if (Number.isFinite(status.nextCheckAt) && status.nextCheckAt > 0) numbers.push([nextCheckLabel(status.nextCheckAt, zone), 'next check']);
    const pending = status.pending?.[root];
    const waiting = c ? c.queued + c.inFlight : Number.isFinite(pending) ? pending : null;
    mount.querySelector('[data-savings-note]').hidden = !Number.isFinite(saved?.bytes) && !Number.isFinite(saved?.clips);
    mount.querySelector('[data-catchup]').hidden = !status.catchUp?.[root];
    const paused = active && PAUSED.has(active.state);
    const progress = active && catchUpProgress(active, c), device = active && encoder ? hardwareLabel(active, encoder) : '';
    update('[data-catchup-progress]', progress
      ? `<progress max="${progress.total}" value="${progress.done}" aria-label="Catch-up progress for the current job"></progress><div class="encoder-progress-caption"><span>${progress.percent}% · ${progress.unit === 'bytes' ? `${size(progress.done)} of ${size(progress.total)}` : `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} clips`} processed in this job · ${paused ? 'Paused' : 'In progress'}</span>${device ? `<span>${esc(device)}</span>` : ''}</div>${active.discoveryComplete === false ? '<small>Still looking for clips; the total may grow.</small>' : ''}`
      : `<progress aria-label="Preparing catch-up"></progress><p>${active ? paused ? 'Paused.' : 'Looking for eligible clips…' : status.active?.[root] ? 'Reading catch-up progress…' : 'Waiting for the server to start the catch-up job.'}</p>`);
    const jobButton = mount.querySelector('[data-job-command]');
    jobButton.hidden = !active; jobButton.disabled = busy;
    jobButton.textContent = paused ? 'Resume' : 'Pause';
    mount.querySelector('[data-change]').disabled = busy;
    mount.querySelector('[data-off]').disabled = busy;
    const aging = nextAgingDay(days, choice.keep, vehicle.timezone);
    const dateLabel = (day) => new Date(day + 'T00:00:00Z').toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric', timeZone:'UTC'});
    const last = jobs.filter((j) => j.vehicleId === vehicle.id && ['conversion', 'convert'].includes(j.type) && ['done', 'failed', 'interrupted', 'cancelled'].includes(j.status))
      .sort((a, b) => (b.finishedAt || b.updatedAt || b.createdAt || 0) - (a.finishedAt || a.updatedAt || a.createdAt || 0))[0];
    update('[data-coming-up]', (aging ? `<div class="encoder-review-row"><span class="encoder-review-icon">${icon('calendar_month')}</span><div><b>${esc(dateLabel(aging.day))} footage ages past ${choice.keep} days on ${esc(dateLabel(aging.agesOn))}</b><small>Included clips get shrunk on the first check after that.</small></div></div>` : '') +
      (last ? `<div class="encoder-review-row"><span class="encoder-review-icon">${icon('task')}</span><div><b>Last run: ${esc(describeJob(last).title)}</b><small>${esc(describeJob(last).outcome || describeJob(last).statusText)}</small></div><a class="btn ghost" href="#/activity">Activity</a></div>` : ''));
    update('[data-next-work]', esc(waiting > 0
      ? `${c ? `${waiting.toLocaleString()} clips waiting or in progress.` : `About ${waiting.toLocaleString()} files waiting at the last check; eligible clips are counted when the job starts.`} Later checks look for included clips ${choice.keep == null ? 'that have not been shrunk yet' : `older than the ${choice.keep}-day keep window`}.`
      : `The next check looks for included clips ${choice.keep == null ? 'that have not been shrunk yet' : `that have aged past the ${choice.keep}-day keep window`}. The amount will be known when it checks.`));
    const problems = [];
    if (readError) problems.push(readError);
    if (commandError) problems.push(commandError);
    const sourceError = status.sources?.[root]?.error;
    if (share?.healthy === false || share?.readable === false || active?.state === 'paused_network' || ['PATH_UNAVAILABLE', 'SOURCE_UNAVAILABLE'].includes(sourceError))
      problems.push(`The footage share is offline or cannot be reached. ${share?.lastError || 'Check its connection; your originals stay where they are.'}`);
    if (sourceError && !['PATH_UNAVAILABLE', 'SOURCE_UNAVAILABLE'].includes(sourceError)) problems.push(describe({ code: sourceError }));
    if (c?.failed) problems.push(`${c.failed} clips could not be shrunk. Their originals were kept. Open Expert to review or retry them.`);
    for (const job of jobs.filter((j) => j.vehicleId === vehicle.id && ['conversion', 'convert'].includes(j.type) && j.status === 'failed'))
      problems.push(describeJob(job).outcome || 'A previous shrinking run failed. Open Activity for details.');
    if (status.active?.[root]?.pausedForDevices || (active && nodeWaiting?.jobId === active.id && nodeWaiting.count > 0))
      problems.push('Waiting for an encoding device or GPU to become available.');
    else if (pending > 0 && Object.entries(status.active || {}).some(([source]) => source !== root))
      problems.push('Waiting for another vehicle’s shrinking run to free an encoding device.');
    if (status.active?.[root]?.pausedForWindow) problems.push('Waiting for the next cheap electricity period.');
    if (loaded && !readError) numbers.push([new Set(problems).size.toLocaleString(), 'problems']);
    update('[data-status-numbers]', numbers.map(([value, label], i) => `<div class="encoder-stat${i === 0 && Number.isFinite(saved?.bytes) ? ' encoder-stat-saved' : ''}"><b>${esc(value)}</b><span>${label}</span></div>`).join(''));
    mount.querySelector('[data-problems]').hidden = !problems.length;
    update('[data-problem-list]', [...new Set(problems)].map((message) => `<p>${esc(message)}</p>`).join(''));
  }
  async function load() {
    if (!valid() || loading || busy) return;
    loading = true;
    try {
      const [current, vehicles, history, footage, stats] = await Promise.all([
        invoke('getAuto'), api('/api/vehicles'), api(`/api/jobs?vehicle=${encodeURIComponent(vehicle.id)}`),
        api(`/api/vehicles/${encodeURIComponent(vehicle.id)}/days?limit=400`), api('/api/stats'),
      ]);
      if (!valid()) return;
      auto = current;
      if (!auto.settings?.configs?.some((c) => c.sourceRoot === root)) { await show(auto); return; }
      const currentVehicle = vehicles.vehicles?.find((v) => v.id === vehicle.id);
      saved = currentVehicle?.saved; share = currentVehicle?.share;
      jobs = history.jobs || []; days = footage.days || []; encoder = stats.encoder; readError = ''; loaded = true;
    } catch (error) { if (valid()) readError = `Could not refresh status. ${errorText(error)}`; }
    finally { loading = false; draw(); }
  }
  mount.querySelector('[data-change]').onclick = () => show(auto, true).catch((error) => { commandError = errorText(error); draw(); });
  mount.querySelector('[data-off]').onclick = async () => {
    if (busy) return;
    busy = true; draw();
    try {
      const yes = await confirmDialog({ title: `Turn off automatic shrinking for ${vehicle.name}?`, body: '<p>This removes only this vehicle’s automatic setup. Other vehicles keep their setup.</p>', ok: 'Turn off', danger: true });
      if (!yes) return;
      const current = await invoke('getAuto');
      // Removing a vehicle must not reinterpret the shared schedule in this browser's zone.
      const shared = toAutoSettings({ ...fromSaved(null, current.settings), when: 'custom' }, zone, current.settings);
      const updated = await invoke('setAuto', { enabled: false, ...shared, removeSource: root });
      if (valid()) await show(updated);
    } catch (error) { if (valid()) commandError = errorText(error); }
    finally { busy = false; draw(); }
  };
  mount.querySelector('[data-job-command]').onclick = async () => {
    const job = activeJob();
    if (!job || busy) return;
    busy = true; commandError = ''; draw();
    try {
      const result = await invoke(PAUSED.has(job.state) ? 'resume' : 'pause', { jobId: job.id });
      if (valid()) { snapshot = result; applySnapshot(result); }
    } catch (error) { if (valid()) commandError = errorText(error); }
    finally { busy = false; draw(); }
  };
  mount.querySelector('[data-refresh]').onclick = load;
  mount.querySelector('[data-problem-expert]').onclick = openExpert;
  draw();
  const stop = follow((next, waiting) => {
    if (next?.config?.sourceRoot === root) { snapshot = next; nodeWaiting = waiting; }
    draw();
  }, ctx.scope);
  const timer = setInterval(load, 5000);
  const cleanup = () => { stopped = true; clearInterval(timer); stop(); };
  ctx.scope.signal.addEventListener('abort', cleanup, { once: true });
  await load();
  return cleanup;
}

export async function render(mount, ctx) {
  const vehicle = ctx.current();
  mount.className = 'encoder-setup';
  if (!vehicle) {
    mount.innerHTML = '<section class="card"><h2>Add your first vehicle to get started.</h2><a class="btn primary" href="#/settings/vehicles">Add a vehicle</a></section>';
    return;
  }
  mount.innerHTML = '<p role="status">Loading encoder setup…</p>';
  const auto = await ctx.scope.invoke('getAuto');
  if (!ctx.alive()) return;
  let owner, cleanup, opened = false;
  async function show(current, editing = false) {
    const focus = opened; opened = true;
    owner?.abort(); cleanup?.(); cleanup = null;
    owner = scope([], { signal: ctx.scope.signal });
    const screenOwner = owner;
    const screen = { ...ctx, scope: screenOwner, alive: () => ctx.alive() && screenOwner.alive() };
    const config = current.settings?.configs?.find((entry) => entry.sourceRoot === rootOf(vehicle));
    try {
      const stop = config && !editing
        ? await renderStatus(mount, screen, current, show)
        : await renderWizard(mount, screen, current, editing, show);
      if (screen.alive()) {
        cleanup = stop;
        if (focus && config && !editing) mount.querySelector('h2')?.focus();
      }
      else stop?.();
    } catch (error) {
      if (!screen.alive()) return;
      mount.innerHTML = `<section class="card"><p role="alert">${esc(errorText(error))}</p><button type="button" data-reload>Try again</button></section>`;
      mount.querySelector('[data-reload]').onclick = () => ctx.render();
    }
  }
  await show(auto);
  return () => { owner?.abort(); cleanup?.(); };
}

async function renderWizard(mount, ctx, auto, editing, show) {
  const { api } = ctx.scope;
  const invoke = setupInvoke(ctx.scope);
  const vehicle = ctx.current(), root = rootOf(vehicle), zone = browserZone();
  const saved = auto.settings?.configs?.find((entry) => entry.sourceRoot === root) || auto.saved?.find((entry) => entry.sourceRoot === root);
  // A new setup starts with the guided defaults; an existing shared schedule
  // belongs to all configured vehicles and must survive editing this one.
  const choice = fromSaved(saved, auto.settings?.configs?.length ? auto.settings : undefined);
  const { days, total } = await api(`/api/vehicles/${encodeURIComponent(vehicle.id)}/days?limit=400`);
  if (!ctx.alive()) return;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: vehicle.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type) => parts.find((p) => p.type === type).value;
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  const currentMonth = today.slice(0, 7) + '-01';
  let month = new Date(currentMonth + 'T00:00:00Z');
  let step = editing ? 4 : 1;
  let acknowledged = false, saving = false, replacementUnavailable = false, capabilitiesReady = false, saveError = '';
  const otherVehicles = ctx.state.vehicles.filter((v) => rootOf(v) !== root && auto.settings?.configs?.some((c) => c.sourceRoot === rootOf(v))).map((v) => v.name);
  let customOpen = choice.keep != null && !KEEP_CHIPS.includes(choice.keep);
  const noKeep = choice.keep == null;
  const byDay = new Map(days.map((day) => [day.day, day]));
  const phoneCalendar = window.matchMedia('(max-width: 600px)');

  mount.innerHTML = `<div data-encoder-screen="wizard">
    <ol class="encoder-stepper" aria-label="Encoder setup steps">
      ${STEPS.map((label, i) => `<li ${i === 0 ? 'aria-current="step"' : ''}><span class="encoder-step-number">${i + 1}</span><span class="encoder-step-label">${label}</span></li>`).join('')}
    </ol>
    <div class="card">
    <section data-encoder-step="1" aria-labelledby="encoder-keep-heading">
      <div class="encoder-eyebrow">Step 1 of 4</div>
      <h2 id="encoder-keep-heading" tabindex="-1">How much of your newest footage should stay exactly as recorded?</h2>
      <p class="encoder-lead">Your newest clips stay at full quality, so you can review and export them. Anything older than this gets shrunk to save space. Your cleanup rules still decide when footage is deleted.</p>
      <div class="encoder-chips" role="group" aria-label="Keep recent footage as recorded">
        ${noKeep ? '<button type="button" class="encoder-chip" data-keep="none" aria-label="No keep window">No keep window</button>' : ''}
        ${KEEP_CHIPS.map((n) => `<button type="button" class="encoder-chip" data-keep="${n}" aria-label="Keep the newest ${n} days as recorded">${n === 7 ? '1 week' : n === 14 ? '2 weeks' : `${n} days`}</button>`).join('')}
        <button type="button" class="encoder-chip" data-custom aria-label="Custom keep window" aria-controls="encoder-custom-keep">Custom</button>
      </div>
      <div id="encoder-custom-keep" class="encoder-custom-keep" ${customOpen ? '' : 'hidden'}>
        <label for="encoder-keep-days">Days to keep as recorded</label>
        <input id="encoder-keep-days" type="number" min="1" max="365" step="1" required value="${choice.keep ?? ''}" aria-describedby="encoder-keep-help">
        <small id="encoder-keep-help">Enter a whole number from 1 to 365.</small>
      </div>
      <section class="encoder-footage" aria-label="Your footage calendar">
        <div class="encoder-calendar-header"><h3>Your footage</h3>
          <ul class="encoder-legend" aria-label="Footage calendar legend">${Object.entries(DAY_LABELS).map(([state, label]) => `<li><i class="encoder-day-pattern ${state}" aria-hidden="true"></i>${label}</li>`).join('')}</ul>
          <div class="encoder-calendar-nav" role="group" aria-label="Browse footage months">
            <button type="button" data-month="-1" aria-label="Previous month">${icon('chevron_left')}</button>
            <button type="button" data-month="1" aria-label="Next month">${icon('chevron_right')}</button>
          </div>
        </div>
        <div class="encoder-cal-wrap" data-calendar></div>
      </section>
      <div class="encoder-summary" data-summary aria-live="polite" aria-atomic="true"></div>
      <p class="encoder-estimate-note">Day-level estimates across all clip kinds${total > days.length ? `, using the ${days.length} loaded days` : ''}. Actual savings depend on the kinds included and the footage.</p>
      <div class="encoder-subhead"><h3 id="encoder-order-heading">What gets shrunk first</h3><p>Matters most on the first run, when there's a lot to catch up on. Turn a kind off to keep it as recorded for good.</p></div>
      <ol class="encoder-order" data-order aria-labelledby="encoder-order-heading"></ol>
      <p class="encoder-estimate-note" id="encoder-order-help">At least one kind must stay included.</p>
    </section>
    <section data-encoder-step="2" hidden aria-labelledby="encoder-step-2-heading">
      <div class="encoder-eyebrow">Step 2 of 4</div><h2 id="encoder-step-2-heading" tabindex="-1">How much space should older footage save?</h2>
      <p class="encoder-lead">Choose how much space to save, then compare the picture on your own footage.</p>
      ${saved && levelOf(saved) === 'custom' ? `<div class="encoder-customized"><h3>Customized in Expert</h3>
        <p>${esc(expertSummary(saved))}</p>
        <div class="form-actions"><button type="button" data-keep-expert>Keep my Expert settings</button><button type="button" data-pick-level>Pick a level</button></div></div>` : ''}
      <div class="encoder-tiles" data-levels role="group" aria-label="Space to save"></div>
      <section class="encoder-cmp-card" data-cmp aria-labelledby="encoder-preview-heading">
        <div class="encoder-cmp-head"><h3 id="encoder-preview-heading">See it on your own clip</h3><small>Drag the line. The dashed box is shown up close.</small></div>
        <div class="encoder-cmp-toolbar"><div class="encoder-cmp-tabs" role="tablist" aria-label="Preview clip kind">
          ${['saved', 'sentry'].map((kind) => `<button type="button" role="tab" id="encoder-tab-${kind}" data-preview-kind="${kind}" aria-controls="encoder-preview-panel"><span class="encoder-group-dot ${kind}" aria-hidden="true"></span>${kind === 'saved' ? 'Saved' : 'Sentry'}</button>`).join('')}
        </div><button type="button" data-another>Try another clip</button></div>
        <div data-preview-status role="status" aria-live="polite"></div>
        <div id="encoder-preview-panel" role="tabpanel" tabindex="0" data-preview-body></div>
      </section>
      <div class="encoder-estimate" data-space-estimate></div>
    </section>
    <section data-encoder-step="3" hidden aria-labelledby="encoder-step-3-heading">
      <div class="encoder-eyebrow">Step 3 of 4</div><h2 id="encoder-step-3-heading" tabindex="-1">When should it shrink footage?</h2>
      <p class="encoder-lead">It runs by itself in the background. A scheduled check starts work; it doesn't promise to finish by a set time.</p>
      <div class="encoder-when" data-schedules role="group" aria-label="When to check"></div>
      <div class="encoder-schedule-line"><div class="encoder-picker" data-picker></div><small><span data-schedule-zone></span> One schedule for every vehicle that shrinks automatically.</small></div>
      ${otherVehicles.length ? `<p class="encoder-callout">Changing this also changes the schedule for ${esc(otherVehicles.join(', '))}.</p>` : ''}
      <div class="encoder-switches"><label class="encoder-switch"><input class="toggle-switch" type="checkbox" role="switch" data-off-peak><span><b>Only when electricity is cheapest</b><small>Uses the off-peak hours of your plan in Settings › Electricity price. <span data-schedule-help></span></small></span></label>
      <label class="encoder-switch"><input class="toggle-switch" type="checkbox" role="switch" data-catch-up><span><b>Finish the first catch-up run as soon as possible</b><small>The first run shrinks everything already older than your cut-off. With this on, it starts as soon as setup finishes and keeps going until done, ignoring the schedule and electricity hours. After that, only clips that age past the cut-off get shrunk, at the scheduled times.</small><small>Turning a vehicle back on, shortening its keep window, including another kind of clip or changing the space level can start another catch-up run. Pause holds until you press Resume.</small></span></label></div>
    </section>
    <section data-encoder-step="4" hidden aria-labelledby="encoder-step-4-heading">
      <div class="encoder-eyebrow">Step 4 of 4</div><h2 id="encoder-step-4-heading" tabindex="-1">Here's what will happen</h2>
      <p class="encoder-lead" data-plan></p><div class="encoder-review" data-review></div>
      <p class="encoder-callout" data-level-change hidden></p>
      <label class="encoder-switch encoder-ack"><input class="toggle-switch" type="checkbox" role="switch" data-ack required><span><b>Replace the originals with the smaller copies</b><small>Needed to free space. Each copy is checked against the original before the original is replaced.</small></span></label>
      <p class="encoder-callout encoder-info">${icon('info')}<span>Footage settings are saved for ${esc(vehicle.name)} only. Other vehicles keep their own; the schedule is shared. You can change anything later, or flip Expert for every detail.</span></p>
      <div class="encoder-callout" data-replacement hidden></div>
      <p class="encoder-problem" data-save-error role="alert" hidden></p>
    </section>
    <footer class="encoder-foot"><button type="button" data-back disabled>Back</button><button type="button" class="primary" data-continue>Continue</button><button type="button" class="primary" data-save hidden>Turn on automatic shrinking</button><button type="button" data-review-expert hidden>Open Expert</button></footer>
    </div>
    <p class="encoder-scope-note">Keep, space and clip choices apply to <b>${esc(vehicle.name)}</b>. The schedule is shared by every vehicle.</p>
  </div>`;

  const customInput = mount.querySelector('#encoder-keep-days');
  let scheduleChanged = false;
  const next = mount.querySelector('[data-continue]');
  function drawSchedule() {
    const scheduleZone = toAutoSettings(choice, zone, auto.settings, { scheduleChanged }).schedule?.zone || zone;
    mount.querySelector('[data-schedule-zone]').textContent = scheduleZone === zone
      ? `Your time zone (${zone}).` : `Schedule time zone (${scheduleZone}).`;
    mount.querySelector('[data-schedules]').innerHTML = Object.entries(SCHEDULES).map(([id, name]) => `<button type="button" class="encoder-when-card" data-when="${id}" aria-pressed="${choice.when === id}"><b>${name}${id !== 'asap' && choice.offPeak ? ', when electricity is cheapest' : ''}</b><small>${{ night: 'Best for most people', week: 'Choose a weekday', month: 'Choose a day of the month', asap: 'Checks every hour, any time' }[id]}</small></button>`).join('');
    const select = (key, label, values) => `<label>${label}<select data-timing="${key}">${values.map(([value, text]) => `<option value="${value}" ${choice[key] === value ? 'selected' : ''}>${text}</option>`).join('')}</select></label>`;
    mount.querySelector('[data-picker]').innerHTML = choice.when === 'custom'
      ? '<p>Customized in Expert. Your existing timing stays unchanged unless you choose a schedule above.</p>'
      : (choice.when === 'week' ? select('weekday', 'Weekday', WEEKDAYS.map((name, n) => [n, name])) : '') +
        (choice.when === 'month' ? select('day', 'Day of the month', Array.from({ length: 28 }, (_, i) => [i + 1, i + 1])) : '') +
        (!choice.offPeak && choice.when !== 'asap' ? select('hour', 'Start at', Array.from({ length: 24 }, (_, i) => [i, `${String(i).padStart(2, '0')}:00`])) : '');
    const offPeak = mount.querySelector('[data-off-peak]');
    offPeak.checked = choice.offPeak; offPeak.disabled = ['asap', 'custom'].includes(choice.when);
    mount.querySelector('[data-catch-up]').checked = choice.catchUp;
    mount.querySelector('[data-schedule-help]').textContent = choice.when === 'asap'
      ? 'As clips age checks every hour, any time, without an electricity window.'
      : choice.when === 'custom' ? 'Choose a guided schedule above to change the electricity window here.'
      : choice.offPeak ? 'Checks start when the cheap period begins. A running job pauses when it ends and resumes in the next cheap period, even with a weekly or monthly schedule.'
      : 'Once a job starts, it runs until done. It does not pause at a set hour.';
  }
  function nothingWaiting() {
    return choice.keep == null ? 'No footage is waiting to be shrunk yet.'
      : `Nothing older than the last ${choice.keep} ${choice.keep === 1 ? 'day' : 'days'} is waiting to be shrunk yet.`;
  }
  function drawReview() {
    const expertOnly = choice.level === 'custom' && saved?.outputMode !== 'replace';
    mount.querySelector('[data-plan]').textContent = planSentence(choice);
    const estimate = footageEstimate(days, choice.keep, vehicle.timezone, choice.level, today);
    const level = LEVELS.find((l) => l.id === choice.level);
    const order = choice.order.filter((g) => choice.included[g]);
    const excludedNames = choice.order.filter((g) => !choice.included[g]).map((g) => GROUPS[g].name);
    const codec = choice.level === 'custom' ? saved?.codec?.toUpperCase() : 'H.265';
    const device = choice.level === 'custom' ? '' : devices ? levelDevice(devices, choice.level).replace(/^Uses /, '') : '';
    const rows = [
      ['calendar_month', 'keep', choice.keep == null ? 'No keep window' : `Newest ${choice.keep} ${choice.keep === 1 ? 'day stays' : 'days stay'} as recorded`, `${size(estimate.kept)} right now · day-level estimate`, 1],
      ['hard_drive', 'space', level ? `${level.name}: about ${level.pct}% smaller` : 'Customized in Expert', level ? estimate.shrink === 0 ? nothingWaiting() : `Gets back about ${size(estimate.saved)} from ${size(estimate.shrink)} of older footage · estimate across all clip kinds` : expertSummary(saved), 2],
      ['conversion_path', 'order', `Order: ${order.map((g) => GROUPS[g].name.replace(' clips', '')).join(' → ')}`, excludedNames.length ? `${excludedNames.join(' and ')} stay as recorded` : order[0] === 'SavedClips' ? 'Saved clips are done first, so your important moments shrink first' : `${GROUPS[order[0]].name} are done first`, 1],
      ['schedule', 'schedule', scheduleText(choice), choice.catchUp ? 'Catch-up starts as soon as setup finishes.' : 'Catch-up follows the schedule and electricity hours.', 3],
      ['shield', '', 'Safe by default', `Telemetry kept · each copy checked before an original is replaced${codec ? ` · ${codec}` : ''}${device ? ` on ${device}` : ''}`, 0],
    ];
    mount.querySelector('[data-review]').innerHTML = rows.map(([glyph, label, text, detail, target]) => `<div class="encoder-review-row"><span class="encoder-review-icon" aria-hidden="true">${icon(glyph)}</span><div><b>${esc(text)}</b><small>${esc(detail)}</small></div>${target ? `<button type="button" class="ghost" data-edit="${target}" aria-label="Edit ${label}" ${saving ? 'disabled' : ''}>Edit</button>` : ''}</div>`).join('');
    const change = mount.querySelector('[data-level-change]');
    change.hidden = !saved || levelOf(saved) !== 'custom' || choice.level === 'custom';
    change.textContent = `Picking a level changes your Expert encoding to H.265 with the selected space target, removes custom bitrate, quality and larger-result settings, and replaces the originals. Other settings, including device lanes and verification, stay as saved.`;
    const notice = mount.querySelector('[data-replacement]');
    notice.hidden = !replacementUnavailable && !expertOnly && acknowledged;
    notice.textContent = replacementUnavailable
      ? 'This storage cannot safely replace the originals. Automatic shrinking needs replacement to free space. Open Expert to set up separate copies instead.'
      : !expertOnly ? 'Turn on replacing to free space; automatic shrinking needs it.'
      : 'Separate copies stay in Expert because they need a destination and do not free space on this share. Open Expert to keep these settings, or pick a space level to replace originals.';
    const ack = mount.querySelector('[data-ack]');
    ack.checked = acknowledged; ack.disabled = saving || replacementUnavailable || expertOnly;
    const button = mount.querySelector('[data-save]');
    button.hidden = step !== 4 || replacementUnavailable || expertOnly;
    button.disabled = !acknowledged || !capabilitiesReady || saving;
    button.textContent = saving ? 'Saving…' : 'Turn on automatic shrinking';
    mount.querySelector('[data-review-expert]').hidden = step !== 4 || (!replacementUnavailable && !expertOnly);
    const error = mount.querySelector('[data-save-error]'); error.hidden = !saveError; error.textContent = saveError;
  }
  let devices = null;
  let previewId = null, previewOwner = null, previewTimer = null, previewGeneration = 0;
  let previewWasCancelled = false;
  let previewState = 'idle', waitingFor = null, previewError = '', previewKind = 'saved', requestedKind = null;
  let previewClips = {}, progress = null, split = 50, pausePending = false;
  let previewStartedAt = null, elapsedTimer = null;
  const excluded = new Set();
  const previewBody = mount.querySelector('[data-preview-body]');
  const previewStatus = mount.querySelector('[data-preview-status]');
  let previewStatusMarkup = '';
  function drawElapsed() {
    const elapsed = previewStatus.querySelector('[data-preview-elapsed]');
    if (elapsed) elapsed.textContent = Math.floor((Date.now() - previewStartedAt) / 1000);
  }
  function drawLevels() {
    mount.querySelector('[data-levels]').innerHTML = LEVELS.map((level) => `<button type="button" class="encoder-tile" data-level="${level.id}" aria-pressed="${choice.level === level.id}">
      <span class="encoder-tile-title">${level.name}${level.rec ? '<span class="encoder-recommended">Recommended</span>' : ''}</span>
      <span class="encoder-pct"><small>about</small> ${level.pct}% <small>smaller</small></span>
      <span class="encoder-bars"><span>Typical space used</span><span class="encoder-bar"><i style="width:100%"></i></span><span class="encoder-bar after"><i style="width:${100 - level.pct}%"></i></span><span>Original → about ${100 - level.pct}% of its size</span></span>
      <span class="encoder-quality" aria-label="Picture quality: ${QUALITY[level.id].dots} out of 5">Picture ${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= QUALITY[level.id].dots ? 'filled' : ''}" aria-hidden="true"></i>`).join('')}</span>
      <span class="encoder-quality-note">${QUALITY[level.id].note}</span><span class="encoder-device">${esc(levelDevice(devices, level.id))}</span><small>Typical results, not a promise</small>
    </button>`).join('') + `<button type="button" class="encoder-tile" data-open-expert aria-pressed="${choice.level === 'custom'}"><span class="encoder-tile-title">Custom</span>${icon('tune')}<span>Pick the codec, quality or bitrate yourself</span><small>Opens Expert</small></button>`;
    mount.querySelector('[data-keep-expert]')?.setAttribute('aria-pressed', String(choice.level === 'custom'));
    const estimate = footageEstimate(days, choice.keep, vehicle.timezone, choice.level, today);
    const level = LEVELS.find((l) => l.id === choice.level);
    mount.querySelector('[data-space-estimate]').innerHTML = estimate.shrink === 0 ? `<p>${esc(nothingWaiting())}</p>` : level ? `<div class="encoder-stat encoder-stat-saved"><b>${size(estimate.saved)}</b><span>you get back · estimate</span></div><div><div class="encoder-estimate-labels"><span>Older footage now: <b>${size(estimate.shrink)}</b></span><span>After: <b>${size(estimate.after)}</b></span></div><div class="encoder-space-bar" role="img" aria-label="Estimated ${level.pct}% saved"><i style="width:${100 - level.pct}%"></i><i style="width:${level.pct}%"></i></div><small>Based on ${level.name}'s typical ${level.pct}% saving across all clip kinds${total > days.length ? ` in the ${days.length} loaded days` : ''}. Actual savings depend on the kinds included and the footage.</small></div>` : '<div><b>Custom</b><p>Choose a guided level to estimate the space you get back. Your Expert settings are kept.</p></div>';
  }
  function drawPreview() {
    mount.querySelector('[data-cmp]').dataset.state = previewState;
    const busy = ['starting', 'waiting', 'running'].includes(previewState);
    const clip = previewClips[previewKind];
    const results = clip?.results || [];
    const original = results.find((result) => result.level === 'orig');
    const selected = results.find((result) => result.level === choice.level);
    const name = LEVELS.find((level) => level.id === choice.level)?.name;
    mount.querySelectorAll('[data-preview-kind]').forEach((tab) => {
      const active = tab.dataset.previewKind === previewKind;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    });
    previewBody.setAttribute('aria-labelledby', `encoder-tab-${previewKind}`);
    mount.querySelector('[data-another]').disabled = busy || !clip;
    let status = '';
    if (busy) {
      const stages = previewProgress(progress, requestedKind || previewKind, vehicle.timezone);
      const waiting = previewState === 'waiting';
      status = `${waiting ? `<p>${waitingFor === 'benchmark' ? 'Waiting for the device benchmark to finish.' : waitingFor === 'conversion' ? 'Waiting for the current shrinking run to finish.' : 'Waiting for an encoder to become available.'}</p>` : ''}
        <ol class="encoder-preview-steps">${stages.steps.map((s) => `<li class="${s.done ? 'done' : s.active && !waiting ? 'active' : ''}"><span class="encoder-preview-mark" aria-hidden="true">${s.done ? '✓' : '·'}</span>${esc(s.text)}</li>`).join('')}</ol>
        <progress max="5" value="${stages.done}" aria-label="Preview steps completed for this clip"></progress><p class="encoder-estimate-note">${stages.done} of 5 steps for this clip · <span data-preview-elapsed></span> seconds elapsed</p>
        ${waiting && waitingFor === 'conversion' ? `<button type="button" data-pause-preview ${pausePending ? 'disabled' : ''}>${pausePending ? 'Pausing conversion…' : 'Pause conversion and preview now'}</button>` : ''}`;
    }
    else if (previewState === 'failed') {
      const error = previewFailure(previewError);
      status = `<p>${esc(error.message)}</p>${error.detail ? `<small class="encoder-error-detail">Detail: ${esc(error.detail)}</small>` : ''}<button type="button" data-retry-preview>Try preview again</button>`;
    }
    else if (previewState === 'cancelled') status = '<p>Preview cancelled.</p><button type="button" data-retry-preview>Try preview again</button>';
    else if (!Object.keys(previewClips).length) status = '<p>No Saved or Sentry clips to preview yet.</p>';
    // Avoid re-announcing unchanged status and replacing focused buttons on every poll.
    if (previewStatusMarkup !== status) { previewStatusMarkup = status; previewStatus.innerHTML = status; }
    drawElapsed();
    let body = '';
    if (clip && choice.level === 'custom') body = '<p>Your Expert settings are kept. Pick Standard, Medium or High to compare the guided levels; this preview does not measure your custom settings.</p>';
    else if (original && selected) {
      body = `<div class="encoder-preview-source"><span class="encoder-review-icon" aria-hidden="true">${icon('videocam')}</span><span>${esc(previewSource(clip, selected, vehicle.timezone))}</span></div>
        <div class="encoder-cmp-grid"><div class="encoder-cmp" data-cmpdrag style="--split:${split}%">
          <img src="${esc(original.frame)}" alt="Original frame" data-original-frame><img class="encoder-after" src="${esc(selected.frame)}" alt="${name} frame">
          <span class="encoder-zoom-box" hidden></span><span class="encoder-cmp-handle" aria-hidden="true"></span><span class="encoder-cmp-tag original">Original</span><span class="encoder-cmp-tag selected">${name}</span>
          <input class="encoder-cmp-range" type="range" min="0" max="100" value="${split}" aria-label="Compare original and shrunk frame" aria-valuetext="${split}% original">
        </div><div class="encoder-zooms">${[[original, 'Original'], [selected, name]].map(([result, label]) => `<figure class="encoder-zoom ${result.level === 'orig' ? '' : 'selected'}"><img src="${esc(result.zoom)}" alt="${label}, up close"><figcaption><b>${label}</b><span>${esc(previewMegabytes(result.after_bytes))}${result.level === 'orig' ? '' : ` · ${previewPercent(result.saved_percent)}`}</span></figcaption></figure>`).join('')}</div></div>
        <p class="encoder-measured">${esc(previewMeasured(results)).replace(/\d+%(?: larger)?/g, '<b>$&</b>')} The cards above show what to expect on average. Parked clips shrink more than driving ones.</p>`;
    } else if (!busy && Object.keys(previewClips).length) body = `<p>No ${previewKind === 'saved' ? 'Saved' : 'Sentry'} clips to preview${requestedKind === previewKind ? ' besides those already shown' : ''}.</p>`;
    const key = JSON.stringify([clip, choice.level, busy, requestedKind]);
    if (previewBody.dataset.key === key) return;
    previewBody.dataset.key = key;
    previewBody.innerHTML = body;
    const frame = previewBody.querySelector('[data-original-frame]');
    if (frame) {
      const placeCrop = () => {
        if (!frame.naturalWidth || !frame.isConnected) return;
        const comparison = frame.closest('[data-cmpdrag]');
        comparison.style.aspectRatio = `${frame.naturalWidth} / ${frame.naturalHeight}`;
        const crop = original.crop, box = comparison.querySelector('.encoder-zoom-box');
        if (!crop) return;
        Object.assign(box.style, { left: `${100 * crop.x / frame.naturalWidth}%`, top: `${100 * crop.y / frame.naturalHeight}%`, width: `${100 * crop.width / frame.naturalWidth}%`, height: `${100 * crop.height / frame.naturalHeight}%` });
        box.hidden = false;
      };
      frame.onload = placeCrop;
      if (frame.complete) placeCrop();
    }
  }
  function cancelPreview() {
    if (previewId || previewState === 'starting') previewWasCancelled = true;
    previewGeneration++;
    clearTimeout(previewTimer); previewTimer = null;
    clearInterval(elapsedTimer); elapsedTimer = null;
    previewOwner?.abort(); previewOwner = null;
    const id = previewId; previewId = null;
    // The page scope is already aborted during navigation. Cleanup must still reach the server.
    if (id) cancelPreviewId(id);
  }
  async function startPreview({ another = false, pause = false } = {}) {
    if (step !== 2 || !ctx.alive()) return;
    if (!pause) {
      cancelPreview();
      if (another && previewClips[previewKind]) excluded.add(previewClips[previewKind].eventId);
      requestedKind = another ? previewKind : null;
      if (another) delete previewClips[previewKind]; else previewClips = {};
      progress = null; previewState = 'starting'; previewError = ''; pausePending = false; previewStartedAt = Date.now();
      elapsedTimer = setInterval(drawElapsed, 1000);
      previewOwner = scope([], { signal: ctx.scope.signal });
      onPreview((event) => {
        if (event.id !== previewId || step !== 2) return;
        if (event.state) { previewState = event.state; waitingFor = event.waitingFor; }
        if (event.phase) {
          // Older servers send individual phases; newer ones also retain measured levels.
          if (event.eventId !== progress?.eventId) progress = {results:{}};
          progress = {...progress, ...event, results:{...progress?.results, ...event.results, ...(event.result ? {[event.result.level]:event.result} : {})}};
        }
        drawPreview();
      }, previewOwner);
    } else {
      pausePending = true;
      previewGeneration++;
      clearTimeout(previewTimer);
    }
    drawPreview();
    const generation = previewGeneration;
    const valid = () => generation === previewGeneration && step === 2 && ctx.alive();
    try {
      if (!pause) await streamReady(previewOwner);
      if (!valid()) return;
      // Do not abort the start response: if navigation wins, we still need its id to cancel it.
      const payload = { vehicleId: vehicle.id, exclude: [...excluded], ...(pause ? { pauseConversion: true } : {}) };
      let started;
      try {
        started = await previewInvoke('previewStart', payload);
      } catch (error) {
        if (pause || !previewWasCancelled || !valid() || (error.code || error.message) !== 'PREVIEW_ACTIVE') throw error;
        // A running worker releases its slot after cancellation has unwound.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!valid()) return;
        started = await previewInvoke('previewStart', payload);
      }
      const { id } = started;
      if (!valid()) { cancelPreviewId(id); return; }
      previewWasCancelled = false;
      previewId = id;
      clearTimeout(previewTimer);
      const poll = async () => {
        try {
          const answer = await invoke('previewGet', { id });
          if (!valid()) return;
          previewState = answer.state; waitingFor = answer.waitingFor;
          if (answer.progress) progress = answer.progress;
          if (answer.error) previewError = answer.error;
          if (['failed', 'cancelled'].includes(previewState)) {
            // The server revokes this preview's image URLs on failure/cancellation.
            if (requestedKind) delete previewClips[requestedKind]; else previewClips = {};
          }
          for (const clip of answer.clips || []) {
            if (!['saved', 'sentry'].includes(clip.kind) || (requestedKind && clip.kind !== requestedKind)) continue;
            previewClips[clip.kind] = clip;
          }
          if (!requestedKind && !previewClips[previewKind] && previewClips.sentry) previewKind = 'sentry';
          drawPreview();
          if (['waiting', 'running'].includes(previewState)) previewTimer = setTimeout(poll, 1500);
        } catch (error) {
          if (valid()) { previewState = 'failed'; previewError = error.message; drawPreview(); }
        }
      };
      await poll();
    } catch (error) {
      if (valid()) { pausePending = false; previewState = 'failed'; previewError = error.message; drawPreview(); }
    }
  }
  function drawChips() {
    mount.querySelectorAll('[data-keep]').forEach((button) => {
      const selected = button.dataset.keep === 'none' ? choice.keep == null : !customOpen && Number(button.dataset.keep) === choice.keep;
      button.setAttribute('aria-pressed', String(selected));
    });
    const custom = mount.querySelector('[data-custom]');
    custom.setAttribute('aria-pressed', String(customOpen && choice.keep != null));
    custom.setAttribute('aria-expanded', String(customOpen));
    mount.querySelector('#encoder-custom-keep').hidden = !customOpen;
    customInput.disabled = !customOpen;
    customInput.setAttribute('aria-invalid', String(customOpen && !customInput.validity.valid));
    next.disabled = step === 1 && customOpen && !customInput.validity.valid;
  }
  function drawFootage() {
    const states = dayStates(days, choice.keep, vehicle.timezone, today);
    const previous = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const visibleMonths = [...(phoneCalendar.matches ? [] : [previous]), month.toISOString().slice(0, 7)];
    const cap = Math.max(0, ...days.filter((d) => visibleMonths.includes(d.day.slice(0, 7))).map((d) => Number(d.bytes) || 0));
    mount.querySelector('[data-calendar]').innerHTML = [-1, 0].map((offset) => {
      const date = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + offset, 1));
      const label = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      const prefix = date.toISOString().slice(0, 7);
      const first = (date.getUTCDay() + 6) % 7;
      const count = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      const cells = Array.from({ length: Math.ceil((first + count) / 7) * 7 }, (_, i) => {
        const d = i - first + 1;
        if (d < 1 || d > count) return '<td></td>';
        const key = `${prefix}-${String(d).padStart(2, '0')}`;
        const state = states.get(key) || 'none';
        const description = `${key}${key === today ? ', Today' : ''}: ${DAY_LABELS[state]}${byDay.has(key) ? `, ${size(byDay.get(key).bytes)}` : ''}`;
        return `<td><span class="encoder-day encoder-day-pattern ${state}${key > today ? ' future' : ''}" style="--a:${dayHeat(byDay.get(key)?.bytes, cap)}" role="img" aria-label="${esc(description)}" title="${esc(description)}" ${key === today ? 'aria-current="date"' : ''}>${d}</span></td>`;
      });
      const rows = [];
      for (let i = 0; i < cells.length; i += 7) rows.push(`<tr>${cells.slice(i, i + 7).join('')}</tr>`);
      return `<table class="encoder-cal ${offset === -1 ? 'encoder-cal-previous' : ''}" aria-label="${label} footage"><caption>${label}</caption><thead><tr>${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day) => `<th scope="col" abbr="${day}">${day.slice(0, 1)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
    }).join('');
    mount.querySelector('[data-month="1"]').disabled = month.toISOString().slice(0, 10) >= currentMonth;
    const sums = footageEstimate(days, choice.keep, vehicle.timezone, choice.level, today);
    mount.querySelector('[data-summary]').innerHTML = `<div class="encoder-stat"><b>${size(sums.kept)}</b><span>${choice.keep == null ? 'no keep window' : `from the last ${choice.keep} ${choice.keep === 1 ? 'day' : 'days'} stays as recorded`}</span></div>
      <div class="encoder-stat encoder-stat-shrink"><b>${size(sums.shrink)}</b><span>older footage that will be shrunk</span></div>`;
  }
  function drawOrder() {
    const included = choice.order.filter((group) => choice.included[group]);
    mount.querySelector('[data-order]').innerHTML = choice.order.map((group, i) => {
      const info = GROUPS[group], on = choice.included[group];
      return `<li class="encoder-ord${on ? '' : ' off'}" data-group="${group}">
        <span class="encoder-pos" aria-hidden="true">${on ? included.indexOf(group) + 1 : '–'}</span><span class="encoder-group-dot ${info.color}" aria-hidden="true"></span>
        <div class="encoder-group-copy"><b>${info.name}</b><span>${on ? info.description : 'Kept as recorded, never shrunk'}</span></div>
        <div class="encoder-move"><button type="button" data-move="${group}" data-direction="-1" aria-label="Move ${info.name} up" ${i === 0 ? 'disabled' : ''}>${icon('expand_more')}</button><button type="button" data-move="${group}" data-direction="1" aria-label="Move ${info.name} down" ${i === choice.order.length - 1 ? 'disabled' : ''}>${icon('expand_more')}</button></div>
        <label class="encoder-include"><input class="toggle-switch" type="checkbox" role="switch" data-include="${group}" aria-label="Shrink ${info.name}" aria-describedby="encoder-order-help" ${on ? 'checked' : ''} ${on && included.length === 1 ? 'disabled' : ''}></label>
      </li>`;
    }).join('');
  }
  function showStep() {
    if (step !== 2) cancelPreview();
    mount.querySelectorAll('[data-encoder-step]').forEach((panel) => {
      panel.hidden = Number(panel.dataset.encoderStep) !== step;
    });
    mount.querySelectorAll('.encoder-stepper li').forEach((item, i) => {
      if (i + 1 === step) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
      item.classList.toggle('complete', i + 1 < step);
      item.querySelector('.encoder-step-number').textContent = i + 1 < step ? '✓' : i + 1;
    });
    mount.querySelector('[data-back]').disabled = step === 1 || saving;
    next.hidden = step === STEPS.length;
    drawChips();
    if (step === 1) drawFootage();
    if (step === 2) { drawLevels(); startPreview(); }
    if (step === 3) drawSchedule();
    drawReview();
    mount.querySelector(`[data-encoder-step="${step}"] h2`).focus();
  }
  mount.querySelector('.encoder-chips').onclick = (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    customOpen = button.hasAttribute('data-custom');
    if (!customOpen) choice.keep = button.dataset.keep === 'none' ? null : Number(button.dataset.keep);
    customInput.value = choice.keep ?? '';
    drawChips();
    drawFootage();
    if (customOpen) customInput.focus();
  };
  customInput.oninput = () => {
    if (customInput.validity.valid) choice.keep = customInput.valueAsNumber;
    drawChips();
    drawFootage();
  };
  mount.querySelector('.encoder-calendar-nav').onclick = (event) => {
    const button = event.target.closest('[data-month]');
    if (!button || button.disabled) return;
    month.setUTCMonth(month.getUTCMonth() + Number(button.dataset.month));
    drawFootage();
  };
  mount.querySelector('[data-order]').onclick = (event) => {
    const button = event.target.closest('[data-move]');
    if (!button || button.disabled) return;
    const index = choice.order.indexOf(button.dataset.move);
    const target = index + Number(button.dataset.direction);
    [choice.order[index], choice.order[target]] = [choice.order[target], choice.order[index]];
    drawOrder();
    const replacement = mount.querySelector(`[data-move="${button.dataset.move}"][data-direction="${button.dataset.direction}"]`);
    (replacement.disabled ? mount.querySelector(`[data-move="${button.dataset.move}"]:not(:disabled)`) : replacement).focus();
  };
  mount.querySelector('[data-order]').onchange = (event) => {
    const input = event.target.closest('[data-include]');
    if (!input) return;
    choice.included[input.dataset.include] = input.checked;
    drawOrder();
    mount.querySelector(`[data-include="${input.dataset.include}"]`).focus();
  };
  mount.querySelector('[data-back]').onclick = () => { if (step > 1) { step--; showStep(); } };
  next.onclick = () => { if (!next.disabled && step < STEPS.length) { step++; showStep(); } };
  mount.querySelector('[data-schedules]').onclick = (event) => {
    const button = event.target.closest('[data-when]');
    if (!button) return;
    choice.when = button.dataset.when;
    scheduleChanged = true;
    if (choice.when === 'asap') choice.offPeak = false;
    drawSchedule(); mount.querySelector(`[data-when="${choice.when}"]`).focus();
  };
  mount.querySelector('[data-picker]').onchange = (event) => {
    const key = event.target.dataset.timing;
    if (key) {
      choice[key] = Number(event.target.value); scheduleChanged = true; drawSchedule();
      mount.querySelector(`[data-timing="${key}"]`).focus();
    }
  };
  mount.querySelector('[data-off-peak]').onchange = (event) => { choice.offPeak = event.target.checked; scheduleChanged = true; drawSchedule(); };
  mount.querySelector('[data-catch-up]').onchange = (event) => { choice.catchUp = event.target.checked; scheduleChanged = true; drawSchedule(); };
  mount.querySelector('[data-review]').onclick = (event) => {
    const button = event.target.closest('[data-edit]');
    if (button && !saving) { step = Number(button.dataset.edit); showStep(); }
  };
  mount.querySelector('[data-ack]').onchange = (event) => { acknowledged = event.target.checked; drawReview(); };
  mount.querySelector('[data-review-expert]').onclick = openExpert;
  mount.querySelector('[data-save]').onclick = async () => {
    if (saving || !acknowledged || replacementUnavailable || !capabilitiesReady) return;
    saving = true; saveError = ''; drawReview(); mount.querySelector('[data-back]').disabled = true;
    try {
      const current = await invoke('getAuto');
      const existing = current.settings?.configs?.find((c) => c.sourceRoot === root) || current.saved?.find((c) => c.sourceRoot === root);
      const config = toVehicleConfig(choice, vehicle, existing);
      const shared = toAutoSettings(choice, zone, current.settings, { scheduleChanged });
      await invoke('saveVehicle', { config });
      const updated = await invoke('setAuto', { enabled: true, ...shared, config });
      if (ctx.alive()) await show(updated);
    } catch (error) {
      if (!ctx.alive()) return;
      saveError = errorText(error);
      if (error.code === 'REPLACEMENT_UNAVAILABLE' || saveError.includes('REPLACEMENT_UNAVAILABLE')) replacementUnavailable = true;
    } finally {
      if (ctx.alive()) { saving = false; drawReview(); mount.querySelector('[data-back]').disabled = false; }
    }
  };
  mount.querySelector('[data-levels]').onclick = (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-open-expert')) {
      openExpert();
      return;
    }
    choice.level = button.dataset.level;
    drawLevels(); drawPreview();
    mount.querySelector(`[data-level="${choice.level}"]`).focus();
  };
  mount.querySelector('[data-keep-expert]')?.addEventListener('click', () => {
    choice.level = 'custom'; drawLevels(); drawPreview();
  });
  mount.querySelector('[data-pick-level]')?.addEventListener('click', () => mount.querySelector('[data-level="med"]').focus());
  mount.querySelector('[data-cmp]').onclick = (event) => {
    const tab = event.target.closest('[data-preview-kind]');
    if (tab) { previewKind = tab.dataset.previewKind; drawPreview(); }
    else if (event.target.closest('[data-another]')) startPreview({ another: true });
    else if (event.target.closest('[data-pause-preview]')) startPreview({ pause: true });
    else if (event.target.closest('[data-retry-preview]')) startPreview();
  };
  mount.querySelector('.encoder-cmp-tabs').onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    previewKind = event.key === 'Home' ? 'saved' : event.key === 'End' ? 'sentry' : previewKind === 'saved' ? 'sentry' : 'saved';
    drawPreview(); mount.querySelector(`[data-preview-kind="${previewKind}"]`).focus();
  };
  previewBody.oninput = (event) => {
    if (!event.target.matches('.encoder-cmp-range')) return;
    split = Number(event.target.value);
    event.target.closest('[data-cmpdrag]').style.setProperty('--split', `${split}%`);
    event.target.setAttribute('aria-valuetext', `${split}% original`);
  };
  const onPageHide = () => cancelPreview();
  const resizeCalendar = () => { if (ctx.alive() && step === 1) drawFootage(); };
  phoneCalendar.addEventListener('change', resizeCalendar);
  window.addEventListener('pagehide', onPageHide);
  ctx.scope.signal.addEventListener('abort', cancelPreview, { once: true });
  invoke('devices').then((answer) => {
    devices = answer; if (ctx.alive()) drawLevels();
  }).catch(() => { /* Unknown hardware keeps the honest CPU fallback. */ });
  drawLevels();
  drawChips();
  drawFootage();
  drawOrder();
  invoke('getCapabilities').then((answer) => {
    if (!ctx.alive()) return;
    replacementUnavailable = answer.replacement === 'unavailable'; capabilitiesReady = true; drawReview();
  }).catch((error) => {
    if (!ctx.alive()) return;
    // An older server may not publish capabilities. The save still enforces replacement.
    capabilitiesReady = true; saveError = errorText(error); drawReview();
  });
  if (editing) showStep();
  return () => {
    cancelPreview();
    phoneCalendar.removeEventListener('change', resizeCalendar);
    window.removeEventListener('pagehide', onPageHide);
    ctx.scope.signal.removeEventListener('abort', cancelPreview);
  };
}
