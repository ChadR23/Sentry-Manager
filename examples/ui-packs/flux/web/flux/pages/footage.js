// Footage: days on the left, a dense sortable/filterable recordings table on the right,
// keyboard bulk selection and a raw-JSON inspector drawer.
import { esc, api, state, current, bytes, plural, dayTitle, ago, icon, toast, confirmDialog, busy, jsonHtml, debounce, store, CAMERAS, CAMERA_LABEL, CAMERA_SHORT, humanize } from '../core.js';
import { split, seg, wireSeg, drawer, empty, chip } from '../ui.js';

const CODEC = { h264: 'H.264', h265: 'H.265', av1: 'AV1', hevc: 'H.265' };
const COLS = [
  ['start', 'Start'], ['category', 'Type'], ['minutes', 'Dur'], ['cameras', 'Cams'], ['fileCount', 'Files'], ['bytes', 'Size'], ['enc', 'Codec'], ['protected', '']
];

export default {
  async mount(el, { params, go }) {
    const v = current();
    if (!v) {
      el.innerHTML = `<div class="phead"><div><h1>Footage</h1></div></div>${empty('No vehicles yet. Add one in Settings to see its footage.', '<a class="btn primary" href="#/settings/vehicles?add=1">Add a vehicle</a>')}`;
      return {};
    }
    const f = {
      category: store.get('fo:cat', 'all'),
      date: params.get('day') || '',
      prot: false,
      conv: store.get('fo:conv', 'all'),
      text: '',
      sort: store.get('fo:sort', { key: 'start', dir: -1 }),
      selected: new Set(),
      cursor: 0,
      anchor: null
    };
    let days = null;
    let recs = [];
    let total = 0;
    let shown = [];
    let alive = true;

    el.innerHTML = `
      <div class="phead">
        <div><h1>Footage <span class="muted h-sub">${esc(v.name)}</span></h1><p class="muted small" id="fo-sum">Loading…</p></div>
        <div class="phead-actions">
          <button class="btn" type="button" id="fo-scan">${icon('refresh')}Refresh inventory</button>
          <a class="btn cyan" href="#/encoder?new=1">${icon('encoder')}Review conversion</a>
        </div>
      </div>
      <div class="toolbar wrap" role="search">
        ${seg('cat', [['all', 'All'], ['Recent', 'Recent'], ['Sentry', 'Sentry'], ['Saved', 'Saved'], ['Other', 'Other']], f.category, 'Category')}
        ${seg('conv', [['all', 'Any codec'], ['no', 'Not converted'], ['yes', 'Converted']], f.conv, 'Converted')}
        <label class="check"><input type="checkbox" id="fo-prot"> Protected only</label>
        <input class="input grow" type="search" id="fo-text" data-filter placeholder="Filter: time, folder, event, camera  ( / )" aria-label="Filter recordings">
      </div>
      <div id="fo-split">
        <section class="days-pane" aria-label="Days"><div class="pane-title"><span>Days</span><span class="faint small" id="fo-days-n"></span></div><div class="days" id="fo-days"></div></section>
        <section class="recs-pane" aria-label="Recordings">
          <div class="bulk" id="fo-bulk"></div>
          <div class="tscroll" id="fo-tbox"><table class="dtable recs" id="fo-table" aria-label="Recordings" aria-multiselectable="true"></table></div>
          <div class="table-foot" id="fo-foot"></div>
        </section>
      </div>`;
    split(el.querySelector('#fo-split'), { id: 'footage', initial: 260, min: 230, max: 520 });
    const $ = (s) => el.querySelector(s);

    // ---------- loading ----------
    async function loadDays() {
      const q = new URLSearchParams({ category: f.category, limit: '100' });
      try {
        days = await api(`/api/vehicles/${encodeURIComponent(v.id)}/days?${q}`);
      } catch (err) {
        days = { days: [], total: 0, recordings: 0, error: err.message };
      }
      if (alive) drawDays();
    }
    async function loadRecs() {
      const q = new URLSearchParams({ category: f.category, limit: '500' });
      if (f.date) q.set('date', f.date);
      if (f.prot) q.set('protected', '1');
      let out;
      try {
        out = await api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings?${q}`);
        recs = out.recordings;
        total = out.total;
        // more than one page: fetch the rest
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
        $('#fo-table').innerHTML = `<tbody><tr><td>${esc(err.message)}</td></tr></tbody>`;
        return;
      }
      for (const id of [...f.selected]) if (!recs.some((r) => r.id === id)) f.selected.delete(id);
      $('#fo-sum').textContent = `${plural(out.total, 'recording')}${f.date ? ` on ${dayTitle(f.date)}` : ''} · inventory ${ago(out.scannedAt)}${out.scanning ? ' · scanning…' : ''} · times are the vehicle's (${v.timezone || 'local'})`;
      if (alive) drawTable();
    }

    // ---------- days ----------
    function drawDays() {
      const list = days.days || [];
      $('#fo-days-n').textContent = `${days.total ?? 0} days`;
      const allBytes = list.reduce((n, d) => n + d.bytes, 0);
      const maxB = Math.max(1, ...list.map((d) => d.bytes));
      $('#fo-days').innerHTML = `<button type="button" class="day${f.date ? '' : ' on'}" data-day=""><div class="day-top"><b>All days</b><span class="num small">${bytes(allBytes)}</span></div><div class="small muted">${plural(days.recordings || 0, 'recording')}</div></button>
        ${days.error ? `<p class="bad-text small">${esc(days.error)}</p>` : ''}
        ${list.map((d) => {
          const cats = Object.entries(d.byCategory || {});
          const encP = d.clips ? (d.encoded / d.clips) * 100 : 0;
          return `<div class="day${f.date === d.day ? ' on' : ''}" data-day="${esc(d.day)}" role="button" tabindex="0" aria-pressed="${f.date === d.day}">
            <div class="day-top"><b>${esc(dayTitle(d.day))}</b><span class="num small">${bytes(d.bytes)}</span></div>
            <div class="daybar" title="${esc(cats.map(([c, n]) => `${c}: ${n}`).join(', '))}">${cats.map(([c, n]) => `<i class="cat-${esc(c)}" style="flex:${n}"></i>`).join('')}</div>
            <div class="small muted num">${plural(d.recordings, 'rec')} · ${d.minutes} min · ${d.cameras} cams${d.protected ? ` · ${d.protected} ${icon('lock', 'ico xs')}` : ''}</div>
            <div class="enc-line"><span class="enc-track"><span style="width:${encP.toFixed(1)}%"></span></span><span class="small faint num">${d.encoded}/${d.clips} encoded</span></div>
            <div class="day-actions">
              <button class="btn sm" type="button" data-play-day="${esc(d.day)}" aria-label="Play ${esc(d.day)}">${icon('play')}Play</button>
              <button class="btn sm" type="button" data-del-day="${esc(d.day)}">Delete day</button>
              <button class="btn sm" type="button" data-del-through="${esc(d.day)}">…and older</button>
            </div>
            <span class="day-size" style="width:${((d.bytes / maxB) * 100).toFixed(1)}%"></span>
          </div>`;
        }).join('')}
        ${!list.length && !days.error ? '<p class="muted small" style="padding:8px">No days match.</p>' : ''}`;
    }
    $('#fo-days').addEventListener('click', (e) => {
      const play = e.target.closest('[data-play-day]');
      if (play) { go(`#/viewer?day=${encodeURIComponent(play.dataset.playDay)}`); return; }
      const del = e.target.closest('[data-del-day]');
      if (del) { deleteDays(del.dataset.delDay, false); return; }
      const thr = e.target.closest('[data-del-through]');
      if (thr) { deleteDays(thr.dataset.delThrough, true); return; }
      const d = e.target.closest('[data-day]');
      if (d) pickDay(d.dataset.day);
    });
    $('#fo-days').addEventListener('keydown', (e) => {
      const d = e.target.closest('[data-day]');
      if (d && (e.key === 'Enter' || e.key === ' ') && e.target === d) { e.preventDefault(); pickDay(d.dataset.day); }
    });
    function pickDay(day) {
      f.date = day;
      f.cursor = 0;
      history.replaceState(null, '', day ? `#/footage?day=${day}` : '#/footage');
      drawDays();
      loadRecs();
    }
    async function deleteDays(day, through) {
      let preview;
      try {
        preview = await api(`/api/vehicles/${encodeURIComponent(v.id)}/trash-days`, { body: { day, through, category: f.category, preview: true } });
      } catch (err) { toast(err.message, 'bad'); return; }
      if (!preview.recordings) { toast(preview.protected ? 'Everything there is protected: nothing to move.' : 'Nothing to move.'); return; }
      const scope = f.category === 'all' ? '' : ` (${f.category} only, as filtered)`;
      const ok = await confirmDialog({
        title: through ? 'Move this day and every older day to the Recycle Bin?' : 'Move this day to the Recycle Bin?',
        body: `<p><b>${plural(preview.recordings, 'recording')}</b> · <b>${bytes(preview.bytes)}</b> from ${esc(dayTitle(day))}${through ? ` and older${preview.days > 1 ? ` (${preview.days} days, oldest ${esc(preview.oldest)})` : ''}` : ''}${esc(scope)}.</p><p class="muted">Nothing is deleted until you empty the Recycle Bin.${preview.protected ? ` ${plural(preview.protected, 'protected recording')} stay.` : ''}</p>`,
        ok: through ? 'Move day and older' : 'Move day', danger: true
      });
      if (!ok) return;
      await busy(null, async () => {
        const out = await api(`/api/vehicles/${encodeURIComponent(v.id)}/trash-days`, { body: { day, through, category: f.category } });
        toast(`Moving ${plural(out.recordings, 'recording')} (${bytes(out.bytes)}) to the Recycle Bin. Jobs shows the progress.`);
      });
    }

    // ---------- table ----------
    const encOf = (r) => (r.encoded?.clips ? r.encoded.encoded / r.encoded.clips : 0);
    const sortVal = (r, key) => (key === 'enc' ? encOf(r) : key === 'cameras' ? r.cameras.length : key === 'protected' ? (r.protected ? 1 : 0) : r[key] ?? '');
    function filtered() {
      const q = f.text.trim().toLowerCase();
      let list = recs.filter((r) => {
        if (f.conv === 'yes' && !(r.encoded?.encoded > 0)) return false;
        if (f.conv === 'no' && r.encoded?.encoded > 0 && r.encoded.encoded === r.encoded.clips) return false;
        if (!q) return true;
        return `${r.start} ${r.end} ${r.folder} ${r.category} ${r.eventId || ''} ${r.cameras.join(' ')} ${r.id}`.toLowerCase().includes(q);
      });
      const { key, dir } = f.sort;
      list = list.slice().sort((a, b) => {
        const x = sortVal(a, key);
        const y = sortVal(b, key);
        return (x > y ? 1 : x < y ? -1 : 0) * dir || String(a.start).localeCompare(String(b.start)) * -1;
      });
      return list;
    }
    function codecCell(r) {
      const e = r.encoded || {};
      if (!e.clips) return '<span class="faint">—</span>';
      const names = (e.codecs || []).map((c) => CODEC[c] || c).join('+');
      const p = (e.encoded / e.clips) * 100;
      if (!e.encoded) return `<span class="tag plain">H.264</span>${e.unknown ? '<span class="faint small"> ·checking</span>' : ''}`;
      return `<span class="tag enc">${esc(names || 'enc')}</span><span class="mini-meter" title="${e.encoded}/${e.clips} clips"><span style="width:${p.toFixed(0)}%"></span></span><span class="num small">${e.encoded}/${e.clips}</span>`;
    }
    function camsCell(r) {
      const have = new Set(r.cameras);
      return `<span class="cams" title="${esc(r.cameras.map((c) => CAMERA_LABEL[c] || c).join(', '))}">${CAMERAS.map((c) => `<i class="${have.has(c) ? 'on' : ''}">${CAMERA_SHORT[c]}</i>`).join('')}</span>`;
    }
    function drawTable() {
      shown = filtered();
      f.cursor = Math.max(0, Math.min(f.cursor, shown.length - 1));
      const { key, dir } = f.sort;
      const head = `<thead><tr><th class="cb"><label class="cbl"><input type="checkbox" id="fo-all" aria-label="Select every recording shown"${shown.length && shown.every((r) => f.selected.has(r.id)) ? ' checked' : ''}></label></th><th class="th-thumb"><span class="sr-only">Thumbnail</span></th>
        ${COLS.map(([k, label]) => `<th class="${['bytes', 'minutes', 'fileCount'].includes(k) ? 'r' : ''}" aria-sort="${key === k ? (dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="sort" data-sort="${k}">${label || icon('lock', 'ico xs')}${key === k ? `<span class="arrow">${dir > 0 ? '▲' : '▼'}</span>` : ''}</button></th>`).join('')}
        <th class="r">Actions</th></tr></thead>`;
      const rows = shown.map((r, i) => {
        const sel = f.selected.has(r.id);
        const cat = r.category;
        return `<tr data-id="${esc(r.id)}" data-i="${i}" class="${sel ? 'sel' : ''}${i === f.cursor ? ' cur' : ''}" aria-selected="${sel}">
          <td class="cb"><label class="cbl"><input type="checkbox" aria-label="Select ${esc(r.start)}"${sel ? ' checked' : ''}></label></td>
          <td class="thumbc">${r.thumbRel || r.frontRel ? `<img loading="lazy" alt="" src="/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(r.id)}/thumbnail">` : ''}</td>
          <td class="mono nowrap">${esc(r.start || r.day)}<div class="faint small">${r.end && r.end !== r.start ? `→ ${esc(r.end.slice(11))}` : ''}${r.eventAt ? ` · event ${esc(r.eventAt.slice(11))}` : ''}</div></td>
          <td><span class="cat ${esc(cat)}">${esc(cat)}</span></td>
          <td class="r num">${r.minutes}m</td>
          <td>${camsCell(r)}</td>
          <td class="r num">${r.fileCount}</td>
          <td class="r num">${bytes(r.bytes)}</td>
          <td class="nowrap">${codecCell(r)}</td>
          <td>${r.protected ? `<span class="prot" title="Protected">${icon('lock', 'ico xs')}</span>` : ''}</td>
          <td class="r nowrap acts">
            <button class="btn sm icon" type="button" data-act="play" aria-label="Play ${esc(r.start)}" title="Play (Enter)">${icon('play')}</button>
            <button class="btn sm icon" type="button" data-act="protect" aria-label="${r.protected ? 'Unprotect' : 'Protect'} ${esc(r.start)}" title="${r.protected ? 'Unprotect' : 'Protect'} (p)">${icon(r.protected ? 'unlock' : 'lock')}</button>
            <button class="btn sm icon" type="button" data-act="trash" aria-label="Move ${esc(r.start)} to the Recycle Bin" title="Move to the Recycle Bin (Delete)"${r.protected ? ' disabled' : ''}>${icon('bin')}</button>
            <button class="btn sm icon" type="button" data-act="inspect" aria-label="Inspect ${esc(r.start)}" title="Raw JSON (i)">${icon('code')}</button>
          </td></tr>`;
      }).join('');
      $('#fo-table').innerHTML = head + `<tbody>${rows || `<tr><td colspan="12" class="muted" style="padding:18px">No recordings match${recs.length ? ' the filter' : ''}.</td></tr>`}</tbody>`;
      $('#fo-foot').textContent = `${shown.length} shown of ${total} · sort: ${f.sort.key} ${f.sort.dir > 0 ? '↑' : '↓'} · j/k move · x select · Enter play · i inspect`;
      drawBulk();
    }
    function drawBulk() {
      const sel = recs.filter((r) => f.selected.has(r.id));
      const b = sel.reduce((n, r) => n + r.bytes, 0);
      $('#fo-bulk').innerHTML = `<span class="bulk-n"><b class="num">${sel.length}</b> selected${sel.length ? ` · <span class="num">${bytes(b)}</span>` : ''}</span>
        <button class="btn sm" type="button" data-bulk="protect"${sel.length ? '' : ' disabled'}>${icon('lock')}Protect</button>
        <button class="btn sm" type="button" data-bulk="unprotect"${sel.some((r) => r.protected) ? '' : ' disabled'}>${icon('unlock')}Unprotect</button>
        <button class="btn sm danger" type="button" data-bulk="trash"${sel.some((r) => !r.protected) ? '' : ' disabled'}>${icon('bin')}Move to Bin</button>
        <button class="btn sm" type="button" data-bulk="all"${shown.length ? '' : ' disabled'}>Select all</button>
        <button class="btn sm ghost" type="button" data-bulk="clear"${sel.length ? '' : ' disabled'}>Clear</button>`;
    }

    function rowOf(i) { return $('#fo-table')?.querySelector(`tr[data-i="${i}"]`); }
    function moveCursor(i, extend = false) {
      if (!shown.length) return;
      const prev = f.cursor;
      f.cursor = Math.max(0, Math.min(shown.length - 1, i));
      if (extend) {
        if (f.anchor === null) f.anchor = prev;
        const [a, b] = [Math.min(f.anchor, f.cursor), Math.max(f.anchor, f.cursor)];
        for (let k = a; k <= b; k++) f.selected.add(shown[k].id);
        drawTable();
      } else {
        f.anchor = null;
        rowOf(prev)?.classList.remove('cur');
        rowOf(f.cursor)?.classList.add('cur');
      }
      rowOf(f.cursor)?.scrollIntoView({ block: 'nearest' });
    }
    function toggle(id, on) {
      if (on ?? !f.selected.has(id)) f.selected.add(id); else f.selected.delete(id);
    }

    $('#fo-table').addEventListener('click', (e) => {
      if (e.target.closest('label.cbl') && !e.target.matches('input')) return;
      const s = e.target.closest('[data-sort]');
      if (s) {
        const k = s.dataset.sort;
        f.sort = f.sort.key === k ? { key: k, dir: -f.sort.dir } : { key: k, dir: k === 'start' ? -1 : -1 };
        store.set('fo:sort', f.sort);
        drawTable();
        return;
      }
      if (e.target.id === 'fo-all') {
        const on = e.target.checked;
        shown.forEach((r) => toggle(r.id, on));
        drawTable();
        return;
      }
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const r = recs.find((x) => x.id === tr.dataset.id);
      f.cursor = Number(tr.dataset.i);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'play') return play(r);
      if (act === 'protect') return protect([r.id], !r.protected);
      if (act === 'trash') return trash([r.id]);
      if (act === 'inspect') return inspect(r);
      if (e.target.matches('input[type=checkbox]')) {
        if (e.shiftKey && f.anchor !== null) {
          const [a, b] = [Math.min(f.anchor, f.cursor), Math.max(f.anchor, f.cursor)];
          for (let k = a; k <= b; k++) f.selected.add(shown[k].id);
        } else toggle(r.id, e.target.checked);
        f.anchor = f.cursor;
        drawTable();
        return;
      }
      if (e.target.closest('td.thumbc, td')) {
        // a click on the row moves the cursor; on touch it selects
        if (matchMedia('(pointer: coarse)').matches) toggle(r.id);
        drawTable();
      }
      return undefined;
    });
    $('#fo-table').addEventListener('dblclick', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr && !e.target.closest('button, input')) play(recs.find((x) => x.id === tr.dataset.id));
    });
    $('#fo-bulk').addEventListener('click', (e) => {
      const b = e.target.closest('[data-bulk]')?.dataset.bulk;
      if (!b) return;
      const ids = [...f.selected];
      if (b === 'protect') protect(ids, true);
      if (b === 'unprotect') protect(ids, false);
      if (b === 'trash') trash(ids);
      if (b === 'all') { shown.forEach((r) => f.selected.add(r.id)); drawTable(); }
      if (b === 'clear') { f.selected.clear(); drawTable(); }
    });

    // ---------- actions ----------
    function play(r) {
      if (r) go(`#/viewer?rec=${encodeURIComponent(r.id)}`);
    }
    async function protect(ids, on) {
      if (!ids.length) return;
      await busy(null, async () => {
        await api(`/api/vehicles/${encodeURIComponent(v.id)}/protect`, { body: { ids, protected: on } });
        toast(on ? `Protected ${plural(ids.length, 'recording')}: policies and the Recycle Bin skip ${ids.length === 1 ? 'it' : 'them'}.` : 'Protection removed.');
      });
      await loadRecs();
    }
    async function trash(ids) {
      const list = recs.filter((r) => ids.includes(r.id));
      const movable = list.filter((r) => !r.protected);
      if (!movable.length) { toast('Protected recordings stay where they are.', 'bad'); return; }
      const b = movable.reduce((n, r) => n + r.bytes, 0);
      const ok = await confirmDialog({
        title: `Move ${plural(movable.length, 'recording')} to the Recycle Bin?`,
        body: `<p><b class="num">${bytes(b)}</b> moves to the Recycle Bin on the same share. Restore it any time; nothing is deleted until you empty the bin.</p>${list.length > movable.length ? `<p class="muted">${list.length - movable.length} protected recording(s) are skipped.</p>` : ''}`,
        ok: 'Move to Bin', danger: true
      });
      if (!ok) return;
      await busy(null, async () => {
        const out = await api(`/api/vehicles/${encodeURIComponent(v.id)}/trash`, { body: { ids: movable.map((r) => r.id) } });
        const why = out.skipped?.length ? ` ${out.skipped.length} skipped (${[...new Set(out.skipped.map((s) => s.reason))].join(', ')}).` : '';
        toast(`${plural(out.moved.length, 'recording')} moved to the Recycle Bin (${bytes(out.bytes)}).${why}`, out.skipped?.length && !out.moved.length ? 'bad' : 'ok');
        movable.forEach((r) => f.selected.delete(r.id));
      });
      await Promise.all([loadRecs(), loadDays()]);
    }
    async function inspect(r) {
      const d = drawer({ title: `Recording ${r.start}`, wide: true, html: '<div class="loading"><i></i><i></i><i></i></div>' });
      let detail;
      try {
        detail = await api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(r.id)}`);
      } catch (err) {
        d.body.innerHTML = `<p class="bad-text">${esc(err.message)}</p><h3>List entry</h3><pre class="json">${jsonHtml(r)}</pre>`;
        return;
      }
      const ev = detail.event;
      d.body.innerHTML = `
        <div class="tabs" role="tablist">
          <button role="tab" type="button" data-tab="sum" aria-selected="true" class="on">Summary</button>
          <button role="tab" type="button" data-tab="files" aria-selected="false">Files (${detail.files.length})</button>
          <button role="tab" type="button" data-tab="json" aria-selected="false">Raw JSON</button>
        </div>
        <div data-panel="sum">
          ${r.thumbRel || r.frontRel ? `<img class="insp-thumb" alt="Thumbnail" src="/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(r.id)}/thumbnail">` : ''}
          <dl class="kv">
            <dt>id</dt><dd class="mono">${esc(detail.id)}</dd><dt>type</dt><dd>${esc(detail.type)} · ${esc(detail.category)}</dd>
            <dt>start → end</dt><dd class="mono">${esc(detail.start)} → ${esc(detail.end)}</dd><dt>event at</dt><dd class="mono">${esc(detail.eventAt || '—')}</dd>
            <dt>cameras</dt><dd>${esc(detail.cameras.map((c) => CAMERA_LABEL[c] || c).join(', '))}</dd><dt>size</dt><dd class="num">${bytes(detail.bytes)} · ${detail.fileCount} files · ${detail.clipCount} clips</dd>
            <dt>encoded</dt><dd class="num">${detail.encoded?.encoded ?? 0}/${detail.encoded?.clips ?? 0} clips ${esc((detail.encoded?.codecs || []).map((c) => CODEC[c] || c).join(', '))}</dd>
            <dt>protected</dt><dd>${detail.protected ? 'yes' : 'no'}</dd><dt>folder</dt><dd class="mono small wrap">${esc(detail.folderPath)}</dd>
            ${ev ? `<dt>event</dt><dd>${esc([humanize(ev.reason), ev.city, ev.street].filter(Boolean).join(' · '))}${ev.est_lat ? `<div class="mono small">${esc(ev.est_lat)}, ${esc(ev.est_lon)}</div>` : ''}</dd>` : ''}
          </dl>
          <div class="row-actions"><button class="btn primary" type="button" data-i-play>${icon('play')}Play</button><button class="btn" type="button" data-i-prot>${icon(detail.protected ? 'unlock' : 'lock')}${detail.protected ? 'Unprotect' : 'Protect'}</button><button class="btn danger" type="button" data-i-trash${detail.protected ? ' disabled' : ''}>${icon('bin')}Move to Bin</button></div>
        </div>
        <div data-panel="files" hidden><div class="tscroll"><table class="dtable"><thead><tr><th>file</th><th>codec</th><th class="r">size</th><th></th></tr></thead><tbody>
          ${detail.files.map((x) => `<tr><td class="mono small wrap">${esc(x.rel.split('/').pop())}</td><td>${'codec' in x ? (x.codec ? `<span class="tag ${x.codec === 'h264' ? 'plain' : 'enc'}">${esc(CODEC[x.codec] || x.codec)}</span>` : '<span class="faint">checking</span>') : '<span class="faint">asset</span>'}</td><td class="r num">${bytes(x.size)}</td><td class="r"><a class="btn sm" href="/api/media?path=${encodeURIComponent(x.path)}" download>${icon('download')}<span class="sr-only">Download ${esc(x.rel)}</span></a></td></tr>`).join('')}
        </tbody></table></div></div>
        <div data-panel="json" hidden><div class="row-actions"><button class="btn sm" type="button" data-copy>${icon('copy')}Copy JSON</button></div><pre class="json" tabindex="0">${jsonHtml(detail)}</pre></div>`;
      const tabs = d.body.querySelectorAll('[data-tab]');
      tabs.forEach((t) => {
        t.onclick = () => {
          tabs.forEach((x) => { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', String(x === t)); });
          d.body.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
        };
      });
      d.body.querySelector('[data-i-play]').onclick = () => { d.close(); play(r); };
      d.body.querySelector('[data-i-prot]').onclick = () => { d.close(); protect([r.id], !detail.protected); };
      d.body.querySelector('[data-i-trash]').onclick = () => { d.close(); trash([r.id]); };
      d.body.querySelector('[data-copy]').onclick = async () => {
        try { await navigator.clipboard.writeText(JSON.stringify(detail, null, 2)); toast('Copied.'); } catch { toast('The browser did not allow copying.', 'bad'); }
      };
    }

    // ---------- filters ----------
    wireSeg(el, 'cat', (c) => { f.category = c; store.set('fo:cat', c); loadDays(); loadRecs(); });
    wireSeg(el, 'conv', (c) => { f.conv = c; store.set('fo:conv', c); drawTable(); });
    $('#fo-prot').onchange = (e) => { f.prot = e.target.checked; loadRecs(); };
    $('#fo-text').addEventListener('input', debounce((e) => { f.text = e.target.value; f.cursor = 0; drawTable(); }, 100));
    $('#fo-scan').onclick = (e) => busy(e.currentTarget, async () => { await api(`/api/vehicles/${encodeURIComponent(v.id)}/scan`, { body: {} }); toast('Refreshing the inventory… Jobs shows the progress.'); });

    await Promise.all([loadDays(), loadRecs()]);

    return {
      unmount() { alive = false; },
      onTopics(topics) {
        if (topics.includes('inventory') || topics.includes('bin')) { loadDays(); loadRecs(); }
      },
      onKey(e) {
        const r = shown[f.cursor];
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { shown.forEach((x) => f.selected.add(x.id)); drawTable(); return true; }
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        switch (e.key) {
          case 'j': case 'ArrowDown': moveCursor(f.cursor + 1, e.shiftKey); return true;
          case 'k': case 'ArrowUp': moveCursor(f.cursor - 1, e.shiftKey); return true;
          case 'J': moveCursor(f.cursor + 1, true); return true;
          case 'K': moveCursor(f.cursor - 1, true); return true;
          case 'Home': moveCursor(0); return true;
          case 'End': moveCursor(shown.length - 1); return true;
          case 'x': case ' ': if (r) { toggle(r.id); f.anchor = f.cursor; drawTable(); } return true;
          case 'Enter': case 'o': if (r) play(r); return true;
          case 'i': if (r) inspect(r); return true;
          case 'p': if (f.selected.size) protect([...f.selected], !recs.filter((x) => f.selected.has(x.id)).every((x) => x.protected)); else if (r) protect([r.id], !r.protected); return true;
          case 'Delete': case 'Backspace': case '#': if (f.selected.size) trash([...f.selected]); else if (r) trash([r.id]); return true;
          case 'Escape': if (f.selected.size) { f.selected.clear(); drawTable(); return true; } return false;
          default: return false;
        }
      },
      commands: () => [
        { group: 'Footage', label: 'Select every recording shown', icon: 'check', run: () => { shown.forEach((x) => f.selected.add(x.id)); drawTable(); } },
        { group: 'Footage', label: 'Move selection to the Recycle Bin', icon: 'bin', run: () => trash([...f.selected]) },
        { group: 'Footage', label: 'Protect selection', icon: 'lock', run: () => protect([...f.selected], true) },
        { group: 'Footage', label: 'Show not-converted only', icon: 'encoder', run: () => el.querySelector('[data-seg="conv"] button[data-v="no"]')?.click() },
        ...(days?.days || []).slice(0, 10).map((d) => ({ group: 'Footage day', label: `Show ${d.day}`, icon: 'footage', run: () => pickDay(d.day) }))
      ]
    };
  }
};
