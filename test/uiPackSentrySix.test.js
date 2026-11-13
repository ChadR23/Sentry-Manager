const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  path = require('path');
const root = path.join(__dirname, '../examples/ui-packs/sentry-six');
const read = (f) =>
  process.env.S6_RACE_BASELINE
    ? require('child_process').execFileSync(
        'git',
        ['show', process.env.S6_RACE_BASELINE + ':examples/ui-packs/sentry-six/' + f],
        { encoding: 'utf8' },
      )
    : fs.readFileSync(path.join(root, f), 'utf8');
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
    m.overviewStatus({
      vehicle: { ...v, share: { healthy: true, writable: false } },
      now,
    }).first,
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
  const old = m.overviewStatus({
    vehicle: { ...v, inventory: { lastDay: '2026-11-07' } },
    now,
  });
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
  const items = m.attentionItems({
    days,
    now,
    notes: [{ kind: 'disk', title: 'Disk errors' }],
  });
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
    ...Array.from({ length: 3 }, (_, i) => ({
      id: 'video' + i,
      group: 'Video',
      status: 'ok',
    })),
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
    [
      {
        day: '2026-11-12',
        recordings: 6,
        byCategory: { Recent: 3, Sentry: 2, Saved: 1 },
      },
    ],
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

// Load the real browser modules with only the shared Account mount substituted.
function browserModule(file) {
  const src = read('web/s6/' + file).replace(
    /(from\s*|import\()(['"])([^'"]+)\2/g,
    (all, lead, quote, spec) => {
      if (spec === '/web/buildLabel.js')
        return lead + JSON.stringify('data:text/javascript,export const buildText=()=>"test"');
      if (spec === '/web/savingsChart.js')
        return (
          lead +
          JSON.stringify('data:text/javascript,export const createSavingsChart=()=>({destroy(){}})')
        );
      if (spec === '/web/account.js')
        return (
          lead +
          JSON.stringify('data:text/javascript,export const createAccountPage=()=>({destroy(){}})')
        );
      if (!spec.startsWith('.')) return all;
      return (
        lead +
        JSON.stringify(
          browserModule(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))),
        )
      );
    },
  );
  return 'data:text/javascript,' + encodeURIComponent(src);
}
function element() {
  const children = new Map();
  return {
    dataset: {},
    innerHTML: '',
    textContent: '',
    classList: { toggle() {}, remove() {} },
    style: { setProperty() {} },
    addEventListener() {},
    removeEventListener() {},
    appended: [],
    append(...els) {
      this.appended.push(...els);
    },
    showModal() {
      this.open = true;
    },
    close(value) {
      this.open = false;
      this.returnValue = value;
      this.onclose?.();
    },
    elements: { withCan: { checked: true } },
    remove() {},
    querySelectorAll: () => [],
    querySelector(key) {
      if (key.startsWith('#')) return null;
      if (!children.has(key)) children.set(key, element());
      return children.get(key);
    },
  };
}
async function browserEnv(t, reply) {
  const saved = {};
  t.cleanupFns = [];
  const intervals = new Set(),
    originalInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    const id = originalInterval(...args);
    intervals.add(id);
    return id;
  };
  t.after(() => {
    intervals.forEach(clearInterval);
    globalThis.setInterval = originalInterval;
  });
  for (const key of [
    'window',
    'document',
    'location',
    'history',
    'fetch',
    'EventSource',
    'localStorage',
  ])
    saved[key] = globalThis[key];
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const toasts = element();
  globalThis.document = {
    body: element(),
    getElementById: (id) => (id === 'toasts' ? toasts : null),
    querySelector: () => null,
    createElement: element,
  };
  globalThis.location = { hash: '#/footage', href: '' };
  globalThis.history = {
    replaceState(a, b, hash) {
      location.hash = hash;
    },
  };
  globalThis.localStorage = { getItem() {}, setItem() {} };
  globalThis.EventSource = class {
    addEventListener() {}
    close() {}
  };
  globalThis.fetch = async (url, opts) => {
    const data = await reply(url, opts);
    if (url === '/api/auth/me' && !data?.role) data.role = 'admin';
    return {
      ok: !(data?.status >= 400),
      status: data?.status || 200,
      json: async () => data,
    };
  };
  t.after(() => {
    for (const stop of t.cleanupFns) stop();
    for (const [key, value] of Object.entries(saved)) globalThis[key] = value;
  });
}
test('footage: a linked range change drops hidden selections and select mode', async (t) => {
  await browserEnv(t, (url) =>
    url.includes('/days?')
      ? { days: [], total: 0, dates: [] }
      : url.includes('/recordings?')
        ? { recordings: [{ id: 'old' }], total: 1 }
        : {},
  );
  const m = await import(browserModule('pages/footage.js')),
    el = element();
  const ctx = {
    current: () => ({ id: 'range-test', share: { healthy: true } }),
    state: {},
    alive: () => true,
  };
  let stop = await m.render(el, ctx);
  const click = async (key) =>
    el.onclick({
      target: {
        closest: () => ({
          dataset: {},
          hasAttribute: (a) => a === 'data-' + key,
        }),
      },
    });
  await click('select');
  await click('all');
  assert.match(el.innerHTML, /1 selected/);
  stop();
  location.hash = '#/footage?from=2026-11-11&to=2026-11-11';
  stop = await m.render(el, ctx);
  try {
    assert.doesNotMatch(el.innerHTML, /1 selected|data-all/);
    await click('select');
    assert.match(el.innerHTML, /0 selected/);
  } finally {
    stop();
  }
});
test('activity: job title and progress text render as text, never HTML', async (t) => {
  const attack = '<img src=x onerror=alert(1)>';
  await browserEnv(t, (url) =>
    url.startsWith('/api/jobs')
      ? {
          jobs: [
            {
              title: attack,
              detail: `Rendering ${attack} of 3:00 (44%)`,
              status: 'running',
            },
          ],
        }
      : {},
  );
  const m = await import(browserModule('pages/activity.js')),
    el = element();
  const stop = await m.render(el, {
    current: () => null,
    state: {},
    alive: () => true,
  });
  try {
    assert.doesNotMatch(el.innerHTML, /<img/);
    assert.match(el.innerHTML, /&lt;img/);
  } finally {
    stop();
  }
});
test('footage: recording Play uses the detail folder, day Play uses the date', async (t) => {
  await browserEnv(t, (url) => ({
    folderPath: url.endsWith('/drive')
      ? '/root/RecentClips'
      : '/root/SentryClips/2026-11-11_18-00-00',
  }));
  const m = await import(browserModule('pages/footage.js'));
  assert.deepEqual(await m.playParams('/api/vehicles/car', '2026-11-11', { id: 'drive' }), {
    folder: '/root/RecentClips',
  });
  assert.deepEqual(await m.playParams('/api/vehicles/car', '2026-11-11', { id: 'event' }), {
    folder: '/root/SentryClips/2026-11-11_18-00-00',
  });
  assert.deepEqual(await m.playParams('/api/vehicles/car', '2026-11-11'), {
    day: '2026-11-11',
  });
});
test('settings: viewer Account renders without requesting admin endpoints and signs out', async (t) => {
  const calls = [];
  await browserEnv(t, (url) => {
    calls.push(url);
    return url === '/api/auth/me'
      ? { user: 'watcher', role: 'viewer' }
      : { status: 403, error: 'Forbidden' };
  });
  const m = await import(browserModule('pages/settings.js')),
    el = element();
  const stop = await m.render(el, {
    sub: 'account',
    state: { vehicles: [] },
    current: () => null,
    alive: () => true,
  });
  assert.deepEqual(calls, ['/api/auth/me']);
  assert.match(el.querySelector('[data-detail]').innerHTML, /data-signout/);
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await el.querySelector('[data-detail]').querySelector('[data-signout]').onclick();
  assert.equal(location.href, '/login');
  stop();
});
test('bin: restore result counts files and marks conflicts as a failure', async () => {
  const m = await mod('bin');
  assert.deepEqual(
    m.restoreResult([
      { restored: 2, conflicts: 1 },
      { restored: 0, conflicts: 3 },
    ]),
    {
      text: 'Restored 2 files; 4 could not be restored (a file with that name exists).',
      bad: true,
    },
  );
  assert.deepEqual(m.restoreResult([{ restored: 1, conflicts: 0 }]), {
    text: 'Restored 1 file.',
    bad: false,
  });
});
test('format: singular, plural and fixed category order', async () => {
  const m = await mod('format');
  for (const noun of [
    'drive',
    'recording',
    'Sentry event',
    'item',
    'file',
    'clip',
    'check',
    'day',
  ]) {
    assert.equal(m.plural(1, noun), '1 ' + noun);
    assert.equal(m.plural(2, noun), '2 ' + noun + 's');
  }
  assert.equal(m.plural(1, 'saved', 'saved'), '1 saved');
  assert.deepEqual(
    m.categoryEntries({ Saved: 1, Sentry: 2, Recent: 3 }).map(([k]) => k),
    ['Recent', 'Sentry', 'Saved'],
  );
});
test('activity: numeric progressClips is a count; live devices name the GPU and encoder', async (t) => {
  await browserEnv(t, () => ({}));
  const m = await import(browserModule('convert.js'));
  assert.match(
    m.hardwareLabel(
      { id: 'a', progressClips: 12 },
      {
        jobId: 'a',
        devices: [
          {
            id: 'nvidia:0',
            name: 'RTX 4070',
            encoder: 'hevc_nvenc',
            hardware: true,
          },
        ],
      },
    ),
    /RTX 4070.*hevc_nvenc/,
  );
  assert.doesNotMatch(
    m.hardwareLabel(
      { id: 'b', progressClips: 12 },
      { jobId: 'a', device: { gpuName: 'RTX 4070', encoder: 'hevc_nvenc' } },
    ),
    /RTX|nvenc/,
  );
});

