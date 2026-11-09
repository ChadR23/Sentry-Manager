// Sentry USB, the Pi in the car that archives the clips to the share: one
// line on the Footage page (and Per car) of every interface saying what it
// last did, from GET /api/vehicles/:id/sentry-usb (its status file on the
// share, docs/sentry-usb.md). Words here, markup and colours in each page.
//
//   sentryUsbView(status, { timeZone, h24 })  -> null (nothing to show) or
//     { tone: 'ok'|'busy'|'wait'|'bad'|'stale', text, line, details: [[label, value]], transferring,
//       record: null | { text, backfill: null | { days, done, total, running }, canBackfill } }
//     (record: the checksums Sentry Manager records for the Pi, status.record)
//   sentryUsbHtml(view, { open, tagClass })  -> '<details class="usb-status …">…' or ''
//   mountSentryUsb(el, vehicle, { tagClass, h24: () => bool })  -> { refresh(), destroy() }
//
// Times of day are the car's (its time zone; a clip's own name is the car's
// clock already). The line is kept short; the details say everything else.

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
const plural = (n, word) => `${num(n).toLocaleString('en-US')} ${word}${num(n) === 1 ? '' : 's'}`;
const fin = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

function size(b) {
  const n = num(b);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// a formatter in the car's zone, the browser's zone when the car's is unknown or invalid
function fmt(opts, timeZone, locale) {
  try { return new Intl.DateTimeFormat(locale, { ...opts, timeZone: timeZone || undefined }); } catch { return new Intl.DateTimeFormat(locale, opts); }
}
// YYYY-MM-DD of an instant in the car's zone
const dayKey = (ms, timeZone) => fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }, timeZone, 'en-CA').format(new Date(ms));

/** The Tesla clip time in a relpath (…/2026-11-08_12-59-00-front.mp4): { ms (as UTC wall clock), day } or null. */
export function clipTime(rel) {
  const all = [...String(rel || '').matchAll(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/g)];
  const m = all[all.length - 1];
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(ms) ? { ms, day: `${m[1]}-${m[2]}-${m[3]}` } : null;
}

function clock(timeZone, now, locale, h24) {
  const today = dayKey(now, timeZone);
  const year = today.slice(0, 4);
  const hm = { hour: h24 ? '2-digit' : 'numeric', minute: '2-digit', hour12: !h24 };
  const time = fmt(hm, timeZone, locale);
  const date = fmt({ month: 'short', day: 'numeric' }, timeZone, locale);
  const dateY = fmt({ month: 'short', day: 'numeric', year: 'numeric' }, timeZone, locale);
  const utc = (o) => fmt(o, 'UTC', locale);
  const cTime = utc(hm);
  const cDate = utc({ month: 'short', day: 'numeric' });
  const cDateY = utc({ month: 'short', day: 'numeric', year: 'numeric' });
  // a time of day, with the date when it is not today (or always, with full)
  const when = (ms, full = false) => {
    if (!fin(ms)) return '';
    const d = dayKey(ms, timeZone);
    if (d === today && !full) return time.format(ms);
    return `${(d.slice(0, 4) === year ? date : dateY).format(ms)}, ${time.format(ms)}`;
  };
  // a clip's own time (its name is the car's clock); the date when it is not today or not the day of ref
  const clip = (rel, ref = today) => {
    const t = clipTime(rel);
    if (!t) return '';
    if (t.day === ref) return cTime.format(t.ms);
    return `${(t.day.slice(0, 4) === year ? cDate : cDateY).format(t.ms)}, ${cTime.format(t.ms)}`;
  };
  return { when, clip, today };
}

const RESULT = { ok: 'ok', failed: 'failed', nothing_new: 'nothing new', in_progress: 'in progress' };

