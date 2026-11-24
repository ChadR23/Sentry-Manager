'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');

let model;
before(async () => {
  // The browser pack has no package.json. A data URL loads its import-free ESM
  // unchanged, without Node's module-type warning or a new package scope.
  const source = readFileSync(path.resolve(__dirname,
    '../../examples/ui-packs/sentry-six/web/s6/encoderModel.js'));
  model = await import('data:text/javascript;base64,' + source.toString('base64'));
});

const vehicle = { root: '/footage/car-a', timezone: 'America/New_York' };
const groups = ['SavedClips', 'SentryClips', 'RecentClips'];
const simple = { codec: 'h265', outputMode: 'replace', profileId: 'aggressive' };
const choice = (patch = {}) => ({ ...structuredClone(model.DEFAULTS), ...patch });

test('preview progress counts verified steps for the current clip, never invented encode percents', () => {
  const picking = model.previewProgress(null, 'saved', 'UTC');
  assert.equal(picking.done, 0);
  assert.equal(picking.steps.length, 5);
  assert.match(picking.steps[0].text, /Picking.*Saved/);
  const extracting = model.previewProgress({phase:'extracting', kind:'sentry', when:'2026-11-03T19:43:00', window:[1_000_000, 6_250_000]}, 'saved', 'UTC');
  assert.equal(extracting.done, 1);
  assert.match(extracting.steps[0].text, /Sentry clip, Nov 3, 19:43/);
  assert.match(extracting.steps[1].text, /5.25 seconds/);
  const encoding = model.previewProgress({phase:'encoding', level:'med', device:'Test GPU', results:{orig:{}, std:{saved_percent:-2.4}}}, 'saved', 'UTC');
  assert.equal(encoding.done, 3);
  assert.equal(encoding.steps[2].text, 'Standard 2% larger');
  assert.equal(encoding.steps[3].text, 'Shrinking at Medium on Test GPU');
  assert.equal(encoding.steps[3].active, true);
  assert.equal(model.previewProgress({phase:'cached'}, 'saved', 'UTC').done, 5);
});

test('preview failures give plain guidance separately from technical codes', () => {
  const error = model.previewFailure('PREVIEW_FRAME_TIMING_MISMATCH');
  assert.match(error.message, /picture check failed/i);
  assert.doesNotMatch(error.message, /PREVIEW_/);
  assert.equal(error.detail, 'PREVIEW_FRAME_TIMING_MISMATCH');
  assert.match(model.previewFailure('PREVIEW_ACTIVE').message, /another preview/i);
  assert.doesNotMatch(model.previewFailure('UNRECOGNIZED_CODE').message, /UNRECOGNIZED_CODE/);
});

test('calendar heat scales to visible footage sizes and estimates only guided levels', () => {
  assert.equal(model.dayHeat(0, 100), 0.25);
  assert.equal(model.dayHeat(100, 100), 0.95);
  assert.equal(model.dayHeat(200, 100), 0.95);
  assert.equal(model.dayHeat(0, 0), 0.25);
  const days = [{day:'2026-11-24', clips:2, encoded:0, bytes:100}, {day:'2026-10-01',clips:2,encoded:0,bytes:400}, {day:'2026-09-01',clips:2,encoded:2,bytes:80}];
  assert.deepEqual(model.footageEstimate(days, 30, 'UTC', 'med', '2026-11-24'), {kept:100, shrink:400, saved:200, after:200});
  assert.equal(model.footageEstimate(days, 30, 'UTC', 'custom', '2026-11-24').saved, null);
});

test('Coming up uses a real unshrunk day and calendar arithmetic across DST', () => {
  const days = [{day:'2026-10-15',clips:1,encoded:0},{day:'2026-10-14',clips:1,encoded:1}];
  assert.deepEqual(model.nextAgingDay(days, 30, 'America/New_York', '2026-11-01'), {day:'2026-10-15', agesOn:'2026-11-14'});
  assert.equal(model.nextAgingDay(days, null, 'UTC', '2026-11-01'), null);
  assert.equal(model.nextAgingDay(days, 3, 'UTC', '2026-11-01'), null);
});

