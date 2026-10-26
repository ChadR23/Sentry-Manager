// Today: the owner's questions first. Is the footage safe? How much space is
// left? Is anything converting? Does anything need me?

import { api, esc, icon, bytes, plural, ago, pct, meter, emptyState, dayShort, fail, toast, busy, fin } from '../core.js';
import { state, vehicle, shareHealth, unreadCount, loadVehicles } from '../state.js';
import { follow, counts, STATE_WORDS, ACTIVE, PAUSED, Pace } from '../convert.js';
import { thumbUrl } from './footage.js';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function card({ tone = '', iconName, q, a, detail = '', body = '', action = '', pulse = false, id = '' }) {
  return `<article class="card status-card tone-${tone}"${id ? ` id="${id}"` : ''}>
    ${pulse ? '<span class="pulse" aria-hidden="true"></span>' : ''}
    <div class="status-icon">${icon(iconName)}</div>
    <p class="q">${esc(q)}</p>
    <p class="a">${a}</p>
    ${detail ? `<p class="detail">${detail}</p>` : ''}
    ${body}
    <div class="grow"></div>
    ${action}
  </article>`;
}

function safeCard() {
  const list = state.vehicles;
  if (!list.length) {
    return card({ tone: 'warn', iconName: 'car', q: 'Is my car’s footage safe?', a: 'Let’s add your car first', detail: 'Tell Sentry Six where your Tesla’s footage is kept and it will start looking after it.', action: '<a class="btn btn-primary" href="#/settings/add-vehicle">Add my vehicle</a>' });
  }
  const bad = list.filter((v) => !shareHealth(v).ok);
  if (bad.length) {
    const v = bad[0];
    return card({ tone: 'bad', iconName: 'alert', q: 'Is my car’s footage safe?', a: `${esc(v.name)}’s footage can’t be reached`, detail: esc(shareHealth(v).detail || 'The share or folder isn’t answering. Nothing is lost; we just can’t see it right now.'), action: `<button class="btn btn-primary" type="button" data-reconnect="${esc(v.id)}">${icon('refresh')} Try to reconnect</button>` });
  }
  const scanned = list.map((v) => v.inventory?.scannedAt).filter(Boolean);
  const last = scanned.length ? Math.max(...scanned) : null;
  const total = list.reduce((n, v) => n + (v.inventory?.recordings || 0), 0);
  const protectedHint = 'Sentry Six only ever moves footage to the Recycle Bin. Nothing is deleted unless you say so.';
  return card({ tone: 'good', iconName: 'shieldCheck', q: 'Is my car’s footage safe?', a: 'Yes, everything looks good', detail: `${plural(total, 'recording')} kept${last ? ` · checked ${ago(last)}` : ''}. ${protectedHint}`, action: '<a class="btn btn-soft" href="#/footage">Look at my footage</a>' });
}

function spaceCard() {
  const list = state.vehicles.filter((v) => fin(v.share?.totalBytes) && v.share.totalBytes > 0);
  if (!list.length) {
    return card({ iconName: 'disk', q: 'How much space is left?', a: 'We’ll know once connected', detail: 'Free space shows here as soon as a vehicle’s footage is reachable.', action: '<a class="btn btn-soft" href="#/settings/vehicles">Vehicle settings</a>' });
  }
  const v = list.reduce((a, b) => (a.share.freeBytes / a.share.totalBytes <= b.share.freeBytes / b.share.totalBytes ? a : b));
  const free = v.share.freeBytes;
  const used = 1 - free / v.share.totalBytes;
  const tone = used > 0.95 ? 'bad' : used > 0.85 ? 'warn' : 'good';
  const bin = state.vehicles.reduce((n, x) => n + (x.binBytes || 0), 0);
  const tip = tone === 'good' ? 'Plenty of room for now.' : bin > 0 ? `The Recycle Bin holds ${bytes(bin)} you could free up.` : 'Converting footage to a smaller format can win back a lot of room.';
  const action = tone === 'good'
    ? '<a class="btn btn-soft" href="#/encoder">Save even more space</a>'
    : bin > 0 ? '<a class="btn btn-primary" href="#/bin">Free up space</a>' : '<a class="btn btn-primary" href="#/encoder">Shrink my footage</a>';
  return card({
    tone, iconName: 'disk', q: 'How much space is left?', a: `${bytes(free)} free`,
    detail: `${list.length > 1 ? `${esc(v.name)} has the least room. ` : ''}${pct(used * 100)} of ${bytes(v.share.totalBytes)} used. ${tip}`,
    body: meter(used, tone === 'good' ? '' : tone) , action
  });
}

