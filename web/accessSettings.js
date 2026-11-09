// Settings → Security, for a server open to the internet, the same in every
// interface (admins only: /api/security/access answers nobody else): where
// the server sees this device from, bans after failed sign-ins with the
// addresses banned now (and Unban), the two-step sign-in rules, admin work
// only from the home network, and what counts as the home network. Plain
// markup (sentry-acc-*), colours inherited; the interface may pass its own
// button and input classes.
//
//   const a = createAccessSettings(el, { cls: { btn, primary, input } });
//   a.destroy();

const STYLE = `
.sentry-acc{display:flex;flex-direction:column;gap:22px;font-size:14px;line-height:1.5;min-width:0}
.sentry-acc section{display:flex;flex-direction:column;gap:10px;min-width:0}
.sentry-acc h3{margin:0;font-size:15.5px}
.sentry-acc p{margin:0}
.sentry-acc .sx-muted{opacity:.74}
.sentry-acc .sx-small{font-size:12.5px}
.sentry-acc .sx-row{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.sentry-acc .sx-check{display:flex;gap:10px;align-items:flex-start;cursor:pointer}
.sentry-acc .sx-check input{margin:3px 0 0;flex:none;width:17px;height:17px;accent-color:currentColor}
.sentry-acc .sx-check span{min-width:0}
.sentry-acc .sx-check small{display:block;opacity:.74;font-size:12.5px;margin-top:2px}
.sentry-acc .sx-nums{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
.sentry-acc label.sx-f{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600;min-width:0}
.sentry-acc .sx-in{box-sizing:border-box;padding:7px 9px;border-radius:7px;border:1px solid rgba(127,127,127,.45);background:transparent;color:inherit;font:inherit;width:100%;min-width:0}
.sentry-acc textarea.sx-in{min-height:64px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.sentry-acc .sx-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:7px 12px;border-radius:7px;border:1px solid rgba(127,127,127,.45);font-weight:600;white-space:nowrap;text-align:center}
.sentry-acc .sx-btn:hover{background:rgba(127,127,127,.14)}
.sentry-acc .sx-btn:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.sentry-acc .sx-btn[disabled]{opacity:.5;cursor:default}
.sentry-acc .sx-where{padding:10px 12px;border-radius:9px;border:1px solid rgba(127,127,127,.3)}
.sentry-acc .sx-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;overflow-wrap:anywhere}
.sentry-acc .sx-tag{display:inline-block;font-size:11.5px;font-weight:700;padding:1px 8px;border-radius:999px;white-space:nowrap;vertical-align:1px}
.sentry-acc .sx-home{background:rgba(61,220,132,.2)}
.sentry-acc .sx-out{background:rgba(255,170,60,.24)}
.sentry-acc .sx-bans{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.sentry-acc .sx-bans li{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;padding:10px 0;border-top:1px solid rgba(127,127,127,.22)}
.sentry-acc .sx-bans li:first-child{border-top:0}
.sentry-acc .sx-grow{flex:1 1 240px;min-width:0}
.sentry-acc .sx-err{color:#e5484d}
.sentry-acc .sx-confirm{padding:10px 12px;border-radius:9px;border:1px solid rgba(127,127,127,.4)}
.sentry-acc [hidden]{display:none!important}
`;
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' };
async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || `That did not work (${r.status}).`), { code: d.code, status: r.status });
  return d;
}
const when = (t) => {
  const d = new Date(t);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const left = (until) => {
  const m = Math.max(1, Math.round((until - Date.now()) / 60000));
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
};

export function createAccessSettings(el, { cls = {} } = {}) {
  if (!document.getElementById('sentry-acc-css')) {
    const style = document.createElement('style');
    style.id = 'sentry-acc-css';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  const btn = cls.btn || 'sx-btn';
  const primary = cls.primary || btn;
  const input = `sx-in${cls.input ? ` ${cls.input}` : ''}`;
  let alive = true;
  let view = null;
  let retry = null;
  const $ = (s) => el.querySelector(s);
  const say = (msg, isBad) => {
    const e = $('[data-msg]');
    if (e) { e.textContent = msg; e.classList.toggle('sx-err', Boolean(isBad)); }
  };

  const check = (path, label, help, on) => `<label class="sx-check"><input type="checkbox" data-k="${path}"${on ? ' checked' : ''}><span>${label}${help ? `<small>${help}</small>` : ''}</span></label>`;
  const num = (path, label, value, min, max) => `<label class="sx-f">${label}<input class="${input}" type="number" inputmode="numeric" data-k="${path}" value="${esc(value)}" min="${min}" max="${max}" step="1" required></label>`;

  function draw() {
    const v = view;
    const s = v.settings;
    const you = v.you;
    const bans = v.bans.length
      ? `<ul class="sx-bans">${v.bans.map((b) => `<li><div class="sx-grow"><b class="sx-mono">${esc(b.key)}</b><br>
          <span class="sx-muted">banned ${esc(when(b.at))} for ${esc(left(b.until))} more (until ${esc(when(b.until))}) · ${esc(b.failures)} failed attempts, last: ${esc(b.reason)}${b.offences > 1 ? ` · ban ${esc(b.offences)} this week` : ''}</span></div>
          <button type="button" class="${btn}" data-unban="${esc(b.key)}">Unban</button></li>`).join('')}</ul>`
      : `<p class="sx-muted">No address is banned.${v.watching ? ` Failed attempts are being counted for ${v.watching} address${v.watching === 1 ? '' : 'es'}.` : ''}</p>`;
    el.innerHTML = `<div class="sentry-acc">
      <section aria-label="This device">
        <div class="sx-where">This device reaches the server from <b class="sx-mono">${esc(you.address)}</b> <span class="sx-tag ${you.home ? 'sx-home' : 'sx-out'}">${you.home ? 'home network' : 'outside the home network'}</span>
          <br><span class="sx-muted sx-small">${v.trustProxy ? `Behind a reverse proxy (TRUST_PROXY): the address it forwards counts only when the connection comes from ${v.trustedProxies ? `TRUSTED_PROXIES (${esc(v.trustedProxies)})` : 'an address on the local network'}.` : 'The connection\'s own address (no reverse proxy is trusted).'} Check it from a phone on mobile data before relying on the rules below: it must say outside.</span></div>
      </section>
      <section aria-labelledby="sx-b"><h3 id="sx-b">Bans after failed sign-ins</h3>
        ${check('bans.enabled', 'Ban an address after repeated failed attempts', 'Wrong passwords, wrong two-step codes, wrong password confirmations and wrong setup codes all count. A banned address cannot sign in at all for a while (it is told only to try again later), and each ban within a week of the last one lasts twice as long. The usual slow-down after a few wrong passwords stays on as well.', s.bans.enabled)}
        <div class="sx-nums">
          ${num('bans.maxFailures', 'Failed attempts', s.bans.maxFailures, 3, 100)}
          ${num('bans.windowMinutes', 'Within (minutes)', s.bans.windowMinutes, 1, 1440)}
          ${num('bans.banMinutes', 'First ban (minutes)', s.bans.banMinutes, 1, 10080)}
          ${num('bans.maxBanHours', 'Longest ban (hours)', s.bans.maxBanHours, 1, 720)}
        </div>
        ${check('bans.exemptHome', 'Never ban addresses on the home network', 'So you cannot lock yourself out at home. Turn it off only if the home network itself is not to be trusted.', s.bans.exemptHome)}
        <h3 style="margin-top:6px">Banned now</h3>
        ${bans}
      </section>
      <section aria-labelledby="sx-t"><h3 id="sx-t">Two-step sign-in rules</h3>
        ${check('twoFactor.outside', 'Require two-step sign-in for sign-ins from outside the home network', 'An account without two-step sign-in can then only sign in at home (it is told to set it up there, under Account); devices of such accounts already signed in from outside are signed out. Accounts with it use their code (or a recovery code) as always.', s.twoFactor.outside)}
        ${check('twoFactor.everyone', 'Require two-step sign-in for every account, everywhere', 'An account without it can sign in only at home, and then only to set it up (on a page of its own); from outside it cannot sign in. Your own account needs two-step sign-in before this can be turned on.', s.twoFactor.everyone)}
        <p class="sx-muted sx-small">${v.twoFactor.without.length ? `Accounts without two-step sign-in now: <b>${v.twoFactor.without.map(esc).join(', ')}</b>.` : 'Every account has two-step sign-in.'}</p>
      </section>
      <section aria-labelledby="sx-h"><h3 id="sx-h">Admin work only from the home network</h3>
        ${check('homeOnly.adminChanges', 'Admin changes only from the home network', 'From outside, admins can still look at everything, but every change that needs an admin (settings, vehicles and shares, accounts, deleting, the CAN Bridge\'s tokens, interfaces, updates) is refused with a message saying so. Turning this off again also needs the home network.', s.homeOnly.adminChanges)}
        ${check('homeOnly.adminPages', 'Settings and the other admin pages only from the home network', 'From outside, admin accounts are watch-only: footage, the Viewer, maps, exports and starred moments, no Settings, logs or accounts.', s.homeOnly.adminPages)}
      </section>
      <section aria-labelledby="sx-n"><h3 id="sx-n">The home network</h3>
        <p class="sx-muted sx-small">Always: this server itself, the private ranges 10.x, 172.16–31.x, 192.168.x, link-local 169.254.x, and IPv6 ::1, fc00::/7 (unique local) and fe80::/10.</p>
        ${check('home.tailscale', 'Count Tailscale as the home network', '100.64.0.0/10 and fd7a:115c:a1e0::/48. Off by default: 100.64/10 is also the range carriers use for shared addresses (CGNAT).', s.home.tailscale)}
        <label class="sx-f">Extra addresses and ranges that count as home (one per line)<textarea class="${input}" data-k="home.extra" spellcheck="false" placeholder="198.51.100.0/24">${esc(s.home.extra.join('\n'))}</textarea></label>
      </section>
      <form class="sx-row sx-confirm" data-confirm hidden><span>Enter your password to save:</span><input class="${input}" style="width:auto;flex:1 1 180px" type="password" name="password" autocomplete="current-password" aria-label="Your password" required><button type="submit" class="${primary}">Confirm</button><button type="button" class="${btn}" data-cancel>Cancel</button></form>
      <div class="sx-row"><button type="button" class="${primary}" data-save>Save security rules</button><span data-msg role="status"></span></div>
    </div>`;
  }

  async function load() {
    try {
      view = await api('/api/security/access');
      if (alive) draw();
    } catch (err) {
      if (alive) el.innerHTML = `<p class="sx-err">${esc(err.message)}</p>`;
    }
  }

  function collect() {
    const out = { bans: {}, twoFactor: {}, homeOnly: {}, home: {} };
    for (const x of el.querySelectorAll('[data-k]')) {
      const [part, k] = x.dataset.k.split('.');
      if (x.type === 'checkbox') out[part][k] = x.checked;
      else if (x.type === 'number') out[part][k] = Number(x.value);
      else out[part][k] = x.value.split(/[\s,]+/).filter(Boolean);
    }
    return out;
  }

  async function run(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.code === 'CONFIRM_PASSWORD') {
        retry = fn;
        $('[data-confirm]').hidden = false;
        $('[data-confirm] input').focus();
        return undefined;
      }
      say(err.message, true);
      return undefined;
    }
  }

  async function save() {
    const settings = collect();
    const out = await run(() => api('/api/security/access', { method: 'PUT', body: JSON.stringify({ settings }) }));
    if (out && alive) {
      view = out;
      draw();
      say('Saved.');
    }
  }

  el.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-save]')) save();
    const un = t.closest('[data-unban]');
    if (un) {
      un.disabled = true;
      const out = await run(() => api('/api/security/unban', { method: 'POST', body: JSON.stringify({ address: un.dataset.unban }) }));
      if (out && alive) { view = { ...view, bans: out.bans, watching: out.watching }; draw(); say(`${un.dataset.unban} can sign in again.`); }
    }
    if (t.closest('[data-cancel]')) { $('[data-confirm]').hidden = true; retry = null; }
  });
  el.addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-confirm]');
    if (!f) return;
    e.preventDefault();
    try {
      await api('/api/auth/confirm', { method: 'POST', body: JSON.stringify({ password: f.password.value }) });
      f.hidden = true;
      f.password.value = '';
      const again = retry;
      retry = null;
      if (again) {
        const out = await run(again);
        if (out && alive) { view = out; draw(); say('Saved.'); }
      }
    } catch (err) {
      say(err.message, true);
    }
  });

  load();
  return { destroy() { alive = false; }, reload: load };
}