test('catch-up bytes require the whole item list; trimmed snapshots use real clip counts', () => {
  const counts = {total:2, done:1};
  const items = [{state:'completed', sourceBytes:30}, {state:'queued',sourceBytes:70}];
  assert.deepEqual(model.catchUpProgress({items, itemCount:2}, counts), {unit:'bytes', done:30, total:100, percent:30});
  assert.deepEqual(model.catchUpProgress({items:items.slice(0, 1), itemCount:2}, counts), {unit:'clips', done:1, total:2, percent:50});
  assert.equal(model.catchUpProgress({}, {total:0, done:0}), null);
});

test('guided saves preserve the schedule zone until step 3 is changed', () => {
  for (const kind of ['daily', 'weekly', 'monthly']) {
    const settings = { schedule: {kind, hour:2, weekday:3, day:12, zone:'America/New_York'} };
    const selected = model.fromSaved(simple, settings);
    assert.equal(model.toAutoSettings(selected, 'Asia/Tokyo', settings).schedule.zone, 'America/New_York');
    assert.equal(model.toAutoSettings(selected, 'Asia/Tokyo', settings, {scheduleChanged:true}).schedule.zone, 'Asia/Tokyo');
  }
  assert.equal(model.toAutoSettings(choice(), 'Asia/Tokyo').schedule.zone, 'Asia/Tokyo');
});

test('Coming up formats the actual check in the browser zone, including DST and overdue checks', () => {
  const now = Date.parse('2026-11-01T04:00:00Z');
  assert.equal(model.nextCheckText(null, 'America/New_York', now), 'The next check time is not available yet.');
  assert.equal(model.nextCheckText('bad', 'America/New_York', now), 'The next check time is not available yet.');
  assert.equal(model.nextCheckText(now - 1, 'America/New_York', now), 'A check is due. It will start when the server is ready.');
  assert.equal(model.nextCheckText(Date.parse('2026-11-01T06:00:00Z'), 'America/New_York', now), 'Sun, Nov 1, 01:00 EST');
  assert.equal(model.nextCheckText(Date.parse('2026-11-01T06:00:00Z'), 'Asia/Tokyo', now), 'Sun, Nov 1, 15:00 GMT+9');
});

test('status check tile uses the reported instant, including tomorrow across DST', () => {
  const now = Date.parse('2026-10-31T22:00:00Z');
  assert.equal(model.nextCheckLabel(null, 'America/New_York', now), null);
  assert.equal(model.nextCheckLabel(now - 1, 'America/New_York', now), 'Due now');
  assert.equal(model.nextCheckLabel(now + 3600000, 'America/New_York', now), 'Today 19:00');
  assert.equal(model.nextCheckLabel(Date.parse('2026-11-01T07:00:00Z'), 'America/New_York', now), 'Tomorrow 02:00');
});

test('schedule text shares exact timing with the plan and does not invent an Expert schedule', () => {
  assert.equal(model.scheduleText(choice()), 'Every night at 02:00');
  assert.equal(model.scheduleText(choice({when:'week', weekday:3, hour:23})), 'Every Wednesday at 23:00');
  assert.equal(model.scheduleText(choice({when:'month', day:28, offPeak:true})), 'On day 28 of each month, when electricity is cheapest');
  assert.equal(model.scheduleText(choice({when:'asap', offPeak:true})), 'As clips age, checking every hour');
  assert.equal(model.scheduleText(choice({when:'custom'})), 'On your Expert schedule');
});

test('Expert summary states custom encoding, output, device lanes and larger-result policy', () => {
  assert.equal(model.expertSummary({ codec:'av1', profileId:'quality', qualityLevel:25, outputMode:'separate', lanes:[{device:'node:test'},{device:'cpu'}], keepLarger:true }),
    'AV1 · quality · Quality: 25 · Separate copies · 2 device lanes · Larger results can be kept (set in Expert).');
  assert.match(model.expertSummary({...simple, bitrateKbps:6000}), /6000 kbps · Replace originals/);
});

