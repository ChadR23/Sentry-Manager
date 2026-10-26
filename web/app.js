'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(`sm:${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`sm:${k}`, JSON.stringify(v)); } catch { /* private mode */ } }
  };

  function bytes(n) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
    const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let v = Number(n);
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
  }
  const plural = (n, w) => `${Number(n || 0).toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  const when = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
  // how long a job took: 42 s, 12 m 5 s, 8 h 0 m
  function took(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} m ${s % 60} s`;
    return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} m`;
  }
  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  }
  const humanize = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

  async function api(path, opts = {}, retried = false) {
    const init = { credentials: 'same-origin', headers: { 'X-Requested-With': 'sentry-six-manager' } };
    if (opts.method) init.method = opts.method;
    if (opts.body !== undefined) {
      init.method = init.method || 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    // requests repeated on a timer give up instead of piling up behind a stuck one
    const ctrl = opts.timeoutMs ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : null;
    if (ctrl) init.signal = ctrl.signal;
    let res;
    try {
      res = await fetch(path, init);
    } catch {
      clearTimeout(timer);
      if (ctrl?.signal.aborted) throw new Error('The server took too long to answer.');
      // the server is down, or its certificate changed and the browser no longer accepts it
      throw new Error('Can\'t reach Sentry Six Manager. Reload the page; if the browser warns about the certificate, install the certificate authority (Settings → Security) so it trusts the page for good.');
    }
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
      throw new Error('Signed out');
    }
    const data = await res.json().catch(() => ({}));
    clearTimeout(timer);
    if (ctrl?.signal.aborted) throw new Error('The server took too long to answer.');
    if (res.status === 403 && data.code === 'CONFIRM_PASSWORD' && !retried) {
      // changes that could hand someone the shares or the server need the password again
      await confirmPassword();
      return api(path, opts, true);
    }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  /** Ask for the password and confirm it with the server; throws if cancelled. */
  async function confirmPassword() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const password = await passwordDialog(attempt ? 'That password was not right. Try again.' : 'This change affects where footage comes from or what code runs, so Sentry Six Manager asks for your password again.');
      if (password === null) throw new Error('Not changed: the password was not confirmed.');
      try {
        await api('/api/auth/confirm', { body: { password } }, true);
        return;
      } catch (err) {
        if (/Too many/.test(err.message)) throw err;
      }
    }
    throw new Error('Not changed: the password was not confirmed.');
  }

  function passwordDialog(message) {
    return new Promise((resolve) => {
      const dlg = $('dialog');
      $('dialog-form').innerHTML = `<h2>Confirm with your password</h2><p>${esc(message)}</p>
        <label class="field" style="margin-top:14px">Password<input class="input" type="password" name="confirm-password" autocomplete="current-password"></label>
        <div class="form-actions"><button class="btn" value="cancel">Cancel</button><button class="btn solid" value="ok">Confirm</button></div>`;
      const input = $('dialog-form').querySelector('[name=confirm-password]');
      dlg.onclose = () => resolve(dlg.returnValue === 'ok' && input.value ? input.value : null);
      dlg.returnValue = '';
      dlg.showModal();
      input.focus();
    });
  }

  function toast(msg, bad = false) {
    const el = document.createElement('div');
    el.className = `toast${bad ? ' bad' : ''}`;
    el.textContent = msg;
    $('toasts').append(el);
    setTimeout(() => el.remove(), bad ? 9000 : 5000);
  }

  /** Confirm dialog; resolves true/false. */
  function confirmDialog({ title, body, ok = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const dlg = $('dialog');
      $('dialog-form').innerHTML = `<h2>${esc(title)}</h2>${body}<div class="form-actions"><button class="btn" value="cancel">Cancel</button><button class="btn ${danger ? 'danger' : 'solid'}" value="ok">${esc(ok)}</button></div>`;
      dlg.onclose = () => resolve(dlg.returnValue === 'ok');
      dlg.returnValue = '';
      dlg.showModal();
    });
  }

  const state = {
    route: 'overview',
    vehicles: [],
    vehicleId: store.get('vehicle', null),
    notes: [],
    // open: the days the reader opened (none opens by itself)
    footage: { category: 'all', date: '', offset: 0, data: null, selected: new Set(), expanded: new Set(), open: new Set(), vehicleId: null, dayRecs: new Map() },
    system: null
  };
  const current = () => state.vehicles.find((v) => v.id === state.vehicleId) || state.vehicles[0] || null;

  // ---------- shell ----------
  // thumbnails that fail to load show their category instead (no inline handlers: CSP)
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.dataset.fallback !== undefined) img.replaceWith(Object.assign(document.createElement('span'), { textContent: img.dataset.fallback }));
  }, true);
  const app = $('app');
  if (store.get('collapsed', false)) app.classList.add('collapsed');
  $('collapse').addEventListener('click', () => {
    app.classList.toggle('collapsed');
    app.classList.remove('auto-collapsed');
    store.set('collapsed', app.classList.contains('collapsed'));
    setTimeout(() => fitFrames(), 50);
  });
  $('reduce-effects').addEventListener('change', (e) => {
    document.documentElement.classList.toggle('reduce-effects', e.target.checked);
    api('/api/settings/appearance', { method: 'PUT', body: { reduceEffects: e.target.checked } }).catch(() => {});
  });

  function setBadge(id, text, cls = '') {
    const b = $(id);
    b.hidden = !text;
    b.textContent = text || '';
    b.className = `count ${cls}`;
  }

  async function loadVehicles() {
    const { vehicles } = await api('/api/vehicles');
    state.vehicles = vehicles;
    if (!current() && vehicles.length) state.vehicleId = vehicles[0].id;
    else if (current()) state.vehicleId = current().id;
    const binItems = vehicles.reduce((n, v) => n + v.binItems, 0);
    setBadge('badge-bin', binItems ? String(binItems) : '');
  }

  async function loadNotes() {
    const { notifications } = await api('/api/notifications?open=1');
    state.notes = notifications;
    setBadge('badge-notes', notifications.length ? String(notifications.length) : '', 'alert');
  }

  function pills() {
    if (!state.vehicles.length) {
      return `<div class="pills"><a class="pill add" href="#/settings">${icon('plus')} Add your first vehicle</a></div>`;
    }
    return `<div class="pills" role="tablist" aria-label="Vehicles">${state.vehicles.map((v) => {
      const s = v.share;
      const dot = !s ? '' : s.healthy ? (s.writable === false ? 'warn' : 'ok') : 'bad';
      const n = v.inventory ? plural(v.inventory.recordings, 'recording') : v.scanning ? 'scanning…' : 'not scanned yet';
      return `<button class="pill${v.id === current()?.id ? ' active' : ''}" role="tab" aria-selected="${v.id === current()?.id}" data-vehicle="${esc(v.id)}">
        <span class="row"><span class="dot ${dot}"></span>${esc(v.name)}</span><span class="sub">${esc(n)}</span></button>`;
    }).join('')}</div>`;
  }

  function head(eyebrow, title, extra = '') {
    return `<div class="page-head"><div>${eyebrow ? `<p class="eyebrow">${esc(eyebrow)}</p>` : ''}<h1>${esc(title)}</h1></div>
      <div class="head-actions">${extra}<button class="btn" data-action="signout">Sign out</button></div></div>`;
  }

  const page = $('page');
  page.addEventListener('click', async (e) => {
    const pill = e.target.closest('[data-vehicle]');
    if (pill) {
      state.vehicleId = pill.dataset.vehicle;
      store.set('vehicle', state.vehicleId);
      state.footage.offset = 0;
      state.footage.selected.clear();
      return render();
    }
    // a Logs link while the address already is #/overview/logs: no hashchange
    if (e.target.closest('a[href="#/overview/logs"]') && location.hash === '#/overview/logs') {
      e.preventDefault();
      $('ov-logs')?.scrollIntoView({ block: 'start' });
      return undefined;
    }
    const act = e.target.closest('[data-action]');
    if (act && act.dataset.action === 'signout') {
      await api('/api/auth/logout', { body: {} }).catch(() => {});
      location.href = '/login';
    }
  });

  // ---------- pages ----------
  const pages = {};

  /**
   * Redraws part of the page without moving it. Safari (WebKit) shifts the
   * scroll position when the content under it is replaced, even by the same
   * content, so the Overview jumped at every poll and every live update;
   * the position is put back before anything is painted.
   */
  function keepScroll(draw) {
    const se = document.scrollingElement;
    const top = se ? se.scrollTop : 0;
    draw();
    if (se && se.scrollTop !== top) se.scrollTop = top;
  }

  // a node change being saved (the Nodes page)
  let nodeSaving = false;

  // Text the reader is highlighting (or about to, with the button down) inside
  // `el`: redrawing it would take the highlight away before it can be copied.
  // Live updates wait until the highlight is gone, then catch up at once.
  let pressing = null;
  function selecting(el) {
    if (!el) return false;
    if (pressing && el.contains(pressing)) return true;
    const sel = document.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    return el.contains(range.commonAncestorContainer) || range.intersectsNode?.(el) === true;
  }
  const held = { monitor: false, logs: false, page: false };
  // what a poll redraws in Overview > Server: the head's line and chips, and
  // the tiles (a highlight in the vehicle tiles or the logs holds no numbers)
  const monitorSelecting = (root) => Boolean(root) && (selecting(root.querySelector('.nd-head')) || selecting(root.querySelector('.nd-body')));
  function catchUp() {
    if (held.monitor && !monitorSelecting($('nd-server'))) {
      held.monitor = false;
      drawMonitor();
    }
    if (held.logs && !selecting($('log-list'))) {
      held.logs = false;
      drawLogs();
    }
    if (held.page && !selecting(page)) {
      held.page = false;
      render();
    }
  }
  document.addEventListener('pointerdown', (e) => { pressing = e.button === 0 ? e.target : null; }, true);
  document.addEventListener('pointerup', () => { pressing = null; setTimeout(catchUp, 0); }, true);
  document.addEventListener('pointercancel', () => { pressing = null; setTimeout(catchUp, 0); }, true);
  document.addEventListener('selectionchange', () => { if (!pressing) catchUp(); });

  // The Overview is one window, the Server section: the selected vehicle's
  // archive and free space at its top (with Nerd stats off too), then what
  // the server is doing. Viewer, Footage, Encoder and the alerts
  // (Notifications) are tabs of their own.
  pages.overview = async () => {
    // (a live update redraws it all: the reader stays where they were)
    keepScroll(() => {
      page.innerHTML = head('Your archive workspace', 'Overview') + pills() + serverSection();
      mountOverview();
    });
    revealLogs();
  };

  /** Wires the Server section, drawn by the page or anew by the Nerd stats switch. */
  function mountOverview() {
    const v = current();
    const refresh = $('refresh-inv');
    if (refresh && v) refresh.onclick = () => api(`/api/vehicles/${v.id}/scan`, { body: {} }).then(() => toast('Refreshing the inventory…'), (err) => toast(err.message, true));
    mountMonitor();
    mountLogs();
  }

  // ---------- Overview > Server ("nerd stats") ----------
  // What the server is doing, from GET /api/stats every 2 s while the
  // Overview is on screen and the tab is visible, behind a switch this
  // browser remembers. Only tiles the server has numbers for are drawn.
  // Names, models and labels come from the machine, so all of it goes
  // through esc().

  // ---- server monitor: drawing (no DOM here; test/screens.test.js runs it) ----
  const fin = (n) => typeof n === 'number' && Number.isFinite(n);
  const clampPct = (n) => Math.max(0, Math.min(100, Math.round((fin(n) ? n : 0) * 10) / 10));
  const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const sizeUnit = (b) => {
    let i = 0;
    for (let v = Math.abs(b); v >= 1024 && i < SIZE_UNITS.length - 1; v /= 1024) i++;
    return i;
  };
  const sizeNum = (b, i) => {
    const v = b / 1024 ** i;
    return v >= 100 || i === 0 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
  };
  // like the mockup: 18.2 GB, 640 MB, "112 of 476 GB", "1.1 / 6 GB"
  const size = (b) => (fin(b) ? `${sizeNum(b, sizeUnit(b))} ${SIZE_UNITS[sizeUnit(b)]}` : '—');
  const sizeOf = (used, total, sep = ' of ') => `${sizeNum(used, sizeUnit(total))}${sep}${sizeNum(total, sizeUnit(total))} ${SIZE_UNITS[sizeUnit(total)]}`;
  const rate = (bps) => {
    if (!fin(bps)) return '—';
    if (bps > 0 && bps < 1024 ** 2) return `${Math.max(1, Math.round(bps / 1024))} KB/s`;
    const i = Math.max(2, sizeUnit(bps));
    return `${sizeNum(bps, i)} ${SIZE_UNITS[i]}/s`;
  };
  const pct = (n) => `${Math.round(n)}%`;
  const watts = (w) => `${w >= 10 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, '')} W`;
  const temp = (c) => `${Math.round(c)} °C`;
  const clock = (mhz) => (mhz >= 1000 ? `${Number((mhz / 1000).toFixed(2))} GHz` : `${Math.round(mhz)} MHz`);
  // "12.4 Wh" below 100 Wh, so a run's first minutes visibly count up; "412 Wh"; then "5.2 kWh"
  const energyText = (wh) => {
    if (Math.round(wh * 10) / 10 < 100) return `${(Math.round(wh * 10) / 10).toFixed(1)} Wh`;
    if (Math.round(wh) < 1000) return `${Math.round(wh)} Wh`;
    const k = wh / 1000;
    return `${Math.round(k * 10) / 10 < 100 ? k.toFixed(1) : Math.round(k).toLocaleString()} kWh`;
  };
  // $0.14 but 1.20 kr
  const inCurrency = (n, cur) => {
    const c = String(cur || '$');
    return /^[a-z]+$/i.test(c) ? `${n} ${c}` : `${c}${n}`;
  };
  /** "≈ $0.14"; costs come summed by the server (time-of-use plans), never kWh × one price. */
  const money = (v, cur) => `≈ ${inCurrency(v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2), cur)}`;
  const span = (s) => {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d ? `${d} d ${h} h` : h ? `${h} h ${m} m` : m ? `${m} m` : `${Math.max(0, Math.round(s))} s`;
  };
  const answer = (ms) => (ms < 1 ? 'under 1 ms' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`);
  const linkSpeed = (mbps) => (!fin(mbps) || mbps <= 0 ? '' : mbps >= 1000 ? `${Number((mbps / 1000).toFixed(1))} Gbit/s` : `${Math.round(mbps)} Mbit/s`);
  const cpuName = (m) => String(m || '').replace(/\((R|TM)\)/gi, '').replace(/\s+CPU\s+@.*$/i, '').replace(/\s+with\s+Radeon.*$/i, '').replace(/\s+/g, ' ').trim();

  /**
   * A sparkline, 0 at the bottom; null points are gaps (no sample then).
   * `also` adds more lines ([points, color]) on the same scale, drawn over it.
   */
  function spark(points, color, floor, also = []) {
    const clean = (list) => (Array.isArray(list) ? list : []).map((p) => (fin(p) ? Math.max(0, p) : null));
    const series = [[clean(points), color], ...also.map(([p, c]) => [clean(p), c])].filter(([vals]) => vals.filter((v) => v !== null).length > 1);
    if (!series.length) return '';
    const w = 220;
    const h = 40;
    const top = Math.max(floor, ...series.flatMap(([vals]) => vals.filter((v) => v !== null)).map((v) => v * 1.15));
    const lines = series.flatMap(([vals, c]) => {
      const x = (i) => ((i / (vals.length - 1)) * w).toFixed(1);
      const segs = [];
      let seg = [];
      vals.forEach((v, i) => {
        if (v === null) {
          if (seg.length) segs.push(seg);
          seg = [];
        } else {
          seg.push([x(i), (h - 3 - (v / top) * (h - 6)).toFixed(1)]);
        }
      });
      if (seg.length) segs.push(seg);
      return segs.filter((s) => s.length > 1).map((s) => {
        const pts = s.map((p) => p.join(',')).join(' ');
        return `<polyline points="${s[0][0]},${h} ${pts} ${s[s.length - 1][0]},${h}" fill="${c}" opacity="0.08" stroke="none"/><polyline points="${pts}" fill="none" stroke="${c}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
      });
    });
    return `<svg class="nd-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${lines.join('')}</svg>`;
  }
  const sparkBlock = (svg, day) => (svg && day ? `${svg}<div class="nd-axis"><span>24 h ago</span><span>now</span></div>` : svg);
  // a tile's sparkline keeps its room while it has fewer than two points
  const sparkOrRoom = (svg) => svg || '<svg class="nd-spark" viewBox="0 0 220 40" aria-hidden="true"></svg>';
  const ndBar = (value, hot = false, bad = false) => `<div class="nd-bar${bad ? ' bad' : hot ? ' hot' : ''}"><span style="width:${clampPct(value)}%"></span></div>`;
  const ndBig = (value, label) => `<div class="nd-big"><b>${value}</b>${label ? `<span class="muted small">${label}</span>` : ''}</div>`;
  /** key/value rows; values are HTML already escaped by the caller, rows without a value are left out */
  const ndKv = (rows, cls = '') => {
    const r = rows.filter((row) => row && row[1]);
    return r.length ? `<dl class="nd-kv${cls}">${r.map(([k, v, hot]) => `<dt>${esc(k)}</dt><dd${hot ? ' class="nd-warn"' : ''}>${v}</dd>`).join('')}</dl>` : '';
  };
  /**
   * A tile's rows, steady while the page is open: a row the tile has shown
   * keeps its place, with '—' (or the row's own placeholder, row[3]), while
   * the server has no value for it or leaves it out for a moment, so the
   * page does not jump with every poll. `seen` (the caller's, kept between
   * polls) maps a tile to the rows it has shown, in order; rows that never
   * had a value are left out as before. A label that comes twice (two NVMe
   * drives are both "NVMe") is two rows, told apart by their order.
   */
  function steady(seen, tile, rows) {
    const list = rows.filter((row) => row && row[0]);
    if (!seen) return list;
    // "2:NVMe" is the second row called NVMe
    const times = new Map();
    const keyed = list.map((row) => {
      times.set(row[0], (times.get(row[0]) || 0) + 1);
      return [`${times.get(row[0])}:${row[0]}`, row];
    });
    const order = [...(seen.get(tile) || [])];
    let at = -1;
    for (const [key, row] of keyed) {
      const i = order.indexOf(key);
      if (i >= 0) at = i;
      else if (row[1]) order.splice(++at, 0, key);
    }
    seen.set(tile, order);
    const now = new Map(keyed);
    return order.map((key) => {
      const row = now.get(key);
      return row && row[1] ? row : [key.slice(key.indexOf(':') + 1), row?.[3] ?? '—'];
    });
  }
  const ndTile = (title, sub, body, wide = false) => `<div class="nd-tile${wide ? ' nd-wide' : ''}"><div class="nd-title"><span>${esc(title)}</span>${sub ? `<span class="muted" title="${esc(sub)}">${esc(sub)}</span>` : ''}</div>${body}</div>`;
  const moreButton = (key, shown, total, open) => (total > shown || open ? `<button type="button" class="nd-more" data-nd-more="${key}">${open ? 'Show fewer' : `Show all ${total}`}</button>` : '');

  function cpuTile(cpu, points, day, seen = null) {
    if (!cpu || !fin(cpu.usage)) return '';
    const counts = fin(cpu.cores) ? (fin(cpu.threads) && cpu.threads !== cpu.cores ? `${cpu.cores} cores / ${cpu.threads} threads` : plural(cpu.cores, 'core')) : '';
    const per = (Array.isArray(cpu.perCore) ? cpu.perCore : []).filter(fin);
    // one bar per thread; big machines get rows of 16 (or 32) thinner bars
    const cols = per.length <= 16 ? per.length : per.length <= 64 ? 16 : 32;
    const cores = per.length > 1 ? `<div class="nd-cores${per.length > 16 ? ' dense' : ''}" style="--cols:${cols}">${per.map((c, i) => `<i style="--v:${clampPct(c)}%" title="CPU ${i}: ${pct(c)}"></i>`).join('')}</div>` : '';
    const app = cpu.app || {};
    const appText = fin(app.usage) ? `${pct(app.usage)}${app.ffmpegCount > 0 && fin(app.ffmpegUsage) ? ` (ffmpeg ×${app.ffmpegCount}: ${pct(app.ffmpegUsage)})` : ''}` : '';
    // two or more sockets: "2 × <model>" (the counts are totals) and a short line per socket
    const multi = fin(cpu.sockets) && cpu.sockets > 1;
    const name = multi ? (cpuName(cpu.model) ? `${cpu.sockets} × ${cpuName(cpu.model)}` : `${cpu.sockets} CPUs`) : cpuName(cpu.model);
    const socketLines = (multi && Array.isArray(cpu.perSocket) ? cpu.perSocket : []).map((s, i) => {
      if (!s) return '';
      const bits = [
        fin(s.usage) && pct(s.usage),
        fin(s.tempC) && (s.tempC >= 90 ? `<span class="nd-warn">${temp(s.tempC)}</span>` : temp(s.tempC)),
        fin(s.powerW) && watts(s.powerW)
      ].filter(Boolean);
      const own = fin(s.cores) ? (fin(s.threads) && s.threads !== s.cores ? `${s.cores} cores / ${s.threads} threads` : plural(s.cores, 'core')) : '';
      // numbered from 1 by the kernel's physical id, as the Sensors tile names the packages
      const n = Number.isInteger(s.socket) && s.socket >= 0 && s.socket < 1024 ? s.socket + 1 : i + 1;
      return bits.length ? `<div${own ? ` title="${esc(own)}"` : ''}><span>CPU ${n}</span>${bits.map((b) => `<span>${b}</span>`).join('')}</div>` : '';
    }).join('');
    return ndTile('CPU', [name, counts].filter(Boolean).join(' · '), ndBig(pct(cpu.usage), 'whole server')
      + sparkBlock(sparkOrRoom(spark(points, 'var(--accent)', 10)), day) + cores
      + (socketLines ? `<div class="nd-sockets">${socketLines}</div>` : '')
      + ndKv(steady(seen, 'cpu', [
        ['Clock', fin(cpu.freqMHz) ? clock(cpu.freqMHz) : ''],
        ['Temp', fin(cpu.tempC) ? temp(cpu.tempC) : '', cpu.tempC >= 90],
        ['Load', Array.isArray(cpu.load) && cpu.load.some(fin) ? cpu.load.map((l) => (fin(l) ? l.toFixed(1) : '—')).join(' · ') : ''],
        ['This app', appText],
        ['Throttling', cpu.throttling ? 'yes: too hot, running slower' : '', true, 'no']
      ])));
  }

  // these drivers report the video engine and render use whenever this app
  // has a client open; their rows stay in place (with '—') in between
  const VIDEO_VENDORS = new Set(['amd', 'intel', 'nvidia']);
  const reportsVideo = (g) => Boolean(g) && VIDEO_VENDORS.has(g.vendor);
  // AMD and NVIDIA drivers report the whole GPU's use (anything on the server,
  // not only conversions): their tile leads with it, 0 % when idle. Intel only
  // tells this app's own share, so its tile leads with the video engine.
  const OVERALL_VENDORS = new Set(['amd', 'nvidia']);
  const reportsOverall = (g) => Boolean(g) && OVERALL_VENDORS.has(g.vendor);
  // what a GPU's tile needs to be drawn again while a sample leaves it out
  const GPU_NAMES = ['id', 'name', 'vendor', 'driver', 'node', 'vramTotalB', 'integrated'];

  // (`g.held`: a GPU the page has shown that this sample left out, drawn with '—')
  function gpuTile(g, points, day, seen = null, key = 'gpu') {
    const steadyRows = reportsVideo(g);
    if (!g || (!steadyRows && !g.held && !['busy', 'video', 'vramUsedB', 'clockMHz', 'tempC', 'powerW'].some((k) => fin(g[k])))) return '';
    const dash = (n) => (fin(n) ? pct(n) : '—');
    const big = reportsOverall(g) ? ndBig(fin(g.busy) ? pct(g.busy) : g.held ? '—' : '0%', 'in use')
      : steadyRows ? ndBig(dash(g.video), 'video engine')
      : fin(g.video) ? ndBig(pct(g.video), 'video engine') : fin(g.busy) ? ndBig(pct(g.busy), 'busy') : g.held ? ndBig('—', 'busy') : '';
    const vram = fin(g.vramTotalB) && g.vramTotalB > 0;
    const rows = [
      (steadyRows || fin(g.busy)) && `<div><span>Render / 3D</span>${ndBar(g.busy, g.busy >= 90)}<b>${dash(g.busy)}</b></div>`,
      (steadyRows || fin(g.video)) && `<div><span>Video</span>${ndBar(g.video, g.video >= 90)}<b>${dash(g.video)}</b></div>`,
      vram && `<div><span>VRAM</span>${ndBar(fin(g.vramUsedB) ? (g.vramUsedB / g.vramTotalB) * 100 : 0)}<b>${fin(g.vramUsedB) ? sizeOf(g.vramUsedB, g.vramTotalB, ' / ') : '—'}</b></div>`
    ].filter(Boolean);
    return ndTile('GPU', [g.name, g.driver, g.node].filter(Boolean).join(' · '), big
      + sparkBlock(points ? sparkOrRoom(spark(points, 'var(--info)', 10)) : '', day)
      + (rows.length ? `<div class="nd-rows">${rows.join('')}</div>` : '')
      + ndKv(steady(seen, key, [
        ['Clock', fin(g.clockMHz) ? clock(g.clockMHz) : ''],
        ['Temp', fin(g.tempC) ? temp(g.tempC) : '', g.tempC >= 90],
        // a built-in GPU's reading is the whole chip's, CPU included
        ['Power', fin(g.powerW) ? `${watts(g.powerW)}${g.integrated ? ' · whole chip' : ''}` : ''],
        ['Clients', g.clients > 0 ? `${g.clients} × ffmpeg` : '', false, g.clients === 0 ? 'none' : '—']
      ])));
  }

  function powerTile(p, enc, price, currency, seen = null) {
    if (!p) return '';
    // A built-in GPU (an APU such as the Ryzen 8700G's 780M) is part of the
    // CPU chip: its reading and the CPU package's are the same power, so the
    // chip is one figure, and only other GPUs are added to it. Once shown,
    // it stays one figure while a sample has no reading.
    if (fin(p.chipW) && seen) seen.set('power-whole-chip', true);
    const chip = fin(p.chipW) || Boolean(seen?.get('power-whole-chip'));
    const partW = chip ? { 'Whole chip': p.chipW, GPU: p.discreteW } : { 'CPU package': p.cpuW, GPU: p.gpuW };
    const parts = Object.entries(partW).filter(([, w]) => fin(w));
    // a part seen before keeps its bar while its reading is missing for a moment
    const bars = steady(seen, chip ? 'power-chip' : 'power-parts', Object.entries(partW).map(([name, w]) => [name, fin(w) ? watts(w) : ''])).filter((row) => row[1]);
    const total = fin(p.totalW) ? p.totalW : parts.length ? parts.reduce((n, [, w]) => n + w, 0) : null;
    // no power reading at all (and nothing measured earlier this week): no tile
    if (!fin(total) && !p.cpuSource && !p.gpuSource && !(p.todayWh > 0) && !(p.weekWh > 0)) return '';
    const label = chip ? (fin(p.discreteW) || bars.length === 2 ? 'whole chip + GPU' : 'whole chip (CPU + built-in GPU)')
      : parts.length === 2 ? 'CPU + GPU' : parts.length ? (parts[0][0] === 'GPU' ? 'GPU (CPU not measured)' : 'CPU package') : '';
    const energy = (wh, c) => (fin(wh) ? esc(`${energyText(wh)}${fin(c) ? ` · ${money(c, currency)}` : ''}`) : '');
    const priceNow = fin(price?.now) ? `${esc(inCurrency(price.now.toFixed(price.now < 1 ? 3 : 2).replace(/(\.\d\d)0$/, '$1'), price.currency || currency))} per kWh${price.rate ? ` · ${esc(price.rate)}` : ''}` : '';
    return ndTile('Power', 'measured, not estimated', (fin(total) ? ndBig(watts(total), label) : bars.length ? ndBig('—', label) : '')
      + (bars.length ? `<div class="nd-rows">${bars.map(([name, text]) => `<div><span>${name}</span>${ndBar(fin(partW[name]) && total > 0 ? (partW[name] / total) * 100 : 0)}<b>${text}</b></div>`).join('')}</div>` : '')
      + ndKv(steady(seen, 'power', [
        ['Today', energy(p.todayWh, p.todayCost)],
        ['This week', energy(p.weekWh, p.weekCost)],
        ['Converting', enc?.running && fin(enc.run?.wh) ? `${energyText(enc.run.wh)} this run` : ''],
        ['Price now', priceNow]
      ])));
  }

  function memoryTile(m, seen = null) {
    if (!m || !fin(m.totalB) || !fin(m.usedB) || m.totalB <= 0) return '';
    const used = (m.usedB / m.totalB) * 100;
    return ndTile('Memory', size(m.totalB), ndBig(size(m.usedB), `used (${pct(used)})`) + ndBar(used, used >= 95)
      + ndKv(steady(seen, 'memory', [
        ['This app', fin(m.appB) ? size(m.appB) : ''],
        ['Cache', fin(m.cacheB) ? size(m.cacheB) : ''],
        ['Swap', fin(m.swapTotalB) ? (m.swapTotalB > 0 ? sizeOf(m.swapUsedB || 0, m.swapTotalB, ' / ') : 'none') : '']
      ])));
  }

  const DISK_KIND = { nvme: 'NVMe', ssd: 'SSD', hdd: 'hard disk' };
  // the temperatures the server's alerts use
  const diskHot = (d) => fin(d.tempC) && d.tempC >= (d.kind === 'hdd' ? 55 : 70);
  const DISKS_SHOWN = 8;

  // how long ago, by the server's clock (`at`, the sample's time)
  const sinceText = (ts, at) => (ts > 0 ? (at - ts < 1000 ? 'just now' : `${span((at - ts) / 1000)} ago`) : '');

  function storageTile(fss, disks, all, at = Date.now()) {
    const rows = [];
    for (const f of Array.isArray(fss) ? fss : []) {
      if (!f) continue;
      const known = fin(f.totalB) && f.totalB > 0 && fin(f.usedB);
      const used = known ? (f.usedB / f.totalB) * 100 : 0;
      const bits = [known ? sizeOf(f.usedB, f.totalB) : ''];
      const down = f.mounted === false || f.reachable === false;
      // a share that is not mounted: its folder is on this server's disk, not the share
      if (f.mounted === false) bits.push('<span class="nd-bad">not connected</span>');
      else if (f.reachable === false) bits.push('<span class="nd-bad">not reachable</span>');
      else if (fin(f.latencyMs)) bits.push(f.latencyMs > 2000 ? `<span class="nd-warn">answers in ${answer(f.latencyMs)}</span>` : `answers in ${answer(f.latencyMs)}`);
      if (down && f.answeredAt > 0) bits.push(`last answered ${sinceText(f.answeredAt, at)}`);
      // the heartbeat: when it was last checked, and how often
      const beat = [f.checkedAt > 0 && `checked ${sinceText(f.checkedAt, at)}`, fin(f.checkEveryMs) && f.checkEveryMs > 0 && `every ${span(f.checkEveryMs / 1000)}`].filter(Boolean).join(' · ');
      rows.push(`<div class="nd-disk"><div><b>${esc(f.label || f.path)}</b><span class="muted small">${esc(f.path || '')}</span></div>${known ? ndBar(used, used >= 90) : ''}<span class="small">${bits.filter(Boolean).join(' · ')}</span>${beat ? `<span class="small muted nd-beat">${esc(beat)}</span>` : ''}</div>`);
    }
    const list = (Array.isArray(disks) ? disks : []).filter((d) => d && d.name);
    for (const d of all ? list : list.slice(0, DISKS_SHOWN)) {
      const bits = [`read ${rate(d.readBps)}`, `write ${rate(d.writeBps)}`];
      if (fin(d.tempC)) bits.push(diskHot(d) ? `<span class="nd-warn">${temp(d.tempC)}</span>` : temp(d.tempC));
      rows.push(`<div class="nd-disk"><div><b>${esc(d.name)}</b><span class="muted small">${esc([d.model, DISK_KIND[d.kind]].filter(Boolean).join(' · '))}</span></div><span class="small">${bits.join(' · ')}</span></div>`);
    }
    if (!rows.length) return '';
    return ndTile('Storage', 'disks and shares', `<div class="nd-disks">${rows.join('')}</div>${moreButton('disks', DISKS_SHOWN, list.length, all)}`, true);
  }

  // download in blue, upload in purple, on one scale
  function networkTile(net, points, day) {
    const ifs = (Array.isArray(net?.interfaces) ? net.interfaces : []).filter((i) => i && (fin(i.rxBps) || fin(i.txBps)));
    if (!ifs.length) return '';
    const sum = (k) => ifs.reduce((n, i) => n + (fin(i[k]) ? i[k] : 0), 0);
    const one = ifs.length === 1 ? ifs[0] : null;
    return ndTile('Network', one ? [one.name, linkSpeed(one.speedMbps)].filter(Boolean).join(' · ') : `${ifs.length} interfaces`,
      ndBig(`<span class="nd-down">↓</span> ${rate(sum('rxBps'))}`, `<span class="nd-up">↑ ${rate(sum('txBps'))}</span>`)
      + sparkBlock(spark(points?.rx, 'var(--info)', 64 * 1024, [[points?.tx, 'var(--upload)']]), day)
      + ndKv(one ? [] : ifs.map((i) => [[i.name, linkSpeed(i.speedMbps)].filter(Boolean).join(' · '), `↓ ${rate(i.rxBps)} · ↑ ${rate(i.txBps)}`]))
      // a list of its own, so long interface names never narrow its values;
      // the data used is always shown (0 B too) so the tile keeps its height
      // between polls, and a narrow tile wraps it at the dot only
      + ndKv([
        ['Counted for', net.scope === 'host' ? 'the whole server' : 'this container'],
        ...[['Today', net.today], ['This week', net.week], ['This month', net.month]]
          .map(([k, u]) => [k, [['↓', u?.rxB], ['↑', u?.txB]].map(([arrow, b]) => `${arrow} ${size(b)}`.replace(/ /g, '\u00a0')).join(' · ')])
      ]));
  }

  // hwmon names, in words (anything else shows as the server reports it);
  // with several CPU sockets the packages go by the CPU tile's numbers
  function sensorName(s, multiSocket = false) {
    const chip = String(s.chip || '');
    const label = String(s.label || '');
    let m;
    if (chip === 'coretemp' && (m = /^Package id (\d+)$/.exec(label))) {
      if (multiSocket) return `CPU ${Number(m[1]) + 1} package`;
      return m[1] === '0' ? 'CPU package' : `CPU package ${m[1]}`;
    }
    if (chip === 'k10temp' && /^T(ctl|die)$/.test(label)) return `CPU (${label})`;
    if (chip === 'k10temp' && (m = /^Tccd(\d+)$/.exec(label))) return `CPU die ${m[1]}`;
    if (/^cpu[-_]thermal$/.test(chip) || /^cpu[-_]thermal$/.test(label)) return 'CPU';
    if (chip === 'nvme') return label === 'Composite' || !label ? 'NVMe' : `NVMe ${label.toLowerCase()}`;
    if (/^(amdgpu|i915|xe|nouveau|radeon)$/.test(chip)) {
      if (s.kind === 'fan') return 'GPU fan';
      return { edge: 'GPU', pkg: 'GPU', junction: 'GPU hotspot', mem: 'GPU memory', vram: 'GPU memory' }[label] || `GPU ${label}`;
    }
    if ((m = /^fan(\d+)$/.exec(label))) return `Fan ${m[1]}`;
    if ((m = /^temp(\d+)$/.exec(label))) return `${chip} ${m[1]}`;
    return label || chip || 'Sensor';
  }
  const sensorHot = (s, name) => s.kind === 'temp' && s.value >= (s.chip === 'drivetemp' ? 55 : s.chip === 'nvme' ? 70 : /^(CPU|GPU)/.test(name) ? 90 : 85);
  const SENSORS_SHOWN = 10;

  function sensorsTile(sensors, all, sockets = 1, seen = null) {
    const rows = [];
    const coreMax = new Map(); // "Core 0" … "Core 11" of a chip: one "Core max" row
    // the packages go by the CPU tile's numbers when there is one per socket
    // (a CPU with several dies per socket has more: they keep their numbers)
    const packages = new Set((Array.isArray(sensors) ? sensors : []).filter((s) => s && s.chip === 'coretemp' && /^Package id \d+$/.test(s.label || '')).map((s) => s.label));
    const multiSocket = packages.size > 1 && packages.size === sockets;
    for (const s of Array.isArray(sensors) ? sensors : []) {
      if (!s) continue;
      // a sensor without a reading this time keeps its row once it has shown one
      if (!fin(s.value)) {
        if (!(s.kind === 'temp' && /^Core \d+$/.test(s.label || ''))) rows.push({ ...s, name: sensorName(s, multiSocket), value: null });
        continue;
      }
      if (s.kind === 'temp' && /^Core \d+$/.test(s.label || '')) {
        const row = coreMax.get(s.chip);
        if (row) row.value = Math.max(row.value, s.value);
        else {
          const fresh = { name: 'Core max', kind: 'temp', chip: s.chip, value: s.value };
          coreMax.set(s.chip, fresh);
          rows.push(fresh);
        }
        continue;
      }
      rows.push({ ...s, name: sensorName(s, multiSocket) });
    }
    const list = steady(seen, 'sensors', rows.map((s) => [s.name,
      !fin(s.value) ? '' : s.kind === 'fan' ? `${Math.round(s.value).toLocaleString()} rpm` : temp(s.value), fin(s.value) && sensorHot(s, s.name)])).filter((row) => row[1]);
    if (!list.length) return '';
    const shown = all ? list : list.slice(0, SENSORS_SHOWN);
    return ndTile('Sensors', 'every one the server reports', ndKv(shown, ' nd-sensors')
      + moreButton('sensors', SENSORS_SHOWN, list.length, all));
  }

  // the server sends its 8 busiest; the table keeps room for 8 rows
  const PROCESS_ROWS = 8;

  function processTile(procs, enc, hasGpu = false, seen = null) {
    const top = (Array.isArray(procs?.top) ? procs.top : []).filter((p) => p && p.name);
    if (!top.length) return '';
    // the same program several times (ffmpeg ×4) is one row
    const groups = new Map();
    for (const p of top) {
      const g = groups.get(p.name) || { name: p.name, n: 0, cpu: 0, memB: 0, gpu: null };
      g.n++;
      g.cpu += fin(p.cpu) ? p.cpu : 0;
      g.memB += fin(p.memB) ? p.memB : 0;
      if (fin(p.gpuVideo)) g.gpu = (g.gpu || 0) + p.gpuVideo;
      groups.set(p.name, g);
    }
    // Busy programs come first, by bands of 5 %; inside a band the rows keep
    // their places from the last poll (`seen`), so the list does not reshuffle
    // while most programs sit near 0 %. A row changes band only once it is a
    // point past the band's edge.
    const before = seen?.get('procs') || new Map(); // name -> { band, at }
    const bandOf = (g) => {
      const was = before.get(g.name)?.band;
      if (was !== undefined && g.cpu >= was * 5 - 1 && g.cpu < (was + 1) * 5 + 1) return was;
      return Math.floor(g.cpu / 5);
    };
    const rows = [...groups.values()].map((g) => ({ ...g, band: bandOf(g), at: before.get(g.name)?.at ?? Infinity }))
      .sort((a, b) => b.band - a.band || a.at - b.at || b.cpu - a.cpu || b.memB - a.memB);
    if (seen) seen.set('procs', new Map(rows.map((r, i) => [r.name, { band: r.band, at: i }])));
    // with a GPU, its column stays while no process uses it
    const gpuCol = hasGpu || rows.some((r) => r.gpu !== null);
    // rows come and go (ffprobe, a mount): empty ones keep the table's height;
    // past PROCESS_ROWS the list scrolls inside the tile
    const pad = `<tr class="nd-pad" aria-hidden="true"><td>&nbsp;</td><td></td><td></td>${gpuCol ? '<td></td>' : ''}</tr>`.repeat(Math.max(0, PROCESS_ROWS - rows.length));
    // The server names an ffmpeg that encodes by its encoder (ffmpeg ·
    // hevc_vaapi); the others (checks, probes, thumbnails) stay "ffmpeg".
    // One line each, so a row is as tall with ffmpeg ×3 as with one ffmpeg:
    // a long name ends in … before its count (its title has it all)
    const name = (r) => r.name;
    const nameCell = (r) => `<td title="${esc(`${name(r)}${r.n > 1 ? ` ×${r.n}` : ''}`)}"><span class="nd-pname"><span>${esc(name(r))}</span>${r.n > 1 ? `<span>×${r.n}</span>` : ''}</span></td>`;
    return ndTile('Top processes', procs.scope === 'host' ? 'whole server' : 'this container',
      `<div class="nd-procs-box" tabindex="0" aria-label="Processes, ${rows.length > PROCESS_ROWS ? 'scroll for more' : 'all shown'}"><table class="nd-procs"><thead><tr><th>Process</th><th>CPU</th><th>Memory</th>${gpuCol ? '<th>GPU</th>' : ''}</tr></thead><tbody>${rows.map((r) => `<tr>${nameCell(r)}<td>${pct(r.cpu)}</td><td>${size(r.memB)}</td>${gpuCol ? `<td>${r.gpu !== null ? `${pct(r.gpu)} video` : '—'}</td>` : ''}</tr>`).join('')}${pad}</tbody></table></div>`, true);
  }

  function hostLine(h) {
    if (!h) return '';
    return [h.hostname, h.os, h.kernel && `kernel ${h.kernel}`, fin(h.uptimeS) && `up ${span(h.uptimeS)}`,
      fin(h.appUptimeS) && `app up ${span(h.appUptimeS)}`, h.version && `version ${h.version}`].filter(Boolean).map((part) => `<span class="nd-nb">${esc(part)}</span>`).join(' · ');
  }

  function alertChip(alerts) {
    const n = Array.isArray(alerts) ? alerts.length : 0;
    if (!n) return '';
    const bad = alerts.some((a) => a.level === 'error');
    return `<span class="chip ${bad ? 'red' : 'amber'}"><span class="cdot"></span>${bad ? plural(n, 'problem') : plural(n, 'warning')}</span>`;
  }

  /**
   * The top of the Server section: the selected vehicle's last discovered
   * inventory and the free space last observed on its share, in two tiles
   * with their buttons. Drawn with the page (not with every poll), so they
   * show with Nerd stats off too; each keeps its rows, so a live update does
   * not change its height. Only a share with a problem gets a chip.
   */
  function vehicleTiles(v, at = Date.now()) {
    if (!v) {
      return `<div class="nd-grid nd-vgrid">${ndTile('Vehicles', 'none yet', '<p class="nd-note">Each vehicle has its own footage share (SMB) or folder. Add one in Settings to start.</p><div class="nd-actions"><a class="btn sm solid" href="#/settings">Open settings</a></div>')}</div>`;
    }
    const s = v.share || {};
    const inv = v.inventory;
    const known = fin(s.totalBytes) && s.totalBytes > 0 && fin(s.freeBytes);
    const used = known ? (1 - s.freeBytes / s.totalBytes) * 100 : null;
    const problem = !s.healthy ? '<span class="chip red">Share unavailable</span>' : s.writable === false ? '<span class="chip amber">Read-only share</span>' : '';
    const scanned = v.scanning ? 'scanning…' : inv ? sinceText(inv.scannedAt, at) || '—' : 'not yet';
    const inventory = ndTile('Inventory', 'last discovered', ndBig(inv && fin(inv.bytes) ? size(inv.bytes) : '—', 'all categories')
      + ndKv([
        ['Recordings', inv ? Number(inv.recordings || 0).toLocaleString() : '—'],
        ['Scanned', esc(scanned)],
        ['Time zone', esc(v.timezone || '—')]
      ])
      + '<div class="nd-actions"><button type="button" class="btn sm" id="refresh-inv">Refresh inventory</button></div>');
    const free = ndTile('Free space', `last observed on ${v.name}`, `<div class="nd-big"><b>${fin(s.freeBytes) ? size(s.freeBytes) : '—'}</b><span class="muted small">free</span>${problem}</div>`
      // (no capacity known: an empty meter keeps the tile's height)
      + ndBar(used ?? 0, used > 85, used > 95)
      + ndKv([
        ['Capacity', known ? size(s.totalBytes) : 'unknown'],
        ['Used', known ? pct(used) : '—'],
        ['Recycle Bin', fin(v.binBytes) && v.binBytes > 0 ? size(v.binBytes) : 'empty']
      ])
      + `<div class="nd-actions"><a class="btn sm" href="#/settings/vehicle/${esc(v.id)}">Vehicle settings</a></div>`);
    return `<div class="nd-grid nd-vgrid">${inventory}${free}</div>`;
  }

  /** Everything under the section's head: alerts, tiles, and what optional compose lines would add. */
  /**
   * `seen` (optional, kept by the caller while the page is open) keeps rows
   * that come and go in place; see steady().
   */
  function serverBody(s, { range = '15m', hist = null, currency = '$', more = {}, seen = null } = {}) {
    const day = range === '24h' && hist?.series ? hist.series : null;
    const usable = (pts) => Array.isArray(pts) && pts.filter(fin).length > 1;
    const pts = {
      cpu: day ? day.cpu : s.sparks?.cpu,
      gpu: day ? (usable(day.gpuVideo) ? day.gpuVideo : day.gpuBusy) : s.sparks?.gpuVideo,
      gpuBusy: day ? day.gpuBusy : s.sparks?.gpuBusy,
      rx: day ? day.rxBps : s.sparks?.rxBps,
      tx: day ? day.txBps : s.sparks?.txBps
    };
    // A GPU the page has shown keeps its tile, in its place, while a sample
    // leaves it out (its reading failed for a moment), so the tiles after it
    // stay put. `seen` holds their names (no numbers) by key.
    const sampled = (Array.isArray(s.gpus) ? s.gpus : []).filter(Boolean);
    const gpuKey = (g, i) => `gpu:${g.id || g.node || i}`;
    const shown = seen ? seen.get('gpus') || new Map() : null;
    const here = new Map(sampled.map((g, i) => [gpuKey(g, i), g]));
    const list = shown
      ? [...[...shown].map(([k, g]) => [k, here.get(k) || { ...g, held: true }]), ...[...here].filter(([k]) => !shown.has(k))]
      : [...here];
    // one sparkline series for the GPUs: on the first that can report its
    // video engine (it stays there while the engine's use is unknown), else
    // on the first that encodes
    const sparkOn = list.map(([, g]) => g).find(reportsVideo) || list.map(([, g]) => g).find((g) => fin(g.video)) || null;
    const gpus = list.map(([k, g]) => {
      // the sparkline follows the tile's big number: whole-GPU use or the video engine
      const html = gpuTile(g, g === sparkOn ? (reportsOverall(g) ? pts.gpuBusy : pts.gpu) : null, Boolean(day), seen, k);
      if (html && shown && !g.held) shown.set(k, Object.fromEntries(GPU_NAMES.filter((n) => g[n] !== undefined).map((n) => [n, g[n]])));
      return html;
    }).join('');
    if (shown) seen.set('gpus', shown);
    const tiles = [
      cpuTile(s.cpu, pts.cpu, Boolean(day), seen), gpus, powerTile(s.power, s.encoder, s.price, currency, seen), memoryTile(s.memory, seen),
      storageTile(s.filesystems, s.disks, more.disks, fin(s.at) ? s.at : Date.now()), networkTile(s.network, { rx: pts.rx, tx: pts.tx }, Boolean(day)),
      sensorsTile(s.sensors, more.sensors, Number(s.cpu?.sockets) || 1, seen), processTile(s.processes, s.encoder, list.length > 0, seen)
    ].join('');
    // (Logs: the last tile of the same section)
    const alerts = (Array.isArray(s.alerts) ? s.alerts : []).filter((a) => a && a.message).map((a) => `<div class="nd-alert${a.level === 'error' ? ' bad' : ''}"><b>${a.level === 'error' ? 'Problem' : 'Warning'}</b>${esc(a.message)} · <a href="#/overview/logs">Logs</a></div>`).join('');
    const unlock = (Array.isArray(s.unlock) ? s.unlock : []).filter((u) => u && u.adds);
    const foot = unlock.length
      ? `<p>Shown only when the server provides it. More with one optional line each in <code>docker-compose.yml</code>:</p>
        <ul>${unlock.map((u) => `<li>${esc(u.adds)}${u.compose ? `: <code>${esc(u.compose)}</code>` : ''}</li>`).join('')}</ul><p>Every number stays on this server.</p>`
      : '<p>Shown only when the server provides it. Every number stays on this server.</p>';
    return `${alerts}${tiles ? `<div class="nd-grid">${tiles}</div>` : '<p class="muted nd-none">The server has no numbers to show here.</p>'}<div class="muted small nd-foot">${foot}</div>`;
  }
  // ---- server monitor: end of drawing ----

  const monitor = {
    snap: null, error: null, timer: null, gen: 0, active: false,
    range: store.get('statsRange', '15m') === '24h' ? '24h' : '15m', hist: null, histAt: 0, more: {},
    // while the page stays open: the rows each tile has shown (steady()) and
    // the tallest the tiles have been, so a poll never makes the page jump
    seen: new Map(), tallest: 0, procScroll: 0
  };
  /** Back to the tiles' own height (a new visit, another range, a fold, a resize). */
  function releaseMonitorHeight({ rows = false } = {}) {
    monitor.tallest = 0;
    if (rows) {
      monitor.seen = new Map();
      monitor.procScroll = 0;
    }
    const body = $('nd-server')?.querySelector('.nd-body');
    if (body) body.style.minHeight = '';
  }
  const nerdStats = () => store.get('nerdStats', true) !== false;

  function serverSection() {
    const on = nerdStats();
    return `<section class="card nd-server" id="nd-server" aria-labelledby="nd-title">
      <div class="nd-head"><div><h2 id="nd-title">Server</h2><p class="muted small nd-sub">${on ? '' : 'Nerd stats are off. Turn them on to see what the server is doing: CPU, GPU, power, disks, network and temperatures.'}</p></div>
        <div class="nd-head-right"><span class="nd-chipbox"></span>
          ${on ? `<div class="seg nd-range" role="group" aria-label="Graphs over"><button type="button" data-range="15m">15 min</button><button type="button" data-range="24h">24 h</button></div>
          <a class="btn sm" href="/api/stats/export.csv?range=24h" download title="The last 24 hours as a spreadsheet">CSV</a>` : ''}
          <label class="check small"><input type="checkbox" id="nd-toggle" data-kept${on ? ' checked' : ''}> Nerd stats</label></div></div>
      ${vehicleTiles(current())}
      ${on ? '<div class="nd-body"></div>' : ''}
      ${logsPart()}</section>`;
  }

  function drawMonitor() {
    const root = $('nd-server');
    const body = root?.querySelector('.nd-body');
    if (!body) return;
    // the reader is highlighting something in it: the numbers wait
    if (monitorSelecting(root)) {
      held.monitor = true;
      return;
    }
    const s = monitor.snap;
    root.querySelectorAll('[data-range]').forEach((b) => {
      b.classList.toggle('on', b.dataset.range === monitor.range);
      b.setAttribute('aria-pressed', String(b.dataset.range === monitor.range));
    });
    // With numbers on screen, the line always holds room for "Not updating
    // right now" (hidden until a poll fails), so one failed poll does not
    // push the tiles down and back up.
    const host = s ? hostLine(s.host) : '';
    const sub = s
      ? `${host}<span class="nd-nb nd-stale${monitor.error ? '' : ' off'}"${monitor.error ? '' : ' aria-hidden="true"'}>${host ? ' · ' : ''}<span class="nd-warn">Not updating right now</span></span>`
      : monitor.error ? `<span class="nd-warn">Can't show the server's numbers: ${esc(monitor.error)}</span>` : 'Loading…';
    keepScroll(() => {
      root.querySelector('.nd-sub').innerHTML = sub;
      root.querySelector('.nd-chipbox').innerHTML = s ? alertChip(s.alerts) : '';
      body.innerHTML = s ? serverBody(s, {
        range: monitor.range, hist: monitor.hist, more: monitor.more, seen: monitor.seen,
        currency: s.price?.currency || state.power?.currency || '$'
      }) : '';
      // the process list: 8 rows and half of the ninth (there is more below),
      // and it stays where the reader scrolled it
      const procs = body.querySelector('.nd-procs-box');
      if (procs) {
        const head = procs.querySelector('thead')?.getBoundingClientRect().height || 0;
        const row = procs.querySelector('tbody tr')?.getBoundingClientRect().height || 0;
        if (head && row) procs.style.maxHeight = `${Math.ceil(head + row * (PROCESS_ROWS + 0.5))}px`;
        if (monitor.procScroll) procs.scrollTop = monitor.procScroll;
      }
      // Rebuilt on every poll: a tile that grows for a moment would make the
      // page jump back up when it shrinks again (at the bottom of the page the
      // browser has to scroll). The tiles never get shorter while the page is
      // open; leaving it, another range, a fold or a resize lets them.
      if (s) {
        monitor.tallest = Math.max(monitor.tallest, body.offsetHeight);
        body.style.minHeight = `${monitor.tallest}px`;
      }
    });
    // (the tiles above the logs have arrived: they stay in view)
    if (s) revealLogs();
  }

  /** Polls while wanted; a new Overview render draws the last sample at once. */
  function mountMonitor() {
    const root = $('nd-server');
    if (!root) return;
    $('nd-toggle').onchange = (e) => {
      store.set('nerdStats', e.target.checked);
      releaseMonitorHeight({ rows: true });
      root.outerHTML = serverSection();
      mountOverview();
      $('nd-toggle')?.focus({ preventScroll: true });
    };
    root.querySelectorAll('[data-range]').forEach((b) => {
      b.onclick = () => {
        monitor.range = b.dataset.range;
        store.set('statsRange', monitor.range);
        monitor.histAt = 0;
        releaseMonitorHeight();
        drawMonitor();
        stopMonitor();
        startMonitor();
      };
    });
    root.addEventListener('scroll', (e) => {
      if (e.target.classList?.contains('nd-procs-box')) monitor.procScroll = e.target.scrollTop;
    }, true);
    root.addEventListener('click', (e) => {
      const more = e.target.closest('[data-nd-more]');
      if (!more) return;
      monitor.more[more.dataset.ndMore] = !monitor.more[more.dataset.ndMore];
      releaseMonitorHeight();
      drawMonitor();
    });
    drawMonitor();
    if (nerdStats()) startMonitor();
    else stopMonitor();
  }

  const monitorWanted = () => state.route === 'overview' && nerdStats() && document.visibilityState === 'visible' && Boolean($('nd-server'));
  function stopMonitor() {
    monitor.gen++;
    monitor.active = false;
    clearTimeout(monitor.timer);
    monitor.timer = null;
  }
  function startMonitor() {
    if (!monitorWanted()) return stopMonitor();
    if (monitor.active) return undefined; // already polling: the next sample lands in the new section
    monitor.active = true;
    return pollMonitor(++monitor.gen);
  }
  async function pollMonitor(gen) {
    try {
      // the 24 h graphs change once a minute
      const day = monitor.range === '24h' && Date.now() - monitor.histAt > 60000;
      const [snap, hist] = await Promise.all([
        api('/api/stats', { timeoutMs: 10000 }),
        day ? api('/api/stats/history?range=24h', { timeoutMs: 15000 }).catch(() => null) : null
      ]);
      if (gen !== monitor.gen) return;
      monitor.snap = snap;
      monitor.error = null;
      if (hist) Object.assign(monitor, { hist, histAt: Date.now() });
    } catch (err) {
      if (gen !== monitor.gen) return;
      monitor.error = err.message;
    }
    drawMonitor();
    if (gen === monitor.gen && monitorWanted()) monitor.timer = setTimeout(() => pollMonitor(gen), 2000);
    else if (gen === monitor.gen) monitor.active = false;
  }
  // a hidden tab asks nothing; it catches up when shown again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startMonitor();
    else stopMonitor();
  });
  // another width lays the tiles out anew (a phone turned, a window resized)
  let monitorWidth = innerWidth;
  window.addEventListener('resize', () => {
    if (innerWidth === monitorWidth) return;
    monitorWidth = innerWidth;
    releaseMonitorHeight();
    releaseLogsHeight();
    if (monitor.snap) drawMonitor();
  });

  // ---------- Overview > Logs ----------
  // The warnings and errors (or everything) the server keeps, newest first,
  // as the last tile of the Server section. The lines are asked for after
  // the page has shown, again whenever the page is redrawn and with Refresh;
  // until they arrive the last ones stay, so a redraw never empties the box.
  // While the page is open the box never gets shorter (a refresh with fewer
  // lines would make the page jump), keeps where the reader scrolled it, and
  // waits while they highlight in it. Every line from the server is escaped.
  // The box is not a live region: it is replaced by live updates too, and a
  // screen reader would read out up to 300 lines nobody asked for. A short
  // status says what arrived, only after Refresh or Everything.
  const logs = { all: false, html: '', gen: 0, tallest: 0, scroll: 0, drawn: null };
  const logLine = (l) => `<div class="logline ${esc(l.level)}"><span class="logwhen">${esc(when(l.at))}</span><span class="loglevel">${esc(l.level)}</span><span class="logscope">${esc(l.scope)}</span><span class="logmsg">${esc(l.message)}</span></div>`;

  function logsPart() {
    return `<div class="nd-tile nd-logs" id="ov-logs" role="region" aria-label="Logs">
      <div class="nd-title"><span>Logs</span><span class="muted">newest first</span></div>
      <div class="nd-logs-bar"><p class="muted small">Warnings and errors from the server, the converter and the container. Kept in the data folder (<code>logs/manager.log</code>), so nothing needs a shell on the server.</p>
        <div class="nd-logs-actions"><label class="check small"><input type="checkbox" id="log-all" data-kept${logs.all ? ' checked' : ''}> Everything</label>
          <button type="button" class="btn sm" id="log-refresh">Refresh</button><a class="btn sm" href="/api/logs/download" download>Download</a><button type="button" class="btn sm" id="log-clear">Clear</button></div></div>
      <p class="sr-only" id="log-status" role="status"></p>
      <div class="logbox" id="log-list"${logs.tallest ? ` style="min-height:${logs.tallest}px"` : ''}>${logs.html || '<p class="muted small">Loading…</p>'}</div>
      <details class="log-archive" id="log-archive"${logs.archiveOpen ? ' open' : ''}><summary>Cleared logs</summary><div id="log-archive-list"><p class="muted small">Loading…</p></div></details></div>`;
  }

  /** Back to the box's own height (a new visit, the other list, a resize). */
  function releaseLogsHeight({ scroll = false } = {}) {
    logs.tallest = 0;
    if (scroll) logs.scroll = 0;
    const box = $('log-list');
    if (box) box.style.minHeight = '';
  }

  function mountLogs() {
    const box = $('log-list');
    if (!box) return;
    logs.drawn = { box, html: logs.html };
    if (logs.scroll) box.scrollTop = logs.scroll;
    box.addEventListener('scroll', () => { logs.scroll = box.scrollTop; }, { passive: true });
    $('log-all').onchange = (e) => {
      logs.all = e.target.checked;
      releaseLogsHeight({ scroll: true });
      loadLogs({ tell: true });
    };
    $('log-refresh').onclick = () => loadLogs({ tell: true });
    $('log-clear').onclick = async () => {
      const ok = await confirmDialog({
        title: 'Clear the logs?',
        body: '<p>The logs start empty. Nothing is deleted: the current lines move to <code>logs/archive/</code> in the data folder, and you can download them under Cleared logs.</p>',
        ok: 'Clear logs'
      });
      if (!ok) return;
      try {
        await api('/api/logs/clear', { method: 'POST' });
        toast('Logs cleared. The earlier lines are under Cleared logs.');
      } catch (err) {
        toast(err.message, true);
      }
      releaseLogsHeight({ scroll: true });
      loadLogs({ tell: true });
      loadLogArchive();
    };
    $('log-archive').ontoggle = (e) => {
      logs.archiveOpen = e.target.open;
      if (e.target.open) loadLogArchive();
    };
    loadLogArchive();
    // the lines come after the page has shown
    requestAnimationFrame(() => setTimeout(loadLogs, 0));
  }

  async function loadLogArchive() {
    const list = $('log-archive-list');
    if (!list) return;
    let html;
    try {
      const { archives = [] } = await api('/api/logs/archive', { timeoutMs: 15000 });
      html = archives.length
        ? `<ul>${archives.map((a) => `<li><a href="/api/logs/archive/${encodeURIComponent(a.name)}" download>${esc(when(a.at))}</a> <span class="muted small">${bytes(a.bytes)}</span></li>`).join('')}</ul>`
        : '<p class="muted small">None yet. Clear moves the logs here instead of deleting them.</p>';
    } catch (err) {
      html = `<p class="muted small">Could not list them: ${esc(err.message)}</p>`;
    }
    const now = $('log-archive-list');
    if (now) now.innerHTML = html;
  }

  /** `tell`: the reader asked (Refresh, Everything), so the status says what arrived. */
  async function loadLogs({ tell = false } = {}) {
    const gen = ++logs.gen;
    const all = logs.all;
    let html;
    let said;
    try {
      const out = await api(`/api/logs?level=${all ? 'all' : 'problems'}`, { timeoutMs: 15000 });
      const lines = Array.isArray(out.lines) ? out.lines : [];
      const empty = all ? 'Nothing logged yet.' : 'No warnings or errors. Tick Everything to see all activity.';
      html = lines.length ? lines.map(logLine).join('') : `<p class="muted small">${empty}</p>`;
      said = lines.length ? `${plural(lines.length, 'line')}${all ? '' : ' of warnings and errors'}, newest first.` : empty;
    } catch (err) {
      html = `<p class="muted small">Could not load the log: ${esc(err.message)}</p>`;
      said = 'Could not load the log.';
    }
    if (gen !== logs.gen) return;
    logs.html = html;
    drawLogs();
    if (tell) sayLogs(said);
  }

  /** The status line, emptied first so the same words are read out again. */
  function sayLogs(text) {
    const status = $('log-status');
    if (!status) return;
    status.textContent = '';
    setTimeout(() => { if (status.isConnected) status.textContent = text; }, 100);
  }

  function drawLogs() {
    const box = $('log-list');
    if (!box || state.route !== 'overview') return;
    if (logs.drawn?.box !== box || logs.drawn.html !== logs.html) {
      // the reader is highlighting a line: the new ones wait
      if (selecting(box)) {
        held.logs = true;
        return;
      }
      keepScroll(() => {
        box.innerHTML = logs.html;
        box.scrollTop = logs.scroll;
        logs.tallest = Math.max(logs.tallest, box.offsetHeight);
        box.style.minHeight = `${logs.tallest}px`;
      });
      logs.drawn = { box, html: logs.html };
    }
    revealLogs();
  }

  // #/overview/logs (the alerts' Logs links; old #/settings/logs links land
  // here too): the Overview with its Logs in view, kept there while the
  // tiles above them arrive, until the reader scrolls or a few seconds pass.
  const LOGS_HASH = /^#\/?(overview|settings)\/logs\/?$/;
  let revealUntil = 0;
  function revealLogs() {
    if (Date.now() > revealUntil || state.route !== 'overview') return;
    $('ov-logs')?.scrollIntoView({ block: 'start' });
  }
  for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
    addEventListener(type, () => { revealUntil = 0; }, { capture: true, passive: true });
  }

  // Footage, one card per capture day (newest first, all closed): a
  // thumbnail, what the day holds, how much of it is encoded, and actions
  // for the whole day. A day the reader opens lists its recordings and stays
  // open (live updates, filters, paging, coming back to the page) until they
  // close it or pick another vehicle; picking a date in the filter opens it.
  pages.footage = async () => {
    const v = current();
    const f = state.footage;
    let html = head('Your archive workspace', 'Footage') + pills();
    if (!v) {
      page.innerHTML = `${html}<div class="empty">Add a vehicle in Settings first.</div>`;
      return;
    }
    if (f.vehicleId !== v.id) Object.assign(f, { vehicleId: v.id, open: new Set(), offset: 0 });
    const q = new URLSearchParams({ category: f.category, offset: String(f.offset), limit: String(DAYS_PER_PAGE) });
    if (f.date) q.set('date', f.date);
    let data;
    try {
      data = await api(`/api/vehicles/${v.id}/days?${q}`);
    } catch (err) {
      page.innerHTML = `${html}<div class="empty">${esc(err.message)}</div>`;
      return;
    }
    // the recordings of the open days
    const recQ = (day) => new URLSearchParams({ category: f.category, date: day, limit: '500' });
    const loaded = await Promise.all(data.days.filter((d) => f.open.has(d.day))
      .map((d) => api(`/api/vehicles/${v.id}/recordings?${recQ(d.day)}`).then((x) => [d.day, x.recordings], () => [d.day, []])));
    f.dayRecs = new Map(loaded);
    f.data = { recordings: loaded.flatMap(([, list]) => list) };
    const sel = [...f.selected];
    const selRecs = f.data.recordings.filter((r) => f.selected.has(r.id));
    html += `<div class="filters">
        <label class="field">Category<select class="input" id="f-cat">
          ${['all', 'Recent', 'Sentry', 'Saved', 'Other'].map((c) => `<option value="${c}"${f.category === c ? ' selected' : ''}>${c === 'all' ? 'All categories' : `${c}`}</option>`).join('')}</select></label>
        <label class="field">Capture date<input class="input" type="date" id="f-date" value="${esc(f.date)}"${data.dates.length ? ` min="${data.dates[data.dates.length - 1]}" max="${data.dates[0]}"` : ''}></label>
        ${f.date ? '<button class="btn ghost" id="f-clear">Clear date</button>' : ''}
      </div>
      <p class="hint">${plural(data.total, 'day')} · ${plural(data.recordings, 'recording')}${data.scanning ? ' · scanning…' : ''} · capture times use the vehicle timezone${data.scannedAt ? ` · inventory ${ago(data.scannedAt)}` : ''}</p>
      <div class="selpanel"><div class="row">
        <b class="count">${sel.length} selected</b>
        <button class="btn" id="sel-trash"${sel.length ? '' : ' disabled'}>Move to trash</button>
        <button class="btn green" id="sel-protect"${sel.length ? '' : ' disabled'}>Protect</button>
        <button class="btn" id="sel-unprotect"${selRecs.some((r) => r.protected) ? '' : ' disabled'}>Unprotect</button>
        <button class="btn" id="sel-clear"${sel.length ? '' : ' disabled'}>Clear selection</button>
        <button class="btn green" id="sel-review" type="button">Review conversion</button>
      </div></div>`;
    if (!data.days.length) {
      html += `<div class="empty">${data.error ? esc(data.error) : data.scanning ? 'Scanning the share…' : 'No recordings match. Try another category or date, or refresh the inventory.'}</div>`;
    } else {
      html += `<div class="days">${data.days.map((d) => dayCard(v, d)).join('')}</div>`;
      if (data.total > data.offset + data.days.length || data.offset > 0) {
        html += `<div class="form-actions" style="justify-content:center">
          <button class="btn" id="pg-prev"${data.offset ? '' : ' disabled'}>Newer days</button>
          <span class="muted" style="align-self:center">days ${data.offset + 1}–${data.offset + data.days.length} of ${data.total}</span>
          <button class="btn" id="pg-next"${data.total > data.offset + data.days.length ? '' : ' disabled'}>Older days</button></div>`;
      }
    }
    page.innerHTML = html;

    $('f-cat').onchange = (e) => { f.category = e.target.value; f.offset = 0; render(); };
    $('f-date').onchange = (e) => { f.date = e.target.value; f.offset = 0; if (f.date) f.open.add(f.date); render(); };
    if ($('f-clear')) $('f-clear').onclick = () => { f.date = ''; f.offset = 0; render(); };
    if ($('pg-prev')) $('pg-prev').onclick = () => { f.offset = Math.max(0, f.offset - DAYS_PER_PAGE); render(); };
    if ($('pg-next')) $('pg-next').onclick = () => { f.offset += DAYS_PER_PAGE; render(); };
    $('sel-clear').onclick = () => { f.selected.clear(); render(); };
    $('sel-trash').onclick = () => trash(v, [...f.selected]);
    $('sel-protect').onclick = () => protect(v, [...f.selected], true);
    $('sel-unprotect').onclick = () => protect(v, [...f.selected], false);
    $('sel-review').onclick = () => reviewConversion(v);
    page.querySelectorAll('.day').forEach((el) => {
      const day = el.dataset.day;
      el.querySelector('[data-toggle]').onclick = () => { if (f.open.has(day)) f.open.delete(day); else f.open.add(day); render(); };
      el.querySelector('[data-play-day]').onclick = () => openStudio('viewer', { date: day });
      el.querySelector('[data-delete-day]').onclick = () => deleteDays(v, day, false);
      el.querySelector('[data-delete-through]').onclick = () => deleteDays(v, day, true);
      el.querySelector('[data-select-day]').onchange = async (e) => {
        const on = e.target.checked;
        const list = f.dayRecs.get(day) || await api(`/api/vehicles/${v.id}/recordings?${recQ(day)}`).then((x) => x.recordings, () => []);
        list.forEach((r) => (on ? f.selected.add(r.id) : f.selected.delete(r.id)));
        render();
      };
    });
    page.querySelectorAll('.rec').forEach((el) => {
      const id = el.dataset.id;
      el.querySelector('input[type=checkbox]').onchange = (e) => { if (e.target.checked) f.selected.add(id); else f.selected.delete(id); render(); };
      el.querySelector('[data-play]').onclick = () => play(v, id);
      el.querySelector('[data-files]').onclick = () => { if (f.expanded.has(id)) f.expanded.delete(id); else f.expanded.add(id); render(); };
      el.querySelector('[data-protect]').onclick = (e) => protect(v, [id], e.currentTarget.dataset.protect !== 'on');
      el.querySelector('[data-trash]')?.addEventListener('click', () => trash(v, [id]));
    });
    for (const id of f.expanded) loadFiles(v, id);
  };

  const DAYS_PER_PAGE = 30;
  const CODEC_NAMES = { h265: 'H.265', av1: 'AV1', h264: 'H.264' };
  const minutesText = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
  const dayTitle = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });

  /** The blue "Encoded" badge of a day: every recording, or how many of them. */
  function dayEncodedChip(d) {
    if (!d.encodedRecordings) return '';
    const label = d.encodedRecordings === d.recordings ? 'Encoded' : `Encoded ${d.encodedRecordings}/${d.recordings}`;
    return `<span class="chip blue" title="${esc(`${d.encoded} of ${d.clips} clips are H.265 or AV1`)}"><span class="cdot"></span>${label}</span>`;
  }

  function dayCard(v, d) {
    const f = state.footage;
    const open = f.open.has(d.day);
    const recs = f.dayRecs.get(d.day) || [];
    const allSelected = recs.length > 0 && recs.every((r) => f.selected.has(r.id));
    const cat = (name, chip, word) => (d.byCategory[name] ? `<span class="chip ${chip}">${plural(d.byCategory[name], word)}</span>` : '');
    const thumb = d.thumbId
      ? `<img loading="lazy" alt="" data-fallback="${esc(d.day)}" src="/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(d.thumbId)}/thumbnail">`
      : '';
    return `<article class="day${open ? ' open' : ''}" data-day="${esc(d.day)}">
      <div class="day-top">
        <input type="checkbox" data-select-day aria-label="Select every recording of ${esc(d.day)}"${allSelected ? ' checked' : ''}>
        <div class="day-thumb">${thumb}<span class="count">${plural(d.recordings, 'recording')}</span></div>
        <div class="day-info">
          <span class="date">${esc(dayTitle(d.day))}</span>
          <span class="row">${cat('Recent', '', 'drive')}${cat('Sentry', 'amber', 'Sentry event')}${cat('Saved', 'green', 'Saved event')}${cat('Other', '', 'other')}${dayEncodedChip(d)}${d.protected ? `<span class="chip green">${d.protected} protected</span>` : ''}</span>
          <span class="meta">${minutesText(d.minutes)}${d.cameras ? ` · ${plural(d.cameras, 'camera')}` : ''} · ${bytes(d.bytes)}${d.unknown ? ' · checking which clips are encoded…' : ''}</span>
        </div>
        <div class="day-actions">
          <button class="btn solid" data-play-day>Play day</button>
          <button class="btn" data-delete-day>Delete this day</button>
          <button class="btn" data-delete-through>Delete through this date</button>
        </div>
      </div>
      <button class="day-toggle" type="button" data-toggle aria-expanded="${open}">${open ? '▾ Hide recordings' : `▸ Show ${plural(d.recordings, 'recording')}`}</button>
      ${open ? `<div class="recs">${recs.map((r) => recCard(v, r)).join('') || '<p class="muted">No recordings.</p>'}</div>` : ''}
    </article>`;
  }

  // "Delete this day" / "Delete through this date": everything that day (or
  // that day and older) goes to the Recycle Bin; protected recordings stay.
  async function deleteDays(v, day, through) {
    const f = state.footage;
    const body = { day, through, category: f.category };
    let preview;
    try {
      preview = await api(`/api/vehicles/${v.id}/trash-days`, { body: { ...body, preview: true } });
    } catch (err) {
      toast(err.message, true);
      return;
    }
    const what = through ? `${esc(dayTitle(day))} and every older day` : esc(dayTitle(day));
    const scope = f.category === 'all' ? '' : ` (${esc(f.category)} only, as filtered)`;
    if (!preview.recordings) {
      toast(preview.protected ? 'Everything there is protected: nothing to move.' : 'Nothing to move.');
      return;
    }
    const ok = await confirmDialog({
      title: through ? 'Delete through this date?' : 'Delete this day?',
      body: `<p>${plural(preview.recordings, 'recording')} from ${what}${scope}, ${bytes(preview.bytes)}${through && preview.days > 1 ? ` over ${plural(preview.days, 'day')}` : ''}, move to the Recycle Bin.</p>
        <p>Nothing is deleted for good until you empty the Recycle Bin; you can restore it until then.${preview.protected ? ` ${plural(preview.protected, 'protected recording')} stay${preview.protected === 1 ? 's' : ''}.` : ''}</p>`,
      ok: through ? 'Delete through this date' : 'Delete this day',
      danger: true
    });
    if (!ok) return;
    try {
      const out = await api(`/api/vehicles/${v.id}/trash-days`, { body });
      toast(`Moving ${plural(out.recordings, 'recording')} (${bytes(out.bytes)}) to the Recycle Bin. Jobs shows the progress.`);
      f.selected.clear();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /** "Encoded H.265" when every clip is encoded, "Encoded 3/6 clips" when some are. */
  function recEncodedChip(r) {
    const e = r.encoded;
    if (!e || !e.clips || !e.encoded) return '';
    const name = e.codecs.map((c) => CODEC_NAMES[c] || c).join(' + ');
    return `<span class="chip blue"><span class="cdot"></span>${e.encoded === e.clips ? `Encoded ${esc(name)}` : `Encoded ${e.encoded}/${e.clips} clips`}</span>`;
  }

  function recCard(v, r) {
    const f = state.footage;
    const chip = r.category === 'Saved' ? 'green' : r.category === 'Sentry' ? 'amber' : '';
    const thumb = (r.thumbRel || r.frontRel)
      ? `<img loading="lazy" alt="" data-fallback="${esc(r.category)}" src="/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(r.id)}/thumbnail">`
      : esc(r.category);
    const range = r.start && r.end && r.end !== r.start ? ` – ${esc(r.end.slice(11))}` : '';
    return `<article class="rec${f.selected.has(r.id) ? ' selected' : ''}" data-id="${esc(r.id)}">
      <div class="rec-top">
        <input type="checkbox" aria-label="Select ${esc(r.start)}"${f.selected.has(r.id) ? ' checked' : ''}>
        <div class="thumb">${thumb}</div>
        <div class="rec-info"><span class="when">${esc(r.start || r.day)}${range}</span>
          <span class="meta"><span class="chip ${chip}">${esc(r.category)}</span>${recEncodedChip(r)}<span>${plural(r.fileCount, 'file')}</span><span>${bytes(r.bytes)}</span>${r.eventAt ? `<span>event ${esc(r.eventAt.slice(11))}</span>` : ''}${r.cameras.length ? `<span>${plural(r.cameras.length, 'camera')}</span>` : ''}${r.protected ? '<span class="chip green">Protected</span>' : ''}</span>
          <span class="orig">Original capture: ${esc(r.startKey ? `${r.startKey.slice(0, 10)}T${r.startKey.slice(11).replace(/-/g, ':')}` : r.day)} · ${esc(r.folder)}</span></div>
        <div class="rec-actions"><button class="btn" data-play>Play recording</button><button class="btn" data-files>${f.expanded.has(r.id) ? 'Hide files' : 'Show files'}</button></div>
      </div>
      <div class="rec-bottom"><button class="btn${r.protected ? ' green' : ''}" data-protect="${r.protected ? 'on' : 'off'}">${r.protected ? 'Protected · unprotect' : 'Protect recording'}</button>
        ${r.protected ? '' : '<button class="btn ghost" data-trash>Move to trash</button>'}</div>
      ${f.expanded.has(r.id) ? `<ul class="files" id="files-${esc(r.id)}"><li><span>Loading…</span></li></ul>` : ''}
    </article>`;
  }

  const ENCODED_CODECS = new Set(['h265', 'av1']);
  /** A clip's codec: blue when encoded, amber when still the original H.264. */
  function codecTag(f) {
    if (!('codec' in f)) return '<span></span>';
    if (!f.codec) return '<span class="ftag muted">checking</span>';
    const name = CODEC_NAMES[f.codec] || f.codec.toUpperCase();
    return ENCODED_CODECS.has(f.codec)
      ? `<span class="ftag enc">${esc(name)}</span>`
      : `<span class="ftag plain" title="Not encoded yet">${esc(name)}</span>`;
  }

  async function loadFiles(v, id) {
    const el = document.getElementById(`files-${id}`);
    if (!el) return;
    try {
      const d = await api(`/api/vehicles/${v.id}/recordings/${id}`);
      const ev = d.event ? `<li><span>${esc([humanize(d.event.reason), d.event.city, d.event.street].filter(Boolean).join(' · ') || 'Event')}</span><span></span><span></span></li>` : '';
      const clips = d.files.filter((f) => 'codec' in f);
      const plain = clips.filter((f) => f.codec && !ENCODED_CODECS.has(f.codec)).length;
      const draw = (onlyPlain) => {
        const shown = onlyPlain ? d.files.filter((f) => 'codec' in f && f.codec && !ENCODED_CODECS.has(f.codec)) : d.files;
        const head = plain
          ? `<li class="files-head"><span>${plural(plain, 'clip')} of ${clips.length} not encoded yet</span><label class="check small"><input type="checkbox" data-only-plain${onlyPlain ? ' checked' : ''}> Not encoded only</label></li>`
          : '';
        el.innerHTML = head + (onlyPlain ? '' : ev) + shown.map((f) => `<li><span title="${esc(f.rel)}">${esc(f.rel)}</span>${codecTag(f)}<span>${bytes(f.size)}</span><a href="/api/media?path=${encodeURIComponent(f.path)}" download>Download</a></li>`).join('');
        const box = el.querySelector('[data-only-plain]');
        if (box) box.onchange = () => draw(box.checked);
      };
      draw(false);
    } catch (err) {
      el.innerHTML = `<li><span>${esc(err.message)}</span></li>`;
    }
  }

  async function protect(v, ids, on) {
    if (!ids.length) return;
    await api(`/api/vehicles/${v.id}/protect`, { body: { ids, protected: on } }).then(() => toast(on ? 'Protected: policies and Move to trash will skip it.' : 'Protection removed.'), (err) => toast(err.message, true));
    render();
  }

  async function trash(v, ids) {
    if (!ids.length) return;
    const recs = (state.footage.data?.recordings || []).filter((r) => ids.includes(r.id));
    const total = recs.reduce((n, r) => n + r.bytes, 0);
    const ok = await confirmDialog({
      title: `Move ${plural(ids.length, 'recording')} to the Recycle Bin?`,
      body: `<p>${bytes(total)} moves to the Recycle Bin on the same share. Nothing is deleted: restore it any time, or delete it forever from the Recycle Bin.</p>${recs.some((r) => r.protected) ? '<p>Protected recordings are skipped.</p>' : ''}`,
      ok: 'Move to trash'
    });
    if (!ok) return;
    try {
      const out = await api(`/api/vehicles/${v.id}/trash`, { body: { ids } });
      const why = out.skipped.length ? ` ${out.skipped.length} skipped (${[...new Set(out.skipped.map((s) => s.reason))].join(', ')}).` : '';
      toast(`${plural(out.moved.length, 'recording')} moved to the Recycle Bin (${bytes(out.bytes)}).${why}`, out.skipped.length > 0 && !out.moved.length);
      ids.forEach((id) => state.footage.selected.delete(id));
    } catch (err) {
      toast(err.message, true);
    }
    await loadVehicles().catch(() => {});
    render();
  }

  async function play(v, id) {
    try {
      const d = await api(`/api/vehicles/${v.id}/recordings/${id}`);
      // events open their own folder; drives open the clip folder they are in
      openStudio('viewer', { folder: d.folderPath });
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- embedded Studio (Viewer / Encoder) ----------
  const frames = {};
  // The Encoder page's loading skeleton (index.html, the same as the page's
  // own): drawn behind its frame, so the tab shows it from the moment it
  // opens until the page has arrived and painted the same skeleton over it.
  const bootFrame = $('encoder-skeleton');
  const ENCODER_SKELETON = bootFrame?.innerHTML || '';
  // The Viewer shows the selected vehicle's footage (Studio's page); the
  // Encoder converts it (a page with only the converter: encoder.html).
  function studioUrl(kind, extra = {}) {
    const v = current();
    const q = new URLSearchParams({
      embed: kind,
      // (before the vehicles have loaded: the one picked last time)
      ...(v ? { root: v.studioRoot || v.root, vehicle: v.id } : state.vehicleId ? { vehicle: state.vehicleId } : {}),
      ...extra
    });
    return `/studio/${kind === 'encoder' ? 'encoder' : 'index'}.html?${q}`;
  }
  function openStudio(kind, extra = {}) {
    pendingFrame[kind] = studioUrl(kind, extra);
    if (location.hash === `#/${kind}`) render();
    else location.hash = `#/${kind}`;
  }
  const pendingFrame = {};
  /** Open the Encoder with this vehicle's footage folder as the source. */
  function reviewConversion(v) {
    const folder = v.studioRoot || v.root;
    const frame = frames.encoder?.querySelector('iframe');
    if (!frame) return openStudio('encoder', { source: folder });
    location.hash = '#/encoder';
    frame.contentWindow?.postMessage({ type: 'use-source', folder }, location.origin);
    return undefined;
  }
  function showFrame(kind) {
    // a tab opened for another vehicle than the selected one starts over
    const same = frames[kind] && frames[kind].dataset.vehicle === String(current()?.id || '');
    const url = pendingFrame[kind] || (same ? frames[kind].dataset.src : studioUrl(kind));
    delete pendingFrame[kind];
    if (!frames[kind] || frames[kind].dataset.src !== url) {
      frames[kind]?.remove();
      const wrap = document.createElement('div');
      wrap.className = 'frame-wrap';
      wrap.dataset.src = url;
      wrap.dataset.vehicle = String(current()?.id || '');
      wrap.innerHTML = `<iframe title="Sentry Studio ${kind}" src="${esc(url)}" allow="fullscreen; clipboard-write"></iframe>`;
      if (kind === 'encoder') {
        wrap.classList.add('frame-loading');
        wrap.insertAdjacentHTML('afterbegin', ENCODER_SKELETON);
        wrap.querySelector('iframe').addEventListener('load', () => {
          wrap.classList.remove('frame-loading');
          wrap.querySelector('.enc-skeleton')?.remove();
        }, { once: true });
      }
      $('frames').append(wrap);
      frames[kind] = wrap;
    }
    for (const [k, el] of Object.entries(frames)) {
      if (k !== kind) hideFrame(el);
      else if (el.hidden) {
        el.hidden = false;
        el.querySelector('iframe')?.contentWindow?.postMessage({ type: 'shown' }, location.origin);
      }
    }
    fitFrames();
  }
  // A Studio tab that is put away stops playing, so six videos don't keep
  // decoding in the background (battery on phones and tablets).
  function hideFrame(el) {
    if (!el.hidden) el.querySelector('iframe')?.contentWindow?.postMessage({ type: 'pause' }, location.origin);
    el.hidden = true;
  }

  // Studio's viewer needs about 900px; on narrower screens (phones) it is
  // drawn at that width and scaled down to fit, instead of overlapping itself.
  const VIEWER_MIN_WIDTH = 900;
  function fitFrames() {
    const wrap = frames.viewer;
    const iframe = wrap?.querySelector('iframe');
    if (!iframe || wrap.hidden) return;
    const width = wrap.clientWidth;
    if (width && width < VIEWER_MIN_WIDTH) {
      const s = width / VIEWER_MIN_WIDTH;
      Object.assign(iframe.style, { width: `${VIEWER_MIN_WIDTH}px`, height: `${wrap.clientHeight / s}px`, transform: `scale(${s})`, transformOrigin: '0 0' });
    } else {
      Object.assign(iframe.style, { width: '', height: '', transform: '', transformOrigin: '' });
    }
  }
  window.addEventListener('resize', () => fitFrames());
  pages.viewer = () => {
    page.innerHTML = '';
    showFrame('viewer');
  };
  pages.encoder = () => {
    page.innerHTML = '';
    showFrame('encoder');
  };
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.data?.source !== 'sentry-studio') return;
    if (e.data.type === 'showInFolder') {
      state.footage.category = 'all';
      location.hash = '#/footage';
    }
    // the Viewer's vehicle picker
    if (e.data.type === 'select-vehicle' && state.vehicles.some((v) => v.id === e.data.id)) {
      state.vehicleId = e.data.id;
      store.set('vehicle', state.vehicleId);
      state.footage.offset = 0;
      state.footage.selected.clear();
      openStudio('viewer');
    }
  });

  pages.policies = async () => {
    const v = current();
    let html = head('Your archive workspace', 'Policies') + pills();
    if (!v) {
      page.innerHTML = `${html}<div class="empty">Add a vehicle in Settings first.</div>`;
      return;
    }
    const { policy, preview } = await api(`/api/vehicles/${v.id}/policy`);
    html += `<div class="card"><h2>Retention for ${esc(v.name)}</h2>
      <p>Recordings older than the number of days below are moved to the Recycle Bin once a day. Nothing is ever deleted by a policy, and protected recordings are always skipped. Leave a field empty to keep that category forever.</p>
      <form id="pol" style="margin-top:22px">
        <label class="check" style="margin-bottom:18px"><input type="checkbox" name="enabled"${policy.enabled ? ' checked' : ''}> Run this policy every day</label>
        <div class="keep">${['Recent', 'Sentry', 'Saved', 'Other'].map((c) => `<label class="field">Keep ${c} clips (days)<input class="input" type="number" min="1" max="3650" name="keep-${c}" value="${policy.keepDays[c] ?? ''}" placeholder="forever"></label>`).join('')}</div>
        <div class="form" style="margin-top:16px"><label class="field">Run at (server time)<input class="input" type="time" name="runAt" value="${esc(policy.runAt)}"></label></div>
        <div class="note${preview.recordings ? ' amber' : ''}">${preview.recordings ? `With these settings, the next run moves ${plural(preview.recordings, 'recording')} (${bytes(preview.bytes)}) to the Recycle Bin.` : 'With these settings, nothing would be moved right now.'}
          ${policy.lastRunAt ? `<br>Last run ${when(policy.lastRunAt)}: ${policy.lastResult?.error ? esc(policy.lastResult.error) : `${policy.lastResult?.moved ?? 0} moved, ${policy.lastResult?.skipped ?? 0} skipped`}.` : ''}</div>
        <div class="form-actions"><button class="btn" type="button" id="pol-run">Run now</button><button class="btn solid" type="submit">Save policy</button></div>
      </form></div>`;
    page.innerHTML = html;
    const form = $('pol');
    const read = () => {
      const fd = new FormData(form);
      return { enabled: fd.get('enabled') === 'on', runAt: fd.get('runAt'), keepDays: Object.fromEntries(['Recent', 'Sentry', 'Saved', 'Other'].map((c) => [c, fd.get(`keep-${c}`) || null])) };
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/api/vehicles/${v.id}/policy`, { method: 'PUT', body: read() });
        toast('Policy saved.');
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
    $('pol-run').onclick = async () => {
      try {
        await api(`/api/vehicles/${v.id}/policy`, { method: 'PUT', body: read() });
        const p = await api(`/api/vehicles/${v.id}/policy`);
        if (!p.preview.recordings) return toast('Nothing to move right now.');
        if (!(await confirmDialog({ title: 'Run the policy now?', body: `<p>${plural(p.preview.recordings, 'recording')} (${bytes(p.preview.bytes)}) will move to the Recycle Bin. You can restore them from there.</p>`, ok: 'Run now' }))) return;
        const out = await api(`/api/vehicles/${v.id}/policy/run`, { body: {} });
        toast(`${plural(out.moved.length, 'recording')} moved to the Recycle Bin.`);
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
  };

  pages.jobs = async () => {
    const v = current();
    const { jobs } = await api(`/api/jobs${v ? `?vehicle=${encodeURIComponent(v.id)}` : ''}`);
    const running = jobs.filter((j) => j.status === 'running').length;
    setBadge('badge-jobs', running ? String(running) : '', 'busy');
    // (cancelled and interrupted: grey)
    const chip = (s) => `<span class="chip ${s === 'done' ? 'green' : s === 'failed' ? 'red' : s === 'running' ? 'amber' : ''}">${esc(s)}</span>`;
    // conversions the server measured: energy, average power and (with a price) cost
    const withEnergy = jobs.some((j) => fin(j.energy?.wh));
    const energy = (e) => (fin(e?.wh) ? `${energyText(e.wh)}${fin(e.avgW) ? ` · avg ${watts(e.avgW)}` : ''}${fin(e.cost) ? ` · ${money(e.cost, state.power?.currency)}` : ''}` : '');
    // Clear jobs takes the finished ones off the list (the server decides which)
    const finished = jobs.some((j) => j.status !== 'running');
    const clear = `<button class="btn" id="jobs-clear" type="button"${finished ? '' : ' disabled title="No finished jobs to clear"'}>Clear jobs</button>`;
    page.innerHTML = head('Your archive workspace', 'Jobs', clear) + pills() + `<div class="card">
      ${jobs.length ? `<table class="table"><thead><tr><th>Job</th><th>Status</th><th>Details</th><th>Started</th><th>Took</th>${withEnergy ? '<th>Energy</th>' : ''}</tr></thead><tbody>
        ${jobs.map((j) => `<tr><td><b>${esc(j.title)}</b><br><span class="muted small">${esc(j.type)}</span></td><td>${chip(j.status)}</td><td class="small">${esc(j.detail || '')}</td><td class="small">${when(j.startedAt)}</td>
          <td class="small mono">${j.status === 'interrupted' ? '—' : j.finishedAt ? took(j.finishedAt - j.startedAt) : '…'}</td>${withEnergy ? `<td class="small mono energy">${esc(energy(j.energy))}</td>` : ''}</tr>`).join('')}</tbody></table>`
        : '<p>No jobs yet. Scans, conversions, Recycle Bin actions and policy runs show up here.</p>'}</div>`;
    $('jobs-clear').onclick = () => clearJobs(v);
  };

  // Jobs > Clear jobs: the finished jobs (done, failed, cancelled,
  // interrupted) of the vehicle shown leave the list, after a confirmation
  // with how many; running, waiting and paused ones stay. Nothing else
  // changes (footage, converted files, what a paused conversion needs).
  async function clearJobs(v) {
    const body = { vehicle: v?.id || null };
    let preview;
    try {
      preview = await api('/api/jobs/clear', { body: { ...body, preview: true } });
    } catch (err) {
      toast(err.message, true);
      return;
    }
    if (!preview.jobs) {
      toast('Nothing to clear: running, waiting and paused jobs stay on the list.');
      return;
    }
    const ok = await confirmDialog({
      title: 'Clear finished jobs?',
      body: `<p>${plural(preview.jobs, 'finished job')} (done, failed, cancelled or interrupted)${v && state.vehicles.length > 1 ? ` of ${esc(v.name)}` : ''} leave${preview.jobs === 1 ? 's' : ''} the list. Running, waiting and paused jobs stay.</p>
        <p>Only the list is cleared: footage, converted files and what the Encoder needs to resume a conversion are not touched. New jobs show up as before.</p>`,
      ok: 'Clear jobs'
    });
    if (!ok) return;
    try {
      const out = await api('/api/jobs/clear', { body: { ...body, confirm: true } });
      toast(`Cleared ${plural(out.cleared, 'finished job')}.`);
    } catch (err) {
      toast(err.message, true);
    }
    render();
  }

  pages.bin = async () => {
    const v = current();
    const { items } = await api(`/api/bin${v ? `?vehicle=${encodeURIComponent(v.id)}` : ''}`);
    const total = items.reduce((n, i) => n + i.bytes, 0);
    page.innerHTML = head('Your archive workspace', 'Recycle Bin', items.length ? '<button class="btn danger" id="bin-empty">Empty Recycle Bin</button>' : '') + pills() + `
      <div class="note green" style="margin:0 0 20px">Nothing in the Recycle Bin is deleted automatically. Restore puts recordings back exactly where they were; only "Delete forever" and "Empty Recycle Bin" free the space.</div>
      <div class="card">${items.length ? `<p class="muted" style="margin-bottom:12px">${plural(items.length, 'item')} · ${bytes(total)}</p>
        <table class="table"><thead><tr><th>Recording</th><th>Size</th><th>Moved</th><th>Why</th><th></th></tr></thead><tbody>
        ${items.map((i) => `<tr data-item="${esc(i.id)}"><td><b>${esc(i.label)}</b><br><span class="muted small">${plural(i.files.length, 'file')}${i.files.some((f) => f.conflict) ? ' · some files could not be restored (name taken)' : ''}</span></td>
          <td class="mono small">${bytes(i.bytes)}</td><td class="small">${when(i.trashedAt)}</td><td class="small">${i.reason === 'policy' ? 'Policy' : 'You'}</td>
          <td class="actions"><button class="btn sm" data-restore>Restore</button><button class="btn sm danger" data-delete>Delete forever</button></td></tr>`).join('')}</tbody></table>`
        : '<p>The Recycle Bin is empty.</p>'}</div>`;
    page.querySelectorAll('[data-item]').forEach((row) => {
      const id = row.dataset.item;
      const item = items.find((i) => i.id === id);
      row.querySelector('[data-restore]').onclick = async () => {
        try {
          const out = await api(`/api/bin/${encodeURIComponent(id)}/restore`, { body: {} });
          toast(out.conflicts ? `Restored ${out.restored} file(s); ${out.conflicts} could not be (a file with that name exists).` : 'Restored.', out.conflicts > 0);
        } catch (err) {
          toast(err.message, true);
        }
        await loadVehicles().catch(() => {});
        render();
      };
      row.querySelector('[data-delete]').onclick = async () => {
        if (!(await confirmDialog({ title: 'Delete forever?', body: `<p><b>${esc(item.label)}</b> (${bytes(item.bytes)}) will be permanently deleted from the share. This cannot be undone.</p>`, ok: 'Delete forever', danger: true }))) return;
        try {
          await api(`/api/bin/${encodeURIComponent(id)}/delete`, { body: { confirm: true } });
          toast('Deleted.');
        } catch (err) {
          toast(err.message, true);
        }
        await loadVehicles().catch(() => {});
        render();
      };
    });
    if ($('bin-empty')) {
      $('bin-empty').onclick = async () => {
        if (!(await confirmDialog({ title: 'Empty the Recycle Bin?', body: `<p>${plural(items.length, 'item')} (${bytes(total)}) of ${esc(v ? v.name : 'all vehicles')} will be permanently deleted. This cannot be undone.</p>`, ok: 'Empty Recycle Bin', danger: true }))) return;
        try {
          const out = await api('/api/bin/empty', { body: { confirm: true, vehicle: v?.id || null } });
          toast(`Deleted ${plural(out.deleted, 'item')} (${bytes(out.bytes)}).`, out.failed > 0);
        } catch (err) {
          toast(err.message, true);
        }
        await loadVehicles().catch(() => {});
        render();
      };
    }
  };

  // Nodes: other servers running Sentry Six Manager encode clips for this one
  // (server/nodes.js), and this one can encode for another (server/nodeWorker.js).
  // Clips go over HTTPS to the paired certificate only; nodes never get share
  // passwords and never touch footage.
  pages.nodes = async () => {
    const seq = renderSeq;
    const [{ nodes, worker }, { vehicles: cars = [] }] = await Promise.all([api('/api/nodes'), api('/api/vehicles').catch(() => ({ vehicles: [] }))]);
    const benches = Object.fromEntries(await Promise.all(nodes.map(async (n) => [n.id, (await api(`/api/nodes/${encodeURIComponent(n.id)}/benchmark`).catch(() => ({}))).benchmark || null])));
    if (seq !== renderSeq) return;
    const benchRunning = Object.values(benches).some((b) => b?.state === 'running');
    const benchPanel = (n) => {
      const b = benches[n.id];
      if (!b) return '';
      const codec = b.codec === 'av1' ? 'AV1' : 'H.265';
      const rows = b.results.map((r) => `<tr${r.level === b.suggested ? ' class="is-best"' : ''}><td>${r.level} at once</td><td>${r.failed ? `${r.failed} failed` : `${r.clipsPerMinute} clips/min`}</td><td class="muted small">${r.clips} clips in ${r.seconds} s</td></tr>`).join('');
      return `<tr class="node-bench-row"><td colspan="5"><div class="node-bench">
        <div><b>Benchmark, ${codec}</b> <span class="muted small">${b.state === 'running' ? esc(b.phase || 'Running') + '…' : b.state === 'failed' ? `failed: ${esc(b.error || '')}` : b.state === 'cancelled' ? 'cancelled' : `done${b.samples ? ` · ${plural(b.samples, 'sample clip')} from your footage, only read${b.converted ? ' (already converted ones: no originals are left)' : ''}` : ''}`}</span></div>
        ${rows ? `<table class="table" style="margin-top:8px"><tbody>${rows}</tbody></table>` : ''}
        <div class="form-actions" style="margin-top:8px">
          ${b.state === 'running' ? `<button class="btn sm" data-bench-cancel="${esc(n.id)}">Cancel</button>`
            : `${b.suggested ? `<button class="btn sm solid" data-bench-use="${esc(n.id)}" data-level="${b.suggested}">Use ${b.suggested} at once</button>` : ''}<button class="btn sm" data-bench-start="${esc(n.id)}" data-codec="${esc(b.codec)}">Run again</button>`}
        </div></div></td></tr>`;
    };
    // the vehicles a node converts for first, in order (automatic conversion)
    const carName = (id) => cars.find((v) => v.id === id)?.name || id;
    const carsPanel = (n) => {
      if (!cars.length) return '';
      const list = n.cars || [];
      const left = cars.filter((v) => !list.includes(v.id));
      const items = list.map((id, i) => `<li><span class="node-car-rank">${i + 1}</span>${esc(carName(id))}${i > 0 ? `<button class="btn sm ghost" data-car-up="${esc(n.id)}" data-car="${esc(id)}" aria-label="Move ${esc(carName(id))} up">↑</button>` : ''}<button class="btn sm ghost" data-car-remove="${esc(n.id)}" data-car="${esc(id)}" aria-label="Remove ${esc(carName(id))}">✕</button></li>`).join('');
      return `<tr class="node-bench-row"><td colspan="5"><div class="node-cars">
        <b>Vehicles first</b> <span class="muted small">${list.length ? 'Automatic conversion sends this node these vehicles\' new clips first, in this order; with none waiting, it helps the others.' : 'None: it helps whichever vehicle is converting.'}</span>
        ${items ? `<ol class="node-car-list">${items}</ol>` : ''}
        ${left.length ? `<select class="input node-car-add" data-car-add="${esc(n.id)}" aria-label="Add a vehicle for ${esc(n.name)}"><option value="">Add a vehicle…</option>${left.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select>` : ''}
      </div></td></tr>`;
    };
    // a node of your own: its encodes skip the picture check (faster, less safe)
    const trustPanel = (n) => `<tr class="node-bench-row"><td colspan="5"><label class="check node-trust">
        <input type="checkbox" data-node-trust="${esc(n.id)}"${n.trusted ? ' checked' : ''}>
        <span><b>Trusted</b> <span class="muted small">${n.trusted
          ? 'Its encodes replace originals without the picture check (streams, length, frames and telemetry are still verified). Turn off if anyone else could change this computer.'
          : 'Its encodes get the picture check here: a few random stretches of each clip compared with the original. Trust only a computer of your own: it skips that check.'}</span></span>
      </label></td></tr>`;
    const encodersText = (e) => [['H.265', e?.h265], ['AV1', e?.av1]].filter(([, v]) => v).map(([k, v]) => `${k}: ${esc(v)}`).join(' · ') || '—';
    const nodeRows = nodes.map((n) => `<tr>
        <td class="words"><b>${esc(n.name)}</b><br><span class="muted small mono">${esc(n.address)}</span></td>
        <td>${n.online ? '<span class="chip green"><span class="dot ok"></span>Online</span>' : `<span class="chip red"><span class="dot bad"></span>Offline</span><br><span class="muted small words">${esc(n.error || '')}</span>`}</td>
        <td class="small">${encodersText(n.encoders)}</td>
        <td class="small">${n.online && n.slots ? (n.encoding === null ? `${n.busy ?? 0} of ${n.slots} busy` : `${n.encoding} of ${n.slots} converting${n.busy > n.encoding ? ` · ${n.busy - n.encoding} waiting` : ''}`) : '—'}</td>
        <td class="actions">${n.online && !benches[n.id] ? `<button class="btn sm" data-bench-start="${esc(n.id)}" data-codec="h265"${benchRunning ? ' disabled' : ''}>Benchmark</button>${n.encoders?.av1 ? `<button class="btn sm" data-bench-start="${esc(n.id)}" data-codec="av1"${benchRunning ? ' disabled' : ''}>Benchmark AV1</button>` : ''}` : ''}<button class="btn sm" data-rename-node="${esc(n.id)}">Rename</button><button class="btn sm" data-remove-node="${esc(n.id)}">Remove</button></td></tr>${carsPanel(n)}${trustPanel(n)}${benchPanel(n)}`).join('');
    const pairing = worker.pairing;
    const mins = pairing ? Math.max(1, Math.round((pairing.expiresAt - Date.now()) / 60000)) : 0;
    const mainRows = worker.mains.map((m) => `<tr>
        <td class="words"><b>${esc(m.name)}</b><br><span class="muted small mono">${esc(m.address || '')}</span></td>
        <td class="small">Paired ${when(m.pairedAt)}${m.lastSeenAt ? `<br><span class="muted">last seen ${when(m.lastSeenAt)}</span>` : ''}</td>
        <td class="actions"><button class="btn sm" data-revoke-main="${esc(m.id)}">Revoke</button></td></tr>`).join('');

    page.innerHTML = head('Your servers', 'Nodes') + `
      <div class="card"><h2>Nodes this server uses</h2>
        <p class="muted" style="margin-top:6px">Other servers running Sentry Six Manager can encode clips for this one. This server reads each clip, sends it to the node over HTTPS and checks the encoded file before it saves anything, as with its own GPUs. Nodes never get your share passwords and never touch the footage.</p>
        ${nodes.length ? `<table class="table" style="margin-top:14px"><thead><tr><th>Node</th><th>Status</th><th>Encoders</th><th>Clips</th><th></th></tr></thead><tbody>${nodeRows}</tbody></table>
          <p class="muted small" style="margin-top:10px">Each node is a row under <a href="#/encoder">Encoder</a> → Parallel conversions: set how many clips it converts at once there.</p>` : '<p style="margin-top:12px">No nodes yet.</p>'}
        <form id="node-add" class="form" style="margin-top:18px">
          <label class="field">Node address<input class="input" name="address" placeholder="192.168.1.30 or nas.local:9000" autocomplete="off" required></label>
          <label class="field">Pairing code<input class="input mono" name="code" placeholder="ABCD-EFGH-JKLM" autocomplete="off" required></label>
          <div class="full form-actions" style="margin-top:0"><button class="btn solid" type="submit">${icon('plus')} Add node</button></div>
        </form>
        <p class="muted small">On the other server, open Nodes → Let another server use this one → Show pairing code.</p>
      </div>

      <div class="card" style="margin-top:20px"><h2>Let another server use this one</h2>
        ${worker.available ? `
        <p class="muted" style="margin-top:6px">A main server you pair here sends this one clips to encode and takes the encoded files back. It can do nothing else here: no footage, settings or passwords.</p>
        <div class="form" style="margin-top:14px">
          <label class="check"><input type="checkbox" id="worker-on"${worker.enabled ? ' checked' : ''}> Encode for paired main servers</label>
          <label class="field">Clips at once<select class="input" id="worker-slots">${[1, 2, 3, 4, 6, 8].map((n) => `<option${n === worker.slots ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="field">Encode with<select class="input" id="worker-use">${[['gpu', 'GPU (CPU only without a GPU)'], ['gpu-cpu', 'GPU, then CPU if it fails'], ['cpu', 'CPU only']].map(([v, t]) => `<option value="${v}"${v === worker.use ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        </div>
        ${pairing ? `<div class="note green pair-code" style="margin-top:14px">
            <div class="muted small">Pairing code (one use, ${plural(mins, 'minute')} left)</div>
            <div class="mono pair-code-value">${esc(pairing.code)}</div>
            <div class="small">On the main server: Nodes → Add node, with this server's address <b class="mono">${esc(location.hostname)}${location.port && location.port !== '9000' ? `:${esc(location.port)}` : ''}</b> and the code.</div>
            <button class="btn sm" id="pair-cancel" style="margin-top:10px">Cancel</button></div>`
          : '<div class="form-actions" style="margin-top:14px"><button class="btn" id="pair-start">Show pairing code</button></div>'}
        ${worker.mains.length ? `<table class="table" style="margin-top:16px"><thead><tr><th>Main server</th><th>Paired</th><th></th></tr></thead><tbody>${mainRows}</tbody></table>` : ''}
        ` : '<p class="muted" style="margin-top:6px">This server runs without its own HTTPS (TLS_MODE=off), so it cannot be a node: a main server must be able to check its certificate.</p>'}
      </div>`;

    $('node-add').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api('/api/nodes', { body: { address: f.get('address'), code: f.get('code') } });
        toast('Node paired. Set its clips under Encoder → Parallel conversions.');
        render();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    };
    page.querySelectorAll('[data-bench-start]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          await api(`/api/nodes/${encodeURIComponent(b.dataset.benchStart)}/benchmark`, { body: { codec: b.dataset.codec } });
        } catch (err) { toast(err.message, true); }
        render();
      };
    });
    page.querySelectorAll('[data-bench-cancel]').forEach((b) => {
      b.onclick = async () => {
        await api(`/api/nodes/${encodeURIComponent(b.dataset.benchCancel)}/benchmark`, { method: 'DELETE' }).catch(() => {});
        render();
      };
    });
    page.querySelectorAll('[data-bench-use]').forEach((b) => {
      b.onclick = async () => {
        const level = Number(b.dataset.level);
        try {
          await api(`/api/nodes/${encodeURIComponent(b.dataset.benchUse)}/slots`, { body: { slots: level } });
          // and its row under Encoder > Parallel conversions, for the next run
          try {
            const key = 'converterLanes';
            const lanes = JSON.parse(localStorage.getItem(key) || '{}') || {};
            lanes[`node:${b.dataset.benchUse}`] = level;
            localStorage.setItem(key, JSON.stringify(lanes));
          } catch { /* a preference only */ }
          toast(`The node now converts ${level} at once; its Encoder row is set to ${level} too.`);
        } catch (err) { toast(err.message, true); }
        render();
      };
    });
    // follow a running benchmark, and the nodes' clips (converting, waiting)
    // while any node is paired: the numbers were the ones from when the page
    // opened. Hidden tabs and something being typed or picked wait.
    if (benchRunning || nodes.length) {
      const every = benchRunning ? 2500 : 5000;
      const follow = () => {
        if (seq !== renderSeq || !location.hash.startsWith('#/nodes')) return;
        // (nor a node address or pairing code typed and not sent yet)
        const typed = [...page.querySelectorAll('input[name="address"], input[name="code"]')].some((input) => input.value);
        if (document.hidden || typed || document.activeElement?.matches?.('input, select, textarea')) setTimeout(follow, every);
        else render();
      };
      setTimeout(follow, every);
    }
    // one node change at a time: a second click while one saves would work
    // from the list as it was before the first
    const once = (fn) => async (...args) => {
      if (nodeSaving) return;
      nodeSaving = true;
      try { await fn(...args); } finally { nodeSaving = false; }
    };
    page.querySelectorAll('[data-node-trust]').forEach((box) => {
      box.addEventListener('change', once(async () => {
        const on = box.checked;
        if (on && !confirm('Trust this node? Its encodes will replace your originals without the picture check. Only for a computer of your own that nobody else can change.')) {
          box.checked = false;
          return;
        }
        try {
          await api(`/api/nodes/${encodeURIComponent(box.dataset.nodeTrust)}`, { method: 'PUT', body: { trusted: on } });
          toast(on ? 'Trusted: its encodes skip the picture check.' : 'Not trusted: its encodes get the picture check.');
        } catch (err) {
          toast(err.message, true);
        }
        render();
      }));
    });
    const saveCars = once(async (id, list) => {
      await api(`/api/nodes/${encodeURIComponent(id)}`, { method: 'PUT', body: { cars: list } }).catch((err) => toast(err.message, true));
      render();
    });
    const carsOf = (id) => [...(nodes.find((x) => x.id === id)?.cars || [])];
    page.querySelectorAll('[data-car-add]').forEach((sel) => {
      sel.onchange = () => { if (sel.value) saveCars(sel.dataset.carAdd, [...carsOf(sel.dataset.carAdd), sel.value]); };
    });
    page.querySelectorAll('[data-car-remove]').forEach((b) => {
      b.onclick = () => saveCars(b.dataset.carRemove, carsOf(b.dataset.carRemove).filter((id) => id !== b.dataset.car));
    });
    page.querySelectorAll('[data-car-up]').forEach((b) => {
      b.onclick = () => {
        const list = carsOf(b.dataset.carUp);
        const i = list.indexOf(b.dataset.car);
        if (i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
        saveCars(b.dataset.carUp, list);
      };
    });
    page.querySelectorAll('[data-rename-node]').forEach((b) => {
      b.onclick = once(async () => {
        const n = nodes.find((x) => x.id === b.dataset.renameNode);
        const asked = confirmDialog({ title: 'Rename node', ok: 'Save',
          body: `<label class="field">Name<input class="input" id="node-new-name" maxlength="64" autocomplete="off" value="${esc(n?.name || '')}"></label><p class="muted small">Shown here and under Encoder → Parallel conversions. The node itself keeps its own name.</p>` });
        const input = $('node-new-name');
        input.select();
        // Enter saves (the dialog's first button is Cancel)
        input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('dialog').close('ok'); } };
        const ok = await asked;
        const name = input.value.trim();
        if (!ok || !name || name === n?.name) return;
        await api(`/api/nodes/${encodeURIComponent(b.dataset.renameNode)}`, { method: 'PUT', body: { name } }).catch((err) => toast(err.message, true));
        render();
      });
    });
    page.querySelectorAll('[data-remove-node]').forEach((b) => {
      b.onclick = once(async () => {
        const n = nodes.find((x) => x.id === b.dataset.removeNode);
        if (!(await confirmDialog({ title: 'Remove this node?', body: `<p><b>${esc(n?.name || '')}</b> gets no more clips from this server. To use it again, pair it again with a new code.</p>`, ok: 'Remove' }))) return;
        await api(`/api/nodes/${encodeURIComponent(b.dataset.removeNode)}`, { method: 'DELETE' }).catch((err) => toast(err.message, true));
        render();
      });
    });
    if (!worker.available) return;
    const saveWorker = async () => {
      try {
        await api('/api/nodes/worker', { body: { enabled: $('worker-on').checked, slots: Number($('worker-slots').value), use: $('worker-use').value } });
      } catch (err) { toast(err.message, true); }
      render();
    };
    $('worker-on').onchange = saveWorker;
    $('worker-slots').onchange = saveWorker;
    $('worker-use').onchange = saveWorker;
    if ($('pair-start')) $('pair-start').onclick = async () => {
      try { await api('/api/nodes/worker/pair', { body: {} }); } catch (err) { toast(err.message, true); }
      render();
    };
    if ($('pair-cancel')) $('pair-cancel').onclick = async () => {
      await api('/api/nodes/worker/pair', { method: 'DELETE' }).catch(() => {});
      render();
    };
    page.querySelectorAll('[data-revoke-main]').forEach((b) => {
      b.onclick = async () => {
        const m = worker.mains.find((x) => x.id === b.dataset.revokeMain);
        if (!(await confirmDialog({ title: 'Revoke this main server?', body: `<p><b>${esc(m?.name || '')}</b> can no longer send clips here. Clips it is converting now stop.</p>`, ok: 'Revoke', danger: true }))) return;
        await api(`/api/nodes/worker/mains/${encodeURIComponent(b.dataset.revokeMain)}`, { method: 'DELETE' }).catch((err) => toast(err.message, true));
        render();
      };
    });
  };

  pages.notifications = async () => {
    const { notifications } = await api('/api/notifications');
    page.innerHTML = head('Your archive workspace', 'Notifications') + `<div class="card">
      ${notifications.length ? `<ul class="alerts" style="margin:0">${notifications.map((n) => `<li class="alert-item" style="${n.resolvedAt ? 'opacity:.6' : ''}"><span class="dot ${n.resolvedAt ? '' : n.level === 'critical' ? 'bad' : n.level === 'info' ? 'ok' : 'warn'}"></span>
        <div><b>${esc(n.title)}</b><span>${esc(n.message || '')}</span><br><span class="muted small">${when(n.createdAt)}${n.resolvedAt ? ` · resolved ${when(n.resolvedAt)}` : ''}</span></div>
        ${n.resolvedAt ? '<span></span>' : `<button class="btn sm" data-dismiss="${n.id}">Dismiss</button>`}</li>`).join('')}</ul>` : '<p>No notifications.</p>'}</div>`;
    page.querySelectorAll('[data-dismiss]').forEach((b) => {
      b.onclick = async () => {
        await api(`/api/notifications/${b.dataset.dismiss}/dismiss`, { body: {} }).catch(() => {});
        await loadNotes();
        render();
      };
    });
  };

  pages.settings = async (sub) => {
    const seq = renderSeq;
    const editing = sub?.startsWith('vehicle/') ? sub.slice(8) : sub === 'vehicle-new' ? 'new' : null;
    const [settings, upd, sys, sec, ui] = await Promise.all([api('/api/settings'), api('/api/updates'), api('/api/system').catch(() => null), api('/api/security').catch(() => null), api('/api/ui-packs').catch(() => null)]);
    if (seq !== renderSeq) return; // the user moved on while this loaded
    state.system = sys || state.system;
    state.power = settings.power || state.power || null;
    // (the Logs are on the Overview)
    const sections = [['vehicles', 'Vehicles'], ['updates', 'Updates'], ['account', 'Account'], ui && ['interface', 'Interface'], sec && ['security', 'Security'], (sys || settings.power) && ['system', 'System']].filter(Boolean);
    const show = editing || !sections.some(([k]) => k === sub) ? 'vehicles' : sub;
    let html = head('Your archive workspace', 'Settings');
    html += `<nav class="set-tabs" aria-label="Settings sections">${sections.map(([k, label]) => `<button type="button" data-tab="${k}">${label}</button>`).join('')}</nav>`;
    html += `<div class="card" data-section="vehicles"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><h2>Vehicles</h2><a class="btn" href="#/settings/vehicle-new">${icon('plus')} Add vehicle</a></div>
      ${state.vehicles.length ? `<table class="table" style="margin-top:14px"><thead><tr><th>Name</th><th>Footage</th><th>Status</th><th></th></tr></thead><tbody>
      ${state.vehicles.map((v) => `<tr><td class="words"><b>${esc(v.name)}</b><br><span class="muted small">${esc(v.timezone)}</span></td>
        <td class="small"><span class="mono">${esc(v.source.type === 'smb' ? v.source.share : v.source.path)}</span>${v.security ? `<br><span class="muted">${esc(v.security)}</span>` : ''}</td>
        <td class="small words">${v.share?.healthy ? (v.share.writable === false ? 'Read-only' : 'Connected') : esc(v.share?.lastError || 'Unavailable')}</td>
        <td class="actions"><a class="btn sm" href="#/settings/vehicle/${esc(v.id)}">Edit</a></td></tr>`).join('')}</tbody></table>` : '<p style="margin-top:12px">No vehicles yet.</p>'}
      ${editing ? vehicleForm(editing === 'new' ? null : state.vehicles.find((v) => v.id === editing)) : ''}</div>`;

    html += updatesCard(upd);

    html += `<div class="card" data-section="account"><h2>Account</h2><form id="pw" class="form" style="margin-top:16px">
        <label class="field">Current password<input class="input" type="password" name="current" autocomplete="current-password" required></label>
        <label class="field">New password<input class="input" type="password" name="next" autocomplete="new-password" minlength="8" required></label>
        <div class="full form-actions" style="margin-top:0"><button class="btn solid" type="submit">Change password</button></div></form></div>`;

    if (ui) html += interfaceCard(ui);
    if (sec) html += securityCard(sec);

    if (sys) {
      const caps = sys.converter.capabilities || {};
      html += `<div class="card" data-section="system"><h2>System</h2><dl class="kv" style="margin-top:16px">
        <dt>Converter</dt><dd>${sys.converter.ready ? `ready · replace originals ${esc(caps.replacement)} · cleanup ${esc(caps.ownershipCleanup)}` : `not ready (${esc(sys.converter.error || 'starting')})`}</dd>
        <dt>Safe rename helper</dt><dd>${sys.nativeHelper ? 'installed' : 'missing (link + unlink fallback)'}</dd>
        <dt>GPUs</dt><dd>${sys.gpu.gpus.length || sys.gpu.nvidia.length ? [...sys.gpu.nvidia.map((g) => `${/^nvidia\b/i.test(g.name || '') ? '' : 'NVIDIA '}${esc(g.name)} (driver ${esc(g.driver)})`), ...sys.gpu.gpus.filter((g) => g.vendor !== 'nvidia').map((g) => (g.virtual ? `${esc(g.name)} · ${esc(g.node)} · not a GPU, not used for encoding` : `${esc(g.name || g.vendorName)} · ${esc(g.node)}${g.passedThrough ? (g.encodes ? ` · encodes ${Object.entries(g.encodes).filter(([, x]) => x).map(([k]) => k.toUpperCase()).join(', ') || 'nothing'}` : '') : ' · not passed into the container'}`))].join('<br>') : 'none visible (the CPU encoders are used)'}</dd>
        ${sys.gpu.hints.length ? `<dt>GPU hints</dt><dd>${sys.gpu.hints.map(esc).join('<br>')}</dd>` : ''}
        <dt>Data volume free</dt><dd>${bytes(sys.dataFree)}</dd>
        <dt>Server time zone</dt><dd>${esc(sys.timezone)}</dd></dl></div>`;
    }
    if (settings.power) html += powerCard(settings.power, sys?.timezone);
    page.innerHTML = html;
    wireSettingsTabs(show, editing ? `#/settings/${sub}` : '#/settings', seq);
    wireSettings(editing);
    if (ui) wireInterface(ui);
    if (sec) wireSecurity(sec);
    if (settings.power) wirePower(settings.power);
  };

  pages.support = async () => {
    // Easter egg: the Sentry Six team, Seal Team 6 style. Six taps and it answers.
    const insignia = `<button type="button" class="st6" id="st6" title="Sentry Team 6" aria-label="Sentry Team 6">
      <svg class="i" aria-hidden="true"><use href="#i-shield"/></svg><span>Sentry Team 6</span></button>`;
    page.innerHTML = head('', 'Support') + insignia + supportCard();
    let taps = 0;
    $('st6').onclick = () => {
      if (++taps % 6) return;
      $('st6').classList.add('hooyah');
      setTimeout(() => $('st6')?.classList.remove('hooyah'), 1200);
      toast('Hooyah. Sentry Team 6 is on station. Brief us below.');
    };
    wireSupport(renderSeq);
  };

  // Support: chat with Sentry Six support, a tab of its own. This server relays it
  // to the support server (server/support.js); the ticket stays on the server,
  // so every signed-in browser sees the same conversation.
  const SUPPORT_MAX_FILE = 50 * 1024 * 1024;

  function supportCard() {
    return `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><h2>Chat with the Sentry Six team</h2>
        <button class="btn sm" type="button" id="sup-close" hidden>Close ticket</button></div>
      <p>Ask the Sentry Six team for help. Messages go to the Sentry Six support server (api.sentry-six.com) and replies show up here.</p>
      <div class="sup-log" id="sup-log" aria-live="polite"><p class="muted small" id="sup-empty">No open ticket. Your first message opens one.</p></div>
      <form id="sup-form" class="sup-form">
        <textarea class="input" id="sup-text" rows="3" maxlength="4000" placeholder="Describe the problem: what you did, what you expected, what happened"></textarea>
        <div class="sup-row">
          <label class="sup-check"><input type="checkbox" id="sup-diag"> Include diagnostics <span class="muted small">(version, OS, CPU/GPU, recent warnings; addresses and footage paths removed)</span></label>
          <label class="btn sm" for="sup-file">${icon('plus')} Attach</label><input type="file" id="sup-file" hidden accept="image/*,video/*,.log,.txt,.json">
          <span class="muted small" id="sup-file-name"></span>
          <button class="btn solid" type="submit" id="sup-send">Send</button>
        </div>
        <p class="muted small" id="sup-status" role="status"></p>
      </form></div>`;
  }

  function supportMessage(m) {
    const user = m.sender === 'user';
    const when = m.timestamp ? new Date(m.timestamp) : null;
    const time = when && !Number.isNaN(when.getTime()) ? when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const files = (m.attachments || []).map((a) => {
      if (!a.url) return `<span class="sup-file">${esc(a.name)}</span>`;
      if (a.type.startsWith('image/')) return `<a href="${esc(a.url)}" data-lightbox><img class="sup-img" src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy"></a>`;
      if (a.type.startsWith('video/')) return `<video class="sup-img" src="${esc(a.url)}" controls preload="metadata"></video>`;
      return `<a class="sup-file" href="${esc(a.url)}" download>${esc(a.name)}</a>`;
    }).join('');
    return `<div class="sup-msg ${user ? 'me' : 'them'}"${m.id ? ` data-id="${esc(m.id)}"` : ''}>
      <div class="sup-who">${user ? 'You' : esc(m.responder || 'Sentry Six support')}${time ? ` · <span class="muted">${esc(time)}</span>` : ''}</div>
      ${m.content ? `<div class="sup-text">${esc(m.content)}</div>` : ''}${files ? `<div class="sup-files">${files}</div>` : ''}
      ${m.hasDiagnostics ? '<div class="muted small">Diagnostics attached</div>' : ''}</div>`;
  }

  // A picture in the chat opens over the page; a click, Esc or Close shuts it.
  function openLightbox(src, name) {
    const box = $('lightbox');
    $('lightbox-img').src = src;
    $('lightbox-img').alt = name || '';
    $('lightbox-name').textContent = name || '';
    $('lightbox-save').href = src;
    if (!box.dataset.wired) {
      box.dataset.wired = '1';
      // the picture itself, or the dark area around it, closes it too
      box.addEventListener('click', (e) => {
        if (e.target === box || e.target.id === 'lightbox-img') box.close();
      });
      box.addEventListener('close', () => { $('lightbox-img').removeAttribute('src'); });
    }
    box.showModal();
  }

  function wireSupport(seq) {
    const form = $('sup-form');
    if (!form) return;
    const log = $('sup-log');
    log.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-lightbox]');
      if (!link) return;
      e.preventDefault();
      const img = link.querySelector('img');
      openLightbox(link.getAttribute('href'), img?.alt);
    });
    const text = $('sup-text');
    const fileInput = $('sup-file');
    const status = (msg, bad = false) => {
      $('sup-status').textContent = msg || '';
      $('sup-status').classList.toggle('bad', bad);
    };
    let open = false;
    let since = null;
    let timer = null;
    let busy = false;
    const alive = () => seq === renderSeq && document.body.contains(form);
    const setOpen = (v) => {
      open = v;
      $('sup-close').hidden = !v;
      $('sup-empty').hidden = v || log.querySelector('.sup-msg') !== null;
    };
    const visible = () => !document.hidden && form.closest('.card').offsetParent !== null;

    async function poll() {
      clearTimeout(timer);
      if (!alive()) return;
      if (open && visible() && !busy) {
        busy = true;
        try {
          const out = await api(`/api/support/messages${since ? `?since=${encodeURIComponent(since)}` : ''}`, { timeoutMs: 20000 });
          if (!alive()) return;
          let fresh = false;
          for (const m of out.messages || []) {
            if (m.id && log.querySelector(`[data-id="${CSS.escape(m.id)}"]`)) continue;
            log.insertAdjacentHTML('beforeend', supportMessage(m));
            if (m.id) since = m.id;
            if (m.sender !== 'user' && !m.read) fresh = true;
          }
          if ((out.messages || []).length) log.scrollTop = log.scrollHeight;
          if (fresh) api('/api/support/read', { method: 'POST' }).catch(() => {});
          if (out.closed) {
            setOpen(false);
            status('Support closed this ticket. A new message opens a new one.');
          } else if (!out.open) setOpen(false);
        } catch (err) {
          status(err.message, true);
        } finally {
          busy = false;
        }
      }
      timer = setTimeout(poll, 5000);
    }

    fileInput.onchange = () => {
      const f = fileInput.files[0];
      if (f && f.size > SUPPORT_MAX_FILE) {
        fileInput.value = '';
        status(`That file is ${bytes(f.size)}; the limit is ${bytes(SUPPORT_MAX_FILE)}.`, true);
      }
      $('sup-file-name').textContent = fileInput.files[0] ? fileInput.files[0].name : '';
    };

    form.onsubmit = async (e) => {
      e.preventDefault();
      const message = text.value.trim();
      const file = fileInput.files[0] || null;
      if (!message && !file) return status('Write a message or attach a file first.', true);
      const btn = $('sup-send');
      btn.disabled = true;
      status(file ? 'Uploading…' : 'Sending…');
      try {
        const includeDiagnostics = $('sup-diag').checked;
        if (file) {
          const res = await fetch('/api/support/media', {
            method: 'POST', credentials: 'same-origin', body: file,
            headers: {
              'X-Requested-With': 'sentry-six-manager', 'Content-Type': file.type || 'application/octet-stream',
              'X-File-Name': encodeURIComponent(file.name), 'X-Message': encodeURIComponent(message), 'X-Diagnostics': includeDiagnostics ? '1' : '0'
            }
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `Upload failed (${res.status}).`);
        } else {
          await api('/api/support/message', { body: { message, includeDiagnostics } });
        }
        if (!alive()) return;
        text.value = '';
        fileInput.value = '';
        $('sup-file-name').textContent = '';
        $('sup-diag').checked = false;
        status('Sent.');
        setOpen(true);
        poll();
      } catch (err) {
        status(err.message, true);
      } finally {
        btn.disabled = false;
      }
    };

    $('sup-close').onclick = async () => {
      if (!confirm('Close this support ticket? You can start a new one any time.')) return;
      try {
        await api('/api/support/close', { method: 'POST' });
        if (!alive()) return;
        setOpen(false);
        since = null;
        log.querySelectorAll('.sup-msg').forEach((n) => n.remove());
        $('sup-empty').hidden = false;
        status('Ticket closed.');
      } catch (err) {
        status(err.message, true);
      }
    };

    api('/api/support').then((st) => {
      if (!alive()) return;
      setOpen(Boolean(st.open));
      poll();
    }).catch((err) => status(err.message, true));
  }

  // Settings > System: the electricity price behind every cost shown with
  // energy. One price, or a time-of-use plan (peak, off-peak, weekends): the
  // server sums costs at the price of each moment, and the first rate whose
  // days and hours match wins.
  const WEEK = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
  const MAX_RATES = 12;
  const priceValue = (n) => (fin(n) ? String(n) : '');

  function rateRow(r = {}) {
    const days = new Set(Array.isArray(r.days) ? r.days : [0, 1, 2, 3, 4, 5, 6]);
    return `<div class="rate" data-rate>
      <label class="field">Name<input class="input" data-k="label" maxlength="24" value="${esc(r.label || '')}" placeholder="Off-peak"></label>
      <label class="field">Price per kWh<input class="input" data-k="price" inputmode="decimal" value="${esc(priceValue(r.price))}" placeholder="0.12"></label>
      <label class="field">From<input class="input" type="time" step="60" data-k="from" value="${esc(r.from || '23:00')}"></label>
      <label class="field">To<input class="input" type="time" step="60" data-k="to" value="${esc(r.to || '07:00')}"></label>
      <div class="field rate-days">Days<div class="days-pick">${WEEK.map(([d, name]) => `<label><input type="checkbox" value="${d}"${days.has(d) ? ' checked' : ''}><span>${name}</span></label>`).join('')}</div></div>
      <button type="button" class="btn sm ghost rate-del" data-rate-del aria-label="Remove this rate">Remove</button>
    </div>`;
  }

  function powerCard(p, timezone) {
    const tou = p.mode === 'tou';
    return `<div class="card" data-section="system"><h2>Electricity price</h2>
      <p>For the cost next to energy on the Overview, the Encoder and Jobs. Leave it empty to show energy only.</p>
      <form id="power-form" class="form" style="margin-top:18px" novalidate>
        <div class="field full">Plan<div class="seg" id="power-mode" role="group" aria-label="Plan">
          <button type="button" data-mode="flat" class="${tou ? '' : 'on'}" aria-pressed="${!tou}">One price</button><button type="button" data-mode="tou" class="${tou ? 'on' : ''}" aria-pressed="${tou}">Time of use</button></div></div>
        <label class="field">Currency<input class="input" name="currency" maxlength="3" value="${esc(p.currency || '$')}" placeholder="$"></label>
        <label class="field" data-plan="flat"${tou ? ' hidden' : ''}>Price per kWh<input class="input" name="pricePerKwh" inputmode="decimal" value="${esc(priceValue(p.pricePerKwh))}" placeholder="0.15"></label>
        <label class="field" data-plan="tou"${tou ? '' : ' hidden'}>Other hours (per kWh)<input class="input" name="defaultPrice" inputmode="decimal" value="${esc(priceValue(p.defaultPrice))}" placeholder="0.25"></label>
        <div class="full" data-plan="tou"${tou ? '' : ' hidden'}>
          <p class="muted small">Rates in order: the first one whose days and hours match is used, otherwise the price for other hours. A rate from 23:00 to 07:00 runs over midnight and belongs to the day it starts. Times are the server's${timezone ? ` (${esc(timezone)})` : ''}.</p>
          <div class="rates" id="power-rates">${(p.rates || []).map(rateRow).join('')}</div>
          <button type="button" class="btn sm" id="power-add"${(p.rates || []).length >= MAX_RATES ? ' disabled' : ''}>${icon('plus')} Add a rate</button>
        </div>
        <div class="full form-actions" style="margin-top:0"><button class="btn solid" type="submit">Save price</button></div>
      </form></div>`;
  }

  function wirePower(saved) {
    const form = $('power-form');
    if (!form) return;
    let mode = saved.mode === 'tou' ? 'tou' : 'flat';
    const list = $('power-rates');
    const add = $('power-add');
    const count = () => list.querySelectorAll('[data-rate]').length;
    form.querySelectorAll('#power-mode button').forEach((b) => {
      b.onclick = () => {
        mode = b.dataset.mode;
        form.querySelectorAll('#power-mode button').forEach((x) => {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-pressed', String(x === b));
        });
        form.querySelectorAll('[data-plan]').forEach((x) => { x.hidden = x.dataset.plan !== mode; });
        if (mode === 'tou' && !count()) list.insertAdjacentHTML('beforeend', rateRow({ label: 'Off-peak' }));
        add.disabled = count() >= MAX_RATES;
      };
    });
    add.onclick = () => {
      if (count() >= MAX_RATES) return;
      list.insertAdjacentHTML('beforeend', rateRow(count() ? { label: 'Peak', from: '16:00', to: '21:00', days: [1, 2, 3, 4, 5] } : { label: 'Off-peak' }));
      add.disabled = count() >= MAX_RATES;
      list.lastElementChild.querySelector('input')?.focus();
    };
    list.onclick = (e) => {
      const del = e.target.closest('[data-rate-del]');
      if (!del) return;
      del.closest('[data-rate]').remove();
      add.disabled = count() >= MAX_RATES;
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const num = (v) => (String(v ?? '').trim() === '' ? null : Number(String(v).replace(',', '.')));
      const rates = [...list.querySelectorAll('[data-rate]')].map((row) => {
        const v = (k) => row.querySelector(`[data-k="${k}"]`).value;
        return { label: v('label').trim(), price: num(v('price')), from: v('from'), to: v('to'), days: [...row.querySelectorAll('.days-pick input:checked')].map((x) => Number(x.value)) };
      });
      const prices = mode === 'tou' ? [num(fd.get('defaultPrice')), ...rates.map((r) => r.price)] : [num(fd.get('pricePerKwh'))];
      if (prices.some(Number.isNaN)) return toast('Enter prices as numbers, like 0.15.', true);
      const body = {
        currency: String(fd.get('currency') || '').trim() || '$', mode,
        pricePerKwh: num(fd.get('pricePerKwh')), defaultPrice: num(fd.get('defaultPrice')),
        // one price keeps the saved plan for later; a plan sends what is on screen
        rates: mode === 'tou' ? rates : (saved.rates || [])
      };
      try {
        const next = await api('/api/settings/power', { method: 'PUT', body });
        state.power = next;
        Object.assign(saved, next);
        toast(mode === 'tou' ? 'Saved. Costs follow the plan from now on.' : body.pricePerKwh === null ? 'Saved. Energy is shown without a cost.' : 'Saved. Costs use this price from now on.');
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  // Phones show one Settings section at a time, picked from the tabs (wider
  // screens hide the tabs and show every section). Switching keeps what was
  // typed and only rewrites the address, so a reload opens the same section.
  // Taps on a page that is being replaced are ignored.
  function wireSettingsTabs(show, vehiclesHash, seq) {
    const pick = (key) => {
      page.querySelectorAll('[data-tab]').forEach((b) => {
        b.classList.toggle('on', b.dataset.tab === key);
        if (b.dataset.tab === key) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      });
      page.querySelectorAll('[data-section]').forEach((c) => c.classList.toggle('on', c.dataset.section === key));
    };
    page.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => {
        if (seq !== renderSeq) return;
        pick(b.dataset.tab);
        history.replaceState(null, '', b.dataset.tab === 'vehicles' ? vehiclesHash : `#/settings/${b.dataset.tab}`);
      };
    });
    pick(show);
  }

  function updatesCard(u) {
    const cur = u.current || {};
    const running = `${cur.sha ? `${esc(cur.sha.slice(0, 7))}${u.tag ? ` (${esc(u.tag)})` : ''}` : 'built from source'}${cur.builtAt ? ` · built ${esc(String(cur.builtAt).slice(0, 10))}` : ''}`;
    const how = '<code>docker compose pull &amp;&amp; docker compose up -d</code>';
    if (!u.enabled) {
      return `<div class="card" data-section="updates"><h2>Updates</h2>
        <p>${u.image ? `Checking for updates is turned off (UPDATE_CHECK=off). To update, run ${how} where you set up Sentry Six Manager.` : 'This copy was built from source. To update it, build the image again from the new code.'}</p>
        <dl class="kv" style="margin-top:16px"><dt>Running</dt><dd class="mono">${running}</dd></dl></div>`;
    }
    const l = u.latest;
    const latest = l ? `${l.revision ? `${esc(l.revision.slice(0, 7))} · ` : ''}published ${esc(String(l.created || '').slice(0, 10) || '?')}` : u.error ? esc(u.error) : 'not checked yet';
    return `<div class="card" data-section="updates"><h2>Updates</h2>
      <p>Updates come as a new image. To install one, run ${how} where you set up Sentry Six Manager. Settings, footage and the Recycle Bin stay as they are.</p>
      <dl class="kv" style="margin-top:16px"><dt>Running</dt><dd class="mono">${running}</dd>
        <dt>Newest</dt><dd${l ? ' class="mono"' : ''}>${latest}${u.checkedAt ? ` <span class="muted">(checked ${when(u.checkedAt)})</span>` : ''}</dd></dl>
      ${u.updateAvailable ? '<div class="note green">An update is available.</div>' : ''}
      <div class="form-actions"><button class="btn" id="upd-check" type="button">Check now</button></div></div>`;
  }

  // Settings > Interface: the built-in interface or a pack of the owner's own
  // (server/uiPacks.js), for everyone, switched without a restart.
  function interfaceCard(ui) {
    const day = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');
    return `<div class="card" data-section="interface"><h2>Interface</h2>
      <p class="muted small" style="margin-top:6px">How Sentry Six Manager looks and works for everyone who signs in. <b>Original</b> is the built-in interface; Daylight, Flux, Horizon and Aurora come with the app, and you can upload packs of your own.</p>
      ${ui.original ? `<div class="ui-original-note"><p>This browser shows the <b>original</b> interface, as you opened <span class="mono">/original</span>${ui.active ? `; everyone else sees <b>${esc(ui.packs.find((x) => x.id === ui.active)?.name || '')}</b>` : ''}.</p><a class="btn sm" href="/original?off=1">Show the chosen interface</a></div>` : ''}
      <div class="form" style="margin-top:14px"><label class="field">Interface<select class="input" id="ui-pick">
        <option value=""${ui.active ? '' : ' selected'}>Original</option>
        ${ui.packs.map((x) => `<option value="${esc(x.id)}"${x.id === ui.active ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select></label></div>
      ${ui.packs.length ? `<table class="table ui-packs" style="margin-top:14px"><thead><tr><th>Pack</th><th>Changes</th><th>Added</th><th></th></tr></thead><tbody>
        ${ui.packs.map((x) => `<tr><td class="words"><b>${esc(x.name)}</b>${x.id === ui.active ? ' <span class="chip green">In use</span>' : ''}${x.description ? `<br><span class="muted small">${esc(x.description)}</span>` : ''}${x.author ? `<br><span class="muted small">by ${esc(x.author)}</span>` : ''}</td>
          <td class="small">${x.replaces.map((k) => (k === 'web' ? 'Pages' : 'Viewer and Encoder')).join(', ')} · ${x.files} file${x.files === 1 ? '' : 's'}</td>
          <td class="small">${x.builtin ? 'Built in' : esc(day(x.uploadedAt))}</td>
          <td class="actions">${x.builtin ? '' : `<button class="btn sm danger" type="button" data-ui-del="${esc(x.id)}">Delete</button>`}</td></tr>`).join('')}</tbody></table>` : ''}
      <div class="form-actions" style="justify-content:flex-start;flex-wrap:wrap">
        <input type="file" id="ui-file" accept=".zip,application/zip" hidden>
        <button class="btn solid" type="button" id="ui-upload">${icon('plus')} Upload a pack (.zip)</button>
        <a class="btn" href="/api/ui-packs/original.zip" download>Download the original to start from</a>
      </div>
      <p class="muted small" style="margin-top:12px">A pack replaces the built-in files with the same path, so it can change one stylesheet or the whole interface; the download explains the layout. <b>A pack's scripts run as whoever is signed in and can do anything you can</b>: only upload packs you made or trust. Uploading or choosing one asks for your password.</p>
      <p class="muted small" style="margin-top:8px">If a pack breaks the pages, open <a class="mono" href="/original">${esc(location.origin)}/original</a>: that browser then shows the original interface, and you can switch back here.</p>
    </div>`;
  }

  function wireInterface(ui) {
    const pick = $('ui-pick');
    const use = async (id) => {
      await api('/api/ui-packs/active', { method: 'PUT', body: { id } });
      // the pages of the new interface, without a restart
      location.reload();
    };
    pick.onchange = async () => {
      try {
        await use(pick.value || null);
      } catch (err) {
        pick.value = ui.active || '';
        toast(err.message, true);
      }
    };
    page.querySelectorAll('[data-ui-del]').forEach((b) => {
      b.onclick = async () => {
        const x = ui.packs.find((y) => y.id === b.dataset.uiDel);
        if (!(await confirmDialog({ title: 'Delete this interface?', body: `<p><b>${esc(x?.name || '')}</b> is deleted from the server.${x?.id === ui.active ? ' Everyone gets the original interface.' : ''}</p>`, ok: 'Delete', danger: true }))) return;
        try {
          await api(`/api/ui-packs/${encodeURIComponent(b.dataset.uiDel)}`, { method: 'DELETE' });
          if (x?.id === ui.active) location.reload();
          else render();
        } catch (err) { toast(err.message, true); }
      };
    });
    const file = $('ui-file');
    $('ui-upload').onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      const btn = $('ui-upload');
      btn.disabled = true;
      try {
        const send = () => fetch('/api/ui-packs/upload', {
          method: 'POST', credentials: 'same-origin', body: f,
          headers: { 'X-Requested-With': 'sentry-six-manager', 'Content-Type': 'application/zip', 'X-File-Name': encodeURIComponent(f.name) }
        });
        let res = await send();
        let data = await res.json().catch(() => ({}));
        if (res.status === 403 && data.code === 'CONFIRM_PASSWORD') {
          await confirmPassword();
          res = await send();
          data = await res.json().catch(() => ({}));
        }
        if (!res.ok) throw new Error(data.error || `Upload failed (${res.status}).`);
        if (await confirmDialog({ title: 'Use it now?', body: `<p><b>${esc(data.pack.name)}</b> is installed. Use it for everyone now? You can switch back to Original here at any time.</p>`, ok: 'Use it' })) await use(data.pack.id);
        else render();
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    };
  }

  function securityCard(sec) {
    const tls = sec.tls || {};
    const ca = tls.ca;
    const host = (sec.currentHost || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const covered = !host || (tls.hostnames || []).map((h) => h.toLowerCase()).includes(host.toLowerCase());
    let body = `<dl class="kv" style="margin-top:16px">
      <dt>This connection</dt><dd>${sec.https ? 'HTTPS (encrypted)' : '<b class="bad-text">not encrypted</b>: others on the network could read your password and the footage. Use https:// or a reverse proxy that does HTTPS.'}</dd>
      <dt>Server process</dt><dd>${sec.runningAsRoot ? 'runs as root (not supervised; fine for development, not for the Docker image)' : 'runs as an unprivileged user; only the supervisor can mount shares'}</dd>`;
    if (sec.tlsMode === 'off') {
      body += '<dt>HTTPS</dt><dd>turned off (TLS_MODE=off): only use this behind a reverse proxy that does HTTPS.</dd></dl>';
    } else if (tls.mode === 'own') {
      body += `<dt>Certificate</dt><dd>your own (TLS_CERT_FILE) · ${esc((tls.certificate?.names || []).join(', '))} · valid until ${esc(tls.certificate?.validTo || '?')}</dd>
        <dt>Fingerprint</dt><dd class="mono small">${esc(tls.certificate?.fingerprint || '?')}</dd></dl>`;
    } else if (tls.error) {
      body += `<dt>Certificate</dt><dd>${esc(tls.error)}</dd></dl>`;
    } else {
      body += `<dt>Certificate fingerprint (SHA-256)</dt><dd class="mono small">${esc(tls.certificate?.fingerprint || '?').replace(/:/g, ':<wbr>')}</dd>
        <dt>Certificate</dt><dd>Sentry Six Manager's own · stays the same until ${esc(tls.certificate?.validTo || '?')}, then renews by itself</dd>
        <dt>Certificate covers</dt><dd>${esc((tls.hostnames || []).join(', '))}</dd>
        <dt>Certificate authority</dt><dd>valid until ${esc(ca?.validTo || '?')} · fingerprint <span class="mono small">${esc(ca?.fingerprint || '?').replace(/:/g, ':<wbr>')}</span></dd></dl>
        <p style="margin-top:14px">Every phone, tablet and computer shows the browser's certificate warning once; continue past it (Advanced, then Proceed / visit this website / Accept the Risk) and the device remembers. To be sure it is this server, compare the certificate fingerprint above with the one in the browser's certificate details or the container log (<code>docker logs sentry-six-manager</code>). If a device that continued before warns again and you changed nothing here, don't continue.</p>
        <p style="margin-top:10px">No warning at all: install the certificate authority on a device instead (download it below and compare its fingerprint before trusting it). It can only vouch for local names and private IP addresses.</p>
        ${covered ? '' : `<div class="note amber">You opened this page as <b>${esc(host)}</b>, which the certificate does not cover, so it warns even on devices with the certificate authority installed. <button class="btn sm" type="button" id="sec-add-host" data-host="${esc(host)}">Add ${esc(host)}</button></div>`}
        <details class="more" style="margin-top:10px"><summary>How to install the certificate authority</summary>
          <ul class="small" style="margin:10px 0 0 18px;display:grid;gap:6px">
            <li><b>iPhone / iPad:</b> open the download in Safari, then Settings &gt; General &gt; VPN &amp; Device Management to install it, and Settings &gt; General &gt; About &gt; Certificate Trust Settings to turn on full trust.</li>
            <li><b>Android:</b> Settings &gt; Security &gt; Encryption &amp; credentials &gt; Install a certificate &gt; CA certificate.</li>
            <li><b>Windows:</b> open the file &gt; Install Certificate &gt; Local Machine &gt; Trusted Root Certification Authorities.</li>
            <li><b>macOS:</b> open it in Keychain Access (System), then set Trust to Always Trust.</li>
            <li><b>Firefox:</b> Settings &gt; Privacy &amp; Security &gt; Certificates &gt; View Certificates &gt; Authorities &gt; Import.</li>
          </ul></details>
        <form id="sec-hosts" class="form" style="margin-top:16px">
          <label class="field full">Extra names and addresses for the certificate<input class="input" name="hostnames" value="${esc((tls.editable || []).join(', '))}" placeholder="192.168.1.20, nas.local"></label>
          <p class="muted small full">The IP addresses or names you type in the browser to reach this server; only devices with the certificate authority installed need them. Saving makes a new certificate, so devices that continued past the warning see it once more. Names from TLS_HOSTNAMES: ${esc((tls.fromEnv || []).join(', ') || 'none')}.</p>
          <div class="full form-actions" style="margin-top:0"><a class="btn" href="/api/security/ca.crt" download>Download certificate authority</a><button class="btn solid" type="submit">Save names</button></div>
        </form>`;
    }
    return `<div class="card" data-section="security"><h2>Security</h2>${body}</div>`;
  }

  function wireSecurity(sec) {
    const save = async (names) => {
      const ok = await confirmDialog({
        title: 'Make a new certificate?',
        body: '<p>The certificate will cover the new names. Every phone, tablet and computer that continued past the browser\'s warning before will see it once more; devices with the certificate authority installed won\'t.</p>',
        ok: 'Save names'
      });
      if (!ok) return;
      try {
        const out = await api('/api/security/hostnames', { method: 'PUT', body: { hostnames: names } });
        toast(`${out.caReplaced ? 'Saved. The certificate authority was replaced: install the new one on your devices.' : 'Saved. The certificate now covers those names.'} Reloading the page for the new certificate…`);
        // the browser has to pick up the new certificate; a page that clicked
        // past a warning would otherwise fail every request from now on
        setTimeout(() => location.reload(), 2500);
      } catch (err) {
        toast(err.message, true);
      }
    };
    const form = $('sec-hosts');
    if (form) {
      form.onsubmit = (e) => {
        e.preventDefault();
        save(String(new FormData(form).get('hostnames') || '').split(/[\s,]+/).filter(Boolean));
      };
    }
    const add = $('sec-add-host');
    if (add) add.onclick = () => save([...(sec.tls?.editable || []), add.dataset.host]);
  }

  function vehicleForm(v) {
    const versions = state.system?.smbVersions || { '3.1.1': 'SMB 3.1.1 (recommended)', '3.02': 'SMB 3.02', '3.0': 'SMB 3.0', 3: 'SMB 3.0 or newer' };
    const s = v?.source || { type: 'smb', version: state.system?.smbDefaultVersion || '3.1.1', encrypt: true };
    return `<form id="veh" class="form" style="margin-top:22px;padding-top:22px;border-top:1px solid var(--border)">
      <h3 class="full">${v ? `Edit ${esc(v.name)}` : 'Add a vehicle'}</h3>
      <label class="field">Name<input class="input" name="name" required value="${esc(v?.name || '')}" placeholder="Daily Driver"></label>
      <label class="field">Time zone<input class="input" name="timezone" value="${esc(v?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)}" placeholder="America/Chicago"></label>
      <div class="field full">Footage source<div class="seg" id="src-type"><button type="button" data-type="smb" class="${s.type !== 'path' ? 'on' : ''}">SMB share</button><button type="button" data-type="path" class="${s.type === 'path' ? 'on' : ''}">Folder in the container</button></div></div>
      <div class="full form" data-src="smb"${s.type === 'path' ? ' hidden' : ''}>
        <label class="field full">Share<input class="input" name="share" value="${esc(s.share || '')}" placeholder="//192.168.1.50/TeslaCam"></label>
        <label class="field">User name<input class="input" name="username" value="${esc(s.username || '')}" autocomplete="off"></label>
        <label class="field">Password<input class="input" name="password" type="password" placeholder="${s.passwordSet ? 'saved — leave empty to keep' : ''}" autocomplete="new-password"></label>
        <label class="field">Domain (optional)<input class="input" name="domain" value="${esc(s.domain || '')}"></label>
        <label class="field">SMB version<select class="input" name="version">${Object.entries(versions).map(([x, label]) => `<option value="${esc(x)}"${String(s.version || '3.1.1') === x ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <label class="field">Port (optional)<input class="input" name="port" inputmode="numeric" value="${esc(s.port || '')}" placeholder="445"></label>
        <label class="check full"><input type="checkbox" name="encrypt"${s.encrypt === false ? '' : ' checked'}> Encrypt the connection (recommended). Without it the connection is still signed, so nobody can change the footage, but others on the network could watch it.</label>
        <p class="muted small full">Only SMB 3 is allowed and every connection is signed, so a man in the middle cannot read or change footage, or pose as your NAS. Files on the share can never run as programs inside the container. Use a dedicated NAS account with access to this share only.</p>
      </div>
      <div class="full" data-src="path"${s.type === 'path' ? '' : ' hidden'}>
        <label class="field">Folder<input class="input" name="path" value="${esc(s.path || '')}" placeholder="/footage/weekend-car"></label>
        <p class="muted small" style="margin-top:8px">A folder you mounted into the container yourself (bind mount or Docker CIFS volume).</p>
      </div>
      <div class="full form-actions">${v ? '<button class="btn danger" type="button" id="veh-del">Remove vehicle</button>' : ''}<a class="btn" href="#/settings">Cancel</a><button class="btn solid" type="submit">${v ? 'Save' : 'Add vehicle'}</button></div>
    </form>`;
  }

  function wireSettings(editing) {
    const veh = $('veh');
    if (veh) {
      let type = veh.querySelector('#src-type .on')?.dataset.type || 'smb';
      veh.querySelectorAll('#src-type button').forEach((b) => {
        b.onclick = () => {
          type = b.dataset.type;
          veh.querySelectorAll('#src-type button').forEach((x) => x.classList.toggle('on', x === b));
          veh.querySelectorAll('[data-src]').forEach((x) => { x.hidden = x.dataset.src !== type; });
        };
      });
      veh.onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(veh);
        const body = { name: fd.get('name'), timezone: fd.get('timezone'), source: type === 'path'
          ? { type: 'path', path: fd.get('path') }
          : { type: 'smb', share: fd.get('share'), username: fd.get('username'), password: fd.get('password') || undefined, domain: fd.get('domain'), version: fd.get('version'), encrypt: fd.get('encrypt') === 'on', port: fd.get('port') || null } };
        // only send the source when it changed, so a rename needs no password
        if (editing !== 'new') {
          const was = state.vehicles.find((x) => x.id === editing)?.source || {};
          const same = type === was.type && (type === 'path'
            ? body.source.path === was.path
            : ['share', 'username', 'domain', 'version'].every((k) => String(body.source[k] ?? '') === String(was[k] ?? ''))
              && body.source.encrypt === (was.encrypt !== false) && String(body.source.port ?? '') === String(was.port ?? '') && !body.source.password);
          if (same) delete body.source;
        }
        try {
          const saved = editing === 'new' ? await api('/api/vehicles', { body }) : await api(`/api/vehicles/${encodeURIComponent(editing)}`, { method: 'PUT', body });
          state.vehicleId = saved.id;
          store.set('vehicle', saved.id);
          toast('Saved. Connecting to the footage…');
          await loadVehicles();
          location.hash = '#/settings';
        } catch (err) {
          toast(err.message, true);
        }
      };
      if ($('veh-del')) {
        $('veh-del').onclick = async () => {
          if (!(await confirmDialog({ title: 'Remove this vehicle?', body: '<p>Sentry Six Manager forgets the vehicle and unmounts its share. No footage is deleted.</p>', ok: 'Remove', danger: true }))) return;
          await api(`/api/vehicles/${encodeURIComponent(editing)}`, { method: 'DELETE' }).catch((err) => toast(err.message, true));
          await loadVehicles();
          location.hash = '#/settings';
        };
      }
    }
    const check = $('upd-check');
    if (check) {
      check.onclick = async () => {
        check.disabled = true;
        try {
          const out = await api('/api/updates/check', { body: {} });
          toast(out.error || (out.updateAvailable ? 'An update is available.' : 'This is the latest version.'), Boolean(out.error));
        } catch (err) {
          toast(err.message, true);
        }
        render();
      };
    }
    $('pw').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/auth/password', { body: { current: fd.get('current'), next: fd.get('next') } });
        toast('Password changed.');
        e.target.reset();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  // Phones show each table row as a stacked block; the cells carry their column name.
  function labelTableCells(root) {
    root.querySelectorAll('table.table').forEach((table) => {
      // its own rows only, not those of a table inside a cell (Nodes > Benchmark)
      const names = [...table.querySelectorAll(':scope > thead th')].map((th) => th.textContent.trim());
      table.querySelectorAll(':scope > tbody > tr').forEach((tr) => [...tr.children].forEach((td, i) => { if (names[i]) td.dataset.label = names[i]; }));
    });
  }

  // ---------- routing ----------
  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    held.page = false;
    // the Logs moved from Settings to the Overview: old links land there
    if (/^#\/?settings\/logs\/?$/.test(location.hash)) history.replaceState(null, '', '#/overview/logs');
    // the shell's opening state (boot.js, index.html) ends here
    bootFrame?.remove();
    delete document.documentElement.dataset.boot;
    const [route, ...rest] = (location.hash.replace(/^#\/?/, '') || 'overview').split('/');
    const before = state.route;
    state.route = pages[route] ? route : 'overview';
    // a new visit to the Overview starts with the tiles' (and the logs') own height and rows
    if (state.route !== before) {
      releaseMonitorHeight({ rows: true });
      releaseLogsHeight({ scroll: true });
    }
    // the server's numbers are only asked for while the Overview shows them
    if (state.route !== 'overview') stopMonitor();
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === state.route));
    const label = document.querySelector(`#nav a[data-route="${state.route}"] span`)?.textContent || '';
    $('crumb').textContent = `Sentry Six Manager${label ? ` / ${label}` : ''}`;
    document.title = `${label || 'Overview'} · Sentry Six Manager`;
    const embedded = state.route === 'viewer' || state.route === 'encoder';
    $('topbar').hidden = embedded;
    // give Studio the room it needs on smaller windows; the sidebar comes back after
    if (embedded && innerWidth < 1200 && !app.classList.contains('collapsed')) app.classList.add('collapsed', 'auto-collapsed');
    if (!embedded && app.classList.contains('auto-collapsed')) app.classList.remove('collapsed', 'auto-collapsed');
    if (!embedded) for (const el of Object.values(frames)) hideFrame(el);
    const focused = focusedControl();
    try {
      await pages[state.route](rest.join('/'));
      labelTableCells(page);
    } catch (err) {
      if (seq === renderSeq) page.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
    if (seq === renderSeq) refocus(focused);
  }

  // A redraw replaces the button or checkbox that had the focus (a live
  // update, Clear jobs, a switch): the new one of the same id gets it back,
  // so a keyboard reader keeps their place. Fields that bring up a keyboard
  // or a picker are left alone.
  function focusedControl() {
    const el = document.activeElement;
    return el && el.id && page.contains(el) && el.matches('button, input[type="checkbox"], input[type="radio"]') ? el.id : '';
  }
  function refocus(id) {
    if (!id || (document.activeElement && document.activeElement !== document.body)) return;
    $(id)?.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', () => {
    if (LOGS_HASH.test(location.hash)) revealUntil = Date.now() + 5000;
    render();
  });

  // ---------- live updates ----------
  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('changed', async (e) => {
      const { topics } = JSON.parse(e.data);
      // the interface was switched (Settings > Interface): its pages, now
      if (topics.includes('interface')) {
        location.reload();
        return;
      }
      if (topics.includes('vehicles') || topics.includes('inventory') || topics.includes('bin')) await loadVehicles().catch(() => {});
      if (topics.includes('notifications')) await loadNotes().catch(() => {});
      const affects = {
        overview: ['vehicles', 'inventory', 'notifications', 'bin'], footage: ['inventory'], jobs: ['jobs'],
        bin: ['bin'], notifications: ['notifications'], policies: ['inventory']
      }[state.route] || [];
      // (not while the reader fills in a field: the redraw would take it
      // away; a switch the page keeps itself, data-kept, is redrawn as it is)
      if (topics.some((t) => affects.includes(t)) && !document.querySelector('dialog[open]') && !document.activeElement?.matches('input:not([data-kept]), select, textarea')) {
        // a highlight on the page: the update waits until it is gone
        if (selecting(page)) held.page = true;
        else render();
      }
      if (topics.includes('jobs') && state.route !== 'jobs') {
        api('/api/jobs?limit=50').then(({ jobs }) => {
          const running = jobs.filter((j) => j.status === 'running');
          setBadge('badge-jobs', running.length ? String(running.length) : '', 'busy');
          setBadge('badge-encoder', running.some((j) => j.type === 'conversion') ? '●' : '', 'busy');
        }).catch(() => {});
      }
    });
  }

  (async () => {
    // Started on the Encoder tab: it starts loading now instead of after the
    // settings and vehicles (it shows the vehicle picked last time, else the
    // first one, as the shell will).
    const encoderFirst = /^#\/?encoder\/?$/.test(location.hash);
    if (encoderFirst) render();
    try {
      const s = await api('/api/settings');
      state.power = s.power || null;
      $('reduce-effects').checked = Boolean(s.appearance?.reduceEffects);
      document.documentElement.classList.toggle('reduce-effects', Boolean(s.appearance?.reduceEffects));
      await Promise.all([loadVehicles(), loadNotes()]);
    } catch {
      // shown by render
    }
    // that frame is the selected vehicle's, so it stays
    if (encoderFirst && frames.encoder && !state.vehicles.some((v) => String(v.id) === frames.encoder.dataset.vehicle)) frames.encoder.dataset.vehicle = String(current()?.id || '');
    if (LOGS_HASH.test(location.hash)) revealUntil = Date.now() + 8000;
    render();
    connect();
  })();
})();
