// Sentry USB: what the Pi in the car last wrote to its share (web/sentryUsbInfo.js).
import { createSentryUsbPage } from '/web/sentryUsbInfo.js';
import { clockPref } from '../core.js';

export async function render(ctx) {
  ctx.view.innerHTML = '<div class="page"><div class="page-head"><div><h1>Sentry USB</h1><p class="lede">The Pi in the car, as it last wrote to the share: storage, version and the car\'s tires, temperatures and battery.</p></div></div><div class="card" id="su-page"></div></div>';
  const page = createSentryUsbPage(ctx.view.querySelector('#su-page'), { h24: () => clockPref.h24 });
  ctx.cleanup(() => page.destroy());
}
