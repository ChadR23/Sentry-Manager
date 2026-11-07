// The Viewer's Export panel, shared by the built-in Viewer and the interface
// packs: mark a start and an end at the playhead, see the clips that stretch
// covers, pick all cameras or one, and render one MP4 on the server
// (server/exporter.js), then download it. It floats over the page, so the
// player stays usable while it is open. A pack colours it with CSS variables:
//
//   --xp-bg, --xp-fg, --xp-muted, --xp-line, --xp-field
//   --xp-accent, --xp-accent-fg, --xp-radius, --xp-font
//
//   const xp = createExportPanel({
//     vehicleId: () => id,
//     clips: () => [{ key, files: { front: path, ... }, len, cat }],  // playing order
//     position: () => ({ index, t }),   // the clip on screen and seconds into it
//     units: () => 'mph' | 'kmh',
//   });
//   button.onclick = () => xp.toggle();

const CAMS = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];
const CAM_NAME = { front: 'Front', back: 'Rear', left_repeater: 'Left repeater', right_repeater: 'Right repeater', left_pillar: 'Left pillar', right_pillar: 'Right pillar' };
const MAX_SECONDS = 60 * 60;

const CSS = `
.xp{position:fixed;inset:auto 16px 16px auto;z-index:2147483000;width:min(400px,calc(100vw - 32px));max-height:min(80vh,680px);
  margin:0;padding:0;display:flex;flex-direction:column;overflow:hidden;
  background:var(--xp-bg,#141922);color:var(--xp-fg,#e8ecf2);border:1px solid var(--xp-line,rgba(255,255,255,.14));
  border-radius:var(--xp-radius,14px);box-shadow:0 18px 50px rgba(0,0,0,.45);font:14px/1.4 var(--xp-font,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif)}
.xp[hidden]{display:none}
.xp *{box-sizing:border-box}
.xp-h{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid var(--xp-line,rgba(255,255,255,.14))}
.xp-h b{font-size:15px}
.xp-b{padding:12px 14px;overflow:auto;display:grid;gap:12px}
.xp-row{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center}
.xp-k{color:var(--xp-muted,#9aa4b2);font-size:12.5px;min-width:42px}
.xp-v{font-variant-numeric:tabular-nums;font-weight:600;min-width:0;overflow-wrap:anywhere}
.xp button,.xp select,.xp a.xp-btn{font:inherit;font-size:13px;min-height:36px;padding:6px 12px;border-radius:calc(var(--xp-radius,14px) * .6);
  border:1px solid var(--xp-line,rgba(255,255,255,.18));background:var(--xp-field,rgba(255,255,255,.06));color:inherit;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.xp button:disabled{opacity:.5;cursor:not-allowed}
.xp button:focus-visible,.xp select:focus-visible,.xp a:focus-visible{outline:2px solid var(--xp-accent,#5ee9a0);outline-offset:2px}
.xp .xp-go,.xp a.xp-go{background:var(--xp-accent,#5ee9a0);color:var(--xp-accent-fg,#06120c);border-color:transparent;font-weight:700}
.xp .xp-x{min-height:32px;width:32px;padding:0}
.xp-sel{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.xp-sel label{display:grid;gap:4px;font-size:12.5px;color:var(--xp-muted,#9aa4b2)}
.xp-sel select{width:100%;color:var(--xp-fg,#e8ecf2)}
.xp-priv{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.35;color:var(--xp-muted,#9aa4b2);cursor:pointer}
.xp-priv input{margin:2px 0 0;flex:none}
.xp-sel option{color:#111;background:#fff}
.xp-sum{font-size:12.5px;color:var(--xp-muted,#9aa4b2)}
.xp-sum b{color:var(--xp-fg,#e8ecf2)}
.xp-list{list-style:none;margin:0;padding:0;display:grid;gap:4px;max-height:220px;overflow:auto;border:1px solid var(--xp-line,rgba(255,255,255,.14));border-radius:calc(var(--xp-radius,14px) * .6);padding:6px}
.xp-list li{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;font-size:12.5px;padding:4px 6px;border-radius:6px}
.xp-list li:nth-child(odd){background:var(--xp-field,rgba(255,255,255,.04))}
.xp-list .n{color:var(--xp-muted,#9aa4b2);font-variant-numeric:tabular-nums}
.xp-list .t{font-variant-numeric:tabular-nums;font-weight:600}
.xp-list .p{color:var(--xp-muted,#9aa4b2);font-variant-numeric:tabular-nums;text-align:right}
.xp-bar{height:8px;border-radius:99px;background:var(--xp-field,rgba(255,255,255,.08));overflow:hidden}
.xp-bar i{display:block;height:100%;width:0;background:var(--xp-accent,#5ee9a0);transition:width .4s}
.xp-err{color:#ff8f8f;font-size:13px}
.xp-f{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;padding:12px 14px;border-top:1px solid var(--xp-line,rgba(255,255,255,.14))}
.xp [hidden]{display:none!important}
@media (max-width:600px){.xp{inset:auto 8px 8px 8px;width:auto}}
.xp .xp-again{background:var(--xp-field,rgba(255,255,255,.06));color:inherit;border-color:var(--xp-line,rgba(255,255,255,.18));font-weight:400}
`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fin = (n) => typeof n === 'number' && Number.isFinite(n);
/** "YYYY-MM-DD_HH-MM-SS" from a clip key or "YYYY-MM-DD HH:MM:SS". */
function keyOf(k) {
  const m = /(\d{4}-\d{2}-\d{2})[ _T](\d{2})[:-](\d{2})[:-](\d{2})/.exec(String(k || ''));
  return m ? `${m[1]}_${m[2]}-${m[3]}-${m[4]}` : null;
}
function wall(key, sec, h24) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(key || '');
  if (!m) return '';
  const t = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + Math.floor(sec) * 1000);
  const two = (n) => String(n).padStart(2, '0');
  const h = t.getUTCHours();
  const clock = h24 ? `${two(h)}:${two(t.getUTCMinutes())}:${two(t.getUTCSeconds())}` : `${h % 12 || 12}:${two(t.getUTCMinutes())}:${two(t.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
  return { date: `${t.getUTCFullYear()}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())}`, clock };
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const len = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);
const lenOf = (c) => (fin(c?.len) && c.len > 0 ? c.len : 60);

function addCss() {
  if (document.getElementById('xp-css')) return;
  const style = document.createElement('style');
  style.id = 'xp-css';
  style.textContent = CSS;
  document.head.appendChild(style);
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: { 'X-Requested-With': 'sentry-six-manager', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

let clock24 = null;
async function useClock24() {
  if (clock24 === null) {
    clock24 = false;
    try { clock24 = Boolean((await call('GET', '/api/settings')).appearance?.clock24); } catch { /* 12-hour */ }
  }
  return clock24;
}

/**
 * The parts of each clip from start to end, in playing order.
 * start/end: { index, t }; clips: the playlist.
 */
export function partsBetween(clips, start, end) {
  let a = start;
  let b = end;
  if (b.index < a.index || (b.index === a.index && b.t < a.t)) [a, b] = [b, a];
  const out = [];
  for (let i = a.index; i <= b.index; i++) {
    const c = clips[i];
    if (!c) continue;
    const from = i === a.index ? Math.max(0, a.t) : 0;
    const to = i === b.index ? Math.min(lenOf(c), b.t) : lenOf(c);
    if (to - from >= 0.5) out.push({ i, clip: c, from, to });
  }
  return out;
}

export function createExportPanel({ vehicleId, clips, position, units = () => 'mph', toast = null }) {
  addCss();
  // a floating panel, not a <dialog>: the pages' keyboard shortcuts pause
  // while a dialog is open, and the player should stay usable beside this
  const el = document.createElement('section');
  el.className = 'xp';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'false');
  el.setAttribute('aria-label', 'Export video');
  el.innerHTML = `
    <div class="xp-h"><b>Export video</b><button type="button" class="xp-x" data-x="close" aria-label="Close">✕</button></div>
    <div class="xp-b">
      <p class="xp-sum" style="margin:0">Play or scrub to the moment, then set the start and the end here. The cameras are rendered into one video on the server, with the date, time and speed.</p>
      <div class="xp-row"><span class="xp-k">Start</span><span class="xp-v" data-x="start">—</span><button type="button" data-x="set-start">Set start here</button></div>
      <div class="xp-row"><span class="xp-k">End</span><span class="xp-v" data-x="end">—</span><button type="button" data-x="set-end">Set end here</button></div>
      <p class="xp-sum" data-x="sum" style="margin:0"></p>
      <ol class="xp-list" data-x="list" aria-label="Clips in this export"></ol>
      <div class="xp-sel">
        <label>Cameras<select data-x="camera"></select></label>
        <label>Speed in<select data-x="units"><option value="mph">mph</option><option value="kmh">km/h</option></select></label>
      </div>
      <label class="xp-priv"><input type="checkbox" data-x="privacy"> Privacy: leave out the speed and the file's hidden details (the date and time stay)</label>
      <div data-x="run" hidden>
        <p class="xp-sum" data-x="state" style="margin:0 0 6px"></p>
        <div class="xp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Export progress"><i data-x="bar"></i></div>
      </div>
      <p class="xp-err" data-x="err" role="alert" hidden></p>
    </div>
    <div class="xp-f">
      <button type="button" data-x="cancel" hidden>Cancel export</button>
      <a class="xp-btn xp-go" data-x="download" hidden download>Download video</a>
      <button type="button" class="xp-go" data-x="go">Export video</button>
    </div>`;
  document.body.appendChild(el);
  const $ = (k) => el.querySelector(`[data-x="${k}"]`);
  let start = null;
  let end = null;
  let job = null;
  let poll = 0;
  let h24 = false;

  const list = () => (clips() || []).map((c) => ({ ...c, key: keyOf(c.key) })).filter((c) => c.key);
  const here = () => {
    const p = position() || {};
    return { index: Math.max(0, p.index | 0), t: fin(p.t) ? p.t : 0 };
  };
  function label(p, all) {
    const c = all[p.index];
    if (!c) return '—';
    const w = wall(c.key, p.t, h24);
    return `${w.clock} · ${w.date}`;
  }
  function draw() {
    const all = list();
    $('start').textContent = start ? label(start, all) : '—';
    $('end').textContent = end ? label(end, all) : '—';
    const parts = start && end ? partsBetween(all, start, end) : [];
    const secs = parts.reduce((n, p) => n + (p.to - p.from), 0);
    // the cameras these clips have
    const have = CAMS.filter((cam) => parts.some((p) => p.clip.files?.[cam]));
    const sel = $('camera');
    const was = sel.value || 'grid';
    sel.innerHTML = `<option value="grid">All cameras (grid)</option>${have.map((c) => `<option value="${c}">${CAM_NAME[c]} only</option>`).join('')}`;
    sel.value = [...sel.options].some((o) => o.value === was) ? was : 'grid';
    $('sum').innerHTML = parts.length
      ? `<b>${len(secs)}</b> from <b>${parts.length}</b> clip${parts.length === 1 ? '' : 's'}${secs > MAX_SECONDS ? ' — too long: an export can be up to 60 minutes' : ''}`
      : 'Set a start and an end to see the clips it covers.';
    $('list').hidden = !parts.length;
    $('list').innerHTML = parts.map((p, k) => {
      const w = wall(p.clip.key, 0, h24);
      const cams = CAMS.filter((c) => p.clip.files?.[c]).length;
      const whole = p.from < 0.5 && p.to >= lenOf(p.clip) - 0.5;
      return `<li><span class="n">${k + 1}</span><span><span class="t">${esc(w.clock)}</span> ${p.clip.cat ? `· ${esc(p.clip.cat)} ` : ''}· ${cams} camera${cams === 1 ? '' : 's'}</span><span class="p">${whole ? 'whole clip' : `${mmss(p.from)}–${mmss(p.to)}`}</span></li>`;
    }).join('');
    const busy = job && ['waiting', 'running'].includes(job.state);
    $('go').disabled = busy || !parts.length || secs > MAX_SECONDS;
    // once a video is ready, Download is the main button
    const ready = job?.state === 'done';
    $('go').classList.toggle('xp-again', ready);
    $('go').textContent = ready ? 'Export again' : 'Export video';
    $('set-start').disabled = busy;
    $('set-end').disabled = busy;
  }
  function showJob() {
    const run = $('run');
    if (!job) { run.hidden = true; $('cancel').hidden = true; $('download').hidden = true; return; }
    run.hidden = false;
    const pct = Math.round((job.progress || 0) * 100);
    $('bar').style.width = `${pct}%`;
    el.querySelector('[role=progressbar]').setAttribute('aria-valuenow', String(pct));
    const words = {
      waiting: 'Waiting for the export before it…',
      running: `Rendering… ${pct}% (${mmss(job.done || 0)} of ${mmss(job.seconds || 0)})`,
      done: `Ready: ${len(job.seconds)}, ${(job.bytes / 1e6).toFixed(1)} MB. It is kept on the server for a day.${job.notes?.length ? ` Note: ${job.notes.join('; ')}.` : ''}`,
      failed: `The export failed: ${job.error || 'unknown error'}`,
      cancelled: 'Cancelled.',
      expired: 'This export was removed after a day.'
    };
    $('state').textContent = words[job.state] || job.state;
    $('cancel').hidden = !['waiting', 'running'].includes(job.state);
    const dl = $('download');
    dl.hidden = job.state !== 'done';
    if (job.state === 'done') {
      dl.href = `/api/exports/${encodeURIComponent(job.id)}/file`;
      dl.setAttribute('download', job.name || 'export.mp4');
    }
    draw();
  }
  async function follow() {
    clearTimeout(poll);
    if (!job || !['waiting', 'running'].includes(job.state)) return;
    try { job = await call('GET', `/api/exports/${encodeURIComponent(job.id)}`); } catch { /* keep trying */ }
    showJob();
    if (job.state === 'done') toast?.('Your export is ready to download.');
    poll = setTimeout(follow, 1500);
  }
  function err(text) {
    $('err').textContent = text || '';
    $('err').hidden = !text;
  }

  el.addEventListener('click', async (e) => {
    const k = e.target.closest('[data-x]')?.dataset.x;
    if (k === 'close') close();
    else if (k === 'set-start') {
      start = here();
      if (!end || partsBetween(list(), start, end).length === 0) {
        // a first start: end 30 seconds on, so the list shows at once
        const all = list();
        let { index, t } = start;
        t += 30;
        while (all[index] && t > lenOf(all[index]) && index < all.length - 1) { t -= lenOf(all[index]); index += 1; }
        end = { index, t: Math.min(t, lenOf(all[index])) };
      }
      err('');
      draw();
    } else if (k === 'set-end') {
      end = here();
      if (!start) start = { index: end.index, t: Math.max(0, end.t - 30) };
      err('');
      draw();
    } else if (k === 'go') {
      const all = list();
      const parts = partsBetween(all, start, end);
      err('');
      $('go').disabled = true;
      try {
        const vid = vehicleId();
        job = await call('POST', vid ? `/api/vehicles/${encodeURIComponent(vid)}/exports` : '/api/exports', {
          camera: $('camera').value, units: $('units').value, privacy: $('privacy').checked,
          clips: parts.map((p) => ({ key: p.clip.key, files: p.clip.files, from: Number(p.from.toFixed(3)), to: Number(p.to.toFixed(3)) }))
        });
        showJob();
        follow();
      } catch (ex) {
        err(ex.message);
        draw();
      }
    } else if (k === 'cancel' && job) {
      try { await call('DELETE', `/api/exports/${encodeURIComponent(job.id)}`); } catch (ex) { err(ex.message); }
      job = { ...job, state: 'cancelled' };
      showJob();
    }
  });
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-x="privacy"]')) { try { localStorage.setItem('sentry-export-privacy', e.target.checked ? '1' : '0'); } catch { /* this time only */ } }
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    // keys typed in the panel are the panel's, not the player's shortcuts
    else if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  });

  async function open() {
    h24 = await useClock24();
    $('units').value = units() === 'kmh' ? 'kmh' : 'mph';
    // the privacy choice is remembered in this browser (off at first)
    try { $('privacy').checked = localStorage.getItem('sentry-export-privacy') === '1'; } catch { /* off */ }
    if (!start) {
      // a first look: from here, 30 seconds on
      el.querySelector('[data-x="set-start"]').click();
    }
    draw();
    showJob();
    el.hidden = false;
  }
  function close() {
    el.hidden = true;
  }
  return {
    open,
    close,
    toggle() { return el.hidden ? open() : close(); },
    isOpen: () => !el.hidden,
    /** The playlist changed (another day or recording): start over. */
    reset() { start = null; end = null; if (!job || !['waiting', 'running'].includes(job.state)) job = null; draw(); showJob(); },
    destroy() { clearTimeout(poll); el.remove(); }
  };
}
