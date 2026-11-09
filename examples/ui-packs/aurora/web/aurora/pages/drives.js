// Drives: the car's trips, newest first by day; one plays from its start in the Viewer (web/drives.js, the same in every interface).
// Driving and Map are its sub-tabs (Drives | Driving | Map, web/subTabs.js): #/drives/<tab>, each
// one the page module it always was, taken down when the window goes (another tab is another window).
import { current, vehiclePicker, clockPref } from '../core.js';
import { createDrivesPage } from '/web/drives.js';
import { pickSubTab, subTabsHtml } from '/web/subTabs.js';
import driving from './driving.js';
import map from './map.js';

const trips = {
  async mount(ctx) {
    const { body, actions, go } = ctx;
    const v = current();
    actions.innerHTML = vehiclePicker();
    body.innerHTML = '<div id="dv-page"></div>';
    const page = createDrivesPage(body.querySelector('#dv-page'), {
      vehicleId: v?.id, vehicleName: v?.name, h24: () => clockPref.h24,
      open: (at) => { const to = `#/viewer/${encodeURIComponent(v.id)}/day/${encodeURIComponent(at.day)}?at=${encodeURIComponent(`${at.clip}~${at.second}`)}&autoplay=1`; if (go) go(to); else location.hash = to; }
    });
    return { destroy() { page.destroy(); } };
  }
};
export const DRIVES_TABS = [['trips', 'Drives', trips], ['driving', 'Driving', driving], ['map', 'Map', map]];

export default {
  title: 'Drives',
  kicker: 'Trips',
  icon: 'route',
  topics: [],
  vehicle: true,
  async mount(ctx) {
    const tab = pickSubTab('sentry-drives-tab', DRIVES_TABS.map(([k]) => k), ctx.params[0]);
    const [, label, mod] = DRIVES_TABS.find(([k]) => k === tab);
    if (tab !== 'trips') document.title = `${label} · Drives · Sentry Six Manager`;
    ctx.body.innerHTML = `${subTabsHtml(DRIVES_TABS, tab, { href: (k) => `#/drives/${k}`, label: 'Drives sections', cls: 'seg' })}<div data-subbody></div>`;
    const ctl = await mod.mount({ ...ctx, body: ctx.body.querySelector('[data-subbody]'), params: ctx.params.slice(1) });
    return { destroy() { ctl?.destroy?.(); }, refresh: ctl?.refresh ? (t) => ctl.refresh(t) : undefined };
  }
};