const pace = new Pace();
function convertCard(snap) {
  if (snap === undefined) return card({ iconName: 'encoder', q: 'Is anything converting?', a: 'Checking…', id: 'convert-card' });
  if (!snap || !ACTIVE.has(snap.state)) {
    const finished = snap && snap.state === 'completed' && !snap.summaryDismissed && snap.summary;
    return card({
      iconName: 'encoder', q: 'Is anything converting?', id: 'convert-card',
      a: finished ? `Finished: ${bytes(snap.summary.savedBytes)} saved` : 'Not right now',
      detail: finished ? `${plural(snap.summary.files, 'clip')} converted to a smaller format.` : 'Converting footage to H.265 or AV1 keeps every clip watchable and takes far less room.',
      action: '<a class="btn btn-soft" href="#/encoder">Open the Encoder</a>'
    });
  }
  const c = counts(snap);
  const frac = c.total ? c.done / c.total : 0;
  const p = pace.read(snap);
  const left = p.leftMs ? ` · about ${Math.max(1, Math.round(p.leftMs / 60000))} min left` : '';
  const paused = PAUSED.has(snap.state);
  return card({
    tone: paused ? 'warn' : '', iconName: 'encoder', q: 'Is anything converting?', pulse: !paused, id: 'convert-card',
    a: `${esc(STATE_WORDS[snap.state] || 'Converting')}${c.total ? ` · ${pct(frac * 100)}` : ''}`,
    detail: `${c.done.toLocaleString()} of ${c.total.toLocaleString()} clips done${left}.`,
    body: meter(frac, paused ? 'warn' : 'live'),
    action: '<a class="btn btn-primary" href="#/encoder">See progress</a>'
  });
}

function needsCard() {
  const open = state.openNotes;
  if (!open.length) {
    return card({ tone: 'good', iconName: 'checkCircle', q: 'Does anything need me?', a: 'Nothing at all', detail: 'You’ll see it here, and on the bell, if something ever does.', action: '<a class="btn btn-soft" href="#/notifications">Past alerts</a>' });
  }
  const worst = open.find((n) => n.level === 'critical') || open[0];
  const unread = unreadCount();
  return card({
    tone: worst.level === 'critical' ? 'bad' : 'warn', iconName: 'bell', q: 'Does anything need me?',
    a: open.length === 1 ? esc(worst.title) : `${open.length} things to look at`,
    detail: open.length === 1 ? esc(worst.message || '') : `Most important: ${esc(worst.title)}${unread ? ` · ${unread} new` : ''}`,
    action: `<a class="btn btn-primary" href="#/notifications">${open.length === 1 ? 'Take a look' : 'See all alerts'}</a>`
  });
}

function vehicleCard(v) {
  const h = shareHealth(v);
  const inv = v.inventory;
  return `<article class="card vehicle-card">
    <div class="vc-top"><div class="vc-icon">${icon('car')}</div>
      <div class="grow"><h3>${esc(v.name)}</h3><p class="small muted">${h.ok ? `<span class="chip chip-good">${esc(h.word)}</span>` : `<span class="chip chip-${h.tone}">${esc(h.word)}</span>`} ${v.scanning ? ' · looking for new footage…' : inv ? ` · checked ${ago(inv.scannedAt)}` : ''}</p></div></div>
    <div class="vc-stats">
      <div><b>${inv ? Number(inv.recordings).toLocaleString() : '—'}</b><span>recordings</span></div>
      <div><b>${inv ? bytes(inv.bytes) : '—'}</b><span>of footage</span></div>
      <div><b>${v.binItems || 0}</b><span>in Recycle Bin</span></div>
    </div>
    <div class="actions">
      <a class="btn btn-soft btn-sm" href="#/footage?vehicle=${encodeURIComponent(v.id)}">Footage</a>
      <button class="btn btn-sm" type="button" data-scan="${esc(v.id)}">${icon('refresh')} Look for new footage</button>
    </div>
  </article>`;
}

