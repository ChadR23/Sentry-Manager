#!/usr/bin/env node
'use strict';

// The API contract, read from the source (nothing is started or called):
//   - every route the server defines (method, path pattern, who may call it,
//     file:line), from server/index.js's router and the paths it answers by
//     hand (live updates, media, the CAN Bridge upload API, node workers);
//   - every API call the pages make (web/, the Studio pages in src/renderer/,
//     and the bundled interface packs in examples/ui-packs/);
//   - the live-update channels (Server-Sent Events) and their event names;
//   - calls with no route behind them, and routes no page calls.
//
//   node tools/contract/routes.js            writes docs/api-contract.json and .md
//   node tools/contract/routes.js --check    exits 1 when those files are out of date
//   node tools/contract/routes.js --print    prints the totals only

const fs = require('fs');
const path = require('path');
const { lex, matchBracket, lineIndex } = require('./lexjs');

const REPO = path.join(__dirname, '..', '..');
const rel = (f) => path.relative(REPO, f).split(path.sep).join('/');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

// ---- areas: the first rule that matches a path names its group
const AREAS = [
  ['Accounts, sessions and access', /^\/api\/(auth|accounts)(\/|$)/],
  ['HTTPS certificates', /^\/api\/security(\/|$)/],
  ['Live updates', /^\/api\/(events|converter\/events)$/],
  ['Sentry USB', /^\/api\/(vehicles\/[^/]+\/sentry-usb|sentryusb)(\/|$)/],
  ['Drives (driving and trips)', /^\/api\/vehicles\/[^/]+\/(driving|drives)(\/|$)/],
  ['Feedback and diagnostics reports', /^\/api\/reports(\/|$)/],
  ['Places and map', /^\/api\/places(\/|$)/],
  ['Events', /^\/api\/(vehicles\/[^/]+\/(event-map|moments)|stars)(\/|$)/],
  ['Cleanup (policies and Move to trash)', /^\/api\/vehicles\/[^/]+\/(policy|trash|trash-days|trash-preview|saved|protect)(\/|$)/],
  ['Recycle Bin', /^\/api\/bin(\/|$)/],
  ['Power price and savings', /^\/api\/(settings\/power|vehicles\/[^/]+\/savings-by-month)$/],
  ['Viewer, clip ranges, telemetry and speed', /^\/api\/(telemetry|speeds|media|scrub|studio|vehicles\/[^/]+\/speeds)(\/|$)/],
  ['Footage and catalog', /^\/api\/(vehicles\/[^/]+\/(days|recordings|scan|archive-gaps|integrity|exports)|exports)(\/|$)/],
  ['Vehicles and shares', /^\/api\/vehicles(\/[^/]+)?(\/(reconnect))?$|^\/api\/vehicles\/test-smb$/],
  ['Notifications', /^\/api\/notification/],
  ['Activity (jobs)', /^\/api\/jobs(\/|$)/],
  ['Health, stats and logs', /^\/api\/(health|metrics|system|stats|logs|support-bundle)(\/|$)|^\/(healthz|metrics)$/],
  ['Converter and encoder', /^\/api\/converter(\/|$)/],
  ['CAN logs', /^\/api\/can(\/|$)/],
  ['Helper servers (nodes)', /^\/api\/nodes(\/|$)|^\/node\/v1\//],
  ['Other (settings, interface, updates, snapshots, dashboards)', /./]
];
const areaOf = (p) => AREAS.find(([, re]) => re.test(p))[0];

const { viewerMay } = require(path.join(REPO, 'server', 'accounts.js'));
const samplePath = (pattern) => pattern.replace(/:(\w+)/g, 'x');

// ---- server side
function serverRoutes() {
  const routes = [];
  const file = 'server/index.js';
  const src = read(file);
  const { mask } = lex(src);
  const line = lineIndex(src);

  // r.add('METHOD', '/api/…', handler, opts)
  const re = /\br\.add\(\s*'(GET|POST|PUT|PATCH|DELETE)',\s*'([^']+)'/g;
  for (let m; (m = re.exec(src));) {
    if (mask[m.index] !== 'r') continue; // in a comment
    const open = m.index + 'r.add'.length;
    const close = matchBracket(mask, open);
    const body = src.slice(open, close + 1);
    const method = m[1];
    const pattern = m[2];
    const isPublic = /\{\s*public:\s*true\s*\}\s*\)$/.test(body);
    routes.push(describe({
      method, path: pattern, file, line: line(m.index), kind: 'router', public: isPublic, body
    }));
  }

  // the paths the handler answers itself before the router
  const hStart = src.indexOf('const handler = async (req, res) =>');
  const hOpen = src.indexOf('{', hStart);
  const hEnd = matchBracket(mask, hOpen);
  const handler = src.slice(hStart, hEnd);
  const inline = /if \(p === '(\/api\/[^']+)'\) \{/g;
  for (let m; (m = inline.exec(handler));) {
    const at = hStart + m.index;
    const bOpen = src.indexOf('{', at + m[0].length - 1);
    const block = src.slice(bOpen, matchBracket(mask, bOpen) + 1);
    const only = /req\.method !== '(\w+)'/.exec(block);
    const sse = /text\/event-stream/.test(block);
    const method = only ? only[1] : 'GET';
    routes.push(describe({
      method, path: m[1], file, line: line(at), kind: sse ? 'sse' : 'inline', public: false, body: block,
      note: sse ? 'Server-Sent Events stream' : (/sendMedia|createReadStream/.test(block) ? 'file bytes (Range requests), ?path=' : '')
    }));
  }
  // before the host and cookie checks: tokens, no cookies
  const early = [
    [/if \(rawPath === '\/metrics'\)/, 'GET', '/metrics', 'metrics-token', 'Prometheus text; Bearer token made in Health; 404 while off'],
    [/if \(rawPath === '\/api\/can\/now'/, 'GET', '/api/can/now', 'can-now-token', 'Live CAN stats for a Stream Deck (JSON); the read-only token made in the CAN Nerd panel (?token= or Bearer); 404 while off'],
    [/if \(rawPath === '\/api\/can\/now'/, 'GET', '/api/can/now/:stat', 'can-now-token', 'one stat as plain text (also /<stat>.txt); the Stream Deck token; 404 while off', false, 'text/plain; charset=utf-8'],
    [/if \(url\.pathname === '\/api\/can\/now\/ca\.crt'\)/, 'GET', '/api/can/now/ca.crt', 'public', 'the local certificate authority for the Stream Deck plugin\'s pin; only while a Stream Deck link is on', true, 'application/x-x509-ca-cert'],
    [/if \(rawPath === '\/healthz'\)/, 'GET', '/healthz', 'public', 'plain "ok"']
  ];
  for (const [r, method, p, auth, note, whole, type] of early) {
    // (whole: found anywhere in index.js, e.g. inside a function the handler calls; type: a raw answer's)
    const m = r.exec(whole ? src : handler);
    if (m) routes.push(describe({ method, path: p, file, line: line((whole ? 0 : hStart) + m.index), kind: 'inline', auth, note, body: type ? `res.writeHead(200, { 'Content-Type': '${type}' })` : '' }));
  }

  // CAN Bridge uploads (docs/can-bridge-api.md): a write-only token
  const cStart = src.indexOf('canUploadRef = async (req, res, rawPath) =>');
  const cOpen = src.indexOf('{', cStart);
  const can = src.slice(cStart, matchBracket(mask, cOpen));
  const cre = /req\.method === '(\w+)' && (?:sub === '([^']+)'|(n)\b)/g;
  for (let m; (m = cre.exec(can));) {
    routes.push(describe({
      method: m[1], path: `/api/can/logs${m[2] || '/:name'}`, file, line: line(cStart + m.index), kind: 'inline', auth: 'can-token',
      note: 'CAN Bridge API (also on CAN_PORT); Bearer upload token, HTTPS only'
    }));
  }

  // node worker (server/nodeWorker.js): a paired main server, by token
  const nfile = 'server/nodeWorker.js';
  const nsrc = read(nfile);
  const nline = lineIndex(nsrc);
  const nre = /p === '(\/node\/v1\/[^']+)'(?: && req\.method === '(\w+)')?/g;
  for (let m; (m = nre.exec(nsrc));) {
    if (m[1] === '/node/v1/') continue;
    const pair = m[1] === '/node/v1/pair';
    routes.push(describe({
      method: m[2] || 'POST', path: m[1], file: nfile, line: nline(m.index), kind: 'inline', auth: pair ? 'public' : 'node-token',
      note: pair ? 'pairing with the one-time code shown on the node; HTTPS only' : 'HTTPS only; a paired main server\'s token'
    }));
  }
  const jre = /(!?)m\[2\] && req\.method === '(\w+)'/g;
  for (let m; (m = jre.exec(nsrc));) {
    routes.push(describe({
      method: m[2], path: m[1] ? '/node/v1/jobs/:id' : '/node/v1/jobs/:id/output', file: nfile, line: nline(m.index), kind: 'inline', auth: 'node-token',
      note: 'HTTPS only; :id is 32 hex characters'
    }));
  }
  return routes;
}

