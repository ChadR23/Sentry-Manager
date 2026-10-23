// Loaded first by the shell (index.html): marks the tab being opened
// (html[data-boot]) before the page paints, so shell.css can show its loading
// state until app.js has drawn it. app.js removes the mark.
document.documentElement.dataset.boot = (/^#\/?([\w-]+)/.exec(location.hash) || [])[1] || 'overview';
