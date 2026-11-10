// Sentry USB: pair the Pi in the car and manage it over its link (web/sentryUsbLink.js).
import { createSentryUsbPage } from '/web/sentryUsbLink.js';
import { clockPref } from '../core.js';

export default {
  async mount(el) {
    el.innerHTML = `<div class="phead"><div><h1>Sentry USB</h1><p class="muted small">The Pi in the car: pair it, see its status, change its settings, update it, and queue what runs when it is home.</p></div></div>
      <section class="card"><div id="su-page"></div></section>`;
    const page = createSentryUsbPage(el.querySelector('#su-page'), { h24: () => clockPref.h24 });
    return { unmount() { page.destroy(); } };
  }
};
