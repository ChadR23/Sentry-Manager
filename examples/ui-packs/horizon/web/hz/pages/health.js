// Health: checks with what to do, database snapshots, log search and the
// support bundle (web/health.js, the same in every interface).
import { createHealthPage } from '/web/health.js';

export default {
  async mount(el) {
    el.innerHTML = `<section class="ptitle hud"><div><h1 class="chrome">Health</h1><p>Is everything working, and what to do when it is not.</p></div></section>
      <section class="panel hud"><div id="hl-page"></div></section>`;
    const page = createHealthPage(el.querySelector('#hl-page'));
    return { unmount() { page.destroy(); } };
  }
};
