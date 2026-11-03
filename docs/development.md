# Development

[← Back to the README](../README.md)

Node.js 22.13 or newer (the server uses only Node's built-in modules,
including `node:sqlite`) and ffmpeg.

```bash
mkdir -p build && gcc -O2 -o build/noreplace-rename native/noreplace-rename.c
npm test
DATA_PATH=./data FOOTAGE_PATH=/path/to/TeslaCam SENTRY_NOREPLACE_RENAME=build/noreplace-rename npm start
docker build -t ghcr.io/skittles-fivem/sentry-manager:latest .
```

| Folder | |
| --- | --- |
| `server/` | The web server, the root supervisor, shares, Recycle Bin, policies, jobs |
| `web/` | The web pages, and the shim that runs Sentry Studio in the browser |
| `src/` | Sentry Studio's viewer (`renderer`, `shared`) and converter (`main/converter`); the few web-version changes are commented where they are (telemetry from the server, keeping the cameras together, the HW3 / HW4 layout, the benchmark's levels) |
| `native/` | The no-replace rename helper for safe replacement |
| `test/` | Tests (`node --test`), including real conversions with telemetry checks |
