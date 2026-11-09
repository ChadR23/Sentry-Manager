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
"Every arrived clip gets a checksum line" below). An admin also sees **Record
checksums for clips from the last N days** there.

A day whose clips were still being sent when the car drove off gets a grey-blue
**Waiting for Sentry USB** tag instead of **Partly archived?**. Nothing is
lost: the clips stay on the Pi, and the transfer carries on at the next archive.

## Files on the share that belong to Sentry USB

Sentry Six Manager never indexes, counts, converts or flags as missing:

- `.sentryusb/` (Sentry USB's status file, below),
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
- Which clips: Tesla clips (`YYYY-MM-DD_HH-MM-SS-<camera>.mp4`) in
  `RecentClips/`, `SentryClips/`, `SavedClips/` and `TeslaTrackMode/` found by
  the inventory scan, whose own time, modification time or arrival on the share
  (birth time, else change time) is within the last 7 days. The rest of the
  archive is not read, unless an admin asks for it: **Record checksums for
  clips from the last N days** in the Sentry USB details (1 to 365 days, once;
  `POST /api/vehicles/:id/sentry-usb/record` with `{ "days": N }`).

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
runs after every inventory scan and every 10 minutes. SHA-256 takes about one
CPU-second per GiB, so the limit is roughly 6% of one core while it reads;
reading is from the NAS's own disk (over the container's mount), never over the
car's Wi-Fi. A day of driving (some tens of GB) takes several minutes. What was
recorded is kept in `<data>/arrival-checksums/<car>.json` (path, size,
modification time, inode, when), and entries go when the clip is gone or after
45 days. The record's own lines are kept 45 days.

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
  "not heard from since".

The server gives the file, read and in milliseconds, at
`GET /api/vehicles/:id/sentry-usb` (`{ "present": false }` when there is none),
with `record`: `{ enabled, today, lastAt, pending, lines, windowDays, backfill,
canBackfill }` (the checksum lines written for arrived clips, above).

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
