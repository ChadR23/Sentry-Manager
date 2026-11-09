// Drives: the car's trips, newest first by day; one plays from its start in the Viewer (web/drives.js, the same in every interface).
import { vehicle, vehiclePicker, setVehicle } from '../state.js';
import { go } from '../app.js';
import { clockPref } from '../core.js';
import { createDrivesPage } from '/web/drives.js';
import { pickSubTab, subTabsHtml } from '/web/subTabs.js';
import * as driving from './driving.js';
import * as map from './map.js';

// Driving and Map are its sub-tabs (Drives | Driving | Map, web/subTabs.js): #/drives/<tab>, each
// the page it always was, cleaned up with the page.
const trips = { render: renderTrips };
export const DRIVES_TABS = [['trips', 'Drives', trips], ['driving', 'Driving', driving], ['map', 'Map', map]];

export async function render(ctx) {
  const tab = pickSubTab('sentry-drives-tab', DRIVES_TABS.map(([k]) => k), ctx.params[0]);
  const [, , mod] = DRIVES_TABS.find(([k]) => k === tab);
  ctx.view.innerHTML = `<div class="page subtab-bar">${subTabsHtml(DRIVES_TABS, tab, { href: (k) => `#/drives/${k}`, label: 'Drives sections', cls: 'seg' })}</div><div data-subview></div>`;
  await mod.render({ ...ctx, view: ctx.view.querySelector('[data-subview]'), params: ctx.params.slice(1) });
}

async function renderTrips(ctx) {
  const v = vehicle();
  ctx.view.innerHTML = `<div class="page"><div class="page-head"><div><h1>Drives</h1><p class="lede">Every trip the car recorded, day by day. Tap one to watch it from the start.</p></div>
    <div class="head-actions">${vehiclePicker()}</div></div><div class="card" id="dv-page"></div></div>`;
  ctx.view.querySelector('#vehicle-pick')?.addEventListener('change', (e) => { setVehicle(e.target.value); go('#/drives'); });
  const enc = encodeURIComponent;
  const page = createDrivesPage(ctx.view.querySelector('#dv-page'), {
    vehicleId: v?.id, vehicleName: v?.name, h24: () => clockPref.h24,
    open: (at) => go(`#/viewer/${enc(v.id)}?day=${enc(at.day)}&at=${enc(`${at.clip}~${at.second}`)}&autoplay=1`)
  });
  ctx.cleanup(() => page.destroy());
}
