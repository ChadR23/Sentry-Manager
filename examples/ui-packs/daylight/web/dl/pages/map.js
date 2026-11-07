// Map: every Sentry and Saved event where it happened, and the saved places (web/eventMap.js).
import { vehicle, vehiclePicker, setVehicle } from '../state.js';
import { go } from '../app.js';
import { createEventMapPage } from '/web/eventMap.js';

export async function render(ctx) {
  const v = vehicle();
  ctx.view.innerHTML = `<div class="page"><div class="page-head"><div><h1>Map</h1><p class="lede">Where each Sentry and Saved event happened. Tap a pin to watch it.</p></div>
    <div class="head-actions">${vehiclePicker()}</div></div><div class="card" id="em-page"></div></div>`;
  ctx.view.querySelector('#vehicle-pick')?.addEventListener('change', (e) => { setVehicle(e.target.value); go('#/map'); });
  const page = createEventMapPage(ctx.view.querySelector('#em-page'), { vehicleId: v?.id, vehicleName: v?.name, dark: false, openEvent: (ev) => go(`#/viewer/${encodeURIComponent(v.id)}/${encodeURIComponent(ev.recording)}?day=${encodeURIComponent(ev.day)}`) });
  ctx.cleanup(() => page.destroy());
}
