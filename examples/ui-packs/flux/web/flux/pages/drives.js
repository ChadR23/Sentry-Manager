// Drives: the car's trips, newest first by day; one plays from its start in the Viewer (web/drives.js, the same in every interface).
// Driving and Map are its sub-tabs (Drives | Driving | Map, web/subTabs.js): #/drives/<tab>, each
// the page module it always was, unmounted with the page.
import { current, clockPref } from '../core.js';
import { createDrivesPage } from '/web/drives.js';
import { pickSubTab, subTabsHtml } from '/web/subTabs.js';
import driving from './driving.js';
import map from './map.js';

const trips = {
  async mount(el, { go }) {
    const v = current();
    el.innerHTML = `<div class="phead"><div><h1>Drives</h1><p class="muted small">Every trip the car recorded, newest first, day by day. Click one to play it from the start.</p></div></div>
      <section class="card"><div id="dv-page"></div></section>`;
    const page = createDrivesPage(el.querySelector('#dv-page'), {
      vehicleId: v?.id, vehicleName: v?.name, h24: () => clockPref.h24,
      open: (at) => { const to = `#/viewer?day=${encodeURIComponent(at.day)}&at=${encodeURIComponent(`${at.clip}~${at.second}`)}`; if (go) go(to); else location.hash = to; }
    });
    return { unmount() { page.destroy(); } };
  }
};
export const DRIVES_TABS = [['trips', 'Drives', trips], ['driving', 'Driving', driving], ['map', 'Map', map]];

export default {
  async mount(el, opts) {
    const [asked, ...rest] = String(opts.sub || '').split('/');
    const tab = pickSubTab('sentry-drives-tab', DRIVES_TABS.map(([k]) => k), asked);
    const [, label, mod] = DRIVES_TABS.find(([k]) => k === tab);
    document.title = `${tab === 'trips' ? 'Drives' : `${label} · Drives`} · Flux · Sentry Six Manager`;
    el.innerHTML = `${subTabsHtml(DRIVES_TABS, tab, { href: (k) => `#/drives/${k}`, label: 'Drives sections', cls: 'tabs' })}<div data-subview></div>`;
    const m = await mod.mount(el.querySelector('[data-subview]'), { ...opts, sub: rest.join('/') });
    return { ...m, unmount() { m?.unmount?.(); } };
  }
};