export async function render(ctx) {
  const { view } = ctx;
  let snap;
  let days = null;
  let health = null;

  const draw = () => {
    const now = new Date();
    view.innerHTML = `<div class="page">
      <div class="page-head hello"><div>
        <p class="eyebrow">${esc(now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}</p>
        <h1>${greeting()}</h1>
        <p class="lede">Here’s how your Tesla footage is doing today.</p></div></div>
      <section class="status-grid" aria-label="At a glance">${safeCard()}${spaceCard()}${convertCard(snap)}${needsCard()}</section>
      ${state.vehicles.length ? `<section class="section"><div class="section-head"><h2>Latest days</h2><a class="btn btn-ghost btn-sm" href="#/footage">All footage ${icon('next')}</a></div>
        <div class="days-strip" id="latest-days">${days === null ? '<div class="loading"><span class="spin"></span><span>Loading…</span></div>' : days.length ? days.map(dayTile).join('') : `<p class="muted">No footage yet. It shows up here once ${esc(vehicle()?.name || 'the car')} has recorded some.</p>`}</div></section>
      <section class="section"><div class="section-head"><h2>Your vehicles</h2><a class="btn btn-ghost btn-sm" href="#/settings/vehicles">Manage ${icon('next')}</a></div>
        <div class="vehicle-cards">${state.vehicles.map(vehicleCard).join('')}</div></section>` : ''}
      <section class="section"><div class="section-head"><h2>Server</h2><a class="btn btn-ghost btn-sm" href="#/server">Details &amp; logs ${icon('next')}</a></div>
        <div class="card" id="health">${healthBody(health)}</div></section>
    </div>`;
  };
  const dayTile = (d) => {
    const v = vehicle();
    return `<a class="card day-card" href="#/footage/${encodeURIComponent(d.day)}?vehicle=${encodeURIComponent(v.id)}">
      <div class="thumb">${d.thumbId ? `<img class="thumb-img" loading="lazy" alt="" src="${thumbUrl(v.id, d.thumbId)}">` : icon('film')}<span class="thumb-badge">${plural(d.recordings, 'recording')}</span></div>
      <div class="dc-body"><span class="dc-title">${esc(dayShort(d.day))}</span><span class="dc-meta">${d.minutes} min · ${bytes(d.bytes)}</span></div></a>`;
  };
  const healthBody = (s) => {
    if (!s) return '<div class="loading"><span class="spin"></span><span>Asking the server…</span></div>';
    const mem = s.memory && fin(s.memory.totalB) ? s.memory.usedB / s.memory.totalB : null;
    const alerts = (s.alerts || []).length;
    return `<div class="row-between"><div><p class="a" style="font-size:19px;font-weight:700">${alerts ? `${plural(alerts, 'warning')} on the server` : 'Running smoothly'}</p>
      <p class="muted small">${esc([s.host?.hostname, s.host?.appUptimeS ? `up ${Math.round(s.host.appUptimeS / 3600)} h` : ''].filter(Boolean).join(' · '))}</p></div>
      ${alerts ? '<span class="chip chip-warn">Needs a look</span>' : '<span class="chip chip-good">OK</span>'}</div>
      <div class="stat-row" style="margin-top:14px">
        <div class="stat"><span>Processor</span><b>${fin(s.cpu?.usage) ? pct(s.cpu.usage) : '—'}</b></div>
        <div class="stat"><span>Memory</span><b>${mem !== null ? pct(mem * 100) : '—'}</b></div>
        <div class="stat"><span>Power</span><b>${fin(s.power?.totalW) ? `${Math.round(s.power.totalW)} W` : '—'}</b></div>
        <div class="stat"><span>Data folder free</span><b>${fin(s.filesystems?.[0]?.freeB) ? bytes(s.filesystems[0].freeB) : '—'}</b></div>
      </div>`;
  };

  draw();
  wire();
  function wire() {
    view.querySelectorAll('[data-scan]').forEach((b) => {
      b.onclick = () => busy(b, () => api(`/api/vehicles/${encodeURIComponent(b.dataset.scan)}/scan`, { body: {} })
        .then(() => toast('Looking for new footage. This takes a moment.'), fail));
    });
    view.querySelectorAll('[data-reconnect]').forEach((b) => {
      b.onclick = () => busy(b, async () => {
        try {
          const out = await api(`/api/vehicles/${encodeURIComponent(b.dataset.reconnect)}/reconnect`, { body: {} });
          toast(out.share?.healthy ? 'Connected again.' : 'Still can’t reach it. Check the share’s address and password in Settings.', { kind: out.share?.healthy ? 'good' : 'bad' });
          await loadVehicles();
          redraw();
        } catch (err) { fail(err); }
      });
    });
  }
  const redraw = () => {
    if (!ctx.alive()) return;
    if (view.contains(document.activeElement) && document.activeElement !== view) {
      // only the parts that changed, so the focus stays put
      const cc = view.querySelector('#convert-card');
      if (cc) cc.outerHTML = convertCard(snap);
      return;
    }
    draw();
    wire();
  };

  const v = vehicle();
  if (v) {
    api(`/api/vehicles/${encodeURIComponent(v.id)}/days?limit=4`).then((d) => { days = d.days; redraw(); }, () => { days = []; redraw(); });
  }
  const loadHealth = () => api('/api/stats', { timeoutMs: 8000 }).then((s) => {
    health = s;
    const el = view.querySelector('#health');
    if (el) el.innerHTML = healthBody(s);
  }, () => {});
  setTimeout(loadHealth, 1500); // the second sample has real CPU numbers
  ctx.every(10000, loadHealth);

  let lastState = null;
  const stop = follow((s) => {
    const changedState = (s?.state || null) !== lastState;
    lastState = s?.state || null;
    snap = s;
    const cc = view.querySelector('#convert-card');
    if (cc && !changedState) cc.outerHTML = convertCard(snap);
    else redraw();
  });
  ctx.cleanup(stop);
  ctx.on('topics', (topics) => {
    if (topics.some((t) => ['vehicles', 'inventory', 'notifications', 'bin'].includes(t))) {
      if (topics.includes('inventory') && vehicle()) api(`/api/vehicles/${encodeURIComponent(vehicle().id)}/days?limit=4`).then((d) => { days = d.days; redraw(); }, () => {});
      else redraw();
    }
  });
}
