# sentry-lean: the lean backend

The Rust port of the Sentry Six Manager server: one binary that answers the
**same API** as the Node server (`server/`), so the stock UIs in `web/`,
`src/renderer/` and the interface packs work on either. The Node code is the
specification (`PORT_PLAN.md`). Node stays the shipped app until this one
answers every route the same way.

Every area is served through core: core's `AppState` (config, manager.db,
accounts and sessions, access rules, HTTPS, logs, the live-update hub, jobs)
and its `Router` are the one entry point; `src/wire/` makes each area on
core's state and puts its routes into core's router (PORT_PLAN.md,
"Integration"). Sign-in is required and HTTPS is on by default (the same
`/data/tls` and manager.db as Node: either server can take over the other's
data folder). Passwords only go over HTTPS.

Footage is read-only except where Node writes (Recycle Bin, cleanup,
restore), with the same checks. The server's own state is in `DATA_PATH`:
`manager.db` (settings, accounts, sessions, jobs, notifications, the Recycle
Bin, the footage catalog in its `catalog_*` tables), and Node's caches
(`speeds/`, `telemetry/`, `scrub/`, `thumbnails/`, `clip-thumbnails/`,
`drive-data/`, `can-index/`, `exports/`, `ui-packs/`, `tls/`).

## What is in it