test('preview copy distinguishes targets, measured savings, growth and shorter samples', () => {
  assert.equal(model.previewPercent(19.6), '20% smaller');
  assert.equal(model.previewPercent(-2.4), '2% larger');
  assert.equal(model.previewPercent(0), '0% smaller');
  assert.equal(model.previewPercent(null), 'Not measured');
  assert.equal(model.previewMegabytes(1_326_177), '1.33 MB');
  assert.equal(model.previewMegabytes(4_800), '<0.01 MB');
  const results = [{ level: 'orig', duration_us: 5_250_000 },
    { level: 'std', saved_percent: 18.4 }, { level: 'med', saved_percent: -2.1 }, { level: 'high', saved_percent: 63.8 }];
  assert.equal(model.previewMeasured(results), 'Measured on this 5.25-second sample: Standard 18% · Medium 2% larger · High 64%.');
  assert.equal(model.previewMeasured([{ level: 'orig', duration_us: 6_000_000 }]),
    'Measured on this 6-second sample: Standard not measured · Medium not measured · High not measured.');
  assert.equal(model.previewSource({ kind: 'saved', when: '2026-06-02T21:25:00' }, { duration_us: 5_250_000, device: 'CPU' }, 'America/New_York'),
    'From your footage: Saved clip, Jun 2, 21:25 · Front camera · 5.25 seconds around the moment it was saved, shrunk just now on the CPU with the same settings a real run uses. Your clip is only read.');
  assert.match(model.previewSource({ kind: 'sentry', when: '2026-06-03T01:25:00Z' }, { duration_us: 6_000_000, device: 'Test GPU' }, 'America/New_York'),
    /Sentry clip, Jun 2, 21:25 · Front camera · 6 seconds around the moment Sentry was triggered, shrunk just now on your Test GPU/);
});

test('tile hardware uses the working local H.265 default, never a remote or untested device', () => {
  const gpu = { id: 'pci:1', name: 'Test GPU', encoders: { h265: 'hevc_qsv' } };
  const answer = { devices: [gpu, { id: 'cpu', name: 'CPU', encoders: { h265: 'libx265' } }], defaultDevices: { h265: 'pci:1' } };
  assert.equal(model.levelDevice(answer, 'std'), 'Uses your Test GPU');
  assert.equal(model.levelDevice(answer, 'med'), 'Uses your Test GPU');
  assert.equal(model.levelDevice(answer, 'high'), 'Uses the CPU');
  assert.equal(model.levelDevice({ ...answer, defaultDevices: { h265: 'cpu' } }, 'std'), 'Uses the CPU');
  for (const device of [{ ...gpu, name: '' }, { ...gpu, encoders: null }, { ...gpu, encoders: { av1: 'av1_qsv' } },
    { ...gpu, id: 'node:remote:gpu' }, { ...gpu, encoders: { h265: null } }]) {
    assert.equal(model.levelDevice({ devices: [device] }, 'med'), 'Uses the CPU');
  }
  assert.equal(model.levelDevice(null, 'med'), 'Uses the CPU');
});
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('levelOf recognises the three presets, including High with or without keepOffTarget', () => {
  for (const [profileId, level] of [['balanced', 'std'], ['aggressive', 'med'], ['smallest', 'high']]) {
    assert.equal(model.levelOf({ ...simple, profileId }), level);
    assert.equal(model.levelOf({ ...simple, profileId, keepOffTarget: true }), level);
  }
  assert.deepEqual(model.LEVELS, [
    { id: 'std', name: 'Standard', profileId: 'balanced', pct: 20 },
    { id: 'med', name: 'Medium', profileId: 'aggressive', pct: 50, rec: true },
    { id: 'high', name: 'High', profileId: 'smallest', pct: 60 },
  ]);
  assert.deepEqual(model.KEEP_CHIPS, [3, 7, 14, 30, 60]);
});

test('levelOf leaves Expert encoding options marked custom', () => {
  for (const patch of [
    { codec: 'av1' }, { outputMode: 'separate' }, { profileId: 'custom', bitrateKbps: 2500 },
    { bitrateKbps: 2500 }, { qualityLevel: 'small' }, { profileId: 'quality' },
    { profileId: 'conservative' }, { keepLarger: true },
  ]) assert.equal(model.levelOf({ ...simple, ...patch }), 'custom', JSON.stringify(patch));
  assert.equal(model.levelOf(null), 'custom');
  assert.equal(model.levelOf({}), 'custom');
  assert.equal(model.levelOf({ ...simple, keepLarger: false }), 'med');
});

test('R3: one local lane is simple; multiple lanes or any node lane are custom', () => {
  for (const device of ['auto', 'cpu', 'pci:0000:01:00.0']) {
    assert.equal(model.levelOf({ ...simple, lanes: [{ device, concurrency: 2 }] }), 'med');
  }
  for (const lanes of [
    [{ device: 'cpu', concurrency: 1 }, { device: 'pci:0000:01:00.0', concurrency: 1 }],
    [{ device: 'node:helper:cpu', concurrency: 1 }],
    [{ device: 'node:helper:cpu', concurrency: 0 }],
  ]) assert.equal(model.levelOf({ ...simple, lanes }), 'custom');
});

