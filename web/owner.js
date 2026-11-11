'use strict';

// The demo's owner page (server/ownerPage.js). Every string from the attack
// log was typed by an attacker: it only ever goes into text nodes.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else n.setAttribute(k, v);
    }
    for (const k of kids) if (k !== null && k !== undefined) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  };
  const KIND = { login: 'Failed sign-in', 'owner-probe': 'Owner probe', scan: 'Scanner', exploit: 'Exploit', malformed: 'Malformed', 'locked-feature': 'Locked feature', 'rate-limit': 'Rate limit', ban: 'Ban' };
  const TONE = { exploit: 'red', ban: 'red', 'owner-probe': 'amber', login: 'amber', scan: 'blue', 'rate-limit': 'violet', 'locked-feature': 'slate', malformed: 'slate' };
  const when = (ms) => (ms ? new Date(ms).toLocaleString() : '-');
  let sort = 'newest';

  async function call(method, url, body) {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'sentry-six-manager', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
    return data;
  }

  const query = () => {
    const q = new URLSearchParams();
    if ($('kind').value) q.set('kind', $('kind').value);
    q.set('sort', sort);
    return q.toString();
  };

  function kv(dl, rows) {
    dl.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v ?? '-')]));
  }

  function render(s) {
    $('you').textContent = `You are at ${s.you}. Addresses are the real client's (Cloudflare-aware).`;
    const st = s.stats || {};
    const tiles = [[s.visitors.today, 'visitors today'], [s.visitors.sessions, 'sessions active'], [st.addresses || 0, 'addresses in the log'], [st.last24h || 0, 'attacking in 24 h'], [s.bans.length, 'bans in force']];
    $('tiles').replaceChildren(...tiles.map(([n, label]) => el('div', { class: 'tile' }, el('b', {}, n), el('span', {}, label))));
    kv($('demo'), [['Resets every', `${s.demo.resetMinutes} min`], ['Reset', s.demo.resetAvailable ? 'available' : 'not in this build']]);
    $('reset').disabled = !s.demo.resetAvailable;
    const t = s.tls || {};
    kv($('cert'), [['Mode', t.mode], ['Issuer', t.issuer], ['Names', (t.names || []).join(', ')], ['Expires', t.validTo], ...(t.error ? [['Error', t.error]] : [])]);
    $('csv').href = `/api/owner/log.csv?${query()}`;
    const banned = new Set(s.bans.map((b) => b.key));
    if (!s.log.length) return $('groups').replaceChildren(el('p', { class: 'muted' }, 'Nothing in the log.'));
    $('groups').replaceChildren(...s.log.map((g) => {
      const ban = el('button', { class: 'btn sm danger', type: 'button' }, banned.has(g.address) ? 'Banned' : 'Ban');
      if (banned.has(g.address)) ban.disabled = true;
      ban.addEventListener('click', async () => {
        ban.disabled = true;
        try { await call('POST', '/api/owner/ban', { address: g.address }); ban.textContent = 'Banned'; } catch (err) { ban.disabled = false; $('err').textContent = err.message; }
      });
      const rows = g.entries.map((e) => el('tr', {},
        el('td', { 'data-l': 'Kind' }, el('span', { class: `chip ${TONE[e.kind] || ''}` }, KIND[e.kind] || e.kind)),
        el('td', { 'data-l': 'Count' }, e.count),
        el('td', { 'data-l': 'First' }, when(e.firstSeen)),
        el('td', { 'data-l': 'Last' }, when(e.lastSeen)),
        el('td', { class: 'sample', 'data-l': 'Sample' }, e.sample || '-'),
        el('td', { class: 'agent', 'data-l': 'Agent' }, e.agent || '-')));
      return el('div', { class: 'card' },
        el('div', { class: 'group-head' },
          el('div', {}, el('div', { class: 'addr' }, g.address), el('div', { class: 'muted small' }, `${g.count} attempt${g.count === 1 ? '' : 's'} · first ${when(g.firstSeen)} · last ${when(g.lastSeen)}`)),
          ban),
        el('div', { class: 'kinds' }, ...Object.entries(g.kinds).map(([k, n]) => el('span', { class: `chip ${TONE[k] || ''}` }, `${KIND[k] || k} ${n}`))),
        el('table', { class: 'table entries' }, el('thead', {}, el('tr', {}, ...['Kind', 'Count', 'First seen', 'Last seen', 'Sample', 'User agent'].map((h) => el('th', {}, h)))), el('tbody', {}, ...rows)));
    }));
  }

  async function load() {
    $('err').textContent = '';
    try {
      const s = await call('GET', `/api/owner/state?${query()}`);
      $('login').hidden = true;
      $('page').hidden = false;
      render(s);
    } catch (err) {
      if (err.status === 401) { $('page').hidden = true; $('login').hidden = false; return; }
      $('err').textContent = err.message;
    }
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-err').textContent = '';
    try {
      await call('POST', '/api/owner/login', { password: e.target.password.value });
      e.target.reset();
      load();
    } catch (err) { $('login-err').textContent = err.message; }
  });
  $('logout').addEventListener('click', async () => { await call('POST', '/api/owner/logout').catch(() => {}); load(); });
  $('kind').addEventListener('change', load);
  $('refresh').addEventListener('click', load);
  for (const b of document.querySelectorAll('[data-sort]')) {
    b.addEventListener('click', () => {
      sort = b.dataset.sort;
      for (const x of document.querySelectorAll('[data-sort]')) x.classList.toggle('on', x === b);
      load();
    });
  }
  $('reset').addEventListener('click', async () => {
    if (!confirm('Reset the demo now? Everything visitors changed goes back to the start.')) return;
    $('reset').disabled = true;
    try { await call('POST', '/api/owner/reset'); $('reset-note').textContent = 'Reset done.'; } catch (err) { $('reset-note').textContent = err.message; }
    load();
  });
  load();
})();
