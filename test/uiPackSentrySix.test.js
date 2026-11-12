const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  path = require('path');
const root = path.join(__dirname, '../examples/ui-packs/sentry-six');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const moduleUrl = (f) =>
  'data:text/javascript,' +
  encodeURIComponent(
    read('web/s6/' + f + '.js').replace(
      /from '\.\/format\.js'/g,
      () => `from ${JSON.stringify(moduleUrl('format'))}`,
    ),
  );
const mod = (f) => import(moduleUrl(f));
const files = (dir, prefix = '') =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? files(path.join(dir, e.name), prefix + e.name + '/') : [prefix + e.name],
    );
test('sentry-six: the zip holds the folder as it is', () => {
  const entries = require('../server/zip').readZip(fs.readFileSync(root + '.zip'));
  assert.deepEqual(entries.map((e) => e.name).sort(), files(root).sort());
  for (const e of entries)
    assert.ok(e.data.equals(fs.readFileSync(path.join(root, e.name))), e.name);
});
test('sentry-six: replaces only the agreed built-in files', () => {
  const allowed = [
    'web/index.html',
    'web/login.html',
    'web/login-two-factor.html',
    'web/login-code.html',
    'web/studioEmbed.css',
  ];
  for (const f of files(root)) {
    assert.ok(!f.startsWith('studio/'));
    if (f.startsWith('web/') && fs.existsSync(path.join(__dirname, '..', f)))
      assert.ok(allowed.includes(f), f);
  }
  assert.deepEqual(
    files(root)
      .filter((f) => f.startsWith('web/') && fs.existsSync(path.join(__dirname, '..', f)))
      .sort(),
    allowed.sort(),
  );
});
test('sentry-six: ui.json names the pack', () => {
  const m = JSON.parse(read('ui.json'));
  assert.equal(m.name, 'Sentry Six');
  assert.ok(m.description.length <= 300);
});
test('format: dates follow one rule', async () => {
  const m = await mod('format'),
    now = new Date('2026-11-12T10:00:00');
  for (const [d, v] of [
    ['2026-11-12', 'Today'],
    ['2026-11-11', 'Yesterday'],
    ['2026-11-10', 'Tue, Nov 10'],
    ['2025-11-10', 'Mon, Nov 10, 2025'],
  ])
    assert.equal(m.dayLabel(d, now), v);
  assert.equal(m.timeRange('2026-11-09 19:58:02', '2026-11-09 21:08:39', false), '7:58 – 9:08 PM');
  assert.equal(
    m.timeRange('2026-11-09 11:27:01', '2026-11-09 13:35:53', false),
    '11:27 AM – 1:35 PM',
  );
  assert.equal(m.timeLabel('2026-11-09 19:58:02', true), '19:58');
  assert.equal(m.duration(166), '2 h 46 min');
  assert.equal(m.size(18956424973), '17.7 GB');
  assert.equal(m.size(3141814226944), '2.9 TB');
});
test('icons: every nav glyph exists', async () => {
  const m = await mod('icons');
  for (const k of 'dashboard folder_open videocam conversion_path usb task delete cardiology settings notifications menu shield'.split(
    ' ',
  ))
    assert.ok(m.ICONS[k], k);
});
test('theme: Liquid Glass values match the family', () => {
  const s = read('web/s6/s6.css');
  for (const x of [
    '#07090c',
    'oklch(0.82 0.18 150)',
    'blur(22px) saturate(185%)',
    "font-feature-settings: 'ss01', 'cv11'",
  ])
    assert.ok(s.includes(x), x);
  assert.doesNotMatch(s, /prefers-color-scheme: light|data-theme="light"/);
});
// Task 4 contract cases; added after the shell commit.
test('overviewStatus: fresh install, share down, read-only, recent and older footage', async () => {
  const m = await mod('status'),
    now = new Date('2026-11-12T10:00:00'),
    v = {
      id: 'tesla',
      share: { healthy: true, writable: true },
      inventory: { lastDay: '2026-11-11' },
      storage: { daysLeft: 27 },
    };
  assert.equal(
    m.overviewStatus({ vehicle: null, now }).first,
    'Add your first vehicle to get started.',
  );
  const down = m.overviewStatus({
    vehicle: { ...v, share: { healthy: false, lastError: 'Host is down' } },
    now,
  });
  assert.equal(down.first, "Can't reach your footage share.");
  assert.equal(down.tone, 'bad');
  assert.match(down.sub, /Host is down/);
  assert.equal(
    m.overviewStatus({ vehicle: { ...v, share: { healthy: true, writable: false } }, now }).first,
    'Your footage is readable, but the share is read-only.',
  );
  const recent = m.overviewStatus({
    vehicle: v,
    checks: [{ id: 'space-tesla', status: 'warn' }],
    now,
  });
  assert.equal(recent.first, 'Your footage is safe and up to date.');
  assert.equal(recent.second, 'Space runs out in about 27 days.');
  assert.equal(recent.tone, 'warn');
  const old = m.overviewStatus({ vehicle: { ...v, inventory: { lastDay: '2026-11-07' } }, now });
  assert.equal(old.first, 'Your footage is safe. The newest is from Sat, Nov 7.');
  assert.equal(old.second, 'Nothing needs you right now.');
});
test('attentionItems: missing footage is neutral; no disk-error alerts', async () => {
  const m = await mod('status'),
    now = new Date('2026-11-12T10:00:00'),
    days = [];
  for (let d = new Date('2026-10-14T12:00:00'); d < now; d.setDate(d.getDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    if (day !== '2026-11-04') days.push({ day, recordings: 1 });
  }
  const items = m.attentionItems({ days, now, notes: [{ kind: 'disk', title: 'Disk errors' }] });
  assert.ok(items.some((i) => i.title === 'No footage on 1 recent day'));
  assert.ok(items.every((i) => i.kind !== 'disk'));
  assert.ok(items.find((i) => i.kind === 'missing').text.includes('If the car was driven then'));
});
test('strip: 36 cells ending today', async () => {
  const m = await mod('status'),
    cells = m.strip(
      [{ day: '2026-11-11', recordings: 2, archive: { state: 'filling' } }],
      new Date('2026-11-12T10:00:00'),
    );
  assert.equal(cells.length, 36);
  assert.equal(cells.at(-1).state, 'today');
  assert.equal(cells.at(-2).state, 'filling');
});
test('selection: ticking a closed day stays ticked', async () => {
  const s = (await mod('selection')).createSelection();
  s.add(['a', 'b']);
  assert.equal(s.dayState(['a', 'b']), 'all');
  s.remove(['b']);
  assert.equal(s.dayState(['a', 'b']), 'some');
  assert.equal(s.dayState([]), 'none');
});
test('selection: select all counts everything matching, not the page', async () => {
  const s = (await mod('selection')).createSelection();
  s.add(Array.from({ length: 140 }, (_, i) => String(i)));
  assert.equal(s.count(), 140);
});
test('describeJob: trash and interrupted conversion', async () => {
  const m = await mod('jobs');
  const d = m.describeJob({
    type: 'trash',
    status: 'done',
    result: { moved: Array(12).fill('id'), bytes: 33715683737 },
  });
  assert.equal(d.title, 'Moved 12 recordings to the Recycle Bin');
  assert.match(d.outcome, /31.4 GB/);
  assert.match(d.outcome, /you can restore them/);
  assert.equal(m.describeJob({ type: 'convert', status: 'interrupted' }).statusText, 'Interrupted');
});
test('jobProgress: measured export progress, no invented scan percent', async () => {
  const m = await mod('jobs');
  assert.deepEqual(m.jobProgress({ detail: 'Rendering 1:20 of 3:00 (44%)' }), {
    pct: 44,
    text: '1:20 of 3:00',
  });
  assert.equal(m.jobProgress({ detail: 'Scanning…' }), null);
});
test('binNote and expiresIn follow the cleanup rule', async () => {
  const m = await mod('bin');
  assert.equal(
    m.binNote({ enabled: false, binDays: null }),
    'Nothing here is deleted until you empty the bin or press Delete forever. Restore puts footage back exactly where it was.',
  );
  assert.equal(
    m.binNote({ enabled: true, binDays: 30 }),
    'Your cleanup rule deletes items for good 30 days after they arrive here. Restore them before then.',
  );
  const now = Date.now(),
    item = { trashedAt: now - 28 * 86400000 };
  assert.equal(m.expiresIn(item, { enabled: true, binDays: 30 }, now), 2);
  assert.equal(m.expiresIn(item, { enabled: false, binDays: 30 }, now), null);
});
test('healthSummary: folds passing checks per group, normalizes server bad status', async () => {
  const m = await mod('status');
  const checks = [
    ...Array.from({ length: 5 }, (_, i) => ({
      id: 'data' + i,
      group: 'Data folder',
      status: 'ok',
    })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: 'video' + i, group: 'Video', status: 'ok' })),
    { id: 'https', group: 'Access', status: 'ok' },
    { id: 'share-tesla', group: 'Tesla', status: 'ok' },
    { id: 'write-tesla', group: 'Tesla', status: 'ok' },
    { id: 'space-tesla', group: 'Tesla', status: 'warn' },
  ];
  const h = m.healthSummary(checks);
  assert.equal(h.total, 12);
  assert.equal(h.passed, 11);
  assert.equal(h.problems.length, 1);
  assert.match(h.groups.find((g) => g.name === 'Data folder').line, /^✓ All 5 passed/);
  assert.equal(m.healthSummary([{ group: 'Video', status: 'bad' }]).groups[0].worst, 'fail');
});
test('settings: choosing a pack asks for the password first', () => {
  const s = fs.readFileSync(path.join(root, 'web/s6/pages/settings.js'), 'utf8');
  assert.match(
    s,
    /const use\s*=\s*async\s*\(?id\)?\s*=>\s*\{\s*await confirmPassword\(\);\s*await api\(['"]\/api\/ui-packs\/active['"]/,
  );
  assert.match(s, /method:\s*['"]PUT['"]/);
  assert.match(fs.readFileSync(path.join(root, 'web/s6/core.js'), 'utf8'), /\/api\/auth\/confirm/);
});
test('sign-in: every id and name Original scripts read exists in pack HTML', () => {
  for (const name of ['login', 'login-two-factor', 'login-code']) {
    const js = fs.readFileSync(path.join('web', name + '.js'), 'utf8'),
      html = fs.readFileSync(path.join(root, 'web', name + '.html'), 'utf8');
    for (const m of js.matchAll(/(?:\$|getElementById)\('([^']+)'\)/g))
      assert.ok(html.includes('id="' + m[1] + '"'), name + ': ' + m[1]);
    for (const m of js.matchAll(/\[name=([a-z]+)\]/g))
      assert.ok(html.includes('name="' + m[1] + '"'), name + ': ' + m[1]);
    assert.ok(html.includes('/web/s6/login.css'));
    assert.ok(!html.includes('/web/shell.css'));
    assert.ok(html.includes('/web/' + name + '.js'));
  }
});
test('studio embed: pack copy starts with Original and adds family green', () => {
  const original = fs.readFileSync('web/studioEmbed.css', 'utf8'),
    s = fs.readFileSync(path.join(root, 'web/studioEmbed.css'), 'utf8');
  assert.ok(s.startsWith(original));
  const added = s.slice(original.length);
  for (const value of ['--bg-gradient', '--accent-glow', 'oklch(0.82 0.18 150'])
    assert.ok(added.includes(value));
  assert.ok(!added.includes('200, 242, 90'));
});
test('sentry usb: theme sets its variables and button styling', () => {
  const css = fs.readFileSync(path.join(root, 'web/s6/s6.css'), 'utf8');
  for (const value of [
    '--sul-car-ok',
    '--sul-car-warn',
    '--sul-car-bad',
    '--sul-car-bg',
    '.sentry-sul .sul-btn',
  ])
    assert.ok(css.replaceAll('"', "'").includes(value), value);
});
test('overview strip: category counts remain separate and measured', async () => {
  const { strip } = await mod('status');
  const cell = strip(
    [{ day: '2026-11-12', recordings: 6, byCategory: { Recent: 3, Sentry: 2, Saved: 1 } }],
    new Date('2026-11-12T12:00:00'),
  ).at(-1);
  assert.equal(cell.sentry, 2);
  assert.equal(cell.saved, 1);
});
test('job history: missing byte measurements are not invented', async () => {
  const { describeJob } = await mod('jobs');
  assert.doesNotMatch(
    describeJob({ type: 'trash', status: 'done', result: { moved: ['a'] } }).outcome,
    /0 B/,
  );
});
test('sentry-six: all browser modules parse', () => {
  const { spawnSync } = require('node:child_process');
  for (const file of files(root).filter((f) => f.endsWith('.js'))) {
    const out = spawnSync(process.execPath, ['--check', '--input-type=module'], {
      input: read(file),
      encoding: 'utf8',
    });
    assert.equal(out.status, 0, file + '\n' + out.stderr);
  }
});

test('attentionItems: critical notifications lead and other vehicles stay out', async () => {
  const m = await mod('status');
  const items = m.attentionItems({
    vehicle: { id: 'mine' },
    notes: [
      { level: 'warning', title: 'Low space' },
      { level: 'critical', title: 'Cannot read footage' },
    ],
    checks: [
      { id: 'share-other', status: 'bad', label: 'Other car offline' },
      { id: 'write-other', status: 'warn' },
      { id: 'space-other', status: 'warn' },
    ],
  });
  assert.equal(items[0].title, 'Cannot read footage');
  assert.equal(items[0].tone, 'bad');
  assert.equal(items.length, 2);
});

test('icons: secondary pages and unknown glyphs never render empty SVGs', async () => {
  const m = await mod('icons');
  for (const key of [
    'delete_sweep',
    'palette',
    'dns',
    'system_update',
    'help',
    'monitoring',
    'video_file',
    'article',
    'backup',
    'restore',
    'unknown',
  ])
    assert.match(m.icon(key), /<path /, key);
});

test('job history: interrupted conversions explain retained work', async () => {
  const m = await mod('jobs');
  const out = m.describeJob({
    type: 'conversion',
    status: 'interrupted',
    detail: 'Server restarted',
  });
  assert.match(out.outcome, /Server restarted/);
  assert.match(out.outcome, /finished clips/i);
  assert.match(out.outcome, /Encoder/);
});

test('job history: restore titles do not expose raw recording folder dates', async () => {
  const m = await mod('jobs');
  const out = m.describeJob({
    type: 'restore',
    status: 'done',
    title: 'Restore Recent 2026-11-09 19:58:02',
    result: { bytes: 1024 },
  });
  assert.equal(out.title, 'Restored footage from the Recycle Bin');
  assert.match(out.outcome, /1.0 KB/);
});
