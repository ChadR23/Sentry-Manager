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
