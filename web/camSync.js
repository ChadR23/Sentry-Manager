// Keeping the cameras in step while they play, shared by the interface
// packs. A small drift is closed by playing that camera up to 10% faster or
// slower for a moment (no jump, no stutter); only one of over a quarter
// second is jumped. Before, any drift past 0.15-0.25 s was jumped, so the
// cameras wandered up to about 0.1 s apart and corrected with a visible
// skip; now they stay within a few milliseconds.
// Call it for each camera every frame while playing.
export function syncTo(master, x, speed = 1) {
  const d = x.currentTime - master.currentTime;
  if (Math.abs(d) > 0.25) {
    x.currentTime = master.currentTime;
    if (x.playbackRate !== speed) x.playbackRate = speed;
    return;
  }
  const want = Math.abs(d) < 0.005 ? speed : speed * Math.max(0.9, Math.min(1.1, 1 - d * 2));
  if (Math.abs(x.playbackRate - want) > 0.004) x.playbackRate = want;
}
