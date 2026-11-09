// Health: checks with what to do, database snapshots, log search and the
// support bundle (web/health.js, the same in every interface).
import { createHealthPage } from '/web/health.js';

export default {
  title: 'Health',
  kicker: 'Vital signs',
  icon: 'check',
  topics: [],
  async mount(ctx) {
    ctx.body.innerHTML = '<div id="hl-page"></div>';
    const page = createHealthPage(ctx.body.querySelector('#hl-page'));
    return { destroy() { page.destroy(); } };
  }
};
