'use strict';

// Daylight sign-in: first-run account setup (with the setup code) and sign-in.
(function () {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;

  // the look this browser chose (auto / light / dark), the same as in the app
  const THEMES = ['auto', 'light', 'dark'];
  const ICONS = {
    auto: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/></svg>',
    light: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>',
    dark: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/></svg>'
  };
  const readTheme = () => {
    try { return JSON.parse(localStorage.getItem('daylight:theme')) || 'auto'; } catch { return 'auto'; }
  };
  const applyTheme = (t) => {
    if (t === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', t);
    $('theme').innerHTML = ICONS[t];
    $('theme').title = `Look: ${t}`;
  };
  let theme = readTheme();
  applyTheme(theme);
  $('theme').addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { localStorage.setItem('daylight:theme', JSON.stringify(theme)); } catch { /* private mode */ }
    applyTheme(theme);
  });

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

  let setup = false;
  fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({})).then((me) => {
    if (me.user) return location.replace(next);
    if (location.protocol !== 'https:') $('insecure').hidden = false;
    if (me.fingerprint) {
      $('fingerprint').querySelector('.mono').textContent = me.fingerprint;
      $('fingerprint').hidden = false;
    }
    setup = Boolean(me.needsSetup);
    if (setup) {
      $('title').textContent = 'Let’s set things up';
      $('lead').textContent = 'This is the first start. Enter the setup code from the container log, then pick the user name and password that will protect your footage.';
      $('confirm-row').hidden = false;
      $('code-row').hidden = false;
      $('submit').textContent = 'Create my account';
      document.querySelector('[name=password]').autocomplete = 'new-password';
    }
    document.querySelector('[name=password]').focus();
    return undefined;
  });

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const err = $('err');
    err.textContent = '';
    if (!String(f.get('username') || '').trim() || !f.get('password')) {
      err.textContent = 'Enter your user name and password.';
      return;
    }
    if (setup) {
      if (String(f.get('password')).length < 8) { err.textContent = 'Choose a password of at least 8 characters.'; return; }
      if (f.get('password') !== f.get('confirm')) { err.textContent = 'The two passwords don’t match.'; return; }
      if (!String(f.get('code') || '').trim()) { err.textContent = 'Enter the setup code from the container log.'; return; }
    }
    const btn = $('submit');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = setup ? 'Creating…' : 'Signing in…';
    const res = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' },
      body: JSON.stringify({ username: f.get('username'), password: f.get('password'), ...(setup ? { code: f.get('code') } : {}) })
    }).catch(() => null);
    btn.disabled = false;
    btn.textContent = label;
    if (res && res.ok) {
      location.replace(next);
      return;
    }
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res) err.textContent = 'Can’t reach Sentry Six Manager. Check that the server is running.';
    else if (res.status === 429) err.textContent = `${data.error || 'Too many attempts.'} Take a short break, then try again.`;
    else err.textContent = data.error || 'That didn’t work. Try again.';
  });
})();
