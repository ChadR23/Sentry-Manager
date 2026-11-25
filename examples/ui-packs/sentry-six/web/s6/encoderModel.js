// Guided Encoder choices and wire settings. No page state or DOM dependencies.
export const LEVELS = [
  { id: 'std', name: 'Standard', profileId: 'balanced', pct: 20 },
  { id: 'med', name: 'Medium', profileId: 'aggressive', pct: 50, rec: true },
  { id: 'high', name: 'High', profileId: 'smallest', pct: 60 },
];
export const KEEP_CHIPS = [3, 7, 14, 30, 60];

export const statusNoun = (count, one, many = one + 's') => count === 1 ? one : many;

export function clipFailures(snapshot) {
  const rows = (snapshot?.items || []).filter((i) => i.state === 'failed');
  const codeOf = (i) => i.resultCode || i.failure?.code || i.code;
  const legacyGpu = (i) => codeOf(i) === 'frame-count-mismatch' && /_(nvenc|vaapi|qsv|amf)$/.test(i.encoder || '');
  const temporary = (i) => codeOf(i) === 'gpu-memory-exhausted' && (i.failure?.retryable ?? i.retryable) === true;
  const damaged = (i) => (i.failure?.retryable ?? i.retryable) === false &&
    !legacyGpu(i) && ['frame-count-mismatch', 'invalid-h264'].includes(codeOf(i));
  const groups = snapshot?.itemFailureCounts || rows.map((i) => ({...i, count:1}));
  const sum = (accept) => groups.filter(accept).reduce((n, g) => n + (Number(g.count) || 0), 0);
  const kept = sum(damaged), gpu = sum(temporary), legacy = sum(legacyGpu);
  const shortRows = (snapshot?.items || []).filter((i) => ['skipped','completed'].includes(i.state) && codeOf(i) === 'too-short');
  const tooShort = snapshot?.itemTooShortCount ?? shortRows.length;
  const retrying = snapshot?.itemGpuRetryCount ?? (snapshot?.items || []).filter((i) => ['queued','processing'].includes(i.state) && i.resultCode === 'gpu-memory-retry').length;
  const total = snapshot?.itemStateCounts?.failed ?? snapshot?.itemCounts?.failed ?? rows.length;
  const attention = Math.max(0, total - kept);
  const n = kept.toLocaleString();
  return {
    damaged:kept, tooShort, kept:kept + tooShort, attention, temporary:gpu, legacyGpu:legacy, retrying,
    retryingText:`${retrying.toLocaleString()} ${statusNoun(retrying, 'clip')} will be retried (the GPU ran out of memory)${['paused','paused_network'].includes(snapshot?.state) ? ' when you resume shrinking' : ''}.`,
    keptText:tooShort ? `${(kept + tooShort).toLocaleString()} ${statusNoun(kept + tooShort, 'clip')} kept as recorded` : `${n} damaged ${statusNoun(kept, 'clip')} kept as recorded`,
    explanation:[kept ? `${n} ${statusNoun(kept, 'clip')} ${kept === 1 ? 'has' : 'have'} damaged video. Shrinking would lose frames or produce unreadable video. ${kept === 1 ? 'The original was' : 'The originals were'} kept as recorded; nothing to do.` : '',
      tooShort ? `${tooShort.toLocaleString()} ${statusNoun(tooShort, 'clip')} ${tooShort === 1 ? 'is' : 'are'} too short to shrink. Kept as recorded; nothing to do.` : ''].filter(Boolean).join(' '),
    attentionText:[gpu ? `${gpu.toLocaleString()} ${statusNoun(gpu, 'clip')} could not finish because the GPU ran out of memory. ${gpu === 1 ? 'The original was' : 'The originals were'} kept. Retry with less pressure on the GPU.` : '', legacy ? `${legacy.toLocaleString()} ${statusNoun(legacy, 'clip')} lost frames during GPU encoding. The GPU may have been too busy; ${legacy === 1 ? 'the original was' : 'the originals were'} kept. Retry with less pressure to check.` : '',
      attention > gpu + legacy ? `${(attention-gpu-legacy).toLocaleString()} ${statusNoun(attention-gpu-legacy, 'clip')} could not be shrunk. ${attention-gpu-legacy === 1 ? 'The original was' : 'The originals were'} kept. Open Expert to review or retry ${attention-gpu-legacy === 1 ? 'it' : 'them'}.` : ''].filter(Boolean).join(' '),
    items:[...rows.filter(damaged), ...shortRows].map((i) => ({relativePath:i.relativePath || 'Unknown clip', code:codeOf(i),
      reason:codeOf(i) === 'too-short' ? 'Kept as recorded (too short to shrink).' : codeOf(i) === 'frame-count-mismatch' ? 'A smaller copy could not preserve every video frame.' : 'Some of the recorded video cannot be read.'})),
  };
}