test('overview: no attention list (the bell carries it), ordered singular categories and a complete display total', async (t) => {
  await browserEnv(t, (url) =>
    url.includes('/days?')
      ? {
          days: [
            {
              day: '2026-11-11',
              byCategory: { Saved: 1, Sentry: 1, Recent: 1 },
              recordings: 3,
            },
          ],
        }
      : { checks: [], jobs: [] },
  );
  const m = await import(browserModule('pages/overview.js')),
    el = element();
  await m.render(el, {
    current: () => ({
      id: 'v',
      share: { healthy: true },
      inventory: {
        recordings: 1,
        days: 1,
        firstDay: '2026-11-11',
        byCategory: {
          Saved: { recordings: 1 },
          Sentry: { recordings: 1 },
          Recent: { recordings: 1 },
        },
      },
      binItems: 0,
    }),
    state: {
      notes: [
        { title: 'Check it', message: 'Check now', level: 'warning' },
        { title: 'Another', message: 'Details', level: 'critical' },
      ],
    },
    alive: () => true,
  });
  assert.doesNotMatch(el.innerHTML, /attention-group|Needs your attention/);
  assert.match(el.innerHTML, /class="number">1 recording<\/div>/);
  assert.match(el.innerHTML, /1 drive.*1 Sentry event.*1 saved/);
  assert.match(el.innerHTML, /class="muted" href="#\/bin">Recycle Bin is empty/);
});

test('footage: changing vehicles clears every remembered selection', async (t) => {
  await browserEnv(t, (url) =>
    url.includes('/days?')
      ? { days: [], total: 0, dates: [] }
      : url.includes('/recordings?')
        ? { recordings: [{ id: 'old' }], total: 1 }
        : {},
  );
  const m = await import(browserModule('pages/footage.js')),
    el = element(),
    ctx = {
      current: () => ({ id: 'car-reset', share: { healthy: true } }),
      state: {},
      alive: () => true,
    };
  let stop = await m.render(el, ctx);
  const click = (key) =>
    el.onclick({
      target: {
        closest: () => ({
          dataset: {},
          hasAttribute: (a) => a === 'data-' + key,
        }),
      },
    });
  await click('select');
  await click('all');
  stop();
  m.clearFootageSelections();
  stop = await m.render(el, ctx);
  try {
    assert.doesNotMatch(el.innerHTML, /1 selected|data-all/);
  } finally {
    stop();
  }
});

test('attention: informational rows are grey and legacy count labels use real plurals', async () => {
  const m = await mod('status');
  const items = m.attentionItems({
    notes: [
      {
        level: 'info',
        title: '1 clip(s) checked',
        message: '2 recording(s) read',
      },
    ],
  });
  assert.equal(items[0].tone, 'info');
  assert.equal(items[0].title, '1 clip checked');
  assert.equal(items[0].text, '2 recordings read');
});

test('bell: plain for news, yellow for a warning, red for something critical', async () => {
  const m = await mod('status');
  assert.equal(m.bellTone([]), '');
  assert.equal(m.bellTone([{ level: 'info' }]), '');
  assert.equal(m.bellTone([{ level: 'info' }, { level: 'warning', readAt: 1 }]), 'warn');
  assert.equal(m.bellTone([{ kind: 'storage' }]), 'warn');
  assert.equal(m.bellTone([{ kind: 'storage', level: 'info' }]), '');
  assert.equal(m.bellTone([{ level: 'warning' }, { level: 'critical', readAt: 1 }]), 'bad');
  assert.equal(m.bellTone([{ level: 'critical', resolvedAt: 1 }, { level: 'info' }]), '');
});

const clickAction = (el, key, dataset = {}) =>
  el.onclick({
    target: {
      closest: () => ({ dataset, hasAttribute: (a) => a === 'data-' + key }),
    },
  });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const context = (id, extra = {}) => ({
  current: () => ({ id, name: 'Tesla', share: { healthy: true } }),
  state: { vehicles: [] },
  alive: () => true,
  ...extra,
});

