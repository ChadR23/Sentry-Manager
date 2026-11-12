# Sentry Six interface pack: design

Date: 2026-11-12. Owner: Jhoan. Status: approved tab by tab in chat, waiting on a builder check.

## Why

The owner's words: "there is WAYYYYYYYYYYYY to much data overload ... think Apple redesigned. user firendly. easy to use, elegent ... show the data they need."

The Original interface puts every number on screen. The Overview alone is about 3,500 px tall at 1440 px wide, with CPU graphs, 15 disks, 15 sensors, a process table and raw logs. Footage is a list of 424 tall day cards, each with two delete buttons. Health mixes status checks with alert switches, Prometheus setup, database snapshots and log search. A normal Tesla owner can't tell at a glance whether their footage is safe.

This pack answers the owner's questions first and moves the rest one tap down.

## What gets built

A new built-in UI pack named **Sentry Six** (id `sentry-six`), listed in Settings › Interface next to Aurora, Daylight, Flux and Horizon. It takes the look of the owner's other products, Sentry-Six (the desktop app) and Sentry-USB-Rusty (the Pi's web UI), so the three feel like one family. Original stays the default and stays untouched, apart from the two small server additions below.

The pack redesigns six tabs: Overview, Footage, Activity (was Jobs), Recycle Bin, Health and Settings. Viewer, Encoder and Sentry USB keep Original's behaviour and code, but wear the same theme (see "Pages that keep Original's code"). The sign-in pages take Sentry USB's sign-in design.