test('a new guided config sends the complete replacement payload and round-trips the defaults', () => {
  const config = model.toVehicleConfig(freeze(choice()), freeze(vehicle));
  assert.deepEqual(config, {
    sourceRoot: '/footage/car-a', destinationRoot: null, codec: 'h265', profileId: 'aggressive',
    outputMode: 'replace', replacementConfirmed: true, includedGroups: groups, groupOrder: groups,
    keepRecent: { days: 30, zone: 'America/New_York' }, keepOffTarget: true,
    verifyMode: 'quick', networkMode: 'auto', concurrency: 1,
  });
  assert.deepEqual(model.fromSaved(config, model.toAutoSettings(choice(), 'Europe/London')), {
    keep: 30, level: 'med', when: 'night', hour: 2, weekday: 0, day: 1,
    offPeak: false, catchUp: true, order: groups,
    included: { SavedClips: true, SentryClips: true, RecentClips: true },
  });
});

test('guided changes preserve hidden settings and lanes, while clearing Expert encoding overrides', () => {
  const existing = freeze({
    ...simple, sourceRoot: '/old', destinationRoot: '/copies', outputMode: 'separate',
    codec: 'av1', profileId: 'custom', bitrateKbps: 2500, qualityLevel: 'small', keepLarger: true,
    verifyMode: 'full', networkMode: 'staging', concurrency: 3,
    lanes: [{ device: 'pci:0000:01:00.0', concurrency: 3 }], futureOption: { enabled: true },
  });
  const selected = freeze(choice({
    keep: 7, level: 'std', order: ['SentryClips', 'RecentClips', 'SavedClips'],
    included: { SavedClips: false, SentryClips: true, RecentClips: true },
  }));
  const config = model.toVehicleConfig(selected,
    { ...vehicle, studioRoot: '/footage/car-a/TeslaCam' }, existing);
  assert.equal(config.sourceRoot, '/footage/car-a/TeslaCam');
  assert.equal(config.destinationRoot, null);
  assert.equal(config.codec, 'h265');
  assert.equal(config.profileId, 'balanced');
  assert.equal(config.outputMode, 'replace');
  assert.equal(config.replacementConfirmed, true);
  assert.equal(config.keepOffTarget, true);
  for (const key of ['keepLarger', 'bitrateKbps', 'qualityLevel']) assert.equal(key in config, false);
  for (const key of ['verifyMode', 'networkMode', 'concurrency', 'lanes'])
    assert.deepEqual(config[key], existing[key]);
  assert.equal('futureOption' in config, false);
  assert.deepEqual(config.includedGroups, ['SentryClips', 'RecentClips']);
  assert.deepEqual(config.groupOrder, ['SentryClips', 'RecentClips', 'SavedClips']);
  assert.deepEqual(config.keepRecent, { days: 7, zone: 'America/New_York' });
  assert.deepEqual(model.fromSaved(config, model.toAutoSettings(selected, 'UTC')), selected);
  config.groupOrder.reverse();
  assert.deepEqual(selected.order, ['SentryClips', 'RecentClips', 'SavedClips']);
});

test('High omits inherited keepOffTarget and keepLarger so the server accepts smallest', () => {
  const config = model.toVehicleConfig(choice({ level: 'high' }), vehicle,
    { ...simple, keepOffTarget: true, keepLarger: true });
  assert.equal(config.profileId, 'smallest');
  assert.equal('keepOffTarget' in config, false);
  assert.equal('keepLarger' in config, false);
  assert.equal(model.levelOf(config), 'high');
});

test('Keep my Expert settings changes only the keep window and groups', () => {
  const existing = freeze({
    sourceRoot: '/expert', destinationRoot: '/copies', outputMode: 'separate',
    replacementConfirmed: false, codec: 'av1', profileId: 'custom', bitrateKbps: 2500,
    qualityLevel: 'small', keepOffTarget: false, keepLarger: true, verifyMode: 'full',
    networkMode: 'direct', concurrency: 2, lanes: [{ device: 'node:helper:cpu', concurrency: 2 }],
    keepRecent: { days: 7, zone: 'UTC' },
  });
  const selected = choice({ level: 'custom', keep: null, included: {
    SavedClips: true, SentryClips: false, RecentClips: false,
  } });
  assert.deepEqual(model.toVehicleConfig(selected, vehicle, existing), {
    ...existing, keepRecent: null, includedGroups: ['SavedClips'], groupOrder: groups,
  });
});