| Area | Where | State |
| --- | --- | --- |
| core | `src/core/` | config, manager.db, accounts, two-step sign-in, sessions, access rules, the client address, HTTPS with its own CA and Let's Encrypt, logs, `/api/events`, jobs, the router and the request checks in Node's order (`src/core/README.md`) |
| supervisor | `src/supervisor/` | the root supervisor (`sentry-lean-supervisor`): starts the app as PUID:PGID, SMB mounts, restarts, TLS export; the app takes its fd-3 link (`src/supervisor/README.md`) |
| footage | `src/footage/`, `src/api.rs` | vehicles (several, folder and SMB), shares and their health, scans and the catalog, recordings and days, Recycle Bin, cleanup policies, protect, stars, footage check |
| viewer | `src/viewer/` | telemetry, the speed index, moments, scrub previews, filmstrips, places, the event map, drives and driving, archive gaps, work limits, the Studio file routes, `/api/media` |
| ops | `src/ops/` | notifications and rules, health and the startup check, snapshots, power price and savings, image updates, metrics, the opt-in reports, system info, stats, the support bundle |
| ui | `src/ui/` | every page and file as Node serves it, versioned links, the critical bar, early-data hints, interface packs, exports, settings and dashboards |
| can | `src/can/` | CAN Bridge uploads (web port and core's device port), the CAN index, trust, search, sync, prune, downloads, Sentry USB files |
| converter | `src/converter/` | library only: file safety (owned files, staging, recovery), MP4 writing, H.265/AV1 telemetry, verifier, planner. Its routes answer as Node does while its converter starts |
| MP4 and telemetry readers | `src/mp4.rs`, `src/sei.rs`, `src/telemetry.rs`, `src/media.rs`, `src/thumbnails.rs` | box headers only, the quick and the full telemetry read, Range answers, thumbnails with ffmpeg |

Not in it yet: the converter's job store, job service and IPC; the helper
servers (`/api/nodes*` answer 501 "Not in this server yet.", `/node/v1/*`
404); `POST /api/studio/trashFolder` (501); arrival checksums; CAN and
Sentry USB evidence in archive gaps, drives and place tags; some stats
parts. PORT_PLAN.md lists each.

## How it is checked

On the integrated server (PORT_PLAN.md, "Integration", has the numbers):

- `cargo test --release` in `lean/`;
- `node lean/parity/contractAll.js`: the whole API contract, the Node
  fixture against lean (both over HTTPS, signed in), every route;
- per area: `compare.js` (footage lists, viewer, media), `compareFootage.js`
  (the footage area's writes), `canCompare.js`, `opsCompare.js`,
  `uiCompare.js`, `contractUi.js`, `uiPages.js` (Chromium),
  `contractFootage.js`. Each signs in on lean as on Node.

The first slice's checks, still run by `compare.js`:


- `cargo test --release` in `lean/` runs unit tests, `tests/mp4_parity.rs` and `tests/slug_parity.rs`.
  - `mp4_parity.rs` runs `parity/mp4Fixtures.js`, which makes 49 MP4 fixtures. Some are real ffmpeg encodes: Tesla-like H.264 with telemetry, the same clip converted to H.265 and to AV1 the way the converter does it, and plain encodes. Others are synthetic, built with `test/fixtures/fixtureBuilders.js`: NAL length sizes 1, 2 and 4, co64, extended boxes, several chunks, an audio track, ctts, a record placed after the first 4 KB, odd protobufs, a dozen broken files, and twelve made for the speed index's fallback (real and synthetic clips with more than 64 top-level boxes, an edit list, one cut short). The script stores what the Node code gets from each file: `videoCodec`, `readSamples`, `readSpeeds`, `summarize`, the `mp4.js` sample index with timescale, duration and keyframes, every record `telemetry.js` `readRecords` lists with its time, and what the speed index itself (`createSpeedIndex`, its full read in a worker as on the server) keeps for the clip. The Rust output must match all of it exactly, including which files fail. It does: 49 fixtures, 7 readers, no differences. On 30 fixtures the quick read gives up and the fallback runs; on 11 of them it finds speeds.
  - `slug_parity.rs` runs `server/vehicles.js` (`normalizeVehicle`, `slug`) on 32 names (accents, ligatures, full-width and Roman-numeral letters, Greek final sigma, Turkish İ, other scripts, emoji, JavaScript's white space, cuts at 40 and 60) and compares the name and id with the Rust ones. They match.
- `node lean/parity/compare.js [--archive dir]` starts the Node server and the lean server on the same archive (`parity/makeArchive.js`: edge cases, real clips, left-out files, tied recordings, clips for the speed fallback and for thumbnails) and waits until both have finished scanning, reading codecs and indexing speeds. It then compares the answers of the routes above: 13 days queries, 8 recordings queries, every recording's details, the 404s, speeds per day, `/api/media` with 15 range and refusal cases including the bytes, and every recording's thumbnail including the JPEG bytes made from clips. It checks the tie order strictly against Node's own scan (below), runs a second pair of servers without ffmpeg and compares their thumbnails, and checks that no file or folder of the footage changed (size, times, inode; Node's own `.sentrymanager/` checksum record left out, Node writes it). Result: 133 requests, no differences; the footage unchanged. On the 4,000-file archive (`makeArchive.js dir --many 4000`): 502 requests, no differences. (One run of three there differed in `/api/speeds/status` `limit`: Node's speed index raises its pace to 2 when the server keeps up for a while, which depends on timing; lean reports 1.)
- `test/leanParity.test.js` runs `compare.js` under `npm test` when the lean binary is built. Otherwise it is skipped.

### Ties

Two recordings that start at the same time are listed in the order the scan saw their files (`buildRecordings` keeps insertion order, then sorts by start), and an event is shown by its first front clip seen (the first clip seen when it has no front one). Node lists each folder sorted by name (libuv's scandir sorts with `strcmp`), queues one folder read and one stat per entry in that order, and keeps each file when its stat answers: a breadth-first walk in which a folder's own files come before those of its subfolders, and files kept from the last scan come the moment their folder is listed. Its stats run in parallel, so now and then an answer comes early and the order changes from one scan to the next: on the parity archive, 25 scans in a row gave 2 to 4 different orders, the usual one 15 to 24 times. `src/scanner.rs` (`node_order`) gives that usual order, always.

`compare.js` checks it strictly: it runs Node's `scanFootage` and `buildRecordings` 40 times and the lean order must equal the one Node gives most often. In the comparison of the two servers' answers, where the Node server's own scan happened to come out another way, it lets another order through only between genuinely tied items (the same recordings at the same places, a recording shown by another of its own tied clips of the same kind, a day's picture from another recording with the same start and kind), and counts them.
- `node lean/parity/measure.js [N]` measures memory and readiness for both servers.

## Measured (the first slice, before the other areas)

Release binary: 3.6 MiB (3,734,840 bytes), stripped, linked against glibc only; the static musl one in the image is 3.7 MiB (3,902,384 bytes).

One synthetic archive of 4,059 files (sparse 30 MB clips over 9 days, 130 recordings), one server at a time, on the same machine:

| | Node server | sentry-lean |
| --- | --- | --- |
| Resident memory, idle | 157 MB | 13 MB |
| Peak resident memory | 219 MB | 13 MB |
| Footage list ready (scan, codecs, speed index) | 104 s* | 0.3 s |

\* Most of the Node time is the speed index's built-in pacing: 100 ms between clips, for about 1,000 front clips. Both servers produce the same answers on this archive.

## Build and run

```sh
cd lean && cargo build --release
FOOTAGE_PATH=/path/to/footage VEHICLE_NAME="My car" TZ=Europe/Berlin UI_PASSWORD='a long password' \
  DATA_PATH=/tmp/lean-data APP_ROOT=$PWD/.. PORT=9000 target/release/sentry-lean
# https://<host>:9000 (its own certificate authority: DATA_PATH/tls/ca.crt)
```

It reads the Node server's environment (src/core/config.rs lists every
name). `TLS_MODE=off` serves plain HTTP, only behind a reverse proxy that
does HTTPS. In the image, `sentry-lean-supervisor` is the entrypoint
(`src/supervisor/README.md`).

### The image

`Dockerfile` builds a static musl binary (`rust:1.97-slim-trixie`) and puts it on `alpine:3.22` with the UI files and ffmpeg. It runs as user 1000, keeps its state in the `/data` volume and has a health check on `/healthz`. `Dockerfile.dockerignore` keeps the build context to the lean sources and the UI files. From the repository root:

```sh
docker build -f lean/Dockerfile -t sentry-lean .
docker build -f lean/Dockerfile --build-arg FFMPEG=0 -t sentry-lean:slim .   # no ffmpeg, no thumbnails from clips
# behind a proxy that inspects TLS (the certificates are used for the downloads only, not kept):
docker build -f lean/Dockerfile --secret id=build_ca,src=/path/to/ca-bundle.crt -t sentry-lean .
```

| Image | On disk | Compressed |
| --- | --- | --- |
| `sentry-lean` (with ffmpeg 6.1) | 205 MB | 55.7 MB |
| `sentry-lean:slim` (`FFMPEG=0`) | 25.6 MB | 7.3 MB |

These sizes are the first slice's; the integrated binary is larger (HTTPS, accounts, every area: about 17 MB). The Dockerfile is still the first slice's sketch: it has to run the supervisor as root under tini (`sentry-lean-supervisor` as CMD, with setpriv and cifs-utils; src/supervisor/README.md) before it is the image to ship. Always mount the footage read-only (`:ro`) until the Recycle Bin is wanted.