The approved mockups are in `C:/Users/Jhoan/.t3/worktrees/Sentry-Manager/ui-redesign-mockups/` (outside the repo on purpose, since they embed thumbnails of the owner's real footage). Do not commit them. Where this document and a mockup disagree, this document wins.

`sentry-six-final.built.html` is the visual spec. It shows every tab, desktop and phone, in the final theme; switch tabs with the buttons at the top. The per-tab files below were the earlier approval rounds in a generic Apple look. Use them only for states the final file leaves out, such as the Footage date sheet on a phone and the Settings › Look details. Take their layout, never their colours or fonts.

| Tab | Earlier approval file |
| --- | --- |
| Overview | `overview-v2.built.html` |
| Footage | `footage.built.html` |
| Activity | `activity.built.html` |
| Recycle Bin | `bin.built.html` |
| Health | `health.built.html` |
| Settings | `settings.built.html` |

## Goals

- Each page answers one question in its first screenful. Overview asks if my footage is safe and what happened. Footage asks where a recording is. Activity asks what's running and what happened. Recycle Bin asks what's waiting to be deleted. Health asks if the server is OK. Settings asks how to change something.
- Problems come first and use plain words with one action each. When nothing is wrong, the page doesn't invent warnings.
- It works as well on a phone as on a desktop.
- It looks like Sentry-Six and Sentry USB: the same fonts, icons, accent colour and Liquid Glass material.

## Non-goals

- No changes to Viewer, Encoder or Sentry USB. The pack shows them exactly as Original does.
- No new server features beyond the two additions listed below.
- No change to Original's look or behaviour.

## Anti-goals

These would make the pack a failure even if it technically works:

- Showing alarms the server doesn't stand behind. Upstream removed disk-error alerts in `b8f6005` because they "flagged healthy disks as failing". The mockups show a "Disk sdd is reporting errors" row. That came from a log line written before the update. Do not bring that alert back, and do not mine the logs for it.
- Making deletion sound safer than it is. "Move to Recycle Bin" is reversible. "Also delete its CAN data" is not (`web/app.js:1448`, `server/canPrune.js:193`). Keep that option separate, unticked, and worded as permanent.
- Hiding the numbers people still want. Every number Original shows must stay reachable, one or two taps down. Nothing gets deleted from the product.
- Inventing data. When the server has no number for something, show text or a spinner, not a made-up percentage.

## Constraints

- Repo rules (`CLAUDE.md`). Finished work goes to `release/next-update`, unfinished work to `wip`. Never `main` without the owner saying so. No new branches: helper agents work in `git worktree add --detach` and their commits land by id. No co-author trailers and no model names in commits or code. Run `npm test` before every push. Every change that alters how the app looks needs desktop and phone screenshots of every page it touches.
- Everything stays inside the one container: no new services and no CDN.
- A pack's files replace built-in files of the same path, and left-out files fall back per file (`server/uiPacks.js`). Original's page registry is private inside `web/app.js`, so the pack can't reuse single Original pages by leaving files out. Codex found this in round 1.
- `web/health.js` and `web/sentryUsbLink.js` are shared modules that bring their own markup. Sentry USB uses its module unchanged, with the theme applied around it. Health needs the pack's own renderer.
- Files the pack replaces: `web/index.html`, `web/login.html`, `web/login-two-factor.html`, `web/login-code.html` and `web/studioEmbed.css`. Everything else it adds under `web/s6/`. It never replaces `web/shell.css`, any `web/login*.js`, `web/app.js`, or anything under `studio/`.
- The live server is `https://192.168.1.175:9000`, with user `sentryusb`, signed with the app's own local CA. Browsers that don't trust that CA refuse the page, so use headless Chrome with `ignoreHTTPSErrors` for screenshots.

## Server additions

Both changes are small and leave every existing caller unchanged.

1. Date range for footage. `filtered()` at `server/index.js:1847` accepts one `date`. Add optional `from` and `to` (inclusive `YYYY-MM-DD`, compared against `rec.day`). `/days` and `/recordings` both go through `filtered()`, so both get the range.
2. Thumbnails for Recycle Bin items. The current route at `server/index.js:3698` looks the recording up in the inventory, so it returns 404 once footage moves to the bin. Add `GET /api/bin/:item/thumbnail`. If the item's files include a `thumb.png` (Sentry and Saved clips), serve that file from its bin path. Otherwise take the front-camera clip and run it through the existing `thumbs.forClip`. Binned files end in `.binned`, so check that ffmpeg still reads them. Return 404 when neither exists, and the page falls back to the category icon. Use the same path guards as the existing media routes.

## Shared design

### Look: the Sentry family's Liquid Glass

The owner's rule: the layout is the one approved in this document, but the UI follows the other products. The sources of truth are `Sentry-USB-Rusty/web/src/index.css` (the `html[data-style="liquid"]` block) and `Sentry-Six/src/renderer/style.css` (`:root`, "ported from SentryUSB Rusty"). Copy their values; don't approximate them. The final mockup's "Sentry family theme" CSS block shows how they map onto this layout.

- Dark only. Neither sibling has a light mode, so this pack drops the Light/Dark/Automatic choice the earlier mockups showed.
- Background `#07090c`, lit by Liquid Glass's four radial glows: green accent from the top, from the top left and from below, and violet `oklch(0.62 0.19 285)` from the top right. Use `background-attachment: fixed`.
- Glass cards. Fill `linear-gradient(150deg, rgba(255,255,255,.075), rgba(255,255,255,.03) 55%, rgba(255,255,255,.05))`, border `rgba(255,255,255,.12)`, radius 1.5rem. Shadow `inset 0 1px 0 rgba(255,255,255,.22), inset 0 -1px 1px rgba(255,255,255,.05), 0 12px 34px rgba(0,0,0,.45)`. Backdrop `blur(22px) saturate(185%)`.
- The sidebar is full-height glass (`rgba(255,255,255,.055)`, `blur(26px) saturate(180%)`, a hairline on the right). The brand mark is the `shield` glyph on a green tile, as in Sentry USB's sidebar, then "Sentry Six" and a small "Manager · Build N" line.
- Accent green `oklch(0.82 0.18 150)` for text and icons. Solid buttons use `oklch(0.72 0.17 150)` with white text. Active nav items get a 15% accent fill with accent text.
- Segmented controls copy Sentry USB's `.tab-bar`: a glass track with radius 1rem, and the active item at `rgba(255,255,255,.14)` with a bright inset top edge.
- Status colours, from Sentry-Six: `#34d399` OK, `#fbbf24` warning or running low, `#f87171` error or permanent action, `#38bdf8` info.
- Category colours, used the same everywhere: Driving (RecentClips) `#38bdf8`, Sentry `#fbbf24`, Saved `#c4b5fd`. Green stays reserved for the accent and "OK", so it never means a category. Grey dashed means "no footage".
- Fonts. Inter for text, with `font-feature-settings: 'ss01', 'cv11'` and headings at 600 and `-0.02em`. JetBrains Mono for numeric readouts (sizes, durations, times in lists, counters), as Sentry-Six does. Both woff2 files already ship in `web/fonts`.
- Icons. Google Material Symbols, outlined, weight 400, as inline SVG. Copy the glyphs from Sentry USB's `scripts/icons` approach (pinned `@material-symbols/svg-400`, Apache-2.0, add it to NOTICE): no icon font and no network request. The navigation glyphs are `dashboard` (Overview), `folder_open` (Footage), `videocam` (Viewer), `conversion_path` (Encoder), `usb` (Sentry USB), `task` (Activity), `delete` (Recycle Bin), `cardiology` (Health), `settings` (Settings), `notifications` (the bell) and `menu` (More). The final mockup uses Sentry USB's glyph set for everything else.
- Glass effect setting. Settings › Look & interface has a Glass effect slider plus "Reduce motion and effects", as Sentry-Six's Glass Blur slider does. At zero, remove `backdrop-filter` outright (Sentry-Six's `html.no-glass` rule), not just its radius, because blur over moving content is expensive on weak GPUs. Respect `prefers-reduced-motion`.
- Phone navigation. Sentry USB uses a slide-out drawer, but the owner chose a bottom tab bar here. Style it as a floating Liquid Glass pill, with the active item in the same bright pill as the segmented control.

