// The Encoder's Hardware panel, inside Live run: what the running conversion
// uses (encoder, GPU, decoding) and what it costs, one row per clip being
// converted. From GET /api/stats (the `encoder` block) every 2 s while the
// page is on screen; with no conversion running, one compact line with the
// device instead. Names, paths and models come from the machine, so every
// value is escaped.

const POLL_MS = 2000;
const TIMEOUT_MS = 10000;
const WORKERS_SHOWN = 16;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fin = (n) => typeof n === 'number' && Number.isFinite(n);
const clampPct = (n) => Math.max(0, Math.min(100, Math.round((fin(n) ? n : 0) * 10) / 10));
const pct = (n) => `${Math.round(n)}%`;
const temp = (c) => `${Math.round(c)} °C`;
const watts = (w) => `${w >= 10 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, '')} W`;
const base = (p) => String(p || '').split(/[\\/]/).pop();
const group = (n) => Math.round(n).toLocaleString('en-US');

// Clips and space per kWh need at least this much energy measured first: a
// fraction of a Wh would turn a clip or two into an absurd ratio.
const MIN_WH = 1;

/** "12.4 Wh" below 1 kWh, so a run's first minutes visibly count up; then "5.2 kWh". */
export function energyText(wh) {
    const w = Math.round(wh * 10) / 10;
    if (w < 1000) return `${w.toFixed(1)} Wh`;
    const k = wh / 1000;
    return `${k < 100 ? k.toFixed(1) : group(k)} kWh`;
}

// binary sizes, labelled like the rest of the manager's server numbers
function gb(bytes) {
    if (!(bytes > 0)) return '0 GB';
    const g = bytes / 1024 ** 3;
    if (g >= 1024) return `${(g / 1024).toFixed(1).replace(/\.0$/, '')} TB`;
    if (g >= 1) return `${g >= 100 ? group(g) : g.toFixed(1).replace(/\.0$/, '')} GB`;
    return `${Math.round(bytes / 1024 ** 2)} MB`;
}

// $0.05 but 1.20 kr; costs are summed by the server at each moment's price
function money(value, currency) {
    const n = value >= 100 ? group(value) : value.toFixed(2);
    const c = String(currency || '$');
    return `≈ ${/^[a-z]+$/i.test(c) ? `${n} ${c}` : `${c}${n}`}`;
}

