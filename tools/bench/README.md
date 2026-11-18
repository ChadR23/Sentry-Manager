# Measurement harness (tools/bench)

Numbers for the resource plan: how much memory, CPU and disk reading the app
uses on the real archive, how long the first index takes, and how quickly
the pages answer. **Phase 0** measures the stock image (build 143) so there
is something to compare with; **Phase 3** measures a new image the same way
and puts the two side by side.

Everything runs in the one Sentry Six Manager container being measured.
The scripts read it from the outside (`docker stats`, `docker exec` with
`sh` and `cat` over `/proc` and the container's cgroup files) and through
its normal web API over HTTPS. Nothing is sent anywhere else.

| File | What it does |
| --- | --- |
| `run.sh` | Starts one named run with the safety checks, then drives it: start, first index, idle, API timings, report |
| `sample.js` | Every 5 s: container memory, CPU and disk read; RSS, CPU % and `read_bytes` of every process → `samples.csv`, `procs.csv` |
| `latency.js` | Signs in over HTTPS; times the Footage, event, Driving and Encoder API calls → `latency.csv`; watches the first index → `index.csv`, `index.json` |
| `memlog.js` | Diagnostic run only: preload that logs `process.memoryUsage()` every 5 s; heap snapshots on `SIGUSR2` |
| `report.js` | Run folders → one markdown table |
| `clipMemory.js` | No Docker: peak memory of `server/speedReader.js` and `server/telemetry.js` reading 10/30/60 MB synthetic clips |
| `lib.js` | The parsing and checks the others share (tested in `test/bench.test.js`) |

## What a run does

`tools/bench/run.sh run --name <run> ...`:

1. **Refuses** before anything starts:
   - when the image follows `:latest` (pin a digest; `--force-latest`
     overrides, and it is recorded),
   - when the data folder is not new or empty, or when it is inside the
     archive (or the other way round),
   - when port 9100 or 10100 (or the ones given) is in use, the container
     name exists, or another Sentry Six Manager container runs (it would
     share CPU, disk and page cache; `--allow-other` overrides, and it is
     recorded).
2. Pulls the image and records its **digest**, image id and
   `BUILD_INFO.json` (the build number) in `meta.json`.
3. Creates the container like `docker-compose.yml` does (same capabilities
   and security options), with:
   - the archive at `/footage/car`, **read-only** (`:ro`), as a folder vehicle
     (`FOOTAGE_PATH=/footage/car`),
   - the fresh data folder at `/data`,
   - host ports 9100 → 9000 and 10100 → 10000,
   - a bench account (`UI_USERNAME=bench` and a random `UI_PASSWORD` in
     `<run>/bench.env`, mode 600), `UPDATE_CHECK=off`,
   - `--restart no`, so an out-of-memory kill stays visible.
4. Reads `docker inspect` and **removes the container without starting it**
   unless `/footage/car` shows `RW=false` and nothing of the archive is
   mounted writable anywhere else.
5. For `--cache cold`, drops the page cache (`sync; echo 3 >
   /proc/sys/vm/drop_caches`; it asks for sudo when not root).
6. Starts the container; `sample.js` records every 5 s from then on, and
   `docker logs` goes to `container.log`.
7. Copies the app's own certificate authority out of the container
   (`/data/tls/ca.crt` → `<run>/ca.crt`) and signs in at
   `https://localhost:9100` with certificate checks **on**. The password
   never goes over plain HTTP.
8. **First index**: waits until the inventory scan is done and a speed index
   pass has finished (`GET /api/vehicles`, `GET /api/speeds/status` every
   5 s; the times are the app's own `scannedAt` and `finishedAt`).
9. Times the API calls (10 each, after one first call kept separately),
   then **30 min idle**, then times them again.
10. Stops and removes the container (`--keep` leaves it running), and writes
    `report.md`.

Timed calls (`node tools/bench/latency.js routes`):

| Label | Call | Page |
| --- | --- | --- |
| footage-days | `GET /api/vehicles/:id/days?category=all&offset=0&limit=30` | Footage |
| footage-day | `GET /api/vehicles/:id/recordings?category=all&date=<newest day>&limit=500` | Footage, a day opened |
| vehicles | `GET /api/vehicles` | every page |
| event-open | `GET /api/vehicles/:id/recordings/:rid` (newest Sentry or Saved event) | an event opened |
| event-thumb | `GET /api/vehicles/:id/recordings/:rid/thumbnail` | its thumbnail |
| drives | `GET /api/vehicles/:id/driving?weeks=12` | Driving |
| encoder-status | `POST /api/converter/invoke/getCurrent` | Encoder |
| speeds-status | `GET /api/speeds/status` | Footage, "Index speeds" |

The run folder (`bench-runs/<run>-<date>/`, ignored by git) holds
`meta.json`, `samples.csv`, `procs.csv`, `index.csv`, `index.json`,
`latency.csv`, `final.json` (the container's last state: `OOMKilled`, exit
code), `inspect.json`, `container.log`, `report.md`, and `bench.env` (the
bench account's password: delete the folder or that file when done).

## Fill in first

| What | Example | Where it goes |
| --- | --- | --- |
| The archive folder on the Docker host (the one holding `TeslaCam`, or `RecentClips` / `SentryClips` / `SavedClips`) | `/mnt/tank/tesla` | `ARCHIVE=` below |
| A folder for the runs' data folders, on a local disk, **not** the installed app's `./data` | `/srv/bench` | `BENCH=` below |
| The user that can read the archive (`id <user>`) | `1000` / `1000` | `--puid` / `--pgid` |
| The car's time zone | `Europe/Amsterdam` | `--tz` |
| Whether the archive is on ZFS (TrueNAS) | yes / no | see "Cold cache on ZFS" |

The host needs Node 22 or newer for the scripts (`node -v`), Docker, and
sudo for `--cache cold`.

## Phase 0: the stock image (build 143)

On the Docker host, in a copy of this repository:

```sh
IMAGE=ghcr.io/skittles-fivem/sentry-manager@sha256:b366c96f5caac430d2ca83e7abc284c0a9cd5695b794d93279e602bf0124800b
ARCHIVE=/mnt/tank/tesla      # fill in
BENCH=/srv/bench             # fill in
PUID=1000 PGID=1000 TZNAME=UTC   # fill in

# 0. one container at a time: stop the installed app (it reads the same archive)
docker stop sentry-six-manager

# 1. a dry run: every check that needs no Docker, and the docker command it would run
tools/bench/run.sh run --name baseline --image "$IMAGE" --archive "$ARCHIVE" \
  --data "$BENCH/data-baseline-cold" --cache cold --puid $PUID --pgid $PGID --tz $TZNAME --dry-run

# 2. baseline, cold cache (first, so nothing is cached yet)
tools/bench/run.sh run --name baseline --image "$IMAGE" --archive "$ARCHIVE" \
  --data "$BENCH/data-baseline-cold" --cache cold --puid $PUID --pgid $PGID --tz $TZNAME

# 3. baseline again, warm cache (right after, without dropping caches)
tools/bench/run.sh run --name baseline --image "$IMAGE" --archive "$ARCHIVE" \
  --data "$BENCH/data-baseline-warm" --cache warm --puid $PUID --pgid $PGID --tz $TZNAME

# 4. constrained: 4 CPUs and 2 GB, then 1 GB (warm)
tools/bench/run.sh run --name constrained-2g --image "$IMAGE" --archive "$ARCHIVE" \
  --data "$BENCH/data-2g" --cache warm --puid $PUID --pgid $PGID --tz $TZNAME
tools/bench/run.sh run --name constrained-1g --image "$IMAGE" --archive "$ARCHIVE" \
  --data "$BENCH/data-1g" --cache warm --puid $PUID --pgid $PGID --tz $TZNAME

# 5. the table
node tools/bench/report.js bench-runs/baseline-* bench-runs/constrained-* --out bench-runs/phase0.md

# 6. the installed app back on
docker start sentry-six-manager
```

Each run takes as long as the first index plus 30 minutes. A run's data
folder can be deleted afterwards (`sudo rm -rf "$BENCH"/data-*`); the
archive was never writable to it.

What to look at in the constrained runs:

- **Slowdown**: "First index complete" against the baseline.
- **Swap**: "Swap used, peak". `--memory` without `--memory-swap` lets
  Docker add as much swap as memory where the host has swap; a host without
  swap shows 0 and goes straight to OOM kills.
- **OOM**: "OOM kills (cgroup)" counts every process the kernel killed in
  the container (often an ffprobe or the app itself, which the supervisor
  restarts: "App restarts"); `OOMKilled` is Docker's flag for the container.
  `final.json` and `container.log` say what happened.

### Diagnostic run (separately, never with the limits)

```sh
tools/bench/run.sh run --name diagnostic --image "$IMAGE" --archive "$ARCHIVE" \
  --data "$BENCH/data-diag" --cache warm --puid $PUID --pgid $PGID --tz $TZNAME --keep
```

`memlog.js` is mounted read-only into the container and loaded into both
Node processes with
`NODE_OPTIONS=--require=/bench/memlog.js --heapsnapshot-signal=SIGUSR2 --diagnostic-dir=/data/bench-diag`.
It writes `process.memoryUsage()` (rss, heapUsed, external, arrayBuffers)
every 5 s to `/data/bench-diag/memlog.<role>.<pid>.jsonl`; the run copies
`/data/bench-diag` to `<run>/diag/` at the end. With `--keep` the container
stays up, so a heap snapshot can be taken when memory is high:

```sh
tools/bench/run.sh heapsnapshot --container manager-baseline   # writes Heap...heapsnapshot into $BENCH/data-diag/bench-diag/
tools/bench/run.sh stop --container manager-baseline
```

Open the `.heapsnapshot` in Chrome DevTools (Memory tab, Load). The
preload and snapshots cost memory themselves: do not compare the
diagnostic run's numbers with the others (`heapsnapshot` refuses a
container that is not a diagnostic run, as `SIGUSR2` would end it).

### Cold cache on ZFS

`drop_caches` empties Linux's page cache, not ZFS's ARC, so on TrueNAS a
"cold" run is only cold for the page cache (`meta.json` says so). For a
really cold run, reboot the host (or export and import the pool) first and
start with `--cache cold`.

## Phase 3: stock against new

Build the new image from the commit to measure, with a tag that is not
`latest`:

```sh
git checkout <commit>            # e.g. release/next-update
docker build -t sentry-manager:bench-new .
```

Then repeat the Phase 0 runs with `IMAGE=sentry-manager:bench-new` and
fresh data folders (a local build has no registry digest: the run records
its image id instead), in the same order and with the same cache states,
and put both in one table:

```sh
node tools/bench/report.js bench-runs/baseline-<stock cold> bench-runs/baseline-<new cold> \
  bench-runs/baseline-<stock warm> bench-runs/baseline-<new warm> \
  bench-runs/constrained-2g-<stock> bench-runs/constrained-2g-<new> \
  bench-runs/constrained-1g-<stock> bench-runs/constrained-1g-<new> --out bench-runs/phase3.md
```

Each column's "Image" row says which is which. Compare like with like:
same cache state, same limits, nothing else running.

## Without Docker: clipMemory.js

```sh
node tools/bench/clipMemory.js [--sizes 10,30,60] [--concurrency 1,4] [--json out.json]
```

Makes three synthetic Tesla-like front-camera clips once (60 s, 36 fps,
1280×960, a telemetry record per frame; about 10, 30 and 60 MB) and runs
`readSamples` (speed index) and the telemetry reader (full read in a worker
thread) on each, one at a time and four at once, each case in its own
process. It prints peak rss, arrayBuffers and heapUsed (and the telemetry
worker's heap and external memory). Run it before and after a change to
those two files.

## Tests

`test/bench.test.js` runs with `npm test`: the parsing of `docker stats`,
`/proc` and cgroup (v2 and v1) output, CSV, the report, the first-index
rule, and `run.sh`'s refusals in dry-run mode. None of it needs Docker.