for (const change of ['category', 'deselect', 'leave', 'confirm']) {
  test('r3 footage: pending Move aborts on ' + change, async (t) => {
    let resolvePreview;
    const posts = [];
    await browserEnv(t, (url, opts) => {
      if (url.endsWith('/trash-preview'))
        return new Promise((r) => {
          resolvePreview = r;
        });
      if (url.endsWith('/trash')) {
        posts.push(JSON.parse(opts.body));
        return { moved: ['A', 'B'] };
      }
      if (url.includes('/days?')) return { days: [], total: 0, dates: [] };
      if (url.includes('/recordings?'))
        return {
          recordings: [
            { id: 'A', category: 'Recent' },
            { id: 'B', category: 'Saved' },
          ],
          total: 2,
        };
      return { role: 'admin' };
    });
    const m = await import(browserModule('pages/footage.js')),
      el = element();
    const stop = await m.render(el, context('race-' + change));
    t.cleanupFns.push(stop);
    await clickAction(el, 'select');
    await clickAction(el, 'all');
    const pending = clickAction(el, 'move');
    while (!resolvePreview) await tick();
    if (change === 'confirm') {
      resolvePreview({ recordings: 2, can: { logs: 2 } });
      await tick();
      assert.match(document.body.appended.at(-1).innerHTML, /2 recordings/);
    }
    if (change === 'leave') stop();
    else
      await clickAction(el, change === 'confirm' ? 'category' : change, {
        category: 'Saved',
      });
    if (change !== 'confirm') resolvePreview({ recordings: 2, can: { logs: 2 } });
    await tick();
    const dialogs = document.body.appended.filter((x) => x.open);
    // Accept a stale dialog if one survived: it must never submit.
    for (const dlg of dialogs) dlg.close('ok');
    await pending;
    assert.equal(posts.length, 0);
    assert.equal(dialogs.length, 0, 'scope change must close or prevent confirmation');
  });
}

test('r3 cleanup: retention labels match their field names', async (t) => {
  await browserEnv(t, () => ({ policy: { keepDays: {} }, preview: {} }));
  const el = element(),
    query = el.querySelector.bind(el);
  el.querySelector = (s) => query(s.replace('#', '[id=') + (s.startsWith('#') ? ']' : ''));
  await (await import(browserModule('pages/settings/cleanup.js'))).render(el, context('labels'));
  for (const [key, name] of [
    ['Recent', 'Driving'],
    ['Sentry', 'Sentry'],
    ['Saved', 'Saved'],
    ['Other', 'other'],
  ])
    assert.match(
      el.innerHTML,
      new RegExp('Keep ' + name + ' clips [(]days[)]<input[^>]+name="keep-' + key + '"'),
    );
});

test('r3 studio: vehicle changes discard all recording parameters', async (t) => {
  await browserEnv(t, () => ({}));
  const m = await import(browserModule('studio.js'));
  assert.equal(typeof m.studioUrl, 'function');
  const extra = {
    folder: '/old',
    date: '2026-11-11',
    at: 'clip~1',
    recording: 'A',
  };
  const v = { id: 'new', studioRoot: '/new' };
  const q = new URL(m.studioUrl('viewer', v, extra, true), 'https://local').searchParams;
  assert.deepEqual([...q.keys()], ['embed', 'root', 'vehicle']);
  assert.equal(q.get('root'), '/new');
  assert.equal(
    new URL(m.studioUrl('viewer', v, extra), 'https://local').searchParams.get('folder'),
    '/old',
  );
});

for (const action of ['restore', 'delete'])
  test('r3 bin: partial ' + action + ' refreshes and retries only failures', async (t) => {
    const calls = [];
    let remaining = ['A', 'B'];
    let fail = true;
    await browserEnv(t, (url) => {
      if (url.startsWith('/api/bin?')) {
        calls.push('refresh');
        return {
          items: remaining.map((id) => ({ id, bytes: 1, reason: 'manual' })),
        };
      }
      if (url.endsWith('/' + action)) {
        const id = url.split('/')[3];
        calls.push(id);
        if (id === 'B' && fail) return { status: 500, error: 'disk busy' };
        remaining = remaining.filter((x) => x !== id);
        return { restored: 1 };
      }
      return { role: 'admin' };
    });
    const el = element(),
      stop = await (await import(browserModule('pages/bin.js'))).render(el, context('bin'));
    t.cleanupFns.push(stop);
    calls.length = 0;
    await clickAction(el, 'select');
    await clickAction(el, 'all');
    const run = async () => {
      const pending = clickAction(el, action + '-selected');
      await tick();
      document.body.appended.filter((x) => x.open).forEach((x) => x.close('ok'));
      await pending;
    };
    await run();
    assert.deepEqual(calls, ['A', 'B', 'refresh']);
    assert.match(el.innerHTML, /0 selected/);
    const notice = document.getElementById('toasts').appended.at(-1);
    assert.match(notice.textContent, /(?:Restored|Deleted) 1; 1 failed: disk busy/);
    assert.match(notice.className, /bad/);
    fail = false;
    calls.length = 0;
    await clickAction(el, 'all');
    await run();
    assert.deepEqual(calls, ['B', 'refresh']);
  });

for (const page of [
  'footage',
  'bin',
  'activity',
  'health',
  'health/backups',
  'health/footage-check',
  'settings',
])
  test('r3 permissions: viewer ' + page + ' hides admin controls', async (t) => {
    await browserEnv(t, (url) => {
      if (url === '/api/auth/me') return { role: 'viewer', user: 'Watcher' };
      if (url.includes('/days?')) return { days: [], total: 0, dates: [] };
      if (url.startsWith('/api/bin?')) return { items: [{ id: 'A', bytes: 1 }] };
      return { checks: [], jobs: [], snapshots: [], policy: {} };
    });
    const el = element(),
      stop = await (
        await import(browserModule('pages/' + page.split('/')[0] + '.js'))
      ).render(el, context('viewer', { sub: page.split('/')[1] || '' }));
    t.cleanupFns.push(() => stop?.());
    assert.doesNotMatch(
      el.innerHTML,
      /data-(?:select|protect|unprotect|move|restore|empty|clear|command|run|make)\b|href="#\/settings\/(?:vehicles|cleanup|helpers|security)"/,
    );
  });

test('r3 footage: shrinking totals clamp the final page', async (t) => {
  let total = 31;
  const offsets = [];
  await browserEnv(t, (url) => {
    if (url.includes('/days?')) {
      const offset = Number(new URL(url, 'https://local').searchParams.get('offset'));
      offsets.push(offset);
      return {
        days: offset < total ? [{ day: '2026-11-11', recordings: 1, byCategory: {} }] : [],
        total,
        dates: [],
      };
    }
    return { role: 'admin', recordings: [], total: 0 };
  });
  const el = element(),
    stop = await (await import(browserModule('pages/footage.js'))).render(el, context('paging'));
  t.cleanupFns.push(stop);
  await clickAction(el, 'next');
  total = 30;
  await clickAction(el, 'select');
  assert.deepEqual(offsets.slice(-2), [30, 0]);
  assert.match(el.innerHTML, /Days 1–30 of 30/);
  assert.doesNotMatch(el.innerHTML, /No footage matches/);
});

test('r3 settings: independent summaries survive nodes 403 and keep Account usable', async (t) => {
  const calls = [];
  await browserEnv(t, (url) => {
    calls.push(url);
    return (
      {
        '/api/auth/me': { role: 'admin', user: 'Owner' },
        '/api/nodes': { status: 403 },
        '/api/updates': { enabled: true, latest: '1' },
        '/api/settings': {},
        '/api/vehicles/car/policy': { policy: { enabled: false } },
      }[url] || {}
    );
  });
  const el = element(),
    stop = await (
      await import(browserModule('pages/settings.js'))
    ).render(
      el,
      context('car', {
        sub: 'account',
        state: { vehicles: [{ id: 'car', name: 'Tesla' }] },
      }),
    );
  t.cleanupFns.push(() => stop?.());
  await tick();
  assert.ok(calls.includes('/api/nodes'));
  assert.match(el.querySelector('[data-detail]').innerHTML, /Sign out/);
  assert.match(el.querySelector('[data-summary="updates"]').textContent, /Up to date/);
  assert.match(el.querySelector('[data-summary="cleanup"]').textContent, /Off/);
  assert.equal(el.querySelector('[data-summary="helpers"]').textContent, '');
});

