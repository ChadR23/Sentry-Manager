# The lean backend's image: one static binary on Alpine, the stock UI's files
# beside it, and ffmpeg (thumbnails made from clips; without it there are none,
# as on the Node server). Built from the repository root:
#
#   docker build -f lean/Dockerfile -t sentry-lean .
#   docker build -f lean/Dockerfile --build-arg FFMPEG=0 -t sentry-lean:slim .   (no ffmpeg: 26 MB, 205 MB with it)
#
# (lean/Dockerfile.dockerignore keeps the context to what the build needs.)
# Behind a proxy that inspects TLS, hand the build its certificates (used for the
# downloads only, not kept in the image): --secret id=build_ca,src=/path/to/ca-bundle.crt
#
# There is no sign-in yet, so the server listens on loopback only: inside the
# container that is the container's own loopback, which nothing outside can
# reach. To try it on this machine, share the host's network and it listens
# on the host's loopback:
#
#   docker run --rm --network host -e PORT=9000 -e VEHICLE_NAME="My car" \
#     -v /path/to/footage:/footage:ro -v sentry-lean-data:/data sentry-lean
#   curl http://127.0.0.1:9000/healthz
#
# Accounts come with HTTPS, never passwords over plain HTTP (lean/README.md).
# The footage is mounted read-only: the lean server never writes to it.

FROM rust:1.97-slim-trixie AS build
ARG CARGO_BUILD_JOBS=2
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi \
 && apt-get update && apt-get install -y --no-install-recommends musl-tools && rm -rf /var/lib/apt/lists/* \
 && rustup target add x86_64-unknown-linux-musl
WORKDIR /src/lean
COPY lean/Cargo.toml lean/Cargo.lock ./
# the dependencies first, in a layer of their own (a change to src/ does not fetch them again)
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export CARGO_HTTP_CAINFO=/run/secrets/build_ca; fi \
 && mkdir src && echo 'fn main() {}' > src/main.rs && touch src/lib.rs \
 && cargo build --release --locked --target x86_64-unknown-linux-musl -j "$CARGO_BUILD_JOBS" \
 && rm -rf src target/x86_64-unknown-linux-musl/release/deps/sentry_lean* target/x86_64-unknown-linux-musl/release/.fingerprint/sentry-lean*
COPY lean/src ./src
RUN cargo build --release --locked --offline --target x86_64-unknown-linux-musl -j "$CARGO_BUILD_JOBS"

FROM alpine:3.22
ARG FFMPEG=1
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi \
 && if [ "$FFMPEG" = "1" ]; then apk add --no-cache ffmpeg; fi \
 && mkdir -p /data && chown 1000:1000 /data
COPY --from=build /src/lean/target/x86_64-unknown-linux-musl/release/sentry-lean /usr/local/bin/sentry-lean
COPY web /app/web
COPY src/renderer /app/src/renderer
COPY src/shared /app/src/shared
COPY assets /app/assets
ENV APP_ROOT=/app DATA_PATH=/data PORT=9000 HOST=127.0.0.1 FOOTAGE_PATH=/footage
VOLUME ["/data"]
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
ENTRYPOINT ["/usr/local/bin/sentry-lean"]
