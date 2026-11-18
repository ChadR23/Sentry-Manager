#!/usr/bin/env bash
# Sentry Six Manager measurement runs (tools/bench/README.md has the steps).
#
#   tools/bench/run.sh run --name baseline|constrained-2g|constrained-1g|diagnostic \
#       --image ghcr.io/skittles-fivem/sentry-manager@sha256:<digest> \
#       --archive /path/to/TeslaCam-parent --data /path/to/new/empty/folder \
#       --cache warm|cold [options]
#   tools/bench/run.sh heapsnapshot [--container manager-baseline]   (diagnostic runs only)
#   tools/bench/run.sh stop         [--container manager-baseline]
#
# Options for run:
#   --container NAME     default manager-baseline
#   --port N             host port for the web UI (default 9100; the installed app uses 9000)
#   --device-port N      host port for the device port (default 10100)
#   --idle-min N         minutes of idle after the first index (default 30)
#   --max-index-min N    give up waiting for the first index after N minutes (default 720)
#   --out DIR            where run folders go (default ./bench-runs)
#   --puid N --pgid N    the app's user (default 1000:1000; must be able to read the archive)
#   --tz ZONE            the car's time zone (default UTC)
#   --force-latest       allow an image that follows :latest (not pinned)
#   --allow-other        start although another Sentry Six Manager container runs
#   --keep               leave the container running at the end
#   --dry-run            the checks that need no Docker, and the commands it would run
#
# Safety: the archive is only ever mounted read-only (:ro), and the run stops
# before the container starts if docker inspect shows anything else; the data
# folder must be new or empty; the ports must be free; the container name
# must be unused.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/lib.js"
ARCHIVE_DEST=/footage/car

die() { echo "run.sh: $*" >&2; exit 1; }
say() { echo "[$(date +%H:%M:%S)] $*"; }

cmd="${1:-}"
[ -n "$cmd" ] && shift || true

NAME="" IMAGE="" ARCHIVE="" DATA="" CACHE="" CONTAINER=manager-baseline PORT=9100 DPORT=10100
IDLE_MIN=30 MAX_INDEX_MIN=720 OUT="./bench-runs" PUID=1000 PGID=1000 TZ_NAME=UTC
FORCE_LATEST=0 ALLOW_OTHER=0 KEEP=0 DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --archive) ARCHIVE="$2"; shift 2 ;;
    --data) DATA="$2"; shift 2 ;;
    --cache) CACHE="$2"; shift 2 ;;
    --container) CONTAINER="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --device-port) DPORT="$2"; shift 2 ;;
    --idle-min) IDLE_MIN="$2"; shift 2 ;;
    --max-index-min) MAX_INDEX_MIN="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --puid) PUID="$2"; shift 2 ;;
    --pgid) PGID="$2"; shift 2 ;;
    --tz) TZ_NAME="$2"; shift 2 ;;
    --force-latest) FORCE_LATEST=1; shift ;;
    --allow-other) ALLOW_OTHER=1; shift ;;
    --keep) KEEP=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

# ---- heapsnapshot / stop

if [ "$cmd" = heapsnapshot ]; then
  # SIGUSR2 ends a Node process that was not started with --heapsnapshot-signal:
  # only send it to a diagnostic container
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" | grep -q -- '--heapsnapshot-signal=SIGUSR2' \
    || die "$CONTAINER is not a diagnostic run (no --heapsnapshot-signal in NODE_OPTIONS); not sending SIGUSR2"
  docker exec -u 0 "$CONTAINER" sh -c 'for d in /proc/[0-9]*; do if tr "\000" " " < $d/cmdline 2>/dev/null | grep -q "server/index.js"; then kill -USR2 ${d#/proc/} && echo "SIGUSR2 sent to server/index.js (pid ${d#/proc/})"; fi; done'
  echo "The snapshot appears in <data>/bench-diag/ when it is written (seconds for a large heap)."
  exit 0
fi
if [ "$cmd" = stop ]; then
  docker stop -t 60 "$CONTAINER" >/dev/null && docker rm "$CONTAINER" >/dev/null && echo "stopped and removed $CONTAINER"
  exit 0
fi
[ "$cmd" = run ] || die "usage: run.sh run|heapsnapshot|stop ... (see --help)"

# ---- checks that need no Docker

