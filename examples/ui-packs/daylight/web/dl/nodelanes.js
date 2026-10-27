// Encoder lanes on nodes. Each GPU of a paired node, and its CPU, is a device
// of its own ('node:<id>@<its GPU or cpu>'); the Encoder shows them grouped
// by node, under a header that opens and closes. A node of an older version
// lists no devices and stays one device ('node:<id>'), shown as a plain row.
// A number saved for 'node:<id>' (before nodes listed their GPUs) is the
// node's default device's (isDefault: its first GPU, else its CPU).

/** 'node:<id>' for any lane of a node, else null. */
export const nodeKeyOf = (id) => /^(node:[^@]+)(?:@.+)?$/.exec(String(id || ''))?.[1] || null;

/** One GPU (or the CPU) of a node that lists its devices: grouped under its node. */
export const isNodeDevice = (d) => d?.kind === 'node' && typeof d.id === 'string' && d.id.includes('@');

/** This server's own devices (and nodes that list none) as rows; each node that lists its devices as a group. */
export function splitDevices(devices) {
  const own = [];
  const groups = new Map();
  for (const d of devices || []) {
    if (!isNodeDevice(d)) { own.push(d); continue; }
    const key = nodeKeyOf(d.id);
    if (!groups.has(key)) groups.set(key, { key, name: d.nodeName || key.slice(5), devices: [] });
    groups.get(key).devices.push(d);
  }
  const nodes = [...groups.values()].map((g) => ({ ...g, online: g.devices.some((d) => d.online !== false) }));
  return { own, nodes };
}

/** A node device's own name, without its node's ("<node> · <GPU>" → "<GPU>"). */
export function deviceLabel(d) {
  if (d.deviceName) return d.deviceName;
  const name = String(d.name || d.id || '');
  const prefix = d.nodeName ? `${d.nodeName} · ` : '';
  return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** The number saved for a device: its own, or the whole-node number saved before for a node's default device. */
export function savedLane(saved, d) {
  if (!saved || !d) return undefined;
  if (Number.isSafeInteger(saved[d.id])) return saved[d.id];
  const key = nodeKeyOf(d.id);
  if (isNodeDevice(d) && d.isDefault === true && Number.isSafeInteger(saved[key])) return saved[key];
  return undefined;
}

/** A device's number for the next run: what was saved, else `fallback` (a node's other devices start Off). */
export function laneValue(saved, d, fallback) {
  const v = savedLane(saved, d);
  if (v !== undefined) return v;
  return isNodeDevice(d) && d.isDefault !== true ? 0 : fallback;
}

/** The device a job's lane shows on: itself, or for a whole-node lane saved before the node's default device. */
export function rowIdOf(devices, id) {
  if ((devices || []).some((d) => d.id === id)) return id;
  if (nodeKeyOf(id) !== id) return id;
  return (devices || []).find((d) => isNodeDevice(d) && d.isDefault === true && nodeKeyOf(d.id) === id)?.id || id;
}

/** A job's lanes as device → number, by the row each one shows on. */
export function jobLanes(devices, lanes) {
  const out = new Map();
  for (const l of Array.isArray(lanes) ? lanes : []) {
    const row = rowIdOf(devices, l.device);
    if (!out.has(row)) out.set(row, l.concurrency);
  }
  return out;
}

/** Which node groups are open (per browser), in a pack's own store under `key`. */
export function groupMemory(store, key) {
  const read = () => {
    const v = store.get(key, {});
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  };
  return {
    isOpen: (id) => read()[id] === true,
    set(id, open) {
      const next = { ...read() };
      if (open) next[id] = true; else delete next[id];
      store.set(key, next);
    }
  };
}

/** An element id for a group's body (letters, digits, - and _ only). */
export const groupBodyId = (scope, key) => `ng-${scope}-${String(key).replace(/[^A-Za-z0-9_-]/g, '-')}`;

/**
 * Wires the group headers inside `root` (buttons with data-node-group="<scope>|<node key>"
 * and aria-controls): each shows its remembered state and opens or closes on a click
 * (Enter and Space too: they are buttons). The markup is drawn closed, so a redraw
 * that only compares markup keeps what is open.
 */
export function wireGroups(root, memory) {
  root.querySelectorAll('[data-node-group]').forEach((head) => {
    const body = root.querySelector(`#${head.getAttribute('aria-controls')}`);
    const show = (open) => {
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      head.closest('[data-group-box]')?.classList.toggle('is-open', open);
      if (body) body.hidden = !open;
    };
    show(memory.isOpen(head.dataset.nodeGroup));
    head.onclick = () => {
      const open = head.getAttribute('aria-expanded') !== 'true';
      memory.set(head.dataset.nodeGroup, open);
      show(open);
    };
  });
}
