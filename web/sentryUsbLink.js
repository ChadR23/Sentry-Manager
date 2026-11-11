// The Sentry USB page, the same in every interface: pair a Sentry USB (the Pi
// in the car) in a few guided steps, see it online or away, its status, and
// manage it over the link (docs/sentry-usb-link.md): settings, diagnostics,
// logs, updates, actions, snapshots, backups, and actions queued for when it
// is home. Plain markup (sentry-sul-*), colours inherited from the page.
//
//   const page = createSentryUsbPage(el, { h24: () => bool });   // page.destroy() when leaving
//
// Everything the Pi sends is untrusted: it is only ever put on the page as
// text (textContent, text nodes), never as markup.

const CSS = `
.sentry-sul{display:flex;flex-direction:column;gap:20px;font-size:14px;line-height:1.45;min-width:0}
.sentry-sul section{display:flex;flex-direction:column;gap:8px;min-width:0}
.sentry-sul h2{margin:0;font-size:17px}
.sentry-sul h3{margin:6px 0 0;font-size:14px}
.sentry-sul p{margin:0}
.sentry-sul .sul-muted{opacity:.72}
.sentry-sul .sul-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0}
.sentry-sul .sul-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:7px 12px;border-radius:7px;border:1px solid rgba(127,127,127,.45);font-weight:600;white-space:nowrap;text-align:center}
.sentry-sul .sul-btn:hover{background:rgba(127,127,127,.14)}
.sentry-sul .sul-btn:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.sentry-sul .sul-btn[disabled]{opacity:.5;cursor:default}
.sentry-sul .sul-btn.sul-main{background:rgba(127,127,127,.2)}
.sentry-sul .sul-btn.sul-danger{border-color:rgba(224,82,82,.7)}
.sentry-sul .sul-btn.sul-later{border-style:dashed}
.sentry-sul input,.sentry-sul select{box-sizing:border-box;padding:7px 9px;border-radius:7px;border:1px solid rgba(127,127,127,.45);background:transparent;color:inherit;font:inherit;min-width:0;max-width:100%}
.sentry-sul select option{color:#111}
.sentry-sul label.sul-field{display:flex;flex-direction:column;gap:3px;flex:1 1 180px;min-width:0}
.sentry-sul label.sul-field span{font-size:12px;opacity:.78}
.sentry-sul .sul-steps{margin:0;padding-left:22px;display:flex;flex-direction:column;gap:10px}
.sentry-sul .sul-box{border:1px solid rgba(127,127,127,.3);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.sentry-sul .sul-ok{color:#3ddc84;font-weight:700}
.sentry-sul .sul-bad{color:#ff7b7b;font-weight:700}
.sentry-sul .sul-warn{color:#e0a030;font-weight:700}
.sentry-sul .sul-err{color:#ff7b7b}
.sentry-sul .sul-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:#888;vertical-align:middle}
.sentry-sul .sul-dot.on{background:#3ddc84}
.sentry-sul .sul-fp{font:600 13px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.04em;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,250px),1fr));gap:0 14px;padding:6px 10px;border-radius:7px;background:rgba(127,127,127,.14);user-select:all;-webkit-user-select:all}
.sentry-sul .sul-count{font:700 22px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}
.sentry-sul .sul-code{display:flex;flex-wrap:wrap;gap:0 .2em;font:700 clamp(20px,6vw,48px)/1.15 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.04em;padding:10px 12px;border-radius:10px;background:rgba(127,127,127,.16);user-select:all;-webkit-user-select:all;align-self:flex-start;max-width:100%;box-sizing:border-box}
.sentry-sul .sul-code span{white-space:nowrap}
.sentry-sul .sul-code i{font-style:normal;opacity:.45}
.sentry-sul .sul-devs{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,240px),1fr));gap:10px}
.sentry-sul .sul-dev{all:unset;box-sizing:border-box;cursor:pointer;border:1px solid rgba(127,127,127,.3);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:2px;min-width:0}
.sentry-sul .sul-dev[aria-pressed="true"]{border-color:currentColor;background:rgba(127,127,127,.12)}
.sentry-sul .sul-dev b{overflow-wrap:anywhere}
.sentry-sul .sul-tabs{display:flex;flex-wrap:wrap;gap:6px}
.sentry-sul .sul-tabs button[aria-selected="true"]{background:rgba(127,127,127,.24)}
.sentry-sul .sul-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(46%,190px),1fr));gap:8px}
.sentry-sul .sul-flag{font-size:11px;font-weight:700;padding:1px 6px;border-radius:5px;white-space:nowrap;margin-right:4px;display:inline-block}
.sentry-sul .sul-flag.hijack{background:#c0392b;color:#fff}.sentry-sul .sul-flag.new{background:#2b6cb0;color:#fff}.sentry-sul .sul-flag.outside{background:#b7791f;color:#fff}
.sentry-sul .sul-stat{border:1px solid rgba(127,127,127,.22);border-radius:8px;padding:8px 10px;min-width:0}
.sentry-sul .sul-stat span{display:block;font-size:12px;opacity:.72}
.sentry-sul .sul-stat b{display:block;overflow-wrap:anywhere}
.sentry-sul table{border-collapse:collapse;width:100%}
.sentry-sul td,.sentry-sul th{padding:7px 10px 7px 0;border-top:1px solid rgba(127,127,127,.2);vertical-align:top;text-align:left}
.sentry-sul th{font-size:12px;opacity:.75;font-weight:600}
.sentry-sul .sul-scroll{overflow-x:auto;min-width:0}
.sentry-sul pre{margin:0;max-height:420px;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid rgba(127,127,127,.3);border-radius:7px;padding:8px 10px}
.sentry-sul .sul-cfg{display:flex;flex-wrap:wrap;gap:10px}
.sentry-sul .sul-cfg label.sul-field{flex:1 1 220px}
.sentry-sul .sul-cfg .sul-off input[type=text],.sentry-sul .sul-cfg .sul-off input[type=password]{opacity:.55}
.sentry-sul details{border-top:1px solid rgba(127,127,127,.2);padding-top:6px}
.sentry-sul summary{cursor:pointer;font-weight:700}
.sentry-sul .sul-tag{font-size:11px;font-weight:700;padding:1px 6px;border-radius:5px;background:rgba(127,127,127,.2);white-space:nowrap}
.sentry-sul .sul-confirm{border:1px solid rgba(224,160,48,.6)}
`;

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' };
async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const type = r.headers.get('content-type') || '';
  const d = type.includes('application/json') ? await r.json().catch(() => ({})) : await r.text().catch(() => '');
  if (!r.ok) throw Object.assign(new Error((d && typeof d === 'object' && typeof d.error === 'string' && d.error) || `That did not work (${r.status}).`), { code: d?.code, status: r.status });
  return d;
}

