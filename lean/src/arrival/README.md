# arrival: Sentry USB checksums

Ports `server/originalChecksums.js` (the share's checksum record),
`server/arrivalChecksums.js` (every arrived clip gets a line), the converter's
before-replace hook as index.js wires it, Sentry USB's `holds` rule
(`server/sentryUsb.js` interpret / inRange / holds) and the route logic of
`GET /api/vehicles/:id/sentry-usb` (its `record` field),
`POST /api/vehicles/:id/sentry-usb/record` and the vehicle removal.

Library only: nothing here is mounted, no route answers and nothing is
written until the integrator wires it.

## Files it writes (byte for byte Node's)

- `<share root>/.sentrymanager/original-checksums.sha256`: one
  `"<64 lowercase hex>  <relpath>\n"` per clip, appended with O_APPEND,
  fsynced (the folder too when new); a torn last line gets a line break first.
  The share root is the folder above RecentClips / SentryClips / SavedClips /
  TeslaTrackMode (the vehicle folder or its TeslaCam/), only inside a vehicle's
  folder (`allowed_root`).
- `<share root>/.sentrymanager/original-checksums.marks.json`:
  `{"v":1,"marks":[{"day":"YYYY-MM-DD","offset":N}]}`, written atomically
  (dot-named temp, fsync, rename, folder fsync); lines older than 45 days are
  pruned the same way once the oldest dropped day is 52 days old.
- `<DATA>/arrival-checksums/<vehicle id, [^A-Za-z0-9_-] as _>.json` (snapshot
  `{"v":2,"dirs":{...}}`, JS key order) and `.log` (journal, one JSON array a
  line), the same thresholds (save every 25 hashed, compact past
  max(2000, entries / 2)).

Nothing is written on a share without a `.sentryusb/` folder at its root.

## Hookup for the integrator

1. `ArrivalCtx` (`ctx.rs`) on core's AppState:
   - `vehicles` / `vehicle` / `root_of` / `vehicle_for_path`: vehicles.js.
   - `inventory(vid)`: the last scan's files, every kind, with **birth time**
     (`statx`; the lean scanner does not keep it yet: add
     `birthtime_ms` to `scanner::FileEntry`, or 0 where there is none, then
     ctime is used) and `scanning`.
   - `codec(vid, rel)`: the catalog's codec for that size and mtime.
   - `holds(abs)`: from the Sentry USB link's status (can/ area) via
     `holds::TransferStatus::parse(&json)` and `holds::holds(Some(&s), now, abs)`
     for the vehicle of `abs`.
   - `busy_paths()`: the converter's processing items
     (`sourceRoot/relativePath` of items in state `processing` of active jobs).
   - `idle()`: `!(converter running || benchmark)`.
   - `older_of` / `set_older` / `forget_setting`: the `sentry-usb-record`
     setting (`(db.get('sentry-usb-record', {}) || {})[vid]?.older !== false`).
   - `day_in`: the default uses chrono-tz (as Intl's en-CA format).
   - `audit`, `log_warn` / `log_debug` ('sentry-usb' scope),
     `log_converter(level, line)` ('converter' scope).
2. `let area = arrival::Area::open(ctx, &data_path); area.start();` (the
   10-minute pass).
3. The converter: `RuntimeOptions { before_replace_original:
   Some(area.before_replace_fn()), .. }` (an Err there makes staging answer
   `CHECKSUM_RECORD_FAILED` and keep the original; the error line
   "Could not record the original's checksum for Sentry USB, so it was kept:
   <name>: <code or message>" goes to `log_converter("error", ..)`), or from
   `ConverterCtx::before_replace_original` call `area.before_replace_original`.
   `ConverterCtx::clip_converted(path)` → `area.clip_converted(path)`.
   The converter's holdDiscovered is the same `holds` rule.
4. Inventory `onScanned(vid)`: after the Sentry USB status refresh,
   `area.scanned()` (a kick).
5. Routes (handlers in `routes.rs`):
   - GET `/api/vehicles/:id/sentry-usb`: `record:
     routes::record_view(&area.arrival, vid, adminHere(req, user))` inside the
     Sentry USB view (sentryUsb.api + countedMisses, other areas).
   - POST `/api/vehicles/:id/sentry-usb/record` (admin; a watch-only account
     may not make it): after vehicleOr404, `routes::post_record(&area.arrival,
     ctx, vid, &v.name, &body, &by(req, user))`; an `ApiError` is 400
     `{ error }`; on Ok answer the same view as the GET.
   - DELETE `/api/vehicles/:id`: `routes::vehicle_removed(&area.arrival, ctx, vid)`.
6. On shutdown: `area.arrival.stop()` (saves what is waiting).

## Tests

`cargo test --lib arrival` (test/arrivalChecksums.test.js and the record tests
of test/sentryUsb.test.js, ported), `cargo test --test arrival_parity` (Node
and Rust in turn on the same generated archive, two passes and 60 days of
record calls; needs node; `lean/parity/arrival.js`).
