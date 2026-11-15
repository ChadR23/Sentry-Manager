# Full port to Rust: plan and ground rules

The owner's decisions (2026-11-15):

- **Everything on the server moves to Rust**: every route, background job,
  the converter, the supervisor. The browser pages stay as they are (`web/`,
  `src/renderer` Studio pages, `examples/ui-packs`); Rust serves them and
  everything they call, so all six interfaces and uploaded packs keep working.
- **One switch at the end**: the Node server stays the shipped app until the
  Rust one answers every route the same way; then the image switches over and
  Node is removed. No half-and-half proxying.
- **The converter is ported early**, with every safety check it has today.

The Node code is the specification. Where the Rust code answers differently
from Node, Rust is wrong unless the owner says otherwise.

## Size

About 50,000 lines of JavaScript (`server/`, `src/main/`), 189 server routes
(`docs/api-contract.md`, regenerate with `node tools/contract/routes.js`), two
live-update streams, the converter's 22 IPC channels over
`POST /api/converter/invoke/:name`.

## Layout

One crate, `lean/`, binary `sentry-lean`. Each area is a module folder with
its own routes, merged in `src/api.rs`:

| Module | Area (contract groups) | Node source to port |
| --- | --- | --- |
| `core/` | config/env, `manager.db` (same schema as `server/db.js`), settings, accounts, sessions, sign-in throttle, access levels, CSRF header, HTTPS + own CA + ACME, audit + logs, live-update hub (`/api/events`), jobs, router helpers | `server/db.js`, `auth.js`, `accounts.js`, `access.js`, `acme.js`, `http.js`, `log.js`, `activity.js`, index.js glue |
| `supervisor/` | the root supervisor: starts the app as PUID/PGID, mounts SMB shares (mount.cifs), restarts | `server/supervisor.js`, `mounter.js`, `mountSpec.js` |
| `converter/` | converter + encoder + helper servers (nodes) + benchmarks + GPU detection | `src/main/converter/*`, `server/converterHost.js`, `converterBridge.js`, `nodes.js`, `nodeWorker.js`, `gpu.js`, `stats/gpu.js` |
| `footage/` | vehicles, shares, inventory, catalog, Recycle Bin, cleanup policies, protect, stars, integrity, arrival checksums | `server/vehicles*`, `inventory.js`, `catalog.js`, `scanner.js`, `recycleBin.js`, `deletedClips.js`, `integrity.js`, `arrivalChecksums.js` |
| `viewer/` | media ranges, telemetry, speeds, speed index, scrub previews, thumbnails, moments, places, map, drives/driving, event map, archive gaps | `server/media`, `telemetry.js`, `speedReader.js`, `speedIndex.js`, `scrub*.js`, `thumbnails.js`, `driveData.js`, `archiveGap.js`, places |
| `ops/` | notifications + rules, health, stats + history + export, power price + savings, updates, feedback reports, support bundle, snapshots, metrics | `server/health.js`, `stats/*`, `imageUpdates.js`, `reports*.js`, snapshots |
| `can/` | CAN logs, CAN Bridge uploads, device port, Sentry USB link | `server/can*.js`, `canPort.js`, `sentryUsb.js` |
| `ui/` | interface packs (list, upload, install, serve, HTML rewriting: versioned links, prefetch, critical bar), static files, exports | `server/uiPacks.js`, `exporter.js`, the static/HTML parts of index.js |

Areas are written in parallel with `core/`. Until core lands, an area
defines the few things it needs from core as a small trait in its own module
(`<area>/ctx.rs`: e.g. `db()`, `setting(key)`, `announce(topic)`,
`audit(line)`, `user role`) and its handlers take that trait; the coordinator
implements the traits on core's `AppState` when merging. Keep handler logic
in plain functions that are testable without HTTP.

Shared types live in `core/`. An area module only adds files in its own
folder, plus one line in `src/api.rs` (its routes) and its dependencies in
`Cargo.toml`; the coordinator merges those.

## How an area is done

1. Read the Node code for the area completely, including its tests in
   `test/`. Port behaviour, not just shapes: limits, ordering, error texts,
   status codes, audit lines, live-update topics, timing (debounces, retries).
