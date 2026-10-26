'use strict';
// Aurora sign-in: sign in, or create the account on the first start (setup code
// from the container log). Throttled attempts (429) count down on the button.
(async () => {
  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const err = $('err');
  const submit = $('submit');
  // only ever continue to a page of this server
  const next = (() => {
    const raw = new URLSearchParams(location.search).get('next') || '/';
    if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\s]/.test(raw)) return '/';
    try {
      const u = new URL(raw, location.origin);
      return u.origin === location.origin ? u.pathname + u.search + u.hash : '/';
    } catch {
      return '/';
    }
  })();
  let me = {};
  try {
    me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json());
  } catch {
    err.textContent = 'Could not reach Sentry Six Manager. Check the address and reload.';
  }
  if (me.user) {
    location.replace(next);
    return;
  }
  if (location.protocol !== 'https:') $('insecure').hidden = false;
  if (me.fingerprint) {
    const box = $('fingerprint').querySelector('.mono');
    box.replaceChildren(...String(me.fingerprint).split(':').flatMap((part, i) => (i ? [':', document.createElement('wbr'), part] : [part])));
    $('fingerprint').hidden = false;
  }
  const setup = Boolean(me.needsSetup);
  if (setup) {
    $('title').textContent = 'Create your account';
    $('lead').textContent = 'First start: enter the setup code from the container log, then choose the user name and password that protect this server.';
    $('confirm-row').hidden = false;
    $('code-row').hidden = false;
    submit.textContent = 'Create account';
    form.password.autocomplete = 'new-password';
  }
  (form.username.value ? form.password : form.username).focus();

  let waitTimer = null;
  function countDown(message) {
    const m = /(\d+)\s*s\b/.exec(message || '');
    let left = m ? Number(m[1]) : 0;
    clearInterval(waitTimer);
    if (!left) {
      err.textContent = message;
      return;
    }
    submit.disabled = true;
    const tick = () => {
      if (left <= 0) {
        clearInterval(waitTimer);
        submit.disabled = false;
        submit.textContent = setup ? 'Create account' : 'Sign in';
        err.textContent = 'You can try again now.';
        return;
      }
      err.textContent = `Too many attempts. Try again in ${left} s.`;
      submit.textContent = `Wait ${left} s`;
      left -= 1;
    };
    tick();
    waitTimer = setInterval(tick, 1000);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const f = new FormData(form);
    const username = String(f.get('username') || '').trim();
    const password = String(f.get('password') || '');
    if (!username || !password) {
      err.textContent = 'Enter your user name and password.';
      return;
    }
    if (setup) {
      if (password.length < 8) { err.textContent = 'Choose a password of at least 8 characters.'; return; }
      if (password !== f.get('confirm')) { err.textContent = 'The passwords do not match.'; return; }
      if (!String(f.get('code') || '').trim()) { err.textContent = 'Enter the setup code from the container log.'; return; }
    }
    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = setup ? 'Creating…' : 'Signing in…';
    let res = null;
    try {
      res = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' },
        body: JSON.stringify({ username, password, ...(setup ? { code: String(f.get('code') || '').trim() } : {}) })
      });
    } catch {
      res = null;
    }
    if (res && res.ok) {
      location.replace(next);
      return;
    }
    submit.disabled = false;
    submit.textContent = label;
    const data = res ? await res.json().catch(() => ({})) : {};
    if (res && res.status === 429) {
      countDown(data.error || 'Too many attempts. Try again later.');
      return;
    }
    err.textContent = data.error || 'Could not reach Sentry Six Manager.';
    form.password.select();
  });
})();
