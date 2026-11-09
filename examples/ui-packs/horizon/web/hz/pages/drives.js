// Drives: the car's trips, newest first by day; one plays from its start in the Viewer (web/drives.js, the same in every interface).
// Driving and Map are its sub-tabs (Drives | Driving | Map, web/subTabs.js): #/drives/<tab>, each
// the page module it always was, unmounted with the page.
import { car, clockPref } from '../core.js';
import { createDrivesPage } from '/web/drives.js';
import { pickSubTab, subTabsHtml } from '/web/subTabs.js';
import driving from './driving.js';
import map from './map.js';

const trips = {
  async mount(el, { go }) {
    const v = car();
    el.innerHTML = `<section class="ptitle hud"><div><h1 class="chrome">Drives</h1><p>Every trip the car recorded, newest first, day by day. Tap one to play it from the start.</p></div></section>
      <section class="panel hud"><div id="dv-page"></div></section>`;
    const page = createDrivesPage(el.querySelector('#dv-page'), {
      vehicleId: v?.id, vehicleName: v?.name, h24: () => clockPref.h24,
      open: (at) => go(`#/viewer?day=${encodeURIComponent(at.day)}&at=${encodeURIComponent(`${at.clip}~${at.second}`)}`)
    });
    return { unmount() { page.destroy(); }, onCar() { go('#/drives'); } };
  }
};
export const DRIVES_TABS = [['trips', 'Drives', trips], ['driving', 'Driving', driving], ['map', 'Map', map]];

export default {
  async mount(el, opts) {
    const [asked, ...rest] = String(opts.sub || '').split('/');
    const tab = pickSubTab('sentry-drives-tab', DRIVES_TABS.map(([k]) => k), asked);
    const [, label, mod] = DRIVES_TABS.find(([k]) => k === tab);
    document.title = `${tab === 'trips' ? 'Drives' : `${label} · Drives`} · Horizon · Sentry Six Manager`;
    // (the sub-page's box is display: contents, as .page, so its panels sit in the view's grid)
    el.innerHTML = `${subTabsHtml(DRIVES_TABS, tab, { href: (k) => `#/drives/${k}`, label: 'Drives sections', cls: 'segs' })}<div class="page" data-subview></div>`;
    const m = await mod.mount(el.querySelector('[data-subview]'), { ...opts, sub: rest.join('/') });
    return { ...m, unmount() { m?.unmount?.(); }, onCar: m?.onCar ? () => opts.go(`#/drives/${tab}`) : undefined };
  }
};