### Navigation

- Desktop sidebar: Overview, Footage, Viewer, Encoder. Then a "Manage" group: Sentry USB, Activity, Recycle Bin, Health. Settings sits at the bottom. The owner singled this sidebar out as liked.
- Phone: a bottom tab bar with Overview, Footage, Viewer, Activity and More. More lists the rest.
- Top right: a bell for notifications with the unread count (it replaces the Notifications tab) and an avatar that opens Account. The old top bar's 24-hour clock and reduce-effects switches move to Settings.
- Policies moves to Settings › Cleanup rules and Encoding per car. Nodes moves to Settings › Helper servers. Old hash routes (`#/jobs`, `#/policies`, `#/notifications`, `#/account`, `#/nodes`) keep working by redirecting to the new places.

### Dates and times

One formatter for the whole pack. The owner asked for this explicitly.

- A day reads "Tue, Nov 10". The year appears only for days outside the current year. Today and yesterday read "Today" and "Yesterday".
- A time reads "7:58 PM", or "19:58" when the 24-hour setting is on. A range reads "7:58 – 9:08 PM".
- Durations read "2 h 46 min". Sizes use the same unit rules as the Overview space card.
- Never show raw ISO strings (`2026-11-09T19:58:02`) or folder names in the main view. They live in ⋯ › Details.

### Selection

The same pattern applies on Footage and the Recycle Bin.

- No checkboxes and no action bar until the user presses Select (or long-presses on a phone).
- Desktop shows a floating bar at the bottom with the count and the actions. On a phone the tab bar turns into an action bar, and the header shows "Select all / N selected / Done".
- A day's checkbox shows all, some (a dash) or none, computed from the selection itself. It must stay ticked after a redraw. Original has a bug here: ticking a closed day selects its recordings but never stores them in `dayRecs`, so the box comes back unticked and only "Clear selection" undoes it (`web/app.js:1275`, `web/app.js:1420`).
- "Select all" means everything that matches the current tab and date range, not only the page on screen.

## Tabs

### Overview (locked)

From top to bottom:

1. A status sentence in large type, with any warning in amber. Under it sits a grey line: "4,809 recordings over 424 days · checked 12 minutes ago". The sentence has two halves.
   - The first half only claims what the server can show. The share being up doesn't prove every clip arrived, so it never says "everything arrived".
     - Share down or unreadable (`share.healthy` false): in red, "Can't reach your footage share." plus `share.lastError`. Nothing else on the page calls the footage safe.
     - Share up but not writable: "Your footage is readable, but the share is read-only."
     - Share up, and the newest footage (`inventory.lastDay`) is today or yesterday, or that day's archive state is "filling": "Your footage is safe and up to date."
     - Share up but the newest footage is older: "Your footage is safe. The newest is from Sat, Nov 7." This states a fact without guessing whether the car was driven.
     - A day whose archive state says footage is missing or partial (the server's own `archive.summary`) adds a "Needs your attention" row with that summary.
   - The second half is the most severe "Needs your attention" item, as a short clause, such as "Space runs out in about 27 days." With no items it reads "Nothing needs you right now."
   - My call: "safe" means only that the share is mounted, readable and writable. That's all the existing APIs can back up, and it needs no new server work.
2. "What happened lately". A five-week bar strip, one bar per day, with height from the day's recordings and colours split by Driving versus Sentry and Saved. Days with no footage show as dashed red outlines, today as an empty outline, and a day still being copied fades out. Below the strip sit the latest days with thumbnails: five on desktop, two on a phone. Data comes from `/api/vehicles/:id/days?limit=40`.
3. "Needs your attention". It only appears when something is wrong. Sources are open notifications (`/api/notifications?open=1`), health checks with `warn` or `fail` status (`/api/health`), and days in the strip window with no footage. That last item is worded neutrally: "If the car was driven then, its footage didn't reach the share." Each row has a title, one plain sentence and one action.
4. Three cards. Footage shows the total recordings and days, with a bar and legend splitting Driving, Sentry and Saved by count and size (`inventory.byCategory`). Space shows a ring, "2.9 TB free of 32.7 TB", "Grows about 108 GB a day" and an "About N days left" pill (`storage`). Activity shows Idle or running, conversion savings, Recycle Bin size and the last scan. On a phone these become compact horizontal cards with the small ring beside the text.

Nerd stats leave the Overview. The raw logs leave it too.

### Footage (locked)

- Header: title, a live "Indexing speed data · N%" chip while indexing runs (from `/api/speeds/status`, tapping it opens Activity), a Select button, the bell and the avatar.
- Filters: a segmented control with All, Driving, Sentry and Saved, each with its count. An "Other" tab appears only if such footage exists. Next to it is a date-range button ("Any date", or the chosen range with a clear ✕). Page arrows with "Days 1–30 of 424" sit at the top right and again at the bottom.
- The date picker is a popover on desktop and a bottom sheet on a phone. It has shortcuts (Today, Last 7 days, Last 30 days, This month, Custom), From and To fields, a month calendar with dots on days that have footage, a "4 days · 26 recordings" summary, and "Show these days". It needs server addition 1.
- Day rows: thumbnail, day title, tags (drives, Sentry events, saved, ✓ Indexed or "Indexing 95%", "Still arriving", protected count, CAN), then duration, cameras and size. On the right sit Play and ⋯. The ⋯ menu holds Play day, Select this day, Protect every recording, Move day to Recycle Bin and "Move this day and older…". Delete buttons are no longer on the row.
- An expanded day lists its recordings: thumbnail, time range, category tag, duration and size (Sentry and Saved show "Event at 6:06 PM"), then Play and ⋯. That ⋯ menu holds Protect or Unprotect, Move to Recycle Bin, and Files and details. Files and details shows the original folder path and Original's per-file list, each file with its own download link (`/api/media`, as `web/app.js:1548` does today). There is no whole-recording download: that would need packaging on the server, which is out of scope. The list shows five recordings, then "Show N more".
- Moving to the Recycle Bin keeps Original's confirm box, including the separate CAN-data option.
- "Review conversion" moves to the Encoder, where it belongs.

### Activity, was Jobs (locked)

- A "Now" section appears only while something runs. Otherwise the page shows one line, "Nothing running right now". There is one card per running job:
  - Conversion: GPU or CPU, start time, a % bar, clips done of total, time left, space saved so far and speed. It has Pause and Stop, plus a link to the Encoder. Progress comes from the converter event stream, the same one the Daylight pack's `convert.js` uses.
  - Indexing speed data: clips read of total and the day it's working on (`/api/speeds/status`).
  - Export: % and "1:20 of 3:00 rendered", parsed from the job's `detail`, which the exporter writes as "Rendering X of Y (N%)".
  - Anything else, such as a scan: a spinner plus the job's `detail` text. Never a made-up percentage.
- History is grouped by day (Today, Yesterday, then dates). A row has a type icon, a plain title rewritten from `type` and `result` ("Moved 12 recordings to the Recycle Bin"), and an outcome line: count, size, and "you can restore them" where that's true. On the right: ✓ Done, ✕ Failed (with the server's reason in red), or Interrupted (with what was kept), plus the time and how long it took. Conversions add energy and cost only when the server measured them.
- "Clear finished" in the header keeps Original's confirm box, and running, waiting or paused jobs are never cleared.