command -v node >/dev/null || die "node is needed on the host (Node 22 or newer)"
case "$NAME" in baseline|constrained-2g|constrained-1g|diagnostic) ;; *) die "--name must be baseline, constrained-2g, constrained-1g or diagnostic" ;; esac
case "$CACHE" in warm|cold) ;; *) die "--cache warm|cold is required (it is recorded with the numbers)" ;; esac
[ -n "$IMAGE" ] || die "--image is required (pin a digest: image@sha256:...)"
latest_flag=""; [ "$FORCE_LATEST" = 1 ] && latest_flag="--force-latest"
IMAGE_KIND="$(node "$LIB" check-image "$IMAGE" $latest_flag)" || die "refusing the image"

[ -n "$ARCHIVE" ] && [ -d "$ARCHIVE" ] || die "--archive must be an existing folder (the one holding TeslaCam, or RecentClips/SentryClips/SavedClips)"
ARCHIVE="$(cd "$ARCHIVE" && pwd -P)"
[ -n "$DATA" ] || die "--data is required: a new (or empty) folder for this run only"
case "$DATA" in /*) ;; *) DATA="$PWD/$DATA" ;; esac
if [ -e "$DATA" ]; then
  [ -d "$DATA" ] || die "$DATA exists and is not a folder"
  [ -z "$(ls -A "$DATA")" ] || die "$DATA is not empty: every run starts from a fresh data folder (never the installed app's data)"
fi
DATA_PARENT="$(cd "$(dirname "$DATA")" 2>/dev/null && pwd -P || true)"
[ -n "$DATA_PARENT" ] || die "the parent folder of $DATA does not exist"
DATA="$DATA_PARENT/$(basename "$DATA")"
node "$LIB" inside "$DATA" "$ARCHIVE" && die "the data folder must not be inside the archive"
node "$LIB" inside "$ARCHIVE" "$DATA" && die "the archive must not be inside the data folder"
case "$PORT$DPORT" in *[!0-9]*) die "ports must be numbers" ;; esac

port_busy() {
  if command -v ss >/dev/null; then ss -Hltn "sport = :$1" 2>/dev/null | grep -q . && return 0; fi
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0
  return 1
}
for p in "$PORT" "$DPORT"; do port_busy "$p" && die "port $p is in use (the installed app uses 9000/10000; choose others or stop it)"; done

PROFILE_ARGS=()
case "$NAME" in
  constrained-2g) PROFILE_ARGS=(--cpus=4 --memory=2g) ;;
  constrained-1g) PROFILE_ARGS=(--memory=1g) ;;
esac
PROFILE_NOTE="$(node -e "console.log(require('$LIB').RUN_PROFILES['$NAME'].note)")"

case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN="$OUT/$NAME-$STAMP"
node "$LIB" inside "$OUT" "$ARCHIVE" && die "the run folders (--out) must not be inside the archive"

DOCKER_ARGS=(
  --name "$CONTAINER" --restart no --stop-timeout 60
  -p "$PORT:9000" -p "$DPORT:10000"
  --env-file "$RUN/bench.env"
  -v "$DATA:/data"
  -v "$ARCHIVE:$ARCHIVE_DEST:ro"
  --cap-drop ALL
  --cap-add SYS_ADMIN --cap-add DAC_READ_SEARCH --cap-add DAC_OVERRIDE --cap-add SETUID
  --cap-add SETGID --cap-add SETPCAP --cap-add CHOWN --cap-add KILL
  --security-opt no-new-privileges:true --security-opt apparmor=unconfined
  "${PROFILE_ARGS[@]}"
)
if [ "$NAME" = diagnostic ]; then
  DOCKER_ARGS+=(-v "$HERE/memlog.js:/bench/memlog.js:ro")
fi

if [ "$DRY" = 1 ]; then
  echo "checks passed (image: $IMAGE_KIND; archive: $ARCHIVE read-only at $ARCHIVE_DEST; data: $DATA; ports $PORT/$DPORT free)"
  echo "run folder: $RUN"
  echo "would run:"
  echo "  docker pull $IMAGE"
  echo "  docker create ${DOCKER_ARGS[*]} <image pinned by digest>"
  echo "  docker inspect $CONTAINER   -> refuse unless $ARCHIVE_DEST is RW=false"
  [ "$CACHE" = cold ] && echo "  sync; echo 3 > /proc/sys/vm/drop_caches   (as root)"
  echo "  docker start $CONTAINER; sampler every 5 s; first index; $IDLE_MIN min idle; API timings after the index and at the end"
  [ "$NAME" = diagnostic ] && echo "  NODE_OPTIONS=--require=/bench/memlog.js --heapsnapshot-signal=SIGUSR2 --diagnostic-dir=/data/bench-diag"
  exit 0
fi

# ---- checks that need Docker

command -v docker >/dev/null || die "docker is needed"
docker info >/dev/null 2>&1 || die "cannot reach the Docker daemon (sudo, or add yourself to the docker group)"
docker container inspect "$CONTAINER" >/dev/null 2>&1 && die "a container named $CONTAINER exists already (tools/bench/run.sh stop --container $CONTAINER)"
docker ps --format '{{.Ports}}' | grep -Eq "(:|^)($PORT|$DPORT)->" && die "a container publishes port $PORT or $DPORT already"
OTHERS="$(docker ps --format '{{.Names}} {{.Image}}' | grep -i 'sentry-manager' || true)"
if [ -n "$OTHERS" ] && [ "$ALLOW_OTHER" != 1 ]; then
  die "another Sentry Six Manager container runs (it shares CPU, disk and page cache with the run):
$OTHERS
stop it (docker stop <name>) or pass --allow-other, which is recorded"
fi

say "pulling $IMAGE"
if ! docker pull "$IMAGE" >/dev/null 2>&1; then
  # a local build (Phase 3: docker build -t sentry-manager:bench-new .) is not in a registry
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "cannot pull $IMAGE and there is no local image of that name"
  say "using the local image $IMAGE (not in a registry)"
fi
IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$IMAGE")"
REPO="${IMAGE%@*}"; REPO="${REPO%:*}"
DIGEST="$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE" | grep -F "$REPO@" | head -1 || true)"
case "$IMAGE" in *@sha256:*) [ "${DIGEST#*@}" = "${IMAGE#*@}" ] || die "pulled digest ${DIGEST#*@} differs from the one asked for" ;; esac
# a local build has no registry digest: it runs, and is recorded, by its image id
[ -n "$DIGEST" ] || DIGEST="$IMAGE_ID"
BUILD_INFO="$(docker run --rm --network none --entrypoint cat "$DIGEST" /app/BUILD_INFO.json 2>/dev/null || echo null)"

mkdir -p "$RUN" "$DATA"
umask 077
PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
{
  echo "UI_USERNAME=bench"
  echo "UI_PASSWORD=$PASSWORD"
  echo "FOOTAGE_PATH=$ARCHIVE_DEST"
  echo "VEHICLE_NAME=Bench car"
  echo "TZ=$TZ_NAME"
  echo "PUID=$PUID"
  echo "PGID=$PGID"
  echo "UPDATE_CHECK=off"
  if [ "$NAME" = diagnostic ]; then
    echo "NODE_OPTIONS=--require=/bench/memlog.js --heapsnapshot-signal=SIGUSR2 --diagnostic-dir=/data/bench-diag"
    echo "MEMLOG_FILE=/data/bench-diag/memlog"
  fi
} > "$RUN/bench.env"
umask 022

# ---- create, check the mount, then start

say "creating $CONTAINER"
docker create "${DOCKER_ARGS[@]}" "$DIGEST" >/dev/null
docker inspect "$CONTAINER" > "$RUN/inspect.json"
if ! node "$LIB" check-mount "$RUN/inspect.json" "$ARCHIVE_DEST"; then
  docker rm "$CONTAINER" >/dev/null
  die "the archive is not mounted read-only; nothing was started"
fi

CACHE_DETAIL="$CACHE"
if [ "$CACHE" = cold ]; then
  say "dropping the page cache (cold run)"
  if [ "$(id -u)" = 0 ]; then sync; echo 3 > /proc/sys/vm/drop_caches
  else sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null; fi
  CACHE_DETAIL="cold (page cache dropped)"
  if grep -q '^zfs ' /proc/modules 2>/dev/null; then
    CACHE_DETAIL="cold (page cache dropped; ZFS ARC not dropped, see README)"
  fi
fi

export RUN_NAME="$NAME" RUN_IMAGE="$IMAGE" RUN_DIGEST="$DIGEST" RUN_IMAGE_ID="$IMAGE_ID" RUN_BUILD_INFO="$BUILD_INFO" RUN_CACHE="$CACHE_DETAIL" \
  RUN_NOTE="$PROFILE_NOTE" RUN_ARCHIVE="$ARCHIVE" RUN_DATA="$DATA" RUN_CONTAINER="$CONTAINER" RUN_PORT="$PORT" RUN_DPORT="$DPORT" \
  RUN_PROFILE_ARGS="${PROFILE_ARGS[*]:-}" RUN_ALLOW_OTHER="$ALLOW_OTHER" RUN_OTHERS="$OTHERS" RUN_IDLE_MIN="$IDLE_MIN" \
  RUN_DOCKER_VERSION="$(docker version -f '{{.Server.Version}}' 2>/dev/null || echo ?)"
node -e '
const os = require("os"); const e = process.env;
let build = null; try { build = JSON.parse(e.RUN_BUILD_INFO); } catch {}
const meta = {
  name: e.RUN_NAME, image: e.RUN_IMAGE, imageDigest: e.RUN_DIGEST, imageId: e.RUN_IMAGE_ID, buildInfo: build,
  cache: e.RUN_CACHE, profileNote: e.RUN_NOTE, profileArgs: e.RUN_PROFILE_ARGS, archive: e.RUN_ARCHIVE, archiveMount: "read-only",
  data: e.RUN_DATA, container: e.RUN_CONTAINER, ports: [Number(e.RUN_PORT), Number(e.RUN_DPORT)], idleMinutes: Number(e.RUN_IDLE_MIN),
  otherContainers: e.RUN_ALLOW_OTHER === "1" ? e.RUN_OTHERS : "",
  host: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memBytes: os.totalmem(), kernel: os.release(), docker: e.RUN_DOCKER_VERSION },
  createdAt: new Date().toISOString()
};
require("fs").writeFileSync(process.argv[1], JSON.stringify(meta, null, 2) + "\n");
' "$RUN/meta.json"

BG=()
cleanup() {
  for p in "${BG[@]:-}"; do [ -n "$p" ] && kill -TERM "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT

echo startup > "$RUN/phase"
say "starting $CONTAINER (run folder $RUN)"
docker start "$CONTAINER" >/dev/null
T0="$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER")"
docker logs -f --timestamps "$CONTAINER" > "$RUN/container.log" 2>&1 &
BG+=($!)
node "$HERE/sample.js" --container "$CONTAINER" --out "$RUN" --interval 5 --phase-file "$RUN/phase" --puid "$PUID" &
SAMPLER=$!
BG+=($SAMPLER)

alive() { [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]; }

# the CA the app made in its fresh data folder: the only certificate trusted
for _ in $(seq 1 120); do
  docker exec "$CONTAINER" cat /data/tls/ca.crt > "$RUN/ca.crt" 2>/dev/null && [ -s "$RUN/ca.crt" ] && break
  alive || break
  sleep 1
done
[ -s "$RUN/ca.crt" ] || say "no certificate authority in /data/tls yet (TLS off?); the API steps will fail"

URL="https://localhost:$PORT"
API=(--url "$URL" --ca "$RUN/ca.crt" --env-file "$RUN/bench.env" --out "$RUN")
status=0
if node "$HERE/latency.js" wait-ready "${API[@]}" --timeout-min 5; then
  echo indexing > "$RUN/phase"
  say "waiting for the first index (inventory scan + speed index)"
  node "$HERE/latency.js" watch-index "${API[@]}" --t0 "$T0" --interval 5 --timeout-min "$MAX_INDEX_MIN" || status=$?
  if alive; then
    echo idle > "$RUN/phase"
    say "API timings after the index"
    node "$HERE/latency.js" measure "${API[@]}" --phase after-index || status=$?
    say "idle for $IDLE_MIN min"
    end=$(( $(date +%s) + IDLE_MIN * 60 ))
    while [ "$(date +%s)" -lt "$end" ] && alive; do sleep 15; done
    if alive; then
      say "API timings at the end of idle"
      node "$HERE/latency.js" measure "${API[@]}" --phase end-of-idle || status=$?
    fi
  fi
else
  status=1
fi
alive || say "the container stopped (OOMKilled: $(docker inspect -f '{{.State.OOMKilled}}' "$CONTAINER" 2>/dev/null))"
echo done > "$RUN/phase"

# the sampler writes final.json (the container's last State) when it ends
kill -TERM "$SAMPLER" 2>/dev/null || true
wait "$SAMPLER" 2>/dev/null || true
docker inspect "$CONTAINER" > "$RUN/inspect-end.json" 2>/dev/null || true
if [ "$NAME" = diagnostic ]; then
  mkdir -p "$RUN/diag"
  docker cp "$CONTAINER:/data/bench-diag/." "$RUN/diag/" 2>/dev/null || cp -r "$DATA/bench-diag/." "$RUN/diag/" 2>/dev/null || true
fi
if [ "$KEEP" != 1 ]; then
  say "stopping $CONTAINER"
  docker stop -t 60 "$CONTAINER" >/dev/null 2>&1 || true
  docker rm "$CONTAINER" >/dev/null 2>&1 || true
fi
node "$HERE/report.js" "$RUN" --out "$RUN/report.md" || true
say "done: $RUN/report.md"
exit "$status"
