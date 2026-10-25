const ACTIVE_STATES = new Set([
    'discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry',
    'verifying', 'copying', 'replacing', 'paused', 'paused_network'
]);

const PIPELINE_ORDER = ['discover', 'encode', 'verify', 'save'];
const GROUPS = ['RecentClips', 'SavedClips', 'SentryClips'];
const DEFAULT_GROUP_ORDER = ['SavedClips', 'SentryClips', 'RecentClips'];
// Mirrors CONCURRENCY in src/main/converter/contracts.js (not loadable here).
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 64;
const LISTED_CONCURRENCY = 10; // higher values use the Custom box
const DEFAULT_CONCURRENCY = 5;
const CONCURRENCY_STORAGE_KEY = 'converterConcurrency';
// With several GPUs: how many at once on each device (id -> count, 0 = Off)
const LANES_STORAGE_KEY = 'converterLanes';
const VERIFY_STORAGE_KEY = 'converterVerifyMode';
const VERIFY_MODES = ['off', 'quick', 'full'];
// The benchmark times these; Off stays a setting but is not compared
const COMPARED_VERIFY_MODES = ['quick', 'full'];
const CODEC_LABELS = { h265: 'H.265', av1: 'AV1' };
// The benchmark dialog's introduction with several GPUs (encoder.html has the
// one-GPU text)
const BENCHMARK_INTRO_LANES = 'Runs real conversions — telemetry, verification and saving — on copies of up to 8 clips from your source folder on each GPU in turn, with H.265 and then AV1 (when that GPU can encode it), at 1–8 parallel conversions with the compression selected above, then repeats each GPU\'s fastest setting with each verification mode (Quick, Full). Each GPU is tested alone, so its results are its own. Your footage is only read; results go to a temporary folder. Takes several minutes for each GPU; close other heavy apps for accurate results.';

const PAUSED_STATES = new Set(['paused', 'paused_network']);

// Time the job has spent working: paused periods (also while the app was
// closed) and the gap before a retry are left out. updatedAt marks the last
// state change, so a paused or finished job's clock stops there.
function workingMs(job, at = Date.now()) {
    if (!job || !Number.isFinite(job.createdAt)) return 0;
    const stopped = !ACTIVE_STATES.has(job.state) || PAUSED_STATES.has(job.state);
    const end = stopped ? (Number.isFinite(job.updatedAt) ? job.updatedAt : job.createdAt) : at;
    return Math.max(0, end - job.createdAt - (Number.isFinite(job.pausedMs) ? job.pausedMs : 0));
}

function normalizeConcurrency(value) {
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(number) && number >= MIN_CONCURRENCY && number <= MAX_CONCURRENCY ? number : null;
}

const STATUS_LABELS = Object.freeze({
    discovering: ['statusDiscovering', 'Discovering footage'],
    waiting: ['statusWaiting', 'Preparing next file'],
    staging: ['statusStaging', 'Staging locally'],
    encoding: ['statusEncoding', 'Encoding video'],
    'writing-telemetry': ['statusWritingTelemetry', 'Writing telemetry'],
    verifying: ['statusVerifying', 'Verifying telemetry'],
    copying: ['statusCopying', 'Saving verified file'],
    replacing: ['statusReplacing', 'Replacing verified original'],
    paused: ['statusPaused', 'Paused at a safe boundary'],
    paused_network: ['statusWaitingForConnection', 'Waiting for connection'],
    completed: ['statusCompleted', 'Conversion complete'],
    cancelled: ['statusCancelled', 'Conversion cancelled'],
    failed: ['statusFailed', 'Conversion stopped']
});

function formatBytes(bytes, locale) {
    const safe = Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0;
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = safe;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const rendered = new Intl.NumberFormat(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: unit === 0 ? 0 : 2
    }).format(unit === 0 ? safe : value);
    return `${rendered} ${units[unit]}`;
}

function formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = seconds % 60;
    return hours > 0
        ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
        : `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
}

// "1h 05m", "12m 30s", "45s".
function formatRemaining(milliseconds) {
    const seconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
    return `${rest}s`;
}

const TIMING_LABELS = Object.freeze({
    inspect: ['timingInspect', 'Probe file'],
    source: ['timingSource', 'Read source'],
    timeline: ['timingTimeline', 'Read telemetry'],
    encode: ['timingEncode', 'Encode'],
    metadata: ['timingMetadata', 'Write telemetry'],
    checkWait: ['timingCheckWait', 'Wait for picture check'],
    picture: ['timingPicture', 'Picture check (nodes)'],
    verify: ['timingVerify', 'Verify'],
    saveWait: ['timingSaveWait', 'Wait to save'],
    save: ['timingSave', 'Save / replace'],
    cleanup: ['timingCleanup', 'Clean up']
});
// Throughput is measured over this trailing window of finished-file samples.
const SPEED_WINDOW_MS = 3 * 60 * 1000;
const SPEED_MIN_SPAN_MS = 10 * 1000;

// details: what the server adds to some errors (DEVICE_UNSUPPORTED names the GPU)
function apiError(code, details) {
    const error = Object.assign(new Error(code || 'OPERATION_FAILED'), { code: code || 'OPERATION_FAILED' });
    if (details && typeof details === 'object') error.details = details;
    return error;
}

function unwrap(result) {
    if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
        if (result.ok === true) return result.value;
        throw apiError(result.error?.code, result.error?.details);
    }
    return result;
}

// The encoder a device uses for a codec: a name, or null when it can't
// (undefined: not reported, so not ruled out)
function deviceEncoder(device, codec) {
    const value = device?.encoders?.[codec];
    if (value && typeof value === 'object') return typeof value.codec === 'string' ? value.codec : null;
    return value;
}

// A GPU's name for the lanes and the benchmark. Two cards of the same model
// get their render node (or NVIDIA index, or PCI slot) after the name, so
// their rows and results are never mistaken for each other.
function deviceLabels(devices) {
    const named = new Map();
    for (const device of devices) named.set(device.name, (named.get(device.name) || 0) + 1);
    return devices.map((device) => {
        if (named.get(device.name) < 2) return device.name;
        const node = typeof device.node === 'string' && device.node ? device.node.split('/').pop() : null;
        const slot = typeof device.pci === 'string' && device.pci ? device.pci
            : String(device.id || '').replace(/^pci:/, '');
        const where = node || (Number.isSafeInteger(device.index) ? `GPU ${device.index}` : slot.replace(/^0000:/, ''));
        return where ? `${device.name} (${where})` : device.name;
    });
}

// "Intel Arc A380" -> "Arc A380", "Intel UHD Graphics 770" -> "UHD 770"
function shortDeviceName(label) {
    const short = String(label || '').replace(/^(Intel|AMD|NVIDIA)\s+/i, '').replace(/\bGraphics\s+/, '').trim();
    return short || String(label || '');
}

// "A", "A and B", "A, B and C"
function joinList(parts, and) {
    if (parts.length < 2) return parts.join('');
    return `${parts.slice(0, -1).join(', ')} ${and} ${parts[parts.length - 1]}`;
}

function selected(options, dataKey, fallback) {
    return options.find((entry) => entry.checked)?.dataset?.[dataKey] || fallback;
}

// Text being highlighted (or about to be, with the button held down on it)
// keeps its words: the run's counters change every second or two, and a new
// value would take the highlight away before it could be copied. The new
// value waits and shows as soon as the highlight is gone.
const heldText = new Map();
const watchedDocuments = new WeakSet();
let pressedNode = null;

function highlighted(element) {
    if (pressedNode && element.contains?.(pressedNode) === true) return true;
    const selection = element.ownerDocument?.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    return element.contains?.(range.commonAncestorContainer) === true || range.intersectsNode?.(element) === true;
}

function releaseHeldText() {
    for (const [element, text] of heldText) {
        if (highlighted(element)) continue;
        heldText.delete(element);
        if (element.textContent !== text) element.textContent = text;
    }
    for (const [container, rows] of heldRows) {
        if (!highlighted(container)) renderRows(container, rows);
    }
}

function watchHighlights(documentApi) {
    if (!documentApi?.addEventListener || watchedDocuments.has(documentApi)) return;
    watchedDocuments.add(documentApi);
    documentApi.addEventListener('pointerdown', (event) => { pressedNode = event.button === 0 ? event.target : null; }, true);
    for (const type of ['pointerup', 'pointercancel']) {
        documentApi.addEventListener(type, () => {
            pressedNode = null;
            setTimeout(releaseHeldText, 0);
        }, true);
    }
    documentApi.addEventListener('selectionchange', () => { if (!pressedNode) releaseHeldText(); });
}

function setText(element, value) {
    if (!element) return;
    const text = value == null ? '' : String(value);
    watchHighlights(element.ownerDocument);
    if (highlighted(element)) {
        heldText.set(element, text);
        return;
    }
    heldText.delete(element);
    // the same words leave the text (and a highlight in it) alone
    if (element.textContent !== text) element.textContent = text;
}

function setHidden(element, hidden) {
    if (element) element.hidden = Boolean(hidden);
}

function setDisabled(element, disabled) {
    if (element) element.disabled = Boolean(disabled);
}

function createRow(container, primary, secondary = '') {
    const documentApi = container?.ownerDocument;
    if (!container || !documentApi?.createElement) return null;
    const row = documentApi.createElement('div');
    row.classList.add('converter-row');
    const label = documentApi.createElement('span');
    label.classList.add('converter-row-primary');
    label.textContent = primary;
    row.append(label);
    if (secondary) {
        const detail = documentApi.createElement('span');
        detail.classList.add('converter-row-secondary');
        detail.textContent = secondary;
        row.append(detail);
    }
    return row;
}

// A list (the clips that failed) is redrawn only when it changed, keeps the
// place it was scrolled to, and waits while text in it is highlighted.
const heldRows = new Map();

function renderRows(container, rows) {
    if (!container) return;
    const text = rows.map(([primary, secondary]) => `${primary}${secondary ? ` — ${secondary}` : ''}`).join('\n');
    watchHighlights(container.ownerDocument);
    if (highlighted(container)) {
        heldRows.set(container, rows);
        return;
    }
    heldRows.delete(container);
    if (container.dataset && container.dataset.rendered === text) return;
    if (typeof container.replaceChildren === 'function') {
        const top = container.scrollTop;
        container.replaceChildren(...rows.map(([primary, secondary]) => createRow(container, primary, secondary)).filter(Boolean));
        if (top) container.scrollTop = top;
    } else {
        container.textContent = text;
    }
    if (container.dataset) container.dataset.rendered = text;
}

function collectElements(root) {
    const byId = (id) => root?.querySelector?.(`#${id}`) || null;
    const all = (selector) => [...(root?.querySelectorAll?.(selector) || [])];
    const orderRows = all('[data-converter-order-group]').map((row) => ({
        group: row.dataset?.converterOrderGroup,
        row,
        rank: row.querySelector?.('[data-converter-order-rank]') || null,
        up: row.querySelector?.('[data-converter-order-move="up"]') || null,
        down: row.querySelector?.('[data-converter-order-move="down"]') || null
    }));
    return {
        sourcePath: byId('converterSourcePath'),
        destinationPath: byId('converterDestinationPath'),
        sourceButton: byId('converterChooseSource'),
        destinationButton: byId('converterChooseDestination'),
        groupOptions: all('[data-converter-group]'),
        orderRows,
        codecOptions: all('[data-converter-codec]'),
        profileOptions: all('[data-converter-profile]'),
        profileSelect: byId('converterProfileSelect'),
        customBitrate: byId('converterCustomBitrate'),
        customBitrateRow: byId('converterCustomBitrateRow'),
        qualityLevel: byId('converterQualityLevel'),
        qualityRow: byId('converterQualityRow'),
        verifyMode: byId('converterVerifyMode'),
        verifyReplaceNote: byId('converterVerifyReplaceNote'),
        benchmarkVerifyTable: byId('converterBenchmarkVerifyTable'),
        benchmarkVerifyHead: byId('converterBenchmarkVerifyHead'),
        benchmarkVerifyRows: byId('converterBenchmarkVerifyRows'),
        autoEnabled: byId('converterAutoEnabled'),
        autoInterval: byId('converterAutoInterval'),
        autoWindowEnabled: byId('converterAutoWindowEnabled'),
        autoStart: byId('converterAutoStart'),
        autoEnd: byId('converterAutoEnd'),
        autoOffPeak: byId('converterAutoOffPeak'),
        autoHoldManual: byId('converterAutoHoldManual'),
        autoKeepRunning: byId('converterAutoKeepRunning'),
        autoLogin: byId('converterAutoLogin'),
        autoStatus: byId('converterAutoStatus'),
        autoList: byId('converterAutoList'),
        autoCheckNow: byId('converterAutoCheckNow'),
        concurrency: byId('converterConcurrency'),
        concurrencyCustom: byId('converterConcurrencyCustom'),
        concurrencyCustomRow: byId('converterConcurrencyCustomRow'),
        lanes: byId('converterLanes'),
        lanesTotal: byId('converterLanesTotal'),
        outputOptions: all('[data-converter-output]'),
        replaceOption: byId('converterReplaceOption'),
        replaceInput: byId('converterOutputReplace'),
        replaceCapability: byId('converterReplaceCapability'),
        replacementConfirmation: byId('converterReplacementConfirmation'),
        replacementWarning: byId('converterReplacementWarning'),
        replacementConfirmationRow: byId('converterReplacementConfirmationRow'),
        estimate: byId('converterEstimate'),
        startButton: byId('converterStart'),
        pauseButton: byId('converterPause'),
        resumeButton: byId('converterResume'),
        cancelButton: byId('converterCancel'),
        retryButton: byId('converterRetry'),
        dismissButton: byId('converterDismissSummary'),
        status: byId('converterStatus'),
        currentFile: byId('converterCurrentFile'),
        currentProgress: byId('converterCurrentProgress'),
        nodeWaiting: byId('converterNodeWaiting'),
        currentProgressFill: byId('converterCurrentProgressFill'),
        elapsed: byId('converterElapsed'),
        countDiscovered: byId('converterCountDiscovered'),
        countCompleted: byId('converterCountCompleted'),
        countSkipped: byId('converterCountSkipped'),
        countFailed: byId('converterCountFailed'),
        countWaiting: byId('converterCountWaiting'),
        processedBytes: byId('converterProcessedBytes'),
        speed: byId('converterSpeed'),
        fps: byId('converterFps'),
        benchmarkButton: byId('converterBenchmarkBtn'),
        benchmarkDialog: byId('converterBenchmarkDialog'),
        benchmarkIntro: byId('converterBenchmarkIntro'),
        benchmarkStatus: byId('converterBenchmarkStatus'),
        benchmarkDevices: byId('converterBenchmarkDevices'),
        benchmarkTable: byId('converterBenchmarkTable'),
        benchmarkRows: byId('converterBenchmarkRows'),
        benchmarkBest: byId('converterBenchmarkBest'),
        benchmarkRun: byId('converterBenchmarkRun'),
        benchmarkApply: byId('converterBenchmarkApply'),
        benchmarkApplyAlt: byId('converterBenchmarkApplyAlt'),
        benchmarkHead: byId('converterBenchmarkHead'),
        benchmarkClose: byId('converterBenchmarkClose'),
        eta: byId('converterEta'),
        timings: byId('converterTimings'),
        timingRows: byId('converterTimingRows'),
        reconnectBanner: byId('converterReconnectBanner'),
        cleanupBanner: byId('converterCleanupBanner'),
        scanNotice: byId('converterScanNotice'),
        errorRows: byId('converterErrorRows'),
        pipeline: byId('converterPipeline'),
        pipelineStages: all('[data-converter-phase]'),
        summary: byId('converterSummary'),
        summaryRetention: byId('converterSummaryRetention'),
        summaryFiles: byId('converterSummaryFiles'),
        summarySkipped: byId('converterSummarySkipped'),
        summaryFailed: byId('converterSummaryFailed'),
        summarySource: byId('converterSummarySource'),
        summaryOutput: byId('converterSummaryOutput'),
        summarySaved: byId('converterSummarySaved'),
        summaryPercent: byId('converterSummaryPercent'),
        summaryAssets: byId('converterSummaryAssets'),
        summaryElapsed: byId('converterSummaryElapsed'),
        summaryGroups: byId('converterSummaryGroups')
    };
}