for (const action of ['protect', 'unprotect'])
  test('r3 footage: ' + action + ' confirmation closes on selection clear', async (t) => {
    const posts = [];
    await browserEnv(t, (url, opts) => {
      if (url.endsWith('/protect')) posts.push(opts);
      if (url.includes('/days?')) return { days: [], dates: [], total: 0 };
      if (url.includes('/recordings?')) return { recordings: [{ id: 'A' }], total: 1 };
      return { role: 'admin' };
    });
    const el = element(),
      stop = await (await import(browserModule('pages/footage.js'))).render(el, context(action));
    t.cleanupFns.push(stop);
    await clickAction(el, 'select');
    await clickAction(el, 'all');
    const pending = clickAction(el, action);
    await tick();
    const dlg = document.body.appended.at(-1);
    assert.equal(dlg.open, true);
    await clickAction(el, 'deselect');
    await pending;
    assert.equal(dlg.open, false);
    assert.deepEqual(posts, []);
  });
test('r3 actions: an aborted request is silent', async (t) => {
  await browserEnv(t, () => ({}));
  const { act } = await import(browserModule('core.js'));
  await act(async () => {
    throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
  })();
  assert.equal(document.getElementById('toasts').appended.length, 0);
});
test('r3 bin: scope change closes pending Delete forever', async (t) => {
  const posts = [];
  await browserEnv(t, (url, opts) => {
    if (opts.method === 'POST') posts.push(url);
    return url.startsWith('/api/bin?')
      ? { items: [{ id: 'A', reason: 'manual', bytes: 1 }] }
      : { role: 'admin' };
  });
  const el = element(),
    stop = await (await import(browserModule('pages/bin.js'))).render(el, context('delete-race'));
  t.cleanupFns.push(stop);
  await clickAction(el, 'select');
  await clickAction(el, 'all');
  const pending = clickAction(el, 'delete-selected');
  await tick();
  const dlg = document.body.appended.at(-1);
  await clickAction(el, 'reason', { reason: 'policy' });
  const survived = dlg.open;
  if (survived) dlg.close('ok');
  await pending;
  assert.equal(survived, false);
  assert.deepEqual(posts, []);
});

for (const action of ['move', 'protect', 'unprotect'])
  test(
    'r3 footage: confirmed ' + action + ' submits only selected ids still in scope',
    async (t) => {
      let reads = 0;
      const posts = [];
      await browserEnv(t, (url, opts) => {
        if (url.includes('/days?')) return { days: [], total: 0, dates: [] };
        if (url.includes('/recordings?')) {
          const recordings = ++reads === 1 ? [{ id: 'A' }, { id: 'B' }] : [{ id: 'B' }];
          return { recordings, total: recordings.length };
        }
        if (url.endsWith('/trash-preview')) return { recordings: 1, can: { logs: 1 } };
        if (url.endsWith('/trash') || url.endsWith('/protect')) {
          posts.push(JSON.parse(opts.body));
          return { moved: ['B'] };
        }
        return { role: 'admin' };
      });
      const el = element(),
        stop = await (
          await import(browserModule('pages/footage.js'))
        ).render(el, context('success-' + action));
      t.cleanupFns.push(stop);
      await clickAction(el, 'select');
      await clickAction(el, 'all');
      const pending = clickAction(el, action);
      await tick();
      const dlg = document.body.appended.at(-1);
      assert.match(dlg.innerHTML, /1 (?:selected )?recording/);
      assert.doesNotMatch(dlg.innerHTML, /2 recordings/);
      dlg.close('ok');
      await pending;
      assert.deepEqual(posts, [
        action === 'move'
          ? { ids: ['B'], withCan: true }
          : { ids: ['B'], protected: action === 'protect' },
      ]);
    },
  );

test('r3 bin: a failed middle item does not prevent later restores', async (t) => {
  let remaining = ['A', 'B', 'C'];
  const calls = [];
  await browserEnv(t, (url) => {
    if (url.startsWith('/api/bin?')) {
      calls.push('refresh');
      return { items: remaining.map((id) => ({ id, bytes: 1 })) };
    }
    if (url.endsWith('/restore')) {
      const id = url.split('/')[3];
      calls.push(id);
      if (id === 'B') return { status: 500, error: 'disk busy' };
      remaining = remaining.filter((x) => x !== id);
      return { restored: 1 };
    }
    return { role: 'admin' };
  });
  const el = element(),
    stop = await (await import(browserModule('pages/bin.js'))).render(el, context('middle'));
  t.cleanupFns.push(stop);
  calls.length = 0;
  await clickAction(el, 'restore-all');
  assert.deepEqual(calls, ['A', 'B', 'C', 'refresh']);
  assert.match(
    document.getElementById('toasts').appended.at(-1).textContent,
    /Restored 2; 1 failed: disk busy/,
  );
});

test('r3 settings: a failed selected page keeps the Settings list and Account link', async (t) => {
  await browserEnv(t, (url) =>
    url === '/api/auth/me'
      ? { role: 'admin', user: 'Owner' }
      : { status: 500, error: 'Temporarily unavailable' },
  );
  const el = element();
  const stop = await (
    await import(browserModule('pages/settings.js'))
  ).render(el, context('settings-error', { sub: 'updates' }));
  t.cleanupFns.push(() => stop?.());
  assert.match(el.innerHTML, /aria-label="Settings"/);
  assert.match(el.innerHTML, /href="#\/settings\/account"/);
  assert.match(el.querySelector('[data-detail]').innerHTML, /Temporarily unavailable/);
});

test('r3 permissions: viewer empty Footage and check results have no admin links', async (t) => {
  await browserEnv(t, (url) =>
    url === '/api/auth/me' ? { role: 'viewer' } : { more: 1, problems: [], checked: 1 },
  );
  const el = element();
  await (
    await import(browserModule('pages/footage.js'))
  ).render(el, context('empty', { current: () => null }));
  assert.doesNotMatch(el.innerHTML, /href="#\/settings\/vehicles"/);
  const stop = await (
    await import(browserModule('pages/health.js'))
  ).render(
    el,
    context('viewer-check', {
      sub: 'footage-check',
      state: { vehicles: [{ id: 'car', name: 'Tesla' }] },
    }),
  );
  t.cleanupFns.push(stop);
  assert.doesNotMatch(el.innerHTML, /support-bundle|data-check=/);
});

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

