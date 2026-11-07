// Health: checks with what to do, database snapshots, log search and the
// support bundle (web/health.js, the same in every interface).
import { createHealthPage } from '/web/health.js';

export async function render(ctx) {
  ctx.view.innerHTML = '<div class="page"><div class="page-head"><div><h1>Health</h1><p class="lede">Is everything working, and what to do when it is not.</p></div></div><div class="card" id="hl-page"></div></div>';
  const page = createHealthPage(ctx.view.querySelector('#hl-page'));
  ctx.cleanup(() => page.destroy());
}
