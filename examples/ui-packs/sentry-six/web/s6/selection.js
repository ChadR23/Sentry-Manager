export function createSelection() {
  let generation = 0;
  const listeners = new Set();
  const changed = () => {
    generation++;
    for (const fn of listeners) fn();
  };
  const selected = new Set();
  return {
    add: (ids) => {
      changed();
      ids.forEach((id) => selected.add(id));
    },
    remove: (ids) => {
      changed();
      ids.forEach((id) => selected.delete(id));
    },
    has: (id) => selected.has(id),
    count: () => selected.size,
    clear: () => {
      changed();
      selected.clear();
    },
    generation: () => generation,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    ids: () => [...selected],
    dayState: (ids) => {
      const n = ids.filter((id) => selected.has(id)).length;
      return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
    },
  };
}

export function longPress(root, selector, action) {
  let timer = null,
    start = null,
    held = false;
  const stop = () => {
    clearTimeout(timer);
    timer = null;
  };
  const down = (e) => {
    if (e.pointerType !== 'touch' || e.target.closest('input,select')) return;
    const row = e.target.closest(selector);
    if (!row) return;
    held = false;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      held = true;
      action(row);
    }, 550);
  };
  const move = (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) stop();
  };
  const click = (e) => {
    if (held) {
      e.preventDefault();
      e.stopImmediatePropagation();
      held = false;
    }
  };
  root.addEventListener('pointerdown', down);
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerup', stop);
  root.addEventListener('pointercancel', stop);
  root.addEventListener('click', click, true);
  return () => {
    stop();
    root.removeEventListener('pointerdown', down);
    root.removeEventListener('pointermove', move);
    root.removeEventListener('pointerup', stop);
    root.removeEventListener('pointercancel', stop);
    root.removeEventListener('click', click, true);
  };
}

/** Changing the footage scope invalidates both visible and hidden selections. */
export function changeScope(f, next) {
  if (!Object.entries(next).some(([key, value]) => f[key] !== value)) return;
  Object.assign(f, next, { offset: 0, selecting: false });
  f.selection.clear();
  f.dayRecs.clear();
}
