# Daylight

A complete interface pack for Sentry Six Manager, written from scratch
(new HTML, CSS and JavaScript; nothing from the built-in pages or Studio).
It is built for the everyday Tesla owner: calm, friendly, plain language
first, the technical details tucked into "More details".

Install: Settings → Interface → Upload a pack, pick `daylight.zip`
(it asks for your password), then choose **Daylight**. To go back, pick
**Original** in the same place, or open `/original` in a browser.

## Design ideas

- **Light first, dark too.** Warm off-white surfaces, soft shadows, one deep
  teal accent. A proper dark look follows the device
  (`prefers-color-scheme`); the moon/sun button (or Settings → Look) picks
  Automatic, Light or Dark for this browser.
- **Big, readable, roomy.** A system font stack at 17 px, generous spacing,
  touch targets of at least 44 × 44 px, inputs at 16 px or more.
- **Today answers the questions first.** Is my car's footage safe? How much
  space is left? Is anything converting? Does anything need me? Four big
  cards, one clear action each, then the latest days, your vehicles and a
  short server summary.
- **Footage as a calendar.** A month calendar with the days that have
  footage, and picture cards for each day. Tap a day to see its drives,
  Sentry events and saved clips: play, protect, move to the Recycle Bin (with
  **Undo**), or tidy up the whole day ("this day" / "this day and older").
- **A big, simple Viewer** (its own code, no Studio). All six cameras laid
  out like the car, played in sync from `/api/media`; tap a camera to make it
  big, tap again for the grid. Large play controls, a scrubber, clip buttons,
  speed, full screen, and the driving data (speed, gear, Autopilot, brake,
  accelerator, steering, turn signals) decoded from `/api/telemetry`. Turn a
  phone sideways and the picture gets the whole screen.
- **Guided flows.** "Save space on my footage" asks what you want to do
  (shrink / make copies / test speed), which footage, how small, then shows a
  plain summary before it starts. "Add a vehicle" asks where the footage
  lives (network share or folder), then the details, then confirms.
- **Encoder** (its own code on `/api/converter/invoke/*` and
  `/api/converter/events`): live progress, speed, time left, space saved,
  pause / resume / stop, clips at once (per GPU, CPU and helper server when
  there are several), automatic conversion (interval, hours or off-peak), a
  speed test with a recommendation.
- **Navigation.** A side bar on wide screens; on phones a bottom tab bar
  (Today, Footage, Viewer, Encoder, More) with the rest under More.
- **Motion** is short and subtle, and switched off by the device's "reduce
  motion" setting or by Calm mode (Settings → Look).

Everything the built-in interface does is here: Overview (as Today plus
Server & logs), Footage, Viewer, Encoder, Helper servers (Nodes), Cleanup
rules (Policies), Activity (Jobs), Recycle Bin, Alerts (Notifications) with a
live badge, Help & support (chat with attachments), and Settings (vehicles,
account, look, interface packs, security and certificates, updates, system
and the electricity price).

## Keyboard shortcuts (Viewer)

| Key | Does |
| --- | --- |
| Space or K | Play / pause |
| ← / → | Back / forward 5 seconds |
| J / L | Back / forward 10 seconds |
| , / . | One frame back / forward (pauses) |
| [ / ] | Previous / next clip |
| P / N | Earlier / later recording that day |
| 1 – 6 | Make a camera big (front, rear, left side, right side, left pillar, right pillar) |
| 0, G or Esc | All cameras |
| − / + | Slower / faster |
| F | Full screen |

## Files

```
ui.json
web/index.html        the app shell
web/login.html        sign-in (and first-run setup)
web/login.js          sign-in script (the only script the sign-in page may load)
web/shell.css         design tokens and base components (shared with sign-in)
web/dl/theme.js       applies the chosen look before the first paint
web/dl/app.js         navigation, router, live updates, badges
web/dl/app.css        layout and page styles
web/dl/core.js        API, formatting, dialogs, toasts, icons
web/dl/state.js       vehicles, alerts, shared state
web/dl/convert.js     converter live stream and progress maths
web/dl/telemetry.js   Tesla driving-data decoder
web/dl/pages/*.js     one module per page
```
