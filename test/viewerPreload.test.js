'use strict';

// The Viewer's next-minute preload (src/renderer/scripts/core/segmentPreload.js):
// when it starts, what it loads for the view on screen, and when it is
// cancelled, with stand-in video elements.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..');
const MODULE = pathToFileURL(path.join(REPO, 'src/renderer/scripts/core/segmentPreload.js')).href;
const LIFECYCLE = pathToFileURL(path.join(REPO, 'src/shared/asyncLifecycle.mjs')).href;

const HW4_SLOTS = [
  { slot: 'tl', camera: 'left_pillar' }, { slot: 'tc', camera: 'front' }, { slot: 'tr', camera: 'right_pillar' },
  { slot: 'bl', camera: 'left_repeater' }, { slot: 'bc', camera: 'back' }, { slot: 'br', camera: 'right_repeater' }
];
const ALL = HW4_SLOTS.map((s) => s.camera);

/** A segment's clip group with these cameras (entries carry a server path, as on the web). */
function group(minute, cameras = ALL) {
  return { filesByCamera: new Map(cameras.map((camera) => [camera, { camera, file: { isElectronFile: true, path: `/footage/2026-10-01_10-0${minute}-00-${camera}.mp4` } }])) };
}

const sourceKey = (entry) => entry?.file?.path || null;

function fakeVideo() {
  return {
    src: '', preload: '', id: '', className: '', style: { cssText: '' }, loads: 0, paused: true, parent: null,
    load() { this.loads++; },
    pause() { this.paused = true; },
    removeAttribute(name) { if (name === 'src') this.src = ''; if (name === 'id') this.id = ''; },
    remove() { this.parent?.children.delete(this); this.parent = null; }
  };
}

async function preloader({ blob = false } = {}) {
  const { createSegmentPreloader } = await import(MODULE);
  const { detachMediaElement } = await import(LIFECYCLE);
  const stage = { children: new Set(), append(v) { v.parent?.children.delete(v); v.parent = stage; stage.children.add(v); } };
  const created = [];
  const revoked = [];
  const timers = new Map();
  let nextTimer = 1;
  let blobs = 0;
  const p = createSegmentPreloader({
    createVideo: () => { const v = fakeVideo(); created.push(v); return v; },
    stage,
    urlFor: (entry) => (blob ? { url: `blob:${++blobs}`, isBlob: true } : { url: `/api/media?path=${encodeURIComponent(entry.file.path)}`, isBlob: false }),
    revokeUrl: (url) => revoked.push(url),
    detach: detachMediaElement,
    setTimer: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimer: (id) => timers.delete(id)
  });
  const runTimers = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  return { p, stage, created, revoked, timers, runTimers };
}

async function plan(minute, view = {}, cameras = ALL) {
  const { planSegment, planKey } = await import(MODULE);
  const pl = planSegment(group(minute, cameras), { multiEnabled: true, slots: HW4_SLOTS, ...view });
  return { plan: pl, key: planKey(pl, sourceKey) };
}

test('the preload starts 15 s before the end of a minute, sooner at a higher speed', async () => {
  const { shouldStartPreload, PRELOAD_LEAD_SECONDS } = await import(MODULE);
  assert.equal(PRELOAD_LEAD_SECONDS, 15);
  assert.equal(shouldStartPreload({ currentTime: 30, duration: 60 }), false);
  assert.equal(shouldStartPreload({ currentTime: 44.9, duration: 60 }), false);
  assert.equal(shouldStartPreload({ currentTime: 45, duration: 60 }), true);
  assert.equal(shouldStartPreload({ currentTime: 59.9, duration: 60 }), true);
  assert.equal(shouldStartPreload({ currentTime: 60, duration: 60 }), true);
  // at 2x the last 15 s of playing are 30 s of footage
  assert.equal(shouldStartPreload({ currentTime: 29, duration: 60, playbackRate: 2 }), false);
  assert.equal(shouldStartPreload({ currentTime: 31, duration: 60, playbackRate: 2 }), true);
  // slow motion: later
  assert.equal(shouldStartPreload({ currentTime: 50, duration: 60, playbackRate: 0.5 }), false);
  assert.equal(shouldStartPreload({ currentTime: 53, duration: 60, playbackRate: 0.5 }), true);
});

