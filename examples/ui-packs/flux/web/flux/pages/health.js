// Health: checks with what to do, database snapshots, log search and the
// support bundle (web/health.js, the same in every interface).
import { createHealthPage } from '/web/health.js';

export default {
  async mount(el) {
    el.innerHTML = `<div class="phead"><div><h1>Health</h1><p class="muted small">Is everything working, and what to do when it is not.</p></div></div>
      <section class="card"><div id="hl-page"></div></section>`;
    const page = createHealthPage(el.querySelector('#hl-page'));
    return { unmount() { page.destroy(); } };
  }
};
