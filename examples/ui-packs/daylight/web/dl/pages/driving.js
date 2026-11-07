// Driving: the car's driving week by week (web/driving.js, the same in every interface).
import { vehicle, vehiclePicker, setVehicle } from '../state.js';
import { go } from '../app.js';
import { createDrivingPage } from '/web/driving.js';

export async function render(ctx) {
  const v = vehicle();
  ctx.view.innerHTML = `<div class="page"><div class="page-head"><div><h1>Driving</h1><p class="lede">How far and how long you drove each week, and how often you braked hard or swerved.</p></div>
    <div class="head-actions">${vehiclePicker()}</div></div><div class="card" id="dr-page"></div></div>`;
  ctx.view.querySelector('#vehicle-pick')?.addEventListener('change', (e) => { setVehicle(e.target.value); go('#/driving'); });
  const page = createDrivingPage(ctx.view.querySelector('#dr-page'), { vehicleId: v?.id, vehicleName: v?.name });
  ctx.cleanup(() => page.destroy());
}