2. Port the area's tests that make sense in Rust (`cargo test`).
3. Same answers: record goldens from the Node server (`tools/contract/record.js`
   against `tools/contract/fixture.js`, or the bench container) and compare
   the Rust server (`tools/contract/compare.js`). Every difference is fixed or
   listed in this file under "Known differences" with the owner's OK.
4. Write down what is not done yet in this file under the area.

## Ground rules (owner's)

- Footage is read-only except where Node writes today (converter replace,
  Recycle Bin, cleanup, restore), and there with the same checks, in the same
  order, tested only on copies.
- Passwords only over HTTPS, never plain HTTP.
- Everything stays in the one container: no extra services.
- The opt-in reports go only to the developers' receiver
  (`https://reports.skittles.live`), only when an admin turns it on or presses
  Send (docs/security.md, docs/reports-api.md).
- No co-author trailers, no model names in code or commits.
- `npm test` keeps passing while Node is still the shipped app.

## Status

| Module | State |
| --- | --- |
| footage list, recordings, media ranges, speeds, MP4/SEI reading | first slice done (see README.md) |
| supervisor | ported, see below and `src/supervisor/README.md` |
| converter | the file-safety and telemetry core ported and tested; job store, job service, IPC and runtime still to do (see below) |
| ops | most of it ported, see below |
| viewer | ported except where it needs CAN, Sentry USB status, notifications or accounts; see below |
| core | ported, see below and `src/core/README.md` |
| `footage/` | ported, with what is left listed below |
| ui (pages, static files, interface packs, exports, settings) | ported, see below |
| everything else | not started |

## Converter

Done (`src/converter/`, library only: nothing is wired into `api.rs` yet,
so no route answers and nothing can touch footage from the lean server):

- `owned.rs` (server/posixOwnedFs.js, native/noreplace-rename.c): remove,
  promote, linkBackup, replaceOver. Device, inode, size and a SHA-256 taken
  with the file held open and unchanged while hashed (or identity and mtime
  for content just proven), removal through a quarantine name with the inode
  checked again there, a guard file held open, renameat2(RENAME_NOREPLACE)
  called directly (link + unlink fallback where it is unsupported).
- `mp4w.rs` (mp4.js, whole-file tree and chunk-offset rewrite), `tesla_sei.rs`,
  `timeline.rs` (telemetryTimeline.js), `lead_in.rs`, `frame_num.rs`
  (frameNumGaps.js), `h265.rs`, `av1.rs` (inject and inspect), `adapters.rs`
  (outputTiming, the in-place telemetry writer with its identity checks).
- `verifier.rs` (verifier.js): every check in Node's order, same reasons and
  details; `snapshot.rs` (verificationSnapshot.js and the runtime's snapshot
  registry: structural ownership, consume-once, reconcile).
- `staging/` (staging.js): stageSource, reserve/adoptEncodeOutput, copyAsset,
  publishSeparate, prepare/commitPublication, prepare/swapReplacement,
  replaceOriginal, rollbackReplacement, recoverReplacement (all actions),
  recoverCopy, cleanupOwnedArtifacts, the journal snapshots (same JSON as
  Node's), classifyPath / checkStagingSpace / chooseStagingMode.
  Ported for the server's configuration only (posix adapters, private temp
  cleanup by identity, replace by link); the desktop branches are left out.
- `recovery.rs` (jobStore.js REPLACEMENT_TRUTH_TABLES / replacementAction and
  runtime.js createRecoveryInspector), `planner.rs` (encoderPlanner.js),
  `process.rs` (the bounded runner: timeout, output cap, cancel, SIGTERM,
  CUDA_DEVICE_ORDER), `contracts.rs` (profiles, size rules, verify modes,
  device ids).

