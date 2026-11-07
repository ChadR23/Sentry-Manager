// Map: every Sentry and Saved event where it happened, and the saved places (web/eventMap.js).
import { current } from '../core.js';
import { createEventMapPage } from '/web/eventMap.js';

export default {
  async mount(el, { go }) {
    const v = current();
    el.innerHTML = `<div class="phead"><div><h1>Map</h1><p class="muted small">Where each Sentry and Saved event happened. Click a pin to play it.</p></div></div>
      <section class="card"><div id="em-page"></div></section>`;
    const page = createEventMapPage(el.querySelector('#em-page'), { vehicleId: v?.id, vehicleName: v?.name, openEvent: (ev) => { location.hash = `#/viewer?rec=${encodeURIComponent(ev.recording)}`; } });
    return { unmount() { page.destroy(); } };
  }
};
