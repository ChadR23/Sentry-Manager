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

1. The first scan after a restart reads the catalog (and its folder times)
   as the light rescan's `previous`, instead of a stat of every file.
2. Consumers that only count or sum (storage's last 14 days, arrivedClips,
   canPrune's clip list) query the catalog (`catalog.summary`, by day).
3. Then the file map can hold only what the light rescan needs, or nothing.
