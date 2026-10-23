# Sentry Six Manager: performance improvements, ranked

These are ranked by the gain you would actually see, divided by effort and risk. Your priorities set the order: conversion speed first, then how fast pages respond, then power use.

**How to read the numbers**
- Times marked "VM" were measured on the test machine. That is a 2.8 GHz Xeon with no SHA hardware, so it is slower than your server.
- Your 12th to 14th gen Intel CPU is usually about twice as fast on CPU-bound work, so expect roughly half the VM saving there.
- Nothing was measured on your GPUs or your NAS.
- Effort: S means hours, M means a day or more.
- Risk means the chance of breaking conversions or data safety. "UI only" means only the pages are affected.
- All files are under the repository root.
- Under your rule, every item goes on a `release/` branch, passes `npm test`, and gets your screenshot check before it goes to `main`.

**Duplicates that were merged**
- "Each clip is hashed ~14 times" and "Replacing an original reads it 7 times" became #3. The riskier part of the second one is #23.
- The snapshot parts of three findings became #2 (server side) and #10 (browser side). Those findings are "the rest of each job-file update", "converter live updates" and "Encoder page redraws every snapshot". The rest of the job-file finding is #4 and #16.
- The two "static files have no validator or compression" findings (server and client) became #15.
- The two Recycle Bin findings (summaries and list) became #12.
- The inventory-scan finding was split into #13 (cheap half) and #25 (incremental walk).
- The duration-probe and first-chunk finding was split into #18 and #26.

## Tier 1: clear wins, do these first

**1. Stop re-copying every finished clip on each job update** (conversion speed)
- **What it does:** When the app builds the live job view, it reuses clips that are already finished instead of copying all of them again. Their empty "ownership" fields hold nothing private.
- **Gain:** The biggest single win for large jobs.
  - Today a 30,000-clip job gets slower as it runs: the extra cost per clip grows from about 2 s to about 17 s. More GPUs do not help.
  - On the VM at the halfway point (15k converted), one worker went from 11.5 to 4.2 s per clip. Two workers went to 3.2 s per clip.
  - Over a full 30k job that is roughly 55-70 h on the VM, probably about 25-35 h on your CPU.
  - It also removes the 300-600 ms web UI freezes late in a job.
  - There is no gain at the start of a job. The gain grows as more clips finish.
- **Effort:** S
- **Risk:** Very low. It is a one-condition change, and 41/41 tests pass.
- **Where:** `src/main/converter/jobService.js:157-163` (publicItem). Optional second step at `:1619-1640`: stop writing empty ownership.

**2. Send live job snapshots less often, and skip the work when nobody is watching** (conversion speed, then pages)
- **What it does:**
  - Sends the full job snapshot at once on state changes and when the job ends; otherwise at most every 250 ms, latest one wins.
  - Skips preparing the browser copy entirely when no browser is subscribed.
  - Updates the Jobs table and tells pages to refresh only when that job's line actually changed.
- **Gain:**
  - Each clip makes about 21-45 job updates. Today each one spends 12-46 ms preparing the snapshot (VM, 25-30k items), inside the queue that every worker waits on.
  - The prototype, measured together with #1 on the VM, went from 4.2 to 3.2 s per clip at 15k converted. That is about 1 s per clip, roughly 4 h over a 30k job on your CPU.
  - Open tabs stop re-fetching the Jobs list up to 2.5 times a second.
  - Encoder page traffic drops from about 2.3 MiB per clip to at most 0.2-0.4 MiB/s.
- **Effort:** S
- **Risk:** Low, and only affects UI timing.
  - Status can appear up to 250 ms late, so it needs your OK.
  - The final state must always be sent.
  - `ipc.js` is shared with the desktop app.
  - Two UI tests need a flush hook.
  - The throttling must happen before sanitizeSnapshot. Doing it only in `converterBridge.js` saves no server CPU.
- **Where:**
  - `src/main/converter/jobService.js:458-459` (where every update sends a snapshot)
  - `src/main/converter/ipc.js:443-467`
  - `server/index.js:1084-1105` (mirrorConverterJob)

**3. Hash each file once per safety check, not about 14 times** (conversion speed)
- **What it does:** Removes repeated SHA-256 checks of the same bytes in verify, the staging copy and replace-original. It keeps a full check, with the file held open, right before every rename or delete.
- **Gain:**
  - Bytes hashed per clip drop from 1.21 GB to 0.68 GB.
  - On the VM, 4 workers went from 11.1 to 17.8 clips/min (1.6x), and 1 worker from 6.9 to 5.05 s per clip. The longest UI stall went from 289 to 153 ms.
  - Your CPU has SHA hardware, so expect less: about 0.25-0.35 s of main-thread time per clip, or about 2 h per 25,000 clips. That only turns into speed while the main thread is the bottleneck.
  - NAS reads in replace mode drop from 620 to 383 MB per clip. At 1 GbE that is worth about 2 s per clip only if the share really re-reads from the NAS instead of the local cache. That is unknown and could be close to zero.