Tests (`cargo test`): test/posixOwnedFs, ownedCleanup, stagingSplit,
verifierRepeatedMessage, leadIn (encode arguments) and frameNumGaps (the
rule) ported; a crash-point test kills a replacement before each of its
journal records (a panic, so no rollback runs) and recovers as jobService
does, asserting the original's name always holds the original or the
verified conversion and nothing unproven is removed. Parity with Node
(`src/converter/testdata/*.js`, needs node + ffmpeg; set
`LEAN_CONVERTER_FIXTURES=<dir>` to reuse fixtures): timelines of 7
Tesla-like originals (keyframe first, lead-in, frame_num gaps, unknown gap,
no keyframe), the H.265 and AV1 writer outputs byte-identical (12 files),
inspections identical, 168 verifier verdicts identical (good, raw,
truncated, tampered; Quick and Full; with and without a size profile), and
buildEncodeArgs / decodeAccelArgs over every encoder and option.

Not done yet, in order:

1. jobStore.js (manifest files, journal, validation, transitions) and the
   manifest folding of transaction snapshots; reading jobs Node wrote.
2. jobService.js (the pipeline: discover, stage, encode with progress
   parsing, telemetry, verify, size retry, save slot, recovery loop,
   pause/cancel, lanes), runtime.js composition (volume info, device list,
   lifecycle), scanner.js, convertedIndex.js, mp4Header.js, pictureCheck.js.
3. ipc.js (22 channels) behind `POST /api/converter/invoke/:name` and the
   `/api/converter/events` SSE (converterBridge.js: verify never Off, the
   path guard), converterHost.js.
4. autoConvert.js, benchmark.js, encodeDevices.js, server/gpu.js,
   stats/gpu.js, encoderStats.js, convertStats.js.
5. Helper servers: server/nodes.js, nodeWorker.js, `/node/v1/*`, pinning,
   tokens.
6. The Node crash suites (test/converterCrash*, replaceCrash, crashPoints)
   need the job service; port them with it.