export function currentFailureExplained(job, snapshot) {
  if (!snapshot || job.externalId !== `converter:${snapshot.id}` || snapshot.failure) return false;
  const issues = clipFailures(snapshot);
  return snapshot.state === 'completed' || issues.damaged + issues.attention + issues.retrying > 0;
}

function speedPerHour(result) {
  const devices = result?.devices;
  if (!devices?.length || devices.some((d) => !Number.isFinite(d.filesPerMinute) || d.filesPerMinute <= 0)) return null;
  return Math.round(devices.reduce((sum, d) => sum + d.filesPerMinute, 0) * 60);
}

export function speedEstimate(state, level) {
  const result = state?.result, rate = speedPerHour(result);
  return rate != null && result.profileId === LEVELS.find((l) => l.id === level)?.profileId
    ? `About ${rate.toLocaleString('en-US')} ${statusNoun(rate, 'clip')} an hour on your server` : '';
}

export function speedStatus(state, config, now = Date.now()) {
  const s = state || {}, result = s.result;
  const active = ['queued', 'waiting', 'running'].includes(s.phase);
  const canApply = !active && s.phase === 'done' && s.settingsSource === 'user' && !!result?.devices?.length;
  const names = (devices) => devices.map((d) => `${d.name || d.device || d.id} × ${d.concurrency}`).join(' and ');
  let summary = s.reason || (s.settingsSource === 'user' ? 'Your device settings are kept. Test again to compare them.' : 'A speed test will choose how many clips your server shrinks at once.');
  if (s.phase === 'running') {
    const p = s.progress || {}, seconds = Math.max(0, Math.floor((now - (s.startedAt || now)) / 1000));
    const elapsed = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
    const step = p.step === 'scan' ? 'Finding original clips' : p.step === 'copy' ? 'Preparing temporary copies'
      : `${p.device?.name || (p.hardware === false ? 'CPU' : 'Encoding device')}${p.level ? ` · ${p.level} at once` : ''}`;
    summary = `${step} · ${elapsed} elapsed`;
  } else if (s.phase === 'queued') summary = 'Speed test queued.';
  else if (s.phase === 'done' && result?.devices?.length) {
    const date = new Date(result.testedAt).toLocaleDateString('en-US', {month:'short', day:'numeric'});
    const rate = speedPerHour(result);
    summary = `${canApply ? 'Recommended: ' : 'Using '}${names(result.devices)} · tested ${date}${rate == null ? '' : ` · about ${rate.toLocaleString('en-US')} ${statusNoun(rate, 'clip')} an hour`}`;
    for (const device of result.devices) {
      const memory = device.memory;
      if (memory?.limited === true && Number.isFinite(memory.freeMib) && Number.isFinite(memory.totalMib))
        summary += ` · ${device.name || 'GPU'} limited by GPU memory: ${(Math.max(0, memory.totalMib-memory.freeMib)/1024).toFixed(1)} GB already in use`;
    }
  }
  const current = canApply ? `Current: ${config?.lanes?.length ? names(config.lanes.map((d) => ({...d, name:result.devices.find((r) => r.id === d.device)?.name}))) : `${config?.concurrency || 1} at once on the default device`}` : '';
  return {summary, current, active, canApply};
}

