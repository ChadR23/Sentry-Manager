// Sub-tabs, the same in every interface: a page with pages inside it (Drives |
// Driving | Map, Policies | Per car) shows a row of tabs, each a link to
// #/<page>/<tab>, so a sub-tab has its own address, Back works, and the page
// that was showing is taken down by the interface's own router like any
// other page. The page's plain address (#/<page>) opens the sub-tab last
// used in this browser, else the first.
//
//   const tab = pickSubTab('sentry-policies-tab', ['retention', 'per-car'], asked);
//   el.innerHTML = subTabsHtml([['retention', 'Policies'], ['per-car', 'Per car']], tab, {
//     href: (id) => `#/policies/${id}`, label: 'Policies sections', cls: 'seg', on: 'on'
//   });

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The sub-tab to show: the one asked for (in the address), else the last one used here, else the first; remembered. */
export function pickSubTab(key, ids, asked) {
  let id = ids.includes(asked) ? asked : null;
  if (!id) {
    try { const had = localStorage.getItem(key); if (ids.includes(had)) id = had; } catch { /* private window: the first */ }
  }
  id ||= ids[0];
  try { localStorage.setItem(key, id); } catch { /* for this visit then */ }
  return id;
}

/**
 * The tab row: tabs [[id, label]], links from href(id). cls is the
 * interface's own segmented control class, on the class of the current tab
 * (it also gets aria-current="page").
 */
export function subTabsHtml(tabs, current, { href, label = 'Sections', cls = '', item = '', on = 'on' } = {}) {
  return `<nav class="sentry-subtabs ${esc(cls)}" aria-label="${esc(label)}">${tabs.map(([id, text]) => `<a class="${esc(item)}${id === current ? ` ${esc(on)}` : ''}" href="${esc(href(id))}" data-subtab="${esc(id)}"${id === current ? ' aria-current="page"' : ''}>${esc(text)}</a>`).join('')}</nav>`;
}
