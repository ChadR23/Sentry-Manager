// Map: every Sentry and Saved event where it happened, and the saved places (web/eventMap.js).
import { car } from '../core.js';
import { createEventMapPage } from '/web/eventMap.js';

export default {
  async mount(el, { go }) {
    const v = car();
    el.innerHTML = `<section class="ptitle hud"><div><h1 class="chrome">Map</h1><p>Where each Sentry and Saved event happened. Tap a pin to play it.</p></div></section>
      <section class="panel hud"><div id="em-page"></div></section>`;
    const page = createEventMapPage(el.querySelector('#em-page'), { vehicleId: v?.id, vehicleName: v?.name, openEvent: (ev) => go(`#/viewer?rec=${encodeURIComponent(ev.recording)}`) });
    return { unmount() { page.destroy(); }, onCar() { go('#/map'); } };
  }
};