// ---- DOM from text only: h('b', { class: 'x' }, 'text', child, …)
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = Boolean(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const fill = (el, ...kids) => { el.replaceChildren(); for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c))); };
const btn = (text, onclick, extra = {}) => h('button', { type: 'button', class: `sul-btn${extra.cls ? ` ${extra.cls}` : ''}`, onclick, disabled: extra.disabled, title: extra.title }, text);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const size = (b) => { const n = num(b); if (n === null) return '—'; if (n < 1024) return `${n} B`; const u = ['KB', 'MB', 'GB', 'TB']; let v = n; let i = -1; do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1); return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`; };
const ago = (t) => {
  if (!t) return 'never';
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
const clockLeft = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const uptime = (secs) => { const s = num(secs); if (s === null) return '—'; const d = Math.floor(s / 86400); const hh = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60); return d ? `${d} d ${hh} h` : hh ? `${hh} h ${m} min` : `${m} min`; };

// why pairing did not work, in plain words: [headline, what to do]. A wrong code and a
// wrong password are one message, so neither is revealed (the proof cannot tell them apart).
const WRONG = 'Wrong pairing code or password';
const PAIR_WHY = {
  'wrong password': [WRONG, 'Check the code typed on the Sentry USB, and the web username and password entered here (its web login), then start again.'],
  'too many tries': [WRONG, 'Five tries with a wrong pairing code or password: pairing was stopped. Check them and start again for a new code.'],
  expired: ['Pairing window expired', 'No Sentry USB paired within 15 minutes. Start pairing again for a new code. The Sentry USB must reach port 10000 here: check the NAS firewall and that Docker publishes port 10000 (10000:10000).'],
  version: ['The Sentry USB needs updating', 'Update Sentry USB to test.30 or later, then start pairing again.']
};
/** [headline, detail] for a failed pairing (last.why from the server). */
export const pairWhy = (why) => PAIR_WHY[why] || ['Pairing did not work', `The Sentry USB was refused: ${why}.`];
// the device port's address as the owner types it on the Sentry USB
export const pairInstruction = (port = 10000) => `On the Sentry USB, open Settings → System → Sentry Manager, enter this Sentry Manager's address (the computer it runs on, port ${port}, for example 192.168.1.5:${port}) and this code, then press Pair.`;

// the Pi's setup config in groups (field names from its setup)
const GROUPS = [
  ['Wi-Fi and network', /^(SSID|WIFIPASS|AP_|SENTRYUSB_HOSTNAME|TIME_ZONE|HOTSPOT)/],
  ['Archive (where clips go)', /^(ARCHIVE_|SHARE_|CIFS_|RSYNC_|RCLONE_|MUSIC_SHARE)/],
  ['Drives and snapshots', /^(CAM_SIZE|MUSIC_SIZE|LIGHTSHOW_SIZE|BOOMBOX_SIZE|USE_EXFAT|DATA_DRIVE|SNAPSHOT_|DRIVE_MAP|SAMBA_)/],
  ['Web login', /^WEB_/],
  ['Notifications', /^(NOTIFICATION_|SIGNAL_|PUSHOVER_|GOTIFY_|IFTTT_|DISCORD_|SNS_|AWS_|TELEGRAM_|WEBHOOK_|SLACK_|MATRIX_|NTFY_|MOBILE_PUSH|TRIGGER_FILE)/],
  ['Car', /^(TESLA|TESSIE|TESLAFI|KEEP_AWAKE|SENTRY_CASE)/],
  ['System', /^(TEMPERATURE_|SYSTEM_TEMPERATURE|PRESSURE_|CPU_|DIRTY_|INCREASE_ROOT|INSTALL_USER|REPO)/]
];
// the Pi's own rules (its manager_link secrets.rs; server/sentryUsbLink.js has the same lists):
// which fields are secrets, which it lets Sentry Manager change, and the secret
// a changed destination needs again
const isSecretKey = (k) => k.includes('PASS') || k.includes('TOKEN') || k.includes('SECRET') || k.endsWith('_KEY') || k.endsWith('_KEY_ID') || k.endsWith('WEBHOOK_URL') || k === 'NTFY_URL' || k === 'IFTTT_KEY';
const SETTABLE = new Set(('SSID WIFIPASS AP_SSID AP_PASS AP_IP SENTRYUSB_HOSTNAME TIME_ZONE ARCHIVE_SYSTEM ARCHIVE_SERVER SHARE_NAME SHARE_USER SHARE_PASSWORD SHARE_DOMAIN '
  + 'CIFS_VERSION CIFS_SEC CIFS_NOSERVERINO RSYNC_USER RSYNC_SERVER RSYNC_PATH RSYNC_SSH_PORT RCLONE_DRIVE RCLONE_PATH MUSIC_SHARE_NAME ARCHIVE_DELAY ARCHIVE_STALL_GRACE_SECONDS '
  + 'ARCHIVE_RECENTCLIPS ARCHIVE_SAVEDCLIPS ARCHIVE_SENTRYCLIPS ARCHIVE_TRACKMODECLIPS ARCHIVE_VERIFY ARCHIVE_VERIFY_MODE ARCHIVE_VERIFY_MAX_SECONDS ARCHIVE_VERIFY_RECHECK_SECONDS '
  + 'ARCHIVE_VERIFY_PARALLEL ARCHIVE_VERIFY_MANAGER_WAIT_HOURS ARCHIVE_AUTO_DELETE_VERIFIED SNAPSHOT_INTERVAL TRIGGER_FILE_SAVED TRIGGER_FILE_SENTRY TRIGGER_FILE_RECENT TRIGGER_FILE_ANY '
  + 'SENTRY_CASE DRIVE_MAP_ENABLED DRIVE_MAP_UNIT DRIVE_MAP_WHILE_AWAY NOTIFICATION_TITLE PUSHOVER_ENABLED PUSHOVER_USER_KEY PUSHOVER_APP_KEY GOTIFY_ENABLED GOTIFY_DOMAIN '
  + 'GOTIFY_APP_TOKEN GOTIFY_PRIORITY DISCORD_ENABLED DISCORD_WEBHOOK_URL TELEGRAM_ENABLED TELEGRAM_CHAT_ID TELEGRAM_BOT_TOKEN TELEGRAM_SILENT_NOTIFY IFTTT_ENABLED IFTTT_EVENT_NAME '
  + 'IFTTT_KEY SLACK_ENABLED SLACK_WEBHOOK_URL SIGNAL_ENABLED SIGNAL_URL SIGNAL_FROM_NUM SIGNAL_TO_NUM MATRIX_ENABLED MATRIX_SERVER_URL MATRIX_USERNAME MATRIX_PASSWORD MATRIX_ROOM '
  + 'SNS_ENABLED AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SNS_TOPIC_ARN WEBHOOK_ENABLED WEBHOOK_URL NTFY_ENABLED NTFY_URL NTFY_TOKEN NTFY_PRIORITY MOBILE_PUSH_ENABLED '
  + 'KEEP_AWAKE_WEBHOOK_URL TESLAFI_API_TOKEN TESSIE_API_TOKEN TESSIE_VIN TESLA_BLE_VIN TEMPERATURE_WARNING TEMPERATURE_CAUTION TEMPERATURE_INTERVAL TEMPERATURE_POSTARCHIVE '
  + 'TEMPERATURE_UNIT SYSTEM_TEMPERATURE_UNIT PRESSURE_UNIT').split(' '));
const SECRET_TARGETS = {
  SHARE_PASSWORD: ['ARCHIVE_SYSTEM', 'ARCHIVE_SERVER', 'SHARE_USER', 'SHARE_DOMAIN'], WIFIPASS: ['SSID'], MATRIX_PASSWORD: ['MATRIX_SERVER_URL', 'MATRIX_USERNAME'],
  GOTIFY_APP_TOKEN: ['GOTIFY_DOMAIN'], NTFY_TOKEN: ['NTFY_URL'], AWS_SECRET_ACCESS_KEY: ['AWS_REGION', 'AWS_ACCESS_KEY_ID']
};
const UPDATE_TAG = /^(?!.*\.\.)[A-Za-z0-9._+-]{1,64}$/;
// passwords are never queued (server/sentryUsbQueue.js has the same words)
export const SECRETS_ONLINE_TEXT = 'Password changes need the Sentry USB online. Save them while it\'s connected.';
// a change split for the queue: secrets, and the fields that must go with one, wait for the Pi
export function splitHeld(c) {
  const keep = {};
  const held = [];
  for (const [k, v] of Object.entries(c)) {
    if (v.secret || isSecretKey(k)) held.push(k);
    else keep[k] = { from: v.from, to: v.to };
  }
  const tied = [];
  for (const [sec, targets] of Object.entries(SECRET_TARGETS)) {
    for (const t of targets) if (t in keep) { delete keep[t]; held.push(t); tied.push(`${t} goes with ${sec}`); }
  }
  return { keep, held, note: `${SECRETS_ONLINE_TEXT}${tied.length ? ` Also left for then: ${tied.join(', ')}.` : ''}` };
}

