# Sentry Six Manager: the Sentry Studio viewer and converter as a web app, plus
# footage management, on port 9000. The server is the Rust port (lean/): two
# binaries, the root supervisor and the app it runs unprivileged. The pages
# (web/, the Studio pages, the interface packs) are the same files as before.
#
#   docker build -t ghcr.io/skittles-fivem/sentry-manager:latest .
#
# The Node.js image this replaces is Dockerfile.node, kept while the Rust
# image is tested.
#
# Behind a proxy that inspects TLS, hand the build its certificates (used for
# the downloads only, never kept in the image):
#   docker build --secret id=build_ca,src=/path/to/ca-bundle.crt -t ... .

# ---- the two binaries, for this machine's architecture (glibc, like the image)
FROM rust:1.97-slim-trixie AS build
ARG CARGO_BUILD_JOBS=4
WORKDIR /src/lean
COPY lean/Cargo.toml lean/Cargo.lock ./
# the dependencies first, in a layer of their own (a change to src/ does not fetch them again)
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export CARGO_HTTP_CAINFO=/run/secrets/build_ca; fi \
 && mkdir -p src/supervisor && echo 'fn main() {}' > src/main.rs && echo 'fn main() {}' > src/supervisor/bin.rs && touch src/lib.rs \
 && cargo build --release --locked -j "$CARGO_BUILD_JOBS" \
 && rm -rf src target/release/deps/sentry_lean* target/release/.fingerprint/sentry-lean* \
      target/release/sentry-lean target/release/sentry-lean-supervisor
COPY lean/src ./src
RUN cargo build --release --locked --offline -j "$CARGO_BUILD_JOBS" \
 && cp target/release/sentry-lean target/release/sentry-lean-supervisor /

# Debian 13: every package below gets Debian security updates.
FROM debian:trixie-slim

# jellyfin-ffmpeg  FFmpeg kept current by the Jellyfin team: libx265 / SVT-AV1
#                  plus NVENC, VA-API (AMD incl. APUs, Intel), QSV and AMF, with
#                  its own VA-API drivers and vainfo. From Jellyfin's signed
#                  repository; jellyfin.gpg is their key, fingerprint
#                  4918 AABC 486C A052 358D 778D 4902 3CD0 1DE2 1A7B.
# cifs-utils       mounting the vehicles' SMB shares (the root supervisor)
# fonts            for burned-in timestamps / dashboards in exports
# tini             reaps ffmpeg children and forwards signals
# openssl          the local HTTPS certificate authority
# util-linux       setpriv: the app runs unprivileged (the supervisor)
COPY jellyfin.gpg /etc/apt/keyrings/jellyfin.gpg
# The release build passes the week (like 2026-W43): a release in a new week
# runs this step again instead of reusing the build cache, so it really
# fetches the packages' latest security fixes.
ARG APT_REFRESH=""
RUN --mount=type=secret,id=build_ca,required=false \
    set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    # (apt downloads as its own user, which cannot read the secret: a copy for
    # this step only, removed below with its setting)
    if [ -s /run/secrets/build_ca ]; then \
      install -m 644 /run/secrets/build_ca /tmp/build-ca.crt; \
      printf 'Acquire::https::CaInfo "/tmp/build-ca.crt";\n' > /etc/apt/apt.conf.d/99build-ca; fi; \
    echo "packages as of ${APT_REFRESH:-now}"; \
    apt-get update; \
    # Debian security fixes released since the base image was published
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates; \
    printf 'Types: deb\nURIs: https://repo.jellyfin.org/debian\nSuites: trixie\nComponents: main\nSigned-By: /etc/apt/keyrings/jellyfin.gpg\n' \
      > /etc/apt/sources.list.d/jellyfin.sources; \
    apt-get update; \
    # FFmpeg 8 when Jellyfin publishes it for this release, else their 7.x
    ffmpeg_pkg=jellyfin-ffmpeg8; apt-cache show "$ffmpeg_pkg" >/dev/null 2>&1 || ffmpeg_pkg=jellyfin-ffmpeg7; \
    apt-get install -y --no-install-recommends "$ffmpeg_pkg" cifs-utils tini tzdata \
      fontconfig fonts-liberation fonts-dejavu-core openssl util-linux xz-utils; \
    ln -s /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/lib/jellyfin-ffmpeg/ffprobe /usr/lib/jellyfin-ffmpeg/vainfo /usr/local/bin/; \
    rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99build-ca /tmp/build-ca.crt; \
    # no setuid/setgid programs: nothing inside can become root again (the
    # root supervisor runs mount.cifs as root anyway)
    find / -xdev -perm /6000 -type f -exec chmod a-s {} +

# the supervisor starts the app from its own folder
COPY --from=build /sentry-lean /sentry-lean-supervisor /usr/local/bin/

ENV PORT=9000 \
    PUID=1000 \
    PGID=1000 \
    APP_ROOT=/app \
    DATA_PATH=/data \
    FOOTAGE_ROOT=/footage \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility

WORKDIR /app
COPY version.json CRITICAL_UPDATE.txt ./
# the license and the notices of what keeps its own license (NOTICE), with the code
COPY LICENSE NOTICE ./
COPY assets ./assets
# the pages: the built-in interface, the Studio pages and their shared code
COPY web ./web
COPY src/renderer ./src/renderer
COPY src/shared ./src/shared
# the CAN signal sets the server decodes with
COPY server/dbc ./server/dbc
# the interface packs that come with the app (Settings > Interface)
COPY examples/ui-packs ./ui-packs

# Set by the release build (.github/workflows/image.yml); IMAGE and
# IMAGE_TAG let Settings > Updates check the registry for a newer image.
# BUILD_NUMBER is the Image workflow's run number ("Build N" in the app); a
# local build has none, and then "build" is left out.
ARG GIT_SHA=""
ARG GIT_BRANCH=""
ARG BUILD_DATE=""
ARG IMAGE=""
ARG IMAGE_TAG=""
ARG BUILD_NUMBER=""
RUN build=""; case "$BUILD_NUMBER" in ''|0*|*[!0-9]*) ;; *) build=",\"build\":$BUILD_NUMBER" ;; esac; \
    printf '{"sha":"%s","branch":"%s","builtAt":"%s","image":"%s","tag":"%s"%s}\n' "$GIT_SHA" "$GIT_BRANCH" \
      "${BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" "$IMAGE" "$IMAGE_TAG" "$build" > /app/BUILD_INFO.json

# Two malloc arenas for the server (the app drops it from its environment at
# start, so ffmpeg keeps glibc's default).
ENV MALLOC_ARENA_MAX=2

VOLUME ["/data"]
EXPOSE 9000
# the device port (CAN_PORT): the CAN Bridge's uploads and the Sentry USB link,
# only while one of them is in use
EXPOSE 10000
# /healthz answers on plain HTTP too (everything else there redirects to HTTPS)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD ["/usr/local/bin/sentry-lean-supervisor", "healthcheck"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/sentry-lean-supervisor"]
