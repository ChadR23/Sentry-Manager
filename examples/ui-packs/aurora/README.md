# Aurora

A complete interface pack for Sentry Six Manager, written from scratch (new HTML,
CSS and JavaScript; nothing from the built-in pages or from Studio). A night sky
with slowly drifting northern lights sits behind a frosted-glass, spatial
interface: glass windows float over the sky and a dock floats at the bottom.

Install: Settings → Interface → Upload a pack, pick `aurora.zip` (it asks for
your password), then choose **Aurora**. To go back, pick **Original** in the
same place, or open `/original` in a browser.

## Design ideas

- **The sky is the star.** Aurora curtains in green, teal, violet and magenta
  are drawn on one low-resolution `<canvas>` (they are soft, so a half-size
  canvas stretched by the browser looks the same at a quarter of the pixels),
  over a deep night-blue CSS sky with a still starfield (a second canvas drawn
  only on resize), a few twinkling stars (opacity animations) and, now and
  then, a shooting star. The curtains drift with the mouse or the device tilt.
- **Cheap on purpose.** At most 30 frames per second (calm: 20),
  devicePixelRatio capped at 1.5, nothing drawn while the tab is hidden or a
  video plays in the Viewer, and a still, painted sky for "off" and for
  `prefers-reduced-motion`. Settings → Interface → Background effect:
  **Full / Calm / Off**, saved in this browser; every browser starts on Calm. "Solid
  glass" there turns the backdrop blur off for older devices.
- **Glass you can read.** Panels are frosted glass (backdrop blur, with a solid
  fallback where the browser has none) with soft light edges and depth; the
  tint is dark enough that body text stays above WCAG AA over the brightest
  part of the sky.
- **A floating dock** at the bottom on every screen: icons whose labels appear on
  hover (always shown under the icons on touch screens). Phones show Sky,
  Footage, Viewer, Encoder, Alerts and **More** (a glass sheet with the rest).
  Pages open as glass windows with a short rise-and-fade.
- **Large, airy type** from the system font stack.

## Pages

- **Sky** (home): a hero with the vehicle, what its footage holds and its storage
  as a glowing ring (outer: the share used; inner: the footage), then floating
  widgets: Attention (notifications and server alerts), the Encoder, the latest
  days, the server (CPU with per-core bars, memory, network, power and cost,
  GPUs, shares, disks, temperatures, busiest processes, CSV export; live every
  2 s), Keeping (Recycle Bin and policy) and the Logs (problems or everything,
  refresh, download, clear into the archive, cleared logs).
- **Footage**: a horizontal filmstrip of days with thumbnails (category dots,
  minutes, size, protected, encoded), category filter, protected only, jump to a
  date. Under it the chosen day: Play day, select all, Delete this day, Delete
  through this date; each recording as a glass card (play, protect/unprotect,
  move to the Bin, files with codecs and downloads), and bulk actions.
- **Viewer**: the six cameras as a cockpit. Front large in the middle, the
  pillars and repeaters angled around it like side windows, the back camera as
  a rear-view-mirror strip on top (mirror it with **Mirror**). The cameras are
  sized to sit above where the control bar and the dock rest, so none is
  covered; on narrow portrait screens the four side cameras line up under the
  front one. Phones held sideways get a theatre view while playing: the top
  bar and the date, event and recordings rows step aside (they come back on
  pause, or scroll down), the cockpit fills the screen height, the front
  camera takes well over half the width with the pillars and repeaters at its
  sides and the rear camera hanging over it like a rear-view mirror; small
  tiles label themselves LP, LR, RP, RR and R. While a recording plays, the bar and the dock fade away after
  2.5 s without pointer, touch or keyboard activity and come back on any mouse
  move, tap or key (they stay while paused, while the mouse is over them or a
  control has keyboard focus; no animation with reduced motion). The glass
  control bar: previous/next clip, ±5 s, play/pause, a scrubber for the
  whole recording or day (clip marks and the event marked), speed, HUD
  (speed, gear, Autopilot, steering, blinkers, brake, pedal, GPS from
  `/api/telemetry`), km/h or mph, full screen. Tap a camera to focus it. A clip
  the browser can't decode shows "This browser can't play this video" with a
  download.
- **Encoder**: a radial progress ring with an orbiting light for each clip being
  converted (coloured by device), the live numbers (clips, speed, time left,
  saved, working now, waiting on nodes, problems), pause/resume/cancel, retry
  failed, dismiss, clear, conversions at once or per device lanes changed live,
  the clips, where the time goes; a new conversion (vehicle, H.265/AV1, size
  profile / constant quality / custom bitrate, replace originals or a separate
  folder with a folder browser, verify, clip groups and their order, network
  mode); automatic conversion; a benchmark.
- **Nodes**, **Policies**, **Jobs** (a timeline), **Recycle Bin**,
  **Notifications** (mark read, dismiss; the dock badge counts unread),
  **Support** (chat, attachment, diagnostics, close), **Settings** (vehicles
  SMB/folder, account, interface incl. packs and the background effect,
  updates, security and certificates, system, electricity price).

## Keyboard shortcuts

| Keys | Where | Does |
| --- | --- | --- |
| `g` then `s` `f` `v` `e` `n` `p` `j` `b` `a` `h` `,` | everywhere | Sky, Footage, Viewer, Encoder, Nodes, Policies, Jobs, Bin, Alerts, Support (help), Settings |
| `?` | everywhere | the list of shortcuts |
| `Space` or `k` | Viewer | play / pause |
| `←` `→` (Shift: 1 s) | Viewer | back / forward 5 s |
| `,` `.` | Viewer | one frame back / forward |
| `[` `]` | Viewer | previous / next clip |
| `-` `+` | Viewer | slower / faster |
| `1`–`6`, `0` / `Esc` | Viewer | focus front, rear, left repeater, right repeater, left pillar, right pillar; all cameras |
| `t`, `m`, `f` | Viewer | HUD, mirror the rear view, full screen |
| `←` `→` | Footage filmstrip | previous / next day |

Every shortcut also has a visible control, so everything works by touch.

## Files

```
ui.json
web/index.html            the shell (sky canvases, top bar, dock, dialogs, icons)
web/login.html, login.js  sign-in and first-run setup (only these may load before sign-in)
web/shell.css             tokens, glass, controls, sign-in page
web/aurora/boot.js        applies the background effect and glass choice before the first paint
web/aurora/sky.js         the northern lights, stars and shooting star
web/aurora/main.js        windows, dock, live updates, badges, shortcuts
web/aurora/core.js        API (password re-check, sign-out), formatting, dialogs, toasts
web/aurora/conv.js        the converter's live stream and progress maths
web/aurora/telemetry.js   Tesla driving-data decoder
web/aurora/app.css        layout and pages
web/aurora/pages/*.js     one module per page
```