// the Pi's logs (fixed names: it has no route that lists them)
const LOG_NAMES = ['archiveloop', 'manager-link', 'setup', 'diagnostics', 'syslog', 'kern', 'auth', 'daemon', 'sentryusb', 'sentryusb-ble'];

export function createSentryUsbPage(el, { h24 = null } = {}) {
  if (!document.getElementById('sentry-sul-css')) {
    const style = document.createElement('style');
    style.id = 'sentry-sul-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const stamp = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', ...(typeof h24 === 'function' ? { hour12: !h24() } : {}) }) : '—');
  let alive = true;
  let info = null; // GET /api/sentryusb
  let selected = null;
  try { selected = localStorage.getItem('sentry-sul-device'); } catch { /* none */ }
  let tab = 'overview';
  let retry = null;
  const timers = new Set();
  const every = (fn, ms) => { const t = setInterval(() => { if (alive && !document.hidden) fn(); }, ms); timers.add(t); return t; };
  const stop = (t) => { clearInterval(t); timers.delete(t); };

  const root = h('div', { class: 'sentry-sul' });
  const noHttps = h('section', { hidden: true });
  const pairBox = h('section', { 'aria-labelledby': 'sul-add' });
  const devBox = h('section', { 'aria-labelledby': 'sul-devs' });
  const detail = h('section', {});
  const confirmForm = h('form', { class: 'sul-row sul-box sul-confirm', hidden: true },
    h('span', {}, 'Enter your Sentry Manager password to confirm:'),
    h('input', { type: 'password', name: 'password', autocomplete: 'current-password', 'aria-label': 'Your password', required: true }),
    h('button', { type: 'submit', class: 'sul-btn sul-main' }, 'Confirm'),
    btn('Cancel', () => { confirmForm.hidden = true; retry = null; }));
  const errLine = h('p', { class: 'sul-err', role: 'alert' });
  root.append(noHttps, pairBox, devBox, detail, confirmForm, errLine);
  el.replaceChildren(root);

  const fail = (err) => { errLine.textContent = err?.message || ''; };
  // an action that needs the password again asks for it, then runs again
  async function guarded(fn) {
    fail(null);
    try {
      return await fn();
    } catch (err) {
      if (err.code === 'CONFIRM_PASSWORD') {
        retry = fn;
        confirmForm.hidden = false;
        confirmForm.password.focus();
        return undefined;
      }
      fail(err);
      return undefined;
    }
  }
  confirmForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/confirm', { method: 'POST', body: JSON.stringify({ password: confirmForm.password.value }) });
      confirmForm.password.value = '';
      confirmForm.hidden = true;
      const again = retry;
      retry = null;
      if (again) await guarded(again);
    } catch (err) { fail(err); }
  });

  const dev = () => info?.devices?.find((d) => d.id === selected) || null;
  const proxy = (p, opts = {}) => api(`/api/sentryusb/${encodeURIComponent(selected)}/proxy${p}`, opts);
  const post = (p, body = null) => proxy(p, { method: 'POST', body: JSON.stringify(body) }); // (null: no body for the Pi)

  // ---------- data
  async function load() {
    const d = await api('/api/sentryusb').catch((err) => { fail(err); return null; });
    if (!alive || !d) return;
    const first = !info;
    const wasOnline = dev()?.online;
    info = d;
    if (!info.devices.some((x) => x.id === selected)) selected = info.devices[0]?.id || null;
    drawNoHttps();
    drawPair();
    drawDevices();
    // a Pi that came or went: the open tab redraws with what it can do now
    if (first || wasOnline !== dev()?.online) drawDetail();
    else refreshOverviewOnly();
  }

  function drawNoHttps() {
    noHttps.hidden = Boolean(info.https);
    if (!info.https) fill(noHttps, h('div', { class: 'sul-box' }, h('p', { class: 'sul-bad' }, 'Sentry Manager has no HTTPS of its own'), h('p', {}, info.noHttpsText || '')));
  }

  // ---------- pairing: the guided steps
  let countdown = null;
  let pairDrawn = '';
  function drawPair() {
    const pr = info.pairing || {};
    // redrawn only when something it shows changed: the poll must not wipe what is being typed
    const sig = JSON.stringify([pr, info.devices.length, info.https, info.fingerprint, info.port?.error]);
    if (sig === pairDrawn) return;
    pairDrawn = sig;
    // 16 groups of 4, as the Sentry USB shows it, in four rows
    const groups4 = info.fingerprint ? info.fingerprint.split(' ') : [];
    const fp = groups4.length ? [0, 4, 8, 12].map((i) => h('span', {}, groups4.slice(i, i + 4).join(' '))) : null;
    // for reference only: the pairing code is what proves it is this server, nothing has to be compared
    const fpBlock = fp ? [h('p', { class: 'sul-muted' }, 'For reference: Sentry Manager\'s certificate fingerprint (SHA-256). After pairing the Sentry USB shows the one it saved; nothing has to be compared.'), h('div', { class: 'sul-fp', 'aria-label': 'Certificate fingerprint' }, fp)] : null;
    const devicePort = info.port?.port || 10000;
    const portLine = info.port?.error ? h('p', { class: 'sul-bad' }, `Port ${info.port.port} could not open: ${info.port.error}`) : null;
    const last = pr.last;
    const result = last ? (last.ok
      ? h('div', { class: 'sul-box' }, h('p', { class: 'sul-ok' }, `Paired: ${last.name || 'Sentry USB'} is connected.`))
      : h('div', { class: 'sul-box' }, h('p', { class: 'sul-bad' }, pairWhy(last.why)[0]), h('p', {}, pairWhy(last.why)[1]))) : null;
    if (pr.open) {
      const left = h('span', { class: 'sul-count', 'aria-live': 'polite' }, clockLeft(pr.expiresAt - Date.now()));
      clearInterval(countdown);
      countdown = setInterval(() => { if (!alive) return; left.textContent = clockLeft(pr.expiresAt - Date.now()); }, 1000);
      timers.add(countdown);
      // the code: only the admin who opened the slot gets it (never a watch-only account)
      const codeEl = pr.code ? h('div', { class: 'sul-code', 'aria-label': `Pairing code ${pr.code.split('').join(' ')}` },
        pr.code.split('-').map((g, i) => [i ? h('i', { 'aria-hidden': 'true' }, '-') : null, h('span', {}, g)])) : null;
      const copied = h('span', { class: 'sul-muted', 'aria-live': 'polite' });
      const copy = pr.code ? btn('Copy code', async () => {
        try { await navigator.clipboard.writeText(pr.code); copied.textContent = 'Copied.'; } catch {
          // no clipboard (plain HTTP, an old browser): select it to copy by hand
          const r = document.createRange(); r.selectNodeContents(codeEl); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
          copied.textContent = 'Selected: copy it with Ctrl+C (or long-press).';
        }
        setTimeout(() => { copied.textContent = ''; }, 4000);
      }) : null;
      const wrongNow = last && !last.ok && last.why === 'version' ? h('p', { class: 'sul-bad' }, `${pairWhy('version')[0]}. ${pairWhy('version')[1]}`) : null;
      fill(pairBox, h('h2', { id: 'sul-add' }, 'Add a Sentry USB'),
        h('div', { class: 'sul-box' },
          h('p', {}, h('b', {}, `Pairing code for "${pr.name}"`)),
          codeEl || h('p', { class: 'sul-muted' }, 'The pairing code is shown only to the admin who started pairing.'),
          h('div', { class: 'sul-row' }, copy, copied),
          h('p', {}, pairInstruction(devicePort)),
          h('div', { class: 'sul-row' }, left, h('span', { class: 'sul-muted' }, 'left'), btn('Cancel', () => guarded(async () => { await api('/api/sentryusb/pair', { method: 'DELETE' }); await load(); }))),
          pr.failures ? h('p', { class: 'sul-warn' }, `${WRONG}: ${pr.failures} of 5 tries used (pairing stops after 5).`) : null,
          wrongNow,
          h('p', { class: 'sul-muted' }, 'The code works once, for 15 minutes. It is not saved anywhere: cancel or let it run out and start again for a new one.')),
        portLine, fpBlock);
      return;
    }
    clearInterval(countdown);
    const form = h('form', { class: 'sul-row' },
      h('label', { class: 'sul-field' }, h('span', {}, 'A name for it'), h('input', { name: 'name', placeholder: 'Model 3', required: true, maxlength: 40 })),
      h('label', { class: 'sul-field' }, h('span', {}, 'Sentry USB web username'), h('input', { name: 'username', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', required: true })),
      h('label', { class: 'sul-field' }, h('span', {}, 'Sentry USB web password'), h('input', { name: 'password', type: 'password', autocomplete: 'off', required: true })),
      h('button', { type: 'submit', class: 'sul-btn sul-main', disabled: !info.https }, 'Start pairing'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = JSON.stringify({ name: form.name.value, username: form.username.value, password: form.password.value });
      guarded(async () => { await api('/api/sentryusb/pair', { method: 'POST', body }); form.reset(); pairDrawn = ''; await load(); });
    });
    const many = info.devices.length > 0;
    const steps = h('ol', { class: 'sul-steps' },
      h('li', {}, h('b', {}, 'Here'), ', enter a name and the Sentry USB\'s web username and password, then press Start pairing. They are used once and not kept. (A Sentry USB without a web password cannot pair: set one there first.)', form),
      h('li', {}, 'Sentry Manager shows a ', h('b', {}, 'pairing code'), ' for 15 minutes. ', h('b', {}, 'On the Sentry USB'), ', open ', h('b', {}, 'Settings → System → Sentry Manager'), `, enter this Sentry Manager's address (the computer it runs on, port ${devicePort}, for example 192.168.1.5:${devicePort}) and the code, then press `, h('b', {}, 'Pair'), '.'),
      h('li', {}, 'Both sides then show Paired. Nothing has to be compared.'));
    const body = [h('h2', { id: 'sul-add' }, many ? 'Add another Sentry USB' : 'Add a Sentry USB'), result, steps, portLine, fpBlock];
    // with one paired: the steps fold away under "Add another"
    if (many && last?.ok !== false) fill(pairBox, result, h('details', {}, h('summary', {}, 'Add another Sentry USB'), h('div', { class: 'sul-box' }, steps, fpBlock)));
    else fill(pairBox, ...body);
  }

  // ---------- the devices
  function drawDevices() {
    if (!info.devices.length) { fill(devBox); return; }
    fill(devBox, h('h2', { id: 'sul-devs' }, 'Your Sentry USB'), h('div', { class: 'sul-devs' }, info.devices.map((d) => h('button', {
      type: 'button', class: 'sul-dev', 'aria-pressed': String(d.id === selected),
      onclick: () => { selected = d.id; try { localStorage.setItem('sentry-sul-device', d.id); } catch { /* none */ } drawDevices(); drawDetail(); }
    }, h('b', {}, h('span', { class: `sul-dot${d.online ? ' on' : ''}` }), d.name),
    h('span', {}, d.online ? 'Online now' : `Away · last seen ${ago(d.lastSeen)}`),
    h('span', { class: 'sul-muted' }, [d.version || 'version unknown', d.hostname].filter(Boolean).join(' · '))))));
  }

  // ---------- one device
  const TABS = [['overview', 'Status'], ['settings', 'Settings'], ['diagnostics', 'Diagnostics'], ['logs', 'Logs'], ['updates', 'Updates'], ['actions', 'Actions'], ['snapshots', 'Snapshots'], ['backups', 'Backups'], ['queue', 'Waiting for the Pi'], ['security', 'Security log'], ['device', 'Name and unpair']];
  let pane = null;
  let paneTimer = null;
  let overviewEl = null;
  function drawDetail() {
    stop(paneTimer);
    const d = dev();
    if (!d) { fill(detail); return; }
    pane = h('div', { class: 'sul-box', role: 'tabpanel' });
    fill(detail,
      h('div', { class: 'sul-row' }, h('h2', {}, d.name), h('span', { class: 'sul-tag' }, d.online ? 'online' : 'away')),
      d.online ? null : h('p', { class: 'sul-muted' }, `Away since ${stamp(d.lastSeen)}. What it showed last is below; actions can be queued and run when it is home.`),
      d.protocolError ? h('p', { class: 'sul-warn' }, `The last connection was closed: ${d.protocolError.why} (${stamp(d.protocolError.at)}).`) : null,
      h('div', { class: 'sul-tabs', role: 'tablist' }, TABS.map(([k, label]) => h('button', { type: 'button', class: 'sul-btn', role: 'tab', 'aria-selected': String(k === tab), onclick: () => { tab = k; drawDetail(); } }, label))),
      pane);
    ({ overview, settings, diagnostics, logs, updates, actions, snapshots, backups, queue, security, device })[tab]();
  }
  const offlineNote = () => h('p', { class: 'sul-muted' }, 'The Sentry USB is away: this needs it online. It shows here when it is back.');
  const loading = () => fill(pane, h('p', { class: 'sul-muted' }, 'Asking the Sentry USB…'));
  const showErr = (err) => fill(pane, h('p', { class: 'sul-err' }, err.message));

  // later: queue an action for when the Pi is home
  const later = (kind, label, params = null) => btn(label, () => guarded(async () => {
    await api(`/api/sentryusb/${encodeURIComponent(selected)}/queue`, { method: 'POST', body: JSON.stringify({ kind, params }) });
    tab = 'queue';
    drawDetail();
  }), { cls: 'sul-later' });

  // ---- Status: from the last status push, no request
  function stat(label, value) { return h('div', { class: 'sul-stat' }, h('span', {}, label), h('b', {}, value ?? '—')); }
  function overviewBody() {
    const d = dev();
    const s = d?.status;
    if (!s || typeof s !== 'object') return [h('p', { class: 'sul-muted' }, 'No status yet: it is sent when the Sentry USB connects.')];
    const temp = num(s.cpu_temp);
    const sh = s.storage_health && typeof s.storage_health === 'object' ? s.storage_health : null;
    const wifi = s.wifi_ssid ? `${s.wifi_ssid}${num(s.wifi_signal_dbm) !== null ? ` · ${s.wifi_signal_dbm} dBm` : ''}` : s.ether_ip ? 'Ethernet' : 'not connected';
    const net = d.net ? `${d.net.ssid || d.net.iface || '—'}${d.net.gw ? ` via ${d.net.gw}` : ''}` : null;
    return [
      h('p', { class: 'sul-muted' }, `${d.online ? 'Status' : 'Last status'} from ${stamp(d.statusAt)} (${ago(d.statusAt)}).`),
      h('div', { class: 'sul-grid' },
        stat('Connection', d.online ? 'Online' : `Away, last seen ${ago(d.lastSeen)}`),
        stat('Version', d.version),
        stat('USB drives', s.drives_active === 'yes' ? 'Presented to the car' : 'Off'),
        stat('Car writing', num(s.cam_last_write_secs) !== null && s.cam_last_write_secs >= 0 ? `${uptime(s.cam_last_write_secs)} ago` : '—'),
        stat('Free space', `${size(s.free_space)} of ${size(s.total_space)}`),
        stat('Storage', sh ? `${String(sh.state)}${sh.message ? ` · ${sh.message}` : ''}` : '—'),
        stat('Snapshots', s.num_snapshots),
        stat('Wi-Fi', wifi),
        stat('Address', s.wifi_ip || s.ether_ip || d.address),
        net ? stat('Network (it says)', net) : null,
        stat('Connects from', d.address),
        stat('CPU', `${temp !== null ? `${(temp / 1000).toFixed(1)} °C` : '—'}${num(s.cpu_percent) !== null ? ` · ${Math.round(s.cpu_percent)}%` : ''}`),
        stat('Supply', num(s.supply_voltage) !== null ? `${Number(s.supply_voltage).toFixed(2)} V` : '—'),
        stat('Up for', uptime(s.uptime)),
        stat('Board', s.sbc_model))
    ];
  }
  function overview() {
    overviewEl = pane;
    fill(pane, overviewBody());
  }
  function refreshOverviewOnly() {
    if (tab === 'overview' && overviewEl === pane && pane) fill(pane, overviewBody());
  }

  // ---- Settings: the setup config, grouped; secrets never shown
  async function settings() {
    const d = dev();
    loading();
    let cfg = null;
    let from = null;
    try {
      if (d.online) cfg = await proxy('/setup/config');
      else { const c = await api(`/api/sentryusb/${encodeURIComponent(selected)}/last-config`); cfg = c.config; from = c.at; }
    } catch (err) { return showErr(err); }
    if (!alive || tab !== 'settings') return undefined;
    if (!cfg) return fill(pane, offlineNote(), h('p', {}, 'Its settings have not been read yet: open this tab once while it is online.'));
    const keys = Object.keys(cfg).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k) && cfg[k] && typeof cfg[k] === 'object');
    const isSecret = (k) => isSecretKey(k) || cfg[`${k}__set`] === true;
    const inputs = new Map();
    const groups = new Map();
    for (const k of keys.sort()) {
      const g = (GROUPS.find(([, re]) => re.test(k)) || ['Other'])[0];
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(k);
    }
    const field = (k) => {
      const v = cfg[k];
      const secret = isSecret(k);
      // the web login, drive sizes, commands and anything it does not know: only on the Sentry USB itself
      const ro = !SETTABLE.has(k);
      const on = h('input', { type: 'checkbox', checked: v.active, disabled: ro, 'aria-label': `${k} in use` });
      const input = h('input', {
        type: secret ? 'password' : 'text', value: secret ? '' : String(v.value ?? ''), autocomplete: 'off', spellcheck: 'false', 'aria-label': k, readonly: ro, disabled: ro && secret,
        placeholder: secret ? (cfg[`${k}__set`] ? 'set, leave empty to keep' : 'not set') : ''
      });
      const wrap = h('label', { class: `sul-field${v.active ? '' : ' sul-off'}`, title: ro ? 'Change this on the Sentry USB itself' : null },
        h('span', {}, h('span', { class: 'sul-row' }, on, k, ro ? h('span', { class: 'sul-tag' }, 'on the Pi only') : null)), input);
      on.addEventListener('change', () => wrap.classList.toggle('sul-off', !on.checked));
      inputs.set(k, { on, input, secret, wrap, ro });
      return wrap;
    };
    // a field the Pi named, or one that must be filled: outlined and in view
    const point = (k) => {
      for (const { wrap } of inputs.values()) wrap.style.outline = '';
      const f = inputs.get(k);
      if (!f) return;
      f.wrap.closest('details')?.setAttribute('open', '');
      f.wrap.style.outline = '2px solid #e0a030';
      f.wrap.style.outlineOffset = '3px';
      f.input.focus();
    };
    // the Pi refuses a changed destination without its secret: say so before sending
    const needSecret = (c) => {
      for (const [sec, targets] of Object.entries(SECRET_TARGETS)) {
        const hit = targets.filter((t) => c[t]);
        if (hit.length && !(typeof c[sec]?.to === 'string' && c[sec].to !== '')) return { sec, hit };
      }
      return null;
    };
    const check = (c) => {
      const miss = needSecret(c);
      if (!miss) return true;
      status.textContent = `Changing ${miss.hit.join(', ')} needs ${miss.sec} entered again (the stored one is not sent to a new place).`;
      point(miss.sec);
      return false;
    };
    // the Pi's 400 names the key it refused
    const named = (err) => {
      const k = [...inputs.keys()].find((key) => new RegExp(`\\b${key}\\b`).test(err.message || ''));
      if (k) point(k);
      throw err;
    };
    // the fields changed here: { KEY: { from, to, secret } } (null: not in use)
    const changes = () => {
      const out = {};
      for (const [k, { on, input, secret, ro }] of inputs) {
        if (ro) continue;
        const before = cfg[k].active ? (secret ? '' : String(cfg[k].value ?? '')) : null;
        let after = on.checked ? input.value : null;
        if (secret && on.checked && input.value === '') after = cfg[k].active ? '' : null; // empty keeps it
        if (secret && after === '' && before === '') continue;
        if (after !== before) out[k] = { from: secret ? null : before, to: after, secret };
      }
      return out;
    };
    const full = () => {
      const out = {};
      for (const [k, { on, input }] of inputs) if (on.checked) out[k] = input.value;
      return out;
    };
    const status = h('p', { class: 'sul-muted', 'aria-live': 'polite' });
    const actionsRow = h('div', { class: 'sul-row' });
    const unmasked = cfg.__unmasked === true;
    if (unmasked) status.textContent = 'This Sentry USB sends its passwords unmasked: update it before changing settings from here.';
    if (d.online) {
      actionsRow.append(
        btn('Save', () => guarded(async () => {
          const c = changes();
          if (!Object.keys(c).length) { status.textContent = 'Nothing changed.'; return; }
          if (!check(c)) return;
          await proxy('/setup/config', { method: 'PUT', body: JSON.stringify(full()) }).catch(named);
          status.textContent = 'Saved. Apply (re-run setup) to use the new settings.';
        }), { cls: 'sul-main', disabled: unmasked }),
        btn('Apply (re-run setup)', () => guarded(async () => {
          if (!confirm('Re-run setup on the Sentry USB? It reboots and is away for a few minutes; recording pauses meanwhile.')) return;
          await post('/setup/run');
          status.textContent = 'Setup is running. The Sentry USB reboots and comes back by itself.';
        }), { disabled: unmasked }));
    } else {
      const queueIt = (apply) => guarded(async () => {
        const c = changes();
        if (!Object.keys(c).length) { status.textContent = 'Nothing changed.'; return; }
        // passwords are never sent to the queue: they stay in their fields, the rest is queued
        const { keep, held, note } = splitHeld(c);
        // the fields left for later are outlined; the note is brought into view
        const showHeld = (text) => {
          for (const { wrap } of inputs.values()) wrap.style.outline = '';
          for (const k of held) { const f = inputs.get(k); if (f) { f.wrap.style.outline = '2px solid #e0a030'; f.wrap.style.outlineOffset = '3px'; } }
          status.textContent = text;
          status.scrollIntoView({ block: 'center' });
        };
        if (!Object.keys(keep).length) { showHeld(note); return; }
        await api(`/api/sentryusb/${encodeURIComponent(selected)}/queue`, { method: 'POST', body: JSON.stringify({ kind: 'settings', params: { changes: keep, apply } }) }).catch(named);
        if (held.length) {
          const n = Object.keys(keep).length;
          showHeld(`Queued ${n} change${n === 1 ? '' : 's'} for when it is home; ${held.join(', ')} left as typed. ${note}`);
          return;
        }
        tab = 'queue';
        drawDetail();
      });
      actionsRow.append(btn('Save and apply when home', () => queueIt(true), { cls: 'sul-later sul-main', disabled: unmasked }), btn('Save when home', () => queueIt(false), { cls: 'sul-later', disabled: unmasked }));
    }
    fill(pane,
      d.online ? h('p', { class: 'sul-muted' }, 'The Sentry USB\'s setup settings. Passwords are never shown: leave one empty to keep it. Untick a setting to stop using it. Settings marked "on the Pi only" (the web login, drive sizes and a few more) can only be changed on the Sentry USB itself.')
        : h('p', { class: 'sul-muted' }, `Away: these are its settings as read ${stamp(from)}. Changes are queued; only the fields you change are applied when it is home, and a field changed on the Sentry USB meanwhile is left alone. ${SECRETS_ONLINE_TEXT}`),
      [...groups].map(([g, ks]) => h('details', { open: g === 'Wi-Fi and network' || g === 'Archive (where clips go)' }, h('summary', {}, `${g} (${ks.length})`), h('div', { class: 'sul-cfg' }, ks.map(field)))),
      actionsRow, status);
    return undefined;
  }

  // ---- Diagnostics
  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type: type || 'application/octet-stream' }));
    const a = h('a', { href: url, download: name.replace(/[^A-Za-z0-9_.-]/g, '_') });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  async function fetchBlob(p, opts = {}) {
    const r = await fetch(`/api/sentryusb/${encodeURIComponent(selected)}/proxy${p}`, { credentials: 'same-origin', ...opts, headers: { ...H, ...(opts.headers || {}) } });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw Object.assign(new Error(d.error || `That did not work (${r.status}).`), { code: d.code }); }
    return r.blob();
  }
  async function diagnostics() {
    const d = dev();
    if (!d.online) {
      return fill(pane, offlineNote(), h('div', { class: 'sul-row' }, later('diagnostics', 'Get diagnostics when home')),
        h('p', { class: 'sul-muted' }, 'Diagnostics fetched while it was home are under Waiting for the Pi.'));
    }
    const text = h('pre', {}, 'Loading…');
    const checks = h('div', {});
    const stampLine = h('p', { class: 'sul-muted' });
    const load2 = async () => {
      const [t, hc] = await Promise.all([proxy('/diagnostics').catch((err) => `(${err.message})`), proxy('/system/health-check').catch(() => null)]);
      if (!alive) return;
      text.textContent = typeof t === 'string' ? t : JSON.stringify(t, null, 2);
      stampLine.textContent = `Shown ${stamp(Date.now())}.`;
      if (hc && Array.isArray(hc.categories)) {
        fill(checks, h('p', {}, h('b', {}, 'Health check: '), String(hc.summary || '')), h('div', { class: 'sul-scroll' }, h('table', {}, h('tbody', {}, hc.categories.flatMap((c) => (Array.isArray(c.items) ? c.items : []).map((it) => h('tr', {},
          h('td', {}, String(c.name || '')), h('td', {}, String(it.name || '')),
          h('td', { class: it.status === 'pass' ? 'sul-ok' : it.status === 'fail' ? 'sul-bad' : 'sul-warn' }, String(it.status || '')), h('td', {}, String(it.detail || '')))))))));
      }
    };
    fill(pane, h('div', { class: 'sul-row' },
      btn('Refresh', () => guarded(async () => { text.textContent = 'Gathering diagnostics on the Sentry USB (up to a minute)…'; await post('/diagnostics/refresh'); await load2(); }), { cls: 'sul-main' }),
      btn('Download', () => guarded(async () => download(`sentryusb-${d.name}-diagnostics.txt`, await fetchBlob('/diagnostics/download', { method: 'POST', body: '{}' }), 'text/plain'))),
      later('diagnostics', 'Keep a copy here')), stampLine, checks, text);
    await load2();
    return undefined;
  }

  // ---- Logs: list, view, tail
  async function logs() {
    const d = dev();
    if (!d.online) return fill(pane, offlineNote());
    const names = LOG_NAMES;
    const pick = h('select', { 'aria-label': 'Log' }, names.map((n) => h('option', { value: n }, n)));
    const out = h('pre', {}, '');
    const tailBox = h('input', { type: 'checkbox', 'aria-label': 'Follow new lines' });
    let cursor = null;
    let tailT = null;
    const show = () => guarded(async () => {
      stop(tailT);
      tailBox.checked = false;
      out.textContent = 'Loading…';
      const pg = await proxy(`/logs/${encodeURIComponent(pick.value)}/page?lines=300`).catch(async () => ({ content: await proxy(`/logs/${encodeURIComponent(pick.value)}`) }));
      out.textContent = typeof pg?.content === 'string' ? pg.content : String(pg ?? '');
      cursor = null;
      out.scrollTop = out.scrollHeight;
    });
    const tail = async () => {
      const r = await proxy(`/logs/${encodeURIComponent(pick.value)}/tail${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`).catch((err) => { fail(err); return null; });
      if (!r || !alive) return;
      if (typeof r.cursor === 'string') cursor = r.cursor.slice(0, 512);
      const add = typeof r.content === 'string' ? r.content : '';
      if (r.reset) out.textContent = add;
      else if (add && cursor) out.textContent = (out.textContent + add).slice(-400_000);
      out.scrollTop = out.scrollHeight;
    };
    tailBox.addEventListener('change', () => {
      stop(tailT);
      if (!tailBox.checked) return;
      cursor = null;
      tail().then(() => { tailT = every(tail, 3000); paneTimer = tailT; });
    });
    pick.addEventListener('change', show);
    fill(pane, h('div', { class: 'sul-row' }, pick, btn('Refresh', show), h('label', { class: 'sul-row' }, tailBox, 'Follow new lines')), out);
    show();
    return undefined;
  }

  // ---- Updates
  async function updates() {
    const d = dev();
    if (!d.online) return fill(pane, h('p', {}, `Installed: ${d.version || 'unknown'}.`), offlineNote(), h('div', { class: 'sul-row' }, later('update', 'Install update when home')), h('p', { class: 'sul-muted' }, 'When home it checks for a newer version, and installs it once no archive is running.'));
    const box = h('div', { class: 'sul-box' }, 'Loading…');
    const progress = h('p', { 'aria-live': 'polite' });
    const draw = (v, st) => {
      // the Pi gives the latest stable release as latest_version, and test builds under prerelease
      const pre = st?.prerelease && typeof st.prerelease === 'object' && st.prerelease.version ? st.prerelease : null;
      const stableAvail = Boolean(st?.update_available);
      const target = stableAvail ? String(st.latest_version || '') : pre?.available ? String(pre.version) : null;
      const avail = Boolean(target);
      const line = (label, version, newer) => h('p', {}, h('b', {}, label), String(version), newer ? h('span', { class: 'sul-ok' }, '  (newer)') : ' (up to date)');
      const checked = Boolean(st?.checked_at);
      fill(box,
        h('p', {}, h('b', {}, 'Installed: '), String(v?.version || d.version || 'unknown'), v?.sbc_model ? ` · ${v.sbc_model}` : ''),
        st?.latest_version ? line('Latest: ', st.latest_version, stableAvail) : checked ? h('p', { class: 'sul-muted' }, 'No stable release yet.') : h('p', { class: 'sul-muted' }, 'Not checked yet.'),
        pre ? line('Latest test build: ', pre.version, Boolean(pre.available)) : null,
        st?.checked_at ? h('p', { class: 'sul-muted' }, `Checked ${stamp(Date.parse(st.checked_at))}${st.source_repo ? ` · from ${st.source_repo}` : ''}`) : null,
        st?.error ? h('p', { class: 'sul-err' }, String(st.error)) : null,
        st?.release_notes ? h('details', {}, h('summary', {}, 'What is new'), h('pre', {}, String(st.release_notes))) : null,
        h('div', { class: 'sul-row' },
          btn('Check now', () => guarded(async () => { fill(box, 'Checking…'); draw(v, await post('/system/check-update')); }), { cls: 'sul-main' }),
          btn('Install update', () => guarded(async () => {
            if (!confirm(`Install ${target || 'the update'} on the Sentry USB? It restarts when done and is away for a few minutes.`)) return;
            // the Pi takes no body (the latest) or a plain version tag
            await post('/system/update', typeof target === 'string' && UPDATE_TAG.test(target) ? { version: target } : null);
            follow(v?.boot_id || null);
          }), { disabled: !avail })),
        progress);
    };
    // update-status and the version, until the Pi has restarted on the new one
    const follow = (bootBefore) => {
      const t0 = Date.now();
      progress.textContent = 'Installing… the Sentry USB restarts by itself when done.';
      stop(paneTimer);
      paneTimer = every(async () => {
        const st = await proxy('/system/update-status').catch(() => null);
        const v = await proxy('/system/version').catch(() => null);
        if (!alive) return;
        if (st?.status === 'error' || st?.error) { progress.textContent = `The update failed: ${String(st.error || st.message || '')}`; stop(paneTimer); return; }
        if (v?.boot_id && bootBefore && v.boot_id !== bootBefore) { progress.textContent = `Done: now on ${String(v.version || '')}.`; stop(paneTimer); load(); return; }
        const phase = st?.status || st?.message || (v ? 'installing' : 'restarting');
        progress.textContent = `Installing… (${String(phase)}, ${Math.round((Date.now() - t0) / 1000)} s)`;
      }, 3000);
    };
    fill(pane, box);
    const [v, st] = await Promise.all([proxy('/system/version').catch(() => null), proxy('/system/update-status').catch(() => null)]);
    if (alive && tab === 'updates') draw(v, st);
    return undefined;
  }

  // ---- Actions
  function actions() {
    const d = dev();
    const run = (label, p, ask, body) => btn(label, () => guarded(async () => {
      if (ask && !confirm(ask)) return;
      const r = await post(p, body);
      say.textContent = `${label}: ${r?.message || 'done'}.`;
    }), { cls: ask ? 'sul-danger' : '' });
    const say = h('p', { 'aria-live': 'polite' });
    const drives = d.status?.drives_active === 'yes';
    if (!d.online) {
      return fill(pane, offlineNote(), h('div', { class: 'sul-row' }, later('reboot', 'Reboot when home'), later('sync', 'Sync when home')),
        h('p', { class: 'sul-muted' }, 'Shut down, Cancel archive and the drives need it online.'));
    }
    fill(pane, h('div', { class: 'sul-row' },
      run('Sync now', '/system/trigger-sync'),
      run('Cancel archive', '/system/cancel-archive', 'Stop the archive that is running? Clips not sent yet stay on the Sentry USB and go with the next one.'),
      run(drives ? 'Turn drives off' : 'Turn drives on', '/system/toggle-drives', drives ? 'Turn the USB drives off? The car stops recording to the Sentry USB until they are on again.' : null),
      run('Reboot', '/system/reboot', 'Reboot the Sentry USB? It is away for a minute or two, and recording pauses meanwhile.'),
      run('Shut down', '/system/shutdown', 'Shut the Sentry USB down? It stays off until it loses and gets power again (the car sleeping and waking, or unplugging it).')), say);
    return undefined;
  }

  // ---- Snapshots
  async function snapshots() {
    const d = dev();
    if (!d.online) return fill(pane, offlineNote());
    loading();
    let r;
    try { r = await proxy('/snapshots'); } catch (err) { return showErr(err); }
    if (!alive || tab !== 'snapshots') return undefined;
    const list = Array.isArray(r?.snapshots) ? r.snapshots : [];
    fill(pane,
      h('p', { class: 'sul-muted' }, `${list.length} snapshot${list.length === 1 ? '' : 's'}, oldest first. Deleting one frees the space shown (with every older one).`),
      list.length ? h('div', { class: 'sul-scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Snapshot'), h('th', {}, 'Taken'), h('th', {}, 'On the archive'), h('th', {}, 'Frees'), h('th', {}))),
        h('tbody', {}, list.map((s) => h('tr', {},
          h('td', {}, String(s.id || '')), h('td', {}, num(s.created_unix) ? stamp(s.created_unix * 1000) : '—'),
          h('td', {}, s.archive ? `${String(s.archive.state || '')}${num(s.archive.clips) !== null ? ` · ${s.archive.verified || 0} of ${s.archive.clips} clips` : ''}` : '—'),
          h('td', {}, s.cumulative_reclaim_bytes == null ? 'measuring' : size(s.cumulative_reclaim_bytes)),
          h('td', {}, btn('Delete', () => guarded(async () => {
            if (!confirm(`Delete snapshot ${s.id}? Its clips are gone from the Sentry USB (archived ones stay on the share).`)) return;
            await proxy(`/snapshots/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
            await snapshots();
          }), { cls: 'sul-danger' }))))))) : null);
    return undefined;
  }

  // ---- Backups
  async function backups() {
    const d = dev();
    const where = h('p', { class: 'sul-muted' }, 'A backup holds every password and the car key, so it never leaves the Sentry USB over the link: it is written to the archive share (or kept on the Sentry USB), and restored on the Sentry USB itself.');
    if (!d.online) return fill(pane, offlineNote(), h('div', { class: 'sul-row' }, later('backup', 'Create a backup when home')), where);
    loading();
    let list;
    try { list = await proxy('/system/backups'); } catch (err) { return showErr(err); }
    if (!alive || tab !== 'backups') return undefined;
    list = Array.isArray(list) ? list : [];
    const say = h('p', { 'aria-live': 'polite' });
    fill(pane,
      h('div', { class: 'sul-row' }, btn('Create a backup', () => guarded(async () => { const r = await post('/system/backup'); say.textContent = r?.skipped ? 'No changes since the last backup.' : `Backup ${String(r?.date || '')} made.`; await backups(); }), { cls: 'sul-main' })),
      say, where,
      list.length ? h('div', { class: 'sul-scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Where'), h('th', {}, 'Size'), h('th', {}, 'File'))),
        h('tbody', {}, list.map((b) => h('tr', {}, h('td', {}, String(b.date || '')), h('td', {}, b.location === 'archive' ? 'archive share' : 'on the Sentry USB'), h('td', {}, size(b.size)), h('td', {}, String(b.filename || ''))))))) : h('p', { class: 'sul-muted' }, 'No backups yet.'));
    return undefined;
  }

  // ---- Waiting for the Pi: queued actions, results, fetched files
  async function queue(quiet = false) {
    let q;
    try { q = await api(`/api/sentryusb/${encodeURIComponent(selected)}/queue`); } catch (err) { if (!quiet) showErr(err); return; }
    if (!alive || tab !== 'queue') return;
    const d = dev();
    const STATE = { queued: 'waiting', running: 'running', done: 'done', failed: 'failed', expired: 'expired', cancelled: 'cancelled', interrupted: 'interrupted' };
    const what = (it) => `${it.label || it.kind}${it.params?.fields?.length ? `: ${it.params.fields.join(', ')}${it.params.apply ? ', then re-run setup' : ''}` : ''}`;
    fill(pane,
      h('h3', {}, 'Waiting for the Pi'),
      q.queued.length ? h('div', { class: 'sul-scroll' }, h('table', {}, h('tbody', {}, q.queued.map((it) => h('tr', {},
        h('td', {}, h('b', {}, what(it)), h('br'), h('span', { class: 'sul-muted' }, `queued ${stamp(it.createdAt)}${it.by ? ` by ${it.by}` : ''} · expires ${stamp(it.expiresAt)}`), it.note ? [h('br'), h('span', { class: 'sul-warn' }, it.note)] : null),
        h('td', {}, h('span', { class: 'sul-tag' }, STATE[it.state] || it.state)),
        h('td', {}, it.state === 'queued' ? btn('Cancel', () => guarded(async () => { await api(`/api/sentryusb/${encodeURIComponent(selected)}/queue/${encodeURIComponent(it.id)}`, { method: 'DELETE' }); await queue(); })) : null)))))) : h('p', { class: 'sul-muted' }, 'Nothing waiting.'),
      d && !d.online ? h('div', { class: 'sul-row' }, h('span', { class: 'sul-muted' }, 'Add:'), later('update', 'Install update'), later('reboot', 'Reboot'), later('sync', 'Sync'), later('diagnostics', 'Get diagnostics'), later('backup', 'Backup')) : h('p', { class: 'sul-muted' }, 'Queued actions run in order once the Sentry USB is home; update and reboot go last, after any archive.'),
      h('h3', {}, 'Fetched files'),
      q.files.length ? h('div', { class: 'sul-scroll' }, h('table', {}, h('tbody', {}, q.files.map((f) => h('tr', {}, h('td', {}, f.name), h('td', {}, size(f.bytes)), h('td', {}, stamp(f.at)),
        h('td', {}, h('a', { class: 'sul-btn', href: `/api/sentryusb/${encodeURIComponent(selected)}/files/${encodeURIComponent(f.name)}`, download: f.name }, 'Download'))))))) : h('p', { class: 'sul-muted' }, 'None yet. Diagnostics fetched when it is home are kept here (the newest 5).'),
      h('h3', {}, 'Results'),
      q.results.length ? h('div', { class: 'sul-scroll' }, h('table', {}, h('tbody', {}, q.results.slice(0, 30).map((it) => h('tr', {},
        h('td', {}, h('b', {}, what(it)), h('br'), h('span', { class: 'sul-muted' }, `${stamp(it.finishedAt)}${it.result?.message ? ` · ${it.result.message}` : ''}`)),
        h('td', { class: it.state === 'done' ? 'sul-ok' : it.state === 'cancelled' ? 'sul-muted' : 'sul-bad' }, STATE[it.state] || it.state)))))) : h('p', { class: 'sul-muted' }, 'No results yet.'));
    if (!quiet) { stop(paneTimer); paneTimer = every(() => queue(true), 5000); }
  }

  // ---- Security log: every connection, attempt and action, with its flags (admins)
  const FLAG_WORD = { new: 'new address', outside: 'outside home', hijack: 'possible hijack attempt' };
  let secFilter = 'all';
  let secScope = 'this';
  async function security() {
    const d = dev();
    const params = () => `filter=${encodeURIComponent(secFilter)}${secScope === 'this' ? `&device=${encodeURIComponent(selected)}` : ''}`;
    let r;
    try { r = await api(`/api/sentryusb/security?${params()}&limit=300`); } catch (err) { return showErr(err); }
    if (!alive || tab !== 'security') return undefined;
    const filter = h('select', { 'aria-label': 'Show' }, [['all', 'Everything'], ['attempts', 'Attempts'], ['network', 'New or outside'], ['actions', 'Actions']].map(([k, l]) => h('option', { value: k, selected: k === secFilter }, l)));
    const scope = h('select', { 'aria-label': 'Which' }, h('option', { value: 'this', selected: secScope === 'this' }, `${d.name} only`), h('option', { value: 'all', selected: secScope === 'all' }, 'Every Sentry USB and unknown callers'));
    filter.addEventListener('change', () => { secFilter = filter.value; security(); });
    scope.addEventListener('change', () => { secScope = scope.value; security(); });
    const name = (id) => info.devices.find((x) => x.id === id)?.name || id || '';
    const notify = h('input', { type: 'checkbox', checked: d.notifyNetwork !== false, 'aria-label': 'Notify about a new address or outside home' });
    notify.addEventListener('change', () => guarded(async () => { await api(`/api/sentryusb/${encodeURIComponent(selected)}`, { method: 'PATCH', body: JSON.stringify({ notifyNetwork: notify.checked }) }); await load(); }));
    const ssid = h('input', { value: d.home?.ssid || '', placeholder: 'learned', 'aria-label': 'Home Wi-Fi name', maxlength: 64 });
    const gw = h('input', { value: d.home?.gw || '', placeholder: 'learned', 'aria-label': 'Home gateway', maxlength: 64 });
    const days = h('input', { type: 'number', min: 7, max: 3650, value: r.keepDays, 'aria-label': 'Days kept', style: 'width:90px' });
    fill(pane,
      h('div', { class: 'sul-row' }, filter, scope, h('a', { class: 'sul-btn', href: `/api/sentryusb/security.csv?${params()}`, download: '' }, 'Export CSV')),
      h('div', { class: 'sul-scroll' }, r.rows.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'What'), h('th', {}, 'From'), h('th', {}, 'Detail'))),
        h('tbody', {}, r.rows.map((x) => h('tr', {},
          h('td', {}, stamp(x.at), x.count > 1 ? [h('br'), h('span', { class: 'sul-muted' }, `${x.count} times, last ${stamp(x.lastAt)}`)] : null),
          h('td', {}, x.flags.map((f) => h('span', { class: `sul-flag ${f}` }, FLAG_WORD[f] || f)), h('b', {}, x.what), x.deviceId && secScope === 'all' ? [h('br'), h('span', { class: 'sul-muted' }, name(x.deviceId))] : null, x.who ? [h('br'), h('span', { class: 'sul-muted' }, `by ${x.who}`)] : null),
          h('td', {}, x.ip ? `${x.ip}${x.port ? `:${x.port}` : ''}` : ''),
          h('td', {}, x.detail || '')))))
        : h('p', { class: 'sul-muted' }, 'Nothing logged here yet.')),
      h('details', {}, h('summary', {}, 'Settings'),
        h('div', { class: 'sul-box' },
          h('label', { class: 'sul-row' }, notify, 'Notify me when it connects from a new address or outside home (a possible hijack attempt is always notified)'),
          h('p', { class: 'sul-muted' }, 'Home network: learned from the one it uses most (last 30 days), or set here.'),
          h('div', { class: 'sul-row' }, ssid, gw, btn('Save home network', () => guarded(async () => { await api(`/api/sentryusb/${encodeURIComponent(selected)}`, { method: 'PATCH', body: JSON.stringify({ home: { ssid: ssid.value, gw: gw.value } }) }); await load(); }))),
          h('div', { class: 'sul-row' }, h('span', {}, 'Keep the log for'), days, h('span', {}, 'days'), btn('Save', () => guarded(async () => { await api('/api/sentryusb/security/settings', { method: 'PUT', body: JSON.stringify({ days: Number(days.value) }) }); }))))));
    return undefined;
  }

  // ---- name and unpair
  function device() {
    const d = dev();
    const name = h('input', { value: d.name, maxlength: 40, 'aria-label': 'Name' });
    fill(pane,
      h('div', { class: 'sul-row' }, name, btn('Rename', () => guarded(async () => { await api(`/api/sentryusb/${encodeURIComponent(selected)}`, { method: 'PATCH', body: JSON.stringify({ name: name.value }) }); await load(); drawDetail(); }))),
      h('p', { class: 'sul-muted' }, `Paired ${stamp(d.pairedAt)} · id ${d.id}${d.hostname ? ` · ${d.hostname}` : ''}`),
      h('div', { class: 'sul-row' }, btn('Unpair', () => guarded(async () => {
        if (!confirm(`Unpair "${d.name}"? Sentry Manager forgets its link key and what it queued; the Sentry USB shows "not paired" the next time it connects.`)) return;
        await api(`/api/sentryusb/${encodeURIComponent(selected)}`, { method: 'DELETE' });
        selected = null;
        await load();
        drawDetail();
      }), { cls: 'sul-danger' })));
  }

  load();
  every(load, 5000);
  return { destroy() { alive = false; for (const t of timers) clearInterval(t); clearInterval(countdown); el.replaceChildren(); } };
}
