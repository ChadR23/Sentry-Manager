'use strict';

// What record.js asks a running server, route by route, and how each answer
// is normalised before it is kept or compared.
//
// Every GET route in docs/api-contract.json is either recorded here or named
// in `skip` with the reason; a GET route with no path parameters and no
// entry is recorded as it is with the default normalisers (lib.js
// VOLATILE_KEYS: times, uptimes, process figures, session ids). record.js
// fails when a GET route is neither recorded nor skipped, so a new route
// cannot be left out of the gate by accident.
//
// Requests are { path, query?, headers? }. Text in them may name a share as
// {root:<vehicle id>} or the data folder as {data}: each server puts its own
// in (the folders differ from one instance to another; the footage does not).
//
// Normaliser rules (lib.js normalise): { path: 'a.*.b', as: 'time'|'number'|
// 'id'|'bytes'|'shape'|'drop' }, { path, sortBy }, { strings: [[regex, to]] }.
// 'shape' keeps only the structure and the types: for answers about the
// machine itself (CPU, memory, disks), which no two servers share.

const SKIP = {
  'GET /api/events': 'live stream (Server-Sent Events): see docs/api-contract.md "Live updates"',
  'GET /api/converter/events': 'live stream (Server-Sent Events): see docs/api-contract.md "Live updates"',
  'GET /api/converter/previews/:id/images/:asset': 'preview-owned JPEGs have no Node golden; covered by wire::converter_preview image/access tests and guided preview browser checks',
  'GET /metrics': 'needs the metrics token (off by default); not called by the recorder',
  'GET /api/can/logs/ping': 'CAN Bridge token API (off by default); not called by the recorder',
  'GET /node/v1/info': 'node token API: only a paired main server calls it',
  'GET /node/v1/jobs/:id': 'node token API: only a paired main server calls it',
  'GET /node/v1/jobs/:id/output': 'node token API: only a paired main server calls it'
};

const freeText = [/\d+(\.\d+)? ?[KMGT]?B free( of \d+(\.\d+)? ?[KMGT]?B)?/, '<space> free'];

/** Ask the server what to ask: vehicles, days, recordings, clip files. */
async function discover(get) {
  const ctx = { vehicles: [] };
  const context = await get('/api/studio/context');
  const { vehicles = [] } = await get('/api/vehicles');
  for (const v of vehicles) {
    const days = (await get(`/api/vehicles/${encodeURIComponent(v.id)}/days?limit=100`)).days || [];
    const recs = (await get(`/api/vehicles/${encodeURIComponent(v.id)}/recordings?limit=500`)).recordings || [];
    const details = [];
    for (const r of recs) details.push(await get(`/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(r.id)}`));
    const root = (context.vehicles || []).find((x) => x.id === v.id)?.root || v.root;
    ctx.vehicles.push({
      id: v.id, root,
      days: days.map((d) => d.day),
      categories: [...new Set(recs.map((r) => r.category))].sort(),
      recordings: recs.map((r) => r.id),
      // front clips, by their place below the share (the same on every server)
      clips: details.flatMap((d) => (d.files || []).filter((f) => /-front\.mp4$/.test(f.rel)).map((f) => f.rel)).sort()
    });
  }
  ctx.data = (context.outputRoots || [])[0]?.replace(/[\\/]converted$/, '') || null;
  return ctx;
}

/** Folder names a server answers with, longest first, and what stands for them. */
function folders(ctx) {
  const list = [];
  for (const v of ctx.vehicles) if (v.root) list.push([v.root, `{root:${v.id}}`]);
  if (ctx.data) list.push([ctx.data, '{data}']);
  return list.sort((a, b) => b[0].length - a[0].length);
}

const V = (v, rest = '') => `/api/vehicles/${encodeURIComponent(v.id)}${rest}`;
const clipPath = (v, rel) => `{root:${v.id}}/${rel}`;
const each = (ctx, fn) => ctx.vehicles.flatMap(fn);

