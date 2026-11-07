// Driving: the car's driving week by week (web/driving.js, the same in every interface).
import { car } from '../core.js';
import { createDrivingPage } from '/web/driving.js';

export default {
  async mount(el, { go }) {
    const v = car();
    el.innerHTML = `<section class="ptitle hud"><div><h1 class="chrome">Driving</h1><p>Distance, time on the road, hard braking and swerves, week by week, from the driving data in the footage.</p></div></section>
      <section class="panel hud"><div id="dr-page"></div></section>`;
    const page = createDrivingPage(el.querySelector('#dr-page'), { vehicleId: v?.id, vehicleName: v?.name });
    return { unmount() { page.destroy(); }, onCar() { go('#/driving'); } };
  }
};
