# Sentry USB

Sentry USB runs on a Raspberry Pi
in the car. It records the car's dashcam clips and, when the car is home,
copies (archives) them to a share on the NAS. Sentry Six Manager reads that
same share. This page is Sentry Six Manager's side of the agreement between
the two, so that neither undoes the other's work.

Sentry USB's side is in its own repository (`run/archiveloop` and
`run/rsync_archive/archive-clips.sh`). Sentry USB `v3.28.10-test.5` or later
is needed for the checks below.

## What you see

On the **Footage** page of every interface, a line under the heading says what
the Sentry USB last did for the selected car. It only shows when the share has
a Sentry USB status file. Tap it to see the details.

| Sentry USB is | The line reads, for example |
|---|---|
| done, all good | Sentry USB · last archive 3:07 PM ok · 120 clips · verified 120, 2 of them re-encoded by Sentry Manager |
| sending clips now | Sentry USB · sending 48 clips (from 2:40 PM to 3:12 PM) · expected by 3:41 PM |
| stuck mid-transfer | Sentry USB · waiting: the car left during the 3:20 PM transfer; its 48 clips stay on the Pi and arrive with the next archive |
| failed | Sentry USB · last archive 3:07 PM failed · 20 clips not sent, retried next archive |
| silent for a day | Sentry USB · not heard from since Nov 5, 3:30 PM (dimmed) |

Times are in the car's time zone, like the rest of the Footage page. The
details list the checksum results (matched the Pi, re-encoded on the server,
being re-sent, no Pi copy, still queued, and why the checks stopped early, if
they did), whether the Pi deletes its own copies after checking them
(auto-delete), the device name, and when the status was written and read.
While Sentry USB is sending, the line refreshes every minute.

**Checksums recorded** in the details says how many clips Sentry Six Manager
wrote a checksum line for today, when the last one was, and how many are
waiting (for example `12 clips today · last at 3:05 PM · 4 waiting`; see
"Every arrived clip gets a checksum line" below). While the older clips on the
share are still being read the first time it says how far that is instead,
for example `Recording checksums for older clips: 12,400 of 35,480 · about 2 h
left`, and the usual line again once they are done. An admin also sees the
**Record checksums for older clips** setting there (on by default).

A day whose clips were still being sent when the car drove off gets a grey-blue
**Waiting for Sentry USB** tag instead of **Partly archived?**. Nothing is
lost: the clips stay on the Pi, and the transfer carries on at the next archive.

A day whose missing footage is explained by snapshots the Pi did not take
gets an amber **Pi missed snapshots** tag instead of **Partly archived?**, and
the details list **Snapshots** (`every 58 min`) and **Missed snapshots (7
days)** (how many, and the latest, or `none`). See "Missed snapshots" below.

## Files on the share that belong to Sentry USB

Sentry Six Manager never indexes, counts, converts or flags as missing:

- `.sentryusb/` (Sentry USB's status file and its list of what the car
  wrote, below; Sentry Six Manager reads those two on purpose, but never
  indexes them as footage),
- `.sentryusb-partial/` folders inside clip folders (an upload that was cut
  off and resumes later),
- `.sentryusbtmp/` (the temporary folder of SMB and NFS uploads),
- `*.mp4.mismatch-<time>` files (a copy that failed its checksum, renamed
  aside by Sentry USB and sent again).

In general: anything whose name starts with a dot, and anything that does not
end in `.mp4`, is not footage. Sentry USB never deletes anything on the share.

## Converting clips in place

Sentry USB checks every clip it sends: it compares the SHA-256 of the copy on
the share with the one on the Pi, and with auto-delete on it checks again at
least an hour later before deleting the Pi's copy. When Sentry Six Manager
converts a clip in place ("replace originals"), the new file can never match
the Pi's, so Sentry Six Manager does three things that let Sentry USB tell a
conversion from a damaged upload:

1. **It writes down the original's checksum first.** Before replacing a clip,
   it hashes the original and appends one line to
   `.sentrymanager/original-checksums.sha256` at the share root (the folder
   that holds `RecentClips/`). The line is in `sha256sum` format: 64 lowercase
   hex digits, two spaces, and the path from the share root, for example
   `3f…a9  RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4`. The line is
   flushed to disk (fsync) before the original is replaced, so a failed
   replace leaves only a harmless line. A later line for the same path wins.
   Lines are kept for at least 30 days; older ones may be pruned by writing a
   new file and renaming it over the old one.
2. **It replaces the clip in one step.** The converted file is written under a
   temporary name (dot-prefixed or not ending in `.mp4`) and then renamed over
   the original, so a half-written clip never appears under the real name.
3. **The result is recognisable.** Same folder and name, an MP4 with H.265
   (`hvc1` or `hev1`) or AV1 (`av01`) video, and its index (`moov`) in the
   first or last MiB of the file.

Sentry USB then counts the clip as verified ("re-encoded on the server by
Sentry Manager"), never renames it aside and never sends it again. If the
checksum written down differs from the Pi's, the upload was damaged before it
was converted: Sentry USB renames the converted file aside and sends the
original again, and Sentry Six Manager converts it again later.

Converting to a separate folder ("keep originals") leaves the originals alone
and needs none of this.

## Every arrived clip gets a checksum line

Sentry USB verifies from Sentry Six Manager's record first: a clip with a line
in `.sentrymanager/original-checksums.sha256` is compared with the Pi's own
hash and never read back over the network. A clip without a line waits up to
24 hours for one, then the Pi reads the share's copy back in full. So Sentry
Six Manager writes a line for **every clip once it has fully arrived**,
converted or not (already H.265, an excluded folder, a conversion that failed
or was skipped), not only before conversions:

- The line is the SHA-256 of the clip on the share as it is now, in the same
  file and format as the conversion's lines (appended, fsynced, pruned the
  same way). It is the same hash a later in-place conversion writes for the
  original; a later line for the same path wins and an equal one changes
  nothing.
- A damaged upload gets its true (damaged) hash, so the Pi sees the mismatch
  and sends the clip again. The new upload is a new file and gets a new line.
- Only for shares whose root (the folder holding `RecentClips/`) has a
  `.sentryusb/` folder. Nothing is written on any other share.
- Which clips: **every** Tesla clip (`YYYY-MM-DD_HH-MM-SS-<camera>.mp4`) in
  `RecentClips/`, `SentryClips/`, `SavedClips/` and `TeslaTrackMode/` found by
  the inventory scan, however old. Turning **Record checksums for older clips**
  off in the Sentry USB details (admins; per car;
  `POST /api/vehicles/:id/sentry-usb/record` with `{ "older": false }`) limits
  it to clips whose own time, modification time or arrival on the share (birth
  time, else change time) is within the last 7 days, as before.
- Order: newest first, and fresh arrivals never wait behind the old archive.
  Each pass first takes the clips of the last 7 days, for every car (those that
  arrived in the last 48 hours first, then by the clip's own time, newest
  first), then the older ones (the backlog), newest first by the clip's own
  time. New clips found by a scan while the backlog is being read end that pass
  after the file in hand, and the next pass starts with them.

Skipped, and why:

| Clip | Why |
|---|---|
| in the range Sentry USB is still copying (status file `transferring`) | not fully arrived; recorded after the transfer |
| modified or renamed into place in the last minute | may still be written |
| one a conversion is working on right now | its own line comes with the conversion |
| unchanged (same size, modification time and inode) since its line | already recorded |
| the output of our own in-place conversion | the record keeps the original's hash for it; the converted bytes never get a line |
| any other H.265 / AV1 clip | not what the Pi uploaded and not converted here, so its hash proves nothing (the Pi marks it unconfirmed by codec) |
| dot-named files and folders, `*.mismatch-*`, `TEMP-H265-…` / `BACKUP-…` | not clips (see above) |

