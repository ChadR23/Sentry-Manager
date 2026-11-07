// Map: every Sentry and Saved event where it happened, and the saved places (web/eventMap.js).
import { current, vehiclePicker } from '../core.js';
import { createEventMapPage } from '/web/eventMap.js';

export default {
  topics: [],
  vehicle: true,
  async mount(ctx) {
    const { body, actions } = ctx;
    const v = current();
    actions.innerHTML = vehiclePicker();
    body.innerHTML = '<div id="em-page"></div>';
    const page = createEventMapPage(body.querySelector('#em-page'), { vehicleId: v?.id, vehicleName: v?.name, openEvent: (ev) => { location.hash = `#/viewer/${encodeURIComponent(v.id)}/${encodeURIComponent(ev.recording)}`; } });
    return { destroy() { page.destroy(); } };
  }
};
