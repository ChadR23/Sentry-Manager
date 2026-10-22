'use strict';

// The plain-HTTP page in front of HTTPS. A device that already trusts the
// certificate (it continued past the warning before, or has the certificate
// authority installed) goes straight on: its request to the HTTPS address
// succeeds, which it can't while the certificate is unknown.
(() => {
  const go = document.getElementById('go');
  const target = new URL(go.href);
  const checking = document.getElementById('checking');
  fetch(`${target.origin}/healthz`, { mode: 'no-cors', cache: 'no-store' })
    .then(() => location.replace(target.href))
    .catch(() => { checking.hidden = true; });
})();