- **Effort:** S
- **Risk:** Low.
  - 68/68 converter tests pass. The rename helper must be built first, or 25 of those tests silently skip.
  - Two small checks are lost: removeExactOwned no longer rejects a file whose parent folder is a symlink (the inode check stays), and the verifier no longer guards against a swapped-in snapshot factory.
  - Gate the removals with an adapter flag so the Windows desktop adapter keeps today's checks.
- **Where:**
  - `src/main/converter/verifier.js:676, :679`
  - `src/main/converter/verificationSnapshot.js:61, :108`
  - `src/main/converter/staging.js:527/540, :584, :777, :1586, :1589, :1594, :1618`
  - `server/posixOwnedFs.js:130/134/179` stays as it is and keeps the checks.

**4. Fewer job-file writes per clip, and fewer full rewrites of the job file** (conversion speed, power)
- **What it does:**
  - Skips cleanup writes when there is nothing to clean.
  - Merges two cleanups into one.
  - Drops a "pending" record that is never read.
  - Raises the journal limit, so the 18-24 MB `job.json` is fully rewritten 5-10x less often.
- **Gain:**
  - About 8 of the roughly 45 updates per 60 MB clip disappear. Each still costs about 40 ms of CPU at 30k items on the VM, so roughly 0.3 s per clip there (an estimate).
  - Raising the journal limit from 200 to 1000-2000 removes most of the 330-410 ms full rewrites. Those rewrites cause the 400-600 ms UI freezes.
  - Writes to `/data` over a 30k-clip job fall from about 110-140 GB by 5-10x.
  - Trade-off: opening a large job goes from about 0.6 s to about 1.0 s at a limit of 2000. 1000 may be the better balance.
- **Effort:** S
- **Risk:** Low. The replacementCandidate and destinationPartial "pending" records must stay, because crash recovery uses them.
- **Where:**
  - `src/main/converter/jobStore.js:14` (JOURNAL_LIMIT)
  - `src/main/converter/staging.js:1007-1010, :2131, :2187`
  - `src/main/converter/jobService.js:1608-1613`

**5. Fix the task queue used by footage scans** (pages, power)
- **What it does:** Replaces a queue step that slows down sharply (quadratically) once tens of thousands of files are queued with one that takes the same time per file. Order and limits stay the same.
- **Gain:**
  - On the VM with a 38k-file tree, each scan went from 4.5 to 1.6 s and its CPU time from 5.3 to 2.3 s. Scans run every 15 min per vehicle.
  - The first codec probe of a 106k-clip share drops from about 22 s to about 0.2 s of main-thread CPU.
  - On the NAS the wall-time saving is smaller, but the CPU saving is the same.
  - It frees the process that also runs the converter and the UI.
- **Effort:** S
- **Risk:** None found.
- **Where:** `server/scanner.js:14`

**6. Stop the server freezing when you delete footage during a big conversion** (pages; also unblocks the converter)
- **What it does:** Builds the list of clips the converter still needs once per job snapshot and checks files against it. Today it walks every queued clip for every file being deleted.
- **Gain:** This only applies while a large job is queued, running or paused, but then the gain is large.
  - Today each trashed file freezes the server for about 40 ms.
  - The nightly policy causes about 17 s of freezes.
  - "Delete through this date" over 60 days freezes the server for about 15 min, and the converter stalls with it.
  - With the fix, both drop to well under a second.
- **Effort:** S
- **Risk:** Low.
  - It must check both the share path and its real path.
  - The protection read must stay inside the lock.
  - Add a test that a queued clip's file is refused.
- **Where:** `server/index.js:218-224`, `server/recycleBin.js:103, :108`

**7. Keep frames on the GPU between decode and encode (Intel QSV/VAAPI): test first** (conversion speed, power)
- **What it does:** Keeps decoded frames on the Arc A380 or UHD 770 instead of copying every frame to RAM and back.
- **Gain:** Unknown until tested on your GPU.
  - It removes about 8 GB (HW3) or 35 GB (HW4 front camera) of memory copying per clip. That is at least about 1.1 s (HW3) or 4.8 s (HW4 front) of CPU per clip, which is a power saving.
  - ffmpeg already runs on other cores, so the speed gain per lane may be small.
  - A 5-minute A/B test with the two ffmpeg commands in the finding will decide it. Skip this item if the difference is small.
