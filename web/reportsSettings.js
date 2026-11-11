// Settings → Help & feedback, the same in every interface (admins only:
// /api/reports answers nobody else). Send feedback, send diagnostics to
// support, the opt-in "Share diagnostics with the developers", "Send
// anonymously", what was sent last and the last hourly heartbeat ("Show a
// heartbeat" shows a sample of one). Before anything is sent, "What
// will be sent" shows the exact JSON (already made anonymous when that is
// on); sending asks for the password, the two switches save in one click. Plain markup
// (sentry-rep-*), colours inherited; the interface passes its own button
// and input classes.
//
//   const r = createReportsSettings(el, { cls: { btn, primary, input }, h24: () => bool });
//   r.destroy();

const STYLE = `
.sentry-rep{display:flex;flex-direction:column;gap:22px;font-size:14px;line-height:1.5;min-width:0}
.sentry-rep section{display:flex;flex-direction:column;gap:10px;min-width:0}
.sentry-rep h3{margin:0;font-size:15.5px}
.sentry-rep p{margin:0}
.sentry-rep .sr-muted{opacity:.74}
.sentry-rep .sr-small{font-size:12.5px}
.sentry-rep .sr-row{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.sentry-rep .sr-check{display:flex;gap:10px;align-items:flex-start;cursor:pointer}
.sentry-rep .sr-check input{margin:3px 0 0;flex:none;width:17px;height:17px;accent-color:currentColor}
.sentry-rep .sr-check small{display:block;opacity:.74;font-size:12.5px;margin-top:2px}
.sentry-rep label.sr-f{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600;min-width:0}
.sentry-rep .sr-in{box-sizing:border-box;padding:7px 9px;border-radius:7px;border:1px solid rgba(127,127,127,.45);background:transparent;color:inherit;font:inherit;width:100%;min-width:0}
.sentry-rep textarea.sr-in{min-height:96px;resize:vertical}
.sentry-rep .sr-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:7px 12px;border-radius:7px;border:1px solid rgba(127,127,127,.45);font-weight:600;white-space:nowrap;text-align:center}
.sentry-rep .sr-btn:hover{background:rgba(127,127,127,.14)}
.sentry-rep .sr-btn:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.sentry-rep [disabled]{opacity:.5;cursor:default}
.sentry-rep .sr-box{padding:12px 14px;border-radius:9px;border:1px solid rgba(127,127,127,.3)}
.sentry-rep .sr-off{padding:12px 14px;border-radius:9px;background:rgba(255,170,60,.16);border:1px solid rgba(255,170,60,.45);font-weight:600}
.sentry-rep .sr-ok{color:#2fa56a}.sentry-rep .sr-err{color:#e5484d}
.sentry-rep .sr-ref{font:700 15px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.04em;padding:2px 8px;border-radius:6px;background:rgba(127,127,127,.16)}
.sentry-rep .sr-preview summary{cursor:pointer;font-weight:600}
.sentry-rep .sr-preview pre{margin:8px 0 0;max-height:340px;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px 10px;border-radius:7px;border:1px solid rgba(127,127,127,.3)}
.sentry-rep .sr-kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}
.sentry-rep .sr-kv dt{opacity:.74}.sentry-rep .sr-kv dd{margin:0;overflow-wrap:anywhere}
.sentry-rep .sr-count{font-size:12px;opacity:.7;text-align:right}
.sentry-rep [hidden]{display:none!important}
`;
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' };
async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || `That did not work (${r.status}).`), { code: d.code, status: r.status });
  return d;
}
const NOT_SET_UP = "Reporting isn't set up in this build.";

