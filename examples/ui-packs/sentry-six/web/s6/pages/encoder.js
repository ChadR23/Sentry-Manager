import { esc } from '../core.js';
import { icon } from '../icons.js';

export async function render(mount, ctx) {
  const { invoke } = ctx.scope;
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
  mount.innerHTML = `<div data-encoder-screen="wizard">
    <ol class="encoder-stepper" aria-label="Encoder setup steps">
      ${['Keep', 'Space', 'Schedule', 'Review'].map((label, i) => `<li ${i === 0 ? 'aria-current="step"' : ''}><span class="encoder-step-number">${i + 1}</span><span class="encoder-step-label">${label}</span></li>`).join('')}
    </ol>
    <section class="card" data-encoder-step="1">
      <div class="encoder-eyebrow">Step 1 of 4</div>
      <h2>How much of your newest footage should stay exactly as recorded?</h2>
      <p class="encoder-lead">Your newest clips stay at full quality, so you can review and export them. Anything older than this gets shrunk to save space. Your cleanup rules still decide when footage is deleted.</p>
    </section>
    <p class="encoder-scope-note">Keep, space and clip choices apply to <b>${esc(vehicle.name)}</b>. The schedule is shared by every vehicle.</p>
  </div>`;
}
