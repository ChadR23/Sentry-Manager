// Pages kept in the code but taken out of every interface for now: Drives
// (with its Driving and Map sub-tabs). No navigation, menu, palette or
// shortcut leads there, and an old address (#/drives, #/driving, #/map)
// opens the interface's home page instead. For trying them out, a browser
// with localStorage 'sentry-show-drives' set to '1' opens the addresses
// (still not in the navigation). web/app.js has the same rule inline.
export const HIDDEN_ROUTES = ['drives', 'driving', 'map'];
export function hiddenRoute(route) {
  if (!HIDDEN_ROUTES.includes(route)) return false;
  try { return localStorage.getItem('sentry-show-drives') !== '1'; } catch { return true; }
}
