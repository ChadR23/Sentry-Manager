'use strict';

// BUILD_INFO.json: what the release build (.github/workflows/image.yml, the
// Dockerfile) wrote into the image: the commit (sha), branch, build time,
// image, tag and, from images with one, the build number (the Image
// workflow's run number: it only ever goes up). People see "Build N"; the
// commit is there for debugging. A copy built from source has none of it.

const fs = require('fs');
const path = require('path');

/** A build number: a whole number from 1, else null. */
function cleanBuild(value) {
  const t = String(value ?? '').trim().replace(/^build-/i, '');
  if (!/^\d{1,9}$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

/** BUILD_INFO.json from `root`, with `build` a number (or left out); {} when there is none. */
function readBuildInfo(root) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(path.join(root, 'BUILD_INFO.json'), 'utf8'));
  } catch {
    return {};
  }
  if (!info || typeof info !== 'object' || Array.isArray(info)) return {};
  const { build, ...rest } = info;
  const n = cleanBuild(build);
  return n ? { ...rest, build: n } : rest;
}

/** "Build 128 (cb593ca)", "cb593ca" for an image from before build numbers, null for a copy built from source. */
function buildName(info = {}) {
  const sha = info.sha ? String(info.sha).slice(0, 7) : '';
  const n = cleanBuild(info.build);
  if (n) return sha ? `Build ${n} (${sha})` : `Build ${n}`;
  return sha || null;
}

module.exports = { cleanBuild, readBuildInfo, buildName };