A clip replaced while it is being hashed (a re-upload, a conversion) is
noticed by its size, modification time and inode afterwards, and its hash is
dropped; the new file is hashed on the next pass.

**Cost.** One file at a time across all cars, read in 1 MiB pieces at most
64 MiB/s, paused while a conversion or the benchmark runs, at most 300 clips a
pass (the next pass follows half a minute later while more are waiting). A pass
runs after every inventory scan and every 10 minutes. Measured: SHA-256 with
the reads takes about 1.1 CPU-seconds per GiB (some 900 MiB/s unlimited on one
core), so at the 64 MiB/s limit it is roughly 8% of one core while it reads;
reading is from the NAS's own disk (over the container's mount), never over the
car's Wi-Fi. A day of driving (some tens of GB) takes several minutes. The
whole archive is read once, the first time: 550 GB (about 35,000 clips) is
about 2.3 hours of reading at the limit, some 3.3 hours with the half-minute
pauses between passes, longer while conversions run (it waits for them). After
that only new clips are read.

What was recorded is kept in `<data>/arrival-checksums/<car>.json` and
`<car>.log` (path, size, modification time, inode, when; a compact snapshot by
folder plus a journal of the changes, appended in batches and folded into the
snapshot now and then, not rewritten per clip). An entry stays as long as its
clip is on the share unchanged, however old, so a clip is never read twice;
entries go only when the clip is gone (or replaced: a new file is hashed
again).

**Pruning.** The record's own lines are kept at least 45 days by when they were
written and older ones may be pruned (see "Converting clips in place"),
whatever the clip's date. That is enough: the Pi only needs a clip's line
within its first day or so after the upload (it waits up to 24 hours for it,
then checks the clip itself), and a clip whose line was pruned is not hashed
again (its entry above stays). So an old clip recorded in the backlog keeps
its line at least 45 days after it was written, then only the entry.

## The status file

Sentry USB writes `.sentryusb/archive-status.json` at the share root when a
transfer starts and when an archive (and its checks) finishes. Sentry Six
Manager reads it to:

- **leave arriving clips alone:** while the state is `transferring`, the clips
  from `first_clip` to `last_clip` (by name) are still arriving, so nothing in
  that range is flagged as missing or converted yet;
- **say "waiting for Sentry USB":** still `transferring` after `give_up_unix`
  means the car drove off or the Pi lost its connection. The days in that
  range get the **Waiting for Sentry USB** tag instead of a missing-footage
  warning;
- **show the line above,** from `archive`, `verification`,
  `auto_delete_enabled` and `transfer`. A file older than 24 hours is shown as
  "not heard from since";
- **explain missing footage by missed snapshots,** from the optional
  `snapshot_interval_s` and `snapshots` (below).

The file may be up to 256 KiB; a larger one is not read.

### Missed snapshots

The Pi snapshots the car's USB drive every `SNAPSHOT_INTERVAL` (3480 s, 58
min, by default) and archives the snapshots later. The car keeps only about
the last hour of RecentClips, so when two snapshots in a row are much further
apart than that, the footage in between was overwritten on the car before any
snapshot caught it. Two optional fields (still schema 1; a file without them
reads as before) let Sentry Six Manager say so:

```json
"snapshot_interval_s": 3480,
"snapshots": [
  { "name": "snap-000010", "started_unix": 1794217860 },
  { "name": "snap-000011", "started_unix": 1794228300 }
]
```

- `snapshot_interval_s`: the configured interval in seconds, an integer from
  60 to 86400 (anything else is ignored, and 3480 is assumed).
- `snapshots`: every snapshot the Pi took in the last 7 days, oldest first,
  at most 1000, **including snapshots since released or deleted**: a
  snapshot left out looks like a missed one. `started_unix` (an integer, Unix
  seconds) is when the snapshot started; `name` is optional, at most 64
  characters of `A-Z a-z 0-9 . _ -`. Entries that are not like that are left
  out; the list is sorted, one entry per time, and only the newest 1000 kept.

