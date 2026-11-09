// Driving: the car's driving week by week (web/driving.js, the same in every interface).
import { current, vehiclePicker } from '../core.js';
import { createDrivingPage } from '/web/driving.js';

export default {
  title: 'Driving',
  kicker: 'Logbook',
  icon: 'speed',
  topics: [],
  vehicle: true,
  async mount(ctx) {
    const { body, actions } = ctx;
    const v = current();
    actions.innerHTML = vehiclePicker();
    body.innerHTML = '<div id="dr-page"></div>';
    const page = createDrivingPage(body.querySelector('#dr-page'), { vehicleId: v?.id, vehicleName: v?.name });
    return { destroy() { page.destroy(); } };
  }
};