const bar = (value, hot = false) => `<div class="nd-bar${hot ? ' hot' : ''}"><span style="width:${clampPct(value)}%"></span></div>`;
const chip = (text, title) => `<span class="nd-chip"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;

/** The GPU a render node (or a GPU name) belongs to, or the only GPU there is. */
export function gpuFor(gpus, device) {
    const list = Array.isArray(gpus) ? gpus.filter(Boolean) : [];
    if (!list.length || !device) return null;
    const node = base(device.node);
    return list.find((g) => node && base(g.node) === node)
        || list.find((g) => device.gpuName && g.name === device.gpuName)
        || (list.length === 1 ? list[0] : null);
}


function workerRow(w) {
    const done = fin(w.outTimeUs) && fin(w.durationUs) && w.durationUs > 0 ? Math.min(100, (w.outTimeUs / w.durationUs) * 100) : null;
    // numbers only, so the meta line needs no escaping
    const meta = [];
    if (fin(w.fps) && w.fps > 0) meta.push(`${group(w.fps)} fps`);
    if (fin(w.speed) && w.speed > 0) meta.push(`${w.speed.toFixed(1)}× realtime`);
    if (fin(w.bitrateKbps) && w.bitrateKbps > 0) meta.push(`${(w.bitrateKbps / 1000).toFixed(1)} Mb/s`);
    const drop = fin(w.dropFrames) ? w.dropFrames : 0;
    const dup = fin(w.dupFrames) ? w.dupFrames : 0;
    if (!meta.length) meta.push('starting…');
    else if (drop || dup) meta.push(`<span class="nd-warn">${[drop && `${group(drop)} dropped`, dup && `${group(dup)} duplicated`].filter(Boolean).join(' · ')}</span>`);
    else meta.push('no dropped frames');
    return `<div class="nd-w"><div class="nd-w-top"><span class="nd-clip" title="${esc(w.relativePath)}">${esc(base(w.relativePath) || w.itemId || 'clip')}</span><span>${done === null ? '' : pct(done)}</span></div>${bar(done ?? 0)}<div class="nd-w-meta">${meta.join(' · ')}</div></div>`;
}

// A device of `encoder.devices` (several GPUs converting): its name, encoder,
// how many clips it has and how busy its video engine is.
function deviceLine(d) {
    const converting = Array.isArray(d.workers) ? d.workers.length : fin(d.workers) ? d.workers : null;
    const parts = [d.name || (d.hardware ? base(d.node) : 'CPU') || d.id, d.encoder];
    if (converting !== null) parts.push(`${group(converting)} converting`);
    if (fin(d.video)) parts.push(`video ${pct(d.video)}`);
    else if (fin(d.busy)) parts.push(`GPU ${pct(d.busy)}`);
    const text = parts.filter(Boolean).join(' · ');
    const hot = fin(d.video) ? d.video >= 90 : fin(d.busy) && d.busy >= 90;
    return `<div class="nd-dev${hot ? ' hot' : ''}" title="${esc(text)}">${esc(text)}</div>`;
}

/**
 * The panel's inner HTML for a GET /api/stats body, or '' when there is
 * nothing to show (no numbers at all).
 */
export function renderHardware(stats) {
    if (!stats || typeof stats !== 'object') return '';
    const enc = stats.encoder && typeof stats.encoder === 'object' ? stats.encoder : null;
    const gpus = Array.isArray(stats.gpus) ? stats.gpus.filter(Boolean) : [];
    const workers = Array.isArray(enc?.workers) ? enc.workers.filter(Boolean) : [];
    const device = enc?.device || null;

    // idle (or paused): one line with the device the conversions use
    if (!enc || (!enc.running && !workers.length)) {
        const chips = [];
        if (device?.encoder) chips.push(chip([device.encoder, device.gpuName, base(device.node)].filter(Boolean).join(' · ')));
        else {
            const named = gpus.filter((g) => g.name && g.vendor !== 'other').slice(0, 2);
            for (const g of named) chips.push(chip([g.name, g.node].filter(Boolean).join(' · ')));
            if (!named.length) chips.push(chip('CPU encoding (no GPU encoder seen)'));
        }
        const state = enc && !enc.running ? 'Paused' : 'Idle';
        return `<div class="nd-hw-head nd-hw-idle"><h3>Hardware</h3><span class="nd-state">${state}</span>${chips.join('')}</div>`;
    }

    // several devices converting at once, each a lane of its own (one GPU
    // or none, or a job without lanes: as always)
    const devices = Array.isArray(enc.devices) ? enc.devices.filter(Boolean) : [];
    const several = devices.filter((d) => d.id !== null && d.id !== undefined).length > 1;
    const gpu = device?.hardware && !several ? gpuFor(gpus, device) : null;
    const cpu = stats.cpu || {};
    const power = stats.power || {};
    const chips = [];
    if (device?.encoder && !several) {
        const what = [device.encoder, device.gpuName || (device.hardware ? gpu?.name : 'CPU'), base(device.node)].filter(Boolean).join(' · ');
        chips.push(chip(what, what)); // (cut short on phones; the whole of it on hover)
    }
    if (device?.decode) chips.push(chip(`decode: ${device.decode === 'gpu' ? 'GPU' : 'CPU'}`));
    const finding = !enc?.state || enc.state === 'discovering' || enc.state === 'waiting';
    chips.push(chip(workers.length ? `${workers.length} at once` : finding ? 'finding clips…' : 'checking and saving…'));

    const tiles = [];
    const video = gpu ? (fin(gpu.video) ? gpu.video : fin(gpu.busy) ? gpu.busy : null) : null;
    if (fin(video)) tiles.push(`<div><span>${fin(gpu.video) ? 'Video engine' : 'GPU'}</span><b>${pct(video)}</b>${bar(video, video >= 90)}</div>`);
    const convCpu = fin(cpu.app?.ffmpegUsage) ? cpu.app.ffmpegUsage : fin(cpu.app?.usage) ? cpu.app.usage : null;
    if (fin(convCpu)) tiles.push(`<div><span>CPU (conversions)</span><b>${pct(convCpu)}</b>${bar(convCpu, convCpu >= 90)}</div>`);
    const total = fin(power.totalW) ? power.totalW : null;
    if (fin(total)) {
        const parts = [fin(power.cpuW) && `CPU ${Math.round(power.cpuW)}`, fin(power.gpuW) && `GPU ${Math.round(power.gpuW)}`].filter(Boolean);
        tiles.push(`<div><span>Power</span><b>${watts(total)}</b>${parts.length ? `<small>${parts.join(' · ')}</small>` : ''}</div>`);
    }
    // with several GPUs, the hottest of the ones converting
    const gpuTemps = (several ? devices.filter((d) => d.hardware).map((d) => gpuFor(gpus, { node: d.node, gpuName: d.name })) : [gpu])
        .map((g) => g?.tempC).filter(fin);
    const temps = [gpuTemps.length && ['GPU', Math.max(...gpuTemps)], fin(cpu.tempC) && ['CPU', cpu.tempC]].filter(Boolean);
    if (temps.length) {
        const hot = Math.max(...temps.map(([, t]) => t));
        tiles.push(`<div${hot >= 90 ? ' class="hot"' : ''}><span>Temperatures</span><b>${temp(temps[0][1])}</b><small>${temps.map(([k, t]) => `${k} ${Math.round(t)}`).join(' · ')}</small></div>`);
    }

    // energy per clip and per GB saved, when the server could measure power:
    // the clips and space since measuring began against the energy measured
    // since, so they start at 0 and rise as clips finish
    const run = enc.run || {};
    const eff = [];
    let note = '';
    if (fin(run.wh)) {
        const since = fin(run.sinceWh) && run.sinceWh >= MIN_WH ? run.sinceWh : null;
        const perKwh = (n) => (since !== null && fin(n) && n > 0 ? n / (since / 1000) : 0);
        eff.push(['This run', energyText(run.wh)]);
        eff.push(['Clips per kWh', group(perKwh(run.clips))]);
        eff.push(['Space saved per kWh', gb(perKwh(run.savedB))]);
        // the server measures the GPU's power but not the CPU's
        if (run.cpuMeasured === false) note = 'GPU only (CPU not measured)';
    } else {
        if (fin(run.clips)) eff.push(['Clips this run', group(run.clips)]);
        if (fin(run.savedB) && run.savedB > 0) eff.push(['Space saved', gb(run.savedB)]);
    }
    if (fin(run.cost)) eff.push(['Cost so far', money(run.cost, stats.price?.currency)]);

    const shown = workers.slice(0, WORKERS_SHOWN);
    const rows = shown.map(workerRow).join('')
        + (workers.length > shown.length ? `<p class="nd-w-more">and ${workers.length - shown.length} more</p>` : '');

    // one line per device: Intel Arc A380 · hevc_qsv · 3 converting · video 72%
    const lines = several ? devices.map(deviceLine).join('') : '';

    return `<div class="nd-hw-head"><h3>Hardware</h3>${chips.join('')}</div>`
        + (lines ? `<div class="nd-devices">${lines}</div>` : '')
        + (tiles.length ? `<div class="nd-hw-tiles">${tiles.join('')}</div>` : '')
        + (eff.length ? `<div class="nd-eff">${eff.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>` : '')
        + (note ? `<p class="nd-eff-note">${esc(note)}</p>` : '')
        + (rows ? `<div class="nd-workers">${rows}</div>` : '');
}

/**
 * Polls while the panel can be seen: the tab is visible, the manager has not
 * put the Encoder away (it posts "pause" / "shown"), and Live run is on
 * screen. A job starting (Start turns disabled) asks at once.
 */
export function startHardwarePanel({ doc = document, win = window, fetchImpl = (...args) => win.fetch(...args) } = {}) {
    const panel = doc.getElementById('converterHardware');
    if (!panel) return null;
    let timer = null;
    let busy = false;
    let shownByShell = true;
    let onScreen = true;
    let last = '';

    const wanted = () => doc.visibilityState !== 'hidden' && shownByShell && onScreen;

    async function poll() {
        clearTimeout(timer);
        timer = null;
        if (busy || !wanted()) return;
        busy = true;
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        const giveUp = setTimeout(() => ctrl?.abort(), TIMEOUT_MS);
        try {
            const res = await fetchImpl('/api/stats', { credentials: 'same-origin', headers: { 'X-Requested-With': 'sentry-six-manager' }, signal: ctrl?.signal });
            if (res.ok) {
                const html = renderHardware(await res.json());
                // unchanged numbers leave the DOM (and a hovered title) alone
                if (html !== last) {
                    panel.innerHTML = html;
                    last = html;
                }
                panel.hidden = !html;
            }
        } catch {
            // the next poll tries again; the panel keeps its last numbers
        } finally {
            clearTimeout(giveUp);
            busy = false;
        }
        if (wanted()) timer = setTimeout(poll, POLL_MS);
    }

    const stop = () => {
        clearTimeout(timer);
        timer = null;
    };
    const resume = () => {
        if (wanted() && !timer && !busy) poll();
    };

    doc.addEventListener('visibilitychange', () => (doc.visibilityState === 'hidden' ? stop() : resume()));
    win.addEventListener('message', (event) => {
        if (event.origin !== win.location.origin) return;
        if (event.data?.type === 'pause') {
            shownByShell = false;
            stop();
        } else if (event.data?.type === 'shown') {
            shownByShell = true;
            resume();
        }
    });
    // Live run scrolled out of view (one column on phones): nothing to update
    const live = panel.closest('.converter-operations') || panel.parentElement;
    if (live && typeof win.IntersectionObserver === 'function') {
        new win.IntersectionObserver((entries) => {
            onScreen = entries.some((entry) => entry.isIntersecting);
            if (onScreen) resume();
            else stop();
        }).observe(live);
    }
    const start = doc.getElementById('converterStart');
    if (start && typeof win.MutationObserver === 'function') {
        // only when a job really starts or ends: the converter rewrites the
        // attribute on every redraw, which polled several times a second
        let wasDisabled = start.disabled;
        new win.MutationObserver(() => {
            if (start.disabled === wasDisabled) return;
            wasDisabled = start.disabled;
            stop();
            resume();
        }).observe(start, { attributes: true, attributeFilter: ['disabled'] });
    }
    poll();
    return { poll, stop };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    const run = () => startHardwarePanel();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
    else run();
}
