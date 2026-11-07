'use strict';

// The two-step sign-in's code page (/login/code): the password was right,
// the code from the authenticator app (or a recovery code) finishes it.
(() => {
  const form = document.getElementById('code-form');
  const err = document.getElementById('err');
  const raw = new URLSearchParams(location.search).get('next') || '/';
  // only a path on this server (as login.js: "/\evil.com" and tabs count as another site)
  const next = (() => {
    try {
      const u = new URL(raw, location.origin);
      if (u.origin !== location.origin || !raw.startsWith('/') || raw.startsWith('//') || /[\\\s]/.test(raw) || u.pathname.startsWith('/login')) return '/';
      return u.pathname + u.search + u.hash;
    } catch {
      return '/';
    }
  })();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    err.textContent = '';
    try {
      const res = await fetch('/api/auth/2fa/code', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' },
        body: JSON.stringify({ code: form.code.value.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { location.replace(next); return; }
      err.textContent = data.error || 'That did not work.';
      if (/sign in again/i.test(data.error || '')) setTimeout(() => location.replace(`/login?next=${encodeURIComponent(next)}`), 1500);
    } catch {
      err.textContent = 'The server did not answer. Try again.';
    }
    button.disabled = false;
    form.code.select();
  });
})();
