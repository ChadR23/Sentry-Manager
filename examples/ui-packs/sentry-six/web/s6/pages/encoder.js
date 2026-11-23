import { esc } from '../core.js';
import { icon } from '../icons.js';
import { size } from '../format.js';
import { KEEP_CHIPS, LEVELS, fromSaved, dayStates } from '../encoderModel.js';

const GROUPS = {
  SavedClips: { name: 'Saved clips', description: 'Clips you saved with the horn, your voice or the screen', color: 'saved' },
  SentryClips: { name: 'Sentry clips', description: 'Recorded while parked, when something moved near the car', color: 'sentry' },
  RecentClips: { name: 'Recent clips', description: 'Everything else the car records while driving', color: 'driving' },
};
const DAY_LABELS = { kept: 'Kept as recorded', shrink: 'Will be shrunk', done: 'Already shrunk', none: 'No footage' };
const STEPS = ['Keep', 'Space', 'Schedule', 'Review'];

export async function render(mount, ctx) {
  const { invoke, api } = ctx.scope;
  const vehicle = ctx.current();
  mount.className = 'encoder-setup';
  if (!vehicle) {
    mount.innerHTML = '<section class="card"><h2>Add your first vehicle to get started.</h2><a class="btn primary" href="#/settings/vehicles">Add a vehicle</a></section>';
    return;
  }
  mount.innerHTML = '<p role="status">Loading encoder setup…</p>';
  const auto = await invoke('getAuto');
  if (!ctx.alive()) return;
  const root = vehicle.studioRoot || vehicle.root;
  const config = auto.settings?.configs?.find((entry) => entry.sourceRoot === root);
  if (config) {
    mount.innerHTML = `<section class="card encoder-status" data-encoder-screen="status">
      <span class="encoder-status-icon" aria-hidden="true">${icon('check_circle')}</span>
      <div><div class="encoder-eyebrow">Automatic shrinking</div>
        <h2>${esc(vehicle.name)} is set up.</h2>
        <p>Your automatic shrinking setup for this vehicle is saved.</p>
      </div>
    </section>`;
    return;
  }
  const saved = auto.saved?.find((entry) => entry.sourceRoot === root);
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
  let step = 1;
  let customOpen = choice.keep != null && !KEEP_CHIPS.includes(choice.keep);
  const noKeep = choice.keep == null;
  const byDay = new Map(days.map((day) => [day.day, day]));

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
          <div class="encoder-calendar-nav" role="group" aria-label="Browse footage months">
            <button type="button" data-month="-1" aria-label="Previous month">${icon('chevron_left')}</button>
            <button type="button" data-month="1" aria-label="Next month">${icon('chevron_right')}</button>
          </div>
        </div>
        <ul class="encoder-legend" aria-label="Footage calendar legend">${Object.entries(DAY_LABELS).map(([state, label]) => `<li><i class="encoder-day-pattern ${state}" aria-hidden="true"></i>${label}</li>`).join('')}</ul>
        <div class="encoder-cal-wrap" data-calendar></div>
      </section>
      <div class="encoder-summary" data-summary aria-live="polite" aria-atomic="true"></div>
      <p class="encoder-estimate-note">Day-level estimates across all clip kinds${total > days.length ? `, using the ${days.length} loaded days` : ''}. Actual savings depend on the kinds included and the footage.</p>
      <div class="encoder-subhead"><h3 id="encoder-order-heading">What gets shrunk first</h3><p>Matters most on the first run, when there's a lot to catch up on. Turn a kind off to keep it as recorded for good.</p></div>
      <ol class="encoder-order" data-order aria-labelledby="encoder-order-heading"></ol>
      <p class="encoder-estimate-note" id="encoder-order-help">At least one kind must stay included.</p>
    </section>
    ${['How much space should older footage save?', 'When should shrinking happen?', 'Review your setup'].map((heading, i) => `<section data-encoder-step="${i + 2}" hidden aria-labelledby="encoder-step-${i + 2}-heading"><div class="encoder-eyebrow">Step ${i + 2} of 4</div><h2 id="encoder-step-${i + 2}-heading" tabindex="-1">${heading}</h2></section>`).join('')}
    <footer class="encoder-foot"><button type="button" data-back disabled>Back</button><button type="button" class="primary" data-continue>Continue</button></footer>
    </div>
    <p class="encoder-scope-note">Keep, space and clip choices apply to <b>${esc(vehicle.name)}</b>. The schedule is shared by every vehicle.</p>
  </div>`;

  const customInput = mount.querySelector('#encoder-keep-days');
  const next = mount.querySelector('[data-continue]');
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
        return `<td><span class="encoder-day encoder-day-pattern ${state}${key > today ? ' future' : ''}" role="img" aria-label="${esc(description)}" title="${esc(description)}" ${key === today ? 'aria-current="date"' : ''}>${d}</span></td>`;
      });
      const rows = [];
      for (let i = 0; i < cells.length; i += 7) rows.push(`<tr>${cells.slice(i, i + 7).join('')}</tr>`);
      return `<table class="encoder-cal ${offset === -1 ? 'encoder-cal-previous' : ''}" aria-label="${label} footage"><caption>${label}</caption><thead><tr>${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day) => `<th scope="col" abbr="${day}">${day.slice(0, 1)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
    }).join('');
    mount.querySelector('[data-month="1"]').disabled = month.toISOString().slice(0, 10) >= currentMonth;
    const sums = { kept: 0, shrink: 0 };
    for (const day of days) {
      const state = states.get(day.day);
      if (state in sums) sums[state] += Number(day.bytes) || 0;
    }
    const level = LEVELS.find((entry) => entry.id === choice.level);
    mount.querySelector('[data-summary]').innerHTML = `<div class="encoder-stat"><b>${size(sums.kept)}</b><span>Kept as recorded</span></div>
      <div class="encoder-stat encoder-stat-shrink"><b>${size(sums.shrink)}</b><span>Will be shrunk</span></div>
      <div class="encoder-stat"><b>${level ? `About ${size(sums.shrink * level.pct / 100)}` : 'Not estimated'}</b><span>${level ? `freed at ${level.name}` : 'with Expert settings'} <small>· estimate</small></span></div>`;
  }
  function drawOrder() {
    const included = choice.order.filter((group) => choice.included[group]);
    mount.querySelector('[data-order]').innerHTML = choice.order.map((group, i) => {
      const info = GROUPS[group], on = choice.included[group];
      return `<li class="encoder-ord${on ? '' : ' off'}" data-group="${group}">
        <span class="encoder-pos" aria-hidden="true">${on ? included.indexOf(group) + 1 : '–'}</span><span class="encoder-group-dot ${info.color}" aria-hidden="true"></span>
        <div class="encoder-group-copy"><b>${info.name}</b><span>${on ? info.description : 'Kept as recorded, never shrunk'}</span></div>
        <div class="encoder-move"><button type="button" data-move="${group}" data-direction="-1" aria-label="Move ${info.name} up" ${i === 0 ? 'disabled' : ''}>${icon('expand_more')}</button><button type="button" data-move="${group}" data-direction="1" aria-label="Move ${info.name} down" ${i === choice.order.length - 1 ? 'disabled' : ''}>${icon('expand_more')}</button></div>
        <input class="toggle-switch" type="checkbox" role="switch" data-include="${group}" aria-label="Shrink ${info.name}" aria-describedby="encoder-order-help" ${on ? 'checked' : ''} ${on && included.length === 1 ? 'disabled' : ''}>
      </li>`;
    }).join('');
  }
  function showStep() {
    mount.querySelectorAll('[data-encoder-step]').forEach((panel) => {
      panel.hidden = Number(panel.dataset.encoderStep) !== step;
    });
    mount.querySelectorAll('.encoder-stepper li').forEach((item, i) => {
      if (i + 1 === step) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    mount.querySelector('[data-back]').disabled = step === 1;
    next.hidden = step === STEPS.length;
    drawChips();
    if (step === 1) drawFootage();
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
  drawChips();
  drawFootage();
  drawOrder();
}
