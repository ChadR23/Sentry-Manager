# Horizon

A complete replacement interface for Sentry Six Manager in a retro-futuristic
synthwave / outrun style: neon HUD panels over an endless grid that runs toward a
striped setting sun. Every page is new HTML, CSS and JavaScript that calls the
server's JSON API directly. Nothing from the original `web/` or the Studio pages is
loaded, and the pack makes no request to `/studio/`.

## Design ideas

- **Colors.** Neon magenta, hot orange, electric cyan and chrome on deep indigo.
  Headings use a chrome gradient; body text is the system font stack, numbers use
  the system monospace with tabular figures.
- **HUD panels.** Translucent dark glass with a thin neon outline and corner
  brackets. The glass is dense enough (86 %) that body text stays above WCAG AA
  contrast even over the brightest part of the sun.
- **Background.** A dusk sky, stars, a striped sun with a soft glow, wireframe
  mountains, horizon haze, faint scanlines and film grain, and a neon grid floor
  that scrolls toward the horizon. While a conversion runs the floor speeds up
  ("engine running") and the sun glows brighter.
  - Only the floor moves. It is one `<canvas>` covering just the area below the
    horizon, drawn at most 30 times a second (12 in Calm) with
    `devicePixelRatio` capped at 1.5. Everything else is static CSS/SVG; the sun
    glow and the haze only fade with `opacity`.
  - It stops completely while the tab is hidden and while a video plays in the
    Viewer. With `prefers-reduced-motion` it is a still picture.
  - Settings → Background: **Auto** (Full on computers and tablets, Calm on
    phones), **Full**, **Calm** or **Off** (a plain dusk gradient). Saved per
    browser. The quick-action button on phones and tablets has the same switch.
- **Navigation.** On a computer: a top strip styled like a car dashboard with the
  page buttons on both sides and the page name in the middle as a radio display
  (the arrows "tune" to the previous or next page). On phones and tablets: the same
  radio display, a swipeable segmented tuner bar with every page under it, and a
  round **Quick** button at the bottom for the common actions.
- **Dashboard.** An instrument cluster: a storage speedometer (share used), a
  fuel gauge for free space, CPU and memory dials, trip counters (footage hours,
  clips, recordings, size) and warning lights (share offline, low space, critical
  and warning notifications, engine/converter, scanning, Recycle Bin, policy,
  heat). Below: server telemetry meters with sparklines (CPU, memory, GPU, power
  and cost, network, disks, hottest sensor), vehicles, attention items, the encoder,
  storage, GPUs and sensors, disks and processes, CSV export, and the "black box"
  log tail (level, text and scope filters, follow, download, clear to archive,
  archives).
- **Footage.** A music library: days are albums (thumbnail, track count, minutes,
  size, category mix, conversion share); the recordings are a track list with play
  buttons, durations, cameras, codec, protection, details (summary, event, every
  file with codec and download), selection for bulk protect / unprotect / move to
  the Recycle Bin, and per-day "Move day to Bin" and "This day and older".
- **Viewer.** A full-bleed heads-up display: the main camera fills the stage with
  speed in big digits, P R N D, blinker arrows, the Autopilot glyph and state,
  brake light, steering angle, accelerator bar, clock and GPS drawn over it. The
  other cameras ride along as picture-in-picture tiles: tap one to swap it into
  the main view (or press 1 to 6). All-six grid, HUD on/off, mph/km/h, speed
  0.25×–4×, frame stepping, clip timeline with event marker, whole-day playback,
  fullscreen (an in-page theater mode where the browser has no element fullscreen,
  e.g. iPhone). A clip the browser cannot decode shows a friendly note.
- **Encoder.** A garage with a dyno: live throughput is a tachometer, the job's
  progress is a lap counter, every device's busy lanes are cylinders filling with
  each clip's progress, plus speed, time left, saved space, failures, lanes and
  clips waiting on nodes, and energy. The tune-up sheet starts a conversion (vehicle,
  H.265 / AV1, size profile, bitrate or constant quality, replace or separate
  folder, Quick or Full verify, clip groups and their order, conversions at once
  or per-device lanes). Pause, resume, cancel, retry failed, dismiss, set aside,
  live conversions-at-once / lanes, automatic conversion, a benchmark ("dyno run"),
  the timing sheet, the clips table and the converter log.
- **Nodes, Policies, Jobs (pit log), Recycle Bin, Notifications (warning lights),
  Support (chat with attachments), Settings** (vehicles, account, interface packs,
  background, updates, security / CA certificate, system, electricity price), with
  the confirmations and password re-checks the server asks for.

## Cost of the background

Measured with Playwright on the Dashboard (5 s of `requestAnimationFrame`, main-thread
busy from the Chrome `TaskDuration` metric):

| Device | Effect | Page fps | Main thread busy |
| --- | --- | --- | --- |
| Desktop 1440×900 | Full | 59.6 | 8 % |
| Desktop 1440×900 | Full, conversion running | 60 | 9 % |
| Desktop 1440×900 | Off | 60 | 2 % |
| iPhone 14, CPU ×4 slower | Auto (= Calm) | 58.8 | 18 % |
| iPhone 14, CPU ×4 slower | Full | 59.2 | 23 % |
| iPhone 14, CPU ×4 slower | Off | 59.8 | 9 % |

The floor is drawn with a single solid stroke per frame; its fade into the horizon and
its glow are static CSS layers above the canvas.

## Keyboard

| Keys | Where | Does |
| --- | --- | --- |
| `[` / `]` | everywhere | previous / next page (tune the radio) |
| `?` | everywhere | shortcut sheet |
| `j` / `k`, `Enter`, `x`, `p`, `Delete`, `i`, `/`, `Esc` | Footage | move, play, select, protect, move to Bin, details, search, clear selection |
| `Space` or `k`, `←` / `→` (Shift: 1 s), `,` / `.` | Viewer | play / pause, seek 5 s, one frame back / forward |
| `n` / `p`, `1`–`6`, `0`, `h`, `u`, `-` / `+`, `f` | Viewer | next / previous clip, main camera, all six, HUD, units, speed, fullscreen |
| `+` / `-`, `Space` | Encoder | conversions at once, pause / resume |
| `l` | Dashboard | focus the log filter |

Every shortcut also has a visible control, so everything works by touch.

## Files

```
ui.json
README.md
web/index.html          the app shell: HUD strip, radio display, tuner, quick button, icons
web/login.html          sign-in page (loads only /web/shell.css and /web/login.js)
web/login.js            the background engine (shared with the app) and the sign-in
web/shell.css           tokens, controls, HUD panels, the background, sign-in
web/hz/app.css          app layout, components and every page
web/hz/main.js          router, navigation, radio display, quick actions, keyboard, live updates
web/hz/core.js          API client (password re-check, 401), formatting, dialogs, toasts, state
web/hz/gauges.js        SVG dials (speedometer, tachometer), fuel gauge, lap ring, sparklines
web/hz/telemetry.js     Tesla SEI telemetry decoder for the HUD
web/hz/pages/*.js       one module per page
```

## Install

Zip the folder's contents (so `ui.json` is at the zip root) and upload it in
Settings → Interface, or use `examples/ui-packs/horizon.zip`. To go back, choose
**Original** in Settings → Interface, or open `/original` in a browser.
