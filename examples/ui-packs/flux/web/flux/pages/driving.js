// Driving: the car's driving week by week (web/driving.js, the same in every interface).
import { current } from '../core.js';
import { createDrivingPage } from '/web/driving.js';

export default {
  async mount(el) {
    const v = current();
    el.innerHTML = `<div class="phead"><div><h1>Driving</h1><p class="muted small">Distance, time on the road, hard braking and swerves, week by week, from the driving data in the footage.</p></div></div>
      <section class="card"><div id="dr-page"></div></section>`;
    const page = createDrivingPage(el.querySelector('#dr-page'), { vehicleId: v?.id, vehicleName: v?.name });
    return { unmount() { page.destroy(); } };
  }
};