/** What the line and its details say, or null when there is no status file to show. */
export function sentryUsbView(s, { timeZone, now = Date.now(), locale, h24 = false } = {}) {
  if (!s || s.present !== true) return null;
  const { when, clip, today } = clock(timeZone, now, locale, h24);
  const a = s.archive || {};
  const ver = s.verification || null;
  const t = s.transfer || null;
  const at = fin(a.finishedAt) ? a.finishedAt : fin(s.writtenAt) ? s.writtenAt : null;

  // the checksum part of the line: "verified 120, 2 of them re-encoded by Sentry Manager"
  const verLine = () => {
    if (!ver || !ver.enabled) return '';
    if (!ver.ran) return num(ver.stillQueued) ? `${plural(ver.stillQueued, 'clip')} waiting to be verified` : '';
    const ok = num(ver.matched) + num(ver.converted);
    const parts = [];
    if (ok) parts.push(`verified ${ok.toLocaleString('en-US')}${num(ver.converted) ? `, ${num(ver.converted).toLocaleString('en-US')} of them re-encoded by Sentry Manager` : ''}`);
    if (num(ver.resending)) parts.push(`${plural(ver.resending, 'clip')} being re-sent`);
    if (ver.stopped) parts.push('checks stopped early');
    return parts.join(' · ');
  };

  let tone;
  let text;
  if (s.stale) {
    tone = 'stale';
    text = `not heard from since ${when(s.writtenAt, true) || 'a while'}`;
  } else if (s.state === 'transferring' && t) {
    tone = 'busy';
    const first = clip(t.firstClip);
    const firstDay = clipTime(t.firstClip)?.day || today;
    const last = clip(t.lastClip, firstDay);
    const range = first && last && t.firstClip !== t.lastClip ? ` (from ${first} to ${last})` : first ? ` (${first})` : '';
    text = `sending ${plural(t.files, 'clip')}${range}${fin(t.expectedFinishAt) ? ` · expected by ${when(t.expectedFinishAt)}` : ''}`;
  } else if (s.state === 'waiting') {
    tone = 'wait';
    const started = when(t?.startedAt || s.writtenAt);
    text = `waiting: the car left during the ${started ? `${started} ` : ''}transfer; ${t && num(t.files) ? `its ${plural(t.files, 'clip')}` : 'the clips'} stay on the Pi and arrive with the next archive`;
  } else if (a.result === 'failed') {
    tone = 'bad';
    text = [`last archive ${when(at)} failed`, num(a.filesNotArchived) ? `${plural(a.filesNotArchived, 'clip')} not sent, retried next archive` : 'retried next archive', num(a.filesArchived) ? `${plural(a.filesArchived, 'clip')} sent` : ''].filter(Boolean).join(' · ');
  } else if (a.result === 'in_progress') {
    tone = 'busy';
    text = `archiving since ${when(a.startedAt || s.writtenAt)}`;
  } else if (a.result === 'nothing_new') {
    tone = num(ver?.resending) || ver?.stopped ? 'bad' : 'ok';
    text = [`last archive ${when(at)} · nothing new`, verLine()].filter(Boolean).join(' · ');
  } else if (a.result === 'ok') {
    tone = num(ver?.resending) || ver?.stopped ? 'bad' : 'ok';
    text = [`last archive ${when(at)} ok`, plural(a.filesArchived, 'clip'), verLine()].filter(Boolean).join(' · ');
  } else {
    tone = 'ok';
    text = `no archive yet${fin(s.writtenAt) ? ` · status from ${when(s.writtenAt)}` : ''}`;
  }

  const details = [];
  const add = (label, value) => { if (value !== '' && value != null) details.push([label, String(value)]); };
  if (t && (s.state === 'transferring' || s.state === 'waiting')) {
    add(s.state === 'waiting' ? 'Unfinished transfer' : 'Sending', `${plural(t.files, 'clip')}${fin(t.bytes) ? `, ${size(t.bytes)}` : ''}`);
    const firstDay = clipTime(t.firstClip)?.day || today;
    if (t.firstClip) add('Clips', t.firstClip === t.lastClip || !t.lastClip ? clip(t.firstClip) : `${clip(t.firstClip)} to ${clip(t.lastClip, firstDay)}`);
    add('Transfer started', when(t.startedAt));
    if (s.state === 'transferring') add('Expected by', when(t.expectedFinishAt));
    add(s.state === 'waiting' ? 'Counted as waiting since' : 'Counted as waiting after', when(t.giveUpAt));
  }
  add('Last archive', a.result ? `${RESULT[a.result] || a.result}${fin(a.startedAt) ? `, started ${when(a.startedAt)}` : ''}${fin(a.finishedAt) ? `, finished ${when(a.finishedAt)}` : ''}` : 'none yet');
  if (a.result && a.result !== 'in_progress') add('Clips sent', num(a.filesArchived).toLocaleString('en-US'));
  if (num(a.filesNotArchived)) add('Clips not sent', `${num(a.filesNotArchived).toLocaleString('en-US')} (retried next archive)`);
  if (a.lastClip) add('Newest clip sent', `${clip(a.lastClip)}${String(a.lastClip).includes('/') ? ` (${String(a.lastClip).split('/')[0]})` : ''}`);
  if (!ver) add('Checksum checks', 'not reported');
  else if (!ver.enabled) add('Checksum checks', 'off');
  else {
    add('Checksum checks', ver.ran ? 'ran after this archive' : 'did not run this archive');
    if (ver.ran) {
      add('Matched the Pi', num(ver.matched).toLocaleString('en-US'));
      add('Re-encoded on the server', num(ver.converted).toLocaleString('en-US'));
      add('Being re-sent', num(ver.resending).toLocaleString('en-US'));
      add('No Pi copy', num(ver.noPiCopy).toLocaleString('en-US'));
    }
    add('Still queued', num(ver.stillQueued).toLocaleString('en-US'));
    if (ver.stopped) add('Stopped', ver.stopped === true ? 'yes' : ver.stopped);
  }
  const record = recordView(s.record, when);
  if (record) add('Checksums recorded', record.text);
  add('Auto-delete on the Pi', s.autoDeleteEnabled === true ? 'on' : s.autoDeleteEnabled === false ? 'off' : 'not reported');
  add('Device', s.device || '');
  add('Status written', when(s.writtenAt, true));
  add('Read by Sentry Manager', when(s.readAt, true));

  return { tone, text, line: `Sentry USB · ${text}`, details, transferring: s.state === 'transferring' && !s.stale, record };
}

