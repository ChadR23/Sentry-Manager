// The running version as people see it, the same in every interface:
// "Build 128 · Nov 11, 2026". The build number is the Image workflow's run
// number (BUILD_INFO.json `build`, server/buildInfo.js); it only ever goes
// up, so "Build 128" tells how old a copy is at a glance. The full commit is
// only in the tooltip (and in the support bundle and /api/system). An image
// from before build numbers shows its short commit; a copy built from source
// shows `none`. Plain text: the caller escapes it.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A build number, or null. */
export function buildNumber(value) {
  const n = Number(String(value ?? '').replace(/^build-/i, ''));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** "Nov 11, 2026" (the UTC day, as the build recorded it), or '' without a date. */
export function buildDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return '';
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/**
 * The running copy: "Build 128 · Nov 11, 2026"; "cb593ca · built Nov 11, 2026"
 * for an image without a number; `none` (with "· built <date>" when it has
 * one) for a copy built from source. `v` is BUILD_INFO (/api/system `version`)
 * or /api/updates `current`.
 */
export function buildText(v, none = 'built from source') {
  const n = buildNumber(v?.build);
  const day = buildDate(v?.builtAt);
  if (n) return `Build ${n}${day ? ` · ${day}` : ''}`;
  const sha = v?.sha ? String(v.sha).slice(0, 7) : '';
  return `${sha || none}${day ? ` · built ${day}` : ''}`;
}

/** The tooltip: the full commit (and the tag), or '' without one. */
export function buildTip(v, tag = v?.tag) {
  if (!v?.sha) return '';
  return `Commit ${v.sha}${tag ? ` · image tag ${tag}` : ''}`;
}

/** "Build 1" for one build, else "N builds". */
const builds = (n) => `${n} build${n === 1 ? '' : 's'}`;

/**
 * Settings > Updates, when both builds have numbers and a newer one is out:
 * "Build 131 is out: you have Build 128 (3 builds behind)". null otherwise.
 * `u` is /api/updates.
 */
export function behindText(u) {
  const mine = buildNumber(u?.current?.build);
  const latest = buildNumber(u?.latest?.build);
  if (!mine || !latest || latest <= mine) return null;
  return `Build ${latest} is out: you have Build ${mine} (${builds(latest - mine)} behind)`;
}

/** The newest image on the tag: "Build 131 · published Nov 12, 2026" (the short commit for one without a number). */
export function latestText(l) {
  if (!l) return '';
  const n = buildNumber(l.build);
  const day = buildDate(l.created);
  const name = n ? `Build ${n}` : l.revision ? String(l.revision).slice(0, 7) : '';
  return `${name ? `${name} · ` : ''}published ${day || '?'}`;
}

/** The newest image's tooltip: its full commit, or ''. */
export function latestTip(l) {
  return l?.revision ? `Commit ${l.revision}` : '';
}

/** A server line's version part: "Build 128" as it is, "version 2026.26.35" (or `prefix` + it) otherwise. */
export function hostVersion(version, prefix = 'version ') {
  if (!version) return '';
  return /^Build \d/.test(String(version)) ? String(version) : `${prefix}${version}`;
}