export function levelDevice(answer, level) {
  const devices = answer?.devices || [];
  const preferred = answer?.defaultDevices?.h265 ?? answer?.defaultDevice;
  const working = (device) => device.id !== 'cpu' && !device.id?.startsWith('node:') &&
    device.name && typeof device.encoders?.h265 === 'string' && device.encoders.h265.startsWith('hevc_');
  const device = preferred ? devices.find((entry) => entry.id === preferred) : devices.find(working);
  return level !== 'high' && device && working(device) ? `Uses your ${device.name}` : 'Uses the CPU';
}

export function previewPercent(value, compact = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return compact ? 'not measured' : 'Not measured';
  return `${Math.round(Math.abs(value))}%${value < 0 ? ' larger' : compact ? '' : ' smaller'}`;
}

export function previewSeconds(result) {
  return Number((result.duration_us / 1e6).toFixed(3));
}

export function previewMegabytes(bytes) {
  return bytes > 0 && bytes < 10_000 ? '<0.01 MB' : `${(bytes / 1e6).toFixed(2)} MB`;
}

export function previewMeasured(results) {
  const sample = results.find((entry) => entry.duration_us > 0);
  if (!sample) return '';
  return `Measured on this ${previewSeconds(sample)}-second sample: ${LEVELS.map(({ id, name }) =>
    `${name} ${previewPercent(results.find((entry) => entry.level === id)?.saved_percent, true)}`).join(' · ')}.`;
}

export function previewSource(clip, result, zone) {
  const moment = clip.kind === 'saved' ? 'the moment it was saved' : clip.kind === 'sentry' ? 'the moment Sentry was triggered' : 'the selected moment';
  const device = result.device === 'CPU' ? 'on the CPU' : `on your ${result.device}`;
  return `From your footage: ${previewClipLabel(clip, zone)} · ${previewSeconds(result)} seconds around ${moment}, shrunk just now ${device} with the same settings a real run uses. Your clip is only read.`;
}