- **Effort:** M
- **Risk:** Medium-low.
  - The existing fallback (zero-copy, then GPU decode, then CPU decode) catches failures, at the cost of one failed attempt per GPU and encoder.
  - The VAAPI encode must drop its hwupload filter in the same change, or every first attempt fails.
  - renderDevice must learn the new arguments so stats and lanes still credit the right GPU.
- **Where:** `src/main/converter/encoderPlanner.js:166, :121-125, :127, :137`, `src/main/converter/jobService.js:75-91`

**8. Play day opens the day you asked for** (pages)
- **What it does:** The Viewer reads the date from its address and loads that day first. Today it loads the newest day, then switches about 300 ms later.
- **Gain:**
  - Removes a full wrong-day load on every Play day: about 90-115 requests and 17-22 MiB in the test, and more with real 30-80 MB clips.
  - Fixes a race where the newest day could replace the day you asked for. This was found by reading the code, not reproduced.
- **Effort:** S
- **Risk:** Low.
  - The desktop app is unaffected, because its URL has no date.
  - Remove the 300 ms poller in `electronApiShim.js` in the same change, or it fires a second, redundant switch.
- **Where:** `src/renderer/script.js:2444-2447`, `web/electronApiShim.js:411-427`

**9. List a day's event folders 8-16 at a time in the Viewer** (pages)
- **What it does:** Reads the event folders in parallel instead of one request after another.
- **Gain:** On a 300-event day, about 2.3 s becomes about 0.3-0.5 s on the LAN. At 40 ms latency (phone or VPN), about 19 s becomes about 2 s.
- **Effort:** S
- **Risk:** Low. Keep the event order and the per-folder error handling.
- **Where:** `src/renderer/script.js:2632, :2650`

**10. Encoder page: redraw at most once per frame, and stop listening while hidden** (pages, power)
- **What it does:** Combines rapid updates into one redraw, and unsubscribes while the Encoder tab is hidden.
- **Gain:**
  - A hidden Encoder tab costs nothing.
  - With #2's limit in place, the Encoder page drops from about 22% to about 5-9% of a desktop browser's main thread at 0.5 clip/s.
  - Phones and tablets are no longer overloaded. Today a phone-class CPU hits 100% at 20 events/s.
  - Most of this gain depends on #2.
- **Effort:** S
- **Risk:** Low, UI only. When the tab is shown again it must resubscribe and fetch a fresh snapshot, using the existing path.
- **Where:** `src/renderer/scripts/features/footageConverter.js:1418, :1849`, `web/electronApiShim.js:335`

**11. Footage page: tick boxes without reloading the page** (pages)
- **What it does:** Checkbox, Show files and select-day clicks update the page in place instead of re-fetching and rebuilding it.
- **Gain:**
  - Each click goes from 200-450 ms plus about 230 KiB of requests to a few ms with no network. On a phone it is about 4x slower today.
  - `content-visibility` makes the first draw of long days cheaper.
- **Effort:** S
- **Risk:** Low, UI only.
- **Where:** `web/app.js:759, :763-768, :772, :774`, `web/shell.css` (`.rec`, `.day`)

**12. Recycle Bin: count in the database, list without per-file details, fewer 30-second refreshes** (pages)
- **What it does:**
  - Counts bin items and bytes with one SQL query.
  - Sends the Bin page file counts instead of every file path.
  - Removes a restored or deleted row in place instead of reloading the list.
  - The 30-second share check only announces changes the page actually shows.
- **Gain:** It grows with the bin, which nothing empties automatically.
  - At 300 items, each vehicle refresh freezes the server for 50-70 ms per vehicle. That happens every 30 s per vehicle per open tab, and drops to about 0.5 ms.
  - At 1,500 items the freeze is 260-310 ms and drops to about 2 ms.
  - The Bin page goes from 5-26 MB to about 0.3 MB.
- **Effort:** S
- **Risk:** Low. Restore, delete and empty keep using the full file lists.
- **Where:**
  - `server/index.js:361-369, :659`
  - `server/recycleBin.js:309-311`
  - `server/share.js:312-318`
  - `server/activity.js:49-52`
  - `web/app.js:1137-1138`

**13. Skip inventory work when nothing changed** (pages, power)
- **What it does:** After the 15-minute scan, it regroups recordings and tells open pages to refresh only if a file actually changed. Protect updates one recording in place.
- **Gain:** Removes 110-470 ms of regrouping that blocks the server, plus a full refresh of every open Overview, Footage or Policies tab. Today that happens every 15 min when nothing changed, and on every Protect click.
- **Effort:** S
- **Risk:** None.
- **Where:** `server/inventory.js:247-256, :272-277`, `server/index.js:642-650, :1113-1115`

