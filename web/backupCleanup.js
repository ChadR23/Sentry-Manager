// What a replace job did with leftover files of an earlier replace that did
// not finish (BACKUP-<clip> and TEMP-H265-/TEMP-AV1-<clip> beside a clip), in
// plain words, for every interface's Encoder page. The server sends it as the
// job snapshot's `backupCleanup` (kept in memory only), and only when there
// was something to tidy: { removed, restored, binned, kept, keptWhy: [{ path, why }] }.
//
// The Studio Encoder page (src/renderer/scripts/features/footageConverter.js)
// has the same words; tools/backupCleanup.test.js keeps the two the same.

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The words for a job's `backupCleanup`, or null when there is none.
 * @returns {{ summary: string, kept: { path: string, why: string }[], more: number } | null}
 */
export function backupCleanupWords(c) {
    if (!c || typeof c !== 'object') return null;
    const n = (k) => (Number.isFinite(c[k]) && c[k] > 0 ? c[k] : 0);
    const parts = [];
    if (n('removed')) parts.push(`${n('removed')} tidied`);
    if (n('restored')) parts.push(`${count(n('restored'), 'original', 'originals')} put back`);
    if (n('binned')) parts.push(`${n('binned')} moved to the Recycle Bin`);
    if (n('kept')) parts.push(`${n('kept')} kept`);
    if (!parts.length) return null;
    const kept = (Array.isArray(c.keptWhy) ? c.keptWhy : [])
        .filter((k) => k && typeof k.path === 'string' && typeof k.why === 'string')
        .map((k) => ({ path: k.path, why: k.why }));
    return {
        summary: `Leftover backups from an earlier replace: ${parts.join(', ')}.`,
        kept,
        more: Math.max(0, n('kept') - kept.length),
    };
}

/** The kept list's heading. */
export const KEPT_HEADING = 'Kept as they are, and why';
/** The note under the list when the server sent only the first ones. */
export const keptMore = (more) => `and ${more} more (see the server log)`;

/**
 * The words as HTML for the interfaces that build their pages from strings:
 * the summary, and a <details> listing each kept name and why. `esc` escapes text.
 */
export function backupCleanupHtml(c, esc, cls = 'backup-cleanup') {
    const w = backupCleanupWords(c);
    if (!w) return '';
    const list = w.kept.length
        ? `<details><summary>${esc(KEPT_HEADING)}</summary><ul>${w.kept.map((k) => `<li><code>${esc(k.path)}</code> ${esc(k.why)}</li>`).join('')}${w.more ? `<li>${esc(keptMore(w.more))}</li>` : ''}</ul></details>`
        : '';
    return `<div class="${esc(cls)}" role="status"><span>${esc(w.summary)}</span>${list}</div>`;
}
