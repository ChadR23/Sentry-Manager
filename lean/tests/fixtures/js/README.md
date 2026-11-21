# Stand-ins for outside services (plain Node, no packages)

Test doubles of services outside the app, used by the Rust tests over
127.0.0.1. They are not the Node server (removed) and load nothing from it.

| File | Stands in for | Used by |
| --- | --- | --- |
| `fakeAcme.js` | an ACME v2 server (Let's Encrypt) | `lean/src/core/acme.rs` (`issues_against_the_fake_acme_server`) |
| `reportsReceiver.js`, `receiver.js`, `reportsProtocol.js` | the developers' private reports receiver (only its public wire protocol, docs/reports-api.md) | `lean/tests/reports_parity.rs` (the round trips) |

They need `node` (22 or newer). Without it those tests are skipped with a
note, unless `LEAN_NEED_NODE=1` is set (CI sets it): then they fail.
