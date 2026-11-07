// Account: two-step sign-in, signed-in devices, other accounts (web/account.js).
import { createAccountPage } from '/web/account.js';

export async function render(ctx) {
  ctx.view.innerHTML = '<div class="page"><div class="page-head"><div><h1>Account</h1><p class="lede">Two-step sign-in, where you are signed in, and who else can sign in.</p></div></div><div class="card" id="ac-page"></div></div>';
  const page = createAccountPage(ctx.view.querySelector('#ac-page'));
  ctx.cleanup(() => page.destroy());
}