test('a short segment preloads once it has settled, and an unknown length never', async () => {
  const { shouldStartPreload, PRELOAD_SETTLE_SECONDS } = await import(MODULE);
  assert.equal(PRELOAD_SETTLE_SECONDS, 3);
  // 12 s segment: the whole of it is inside the lead, but not in its first 3 s
  assert.equal(shouldStartPreload({ currentTime: 0, duration: 12 }), false);
  assert.equal(shouldStartPreload({ currentTime: 2.9, duration: 12 }), false);
  assert.equal(shouldStartPreload({ currentTime: 3, duration: 12 }), true);
  // shorter than twice the settle time: from its middle
  assert.equal(shouldStartPreload({ currentTime: 1.9, duration: 4 }), false);
  assert.equal(shouldStartPreload({ currentTime: 2, duration: 4 }), true);
  for (const duration of [NaN, 0, -5, undefined, Infinity]) {
    assert.equal(shouldStartPreload({ currentTime: 10, duration }), false, String(duration));
  }
  // a nonsense speed counts as 1x
  assert.equal(shouldStartPreload({ currentTime: 46, duration: 60, playbackRate: 0 }), true);
  assert.equal(shouldStartPreload({ currentTime: 40, duration: 60, playbackRate: -2 }), false);
});

test('no preloading with Data Saver on or on a device with 2 GB or less', async () => {
  const { preloadAllowed } = await import(MODULE);
  assert.equal(preloadAllowed({ connection: { saveData: true }, deviceMemory: 8 }), false);
  assert.equal(preloadAllowed({ deviceMemory: 2 }), false);
  assert.equal(preloadAllowed({ deviceMemory: 0.5 }), false);
  assert.equal(preloadAllowed({ deviceMemory: 4 }), true);
  assert.equal(preloadAllowed({ connection: { saveData: false }, deviceMemory: 8 }), true);
  // Safari and Firefox do not say: preload
  assert.equal(preloadAllowed({}), true);
  assert.equal(preloadAllowed(undefined), true);
});

test('the plan is what loadNativeSegment shows: the layout slots, the master, a missing camera', async () => {
  const { planSegment } = await import(MODULE);
  const full = planSegment(group(1), { multiEnabled: true, slots: HW4_SLOTS });
  assert.equal(full.multi, true);
  assert.equal(full.masterSlot, 'tc');
  assert.deepEqual(full.targets.map((t) => [t.slot, t.camera, sourceKey(t.entry)]), HW4_SLOTS.map(({ slot, camera }) => [slot, camera, `/footage/2026-10-01_10-01-00-${camera}.mp4`]));

  // HW3 footage in an HW4 layout: the pillar slots are empty
  const hw3 = planSegment(group(1, ['front', 'back', 'left_repeater', 'right_repeater']), { multiEnabled: true, slots: HW4_SLOTS });
  assert.deepEqual(hw3.targets.filter((t) => !t.entry).map((t) => t.slot), ['tl', 'tr']);

  // no front file in this minute: the first slot that has one is the master
  const noFront = planSegment(group(1, ['back', 'right_pillar']), { multiEnabled: true, slots: HW4_SLOTS });
  assert.equal(noFront.masterSlot, 'tr');
  // another master camera
  assert.equal(planSegment(group(1), { multiEnabled: true, slots: HW4_SLOTS, masterCamera: 'back' }).masterSlot, 'bc');
  // nothing at all: the master camera's slot stays
  assert.equal(planSegment({ filesByCamera: new Map() }, { multiEnabled: true, slots: HW4_SLOTS }).masterSlot, 'tc');

  // one camera: the selected one, or the first the minute has
  const single = planSegment(group(2), { multiEnabled: false, selectedCamera: 'back' });
  assert.deepEqual(single.targets.map((t) => [t.slot, sourceKey(t.entry)]), [['main', '/footage/2026-10-01_10-02-00-back.mp4']]);
  assert.equal(single.masterSlot, 'main');
  const fallback = planSegment(group(2, ['left_repeater']), { multiEnabled: false, selectedCamera: 'front' });
  assert.equal(sourceKey(fallback.targets[0].entry), '/footage/2026-10-01_10-02-00-left_repeater.mp4');

  assert.equal(planSegment(null, { multiEnabled: true, slots: HW4_SLOTS }), null);
});

