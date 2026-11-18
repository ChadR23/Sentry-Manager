# Development

[← Back to the README](../README.md)

The server is written in Rust (`lean/`): two programs, the root supervisor
(`sentry-lean-supervisor`) and the app it runs unprivileged (`sentry-lean`).
The pages it serves are the same files as before (`web/`, `src/renderer`,
`examples/ui-packs`). The Node.js server it replaced (`server/`, `src/main/`)
is still in the repository while the Rust one settles in: it is the reference
the Rust server is checked against, and `Dockerfile.node` still builds it.

You need Rust (stable), ffmpeg, and Node.js 22.13 or newer for the checks
against the Node code.

```bash
cd lean && cargo test --release
cd lean && cargo build --release
DATA_PATH=./data FOOTAGE_PATH=/path/to/TeslaCam APP_ROOT=$PWD/.. lean/target/release/sentry-lean
docker build -t ghcr.io/skittles-fivem/sentry-manager:latest .
```

The Node server and its tests:

```bash
mkdir -p build && gcc -O2 -o build/noreplace-rename native/noreplace-rename.c
npm test
DATA_PATH=./data FOOTAGE_PATH=/path/to/TeslaCam SENTRY_NOREPLACE_RENAME=build/noreplace-rename npm start
docker build -f Dockerfile.node -t sentry-manager:node .
```

| Folder | |
| --- | --- |
| `lean/` | The Rust server: one module per area (core, footage, viewer, converter, CAN, ops, ui, helper servers, supervisor); `lean/PORT_PLAN.md` says what each holds and how it was checked, `lean/parity/` the scripts that compare it with the Node server |
| `web/` | The web pages, and the shim that runs Sentry Studio in the browser |
| `src/` | Sentry Studio's viewer (`renderer`, `shared`), served as they are; the Node converter (`main/converter`) |
| `server/` | The Node.js server (the reference the Rust server is checked against) |
| `native/` | The no-replace rename helper the Node server uses for safe replacement (the Rust server calls renameat2 itself) |
| `test/` | The Node tests (`node --test`), including real conversions with telemetry checks |
| `tools/contract/` | The API contract ([`api-contract.md`](api-contract.md)): every route and page call read from the source, and goldens recorded from a running server to check another one answers the same ([how](../tools/contract/README.md)) |
| `tools/bench/` | Measurement runs of an image on a real archive, read-only ([how](../tools/bench/README.md)) |