test('r4 bin: leaving during password confirmation prevents delete retry and next batch item', async (t) => {
  const posts = [];
  await browserEnv(t, (url, opts) => {
    if (url.startsWith('/api/bin?')) return { items: ['A', 'B'].map((id) => ({ id, bytes: 1 })) };
    if (opts.method === 'POST') {
      posts.push(url);
      if (url.endsWith('/A/delete') && posts.length === 1)
        return { status: 403, code: 'CONFIRM_PASSWORD' };
    }
    return { role: 'admin' };
  });
  const el = element();
  const stop = await (await import(browserModule('pages/bin.js'))).render(el, context('password'));
  t.cleanupFns.push(stop);
  const pending = clickAction(el, 'empty');
  await tick();
  document.body.appended.at(-1).close('ok');
  await tick();
  const password = document.body.appended.at(-1);
  assert.match(password.innerHTML, /password/);
  stop();
  const survived = password.open;
  if (survived) password.close('ok');
  await pending;
  assert.deepEqual(posts, ['/api/bin/A/delete']);
  assert.equal(survived, false);
});

for (const stage of ['preview', 'dialog'])
  test('r4 cleanup: vehicle change during ' + stage + ' prevents run', async (t) => {
    const held = deferred();
    let reads = 0,
      vehicle = 'A';
    const posts = [];
    await browserEnv(t, (url, opts) => {
      if (url.endsWith('/run')) posts.push(url);
      if (opts.method === 'GET' && ++reads === 2) return held.promise;
      return { policy: { keepDays: {} }, preview: { recordings: 3 } };
    });
    const oldFormData = globalThis.FormData;
    globalThis.FormData = class {
      get() {
        return '';
      }
    };
    t.after(() => (globalThis.FormData = oldFormData));
    const el = element(),
      query = el.querySelector.bind(el);
    el.querySelector = (s) => query(s.replace('#', '[id=') + (s.startsWith('#') ? ']' : ''));
    const stop = await (
      await import(browserModule('pages/settings/cleanup.js'))
    ).render(el, context('A', { current: () => ({ id: vehicle }), render() {} }));
    t.cleanupFns.push(() => stop?.());
    const pending = el.querySelector('#pol-run').onclick();
    await tick();
    if (stage === 'preview') vehicle = 'B';
    held.resolve({ preview: { recordings: 3 } });
    await tick();
    if (stage === 'dialog') {
      vehicle = 'B';
      await new Promise((r) => setTimeout(r, 40));
    }
    const dialogs = document.body.appended.filter((d) => d.open);
    dialogs.forEach((d) => d.close('ok'));
    await pending;
    assert.deepEqual(posts, []);
    assert.equal(dialogs.length, 0);
  });

test('r4 footage: delayed Select all cannot reverse Deselect all', async (t) => {
  const held = deferred();
  let waiting = false;
  await browserEnv(t, (url) => {
    if (url.includes('/days?')) return { days: [], total: 0 };
    if (url.includes('/recordings?')) {
      if (url.includes('offset=500')) {
        waiting = true;
        return held.promise;
      }
      return {
        recordings: Array.from({ length: 500 }, (_, i) => ({ id: String(i) })),
        total: 501,
      };
    }
    return { role: 'admin' };
  });
  const el = element(),
    stop = await (await import(browserModule('pages/footage.js'))).render(el, context('501'));
  t.cleanupFns.push(stop);
  await clickAction(el, 'select');
  const pending = clickAction(el, 'all');
  await tick();
  assert.ok(waiting);
  await clickAction(el, 'deselect');
  held.resolve({ recordings: [{ id: '500' }], total: 501 });
  await pending;
  assert.match(el.innerHTML, /0 selected/);
  assert.doesNotMatch(el.innerHTML, /501 selected/);
});

test('r4 render: late Footage teardown preserves newer header handlers', async (t) => {
  const held = deferred();
  let first = true,
    live = true;
  await browserEnv(t, (url) =>
    url.includes('/days?')
      ? first
        ? ((first = false), held.promise)
        : { days: [], total: 0 }
      : { role: 'admin' },
  );
  const header = element(),
    get = document.getElementById;
  header.replaceChildren = () => {
    header.innerHTML = '';
  };
  document.getElementById = (id) => (id === 'page-actions' ? header : get(id));
  const m = await import(browserModule('pages/footage.js')),
    el = element();
  const a = m.render(el, context('slow', { alive: () => live }));
  await tick();
  live = false;
  const stopB = await m.render(el, context('fast'));
  t.cleanupFns.push(stopB);
  const handler = header.onclick;
  assert.equal(typeof handler, 'function');
  held.resolve({ days: [], total: 0 });
  (await a)?.();
  assert.equal(header.onclick, handler);
});

for (const action of ['restore', 'delete'])
  test(
    'r4 bin: ' + action + ' retry after refresh failure excludes successful items',
    async (t) => {
      const calls = [];
      let reads = 0;
      await browserEnv(t, (url) => {
        if (url.startsWith('/api/bin?'))
          return ++reads === 1
            ? { items: ['A', 'B'].map((id) => ({ id, bytes: 1 })) }
            : { status: 500, error: 'refresh unavailable' };
        if (url.endsWith('/' + action)) {
          const id = url.split('/')[3];
          calls.push(id);
          return id === 'A' ? {} : { status: 500, error: 'busy' };
        }
        return { role: 'admin' };
      });
      const el = element(),
        stop = await (
          await import(browserModule('pages/bin.js'))
        ).render(el, context('refresh-' + action));
      t.cleanupFns.push(stop);
      const run = async () => {
        const p = clickAction(el, action === 'restore' ? 'restore-all' : 'empty');
        await tick();
        document.body.appended.filter((d) => d.open).forEach((d) => d.close('ok'));
        await p;
      };
      await run();
      await run();
      assert.deepEqual(calls, ['A', 'B', 'B']);
    },
  );
for (const action of ['restore', 'delete'])
  test(
    'r4 bin: ' + action + ' batch reports live progress and blocks duplicate clicks',
    async (t) => {
      const held = deferred();
      const calls = [];
      await browserEnv(t, (url) => {
        if (url.startsWith('/api/bin?'))
          return { items: ['A', 'B', 'C'].map((id) => ({ id, bytes: 1 })) };
        if (url.endsWith('/' + action)) {
          calls.push(url);
          return held.promise;
        }
        return { role: 'admin' };
      });
      const el = element(),
        stop = await (
          await import(browserModule('pages/bin.js'))
        ).render(el, context('progress-' + action));
      t.cleanupFns.push(stop);
      const key = action === 'restore' ? 'restore-all' : 'empty',
        pending = clickAction(el, key);
      await tick();
      document.body.appended.filter((d) => d.open).forEach((d) => d.close('ok'));
      await tick();
      const html = el.innerHTML;
      await clickAction(el, key);
      stop();
      held.resolve({});
      await pending;
      assert.match(html, new RegExp((action === 'restore' ? 'Restoring' : 'Deleting') + ' 1 of 3'));
      assert.match(html, /<progress/);
      assert.match(html, /data-restore-all[^>]*disabled/);
      assert.equal(calls.length, 1);
    },
  );