// per route: requests(ctx) and how to normalise the answers
const ROUTES = {
  'GET /healthz': {},
  'GET /api/auth/me': { normalise: [{ path: 'fingerprint', as: 'id' }] },
  // every sign-in (this tool's too) adds one: only their shape
  'GET /api/auth/sessions': { normalise: [{ path: 'sessions', as: 'shape' }] },
  'GET /api/system': { normalise: [{ path: 'dataFree', as: 'bytes' }, { path: 'gpu', as: 'shape' }, { path: 'version', as: 'shape' }] },
  'GET /api/security': {
    normalise: [
      { path: 'tls.ca', as: 'shape' }, { path: 'tls.certificate', as: 'shape' },
      { path: 'tls.containerHostname', as: 'id' }, { path: 'currentHost', as: 'id' }
    ]
  },
  'GET /api/security/ca.crt': { body: 'ignore' }, // each server makes its own certificate authority
  'GET /api/security/access': { normalise: [{ path: 'you', as: 'shape' }] },
  'GET /api/logs': { requests: () => [{ path: '/api/logs' }, { path: '/api/logs', query: { level: 'all' } }], normalise: [{ path: 'lines', as: 'shape' }] },
  'GET /api/logs/search': { normalise: [], body: 'ignore' },
  'GET /api/logs/download': { body: 'ignore' },
  'GET /api/logs/archive/:name': { requests: () => [{ path: '/api/logs/archive/none.log' }] },
  'GET /api/ui-packs/original.zip': { body: 'ignore' }, // the built-in files zipped: its bytes follow every interface change
  'GET /api/support-bundle': { body: 'ignore' },
  'GET /api/health': { normalise: [{ strings: [freeText] }] },
  'GET /api/reports': { normalise: [{ path: 'installCode', as: 'id' }] },
  'GET /api/vehicles': {
    normalise: [
      { path: 'vehicles.*.share.totalBytes', as: 'bytes' }, { path: 'vehicles.*.share.freeBytes', as: 'bytes' },
      { path: 'vehicles.*.storage.free', as: 'bytes' }, { path: 'vehicles.*.storage.total', as: 'bytes' }
    ]
  },
  'GET /api/exports': { requests: (ctx) => [{ path: '/api/exports' }, ...each(ctx, (v) => [{ path: '/api/exports', query: { vehicle: v.id } }])] },
  'GET /api/exports/:id': { requests: () => [{ path: '/api/exports/0000000000000000' }] },
  'GET /api/exports/:id/file': { requests: () => [{ path: '/api/exports/0000000000000000/file' }] },
  'GET /api/nodes': { normalise: [{ path: 'worker.name', as: 'id' }] },
  'GET /api/nodes/:id/benchmark': { requests: () => [{ path: '/api/nodes/none/benchmark' }] },

  // ---- footage and catalog: clip counts, days, cameras, codecs, sizes
  'GET /api/vehicles/:id/days': { requests: (ctx) => each(ctx, (v) => [{ path: V(v, '/days'), query: { limit: '100' } }, { path: V(v, '/days'), query: { limit: '1', offset: '1' } }]) },
  'GET /api/vehicles/:id/recordings': {
    requests: (ctx) => each(ctx, (v) => [
      { path: V(v, '/recordings'), query: { limit: '500' } },
      { path: V(v, '/recordings'), query: { limit: '1' } },
      ...v.days.flatMap((day) => v.categories.map((category) => ({ path: V(v, '/recordings'), query: { category, date: day, limit: '500' } })))
    ])
  },
  'GET /api/vehicles/:id/recordings/:rid': { requests: (ctx) => each(ctx, (v) => [...v.recordings.map((r) => ({ path: V(v, `/recordings/${r}`) })), { path: V(v, '/recordings/0000000000000000') }]) },
  'GET /api/vehicles/:id/recordings/:rid/thumbnail': { requests: (ctx) => each(ctx, (v) => v.recordings.map((r) => ({ path: V(v, `/recordings/${r}/thumbnail`) }))), body: 'ignore' },
  'GET /api/vehicles/:id/integrity': { requests: (ctx) => each(ctx, (v) => [{ path: V(v, '/integrity') }]) },
  'GET /api/vehicles/:id/archive-gaps': { requests: (ctx) => each(ctx, (v) => [{ path: V(v, '/archive-gaps') }]) },
  'GET /api/vehicles/:id/policy': { requests: (ctx) => each(ctx, (v) => [{ path: V(v, '/policy') }]) },
  'GET /api/vehicles/:id/sentry-usb': { requests: (ctx) => each(ctx, (v) => [{ path: V(v, '/sentry-usb') }]) },
  'GET /api/vehicles/:id/savings-by-month': {
    requests: (ctx) => each(ctx, (v) => [{ path: V(v, '/savings-by-month') }]),
    normalise: [{ path: 'months.*.month', as: 'time' }] // the last 12 months from today
  },

  // ---- viewer: telemetry, speed samples, media bytes, moments, drives
  'GET /api/telemetry': { requests: (ctx) => each(ctx, (v) => [...v.clips.map((rel) => ({ path: '/api/telemetry', query: { path: clipPath(v, rel) } })), { path: '/api/telemetry', query: { path: '/etc/passwd' } }]) },
  'GET /api/vehicles/:id/speeds': { requests: (ctx) => each(ctx, (v) => v.days.map((date) => ({ path: V(v, '/speeds'), query: { date } }))) },
  'GET /api/vehicles/:id/moments': { requests: (ctx) => each(ctx, (v) => v.days.map((date) => ({ path: V(v, '/moments'), query: { date } }))) },
  'GET /api/vehicles/:id/driving': {
    requests: (ctx) => each(ctx, (v) => [{ path: V(v, '/driving'), query: { weeks: '12' } }]),
    normalise: [{ path: 'weeks.*.week', as: 'time' }] // weeks back from today
  },
  'GET /api/vehicles/:id/drives': { requests: (ctx) => each(ctx, (v) => [{ path: V(v, '/drives') }]) },
  'GET /api/vehicles/:id/event-map': { requests: (ctx) => each(ctx, (v) => [{ path: V(v, '/event-map') }]) },
  'GET /api/stars': { requests: (ctx) => [{ path: '/api/stars' }, ...each(ctx, (v) => [{ path: '/api/stars', query: { vehicle: v.id } }])] },
  'GET /api/places/near': { requests: () => [{ path: '/api/places/near', query: { lat: '30.2672', lon: '-97.7431' } }, { path: '/api/places/near' }] },
  'GET /api/media': {
    requests: (ctx) => each(ctx, (v) => [
      ...v.clips.map((rel) => ({ path: '/api/media', query: { path: clipPath(v, rel) } })),
      ...v.clips.slice(0, 1).map((rel) => ({ path: '/api/media', query: { path: clipPath(v, rel) }, headers: { Range: 'bytes=0-99' } })),
      { path: '/api/media', query: { path: '/etc/passwd' } }
    ]),
    ignoreHeaders: ['cache-control']
  },
  'GET /api/scrub': { requests: (ctx) => each(ctx, (v) => [...v.clips.slice(0, 1).map((rel) => ({ path: '/api/scrub', query: { path: clipPath(v, rel) } })), { path: '/api/scrub', query: { path: '/etc/passwd' } }]), body: 'ignore' },
  'GET /api/speeds/status': {},
  'GET /api/studio/context': { normalise: [{ path: 'version', as: 'id' }] },

  // ---- bin, jobs, notifications
  'GET /api/bin': { requests: (ctx) => [{ path: '/api/bin' }, ...each(ctx, (v) => [{ path: '/api/bin', query: { vehicle: v.id } }])] },
  'GET /api/bin/:item/thumbnail': { requests: () => [{ path: '/api/bin/0000000000000000/thumbnail' }] },
  'GET /api/jobs': { requests: () => [{ path: '/api/jobs', query: { limit: '50' } }] },
  'GET /api/notifications': { requests: () => [{ path: '/api/notifications' }, { path: '/api/notifications', query: { open: '1' } }] },

  // ---- the machine itself: structure only
  // each part of the answer by its names only: which figures are there at a
  // given moment (a first sample, a GPU, a network total) varies
  'GET /api/stats': { normalise: [{ path: '*', as: 'keys' }] },
  'GET /api/stats/history': { requests: () => [{ path: '/api/stats/history', query: { range: '15m' } }], normalise: [{ path: 'series', as: 'shape' }, { path: 'start', as: 'time' }, { path: 'step', as: 'number' }] },
  'GET /api/stats/export.csv': { requests: () => [{ path: '/api/stats/export.csv', query: { range: '24h' } }], text: 'firstLine' },

  // ---- CAN logs (the fixture has none: the answers say so)
  'GET /api/can/signals': { requests: (ctx) => each(ctx, (v) => v.clips.slice(0, 1).map((rel) => ({ path: '/api/can/signals', query: { path: clipPath(v, rel) } }))) },
  'GET /api/can/clip': { requests: (ctx) => each(ctx, (v) => v.clips.slice(0, 1).map((rel) => ({ path: '/api/can/clip', query: { path: clipPath(v, rel) } }))) },
  'GET /api/can/raw': { requests: (ctx) => each(ctx, (v) => v.clips.slice(0, 1).map((rel) => ({ path: '/api/can/raw', query: { path: clipPath(v, rel) } }))) },
  'GET /api/can/vehicle-signals': { requests: (ctx) => each(ctx, (v) => [{ path: '/api/can/vehicle-signals', query: { vehicle: v.id } }]) },
  'GET /api/can/files/:name/download': { requests: () => [{ path: '/api/can/files/none.log.xz/download' }] },
  'GET /api/can/files/:name/candump': { requests: () => [{ path: '/api/can/files/none.log.xz/candump' }] },
  // the Stream Deck link (off in the fixture: /api/can/now answers 404; with a link, compared live)
  'GET /api/can/stream-deck': { normalise: [{ path: 'pin', as: 'id' }] }, // each server's own certificate authority
  'GET /api/can/stream-deck/plugin': { body: 'ignore' }, // the plugin's files zipped (deflated: the bytes follow the compressor)
  'GET /api/can/now/:stat': { requests: () => [{ path: '/api/can/now/battery', query: { token: 'none' } }] }
};

module.exports = { SKIP, ROUTES, discover, folders };
