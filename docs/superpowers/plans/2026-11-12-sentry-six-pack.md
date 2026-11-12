# Sentry Six interface pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a built-in UI pack named "Sentry Six" that redesigns Overview, Footage, Activity, Recycle Bin, Health and Settings in the Sentry family's Liquid Glass theme, and keeps Original's Viewer, Encoder and Sentry USB.

**Architecture:** A pack folder `examples/ui-packs/sentry-six/` with its own `web/index.html`, its own stylesheet and its own ES modules under `web/s6/`. Of the built-in files it replaces only `web/index.html`, the three sign-in HTML pages (re-skinned as Sentry USB's sign-in, keeping Original's scripts) and `web/studioEmbed.css` (Original's file plus a green-glow block, so Viewer and Encoder match). Original's `shell.css`, the sign-in scripts, `app.js` and `studio/` stay as they are. Logic that decides what to show (status sentence, date formats, selection, job wording, bin expiry, check folding) lives in small pure modules with no imports, so Node tests can load them. Two small server additions: a footage date range and Recycle Bin thumbnails.

**Tech Stack:** Node ≥ 22.13 (CommonJS server, `node --test`), plain browser ES modules (no build step, no framework, no CDN), Material Symbols outlined 400 as inline SVG.

**Spec:** `docs/superpowers/specs/2026-11-12-new-interface-pack-design.md`. Read it before any task. Visual spec: `C:/Users/Jhoan/.t3/worktrees/Sentry-Manager/ui-redesign-mockups/sentry-six-final.built.html` (open it in a browser, switch tabs at the top). Never commit anything from that folder: it holds the owner's real footage thumbnails.

## Global Constraints

- Work in a detached worktree (`git worktree add --detach`). Never create a branch. Commits land on `wip` by id. Never push to `main`.
- No co-author trailers and no model or assistant names in commits or code.
- `npm test` passes before every push.
- No new runtime dependencies, no CDN, no network requests from the page. Fonts come from `/web/fonts/inter-latin.woff2` and `/web/fonts/jetbrains-mono-latin.woff2`.
- Pack id `sentry-six`. `ui.json`: name `Sentry Six`, author `Sentry Six Manager`, and a description of 300 characters or fewer.
- The pack replaces exactly these built-in files: `web/index.html`, `web/login.html`, `web/login-two-factor.html`, `web/login-code.html`, `web/studioEmbed.css`. It never replaces `web/shell.css`, any `web/login*.js`, `web/app.js` or anything under `studio/`.
- Pages that weren't redesigned (Viewer, Encoder, Sentry USB, the sign-in pages, and the shared modules) still wear the theme, as the spec's "Pages that keep Original's code" and "Sign-in" sections describe.
- Theme values are copied from `Sentry-USB-Rusty/web/src/index.css` (the `html[data-style="liquid"]` block) and `Sentry-Six/src/renderer/style.css` (`:root`), exactly as the spec's "Look" section lists them. Dark only.
- Category colours: Driving `#38bdf8`, Sentry `#fbbf24`, Saved `#c4b5fd`. Status colours: OK `#34d399`, warning `#fbbf24`, error `#f87171`, info `#38bdf8`. Accent `oklch(0.82 0.18 150)`, solid accent `oklch(0.72 0.17 150)`.
- No disk-error alerts, and no reading the logs to produce them (upstream `b8f6005`).
- Every number shown comes from an API field. Where the server has none, show text or a spinner.
- Everything the spec moves out of a page stays reachable from the place the spec names.

## Review Focus

- **No vehicles yet (fresh install).** Every page must render. Overview shows "Add your first vehicle" linking to Settings › Vehicles, Footage shows the same, and nothing throws on `inventory` being null. Owner: Task 4 (`overviewStatus` test) and Task 5 (page smoke test).
- **Share down while the page is open.** The status sentence turns red and says "Can't reach your footage share.". Footage keeps its list and shows the error above it. Owner: Task 4 test `share down`.
- **Two or more vehicles.** A vehicle picker (segmented control in the header) drives Overview, Footage, Activity and Recycle Bin, remembered in `localStorage` under `s6:vehicle`. Pages never mix vehicles. Owner: Task 3 Step 6 (add a second vehicle in the test data folder and switch between them on every page), and Task 9 Step 2 (screenshots with two vehicles).
- **Huge numbers and long names.** 140,000+ clips, 400+ days, 30+ TB, and a 64-character vehicle name must not overflow cards at 390 px wide. Owner: Task 9 screenshot pass at 390 px, against the checklist there.
- **A pack upload or switch while signed in.** `/original` still works, and Settings › Look & interface asks for the password before switching, as Original does (`POST /api/ui-packs/...` with the confirm flow). Owner: Task 8 test.

---

## File structure

```
examples/ui-packs/sentry-six/
  ui.json, README.md
  web/index.html            the shell: sidebar, phone tab bar, #page, #frames; loads /web/boot.js, /web/units.js, /web/s6/s6.css, /web/s6/main.js
  web/login.html, web/login-two-factor.html, web/login-code.html
                            Sentry USB's sign-in design; Original's login*.js scripts unchanged
  web/studioEmbed.css       Original's file verbatim + green Liquid Glass block for Viewer/Encoder
  web/s6/login.css          sign-in pages' stylesheet
  web/s6/s6.css             theme tokens, Liquid Glass surfaces, layout, components (one file)
  web/s6/main.js            router, nav, header (vehicle picker, bell, avatar), live updates (/api/events), redirects
  web/s6/core.js            api(), esc(), toast(), confirmDialog(), sheet() (bottom sheet on phones, popover on desktop)
  web/s6/icons.js           pure: ICONS map of Material Symbols path data + icon(name, cls)
  web/s6/format.js          pure: dates, times, ranges, durations, sizes
  web/s6/status.js          pure: overviewStatus(), attentionItems(), healthSummary()
  web/s6/selection.js       pure: selection model with day tri-state
  web/s6/jobs.js            pure: describeJob(), jobProgress()
  web/s6/bin.js             pure: binNote(), expiresIn()
  web/s6/studio.js          Viewer/Encoder iframe handling ported from web/app.js:1601-1720
  web/s6/pages/overview.js, footage.js, datepicker.js, activity.js, bin.js, health.js, server.js, settings.js, notifications.js, account.js
examples/ui-packs/sentry-six.zip   the folder zipped, kept in sync by test
server/index.js                    date range in filtered(); GET /api/bin/:item/thumbnail
server/recycleBin.js               thumbnailSource(itemId)
test/uiPackSentrySix.test.js       pack file checks + pure module tests
test/server.test.js                server additions
NOTICE                             Material Symbols (Apache-2.0) line
```

The pure modules have no `import` lines, so a test can load them with `import(\`data:text/javascript,${encodeURIComponent(src)}\`)`, as `test/uiPackExamples.test.js` does for `nodelanes.js`.

---

### Task 1: Footage date range on the server

**Files:**
- Modify: `server/index.js:1847-1852` (`filtered`)
- Test: `test/server.test.js`, inside `'footage, protect, Recycle Bin and policies never lose files'`, after `daysOf` is defined (line 190)

**Interfaces:**
- Produces: `GET /api/vehicles/:id/days?from=YYYY-MM-DD&to=YYYY-MM-DD` and the same on `/recordings`. Both ends are inclusive and both are optional. A value that isn't `YYYY-MM-DD` is ignored. `date` still works and wins over `from`/`to`.

- [ ] **Step 1: Write the failing test** `days: from/to keeps only days inside the range`

```js
const all = (await s.call('GET', '/api/vehicles/daily-driver/days?limit=100')).data;
const days = all.days.map((d) => d.day).sort();
const [lo, hi] = [days[0], days[days.length - 1]];
const ranged = (await s.call('GET', `/api/vehicles/daily-driver/days?from=${hi}&to=${hi}`)).data;
assert.deepEqual(ranged.days.map((d) => d.day), [hi]);
assert.equal((await s.call('GET', `/api/vehicles/daily-driver/days?from=${lo}&to=${hi}`)).data.total, all.total);
assert.equal((await s.call('GET', '/api/vehicles/daily-driver/days?from=nonsense')).data.total, all.total);
const recs = (await s.call('GET', `/api/vehicles/daily-driver/recordings?from=${hi}&to=${hi}`)).data.recordings;
assert.ok(recs.length > 0 && recs.every((r) => r.day === hi));
```

If the fixture holds a single day, add a second recording on another day to the fixture first, so `lo !== hi`.

- [ ] **Step 2: Run it.** `node --test --test-name-pattern="footage, protect" test/server.test.js`. Expected: FAIL on the `ranged.days` assertion.
- [ ] **Step 3: Implement.** In `filtered`, after the `date` filter: `const ok = (x) => /^\d{4}-\d{2}-\d{2}$/.test(x || '');`, then, when there's no `query.date`, filter `x.day >= query.from` if `ok(query.from)` and `x.day <= query.to` if `ok(query.to)`.
- [ ] **Step 4: Run it.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Footage: days and recordings take a from/to date range"`

### Task 2: Recycle Bin item thumbnails

**Files:**
- Modify: `server/recycleBin.js` (add `thumbnailSource`)
- Modify: `server/index.js`, next to the `/api/bin` routes (line ~3743)
- Test: `test/server.test.js`, in the same footage/bin test, where items are listed (line ~281)

**Interfaces:**
- Produces: `RecycleBin#thumbnailSource(itemId: string) -> { kind: 'image'|'clip', abs: string } | null`. `image` is the binned `thumb.png`, `clip` is the binned front-camera clip.
- Produces: `GET /api/bin/:item/thumbnail`, which returns the image (or a frame of the clip through the existing `thumbs.forClip`), or 404.

- [ ] **Step 1: Write the failing test** `bin: an item shows a thumbnail while it waits in the bin`

```js
const { data: { items: binned } } = await s.call('GET', '/api/bin?vehicle=daily-driver');
const withThumb = binned[0];
const res = await s.raw('GET', `/api/bin/${withThumb.id}/thumbnail`);
assert.equal(res.status, 200);
assert.match(res.headers['content-type'], /^image\//);
assert.equal((await s.raw('GET', '/api/bin/does-not-exist/thumbnail')).status, 404);
```

Use whatever raw-response helper `startServer` returns. If it only has `call`, add `raw` there, returning `{ status, headers, body: Buffer }`. If the fixture has no front clip, the test should check that the 404 fallback works and the route stays inside the bin folder.

- [ ] **Step 2: Run it.** Expected: FAIL with a 404 on the first request.
- [ ] **Step 3: Implement.** For `thumbnailSource`, find the item's `files`. Prefer an entry whose `rel` ends in `/thumb.png`, otherwise the first whose `rel` matches `-front\.mp4$`. Resolve `binRel` under the vehicle root and return `null` if the file is missing. In the route, call `vehicleOr404` on the item's vehicle, resolve through `allowed.resolve`, and for `clip` use `thumbs.forClip(real)`. Send it with `sendMedia(req, res, file, studioReadable.fdInside)`, the same as the route at `server/index.js:3698`. Check that ffmpeg reads a `.binned` file. If it doesn't, give ffmpeg `-f mp4` in `forClip`'s call for this case.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Recycle Bin: items keep a thumbnail while they wait in the bin"`

### Task 3: Pack shell, theme and the pure helpers

**Files:**
- Create: `examples/ui-packs/sentry-six/ui.json`, `README.md`, `web/index.html`, `web/s6/s6.css`, `web/s6/main.js`, `web/s6/core.js`, `web/s6/icons.js`, `web/s6/format.js`, `web/s6/studio.js`, `web/s6/pages/notifications.js`, `web/s6/pages/account.js`
- Create: `test/uiPackSentrySix.test.js`
- Create: `examples/ui-packs/sentry-six.zip` (zip the folder the same way the other packs' zips are built, so the zip check passes)
- Modify: `NOTICE` (add the Material Symbols, Apache-2.0 line, as Sentry-USB-Rusty's NOTICE words it)

**Interfaces:**
- Produces in `format.js`, all taking `now: Date` so tests are deterministic:
  - `dayLabel(day: 'YYYY-MM-DD', now) -> 'Today' | 'Yesterday' | 'Tue, Nov 10' | 'Tue, Nov 10, 2025'`
  - `timeLabel(at: string | number, h24: boolean) -> '7:58 PM' | '19:58'`
  - `timeRange(a, b, h24) -> '7:58 – 9:08 PM' | '11:27 AM – 1:35 PM' | '19:58 – 21:08'`
  - `duration(minutes: number) -> '2 h 46 min' | '11 min'`
  - `size(bytes: number) -> '17.7 GB' | '2.9 TB'`. Binary units with these labels, as Original's `size()` at `web/app.js:336`.
  - `ago(ms: number, now) -> '12 minutes ago'`
- Produces in `icons.js`: `ICONS: Record<string, string>` (path markup) and `icon(name, cls = '') -> string` (an `<svg viewBox="0 -960 960 960" fill="currentColor">`). It covers the nav glyphs in the spec plus every glyph the pages use. Copy the path data from `Sentry-USB-Rusty/web/src/components/icons.tsx`.
- Produces in `core.js`: `api(path, { method, body })` (sends `X-Requested-With: sentry-six-manager` on anything but GET, throws `Error(message)` on non-2xx), `esc(s)`, `toast(text, bad = false)`, `confirmDialog({ title, body, ok, danger }) -> Promise<boolean>`, `sheet(el, { anchor }) -> close()`.
- Produces in `main.js`: `state = { vehicles, vehicleId, notes, h24, glass }`, `current() -> vehicle | null`, `render()`, and a `pages` registry keyed by route. It redirects `#/jobs` to `#/activity`, `#/policies` to `#/settings/cleanup`, `#/notifications` to the bell panel on `#/overview`, `#/account` to `#/settings/account`, and `#/nodes` and `#/settings/nodes` to `#/settings/helpers`.
- Produces in `studio.js`: `showStudio(kind: 'viewer'|'encoder', extra?)` and `hideStudio()`, ported from `web/app.js:1601-1720`. Keep the vehicle/root/date parameters, `postMessage({type:'shown'|'pause'})`, the 900 px scale-down and the `sentry-studio` message handling (`web/app.js:1737`).

- [ ] **Step 1: Write the failing tests** in `test/uiPackSentrySix.test.js`:
  - `sentry-six: the zip holds the folder as it is`, the same check as `test/uiPackExamples.test.js:24`.
  - `sentry-six: replaces only the agreed built-in files`. List the pack's files. The paths that also exist under `web/` of the repo are exactly `web/index.html`, `web/login.html`, `web/login-two-factor.html`, `web/login-code.html` and `web/studioEmbed.css`, and there is no `studio/`. Task 3 creates only `index.html`; the test lists all five so Tasks 9 and 10 don't have to change it.
  - `sentry-six: ui.json names the pack`. `name === 'Sentry Six'`, description length ≤ 300.
  - `format: dates follow one rule`. With `now = new Date('2026-11-12T10:00:00')`: `dayLabel('2026-11-12', now) === 'Today'`, `dayLabel('2026-11-11', now) === 'Yesterday'`, `dayLabel('2026-11-10', now) === 'Tue, Nov 10'`, `dayLabel('2025-11-10', now) === 'Mon, Nov 10, 2025'`, `timeRange('2026-11-09 19:58:02', '2026-11-09 21:08:39', false) === '7:58 – 9:08 PM'`, `timeRange('2026-11-09 11:27:01', '2026-11-09 13:35:53', false) === '11:27 AM – 1:35 PM'`, `timeLabel('2026-11-09 19:58:02', true) === '19:58'`, `duration(166) === '2 h 46 min'`, `size(18956424973) === '17.7 GB'`, `size(3141814226944) === '2.9 TB'`.
  - `icons: every nav glyph exists`. `dashboard folder_open videocam conversion_path usb task delete cardiology settings notifications menu shield` are all keys of `ICONS`.
  - `theme: Liquid Glass values match the family`. `s6.css` contains `#07090c`, `oklch(0.82 0.18 150)`, `blur(22px) saturate(185%)` and `font-feature-settings: 'ss01', 'cv11'`, and it has no `prefers-color-scheme: light` and no `data-theme="light"`.
- [ ] **Step 2: Run them.** `node --test test/uiPackSentrySix.test.js`. Expected: FAIL (files missing).
- [ ] **Step 3: Build the shell.** `index.html` follows the spec's Navigation section: the sidebar (desktop, collapsible at ≤ 1100 px), and the floating glass tab bar (≤ 760 px) with Overview, Footage, Viewer, Activity and More. More opens a sheet listing Encoder, Sentry USB, Recycle Bin, Health and Settings. The header holds the vehicle picker (only with 2+ vehicles), the bell (open notifications count from `/api/notifications?open=1`, opens `pages/notifications.js` as a panel) and the avatar (opens `#/settings/account`). Load `/web/boot.js` and `/web/units.js` before the module, as Original does. `pages/account.js` reuses `/web/account.js`'s `createAccountPage`. Sentry USB uses `/web/sentryUsbLink.js`'s `createSentryUsbPage`, mounted the way `web/app.js:2193` does it. `s6.css` sets the glass tokens on `:root`, with `html.no-glass` removing `backdrop-filter` everywhere and the glass slider writing `--lg-glass` and `--lg-glow`. Store the slider in `localStorage` key `s6:glass`.
- [ ] **Step 4: Implement `format.js` and `icons.js`** to the signatures above.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Check by hand.** `npm start` with a test data folder. Switch to Sentry Six in Settings › Interface (Original), then check that Viewer, Encoder and Sentry USB open and behave as in Original, and `/original` still loads Original.
- [ ] **Step 7: Commit.** `git commit -m "Sentry Six pack: shell, Liquid Glass theme, formats and icons"`

### Task 4: Overview

**Files:**
- Create: `web/s6/status.js`, `web/s6/pages/overview.js`
- Test: `test/uiPackSentrySix.test.js`

**Interfaces:**
- Produces `overviewStatus({ vehicle, notes, checks, days, now }) -> { tone: 'ok'|'warn'|'bad', first: string, second: string, sub: string }`. Here `vehicle` is an item of `/api/vehicles`, `notes` comes from `/api/notifications?open=1`, `checks` from `/api/health`, and `days` from `/days?limit=40`.
- Produces `attentionItems({ vehicle, notes, checks, days, now }) -> Array<{ kind, tone, title, text, action: { label, href } }>`, worst first.
- Produces `strip(days, now, length = 36) -> Array<{ day, state: 'footage'|'none'|'today'|'filling', drives, other }>`.

- [ ] **Step 1: Write the failing tests** `overviewStatus: …`. Each case has one assertion on `first`, `second` and `tone`:
  - `fresh install` (vehicle null): `first === 'Add your first vehicle to get started.'`, tone `ok`.
  - `share down` (`share.healthy=false, lastError='Host is down'`): `first === "Can't reach your footage share."`, tone `bad`, `sub` includes `Host is down`.
  - `read-only`: `first === 'Your footage is readable, but the share is read-only.'`, tone `warn`.
  - `up to date`: `lastDay` is yesterday, a storage-warn check `space-tesla` exists, `storage.daysLeft=27`. Expect `first === 'Your footage is safe and up to date.'`, `second === 'Space runs out in about 27 days.'`, tone `warn`.
  - `older footage`: `lastDay` is 5 days ago, no problems. Expect `first === 'Your footage is safe. The newest is from Sat, Nov 7.'`, `second === 'Nothing needs you right now.'`.
  - `attentionItems: no footage days`. With days present on Oct 14 – Nov 11 except Nov 4, and `now` Nov 12, one item with `title === 'No footage on 1 recent day'`.
  - `attentionItems: never a disk-error item`. Feed a note with `kind: 'disk'` and confirm no item is about disk errors.
  - `strip: 36 cells ending today`. `cells.length === 36`, the last cell's `state === 'today'`, and a day with archive `filling` gives `state === 'filling'`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement `status.js`** to make them pass. Space wording uses `storage.daysLeft`. The storage item's text is "2.9 TB free (8.7%). Footage grows about 108 GB a day, so it fills up in about 27 days." from `storage.free`, `storage.total` and `storage.perDay`, formatted with `format.js`.
- [ ] **Step 4: Build `pages/overview.js`** to the spec's Overview section and the final mockup. That's the sentence, What happened lately (`strip()` plus five latest days; two on phones), Needs your attention (hidden when empty), then the Footage, Space and Activity cards. It refreshes on `/api/events` `inventory` and `notifications`.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit.** `git commit -m "Sentry Six: Overview"`

### Task 5: Footage

**Files:**
- Create: `web/s6/selection.js`, `web/s6/pages/footage.js`, `web/s6/pages/datepicker.js`
- Test: `test/uiPackSentrySix.test.js`

**Interfaces:**
- Consumes: Task 1's `from`/`to`.
- Produces `createSelection() -> { add(ids), remove(ids), has(id), count(), clear(), dayState(dayIds: string[]) -> 'all'|'some'|'none', ids() }`. Footage and Recycle Bin both use it.
- Produces `datepicker.open(anchor, { from, to, daysWithFootage: Set<string>, onApply({from,to}) })`. It's a popover at ≥ 761 px and a bottom sheet below that, with the shortcuts Today, Last 7 days, Last 30 days, This month and Custom.

- [ ] **Step 1: Write the failing tests:**
  - `selection: ticking a closed day stays ticked`. `s.add(['a','b'])`, then `s.dayState(['a','b']) === 'all'`, then `s.remove(['b'])` and `s.dayState(['a','b']) === 'some'`, then `s.dayState([]) === 'none'`.
  - `selection: select all counts everything matching, not the page`. Call `s.add(ids)` with 140 ids, then `s.count() === 140`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement `selection.js`.**
- [ ] **Step 4: Build `pages/footage.js`** to the spec's Footage section. The page fetches a day's recording ids when it ticks a closed day and stores them before redrawing; this is the fix for Original's bug at `web/app.js:1275`. Moving to the bin opens Original's confirm content, including the unticked "Also delete its CAN data" box when the server reports CAN logs. Mirror `web/app.js:1448-1460` and the `/api/vehicles/:id/trash` body it sends. Files and details lists files with `/api/media` links as `web/app.js:1548` does. The indexing chip polls `/api/speeds/status` every 5 s while indexing runs. Day state and selection persist across redraws.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit.** `git commit -m "Sentry Six: Footage with date range and selection"`

### Task 6: Activity and Recycle Bin

**Files:**
- Create: `web/s6/jobs.js`, `web/s6/bin.js`, `web/s6/pages/activity.js`, `web/s6/pages/bin.js`
- Test: `test/uiPackSentrySix.test.js`

**Interfaces:**
- Produces `describeJob(job) -> { icon, title, outcome, status: 'running'|'done'|'failed'|'interrupted'|'cancelled', statusText }`.
- Produces `jobProgress(job) -> { pct: number, text: string } | null`. It returns null unless the detail has a real number.
- Produces `binNote(policy) -> string` and `expiresIn(item, policy, now) -> number | null` (days, rounded up).
- Consumes: Task 2's `/api/bin/:item/thumbnail`, and Task 5's `createSelection`.

- [ ] **Step 1: Write the failing tests:**
  - `describeJob: trash` (`type:'trash', status:'done', title:'Move 12 recording(s) to the Recycle Bin', result:{moved:[…12], bytes:33715683737}`): `title === 'Moved 12 recordings to the Recycle Bin'`, and `outcome` includes `'31.4 GB'` and `'you can restore them'`.
  - `describeJob: interrupted conversion` gives `statusText === 'Interrupted'`.
  - `jobProgress: export detail` (`detail:'Rendering 1:20 of 3:00 (44%)'`): `{ pct: 44, text: '1:20 of 3:00' }`.
  - `jobProgress: scan` (`detail:'Scanning…'`): `null`.
  - `binNote: no rule` (`{enabled:false, binDays:null}`): `'Nothing here is deleted until you empty the bin or press Delete forever. Restore puts footage back exactly where it was.'`
  - `binNote: rule with binDays 30` (`{enabled:true, binDays:30}`): `'Your cleanup rule deletes items for good 30 days after they arrive here. Restore them before then.'`
  - `expiresIn`: with `trashedAt` 28 days before `now` and `binDays` 30, the result is `2`. With the rule disabled, the result is `null`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement `jobs.js` and `bin.js`.**
- [ ] **Step 4: Build `pages/activity.js`.** Conversion cards read the converter stream the way `examples/ui-packs/daylight/web/dl/convert.js` does. Pause and Stop call the same converter endpoints Daylight's Encoder page calls. "Clear finished" uses `/api/jobs/clear` with `preview` and then `confirm`, as `web/app.js:1840-1866` does.
- [ ] **Step 5: Build `pages/bin.js`.** It fetches the policy from `GET /api/vehicles/:id/policy`. Restore all restores items one by one and shows progress. Empty and Delete forever are confirmed with text saying they can't be undone. Rows use `<img src="/api/bin/:id/thumbnail">` and fall back to the category icon on error.
- [ ] **Step 6: Run the tests.** Expected: PASS.
- [ ] **Step 7: Commit.** `git commit -m "Sentry Six: Activity and Recycle Bin"`

### Task 7: Health and Server details

**Files:**
- Modify: `web/s6/status.js` (add `healthSummary`)
- Create: `web/s6/pages/health.js`, `web/s6/pages/server.js`
- Test: `test/uiPackSentrySix.test.js`

**Interfaces:**
- Produces `healthSummary(checks) -> { total, passed, problems: Check[], groups: Array<{ name, ok: number, total: number, worst: 'ok'|'warn'|'fail', line: string }> }`.

- [ ] **Step 1: Write the failing test** `healthSummary: folds passing checks per group`. Use the live server's 12 checks: copy the JSON `/api/health` returned on 2026-11-12, with one `warn` (`space-tesla`). Expect `total === 12`, `passed === 11`, `problems.length === 1`, and the group `Data folder` with `line` starting `'✓ All 5 passed'`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement `healthSummary`.**
- [ ] **Step 4: Build `pages/health.js`** to the spec: the sentence, problems with the server's `hint`, folded groups that expand, and links to Server details, Footage check, Logs and Backups. Footage check, Logs and Backups are sub-routes (`#/health/footage-check`, `#/health/logs`, `#/health/backups`) using the endpoints the shared `web/health.js` uses. Read that file for the calls and the confirm wording. Logs reuses `datepicker.js`.
- [ ] **Step 5: Build `pages/server.js`.** It polls `/api/stats` every 2 s only while the page is open and the tab is visible, with the 15 min / 24 h toggle and the `/api/stats/export.csv?range=` link. Tiles show only fields the sample has, as Original's tiles do (`web/app.js:451` onward).
- [ ] **Step 6: Run the tests.** Expected: PASS.
- [ ] **Step 7: Commit.** `git commit -m "Sentry Six: Health and Server details"`

### Task 8: Settings

**Files:**
- Create: `web/s6/pages/settings.js` (and split it into `settings/*.js` if it grows past about 600 lines)
- Test: `test/uiPackSentrySix.test.js`

**Interfaces:**
- Consumes: the same endpoints Original's Settings uses (`web/app.js:2228-2300` and the helpers it calls): `/api/settings`, `/api/updates`, `/api/system`, `/api/security`, `/api/ui-packs`, `/api/reports`, `/api/nodes`, `/api/places`, `/api/vehicles/:id/policy`. The shared modules `/web/placesSettings.js`, `/web/reportsSettings.js` and `/web/vehicleEncoding.js` mount the same way Original mounts them.

- [ ] **Step 1: Write the failing test** `settings: choosing a pack asks for the password first`. Statically check that `settings.js` calls the same confirm flow as Original's `wireInterface`, by matching the endpoint and the `confirm`/password request `web/app.js` uses there.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Build `settings.js`.** Two panes at ≥ 900 px, a list and then a page below that. Use the spec's grouping and each row's live value. The Notifications page holds the alert kinds moved from Health, and Advanced holds the metrics switch moved from Health; both use the endpoints `web/health.js` calls for them. Look & interface has the glass slider (`s6:glass`, where 0 sets `html.no-glass`), the 24-hour clock (stored where Original stores it, so both interfaces agree), reduce motion, units (`web/units.js`), and the pack cards. Cleanup rules is Original's Policies retention editor (`web/app.js:1755-1815`) restyled.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Sentry Six: Settings"`

### Task 9: Sign-in pages in Sentry USB's design

**Files:**
- Create: `examples/ui-packs/sentry-six/web/login.html`, `web/login-two-factor.html`, `web/login-code.html`, `web/s6/login.css`
- Test: `test/uiPackSentrySix.test.js`

**Interfaces:**
- Consumes: Original's `web/login.js`, `web/login-two-factor.js` and `web/login-code.js`, unchanged. The pack's HTML loads them by the same `<script src>` as Original's pages.

- [ ] **Step 1: Write the failing test** `sign-in: every id and name Original's scripts read is in the pack's pages`. For each pair (`login.html`/`login.js`, `login-two-factor.html`/`login-two-factor.js`, `login-code.html`/`login-code.js`), collect every `$('x')`, `getElementById('x')` and `[name=x]` from the repo's script. Assert `id="x"` or `name="x"` appears in the pack's HTML. Also assert each pack page links `/web/s6/login.css` and not `/web/shell.css`.
- [ ] **Step 2: Run it.** Expected: FAIL (files missing).
- [ ] **Step 3: Build the three pages** to the spec's Sign-in section and `sentry-six-signin.built.html`. Keep Original's hidden rows (setup code, confirm, opt-in, HTTPS warning, fingerprint) in the same card style. Draw the glyphs inline (`shield`, `login`, `error`, `progress_activity`).
- [ ] **Step 4: Check by hand** on a fresh data folder: first-run setup with the code from the log, sign out, a wrong password, a correct password, and two-step sign-in with a code.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit.** `git commit -m "Sentry Six: sign-in pages in the Sentry USB design"`

### Task 10: Theme the pages that keep Original's code

**Files:**
- Create: `examples/ui-packs/sentry-six/web/studioEmbed.css`
- Modify: `web/s6/s6.css` (the Sentry USB, shared-module and status-bar sections)
- Test: `test/uiPackSentrySix.test.js`

- [ ] **Step 1: Write the failing tests:**
  - `studio embed: the pack's copy starts with Original's file`. `pack.startsWith(fs.readFileSync('web/studioEmbed.css', 'utf8'))`, and the rest contains `--bg-gradient`, `--accent-glow` and `oklch(0.82 0.18 150` but not `200, 242, 90`.
  - `sentry usb: the theme sets its variables`. `s6.css` sets `--sul-car-ok`, `--sul-car-warn`, `--sul-car-bad` and `--sul-car-bg`, and styles `.sentry-sul .sul-btn`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** In `studioEmbed.css`, Original's file comes first, then an `html { … }` block of custom properties with the green values from `Sentry-Six/src/renderer/style.css:39-54`. Studio sets these on `:root`, so check that the block wins in both the Viewer and the Encoder, and use `html:root` if it's needed. In `s6.css`, theme Sentry USB (`--sul-*`, `.sentry-sul` buttons and inputs), the two status bars, and the shared modules' class names that Task 8 passes in.
- [ ] **Step 4: Check by hand.** Viewer, Encoder and Sentry USB show the green glow and glass, and behave as in Original: play, seek, the camera grid, a conversion start and stop, and Sentry USB pairing.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit.** `git commit -m "Sentry Six: Viewer, Encoder and Sentry USB in the family theme"`

### Task 11: Verify against the mockup and land on wip

**Files:**
- Modify: `examples/ui-packs/sentry-six.zip` (regenerate)
- Modify: `docs/interface-packs.md` (add Sentry Six to the list of built-in packs)

- [ ] **Step 1: Run `npm test`.** Expected: all pass.
- [ ] **Step 2: Screenshot every page.** Run the app with Sentry Six chosen, on a data folder with at least one vehicle and footage, at 1440×900 and 390×844, in headless Chrome. Cover sign-in (normal, wrong password, first run), Overview, Footage (browsing, a day expanded, selecting, date picker open), Activity (empty and with a running job if you can start a scan), Recycle Bin (empty and with items), Health, Server details, every Settings page, Viewer, Encoder and Sentry USB.
- [ ] **Step 3: Compare against `sentry-six-final.built.html`.** Check:
  - The layout, theme, fonts and icons match.
  - No text overflows at 390 px.
  - Nothing claims footage is safe while the share is down.
  - There is no disk-error row.
  - Viewer, Encoder and Sentry USB look and behave as in Original.
  - `/original` works.
  
  Fix and re-shoot until it passes.
- [ ] **Step 4: Commit and report.** `git commit -m "Sentry Six: docs and pack zip"`. Report the commit ids and attach the screenshots. Don't push. The owner's reviewer moves the commits onto `wip`.