test('saved server metadata never leaks into saveVehicle or setAuto configs', () => {
  const existing = freeze({
    ...simple, sourceRoot: '/footage/car-a', destinationRoot: null, replacementConfirmed: true,
    includedGroups: groups, groupOrder: groups, networkMode: 'direct', verifyMode: 'full',
    concurrency: 2, lanes: [{ device: 'cpu', concurrency: 2 }],
    keepRecent: { days: 7, zone: 'UTC' }, keepOffTarget: true,
    nodesOff: ['node:helper'], autoConvert: true, futureMetadata: { value: 1 },
  });
  for (const level of ['std', 'med', 'high', 'custom']) {
    const config = model.toVehicleConfig(choice({ level }), vehicle, existing);
    for (const key of ['nodesOff', 'autoConvert', 'futureMetadata']) assert.equal(key in config, false);
    assert.deepEqual(config.lanes, [{ device: 'cpu', concurrency: 2 }]);
    assert.equal(config.verifyMode, 'full');
    assert.equal(config.networkMode, 'direct');
    assert.equal(config.concurrency, 2);
  }
  assert.deepEqual(existing.nodesOff, ['node:helper']);
});

test('no keep window stays null instead of silently becoming 30 days', () => {
  for (const keepRecent of [undefined, null]) {
    const selected = model.fromSaved({ ...simple, keepRecent }, { intervalMinutes: 60 });
    assert.equal(selected.keep, null);
    assert.equal(model.toVehicleConfig(selected, vehicle).keepRecent, null);
  }
});

for (const [when, schedule, intervalMinutes] of [
  ['night', { kind: 'daily', hour: 2, zone: 'Europe/London' }, 1440],
  ['week', { kind: 'weekly', weekday: 0, hour: 2, zone: 'Europe/London' }, 1440],
  ['month', { kind: 'monthly', day: 1, hour: 2, zone: 'Europe/London' }, 1440],
  ['asap', null, 60],
]) {
  test(`toAutoSettings: ${when} sends explicit catchUp and the server schedule shape`, () => {
    const selected = choice({ when });
    const settings = model.toAutoSettings(selected, 'Europe/London');
    assert.deepEqual(settings, {
      intervalMinutes, schedule, window: null, catchUp: true,
      holdManual: false, keepRunning: false, openAtLogin: false,
    });
    assert.deepEqual(model.fromSaved(model.toVehicleConfig(selected, vehicle), settings), selected);
  });
}

test('off-peak follows the electricity plan for calendar cards, but asap clears every window', () => {
  const existing = freeze({
    enabled: true, configs: [{ ...simple }], intervalMinutes: 180,
    window: { startHour: 1, endHour: 6 }, holdManual: true, keepRunning: true, openAtLogin: true,
    schedule: { kind: 'daily', hour: 9, zone: 'UTC' }, catchUp: true,
  });
  for (const when of ['night', 'week', 'month', 'asap']) {
    const selected = choice({ when, offPeak: true, catchUp: false, hour: 23, weekday: 6, day: 28 });
    const settings = model.toAutoSettings(selected, 'Asia/Tokyo', existing, { scheduleChanged: true });
    assert.deepEqual(settings.window, when === 'asap' ? null : { follow: 'off-peak' });
    assert.equal(settings.catchUp, false);
    for (const key of ['holdManual', 'keepRunning', 'openAtLogin']) assert.equal(settings[key], true);
    assert.equal('configs' in settings, false);
    assert.equal('enabled' in settings, false);
    if (when !== 'asap') {
      assert.equal(settings.schedule.hour, 23);
      assert.equal(settings.schedule.zone, 'Asia/Tokyo');
      const saved = model.fromSaved(simple, settings);
      assert.equal(saved.hour, 23);
      assert.equal(saved.offPeak, true);
      if (when === 'week') assert.equal(saved.weekday, 6);
      if (when === 'month') assert.equal(saved.day, 28);
    } else {
      assert.equal(settings.schedule, null);
      assert.equal(settings.intervalMinutes, 60);
    }
  }
});

