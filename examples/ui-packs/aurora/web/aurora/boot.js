'use strict';
// Before the first paint: the background effect chosen in this browser
// (Settings > Interface > Background effect), so the page never flashes.
(function () {
  var mode = null;
  try { mode = localStorage.getItem('aurora:effect'); } catch (e) { /* private mode */ }
  if (mode !== 'full' && mode !== 'calm' && mode !== 'off') {
    // calm until chosen otherwise: it looks nearly the same and costs a
    // third of full (measured: 14 % of the main thread against 44 %)
    mode = 'calm';
  }
  document.documentElement.dataset.effect = mode;
  var glass = null;
  try { glass = localStorage.getItem('aurora:glass'); } catch (e) { /* private mode */ }
  if (glass === 'solid') document.documentElement.classList.add('no-blur');
  if (glass === 'frosted') document.documentElement.classList.add('frost-all');
  if (window.matchMedia && matchMedia('(hover: none)').matches) document.documentElement.classList.add('touch');
})();
