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
from Node, Rust is wrong unless the owner says otherwise. Since Node was
removed (below, "Node removed"), its frozen answers are that specification.

The sections below were written while Node was in the repository: the
`server/`, `src/main/`, `test/` and `lean/parity/*.js` they name are in the
git history (before the commit that removed them).

## Size

About 50,000 lines of JavaScript (`server/`, `src/main/`), 196 server routes
(`docs/api-contract.md`, regenerate with `node tools/contract/routes.js`), two
live-update streams, the converter's 22 IPC channels over
`POST /api/converter/invoke/:name`.

## Layout

One crate, `lean/`, binary `sentry-lean`. Each area is a module folder with
its own routes, all put into core's router by `src/wire/`:

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
folder, plus its dependencies in `Cargo.toml`; the coordinator wires it in
`src/wire/` (its context on core's state, its routes in `wire/routes.rs`).

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
- `cargo test --release --locked` in lean/ passes before every push (it was
  `npm test` while Node was in the repository).

## Node removed (2026-11-19)

The owner's decision: record Node's answers as fixed reference files, then
delete Node. Removed: `server/` (its CAN signal sets moved to `dbc/`, read
from `<APP_ROOT>/dbc`, `/app/dbc` in the image), `src/main/` (the Node
converter), `test/` (the Node tests), `native/`, `Dockerfile.node`,
`package.json`, `lean/parity/*.js`, the generators in
`src/converter/testdata/*.js`, `tools/contract/{fixture,routes,lexjs}.js`,
`tools/inventoryMemory.js`, `tools/bench/clipMemory.js`. Nothing of the
image, the pages or the Rust server loaded any of it.

How the references were frozen: each check that ran Node code was run once
against the Node code still in the repository (`LEAN_RECORD_NODE=1`, one
test thread), with the Rust side compared at the same time (all the same),
and Node's answers were stored under `lean/tests/fixtures/node-reference/`
(5.8 MB in all with the contract's):

| Reference | From | Checked by |
| --- | --- | --- |
| `archive-gap.json.gz` | every `server/archiveGap.js` analyze() call of Node's own tests | `tests/archive_gap_parity.rs` |
| `arrival-phase1/2.tar.xz`, `arrival-records.tar.xz` | the share, Node's index and record after each pass of `server/arrivalChecksums.js` (and the files' inodes then; this run's inodes are put into Node's index) | `tests/arrival_parity.rs` |
| `can-index.tar.xz` | the CAN Bridge logs, `server/canIndex.js`'s index files and answers | `tests/can_parity.rs` |
| `mp4.tar.xz` | 49 MP4 fixtures and what the Node readers got from each | `tests/mp4_parity.rs` |
| `slug.json`, `reports-{scrub,validate,heartbeat}.json` | `server/vehicles.js`, `reportsScrub.js`, `reportsProtocol.js`, `reports.js` | `tests/slug_parity.rs`, `tests/reports_parity.rs` |
| `converter-telemetry.tar.xz` | the telemetry and verifier fixtures (encodes, Node's writer output, inspections, verdicts) | `src/converter/tests.rs` |
| `converter-scan.json` | `src/main/converter/scanner.js` on six configs (files with fixed times; this run's inodes put in) | `scanner.rs` |
| `converter-bridge.json` | every channel request of the corpus, `server/converterBridge.js`'s answers | `ipc.rs` |
| `converter-{auto,bench,devices}.json` | automatic conversion, the benchmark, the device list | `parity_tests.rs` |
| `converter-store.json.gz` | the job store: each command with digests of the folders it was given, Node's answer and the folders as it left them | `jobstore/tests.rs` |
| `planner-args.json` | buildEncodeArgs / decodeAccelArgs, with the script that asked | `planner.rs` |
| `converter-jobs.json`, `job-clip.mp4` | three real conversions by `src/main/converter/runtime.js` (the job's shape, events, outputs' codec and digest, the ffmpeg build and the ffmpeg runs it asked for, base folder as `<base>`, ids as `<id>`, libx265's pool of the recording machine's usable CPUs as `pools=<cpus>`, compared with this machine's); re-recorded for PR #40 from that PR's head (ae830e9: Node with its `lean/parity/converterJobs.js` taking an ffmpeg path), with Node's ffmpeg the FFMPEG_ONE_FRAME_THREAD script of `service/tests.rs` (libx265 on one frame thread: the same bytes on a busy machine; the pool run as `pools=4`, the 4 usable CPUs it was recorded on: the same bytes on a machine with other CPUs), on the same `job-clip.mp4` | `service/tests.rs`, the Rust converter through the same script (digests and ffmpeg runs compared with the same ffmpeg build; another build encodes other bytes) |
| `nodes-worker.json` | Node's worker asked by Node's main (35 requests, then the main's lanes, encode, cancel, slots) | `nodes/tests.rs`: the Rust worker, paired by the Rust main, the same requests |

The contract: the fixture archive (`lean/tests/fixtures/contract/footage.tar.xz`),
record.js goldens of every GET route and of `tools/contract/allow.json` from
the Node fixture server, and the live checks' answers (`live.json`,
`tools/contract/live.js`, which now pairs as a main itself instead of loading
`server/nodes.js`); `routes.json` lists which routes they cover (all 196).
`node tools/contract/frozen.js` starts the Rust release binary on the same
archive and compares; CI's rust-tests job runs it. On this machine: 196
routes, 194 the same, 2 the same but for an accepted difference, none differ.

Retired with Node, as they cannot exist without it: Rust and Node reading
each other's interrupted conversions (`crash_in_rust_recovered_by_node`; the
same kill points are now restarted by the Rust converter, and the frozen
store checks both write the same files), the Rust main pairing with Node's
worker (the Rust worker answers as Node's, frozen), and the manual
Node-against-lean scripts per area (`compare.js`, `compareFootage.js`,
`canCompare.js`, `canNow.js`, `placeTags.js`, `opsCompare.js`,
`uiCompare.js`, `contractUi.js`, `uiPages.js`, `bigCompare.js`,
`measure.js`): their routes are covered by the frozen contract, not their
extra depth (uiCompare's sweep of every file compressed and with its ETag,
compareFootage's writing routes on copies, the bigger archives).

Still plain Node (no packages, nothing of the old server):
`tools/contract/frozen.js`, the dev tools and their tests (`node --test
"tools/**/*.test.js"`: bench, contract, the image workflow and compose
files), and two stand-ins for outside services in `lean/tests/fixtures/js/`
(a fake ACME server, the reports receiver: `LEAN_NEED_NODE=1` makes their
tests fail without node, as CI sets).

## Status

One server: core's `AppState` and `Router` are the one entry point, and every
area is served through them (`src/wire/`, see "Integration" below).

| Module | State |
| --- | --- |
| core | ported, see below and `src/core/README.md` |
| supervisor | ported, see below and `src/supervisor/README.md`; TLS and the fd-3 link wired by core |
| footage (`src/footage/`, with the first slice's lists in `api.rs`; arrival checksums in `src/arrival/`) | ported |
| viewer | ported (archive gaps with CAN Bridge and Sentry USB evidence, CAN GPS in place tags and drives, Studio's trashFolder) |
| ops | ported, the server monitor included |
| ui (pages, static files, interface packs, exports, settings) | ported |
| can (CAN logs, uploads, device port, Sentry USB files, the Stream Deck's live stats) | ported |
| converter | ported and mounted: job store, scanner, job service, lanes per GPU and per helper server, automatic conversion, benchmark, converted index, stats, runtime, the 22 channels behind `/api/converter/invoke/:name` and `/api/converter/events` |
| helper servers (nodes) | ported and mounted (main side, worker, benchmark, picture check, the converter's node lanes) |

Same answers, the whole contract (now `node tools/contract/frozen.js` against
the frozen answers; before, `node lean/parity/contractAll.js`: the Node
fixture and lean on copies of the same archive, both with HTTPS and a
password; record.js goldens of every GET route and one request for each other
route from `lean/parity/contractAllow.json`, replayed by compare.js, then the
live checks of `contractLive.js`): every route compared, none differs but for
the accepted differences; see "Integration".

## Integration (`src/wire/`)

`main.rs` opens core's state (after ops' pending snapshot restore), attaches
the supervisor's link, then `wire::build` makes every area on core's state and
puts their routes into core's router, and `wire::start` starts their
background work. What each area needs from the rest is its context trait,
implemented on core's state:

| Area | Context | What it gets |
| --- | --- | --- |
| footage | `wire/footage.rs` `FootageCtx` (`footage::ctx::Ctx`) | manager.db through core's connection (`ManagerDb::of_core`), announce, audit, logs, core's jobs, the supervisor's `IpcMounter` when supervised (else the `LocalMounter`), ops' share alerts (`sync_share`) and savings, the CAN area's `car_summary`, `has_can` (CAN tags, `canRecordings`), `delete_with` (trash-preview `can`, `withCan`), `footage_gone` (Recycle Bin deletes), Sentry USB (`sentryUsb` in days), forgetting a removed vehicle |
| ops | `wire/ops.rs` `CoreOps` (`OpsCtx`) | core's connection, logs and audit, log search, the hub, vehicles and shares from footage (bin bytes, days left, policy), core's TLS status, shutdown; the reports hooks of `/api/auth/me` and the setup page |
| viewer | `wire/viewer.rs` `CoreViewer` (`viewer::ctx::Ctx`) | settings, the hub, audit lines naming who asked, ops' notifications for archive gaps (`raise_note`, `resolve_note`, `open_notes`), the CAN keys, footage's scans (files with birth times), codecs; admin checks are core's (viewerMay, home-only) before the route runs |
| ui | `wire/ui.rs` `CoreUi` (`UiCtx`) | settings, the hub, audit and logs, core's jobs, who asks (session, confirm window, HTTPS, client address), footage's vehicles, the viewer's speed index for exports, the CAN area's car-data switch; core's `note_start_call` hook feeds prefetch learning |
| can | `wire/can.rs` `CoreCan` (`CanCtx`) | settings, dashboards, the hub, audit, footage's vehicles, scans, bin items, protect list, bin lock, TRUST_PROXY and the client address, the certificate fingerprint; uploads through core's raw paths on the web port and core's device port (TLS, 6 per address, 256 in all, 15 s / 20 s) |

Who asks: footage, ops and CAN take it as a value made from core's `Ctx`;
the viewer and ui ask their context, which reads the request this thread
answers (`wire::Who`, set around each call).

Routes: `wire/routes.rs` lists every route of the Node router that core does
not register itself (from docs/api-contract.json, in its order) with the area
answering it; each goes into core's router, so core's checks (session, role,
home network, two-step, CSRF, origin) run before every one, in Node's order.
The paths index.js answers by hand after those checks (`/api/media`,
`/api/scrub`, `/api/converter/events`, `/api/ui-packs/upload`) are core's
`Router::api_raw`; the token paths (`/metrics`, `/api/can/logs…`) are
`Router::raw`; pages are `Router::web` (ui). JSON answers over 1 KB go gzipped
(`wire::gzip_json`), as sendJson.

One of each: the speed index is the viewer's (Node's day files; the old
SQLite index, `speeds.rs` and the first slice's `/api/speeds*` are gone, the
summary moved to `viewer/speed_index.rs`); work limits are the viewer's
(`GET|PUT /api/settings/work-limits`; the ui area's copy is gone); vehicles
are footage's `Vehicles` (manager.db `vehicles` setting); security headers,
CSP and `/healthz` are core's (the ui copies are gone). The footage catalog
is in manager.db's `catalog_files`, `catalog_dirs`, `catalog_scans` and
`clip_codecs`, with catalog.js's columns, FORMAT 1 and batches (its own
connection to the file, WAL), so either server resumes from the other's last
scan; `lean-catalog.sqlite` is no longer read or written (an old one can be
deleted). The stand-alone contexts are gone (ops `LeanCtx`, ui `LocalCtx`,
viewer `AppCtx`, CAN `lean.rs` and its plain-HTTP device port, the temporary
`/api/studio/context`); footage's `LocalCore` stays as the tests' stand-in.

Checked (all on the integrated server, 2026-11-16):

- `cargo test --release`: 540 tests pass (every area's ports of Node's
  tests and their parity runs against the Node code, among them the
  converter's store, scanner, jobs, lanes, automatic conversion, benchmark,
  crash suites and bridge, ops' stats replay, the arrival checksums, the
  helper servers, and `tests/archive_gap_parity.rs`: the 77 analyze() calls
  of Node's archive gap tests, every answer the same);
- `contractAll.js` (all 196 routes, with the Stream Deck's seven; rerun
  2026-11-17): 193 answer the same, 3 the same but
  for an accepted difference (`GET /api/speeds/status` readMode,
  `GET /api/system` nativeHelper, the random code of
  `POST /api/nodes/worker/pair`), 0 differ, 0 not compared. Per area: core
  34, ops 27 + 1 accepted, ui 15, footage 30, nodes 18 + 1 accepted, viewer
  29 + 1 accepted, CAN 38, converter 2. The replay now keeps the order the
  requests were recorded in (the three helper-server differences of the
  last run were the replay's file-name order: a pairing code cancelled
  before it was shown), and an allow-file entry carries its normalisers into
  the replay (the per-server CA in `PUT /api/security/hostnames`, the
  archive's stamped name in `POST /api/logs/clear`). What goldens cannot
  hold is compared live (`contractLive.js`, the same scripted requests to
  both): `/api/events` (the topics each action brings, and those that come
  by themselves in a quiet minute), `/api/converter/events` (hello, then a
  real conversion of an event folder to the converted folder: its states,
  its last snapshot's clips and counters, its Activity row), `/metrics`,
  `/api/can/logs/ping`, `/api/can/now`, `/api/can/now/:stat` and
  `/api/can/now/ca.crt` (a Stream Deck link made, its pin against the
  server's own CA, a new link, off) and `/node/v1/info`, `/jobs/:id`, `/jobs/:id/output`
  with real tokens (node mode paired by Node's own main side), and 2fa/start,
  logout (a session of its own), metrics/enable, snapshots,
  updates/check, can/enable, can/tokens, can/stream-deck (POST, DELETE),
  nodes/worker, speeds/index with
  their random parts normalised;
- `bigCompare.js` (3,000 clips, six cameras, Recent/Sentry/Saved with
  event.json and thumb.png, a read-only bind mount, the converter idle;
  both servers scanned, indexed and scanned again): 1,210 answers of 78 GET
  routes, 1,208 the same, the other two the accepted readMode and
  nativeHelper;
- `compare.js`: 217 requests the same; `compareFootage.js`: 97 writing
  requests the same; `canCompare.js`: 151 requests, no differences;
  `canNow.js` (the Stream Deck, CAN section): 423 answers, no differences;
  `uiCompare.js`: 2871 of 2871 answers the same; `contractUi.js`: 17 of 17;
  `uiPages.js` (Chromium): 30 of 30 pages load the same; `opsCompare.js`:
  15 of 17, the other two the accepted `host.node` and nativeHelper;
  `placeTags.js`: recordings, days and drives with CAN GPS the same;
- `npm test` passes (1,446 tests, 94 skipped; rerun 2026-11-17).

## Converter

Mounted (`src/wire/converter.rs`), as converterHost.js starts it: on its
own thread, `Host::start` (open, then start with its recovery, 5 attempts
2 s apart; until then the routes answer `CONVERTER_STARTING` and the events
503, as Node). Its options: the arrival area's `before_replace_fn`,
`hold_discovered` (Sentry USB's `holds` from the CAN area's status reader),
the benchmark's `power_meter` (ops' meter), `is_cheap_now` (ops' power
price), the helper servers' node lanes (`FromNodes`). The bridge answers
`POST /api/converter/invoke/:name` (blocking thread) and
`/api/converter/events` (SSE, `hello` first, 200 streams at most, the
client forgotten when the stream closes), with `mount_runtime` (devices,
automatic conversion, the benchmark); verification is never Off and every
folder goes through the footage guard (`ConverterCtx::resolve_path`:
index.js `allowed`, the vehicles' folders with an SMB one only inside
FOOTAGE_ROOT, the output folders, the deny list; a destination may not exist
yet, safePath.js realOrNearest). Every job snapshot gives Activity its line
(mirrorConverterJob: started, updated when the line changes, finished with
the job's energy, a notification for failed clips), and ops its
`job_snapshot` (savings, the stats' job mark); each progress event samples
`ConvertStats` (the heartbeat's speed); `clip_converted` goes to the arrival
area; ops' `encoder_block` and `heartbeat_hardware`, `converter()`,
`active_encodes()`, `job_progress()`, `jobs_queued()` and the helper
servers' `WorkerRuntime` are the running converter; `host.stop()` at exit.
Also wired: core's `settle_conversions` / `conversions_active` hooks for
Clear jobs (index.js settleConversionRows: once the converter has listed its
jobs, a conversion row still "running" for a job it no longer runs gets the
job's end, or "interrupted" when it no longer has the job; the jobs under way
are kept), the jobs as index.js keeps them (slimJob; a job listed at the start
is not mirrored, as Node), the heartbeat's device names (heartbeat_hardware
names the GPU by the encode's render node or NVIDIA index, encodeGpuName).
The converter's data folder is Node's: `DATA/converter` (its job store
`converter-jobs`, the converted index, automatic conversion), the temp folder
`DATA/converter-temp`, so either server takes over the other's jobs. The
viewer's previews of a converted clip are made again only when asked.


Done, round 1 (`src/converter/`, library only: nothing is wired into
`api.rs` yet, so no route answers and nothing can touch footage from the
lean server):

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

Round 2 (also library only; the integrator mounts it, see "Mounting"):

- `jobstore/` (jobStore.js): job.json + job.journal (append, replay, the
  1,000-record / 16 MiB limits, a torn last line ignored), every manifest
  rule of normalizeManifest in Node's order with Node's error codes, the
  normalized keys in Node's order (so the files are byte for byte Node's),
  preflight limits, quarantine of a corrupt job.json or journal, create /
  save / load / list (ICU order) / summaries (summary.json with Node's
  stamp) / transition (the store's own clips are not checked again: an
  `Item` only exists normalized) / recover (the recovery truth tables) /
  discard. Kill-point hooks (`StoreHooks`) as crashPoints.js wraps the store.
- `scanner.rs` (scanner.js, teslaFilename.mjs): the same clips in the same
  order (groups in groupOrder, then names by UTF-16 code unit), the same
  skips (hidden, TEMP-/BACKUP-, symbolic links, outside the real source,
  the destination inside the source), compareScanPaths.
- `service/` (jobService.js): start (one job at a time unless automatic jobs
  on separate devices), discovery in batches with follow-up parts at the
  clip limit, the workers (concurrency, raised and lowered while running),
  the lead and save-slot rules for job-level fields, per clip: ffprobe,
  staging or direct, the original's fingerprint, encode (ffmpeg -progress
  parsed exactly as Node, activeEncodes' live numbers, the stall watch),
  the telemetry writer, verify, size retries, the under-source retries
  (85 %, 60 %) and "keep the original" when nothing is saved, the split save
  (prepare outside the slot, swap/commit in it, rollback record), cleanup
  by recorded identity, failures, pause (settles when every worker parks),
  resume, cancel, discard, retry failed, dismiss summary, network waits
  (paused_network with its recovery record, backoff, "gone while the share
  answers"), shutdown (the stop record), recovery (every action of
  performRecovery: resume-queue/discovery/network, copies, replacements
  step by step through the truth tables, cleanup-and-restart), events and
  throttled snapshots (publicSnapshot / summaries).
- `runtime.rs` (runtime.js for the server): `<data>/converter-jobs`, the
  real temp path, `<temp>/sentry-six-converter`, startup recovery (deferred,
  then one job after the other), the startup sweeps (unreferenced
  verification folders, leftover work folders and encodes older than an hour).
- `ipc.rs` + `ctx.rs` (ipc.js + converterBridge.js): the 22 channels with
  their checks, error codes and answers (sanitizeSnapshot with the 256-clip
  cut, sanitizeLiveProgress, responseError), verification never Off for a
  server start, every folder through the footage guard
  (`ConverterCtx::resolve_path`), the SSE live updates.

Checked (`cargo test --lib converter`; the end-to-end ones need ffmpeg with
libx265 and node, `LEAN_CONVERTER_JOB_FIXTURES=<dir>` reuses the clip):

- job store parity (`lean/parity/converterStore.js`): the same scenarios
  run by both stores give byte-identical job.json and job.journal; each
  lists and loads the other's jobs (job.json + journal) as its own and
  continues them (two rounds, each way); summaries equal, Node's
  summary.json reused; recover() with the same facts takes the same step;
  7,842 damaged manifests (every field removed, nulled, retyped; unknown
  and private fields) get the same answer (the same code, or the same job);
  journalDiscovery and snapshotReuse rules;
- scanner parity (`lean/parity/converterScan.js`) on a tree with every skip;
- conversions (`lean/parity/converterJobs.js`): replace direct, replace
  through staging, separate; the same job (states, result codes, attempts,
  encoder, counters, summary), the same events (but live-update counts) and
  byte-identical outputs as Node's run on a copy; Node reads Rust's job;
- the crash suites (converterCrashReplace, converterCrashSeparate,
  converterCrashParallel, replaceCrash, crashPoints.js): the converter
  killed with SIGKILL (its process group) at encode, verify,
  snapshot-unrecorded, save-recorded, copy-recorded, slot-entered,
  backup-renamed, backup-recorded, before-final, after-final,
  final-recorded, quarantined, rolled-back, before-result, after-result,
  cleanup-unrecorded; on a share without hard links; through staging;
  separate; three at once; restarted by Rust, and by Node (Rust's
  interrupted jobs finished by the Node converter). Every time the job
  finishes by itself, every clip holds its verified H.265 conversion, the
  original was at its name or its backup at the moment of the kill, and
  nothing is left behind;
- restartResume (stopped between clips carries on; paused stays paused and
  Resume finishes it), a cancel; ffmpeg progress lines; formatBytes ties.
- bridge parity (`lean/parity/converterBridge.js`): 104 requests (start
  configs of every kind, ids, folders outside the guard, chooseFolder,
  oversized payloads, unknown channels) answered the same by Node's bridge
  and this one on the same stand-in service.

Round 3 (also library only):

- Lanes per GPU (`service/lanes.rs`, jobService.js): resolveLanes (each
  lane's device from the device list; a missing one logged and skipped; a
  whole-node lane finds the node's default device; helper servers told
  their number, at most 8, and sent 15 clips ahead in proportion), workers
  per lane with laneLimit / deviceActive / the default lane (a switch
  between no lanes and lanes never runs a GPU above its number), setLanes,
  setConcurrency on a lanes job (its one GPU still here, else no lanes),
  slotsOf; `planner.selectFor` per lane; the decode tiers (zero-copy, GPU,
  then CPU), a tier that failed and a slower one fixed recorded broken per
  GPU and encoder; GPU decode for a Full verify with its fallback count.
- `devices.rs` (encodeDevices.js + runtime.js): render nodes by PCI slot
  (char device numbers, else /sys/class/drm), nvidia-smi with its deadline
  (a wedged one is not joined by another), the CPU last; `Registry`: one
  lookup at a time, an answer reused 2 s, resolveDevice, defaultDeviceOf,
  devices() (each device's proven encoder per codec, nothing tested with
  fewer than two GPUs or while something encodes).
- `converted_index.rs` + `mp4_header.rs` (convertedIndex.js, mp4Header.js):
  discovery skips converted clips from the index or their MP4 header (a
  share error waited for, 20 s per check), converted outputs recorded, the
  same JSON file as Node's.
- `auto_convert.rs` (autoConvert.js): settings, the per-vehicle configs and
  saved-only vehicles, the give-up index (revision 5), the schedule and
  rounds, the time window (hours or off-peak), holdManual, one job per
  vehicle on devices of its own (planLanes with the helper servers'
  priorities and Off), setLanes / setConcurrency follow a running job,
  saveVehicle / forgetVehicle, restart adoption; the same files as Node's.
- `benchmark.rs` (benchmark.js) and `Converter::run_benchmark` (runtime.js):
  every level, bad clips left out, energy per level, the verify comparison;
  originals found in a mostly converted archive; isolated level runs; every
  GPU alone; progress as `converter:benchmarkProgress` on the asking
  window's `/api/converter/events`.
- `stats.rs` (encoderStats.js, convertStats.js), `host.rs` (converterHost
  start retries), sweepEmptySnapshotFolders (after a job ends and at start),
  holdDiscovered (`RuntimeOptions::hold_discovered`), the channels setLanes,
  devices (DEVICE_UNSUPPORTED on start), getAuto / setAuto / saveVehicle /
  forgetVehicle / checkAutoNow, runBenchmark / cancelBenchmark.
- The helper servers' side (`service/encode.rs` run_remote, `work.rs`):
  a node lane's clip is encoded there (ffmpeg's progress, "queued", stall
  and kill handling), its pictures checked here (`nodes::picture`) unless
  the node is trusted, verified and saved here; a node that fails, sends
  other pictures or an encode that does not verify gives the clip to this
  server's own GPU first (two at a time, NODE_FALLBACK_AT_ONCE); with this
  server Off the clip fails (NODE_ENCODE_FAILED / NODE_PICTURE_MISMATCH /
  NODE_NO_ENCODER); a row set lower takes back the clips waiting in the
  node's queue (re-queued first, the try not counted); checks per node at
  its number + 2. `nodes::ctx::WorkerRuntime` is implemented on `Converter`.
- Probes, verifies and telemetry runs have converterHost's 30-minute limit
  (they had 30 s: a loaded machine failed a verify Node waits for; that was
  the cause of `conversions_as_node_runs_them` failing once under load).

Checked (round 3): test/lanes (the job service's part, with an ffmpeg
stand-in script and the real planner over a fake probe), encodeDevices,
convertedIndex, mp4Header, autoGiveUp, autoPerVehicle, nodePriority
(planning), benchmark, encoderStats, the picture-check and converter tests
of nodes.test.js; the crash points inside a file copy (temp-created,
temp-torn, temp-complete, temp-readback, writer, staging-copy, through a
test-only fs hook, `fs_hook.rs`) and 'lowered', each killed with SIGKILL
(replace and separate, direct and staging, three at once, one restarted
by Node): every job finishes by itself, the original never lost. Parity
(`lean/parity/converterAuto.js`): automatic conversion over a 51-step
scenario (every state, every call to the job service, the files written,
byte for byte), the benchmark's events and results (5 scenarios), the
device list (fake /dev and /sys, three nvidia-smi answers) and devices() /
resolveDevice over 8 GPU sets, all equal to Node's.

### Mounting (for the integrator)

```rust
let mut o = converter::runtime::RuntimeOptions::new(data_path, temp_path, &ffmpeg, &ffprobe);
o.before_replace_original = Some(/* arrival::Area::before_replace_fn */);
o.hold_discovered = Some(/* Sentry USB copies in progress */);
o.power_meter = Some(/* energy per benchmark level */);
o.is_cheap_now = Some(/* off-peak rate now (ops power price) */);
o.nodes = Some(Arc::new(converter::service::lanes::FromNodes(nodes_api.nodes.clone() /* Arc<dyn RemoteNodes> */)));
let host = converter::host::Host::default();
let conv = host.start(&|| converter::runtime::Converter::open(make_options()), &*ctx, 5, Duration::from_secs(2))?;
let bridge = converter::ipc::Bridge::new(Arc::new(conv.service.clone()), ctx.clone(),
    converter::ipc::capabilities(&conv.staging.capabilities()));
bridge.mount_runtime(&conv);         // devices, automatic conversion, the benchmark
// POST /api/converter/invoke/:name  -> bridge.invoke(name, body (None if empty), client)  (blocking: spawn_blocking)
// GET  /api/converter/events?client= -> bridge.attach_events(client, sink); bridge.detach(client) on close
// OpsCtx::encoder_block(snapshot, energy) -> conv.encoder_block(snapshot, energy)
// OpsCtx::heartbeat_hardware -> converter::stats::heartbeat_hardware(&found, cpu, &convert_stats, &paired, 8),
//   with a ConvertStats (settings get/set) sampled from conv.active_encodes() every poll
// NodesCtx::runtime -> Some(conv.clone()) (WorkerRuntime)
// on exit: host.stop()
```
`RuntimeOptions::new` fills the rest (tools, tune, hooks, encoders,
discovery: tests; gpu_decode true; auto_timer true). `ConverterCtx` (ctx.rs):
data/temp paths, tool paths, the footage guard, the Sentry USB hook,
clip_converted (previews), log lines. `Converter` also answers
`active_encodes()` (a benchmark's included), `encoding_now()`,
`devices_answer()`; `Service` answers `slots_of(id)`, `live_jobs()`.

Not done yet:

1. Parity of runBenchmark through the whole runtime (real clips, the
   isolated level services) against Node's: only runConverterBenchmark is
   compared (its events and results); the runtime's part is tested here.
   (pictureCheck has one Rust copy, `nodes::picture`, used by the converter.)
2. The node side is tested with a stand-in node (lanes, failover, Off,
   15 ahead, withdraw); an end-to-end run against a real `nodes` worker
   (nodes.test.js "a real remote encode") is not.

Proposed differences (need the owner's OK): a nested box literally named
`root` is serialized as a box (Node's writer would treat it as the tree
root); io error texts are Rust's where Node logs its own; Resume of a job
parked mid-replacement answers once that clip is settled (Node's answer
waits for the whole relaunched job); a job file holding a lone UTF-16
surrogate (never written from file names) is read as corrupt.

## Helper servers

Done (`src/nodes/`, mounted in `src/wire/nodes.rs`; `src/nodes/README.md`):

- the main side (nodes.js): pairing (address rules, the 12-character code,
  8 nodes, the HMAC proofs over the certificate seen, the token's form, the
  authority kept only when it is a CA that issued the certificate seen),
  every connection pinned before a byte is sent (the fingerprint, or a
  certificate the pinned authority issued and valid now; the handshake's
  signatures checked), the token as Bearer, Node's timeouts (8 s info,
  10 s probe, 15 s pair and job status, 60 s uploads and downloads with
  30-minute deadlines, twice the idle timeout otherwise), at most 64 KiB of
  an answer, the same error texts and codes (NODE_TIMEOUT, NODE_UNREACHABLE
  with Node's errno names, NODE_CERT, NODE_CERT_CHANGED, NODE_PROTOCOL,
  NODE_BUSY, NODE_DEVICE_GONE, CANCELLED); list (a lane per GPU/CPU,
  `node:<id>@<device>`, or one per older node), overview (1.5 s wait, the
  keys JSON.stringify leaves out), power / power_rows, hardware, rename,
  Vehicles first, trust, forgetCar, remove, setSlots (a number or per device);
  the remote encode as Node runs it (info first, 5 minutes of busy waits,
  two uploads at once per node, the job id taken even after a cancel once
  all is sent, `queued=1`, only real progress counts, 30-minute queue
  limit, the output created new and never past twice the clip), devices kept
  with the node for when it is offline, the power notes for the stats engine;
- the worker (nodeWorker.js): one-time codes (10 minutes, 20 wrong tries, 3
  per address), the token kept as SHA-256, the bad-token throttle (20 in
  10 minutes), the settings in Node's key order, devices per GPU/CPU with
  their encoders (30 s cache, no probe while encoding), slots per device and
  the queue of 15 (64 held in all), the disk check, the MP4 check, ffmpeg
  built from fixed choices only (`-protocol_whitelist file -f mov`, `-fs`,
  `-t`), GPU decode then without, the stall watch, the sweeper (done 10
  minutes, orphans 5), every answer and status code of the 7 routes;
- the benchmark (nodeBenchmark.js), the picture check (pictureCheck.js:
  SSIM, the offsets, the three random stretches on long clips, GPU decode
  then CPU), the 12 `/api/nodes*` routes with their audit lines.

Checked: `cargo test --lib nodes` (26 tests; the end-to-end ones need
openssl and ffmpeg, the parity ones node too): ports of test/nodes.test.js
(addresses, settings, pairing with a changed certificate and tokens, a real
remote encode, an existing output, both cancels, a renewed certificate,
refused manifests, wrong codes per address, a node that never stops
sending, clips waiting on the node, GPU/CPU lanes and slots per device, an
older node, the benchmark on real clips, Encode with, device attempts, the
picture check on synthetic and real encodes, the GPU decode fallback, upload
slots), server.test.js "a change refused part way saves none of it; a
removed vehicle leaves every node list" (and the other refusals of the
routes), reportsHeartbeatNodes' nodes.hardware() after a restart. Parity
(`lean/parity/nodes.js`): the Rust main pairs with Node's worker, encodes
there, cancels and sets its slots; Node's main pairs with the Rust worker
and does the same; and 35 requests (pairing refusals, tokens, info, slots,
jobs, a real encode and its output, deletes, the throttle) get the same
status, content type and JSON from both workers.

Not done yet:

- (done by the converter's round 3 and mounted: node lanes in jobService,
  autoConvert's planLanes with the nodes' priorities, `WorkerRuntime` on the
  converter, which the worker on core uses.)
- (done on core: `NodesCtx` on core's state (the `nodes` / `nodeWorker`
  settings, audit, the `nodes` log scope, core's TLS and CA, ops'
  `node_power`, this server's power report and GPUs, vehicles, paths,
  the running converter as its `WorkerRuntime`); `/api/nodes*` through core's router; `/node/v1/*` as core's raw
  path on its HTTPS port with the served certificate's DER, the body read
  on a blocking thread, a refused upload drained, `delivered()` once the
  answer is taken; `forget_vehicle` on vehicle removal; `power_rows` for
  `OpsCtx::node_powers`, `hardware()` in the heartbeat; `close()` at exit.)
- an answer the worker wants to close unanswered ends the connection with an
  error after its status line (hyper has no "no answer"); the runtime's
  end-to-end node lanes against a real worker are not run (Converter, "Not done yet").

Proposed differences (need the owner's OK): TLS failures read "Could not
reach the node (EPROTO)." or rustls' text where Node names OpenSSL's code;
a name cut at 64 UTF-16 units never splits a surrogate pair; a request whose
upload is stopped on the worker (revoked, node mode off) is closed without
an answer (Node leaves it open until the main gives up).

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
- (done: footage mounts through `IpcMounter` when the supervisor started the app)
- lean/Dockerfile: run as root with the supervisor as CMD under tini, with
  setpriv, cifs-utils and tini installed.

Proposed difference (needs the owner's OK): file system error texts that are
only logged ("mount car: ...") read like Rust's, not Node's.

## Ops

Done (`src/ops/`, handlers over the `ops::ctx::OpsCtx` trait; routes in
`ops/routes.rs`; the trait on core's state in `src/wire/ops.rs`):

- notifications: db.js notify/resolve/resolveId/markRead/list (an unchanged
  repeat changes nothing and announces nothing), activity.js Notifications
  (muted kinds, share, read-only and space alerts with the 10-minute
  grace), the rules, all 5 routes. Node has no outbound channels (no e-mail
  or webhooks), so there are none here;
- health.js checks (same order, key order and texts), one run at a time,
  the banner, the startup self-check a minute after the start with its
  notifications and log line;
- snapshots.js (VACUUM INTO, 7 kept, restore at the next start through
  `snapshots::apply_pending_restore`, which main.rs calls before core opens
  manager.db);
- powerPrice.js and savings.js exactly (local time, overnight rates,
  backfill, by month), PUT /api/settings/power, savings-by-month; savings
  recorded from the converter's job snapshots (`Ops::job_snapshot`) and the
  backfill run at the start from the jobs table (`ops::month_of_job`,
  db.jobByExternal);
- buildInfo.js, hostInfo.js, imageUpdates.js (registry token, multi-arch
  index, build numbers, sticky critical levels, the 12 h / 10 min checks,
  notifications);
- metrics: settings, enable, disable and `/metrics` with its token;
- reports: reportsConfig, reportsScrub, reportsProtocol (seal and open,
  sign, proof of work, schema, moved notices), reports.js (opt-in, outbox
  caps, backoff, 429/POW/TIME, the per-hour manual limit, crashes, daily,
  heartbeat and normalizeHeartbeat, install and anonymous keys kept in
  Node's PKCS#8 form). Only `https://reports.skittles.live` (or an https://
  REPORTS_URL; http only to localhost under NODE_ENV=test). The content:
  `ops/diag.rs` builds index.js reportDiagnostics, reportHeartbeat and
  reportIdentifiers (and storageTotals.js) from ops' own parts and the
  `OpsCtx` calls below; crash notes from 500s and panics through
  `Ops::note_server_error` / `Ops::note_crash`;
- /api/system, /api/support-bundle (zip, same scrubbing), /api/updates;
- the server monitor, all of server/stats/* (`ops/stats/`, one file per
  Node file): history, CPU (sockets, throttling, clock), memory, host (OS
  from the kernel, appVersion), the process table (reaped children, page
  size, the app's tree), GPUs (DRM cards, fdinfo engine use per client and
  per process, amdgpu/i915/xe sysfs and hwmon, runtime suspend, the held
  numbers, pci.ids names, the long-running nvidia-smi with its backoff,
  WSL's /dev/dxg), power (RAPL read here or the supervisor's `rapl-reading`
  through `Ops::rapl_reading`, the wrap-around, per socket, APUs), energy
  and costs per day and per job with baselines and peaks, data used per day
  (traffic.js: scopes, splits over midnight, restarts), disks, file systems
  and share answer times (mountinfo, SMB versions, not-mounted shares,
  hung checks), sensors (hwmon, thermal zones, fans, per socket), alerts
  with hysteresis as `server:` notifications, unlock hints, background
  reads (at most 4 at once, answers land between samples), sampling only
  while watched or busy, the once-a-day `tick()`, the RAPL keep-alive;
  nodePower.js (`ops/node_power.rs`: powerReport, cleanReport, combine) and
  GET /api/stats as index.js builds it (`Ops::stats_answer`: "All
  servers", peaks, price, the encoder block); server/gpu.js detectGpus,
  usableGpus, encodeGpuName (`ops/gpu.rs`, for the converter area to use).

Hooks other areas call (methods on `Ops`): `rapl_reading(msg)` (core's
supervisor link), `note_server_error(name, message, stack)` (core's error
path for a 500), `note_crash(...)` (a panic hook), `job_snapshot(&JobSnapshot)`
(converter: each job snapshot, and the jobs listed at the start),
`job_energy(id)` (core's Jobs keeps it with a finished conversion),
`meter_start()` / `meter_stop(token)` (the benchmark's power meter),
`node_power(id, at, w, encoding)` (nodes.js onPower).

`OpsCtx` calls added in round 2, all with defaults so they can be
implemented one area at a time: `encoder_block(snapshot, energy)` (now takes
the stats snapshot and energy), `node_powers()`, `active_encodes()`,
`job_progress(job)`, `stats_busy()`, `request_rapl()` (send
`{ type: 'rapl', on: true }` to the supervisor), `recent_jobs(limit)`,
`access_settings()`, `places_count()`, `sentry_usb_infos()`,
`can_status()`, `car_models()`, `clips_arrived(since)`, `driven_metres()`,
`heartbeat_hardware()` (convertStats.js; the default names the usable GPUs
and the CPU), `trust_proxy()`; `VehicleInfo` gained `footage_minutes` and
`bin_items`. `identifiers()` now only adds what other areas know (account,
place names, FOOTAGE_ROOT); `diagnostics()` / `heartbeat()` stay as test
hooks (null: ops builds them).

Tests: `cargo test` (114 ops unit tests): ports of notifyUnchanged,
powerPrice, savings, savingsByMonth, snapshots, imageUpdates, hostInfo,
healthGpu, reportsScrub, reportsProtocol, reportsClient, statsHistory, gpu,
nodePower, statsPower, statsSockets (cpuinfo, RAPL per socket),
statsTraffic, statsAlerts, statsShares, statsGpu (parsers, fdinfo,
nvidia-smi backoff), statsLifecycle and stats.test.js (the reaped ffmpeg,
garbage in every file, this machine, the hung sensor), and the hooks above.
The engine is replayed against Node: `node lean/parity/opsStats.js` runs the
Node engine on the fake machines of test/fixtures/stats/machines.js (Intel +
Arc, with and without pci.ids, a 25-sample alert run, AMD, NVIDIA through a
fake nvidia-smi, Raspberry Pi, a bare container, dual Xeon, a VM, WSL,
Unraid's bridge, a NAS that hangs, a share that comes back, RAPL from the
supervisor with a price and a job) and records each tree, phase by phase,
with Node's GET /api/stats body (`src/ops/stats/testdata/*.json.gz`, 116 KB);
`ops::stats::tests::the_same_answers_as_node_on_every_fake_machine` builds
the same trees on the same clock and compares every field of every sample:
all the same (15 scenarios, 101 recorded samples; `host.node` is null here). Also
`tests/reports_parity.rs` as before. Nothing goes anywhere but 127.0.0.1.

Same answers: `node lean/parity/opsCompare.js` records goldens of the ops
GET routes from the Node fixture and replays them against the lean server on
a copy of its data folder, and compares GET /api/stats and /api/health
field by field where the answer is the machine's and not the moment's
(the shape of every field; host, CPU, memory size, GPUs, power sources,
disks, shares, interfaces, sensor names, scopes, hints, alerts, price,
encoder; the checks' ids, labels and states): 13 of 17 the same, and the
stats fields differ only in `host.node`. The rest belongs to
other areas or to the machine: the encoder check and the `/api/system`
converter (converter area), `security.https` (core's TLS), the disk's free
space, which can change between the two runs (in notification titles and the
banner), and, in one run of two, the order the share's space alert and the
startup check's notification were made in (the share status comes from
footage/shares).

Wired on core (`src/wire/`): `rapl_reading` from the supervisor's link
(core's hook) and `request_rapl()` sends `rapl` on it; `note_server_error`
from core's 500 path (a new `server_error` hook, unexpected errors only, as
`!err.status`); `note_crash` from a panic hook; `job_snapshot` from every
converter snapshot and the jobs listed at the start; `job_energy` with a
finished conversion's Activity row; the `OpsCtx` calls `converter()`,
`active_encodes()`, `job_progress()`, `jobs_queued()`, `request_rapl()`,
`recent_jobs()`, `access_settings()`, `places_count()`, `can_status()`,
`car_models()`, `clips_arrived()`, `trust_proxy()`, `identifiers()`
(accounts, places, FOOTAGE_ROOT), GPU detection through `ops::gpu`;
`VehicleInfo` with `footage_minutes` and `bin_items`; hub, audit, log
search, sign-in and the 🔑 window are core's; share status is footage's.

Not done yet:

- (done: the encoder block and heartbeatHardware/convertStats are the
  converter's, the benchmark's meter is ops'; `sentry_usb_infos()` reads the
  CAN area's Sentry USB info files, `driven_metres()` sums the speed index's
  days (index.js drivenMetres), and the helper servers' power calls count as
  a page asking for the stats (statsAskedAt, the RAPL keep-alive).)

Accepted differences (the owner's OK): `host.node` in /api/stats is
null (there is no Node: Node puts process.version there); a share check's
answer that lands during the same sample shows from the next one, as in
Node, but a background read's answer now always waits for the sample to end
(Node's promises do the same; noted because Rust's threads could be faster).

## Viewer

Done (`src/viewer/`, handlers on the small `viewer::ctx::Ctx` trait,
implemented on core's state in `src/wire/viewer.rs`):

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

- (done: archive gaps whole (archiveGap.js analyze, carFilesPass and the
  sentences): CAN Bridge driving and Sentry minutes from the CAN index's
  minute files (`act` at the top, else read whole; the keys learned, the
  Sentry habit, CAR_FORMAT), wrong time zones, Sentry USB's transfer range,
  missed snapshots, the list of what the car wrote (Pi missed, car didn't
  record, waiting, deleted, unknown), the Recycle Bin, the day cards'
  `archive` and `carFiles`, `soon()` after the CAN index indexes a key's
  logs, `forget` with the vehicle; checked by `tests/archive_gap_parity.rs`
  (lean/parity/archiveGap.js: every analyze() call of Node's own tests
  test/archiveGap, carFiles, deletedClips, sentryUsb and snapshotGaps, 77
  calls, the answers field for field the same);
- (done: CAN Bridge GPS in recording place tags and drive ends
  (recordingPlace.js fixesOf, canEnds, canNear), `can` on drives;
  `lean/parity/placeTags.js` (test/recordingPlace.test.js's footage, speed
  index and CAN index on both servers): recordings, days and drives the same;)
- (done: any time zone (Intl's, through chrono-tz) for driving's "this week"
  and the archive gaps' wall clock;)
- (done: `POST /api/studio/trashFolder` through the footage area's Recycle
  Bin, in index.js's order: the allowed guard, the vehicle, a scan when there
  is none, the recordings in the folder, the bin's checks;)
- (done: archive-gap notifications through ops, arrival from the birth time
  where the share has one, admin checks by core, audit lines naming who
  asked, the hub; one speed index.)

## Footage (`src/footage/`)

What it needs from core is `footage/ctx.rs` (`Ctx`: the manager database,
announce, audit, logs, jobs, the converter's clips in hand, the supervisor's
`Mounter`, and hooks for the CAN, savings, notifications and Sentry USB
areas; `Caller` for who asks), implemented on core's state in
`src/wire/footage.rs`; `LocalCore` is the tests' stand-in. Routes:
`footage/routes.rs` `handle`, called through core's router; access checks
(admin, viewer, CSRF origin) are core's, `Caller::require_confirmed` is the 🔑.

### Arrival checksums (`src/arrival/`, mounted in `src/wire/arrival.rs`)

Done:

- `record.rs` (server/originalChecksums.js): `locate`, `line_for`,
  `parse_record`, `Recorder::record` (the share root's
  `.sentrymanager/original-checksums.sha256`, O_APPEND + fsync, folder fsync
  when new, a torn last line started anew, one writer per record file, only
  inside a vehicle's folder), the day marks sidecar
  `original-checksums.marks.json` and the 45-day pruning (temp, fsync,
  rename), the converter's before-replace hook (`before_replace_fn` for
  `RuntimeOptions.before_replace_original`; an Err keeps the original, with
  Node's log line).
- `engine.rs` + `index.rs` (server/arrivalChecksums.js): only shares with
  `.sentryusb/`, the same candidates (Tesla clip names in the four groups,
  no dot paths, no converter artifacts), the same order (fresh arrivals of
  48 h, then by clip time, then the backlog newest first), held / busy /
  settling / unchanged / encoded skips, the codec the inventory knows, the
  rate limit and idle pauses, the identity check after hashing, per-cycle
  cap and the next pass 30 s on, a kick ending a backlog pass, `converted()`
  for our own output, prune of gone clips, the index snapshot + journal
  (same files byte for byte: JS number and key order, v1 read, torn line,
  compaction thresholds), `view` (field for field, time zones via chrono-tz),
  `stats`, `forget`, `start` / `stop`.
- `holds.rs` (sentryUsb.js interpret / inRange / holds) on the status
  file's transfer fields, parsed as parseStatus does.
- `routes.rs`: the `record` field of GET `/api/vehicles/:id/sentry-usb`,
  POST `/api/vehicles/:id/sentry-usb/record` (400 text, setting, kick, audit
  line), the vehicle removal.

Tests: test/arrivalChecksums.test.js (all 17) and the record tests of
test/sentryUsb.test.js ported (`cargo test --lib arrival`), the transfer
range test, the before-replace hook (line written; error line and Err when
it cannot be). Parity (`cargo test --test arrival_parity`, needs node;
`lean/parity/arrival.js`): Node's module and the Rust one in turn on the
same generated archive (TeslaCam root, all four groups, backlog of 3 days to
3 years, H.265 / AV1 / H.264 MP4s, converter artifacts, dot folders, a held
clip, a converted clip, a vehicle id needing `_`), two passes (a clip gone,
a re-upload, a new clip): the record, marks and index files byte for byte
and the view and bytes read equal; then 60 days of record calls with
pruning, files byte for byte.

Wired on core (`src/wire/arrival.rs`): `ArrivalCtx` on core's state (the
footage area's vehicles and scans with their birth times, the catalog's
codecs, `holds` from the CAN area's Sentry USB status reader, the
converter's clips in hand and its running state, the `sentry-usb-record`
setting, audit and the `sentry-usb` / `converter` log scopes);
`Area::open` + `start` (the 10-minute pass), `before_replace_fn` in the
converter's `RuntimeOptions` (an Err keeps the original:
CHECKSUM_RECORD_FAILED), `clip_converted` from the converter, `scanned()`
after each finished scan once Sentry USB's status is read again, the
`record` view in the CAN area's GET `/api/vehicles/:id/sentry-usb` (which
adds `canBackfill`), its POST `…/sentry-usb/record` kicks the pass (the
CAN area's handler stores the setting, as `routes::post_record` does), the
vehicle removal forgets the index and the setting, `stop()` at shutdown.

### Vehicles, inventory, catalog, Recycle Bin, cleanup

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

- `archiveGap.js`: the viewer area's per the table above (the day list's
  `archive` and `carFiles`); `deleted_clips::list` is what it reads from here.
- (done: the catalog is in manager.db's catalog tables; core wiring of
  `Caller`, jobs, announce, audit, the CAN hooks, savings, share alerts,
  `vehicle_removed` for savings and Sentry USB; `IpcMounter` when supervised.)
- The car-model change does not kick the CAN index yet. (`vehicle_removed`
  forgets the archive gaps and the drive data now.)
- Stars are sorted by clip with byte order; Node uses `localeCompare`
  (ICU). The same for clip keys (YYYY-MM-DD_HH-MM-SS), which is all a star
  can hold.
## ui

Done (`src/ui/`, what it needs from core in `src/ui/ctx.rs`, implemented on
core in `src/wire/ui.rs`):

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

- (done: `UiCtx` on core; core's checks run before the ui routes, which no
  longer check X-Requested-With and Origin themselves; the work limits are
  the viewer's.)
- `streamZip` (the CAN bundles' streamed zip) is the CAN area's;
- `GET /api/settings` shows the power price; its PUT is the power-price area's;
- original.zip is deflated by flate2 (miniz), not zlib: the files are the
  same, the bytes of the archive differ (the contract ignores its body);
- the uploaded pack is written at upload time, so its files' ETags differ
  between servers (as between any two Node servers).

Node quirks kept as they are: a board without an id gets the id
"undefined"; the hourly exports tidy can remove the work folder of an
export that is rendering (its folder name is not an export id).
## CAN (`src/can/`)

Done: every route of the "CAN logs" (35, with the Stream Deck's seven) and "Sentry USB" (3) groups and
the CAN Bridge upload API (`/api/can/logs`: ping, status, chunked uploads
with their checks, token binding, wrong-token and per-token limits), on the
web port and on the device port (`port.rs`, CAN_PORT, opened and closed with
the uploads). Behind them, ports of: canLogs (names, resumable uploads,
catalogue), canLogReader + canColumns (`xz -dc`, both formats, the same
bounds and refusal texts, one decoder slot for the index, one for
downloads), canDbc + the `server/dbc/` sets, carModels (VIN, the car
setting, which set decodes a car), canFormat, canIndex (minute files,
raw snapshots, signals.json, car.json, ids-<day>.json, done.json,
packed.json, repacking, removing a log), canTrust (ECDSA P-256 with the
`p256` crate, pairing, the chain with restarts, judged again after a rule
change), canSearch + the search queue (45 s budget, resume tokens, one per
user, 429 past four waiting, stopped when the page closes), canSync (the
speed correlation, edges, drive fit) and its cache, canPrune, canFootage
(the CAN tag: `Can::has_can`), canCalc + carCalc's point stats, the
bundle zip (Zip64), the decoded CSV (gzip), the candump download (stalled
reader ended after 60 s), sentryUsb + sentryUsbDevice + sentryUsbCar +
carFiles. JSON is written as JavaScript writes it (`json.rs`: number form,
integer keys first), times in a car's zone come from the system's zoneinfo
(`tz.rs`). The index's files are the Node server's (a Node data folder is
read as it is, and the Rust index writes the same files).

Checked: `cargo test` (`tests/can_parity.rs`: `parity/canFixtures.js`
indexes 12 logs with Node, both formats, broken and cut-off ones, an
internal GPS bus, a VIN, a legacy Model S, the bridge's own test file; the
Rust index writes byte-for-byte the same unpacked files and gives the same
clipData, raw, signals, idSummary, newIds, messageName and heads, before and
after removeLog + repack; `tests/can_units.rs`: trust with real
signatures, the chain, the columns sample, query times, prune spans, the
upload checks, the Sentry USB files) and `node lean/parity/canCompare.js`
(Node and lean on the parity archive with those logs at its drive and
Sentry USB's files on the share: 151 requests, the same answers; the
server's own times, per-instance data folders, and the Sentry USB `record`
part are normalised).

Live CAN stats for a Stream Deck (Node 92ad4e1, d30853c, a9f2482, 0560668,
edb6989): `now.rs` is canNow.js (the 32 stats with their signals, the
coolant inlet temps included, each from the first signal with a value, the
calc.* ones from `calc.rs`, the last minute's values looked for 5 minutes
back, named states in words without the words every name shares, SNA left
out, units.js canonUnit and the mi/km conversions, the digits per unit,
Math.round then toFixed, stale past 5 minutes). `routes.rs` answers
`GET /api/can/now[/<stat>[.txt]]` before core's checks (`wire::can::now`,
a raw path as index.js answers it before the host and cookie checks):
404 while no link, 405 but for GET and HEAD, `/api/can/now/ca.crt` public
(the certificate authority, 404 "No local certificate authority." with an
own certificate), the token by Bearer or ?token= (SHA-256, 401 plain text),
`Access-Control-Allow-Origin: *` on every answer, units, car by its
vehicle's id or name or a CAN key (else the newest), answers worked out at
most every 3 s (16 kept, cleared with a new link or Turn off), plain text
per stat ("—" without a value), 404 for an unknown stat, 500 when the stat
does not decode; JSON gzipped over 1 KB. `GET|POST|DELETE
/api/can/stream-deck` and `GET /api/can/stream-deck/plugin` (core's router:
signed in, admins for POST/DELETE as viewerMay says, then adminHere with
Node's 403 texts; the token shown once, its hash in `can-now`, the audit
lines; the pin: `ca:` the local CA's SHA-256, `cert:` an own certificate's,
none with Let's Encrypt serving; the plugin zipped from
`APP_ROOT/assets/streamdeck` in name order as writeZip, deflated by
flate2: the same files, other bytes, as original.zip). The index takes the
logs that started in the last 15 minutes first, newest first, without
waiting for the converter; older ones still wait for an idle moment, oldest
first. The pages (web/nerd.js) and the plugin's files under `/assets/` are
served by the ui area as Node serves them.

Checked: `tests/can_now.rs` (test/canNow.test.js: the stats from a fake and
a real index, the routes on the area with a stand-in for core, the pin, the
car choice and the 3 s cache, a fresh log indexed while "converting" and
the old one only once idle), `now.rs`'s own tests; `node
lean/parity/canNow.js` (Node and lean on the CAN fixtures with CAR1's drive
made 12 minutes ago, both with HTTPS: the link, its pin against each
server's own CA, the plugin's files and bytes, every stat of every car in
both units, the tokens, errors and headers, HEAD, gzip, then a fresh log
uploaded through the CAN Bridge API to both and read back live once
indexed, and web/nerd.js and the plugin's files as served: 423 answers, no differences, ageSec within 5 s); `canCompare.js`
again (151 requests, no differences); contractAll and contractLive (the new
routes, below).

The area's needs from core are `ctx.rs` (`CanCtx`), implemented on core in
`src/wire/can.rs` (`tls_status`, `ca_pem` and `app_root` for the Stream
Deck).

Not done yet:

- (done: `CanCtx` on core, access per route by core, JSON gzip over 1 KB,
  the device port on core's listener with TLS and its limits, the footage
  hooks `car_summary`, `has_can`, `delete_with`, `footage_gone`, Sentry USB
  in the days answer.)
- the transfer range for the converter's holdDiscovered, `car_files` and the
  costly missed snapshots for archive gaps wait for archiveGap's Sentry USB
  pass (the `record` part is the arrival area's);
- recordingPlace.js (place tags from the CAN GPS) is the viewer area's; it
  can read the minute files with `format.rs`.

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
- (done: the ops, converter, viewer and ui routes and hooks are wired; the
  `/api/studio/context` stand-in is gone.)

## Known differences

Accepted by the owner (2026-11-16), with the earlier ones:

- core: a JSON body over 1 MB gets `413 {"error":"Request body too large"}`;
  Node destroys the connection (the client sees "socket hang up").
- viewer: `/api/speeds/status` `readMode` follows this server's own timing,
  as Node's does.
- core and ui: each server makes its own certificate authority, so the
  certificate details differ (the contract compares their shape).
- ops: `/api/system` `nativeHelper` is true: the no-replace rename is called
  directly (renameat2), where Node reports whether its helper program was
  built.
- ops: `host.node` in /api/stats is null (there is no Node).
- the other areas' proposed differences above (helper servers' TLS error
  texts, the supervisor's logged file system errors, the encoder and stats
  details listed there).

Proposed, waiting for the owner's OK:

- can: `GET /api/can/logs/ping` answers `"maxParallel": 8` (the CAN Bridge
  asked for it, 2026-11-22; docs/can-bridge-api.md): a new field Node never
  answered, so the frozen live answer lacks it. (`POST /api/can/logs/status`
  also answers `size`, `check` and `check_reason` for complete files now, but
  its frozen answer is the `404 off` one, which is unchanged.)

Accepted by the owner (2026-11-18), after the run on the real archive
(1,236 of 1,247 answers the same; these are the only differences left):

- footage: `frontRel` of a recording without a front-camera clip
  (`/api/vehicles/:id/recordings` and `/recordings/:rid`). Both servers
  answer another camera's clip, never null (the first clip of the
  recording, inventory.js and inventory.rs alike), but which clip is first
  differs: Node keeps each file when its stat answers, and its stats run in
  parallel, so on a real share it is sometimes another camera; this server
  takes them in name order (scanner.rs `node_order`), the order Node gives
  when its stats answer in turn.
- ops: `/api/snapshots` `bytes` of the database snapshot. The snapshot is
  the same VACUUM INTO of manager.db with the same tables, but the catalog
  rows in it differ when it is taken (a minute after the start, while the
  first scan and codec reading may still run): Node writes the scan's files
  (`catalog_files`) and the codecs (`clip_codecs`) in batches of 1,000 as it
  goes, this server writes the files when the scan finishes and the codecs
  when they have all been read (`src/app.rs`, catalog.rs).

Proposed (2026-11-18), needs the owner's OK:

- converter, replace mode on an SMB (cifs) share: this server completes it,
  Node's refuses every clip with `unsafe-owned-path` (seen on a real Samba
  share: all 10 clips, the originals put back each time). The cause is the
  cifs client's cached link count: after link(original, BACKUP) and the
  rename over the original, BACKUP still reads 2 links for up to a second
  though it is the only name left, and the one-link checks refuse. Here
  lstat reads the attributes again from the server when it sees more than
  one link (staging/mod.rs `fresh_lstat`, statx AT_STATX_FORCE_SYNC); the
  checks themselves are unchanged, and a file the server says has two
  links is still refused. Confirm on a real share before relying on it.
