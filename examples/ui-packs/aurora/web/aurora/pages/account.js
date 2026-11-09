// Account: two-step sign-in, signed-in devices, other accounts (web/account.js).
import { createAccountPage } from '/web/account.js';

export default {
  title: 'Account',
  kicker: 'Keys',
  icon: 'key',
  topics: [],
  async mount(ctx) {
    ctx.body.innerHTML = '<div id="ac-page"></div>';
    const page = createAccountPage(ctx.body.querySelector('#ac-page'));
    return { destroy() { page.destroy(); } };
  }
};
