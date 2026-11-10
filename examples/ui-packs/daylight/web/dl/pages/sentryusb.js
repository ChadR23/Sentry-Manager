// Sentry USB: pair the Pi in the car and manage it over its link (web/sentryUsbLink.js).
import { createSentryUsbPage } from '/web/sentryUsbLink.js';
import { clockPref } from '../core.js';

export async function render(ctx) {
  ctx.view.innerHTML = '<div class="page"><div class="page-head"><div><h1>Sentry USB</h1><p class="lede">The Pi in the car: pair it, see its status, change its settings, update it, and queue what runs when it is home.</p></div></div><div class="card" id="su-page"></div></div>';
  const page = createSentryUsbPage(ctx.view.querySelector('#su-page'), { h24: () => clockPref.h24 });
  ctx.cleanup(() => page.destroy());
}