export function previewClipLabel(clip, zone) {
  // Unzoned event timestamps are already vehicle-local; do not reinterpret them in the browser zone.
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(clip.when);
  const date = new Date(clip.when + (zoned ? '' : 'Z'));
  const when = Number.isNaN(date.getTime()) ? clip.when : new Intl.DateTimeFormat('en-US', {
    timeZone: zoned ? zone : 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
  const kind = {saved:'Saved', sentry:'Sentry', recent:'Recent'}[clip.kind] || 'Selected';
  return `${kind} clip, ${when} · Front camera`;
}

export function previewFailure(error) {
  const detail = String(error?.code || error?.message || error || '').match(/\b[A-Z][A-Z_]{3,}\b/)?.[0] || '';
  let message = 'Could not prepare a comparison. Try another clip.';
  if (detail === 'PREVIEW_TOOLS_UNAVAILABLE') message = 'The video tools on the server are not working, so no preview can be made. Check Health.';
  else if (/FRAME|TIMING|BOUNDARY|VERIFY|TIMESTAMP/.test(detail)) message = 'The picture check failed on this clip, so no comparison is shown. Try another clip.';
  else if (detail === 'PREVIEW_ACTIVE' || detail === 'PREVIEW_BUSY') message = 'Another preview or shrinking job is using the encoder. Try again when it finishes.';
  else if (detail === 'PREVIEW_RESUME_FAILED') message = 'The preview finished, but shrinking could not resume. Open Expert to resume it.';
  else if (detail === 'PREVIEW_PAUSE_FAILED') message = 'Shrinking could not be paused. Wait for it to finish, then try the preview again.';
  else if (detail === 'PREVIEW_NOT_FOUND') message = 'This preview has expired. Prepare a new comparison.';
  else if (/SOURCE|REQUIRES_H264|EVENT_OUTSIDE_WINDOW/.test(detail)) message = 'This clip cannot be used for a comparison. Try another clip.';
  return {message, detail};
}

/** Five server-observed stages per clip; elapsed time is tracked separately by the page. */
export function previewProgress(progress, kind, zone) {
  const p = progress || {}, results = p.results || {};
  const cached = p.phase === 'cached';
  const picked = !!p.phase;
  const cut = cached || !!results.orig || ['encoding', 'level'].includes(p.phase);
  const duration = Array.isArray(p.window) && p.window[1] > p.window[0] ? (p.window[1] - p.window[0]) / 1e6 : null;
  const steps = [
    {done:picked, active:!picked, text:p.kind && p.when ? previewClipLabel(p, zone) : picked ? 'Clip selected from your footage' : `Picking a clip from your ${kind === 'sentry' ? 'Sentry' : 'Saved'} footage`},
    {done:cut, active:p.phase === 'extracting', text:duration ? `Cutting ${Number(duration.toFixed(3))} seconds around the moment` : 'Cutting a short sample around the moment'},
    ...LEVELS.map(({id, name}) => ({done:cached || !!results[id], active:p.phase === 'encoding' && p.level === id,
      text:results[id] ? `${name} ${previewPercent(results[id].saved_percent)}` : cached ? `${name} comparison ready` : p.phase === 'encoding' && p.level === id ? `Shrinking at ${name}${p.device ? ` on ${p.device}` : ''}` : name})),
  ];
  return {steps, done:steps.filter((s) => s.done).length};
}

export function dayHeat(bytes, cap) {
  return cap > 0 ? 0.25 + Math.min(Math.max(Number(bytes) || 0, 0), cap) / cap * 0.7 : 0.25;
}

export function footageEstimate(days, keep, zone, level, today = new Date()) {
  const states = dayStates(days, keep, zone, today), sums = {kept:0, shrink:0};
  for (const day of days) if (states.get(day.day) in sums) sums[states.get(day.day)] += Number(day.bytes) || 0;
  const pct = LEVELS.find((entry) => entry.id === level)?.pct;
  const saved = pct == null ? null : sums.shrink * pct / 100;
  return {...sums, saved, after:saved == null ? null : sums.shrink - saved};
}

export function nextAgingDay(days, keep, zone, today = new Date()) {
  if (keep == null) return null;
  const now = localDay(today, zone);
  return days.filter((d) => d.clips > d.encoded).map(({day}) => {
    const date = new Date(day + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + keep);
    return {day, agesOn:date.toISOString().slice(0, 10)};
  }).filter((d) => d.agesOn > now).sort((a, b) => a.agesOn.localeCompare(b.agesOn))[0] || null;
}

export function catchUpProgress(snapshot, counts) {
  if (!counts?.total) return null;
  const items = snapshot.items || [];
  let unit = 'clips', done = counts.done, total = counts.total;
  if (items.length === total && items.every((i) => Number.isFinite(i.sourceBytes) && i.sourceBytes >= 0)) {
    const bytes = items.reduce((sum, i) => sum + i.sourceBytes, 0);
    if (bytes > 0) {
      unit = 'bytes'; total = bytes;
      done = items.filter((i) => ['completed', 'skipped', 'failed'].includes(i.state)).reduce((sum, i) => sum + i.sourceBytes, 0);
    }
  }
  return {unit, done, total, percent:Math.round(100 * done / total)};
}
export const DEFAULTS = {
  keep: 30,
  level: 'med',
  when: 'night',
  hour: 2,
  weekday: 0,
  day: 1,
  offPeak: false,
  catchUp: true,
  order: ['SavedClips', 'SentryClips', 'RecentClips'],
  included: { SavedClips: true, SentryClips: true, RecentClips: true },
};

export function levelOf(config) {
  if (
    !config ||
    config.codec !== 'h265' ||
    config.outputMode !== 'replace' ||
    config.keepLarger ||
    'bitrateKbps' in config ||
    'qualityLevel' in config ||
    (config.lanes != null &&
      (!Array.isArray(config.lanes) ||
        (config.lanes.length > 1 && config.deviceSettingsSource !== 'test') ||
        config.lanes.some((lane) => lane.device?.startsWith('node:'))))
  )
    return 'custom';
  return LEVELS.find((level) => level.profileId === config.profileId)?.id || 'custom';
}

// validate_start_config in converter/ipc.rs accepts only these fields. Saved
// configs also carry server-owned metadata such as nodesOff; it is not writable.
const CONFIG_FIELDS = new Set([
  'sourceRoot', 'destinationRoot', 'codec', 'profileId', 'networkMode', 'outputMode',
  'includedGroups', 'replacementConfirmed', 'groupOrder', 'concurrency', 'bitrateKbps',
  'qualityLevel', 'verifyMode', 'lanes', 'keepOffTarget', 'keepLarger', 'keepRecent',
]);

/** Pass the result as { config } to saveVehicle, or alongside shared settings to setAuto. */
export function toVehicleConfig(choice, vehicle, existing) {
  const writable = Object.fromEntries(
    Object.entries(existing || {}).filter(([key]) => CONFIG_FIELDS.has(key)),
  );
  const selected = {
    includedGroups: choice.order.filter((group) => choice.included[group]),
    groupOrder: [...choice.order],
    keepRecent: choice.keep == null ? null : { days: choice.keep, zone: vehicle.timezone },
  };
  // Keeping Expert is explicit: even its output mode and larger-result policy stay intact.
  if (choice.level === 'custom') return { ...writable, ...selected };
  const config = {
    verifyMode: 'quick',
    networkMode: 'auto',
    concurrency: 1,
    ...writable,
    ...selected,
    sourceRoot: vehicle.studioRoot || vehicle.root,
    destinationRoot: null,
    profileId: LEVELS.find((level) => level.id === choice.level).profileId,
    codec: 'h265',
    outputMode: 'replace',
    replacementConfirmed: true,
  };
  delete config.keepLarger;
  delete config.bitrateKbps;
  delete config.qualityLevel;
  // Smallest has no size target; the server rejects keepOffTarget:true for it.
  if (choice.level === 'high') delete config.keepOffTarget;
  else config.keepOffTarget = true;
  return config;
}

/** Shared setAuto fields only. The caller supplies enabled and config (or removeSource). */
export function toAutoSettings(choice, browserZone, existingSettings = {}, { scheduleChanged = false } = {}) {
  const zone = !scheduleChanged && existingSettings.schedule?.zone || browserZone;
  let schedule = null,
    intervalMinutes = 1440,
    window = choice.offPeak ? { follow: 'off-peak' } : null;
  switch (choice.when) {
    case 'night':
      schedule = { kind: 'daily', hour: choice.hour, zone };
      break;
    case 'week':
      schedule = { kind: 'weekly', weekday: choice.weekday, hour: choice.hour, zone };
      break;
    case 'month':
      schedule = { kind: 'monthly', day: choice.day, hour: choice.hour, zone };
      break;
    case 'asap':
      intervalMinutes = 60;
      window = null;
      break;
    case 'custom':
      schedule = existingSettings.schedule ? { ...existingSettings.schedule } : null;
      intervalMinutes = schedule ? 1440 : (existingSettings.intervalMinutes ?? 60);
      window = existingSettings.window ? { ...existingSettings.window } : null;
      break;
  }
  return {
    intervalMinutes,
    schedule,
    window,
    catchUp: choice.catchUp,
    holdManual: existingSettings.holdManual ?? false,
    keepRunning: existingSettings.keepRunning ?? false,
    openAtLogin: existingSettings.openAtLogin ?? false,
  };
}

/** Missing keepRecent means no keep window. Unsupported timing remains an Expert choice. */
export function fromSaved(config, settings) {
  const choice = { ...DEFAULTS, order: [...DEFAULTS.order], included: { ...DEFAULTS.included } };
  if (config) {
    choice.keep = config.keepRecent?.days ?? null;
    choice.level = levelOf(config);
    choice.order = [...(config.groupOrder || DEFAULTS.order)];
    const included = config.includedGroups || DEFAULTS.order;
    choice.included = Object.fromEntries(
      DEFAULTS.order.map((group) => [group, included.includes(group)]),
    );
  }
  if (settings) {
    const schedule = settings.schedule;
    choice.when = schedule
      ? { daily: 'night', weekly: 'week', monthly: 'month' }[schedule.kind] || 'custom'
      : (settings.intervalMinutes ?? 60) === 60 && !settings.window
        ? 'asap'
        : 'custom';
    choice.hour = schedule?.hour ?? DEFAULTS.hour;
    choice.weekday = schedule?.weekday ?? DEFAULTS.weekday;
    choice.day = schedule?.day ?? DEFAULTS.day;
    choice.offPeak = settings.window?.follow === 'off-peak';
    if (settings.window && !choice.offPeak) choice.when = 'custom';
    // Legacy interval settings omit catchUp, which the server interprets as off.
    choice.catchUp = settings.catchUp ?? !!schedule;
  }
  return choice;
}

function localDay(today, zone) {
  // A date-only argument is already a day in the vehicle zone, not a UTC instant.
  if (typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today)) return today;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(today));
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Day estimates: /days assigns a recording to its first clip's day; the sweep tests each clip. */
export function dayStates(days, keep, zone, today = new Date()) {
  let cutoff = null;
  if (keep != null) {
    // UTC is only a calendar arithmetic helper here: no 24-hour subtraction across local DST.
    const first = new Date(localDay(today, zone) + 'T00:00:00Z');
    first.setUTCDate(first.getUTCDate() - (keep - 1));
    cutoff = first.toISOString().slice(0, 10);
  }
  return new Map(
    days.map(({ day, clips, encoded }) => [
      day,
      !clips ? 'none' : encoded >= clips ? 'done' : cutoff && day >= cutoff ? 'kept' : 'shrink',
    ]),
  );
}

const SAVING = { std: 'about a fifth', med: 'about half', high: 'about 60%' };
const GROUP_NAMES = { SavedClips: 'Saved clips', SentryClips: 'Sentry clips', RecentClips: 'Recent clips' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function planSentence(choice, vehicleNames = []) {
  const saving = SAVING[choice.level];
  const start =
    choice.keep == null
      ? `Shrinking all footage, ${saving ? `aiming to save ${saving} of the space` : 'with your Expert settings'}`
      : `Keeping the last ${choice.keep} ${choice.keep === 1 ? 'day' : 'days'} as recorded, shrinking older footage ${saving ? `by ${saving}` : 'with your Expert settings'}`;
  const first = choice.order.find((group) => choice.included[group]);
  const order = first ? `${GROUP_NAMES[first]} first` : 'no clip groups selected';
  const schedule = scheduleText(choice).replace(/^./, (letter) => letter.toLowerCase());
  const sentence = `${start}, ${order}, ${schedule}.`;
  if (!vehicleNames.length) return sentence;
  const names = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(vehicleNames);
  return `For ${names}: ${sentence[0].toLowerCase()}${sentence.slice(1)}`;
}

export function scheduleText(choice) {
  const at = choice.offPeak
    ? ', when electricity is cheapest'
    : ` at ${String(choice.hour).padStart(2, '0')}:00`;
  const schedule = {
    night: `every night${at}`,
    week: `every ${WEEKDAYS[choice.weekday]}${at}`,
    month: `on day ${choice.day} of each month${at}`,
    asap: 'as clips age, checking every hour',
    custom: 'on your Expert schedule',
  }[choice.when];
  return schedule.replace(/^./, (letter) => letter.toUpperCase());
}

export function nextCheckText(at, zone, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return "The next check time is not available yet.";
  if (at <= now) return "A check is due. It will start when the server is ready.";
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(new Date(at));
}

export function nextCheckLabel(at, zone, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return null;
  if (at <= now) return 'Due now';
  const day = localDay(at, zone), today = localDay(now, zone);
  const tomorrow = new Date(today + 'T00:00:00Z');
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const label = day === today ? 'Today' : day === tomorrow.toISOString().slice(0, 10) ? 'Tomorrow' : new Intl.DateTimeFormat('en-US', {timeZone:zone, month:'short', day:'numeric'}).format(at);
  return `${label} ${new Intl.DateTimeFormat('en-US', {timeZone:zone, hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).format(at)}`;
}

export function expertSummary(config) {
  return [config.codec?.toUpperCase(), config.profileId,
    config.qualityLevel != null && `Quality: ${config.qualityLevel}`,
    config.bitrateKbps != null && `${config.bitrateKbps} kbps`,
    config.outputMode === "separate" ? "Separate copies" : "Replace originals",
    config.lanes?.length && `${config.lanes.length} device lane${config.lanes.length === 1 ? "" : "s"}`,
    config.keepLarger && "Larger results can be kept (set in Expert).",
  ].filter(Boolean).join(" · ");
}