test('r4 Viewer: same vehicle without a pending URL reuses the playing frame', async (t) => {
  await browserEnv(t, () => ({}));
  const host = element(),
    get = document.getElementById;
  document.getElementById = (id) => (id === 'frames' ? host : get(id));
  const m = await import(browserModule('studio.js')),
    v = { id: 'car', root: '/car' };
  m.showStudio('viewer', v, { folder: '/car/recording' });
  const frame = host.appended.at(-1);
  m.hideStudio();
  m.showStudio('viewer', v);
  assert.equal(host.appended.length, 1);
  assert.equal(host.appended[0], frame);
  assert.equal(frame.hidden, false);
});
test('r4 server: monthly savings chart remains reachable and dead vehicle tiles are removed', () => {
  const server = read('web/s6/pages/server.js');
  assert.match(server, /savingsChart\.js/);
  assert.match(server, /createSavingsChart/);
  assert.doesNotMatch(read('web/s6/serverStats.js'), /function vehicleTiles\(/);
});
test('r4 server: viewers do not receive admin Logs links in alerts', async () => {
  const m = await import(browserModule('serverStats.js'));
  const html = m.serverBody({ alerts: [{ message: 'hot', level: 'warn' }] }, { admin: false });
  assert.doesNotMatch(html, /#\/health\/logs/);
});

test('r4 core: scope checks keys at password retry even before its watcher runs', async (t) => {
  let vehicle = 'A';
  const posts = [];
  await browserEnv(t, (url) => {
    posts.push(url);
    return url === '/mutate' ? { status: 403, code: 'CONFIRM_PASSWORD' } : {};
  });
  const { scope } = await import(browserModule('core.js'));
  const flow = scope(() => [vehicle]);
  t.cleanupFns.push(flow.abort);
  const pending = flow.api('/mutate', { body: {} });
  await tick();
  vehicle = 'B';
  document.body.appended.at(-1).close('ok');
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(posts, ['/mutate']);
});

test('r4 render: a nested Health subpage retains its parent scope', async (t) => {
  await browserEnv(t, () => ({}));
  const { ownedRender } = await import(browserModule('core.js'));
  const el = element();
  let mounted = false;
  const child = ownedRender(async (el, ctx) => {
    await ctx.scope.api('/api/stats');
    mounted = true;
    el.innerHTML = 'Server details';
  });
  const parent = ownedRender(async (el, ctx) => child(el, ctx));
  const stop = await parent(el, context('nested'));
  t.cleanupFns.push(stop);
  assert.equal(mounted, true);
  assert.equal(el.innerHTML, 'Server details');
});

test('r4 bin: batch stays disabled while its final refresh is pending', async (t) => {
  const held = deferred();
  let reads = 0;
  const calls = [];
  await browserEnv(t, (url) => {
    if (url.startsWith('/api/bin?'))
      return ++reads === 1 ? { items: [{ id: 'A', bytes: 1 }] } : held.promise;
    if (url.endsWith('/restore')) {
      calls.push(url);
      return { status: 500, error: 'busy' };
    }
    return { role: 'admin' };
  });
  const el = element(),
    stop = await (await import(browserModule('pages/bin.js'))).render(el, context('refresh-busy'));
  t.cleanupFns.push(stop);
  const pending = clickAction(el, 'restore-all');
  await tick();
  const html = el.innerHTML;
  const duplicate = clickAction(el, 'restore-all');
  await tick();
  held.resolve({ items: [{ id: 'A', bytes: 1 }] });
  await Promise.all([pending, duplicate]);
  assert.equal(calls.length, 1);
  assert.match(html, /data-restore-all[^>]*disabled/);
});

test('r4 settings: adding a vehicle refreshes before changing its own scope', async (t) => {
  const calls = [];
  const state = { vehicles: [{ id: 'A' }], vehicleId: 'A' };
  await browserEnv(t, (url, opts) => {
    calls.push([url, opts.method]);
    return opts.method === 'POST' ? { id: 'B' } : { vehicles: [{ id: 'A' }, { id: 'B' }] };
  });
  const saved = globalThis.FormData;
  globalThis.FormData = class {
    get() {
      return '';
    }
  };
  t.after(() => (globalThis.FormData = saved));
  const page = element(),
    form = element();
  page.querySelector = (s) => (s === '#veh' ? form : null);
  form.querySelector = () => null;
  const { scope } = await import(browserModule('core.js')),
    flow = scope(() => [state.vehicleId]);
  t.cleanupFns.push(flow.abort);
  const { forms } = await import(browserModule('pages/settings/forms.js'));
  forms(page, { state, scope: flow, alive: flow.alive }).wireSettings('new');
  await form.onsubmit({ preventDefault() {} });
  assert.deepEqual(calls, [
    ['/api/vehicles', 'POST'],
    ['/api/vehicles', 'GET'],
  ]);
  assert.equal(state.vehicleId, 'B');
  assert.equal(location.hash, '#/settings');
});

test('r4 Viewer: an explicit request for the same recording seeks again', async (t) => {
  await browserEnv(t, () => ({}));
  const host = element(),
    get = document.getElementById;
  document.getElementById = (id) => (id === 'frames' ? host : get(id));
  const m = await import(browserModule('studio.js')),
    v = { id: 'explicit', root: '/car' };
  m.showStudio('viewer', v, { folder: '/car/recording' });
  m.hideStudio();
  m.showStudio('viewer', v, { folder: '/car/recording' });
  assert.equal(host.appended.length, 2);
});

for (const stage of ['save', 'preview', 'dialog'])
  test('r5 cleanup: editing during ' + stage + ' cancels the saved run', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const held = deferred(),
      posts = [];
    let reads = 0,
      binDays = '1';
    const response = {
      policy: { keepDays: {}, binDays: 1 },
      preview: { recordings: 3, bytes: 100 },
    };
    await browserEnv(t, (url, opts) => {
      if (url.endsWith('/run')) posts.push(url);
      if (stage === 'save' && opts.method === 'PUT') return held.promise;
      if (opts.method === 'GET' && ++reads === 2 && stage === 'preview') return held.promise;
      return response;
    });
    const saved = globalThis.FormData;
    globalThis.FormData = class {
      get(k) {
        return k === 'binDays' ? binDays : '';
      }
    };
    t.after(() => (globalThis.FormData = saved));
    const el = element(),
      query = el.querySelector.bind(el);
    el.querySelector = (s) => query(s.replace('#', '[id=') + (s.startsWith('#') ? ']' : ''));
    const stop = await (
      await import(browserModule('pages/settings/cleanup.js'))
    ).render(el, context('r5-edit'));
    t.cleanupFns.push(stop);
    const pending = el.querySelector('#pol-run').onclick();
    await tick();
    binDays = '';
    el.querySelector('#pol').oninput?.();
    held.resolve(response);
    await tick();
    const open = document.body.appended.filter((d) => d.open);
    open.forEach((d) => d.close('ok'));
    await pending;
    assert.deepEqual(posts, []);
    assert.equal(open.length, 0);
  });

test('r5 cleanup: confirmation uses normalized saved expiry and warns of permanent deletion', async (t) => {
  await browserEnv(t, () => ({
    policy: { keepDays: {}, binDays: 2 },
    preview: { recordings: 3, bytes: 100 },
  }));
  const saved = globalThis.FormData;
  globalThis.FormData = class {
    get(k) {
      return k === 'binDays' ? '1' : '';
    }
  };
  t.after(() => (globalThis.FormData = saved));
  const el = element(),
    query = el.querySelector.bind(el);
  el.querySelector = (s) => query(s.replace('#', '[id=') + (s.startsWith('#') ? ']' : ''));
  const stop = await (
    await import(browserModule('pages/settings/cleanup.js'))
  ).render(el, context('r5-warning'));
  t.cleanupFns.push(stop);
  const pending = el.querySelector('#pol-run').onclick();
  await tick();
  const dlg = document.body.appended.find((d) => d.open),
    html = dlg.innerHTML;
  dlg.close('cancel');
  await pending;
  assert.match(html, /older than 2 days will be deleted for good/);
});

test('r5 Viewer: URL cannot replace the selected vehicle or its root', async (t) => {
  await browserEnv(t, () => ({}));
  const { studioUrl } = await import(browserModule('studio.js'));
  const q = new URL(
    studioUrl('viewer', { id: 'B', root: '/B' }, { vehicle: 'A', root: '/A', date: '2026-11-10' }),
    'http://localhost',
  ).searchParams;
  assert.equal(q.get('vehicle'), 'B');
  assert.equal(q.get('root'), '/B');
  assert.equal(q.get('date'), '2026-11-10');
});

for (const action of ['cars', 'worker'])
  test('r5 helpers: aborted ' + action + ' save never renders the next page', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let rendered = 0,
      requested = false;
    await browserEnv(t, (url, opts) => {
      if (opts.method !== 'GET') {
        requested = true;
        return new Promise((resolve, reject) =>
          opts.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            { once: true },
          ),
        );
      }
      return url === '/api/nodes'
        ? { nodes: [{ id: 'n', cars: [] }], worker: { available: true, mains: [] } }
        : { vehicles: [] };
    });
    const el = element(),
      query = el.querySelector.bind(el),
      add = element();
    add.dataset.carAdd = 'n';
    add.value = 'B';
    el.querySelector = (s) => query(s.replace('#', '[id=') + (s.startsWith('#') ? ']' : ''));
    el.querySelectorAll = (s) => (s === '[data-car-add]' ? [add] : []);
    const stop = await (
      await import(browserModule('pages/settings/helpers.js'))
    ).render(
      el,
      context('r5-helper', {
        render() {
          rendered++;
        },
      }),
    );
    t.cleanupFns.push(stop);
    const pending =
      action === 'worker' ? el.querySelector('#worker-on').onchange() : add.onchange();
    await tick();
    assert.ok(requested);
    stop();
    await pending;
    await tick();
    assert.equal(rendered, 0);
  });

