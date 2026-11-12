// The Account page, the same in every interface: two-step sign-in, the
// devices signed in to this account, and (for admins) the other accounts
// with their roles. Plain markup (sentry-acct-*), colours inherited.
//
//   const page = createAccountPage(el);

const STYLE = `
.sentry-acct{display:flex;flex-direction:column;gap:24px;font-size:14px;line-height:1.45}
.sentry-acct section{display:flex;flex-direction:column;gap:8px}
.sentry-acct h2{margin:0;font-size:17px}
.sentry-acct .sa-muted{opacity:.72}
.sentry-acct .sa-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.sentry-acct .sa-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:7px 12px;border-radius:7px;border:1px solid rgba(127,127,127,.45);font-weight:600;white-space:nowrap}
.sentry-acct .sa-btn:hover{background:rgba(127,127,127,.14)}
.sentry-acct .sa-btn:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.sentry-acct .sa-btn[disabled]{opacity:.5;cursor:default}
.sentry-acct input,.sentry-acct select{box-sizing:border-box;padding:7px 9px;border-radius:7px;border:1px solid rgba(127,127,127,.45);background:transparent;color:inherit;font:inherit;min-width:0}
.sentry-acct select option{color:#111}
.sentry-acct table{border-collapse:collapse;width:100%}
.sentry-acct td{padding:8px 10px 8px 0;border-top:1px solid rgba(127,127,127,.2);vertical-align:middle}
.sentry-acct .sa-scroll{overflow-x:auto}
/* many signed-in devices (every browser and script that signed in) scroll in their own box, newest first, not down a page as long as the list */
.sentry-acct [data-sessions] .sa-scroll{max-height:min(480px,60vh);overflow-y:auto;overscroll-behavior:contain}
.sentry-acct code{font:600 15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;padding:4px 8px;border-radius:6px;background:rgba(127,127,127,.16);user-select:all;-webkit-user-select:all;overflow-wrap:anywhere}
.sentry-acct .sa-codes{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px}
.sentry-acct .sa-on{color:#3ddc84;font-weight:700}
.sentry-acct .sa-err{color:#ff7b7b}
.sentry-acct .sa-tag{font-size:11px;font-weight:700;padding:1px 6px;border-radius:5px;background:rgba(127,127,127,.2)}
`;
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' };
async function request(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || `That did not work (${r.status}).`), { code: d.code });
  return d;
}
const ago = (t) => {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 120 ? 'just now' : s < 7200 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
function device(agent) {
  const a = String(agent || '');
  if (!a) return 'Unknown device';
  const browser = /Edg\//.test(a) ? 'Edge' : /OPR\//.test(a) ? 'Opera' : /Firefox\//.test(a) ? 'Firefox' : /Chrome\//.test(a) ? 'Chrome' : /Safari\//.test(a) ? 'Safari' : /curl|node|python/i.test(a) ? 'a program' : 'a browser';
  const os = /iPhone/.test(a) ? 'iPhone' : /iPad/.test(a) ? 'iPad' : /Android/.test(a) ? 'Android' : /Windows/.test(a) ? 'Windows' : /Mac OS X|Macintosh/.test(a) ? 'Mac' : /Linux/.test(a) ? 'Linux' : '';
  return `${browser}${os ? ` on ${os}` : ''}`;
}

export function createAccountPage(el, { scope } = {}) {
  const api = async (url, opts = {}) => {
    scope?.check();
    try { return await request(url, { ...opts, signal: scope?.signal }); }
    finally { scope?.check(); }
  };
  if (!document.getElementById('sentry-acct-css')) {
    const style = document.createElement('style');
    style.id = 'sentry-acct-css';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  el.innerHTML = `<div class="sentry-acct">
    <section aria-labelledby="sa-2"><h2 id="sa-2">Two-step sign-in</h2><div data-2fa><p class="sa-muted">Loading…</p></div></section>
    <section aria-labelledby="sa-d"><div class="sa-row"><h2 id="sa-d">Signed-in devices</h2><button type="button" class="sa-btn" data-end-others>Sign out everywhere else</button></div><div data-sessions></div></section>
    <section aria-labelledby="sa-a" data-accounts-box hidden><h2 id="sa-a">Accounts</h2>
      <p class="sa-muted" style="margin:0"><b>Admin</b>: everything. <b>Watch only</b>: footage, the Viewer, maps, exports and starred moments; no deleting, converting or settings.</p>
      <div data-accounts></div>
      <form class="sa-row" data-add><input name="username" placeholder="New account name" aria-label="New account name" required pattern="[A-Za-z0-9._@-]{1,64}">
        <input name="password" type="password" placeholder="Its password (8+ characters)" aria-label="Its password" minlength="8" required autocomplete="new-password">
        <select name="role" aria-label="Role"><option value="viewer">Watch only</option><option value="admin">Admin</option></select>
        <button type="submit" class="sa-btn">Add account</button></form></section>
    <form class="sa-row" data-confirm hidden><span>Enter your password to confirm:</span><input type="password" name="password" autocomplete="current-password" aria-label="Your password" required><button type="submit" class="sa-btn">Confirm</button><button type="button" class="sa-btn" data-cancel>Cancel</button></form>
    <p class="sa-err" data-err role="alert"></p>
  </div>`;
  const $ = (s) => el.querySelector(s);
  let me = null;
  let alive = true;
  let retry = null; // the action to run again once the password is confirmed

  const fail = (err) => { if (!alive || scope?.signal.aborted) return; $('[data-err]').textContent = err?.message || ''; };
  // run an action; one that needs the password again asks for it, then runs again
  async function guarded(fn) {
    fail(null);
    try {
      return await fn();
    } catch (err) {
      if (err.code === 'CONFIRM_PASSWORD') {
        retry = fn;
        $('[data-confirm]').hidden = false;
        $('[data-confirm] input').focus();
        return undefined;
      }
      fail(err);
      return undefined;
    }
  }

  async function draw2fa(setup = null, recovery = null) {
    const st = await api('/api/auth/2fa').catch(() => null);
    if (!alive || !st) return;
    const box = $('[data-2fa]');
    if (recovery) {
      box.innerHTML = `<p><span class="sa-on">On.</span> Keep these recovery codes somewhere safe: each signs in once without the phone. They are not shown again.</p>
        <div class="sa-codes">${recovery.map((c) => `<code>${esc(c)}</code>`).join('')}</div>
        <div class="sa-row"><a class="sa-btn" download="sentry-six-manager-recovery-codes.txt" href="data:text/plain;charset=utf-8,${encodeURIComponent(`Sentry Six Manager recovery codes for ${me?.user}\n\n${recovery.join('\n')}\n`)}">Download them</a><button type="button" class="sa-btn" data-done>Done</button></div>`;
      return;
    }
    if (setup) {
      box.innerHTML = `<ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:8px">
        <li>In an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden, Aegis…), add an account with this setup key:<br><code>${esc(setup.secret.replace(/(.{4})/g, '$1 ').trim())}</code><br>
          <span class="sa-muted">On this phone? <a href="${esc(setup.uri)}">Open it in the authenticator app</a>.</span></li>
        <li>Type the 6-digit code it shows:</li></ol>
        <form class="sa-row" data-enable><input name="code" inputmode="numeric" maxlength="6" placeholder="123456" aria-label="Code from the app" required autocomplete="one-time-code"><button type="submit" class="sa-btn">Turn on</button><button type="button" class="sa-btn" data-done>Cancel</button></form>`;
      box.querySelector('input').focus();
      return;
    }
    box.innerHTML = st.enabled
      ? `<p><span class="sa-on">On.</span> Signing in asks for a code from your authenticator app after the password. ${st.recoveryLeft} recovery code${st.recoveryLeft === 1 ? '' : 's'} left.</p><div class="sa-row"><button type="button" class="sa-btn" data-2fa-off>Turn off…</button></div>`
      : '<p class="sa-muted">Off. With it on, signing in also needs a 6-digit code from an app on your phone, so a stolen password alone is not enough. Nothing leaves this server: the app makes the codes itself.</p><div class="sa-row"><button type="button" class="sa-btn" data-2fa-on>Turn on…</button></div>';
  }

  async function drawSessions() {
    const d = await api('/api/auth/sessions').catch((err) => { fail(err); return null; });
    if (!alive || !d) return;
    $('[data-sessions]').innerHTML = `<div class="sa-scroll"><table>${d.sessions.map((s) => `<tr><td><b>${esc(device(s.agent))}</b>${s.current ? ' <span class="sa-tag">this device</span>' : ''}<br><span class="sa-muted">${esc(s.ip || '')}${s.seenAt ? ` · last used ${esc(ago(s.seenAt))}` : ''} · signed in ${esc(new Date(s.createdAt).toLocaleDateString())}</span></td>
      <td style="text-align:right">${s.current ? '' : `<button type="button" class="sa-btn" data-end="${esc(s.id)}">Sign out</button>`}</td></tr>`).join('')}</table></div>`;
    $('[data-end-others]').hidden = d.sessions.length < 2;
  }

  async function drawAccounts() {
    if (me?.role !== 'admin') return;
    const d = await api('/api/accounts').catch(() => null);
    if (!alive || !d) return;
    $('[data-accounts-box]').hidden = false;
    $('[data-accounts]').innerHTML = `<div class="sa-scroll"><table>${d.accounts.map((a) => `<tr><td><b>${esc(a.username)}</b>${a.username === me.user ? ' <span class="sa-tag">you</span>' : ''}${a.twoFactor ? ' <span class="sa-tag">two-step</span>' : ''}</td>
      <td><select data-role="${esc(a.username)}" aria-label="Role of ${esc(a.username)}"><option value="admin"${a.role === 'admin' ? ' selected' : ''}>Admin</option><option value="viewer"${a.role === 'viewer' ? ' selected' : ''}>Watch only</option></select></td>
      <td style="text-align:right">${a.username === me.user ? '' : `<button type="button" class="sa-btn" data-remove="${esc(a.username)}">Remove</button>`}</td></tr>`).join('')}</table></div>`;
  }

  el.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-2fa-on]')) {
      const setup = await guarded(() => api('/api/auth/2fa/start', { method: 'POST' }));
      if (setup) draw2fa(setup);
    } else if (t.closest('[data-2fa-off]')) {
      if (await guarded(() => api('/api/auth/2fa/disable', { method: 'POST' }))) draw2fa();
    } else if (t.closest('[data-done]')) {
      draw2fa();
    } else if (t.closest('[data-end]')) {
      if (await guarded(() => api(`/api/auth/sessions/${encodeURIComponent(t.closest('[data-end]').dataset.end)}/end`, { method: 'POST' }))) drawSessions();
    } else if (t.closest('[data-end-others]')) {
      if (await guarded(() => api('/api/auth/sessions-end-others', { method: 'POST' }))) drawSessions();
    } else if (t.closest('[data-remove]')) {
      const name = t.closest('[data-remove]').dataset.remove;
      if (!confirm(`Remove the account "${name}"? It is signed out everywhere.`)) return;
      if (await guarded(() => api(`/api/accounts/${encodeURIComponent(name)}`, { method: 'DELETE' }))) drawAccounts();
    } else if (t.closest('[data-cancel]')) {
      $('[data-confirm]').hidden = true;
      retry = null;
    }
  });
  el.addEventListener('change', async (e) => {
    const s = e.target.closest('[data-role]');
    if (!s) return;
    const role = s.value;
    if (!(await guarded(() => api(`/api/accounts/${encodeURIComponent(s.dataset.role)}`, { method: 'PATCH', body: JSON.stringify({ role }) })))) drawAccounts();
  });
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.matches('[data-confirm]')) {
      try {
        await api('/api/auth/confirm', { method: 'POST', body: JSON.stringify({ password: f.password.value }) });
        f.password.value = '';
        f.hidden = true;
        const again = retry;
        retry = null;
        const out = again ? await guarded(again) : null;
        // the action asked for again: show what it made
        if (out?.secret) draw2fa(out);
        else { draw2fa(); drawSessions(); drawAccounts(); }
      } catch (err) { fail(err); }
    } else if (f.matches('[data-enable]')) {
      try { const { recovery } = await api('/api/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code: f.code.value }) }); draw2fa(null, recovery); } catch (err) { fail(err); }
    } else if (f.matches('[data-add]')) {
      const body = JSON.stringify({ username: f.username.value, password: f.password.value, role: f.role.value });
      if (await guarded(() => api('/api/accounts', { method: 'POST', body }))) { f.reset(); drawAccounts(); }
    }
  });

  api('/api/auth/me').then((m) => { me = m; draw2fa(); drawSessions(); drawAccounts(); }).catch(fail);
  return { destroy() { alive = false; el.innerHTML = ''; } };
}