function describe(r) {
  const body = r.body || '';
  const auth = r.auth || (r.public ? 'public' : 'session');
  const access = auth !== 'session' ? auth : viewerMay(r.method, samplePath(r.path)) ? 'signed-in' : 'admin';
  const query = [...new Set([...body.matchAll(/\bquery\.(\w+)|searchParams\.get\('(\w+)'\)/g)].map((x) => x[1] || x[2]))].sort();
  const out = {
    method: r.method,
    path: r.path,
    area: areaOf(r.path),
    auth,
    access,
    confirmPassword: /requireConfirmed\(req\)/.test(body),
    kind: r.kind,
    response: r.kind === 'sse' ? 'text/event-stream' : /res\.writeHead\(|sendMedia\(|pipeline\(|sendFile|serveFile|res\.end\(/.test(body) ? 'raw' : 'json',
    query,
    source: `${r.file}:${r.line}`
  };
  const type = /'Content-Type':\s*'([^']+)'/.exec(body);
  if (out.response === 'raw' && type) out.contentType = type[1];
  if (r.note) out.note = r.note;
  return out;
}

// ---- live channels
function liveChannels(uiFiles) {
  const src = read('server/index.js');
  const topics = [...new Set([...src.matchAll(/announce\('([\w:-]+)'\)/g)].map((m) => m[1]))].sort();
  const ipc = read('src/main/converter/ipc.js');
  const sends = [...new Set([...ipc.matchAll(/sender\.send\('([\w:-]+)'/g)].map((m) => m[1]))].sort();
  const uiTopics = new Map();
  for (const f of uiFiles) {
    const text = fs.readFileSync(f, 'utf8');
    if (!/topics/.test(text)) continue;
    for (const m of text.matchAll(/topics\.(?:includes|has)\('([\w:-]+)'\)|\[((?:'[\w:-]+',?\s*)+)\]\.includes\(t\)/g)) {
      const names = m[1] ? [m[1]] : [...m[2].matchAll(/'([\w:-]+)'/g)].map((x) => x[1]);
      for (const n of names) {
        if (!uiTopics.has(n)) uiTopics.set(n, new Set());
        uiTopics.get(n).add(rel(f));
      }
    }
  }
  return [
    {
      path: '/api/events', transport: 'Server-Sent Events', auth: 'session', access: 'signed-in',
      events: [
        { event: 'hello', data: '{}', note: 'sent once when the stream opens' },
        { event: 'changed', data: '{ "topics": [ … ] }', note: 'batched every 400 ms', topics }
      ],
      keepAlive: '": ping" comment every 20 s', limit: '200 open streams (503 beyond)',
      uiTopics: Object.fromEntries([...uiTopics].sort().map(([k, v]) => [k, [...v].sort()])),
      uiTopicsUnknown: [...uiTopics.keys()].filter((t) => !topics.includes(t)).sort(),
      topicsNoUi: topics.filter((t) => !uiTopics.has(t))
    },
    {
      path: '/api/converter/events?client=<id>', transport: 'Server-Sent Events', auth: 'session', access: 'signed-in',
      events: [{ event: 'hello', data: '{}', note: 'sent once when the stream opens; the page subscribes again' }, ...sends.map((e) => ({ event: e, data: 'converter IPC payload (src/main/converter/ipc.js)' }))],
      keepAlive: '": ping" comment every 15 s', limit: '200 open streams (503 beyond); 503 while the converter starts'
    }
  ];
}

function converterChannels() {
  const ipc = read('src/main/converter/ipc.js');
  const block = /const CHANNELS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(ipc)[1];
  return [...block.matchAll(/'converter:(\w+)'/g)].map((m) => m[1]);
}

// ---- UI side
function uiFiles() {
  const roots = ['web', 'src/renderer', 'examples/ui-packs'];
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(f); } else if (/\.(m?js|html)$/.test(e.name)) out.push(f);
    }
  };
  for (const r of roots) walk(path.join(REPO, r));
  return out.sort();
}