// "12 clips today · last at 3:05 PM · 4 waiting": the clips whose SHA-256
// Sentry Manager wrote to the share's checksum record, so the Pi verifies them
// without reading them back
function recordView(r, when) {
  if (!r || r.enabled !== true) return null;
  const parts = [`${plural(r.today, 'clip')} today`];
  if (fin(r.lastAt)) parts.push(`last at ${when(r.lastAt)}`);
  else parts.push('none yet');
  if (num(r.pending)) parts.push(`${num(r.pending).toLocaleString('en-US')} waiting`);
  const b = r.backfill && typeof r.backfill === 'object' ? r.backfill : null;
  const backfill = b ? { days: num(b.days), done: num(b.done), total: b.total == null ? null : num(b.total), running: !fin(b.finishedAt) } : null;
  if (backfill) parts.push(backfill.running ? `last ${plural(backfill.days, 'day')}: ${backfill.total == null ? 'starting' : `${backfill.done.toLocaleString('en-US')} of ${backfill.total.toLocaleString('en-US')} looked at`}` : `last ${plural(backfill.days, 'day')} done`);
  return { text: parts.join(' · '), backfill, canBackfill: r.canBackfill === true };
}

/** The markup: a details element whose summary is the line (tag + text) and whose body lists the details. */
export function sentryUsbHtml(view, { open = false, tagClass = () => '', days = 30, note = '' } = {}) {
  if (!view) return '';
  return `<details class="usb-status usb-${view.tone}" data-usb${open ? ' open' : ''}>
    <summary><span class="usb-tag ${esc(tagClass(view.tone))}">Sentry USB</span><span class="usb-text">${esc(view.text)}</span></summary>
    <dl class="usb-details">${view.details.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    ${view.record?.canBackfill ? `<form class="usb-backfill" data-usb-backfill>
      <label>Record checksums for clips from the last <input type="number" name="days" min="1" max="365" value="${esc(days)}" inputmode="numeric" aria-label="Days"> days</label>
      <button type="submit"${view.record.backfill?.running ? ' disabled' : ''}>Record</button>
      <span class="usb-backfill-note" role="status" aria-live="polite">${esc(note)}</span>
    </form>` : ''}
  </details>`;
}

// the layout only (colours come from the page; :where keeps it easy to restyle)
const CSS = `
:where(.usb-status){margin:0 0 14px;border:1px solid rgba(127,127,127,.3);border-radius:10px;font-size:13.5px;line-height:1.45;max-width:100%;box-sizing:border-box}
:where(.usb-status) summary{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 12px;cursor:pointer;list-style:none}
:where(.usb-status) summary::-webkit-details-marker{display:none}
:where(.usb-status) summary::after{content:'Details \\25B8';margin-left:auto;font-size:12px;opacity:.65;white-space:nowrap}
:where(.usb-status[open]) summary::after{content:'Hide \\25BE'}
:where(.usb-status) summary:focus-visible{outline:2px solid currentColor;outline-offset:2px}
:where(.usb-status) .usb-tag{flex:none}
:where(.usb-status) .usb-text{min-width:0;flex:1 1 240px;overflow-wrap:anywhere}
:where(.usb-stale) .usb-text{opacity:.6}
:where(.usb-status) .usb-details{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px 18px;margin:0;padding:4px 12px 12px}
:where(.usb-status) .usb-details div{min-width:0}
:where(.usb-status) .usb-details dt{font-size:11.5px;opacity:.65;letter-spacing:.03em}
:where(.usb-status) .usb-details dd{margin:0;overflow-wrap:anywhere}
:where(.usb-status) .usb-backfill{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:0;padding:0 12px 12px;font-size:12.5px}
:where(.usb-status) .usb-backfill input{width:4.5em;font:inherit;padding:2px 4px;margin:0 4px;box-sizing:border-box;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.45);border-radius:6px}
:where(.usb-status) .usb-backfill button{font:inherit;padding:3px 10px;border-radius:6px;border:1px solid rgba(127,127,127,.45);background:transparent;color:inherit;cursor:pointer}
:where(.usb-status) .usb-backfill button[disabled]{opacity:.5;cursor:default}
:where(.usb-status) .usb-backfill-note{opacity:.75}
@media (max-width:600px){:where(.usb-status) .usb-details{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
`;
function addCss() {
  if (typeof document === 'undefined' || document.getElementById('sentry-usb-css')) return;
  const st = document.createElement('style');
  st.id = 'sentry-usb-css';
  st.textContent = CSS;
  document.head.append(st);
}