test('the plan key changes with the camera order, the master, the mode and the files', async () => {
  const { planSegment, planKey } = await import(MODULE);
  const key = (g, view) => planKey(planSegment(g, { multiEnabled: true, slots: HW4_SLOTS, ...view }), sourceKey);
  const base = key(group(1));
  assert.equal(key(group(1)), base);
  const swapped = HW4_SLOTS.map((s) => (s.slot === 'tl' ? { ...s, camera: 'back' } : s.slot === 'bc' ? { ...s, camera: 'left_pillar' } : s));
  assert.notEqual(key(group(1), { slots: swapped }), base);
  assert.notEqual(key(group(1), { masterCamera: 'back' }), base);
  assert.notEqual(key(group(2)), base);
  assert.notEqual(planKey(planSegment(group(1), { multiEnabled: false }), sourceKey), base);
  assert.equal(planKey(null, sourceKey), '');
});

test('a preload loads one hidden element per shown camera with a file, once', async () => {
  const { p, stage, created } = await preloader();
  const { plan: pl, key } = await plan(1, {}, ['front', 'back', 'left_repeater', 'right_repeater']);
  assert.equal(p.start({ segIdx: 1, key, context: 'day', plan: pl }), true);
  assert.equal(p.segIdx, 1);
  assert.equal(created.length, 4, 'the two pillar slots have no file');
  for (const v of created) {
    assert.ok(stage.children.has(v));
    assert.ok(p.isStandby(v));
    assert.equal(v.preload, 'auto');
    assert.match(v.src, /^\/api\/media\?path=/);
    assert.equal(v.loads, 1);
  }
  // the same preload again (every timeupdate near the end): nothing new
  assert.equal(p.start({ segIdx: 1, key, context: 'day', plan: pl }), false);
  assert.equal(created.length, 4);
  assert.equal(created.every((v) => v.loads === 1), true);
});

test('the switch takes the preloaded elements; they are no longer standby', async () => {
  const { p, stage, created } = await preloader();
  const { plan: pl, key } = await plan(1);
  p.start({ segIdx: 1, key, context: 'day', plan: pl });
  const taken = p.take(1, key, 'day');
  assert.deepEqual([...taken.keys()], ['tl', 'tc', 'tr', 'bl', 'bc', 'br']);
  assert.equal(taken.get('tc').url, `/api/media?path=${encodeURIComponent('/footage/2026-10-01_10-01-00-front.mp4')}`);
  assert.equal(created.some((v) => p.isStandby(v)), false);
  assert.equal(p.segIdx, -1);
  // still in the stage until the page swaps them in; nothing was stopped
  assert.equal(stage.children.size, 6);
  assert.equal(created.every((v) => v.src && v.loads === 1), true);
  assert.equal(p.take(1, key, 'day'), null, 'taken once');
});

test('a jump to another minute, a camera or layout change, another day or profile: cancelled, URLs revoked', async () => {
  const { plan: pl, key } = await plan(1);
  const { key: otherOrder } = await plan(1, { slots: [...HW4_SLOTS].reverse() });
  const cases = [
    ['seek to another segment', (p) => p.take(4, key, 'day')],
    ['camera order or layout changed', (p) => p.take(1, otherOrder, 'day')],
    ['another day, library or profile', (p) => p.take(1, key, 'other-day')],
    ['cancel (pause message, profile switch)', (p) => p.cancel()]
  ];
  for (const [name, act] of cases) {
    const { p, stage, created, revoked } = await preloader({ blob: true });
    p.start({ segIdx: 1, key, context: 'day', plan: pl });
    assert.equal(act(p) ?? null, null, name);
    assert.equal(p.segIdx, -1, name);
    assert.equal(stage.children.size, 0, `${name}: nothing left in the stage`);
    assert.equal(created.every((v) => v.src === '' && v.paused && v.loads === 2 && !p.isStandby(v)), true, `${name}: every element stopped`);
    assert.deepEqual(revoked.sort(), ['blob:1', 'blob:2', 'blob:3', 'blob:4', 'blob:5', 'blob:6'], `${name}: every blob URL revoked`);
    assert.equal(p.spareCount, 6, `${name}: kept for the next preload`);
  }
});