**14. Write the codec cache only when it changed** (power, small page gain)
- **What it does:** Skips rewriting the whole codec cache after a scan that found nothing new or removed.
- **Gain:** Removes a 50-380 ms main-thread stall per scan (5-37 s per vehicle per day) and about 0.8-2 GB of database writes per vehicle per day.
- **Effort:** S
- **Risk:** None.
- **Where:** `server/inventory.js:214`

**15. Let browsers cache and compress the page files** (pages, mostly phone and remote)
- **What it does:**
  - Adds ETags, so a browser can ask "has this changed?" and get a quick "no".
  - Gzips text files.
  - Honours the existing ETags on media and thumbnails.
  - Versions thumbnail URLs so the browser stops re-asking.
- **Gain:**
  - The Viewer drops from 2.3 MiB to about 0.55 MiB on first load, then gets only quick "not modified" answers.
  - The Encoder and shell pages get about 4x smaller.
  - About 20 ms saved on wired LAN, about 0.7 s at 20 Mbit, and more on phones and VPN.
  - It adds to the savings from #8 and #27, because every Play day reloads the Viewer.
  - Versioned thumbnails also skip a NAS lookup per thumbnail.
- **Effort:** S
- **Risk:** Low.
  - Compress only static files and list data, never login or settings responses.
  - Keep `no-cache`, so updates still show at once.
- **Where:**
  - `server/http.js:90-115`
  - `server/studioApi.js:94-102`
  - `server/index.js:944, :955-959`
  - `web/app.js:779, :848`

## Tier 2: smaller or conditional

**16. Job-file updates that only check what changed** (conversion speed)
- **What it does:** Each job update re-checks only the clips that changed, instead of walking all 30,000.
- **Gain:**
  - The VM prototype, on top of #1 and #2, went from 3.2 to 2.8 s per clip at 15k converted. That is about 0.4 s per clip, or about 1.5 h per 30k job on your CPU (an estimate).
  - It also raises the ceiling for running several lanes.
- **Effort:** M
- **Risk:** Medium. It must extend the existing item cache and keep full validation for any unusual update.
- **Where:** `src/main/converter/jobStore.js:1256` (transition), `:176-268`, `:656-729`

**17. Full verification: keep decoded frames on the GPU** (only if your jobs use Full mode)
- **What it does:** Full verification decodes the new file on the GPU but no longer copies each frame back to RAM just to discard it.
- **Gain:**
  - Unknown until tested.
  - It removes 4 GB (HW3) or 17.6 GB (HW4 front) of GPU-to-RAM copying per verified clip.
  - Quick mode, the default, is unaffected. But older saved settings with no verify mode fall back to Full, so check which one you use.
- **Effort:** S
- **Risk:** Low. Clips the GPU decoder rejects go to the existing CPU re-check.
- **Where:** `src/main/converter/jobService.js:1506`, `src/main/converter/encoderPlanner.js:166-175`, `src/main/converter/verifier.js` (around line 258)

**18. Smaller first video chunk** (pages, NAS load)
- **What it does:** When a video is opened, the server sends 256 KiB first instead of 2 MiB.
- **Gain:**
  - About 1.75 MiB less NAS read and transfer per camera clip opened, roughly 10 MiB per minute of six-camera playback.
  - About 0.5 MiB less per duration probe.
  - This applies to clips whose index sits at the end of the file. Converted clips do; real Tesla originals were not checked.
  - The effect on time to first frame is unknown.
- **Effort:** S
- **Risk:** Low.
- **Where:** `server/studioApi.js:85, :120`

**19. Read telemetry without copying the video data** (conversion speed, small)
- **What it does:** The telemetry parsers stop copying the whole clip just to find the telemetry records.
- **Gain:** About 60-90 ms of main-thread CPU per clip on the VM, less on yours. That is about 1-3% of the main-thread work per clip.
- **Effort:** S
- **Risk:** Very low.
- **Where:** `src/main/converter/telemetryTimeline.js:26`, `src/main/converter/h265Telemetry.js:120`

**20. Read codec and duration in-process instead of running ffprobe per clip** (conversion speed, small)
- **What it does:** Gets the codec and duration from the file header the app already reads, and keeps ffprobe as a fallback.
- **Gain:**
  - About 70 ms per clip off each worker, plus about 60 ms of CPU.
  - About 29 min of worker time per 25,000 clips, divided by the number of workers.
  - It only helps if the workers, not the GPU, NAS or main thread, are the limit.