const POLL_MS = 60000;
const cache = new Map(); // vehicle id -> { s, at }

// a highlight inside el holds a redraw (the same rule as every live page)
function selecting(el) {
  try {
    const sel = getSelection();
    return Boolean(sel && !sel.isCollapsed && sel.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer));
  } catch { return false; }
}

/**
 * Shows the line in el for this vehicle: the last known status at once, then
 * the server's; every 60 s while Sentry USB is sending. el stays empty and
 * hidden when there is nothing to show (no status file, an older server).
 */
export function mountSentryUsb(el, vehicle, { tagClass, h24 = () => false } = {}) {
  let timer = null;
  let dead = false;
  let last = null;
  let days = 30; // the backfill form's days, kept across redraws
  let note = '';
  const id = vehicle?.id;
  const draw = (s) => {
    if (dead || !el.isConnected) return;
    if (selecting(el)) { clearTimeout(timer); timer = setTimeout(() => draw(s), 2000); return; }
    // (nor while the days are being typed)
    if (el.querySelector('[data-usb-backfill] input') === document.activeElement) { clearTimeout(timer); timer = setTimeout(() => draw(s), 2000); return; }
    const open = Boolean(el.querySelector('details[data-usb]')?.open);
    const input = el.querySelector('[data-usb-backfill] input[name="days"]');
    if (input && input.value) days = input.value;
    const view = sentryUsbView(s, { timeZone: vehicle?.timezone, h24: Boolean(h24()) });
    const html = sentryUsbHtml(view, { open, tagClass, days, note });
    if (html !== last) { el.innerHTML = html; last = html; }
    el.hidden = !html;
    clearTimeout(timer);
    // every 60 s while Sentry USB sends; every 10 s while older days are recorded
    if (view?.record?.backfill?.running) timer = setTimeout(load, 10000);
    else if (view?.transferring) timer = setTimeout(load, POLL_MS);
  };
  const load = async () => {
    if (dead || !id) return;
    let s;
    try {
      const r = await fetch(`/api/vehicles/${encodeURIComponent(id)}/sentry-usb`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'sentry-six-manager' } });
      s = r.ok ? await r.json() : { present: false };
    } catch {
      s = cache.get(id)?.s || { present: false };
    }
    cache.set(id, { s, at: Date.now() });
    draw(s);
  };
  // "Record checksums for clips from the last N days"
  const submit = async (ev) => {
    const form = ev.target.closest?.('[data-usb-backfill]');
    if (!form || !id) return;
    ev.preventDefault();
    days = form.querySelector('input[name="days"]')?.value || days;
    const button = form.querySelector('button');
    if (button) button.disabled = true;
    try {
      const r = await fetch(`/api/vehicles/${encodeURIComponent(id)}/sentry-usb/record`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'X-Requested-With': 'sentry-six-manager', 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: Number(days) })
      });
      const body = await r.json().catch(() => ({}));
      note = r.ok ? 'Started.' : body.error || `Could not start (${r.status}).`;
      if (r.ok) { cache.set(id, { s: body, at: Date.now() }); last = null; draw(body); return; }
    } catch {
      note = 'Could not reach Sentry Manager.';
    }
    last = null;
    draw(cache.get(id)?.s || { present: false });
  };
  el.addEventListener('submit', submit);
  addCss();
  el.classList.add('usb-slot');
  const known = cache.get(id);
  if (known) draw(known.s);
  else el.hidden = true;
  load();
  return {
    refresh: load,
    destroy() { dead = true; clearTimeout(timer); el.removeEventListener('submit', submit); }
  };
}