test('fromSaved uses server catch-up defaults: absent is on for calendar, off for interval', () => {
  assert.equal(model.fromSaved(simple, { schedule: { kind: 'daily', hour: 2, zone: 'UTC' } }).catchUp, true);
  assert.equal(model.fromSaved(simple, { intervalMinutes: 60 }).catchUp, false);
  assert.equal(model.fromSaved(simple, { intervalMinutes: 60, catchUp: true }).catchUp, true);
  assert.equal(model.fromSaved(simple, {
    schedule: { kind: 'daily', hour: 0, zone: 'UTC' }, catchUp: false,
  }).hour, 0);
});

test('fromSaved marks Expert-only schedules custom and preserves them on save', () => {
  for (const patch of [{ intervalMinutes: 180 }, { window: { startHour: 1, endHour: 6 } }]) {
    const settings = { intervalMinutes: 60, schedule: null, window: null, catchUp: false,
      holdManual: false, keepRunning: false, openAtLogin: false, ...patch };
    const selected = model.fromSaved(simple, settings);
    assert.equal(selected.when, 'custom');
    assert.deepEqual(model.toAutoSettings(selected, 'UTC', settings), settings);
  }
});

test('editing a restored choice does not mutate saved groups or another default choice', () => {
  const config = freeze({ ...simple, includedGroups: ['SentryClips'], groupOrder: groups.slice() });
  const selected = model.fromSaved(config, { intervalMinutes: 60 });
  assert.deepEqual(selected.included, { SavedClips: false, SentryClips: true, RecentClips: false });
  selected.order.reverse();
  selected.included.SavedClips = true;
  assert.deepEqual(config.groupOrder, groups);
  const defaults = model.fromSaved();
  assert.deepEqual(defaults, model.DEFAULTS);
  defaults.order.reverse();
  defaults.included.SavedClips = false;
  assert.deepEqual(model.fromSaved(), model.DEFAULTS);
});

test('dayStates includes today in the 30 calendar days and distinguishes empty, mixed, and done', () => {
  const rows = freeze([
    { day: '2026-10-22', clips: 4, encoded: 1 },
    { day: '2026-10-23', clips: 4, encoded: 0 },
    { day: '2026-11-21', clips: 4, encoded: 0 },
    { day: '2026-10-01', clips: 4, encoded: 4 },
    { day: '2026-11-20', clips: 4, encoded: 5 },
    { day: '2026-11-19', clips: 0, encoded: 0 },
  ]);
  assert.deepEqual([...model.dayStates(rows, 30, 'America/New_York', new Date('2026-11-21T15:00:00Z'))], [
    ['2026-10-22', 'shrink'], ['2026-10-23', 'kept'], ['2026-11-21', 'kept'],
    ['2026-10-01', 'done'], ['2026-11-20', 'done'], ['2026-11-19', 'none'],
  ]);
});

test('dayStates advances at vehicle-local midnight, not at UTC midnight', () => {
  const rows = [{ day: '2026-10-23', clips: 1, encoded: 0 }];
  for (const [zone, before, after] of [
    ['America/New_York', '2026-11-22T04:59:59Z', '2026-11-22T05:00:00Z'],
    ['Asia/Tokyo', '2026-11-21T14:59:59Z', '2026-11-21T15:00:00Z'],
  ]) {
    assert.equal(model.dayStates(rows, 30, zone, new Date(before)).get('2026-10-23'), 'kept');
    assert.equal(model.dayStates(rows, 30, zone, new Date(after)).get('2026-10-23'), 'shrink');
  }
});

test('dayStates counts calendar dates across DST, leap day, and the new year', () => {
  for (const [today, keep, older, first] of [
    ['2026-03-09T04:00:00Z', 2, '2026-03-07', '2026-03-08'],
    ['2026-11-02T05:00:00Z', 2, '2026-10-31', '2026-11-01'],
    ['2024-03-01T05:00:00Z', 2, '2024-02-28', '2024-02-29'],
    ['2026-01-01T05:00:00Z', 2, '2025-12-30', '2025-12-31'],
  ]) {
    const rows = [older, first].map((day) => ({ day, clips: 1, encoded: 0 }));
    assert.deepEqual([...model.dayStates(rows, keep, 'America/New_York', new Date(today))], [
      [older, 'shrink'], [first, 'kept'],
    ]);
  }
});