How Sentry Six Manager uses them:

- Two consecutive snapshots more than the interval plus 7 minutes apart are a
  **missed snapshot** gap. Its lost window is from the earlier snapshot's
  start to the later one's start less 60 minutes (what the car keeps); a gap
  of an hour or less loses nothing.
- List the runs that found the drive unchanged too (the Pi discards a copy
  identical to the last one): parked, a car can write nothing to its drive
  for hours, and such a run is not a missed snapshot. Any extra field on an
  entry (`"kept": false`) is ignored.
- Missing minutes the archive check found (CAN Bridge shows the car driving
  with no footage, a drive cut off; parked time never counts) that fall in a lost
  window are explained by it: the day's tag reads **Pi missed snapshots**,
  and its text adds, for example, "Sentry USB took no snapshot between
  9:56 AM and 12:50 PM (2 h 54 min; it should take one every 58 min), and the
  car keeps only about an hour, so the footage from 9:56 to about 11:50 AM was
  overwritten before it was copied" (at most three gaps named, then "and N
  more times"). The missing-minute count is unchanged.
- A gap alone is not called missing footage: before the first snapshot after
  a pause the car may have been asleep and recorded nothing. Only minutes
  that other evidence shows missing are explained by it.
- The Sentry USB details show the interval and the gaps of the last 7 days.