function phaseFor(snapshot) {
    let state = snapshot?.state;
    if (state === 'paused') state = snapshot?.recovery?.fromState || 'waiting';
    if (state === 'paused_network') state = snapshot?.recovery?.resumeState || 'waiting';
    if (state === 'discovering') return 'discover';
    if (['waiting', 'staging', 'encoding', 'writing-telemetry'].includes(state)) return 'encode';
    if (state === 'verifying') return 'verify';
    if (['copying', 'replacing'].includes(state)) return 'save';
    if (state === 'completed') return 'complete';
    return null;
}

function createFootageConverterController(options = {}) {
    const api = options.api;
    if (!api) throw new TypeError('converter api is required');
    const elements = options.elements || collectElements(options.root);
    const notify = typeof options.notify === 'function' ? options.notify : () => {};
    const confirmAction = typeof options.confirm === 'function'
        ? options.confirm
        : (message) => globalThis.confirm?.(message) === true;
    const getLocale = typeof options.getLocale === 'function'
        ? options.getLocale
        : () => options.locale || options.root?.documentElement?.lang || globalThis.document?.documentElement?.lang || 'en';
    const renderBytes = options.formatBytes || ((bytes) => formatBytes(bytes, getLocale()));
    const translate = typeof options.t === 'function' ? options.t : (key) => key;
    const subscribeLanguage = typeof options.onLanguageChange === 'function' ? options.onLanguageChange : null;
    let capabilities = { separatePublication: 'unavailable', ownershipCleanup: 'unavailable', replacement: 'unavailable' };
    let snapshot = null;
    let latestRevision = -1;
    let initialized = false;
    let initPromise = null;
    let unsubscribe = null;
    let unsubscribeLanguage = null;
    let visible = false;
    let pendingStartEvents = null;
    let groupOrder = [...DEFAULT_GROUP_ORDER];
    const storage = options.storage !== undefined ? options.storage : globalThis.localStorage;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    let speedSamples = [];
    let speedJobId = null;

    // Files finished per minute over the recent window (falls back to the whole
    // run while the window is still short), plus the time left at that pace.
    function throughput(done, remaining) {
        const time = now();
        if (snapshot?.id !== speedJobId) {
            speedJobId = snapshot?.id ?? null;
            speedSamples = [];
        }
        if (!speedSamples.length || speedSamples[speedSamples.length - 1].done !== done) speedSamples.push({ time, done });
        while (speedSamples.length > 2 && time - speedSamples[1].time > SPEED_WINDOW_MS) speedSamples.shift();
        const first = speedSamples[0];
        let perMinute = null;
        if (speedSamples.length > 1 && time - first.time >= SPEED_MIN_SPAN_MS && done > first.done) {
            perMinute = (done - first.done) / ((time - first.time) / 60000);
        } else if (snapshot?.createdAt && done > 0 && workingMs(snapshot, time) >= SPEED_MIN_SPAN_MS) {
            perMinute = done / (workingMs(snapshot, time) / 60000);
        }
        if (!perMinute || !Number.isFinite(perMinute)) return { perMinute: null, remainingMs: null };
        return { perMinute, remainingMs: remaining > 0 ? (remaining / perMinute) * 60000 : 0 };
    }

    function renderTimings() {
        const timings = snapshot?.timings;
        const files = timings?.files;
        const rows = Number.isSafeInteger(files) && files > 0
            ? Object.entries(timings.totalMs || {})
                .filter(([phase, total]) => TIMING_LABELS[phase] && Number(total) > 0)
                .map(([phase, total]) => [phase, Number(total) / files])
                .sort((left, right) => right[1] - left[1])
            : [];
        setHidden(elements.timings, rows.length === 0);
        if (!elements.timingRows || rows.length === 0) return;
        const largest = rows[0][1];
        const documentRef = elements.timingRows.ownerDocument || globalThis.document;
        elements.timingRows.replaceChildren(...rows.map(([phase, average]) => {
            const row = documentRef.createElement('li');
            row.className = 'converter-timing-row';
            const label = documentRef.createElement('span');
            label.textContent = message(...TIMING_LABELS[phase]);
            const bar = documentRef.createElement('span');
            bar.className = 'converter-timing-bar';
            const fill = documentRef.createElement('span');
            if (fill.style) fill.style.width = `${Math.max(2, Math.round((average / largest) * 100))}%`;
            bar.append?.(fill);
            const value = documentRef.createElement('span');
            value.className = 'converter-timing-value';
            value.textContent = `${(average / 1000).toFixed(1)}s`;
            row.append?.(label, bar, value);
            row.setAttribute?.('data-phase', phase);
            return row;
        }));
    }

    function storedConcurrency() {
        try { return normalizeConcurrency(storage?.getItem?.(CONCURRENCY_STORAGE_KEY)); } catch (_) { return null; }
    }

    function rememberConcurrency(value) {
        try { storage?.setItem?.(CONCURRENCY_STORAGE_KEY, String(value)); } catch (_) { /* preference only */ }
    }

    function selectedProfile() {
        const value = elements.profileSelect?.value;
        return ['conservative', 'balanced', 'aggressive', 'custom', 'quality'].includes(value)
            ? value : selected(elements.profileOptions, 'converterProfile', 'balanced');
    }

    // Mbps in the box, kbps on the wire (matches CUSTOM_BITRATE_KBPS in contracts.js).
    function customBitrateKbps() {
        const mbps = Number(elements.customBitrate?.value);
        if (!Number.isFinite(mbps)) return null;
        const kbps = Math.round(mbps * 1000);
        return kbps >= 250 && kbps <= 100_000 ? kbps : null;
    }

    function selectedQualityLevel() {
        const value = elements.qualityLevel?.value;
        return ['high', 'balanced', 'small'].includes(value) ? value : 'balanced';
    }

    // Profile-specific settings sent with a start or benchmark request.
    function profileSettings(profileId) {
        if (profileId === 'custom') return { bitrateKbps: customBitrateKbps() };
        if (profileId === 'quality') return { qualityLevel: selectedQualityLevel() };
        return {};
    }

    function updateCustomBitrateVisibility() {
        setHidden(elements.customBitrateRow, selectedProfile() !== 'custom');
        setHidden(elements.qualityRow, selectedProfile() !== 'quality');
    }

    function storedVerifyMode() {
        try {
            const value = storage?.getItem?.(VERIFY_STORAGE_KEY);
            return VERIFY_MODES.includes(value) ? value : null;
        } catch (_) { return null; }
    }

    function replacingSelected() {
        return selected(elements.outputOptions, 'converterOutput', 'separate') === 'replace';
    }

    // Quick is the default. Replacing originals never runs without checks.
    function selectedVerifyMode() {
        const value = VERIFY_MODES.includes(elements.verifyMode?.value) ? elements.verifyMode.value : 'quick';
        return value === 'off' && replacingSelected() ? 'quick' : value;
    }

    function updateVerifyOptions() {
        const replacing = replacingSelected();
        const offOption = [...(elements.verifyMode?.options || [])].find((option) => option.value === 'off');
        if (offOption) offOption.disabled = replacing;
        const forced = replacing && elements.verifyMode?.value === 'off';
        if (forced) elements.verifyMode.value = 'quick';
        setHidden(elements.verifyReplaceNote, !replacing);
    }

    function customConcurrencySelected() {
        return elements.concurrency?.value === 'custom';
    }

    function selectedConcurrency() {
        const raw = customConcurrencySelected() ? elements.concurrencyCustom?.value : elements.concurrency?.value;
        return normalizeConcurrency(raw) ?? storedConcurrency() ?? DEFAULT_CONCURRENCY;
    }

    function updateConcurrencyCustomVisibility() {
        setHidden(elements.concurrencyCustomRow, lanesMode() || !customConcurrencySelected());
    }

    function setConcurrency(value) {
        if (elements.concurrency) {
            const custom = value > LISTED_CONCURRENCY && Boolean(elements.concurrencyCustom);
            elements.concurrency.value = custom ? 'custom' : String(value);
            if (custom) elements.concurrencyCustom.value = String(value);
        }
        updateConcurrencyCustomVisibility();
    }

    // ---- Several GPUs: how many at once on each ----------------------------
    // With two or more GPUs (getConverterDevices) the single number becomes
    // one row per GPU plus the CPU, each with its own − [n] + (0 is Off).
    // Until that answer arrives, or with one GPU, the page is as it always
    // was. A job only gets `lanes` when it uses more than the GPU the single
    // number would use (defaultDevice), so that path stays exactly the same.
    let laneDevices = null; // [{ id, kind, name, label, encoders, ... }], CPU last
    let defaultDevice = null;
    let defaultDevices = null; // codec -> the device a job without lanes uses for it
    // the rows are still the first-time ones (nothing remembered or set)
    let lanesUntouched = false;
    const laneCounts = new Map(); // device id -> the owner's number (0 = Off)
    const laneRows = new Map(); // device id -> { row, output, minus, plus, note }
    let syncedLanes = null;
    let requestedLanes = null;
    // live changes to the running job go one after another, the last one wins
    let requestedConcurrency = null;
    let liveChain = Promise.resolve();

    function lanesMode() {
        return laneDevices !== null;
    }

    function selectedCodec() {
        return selected(elements.codecOptions, 'converterCodec', 'h265');
    }

    // The GPU a job without lanes encodes a codec on (AV1 may use another
    // GPU than H.265); null when the server cannot tell
    function defaultFor(codec) {
        return defaultDevices && Object.prototype.hasOwnProperty.call(defaultDevices, codec) ? defaultDevices[codec] : defaultDevice;
    }

    function jobActive() {
        return Boolean(snapshot?.id && ACTIVE_STATES.has(snapshot.state));
    }

    // The codec the rows are for: the running job's while there is one (the
    // codec choice can be clicked meanwhile; it is for the next job)
    function laneCodec() {
        const codec = snapshot?.config?.codec;
        return jobActive() && CODEC_LABELS[codec] ? codec : selectedCodec();
    }

    // A row can be set when its device can encode the codec, or when the
    // running job converts on it already: it is never dropped from the job
    // because a test encode said otherwise
    function laneSupported(device) {
        if (deviceEncoder(device, laneCodec()) !== null) return true;
        return jobActive() && Boolean(lanesOfConfig(snapshot.config)?.some((lane) => lane.device === device.id));
    }

    function laneLabel(id) {
        return laneDevices?.find((device) => device.id === id)?.label || id;
    }

    // What a row really sends: 0 while its device can't encode the codec
    function laneCount(device) {
        return laneSupported(device) ? laneCounts.get(device.id) ?? 0 : 0;
    }

    function activeLanes() {
        return (laneDevices || []).map((device) => ({ device: device.id, concurrency: laneCount(device) }))
            .filter((lane) => lane.concurrency > 0);
    }

    function lanesSum(lanes) {
        return lanes.reduce((sum, lane) => sum + lane.concurrency, 0);
    }

    // The same lanes in any order give the same key
    function lanesKey(lanes) {
        return lanes.filter((lane) => lane.concurrency > 0).map((lane) => `${lane.device}=${lane.concurrency}`).sort().join(',');
    }

    function validLanes(value) {
        return Array.isArray(value)
            ? value.filter((lane) => lane && typeof lane.device === 'string' && Number.isSafeInteger(lane.concurrency)
                && lane.concurrency > 0 && lane.concurrency <= MAX_CONCURRENCY)
            : [];
    }

    // A job's numbers per device: its lanes, or the single number on the
    // default GPU (what a job without lanes runs on)
    function lanesOfConfig(config) {
        const known = validLanes(config?.lanes).filter((lane) => laneDevices?.some((device) => device.id === lane.device));
        if (known.length) return known.map((lane) => ({ device: lane.device, concurrency: lane.concurrency }));
        const concurrency = normalizeConcurrency(config?.concurrency);
        const device = defaultFor(CODEC_LABELS[config?.codec] ? config.codec : selectedCodec());
        return concurrency !== null && device ? [{ device, concurrency }] : null;
    }

    // Sent with Start and the automatic settings: `lanes` only when the rows
    // above Off are not just the default GPU's; otherwise the plain number.
    function lanesConfig() {
        const lanes = activeLanes();
        const concurrency = lanesSum(lanes);
        if (concurrency === 0) throw apiError('LANES_EMPTY');
        if (concurrency > MAX_CONCURRENCY) throw apiError('LANES_TOO_MANY');
        if (lanes.length === 1 && lanes[0].device === defaultFor(selectedCodec())) return { concurrency };
        return { concurrency, lanes };
    }

    // First time (nothing remembered): the codec's default GPU gets the
    // single number and the rest are Off. A default GPU that can't encode
    // the codec (or none known) gives way to the first GPU that can.
    function firstTimeLanes() {
        const codec = selectedCodec();
        const gpus = laneDevices.filter((device) => device.kind !== 'cpu' && device.id !== 'cpu');
        const able = (id) => laneDevices.some((device) => device.id === id && deviceEncoder(device, codec) !== null);
        const preferred = defaultFor(codec);
        const first = preferred && able(preferred) ? preferred
            : gpus.find((device) => deviceEncoder(device, codec) !== null)?.id ?? preferred ?? gpus[0].id;
        for (const device of laneDevices) laneCounts.set(device.id, device.id === first ? storedConcurrency() ?? DEFAULT_CONCURRENCY : 0);
    }

    function storedLanes() {
        try {
            const parsed = JSON.parse(storage?.getItem?.(LANES_STORAGE_KEY) || 'null');
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            const counts = new Map();
            for (const [id, count] of Object.entries(parsed)) {
                if (Number.isSafeInteger(count) && count >= 0 && count <= MAX_CONCURRENCY) counts.set(id, count);
            }
            return counts;
        } catch (_) { return null; }
    }

    function rememberLanes() {
        lanesUntouched = false;
        try {
            const kept = Object.fromEntries(storedLanes() || []);
            storage?.setItem?.(LANES_STORAGE_KEY, JSON.stringify({ ...kept, ...Object.fromEntries(laneCounts) }));
        } catch (_) { /* preference only */ }
    }

    function encoderSummary(device) {
        if (device.kind === 'cpu') return message('laneCpuHint', "Uses the server's CPU cores; slower than a GPU");
        if (device.kind === 'node') {
            const encoders = Object.keys(CODEC_LABELS).map((codec) => [codec, deviceEncoder(device, codec)])
                .filter(([, encoder]) => typeof encoder === 'string' && encoder)
                .map(([codec, encoder]) => `${CODEC_LABELS[codec]}: ${encoder}`).join(' · ');
            return message('laneNodeHint', 'Another server (Nodes), clips sent over HTTPS · {encoders}', { encoders });
        }
        return Object.keys(CODEC_LABELS).map((codec) => [codec, deviceEncoder(device, codec)])
            .filter(([, encoder]) => typeof encoder === 'string' && encoder)
            .map(([codec, encoder]) => `${CODEC_LABELS[codec]}: ${encoder}`).join(' · ');
    }

    function renderLanes() {
        if (!lanesMode()) return;
        const codec = laneCodec();
        const total = lanesSum(activeLanes());
        for (const device of laneDevices) {
            const parts = laneRows.get(device.id);
            if (!parts) continue;
            const supported = laneSupported(device);
            const count = laneCount(device);
            setText(parts.output, count === 0 ? message('laneOff', 'Off') : String(count));
            setText(parts.note, device.kind === 'node' && device.online === false
                ? message('laneNodeOffline', 'Offline: check it under Nodes')
                : supported ? encoderSummary(device)
                    : message('laneCantEncode', "Can't encode {codec}", { codec: CODEC_LABELS[codec] || codec }));
            parts.row.classList?.toggle('is-off', count === 0);
            parts.row.classList?.toggle('is-unsupported', !supported);
            // the total never drops to nothing or goes past the limit
            setDisabled(parts.minus, !supported || count === 0 || total <= 1);
            setDisabled(parts.plus, !supported || count >= MAX_CONCURRENCY || total >= MAX_CONCURRENCY);
        }
        setText(elements.lanesTotal, total > 0
            ? message('lanesTotal', '{count} at once in total. Each GPU takes its next clip when it is free, so a faster one converts more of them.', { count: total })
            : message('lanesNone', 'Nothing is set to convert: turn on a GPU or the CPU.'));
    }

    function buildLanes() {
        const doc = elements.lanes.ownerDocument || globalThis.document;
        laneRows.clear();
        const rows = laneDevices.map((device) => {
            const row = doc.createElement('div');
            row.className = 'converter-lane';
            row.setAttribute('data-device', device.id);
            const name = doc.createElement('span');
            name.className = 'converter-lane-name';
            const title = doc.createElement('strong');
            title.textContent = device.label;
            title.title = device.label;
            const note = doc.createElement('small');
            name.append(title, note);
            const stepper = doc.createElement('div');
            stepper.className = 'converter-stepper';
            stepper.setAttribute('role', 'group');
            stepper.setAttribute('aria-label', message('laneStepperLabel', '{device}: conversions at once', { device: device.label }));
            const step = (delta, text, label) => {
                const button = doc.createElement('button');
                button.type = 'button';
                button.setAttribute('data-step', String(delta));
                button.setAttribute('aria-label', label);
                button.textContent = text;
                button.addEventListener('click', () => stepLane(device.id, delta));
                return button;
            };
            const minus = step(-1, '−', message('laneFewer', 'Fewer'));
            const output = doc.createElement('output');
            const plus = step(1, '+', message('laneMore', 'More'));
            stepper.append(minus, output, plus);
            row.append(name, stepper);
            laneRows.set(device.id, { row, output, minus, plus, note });
            return row;
        });
        elements.lanes.replaceChildren(...rows, ...(elements.lanesTotal ? [elements.lanesTotal] : []));
    }

    function stepLane(id, delta) {
        const device = laneDevices?.find((entry) => entry.id === id);
        if (!device || !laneSupported(device)) return;
        const current = laneCount(device);
        const total = lanesSum(activeLanes());
        const next = Math.min(MAX_CONCURRENCY, Math.max(0, current + delta));
        if (next === current || (delta > 0 && total >= MAX_CONCURRENCY) || (delta < 0 && total <= 1)) return;
        laneCounts.set(id, next);
        lastStepAt = Date.now();
        rememberLanes();
        renderLanes();
        liveLanes();
    }

    // A row just stepped keeps its number for a moment (the next clicks may
    // follow); after that the rows show the job again, even with the button
    // still focused: a click leaves the focus on it, and the rows then went
    // on showing Off while the job used the node.
    let lastStepAt = 0;
    const STEP_HOLD_MS = 3_000;
    function stepperFocused() {
        if (Date.now() - lastStepAt > STEP_HOLD_MS) return false;
        const active = elements.lanes?.ownerDocument?.activeElement;
        return Boolean(active) && [...laneRows.values()].some((parts) => parts.minus === active || parts.plus === active);
    }

    // Rows follow the job (its lanes, or its number on the default GPU), only
    // when that changes and not while the owner is changing them.
    function syncLanes(config, { force = false } = {}) {
        if (!lanesMode()) return;
        const lanes = lanesOfConfig(config);
        if (!lanes) return;
        const key = lanesKey(lanes);
        if (!force && (key === syncedLanes || requestedLanes !== null || requestedConcurrency !== null || stepperFocused())) return;
        syncedLanes = key;
        lanesUntouched = false;
        for (const device of laneDevices) laneCounts.set(device.id, lanes.find((lane) => lane.device === device.id)?.concurrency ?? 0);
        renderLanes();
    }

    function lanesNotice(lanes) {
        const parts = lanes.map((lane) => message('lanesLiveEntry', '{count} on {device}', { count: lane.concurrency, device: laneLabel(lane.device) }));
        return message('lanesLive', 'Now {lanes}. Clips already converting finish first.', { lanes: joinList(parts, message('lanesAnd', 'and')) });
    }

    // During a run, the rows apply to the running job right away, like the
    // single number (see liveConcurrency). A job without lanes that still
    // only uses the default GPU keeps getting a plain number.
    function liveLanes() {
        if (!snapshot?.id || !ACTIVE_STATES.has(snapshot.state)) return;
        const lanes = activeLanes();
        const total = lanesSum(lanes);
        if (total === 0 || total > MAX_CONCURRENCY) return;
        const key = lanesKey(lanes);
        if (key === (requestedLanes ?? lanesKey(lanesOfConfig(snapshot.config) || []))) return;
        requestedLanes = key;
        const jobId = snapshot.id;
        liveChain = liveChain.then(async () => {
            try {
                // decided now, after the changes before it have landed
                const jobLanes = snapshot?.id === jobId && validLanes(snapshot.config?.lanes).length > 0;
                const plain = !jobLanes && lanes.length === 1 && lanes[0].device === defaultFor(snapshot?.config?.codec);
                let next;
                if (plain && typeof api.setConverterConcurrency === 'function') next = unwrap(await api.setConverterConcurrency(jobId, total));
                else if (typeof api.setConverterLanes === 'function') next = unwrap(await api.setConverterLanes(jobId, lanes));
                else return;
                if (next) applySnapshot(next, next.revision);
                if (requestedLanes === key) notify(lanesNotice(lanes));
            } catch (error) {
                notify(describeError(error), { type: 'error' });
                if (requestedLanes === key && snapshot?.config) syncLanes(snapshot.config, { force: true });
            } finally {
                if (requestedLanes === key) requestedLanes = null;
            }
        });
    }

    // Asked once at start, without holding up the page: with two or more
    // GPUs the rows replace the single number.
    async function loadDevices() {
        if (typeof api.getConverterDevices !== 'function' || !elements.lanes) return;
        let answer;
        try {
            answer = unwrap(await api.getConverterDevices());
        } catch (_) { return; }
        const listed = (Array.isArray(answer?.devices) ? answer.devices : [])
            .filter((device) => device && typeof device.id === 'string' && device.id)
            .map((device) => ({ ...device, name: typeof device.name === 'string' && device.name.trim() ? device.name.trim() : device.id }));
        const gpus = listed.filter((device) => device.kind !== 'cpu' && device.id !== 'cpu');
        // two GPUs, or another server paired under Nodes
        if (gpus.length < 2 && !gpus.some((device) => device.kind === 'node')) return;
        // the CPU row is always there, last
        const cpu = listed.find((device) => device.id === 'cpu') || { id: 'cpu', kind: 'cpu', name: 'CPU (software encoder)', encoders: {} };
        const devices = [...gpus, cpu];
        const labels = deviceLabels(devices);
        laneDevices = devices.map((device, index) => ({ ...device, label: labels[index] }));
        const known = (id) => (laneDevices.some((device) => device.id === id) ? id : null);
        defaultDevice = known(answer.defaultDevice);
        defaultDevices = answer.defaultDevices && typeof answer.defaultDevices === 'object'
            ? Object.fromEntries(Object.keys(CODEC_LABELS).map((codec) => [codec, known(answer.defaultDevices[codec])]))
            : null;
        // first time: the default GPU gets the single number, the rest Off
        const stored = storedLanes();
        const remembered = stored && laneDevices.some((device) => stored.has(device.id));
        if (remembered) for (const device of laneDevices) laneCounts.set(device.id, stored.get(device.id) ?? 0);
        else firstTimeLanes();
        lanesUntouched = !remembered;
        buildLanes();
        setHidden(elements.concurrency, true);
        updateConcurrencyCustomVisibility();
        setHidden(elements.lanes, false);
        if (elements.benchmarkIntro) {
            elements.benchmarkIntro.setAttribute?.('data-i18n', 'ui.converter.benchmarkIntroLanes');
            setText(elements.benchmarkIntro, message('benchmarkIntroLanes', BENCHMARK_INTRO_LANES));
        }
        renderLanes();
        if (snapshot?.config) syncLanes(snapshot.config);
    }

    function message(key, fallback, params) {
        const fullKey = `ui.converter.${key}`;
        const value = params === undefined ? translate(fullKey) : translate(fullKey, params);
        if (value && value !== fullKey) return value;
        return String(fallback).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match);
    }

    function setChecked(optionsList, dataKey, value) {
        for (const entry of optionsList) entry.checked = entry.dataset?.[dataKey] === value;
    }

    let syncedConcurrency = null;

    function syncConfig(config) {
        if (!config) return;
        if (elements.sourcePath) elements.sourcePath.value = config.sourceRoot || '';
        if (elements.destinationPath) elements.destinationPath.value = config.destinationRoot || '';
        setChecked(elements.codecOptions, 'converterCodec', config.codec);
        setChecked(elements.profileOptions, 'converterProfile', config.profileId);
        if (elements.profileSelect && config.profileId) elements.profileSelect.value = config.profileId;
        if (elements.customBitrate && Number.isSafeInteger(config.bitrateKbps)) {
            elements.customBitrate.value = String(config.bitrateKbps / 1000);
        }
        if (elements.qualityLevel && ['high', 'balanced', 'small'].includes(config.qualityLevel)) {
            elements.qualityLevel.value = config.qualityLevel;
        }
        // Jobs saved before the setting existed ran full verification.
        if (elements.verifyMode) elements.verifyMode.value = VERIFY_MODES.includes(config.verifyMode) ? config.verifyMode : 'full';
        updateCustomBitrateVisibility();
        setChecked(elements.outputOptions, 'converterOutput', config.outputMode);
        const included = new Set(config.includedGroups || []);
        for (const entry of elements.groupOptions) entry.checked = included.has(entry.dataset?.converterGroup);
        groupOrder = Array.isArray(config.groupOrder) && config.groupOrder.length === GROUPS.length
            ? [...config.groupOrder]
            : [...DEFAULT_GROUP_ORDER];
        if (elements.replacementConfirmation) elements.replacementConfirmation.checked = config.replacementConfirmed === true;
        // Only when the job's number changes: snapshots come with every clip,
        // and rewriting the control wiped a number being typed into it.
        const concurrency = normalizeConcurrency(config.concurrency);
        const typing = [elements.concurrency, elements.concurrencyCustom]
            .some((control) => control && control.ownerDocument?.activeElement === control);
        if (concurrency !== null && concurrency !== syncedConcurrency && !typing) {
            syncedConcurrency = concurrency;
            setConcurrency(concurrency);
        }
        syncLanes(config);
        // (the codec may have changed: which rows can encode it)
        renderLanes();
        updateOutputMode();
    }

    function renderGroupOrder(disabled = false) {
        for (const item of elements.orderRows || []) {
            const index = groupOrder.indexOf(item.group);
            if (item.row?.style) item.row.style.order = String(index);
            setText(item.rank, String(index + 1));
            setDisabled(item.up, disabled || index <= 0);
            setDisabled(item.down, disabled || index < 0 || index >= groupOrder.length - 1);
        }
    }

    function moveGroup(group, direction) {
        const index = groupOrder.indexOf(group);
        const nextIndex = direction === 'up' ? index - 1 : index + 1;
        if (index < 0 || nextIndex < 0 || nextIndex >= groupOrder.length) return;
        [groupOrder[index], groupOrder[nextIndex]] = [groupOrder[nextIndex], groupOrder[index]];
        renderGroupOrder(false);
    }

    function updateCapabilities(next) {
        capabilities = next || capabilities;
        const replacementAvailable = capabilities.replacement === 'available';
        setDisabled(elements.replaceInput, !replacementAvailable);
        if (elements.replaceOption) {
            elements.replaceOption.setAttribute?.('aria-disabled', replacementAvailable ? 'false' : 'true');
            elements.replaceOption.classList?.toggle('is-unavailable', !replacementAvailable);
        }
        setText(elements.replaceCapability, replacementAvailable
            ? message('capabilityReplaceAvailable', 'Available on this filesystem')
            : message('capabilityReplaceUnavailable', 'Replace originals is not available on this system. Originals remain protected.'));
        if (!replacementAvailable && selected(elements.outputOptions, 'converterOutput', 'separate') === 'replace') {
            setChecked(elements.outputOptions, 'converterOutput', 'separate');
        }
        updateOutputMode();
    }

    function updateOutputMode() {
        const mode = selected(elements.outputOptions, 'converterOutput', 'separate');
        const replacing = mode === 'replace' && capabilities.replacement === 'available';
        setHidden(elements.replacementConfirmationRow, !replacing);
        setDisabled(elements.destinationPath, replacing);
        setDisabled(elements.destinationButton, replacing);
        updateVerifyOptions();
        const sourceRoot = elements.sourcePath?.value?.trim() || message('sourcePlaceholder', 'the selected source folder');
        setText(elements.replacementWarning, message(
            'replacementWarning',
            'Source {sourceRoot}: each original is backed up before replacement. If replacement fails, the backup is restored so you can roll back safely.',
            { sourceRoot }
        ));
    }

    function renderPipeline() {
        const current = phaseFor(snapshot);
        const activeIndex = PIPELINE_ORDER.indexOf(current);
        if (elements.pipeline) elements.pipeline.dataset.currentPhase = current || 'idle';
        for (const stage of elements.pipelineStages) {
            const index = PIPELINE_ORDER.indexOf(stage.dataset?.phase);
            const complete = current === 'complete' || (activeIndex >= 0 && index < activeIndex);
            stage.classList?.toggle('is-active', index === activeIndex);
            stage.classList?.toggle('is-complete', complete);
            stage.setAttribute?.('aria-current', index === activeIndex ? 'step' : 'false');
        }
    }

    function renderSummary(items) {
        const summary = snapshot?.summary;
        setHidden(elements.summary, !summary);
        if (!summary) return;
        setText(elements.summaryRetention, snapshot?.config?.outputMode === 'separate'
            ? message('summarySeparateRetention', 'Video size reduction is not physical storage reclaimed. Originals are retained in separate mode.')
            : message('summaryRetention', 'Video size reduction is not physical storage reclaimed. Retained cleanup artifacts still consume space.'));
        const skipped = snapshot?.itemStateCounts?.skipped
            ?? items.filter((item) => item.state === 'skipped').length;
        const failed = snapshot?.itemStateCounts?.failed
            ?? items.filter((item) => item.state === 'failed').length;
        const percent = summary.sourceVideoBytes > 0 ? Math.round((summary.savedBytes / summary.sourceVideoBytes) * 100) : 0;
        setText(elements.summaryFiles, summary.files);
        setText(elements.summarySkipped, skipped);
        setText(elements.summaryFailed, failed);
        setText(elements.summarySource, renderBytes(summary.sourceVideoBytes));
        setText(elements.summaryOutput, renderBytes(summary.outputVideoBytes));
        setText(elements.summarySaved, renderBytes(summary.savedBytes));
        setText(elements.summaryPercent, `${percent}%`);
        setText(elements.summaryAssets, renderBytes(summary.copiedAssetBytes));
        setText(elements.summaryElapsed, formatDuration(workingMs(snapshot, now())));
        renderRows(elements.summaryGroups, GROUPS.map((group) => {
            const counters = summary.groups?.[group] || { files: 0, savedBytes: 0 };
            return [group, message('summaryGroup', '{count} files · {bytes} video size reduction', {
                count: counters.files,
                bytes: renderBytes(counters.savedBytes)
            })];
        }));
    }

    function render() {
        const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
        const counters = snapshot?.counters || {};
        const activeItem = items.find((item) => item.id === snapshot?.activeItemId)
            || items.find((item) => item.state === 'processing');
        const failedItems = items.filter((item) => item.state === 'failed');
        const cleanupItems = items.filter((item) => String(item.resultCode || '').includes('cleanup-pending'));
        const stateCount = (state) => snapshot?.itemStateCounts?.[state]
            ?? items.filter((item) => item.state === state).length;
        const cleanupPendingCount = snapshot?.cleanupPendingCount ?? cleanupItems.length;
        const progress = snapshot?.progress;
        const active = ACTIVE_STATES.has(snapshot?.state);
        const paused = snapshot?.state === 'paused';

        const statusLabel = STATUS_LABELS[snapshot?.state];
        setText(elements.status, snapshot
            ? statusLabel ? message(...statusLabel) : message('statusReady', 'Converter ready')
            : message('ready', 'Ready to configure'));
        // clips sent ahead to a node wait there: counted apart, not as converting
        const live = active && snapshot?.id && nodeWaiting.jobId === snapshot.id ? nodeWaiting : null;
        const waitingOnNode = live ? live.count : 0;
        const inFlight = snapshot?.itemStateCounts?.active ?? items.filter((item) => item.state === 'processing').length;
        // "Converting" is the clips encoding right now (here, or started on a
        // node); the rest under way are listed under it: waiting on a node, or
        // being read, sent, checked or saved
        const converting = Number.isSafeInteger(live?.encoding) ? Math.min(live.encoding, inFlight) : Math.max(0, inFlight - waitingOnNode);
        const elsewhere = Number.isSafeInteger(live?.encoding) ? Math.max(0, inFlight - converting - waitingOnNode) : 0;
        const withNode = validLanes(snapshot?.config?.lanes).some((lane) => String(lane.device).startsWith('node:'));
        setText(elements.currentFile, active && converting > 1
            ? message('convertingFiles', 'Converting {count} files at once', { count: converting })
            : activeItem?.relativePath || message('noFileActive', 'No file active'));
        if (elements.nodeWaiting) {
            const parts = [
                ...(waitingOnNode > 0 ? [message('waitingOnNode', '{count} waiting on a node', { count: waitingOnNode })] : []),
                ...(elsewhere > 0 ? [withNode
                    ? message('otherUnderWayNode', '{count} more being read, sent, checked or saved', { count: elsewhere })
                    : message('otherUnderWay', '{count} more being read, checked or saved', { count: elsewhere })] : [])
            ];
            setText(elements.nodeWaiting, parts.join(' · '));
            elements.nodeWaiting.hidden = parts.length === 0;
        }
        setText(elements.currentProgress, progress?.outTimeUs !== undefined
            ? message('progressEncoded', '{duration} encoded', { duration: formatDuration(progress.outTimeUs / 1000) })
            : activeItem ? message('progressWorking', 'Working on current file') : '');
        elements.currentProgressFill?.classList?.toggle('is-live', Boolean(activeItem && active));
        setText(elements.elapsed, snapshot ? formatDuration(workingMs(snapshot, now())) : '00:00');
        // Until the scan reaches the end of the folder, Discovered is a running
        // total and the time remaining a minimum; say so instead of looking
        // final.
        const scanning = active && snapshot?.discoveryComplete === false;
        const discoveredCount = snapshot?.itemCount ?? items.length;
        setText(elements.countDiscovered, scanning ? `${discoveredCount}+` : discoveredCount);
        setHidden(elements.scanNotice, !scanning);
        setText(elements.countCompleted, stateCount('completed'));
        setText(elements.countSkipped, stateCount('skipped'));
        setText(elements.countFailed, stateCount('failed'));
        setText(elements.countWaiting, stateCount('queued'));
        setText(elements.processedBytes, renderBytes(counters.sourceVideoBytes || 0));
        // Speed and time remaining count converted (or failed) clips only:
        // already-converted clips are skipped in bursts while the scan runs,
        // and counting them made the speed jump and the time remaining shrink.
        const finished = stateCount('completed') + stateCount('failed');
        const remaining = stateCount('queued') + converting;
        // A pause starts the recent-speed window over (paused time is not speed).
        if (PAUSED_STATES.has(snapshot?.state)) speedSamples = [];
        let pace = active && !paused ? throughput(finished, remaining) : { perMinute: null, remainingMs: null };
        // A finished run keeps showing its overall average speed (working
        // time only, so pauses do not drag it down).
        if (!active && snapshot?.state === 'completed' && finished > 0) {
            const minutes = workingMs(snapshot, now()) / 60000;
            if (minutes > 0) pace = { perMinute: finished / minutes, remainingMs: null };
        }
        setText(elements.speed, pace.perMinute === null ? '—'
            : message('speedValue', '{rate} files/min', { rate: pace.perMinute.toFixed(pace.perMinute < 10 ? 1 : 0) }));
        // Full snapshots carry no progress; keep the last reading briefly.
        const fps = lastFps && Date.now() - lastFps.at < 5_000 ? lastFps.value : null;
        setText(elements.fps, active && !paused && Number.isFinite(fps) && fps > 0
            ? message('fpsValue', '{fps} fps', { fps: fps >= 100 ? Math.round(fps) : fps.toFixed(1) }) : '—');
        setText(elements.eta, pace.remainingMs === null || snapshot?.discoveryComplete === false && remaining === 0 ? '—'
            : scanning ? message('etaAtLeast', 'at least {time}', { time: formatRemaining(pace.remainingMs) })
                : formatRemaining(pace.remainingMs));
        renderTimings();
        setHidden(elements.reconnectBanner, snapshot?.state !== 'paused_network');
        setHidden(elements.cleanupBanner, cleanupPendingCount === 0);
        if (cleanupPendingCount) {
            setText(elements.cleanupBanner, message('cleanupPending', '{count} {file} with cleanup pending. Retained artifacts still consume space; hardlinks share disk allocation.', {
                count: cleanupPendingCount,
                file: message(cleanupPendingCount === 1 ? 'cleanupFileSingular' : 'cleanupFilePlural', cleanupPendingCount === 1 ? 'file' : 'files')
            }));
        }
        renderRows(elements.errorRows, failedItems.map((item) => [item.relativePath || item.id, item.failure?.code || 'operation-failed']));
        setHidden(elements.errorRows, failedItems.length === 0);
        setDisabled(elements.startButton, active);
        // Parallel conversions stays open during a run: changing it applies
        // to the running job (see liveConcurrency)
        setDisabled(elements.concurrency, false);
        setDisabled(elements.concurrencyCustom, false);
        setDisabled(elements.benchmarkButton, active);
        setDisabled(elements.profileSelect, active);
        setDisabled(elements.customBitrate, active);
        setDisabled(elements.pauseButton, !active || paused || snapshot?.state === 'paused_network');
        setDisabled(elements.resumeButton, !paused);
        setDisabled(elements.cancelButton, !active);
        setDisabled(elements.retryButton, failedItems.length === 0 || !['completed', 'failed'].includes(snapshot?.state));
        renderGroupOrder(active);
        renderPipeline();
        renderSummary(items);
        renderAutoStatus();
    }

    let lastFps = null;
    // clips waiting in a node's queue: sent with live progress only, kept
    // across the job's full updates (which carry no progress) until it changes
    let nodeWaiting = { jobId: null, count: 0, encoding: null };
    let benchmarkRunning = false;
    let benchmarkBest = null;

    function encoderLabel(entry) {
        return entry?.codec ? `${entry.codec} (${entry.hardware ? 'GPU' : 'CPU'})` : '—';
    }

    function benchmarkErrorText(error) {
        const code = error?.code || 'OPERATION_FAILED';
        if (code === 'JOB_ACTIVE') return message('benchmarkJobActive', 'Finish or cancel the current conversion before benchmarking.');
        if (code === 'CANCELLED') return message('benchmarkCancelled', 'Benchmark cancelled.');
        if (code === 'BENCHMARK_ACTIVE') return message('benchmarkBusy', 'A benchmark is already running.');
        if (code === 'BENCHMARK_SOURCE_REQUIRED') return message('benchmarkSourceRequired', 'No original (H.264) Tesla clips were found in the source folder, and the benchmark needs some: every clip there may already be converted. Choose a folder that still has originals.');
        return message('benchmarkFailed', 'Benchmark failed: {code}', { code });
    }

    const formatRate = (value) => String(value >= 100 ? Math.round(value) : value);
    // the benchmark reports files per Wh; per kWh reads like the rest of the app
    const filesPerKwh = (perWh) => (Number.isFinite(perWh) && perWh > 0 ? String(Math.round(perWh * 1000)) : '—');

    const verifyLabel = (mode) => ({
        off: message('verifyLabelOff', 'Off'), quick: message('verifyLabelQuick', 'Quick'), full: message('verifyLabelFull', 'Full')
    })[mode] || mode;

    // Quick / Full at each codec's recommended setting, into target's
    // verification table (the dialog's own, or a GPU's section).
    function renderVerifyComparison(target, runs, doc, cell) {
        const compared = runs.filter((run) => Array.isArray(run.verifyComparison) && run.verifyComparison.length);
        if (target.verifyHead) {
            const head = doc.createElement('tr');
            head.append(cell('th', message('verification', 'Verification')),
                ...COMPARED_VERIFY_MODES.map((mode) => cell('th', verifyLabel(mode))));
            target.verifyHead.replaceChildren(head);
        }
        const rows = compared.map((run) => {
            const row = doc.createElement('tr');
            row.append(cell('td', message('benchmarkVerifyTitle', '{codec} · {count} at once',
                { codec: CODEC_LABELS[run.codec] || run.codec, count: run.best?.level ?? '—' })));
            for (const mode of COMPARED_VERIFY_MODES) {
                const entry = run.verifyComparison.find((candidate) => candidate.verifyMode === mode);
                if (!entry) row.append(cell('td', '—'));
                else if (!entry.ok) {
                    const failed = cell('td', message('benchmarkFailedRun', 'failed'));
                    if (entry.failures?.length) failed.title = entry.failures.join(', ');
                    row.append(failed);
                } else {
                    row.append(cell('td', message('benchmarkVerifyCell', '{rate} ({seconds} s)', {
                        rate: formatRate(entry.filesPerMinute),
                        seconds: Number.isFinite(entry.verifySecondsPerClip) ? entry.verifySecondsPerClip.toFixed(1) : '—'
                    })));
                }
            }
            return row;
        });
        target.verifyRows?.replaceChildren(...rows);
        setHidden(target.verifyTable, rows.length === 0);
    }
    let benchmarkPicks = [];
    // a { devices } result: per GPU { id, name, runs, lines, picks }
    let benchmarkGpus = [];

    // One entry per codec tested; older single-codec results become one run.
    function benchmarkRuns(result) {
        if (Array.isArray(result?.codecs) && result.codecs.length) return result.codecs;
        if (!result) return [];
        return [{ codec: selected(elements.codecOptions, 'converterCodec', 'h265'), ...result }];
    }

    // At once | per codec: Files/min, FPS, Saved (, W, Files/kWh), into
    // target's results table (the dialog's own, or a GPU's section).
    function renderResultsTable(target, runs, doc, cell) {
        const tested = runs.filter((run) => !run.error && Array.isArray(run.results) && run.results.length);
        // the server measured power during the run: W and files per kWh per level
        const measured = (run) => run.results.some((entry) => entry.ok && (Number.isFinite(entry.avgW) || Number.isFinite(entry.filesPerWh)));
        // Header: At once | per codec: Files/min, FPS, Saved (, W, Files/kWh)
        if (target.head) {
            const head = doc.createElement('tr');
            head.append(cell('th', message('benchmarkParallel', 'At once')));
            for (const run of tested) {
                const label = CODEC_LABELS[run.codec] || run.codec;
                head.append(cell('th', `${label} ${message('benchmarkFilesPerMinute', 'Files/min')}`, 'codec-start'),
                    cell('th', message('benchmarkFps', 'FPS')), cell('th', message('benchmarkSaved', 'Saved')));
                if (measured(run)) head.append(cell('th', message('benchmarkWatts', 'W')), cell('th', message('benchmarkFilesPerKwh', 'Files/kWh')));
            }
            target.head.replaceChildren(head);
        }
        const levels = [...new Set(tested.flatMap((run) => run.results.map((entry) => entry.level)))].sort((a, b) => a - b);
        const rows = levels.map((level) => {
            const row = doc.createElement('tr');
            row.append(cell('td', String(level)));
            for (const run of tested) {
                const entry = run.results.find((candidate) => candidate.level === level);
                const best = run.best && run.best.level === level;
                const efficient = run.efficient && run.efficient.level === level;
                const energy = measured(run);
                if (!entry) {
                    row.append(cell('td', '—', 'codec-start'), cell('td', '—'), cell('td', '—'));
                    if (energy) row.append(cell('td', '—'), cell('td', '—'));
                } else if (!entry.ok) {
                    const failedCell = cell('td', message('benchmarkFailedRun', 'failed'), 'codec-start');
                    if (entry.failures?.length) failedCell.title = entry.failures.join(', ');
                    row.append(failedCell, cell('td', '—'), cell('td', '—'));
                    if (energy) row.append(cell('td', '—'), cell('td', '—'));
                } else {
                    row.append(cell('td', formatRate(entry.filesPerMinute), `codec-start${best ? ' is-best' : ''}`),
                        cell('td', formatRate(entry.fps), best ? 'is-best' : ''),
                        cell('td', Number.isFinite(entry.savedPercent) ? `${entry.savedPercent}%` : '—', best ? 'is-best' : ''));
                    if (energy) {
                        row.append(cell('td', Number.isFinite(entry.avgW) ? String(Math.round(entry.avgW)) : '—', efficient ? 'is-efficient' : ''),
                            cell('td', filesPerKwh(entry.filesPerWh), efficient ? 'is-efficient' : ''));
                    }
                }
            }
            return row;
        });
        target.rows?.replaceChildren(...rows);
        target.table?.classList?.toggle('has-energy', tested.some(measured));
        setHidden(target.table, rows.length === 0);
    }

    // The best / efficient / failed / skipped lines and the settings worth a
    // Use button. For one GPU of several, every line starts with its name.
    function benchmarkLines(runs, deviceName = null) {
        const lines = [];
        const picks = [];
        const add = (line) => lines.push(deviceName ? message('benchmarkDeviceLine', '{device} · {line}', { device: deviceName, line }) : line);
        for (const run of runs) {
            const codec = CODEC_LABELS[run.codec] || run.codec;
            if (run.error === 'UNSUPPORTED') {
                add(deviceName
                    ? message('benchmarkDeviceCodecUnsupported', "{codec}: this GPU can't encode it, so it was not tested", { codec })
                    : message('benchmarkCodecUnsupported', '{codec}: not supported on this computer', { codec }));
            } else if (run.error) add(message('benchmarkCodecFailed', '{codec}: benchmark failed ({code})', { codec, code: run.error }));
            else if (run.best) {
                const saved = run.results.find((entry) => entry.level === run.best.level)?.savedPercent;
                add(message('benchmarkCodecBest', '{codec}: fastest at {count} at once — {rate} files/min, saves {saved}', {
                    codec, count: run.best.level, rate: formatRate(run.best.filesPerMinute),
                    saved: Number.isFinite(saved) ? `${saved}%` : '—'
                }));
                picks.push({ codec: run.codec, level: run.best.level });
                if (run.efficient && Number.isFinite(run.efficient.filesPerWh)) {
                    add(message('benchmarkCodecEfficient', '{codec}: most efficient at {count} at once — {rate} files per kWh at {watts} W', {
                        codec, count: run.efficient.level, rate: filesPerKwh(run.efficient.filesPerWh),
                        watts: Number.isFinite(run.efficient.avgW) ? Math.round(run.efficient.avgW) : '—'
                    }));
                }
            } else if (Array.isArray(run.results) && run.results.length) {
                const codes = [...new Set(run.results.flatMap((entry) => entry.failures || []))];
                add(message('benchmarkCodecAllFailed', '{codec}: no setting finished ({codes})', { codec, codes: codes.join(', ') || '—' }));
            }
            if (Array.isArray(run.skipped) && run.skipped.length) {
                add(message('benchmarkCodecSkipped', '{codec}: left out {count} clip(s) that fail on their own: {clips}', {
                    codec, count: run.skipped.length,
                    clips: run.skipped.map((entry) => `${entry.name} (${entry.code})`).join(', ')
                }));
            }
        }
        return { lines, picks };
    }

    function useLabel(pick) {
        return message('benchmarkUseCodec', 'Use {codec} · {count} at once',
            { codec: CODEC_LABELS[pick.codec] || pick.codec, count: pick.level });
    }

    function benchmarkEncoders(runs) {
        return runs.filter((run) => !run.error && run.encoder)
            .map((run) => message('benchmarkCodecEncoder', '{codec} on {encoder}', { codec: CODEC_LABELS[run.codec] || run.codec, encoder: encoderLabel(run.encoder) }));
    }

    function renderBenchmark(result) {
        const doc = elements.benchmarkRows?.ownerDocument || elements.benchmarkDevices?.ownerDocument || globalThis.document;
        const cell = (tag, text, className) => {
            const node = doc.createElement(tag);
            node.textContent = text;
            if (className) node.className = className;
            return node;
        };
        if (Array.isArray(result?.devices)) {
            renderDeviceBenchmark(result.devices, doc, cell);
            return;
        }
        benchmarkGpus = [];
        elements.benchmarkDevices?.replaceChildren?.();
        setHidden(elements.benchmarkDevices, true);
        const runs = benchmarkRuns(result);
        const target = {
            head: elements.benchmarkHead, rows: elements.benchmarkRows, table: elements.benchmarkTable,
            verifyHead: elements.benchmarkVerifyHead, verifyRows: elements.benchmarkVerifyRows, verifyTable: elements.benchmarkVerifyTable
        };
        renderResultsTable(target, runs, doc, cell);
        renderVerifyComparison(target, runs, doc, cell);

        const { lines, picks } = benchmarkLines(runs);
        benchmarkPicks = picks;
        benchmarkBest = benchmarkPicks[0] || null;
        setText(elements.benchmarkBest, lines.join('\n'));
        setHidden(elements.benchmarkBest, lines.length === 0);
        [elements.benchmarkApply, elements.benchmarkApplyAlt].forEach((button, index) => {
            const pick = benchmarkPicks[index];
            setHidden(button, !pick);
            if (pick) setText(button, useLabel(pick));
        });
        const encoders = benchmarkEncoders(runs);
        const clips = Math.max(0, ...runs.map((run) => run.clips || 0));
        setText(elements.benchmarkStatus, message('benchmarkDone', 'Done — {clips} real clips converted with {encoder}.',
            { clips, encoder: encoders.join(', ') || '—' }));
    }

    // A { devices } result: every GPU was benchmarked alone, one after
    // another, so each gets a section of its own (its tables, its lines and
    // Use buttons that set its row), in place of the dialog's single tables.
    function renderDeviceBenchmark(entries, doc, cell) {
        for (const element of [elements.benchmarkTable, elements.benchmarkVerifyTable, elements.benchmarkBest,
            elements.benchmarkApply, elements.benchmarkApplyAlt]) setHidden(element, true);
        benchmarkPicks = [];
        benchmarkBest = null;
        const listed = entries.filter((entry) => entry?.device && typeof entry.device.id === 'string' && entry.device.id);
        const names = deviceLabels(listed.map((entry) => ({ ...entry.device, name: String(entry.device.name || entry.device.id) })));
        benchmarkGpus = listed.map((entry, index) => {
            const id = entry.device.id;
            // the same name as its row in Parallel conversions
            const name = laneDevices?.find((device) => device.id === id)?.label || names[index];
            const runs = Array.isArray(entry.codecs) ? entry.codecs.filter(Boolean) : [];
            return { id, name, runs, ...benchmarkLines(runs, name) };
        });
        const sections = benchmarkGpus.map(({ id, name, runs, lines, picks }) => {
            const section = doc.createElement('section');
            section.className = 'converter-benchmark-device';
            section.setAttribute('data-device', id);
            section.append(cell('h4', name));
            const encoders = benchmarkEncoders(runs);
            if (encoders.length) section.append(cell('p', encoders.join(', '), 'converter-disclosure'));
            const table = cell('table', '', 'converter-benchmark-table');
            const head = doc.createElement('thead');
            const rows = doc.createElement('tbody');
            table.append(head, rows);
            const verifyTable = cell('table', '', 'converter-benchmark-table converter-benchmark-verify');
            const verifyHead = doc.createElement('thead');
            const verifyRows = doc.createElement('tbody');
            verifyTable.append(cell('caption', message('benchmarkVerifyCaption', "Verification modes at each codec's fastest setting: files per minute (verification time per clip)")),
                verifyHead, verifyRows);
            const target = { head, rows, table, verifyHead, verifyRows, verifyTable };
            renderResultsTable(target, runs, doc, cell);
            renderVerifyComparison(target, runs, doc, cell);
            section.append(table, verifyTable);
            if (lines.length) section.append(cell('p', lines.join('\n'), 'converter-benchmark-best'));
            // a GPU without a row in Parallel conversions has nothing to set
            if (laneRows.has(id) && picks.length) {
                const actions = cell('div', '', 'converter-benchmark-actions');
                actions.append(...picks.map((pick) => {
                    const button = cell('button', useLabel(pick), 'converter-benchmark-action');
                    button.type = 'button';
                    button.setAttribute('aria-label', message('benchmarkUseCodecOn', 'Use {codec} · {count} at once on {device}',
                        { codec: CODEC_LABELS[pick.codec] || pick.codec, count: pick.level, device: name }));
                    button.addEventListener('click', () => applyDeviceBenchmark(id, pick));
                    return button;
                }));
                section.append(actions);
            }
            return section;
        });
        // The same codec on every GPU at once, each at its own best
        const together = Object.keys(CODEC_LABELS).map((codec) => ({
            codec,
            levels: benchmarkGpus.filter((entry) => laneRows.has(entry.id))
                .map((entry) => ({ name: entry.name, level: entry.picks.find((pick) => pick.codec === codec)?.level }))
                .filter((entry) => Number.isSafeInteger(entry.level))
        })).filter((entry) => entry.levels.length >= 2);
        if (together.length) {
            const block = cell('div', '', 'converter-benchmark-combined');
            const actions = cell('div', '', 'converter-benchmark-actions');
            actions.append(...together.map(({ codec, levels }) => {
                const button = cell('button', message('benchmarkUseEveryGpu', 'Use {codec} on every GPU ({levels})', {
                    codec: CODEC_LABELS[codec],
                    levels: levels.map((entry) => `${shortDeviceName(entry.name)}: ${entry.level}`).join(' · ')
                }), 'converter-benchmark-action');
                button.type = 'button';
                button.addEventListener('click', () => applyEveryGpu(codec));
                return button;
            }));
            block.append(actions, cell('p', message('benchmarkEveryGpuNote',
                'Each GPU was tested alone; together they share the CPU and drives, so the total can be a little lower.'), 'converter-disclosure'));
            sections.push(block);
        }
        elements.benchmarkDevices?.replaceChildren?.(...sections);
        setHidden(elements.benchmarkDevices, sections.length === 0);
        const clips = Math.max(0, ...benchmarkGpus.flatMap((entry) => entry.runs.map((run) => run.clips || 0)));
        setText(elements.benchmarkStatus, message('benchmarkDoneDevices', 'Done — {clips} real clips converted on each of {count} GPUs, one GPU at a time.',
            { clips, count: benchmarkGpus.length }));
    }

    async function runBenchmark() {
        if (benchmarkRunning || typeof api.runConverterBenchmark !== 'function') return;
        benchmarkRunning = true;
        benchmarkBest = null;
        setDisabled(elements.benchmarkRun, true);
        setHidden(elements.benchmarkApply, true);
        setHidden(elements.benchmarkApplyAlt, true);
        setHidden(elements.benchmarkVerifyTable, true);
        setHidden(elements.benchmarkBest, true);
        setHidden(elements.benchmarkDevices, true);
        setText(elements.benchmarkStatus, message('benchmarkScanning', 'Finding sample clips in your source folder…'));
        try {
            const profileId = selectedProfile();
            const bitrateKbps = profileId === 'custom' ? customBitrateKbps() : undefined;
            if (profileId === 'custom' && bitrateKbps === null) throw apiError('BITRATE_INVALID');
            const request = {
                codecs: ['h265', 'av1'],
                verifyMode: selectedVerifyMode(),
                profileId,
                ...profileSettings(profileId),
                sourceRoot: elements.sourcePath?.value?.trim() || null
            };
            const result = unwrap(await api.runConverterBenchmark(request, (progress) => {
                let text = null;
                if (progress?.step === 'copy') {
                    text = message('benchmarkCopying', 'Copying sample clip {index} of {total}…',
                        { index: progress.index, total: progress.total });
                } else if (progress?.step === 'verify') {
                    text = message('benchmarkVerifyProgress',
                        '{codec}: timing verification {mode} at {count} at once… ({index} of {total})',
                        { codec: CODEC_LABELS[progress.codec] || progress.codec || '', mode: verifyLabel(progress.verifyMode),
                            count: progress.level, index: progress.index, total: progress.total });
                } else if (progress?.step === 'run' && progress.codec) {
                    text = message('benchmarkCodecProgress',
                        '{codec} ({codecIndex} of {codecTotal}): converting with {count} at once… ({index} of {total})',
                        { codec: CODEC_LABELS[progress.codec] || progress.codec, codecIndex: progress.codecIndex, codecTotal: progress.codecTotal,
                            count: progress.level, index: progress.index, total: progress.total });
                } else if (progress?.step === 'run') {
                    text = message('benchmarkTestingLevel',
                        'Converting with {count} at once… ({index} of {total})',
                        { count: progress.level, index: progress.index, total: progress.total });
                }
                if (text === null) return;
                // several GPUs are tested one after another: which one now
                if (progress.device && typeof progress.device === 'object') {
                    text = message('benchmarkDeviceProgress', '{device} ({index} of {total}) · {step}', {
                        device: laneDevices?.find((device) => device.id === progress.device.id)?.label || progress.device.name || progress.device.id,
                        index: progress.deviceIndex, total: progress.deviceTotal, step: text
                    });
                }
                setText(elements.benchmarkStatus, text);
            }));
            renderBenchmark(result);
        } catch (error) {
            setText(elements.benchmarkStatus, error?.code === 'BITRATE_INVALID'
                ? message('errorBitrateInvalid', 'Enter a bitrate between 0.25 and 100 Mbps.') : benchmarkErrorText(error));
        } finally {
            benchmarkRunning = false;
            setDisabled(elements.benchmarkRun, false);
        }
    }

    function closeBenchmark() {
        if (benchmarkRunning) void Promise.resolve(api.cancelConverterBenchmark?.()).catch(() => {});
        elements.benchmarkDialog?.close?.();
    }

    function selectCodec(codec) {
        for (const option of elements.codecOptions || []) option.checked = option.dataset?.converterCodec === codec;
        renderLanes();
    }

    function applyBenchmark(index = 0) {
        const pick = benchmarkPicks[index];
        if (!pick) return;
        setConcurrency(pick.level);
        rememberConcurrency(pick.level);
        // one GPU's result with rows per GPU: it was measured on the default GPU
        if (lanesMode()) {
            const target = defaultFor(pick.codec) ?? laneDevices[0].id;
            for (const device of laneDevices) laneCounts.set(device.id, device.id === target ? pick.level : 0);
            rememberLanes();
        }
        selectCodec(pick.codec);
        notify(message('benchmarkAppliedCodec', 'Set to {codec} with {count} parallel conversions.',
            { codec: CODEC_LABELS[pick.codec] || pick.codec, count: pick.level }), { type: 'info' });
        elements.benchmarkDialog?.close?.();
    }

    // A GPU section's Use button: that GPU's row only
    function applyDeviceBenchmark(id, pick) {
        if (!laneRows.has(id)) return;
        laneCounts.set(id, pick.level);
        rememberLanes();
        selectCodec(pick.codec);
        notify(message('benchmarkAppliedDevice', 'Set {device} to {count} at once with {codec}.',
            { device: laneLabel(id), count: pick.level, codec: CODEC_LABELS[pick.codec] || pick.codec }), { type: 'info' });
        elements.benchmarkDialog?.close?.();
    }

    // Use <codec> on every GPU: each GPU at its own best for it (a GPU
    // without one is Off), the CPU Off
    function applyEveryGpu(codec) {
        const levels = [];
        for (const entry of benchmarkGpus) {
            if (!laneRows.has(entry.id)) continue;
            const level = entry.picks.find((pick) => pick.codec === codec)?.level ?? 0;
            laneCounts.set(entry.id, level);
            if (level > 0) levels.push(message('lanesLiveEntry', '{count} on {device}', { count: level, device: entry.name }));
        }
        for (const device of laneDevices || []) if (device.kind === 'cpu' || device.id === 'cpu') laneCounts.set(device.id, 0);
        rememberLanes();
        selectCodec(codec);
        notify(message('benchmarkAppliedEveryGpu', 'Set to {codec} with {levels}.',
            { codec: CODEC_LABELS[codec] || codec, levels: joinList(levels, message('lanesAnd', 'and')) }), { type: 'info' });
        elements.benchmarkDialog?.close?.();
    }

    function applySnapshot(next, revision = next?.revision) {
        if (!next || !Number.isSafeInteger(revision) || revision < latestRevision) return false;
        const progressOnly = Object.keys(next).every((key) => ['id', 'revision', 'progress'].includes(key));
        if (Number.isFinite(next.progress?.fps)) lastFps = { value: next.progress.fps, at: Date.now() };
        if (Number.isSafeInteger(next.progress?.waitingOnNode)) {
            nodeWaiting = {
                jobId: next.id ?? snapshot?.id ?? null,
                count: next.progress.waitingOnNode,
                encoding: Number.isSafeInteger(next.progress.encodingNow) ? next.progress.encodingNow : null
            };
        }
        if (progressOnly && snapshot) snapshot = { ...snapshot, progress: next.progress };
        else {
            snapshot = { ...next };
            if (!Object.prototype.hasOwnProperty.call(next, 'progress')) delete snapshot.progress;
            syncConfig(snapshot.config);
        }
        latestRevision = revision;
        render();
        return true;
    }

    function handleProgress(payload) {
        if (!payload || typeof payload.jobId !== 'string' || !payload.snapshot) return;
        if (pendingStartEvents && (!snapshot?.id || payload.jobId !== snapshot.id)) {
            let buffered = pendingStartEvents.get(payload.jobId);
            if (!buffered) {
                if (pendingStartEvents.size >= 8) return;
                buffered = { full: null, progress: null };
                pendingStartEvents.set(payload.jobId, buffered);
            }
            const progressOnly = Object.keys(payload.snapshot)
                .every((key) => ['id', 'revision', 'progress'].includes(key));
            const slot = progressOnly ? 'progress' : 'full';
            if (!buffered[slot] || payload.revision >= buffered[slot].revision) buffered[slot] = payload;
            return;
        }
        if (snapshot?.id && payload.jobId !== snapshot.id) {
            // A new job (e.g. an automatic one) replaces a finished one on screen.
            const progressOnly = Object.keys(payload.snapshot).every((key) => ['id', 'revision', 'progress'].includes(key));
            if (progressOnly || !['completed', 'failed', 'cancelled'].includes(snapshot.state)) return;
            snapshot = null;
            latestRevision = -1;
            // (which vehicle the automatic run is on now)
            void refreshAuto();
        }
        applySnapshot(payload.snapshot, payload.revision);
    }

    // ---- Automatic conversion -------------------------------------------
    let autoState = null;
    let autoTimer = null;

    function clockTime(ms) {
        try {
            return new Date(ms).toLocaleTimeString(getLocale(), { hour: 'numeric', minute: '2-digit' });
        } catch (_) {
            return new Date(ms).toLocaleTimeString();
        }
    }

    // Automatic conversion is per source folder (one per vehicle): the
    // checkbox is for the folder chosen above; the schedule is shared.
    const currentSource = () => elements.sourcePath?.value?.trim() || '';
    const autoConfigs = () => (Array.isArray(autoState?.settings?.configs) ? autoState.settings.configs : []);
    const autoConfigFor = (sourceRoot) => autoConfigs().find((config) => config.sourceRoot === sourceRoot) || null;
    // the web version names a folder by its vehicle
    function sourceLabel(sourceRoot) {
        try {
            const named = typeof globalThis.sentrySourceLabel === 'function' ? globalThis.sentrySourceLabel(sourceRoot) : null;
            if (named) return String(named);
        } catch (_) { /* the folder itself */ }
        return String(sourceRoot).split(/[\\/]/).filter(Boolean).pop() || String(sourceRoot);
    }

    function renderAutoList() {
        const list = elements.autoList;
        const documentRef = list?.ownerDocument || globalThis.document;
        if (!list || typeof list.replaceChildren !== 'function' || typeof documentRef?.createElement !== 'function') return;
        const configs = autoConfigs();
        list.hidden = configs.length === 0;
        const status = autoState?.status || {};
        list.replaceChildren(...configs.map((config) => {
            const item = documentRef.createElement('li');
            const name = documentRef.createElement('strong');
            name.textContent = sourceLabel(config.sourceRoot);
            const detail = documentRef.createElement('span');
            const codec = config.codec === 'av1' ? 'AV1' : 'H.265';
            const output = config.outputMode === 'separate' ? message('autoListSeparate', 'separate folder') : message('autoListReplace', 'replaces originals');
            const waiting = Number(status.pending?.[config.sourceRoot]) || 0;
            const busy = status.active?.[config.sourceRoot] || (status.activeJobId && status.activeSource === config.sourceRoot)
                ? ` · ${status.active?.[config.sourceRoot]?.pausedForDevices ? message('autoListWaitingDevice', 'waiting for a free device') : message('autoListActive', 'converting now')}`
                : waiting > 0 ? ` · ${message('autoListWaiting', '{count} new clips waiting', { count: waiting })}` : '';
            detail.textContent = ` ${codec} · ${output}${busy}`;
            item.append(name, detail);
            if (config.sourceRoot === currentSource()) item.className = 'current';
            return item;
        }));
    }

    function renderAuto() {
        const settings = autoState?.settings;
        const status = autoState?.status || {};
        if (!settings) return;
        if (elements.autoEnabled) elements.autoEnabled.checked = Boolean(autoConfigFor(currentSource()));
        if (elements.autoInterval) elements.autoInterval.value = String(settings.intervalMinutes || 60);
        const offPeak = settings.window?.follow === 'off-peak';
        if (elements.autoWindowEnabled) elements.autoWindowEnabled.checked = Boolean(settings.window) && !offPeak;
        if (elements.autoOffPeak) elements.autoOffPeak.checked = offPeak;
        if (elements.autoHoldManual) elements.autoHoldManual.checked = settings.holdManual === true;
        setDisabled(elements.autoHoldManual, !settings.window);
        if (settings.window && !offPeak) {
            if (elements.autoStart) elements.autoStart.value = String(settings.window.startHour);
            if (elements.autoEnd) elements.autoEnd.value = String(settings.window.endHour);
        }
        if (elements.autoKeepRunning) elements.autoKeepRunning.checked = settings.keepRunning === true;
        if (elements.autoLogin) elements.autoLogin.checked = settings.openAtLogin === true;
        for (const control of [elements.autoStart, elements.autoEnd]) setDisabled(control, !settings.window || offPeak);
        setDisabled(elements.autoCheckNow, !settings.enabled || status.checking === true);
        renderAutoList();
        renderAutoStatus();
    }

    // Status line only (also refreshed with job updates, e.g. a pause).
    function renderAutoStatus() {
        const settings = autoState?.settings;
        const status = autoState?.status || {};
        if (!settings) return;
        let text;
        const source = currentSource();
        const mine = Boolean(autoConfigFor(source));
        const others = autoConfigs().filter((config) => config.sourceRoot !== source).length;
        // several vehicles may convert at once (each on its own devices)
        const running = status.active && typeof status.active === 'object' ? status.active : {};
        const own = running[source] || (status.activeSource === source && status.activeJobId ? { jobId: status.activeJobId, pausedForWindow: status.pausedForWindow } : null);
        const elsewhere = !own && status.activeSource && status.activeSource !== source;
        const jobId = own?.jobId || null;
        if (!settings.enabled) text = message('autoOff', 'Off');
        else if (!mine && !status.activeSource) {
            text = message('autoOffHere', 'Off for this source · {count} other(s) convert automatically', { count: others });
        } else if (elsewhere) {
            text = status.activeJobId
                ? message('autoConvertingOther', 'Converting {name}\'s new clips…', { name: sourceLabel(status.activeSource) })
                : message('autoCheckingOther', 'Checking {name} for new clips…', { name: sourceLabel(status.activeSource) });
        } else if (status.checking) text = message('autoChecking', 'Checking for new clips…');
        else if (jobId && own.pausedForDevices) {
            text = message('autoWaitingDevice', 'Waiting for a free GPU or node — another vehicle comes first on it');
        } else if (jobId && own.pausedForWindow && settings.window?.follow === 'off-peak') {
            text = message('autoPausedPeak', 'Paused while electricity costs more — resumes when off-peak starts');
        } else if (jobId && own.pausedForWindow) {
            text = message('autoPausedWindow', 'Paused outside the time window — resumes at {time}', {
                time: clockTime(new Date().setHours(settings.window?.startHour ?? 0, 0, 0, 0))
            });
        } else if (jobId && snapshot?.id === jobId && snapshot.state === 'paused') {
            // Paused by the user: it waits for them.
            text = message('autoJobPaused', 'Automatic conversion is paused — resume or cancel it above');
        } else if (jobId) text = message('autoConverting', 'Converting new clips…');
        else {
            const parts = [];
            // this folder's own last check
            const last = status.sources?.[source] || {};
            if (last.error) parts.push(message('autoError', 'Last check failed: {code}', { code: last.error }));
            else if (Number.isSafeInteger(last.lastNewFiles)) {
                parts.push(last.lastNewFiles === 0
                    ? message('autoNoneNew', 'No new clips at {time}', { time: clockTime(last.lastCheckAt) })
                    : message('autoFoundNew', '{count} new clips found at {time}', { count: last.lastNewFiles, time: clockTime(last.lastCheckAt) }));
            }
            if (status.nextCheckAt) parts.push(message('autoNext', 'Next check {time}', { time: clockTime(status.nextCheckAt) }));
            else parts.push(message('autoSoon', 'Checks shortly'));
            text = parts.join(' · ');
        }
        setText(elements.autoStatus, text);
    }

    async function refreshAuto() {
        if (typeof api.getConverterAuto !== 'function') return;
        try {
            autoState = unwrap(await api.getConverterAuto());
            renderAuto();
        } catch (_) { /* automatic conversion unavailable */ }
    }

    function hourValue(control, fallback) {
        const value = Number(control?.value);
        return Number.isSafeInteger(value) && value >= 0 && value <= 23 ? value : fallback;
    }

    async function saveAuto() {
        if (typeof api.setConverterAuto !== 'function') return;
        const enabled = elements.autoEnabled?.checked === true;
        try {
            const windowOn = elements.autoWindowEnabled?.checked === true;
            const window = elements.autoOffPeak?.checked === true ? { follow: 'off-peak' }
                : windowOn ? { startHour: hourValue(elements.autoStart, 1), endHour: hourValue(elements.autoEnd, 6) } : null;
            if (window && !window.follow && window.startHour === window.endHour) throw apiError('AUTO_WINDOW_INVALID');
            const source = currentSource();
            const settings = {
                enabled,
                intervalMinutes: Number(elements.autoInterval?.value) || 60,
                window,
                holdManual: Boolean(window) && elements.autoHoldManual?.checked === true,
                keepRunning: elements.autoKeepRunning?.checked === true,
                openAtLogin: elements.autoLogin?.checked === true,
                // Turning it on (or changing an option while on) saves the
                // job settings above for this source's automatic runs;
                // turning it off removes only this source.
                ...(enabled ? { config: configFromControls() } : autoConfigFor(source) ? { removeSource: source } : {})
            };
            autoState = unwrap(await api.setConverterAuto(settings));
        } catch (error) {
            notify(describeError(error), { type: 'error' });
            await refreshAuto();
            return;
        }
        renderAuto();
    }

    async function checkAutoNow() {
        if (typeof api.checkConverterAutoNow !== 'function') return;
        try {
            autoState = unwrap(await api.checkConverterAutoNow());
            renderAuto();
        } catch (error) {
            notify(describeError(error), { type: 'error' });
        }
    }

    async function chooseFolder(purpose) {
        try {
            const field = purpose === 'source' ? elements.sourcePath : elements.destinationPath;
            const chosen = unwrap(await api.chooseConverterFolder(purpose, field?.value || undefined));
            if (chosen && field) {
                field.value = chosen;
                updateOutputMode();
            }
        } catch (error) {
            notify(message('folderSelectionFailed', 'Folder selection failed: {code}', { code: error.code || 'OPERATION_FAILED' }), { type: 'error' });
        }
    }

    function configFromControls() {
        const sourceRoot = elements.sourcePath?.value?.trim();
        const outputMode = selected(elements.outputOptions, 'converterOutput', 'separate');
        const destinationRoot = elements.destinationPath?.value?.trim();
        const includedGroups = elements.groupOptions
            .filter((entry) => entry.checked)
            .map((entry) => entry.dataset?.converterGroup)
            .filter((group) => GROUPS.includes(group));
        if (!sourceRoot) throw apiError('SOURCE_REQUIRED');
        if (includedGroups.length === 0) throw apiError('GROUP_REQUIRED');
        if (outputMode === 'separate' && !destinationRoot) throw apiError('DESTINATION_REQUIRED');
        if (outputMode === 'replace') {
            if (capabilities.replacement !== 'available') throw apiError('REPLACEMENT_UNAVAILABLE');
            if (elements.replacementConfirmation?.checked !== true) throw apiError('REPLACEMENT_CONFIRMATION_REQUIRED');
            if (!confirmAction(message(
                'replacementConfirm',
                'Replace originals in {sourceRoot}? Each original is backed up first, and a failed replacement restores that backup for rollback.',
                { sourceRoot }
            ))) throw apiError('REPLACEMENT_CONFIRMATION_REQUIRED');
        }
        const profileId = selectedProfile();
        if (profileId === 'custom' && customBitrateKbps() === null) throw apiError('BITRATE_INVALID');
        // { concurrency } as always, or with several GPUs { concurrency, lanes }
        const parallel = lanesMode() ? lanesConfig() : { concurrency: selectedConcurrency() };
        return {
            sourceRoot,
            destinationRoot: outputMode === 'replace' ? null : destinationRoot,
            codec: selected(elements.codecOptions, 'converterCodec', 'h265'),
            profileId,
            ...profileSettings(profileId),
            networkMode: 'auto',
            outputMode,
            includedGroups,
            groupOrder: [...groupOrder],
            replacementConfirmed: outputMode === 'replace',
            ...parallel,
            verifyMode: selectedVerifyMode()
        };
    }

    function describeError(error) {
        const labels = {
            SOURCE_REQUIRED: ['errorSourceRequired', 'Choose a source folder before starting.'],
            DESTINATION_REQUIRED: ['errorDestinationRequired', 'Choose a destination folder for separate output.'],
            BITRATE_INVALID: ['errorBitrateInvalid', 'Enter a bitrate between 0.25 and 100 Mbps.'],
            GROUP_REQUIRED: ['errorGroupRequired', 'Select at least one Tesla clip group.'],
            REPLACEMENT_CONFIRMATION_REQUIRED: ['errorReplacementConfirmation', 'Acknowledge and confirm replacement before starting.'],
            REPLACEMENT_UNAVAILABLE: ['errorReplacementUnavailable', 'Replace originals is not available on this system.'],
            AUTO_WINDOW_INVALID: ['errorAutoWindow', 'Choose different start and end hours for the time window.'],
            RECOVERY_REQUIRED: ['errorRecoveryRequired', 'This job stopped in the middle of replacing an original. Resume it to finish safely.'],
            INVALID_MANIFEST: ['errorInvalidManifest', "This job's saved record couldn't be updated. Use Cancel to set it aside."],
            LANES_EMPTY: ['errorLanesEmpty', 'Turn on a GPU or the CPU under Parallel conversions first.'],
            LANES_TOO_MANY: ['errorLanesTooMany', 'Up to {max} conversions at once in total.'],
            INVALID_LANES: ['errorInvalidLanes', "These GPU settings can't be used. Reload the page and set them again."]
        };
        if (error?.code === 'DEVICE_UNSUPPORTED') {
            const codec = error.details?.codec || selectedCodec();
            return message('errorDeviceUnsupported', "{device} can't encode {codec}. Set it to Off or pick another codec.", {
                device: error.details?.device || message('errorDeviceUnknown', 'One of the GPUs'),
                codec: CODEC_LABELS[codec] || codec
            });
        }
        if (error?.code === 'LANES_TOO_MANY') return message(...labels.LANES_TOO_MANY, { max: MAX_CONCURRENCY });
        return labels[error?.code]
            ? message(...labels[error.code])
            : message('errorActionFailed', 'Converter action failed: {code}', { code: error?.code || 'OPERATION_FAILED' });
    }

    async function start() {
        pendingStartEvents = new Map();
        try {
            const config = configFromControls();
            const result = unwrap(await api.startConverter(config));
            const buffered = pendingStartEvents.get(result.jobId);
            pendingStartEvents = null;
            const createdAt = Date.now();
            snapshot = null;
            latestRevision = -1;
            applySnapshot({
                id: result.jobId,
                state: 'discovering',
                revision: 0,
                createdAt,
                updatedAt: createdAt,
                config,
                items: [],
                counters: { sourceVideoBytes: 0 },
                summary: null
            }, 0);
            if (buffered?.full) applySnapshot(buffered.full.snapshot, buffered.full.revision);
            if (buffered?.progress) applySnapshot(buffered.progress.snapshot, buffered.progress.revision);
        } catch (error) {
            pendingStartEvents = null;
            notify(describeError(error), { type: 'error' });
        }
    }

    async function command(method, { confirmMessage } = {}) {
        if (!snapshot?.id || typeof api[method] !== 'function') return;
        if (confirmMessage && !confirmAction(confirmMessage)) return;
        try {
            const next = unwrap(await api[method](snapshot.id));
            if (next) applySnapshot(next, next.revision);
        } catch (error) {
            notify(describeError(error), { type: 'error' });
        }
    }

    // Cancel, and if the job cannot be ended normally (for example it was left
    // half-saved by a crash or its record can't be read), offer to set it aside
    // so the converter is usable again without touching any folders by hand.
    async function cancelJob() {
        if (!snapshot?.id || typeof api.cancelConverter !== 'function') return;
        if (!confirmAction(message('cancelConfirm', 'Cancel this conversion job after owned temporary files are reconciled?'))) return;
        const jobId = snapshot.id;
        try {
            const next = unwrap(await api.cancelConverter(jobId));
            if (next) applySnapshot(next, next.revision);
            return;
        } catch (error) {
            if (typeof api.discardConverterJob !== 'function') {
                notify(describeError(error), { type: 'error' });
                return;
            }
        }
        if (!confirmAction(message('discardConfirm', "This job can't be ended normally. Set it aside so you can start fresh? Files already converted are kept."))) return;
        try {
            const current = unwrap(await api.discardConverterJob(jobId));
            snapshot = null;
            latestRevision = -1;
            if (current) applySnapshot(current, current.revision);
            else render();
            notify(message('discarded', 'The job was set aside. Files already converted were kept.'), { type: 'info' });
        } catch (error) {
            notify(describeError(error), { type: 'error' });
        }
    }

    function bind() {
        elements.sourceButton?.addEventListener('click', () => chooseFolder('source'));
        elements.destinationButton?.addEventListener('click', () => chooseFolder('destination'));
        for (const option of elements.outputOptions) option.addEventListener?.('change', updateOutputMode);
        for (const item of elements.orderRows || []) {
            item.up?.addEventListener('click', () => moveGroup(item.group, 'up'));
            item.down?.addEventListener('click', () => moveGroup(item.group, 'down'));
        }
        setConcurrency(storedConcurrency() ?? DEFAULT_CONCURRENCY);
        if (elements.verifyMode) elements.verifyMode.value = storedVerifyMode() ?? 'quick';
        elements.verifyMode?.addEventListener?.('change', () => {
            updateVerifyOptions();
            try { storage?.setItem?.(VERIFY_STORAGE_KEY, selectedVerifyMode()); } catch (_) { /* preference only */ }
        });
        updateVerifyOptions();
        elements.profileSelect?.addEventListener?.('change', updateCustomBitrateVisibility);
        updateCustomBitrateVisibility();
        // During a run the new number applies to the running job right away:
        // more starts new conversions now, fewer lets the extra ones finish
        // their clip first. No cancel needed (also for automatic jobs).
        // Changes are sent one after another, so the last choice always wins.
        function liveConcurrency(value) {
            if (!snapshot?.id || !ACTIVE_STATES.has(snapshot.state) || typeof api.setConverterConcurrency !== 'function') return;
            if (value === (requestedConcurrency ?? Number(snapshot.config?.concurrency))) return;
            requestedConcurrency = value;
            const jobId = snapshot.id;
            liveChain = liveChain.then(async () => {
                try {
                    const next = unwrap(await api.setConverterConcurrency(jobId, value));
                    if (next) applySnapshot(next, next.revision);
                    if (requestedConcurrency === value) notify(message('concurrencyLive', 'Now {count} at once. Clips already converting finish first.', { count: value }));
                } catch (error) {
                    notify(describeError(error), { type: 'error' });
                    if (requestedConcurrency === value && snapshot?.config) {
                        syncedConcurrency = null;
                        syncConfig(snapshot.config);
                    }
                } finally {
                    if (requestedConcurrency === value) requestedConcurrency = null;
                }
            });
        }
        // which GPUs can encode the codec decides which rows can be set; rows
        // nobody has set yet follow the codec's default GPU
        for (const option of elements.codecOptions || []) {
            option.addEventListener?.('change', () => {
                if (lanesMode() && lanesUntouched && !jobActive()) firstTimeLanes();
                renderLanes();
            });
        }
        elements.concurrency?.addEventListener?.('change', () => {
            updateConcurrencyCustomVisibility();
            if (customConcurrencySelected()) elements.concurrencyCustom?.focus?.();
            // Custom… only opens the box; the number typed there is what counts
            if (customConcurrencySelected()) return;
            const value = selectedConcurrency();
            if (normalizeConcurrency(elements.concurrency.value) !== null) {
                rememberConcurrency(value);
                liveConcurrency(value);
            }
        });
        elements.concurrencyCustom?.addEventListener?.('change', () => {
            const value = normalizeConcurrency(elements.concurrencyCustom.value);
            if (value === null) {
                const clamped = Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(Number(elements.concurrencyCustom.value)) || DEFAULT_CONCURRENCY));
                elements.concurrencyCustom.value = String(clamped);
                rememberConcurrency(clamped);
                liveConcurrency(clamped);
            } else {
                rememberConcurrency(value);
                liveConcurrency(value);
            }
        });
        elements.benchmarkButton?.addEventListener?.('click', () => elements.benchmarkDialog?.showModal?.());
        elements.benchmarkRun?.addEventListener?.('click', runBenchmark);
        elements.benchmarkApply?.addEventListener?.('click', () => applyBenchmark(0));
        elements.benchmarkApplyAlt?.addEventListener?.('click', () => applyBenchmark(1));
        elements.benchmarkClose?.addEventListener?.('click', closeBenchmark);
        elements.benchmarkDialog?.addEventListener?.('cancel', () => {
            if (benchmarkRunning) void Promise.resolve(api.cancelConverterBenchmark?.()).catch(() => {});
        });
        elements.startButton?.addEventListener('click', start);
        elements.pauseButton?.addEventListener('click', () => command('pauseConverter'));
        elements.resumeButton?.addEventListener('click', () => command('resumeConverter'));
        elements.cancelButton?.addEventListener('click', () => { void cancelJob(); });
        elements.retryButton?.addEventListener('click', () => command('retryFailedConverter'));
        elements.dismissButton?.addEventListener('click', () => command('dismissConverterSummary'));
        if (elements.autoStart && !elements.autoStart.value) elements.autoStart.value = '1';
        if (elements.autoEnd && (!elements.autoEnd.value || elements.autoEnd.value === '0')) elements.autoEnd.value = '6';
        // Fixed hours and off-peak are one choice or the other
        elements.autoWindowEnabled?.addEventListener?.('change', () => {
            if (elements.autoWindowEnabled.checked && elements.autoOffPeak) elements.autoOffPeak.checked = false;
        });
        elements.autoOffPeak?.addEventListener?.('change', () => {
            if (elements.autoOffPeak.checked && elements.autoWindowEnabled) elements.autoWindowEnabled.checked = false;
        });
        for (const control of [elements.autoEnabled, elements.autoInterval, elements.autoWindowEnabled, elements.autoOffPeak,
            elements.autoHoldManual, elements.autoStart, elements.autoEnd, elements.autoKeepRunning, elements.autoLogin]) {
            control?.addEventListener?.('change', () => saveAuto());
        }
        elements.autoCheckNow?.addEventListener?.('click', () => checkAutoNow());
        // another vehicle chosen: its own automatic setting
        for (const type of ['input', 'change']) elements.sourcePath?.addEventListener?.(type, () => renderAuto());
    }

    async function initialize() {
        if (initialized) return controller;
        initialized = true;
        bind();
        // not awaited: the page is drawn as usual and switches to one row per
        // GPU when (and if) the answer says there are several
        void loadDevices().catch(() => {});
        if (typeof api.onConverterProgress === 'function') unsubscribe = api.onConverterProgress(handleProgress);
        if (subscribeLanguage) {
            unsubscribeLanguage = subscribeLanguage(() => {
                updateOutputMode();
                renderLanes();
                render();
            });
        }
        await refreshAuto();
        if (typeof api.getConverterAuto === 'function' && options.autoPollMs !== 0) {
            autoTimer = setInterval(() => { void refreshAuto(); }, options.autoPollMs || 30_000);
        }
        try {
            updateCapabilities(unwrap(await api.getConverterCapabilities()));
            const current = unwrap(await api.getCurrentConverterJob());
            if (current) applySnapshot(current, current.revision);
            else render();
        } catch (error) {
            notify(describeError(error), { type: 'error' });
            render();
        }
        return controller;
    }

    const controller = Object.freeze({
        init() {
            if (!initPromise) initPromise = initialize();
            return initPromise;
        },
        setVisible(nextVisible) { visible = Boolean(nextVisible); },
        get visible() { return visible; },
        get snapshot() { return snapshot; },
        destroy() {
            if (autoTimer) clearInterval(autoTimer);
            autoTimer = null;
            unsubscribe?.();
            unsubscribe = null;
            unsubscribeLanguage?.();
            unsubscribeLanguage = null;
        }
    });
    return controller;
}

