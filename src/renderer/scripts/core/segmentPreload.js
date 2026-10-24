/**
 * Next-minute preload for day playback (native video mode).
 *
 * A day plays as one-minute segments, and loading the next one only when the
 * current one ends paused playback at every minute while up to six videos
 * came from the NAS. Here, while a segment plays, standby video elements
 * (hidden, one per camera shown) load the next segment; when it is due they
 * take the place of the playing ones, which become the standby elements for
 * the minute after. Anything that changes what would be shown (another
 * segment, layout, camera, day or profile) cancels the preload.
 *
 * Only the logic lives here (no DOM lookups), so it can be tested on its own;
 * script.js creates the elements and swaps them in.
 */

/**
 * Seconds of playback left (at the current speed) when the preload starts.
 * The preloaded elements wait paused, and Chrome suspends a player that has
 * been paused for 15 s (it drops its decoders, and the switch then waits for
 * them again), so they take over well before that.
 */
export const PRELOAD_LEAD_SECONDS = 12;

/**
 * Seconds a segment plays before the preload may start (half a segment when
 * it is shorter), so the next minute does not load while this one is still
 * starting up.
 */
export const PRELOAD_SETTLE_SECONDS = 3;

/**
 * Milliseconds the elements of a segment that just went off screen keep
 * their media before it is let go: tearing six players down blocks the page
 * for a moment, which is better done once the next minute plays.
 */
export const RETIRE_DELAY_MS = 1500;

/** Spare standby elements kept for reuse: six cameras and the single view. */
const MAX_SPARE_VIDEOS = 7;

/**
 * Whether this device preloads at all: not with Data Saver on, and not on a
 * device with 2 GB of memory or less (navigator.deviceMemory, where known).
 */
export function preloadAllowed(nav = globalThis.navigator) {
    if (nav?.connection?.saveData) return false;
    const memory = Number(nav?.deviceMemory);
    if (Number.isFinite(memory) && memory > 0 && memory <= 2) return false;
    return true;
}

/**
 * Whether to start preloading the next segment: once the rest of this one
 * plays in PRELOAD_LEAD_SECONDS or less at the current speed (for a segment
 * shorter than that, as soon as it has settled), and not in its first
 * PRELOAD_SETTLE_SECONDS.
 */
export function shouldStartPreload({
    currentTime,
    duration,
    playbackRate = 1,
    leadSeconds = PRELOAD_LEAD_SECONDS,
    settleSeconds = PRELOAD_SETTLE_SECONDS
} = {}) {
    const total = Number(duration);
    if (!Number.isFinite(total) || total <= 0) return false;
    const rate = Number(playbackRate) > 0 ? Number(playbackRate) : 1;
    const position = Math.max(0, Number(currentTime) || 0);
    if (position < Math.min(settleSeconds * rate, total / 2)) return false;
    const remaining = Math.max(0, total - position);
    return remaining / rate <= leadSeconds;
}

/**
 * Whether the switch to a preloaded element waits for it to be able to play:
 * only while it is still loading. One that can play needs no wait, and
 * neither does one the browser stopped loading until it plays (iOS loads only
 * metadata ahead on an element no tap has readied): waiting would only hold
 * the minute back, and would take play() past the second after a tapped
 * video ends in which WebKit still counts play() as the user's.
 */
export function preloadNeedsWait(video) {
    if (!video || video.error) return false;
    if (video.readyState >= 3) return false; // HAVE_FUTURE_DATA
    return video.networkState === 2; // NETWORK_LOADING
}

/**
 * The file each shown video element plays for one segment: in the
 * multi-camera grid one per slot of the layout (custom camera order applied),
 * else the selected camera. The master is the master camera's slot, or the
 * first slot with a file when that camera has none in this segment.
 * @param {{filesByCamera: Map}} group - The segment's clip group
 * @param {{multiEnabled: boolean, slots: {slot: string, camera: string}[], masterCamera?: string, selectedCamera?: string}} view
 * @returns {{multi: boolean, targets: {slot: string, camera: string, entry: object|null}[], masterSlot: string|null}|null}
 */
export function planSegment(group, { multiEnabled, slots = [], masterCamera = 'front', selectedCamera = 'front' } = {}) {
    const files = group?.filesByCamera;
    if (!files) return null;
    if (multiEnabled) {
        const targets = slots.map(({ slot, camera }) => ({
            slot,
            camera,
            entry: (camera && files.get(camera)) || null
        }));
        let masterDef = slots.find(s => s.camera === masterCamera);
        if (!files.has(masterDef?.camera)) {
            masterDef = slots.find(s => files.has(s.camera)) || masterDef;
        }
        return { multi: true, targets, masterSlot: masterDef?.slot || null };
    }
    const entry = files.get(selectedCamera) || files.values().next().value || null;
    return { multi: false, targets: [{ slot: 'main', camera: selectedCamera, entry }], masterSlot: 'main' };
}

/**
 * What a plan shows, as a string: two plans with the same key load the same
 * files into the same places.
 * @param {ReturnType<typeof planSegment>} plan
 * @param {(entry: object) => string|null} sourceKey - A file's identity
 */
export function planKey(plan, sourceKey) {
    if (!plan) return '';
    return JSON.stringify([
        plan.multi,
        plan.masterSlot,
        plan.targets.map(t => [t.slot, t.camera || '', (t.entry && sourceKey(t.entry)) || ''])
    ]);
}

