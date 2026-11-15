# sentry-lean: the lean backend

A start on a second backend for Sentry Six Manager, in Rust: one small
binary that answers the **same API** as the Node server (`server/`), so the
stock UIs in `web/` and `src/renderer/` work on either. It is built in the
order the plan gives, read-only parts first. This is the first slice: the
footage list and recording details. Everything else is still the Node
server's job.

The footage is read-only. The lean server never writes, moves or deletes
anything in a footage folder. It only lists folders, stats files and reads
files. Its own state lives in `DATA_PATH`: the catalog in
`lean-catalog.sqlite`, thumbnails made from clips in `thumbnails/`.

## What works

| Part | Where | Notes |
| --- | --- | --- |
| HTTP server | `src/main.rs`, `src/api.rs` | Axum on Tokio. File work runs on blocking threads. |
| Footage catalog | `src/catalog.rs` | SQLite in WAL mode (rusqlite, bundled). Holds every file of the last scan, folder times, clip codecs and the speed index. |
| Scan | `src/scanner.rs`, `src/footage.rs` | Builds the catalog from directory listings and stats only, without opening videos. Tesla file names give the time and camera. Rescans are incremental: a folder whose modified time has not changed keeps its files. A light rescan runs at start-up and every 15 minutes, and every sixth rescan is a full one. Same classification as `server/footage.js` and `server/scanner.js`. The files come out in the order the Node scan sees them (see Ties below). |
| Recordings and days | `src/inventory.rs` | Events and drives (a gap of more than 90 s starts a new drive), day cards, totals, `event.json` fields. A port of `server/inventory.js`, including its quirks (for example, a clip dated Feb 30 counts as Mar 2 when drives are grouped). |
| Vehicle | `src/app.rs` | One vehicle from `FOOTAGE_PATH`. Its name is kept as `server/vehicles.js` keeps it (JavaScript's trim, at most 60 UTF-16 units) and its id made the same way (`slug`: lower case, NFKD, every other run of characters one dash), so `Café` is `cafe` and `Ölçü` is `o-lc-u`, as on Node. |
| MP4 metadata | `src/mp4.rs` | Reads only the box headers and `moov`: sample offsets and sizes, decode and presentation times, timescale, duration, codec and keyframes (`stss`). It never reads media data and never runs ffprobe. Same checks as `src/main/converter/mp4.js`. The lenient codec read of `server/mp4codec.js` is here too. |
| Telemetry, quick read | `src/sei.rs` | Reads one record a second without reading the whole clip. It strips emulation-prevention bytes and looks for SEI payload type 5 with Tesla's `42…42 69` marker. H.264 records come before the picture. H.265 uses the `66 01` compatibility records. AV1 keeps all records in the first `mdat`, each ended by `61 01 80`. A port of `server/speedReader.js` (`teslaPayload`, `recordIn`, `sampleOfBytes`). |
| Telemetry, full read | `src/telemetry.rs` | Every frame's records with their times, as the dashboard reads them: `server/telemetry.js` `readRecords` with Studio's parser (`src/renderer/scripts/data/dashcam-mp4.js`), ported check for check. The file is read 4 KB pages at a time (at most 256 kept): the index and, of each frame, the records ahead of the picture, never a picture's bytes. |
| Speed index | `src/speeds.rs` | One speed a second and a summary (`summarize`) for every front clip, cached in SQLite. A clip is read again only when its size or time changes. When the quick read gives up (more than 64 top-level boxes, an edit list it does not take, a fragmented file, and so on), the full read gives the speeds, averaged per second, and a summary of those, as `server/speedIndex.js` `speedsFor` does. |
| Thumbnails | `src/thumbnails.rs` | Tesla's `thumb.png` as it is. Without one, one frame of the front clip, one second in (else its first frame), 320 pixels wide: `ffmpeg` runs as a child process (`FFMPEG_PATH`, two at a time, 60 s at most), with the Node server's arguments, and the JPEG is cached in `DATA_PATH/thumbnails` under the Node server's name for it. ffmpeg only reads the clip; nothing is written next to the footage. Without ffmpeg: "No thumbnail" (404), as on Node. |
| Job queue | `src/jobs.rs` | One queue with priorities: scans first, then codec reads, then the speed index. The number of threads comes from the machine (two to four). A job that is already waiting is not queued twice. |
| Media | `src/media.rs` | `/api/media` with Range support, at most 1 MiB per answer, and the same ETag as the Node server. Files are opened with `O_NOFOLLOW` and checked through `/proc/self/fd` to be inside a vehicle folder. Static UI files are served as they are. |

Routes answered, field for field as `server/index.js` answers them:

- `GET /api/vehicles`. The footage parts are the same: id, name, source, root, studioRoot, inventory totals, scanning, bin counts, default policy, savings. `share`, `storage`, `car` and `carModels` are placeholders for now.
- `GET /api/vehicles/:id/days` with `category`, `date`, `from`, `to`, `offset` and `limit`. It includes the speed-index progress per day (`speedIndex`). `archive`, `carFiles` and `sentryUsb` are always empty, and `canRecordings` is always 0.
- `GET /api/vehicles/:id/recordings` with the same filters plus `protected`.
- `GET /api/vehicles/:id/recordings/:rid`: files with sizes and codecs, plus the `event.json` fields.
- `GET /api/vehicles/:id/recordings/:rid/thumbnail`: Tesla's `thumb.png`, else one made from the front clip with ffmpeg.
- `GET /api/vehicles/:id/speeds?date=` and `GET /api/speeds/status`.
- `POST /api/vehicles/:id/scan`. It needs the `X-Requested-With: sentry-six-manager` header, as on the Node server.
- `GET|HEAD /api/media?path=`.
- `/healthz` and the static pages: `/`, `/login`, `/web/…`, `/studio/…`, `/shared/…` and `/assets/…`.
- `GET /api/auth/me` returns a fixed local admin. There are no accounts yet (see below).

## How it is checked

- `cargo test --release` in `lean/` runs unit tests, `tests/mp4_parity.rs` and `tests/slug_parity.rs`.
  - `mp4_parity.rs` runs `parity/mp4Fixtures.js`, which makes 49 MP4 fixtures. Some are real ffmpeg encodes: Tesla-like H.264 with telemetry, the same clip converted to H.265 and to AV1 the way the converter does it, and plain encodes. Others are synthetic, built with `test/fixtures/fixtureBuilders.js`: NAL length sizes 1, 2 and 4, co64, extended boxes, several chunks, an audio track, ctts, a record placed after the first 4 KB, odd protobufs, a dozen broken files, and twelve made for the speed index's fallback (real and synthetic clips with more than 64 top-level boxes, an edit list, one cut short). The script stores what the Node code gets from each file: `videoCodec`, `readSamples`, `readSpeeds`, `summarize`, the `mp4.js` sample index with timescale, duration and keyframes, every record `telemetry.js` `readRecords` lists with its time, and what the speed index itself (`createSpeedIndex`, its full read in a worker as on the server) keeps for the clip. The Rust output must match all of it exactly, including which files fail. It does: 49 fixtures, 7 readers, no differences. On 30 fixtures the quick read gives up and the fallback runs; on 11 of them it finds speeds.
  - `slug_parity.rs` runs `server/vehicles.js` (`normalizeVehicle`, `slug`) on 32 names (accents, ligatures, full-width and Roman-numeral letters, Greek final sigma, Turkish İ, other scripts, emoji, JavaScript's white space, cuts at 40 and 60) and compares the name and id with the Rust ones. They match.
- `node lean/parity/compare.js [--archive dir]` starts the Node server and the lean server on the same archive (`parity/makeArchive.js`: edge cases, real clips, left-out files, tied recordings, clips for the speed fallback and for thumbnails) and waits until both have finished scanning, reading codecs and indexing speeds. It then compares the answers of the routes above: 13 days queries, 8 recordings queries, every recording's details, the 404s, speeds per day, `/api/media` with 15 range and refusal cases including the bytes, and every recording's thumbnail including the JPEG bytes made from clips. It checks the tie order strictly against Node's own scan (below), runs a second pair of servers without ffmpeg and compares their thumbnails, and checks that no file or folder of the footage changed (size, times, inode; Node's own `.sentrymanager/` checksum record left out, Node writes it). Result: 133 requests, no differences; the footage unchanged. On the 4,000-file archive (`makeArchive.js dir --many 4000`): 502 requests, no differences. (One run of three there differed in `/api/speeds/status` `limit`: Node's speed index raises its pace to 2 when the server keeps up for a while, which depends on timing; lean reports 1.)
- `test/leanParity.test.js` runs `compare.js` under `npm test` when the lean binary is built. Otherwise it is skipped.

### Ties

Two recordings that start at the same time are listed in the order the scan saw their files (`buildRecordings` keeps insertion order, then sorts by start), and an event is shown by its first front clip seen (the first clip seen when it has no front one). Node lists each folder sorted by name (libuv's scandir sorts with `strcmp`), queues one folder read and one stat per entry in that order, and keeps each file when its stat answers: a breadth-first walk in which a folder's own files come before those of its subfolders, and files kept from the last scan come the moment their folder is listed. Its stats run in parallel, so now and then an answer comes early and the order changes from one scan to the next: on the parity archive, 25 scans in a row gave 2 to 4 different orders, the usual one 15 to 24 times. `src/scanner.rs` (`node_order`) gives that usual order, always.

`compare.js` checks it strictly: it runs Node's `scanFootage` and `buildRecordings` 40 times and the lean order must equal the one Node gives most often. In the comparison of the two servers' answers, where the Node server's own scan happened to come out another way, it lets another order through only between genuinely tied items (the same recordings at the same places, a recording shown by another of its own tied clips of the same kind, a day's picture from another recording with the same start and kind), and counts them.
- `node lean/parity/measure.js [N]` measures memory and readiness for both servers.

## Measured

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
FOOTAGE_PATH=/path/to/footage VEHICLE_NAME="My car" TZ=Europe/Berlin \
  DATA_PATH=/tmp/lean-data APP_ROOT=$PWD/.. PORT=9000 target/release/sentry-lean
```

It uses the Node server's environment names: `PORT`, `HOST`, `DATA_PATH`, `APP_ROOT`, `FOOTAGE_PATH`, `VEHICLE_NAME`, `TZ` and `FFMPEG_PATH`. It has one vehicle, created from `FOOTAGE_PATH`.

There is no sign-in yet, so the server listens only on loopback. It refuses any other `HOST` (exit code 2) unless `LEAN_NO_AUTH_ANYWHERE=1` is set, which is only for a trusted test network. When accounts arrive they arrive with HTTPS: passwords never go over plain HTTP.

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

The binary in it is 3.9 MB (static). ffmpeg and its libraries are most of the full image.

Inside the container `HOST` is `127.0.0.1`: the container's own loopback, which nothing outside it can reach. To try it on one machine, share the host's network; it then listens on the host's loopback only:

```sh
docker run --rm --network host -e PORT=9000 -e VEHICLE_NAME="My car" -e TZ=Europe/Berlin \
  -v /path/to/footage:/footage:ro -v sentry-lean-data:/data sentry-lean
curl http://127.0.0.1:9000/healthz
```

(On a trusted test machine, `-e HOST=0.0.0.0 -e LEAN_NO_AUTH_ANYWHERE=1 -p 127.0.0.1:9000:9000` also works: published on the host's loopback only, but reachable from other containers on the same Docker network.) Always mount the footage read-only (`:ro`). A bind-mounted data folder must be writable by user 1000.

Checked on this image: it builds; with an archive mounted `:ro` and `--network host`, `/healthz`, `/api/vehicles`, days, recordings, details, speeds (the fallback clips included), `/api/media` ranges, `POST …/scan`, the UI, thumbnails (Tesla's, made with ffmpeg into `/data/thumbnails`, the 500 of a clip under a second) answer; the health check reports healthy; a write to `/footage` fails (read-only); the port is not reachable from the Docker bridge address; `HOST=0.0.0.0` without `LEAN_NO_AUTH_ANYWHERE=1` exits with code 2; the slim image answers "No thumbnail".

## What is missing (the rest of the plan, in order)

1. **Viewer data.** Not done yet:
   - the dashboard's telemetry route (`/api/telemetry`). The reader is done (`src/telemetry.rs`, the speed index's fallback uses it); the route, its cache in `DATA_PATH/telemetry` and its sweep are not;
   - moments (`/moments`);
   - scrub previews (`/api/scrub`);
   - thumbnails for the Recycle Bin (`/api/bin/:item/thumbnail`) and Studio's (`/api/studio/thumbnail`, clip-thumbnails);
   - the Studio file API (`/api/studio/*`) and the HTML rewriting the Node server does (versioned links, critical bar, prefetch).
2. **Drives, places and map.** Not done yet: `/driving`, `/event-map`, `/api/places*`, the place tags on recordings, stars and dashboards.
3. **Sentry USB.** Not done yet: the status file (`sentryUsb` in the day list), archive gaps (`archive`) and the car's file list (`carFiles`).
4. **Accounts, sessions and HTTPS.** Not done yet:
   - sign-in, two-step codes, viewer and admin roles, the CSRF and origin checks on every write, host names;
   - TLS on the same port with the plain-HTTP explainer page.
   
   Passwords only go over HTTPS. Until this step is done the lean server stays on loopback.
5. **Notifications, health, cleanup and Recycle Bin.** Not done yet:
   - `/api/notifications*`, `/api/health*`, `/api/jobs`, `/api/events` (SSE), logs and snapshots;
   - policies, protect, trash and restore. These are the first routes that write to footage folders, and they will need the same safeguards as `server/recycleBin.js`;
   - share mounting and health (`share`, `storage`).
6. **Converter.** Last. Encoding with ffmpeg, the H.265 and AV1 telemetry injection, verification and the staging and recovery steps (`src/main/converter/`). This is the largest piece.
7. **CAN logs, helpers and power price.** Not done yet: CAN Bridge uploads and the indexes (`/api/can/*`), worker nodes, power price and savings, UI packs, updates and the reports opt-in.

Smaller differences in this slice:

- Vehicles come from `FOOTAGE_PATH` only. Node's settings store, SMB shares and more than one vehicle are not supported yet.
- `protected` is always false, because the protect list lives in the Node server's database.
- Tied recordings: the lean server always gives the order Node's scan gives most often; Node itself now and then gives another (see Ties).
- A vehicle name cut at 60 UTF-16 units through a character outside the BMP (an emoji, say) keeps half of it on Node; here the character is left out. The id is the same.
- The thumbnail cache is not swept, as on Node (it grows with the clips that get a card).
- A thumbnail of a clip under a second: ffmpeg ends well without a frame and both servers answer 500 "Internal error" (the Node behaviour, kept).
- The stock UI loads, and the footage pages get real data. Its other pages call routes that are not here yet and get "Not found".
