import { ownedRender } from '../core.js';
import { esc } from '../core.js';
async function renderPage(el, ctx) {
  const {} = ctx.scope;
  const key = ctx.sub || 'trips',
    v = ctx.current();
  el.innerHTML =
    '<a class="back" href="#/footage">‹ Footage</a><div class="toolbar segments">' +
    [
      ['trips', 'Trips'],
      ['driving', 'Driving'],
      ['map', 'Map'],
    ]
      .map(([k, t]) => `<a class="btn ${k === key ? 'active' : ''}" href="#/drives/${k}">${t}</a>`)
      .join('') +
    '</div><div class="card" data-shared></div>';
  const box = el.querySelector('[data-shared]');
  let page;
  if (key === 'driving')
    page = (await ctx.scope.wait(import('/web/driving.js'))).createDrivingPage(box, {
      vehicleId: v?.id,
      vehicleName: v?.name,
    });
  else if (key === 'map')
    page = (await ctx.scope.wait(import('/web/eventMap.js'))).createEventMapPage(box, {
      vehicleId: v?.id,
      vehicleName: v?.name,
      openEvent: (ev) => {
        location.hash = '#/viewer?' + new URLSearchParams({ day: ev.day, at: ev.startKey + '~0' });
      },
    });
  else
    page = (await ctx.scope.wait(import('/web/drives.js'))).createDrivesPage(box, {
      vehicleId: v?.id,
      vehicleName: v?.name,
      h24: () => ctx.state.h24,
      open: (trip) => {
        location.hash =
          '#/viewer?' +
          new URLSearchParams({
            day: trip.day,
            at: (trip.clip || trip.startKey || '') + '~' + (trip.second || 0),
          });
      },
    });
  return () => page?.destroy?.();
}

export const render = ownedRender(renderPage);
