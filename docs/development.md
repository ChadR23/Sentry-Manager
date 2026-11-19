# Development

[← Back to the README](../README.md)

The server is written in Rust (`lean/`): two programs, the root supervisor
(`sentry-lean-supervisor`) and the app it runs unprivileged (`sentry-lean`).
The pages it serves are plain JavaScript files (`web/`, `src/renderer`,
`src/shared`, `examples/ui-packs`), served as they are. The Node.js server
the Rust one replaced was removed once its answers were frozen as reference
files, which the tests now compare with (`lean/PORT_PLAN.md`, "Node removed").

You need Rust (stable) and ffmpeg. Node.js 22 or newer runs the API contract
check, the dev tools' tests and two test stand-ins (no packages, nothing of
the old server).

The frozen answers were recorded with Ubuntu 24.04's ffmpeg 6.1.1, and CI runs
the Rust tests there. With another ffmpeg the conversion test leaves out the
output digests, and the verifier test can differ where ffprobe does (ffmpeg 8's
exits 0 on a damaged file where 6.1's exits 1).

```bash
cd lean && cargo test --release --locked     # before every push
cd lean && cargo build --release
node tools/contract/frozen.js                # the whole API contract against the frozen answers
node --test "tools/**/*.test.js"             # the dev tools and the image workflow
DATA_PATH=./data FOOTAGE_PATH=/path/to/TeslaCam APP_ROOT=$PWD/.. lean/target/release/sentry-lean
docker build -t ghcr.io/skittles-fivem/sentry-manager:latest .
```

| Folder | |
| --- | --- |
| `lean/` | The Rust server: one module per area (core, footage, viewer, converter, CAN, ops, ui, helper servers, supervisor); `lean/PORT_PLAN.md` says what each holds and how it was checked; `lean/tests/fixtures/` the Node server's frozen answers |
| `web/` | The web pages, and the shim that runs Sentry Studio in the browser |
| `src/` | Sentry Studio's viewer (`renderer`, `shared`), served as they are |
| `dbc/` | The CAN signal sets the server decodes CAN Bridge logs with |
| `tools/contract/` | The API contract ([`api-contract.md`](api-contract.md)) and the check against the frozen answers, or between two running servers ([how](../tools/contract/README.md)) |
| `tools/bench/` | Measurement runs of an image on a real archive, read-only ([how](../tools/bench/README.md)) |
