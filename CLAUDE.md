# Working on Sentry Six Manager

## Pushing to main (owner's rule)

- Nothing that changes how the app looks or behaves goes to `main` until the
  owner has checked it. Build and test on a branch (`release/<name>`), send
  desktop and phone screenshots of every page it touches, and push to `main`
  only after the owner says OK.
- Every push to `main` builds and publishes the Docker image the owner runs
  (`latest`), so `main` is what goes live.
- Documentation-only changes (`README.md`, `docs/`) may go to `main` directly.

## Standing rules

- Everything stays inside the one Docker container: no external services,
  no extra containers (no Glances, Netdata, socket proxies, cloud APIs).
- Passwords only over HTTPS; never plain HTTP with passwords.
- No co-author trailers in commits, no model names in commits or code.
- No pull requests unless the owner asks.
- Run `npm test` before every push.