test('a different preload replaces the running one and reuses its elements', async () => {
  const { p, created, revoked } = await preloader({ blob: true });
  const first = await plan(1);
  const second = await plan(1, { masterCamera: 'back' });
  p.start({ segIdx: 1, key: first.key, context: 'day', plan: first.plan });
  assert.equal(p.start({ segIdx: 1, key: second.key, context: 'day', plan: second.plan }), true);
  assert.equal(created.length, 6, 'no new elements');
  assert.equal(revoked.length, 6);
  assert.equal(p.take(1, first.key, 'day'), null);
  // (that take cancelled the second preload too: the view no longer matches it)
  assert.equal(revoked.length, 12);
});

test('replaced elements are torn down after the delay (or at once on dispose) and the spares stay bounded', async () => {
  const { p, runTimers, timers } = await preloader();
  const shown = Array.from({ length: 6 }, () => Object.assign(fakeVideo(), { src: '/api/media?path=x', id: 'videoTL', className: 'tile-video mirrored', style: { cssText: 'transform: scaleX(-1);' } }));
  shown.forEach((v) => p.recycle(v, { delayMs: 1500 }));
  assert.equal(p.retiringCount, 6);
  assert.equal(shown.every((v) => v.src), true, 'not yet');
  runTimers();
  assert.equal(p.retiringCount, 0);
  assert.equal(shown.every((v) => v.src === '' && v.id === '' && v.className === '' && v.style.cssText === ''), true);
  assert.equal(p.spareCount, 6);
  // more than six cameras and the single view are not kept
  Array.from({ length: 5 }, () => fakeVideo()).forEach((v) => p.recycle(v));
  assert.equal(p.spareCount, 7);

  const later = fakeVideo();
  later.src = 'blob:9';
  p.recycle(later, { delayMs: 1500 });
  p.dispose();
  assert.equal(later.src, '', 'released at once');
  assert.equal(timers.size, 0, 'no timer left');
  assert.equal(p.spareCount, 0);
  assert.equal(p.retiringCount, 0);
});

test('the Viewer wires the preload in: listeners on standby elements, cancel paths, the swap', () => {
  const fs = require('fs');
  const script = fs.readFileSync(path.join(REPO, 'src/renderer/script.js'), 'utf8');
  // a preloaded element is never synced to the playing master's time
  assert.match(script, /nativeVideo\.master !== vid && !segmentPreloader\.isStandby\(vid\)/);
  // every load goes through take(): a preload of anything else is cancelled there
  assert.match(script, /const preloaded = segmentPreloader\.take\(segIdx, planKey\(plan, mediaSourceKey\), preloadContext\(\)\);/);
  // day change, profile change, mode change, leaving the page, the shell's pause
  for (const pattern of [/segmentPreloader\.cancel\(\);\s*\n\s*\n\s*\/\/ Reset dashboard and map when switching clips/, /cannot provide it\.\s*\n\s*segmentPreloader\.cancel\(\);/, /pause\(\);\s*\n\s*segmentPreloader\.cancel\(\);/, /'pagehide', \(\) => segmentPreloader\.dispose\(\)/, /e\.data\?\.type === 'pause'\) segmentPreloader\.cancel\(\)/]) {
    assert.match(script, pattern);
  }
  // a deleted clip's files are let go at once (Windows keeps open files from being deleted)
  assert.match(script, /segmentPreloader\.dispose\(\);\s*\n\s*\n\s*\/\/ Clean up URL object references/);
  // the swapped-in element keeps the id, classes and inline style of the one it replaces
  assert.match(script, /next\.id = current\.id;[\s\S]{0,120}next\.className = current\.className;\s*\n\s*next\.style\.cssText = current\.style\.cssText;/);
  const css = fs.readFileSync(path.join(REPO, 'src/renderer/style.css'), 'utf8');
  assert.match(css, /\.standby-videos \{[^}]*opacity: 0;[^}]*pointer-events: none;/);
});
