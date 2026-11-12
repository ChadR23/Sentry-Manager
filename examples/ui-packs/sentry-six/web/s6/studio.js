import { esc } from './core.js';
const frames = {};
function fit() {
  const wrap = frames.viewer,
    frame = wrap?.querySelector('iframe');
  if (!frame || wrap.hidden) return;
  const width = wrap.clientWidth,
    s = width < 900 ? width / 900 : 1;
  Object.assign(frame.style, {
    width: s < 1 ? '900px' : '100%',
    height: s < 1 ? `${wrap.clientHeight / s}px` : '100%',
    transform: s < 1 ? `scale(${s})` : '',
    transformOrigin: '0 0',
  });
}
window.addEventListener('resize', fit);
export function hideStudio() {
  for (const wrap of Object.values(frames)) {
    if (!wrap.hidden)
      wrap.querySelector('iframe').contentWindow?.postMessage({ type: 'pause' }, location.origin);
    wrap.hidden = true;
  }
}
export function studioUrl(kind, vehicle, extra = {}, vehicleChanged = false) {
  const { vehicle: ignoredVehicle, root: ignoredRoot, ...params } = extra;
  const q = new URLSearchParams({
    embed: kind,
    ...(vehicle ? { root: vehicle.studioRoot || vehicle.root, vehicle: vehicle.id } : {}),
    ...(vehicleChanged ? {} : params),
  });
  return `/studio/${kind === 'encoder' ? 'encoder' : 'index'}.html?${q}`;
}
export function showStudio(kind, vehicle, extra = {}, vehicleChanged = false) {
  hideStudio();
  const url = studioUrl(kind, vehicle, extra, vehicleChanged);
  if (
    !frames[kind] ||
    frames[kind].dataset.vehicle !== vehicle?.id ||
    vehicleChanged ||
    Object.keys(extra).length > 0
  ) {
    frames[kind]?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'frame-wrap';
    wrap.dataset.src = url;
    wrap.dataset.vehicle = vehicle?.id;
    wrap.innerHTML = `<div class="studio-loading"><span>Opening ${kind === 'encoder' ? 'Encoder' : 'Viewer'}…</span><i></i><i></i><i></i></div><iframe title="Sentry Studio ${kind}" src="${esc(url)}" allow="fullscreen; clipboard-write"></iframe>`;
    document.getElementById('frames').append(wrap);
    frames[kind] = wrap;
    wrap.querySelector('iframe').onload = () => {
      wrap.querySelector('.studio-loading')?.remove();
      wrap
        .querySelector('iframe')
        .contentWindow?.postMessage({ type: wrap.hidden ? 'pause' : 'shown' }, location.origin);
      fit();
    };
  }
  frames[kind].hidden = false;
  frames[kind]
    .querySelector('iframe')
    .contentWindow?.postMessage({ type: 'shown' }, location.origin);
  fit();
}
