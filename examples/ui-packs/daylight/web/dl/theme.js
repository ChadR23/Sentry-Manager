// Daylight: applies the chosen look before the first paint (no flash).
(function () {
  try {
    var t = JSON.parse(localStorage.getItem('daylight:theme'));
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    if (JSON.parse(localStorage.getItem('daylight:calm')) === true) document.documentElement.classList.add('calm');
  } catch (e) { /* private mode: follow the system */ }
})();