- **Effort:** S
- **Risk:** Low. A clip with damaged frames is caught after its staging copy instead of before it, which wastes one copy.
- **Where:** `src/main/converter/jobService.js:1346`, `src/main/converter/runtime.js:595-599`, `src/main/converter/mp4Header.js`

**21. Faster recording thumbnails (seek to a keyframe)**
- **What it does:** Grabs the nearest keyframe instead of decoding up to a second of video to reach the exact 1 s mark.
- **Gain:**
  - 0.06-0.22 s of CPU per thumbnail, once per recording and once more after it is converted.
  - The Footage page fills faster the first time.
- **Effort:** S
- **Risk:** Cosmetic only. Converted clips show their first frame instead of the frame at 1 s.
- **Where:** `server/thumbnails.js:33-34`

**22. Faster telemetry decoding in the Viewer**
- **What it does:** Replaces a slow byte-copy step with a plain loop.
- **Gain:** About 12 ms less per segment switch (about once a minute of playback), and about 50 ms on a phone-class CPU.
- **Effort:** S
- **Risk:** None.
- **Where:** `src/renderer/scripts/core/seiExtractor.js:79-89`

## Tier 3: bigger follow-ups, only if still needed after the above

**23. Release the shared save slot sooner, and use a quick check instead of the first full hash** (conversion speed)
- **What it does:** Replaces the first full hash of the original with a quick size-and-identity check. Lets the next worker start saving as soon as this clip's result is recorded, with local cleanup done afterwards.
- **Gain:**
  - If the share really re-reads from the NAS, up to about 3-3.5 s per clip. Otherwise about 0.2 s on your CPU.
  - Removing the lock entirely gave only +22% on the VM (see the rejected list).
  - The `save=` and `saveWait=` values in the timing log will show whether this matters for you.
- **Effort:** M
- **Risk:** Medium. It needs a new startup sweep for leftover ownership records, which does not exist today.
- **Where:** `src/main/converter/staging.js:1512`, `src/main/converter/jobService.js:1568, :576`

**24. Move the remaining hashing and telemetry work onto worker threads** (conversion speed, pages)
- **What it does:** Uses Node's built-in worker threads, so no extra service is needed.
- **Gain:** Not measured. After #3, the main thread is still about 88% busy with 4 workers on the VM. This would free it for more lanes and for the UI.
- **Effort:** M
- **Risk:** Not assessed by the audit.
- **Where:** `src/main/converter/staging.js:420` (hashOpenHandle), `server/posixOwnedFs.js:42` (hashHandle)

**25. Incremental footage scans based on folder change times** (power, NAS load)
- **What it does:** Re-reads only the folders that changed, instead of checking every file every 15 min.
- **Gain:**
  - Today each vehicle makes about 3.7 million (38k files) to 10 million (106k files) NAS metadata requests a day. This cuts each scan to a few hundred folder checks.
  - The CPU saving after #5 is modest, about 2 s per 15 min.
  - The time saved on the NAS is unknown.
- **Effort:** M
- **Risk:** Low-medium. It relies on folder change times. Re-checking recently changed folders and a full walk every few hours cover files that are still being copied in.
- **Where:** `server/scanner.js:60`, `server/inventory.js:247-256`

**26. Viewer: get segment durations in one request**
- **What it does:** Replaces one hidden video probe per segment with one server call. Today that is 60 probes per hour of driving, repeated on every reload.
- **Gain:** Fewer requests and less NAS reading per day opened. Not measured separately.
- **Effort:** M
- **Risk:** Low. Keep the existing probe as the fallback.
- **Where:** `src/renderer/script.js:3608, :4339-4433`

**27. Reuse the open Viewer on Play day, Play recording and vehicle switch**
- **What it does:** Keeps the running Viewer and tells it what to open, instead of reloading it.
- **Gain:** Saves the 1-2 s Viewer reload each time.
- **Effort:** M
- **Risk:** Not assessed separately.
- **Where:** `web/app.js:971-982`

## Rejected
- **"The job-wide save lock stops extra workers or GPUs from helping":** The lock is real, but removing it entirely gave only +22% on the VM, because the main thread doing the hashing is the real bottleneck. Its measured gain duplicates #3, and its lock-specific changes were not measured. The useful part survives as #23.
- **"Stage the next clip while this one encodes":** This is the already-known "no prefetch" item again, with a design but no new evidence. The gain is unknown without a GPU, and running 2 or more clips per lane, which the lanes code already supports, gives the same overlap without new crash-recovery paths.