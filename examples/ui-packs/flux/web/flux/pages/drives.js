// Drives: the car's trips, newest first by day; one plays from its start in the Viewer (web/drives.js, the same in every interface).
import { current, clockPref } from '../core.js';
import { createDrivesPage } from '/web/drives.js';

export default {
  async mount(el, { go }) {
    const v = current();
    el.innerHTML = `<div class="phead"><div><h1>Drives</h1><p class="muted small">Every trip the car recorded, newest first, day by day. Click one to play it from the start.</p></div></div>
      <section class="card"><div id="dv-page"></div></section>`;
    const page = createDrivesPage(el.querySelector('#dv-page'), {
      vehicleId: v?.id, vehicleName: v?.name, h24: () => clockPref.h24,
      open: (at) => { const to = `#/viewer?day=${encodeURIComponent(at.day)}&at=${encodeURIComponent(`${at.clip}~${at.second}`)}`; if (go) go(to); else location.hash = to; }
    });
    return { unmount() { page.destroy(); } };
  }
};
