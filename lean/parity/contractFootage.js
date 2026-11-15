'use strict';

// The API contract's goldens (tools/contract/record.js against the Node
// fixture, tools/contract/fixture.js) compared with the lean server, for the
// footage area's GET routes only:
//
//   SM_LEAN_COOKIE=x=y node lean/parity/contractFootage.js --base http://127.0.0.1:PORT --cookie-env SM_LEAN_COOKIE --goldens DIR
//
// (the lean server has no sign-in yet: any cookie does, and it is plain
// HTTP on loopback, so no password is sent). The lean server does not
// answer GET /api/studio/context yet (the viewer area's), which the
// contract tools ask first to learn the footage folders; it is made here
// from GET /api/vehicles, as index.js makes it.

const path = require('path');
const spec = require(path.join(__dirname, '..', '..', 'tools', 'contract', 'spec'));
const lib = require(path.join(__dirname, '..', '..', 'tools', 'contract', 'lib'));
const { compare } = require(path.join(__dirname, '..', '..', 'tools', 'contract', 'compare'));

const ROUTES = '^GET /api/(vehicles($|/:id/(days|recordings|policy|integrity))|bin($|/)|stars)';

const discover = spec.discover;
spec.discover = (get) => discover(async (p) => {
  if (p !== '/api/studio/context') return get(p);
  try {
    return await get(p);
  } catch {
    const { vehicles = [] } = await get('/api/vehicles');
    return { vehicles: vehicles.map((v) => ({ id: v.id, name: v.name, root: v.root, timezone: v.timezone })), outputRoots: [] };
  }
});

const args = lib.parseArgs(process.argv.slice(2), ['insecure-self-signed']);
compare({ only: ROUTES, ...args }).then((r) => process.exit(r.different ? 1 : 0), (err) => {
  console.error(err.message);
  process.exit(2);
});