### Recycle Bin (locked)

- A summary card: items and total size, plus "Emptying the bin frees 476 GB on the share, about 4 more days of recording" (using `storage.perDay`). It has Restore all and Empty Recycle Bin. Restore all loops over the items client-side with progress, as Flux does. Empty is red and confirmed.
- Tabs by reason: All, Moved by you, Cleanup rules, Recovered (item `reason`: `manual`, `policy`, `recovered`).
- A one-line note about what happens to items. It must match the vehicle's cleanup rule, because a rule with `binDays` set deletes bin items for good on every run (`emptyOld`, `server/policies.js:123`):
  - Rule off, or `binDays` empty: "Nothing here is deleted until you empty the bin or press Delete forever. Restore puts footage back exactly where it was."
  - Rule on with `binDays` set: "Your cleanup rule deletes items for good N days after they arrive here. Restore them before then." Each row then also shows "Deleted for good in about N days", in amber when it's under 3 days.
  - The policy comes from `GET /api/vehicles/:id/policy` (`enabled`, `binDays`). It's my call to show the expiry per row rather than only in the note, since the deadline differs per item.
- Groups by move time and reason. Rows show a thumbnail (server addition 2), falling back to the category icon, plus category, day and start time, file count and size. Restore sits on the row, and ⋯ › Delete forever is confirmed.
- Empty state: "The Recycle Bin is empty", with one line on what the bin is for.
- Select works as on Footage, with Restore and Delete forever.

### Health (locked)

- A status sentence ("Your server is working. 2 things need a look.") plus "12 checks · last run … · Run again".
- Problems first: health checks with `warn` or `fail`, each with the server's own `hint` and one action.
- Checks folded per group (Data folder, each vehicle, Video, Access), for example "✓ All 5 passed". Tapping a group opens its individual checks.
- Links to sub-pages:
  - Server details: the old Nerd stats, as tiles for CPU, Graphics, Power, Memory, Network and Temperatures, then Storage (share, data volume, disks) and Top processes. It has the 15 min / 24 h toggle and CSV. It polls `/api/stats` only while open, so the Nerd stats switch goes away.
  - Footage check: per vehicle, with "Check now" and results.
  - Logs: the Footage date-range picker, a search box, a level filter, Download, and the support bundle.
  - Backups: the database snapshots, with "Make one now" and a confirmed Restore.
- "Which alerts you get" moves to Settings › Notifications. "Metrics for your own monitoring" moves to Settings › Advanced.

### Settings (locked)

- Desktop is two panes: a grouped list on the left, the chosen page on the right. On a phone the list opens each page.
- At the top is an account card (sentryusb · Admin) that opens Account: password, two-step sign-in, signed-in devices and Sign out.
- Your car: Vehicles, Places, Cleanup rules (the old Policies retention page) and Encoding per car (the old Policies › Per car).
- This app: Notifications (alert kinds, moved from Health), Look & interface, and Helper servers (the old Nodes). Look & interface holds Glass effect, 24-hour clock, reduce motion and effects, units, and the interface packs as picture cards with "✓ In use", "Upload a pack…" and the `/original` escape line.
- Server: Updates, Security & HTTPS (including installing the local CA on devices), System, Electricity price and Advanced (Prometheus metrics).
- Help & feedback reuses `web/reportsSettings.js`. Places reuses `web/placesSettings.js`. Both are shared modules.
- Each row's right-hand value is live: "Tesla", "Off", "Up to date", "Not set" and so on.

### Sign-in (owner's call: "the same sign in we use for Sentry USB Rusty")

