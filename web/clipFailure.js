// Why a converted clip failed, in plain words, for every interface's
// Encoder page. The server sends failure.detail (the check that refused and
// what did not match, "observed != recorded") with an unsafe-owned-path or
// source-changed failure; it is kept in memory only, so after a restart the
// detail says "not known". The checks guard the original footage: a file that
// is not provably the version that was converted is never replaced.
//
// The Studio Encoder page (src/renderer/scripts/features/footageConverter.js)
// has the same words; tools/encoderRefusal.test.js keeps the two the same.

const NOT_KNOWN = [/^not known/i, 'The reason is not known: this clip failed before the server last restarted. Run it again (Retry failed, or a new Encoder job if Retry failed is refused) and the reason shows here and in the server log.'];

// unsafe-owned-path: a file the converter made or recorded is not exactly that file
const UNSAFE_OWNED_PATH = [
    NOT_KNOWN,
    [/nlink \d+ != 1/, 'The file has a second name (a hard link, often left by a backup or deduplication), so it was not touched.'],
    [/realpath|linked folder|symlink/i, 'Its folder is reached through a linked folder (a symlink), so it was not touched.'],
    [/outside/i, 'The file is outside the folder chosen for this conversion, so it was not touched.'],
    [/not a regular file/i, 'It is not a plain file, so it was not touched.'],
    [/\b(dev|ino) \S+ != /, 'Something else replaced or moved the file while it was being converted, so it was not touched.'],
    [/\bsize \S+ != |sha256|changed/i, 'The file changed while it was being converted, so it was not touched.'],
    [/./, 'A safety check on the file did not pass, so it was not touched.'],
];

// source-changed: the original is not provably the version that was converted
const KEPT = 'The original was kept as it is, not replaced.';
const SOURCE_CHANGED = [
    NOT_KNOWN,
    [/contents the same both times/, `The file changed after it was checked: its metadata time (ctime) changed, its contents did not. Something kept changing its permissions or attributes while it was read. ${KEPT} Run it again.`],
    [/nlink \d+ != 1[^;]*the Encoder's backup name/, `The file has a second name (a hard link), BACKUP-… beside it, left by an earlier Encoder replace that did not finish. ${KEPT}`],
    [/nlink \d+ != 1/, `The file has a second name (a hard link), often made by a backup or deduplication tool. ${KEPT}`],
    [/ENOENT|moved or deleted/, `The file changed after it was checked: it was moved or deleted. ${KEPT}`],
    [/realpath|linked folder/i, `Its folder is reached through a linked folder (a symlink), so it was not replaced. ${KEPT}`],
    [/not a regular file/i, `It is not a plain file, so it was not replaced. ${KEPT}`],
    [/bytes differ|sha256 differs/, `The file changed after it was checked: its contents changed. ${KEPT}`],
    [/\bino \S+ != |dev:ino/, `The file changed after it was checked: it was replaced by another file. ${KEPT}`],
    [/\bdev \S+ != /, `The file changed after it was checked: the share it is on was mounted again (its device number changed). ${KEPT} Run it again.`],
    [/\bsize \S+ != |size changed|bytes read \S+ != size/, `The file changed after it was checked: its size changed. ${KEPT}`],
    [/mtime_ns/, `The file changed after it was checked: it was written to while it was read. ${KEPT}`],
    [/ctime_ns/, `The file changed after it was checked: its metadata time (ctime) changed while it was read. ${KEPT} Run it again.`],
    [/./, `The file changed after it was checked. ${KEPT}`],
];

const TABLES = { 'unsafe-owned-path': UNSAFE_OWNED_PATH, 'source-changed': SOURCE_CHANGED };

/**
 * The plain words for a failed clip, or null when its failure carries no
 * detail. `detail` is the check's own words (empty for a reason not known).
 * @returns {{ plain: string, detail: string } | null}
 */
export function clipFailureWhy(failure) {
    const detail = typeof failure?.detail === 'string' ? failure.detail.trim() : '';
    if (!detail) return null;
    const table = TABLES[failure?.code] || UNSAFE_OWNED_PATH;
    const [pattern, plain] = table.find(([p]) => p.test(detail));
    return { plain, detail: pattern === NOT_KNOWN[0] ? '' : detail };
}
