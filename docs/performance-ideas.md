# Performance ideas (saved for later)

Measured or observed on the owner's server (TrueNAS, raidz1 of 4 hard
disks, an 8,610-clip vehicle) in October 2026. Not started.

1. **Send only what changed to the Encoder page.** A running job's live
   update carries every clip: 4.8 MB for 8,610 clips, up to 4 times a
   second, to every open Encoder tab (measured). The server builds and
   checks each one and the browser parses each one. Send the full list
   once, then only the clips that changed (like the job journal), with
   tests for reconnects and missed updates.
2. **A separate work folder.** The converter's temporary files live in
   `/data` with the job files. An optional volume (for example `/work`)
   would let anyone put them on an SSD without moving all of `/data`.
3. **Read each original once.** In replace mode an original is read in full
   for its fingerprint, then again by the encoder. Fingerprinting while the
   encoder reads saves a full read per clip (hard disks, SMB). It changes
   the step that proves the original is untouched before it is replaced,
   so it needs the crash tests extended first.
4. **Discovery that resumes after a restart.** A job walks all of its
   folders again after every restart ("Still finding clips"); it could
   skip the folders it had finished.
5. **The 15-minute footage scan.** It walks every vehicle's folders (28,000
   files: 0.5 s, up to 40 s while the disks are busy). It could wait while
   a conversion runs, or skip date folders that have not changed.

## The footage catalog (started November 2026)

Each scan's files and every clip's codec are now kept in `/data/manager.db`
(`catalog_files`, `clip_codecs`; `server/catalog.js`), written in batches as
the scan goes, and the inventory's file entries are compact (one class, shared
day / camera / event strings, the codec on the entry). Measured with
`node --expose-gc tools/inventoryMemory.js` (made-up Tesla archive, all six
cameras): 22,000 files took 10.9 MB of heap (519 bytes a file), now 7.6 MB
(360); 100,000 files took 47.6 MB, now 32.1 MB. The catalog was never the
bulk of the server's memory. Files moved to the Recycle Bin or restored reach
the catalog straight away (the inventory's rebuild), not only at the next scan.

Still in memory, and why: the scan's file map (`inventory.get(id).files`,
about 290 bytes a file), because a dozen modules read it as a Map
(speedIndex, integrity, arrivalChecksums, archiveGap, canPrune, canSync,
scrubPrepare, recycleBin, index.js) and the Recycle Bin deletes from it; the
recordings, built from it after each scan. Next steps, one consumer at a
time, each with a before/after test:

1. Done (November 2026): the first scan after a restart reads the catalog
   (and its folder times) as the light rescan's `previous`, instead of a
   stat of every file. Each finished scan now also writes its folders'
   modified times (`catalog_dirs`) and a row saying the catalog holds one
   finished scan of that folder (`catalog_scans`: a format number, the root,
   when it started, and the files and bytes it wrote). The row is removed
   before any scan or Recycle Bin move writes and put back only when the
   write is done, so a scan cut short, a failed write, another version (a
   different format, or a catalog from before this one, which has no row),
   another footage folder, or rows that no longer add up to the files and
   bytes it wrote all mean a full scan. A resumed scan sees every file added
   or removed (every folder is still listed), every file replaced by a rename
   (its folder's time changes), and looks again at every file changed within
   two hours of when the last scan *started*, however long the server was
   down (a clip still being copied then). What it cannot see is what no light
   rescan sees: a file rewritten in place (no rename) in an unchanged folder.
   So it counts as one of the five light scans, and the full scan that
   follows within about 90 minutes catches that, as before. Only a light
   scan with nothing in memory starts from the catalog: the one on the
   share's first healthy moment after a start (index.js), or a background
   rescan; Refresh, a policy, a restore or a share coming back are full as
   before. Measured with a made-up archive of 20,000 files in 67 folders
   (local disk, a busy shared machine): the first scan after a restart made
   20,071 stat calls and took 1.2-1.8 s; now 71 (one per folder) and
   0.34-0.44 s (reading the rows and building the recordings; it also no
   longer rewrites every catalog row). With 2 ms added to each stat (a NAS
   round trip), 3.4-3.5 s against 0.35 s. `test/catalogResume.test.js`
   checks each case against a full scan.
2. Consumers that only count or sum (storage's last 14 days, arrivedClips,
   canPrune's clip list) query the catalog (`catalog.summary`, by day).
   Looked at (November 2026), none switched yet: the catalog gives the same
   answers (`test/catalogAnswers.test.js` compares all three after scans, a
   restart, a Recycle Bin move, a restore and a move during a scan), but
   while the map is in memory it is the quicker of the two. Measured on the
   made-up 20,000-file archive: storage's last 14 days (12,788 files in
   range) 0.5-0.6 ms from the map against 4.9 ms as one indexed query (and
   11-13 ms through `catalog.summary`, which groups the whole car);
   arrivedClips 0.3-0.5 ms against 4-5 ms (no index on arrival times, so
   every row is read); canPrune's clip list 0.3-0.5 ms against 7-9 ms (it
   needs every clip's path, so every row comes back as a string). Each query
   also holds the event loop for those milliseconds. So they move with step
   3, when the map goes and the query is what is left (storage's can then be
   kept per scan, as now). Found on the way and fixed: a Recycle Bin move
   while a scan ran (its rebuild) brought the catalog in line with the map
   from before the scan, dropping rows the scan had just written for new
   files (a scan writes them 1,000 at a time as it goes), and later scans,
   seeing those files unchanged, never wrote them back; a rebuild now leaves
   the catalog to the running scan, whose map replaces the old one anyway.
3. Then the file map can hold only what the light rescan needs, or nothing.
