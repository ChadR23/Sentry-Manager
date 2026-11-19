# sentry-lean: the lean backend

The Sentry Six Manager server, in Rust: one binary that answers the **same
API** as the Node server it replaced, so the stock UIs in `web/`,
`src/renderer/` and the interface packs work as before. It is the shipped
app (the root `Dockerfile`). The Node server was removed from the repository
once its answers were frozen as reference files (`tests/fixtures/`,
`PORT_PLAN.md` "Node removed"): they are what the tests compare with.

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
| footage | `src/footage/`, `src/api.rs`, `src/arrival/` | vehicles (several, folder and SMB), shares and their health, scans and the catalog, recordings and days, Recycle Bin, cleanup policies, protect, stars, footage check, the Sentry USB checksum record (arrival checksums) |
| viewer | `src/viewer/` | telemetry, the speed index, moments, scrub previews, filmstrips, places, the event map, drives and driving, archive gaps, work limits, the Studio file routes, `/api/media` |
| ops | `src/ops/` | notifications and rules, health and the startup check, snapshots, power price and savings, image updates, metrics, the opt-in reports, system info, the server monitor (`/api/stats`: GPUs, power and RAPL, energy, data used, disks, shares, sensors, processes, alerts), the support bundle |
| ui | `src/ui/` | every page and file as Node serves it, versioned links, the critical bar, early-data hints, interface packs, exports, settings and dashboards |
| can | `src/can/` | CAN Bridge uploads (web port and core's device port), the CAN index (the newest logs first), trust, search, sync, prune, downloads, Sentry USB files, the live stats for a Stream Deck (`/api/can/now`, its link and pin, the plugin download) |
| helper servers | `src/nodes/` | pairing with pinned certificates, remote encodes, the worker (`/node/v1/*`), the benchmark, the picture check, `/api/nodes*` |
| converter | `src/converter/` | the job store, scanner, job service (lanes per GPU and per helper server), automatic conversion, the benchmark, the converted index, encoder and conversion stats, and runtime (encode, telemetry, verify, size retries, save, pause/cancel/resume, recovery after a crash), file safety (owned files, staging, recovery), MP4 writing, H.265/AV1 telemetry, verifier, planner; the 22 channels behind `/api/converter/invoke/:name` and `/api/converter/events` |
| MP4 and telemetry readers | `src/mp4.rs`, `src/sei.rs`, `src/telemetry.rs`, `src/media.rs`, `src/thumbnails.rs` | box headers only, the quick and the full telemetry read, Range answers, thumbnails with ffmpeg |

Every route of the Node server is answered. What is left (tests against a
real helper server for the converter's node lanes, a few logged error
texts) and the owner's accepted differences are in PORT_PLAN.md.

## How it is checked

- `cargo test --release --locked` in `lean/`: the unit tests (Node's own
  tests, ported) and every check against the Node code, which now compare
  with the Node server's answers frozen under `tests/fixtures/node-reference/`
  (read by `tests/support/reference.rs`): the converter (scanner, job store,
  channels, planner, automatic conversion, the benchmark, devices, telemetry
  writers, the verifier, real conversions), the helper server's worker, the
  arrival checksums, the CAN index, the MP4 and telemetry readers, archive
  gaps, vehicle ids and the reports client. `tests/fixtures/js/` holds two
  plain-Node stand-ins for outside services (a fake ACME server, the reports
  receiver): with `LEAN_NEED_NODE=1` (CI) their tests fail without node,
  otherwise they are skipped with a note.
- `node tools/contract/frozen.js`: the whole API contract (196 routes) of the
  release binary on the contract's fixture archive, against the Node server's
  frozen answers (`tests/fixtures/contract/`: goldens of every GET route and
  one request of each other route, and the live checks: the two event
  streams, a real conversion, the token routes, pairing, the random and
  session-ending answers); the owner's accepted differences are counted apart.
- `node --test "tools/**/*.test.js"` from the repository root: the dev
  tools and the image workflow.

The CI job `rust-tests` (`.github/workflows/image.yml`) runs all three
before an image is tagged.

### Ties

Two recordings that start at the same time are listed in the order the scan saw their files (`buildRecordings` keeps insertion order, then sorts by start), and an event is shown by its first front clip seen (the first clip seen when it has no front one). Node lists each folder sorted by name (libuv's scandir sorts with `strcmp`), queues one folder read and one stat per entry in that order, and keeps each file when its stat answers: a breadth-first walk in which a folder's own files come before those of its subfolders, and files kept from the last scan come the moment their folder is listed. Its stats run in parallel, so now and then an answer comes early and the order changes from one scan to the next: on the parity archive, 25 scans in a row gave 2 to 4 different orders, the usual one 15 to 24 times. `src/scanner.rs` (`node_order`) gives that usual order, always.

The former `lean/parity/compare.js` checked it strictly while Node was in the repository: it ran Node's `scanFootage` and `buildRecordings` 40 times and the lean order had to equal the one Node gave most often. In the comparison of the two servers' answers, where the Node server's own scan happened to come out another way, it lets another order through only between genuinely tied items (the same recordings at the same places, a recording shown by another of its own tied clips of the same kind, a day's picture from another recording with the same start and kind), and counts them.

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

It reads the same environment as the Node server did (src/core/config.rs
lists every name). `TLS_MODE=off` serves plain HTTP, only behind a reverse proxy that
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
