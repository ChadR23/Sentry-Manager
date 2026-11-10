// Sentry USB: pair the Pi in the car and manage it over its link (web/sentryUsbLink.js).
import { createSentryUsbPage } from '/web/sentryUsbLink.js';
import { clockPref } from '../core.js';

export default {
  title: 'Sentry USB',
  kicker: 'The Pi in the car',
  icon: 'usb',
  topics: [],
  async mount(ctx) {
    ctx.body.innerHTML = '<div id="su-page"></div>';
    const page = createSentryUsbPage(ctx.body.querySelector('#su-page'), { h24: () => clockPref.h24 });
    return { destroy() { page.destroy(); } };
  }
};
