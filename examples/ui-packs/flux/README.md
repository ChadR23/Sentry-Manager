# Flux

A complete replacement interface for Sentry Six Manager: a sleek, information-dense
control console for people who want every number. Every page is new code that calls
the server's JSON API directly; nothing from the original `web/` or Studio pages is
loaded, and the pack makes no request to `/studio/`.

## What it is

- **Dark only.** Deep graphite neutrals with electric violet and cyan accents, defined
  in OKLCH (`web/shell.css`). Monospace for numbers, paths and IDs; the system sans for
  labels. System font stacks only.
- **Navigation.** A collapsible sidebar (`[`), a command palette (Ctrl/⌘ K) that jumps to
  any page, vehicle or action, and `g`-chord shortcuts everywhere. On phones it becomes
  one column with a top bar and a slide-out menu (swipe left to close it).
- **Resizable split panes** on desktop (drag the divider, or focus it and use the arrow
  keys; double-click resets). Widths are remembered per page in this browser.
- **Overview.** Live telemetry from `/api/stats` (every 2 s) prefilled from
  `/api/stats/history`, drawn on canvas: CPU with a per-core heat strip, GPU busy and
  video engine, power in watts with cost per hour, memory, network up/down, disk
  read/write and busy (I/O wait), temperatures, top processes. Hover, tap or drag any
  chart for a readout; tap a legend key to hide a series. Live 15 min or 24 h, CSV
  export of both. A log tail with level, scope and text filters, follow mode, download,
  clear (archives) and the archive list.
- **Footage.** Days on the left (category mix, encoded share, Play / Delete day / Delete
  through), a dense sortable and filterable table on the right (start, type, duration,
  cameras, files, size, codec and converted share, protection). Bulk selection by
  keyboard or touch, Protect / Unprotect / Move to Bin, and a raw-JSON inspector drawer
  (summary, files with codecs and downloads, colourised JSON, copy).
- **Viewer.** Six synced cameras from `/api/media`, any subset. Play/pause, frame stepping,
  speed 0.1×–8×, a playlist timeline (one block per clip, event marker, drag to scrub),
  next/previous clip, whole-day playback, camera layouts (grid, focus, front+back,
  single), tap a camera to focus it, fullscreen. A telemetry panel decodes
  `/api/telemetry` in the browser (a small protobuf reader): speed (mph/km/h), gear,
  steering wheel, Autopilot state, accelerator, brake, blinkers, GPS, heading, plus a
  speed/steering chart for the clip. On phones held sideways the picture gets the room.
- **Encoder.** Start a conversion of a vehicle's footage (H.265/AV1, size profile, custom
  bitrate or constant quality, replace originals or separate folder, Quick/Full verify,
  clip groups and their order, conversions at once or per-device lanes when there are
  GPUs/nodes). Live state from `/api/converter/events`; pause, resume, cancel, retry
  failed, dismiss, set aside; change concurrency or lanes on the running job. Per-lane
  throughput (fps sparkline per device, per-clip progress, speed, bitrate) from
  `/api/stats`, a per-clip state table (discovering, waiting, encoding %, waiting on node,
  verify/save, done, failed…), a timings breakdown per phase, automatic conversion
  settings, a benchmark, and a converter log tail.
- **Nodes, Policies, Jobs, Recycle Bin, Notifications, Support, Settings** (vehicles,
  account, interface packs, updates, security/CA download, system, electricity price,
  appearance), all with the confirmations and password re-checks the server asks for.
- **Motion.** Small transitions (page fade, drawers, toasts, meters, live pulses). All of
  it is off with `prefers-reduced-motion` or Settings → Appearance → Reduce effects.

## Keyboard

| Keys | Where | Does |
| --- | --- | --- |
| Ctrl/⌘ K | everywhere | command palette |
| ? | everywhere | shortcut sheet |
| g o / f / v / e / n / p / j / b / a / h / s | everywhere | Overview, Footage, Viewer, Encoder, Nodes, Policies, Jobs, Bin, Alerts (notifications), Help (support), Settings |
| [ | everywhere | collapse the sidebar |
| / | lists | focus the filter |
| j / k, Shift+j / k | Footage | move, extend the selection |
| x or Space, Ctrl/⌘ A, Esc | Footage | select row, select all, clear |
| Enter or o, i, p, Delete | Footage | play, inspector, protect, move to Bin |
| Space or k, `,` `.` | Viewer | play/pause, one frame back/forward |
| ← → (Shift: 1 s) | Viewer | seek 5 s |
| [ ] | Viewer | slower / faster |
| n / p, 1–6, 0, l, t, f | Viewer | next/prev clip, focus camera, all cameras, next layout, telemetry, fullscreen |
| + / −, Space | Encoder | conversions at once, pause/resume |
| r | Overview | live / 24 h |

Every shortcut also has a visible control, so everything works by touch.

## Files

```
ui.json
web/index.html        the app shell (sidebar, top bar, palette, dialogs, icons)
web/login.html        sign-in page (loads only /web/shell.css and /web/login.js)
web/login.js          sign-in, first-run setup code, throttling countdown
web/shell.css         design tokens + base controls (shared with sign-in)
web/flux.css          app layout and components, responsive and touch rules
web/flux/main.js      router, sidebar, palette, shortcuts, live updates, badges
web/flux/core.js      API client (password re-check, 401), formatting, dialogs, state
web/flux/charts.js    canvas time-series, heat strip, sparklines
web/flux/ui.js        split panes, drawer, segmented controls
web/flux/telemetry.js Tesla SEI protobuf reader
web/flux/pages/*.js   one module per page
```

## Install

Zip the folder's contents (so `ui.json` is at the zip root) and upload it in
Settings → Interface, or use `examples/ui-packs/flux.zip`. To go back, choose
**Original** in Settings → Interface, or open `/original` in a browser.