The API gives them (in milliseconds) as `snapshots` in
`GET /api/vehicles/:id/sentry-usb` (`null` when the file has no list):
`{ interval, intervalReported, count, firstAt, lastAt, times, missed: [{ from,
to, minutes, lostTo }] }` (`lostTo` is `null` for a gap that loses nothing).
A day in `GET /api/vehicles/:id/days` whose missing minutes are explained has
`archive.missedSnapshots`: `[{ from, to, lostTo, minutes, missingMinutes }]`
(the car's clock, `YYYY-MM-DD_HH-MM-SS`; `minutes` the length of the gap,
`missingMinutes` the day's missing minutes in it) and
`archive.missedSnapshotMinutes`; both are `null` / `0` otherwise.

The server gives the file, read and in milliseconds, at
`GET /api/vehicles/:id/sentry-usb` (`{ "present": false }` when there is none),
with `record`: `{ enabled, today, lastAt, pending, lines, windowDays, older,
backlog, canBackfill }` (the checksum lines written for arrived clips, above).
`older` is the **Record checksums for older clips** setting; `backlog` is
`null` while it is off (or before the first pass), else the clips older than
the 7 days: `{ total, done, left, failed, bytesLeft, etaMinutes }` (`done` of
`total` looked at, `bytesLeft` still to read, `etaMinutes` an estimate at the
measured speed with the pauses between passes). `pending` counts the clips of
the last 7 days still waiting. `canBackfill`: this account may change the
setting (admins).

## What the car wrote (`car-files.tsv`)

From Sentry USB test.27 on, the Pi also writes `.sentryusb/car-files.tsv`
beside the status file. Every 10 minutes it lists the clips on the car's USB
drive (from an instant read-only copy, independent of its snapshots) and adds
each clip it has not seen yet, or that grew since. UTF-8, tab-separated, one
header line starting with `#`:

```
# first_seen_unix	path	size	mtime_unix
1762800000	RecentClips/2026-11-10_12-00-00-front.mp4	30000000	1762790000
```

- The path is the car's own layout: RecentClips is flat
  (`RecentClips/<name>.mp4`), while the share has
  `RecentClips/<YYYY-MM-DD>/<name>.mp4`. Sentry and Saved clips keep their
  event folder (`SentryClips/<event>/<name>.mp4`) on both.
- `.mp4` only, the last 7 days, and clips the car later deleted stay listed.
  A clip listed again with a later first-seen time grew: the largest size
  counts.

How Sentry Six Manager reads it:

- At most 32 MiB; a larger file is not read. It is parsed again only when its
  size or modification time changed (the Pi rewrites it every 10 minutes).
- A line that is not four fields of the right kind is skipped quietly, and so
  is a path that is absolute, has `..` or empty parts, a backslash, or is not a
  Tesla clip name. A header naming the four columns in another order is
  followed.
- Clips are matched to the share **by name, never by size** (Sentry Six
  Manager re-encodes clips, so sizes differ): a Recent clip by its file name,
  an event clip by its event folder and file name. Clips in the Recycle Bin
  count as on the share.

What it tells, per day and minute of the last 7 days (the archive check,
`server/archiveGap.js`):

| | When | Shown as |
|---|---|---|
| Fine | in the list and on the share | nothing |
| **Pi missed** | in the list, not on the share, and the Pi has archived since it saw the clip (an archive that went through started after the clip's last first-seen time; while a transfer runs, the clips it is still sending are left alone) | amber **Pi missed ~N min**; counted as missing footage, as before |
| **Car didn't record** | CAN Bridge shows the car driving, the list covers that minute, and has no clip for it | grey-blue **Car didn't record ~N min**; nothing is missing from the share, so no notification |
| **Unknown** | CAN Bridge shows driving with no footage, but the list can't speak for that minute: before its first line, after its last update, or while the Pi was off or restarting (a gap in the status file's `snapshots`) | only counted in the opened day; never "car didn't record" |
| On its way | in the list, not on the share, and the Pi has not archived since | only counted |
| Deleted in Manager | in the list, and deleted for good in Sentry Six Manager (the Recycle Bin emptied by hand or after N days, or a policy) | only counted, never missing |

Every delete for good in Sentry Six Manager goes through the Recycle Bin, and
each one is recorded (the clip's path and the time, in the database, kept 8
days and at most 50,000 entries; only clips at most 9 days old when deleted,
since older ones are out of the Pi's list anyway). "Delete its CAN data"
removes CAN logs only, never clips.

Parked minutes (gear P or no speed, Sentry Mode included) are never looked
at: the car writes no RecentClips then. Without the file (older Sentry USB),
everything works as before. Minutes a drive cut off is guessed to have lost
(the speed index) are dropped when the list shows the car wrote nothing then,
but never called "car didn't record" without CAN Bridge data.

The Pi logs a daily line ("Car files for 2026-11-10: 1234 RecentClips file(s)
covering 310 minute(s), 3 Sentry event(s), 1 saved clip(s)"). Sentry Six
Manager can't read that log, so it counts the same from the list (per day of
the clip's name) and shows it beside its own count of the share.

In the API, each day of `GET /api/vehicles/:id/days` has `carFiles` (`null`
without the file): `{ coverage: 'full' | 'partial' | 'none', car, share
({ recentFiles, minutes, sentryEvents, savedEvents }), carText, shareText,
piMissed, piMissedClips, carMissed, unknown, waiting, deleted, deletedClips,
runs: [{ kind ('pi' |
'car' | 'unknown' | 'waiting'), from, to, minutes, when, why }] }`, and a
day's `archive.carFiles` has the counts and runs. `GET
/api/vehicles/:id/archive-gaps` adds `carFiles: { present, error,
coveredFrom, coveredTo, days: [...] }`.

## Checking that it all works

1. Turn on automatic conversion with "replace originals" for the car, and let
   it convert some clips. `.sentrymanager/original-checksums.sha256` appears on
   the share and gets a line per arrived clip (and the converted ones' lines
   before they are replaced).
2. The Pi runs Sentry USB `v3.28.10-test.5` or later.
3. After the next archive, the Pi's `archiveloop` log shows
   `Archive verification: N matched, M re-encoded on the server by Sentry
   Manager, 0 to re-send, …`, and the Footage page's Sentry USB line says
   "verified …, M of them re-encoded by Sentry Manager".
4. On the Pi's Snapshots page, those snapshots show "Verified on archive", not
   "unconfirmed".
5. No `*.mismatch-*` files appear on the share, unless an upload really was
   damaged.
