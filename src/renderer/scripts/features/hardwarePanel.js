// The Encoder's Hardware panel, inside Live run beside the run's progress:
// what the running conversion uses (encoder, GPU, decoding) and what it
// costs. From GET /api/stats (the `encoder` block) every 2 s while the page
// is on screen; with no conversion running, one compact line with the device
// instead. Names and models come from the machine, so every value is escaped.

const POLL_MS = 2000;
const TIMEOUT_MS = 10000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fin = (n) => typeof n === 'number' && Number.isFinite(n);
const clampPct = (n) => Math.max(0, Math.min(100, Math.round((fin(n) ? n : 0) * 10) / 10));
const pct = (n) => `${Math.round(n)}%`;
const temp = (c) => `${Math.round(c)} °C`;
const watts = (w) => `${w >= 10 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, '')} W`;
const base = (p) => String(p || '').split(/[\\/]/).pop();
const group = (n) => Math.round(n).toLocaleString('en-US');

// Clips and space per kWh are divided by at least this much energy: they
// start at 0 and count up with each clip until it has been measured, then
// follow the real ratio, with no jump in between (a fraction of a Wh would
// turn a clip or two into an absurd number).
const FLOOR_WH = 10;

/** "12.4 Wh" below 100 Wh, so a run's first minutes visibly count up; "412 Wh"; then "5.2 kWh". */
export function energyText(wh) {
    const w = Math.round(wh * 10) / 10;
    if (w < 100) return `${w.toFixed(1)} Wh`;
    if (Math.round(wh) < 1000) return `${Math.round(wh)} Wh`;
    const k = wh / 1000;
    return `${Math.round(k * 10) / 10 < 100 ? k.toFixed(1) : group(k)} kWh`;
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
// A chip as wide as the longest of its wordings, whichever it shows, so the
// head never wraps differently from one poll to the next.
const fitChip = (text, wordings) => `<span class="nd-chip nd-chip-fit"><span>${esc(text)}</span>${wordings.filter((w) => w !== text).map((w) => `<span aria-hidden="true">${esc(w)}</span>`).join('')}</span>`;

/** The GPU a render node (or a GPU name) belongs to, or the only GPU there is. */
export function gpuFor(gpus, device) {
    const list = Array.isArray(gpus) ? gpus.filter(Boolean) : [];
    if (!list.length || !device) return null;
    const node = base(device.node);
    return list.find((g) => node && base(g.node) === node)
        || list.find((g) => device.gpuName && g.name === device.gpuName)
        || (list.length === 1 ? list[0] : null);
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

// these drivers report the video engine's use whenever a clip runs
const VIDEO_VENDORS = new Set(['amd', 'intel', 'nvidia']);

/**
 * What the panel keeps between polls while the page stays open, so it
 * does not jump: the tiles it has shown, the devices it has listed, whether
 * the CPU's power is measured and what the GPU tile is called. Another job,
 * or the panel going idle, starts it over (`fresh` tells the poller to let
 * the panel's height go too).
 */
export function panelMemory() {
    return { view: null, tiles: new Set(), devices: new Map(), cpuMeasured: null, videoLabel: null, fresh: false };
}

function remember(memo, view) {
    if (!memo || memo.view === view) return;
    Object.assign(memo, { view, tiles: new Set(), devices: new Map(), cpuMeasured: null, videoLabel: null, fresh: true });
}

/**
 * The panel's inner HTML for a GET /api/stats body, or '' when there is
 * nothing to show (no numbers at all). With `memo` (panelMemory(), kept by
 * the caller), tiles and device lines stay in place between polls.
 */
export function renderHardware(stats, memo = null) {
    if (!stats || typeof stats !== 'object') return '';
    const enc = stats.encoder && typeof stats.encoder === 'object' ? stats.encoder : null;
    const gpus = Array.isArray(stats.gpus) ? stats.gpus.filter(Boolean) : [];
    const workers = Array.isArray(enc?.workers) ? enc.workers.filter(Boolean) : [];
    const device = enc?.device || null;

    // idle (or paused): one line with the device the conversions use
    if (!enc || (!enc.running && !workers.length)) {
        remember(memo, enc && !enc.running ? 'paused' : 'idle');
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
    remember(memo, `run:${enc.jobId ?? ''}`);

    // several devices converting at once, each a lane of its own (one GPU
    // or none, or a job without lanes: as always). A lane seen before keeps
    // its line while none of its clips runs for a moment.
    const now = Array.isArray(enc.devices) ? enc.devices.filter(Boolean) : [];
    const devices = [...now];
    if (memo) {
        const ids = new Set(now.map((d) => d.id));
        for (const [id, d] of memo.devices) if (!ids.has(id)) devices.push({ ...d, workers: 0, video: null, busy: null });
        for (const d of now) if (d.id !== null && d.id !== undefined) memo.devices.set(d.id, d);
        const rank = (d) => (d.hardware ? 0 : 1);
        devices.sort((a, b) => rank(a) - rank(b) || String(a.id ?? '').localeCompare(String(b.id ?? '')));
    }
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
    // no ffmpeg running: still scanning the folders for clips, or between
    // clips (each one is checked and saved before the next starts); short
    // words, so the chip is no wider than "3 at once"
    const scanning = !enc?.state || enc.state === 'discovering';
    const atOnce = `${Math.max(workers.length, fin(enc.concurrency) ? enc.concurrency : 0)} at once`;
    chips.push(fitChip(workers.length ? `${workers.length} at once` : scanning ? 'scanning…' : 'saving…', [atOnce, 'scanning…', 'saving…']));

    // A tile shows its number, or keeps its place with '—' once it has been
    // shown (the video engine of a GPU that reports one: always).
    const tiles = [];
    const tile = (name, html, placeholder, always = false) => {
        if (html) {
            memo?.tiles.add(name);
            tiles.push(html);
        } else if (always || memo?.tiles.has(name)) tiles.push(placeholder);
    };
    const engine = gpu && VIDEO_VENDORS.has(gpu.vendor);
    const video = gpu ? (fin(gpu.video) ? gpu.video : !engine && fin(gpu.busy) ? gpu.busy : null) : null;
    // (a sample that leaves the GPU out keeps the tile's name)
    let videoLabel = engine || fin(gpu?.video) ? 'Video engine' : 'GPU';
    if (memo && gpu) memo.videoLabel = videoLabel;
    else if (memo?.videoLabel) videoLabel = memo.videoLabel;
    tile('video', fin(video) && `<div><span>${videoLabel}</span><b>${pct(video)}</b>${bar(video, video >= 90)}</div>`,
        `<div><span>${videoLabel}</span><b>—</b>${bar(0)}</div>`, engine);
    const convCpu = fin(cpu.app?.ffmpegUsage) ? cpu.app.ffmpegUsage : fin(cpu.app?.usage) ? cpu.app.usage : null;
    tile('cpu', fin(convCpu) && `<div><span>CPU (conversions)</span><b>${pct(convCpu)}</b>${bar(convCpu, convCpu >= 90)}</div>`,
        `<div><span>CPU (conversions)</span><b>—</b>${bar(0)}</div>`);
    const total = fin(power.totalW) ? power.totalW : null;
    // a built-in GPU is part of the CPU chip: one figure for both
    const parts = fin(power.chipW)
        ? [fin(power.discreteW) ? `chip ${Math.round(power.chipW)} · GPU ${Math.round(power.discreteW)}` : 'whole chip']
        : [fin(power.cpuW) && `CPU ${Math.round(power.cpuW)}`, fin(power.gpuW) && `GPU ${Math.round(power.gpuW)}`].filter(Boolean);
    tile('power', fin(total) && `<div><span>Power</span><b>${watts(total)}</b><small>${parts.length ? parts.join(' · ') : '&nbsp;'}</small></div>`,
        '<div><span>Power</span><b>—</b><small>&nbsp;</small></div>');
    // with several GPUs, the hottest of the ones converting
    const gpuTemps = (several ? devices.filter((d) => d.hardware).map((d) => gpuFor(gpus, { node: d.node, gpuName: d.name })) : [gpu])
        .map((g) => g?.tempC).filter(fin);
    const temps = [gpuTemps.length && ['GPU', Math.max(...gpuTemps)], fin(cpu.tempC) && ['CPU', cpu.tempC]].filter(Boolean);
    const hot = temps.length ? Math.max(...temps.map(([, t]) => t)) : null;
    tile('temps', temps.length && `<div${hot >= 90 ? ' class="hot"' : ''}><span>Temperatures</span><b>${temp(temps[0][1])}</b><small>${temps.map(([k, t]) => `${k} ${Math.round(t)}`).join(' · ')}</small></div>`,
        '<div><span>Temperatures</span><b>—</b><small>&nbsp;</small></div>');

    // energy per clip and per GB saved, when the server could measure power:
    // the clips and space since measuring began against the energy measured
    // since (at least FLOOR_WH), so they start at 0 and count up as clips
    // finish
    const run = enc.run || {};
    const eff = [];
    let note = '';
    if (fin(run.wh)) {
        const since = fin(run.sinceWh) ? Math.max(run.sinceWh, FLOOR_WH) : null;
        const perKwh = (n) => (since !== null && fin(n) && n > 0 ? n / (since / 1000) : 0);
        eff.push(['This run', energyText(run.wh)]);
        eff.push(['Clips per kWh', group(perKwh(run.clips))]);
        eff.push(['Space saved per kWh', gb(perKwh(run.savedB))]);
        // the server measures the GPU's power but not the CPU's (as last
        // known while a sample has no power reading to tell)
        if (memo && typeof run.cpuMeasured === 'boolean') memo.cpuMeasured = run.cpuMeasured;
        if ((typeof run.cpuMeasured === 'boolean' ? run.cpuMeasured : memo?.cpuMeasured) === false) note = 'GPU only (CPU not measured)';
    } else {
        if (fin(run.clips)) eff.push(['Clips this run', group(run.clips)]);
        if (fin(run.savedB) && run.savedB > 0) eff.push(['Space saved', gb(run.savedB)]);
    }
    if (fin(run.cost)) eff.push(['Cost so far', money(run.cost, stats.price?.currency)]);

    // one line per device: Intel Arc A380 · hevc_qsv · 3 converting · video 72%
    const lines = several ? devices.map(deviceLine).join('') : '';

    return `<div class="nd-hw-head"><h3>Hardware</h3>${chips.join('')}</div>`
        + (lines ? `<div class="nd-devices">${lines}</div>` : '')
        + (tiles.length ? `<div class="nd-hw-tiles">${tiles.join('')}</div>` : '')
        + (eff.length ? `<div class="nd-eff">${eff.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>` : '')
        + (note ? `<p class="nd-eff-note">${esc(note)}</p>` : '');
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
    let memo = panelMemory();
    // Rebuilt on every poll: the panel never gets shorter while the page is
    // open and the job runs, so what is below it (the timings and the
    // summary; on one column the settings) stays put when a tile, a device
    // line or the energy row comes and goes. Another job, the panel going
    // idle, coming back to the Encoder or another width let it go.
    let tallest = 0;
    const release = () => {
        tallest = 0;
        if (panel.style) panel.style.minHeight = '';
    };
    const hold = () => {
        if (!panel.style || typeof panel.offsetHeight !== 'number') return;
        tallest = Math.max(tallest, panel.offsetHeight);
        panel.style.minHeight = `${tallest}px`;
    };

    const wanted = () => doc.visibilityState !== 'hidden' && shownByShell && onScreen;

    // Text being highlighted in the panel (or the button held down in it):
    // the numbers wait, so the highlight is not taken away before it can be
    // copied, and catch up as soon as it is gone.
    let pressed = null;
    let waiting = null;
    const selecting = () => {
        if (pressed && panel.contains?.(pressed)) return true;
        const sel = doc.getSelection?.();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
        const range = sel.getRangeAt(0);
        return panel.contains?.(range.commonAncestorContainer) === true || range.intersectsNode?.(panel) === true;
    };
    const show = (html) => {
        if (selecting()) {
            waiting = html;
            return;
        }
        waiting = null;
        // unchanged numbers leave the DOM (and a hovered title) alone
        if (html !== last) {
            panel.innerHTML = html;
            last = html;
        }
        panel.hidden = !html;
        if (html) {
            unavailable(false);
            hold();
        }
    };
    // Live run keeps the panel's column while it waits for the first answer.
    // An answer with nothing to show (the server's numbers cannot be read)
    // gives the column back to the run's progress, until a later poll has
    // numbers again (encoderPage.css: .nd-hw-off).
    const unavailable = (on) => panel.classList?.toggle?.('nd-hw-off', on);
    const catchUp = () => {
        if (waiting !== null && !selecting()) show(waiting);
    };
    doc.addEventListener('pointerdown', (e) => { pressed = e.button === 0 ? e.target : null; }, true);
    for (const type of ['pointerup', 'pointercancel']) {
        doc.addEventListener(type, () => {
            pressed = null;
            setTimeout(catchUp, 0);
        }, true);
    }
    doc.addEventListener('selectionchange', () => { if (!pressed) catchUp(); });

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
                const html = renderHardware(await res.json(), memo);
                if (memo.fresh) {
                    memo.fresh = false;
                    release();
                }
                show(html);
            }
        } catch {
            // the next poll tries again; the panel keeps its last numbers
        } finally {
            clearTimeout(giveUp);
            busy = false;
        }
        if (panel.hidden && waiting === null) unavailable(true);
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
            // back on the Encoder: the panel starts from its own height
            shownByShell = true;
            memo = panelMemory();
            release();
            resume();
        }
    });
    let width = win.innerWidth;
    win.addEventListener('resize', () => {
        if (win.innerWidth === width) return;
        width = win.innerWidth;
        release();
        hold();
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