Proposed differences (need the owner's OK): a nested box literally named
`root` is serialized as a box (Node's writer would treat it as the tree
root); io error texts are Rust's where Node logs its own.

## Supervisor

Done (`src/supervisor/`, binary `sentry-lean-supervisor`): supervisor.js
(folders and their owners, setpriv launch as PUID:PGID with GPU groups, the
app's environment, restart 5 s after a crash, SIGTERM/SIGINT forwarding and
exit code, `shutdown` without CAP_KILL, log forwarding with the early
buffer, RAPL readings, TLS export modes, `tls-hostnames`, ACME token
relaying, a `healthcheck` subcommand for Docker), mounter.js (local
mounter, per-vehicle queue, IPC mounter), mountSpec.js (same accepted and
refused input, same option string and credentials file), proc.js. The IPC
channel is JSON lines over a socketpair on fd 3 (`SENTRY_SUPERVISOR_FD`),
as Node's was; the messages are in `src/supervisor/README.md`.

Not done yet:

- (done by core: `supervisor::ctx::Tls` is `core::supervised::SupervisorTls`,
  passed in `bin.rs`; the app takes fd 3 and `core::supervised::attach`
  handles disconnect/`shutdown`, `supervisor-log`, `rapl-reading` (hook for
  ops), `tls-updated`, the ACME tokens and `tls-hostnames`)
- footage uses `IpcMounter` (`state.supervisor` holds the link);
- lean/Dockerfile: run as root with the supervisor as CMD under tini, with
  setpriv, cifs-utils and tini installed.

Proposed difference (needs the owner's OK): file system error texts that are
only logged ("mount car: ...") read like Rust's, not Node's.

## Ops

Done (`src/ops/`, handlers over the `ops::ctx::OpsCtx` trait; routes in
`ops/routes.rs`, wired in `api.rs` before the slice's own routes, started
from `main.rs`; until core lands `ops/lean.rs` implements the trait on
`App` with its own connection to `DATA_PATH/manager.db`, same schema):

- notifications: db.js notify/resolve/resolveId/markRead/list (an unchanged
  repeat changes nothing and announces nothing), activity.js Notifications
  (muted kinds, share, read-only and space alerts with the 10-minute
  grace), the rules, all 5 routes. Node has no outbound channels (no e-mail
  or webhooks), so there are none here;
- health.js checks (same order, key order and texts), one run at a time,
  the banner, the startup self-check a minute after the start with its
  notifications and log line;
- snapshots.js (VACUUM INTO, 7 kept, restore at the next start through
  `snapshots::apply_pending_restore`, which core must call before it opens
  manager.db; ops/lean.rs does);
- powerPrice.js and savings.js exactly (local time, overnight rates,
  backfill, by month), PUT /api/settings/power, savings-by-month;
- buildInfo.js, hostInfo.js, imageUpdates.js (registry token, multi-arch
  index, build numbers, sticky critical levels, the 12 h / 10 min checks,
  notifications);
- metrics: settings, enable, disable and `/metrics` with its token;
- reports: reportsConfig, reportsScrub, reportsProtocol (seal and open,
  sign, proof of work, schema, moved notices), reports.js (opt-in, outbox
  caps, backoff, 429/POW/TIME, the per-hour manual limit, crashes, daily,
  heartbeat and normalizeHeartbeat, install and anonymous keys kept in
  Node's PKCS#8 form). Only `https://reports.skittles.live` (or an https://
  REPORTS_URL; http only to localhost under NODE_ENV=test);
- /api/system, /api/support-bundle (zip, same scrubbing), /api/updates;
- stats: history.js exactly (the same stats-history.json; its energy,
  traffic and shares parts are kept as they are), the CSV, CPU, memory,
  host and network rates; every part of the answer in Node's shape.

Tests: `cargo test` (94 unit tests, including ports of notifyUnchanged,
powerPrice, savings, savingsByMonth, snapshots, imageUpdates, hostInfo,
healthGpu, reportsScrub, reportsProtocol, reportsClient and statsHistory)
and `tests/reports_parity.rs`: the scrubber, the payload schema and the
heartbeat against the Node code on a corpus, and the Rust client against
the local fake receiver (test/fixtures/reportsReceiver.js through
`parity/reports.js`): reports sent, opened and validated by the Node
protocol code, trust new/verified/anon, heartbeat, crash, a raised
difficulty, 429, a signed and a forged move. Nothing goes anywhere but
127.0.0.1.

Same answers: `node lean/parity/opsCompare.js` records goldens of the ops
GET routes from the Node fixture and replays them against the lean server on
a copy of its data folder: 10 of 15 the same. The rest belongs to other
areas or to the machine: the encoder check and the `/api/system` converter
(converter area), `security.https` (core's TLS), and the disk's free space,
which changed between the two runs (it is in notification titles and the
banner, which the spec does not normalise).

Not done yet:

- stats: GPUs (gpu.js, nvidia-smi), power and RAPL (power.js; the
  supervisor's `rapl-reading` must reach `Stats` once core wires the link),
  energy and costs (energy.js), data used per day (traffic.js), disks, file
  systems and share answer times, sensors, the process table and the app's
  CPU, alerts, unlock hints, node power (nodePower.js), the encoder block
  (converter area, `OpsCtx::encoder_block`), the `tick()` housekeeping;
- savings.record from the converter's job snapshots (converter calls
  `power::record`) and the backfill at start;
- the real diagnostics, heartbeat numbers and identifiers (index.js
  reportDiagnostics, reportHeartbeat, reportIdentifiers) need the other
  areas through `OpsCtx`; ops/lean.rs gives a small version;
- crash notes from 500s (`Reports::note_crash`) need core's error path;
- the live-update hub (`announce`), the audit log, log search and sign-in
  are core's; on the stand-alone server they print to stderr, and the 🔑
  routes always ask for the password (no accounts yet);
- the share status (warning, read-only) comes from footage/shares;
  ops/lean.rs works out a local folder's.
## Viewer

Done (`src/viewer/`, handlers on the small `viewer::ctx::Ctx` trait;
`viewer/glue.rs` implements it on today's `App`):

- `/api/telemetry` (cache `DATA/telemetry/<sha1 "t2|path|size|mtime">.json`,
  ETag, 304, gzip, `telemetryReads` at once; the reader is `src/telemetry.rs`),
  `/api/scrub` (scrubFrames.js + scrubKeyframes.js: keyframes only for a clip
  with one every 1.1 s, else every frame; ffmpeg at nice 10, 60 s timeout;
  cache `DATA/scrub`, 6,000 kept, next clip prepared, scrubPrepare.js after
  every scan, `SCRUB_PREPARE_DAYS`);
- the speed index (speedIndex.js) in Node's own day files
  `DATA/speeds/<vid>/<day>.json`: passes newest day first, a queue per day,
  straight/short read modes measured, the full read as fallback, folder
  moves kept, older summaries upgraded in place, summaries, moments, near()
  with the Float32 packed cache, warm(), clipStats, clipsRead, progress,
  clip(); `/api/vehicles/:id/speeds`, `/moments`, `/driving`,
  `/api/speeds/status`, `POST /api/speeds/index`, `POST /api/telemetry/speeds`;
- backgroundPace.js (lag from a 20 ms sleeper thread instead of the event
  loop; `/api/media` holds the Viewer slot while it answers) and
  workLimits.js with `GET/PUT /api/settings/work-limits`;
- places.js and the places routes (`/api/places` CRUD, `/near`,
  `/suggestions`), event spots, `/api/vehicles/:id/event-map`, the place
  tags on recordings (recordingPlace.js, cameras' GPS and event.json);
- drives.js and driveData.js (streaming tokenizer, reduce, grouping, Park
  splits, Autopilot shares, tags, cache `DATA/drive-data/<vid>.json`),
  `/api/vehicles/:id/drives`;
- archiveGap.js analyze for cut-off drives, partial minutes, late clips and a
  quiet share, its `archive-gap:<vid>` state and notification keys,
  `/api/vehicles/:id/archive-gaps`;
- Studio: `/api/studio/context`, `settings` (GET/POST), `readDir`,
  `readFile`, `exists`, `stat`, `thumbnail` (clipThumbnails.js filmstrips,
  `DATA/clip-thumbnails`), `browse`, through a port of safePath.js
  createRealGuard (deny list included).

Checked: 52 viewer unit tests (ports of test/backgroundPace, workLimits,
speedIndex, telemetrySpeeds, scrubKeyframes, scrubFrames, driveData, drives,
places, recordingPlace, archiveGap). Against goldens recorded from
`tools/contract/fixture.js`: every viewer route answers the same except
`/api/speeds/status` `readMode` (which read mode measured faster on that
run). `lean/parity/compare.js` now also covers the viewer routes and a saved
place: 217 requests the same. The caches the two servers write
(speeds, telemetry, scrub grids) are byte for byte the same, and each reads
the other's.

Not done yet:

- CAN Bridge evidence everywhere it is used: recording place tags and drive
  ends from CAN GPS, `can` on drives, archive gaps' CAN driving/Sentry and
  time zone shifts (needs the CAN index);
- Sentry USB in archive gaps (status file, snapshots, car-files.tsv: carFilesPass,
  `carFiles` in the answer and the day cards' `archive`/`carFiles`);
- archive-gap notifications are only raised once `Ctx::raise_note` is
  implemented (ops); `forDays` for the day cards is not wired;
- arrival times: the lean scan keeps no birth time, so archive gaps use the
  change time (Node prefers the birth time);
- time zones other than UTC and the server's own `TZ` (driving's "this
  week", archive gaps' wall clock) need a zone table (core);
- `POST /api/studio/trashFolder` (Recycle Bin, footage area);
- admin-only routes call `Ctx::refuse_admin`, which core implements; the
  audit line names "local" until accounts exist; `announce` has no hub yet;
- the coordinator keeps one speed index: `app.rs` skips its SQLite index
  while the viewer runs, and the old `/api/speeds*` code in `api.rs` is
  shadowed by the viewer's routes.
## Footage (`src/footage/`)

What it needs from core is `footage/ctx.rs` (`Ctx`: the manager database,
announce, audit, logs, jobs, the converter's clips in hand, the supervisor's
`Mounter`, and hooks for the CAN, savings, notifications and Sentry USB
areas; `Caller` for who asks). `LocalCore` stands in until core lands: it
opens `DATA_PATH/manager.db` with server/db.js's tables (settings,
protected, bin_items, jobs). Routes: `footage/routes.rs` `handle`, called
from `api.rs` (`footage_routes`); access checks (admin, viewer, CSRF origin)
are core's, `Caller::require_confirmed` is the 🔑.

Moved here, unchanged at first (later commits edit them in place):
`src/footage.rs` -> `footage/names.rs` (re-exported as `crate::footage::*`),
`src/catalog.rs`, `src/inventory.rs`, `src/scanner.rs` -> `footage/`
(re-exported from `lib.rs` as `crate::catalog`, `crate::inventory`,
`crate::scanner`). `app::Vehicle` is `footage::vehicles::Vehicle` now and
`App.vehicles` the vehicle manager.

| File | Node | State |
| --- | --- | --- |
| `vehicles.rs` | vehicles.js | done: several vehicles in the `vehicles` setting, folder and SMB sources, checkFolder / overlap / protected folders, ids, add / update / remove, publicView, studioRoot, bootstrap from FOOTAGE_PATH / SMB_SHARE |
| `smb.rs` | mountSpec.js (parseShare, normalizeSmb, securitySummary) | done; mountArgs and the credentials file are the supervisor's |
| `share.rs` | share.js | done: health every 30 s, the write check step by step, read-only mounts (mount table or EROFS) never written, remount after two failures, backoff, status and health events; the mount goes through `ctx::Mounter` |
| `routes.rs` test-smb | smbTest.js | done (rate limit, one at a time); needs the supervisor's mounter to connect |
| `cars.rs` | web/carModels.js normalizeCar, choices, resolveCar without CAN | done; the VIN from CAN logs is the CAN area's (`Ctx::car_summary`) |
| `scanner.rs`, `catalog.rs`, `inventory.rs` | scanner.js, catalog.js, inventory.js | done: light rescans (every sixth full, every SCAN_INTERVAL_MINUTES), the first scan resumed from the catalog's last finished scan of the same folder (`scans` row: root, totals), birth times, protected, rebuild after moves (the catalog follows), arrivedClips, totals, days, footageDays, codecs |
| `bin.rs` | recycleBin.js | done: trash (pending record first, protection read again under the lock, clips in hand refused, put back on failure, empty folders removed), reconcile (settle pending, adopt unlisted), restore (conflicts stay), delete forever, empty, thumbnail source |
| `safe_fs.rs` | safeFs.js | done: O_NOFOLLOW walk from the real root, *at calls on the pinned folder |
| `deleted_clips.rs` | deletedClips.js | done |
| `policies.rs` | policies.js | done: normalize, ruleKey, preview (keepDays, maxGB), run with `expect`, empty after N days, the minute tick |
| `stars.rs` | index.js /api/stars | done |
| `integrity.rs` | integrity.js | done (results in `DATA_PATH/integrity`, resumed after a restart) |
| `tz.rs` | Intl time zones | IANA names (any case) and offsets, chrono-tz |

Checked: `cargo test` (unit tests in each file and `tests/footage.rs` on
generated archives); `node lean/parity/compareFootage.js` (97 writing
requests to Node and lean, each on its own copy of the archive: no
differences); `node lean/parity/contractFootage.js` against goldens from
`tools/contract/fixture.js` + `record.js` (30 of 30 the same);
`node lean/parity/compare.js` still 133 of 133.

Left to do:

- `arrivalChecksums.js`: not ported. It writes the Sentry USB checksum record
  through `originalChecksums.js` (the converter's) and asks `sentryUsb.holds`
  (the Sentry USB area); port it with those, on `inventory` file entries
  (`birthtime_ms`, `arrived_clips` are there).
- `archiveGap.js`: the viewer area's per the table above (the day list's
  `archive` and `carFiles`); `deleted_clips::list` is what it reads from here.
- The catalog stays in `lean-catalog.sqlite` with its own tables, not Node's
  `catalog_files` / `clip_codecs` / `catalog_dirs` / `catalog_scans` in
  manager.db: after the switch the first scan is a full one (and codecs are
  read once more). Port the Node tables if that matters.
- Core wiring: `Caller` from the session (now always the local admin, its
  password counted as given), jobs into core's job list, `announce` onto
  `/api/events`, audit into the audit log, the CAN hooks (`can_with`,
  `can_delete_with`, `on_deleted` -> canPrune, the car-model change kicking
  the CAN index), savings (`saved`, `reset_saved`), notifications
  (`share_status` -> syncShare), `vehicle_removed` (savings, archive gaps,
  Sentry USB, drive data, nodes).
- Share mounts go through the supervisor's `Mounter` (`ctx::SupervisorMounter`
  wraps `supervisor::mounter::Mounter`): main.rs gives the `LocalMounter`, as
  index.js does without the supervisor; when core wires the supervisor link it
  passes `IpcMounter` the same way (`LocalCore::set_mounter`).
- Stars are sorted by clip with byte order; Node uses `localeCompare`
  (ICU). The same for clip keys (YYYY-MM-DD_HH-MM-SS), which is all a star
  can hold.
## ui

Done (`src/ui/`, what it needs from core in `src/ui/ctx.rs`, implemented for
today's lean server by `src/ui/local.rs`):

- static files as `server/http.js` serves them (`ui/http.rs`): the same MIME
  types, weak ETag from size and time, 304, brotli (quality 5) or gzip for
  text over 1 KB from a cached copy (48 MB), transformed pages never kept,
  versioned scripts kept per version; `sendText`; `sendJson` (gzip over 1 KB);
- index.js's page side (`ui/mod.rs`): the security headers and the three CSPs
  on every answer, `/healthz`, `/original` and its cookie, the two-step and
  sign-in redirects (through the ctx), `/v/<version>/…` and `/v/assets/…`
  with the year-long cache only for the current version, the asset version
  (sha256 of build sha or start time and the interface), versioned links in
  every page, versioned imports in versioned scripts, the critical-update bar
  (never on the sign-in pages, never a pack's own `critical.js`), the Studio
  and Encoder shims (the skeleton CSS inline), the early-data hint
  (`prefetch.js`: learning per session for 2 s, hints kept in the `prefetch`
  setting), `/studio` and `?embed=encoder` redirects, the Studio
  translations (`ui/translations.rs`: the literal file is evaluated without
  a JS engine), the chosen pack's file first, else the built-in one;
- `server/uiPacks.js` (`ui/packs.rs`) and `server/zip.js` reading and
  writing (`ui/zip.rs`, Zip64 read and written where needed); the routes
  `GET /api/ui-packs`, `PUT /api/ui-packs/active` (password confirmation,
  `interface` topic, audit, the /original cookie cleared),
  `DELETE /api/ui-packs/:id`, `GET /api/ui-packs/original.zip`,
  `POST /api/ui-packs/upload` (405, confirmation, 413, X-File-Name);
- `server/exporter.js` (`ui/exporter.rs`): checks, layout, ASS overlay,
  ffmpeg arguments, GPU encoder probe with CPU fallback, one at a time with
  a queue, cancel, tidy every hour, jobs through the ctx; the routes
  `POST /api/vehicles/:id/exports`, `POST /api/exports`, `GET /api/exports`,
  `GET|DELETE /api/exports/:id`, `GET /api/exports/:id/file`;
- settings (`ui/settings.rs`): `GET /api/settings`,
  `PUT /api/settings/appearance`, `GET|PUT /api/dashboards` (cleanBoards,
  upgradeBoards rev 2), `GET|PUT /api/settings/work-limits` (workLimits.js,
  cgroup v1/v2).

Checked: `cargo test` (zip, packs, exporter, settings and dashboards, work
limits, translations, HTML rewriting, JS conversions);
`node lean/parity/uiCompare.js` (Node fixture over HTTPS against lean: every
file in every interface plain, versioned, br, gzip, HEAD and 304, the
security headers, all the routes above including an upload, a real export
and a privacy export, the early-data hint: 2871 of 2871 answers the same);
`node lean/parity/contractUi.js` (record.js goldens for these routes,
replayed: 17 of 17); `node lean/parity/uiPages.js` (Chromium, Original and
the five packs, main page, Settings, Viewer, Encoder, sign-in page: 30 of
30 load the same, no file or script error only on lean).

Not done yet:

- core implements `ui::ctx::UiCtx` on its AppState (settings in manager.db,
  sessions, `recentlyConfirmed`, `isSecure`, clientKey, two-step state, the
  jobs list, the `/api/events` hub for `interface`, audit and logs, the
  vehicle guard for exports, the speed index, `viewerCarData` with the CAN
  area) and replaces `LocalCtx`; core also takes over `sendJson` for every
  JSON answer (gzip over 1 KB: `ui::http::send_json`), the Host check (421),
  the CSRF and origin checks and the viewer/home-only checks before the
  ui's routes (the ui checks X-Requested-With and Origin again itself);
- `streamZip` (the CAN bundles' streamed zip) is the CAN area's;
- `GET /api/settings` shows the power price; its PUT is the power-price area's;
- original.zip is deflated by flate2 (miniz), not zlib: the files are the
  same, the bytes of the archive differ (the contract ignores its body);
- the uploaded pack is written at upload time, so its files' ETags differ
  between servers (as between any two Node servers).

Node quirks kept as they are: a board without an id gets the id
"undefined"; the hourly exports tidy can remove the work folder of an
export that is rendering (its folder name is not an export id).

## Known differences

None accepted yet. Proposed (needs the owner's OK): `/api/speeds/status`
`readMode` follows this server's own timing, as Node's does.
## Core

Done (`src/core/`, see its README for how an area plugs in): config/env
(every variable Node reads, DATA layout); `manager.db` with db.js's schema,
migrations and queries and catalog.js's tables (opened in place of Node's:
users, sessions, settings, jobs, bin items, notifications, stars carry over
both ways; a Node password hash verifies, checked against auth.js);
accounts, sessions and both cookie names, setup code, sign-in throttle and
the two-at-once limiter, the confirm window, roles and `viewerMay`, TOTP
and recovery codes, pending sign-ins; access.js bans and rules;
clientAddress.js with TRUST_PROXY/TRUSTED_PROXIES; the CSRF header and
same-origin check; HTTPS with the app's own CA (same openssl commands and
files: Node's CA and certificate are reused unchanged), own certificate,
Let's Encrypt (acme.js, checked end to end against test/fixtures/fakeAcme.js),
one port for HTTPS (HTTP/2 + 1.1) and the plain-HTTP redirect (only /healthz
and the ACME check answer), the device port skeleton (only while `can.enabled`,
6 per address, 256 in all, 15 s to the first bytes); the live-update hub;
jobs, notifications; the app and audit logs (line format, file, rotation,
archive, search); the router (Node's matching), error shape, gzip, security
headers, the request handler's checks in Node's order (also WHATWG path
normalisation); the routes of "Accounts, sessions and access", "HTTPS
certificates", "Live updates" (`/api/events`), "Activity (jobs)" and the
logs routes; the supervisor's TLS and the app side of its link.

Same answers: Node fixture (`tools/contract/fixture.js`) vs the lean server
on a copy of its footage: `record.js`/`compare.js` for core's routes, GETs
and 23 allow-listed refusals and checks (POST/PUT/PATCH/DELETE): 38 of 38
answers the same. A further 50 edge requests (no session, missing header,
cross-site, HEAD, bad params, bad JSON, `/api/events`, plain-HTTP redirect,
bad host and paths, sign-in redirects, `/original`, throttling) compared
directly: the same except the items below. `lean/parity/compare.js` (footage
routes) passes with lean signing in like Node: 133 requests the same.

Not done yet:

- `POST /api/auth/login` and friends run scrypt on a blocking thread; Node's
  2-minute idle timeout on HTTPS connections is approximated by hyper's
  header-read timeout only.
- supervised `set_hostnames` blocks a blocking thread while waiting for the
  supervisor (up to 120 s).
- `/api/system`, `/api/support-bundle`, `/metrics` content and the other
  Health routes are ops'; `/api/converter/events` is the converter's;
  `/api/studio/context` in main.rs is a stand-in for the contract tools'
  discovery until the ui area has it.
- web/prefetch.js learning (noteStartCall) is a hook for ui.

## Known differences

None accepted yet. Proposed (need the owner's OK):

- core: a JSON body over 1 MB gets `413 {"error":"Request body too large"}`;
  Node destroys the connection (the client sees "socket hang up").
- static files from the first slice (`api::web`) lack `Vary: Accept-Encoding`
  (ui area).
