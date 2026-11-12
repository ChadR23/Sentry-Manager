// Sentry USB: what the Pi in the car last wrote to its share (web/sentryUsbInfo.js).
import { createSentryUsbPage } from '/web/sentryUsbInfo.js';
import { clockPref } from '../core.js';

export default {
  async mount(el) {
    el.innerHTML = `<div class="phead"><div><h1>Sentry USB</h1><p class="muted small">The Pi in the car, as it last wrote to the share: storage, version and the car's tires, temperatures and battery.</p></div></div>
      <section class="card"><div id="su-page"></div></section>`;
    const page = createSentryUsbPage(el.querySelector('#su-page'), { h24: () => clockPref.h24 });
    return { unmount() { page.destroy(); } };
  }
};