function createSidebarPanelSwitcher(options = {}) {
    const validPanels = new Set(['clips', 'drives', 'converter']);
    const tabs = options.tabs || [];
    let converterOpened = false;
    let converterPromise = null;
    async function switchSidebarPanel(panel) {
        if (!validPanels.has(panel)) return false;
        const converterActive = panel === 'converter';
        if (options.clipList) options.clipList.style.display = panel === 'clips' ? '' : 'none';
        if (options.driveList) options.driveList.style.display = panel === 'drives' ? '' : 'none';
        if (options.workspace) options.workspace.hidden = !converterActive;
        options.body?.classList?.toggle('converter-mode', converterActive);
        if (options.clipFilter) options.clipFilter.style.display = panel === 'clips' ? '' : 'none';
        if (options.driveFilter) options.driveFilter.style.display = panel === 'drives' ? '' : 'none';
        if (options.chooseFolderButton) options.chooseFolderButton.hidden = converterActive;
        for (const tab of tabs) {
            const active = tab.dataset?.panel === panel;
            tab.classList?.toggle('active', active);
            tab.setAttribute?.('aria-selected', active ? 'true' : 'false');
            tab.setAttribute?.('tabindex', active ? '0' : '-1');
        }
        if (panel === 'drives') options.onDrivesOpen?.();
        if (converterActive && !converterOpened) {
            converterOpened = true;
            converterPromise = Promise.resolve(options.onConverterOpen?.());
        }
        if (converterActive && converterPromise) await converterPromise;
        options.onPanelChange?.(panel);
        return true;
    }
    tabs.forEach((tab, index) => tab.addEventListener?.('keydown', async (event) => {
        let nextIndex = null;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;
        if (nextIndex === null) return;
        event.preventDefault?.();
        const nextTab = tabs[nextIndex];
        await switchSidebarPanel(nextTab.dataset?.panel);
        nextTab.focus?.();
    }));
    return switchSidebarPanel;
}

function initFootageConverter(options = {}) {
    const controller = createFootageConverterController({
        api: options.api || globalThis.window?.electronAPI,
        root: options.root || globalThis.document,
        notify: options.notify,
        t: options.t,
        getLocale: options.getLocale,
        onLanguageChange: options.onLanguageChange,
        confirm: options.confirm
    });
    return controller.init().then(() => controller);
}

export {
    createFootageConverterController,
    createSidebarPanelSwitcher,
    formatBytes,
    initFootageConverter
};
