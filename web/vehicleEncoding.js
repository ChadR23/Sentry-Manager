// Encoding per vehicle: each vehicle's saved encoding settings in plain words,
// with an editor. Shared by the built-in interface and the example packs
// (a classic script: <script src="/web/vehicleEncoding.js"> or, from a
// module, import '/web/vehicleEncoding.js'), so every interface describes a
// vehicle's settings the same way. It exposes window.SentryVehicleEncoding.
//
// Where the settings live: a vehicle with automatic conversion on keeps them
// as its automatic settings (getAuto: settings.configs); one saved without
// automatic conversion is in getAuto's `saved`. Both are saved through the
// converter's own channels (setAuto, saveVehicle), which validate them like a
// manual start: replacing originals needs the confirmation tick, a separate
// folder must not overlap the footage, and so on.
(function (root) {
  'use strict';

  const CODECS = [['h265', 'H.265'], ['av1', 'AV1']];
  const SIZE_PROFILES = [['conservative', 'High quality', 5], ['balanced', 'Balanced', 20], ['aggressive', 'Smaller', 50]];
  const QUALITY_LEVELS = [['high', 'High — keeps the most detail'], ['balanced', 'Balanced'], ['small', 'Small — smallest files']];
  const VERIFY = [['quick', 'Quick', 'checks streams, length, frames and telemetry'], ['full', 'Full', 'also decodes every frame (slowest)'], ['off', 'Off', 'no checks (fastest)']];
  const GROUPS = [['RecentClips', 'Recent drives'], ['SavedClips', 'Saved clips'], ['SentryClips', 'Sentry events']];
  const DEFAULT_ORDER = ['SavedClips', 'SentryClips', 'RecentClips'];
  const INTERVALS = [[15, 'every 15 minutes'], [30, 'every 30 minutes'], [60, 'every hour'], [180, 'every 3 hours'], [360, 'every 6 hours'], [720, 'every 12 hours'], [1440, 'once a day']];
  const ERRORS = {
    REPLACEMENT_CONFIRMATION_REQUIRED: 'Tick the box to confirm that the originals may be replaced.',
    REPLACEMENT_UNAVAILABLE: 'This share can’t replace originals (it is read-only or does not allow it). Choose a separate folder.',
    PATH_NOT_ALLOWED: 'That folder is outside the vehicle shares and output folders.',
    PATH_OVERLAP: 'The separate folder can’t be inside the footage (or the footage inside it).',
    INVALID_PATH: 'That folder can’t be used.',
    INVALID_BITRATE: 'Enter a bitrate from 0.25 to 100 Mbps.',
    INVALID_GROUP_SELECTION: 'Pick at least one kind of clip.',
    INVALID_CONCURRENCY: 'Clips at once: a number from 1 to 64.',
    INVALID_LANES: 'The saved devices are not valid any more: set them again in the Encoder.',
    INVALID_AUTO_WINDOW: 'The time window needs a start and an end that differ.',
    SOURCE_UNAVAILABLE: 'The vehicle’s footage can’t be reached right now (is the share connected?).',
    AUTO_UNAVAILABLE: 'The Encoder is still starting. Try again in a moment.',
    CONVERTER_STARTING: 'The Encoder is still starting. Try again in a moment.',
    TOO_MANY_AUTO_SOURCES: 'Too many vehicles have saved settings.'
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const label = (list, id) => (list.find((x) => x[0] === id) || [])[1];
  const errorText = (err) => ERRORS[err?.code] || err?.message || 'That didn’t work.';
  const hour = (h) => `${String(h).padStart(2, '0')}:00`;

  // ---------- plain words ----------

  function codecWords(config) { return label(CODECS, config.codec) || String(config.codec || '—'); }
  function sizeWords(config, { short = false } = {}) {
    if (config.profileId === 'custom') {
      const mbps = Number(config.bitrateKbps) / 1000;
      return short ? `${mbps} Mbps` : `Custom bitrate: ${mbps} Mbps`;
    }
    if (config.profileId === 'quality') {
      const level = (label(QUALITY_LEVELS, config.qualityLevel) || 'Balanced').split(' — ')[0];
      return short ? `Quality ${level}` : `Quality level: ${level} (size varies by scene)`;
    }
    const p = SIZE_PROFILES.find((x) => x[0] === config.profileId);
    if (!p) return String(config.profileId || '—');
    return short ? p[1] : `${p[1]} — about ${p[2]}% smaller`;
  }
  const hasTarget = (config) => !['custom', 'quality'].includes(config.profileId);
  function outputWords(config, { short = false } = {}) {
    if (config.outputMode === 'replace') return short ? 'Replace' : 'Replace originals (each original is backed up until its copy is checked)';
    return short ? 'Separate' : `Separate folder: ${config.destinationRoot || '—'}`;
  }
  function verifyWords(config, { short = false } = {}) {
    // replacing originals always uses at least Quick
    const mode = config.outputMode === 'replace' && config.verifyMode === 'off' ? 'quick' : (config.verifyMode || 'full');
    const v = VERIFY.find((x) => x[0] === mode) || VERIFY[1];
    return short ? v[1] : `${v[1]} — ${v[2]}`;
  }
  function groupsWords(config) {
    const included = new Set(config.includedGroups || []);
    const order = Array.isArray(config.groupOrder) && config.groupOrder.length === 3 ? config.groupOrder : DEFAULT_ORDER;
    const names = order.filter((g) => included.has(g)).map((g) => label(GROUPS, g));
    return names.length ? names.join(' → ') : '—';
  }
  function deviceName(id, devices) {
    const d = (devices || []).find((x) => x && x.id === id);
    if (d?.name) return d.name;
    if (id === 'cpu') return 'CPU';
    if (String(id).startsWith('node:')) return `Node ${String(id).slice(5).split('@')[0]}`;
    return String(id);
  }
  function devicesWords(config, devices) {
    if (Array.isArray(config.lanes) && config.lanes.length) {
      return config.lanes.map((l) => `${deviceName(l.device, devices)}: ${l.concurrency} at once`).join(' · ');
    }
    const n = Number(config.concurrency) || 1;
    return `This server’s default device, ${n} clip${n === 1 ? '' : 's'} at once`;
  }
  function windowWords(settings) {
    const w = settings?.window;
    if (!w) return 'any time';
    if (w.follow === 'off-peak') return 'only when electricity is off-peak';
    return `only from ${hour(w.startHour)} to ${hour(w.endHour)}`;
  }
  function autoWords(entry, settings) {
    if (!entry?.automatic) return 'Off — converts only when you start a run in the Encoder';
    return `On — checks for new clips ${label(INTERVALS, settings?.intervalMinutes) || 'every hour'}, ${windowWords(settings)}`;
  }

  /** [label, words] rows for one vehicle's saved settings. */
  function describe(entry, settings, devices) {
    const c = entry.config;
    const rows = [
      ['Codec', codecWords(c)],
      ['Size', sizeWords(c)]
    ];
    if (hasTarget(c)) rows.push(['Keep clips that miss the target', c.keepOffTarget === true ? 'On — kept converted even when not smaller enough' : 'Off — the original stays when its copy misses the target']);
    else rows.push(['Always convert', c.keepLarger === true ? 'On — every clip ends up converted, even the few that come out larger' : 'Off — a clip that still isn’t smaller stays as it was']);
    rows.push(['Output', outputWords(c)], ['Verify', verifyWords(c)], ['Clip groups and order', groupsWords(c)],
      ['Devices', devicesWords(c, devices)], ['Automatic conversion', autoWords(entry, settings)]);
    return rows;
  }
  /** "H.265 · Balanced · Replace · Quick" */
  function summary(config) {
    return [codecWords(config), sizeWords(config, { short: true }), outputWords(config, { short: true }), verifyWords(config, { short: true })].join(' · ');
  }
  /** A folder's saved settings: { config, automatic } or null. */
  function savedFor(state, folder) {
    const auto = (state?.settings?.configs || []).find((c) => c.sourceRoot === folder);
    if (auto) return { config: auto, automatic: true };
    const saved = (state?.saved || []).find((c) => c.sourceRoot === folder);
    return saved ? { config: saved, automatic: false } : null;
  }
  const folderOf = (v) => v.studioRoot || v.root;

  // ---------- the server ----------

  async function invoke(name, payload) {
    const res = await fetch(`/api/converter/invoke/${name}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager' },
      body: payload === undefined ? '' : JSON.stringify(payload)
    });
    if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || res.statusText);
    if (!data?.ok) throw Object.assign(new Error(data?.error?.code || 'FAILED'), { code: data?.error?.code });
    return data.value;
  }
  async function vehicles() {
    const res = await fetch('/api/vehicles', { credentials: 'same-origin', headers: { 'X-Requested-With': 'sentry-six-manager' } });
    if (!res.ok) throw new Error('Can’t load the vehicles.');
    return (await res.json()).vehicles || [];
  }

  // What setAuto needs besides one vehicle's settings: the shared schedule.
  function shared(settings, over = {}) {
    const s = settings || {};
    const window = over.window !== undefined ? over.window : (s.window || null);
    return {
      intervalMinutes: over.intervalMinutes || s.intervalMinutes || 60,
      window,
      holdManual: Boolean(window) && s.holdManual === true,
      keepRunning: s.keepRunning === true,
      openAtLogin: s.openAtLogin === true
    };
  }

  /**
   * Save one vehicle. `automatic` on: its automatic settings (setAuto);
   * off: saved only (and its automatic conversion turned off if it was on).
   */
  async function save({ state, folder, config, automatic, schedule, invoke: send = invoke }) {
    const was = savedFor(state, folder);
    if (automatic) return send('setAuto', { enabled: true, ...shared(state?.settings, schedule), config });
    let out = state;
    if (was?.automatic) {
      const others = (state.settings.configs || []).filter((c) => c.sourceRoot !== folder).length;
      out = await send('setAuto', { enabled: others > 0, ...shared(state.settings, schedule), removeSource: folder });
    }
    return send('saveVehicle', { config });
  }

  function defaults(folder, replaceOk) {
    return {
      sourceRoot: folder, destinationRoot: null, codec: 'h265', profileId: 'balanced', networkMode: 'auto',
      outputMode: replaceOk ? 'replace' : 'separate', includedGroups: GROUPS.map((g) => g[0]), groupOrder: [...DEFAULT_ORDER],
      replacementConfirmed: false, concurrency: 5, verifyMode: 'quick'
    };
  }

  // ---------- the page ----------

  const CSS = `
.ve{display:grid;gap:16px;min-width:0}
.ve-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));gap:16px;align-items:start}
.ve-cards>.ve-card{min-width:0;margin:0}
.ve-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.ve-head h2,.ve-head h3{margin:0;font-size:1.1em}
.ve-tag{font-size:.78em;padding:2px 9px;border-radius:999px;border:1px solid currentColor;opacity:.85;white-space:nowrap}
.ve-tag.on{color:#3fb37f}
.ve-rows{display:grid;grid-template-columns:minmax(0,11em) minmax(0,1fr);gap:7px 14px;margin:0}
.ve-rows dt{opacity:.7;font-size:.92em}
.ve-rows dd{margin:0;overflow-wrap:anywhere}
.ve-empty{opacity:.8;margin:6px 0 12px}
.ve-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.ve-form{display:grid;gap:14px}
.ve-form fieldset{border:0;padding:0;margin:0;display:grid;gap:8px;min-width:0}
.ve-form legend{font-weight:600;padding:0;margin-bottom:6px}
.ve-choices{display:flex;flex-wrap:wrap;gap:6px 16px}
.ve-choices label{display:inline-flex;align-items:center;gap:6px}
.ve-form .ve-field{display:grid;gap:4px;min-width:0}
.ve-form .ve-field input,.ve-form .ve-field select{max-width:100%;min-width:0;box-sizing:border-box}
.ve-hint{font-size:.88em;opacity:.75;margin:0}
.ve-order{display:grid;gap:6px;margin:0;padding:0;list-style:none}
.ve-order li{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ve-order li span{flex:1;min-width:8em}
.ve-error{color:#e5484d;margin:0}
.ve-line{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-size:.92em;min-width:0}
.ve-line b{overflow-wrap:anywhere}
@media (max-width:560px){.ve-rows{grid-template-columns:1fr;gap:2px}.ve-rows dd{margin-bottom:8px}}
`;
  function injectCss(doc) {
    if (doc.getElementById('ve-css')) return;
    const style = doc.createElement('style');
    style.id = 've-css';
    style.textContent = CSS;
    doc.head.append(style);
  }

  const DEFAULT_CLASSES = { card: 'card', btn: 'btn', primary: 'btn primary', input: 'input', field: 'field', check: 'check', note: 'note', muted: 'muted' };

  /**
   * Draw the "Encoding per vehicle" view into `el`.
   * opts: classes (the interface's own class names), toast(text, bad),
   * confirm(text) -> Promise<boolean>, encoderHref, edit (a vehicle id to
   * open for editing), onLoadEncoder(vehicle) (optional "Open in Encoder").
   */
  function mount(el, opts = {}) {
    const send = opts.scope?.invoke || invoke;
    injectCss(el.ownerDocument);
    const k = { ...DEFAULT_CLASSES, ...(opts.classes || {}) };
    const toast = opts.toast || (() => {});
    const confirmFn = opts.confirm || ((text) => Promise.resolve(window.confirm(text)));
    let state = null; let cars = []; let devices = []; let replaceOk = false;
    let editing = opts.edit || null; let dead = false; let draft = null;

    async function load() {
      const [vs, st, caps, devs] = await Promise.all([
        vehicles(), send('getAuto'), send('getCapabilities').catch(() => ({})), send('devices').catch(() => ({}))
      ]);
      opts.scope?.check();
      cars = vs; state = st; devices = devs?.devices || []; replaceOk = caps?.replacement === 'available';
    }

    function card(v) {
      const folder = folderOf(v);
      const entry = savedFor(state, folder);
      if (editing === v.id) return editor(v, entry);
      const tag = entry ? (entry.automatic ? '<span class="ve-tag on">Automatic on</span>' : '<span class="ve-tag">Saved · automatic off</span>') : '<span class="ve-tag">Not set up</span>';
      const body = entry
        ? `<dl class="ve-rows">${describe(entry, state.settings, devices).map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}</dl>
          <div class="ve-actions"><button type="button" class="${k.primary}" data-ve-edit="${esc(v.id)}">Edit</button></div>`
        : `<p class="ve-empty">Not set up yet — uses the Encoder’s settings when you start a run.</p>
          <div class="ve-actions"><button type="button" class="${k.primary}" data-ve-edit="${esc(v.id)}">Set up</button></div>`;
      return `<section class="${k.card} ve-card" data-ve-car="${esc(v.id)}"><div class="ve-head"><h2>${esc(v.name)}</h2>${tag}</div>${body}</section>`;
    }

    function editor(v, entry) {
      const folder = folderOf(v);
      const c = draft || (entry ? { ...entry.config } : defaults(folder, replaceOk));
      if (!draft) { draft = c; draft._automatic = Boolean(entry?.automatic); }
      const s = state.settings || {};
      const sizeValue = c.profileId;
      const order = Array.isArray(c.groupOrder) && c.groupOrder.length === 3 ? c.groupOrder : DEFAULT_ORDER;
      const included = new Set(c.includedGroups || []);
      const lanes = Array.isArray(c.lanes) && c.lanes.length;
      const w = s.window;
      const winMode = !w ? 'any' : w.follow === 'off-peak' ? 'off-peak' : 'hours';
      const hours = Array.from({ length: 24 }, (_, h) => h);
      const radio = (name, value, text, checked, extra = '') => `<label class="${k.check}"><input type="radio" name="${name}" value="${esc(value)}"${checked ? ' checked' : ''}${extra}> ${text}</label>`;
      return `<section class="${k.card} ve-card" data-ve-car="${esc(v.id)}"><div class="ve-head"><h2>${esc(v.name)}</h2><span class="ve-tag">Editing</span></div>
        <form class="ve-form" data-ve-form="${esc(v.id)}" novalidate>
          <fieldset><legend>Codec</legend><div class="ve-choices">${CODECS.map(([id, t]) => radio('codec', id, t, c.codec === id)).join('')}</div></fieldset>
          <fieldset><legend>Size</legend>
            <label class="${k.field} ve-field"><span>Size or quality</span><select class="${k.input}" name="profileId">
              ${SIZE_PROFILES.map(([id, t, p]) => `<option value="${id}"${sizeValue === id ? ' selected' : ''}>${t} — about ${p}% smaller</option>`).join('')}
              <option value="quality"${sizeValue === 'quality' ? ' selected' : ''}>Quality level — size varies by scene</option>
              <option value="custom"${sizeValue === 'custom' ? ' selected' : ''}>Custom bitrate</option></select></label>
            <label class="${k.field} ve-field" data-ve-show="quality"${sizeValue === 'quality' ? '' : ' hidden'}><span>Quality level</span><select class="${k.input}" name="qualityLevel">${QUALITY_LEVELS.map(([id, t]) => `<option value="${id}"${(c.qualityLevel || 'balanced') === id ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
            <label class="${k.field} ve-field" data-ve-show="custom"${sizeValue === 'custom' ? '' : ' hidden'}><span>Bitrate (Mbps)</span><input class="${k.input}" type="number" name="bitrate" min="0.25" max="100" step="0.25" inputmode="decimal" value="${c.bitrateKbps ? c.bitrateKbps / 1000 : 8}"></label>
            <label class="${k.check}" data-ve-show="target"${hasTarget(c) ? '' : ' hidden'}><input type="checkbox" name="keepOffTarget"${c.keepOffTarget === true ? ' checked' : ''}> Keep clips that miss the size target (otherwise the original stays)</label>
            <label class="${k.check}" data-ve-show="notarget"${hasTarget(c) ? ' hidden' : ''}><input type="checkbox" name="keepLarger"${c.keepLarger === true ? ' checked' : ''}> Always convert, even if larger (a clip still not smaller after two tries at a lower bitrate is kept converted instead of left as it was)</label>
          </fieldset>
          <fieldset><legend>Output</legend><div class="ve-choices">
            ${radio('outputMode', 'replace', 'Replace originals', c.outputMode === 'replace', replaceOk ? '' : ' disabled')}
            ${radio('outputMode', 'separate', 'Separate folder', c.outputMode !== 'replace')}</div>
            ${replaceOk ? '' : '<p class="ve-hint">This server can’t replace originals on this share.</p>'}
            <label class="${k.field} ve-field" data-ve-show="separate"${c.outputMode === 'replace' ? ' hidden' : ''}><span>Separate folder (on a vehicle share or an output folder)</span><input class="${k.input}" name="destinationRoot" autocomplete="off" spellcheck="false" value="${esc(c.destinationRoot || '')}" placeholder="/output/${esc(v.name)}"></label>
            <label class="${k.check}" data-ve-show="replace"${c.outputMode === 'replace' ? '' : ' hidden'}><input type="checkbox" name="replacementConfirmed"${c.outputMode === 'replace' && c.replacementConfirmed === true ? ' checked' : ''}> I understand the originals are replaced (each is backed up until its converted copy passes the checks)</label>
          </fieldset>
          <fieldset><legend>Verify</legend><div class="ve-choices">${VERIFY.map(([id, t]) => radio('verifyMode', id, t, (c.verifyMode || 'quick') === id)).join('')}</div>
            <p class="ve-hint">Replacing originals always uses at least Quick.</p></fieldset>
          <fieldset><legend>Clip groups and order</legend>
            <ol class="ve-order">${order.map((g, i) => `<li data-ve-group="${g}"><label class="${k.check}"><input type="checkbox" name="group" value="${g}"${included.has(g) ? ' checked' : ''}> ${esc(label(GROUPS, g))}</label><span></span>
              <button type="button" class="${k.btn}" data-ve-up="${g}"${i === 0 ? ' disabled' : ''} aria-label="Earlier">↑</button><button type="button" class="${k.btn}" data-ve-down="${g}"${i === 2 ? ' disabled' : ''} aria-label="Later">↓</button></li>`).join('')}</ol>
            <p class="ve-hint">Converted in this order.</p></fieldset>
          <fieldset><legend>Devices</legend>
            ${lanes ? `<p>${esc(devicesWords(c, devices))}</p><p class="ve-hint">Which GPUs, CPU and nodes convert, and how many clips each converts at once, are set in the Encoder under Parallel conversions. Saving here keeps them.</p>`
              : `<label class="${k.field} ve-field"><span>Clips at once</span><input class="${k.input}" type="number" name="concurrency" min="1" max="64" inputmode="numeric" value="${Number(c.concurrency) || 1}"></label><p class="ve-hint">On this server’s default device. To use several GPUs or nodes, set them in the Encoder under Parallel conversions.</p>`}
          </fieldset>
          <fieldset><legend>Automatic conversion</legend>
            <label class="${k.check}"><input type="checkbox" name="automatic"${draft._automatic ? ' checked' : ''}> Convert new clips of ${esc(v.name)} automatically</label>
            <div data-ve-show="automatic"${draft._automatic ? '' : ' hidden'} class="ve-form">
              <label class="${k.field} ve-field"><span>How often</span><select class="${k.input}" name="intervalMinutes">${INTERVALS.map(([m, t]) => `<option value="${m}"${(s.intervalMinutes || 60) === m ? ' selected' : ''}>${t[0].toUpperCase()}${t.slice(1)}</option>`).join('')}</select></label>
              <label class="${k.field} ve-field"><span>When</span><select class="${k.input}" name="window"><option value="any"${winMode === 'any' ? ' selected' : ''}>Any time</option><option value="off-peak"${winMode === 'off-peak' ? ' selected' : ''}>Only when electricity is off-peak</option><option value="hours"${winMode === 'hours' ? ' selected' : ''}>Only between set hours</option></select></label>
              <div class="ve-choices" data-ve-show="hours"${winMode === 'hours' ? '' : ' hidden'}>
                <label class="${k.field} ve-field"><span>From</span><select class="${k.input}" name="startHour">${hours.map((h) => `<option value="${h}"${(w?.startHour ?? 1) === h ? ' selected' : ''}>${hour(h)}</option>`).join('')}</select></label>
                <label class="${k.field} ve-field"><span>To</span><select class="${k.input}" name="endHour">${hours.map((h) => `<option value="${h}"${(w?.endHour ?? 6) === h ? ' selected' : ''}>${hour(h)}</option>`).join('')}</select></label></div>
              <p class="ve-hint">How often and when are shared by every vehicle that converts automatically.</p>
            </div></fieldset>
          <p class="ve-error" data-ve-error hidden></p>
          <div class="ve-actions"><button type="submit" class="${k.primary}">Save</button><button type="button" class="${k.btn}" data-ve-cancel>Cancel</button>
            ${entry && !entry.automatic ? `<button type="button" class="${k.btn}" data-ve-forget="${esc(v.id)}">Forget these settings</button>` : ''}</div>
        </form></section>`;
    }

    // the form's values back into draft (kept while redrawing the order)
    function readForm(form) {
      const fd = new FormData(form);
      const c = draft;
      c.codec = fd.get('codec') || 'h265';
      c.profileId = fd.get('profileId') || 'balanced';
      c.qualityLevel = fd.get('qualityLevel') || 'balanced';
      c._bitrate = fd.get('bitrate');
      c.keepOffTarget = fd.get('keepOffTarget') === 'on';
      c.keepLarger = fd.get('keepLarger') === 'on';
      c.outputMode = fd.get('outputMode') || 'separate';
      c.destinationRoot = String(fd.get('destinationRoot') ?? c.destinationRoot ?? '').trim() || null;
      c.replacementConfirmed = fd.get('replacementConfirmed') === 'on';
      c.verifyMode = fd.get('verifyMode') || 'quick';
      c.includedGroups = fd.getAll('group');
      if (fd.has('concurrency')) c.concurrency = Number(fd.get('concurrency'));
      c._automatic = fd.get('automatic') === 'on';
      c._schedule = { intervalMinutes: Number(fd.get('intervalMinutes')) || 60, mode: fd.get('window') || 'any', startHour: Number(fd.get('startHour')), endHour: Number(fd.get('endHour')) };
      return c;
    }

    // the payload the converter validates (exactly its keys)
    function configOf(c, folder) {
      const out = {
        sourceRoot: folder, destinationRoot: c.outputMode === 'replace' ? null : c.destinationRoot, codec: c.codec, profileId: c.profileId,
        networkMode: c.networkMode || 'auto', outputMode: c.outputMode, includedGroups: GROUPS.map((g) => g[0]).filter((g) => c.includedGroups.includes(g)),
        groupOrder: [...(c.groupOrder || DEFAULT_ORDER)], replacementConfirmed: c.outputMode === 'replace' && c.replacementConfirmed === true,
        verifyMode: c.verifyMode
      };
      if (c.profileId === 'custom') out.bitrateKbps = Math.round(Number(c._bitrate ?? (c.bitrateKbps / 1000)) * 1000);
      if (c.profileId === 'quality') out.qualityLevel = c.qualityLevel;
      if (hasTarget(c)) out.keepOffTarget = c.keepOffTarget === true;
      else out.keepLarger = c.keepLarger === true;
      if (Array.isArray(c.lanes) && c.lanes.length) out.lanes = c.lanes.map((l) => ({ device: l.device, concurrency: l.concurrency }));
      else out.concurrency = c.concurrency;
      return out;
    }

    function draw() {
      if (dead) return;
      const intro = opts.intro === false ? '' : `<p class="${k.muted}" style="margin:0">What each vehicle converts with. A vehicle with automatic conversion on uses these for its automatic runs; in the Encoder, “Load these” fills the form with them for a run you start.${opts.encoderHref ? ` <a href="${esc(opts.encoderHref)}">Open the Encoder</a>` : ''}</p>`;
      el.innerHTML = `<div class="ve">${intro}${cars.length ? `<div class="ve-cards">${cars.map(card).join('')}</div>` : `<p class="ve-empty">Add a vehicle in Settings first.</p>`}</div>`;
      const form = el.querySelector('[data-ve-form]');
      if (form) {
        sync(form);
        form.addEventListener('change', () => sync(form));
        form.addEventListener('submit', (e) => { e.preventDefault(); submit(form); });
      }
    }
    function sync(form) {
      const fd = new FormData(form);
      const show = (key, on) => form.querySelectorAll(`[data-ve-show="${key}"]`).forEach((x) => { x.hidden = !on; });
      const profile = fd.get('profileId');
      show('quality', profile === 'quality');
      show('custom', profile === 'custom');
      show('target', !['custom', 'quality'].includes(profile));
      show('notarget', ['custom', 'quality'].includes(profile));
      const replace = fd.get('outputMode') === 'replace';
      show('replace', replace);
      show('separate', !replace);
      const off = form.querySelector('input[name=verifyMode][value=off]');
      if (off) {
        off.disabled = replace;
        if (replace && off.checked) form.querySelector('input[name=verifyMode][value=quick]').checked = true;
      }
      show('automatic', fd.get('automatic') === 'on');
      show('hours', fd.get('window') === 'hours');
    }
    function fail(form, text) {
      const p = form.querySelector('[data-ve-error]');
      p.textContent = text;
      p.hidden = false;
      toast(text, true);
    }

    async function submit(form) {
      const v = cars.find((x) => x.id === form.dataset.veForm);
      if (!v) return;
      const folder = folderOf(v);
      const c = readForm(form);
      // the Encoder's own checks first, then the server's (the same as a start)
      if (!c.includedGroups.length) return fail(form, ERRORS.INVALID_GROUP_SELECTION);
      if (c.outputMode === 'separate' && !c.destinationRoot) return fail(form, 'Enter the separate folder, or choose Replace originals.');
      if (c.profileId === 'custom' && !(Number(c._bitrate) >= 0.25 && Number(c._bitrate) <= 100)) return fail(form, ERRORS.INVALID_BITRATE);
      if (!(Array.isArray(c.lanes) && c.lanes.length) && !(Number.isSafeInteger(c.concurrency) && c.concurrency >= 1 && c.concurrency <= 64)) return fail(form, ERRORS.INVALID_CONCURRENCY);
      if (c.outputMode === 'replace') {
        if (!replaceOk) return fail(form, ERRORS.REPLACEMENT_UNAVAILABLE);
        if (!c.replacementConfirmed) return fail(form, ERRORS.REPLACEMENT_CONFIRMATION_REQUIRED);
        if (!(await confirmFn(`Replace originals in ${v.name}’s footage? Each original is backed up first, and a failed replacement restores that backup.`))) return fail(form, ERRORS.REPLACEMENT_CONFIRMATION_REQUIRED);
      }
      const sch = c._schedule;
      const schedule = { intervalMinutes: sch.intervalMinutes, window: sch.mode === 'off-peak' ? { follow: 'off-peak' } : sch.mode === 'hours' ? { startHour: sch.startHour, endHour: sch.endHour } : null };
      if (c._automatic && schedule.window && !schedule.window.follow && schedule.window.startHour === schedule.window.endHour) return fail(form, ERRORS.INVALID_AUTO_WINDOW);
      const button = form.querySelector('[type=submit]');
      button.disabled = true;
      try {
        state = await save({ state, folder, config: configOf(c, folder), automatic: c._automatic, schedule, invoke: send });
        editing = null; draft = null;
        toast(`${v.name}: encoding settings saved.`);
        draw();
      } catch (err) {
        button.disabled = false;
        fail(form, errorText(err));
      }
    }

    el.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t || !el.contains(t)) return;
      const form = t.closest('form');
      if (t.dataset.veEdit) { editing = t.dataset.veEdit; draft = null; draw(); el.querySelector('[data-ve-form]')?.scrollIntoView({ block: 'nearest' }); return; }
      if (t.hasAttribute('data-ve-cancel')) { editing = null; draft = null; draw(); return; }
      const move = t.dataset.veUp || t.dataset.veDown;
      if (move && form) {
        readForm(form);
        const order = [...(draft.groupOrder?.length === 3 ? draft.groupOrder : DEFAULT_ORDER)];
        const i = order.indexOf(move);
        const j = t.dataset.veUp ? i - 1 : i + 1;
        if (j < 0 || j > 2) return;
        [order[i], order[j]] = [order[j], order[i]];
        draft.groupOrder = order;
        draft.bitrateKbps = Math.round(Number(draft._bitrate || 8) * 1000);
        draw();
        el.querySelector(`[data-ve-${t.dataset.veUp ? 'up' : 'down'}="${move}"]:not([disabled])`)?.focus();
        return;
      }
      if (t.dataset.veForget) {
        const v = cars.find((x) => x.id === t.dataset.veForget);
        if (!v || !(await confirmFn(`Forget ${v.name}’s saved encoding settings? The Encoder’s own settings are not changed.`))) return;
        try {
          state = await send('forgetVehicle', { forgetSource: folderOf(v) });
          editing = null; draft = null; draw();
        } catch (err) { toast(errorText(err), true); }
      }
    });

    const ready = (async () => {
      try { await load(); draw(); } catch (err) { if (!dead) el.innerHTML = `<p class="ve-error">${esc(errorText(err))}</p>`; }
    })();
    return {
      ready,
      /** Fresh data (another tab saved); an open editor is left alone. */
      async refresh() { if (editing) return; await load(); draw(); },
      destroy() { dead = true; }
    };
  }

  /**
   * The Encoder's one line for the picked vehicle: "Model 3 saved settings:
   * H.265 · Balanced · Replace · Quick  [Load these] [Encoding per vehicle]".
   * Fills nothing by itself: "Load these" calls onLoad(config).
   * opts: folder, name, href, onLoad, classes; returns the element.
   */
  async function encoderLine(host, opts) {
    injectCss(host.ownerDocument);
    const k = { ...DEFAULT_CLASSES, ...(opts.classes || {}) };
    let line = host.querySelector(':scope > .ve-line');
    if (!line) {
      line = host.ownerDocument.createElement('div');
      line.className = `ve-line ${opts.lineClass || ''}`.trim();
      host.append(line);
    }
    line.dataset.folder = opts.folder || '';
    let state = opts.state;
    if (!state) { try { state = await invoke('getAuto'); } catch (_) { state = null; } }
    if (line.dataset.folder !== (opts.folder || '')) return line; // picked another meanwhile
    const entry = state && opts.folder ? savedFor(state, opts.folder) : null;
    const name = esc(opts.name || 'This vehicle');
    const link = opts.href ? `<a href="${esc(opts.href)}"${opts.target ? ` target="${esc(opts.target)}"` : ''}>Encoding per vehicle</a>` : '';
    line.innerHTML = entry
      ? `<span>${name} saved settings: <b>${esc(summary(entry.config))}</b>${entry.automatic ? ' (automatic on)' : ''}</span><button type="button" class="${k.btn}" data-ve-load>Load these</button>${link}`
      : `<span>${name} has no saved encoding settings — this form is used.</span>${link}`;
    line.querySelector('[data-ve-load]')?.addEventListener('click', () => opts.onLoad?.(JSON.parse(JSON.stringify(entry.config))));
    return line;
  }

  /**
   * A saved config as the example packs' Encoder form object (codec,
   * profileId, groups, groupOrder, dest, lanes by device or concurrency...).
   */
  function formFields(c, current = {}) {
    return {
      codec: c.codec, profileId: c.profileId, outputMode: c.outputMode, verifyMode: c.verifyMode === 'full' ? 'full' : 'quick',
      keepOffTarget: c.keepOffTarget === true, keepLarger: c.keepLarger === true, groups: [...(c.includedGroups || [])],
      ...(c.bitrateKbps ? { bitrateKbps: c.bitrateKbps } : {}), ...(c.qualityLevel ? { qualityLevel: c.qualityLevel } : {}),
      ...(Array.isArray(c.groupOrder) && c.groupOrder.length === 3 ? { groupOrder: [...c.groupOrder] } : {}),
      ...(c.outputMode === 'separate' && c.destinationRoot ? { dest: c.destinationRoot } : {}),
      ...(Array.isArray(c.lanes) ? { lanes: Object.fromEntries(c.lanes.map((l) => [l.device, l.concurrency])) } : { concurrency: c.concurrency || current.concurrency || 1 })
    };
  }

  const api = { formFields, describe, summary, savedFor, save, defaults, mount, encoderLine, invoke, folderOf, ERRORS, errorText };
  root.SentryVehicleEncoding = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
