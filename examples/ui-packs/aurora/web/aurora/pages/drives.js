// Drives: the car's trips, newest first by day; one plays from its start in the Viewer (web/drives.js, the same in every interface).
import { current, vehiclePicker, clockPref } from '../core.js';
import { createDrivesPage } from '/web/drives.js';

export default {
  title: 'Drives',
  kicker: 'Trips',
  icon: 'route',
  topics: [],
  vehicle: true,
  async mount(ctx) {
    const { body, actions, go } = ctx;
    const v = current();
    actions.innerHTML = vehiclePicker();
    body.innerHTML = '<div id="dv-page"></div>';
    const page = createDrivesPage(body.querySelector('#dv-page'), {
      vehicleId: v?.id, vehicleName: v?.name, h24: () => clockPref.h24,
      open: (at) => { const to = `#/viewer/${encodeURIComponent(v.id)}/day/${encodeURIComponent(at.day)}?at=${encodeURIComponent(`${at.clip}~${at.second}`)}&autoplay=1`; if (go) go(to); else location.hash = to; }
    });
    return { destroy() { page.destroy(); } };
  }
};