test('r5 converter: leaving Activity cancels retry and stale hello requests', async (t) => {
  const posts = [],
    sources = [];
  await browserEnv(t, (url, opts) => {
    if (opts.method === 'POST') posts.push({ url, signal: opts.signal });
    return { ok: true, value: null };
  });
  globalThis.EventSource = class {
    static CLOSED = 2;
    handlers = {};
    readyState = 2;
    constructor() {
      sources.push(this);
    }
    addEventListener(k, fn) {
      this.handlers[k] = fn;
    }
    close() {}
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { scope } = await import(browserModule('core.js')),
    owner = scope();
  const m = await import(browserModule('convert.js'));
  const stop = m.follow(() => {}, owner);
  await Promise.resolve();
  await Promise.resolve();
  const first = sources.at(-1);
  first.handlers.error();
  owner.abort();
  stop();
  const count = posts.length;
  t.mock.timers.tick(30000);
  await first.handlers.hello();
  assert.equal(sources.length, 1);
  assert.equal(posts.length, count);
  assert.ok(posts.every((p) => p.signal));
});

test('r5 server: configured EUR reaches energy costs and tiles have a single grid', async (t) => {
  await browserEnv(t, (url) =>
    url === '/api/stats'
      ? { power: { totalW: 20, todayWh: 12, todayCost: 0.5 } }
      : { role: 'admin' },
  );
  document.addEventListener = document.removeEventListener = () => {};
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const el = element();
  const stop = await (
    await import(browserModule('pages/server.js'))
  ).render(el, context('eur', { state: { power: { currency: 'EUR' } } }));
  t.cleanupFns.push(stop);
  assert.match(el.querySelector('[data-stats]').innerHTML, /EUR/);
  assert.doesNotMatch(el.querySelector('[data-stats]').innerHTML, /\$0\.50/);
  assert.doesNotMatch(el.innerHTML, /class="nd-grid" data-stats/);
});

test('r5 server: renderer container leaves the footer outside the tile grid', () => {
  assert.doesNotMatch(read('web/s6/pages/server.js'), /class="nd-grid" data-stats/);
});

test('r5 Viewer: known deep-link vehicle switches selection, scope and root; unknown ids are ignored', async (t) => {
  const vehicles = [
    { id: 'A', root: '/A' },
    { id: 'B', studioRoot: '/B' },
  ];
  await browserEnv(t, (url) => (url === '/api/vehicles' ? { vehicles } : {}));
  const elements = new Map();
  document.getElementById = (id) => {
    if (!elements.has(id)) {
      const el = element();
      el.replaceChildren = () => {};
      elements.set(id, el);
    }
    return elements.get(id);
  };
  document.querySelectorAll = () => [];
  document.querySelector = () => element();
  document.documentElement = element();
  const previous = {
    MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  globalThis.MutationObserver = class {
    observe() {}
  };
  globalThis.requestAnimationFrame = () => {};
  t.after(() => Object.assign(globalThis, previous));
  location.hash = '#/viewer?vehicle=B&day=2026-11-10';
  const m = await import(browserModule('main.js'));
  assert.equal(m.current().id, 'B');
  const host = document.getElementById('frames');
  assert.match(host.appended.at(-1).dataset.src, /root=%2FB&vehicle=B/);
  assert.match(host.appended.at(-1).dataset.src, /date=2026-11-10/);
  const { scope } = await import(browserModule('core.js'));
  const owner = scope(() => [m.current().id]);
  t.cleanupFns.push(owner.abort);
  location.hash = '#/viewer?vehicle=A';
  await m.render();
  assert.equal(m.current().id, 'A');
  assert.equal(owner.alive(), false);
  location.hash = '#/viewer?vehicle=missing';
  await m.render();
  assert.equal(m.current().id, 'A');
  assert.match(host.appended.at(-1).dataset.src, /root=%2FA&vehicle=A/);
});

test('r5 converter: a hello awaiting subscribe cannot request or deliver after its owner leaves', async (t) => {
  const held = deferred(),
    posts = [],
    sources = [];
  await browserEnv(t, (url, opts) => {
    posts.push({ url, signal: opts.signal });
    return url.endsWith('/subscribeProgress') ? held.promise : { ok: true, value: null };
  });
  globalThis.EventSource = class {
    handlers = {};
    constructor() {
      sources.push(this);
    }
    addEventListener(k, fn) {
      this.handlers[k] = fn;
    }
    close() {}
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { scope } = await import(browserModule('core.js')),
    owner = scope();
  const m = await import(browserModule('convert.js'));
  let delivered = 0;
  const stop = m.follow(() => delivered++, owner);
  await tick();
  const first = sources.at(-1),
    pending = first.handlers.hello();
  await tick();
  owner.abort();
  stop();
  const count = posts.length,
    before = delivered;
  held.resolve({ ok: true, value: null });
  await pending;
  first.handlers['converter:progress']({
    data: JSON.stringify({ snapshot: { id: 'late', state: 'encoding' } }),
  });
  t.mock.timers.tick(30000);
  assert.equal(posts.length, count);
  assert.equal(delivered, before);
  assert.ok(posts.every((p) => p.signal?.aborted));
});

test('cleanup: Run now sends the rule it confirmed, and the server compares rules by what they move or delete', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'examples', 'ui-packs', 'sentry-six', 'web', 's6', 'pages', 'settings', 'cleanup.js'), 'utf8');
  assert.match(src, /policy\/run`, \{ body: \{ expect: saved \} \}/);
  const { ruleKey } = require('../server/policies');
  const base = { keepDays: { Recent: 30, Sentry: null, Saved: undefined }, binDays: null, maxGB: null, enabled: false, runAt: '03:30', lastRunAt: 1 };
  assert.equal(ruleKey(base), ruleKey({ ...base, keepDays: { Recent: '30', Other: null }, enabled: true, runAt: '04:00', lastRunAt: 2 }), 'schedule and bookkeeping do not count');
  assert.notEqual(ruleKey(base), ruleKey({ ...base, binDays: 1 }), 'emptying the bin is a different rule');
  assert.notEqual(ruleKey(base), ruleKey({ ...base, keepDays: { Recent: 7 } }));
  assert.notEqual(ruleKey(base), ruleKey({ ...base, maxGB: 500 }));
});

test('overview: storage and mapped health notifications describe one problem per vehicle', async () => {
  const m = await mod('status');
  const vehicle = {
    id: 'tesla',
    name: 'Tesla',
    storage: { free: 100, total: 1000, perDay: 4, daysLeft: 26 },
  };
  const notes = [
    {
      vehicleId: 'tesla',
      kind: 'storage',
      title: 'Tesla: share running low on space',
    },
    {
      vehicleId: 'other',
      kind: 'storage',
      title: 'Other: share running low on space',
    },
    {
      vehicleId: 'tesla',
      kind: 'share',
      dedupeKey: 'readonly:tesla',
      title: 'Tesla: share is read-only',
    },
    {
      kind: 'health',
      dedupeKey: 'health:write-tesla',
      title: 'Startup check: write',
    },
  ];
  const checks = [
    { id: 'space-tesla', status: 'warn' },
    { id: 'write-tesla', status: 'warn', label: 'Read-only' },
    { id: 'space-other', status: 'fail' },
  ];
  const items = m.attentionItems({ vehicle, notes, checks });
  assert.equal(items.length, 2);
  assert.equal(items.filter((i) => i.title === 'The share is almost full').length, 1);
  assert.equal(items[0].action.label, 'Free up space');
  assert.match(items[0].text, /100 B free.*26 days/);
  assert.equal(
    m.attentionItems({ vehicle, notes: notes.slice(0, 1) })[0].title,
    'The share is almost full',
  );
});

test('overview: status sentences use plain storage wording and single-vehicle titles', async () => {
  const m = await mod('status');
  const vehicle = {
    id: 'tesla',
    name: 'Tesla',
    share: { healthy: true, writable: true },
    storage: { daysLeft: 26 },
  };
  const notes = [
    {
      vehicleId: 'tesla',
      kind: 'storage',
      title: 'Tesla: share running low on space',
    },
  ];
  assert.equal(m.overviewStatus({ vehicle, notes }).second, 'Space runs out in about 26 days.');
  assert.equal(
    m.overviewStatus({ vehicle: { ...vehicle, storage: {} }, notes }).second,
    'Space is running low.',
  );
  const other = [
    {
      vehicleId: 'tesla',
      kind: 'conversion',
      title: 'Tesla: Conversion needs a look.',
    },
  ];
  assert.equal(
    m.overviewStatus({ vehicle, notes: other, vehicleCount: 1 }).second,
    'Conversion needs a look.',
  );
  assert.equal(
    m.overviewStatus({ vehicle, notes: other, vehicleCount: 2 }).second,
    'Tesla: Conversion needs a look.',
  );
});

test('overview: missing dates collapse consecutive days and limit visible ranges', async () => {
  const { missingDaySummary } = await mod('status');
  const dates = [
    '2026-10-08',
    '2026-10-09',
    '2026-10-10',
    '2026-10-11',
    '2026-10-12',
    '2026-10-13',
    '2026-11-04',
  ];
  assert.equal(missingDaySummary(dates), 'Oct 8 – 13 and Nov 4');
  assert.equal(
    missingDaySummary(['2026-11-01', '2026-11-03', '2026-11-05', '2026-11-07', '2026-11-09']),
    'Nov 1, Nov 3 and Nov 5 +2 more',
  );
});

test('overview: space warning colors use health and days-left thresholds', async () => {
  const { spaceTone } = await mod('status');
  const v = { id: 'v', storage: { daysLeft: 61 } };
  assert.equal(spaceTone(v, []), 'ok');
  assert.equal(spaceTone(v, [{ id: 'space-v', status: 'warn' }]), 'warn');
  for (const n of [60, 26, 14]) assert.equal(spaceTone({ ...v, storage: { daysLeft: n } }), 'warn');
  for (const n of [13, 0]) assert.equal(spaceTone({ ...v, storage: { daysLeft: n } }), 'bad');
  assert.equal(spaceTone({ id: 'v' }), 'ok');
});

test('overview and footage: large category and pager counts use thousands separators', async (t) => {
  const inv = {
    recordings: 4809,
    days: 2477,
    byCategory: { Recent: { recordings: 2477, bytes: 1000 } },
  };
  await browserEnv(t, (url) =>
    url.includes('/days?') ? { days: [], total: 2477, dates: [] } : { checks: [], jobs: [] },
  );
  const ctx = {
    current: () => ({
      id: 'counts',
      inventory: inv,
      share: { healthy: true, writable: true },
    }),
    state: { notes: [] },
    alive: () => true,
  };
  const el = element();
  await (await import(browserModule('pages/overview.js'))).render(el, ctx);
  assert.match(el.innerHTML, /2,477 ·/);
  const stop = await (await import(browserModule('pages/footage.js'))).render(el, ctx);
  t.cleanupFns.push(stop);
  assert.match(el.innerHTML, /<small>4,809<\/small>/);
  assert.match(el.innerHTML, /of 2,477/);
});

test('format: large counts in server messages and job progress retain separators', async () => {
  const f = await mod('format'),
    j = await mod('jobs');
  assert.equal(f.countText('2477 clips and 4809 recording(s)'), '2,477 clips and 4,809 recordings');
  assert.equal(j.jobProgress({ detail: 'Rendering 2477 of 4809 (51%)' }).text, '2,477 of 4,809');
});

test('sentry usb: the pack mounts the Sentry USB module the server ships', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'examples', 'ui-packs', 'sentry-six', 'web', 's6', 'main.js'), 'utf8');
  const mods = [...main.matchAll(/import\('\/web\/(sentryUsb[A-Za-z]*\.js)'\)/g)].map((m) => m[1]);
  assert.deepEqual(mods, ['sentryUsbInfo.js']);
  for (const m of mods) assert.ok(fs.existsSync(path.join(__dirname, '..', 'web', m)), `web/${m} exists`);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'web', 'sentryUsbInfo.js'), 'utf8'), /export function createSentryUsbPage\(/);
});
