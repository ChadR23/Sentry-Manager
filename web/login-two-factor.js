'use strict';

// Setting up two-step sign-in when Settings → Security says every account
// needs it (/login/two-factor): until it is on, this page is all a session
// of an account without it can open. The same page for every interface.
(() => {
  const $ = (id) => document.getElementById(id);
  const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' };
  const call = async (url, body) => {
    const res = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.replace('/login'); throw new Error('Signed out'); }
    if (!res.ok) throw Object.assign(new Error(data.error || 'That did not work.'), { code: data.code });
    return data;
  };
  const fail = (err) => { $('err').textContent = err ? err.message : ''; };
  const show = (id) => { for (const x of ['pw-form', 'start-box', 'code-form', 'done']) $(x).hidden = x !== id; };

  async function start() {
    fail(null);
    try {
      const setup = await call('/api/auth/2fa/start', {});
      $('key').textContent = setup.secret.replace(/(.{4})/g, '$1 ').trim();
      $('uri').href = setup.uri;
      show('code-form');
      $('code').focus();
    } catch (err) {
      if (err.code === 'CONFIRM_PASSWORD') { show('pw-form'); $('pw').focus(); return; }
      fail(err);
    }
  }

  call('/api/auth/2fa').then((st) => { if (st.enabled) location.replace('/'); }).catch(() => {});
  $('start').addEventListener('click', start);
  $('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    fail(null);
    try {
      await call('/api/auth/confirm', { password: $('pw').value });
      $('pw').value = '';
      start();
    } catch (err) {
      fail(err);
    }
  });
  $('code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    fail(null);
    const button = $('code-form').querySelector('button');
    button.disabled = true;
    try {
      const out = await call('/api/auth/2fa/enable', { code: $('code').value.trim() });
      $('codes').replaceChildren(...out.recovery.map((c) => Object.assign(document.createElement('code'), { textContent: c })));
      $('download').href = `data:text/plain;charset=utf-8,${encodeURIComponent(`Sentry Six Manager recovery codes\n\n${out.recovery.join('\n')}\n`)}`;
      $('lead').hidden = true;
      show('done');
    } catch (err) {
      fail(err);
      $('code').select();
    }
    button.disabled = false;
  });
  $('continue').addEventListener('click', () => location.replace('/'));
  $('logout').addEventListener('click', async (e) => {
    e.preventDefault();
    await call('/api/auth/logout', {}).catch(() => {});
    location.replace('/login');
  });
})();
