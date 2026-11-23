// Guided Encoder choices and wire settings. No page state or DOM dependencies.
export const LEVELS = [
  { id: 'std', name: 'Standard', profileId: 'balanced', pct: 20 },
  { id: 'med', name: 'Medium', profileId: 'aggressive', pct: 50, rec: true },
  { id: 'high', name: 'High', profileId: 'smallest', pct: 60 },
];
export const KEEP_CHIPS = [3, 7, 14, 30, 60];
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
        config.lanes.length > 1 ||
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
export function toAutoSettings(choice, browserZone, existingSettings = {}) {
  let schedule = null,
    intervalMinutes = 1440,
    window = choice.offPeak ? { follow: 'off-peak' } : null;
  switch (choice.when) {
    case 'night':
      schedule = { kind: 'daily', hour: choice.hour, zone: browserZone };
      break;
    case 'week':
      schedule = { kind: 'weekly', weekday: choice.weekday, hour: choice.hour, zone: browserZone };
      break;
    case 'month':
      schedule = { kind: 'monthly', day: choice.day, hour: choice.hour, zone: browserZone };
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
  const sentence = `${start}, ${order}, ${schedule}.`;
  if (!vehicleNames.length) return sentence;
  const names = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(vehicleNames);
  return `For ${names}: ${sentence[0].toLowerCase()}${sentence.slice(1)}`;
}
