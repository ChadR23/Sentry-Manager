# Export a video

[← Back to the README](../README.md)

**Export** in the Viewer turns a stretch of footage into one video file:
the cameras in a grid (or one camera), with the date, time and speed burned
in. The server renders it, so it works the same from a phone.

Every interface has it: the built-in Viewer (the download button in the
playback bar), Horizon, Flux, Aurora (under **⋯** on a phone) and Daylight,
or press **e** in any of them.

## Making one

1. Play or scrub to where the video should start and open **Export**.
2. Press **Set start here**. The end is put 30 seconds later, so you see
   the clips at once.
3. Play or scrub to the end and press **Set end here**. The panel stays
   open beside the player, so you can keep playing, scrubbing and switching
   clips. On a phone it covers the controls: close it with **✕**, move, and
   open it again; the start and end are kept.
4. The panel lists **the clips the stretch covers**: each clip's time, its
   type (Recent, Sentry, Saved), how many cameras it has, and which part of
   it is used (`0:40–1:00`, or *whole clip*). It also says how long the
   video will be.
5. Choose **All cameras (grid)** or one camera, and mph or km/h, then press
   **Export video**.
6. The bar shows the progress (**Jobs** shows it too). When it is done,
   press **Download video**.

## What you get

- **An MP4 (H.264, 30 frames a second)** that plays on any phone, computer
  or video editor.
- **All cameras:** a grid laid out as the cameras sit on the car: pillars
  beside the front camera and the repeaters beside the rear one (3 × 2,
  1920 × 960). Cars without pillar cameras get 2 × 2 (1280 × 960). Each tile
  is named.
- **One camera:** that camera's picture, up to 1920 pixels wide.
- **Burned in:** the date and time (in the 12- or 24-hour clock chosen in
  Settings) and the speed, from Tesla's telemetry, each second.
- A camera a clip doesn't have, or whose file is damaged, is a black tile;
  a clip that can't be read at all is left out. The job says which.

## Limits

- Up to **60 minutes** in one export.
- **One export at a time**; another one waits in Jobs until it is done.
  Cancel either from the panel.
- Rendering uses the CPU at a lower priority, so playback and conversions
  carry on; a long all-camera export can take about as long as the footage.
- The finished file is kept on the server for **a day** (the 10 newest at
  most), in `data/exports`, then removed. Download it before then.
- No sound: Tesla's cameras record none.