const OPTION_CALLEES = new Set(['api', 'fetch', 'fetchImpl', 'rawGet', 'apiJson', 'getJson', 'json']);
const POST_CALLEES = new Set(['post', 'upload', 'metricsAction', 'send']);
const GET_CALLEES = new Set(['download', 'EventSource']);

/** The method a UI call uses, from the code around its URL literal; '?' when it cannot tell. */
function inferMethod(src, mask, lit) {
  const from = Math.max(0, lit.start - 120);
  const before = src.slice(from, lit.start);
  // the same text with other literals blanked, for its structure (offsets match)
  const shape = mask.slice(from, lit.start);
  let m;
  // call('METHOD', url) and call('METHOD', a ? url : other)
  if ((m = /\b([\w$]+)\(\s*(['"])[^'"]*\2,\s*(?:[^();]*[?:]\s*)?$/.exec(shape))) {
    const q = m.index + m[0].indexOf(m[2]) + 1;
    const word = /^(GET|POST|PUT|PATCH|DELETE|HEAD)\b/.exec(before.slice(q));
    if (word) return { method: word[1], how: `${m[1]}(method, url)` };
  }
  if ((m = /method:\s*'(GET|POST|PUT|PATCH|DELETE)',\s*(url|path|href):\s*$/.exec(before))) return { method: m[1], how: '{ method, url }' };
  if (/(href|src|action)=["']?$/.test(before) || /\.(href|src)\s*=\s*$/.test(before)) return { method: 'GET', how: 'link' };
  if ((m = /(?:new\s+)?([\w$.]+)\(\s*(?:[^();]*[?:]\s*)?$/.exec(shape))) {
    const callee = m[1].split('.').pop();
    // the call's own arguments
    const open = from + m.index + m[0].indexOf(m[1]) + m[1].length;
    const close = matchBracket(mask, open);
    const args = close > 0 ? src.slice(lit.end, close) : src.slice(lit.end, lit.end + 200);
    const opt = /method:\s*['"](\w+)['"]/.exec(args);
    if (GET_CALLEES.has(callee)) return { method: 'GET', how: callee };
    if (POST_CALLEES.has(callee)) return { method: opt ? opt[1].toUpperCase() : 'POST', how: callee };
    if (callee === 'confirmThen') return { method: opt ? opt[1].toUpperCase() : 'POST', how: callee };
    if (OPTION_CALLEES.has(callee)) {
      // options picked by a condition (`a ? { method: 'POST' } : {}`): either
      if (opt && /\?[^:]*method:/.test(args)) return { method: '?', how: `${callee}(url, a ? opts : opts)` };
      if (opt) return { method: opt[1].toUpperCase(), how: `${callee}({ method })` };
      if (/^\s*,\s*post\(/.test(args)) return { method: 'POST', how: `${callee}(url, post())` };
      if (/\bbody\b/.test(args) && callee !== 'fetch' && callee !== 'fetchImpl' && callee !== 'rawGet') return { method: 'POST', how: `${callee}({ body })` };
      return { method: 'GET', how: callee };
    }
    return { method: '?', how: `${callee}()` };
  }
  return { method: '?', how: 'value' };
}

const HOLE = '\u0001';

function uiCalls(files) {
  const calls = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const line = lineIndex(src);
    if (f.endsWith('.html')) {
      for (const m of src.matchAll(/(?:href|src|action)="(\/api\/[^"]*)"/g)) calls.push(uiCall(f, line(m.index), m[1], 'GET', 'html'));
      continue;
    }
    const { literals, mask } = lex(src);
    const byStart = new Map(literals.map((l) => [l.start, l]));
    for (const lit0 of literals) {
      const lit = joinConcat(lit0, mask, byStart);
      const raw = lit.parts.join(HOLE);
      // links in HTML written by a script: <a href="/api/…">, <img src="/api/…">
      for (const m of raw.matchAll(/(?:href|src|action)=["']?(\/api\/[^"'\s>]*)/g)) {
        const holesBefore = raw.slice(0, m.index).split(HOLE).length - 1;
        const n = m[1].split(HOLE).length - 1;
        calls.push(uiCall(f, line(lit.start + m.index), m[1], 'GET', 'html link', lit.holes.slice(holesBefore, holesBefore + n)));
      }
      // `/api/…`, or `${origin}/api/…` (and the two token-free paths)
      const origin = new RegExp(`^${HOLE}(?=/(api/.|healthz$|metrics$))`).test(raw);
      if (!/^\/api\/./.test(raw) && !origin) continue;
      // a check of a path (startsWith, ===), not a call
      const before = src.slice(Math.max(0, lit.start - 40), lit.start);
      if (/(startsWith|includes|===|!==|test)\(?\s*$/.test(before)) continue;
      const { method, how } = inferMethod(src, mask, lit);
      calls.push(uiCall(f, line(lit.start), origin ? raw.slice(1) : raw, method, how, origin ? lit.holes.slice(1) : lit.holes));
    }
  }
  return calls;
}

/**
 * '/api/x/' + id + '/y' as one literal with holes (its end is the end of the
 * whole expression, so the call's options are read after it).
 */
function joinConcat(lit, mask, byStart) {
  if (!/^\/api\//.test(lit.parts[0])) return lit;
  const parts = [...lit.parts];
  const holes = [...lit.holes];
  let at = lit.end;
  for (;;) {
    const plus = /^\s*\+\s*/.exec(mask.slice(at, at + 200));
    if (!plus) break;
    at += plus[0].length;
    const next = byStart.get(at);
    if (next) { // + 'text'
      parts[parts.length - 1] += next.parts[0];
      for (let k = 1; k < next.parts.length; k++) { holes.push(next.holes[k - 1]); parts.push(next.parts[k]); }
      at = next.end;
      continue;
    }
    // + expression: up to the next top-level + , ) ] } ;
    const start = at;
    let depth = 0;
    while (at < mask.length) {
      const c = mask[at];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if (depth === 0 && (c === '+' || c === ',' || c === ';' || c === '?' || c === ':' || c === '\n')) break;
      // a literal inside the expression (a call's argument) is skipped whole
      const inner = byStart.get(at);
      if (inner) { at = inner.end; continue; }
      at++;
    }
    holes.push(mask.slice(start, at).trim());
    parts.push('');
  }
  if (at === lit.end) return lit;
  return { ...lit, parts, holes, end: at };
}

function uiCall(f, ln, raw, method, how, holes = []) {
  // the address without its query: a hole at the very end that follows a
  // word (`/api/jobs${q}`) is a query string or nothing
  let p = raw;
  const q = p.indexOf('?');
  if (q !== -1) p = p.slice(0, q);
  const trailing = p.endsWith(HOLE) && !p.endsWith(`/${HOLE}`);
  if (trailing) p = p.slice(0, -1);
  const shown = p.replace(new RegExp(HOLE, 'g'), '{…}');
  return { method, path: shown, raw: raw.replace(new RegExp(HOLE, 'g'), '${…}'), source: `${rel(f)}:${ln}`, how, holes: holes.map((h) => h.trim()).filter(Boolean) };
}

/** The server route a UI path (with {…} holes) means, or null. */
function matchRoute(routes, method, uiPath) {
  const sample = uiPath.replace(/\{…\}/g, 'x1x');
  const esc = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const bySample = (r) => new RegExp(`^${esc(r.path).replace(/:(\w+)/g, '[^/]+')}$`).test(sample);
  // only when no route fits a one-segment hole: a hole that stands for
  // several segments or a fixed word (`/api/${what}`)
  const holeRe = new RegExp(`^${uiPath.split('{…}').map(esc).join('.+')}$`);
  let byPath = routes.filter(bySample);
  if (!byPath.length && uiPath.includes('{…}')) byPath = routes.filter((r) => holeRe.test(r.path));
  if (!byPath.length) return { route: null, pathKnown: false };
  if (method === '?') return { route: byPath[0], pathKnown: true, methods: byPath.map((r) => r.method) };
  const exact = byPath.find((r) => r.method === method || (method === 'GET' && r.method === 'HEAD'));
  return { route: exact || null, pathKnown: true, methods: byPath.map((r) => r.method) };
}

function build() {
  const routes = serverRoutes();
  const files = uiFiles();
  const calls = uiCalls(files);
  const live = liveChannels(files);
  const channels = converterChannels();
  const key = (r) => `${r.method} ${r.path}`;
  const usedBy = new Map(routes.map((r) => [key(r), []]));
  const unmatched = [];
  for (const c of calls) {
    const m = matchRoute(routes, c.method, c.path);
    if (m.route) {
      c.route = key(m.route);
      usedBy.get(key(m.route)).push(c.source);
      if (c.method === '?') c.methodGuess = m.methods;
    } else {
      c.route = null;
      unmatched.push({ ...c, reason: m.pathKnown ? `the server answers ${m.methods.join('/')} here, not ${c.method}` : 'no server route' });
    }
  }
  for (const r of routes) {
    const by = [...new Set(usedBy.get(key(r)))].sort();
    r.callSites = by.length;
    const packs = new Set(by.map((s) => /^examples\/ui-packs\/([\w-]+)/.exec(s)?.[1] || (s.startsWith('src/renderer') ? 'studio' : 'built-in')));
    r.calledFrom = [...packs].sort();
  }
  // routes only other programs call (no page): token APIs and helpers
  const external = (r) => r.auth !== 'session' && r.auth !== 'public' || r.path.startsWith('/node/') || r.path === '/api/can/now/ca.crt';
  const notCalled = routes.filter((r) => !r.callSites);
  const distinct = new Set(routes.filter((r) => r.path.startsWith('/api/')).map((r) => r.path));
  const uiDistinct = new Set(calls.map((c) => `${c.method} ${c.path}`));
  return {
    generatedFrom: 'tools/contract/routes.js (static reading of the source; regenerate with `node tools/contract/routes.js`)',
    totals: {
      serverRoutes: routes.length,
      serverRouterRoutes: routes.filter((r) => r.kind === 'router').length,
      serverInlineRoutes: routes.filter((r) => r.kind !== 'router').length,
      serverApiRoutes: routes.filter((r) => r.path.startsWith('/api/')).length,
      serverDistinctApiPaths: distinct.size,
      byAccess: countBy(routes, (r) => r.access),
      uiCallSites: calls.length,
      uiDistinctCalls: uiDistinct.size,
      uiCallSitesBySource: countBy(calls, (c) => /^examples\/ui-packs\/([\w-]+)/.exec(c.source)?.[1] || (c.source.startsWith('src/renderer') ? 'studio' : 'built-in')),
      uiMethodUnknown: calls.filter((c) => c.method === '?').length,
      liveChannels: live.length,
      liveEventTypes: live.reduce((n, c) => n + c.events.length, 0),
      converterIpcChannels: channels.length,
      uiCallsWithoutRoute: unmatched.length,
      routesNoUiCalls: notCalled.length,
      routesNoUiCallsExternal: notCalled.filter(external).length,
      liveTopicsUiOnly: live[0].uiTopicsUnknown.length
    },
    routes,
    converterIpcChannels: channels.map((c) => ({ name: c, call: `POST /api/converter/invoke/${c}` })),
    liveChannels: live,
    uiCalls: calls.map(({ holes, ...c }) => c),
    mismatches: {
      uiCallsWithoutRoute: unmatched.map(({ method, path: p, source, reason }) => ({ method, path: p, source, reason })),
      routesNoUiCalls: notCalled.map((r) => ({ method: r.method, path: r.path, access: r.access, source: r.source, external: external(r) })),
      liveTopicsUiOnly: live[0].uiTopicsUnknown.map((t) => ({ channel: '/api/events', topic: t, listenedIn: live[0].uiTopics[t] }))
    }
  };
}

function countBy(list, fn) {
  const o = {};
  for (const x of list) o[fn(x)] = (o[fn(x)] || 0) + 1;
  return Object.fromEntries(Object.entries(o).sort());
}

function markdown(c) {
  const t = c.totals;
  const out = [];
  out.push('# API contract', '');
  out.push('Generated by `node tools/contract/routes.js` from the source (do not edit by hand; `--check` fails when it is out of date). The machine-readable copy is [`api-contract.json`](api-contract.json). Recording and comparing a running server against it: [`tools/contract/`](../tools/contract/README.md).', '');
  out.push('## Totals', '');
  out.push('| | |', '| --- | --- |');
  out.push(`| Server routes (method + path) | ${t.serverRoutes} (${t.serverRouterRoutes} in the router, ${t.serverInlineRoutes} answered by hand) |`);
  out.push(`| … under /api/ | ${t.serverApiRoutes} routes, ${t.serverDistinctApiPaths} distinct paths |`);
  out.push(`| By access | ${Object.entries(t.byAccess).map(([k, v]) => `${k} ${v}`).join(', ')} |`);
  out.push(`| UI call sites | ${t.uiCallSites} (${Object.entries(t.uiCallSitesBySource).map(([k, v]) => `${k} ${v}`).join(', ')}); ${t.uiDistinctCalls} distinct method + path; method not readable at ${t.uiMethodUnknown} |`);
  out.push(`| Live channels | ${t.liveChannels} SSE streams, ${t.liveEventTypes} event types |`);
  out.push(`| Converter IPC channels | ${t.converterIpcChannels}, all through \`POST /api/converter/invoke/:name\` |`);
  out.push(`| UI calls with no route | ${t.uiCallsWithoutRoute} |`);
  out.push(`| Live topics a page listens for that the server never sends | ${t.liveTopicsUiOnly} |`);
  out.push(`| Routes no page calls | ${t.routesNoUiCalls} (${t.routesNoUiCallsExternal} of them for other programs: tokens, nodes, CAN Bridge) |`, '');
  out.push('Access: **public** needs no sign-in; **signed-in** any account, a watch-only (viewer) one too; **admin** not a watch-only account (server/accounts.js `viewerMay`); **🔑** the password is asked again (`requireConfirmed`); token kinds are for other programs. Every non-GET call needs `X-Requested-With: sentry-six-manager` and a same-origin `Origin`.', '');

  out.push('## Mismatches', '');
  out.push('### UI calls the server does not define', '');
  if (!c.mismatches.uiCallsWithoutRoute.length) out.push('None.', '');
  else {
    out.push('| Method | Path | Where | Why |', '| --- | --- | --- | --- |');
    for (const m of c.mismatches.uiCallsWithoutRoute) out.push(`| ${m.method} | \`${m.path}\` | ${m.source} | ${m.reason} |`);
    out.push('');
  }
  out.push('### Routes no page calls', '');
  out.push('| Method | Path | Access | Defined | For |', '| --- | --- | --- | --- | --- |');
  for (const m of c.mismatches.routesNoUiCalls) out.push(`| ${m.method} | \`${m.path}\` | ${m.access} | ${m.source} | ${m.external ? 'other programs' : 'no page (check)'} |`);
  out.push('');

  out.push('## Live updates', '');
  for (const ch of c.liveChannels) {
    out.push(`### \`${ch.path}\``, '', `${ch.transport}, ${ch.access}. Keep-alive: ${ch.keepAlive}. Limit: ${ch.limit}.`, '');
    out.push('| Event | Data | |', '| --- | --- | --- |');
    for (const e of ch.events) out.push(`| \`${e.event}\` | \`${e.data}\` | ${e.note || ''}${e.topics ? ` Topics: ${e.topics.map((x) => `\`${x}\``).join(', ')}` : ''} |`);
    out.push('');
    if (ch.uiTopics) {
      out.push(`Topics the pages act on: ${Object.keys(ch.uiTopics).map((x) => `\`${x}\``).join(', ')}.${ch.uiTopicsUnknown.length ? ` **Not sent by the server:** ${ch.uiTopicsUnknown.join(', ')}.` : ''}${ch.topicsNoUi.length ? ` Sent but no page reacts by name: ${ch.topicsNoUi.join(', ')}.` : ''}`, '');
    }
  }
  out.push('### Converter IPC channels', '');
  out.push(c.converterIpcChannels.map((x) => `\`${x.name}\``).join(', '), '');

  out.push('## Routes by area', '');
  for (const [area] of AREAS) {
    const list = c.routes.filter((r) => r.area === area);
    if (!list.length) continue;
    out.push(`### ${area} (${list.length})`, '');
    out.push('| Method | Path | Access | Answer | Query | Defined | Called from |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of list.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
      out.push(`| ${r.method} | \`${r.path}\` | ${r.access}${r.confirmPassword ? ' 🔑' : ''} | ${r.response}${r.contentType ? ` (${r.contentType})` : ''}${r.note ? `: ${r.note}` : ''} | ${r.query.join(', ')} | ${r.source} | ${r.calledFrom.join(', ') || '—'} |`);
    }
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

if (require.main === module) {
  const contract = build();
  const json = `${JSON.stringify(contract, null, 2)}\n`;
  const md = markdown(contract);
  const jf = path.join(REPO, 'docs', 'api-contract.json');
  const mf = path.join(REPO, 'docs', 'api-contract.md');
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify(contract.totals, null, 2));
  } else if (process.argv.includes('--check')) {
    const same = fs.existsSync(jf) && fs.readFileSync(jf, 'utf8') === json && fs.existsSync(mf) && fs.readFileSync(mf, 'utf8') === md;
    if (!same) {
      console.error('docs/api-contract.json or .md is out of date: run node tools/contract/routes.js');
      process.exit(1);
    }
    console.log('API contract up to date.');
  } else {
    fs.writeFileSync(jf, json);
    fs.writeFileSync(mf, md);
    console.log(JSON.stringify(contract.totals, null, 2));
  }
}

module.exports = { build, serverRoutes, uiCalls, uiFiles, matchRoute, inferMethod, markdown, areaOf };
