// Account: two-step sign-in, signed-in devices, other accounts (web/account.js).
import { createAccountPage } from '/web/account.js';

export default {
  async mount(el) {
    el.innerHTML = `<div class="phead"><div><h1>Account</h1><p class="muted small">Two-step sign-in, where you are signed in, and who else can sign in.</p></div></div>
      <section class="card"><div id="ac-page"></div></section>`;
    const page = createAccountPage(el.querySelector('#ac-page'));
    return { unmount() { page.destroy(); } };
  }
};