/**
 * Keeps at most one preload (the next segment) and the spare standby
 * elements.
 * @param {object} deps
 * @param {() => HTMLVideoElement} deps.createVideo - A new standby element
 * @param {{append: (video: HTMLVideoElement) => void}} deps.stage - Where standby elements wait, out of sight
 * @param {(entry: object) => ({url: string, isBlob: boolean}|null)} deps.urlFor - A file's URL (blob URLs are revoked here)
 * @param {(url: string) => void} deps.revokeUrl
 * @param {(video: HTMLVideoElement) => void} deps.detach - Stops an element and drops its source
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer]
 * @param {(id: unknown) => void} [deps.clearTimer]
 */
export function createSegmentPreloader({
    createVideo,
    stage,
    urlFor,
    revokeUrl,
    detach,
    setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimer = id => globalThis.clearTimeout(id)
}) {
    let pending = null; // { segIdx, key, context, videos: Map(slot -> { video, url, isBlob }) }
    const spare = [];
    const standby = new WeakSet();
    const primed = new WeakSet();
    const retiring = new Map(); // video -> timer

    // A spare element, one readied during a tap first (see prime)
    const takeSpare = () => {
        for (let i = spare.length - 1; i >= 0; i--) {
            if (primed.has(spare[i])) return spare.splice(i, 1)[0];
        }
        return spare.pop() || null;
    };

    const release = (video) => {
        standby.delete(video);
        detach(video);
        video.removeAttribute?.('id');
        video.className = '';
        if (video.style) video.style.cssText = '';
        video.remove?.();
        if (spare.length < MAX_SPARE_VIDEOS && !spare.includes(video)) spare.push(video);
    };

    const preloader = {
        /** The segment being preloaded, or -1. */
        get segIdx() {
            return pending ? pending.segIdx : -1;
        },

        /** Elements loading or holding the next segment (none of them shown). */
        isStandby(video) {
            return standby.has(video);
        },

        /**
         * Preload segment segIdx as plan shows it. The same preload again is
         * left alone; a different one replaces it. Returns true when a new
         * preload started.
         */
        start({ segIdx, key, context, plan }) {
            if (pending && pending.segIdx === segIdx && pending.key === key && pending.context === context) return false;
            preloader.cancel();
            if (!plan) return false;
            const videos = new Map();
            for (const target of plan.targets) {
                const urlData = target.entry ? urlFor(target.entry) : null;
                if (!urlData) continue;
                const video = takeSpare() || createVideo();
                standby.add(video);
                stage.append(video);
                video.preload = 'auto';
                video.src = urlData.url;
                video.load();
                videos.set(target.slot, { video, url: urlData.url, isBlob: urlData.isBlob });
            }
            pending = { segIdx, key, context, videos };
            return true;
        },

        /**
         * The preloaded elements for segment segIdx, when they were loaded for
         * exactly this view (key and context): the caller then owns them and
         * their URLs. Anything else cancels the preload and returns null.
         */
        take(segIdx, key, context) {
            if (!pending) return null;
            if (pending.segIdx !== segIdx || pending.key !== key || pending.context !== context) {
                preloader.cancel();
                return null;
            }
            const { videos } = pending;
            pending = null;
            for (const { video } of videos.values()) standby.delete(video);
            return videos;
        },

        /** Drops the preload: its elements stop loading and their blob URLs are revoked. */
        cancel() {
            if (!pending) return;
            const { videos } = pending;
            pending = null;
            for (const { video, url, isBlob } of videos.values()) {
                release(video);
                if (isBlob) revokeUrl(url);
            }
        },

        /**
         * Playback goes on after a pause: the preloaded elements seek to
         * their start again. Chrome suspends paused players (drops their
         * decoders) once more than eight in the page are paused (six cameras
         * paused with six preloaded ones are twelve) or once one has been
         * paused for 15 s, and the switch then waited for them as for a
         * normal load. A seek wakes a suspended player; on one that is awake
         * (paused at its start) Chrome skips it.
         */
        wake() {
            if (!pending) return;
            for (const { video } of pending.videos.values()) {
                if (video.readyState >= 1 && !video.seeking) video.currentTime = 0;
            }
        },

        /**
         * Called during a tap or key press: up to `count` spare elements are
         * made (or kept), and load() runs on each one not readied before.
         * iOS loads a video ahead (beyond its metadata), and in Low Power
         * Mode lets it play without a tap, only once load() or play() ran on
         * that element during a user gesture. Standby elements are made by
         * script, so they are readied here, before a preload needs them.
         */
        prime(count = MAX_SPARE_VIDEOS) {
            const target = Math.min(count, MAX_SPARE_VIDEOS);
            for (const video of spare) {
                if (primed.has(video)) continue;
                video.load();
                primed.add(video);
            }
            while (spare.length < target) {
                const video = createVideo();
                video.load();
                primed.add(video);
                spare.push(video);
            }
        },

        /**
         * An element that was shown and is no longer: kept (stopped) for a
         * later preload, after delayMs when given (it should be paused and
         * off the page by then).
         */
        recycle(video, { delayMs = 0 } = {}) {
            if (!video) return;
            if (retiring.has(video)) {
                clearTimer(retiring.get(video));
                retiring.delete(video);
            }
            if (!(delayMs > 0)) {
                release(video);
                return;
            }
            retiring.set(video, setTimer(() => {
                retiring.delete(video);
                release(video);
            }, delayMs));
        },

        /** Cancels the preload and lets go of every element it holds, at once. */
        dispose() {
            preloader.cancel();
            for (const [video, timer] of retiring) {
                clearTimer(timer);
                release(video);
            }
            retiring.clear();
            spare.length = 0;
        },

        get spareCount() {
            return spare.length;
        },

        get primedSpareCount() {
            return spare.filter(video => primed.has(video)).length;
        },

        get retiringCount() {
            return retiring.size;
        }
    };
    return preloader;
}
