// Drives: the car's trips, newest first by day; one plays from its start in the Viewer (web/drives.js, the same in every interface).
import { car, clockPref } from '../core.js';
import { createDrivesPage } from '/web/drives.js';

export default {
  async mount(el, { go }) {
    const v = car();
    el.innerHTML = `<section class="ptitle hud"><div><h1 class="chrome">Drives</h1><p>Every trip the car recorded, newest first, day by day. Tap one to play it from the start.</p></div></section>
      <section class="panel hud"><div id="dv-page"></div></section>`;
    const page = createDrivesPage(el.querySelector('#dv-page'), {
      vehicleId: v?.id, vehicleName: v?.name, h24: () => clockPref.h24,
      open: (at) => go(`#/viewer?day=${encodeURIComponent(at.day)}&at=${encodeURIComponent(`${at.clip}~${at.second}`)}`)
    });
    return { unmount() { page.destroy(); }, onCar() { go('#/drives'); } };
  }
};
