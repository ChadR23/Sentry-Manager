'use strict';
// Flux sign-in: login, first-run account setup (setup code), throttling.
(async () => {
  const $ = (id) => document.getElementById(id);
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
  $('host').textContent = location.host;
  const me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({}));
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
  const form = $('form');
  if (setup) {
    $('title').textContent = 'Create your account';
    $('lead').textContent = 'First start. Enter the setup code from the container log, then choose the user name and password that protect this server.';
    $('confirm-row').hidden = false;
    $('code-row').hidden = false;
    $('submit').textContent = 'Create account';
    form.password.autocomplete = 'new-password';
  }
  let lockTimer = null;
  function lockFor(seconds, text) {
    clearInterval(lockTimer);
    let left = seconds;
    const btn = $('submit');
    btn.disabled = true;
    const tick = () => {
      $('err').textContent = `${text.replace(/Try again in \d+ s\.?/, '').trim()} Try again in ${left} s.`;
      if (left-- <= 0) {
        clearInterval(lockTimer);
        btn.disabled = false;
        $('err').textContent = '';
      }
    };
    tick();
    lockTimer = setInterval(tick, 1000);
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    $('err').textContent = '';
    if (!f.get('username') || !f.get('password')) {
      $('err').textContent = 'Enter your user name and password.';
      return;
    }
    if (setup) {
      if (String(f.get('password')).length < 8) { $('err').textContent = 'Choose a password of at least 8 characters.'; return; }
      if (f.get('password') !== f.get('confirm')) { $('err').textContent = 'The passwords do not match.'; return; }
      if (!f.get('code')) { $('err').textContent = 'Enter the setup code from the container log.'; return; }
    }
    $('submit').disabled = true;
    const res = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' },
      body: JSON.stringify({ username: f.get('username'), password: f.get('password'), ...(setup ? { code: f.get('code') } : {}) })
    }).catch(() => null);
    $('submit').disabled = false;
    if (res && res.ok) {
      location.replace(next);
      return;
    }
    const data = res ? await res.json().catch(() => ({})) : {};
    const msg = data.error || (res ? `Sign-in failed (${res.status}).` : 'Could not reach Sentry Six Manager.');
    if (res && res.status === 429) {
      const m = /(\d+)\s*s/.exec(msg);
      lockFor(m ? Number(m[1]) : 30, msg);
      return;
    }
    $('err').textContent = msg;
    form.password.select();
  });
})();