export function createReportsSettings(el, { cls = {}, h24 = null } = {}) {
  if (!document.getElementById('sentry-rep-css')) {
    const style = document.createElement('style');
    style.id = 'sentry-rep-css';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  const btn = cls.btn || 'sr-btn';
  const primary = cls.primary || btn;
  const input = `sr-in${cls.input ? ` ${cls.input}` : ''}`;
  const h24Now = () => (typeof h24 === 'function' ? Boolean(h24()) : false);
  const stamp = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: !h24Now() });
  let alive = true;
  let st = null;
  let retry = null;
  let pending = null; // { kind, previewId }
  const $ = (s) => el.querySelector(s);

  function statusHtml() {
    if (!st.configured) return `<p class="sr-muted">${NOT_SET_UP} Nothing is sent from it.</p>`;
    const last = st.lastSent;
    const words = { feedback: 'feedback', support: 'diagnostics to support', crash: 'a crash report', daily: 'the daily summary', heartbeat: 'a heartbeat' };
    const hb = st.lastHeartbeat;
    const hbText = hb?.at ? esc(stamp(hb.at)) : st.settings.share ? `none yet${st.nextHeartbeatAt ? ` (the first goes at about ${esc(stamp(st.nextHeartbeatAt))})` : ''}` : 'off (sharing is off)';
    const hbErr = hb?.error ? ` <span class="sr-err">· not delivered: ${esc(hb.error.message)} <span class="sr-muted">(${esc(stamp(hb.error.at))})</span></span>` : '';
    return `<dl class="sr-kv">
      <dt>Last sent</dt><dd>${last ? `${esc(stamp(last.at))} · ${esc(words[last.kind] || last.kind)}${last.ref ? ` · <span class="sr-ref">${esc(last.ref)}</span>` : ''}` : 'nothing yet'}</dd>
      <dt>Last heartbeat</dt><dd data-lasthb>${hbText}${hbErr}</dd>
      <dt>Waiting to go</dt><dd>${st.outbox.count ? `${st.outbox.count} report${st.outbox.count === 1 ? '' : 's'} (sealed; tried again by themselves, kept at most 7 days)` : 'none'}</dd>
      ${st.lastError ? `<dt>Last problem</dt><dd class="sr-err">${esc(st.lastError.message)} <span class="sr-muted">(${esc(stamp(st.lastError.at))})</span></dd>` : ''}
      <dt>Sent to</dt><dd><span class="sr-muted">${esc(st.endpoint)} · key ${esc(st.kid)}</span></dd></dl>`;
  }

  function draw() {
    const off = !st.configured;
    const dis = off ? ' disabled' : '';
    const s = st.settings;
    el.innerHTML = `<div class="sentry-rep">
      ${off ? `<p class="sr-off" role="status">${NOT_SET_UP} The buttons below are off and nothing is ever sent.</p>` : ''}
      <p class="sr-muted">Reports go only to the developers of Sentry Six Manager, sealed so only they can read them. Nothing is sent unless you press Send here, or turn on sharing below. Passwords, keys, tokens, cookies and share credentials are never in a report.</p>
      <section aria-labelledby="sr-fb"><h3 id="sr-fb">Send feedback</h3>
        <label class="sr-f">Message<textarea class="${input}" data-msg maxlength="5000" required placeholder="What works, what doesn't, what you'd like…"${dis}></textarea></label>
        <div class="sr-count" data-msgcount>0 / 5000</div>
        <label class="sr-f">Contact (optional)<input class="${input}" data-contact maxlength="200" autocomplete="email" placeholder="An e-mail address or a name to reply to"${dis || (s.anonymous ? ' disabled' : '')}></label>
        ${s.anonymous ? '<p class="sr-muted sr-small">"Send anonymously" is on: no contact is sent.</p>' : ''}
        <label class="sr-check"><input type="checkbox" data-attach checked${dis}><span>Attach diagnostics<small>The same as "Send diagnostics to support" below: the set-up, versions, health checks and recent warnings, without secrets.</small></span></label>
        <div class="sr-row"><button type="button" class="${primary}" data-preview="feedback"${dis}>Review and send…</button></div>
      </section>
      <section aria-labelledby="sr-sp"><h3 id="sr-sp">Send diagnostics to support</h3>
        <p class="sr-muted sr-small">A full diagnostics report for the support team, now (it works with sharing off: pressing Send is the yes for this one report). You get a reference code to quote.</p>
        <label class="sr-f">What's wrong (optional)<input class="${input}" data-note maxlength="1000" placeholder="A few words for the support team"${dis}></label>
        <div class="sr-row"><button type="button" class="${btn}" data-preview="support"${dis}>Review and send…</button></div>
      </section>
      <section class="sr-preview" data-pv hidden aria-live="polite">
        <details open><summary data-pvtitle>What will be sent</summary><pre data-pvjson></pre></details>
        <div class="sr-row"><button type="button" class="${primary}" data-send>Send</button><button type="button" class="${btn}" data-cancelpv>Cancel</button></div>
        <div class="sr-row" data-sampleclose hidden><span class="sr-muted sr-small">A sample: heartbeats go by themselves while sharing is on, never by hand.</span><button type="button" class="${btn}" data-cancelpv>Close</button></div>
      </section>
      <p data-result role="status" hidden></p>
      <section aria-labelledby="sr-opt"><h3 id="sr-opt">Sharing</h3>
        <label class="sr-check"><input type="checkbox" data-k="share"${s.share ? ' checked' : ''}${dis}><span>Share diagnostics with the developers<small>Off unless you turn it on. Then a report goes after a crash or an unhandled error, a health summary once a day, and a short heartbeat every hour (version, health, how much footage and space saved). Turning it off stops that and drops the ones still waiting.</small></span></label>
        <p class="sr-small"><a href="#" data-samplehb${dis}>Show a heartbeat</a> <span class="sr-muted">(what one would send now: numbers only, no names, paths or hosts)</span></p>
        <label class="sr-check"><input type="checkbox" data-k="anonymous"${s.anonymous ? ' checked' : ''}${dis}><span>Send anonymously<small>For every report: the install id, host name, addresses, account, vehicle and Sentry USB names, share paths, Wi-Fi names, VINs, e-mail addresses and places become ANON, and no contact is sent.</small></span></label>
      </section>
      <form class="sr-row sr-box" data-confirm hidden><span>Enter your password to confirm:</span><input class="${input}" style="width:auto;flex:1 1 180px" type="password" name="password" autocomplete="current-password" aria-label="Your password" required><button type="submit" class="${primary}">Confirm</button><button type="button" class="${btn}" data-cancel>Cancel</button></form>
      <section aria-labelledby="sr-st"><h3 id="sr-st">Status</h3><div data-status>${statusHtml()}</div></section>
      <p data-say role="status"></p>
    </div>`;
  }
  const say = (msg, bad) => { const e = $('[data-say]'); if (e) { e.textContent = msg; e.className = bad ? 'sr-err' : ''; } };
  // a problem with a preview or a send, shown next to its buttons (the line at the
  // bottom is far below them on a phone, so a refused Send looked like nothing happened)
  const tell = (msg, scroll = true) => { const r = $('[data-result]'); if (!r) return; r.hidden = !msg; r.className = 'sr-err'; r.textContent = msg; if (msg && scroll) r.scrollIntoView?.({ block: 'center' }); };

  async function load() {
    try {
      st = await api('/api/reports');
      if (alive) draw();
    } catch (err) {
      if (alive) el.innerHTML = `<p class="sr-err">${esc(err.status === 403 ? 'Only admin accounts can see Help & feedback.' : err.message)}</p>`;
    }
  }

  async function guarded(fn, onCancel = null, onError = (msg) => say(msg, true)) {
    try {
      return await fn();
    } catch (err) {
      if (err.code === 'CONFIRM_PASSWORD') {
        retry = { fn, onCancel, onError };
        $('[data-confirm]').hidden = false;
        $('[data-confirm] input').focus();
        return undefined;
      }
      onError(err.message);
      onCancel?.();
      return undefined;
    }
  }

  /** The preview box, for a report to send or for a sample heartbeat (nothing to send). */
  function showPreview(title, payload, sample) {
    $('[data-pvtitle]').textContent = title;
    $('[data-pvjson]').textContent = JSON.stringify(payload, null, 2);
    $('[data-send]').parentElement.hidden = sample;
    $('[data-sampleclose]').hidden = !sample;
    $('[data-pv]').hidden = false;
    $('[data-pv]').scrollIntoView?.({ block: 'nearest' });
  }

  async function sampleHeartbeat() {
    say('');
    tell('');
    pending = null;
    try {
      const out = await api('/api/reports/preview', { method: 'POST', body: JSON.stringify({ kind: 'heartbeat' }) });
      showPreview(`What will be sent${out.payload.anonymous ? ' (anonymous)' : ''}: a heartbeat (a sample)`, out.payload, true);
    } catch (err) {
      tell(err.message);
    }
  }

  async function preview(kind) {
    say('');
    $('[data-result]').hidden = true;
    const body = kind === 'feedback'
      ? { kind, message: $('[data-msg]').value, contact: $('[data-contact]').value, attach: $('[data-attach]').checked }
      : { kind, message: $('[data-note]').value };
    if (kind === 'feedback' && !body.message.trim()) { tell('Write a message first.', false); $('[data-msg]').focus(); return; }
    const b = $(`[data-preview="${kind}"]`);
    b.disabled = true;
    try {
      const out = await api('/api/reports/preview', { method: 'POST', body: JSON.stringify(body) });
      pending = { kind, previewId: out.previewId };
      showPreview(`What will be sent${out.payload.anonymous ? ' (anonymous)' : ''}: ${kind === 'support' ? 'diagnostics to support' : 'feedback'}`, out.payload, false);
    } catch (err) {
      tell(err.message);
    }
    b.disabled = false;
  }

  async function send() {
    if (!pending) return;
    const p = pending;
    const b = $('[data-send]');
    b.disabled = true;
    const out = await guarded(() => api('/api/reports/send', { method: 'POST', body: JSON.stringify({ previewId: p.previewId }) }), () => { b.disabled = false; }, tell);
    if (!out || !alive) return;
    pending = null;
    st = out.status;
    draw();
    const r = $('[data-result]');
    r.hidden = false;
    if (out.result === 'sent') {
      r.className = 'sr-ok';
      r.innerHTML = `Sent, thank you.${out.ref ? ` Your reference: <span class="sr-ref">${esc(out.ref)}</span> (quote it to support).` : ''}`;
    } else if (out.result === 'retry') {
      r.className = '';
      r.textContent = `Not sent yet: ${out.message} It waits, sealed, and goes by itself.`;
    } else {
      r.className = 'sr-err';
      r.textContent = out.message || 'The report was refused.';
    }
  }

  async function setOption(k, on, box) {
    const fn = () => api('/api/reports/settings', { method: 'PUT', body: JSON.stringify({ [k]: on }) });
    const out = await guarded(fn, () => { box.checked = !on; });
    if (out && alive) {
      st = out;
      draw();
      say(k === 'share' ? (on ? 'Sharing diagnostics is on.' : 'Sharing diagnostics is off.') : (on ? 'Reports are now sent anonymously.' : 'Reports are no longer anonymous.'));
    }
  }

  el.addEventListener('input', (e) => {
    if (e.target.matches('[data-msg]')) $('[data-msgcount]').textContent = `${e.target.value.length} / 5000`;
    if (e.target.matches('[data-msg],[data-note],[data-contact],[data-attach]') && pending) { pending = null; $('[data-pv]').hidden = true; }
  });
  el.addEventListener('change', (e) => {
    const box = e.target.closest('[data-k]');
    if (!box) return;
    // one click: the switch saves at once (its text says what it sends)
    setOption(box.dataset.k, box.checked, box);
  });
  el.addEventListener('click', (e) => {
    const t = e.target;
    const pv = t.closest('[data-preview]');
    if (pv) preview(pv.dataset.preview);
    if (t.closest('[data-send]')) send();
    if (t.closest('[data-samplehb]')) { e.preventDefault(); if (!t.closest('[data-samplehb]').hasAttribute('disabled')) sampleHeartbeat(); }
    if (t.closest('[data-cancelpv]')) { pending = null; $('[data-pv]').hidden = true; }
    if (t.closest('[data-cancel]')) {
      $('[data-confirm]').hidden = true;
      retry?.onCancel?.();
      retry = null;
    }
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
        const out = await guarded(again.fn, again.onCancel, again.onError);
        if (out && alive) {
          if (out.status && out.kind) { // a send
            pending = null;
            st = out.status;
            draw();
            const r = $('[data-result]');
            r.hidden = false;
            r.className = out.result === 'sent' ? 'sr-ok' : out.result === 'retry' ? '' : 'sr-err';
            if (out.result === 'sent') r.innerHTML = `Sent, thank you.${out.ref ? ` Your reference: <span class="sr-ref">${esc(out.ref)}</span> (quote it to support).` : ''}`;
            else r.textContent = out.result === 'retry' ? `Not sent yet: ${out.message} It waits, sealed, and goes by itself.` : out.message || 'The report was refused.';
          } else { st = out; draw(); say('Saved.'); }
        }
      }
    } catch (err) {
      say(err.message, true);
    }
  });

  load();
  return { destroy() { alive = false; }, reload: load };
}
