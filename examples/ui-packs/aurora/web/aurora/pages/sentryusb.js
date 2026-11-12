// Sentry USB: what the Pi in the car last wrote to its share (web/sentryUsbInfo.js).
import { createSentryUsbPage } from '/web/sentryUsbInfo.js';
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