Copy the layout and classes of `Sentry-USB-Rusty/web/src/pages/Login.tsx`: a centred glass card at most 384 px wide on the Liquid Glass background, and a 56 px round green tile with the `shield` glyph. Under it, "Sentry Six" (18 px, 600) and "Sign in to Sentry Six Manager." in muted text. Then Username and Password fields (12 px labels, inputs with `rgba(255,255,255,.05)` fill and a `.10` border, 8 px radius, green focus border) and a full-width solid green "Sign In" button with the `login` glyph. Errors appear above the form in a red-tinted box with the `error` glyph, and the spinner shows "Signing in..." while waiting. Mockup: `sentry-six-signin.built.html`.

- The pack replaces `web/login.html`, `web/login-two-factor.html` and `web/login-code.html` only. It keeps Original's scripts (`login.js`, `login-two-factor.js`, `login-code.js`) so first-run setup, the setup code, the diagnostics opt-in, two-step sign-in, recovery codes, the HTTPS warning and the certificate fingerprint all keep working. Every id and `name` those scripts read must exist in the pack's HTML: `code`, `code-form`, `code-row`, `codes`, `confirm-row`, `continue`, `download`, `err`, `fingerprint`, `form`, `insecure`, `key`, `lead`, `logout`, `pw`, `pw-form`, `reports-row`, `start`, `submit`, `title`, `uri`, and the inputs named `username`, `password`, `confirm`, `code`, `share` and `anonymous`.
- The first-run page (setup code, confirm password, opt-in) uses the same card, with the extra fields in the same input style.
- Original stays the default interface (owner's decision, 2026-11-12). A fresh Docker install serves Original's first-run setup, because no pack is chosen yet (`server/uiPacks.js:132`). Sentry Six's setup styling applies only when Sentry Six is already the chosen pack, for example after every account has been removed. Don't change the default pack.
- The sign-in pages load their own stylesheet (`/web/s6/login.css`), not `shell.css`.

### Pages that keep Original's code

The owner's rule: tabs that weren't redesigned still follow the theme.

- Viewer and Encoder are Studio pages in an iframe. Studio already uses Liquid Glass, but Manager's copy still glows lime (`rgba(200, 242, 90, …)` in `src/renderer/style.css:39-52`). Manager injects `web/studioEmbed.css` into both Studio pages (`server/index.js:196`, `:255`), and a pack may replace that file. Sentry Six's copy is Original's `web/studioEmbed.css`, byte for byte, followed by a block that resets Studio's `--bg-gradient`, `--accent-glow`, `--accent-hover` and `--accent-bg` to the family green values in `Sentry-Six/src/renderer/style.css:39-54`. Keep the copy in sync: a test fails when Original's file changes.
- The iframe surround (the page background behind the frame, the frame's corners, and the Encoder's loading skeleton) uses the pack's tokens.
- Sentry USB mounts `/web/sentryUsbLink.js` unchanged. Theme it through its `--sul-*` variables (`web/sentryUsbLink.js:73-94`) and its `.sentry-sul` button and input classes in `s6.css`: glass tiles, the accent for active states, and the status colours for OK, check and unsafe.
- Shared pieces from Original that appear in Sentry Six also get the theme: the critical-update bar and the startup-check bar (`#sentry-critical-update`, `#sentry-health-bar`), Account (`/web/account.js`), Places (`/web/placesSettings.js`), Help & feedback (`/web/reportsSettings.js`), and Encoding per car (`/web/vehicleEncoding.js`). Pass these modules the pack's class names where they accept them, and style what they draw.

## Left to the builder

- File layout inside the pack, and how it reuses Original's Studio iframe handling for Viewer and Encoder. Codex noted the details that must survive: vehicle, date and folder parameters, pause-on-hide, sizing, and the `sentry-studio` postMessage events at `web/app.js:1737`.
- Exact poll intervals, animation and transitions.
- Test layout. Follow `test/uiPackExamples.test.js` and `test/uiPackAuroraDaylight.test.js`.
- Whether the strip and the date picker share code.

## Process

Claude designed this with the owner. Codex (Astra) builds it in a detached worktree and verifies it. Claude reviews the result against this document and the mockups before anything lands on `wip`.
