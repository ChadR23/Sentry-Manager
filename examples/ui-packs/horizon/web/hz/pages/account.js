// Account: two-step sign-in, signed-in devices, other accounts (web/account.js).
import { createAccountPage } from '/web/account.js';

export default {
  async mount(el) {
    el.innerHTML = `<section class="ptitle hud"><div><h1 class="chrome">Account</h1><p>Two-step sign-in, where you are signed in, and who else can sign in.</p></div></section>
      <section class="panel hud"><div id="ac-page"></div></section>`;
    const page = createAccountPage(el.querySelector('#ac-page'));
    return { unmount() { page.destroy(); } };
  }
};