test('dayStates accepts a local today key, handles keep one or null, and leaves inputs alone', () => {
  const rows = freeze([
    { day: '2026-11-20', clips: 1, encoded: 0 },
    { day: '2026-11-21', clips: 1, encoded: 0 },
  ]);
  assert.deepEqual([...model.dayStates(rows, 1, 'America/New_York', '2026-11-21')], [
    ['2026-11-20', 'shrink'], ['2026-11-21', 'kept'],
  ]);
  assert.deepEqual([...model.dayStates(rows, null, 'America/New_York', '2026-11-21')], [
    ['2026-11-20', 'shrink'], ['2026-11-21', 'shrink'],
  ]);
  assert.equal(model.dayStates([], 30, 'UTC', '2026-11-21').size, 0);
});

test('planSentence uses the exact default and level copy', () => {
  assert.equal(model.planSentence(choice()),
    'Keeping the last 30 days as recorded, shrinking older footage by about half, Saved clips first, every night at 02:00.');
  assert.equal(model.planSentence(choice({ level: 'std' })),
    'Keeping the last 30 days as recorded, shrinking older footage by about a fifth, Saved clips first, every night at 02:00.');
  assert.equal(model.planSentence(choice({ level: 'high' })),
    'Keeping the last 30 days as recorded, shrinking older footage by about 60%, Saved clips first, every night at 02:00.');
  assert.equal(model.planSentence(choice({ level: 'custom' })),
    'Keeping the last 30 days as recorded, shrinking older footage with your Expert settings, Saved clips first, every night at 02:00.');
  assert.equal(model.planSentence(choice({ keep: null })),
    'Shrinking all footage, aiming to save about half of the space, Saved clips first, every night at 02:00.');
  assert.equal(model.planSentence(choice({ keep: null, level: 'std' })),
    'Shrinking all footage, aiming to save about a fifth of the space, Saved clips first, every night at 02:00.');
  assert.equal(model.planSentence(choice({ keep: null, level: 'high' })),
    'Shrinking all footage, aiming to save about 60% of the space, Saved clips first, every night at 02:00.');
  assert.equal(model.planSentence(choice({ keep: null, level: 'custom' })),
    'Shrinking all footage, with your Expert settings, Saved clips first, every night at 02:00.');
});

test('planSentence uses each schedule and replaces the hour for off-peak', () => {
  const prefix = 'Keeping the last 30 days as recorded, shrinking older footage by about half, Saved clips first, ';
  for (const [when, timed, cheap] of [
    ['night', 'every night at 02:00.', 'every night, when electricity is cheapest.'],
    ['week', 'every Sunday at 02:00.', 'every Sunday, when electricity is cheapest.'],
    ['month', 'on day 1 of each month at 02:00.', 'on day 1 of each month, when electricity is cheapest.'],
    ['asap', 'as clips age, checking every hour.', 'as clips age, checking every hour.'],
    ['custom', 'on your Expert schedule.', 'on your Expert schedule.'],
  ]) {
    assert.equal(model.planSentence(choice({ when })), prefix + timed);
    assert.equal(model.planSentence(choice({ when, offPeak: true })), prefix + cheap);
  }
});

test('planSentence respects group inclusion, date choices, and optional vehicle names', () => {
  assert.equal(model.planSentence(choice({ keep: 1, when: 'week', weekday: 6, hour: 0,
    included: { SavedClips: false, SentryClips: true, RecentClips: true } }), ['Car A', 'Car B']),
  'For Car A and Car B: keeping the last 1 day as recorded, shrinking older footage by about half, Sentry clips first, every Saturday at 00:00.');
  assert.equal(model.planSentence(choice({ when: 'month', day: 28, hour: 23,
    order: ['RecentClips', 'SavedClips', 'SentryClips'] })),
  'Keeping the last 30 days as recorded, shrinking older footage by about half, Recent clips first, on day 28 of each month at 23:00.');
});


test('preview tool failures point to Health and retain their error code', () => {
  assert.deepEqual(model.previewFailure('PREVIEW_TOOLS_UNAVAILABLE'), {
    message: 'The video tools on the server are not working, so no preview can be made. Check Health.',
    detail: 'PREVIEW_TOOLS_UNAVAILABLE',
  });
});
