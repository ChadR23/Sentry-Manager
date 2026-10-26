// Footage as a music library: days are albums, recordings are the tracks of a
// playlist, each with a play button and a duration.
import { h, ico, api, car, size, count, since, dayName, words, toast, ask, sheet, act, local, segs, onSegs, pill, debounce, CAMS, CAM_NAME, CAM_TAG, CODEC_NAME, paint } from '../core.js';

const CAT_TONE = { Recent: 'cyan', Sentry: 'org', Saved: 'grn', Other: '' };
const thumbUrl = (vid, rid) => `/api/vehicles/${encodeURIComponent(vid)}/recordings/${encodeURIComponent(rid)}/thumbnail`;
const dur = (min) => `${Math.floor(min)}:00`;

export default {
  async mount(el, { params, go, status }) {
    const v = car();
    if (!v) {
      el.innerHTML = `<section class="ptitle hud"><div><h1 class="chrome">Footage</h1></div></section><section class="panel hud"><div class="blank">${ico('car', 'i big')}<p>No vehicle yet. Add one to see its footage.</p><a class="btn go" href="#/settings/vehicles?add=1">${ico('plus')}Add a vehicle</a></div></section>`;
      return {};
    }
    const f = { cat: local.get('ft.cat', 'all'), day: params.get('day') || '', prot: false, conv: local.get('ft.conv', 'all'), q: '', sel: new Set(), cur: 0 };
    let days = { days: [] };
    let recs = [];
    let total = 0;
    let shown = [];
    let alive = true;
    let meta = {};

    el.innerHTML = `
      <section class="ptitle hud">
        <div><h1 class="chrome">Footage</h1><p id="ft-sum">${h(v.name)} · loading the library…</p></div>
        <div class="pacts"><button class="btn" type="button" id="ft-scan">${ico('refresh')}Refresh inventory</button><a class="btn" href="#/encoder?new=1">${ico('engine')}Convert</a></div>
      </section>
      <section class="hud panel ft-filters" aria-label="Filters">
        <div class="row">
          ${segs('cat', [['all', 'All'], ['Recent', 'Recent'], ['Sentry', 'Sentry'], ['Saved', 'Saved'], ['Other', 'Other']], f.cat, 'Category')}
          ${segs('conv', [['all', 'Any codec'], ['no', 'Not converted'], ['yes', 'Converted']], f.conv, 'Conversion')}
          <label class="chk"><input type="checkbox" id="ft-prot"> Protected only</label>
          <input class="in grow" type="search" id="ft-q" placeholder="Search time, event, place, camera" aria-label="Search recordings">
        </div>
      </section>
      <div class="ft-body">
        <section class="albums hud" aria-label="Days"><div class="ph"><h2>${ico('film')}Days</h2><span class="faint tiny" id="ft-dayn"></span></div><div class="album-list" id="ft-days"></div></section>
        <section class="playlist hud" aria-label="Track list">
          <div class="pl-head" id="ft-head"></div>
          <div class="bulk" id="ft-bulk" hidden></div>
          <ol class="tracks" id="ft-tracks" aria-label="Recordings"></ol>
          <p class="pl-foot small faint" id="ft-foot"></p>
        </section>
      </div>`;
    const $ = (s) => el.querySelector(s);

    // ---------- data ----------
    async function loadDays() {
      try {
        days = await api(`/api/vehicles/${encodeURIComponent(v.id)}/days?${new URLSearchParams({ category: f.cat, limit: '100' })}`);
      } catch (err) {
        days = { days: [], total: 0, error: err.message };
      }
      if (alive) drawDays();
    }
    async function loadRecs() {
      const q = new URLSearchParams({ category: f.cat, limit: '500' });
      if (f.day) q.set('date', f.day);
      if (f.prot) q.set('protected', '1');
      try {
        const out = await api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings?${q}`);
        recs = out.recordings;
        total = out.total;
        meta = out;
        let off = recs.length;
        while (off < total && off < 5000) {
          q.set('offset', String(off));
          const more = await api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings?${q}`);
          if (!more.recordings.length) break;
          recs = recs.concat(more.recordings);
          off += more.recordings.length;
        }
      } catch (err) {
        recs = [];
        total = 0;
        meta = { error: err.message };
      }
      for (const id of [...f.sel]) if (!recs.some((r) => r.id === id)) f.sel.delete(id);
      if (alive) { drawHead(); drawTracks(); }
    }

    // ---------- days (albums) ----------
    function drawDays() {
      const list = days.days || [];
      $('#ft-dayn').textContent = count(days.total || 0, 'day');
      const all = list.reduce((n, d) => n + d.bytes, 0);
      paint($('#ft-days'), `<button type="button" class="album${f.day ? '' : ' on'}" data-day="" aria-pressed="${!f.day}">
          <span class="album-art all" aria-hidden="true">${ico('horizon')}</span>
          <span class="album-t"><b>All days</b><span class="small dim">${count(days.recordings || 0, 'track')} · ${size(all)}</span></span></button>
        ${days.error ? `<p class="small badtx">${h(days.error)}</p>` : ''}
        ${list.map((d) => {
          const cats = Object.entries(d.byCategory || {});
          const enc = d.clips ? Math.round((d.encoded / d.clips) * 100) : 0;
          return `<button type="button" class="album${f.day === d.day ? ' on' : ''}" data-day="${h(d.day)}" aria-pressed="${f.day === d.day}">
            <span class="album-art" aria-hidden="true">${d.thumbId ? `<img alt="" loading="lazy" src="${thumbUrl(v.id, d.thumbId)}">` : ico('film')}</span>
            <span class="album-t"><b>${h(dayName(d.day))}</b><span class="small dim">${count(d.recordings, 'track')} · ${d.minutes} min · ${size(d.bytes)}</span>
              <span class="catbar" aria-hidden="true">${cats.map(([c, n]) => `<i class="c-${h(c)}" style="flex:${n}"></i>`).join('')}</span>
              <span class="tiny faint">${cats.map(([c, n]) => `${c} ${n}`).join(' · ')}${d.protected ? ` · ${d.protected} protected` : ''} · ${enc}% converted</span></span></button>`;
        }).join('')}
        ${!list.length && !days.error ? '<p class="small dim">No days match these filters.</p>' : ''}`);
    }
    $('#ft-days').addEventListener('click', (e) => {
      const b = e.target.closest('[data-day]');
      if (b) pickDay(b.dataset.day);
    });
    function pickDay(day) {
      f.day = day;
      f.cur = 0;
      history.replaceState(null, '', day ? `#/footage?day=${day}` : '#/footage');
      drawDays();
      loadRecs();
      if (matchMedia('(max-width: 1023px)').matches) $('#ft-head').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    function drawHead() {
      const d = (days.days || []).find((x) => x.day === f.day);
      const b = recs.reduce((n, r) => n + r.bytes, 0);
      const mins = recs.reduce((n, r) => n + (r.minutes || 0), 0);
      $('#ft-head').innerHTML = `
        <div class="pl-art" aria-hidden="true">${d?.thumbId ? `<img alt="" src="${thumbUrl(v.id, d.thumbId)}">` : ico('horizon', 'i big')}</div>
        <div class="pl-info">
          <span class="tiny faint pl-kind">${f.day ? 'DAY' : 'LIBRARY'} · ${h(v.name)}</span>
          <h2 class="chrome pl-title">${h(f.day ? dayName(f.day, true) : 'All days')}</h2>
          <p class="small dim">${count(total, 'track')} · ${mins} min · ${size(b)}${f.cat !== 'all' ? ` · ${h(f.cat)} only` : ''}${f.prot ? ' · protected only' : ''}</p>
          <div class="row">
            <button class="btn go" type="button" id="ft-playall"${recs.length ? '' : ' disabled'}>${ico('play')}${f.day ? 'Play day' : 'Play newest day'}</button>
            ${f.day ? `<button class="btn danger" type="button" id="ft-delday">${ico('bin')}Move day to Bin</button><button class="btn danger" type="button" id="ft-delthru">${ico('bin')}This day and older</button>` : ''}
          </div>
        </div>`;
      $('#ft-playall').onclick = () => {
        const day = f.day || recs[0]?.day || days.dates?.[0];
        if (day) go(`#/viewer?day=${encodeURIComponent(day)}`);
      };
      $('#ft-delday')?.addEventListener('click', () => trashDays(f.day, false));
      $('#ft-delthru')?.addEventListener('click', () => trashDays(f.day, true));
      const inv = meta.scannedAt ? `inventory ${since(meta.scannedAt)}${meta.scanning ? ' · scanning…' : ''}` : '';
      $('#ft-sum').textContent = `${v.name} · ${count(days.recordings || 0, 'recording')} on ${count(days.total || 0, 'day')} · ${inv} · times are the car's (${v.timezone || 'local'})`;
      status(`${count(total, 'track')}${f.day ? ` · ${dayName(f.day)}` : ''}`);
    }

    // ---------- tracks ----------
    function filtered() {
      const q = f.q.trim().toLowerCase();
      return recs.filter((r) => {
        if (f.conv === 'yes' && !(r.encoded?.encoded > 0)) return false;
        if (f.conv === 'no' && r.encoded?.clips && r.encoded.encoded === r.encoded.clips) return false;
        if (!q) return true;
        return `${r.start} ${r.end} ${r.folder} ${r.category} ${r.eventId || ''} ${r.cameras.map((c) => CAM_NAME[c] || c).join(' ')}`.toLowerCase().includes(q);
      }).sort((a, b) => String(b.startKey).localeCompare(String(a.startKey)));
    }
    function codec(r) {
      const e = r.encoded || {};
      if (!e.clips) return '';
      if (!e.encoded) return pill('H.264', '');
      return pill(`${(e.codecs || []).map((c) => CODEC_NAME[c] || c).join('+') || 'converted'}${e.encoded < e.clips ? ` ${e.encoded}/${e.clips}` : ''}`, 'mag');
    }
    function drawTracks() {
      shown = filtered();
      f.cur = Math.max(0, Math.min(f.cur, shown.length - 1));
      paint($('#ft-tracks'), shown.map((r, i) => {
        const sel = f.sel.has(r.id);
        const have = new Set(r.cameras);
        const ev = r.eventAt ? ` · event ${r.eventAt.slice(11, 19)}` : '';
        return `<li class="track${sel ? ' sel' : ''}${i === f.cur ? ' cur' : ''}" data-id="${h(r.id)}" data-i="${i}">
          <label class="tk-sel chk"><input type="checkbox" aria-label="Select ${h(r.start)}"${sel ? ' checked' : ''}></label>
          <span class="tk-n num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
          <button class="tk-play" type="button" data-act="play" aria-label="Play ${h(r.start)}">${ico('play')}</button>
          <span class="tk-art" aria-hidden="true">${r.thumbRel || r.frontRel ? `<img loading="lazy" alt="" src="${thumbUrl(v.id, r.id)}">` : ''}</span>
          <span class="tk-t"><b class="num">${h(r.start.slice(11))}<span class="faint"> – ${h((r.end || r.start).slice(11))}</span></b>
            <span class="tk-sub small">${pill(r.category, CAT_TONE[r.category] || '')}<span class="dim">${h(f.day ? '' : `${dayName(r.day)} · `)}${h(words(r.type || ''))}${h(ev)}</span>${r.protected ? `<span class="lock" title="Protected">${ico('lock')}<span class="sr-only">Protected</span></span>` : ''}</span></span>
          <span class="tk-cams" aria-label="Cameras: ${h(r.cameras.map((c) => CAM_NAME[c] || c).join(', '))}">${CAMS.map((c) => `<i class="${have.has(c) ? 'on' : ''}">${CAM_TAG[c]}</i>`).join('')}</span>
          <span class="tk-codec">${codec(r)}</span>
          <span class="tk-dur num">${dur(r.minutes)}<span class="faint small"> · ${size(r.bytes)}</span></span>
          <span class="tk-acts">
            <button class="btn icon ghost" type="button" data-act="protect" aria-label="${r.protected ? 'Unprotect' : 'Protect'} ${h(r.start)}">${ico(r.protected ? 'unlock' : 'lock')}</button>
            <button class="btn icon ghost" type="button" data-act="trash" aria-label="Move ${h(r.start)} to the Recycle Bin"${r.protected ? ' disabled' : ''}>${ico('bin')}</button>
            <button class="btn icon ghost" type="button" data-act="info" aria-label="Details of ${h(r.start)}">${ico('info')}</button>
          </span></li>`;
      }).join('') || `<li class="blank">${meta.error ? h(meta.error) : recs.length ? 'No track matches the search.' : 'No recordings here yet.'}</li>`);
      $('#ft-foot').textContent = shown.length ? `${shown.length} of ${total} shown · keyboard: j / k move · Enter play · x select · p protect · Delete to Bin` : '';
      drawBulk();
    }
    function drawBulk() {
      const sel = recs.filter((r) => f.sel.has(r.id));
      $('#ft-bulk').hidden = !sel.length;
      if (!sel.length) return;
      $('#ft-bulk').innerHTML = `<b class="num">${sel.length} selected · ${size(sel.reduce((n, r) => n + r.bytes, 0))}</b>
        <button class="btn sm" type="button" data-bulk="protect">${ico('lock')}Protect</button>
        <button class="btn sm" type="button" data-bulk="unprotect"${sel.some((r) => r.protected) ? '' : ' disabled'}>${ico('unlock')}Unprotect</button>
        <button class="btn sm danger" type="button" data-bulk="trash"${sel.some((r) => !r.protected) ? '' : ' disabled'}>${ico('bin')}Move to Bin</button>
        <button class="btn sm" type="button" data-bulk="all">Select all shown</button>
        <button class="btn sm ghost" type="button" data-bulk="clear">Clear</button>`;
    }
    $('#ft-tracks').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-id]');
      if (!li) return;
      const r = recs.find((x) => x.id === li.dataset.id);
      f.cur = Number(li.dataset.i);
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'play') return play(r);
      if (a === 'protect') return protect([r.id], !r.protected);
      if (a === 'trash') return trash([r.id]);
      if (a === 'info') return info(r);
      if (e.target.matches('input[type=checkbox]')) {
        if (e.target.checked) f.sel.add(r.id); else f.sel.delete(r.id);
        li.classList.toggle('sel', e.target.checked);
        drawBulk();
      }
      return undefined;
    });
    $('#ft-tracks').addEventListener('dblclick', (e) => {
      const li = e.target.closest('li[data-id]');
      if (li && !e.target.closest('button, input, label')) play(recs.find((x) => x.id === li.dataset.id));
    });
    $('#ft-bulk').addEventListener('click', (e) => {
      const b = e.target.closest('[data-bulk]')?.dataset.bulk;
      const ids = [...f.sel];
      if (b === 'protect') protect(ids, true);
      if (b === 'unprotect') protect(ids, false);
      if (b === 'trash') trash(ids);
      if (b === 'all') { shown.forEach((r) => f.sel.add(r.id)); drawTracks(); }
      if (b === 'clear') { f.sel.clear(); drawTracks(); }
    });

    // ---------- actions ----------
    const play = (r) => r && go(`#/viewer?rec=${encodeURIComponent(r.id)}`);
    async function protect(ids, on) {
      if (!ids.length) return;
      await act(null, async () => {
        await api(`/api/vehicles/${encodeURIComponent(v.id)}/protect`, { body: { ids, protected: on } });
        toast(on ? `Protected ${count(ids.length, 'recording')}: policies and the Bin skip ${ids.length === 1 ? 'it' : 'them'}.` : 'Protection removed.');
      });
      await loadRecs();
    }
    async function trash(ids) {
      const list = recs.filter((r) => ids.includes(r.id));
      const movable = list.filter((r) => !r.protected);
      if (!movable.length) { toast('Protected recordings stay where they are.', 'bad'); return; }
      const b = movable.reduce((n, r) => n + r.bytes, 0);
      if (!(await ask({ title: `Move ${count(movable.length, 'recording')} to the Recycle Bin?`, body: `<p><b>${size(b)}</b> moves to the Recycle Bin on the same share. You can restore it any time; nothing is deleted until you empty the Bin.</p>${list.length > movable.length ? `<p class="dim">${list.length - movable.length} protected recording(s) stay.</p>` : ''}`, yes: 'Move to Bin', danger: true }))) return;
      await act(null, async () => {
        const out = await api(`/api/vehicles/${encodeURIComponent(v.id)}/trash`, { body: { ids: movable.map((r) => r.id) } });
        const why = out.skipped?.length ? ` ${out.skipped.length} skipped (${[...new Set(out.skipped.map((s) => s.reason))].join(', ')}).` : '';
        toast(`${count(out.moved.length, 'recording')} moved to the Recycle Bin (${size(out.bytes)}).${why}`, out.skipped?.length && !out.moved.length ? 'bad' : 'ok');
        movable.forEach((r) => f.sel.delete(r.id));
      });
      await Promise.all([loadRecs(), loadDays()]);
    }
    async function trashDays(day, through) {
      let pv;
      try {
        pv = await api(`/api/vehicles/${encodeURIComponent(v.id)}/trash-days`, { body: { day, through, category: f.cat, preview: true } });
      } catch (err) { toast(err.message, 'bad'); return; }
      if (!pv.recordings) { toast(pv.protected ? 'Everything there is protected: nothing to move.' : 'Nothing to move.'); return; }
      if (!(await ask({
        title: through ? 'Move this day and every older day to the Bin?' : 'Move this day to the Recycle Bin?',
        body: `<p><b>${count(pv.recordings, 'recording')}</b> · <b>${size(pv.bytes)}</b> from ${h(dayName(day, true))}${through ? ` and older${pv.days > 1 ? ` (${pv.days} days, the oldest ${h(pv.oldest)})` : ''}` : ''}${f.cat === 'all' ? '' : ` (${h(f.cat)} only, as filtered)`}.</p><p class="dim">Nothing is deleted until you empty the Recycle Bin.${pv.protected ? ` ${count(pv.protected, 'protected recording')} stay.` : ''}</p>`,
        yes: through ? 'Move day and older' : 'Move day', danger: true
      }))) return;
      await act(null, async () => {
        const out = await api(`/api/vehicles/${encodeURIComponent(v.id)}/trash-days`, { body: { day, through, category: f.cat } });
        toast(`Moving ${count(out.recordings, 'recording')} (${size(out.bytes)}) to the Recycle Bin. Jobs shows the progress.`);
      });
    }
    async function info(r) {
      let d;
      try { d = await api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(r.id)}`); } catch (err) { toast(err.message, 'bad'); return; }
      const ev = d.event;
      await sheet(`Track ${d.start}`, `
        <div class="info-top">${r.thumbRel || r.frontRel ? `<img class="info-art" alt="Thumbnail of ${h(d.start)}" src="${thumbUrl(v.id, r.id)}">` : ''}
          <dl class="kv"><dt>Type</dt><dd>${h(words(d.type))} · ${h(d.category)}</dd><dt>Start → end</dt><dd class="num">${h(d.start)} → ${h(d.end)}</dd>
            ${d.eventAt ? `<dt>Event at</dt><dd class="num">${h(d.eventAt)}</dd>` : ''}
            ${ev ? `<dt>Event</dt><dd>${h([words(ev.reason), ev.city, ev.street].filter(Boolean).join(' · '))}${ev.est_lat ? `<br><span class="mono small">${h(ev.est_lat)}, ${h(ev.est_lon)}</span>` : ''}</dd>` : ''}
            <dt>Cameras</dt><dd>${h(d.cameras.map((c) => CAM_NAME[c] || c).join(', '))}</dd>
            <dt>Size</dt><dd class="num">${size(d.bytes)} · ${count(d.fileCount, 'file')} · ${count(d.clipCount, 'clip')}</dd>
            <dt>Converted</dt><dd class="num">${d.encoded?.encoded ?? 0} of ${d.encoded?.clips ?? 0} clips ${h((d.encoded?.codecs || []).map((c) => CODEC_NAME[c] || c).join(', '))}</dd>
            <dt>Protected</dt><dd>${d.protected ? 'yes' : 'no'}</dd><dt>Folder</dt><dd class="mono small">${h(d.folderPath)}</dd></dl></div>
        <div class="row"><button class="btn go" type="button" value="play" data-i="play">${ico('play')}Play</button><button class="btn" type="button" data-i="protect">${ico(d.protected ? 'unlock' : 'lock')}${d.protected ? 'Unprotect' : 'Protect'}</button><button class="btn danger" type="button" data-i="trash"${d.protected ? ' disabled' : ''}>${ico('bin')}Move to Bin</button></div>
        <h3 class="sub-h">Files</h3>
        <div class="tblwrap"><table class="tbl stack"><thead><tr><th>File</th><th>Codec</th><th class="r">Size</th><th class="r">Download</th></tr></thead><tbody>
          ${d.files.map((x) => `<tr><td data-label="File" class="mono small wrap-any">${h(x.rel.split('/').pop())}</td><td data-label="Codec">${'codec' in x ? (x.codec ? pill(CODEC_NAME[x.codec] || x.codec, x.codec === 'h264' ? '' : 'mag') : '<span class="faint">checking</span>') : '<span class="faint">asset</span>'}</td><td data-label="Size" class="r num">${size(x.size)}</td><td class="r"><a class="btn icon ghost" href="/api/media?path=${encodeURIComponent(x.path)}" download aria-label="Download ${h(x.rel.split('/').pop())}">${ico('download')}</a></td></tr>`).join('')}
        </tbody></table></div>`, {
        onOpen(form, dlg) {
          form.querySelector('[data-i="play"]').onclick = () => { dlg.close(); play(r); };
          form.querySelector('[data-i="protect"]').onclick = () => { dlg.close(); protect([r.id], !d.protected); };
          form.querySelector('[data-i="trash"]').onclick = () => { dlg.close(); trash([r.id]); };
        }
      });
    }

    // ---------- filters ----------
    onSegs(el, 'cat', (c) => { f.cat = c; local.set('ft.cat', c); loadDays(); loadRecs(); });
    onSegs(el, 'conv', (c) => { f.conv = c; local.set('ft.conv', c); drawTracks(); });
    $('#ft-prot').onchange = (e) => { f.prot = e.target.checked; loadRecs(); };
    $('#ft-q').addEventListener('input', debounce((e) => { f.q = e.target.value; f.cur = 0; drawTracks(); }, 120));
    $('#ft-scan').onclick = (e) => act(e.currentTarget, async () => { await api(`/api/vehicles/${encodeURIComponent(v.id)}/scan`, { body: {} }); toast('Refreshing the inventory. Jobs shows the progress.'); });

    await Promise.all([loadDays(), loadRecs()]);

    const row = (i) => $(`#ft-tracks li[data-i="${i}"]`);
    function move(i) {
      if (!shown.length) return;
      row(f.cur)?.classList.remove('cur');
      f.cur = Math.max(0, Math.min(shown.length - 1, i));
      const r = row(f.cur);
      r?.classList.add('cur');
      r?.scrollIntoView({ block: 'nearest' });
      r?.querySelector('.tk-play')?.focus({ preventScroll: true });
    }
    return {
      unmount() { alive = false; },
      onTopics(t) { if (t.includes('inventory') || t.includes('bin')) { loadDays(); loadRecs(); } },
      keys: [['j / k', 'Next / previous track'], ['Enter', 'Play the track'], ['x', 'Select the track'], ['p', 'Protect / unprotect'], ['Delete', 'Move to the Recycle Bin'], ['i', 'Track details'], ['/', 'Search']],
      onKey(e) {
        const r = shown[f.cur];
        switch (e.key) {
          case 'j': case 'ArrowDown': move(f.cur + 1); return true;
          case 'k': case 'ArrowUp': move(f.cur - 1); return true;
          case 'Enter': if (r && !e.target.closest?.('button, a')) { play(r); return true; } return false;
          case 'x': if (r) { if (f.sel.has(r.id)) f.sel.delete(r.id); else f.sel.add(r.id); drawTracks(); } return true;
          case 'p': if (r) protect(f.sel.size ? [...f.sel] : [r.id], f.sel.size ? true : !r.protected); return true;
          case 'Delete': case 'Backspace': if (r) trash(f.sel.size ? [...f.sel] : [r.id]); return true;
          case 'i': if (r) info(r); return true;
          case '/': $('#ft-q').focus(); return true;
          case 'Escape': if (f.sel.size) { f.sel.clear(); drawTracks(); return true; } return false;
          default: return false;
        }
      }
    };
  }
};
