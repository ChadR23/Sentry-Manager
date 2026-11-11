'use strict';

// Free and total space over all vehicles, counting each storage once: two
// vehicles on the same SMB share (the same server and share name, whatever
// folder each uses in it) or on the same local disk report the same space, so
// it is added only once.

const fs = require('fs');
const { parseShare } = require('./mountSpec');

/** What a vehicle's footage is stored on: the SMB server and share, or the local disk (its device). */
function storageKey(vehicle, root, statImpl = fs.statSync) {
  const src = vehicle?.source || {};
  if (src.type === 'smb') {
    try {
      const p = parseShare(src.share);
      return `smb:${p.host.toLowerCase()}/${p.share.toLowerCase()}`;
    } catch {
      return `smb:${String(src.share || '').toLowerCase()}`;
    }
  }
  try {
    return `dev:${statImpl(root).dev}`;
  } catch {
    return `path:${root || vehicle?.id}`;
  }
}

/** { freeBytes, totalBytes } summed once per storage; both null when none reports space. */
function storageTotals(list, { statusOf, rootOf, statImpl } = {}) {
  const seen = new Set();
  let freeBytes = null;
  let totalBytes = null;
  for (const v of list) {
    const st = statusOf(v) || {};
    if (!Number.isFinite(st.freeBytes) || !Number.isFinite(st.totalBytes)) continue;
    const key = storageKey(v, rootOf(v), statImpl);
    if (seen.has(key)) continue;
    seen.add(key);
    freeBytes = (freeBytes || 0) + st.freeBytes;
    totalBytes = (totalBytes || 0) + st.totalBytes;
  }
  return { freeBytes, totalBytes };
}

module.exports = { storageTotals, storageKey };
